import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

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

import { commands } from "@/lib/bindings";
import { describeRoc, RocWidget } from "@/components/RocWidget";
import { newTerminal, newWorkspace } from "@/lib/factories";
import { resetRocBrainState } from "@/lib/rocBrain";
import { resetRocDispatchState } from "@/lib/rocDispatch";
import { getVoiceSink, setVoiceSink } from "@/lib/voiceSink";
import { useRocStore } from "@/stores/roc";
import {
  DEFAULT_ROC_SETTINGS,
  DEFAULT_VOICE_SETTINGS,
  useSettingsStore,
} from "@/stores/settings";
import { useRocTalkStore } from "@/stores/roctalk";
import { useTerminalsStore } from "@/stores/terminals";
import { resetToastsState, useToastsStore } from "@/stores/toasts";
import { useUIStore } from "@/stores/ui";
import { useWorkspacesStore } from "@/stores/workspaces";

/** Every live ResizeObserver callback, so a test can BE the resize: jsdom has
 *  no layout and therefore never fires one, and the widget's re-clamp is one of
 *  the two things that keep the card inside its parent. */
const resizeCallbacks: ResizeObserverCallback[] = [];

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

beforeEach(() => {
  vi.clearAllMocks();
  resizeCallbacks.length = 0;
  setVoiceSink(null);
  resetRocDispatchState();
  resetRocBrainState();
  resetToastsState();
  useSettingsStore.setState({
    roc: { ...DEFAULT_ROC_SETTINGS },
    voice: { ...DEFAULT_VOICE_SETTINGS },
  });
  useTerminalsStore.setState({ byId: {} });
  useWorkspacesStore.setState({ workspaces: [], activeWorkspaceId: null });
  useUIStore.setState({ mainView: "terminals", focusedTerminalId: null });
  useRocStore.setState({
    phase: "idle",
    open: true,
    expanded: false,
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
    amplitude: 0,
    downloadProgress: 0,
    position: { x: 10, y: 10 },
  });
});

describe("describeRoc", () => {
  const base = {
    phase: "idle",
    talkStatus: "idle",
    enabled: true,
    modelStatus: "ready",
    routeTo: "terminal",
    destination: "Rocky",
  } as const;

  it("lets the microphone speak over the conversation while it is open", () => {
    expect(
      describeRoc({
        ...base,
        phase: "dispatching",
        talkStatus: "recording",
        routeTo: "roc",
      }),
    ).toEqual({ label: "Listening — Roc is listening", orb: "listening" });
  });

  it("is not live when nothing is happening", () => {
    expect(describeRoc(base)).toEqual({ label: "Ready", orb: "idle" });
  });

  // The moment the mode matters is the moment the key is down, and "the
  // focused terminal" is a category — `Rocky` is the pane the user would have
  // to undo.
  it("names the pane it is dictating into while the key is held", () => {
    expect(describeRoc({ ...base, talkStatus: "recording" })).toEqual({
      label: "Listening — dictating to Rocky",
      orb: "listening",
    });
  });

  it("still reads as a sentence with nothing focused", () => {
    expect(
      describeRoc({ ...base, talkStatus: "recording", destination: null }),
    ).toEqual({ label: "Listening — dictating", orb: "listening" });
  });

  // The orb's ring is gated on `live`, and a missing model is a state the user
  // has to act on rather than one to animate at.
  it("says what is in the way before it says Ready", () => {
    expect(describeRoc({ ...base, modelStatus: "missing" })).toEqual({
      label: "Voice model needed",
      orb: "idle",
    });

    expect(describeRoc({ ...base, enabled: false })).toEqual({
      label: "Voice off",
      orb: "idle",
    });
  });
});

describe("RocWidget", () => {
  it("announces the transcript politely", () => {
    useRocStore.getState().setTranscript("fix the failing test");
    render(<RocWidget />);

    expect(screen.getByText("fix the failing test")).toHaveAttribute(
      "aria-live",
      "polite",
    );
  });

  // The orb is decorative and `aria-hidden`, so the phase line is the whole of
  // what a screen-reader user is told about it — and it has to be told, not
  // merely present.
  it("announces the phase, and names every state the orb has", () => {
    render(<RocWidget />);
    expect(screen.getByText("Ready")).toHaveAttribute("aria-live", "polite");

    act(() => useRocTalkStore.getState().setStatus("recording"));
    expect(screen.getByText("Listening — dictating")).toBeInTheDocument();

    act(() => useRocTalkStore.getState().setStatus("idle"));
    act(() => useRocStore.getState().setPhase("thinking"));
    expect(screen.getByText("Thinking")).toBeInTheDocument();

    act(() => useRocStore.getState().setPhase("dispatching"));
    expect(screen.getByText("Dispatching")).toBeInTheDocument();

    act(() => useRocStore.getState().setPhase("speaking"));
    expect(screen.getByText("Speaking")).toBeInTheDocument();
  });

  it("expands into the Roc view and collapses back out of it", () => {
    render(<RocWidget />);

    fireEvent.click(screen.getByLabelText("Expand Roc"));
    expect(useUIStore.getState().mainView).toBe("roc");

    fireEvent.click(screen.getByLabelText("Collapse Roc"));
    expect(useUIStore.getState().mainView).toBe("terminals");
  });

  it("closes, and renders nothing once closed", () => {
    const { container } = render(<RocWidget />);

    fireEvent.click(screen.getByLabelText("Close Roc"));

    expect(useRocStore.getState().open).toBe(false);
    expect(container.querySelector("[data-roc-widget]")).toBeNull();
  });

  it("mic button toggles voice — and downloads the model when there isn't one", () => {
    const { rerender } = render(<RocWidget />);

    fireEvent.click(screen.getByLabelText("Turn voice off"));
    expect(useRocTalkStore.getState().enabled).toBe(false);
    expect(commands.roctalkDownloadModel).not.toHaveBeenCalled();

    useRocTalkStore.setState({ enabled: true, modelStatus: "missing" });
    rerender(<RocWidget />);

    fireEvent.click(screen.getByLabelText("Download the voice model"));
    expect(commands.roctalkDownloadModel).toHaveBeenCalledTimes(1);
    // Asking for the model must not also flip the flag out from under it.
    expect(useRocTalkStore.getState().enabled).toBe(true);
  });

  // The pill's drag, which the widget inherits. Buttons sit inside the drag
  // surface, so a click on one must not also move the card.
  it("drags by the card, and not by its buttons", () => {
    const { container } = render(<RocWidget />);
    // jsdom measures everything as 0×0, and the drag clamps to its parent — so
    // without a box to move inside, every drag lands back at the origin.
    container.getBoundingClientRect = () =>
      ({ width: 800, height: 600 }) as DOMRect;
    const card = container.querySelector<HTMLElement>("[data-roc-widget]")!;
    card.setPointerCapture = () => {};
    card.releasePointerCapture = () => {};

    fireEvent.pointerDown(card, {
      button: 0,
      pointerId: 1,
      clientX: 0,
      clientY: 0,
    });
    fireEvent.pointerMove(card, { pointerId: 1, clientX: 40, clientY: 25 });
    fireEvent.pointerUp(card, { pointerId: 1, clientX: 40, clientY: 25 });

    expect(useRocTalkStore.getState().position).toEqual({ x: 50, y: 35 });

    fireEvent.pointerDown(screen.getByLabelText("Close Roc"), {
      button: 0,
      pointerId: 2,
      clientX: 0,
      clientY: 0,
    });
    fireEvent.pointerMove(card, { pointerId: 2, clientX: 90, clientY: 90 });

    expect(useRocTalkStore.getState().position).toEqual({ x: 50, y: 35 });
  });

  // The card is a `minHeight` card — 104 with nothing to say, 127 with a
  // transcript and a reply on it, taller again when the footer wraps — and the
  // drag used to clamp against the 104. So a tall card dragged to the bottom
  // edge put its last 23 pixels outside an `overflow-hidden` parent, which is
  // where the mode switch and all six icon buttons live: invisible, unclickable,
  // and impossible to drag back because the only grip left was the card's top.
  it("keeps the whole card inside its parent, however tall it has grown", () => {
    const { container } = render(<RocWidget />);
    container.getBoundingClientRect = () =>
      ({ width: 800, height: 600 }) as DOMRect;
    const card = container.querySelector<HTMLElement>("[data-roc-widget]")!;
    card.setPointerCapture = () => {};
    card.releasePointerCapture = () => {};
    // jsdom measures every box as zero, so the card is told how tall it is —
    // the height a transcript and a reply actually make it in the browser.
    Object.defineProperty(card, "offsetHeight", { value: 127 });

    fireEvent.pointerDown(card, {
      button: 0,
      pointerId: 7,
      clientX: 0,
      clientY: 0,
    });
    fireEvent.pointerMove(card, { pointerId: 7, clientX: 0, clientY: 5000 });
    fireEvent.pointerUp(card, { pointerId: 7, clientX: 0, clientY: 5000 });

    const { y } = useRocTalkStore.getState().position;
    // The bottom of the card, not the bottom of a 104-pixel guess.
    expect(y).toBe(600 - 127);
    expect(y + 127).toBeLessThanOrEqual(600);
  });

  // …and the same rule when the card grows where it stands: a reply arriving
  // while it sits on the bottom edge is the common way the footer leaves the
  // box, and no pointer is involved.
  it("pulls itself back in when it grows against the bottom edge", () => {
    // Where a 104-pixel card is allowed to sit in a 600-pixel parent, and 23
    // pixels lower than a 127-pixel one may.
    useRocTalkStore.setState({ position: { x: 10, y: 496 } });

    const { container } = render(<RocWidget />);
    container.getBoundingClientRect = () =>
      ({ width: 800, height: 600 }) as DOMRect;
    const card = container.querySelector<HTMLElement>("[data-roc-widget]")!;
    Object.defineProperty(card, "offsetHeight", { value: 127 });

    act(() => {
      for (const callback of resizeCallbacks) {
        callback([], {} as ResizeObserver);
      }
    });

    expect(useRocTalkStore.getState().position).toEqual({ x: 10, y: 473 });
  });

  // The cross-workstream seam. `useRocTalk` routes a transcript to whatever is
  // registered here rather than importing Roc's store, phase machine and view;
  // with nothing registered it falls back to the focused terminal, so failing
  // to register would send everything the user dictated into a PTY instead.
  it("claims the routed transcripts while it is mounted", () => {
    expect(getVoiceSink()).toBeNull();
    const { unmount } = render(<RocWidget />);

    const sink = getVoiceSink();
    expect(sink).not.toBeNull();
    act(() => sink!("restart the failing test"));

    expect(useRocStore.getState().transcript).toBe("restart the failing test");
    // Heard, and nothing more. A sentence waiting on screen for the user to
    // press something is not Roc thinking about anything — "thinking" is the
    // reasoning turn, and claiming it here left the orb turning for a thought
    // nobody was having until the user happened to act.
    expect(useRocStore.getState().phase).toBe("idle");

    // …and a phase somebody else owns is left where it is: dictation can land
    // while a fan-out from the last message is still going.
    act(() => useRocStore.getState().setPhase("dispatching"));
    act(() => sink!("and the other one"));
    expect(useRocStore.getState().phase).toBe("dispatching");
    act(() => useRocStore.getState().setPhase("idle"));

    // …and it gives them back, or the next mount would be the second thing
    // claiming one microphone.
    unmount();
    expect(getVoiceSink()).toBeNull();
  });

  // Closing the widget gives the sink BACK, and that is the whole of the fix.
  //
  // The claim used to be a bare `useEffect`, which runs whatever the render
  // returned — and this component returns null while closed. So a hidden widget
  // went on holding the microphone's output: `useRocTalk` asked whether a
  // destination existed, was told yes, and handed the sentence to
  // `setTranscript` for a store field with nothing mounted to draw it. Hide the
  // widget, hold push-to-talk, speak: no orb, no text, no toast, and — because
  // `deliverTranscript`'s "Roc is not open, send it to the terminal and say so"
  // path is keyed on the sink being NULL — no fallback either. The words went
  // nowhere at all.
  it("gives them back when it is closed, so the fallback can happen", () => {
    render(<RocWidget />);
    expect(getVoiceSink()).not.toBeNull();

    fireEvent.click(screen.getByLabelText("Close Roc"));

    expect(useRocStore.getState().open).toBe(false);
    expect(getVoiceSink()).toBeNull();
  });

  // …unless the expanded view is up, which draws the same transcript on its
  // stage. Closing the widget while Roc is open is a smaller "not now" than
  // closing Roc, and dictation still has somewhere to land.
  it("keeps claiming them for the expanded view", () => {
    render(<RocWidget />);
    act(() => useRocStore.getState().setExpanded(true));
    fireEvent.click(screen.getByLabelText("Close Roc"));

    expect(useRocStore.getState().open).toBe(false);
    expect(useRocStore.getState().expanded).toBe(true);
    expect(getVoiceSink()).not.toBeNull();
  });

  // Not decoration: an orb that animates forever is a layer repainting behind
  // every terminal for the whole session. Asserted end to end here — the store
  // says idle, and no frame is asked for anywhere below this card — with the
  // orb's own teardown and reduced-motion rules in `rocOrb.test.tsx`.
  it("schedules no frame while Roc is idle, and one once it is not", () => {
    const context = {
      setTransform: () => {},
      clearRect: () => {},
      beginPath: () => {},
      moveTo: () => {},
      lineTo: () => {},
      stroke: () => {},
    } as unknown as CanvasRenderingContext2D;
    const getContext = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue(context);
    const schedule = vi
      .spyOn(window, "requestAnimationFrame")
      .mockReturnValue(1);

    const { container, rerender } = render(<RocWidget />);
    expect(container.querySelector("[data-roc-orb-state]")).toHaveAttribute(
      "data-roc-orb-state",
      "idle",
    );
    expect(schedule).not.toHaveBeenCalled();

    useRocStore.getState().setPhase("dispatching");
    rerender(<RocWidget />);

    expect(container.querySelector("[data-roc-orb-state]")).toHaveAttribute(
      "data-roc-orb-state",
      "thinking",
    );
    expect(schedule).toHaveBeenCalled();

    schedule.mockRestore();
    getContext.mockRestore();
  });
});

/** The thing the owner asked for after using it: dictation stays the default, and
 *  swapping to a conversation is a control that is always on screen rather
 *  than a trip through Settings. */
describe("the mode switch", () => {
  const dictate = () => screen.getByRole("radio", { name: /^Dictate/ });
  const talk = () => screen.getByRole("radio", { name: /^Talk to Roc/ });

  it("opens in Dictate, and says so", () => {
    render(<RocWidget />);

    expect(useSettingsStore.getState().voice.routeTo).toBe("terminal");
    expect(dictate()).toHaveAttribute("aria-checked", "true");
    expect(talk()).toHaveAttribute("aria-checked", "false");
  });

  it("switches with one click, and writes the setting", () => {
    render(<RocWidget />);

    fireEvent.click(talk());

    expect(useSettingsStore.getState().voice.routeTo).toBe("roc");
    expect(talk()).toHaveAttribute("aria-checked", "true");
    expect(dictate()).toHaveAttribute("aria-checked", "false");

    fireEvent.click(dictate());
    expect(useSettingsStore.getState().voice.routeTo).toBe("terminal");
  });

  // One source of truth, so the two controls cannot disagree about which mode
  // is live: the widget writes through `setVoiceOption`, which is the same
  // writer Settings › Voice uses, and reads the store back out.
  it("agrees with Settings, both ways", () => {
    render(<RocWidget />);

    act(() => useSettingsStore.getState().setVoiceOption("routeTo", "roc"));
    expect(talk()).toHaveAttribute("aria-checked", "true");

    fireEvent.click(dictate());
    expect(useSettingsStore.getState().voice.routeTo).toBe("terminal");
  });

  // The moment the mode matters is the moment the key is down.
  it("names the destination pane while the key is held in Dictate", () => {
    const workspace = newWorkspace({ projectPath: "/proj", order: 0 });
    const pane = newTerminal({
      workspaceId: workspace.id,
      name: "Rocky",
      agentType: "claude-code",
      projectPath: "/proj",
    });
    useTerminalsStore.getState().setTerminals([pane]);
    useUIStore.setState({ focusedTerminalId: pane.id });
    render(<RocWidget />);

    act(() => useRocTalkStore.getState().setStatus("recording"));
    expect(screen.getByText("Listening — dictating to Rocky")).toBeTruthy();

    act(() => useSettingsStore.getState().setVoiceOption("routeTo", "roc"));
    expect(screen.getByText("Listening — Roc is listening")).toBeTruthy();
  });

  // Measured in a browser against the built stylesheet: with a transcript in
  // hand AND a reply being read — six icon buttons, a state `rocBrain` really
  // does produce — each option had 65 pixels of box for 66 pixels of text, and
  // "Talk to Roc" came out as "Talk to R…". One pixel over is a bug at the
  // mercy of whichever font actually loads.
  //
  // jsdom has no layout, so what is asserted here is the RULE that fixes it:
  // the label is not the thing that gives way. The switch is sized by its own
  // labels, and the footer wraps instead.
  it("never shortens a mode label to make room for the buttons", () => {
    act(() => {
      useRocStore.getState().setTranscript("ask Rocky to run the tests");
      useRocStore.getState().setPhase("speaking");
    });
    render(<RocWidget />);
    // The worst case, on screen: Ask, Send and Stop are all there.
    expect(screen.getAllByRole("button")).toHaveLength(6);

    for (const option of screen.getAllByRole("radio")) {
      expect(option.className).toMatch(/\bwhitespace-nowrap\b/);
      expect(option.className).not.toMatch(/\btruncate\b/);
      expect(option.className).not.toMatch(/\bmin-w-0\b/);
    }
    const group = screen.getAllByRole("radio")[0]!.parentElement!;
    expect(group.className).not.toMatch(/\bmin-w-0\b/);
    // …and the thing that gives way instead of the words.
    expect(group.parentElement!.className).toMatch(/\bflex-wrap\b/);
  });

  // Calling it a radiogroup is a promise about the keyboard. It was making the
  // promise and keeping none of it: both options were tab stops, and the arrow
  // keys AT announces ("radio button, 1 of 2") did nothing at all.
  it("is one tab stop, and the stop follows the selection", () => {
    render(<RocWidget />);

    expect(screen.getAllByRole("radio").map((r) => r.tabIndex)).toEqual([
      0, -1,
    ]);

    fireEvent.click(talk());

    expect(screen.getAllByRole("radio").map((r) => r.tabIndex)).toEqual([
      -1, 0,
    ]);
  });

  it("moves and selects on the arrow keys, and wraps", () => {
    render(<RocWidget />);
    const group = screen.getByRole("radiogroup", {
      name: "What the push-to-talk key does",
    });
    const mode = () => useSettingsStore.getState().voice.routeTo;

    fireEvent.keyDown(group, { key: "ArrowRight" });
    expect(mode()).toBe("roc");
    expect(talk()).toHaveFocus();

    // Two options, so either direction from either end wraps.
    fireEvent.keyDown(group, { key: "ArrowRight" });
    expect(mode()).toBe("terminal");
    fireEvent.keyDown(group, { key: "ArrowLeft" });
    expect(mode()).toBe("roc");
    fireEvent.keyDown(group, { key: "ArrowUp" });
    expect(mode()).toBe("terminal");
    fireEvent.keyDown(group, { key: "ArrowDown" });
    expect(mode()).toBe("roc");

    fireEvent.keyDown(group, { key: "Home" });
    expect(mode()).toBe("terminal");
    fireEvent.keyDown(group, { key: "End" });
    expect(mode()).toBe("roc");
  });

  // Holding the key is not browsing: with two options it is the mode flipping
  // thirty times a second, and every flip is a setting written to disk.
  it("ignores an autorepeating arrow", () => {
    render(<RocWidget />);
    const group = screen.getByRole("radiogroup", {
      name: "What the push-to-talk key does",
    });

    fireEvent.keyDown(group, { key: "ArrowRight" });
    expect(useSettingsStore.getState().voice.routeTo).toBe("roc");

    for (const _ of [1, 2, 3]) {
      fireEvent.keyDown(group, { key: "ArrowRight", repeat: true });
    }

    expect(useSettingsStore.getState().voice.routeTo).toBe("roc");
  });

  // The switch sits inside the drag surface, like the buttons beside it.
  it("does not drag the card", () => {
    const { container } = render(<RocWidget />);
    container.getBoundingClientRect = () =>
      ({ width: 800, height: 600 }) as DOMRect;
    const card = container.querySelector<HTMLElement>("[data-roc-widget]")!;
    card.setPointerCapture = () => {};
    card.releasePointerCapture = () => {};

    fireEvent.pointerDown(talk(), { button: 0, pointerId: 3, clientX: 0 });
    fireEvent.pointerMove(card, { pointerId: 3, clientX: 70, clientY: 70 });

    expect(useRocTalkStore.getState().position).toEqual({ x: 10, y: 10 });
  });
});

describe("sending what Roc heard", () => {
  function seedPane(name: string) {
    const workspace = newWorkspace({ projectPath: "/proj", order: 0 });
    const pane = newTerminal({
      workspaceId: workspace.id,
      name,
      agentType: "claude-code",
      projectPath: "/proj",
    });
    useTerminalsStore.getState().setTerminals([pane]);
    useWorkspacesStore.setState({
      workspaces: [workspace],
      activeWorkspaceId: workspace.id,
    });
    return pane;
  }

  // The premise of the phase is talking to your agents from wherever you are.
  // A transcript that can only be sent from a view the user has to open first
  // fails that on its own terms.
  it("dispatches from the widget, with the view closed", async () => {
    const rocky = seedPane("Rocky");
    render(<RocWidget />);
    act(() => useRocStore.getState().setTranscript("@Rocky run the tests"));

    fireEvent.click(screen.getByLabelText("Send what Roc heard"));
    await act(async () => {});

    expect(terminalWrite).toHaveBeenCalledWith(
      rocky.id,
      "\x1b[200~run the tests\x1b[201~\r",
    );
    expect(useRocStore.getState().transcript).toBe("");
  });

  // The widget took the targets and threw the unknown names away, so a
  // transcript naming two agents with one of them closed went to one of them
  // and said nothing at all — leaving the user certain both had been told.
  // Same helper as the stage now, so the warning cannot go missing on one path.
  it("says which of the names it could not find", async () => {
    const rocky = seedPane("Rocky");
    render(<RocWidget />);
    act(() => useRocStore.getState().setTranscript("@Rocky @Roxie deploy"));

    fireEvent.click(screen.getByLabelText("Send what Roc heard"));
    await act(async () => {});

    expect(terminalWrite).toHaveBeenCalledWith(
      rocky.id,
      "\x1b[200~deploy\x1b[201~\r",
    );
    expect(
      useToastsStore
        .getState()
        .items.map((t) => t.message)
        .join(" "),
    ).toContain("Roxie");
  });

  // Never on its own: Whisper mishears, and a fan-out cannot be taken back.
  it("offers nothing to press until there is something to send", () => {
    seedPane("Rocky");
    render(<RocWidget />);

    expect(screen.queryByLabelText("Send what Roc heard")).toBeNull();
    expect(terminalWrite).not.toHaveBeenCalled();
  });
});

describe("asking Roc from the widget", () => {
  function seedPane(name: string) {
    const workspace = newWorkspace({ projectPath: "/proj", order: 0 });
    const pane = newTerminal({
      workspaceId: workspace.id,
      name,
      agentType: "claude-code",
      projectPath: "/proj",
    });
    useTerminalsStore.getState().setTerminals([pane]);
    useWorkspacesStore.setState({
      workspaces: [workspace],
      activeWorkspaceId: workspace.id,
    });
    return pane;
  }

  // The turn the phase is about, from a card the user did not have to open
  // anything to reach.
  it("thinks about the transcript and shows what came back", async () => {
    seedPane("Rocky");
    rocThink.mockResolvedValueOnce({
      text: '{"reply":"Rocky is running the tests.","assignments":[]}',
      isError: false,
      costUsd: 0.01,
      durationMs: 200,
    });
    render(<RocWidget />);
    act(() => useRocStore.getState().setTranscript("what is Rocky doing?"));

    fireEvent.click(screen.getByLabelText("Ask Roc what to do with it"));
    await act(async () => {});

    expect(rocThink).toHaveBeenCalled();
    expect(rocThink.mock.calls[0]?.[0]).toContain("what is Rocky doing?");
    expect(screen.getByText("Rocky is running the tests.")).toBeInTheDocument();
    expect(useRocStore.getState().transcript).toBe("");
  });

  // A 320-pixel card is no place to confirm a plan, so a turn that came back
  // with work to do takes the user where the list is.
  it("opens the Roc view when there is a plan to confirm", async () => {
    seedPane("Rocky");
    rocThink.mockResolvedValueOnce({
      text: '{"reply":"On it.","assignments":[{"name":"Rocky","prompt":"run the tests"}]}',
      isError: false,
      costUsd: 0.01,
      durationMs: 200,
    });
    render(<RocWidget />);
    act(() =>
      useRocStore.getState().setTranscript("ask Rocky to run the tests"),
    );

    fireEvent.click(screen.getByLabelText("Ask Roc what to do with it"));
    await act(async () => {});

    expect(useUIStore.getState().mainView).toBe("roc");
    // …and nothing has been written to a PTY: the plan is a proposal.
    expect(terminalWrite).not.toHaveBeenCalled();
  });

  it("stays put when auto-dispatch is on, because there is nothing to confirm", async () => {
    const rocky = seedPane("Rocky");
    useSettingsStore.getState().setRocOption("autoDispatch", true);
    rocThink.mockResolvedValueOnce({
      text: '{"reply":"Told Rocky.","assignments":[{"name":"Rocky","prompt":"run the tests"}]}',
      isError: false,
      costUsd: 0.01,
      durationMs: 200,
    });
    render(<RocWidget />);
    act(() =>
      useRocStore.getState().setTranscript("ask Rocky to run the tests"),
    );

    fireEvent.click(screen.getByLabelText("Ask Roc what to do with it"));
    await act(async () => {});
    await act(async () => {});

    expect(useUIStore.getState().mainView).toBe("terminals");
    expect(terminalWrite).toHaveBeenCalledWith(
      rocky.id,
      "\x1b[200~run the tests\x1b[201~\r",
    );
  });

  // The failure the exit criteria call unmissable: no CLI, and a sentence on
  // the one surface that is always up.
  it("shows why a turn produced nothing", async () => {
    seedPane("Rocky");
    rocThink.mockRejectedValueOnce("Claude Code CLI not found. Install it (…)");
    render(<RocWidget />);
    act(() => useRocStore.getState().setTranscript("ask Rocky to deploy"));

    fireEvent.click(screen.getByLabelText("Ask Roc what to do with it"));
    await act(async () => {});

    expect(screen.getByText(/not found/)).toBeInTheDocument();
    // …and the transcript is still there, because nothing was done with it.
    expect(useRocStore.getState().transcript).toBe("ask Rocky to deploy");
  });

  it("speaks the reply, and offers a way to stop it", async () => {
    seedPane("Rocky");
    useSettingsStore.getState().setRocOption("speakReplies", true);
    let finishSpeaking = () => {};
    rocSpeak.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishSpeaking = resolve;
        }),
    );
    render(<RocWidget />);
    act(() => useRocStore.getState().setTranscript("what is Rocky doing?"));

    fireEvent.click(screen.getByLabelText("Ask Roc what to do with it"));
    await act(async () => {});

    expect(rocSpeak).toHaveBeenCalledWith(
      "On it.",
      null,
      DEFAULT_ROC_SETTINGS.speechRate,
    );
    expect(useRocStore.getState().phase).toBe("speaking");
    expect(screen.getByText("Speaking")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Stop speaking"));
    await act(async () => {});
    expect(rocStopSpeaking).toHaveBeenCalled();
    expect(useRocStore.getState().phase).toBe("idle");

    // The child really does end, and the speaker tidies up after itself.
    await act(async () => {
      finishSpeaking();
    });
  });

  it("says nothing aloud when the user asked it not to", async () => {
    seedPane("Rocky");
    useSettingsStore.getState().setRocOption("speakReplies", false);
    render(<RocWidget />);
    act(() => useRocStore.getState().setTranscript("what is Rocky doing?"));

    fireEvent.click(screen.getByLabelText("Ask Roc what to do with it"));
    await act(async () => {});

    expect(rocSpeak).not.toHaveBeenCalled();
  });
});
