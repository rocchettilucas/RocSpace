/** Roc's brain — the step between hearing a sentence and dispatching one.
 *
 *  Phase 4 could take "ask Rocky to fix the auth test and have Roxie update the
 *  login form" and paste that whole sentence into whichever panes happened to
 *  be selected. Both agents got a message about the other one's job, addressed
 *  to nobody, and neither of them got an instruction. What was missing was not
 *  a better dispatcher — the dispatcher is fine — but a thought.
 *
 *  So: one turn through the Claude Code CLI (`roc_think`, see
 *  `src-tauri/src/roc_brain`), given the live session roster, answering with a
 *  sentence for the user and one tailored prompt per agent. This module owns
 *  that turn's three halves — the prompt that goes out, the answer that comes
 *  back, and the names in it — and nothing else: delivery is still
 *  `rocDispatch`, addressing is still `rocTargets`, and the phase machine is
 *  still the roc store.
 *
 *  ── The answer is not to be trusted ──────────────────────────────────────
 *
 *  Everything below the API call treats the model's output as text somebody
 *  else wrote. It may be fenced. It may have a sentence in front of it. It may
 *  name an agent that does not exist, or the same one twice, or none at all.
 *  Each of those is handled and none of them is silent — an answer that cannot
 *  be understood becomes a `brainError` the user can read, because a brain that
 *  fails quietly is exactly the Roc this phase exists to replace.
 *
 *  A name that matched nothing is REPORTED and dropped rather than guessed at.
 *  Dispatching a tailored instruction to the wrong agent is worse than not
 *  dispatching it: the user asked for something specific and somebody else
 *  starts doing it. */

import { create } from "zustand";
import { devtools } from "zustand/middleware";
import { commands, type RocThinkResult } from "@/lib/bindings";
import { dispatchBrainTurn, rocFanoutsInFlight } from "@/lib/rocDispatch";
import { addressablePanes, resolveTargets } from "@/lib/rocTargets";
import { useRocStore, type RocPhase, type RocTarget } from "@/stores/roc";
import { useSettingsStore, type RocPersona } from "@/stores/settings";
import { useToastsStore } from "@/stores/toasts";
import { useWorkspacesStore } from "@/stores/workspaces";
import type { AgentType, TerminalStatus } from "@/lib/bindings";

/** One session, as the model is told about it. */
export interface RocRosterEntry {
  /** The pane's chat name — `Rocky`. This is the handle the model must use,
   *  and the handle `rocTargets` resolves back into a pane. */
  name: string;
  agentType: AgentType;
  /** The workspace's NAME, not its id: the model is being asked to reason
   *  about "the frontend one", and an id means nothing to it. */
  workspace: string;
  status: TerminalStatus;
  /** The pane's project directory, when it has one. */
  cwd: string | null;
}

/** One agent, and the instruction meant for it. */
export interface RocAssignment {
  /** A `name` from the roster. */
  name: string;
  /** The whole instruction, written to stand on its own — the agent never sees
   *  the request it came from. */
  prompt: string;
}

/** What one reasoning turn produced. */
export interface RocPlanReply {
  /** One sentence for the user. Rendered, and spoken. */
  reply: string;
  /** Possibly none: a question about what is happening is answered, not
   *  dispatched. */
  assignments: RocAssignment[];
}

/** Every session Roc can address, described for the model.
 *
 *  Built from the same list `resolveTargets` addresses (`addressablePanes`), so
 *  a name the model is offered is by construction a name that can be resolved
 *  back into a pane. Two lists that agreed today and drifted tomorrow would
 *  show up as an agent that exists in the roster and cannot be sent to. */
export function rocRoster(): RocRosterEntry[] {
  const workspaces = useWorkspacesStore.getState().workspaces;
  const nameOf = new Map(workspaces.map((w) => [w.id, w.name]));
  return addressablePanes().map((session) => ({
    name: session.name,
    agentType: session.agentConfig.type,
    workspace: nameOf.get(session.workspaceId) ?? "unknown workspace",
    status: session.status,
    cwd: session.projectPath === "" ? null : session.projectPath,
  }));
}

// The persona ----------------------------------------------------------------
//
// A persona is a tone instruction on ONE field, and the discipline is the whole
// feature: it shapes `reply` — the sentence a person reads and hears — and it
// must not touch a single assignment prompt. An agent addressed in character is
// a worse agent. It is a command-line coding tool being handed a task, and
// "Rocky, if you would be so kind" is noise in front of the instruction it has
// to act on; worse, a model that has been given a voice tends to use it
// everywhere it is allowed to write prose.
//
// One constant per persona, listed in `PERSONA_REPLY_RULES`, so a third one is
// a data change here plus an entry in `ROC_PERSONAS`.
//
// TWO of the rules are not the persona's to choose, and every constant below
// carries both in its own words: the reply says what was DONE rather than what
// is about to happen, and it stays under 200 characters. Neither is decoration.
// The tense is the difference between a report and a claim — Roc has dispatched
// the work, it has not watched it finish, and a sentence that has been read
// aloud has no screen to be corrected on. The cap is the only length bound
// there is: "one sentence" is not one, a model will write a 400-character
// sentence when asked for a short one, and Rust truncates at 2 KB — which is
// half a minute of speech. `the rules every persona carries` in the tests holds
// both personas to both, so a third cannot be added without them.

/** What Roc has always been asked for: a short, ordinary sentence. */
const PLAIN_REPLY_RULES: readonly string[] = [
  "- Keep the reply under 200 characters and say what you did, not what you are",
  "  about to do.",
];

/** Terse, dry, faintly formal — and specific, because "be like a butler" is an
 *  invitation to write a parody. Every line below is a failure this register
 *  falls into on its own: the enthusiasm of a chat assistant, the exclamation
 *  mark, the "sir" on every sentence, and the tone leaking into the work.
 *
 *  And the failure the register invites that the plain one does not: the
 *  finished-job report. A butler announces outcomes, so a model handed only
 *  "Rocky has finished the auth test, sir" as its example will say exactly that
 *  about a turn it has this second dispatched. Hence the tense rule, and hence
 *  TWO examples — the just-dispatched one first, because that is nearly every
 *  turn. */
const BUTLER_REPLY_RULES: readonly string[] = [
  "- The reply is spoken by a butler: at most one sentence, understated and dry,",
  "  and under 200 characters like every other reply.",
  "- State what has happened and what you did about it. Nothing else — and what",
  "  you did, not what you are about to do. Sending an agent its instruction is",
  "  not the same as that work being finished: report a job done only when you",
  "  have been told it is done.",
  "- No exclamation marks, and no enthusiasm: no “Great”, no “Sure thing”, no",
  "  “Happy to help”, no praising the request back at the person.",
  '- You may address the person as "sir", but sparingly — roughly one reply in',
  "  three, never every line.",
  '- This is the register for a turn you have just dispatched: "Rocky has it,',
  '  sir." And for work you have been told is finished: "Rocky has finished the',
  '  auth test, sir — two files changed." This is not, ever: "Great news! I sent',
  '  that to Rocky!"',
  '- The persona governs the "reply" field and NOTHING else. Every prompt in',
  '  "assignments" stays a plain instruction to a command-line coding agent:',
  "  no persona, no form of address, no flourish. An agent spoken to in",
  "  character is a worse agent.",
];

const PERSONA_REPLY_RULES: Record<RocPersona, readonly string[]> = {
  plain: PLAIN_REPLY_RULES,
  butler: BUTLER_REPLY_RULES,
};

/** The whole instruction the CLI is given.
 *
 *  Explicit to the point of being blunt, because every rule here is a failure
 *  mode with a cost: an invented name is a dispatch that goes nowhere (or,
 *  worse, somewhere), a missing `reply` is a turn with nothing to say or speak,
 *  and prose around the JSON is a parse that has to guess. The parser tolerates
 *  the last one anyway — asking clearly is cheaper than recovering.
 *
 *  `persona` is the LAST thing in the prompt and the only thing that varies
 *  with it: every persona gets the same roster, the same JSON contract, the
 *  same naming rule and the same instruction about what an agent is sent. */
export function buildBrainPrompt(
  request: string,
  roster: readonly RocRosterEntry[],
  persona: RocPersona,
): string {
  const sessions =
    roster.length === 0
      ? "There are no agent sessions open right now."
      : roster
          .map(
            (entry) =>
              `- "${entry.name}" — ${entry.agentType}, in workspace "${entry.workspace}", ` +
              `status ${entry.status}${entry.cwd ? `, working in ${entry.cwd}` : ""}`,
          )
          .join("\n");

  return [
    "You are Roc, the orchestrator inside RocSpace, a desktop app where a person",
    "runs several coding agents side by side and talks to them out loud.",
    "",
    "These are the agent sessions open right now:",
    sessions,
    "",
    "The person just said:",
    request,
    "",
    "Answer with ONLY a JSON object, no code fence and no commentary:",
    '{"reply": "<one sentence for the person, which will be read aloud>",',
    ' "assignments": [{"name": "<a session name>", "prompt": "<the full instruction for that agent>"}]}',
    "",
    "Rules:",
    "- Use only the session names listed above, spelled exactly as written.",
    "  Never invent a name. If the person named somebody who is not open, say so",
    "  in the reply and leave them out of the assignments.",
    '- An empty "assignments" list is a perfectly good answer. A question about',
    "  what is happening deserves a reply and no work.",
    "- Write each prompt as a complete instruction the agent can act on without",
    "  seeing this conversation: it is pasted straight into that agent's terminal.",
    ...PERSONA_REPLY_RULES[persona],
  ].join("\n");
}

/** Everything from the first `{` that opens a complete object, respecting
 *  strings — a prompt is prose, and prose has braces in it. */
function jsonObjectsIn(raw: string): string[] {
  const found: string[] = [];
  for (let start = 0; start < raw.length; start++) {
    if (raw[start] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < raw.length; i++) {
      const ch = raw[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          found.push(raw.slice(start, i + 1));
          // Whatever is nested inside this one is part of it, so the next
          // candidate starts after it.
          start = i;
          break;
        }
      }
    }
  }
  return found;
}

const asText = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

function readPlan(value: unknown): RocPlanReply | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const hasReply = typeof record.reply === "string";
  const hasAssignments = Array.isArray(record.assignments);
  // Neither half: this is some other object that happened to be in the answer.
  if (!hasReply && !hasAssignments) return null;

  const assignments = (
    hasAssignments ? (record.assignments as unknown[]) : []
  ).flatMap((raw) => {
    if (typeof raw !== "object" || raw === null) return [];
    const entry = raw as Record<string, unknown>;
    const name = asText(entry.name);
    const prompt = asText(entry.prompt);
    // Half an assignment is not one: a name with nothing to say would dispatch
    // an empty message, and a prompt with no name has nowhere to go.
    return name === "" || prompt === "" ? [] : [{ name, prompt }];
  });

  return { reply: asText(record.reply), assignments };
}

/** The model's answer, as a plan.
 *
 *  Tolerant of a fenced block and of prose on either side, because those are
 *  the two things a language model does with "answer with only JSON" — and
 *  strict about everything after that. Throws when there is no plan in the
 *  answer at all; the caller turns that into a `brainError`. */
export function parseBrainReply(raw: string): RocPlanReply {
  for (const candidate of jsonObjectsIn(raw)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const plan = readPlan(parsed);
    if (plan) return plan;
  }
  throw new Error(
    `Roc's answer was not a plan: ${raw.trim().slice(0, 200) || "(nothing)"}`,
  );
}

/** Keep the assignments whose agent exists; hand back the names that do not.
 *
 *  Case-insensitive, and the roster's own spelling wins, so "rocky" reaches
 *  Rocky and the log reads the way the rail does. */
export function knownAssignments(
  assignments: readonly RocAssignment[],
  roster: readonly RocRosterEntry[],
): { assignments: RocAssignment[]; unknown: string[] } {
  const byLower = new Map(
    roster.map((entry) => [entry.name.toLowerCase(), entry.name]),
  );
  const kept: RocAssignment[] = [];
  const unknown: string[] = [];
  for (const assignment of assignments) {
    const real = byLower.get(assignment.name.toLowerCase());
    if (real === undefined) {
      if (!unknown.includes(assignment.name)) unknown.push(assignment.name);
      continue;
    }
    kept.push({ name: real, prompt: assignment.prompt });
  }
  return { assignments: kept, unknown };
}

/** Phases a thought must not take the orb away from. Same rule, and the same
 *  reason, as the fan-out's: the microphone being open is the user's half of the
 *  conversation and outranks anything the app is doing about a sentence that has
 *  already been said. A delivery still in flight outranks it too — the message
 *  is on its way, and that is the more urgent truth about the app. */
const THINKING_YIELDS_TO: readonly RocPhase[] = ["listening", "dispatching"];

/** …and what SPEECH yields to, which is the microphone and nothing else.
 *
 *  It used to yield to "dispatching" as well, and that was the bug: with
 *  auto-dispatch on, the fan-out starts before the reply is spoken and stamps
 *  "dispatching" synchronously, so the speech declined the phase, no Stop button
 *  was ever drawn, and the reply read itself out with no way to interrupt it.
 *  The same thing happened on the manual path whenever an earlier fan-out was
 *  still waiting on a busy pane.
 *
 *  So the ownership is the other way round, and `rocDispatch.HOLDS_THE_ORB`
 *  agrees from its side: while Roc is talking, that is what the orb says and
 *  what the button offers. The fan-out gets the orb back the moment the voice
 *  stops — see `endSpeechPhase`. */
const SPEECH_YIELDS_TO: readonly RocPhase[] = ["listening"];

function releasePhase(): void {
  const roc = useRocStore.getState();
  if (roc.phase === "thinking") roc.setPhase("idle");
}

const toast = (message: string): void => {
  useToastsStore.getState().push({ message, tone: "warn" });
};

const messageOf = (err: unknown): string => {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  return String(err);
};

/** Think about what was said, and come back with a plan — or with null and a
 *  `brainError` nobody has to go looking for.
 *
 *  The reply is put in the store on the way out rather than left to the caller:
 *  two surfaces render it (the stage and the widget) and one of them may not be
 *  mounted, so the turn cannot depend on whoever started it still being there. */
export async function runRocBrain(
  request: string,
): Promise<RocPlanReply | null> {
  const text = request.trim();
  if (text === "") return null;

  const roc = useRocStore.getState();
  roc.setBrainError(null);
  roc.setReply(null);
  // Only ever take a phase that is ours to take — see `THINKING_YIELDS_TO`.
  if (!THINKING_YIELDS_TO.includes(roc.phase)) roc.setPhase("thinking");

  const roster = rocRoster();
  try {
    const { brainModel, persona } = useSettingsStore.getState().roc;
    const result: RocThinkResult = await commands.rocThink(
      buildBrainPrompt(text, roster, persona),
      brainModel === "" ? null : brainModel,
    );
    // Rust rejects a failed turn rather than resolving with one, so this is
    // belt and braces — and cheaper than the alternative, which is routing an
    // error message into somebody's agent.
    if (result.isError) {
      throw new Error(result.text || "Roc's brain could not answer");
    }

    const parsed = parseBrainReply(result.text);
    const { assignments, unknown } = knownAssignments(
      parsed.assignments,
      roster,
    );
    if (unknown.length > 0) {
      toast(
        `Roc named ${unknown.join(", ")}, which ${
          unknown.length === 1 ? "is not a session" : "are not sessions"
        } — that part was dropped`,
      );
    }
    const plan: RocPlanReply = { reply: parsed.reply, assignments };
    useRocStore.getState().setReply(plan.reply === "" ? null : plan.reply);
    return plan;
  } catch (err) {
    const message = messageOf(err);
    console.warn("[roc] brain failed:", err);
    useRocStore.getState().setBrainError(message);
    // On screen AND out loud: this is the failure the phase's exit criteria
    // call unmissable, and the stage may not even be open.
    toast(message);
    return null;
  } finally {
    releasePhase();
  }
}

// Saying it out loud ---------------------------------------------------------

/** Say a reply, and hold the orb for exactly as long as it takes.
 *
 *  Resolves when the speech ENDS, because `roc_speak` does — which is what
 *  makes "speaking" a phase with a real duration rather than a flicker, and
 *  what makes Stop end it immediately.
 *
 *  Silent when the setting is off, when there is nothing to say, and off macOS
 *  (Rust no-ops there). A voice that fails is a warning in the console and
 *  nothing else: the reply is already on screen, and a modal about a
 *  synthesizer would be worse than the silence it is reporting. */
export async function speakRocReply(text: string): Promise<void> {
  const { speakReplies, speechVoice, speechRate } =
    useSettingsStore.getState().roc;
  const spoken = text.trim();
  if (!speakReplies || spoken === "") return;

  const speech = beginSpeechPhase();
  try {
    await commands.rocSpeak(
      spoken,
      speechVoice === "" ? null : speechVoice,
      speechRate,
    );
  } catch (err) {
    console.warn("[roc] could not speak the reply:", err);
  } finally {
    endSpeechPhase(speech);
  }
}

/** Which speech now owns the "speaking" phase.
 *
 *  The same generation counter Rust keeps over its one `say` child, for the
 *  same reason: speech REPLACES speech, and the one that was replaced must not
 *  clean up after the one that replaced it. Rust kills the old child, so the
 *  old call resolves — normally, it was not a failure — and its `finally` runs
 *  while the new voice is still going. Without the generation that `finally`
 *  put the orb to sleep mid-sentence: the Stop button vanished with sound still
 *  coming out, and nothing left in the UI could reach it. */
let speechGeneration = 0;

/** Take the orb for a voice that is about to start, and answer with the id
 *  that gives it back.
 *
 *  Every path to `roc_speak` goes through here — a reply and an audition are
 *  the same sound out of the same speaker, and the Stop button cannot govern
 *  one and not the other. */
function beginSpeechPhase(): number {
  const roc = useRocStore.getState();
  if (!SPEECH_YIELDS_TO.includes(roc.phase)) roc.setPhase("speaking");
  speechGeneration += 1;
  return speechGeneration;
}

/** Give the orb back when the voice stops — to whoever is next in line.
 *
 *  Only ever OUR phase, in both senses: not the microphone's, which can open
 *  mid-sentence, and not a later speaker's, which is what `speech` answers. And
 *  not always "idle": speech outranks a fan-out but does not cancel one, so a
 *  delivery that is still waiting on a busy pane takes the orb back rather than
 *  having it put to sleep underneath it. */
function endSpeechPhase(speech: number): void {
  if (speech !== speechGeneration) return;
  releaseSpeechPhase();
}

/** Give the orb back whoever was holding it — for Stop, which has just
 *  silenced every voice there was. */
function releaseSpeechPhase(): void {
  const roc = useRocStore.getState();
  if (roc.phase !== "speaking") return;
  roc.setPhase(rocFanoutsInFlight() ? "dispatching" : "idle");
}

/** One line each persona would really say, for the Audition button.
 *
 *  A DIFFERENT sentence per persona, and that is the whole point of the button:
 *  hearing the same words twice tells you about the voice, which is not what
 *  the persona picker is choosing. These two are the same pair the brain prompt
 *  holds up as the register and the anti-register, so what is auditioned is
 *  what is asked for. */
export const PERSONA_SAMPLES: Record<RocPersona, string> = {
  plain: "Rocky is on the auth test and Roxie has the login form.",
  butler: "Rocky has finished the auth test, sir — two files changed.",
};

/** Speak one sample line in the voice, rate and persona as they stand.
 *
 *  Through `commands.rocSpeak`, which is the same and only speech path the
 *  replies take — so what is heard here is what will be heard then, down to the
 *  one-speaker-at-a-time lock in Rust that makes this interrupt a reply rather
 *  than talk over it.
 *
 *  NOT gated on `speakReplies`: auditioning is how somebody decides whether to
 *  turn that on, and a button that silently did nothing would be the worst
 *  possible answer to "what does this sound like". A failure is a console
 *  warning — the same call from a reply is no louder about it.
 *
 *  It takes the "speaking" phase exactly as a reply does, and that is not
 *  cosmetic: this can be up to eight seconds of speech, it INTERRUPTS whatever
 *  reply was reading (Rust allows one voice), and the phase is what draws the
 *  Stop button. Without it the interrupted reply's own `finally` ended the
 *  phase, the Stop button disappeared, and the audition played on with nothing
 *  in the app that could stop it. */
export async function auditionRocPersona(): Promise<void> {
  const { speechVoice, speechRate, persona } = useSettingsStore.getState().roc;
  const speech = beginSpeechPhase();
  try {
    await commands.rocSpeak(
      PERSONA_SAMPLES[persona],
      speechVoice === "" ? null : speechVoice,
      speechRate,
    );
  } catch (err) {
    console.warn("[roc] could not audition the persona:", err);
  } finally {
    endSpeechPhase(speech);
  }
}

/** Stop whatever is speaking — a reply or an audition. Safe when nothing is. */
export async function stopRocSpeaking(): Promise<void> {
  try {
    await commands.rocStopSpeaking();
  } catch (err) {
    console.warn("[roc] could not stop speaking:", err);
  }
  // The speaker's own `finally` will do this too, a poll later. Doing it here
  // means the button the user just pressed changes the orb NOW — and
  // unconditionally, because Rust has just silenced every generation there was.
  releaseSpeechPhase();
}

// The turn, waiting to be confirmed ------------------------------------------

/** A plan the user has not sent yet.
 *
 *  `request` is what they actually said, kept because it — not any one of the
 *  tailored prompts — is what the log entry for the turn reads back. */
export interface RocPendingPlan {
  request: string;
  assignments: RocAssignment[];
}

interface RocTurnState {
  pending: RocPendingPlan | null;
  /** Is a turn out right now?
   *
   *  Here rather than in a component, because "one turn at a time" is a fact
   *  about the app and not about a button. The stage and the widget are both
   *  mounted at once and each used to keep its own flag, so pressing Ask on one
   *  while the other was thinking spent a second few cents on the same question
   *  — and the second turn's `clearRocPlan` threw away the first turn's plan
   *  before it could be confirmed. */
  asking: boolean;
}

/** Module-level rather than a field on the roc store, the same way
 *  `useRocDispatchStore` is: this is one module's working state, both surfaces
 *  render it, and neither of them owns it. The widget can start a turn with the
 *  Roc view shut, and the plan has to still be there when the view opens. */
const useRocTurnStore = create<RocTurnState>()(
  devtools(() => ({ pending: null, asking: false }), {
    name: "rocTurn",
  }),
);

export const useRocPendingPlan = (): RocPendingPlan | null =>
  useRocTurnStore((s) => s.pending);

/** Is Roc thinking about something already? What both Ask buttons grey
 *  themselves out on — the same answer for both, whichever one started it. */
export const useRocAsking = (): boolean => useRocTurnStore((s) => s.asking);

export const getRocPendingPlan = (): RocPendingPlan | null =>
  useRocTurnStore.getState().pending;

export function clearRocPlan(): void {
  useRocTurnStore.setState({ pending: null });
}

/** Rewrite one assignment's prompt before it goes. The whole reason the plan is
 *  confirmed rather than sent: a model that understood 90% of a sentence
 *  produces a prompt that is 90% right, and fixing the last word is faster than
 *  saying the whole thing again. */
export function editRocAssignment(index: number, prompt: string): void {
  useRocTurnStore.setState((s) => {
    if (!s.pending) return s;
    const assignments = s.pending.assignments.map((a, i) =>
      i === index ? { ...a, prompt } : a,
    );
    return { pending: { ...s.pending, assignments } };
  });
}

/** Take one agent out of the plan. A plan with nothing left in it is no plan. */
export function dropRocAssignment(index: number): void {
  useRocTurnStore.setState((s) => {
    if (!s.pending) return s;
    const assignments = s.pending.assignments.filter((_, i) => i !== index);
    return {
      pending: assignments.length === 0 ? null : { ...s.pending, assignments },
    };
  });
}

// Delivery -------------------------------------------------------------------

/** What a dispatched turn actually reached. */
export interface RocPlanDispatch {
  /** Panes that were written to, by name. */
  sent: string[];
  /** Names in the plan that no longer resolve to a pane — a session closed
   *  between the thought and the confirmation. */
  missing: string[];
}

/** Send each assignment its own prompt, as one turn.
 *
 *  The delivery and the single log record are `dispatchBrainTurn`'s (they are
 *  shared with re-sending one of those records from the log); what belongs here
 *  is the addressing.
 *
 *  Names are re-resolved HERE rather than trusted from the roster the model was
 *  given, because a session can close between the thought and the
 *  confirmation — that is a whole conversation's worth of time — and a target
 *  resolved a minute ago is a target that may not exist. */
export async function dispatchRocAssignments(
  assignments: readonly RocAssignment[],
  request: string,
): Promise<RocPlanDispatch> {
  const jobs: { target: RocTarget; prompt: string }[] = [];
  const missing: string[] = [];
  for (const assignment of assignments) {
    const { targets } = resolveTargets(
      { text: "", explicitNames: [assignment.name], broadcast: false },
      { selectedIds: [], activeWorkspaceOnly: false },
    );
    if (targets.length === 0) {
      if (!missing.includes(assignment.name)) missing.push(assignment.name);
      continue;
    }
    for (const target of targets)
      jobs.push({ target, prompt: assignment.prompt });
  }

  if (missing.length > 0) {
    toast(
      `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not open any more`,
    );
  }
  if (jobs.length === 0) return { sent: [], missing };

  const summary = await dispatchBrainTurn(request, jobs);
  return { sent: summary.sent, missing };
}

// The whole turn -------------------------------------------------------------

/** Ask Roc about `request`: think, answer, speak, and either send or propose.
 *
 *  The one entry point both surfaces use, so the stage and the widget cannot
 *  drift about what a turn IS — which is the mistake this codebase already made
 *  once with `sendRocCommand` and fixed the same way.
 *
 *  With auto-dispatch off (the default) the assignments become a pending plan
 *  for the user to confirm: the brain proposes, the user sends. With it on they
 *  go immediately, and the reply — which is spoken either way — is what says
 *  what happened.
 *
 *  ONE TURN AT A TIME, for the app rather than for a button. Answers null to a
 *  caller that asked while another turn was out — a paid CLI call for a question
 *  that is already being answered, and (worse) a `clearRocPlan` that would throw
 *  away the plan the first turn is about to produce. */
export async function askRoc(request: string): Promise<RocPlanReply | null> {
  if (useRocTurnStore.getState().asking) return null;
  useRocTurnStore.setState({ asking: true });
  try {
    return await runOneTurn(request);
  } finally {
    useRocTurnStore.setState({ asking: false });
  }
}

async function runOneTurn(request: string): Promise<RocPlanReply | null> {
  // Whatever Roc was saying is about to be out of date.
  await stopRocSpeaking();
  clearRocPlan();

  const plan = await runRocBrain(request);
  if (!plan) return null;

  // The voice goes FIRST, and not awaited: the reply is on screen the moment
  // the turn ends, it starts reading itself out immediately, and it owns the
  // orb — so the Stop button is there on both paths. Started after the fan-out
  // (which is what this used to do) it was started into a "dispatching" phase
  // it declined to take, and auto-dispatch read every reply out with no way to
  // interrupt it.
  void speakRocReply(plan.reply);

  const { autoDispatch } = useSettingsStore.getState().roc;
  if (plan.assignments.length > 0) {
    if (autoDispatch) {
      void dispatchRocAssignments(plan.assignments, request.trim());
    } else {
      useRocTurnStore.setState({
        pending: { request: request.trim(), assignments: plan.assignments },
      });
    }
  }
  return plan;
}

/** Test seam: forget the pending plan, and that anybody was asking. Both are
 *  module-global by design (see above), so a suite that left one behind would
 *  show the next suite's stage a plan it never asked for — or refuse its first
 *  turn as a second one. */
export function resetRocBrainState(): void {
  useRocTurnStore.setState({ pending: null, asking: false });
}
