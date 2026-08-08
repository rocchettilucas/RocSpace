/** Roc's brain: the roster it is given, the answer it comes back with, and
 *  what happens to every way that can go wrong. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import { newTerminal, newWorkspace } from "@/lib/factories";
import {
  askRoc,
  auditionRocPersona,
  buildBrainPrompt,
  knownAssignments,
  parseBrainReply,
  resetRocBrainState,
  rocRoster,
  runRocBrain,
  stopRocSpeaking,
  type RocAssignment,
  type RocRosterEntry,
} from "@/lib/rocBrain";
import { dispatchToTargets, resetRocDispatchState } from "@/lib/rocDispatch";
import { useRocStore, type RocTarget } from "@/stores/roc";
import {
  DEFAULT_ROC_SETTINGS,
  ROC_PERSONAS,
  useSettingsStore,
} from "@/stores/settings";
import { useTerminalsStore } from "@/stores/terminals";
import { resetToastsState, useToastsStore } from "@/stores/toasts";
import { useWorkspacesStore } from "@/stores/workspaces";
import type { AgentType, TerminalStatus } from "@/lib/bindings";

let workspaceId = "";

function addPane(
  name: string,
  over: {
    agentType?: AgentType;
    status?: TerminalStatus;
    projectPath?: string;
  } = {},
): void {
  const terminal = newTerminal({
    workspaceId,
    name,
    agentType: over.agentType ?? "claude-code",
    projectPath: over.projectPath ?? "/code/rocspace",
  });
  terminal.status = over.status ?? "idle";
  useTerminalsStore.getState().addTerminal(terminal);
}

const thinkCalls = (): { prompt: string; model: string | null }[] =>
  invoke.mock.calls
    .filter(([cmd]) => cmd === "roc_think")
    .map(([, args]) => args as { prompt: string; model: string | null });

const toastText = () => useToastsStore.getState().items.map((t) => t.message);

/** What `roc_think` resolves with, framed the way Rust does. */
const thought = (text: string) => ({
  text,
  isError: false,
  costUsd: 0.01,
  durationMs: 400,
});

/** The pane, as the fan-out addresses it. */
const paneTarget = (name: string): RocTarget => {
  const pane = Object.values(useTerminalsStore.getState().byId).find(
    (t) => t.name === name,
  )!;
  return {
    terminalId: pane.id,
    name: pane.name,
    workspaceId: pane.workspaceId,
  };
};

/** One turn of the event loop, which is all any of these are waiting for. */
const flush = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
  resetRocDispatchState();
  resetRocBrainState();
  resetToastsState();
  useTerminalsStore.setState({ byId: {} });
  useRocStore.setState({
    phase: "idle",
    transcript: "",
    selectedTerminalIds: [],
    focusedRailTerminalId: null,
    log: [],
    reply: null,
    brainError: null,
  });
  useSettingsStore.setState({ roc: { ...DEFAULT_ROC_SETTINGS } });

  const workspace = newWorkspace({
    name: "frontend",
    projectPath: "/code/rocspace",
    order: 0,
  });
  workspaceId = workspace.id;
  useWorkspacesStore.setState({
    workspaces: [workspace],
    activeWorkspaceId: workspace.id,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

// The roster -----------------------------------------------------------------

describe("the roster", () => {
  it("describes every open session the way the model will be asked about it", () => {
    addPane("Rocky", { status: "running", projectPath: "/code/app" });
    addPane("Roxie", { agentType: "codex", status: "awaiting_approval" });

    const roster = rocRoster();

    expect(roster).toEqual([
      {
        name: "Rocky",
        agentType: "claude-code",
        workspace: "frontend",
        status: "running",
        cwd: "/code/app",
      },
      {
        name: "Roxie",
        agentType: "codex",
        workspace: "frontend",
        status: "awaiting_approval",
        cwd: "/code/rocspace",
      },
    ]);
  });

  it("is empty when nothing is open", () => {
    expect(rocRoster()).toEqual([]);
  });
});

// The prompt -----------------------------------------------------------------

describe("buildBrainPrompt", () => {
  const roster: RocRosterEntry[] = [
    {
      name: "Rocky",
      agentType: "claude-code",
      workspace: "frontend",
      status: "idle",
      cwd: "/code/app",
    },
    {
      name: "Roxie",
      agentType: "codex",
      workspace: "backend",
      status: "running",
      cwd: null,
    },
  ];

  it("carries the request and every name, quoted", () => {
    const prompt = buildBrainPrompt("fix the auth test", roster, "plain");

    expect(prompt).toContain("fix the auth test");
    expect(prompt).toContain('"Rocky"');
    expect(prompt).toContain('"Roxie"');
    expect(prompt).toContain("claude-code");
    expect(prompt).toContain("backend");
  });

  it("states the contract the parser then relies on, whichever persona", () => {
    for (const persona of ROC_PERSONAS) {
      const prompt = buildBrainPrompt(
        "what is everyone doing?",
        roster,
        persona,
      );

      expect(prompt).toContain('"reply"');
      expect(prompt).toContain('"assignments"');
      // The two rules a wrong answer breaks: inventing a name, and answering a
      // question with work nobody asked for.
      expect(prompt.toLowerCase()).toContain("exactly as written");
      expect(prompt.toLowerCase()).toContain("empty");
    }
  });

  it("says plainly when there is nobody to address", () => {
    const prompt = buildBrainPrompt("ask Rocky to deploy", [], "plain");
    expect(prompt.toLowerCase()).toContain("no agent sessions");
  });
});

// The persona ----------------------------------------------------------------
//
// A persona is a tone instruction on ONE field. The tests that matter here are
// the two halves of that sentence: that the butler's register actually reaches
// the reply, and that it reaches nothing else.

describe("the persona", () => {
  const roster: RocRosterEntry[] = [
    {
      name: "Rocky",
      agentType: "claude-code",
      workspace: "frontend",
      status: "idle",
      cwd: "/code/app",
    },
  ];

  /** The instruction that governs what an AGENT is sent. Byte-identical in
   *  every persona, and asserted that way below. */
  const AGENT_RULE =
    "- Write each prompt as a complete instruction the agent can act on without";

  it("leaves the plain persona saying exactly what it said before", () => {
    const prompt = buildBrainPrompt("ask Rocky to deploy", roster, "plain");

    expect(prompt).toContain("Keep the reply under 200 characters");
    // Nothing of the other persona leaks into the one that did not ask for it.
    expect(prompt.toLowerCase()).not.toContain("sir");
    expect(prompt.toLowerCase()).not.toContain("butler");
  });

  it("asks the butler for one understated sentence and no enthusiasm", () => {
    const prompt = buildBrainPrompt("ask Rocky to deploy", roster, "butler");
    const lower = prompt.toLowerCase();

    expect(lower).toContain("one sentence");
    expect(lower).toContain("exclamation");
    expect(lower).toContain("understated");
    // Sparingly — a "sir" on every line is a parody, not a butler.
    expect(lower).toContain("sparingly");
    expect(prompt).toContain('"sir"');
  });

  // The rule this whole feature turns on. An agent addressed in character is a
  // worse agent: it is a CLI being handed a task, and "Rocky, if you would be
  // so kind" is noise in front of the instruction it has to act on.
  it("shapes the reply and never what an agent is sent", () => {
    const butler = buildBrainPrompt("ask Rocky to deploy", roster, "butler");
    const plain = buildBrainPrompt("ask Rocky to deploy", roster, "plain");

    expect(butler).toContain(AGENT_RULE);
    expect(plain).toContain(AGENT_RULE);
    // …and the butler is told so in as many words, because the tone is in the
    // same prompt as the assignments and a model will happily apply it twice.
    expect(butler).toContain('"assignments"');
    expect(butler.toLowerCase()).toContain("plain instruction");
    expect(butler.toLowerCase()).toContain("no persona");
  });

  it("changes only the reply rules between personas", () => {
    const butler = buildBrainPrompt("ask Rocky to deploy", roster, "butler");
    const plain = buildBrainPrompt("ask Rocky to deploy", roster, "plain");

    // Everything above the reply rules — the roster, the request, the JSON
    // contract, the naming rule — is one shared prompt.
    const shared = plain.slice(0, plain.indexOf("- Keep the reply"));
    expect(shared.length).toBeGreaterThan(0);
    expect(butler.startsWith(shared)).toBe(true);
  });

  /** The rules are wrapped at 80 columns; a rule split over two lines is still
   *  one rule, and the assertions below are about the sentence rather than the
   *  layout. */
  const unwrapped = (prompt: string) => prompt.replace(/\n\s+/g, " ");

  // Not a style preference: these are the two constraints a persona is not
  // entitled to drop, and this test is what stops a third one from dropping
  // them. Written as the same words in every persona on purpose — the
  // constraint is identical, only the register around it differs.
  describe("the rules every persona carries", () => {
    it("tells every persona to say what it DID, not what it is about to do", () => {
      for (const persona of ROC_PERSONAS) {
        const prompt = unwrapped(
          buildBrainPrompt("fix the auth test", roster, persona),
        );
        // The truthfulness rule. Roc has dispatched the work, not watched it
        // finish, and "Rocky has finished the auth test" about a turn that was
        // sent a second ago is a completion that never happened — spoken, with
        // nothing on screen to contradict it.
        expect(prompt).toContain("not what you are about to do");
      }
    });

    it("bounds the length of every persona's reply, in characters", () => {
      for (const persona of ROC_PERSONAS) {
        const prompt = unwrapped(
          buildBrainPrompt("fix the auth test", roster, persona),
        );
        // "One sentence" is not a length: a model will happily write a
        // 400-character one, `say` reads all of it, and Rust's own limit is
        // 2 KB — half a minute of speech nobody asked for.
        expect(prompt).toContain("under 200 characters");
      }
    });
  });
});

// The answer -----------------------------------------------------------------

describe("parseBrainReply", () => {
  it("reads the bare object the contract asks for", () => {
    const plan = parseBrainReply(
      '{"reply":"On it.","assignments":[{"name":"Rocky","prompt":"fix the auth test"}]}',
    );

    expect(plan).toEqual({
      reply: "On it.",
      assignments: [{ name: "Rocky", prompt: "fix the auth test" }],
    });
  });

  it("reads it out of a fenced block", () => {
    const plan = parseBrainReply(
      'Here you go:\n```json\n{"reply":"Done.","assignments":[]}\n```\nHope that helps.',
    );

    expect(plan.reply).toBe("Done.");
    expect(plan.assignments).toEqual([]);
  });

  it("reads it out of surrounding prose", () => {
    const plan = parseBrainReply(
      'Sure — {"reply":"Told Rocky.","assignments":[]} — anything else?',
    );

    expect(plan.reply).toBe("Told Rocky.");
  });

  // A prompt is prose, and prose has braces in it. Scanning for the last `}`
  // in the string would swallow the rest of the answer; stopping at the first
  // one would cut the object in half.
  it("is not fooled by braces around it or inside the prompts", () => {
    const plan = parseBrainReply(
      "Note: use {} for an empty map. " +
        '{"reply":"ok","assignments":[{"name":"Rocky","prompt":"replace {} with a map"}]}' +
        " Anything else? {",
    );

    expect(plan.reply).toBe("ok");
    expect(plan.assignments[0]?.prompt).toBe("replace {} with a map");
  });

  it("takes a reply with no assignments as a perfectly good answer", () => {
    const plan = parseBrainReply('{"reply":"Rocky is running the tests."}');

    expect(plan.reply).toBe("Rocky is running the tests.");
    expect(plan.assignments).toEqual([]);
  });

  it("drops an assignment that is missing half of itself", () => {
    const plan = parseBrainReply(
      '{"reply":"ok","assignments":[{"name":"Rocky"},{"prompt":"do it"},{"name":"Roxie","prompt":"ship it"}]}',
    );

    expect(plan.assignments).toEqual([{ name: "Roxie", prompt: "ship it" }]);
  });

  it("trims what it keeps", () => {
    const plan = parseBrainReply(
      '{"reply":"  On it.  ","assignments":[{"name":" Rocky ","prompt":"  ship it  "}]}',
    );

    expect(plan.reply).toBe("On it.");
    expect(plan.assignments).toEqual([{ name: "Rocky", prompt: "ship it" }]);
  });

  it("refuses an answer with no JSON in it at all", () => {
    expect(() => parseBrainReply("I could not do that.")).toThrow();
  });

  it("refuses an answer that is neither a reply nor a plan", () => {
    expect(() => parseBrainReply('{"something":"else"}')).toThrow();
  });
});

// Names ----------------------------------------------------------------------

describe("knownAssignments", () => {
  const roster: RocRosterEntry[] = [
    {
      name: "Rocky",
      agentType: "claude-code",
      workspace: "frontend",
      status: "idle",
      cwd: null,
    },
  ];

  it("matches a name however it was capitalized, and answers in the roster's spelling", () => {
    const { assignments, unknown } = knownAssignments(
      [{ name: "rocky", prompt: "ship it" }],
      roster,
    );

    expect(assignments).toEqual([{ name: "Rocky", prompt: "ship it" }]);
    expect(unknown).toEqual([]);
  });

  // The exit criterion: a name the model invented is REPORTED, not dispatched.
  it("hands back a name nothing matches rather than sending to it", () => {
    const { assignments, unknown } = knownAssignments(
      [
        { name: "Rocky", prompt: "ship it" },
        { name: "Ghost", prompt: "deploy staging" },
      ],
      roster,
    );

    expect(assignments).toEqual([{ name: "Rocky", prompt: "ship it" }]);
    expect(unknown).toEqual(["Ghost"]);
  });
});

// The turn -------------------------------------------------------------------

describe("runRocBrain", () => {
  it("thinks, parses, and comes back with a plan", async () => {
    addPane("Rocky");
    addPane("Roxie");
    invoke.mockResolvedValue(
      thought(
        '{"reply":"Rocky is on the auth test and Roxie has the login form.",' +
          '"assignments":[{"name":"Rocky","prompt":"Fix the failing auth test."},' +
          '{"name":"Roxie","prompt":"Update the login form."}]}',
      ),
    );

    const plan = await runRocBrain(
      "ask Rocky to fix the failing auth test and have Roxie update the login form",
    );

    expect(plan?.assignments.map((a) => a.name)).toEqual(["Rocky", "Roxie"]);
    expect(useRocStore.getState().reply).toBe(
      "Rocky is on the auth test and Roxie has the login form.",
    );
    expect(useRocStore.getState().brainError).toBeNull();
    // The phase is given back — a brain that left the orb spinning would be
    // the Phase 4 bug this replaces.
    expect(useRocStore.getState().phase).toBe("idle");
  });

  it("sends the roster and the configured model to the CLI", async () => {
    addPane("Rocky");
    useSettingsStore.getState().setRocOption("brainModel", "claude-sonnet-4-6");
    invoke.mockResolvedValue(thought('{"reply":"ok","assignments":[]}'));

    await runRocBrain("what is everyone doing?");

    const [call] = thinkCalls();
    expect(call?.model).toBe("claude-sonnet-4-6");
    expect(call?.prompt).toContain('"Rocky"');
    expect(call?.prompt).toContain("what is everyone doing?");
  });

  it("asks in the persona the user chose", async () => {
    addPane("Rocky");
    invoke.mockResolvedValue(thought('{"reply":"ok","assignments":[]}'));

    await runRocBrain("what is everyone doing?");
    expect(thinkCalls()[0]?.prompt.toLowerCase()).not.toContain("understated");

    useSettingsStore.getState().setRocOption("persona", "butler");
    await runRocBrain("what is everyone doing?");
    expect(thinkCalls()[1]?.prompt.toLowerCase()).toContain("understated");
  });

  it("answers a question with a reply and no work", async () => {
    addPane("Rocky");
    invoke.mockResolvedValue(
      thought('{"reply":"Rocky is running the tests.","assignments":[]}'),
    );

    const plan = await runRocBrain("what is everyone doing?");

    expect(plan?.assignments).toEqual([]);
    expect(plan?.reply).toBe("Rocky is running the tests.");
  });

  // The failure that has to be unmissable: no CLI, no thought, and a sentence
  // on screen saying so.
  it("turns a missing CLI into a brain error, out loud", async () => {
    addPane("Rocky");
    invoke.mockRejectedValue("Claude Code CLI not found. Install it (…)");

    const plan = await runRocBrain("ask Rocky to deploy");

    expect(plan).toBeNull();
    expect(useRocStore.getState().brainError).toContain("not found");
    expect(toastText().join(" ")).toContain("not found");
    expect(useRocStore.getState().phase).toBe("idle");
  });

  it("turns an answer it cannot parse into a brain error rather than silence", async () => {
    addPane("Rocky");
    invoke.mockResolvedValue(thought("I think you should ask Rocky yourself."));

    const plan = await runRocBrain("ask Rocky to deploy");

    expect(plan).toBeNull();
    expect(useRocStore.getState().brainError).not.toBeNull();
  });

  it("reports a name it does not know instead of dispatching to it", async () => {
    addPane("Rocky");
    invoke.mockResolvedValue(
      thought(
        '{"reply":"On it.","assignments":[{"name":"Rocky","prompt":"deploy"},' +
          '{"name":"Ghost","prompt":"deploy staging"}]}',
      ),
    );

    const plan = await runRocBrain("ask everyone to deploy");

    expect(plan?.assignments.map((a) => a.name)).toEqual(["Rocky"]);
    expect(toastText().join(" ")).toContain("Ghost");
  });

  it("does not spend a turn on an empty request", async () => {
    const plan = await runRocBrain("   ");

    expect(plan).toBeNull();
    expect(thinkCalls()).toEqual([]);
  });

  // The microphone outranks the conversation: a thought that finishes while the
  // user is already saying the next thing must not put the orb to sleep.
  it("does not take the phase back from a microphone that opened mid-thought", async () => {
    addPane("Rocky");
    invoke.mockImplementation(async () => {
      useRocStore.getState().setPhase("listening");
      return thought('{"reply":"ok","assignments":[]}');
    });

    await runRocBrain("ask Rocky to deploy");

    expect(useRocStore.getState().phase).toBe("listening");
  });
});

// One turn at a time ----------------------------------------------------------

/** The guard used to be a `useState` in each of the two surfaces — and both are
 *  mounted at once, so pressing the stage's Ask and the widget's sparkle was two
 *  paid CLI calls for one question, with the second turn's `clearRocPlan`
 *  throwing away the plan the first was about to hand over. */
describe("one turn at a time", () => {
  it("refuses a second Ask while the first is still out, whoever pressed it", async () => {
    addPane("Rocky");
    let answer = (_result: unknown): void => {};
    invoke.mockImplementation(async (command: string) => {
      if (command !== "roc_think") return undefined;
      return new Promise((resolve) => {
        answer = resolve;
      });
    });

    const first = askRoc("ask Rocky to fix the auth test");
    await flush();

    expect(await askRoc("ask Rocky to fix the auth test again")).toBeNull();
    expect(thinkCalls()).toHaveLength(1);

    answer(thought('{"reply":"On it.","assignments":[]}'));
    expect(await first).not.toBeNull();

    // …and the turn gives the guard back, or Ask would be dead for the session.
    invoke.mockResolvedValue(
      thought('{"reply":"Still on it.","assignments":[]}'),
    );
    expect(await askRoc("what is everyone doing?")).not.toBeNull();
    expect(thinkCalls()).toHaveLength(2);
  });

  it("gives the guard back when the turn fails", async () => {
    addPane("Rocky");
    invoke.mockRejectedValueOnce("Claude Code CLI not found");

    expect(await askRoc("ask Rocky to deploy")).toBeNull();

    invoke.mockResolvedValue(thought('{"reply":"On it.","assignments":[]}'));
    expect(await askRoc("ask Rocky to deploy")).not.toBeNull();
  });
});

// Who owns the orb while Roc is talking ---------------------------------------

/** The phase a reply is read in is the phase the Stop button renders on, so
 *  "does the speech own the orb" and "can the user stop it" are one question.
 *  It has two answers to get right: the fan-out auto-dispatch starts BEFORE the
 *  voice, and a fan-out from an earlier turn that is still waiting on a busy
 *  pane. Both used to take the phase, and a reply then read itself out with no
 *  way to interrupt it. */
describe("the orb while a reply is being read", () => {
  const plan = (assignments: RocAssignment[]) =>
    thought(JSON.stringify({ reply: "On it.", assignments }));

  /** `roc_think` answers at once; the voice and the PTY write finish when the
   *  test says so, which is what makes the phases observable. */
  function wire(answer: unknown): { speak: () => void; write: () => void } {
    let speakDone = (): void => {};
    let writeDone = (): void => {};
    invoke.mockImplementation(async (command: string) => {
      if (command === "roc_think") return answer;
      if (command === "roc_speak") {
        return new Promise<void>((resolve) => {
          speakDone = resolve;
        });
      }
      if (command === "terminal_write") {
        return new Promise<void>((resolve) => {
          writeDone = resolve;
        });
      }
      return undefined;
    });
    return { speak: () => speakDone(), write: () => writeDone() };
  }

  beforeEach(() => {
    useSettingsStore.getState().setRocOption("speakReplies", true);
  });

  it("speaks over the fan-out auto-dispatch just started", async () => {
    addPane("Rocky");
    useSettingsStore.getState().setRocOption("autoDispatch", true);
    const finish = wire(
      plan([{ name: "Rocky", prompt: "Fix the failing auth test." }]),
    );

    await askRoc("ask Rocky to fix the auth test");

    // Reading it out, with everything that hangs off that phase: the orb, the
    // label, and the Stop button that is the only way to interrupt a reply.
    expect(useRocStore.getState().phase).toBe("speaking");
    expect(
      invoke.mock.calls.filter(([command]) => command === "roc_speak"),
    ).toHaveLength(1);

    // …and the dispatch that is under way does not take it back — not when it
    // reaches the PTY, and not when it finishes.
    await flush();
    expect(useRocStore.getState().phase).toBe("speaking");
    finish.write();
    await flush();
    expect(useRocStore.getState().phase).toBe("speaking");

    finish.speak();
    await flush();
    expect(useRocStore.getState().phase).toBe("idle");
  });

  it("speaks over an earlier fan-out, and hands the orb back to it", async () => {
    addPane("Rocky");
    const finish = wire(plan([]));

    // A message from before this turn, parked in a write that has not landed.
    void dispatchToTargets("earlier message", [paneTarget("Rocky")]);
    await flush();
    expect(useRocStore.getState().phase).toBe("dispatching");

    await askRoc("what is everyone doing?");

    expect(useRocStore.getState().phase).toBe("speaking");

    finish.speak();
    await flush();
    // The earlier message is still going, so the orb goes back to it rather
    // than to sleep on work that is still happening.
    expect(useRocStore.getState().phase).toBe("dispatching");

    finish.write();
    await flush();
    expect(useRocStore.getState().phase).toBe("idle");
  });

  // The microphone still outranks everything: it is the user's half of the
  // conversation, and a reply must not put the orb on itself while somebody is
  // talking to it.
  it("does not take the orb from an open microphone", async () => {
    addPane("Rocky");
    const finish = wire(plan([]));
    useRocStore.getState().setPhase("listening");

    await askRoc("what is everyone doing?");

    expect(useRocStore.getState().phase).toBe("listening");
    finish.speak();
    await flush();
    expect(useRocStore.getState().phase).toBe("listening");
  });
});

// The same question about the Audition button ---------------------------------

/** An audition is sound out of the same speaker, up to eight seconds of it, and
 *  Rust allows exactly one voice — so pressing it mid-reply KILLS the reply.
 *  Everything below is about the orb surviving that handover: the phase draws
 *  the Stop button, and an audition nothing can stop is worse than a reply
 *  nothing can stop, because nothing on screen even says it is playing. */
describe("the orb while an audition is playing", () => {
  /** A resolver per `roc_speak`, because the case that matters has two of them
   *  in flight: the reply that was interrupted, and the audition that did it. */
  function wireSpeech(): {
    speakers: (() => void)[];
    thought: (answer: unknown) => void;
  } {
    const speakers: (() => void)[] = [];
    let answer: unknown = thought('{"reply":"On it.","assignments":[]}');
    invoke.mockImplementation(async (command: string) => {
      if (command === "roc_think") return answer;
      if (command === "roc_speak")
        return new Promise<void>((resolve) => {
          speakers.push(resolve);
        });
      return undefined;
    });
    return {
      speakers,
      thought: (next) => {
        answer = next;
      },
    };
  }

  beforeEach(() => {
    useSettingsStore.getState().setRocOption("speakReplies", true);
  });

  it("holds the orb for as long as the sample is playing", async () => {
    const { speakers } = wireSpeech();

    const audition = auditionRocPersona();
    await flush();

    // The phase the Stop button renders on. An audition without it is a voice
    // with no control over it anywhere in the app.
    expect(useRocStore.getState().phase).toBe("speaking");

    speakers[0]();
    await audition;
    expect(useRocStore.getState().phase).toBe("idle");
  });

  // The regression this exists for. Rust kills the reply to make room for the
  // audition, so the reply's call RESOLVES — it was replaced, not failed — and
  // its `finally` used to end the phase while the sample was still playing.
  it("keeps the orb when it interrupts a reply, until the sample ends", async () => {
    const { speakers } = wireSpeech();

    void askRoc("what is everyone doing?");
    await flush();
    expect(useRocStore.getState().phase).toBe("speaking");

    const audition = auditionRocPersona();
    await flush();
    expect(speakers).toHaveLength(2);

    // Rust has killed the reply's `say`; the reply's promise comes back.
    speakers[0]();
    await flush();
    // Still speaking, because something still IS.
    expect(useRocStore.getState().phase).toBe("speaking");

    speakers[1]();
    await audition;
    expect(useRocStore.getState().phase).toBe("idle");
  });

  it("is stoppable, like anything else Roc says out loud", async () => {
    const { speakers } = wireSpeech();

    const audition = auditionRocPersona();
    await flush();
    expect(useRocStore.getState().phase).toBe("speaking");

    await stopRocSpeaking();
    expect(
      invoke.mock.calls.filter(([command]) => command === "roc_stop_speaking"),
    ).toHaveLength(1);
    // The button the user just pressed changes the orb now, not a poll later.
    expect(useRocStore.getState().phase).toBe("idle");

    speakers[0]();
    await audition;
    expect(useRocStore.getState().phase).toBe("idle");
  });

  // The microphone outranks an audition for the same reason it outranks a
  // reply: it is the user's half of the conversation.
  it("does not take the orb from an open microphone", async () => {
    const { speakers } = wireSpeech();
    useRocStore.getState().setPhase("listening");

    const audition = auditionRocPersona();
    await flush();
    expect(useRocStore.getState().phase).toBe("listening");

    speakers[0]();
    await audition;
    expect(useRocStore.getState().phase).toBe("listening");
  });
});
