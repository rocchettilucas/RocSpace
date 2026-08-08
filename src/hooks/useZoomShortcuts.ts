/** ⌘+ / ⌘− / ⌘0 — make the whole window bigger or smaller.
 *
 *  Bound on the document in the CAPTURE phase like every other chord here, and
 *  always claimed with `preventDefault`: the webview has its own zoom on these
 *  keys, and letting it through would scale the terminals too, fighting the
 *  per-pane font size in Settings › Terminal. One mechanism, not two.
 *
 *  # The one chord that does not stand down
 *
 *  Every other ⌘ chord in RocSpace waits while a modal is up, because a chord
 *  that keeps firing acts on something the user cannot see — ⌘W closing a pane
 *  behind a dialog is the shape that takes. Zoom has no such failure: it acts on
 *  the window, which is entirely visible, dialog included. Standing it down
 *  would mean the text is unreadable exactly while you are being asked to read
 *  something. It fires from inside text fields for the same reason — ⌘− is not
 *  an editing key anywhere.
 *
 *  # Which keys
 *
 *  `+` needs Shift on most layouts, so ⌘+ arrives as either `"+"` (shifted) or
 *  `"="` (the unshifted key), and both mean "bigger". `"-"` and `"_"` are the
 *  same pair going down. Shift is therefore ALLOWED here, unlike in the pane
 *  chords where it is what tells ⌘D from ⌘⇧D. */

import { useEffect } from "react";
import { zoomIn, zoomOut, DEFAULT_ZOOM } from "@/lib/zoom";
import { useSettingsStore } from "@/stores";

export function useZoomShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.metaKey || e.ctrlKey || e.altKey) return;

      const { zoom, setZoom } = useSettingsStore.getState();
      if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        setZoom(zoomIn(zoom));
        return;
      }
      if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        setZoom(zoomOut(zoom));
        return;
      }
      // ⌘0 only. ⌘1–⌘9 belong to the workspace switcher, and zero is not one
      // of them precisely because there is no zeroth row in the sidebar.
      if (e.key === "0") {
        e.preventDefault();
        setZoom(DEFAULT_ZOOM);
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, []);
}
