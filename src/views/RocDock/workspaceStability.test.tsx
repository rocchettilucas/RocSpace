/** Switching workspaces must never cost a pane its terminal.
 *
 *  This is `paneStability.test.tsx`'s invariant, asked of the other axis. A
 *  reshape moves a pane inside one workspace; a switch moves the whole dock to
 *  another workspace's tree — and for as long as the dock hosted only the
 *  ACTIVE workspace's cards, that switch unmounted every card of the one being
 *  left and mounted fresh ones for the one being entered.
 *
 *  A fresh mount is not a re-render. `useXterm` disposes the Terminal it built,
 *  and the replacement can only `clear()` and then `write()` the session's ring
 *  buffer back in — up to 2000 lines of RAW PTY BYTES. That is unsound for
 *  anything that addresses the cursor: an agent CLI's escape sequences were
 *  written against a screen state that no longer exists, so replayed into a
 *  blank grid they paint fragments of many historical frames over each other.
 *  The reported symptom was two renders of the same Claude line occupying the
 *  same cells — "ettmodelrtoiSonnet 5land…" sitting above the real text.
 *
 *  So the invariant is asserted the way the reshape one is: zero
 *  `Terminal.dispose()` calls, and — because a surviving pane's corruption
 *  comes from the replay rather than from the disposal — zero `clear()` /
 *  `write()` on a terminal that was already showing the session. */

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";

/** Stand-in for xterm.js: jsdom has no canvas, and what this file needs is
 *  instance lifetime plus every write the card asks for. */
const { FakeTerminal } = vi.hoisted(() => {
  const disposable = () => ({ dispose: () => {} });
  class FakeTerminal {
    disposeCalls = 0;
    clearCalls = 0;
    element: HTMLElement | null = null;
    options: Record<string, unknown>;
    buffer = { active: { getLine: () => null } };
    written: string[] = [];
    constructor(options: Record<string, unknown> = {}) {
      this.options = { ...options };
    }
    loadAddon() {}
    open(el: HTMLElement) {
      this.element = el;
    }
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
    clear() {
      this.clearCalls++;
    }
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

import type { TerminalOutputLine } from "@/lib/bindings";
import { newTerminal, newWorkspace } from "@/lib/factories";
import { buildBalancedTree } from "@/lib/paneTree";
import { clearTerminalRegistry, getTerminal } from "@/lib/terminalRegistry";
import { resetPaneAttachments } from "@/lib/paneAttachment";
import { useTerminalsStore, useUIStore, useWorkspacesStore } from "@/stores";
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
});

let seq = 0;
const line = (text: string): TerminalOutputLine => ({
  id: `l${seq++}`,
  ts: seq,
  stream: "stdout",
  text,
});

/** One workspace per entry, each holding `panes` sessions in a balanced tree.
 *  The first is active. Every session carries a line of history, so a card that
 *  remounts betrays itself by replaying it. */
function seedWorkspaces(shape: { name: string; panes: number }[]) {
  const workspaces = shape.map((w, order) => ({
    ...newWorkspace({ name: w.name, projectPath: `/tmp/${w.name}`, order }),
  }));
  const sessions = workspaces.flatMap((workspace, index) =>
    Array.from({ length: shape[index]!.panes }, (_, pane) => ({
      ...newTerminal({
        workspaceId: workspace.id,
        name: `${shape[index]!.name}${pane}`,
        agentType: "shell" as const,
        projectPath: workspace.projectPath ?? "",
      }),
      output: [line(`history of ${shape[index]!.name}${pane}`)],
    })),
  );
  useTerminalsStore.getState().setTerminals(sessions);
  useWorkspacesStore.setState({
    workspaces: workspaces.map((workspace) => ({
      ...workspace,
      paneTree: buildBalancedTree(
        sessions.filter((s) => s.workspaceId === workspace.id).map((s) => s.id),
      ),
    })),
    activeWorkspaceId: workspaces[0]!.id,
  });
  return {
    workspaceIds: workspaces.map((w) => w.id),
    idsOf: (name: string) =>
      sessions.filter((s) => s.name.startsWith(name)).map((s) => s.id),
  };
}

const xterm = (id: string) =>
  getTerminal(id) as unknown as InstanceType<typeof FakeTerminal>;

beforeEach(() => {
  clearTerminalRegistry();
  resetPaneAttachments();
  useWorkspacesStore.setState({ workspaces: [], activeWorkspaceId: null });
  useTerminalsStore.setState({ byId: {} });
  useUIStore.setState({ focusedTerminalId: null, maximizedTerminalId: null });
});

describe("workspace switch", () => {
  it("keeps the terminals of the workspace being left alive", () => {
    const { workspaceIds, idsOf } = seedWorkspaces([
      { name: "A", panes: 2 },
      { name: "B", panes: 2 },
    ]);
    const [, second] = workspaceIds as [string, string];
    const leaving = idsOf("A");

    render(<PaneTree />);
    const terms = leaving.map((id) => xterm(id));

    act(() => {
      useWorkspacesStore.getState().setActiveWorkspace(second);
    });

    for (const [index, term] of terms.entries()) {
      expect(term.disposeCalls, `terminal ${leaving[index]} was disposed`).toBe(
        0,
      );
    }
  });

  it("replays nothing into a pane that comes back into view", () => {
    // The corruption the user saw is the replay, not the disposal: raw TUI
    // bytes written into a grid they were not painted against.
    const { workspaceIds, idsOf } = seedWorkspaces([
      { name: "A", panes: 2 },
      { name: "B", panes: 2 },
    ]);
    const [first, second] = workspaceIds as [string, string];
    const [a0] = idsOf("A") as [string, string];

    const { container } = render(<PaneTree />);
    const cardFor = (id: string) =>
      container.querySelector<HTMLElement>(`[data-terminal-id="${id}"]`);

    const term = xterm(a0);
    const card = cardFor(a0)!;
    // The one legitimate replay: this card's first mount, against a session
    // that already had history.
    expect(term.written.join("")).toBe("history of A0");
    const writesAtMount = term.written.length;
    const clearsAtMount = term.clearCalls;

    act(() => {
      useWorkspacesStore.getState().setActiveWorkspace(second);
    });
    act(() => {
      useWorkspacesStore.getState().setActiveWorkspace(first);
    });

    expect(term.disposeCalls).toBe(0);
    expect(term.written.length, "the pane was replayed into").toBe(
      writesAtMount,
    );
    expect(term.clearCalls, "the pane was cleared").toBe(clearsAtMount);
    // …and it is the same live view, not a rebuilt one.
    expect(getTerminal(a0)).toBe(term);
    expect(cardFor(a0)).toBe(card);
    expect(card.isConnected).toBe(true);
  });

  it("keeps the terminals of a workspace that was never shown", () => {
    // Every workspace's panes are hosted, so entering one for the first time
    // is not a mount either — the dock built its terminal when the workspace
    // arrived, and the PTY has been drawing into it since.
    const { workspaceIds, idsOf } = seedWorkspaces([
      { name: "A", panes: 1 },
      { name: "B", panes: 1 },
    ]);
    const [, second] = workspaceIds as [string, string];
    const [b0] = idsOf("B") as [string];

    render(<PaneTree />);
    const term = xterm(b0);
    expect(term).toBeDefined();
    const writesAtMount = term.written.length;

    act(() => {
      useWorkspacesStore.getState().setActiveWorkspace(second);
    });

    expect(term.disposeCalls).toBe(0);
    expect(xterm(b0)).toBe(term);
    expect(term.written.length).toBe(writesAtMount);
  });

  it("keeps them alive through a workspace with no panes at all", () => {
    // The empty state used to replace the whole host, which took every card in
    // the app down with it — a harsher version of the same bug.
    const { workspaceIds, idsOf } = seedWorkspaces([
      { name: "A", panes: 2 },
      { name: "B", panes: 1 },
    ]);
    const [first, second] = workspaceIds as [string, string];
    const leaving = idsOf("A").map((id) => xterm(id));

    render(<PaneTree />);
    const terms = idsOf("A").map((id) => xterm(id));
    void leaving;

    act(() => {
      useWorkspacesStore.setState((s) => ({
        workspaces: s.workspaces.map((w) =>
          w.id === second ? { ...w, paneTree: null } : w,
        ),
      }));
      useWorkspacesStore.getState().setActiveWorkspace(second);
    });
    act(() => {
      useWorkspacesStore.getState().setActiveWorkspace(first);
    });

    for (const term of terms) expect(term.disposeCalls).toBe(0);
  });

  it("still disposes the terminals of a workspace that is closed", () => {
    // Hosting every workspace's cards must not turn a close into a leak: the
    // pane is gone from every tree, so its terminal has to go with it.
    const { workspaceIds, idsOf } = seedWorkspaces([
      { name: "A", panes: 1 },
      { name: "B", panes: 1 },
    ]);
    const [, second] = workspaceIds as [string, string];
    const [b0] = idsOf("B") as [string];

    render(<PaneTree />);
    const term = xterm(b0);

    act(() => {
      useWorkspacesStore.getState().closeWorkspace(second);
    });

    expect(term.disposeCalls).toBe(1);
    expect(getTerminal(b0)).toBeUndefined();
  });
});
