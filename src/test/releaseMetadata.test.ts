/** The metadata a release is judged by, checked at the same moment as the code.
 *
 *  Both facts here have already failed in exactly the way a test suite cannot
 *  normally see: they are properties of the BUNDLE, not of any module, so every
 *  gate stayed green while the shipped app was wrong. `pnpm test` is the only
 *  place they can be caught before a user finds them.
 *
 *  Files are read through Vite's `?raw` rather than `node:fs` for the same
 *  reason `sourceBytes.test.ts` does: the project carries no `@types/node`. */

import { describe, expect, it } from "vitest";
import infoPlist from "/src-tauri/Info.plist?raw";
import tauriConf from "/src-tauri/tauri.conf.json?raw";
import packageJson from "/package.json?raw";
import cargoToml from "/src-tauri/Cargo.toml?raw";

describe("macOS bundle Info.plist", () => {
  /** RocSpace opens a cpal input stream for push-to-talk and for Roc.
   *
   *  macOS does not deny an audio request from a bundle with no usage
   *  description — it kills the process. And a dev build never shows it: a bare
   *  binary launched from a terminal has its request attributed to the
   *  terminal, which already holds the permission. So the packaged app would
   *  die on first mic use with every gate green and every dev session healthy.
   *  Shipped 1.0.0 without it once. */
  it("declares why the app wants the microphone", () => {
    expect(infoPlist).toContain("NSMicrophoneUsageDescription");
    // A key with an empty value is the same crash as no key at all.
    const value =
      /<key>NSMicrophoneUsageDescription<\/key>\s*<string>([^<]*)<\/string>/.exec(
        infoPlist,
      );
    expect(value?.[1]?.trim()).toBeTruthy();
  });

  it("stays out of the fields Tauri generates", () => {
    // Tauri writes these from tauri.conf.json. Declaring them here too creates
    // a second source of truth that drifts silently — the merge would let this
    // file quietly win and pin the bundle to a stale version.
    for (const generated of [
      "CFBundleShortVersionString",
      "CFBundleVersion",
      "CFBundleIdentifier",
    ]) {
      expect(infoPlist).not.toContain(generated);
    }
  });
});

describe("version", () => {
  /** Three manifests carry the version and nothing reconciles them. The topbar
   *  badge and Settings › About both read the Tauri one at runtime, so a
   *  package.json left behind does not show up on screen — it shows up later,
   *  in a release artifact named after a version the app does not claim. */
  it("agrees across every manifest that declares it", () => {
    const pkg = (JSON.parse(packageJson) as { version: string }).version;
    const tauri = (JSON.parse(tauriConf) as { version: string }).version;
    // Cargo.toml is TOML, so match the key in the [package] table rather than
    // add a parser for one field.
    const cargo = /^\s*version\s*=\s*"([^"]+)"/m.exec(cargoToml)?.[1];

    expect(pkg).toMatch(/^\d+\.\d+\.\d+$/);
    expect(tauri).toBe(pkg);
    expect(cargo).toBe(pkg);
  });
});
