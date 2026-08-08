/** ⌘K — open the command palette, and close it again.
 *
 *  Bound on the document in the CAPTURE phase for the same reason every other
 *  chord in this app is: a focused terminal owns the keyboard through xterm's
 *  hidden textarea, so a bubble-phase listener would race it, and an unclaimed
 *  ⌘K would go down the PTY as well. Claimed with `preventDefault` either way.
 *
 *  Two rules that are not the usual ones:
 *
 *  * **The palette answers its own chord first.** ⌘K while it is up closes it,
 *    from inside its search field included — the field is a text entry, and the
 *    rule that a chord stands down in one exists so typing is never eaten. A
 *    chord that opens a box you then cannot dismiss with the same keys is worse
 *    than one that never fired. Same reasoning as ⌘⇧R inside Roc's command bar.
 *  * **Everything else stands down for it.** `isAnyBlockingModalOpen` counts
 *    the palette, so once it is open no other chord acts on the app behind it —
 *    a scrim stops the mouse, not the keyboard.
 *
 *  Meta only, never Ctrl: Ctrl-K is "kill to end of line" in every shell these
 *  panes run, and binding it would be a destructive misfire. */

import { useEffect } from "react";
import { isTypingTarget } from "@/lib/dom";
import { isAnyBlockingModalOpen, useUIStore } from "@/stores";

export function useCommandPaletteShortcut(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (e.key.toLowerCase() !== "k") return;

      const ui = useUIStore.getState();
      if (ui.isCommandPaletteOpen) {
        e.preventDefault();
        ui.closeCommandPalette();
        return;
      }
      // Settings covers the dock and each modal covers the window; each owns
      // its own keys. The palette does not open on top of one.
      if (isAnyBlockingModalOpen()) return;
      // A real text field keeps ⌘K — a rename in progress, a card's
      // description. The focused terminal is not one (see `isTypingTarget`).
      if (isTypingTarget(document.activeElement)) return;

      e.preventDefault();
      ui.openCommandPalette();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, []);
}
