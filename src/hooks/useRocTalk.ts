import { useEffect, useLayoutEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  isAcceleratorKey,
  isDomOnlyAccelerator,
  matchesAccelerator,
} from "@/lib/accelerator";
import {
  EVENT_ROCTALK_AMPLITUDE,
  EVENT_ROCTALK_DOWNLOAD_PROGRESS,
  EVENT_ROCTALK_PTT_DOWN,
  EVENT_ROCTALK_PTT_UP,
  type RocTalkAmplitudeEvent,
  type RocTalkDownloadProgressEvent,
  type RocTalkModelStatus,
  commands,
} from "@/lib/bindings";
import { isWindows } from "@/lib/platform";
import { pasteSafeLine } from "@/lib/agentDispatch";
import { errorMessage } from "@/lib/utils";
import { getVoiceSink } from "@/lib/voiceSink";
import {
  useFocusedTerminalId,
  useRocTalkStore,
  useTerminalRuntimeStore,
  useToastsStore,
  useVoiceSettings,
  WINDOWS_PTT_ACCELERATOR,
  type VoiceSettings,
} from "@/stores";
import { cleanTranscript } from "@/utils/cleanTranscript";

/** Mount once at the AppShell level. Owns the bridge between Rust's RocTalk
 *  events and the store, and runs the dictation pipeline:
 *
 *    push-to-talk down → start recording
 *    push-to-talk up   → transcribe → cleanTranscript → route it
 *
 *  # Two sources, one pipeline
 *
 *  Push-to-talk arrives from either of two places, and which one depends on the
 *  platform (see `src-tauri/src/roctalk/ptt.rs`):
 *
 *  * `roctalk://ptt-down` / `ptt-up` from Rust — the global-shortcut
 *    accelerator everywhere but Windows, the WH_KEYBOARD_LL hook on Windows.
 *  * A DOM keydown/keyup pair, because Chromium / WebView2 route some keyboard
 *    input through raw input devices that BYPASS the LL hook while the app's
 *    own window has focus. Without this, Windows PTT worked only while
 *    RocSpace was in the background.
 *
 *  Both call the same two functions, and both are guarded by one status
 *  machine, so a key that fires both ways records once. That the two used to be
 *  two copies of the pipeline is the debt this file has carried since Phase 0.
 *
 *  # Refs, not state
 *
 *  Every value the handlers read lives in a ref, re-pointed in a LAYOUT effect.
 *  Passive effects flush asynchronously after paint, and neither a capture-phase
 *  keydown nor a Tauri `listen` callback is gated on React's scheduler: a
 *  down/up cycle landing in that gap right after a focus change would dictate
 *  into the terminal that WAS focused. */
export function useRocTalk(): void {
  const setStatus = useRocTalkStore((s) => s.setStatus);
  const setAmplitude = useRocTalkStore((s) => s.setAmplitude);
  const setModelStatus = useRocTalkStore((s) => s.setModelStatus);
  const setDownloadProgress = useRocTalkStore((s) => s.setDownloadProgress);

  const focusedTerminalId = useFocusedTerminalId();
  const focusedRef = useRef(focusedTerminalId);

  const enabled = useRocTalkStore((s) => s.enabled);
  const enabledRef = useRef(enabled);

  // Settings' accelerator picker is armed: every source stands down until it
  // is not. See `capturingAccelerator` in the store for why.
  const capturing = useRocTalkStore((s) => s.capturingAccelerator);
  const capturingRef = useRef(capturing);

  const modelStatus = useRocTalkStore((s) => s.modelStatus);
  const modelStatusRef = useRef(modelStatus);

  // Which model to transcribe with, which microphone to open, where the
  // transcript goes, and what key starts it.
  const voice = useVoiceSettings();
  const voiceRef = useRef(voice);

  const statusRef = useRef<"idle" | "recording" | "transcribing">("idle");

  // Declared first so it runs before the listener effects on every pass.
  useLayoutEffect(() => {
    focusedRef.current = focusedTerminalId;
    enabledRef.current = enabled;
    capturingRef.current = capturing;
    modelStatusRef.current = modelStatus;
    voiceRef.current = voice;
  });

  // Keep Rust's Windows hook in sync with the store's enabled flag.
  useEffect(() => {
    commands.roctalkSetEnabled(enabled).catch((err) => {
      console.warn("[roctalk] setEnabled failed:", err);
    });
  }, [enabled]);

  // Bind the global accelerator: at boot, again whenever it changes, and again
  // whenever RocTalk is switched back on.
  //
  // Rust holds no copy of this — `settings.dat` is the only place the choice
  // lives — so nothing is bound until this effect runs. A refusal is worth a
  // toast rather than a console line: the user chose a key, the key does not
  // work, and the only place that could say so is here.
  //
  // Switching RocTalk OFF gives the chord back. A registered accelerator is
  // taken from every application on the machine for as long as it is bound, so
  // an "off" that left it registered would keep stealing ⌥Space from the
  // editor next door while doing nothing with it — which is not off.
  //
  // The picker being armed releases it too, and for a sharper reason: the OS
  // consumes a registered accelerator before the webview ever sees it, so the
  // chord a user is trying to REBIND is unreachable by the control asking for
  // it until the binding is handed back.
  //
  // So does choosing a key the OS cannot be asked for at all (bare Caps Lock):
  // there is nothing to register, the DOM listener below is the whole of it,
  // and whatever WAS bound has to be given back or the old chord would keep
  // firing under the new choice.
  useEffect(() => {
    if (!enabled || capturing || isDomOnlyAccelerator(voice.accelerator)) {
      commands.pttUnregister().catch((err) => {
        console.warn("[roctalk] pttUnregister failed:", err);
      });
      return;
    }
    const accelerator = voice.accelerator;
    commands.pttRegister(accelerator).catch((err) => {
      console.warn("[roctalk] pttRegister failed:", err);
      useToastsStore.getState().push({
        message: `${accelerator} could not be used for push-to-talk — another application may already have it`,
        tone: "warn",
      });
    });
  }, [capturing, enabled, voice.accelerator]);

  // Give the accelerator back when the app tears this down. Separate from the
  // effect above so a change of accelerator does not unregister the one it just
  // registered — `pttRegister` already replaces.
  useEffect(() => {
    return () => {
      commands.pttUnregister().catch(() => {});
    };
  }, []);

  // Is the SELECTED model on disk? Re-asked whenever the selection changes:
  // the store holds one status because only one size is ever transcribed with,
  // and switching to a size that has not been downloaded has to put the
  // download offer back on screen.
  useEffect(() => {
    let cancelled = false;
    commands
      .roctalkGetModelStatus(voice.modelSize)
      .then((status) => {
        if (!cancelled) setModelStatus(status as RocTalkModelStatus);
      })
      .catch((err) => console.warn("[roctalk] getModelStatus failed:", err));
    return () => {
      cancelled = true;
    };
  }, [setModelStatus, voice.modelSize]);

  // The pipeline and every source that drives it. One effect, because the two
  // sources share the two functions and the guard between them.
  useEffect(() => {
    // — the pipeline ————————————————————————————————————————————————

    /** Begin recording, if everything a recording needs is true.
     *
     *  Idempotent: the status guard makes a second down — from the other
     *  source, or from autorepeat — a no-op rather than a restart. */
    const startDictation = (source: "rust" | "dom") => {
      if (statusRef.current !== "idle") return;
      if (!enabledRef.current) {
        console.warn(`[roctalk] ${source} PTT-down ignored: RocTalk is off`);
        return;
      }
      // Releasing the accelerator is a round trip; a chord pressed before it
      // lands still arrives from Rust, and a recording started under the picker
      // is exactly what the picker is trying to prevent.
      if (capturingRef.current) {
        console.warn(
          `[roctalk] ${source} PTT-down ignored: a shortcut is being captured`,
        );
        return;
      }
      if (modelStatusRef.current !== "ready") {
        console.warn(
          `[roctalk] ${source} PTT-down ignored: Whisper model is`,
          modelStatusRef.current,
          "(download it from Settings → Voice)",
        );
        return;
      }
      // A transcript bound for a terminal needs a terminal. One bound for Roc
      // does not — being able to talk to Roc with no pane focused is most of
      // why the routing setting exists.
      if (!hasDestination(voiceRef.current, focusedRef.current)) {
        console.warn(
          `[roctalk] ${source} PTT-down ignored: nothing focused to dictate into`,
        );
        return;
      }
      statusRef.current = "recording";
      setStatus("recording");
      commands
        .roctalkStartRecording(voiceRef.current.inputDevice)
        .catch((err) => {
          console.warn(`[roctalk] ${source} startRecording failed:`, err);
          statusRef.current = "idle";
          setStatus("idle");
          // The pill going quiet again is not an explanation. A microphone
          // that is asleep, unplugged or held by another application is the
          // usual cause, and Rust's message names it.
          useToastsStore.getState().push({
            message: `Recording could not start — ${errorMessage(
              err,
              "the microphone did not answer",
            )}`,
            tone: "warn",
          });
        });
    };

    /** Say — once — that a transcript routed to Roc went to the terminal
     *  instead. Once per mount, not once per sentence: nothing having claimed
     *  the sink is a standing condition, and a toast for every dictation would
     *  be a wall of them for one fact. */
    let warnedRocMissing = false;
    const warnRocMissing = () => {
      if (warnedRocMissing) return;
      warnedRocMissing = true;
      useToastsStore.getState().push({
        message:
          "Roc is not open, so the transcript went to the focused terminal",
        tone: "warn",
      });
    };

    /** Stop, transcribe, and deliver. Only the source that saw the recording
     *  start gets past the guard. */
    const stopDictation = async (source: "rust" | "dom") => {
      if (statusRef.current !== "recording") return;
      statusRef.current = "transcribing";
      setStatus("transcribing");
      try {
        const raw = await commands.roctalkStopRecordingAndTranscribe(
          voiceRef.current.modelSize,
        );
        // Read the destination AFTER the transcription, not before it: focus
        // can move while Whisper is thinking, and what the user meant is the
        // pane they are looking at when the words arrive.
        await deliverTranscript(
          cleanTranscript(raw),
          voiceRef.current,
          focusedRef.current,
          warnRocMissing,
        );
      } catch (err) {
        console.warn(`[roctalk] ${source} transcribe failed:`, err);
      } finally {
        statusRef.current = "idle";
        setStatus("idle");
        setAmplitude(0);
      }
    };

    // — the DOM source ——————————————————————————————————————————————
    //
    // Listens for whatever drives PTT on this platform: the Windows hook's
    // Caps Lock, or the configured accelerator elsewhere. On macOS the OS
    // consumes a registered accelerator before the webview ever sees it, so in
    // practice this only fires when registration FAILED — which is exactly when
    // a fallback is worth having.

    let domDown = false;

    const domAccelerator = () =>
      isWindows() ? WINDOWS_PTT_ACCELERATOR : voiceRef.current.accelerator;

    const onKeyDown = (e: KeyboardEvent) => {
      // Asked BEFORE the event is swallowed. A chord that is not going to
      // record anything must reach whatever it was typed into: RocTalk turned
      // off and still eating ⌥Space in the terminal is the same theft as
      // leaving the accelerator registered, one layer down. And while the
      // picker is armed the chord is not push-to-talk at all — it is the answer
      // to the question the picker is asking, and this listener is ahead of it
      // in the propagation path.
      if (!enabledRef.current || capturingRef.current) return;
      if (!matchesAccelerator(e, domAccelerator())) return;
      // Swallow it: Caps Lock must not toggle the caps state (the LL hook's
      // LRESULT(1) suppression, mirrored), and no accelerator held for
      // push-to-talk should also reach the terminal underneath.
      e.preventDefault();
      e.stopPropagation();
      if (domDown) return;
      domDown = true;
      startDictation("dom");
    };

    const onKeyUp = (e: KeyboardEvent) => {
      // Not `matchesAccelerator`: releasing the modifier first changes what the
      // event looks like, and a hold that never ended would strand the recorder
      // (and the microphone) open. Any keyup for the chord's own key ends it.
      //
      // Deliberately NOT gated on `enabled` either: switching RocTalk off
      // mid-hold must still end the hold it already started.
      if (!domDown) return;
      if (!isAcceleratorKey(e, domAccelerator())) return;
      e.preventDefault();
      e.stopPropagation();
      domDown = false;
      void stopDictation("dom");
    };

    // Capture phase + window so we beat xterm's keystroke handler.
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);

    // — the Rust source, and the two report-only events ——————————————

    let amplitudeRaf: number | null = null;
    let pendingAmplitude = 0;
    const flushAmplitude = () => {
      amplitudeRaf = null;
      setAmplitude(pendingAmplitude);
    };

    const unlistenPromises = [
      listen<void>(EVENT_ROCTALK_PTT_DOWN, () => startDictation("rust")),
      listen<void>(EVENT_ROCTALK_PTT_UP, () => void stopDictation("rust")),

      listen<RocTalkAmplitudeEvent>(EVENT_ROCTALK_AMPLITUDE, (event) => {
        // Coalesce 30 Hz events into one rAF tick to avoid thrashing React.
        pendingAmplitude = event.payload.rms;
        if (amplitudeRaf === null) {
          amplitudeRaf = requestAnimationFrame(flushAmplitude);
        }
      }),

      listen<RocTalkDownloadProgressEvent>(
        EVENT_ROCTALK_DOWNLOAD_PROGRESS,
        (event) => {
          const { modelSize, received, total } = event.payload;
          // Sizes download independently. Bytes for a model the user is not
          // looking at must not fill this one's ring.
          if (modelSize !== voiceRef.current.modelSize) return;
          const ratio = total > 0 ? received / total : 0;
          setDownloadProgress(ratio);
          if (ratio >= 1) {
            // Refetch authoritative status from Rust once the file is in place.
            commands
              .roctalkGetModelStatus(modelSize)
              .then((s) => setModelStatus(s as RocTalkModelStatus))
              .catch(() => {});
          } else {
            // Bytes are arriving, so this size is downloading whoever started
            // it. Said here as well as at the click because a status of
            // "missing" renders an offer to download what is already coming.
            setModelStatus("downloading");
          }
        },
      ),
    ];

    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      if (amplitudeRaf !== null) cancelAnimationFrame(amplitudeRaf);
      void Promise.all(unlistenPromises).then((unlistens) => {
        for (const un of unlistens) un();
      });
    };
  }, [setStatus, setAmplitude, setDownloadProgress, setModelStatus]);
}

/** Is there somewhere for a transcript to go right now?
 *
 *  Routed to Roc there always is — the widget takes what it is given whether or
 *  not a pane is focused, and when nothing has claimed the sink the delivery
 *  falls back to the focused terminal, which is the same question again. */
function hasDestination(
  voice: VoiceSettings,
  focusedTerminalId: string | null,
): boolean {
  if (voice.routeTo === "roc" && getVoiceSink() !== null) return true;
  return focusedTerminalId !== null;
}

/** Hand a finished transcript to whatever the routing setting names.
 *
 *  Terminal delivery is a WRITE, not a dispatch: the text lands in the pane's
 *  prompt and stops there, with no bracketed-paste frame and no carriage
 *  return, exactly as dictation has always behaved. That is deliberate — a
 *  submit would run whatever Whisper thought it heard — so this shares Phase
 *  3's SANITIZER (`pasteSafeLine`: no ESC, no C0, no rebuildable paste marker)
 *  without its framing. `cleanTranscript` already folds newlines into spaces;
 *  this is the second belt, for whatever a speech model can be talked into
 *  emitting.
 *
 *  The pane is marked as having had user input, because it has: the idle
 *  watchdog and the notification bridge both gate on that flag, and a pane
 *  dictated into without it would neither warn about a permission prompt nor
 *  ping when it finished. Deliberately the raw flag rather than
 *  `notifyTerminalUserInput`, which ALSO clears `awaiting_approval` — nothing
 *  was submitted here, so the question on screen is still unanswered and the
 *  dot must stay amber. */
async function deliverTranscript(
  cleaned: string,
  voice: VoiceSettings,
  focusedTerminalId: string | null,
  onRocMissing: () => void,
): Promise<void> {
  if (!cleaned) return;

  if (voice.routeTo === "roc") {
    const sink = getVoiceSink();
    if (sink) {
      sink(cleaned);
      return;
    }
    // Nothing has claimed the sink — Roc is not open. Fall through to the
    // terminal rather than losing what was said, and SAY SO: the setting names
    // a destination, the words went somewhere else, and a console line is a
    // message in a window nobody has open. The user would otherwise find the
    // sentence they aimed at Roc typed into a shell prompt with no explanation.
    console.warn(
      "[roctalk] routing is Roc, but nothing is listening — sending to the focused terminal instead",
    );
    onRocMissing();
  }

  if (!focusedTerminalId) return;
  await commands.terminalWrite(focusedTerminalId, pasteSafeLine(cleaned));
  useTerminalRuntimeStore.getState().notifyUserInput(focusedTerminalId);
}
