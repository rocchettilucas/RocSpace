/** Procedurally-generated notification chime using the Web Audio API.
 *  No audio file shipped — keeps the bundle binary-free and lets the sound be
 *  tuned by editing constants rather than by re-exporting a wav.
 *
 *  What it plays: two soft bell notes, E5 then C5, a descending major third,
 *  ringing out over about a second and a half.
 *
 *  Every choice here is about a sound the user will hear MANY times a day —
 *  since the chime now fires for every finished turn, an unpleasant one is not
 *  a small problem:
 *
 *  • DESCENDING, not rising. A pitch that climbs reads as a question or an
 *    alarm; one that falls reads as resolution. This sound means "that's done",
 *    which is the same thing a doorbell's ding-dong says.
 *  • LOWER. The old sweep ended at 1760 Hz, sitting in the band the ear is most
 *    sensitive to, which is why it read as loud and sharp at a modest gain.
 *    Both notes here are under 700 Hz.
 *  • SOFT ATTACK. 5 ms is close enough to instantaneous to produce a click
 *    transient; 18 ms lets the note begin instead of arriving.
 *  • FILTERED. A bare sine has nothing taking the edge off. A gentle low-pass
 *    plus a quiet octave partial gives it a struck-bell body rather than a
 *    test tone's purity. */

let cachedContext: AudioContext | null = null;

function getContext(): AudioContext | null {
  if (cachedContext) return cachedContext;
  // Safari / older webkit guards.
  const Ctx: typeof AudioContext | undefined =
    typeof window !== "undefined"
      ? (window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext)
      : undefined;
  if (!Ctx) return null;
  try {
    cachedContext = new Ctx();
  } catch {
    cachedContext = null;
  }
  return cachedContext;
}

/** The two notes, in Hz: E5 down to C5. */
const NOTES = [659.25, 523.25] as const;
/** How long after the first note the second one starts. Far enough apart to
 *  read as two notes rather than a chord, close enough to be one gesture. */
const NOTE_GAP_S = 0.11;
/** Peak gain per note. Roughly half the old chime's, and the low-pass below
 *  takes more off the top of the perceived loudness than the number suggests. */
const PEAK_GAIN = 0.055;
/** The octave partial that makes it a bell instead of a sine, kept quiet
 *  enough to be felt rather than heard as a separate pitch. */
const PARTIAL_GAIN_RATIO = 0.14;
const ATTACK_S = 0.018;
/** How long each note takes to fade to silence. The only thing changed from
 *  the chime this replaced — same notes, same partial, same gain, same filter.
 *  Both notes share it: the second starts 110 ms later and so ends 110 ms
 *  later, which is the tail you hear, and lengthening only the second one
 *  changes the sound's character rather than its length. */
const RELEASE_S = 1.6;

function strike(ctx: AudioContext, freq: number, at: number): void {
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(PEAK_GAIN, at + ATTACK_S);
  // Exponential, because loudness is perceived logarithmically — a linear fade
  // sounds like it stops rather than rings out.
  gain.gain.exponentialRampToValueAtTime(0.0001, at + RELEASE_S);

  // Rolls off what little edge two sines have. Set above the octave partial so
  // it shapes the tone rather than muffling it.
  const tone = ctx.createBiquadFilter();
  tone.type = "lowpass";
  tone.frequency.setValueAtTime(2100, at);
  tone.Q.setValueAtTime(0.7, at);

  const fundamental = ctx.createOscillator();
  fundamental.type = "sine";
  fundamental.frequency.setValueAtTime(freq, at);

  const partial = ctx.createOscillator();
  partial.type = "sine";
  partial.frequency.setValueAtTime(freq * 2, at);
  const partialGain = ctx.createGain();
  partialGain.gain.setValueAtTime(PARTIAL_GAIN_RATIO, at);

  fundamental.connect(gain);
  partial.connect(partialGain);
  partialGain.connect(gain);
  gain.connect(tone);
  tone.connect(ctx.destination);

  const end = at + RELEASE_S + 0.02;
  fundamental.start(at);
  partial.start(at);
  fundamental.stop(end);
  partial.stop(end);
}

function schedule(ctx: AudioContext): void {
  try {
    const now = ctx.currentTime;
    NOTES.forEach((freq, i) => strike(ctx, freq, now + i * NOTE_GAP_S));
  } catch {
    /* if the AudioContext has been closed by the platform, skip silently */
  }
}

/** Open the audio device while the user is touching the app.
 *
 *  A webview will not let a page make noise until the user has interacted with
 *  it, and an `AudioContext` created outside a real input event is born
 *  `suspended`. Notifications are the worst possible place to discover this:
 *  they fire from a store subscription — a status arriving over IPC — which is
 *  not a gesture by any browser's reckoning, so the context that gets created
 *  at that moment is a deaf one, and `resume()` on it is a promise nobody is
 *  waiting for while the notes are scheduled against a clock that is not
 *  running. The bell fills up and the room stays silent.
 *
 *  So the context is opened from a click or a keystroke instead, where the
 *  permission exists, and is warm by the time an agent finishes. Idempotent and
 *  cheap: after the first successful resume this is a state check. */
export function unlockNotificationAudio(): void {
  const ctx = getContext();
  if (!ctx || ctx.state !== "suspended") return;
  void ctx.resume().catch(() => {
    /* still locked; the next gesture tries again */
  });
}

/** Trigger one chime. Best-effort: silently no-ops in environments without
 *  Web Audio (jsdom tests, headless contexts). */
export function playNotificationDing(): void {
  const ctx = getContext();
  if (!ctx) return;
  if (ctx.state === "suspended") {
    // Schedule only once the clock is actually running: `currentTime` does not
    // advance while suspended, so notes placed at `now` land in a past that
    // never arrives.
    void ctx
      .resume()
      .then(() => schedule(ctx))
      .catch(() => {
        /* the platform is still refusing; the chime is silent this time */
      });
    return;
  }
  schedule(ctx);
}
