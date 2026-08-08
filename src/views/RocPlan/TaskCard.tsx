/** One card on the board.
 *
 *  Three ways to move it, because the board is used three ways: dragged with
 *  the mouse, nudged with the hover movers, and walked with the arrow keys. The
 *  keyboard route is not an afterthought — the card's face is a `role="button"`
 *  with a tab stop and an `aria-label` that says which column it is in and that
 *  the arrows will move it, so the board is usable without ever touching the
 *  pointer.
 *
 *  The face is the card's BODY, and the body is what the user clicks: the
 *  title, the priority pill, the note count and the space around them. What is
 *  outside it is exactly what has to be — a button's children are
 *  presentational as far as ARIA is concerned, so the movers and the agent chip
 *  (which are buttons of their own) would be controls a screen reader is
 *  entitled to never announce, and interactive content inside a button is
 *  invalid besides. Nothing else. Moving the pill and the count out along with
 *  them, as an earlier pass did, shrinks the target to one line of text with a
 *  strip of dead card under it.
 *
 *  So: the frame owns the drag and the border; the face owns the tab stop, the
 *  label, the keys and the whole body; the movers are the face's siblings,
 *  absolutely positioned back into the corner they sat in when they were
 *  inline, and the chip is a sibling in a row beside it, where it reserves its
 *  own width rather than covering text.
 *
 *  Every route ends in the same `onMove`, and the columns it may travel are
 *  handed down rather than assumed: Cancelled is hidden behind a header toggle,
 *  and an arrow key that walked a card into a column nobody can see would
 *  simply lose it. */

import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  COLUMN_META,
  PRIORITY_META,
  tintedFill,
} from "@/views/RocPlan/taskMeta";
import type { RocTask, RocTaskStatus } from "@/lib/bindings";

/** The `dataTransfer` type a card drag carries, and the one a column requires
 *  before it will advertise a drop.
 *
 *  It used to be `text/plain`, which is what the SIDEBAR's workspace rows drag
 *  with — and the sidebar sits directly beside the board. Dragging a workspace
 *  across a column tinted it and offered "Drop here"; the drop then read a
 *  workspace id out of `text/plain`, looked for a task with that id, found
 *  none, and did nothing at all. A drop target that advertises for anything is
 *  a promise the board cannot keep, and the only way to keep it is a payload
 *  the column can recognise BEFORE the drop — `dataTransfer.types` is readable
 *  during `dragover`, while the data itself is not.
 *
 *  `text/plain` is still set alongside it (see the drag start below), so the
 *  card carries something legible to anything outside the board; nothing on the
 *  board reads it. */
export const TASK_DRAG_TYPE = "application/x-rocspace-task";

export function TaskCard({
  task,
  columns,
  accentColor,
  onMove,
  onOpen,
  onJumpToAgent,
}: {
  task: RocTask;
  /** The columns currently on screen, in board order. */
  columns: readonly RocTaskStatus[];
  /** The workspace's accent — what the assigned-agent chip wears, so a card
   *  and the pane it was dispatched to read as the same project. */
  accentColor: string;
  onMove: (taskId: string, status: RocTaskStatus) => void;
  onOpen: (taskId: string) => void;
  /** Go and look at the pane this card is assigned to. Optional so a card can
   *  still be rendered somewhere there is no dock to jump into. */
  onJumpToAgent?: (terminalName: string) => void;
}) {
  const priority = PRIORITY_META[task.priority];
  const column = COLUMN_META[task.status];
  const index = columns.indexOf(task.status);
  const previous = index > 0 ? columns[index - 1] : undefined;
  const next =
    index !== -1 && index < columns.length - 1 ? columns[index + 1] : undefined;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onOpen(task.id);
      return;
    }
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    // Claimed before we know whether there is anywhere to go, so that an arrow
    // at the END of the row is claimed too: the column strip scrolls
    // horizontally, and the browser's answer to a left arrow in the last
    // column is to scroll the board out from under the card the user is
    // holding. The comment here used to promise this while the early return
    // below it handed those two keys straight back.
    e.preventDefault();
    const target = e.key === "ArrowLeft" ? previous : next;
    if (target === undefined) return;
    onMove(task.id, target);
  };

  return (
    // The frame, and the drag source — but NOT the button. A `role="button"`
    // has presentational children as far as ARIA is concerned, so the movers
    // nested inside the old one were controls a screen reader was entitled to
    // never announce, and interactive content inside a button is invalid
    // besides. The button is the card's face below; the movers are its
    // siblings, positioned back into the corner they used to sit in.
    <div
      draggable
      data-task-id={task.id}
      onDragStart={(e) => {
        e.dataTransfer.setData(TASK_DRAG_TYPE, task.id);
        // Belt as well as braces: the typed payload above is what the columns
        // read and what they gate on, and this is what a text field, an editor
        // or another application gets if the card is dragged out of the board.
        e.dataTransfer.setData("text/plain", task.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      className={cn(
        "group relative flex cursor-grab flex-col overflow-hidden rounded-card",
        "border border-border bg-surface-2 py-2 pl-3 pr-2",
        "transition-transform hover:-translate-y-px hover:border-border-hover",
      )}
    >
      {/* Priority, read before the words are: the bar is the only part of a
          card visible when the column is scrolled to its edge. */}
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 w-[3px]"
        style={{ background: priority.tint }}
      />

      {/* The face and the chip sit in one row so the chip reserves its own
          width rather than being positioned over text it would cover. Only the
          CHIP is out of the face — it is a button (it jumps to the pane), and
          a button inside a `role="button"` is a control a screen reader is
          entitled to never announce, and invalid HTML besides. The pill and the
          note count are not buttons, so they belong to the card's body, which
          is the thing the user clicks to open it. */}
      <div className="flex min-h-0 flex-1 items-start gap-2">
        <div
          role="button"
          tabIndex={0}
          // Says what it is, where it is, and how to move it — the three things
          // a screen-reader user cannot get from the layout.
          aria-label={`${task.title} — ${priority.label} priority, ${column.label}${
            task.assignedTerminalName
              ? `, assigned to ${task.assignedTerminalName}`
              : ", unassigned"
          }. Left and right arrows move it between columns; Enter opens it.`}
          onKeyDown={handleKeyDown}
          onClick={() => onOpen(task.id)}
          className={cn(
            "min-w-0 flex-1 self-stretch rounded-input text-left",
            "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent",
          )}
        >
          <p className="text-xs font-medium leading-snug text-fg-primary">
            {task.title}
          </p>

          {/* `pr-11` reserves the movers' corner: they are out of the flow, and
              a pill running underneath them would be a pill nobody can read. */}
          <div className="mt-2 flex flex-wrap items-center gap-1.5 pr-11">
            <span
              className="rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide"
              style={{
                background: tintedFill(priority.tint),
                color: priority.tint,
              }}
            >
              {priority.label}
            </span>
            {task.findings.length > 0 ? (
              <span className="text-[10px] tabular-nums text-fg-muted">
                {`${task.findings.length} note${task.findings.length === 1 ? "" : "s"}`}
              </span>
            ) : null}
          </div>
        </div>

        {task.assignedTerminalName ? (
          <AgentChip
            name={task.assignedTerminalName}
            accentColor={accentColor}
            onJump={onJumpToAgent}
          />
        ) : null}
      </div>

      {/* The pointer's version of the arrow keys. Revealed on hover, but kept
          reachable by focus so they are not a mouse-only feature. */}
      <span className="absolute bottom-2 right-2 flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        <MoveButton
          direction="left"
          label={
            previous
              ? `Move "${task.title}" to ${COLUMN_META[previous].label}`
              : undefined
          }
          onClick={() => previous && onMove(task.id, previous)}
        />
        <MoveButton
          direction="right"
          label={
            next
              ? `Move "${task.title}" to ${COLUMN_META[next].label}`
              : undefined
          }
          onClick={() => next && onMove(task.id, next)}
        />
      </span>
    </div>
  );
}

/** Who has this card, and the way over to them.
 *
 *  The name is the pane's, so the shortest route from "what is this agent
 *  doing?" to the answer is a click on it. A plain chip when there is nowhere
 *  to jump to, so the card does not offer a control that would do nothing. */
function AgentChip({
  name,
  accentColor,
  onJump,
}: {
  name: string;
  accentColor: string;
  onJump?: (terminalName: string) => void;
}) {
  const style = {
    background: tintedFill(accentColor),
    color: accentColor,
  };
  const className =
    "flex shrink-0 items-center gap-1 self-start rounded-full px-1.5 py-0.5 text-[10px] font-medium";
  const dot = (
    <span
      aria-hidden
      className="h-1.5 w-1.5 rounded-full"
      style={{ background: accentColor }}
    />
  );

  if (!onJump) {
    return (
      <span className={className} style={style}>
        {dot}
        {name}
      </span>
    );
  }
  return (
    <button
      type="button"
      aria-label={`Go to ${name}`}
      title={`Go to ${name}`}
      onClick={() => onJump(name)}
      className={cn(
        className,
        "hover:opacity-80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent",
      )}
      style={style}
    >
      {dot}
      {name}
    </button>
  );
}

/** A ‹ or › nudge. Disabled — not hidden — at the ends of the row, so the pair
 *  does not reflow as a card travels across the board. */
function MoveButton({
  direction,
  label,
  onClick,
}: {
  direction: "left" | "right";
  label: string | undefined;
  onClick: () => void;
}) {
  const Icon = direction === "left" ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      disabled={label === undefined}
      aria-label={label ?? `Move ${direction}`}
      title={label}
      onClick={onClick}
      className={cn(
        "grid h-5 w-5 place-items-center rounded text-fg-muted",
        label === undefined
          ? "cursor-not-allowed opacity-30"
          : "hover:bg-surface-3 hover:text-fg-primary",
      )}
    >
      <Icon className="h-3 w-3" />
    </button>
  );
}
