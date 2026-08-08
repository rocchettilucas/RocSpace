/** rAF-batched PTY writes.
 *
 *  A streaming pane produces output far faster than a screen can show it: a
 *  shell running `yes` emits hundreds of `terminal://output` events a second,
 *  and each one used to be its own `xterm.write` *and* its own terminals-store
 *  write. Both are expensive at that rate — the store write re-runs every
 *  selector in the app (and re-renders every mounted card), and xterm re-renders
 *  per write. With eight such panes the UI stops answering the pointer.
 *
 *  So nothing is written where it lands. Output is queued per terminal and
 *  drained once per animation frame:
 *    - ONE budget, `FRAME_BYTE_BUDGET`, covers the whole frame rather than each
 *      pane, because what has to stay bounded is the work the frame does. A
 *      per-pane budget is not a budget: sixteen panes at 64 KiB each is a
 *      megabyte of writes in one frame, which is the stall it was meant to
 *      prevent;
 *    - the focused pane is served first and guaranteed `FOCUSED_FRAME_SHARE`
 *      of that budget, so the pane the user is looking at does not queue behind
 *      fifteen background agents;
 *    - what is left is split evenly among the rest in a rotating order, so a
 *      frame too small to serve everyone serves a different subset next time
 *      and no background agent is permanently starved;
 *    - whatever a pane does not get carries to the next frame;
 *    - the whole frame's ring-buffer appends land in ONE store write.
 *
 *  What this does not do is take the cards off React. That store write still
 *  re-runs every selector and re-renders every mounted card, `TerminalCard`
 *  included — it subscribes through `useTerminalById`. What changed is how
 *  many: renders now scale with flushes rather than with PTY chunks, one per
 *  frame instead of hundreds, and a card that re-renders writes nothing.
 *
 *  A pane with no live xterm (its card has not opened one yet) still drains:
 *  the bytes go to the store's ring buffer, which is what `TerminalCard`
 *  replays when its terminal finally opens. Queueing them instead would grow
 *  without bound.
 *
 *  Two things keep the queue itself bounded, because a queue drained only by
 *  animation frames is not:
 *    - WKWebView suspends rAF while the window is occluded or minimized, which
 *      is exactly when background agents are streaming. So a coarse timer and
 *      `visibilitychange` drain on the same budget when no frame is coming —
 *      see `scheduleFlush`.
 *    - a PTY can outrun any drain, timer or frame. Past `QUEUE_BYTE_CAP` a
 *      terminal drops its OLDEST pending bytes rather than growing: the dropped
 *      text still reaches the ring buffer (which caps itself), and xterm gets a
 *      one-line marker in its place. Retained memory is then bounded by the cap
 *      plus the ring, instead of by how long the window stayed hidden. */

import type { TerminalOutputLine } from "@/lib/bindings";
import { getTerminal } from "@/lib/terminalRegistry";
import {
  OUTPUT_RING_BUFFER_CAP,
  useTerminalsStore,
  type TerminalOutputBatchEntry,
} from "@/stores/terminals";
import { useUIStore } from "@/stores/ui";

/** Bytes written per frame across ALL terminals. 256 KiB is far more than a
 *  screenful of panes can actually display in 16 ms — the budget is a stall
 *  guard, not a throttle, so it must not be tight enough to add latency to
 *  ordinary output. Counted in UTF-16 code units (`String.length`), which is
 *  within a factor of two of the byte count for anything a terminal prints. */
export const FRAME_BYTE_BUDGET = 256 * 1024;

/** The focused pane's guaranteed slice of a frame. Half, so it stays fast to
 *  read under any number of background streams, while the other half still
 *  goes round the rest — a pane the user is not looking at is not one whose
 *  output can be dropped, only one that can wait a frame. */
export const FOCUSED_FRAME_SHARE = 0.5;

/** How much unwritten output one terminal may hold before it starts dropping
 *  the oldest of it.
 *
 *  1 MiB is several frames of the budget above: enough that no burst a pane
 *  can produce is ever truncated, and small enough that sixteen hidden panes
 *  cost tens of megabytes rather than the hundreds a hidden window used to
 *  accumulate. What is dropped is dropped from the *xterm* side only — the
 *  bytes still reach the ring buffer, so the transcript stays complete to the
 *  depth the ring itself keeps. */
export const QUEUE_BYTE_CAP = 1024 * 1024;

/** How long a flush may wait for an animation frame that may never come.
 *
 *  Coarse on purpose: this is the drain of last resort for a window whose rAF
 *  is suspended, not a second scheduler. At four flushes a second it moves the
 *  same budget a visible window moves in four frames. */
export const FALLBACK_FLUSH_MS = 250;

/** What a queue holds.
 *
 *  Two of the three are control tokens rather than output, because both have to
 *  reach the pane in their place in the byte stream: `skipped` is the marker
 *  written where the cap dropped bytes (carrying how many, so the flush renders
 *  it once however many drops fed it), and `clear` is a `term.clear()` waiting
 *  its turn among the writes around it.
 *
 *  `text.ring` is false for output a queued `clear` supersedes — the pane still
 *  shows it and then clears it, but the ring buffer must not receive it after
 *  the store has already emptied itself. */
type QueueItem =
  | { kind: "text"; line: TerminalOutputLine; ring: boolean }
  | { kind: "skipped"; bytes: number }
  | { kind: "clear" };

interface Queue {
  /** Pending items in arrival order: what xterm has not been shown yet. */
  items: QueueItem[];
  /** Total `text.length` across the `text` items, for the cap check. */
  bytes: number;
  /** Lines the cap dropped from `items`, still owed to the ring buffer. They
   *  precede everything left in `items`, and are themselves capped at the
   *  ring's depth — anything older than that the ring would trim on arrival. */
  ringOnly: TerminalOutputLine[];
}

/** Pending output per terminal. Map iteration order is insertion order, which
 *  is what the rotation below indexes into. */
const queues = new Map<string, Queue>();

/** True between requesting a frame and that frame running. */
let frameRequested = false;

/** Armed whenever a flush is pending, in case the frame never runs. */
let fallbackTimer: ReturnType<typeof setTimeout> | null = null;

/** Rotates which unfocused terminal is served first. */
let rotation = 0;

/** Queue one chunk of PTY output for `terminalId` and make sure a flush is
 *  coming. Called once per `terminal://output` event. */
export function enqueueOutput(
  terminalId: string,
  line: TerminalOutputLine,
): void {
  const queue = queueFor(terminalId);
  queue.items.push({ kind: "text", line, ring: true });
  queue.bytes += line.text.length;
  if (queue.bytes > QUEUE_BYTE_CAP) dropOldest(queue);
  scheduleFlush();
}

/** Queue a `term.clear()` for `terminalId`.
 *
 *  The terminals store's `clearOutput` empties the ring buffer, which is the
 *  half of "clear this pane" React can see; this is the other half. It goes
 *  through the queue rather than straight at the xterm instance because output
 *  that arrived before it is still waiting for a frame — written afterwards,
 *  those bytes would survive the clear that was supposed to remove them. */
export function enqueueClear(terminalId: string): void {
  const queue = queueFor(terminalId);
  // Everything queued so far is output this clear supersedes. It still goes to
  // xterm, in order, and is cleared there a moment later — but the ring has
  // just been emptied, and appending pre-clear text to it afterwards would put
  // back what the clear removed.
  queue.ringOnly = [];
  for (const item of queue.items) {
    if (item.kind === "text") item.ring = false;
  }
  queue.items.push({ kind: "clear" });
  scheduleFlush();
}

/** Drain every queue: xterm writes first, then one batched store append.
 *
 *  Exported so tests can advance the pipeline without a real animation frame,
 *  and so a caller that needs the store caught up right now can say so. */
export function flushOutputQueues(): void {
  if (queues.size === 0) return;

  const focusedId = useUIStore.getState().focusedTerminalId;
  const order = flushOrder(focusedId);
  let remaining = FRAME_BYTE_BUDGET;

  const batch: TerminalOutputBatchEntry[] = [];
  for (const [position, terminalId] of order.entries()) {
    // Out of frame. The panes not reached keep their place in the map and go
    // first in a later frame, which is what makes the rotation above matter.
    if (remaining <= 0) break;

    const queue = queues.get(terminalId);
    if (!queue) continue;

    const items = takeUpToBudget(
      queue,
      shareOf(remaining, order.length - position, terminalId === focusedId),
    );
    // Dropped bytes are owed to the ring in front of whatever is written now:
    // they arrived before it.
    const lines: TerminalOutputLine[] = queue.ringOnly;
    queue.ringOnly = [];

    if (queue.items.length === 0) {
      queues.delete(terminalId);
    } else {
      // Back of the map: a terminal that could not be drained yields its place
      // in the insertion order to the ones that could.
      queues.delete(terminalId);
      queues.set(terminalId, queue);
    }

    // The one real consumer of the terminal registry: the xterm instance is
    // owned by a React component, and this path is not React.
    const term = getTerminal(terminalId);
    let text = "";
    const writeThrough = () => {
      if (text.length === 0) return;
      if (term) term.write(text);
      text = "";
    };

    for (const item of items) {
      if (item.kind === "text") {
        text += item.line.text;
        if (item.ring) lines.push(item.line);
        // Only real output is charged to the frame; the control tokens are
        // written *instead* of output, not as well as it.
        remaining -= item.line.text.length;
      } else if (item.kind === "skipped") {
        text += skippedMarker(item.bytes);
      } else {
        // Everything queued ahead of the clear has to be on screen before it,
        // or the clear removes less than the user asked it to.
        writeThrough();
        term?.clear();
      }
    }
    writeThrough();

    if (lines.length > 0) batch.push({ terminalId, lines });
  }

  if (batch.length > 0) {
    useTerminalsStore.getState().appendOutputBatch(batch);
  }
  // Whatever the budget left behind gets the next frame.
  if (queues.size > 0) scheduleFlush();
}

/** Forget everything queued. Test helper — the app has no reason to discard
 *  output that has already left the PTY. */
export function resetOutputQueues(): void {
  queues.clear();
  frameRequested = false;
  clearFallback();
  rotation = 0;
}

function queueFor(terminalId: string): Queue {
  let queue = queues.get(terminalId);
  if (!queue) {
    queue = { items: [], bytes: 0, ringOnly: [] };
    queues.set(terminalId, queue);
  }
  return queue;
}

/** Drop from the head until the queue is back under the cap, moving what it
 *  drops onto the ring-buffer side so only the *view* loses those bytes.
 *
 *  The marker goes where the drop happened — the new head — and successive
 *  drops fold into it, so a pane that has been hidden for a minute shows one
 *  line rather than a screenful of them. */
function dropOldest(queue: Queue): void {
  let dropped = 0;
  let clearDropped = false;
  while (queue.bytes > QUEUE_BYTE_CAP) {
    const item = queue.items.shift();
    if (!item) break;
    if (item.kind === "text") {
      queue.bytes -= item.line.text.length;
      dropped += item.line.text.length;
      if (item.ring) queue.ringOnly.push(item.line);
    } else if (item.kind === "skipped") {
      // A marker being dropped: its count folds into the one written below.
      dropped += item.bytes;
    } else {
      // A clear survives being dropped. Everything it was meant to remove went
      // with the bytes ahead of it, so it belongs at the new head either way.
      clearDropped = true;
    }
  }
  if (dropped === 0) return;

  if (queue.ringOnly.length > OUTPUT_RING_BUFFER_CAP) {
    queue.ringOnly.splice(0, queue.ringOnly.length - OUTPUT_RING_BUFFER_CAP);
  }

  const head = queue.items[0];
  if (head?.kind === "skipped") head.bytes += dropped;
  else queue.items.unshift({ kind: "skipped", bytes: dropped });
  if (clearDropped) queue.items.unshift({ kind: "clear" });
}

/** The line xterm gets in place of dropped bytes. On its own line either side,
 *  so it cannot land in the middle of whatever the agent was painting. */
function skippedMarker(bytes: number): string {
  const kib = Math.max(1, Math.round(bytes / 1024));
  return `\r\n[rocspace: ${kib} KiB of output skipped]\r\n`;
}

function scheduleFlush(): void {
  if (!frameRequested) {
    frameRequested = true;
    requestAnimationFrame(() => {
      frameRequested = false;
      clearFallback();
      flushOutputQueues();
    });
  }
  armFallback();
}

/** The drain for when no frame is coming.
 *
 *  rAF is suspended while the window is occluded, minimized, or on another
 *  Space — which is precisely when background agents stream unattended. The
 *  frame requested above then never runs, so without this the queue would only
 *  move again when the user came back. */
function armFallback(): void {
  if (fallbackTimer !== null) return;
  fallbackTimer = setTimeout(() => {
    fallbackTimer = null;
    flushOutputQueues();
  }, FALLBACK_FLUSH_MS);
}

function clearFallback(): void {
  if (fallbackTimer === null) return;
  clearTimeout(fallbackTimer);
  fallbackTimer = null;
}

// Both edges matter: going hidden is when the frame loop stops, and coming back
// is when the user wants what accumulated while it was stopped — neither can
// wait for a frame that is not scheduled.
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    flushOutputQueues();
  });
}

/** Focused terminal first; the rest in a rotating order so the same pane is
 *  not always served last.
 *
 *  With one budget for the whole frame, order decides who is served at all
 *  when there is not enough of it to go round — which is why the rotation is
 *  here and why it advances every flush. */
function flushOrder(focusedId: string | null): string[] {
  const others = [...queues.keys()].filter((id) => id !== focusedId);
  const start = others.length > 0 ? rotation % others.length : 0;
  rotation++;
  const rotated = [...others.slice(start), ...others.slice(0, start)];
  return focusedId !== null && queues.has(focusedId)
    ? [focusedId, ...rotated]
    : rotated;
}

/** What one pane may take out of a frame that has `remaining` left and
 *  `panesLeft` panes still to serve, including this one.
 *
 *  An even split of what is left, except the focused pane, which takes its
 *  guaranteed share when that is more. Unused capacity is not lost: `remaining`
 *  only falls by what a pane actually writes, so a quiet pane's slice widens
 *  the ones after it. */
function shareOf(
  remaining: number,
  panesLeft: number,
  focused: boolean,
): number {
  const even = remaining / panesLeft;
  if (!focused) return even;
  return Math.max(
    even,
    Math.min(remaining, FRAME_BYTE_BUDGET * FOCUSED_FRAME_SHARE),
  );
}

/** Remove and return as many whole items as `share` allows — always at least
 *  one, so a single chunk larger than the whole frame cannot stall forever. */
function takeUpToBudget(queue: Queue, share: number): QueueItem[] {
  let count = 0;
  let bytes = 0;
  while (count < queue.items.length && bytes < share) {
    const item = queue.items[count]!;
    if (item.kind === "text") bytes += item.line.text.length;
    count++;
  }
  queue.bytes -= bytes;
  // One splice rather than repeated shift(): shift is O(n) per call, and these
  // queues are long exactly when the frame is already under pressure.
  return queue.items.splice(0, count);
}
