import { useEffect, useId, useState } from "react";
import { Download, Loader2, RotateCcw, Volume2 } from "lucide-react";
import {
  acceleratorChips,
  acceleratorFromEvent,
  appShortcutConflict,
  isDomOnlyAccelerator,
} from "@/lib/accelerator";
import {
  commands,
  WHISPER_MODEL_SIZES,
  type WhisperModelSize,
} from "@/lib/bindings";
import { isMacOS, isWindows } from "@/lib/platform";
import { auditionRocPersona } from "@/lib/rocBrain";
import { startModelDownload } from "@/lib/roctalkModel";
import { cn } from "@/lib/utils";
import {
  DEFAULT_ROC_SETTINGS,
  DEFAULT_VOICE_SETTINGS,
  ROC_PERSONAS,
  ROC_SPEECH_RATE_MAX,
  ROC_SPEECH_RATE_MIN,
  useRocSettings,
  useRocTalkStore,
  useSettingsStore,
  useVoiceSettings,
  WINDOWS_PTT_ACCELERATOR,
  type RocPersona,
  type VoiceRoute,
} from "@/stores";
import {
  SettingsNote,
  SettingsRow,
  SettingsSection,
  SettingsToggle,
} from "@/views/Settings/rows";

const MODEL_LABELS: Record<WhisperModelSize, string> = {
  "tiny.en": "Tiny — fastest, ~75 MB",
  "base.en": "Base — balanced, ~142 MB",
  "small.en": "Small — most accurate, ~466 MB",
};

const ROUTE_LABELS: Record<VoiceRoute, string> = {
  terminal: "The focused terminal",
  roc: "Roc's command bar",
};

/** One line each, in the option itself — the same shape as the Whisper model
 *  picker above, and the reason neither needs a paragraph under it. */
const PERSONA_LABELS: Record<RocPersona, string> = {
  plain: "Plain — an ordinary, helpful sentence",
  butler: "Butler — terse, dry, faintly formal",
};

/** How far one drag of the rate slider moves. Five words a minute is about the
 *  smallest change anybody can hear, so finer steps would only make the control
 *  harder to land. */
const SPEECH_RATE_STEP = 5;

export function VoiceSection() {
  const enabled = useRocTalkStore((s) => s.enabled);
  const setEnabled = useRocTalkStore((s) => s.setEnabled);
  const modelStatus = useRocTalkStore((s) => s.modelStatus);
  const downloadProgress = useRocTalkStore((s) => s.downloadProgress);

  const voice = useVoiceSettings();
  const setVoiceOption = useSettingsStore((s) => s.setVoiceOption);
  const roc = useRocSettings();
  const setRocOption = useSettingsStore((s) => s.setRocOption);

  /** Is there a voice on this machine at all? `roc_speak` is `say`, and `say`
   *  is macOS — everything under Roc that makes a sound says so rather than
   *  offering a control that does nothing. */
  const canSpeak = isMacOS();

  const modelId = useId();
  const deviceId = useId();
  const routeId = useId();
  const brainModelId = useId();
  const speechVoiceId = useId();
  const personaId = useId();
  const speechRateId = useId();

  return (
    <SettingsSection
      title="Voice"
      description="RocTalk transcribes speech locally with Whisper — audio never leaves this machine."
    >
      <SettingsRow
        label="RocTalk"
        description="Same switch as the microphone button in the topbar."
      >
        <SettingsToggle
          label="Enable RocTalk"
          checked={enabled}
          onChange={setEnabled}
        />
      </SettingsRow>

      <SettingsRow
        label="Push-to-talk key"
        description={
          isWindows()
            ? "Hold to record, release to transcribe. Windows uses a keyboard hook on Caps Lock, which reaches further than a shortcut can — the caps state never flips while RocTalk is on."
            : isDomOnlyAccelerator(voice.accelerator)
              ? // A bare key is not something this system will hand to a
                // background application, so the promise the other branch makes
                // would be a lie here. Said rather than refused: Caps Lock is
                // what RocTalk shipped with, and taking it away silently was
                // worse than keeping it with a caveat.
                "Hold to record, release to transcribe. A bare key only reaches RocSpace while it is the front application — add a modifier for a shortcut that works everywhere."
              : "Hold to record, release to transcribe. Works while any application is in front."
        }
      >
        {isWindows() ? (
          <Chips accelerator={WINDOWS_PTT_ACCELERATOR} />
        ) : (
          <AcceleratorPicker
            accelerator={voice.accelerator}
            onChange={(next) => setVoiceOption("accelerator", next)}
          />
        )}
      </SettingsRow>

      <SettingsRow
        label="Speech model"
        description="Bigger models hear better and think slower. Each is downloaded once and kept, so switching back is instant."
        htmlFor={modelId}
      >
        <select
          id={modelId}
          value={voice.modelSize}
          onChange={(e) =>
            setVoiceOption("modelSize", e.target.value as WhisperModelSize)
          }
          className={selectClass}
        >
          {WHISPER_MODEL_SIZES.map((size) => (
            <option key={size} value={size}>
              {MODEL_LABELS[size]}
            </option>
          ))}
        </select>
        <ModelStatus
          size={voice.modelSize}
          status={modelStatus}
          progress={downloadProgress}
        />
      </SettingsRow>

      <SettingsRow
        label="Microphone"
        description="Which input Whisper listens to. A device that has been unplugged falls back to the system default rather than failing."
        htmlFor={deviceId}
      >
        <InputDeviceSelect
          id={deviceId}
          value={voice.inputDevice}
          onChange={(next) => setVoiceOption("inputDevice", next)}
        />
      </SettingsRow>

      <SettingsRow
        label="Send transcripts to"
        description="Where a finished transcript lands. Roc's command bar lets you aim it at several agents before it is sent anywhere."
        htmlFor={routeId}
      >
        <select
          id={routeId}
          value={voice.routeTo}
          onChange={(e) =>
            setVoiceOption("routeTo", e.target.value as VoiceRoute)
          }
          className={selectClass}
        >
          {(Object.keys(ROUTE_LABELS) as VoiceRoute[]).map((route) => (
            <option key={route} value={route}>
              {ROUTE_LABELS[route]}
            </option>
          ))}
        </select>
      </SettingsRow>

      {/* Roc — the other half of the same sentence: you hold the key, you say
          something, and these decide what happens to it. (The same sentence as
          `RocSettings` in the settings store, and it lost its count for the
          same reason: the rows grow.) */}
      <SettingsRow
        label="Roc's brain"
        description="Which model reasons about what you say. Every turn runs `claude -p`, which re-sends Claude Code's own system prompt — so a cheap fast model is cents rather than tens of cents per question. Leave it blank to let the CLI choose."
        htmlFor={brainModelId}
      >
        <div className="flex items-center gap-1.5">
          <input
            id={brainModelId}
            type="text"
            value={roc.brainModel}
            placeholder="let the CLI choose"
            spellCheck={false}
            onChange={(e) => setRocOption("brainModel", e.target.value)}
            className="w-56 rounded-input border border-border bg-surface-2 px-2 py-1 font-mono text-[11px] text-fg-primary hover:border-border-hover focus:border-border-active focus:outline-none"
          />
          <button
            type="button"
            aria-label="Reset the brain model to the default"
            title="Reset to default"
            disabled={roc.brainModel === DEFAULT_ROC_SETTINGS.brainModel}
            onClick={() =>
              setRocOption("brainModel", DEFAULT_ROC_SETTINGS.brainModel)
            }
            className={cn(
              "flex h-6 w-6 items-center justify-center rounded-input transition-colors",
              roc.brainModel === DEFAULT_ROC_SETTINGS.brainModel
                ? "cursor-not-allowed text-fg-muted opacity-40"
                : "text-fg-secondary hover:bg-surface-3 hover:text-fg-primary",
            )}
          >
            <RotateCcw className="h-3 w-3" />
          </button>
        </div>
      </SettingsRow>

      <SettingsRow
        label="Speak replies"
        description={
          canSpeak
            ? "Roc says its answer out loud through the system voice."
            : "Spoken replies need macOS `say`; on this system Roc answers on screen only."
        }
      >
        <SettingsToggle
          label="Speak Roc's replies"
          checked={roc.speakReplies}
          onChange={(next) => setRocOption("speakReplies", next)}
        />
      </SettingsRow>

      <SettingsRow
        label="Roc's voice"
        description="Which of the voices macOS provides reads the replies. Add more in System Settings › Accessibility › Spoken Content — RocSpace ships none of its own."
        htmlFor={speechVoiceId}
      >
        <SpeechVoiceSelect
          id={speechVoiceId}
          value={roc.speechVoice}
          onChange={(next) => setRocOption("speechVoice", next)}
        />
      </SettingsRow>

      <SettingsRow
        label="Roc's manner"
        description="How Roc words its reply — not which voice says it. Butler keeps it to one understated sentence; Plain is an ordinary one. Either way the instructions sent to your agents stay plain."
        htmlFor={personaId}
      >
        <select
          id={personaId}
          value={roc.persona}
          onChange={(e) =>
            setRocOption("persona", e.target.value as RocPersona)
          }
          className={selectClass}
        >
          {ROC_PERSONAS.map((persona) => (
            <option key={persona} value={persona}>
              {PERSONA_LABELS[persona]}
            </option>
          ))}
        </select>
      </SettingsRow>

      {/* Both rows below are dead off macOS — `say` is the only voice there is
          — so both say so and neither pretends otherwise. A slider that moves
          and changes nothing, and a button that plays silence, leave somebody
          on Windows unable to tell whether it is the voice, the build or their
          speakers. Same shape as Speak replies above. */}
      <SettingsRow
        label="Speaking rate"
        description={
          canSpeak
            ? "How fast the reply is read, in words per minute."
            : "How fast the reply would be read, in words per minute — but the rate needs macOS `say`, and nothing on this system reads them."
        }
        htmlFor={speechRateId}
      >
        <span className="flex items-center gap-2">
          <input
            id={speechRateId}
            type="range"
            min={ROC_SPEECH_RATE_MIN}
            max={ROC_SPEECH_RATE_MAX}
            step={SPEECH_RATE_STEP}
            value={roc.speechRate}
            disabled={!canSpeak}
            onChange={(e) => setRocOption("speechRate", Number(e.target.value))}
            className={cn(
              "w-40 accent-accent",
              !canSpeak && "cursor-not-allowed opacity-40",
            )}
          />
          {/* Beside the slider rather than in its label: the number is what
              the user is steering by, and a value that only shows up in a
              tooltip is a value nobody sees. */}
          <span
            className={cn(
              "w-16 shrink-0 text-right font-mono text-[11px] tabular-nums",
              canSpeak ? "text-fg-secondary" : "text-fg-muted opacity-40",
            )}
          >
            {roc.speechRate} wpm
          </span>
        </span>
      </SettingsRow>

      <SettingsRow
        label="Audition"
        description={
          canSpeak
            ? "Hear the three settings above together, on a line Roc would really say — the sentence changes with the manner, because that is what is being chosen."
            : "Auditioning needs macOS `say`; on this system there is nothing to hear, and the manner is read on screen instead."
        }
      >
        <button
          type="button"
          disabled={!canSpeak}
          onClick={() => void auditionRocPersona()}
          className={cn(
            "flex items-center gap-1.5 rounded-input bg-surface-2 px-2.5 py-1 text-xs transition-colors",
            canSpeak
              ? "text-fg-primary hover:bg-surface-3"
              : "cursor-not-allowed text-fg-muted opacity-40",
          )}
        >
          <Volume2 className="h-3 w-3" />
          Audition
        </button>
      </SettingsRow>

      <SettingsRow
        label="Send without asking"
        description="Off, Roc proposes: you see each agent's instruction and press Send. On, it dispatches the moment it has decided — quicker, and nothing to take back if it misheard you."
      >
        <SettingsToggle
          label="Dispatch Roc's plans without confirming"
          checked={roc.autoDispatch}
          onChange={(next) => setRocOption("autoDispatch", next)}
        />
      </SettingsRow>

      {roc.autoDispatch ? (
        <SettingsNote>
          Roc will send to your agents on its own. A misheard word reaches them
          before you can read it — and a message that is in a terminal is in it.
        </SettingsNote>
      ) : null}

      {isWindows() ? null : (
        <SettingsNote>
          A shortcut needs a modifier and one key: holding Right Option alone is
          not something any operating system can hand to an application. Alt is
          Option and Super is Command on this keyboard.
        </SettingsNote>
      )}
    </SettingsSection>
  );
}

const selectClass =
  "rounded-input border border-border bg-surface-2 px-2 py-1 text-xs text-fg-primary hover:border-border-hover focus:border-border-active focus:outline-none";

/** The chord, as `<kbd>` chips. */
function Chips({ accelerator }: { accelerator: string }) {
  return (
    <span className="flex items-center gap-1">
      {acceleratorChips(accelerator, { mac: isMacOS() }).map((label, i) => (
        <kbd
          key={`${label}-${i}`}
          className="rounded-input border border-border bg-surface-2 px-2 py-1 font-mono text-[11px] text-fg-secondary"
        >
          {label}
        </kbd>
      ))}
    </span>
  );
}

/** Capture-a-chord control.
 *
 *  Arming it takes the keyboard: every keydown while armed is a candidate
 *  rather than a shortcut, which is the only way to bind something the app
 *  itself already binds. Escape disarms — and stops there, in the CAPTURE
 *  phase, because Settings closes on a bubbled Escape and backing out of a
 *  picker should not also close the screen it is on.
 *
 *  # Taking the keyboard, properly
 *
 *  On the WINDOW rather than the document, with `stopImmediatePropagation`.
 *  Both details are load-bearing and neither is a style choice:
 *
 *  * Every other chord in the app listens on the document in the capture
 *    phase, and the window is one step earlier in that path — the only place
 *    from which a listener added at click time can get in front of listeners
 *    registered when the app mounted.
 *  * `stopPropagation` alone does not stop a listener already registered on
 *    the SAME node, which is what the document is for all of them. That is how
 *    ⌘+ scaled the window while the user was pressing it to BIND it: zoom
 *    (`useZoomShortcuts`) is deliberately the one chord with no modal guard,
 *    since it acts on the window and the window is always visible.
 *
 *  Taking the keyboard includes taking it from push-to-talk itself, which
 *  listens on the window too and holds the chord at the OS level besides.
 *  `capturingAccelerator` is how RocTalk is told to stand down for the
 *  duration — it is registered before this listener, so stopping the event
 *  cannot reach it, and without the flag the chord the user is trying to
 *  rebind is the one chord that never arrives here. */
function AcceleratorPicker({
  accelerator,
  onChange,
}: {
  accelerator: string;
  onChange: (accelerator: string) => void;
}) {
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isDefault = accelerator === DEFAULT_VOICE_SETTINGS.accelerator;
  /** What this chord would take from the app, if anything — see
   *  `appShortcutConflict`. Read off the stored value, not the last capture:
   *  the collision is a property of the setting. */
  const conflict = appShortcutConflict(accelerator);

  useEffect(() => {
    if (!capturing) return;
    // Raised here rather than in the click handler so it is exactly as long
    // lived as the listener below: a picker unmounted mid-capture (Settings
    // closed from somewhere else) cannot leave push-to-talk stood down.
    const { setCapturingAccelerator } = useRocTalkStore.getState();
    setCapturingAccelerator(true);

    const onKeyDown = (e: KeyboardEvent) => {
      // Nothing typed while capturing is meant for anyone else — not the
      // pane chords, not the zoom keys, not xterm, not the Settings overlay's
      // own Escape. See the header for why it is this call and this node.
      e.preventDefault();
      e.stopImmediatePropagation();

      if (e.key === "Escape") {
        setCapturing(false);
        setError(null);
        return;
      }

      const captured = acceleratorFromEvent(e);
      // Still holding modifiers: stay armed, say nothing.
      if (captured === "pending") return;
      if (captured === null) {
        setError("That key cannot be a global shortcut on its own.");
        return;
      }
      setCapturing(false);
      setError(null);
      onChange(captured);
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      setCapturingAccelerator(false);
    };
  }, [capturing, onChange]);

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          aria-label="Push-to-talk shortcut"
          aria-pressed={capturing}
          onClick={() => {
            setError(null);
            setCapturing((on) => !on);
          }}
          onBlur={() => setCapturing(false)}
          className={cn(
            "flex min-h-[26px] items-center gap-1 rounded-input border px-2 py-1 text-xs transition-colors",
            capturing
              ? "border-accent bg-accent-soft text-fg-primary"
              : "border-border bg-surface-2 text-fg-primary hover:border-border-hover",
          )}
        >
          {capturing ? (
            <span className="font-mono text-[11px] text-fg-secondary">
              Press a shortcut…
            </span>
          ) : (
            <Chips accelerator={accelerator} />
          )}
        </button>
        <button
          type="button"
          aria-label="Reset the push-to-talk shortcut to the default"
          title="Reset to default"
          disabled={isDefault}
          onClick={() => {
            setCapturing(false);
            setError(null);
            onChange(DEFAULT_VOICE_SETTINGS.accelerator);
          }}
          className={cn(
            "flex h-6 w-6 items-center justify-center rounded-input transition-colors",
            isDefault
              ? "cursor-not-allowed text-fg-muted opacity-40"
              : "text-fg-secondary hover:bg-surface-3 hover:text-fg-primary",
          )}
        >
          <RotateCcw className="h-3 w-3" />
        </button>
      </div>
      {/* Assertive: the user is mid-interaction and has just been told the key
          they pressed did not take. */}
      <span role="alert" className="text-[11px] text-warning">
        {error}
      </span>
      {/* The chord was ACCEPTED and shadows something. Polite rather than
          assertive, and rendered off the stored value rather than off the
          capture, so it is still there the next time Settings is opened —
          the collision outlives the moment it was created in. */}
      {conflict ? (
        <span
          role="status"
          className="max-w-[15rem] text-right text-[11px] leading-relaxed text-warning"
        >
          This chord also {conflict} in RocSpace. Push-to-talk is heard first,
          so that shortcut stops working while this is bound.
        </span>
      ) : null}
    </div>
  );
}

function InputDeviceSelect({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (device: string) => void;
}) {
  const [devices, setDevices] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    commands
      .roctalkListInputDevices()
      .then((names) => {
        if (!cancelled && Array.isArray(names)) setDevices(names);
      })
      .catch((err) => {
        // A host that cannot be enumerated still records from its default, so
        // this is a smaller dropdown rather than a broken screen.
        console.warn("[settings] roctalkListInputDevices failed:", err);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Offer the stored device even when it is not connected right now: silently
  // dropping it would make the select show "System default" while the setting
  // says otherwise, and the next reconnect would surprise everyone.
  const missing = value !== "" && !devices.includes(value);

  return (
    <select
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={selectClass}
    >
      <option value="">System default</option>
      {devices.map((device) => (
        <option key={device} value={device}>
          {device}
        </option>
      ))}
      {missing ? <option value={value}>{value} (not connected)</option> : null}
    </select>
  );
}

function ModelStatus({
  size,
  status,
  progress,
}: {
  size: WhisperModelSize;
  status: "missing" | "downloading" | "ready";
  progress: number;
}) {
  if (status === "ready") {
    return (
      <span className="flex items-center gap-1.5 text-xs text-fg-secondary">
        <span className="h-1.5 w-1.5 rounded-full bg-success" />
        Ready
      </span>
    );
  }

  if (status === "downloading") {
    return (
      <span className="flex items-center gap-1.5 text-xs text-fg-secondary">
        <Loader2 className="h-3 w-3 animate-spin text-accent" />
        Downloading {Math.round(progress * 100)}%
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={() => void startModelDownload(size)}
      className={cn(
        "flex items-center gap-1.5 rounded-input bg-surface-2 px-2.5 py-1 text-xs text-fg-primary transition-colors",
        "hover:bg-surface-3",
      )}
    >
      <Download className="h-3 w-3" />
      Download model
    </button>
  );
}

/** The voices `say` offers — exactly what `say -v ?` reports on this machine,
 *  and nothing this app has added.
 *
 *  The list is asked for once on mount — it is a subprocess, and the answer
 *  does not change while Settings is open. Empty off macOS (Rust says so
 *  rather than the UI guessing), which leaves "System default" as the only
 *  choice: the honest answer where there is nothing to choose between.
 *
 *  No Test button of its own. It used to have one, and Audition below replaced
 *  it rather than joining it: the voice, the rate and the manner are only
 *  judgeable together — what the user is deciding is whether they want to
 *  listen to THIS reading Roc's answers — and two buttons onto the same
 *  `rocSpeak` would be two ways to ask half the question. */
function SpeechVoiceSelect({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (voice: string) => void;
}) {
  const [voices, setVoices] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    commands
      .rocListVoices()
      .then((names) => {
        if (!cancelled && Array.isArray(names)) setVoices(names);
      })
      .catch((err) => {
        // A missing `say` is a shorter dropdown, not a broken screen.
        console.warn("[settings] rocListVoices failed:", err);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Offer the stored voice even when this system has never heard of it: a
  // settings file that travels between machines should not silently lose it.
  const missing = value !== "" && !voices.includes(value);

  return (
    <select
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={selectClass}
    >
      <option value="">System default</option>
      {voices.map((name) => (
        <option key={name} value={name}>
          {name}
        </option>
      ))}
      {missing ? <option value={value}>{value} (not installed)</option> : null}
    </select>
  );
}
