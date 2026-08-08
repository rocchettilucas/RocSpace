import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  useActiveEditorPath,
  useDirtyBuffers,
  useEditorStore,
  useEditorTabs,
  useUIStore,
} from "@/stores";

export function TabStrip() {
  const tabs = useEditorTabs();
  const activePath = useActiveEditorPath();
  const dirty = useDirtyBuffers();
  const setActive = useEditorStore((s) => s.setActive);
  const closeTab = useEditorStore((s) => s.closeTab);
  const openEditorPrompt = useUIStore((s) => s.openEditorPrompt);

  if (tabs.length === 0) return null;

  return (
    <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto bg-surface-1">
      {tabs.map((t) => {
        const isActive = t.path === activePath;
        const isDirty = dirty[t.path] !== undefined;
        return (
          <div
            key={t.path}
            className={cn(
              "group flex shrink-0 items-center gap-2 border-r border-border pl-3 pr-1.5 text-xs",
              isActive
                ? "bg-surface-0 text-fg-primary"
                : "bg-surface-1 text-fg-secondary hover:bg-surface-2",
            )}
          >
            <button
              type="button"
              onClick={() => setActive(t.path)}
              title={isDirty ? `${t.path} — unsaved changes` : t.path}
              className="max-w-[180px] truncate"
            >
              {t.name}
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                // Unsaved work is never closed on one click. The dialog is the
                // only thing that knows the third answer — save it — and the
                // store's `closeTab` drops the buffer without asking, because
                // by the time it is called the question has been answered.
                if (isDirty) {
                  openEditorPrompt({ type: "unsaved-close", path: t.path });
                  return;
                }
                closeTab(t.path);
              }}
              title={isDirty ? `Close ${t.name} — unsaved` : `Close ${t.name}`}
              aria-label={
                isDirty ? `Close ${t.name} (unsaved)` : `Close ${t.name}`
              }
              className={cn(
                "rounded p-0.5 text-fg-muted hover:bg-surface-3 hover:text-fg-primary",
                // A dirty tab keeps its marker on show — the dot IS the close
                // button, so hiding it until hover would hide the fact that
                // there is unsaved work in a tab nobody is pointing at.
                isDirty || isActive ? "opacity-100" : "opacity-0",
                "group-hover:opacity-100",
              )}
            >
              {isDirty ? (
                <span
                  aria-hidden
                  className={cn(
                    "block h-2 w-2 rounded-full bg-accent",
                    // Swap to the × under the pointer, so one click still
                    // closes and the target does not move.
                    "group-hover:hidden",
                  )}
                />
              ) : null}
              <X
                className={cn(
                  "h-3 w-3",
                  isDirty ? "hidden group-hover:block" : "block",
                )}
              />
            </button>
          </div>
        );
      })}
    </div>
  );
}
