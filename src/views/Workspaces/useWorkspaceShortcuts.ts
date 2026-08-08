/** ⌘T new workspace · ⌘⇧S save the session · ⌘⇧P the board · ⌘1-9 switch to
 *  the nth workspace.
 *
 *  Bound on the document in the CAPTURE phase for the same reason the pane
 *  chords are: a focused terminal owns the keyboard through xterm's hidden
 *  textarea, so a bubble-phase listener would race it for keys it may consume,
 *  and an unclaimed chord would also go down the PTY. Every handled chord calls
 *  `preventDefault`.
 *
 *  Meta only, never Ctrl — Ctrl-digit and Ctrl-T mean things inside the shells
 *  these panes run. Windows gets no chords until it gets its own map. */

import { useEffect } from "react";
import { isTypingTarget } from "@/lib/dom";
import {
  isAnyBlockingModalOpen,
  useUIStore,
  useWorkspacesStore,
} from "@/stores";

export function useWorkspaceShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.metaKey || e.ctrlKey || e.altKey) return;
      const ui = useUIStore.getState();
      // Settings covers the dock and each modal covers the window; each owns
      // its own keys and nothing else should fire underneath them. The same
      // question the pane chords ask — see `isAnyBlockingModalOpen`.
      if (isAnyBlockingModalOpen()) return;
      if (isTypingTarget(document.activeElement)) return;

      if (!e.shiftKey && e.key.toLowerCase() === "t") {
        e.preventDefault();
        ui.openWorkspaceModal();
        return;
      }

      // ⌘⇧S — name and save the active workspace. Claimed even with no
      // workspace open, so the chord never falls through to the browser's own
      // save dialog; the modal itself says there is nothing to save.
      if (e.shiftKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        ui.openSaveSessionModal();
        return;
      }

      // ⌘⇧P toggles the board. ⌘P itself is deliberately untouched — it is
      // reserved for the quick-open Phase 5 brings, and a chord that meant one
      // thing for two phases and something else afterwards is worse than one
      // that never existed.
      //
      // Claimed even with no workspace open (the board would have nothing to
      // plan against), so the chord cannot fall through to the webview while
      // the empty state is up — but it does not OPEN a view nobody can see.
      // Only the opening direction: refusing both ways left the board a room
      // with no door out if the last workspace closed while it was up. The
      // sidebar's RocPlan row asks the same question — see `RocPlanRow`.
      if (e.shiftKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        if (ui.mainView === "rocplan") {
          ui.setMainView("terminals");
          return;
        }
        if (useWorkspacesStore.getState().workspaces.length === 0) return;
        ui.setMainView("rocplan");
        return;
      }

      // ⌘1-9 address the sidebar's order, not workspace ids: what the user is
      // counting is rows. A digit past the end does nothing rather than
      // clamping to the last workspace — pressing ⌘7 with three open is a
      // miss, and landing somewhere unrelated is worse than landing nowhere.
      if (e.key >= "1" && e.key <= "9") {
        const index = Number(e.key) - 1;
        const { workspaces, setActiveWorkspace } =
          useWorkspacesStore.getState();
        const target = workspaces[index];
        if (!target) return;
        e.preventDefault();
        setActiveWorkspace(target.id);
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, []);
}
