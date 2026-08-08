import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ZOOM } from "@/lib/zoom";
import { DEFAULT_THEME_ID, getTheme, THEMES } from "@/themes/registry";

/** In-memory stand-in for tauri-plugin-store. `files` is keyed by file name so
 *  a test can assert we wrote to `settings.dat` and nothing else. */
const { files } = vi.hoisted(() => ({
  files: new Map<string, Map<string, unknown>>(),
}));

vi.mock("@tauri-apps/plugin-store", () => {
  class FakeStore {
    constructor(private readonly file: string) {}
    static async load(file: string): Promise<FakeStore> {
      if (!files.has(file)) files.set(file, new Map());
      return new FakeStore(file);
    }
    private data(): Map<string, unknown> {
      let d = files.get(this.file);
      if (!d) {
        d = new Map();
        files.set(this.file, d);
      }
      return d;
    }
    async get<T>(key: string): Promise<T | undefined> {
      return this.data().get(key) as T | undefined;
    }
    async set(key: string, value: unknown): Promise<void> {
      this.data().set(key, value);
    }
    async delete(key: string): Promise<void> {
      this.data().delete(key);
    }
    async save(): Promise<void> {}
  }
  return { Store: FakeStore };
});

const {
  DEFAULT_AGENT_DEFAULTS,
  DEFAULT_ROC_SETTINGS,
  DEFAULT_NOTIFICATION_SETTINGS,
  DEFAULT_TERMINAL_SETTINGS,
  DEFAULT_VOICE_SETTINGS,
  ROC_SPEECH_RATE_MAX,
  ROC_SPEECH_RATE_MIN,
  SETTINGS_FILE,
  SETTINGS_KEY,
  saveSettingsNow,
  useSettingsStore,
} = await import("@/stores/settings");

function persisted(): Record<string, unknown> | undefined {
  return files.get(SETTINGS_FILE)?.get(SETTINGS_KEY) as
    Record<string, unknown> | undefined;
}

/** A theme id that is not the default — exercises the "switch" path. */
const otherThemeId =
  THEMES.find((t) => t.id !== DEFAULT_THEME_ID)?.id ?? DEFAULT_THEME_ID;

describe("useSettingsStore", () => {
  beforeEach(() => {
    files.clear();
    useSettingsStore.setState({
      themeId: DEFAULT_THEME_ID,
      terminal: { ...DEFAULT_TERMINAL_SETTINGS },
      agentDefaults: { ...DEFAULT_AGENT_DEFAULTS },
      voice: { ...DEFAULT_VOICE_SETTINGS },
      notifications: { ...DEFAULT_NOTIFICATION_SETTINGS },
    });
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.removeAttribute("style");
  });

  it("defaults to the default theme", () => {
    expect(useSettingsStore.getState().themeId).toBe(DEFAULT_THEME_ID);
  });

  it("defaults terminal + agent settings", () => {
    const s = useSettingsStore.getState();
    expect(s.terminal).toEqual({ fontSize: 13, scrollback: 5000 });
    expect(s.agentDefaults).toEqual({
      agentType: "claude-code",
      model: null,
      permissionMode: "ask",
    });
  });

  it("keeps the exported defaults frozen", () => {
    // They double as the sanitizers' per-field fallbacks, so a write here does
    // not just change the initial state — it redefines "default" for every
    // value that ever fails validation, for the rest of the process.
    expect(Object.isFrozen(DEFAULT_TERMINAL_SETTINGS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_AGENT_DEFAULTS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_VOICE_SETTINGS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_NOTIFICATION_SETTINGS)).toBe(true);
  });

  it("setThemeId updates state and paints the document", async () => {
    useSettingsStore.getState().setThemeId(otherThemeId);

    const theme = getTheme(otherThemeId);
    expect(useSettingsStore.getState().themeId).toBe(theme.id);
    expect(document.documentElement.getAttribute("data-theme")).toBe(theme.id);
    expect(
      document.documentElement.style.getPropertyValue("--rs-background"),
    ).toBe(theme.tokens.background);
    expect(
      document.documentElement.style.getPropertyValue("--rs-primary"),
    ).toBe(theme.tokens.primary);
  });

  it("normalizes unknown theme ids to the default", () => {
    useSettingsStore.getState().setThemeId("no-such-theme");
    expect(useSettingsStore.getState().themeId).toBe(DEFAULT_THEME_ID);
    expect(document.documentElement.getAttribute("data-theme")).toBe(
      DEFAULT_THEME_ID,
    );
  });

  it("persists everything to settings.dat under a versioned shape", async () => {
    useSettingsStore.getState().setThemeId(otherThemeId);
    useSettingsStore.getState().setTerminalOption("fontSize", 16);
    useSettingsStore.getState().setAgentDefault("permissionMode", "skipAll");
    await saveSettingsNow();

    expect(persisted()).toEqual({
      version: 7,
      themeId: otherThemeId,
      terminal: { fontSize: 16, scrollback: 5000 },
      agentDefaults: {
        agentType: "claude-code",
        model: null,
        permissionMode: "skipAll",
      },
      voice: { ...DEFAULT_VOICE_SETTINGS },
      roc: { ...DEFAULT_ROC_SETTINGS },
      notifications: { ...DEFAULT_NOTIFICATION_SETTINGS },
      zoom: DEFAULT_ZOOM,
      whatsNewSeen: "",
    });
    // The workspace snapshot file must stay untouched by settings writes.
    expect(files.has("workspace.dat")).toBe(false);
  });

  it("hydrate restores and applies a persisted theme", async () => {
    files.set(
      SETTINGS_FILE,
      new Map([[SETTINGS_KEY, { version: 2, themeId: otherThemeId }]]),
    );

    await useSettingsStore.getState().hydrate();

    expect(useSettingsStore.getState().themeId).toBe(otherThemeId);
    expect(document.documentElement.getAttribute("data-theme")).toBe(
      otherThemeId,
    );
  });

  it("hydrate restores terminal + agent settings from a v2 payload", async () => {
    files.set(
      SETTINGS_FILE,
      new Map([
        [
          SETTINGS_KEY,
          {
            version: 2,
            themeId: otherThemeId,
            terminal: { fontSize: 18, scrollback: 10000 },
            agentDefaults: {
              agentType: "codex",
              model: "gpt-5",
              permissionMode: "acceptEdits",
            },
          },
        ],
      ]),
    );

    await useSettingsStore.getState().hydrate();

    const s = useSettingsStore.getState();
    expect(s.terminal).toEqual({ fontSize: 18, scrollback: 10000 });
    expect(s.agentDefaults).toEqual({
      agentType: "codex",
      model: "gpt-5",
      permissionMode: "acceptEdits",
    });
  });

  /** The pickers no longer offer `custom`, but the validator still knows it:
   *  rewriting a stored default on load would change what the user's next pane
   *  launches without telling them. Settings shows the stored value and stops
   *  offering it — see `agentChoices`. */
  it("keeps a stored default of the withdrawn Custom type", async () => {
    files.set(
      SETTINGS_FILE,
      new Map([
        [
          SETTINGS_KEY,
          {
            version: 2,
            agentDefaults: {
              agentType: "custom",
              model: null,
              permissionMode: "ask",
            },
          },
        ],
      ]),
    );

    await useSettingsStore.getState().hydrate();

    expect(useSettingsStore.getState().agentDefaults.agentType).toBe("custom");
  });

  it("migrates a v1 payload (theme only) to today's defaults", async () => {
    files.set(
      SETTINGS_FILE,
      new Map([[SETTINGS_KEY, { version: 1, themeId: otherThemeId }]]),
    );

    await useSettingsStore.getState().hydrate();

    const s = useSettingsStore.getState();
    expect(s.themeId).toBe(otherThemeId);
    expect(s.terminal).toEqual(DEFAULT_TERMINAL_SETTINGS);
    expect(s.agentDefaults).toEqual(DEFAULT_AGENT_DEFAULTS);
    expect(s.voice).toEqual(DEFAULT_VOICE_SETTINGS);
    expect(s.roc).toEqual(DEFAULT_ROC_SETTINGS);

    // …and the next write upgrades the file on disk.
    await saveSettingsNow();
    expect(persisted()).toMatchObject({ version: 7 });
  });

  it("hydrate sanitizes out-of-range and unknown persisted values", async () => {
    files.set(
      SETTINGS_FILE,
      new Map([
        [
          SETTINGS_KEY,
          {
            version: 2,
            themeId: otherThemeId,
            terminal: { fontSize: 99, scrollback: "lots" },
            agentDefaults: {
              agentType: "skynet",
              model: "   ",
              permissionMode: "yolo",
            },
          },
        ],
      ]),
    );

    await useSettingsStore.getState().hydrate();

    const s = useSettingsStore.getState();
    expect(s.terminal).toEqual({
      fontSize: 20,
      scrollback: DEFAULT_TERMINAL_SETTINGS.scrollback,
    });
    expect(s.agentDefaults).toEqual(DEFAULT_AGENT_DEFAULTS);
  });

  it("hydrate tolerates unknown fields and future-shaped payloads", async () => {
    files.set(
      SETTINGS_FILE,
      new Map([
        [
          SETTINGS_KEY,
          { version: 99, themeId: otherThemeId, somethingNew: { a: 1 } },
        ],
      ]),
    );

    await useSettingsStore.getState().hydrate();

    expect(useSettingsStore.getState().themeId).toBe(otherThemeId);
  });

  it("hydrate falls back to the default when nothing (or garbage) is stored", async () => {
    await useSettingsStore.getState().hydrate();
    expect(useSettingsStore.getState().themeId).toBe(DEFAULT_THEME_ID);
    expect(document.documentElement.getAttribute("data-theme")).toBe(
      DEFAULT_THEME_ID,
    );

    files.set(SETTINGS_FILE, new Map([[SETTINGS_KEY, { themeId: 42 }]]));
    await useSettingsStore.getState().hydrate();
    expect(useSettingsStore.getState().themeId).toBe(DEFAULT_THEME_ID);
  });

  it("hydrate leaves a theme the user picked mid-flight alone", async () => {
    // settings.dat holds the default; the user switches while the read is
    // still in flight. Hydrate must not revert them — and must not leave the
    // debounced save about to write the reverted id back to disk.
    files.set(
      SETTINGS_FILE,
      new Map([[SETTINGS_KEY, { version: 2, themeId: DEFAULT_THEME_ID }]]),
    );

    const inFlight = useSettingsStore.getState().hydrate();
    useSettingsStore.getState().setThemeId(otherThemeId);
    await inFlight;

    expect(useSettingsStore.getState().themeId).toBe(otherThemeId);
    expect(document.documentElement.getAttribute("data-theme")).toBe(
      otherThemeId,
    );
    await saveSettingsNow();
    expect(persisted()).toMatchObject({ themeId: otherThemeId });
  });

  it("hydrate leaves any setting edited mid-flight alone", async () => {
    // Same guard, but for the 0C fields: the dirty counter has to cover every
    // setter or hydrate silently reverts a non-theme edit. Everything on disk
    // is NON-default, so a hydrate that bails wholesale is visible here rather
    // than hidden behind values that happen to match the defaults.
    files.set(
      SETTINGS_FILE,
      new Map([
        [
          SETTINGS_KEY,
          {
            version: 2,
            themeId: otherThemeId,
            terminal: { fontSize: 11, scrollback: 1000 },
            agentDefaults: {
              agentType: "shell",
              model: null,
              permissionMode: "acceptEdits",
            },
          },
        ],
      ]),
    );

    const inFlight = useSettingsStore.getState().hydrate();
    useSettingsStore.getState().setTerminalOption("fontSize", 17);
    await inFlight;

    expect(useSettingsStore.getState().terminal.fontSize).toBe(17);
    await saveSettingsNow();
    expect(persisted()).toMatchObject({ terminal: { fontSize: 17 } });
  });

  it("hydrate keeps the edited group only — the rest still load from disk", async () => {
    // The whole payload is non-default and the user touches exactly ONE field
    // group mid-flight. A single store-wide dirty counter discards the entire
    // persisted blob here, and the debounced save then writes defaults over
    // the user's stored theme and agent defaults. Guard per group instead.
    files.set(
      SETTINGS_FILE,
      new Map([
        [
          SETTINGS_KEY,
          {
            version: 2,
            themeId: otherThemeId,
            terminal: { fontSize: 11, scrollback: 1000 },
            agentDefaults: {
              agentType: "codex",
              model: "gpt-5",
              permissionMode: "skipAll",
            },
          },
        ],
      ]),
    );

    const inFlight = useSettingsStore.getState().hydrate();
    useSettingsStore.getState().setTerminalOption("fontSize", 17);
    await inFlight;

    const s = useSettingsStore.getState();
    // Untouched groups hydrate from disk…
    expect(s.themeId).toBe(otherThemeId);
    expect(document.documentElement.getAttribute("data-theme")).toBe(
      otherThemeId,
    );
    expect(s.agentDefaults).toEqual({
      agentType: "codex",
      model: "gpt-5",
      permissionMode: "skipAll",
    });
    // …and only the edited group keeps the user's value (the rest of that
    // group still comes off disk).
    expect(s.terminal).toEqual({ fontSize: 17, scrollback: 1000 });

    // Crucially, the pending save must not write defaults back over disk.
    await saveSettingsNow();
    expect(persisted()).toEqual({
      version: 7,
      themeId: otherThemeId,
      terminal: { fontSize: 17, scrollback: 1000 },
      agentDefaults: {
        agentType: "codex",
        model: "gpt-5",
        permissionMode: "skipAll",
      },
      voice: { ...DEFAULT_VOICE_SETTINGS },
      roc: { ...DEFAULT_ROC_SETTINGS },
      notifications: { ...DEFAULT_NOTIFICATION_SETTINGS },
      zoom: DEFAULT_ZOOM,
      whatsNewSeen: "",
    });
  });

  it("setTerminalOption clamps and rounds", () => {
    const { setTerminalOption } = useSettingsStore.getState();

    setTerminalOption("fontSize", 13.6);
    expect(useSettingsStore.getState().terminal.fontSize).toBe(14);
    setTerminalOption("fontSize", 3);
    expect(useSettingsStore.getState().terminal.fontSize).toBe(10);
    setTerminalOption("fontSize", 400);
    expect(useSettingsStore.getState().terminal.fontSize).toBe(20);
    setTerminalOption("fontSize", Number.NaN);
    expect(useSettingsStore.getState().terminal.fontSize).toBe(13);

    setTerminalOption("scrollback", 250);
    expect(useSettingsStore.getState().terminal.scrollback).toBe(1000);
    setTerminalOption("scrollback", 999_999);
    expect(useSettingsStore.getState().terminal.scrollback).toBe(10000);
  });

  it("setAgentDefault normalizes the model string", () => {
    const { setAgentDefault } = useSettingsStore.getState();

    setAgentDefault("model", "  claude-opus-4-7  ");
    expect(useSettingsStore.getState().agentDefaults.model).toBe(
      "claude-opus-4-7",
    );
    // Blank means "whatever the CLI defaults to", stored as null.
    setAgentDefault("model", "   ");
    expect(useSettingsStore.getState().agentDefaults.model).toBeNull();
  });

  it("setVoiceOption stores a canonical accelerator and refuses a broken one", () => {
    const { setVoiceOption } = useSettingsStore.getState();
    const voice = () => useSettingsStore.getState().voice;

    setVoiceOption("accelerator", "control+shift+keyr");
    expect(voice().accelerator).toBe("Control+Shift+KeyR");

    // A chord the OS cannot bind is not stored — the picker validates before
    // calling, so anything that reaches here is a hand-edited file or a bug,
    // and either way the user must be left with a working key.
    setVoiceOption("accelerator", "Alt+Nope");
    expect(voice().accelerator).toBe(DEFAULT_VOICE_SETTINGS.accelerator);
    setVoiceOption("accelerator", "Space");
    expect(voice().accelerator).toBe(DEFAULT_VOICE_SETTINGS.accelerator);

    // …but Caps Lock is kept. It is not an OS shortcut and is never sent to
    // one; it is the key RocTalk shipped with, and rewriting it to ⌥Space on
    // load is how an upgrade silently takes someone's dictation key away.
    setVoiceOption("accelerator", "capslock");
    expect(voice().accelerator).toBe("CapsLock");
  });

  it("setVoiceOption validates the rest of the voice group", () => {
    const { setVoiceOption } = useSettingsStore.getState();
    const voice = () => useSettingsStore.getState().voice;

    setVoiceOption("modelSize", "small.en");
    expect(voice().modelSize).toBe("small.en");
    setVoiceOption("modelSize", "large-v3" as never);
    expect(voice().modelSize).toBe(DEFAULT_VOICE_SETTINGS.modelSize);

    setVoiceOption("routeTo", "roc");
    expect(voice().routeTo).toBe("roc");
    setVoiceOption("routeTo", "somewhere" as never);
    expect(voice().routeTo).toBe(DEFAULT_VOICE_SETTINGS.routeTo);

    // "" is a real value — the system default device — so it survives.
    setVoiceOption("inputDevice", "  Yeti Nano  ");
    expect(voice().inputDevice).toBe("Yeti Nano");
    setVoiceOption("inputDevice", "");
    expect(voice().inputDevice).toBe("");
  });

  it("hydrate reads a v3 voice block and sanitizes it field by field", async () => {
    files.set(
      SETTINGS_FILE,
      new Map([
        [
          SETTINGS_KEY,
          {
            version: 3,
            themeId: otherThemeId,
            voice: {
              accelerator: "cmd+shift+keyd",
              modelSize: "tiny.en",
              inputDevice: "Yeti Nano",
              routeTo: "roc",
            },
          },
        ],
      ]),
    );

    await useSettingsStore.getState().hydrate();

    expect(useSettingsStore.getState().voice).toEqual({
      accelerator: "Shift+Super+KeyD",
      modelSize: "tiny.en",
      inputDevice: "Yeti Nano",
      routeTo: "roc",
    });

    // One bad field costs that field, not the block.
    files.set(
      SETTINGS_FILE,
      new Map([
        [
          SETTINGS_KEY,
          {
            version: 3,
            themeId: otherThemeId,
            voice: {
              accelerator: "not a chord",
              modelSize: "small.en",
              inputDevice: 42,
              routeTo: "roc",
            },
          },
        ],
      ]),
    );
    await useSettingsStore.getState().hydrate();

    expect(useSettingsStore.getState().voice).toEqual({
      accelerator: DEFAULT_VOICE_SETTINGS.accelerator,
      modelSize: "small.en",
      inputDevice: "",
      routeTo: "roc",
    });
  });

  it("migrates a v2 payload by giving it today's voice defaults", async () => {
    // The upgrade that matters most: an existing install keeps base.en, which
    // is the model it already has on disk, rather than being switched to one it
    // would have to download before it could dictate again.
    files.set(
      SETTINGS_FILE,
      new Map([
        [
          SETTINGS_KEY,
          {
            version: 2,
            themeId: otherThemeId,
            terminal: { fontSize: 18, scrollback: 10000 },
            agentDefaults: {
              agentType: "codex",
              model: "gpt-5",
              permissionMode: "acceptEdits",
            },
          },
        ],
      ]),
    );

    await useSettingsStore.getState().hydrate();

    const s = useSettingsStore.getState();
    expect(s.voice).toEqual(DEFAULT_VOICE_SETTINGS);
    expect(s.voice.modelSize).toBe("base.en");
    // …and everything v2 did hold is still there.
    expect(s.terminal).toEqual({ fontSize: 18, scrollback: 10000 });
    expect(s.agentDefaults.agentType).toBe("codex");

    await saveSettingsNow();
    expect(persisted()).toMatchObject({
      version: 7,
      voice: { ...DEFAULT_VOICE_SETTINGS },
    });
  });

  it("hydrate leaves a voice option edited mid-flight alone", async () => {
    files.set(
      SETTINGS_FILE,
      new Map([
        [
          SETTINGS_KEY,
          {
            version: 3,
            themeId: otherThemeId,
            voice: {
              accelerator: "Control+F13",
              modelSize: "tiny.en",
              inputDevice: "Yeti Nano",
              routeTo: "roc",
            },
          },
        ],
      ]),
    );

    const inFlight = useSettingsStore.getState().hydrate();
    useSettingsStore.getState().setVoiceOption("modelSize", "small.en");
    await inFlight;

    const s = useSettingsStore.getState();
    expect(s.voice.modelSize).toBe("small.en");
    // The rest of the group still loads from disk.
    expect(s.voice.accelerator).toBe("Control+F13");
    expect(s.voice.routeTo).toBe("roc");
  });

  it("defaults both notification sounds on and the mute off", () => {
    // The defaults are the whole upgrade story for an existing install: it
    // keeps the approval ding it already had, gains the turn signal this phase
    // restores, and nothing is silently muted on their behalf.
    expect(useSettingsStore.getState().notifications).toEqual({
      turnFinishedSound: true,
      approvalSound: true,
      muted: false,
    });
  });

  it("setNotificationOption flips a switch and refuses a non-boolean", () => {
    const { setNotificationOption } = useSettingsStore.getState();
    const notifications = () => useSettingsStore.getState().notifications;

    setNotificationOption("turnFinishedSound", false);
    expect(notifications().turnFinishedSound).toBe(false);
    setNotificationOption("muted", true);
    expect(notifications().muted).toBe(true);

    // Silence is the one outcome a bad value must not be able to produce, so
    // garbage lands on the switch's default rather than on `false`.
    setNotificationOption("approvalSound", "yes" as never);
    expect(notifications().approvalSound).toBe(true);
  });

  it("migrates a v4 payload by giving it today's notification defaults", async () => {
    files.set(
      SETTINGS_FILE,
      new Map([
        [
          SETTINGS_KEY,
          {
            version: 4,
            themeId: otherThemeId,
            terminal: { fontSize: 18, scrollback: 10000 },
            voice: { ...DEFAULT_VOICE_SETTINGS },
            zoom: DEFAULT_ZOOM,
            whatsNewSeen: "phase-5",
          },
        ],
      ]),
    );

    await useSettingsStore.getState().hydrate();

    const s = useSettingsStore.getState();
    expect(s.notifications).toEqual(DEFAULT_NOTIFICATION_SETTINGS);
    // …and everything v4 did hold is still there.
    expect(s.terminal).toEqual({ fontSize: 18, scrollback: 10000 });
    expect(s.whatsNewSeen).toBe("phase-5");

    await saveSettingsNow();
    expect(persisted()).toMatchObject({
      version: 7,
      notifications: { ...DEFAULT_NOTIFICATION_SETTINGS },
    });
  });

  it("hydrate reads a v5 notifications block and sanitizes it field by field", async () => {
    files.set(
      SETTINGS_FILE,
      new Map([
        [
          SETTINGS_KEY,
          {
            version: 6,
            themeId: otherThemeId,
            notifications: {
              turnFinishedSound: false,
              approvalSound: "loud",
              muted: true,
            },
          },
        ],
      ]),
    );

    await useSettingsStore.getState().hydrate();

    // One bad field costs that field, not the block.
    expect(useSettingsStore.getState().notifications).toEqual({
      turnFinishedSound: false,
      approvalSound: true,
      muted: true,
    });
  });

  it("hydrate leaves a notification switch flipped mid-flight alone", async () => {
    files.set(
      SETTINGS_FILE,
      new Map([
        [
          SETTINGS_KEY,
          {
            version: 6,
            themeId: otherThemeId,
            notifications: {
              turnFinishedSound: false,
              approvalSound: false,
              muted: true,
            },
          },
        ],
      ]),
    );

    const inFlight = useSettingsStore.getState().hydrate();
    useSettingsStore.getState().setNotificationOption("muted", false);
    await inFlight;

    const s = useSettingsStore.getState();
    expect(s.notifications.muted).toBe(false);
    // The rest of the group still loads from disk.
    expect(s.notifications.turnFinishedSound).toBe(false);
    expect(s.notifications.approvalSound).toBe(false);
  });

  it("hydrate never rejects when the plugin store is unavailable", async () => {
    // Fresh module graph so the store module has not cached a working handle.
    vi.resetModules();
    const plugin = await import("@tauri-apps/plugin-store");
    const spy = vi
      .spyOn(plugin.Store, "load")
      .mockRejectedValue(new Error("no tauri here"));
    const fresh = await import("@/stores/settings");

    await expect(
      fresh.useSettingsStore.getState().hydrate(),
    ).resolves.toBeUndefined();
    expect(fresh.useSettingsStore.getState().themeId).toBe(DEFAULT_THEME_ID);
    expect(document.documentElement.getAttribute("data-theme")).toBe(
      DEFAULT_THEME_ID,
    );
    // Settled, not successful. Anything waiting on the read has to be released
    // by a file that is missing or a plugin that is not there — those are
    // answers, and holding the app for them would be waiting forever.
    expect(fresh.useSettingsStore.getState().hydrated).toBe(true);
    spy.mockRestore();
  });

  describe("hydrated", () => {
    it("starts false and is set when the read settles", async () => {
      vi.resetModules();
      const fresh = await import("@/stores/settings");
      expect(fresh.useSettingsStore.getState().hydrated).toBe(false);

      await fresh.useSettingsStore.getState().hydrate();
      expect(fresh.useSettingsStore.getState().hydrated).toBe(true);
    });

    // One commit, not two: a subscriber woken by the flag reads the store in
    // the same render, and it must not find the defaults it was waiting to
    // stop reading.
    it("lands in the same update as the values it vouches for", async () => {
      vi.resetModules();
      files.set(
        SETTINGS_FILE,
        new Map([[SETTINGS_KEY, { version: 4, whatsNewSeen: "phase-4" }]]),
      );
      const fresh = await import("@/stores/settings");

      const seenWhenHydrated: string[] = [];
      const unsubscribe = fresh.useSettingsStore.subscribe((s) => {
        if (s.hydrated) seenWhenHydrated.push(s.whatsNewSeen);
      });
      await fresh.useSettingsStore.getState().hydrate();
      unsubscribe();

      expect(seenWhenHydrated).toEqual(["phase-4"]);
    });
  });
});

describe("Roc's settings", () => {
  const roc = () => useSettingsStore.getState().roc;
  const setRocOption = (
    ...args: Parameters<
      ReturnType<typeof useSettingsStore.getState>["setRocOption"]
    >
  ) => useSettingsStore.getState().setRocOption(...args);

  beforeEach(() => {
    files.clear();
    useSettingsStore.setState({ roc: { ...DEFAULT_ROC_SETTINGS } });
  });

  // Cheap and fast by default: print mode re-sends Claude Code's whole system
  // prompt every call, so the model is what decides whether a routing question
  // costs a fraction of a cent or a fifth of a dollar.
  it("defaults to a cheap model, and to proposing rather than sending", () => {
    expect(DEFAULT_ROC_SETTINGS.brainModel).toBe("claude-haiku-4-5-20251001");
    expect(DEFAULT_ROC_SETTINGS.autoDispatch).toBe(false);
  });

  it("trims and bounds the model, which becomes an argv element", () => {
    setRocOption("brainModel", "  claude-sonnet-4-6  ");
    expect(roc().brainModel).toBe("claude-sonnet-4-6");

    // Blank is a real value: "let the CLI choose".
    setRocOption("brainModel", "   ");
    expect(roc().brainModel).toBe("");

    setRocOption("brainModel", "m".repeat(500));
    expect(roc().brainModel).toHaveLength(100);

    setRocOption("brainModel", 42 as never);
    expect(roc().brainModel).toBe(DEFAULT_ROC_SETTINGS.brainModel);
  });

  it("keeps the flags boolean", () => {
    setRocOption("autoDispatch", true);
    expect(roc().autoDispatch).toBe(true);

    setRocOption("autoDispatch", "yes" as never);
    expect(roc().autoDispatch).toBe(DEFAULT_ROC_SETTINGS.autoDispatch);

    setRocOption("speakReplies", false);
    expect(roc().speakReplies).toBe(false);
  });

  it("takes a voice name and lets it be blank for the system default", () => {
    setRocOption("speechVoice", "  Samantha  ");
    expect(roc().speechVoice).toBe("Samantha");
    setRocOption("speechVoice", "");
    expect(roc().speechVoice).toBe("");
  });

  // A persona changes the words a user hears. Nobody is given a new one
  // because they upgraded — they have to go and ask for it.
  it("defaults to the plain persona and an unhurried rate", () => {
    expect(DEFAULT_ROC_SETTINGS.persona).toBe("plain");
    expect(DEFAULT_ROC_SETTINGS.speechRate).toBe(175);
  });

  it("takes only a persona it knows", () => {
    setRocOption("persona", "butler");
    expect(roc().persona).toBe("butler");

    setRocOption("persona", "pirate" as never);
    expect(roc().persona).toBe(DEFAULT_ROC_SETTINGS.persona);

    setRocOption("persona", 7 as never);
    expect(roc().persona).toBe(DEFAULT_ROC_SETTINGS.persona);
  });

  // The rate becomes `-r <n>` in `say`'s argv, so it is a whole number in a
  // band a person can follow — Rust clamps it again rather than trusting this.
  it("clamps the speech rate into the band say can be asked for", () => {
    setRocOption("speechRate", 200);
    expect(roc().speechRate).toBe(200);

    setRocOption("speechRate", ROC_SPEECH_RATE_MIN - 60);
    expect(roc().speechRate).toBe(ROC_SPEECH_RATE_MIN);

    setRocOption("speechRate", ROC_SPEECH_RATE_MAX + 9000);
    expect(roc().speechRate).toBe(ROC_SPEECH_RATE_MAX);

    setRocOption("speechRate", 180.6);
    expect(roc().speechRate).toBe(181);

    setRocOption("speechRate", "fast" as never);
    expect(roc().speechRate).toBe(DEFAULT_ROC_SETTINGS.speechRate);
  });

  // v6 → v7: a `roc` block written before the persona existed keeps every
  // choice in it and takes the two new defaults, which sound like what that
  // user already had.
  it("hydrates a v6 roc block into today's persona and rate", async () => {
    files.set(
      SETTINGS_FILE,
      new Map([
        [
          SETTINGS_KEY,
          {
            version: 6,
            roc: {
              brainModel: "claude-haiku-4-5",
              speakReplies: true,
              speechVoice: "Alex",
              autoDispatch: true,
            },
          },
        ],
      ]),
    );

    await useSettingsStore.getState().hydrate();

    const s = useSettingsStore.getState();
    expect(s.roc.speechVoice).toBe("Alex");
    expect(s.roc.autoDispatch).toBe(true);
    expect(s.roc.persona).toBe(DEFAULT_ROC_SETTINGS.persona);
    expect(s.roc.speechRate).toBe(DEFAULT_ROC_SETTINGS.speechRate);

    await saveSettingsNow();
    expect(persisted()).toMatchObject({ version: 7 });
  });

  // The whole v4 → v5 migration: a file with no `roc` key is a file that gets
  // today's defaults, and everything it DID hold survives.
  it("hydrates a v4 file into today's Roc defaults", async () => {
    files.set(
      SETTINGS_FILE,
      new Map([
        [
          SETTINGS_KEY,
          {
            version: 4,
            themeId: otherThemeId,
            terminal: { fontSize: 18, scrollback: 10000 },
          },
        ],
      ]),
    );

    await useSettingsStore.getState().hydrate();

    const s = useSettingsStore.getState();
    expect(s.roc).toEqual(DEFAULT_ROC_SETTINGS);
    expect(s.terminal).toEqual({ fontSize: 18, scrollback: 10000 });

    await saveSettingsNow();
    expect(persisted()).toMatchObject({
      version: 7,
      roc: { ...DEFAULT_ROC_SETTINGS },
    });
  });

  it("hydrate sanitizes a hand-edited roc block field by field", async () => {
    files.set(
      SETTINGS_FILE,
      new Map([
        [
          SETTINGS_KEY,
          {
            version: 6,
            roc: {
              brainModel: "  claude-haiku-4-5  ",
              speakReplies: "loudly",
              speechVoice: 7,
              autoDispatch: true,
              persona: "jeeves",
              speechRate: 9000,
            },
          },
        ],
      ]),
    );

    await useSettingsStore.getState().hydrate();

    expect(useSettingsStore.getState().roc).toEqual({
      brainModel: "claude-haiku-4-5",
      speakReplies: DEFAULT_ROC_SETTINGS.speakReplies,
      speechVoice: DEFAULT_ROC_SETTINGS.speechVoice,
      autoDispatch: true,
      persona: DEFAULT_ROC_SETTINGS.persona,
      speechRate: ROC_SPEECH_RATE_MAX,
    });
  });

  // Same rule as every other group: a value the user changed while the read was
  // still in flight wins, and the rest of the group still comes off disk.
  it("hydrate leaves a roc option edited mid-flight alone", async () => {
    files.set(
      SETTINGS_FILE,
      new Map([
        [
          SETTINGS_KEY,
          {
            version: 6,
            roc: {
              brainModel: "from-disk",
              speakReplies: false,
              speechVoice: "Alex",
              autoDispatch: false,
            },
          },
        ],
      ]),
    );

    const hydrating = useSettingsStore.getState().hydrate();
    useSettingsStore.getState().setRocOption("brainModel", "mine");
    await hydrating;

    const s = useSettingsStore.getState();
    expect(s.roc.brainModel).toBe("mine");
    expect(s.roc.speechVoice).toBe("Alex");
  });
});
