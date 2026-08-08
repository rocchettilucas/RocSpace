/** The sidebar's workspace tablist.
 *
 *  `WORKSPACES n` + `+` over a list of rows, one per workspace, in sidebar
 *  order. The list owns everything that is about the list rather than about a
 *  row: which row holds the tab stop, what the arrows do, and where a dragged
 *  row lands. */

import { Plus } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import {
  useActiveWorkspaceId,
  useUIStore,
  useWorkspaces,
  useWorkspacesStore,
} from "@/stores";
import { WorkspaceRow } from "@/views/Sidebar/WorkspaceRow";

/** What a drag carries. `text/plain` because that is the type every browser
 *  lets a drop handler read back synchronously. */
const DRAG_TYPE = "text/plain";

/** Which side of the hovered row the dragged one would land on. A drop is an
 *  insertion between two rows, never onto one, so this — and not "which row is
 *  under the pointer" — is the whole answer. */
export type DropEdge = "before" | "after";

/** The edge the pointer is nearest, by the hovered row's own midpoint.
 *
 *  Split out so the indicator and the drop share one definition: drawn from a
 *  `dragover` and re-derived from the `drop`, the two cannot disagree about
 *  where the line was. */
function edgeAt(clientY: number, rect: DOMRect): DropEdge {
  return clientY < rect.top + rect.height / 2 ? "before" : "after";
}

/** Where an insertion at `edge` of row `index` puts the row that came from
 *  `from`, in `reorderWorkspace`'s remove-then-insert terms.
 *
 *  The store splices `from` OUT and then inserts into the shortened array, so
 *  every slot above `from` has shifted down one by the time the insert happens
 *  — hence the decrement. Returns null when the drop would not move anything:
 *  the slot just above a row and the slot just below its predecessor are the
 *  same place, and asking the store to "move" a row there is a no-op. */
export function reorderTarget(
  from: number,
  index: number,
  edge: DropEdge,
): number | null {
  const insertAt = edge === "before" ? index : index + 1;
  const to = insertAt > from ? insertAt - 1 : insertAt;
  return to === from ? null : to;
}

export function WorkspaceList() {
  const workspaces = useWorkspaces();
  const activeId = useActiveWorkspaceId();
  const setActiveWorkspace = useWorkspacesStore((s) => s.setActiveWorkspace);
  const reorderWorkspace = useWorkspacesStore((s) => s.reorderWorkspace);
  const openWorkspaceModal = useUIStore((s) => s.openWorkspaceModal);

  const [dropSlot, setDropSlot] = useState<{
    index: number;
    edge: DropEdge;
  } | null>(null);
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);

  const activeIndex = workspaces.findIndex((w) => w.id === activeId);

  /** Which row holds the list's single tab stop.
   *
   *  The active one, and the first when there is none — closing the last
   *  workspace leaves `activeWorkspaceId` null, and a list where every row is
   *  `tabIndex -1` has quietly removed itself from the tab order, so the only
   *  way back to the workspaces is the mouse. */
  const tabStopIndex = activeIndex === -1 ? 0 : activeIndex;

  /** ↑/↓ move the selection and apply it — the automatic-activation tablist
   *  pattern, which is what a workspace switcher wants: arrowing to a workspace
   *  and not landing in it would be a selection that means nothing.
   *
   *  With nothing selected the first press claims the row the tab stop is on
   *  rather than stepping off it, so arriving by Tab and pressing ↓ lands on
   *  row 1 instead of skipping it.
   *
   *  Focus follows by walking the tabs in the DOM, which is the same order the
   *  store holds them in, so no ref bookkeeping is needed. */
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    if (workspaces.length === 0) return;
    e.preventDefault();

    const step = e.key === "ArrowDown" ? 1 : -1;
    const next =
      activeIndex === -1
        ? tabStopIndex
        : (activeIndex + step + workspaces.length) % workspaces.length;

    setActiveWorkspace(workspaces[next]!.id);
    const tabs = e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]');
    tabs[next]?.focus();
  };

  const handleDragStart = (index: number, e: React.DragEvent) => {
    e.dataTransfer.setData(DRAG_TYPE, workspaces[index]!.id);
    e.dataTransfer.effectAllowed = "move";
    setDraggingIndex(index);
  };

  const handleDragEnd = () => {
    setDraggingIndex(null);
    setDropSlot(null);
  };

  const handleDragOver = (index: number, e: React.DragEvent) => {
    // Without preventDefault the element is not a drop target at all.
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const edge = edgeAt(e.clientY, e.currentTarget.getBoundingClientRect());
    // A line drawn where the row already sits promises a move that the drop
    // would decline. Browsers keep the payload unreadable until the drop, so
    // the source index is the one thing tracked in state.
    if (
      draggingIndex !== null &&
      reorderTarget(draggingIndex, index, edge) === null
    ) {
      setDropSlot(null);
      return;
    }
    setDropSlot({ index, edge });
  };

  const handleDrop = (index: number, e: React.DragEvent) => {
    e.preventDefault();
    setDropSlot(null);
    setDraggingIndex(null);
    const id = e.dataTransfer.getData(DRAG_TYPE);
    const from = workspaces.findIndex((w) => w.id === id);
    if (from === -1) return;
    // Re-derived from the drop's own coordinates rather than read back out of
    // the indicator's state, so the row lands exactly where the line was.
    const edge = edgeAt(e.clientY, e.currentTarget.getBoundingClientRect());
    const to = reorderTarget(from, index, edge);
    if (to === null) return;
    reorderWorkspace(from, to);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-7 shrink-0 items-center justify-between px-3">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-fg-muted">
          Workspaces {workspaces.length}
        </span>
        <button
          type="button"
          onClick={openWorkspaceModal}
          aria-label="New workspace"
          title="New workspace (⌘T)"
          className={cn(
            "grid h-5 w-5 place-items-center rounded text-fg-muted",
            "hover:bg-surface-2 hover:text-fg-primary",
          )}
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      {workspaces.length === 0 ? (
        <p className="px-3 py-1 text-[10px] italic leading-tight text-fg-muted">
          No workspaces — press ⌘T
        </p>
      ) : (
        <div
          role="tablist"
          aria-label="Workspaces"
          aria-orientation="vertical"
          onKeyDown={handleKeyDown}
          onDragLeave={() => setDropSlot(null)}
          className="flex flex-col gap-0.5 overflow-y-auto px-1.5 pb-2"
        >
          {workspaces.map((workspace, index) => (
            <WorkspaceRow
              key={workspace.id}
              workspace={workspace}
              index={index}
              active={workspace.id === activeId}
              tabStop={index === tabStopIndex}
              dropEdge={dropSlot?.index === index ? dropSlot.edge : null}
              onActivate={() => setActiveWorkspace(workspace.id)}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
              onDragOver={handleDragOver}
              onDrop={handleDrop}
            />
          ))}
        </div>
      )}
    </div>
  );
}
