/** Accelerators — the strings the global push-to-talk key is stored and bound
 *  as.
 *
 *  The grammar is not ours: `tauri-plugin-global-shortcut` hands the string to
 *  `global_hotkey`, which wants modifiers first and exactly one key, joined by
 *  `+` (`"Alt+Space"`, `"Control+Shift+KeyR"`). Rust is the authority and will
 *  refuse anything it cannot parse — this module exists so the user finds out
 *  while they are pressing keys rather than after a round trip, and so the
 *  string that reaches disk is always in one canonical spelling.
 *
 *  Key tokens are DOM `KeyboardEvent.code` values, which is what makes capture
 *  work: the code the browser reports IS the token Rust wants ("KeyR",
 *  "Digit1", "Space", "F13"). The list below is `global_hotkey`'s own, so a
 *  key that survives `normalizeAccelerator` is one the OS can bind.
 *
 *  Physical keys, not characters: `KeyZ` is the key where Z sits on a US
 *  layout, wherever it sits on the user's. That is how every global hotkey on
 *  every platform works, and why the picker shows the code's label rather than
 *  `event.key`. */

/** Modifier tokens, in the order a canonical accelerator lists them. */
export const ACCELERATOR_MODIFIERS = [
  "Control",
  "Alt",
  "Shift",
  "Super",
] as const;

export type AcceleratorModifier = (typeof ACCELERATOR_MODIFIERS)[number];

/** What people (and other apps' docs) call the modifiers, lowercased. */
const MODIFIER_ALIASES: Record<string, AcceleratorModifier> = {
  control: "Control",
  ctrl: "Control",
  alt: "Alt",
  option: "Alt",
  opt: "Alt",
  shift: "Shift",
  super: "Super",
  command: "Super",
  cmd: "Super",
  meta: "Super",
  win: "Super",
};

/** Every key `global_hotkey` accepts, spelled as `KeyboardEvent.code` does.
 *  Kept in the parser's order so the two lists can be diffed by eye. */
const KEY_CODES = [
  "Backquote",
  "Backslash",
  "BracketLeft",
  "BracketRight",
  "Pause",
  "Comma",
  "Digit0",
  "Digit1",
  "Digit2",
  "Digit3",
  "Digit4",
  "Digit5",
  "Digit6",
  "Digit7",
  "Digit8",
  "Digit9",
  "Equal",
  "KeyA",
  "KeyB",
  "KeyC",
  "KeyD",
  "KeyE",
  "KeyF",
  "KeyG",
  "KeyH",
  "KeyI",
  "KeyJ",
  "KeyK",
  "KeyL",
  "KeyM",
  "KeyN",
  "KeyO",
  "KeyP",
  "KeyQ",
  "KeyR",
  "KeyS",
  "KeyT",
  "KeyU",
  "KeyV",
  "KeyW",
  "KeyX",
  "KeyY",
  "KeyZ",
  "Minus",
  "Period",
  "Quote",
  "Semicolon",
  "Slash",
  "Backspace",
  "CapsLock",
  "Enter",
  "Space",
  "Tab",
  "Delete",
  "End",
  "Home",
  "Insert",
  "PageDown",
  "PageUp",
  "PrintScreen",
  "ScrollLock",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "NumLock",
  "Numpad0",
  "Numpad1",
  "Numpad2",
  "Numpad3",
  "Numpad4",
  "Numpad5",
  "Numpad6",
  "Numpad7",
  "Numpad8",
  "Numpad9",
  "NumpadAdd",
  "NumpadDecimal",
  "NumpadDivide",
  "NumpadEnter",
  "NumpadEqual",
  "NumpadMultiply",
  "NumpadSubtract",
  "Escape",
  "AudioVolumeDown",
  "AudioVolumeUp",
  "AudioVolumeMute",
  "MediaPlay",
  "MediaPause",
  "MediaPlayPause",
  "MediaStop",
  "MediaTrackNext",
  "MediaTrackPrevious",
  ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`),
] as const;

const KEY_BY_LOWER = new Map<string, string>(
  KEY_CODES.map((code) => [code.toLowerCase(), code]),
);

/** Short spellings a stored (or hand-edited) accelerator may use. The picker
 *  never produces these; the parser accepts them so a value typed from another
 *  app's documentation still resolves. */
const KEY_ALIASES: Record<string, string> = {
  esc: "Escape",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  "`": "Backquote",
  "\\": "Backslash",
  "[": "BracketLeft",
  "]": "BracketRight",
  ",": "Comma",
  "=": "Equal",
  "-": "Minus",
  ".": "Period",
  "'": "Quote",
  ";": "Semicolon",
  "/": "Slash",
};

/** The keys that may be bound with NO modifier at all.
 *
 *  A bare `Space` accelerator is a global shortcut that eats the space bar in
 *  every application on the machine, and the user who bound it cannot type the
 *  word "no" to undo it. Function and media keys have no such job, and a bare
 *  F13 is what dictation apps traditionally use — so they, and only they, are
 *  allowed alone. */
const BARE_KEY_PATTERN = /^(F([1-9]|1\d|2[0-4])|Media\w+|AudioVolume\w+)$/;

/** Bare keys that may be CHOSEN but never handed to the OS.
 *
 *  Caps Lock is the push-to-talk key RocTalk shipped with, and on Windows it
 *  still is — `hotkey.rs` takes it with a keyboard hook, which is a thing an
 *  accelerator cannot be. Everywhere else there is no global mechanism for a
 *  bare toggle key, so choosing it binds nothing: it drives push-to-talk
 *  through the DOM listener, which means only while RocSpace is in front.
 *
 *  Refusing it outright — which is what this module used to do — silently
 *  rewrote the setting of anyone who dictates with Caps Lock today, and left
 *  them with no way to ask for it back. A key that works in the app is worth
 *  more than a key that cannot be chosen, as long as the difference is
 *  SAID: see `isDomOnlyAccelerator`, and the note the Settings row shows. */
const DOM_ONLY_BARE_KEYS = new Set(["CapsLock"]);

/** `KeyboardEvent.code` values that are themselves modifiers.
 *
 *  Caps Lock is deliberately NOT here even though it behaves like one: it is a
 *  real key token, and a picker that silently ignored it would leave the person
 *  who pressed it wondering. It falls through to `DOM_ONLY_BARE_KEYS` instead
 *  and is accepted, with the limitation spelled out. */
const MODIFIER_CODES = new Set([
  "ShiftLeft",
  "ShiftRight",
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
]);

export interface ParsedAccelerator {
  modifiers: AcceleratorModifier[];
  key: string;
}

/** Split an accelerator into its parts, or `null` when it is not one.
 *
 *  Total and forgiving about spelling — case, whitespace and the aliases above
 *  all resolve — but not about SHAPE: modifiers before the key, one key, and
 *  nothing empty.
 *
 *  Says nothing about whether the chord may be BOUND: that is
 *  `normalizeAccelerator`'s question, and the difference matters because
 *  `matchesAccelerator` is also asked about bare Caps Lock, which the Windows
 *  keyboard hook delivers without the OS's accelerator machinery ever being
 *  involved. */
export function parseAccelerator(raw: string): ParsedAccelerator | null {
  const tokens = raw.split("+").map((t) => t.trim());
  if (tokens.length === 0 || tokens.some((t) => t === "")) return null;

  const modifiers: AcceleratorModifier[] = [];
  let key: string | null = null;

  for (const token of tokens) {
    const lower = token.toLowerCase();
    const modifier = MODIFIER_ALIASES[lower];
    if (modifier) {
      // A modifier after the key is the "Ctrl+C+Shift" mistake Rust refuses
      // too; a repeated one is a typo worth surfacing rather than collapsing.
      if (key !== null || modifiers.includes(modifier)) return null;
      modifiers.push(modifier);
      continue;
    }
    if (key !== null) return null;
    key = KEY_BY_LOWER.get(lower) ?? KEY_ALIASES[lower] ?? null;
    if (key === null) return null;
  }

  if (key === null) return null;

  // Canonical order, so two spellings of one accelerator compare equal.
  modifiers.sort(
    (a, b) =>
      ACCELERATOR_MODIFIERS.indexOf(a) - ACCELERATOR_MODIFIERS.indexOf(b),
  );
  return { modifiers, key };
}

/** May this chord be handed to the OS as a global shortcut? See
 *  `BARE_KEY_PATTERN` for why an unmodified key mostly may not, and
 *  `DOM_ONLY_BARE_KEYS` for the one that may be chosen without being bindable
 *  at all. */
function isOsBindable(parsed: ParsedAccelerator): boolean {
  return parsed.modifiers.length > 0 || BARE_KEY_PATTERN.test(parsed.key);
}

/** Is this a key that push-to-talk can only hear through the DOM?
 *
 *  Callers who REGISTER must ask: handing one of these to the OS is at best a
 *  refusal and at worst a bare key taken from every application. Callers who
 *  SHOW should ask too — "works while any application is in front" is not true
 *  of these, and the row says so. */
export function isDomOnlyAccelerator(raw: string): boolean {
  const parsed = parseAccelerator(raw);
  if (!parsed) return false;
  return parsed.modifiers.length === 0 && DOM_ONLY_BARE_KEYS.has(parsed.key);
}

/** The canonical spelling of `raw`, or `null` when it is not an accelerator at
 *  all. This is the gate everything stored goes through.
 *
 *  Accepting a DOM-only key here is what stops a stored `CapsLock` from being
 *  quietly rewritten to the default on the next load. Whether the OS may be
 *  ASKED for it is a separate question — `isDomOnlyAccelerator`. */
export function normalizeAccelerator(raw: string): string | null {
  const parsed = parseAccelerator(raw);
  if (!parsed) return null;
  if (!isOsBindable(parsed) && !DOM_ONLY_BARE_KEYS.has(parsed.key)) return null;
  return [...parsed.modifiers, parsed.key].join("+");
}

/** Read an accelerator off a keydown.
 *
 *  `"pending"` while the user is only holding modifiers — a picker should stay
 *  armed rather than reject. `null` when the key cannot be chosen (it is not in
 *  the OS's vocabulary, or it is a bare key that would be unbindable-by-hand
 *  once it was global). A bare `DOM_ONLY_BARE_KEYS` key comes back as itself:
 *  it is a choice with a caveat, not a refusal. */
export function acceleratorFromEvent(
  event: Pick<
    KeyboardEvent,
    "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey"
  >,
): string | "pending" | null {
  if (MODIFIER_CODES.has(event.code)) return "pending";
  const key = KEY_BY_LOWER.get(event.code.toLowerCase());
  if (!key) return null;

  const modifiers: AcceleratorModifier[] = [];
  if (event.ctrlKey) modifiers.push("Control");
  if (event.altKey) modifiers.push("Alt");
  if (event.shiftKey) modifiers.push("Shift");
  if (event.metaKey) modifiers.push("Super");

  if (
    modifiers.length === 0 &&
    !BARE_KEY_PATTERN.test(key) &&
    !DOM_ONLY_BARE_KEYS.has(key)
  ) {
    return null;
  }
  return [...modifiers, key].join("+");
}

/** Does this keyboard event press exactly `accelerator`?
 *
 *  Exactly: a modifier the accelerator does not name must NOT be held, or
 *  `Alt+Space` would fire on `Control+Alt+Space` — which is somebody else's
 *  shortcut. */
export function matchesAccelerator(
  event: Pick<
    KeyboardEvent,
    "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey"
  >,
  accelerator: string,
): boolean {
  const parsed = parseAccelerator(accelerator);
  if (!parsed) return false;
  if (KEY_BY_LOWER.get(event.code.toLowerCase()) !== parsed.key) return false;
  return (
    event.ctrlKey === parsed.modifiers.includes("Control") &&
    event.altKey === parsed.modifiers.includes("Alt") &&
    event.shiftKey === parsed.modifiers.includes("Shift") &&
    event.metaKey === parsed.modifiers.includes("Super")
  );
}

/** Is this event about the accelerator's MAIN key, whatever modifiers are (or
 *  are no longer) held?
 *
 *  What a key-UP has to be matched with. Let go of `Alt` a moment before
 *  `Space` and the `Space` keyup carries no Alt at all — `matchesAccelerator`
 *  would say no, the hold would never be seen to end, and the microphone would
 *  stay open until the next press. */
export function isAcceleratorKey(
  event: Pick<KeyboardEvent, "code">,
  accelerator: string,
): boolean {
  const parsed = parseAccelerator(accelerator);
  if (!parsed) return false;
  return KEY_BY_LOWER.get(event.code.toLowerCase()) === parsed.key;
}

/** The chords RocSpace binds itself, as accelerators, and what each one does.
 *
 *  For one question only: the push-to-talk picker's. Push-to-talk is heard
 *  before anything else in the app — the DOM fallback in `useRocTalk` is on the
 *  window in the capture phase, ahead of every document handler, and it calls
 *  `preventDefault` on a match; a chord the OS registered never reaches the
 *  webview at all. So a user who binds ⌘K to push-to-talk does not get two
 *  behaviours, they get one, and the command palette simply stops opening with
 *  nothing on screen connecting the two.
 *
 *  A warning rather than a refusal. It is the user's keyboard, they may have
 *  meant it, and RocSpace taking a chord back from them is the same rudeness in
 *  the other direction — it just has to be a choice made with the facts.
 *
 *  Only chords a push-to-talk key could BE are worth listing: the picker
 *  requires a modifier (or a function/media key), so Enter, Escape and the
 *  arrows cannot collide however many surfaces bind them. Keep it in step with
 *  Settings › Shortcuts, which is the table this is the machine-readable half
 *  of. */
/** Phrased to complete "This chord also ___ in RocSpace", so one sentence in
 *  the picker fits every entry.
 *
 *  Written the way a person says the chord (⌘⇧M) and canonicalized below
 *  rather than hand-spelled in `ACCELERATOR_MODIFIERS` order, which is
 *  Control-Alt-Shift-Super and puts Shift BEFORE Super. Spelled by hand, every
 *  two-modifier row here silently failed to match — a lookup that finds
 *  nothing looks exactly like a chord that collides with nothing. */
const APP_CHORD_SOURCE: Record<string, string> = {
  "Super+KeyK": "opens the command palette",
  "Super+KeyT": "makes a new workspace",
  "Super+KeyN": "opens a new pane",
  "Super+KeyD": "splits the focused pane to the right",
  "Super+Shift+KeyD": "splits the focused pane downwards",
  "Super+KeyW": "closes the focused pane",
  "Super+KeyS": "saves the file the editor is on",
  "Super+KeyP": "opens a file by name",
  "Super+Shift+KeyS": "saves the workspace as a session",
  "Super+Shift+KeyP": "shows the RocPlan board",
  "Super+Shift+KeyM": "shows RocMind",
  "Super+Shift+KeyR": "shows Roc",
  "Super+Shift+KeyK": "opens the Git panel",
  "Super+Equal": "zooms in",
  "Super+Shift+Equal": "zooms in",
  "Super+Minus": "zooms out",
  "Super+Shift+Minus": "zooms out",
  "Super+Digit0": "resets the zoom",
  ...Object.fromEntries(
    Array.from({ length: 9 }, (_, i) => [
      `Super+Digit${i + 1}`,
      "switches to the nth workspace",
    ]),
  ),
};

const APP_CHORDS: Record<string, string> = Object.fromEntries(
  Object.entries(APP_CHORD_SOURCE).map(([chord, what]) => [
    normalizeAccelerator(chord) ?? chord,
    what,
  ]),
);

/** What `accelerator` would shadow if push-to-talk took it, or null.
 *
 *  Normalizes first, so a stored spelling and a freshly captured one give the
 *  same answer. */
export function appShortcutConflict(accelerator: string): string | null {
  const canonical = normalizeAccelerator(accelerator);
  return canonical ? (APP_CHORDS[canonical] ?? null) : null;
}

const MAC_MODIFIER_LABELS: Record<AcceleratorModifier, string> = {
  Control: "⌃",
  Alt: "⌥",
  Shift: "⇧",
  Super: "⌘",
};

const PC_MODIFIER_LABELS: Record<AcceleratorModifier, string> = {
  Control: "Ctrl",
  Alt: "Alt",
  Shift: "Shift",
  Super: "Win",
};

const KEY_LABELS: Record<string, string> = {
  CapsLock: "Caps Lock",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Backquote: "`",
  Backslash: "\\",
  BracketLeft: "[",
  BracketRight: "]",
  Comma: ",",
  Equal: "=",
  Minus: "-",
  Period: ".",
  Quote: "'",
  Semicolon: ";",
  Slash: "/",
};

/** One label per key of the chord, for rendering as `<kbd>` chips. Unparseable
 *  input comes back as a single chip of itself, so a stored value we cannot
 *  read is still shown rather than silently blanked. */
export function acceleratorChips(
  accelerator: string,
  options: { mac?: boolean } = {},
): string[] {
  const parsed = parseAccelerator(accelerator);
  if (!parsed) return [accelerator];
  const labels = options.mac ? MAC_MODIFIER_LABELS : PC_MODIFIER_LABELS;
  return [
    ...parsed.modifiers.map((m) => labels[m]),
    KEY_LABELS[parsed.key] ??
      parsed.key.replace(/^(Key|Digit|Numpad)/, (prefix) =>
        prefix === "Numpad" ? "Num " : "",
      ),
  ];
}
