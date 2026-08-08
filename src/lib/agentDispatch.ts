/** Writing to an agent, safely — the primitives every dispatch shares.
 *
 *  Lifted out of `rocplanDispatch`, where they were written and where they were
 *  argued with by real terminals for a phase. Nothing here is new; what is new
 *  is that RocPlan's board is no longer the only thing that dispatches. Roc
 *  fans one message out to many panes, the live terminal panel types into one,
 *  and dictation writes a transcript — and every one of those has to answer the
 *  same three questions the board already answered:
 *
 *    WHAT is safe to put in a PTY (`sanitizeForPty`, `pasteSafeLine`);
 *    HOW it is framed so a multi-line message arrives as one paste and one
 *      Enter rather than as five turns (`toBracketedPaste`);
 *    WHEN a pane can be written into at all (`waitUntilReady`).
 *
 *  Copying those into a second module would have been the ordinary mistake, and
 *  an expensive one: the sanitizer is a security boundary (text from a repo, or
 *  from a speech model, is about to be executed by whatever the pane is running)
 *  and a second copy is a second thing to forget to fix. So this module owns
 *  them and `rocplanDispatch` imports them, unchanged.
 *
 *  What is deliberately NOT here: choosing a pane, remembering what was sent,
 *  toasts. Those are policy, they differ per caller, and they are why the two
 *  dispatch modules are still two modules. */

import {
  commands,
  type TerminalSession,
  type TerminalStatus,
} from "@/lib/bindings";
import { useTerminalsStore } from "@/stores/terminals";
import { useTerminalRuntimeStore } from "@/stores/terminalRuntime";

/** How long a non-hook-driven pane has to be silent before it counts as ready.
 *  Same guess, and the same length, as `ptyBridge`'s idle watchdog — the two
 *  are answering the same unanswerable question about the same agents. */
export const DISPATCH_QUIET_MS = 1_000;

/** …and how long we will keep waiting for that second. A pane streaming a
 *  build never has one, and a prompt that is never sent because the pane is
 *  busy is worse than a prompt that queues behind the build's output. */
export const DISPATCH_QUIET_MAX_WAIT_MS = 10_000;

/** How long a dispatch waits on a pane that is asking the user something.
 *
 *  Bounded because the alternative is a promise that lives until the app quits,
 *  holding a store subscription, for a message the user has probably given up
 *  on. Generous because the thing being waited on is a human answering a
 *  permission prompt. */
export const DISPATCH_APPROVAL_WAIT_MS = 5 * 60_000;

// What is safe to write -----------------------------------------------------

/** Every C0 control except the newline, plus DEL.
 *
 *  `\r` (0x0d) is inside the range on purpose: the two helpers below decide
 *  what a carriage return should BECOME before this strips whatever is left. */
// eslint-disable-next-line no-control-regex -- control bytes are the subject
const CONTROL_BYTES = /[\u0000-\u0009\u000b-\u001f\u007f]/g;

/** Break the two bracketed-paste markers as literal text.
 *
 *  Belt and braces: the escape that makes `[201~` a real CSI sequence is gone
 *  by the time this runs, so what it defuses is a marker rebuilt downstream —
 *  by a terminal that resynchronises on a stray byte, or by a future caller
 *  that frames this text some other way. A space costs nothing to read and
 *  cannot be part of a control sequence. */
const neutralizePasteMarkers = (text: string): string =>
  text.replace(/\[(200|201)~/g, "[$1 ~");

/** Text as ONE line — a title, an id, a dictated sentence.
 *
 *  Line breaks become spaces rather than disappearing, so two words that were
 *  on two lines do not silently become one word. */
export function pasteSafeLine(text: string): string {
  return neutralizePasteMarkers(
    text.replace(/[\r\n]+/g, " ").replace(CONTROL_BYTES, ""),
  );
}

/** Text as a BLOCK — a prompt, a message to an agent.
 *
 *  Keeps `\n`, which is the whole reason a prompt is framed as a paste, and
 *  folds `\r` into it: inside a paste a carriage return is a submit on every
 *  ink-based CLI, so a message written on Windows line endings would end the
 *  paste early on its first line. */
export function sanitizeForPty(text: string): string {
  return neutralizePasteMarkers(
    text.replace(/\r\n?/g, "\n").replace(CONTROL_BYTES, ""),
  );
}

/** The message, as bytes a PTY will accept as one paste and one Enter.
 *
 *  Bracketed paste is not decoration. A multi-line message's bare `\n` is Enter
 *  as far as any TUI is concerned: Claude Code would submit the first line on
 *  its own and take the rest as further turns. Wrapped in `ESC[200~` /
 *  `ESC[201~`, the whole block arrives as one paste — exactly what a human
 *  pasting into the composer does — and the trailing `\r` is the Enter that
 *  sends it. Readline (bash, zsh) and every ink-based CLI understand the same
 *  framing.
 *
 *  The body is re-sanitized on the way in, so the framing is safe by
 *  construction rather than by the caller having remembered: the only escape
 *  and the only carriage return that reach the PTY are the frame's own. */
export function toBracketedPaste(text: string): string {
  return `\x1b[200~${sanitizeForPty(text)}\x1b[201~\r`;
}

// When a pane can be written into -------------------------------------------

/** Is this pane's process gone?
 *
 *  `complete` is a clean exit and `error` a crash; both mean there is nothing
 *  on the other end of the PTY. Worth asking BEFORE writing, because the write
 *  itself will not say so: Rust keeps an exited session in its map, so the
 *  bytes land in a dead file descriptor and the call succeeds. */
export const hasExited = (terminal: TerminalSession): boolean =>
  terminal.status === "complete" || terminal.status === "error";

/** Statuses a pane may be written into.
 *
 *  `idle` is a claude pane between turns; `running` is one mid-turn, which is
 *  fine — the CLI queues what is typed. What is NOT here is `awaiting_approval`,
 *  and that is the whole point of waiting. */
const READY: readonly TerminalStatus[] = ["idle", "running"];

/** Does this pane report its own lifecycle?
 *
 *  Agent type rather than `ptyBridge`'s `isHookDriven`: that asks whether the
 *  hooks are live RIGHT NOW (a hydrated pane with a parked conversation is not
 *  driven by anything), while the question here is which readiness rule to use,
 *  and for a claude pane that is the hook-shaped one either way. Waiting a
 *  second of silence on a pane that reports `awaiting_approval` accurately
 *  would just be a slower way to get the same answer. */
const isHookShaped = (terminal: TerminalSession): boolean =>
  terminal.agentConfig.type === "claude-code";

/** What a wait can end in.
 *
 *  `ready` — write now. `timeout` — it would not be safe to write and it never
 *  became safe (or the caller called the wait off; the caller knows which).
 *  `dead` — there is no process on the other end, so the write would succeed
 *  into nothing. */
export type Readiness = "ready" | "timeout" | "dead";

export interface WaitOptions {
  /** The whole budget for this wait. Defaults to `DISPATCH_APPROVAL_WAIT_MS`
   *  for a pane that reports its own state and `DISPATCH_QUIET_MAX_WAIT_MS` for
   *  one that does not — two very different questions with two very different
   *  reasonable answers. */
  timeoutMs?: number;
  /** Call the wait off. Aborting resolves `timeout` and, more importantly, lets
   *  go of the store subscription the wait is parked on — a fan-out that is
   *  superseded must not leave a listener per target behind. */
  signal?: AbortSignal;
  /** Called once, if this wait is actually going to park.
   *
   *  "Is this pane busy?" has no cheap answer from outside: it is the same two
   *  rules this module already holds, and a caller re-deriving them would be a
   *  second copy that could disagree. Roc's rail wears a "queued" badge for
   *  exactly the panes that got here — so rather than every caller guessing,
   *  the wait says so on its way down. Not called when the answer is already
   *  known, which is why a pane that is free never flashes a badge. */
  onWaiting?: () => void;
}

/** Resolve when this pane is safe to write into.
 *
 *  Two rules, because there are two kinds of agent. A claude pane says what it
 *  is doing through its hooks, so the question is simply whether it is asking
 *  the user something — writing a message into an open permission prompt
 *  ANSWERS that prompt with the message. Everything else says nothing, so the
 *  question becomes the same guess `ptyBridge` makes: has it been quiet for a
 *  second? */
export function waitUntilReady(
  terminalId: string,
  opts: WaitOptions = {},
): Promise<Readiness> {
  const terminal = useTerminalsStore.getState().byId[terminalId];
  if (!terminal || hasExited(terminal)) return Promise.resolve("dead");
  if (opts.signal?.aborted) return Promise.resolve("timeout");
  return isHookShaped(terminal)
    ? waitForApproval(terminalId, opts)
    : waitForQuiet(terminalId, opts);
}

/** Hold until a claude pane is not asking the user anything.
 *
 *  A pane whose process ends while we wait resolves `dead` rather than parking
 *  for the full budget: its prompt is never going to clear, and holding a
 *  subscription for five minutes waiting for an answer nobody can give is how
 *  a fan-out ends up with a listener per dead pane. */
function waitForApproval(
  terminalId: string,
  opts: WaitOptions,
): Promise<Readiness> {
  const status = useTerminalsStore.getState().byId[terminalId]?.status;
  if (status === undefined) return Promise.resolve("dead");
  if (status !== "awaiting_approval") return Promise.resolve("ready");

  opts.onWaiting?.();
  return new Promise<Readiness>((resolve) => {
    let done = false;
    const finish = (result: Readiness) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();
      opts.signal?.removeEventListener("abort", giveUp);
      resolve(result);
    };
    const giveUp = () => finish("timeout");
    const timer = setTimeout(
      giveUp,
      opts.timeoutMs ?? DISPATCH_APPROVAL_WAIT_MS,
    );
    const unsubscribe = useTerminalsStore.subscribe((state) => {
      const next = state.byId[terminalId];
      // The pane was closed while we waited. Nothing to write into.
      if (!next) return finish("dead");
      if (hasExited(next)) return finish("dead");
      if (READY.includes(next.status)) finish("ready");
    });
    opts.signal?.addEventListener("abort", giveUp);
  });
}

/** What "this pane has produced output since I last looked" is measured on.
 *
 *  The IDENTITY of the newest line, not the number of lines. `output` is a ring
 *  buffer capped at `OUTPUT_RING_BUFFER_CAP`, so its length climbs to the cap
 *  once and then never moves again however hard the pane is streaming — every
 *  new line drops the oldest. Watching the length meant watching a constant on
 *  every pane that had been used for more than a screenful, and one of those
 *  was declared quiet a second into a build it was still pouring out.
 *
 *  Line ids are minted per line (Rust's `lineId`), so this changes on every
 *  line that arrives and on a clear, which is the whole question being asked.
 *  The length rides along for the one case the id cannot see: a ring emptied
 *  back to nothing. */
const outputMark = (terminal: TerminalSession | undefined): string => {
  if (!terminal) return "";
  const output = terminal.output;
  return `${output.length}:${output[output.length - 1]?.id ?? ""}`;
};

/** Hold until a pane with no hooks has been silent for `DISPATCH_QUIET_MS`.
 *
 *  Measured on the ring buffer rather than on the status, because status is
 *  exactly what these agents do not report. The cap is what keeps a chatty pane
 *  from swallowing the message entirely: once the budget runs out the answer is
 *  `ready`, not `timeout` — we write anyway and let the CLI queue it, which is
 *  strictly better than never sending at all. */
function waitForQuiet(
  terminalId: string,
  opts: WaitOptions,
): Promise<Readiness> {
  // Always a wait: this rule cannot answer "ready" without a quiet second to
  // measure, so a pane on it is busy for at least that long by definition.
  opts.onWaiting?.();
  return new Promise<Readiness>((resolve) => {
    let done = false;
    let quiet: ReturnType<typeof setTimeout>;
    let seen = outputMark(useTerminalsStore.getState().byId[terminalId]);

    const finish = (result: Readiness) => {
      if (done) return;
      done = true;
      clearTimeout(quiet);
      clearTimeout(cap);
      unsubscribe();
      opts.signal?.removeEventListener("abort", giveUp);
      resolve(result);
    };
    const giveUp = () => finish("timeout");
    const arm = () => {
      clearTimeout(quiet);
      quiet = setTimeout(() => finish("ready"), DISPATCH_QUIET_MS);
    };

    const cap = setTimeout(
      () => finish("ready"),
      opts.timeoutMs ?? DISPATCH_QUIET_MAX_WAIT_MS,
    );
    const unsubscribe = useTerminalsStore.subscribe((state) => {
      const next = state.byId[terminalId];
      if (!next) return finish("dead");
      if (hasExited(next)) return finish("dead");
      const mark = outputMark(next);
      if (mark === seen) return;
      seen = mark;
      arm();
    });
    opts.signal?.addEventListener("abort", giveUp);
    arm();
  });
}

// The write -----------------------------------------------------------------

/** Put a message in a pane's PTY, framed and submitted.
 *
 *  Throws whatever the write threw — a caller that wants to say something about
 *  a failed dispatch needs to know it failed, and the shapes of that sentence
 *  differ per caller.
 *
 *  `notifyUserInput` after the write, and only after a write that worked: the
 *  pane has been typed into, by us on the user's behalf. The idle watchdog and
 *  the notification bridge both gate on that flag, and a pane dispatched to
 *  without it would neither warn about a permission prompt nor ping when it
 *  finished. Deliberately the raw flag rather than `notifyTerminalUserInput`,
 *  which ALSO clears `awaiting_approval` — a dispatch waits for that state to
 *  clear rather than answering it, so there is nothing here to clear. */
export async function sendToTerminal(
  terminalId: string,
  text: string,
): Promise<void> {
  await commands.terminalWrite(terminalId, toBracketedPaste(text));
  useTerminalRuntimeStore.getState().notifyUserInput(terminalId);
}
