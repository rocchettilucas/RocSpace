// Build `rocspace-mcp` and, optionally, stage it where Tauri's bundler expects
// a sidecar.
//
// Why this exists at all: `rocspace-mcp` is a second `[[bin]]` of the same
// crate as the app, and neither of the two ways RocSpace runs was building it.
//
//   - `cargo tauri dev` shells out to `cargo run`, and `cargo run` builds ONLY
//     the binary it is about to run. `target/debug/rocspace-mcp` existed on a
//     developer's machine solely because `cargo test` had happened to build it
//     for the integration suite. On a clean checkout, no server binary — and
//     `mcp_binary_path` correctly answering `None` meant every Claude pane
//     launched without the board's tools and nothing said so.
//   - `cargo tauri build` bundled the app and nothing else. The shipped
//     `.app` had no server in it at all, so the feature could not work for a
//     single user of a release.
//
// Run with no arguments it builds the debug binary, which lands next to
// `target/debug/rocspace` — which is exactly where `mcp_binary_path` looks.
// That is the dev half, and it is wired into `beforeDevCommand`.
//
// Run with `--release --stage` it also copies the result to
// `src-tauri/binaries/rocspace-mcp-<target-triple>`, the name
// `bundle.externalBin` requires. That is the production half, and it is wired
// into `pnpm tauri:build`.
//
// `--stage` is deliberately NOT in `tauri.conf.json`: declaring `externalBin`
// there makes the staged file a hard requirement of every `cargo build`,
// `cargo test` and `cargo clippy` of the app crate, because `tauri-build`
// copies external binaries from its build script and fails when one is
// missing. The declaration lives in `src-tauri/tauri.bundle.conf.json`, merged
// in only by `pnpm tauri:build`.
//
// And that staging has to happen BEFORE `tauri build` starts, which is why it
// sits in the `tauri:build` script rather than in `beforeBuildCommand` where it
// would read more naturally. `tauri build --config` exports the merged config
// as `TAURI_CONFIG` and only then runs `beforeBuildCommand`; the `cargo build`
// below would inherit it, so `tauri-build` would demand the very sidecar this
// script is in the middle of producing. Staging first keeps that cargo
// invocation outside the bundling config entirely.

import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const BIN = "rocspace-mcp";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tauriDir = join(root, "src-tauri");

const args = process.argv.slice(2);
const release = args.includes("--release");
const stage = args.includes("--stage");
const targetFlag = args.indexOf("--target");
const target = targetFlag === -1 ? hostTriple() : args[targetFlag + 1];

if (targetFlag !== -1 && !target) {
  fail("--target needs a triple after it");
}

/** The triple `rustc` will build for by default. */
function hostTriple() {
  const out = run("rustc", ["-vV"]);
  const line = out.split("\n").find((l) => l.startsWith("host: "));
  if (!line) fail("could not read the host target triple out of `rustc -vV`");
  return line.slice("host: ".length).trim();
}

/** Run a command, capture stdout, and stop the build if it fails. */
function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    encoding: "utf8",
    stdio: ["inherit", "pipe", "inherit"],
    ...options,
  });
  if (result.error) fail(`${command}: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`${command} ${commandArgs.join(" ")} exited ${result.status}`);
  }
  return result.stdout;
}

function fail(message) {
  console.error(`build-mcp-sidecar: ${message}`);
  process.exit(1);
}

// `--message-format=json-render-diagnostics` keeps warnings and errors looking
// the way a developer expects them on stderr, while stdout carries one JSON
// object per event. The artifact event names the executable's absolute path,
// which is how this works whatever `CARGO_TARGET_DIR` is set to — and it is set
// to something unusual on at least one machine here.
const cargoArgs = [
  "build",
  "--bin",
  BIN,
  "--message-format=json-render-diagnostics",
];
if (release) cargoArgs.push("--release");
if (targetFlag !== -1) cargoArgs.push("--target", target);

const built = run("cargo", cargoArgs, { cwd: tauriDir })
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  })
  .filter((event) => event?.reason === "compiler-artifact" && event.executable)
  .filter((event) => event.target?.name === BIN)
  .map((event) => event.executable)
  .pop();

if (!built) {
  fail(`cargo built no executable for \`${BIN}\``);
}
console.log(`build-mcp-sidecar: built ${built}`);

if (stage) {
  const extension = target.includes("windows") ? ".exe" : "";
  const staged = join(tauriDir, "binaries", `${BIN}-${target}${extension}`);
  mkdirSync(dirname(staged), { recursive: true });
  copyFileSync(built, staged);
  // `copyFileSync` keeps the source's mode on every platform this ships to,
  // but a sidecar that is not executable is a bundle that fails at run time
  // rather than at build time, which is the expensive way to find out.
  chmodSync(staged, 0o755);
  console.log(`build-mcp-sidecar: staged ${staged}`);
}
