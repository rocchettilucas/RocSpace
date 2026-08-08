/** RocPlan — the board.
 *
 *  A main-area surface, not a modal and not an overlay: it takes the RocDock's
 *  place while the dock stays mounted behind it, so switching to the plan does
 *  not cost a single line of terminal output. ⌘⇧P and the sidebar's RocPlan row
 *  are the two ways in.
 *
 *  Scoped to the active workspace's `projectPath`, because that is what the
 *  plan file belongs to: the board lives at `<projectPath>/.rocspace/plan.json`,
 *  in the repository, where an agent can read it without the app and where it
 *  travels with a branch. A workspace with no directory has nowhere to keep a
 *  plan, and says so rather than offering a board that could not be saved. */

import {
  Folder,
  Loader2,
  Plus,
  RefreshCw,
  SquareKanban,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { accentVar } from "@/lib/accentColors";
import { dispatchOnMove, jumpToAgent } from "@/lib/rocplanDispatch";
import { cn, pathTail } from "@/lib/utils";
import {
  ROC_TASK_STATUSES,
  flushPlanWrites,
  isBoardFollowed,
  useActiveWorkspace,
  useBoardError,
  useBoardLoaded,
  useBoardLoading,
  useBoardTasks,
  useRocPlanStore,
  useToastsStore,
  useUIStore,
} from "@/stores";
import { BoardColumn } from "@/views/RocPlan/BoardColumn";
import type { RocTask, RocTaskStatus } from "@/lib/bindings";

/** Columns that are always on screen. Cancelled is the fifth and sits behind a
 *  header toggle: it is where cards go to be forgotten, and a column of them
 *  would take a fifth of the board to say so. */
const DEFAULT_COLUMNS = ROC_TASK_STATUSES.filter((s) => s !== "cancelled");

export function BoardView() {
  const workspace = useActiveWorkspace();
  const projectPath = workspace?.projectPath ?? null;

  const loadBoard = useRocPlanStore((s) => s.loadBoard);
  const unloadBoard = useRocPlanStore((s) => s.unloadBoard);
  const openTaskEditor = useUIStore((s) => s.openTaskEditor);

  const tasks = useBoardTasks(projectPath);
  const loading = useBoardLoading(projectPath);
  const loaded = useBoardLoaded(projectPath);
  const error = useBoardError(projectPath);
  const [showCancelled, setShowCancelled] = useState(false);

  // Read the plan on the way in, hand the watch back on the way out. Mounted
  // only while the board is showing, so a workspace nobody is planning against
  // is not one this app is holding a file watcher for.
  useEffect(() => {
    if (!projectPath) return;
    void loadBoard(projectPath);
    return () => unloadBoard(projectPath);
  }, [projectPath, loadBoard, unloadBoard]);

  /** One pass over the tasks instead of a `useTasksByStatus` per column: the
   *  column list changes length when Cancelled is toggled, and a hook called
   *  inside that loop would break the rules of hooks the first time it did. */
  const byStatus = useMemo(() => {
    const groups = {} as Record<RocTaskStatus, RocTask[]>;
    for (const status of ROC_TASK_STATUSES) groups[status] = [];
    for (const task of tasks) groups[task.status]?.push(task);
    return groups;
  }, [tasks]);

  const columns = showCancelled ? ROC_TASK_STATUSES : DEFAULT_COLUMNS;

  /** What the header's count is a count OF: the cards on screen.
   *
   *  `tasks.length` counted cancelled cards too, which is a number the board
   *  never shows and cannot be reconciled with the four column counts under it
   *  — "12" over columns totalling 9, with the three that explain it behind a
   *  toggle. Summed over the visible columns so pressing Show cancelled moves
   *  both numbers together. */
  const visibleCount = columns.reduce(
    (sum, status) => sum + (byStatus[status]?.length ?? 0),
    0,
  );

  /** Every route a card can travel by — drag, mover, arrow key — ends here.
   *
   *  One handler on purpose, and it is `dispatchOnMove` rather than the store's
   *  `moveTask`: a card reaching In Progress means "somebody start this", and
   *  it must be impossible to move a card by a route that skipped the
   *  somebody. The store stays pure — the terminal half lives in
   *  `lib/rocplanDispatch`, which moves the card first and then goes looking
   *  for a pane.
   *
   *  Not awaited: the move is synchronous inside that call, and what follows it
   *  (waiting for a pane to stop asking the user something, writing the prompt)
   *  is not something a drag handler should hold the frame for. Failures reach
   *  the user as toasts. */
  const handleMove = (taskId: string, status: RocTaskStatus) => {
    if (!projectPath) return;
    // The one refusal this surface had no way of reporting. A board whose
    // mirror is not LIVE takes no mutations — rightly, since a whole-file write
    // from a snapshot would replace everything the repository has taken since —
    // but from the user's side the card simply springs back, three ways in a
    // row, with the reason in a console they do not have open. Every other
    // mutation path already says so: the card editor has its banner, dispatch
    // has its toasts.
    //
    // Asked here rather than read off the result for the reason given on
    // `isBoardFollowed`: a card dropped back where it started returns false
    // too, and saying anything about that would be an error message for a
    // no-op.
    if (!isBoardFollowed(projectPath)) {
      useToastsStore.getState().push({
        message:
          "That card did not move — RocSpace is not holding this project's plan, so writing would replace a file it has never read.",
        tone: "warn",
        action: {
          label: "Re-read the plan",
          run: () => void loadBoard(projectPath),
        },
      });
      return;
    }
    void dispatchOnMove(projectPath, taskId, status);
  };

  if (!workspace || !projectPath) {
    return (
      <BoardShell projectPath={null} taskCount={0}>
        <EmptyBoard
          title="Pick a project directory to plan against"
          detail="RocPlan keeps its board in the repository, at .rocspace/plan.json — so a workspace with no directory has nowhere to keep one. Open a workspace on a folder and the board appears here."
        />
      </BoardShell>
    );
  }

  /** Read the file again — the header's Refresh, and the way back from a read
   *  that failed. Safe to press with unsaved work: the store writes what it is
   *  holding first, and declines to read at all if that write cannot be made. */
  const reread = () => void loadBoard(projectPath);

  /** Try the WRITE again — what a failed write actually needs.
   *
   *  This button used to re-read, which is the opposite of a recovery: the
   *  banner it sits in means the board is showing edits that are not on disk,
   *  and reading the file replaces them with the version that does not have
   *  them. The one control offered to somebody who is about to lose work was
   *  the fastest way to lose it. */
  const retryWrite = () => void flushPlanWrites(projectPath);

  return (
    <BoardShell
      projectPath={projectPath}
      taskCount={visibleCount}
      showCancelled={showCancelled}
      onToggleCancelled={() => setShowCancelled((v) => !v)}
      onRefresh={reread}
      onCreate={loaded ? () => openTaskEditor(projectPath, null) : undefined}
    >
      {/* A write that failed is the one failure worth interrupting for: the
          board on screen is showing edits that are NOT in the repository, and
          the user has no other way to find that out. Read failures with a board
          already loaded say the same thing from the other side — what is here
          may be older than the file. */}
      {error && loaded ? (
        <div className="mx-3 mt-3 flex items-start gap-2 rounded-card border border-error/40 bg-error/10 px-3 py-2">
          <TriangleAlert
            aria-hidden
            className="mt-0.5 h-3.5 w-3.5 text-error"
          />
          <p className="min-w-0 flex-1 text-[11px] leading-relaxed text-fg-primary">
            {error.kind === "write"
              ? "These changes are not saved — RocSpace could not write .rocspace/plan.json."
              : "This board may be out of date — RocSpace could not re-read .rocspace/plan.json."}{" "}
            <span className="text-fg-muted">{error.message}</span>
          </p>
          <button
            type="button"
            onClick={error.kind === "write" ? retryWrite : reread}
            className="shrink-0 rounded-input px-2 py-0.5 text-[11px] text-fg-secondary hover:bg-surface-2 hover:text-fg-primary"
          >
            Try again
          </button>
        </div>
      ) : null}

      {loading && !loaded ? (
        <div className="grid min-h-0 flex-1 place-items-center gap-2 p-8 text-fg-muted">
          <Loader2 aria-hidden className="h-5 w-5 animate-spin" />
          <p className="text-[11px]">Reading .rocspace/plan.json…</p>
        </div>
      ) : !loaded ? (
        // Nothing to show and no board to fall back on. Deliberately not four
        // empty columns: an unreadable plan looks exactly like a plan with no
        // tasks in it, and the difference is whether adding a card would write
        // over somebody's work.
        <EmptyBoard
          title="RocPlan could not read this project's plan"
          detail={
            error?.message ??
            "The board is at .rocspace/plan.json inside the project directory."
          }
          onRetry={reread}
        />
      ) : (
        <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-3">
          {columns.map((status) => (
            <BoardColumn
              key={status}
              status={status}
              tasks={byStatus[status]}
              columns={columns}
              accentColor={accentVar(workspace.accent)}
              onMove={handleMove}
              onOpen={(taskId) => openTaskEditor(projectPath, taskId)}
              // The card names a pane; the chip is the way over to it. Leaving
              // the board is the point — a card in In Progress is a question
              // about what an agent is doing, and the answer is on screen two
              // panes away.
              onJumpToAgent={jumpToAgent}
              onCreate={
                status === "todo"
                  ? () => openTaskEditor(projectPath, null)
                  : undefined
              }
            />
          ))}
        </div>
      )}
    </BoardShell>
  );
}

/** The header band and the frame around whatever the board has to show —
 *  columns, an empty state, or a reason it has neither. */
function BoardShell({
  projectPath,
  taskCount,
  showCancelled,
  onToggleCancelled,
  onRefresh,
  onCreate,
  children,
}: {
  projectPath: string | null;
  taskCount: number;
  showCancelled?: boolean;
  onToggleCancelled?: () => void;
  onRefresh?: () => void;
  onCreate?: () => void;
  children: React.ReactNode;
}) {
  return (
    <section
      aria-label="RocPlan"
      className="flex h-full w-full flex-col bg-surface-0"
    >
      <header
        className="flex shrink-0 items-center gap-3 border-b border-border px-3 py-2.5"
        style={{
          background:
            "linear-gradient(to right, color-mix(in srgb, var(--rs-primary) 6%, transparent), transparent 60%)",
        }}
      >
        <span
          aria-hidden
          className="grid h-8 w-8 shrink-0 place-items-center rounded-card text-accent"
          style={{
            background:
              "color-mix(in srgb, var(--rs-primary) 14%, transparent)",
          }}
        >
          <SquareKanban className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-fg-primary">RocPlan</h2>
          <p className="truncate text-[11px] text-fg-muted">
            Drag a card to In Progress and an agent picks it up.
          </p>
        </div>

        {projectPath ? (
          <span
            title={projectPath}
            className="flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-surface-2/60 px-2 py-1 text-[11px] text-fg-secondary"
          >
            <Folder aria-hidden className="h-3 w-3 text-fg-muted" />
            <span className="max-w-40 truncate">{pathTail(projectPath)}</span>
            <span className="rounded-full bg-surface-3 px-1.5 text-[10px] tabular-nums text-fg-muted">
              {taskCount}
            </span>
          </span>
        ) : null}

        {onToggleCancelled ? (
          <button
            type="button"
            onClick={onToggleCancelled}
            aria-pressed={showCancelled}
            className={cn(
              "shrink-0 rounded-input px-2 py-1 text-[11px]",
              showCancelled
                ? "bg-surface-3 text-fg-primary"
                : "text-fg-secondary hover:bg-surface-2 hover:text-fg-primary",
            )}
          >
            {showCancelled ? "Hide cancelled" : "Show cancelled"}
          </button>
        ) : null}

        {onRefresh ? (
          <button
            type="button"
            onClick={onRefresh}
            aria-label="Refresh board"
            title="Re-read .rocspace/plan.json"
            className="grid h-7 w-7 shrink-0 place-items-center rounded-input text-fg-secondary hover:bg-surface-2 hover:text-fg-primary"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        ) : null}

        {onCreate ? (
          <button
            type="button"
            onClick={onCreate}
            className="flex shrink-0 items-center gap-1.5 rounded-input bg-accent px-2.5 py-1.5 text-xs font-medium text-accent-fg hover:opacity-90"
          >
            <Plus className="h-3.5 w-3.5" />
            New task
          </button>
        ) : null}
      </header>

      {children}
    </section>
  );
}

/** The board has nothing to show, and why. */
export function EmptyBoard({
  title,
  detail,
  onRetry,
}: {
  title: string;
  detail: string;
  /** Offered when the reason might not still be true. Absent for the reasons
   *  that are permanent until the user changes something (no directory). */
  onRetry?: () => void;
}) {
  return (
    <div className="grid min-h-0 flex-1 place-items-center p-8">
      <div className="flex max-w-md flex-col items-center gap-2 text-center">
        <SquareKanban aria-hidden className="h-6 w-6 text-fg-muted" />
        <p className="text-sm font-medium text-fg-primary">{title}</p>
        <p className="text-[11px] leading-relaxed text-fg-muted">{detail}</p>
        {onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            className="mt-1 rounded-input bg-surface-2 px-2.5 py-1.5 text-xs text-fg-primary hover:bg-surface-3"
          >
            Try again
          </button>
        ) : null}
      </div>
    </div>
  );
}
