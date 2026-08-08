import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
/** The user guide, read the same way `releaseMetadata.test.ts` reads the
 *  manifests: it and Settings describe the same behaviour to the same person,
 *  so they are checked against it together. */
import userGuide from "/docs/user-guide.md?raw";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

/** The platform, swappable per test. `platform()` normally reads a global the
 *  webview is seeded with; there is no webview here. */
const { platformValue } = vi.hoisted(() => ({
  platformValue: { current: "macos" as "macos" | "windows" },
}));
vi.mock("@tauri-apps/plugin-os", () => ({
  platform: () => platformValue.current,
}));

/** Settings writes are debounced; without a stand-in the timer fires into a
 *  missing Tauri runtime after the test has finished. */
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

const {
  DEFAULT_AGENT_DEFAULTS,
  DEFAULT_ROC_SETTINGS,
  DEFAULT_NOTIFICATION_SETTINGS,
  DEFAULT_VOICE_SETTINGS,
  useSettingsStore,
} = await import("@/stores/settings");
const { useRocTalkStore } = await import("@/stores/roctalk");
const { useZoomShortcuts } = await import("@/hooks/useZoomShortcuts");
const { DEFAULT_ZOOM } = await import("@/lib/zoom");
const { useToastsStore } = await import("@/stores/toasts");
const { AgentsSection } =
  await import("@/views/Settings/sections/AgentsSection");
const { NotificationsSection } =
  await import("@/views/Settings/sections/NotificationsSection");
const { VoiceSection } = await import("@/views/Settings/sections/VoiceSection");
const { ShortcutsSection } =
  await import("@/views/Settings/sections/ShortcutsSection");
const { AboutSection } = await import("@/views/Settings/sections/AboutSection");
const { HistorySection } =
  await import("@/views/Settings/sections/HistorySection");
const { useHistoryStore } = await import("@/stores/history");
const { useSavedSessionsStore } = await import("@/stores/savedSessions");
const { useUIStore } = await import("@/stores/ui");
const { useWorkspacesStore } = await import("@/stores/workspaces");
const { useTerminalsStore } = await import("@/stores/terminals");
const { answerConfirmsWith } = await import("@/test/confirm");

describe("AgentsSection", () => {
  beforeEach(() => {
    useSettingsStore.setState({
      agentDefaults: { ...DEFAULT_AGENT_DEFAULTS },
    });
  });

  it("edits every agent default", () => {
    render(<AgentsSection />);

    fireEvent.change(screen.getByLabelText("Default agent"), {
      target: { value: "codex" },
    });
    expect(useSettingsStore.getState().agentDefaults.agentType).toBe("codex");

    fireEvent.change(screen.getByLabelText("Default model"), {
      target: { value: "gpt-5" },
    });
    expect(useSettingsStore.getState().agentDefaults.model).toBe("gpt-5");

    fireEvent.click(screen.getByRole("radio", { name: /Auto-accept edits/ }));
    expect(useSettingsStore.getState().agentDefaults.permissionMode).toBe(
      "acceptEdits",
    );
  });

  it("keeps the permission group to one tab stop", () => {
    render(<AgentsSection />);

    const radios = screen.getAllByRole("radio");
    expect(radios.map((r) => r.tabIndex)).toEqual([0, -1, -1]);

    fireEvent.click(screen.getByRole("radio", { name: /Skip all/ }));

    // The roving stop follows the selection rather than staying put.
    expect(screen.getAllByRole("radio").map((r) => r.tabIndex)).toEqual([
      -1, -1, 0,
    ]);
  });

  it("arrow keys move through the permission group and select as they go", () => {
    render(<AgentsSection />);

    const group = screen.getByRole("radiogroup", { name: "Permission mode" });
    const mode = () => useSettingsStore.getState().agentDefaults.permissionMode;

    fireEvent.keyDown(group, { key: "ArrowDown" });
    expect(mode()).toBe("acceptEdits");

    fireEvent.keyDown(group, { key: "ArrowRight" });
    expect(mode()).toBe("skipAll");

    // Wraps rather than dead-ending, in both directions.
    fireEvent.keyDown(group, { key: "ArrowDown" });
    expect(mode()).toBe("ask");
    fireEvent.keyDown(group, { key: "ArrowUp" });
    expect(mode()).toBe("skipAll");
    fireEvent.keyDown(group, { key: "ArrowLeft" });
    expect(mode()).toBe("acceptEdits");

    // …and focus follows, so the next arrow lands on the same element.
    expect(document.activeElement).toBe(
      screen.getByRole("radio", { name: /Auto-accept edits/ }),
    );
  });

  it("warns only while Skip all is selected", () => {
    render(<AgentsSection />);
    expect(screen.queryByText(/willing to lose/)).toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: /Skip all/ }));

    expect(screen.getByText(/willing to lose/)).toBeInTheDocument();
  });

  /** The permission mode reaches exactly one CLI.
   *
   *  `permission_args` is called from `claude_code_spec` and nowhere else, so
   *  a Codex, OpenCode or shell pane launches with no permission flags. The
   *  red Skip-all warning read as a property of "an agent", which made it a
   *  warning about a setting that does nothing on three of the five types —
   *  and left the reverse unsaid, which is the half that matters: those panes
   *  run unrestricted no matter which mode is picked. */
  it("says which agent the permission modes reach", () => {
    render(<AgentsSection />);

    expect(screen.getByText(/only Claude Code/i)).toBeVisible();
    expect(screen.getByText(/no permission flags/i)).toBeVisible();
  });

  it("scopes the Skip all warning to the agent it is true of", () => {
    render(<AgentsSection />);
    fireEvent.click(screen.getByRole("radio", { name: /Skip all/ }));

    expect(screen.getByText(/willing to lose/).textContent).toMatch(
      /Claude Code/,
    );
  });

  /** Nothing in any UI can set `customArgs`, so `custom_spec` bails on the
   *  first `?` and the pane opens a plain interactive shell wearing a "Custom"
   *  badge. The type still loads and spawns — only the choice goes. */
  it("does not offer Custom as a default agent", () => {
    render(<AgentsSection />);

    const select = screen.getByLabelText("Default agent") as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
      "Claude Code",
      "Codex",
      "OpenCode",
      "Shell",
    ]);
  });

  it("still shows Custom when that is what is already stored", () => {
    // Withdrawing the option must not silently rewrite a stored default into
    // whatever happens to be first in the list.
    useSettingsStore.setState({
      agentDefaults: { ...DEFAULT_AGENT_DEFAULTS, agentType: "custom" },
    });
    render(<AgentsSection />);

    const select = screen.getByLabelText("Default agent") as HTMLSelectElement;
    expect(select.value).toBe("custom");
    expect(Array.from(select.options).map((o) => o.textContent)).toContain(
      "Custom",
    );
  });
});

describe("NotificationsSection", () => {
  const switches = () => useSettingsStore.getState().notifications;

  beforeEach(() => {
    useSettingsStore.setState({
      notifications: { ...DEFAULT_NOTIFICATION_SETTINGS },
    });
  });

  it("shows both sounds on and the mute off out of the box", () => {
    render(<NotificationsSection />);

    for (const name of [
      "Sound when an agent finishes",
      "Sound when an agent needs permission",
    ]) {
      expect(screen.getByRole("switch", { name })).toHaveAttribute(
        "aria-checked",
        "true",
      );
    }
    expect(
      screen.getByRole("switch", { name: "Mute every sound" }),
    ).toHaveAttribute("aria-checked", "false");
  });

  it("flips each switch independently", () => {
    render(<NotificationsSection />);

    fireEvent.click(
      screen.getByRole("switch", { name: "Sound when an agent finishes" }),
    );
    expect(switches()).toEqual({
      ...DEFAULT_NOTIFICATION_SETTINGS,
      turnFinishedSound: false,
    });

    fireEvent.click(screen.getByRole("switch", { name: "Mute every sound" }));
    expect(switches()).toEqual({
      turnFinishedSound: false,
      approvalSound: true,
      muted: true,
    });
  });

  /** What the bridge actually does, said in the place the user reads.
   *
   *  `notificationsBridge.ts` calls `markTurnFinished` unconditionally and only
   *  a modal holds the chime back, so the watched pane glows AND dings — see
   *  "does both for the pane you are watching, too" in
   *  `notificationsBridge.test.ts`. That is what was asked for; the copy is
   *  what was left behind, and a user who reads it concludes the pane in front
   *  of them is the one pane that stays quiet. */
  it("describes the watched pane the way the bridge treats it", () => {
    render(<NotificationsSection />);

    const copy = document.body.textContent ?? "";
    expect(copy).not.toMatch(/does neither/i);
    expect(copy).toMatch(/the one you are watching included/i);
  });

  it("and the user guide says the same thing", () => {
    expect(userGuide).not.toMatch(/does neither/i);
    expect(userGuide).toMatch(/the one you are watching included/i);
  });

  it("does not pretend every agent has a turn to finish", () => {
    // Only Claude Code reports a turn boundary (its lifecycle hooks). A section
    // that offered "sound when an agent finishes" without saying so would be
    // promising codex and shell panes something they cannot deliver.
    render(<NotificationsSection />);

    expect(screen.getByText(/Codex, opencode and plain shells/)).toBeVisible();
  });
});

describe("VoiceSection", () => {
  beforeEach(() => {
    platformValue.current = "macos";
    invoke.mockReset();
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "roctalk_list_input_devices") {
        return ["MacBook Pro Microphone", "Yeti Nano"];
      }
      if (cmd === "roc_list_voices") return ["Samantha", "Daniel"];
      return null;
    });
    useRocTalkStore.setState({
      enabled: true,
      modelStatus: "ready",
      downloadProgress: 0,
      capturingAccelerator: false,
    });
    useSettingsStore.setState({
      voice: { ...DEFAULT_VOICE_SETTINGS },
      roc: { ...DEFAULT_ROC_SETTINGS },
      zoom: DEFAULT_ZOOM,
    });
    useToastsStore.setState({ items: [] });
  });

  it("mirrors the RocTalk toggle the topbar drives", () => {
    render(<VoiceSection />);
    const toggle = screen.getByRole("switch", { name: "Enable RocTalk" });
    expect(toggle).toHaveAttribute("aria-checked", "true");

    fireEvent.click(toggle);

    expect(useRocTalkStore.getState().enabled).toBe(false);
  });

  it("offers a download only while the model is missing, for the size that is selected", () => {
    const { rerender } = render(<VoiceSection />);
    expect(screen.getByText("Ready")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Download model/ })).toBeNull();

    useSettingsStore.getState().setVoiceOption("modelSize", "small.en");
    useRocTalkStore.setState({ modelStatus: "missing" });
    rerender(<VoiceSection />);

    fireEvent.click(screen.getByRole("button", { name: /Download model/ }));

    // The size rides along: downloading the one that is NOT selected would
    // leave the user still unable to dictate.
    expect(invoke).toHaveBeenCalledWith("roctalk_download_model", {
      modelSize: "small.en",
    });
  });

  it("shows the download running instead of offering it again", async () => {
    // The status was left on "missing" for the whole fetch: the progress branch
    // was unreachable, the button stayed on screen, and every further click
    // came back from Rust as "already in progress" — to the console.
    let finish: (() => void) | null = null;
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "roctalk_download_model") {
        return new Promise<null>((resolve) => {
          finish = () => resolve(null);
        });
      }
      if (cmd === "roctalk_get_model_status") return "ready";
      if (cmd === "roctalk_list_input_devices") return [];
      return null;
    });
    useRocTalkStore.setState({ modelStatus: "missing", downloadProgress: 0 });
    render(<VoiceSection />);

    fireEvent.click(screen.getByRole("button", { name: /Download model/ }));

    expect(await screen.findByText("Downloading 0%")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Download model/ })).toBeNull();

    act(() => useRocTalkStore.getState().setDownloadProgress(0.42));
    expect(screen.getByText("Downloading 42%")).toBeInTheDocument();

    await act(async () => finish!());
    expect(await screen.findByText("Ready")).toBeInTheDocument();
  });

  it("says so when the download fails, and offers it again", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "roctalk_download_model")
        throw new Error("download HTTP 503");
      if (cmd === "roctalk_list_input_devices") return [];
      return null;
    });
    useRocTalkStore.setState({ modelStatus: "missing", downloadProgress: 0 });
    render(<VoiceSection />);

    fireEvent.click(screen.getByRole("button", { name: /Download model/ }));

    // Back to the offer — a spinner that never finishes would be a worse lie
    // than the button.
    expect(
      await screen.findByRole("button", { name: /Download model/ }),
    ).toBeInTheDocument();
    const toast = useToastsStore.getState().items.at(-1)!;
    expect(toast.message).toMatch(/base\.en/);
    expect(toast.message).toMatch(/503/);
    expect(toast.tone).toBe("warn");
  });

  it("edits the model, the microphone and the routing", async () => {
    render(<VoiceSection />);
    const voice = () => useSettingsStore.getState().voice;

    fireEvent.change(screen.getByLabelText("Speech model"), {
      target: { value: "tiny.en" },
    });
    expect(voice().modelSize).toBe("tiny.en");

    // The device list comes from cpal, through Rust.
    const mic = await screen.findByRole("option", { name: "Yeti Nano" });
    expect(mic).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Microphone"), {
      target: { value: "Yeti Nano" },
    });
    expect(voice().inputDevice).toBe("Yeti Nano");

    fireEvent.change(screen.getByLabelText("Send transcripts to"), {
      target: { value: "roc" },
    });
    expect(voice().routeTo).toBe("roc");
  });

  it("still offers a stored microphone that is not plugged in", async () => {
    useSettingsStore.getState().setVoiceOption("inputDevice", "Road Caster");
    render(<VoiceSection />);

    // Dropping it silently would show "System default" while the setting said
    // otherwise — and the next reconnect would change behaviour with nothing
    // on screen having changed.
    expect(
      await screen.findByRole("option", {
        name: /Road Caster \(not connected\)/,
      }),
    ).toBeInTheDocument();
    expect(useSettingsStore.getState().voice.inputDevice).toBe("Road Caster");
  });

  it("captures a new push-to-talk chord", () => {
    render(<VoiceSection />);
    const picker = screen.getByRole("button", {
      name: "Push-to-talk shortcut",
    });
    expect(picker).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(picker);
    expect(picker).toHaveAttribute("aria-pressed", "true");

    // Modifiers alone keep it armed — you are still reaching for the key.
    fireEvent.keyDown(document, { code: "ControlLeft", ctrlKey: true });
    expect(picker).toHaveAttribute("aria-pressed", "true");

    fireEvent.keyDown(document, {
      code: "KeyD",
      ctrlKey: true,
      shiftKey: true,
    });

    expect(useSettingsStore.getState().voice.accelerator).toBe(
      "Control+Shift+KeyD",
    );
    expect(picker).toHaveAttribute("aria-pressed", "false");
  });

  it("takes Caps Lock, and says what choosing it costs", () => {
    // Refusing it rewrote the stored key of anyone who dictates with Caps Lock
    // and gave them no way to ask for it back. Accepted with the limitation on
    // screen instead — it reaches RocSpace, and only RocSpace.
    render(<VoiceSection />);
    expect(
      screen.getByText(/Works while any application is in front/),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Push-to-talk shortcut" }),
    );
    fireEvent.keyDown(document, { code: "CapsLock" });

    expect(useSettingsStore.getState().voice.accelerator).toBe("CapsLock");
    expect(screen.getByRole("alert").textContent).toBe("");
    expect(screen.getByText(/only reaches RocSpace/)).toBeInTheDocument();
  });

  it("refuses a key that cannot be a global shortcut, and says why", () => {
    render(<VoiceSection />);
    fireEvent.click(
      screen.getByRole("button", { name: "Push-to-talk shortcut" }),
    );

    fireEvent.keyDown(document, { code: "Space" });

    expect(screen.getByRole("alert").textContent).toMatch(/cannot be a global/);
    expect(useSettingsStore.getState().voice.accelerator).toBe(
      DEFAULT_VOICE_SETTINGS.accelerator,
    );
  });

  it("Escape backs out of the capture without changing anything", () => {
    // And without closing Settings: the overlay's own Escape handler is on the
    // document too, so the picker has to stop the event in the capture phase.
    const onDocumentEscape = vi.fn();
    document.addEventListener("keydown", onDocumentEscape);
    render(<VoiceSection />);
    const picker = screen.getByRole("button", {
      name: "Push-to-talk shortcut",
    });
    fireEvent.click(picker);

    fireEvent.keyDown(document, { code: "Escape", key: "Escape" });

    expect(picker).toHaveAttribute("aria-pressed", "false");
    expect(useSettingsStore.getState().voice.accelerator).toBe(
      DEFAULT_VOICE_SETTINGS.accelerator,
    );
    expect(onDocumentEscape).not.toHaveBeenCalled();
    document.removeEventListener("keydown", onDocumentEscape);
  });

  it("resets to the default, and offers that only when it would do something", () => {
    render(<VoiceSection />);
    const reset = screen.getByRole("button", {
      name: /Reset the push-to-talk shortcut/,
    });
    expect(reset).toBeDisabled();

    act(() => {
      useSettingsStore.getState().setVoiceOption("accelerator", "Control+F13");
    });
    expect(reset).toBeEnabled();
    fireEvent.click(reset);

    expect(useSettingsStore.getState().voice.accelerator).toBe(
      DEFAULT_VOICE_SETTINGS.accelerator,
    );
  });

  /** The picker takes the keyboard, and "the keyboard" includes zoom.
   *
   *  Zoom is deliberately the one chord with no modal guard — it acts on the
   *  window, which is always visible — so it kept firing at a picker that had
   *  called `preventDefault` and `stopPropagation` on the same event. Neither
   *  helps: both listeners are on the document in the capture phase, and
   *  `stopPropagation` does not reach a co-located listener that is already
   *  registered. Pressing ⌘+ to BIND it scaled the window instead. */
  it("does not zoom the window while it is waiting for a chord", () => {
    function VoiceWithZoom() {
      // Registered first, exactly as `App` does it — the picker's listener is
      // added later, when it is armed.
      useZoomShortcuts();
      return <VoiceSection />;
    }
    render(<VoiceWithZoom />);
    fireEvent.click(
      screen.getByRole("button", { name: "Push-to-talk shortcut" }),
    );

    fireEvent.keyDown(document, { code: "Equal", key: "=", metaKey: true });

    expect(useSettingsStore.getState().voice.accelerator).toBe("Super+Equal");
    expect(useSettingsStore.getState().zoom).toBe(DEFAULT_ZOOM);
  });

  /** The picker validates the chord against the OS's grammar and nothing else,
   *  so ⌘K is a legal push-to-talk key — and RocTalk's DOM listener is on the
   *  window in the capture phase, ahead of every document handler in the app.
   *  Bind it and the command palette stops opening, with nothing on screen
   *  connecting the two. Said, not refused: it is the user's keyboard. */
  it("warns when the chord is one the app already binds", () => {
    render(<VoiceSection />);
    fireEvent.click(
      screen.getByRole("button", { name: "Push-to-talk shortcut" }),
    );

    fireEvent.keyDown(document, { code: "KeyK", metaKey: true });

    // Taken, not rejected.
    expect(useSettingsStore.getState().voice.accelerator).toBe("Super+KeyK");
    expect(screen.getByText(/command palette/i)).toBeVisible();
  });

  it("says nothing about a chord the app does not want", () => {
    // ⌥Space, the default, collides with nothing.
    render(<VoiceSection />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("keeps saying it after Settings is reopened", () => {
    // The collision belongs to the setting, not to the moment it was made in.
    useSettingsStore
      .getState()
      .setVoiceOption("accelerator", "Super+Shift+KeyM");
    render(<VoiceSection />);

    expect(screen.getByRole("status").textContent).toMatch(/RocMind/);
  });

  it("shows the keyboard hook's key on Windows instead of a picker", () => {
    // The accelerator and the LL hook are mutually exclusive, and the hook wins
    // there — offering a picker that binds nothing would be a lie.
    platformValue.current = "windows";
    render(<VoiceSection />);

    expect(screen.getByText("Caps Lock")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Push-to-talk shortcut" }),
    ).toBeNull();
  });
});

describe("VoiceSection — Roc", () => {
  /** What the LAST `roc_speak` was asked for — the text, the voice and the
   *  rate, as they reached the command. */
  const spokenArgs = ():
    { text: string; voice: string | null; rate: number | null } | undefined =>
    invoke.mock.calls
      .filter(([cmd]) => cmd === "roc_speak")
      .map(([, args]) => args)
      .pop() as
      { text: string; voice: string | null; rate: number | null } | undefined;

  beforeEach(() => {
    platformValue.current = "macos";
    invoke.mockReset();
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "roctalk_list_input_devices") return [];
      if (cmd === "roc_list_voices") return ["Samantha", "Daniel"];
      return null;
    });
    useSettingsStore.setState({
      voice: { ...DEFAULT_VOICE_SETTINGS },
      roc: { ...DEFAULT_ROC_SETTINGS },
    });
    useToastsStore.setState({ items: [] });
  });

  it("prefills the cheap default model and can put it back", () => {
    render(<VoiceSection />);
    const field = screen.getByLabelText("Roc's brain") as HTMLInputElement;
    expect(field.value).toBe(DEFAULT_ROC_SETTINGS.brainModel);

    fireEvent.change(field, { target: { value: "claude-sonnet-4-6" } });
    expect(useSettingsStore.getState().roc.brainModel).toBe(
      "claude-sonnet-4-6",
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Reset the brain model to the default",
      }),
    );
    expect(useSettingsStore.getState().roc.brainModel).toBe(
      DEFAULT_ROC_SETTINGS.brainModel,
    );
  });

  // Every turn is a `claude -p` call that re-sends Claude Code's own system
  // prompt. The user is entitled to know that before they hold the key down.
  it("says what a turn costs", () => {
    render(<VoiceSection />);
    expect(screen.getByText(/re-sends Claude Code/)).toBeInTheDocument();
  });

  it("offers the system voices, and can try one", async () => {
    render(<VoiceSection />);
    await waitFor(() =>
      expect(
        screen.getByRole("option", { name: "Samantha" }),
      ).toBeInTheDocument(),
    );

    fireEvent.change(screen.getByLabelText("Roc's voice"), {
      target: { value: "Samantha" },
    });
    expect(useSettingsStore.getState().roc.speechVoice).toBe("Samantha");

    fireEvent.click(screen.getByRole("button", { name: "Audition" }));
    await waitFor(() =>
      expect(spokenArgs()).toMatchObject({ voice: "Samantha" }),
    );
  });

  it("offers every manner with a line saying what it is", () => {
    render(<VoiceSection />);

    const select = screen.getByLabelText("Roc's manner") as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
      "Plain — an ordinary, helpful sentence",
      "Butler — terse, dry, faintly formal",
    ]);
    expect(select.value).toBe("plain");

    fireEvent.change(select, { target: { value: "butler" } });
    expect(useSettingsStore.getState().roc.persona).toBe("butler");
  });

  // The persona changes the WORDING. Somebody who reads this row as "pick a
  // celebrity voice" has been misled, and the row is where that is settled.
  it("says the manner shapes the wording and not the voice", () => {
    render(<VoiceSection />);
    expect(screen.getByText(/not which voice says it/)).toBeInTheDocument();
    // …and the voices are the ones this machine already has.
    expect(screen.getByText(/voices macOS provides/)).toBeInTheDocument();
  });

  it("shows the speaking rate in words per minute, and stores it", () => {
    render(<VoiceSection />);
    const slider = screen.getByLabelText("Speaking rate") as HTMLInputElement;

    expect(screen.getByText("175 wpm")).toBeInTheDocument();
    expect(slider.min).toBe("120");
    expect(slider.max).toBe("260");

    fireEvent.change(slider, { target: { value: "230" } });

    expect(useSettingsStore.getState().roc.speechRate).toBe(230);
    expect(screen.getByText("230 wpm")).toBeInTheDocument();
  });

  // The button is auditioning the CHOICE, so the sentence has to change with
  // it: a fixed line would only ever demonstrate the voice, which is the one
  // thing the manner picker is not choosing.
  it("auditions a different line per manner, at the chosen rate", async () => {
    render(<VoiceSection />);

    fireEvent.click(screen.getByRole("button", { name: "Audition" }));
    await waitFor(() => expect(spokenArgs()).not.toBeUndefined());
    const plain = spokenArgs();
    expect(plain).toMatchObject({ rate: 175, voice: null });

    fireEvent.change(screen.getByLabelText("Roc's manner"), {
      target: { value: "butler" },
    });
    fireEvent.change(screen.getByLabelText("Speaking rate"), {
      target: { value: "140" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Audition" }));

    await waitFor(() => expect(spokenArgs()?.rate).toBe(140));
    expect(spokenArgs()?.text).not.toBe(plain?.text);
  });

  // Auditioning is how somebody decides whether to switch speech on. A button
  // that went quiet because it is off would be the worst possible answer.
  it("auditions even with spoken replies switched off", async () => {
    useSettingsStore.getState().setRocOption("speakReplies", false);
    render(<VoiceSection />);

    fireEvent.click(screen.getByRole("button", { name: "Audition" }));

    await waitFor(() => expect(spokenArgs()).not.toBeUndefined());
  });

  it("keeps a stored voice this machine has never heard of", async () => {
    useSettingsStore.setState({
      roc: { ...DEFAULT_ROC_SETTINGS, speechVoice: "Moira" },
    });
    render(<VoiceSection />);

    await waitFor(() =>
      expect(
        screen.getByRole("option", { name: "Moira (not installed)" }),
      ).toBeInTheDocument(),
    );
  });

  // Off by default, and loud about what turning it on means: a fan-out cannot
  // be taken back.
  it("warns only once auto-dispatch is actually on", () => {
    const { rerender } = render(<VoiceSection />);
    expect(screen.queryByText(/before you can read it/)).toBeNull();

    fireEvent.click(
      screen.getByRole("switch", {
        name: "Dispatch Roc's plans without confirming",
      }),
    );
    rerender(<VoiceSection />);

    expect(useSettingsStore.getState().roc.autoDispatch).toBe(true);
    expect(screen.getByText(/before you can read it/)).toBeInTheDocument();
  });

  it("says plainly that spoken replies are a macOS thing", () => {
    platformValue.current = "windows";
    render(<VoiceSection />);

    expect(screen.getByText(/on screen only/)).toBeInTheDocument();
  });

  // …and so are the two controls that hang off them. A slider that moves and
  // changes nothing and a button that plays silence are worse than no controls
  // at all: they leave somebody unable to tell whether it is the voice, the
  // build or their speakers.
  it("does not offer a rate or an audition this system cannot play", () => {
    platformValue.current = "windows";
    render(<VoiceSection />);

    expect(screen.getByLabelText("Speaking rate")).toBeDisabled();
    const audition = screen.getByRole("button", { name: "Audition" });
    expect(audition).toBeDisabled();
    fireEvent.click(audition);
    expect(invoke.mock.calls.filter(([cmd]) => cmd === "roc_speak")).toEqual(
      [],
    );

    // Each row says why where it is, rather than leaving the silence to be
    // interpreted.
    expect(screen.getByText(/rate needs macOS/)).toBeInTheDocument();
    expect(screen.getByText(/Auditioning needs macOS/)).toBeInTheDocument();
  });

  it("offers both where there is a voice to hear", () => {
    render(<VoiceSection />);

    expect(screen.getByLabelText("Speaking rate")).toBeEnabled();
    expect(screen.getByRole("button", { name: "Audition" })).toBeEnabled();
  });
});

describe("ShortcutsSection", () => {
  beforeEach(() => {
    platformValue.current = "macos";
    useSettingsStore.setState({ voice: { ...DEFAULT_VOICE_SETTINGS } });
  });

  it("lists the bindings that exist today", () => {
    render(<ShortcutsSection />);

    expect(screen.getByRole("table")).toBeInTheDocument();
    // Nothing aspirational, and nothing missing either. This row used to
    // assert the OPPOSITE — that no ⌘K chord was listed, because none was
    // bound; the palette landing is what turned an honest absence into an
    // omission.
    expect(screen.getByText(/Open the command palette/)).toBeInTheDocument();
  });

  it("prints the push-to-talk key that is actually bound", () => {
    // The row used to say "Caps Lock" for ever. It is a setting now, and a
    // table that promises the whole list cannot print a key nothing answers to.
    const { rerender } = render(<ShortcutsSection />);
    expect(screen.getByText("⌥")).toBeInTheDocument();
    expect(screen.getAllByText("Space").length).toBeGreaterThan(0);

    act(() => {
      useSettingsStore.getState().setVoiceOption("accelerator", "Control+F13");
    });
    rerender(<ShortcutsSection />);
    expect(screen.getByText("⌃")).toBeInTheDocument();
    expect(screen.getByText("F13")).toBeInTheDocument();

    // …and on Windows it is the hook's key, whatever is stored.
    platformValue.current = "windows";
    rerender(<ShortcutsSection />);
    expect(screen.getByText("Caps Lock")).toBeInTheDocument();
  });

  it("does not promise a bare key reaches further than it does", () => {
    // The header calls this the whole list, which makes an inaccurate scope a
    // lie. Nothing global carries a bare key outside the Windows hook.
    const { rerender } = render(<ShortcutsSection />);
    expect(
      screen.getByText(/Anywhere, while RocTalk is on/),
    ).toBeInTheDocument();

    act(() => {
      useSettingsStore.getState().setVoiceOption("accelerator", "CapsLock");
    });
    rerender(<ShortcutsSection />);

    expect(screen.queryByText(/Anywhere, while RocTalk is on/)).toBeNull();
    expect(
      screen.getByText(/While RocSpace is in front, RocTalk is on/),
    ).toBeInTheDocument();
  });

  it("does not omit the bindings that are easy to forget", () => {
    // The header promises "the whole list — not a selection", so a missing row
    // is a false claim. These two were absent while the promise was already on
    // screen: arrowing through the theme cards, and opening a notification.
    render(<ShortcutsSection />);

    expect(screen.getByText(/Move to the next option/)).toBeInTheDocument();
    // `getAllByText`: ↑ and ↓ now key two rows — Settings' option browsing and
    // the sidebar's workspace list — and the claim here is that the key is
    // listed at all, not that it is listed once.
    for (const arrow of ["↑", "↓", "←", "→"]) {
      expect(screen.getAllByText(arrow).length).toBeGreaterThan(0);
    }
    expect(
      screen.getByText(/Open the notification's terminal/),
    ).toBeInTheDocument();
  });

  // Same promise, the keys this phase added. A confirmation answers Enter
  // itself, and ⌘_ is a real second spelling of zoom out — both were bound
  // while the table said it was the whole list.
  it("lists what the confirmation dialog and the zoom aliases bind", () => {
    render(<ShortcutsSection />);

    expect(
      screen.getByText(/Answer yes to a confirmation/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Answer no to a confirmation/)).toBeInTheDocument();
    // The aliases are named in the scope of the row they belong to rather than
    // printed as rows of their own — see the header for why.
    expect(
      screen.getByText(/⌘= is the same key unshifted/),
    ).toBeInTheDocument();
    expect(screen.getByText(/⌘_ is the same key shifted/)).toBeInTheDocument();
  });

  it("lists what the workspace list and the modal answer to", () => {
    // Both were bound and unlisted: a workspace row activates on Enter/Space,
    // and the New Workspace modal holds Tab inside itself and closes on
    // Escape. A binding the user has to discover by accident is one the "whole
    // list" promise says is not there.
    render(<ShortcutsSection />);

    expect(
      screen.getByText("Switch to the focused workspace"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/focus cannot leave the dialog/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Close the New Workspace modal/),
    ).toBeInTheDocument();
  });

  /** "Anywhere" was not anywhere.
   *
   *  ⌘⇧M, ⌘⇧R, ⌘⇧K, ⌘S, ⌘P and the four pane chords are bound by hooks that
   *  live in `AppShell` / `RocDock`, and `App.tsx` renders neither with zero
   *  workspaces open — which is a state you can reach by closing the last one.
   *  Every one of those rows claimed to work "anywhere except…". */
  it("does not claim a chord works where nothing binds it", () => {
    render(<ShortcutsSection />);
    const scopeOf = (action: RegExp) =>
      screen.getByText(action).closest("tr")?.textContent ?? "";

    for (const action of [
      /Show RocMind/,
      /Show Roc, or go back/,
      /Open the Git panel/,
      /Save the file the editor is on/,
      /Open a file by name/,
      /Split the focused pane to the right/,
      /Close the focused pane/,
    ]) {
      expect(scopeOf(action)).toMatch(/at least one workspace open/);
    }
    // ⌘T is the counter-example, and the reason the distinction is worth
    // drawing: it is bound in `App`, above the gate, so it really does work
    // with nothing open — which is the only state it is any use in.
    expect(scopeOf(/^New workspace$/)).not.toMatch(/at least one workspace/);
  });

  /** Two real handlers the "whole list" promise did not cover: the Roc
   *  widget's mode radiogroup, and the key the push-to-talk picker swallows
   *  while it is armed. Both are in the app's own audit comment now too. */
  it("lists the widget's mode switch and the picker's capture", () => {
    render(<ShortcutsSection />);

    expect(screen.getByText(/what the push-to-talk key does/i)).toBeVisible();
    expect(screen.getByText(/Bind it as push-to-talk/i)).toBeVisible();
  });

  /** The Browser panel is a native child webview (`window.add_child`), not an
   *  iframe: its key events belong to a different window and never reach the
   *  document where all sixteen chord handlers live. Every shortcut in this
   *  table is dead while it has focus, and nothing said so. */
  it("says the shortcuts die while the Browser panel has focus", () => {
    render(<ShortcutsSection />);

    expect(screen.getByText(/Browser panel/)).toBeVisible();
    expect(screen.getByText(/its own window/)).toBeVisible();
  });

  it("says where the chords stand down, in the words the guard uses", () => {
    // The scope column used to name the New Workspace modal specifically,
    // which read as a complete list and was not one — the Save session prompt
    // was missing from it and from the pane chords' guard both. One rule,
    // stated once, and the ⌘⇧S row says the prompt it opens is covered too.
    render(<ShortcutsSection />);

    expect(screen.getAllByText(/any open modal/).length).toBeGreaterThan(5);
    expect(
      screen.getByText(/the Save session prompt included/),
    ).toBeInTheDocument();
    expect(screen.getByText(/it owns the keyboard/)).toBeInTheDocument();
  });
});

describe("HistorySection", () => {
  const meta = (name: string, paneCount = 2) => ({
    name,
    savedAt: 1_700_000_000_000,
    workspaceName: "rocspace",
    paneCount,
  });

  const payload = {
    workspaceName: "rocspace",
    paneCount: 1,
    workspace: { name: "rocspace", accent: "cyan", projectPath: null },
    terminals: [{ id: "s1", name: "Rocky", agentConfig: { type: "shell" } }],
  };

  beforeEach(() => {
    invoke.mockReset();
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "session_list") return [meta("friday"), meta("spike", 4)];
      if (cmd === "session_load") return payload;
      return null;
    });
    useSavedSessionsStore.setState({
      sessions: [],
      loaded: false,
      error: null,
    });
    useHistoryStore.setState({ failures: [] });
    useWorkspacesStore.setState({ workspaces: [], activeWorkspaceId: null });
    useTerminalsStore.setState({ byId: {} });
    useUIStore.setState({ isSettingsOpen: true });
  });

  it("lists the saved sessions with what is in each one", async () => {
    render(<HistorySection />);

    expect(await screen.findByText("friday")).toBeInTheDocument();
    expect(screen.getByText(/rocspace · 4 panes/)).toBeInTheDocument();
  });

  it("restores one and gets out of the way", async () => {
    // The restored workspace is now active behind the overlay; standing in
    // front of it would make the button look like it did nothing.
    render(<HistorySection />);
    await screen.findByText("friday");

    fireEvent.click(screen.getAllByRole("button", { name: /Restore/ })[0]!);

    await waitFor(() =>
      expect(useUIStore.getState().isSettingsOpen).toBe(false),
    );
    expect(useWorkspacesStore.getState().workspaces).toHaveLength(1);
  });

  it("confirms before deleting", async () => {
    const confirms = answerConfirmsWith(false);
    render(<HistorySection />);
    await screen.findByText("friday");

    fireEvent.click(screen.getByRole("button", { name: "Delete friday" }));

    await waitFor(() => expect(confirms.asked[0]?.message).toContain("friday"));
    expect(invoke.mock.calls.some(([c]) => c === "session_delete")).toBe(false);
    confirms.restore();
  });

  it("shows why a pane could not be started, and what kind of failure it was", async () => {
    // A console.warn is a message in a window the user does not have open. The
    // pane that never came up is otherwise indistinguishable from one that was
    // never started.
    useHistoryStore.getState().recordFailure({
      kind: "resume",
      name: "Roxie",
      workspaceName: "rocspace",
      error: "claude: no conversation with that id",
    });
    render(<HistorySection />);

    expect(
      await screen.findByText("claude: no conversation with that id"),
    ).toBeInTheDocument();
    expect(screen.getByText("Roxie")).toBeInTheDocument();
    expect(screen.getByText("resume")).toBeInTheDocument();
  });

  it("shows a session that could not be restored, with no workspace to blame", async () => {
    // A restore fails before there is a pane or a workspace, so the row names
    // the file and stops there rather than inventing somewhere for it to have
    // failed.
    useHistoryStore.getState().recordFailure({
      kind: "restore",
      name: "monday",
      workspaceName: null,
      error: '"monday" has no panes in it — the file is empty or corrupt',
    });
    render(<HistorySection />);

    expect(await screen.findByText(/has no panes in it/)).toBeInTheDocument();
    expect(screen.getByText("restore")).toBeInTheDocument();
    expect(screen.getByText("monday").textContent).toBe("monday");
  });

  it("clears the failures on demand", async () => {
    useHistoryStore.getState().recordFailure({
      kind: "spawn",
      name: "Rocky",
      workspaceName: "rocspace",
      error: "claude: command not found",
    });
    render(<HistorySection />);
    await screen.findByText("claude: command not found");

    fireEvent.click(screen.getByRole("button", { name: /Clear/ }));

    expect(useHistoryStore.getState().failures).toEqual([]);
    expect(screen.getByText(/Nothing has failed to start/)).toBeVisible();
  });

  it("says so when there is nothing to show, rather than showing nothing", async () => {
    invoke.mockImplementation(async () => []);
    render(<HistorySection />);

    expect(await screen.findByText(/Nothing saved yet/)).toBeInTheDocument();
    expect(screen.getByText(/Nothing has failed to start/)).toBeVisible();
  });

  /** `error` was written by six code paths and read by none.
   *
   *  A `session_list` that threw set `loaded: true` with an empty list, so the
   *  screen said "Nothing saved yet" — an assertion about the disk that the
   *  app had just failed to check. */
  describe("when the store cannot be read", () => {
    it("says the list failed rather than that it is empty", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      invoke.mockRejectedValue(new Error("no permission"));
      render(<HistorySection />);

      expect(await screen.findByText(/no permission/)).toBeInTheDocument();
      expect(screen.queryByText(/Nothing saved yet/)).toBeNull();
      warn.mockRestore();
    });
  });

  /** Restoring a session whose file was deleted or corrupted outside the app
   *  did nothing at all: no toast, no row change, no history entry. The
   *  empty-payload branch beside it already filed a failure — the catch branch
   *  swallowed the same event. */
  it("records and shows a restore that could not read its file", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    render(<HistorySection />);
    await screen.findByText("friday");
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "session_list") return [meta("friday")];
      if (cmd === "session_load") throw new Error("No such file or directory");
      return null;
    });

    fireEvent.click(screen.getAllByRole("button", { name: /Restore/ })[0]!);

    // Twice on this screen, and deliberately: the banner over the list says
    // the click failed, the failure row below says what was attempted and
    // when. They are answers to different questions.
    expect(
      await screen.findAllByText(/No such file or directory/),
    ).toHaveLength(2);
    expect(useHistoryStore.getState().failures[0]).toMatchObject({
      kind: "restore",
      name: "friday",
      workspaceName: null,
    });
    // And Settings stays put: nothing was opened behind it.
    expect(useUIStore.getState().isSettingsOpen).toBe(true);
    warn.mockRestore();
  });
});

describe("AboutSection", () => {
  it("renders without a Tauri runtime and shows a placeholder version", () => {
    render(<AboutSection />);

    expect(screen.getByText("RocSpace")).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Open on GitHub/ }),
    ).toBeInTheDocument();
  });
});
