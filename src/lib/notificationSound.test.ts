import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** A minimal AudioContext that records what was scheduled and when.
 *
 *  Enough of the shape for the chime to build its graph, and no more — what
 *  these tests are about is WHEN notes get scheduled relative to the context's
 *  state, not what they sound like. */
function makeCtx(initialState: AudioContextState) {
  const started: number[] = [];
  let state = initialState;
  let resolveResume: (() => void) | null = null;

  const param = () => ({
    setValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
  });

  const ctx = {
    get state() {
      return state;
    },
    // A suspended context's clock does not advance. That is the whole bug: a
    // note scheduled at `currentTime` while suspended is scheduled into a
    // moment that never arrives.
    currentTime: 0,
    resume: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveResume = () => {
            state = "running";
            ctx.currentTime = 5;
            resolve();
          };
        }),
    ),
    createGain: () => ({ gain: param(), connect: vi.fn() }),
    createBiquadFilter: () => ({
      type: "",
      frequency: param(),
      Q: param(),
      connect: vi.fn(),
    }),
    createOscillator: () => ({
      type: "",
      frequency: param(),
      connect: vi.fn(),
      start: (at: number) => started.push(at),
      stop: vi.fn(),
    }),
    destination: {},
  };

  return { ctx, started, letResumeSettle: () => resolveResume?.() };
}

let harness: ReturnType<typeof makeCtx>;

/** `new AudioContext()` is a construct call, so the stub has to be a real
 *  function — an arrow cannot be newed. Returning an object from a constructor
 *  is what hands the test its instrumented context. */
function stubAudioContext() {
  vi.stubGlobal("AudioContext", function AudioContextStub(this: unknown) {
    return harness.ctx;
  });
}

beforeEach(() => {
  vi.resetModules();
  harness = makeCtx("suspended");
  stubAudioContext();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("notification chime", () => {
  it("waits for the clock before scheduling a note into it", async () => {
    const { playNotificationDing } = await import("@/lib/notificationSound");

    playNotificationDing();

    // Nothing yet: the context is suspended, so anything placed at its frozen
    // `currentTime` would be scheduled into a past that never arrives — which
    // is exactly how a notification lands in the bell in silence.
    expect(harness.started).toEqual([]);
    expect(harness.ctx.resume).toHaveBeenCalled();

    harness.letResumeSettle();
    // Four, not two: each note is a fundamental plus its octave partial.
    await vi.waitFor(() => expect(harness.started.length).toBe(4));
    // …and they land on the running clock, not the frozen one.
    expect(harness.started.every((t) => t >= 5)).toBe(true);
  });

  it("schedules immediately when the device is already open", async () => {
    harness = makeCtx("running");
    harness.ctx.currentTime = 2;
    stubAudioContext();
    const { playNotificationDing } = await import("@/lib/notificationSound");

    playNotificationDing();

    expect(harness.started.length).toBe(4);
    expect(harness.ctx.resume).not.toHaveBeenCalled();
  });

  it("opens the device from a gesture without making a sound", async () => {
    const { unlockNotificationAudio } = await import("@/lib/notificationSound");

    unlockNotificationAudio();

    expect(harness.ctx.resume).toHaveBeenCalled();
    // Unlocking is not chiming — the user clicked something, they did not
    // finish a turn.
    harness.letResumeSettle();
    expect(harness.started).toEqual([]);
  });

  it("is a state check once the device is open", async () => {
    harness = makeCtx("running");
    stubAudioContext();
    const { unlockNotificationAudio } = await import("@/lib/notificationSound");

    unlockNotificationAudio();
    unlockNotificationAudio();

    expect(harness.ctx.resume).not.toHaveBeenCalled();
  });
});
