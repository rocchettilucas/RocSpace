/** How PTY bytes reach a pane's xterm.
 *
 *  The card no longer writes live output at all — `outputQueue` writes it
 *  straight to the xterm instance once per frame, and the card only replays
 *  what the ring buffer already held when its terminal opened. The two halves
 *  have to add up to "every byte exactly once", which is what this file pins:
 *  a card that also wrote on every store change would double every chunk, and
 *  one that never replayed would boot a restored session blank.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";

/** Recording stand-in for xterm.js — jsdom has no canvas, and all this file
 *  needs is the exact sequence of writes. */
const { FakeTerminal } = vi.hoisted(() => {
  const disposable = () => ({ dispose: () => {} });
  class FakeTerminal {
    options: Record<string, unknown>;
    written: string[] = [];
    buffer = { active: { getLine: () => null } };
    constructor(options: Record<string, unknown> = {}) {
      this.options = { ...options };
    }
    loadAddon() {}
    open() {}
    onData() {
      return disposable();
    }
    onKey() {
      return disposable();
    }
    onResize() {
      return disposable();
    }
    registerLinkProvider() {
      return disposable();
    }
    write(data: string) {
      this.written.push(data);
    }
    clear() {}
    dispose() {}
  }
  return { FakeTerminal };
});

vi.mock("@xterm/xterm", () => ({ Terminal: FakeTerminal }));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    proposeDimensions() {
      return { cols: 80, rows: 24 };
    }
    fit() {}
  },
}));
vi.mock("@/lib/bindings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/bindings")>()),
  commands: {
    terminalSpawn: vi.fn(async () => ({ pid: 1, claudeSessionId: null })),
    terminalKill: vi.fn(async () => {}),
    terminalWrite: vi.fn(async () => {}),
    terminalResize: vi.fn(async () => {}),
  },
}));

import type { TerminalOutputLine } from "@/lib/bindings";
import { newTerminal, newWorkspace } from "@/lib/factories";
import {
  enqueueOutput,
  flushOutputQueues,
  resetOutputQueues,
} from "@/lib/outputQueue";
import { RESTORED_NOTICE } from "@/lib/outputReplay";
import { clearTerminalRegistry, getTerminal } from "@/lib/terminalRegistry";
import {
  OUTPUT_RING_BUFFER_CAP,
  useTerminalsStore,
  useUIStore,
  useWorkspacesStore,
} from "@/stores";
import { TerminalCard } from "@/views/RocDock/TerminalCard";

const ESC = "\u001b";

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

let seq = 0;
const line = (text: string): TerminalOutputLine => ({
  id: `l${seq++}`,
  ts: seq,
  stream: "stdout",
  text,
});

/** A session in a workspace, optionally with output already buffered. */
function seed(buffered: string[] = []): string {
  const workspace = newWorkspace({ projectPath: "/tmp/proj", order: 0 });
  const session = newTerminal({
    workspaceId: workspace.id,
    name: "Rocky",
    agentType: "shell",
    projectPath: "/tmp/proj",
  });
  useWorkspacesStore.setState({
    workspaces: [
      { ...workspace, paneTree: { kind: "leaf", terminalId: session.id } },
    ],
    activeWorkspaceId: workspace.id,
  });
  useTerminalsStore
    .getState()
    .setTerminals([{ ...session, output: buffered.map(line) }]);
  return session.id;
}

const written = (id: string) =>
  (getTerminal(id) as unknown as InstanceType<typeof FakeTerminal>).written;

beforeEach(() => {
  resetOutputQueues();
  clearTerminalRegistry();
  useWorkspacesStore.setState({ workspaces: [], activeWorkspaceId: null });
  useTerminalsStore.setState({ byId: {} });
  useUIStore.setState({ focusedTerminalId: null, maximizedTerminalId: null });
});

describe("TerminalCard output", () => {
  it("replays the ring buffer into a freshly opened terminal", () => {
    // A session restored from a snapshot at boot: the PTY events that produced
    // this text are long gone, so the buffer is the only source.
    const id = seed(["boot ", "banner"]);

    render(<TerminalCard terminalId={id} />);

    expect(written(id).join("")).toBe("boot banner");
  });

  it("opens a terminal with no history silently", () => {
    const id = seed();

    render(<TerminalCard terminalId={id} />);

    expect(written(id)).toEqual([]);
  });

  it("writes live output on the frame, not on the store append", () => {
    const id = seed();
    render(<TerminalCard terminalId={id} />);

    act(() => {
      enqueueOutput(id, line("hello "));
      enqueueOutput(id, line("world"));
    });
    expect(written(id)).toEqual([]);

    act(() => flushOutputQueues());

    expect(written(id)).toEqual(["hello world"]);
  });

  it("writes each chunk exactly once", () => {
    // The card used to write from the store on every output change. With the
    // queue writing directly, doing both would print everything twice.
    const id = seed(["history."]);
    render(<TerminalCard terminalId={id} />);

    act(() => {
      enqueueOutput(id, line("live."));
      flushOutputQueues();
    });

    expect(written(id).join("")).toBe("history.live.");
  });

  /** A ring at its cap: the start of the process's stream has been trimmed
   *  away, which is the case every long-running pane is restored in. `fill`
   *  makes the chunk at index `i`. */
  const trimmedRing = (fill: (i: number) => string) =>
    seed(Array.from({ length: OUTPUT_RING_BUFFER_CAP }, (_, i) => fill(i)));

  it("replays a trimmed ring from its last full-screen clear", () => {
    // The ring records screen OPERATIONS, not a document. Everything before the
    // clear addressed cells the clear then emptied, so writing it into a fresh
    // grid paints ghosts underneath what the pane should be showing — which is
    // the corruption this path was reported for. See `lib/outputReplay`.
    const id = trimmedRing((i) =>
      i === OUTPUT_RING_BUFFER_CAP - 2
        ? `stale frame${ESC}[2J`
        : i === OUTPUT_RING_BUFFER_CAP - 1
          ? `${ESC}[Hfresh frame`
          : `${ESC}[3;1Hstale frame ${i}`,
    );

    render(<TerminalCard terminalId={id} />);

    expect(written(id).join("")).toBe(`${ESC}[2J${ESC}[Hfresh frame`);
  });

  it("flattens a trimmed ring that addresses the screen", () => {
    // A ring at its cap no longer holds the start of the process's stream, and
    // these frames each step the cursor UP into rows that were trimmed away —
    // so there is no state left for them to be replayed from. They are shown as
    // what they say instead, and the pane says so.
    const id = trimmedRing((i) => `${ESC}[1A\rframe ${i}${ESC}[K`);

    render(<TerminalCard terminalId={id} />);

    const out = written(id).join("");
    expect(out.startsWith(RESTORED_NOTICE)).toBe(true);
    expect(out).toContain(`frame ${OUTPUT_RING_BUFFER_CAP - 1}`);
    // Nothing left that could put two frames in the same cells.
    expect(out.slice(RESTORED_NOTICE.length)).not.toContain(`${ESC}[K`);
    expect(out.slice(RESTORED_NOTICE.length)).not.toContain("\r");
    expect(out.slice(RESTORED_NOTICE.length)).not.toContain(`${ESC}[1A`);
  });

  it("hands a trimmed ring of redrawn lines straight to the terminal", () => {
    // The other shape a trimmed ring comes in, and the commoner one: a build
    // that rewrites its progress bar with CR and never addresses a row. Those
    // bytes replay into a blank grid EXACTLY as they rendered live, so the pane
    // gets them untouched — no transcript, no banner, and each bar still
    // collapsed to its last frame instead of spread over ten lines.
    const id = trimmedRing((i) => `\r${ESC}[KBuilding [${i % 10}0%]`);
    const ring = useTerminalsStore.getState().byId[id]!.output;

    render(<TerminalCard terminalId={id} />);

    expect(written(id).join("")).toBe(ring.map((l) => l.text).join(""));
  });

  it("does not rewrite the buffer when the card re-renders", () => {
    const id = seed(["history."]);
    const { rerender } = render(<TerminalCard terminalId={id} />);

    act(() => {
      enqueueOutput(id, line("live."));
      flushOutputQueues();
    });
    act(() => {
      useTerminalsStore.getState().setStatus(id, "running");
    });
    rerender(<TerminalCard terminalId={id} />);

    expect(written(id).join("")).toBe("history.live.");
  });
});
