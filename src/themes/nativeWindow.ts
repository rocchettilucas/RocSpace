/** Keep the OS window in step with the active theme.
 *
 *  The webview paints everything *inside* the window; the title bar, its
 *  traffic lights and every OS-drawn control are the window's business, and
 *  macOS picks those from the window's appearance. Without this call a light
 *  theme runs behind a dark title bar with dark controls.
 *
 *  The window also has a background color of its own, distinct from anything
 *  CSS paints. It shows wherever the webview has not painted yet — most
 *  visibly at the growing edge during a resize, and for the first frames of a
 *  restore. `tauri.conf.json` pins it to the default dark theme's background so
 *  the very first frame after launch is right; from then on it has to follow
 *  the active theme, or every resize on a light theme flashes near-black.
 *
 *  Called from `applyTheme` so every path — boot, the theme picker, hydration
 *  from `settings.dat` — is covered by one call site. */

import { getCurrentWindow } from "@tauri-apps/api/window";
import { parseColor } from "@/themes/colors";
import type { ThemeDefinition } from "@/themes/types";

/** A missing `core:window:allow-set-background-color` rejects identically on
 *  every call, and arrowing through the theme picker calls this once per card.
 *  Say it once rather than filling the console with the same line. */
let warnedBackground = false;

export function syncNativeWindowTheme(theme: ThemeDefinition): void {
  try {
    // Reaching for the window handle throws outright when there is no Tauri
    // runtime (plain `vite dev`, jsdom tests). That is the expected case there,
    // not a failure, so it stays quiet — the same shape the settings store uses
    // for `settings.dat`.
    const appWindow = getCurrentWindow();

    // A *rejection*, on the other hand, means the runtime was there and said
    // no (missing `core:window:allow-set-theme`, an OS refusal) — worth seeing.
    void appWindow.setTheme(theme.mode).catch((err: unknown) => {
      console.warn("[themes] native window theme sync failed:", err);
    });

    // Tokens are hex; the window API wants channels. Alpha is dropped: the
    // window background is opaque by definition, and Windows ignores it anyway.
    const { r, g, b } = parseColor(theme.tokens.background);
    void appWindow.setBackgroundColor([r, g, b]).catch((err: unknown) => {
      if (warnedBackground) return;
      warnedBackground = true;
      console.warn("[themes] native window background sync failed:", err);
    });
  } catch {
    /* no Tauri runtime — nothing to sync */
  }
}
