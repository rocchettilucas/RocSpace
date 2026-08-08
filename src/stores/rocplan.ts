/** The board's mirror of `<projectPath>/.rocspace/plan.json`.
 *
 *  Two things write that file: this app, and whatever else is holding the
 *  repository — an agent through the `rocspace-mcp` tools, the user in an
 *  editor, a merge. So the store is a *mirror*, not an owner: every mutation
 *  lands in memory immediately and is written through to disk on a 300 ms
 *  trailing debounce, and an external change re-reads the whole file. Last
 *  writer wins, which is the only rule that stays true when the other writer is
 *  a process we do not control.
 *
 *  The debounce is what makes a drag across four columns one write instead of
 *  four, and the trailing edge is what makes the file agree with the screen
 *  when the user stops. Writes are whole-file because the file is the document.
 *
 *  Which makes the write-through more than a timer, because "somebody else is
 *  writing too" has to hold across the whole of one of our writes and not just
 *  across the wait before it. Three states, per project, in `PlanWriteState`:
 *  what is unwritten, what is in the air, and whether the file moved while
 *  either was true. A change that arrives while we are busy is REMEMBERED and
 *  read once we are quiet, rather than dropped as it was; a write that fails
 *  re-arms behind a bounded backoff, rather than living in memory until the app
 *  quits; and a read never replaces a mirror that holds unwritten work.
 *
 *  What that does NOT buy is a merge: a whole-file write still overwrites an
 *  external edit made inside our debounce window, and last writer still wins.
 *  It buys convergence — the board and the file always end up agreeing, and
 *  every external change is seen rather than silently skipped.
 *
 *  Keyed by project path rather than by workspace: two workspaces opened on one
 *  directory are looking at the same board, and giving them two mirrors would
 *  let one show a card the other has already moved.
 *
 *  Never persisted to the app's own snapshot — the repository is the durable
 *  copy, and a snapshot of it would be a second, staler answer. */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { create } from "zustand";
import { devtools } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";
import { useMemo } from "react";
import { newId } from "@/lib/factories";
import {
  EVENT_ROCPLAN_CHANGED,
  commands,
  type RocPlanChangedEvent,
  type RocTask,
  type RocTaskPriority,
  type RocTaskStatus,
} from "@/lib/bindings";

/** Board columns, in the order the board draws them. Exported so the view and
 *  anything that iterates statuses share one definition of "all of them". */
export const ROC_TASK_STATUSES: readonly RocTaskStatus[] = [
  "todo",
  "in_progress",
  "in_review",
  "complete",
  "cancelled",
];

export const ROC_TASK_PRIORITIES: readonly RocTaskPriority[] = [
  "critical",
  "high",
  "medium",
  "low",
];

/** How long the store sits on a change before writing it through.
 *
 *  Long enough that a card dragged through three columns is one write, short
 *  enough that a user who edits a card and quits the app a second later still
 *  has it on disk. */
export const PLAN_WRITE_DEBOUNCE_MS = 300;

/** Why a board is unhappy.
 *
 *  The half that matters is `kind`, and it is not cosmetic: a failed READ means
 *  the board may be showing nothing, which is annoying; a failed WRITE means
 *  the board is showing edits that are not on disk, which is the user losing
 *  work without being told. The two deserve different words, so the store keeps
 *  them apart rather than making the view guess from a message Rust wrote. */
export interface BoardError {
  kind: "read" | "write";
  message: string;
}

export interface RocPlanState {
  /** The mirror, by project path. A key exists only for a board that has been
   *  read at least once — which is what makes "this project is not loaded" a
   *  question the mutations below can answer. */
  tasksByProject: Record<string, RocTask[]>;
  /** A read is in flight and there is nothing to show yet. Not set for the
   *  re-reads an external change triggers: a board that blanked every time an
   *  agent moved a card would flicker on exactly the workflow it exists for. */
  loadingByProject: Record<string, boolean>;
  /** The last read or write failure for a project, for the board to say inline
   *  instead of silently showing a stale or empty column. */
  errorByProject: Record<string, BoardError | null>;
}

export interface RocPlanActions {
  /** Read the project's plan and start following the file. Safe to call again
   *  — a second call re-reads and does NOT take a second watch. */
  loadBoard: (projectPath: string) => Promise<void>;
  /** Stop following the file. Flushes a pending write first: leaving the board
   *  is not a reason to lose the edit that had not been written yet.
   *
   *  Deliberately keeps the mirror. Coming back to a board should paint what
   *  was there and then correct itself, not flash an empty board while the read
   *  lands. */
  unloadBoard: (projectPath: string) => void;

  /* Every mutation below reports whether the change LANDED — see `mutate` for
   * the two ways one does not. A caller that shows the user an outcome has to
   * ask: a dialog that says "saved" over a task the store refused is worse
   * than one that says nothing. */

  /** Mint a task in `todo`. Returns its id, or `""` when the change did not
   *  land. */
  createTask: (
    projectPath: string,
    draft: {
      title: string;
      description?: string;
      priority?: RocTaskPriority;
      assignedTerminalName?: string | null;
    },
  ) => string;
  updateTask: (
    projectPath: string,
    taskId: string,
    patch: Partial<
      Pick<
        RocTask,
        "title" | "description" | "priority" | "assignedTerminalName"
      >
    >,
  ) => boolean;
  /** Move a card to another column. Pure — Phase 3B wraps this with dispatch
   *  rather than teaching the store about terminals.
   *
   *  False for a card already in that column as well as for a refusal: an
   *  arrow key at the end of a row is a no-op, not a failure, so this is the
   *  one return here that does not mean "something went wrong". */
  moveTask: (
    projectPath: string,
    taskId: string,
    status: RocTaskStatus,
  ) => boolean;
  appendFinding: (
    projectPath: string,
    taskId: string,
    by: string,
    text: string,
  ) => boolean;
  deleteTask: (projectPath: string, taskId: string) => boolean;
}

const initialState: RocPlanState = {
  tasksByProject: {},
  loadingByProject: {},
  errorByProject: {},
};

const message = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

// Write-through ------------------------------------------------------------

/** How many times a failed write tries again on its own, and how far apart.
 *
 *  A write fails for reasons that pass — a checkout replacing the directory,
 *  another process holding the file for a moment — and a banner that sits there
 *  until the user notices a button is a banner outliving its problem. It also
 *  fails for reasons that do not (a read-only volume), which is why this is
 *  bounded: a store that retries forever is a store writing to a full disk once
 *  a second all afternoon.
 *
 *  After the last attempt the edit stays unwritten and the banner stays up.
 *  Nothing is lost — `flushPlanWrites` still takes it, so Try again, leaving
 *  the board and quitting each get a real attempt. */
export const PLAN_WRITE_RETRIES = 4;
const retryDelayMs = (failures: number): number =>
  Math.min(PLAN_WRITE_DEBOUNCE_MS * 2 ** failures, 5_000);

/** What the store knows about one project's unwritten work.
 *
 *  Module-level rather than in the store because none of it is state anybody
 *  renders, and a re-render must not restart a timer.
 *
 *  `edits` and `written` are counters rather than a `dirty` flag because a
 *  mutation can land WHILE a write is in the air. The write that then succeeds
 *  put the state as of its own `edits` on disk; a flag cleared afterwards would
 *  call the newer edit written too, and the newer edit is the one on screen. */
interface PlanWriteState {
  /** Mutations counted for this project. */
  edits: number;
  /** The `edits` value the last write that LANDED put on disk. */
  written: number;
  /** Debounce or retry timer, if one is armed. */
  timer: ReturnType<typeof setTimeout> | null;
  /** The `plan_write` currently in the air, so a caller that has to know the
   *  file is settled can await it rather than guess. */
  flight: Promise<void> | null;
  /** Consecutive failures, for the backoff. Reset by a write that lands, and
   *  by a fresh edit — new work deserves a prompt attempt rather than the tail
   *  of a backoff earned by the last one. */
  failures: number;
  /** The file has moved and nobody has read it: `rocplan://changed` arrived
   *  while we had work outstanding, or a refresh was asked for then. The read
   *  waits until we are quiet, because doing it sooner replaces the mirror with
   *  a file our own pending write is about to make wrong. */
  rereadWhenQuiet: boolean;
}

const writes = new Map<string, PlanWriteState>();

function stateFor(projectPath: string): PlanWriteState {
  let state = writes.get(projectPath);
  if (state === undefined) {
    state = {
      edits: 0,
      written: 0,
      timer: null,
      flight: null,
      failures: 0,
      rereadWhenQuiet: false,
    };
    writes.set(projectPath, state);
  }
  return state;
}

/** The mirror holds something the disk has not been told about. */
const isUnwritten = (s: PlanWriteState): boolean => s.edits > s.written;

/** Nothing outstanding: nothing to write, nothing in the air, nothing armed. */
const isQuiet = (s: PlanWriteState): boolean =>
  !isUnwritten(s) && s.flight === null && s.timer === null;

/** Is one of our own writes still outstanding — waiting out its debounce, in
 *  the air, or waiting on a retry?
 *
 *  Read by the change listener, and it has to cover the IPC round trip. The
 *  version that only knew about the debounce timer deleted its entry BEFORE
 *  awaiting `plan_write`, so an external change arriving mid-write found
 *  nothing pending, re-read the file as it stood before our write, and then our
 *  write landed on top of what it had just read. Mirror and disk disagreed from
 *  then on, permanently: Rust suppresses the echo of our own writes, so no
 *  further `rocplan://changed` was ever coming to reconcile them. */
export const hasPendingPlanWrite = (projectPath: string): boolean => {
  const state = writes.get(projectPath);
  return state !== undefined && (isUnwritten(state) || state.flight !== null);
};

function arm(projectPath: string, delayMs: number): void {
  const state = stateFor(projectPath);
  if (state.timer !== null) clearTimeout(state.timer);
  state.timer = setTimeout(() => {
    state.timer = null;
    void writeNow(projectPath);
  }, delayMs);
}

function scheduleWrite(projectPath: string): void {
  const state = stateFor(projectPath);
  state.edits += 1;
  state.failures = 0;
  arm(projectPath, PLAN_WRITE_DEBOUNCE_MS);
}

function writeNow(projectPath: string): Promise<void> {
  const state = stateFor(projectPath);
  // One write at a time. Two `plan_write`s racing for one file is how the older
  // one wins; whatever this call was for, `settle` re-arms for it.
  if (state.flight !== null) return state.flight;
  if (state.timer !== null) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  if (!isUnwritten(state)) {
    settle(projectPath);
    return Promise.resolve();
  }

  const tasks = useRocPlanStore.getState().tasksByProject[projectPath];
  // The mirror went away between the schedule and the flush. Writing `[]` here
  // would empty the user's plan file on a teardown.
  if (!tasks) {
    writes.delete(projectPath);
    return Promise.resolve();
  }

  // Read together, and before the await: this is the state this write puts on
  // disk, and `version` is what it is allowed to mark as written.
  const version = state.edits;
  const flight = (async () => {
    try {
      await commands.planWrite(projectPath, tasks);
      state.written = version;
      state.failures = 0;
      if (useRocPlanStore.getState().errorByProject[projectPath]) {
        setError(projectPath, null);
      }
    } catch (err) {
      console.warn("[rocplan] write failed:", err);
      state.failures += 1;
      setError(projectPath, { kind: "write", message: message(err) });
    } finally {
      state.flight = null;
    }
    settle(projectPath);
  })();
  state.flight = flight;
  return flight;
}

/** What to do now that a write has settled — the half the old debounce did not
 *  have, and where both of its silences are answered.
 *
 *  A failure re-arms, because a write that failed and was never retried is the
 *  user's edit living in memory until they quit. And a change that arrived
 *  while we were busy is read HERE rather than dropped, because this is the
 *  first moment when reading it cannot lose an edit of our own. */
function settle(projectPath: string): void {
  const state = writes.get(projectPath);
  if (state === undefined) return;

  if (isUnwritten(state) && state.timer === null && state.flight === null) {
    // Unwritten with nothing armed means the last attempt failed — a fresh edit
    // would have armed its own timer, which is why this cannot steal one.
    if (state.failures > 0 && state.failures <= PLAN_WRITE_RETRIES) {
      arm(projectPath, retryDelayMs(state.failures));
    }
  }

  if (!isQuiet(state)) return;

  // Only for a board there is still a MIRROR of.
  //
  // This used to ask `following` instead, which is a stricter question than it
  // looks and excluded the one case that most needed the re-read. `loadBoard`
  // returns early — before `following.add` — when it finds a pending write it
  // cannot flush, and it sets `rereadWhenQuiet` on the way out precisely so
  // this is the thing that finishes the job. Asking `following` there meant
  // asking a flag that had never been set: the owed read was dropped, the entry
  // deleted, and the board went on rendering (the mirror is kept on purpose)
  // with every drag, arrow and save refused until the user left and came back.
  //
  // The mirror is the right question because it is the same one `writeNow`
  // asks: no mirror means nothing to write from and nothing to correct, and
  // that is exactly when there is no read worth taking. A board that has been
  // unloaded still has one, so this can re-take a watch on a file nobody is
  // showing — the trade the old comment was avoiding — but that is a spare
  // watch until the next visit, where the wedge it prevents was a board the
  // user could look at and not use.
  const hasMirror =
    useRocPlanStore.getState().tasksByProject[projectPath] !== undefined;
  if (state.rereadWhenQuiet && hasMirror) {
    state.rereadWhenQuiet = false;
    void useRocPlanStore.getState().loadBoard(projectPath);
    return;
  }
  writes.delete(projectPath);
}

/** Write a project's unwritten change now instead of when the timer says so.
 *
 *  Also the retry: a failed write leaves the edit unwritten and the board's
 *  banner up, and this is what the banner's Try again, leaving the board and
 *  quitting all call to have another go. The backoff is reset first — a person
 *  pressing a button is new information about the world (they have fixed the
 *  permissions, remounted the volume), not the next step of a schedule.
 *
 *  Resolves when the attempt has settled, so a caller about to read the file
 *  can await it. */
export function flushPlanWrites(projectPath: string): Promise<void> {
  const state = writes.get(projectPath);
  if (state === undefined || !isUnwritten(state)) {
    return state?.flight ?? Promise.resolve();
  }
  state.failures = 0;
  return writeNow(projectPath);
}

function setError(projectPath: string, error: BoardError | null): void {
  useRocPlanStore.setState((s) => {
    s.errorByProject[projectPath] = error;
  });
}

// The change listener ------------------------------------------------------

/** One subscription for every watched project, taken the first time a board
 *  loads and kept for the life of the app.
 *
 *  Held as the promise so two boards loading in the same tick cannot each
 *  register one. `null` inside it means there is no IPC to listen to (unit
 *  tests, a plain browser dev server) — the board still works, it just will not
 *  hear about edits made outside it. */
let changeListener: Promise<UnlistenFn | null> | null = null;

function ensureChangeListener(): Promise<UnlistenFn | null> {
  changeListener ??= (async () => {
    try {
      return await listen<RocPlanChangedEvent>(
        EVENT_ROCPLAN_CHANGED,
        (event) => {
          const { projectPath } = event.payload;
          // Not ours to care about — another window's project, one this store
          // has never read, or one whose board has been put down since (the
          // watch is already handed back; this is the event that crossed it).
          if (!following.has(projectPath)) return;
          if (!useRocPlanStore.getState().tasksByProject[projectPath]) return;
          if (hasPendingPlanWrite(projectPath)) {
            // Our own write is about to land, or is landing. Re-reading now
            // would paint the file as it was and then be overwritten by the
            // very edit being read away.
            //
            // Remembered rather than dropped, which is the whole difference:
            // the version that returned here meant an agent's
            // `rocplan_update_task_status` arriving during the user's drag was
            // a change the board never learned about at ALL — no event, no
            // echo (Rust suppresses our own), nothing. `settle` reads it the
            // moment doing so cannot cost an edit of ours.
            stateFor(projectPath).rereadWhenQuiet = true;
            return;
          }
          void useRocPlanStore.getState().loadBoard(projectPath);
        },
      );
    } catch {
      return null;
    }
  })();
  return changeListener;
}

// Watch bookkeeping --------------------------------------------------------

/** Projects this renderer holds a watch on. Rust reference-counts, so the set
 *  is what keeps *this* side's calls balanced: `loadBoard` doubles as a
 *  refresh, and a refresh must not take a second reference it will never give
 *  back. */
const watched = new Set<string>();

/** Projects whose mirror is LIVE — read at least once and followed since.
 *
 *  Not the same question as "is there a mirror", which is what the mutations
 *  used to ask, because `unloadBoard` deliberately keeps the mirror so coming
 *  back to a board paints instead of flashing. A kept mirror is a snapshot of a
 *  file nobody has been watching since, and a whole-file write from one
 *  replaces every change made to the repository in the meantime — an agent's
 *  whole session of `rocplan_*` calls, a branch switch, a merge.
 *
 *  Separate from `watched` on purpose: a board whose `plan_watch` failed still
 *  works and is still being kept by the board on screen, and refusing its edits
 *  because a file watcher would not start would be a much worse answer than
 *  going stale. */
const following = new Set<string>();

/** Is this project's mirror LIVE — read at least once and followed since?
 *
 *  The question `mutate` asks before it accepts anything, exported because the
 *  BOARD has to be able to ask it too. Everywhere else a refusal has somewhere
 *  to be said (the card editor has its own banner, dispatch has toasts), but a
 *  drag has nothing: the card springs back to the column it came from and the
 *  only trace is a `console.warn` in a window the user does not have open.
 *
 *  Asked BEFORE a move rather than read off `moveTask`'s result on purpose —
 *  that returns false for a card dropped back where it started as well, and
 *  that one is a no-op rather than a failure. */
export const isBoardFollowed = (projectPath: string | null): boolean =>
  projectPath !== null && following.has(projectPath);

/** Make sure a project's board is loaded before mutating it — the entry point
 *  for anything that reaches these actions from OUTSIDE the board's own mount.
 *
 *  Phase 3B is the caller this exists for: dispatch appends findings and moves
 *  cards in response to a terminal, which happens while the user is looking at
 *  their panes and the board is not mounted at all. `await ensureBoardLoaded`
 *  first and the mutation lands on a mirror that agrees with the file; call the
 *  mutation on its own and it is refused with a warning, which is the loud
 *  version of "this would have overwritten somebody's work".
 *
 *  Resolves without reading when the board is already live, so it is cheap to
 *  put in front of every call rather than reasoning about which ones need it.
 *
 *  `refresh` is for the callers that cannot afford that shortcut, and there is
 *  exactly one class of them: a decision made from what the mirror says, about
 *  a card an AGENT has been holding. A live mirror is only as fresh as the last
 *  thing that told it something, and the `rocplan://changed` event that
 *  eventually will is a file watcher and a round trip behind the tool call that
 *  moved the card. Auto-advance reads the file again for that reason — see
 *  `advance` in `lib/rocplanDispatch` — because the alternative is dragging a
 *  card back out of Complete a millisecond after the agent put it there. */
export function ensureBoardLoaded(
  projectPath: string,
  options?: { refresh?: boolean },
): Promise<void> {
  if (!projectPath) return Promise.resolve();
  if (following.has(projectPath) && !options?.refresh) return Promise.resolve();
  return useRocPlanStore.getState().loadBoard(projectPath);
}

/** Out-of-board callers' outstanding interest in a project's board, by path.
 *
 *  `unloadOnRelease` is decided by the FIRST holder and is the only question
 *  that matters at release time: was this board somebody's before we asked for
 *  it? A board on screen owns its own watch and its own mirror, and handing
 *  those back underneath it would leave the user looking at a board that has
 *  stopped following the file. */
const holds = new Map<string, { count: number; unloadOnRelease: boolean }>();

/** What a hold hands back. `release` is idempotent. */
export interface BoardHold {
  release: () => void;
}

const NO_HOLD: BoardHold = { release: () => {} };

/** `ensureBoardLoaded`, but paired — for the callers that are only passing
 *  through.
 *
 *  Loading a board is not free and it is not local: it takes a file watch from
 *  Rust and it marks the mirror LIVE, which is the store's word for "safe to
 *  write the whole file from". Auto-advance loads boards nobody is looking at,
 *  a few seconds at a time, for as long as the app is running — and left
 *  unpaired that is one more watch per card and a permanently live mirror of a
 *  file nothing is following. (It also quietly disables the store's own
 *  refusal, which is the guard that stops a stale snapshot overwriting a
 *  repository.)
 *
 *  Reference-counted so two panes finishing at once cannot release each other's
 *  board mid-write. Release once the mutations are done — `unloadBoard` flushes
 *  what is pending, so nothing is lost by letting go promptly. */
export async function holdBoard(
  projectPath: string,
  options?: { refresh?: boolean },
): Promise<BoardHold> {
  if (!projectPath) return NO_HOLD;
  const existing = holds.get(projectPath);
  if (existing) existing.count += 1;
  else
    holds.set(projectPath, {
      count: 1,
      unloadOnRelease: !following.has(projectPath),
    });

  await ensureBoardLoaded(projectPath, options);

  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      const state = holds.get(projectPath);
      if (!state) return;
      state.count -= 1;
      if (state.count > 0) return;
      holds.delete(projectPath);
      if (state.unloadOnRelease) {
        useRocPlanStore.getState().unloadBoard(projectPath);
      }
    },
  };
}

export const useRocPlanStore = create<RocPlanState & RocPlanActions>()(
  devtools(
    immer((set, get) => ({
      ...initialState,

      loadBoard: async (projectPath) => {
        if (!projectPath) return;
        // A read REPLACES the mirror, so unwritten work has to reach the file
        // first or this is the edit's undo button. It is not a hypothetical:
        // the board's own Refresh and the write-failure banner's Try again both
        // land here, and Try again is pressed precisely when there are edits
        // the disk has not been told about.
        if (hasPendingPlanWrite(projectPath)) {
          await flushPlanWrites(projectPath);
          if (hasPendingPlanWrite(projectPath)) {
            // The write failed, or a fresh edit arrived while it was in the
            // air. Either way the mirror is the newer copy of the two, so the
            // read is owed rather than done — `settle` takes it once we are
            // quiet.
            stateFor(projectPath).rereadWhenQuiet = true;
            return;
          }
        }
        // Only the *first* read is a loading state. A re-read triggered by an
        // agent moving a card has a board to keep showing meanwhile.
        const first = get().tasksByProject[projectPath] === undefined;
        if (first) {
          set((s) => {
            s.loadingByProject[projectPath] = true;
          });
        }
        // Listening before reading, so an edit that lands between the read and
        // the subscription is not the one edit the board never hears about.
        await ensureChangeListener();

        try {
          const tasks = await commands.planRead(projectPath);
          // The same question again, for the width of the read itself: a card
          // dragged while the file was being read is newer than the answer that
          // just came back, and taking the answer would put it back where it
          // started — and then write that.
          if (hasPendingPlanWrite(projectPath)) {
            stateFor(projectPath).rereadWhenQuiet = true;
            set((s) => {
              s.loadingByProject[projectPath] = false;
            });
            return;
          }
          set((s) => {
            s.tasksByProject[projectPath] = tasks;
            s.loadingByProject[projectPath] = false;
            s.errorByProject[projectPath] = null;
          });
          // Live from here: the mirror agrees with the file as of now, which is
          // the whole of what a mutation needs to be safe.
          following.add(projectPath);
        } catch (err) {
          console.warn("[rocplan] read failed:", err);
          // Deliberately no empty mirror on failure: a board nobody could read
          // is not an empty board, and seeding one would let the next edit
          // write `[]` over a file that has tasks in it.
          set((s) => {
            s.loadingByProject[projectPath] = false;
            s.errorByProject[projectPath] = {
              kind: "read",
              message: message(err),
            };
          });
          return;
        }

        if (watched.has(projectPath)) return;
        watched.add(projectPath);
        try {
          await commands.planWatch(projectPath);
        } catch (err) {
          // A board that cannot follow the file still works; it just goes
          // stale when somebody else writes. Not worth an error banner.
          watched.delete(projectPath);
          console.warn("[rocplan] watch failed:", err);
        }
      },

      unloadBoard: (projectPath) => {
        if (!projectPath) return;
        // Not awaited: leaving the board is a render, and the write outlives
        // the component either way. A failure here still re-arms — see
        // `settle` — so the edit survives switching back to the terminals.
        void flushPlanWrites(projectPath);
        // The mirror stays (coming back should paint), but it stops being LIVE:
        // from here nothing is watching the file, so what is held is a snapshot
        // and a whole-file write from it would replace whatever happened to the
        // repository meanwhile. `mutate` refuses until somebody reads again.
        following.delete(projectPath);
        set((s) => {
          delete s.loadingByProject[projectPath];
        });
        if (!watched.delete(projectPath)) return;
        commands.planUnwatch(projectPath).catch(() => {
          /* no IPC, or the watch is already gone */
        });
      },

      createTask: (projectPath, draft) => {
        const now = Date.now();
        const task: RocTask = {
          id: newId(),
          title: draft.title,
          description: draft.description ?? "",
          status: "todo",
          priority: draft.priority ?? "medium",
          assignedTerminalName: draft.assignedTerminalName ?? null,
          findings: [],
          createdAt: now,
          updatedAt: now,
        };
        return mutate(projectPath, (tasks) => {
          tasks.push(task);
          return true;
        })
          ? task.id
          : "";
      },

      updateTask: (projectPath, taskId, patch) => {
        return mutate(projectPath, (tasks) => {
          const task = tasks.find((t) => t.id === taskId);
          if (!task) return false;
          if (patch.title !== undefined) task.title = patch.title;
          if (patch.description !== undefined)
            task.description = patch.description;
          if (patch.priority !== undefined) task.priority = patch.priority;
          if (patch.assignedTerminalName !== undefined)
            task.assignedTerminalName = patch.assignedTerminalName;
          task.updatedAt = Date.now();
          return true;
        });
      },

      moveTask: (projectPath, taskId, status) => {
        return mutate(projectPath, (tasks) => {
          const task = tasks.find((t) => t.id === taskId);
          // A card "moved" to the column it is already in is not a change, and
          // must not cost a write — arrow keys at the end of a row repeat it.
          if (!task || task.status === status) return false;
          task.status = status;
          task.updatedAt = Date.now();
          return true;
        });
      },

      appendFinding: (projectPath, taskId, by, text) => {
        return mutate(projectPath, (tasks) => {
          const task = tasks.find((t) => t.id === taskId);
          if (!task) return false;
          task.findings.push({ at: Date.now(), by, text });
          task.updatedAt = Date.now();
          return true;
        });
      },

      deleteTask: (projectPath, taskId) => {
        return mutate(projectPath, (tasks) => {
          const index = tasks.findIndex((t) => t.id === taskId);
          if (index === -1) return false;
          tasks.splice(index, 1);
          return true;
        });
      },
    })),
    { name: "rocplan" },
  ),
);

/** Apply `recipe` to a project's task list and write the result through.
 *
 *  Every mutation goes through here so two rules hold everywhere rather than in
 *  most places:
 *
 *  1. A project whose board is not LIVE takes no mutations. `plan_write`
 *     replaces the file whole, so a write can only be safe when the mirror it
 *     comes from agrees with the file — which is true of a board being followed
 *     and of nothing else. A project nobody has read holds nothing (the write
 *     would empty the file); a project whose board was unloaded holds a
 *     snapshot of a file nobody has watched since, and the write would replace
 *     every change the repository has taken meanwhile. The second one is the
 *     dangerous half, because it looks exactly like a working board: the mirror
 *     is kept on purpose so coming back paints instead of flashing.
 *
 *     `ensureBoardLoaded` is how a caller outside the board's mount gets in.
 *  2. A recipe that changed nothing schedules nothing. Otherwise the no-op
 *     paths (a card dropped back where it started, an edit that edits nothing)
 *     each cost a file write.
 *
 *  Returns whether the change landed. */
function mutate(
  projectPath: string,
  recipe: (tasks: RocTask[]) => boolean,
): boolean {
  const store = useRocPlanStore;
  if (!projectPath) return false;
  if (!following.has(projectPath)) {
    // Loud, because it is a caller's bug and a silent no-op would be a card
    // that quietly does not move. Not a throw: the alternative to a refused
    // dispatch must not be a broken render.
    console.warn(
      `[rocplan] refused a change to a board that is not loaded: ${projectPath}.` +
        " Await ensureBoardLoaded(projectPath) before mutating from outside the board.",
    );
    return false;
  }
  if (store.getState().tasksByProject[projectPath] === undefined) return false;
  let changed = false;
  store.setState((s) => {
    const tasks = s.tasksByProject[projectPath];
    if (!tasks) return;
    changed = recipe(tasks);
  });
  if (changed) scheduleWrite(projectPath);
  return changed;
}

// Selectors --------------------------------------------------------------

const EMPTY_TASKS: RocTask[] = [];

/** Every task on a project's board, in file order. */
export const useBoardTasks = (projectPath: string | null): RocTask[] =>
  useRocPlanStore((s) =>
    projectPath ? (s.tasksByProject[projectPath] ?? EMPTY_TASKS) : EMPTY_TASKS,
  );

/** One column's tasks.
 *
 *  Filtered outside the selector on purpose: zustand hands the selector's
 *  result straight to `useSyncExternalStore`, which compares by identity, and a
 *  `filter` inside would allocate a fresh array on every store write — an
 *  infinite render loop, not a slow one. */
export const useTasksByStatus = (
  projectPath: string | null,
  status: RocTaskStatus,
): RocTask[] => {
  const tasks = useBoardTasks(projectPath);
  return useMemo(
    () => tasks.filter((task) => task.status === status),
    [tasks, status],
  );
};

/** True only while the FIRST read of a board is in flight. */
export const useBoardLoading = (projectPath: string | null): boolean =>
  useRocPlanStore((s) =>
    projectPath ? (s.loadingByProject[projectPath] ?? false) : false,
  );

/** The last read or write failure for a board, or null. */
export const useBoardError = (projectPath: string | null): BoardError | null =>
  useRocPlanStore((s) =>
    projectPath ? (s.errorByProject[projectPath] ?? null) : null,
  );

/** Has this board been read at least once? The difference between "no tasks"
 *  and "we have not looked yet", which the empty state has to tell apart. */
export const useBoardLoaded = (projectPath: string | null): boolean =>
  useRocPlanStore((s) =>
    projectPath ? s.tasksByProject[projectPath] !== undefined : false,
  );

/** Test seam: drop every watch and timer this module is holding. The watch set
 *  and the debounce timers are module-global by design, and a suite that left
 *  one behind would change what the next one observes. */
export function resetRocPlanModuleState(): void {
  for (const state of writes.values()) {
    if (state.timer !== null) clearTimeout(state.timer);
  }
  writes.clear();
  watched.clear();
  following.clear();
  holds.clear();
  changeListener = null;
}
