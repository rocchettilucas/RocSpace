/** Which OS the app is running on, for the handful of decisions that genuinely
 *  differ by platform.
 *
 *  `@tauri-apps/plugin-os`'s `platform()` is synchronous — it reads a global the
 *  webview is seeded with before any app code runs — but it THROWS outside a
 *  Tauri runtime, which is every unit test and every `vite dev` in a browser.
 *  So it is wrapped once, here, and answers `null` when it cannot know rather
 *  than making each caller remember the try/catch.
 *
 *  Null is deliberately not "assume macOS": a caller that has to branch should
 *  take the path that is safe when the platform is unknown, and each of the
 *  helpers below is phrased so `null` means "no". */

import { platform, type Platform } from "@tauri-apps/plugin-os";

/** The current platform, or `null` when there is no Tauri runtime to ask. */
export function currentPlatform(): Platform | null {
  try {
    return platform();
  } catch {
    return null;
  }
}

/** Windows, where RocTalk's push-to-talk is the WH_KEYBOARD_LL hook on Caps
 *  Lock rather than a configurable accelerator — see `src-tauri/src/roctalk/ptt.rs`. */
export const isWindows = (): boolean => currentPlatform() === "windows";

/** macOS, where `Alt` is Option and `Super` is Command. */
export const isMacOS = (): boolean => currentPlatform() === "macos";
