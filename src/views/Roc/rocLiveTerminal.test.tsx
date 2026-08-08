/** Roc's live terminal is a READER, and this file is why that matters.
 *
 *  The dock holds each pane's card in a permanent host element and portals it
 *  there for the pane's whole life; the slot that shows it adopts that host in a
 *  layout effect nothing else re-runs (see `PaneTree`). So a second surface that
 *  wanted the same terminal had exactly two ways to take it — move the host, or
 *  re-`open()` the xterm — and both empty the dock's slot with no commit coming
 *  to put it back. The mirror takes neither: it reads `buffer.active`, which is
 *  the same buffer `outputQueue` is already writing into every frame.
 *
 *  The last test here is the invariant stated directly: the dock's card is the
 *  same DOM node, still connected, and its terminal was never disposed, after
 *  the Roc panel has been watching it. */

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

const { FakeTerminal } = vi.hoisted(() => {
  const disposable = (bag: Array<() => void>, fn: () => void) => {
    bag.push(fn);
    return {
      dispose: () => {
        const at = bag.indexOf(fn);
        if (at !== -1) bag.splice(at, 1);
      },
    };
  };
  class FakeTerminal {
    disposeCalls = 0;
    element: HTMLElement | null = null;
    options: Record<string, unknown>;
    rows = 4;
    written: string[] = [];
    /** The screen, as the mirror will read it. */
    lines: string[] = [];
    private writeParsed: Array<() => void> = [];
    private scrolled: Array<() => void> = [];
    private resized: Array<() => void> = [];
    buffer = {
      active: {
        viewportY: 0,
        getLine: (y: number) =>
          y < this.lines.length
            ? { translateToString: () => this.lines[y]! }
            : null,
      },
    };
    constructor(options: Record<string, unknown> = {}) {
      this.options = { ...options };
    }
    loadAddon() {}
    open(el: HTMLElement) {
      this.element = el;
    }
    onData() {
      return { dispose: () => {} };
    }
    onKey() {
      return { dispose: () => {} };
    }
    onResize(fn: () => void) {
      return disposable(this.resized, fn);
    }
    onScroll(fn: () => void) {
      return disposable(this.scrolled, fn);
    }
    onWriteParsed(fn: () => void) {
      return disposable(this.writeParsed, fn);
    }
    registerLinkProvider() {
      return { dispose: () => {} };
    }
    write(data: string) {
      this.written.push(data);
    }
    /** Paint a screen and tell whoever is listening, the way a real write does. */
    paint(lines: string[]) {
      this.lines = lines;
      for (const fn of [...this.writeParsed]) fn();
    }
    clear() {}
    dispose() {
      this.disposeCalls++;
    }
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

import { commands } from "@/lib/bindings";
import { newTerminal, newWorkspace } from "@/lib/factories";
import type { PaneNode } from "@/lib/paneTree";
import {
  clearTerminalRegistry,
  getTerminal,
  registerTerminal,
} from "@/lib/terminalRegistry";
import {
  useRocStore,
  useTerminalsStore,
  useToastsStore,
  useUIStore,
  useWorkspacesStore,
} from "@/stores";
import { LiveTerminal, readViewport } from "@/views/Roc/LiveTerminal";
import { PaneTree } from "@/views/RocDock/PaneTree";

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  // Synchronous frames: the mirror coalesces its reads into one, and a test
  // that waited for a real frame would be a test about jsdom's timers.
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
});

const leaf = (terminalId: string): PaneNode => ({ kind: "leaf", terminalId });

/** One workspace, one pane, seeded into the stores. */
function seed(name = "Rocky") {
  const workspace = newWorkspace({ projectPath: "/tmp/proj", order: 0 });
  const session = newTerminal({
    workspaceId: workspace.id,
    name,
    agentType: "shell",
    projectPath: "/tmp/proj",
  });
  useTerminalsStore.getState().setTerminals([session]);
  useWorkspacesStore.setState({
    workspaces: [{ ...workspace, paneTree: leaf(session.id) }],
    activeWorkspaceId: workspace.id,
  });
  return { workspace, session };
}

/** The same pane, in a workspace that is NOT the one that is up.
 *
 *  Being elsewhere is NOT what leaves it without a screen — the dock hosts
 *  every workspace's cards, so a background pane keeps its xterm and is
 *  mirrored like any other (see `PaneCardHost`, and the test below that proves
 *  it). What leaves it without one here is that these cases render no dock at
 *  all, so nothing has registered a terminal: the state a pane is in for the
 *  frames before its card mounts. */
function seedElsewhere(name = "Rocky") {
  const seeded = seed(name);
  const other = newWorkspace({ projectPath: "/tmp/other", order: 1 });
  useWorkspacesStore.setState((s) => ({
    workspaces: [...s.workspaces, { ...other, paneTree: null }],
    activeWorkspaceId: other.id,
  }));
  return seeded;
}

const xterm = (id: string) =>
  getTerminal(id) as unknown as InstanceType<typeof FakeTerminal>;

beforeEach(() => {
  vi.clearAllMocks();
  clearTerminalRegistry();
  useWorkspacesStore.setState({ workspaces: [], activeWorkspaceId: null });
  useTerminalsStore.setState({ byId: {} });
  useUIStore.setState({ focusedTerminalId: null, maximizedTerminalId: null });
  useToastsStore.setState({ items: [] });
  useRocStore.setState({ focusedRailTerminalId: null });
});

describe("readViewport", () => {
  it("reads the visible screen from wherever it is scrolled to", () => {
    const term = new FakeTerminal();
    term.rows = 3;
    term.lines = ["one", "two", "three", "four", "five"];
    term.buffer.active.viewportY = 2;

    expect(readViewport(term as never)).toEqual(["three", "four", "five"]);
  });

  it("drops the blank rows a mostly-empty shell leaves behind", () => {
    const term = new FakeTerminal();
    term.rows = 4;
    term.lines = ["$ ls", "", "", ""];

    expect(readViewport(term as never)).toEqual(["$ ls"]);
  });
});

describe("the mirror", () => {
  it("shows what the live terminal has on its screen, and follows it", () => {
    const { session } = seed();
    render(<PaneTree />);
    const term = xterm(session.id);

    const { container } = render(<LiveTerminal terminalId={session.id} />);
    act(() => term.paint(["$ pnpm test", "813 passed"]));

    const mirror = container.querySelector("[data-roc-live-mirror]")!;
    expect(mirror).toHaveTextContent("$ pnpm test");
    expect(mirror).toHaveTextContent("813 passed");

    act(() => term.paint(["$ pnpm test", "813 passed", "Done in 9.7s"]));
    expect(mirror).toHaveTextContent("Done in 9.7s");
  });

  // The state the copy is actually about: no card has mounted for this session
  // yet, so nothing registered a terminal. When that session is in another
  // workspace the panel offers the way in as well, rather than showing an empty
  // black box.
  it("offers a switch when the session's dock is not the one that is up", () => {
    const { session } = seedElsewhere();
    // Seeded, but nothing rendered the dock — so nothing registered a terminal.
    render(<LiveTerminal terminalId={session.id} />);

    expect(screen.getByText(/is in another workspace/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /switch to that workspace/i }),
    ).toBeInTheDocument();
  });

  // Two lies this copy has told, in order. The first said the agent's terminal
  // was "only running while that workspace's dock is up" — false, because only
  // `closeWorkspace` calls `terminalKill`. The second said its screen was
  // missing BECAUSE a screen is only mirrored while that workspace's dock is
  // up, which stopped being true when the dock started hosting every
  // workspace's cards: a background pane keeps its xterm and is mirrored. Both
  // would send a user to restart work that was already being done, or to switch
  // workspaces to fix something that is not broken.
  it("does not claim the agent stopped, or that its workspace is why", () => {
    const { session } = seedElsewhere();
    render(<LiveTerminal terminalId={session.id} />);

    const message = screen.getByText(/is in another workspace/i).textContent!;
    expect(message).toMatch(/still running/i);
    expect(message).toMatch(/screen/i);
    expect(message).toMatch(/has not mounted yet/i);
    expect(message).not.toMatch(/terminal is only running/i);
    expect(message).not.toMatch(/only mirrored while/i);
  });

  // And the claim itself, at the level it is made: a pane in a workspace that
  // is NOT up has a card, an xterm, and a mirror — the dock hosts every
  // workspace's leaves, so there is no empty state to show at all.
  it("mirrors a pane whose workspace is not the one on screen", () => {
    const { session } = seedElsewhere();
    render(<PaneTree />);
    const term = xterm(session.id);

    const { container } = render(<LiveTerminal terminalId={session.id} />);
    act(() => term.paint(["$ cargo build", "Compiling rocspace v0.1.0"]));

    expect(container.querySelector("[data-roc-live-mirror]")).toHaveTextContent(
      "Compiling rocspace v0.1.0",
    );
    expect(screen.queryByText(/is in another workspace/i)).toBeNull();
  });

  // A pane on the dock that is up, whose card simply has not mounted yet, is a
  // different sentence — there is no workspace to switch to.
  it("says a pane on this dock is still coming, with nowhere to switch", () => {
    const { session } = seed();
    render(<LiveTerminal terminalId={session.id} />);

    expect(screen.getByText(/has not mounted yet/i)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /switch to that workspace/i }),
    ).toBeNull();
  });

  // The registry is the signal: a session whose card mounts later must light up
  // without this panel having to poll or guess at effect ordering.
  it("picks the terminal up when its card mounts afterwards", () => {
    const { session } = seed();
    const { container } = render(<LiveTerminal terminalId={session.id} />);
    expect(container.querySelector("[data-roc-live-mirror]")).toBeNull();

    const term = new FakeTerminal();
    term.lines = ["hello"];
    act(() => registerTerminal(session.id, term as never));

    expect(container.querySelector("[data-roc-live-mirror]")).toHaveTextContent(
      "hello",
    );
  });
});

describe("the input line", () => {
  it("sends what was typed, sanitized and framed as one paste", async () => {
    const { session } = seed();
    render(<PaneTree />);
    render(<LiveTerminal terminalId={session.id} />);

    const box = screen.getByLabelText("Send to Rocky");
    fireEvent.change(box, { target: { value: "run the tests" } });
    fireEvent.keyDown(box, { key: "Enter" });

    expect(commands.terminalWrite).toHaveBeenCalledWith(
      session.id,
      "\x1b[200~run the tests\x1b[201~\r",
    );
    // …and the box is cleared, so Enter twice does not send it twice.
    expect((box as HTMLInputElement).value).toBe("");
  });

  // A closing marker pasted into the box would otherwise end the paste early
  // and let everything after it arrive as real typing — a message that runs a
  // command. The escape goes, and the marker is broken as literal text.
  it("strips the escapes that would break out of the paste", () => {
    const { session } = seed();
    render(<PaneTree />);
    render(<LiveTerminal terminalId={session.id} />);

    const box = screen.getByLabelText("Send to Rocky");
    fireEvent.change(box, {
      target: { value: "oops\x1b[201~rm -rf /" },
    });
    fireEvent.keyDown(box, { key: "Enter" });

    const [, written] = vi.mocked(commands.terminalWrite).mock.calls[0]!;
    expect(written).toBe("\x1b[200~oops[201 ~rm -rf /\x1b[201~\r");
    // The only ESCs and the only CR that reach the PTY are the frame's own.
    expect(written.split("\x1b")).toHaveLength(3);
    expect(written.split("\r")).toHaveLength(2);
  });

  // The box is offered on a pane with no mirror — one whose card has not
  // mounted — and it works: the PTY is alive whether or not anything here is
  // showing its screen. What it must not do is look like an ordinary send,
  // because nothing above it will move.
  it("still reaches a pane with no screen here, and says the send was blind", async () => {
    const { session } = seedElsewhere();
    render(<LiveTerminal terminalId={session.id} />);

    const box = screen.getByLabelText(/^Send to Rocky \(blind/);
    expect(box).toHaveAttribute("placeholder", expect.stringMatching(/blind/i));

    fireEvent.change(box, { target: { value: "keep going" } });
    fireEvent.keyDown(box, { key: "Enter" });

    expect(commands.terminalWrite).toHaveBeenCalledWith(
      session.id,
      "\x1b[200~keep going\x1b[201~\r",
    );
    // The write is a promise; the acknowledgement lands with it.
    await vi.waitFor(() =>
      expect(useToastsStore.getState().items[0]?.message).toMatch(
        /not mirrored here/i,
      ),
    );
  });

  // …and the pane the user is actually watching says none of that.
  it("does not cry blind when the screen is right there", async () => {
    const { session } = seed();
    render(<PaneTree />);
    render(<LiveTerminal terminalId={session.id} />);

    const box = screen.getByLabelText("Send to Rocky");
    fireEvent.change(box, { target: { value: "run the tests" } });
    fireEvent.keyDown(box, { key: "Enter" });

    await vi.waitFor(() => expect(commands.terminalWrite).toHaveBeenCalled());
    expect(useToastsStore.getState().items).toEqual([]);
  });

  // Typing Japanese means typing a draft into the IME and pressing Enter to
  // accept it. That Enter is not a send, and a box that cannot tell the two
  // apart writes half a word into a live agent's PTY.
  it("does not send the Enter that accepts an IME candidate", () => {
    const { session } = seed();
    render(<PaneTree />);
    render(<LiveTerminal terminalId={session.id} />);

    const box = screen.getByLabelText("Send to Rocky");
    fireEvent.change(box, { target: { value: "テス" } });
    fireEvent.keyDown(box, { key: "Enter", isComposing: true });

    expect(commands.terminalWrite).not.toHaveBeenCalled();
    // …and the draft is untouched, so the composition can be finished.
    expect((box as HTMLInputElement).value).toBe("テス");

    // The Enter AFTER the candidate is committed is the one that sends.
    fireEvent.change(box, { target: { value: "テスト" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(commands.terminalWrite).toHaveBeenCalledWith(
      session.id,
      "\x1b[200~テスト\x1b[201~\r",
    );
  });

  // Rust keeps an exited session in its map, so the write lands in a dead
  // descriptor and succeeds. Asking first is the difference between a user who
  // knows nothing was read and one who is waiting for an answer.
  it("refuses a pane whose agent has exited, out loud", () => {
    const { session } = seed();
    render(<PaneTree />);
    act(() => useTerminalsStore.getState().setStatus(session.id, "complete"));
    render(<LiveTerminal terminalId={session.id} />);

    const box = screen.getByLabelText("Send to Rocky");
    fireEvent.change(box, { target: { value: "are you there" } });
    fireEvent.keyDown(box, { key: "Enter" });

    expect(commands.terminalWrite).not.toHaveBeenCalled();
    expect(useToastsStore.getState().items[0]?.message).toMatch(
      /has exited — restart it first/,
    );
  });
});

describe("the dock's portal invariant", () => {
  it("survives the Roc panel watching one of its panes", () => {
    const { session } = seed();
    const { container: dock } = render(<PaneTree />);
    const card = dock.querySelector<HTMLElement>(
      `[data-terminal-id="${session.id}"]`,
    )!;
    const term = xterm(session.id);
    expect(card.isConnected).toBe(true);

    const { unmount } = render(<LiveTerminal terminalId={session.id} />);
    act(() => term.paint(["still here"]));

    // Watched — and the card has not moved, been rebuilt, or been torn down.
    expect(dock.querySelector(`[data-terminal-id="${session.id}"]`)).toBe(card);
    expect(card.isConnected).toBe(true);
    expect(term.disposeCalls).toBe(0);
    expect(term.element).toBe(card.querySelector(".terminal-host"));

    // …and leaving the view is not the moment it breaks either.
    unmount();
    expect(dock.querySelector(`[data-terminal-id="${session.id}"]`)).toBe(card);
    expect(card.isConnected).toBe(true);
    expect(term.disposeCalls).toBe(0);
  });
});
