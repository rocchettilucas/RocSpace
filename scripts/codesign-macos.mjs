// Make sure the bundle `tauri build` just produced carries a VALID signature,
// and sign it if nothing else did.
//
// Why this exists: `tauri.conf.json` had no `bundle.macOS` block, so
// tauri-bundler had no signing identity and skipped `codesign` entirely. What
// shipped was not "unsigned" — it was worse. The linker leaves its own ad-hoc
// signature on the Mach-O, and that signature claims sealed resources:
//
//     $ codesign -dvvv RocSpace.app
//     flags=0x20002(adhoc,linker-signed)   Sealed Resources=none
//     $ ls RocSpace.app/Contents/_CodeSignature
//     No such file or directory
//     $ spctl -a -t exec -vvv RocSpace.app
//     code has no resources but signature indicates they must be present
//
// On the machine that built it that launches fine, because nothing quarantined
// it. The moment the `.dmg` reaches another Mac, quarantine plus a failed
// assessment gives the user **"RocSpace is damaged and can't be opened. You
// should move it to the Trash."** — the invalid-signature message, not the
// unidentified-developer one that right-click → Open gets past.
//
// The fix has two halves and this script is the second:
//
//   1. `bundle.macOS.signingIdentity: "-"` in `tauri.conf.json` makes
//      tauri-bundler run `codesign` itself, DURING bundling. That ordering is
//      the whole reason it is done there: the `.dmg` is built from the `.app`
//      in the same pass, so a signature applied afterwards would live only on
//      the copy in `target/`, and every user's copy — the one inside the disk
//      image — would still be the broken one. There is no hook between the two
//      steps to use instead (`beforeBundleCommand` runs before either).
//   2. This script, which VERIFIES what came out — including the copy inside
//      each `.dmg`, by mounting it — and signs the `.app` itself only if the
//      bundler did not. A build that cannot produce a valid signature fails
//      here rather than shipping.
//
// Ad-hoc (`-`) rather than a Developer ID because there is no certificate to
// use. It is not notarization and it does not silence Gatekeeper's
// unidentified-developer prompt; what it does is make the signature TRUE, which
// is the difference between "are you sure you want to open this?" and
// "damaged".  With a certificate, set `APPLE_SIGNING_IDENTITY` (or the config
// field) and both halves use it.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tauriDir = join(root, "src-tauri");

if (process.platform !== "darwin") {
  // Not a no-op by accident: Linux and Windows bundles are signed (or not) by
  // entirely different machinery, and there is nothing here that applies.
  console.log("codesign-macos: not macOS — nothing to sign");
  process.exit(0);
}

const args = process.argv.slice(2);
const targetFlag = args.indexOf("--target");
if (targetFlag !== -1 && !args[targetFlag + 1]) {
  fail("--target needs a triple after it");
}
const target = targetFlag === -1 ? null : args[targetFlag + 1];

/** The identity to sign with. `-` is ad-hoc: no certificate, no team, but a
 *  real seal over real resources. `APPLE_SIGNING_IDENTITY` is the name
 *  tauri-bundler reads too, so one variable configures both halves. */
const identity = process.env.APPLE_SIGNING_IDENTITY?.trim() || "-";

// `cargo build --target` puts everything one level deeper, which moves the
// bundle with it.
const bundleDir = target
  ? join(tauriDir, "target", target, "release", "bundle")
  : join(tauriDir, "target", "release", "bundle");

const apps = listBundles(join(bundleDir, "macos"), ".app");
if (apps.length === 0) {
  fail(`no .app in ${join(bundleDir, "macos")} — did \`tauri build\` run?`);
}

for (const app of apps) {
  if (verify(app)) {
    console.log(`codesign-macos: ${app} is already validly signed`);
  } else {
    signBundle(app);
    if (!verify(app)) {
      fail(`${app} still does not verify after signing`);
    }
    console.log(`codesign-macos: signed ${app}`);
    console.warn(
      `codesign-macos: WARNING — the bundler did not sign this app, so any ` +
        `.dmg built alongside it contains the UNSIGNED copy. Check ` +
        `bundle.macOS.signingIdentity in tauri.conf.json.`,
    );
  }
  report(app);
}

// The half that actually reaches users. A signed `.app` in `target/` and a
// broken one inside the disk image is exactly the bug this script exists to
// catch, and the only way to know which is in there is to look.
for (const dmg of listBundles(join(bundleDir, "dmg"), ".dmg")) {
  verifyDmgPayload(dmg);
}

// ---------------------------------------------------------------------------

/** Every `<dir>/*<extension>`, or nothing when the directory was not built. */
function listBundles(dir, extension) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(extension))
    .map((name) => join(dir, name));
}

/** Sign the nested executables first, then the bundle around them.
 *
 *  In that order, and NOT with `--deep`: Apple deprecated `--deep` because it
 *  applies the outer bundle's flags and entitlements to everything it finds
 *  inside, which is rarely what any of those pieces should have. Signing
 *  inside-out is the documented replacement — and it matters here because
 *  `Contents/MacOS/rocspace-mcp` (the MCP sidecar `bundle.externalBin` puts
 *  beside the app) is a second Mach-O that Gatekeeper will look at. */
function signBundle(app) {
  for (const nested of nestedExecutables(app)) {
    codesign(nested);
  }
  codesign(app);
}

/** The extra Mach-O binaries in `Contents/MacOS`. The main executable is signed
 *  as part of the bundle itself, so it is not one of these. */
function nestedExecutables(app) {
  const macos = join(app, "Contents", "MacOS");
  const main = mainExecutableName(app);
  if (!existsSync(macos)) return [];
  return readdirSync(macos)
    .filter((name) => name !== main)
    .map((name) => join(macos, name))
    .filter((path) => statSync(path).isFile());
}

/** `CFBundleExecutable` out of the bundle's Info.plist. */
function mainExecutableName(app) {
  const plist = join(app, "Contents", "Info.plist");
  const out = spawnSync(
    "/usr/libexec/PlistBuddy",
    ["-c", "Print :CFBundleExecutable", plist],
    { encoding: "utf8" },
  );
  return out.status === 0 ? out.stdout.trim() : null;
}

function codesign(path) {
  // `--timestamp=none` because an ad-hoc signature cannot be timestamped and
  // asking for one is a network round trip that fails. A real identity should
  // be timestamped, so the flag is dropped for anything but `-`.
  const timestamp = identity === "-" ? ["--timestamp=none"] : ["--timestamp"];
  const result = spawnSync(
    "/usr/bin/codesign",
    ["--force", "--sign", identity, ...timestamp, path],
    { encoding: "utf8", stdio: ["inherit", "inherit", "pipe"] },
  );
  if (result.status !== 0) {
    fail(`codesign ${path} failed: ${(result.stderr || "").trim()}`);
  }
}

/** True when the signature is real, sealed and internally consistent.
 *
 *  `--deep` here (unlike when signing) is exactly right: it walks the nested
 *  code, which is the half a top-level check would miss. `--strict` is what
 *  refuses the linker-signed-with-no-resources state this script exists for. */
function verify(path) {
  return (
    spawnSync(
      "/usr/bin/codesign",
      ["--verify", "--deep", "--strict", "--verbose=2", path],
      { encoding: "utf8" },
    ).status === 0
  );
}

function report(app) {
  const details = spawnSync("/usr/bin/codesign", ["-dvvv", app], {
    encoding: "utf8",
  });
  const lines = `${details.stdout}${details.stderr}`
    .split("\n")
    .filter((line) =>
      /^(Signature|Sealed Resources|CDHash|Identifier)/.test(line),
    );
  for (const line of lines) console.log(`codesign-macos:   ${line}`);
}

/** Mount `dmg` read-only and verify the `.app` inside it.
 *
 *  The disk image is what travels, and its payload was copied out of `target/`
 *  at bundling time — before anything this script could have done to the copy
 *  left behind. Asserting on the copy in `target/` and calling the release
 *  signed would be assuming the very thing that was broken. */
function verifyDmgPayload(dmg) {
  const mountpoint = mkdtempSync(join(tmpdir(), "rocspace-dmg-"));
  const attached = spawnSync(
    "/usr/bin/hdiutil",
    [
      "attach",
      dmg,
      "-nobrowse",
      "-readonly",
      "-noverify",
      "-mountpoint",
      mountpoint,
    ],
    { encoding: "utf8" },
  );
  if (attached.status !== 0) {
    rmSync(mountpoint, { recursive: true, force: true });
    fail(`could not mount ${dmg}: ${(attached.stderr || "").trim()}`);
  }
  try {
    const inside = listBundles(mountpoint, ".app");
    if (inside.length === 0) fail(`${dmg} contains no .app`);
    for (const app of inside) {
      if (!verify(app)) {
        fail(
          `${dmg} contains an app whose signature does not verify. The bundler ` +
            `signs the app before it builds the disk image, so this means it ` +
            `did not sign at all — check bundle.macOS.signingIdentity.`,
        );
      }
      console.log(`codesign-macos: ${dmg} carries a validly signed app`);
    }
  } finally {
    spawnSync("/usr/bin/hdiutil", ["detach", mountpoint, "-quiet"]);
    rmSync(mountpoint, { recursive: true, force: true });
  }
}

function fail(message) {
  console.error(`codesign-macos: ${message}`);
  process.exit(1);
}
