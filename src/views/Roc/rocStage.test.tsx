/** The command bar's answer to "who would this reach" — the @-token feedback,
 *  resolved live against the panes that are actually open — and what happens
 *  when the user presses Enter on it. */

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const terminalWrite = vi.fn(async (_terminalId: string, _data: string) => {});
const rocThink = vi.fn(async (_prompt: string, _model: string | null) => ({
  text: '{"reply":"On it.","assignments":[]}',
  isError: false,
  costUsd: 0.01,
  durationMs: 200,
}));
const rocSpeak = vi.fn(
  async (_text: string, _voice: string | null, _rate: number | null) => {},
);
const rocStopSpeaking = vi.fn(async () => {});
vi.mock("@/lib/bindings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/bindings")>()),
  commands: {
    roctalkDownloadModel: vi.fn(async () => {}),
    terminalWrite: (terminalId: string, data: string) =>
      terminalWrite(terminalId, data),
    rocThink: (prompt: string, model: string | null) => rocThink(prompt, model),
    rocSpeak: (text: string, voice: string | null, rate: number | null) =>
      rocSpeak(text, voice, rate),
    rocStopSpeaking: () => rocStopSpeaking(),
  },
}));

import { newTerminal, newWorkspace } from "@/lib/factories";
import { askRoc, resetRocBrainState } from "@/lib/rocBrain";
import { resetRocDispatchState } from "@/lib/rocDispatch";
import { useRocStore } from "@/stores/roc";
import {
  DEFAULT_ROC_SETTINGS,
  DEFAULT_VOICE_SETTINGS,
  useSettingsStore,
} from "@/stores/settings";
import { useRocTalkStore } from "@/stores/roctalk";
import { useTerminalsStore } from "@/stores/terminals";
import { useToastsStore } from "@/stores/toasts";
import { useUIStore } from "@/stores/ui";
import { useWorkspacesStore } from "@/stores/workspaces";
import { RocWidget } from "@/components/RocWidget";
import { RocStage } from "@/views/Roc/RocStage";

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

function seed() {
  const workspace = newWorkspace({ projectPath: "/proj", order: 0 });
  // Claude panes: they report their own readiness, so a dispatch to an idle one
  // is immediate. A shell would make every send here wait out the quiet second,
  // which is `rocDispatch`'s business to test and not this file's.
  const make = (name: string) =>
    newTerminal({
      workspaceId: workspace.id,
      name,
      agentType: "claude-code",
      projectPath: "/proj",
    });
  const rocky = make("Rocky");
  const roxie = make("Roxie");
  useTerminalsStore.getState().setTerminals([rocky, roxie]);
  useWorkspacesStore.setState({
    workspaces: [
      {
        ...workspace,
        paneTree: {
          kind: "split",
          direction: "row",
          ratio: 0.5,
          first: { kind: "leaf", terminalId: rocky.id },
          second: { kind: "leaf", terminalId: roxie.id },
        },
      },
    ],
    activeWorkspaceId: workspace.id,
  });
  return { rocky, roxie };
}

beforeEach(() => {
  terminalWrite.mockClear();
  resetRocDispatchState();
  resetRocBrainState();
  rocThink.mockClear();
  rocSpeak.mockClear();
  rocStopSpeaking.mockClear();
  useSettingsStore.setState({
    roc: { ...DEFAULT_ROC_SETTINGS },
    voice: { ...DEFAULT_VOICE_SETTINGS },
  });
  useWorkspacesStore.setState({ workspaces: [], activeWorkspaceId: null });
  useTerminalsStore.setState({ byId: {} });
  useUIStore.setState({ focusedTerminalId: null });
  useRocStore.setState({
    phase: "idle",
    transcript: "",
    selectedTerminalIds: [],
    focusedRailTerminalId: null,
    log: [],
    reply: null,
    brainError: null,
  });
  useRocTalkStore.setState({
    enabled: true,
    status: "idle",
    modelStatus: "ready",
  });
  useToastsStore.setState({ items: [] });
});

const bar = () => screen.getByLabelText("Message for your agents");

/** The stage IS the orb plus a box you talk in, so the orb's state is the one
 *  thing on this surface that has to come from the right place: two stores
 *  describe the same moment — RocTalk owns the microphone, Roc owns the
 *  conversation — and drawing the wrong one is a user talking at an orb that
 *  stopped listening a second ago. */
describe("the orb on the stage", () => {
  const orb = () => document.querySelector("[data-roc-orb-state]");
  const orbState = () => orb()?.getAttribute("data-roc-orb-state");

  it("is the big one — the thing you are talking to, not a status dot", () => {
    seed();
    render(<RocStage />);

    expect(orb()).toHaveStyle({ width: "160px", height: "160px" });
  });

  it("is idle, and says Ready, when nothing is happening", () => {
    seed();
    render(<RocStage />);

    expect(orbState()).toBe("idle");
    expect(screen.getByText("Ready")).toBeInTheDocument();
  });

  // The microphone's half. `useRocTalk` sets this the moment the key goes
  // down, and it outranks whatever the conversation is doing.
  it("listens from RocTalk's status, and names where the words go", () => {
    const { rocky } = seed();
    useUIStore.setState({ focusedTerminalId: rocky.id });
    render(<RocStage />);

    act(() => {
      useRocStore.getState().setPhase("dispatching");
      useRocTalkStore.getState().setStatus("recording");
    });

    expect(orbState()).toBe("listening");
    expect(
      screen.getByText("Listening — dictating to Rocky"),
    ).toBeInTheDocument();

    act(() => useSettingsStore.getState().setVoiceOption("routeTo", "roc"));
    expect(
      screen.getByText("Listening — Roc is listening"),
    ).toBeInTheDocument();
  });

  // The conversation's half — the phases Roc's brain, its fan-out and its
  // voice take and give back.
  it.each([
    ["thinking", "thinking", "Thinking"],
    ["dispatching", "thinking", "Dispatching"],
    ["speaking", "speaking", "Speaking"],
  ] as const)(
    "draws %s as the orb's %s behaviour, labelled %s",
    (phase, expected, label) => {
      seed();
      render(<RocStage />);

      act(() => useRocStore.getState().setPhase(phase));

      expect(orbState()).toBe(expected);
      expect(screen.getByText(label)).toBeInTheDocument();
    },
  );

  // Whisper is still crunching: the key is up, the microphone is shut, and an
  // orb that kept the listening shape would be inviting the user to keep
  // talking into it.
  it("stops looking like it is listening the moment the key goes up", () => {
    seed();
    render(<RocStage />);

    act(() => useRocTalkStore.getState().setStatus("transcribing"));

    expect(orbState()).toBe("thinking");
    expect(screen.getByText("Thinking")).toBeInTheDocument();
  });
});

/** One conversation, drawn on two surfaces — and said out loud once.
 *
 *  The widget is mounted for the whole session and the stage comes and goes;
 *  both render the phase, the transcript and the reply from the same
 *  `describeRoc` and the same store. With a live region on each, a screen
 *  reader read every one of them twice — six announcements for one
 *  idle → thinking → speaking → idle turn. */
describe("who announces Roc's state", () => {
  const live = (text: string | RegExp) =>
    screen
      .getAllByText(text)
      .filter((el) => el.getAttribute("aria-live") !== null);

  it("leaves the announcing to the widget while the widget is up", () => {
    seed();
    useRocStore.setState({ open: true, reply: "Rocky is idle." });
    render(
      <>
        <RocWidget />
        <RocStage />
      </>,
    );

    // Both surfaces still SHOW all three; exactly one of each is announced.
    expect(screen.getAllByText("Ready").length).toBe(2);
    expect(live("Ready")).toHaveLength(1);
    expect(live("Rocky is idle.")).toHaveLength(1);
    // …and the one that speaks is the widget's, which is the surface that is
    // there whether or not this view is.
    expect(live("Ready")[0]!.closest("[data-roc-widget]")).not.toBeNull();
  });

  // Closing the widget is "not now", not "stop talking to me": the Roc view
  // opens from ⌘⇧R and from the palette with the widget shut, and an orb that
  // is `aria-hidden` beside a label that is not announced says nothing at all.
  it("takes it over when the widget is closed", () => {
    seed();
    useRocStore.setState({ open: false, reply: "Rocky is idle." });
    render(
      <>
        <RocWidget />
        <RocStage />
      </>,
    );

    expect(live("Ready")).toHaveLength(1);
    expect(live("Ready")[0]!.closest("[data-roc-widget]")).toBeNull();
    expect(live("Rocky is idle.")).toHaveLength(1);
  });
});

describe("the command bar's target line", () => {
  it("names the panes an @token resolves to", () => {
    seed();
    render(<RocStage />);

    fireEvent.change(bar(), { target: { value: "@Roxie fix the flake" } });

    expect(screen.getByText(/1 agent: Roxie/i)).toBeInTheDocument();
  });

  it("counts a broadcast", () => {
    seed();
    render(<RocStage />);

    fireEvent.change(bar(), { target: { value: "@all ship it" } });

    expect(screen.getByText(/2 agents: Rocky, Roxie/i)).toBeInTheDocument();
  });

  // Better before the message is sent than after it reached two of three.
  it("calls out a name that matches no pane", () => {
    seed();
    render(<RocStage />);

    fireEvent.change(bar(), { target: { value: "@Ghost hello" } });

    expect(screen.getByText(/no pane called Ghost/i)).toBeInTheDocument();
  });

  it("falls back to the rail's selection when nothing is named", () => {
    const { rocky } = seed();
    useRocStore.getState().selectOnly([rocky.id]);
    render(<RocStage />);

    fireEvent.change(bar(), { target: { value: "run the tests" } });

    expect(screen.getByText(/1 agent: Rocky/i)).toBeInTheDocument();
  });

  it("says there is nobody when there is nobody", () => {
    render(<RocStage />);
    expect(screen.getByText(/no agents — type @name/i)).toBeInTheDocument();
  });

  // The summary was memoized on the draft, the selection and the roster, and
  // the pane a bare message goes to is none of those — it is whoever is
  // focused. Clicking another rail row did not even re-render this stage, so
  // the line went on naming the pane the user had just stopped pointing at.
  it("follows the rail's focus from one row to another", () => {
    const { rocky, roxie } = seed();
    act(() => useRocStore.getState().setFocusedRail(rocky.id));
    render(<RocStage />);
    expect(screen.getByText(/1 agent: Rocky/i)).toBeInTheDocument();

    act(() => useRocStore.getState().setFocusedRail(roxie.id));

    expect(screen.getByText(/1 agent: Roxie/i)).toBeInTheDocument();
  });

  it("follows the dock's focus when the rail has none", () => {
    const { roxie } = seed();
    render(<RocStage />);
    expect(screen.getByText(/no agents — type @name/i)).toBeInTheDocument();

    act(() => useUIStore.setState({ focusedTerminalId: roxie.id }));

    expect(screen.getByText(/1 agent: Roxie/i)).toBeInTheDocument();
  });
});

describe("the composer's Enter", () => {
  const sent = () => terminalWrite.mock.calls.length;

  it("sends on a bare Enter", async () => {
    const { rocky } = seed();
    render(<RocStage />);

    fireEvent.change(bar(), { target: { value: "@Rocky go" } });
    fireEvent.keyDown(bar(), { key: "Enter" });

    await waitFor(() => expect(sent()).toBe(1));
    // The addressing is not part of the message: Rocky gets "go", not a note
    // about somebody called Rocky.
    expect(terminalWrite).toHaveBeenCalledWith(
      rocky.id,
      "\x1b[200~go\x1b[201~\r",
    );
    expect((bar() as HTMLTextAreaElement).value).toBe("");
  });

  it("reaches every pane a broadcast names, at once", async () => {
    const { rocky, roxie } = seed();
    render(<RocStage />);

    fireEvent.change(bar(), { target: { value: "@all ship it" } });
    fireEvent.keyDown(bar(), { key: "Enter" });

    await waitFor(() => expect(sent()).toBe(2));
    expect(terminalWrite.mock.calls.map((c) => c[0]).sort()).toEqual(
      [rocky.id, roxie.id].sort(),
    );
  });

  it("says which name matched nothing, and still sends to the rest", async () => {
    seed();
    render(<RocStage />);

    fireEvent.change(bar(), { target: { value: "@Rocky @Ghost go" } });
    fireEvent.keyDown(bar(), { key: "Enter" });

    await waitFor(() => expect(sent()).toBe(1));
    expect(
      useToastsStore
        .getState()
        .items.map((t) => t.message)
        .join(" "),
    ).toContain("Ghost");
  });

  // Enter cleared the box whatever happened, so a message nothing had received
  // was destroyed by the keystroke that failed to send it — and there is no
  // undo for a textarea the app emptied.
  it("keeps the message when nobody was there to take it", () => {
    seed();
    render(<RocStage />);

    fireEvent.change(bar(), { target: { value: "@Ghost redeploy staging" } });
    fireEvent.keyDown(bar(), { key: "Enter" });

    expect(sent()).toBe(0);
    expect((bar() as HTMLTextAreaElement).value).toBe(
      "@Ghost redeploy staging",
    );
  });

  // …and it said BOTH "the rest still got it" and "nobody to send that to"
  // about the same keystroke. There was no rest.
  it("does not claim a rest got it when nothing did", () => {
    seed();
    render(<RocStage />);

    fireEvent.change(bar(), { target: { value: "@Ghost redeploy staging" } });
    fireEvent.keyDown(bar(), { key: "Enter" });

    const toasts = useToastsStore.getState().items.map((t) => t.message);
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toContain("Ghost");
    expect(toasts[0]).toContain("nothing was sent");
  });

  it("still empties the box when somebody did get it", async () => {
    seed();
    render(<RocStage />);

    fireEvent.change(bar(), { target: { value: "@Rocky @Ghost go" } });
    fireEvent.keyDown(bar(), { key: "Enter" });

    await waitFor(() => expect(sent()).toBe(1));
    expect((bar() as HTMLTextAreaElement).value).toBe("");
    expect(
      useToastsStore
        .getState()
        .items.map((t) => t.message)
        .join(" "),
    ).toContain("the rest still got it");
  });

  // The Enter that accepts an IME candidate is not the Enter that sends. A
  // composer that cannot tell them apart dispatches a half-composed Japanese
  // draft to every agent the bar is pointed at.
  it("does not send the Enter that accepts an IME candidate", () => {
    seed();
    render(<RocStage />);

    fireEvent.change(bar(), { target: { value: "テス" } });
    fireEvent.keyDown(bar(), { key: "Enter", isComposing: true });

    expect(sent()).toBe(0);
    expect((bar() as HTMLTextAreaElement).value).toBe("テス");
  });

  // The other half of the same bug, and the half that costs something: the
  // summary said "Rocky" and Enter wrote into Rocky, seconds after the user
  // clicked Roxie's row. What is delivered has to be what the line says.
  it("delivers to the pane the rail's focus has moved to", async () => {
    const { rocky, roxie } = seed();
    act(() => useRocStore.getState().setFocusedRail(rocky.id));
    render(<RocStage />);

    fireEvent.change(bar(), { target: { value: "run the tests" } });
    act(() => useRocStore.getState().setFocusedRail(roxie.id));
    fireEvent.keyDown(bar(), { key: "Enter" });

    await waitFor(() => expect(sent()).toBe(1));
    expect(terminalWrite).toHaveBeenCalledWith(
      roxie.id,
      "\x1b[200~run the tests\x1b[201~\r",
    );
    expect(terminalWrite).not.toHaveBeenCalledWith(
      rocky.id,
      expect.any(String),
    );
  });

  it("leaves ⇧Enter to the browser, which already inserts the newline", () => {
    // Nothing to assert about the text here — jsdom performs no editing
    // defaults — but the send must not fire, which is this handler's half.
    seed();
    render(<RocStage />);
    fireEvent.change(bar(), { target: { value: "line one" } });

    fireEvent.keyDown(bar(), { key: "Enter", shiftKey: true });

    expect(sent()).toBe(0);
  });

  /** ⌘Enter is documented in Settings › Shortcuts as "start a new line", and
   *  it did nothing: the handler returned early on `metaKey` without
   *  `preventDefault` and without inserting anything, and ⌘Return — unlike
   *  ⇧Return — is not an insertion default in WKWebView. Typed as an
   *  insertion here rather than dropped from the table, because the composer's
   *  own header promises both modifiers and one of them working is a coin
   *  toss on the embedder. */
  it("inserts a newline on ⌘Enter", () => {
    seed();
    render(<RocStage />);
    const box = bar() as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "line one" } });
    box.setSelectionRange(8, 8);

    fireEvent.keyDown(box, { key: "Enter", metaKey: true });

    expect(box.value).toBe("line one\n");
    expect(sent()).toBe(0);
  });

  it("inserts it at the caret, replacing whatever is selected", () => {
    seed();
    render(<RocStage />);
    const box = bar() as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "lineXXone" } });
    box.setSelectionRange(4, 6);

    fireEvent.keyDown(box, { key: "Enter", metaKey: true });

    expect(box.value).toBe("line\none");
    // …and the caret follows it, so the next character lands on the new line.
    expect(box.selectionStart).toBe(5);
  });
});

describe("the transcript", () => {
  it("can be pushed into the bar rather than retyped", () => {
    seed();
    useRocStore.getState().setTranscript("run the failing test again");
    render(<RocStage />);

    fireEvent.click(screen.getByText("Put it in the bar"));

    expect((bar() as HTMLTextAreaElement).value).toBe(
      "run the failing test again",
    );
  });

  // Dictation never dispatches on its own — Whisper mishears, and a fan-out
  // cannot be taken back. The button is the confirmation, and it names who it
  // is about to reach.
  it("goes nowhere until it is confirmed", () => {
    const { rocky } = seed();
    useRocStore.getState().selectOnly([rocky.id]);
    useRocStore.getState().setTranscript("run the failing test again");
    render(<RocStage />);

    expect(terminalWrite).not.toHaveBeenCalled();
    expect(screen.getByText("Send to Rocky")).toBeInTheDocument();
  });

  it("dispatches to the panes it names when it is", async () => {
    const { roxie } = seed();
    useRocStore.getState().setTranscript("@Roxie run the failing test again");
    render(<RocStage />);

    fireEvent.click(screen.getByText("Send to Roxie"));

    await waitFor(() => expect(terminalWrite).toHaveBeenCalledTimes(1));
    expect(terminalWrite).toHaveBeenCalledWith(
      roxie.id,
      "\x1b[200~run the failing test again\x1b[201~\r",
    );
    // …and it is gone from the stage, because it has been acted on.
    expect(useRocStore.getState().transcript).toBe("");
  });

  it("refuses to guess when the transcript names nobody", () => {
    seed();
    useRocStore.getState().setTranscript("ship it");
    render(<RocStage />);

    expect(screen.getByText("Nobody to send it to")).toBeDisabled();
  });

  // Dealing with the transcript deals with the TRANSCRIPT. The phase belongs to
  // whatever took it — the brain while a `claude -p` turn is out, the fan-out
  // while a message is going, the microphone while somebody is talking — and
  // clearing a line of text is none of those. (It used to stamp "idle" over
  // "thinking", which was harmless only while a transcript arriving was what
  // set "thinking" in the first place.)
  it.each([
    ["it is thrown away", "Clear"],
    ["it is moved into the bar", "Put it in the bar"],
  ])(
    "leaves a thought that is still running alone when %s",
    (_label, button) => {
      seed();
      act(() => {
        useRocStore.getState().setTranscript("run the failing test again");
        useRocStore.getState().setPhase("thinking");
      });
      render(<RocStage />);

      fireEvent.click(screen.getByText(button));

      expect(useRocStore.getState().transcript).toBe("");
      expect(useRocStore.getState().phase).toBe("thinking");
    },
  );

  // Same rule from the other side, and the one that was always true: the
  // microphone can open between the transcript landing and the user dealing
  // with it, and nothing here may put the orb to sleep while it is open.
  it("does not put the orb to sleep on a microphone that opened since", () => {
    seed();
    act(() => {
      useRocStore.getState().setTranscript("run the failing test again");
      useRocStore.getState().setPhase("listening");
    });
    render(<RocStage />);

    fireEvent.click(screen.getByText("Clear"));

    expect(useRocStore.getState().phase).toBe("listening");
  });

  it("stops thinking once it has been sent", async () => {
    const { roxie } = seed();
    act(() => {
      useRocStore.getState().setTranscript("@Roxie run the tests");
      useRocStore.getState().setPhase("thinking");
    });
    render(<RocStage />);

    fireEvent.click(screen.getByText("Send to Roxie"));
    await waitFor(() =>
      expect(terminalWrite).toHaveBeenCalledWith(
        roxie.id,
        "\x1b[200~run the tests\x1b[201~\r",
      ),
    );

    await waitFor(() => expect(useRocStore.getState().phase).toBe("idle"));
  });
});

describe("the broadcast button", () => {
  const broadcast = () =>
    screen.getByLabelText("Broadcast to every agent in this workspace");

  // The one target list you cannot describe by typing a name. `@all` does the
  // same thing; this is the version you do not have to know about.
  it("reaches every session in the workspace behind the view", async () => {
    const { rocky, roxie } = seed();
    render(<RocStage />);

    fireEvent.change(bar(), { target: { value: "stand down" } });
    fireEvent.click(broadcast());

    await waitFor(() => expect(terminalWrite).toHaveBeenCalledTimes(2));
    expect(terminalWrite.mock.calls.map((c) => c[0]).sort()).toEqual(
      [rocky.id, roxie.id].sort(),
    );
    expect((bar() as HTMLTextAreaElement).value).toBe("");
  });

  it("ignores who the bar was pointed at, but not what it says", async () => {
    const { rocky, roxie } = seed();
    render(<RocStage />);

    fireEvent.change(bar(), { target: { value: "@Rocky stand down" } });
    fireEvent.click(broadcast());

    await waitFor(() => expect(terminalWrite).toHaveBeenCalledTimes(2));
    // The addressing is stripped either way: both get "stand down".
    for (const id of [rocky.id, roxie.id]) {
      expect(terminalWrite).toHaveBeenCalledWith(
        id,
        "\x1b[200~stand down\x1b[201~\r",
      );
    }
  });

  it("has nothing to offer with an empty box", () => {
    seed();
    render(<RocStage />);
    expect(broadcast()).toBeDisabled();
  });

  it("has nothing to offer with an empty workspace", () => {
    render(<RocStage />);
    fireEvent.change(bar(), { target: { value: "anybody there" } });
    expect(broadcast()).toBeDisabled();
  });
});

describe("the log", () => {
  it("says what it is for while it is empty", () => {
    render(<RocStage />);
    expect(screen.getByText(/click one to send it again/i)).toBeInTheDocument();
  });

  // "Say that again" is the second most common thing anybody does with a
  // message to an agent, after saying it once.
  it("sends an entry again when it is clicked", async () => {
    const { rocky } = seed();
    render(<RocStage />);

    fireEvent.change(bar(), { target: { value: "@Rocky run the tests" } });
    fireEvent.keyDown(bar(), { key: "Enter" });
    await waitFor(() => expect(terminalWrite).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByTitle("Send it again to Rocky"));

    await waitFor(() => expect(terminalWrite).toHaveBeenCalledTimes(2));
    expect(terminalWrite).toHaveBeenLastCalledWith(
      rocky.id,
      "\x1b[200~run the tests\x1b[201~\r",
    );
  });

  // The list was keyed on the timestamp plus the text, and both of those are
  // things two dispatches can share — sending the same words twice inside one
  // millisecond (a double press, or a re-send racing an Enter) gave two rows
  // the same key, which React reports as an error and renders wrong.
  it("keeps two identical messages a millisecond apart from each other", async () => {
    seed();
    const now = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<RocStage />);

    for (const _ of [1, 2]) {
      fireEvent.change(bar(), { target: { value: "@Rocky run the tests" } });
      fireEvent.keyDown(bar(), { key: "Enter" });
      await waitFor(() => expect(bar()).toHaveValue(""));
    }
    await waitFor(() => expect(terminalWrite).toHaveBeenCalledTimes(2));

    expect(screen.getAllByTitle("Send it again to Rocky")).toHaveLength(2);
    expect(errors.mock.calls.flat().join(" ")).not.toMatch(/key/i);
    errors.mockRestore();
    now.mockRestore();
  });

  // The record outlives the ids it was sent to, which is exactly why the
  // contract stores names: a restarted session is a new id with the same name,
  // and it is the pane the user means.
  it("finds a restarted session under the same name", async () => {
    seed();
    render(<RocStage />);

    fireEvent.change(bar(), { target: { value: "@Rocky run the tests" } });
    fireEvent.keyDown(bar(), { key: "Enter" });
    await waitFor(() => expect(terminalWrite).toHaveBeenCalledTimes(1));

    const workspaceId = useWorkspacesStore.getState().activeWorkspaceId!;
    const before = useTerminalsStore.getState();
    const old = Object.values(before.byId).find((t) => t.name === "Rocky")!;
    const again = newTerminal({
      workspaceId,
      name: "Rocky",
      agentType: "claude-code",
      projectPath: "/proj",
    });
    act(() => {
      useTerminalsStore.getState().removeTerminal(old.id);
      useTerminalsStore.getState().addTerminal(again);
    });

    fireEvent.click(screen.getByTitle("Send it again to Rocky"));

    await waitFor(() => expect(terminalWrite).toHaveBeenCalledTimes(2));
    expect(terminalWrite).toHaveBeenLastCalledWith(
      again.id,
      "\x1b[200~run the tests\x1b[201~\r",
    );
  });
});

/** One turn's worth of answer from the CLI. */
const answers = (
  reply: string,
  assignments: { name: string; prompt: string }[],
) =>
  rocThink.mockResolvedValueOnce({
    text: JSON.stringify({ reply, assignments }),
    isError: false,
    costUsd: 0.01,
    durationMs: 200,
  });

/** The bytes a pane actually received. */
const wroteTo = (id: string): string[] =>
  terminalWrite.mock.calls
    .filter(([terminalId]) => terminalId === id)
    .map(([, data]) => data);

describe("asking Roc", () => {
  it("thinks about the transcript rather than pasting it anywhere", async () => {
    seed();
    answers("Rocky is on the auth test and Roxie has the login form.", [
      { name: "Rocky", prompt: "Fix the failing auth test." },
      { name: "Roxie", prompt: "Update the login form." },
    ]);
    useRocStore
      .getState()
      .setTranscript(
        "ask Rocky to fix the failing auth test and have Roxie update the login form",
      );
    render(<RocStage />);

    fireEvent.click(screen.getByText("Ask Roc"));
    await act(async () => {});

    // The reply is on screen…
    expect(
      screen.getByText(
        "Rocky is on the auth test and Roxie has the login form.",
      ),
    ).toBeInTheDocument();
    // …the two agents are named, each with its own instruction…
    expect(screen.getByText("Fix the failing auth test.")).toBeInTheDocument();
    expect(screen.getByText("Update the login form.")).toBeInTheDocument();
    // …and NOTHING has been written to a PTY. The brain proposes.
    expect(terminalWrite).not.toHaveBeenCalled();
  });

  it("sends every assignment its own prompt when the user says so", async () => {
    const { rocky, roxie } = seed();
    answers("On it.", [
      { name: "Rocky", prompt: "Fix the failing auth test." },
      { name: "Roxie", prompt: "Update the login form." },
    ]);
    useRocStore.getState().setTranscript("ask Rocky and Roxie");
    render(<RocStage />);
    fireEvent.click(screen.getByText("Ask Roc"));
    await act(async () => {});

    fireEvent.click(screen.getByText("Send all"));
    await waitFor(() => expect(terminalWrite).toHaveBeenCalledTimes(2));

    expect(wroteTo(rocky.id)).toEqual([
      "\x1b[200~Fix the failing auth test.\x1b[201~\r",
    ]);
    expect(wroteTo(roxie.id)).toEqual([
      "\x1b[200~Update the login form.\x1b[201~\r",
    ]);
  });

  // One record for the whole turn, naming everyone it fed: the user said one
  // thing, and two entries would read as two messages they never sent.
  it("logs a brain turn once, as what was actually said", async () => {
    seed();
    answers("On it.", [
      { name: "Rocky", prompt: "Fix the auth test." },
      { name: "Roxie", prompt: "Update the login form." },
    ]);
    useRocStore.getState().setTranscript("ask Rocky and Roxie to get on it");
    render(<RocStage />);
    fireEvent.click(screen.getByText("Ask Roc"));
    await act(async () => {});

    fireEvent.click(screen.getByText("Send all"));
    await waitFor(() => expect(terminalWrite).toHaveBeenCalledTimes(2));

    const log = useRocStore.getState().log;
    expect(log).toHaveLength(1);
    expect(log[0]?.viaBrain).toBe(true);
    expect(log[0]?.text).toBe("ask Rocky and Roxie to get on it");
    expect(log[0]?.targets.map((t) => t.name)).toEqual(["Rocky", "Roxie"]);
    // …and it says so on screen. The entry reads back the sentence, which is
    // not what any of those agents was told — the mark is the only thing that
    // says the two are different.
    expect(screen.getByLabelText("Roc's turn")).toBeInTheDocument();
  });

  // Clicking a brain turn used to re-send `record.text` — the user's whole
  // sentence, to every pane, addressed to nobody. That is precisely the Phase-4
  // fan-out this phase exists to replace, one click away in the log.
  it("re-sends each agent its own instruction, never the sentence", async () => {
    const { rocky, roxie } = seed();
    answers("On it.", [
      { name: "Rocky", prompt: "Fix the auth test." },
      { name: "Roxie", prompt: "Update the login form." },
    ]);
    useRocStore.getState().setTranscript("ask Rocky and Roxie to get on it");
    render(<RocStage />);
    fireEvent.click(screen.getByText("Ask Roc"));
    await act(async () => {});
    fireEvent.click(screen.getByText("Send all"));
    await waitFor(() => expect(terminalWrite).toHaveBeenCalledTimes(2));
    terminalWrite.mockClear();

    fireEvent.click(screen.getByText("ask Rocky and Roxie to get on it"));
    await waitFor(() => expect(terminalWrite).toHaveBeenCalledTimes(2));

    expect(wroteTo(rocky.id)).toEqual([
      "\x1b[200~Fix the auth test.\x1b[201~\r",
    ]);
    expect(wroteTo(roxie.id)).toEqual([
      "\x1b[200~Update the login form.\x1b[201~\r",
    ]);
    expect(
      terminalWrite.mock.calls.some(([, data]) =>
        data.includes("ask Rocky and Roxie"),
      ),
    ).toBe(false);

    // Still one entry per turn, and still marked as Roc's.
    const log = useRocStore.getState().log;
    expect(log).toHaveLength(2);
    expect(log[0]?.viaBrain).toBe(true);
    expect(log[0]?.text).toBe("ask Rocky and Roxie to get on it");
  });

  it("sends one agent without sending the other", async () => {
    const { rocky, roxie } = seed();
    answers("On it.", [
      { name: "Rocky", prompt: "Fix the auth test." },
      { name: "Roxie", prompt: "Update the login form." },
    ]);
    useRocStore.getState().setTranscript("ask both");
    render(<RocStage />);
    fireEvent.click(screen.getByText("Ask Roc"));
    await act(async () => {});

    fireEvent.click(screen.getByLabelText("Send Rocky this instruction"));
    await waitFor(() => expect(terminalWrite).toHaveBeenCalledTimes(1));

    expect(wroteTo(rocky.id)).toHaveLength(1);
    expect(wroteTo(roxie.id)).toEqual([]);
    // The row it sent is gone; the one it did not is still waiting.
    expect(screen.queryByLabelText("Send Rocky this instruction")).toBeNull();
    expect(
      screen.getByLabelText("Send Roxie this instruction"),
    ).toBeInTheDocument();
  });

  it("drops an agent out of the plan without telling it anything", async () => {
    seed();
    answers("On it.", [
      { name: "Rocky", prompt: "Fix the auth test." },
      { name: "Roxie", prompt: "Update the login form." },
    ]);
    useRocStore.getState().setTranscript("ask both");
    render(<RocStage />);
    fireEvent.click(screen.getByText("Ask Roc"));
    await act(async () => {});

    fireEvent.click(screen.getByLabelText("Drop Roxie from the plan"));

    expect(screen.queryByText("Update the login form.")).toBeNull();
    expect(terminalWrite).not.toHaveBeenCalled();
  });

  // The whole reason a plan is confirmed rather than sent: a model that
  // understood most of a sentence writes a prompt that is mostly right.
  it("sends the edited prompt, not the one the model wrote", async () => {
    const { rocky } = seed();
    answers("On it.", [{ name: "Rocky", prompt: "Fix the auth test." }]);
    useRocStore.getState().setTranscript("ask Rocky");
    render(<RocStage />);
    fireEvent.click(screen.getByText("Ask Roc"));
    await act(async () => {});

    fireEvent.click(screen.getByLabelText("Edit Rocky's instruction"));
    fireEvent.change(screen.getByLabelText("Instruction for Rocky"), {
      target: { value: "Fix the auth test in packages/api." },
    });
    fireEvent.click(screen.getByLabelText("Send Rocky this instruction"));
    await waitFor(() => expect(terminalWrite).toHaveBeenCalledTimes(1));

    expect(wroteTo(rocky.id)).toEqual([
      "\x1b[200~Fix the auth test in packages/api.\x1b[201~\r",
    ]);
  });

  it("sends straight away when auto-dispatch is on", async () => {
    const { rocky } = seed();
    useSettingsStore.getState().setRocOption("autoDispatch", true);
    answers("Told Rocky.", [{ name: "Rocky", prompt: "Fix the auth test." }]);
    useRocStore.getState().setTranscript("ask Rocky");
    render(<RocStage />);

    fireEvent.click(screen.getByText("Ask Roc"));
    await waitFor(() => expect(terminalWrite).toHaveBeenCalledTimes(1));

    expect(wroteTo(rocky.id)).toEqual([
      "\x1b[200~Fix the auth test.\x1b[201~\r",
    ]);
    // Nothing left to confirm.
    expect(screen.queryByText("Send all")).toBeNull();
  });

  // The reply is read aloud on BOTH paths, so the way to interrupt it has to be
  // on both too. The fan-out auto-dispatch starts stamps its own phase
  // synchronously, and it used to take the one the Stop button hangs off before
  // the speech could — so a reply read itself out with nothing to press.
  it("offers Stop while it reads the reply, with auto-dispatch on", async () => {
    seed();
    useSettingsStore.getState().setRocOption("autoDispatch", true);
    useSettingsStore.getState().setRocOption("speakReplies", true);
    answers("Told Rocky.", [{ name: "Rocky", prompt: "Fix the auth test." }]);
    let finishSpeaking = () => {};
    rocSpeak.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishSpeaking = resolve;
        }),
    );
    useRocStore.getState().setTranscript("ask Rocky");
    render(<RocStage />);

    fireEvent.click(screen.getByText("Ask Roc"));
    await act(async () => {});

    expect(rocSpeak).toHaveBeenCalledWith(
      "Told Rocky.",
      null,
      DEFAULT_ROC_SETTINGS.speechRate,
    );
    expect(useRocStore.getState().phase).toBe("speaking");
    expect(screen.getByLabelText("Stop speaking")).toBeInTheDocument();
    // …and the message still went, which is what auto-dispatch is for.
    expect(terminalWrite).toHaveBeenCalledTimes(1);

    await act(async () => {
      finishSpeaking();
    });
    expect(useRocStore.getState().phase).toBe("idle");
  });

  // "One turn at a time" is a fact about the app, not about a button: the
  // widget is mounted beside this stage, and a turn it started has to grey this
  // one out too — or the two of them buy the same answer twice, and the second
  // turn throws away the first one's plan.
  it("greys out Ask while a turn started somewhere else is out", async () => {
    seed();
    let answer = () => {};
    rocThink.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = () =>
            resolve({
              text: '{"reply":"Rocky is idle.","assignments":[]}',
              isError: false,
              costUsd: 0.01,
              durationMs: 200,
            });
        }),
    );
    render(<RocStage />);
    fireEvent.change(bar(), { target: { value: "what is Rocky up to?" } });

    // The widget's sparkle, or a dictated sentence's Ask Roc: the same turn.
    await act(async () => {
      void askRoc("what is everyone doing?");
    });

    expect(screen.getByLabelText("Ask Roc")).toBeDisabled();

    await act(async () => {
      answer();
    });

    expect(screen.getByLabelText("Ask Roc")).not.toBeDisabled();
    expect(rocThink).toHaveBeenCalledTimes(1);
  });

  it("answers a question with a reply and no work", async () => {
    seed();
    answers("Rocky is running the tests and Roxie is idle.", []);
    useRocStore.getState().setTranscript("what is everyone doing?");
    render(<RocStage />);

    fireEvent.click(screen.getByText("Ask Roc"));
    await act(async () => {});

    expect(
      screen.getByText("Rocky is running the tests and Roxie is idle."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Send all")).toBeNull();
    expect(terminalWrite).not.toHaveBeenCalled();
  });

  it("puts a failure on the stage instead of going quiet", async () => {
    seed();
    rocThink.mockRejectedValueOnce(
      "Claude Code CLI not found. Install it (npm install -g …)",
    );
    useRocStore.getState().setTranscript("ask Rocky to deploy");
    render(<RocStage />);

    fireEvent.click(screen.getByText("Ask Roc"));
    await act(async () => {});

    expect(screen.getByRole("alert")).toHaveTextContent("not found");
    // …and the sentence is still on the stage, because nothing was done with it.
    expect(useRocStore.getState().transcript).toBe("ask Rocky to deploy");
  });

  it("asks from the command bar too, and empties the box when it does", async () => {
    seed();
    answers("Rocky is idle.", []);
    render(<RocStage />);
    fireEvent.change(bar(), { target: { value: "what is Rocky up to?" } });

    fireEvent.click(screen.getByLabelText("Ask Roc"));
    await act(async () => {});

    expect(rocThink.mock.calls[0]?.[0]).toContain("what is Rocky up to?");
    expect((bar() as HTMLTextAreaElement).value).toBe("");
    expect(terminalWrite).not.toHaveBeenCalled();
  });

  it("stops the reply when the user has heard enough", async () => {
    seed();
    useSettingsStore.getState().setRocOption("speakReplies", true);
    answers("Rocky is idle.", []);
    let finishSpeaking = () => {};
    rocSpeak.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishSpeaking = resolve;
        }),
    );
    useRocStore.getState().setTranscript("what is Rocky up to?");
    render(<RocStage />);
    fireEvent.click(screen.getByText("Ask Roc"));
    await act(async () => {});

    expect(rocSpeak).toHaveBeenCalledWith(
      "Rocky is idle.",
      null,
      DEFAULT_ROC_SETTINGS.speechRate,
    );
    fireEvent.click(screen.getByLabelText("Stop speaking"));
    await act(async () => {});

    expect(rocStopSpeaking).toHaveBeenCalled();
    expect(useRocStore.getState().phase).toBe("idle");
    await act(async () => {
      finishSpeaking();
    });
  });
});
