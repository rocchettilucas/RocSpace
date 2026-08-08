/** The sidebar's way into the board.
 *
 *  A nav row rather than a workspace: the BridgeSpace demo makes its board a
 *  row in the same tablist as the projects, which reads well until you ask
 *  which project the board is *of*. RocSpace's board is always the active
 *  workspace's, so it is a view of the workspace you are already in — a toggle,
 *  and it says so with `aria-pressed`. */

import { SquareKanban } from "lucide-react";
import { cn } from "@/lib/utils";
import { useMainView, useUIStore, useWorkspaces } from "@/stores";

export function RocPlanRow() {
  const mainView = useMainView();
  const setMainView = useUIStore((s) => s.setMainView);
  const workspaces = useWorkspaces();
  const active = mainView === "rocplan";
  /** The chord's question, asked here too. ⌘⇧P refuses to open a board with no
   *  workspace to plan against — the board would have nowhere to keep a plan —
   *  and this row used to open it anyway, which is one entry point contradicting
   *  the other about whether the thing exists. Leaving is always allowed, so
   *  the board is never a room with no door out. */
  const canOpen = workspaces.length > 0;
  const disabled = !active && !canOpen;

  return (
    <div className="shrink-0 px-1.5 pb-1">
      <button
        type="button"
        aria-pressed={active}
        disabled={disabled}
        title={
          disabled
            ? "RocPlan keeps its board in a project directory — open a workspace first"
            : "RocPlan (⌘⇧P)"
        }
        onClick={() => setMainView(active ? "terminals" : "rocplan")}
        className={cn(
          "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs",
          disabled
            ? "cursor-not-allowed text-fg-muted opacity-50"
            : active
              ? "bg-surface-2 font-medium text-fg-primary"
              : "text-fg-secondary hover:bg-surface-2 hover:text-fg-primary",
        )}
      >
        <SquareKanban className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">RocPlan</span>
        <kbd className="shrink-0 text-[10px] text-fg-muted">⌘⇧P</kbd>
      </button>
    </div>
  );
}
