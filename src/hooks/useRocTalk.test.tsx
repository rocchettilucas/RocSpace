import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

/** Tauri stand-ins. `invoke` records every command the pipeline issues;
 *  `listen` keeps the handlers so a test can play a `roctalk://` event. */
const { invoke, listeners } = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(name, handler);
    return Promise.resolve(() => listeners.delete(name));
  },
}));

const { platformValue } = vi.hoisted(() => ({
  platformValue: { current: "macos" as "macos" | "windows" },
}));
vi.mock("@tauri-apps/plugin-os", () => ({
  platform: () => platformValue.current,
}));

vi.mock("@tauri-apps/plugin-store", () => {
  class FakeStore {
    static async load(): Promise<FakeStore> {
      return new FakeStore();
    }
    async get(): Promise<undefined> {
      return undefined;
    }
    async set(): Promise<void> {}
    async save(): Promise<void> {}
  }
  return { Store: FakeStore };
});

const { useRocTalk } = await import("@/hooks/useRocTalk");
const { VoiceSection } = await import("@/views/Settings/sections/VoiceSection");
const { setVoiceSink } = await import("@/lib/voiceSink");
const { DEFAULT_VOICE_SETTINGS, useSettingsStore } =
  await import("@/stores/settings");
const { useRocTalkStore } = await import("@/stores/roctalk");
const { useTerminalRuntimeStore } = await import("@/stores/terminalRuntime");
const { useToastsStore } = await import("@/stores/toasts");
const { useUIStore } = await import("@/stores/ui");

function Harness() {
  useRocTalk();
  return null;
}

/** Play a whole push-to-talk hold at the DOM level. */
function holdKey(init: KeyboardEventInit) {
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", init));
  });
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keyup", init));
  });
}

function calls(command: string) {
  return invoke.mock.calls.filter(([name]) => name === command);
}

describe("useRocTalk", () => {
  beforeEach(() => {
    platformValue.current = "macos";
    listeners.clear();
    invoke.mockReset();
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "roctalk_get_model_status") return "ready";
      if (cmd === "roctalk_stop_recording_and_transcribe") {
        return "um, run the tests";
      }
      return null;
    });
    setVoiceSink(null);
    useSettingsStore.setState({ voice: { ...DEFAULT_VOICE_SETTINGS } });
    useRocTalkStore.setState({
      enabled: true,
      status: "idle",
      modelStatus: "ready",
      amplitude: 0,
    });
    useTerminalRuntimeStore.setState({ hasUserInput: {} });
    useToastsStore.setState({ items: [] });
    useUIStore.setState({ focusedTerminalId: "term-1" });
  });

  it("binds the configured accelerator at boot and again when it changes", async () => {
    render(<Harness />);

    await waitFor(() =>
      expect(calls("ptt_register")).toEqual([
        ["ptt_register", { accelerator: "Alt+Space" }],
      ]),
    );

    act(() => {
      useSettingsStore.getState().setVoiceOption("accelerator", "Control+F13");
    });

    await waitFor(() =>
      expect(calls("ptt_register").at(-1)).toEqual([
        "ptt_register",
        { accelerator: "Control+F13" },
      ]),
    );
  });

  it("gives the chord back when RocTalk is switched off, and takes it again after", async () => {
    // A registered accelerator is taken from every application on the machine.
    // An off switch that leaves it bound is not an off switch.
    render(<Harness />);
    await waitFor(() => expect(calls("ptt_register")).toHaveLength(1));

    act(() => useRocTalkStore.setState({ enabled: false }));
    await waitFor(() => expect(calls("ptt_unregister")).toHaveLength(1));

    act(() => useRocTalkStore.setState({ enabled: true }));
    await waitFor(() => expect(calls("ptt_register")).toHaveLength(2));
    expect(calls("ptt_register").at(-1)).toEqual([
      "ptt_register",
      { accelerator: "Alt+Space" },
    ]);
  });

  it("lets the chord through to the app while RocTalk is off", async () => {
    // The other half of switching off: the DOM fallback used to swallow the
    // chord before it asked whether RocTalk was on, so ⌥Space vanished from the
    // terminal underneath and nothing was recorded either.
    render(<Harness />);
    await waitFor(() => expect(listeners.has("roctalk://ptt-down")).toBe(true));
    act(() => useRocTalkStore.setState({ enabled: false }));

    const down = new KeyboardEvent("keydown", {
      code: "Space",
      altKey: true,
      cancelable: true,
    });
    act(() => {
      window.dispatchEvent(down);
    });

    expect(down.defaultPrevented).toBe(false);
    expect(calls("roctalk_start_recording")).toEqual([]);

    // …and the fallback works again the moment it is switched back on.
    act(() => useRocTalkStore.setState({ enabled: true }));
    holdKey({ code: "Space", altKey: true });
    expect(calls("roctalk_start_recording")).toHaveLength(1);
  });

  it("stands down while the accelerator picker is armed", async () => {
    // Rebinding is the one moment the chord must reach a control instead of the
    // microphone. The hook listens on `window` in the capture phase and the
    // picker on `document`, so the hook is first in the path for every real
    // keystroke: swallowing the chord there meant the picker could never see
    // the key it was asking for, and pressing it started a recording instead.
    render(
      <>
        <Harness />
        <VoiceSection />
      </>,
    );
    await waitFor(() => expect(calls("ptt_register")).toHaveLength(1));

    const picker = screen.getByRole("button", {
      name: "Push-to-talk shortcut",
    });
    fireEvent.click(picker);
    expect(picker).toHaveAttribute("aria-pressed", "true");
    // The OS eats a registered accelerator before the webview sees it, so the
    // binding has to be handed back for the duration of the capture.
    await waitFor(() => expect(calls("ptt_unregister")).toHaveLength(1));

    // Dispatched inside the document, where a real keystroke lands.
    fireEvent.keyDown(document.body, { code: "Space", altKey: true });

    expect(calls("roctalk_start_recording")).toEqual([]);
    expect(useRocTalkStore.getState().status).toBe("idle");
    // The picker got it: capture ends nowhere else but Escape, blur, and a
    // captured chord.
    expect(picker).toHaveAttribute("aria-pressed", "false");
    expect(useSettingsStore.getState().voice.accelerator).toBe("Alt+Space");

    // …and the accelerator is taken again the moment the picker is done.
    await waitFor(() => expect(calls("ptt_register")).toHaveLength(2));
  });

  it("ignores a global push-to-talk event that arrives while the picker is armed", async () => {
    // The unregister is a round trip; a chord pressed before it lands still
    // arrives from Rust, and must not open the microphone under the picker.
    render(
      <>
        <Harness />
        <VoiceSection />
      </>,
    );
    await waitFor(() => expect(listeners.has("roctalk://ptt-down")).toBe(true));

    fireEvent.click(
      screen.getByRole("button", { name: "Push-to-talk shortcut" }),
    );
    act(() => listeners.get("roctalk://ptt-down")!({ payload: undefined }));

    expect(calls("roctalk_start_recording")).toEqual([]);
    expect(useRocTalkStore.getState().status).toBe("idle");
  });

  it("never asks the OS for a key it cannot take, and hears it anyway", async () => {
    // Bare Caps Lock is what RocTalk shipped with. There is no global mechanism
    // for it outside Windows, so nothing is registered — but the DOM listener
    // is right here, and in-app dictation is worth more than a refusal.
    act(() => {
      useSettingsStore.getState().setVoiceOption("accelerator", "CapsLock");
    });
    render(<Harness />);
    await waitFor(() => expect(listeners.has("roctalk://ptt-down")).toBe(true));
    await waitFor(() => expect(calls("ptt_unregister")).toHaveLength(1));

    expect(calls("ptt_register")).toEqual([]);
    expect(useToastsStore.getState().items).toEqual([]);

    holdKey({ code: "CapsLock" });
    expect(calls("roctalk_start_recording")).toHaveLength(1);
  });

  it("says so when the OS refuses the accelerator", async () => {
    // A console line is a message in a window nobody has open: the user chose a
    // key and it does not work.
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "ptt_register") throw new Error("HotKey already registered");
      if (cmd === "roctalk_get_model_status") return "ready";
      return null;
    });
    render(<Harness />);

    await waitFor(() =>
      expect(useToastsStore.getState().items).toHaveLength(1),
    );
    const toast = useToastsStore.getState().items[0]!;
    expect(toast.message).toMatch(/Alt\+Space/);
    expect(toast.tone).toBe("warn");
  });

  it("says so when the microphone will not open", async () => {
    // Rust's message names the cause — asleep, unplugged, held by another
    // application. The pill going quiet again explains none of that, and a
    // console line is a message in a window nobody has open.
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "roctalk_start_recording") {
        throw "the microphone did not answer within 10 s";
      }
      if (cmd === "roctalk_get_model_status") return "ready";
      return null;
    });
    render(<Harness />);
    await waitFor(() => expect(listeners.has("roctalk://ptt-down")).toBe(true));

    act(() => listeners.get("roctalk://ptt-down")!({ payload: undefined }));

    await waitFor(() => expect(useRocTalkStore.getState().status).toBe("idle"));
    const toast = useToastsStore.getState().items.at(-1)!;
    expect(toast.message).toMatch(/did not answer within 10 s/);
    expect(toast.tone).toBe("warn");
  });

  it("dictates into the focused terminal, sanitized and not submitted", async () => {
    render(<Harness />);
    await waitFor(() => expect(listeners.has("roctalk://ptt-down")).toBe(true));

    act(() => listeners.get("roctalk://ptt-down")!({ payload: undefined }));
    expect(useRocTalkStore.getState().status).toBe("recording");
    expect(calls("roctalk_start_recording")).toEqual([
      ["roctalk_start_recording", { inputDevice: "" }],
    ]);

    await act(async () => {
      listeners.get("roctalk://ptt-up")!({ payload: undefined });
    });

    await waitFor(() =>
      expect(calls("terminal_write")).toEqual([
        // Fillers stripped, one line, and NO trailing carriage return: a
        // submit would run whatever Whisper thought it heard.
        ["terminal_write", { terminalId: "term-1", data: "Run the tests. " }],
      ]),
    );
    expect(useRocTalkStore.getState().status).toBe("idle");
    // The pane has been typed into — the idle watchdog and the notification
    // bridge both gate on that.
    expect(useTerminalRuntimeStore.getState().hasUserInput["term-1"]).toBe(
      true,
    );
  });

  it("transcribes with the selected model and opens the selected microphone", async () => {
    act(() => {
      useSettingsStore.getState().setVoiceOption("modelSize", "small.en");
      useSettingsStore.getState().setVoiceOption("inputDevice", "Yeti Nano");
    });
    render(<Harness />);
    await waitFor(() => expect(listeners.has("roctalk://ptt-down")).toBe(true));

    act(() => listeners.get("roctalk://ptt-down")!({ payload: undefined }));
    await act(async () => {
      listeners.get("roctalk://ptt-up")!({ payload: undefined });
    });

    expect(calls("roctalk_start_recording")).toEqual([
      ["roctalk_start_recording", { inputDevice: "Yeti Nano" }],
    ]);
    expect(calls("roctalk_stop_recording_and_transcribe")).toEqual([
      ["roctalk_stop_recording_and_transcribe", { modelSize: "small.en" }],
    ]);
  });

  it("hands the transcript to Roc when that is where it is routed", async () => {
    const sink = vi.fn();
    setVoiceSink(sink);
    act(() => {
      useSettingsStore.getState().setVoiceOption("routeTo", "roc");
    });
    render(<Harness />);
    await waitFor(() => expect(listeners.has("roctalk://ptt-down")).toBe(true));

    act(() => listeners.get("roctalk://ptt-down")!({ payload: undefined }));
    await act(async () => {
      listeners.get("roctalk://ptt-up")!({ payload: undefined });
    });

    await waitFor(() => expect(sink).toHaveBeenCalledWith("Run the tests. "));
    expect(calls("terminal_write")).toEqual([]);
  });

  it("records for Roc even with no pane focused, and refuses to for a terminal", async () => {
    // Talking to Roc with nothing focused is most of why the routing setting
    // exists; dictating into a terminal that does not exist is not.
    useUIStore.setState({ focusedTerminalId: null });
    render(<Harness />);
    await waitFor(() => expect(listeners.has("roctalk://ptt-down")).toBe(true));

    act(() => listeners.get("roctalk://ptt-down")!({ payload: undefined }));
    expect(useRocTalkStore.getState().status).toBe("idle");
    expect(calls("roctalk_start_recording")).toEqual([]);

    setVoiceSink(vi.fn());
    act(() => {
      useSettingsStore.getState().setVoiceOption("routeTo", "roc");
    });
    act(() => listeners.get("roctalk://ptt-down")!({ payload: undefined }));

    expect(useRocTalkStore.getState().status).toBe("recording");
  });

  it("falls back to the terminal when nothing has claimed the routed transcript", async () => {
    // Roc is not mounted yet. Losing what was said would be worse than putting
    // it where it has always gone.
    act(() => {
      useSettingsStore.getState().setVoiceOption("routeTo", "roc");
    });
    render(<Harness />);
    await waitFor(() => expect(listeners.has("roctalk://ptt-down")).toBe(true));

    act(() => listeners.get("roctalk://ptt-down")!({ payload: undefined }));
    await act(async () => {
      listeners.get("roctalk://ptt-up")!({ payload: undefined });
    });

    await waitFor(() =>
      expect(calls("terminal_write")).toEqual([
        ["terminal_write", { terminalId: "term-1", data: "Run the tests. " }],
      ]),
    );
  });

  it("says where the transcript went when Roc is not open — once", async () => {
    // The setting names a destination and the words went somewhere else. Found
    // in a shell prompt with no explanation, that reads as a bug in dictation.
    act(() => {
      useSettingsStore.getState().setVoiceOption("routeTo", "roc");
    });
    render(<Harness />);
    await waitFor(() => expect(listeners.has("roctalk://ptt-down")).toBe(true));

    const dictate = async () => {
      act(() => listeners.get("roctalk://ptt-down")!({ payload: undefined }));
      await act(async () => {
        listeners.get("roctalk://ptt-up")!({ payload: undefined });
      });
    };

    await dictate();
    await waitFor(() =>
      expect(useToastsStore.getState().items).toHaveLength(1),
    );
    const toast = useToastsStore.getState().items[0]!;
    expect(toast.message).toMatch(/Roc is not open/);
    expect(toast.message).toMatch(/focused terminal/);
    expect(toast.tone).toBe("warn");

    // Nothing claiming the sink is a standing condition, not news twice.
    await dictate();
    await waitFor(() => expect(calls("terminal_write")).toHaveLength(2));
    expect(useToastsStore.getState().items).toHaveLength(1);
  });

  it("runs one recording when both sources report the same hold", async () => {
    // The DOM fallback and the Rust event can both fire for one press. Two
    // pipelines used to mean two recorders and two transcriptions.
    render(<Harness />);
    await waitFor(() => expect(listeners.has("roctalk://ptt-down")).toBe(true));

    act(() => {
      listeners.get("roctalk://ptt-down")!({ payload: undefined });
      window.dispatchEvent(
        new KeyboardEvent("keydown", { code: "Space", altKey: true }),
      );
    });
    await act(async () => {
      listeners.get("roctalk://ptt-up")!({ payload: undefined });
      window.dispatchEvent(
        new KeyboardEvent("keyup", { code: "Space", altKey: true }),
      );
    });

    await waitFor(() => expect(calls("terminal_write")).toHaveLength(1));
    expect(calls("roctalk_start_recording")).toHaveLength(1);
    expect(calls("roctalk_stop_recording_and_transcribe")).toHaveLength(1);
  });

  it("the DOM fallback follows the configured accelerator", async () => {
    render(<Harness />);
    await waitFor(() => expect(listeners.has("roctalk://ptt-down")).toBe(true));

    // Not the configured chord: nothing happens, and the key still reaches
    // whatever was going to receive it.
    holdKey({ code: "KeyR", altKey: true });
    expect(calls("roctalk_start_recording")).toEqual([]);

    holdKey({ code: "Space", altKey: true });
    expect(calls("roctalk_start_recording")).toHaveLength(1);

    act(() => {
      useSettingsStore.getState().setVoiceOption("accelerator", "Control+F13");
    });
    await waitFor(() =>
      expect(useSettingsStore.getState().voice.accelerator).toBe("Control+F13"),
    );

    holdKey({ code: "F13", ctrlKey: true });
    expect(calls("roctalk_start_recording")).toHaveLength(2);
  });

  it("ends the hold even when the modifier is released first", async () => {
    // Letting go of Alt a moment before Space leaves a keyup carrying no Alt at
    // all. Matching the whole chord there would leave the microphone open.
    render(<Harness />);
    await waitFor(() => expect(listeners.has("roctalk://ptt-down")).toBe(true));

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { code: "Space", altKey: true }),
      );
    });
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keyup", { code: "Space" }));
    });

    await waitFor(() =>
      expect(calls("roctalk_stop_recording_and_transcribe")).toHaveLength(1),
    );
  });

  it("keeps Caps Lock as the fallback on Windows, whatever is configured", async () => {
    // The keyboard hook owns PTT there and is hard-wired to Caps Lock; the
    // stored accelerator is inert.
    platformValue.current = "windows";
    render(<Harness />);
    await waitFor(() => expect(listeners.has("roctalk://ptt-down")).toBe(true));

    holdKey({ code: "Space", altKey: true });
    expect(calls("roctalk_start_recording")).toEqual([]);

    holdKey({ code: "CapsLock" });
    expect(calls("roctalk_start_recording")).toHaveLength(1);
  });

  it("stands down while RocTalk is off or the model is missing", async () => {
    render(<Harness />);
    await waitFor(() => expect(listeners.has("roctalk://ptt-down")).toBe(true));

    act(() => useRocTalkStore.setState({ enabled: false }));
    act(() => listeners.get("roctalk://ptt-down")!({ payload: undefined }));
    expect(calls("roctalk_start_recording")).toEqual([]);

    act(() =>
      useRocTalkStore.setState({ enabled: true, modelStatus: "missing" }),
    );
    act(() => listeners.get("roctalk://ptt-down")!({ payload: undefined }));
    expect(calls("roctalk_start_recording")).toEqual([]);
  });

  it("ignores download progress for a model the user is not watching", async () => {
    render(<Harness />);
    await waitFor(() =>
      expect(listeners.has("roctalk://download-progress")).toBe(true),
    );
    // The boot status check has already reported "ready", which fills the ring.
    act(() => useRocTalkStore.setState({ downloadProgress: 0 }));

    act(() =>
      listeners.get("roctalk://download-progress")!({
        payload: { modelSize: "small.en", received: 50, total: 100 },
      }),
    );
    expect(useRocTalkStore.getState().downloadProgress).toBe(0);

    act(() =>
      listeners.get("roctalk://download-progress")!({
        payload: { modelSize: "base.en", received: 50, total: 100 },
      }),
    );
    expect(useRocTalkStore.getState().downloadProgress).toBe(0.5);
  });
});
