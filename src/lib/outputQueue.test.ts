/** The write path between the PTY event stream and xterm.
 *
 *  Everything here is about what a *frame* does, so the tests drive rAF by
 *  hand: nothing may reach an xterm (or the store) until a frame runs, and one
 *  frame must be one store write no matter how many panes are streaming.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import type { TerminalOutputLine } from "@/lib/bindings";
import { newTerminal } from "@/lib/factories";
import {
  FALLBACK_FLUSH_MS,
  FOCUSED_FRAME_SHARE,
  FRAME_BYTE_BUDGET,
  QUEUE_BYTE_CAP,
  enqueueOutput,
  flushOutputQueues,
  resetOutputQueues,
} from "@/lib/outputQueue";
import {
  clearTerminalRegistry,
  registerTerminal,
  unregisterTerminal,
} from "@/lib/terminalRegistry";
import { useTerminalsStore } from "@/stores/terminals";
import { useUIStore } from "@/stores/ui";

// rAF, driven by hand ------------------------------------------------------

let frames: FrameRequestCallback[] = [];

/** Run every frame requested so far (but not the ones they request). */
function runFrame(): void {
  const due = frames;
  frames = [];
  for (const cb of due) cb(0);
}

/** Run frames until nothing more is scheduled — the streaming steady state. */
function drainFrames(limit = 50): number {
  let ran = 0;
  while (frames.length > 0 && ran < limit) {
    runFrame();
    ran++;
  }
  return ran;
}

// Fakes --------------------------------------------------------------------

/** The registry hands back a real `Terminal`; all this path uses is `write`
 *  and `clear`. `ops` records both, in the order they were called, for the
 *  tests where the interleaving is the point. */
function fakeTerminal(written: string[], ops: string[]): Terminal {
  return {
    write: (data: string) => {
      written.push(data);
      ops.push(`write:${data}`);
    },
    clear: () => ops.push("clear"),
  } as unknown as Terminal;
}

let seq = 0;
function line(text: string): TerminalOutputLine {
  return { id: `l${seq++}`, ts: 1000 + seq, stream: "stdout", text };
}

/** A session in the store, so its ring buffer is a real destination. */
function seedSession(name: string): string {
  const session = newTerminal({
    workspaceId: "w1",
    name,
    agentType: "shell",
    projectPath: "/tmp",
  });
  useTerminalsStore.getState().addTerminal(session);
  return session.id;
}

/** Give an already-seeded session a live xterm, as opening its card does. */
function openPane(id: string): { written: string[]; ops: string[] } {
  const written: string[] = [];
  const ops: string[] = [];
  registerTerminal(id, fakeTerminal(written, ops));
  return { written, ops };
}

/** A seeded session plus a live xterm, and what reached it. */
function seedPane(name: string): {
  id: string;
  written: string[];
  ops: string[];
} {
  const id = seedSession(name);
  return { id, ...openPane(id) };
}

const outputOf = (id: string) =>
  (useTerminalsStore.getState().byId[id]?.output ?? [])
    .map((l) => l.text)
    .join("");

beforeEach(() => {
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    frames.push(cb);
    return frames.length;
  });
  resetOutputQueues();
  clearTerminalRegistry();
  useTerminalsStore.setState({ byId: {} });
  useUIStore.setState({ focusedTerminalId: null });
});

afterEach(() => {
  // Before unstubbing rAF: reset also disarms the fallback timer, which would
  // otherwise outlive the test that armed it.
  resetOutputQueues();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("enqueueOutput", () => {
  it("writes nothing until a frame runs", () => {
    const { id, written } = seedPane("A");

    enqueueOutput(id, line("hello"));

    expect(written).toEqual([]);
    expect(outputOf(id)).toBe("");

    runFrame();

    expect(written).toEqual(["hello"]);
  });

  it("coalesces a frame's chunks into a single xterm write", () => {
    // The point of the batching: 300 PTY events in one frame must not be 300
    // xterm writes, each of which re-renders the pane.
    const { id, written } = seedPane("A");

    for (let i = 0; i < 300; i++) enqueueOutput(id, line(`${i};`));
    runFrame();

    expect(written).toHaveLength(1);
    expect(written[0]).toBe(
      Array.from({ length: 300 }, (_, i) => `${i};`).join(""),
    );
  });

  it("preserves byte order across frames", () => {
    const { id, written } = seedPane("A");

    enqueueOutput(id, line("one "));
    runFrame();
    enqueueOutput(id, line("two "));
    enqueueOutput(id, line("three"));
    runFrame();

    expect(written.join("")).toBe("one two three");
  });

  it("appends the same bytes to the store's ring buffer", () => {
    const { id } = seedPane("A");

    enqueueOutput(id, line("banner"));
    runFrame();

    expect(outputOf(id)).toBe("banner");
  });

  it("makes one store write per frame however many panes are streaming", () => {
    // Every mounted card and half the selectors in the app re-run on each
    // terminals-store write. One per frame is the budget; per chunk is what
    // this replaced.
    const panes = ["A", "B", "C"].map(seedPane);
    let writes = 0;
    const unsubscribe = useTerminalsStore.subscribe(() => writes++);

    for (const pane of panes) {
      for (let i = 0; i < 10; i++) enqueueOutput(pane.id, line("x"));
    }
    runFrame();
    unsubscribe();

    expect(writes).toBe(1);
    for (const pane of panes) expect(outputOf(pane.id)).toBe("x".repeat(10));
  });
});

describe("clearing a pane", () => {
  const clear = (id: string) => useTerminalsStore.getState().clearOutput(id);

  it("applies the clear in its place among the writes", () => {
    // The store action empties the ring buffer; the pane holds its own copy of
    // the scrollback and never reads that store. Both halves, in order.
    const { id, ops } = seedPane("A");

    enqueueOutput(id, line("before"));
    clear(id);
    enqueueOutput(id, line("after"));
    runFrame();

    expect(ops).toEqual(["write:before", "clear", "write:after"]);
  });

  it("clears even when the pane had nothing pending", () => {
    const { id, ops } = seedPane("A");

    clear(id);
    runFrame();

    expect(ops).toEqual(["clear"]);
  });

  it("keeps pre-clear output out of the ring it just emptied", () => {
    // The bytes queued before the clear are on their way to the ring too.
    // Appending them afterwards would put back what the clear removed.
    const { id } = seedPane("A");
    enqueueOutput(id, line("stale"));

    clear(id);
    enqueueOutput(id, line("fresh"));
    runFrame();

    expect(outputOf(id)).toBe("fresh");
  });
});

describe("flush order", () => {
  /** `n` streaming panes, each holding far more than one frame can carry, so
   *  every frame is a frame the budget has to be divided in. */
  function backloggedPanes(names: string[]) {
    const panes = names.map(seedPane);
    const chunk = "y".repeat(64 * 1024);
    const feed = () => {
      for (const pane of panes) {
        for (let i = 0; i < 8; i++) enqueueOutput(pane.id, line(chunk));
      }
    };
    return { panes, feed, chunk };
  }

  it("serves the focused pane its share before the others get any", () => {
    // The pane the user is looking at should not wait behind seven background
    // agents for its share of the frame. With one budget for the whole frame,
    // "first" is worth something: it is bytes the others do not get.
    const { panes, feed } = backloggedPanes(["A", "B", "C"]);
    feed();

    useUIStore.setState({ focusedTerminalId: panes[2]!.id });
    runFrame();

    const [a, b, c] = panes.map((p) => p.written.join("").length) as [
      number,
      number,
      number,
    ];
    expect(c).toBe(FRAME_BYTE_BUDGET * FOCUSED_FRAME_SHARE);
    expect(c).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
    // The rest of the frame, split between the two that are left.
    expect(a + b).toBe(FRAME_BYTE_BUDGET - c);
  });

  it("makes a pane over its share yield the rest of the frame", () => {
    // The failure this rules out: one runaway pane taking the whole frame
    // because it happened to be first in the map.
    const { panes, feed } = backloggedPanes(["A", "B"]);
    feed();

    runFrame();

    const written = panes.map((p) => p.written.join("").length);
    expect(written[0]).toBe(FRAME_BYTE_BUDGET / 2);
    expect(written[1]).toBe(FRAME_BYTE_BUDGET / 2);
  });

  it("rotates which panes a frame reaches when it cannot reach them all", () => {
    // Eight backlogged panes and a budget for four of them. Without the
    // rotation the same four would be served every frame and the other four
    // would never print at all.
    const { panes, feed } = backloggedPanes([
      "A",
      "B",
      "C",
      "D",
      "E",
      "F",
      "G",
      "H",
    ]);
    feed();

    const servedThisFrame = () => {
      const before = panes.map((p) => p.written.length);
      runFrame();
      return new Set(
        panes.filter((p, i) => p.written.length > before[i]!).map((p) => p.id),
      );
    };

    const first = servedThisFrame();
    const second = servedThisFrame();

    expect(first.size).toBe(4);
    expect(second.size).toBe(4);
    expect(new Set([...first, ...second]).size).toBeGreaterThan(4);
  });
});

describe("per-frame byte budget", () => {
  it("stops at the budget and carries the rest into the next frame", () => {
    // A pane running `yes` produces far more per frame than a terminal can
    // usefully render. Writing all of it would stall the frame; the excess
    // waits instead.
    const { id, written } = seedPane("A");
    const chunk = "y".repeat(8192);
    const chunks = Math.ceil(FRAME_BYTE_BUDGET / chunk.length) + 3;
    for (let i = 0; i < chunks; i++) enqueueOutput(id, line(chunk));

    runFrame();

    expect(written).toHaveLength(1);
    expect(written[0]!.length).toBeLessThanOrEqual(
      FRAME_BYTE_BUDGET + chunk.length,
    );
    expect(written[0]!.length).toBeGreaterThanOrEqual(FRAME_BYTE_BUDGET);

    drainFrames();

    expect(written.join("").length).toBe(chunks * chunk.length);
  });

  it("never stalls on a single chunk larger than the budget", () => {
    const { id, written } = seedPane("A");
    const huge = "z".repeat(FRAME_BYTE_BUDGET * 3);

    enqueueOutput(id, line(huge));
    runFrame();

    expect(written).toEqual([huge]);
  });

  it("divides one budget between the panes rather than giving each its own", () => {
    // Sixteen panes at a private 64 KiB each would be a megabyte of writes in
    // one frame — the stall the budget exists to prevent.
    const panes = ["A", "B", "C", "D"].map(seedPane);
    const chunk = "y".repeat(16 * 1024);
    for (const pane of panes) {
      for (let i = 0; i < 16; i++) enqueueOutput(pane.id, line(chunk));
    }

    runFrame();

    const total = panes.reduce((n, p) => n + p.written.join("").length, 0);
    expect(total).toBe(FRAME_BYTE_BUDGET);
    // …and every pane got a quarter of it, not one pane all of it.
    for (const pane of panes) {
      expect(pane.written.join("").length).toBe(FRAME_BYTE_BUDGET / 4);
    }
  });
});

describe("the queue cap", () => {
  /** `n` chunks of 64 KiB, each filled with a different character so the test
   *  can say exactly which ones a pane was shown. */
  function distinctChunks(n: number): string[] {
    return Array.from({ length: n }, (_, i) =>
      String.fromCharCode(97 + i).repeat(64 * 1024),
    );
  }

  it("drops the oldest pending bytes once a pane is over the cap", () => {
    // The queue is drained by frames, and frames stop while the window is
    // occluded. Without a cap a background `yes` pane grows until the user
    // comes back — hundreds of megabytes in the probe that found this.
    const { id, written } = seedPane("A");
    const chunks = distinctChunks(20); // 1.25 MiB against a 1 MiB cap

    for (const chunk of chunks) enqueueOutput(id, line(chunk));
    drainFrames();

    // `includes` rather than `toContain`: a failure here should not print two
    // 64 KiB strings at each other.
    const shown = written.join("");
    // 256 KiB over the cap: the four oldest chunks are what went.
    expect(shown.includes(chunks[0]!)).toBe(false);
    expect(shown.includes(chunks[3]!)).toBe(false);
    expect(shown.includes(chunks[4]!)).toBe(true);
    expect(shown.endsWith(chunks.at(-1)!)).toBe(true);
  });

  it("writes one marker into the pane where the bytes were dropped", () => {
    const { id, written } = seedPane("A");
    const chunks = distinctChunks(20);
    for (const chunk of chunks) enqueueOutput(id, line(chunk));

    drainFrames();
    const shown = written.join("");

    // Everything dropped folds into a single line, however many drops it took
    // to get there — 20 chunks of 64 KiB over a 1 MiB cap is 4 of them.
    expect(shown.match(/rocspace/g)).toHaveLength(1);
    expect(shown).toContain("\r\n[rocspace: 256 KiB of output skipped]\r\n");
    // …and it sits where the gap is: before the oldest chunk that survived.
    expect(shown.indexOf("[rocspace")).toBeLessThan(shown.indexOf(chunks[4]!));
  });

  it("keeps the dropped bytes in the ring buffer", () => {
    // Only the *view* loses them. The ring is the transcript the card replays
    // and the inspector reads, and it does its own capping by line count.
    const { id } = seedPane("A");
    const chunks = distinctChunks(20);

    for (const chunk of chunks) enqueueOutput(id, line(chunk));
    drainFrames();

    expect(outputOf(id)).toBe(chunks.join(""));
  });

  it("holds what a pane owes xterm at the cap however long it streams", () => {
    // 12.5 MiB with no frame in between — a window that has been occluded for
    // a while. What the pane eventually replays is the cap, not the backlog.
    const { id, written } = seedPane("A");
    const chunk = "y".repeat(64 * 1024);
    for (let i = 0; i < 200; i++) enqueueOutput(id, line(chunk));

    const frames = drainFrames(100);

    const shown = written.join("");
    expect(shown.length).toBeLessThanOrEqual(QUEUE_BYTE_CAP + 64);
    expect(shown.length).toBeGreaterThan(QUEUE_BYTE_CAP - 64 * 1024);
    // The cap is also what bounds the replay: a handful of frames, not the
    // ~50 the un-capped queue would have taken.
    expect(frames).toBeLessThanOrEqual(8);
  });
});

describe("the frame loop", () => {
  it("keeps scheduling frames while work remains, then stops", () => {
    const { id } = seedPane("A");
    const chunk = "y".repeat(FRAME_BYTE_BUDGET);
    for (let i = 0; i < 4; i++) enqueueOutput(id, line(chunk));

    expect(frames).toHaveLength(1);
    const ran = drainFrames();

    expect(ran).toBe(4);
    expect(frames).toHaveLength(0);
  });

  it("schedules one frame however many chunks arrive before it", () => {
    const { id } = seedPane("A");
    for (let i = 0; i < 20; i++) enqueueOutput(id, line("x"));
    expect(frames).toHaveLength(1);
  });
});

describe("the fallback drain", () => {
  /** Timers only — the rAF stub in `beforeEach` never fires on its own, which
   *  is exactly what an occluded WKWebView window does to the frame loop. */
  const withFakeTimers = () =>
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

  it("drains on a timer when no frame ever runs", () => {
    withFakeTimers();
    const { id, written } = seedPane("A");

    enqueueOutput(id, line("hidden output"));
    expect(written).toEqual([]);

    vi.advanceTimersByTime(FALLBACK_FLUSH_MS);

    expect(written).toEqual(["hidden output"]);
    expect(outputOf(id)).toBe("hidden output");
  });

  it("keeps draining on the timer while output keeps arriving", () => {
    withFakeTimers();
    const { id, written } = seedPane("A");
    const chunk = "y".repeat(FRAME_BYTE_BUDGET);

    for (let i = 0; i < 3; i++) enqueueOutput(id, line(chunk));
    for (let i = 0; i < 3; i++) vi.advanceTimersByTime(FALLBACK_FLUSH_MS);

    expect(written.join("")).toBe(chunk.repeat(3));
  });

  it("drains when the window's visibility changes", () => {
    // Going hidden is when the frame loop stops; coming back is when the user
    // wants what accumulated. Neither can wait for a frame that is not coming.
    const { id, written } = seedPane("A");
    enqueueOutput(id, line("backlog"));

    document.dispatchEvent(new Event("visibilitychange"));

    expect(written).toEqual(["backlog"]);
  });

  it("leaves the foreground path alone", () => {
    // With frames running, the timer must not write anything a second time or
    // add a store write of its own.
    withFakeTimers();
    const { id, written } = seedPane("A");
    let writes = 0;
    const unsubscribe = useTerminalsStore.subscribe(() => writes++);

    enqueueOutput(id, line("visible"));
    runFrame();
    vi.advanceTimersByTime(FALLBACK_FLUSH_MS * 4);
    unsubscribe();

    expect(written).toEqual(["visible"]);
    expect(writes).toBe(1);
  });
});

/** A frame flushes a terminal's queue whether or not anything is listening —
 *  it is never held back for an xterm that may open later. These pin that
 *  choice from both ends: what the ring keeps, and what nothing keeps. */
describe("panes with no xterm listening", () => {
  it("drains into the ring buffer instead of holding a backlog for one", () => {
    // A card whose xterm has not opened yet: a session restored from a
    // snapshot at boot, or bytes that arrive in the frames before `term.open`.
    // Waiting for it would grow without bound while the session sat unopened.
    const id = seedSession("A");

    enqueueOutput(id, line("early bytes"));
    runFrame();

    expect(outputOf(id)).toBe("early bytes");
    // Nothing left over: no frame was rescheduled to try again.
    expect(frames).toHaveLength(0);
  });

  it("does not replay the drained bytes into an xterm that opens later", () => {
    // Replaying the ring into a fresh terminal is `TerminalCard`'s job, and it
    // reads the store. If the queue kept those bytes for whatever xterm turned
    // up next, the pane would print its banner twice.
    const id = seedSession("A");
    enqueueOutput(id, line("early bytes"));
    runFrame();

    const { written } = openPane(id);
    flushOutputQueues();

    expect(written).toEqual([]);
    expect(outputOf(id)).toBe("early bytes");

    // Only what arrives after it opened is written to it.
    enqueueOutput(id, line(" and later"));
    runFrame();
    expect(written).toEqual([" and later"]);
  });

  it("discards output for a terminal the store has forgotten", () => {
    // A pane closed in the frame between the PTY writing and the flush. There
    // is no session left to hold a ring buffer, so the bytes go nowhere —
    // quietly, and without keeping the queue alive.
    const { id } = seedPane("A");
    enqueueOutput(id, line("orphan"));
    useTerminalsStore.getState().removeTerminal(id);
    unregisterTerminal(id);

    expect(() => runFrame()).not.toThrow();
    expect(useTerminalsStore.getState().byId[id]).toBeUndefined();
    expect(frames).toHaveLength(0);

    // …and nothing was kept for a terminal that re-registers under that id.
    const { written } = openPane(id);
    flushOutputQueues();
    expect(written).toEqual([]);
  });
});

describe("flushOutputQueues", () => {
  it("flushes synchronously, for tests and teardown", () => {
    const { id, written } = seedPane("A");
    enqueueOutput(id, line("now"));

    flushOutputQueues();

    expect(written).toEqual(["now"]);
  });

  it("does nothing when there is nothing queued", () => {
    expect(() => flushOutputQueues()).not.toThrow();
  });
});
