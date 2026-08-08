/** ⌘⇧M — swap the main area to RocMind, and back.
 *
 *  ⇧ for the same reason Roc's chord takes it: ⌘M is minimise on macOS, and a
 *  chord that took it would cost the user the window.
 *
 *  Bound on the document in the CAPTURE phase, like every other main-area
 *  chord: a focused terminal owns the keyboard through xterm's hidden textarea,
 *  so a bubble-phase listener races it for a key it may consume, and an
 *  unclaimed chord goes down the PTY as text.
 *
 *  Toggling always returns to the terminals rather than to whatever was showing
 *  before, matching ⌘⇧P and ⌘⇧R: the dock is the way home from every surface,
 *  and a chord that returned to the board sometimes and the panes other times
 *  would be a chord you have to think about. */

import { useEffect } from "react";
import { isTypingTarget } from "@/lib/dom";
import { isAnyBlockingModalOpen, useUIStore } from "@/stores";

export function useMindShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.metaKey || e.ctrlKey || e.altKey) return;
      if (!e.shiftKey || e.key.toLowerCase() !== "m") return;
      // Settings covers the dock and every modal covers the window; each owns
      // its own keys, and nothing else should fire underneath them.
      if (isAnyBlockingModalOpen()) return;
      const showing = useUIStore.getState().mainView === "rocmind";
      // RocMind's search box is a text field, and the chord has to work from
      // inside it — otherwise the way out of the view is unreachable from the
      // box the user is typing in. Everywhere else, a text field keeps its M.
      if (!showing && isTypingTarget(document.activeElement)) return;
      e.preventDefault();
      useUIStore.getState().setMainView(showing ? "terminals" : "rocmind");
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, []);
}
