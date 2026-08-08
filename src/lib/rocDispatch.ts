/** One message, many agents — the thing Roc exists to do.
 *
 *  RocPlan's dispatch answers "which pane picks this card up". This one is the
 *  opposite question: the panes are already chosen (by @name, by the rail's
 *  checkboxes, by broadcast — see `lib/rocTargets`), and the work is getting one
 *  sentence into all of them without the slowest one holding up the rest.
 *
 *  ── In parallel, but one at a time per pane ──────────────────────────────
 *
 *  Those are not in tension, they are the whole design. ACROSS panes everything
 *  happens at once: three agents each needing a quiet second must all have the
 *  message a second from now, not three seconds from now, or "talk to your
 *  team" becomes "talk to your team in turn". WITHIN a pane it is strictly FIFO,
 *  because a pane is one process reading one stream: two messages racing to be
 *  written into the same PTY interleave into nonsense, and the second one
 *  arriving first is a plain lie about what the user typed. So each pane has a
 *  chain, and a new message for a busy pane joins the back of it.
 *
 *  ── Being told what is happening ─────────────────────────────────────────
 *
 *  A fan-out is mostly waiting, and a wait nobody can see is indistinguishable
 *  from nothing happening. Three things say otherwise: the rail row's badge
 *  (`useRocTargetState` — queued while a pane is busy, then sent / skipped /
 *  failed), Roc's phase (`dispatching` until the last pane answers, so the orb
 *  is live), and the log, which is written IMMEDIATELY rather than when the
 *  slowest pane finally takes the message. The log's job is "I sent that", and
 *  ten seconds late it would be answering a question the user stopped asking.
 *
 *  ── Refusals are loud ────────────────────────────────────────────────────
 *
 *  A pane whose agent has exited is skipped, not written into: Rust keeps an
 *  exited session in its map, so the write succeeds into a dead descriptor and
 *  nothing says a word. Silently sending to four of the five agents you
 *  addressed is the failure this module exists to prevent, so every skip is a
 *  toast that NAMES the panes — one toast for the whole fan-out, because five
 *  dead panes should not be five notifications.
 *
 *  The panes that miss the message LATE are bundled the same way (see
 *  `reportLate`). They are the ones a broadcast produces in bulk: five agents
 *  all sitting on a permission prompt reach the five-minute budget together, and
 *  five notifications saying the same sentence about five names is a wall the
 *  user dismisses without reading — which is how the one name that mattered goes
 *  unread.
 *
 *  Everything about writing to a PTY — sanitizing, framing, readiness — is
 *  `lib/agentDispatch`, shared with RocPlan. This module is only the fan-out. */

import { create } from "zustand";
import { devtools } from "zustand/middleware";
import { ulid } from "ulid";
import { hasExited, sendToTerminal, waitUntilReady } from "@/lib/agentDispatch";
import { reresolveTargets, type AimedRocCommand } from "@/lib/rocTargets";
import {
  useRocStore,
  type RocDispatchRecord,
  type RocPhase,
  type RocTarget,
} from "@/stores/roc";
import { useTerminalsStore } from "@/stores/terminals";
import { useToastsStore } from "@/stores/toasts";

/** What the rail draws on a row about the LAST dispatch that touched it.
 *
 *  "idle" is the absence of an entry rather than a value: most rows, most of
 *  the time, have nothing to say, and a map with an entry per session would be
 *  a map that has to be pruned on every close.
 *
 *  `failed` is not in the plan's four and is here on purpose: a write that
 *  threw, and a pane that never stopped asking the user something, are neither
 *  "sent" nor a skip the app chose — calling them either would be the app
 *  telling itself a story. The toast beside them says which. */
export type RocTargetState = "queued" | "sent" | "skipped" | "failed";

interface RocDispatchState {
  /** What the last job to FINISH did about each pane. */
  outcome: Record<string, RocTargetState>;
  /** How many messages are still outstanding for each pane — parked in a wait,
   *  or in the middle of being written. */
  outstanding: Record<string, number>;
}

export const useRocDispatchStore = create<RocDispatchState>()(
  devtools(() => ({ outcome: {}, outstanding: {} }), { name: "rocDispatch" }),
);

/** What the rail should draw on this row, or undefined for nothing.
 *
 *  DERIVED from the pane's queue rather than from whichever job last wrote a
 *  mark, and that is the fix: while a pane has anything outstanding the answer
 *  is "queued", whatever the message before it finished as. The badge used to
 *  be simply the last thing written, so a pane that took one message while
 *  another was still behind it wore "Sent" — and the queued badge IS the cancel
 *  button, so the only message the user could still call off was the one with
 *  nothing to press. */
const targetStateOf = (
  s: RocDispatchState,
  terminalId: string,
): RocTargetState | undefined =>
  (s.outstanding[terminalId] ?? 0) > 0 ? "queued" : s.outcome[terminalId];

export const useRocTargetState = (
  terminalId: string,
): RocTargetState | undefined =>
  useRocDispatchStore((s) => targetStateOf(s, terminalId));

/** The same answer, for callers that are not components. */
export const getRocTargetState = (
  terminalId: string,
): RocTargetState | undefined =>
  targetStateOf(useRocDispatchStore.getState(), terminalId);

/** Remember how a job ENDED. Says nothing about what is still queued behind
 *  it — that is `outstanding`'s job, and the badge asks it first. */
function mark(terminalId: string, state: RocTargetState): void {
  useRocDispatchStore.setState((s) =>
    s.outcome[terminalId] === state
      ? s
      : { outcome: { ...s.outcome, [terminalId]: state } },
  );
}

function clearMark(terminalId: string): void {
  useRocDispatchStore.setState((s) => {
    if (!(terminalId in s.outcome)) return s;
    const outcome = { ...s.outcome };
    delete outcome[terminalId];
    return { outcome };
  });
}

/** One more message on its way to this pane. */
function beginJob(terminalId: string): void {
  useRocDispatchStore.setState((s) => ({
    outstanding: {
      ...s.outstanding,
      [terminalId]: (s.outstanding[terminalId] ?? 0) + 1,
    },
  }));
}

function endJob(terminalId: string): void {
  useRocDispatchStore.setState((s) => {
    const left = (s.outstanding[terminalId] ?? 0) - 1;
    if (left > 0) {
      return { outstanding: { ...s.outstanding, [terminalId]: left } };
    }
    if (!(terminalId in s.outstanding)) return s;
    const outstanding = { ...s.outstanding };
    delete outstanding[terminalId];
    return { outstanding };
  });
}

/** Everything queued for this pane is off — see `cancelRocDispatch`. The jobs
 *  themselves still resolve and still call `endJob`, which is why that one
 *  tolerates a count that is already gone. */
function clearOutstanding(terminalId: string): void {
  useRocDispatchStore.setState((s) => {
    if (!(terminalId in s.outstanding)) return s;
    const outstanding = { ...s.outstanding };
    delete outstanding[terminalId];
    return { outstanding };
  });
}

/** Wipe what the LAST dispatch finished as, and only that.
 *
 *  The rail shows the current dispatch, so a tick left over from the one before
 *  would claim a pane had just been sent something it had not. What is still
 *  outstanding is untouched, and does not need touching: those rows draw their
 *  badge from the queue, which is still true. */
function clearFinishedMarks(): void {
  useRocDispatchStore.setState({ outcome: {} });
}

/** Forget a pane the moment it stops existing.
 *
 *  Same reasoning as the roc store's selection pruning, and the same care about
 *  the hot path: the terminals store is rewritten on every frame that carries
 *  PTY output, so this returns on its first line for every user who has not
 *  dispatched anything. */
useTerminalsStore.subscribe((s, prev) => {
  if (s.byId === prev.byId) return;
  const { outcome, outstanding } = useRocDispatchStore.getState();
  const ids = [
    ...new Set([...Object.keys(outcome), ...Object.keys(outstanding)]),
  ];
  if (ids.length === 0) return;
  const gone = ids.filter((id) => s.byId[id] === undefined);
  if (gone.length === 0) return;
  useRocDispatchStore.setState({
    outcome: without(outcome, gone),
    outstanding: without(outstanding, gone),
  });
});

const without = <T>(
  map: Readonly<Record<string, T>>,
  keys: readonly string[],
): Record<string, T> => {
  const next = { ...map };
  for (const key of keys) delete next[key];
  return next;
};

// The queues ----------------------------------------------------------------

/** The tail of each pane's chain — what a new message for it waits behind. */
const queues = new Map<string, Promise<unknown>>();

/** The controllers of everything still outstanding for a pane, so a cancel can
 *  reach the one that is parked in a wait AND the ones behind it. */
const pending = new Map<string, Set<AbortController>>();

type JobResult = "sent" | "skipped" | "failed" | "cancelled";

function enqueue(target: RocTarget, text: string): Promise<JobResult> {
  const id = target.terminalId;
  const controller = new AbortController();
  const inFlight = pending.get(id);
  if (inFlight) inFlight.add(controller);
  else pending.set(id, new Set([controller]));
  // On its way, which is all the rail's badge asks about: from here until this
  // job is done the row says "queued" and offers the cancel, whatever the
  // message before it finished as.
  beginJob(id);

  const tail = queues.get(id) ?? Promise.resolve();
  const run = tail.then(() => runOne(target, text, controller));
  queues.set(
    id,
    run.then(
      () => {},
      () => {},
    ),
  );
  void run.finally(() => {
    endJob(id);
    const set = pending.get(id);
    if (!set) return;
    set.delete(controller);
    if (set.size > 0) return;
    pending.delete(id);
    queues.delete(id);
  });
  return run;
}

async function runOne(
  target: RocTarget,
  text: string,
  controller: AbortController,
): Promise<JobResult> {
  const id = target.terminalId;
  // Cancelled while it sat in the queue. Nothing was written, and the mark was
  // taken down by whoever cancelled.
  if (controller.signal.aborted) return "cancelled";

  const readiness = await waitUntilReady(id, { signal: controller.signal });
  if (controller.signal.aborted) return "cancelled";

  if (readiness === "dead") {
    // It died while we waited — the up-front check cleared it, so the fan-out's
    // summary went out seconds ago and this pane was not in it.
    mark(id, "skipped");
    reportLate("exited", target.name);
    return "skipped";
  }
  if (readiness === "timeout") {
    mark(id, "failed");
    reportLate("unready", target.name);
    return "failed";
  }

  try {
    await sendToTerminal(id, text);
  } catch (err) {
    console.warn("[roc] dispatch write failed:", err);
    mark(id, "failed");
    reportLate("write-failed", target.name);
    return "failed";
  }
  if (controller.signal.aborted) {
    // Cancelled while the write was in the air. The bytes cannot be recalled —
    // but the cancel took the badge down, and a job that painted "Sent" over
    // that would answer the user's cancel with a tick. So it reports no
    // success, and says out loud what actually happened instead: silently
    // letting them believe a message they called off never went is the worse
    // half of the same lie.
    toast(`${target.name} had already been sent it — too late to call it off`);
    return "cancelled";
  }
  mark(id, "sent");
  return "sent";
}

// Saying it once ------------------------------------------------------------

/** The ways a pane can miss a message it was not refused up front. */
type LateFailure = "exited" | "unready" | "write-failed";

/** Names collected since the last flush, in the order the panes gave up. */
const lateFailures = new Map<LateFailure, string[]>();
let lateFlush: ReturnType<typeof setTimeout> | null = null;

/** One pane missed the message, late. Says so with the others that missed it
 *  the same way, rather than on its own.
 *
 *  Held for one turn of the event loop, and no longer. That window is the whole
 *  trick, and it has to be a TASK rather than a microtask: a fan-out starts
 *  every pane's wait in one pass, so the panes that give up on the same budget
 *  hold timers with the same deadline — but a microtask checkpoint runs between
 *  two timer callbacks, so a flush queued from the first pane's `await` fires
 *  before the second pane has given up at all. A timer scheduled from inside
 *  that burst is behind every timer already due, which is exactly the set being
 *  bundled.
 *
 *  A window rather than "when the fan-out finishes", because those are not the
 *  same wait: a pane whose write fails instantly, sent alongside one parked in
 *  front of a permission prompt, would otherwise sit unreported for the five
 *  minutes the other one is allowed to take.
 *
 *  Panes on unlike paths can fall out of step and be told about separately.
 *  That is a bundle that did not happen, not a message that went missing — the
 *  failure this module exists to prevent is silence, and there is none of it. */
function reportLate(reason: LateFailure, name: string): void {
  const names = lateFailures.get(reason);
  if (names) names.push(name);
  else lateFailures.set(reason, [name]);
  if (lateFlush !== null) return;
  lateFlush = setTimeout(flushLateFailures, 0);
}

function flushLateFailures(): void {
  lateFlush = null;
  const batch = [...lateFailures];
  lateFailures.clear();
  // One sentence per REASON, not one for the lot: "is still waiting on you" and
  // "could not send to" are two different things to do about it, and a sentence
  // that ran them together would name panes the user cannot act on as a group.
  for (const [reason, names] of batch) toast(LATE_SENTENCE[reason](names));
}

const LATE_SENTENCE: Record<LateFailure, (names: readonly string[]) => string> =
  {
    exited: (names) => exitedSentence(names),
    unready: (names) =>
      names.length === 1
        ? `${names[0]} is still waiting on you — nothing was sent to it`
        : `${nameList(names)} are still waiting on you —` +
          ` nothing was sent to them`,
    "write-failed": (names) => `Could not send to ${nameList(names)}`,
  };

/** Call off everything outstanding for a pane — the message parked in a wait
 *  and every message queued behind it.
 *
 *  The rail's queued badge is the button for this: a message aimed at a pane
 *  that is asking the user something can sit there for five minutes, and the
 *  user who has changed their mind needs a way to say so that is not "close the
 *  session". */
export function cancelRocDispatch(terminalId: string): void {
  const set = pending.get(terminalId);
  if (!set || set.size === 0) return;
  for (const controller of set) controller.abort();
  // The chain STAYS, and so does the set that each job takes itself out of.
  // An abort cannot reach a job that is already inside its write, and dropping
  // the chain would let the very next message start its own write beside it —
  // two writes racing into one PTY, which is precisely what the chain exists to
  // prevent and what a cancel has no business causing. The aborted jobs resolve
  // within a tick and clean up after themselves, exactly as they always did.
  clearOutstanding(terminalId);
  clearMark(terminalId);
}

// The fan-out ---------------------------------------------------------------

export interface RocDispatchSummary {
  /** The message as it was actually sent — trimmed. */
  text: string;
  /** Names, in the order they were given. */
  sent: string[];
  /** Panes whose agent had already gone. */
  skipped: string[];
  /** Panes that never became writable, and writes that threw. */
  failed: string[];
}

/** How many fan-outs are in flight, so the phase is not put back while one of
 *  them is still working. */
let fanouts = 0;

/** Is anything still being delivered?
 *
 *  Asked by the speech, which outranks a fan-out for the orb (see
 *  `HOLDS_THE_ORB`) and therefore has to know what to give the orb BACK to when
 *  it finishes: "idle" over a fan-out that is still waiting on a busy pane
 *  would put the orb to sleep on work that is still happening. */
export const rocFanoutsInFlight = (): boolean => fanouts > 0;

/** Phases a fan-out must not take the orb away from.
 *
 *  "listening" is the microphone being open, and that is the user's half of the
 *  conversation: it outranks anything the app is doing about a message that has
 *  already been said. `describeRoc` agrees from the other side — the microphone
 *  speaks over the conversation while it is open.
 *
 *  "speaking" is here because a reply being read aloud is the one phase the user
 *  can HEAR, and the only phase with a Stop button on it. A fan-out that stamped
 *  "dispatching" over it (which is what auto-dispatch did, every time) took the
 *  button away while the voice went on talking — and left the speech's own
 *  release, which only ever gives back "speaking", with nothing to give back. */
const HOLDS_THE_ORB: readonly RocPhase[] = ["listening", "speaking"];

function beginFanout(): void {
  fanouts += 1;
  // Guarded on the way IN as well as on the way out, and that symmetry is the
  // point: the end only ever gives back what it took ("dispatching"), so a
  // beginning that took the phase unconditionally could take a recording state
  // and have nothing that would ever hand it back. Nothing sets "listening"
  // yet — the phase is not wired to push-to-talk until it is — and this is
  // exactly the kind of half-invariant that is fine right up until it is not.
  if (HOLDS_THE_ORB.includes(useRocStore.getState().phase)) return;
  useRocStore.getState().setPhase("dispatching");
}

function endFanout(): void {
  fanouts = Math.max(0, fanouts - 1);
  if (fanouts > 0) return;
  // Only ever OUR phase back. The microphone can open mid-dispatch, and
  // stamping "idle" over "listening" would put the orb to sleep while the user
  // is talking to it.
  if (useRocStore.getState().phase === "dispatching") {
    useRocStore.getState().setPhase("idle");
  }
}

/** Say one thing to several agents.
 *
 *  Resolves when every target has answered — written to, skipped, or given up
 *  on. Callers may ignore the promise (the command bar does; it has already
 *  cleared the box) or await it (tests, and the re-send).
 *
 *  `opts.log` may be set to false by a caller that writes its OWN log record —
 *  see the note at the push below. */
export async function dispatchToTargets(
  text: string,
  targets: readonly RocTarget[],
  opts: { log?: boolean } = {},
): Promise<RocDispatchSummary> {
  const message = text.trim();
  const nothing: RocDispatchSummary = {
    text: message,
    sent: [],
    skipped: [],
    failed: [],
  };
  if (message === "") return nothing;

  const unique = dedupe(targets);
  if (unique.length === 0) {
    toast(NOBODY_TO_SEND);
    return nothing;
  }

  clearFinishedMarks();

  // The dead are known before anything is awaited, and saying so as one
  // sentence beats five notifications about five panes.
  const byId = useTerminalsStore.getState().byId;
  const live: RocTarget[] = [];
  const skipped: string[] = [];
  for (const target of unique) {
    const pane = byId[target.terminalId];
    if (pane && !hasExited(pane)) {
      live.push(target);
      continue;
    }
    skipped.push(target.name);
    mark(target.terminalId, "skipped");
  }
  if (skipped.length > 0) toast(exitedSentence(skipped));
  if (live.length === 0) return { ...nothing, skipped };

  // Written now, not when the slowest pane finally takes it: the log answers
  // "did that go", and it has to answer while the user is still asking.
  // …unless the caller is writing its own. A brain turn is several DIFFERENT
  // messages to several panes, and one record per pane would read as several
  // messages the user never sent — so `rocBrain` opts out here and writes a
  // single `viaBrain` record naming every agent it fed.
  if (opts.log !== false) {
    useRocStore.getState().pushLog({
      id: ulid(),
      at: Date.now(),
      text: message,
      targets: live,
      viaBrain: false,
    });
  }

  beginFanout();
  try {
    const results = await Promise.all(
      live.map((target) => enqueue(target, message)),
    );
    const summary: RocDispatchSummary = {
      text: message,
      sent: [],
      skipped,
      failed: [],
    };
    results.forEach((result, i) => {
      const name = live[i]!.name;
      if (result === "sent") summary.sent.push(name);
      else if (result === "skipped") summary.skipped.push(name);
      else if (result === "failed") summary.failed.push(name);
    });
    return summary;
  } finally {
    endFanout();
  }
}

/** One brain turn: a DIFFERENT sentence to each agent, logged as one thing.
 *
 *  The fan-out itself is unchanged — every prompt still goes through
 *  `dispatchToTargets`, so readiness waiting, the per-pane FIFO, sanitizing, the
 *  rail's badges and the dead-pane skip all work exactly as they do for a typed
 *  message. What is different is the log: one record, marked as Roc's, reading
 *  back what the person SAID and carrying what each agent was actually told. One
 *  record per pane would read as several messages they never sent, and a record
 *  with only the sentence in it could not be re-sent without blasting that
 *  sentence at everybody.
 *
 *  Here rather than in `rocBrain` because both callers live here in the end: the
 *  turn itself (through `dispatchRocAssignments`) and the re-send of one. */
export async function dispatchBrainTurn(
  request: string,
  jobs: readonly { target: RocTarget; prompt: string }[],
): Promise<RocDispatchSummary> {
  const message = request.trim();
  const summary: RocDispatchSummary = {
    text: message,
    sent: [],
    skipped: [],
    failed: [],
  };
  if (jobs.length === 0) return summary;

  // Written now rather than when the slowest pane takes its prompt: the log
  // answers "did that go", and it has to answer while the user is still asking.
  useRocStore.getState().pushLog({
    id: ulid(),
    at: Date.now(),
    text: message,
    targets: jobs.map((job) => job.target),
    viaBrain: true,
    prompts: Object.fromEntries(
      jobs.map((job) => [job.target.name, job.prompt]),
    ),
  });

  const summaries = await Promise.all(
    jobs.map((job) =>
      dispatchToTargets(job.prompt, [job.target], { log: false }),
    ),
  );
  for (const one of summaries) {
    summary.sent.push(...one.sent);
    summary.skipped.push(...one.skipped);
    summary.failed.push(...one.failed);
  }
  return summary;
}

/** Say an aimed command, and say so when part of the addressing missed.
 *
 *  The one thing the fan-out cannot report is a name that matched nothing: by
 *  the time it has a list of targets, the name that failed to become one is
 *  gone. So every surface that sends has to say it — and the widget's Send did
 *  not. Dictating "@Rocky @Roxie deploy" with Roxie's pane closed reached Rocky
 *  and said NOTHING about Roxie, leaving the user certain both had been told.
 *  Reaching some of the agents you addressed while looking like you reached all
 *  of them is the failure this module exists to prevent.
 *
 *  One helper rather than one warning per surface, so a third way in cannot
 *  quietly repeat it.
 *
 *  Answers whether the message went to ANYBODY, which is what tells a composer
 *  whether it may throw the draft away. Not whether it arrived — that is
 *  minutes away for a pane with a permission prompt up, and a box that stayed
 *  full until then would be a box the user typed the next message into. */
export function sendRocCommand(command: AimedRocCommand): boolean {
  const text = command.text.trim();
  if (text === "") return false;

  // "The rest still got it" is only true when there IS a rest. Said over an
  // empty target list it is the app inventing a delivery, and it used to be
  // said alongside "Nobody to send that to" — two toasts about one message,
  // disagreeing about whether it went.
  const anyone = command.targets.length > 0;
  if (command.unknown.length > 0) {
    toast(
      `No pane called ${command.unknown.join(", ")} — ` +
        (anyone ? "the rest still got it" : "nothing was sent"),
    );
  }
  if (!anyone) {
    // The sentence above has already said why nothing went, when there was a
    // name to blame it on. When there was not, this is the only thing to say.
    if (command.unknown.length === 0) toast(NOBODY_TO_SEND);
    return false;
  }
  // It still goes to the panes that DID resolve: reaching two of the three
  // agents you addressed is worth knowing about, not worth refusing over.
  void dispatchToTargets(text, command.targets);
  return true;
}

/** Send a log entry again.
 *
 *  By NAME, re-resolved now, INSIDE the workspace each pane was in. A record
 *  outlives the sessions it names — that is why it is re-resolved at all, and a
 *  session restarted since is a new id under the same name, which is exactly
 *  the pane the user means when they click "again" on a message they sent it
 *  ten minutes ago. But the name only means that pane within its own dock: the
 *  pool hands `Rocky` out per app, so a message re-resolved across every
 *  workspace found every Rocky, and a broadcast made in one project silently
 *  grew a target in another. See `reresolveTargets`. */
export async function resendRocDispatch(
  record: RocDispatchRecord,
): Promise<RocDispatchSummary> {
  const nothing: RocDispatchSummary = {
    text: record.text,
    sent: [],
    skipped: [],
    failed: [],
  };
  if (record.targets.length === 0) return nothing;

  const { targets, unknown } = reresolveTargets(record.targets);
  if (unknown.length > 0) {
    toast(
      `${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not open any more`,
    );
  }
  if (targets.length === 0) return nothing;
  return record.viaBrain
    ? resendBrainTurn(record, targets)
    : dispatchToTargets(record.text, targets);
}

/** Send each agent the instruction IT was given, not the sentence you said.
 *
 *  A brain turn's `text` is the request — "ask Rocky to fix the auth test and
 *  have Roxie update the login form" — and putting that into both panes is
 *  exactly the addressed-to-nobody blast the brain replaced. So the record
 *  carries what each agent was actually told (`prompts`) and each of them gets
 *  its own back.
 *
 *  Matched by name, case-insensitively, for the same reason the names were
 *  re-resolved at all: the pane may be a restarted session under the same name.
 *  A name with no instruction kept is dropped rather than guessed at. */
async function resendBrainTurn(
  record: RocDispatchRecord,
  targets: readonly RocTarget[],
): Promise<RocDispatchSummary> {
  const byName = new Map(
    Object.entries(record.prompts ?? {}).map(([name, prompt]) => [
      name.toLowerCase(),
      prompt,
    ]),
  );
  const jobs = targets.flatMap((target) => {
    const prompt = byName.get(target.name.toLowerCase());
    return prompt === undefined ? [] : [{ target, prompt }];
  });
  if (jobs.length === 0) {
    // Nothing to say, and the one thing we must not do is say the request
    // instead. Only reachable through a record older than `prompts`.
    toast(
      "That turn's instructions are not here any more — ask Roc again to send it",
    );
    return { text: record.text, sent: [], skipped: [], failed: [] };
  }
  return dispatchBrainTurn(record.text, jobs);
}

// Small things ---------------------------------------------------------------

/** Same pane twice is one pane. A message pasted twice into one PTY reads as
 *  the user having said it twice. */
function dedupe(targets: readonly RocTarget[]): RocTarget[] {
  const seen = new Set<string>();
  return targets.filter((t) =>
    seen.has(t.terminalId) ? false : (seen.add(t.terminalId), true),
  );
}

const NOBODY_TO_SEND =
  "Nobody to send that to — tick some sessions on the left, or name them with @";

/** "Rocky", "Rocky and Roxie", "Rocky, Roxie and Rex". */
const nameList = (names: readonly string[]): string =>
  names.length === 1
    ? names[0]!
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

const exitedSentence = (names: readonly string[]): string =>
  names.length === 1
    ? `${names[0]}'s agent has exited — nothing was sent to it`
    : `${nameList(names)} have exited — nothing was sent to them`;

const toast = (message: string): void => {
  useToastsStore.getState().push({ message, tone: "warn" });
};

/** Test seam: forget every queue, every wait one is parked in, every badge, and
 *  anything waiting to be said. All of them are module-global by design — a
 *  suite that left one behind would write the next suite's message into a pane,
 *  or name this suite's panes in the next one's toast. */
export function resetRocDispatchState(): void {
  for (const set of pending.values()) {
    for (const controller of set) controller.abort();
    set.clear();
  }
  pending.clear();
  queues.clear();
  fanouts = 0;
  if (lateFlush !== null) clearTimeout(lateFlush);
  lateFlush = null;
  lateFailures.clear();
  useRocDispatchStore.setState({ outcome: {}, outstanding: {} });
}
