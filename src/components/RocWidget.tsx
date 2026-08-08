/** Roc's floating widget — the orchestrator's always-available face.
 *
 *  Evolved from `RocTalkPill`, which it replaces. The behaviour that pill
 *  earned is PORTED rather than rewritten, because it is the kind of thing that
 *  is only right after it has been used: the drag, with its click/drag
 *  threshold and its re-clamp on resize — still reading and writing
 *  `useRocTalkStore.position`, which is the persisted one, so a widget dragged
 *  into a corner is still there after a restart.
 *
 *  Its seven amplitude bars are GONE, and their job went to the orb. They were
 *  a second, worse drawing of the one signal the orb now IS — and they carried
 *  it by subscribing this card to a store field that changes thirty times a
 *  second, which put React's reconciler behind every sample for the whole
 *  session. The one thing they said that the ring alone would not is that a
 *  silent microphone is not a broken one; the orb's core keeps a slow baseline
 *  breath for exactly that.
 *
 *  What is new is the card around them: a phase line the user can read at a
 *  glance, a transcript line that announces itself, and the three buttons that
 *  make the widget a way IN to Roc rather than only a dictation indicator.
 *
 *  ── The mode switch ──────────────────────────────────────────────────────
 *  The footer carries a segmented control between dictating and talking to
 *  Roc, always visible, because that is what the owner asked for after living with
 *  it: the two modes are used minutes apart and the only way to change them
 *  was Settings › Voice. It writes through `setVoiceOption`, the same writer
 *  Settings uses, so there is one answer to "which mode am I in" rather than
 *  two that can drift.
 *
 *  It also pushed the buttons out of the header row, and that is the point of
 *  the layout rather than a consequence of it: the phase line now names the
 *  DESTINATION while the key is held ("Listening — dictating to Rocky"), and
 *  the sixty pixels six icons used to leave behind would have truncated away
 *  exactly the word worth reading.
 *
 *  The orb does not animate when Roc is idle. That is a compositor cost, not a
 *  taste call: a decoration turning forever is a layer repainting behind
 *  sixteen terminals for the entire time the app is open. See `RocOrb`. */

import { useEffect, useRef, useState } from "react";
import {
  Download,
  Maximize2,
  Mic,
  MicOff,
  Minimize2,
  Send,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import { type RocTalkModelStatus } from "@/lib/bindings";
import { RocOrb, type RocOrbState } from "@/components/RocOrb";
import { askRoc, stopRocSpeaking, useRocAsking } from "@/lib/rocBrain";
import { sendRocCommand } from "@/lib/rocDispatch";
import { aimRocCommand } from "@/lib/rocTargets";
import { cn } from "@/lib/utils";
import { setVoiceSink } from "@/lib/voiceSink";
import {
  useFocusedTerminalId,
  useRocBrainError,
  useRocExpanded,
  useRocOpen,
  useRocPhase,
  useRocReply,
  useRocStore,
  useRocTalkStore,
  useRocTranscript,
  useTerminalsStore,
  useVoiceSettings,
  type RocPhase,
  type VoiceRoute,
} from "@/stores";
import { startModelDownload } from "@/lib/roctalkModel";
import { useSettingsStore } from "@/stores/settings";
import type { RocTalkStatus } from "@/stores/roctalk";

/** Wider than the pill it grew out of, and the footer is why: with a transcript
 *  in hand and a reply being read, six icon buttons and both mode labels share
 *  this row, and a switch whose second option truncates to "Talk to R…" is a
 *  switch you have to hover to read. The width alone was not enough — see
 *  `ModeSwitch`, where the labels stopped being the thing that gives way. */
const WIDGET_WIDTH = 320;
/** The card's FLOOR, and only that — it is `minHeight`, not `height`.
 *
 *  What it is not is the number to clamp a drag against. The card is 106.5
 *  pixels tall with nothing to say and 127 with a transcript and a reply on it,
 *  and it grows again when the footer wraps — so a clamp that assumed this
 *  constant let the user drag 23 pixels of card out through the bottom of an
 *  `overflow-hidden` parent, taking half the mode switch and every icon button
 *  with it and leaving no way to get them back. Everything that clamps measures
 *  the card instead (`cardHeight`); this is the floor that measurement falls
 *  back to before the first layout. */
const WIDGET_MIN_HEIGHT = 104;
/** Movement threshold — below this, a pointer release is treated as a click. */
const DRAG_THRESHOLD_PX = 4;

/** How tall the card actually is right now.
 *
 *  Measured rather than assumed, because it is a `minHeight` card: a reply is
 *  one more line, and a crowded footer is one more row. `offsetHeight` is a
 *  read of a layout that has already happened rather than one that forces a new
 *  one, and it is only ever asked at a pointer move or a resize — never inside
 *  a frame. Falls back to the floor before the first layout, and in jsdom,
 *  which measures everything as zero. */
function cardHeight(card: HTMLElement | null): number {
  return Math.max(card?.offsetHeight ?? 0, WIDGET_MIN_HEIGHT);
}

/** The two things the push-to-talk key can do, said as what happens to the
 *  user rather than as which store field flips.
 *
 *  One table, and the switch below is what reads it — the palette's two actions
 *  (`voice.route-terminal`, `voice.route-roc`) name the same two modes in their
 *  own words, because a command is phrased as the thing it does. What they do
 *  share is the WRITER: all of them go through `setVoiceOption`, so the switch,
 *  the palette and Settings › Voice cannot disagree about which mode is live. */
export const ROC_MODES: readonly {
  route: VoiceRoute;
  label: string;
  hint: string;
}[] = [
  {
    route: "terminal",
    label: "Dictate",
    hint: "Types what you say into the focused pane.",
  },
  {
    route: "roc",
    label: "Talk to Roc",
    hint: "Roc listens, answers, and can brief your agents.",
  },
];

/** What the widget says it is doing, and whether that counts as "live".
 *
 *  Pure, and exported, because it is the one piece of this component with a
 *  right answer: two stores describe the same moment from different angles —
 *  RocTalk knows about the microphone, Roc knows about the conversation — and
 *  the microphone wins while it is open, because that is the half the user is
 *  actively doing something about.
 *
 *  `live` is what turns the orb's ring on, so it must be false for every state
 *  in which nothing is happening.
 *
 *  While the key is HELD the label also names where the words are going, and
 *  that is the moment it matters: the mode is a setting the user changed once
 *  and a sentence they are saying now, and "Listening" alone cannot tell them
 *  apart. In dictation it names the pane, because "the focused terminal" is a
 *  category and `Rocky` is the thing they will have to undo. */
export function describeRoc(input: {
  phase: RocPhase;
  talkStatus: RocTalkStatus;
  enabled: boolean;
  modelStatus: RocTalkModelStatus;
  /** Where a finished transcript is routed right now. */
  routeTo: VoiceRoute;
  /** The pane dictation would type into, by name, or null when nothing is
   *  focused — which is also when dictation refuses to start. */
  destination: string | null;
}): { label: string; orb: RocOrbState } {
  const { phase, talkStatus, enabled, modelStatus, routeTo, destination } =
    input;
  const listening = (): { label: string; orb: RocOrbState } => ({
    label: listeningLabel(routeTo, destination),
    orb: "listening",
  });
  if (talkStatus === "recording") return listening();
  // Whisper crunching the audio is a wait with a result coming, which is what
  // the orb's thinking sweep means — and it must not look like listening, or
  // the user keeps talking at a microphone that has already closed.
  if (talkStatus === "transcribing")
    return { label: "Thinking", orb: "thinking" };
  if (phase === "listening") return listening();
  if (phase === "thinking") return { label: "Thinking", orb: "thinking" };
  // Named separately because the words are worth reading — but it is the same
  // BEHAVIOUR as thinking: work is out, and your voice is not driving it.
  if (phase === "dispatching") return { label: "Dispatching", orb: "thinking" };
  if (phase === "speaking") return { label: "Speaking", orb: "speaking" };
  if (modelStatus === "downloading")
    return { label: "Downloading voice model", orb: "idle" };
  if (modelStatus === "missing")
    return { label: "Voice model needed", orb: "idle" };
  if (!enabled) return { label: "Voice off", orb: "idle" };
  return { label: "Ready", orb: "idle" };
}

function listeningLabel(
  routeTo: VoiceRoute,
  destination: string | null,
): string {
  if (routeTo === "roc") return "Listening — Roc is listening";
  // No pane focused: dictation will not have started, but the label is drawn
  // from a phase the conversation can also set, so it must still read as a
  // sentence rather than as "dictating to null".
  if (!destination) return "Listening — dictating";
  return `Listening — dictating to ${destination}`;
}

export function RocWidget(): React.ReactElement | null {
  const open = useRocOpen();
  const expanded = useRocExpanded();
  const phase = useRocPhase();
  const transcript = useRocTranscript();
  const reply = useRocReply();
  const brainError = useRocBrainError();
  const toggleOpen = useRocStore((s) => s.toggleOpen);
  const setExpanded = useRocStore((s) => s.setExpanded);

  const talkStatus = useRocTalkStore((s) => s.status);
  const voice = useVoiceSettings();
  const setVoiceOption = useSettingsStore((s) => s.setVoiceOption);
  // Which pane a dictated sentence would be typed into, by name.
  //
  // This card deliberately does not subscribe to the terminals store for its
  // send button (see `handleSend`), because that would walk every session on
  // every animation frame that carries PTY output. This selector is a different
  // shape and is safe on the same hot path: one lookup by id, returning a
  // string, so zustand's identity check drops every write that did not rename
  // the pane the user is pointing at.
  const focusedTerminalId = useFocusedTerminalId();
  const destination = useTerminalsStore((s) =>
    focusedTerminalId ? (s.byId[focusedTerminalId]?.name ?? null) : null,
  );
  const enabled = useRocTalkStore((s) => s.enabled);
  const setEnabled = useRocTalkStore((s) => s.setEnabled);
  const position = useRocTalkStore((s) => s.position);
  const setPosition = useRocTalkStore((s) => s.setPosition);
  const modelStatus = useRocTalkStore((s) => s.modelStatus);
  const downloadProgress = useRocTalkStore((s) => s.downloadProgress);

  // Claim the routed transcripts for Roc, for as long as one of Roc's two
  // surfaces is on screen to show them.
  //
  // The seam is `lib/voiceSink`, and it is a seam rather than a call because
  // `useRocTalk` must not import this store, this phase machine and this view —
  // it is the dictation pipeline, and it already knows how to type into a PTY.
  // So the destination registers itself and the hook asks for whatever is
  // registered; with nothing registered it falls back to the focused terminal
  // rather than dropping what was said.
  //
  // Here rather than in `RocView` on purpose: the widget outlives the expanded
  // view (it is mounted for the whole session), and dictation has to reach Roc
  // whether or not the big surface is up. What arrives is a transcript nobody
  // has acted on yet — so it goes in the box, and that is ALL it does.
  //
  // Which is exactly why the claim is CONDITIONAL. This component renders null
  // while the widget is closed (`if (!open)` below), but a `useEffect` runs
  // whatever the render returns — so a closed widget went on holding the sink,
  // `useRocTalk` went on reporting that a destination existed, and the words
  // were handed to `setTranscript` for a store field with nothing mounted to
  // draw it. Hiding the widget and holding push-to-talk produced no orb, no
  // text, no toast and no fallback: the "Roc is not open → type it into the
  // terminal and say so" path in `deliverTranscript` is keyed on the sink being
  // NULL, so a claim nothing renders is what made it unreachable. `expanded`
  // is the other half — it mirrors `mainView === "roc"`, where `RocStage` draws
  // the same transcript — so the widget can be closed with Roc still open.
  //
  // It used to move the phase to "thinking", which was a label with nothing
  // behind it: a sentence sitting on screen waiting for the user to press
  // something is not Roc thinking about anything, and the orb turned for it
  // until they did. "Thinking" now means the one thing it says — a reasoning
  // turn is out (`runRocBrain`) — and the transcript line, which announces
  // itself, is what says the words landed.
  const showsTranscript = open || expanded;
  useEffect(() => {
    if (!showsTranscript) return;
    setVoiceSink((text) => useRocStore.getState().setTranscript(text));
    return () => setVoiceSink(null);
  }, [showsTranscript]);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    moved: boolean;
  } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  /** One turn at a time, across the whole app — the flag lives in `rocBrain`,
   *  so this sparkle and the stage's Ask are the same button as far as a turn is
   *  concerned. Two local flags meant two paid turns for one question. */
  const asking = useRocAsking();

  // Clamp the persisted position back into bounds whenever the box it lives in
  // changes — which is the PARENT resizing (the window, or the dock swapping
  // for the Roc view) or the CARD growing. Both matter: a card sitting on the
  // bottom edge that gains a reply line pushes that many pixels of itself out
  // through an `overflow-hidden` parent, and what leaves first is the footer.
  useEffect(() => {
    const card = containerRef.current;
    const el = card?.parentElement;
    if (!card || !el) return;
    const observer = new ResizeObserver(() => {
      const bounds = el.getBoundingClientRect();
      const maxX = Math.max(0, bounds.width - WIDGET_WIDTH);
      const maxY = Math.max(0, bounds.height - cardHeight(card));
      const clampedX = Math.min(Math.max(position.x, 0), maxX);
      const clampedY = Math.min(Math.max(position.y, 0), maxY);
      if (clampedX !== position.x || clampedY !== position.y) {
        setPosition({ x: clampedX, y: clampedY });
      }
    });
    observer.observe(el);
    observer.observe(card);
    return () => observer.disconnect();
  }, [position.x, position.y, setPosition]);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragStateRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      originX: position.x,
      originY: position.y,
      moved: false,
    };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragStateRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
    drag.moved = true;
    if (!isDragging) setIsDragging(true);

    const parent = containerRef.current?.parentElement;
    const bounds = parent?.getBoundingClientRect();
    const maxX = bounds ? Math.max(0, bounds.width - WIDGET_WIDTH) : 9999;
    // The card as it is NOW, not as it was when it had nothing to say: the
    // bottom edge of a tall card has to stop at the bottom edge of the parent,
    // or the footer is dragged out of an `overflow-hidden` box and cannot be
    // clicked or dragged back.
    const maxY = bounds
      ? Math.max(0, bounds.height - cardHeight(containerRef.current))
      : 9999;
    const nextX = Math.min(Math.max(drag.originX + dx, 0), maxX);
    const nextY = Math.min(Math.max(drag.originY + dy, 0), maxY);
    setPosition({ x: nextX, y: nextY });
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragStateRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    dragStateRef.current = null;
    setIsDragging(false);
  };

  if (!open) return null;

  const isDownloading = modelStatus === "downloading";
  const isMissing = modelStatus === "missing";
  const { label, orb } = describeRoc({
    phase,
    talkStatus,
    enabled,
    modelStatus,
    routeTo: voice.routeTo,
    destination,
  });
  // One derived answer rather than a second field beside `orb` that could
  // disagree with it: anything the orb is doing something about is live.
  const live = orb !== "idle";

  /** Send what was just dictated, from the widget, without opening anything.
   *
   *  The premise of the phase is talking to your agents from wherever you are,
   *  and a transcript that can only be sent from a view the user has to open
   *  first fails that on its own terms. Confirmed rather than automatic for the
   *  reason the stage's button is: Whisper mishears, and a fan-out cannot be
   *  taken back.
   *
   *  Resolved AT THE CLICK, not on every render, and that is a deliberate
   *  performance call rather than laziness: this widget is mounted for the whole
   *  session, and subscribing it to the terminals store — which is rewritten on
   *  every animation frame that carries PTY output — would put a walk of every
   *  session behind sixty repaints a second for a label. So the button says what
   *  it does rather than who it would reach; who it reaches is answered out loud
   *  by the fan-out, which names the panes it skipped and says plainly when
   *  there was nobody to send to. */
  const handleSend = () => {
    // `aimRocCommand` strips the addressing out of the text, so `@Rocky run the
    // tests` reaches Rocky as "run the tests" rather than as a message about
    // itself — and `sendRocCommand` is what says which of those names matched
    // nothing. This used to take the targets and drop the unknowns on the
    // floor: "@Rocky @Roxie deploy" with Roxie closed went to Rocky with not
    // one word said about Roxie. Same helper as the stage's Enter, so a third
    // way in cannot quietly go silent again.
    const sent = sendRocCommand(
      aimRocCommand(transcript, {
        selectedIds: useRocStore.getState().selectedTerminalIds,
        activeWorkspaceOnly: false,
      }),
    );
    // Cleared once it has gone — which also stops the orb turning for a
    // thought that has been had. Kept if it went nowhere: this button, unlike
    // the stage's, cannot grey itself out (see above — it does not know who it
    // would reach until it is pressed), so pressing it with nobody there is a
    // normal thing to do and must not eat what was dictated.
    if (sent) useRocStore.getState().clearTranscript();
  };

  /** The whole turn, from a widget the user has not opened anything to reach.
   *
   *  The premise of the phase is talking to your agents from wherever you are,
   *  and that has to include being understood — not just transcribed. Same
   *  entry point as the stage's Ask (`askRoc`), so the two cannot drift about
   *  what a turn is: think, reply, speak, and then either send (auto-dispatch)
   *  or propose.
   *
   *  A proposal needs somewhere to be confirmed, and this card is 320 pixels
   *  wide with a footer already fighting for them — so a turn that came back
   *  with work to do opens the Roc view, where the list with Send / Edit / Drop
   *  lives. */
  const handleAsk = () => {
    if (transcript.trim() === "") return;
    // The guard is `askRoc`'s: it is the only thing that can see a turn the
    // stage started, and a null answer is either that or a turn that failed —
    // and neither is a reason to clear what was dictated.
    void askRoc(transcript).then((plan) => {
      if (!plan) return;
      useRocStore.getState().clearTranscript();
      const { autoDispatch } = useSettingsStore.getState().roc;
      if (plan.assignments.length > 0 && !autoDispatch) {
        useRocStore.getState().setExpanded(true);
      }
    });
  };

  const handleMic = () => {
    if (isMissing) {
      // `startModelDownload` owns the status for every caller (it flips to
      // "downloading" at the click and re-asks Rust at the end), so the widget
      // does not have to duplicate that bookkeeping.
      void startModelDownload(voice.modelSize);
      return;
    }
    setEnabled(!enabled);
  };

  return (
    <div
      ref={containerRef}
      data-roc-widget
      role="group"
      aria-label="Roc"
      style={{
        left: position.x,
        top: position.y,
        width: WIDGET_WIDTH,
        // A floor rather than a height: a reply is one more line, and a card
        // that refused to grow for it would print it outside its own border.
        // Everything that clamps this card measures it (`cardHeight`) rather
        // than assuming this number.
        minHeight: WIDGET_MIN_HEIGHT,
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      className={cn(
        "absolute z-50 flex select-none flex-col gap-1 rounded-card border bg-surface-2/90 px-2.5 py-2 backdrop-blur",
        "shadow-[0_8px_24px_-8px_rgba(0,0,0,0.6)] transition-colors",
        isDragging ? "cursor-grabbing" : "cursor-grab",
        live ? "border-border-active" : "border-border-hover",
        !enabled && !isMissing && "opacity-70",
      )}
    >
      {/* The orb and what it is doing. The buttons used to share this row and
          they are in the footer now, because the phase line is the thing that
          grew: while the key is held it names the destination, and a label
          squeezed into the 60 pixels six icons leave behind would truncate away
          exactly the word that matters. */}
      <div className="flex items-center gap-2">
        <RocOrb
          state={orb}
          size={40}
          downloading={isDownloading}
          progress={downloadProgress}
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-semibold text-fg-primary">Roc</p>
          {/* Announced, because the orb is `aria-hidden` and this line is the
              whole of what it says. Politely: a phase changes a handful of
              times per turn, and it must not talk over the agent output being
              read.

              Here rather than on the stage, which draws the same phase from the
              same `describeRoc`: this card is the surface that is up whenever
              Roc is, so it is the one that speaks, and the stage announces only
              while this one is closed (see `announce` there). Two live regions
              holding one string is every transition read out twice. */}
          <p
            aria-live="polite"
            className="truncate text-[11px] text-fg-muted"
            title={label}
          >
            {label}
          </p>
        </div>
      </div>

      {/* The transcript, and the only thing here worth announcing: it is the
          app repeating back what it heard, which is exactly the case a screen
          reader user cannot check by looking at the orb. Polite so it waits for
          a gap rather than talking over the agent output being read. */}
      <p
        aria-live="polite"
        className="truncate text-[11px] italic text-fg-secondary"
      >
        {transcript || " "}
      </p>

      {/* What Roc said back, or why it could not. The error wins: a reply from
          the turn before would be the app answering a question it has just
          failed to answer. */}
      {brainError || reply ? (
        <p
          aria-live="polite"
          className={cn(
            "truncate text-[11px]",
            brainError ? "text-warning" : "text-fg-primary",
          )}
        >
          {brainError ?? reply}
        </p>
      ) : null}

      {/* The mode, and the way out of it. Both on screen at all times, because
          the thing the owner asked for after using this is that switching between
          dictating and talking should not be a trip through Settings — and a
          control you have to open something to find is that trip with extra
          steps. */}
      {/* Wrapping, and that is the release valve: the switch is sized by its
          own labels (see `ModeSwitch`), so when the six-button state and a
          wider font together ask for more than 300 pixels, the icons drop to a
          second row rather than the label losing its last letters. The card is
          a `minHeight` one and everything that clamps it measures it, so a
          second row costs nothing but height. */}
      <div
        className="mt-auto flex flex-wrap items-center gap-2"
        // Everything here lives inside the drag surface; without this a click
        // would also start a drag from under the pointer.
        onPointerDown={(e) => e.stopPropagation()}
      >
        <ModeSwitch
          route={voice.routeTo}
          onChange={(route) => setVoiceOption("routeTo", route)}
        />
        {/* Flush, not spaced: the ten pixels five gaps cost are the ten pixels
            "Talk to Roc" needs in the six-button state. Each button keeps its
            own 24-pixel target and its own hover shape, so a row of them still
            reads as six things rather than one. */}
        <div className="flex items-center">
          <WidgetButton
            label={
              isMissing
                ? "Download the voice model"
                : enabled
                  ? "Turn voice off"
                  : "Turn voice on"
            }
            onClick={handleMic}
            active={enabled && !isMissing}
          >
            {isMissing ? (
              <Download className="h-3.5 w-3.5" />
            ) : enabled ? (
              <Mic className="h-3.5 w-3.5" />
            ) : (
              <MicOff className="h-3.5 w-3.5" />
            )}
          </WidgetButton>
          {transcript ? (
            <WidgetButton
              label={asking ? "Roc is thinking" : "Ask Roc what to do with it"}
              onClick={handleAsk}
              active={asking}
            >
              <Sparkles className="h-3.5 w-3.5" />
            </WidgetButton>
          ) : null}
          {transcript ? (
            <WidgetButton label="Send what Roc heard" onClick={handleSend}>
              <Send className="h-3.5 w-3.5" />
            </WidgetButton>
          ) : null}
          {phase === "speaking" ? (
            <WidgetButton
              label="Stop speaking"
              onClick={() => void stopRocSpeaking()}
            >
              <Square className="h-3 w-3" />
            </WidgetButton>
          ) : null}
          <WidgetButton
            label={expanded ? "Collapse Roc" : "Expand Roc"}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? (
              <Minimize2 className="h-3.5 w-3.5" />
            ) : (
              <Maximize2 className="h-3.5 w-3.5" />
            )}
          </WidgetButton>
          <WidgetButton label="Close Roc" onClick={toggleOpen}>
            <X className="h-3.5 w-3.5" />
          </WidgetButton>
        </div>
      </div>
    </div>
  );
}

/** Which of the two things the push-to-talk key does, and the one click that
 *  changes it.
 *
 *  A radiogroup rather than a toggle: both options are named and both are on
 *  screen, so the user never has to infer the state they are NOT in from the
 *  label of a button. `setVoiceOption` is the only writer — the same one
 *  Settings uses — so this control and Settings › Voice cannot disagree about
 *  which mode is live.
 *
 *  …and calling it a radiogroup is a promise about the KEYBOARD, which it did
 *  not keep: both options were tab stops and the arrows did nothing, so a
 *  screen reader announced "radio button, 1 of 2" and the key the user then
 *  pressed was dead. The model below is the one this codebase already uses in
 *  `AppearanceSection`'s theme picker and `AgentsSection`'s permission group —
 *  arrows move AND select, Home and End go to the ends, and a roving tabindex
 *  keeps the whole group to a single tab stop. */
function ModeSwitch({
  route,
  onChange,
}: {
  route: VoiceRoute;
  onChange: (route: VoiceRoute) => void;
}) {
  const groupRef = useRef<HTMLDivElement | null>(null);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // Read out of the DOM rather than off `ROC_MODES`, so the order the keys
    // move in cannot drift from the order on screen.
    const options = Array.from(
      groupRef.current?.querySelectorAll<HTMLElement>("[data-roc-mode]") ?? [],
    );
    if (options.length === 0) return;
    const current = options.findIndex((o) => o.dataset.rocMode === route);
    const wanted =
      e.key === "ArrowRight" || e.key === "ArrowDown"
        ? current + 1
        : e.key === "ArrowLeft" || e.key === "ArrowUp"
          ? current - 1
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? options.length - 1
              : null;
    if (wanted === null) return;
    e.preventDefault();
    // Autorepeat is not browsing. With two options a held arrow is the mode
    // flipping thirty times a second, and every flip is a persisted setting.
    if (e.repeat) return;
    const next = options[(wanted + options.length) % options.length]!;
    const nextMode = ROC_MODES.find((m) => m.route === next.dataset.rocMode);
    if (nextMode) onChange(nextMode.route);
    next.focus();
  };

  return (
    <div
      ref={groupRef}
      role="radiogroup"
      aria-label="What the push-to-talk key does"
      onKeyDown={onKeyDown}
      // `flex-1` so it takes the room the icons leave, and NO `min-w-0`, so it
      // refuses to go below what its own labels need. That is the whole fix
      // for a switch reading "Talk to R…": with a transcript in hand and a
      // reply being read — six icon buttons, which `rocBrain` really does
      // produce — the option had 65 pixels for 66 pixels of text, one pixel
      // over and therefore at the mercy of whatever font actually loads. Now
      // the label wins and the footer wraps instead.
      className="flex flex-1 items-center gap-0.5 rounded-md bg-surface-1 p-0.5"
    >
      {ROC_MODES.map((mode) => {
        const active = mode.route === route;
        return (
          <button
            key={mode.route}
            type="button"
            role="radio"
            aria-checked={active}
            // Roving tabindex: the group is one tab stop, the arrows move
            // inside it, and the stop follows the selection.
            tabIndex={active ? 0 : -1}
            data-roc-mode={mode.route}
            title={`${mode.label} — ${lowerFirst(mode.hint)}`}
            onClick={() => onChange(mode.route)}
            className={cn(
              "flex-1 whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors",
              active
                ? "bg-accent-soft text-accent"
                : "text-fg-secondary hover:bg-surface-3 hover:text-fg-primary",
            )}
          >
            {mode.label}
          </button>
        );
      })}
    </div>
  );
}

/** "Types what you say…" → "types what you say…", for a tooltip that reads as
 *  one sentence after the em dash. */
function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function WidgetButton({
  label,
  onClick,
  active = false,
  children,
}: {
  label: string;
  onClick: () => void;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={cn(
        "flex h-6 w-6 items-center justify-center rounded-md transition-colors",
        active
          ? "text-accent hover:bg-surface-3"
          : "text-fg-secondary hover:bg-surface-3 hover:text-fg-primary",
      )}
    >
      {children}
    </button>
  );
}
