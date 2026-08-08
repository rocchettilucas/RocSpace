/** App settings — theme, terminal options, and agent defaults.
 *
 *  Settings live in their OWN tauri-plugin-store file (`settings.dat`), not in
 *  the workspace snapshot: they must survive "reset workspace", they are not
 *  per-project, and they must not ride the workspace schema version. The
 *  load/debounced-save shape deliberately mirrors `src/lib/persistence.ts`. */

import { Store } from "@tauri-apps/plugin-store";
import { create } from "zustand";
import { devtools } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";
import { normalizeAccelerator } from "@/lib/accelerator";
import { isMacOS } from "@/lib/platform";
import { applyZoom, DEFAULT_ZOOM, nearestZoomStep } from "@/lib/zoom";
import { AGENT_TYPES } from "@/lib/agentLabels";
import {
  WHISPER_MODEL_SIZES,
  type AgentType,
  type WhisperModelSize,
} from "@/lib/bindings";
import { applyTheme } from "@/themes/apply";
import { DEFAULT_THEME_ID, getTheme } from "@/themes/registry";

export const SETTINGS_FILE = "settings.dat";
export const SETTINGS_KEY = "settings";
/** Bump when the persisted shape changes incompatibly.
 *    v1: { version, themeId }.
 *    v2: + { terminal, agentDefaults }.
 *    v3: + { voice }.
 *    v4: + { zoom, whatsNewSeen }.
 *    v5: + { roc } (Phase 6) and + { notifications } (Phase 7). Both slices
 *        were authored on parallel branches that each called themselves v5;
 *        the merged app is v6 and reads either ancestor by field, so a
 *        settings.dat written by either branch upgrades cleanly.
 *    v7: + { roc.persona, roc.speechRate }. Read by field like every slice
 *        before it, so a v6 file keeps its Roc block and takes the two new
 *        defaults — which are the plain wording and the rate it already had. */
const SETTINGS_VERSION = 7;
const SAVE_DEBOUNCE_MS = 300;

// Settings vocabulary ----------------------------------------------------

/** Terminal font size the picker offers, and the range anything read off disk
 *  is clamped into. Below 10 the agent CLIs' box drawing collapses; above 20 a
 *  16-pane grid stops fitting a usable number of columns. */
export const TERMINAL_FONT_SIZE_MIN = 10;
export const TERMINAL_FONT_SIZE_MAX = 20;

/** Scrollback presets the picker offers. Arbitrary values in between are
 *  accepted from disk (only the bounds are enforced) so the list can change
 *  without invalidating anyone's stored setting. */
export const SCROLLBACK_OPTIONS = [1000, 2000, 5000, 10000] as const;
const SCROLLBACK_MIN = SCROLLBACK_OPTIONS[0];
const SCROLLBACK_MAX = SCROLLBACK_OPTIONS[SCROLLBACK_OPTIONS.length - 1]!;

/** How much a freshly spawned agent may do without asking. Wired into spawn in
 *  Phase 1 — today this is a stored preference only. */
export type PermissionMode = "ask" | "acceptEdits" | "skipAll";

export const PERMISSION_MODES: readonly PermissionMode[] = [
  "ask",
  "acceptEdits",
  "skipAll",
];

export interface TerminalSettings {
  fontSize: number;
  scrollback: number;
}

export interface AgentDefaults {
  agentType: AgentType;
  /** `null` = let the CLI pick its own default model. */
  model: string | null;
  permissionMode: PermissionMode;
}

// Voice ------------------------------------------------------------------

/** Where a finished transcript goes.
 *
 *  `terminal` is what RocTalk has always done — type it into the focused pane.
 *  `roc` hands it to Roc's command bar instead, where it can be aimed at
 *  several agents before it is sent anywhere. */
export type VoiceRoute = "terminal" | "roc";

export const VOICE_ROUTES: readonly VoiceRoute[] = ["terminal", "roc"];

export interface VoiceSettings {
  /** Global push-to-talk chord, in `global_hotkey`'s spelling
   *  (`"Alt+Space"`). Inert on Windows, where the keyboard hook owns PTT. */
  accelerator: string;
  modelSize: WhisperModelSize;
  /** Input device NAME, or `""` for the system default. A name rather than an
   *  id because that is the only handle cpal offers, and it is what survives a
   *  reboot. */
  inputDevice: string;
  routeTo: VoiceRoute;
}

/** The character of Roc's spoken replies — the WORDING, and nothing else.
 *
 *  Worth being blunt about, because the obvious misreading is the expensive
 *  one: this does not change the voice. The voice is whichever one macOS offers
 *  under `speechVoice`, and no persona adds, licenses or imitates a voice. What
 *  it changes is the sentence Roc writes before that voice reads it.
 *
 *    * `plain` — what Roc has always said. A normal, helpful sentence.
 *    * `butler` — terse, dry, faintly formal. "Rocky has finished the auth
 *      test, sir. Two files changed." rather than "Great news! I sent that to
 *      Rocky!"
 *
 *  A union rather than a boolean because a third one is a plausible Tuesday,
 *  and `ROC_PERSONAS` plus the prompt constants in `lib/rocBrain` are then the
 *  whole of what a new one costs. */
export type RocPersona = "plain" | "butler";

export const ROC_PERSONAS: readonly RocPersona[] = ["plain", "butler"];

/** The band `say -r` may be asked for, and what the slider offers.
 *
 *  `say` itself takes far wider numbers and both ends of that range are
 *  useless: below ~120 wpm a sentence takes long enough that the user has moved
 *  on, and above ~260 it stops being language. Rust clamps to the same two
 *  numbers rather than trusting whatever reaches the command — a hand-edited
 *  settings file is a caller too. */
export const ROC_SPEECH_RATE_MIN = 120;
export const ROC_SPEECH_RATE_MAX = 260;

/** What Roc's brain does with what you say.
 *
 *  Under Voice rather than in a section of its own because it is the second
 *  half of the same sentence: you hold the key, you say something, and these
 *  decide what happens to it. */
export interface RocSettings {
  /** The model `claude -p` reasons with. A string rather than a picker because
   *  the list changes faster than this app ships, and Claude Code takes both
   *  aliases (`haiku`) and full ids. Blank means "let the CLI choose", which is
   *  the expensive default — see `DEFAULT_ROC_SETTINGS`. */
  brainModel: string;
  /** Say the reply out loud. */
  speakReplies: boolean;
  /** A voice name from `rocListVoices`; `""` is the system default. */
  speechVoice: string;
  /** How Roc words the reply. See `RocPersona` — wording, not voice. */
  persona: RocPersona;
  /** Words per minute for `say -r`, in `[ROC_SPEECH_RATE_MIN,
   *  ROC_SPEECH_RATE_MAX]`. */
  speechRate: number;
  /** Send the brain's assignments the moment it produces them, rather than
   *  showing them for confirmation first. OFF by default and that is
   *  deliberate: the brain PROPOSES and the user confirms. A mishearing that
   *  reaches one agent is a conversation; a mishearing that reaches four at
   *  once cannot be taken back. */
  autoDispatch: boolean;
}

// Notifications ----------------------------------------------------------

/** What the app is allowed to make a noise about.
 *
 *  Only the sounds. The visible signals — the bell's list, the green glow on a
 *  pane whose agent just finished — are not switchable here on purpose: they
 *  cost nothing to ignore, and a user who mutes the room is asking for quiet,
 *  not for blindness. `muted` therefore silences without suppressing anything
 *  you can see. */
export interface NotificationSettings {
  /** Ding when an agent ENDS A TURN in a pane you are not looking at. Restores
   *  the signal Phase 3 removed — see `lib/notificationsBridge.ts` for why it
   *  is scoped to the panes you are not watching rather than to all of them. */
  turnFinishedSound: boolean;
  /** Ding when an agent stops to ask for permission. What the app has always
   *  done; a switch now rather than a fact. */
  approvalSound: boolean;
  /** Master mute. Wins over both switches above and over the kinds that have
   *  no switch (a process exiting, a crash, a card sent to review). */
  muted: boolean;
}

// Frozen, and exported that way. These are not just the initial state: the
// sanitizers below read them as their per-field fallbacks, so one stray write
// would retroactively redefine what "default" means for every value that ever
// fails validation. Callers who want a mutable copy spread them (`defaultState`
// does); `Readonly<…>` makes anyone who forgets fail to compile, and the freeze
// catches the same mistake from untyped reach.

export const DEFAULT_TERMINAL_SETTINGS: Readonly<TerminalSettings> =
  Object.freeze({
    fontSize: 13,
    // Matches what `useXterm` hard-coded before this became a setting —
    // lowering the default would silently throw away scrollback people already
    // have.
    scrollback: 5000,
  });

export const DEFAULT_AGENT_DEFAULTS: Readonly<AgentDefaults> = Object.freeze({
  agentType: "claude-code",
  model: null,
  permissionMode: "ask",
});

/** What drives push-to-talk on Windows, where `voice.accelerator` is inert.
 *
 *  `src-tauri/src/roctalk/hotkey.rs` installs a WH_KEYBOARD_LL hook on bare
 *  Caps Lock and swallows it, which is strictly better than an accelerator
 *  there — and which is why the two are mutually exclusive (see
 *  `src-tauri/src/roctalk/ptt.rs`). Not a setting: it is a fact about that
 *  build, and both the Settings row and the renderer's fallback listener read
 *  it from here rather than each spelling it out. */
export const WINDOWS_PTT_ACCELERATOR = "CapsLock";

export const DEFAULT_VOICE_SETTINGS: Readonly<VoiceSettings> = Object.freeze({
  // Right Option — the push-to-talk key people ask for — is a lone modifier,
  // and a lone modifier is not an accelerator on any platform. ⌥Space is the
  // nearest thing that is: free on a stock macOS (which binds ⌘Space and
  // ⌃Space, not ⌥Space) and reachable with one hand.
  accelerator: "Alt+Space",
  // What RocTalk shipped with, so an existing install's downloaded model is
  // still the one it uses after this upgrade.
  modelSize: "base.en",
  inputDevice: "",
  routeTo: "terminal",
});

/** Cheap and fast, which is the whole job: the brain reads a roster and writes
 *  a sentence plus a couple of prompts. Print mode re-sends Claude Code's own
 *  system prompt on every call — roughly sixteen thousand tokens — so the model
 *  is what decides whether a turn costs a fraction of a cent or a fifth of a
 *  dollar, and a routing question does not need a frontier model.
 *
 *  Speech defaults ON where there is a `say` to do it with and off everywhere
 *  else, so the setting matches what the platform can actually do.
 *
 *  The persona defaults to `plain` and the rate to what `say` does anyway,
 *  because an upgrade must not change what an existing user hears. Somebody who
 *  wants a butler goes and asks for one. */
export const DEFAULT_ROC_SETTINGS: Readonly<RocSettings> = Object.freeze({
  brainModel: "claude-haiku-4-5-20251001",
  speakReplies: isMacOS(),
  speechVoice: "",
  autoDispatch: false,
  persona: "plain",
  // `say`'s own default, so a fresh install and every install that predates
  // this setting sound identical.
  speechRate: 175,
});
export const DEFAULT_NOTIFICATION_SETTINGS: Readonly<NotificationSettings> =
  Object.freeze({
    turnFinishedSound: true,
    approvalSound: true,
    muted: false,
  });

interface PersistedSettings {
  version: number;
  themeId: string;
  terminal: TerminalSettings;
  agentDefaults: AgentDefaults;
  voice: VoiceSettings;
  roc: RocSettings;
  notifications: NotificationSettings;
  zoom: number;
  whatsNewSeen: string;
}

/** The fields that live in `settings.dat`. Split out from the state because
 *  `migrate` and `defaultState` produce exactly these — everything the store
 *  knows about itself rather than about the user's choices belongs below. */
interface StoredSettings {
  themeId: string;
  terminal: TerminalSettings;
  agentDefaults: AgentDefaults;
  voice: VoiceSettings;
  roc: RocSettings;
  notifications: NotificationSettings;
  /** App zoom, as a multiplier on the root font size. One of `ZOOM_STEPS`;
   *  see `lib/zoom.ts` for why it is the root font size and not a transform. */
  zoom: number;
  /** The changelog entry whose "What's new" the user has already read, by id
   *  (`"phase-5"`). `""` means none — either a first launch or an upgrade from
   *  a build that predates the modal, and both should be told what changed. */
  whatsNewSeen: string;
}

interface SettingsState extends StoredSettings {
  /** Has `settings.dat` been read — or given up on?
   *
   *  False until `hydrate` settles, and never false again. It is not "did the
   *  read succeed": a missing file and a corrupt one both leave the defaults in
   *  place, and both are answers. What it rules out is the window BEFORE the
   *  answer, which is real and reachable — `main.tsx` renders the app after a
   *  250 ms race, so the whole UI is live while a slow read is outstanding.
   *
   *  Anything that acts on a stored value ONCE, at startup, has to wait for
   *  this or it acts on the default. "What's new" is the case that made it a
   *  field: `whatsNewSeen` is `""` until the read lands, so a mount-only check
   *  announces the release again to somebody who dismissed it yesterday. */
  hydrated: boolean;
}

interface SettingsActions {
  /** Switch theme: normalizes unknown ids, repaints the document, persists. */
  setThemeId: (id: string) => void;
  /** Update one terminal option. Values are clamped, so callers may pass raw
   *  input (a stepper click, a parsed field) without pre-validating. */
  setTerminalOption: <K extends keyof TerminalSettings>(
    key: K,
    value: TerminalSettings[K],
  ) => void;
  /** Update one agent default. Blank model strings normalize to `null`. */
  setAgentDefault: <K extends keyof AgentDefaults>(
    key: K,
    value: AgentDefaults[K],
  ) => void;
  /** Update one voice option. An accelerator that is not a chord the OS can
   *  bind falls back to the default rather than being stored — callers that
   *  want to tell the user why should validate with `normalizeAccelerator`
   *  first. */
  setVoiceOption: <K extends keyof VoiceSettings>(
    key: K,
    value: VoiceSettings[K],
  ) => void;
  /** Update one of Roc's options. Strings are trimmed and bounded, the speech
   *  rate is clamped into its band, and an unknown persona falls back to the
   *  default; a blank model means "let the CLI choose". */
  setRocOption: <K extends keyof RocSettings>(
    key: K,
    value: RocSettings[K],
  ) => void;
  /** Update one notification option. Anything that is not a boolean falls back
   *  to that switch's default. */
  setNotificationOption: <K extends keyof NotificationSettings>(
    key: K,
    value: NotificationSettings[K],
  ) => void;
  /** Set the app zoom. Snapped to the nearest step and repainted, so callers
   *  may pass a raw multiplier. */
  setZoom: (value: number) => void;
  /** Record that the user has read this entry's "What's new". */
  setWhatsNewSeen: (entryId: string) => void;
  /** Load `settings.dat` and apply the result. Never rejects — a missing or
   *  corrupt file just leaves the defaults in place. */
  hydrate: () => Promise<void>;
}

function defaultState(): StoredSettings {
  return {
    themeId: DEFAULT_THEME_ID,
    terminal: { ...DEFAULT_TERMINAL_SETTINGS },
    agentDefaults: { ...DEFAULT_AGENT_DEFAULTS },
    voice: { ...DEFAULT_VOICE_SETTINGS },
    roc: { ...DEFAULT_ROC_SETTINGS },
    notifications: { ...DEFAULT_NOTIFICATION_SETTINGS },
    zoom: DEFAULT_ZOOM,
    whatsNewSeen: "",
  };
}

// Sanitizers -------------------------------------------------------------
//
// Every value that can reach the store from outside TypeScript's reach (the
// settings file, a hand-edited blob) goes through one of these. They are total:
// anything unrecognizable degrades to that field's default rather than
// poisoning the whole payload.

function clampInt(value: unknown, min: number, max: number, fallback: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function sanitizeFontSize(value: unknown): number {
  return clampInt(
    value,
    TERMINAL_FONT_SIZE_MIN,
    TERMINAL_FONT_SIZE_MAX,
    DEFAULT_TERMINAL_SETTINGS.fontSize,
  );
}

function sanitizeScrollback(value: unknown): number {
  return clampInt(
    value,
    SCROLLBACK_MIN,
    SCROLLBACK_MAX,
    DEFAULT_TERMINAL_SETTINGS.scrollback,
  );
}

function sanitizeAgentType(value: unknown): AgentType {
  return AGENT_TYPES.includes(value as AgentType)
    ? (value as AgentType)
    : DEFAULT_AGENT_DEFAULTS.agentType;
}

function sanitizeModel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function sanitizePermissionMode(value: unknown): PermissionMode {
  return PERMISSION_MODES.includes(value as PermissionMode)
    ? (value as PermissionMode)
    : DEFAULT_AGENT_DEFAULTS.permissionMode;
}

function sanitizeAccelerator(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_VOICE_SETTINGS.accelerator;
  // Normalizing here rather than storing what was typed is what lets the rest
  // of the app compare accelerators with `===` — and it is the same gate the
  // picker uses, so a hand-edited settings file cannot hold a chord the picker
  // would have refused.
  return normalizeAccelerator(value) ?? DEFAULT_VOICE_SETTINGS.accelerator;
}

function sanitizeModelSize(value: unknown): WhisperModelSize {
  return WHISPER_MODEL_SIZES.includes(value as WhisperModelSize)
    ? (value as WhisperModelSize)
    : DEFAULT_VOICE_SETTINGS.modelSize;
}

function sanitizeInputDevice(value: unknown): string {
  // "" is meaningful — it is "whatever the system calls the default input" —
  // so unlike the model string this does not normalize to null.
  return typeof value === "string" ? value.trim() : "";
}

function sanitizeVoiceRoute(value: unknown): VoiceRoute {
  return VOICE_ROUTES.includes(value as VoiceRoute)
    ? (value as VoiceRoute)
    : DEFAULT_VOICE_SETTINGS.routeTo;
}

/** A model name, or `""` for "let the CLI choose".
 *
 *  Bounded because it becomes an ARGV element on the way to `claude --model`:
 *  a hand-edited settings file must not be able to put a novel on a command
 *  line. Rust rejects a NUL; this rejects the rest of the nonsense. */
function sanitizeBrainModel(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_ROC_SETTINGS.brainModel;
  return value.trim().replace(/\s+/g, " ").slice(0, 100);
}

/** A voice name, or `""` for the system default. Same reasoning as the model:
 *  it is argv by the time `say` sees it. */
function sanitizeSpeechVoice(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_ROC_SETTINGS.speechVoice;
  return value.trim().slice(0, 100);
}

function sanitizePersona(value: unknown): RocPersona {
  return ROC_PERSONAS.includes(value as RocPersona)
    ? (value as RocPersona)
    : DEFAULT_ROC_SETTINGS.persona;
}

/** Words per minute, as a whole number inside the band.
 *
 *  Clamped rather than rejected so a slider, a stored value from a build with a
 *  wider band, and a hand-edited file all land somewhere audible. Rust clamps
 *  to the same two numbers: this is the UI's guard, not the only one. */
function sanitizeSpeechRate(value: unknown): number {
  return clampInt(
    value,
    ROC_SPEECH_RATE_MIN,
    ROC_SPEECH_RATE_MAX,
    DEFAULT_ROC_SETTINGS.speechRate,
  );
}

function sanitizeFlag(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** A switch, or the default it is a switch for. `undefined` and `"true"` both
 *  land on the default rather than on `false`: silence is the one outcome a
 *  malformed file must not be able to produce by accident. */
function sanitizeSwitch(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function sanitizeZoom(value: unknown): number {
  return typeof value === "number" ? nearestZoomStep(value) : DEFAULT_ZOOM;
}

/** A changelog entry id, or `""`. Bounded because it is compared, not parsed —
 *  a hand-edited settings file must not be able to put a novel in here. */
function sanitizeWhatsNewSeen(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 64) : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readTerminal(raw: unknown): TerminalSettings {
  const r = isRecord(raw) ? raw : {};
  return {
    fontSize: sanitizeFontSize(r.fontSize),
    scrollback: sanitizeScrollback(r.scrollback),
  };
}

function readAgentDefaults(raw: unknown): AgentDefaults {
  const r = isRecord(raw) ? raw : {};
  return {
    agentType: sanitizeAgentType(r.agentType),
    model: sanitizeModel(r.model),
    permissionMode: sanitizePermissionMode(r.permissionMode),
  };
}

function readVoice(raw: unknown): VoiceSettings {
  const r = isRecord(raw) ? raw : {};
  return {
    accelerator: sanitizeAccelerator(r.accelerator),
    modelSize: sanitizeModelSize(r.modelSize),
    inputDevice: sanitizeInputDevice(r.inputDevice),
    routeTo: sanitizeVoiceRoute(r.routeTo),
  };
}

function readRoc(raw: unknown): RocSettings {
  const r = isRecord(raw) ? raw : {};
  return {
    brainModel: sanitizeBrainModel(r.brainModel),
    speakReplies: sanitizeFlag(
      r.speakReplies,
      DEFAULT_ROC_SETTINGS.speakReplies,
    ),
    speechVoice: sanitizeSpeechVoice(r.speechVoice),
    autoDispatch: sanitizeFlag(
      r.autoDispatch,
      DEFAULT_ROC_SETTINGS.autoDispatch,
    ),
    persona: sanitizePersona(r.persona),
    speechRate: sanitizeSpeechRate(r.speechRate),
  };
}

function readNotifications(raw: unknown): NotificationSettings {
  const r = isRecord(raw) ? raw : {};
  return {
    turnFinishedSound: sanitizeSwitch(
      r.turnFinishedSound,
      DEFAULT_NOTIFICATION_SETTINGS.turnFinishedSound,
    ),
    approvalSound: sanitizeSwitch(
      r.approvalSound,
      DEFAULT_NOTIFICATION_SETTINGS.approvalSound,
    ),
    muted: sanitizeSwitch(r.muted, DEFAULT_NOTIFICATION_SETTINGS.muted),
  };
}

/** Turn whatever `settings.dat` holds into state.
 *
 *  v1 stored only `{ version, themeId }`; its readers are gone, so a v1 blob
 *  keeps its theme and takes today's defaults for everything else. Versions ≥ 2
 *  (including future ones) go through the field-wise readers above: each field
 *  degrades on its own, so an unknown shape loses at most the fields it broke,
 *  and unrecognized extra keys are ignored. The upgrade is written back on the
 *  next save.
 *
 *  v2 → v3 needs no case of its own for exactly that reason: a v2 blob has no
 *  `voice` key, `readVoice(undefined)` is the defaults, and the file becomes a
 *  v3 one the next time anything is saved. The version number is still bumped
 *  so a downgrade can tell what it is looking at. v4 → v5 (`notifications`) is
 *  the same shape of upgrade: an existing install lands on both sounds on and
 *  the mute off, which is what it already sounded like plus the turn signal
 *  this phase restores. */
function migrate(raw: unknown): StoredSettings {
  if (!isRecord(raw)) return defaultState();

  const themeId = getTheme(
    typeof raw.themeId === "string" ? raw.themeId : "",
  ).id;
  const version = typeof raw.version === "number" ? raw.version : 1;

  if (version < 2) return { ...defaultState(), themeId };

  return {
    themeId,
    terminal: readTerminal(raw.terminal),
    agentDefaults: readAgentDefaults(raw.agentDefaults),
    voice: readVoice(raw.voice),
    // No version case is needed for v4 → v5 → v6 → v7, for the same reason
    // v2 → v3 did not need one: every slice is read by FIELD, so a blob
    // missing `roc` or `notifications` (or, at v6, missing only that slice's
    // `persona` and `speechRate`) takes their defaults and becomes a v7 file
    // the next time anything is saved. That is also what makes the two
    // parallel branches that each shipped a "v5" readable here — neither
    // ancestor is privileged, and a file from either upgrades in place.
    roc: readRoc(raw.roc),
    notifications: readNotifications(raw.notifications),
    zoom: sanitizeZoom(raw.zoom),
    whatsNewSeen: sanitizeWhatsNewSeen(raw.whatsNewSeen),
  };
}

// Persistence ------------------------------------------------------------

let storePromise: Promise<Store> | null = null;
function getStore(): Promise<Store> {
  if (!storePromise) {
    storePromise = Store.load(SETTINGS_FILE).catch((err) => {
      // Don't cache a rejected handle: a later call should retry.
      storePromise = null;
      throw err;
    });
  }
  return storePromise;
}

function capture(): PersistedSettings {
  const {
    themeId,
    terminal,
    agentDefaults,
    voice,
    roc,
    notifications,
    zoom,
    whatsNewSeen,
  } = useSettingsStore.getState();
  return {
    version: SETTINGS_VERSION,
    themeId,
    terminal: { ...terminal },
    agentDefaults: { ...agentDefaults },
    voice: { ...voice },
    roc: { ...roc },
    notifications: { ...notifications },
    zoom,
    whatsNewSeen,
  };
}

let saveTimer: number | null = null;

/** Dirty counters, one per settable field.
 *
 *  Every setter bumps the counter for the field it wrote. `hydrate` snapshots
 *  them before awaiting `settings.dat` and, once the read lands, applies the
 *  persisted value only to the fields that did not move: a value the user
 *  changed while the file was still in flight has to win, or hydrate reverts
 *  the UI *and* the pending debounced save writes the reverted value to disk.
 *
 *  Per field, not one counter for the store. A single counter makes *any* edit
 *  during hydration discard the WHOLE persisted payload — nudge the font size
 *  while the read is in flight and the debounced save overwrites the stored
 *  theme and agent defaults with today's defaults. That is reachable in
 *  practice: `main.tsx` renders the app after a 250 ms race, so the UI is live
 *  and editable while a slow hydrate is still outstanding. */
interface EditCounters {
  themeId: number;
  terminal: Record<keyof TerminalSettings, number>;
  agentDefaults: Record<keyof AgentDefaults, number>;
  voice: Record<keyof VoiceSettings, number>;
  roc: Record<keyof RocSettings, number>;
  notifications: Record<keyof NotificationSettings, number>;
  zoom: number;
  whatsNewSeen: number;
}

const edits: EditCounters = {
  themeId: 0,
  terminal: { fontSize: 0, scrollback: 0 },
  agentDefaults: { agentType: 0, model: 0, permissionMode: 0 },
  voice: { accelerator: 0, modelSize: 0, inputDevice: 0, routeTo: 0 },
  roc: {
    brainModel: 0,
    speakReplies: 0,
    speechVoice: 0,
    autoDispatch: 0,
    persona: 0,
    speechRate: 0,
  },
  notifications: { turnFinishedSound: 0, approvalSound: 0, muted: 0 },
  zoom: 0,
  whatsNewSeen: 0,
};

function snapshotEdits(): EditCounters {
  return {
    themeId: edits.themeId,
    terminal: { ...edits.terminal },
    agentDefaults: { ...edits.agentDefaults },
    voice: { ...edits.voice },
    roc: { ...edits.roc },
    notifications: { ...edits.notifications },
    zoom: edits.zoom,
    whatsNewSeen: edits.whatsNewSeen,
  };
}

function keysOf<T extends object>(record: T): (keyof T)[] {
  return Object.keys(record) as (keyof T)[];
}

/** Copy the fields of `from` that the user did not touch since `before` onto a
 *  fresh copy of `current`. Generic over the group so both groups share one
 *  (type-safe) implementation. */
function mergeUntouched<T extends object>(
  current: T,
  from: T,
  counters: Record<keyof T, number>,
  before: Record<keyof T, number>,
): T {
  const merged = { ...current };
  for (const key of keysOf(counters)) {
    if (counters[key] === before[key]) merged[key] = from[key];
  }
  return merged;
}

/** Write settings immediately (cancels a pending debounce). Also used by tests
 *  so they don't have to drive timers. */
export async function saveSettingsNow(): Promise<void> {
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  try {
    const store = await getStore();
    await store.set(SETTINGS_KEY, capture());
    await store.save();
  } catch (err) {
    console.warn("[settings] save failed:", err);
  }
}

function scheduleSave(): void {
  if (saveTimer !== null) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void saveSettingsNow();
  }, SAVE_DEBOUNCE_MS) as unknown as number;
}

export const useSettingsStore = create<SettingsState & SettingsActions>()(
  devtools(
    immer((set) => ({
      ...defaultState(),
      hydrated: false,

      setThemeId: (id) => {
        // Resolve through the registry so a bad id can never be persisted and
        // so `themeId` always names a theme that exists.
        const theme = getTheme(id);
        edits.themeId += 1;
        set((s) => {
          s.themeId = theme.id;
        });
        applyTheme(theme.id);
        scheduleSave();
      },

      setTerminalOption: (key, value) => {
        edits.terminal[key] += 1;
        set((s) => {
          switch (key) {
            case "fontSize":
              s.terminal.fontSize = sanitizeFontSize(value);
              break;
            case "scrollback":
              s.terminal.scrollback = sanitizeScrollback(value);
              break;
          }
        });
        scheduleSave();
      },

      setAgentDefault: (key, value) => {
        edits.agentDefaults[key] += 1;
        set((s) => {
          switch (key) {
            case "agentType":
              s.agentDefaults.agentType = sanitizeAgentType(value);
              break;
            case "model":
              s.agentDefaults.model = sanitizeModel(value);
              break;
            case "permissionMode":
              s.agentDefaults.permissionMode = sanitizePermissionMode(value);
              break;
          }
        });
        scheduleSave();
      },

      setVoiceOption: (key, value) => {
        edits.voice[key] += 1;
        set((s) => {
          switch (key) {
            case "accelerator":
              s.voice.accelerator = sanitizeAccelerator(value);
              break;
            case "modelSize":
              s.voice.modelSize = sanitizeModelSize(value);
              break;
            case "inputDevice":
              s.voice.inputDevice = sanitizeInputDevice(value);
              break;
            case "routeTo":
              s.voice.routeTo = sanitizeVoiceRoute(value);
              break;
          }
        });
        scheduleSave();
      },

      setRocOption: (key, value) => {
        edits.roc[key] += 1;
        set((s) => {
          switch (key) {
            case "brainModel":
              s.roc.brainModel = sanitizeBrainModel(value);
              break;
            case "speakReplies":
              s.roc.speakReplies = sanitizeFlag(
                value,
                DEFAULT_ROC_SETTINGS.speakReplies,
              );
              break;
            case "speechVoice":
              s.roc.speechVoice = sanitizeSpeechVoice(value);
              break;
            case "autoDispatch":
              s.roc.autoDispatch = sanitizeFlag(
                value,
                DEFAULT_ROC_SETTINGS.autoDispatch,
              );
              break;
            case "persona":
              s.roc.persona = sanitizePersona(value);
              break;
            case "speechRate":
              s.roc.speechRate = sanitizeSpeechRate(value);
              break;
          }
        });
        scheduleSave();
      },

      setNotificationOption: (key, value) => {
        edits.notifications[key] += 1;
        set((s) => {
          s.notifications[key] = sanitizeSwitch(
            value,
            DEFAULT_NOTIFICATION_SETTINGS[key],
          );
        });
        scheduleSave();
      },

      setZoom: (value) => {
        const zoom = nearestZoomStep(value);
        edits.zoom += 1;
        set((s) => {
          s.zoom = zoom;
        });
        applyZoom(zoom);
        scheduleSave();
      },

      setWhatsNewSeen: (entryId) => {
        edits.whatsNewSeen += 1;
        set((s) => {
          s.whatsNewSeen = sanitizeWhatsNewSeen(entryId);
        });
        scheduleSave();
      },

      hydrate: async () => {
        const before = snapshotEdits();
        let next = defaultState();
        try {
          const store = await getStore();
          const saved = await store.get<unknown>(SETTINGS_KEY);
          next = migrate(saved);
        } catch (err) {
          console.warn("[settings] hydrate failed:", err);
        }
        // Merge field by field. Where the user beat the disk their choice is
        // already applied and queued for save, so it stays; everything they
        // did not touch takes the persisted value.
        const current = useSettingsStore.getState();
        const themeIsUsers = edits.themeId !== before.themeId;
        const zoomIsUsers = edits.zoom !== before.zoom;
        set({
          // Set with the merge, not after it: a subscriber woken by `hydrated`
          // reads the store in the same commit, and one that saw the flag flip
          // a tick before the values landed would be reading the defaults it
          // was waiting to stop reading.
          hydrated: true,
          themeId: themeIsUsers ? current.themeId : next.themeId,
          zoom: zoomIsUsers ? current.zoom : next.zoom,
          whatsNewSeen:
            edits.whatsNewSeen !== before.whatsNewSeen
              ? current.whatsNewSeen
              : next.whatsNewSeen,
          terminal: mergeUntouched(
            current.terminal,
            next.terminal,
            edits.terminal,
            before.terminal,
          ),
          agentDefaults: mergeUntouched(
            current.agentDefaults,
            next.agentDefaults,
            edits.agentDefaults,
            before.agentDefaults,
          ),
          voice: mergeUntouched(
            current.voice,
            next.voice,
            edits.voice,
            before.voice,
          ),
          roc: mergeUntouched(current.roc, next.roc, edits.roc, before.roc),
          notifications: mergeUntouched(
            current.notifications,
            next.notifications,
            edits.notifications,
            before.notifications,
          ),
        });
        // Repaint only when the value is ours to set: the setters already
        // painted the user's pick, and repainting would revert it.
        if (!themeIsUsers) applyTheme(next.themeId);
        if (!zoomIsUsers) applyZoom(next.zoom);
      },
    })),
    { name: "settings" },
  ),
);

// Selectors --------------------------------------------------------------

export const useThemeId = () => useSettingsStore((s) => s.themeId);
export const useTerminalSettings = () => useSettingsStore((s) => s.terminal);
export const useAgentDefaults = () => useSettingsStore((s) => s.agentDefaults);
export const useVoiceSettings = () => useSettingsStore((s) => s.voice);
export const useRocSettings = (): RocSettings => useSettingsStore((s) => s.roc);
export const useNotificationSettings = (): NotificationSettings =>
  useSettingsStore((s) => s.notifications);
export const useZoom = (): number => useSettingsStore((s) => s.zoom);
export const useWhatsNewSeen = (): string =>
  useSettingsStore((s) => s.whatsNewSeen);
/** For anything that must not act on a stored value before it has been read.
 *  See `hydrated` on the state. */
export const useSettingsHydrated = (): boolean =>
  useSettingsStore((s) => s.hydrated);
