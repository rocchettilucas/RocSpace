/** One column of the board: a tinted header with a count, and the cards under
 *  it.
 *
 *  The column is the drop target, not the cards — dropping a card *between* two
 *  others is a reorder, and the plan file has no order to reorder into (it is a
 *  set of tasks with statuses). So a drop anywhere in the column means one
 *  thing, which is also what makes the empty state a legitimate target rather
 *  than a dead rectangle.
 *
 *  A target for CARDS, and nothing else. The column used to `preventDefault`
 *  every `dragover` it saw and set `dropEffect = "move"` unconditionally, which
 *  is a promise to anything the pointer is holding: a workspace row dragged out
 *  of the sidebar — which is one panel to the left — tinted the column, offered
 *  "Drop here", and then dropped into a `moveTask` for a task id that was
 *  really a workspace id, which matched nothing and did nothing. So the drag
 *  now carries a type of its own (`TASK_DRAG_TYPE`) and the column asks for it
 *  before it lights up. `dataTransfer.types` is readable during a drag; the
 *  data behind it is not, which is why the check is on the type and not on the
 *  payload. */

import { Inbox, Plus } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { TASK_DRAG_TYPE, TaskCard } from "@/views/RocPlan/TaskCard";
import { COLUMN_META, tintedFill } from "@/views/RocPlan/taskMeta";
import type { RocTask, RocTaskStatus } from "@/lib/bindings";

/** Is the pointer holding one of this board's cards?
 *
 *  `types` rather than `getData`, because a browser keeps a drag's payload
 *  unreadable until the drop — the list of types it carries is the only thing
 *  a `dragover` is allowed to see, and it is exactly enough. Defensive about
 *  `types` being absent because a synthesized drag event (a test, a webview
 *  quirk) can arrive without one, and a column that threw inside `dragover`
 *  would take the board down with it. */
function carriesTask(data: DataTransfer | null): boolean {
  const types = data?.types;
  if (!types) return false;
  return Array.from(types).includes(TASK_DRAG_TYPE);
}

export function BoardColumn({
  status,
  tasks,
  columns,
  accentColor,
  onMove,
  onOpen,
  onJumpToAgent,
  onCreate,
}: {
  status: RocTaskStatus;
  tasks: readonly RocTask[];
  /** Every column on screen, in board order — what the cards' arrow keys and
   *  movers may travel. */
  columns: readonly RocTaskStatus[];
  accentColor: string;
  onMove: (taskId: string, status: RocTaskStatus) => void;
  onOpen: (taskId: string) => void;
  /** Handed straight to the cards' agent chips. */
  onJumpToAgent?: (terminalName: string) => void;
  /** Present on To Do only: the one column where a brand-new task belongs. */
  onCreate?: () => void;
}) {
  const meta = COLUMN_META[status];
  const Icon = meta.icon;
  const [dragOver, setDragOver] = useState(false);

  return (
    <section
      aria-label={`${meta.label}, ${tasks.length} task${tasks.length === 1 ? "" : "s"}`}
      onDragOver={(e) => {
        // Not a card. Left un-prevented, which is how a drop target says no:
        // the browser keeps the "no drop" cursor and the drop never fires here.
        if (!carriesTask(e.dataTransfer)) return;
        // Without preventDefault the element is not a drop target at all.
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setDragOver(true);
      }}
      onDragLeave={(e) => {
        // Only when the pointer really left the column: `dragleave` also fires
        // crossing from the column onto a card inside it, and reacting to that
        // makes the highlight strobe as the pointer moves down a full column.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setDragOver(false);
        }
      }}
      onDrop={(e) => {
        setDragOver(false);
        if (!carriesTask(e.dataTransfer)) return;
        e.preventDefault();
        const taskId = e.dataTransfer.getData(TASK_DRAG_TYPE);
        if (taskId) onMove(taskId, status);
      }}
      className={cn(
        "flex w-64 shrink-0 flex-col rounded-card border border-border bg-surface-1",
        "transition-colors",
      )}
      style={{
        borderTop: `2px solid ${meta.tint}`,
        background: dragOver ? tintedFill(meta.tint, 6) : undefined,
      }}
    >
      <header className="flex h-9 shrink-0 items-center gap-1.5 px-2.5">
        <Icon
          aria-hidden
          className="h-3.5 w-3.5"
          style={{ color: meta.tint }}
        />
        <span className="text-[11px] font-semibold text-fg-primary">
          {meta.label}
        </span>
        <span
          aria-hidden
          className="rounded-full px-1.5 text-[10px] font-semibold tabular-nums"
          style={{ background: tintedFill(meta.tint), color: meta.tint }}
        >
          {tasks.length}
        </span>
        {onCreate ? (
          <button
            type="button"
            onClick={onCreate}
            // Named for its column: the board header has a New task button
            // too, and two controls that sound identical are two controls a
            // screen-reader user has to guess between.
            aria-label={`New task in ${meta.label}`}
            title="New task"
            className="ml-auto grid h-5 w-5 place-items-center rounded text-fg-muted hover:bg-surface-2 hover:text-fg-primary"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
        {tasks.length === 0 ? (
          <div
            className={cn(
              "flex flex-1 flex-col items-center justify-center gap-1.5 rounded-card",
              "border border-dashed border-border py-6 text-fg-muted",
            )}
            style={
              dragOver
                ? {
                    background: tintedFill(meta.tint, 5),
                    borderColor: meta.tint,
                  }
                : undefined
            }
          >
            <Inbox aria-hidden className="h-4 w-4" />
            <span className="text-[11px]">
              {dragOver ? "Drop here" : "No tasks"}
            </span>
          </div>
        ) : (
          tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              columns={columns}
              accentColor={accentColor}
              onMove={onMove}
              onOpen={onOpen}
              onJumpToAgent={onJumpToAgent}
            />
          ))
        )}
      </div>
    </section>
  );
}
