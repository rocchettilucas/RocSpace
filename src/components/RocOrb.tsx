/** Roc's orb — a polar waveform around the mark.
 *
 *  A ring of radial spokes whose lengths are the last two seconds of real
 *  microphone amplitude: newest at 12 o'clock, advancing clockwise, so your
 *  voice literally inscribes the ring and the silences between words are
 *  visible as it decays. Roc lives beside sixteen terminals, and the orb should
 *  read as an instrument in that world rather than as a lava lamp.
 *
 *  Its own file because it is on two surfaces at two sizes: the widget's small
 *  one and the stage's, which is the same object made big enough to be the
 *  thing you are talking to. Two copies would drift, and the one that drifted
 *  would be the one nobody was looking at.
 *
 *  ── The four states differ in BEHAVIOUR, not hue ─────────────────────────
 *  Colour is the last thing a glance reads and the first thing a colour-blind
 *  user loses, so each state is a different MOTION:
 *
 *    idle       nothing. No canvas work, no loop, no frame scheduled.
 *    listening  spokes are amplitude history; the core breathes with the live
 *               sample. Silence is a visibly decaying ring.
 *    thinking   input stops mattering: the spokes collapse to a uniform radius
 *               and one travelling wave sweeps the ring every ~1.4s. It must
 *               NOT resemble listening, or the user keeps talking at a deaf orb.
 *    speaking   the orb stops RECORDING and starts EMITTING: one contiguous arc
 *               that grows from twelve o'clock to a full circle over the
 *               utterance. Inside it are the words that have been said, drawn
 *               from the reply's own cadence and pulsing at the syllable rate;
 *               outside it the ring is flat at the floor. So the arc's end is
 *               how far through the sentence Roc is, and how much is left.
 *
 *  Listening and speaking used to be the SAME drawing in two colours: both
 *  inscribed a two-second history ring, and the only difference in the pixels
 *  was a token that is 14.8 ΔE away in the default theme (and both violet).
 *  Nothing about that survived a colour-blind glance, and nothing about it said
 *  anything the phase label did not. The arc is a different motion — it has a
 *  beginning and an end, where listening has neither — and it carries
 *  information no label does: you can see how much of the reply is left.
 *
 *  ── Why canvas 2D, and never WebGL ───────────────────────────────────────
 *  The terminals already spend WebKit's WebGL context budget (Phase 4 found
 *  contexts being force-lost at the 16-pane cap). An orb that took one could
 *  evict a pane's renderer — a decoration costing a user their terminal.
 *
 *  ── Why nothing here re-renders ──────────────────────────────────────────
 *  Amplitude arrives ~30 times a second. Subscribing a component to it would
 *  put React's reconciler behind every one of those samples for the whole
 *  session, on a card that floats over the dock. So the store is subscribed
 *  OUTSIDE render, into a ref, and the frame writes pixels and one composited
 *  transform. A frame never calls setState.
 *
 *  ── Why the loop is conditional ──────────────────────────────────────────
 *  The rule this codebase already enforces: a forever-turning decoration is a
 *  promoted layer repainting behind every open terminal for the whole session.
 *  So `idle` schedules NO frame at all, and neither does `prefers-reduced-
 *  motion` — which gets one representative still per state instead, with the
 *  `aria-live` phase label carrying the meaning. Both are asserted in the
 *  tests, because both are the kind of thing that regresses silently. */

import { useEffect, useRef, useSyncExternalStore } from "react";
import { cn } from "@/lib/utils";
import rocLogo from "@/assets/roc-logo.png";
import { useRocStore } from "@/stores/roc";
import { useRocTalkStore } from "@/stores/roctalk";

/** What the orb is doing. Mapped from RocTalk's microphone status and Roc's
 *  conversation phase by `describeRoc`, which is the one place those two are
 *  reconciled. */
export type RocOrbState = "idle" | "listening" | "thinking" | "speaking";

/** How much history the ring holds. Two seconds is about one spoken clause —
 *  long enough that a pause is a visible gap rather than a flicker, short
 *  enough that the ring is about what you are saying now. */
const WINDOW_MS = 2000;
/** One sweep of the thinking wave. */
const SWEEP_MS = 1400;
/** Syllables per second in the speaking envelope — the middle of ordinary
 *  English speech. */
const SYLLABLE_HZ = 4.8;
/** Per-frame approach of a spoke to its target. The waveform flows around the
 *  ring instead of stepping, and a state change eases rather than snaps. */
const SMOOTHING = 0.45;
/** How many spokes behind the arc's head carry the "being said right now"
 *  emphasis. Two, so the leading edge is legible at 40 pixels without the arc
 *  ending in a spike that reads as a separate mark. */
const EDGE_SPOKES = 2;
/** The shortest a spoke is ever drawn. A ring that vanished entirely in
 *  silence would read as a broken microphone rather than a quiet one. */
const FLOOR = 0.1;

export function RocOrb({
  state = "idle",
  size = 32,
  downloading = false,
  progress = 0,
}: {
  state?: RocOrbState;
  size?: number;
  /** Whisper model download, drawn as a ring outside the waveform. */
  downloading?: boolean;
  progress?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const coreRef = useRef<HTMLDivElement | null>(null);
  /** The live sample, kept off React's path. */
  const amplitudeRef = useRef(0);
  const reduced = useReducedMotion();

  // The amplitude subscription, outside render. Never re-points the component;
  // it re-points one number the next frame happens to read.
  useEffect(() => {
    amplitudeRef.current = useRocTalkStore.getState().amplitude;
    return useRocTalkStore.subscribe((s) => {
      amplitudeRef.current = s.amplitude;
    });
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const core = coreRef.current;
    if (!canvas) return;

    const geometry = orbGeometry(size);
    const ctx = setUpCanvas(canvas, size);
    let palette = readPalette();

    // Idle is the whole point of this branch: no context work, no observer, no
    // frame. Whatever the last state drew is wiped so the orb goes quiet.
    if (state === "idle") {
      ctx?.clearRect(0, 0, size, size);
      if (core) core.style.transform = "";
      return;
    }

    const { spokes } = geometry;
    const display = new Float32Array(spokes);
    const target = new Float32Array(spokes);
    const history = new Float32Array(spokes);
    let head = 0;
    let peak = 0;

    let speech = state === "speaking" ? buildSpeech(replyText()) : null;
    /** When the reply being read now started. Progress is measured from here
     *  rather than from the effect's start so a second reply begins its arc at
     *  twelve o'clock instead of inheriting the first one's. */
    let speechStart = performance.now();
    /** How much of the ring the utterance has reached, in spokes. The whole
     *  ring for every state that has no progress to report. */
    let swept = spokes;
    let animating = false;

    const paint = () => {
      if (!ctx) return;
      drawWaveform(ctx, geometry, display, state, palette, swept);
    };

    // A new reply while the voice is still going — `askRoc` stops the old one
    // and answers again — has to start its own arc. Subscribed outside render
    // for the same reason the amplitude is: this must not re-point the
    // component, only the numbers the next frame reads.
    const unsubscribe =
      state === "speaking"
        ? useRocStore.subscribe((s, prev) => {
            if (s.reply === prev.reply) return;
            speech = buildSpeech(s.reply ?? "");
            speechStart = performance.now();
          })
        : null;

    // A theme change rewrites the `--rs-*` custom properties; the canvas has
    // already baked the old ones into pixels, so it has to be told. Watching
    // the attribute `applyThemeDefinition` sets rather than polling per frame,
    // and repainting only when there is no loop already about to do it.
    const observer =
      typeof MutationObserver === "function"
        ? new MutationObserver(() => {
            palette = readPalette();
            if (!animating) paint();
          })
        : null;
    observer?.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "style"],
    });

    const canAnimate =
      !reduced && typeof requestAnimationFrame === "function" && ctx !== null;

    if (!canAnimate) {
      // One representative still. The phase label says which state this is;
      // the picture only has to be recognisably that state's shape.
      swept = staticFrame(display, state, spokes, speech);
      if (core) core.style.transform = "";
      paint();
      return () => {
        observer?.disconnect();
        unsubscribe?.();
      };
    }

    animating = true;
    const start = performance.now();
    let lastSlot = start;
    const slotMs = WINDOW_MS / spokes;
    let raf = requestAnimationFrame(frame);

    function frame(now: number) {
      raf = requestAnimationFrame(frame);
      const t = (now - start) / 1000;
      let level = 0;

      if (state === "thinking") {
        // Input stops mattering here, deliberately: the one thing this state
        // must never look like is listening.
        fillSweep(target, t);
      } else if (speech !== null) {
        // Not a history ring at all: an arc that has got this far through the
        // sentence. Nothing about it is a recording, which is the whole
        // difference between this state and listening.
        const elapsed = (now - speechStart) / 1000;
        swept = fillUtterance(target, speech, elapsed) * spokes;
        level = envelopeAt(speech, elapsed) * SPEECH_GAIN;
      } else {
        level = amplitudeRef.current;
        if (level > peak) peak = level;
        // Peak-held per slot, so the ring is an envelope of what was said
        // rather than a sample of whichever instant the frame landed on.
        while (now - lastSlot >= slotMs) {
          lastSlot += slotMs;
          // A stalled tab must not spend a thousand iterations catching up on
          // history nobody saw.
          if (now - lastSlot > WINDOW_MS) lastSlot = now;
          head = (head + 1) % spokes;
          history[head] = peak;
          peak = level;
        }
        for (let i = 0; i < spokes; i++) {
          target[i] = history[(head - i + spokes) % spokes]!;
        }
      }

      for (let i = 0; i < spokes; i++) {
        display[i]! += (target[i]! - display[i]!) * SMOOTHING;
      }
      paint();

      if (core) core.style.transform = `scale(${breath(state, t, level)})`;
    }

    return () => {
      cancelAnimationFrame(raf);
      observer?.disconnect();
      unsubscribe?.();
      if (core) core.style.transform = "";
    };
  }, [reduced, size, state]);

  const coreInset = Math.max(2, Math.round(size * CORE_INSET_RATIO));
  return (
    <div
      className="relative shrink-0"
      style={{ width: size, height: size }}
      data-roc-orb
      data-roc-orb-state={state}
    >
      {/* Decorative: everything this says in pictures, the phase label beside
          it says in words — and one of the two surfaces that draw that label
          announces it, never both (see `announce` in `RocStage`). */}
      <canvas
        ref={canvasRef}
        aria-hidden
        className="absolute inset-0"
        style={{ width: size, height: size }}
      />
      {downloading ? <DownloadRing size={size} progress={progress} /> : null}
      <div
        ref={coreRef}
        className={cn(
          "absolute grid place-items-center rounded-full transition-colors",
          state === "idle" ? "bg-surface-3" : "bg-accent-soft",
        )}
        style={{ inset: coreInset }}
      >
        <img
          src={rocLogo}
          alt=""
          draggable={false}
          className="object-contain"
          style={{ width: size * LOGO_RATIO, height: size * LOGO_RATIO }}
        />
      </div>
    </div>
  );
}

// ── geometry ──────────────────────────────────────────────────────────────

/** The mark's disc, as a fraction of the box. Smaller than the disc this orb
 *  replaced, because the ring needs the radius: a waveform with nowhere to
 *  swing is a texture. */
const CORE_INSET_RATIO = 0.24;
const LOGO_RATIO = 0.32;

interface OrbGeometry {
  size: number;
  spokes: number;
  innerR: number;
  span: number;
  lineWidth: number;
}

/** Spoke count scales with the box so the SPACING between spokes stays about
 *  four pixels at every size. That is what keeps the small one legible rather
 *  than mush: a fixed count would either be sparse on the stage or solid in the
 *  widget. */
export function orbGeometry(size: number): OrbGeometry {
  const spokes = Math.max(16, Math.min(96, Math.round(size * 0.5)));
  const lineWidth = Math.max(1, Math.min(2.6, size * 0.045));
  const innerR = size * 0.3;
  const outerR = size * 0.5 - lineWidth * 0.5 - 0.5;
  return {
    size,
    spokes,
    innerR,
    span: Math.max(1, outerR - innerR),
    lineWidth,
  };
}

// ── palette ───────────────────────────────────────────────────────────────

interface OrbPalette {
  listening: string;
  thinking: string;
  speaking: string;
}

/** Only reachable with no theme applied at all — `applyTheme` writes the
 *  custom properties at boot and on every change. It exists so a canvas that
 *  somehow finds none is faint rather than invisible. */
const NO_THEME_INK = "rgb(128, 128, 128)";

/** The tokens, read from computed style rather than hardcoded, so all ten
 *  themes — including the two light ones — get their own orb. */
function readPalette(): OrbPalette {
  const root = document.documentElement;
  const computed = getComputedStyle(root);
  const read = (name: string): string =>
    computed.getPropertyValue(name).trim() ||
    root.style.getPropertyValue(name).trim() ||
    NO_THEME_INK;
  return {
    listening: read("--rs-primary"),
    thinking: read("--rs-info"),
    speaking: read("--rs-purple"),
  };
}

// ── drawing ───────────────────────────────────────────────────────────────

function setUpCanvas(
  canvas: HTMLCanvasElement,
  size: number,
): CanvasRenderingContext2D | null {
  const dpr =
    typeof devicePixelRatio === "number" && devicePixelRatio > 0
      ? devicePixelRatio
      : 1;
  canvas.width = Math.round(size * dpr);
  canvas.height = Math.round(size * dpr);
  const ctx = canvas.getContext("2d");
  // jsdom has no 2D context, and neither does a webview that has run out of
  // them. Everything below tolerates null rather than throwing inside a frame.
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

function drawWaveform(
  ctx: CanvasRenderingContext2D,
  { size, spokes, innerR, span, lineWidth }: OrbGeometry,
  values: Float32Array,
  state: RocOrbState,
  palette: OrbPalette,
  /** How far round the ring the utterance has got, in spokes. `spokes` — all of
   *  it — for every state that is not an utterance with an end. */
  swept: number = spokes,
): void {
  ctx.clearRect(0, 0, size, size);
  const centre = size / 2;
  const step = (Math.PI * 2) / spokes;
  ctx.lineCap = "round";
  ctx.lineWidth = lineWidth;
  ctx.strokeStyle =
    state === "thinking"
      ? palette.thinking
      : state === "speaking"
        ? palette.speaking
        : palette.listening;

  for (let i = 0; i < spokes; i++) {
    const value = Math.max(0, Math.min(1, values[i] ?? 0));
    // −90° is 12 o'clock, and canvas angles grow clockwise on screen: index 0
    // is the newest sample and each older one sits one step further round.
    const angle = -Math.PI / 2 + i * step;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const outer = innerR + span * (FLOOR + (1 - FLOOR) * value);
    // Age is the fade in the state that HAS an age — listening, where index 0
    // is the newest sample. The sweep has no age, so its crest carries the
    // brightness; the utterance has none either, so its ARC does: what has
    // been said is lit, what is still to come is a faint rule.
    ctx.globalAlpha =
      state === "thinking"
        ? 0.28 + 0.62 * value
        : state === "speaking"
          ? i < swept
            ? 0.35 + 0.65 * value
            : 0.12
          : 0.2 + 0.8 * (1 - i / spokes);
    ctx.beginPath();
    ctx.moveTo(centre + innerR * cos, centre + innerR * sin);
    ctx.lineTo(centre + outer * cos, centre + outer * sin);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

// ── the generators ────────────────────────────────────────────────────────

/** A single travelling crest on an otherwise uniform ring, one turn per
 *  `SWEEP_MS`. Uniform is the message: it is not listening to you. */
function fillSweep(target: Float32Array, t: number): void {
  const spokes = target.length;
  const headAt = ((t * 1000) / SWEEP_MS) % 1;
  const width = Math.max(1.5, spokes * 0.08);
  for (let i = 0; i < spokes; i++) {
    // Shortest way round, so the crest does not tear at the seam.
    let d = i - headAt * spokes;
    d -= Math.round(d / spokes) * spokes;
    target[i] = 0.28 + 0.55 * Math.exp(-((d / width) ** 2));
  }
}

interface SpeechSegment {
  start: number;
  end: number;
  /** 0 marks a gap between words. */
  gain: number;
}

export interface SpeechPlan {
  segments: SpeechSegment[];
  total: number;
}

/** Speaking is quieter than a microphone held to your mouth. */
const SPEECH_GAIN = 0.85;

/** What Roc is saying, laid out in time.
 *
 *  Scaled to the reply because that is the honest part: `say` gives nothing
 *  back, so the orb cannot know the real envelope — but it does know how many
 *  words there are and where the sentences end, and a cadence built from those
 *  reads as speech where random jitter reads as a fake meter. Deterministic:
 *  the same reply animates the same way twice. */
export function buildSpeech(text: string): SpeechPlan {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const segments: SpeechSegment[] = [];
  let at = 0;
  for (const word of words) {
    const duration = Math.max(0.14, Math.min(0.9, word.length * 0.075));
    segments.push({
      start: at,
      end: at + duration,
      gain: 0.6 + 0.4 * hash01(word),
    });
    at += duration;
    const gap = /[.!?]$/.test(word) ? 0.3 : /[,;:]$/.test(word) ? 0.18 : 0.07;
    segments.push({ start: at, end: at + gap, gain: 0 });
    at += gap;
  }
  return { segments, total: at };
}

function envelopeAt({ segments, total }: SpeechPlan, t: number): number {
  if (total <= 0) return 0;
  // Looped, because `say` decides when it is finished and our estimate is an
  // estimate. The state leaving "speaking" is what actually stops this.
  const at = t % total;
  for (const segment of segments) {
    if (at >= segment.end) continue;
    // A gap is quiet, not off — the ring dips between words rather than dying.
    if (segment.gain === 0) return 0.04;
    const local = at - segment.start;
    const taper = Math.min(1, local / 0.04, (segment.end - at) / 0.04);
    const syllable = 0.55 + 0.45 * Math.sin(2 * Math.PI * SYLLABLE_HZ * at);
    return Math.max(0, segment.gain * syllable * Math.max(0, taper));
  }
  return 0;
}

/** The utterance so far, as an arc.
 *
 *  The reply's own cadence laid around the ring from twelve o'clock, revealed
 *  as it is spoken: spoke `i` holds the moment `(i / spokes) * total` of the
 *  sentence, and only the spokes the voice has reached are drawn at all. So the
 *  arc's END is the thing to look at — it says how far through Roc is, and how
 *  much is left, which is information no label on screen carries.
 *
 *  The body of the arc pulses together at the syllable rate rather than each
 *  spoke shimmering on its own: it is one voice, and a ring of independently
 *  wobbling spokes is the "fake meter" look this state exists to avoid.
 *
 *  Answers the progress, 0..1, so the caller can draw the arc's edge. */
export function fillUtterance(
  target: Float32Array,
  speech: SpeechPlan,
  /** Seconds since this reply started being read. */
  elapsed: number,
): number {
  const spokes = target.length;
  const { total } = speech;
  // One number for the whole body — the syllable the voice is on now.
  const cadence = 0.62 + 0.38 * Math.sin(2 * Math.PI * SYLLABLE_HZ * elapsed);
  if (total <= 0) {
    // Speaking with nothing to measure — the phase without the text, which the
    // store can reach by clearing the reply mid-sentence. No progress to
    // report, so the whole ring pulses rather than pretending to a position.
    for (let i = 0; i < spokes; i++) target[i] = 0.3 + 0.25 * cadence;
    return 1;
  }
  const progress = Math.min(1, Math.max(0, elapsed / total));
  const head = progress * spokes;
  for (let i = 0; i < spokes; i++) {
    if (i >= head) {
      // Not said yet. Flat at the floor — the ring it will be drawn into.
      target[i] = 0;
      continue;
    }
    const said = envelopeAt(speech, (i / spokes) * total) * SPEECH_GAIN;
    // The word being said right now, at the arc's leading edge.
    const edge = Math.max(0, 1 - (head - i) / EDGE_SPOKES);
    target[i] = Math.min(1, said * cadence + 0.25 * edge);
  }
  return progress;
}

/** How much the core swells. Listening tracks the live sample over a slow
 *  baseline breath, so a microphone that is hearing silence still looks alive —
 *  which is the difference between "nobody is talking" and "this is broken". */
function breath(state: RocOrbState, t: number, level: number): string {
  const scale =
    state === "listening"
      ? 1 + 0.02 * Math.sin(t * 2.85) + 0.1 * level
      : state === "speaking"
        ? 1 + 0.07 * level
        : 1 + 0.02 * Math.sin((t * Math.PI * 2000) / SWEEP_MS);
  return scale.toFixed(3);
}

/** The still frame for reduced motion: recognisably this state's shape, drawn
 *  once and then left alone. Answers how much of the ring the drawing occupies,
 *  which is the whole ring for everything except a half-spoken sentence. */
function staticFrame(
  values: Float32Array,
  state: RocOrbState,
  spokes: number,
  speech: SpeechPlan | null,
): number {
  if (state === "thinking") {
    fillSweep(values, 0);
    return spokes;
  }
  if (state === "speaking" && speech) {
    // Half-way through the reply: an arc with an END, which is the one thing
    // this state has to say and the one thing that tells it apart from the
    // listening still at a glance — with no motion available to say it.
    return fillUtterance(values, speech, speech.total / 2) * spokes;
  }
  // A frozen waveform. Two incommensurable terms so it does not read as a
  // repeating pattern the eye can count.
  for (let i = 0; i < spokes; i++) {
    values[i] =
      0.2 +
      0.5 * (0.5 + 0.5 * Math.sin(i * 0.9)) * (0.5 + 0.5 * Math.cos(i * 0.37));
  }
  return spokes;
}

// ── odds and ends ─────────────────────────────────────────────────────────

function replyText(): string {
  return useRocStore.getState().reply ?? "";
}

/** A stable 0..1 from a word, so a reply's emphasis is a property of the reply
 *  and not of when it was said. */
function hash01(word: string): number {
  let hash = 2166136261;
  for (let i = 0; i < word.length; i++) {
    hash ^= word.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 1000) / 1000;
}

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

function reducedMotionQuery(): MediaQueryList | null {
  if (typeof window === "undefined") return null;
  if (typeof window.matchMedia !== "function") return null;
  return window.matchMedia(REDUCED_MOTION);
}

/** Module level so their identity is stable: an inline `subscribe` would make
 *  React tear the listener down and put it back on every render. */
const subscribeReducedMotion = (onChange: () => void): (() => void) => {
  const query = reducedMotionQuery();
  query?.addEventListener("change", onChange);
  return () => query?.removeEventListener("change", onChange);
};
const getReducedMotion = (): boolean => reducedMotionQuery()?.matches ?? false;
const noReducedMotion = (): boolean => false;

/** Re-read when the OS setting changes, rather than only at boot: a user who
 *  turns it on mid-session is asking for the moving thing in the corner of
 *  their eye to stop NOW. One re-render per change, and none otherwise. */
function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReducedMotion,
    getReducedMotion,
    noReducedMotion,
  );
}

function DownloadRing({ size, progress }: { size: number; progress: number }) {
  const stroke = 2;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - Math.max(0, Math.min(1, progress)));
  return (
    <svg
      width={size}
      height={size}
      aria-hidden
      className="absolute inset-0 -rotate-90"
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="var(--rs-border-hover)"
        strokeWidth={stroke}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="var(--color-accent)"
        strokeWidth={stroke}
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        strokeLinecap="round"
      />
    </svg>
  );
}
