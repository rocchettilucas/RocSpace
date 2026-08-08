//! What `tauri.conf.json` promises the operating system.
//!
//! Three of the fields in that file are not preferences — they are claims macOS
//! acts on, and every one of them was wrong (or missing) in the 1.0.0 bundle:
//!
//!   * **`bundle.macOS.signingIdentity`.** Absent, so tauri-bundler skipped
//!     `codesign` entirely and what shipped was the linker's ad-hoc signature
//!     claiming sealed resources that were never written. On another Mac that is
//!     not "unsigned", it is *"RocSpace is damaged and can't be opened."*
//!   * **`bundle.macOS.minimumSystemVersion`.** Absent, so Tauri wrote its
//!     `10.13` default into `LSMinimumSystemVersion` — on a `Mach-O thin
//!     (arm64)` binary, which cannot run before macOS 11.
//!   * **the window label.** The single-instance handler raises the app's
//!     window by name; a label that did not match would make a second launch do
//!     nothing at all, silently.
//!
//! Asserted here rather than trusted because none of the three fails loudly:
//! the build succeeds, the app starts on the machine that made it, and the
//! damage is only visible on somebody else's computer.

use std::path::{Path, PathBuf};

use serde_json::Value;

fn config(name: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(name);
    let raw = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path:?}: {e}"));
    serde_json::from_str(&raw).unwrap_or_else(|e| panic!("{path:?}: {e}"))
}

fn tauri_conf() -> Value {
    config("tauri.conf.json")
}

#[test]
fn the_bundle_is_signed_with_something() {
    // `-` is ad-hoc: no certificate, but a real seal over real resources, which
    // is the whole difference between Gatekeeper's "unidentified developer"
    // prompt (which a user can get past) and "damaged" (which they cannot).
    // Any non-empty identity is fine — a Developer ID would be better.
    let conf = tauri_conf();
    let identity = conf["bundle"]["macOS"]["signingIdentity"]
        .as_str()
        .expect("bundle.macOS.signingIdentity is set, or the bundler skips codesign");

    assert!(!identity.trim().is_empty(), "an empty identity signs nothing");
}

#[test]
fn the_minimum_system_version_is_one_the_binary_could_actually_run_on() {
    // macOS 11 is the first release for Apple silicon, and RocSpace ships as an
    // arm64-only binary. Tauri's own default is 10.13, which promises the app
    // to seven releases of macOS on which its architecture does not exist.
    let conf = tauri_conf();
    let raw = conf["bundle"]["macOS"]["minimumSystemVersion"]
        .as_str()
        .expect("bundle.macOS.minimumSystemVersion is set");
    let major: u32 = raw
        .split('.')
        .next()
        .and_then(|part| part.parse().ok())
        .unwrap_or_else(|| panic!("{raw} is not a version"));

    assert!(major >= 11, "{raw} predates Apple silicon");
}

#[test]
fn the_single_instance_handler_raises_the_window_the_config_declares() {
    // The handler looks the window up by label. Tauri's default label for a
    // window that does not name itself is `main`, so an explicit label added
    // later would silently break a second launch's focus — no error, no window.
    let conf = tauri_conf();
    let windows = conf["app"]["windows"]
        .as_array()
        .expect("app.windows is a list");
    let label = windows[0]
        .get("label")
        .and_then(Value::as_str)
        .unwrap_or("main");

    assert_eq!(label, rocspace_lib::MAIN_WINDOW);
}

#[test]
fn the_signing_script_runs_on_every_release_build() {
    // The signature is verified (and, if the bundler somehow did not apply one,
    // applied) by `scripts/codesign-macos.mjs`. A `tauri:build` that stopped
    // invoking it would go back to shipping bundles nobody had looked at.
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("repository root");
    let package: Value =
        serde_json::from_str(&std::fs::read_to_string(root.join("package.json")).expect("read"))
            .expect("package.json is JSON");
    let build = package["scripts"]["tauri:build"]
        .as_str()
        .expect("a tauri:build script");

    assert!(build.contains("sign:macos"), "got: {build}");
    assert!(
        root.join("scripts").join("codesign-macos.mjs").is_file(),
        "the script tauri:build calls is missing"
    );
}
