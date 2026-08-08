/** ⌘S saves the file the editor is on · ⌘P opens the file finder.
 *
 *  Bound on the document in the CAPTURE phase for the same reason the pane and
 *  workspace chords are: a focused terminal owns the keyboard through xterm's
 *  hidden textarea, so a bubble-phase listener would race it, and an unclaimed
 *  chord would also go down the PTY. Both claim the event.
 *
 *  Both stand down inside a text field — with the one exception that is their
 *  whole point: Monaco. Its input sink is a `<textarea>` like every other, so
 *  the ordinary rule would make save dead in the only place anyone presses it,
 *  and "open another file" unreachable from the file you are in.
 *  `isCodeEditorInput` is what tells the two kinds of field apart.
 *
 *  ⌘⇧S is already the session save and ⌘⇧P is already the board, which is why
 *  save-all is a palette action rather than a chord: a second meaning for ⇧ on
 *  either would be a coin toss for the user, and a shortcut nobody can predict
 *  is worse than one that does not exist. ⌘P itself was left deliberately
 *  unbound through Phases 1–4 for exactly this. */

import { useEffect } from "react";
import { isCodeEditorInput, isTypingTarget } from "@/lib/dom";
import {
  isAnyBlockingModalOpen,
  useEditorStore,
  useUIStore,
  useWorkspacesStore,
} from "@/stores";

export function useEditorShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const key = e.key.toLowerCase();
      if (key !== "s" && key !== "p") return;
      // Settings covers the dock and every modal covers the window; each owns
      // its own keys and nothing else should fire underneath them — the finder
      // and the editor's own two dialogs included, which is why they are in
      // `blockingModalOpen` rather than checked for here.
      if (isAnyBlockingModalOpen()) return;
      const here = document.activeElement;
      if (isTypingTarget(here) && !isCodeEditorInput(here)) return;

      if (key === "s") {
        // Claimed whether or not anything is dirty: a chord that sometimes
        // reaches the webview is a chord that sometimes opens the webview's own
        // save dialog, and "nothing to save" is not a failure worth a toast.
        e.preventDefault();
        void useEditorStore.getState().save();
        return;
      }

      // ⌘P needs somewhere to look. With no project directory there is nothing
      // to walk, so the chord is left unclaimed rather than opening a box that
      // can only say no.
      const { workspaces, activeWorkspaceId } = useWorkspacesStore.getState();
      const root = workspaces.find(
        (w) => w.id === activeWorkspaceId,
      )?.projectPath;
      if (!root) return;
      e.preventDefault();
      useUIStore.getState().openQuickOpen();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, []);
}
