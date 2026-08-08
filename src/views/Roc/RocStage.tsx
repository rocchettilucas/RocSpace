/** Roc's stage — the orb you are talking to, and the box you talk in.
 *
 *  Three things stacked, biggest first: the orb and the phase it is in, the
 *  transcript of what Roc last heard, and the command bar with the log of what
 *  has been sent underneath it.
 *
 *  ── The composer's keys ──────────────────────────────────────────────────
 *  Enter SENDS; ⌘Enter and ⇧Enter insert a newline. That way round because the
 *  overwhelmingly common message is one line — it is a sentence said to an
 *  agent — and every chat composer the user has ever typed in agrees. The rare
 *  multi-line prompt costs one modifier; the common one costs nothing.
 *
 *  Only ⇧Enter gets its newline from the browser. ⌘Return is not an editing
 *  default in WKWebView, so this box types that one in itself
 *  (`insertNewline`) — the alternative was a key Settings › Shortcuts
 *  documents and the app ignores.
 *
 *  It matters more here than in a chat app, because Enter is also what a bare
 *  ⌘Enter would submit INTO: the message is framed as a bracketed paste with
 *  one trailing carriage return, so the newlines inside it are text rather than
 *  five separate turns. Which key inserts a newline is therefore a composer
 *  question and not a protocol one — the agent sees the same thing either way.
 *
 *  ── The dictated message ─────────────────────────────────────────────────
 *  A transcript routed to Roc lands in the transcript line, NOT in the panes.
 *  It is sent when the user says so — the button under it, or after putting it
 *  in the bar and editing. Whisper mishears, and a fan-out cannot be taken
 *  back: "delete the migrations" is one wrong word away from something said to
 *  five agents at once. Confirmation is the whole safety margin, so it is one
 *  click and it names who it is about to reach. */

import { useMemo, useState } from "react";
import { Radio, Send, Sparkles, Square } from "lucide-react";
import { RocOrb } from "@/components/RocOrb";
import { describeRoc } from "@/components/RocWidget";
import { isComposingKey } from "@/lib/dom";
import {
  askRoc,
  clearRocPlan,
  dispatchRocAssignments,
  dropRocAssignment,
  editRocAssignment,
  stopRocSpeaking,
  useRocAsking,
  useRocPendingPlan,
  type RocPendingPlan,
} from "@/lib/rocBrain";
import { resendRocDispatch, sendRocCommand } from "@/lib/rocDispatch";
import {
  aimRocCommand,
  resolveTargets,
  type AimedRocCommand,
} from "@/lib/rocTargets";
import { cn } from "@/lib/utils";
import {
  useActiveWorkspaceId,
  useFocusedTerminalId,
  useRocBrainError,
  useRocFocusedRail,
  useRocLog,
  useRocOpen,
  useRocPhase,
  useRocReply,
  useRocSelection,
  useRocStore,
  useRocTalkStore,
  useRocTranscript,
  useTerminalsStore,
  useVoiceSettings,
  type RocDispatchRecord,
  type RocTarget,
} from "@/stores";

export function RocStage() {
  const phase = useRocPhase();
  const transcript = useRocTranscript();
  const clearTranscript = useRocStore((s) => s.clearTranscript);
  const selected = useRocSelection();
  const log = useRocLog();
  const activeWorkspaceId = useActiveWorkspaceId();
  const talkStatus = useRocTalkStore((s) => s.status);
  const enabled = useRocTalkStore((s) => s.enabled);
  const modelStatus = useRocTalkStore((s) => s.modelStatus);
  const voice = useVoiceSettings();

  const reply = useRocReply();
  const brainError = useRocBrainError();
  const pending = useRocPendingPlan();

  const [draft, setDraft] = useState("");
  /** One turn at a time — and the flag is `rocBrain`'s, not this component's.
   *  The widget is mounted at the same time as this stage, so two local flags
   *  meant pressing both buttons spent two lots of money on one question and
   *  let the second turn throw away the first one's plan. */
  const asking = useRocAsking();

  // Who this message would reach, re-answered on every keystroke.
  //
  // `roster` is a STRING and not the sessions themselves, which matters: the
  // terminals store is rewritten on every animation frame that carries PTY
  // output, so subscribing to `byId` would re-render this stage sixty times a
  // second for every streaming pane. Only three fields can change the answer —
  // which panes exist, what they are called, and which dock they are in — so
  // that is what is watched, and zustand's identity check does the rest.
  const roster = useTerminalsStore((s) =>
    Object.values(s.byId)
      .map((t) => `${t.id}\u0000${t.name}\u0000${t.workspaceId}`)
      .join("\u0001"),
  );
  // …and the other thing that can change the answer: who is FOCUSED, which is
  // where a message with no @name and nothing ticked goes (`resolveTargets`,
  // precedence 4). Subscribed rather than read at the press, because this stage
  // sits next to the rail: clicking a rail row moves the rail's focus, and a
  // stage that does not re-render for it reads out the pane the user has just
  // stopped pointing at — and Enter then sends to that same stale pane.
  const focusedTerminalId = useFocusedTerminalId();
  const focus = focusKey(useRocFocusedRail(), focusedTerminalId);
  // The pane a dictated sentence would be TYPED into, which is the dock's
  // focus and not the rail's — the rail says whose screen you are watching.
  // One lookup returning a string, so the frame-rate rewrites of `byId` that
  // the roster selector above is careful about cost nothing here either.
  const dictationTarget = useTerminalsStore((s) =>
    focusedTerminalId ? (s.byId[focusedTerminalId]?.name ?? null) : null,
  );
  const { label, orb } = describeRoc({
    phase,
    talkStatus,
    enabled,
    modelStatus,
    routeTo: voice.routeTo,
    destination: dictationTarget,
  });
  // What is typed, and who it is for. The COMMAND rather than the raw text,
  // because the two differ: `@Rocky ship it` reaches Rocky as "ship it", and
  // pasting the addressing into the pane along with the message would make
  // every dispatch open with a mention of somebody who is not there.
  const composed = useMemo(
    () => resolveCommand(draft, selected, roster, focus),
    [draft, selected, roster, focus],
  );
  const { targets, unknown } = composed;

  // The dictated message is addressed in its own right: "@Rocky run the tests"
  // said out loud has to reach Rocky, not whoever the BAR happens to point at.
  const dictated = useMemo(
    () => resolveCommand(transcript, selected, roster, focus),
    [transcript, selected, roster, focus],
  );

  // Everyone in the dock behind this view — the same list `@all` resolves to,
  // and deliberately not the whole app: a broadcast said while looking at one
  // project must not reach into another the user forgot was open.
  const broadcast = useMemo(
    () => broadcastTargets(activeWorkspaceId, roster),
    [activeWorkspaceId, roster],
  );

  /** Think about `request`, then let the caller tidy up if it produced
   *  anything. Nothing is cleared when the turn failed: the sentence is all the
   *  user has, and `brainError` says why it went nowhere. */
  const ask = (request: string, onAnswered?: () => void) => {
    if (request.trim() === "") return;
    // No `asking` check here: `askRoc` is the guard, because it is the only
    // thing that can see a turn the other surface started.
    void askRoc(request).then((plan) => {
      if (plan) onAnswered?.();
    });
  };

  const submit = () => {
    // Resolved AGAIN, at the press. The subscription above keeps the summary
    // honest across a re-render, but the write must not depend on a render
    // having happened: whatever the panes are told has to be what the line
    // above the box says, and the only way to guarantee that is to ask the same
    // question with the same arguments at the moment the message goes.
    const command = resolveCommand(draft, selected, roster, focus);
    if (command.text === "") return;
    // `sendRocCommand` rather than the fan-out directly: it is the one place
    // that says which of the names matched nothing, and every surface that
    // sends has to say it. It does not wait for delivery — that can be minutes
    // away for a pane with a permission prompt up, and the box has to empty
    // NOW — it answers whether the message went to anybody at all.
    //
    // …which is the only thing that may empty the box. Enter used to clear it
    // unconditionally, so "@Ghost redeploy staging" destroyed a sentence
    // nothing had received and nothing could get back.
    if (sendRocCommand(command)) setDraft("");
  };

  /** The dictated message, confirmed. Cleared once it has gone: it has been
   *  acted on, it is in the log now, and a transcript left on screen reads like
   *  something still waiting to be sent. Kept if it went nowhere, for the same
   *  reason the draft is — nobody dictates the same sentence twice on purpose. */
  const sendTranscript = () => {
    if (sendRocCommand(dictated)) clearTranscript();
  };

  /** Whether THIS surface is the one that announces.
   *
   *  The widget and this stage say the same three things — the phase, the
   *  transcript, and the reply — because they are the same conversation drawn
   *  twice, and the widget is mounted for the whole session while this view
   *  comes and goes. Two live regions per string is two announcements per
   *  change: a screen-reader user heard "Thinking… Thinking… Speaking…
   *  Speaking…" for one turn.
   *
   *  So the widget is the announcer whenever it is ON SCREEN, and this stage
   *  takes over exactly when it is not: closing the widget is "not now", and
   *  the Roc view can be opened with it closed (⌘⇧R, or the palette), which
   *  would otherwise leave a screen-reader user with an orb that says nothing
   *  at all. One region either way, never two. */
  const announce = useRocOpen() ? undefined : "polite";

  const broadcastNow = () => {
    if (composed.text === "") return;
    // Same rule as Enter: the box is emptied by a message having gone, not by
    // the button having been pressed.
    const sent = sendRocCommand({
      text: composed.text,
      targets: broadcast,
      unknown: [],
    });
    if (sent) setDraft("");
  };

  return (
    <section
      aria-label="Roc"
      className="flex h-full min-h-0 flex-col bg-surface-0"
    >
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 py-4">
        {/* The thing you are talking to, at the size that makes it one. 160
            rather than a round 180 so it still clears the padding when this
            column is dragged to its 24% minimum on a small window. */}
        <RocOrb state={orb} size={160} />
        {/* The orb is `aria-hidden`, so this line is the whole of what it says
            in words — but it is not the only copy of it on screen. The widget
            renders the same three things, from the same `describeRoc`, and it
            is up at the same time as this view: two live regions holding one
            string announced every phase change twice, six times for one
            idle → thinking → speaking → idle turn. See `announce`. */}
        <p
          aria-live={announce}
          className="text-[10px] uppercase tracking-[0.2em] text-fg-muted"
        >
          {label}
        </p>
        <p
          aria-live={announce}
          className={cn(
            "max-h-24 overflow-auto text-center text-sm",
            transcript ? "italic text-fg-secondary" : "text-fg-muted",
          )}
        >
          {transcript || "Hold the push-to-talk key, or type below."}
        </p>
        {transcript ? (
          <div className="flex flex-wrap items-center justify-center gap-2">
            {/* What a dictated sentence is FOR, now that Roc can think about
                one: a routing question, not a message. It is first because a
                transcript only reaches this stage when voice is routed to Roc,
                and "understand me" is what that routing asked for. */}
            <button
              type="button"
              onClick={() => ask(transcript, clearTranscript)}
              disabled={asking}
              className="flex items-center gap-1 rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-accent-fg transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Sparkles className="h-3 w-3" />
              {asking ? "Thinking…" : "Ask Roc"}
            </button>
            {/* The confirm. It names who it would reach, because a dictated
                sentence is the one message the user did not read before it
                went — and a fan-out cannot be taken back. */}
            <button
              type="button"
              onClick={sendTranscript}
              disabled={dictated.targets.length === 0}
              className="rounded-md bg-surface-2 px-2.5 py-1 text-xs text-fg-primary transition-colors hover:bg-surface-3 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {dictated.targets.length === 0
                ? "Nobody to send it to"
                : `Send to ${describeTargets(dictated.targets)}`}
            </button>
            <button
              type="button"
              onClick={() => {
                setDraft(transcript);
                // It is in the bar now, so it is not still waiting on the
                // stage — and Roc is not still thinking about it.
                clearTranscript();
              }}
              className="rounded-md bg-surface-2 px-2.5 py-1 text-xs text-fg-primary transition-colors hover:bg-surface-3"
            >
              Put it in the bar
            </button>
            <button
              type="button"
              onClick={clearTranscript}
              className="rounded-md px-2.5 py-1 text-xs text-fg-secondary transition-colors hover:bg-surface-2 hover:text-fg-primary"
            >
              Clear
            </button>
          </div>
        ) : null}

        <BrainError message={brainError} />
        <Reply
          text={reply}
          speaking={phase === "speaking"}
          announce={announce}
        />
        {pending ? <PendingPlan plan={pending} /> : null}
      </div>

      <div className="shrink-0 border-t border-border bg-surface-1 p-2">
        <TargetSummary targets={targets} unknown={unknown} />
        <div className="mt-1.5 flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              // ⇧Enter is the newline, and the textarea already inserts it —
              // stepping out of the way is the whole handling it needs.
              if (e.shiftKey) return;
              // ⌘Enter is the newline too, and is NOT an editing default the
              // way ⇧Return is: WKWebView does not insert on it, so returning
              // here left a documented key doing nothing at all. Typed in by
              // hand instead, at the caret, replacing any selection — which is
              // what an insertion means everywhere else in the app.
              if (e.metaKey) {
                e.preventDefault();
                insertNewline(e.currentTarget, setDraft);
                return;
              }
              // …and the Enter that accepts an IME candidate is neither. A
              // composer that sends on it dispatches half a Japanese sentence
              // to every agent the bar is pointed at. See `isComposingKey`.
              if (isComposingKey(e)) return;
              e.preventDefault();
              submit();
            }}
            rows={2}
            placeholder="Say something to your agents — @Rocky @Roxie, or @all"
            aria-label="Message for your agents"
            className="min-h-0 w-full flex-1 resize-none rounded-input border border-border bg-surface-0 px-2 py-1.5 text-xs text-fg-primary outline-none placeholder:text-fg-muted focus:border-border-active"
          />
          {/* The one target list you cannot describe by typing: everyone in
              the dock behind this view. `@all` in the message does the same
              thing, and this is the version you do not have to know about. */}
          <button
            type="button"
            onClick={broadcastNow}
            disabled={composed.text === "" || broadcast.length === 0}
            title={
              broadcast.length === 0
                ? "No sessions in this workspace"
                : `Send to all ${broadcast.length} in this workspace`
            }
            aria-label="Broadcast to every agent in this workspace"
            className="flex h-7 shrink-0 items-center gap-1 rounded-md bg-surface-2 px-2 text-[10px] uppercase tracking-wider text-fg-secondary transition-colors hover:bg-surface-3 hover:text-fg-primary disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-surface-2"
          >
            <Radio className="h-3 w-3" />
            All
          </button>
          {/* Ask, rather than send. The same box either way — what changes is
              whether the words go to the agents or to Roc. */}
          <button
            type="button"
            onClick={() => ask(draft, () => setDraft(""))}
            disabled={draft.trim() === "" || asking}
            title="Ask Roc, and let it decide who does what"
            aria-label="Ask Roc"
            className="flex h-7 shrink-0 items-center gap-1 rounded-md bg-surface-2 px-2 text-[10px] uppercase tracking-wider text-fg-secondary transition-colors hover:bg-surface-3 hover:text-fg-primary disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-surface-2"
          >
            <Sparkles className="h-3 w-3" />
            {asking ? "Thinking" : "Ask"}
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={composed.text === ""}
            title="Send"
            aria-label="Send"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-surface-2 text-fg-primary transition-colors hover:bg-surface-3 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-surface-2"
          >
            <Send className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <DispatchLog log={log} />
    </section>
  );
}

/** Type a newline in at the caret, replacing whatever is selected.
 *
 *  What ⌘Enter needs and ⇧Enter does not: the browser has an editing default
 *  for the second and none for the first, so this is the app doing by hand
 *  what WebKit does for the shifted key.
 *
 *  The box is CONTROLLED, so the text has to go through React — and React puts
 *  the caret at the end of any value it writes, which would land it after the
 *  rest of the message rather than on the new line. Writing the value onto the
 *  element first means React's next commit sees the DOM already holding what
 *  it is about to render and leaves the node (and the selection) alone. */
function insertNewline(
  box: HTMLTextAreaElement,
  setDraft: (value: string) => void,
): void {
  const { value, selectionStart, selectionEnd } = box;
  const from = selectionStart ?? value.length;
  const to = selectionEnd ?? from;
  const next = `${value.slice(0, from)}\n${value.slice(to)}`;
  setDraft(next);
  box.value = next;
  box.setSelectionRange(from + 1, from + 1);
}

function broadcastTargets(
  // Neither is read: both are the memo keys that stand for "the answer may have
  // changed", since `resolveTargets` reads the stores itself per its contract.
  _activeWorkspaceId: string | null,
  _roster: string,
): RocTarget[] {
  return resolveTargets(
    { text: "", explicitNames: [], broadcast: true },
    { selectedIds: [], activeWorkspaceOnly: true },
  ).targets;
}

/** The two focus fields as one memo key. Neither is read by `resolveCommand`;
 *  both change its answer, so both have to be watched. */
const focusKey = (railId: string | null, dockId: string | null): string =>
  `${railId ?? ""}\u0000${dockId ?? ""}`;

function resolveCommand(
  input: string,
  selectedIds: string[],
  // Not read — it is the memo key that stands for "the sessions changed", since
  // `resolveTargets` reads the stores itself per its contract.
  _roster: string,
  // Same again for the focused pane, which is who a message with no @name and
  // nothing ticked goes to.
  _focus: string,
): AimedRocCommand {
  return aimRocCommand(input, {
    selectedIds,
    // Roc's rail spans every workspace on purpose, so its command bar does too:
    // `@Rocco` finds the pane whether or not its dock is the one up.
    activeWorkspaceOnly: false,
  });
}

/** Why the last turn produced nothing.
 *
 *  Inline AND a toast (raised by `runRocBrain`), because the two answer
 *  different questions: the toast says something went wrong while you were
 *  looking somewhere else, and this says what — and stays there while you fix
 *  it. A missing CLI is the case that matters: it is the difference between
 *  "Roc is broken" and "Roc needs Claude Code installed". */
function BrainError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p
      role="alert"
      className="max-h-24 w-full max-w-xl overflow-auto rounded-md border border-warning bg-surface-2 px-3 py-2 text-center text-xs text-warning"
    >
      {message}
    </p>
  );
}

/** What Roc said back, and the way out of hearing it.
 *
 *  Announced when this surface is the announcer — see `announce` on the stage:
 *  the widget renders this same reply, and two live regions holding one string
 *  read it out twice. Stop is only there while there is something to stop. */
function Reply({
  text,
  speaking,
  announce,
}: {
  text: string | null;
  speaking: boolean;
  announce: "polite" | undefined;
}) {
  if (!text) return null;
  return (
    <div className="flex w-full max-w-xl items-start justify-center gap-2">
      <p
        aria-live={announce}
        className="max-h-24 overflow-auto text-center text-sm text-fg-primary"
      >
        {text}
      </p>
      {speaking ? (
        <button
          type="button"
          onClick={() => void stopRocSpeaking()}
          aria-label="Stop speaking"
          title="Stop speaking"
          className="flex h-6 shrink-0 items-center gap-1 rounded-md bg-surface-2 px-2 text-[10px] uppercase tracking-wider text-fg-secondary transition-colors hover:bg-surface-3 hover:text-fg-primary"
        >
          <Square className="h-2.5 w-2.5" />
          Stop
        </button>
      ) : null}
    </div>
  );
}

/** The plan, waiting on the user.
 *
 *  This list is the whole reason auto-dispatch is off by default: a model that
 *  understood most of a sentence writes a prompt that is mostly right, and the
 *  cheapest possible fix is a textarea. Nothing here has reached a PTY yet —
 *  Send is the moment it does, and every one of them goes through the same
 *  fan-out a typed message does. */
function PendingPlan({ plan }: { plan: RocPendingPlan }) {
  const [editing, setEditing] = useState<number | null>(null);

  const send = (index: number) => {
    const assignment = plan.assignments[index];
    if (!assignment) return;
    void dispatchRocAssignments([assignment], plan.request);
    setEditing(null);
    dropRocAssignment(index);
  };

  const sendAll = () => {
    void dispatchRocAssignments(plan.assignments, plan.request);
    setEditing(null);
    clearRocPlan();
  };

  return (
    <div className="w-full max-w-xl rounded-card border border-border bg-surface-1 p-2">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-fg-muted">
          {plan.assignments.length === 1
            ? "1 agent — nothing sent yet"
            : `${plan.assignments.length} agents — nothing sent yet`}
        </p>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={sendAll}
            className="rounded-md bg-accent px-2 py-1 text-[11px] font-medium text-accent-fg transition-opacity hover:opacity-90"
          >
            Send all
          </button>
          <button
            type="button"
            onClick={clearRocPlan}
            aria-label="Drop the whole plan"
            className="rounded-md px-2 py-1 text-[11px] text-fg-secondary transition-colors hover:bg-surface-2 hover:text-fg-primary"
          >
            Cancel
          </button>
        </div>
      </div>
      <ul className="flex flex-col gap-1.5">
        {plan.assignments.map((assignment, index) => (
          <li
            key={`${assignment.name}-${index}`}
            className="rounded-md bg-surface-2 px-2 py-1.5"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-[11px] font-semibold text-fg-primary">
                {assignment.name}
              </span>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => send(index)}
                  aria-label={`Send ${assignment.name} this instruction`}
                  className="rounded-md bg-surface-3 px-2 py-0.5 text-[10px] uppercase tracking-wider text-fg-primary transition-opacity hover:opacity-90"
                >
                  Send
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setEditing((current) => (current === index ? null : index))
                  }
                  aria-label={`Edit ${assignment.name}'s instruction`}
                  className="rounded-md px-2 py-0.5 text-[10px] uppercase tracking-wider text-fg-secondary transition-colors hover:bg-surface-3 hover:text-fg-primary"
                >
                  {editing === index ? "Done" : "Edit"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEditing(null);
                    dropRocAssignment(index);
                  }}
                  aria-label={`Drop ${assignment.name} from the plan`}
                  className="rounded-md px-2 py-0.5 text-[10px] uppercase tracking-wider text-fg-secondary transition-colors hover:bg-surface-3 hover:text-fg-primary"
                >
                  Drop
                </button>
              </div>
            </div>
            {editing === index ? (
              <textarea
                value={assignment.prompt}
                onChange={(e) => editRocAssignment(index, e.target.value)}
                rows={3}
                aria-label={`Instruction for ${assignment.name}`}
                className="mt-1 w-full resize-none rounded-input border border-border bg-surface-0 px-2 py-1 text-[11px] text-fg-primary outline-none focus:border-border-active"
              />
            ) : (
              <p className="mt-0.5 whitespace-pre-wrap break-words text-[11px] text-fg-secondary">
                {assignment.prompt}
              </p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** "Rocky", or "3 agents". One name is worth printing; four are a list nobody
 *  reads on a button. */
export function describeTargets(targets: readonly RocTarget[]): string {
  if (targets.length === 1) return targets[0]!.name;
  return `${targets.length} agents`;
}

/** Who this message would reach, said in words BEFORE it is sent.
 *
 *  This is the @-token feedback: a textarea cannot colour a token in place
 *  without an overlay that has to track its scroll and wrapping exactly, and an
 *  overlay that is one pixel out is worse than no highlight at all. Naming the
 *  panes underneath answers the question the highlight was standing in for —
 *  "did it understand who I meant" — and answers it for the rail's selection and
 *  the focused pane too, which a highlight never could.
 *
 *  A name that matched nothing is called out rather than quietly dropped: a
 *  dispatch that reaches two of the three agents you addressed is the failure
 *  worth catching before it happens, not after. */
function TargetSummary({
  targets,
  unknown,
}: {
  targets: readonly RocTarget[];
  unknown: readonly string[];
}) {
  return (
    <p className="truncate text-[10px] uppercase tracking-wider">
      <span className="text-fg-muted">
        {targets.length === 0
          ? "No agents — type @name, or pick some on the left"
          : `${targets.length} agent${targets.length === 1 ? "" : "s"}: ${targets
              .map((t) => t.name)
              .join(", ")}`}
      </span>
      {unknown.length > 0 ? (
        <span className="text-warning">
          {" "}
          · no pane called {unknown.join(", ")}
        </span>
      ) : null}
    </p>
  );
}

/** What has been sent, and the fastest way to send it again.
 *
 *  Every entry is a button, because "say that again" is the second most common
 *  thing anybody does with a message to an agent — after saying it once. It
 *  re-resolves by name within each pane's own workspace (`resendRocDispatch`),
 *  so a session that has been restarted since gets it and a same-named pane in
 *  another project does not.
 *
 *  A brain turn is MARKED, and it is worth marking because it reads back
 *  differently from everything else in this list: what is shown is the sentence
 *  the user said, and what each agent received was its own tailored instruction.
 *  Pressing it sends those instructions again, not the sentence — the badge is
 *  the only thing on screen that says the two are different. */
function DispatchLog({ log }: { log: readonly RocDispatchRecord[] }) {
  return (
    <div className="max-h-40 shrink-0 overflow-auto border-t border-border bg-surface-1 px-2 py-1.5">
      <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-fg-muted">
        Sent
      </p>
      {log.length === 0 ? (
        <p className="pb-1 text-[11px] italic text-fg-muted">
          Nothing yet. What you send shows up here — click one to send it again.
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {log.map((record) => {
            const names = record.targets.map((t) => t.name).join(", ");
            return (
              <li key={record.id}>
                <button
                  type="button"
                  onClick={() => void resendRocDispatch(record)}
                  title={
                    record.viaBrain
                      ? `Send Roc's instructions to ${names} again`
                      : `Send it again to ${names}`
                  }
                  className="w-full rounded-md bg-surface-2 px-2 py-1 text-left transition-colors hover:bg-surface-3"
                >
                  <span className="flex items-center gap-1">
                    {record.viaBrain ? (
                      <span
                        aria-label="Roc's turn"
                        className="flex shrink-0 items-center gap-0.5 rounded bg-surface-3 px-1 text-[9px] font-semibold uppercase tracking-wider text-accent"
                      >
                        <Sparkles className="h-2.5 w-2.5" />
                        Roc
                      </span>
                    ) : null}
                    <span className="truncate text-[11px] text-fg-secondary">
                      {record.text}
                    </span>
                  </span>
                  <span className="block truncate text-[10px] text-fg-muted">
                    {names === "" ? "nobody" : names}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
