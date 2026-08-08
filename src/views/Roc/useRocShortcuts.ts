/** ⌘⇧R — swap the main area to Roc, and back.
 *
 *  ⇧ is not decoration: ⌘R is reload, in this webview as in every other, and a
 *  chord that took it would cost the user the app. So the shift is what makes
 *  the chord ours, and a bare ⌘R is deliberately left alone.
 *
 *  Bound on the document in the CAPTURE phase for the same reason the workspace
 *  and pane chords are: a focused terminal owns the keyboard through xterm's
 *  hidden textarea, so a bubble-phase listener would race it for a key it may
 *  consume, and an unclaimed chord would also go down the PTY.
 *
 *  Toggles through `setExpanded` rather than `setMainView` so the widget's
 *  expand button and this chord are the same call — and so `expanded` cannot
 *  drift from the view that is actually up. Collapsing only ever gives the dock
 *  back FROM Roc: pressing it while the board is showing opens Roc, and pressing
 *  it again returns to the terminals, never to the board's own toggle. */

import { useEffect } from "react";
import { isTypingTarget } from "@/lib/dom";
import { isAnyBlockingModalOpen, useRocStore, useUIStore } from "@/stores";

export function useRocShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.metaKey || e.ctrlKey || e.altKey) return;
      if (!e.shiftKey || e.key.toLowerCase() !== "r") return;
      // Settings covers the dock and every modal covers the window; each owns
      // its own keys, and nothing else should fire underneath them.
      if (isAnyBlockingModalOpen()) return;
      // The Roc view's own command bar is a text field, and so is the live
      // terminal's input — but the chord has to work from inside them, or the
      // way out of the view is unreachable from the box the user is typing in.
      if (
        useUIStore.getState().mainView !== "roc" &&
        isTypingTarget(document.activeElement)
      ) {
        return;
      }
      e.preventDefault();
      const expanded = useUIStore.getState().mainView === "roc";
      useRocStore.getState().setExpanded(!expanded);
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, []);
}
