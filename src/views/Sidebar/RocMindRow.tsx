/** The sidebar's way into RocMind.
 *
 *  A nav row beside RocPlan's, and a toggle for the same reason — it swaps what
 *  the main area is showing, so `aria-pressed` is what it is.
 *
 *  Unlike RocPlan's row it is never disabled. The board belongs to a project
 *  directory and has nowhere to live without one; the memory corpus is the
 *  user's whole machine, and it is worth reading with no workspace open at all
 *  — arguably most worth it then, since "what was I doing in that project"
 *  is the question you ask before you open it. */

import { Brain } from "lucide-react";
import { cn } from "@/lib/utils";
import { useMainView, useUIStore } from "@/stores";

export function RocMindRow() {
  const mainView = useMainView();
  const setMainView = useUIStore((s) => s.setMainView);
  const active = mainView === "rocmind";

  return (
    <div className="shrink-0 px-1.5 pb-1">
      <button
        type="button"
        aria-pressed={active}
        title="RocMind (⌘⇧M)"
        onClick={() => setMainView(active ? "terminals" : "rocmind")}
        className={cn(
          "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs",
          active
            ? "bg-surface-2 font-medium text-fg-primary"
            : "text-fg-secondary hover:bg-surface-2 hover:text-fg-primary",
        )}
      >
        <Brain className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">RocMind</span>
        <kbd className="shrink-0 text-[10px] text-fg-muted">⌘⇧M</kbd>
      </button>
    </div>
  );
}
