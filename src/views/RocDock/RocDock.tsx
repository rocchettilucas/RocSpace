import { useEffect } from "react";
import { isTypingTarget } from "@/lib/dom";
import { PaneTree } from "@/views/RocDock/PaneTree";
import { closeFocusedPane, splitFocused } from "@/views/RocDock/paneActions";
import { arePaneChordsBlocked, useActiveWorkspace } from "@/stores";

/** RocDock — the multi-terminal manager pane.
 *  Renders the active workspace's split tree (PaneTree). The Editor and Browser
 *  views live in the RightPanel; RocDock is terminals-only. */
export function RocDock() {
  const workspace = useActiveWorkspace();
  usePaneShortcuts();

  return (
    <main className="flex h-full flex-col bg-surface-0">
      <header className="flex h-9 items-center justify-between border-b border-border bg-surface-1 px-3">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-fg-muted">
            RocDock
          </span>
          {workspace ? (
            <>
              <span className="h-3 w-px bg-border" />
              <span className="text-xs text-fg-secondary">
                {workspace.name}
              </span>
            </>
          ) : null}
        </div>
      </header>
      <div className="relative flex-1 overflow-hidden">
        <PaneTree />
      </div>
    </main>
  );
}

/** ⌘D split right · ⌘⇧D split down · ⌘N new pane · ⌘W close pane.
 *
 *  Bound on the document in the CAPTURE phase, and every handled chord calls
 *  `preventDefault`. A focused terminal owns the keyboard — xterm's hidden
 *  textarea has it — so a bubble-phase listener would be racing xterm for keys
 *  it may consume, and an unclaimed ⌘D would also go down the PTY.
 *
 *  Document-level, which means they keep firing while this component is off
 *  screen: the dock stays mounted behind RocPlan so its terminals keep
 *  streaming. `arePaneChordsBlocked` is what makes them stand down there.
 *
 *  Meta only, never Ctrl: Ctrl-D is end-of-input in every shell these panes
 *  run, and stealing it to split a window would be a genuinely destructive
 *  misfire. Windows gets no pane chords until it gets its own map. */
function usePaneShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.metaKey || e.ctrlKey || e.altKey) return;
      // Anything modal owns the window and owns its own keys with it, and the
      // dock has to be the view these chords are aimed at — see
      // `arePaneChordsBlocked`. Asked as one question rather than as a list of
      // flags because the list is what went wrong twice: this guard named two
      // of the three modals, so ⌘W closed a pane behind the Save session
      // prompt; then RocPlan arrived and ⌘W closed one behind the board.
      if (arePaneChordsBlocked()) return;
      if (isTypingTarget(document.activeElement)) return;

      switch (e.key.toLowerCase()) {
        case "d":
          e.preventDefault();
          splitFocused(e.shiftKey ? "column" : "row");
          return;
        case "n":
          if (e.shiftKey) return;
          e.preventDefault();
          splitFocused("row");
          return;
        case "w":
          if (e.shiftKey) return;
          e.preventDefault();
          closeFocusedPane();
          return;
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, []);
}
