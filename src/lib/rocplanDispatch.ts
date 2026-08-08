/** Dispatch: the half of RocPlan that reaches out of the board.
 *
 *  Dragging a card into In Progress is the whole point of the board — it means
 *  "somebody start this", and the somebody is a terminal pane. That is a
 *  side effect on a live process, so it deliberately does NOT live in the
 *  rocplan store: the store owns a file, is called from tests and from Rust
 *  events, and must stay a pure mirror. This module is the decorator the board
 *  calls instead of `moveTask`, and every route a card can move by goes through
 *  `BoardView.handleMove`, which calls it. Nothing bypasses dispatch by moving a
 *  card a different way.
 *
 *  Four questions, in order:
 *
 *  1. WHICH PANE. The card's `assignedTerminalName` if that session is still in
 *     the active workspace; the focused pane when the card names nobody or
 *     names somebody who has gone; the first pane in the dock's own order when
 *     nothing is focused. The chosen name is written back onto the card, so the
 *     board shows who owns it and the next dispatch goes to the same place. A
 *     pane whose agent has EXITED is not a candidate and not written into —
 *     Rust keeps its session, so the write would succeed into a dead pipe.
 *  2. WHEN. A pane that is `awaiting_approval` has a question on screen, and
 *     writing a prompt into it ANSWERS that question with the prompt — so the
 *     dispatch waits for the state to clear. Claude panes say so through their
 *     hooks; everything else gets the silence heuristic, one second of no
 *     output, which is the same guess `ptyBridge` makes for those agents.
 *  3. WHAT. The prompt format is contractual (see the phase-3 plan): a title
 *     line, the description, and the sentence that tells the agent the card
 *     exists and how to move it with its own MCP tools.
 *  4. WHAT NEXT. The pane is remembered against the card, and its next
 *     end-of-turn moves the card to In Review — see `mountRocPlanDispatch`.
 *
 *  Every one of those can fail in a way the user has to be told about, and none
 *  of them may stop the card from moving: the move is what the user asked for,
 *  the dispatch is what the app does about it. Failures are toasts, never
 *  refusals. */

import { type RocTask, type RocTaskStatus } from "@/lib/bindings";
import type { TerminalSession } from "@/lib/bindings";
import {
  hasExited,
  pasteSafeLine,
  sanitizeForPty,
  sendToTerminal,
  waitUntilReady,
  type Readiness,
} from "@/lib/agentDispatch";
import { leafIds } from "@/lib/paneTree";
import { useNotificationsStore } from "@/stores/notifications";
import { holdBoard, useRocPlanStore } from "@/stores/rocplan";
import { useTerminalsStore } from "@/stores/terminals";
import { useToastsStore } from "@/stores/toasts";
import { useUIStore } from "@/stores/ui";
import { useWorkspacesStore } from "@/stores/workspaces";

/** The readiness and sanitizing constants live with the primitives now, and are
 *  re-exported because this module's own callers (and its tests) have always
 *  asked it for them. */
export {
  DISPATCH_APPROVAL_WAIT_MS,
  DISPATCH_QUIET_MAX_WAIT_MS,
  DISPATCH_QUIET_MS,
} from "@/lib/agentDispatch";

/** `by` on the finding a dispatch leaves. Not an agent name and not "you": the
 *  app did this, on the user's behalf, and the log should say which. */
export const DISPATCH_FINDING_AUTHOR = "rocspace";

// The prompt -------------------------------------------------------------

/** The contract's prompt, verbatim.
 *
 *  Three lines, and the third one is load-bearing: it is how the agent learns
 *  that the work it was just handed is a CARD, which id it has, and that it can
 *  file the card itself through the `rocplan_*` MCP tools. An agent that moves
 *  its own card is the workflow this phase exists for; auto-advance is the
 *  safety net for the ones that do not.
 *
 *  A card with no description contributes no line rather than a blank one — a
 *  prompt that opens with an empty line reads like a mistake.
 *
 *  Every field interpolated here is SANITIZED first, and that is not defensive
 *  programming for its own sake: `plan.json` lives in the user's repository, so
 *  its text arrives with a clone, a branch or a merge, and it is about to be
 *  written into a terminal inside a bracketed paste. A title holding
 *  `ESC[201~` followed by a carriage return closes the paste and submits
 *  whatever comes next as real typing — a card that runs a command. The
 *  sanitizers make the card's text text. */
export function buildDispatchPrompt(task: RocTask): string {
  const title = pasteSafeLine(task.title);
  const id = pasteSafeLine(task.id);
  const description = sanitizeForPty(task.description).trim();
  return [
    `✻ Picked up from RocPlan: "${title}"`,
    description,
    `When done, summarize what changed. This task is tracked in RocPlan` +
      ` (.rocspace/plan.json) as ${id} — move it with` +
      ` rocplan_update_task_status when you finish.`,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

// Bookkeeping -------------------------------------------------------------

/** What a dispatched pane is working on, keyed by terminal id.
 *
 *  A LIST per pane, not one card. A pane runs one turn at a time, but nothing
 *  stops the user dropping a second card on a pane that is already working —
 *  the CLI queues what is typed — and the version of this that held one record
 *  per terminal answered that by overwriting: the first card sat in In Progress
 *  for ever with nothing watching it, silently. The rule the list encodes is
 *  FIFO, one card per turn: prompts are read in the order they were pasted, so
 *  each end-of-turn files the oldest card still outstanding. A pane whose
 *  PROCESS ends is the exception — see `mountRocPlanDispatch`.
 *
 *  An entry is a promise to look at that card again, and it is dropped the
 *  moment that promise stops being true (the turn ended, the card left In
 *  Progress, the pane was closed).
 *
 *  Module-level, like the rocplan store's write bookkeeping and for the same
 *  reason: nobody renders it, and it has to outlive every component that could
 *  have started it. */
interface DispatchRecord {
  projectPath: string;
  taskId: string;
  /** The pane's name AS DISPATCHED. A rename between the prompt and the end of
   *  the turn should not make the finding credit somebody else. */
  terminalName: string;
  /** Has this pane STARTED a turn since the prompt was written into it?
   *
   *  The load-bearing half of "the turn ended". A card dropped on a pane that
   *  is already running queues behind whatever the user asked for first, and
   *  that turn's end is not this card's — without this flag the card was filed
   *  into In Review before the agent had read a word of it. Only a transition
   *  INTO running, observed after the write, arms a record. */
  armed: boolean;
}

const dispatches = new Map<string, DispatchRecord[]>();

/** Which card a pane was dispatched, or null. The OLDEST one still outstanding
 *  — the one its next end-of-turn will file. */
export function dispatchedCardFor(
  terminalId: string,
): { projectPath: string; taskId: string } | null {
  const record = dispatches.get(terminalId)?.[0];
  return record
    ? { projectPath: record.projectPath, taskId: record.taskId }
    : null;
}

/** Watch for this pane's next end-of-turn on this card's behalf. */
function rememberDispatch(terminalId: string, record: DispatchRecord): void {
  const records = dispatches.get(terminalId);
  if (records) records.push(record);
  else dispatches.set(terminalId, [record]);
}

/** Drop a pane's list once nothing is waiting on it, so the subscription's
 *  `size === 0` fast path keeps working. */
function pruneDispatches(terminalId: string, records: DispatchRecord[]): void {
  if (records.length === 0) dispatches.delete(terminalId);
}

/** Stop watching for a card's end-of-turn — it is not in In Progress any more,
 *  so there is nothing left to advance it to. Cancels a dispatch still waiting
 *  for the pane, too: a card pulled back out is not owed a prompt. */
function forgetCard(projectPath: string, taskId: string): void {
  cancelDispatch(projectPath, taskId);
  for (const [terminalId, records] of dispatches) {
    const kept = records.filter(
      (r) => r.projectPath !== projectPath || r.taskId !== taskId,
    );
    if (kept.length === records.length) continue;
    dispatches.set(terminalId, kept);
    pruneDispatches(terminalId, kept);
  }
}

// One dispatch at a time, per card ----------------------------------------

/** A dispatch that has not finished deciding yet.
 *
 *  Between the move and the prompt there can be a five-minute wait on a pane
 *  that is asking the user something, and in that time the card can be dragged
 *  out and dropped back in — which used to START A SECOND WAIT. Both then woke
 *  on the same pane and pasted the same prompt twice, and the card collected
 *  two findings for one piece of work. N re-drags, N prompts.
 *
 *  So a card has at most one dispatch in flight: beginning one cancels
 *  whatever was already waiting for that card, and every await in `dispatchTask`
 *  is followed by a look at `cancelled`. The waits themselves take the token
 *  and give up on it, rather than holding a store subscription until a timeout
 *  nobody is waiting for. */
interface DispatchAttempt {
  cancelled: boolean;
  /** What to tear down when this attempt is cancelled — the waiters' own
   *  unsubscribe, registered while they are parked. */
  onCancel: Set<() => void>;
}

const inFlight = new Map<string, DispatchAttempt>();

const cardKey = (projectPath: string, taskId: string): string =>
  `${projectPath}\u0000${taskId}`;

function beginDispatch(projectPath: string, taskId: string): DispatchAttempt {
  // Everything the last dispatch of this card left behind goes: the wait it is
  // parked in, and the end-of-turn it asked some pane to watch for. A fresh
  // dispatch is the whole answer about this card.
  forgetCard(projectPath, taskId);
  const attempt: DispatchAttempt = { cancelled: false, onCancel: new Set() };
  inFlight.set(cardKey(projectPath, taskId), attempt);
  return attempt;
}

function cancelDispatch(projectPath: string, taskId: string): void {
  const key = cardKey(projectPath, taskId);
  const attempt = inFlight.get(key);
  if (!attempt) return;
  inFlight.delete(key);
  attempt.cancelled = true;
  for (const undo of attempt.onCancel) undo();
  attempt.onCancel.clear();
}

/** This attempt is done deciding — but only clear the slot if it is still the
 *  one holding it, or a newer dispatch's token would be dropped. */
function endDispatch(
  projectPath: string,
  taskId: string,
  attempt: DispatchAttempt,
): void {
  const key = cardKey(projectPath, taskId);
  if (inFlight.get(key) === attempt) inFlight.delete(key);
}

// Choosing a pane ---------------------------------------------------------

/** The active workspace's sessions, in the dock's own order.
 *
 *  Deliberately the same ordering rule as `useActiveWorkspaceTerminals`: "the
 *  first pane" has to mean the pane at the top left of the dock, not whichever
 *  session happens to be first in an id-keyed map. Sessions the tree has not
 *  heard of yet sort last, by age. */
function workspacePanes(): TerminalSession[] {
  const { activeWorkspaceId, workspaces } = useWorkspacesStore.getState();
  if (!activeWorkspaceId) return [];
  const workspace = workspaces.find((w) => w.id === activeWorkspaceId);
  if (!workspace) return [];
  const panes = Object.values(useTerminalsStore.getState().byId).filter(
    (t) => t.workspaceId === activeWorkspaceId,
  );
  const order = new Map(
    (workspace.paneTree ? leafIds(workspace.paneTree) : []).map((id, i) => [
      id,
      i,
    ]),
  );
  const rank = (t: TerminalSession) =>
    order.get(t.id) ?? Number.MAX_SAFE_INTEGER;
  panes.sort((a, b) => rank(a) - rank(b) || a.createdAt - b.createdAt);
  return panes;
}

/** The focused pane, but only if it is one of this workspace's.
 *
 *  `focusedTerminalId` is app-wide and outlives a workspace switch, so it can
 *  point at a pane in a dock nobody is looking at — dispatching there would put
 *  the prompt somewhere the user cannot see it. */
function focusedPane(panes: TerminalSession[]): TerminalSession | null {
  const focusedId = useUIStore.getState().focusedTerminalId;
  return panes.find((p) => p.id === focusedId) ?? null;
}

interface Target {
  terminal: TerminalSession;
  /** The name the card asked for, when that pane could not be found. Null when
   *  the card got what it named (or named nobody). */
  missing: string | null;
}

function resolveTarget(task: RocTask): Target | null {
  const panes = workspacePanes();
  if (panes.length === 0) return null;
  // The fallback is chosen among the panes that still have a process. A card
  // that names nobody is asking for "somebody who can start this", and a pane
  // whose agent has quit is not one — but a pane the card NAMES is still that
  // pane, and is refused out loud rather than quietly re-aimed.
  const alive = panes.filter((p) => !hasExited(p));
  const fallback = focusedPane(alive) ?? alive[0] ?? panes[0]!;
  if (!task.assignedTerminalName) return { terminal: fallback, missing: null };
  const named = panes.find((p) => p.name === task.assignedTerminalName);
  return named
    ? { terminal: named, missing: null }
    : { terminal: fallback, missing: task.assignedTerminalName };
}

// Waiting for a pane to be ready ------------------------------------------

/** Resolve when the pane is safe to write into; false if it never becomes so.
 *
 *  A thin adapter over `agentDispatch.waitUntilReady`, which is where the two
 *  readiness rules (a claude pane's hook state; a second of silence for
 *  everything else) now live. What this adds is the CARD's cancellation: a
 *  wait that is superseded — the card was dragged back out, or re-dropped —
 *  must let go of its store subscription rather than parking on it for five
 *  minutes, and `DispatchAttempt` is how that news travels here.
 *
 *  `dead` reads as not-ready like `timeout` does, and the difference is made
 *  out loud by the caller: it re-reads the pane after the wait and has a
 *  sentence for a session that has gone and another for one that never
 *  answered. */
function waitForReady(
  terminalId: string,
  attempt: DispatchAttempt,
): Promise<Readiness> {
  if (attempt.cancelled) return Promise.resolve("timeout");
  const controller = new AbortController();
  const giveUp = () => controller.abort();
  attempt.onCancel.add(giveUp);
  return waitUntilReady(terminalId, { signal: controller.signal }).finally(() =>
    attempt.onCancel.delete(giveUp),
  );
}

// Dispatch ----------------------------------------------------------------

/** Move a card, and — when the column it lands in is In Progress — hand it to
 *  an agent.
 *
 *  The move happens SYNCHRONOUSLY, before anything is awaited: the board is a
 *  drag away from this call, and a card that lags a frame behind the pointer
 *  because a terminal is being resolved would be a worse board. The returned
 *  promise settles when the dispatch has finished or given up; the board
 *  ignores it, tests await it. */
export function dispatchOnMove(
  projectPath: string,
  taskId: string,
  status: RocTaskStatus,
): Promise<void> {
  const moved = useRocPlanStore
    .getState()
    .moveTask(projectPath, taskId, status);
  if (!moved) return Promise.resolve();

  if (status !== "in_progress") {
    // Whatever was going to happen at the end of that pane's turn is no longer
    // about this card — the user has filed it somewhere else by hand.
    forgetCard(projectPath, taskId);
    return Promise.resolve();
  }

  const task = cardIn(projectPath, taskId);
  if (!task) return Promise.resolve();
  // One dispatch per card at a time: this cancels whatever the card's last one
  // was still waiting for, so re-dropping a card cannot stack two prompts.
  const attempt = beginDispatch(projectPath, taskId);
  return dispatchTask(projectPath, task, attempt).finally(() =>
    endDispatch(projectPath, taskId, attempt),
  );
}

const cardIn = (projectPath: string, taskId: string): RocTask | undefined =>
  useRocPlanStore
    .getState()
    .tasksByProject[projectPath]?.find((t) => t.id === taskId);

async function dispatchTask(
  projectPath: string,
  task: RocTask,
  attempt: DispatchAttempt,
): Promise<void> {
  const target = resolveTarget(task);
  if (!target) {
    toast({
      message: `No agent pane in this workspace to pick up “${task.title}”`,
      tone: "warn",
    });
    return;
  }
  const { terminal, missing } = target;
  if (missing) {
    toast({
      message: `${missing} is not in this workspace any more — “${task.title}” went to ${terminal.name}`,
      tone: "warn",
    });
  }
  if (hasExited(terminal)) {
    // Nothing is listening, and nothing would tell us: the write succeeds into
    // a dead descriptor. Saying it here is the difference between a card the
    // user knows nobody picked up and a card they think is being worked on.
    toast({
      message: `${terminal.name}'s agent has exited — restart it first`,
      tone: "warn",
    });
    return;
  }
  // Write the choice back so the board says who owns the card, and so the next
  // dispatch goes to the same pane rather than re-deciding.
  if (task.assignedTerminalName !== terminal.name) {
    const held = await holdBoard(projectPath);
    if (!attempt.cancelled) {
      useRocPlanStore.getState().updateTask(projectPath, task.id, {
        assignedTerminalName: terminal.name,
      });
    }
    held.release();
    if (attempt.cancelled) return;
  }

  const readiness = await waitForReady(terminal.id, attempt);
  if (attempt.cancelled) return;
  if (readiness === "timeout") {
    // The pane never stopped asking the user something. Worth saying — the
    // card is sitting in In Progress with nobody on it, and only the user can
    // do anything about the question on screen. (A dispatch that was superseded
    // is NOT worth saying, and cannot get here: the card has moved on.)
    if (useTerminalsStore.getState().byId[terminal.id]) {
      toast({
        message: `${terminal.name} is still waiting on you — “${task.title}” was not sent`,
        tone: "warn",
      });
    }
    return;
  }
  // `dead` falls through to the liveness re-check below, which already has the
  // right sentence for a pane that has gone or whose agent has quit.

  // Both of these can have changed across the wait: the pane can be closed, and
  // the card can be dragged back out of In Progress by the user or filed by the
  // agent through MCP. Writing the prompt then would be a prompt for work
  // nobody is expecting.
  const live = useTerminalsStore.getState().byId[terminal.id];
  if (!live) return;
  if (hasExited(live)) {
    toast({
      message: `${terminal.name}'s agent has exited — restart it first`,
      tone: "warn",
    });
    return;
  }
  const current = cardIn(projectPath, task.id);
  if (!current || current.status !== "in_progress") return;

  try {
    // Sanitized, framed as one bracketed paste, submitted, and the pane marked
    // as having been typed into — all four are `sendToTerminal`'s job now.
    await sendToTerminal(terminal.id, buildDispatchPrompt(current));
  } catch (err) {
    console.warn("[rocplan] dispatch write failed:", err);
    toast({
      message: `Could not send “${task.title}” to ${terminal.name}`,
      tone: "warn",
    });
    return;
  }

  // From here the pane's next end-of-turn is this card's business — recorded
  // before anything else is awaited, because what arms it is the pane going
  // `running`, and a hook can fire while the finding below is being written.
  rememberDispatch(terminal.id, {
    projectPath,
    taskId: task.id,
    terminalName: terminal.name,
    armed: false,
  });

  const held = await holdBoard(projectPath);
  useRocPlanStore
    .getState()
    .appendFinding(
      projectPath,
      task.id,
      DISPATCH_FINDING_AUTHOR,
      `Dispatched to ${terminal.name}`,
    );
  held.release();

  toast({
    message: `${terminal.name} picked up “${task.title}”`,
    // Only from the board: offering to show the terminals to somebody already
    // looking at them is an offer to do nothing.
    action: onBoard()
      ? {
          label: "Watch it work",
          // By NAME, resolved when it is clicked. A toast is six seconds old by
          // then and the pane may have been closed, or the user may be in
          // another workspace — and focusing an id from another dock points the
          // one on screen at nothing while claiming to have jumped. `jumpToAgent`
          // looks in the workspace the user is in NOW, and says so when the pane
          // is not there.
          run: () => void jumpToAgent(terminal.name),
        }
      : null,
  });
}

// Board ⇄ terminals --------------------------------------------------------

const onBoard = (): boolean => useUIStore.getState().mainView === "rocplan";

/** Put the panes on screen and point the user at one. */
function showPane(terminalId: string): void {
  const ui = useUIStore.getState();
  ui.setMainView("terminals");
  ui.focusTerminal(terminalId);
  // The dock can hold sixteen panes; "focused" is a thin ring on one of them.
  // The highlight is what makes the jump land somewhere visible.
  ui.setHighlight(terminalId);
}

/** Jump to the pane a card is assigned to — the agent chip's click.
 *
 *  Returns whether there was one. A name on a card outlives the session it
 *  names: the card is in the repository and travels with the branch, while the
 *  pane is a process somebody closed. So "no such pane here" is an ordinary
 *  answer, and it is said out loud rather than swallowed into a click that
 *  looks broken. */
export function jumpToAgent(terminalName: string): boolean {
  const pane = workspacePanes().find((p) => p.name === terminalName);
  if (!pane) {
    toast({
      message: `${terminalName} is not open in this workspace`,
      tone: "warn",
    });
    return false;
  }
  showPane(pane.id);
  return true;
}

function toast(draft: {
  message: string;
  tone?: "info" | "warn";
  action?: { label: string; run: () => void } | null;
}): void {
  useToastsStore.getState().push(draft);
}

// Auto-advance ------------------------------------------------------------

/** Watch dispatched panes and move their cards to In Review when a turn ends.
 *
 *  Mount once, beside the other bridges in `App`. One subscription for every
 *  dispatch rather than one per card: the terminals store is written on every
 *  frame that carries output, so being expensive here is being expensive sixty
 *  times a second — hence the empty-map early return before anything else.
 *
 *  "The turn ended" is `running → idle` (a claude Stop hook, or the silence
 *  heuristic settling) on a pane that has STARTED a turn since the prompt was
 *  written into it. The arming is the whole difference between the end of this
 *  card's turn and the end of somebody else's: a card dropped on a busy pane
 *  queues behind the turn already running, and filing it when THAT one ends
 *  credits the agent with work it has not read yet.
 *
 *  A pane whose process ends (`complete`, `error`) is the other way a dispatch
 *  resolves, and it resolves ALL of them, armed or not: nothing is ever going
 *  to end a turn on a dead pane, so a card left behind here is left behind for
 *  good.
 *
 *  Closures are handled here too, and that is not incidental: a closed pane is
 *  the one event that can never resolve a dispatch, and nothing else would ever
 *  drop its entry. */
export function mountRocPlanDispatch(): () => void {
  return useTerminalsStore.subscribe((state, prev) => {
    if (dispatches.size === 0) return;
    for (const [terminalId, records] of [...dispatches]) {
      const terminal = state.byId[terminalId];
      if (!terminal) {
        dispatches.delete(terminalId);
        continue;
      }
      const before = prev.byId[terminalId]?.status;
      const after = terminal.status;
      if (before === undefined || before === after) continue;

      // The pane has started work. Every prompt already sitting in its queue is
      // now waiting on a turn that began after it was written.
      if (after === "running") {
        for (const record of records) record.armed = true;
        continue;
      }

      const exited = after === "complete" || after === "error";
      const endedTurn = before === "running" && after === "idle";
      if (!exited && !endedTurn) continue;

      // Taken out of the map BEFORE the async work: `idle → complete` is an
      // ordinary pair, and the same card must not be advanced twice by one
      // turn.
      const resolved = exited ? records.splice(0) : takeOldestArmed(records);
      pruneDispatches(terminalId, records);
      for (const record of resolved) void advance(terminalId, record, exited);
    }
  });
}

/** The one card this turn answers: the oldest still waiting on a turn that
 *  started after its prompt. Removed from the list. */
function takeOldestArmed(records: DispatchRecord[]): DispatchRecord[] {
  const index = records.findIndex((r) => r.armed);
  return index === -1 ? [] : records.splice(index, 1);
}

async function advance(
  terminalId: string,
  record: DispatchRecord,
  /** The pane's process ended, rather than its turn — so the finding says so.
   *  A card filed because the agent was killed is not a finished turn, and the
   *  reviewer reading the card is the one who has to know the difference. */
  exited = false,
): Promise<void> {
  const { projectPath, taskId, terminalName } = record;
  // The user is almost certainly looking at their panes rather than the board,
  // which means nothing is following this project's file. Mutating from here
  // without loading first is refused by the store — rightly: the mirror would
  // be a snapshot of a file an agent has been writing to since.
  //
  // `refresh` because a followed board is not enough here. The agent whose turn
  // just ended has the `rocplan_*` tools, and the call it makes with them —
  // `rocplan_update_task_status(complete)` — lands in the FILE milliseconds
  // before the Stop hook that brought us here. The mirror learns about it from
  // a file watcher, one debounce and one round trip later. Deciding from the
  // mirror in that window means reading in_progress, moving the card to In
  // Review, and writing the whole file back over the agent's own answer.
  //
  // HELD, and handed back below: a board loaded from here is one this app took
  // a file watch on and marked live, for a project the user is not looking at.
  // Unpaired, an app left running all afternoon collects one watch per card and
  // a mirror that claims to agree with a file nothing is watching.
  const held = await holdBoard(projectPath, { refresh: true });
  try {
    const task = cardIn(projectPath, taskId);
    if (!task) return;
    // Agents have the `rocplan_*` tools and are told to use them, so the card
    // may already be where the agent put it. Moving it again would drag it back
    // out of Complete and undo the agent's own answer.
    if (task.status !== "in_progress") return;

    if (
      !useRocPlanStore.getState().moveTask(projectPath, taskId, "in_review")
    ) {
      return;
    }
    useRocPlanStore
      .getState()
      .appendFinding(
        projectPath,
        taskId,
        terminalName,
        exited
          ? "Agent exited — awaiting review"
          : "Turn finished — awaiting review",
      );
  } finally {
    // After the mutations, and before the bell: `unloadBoard` flushes what is
    // pending, so letting go promptly costs nothing and keeps the window in
    // which this board is live as short as the work that needed it.
    held.release();
  }

  // Through the bell rather than a toast, and only for a card this actually
  // moved: what is waiting is a person's attention, and that is still true in
  // ten minutes — which is longer than any toast lives.
  useNotificationsStore.getState().push({
    terminalId,
    terminalName,
    agentType:
      useTerminalsStore.getState().byId[terminalId]?.agentConfig.type ??
      "custom",
    kind: "review",
  });
}

/** Test seam: forget every dispatch, and every wait one is parked in. Both are
 *  module-global by design — a suite that left one behind would advance the
 *  next suite's card, or paste its prompt. */
export function resetRocPlanDispatchState(): void {
  dispatches.clear();
  for (const [key, attempt] of [...inFlight]) {
    inFlight.delete(key);
    attempt.cancelled = true;
    for (const undo of attempt.onCancel) undo();
    attempt.onCancel.clear();
  }
}
