/** The orb's contract, which is mostly about what it does NOT do.
 *
 *  Three of these are load-bearing rather than cosmetic, and all three are the
 *  kind of thing that regresses without anybody noticing on their own machine:
 *  a loop that runs while idle repaints behind sixteen terminals for the whole
 *  session; a loop that outlives its component leaks a frame callback per
 *  mount; and a loop that ignores `prefers-reduced-motion` is the OS setting
 *  being asked and answered wrongly. */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";

import { buildSpeech, orbGeometry, RocOrb } from "@/components/RocOrb";
import { useRocStore } from "@/stores/roc";
import { useRocTalkStore } from "@/stores/roctalk";

/** jsdom has no 2D context. A recording stand-in lets the drawing assertions
 *  ask what the orb painted rather than only whether it scheduled a frame. */
interface FakeContext {
  strokeStyle: string;
  lineWidth: number;
  lineCap: string;
  globalAlpha: number;
  strokes: { style: string; length: number }[];
  clears: number;
}

let context: FakeContext;
let raf: {
  schedule: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
};
let frames: Map<number, FrameRequestCallback>;
let nextFrameId: number;

function makeContext(): FakeContext {
  const ctx: Partial<FakeContext> & Record<string, unknown> = {
    strokeStyle: "",
    lineWidth: 0,
    lineCap: "",
    globalAlpha: 1,
    strokes: [],
    clears: 0,
  };
  let from = { x: 0, y: 0 };
  let to = { x: 0, y: 0 };
  ctx.setTransform = () => {};
  ctx.clearRect = () => {
    (ctx.clears as number) += 1;
  };
  ctx.beginPath = () => {};
  ctx.moveTo = (x: number, y: number) => {
    from = { x, y };
  };
  ctx.lineTo = (x: number, y: number) => {
    to = { x, y };
  };
  ctx.stroke = () => {
    (ctx.strokes as FakeContext["strokes"]).push({
      style: ctx.strokeStyle as string,
      length: Math.hypot(to.x - from.x, to.y - from.y),
    });
  };
  return ctx as unknown as FakeContext;
}

/** The frame clock. The orb times itself off `performance.now()`, so the test
 *  drives that rather than the wall clock — a loop asked to draw two seconds of
 *  history has to be given two seconds. */
let clock = 0;

/** Run n animation frames, advancing the clock between them. */
function advance(count: number, stepMs = 16) {
  for (let i = 0; i < count; i++) {
    const pending = [...frames.values()];
    frames.clear();
    clock += stepMs;
    act(() => {
      for (const callback of pending) callback(clock);
    });
  }
}

beforeEach(() => {
  clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  context = makeContext();
  frames = new Map();
  nextFrameId = 1;
  raf = {
    schedule: vi.fn((callback: FrameRequestCallback) => {
      const id = nextFrameId++;
      frames.set(id, callback);
      return id;
    }),
    cancel: vi.fn((id: number) => frames.delete(id)),
  };
  vi.stubGlobal("requestAnimationFrame", raf.schedule);
  vi.stubGlobal("cancelAnimationFrame", raf.cancel);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    context as unknown as CanvasRenderingContext2D,
  );
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    })),
  );
  // The tokens the orb reads. `applyTheme` writes these at boot in the app.
  const root = document.documentElement;
  root.style.setProperty("--rs-primary", "rgb(139, 108, 234)");
  root.style.setProperty("--rs-info", "rgb(110, 168, 254)");
  root.style.setProperty("--rs-purple", "rgb(192, 132, 252)");
  root.removeAttribute("data-theme");
  useRocTalkStore.setState({ amplitude: 0 });
  useRocStore.setState({ reply: null });
});

describe("the loop's lifecycle", () => {
  // Not decoration: a forever-turning orb is a layer repainting behind every
  // open terminal for as long as the app is open.
  it("schedules nothing at all while idle", () => {
    render(<RocOrb state="idle" size={40} />);
    expect(raf.schedule).not.toHaveBeenCalled();
  });

  it("runs while listening, and stops the moment it goes idle", () => {
    const { rerender } = render(<RocOrb state="listening" size={40} />);
    expect(raf.schedule).toHaveBeenCalled();

    advance(3);
    expect(context.strokes.length).toBeGreaterThan(0);

    raf.schedule.mockClear();
    rerender(<RocOrb state="idle" size={40} />);
    expect(raf.cancel).toHaveBeenCalled();

    advance(3);
    expect(raf.schedule).not.toHaveBeenCalled();
  });

  it("tears the loop down on unmount", () => {
    const { unmount } = render(<RocOrb state="thinking" size={40} />);
    advance(2);

    raf.schedule.mockClear();
    unmount();

    expect(raf.cancel).toHaveBeenCalled();
    advance(3);
    expect(raf.schedule).not.toHaveBeenCalled();
  });

  // The OS setting is asking for the moving thing to stop, and `animation:
  // none` cannot reach a canvas — so the orb has to answer it itself.
  it("draws one still and schedules nothing under reduced motion", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: true,
        addEventListener: () => {},
        removeEventListener: () => {},
      })),
    );

    render(<RocOrb state="listening" size={40} />);

    expect(raf.schedule).not.toHaveBeenCalled();
    // …but there IS a picture. A blank orb would be a third state the phase
    // label does not name.
    expect(context.strokes.length).toBeGreaterThan(0);
  });
});

describe("what it draws", () => {
  it("re-reads the theme's tokens when the theme changes", async () => {
    render(<RocOrb state="listening" size={40} />);
    advance(2);
    expect(context.strokes.at(-1)?.style).toBe("rgb(139, 108, 234)");

    await act(async () => {
      document.documentElement.style.setProperty(
        "--rs-primary",
        "rgb(1, 2, 3)",
      );
      document.documentElement.setAttribute("data-theme", "light");
      // MutationObserver callbacks are microtasks.
      await Promise.resolve();
    });
    advance(2);

    expect(context.strokes.at(-1)?.style).toBe("rgb(1, 2, 3)");
  });

  // Behaviour, not hue, is the primary signal — but the hue should still be
  // the state's own token rather than one borrowed from another state.
  it("uses a different token per state", () => {
    const { rerender } = render(<RocOrb state="thinking" size={40} />);
    advance(2);
    expect(context.strokes.at(-1)?.style).toBe("rgb(110, 168, 254)");

    rerender(<RocOrb state="speaking" size={40} />);
    advance(2);
    expect(context.strokes.at(-1)?.style).toBe("rgb(192, 132, 252)");
  });

  // What the whole direction is for: your voice is the ring's shape. A loud
  // moment has to make a longer spoke than a silent one.
  it("draws your voice — a loud sample is a longer spoke than silence", () => {
    render(<RocOrb state="listening" size={160} />);
    // Two seconds of silence at 16ms a frame, so the ring is full of it.
    advance(130);
    const silent = Math.max(...context.strokes.slice(-80).map((s) => s.length));

    act(() => useRocTalkStore.getState().setAmplitude(1));
    advance(30);
    const loud = Math.max(...context.strokes.slice(-80).map((s) => s.length));

    expect(loud).toBeGreaterThan(silent * 1.5);
  });

  // …and the other half of the same promise: it decays back through a silence
  // rather than holding the last loud frame.
  it("decays back through a silence", () => {
    render(<RocOrb state="listening" size={160} />);
    act(() => useRocTalkStore.getState().setAmplitude(1));
    advance(60);
    const loud = Math.max(...context.strokes.slice(-80).map((s) => s.length));

    act(() => useRocTalkStore.getState().setAmplitude(0));
    advance(200);
    const quiet = Math.max(...context.strokes.slice(-80).map((s) => s.length));

    expect(quiet).toBeLessThan(loud * 0.5);
  });
});

/** The headline requirement of the phase: the four states differ in BEHAVIOUR,
 *  not in hue. Listening and speaking are the pair that failed it — the same
 *  history ring drawn twice, told apart only by a token that is 14.8 ΔE away in
 *  the default theme and violet in both. So these assertions are about the
 *  stroke GEOMETRY: a test that only compared `strokeStyle` is the test that
 *  let this through. */
describe("speaking is a different drawing from listening", () => {
  /** Long enough that the arc is visibly partway through at the moment both
   *  rings are compared, rather than already closed. */
  const REPLY =
    "Rocky is running the failing auth test now and Roxie is updating the login form after that.";
  const { spokes, span } = orbGeometry(160);
  /** The whole of the last frame — one stroke per spoke, in ring order. */
  const ring = () => context.strokes.slice(-spokes).map((s) => s.length);
  /** A spoke nothing has been drawn into: the ring the arc is drawn ON. */
  const atFloor = (length: number) => length < span * 0.15;
  const floors = (lengths: number[]) => lengths.filter(atFloor).length;
  /** How far round the ring the drawing reaches — the arc's head. */
  const reach = (lengths: number[]) => {
    for (let i = lengths.length - 1; i >= 0; i--) {
      if (!atFloor(lengths[i]!)) return i;
    }
    return -1;
  };

  // The test the reviewer wished had existed: the SAME amplitude history drives
  // both, and the pixels still have to differ. Listening inscribes what it
  // hears all the way round; speaking ignores the microphone entirely and draws
  // how far through the sentence it is.
  it("draws a different ring from the same amplitude history", () => {
    useRocStore.setState({ reply: REPLY });
    const { rerender } = render(<RocOrb state="listening" size={160} />);
    act(() => useRocTalkStore.getState().setAmplitude(0.8));
    // More than the two-second window, so the ring is full of that one loud
    // sample from end to end.
    advance(150);
    const listening = ring();

    // Same amplitude, same clock, same component — only the state changes.
    rerender(<RocOrb state="speaking" size={160} />);
    advance(150);
    const speaking = ring();

    expect(speaking).not.toEqual(listening);
    // Listening filled the ring; speaking has an END, and everything past it is
    // the bare floor waiting to be drawn into.
    expect(floors(listening)).toBe(0);
    expect(floors(speaking)).toBeGreaterThan(spokes / 3);
    expect(reach(speaking)).toBeLessThan(spokes - 5);
    // …and past the head there is nothing at all, not a quieter version of the
    // same waveform: this is one contiguous arc.
    const past = speaking.slice(reach(speaking) + 3);
    expect(past.length).toBeGreaterThan(10);
    expect(Math.max(...past)).toBeLessThan(span * 0.12);
  });

  // The arc is the information: it says how much is LEFT. So it has to grow,
  // and it has to grow against the reply — a ring that filled at its own rate
  // would be a progress bar that means nothing.
  it("sweeps from twelve o'clock to a full circle as the reply is read", () => {
    useRocStore.setState({ reply: REPLY });
    render(<RocOrb state="speaking" size={160} />);

    advance(20);
    const early = reach(ring());
    advance(100);
    const later = reach(ring());

    expect(early).toBeGreaterThanOrEqual(0);
    expect(later).toBeGreaterThan(early + 5);
    expect(later).toBeLessThan(spokes - 1);
  });

  it("is further round for a short reply than a long one, at the same moment", () => {
    useRocStore.setState({ reply: "Told Rocky." });
    const short = render(<RocOrb state="speaking" size={160} />);
    advance(40);
    const shortReach = reach(ring());
    short.unmount();

    context.strokes.length = 0;
    useRocStore.setState({ reply: REPLY });
    render(<RocOrb state="speaking" size={160} />);
    advance(40);

    expect(shortReach).toBeGreaterThan(reach(ring()) * 2);
  });

  // A second reply is a second sentence, not a continuation of the first: the
  // arc has to start again rather than carry on round from wherever it was.
  it("starts the arc again for a new reply", () => {
    useRocStore.setState({ reply: "Done." });
    render(<RocOrb state="speaking" size={160} />);
    // Past the end of that estimate: the ring is closed.
    advance(80);
    const finished = reach(ring());
    expect(finished).toBeGreaterThan(spokes - 3);

    act(() => useRocStore.setState({ reply: REPLY }));
    advance(15);

    expect(reach(ring())).toBeLessThan(finished / 2);
  });

  // What `stopRocSpeaking` looks like from here: the phase leaves "speaking",
  // and the arc goes with it in the same frame rather than finishing its sweep.
  it("drops the arc the moment the reply is stopped", () => {
    useRocStore.setState({ reply: REPLY });
    const { rerender } = render(<RocOrb state="speaking" size={160} />);
    advance(40);
    expect(context.strokes.length).toBeGreaterThan(0);

    const clears = context.clears;
    rerender(<RocOrb state="idle" size={160} />);

    expect(raf.cancel).toHaveBeenCalled();
    expect(context.clears).toBeGreaterThan(clears);
    context.strokes.length = 0;
    advance(5);
    expect(context.strokes).toHaveLength(0);
  });

  // Reduced motion gets one still per state, and the stills are all a
  // colour-blind user has: they cannot differ by token either.
  it("differs from listening in the reduced-motion still too", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: true,
        addEventListener: () => {},
        removeEventListener: () => {},
      })),
    );
    useRocStore.setState({ reply: REPLY });

    const listening = render(<RocOrb state="listening" size={160} />);
    const listeningRing = ring();
    listening.unmount();
    context.strokes.length = 0;
    render(<RocOrb state="speaking" size={160} />);
    const speakingRing = ring();

    expect(speakingRing).not.toEqual(listeningRing);
    // Half a sentence: an arc with an end, against a frozen full waveform.
    expect(floors(listeningRing)).toBe(0);
    expect(floors(speakingRing)).toBeGreaterThan(spokes / 3);
    expect(reach(speakingRing)).toBeLessThan(spokes - 5);
  });
});

describe("the geometry", () => {
  // The small one has to stay legible rather than becoming mush, and the big
  // one has to stay a waveform rather than becoming a sunburst — which is one
  // rule, not two: keep the SPACING between spokes roughly constant.
  it("keeps spoke spacing about the same at both sizes", () => {
    const spacing = (size: number) => {
      const { spokes, innerR, lineWidth } = orbGeometry(size);
      return (2 * Math.PI * innerR) / spokes - lineWidth;
    };
    expect(spacing(40)).toBeGreaterThan(1);
    expect(spacing(160)).toBeGreaterThan(1);
    expect(Math.abs(spacing(160) - spacing(40))).toBeLessThan(1.5);
  });
});

describe("the speaking envelope", () => {
  // `say` reports no amplitude back, so the cadence is built from the reply.
  // Deterministic, because the same sentence should look the same twice.
  it("is a function of the reply, and repeats", () => {
    const once = buildSpeech("Rocky is running the tests.");
    const twice = buildSpeech("Rocky is running the tests.");
    expect(once).toEqual(twice);
    expect(buildSpeech("Yes.").total).toBeLessThan(once.total);
  });

  it("has a gap after every word, and a longer one after a sentence", () => {
    const { segments } = buildSpeech("Told Rocky. Roxie is next");
    const gaps = segments.filter((s) => s.gain === 0);
    expect(gaps).toHaveLength(5);
    // The gap after "Rocky." is the one that ends a sentence.
    expect(gaps[1]!.end - gaps[1]!.start).toBeGreaterThan(
      gaps[0]!.end - gaps[0]!.start,
    );
  });
});
