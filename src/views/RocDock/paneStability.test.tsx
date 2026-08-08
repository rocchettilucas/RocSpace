/** Reshaping the dock must never cost a pane its terminal.
 *
 *  A split or a close rewrites the tree, which moves surviving leaves to new
 *  paths. If the renderer lets React unmount those subtrees, every surviving
 *  pane loses its xterm instance — and the replacement replays scrollback from
 *  the 2000-line ring buffer, which is not the same thing: an alt-screen TUI
 *  (vim, htop, the agent CLIs) paints into the alternate buffer, so its output
 *  is not in the ring at all and the pane comes back blank or garbled.
 *
 *  These tests assert the invariant directly — zero `Terminal.dispose()` calls
 *  for panes that survived, and the same DOM node afterwards — rather than
 *  asserting the mechanism, so the renderer stays free to change how it holds
 *  the cards still. */

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";

/** Stand-in for xterm.js: the real one needs a canvas and measures nothing in
 *  jsdom, and all this file cares about is instance lifetime. */
const { FakeTerminal } = vi.hoisted(() => {
  const disposable = () => ({ dispose: () => {} });
  class FakeTerminal {
    disposeCalls = 0;
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

import { newTerminal, newWorkspace } from "@/lib/factories";
import { getTerminal } from "@/lib/terminalRegistry";
import type { PaneNode } from "@/lib/paneTree";
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

const leaf = (terminalId: string): PaneNode => ({ kind: "leaf", terminalId });
const row = (first: PaneNode, second: PaneNode): PaneNode => ({
  kind: "split",
  direction: "row",
  ratio: 0.5,
  first,
  second,
});

/** One workspace whose sessions are named by the letters given, plus a tree
 *  built by `shape` over those ids. Returns the ids in the order asked for. */
function seed(names: string[], shape: (ids: string[]) => PaneNode) {
  const workspace = newWorkspace({ projectPath: "/tmp/proj", order: 0 });
  const sessions = names.map((name) =>
    newTerminal({
      workspaceId: workspace.id,
      name,
      agentType: "shell",
      projectPath: "/tmp/proj",
    }),
  );
  const ids = sessions.map((s) => s.id);
  useTerminalsStore.getState().setTerminals(sessions);
  useWorkspacesStore.setState({
    workspaces: [{ ...workspace, paneTree: shape(ids) }],
    activeWorkspaceId: workspace.id,
  });
  return { workspaceId: workspace.id, ids };
}

const xterm = (id: string) =>
  getTerminal(id) as unknown as InstanceType<typeof FakeTerminal>;

beforeEach(() => {
  useWorkspacesStore.setState({ workspaces: [], activeWorkspaceId: null });
  useTerminalsStore.setState({ byId: {} });
  useUIStore.setState({ focusedTerminalId: null, maximizedTerminalId: null });
});

describe("pane reshape", () => {
  it("keeps every surviving pane's terminal alive when one is closed", () => {
    // row(a, row(b, c)) — closing `a` promotes the inner split into the root's
    // position, which moves BOTH survivors to a new path.
    const { workspaceId, ids } = seed(["A", "B", "C"], ([a, b, c]) =>
      row(leaf(a!), row(leaf(b!), leaf(c!))),
    );
    const [a, b, c] = ids as [string, string, string];

    const { container } = render(<PaneTree />);
    const cardFor = (id: string) =>
      container.querySelector<HTMLElement>(`[data-terminal-id="${id}"]`);

    const termB = xterm(b);
    const termC = xterm(c);
    const cardB = cardFor(b)!;
    const cardC = cardFor(c)!;
    const panelBBefore = cardB.closest("[data-panel]");
    expect(termB).toBeDefined();
    expect(cardB).toBeTruthy();

    act(() => {
      useWorkspacesStore.getState().removeTerminalPane(workspaceId, a);
    });

    // The invariant: the survivors' terminals were never torn down.
    expect(termB.disposeCalls).toBe(0);
    expect(termC.disposeCalls).toBe(0);
    // …and their cards are the same DOM nodes, moved rather than rebuilt.
    expect(cardFor(b)).toBe(cardB);
    expect(cardFor(c)).toBe(cardC);
    expect(cardB.isConnected).toBe(true);
    expect(cardC.isConnected).toBe(true);
    // Proof the move actually happened: `b` now lives under a different panel.
    expect(cardB.closest("[data-panel]")).not.toBe(panelBBefore);
    // The closed pane's terminal, by contrast, is gone for good.
    expect(cardFor(a)).toBeNull();
  });

  it("keeps every pane's terminal alive when a leaf becomes a split", () => {
    const { workspaceId, ids } = seed(["A", "B", "C"], ([a, b, c]) =>
      row(leaf(a!), row(leaf(b!), leaf(c!))),
    );
    const [a, b, c] = ids as [string, string, string];

    const { container } = render(<PaneTree />);
    const cardFor = (id: string) =>
      container.querySelector<HTMLElement>(`[data-terminal-id="${id}"]`);

    const before = [a, b, c].map((id) => ({
      id,
      term: xterm(id),
      card: cardFor(id)!,
    }));

    const fresh = newTerminal({
      workspaceId,
      name: "D",
      agentType: "shell",
      projectPath: "/tmp/proj",
    });
    act(() => {
      useTerminalsStore.getState().addTerminal(fresh);
      // `c` is a leaf today; splitting it turns that node into a split, which
      // is the reconciliation cliff — the leaf's subtree is replaced wholesale.
      useWorkspacesStore
        .getState()
        .splitTerminalPane(workspaceId, c, "column", fresh.id);
    });

    for (const { id, term, card } of before) {
      expect(term.disposeCalls, `terminal ${id} was disposed`).toBe(0);
      expect(cardFor(id), `card ${id} was rebuilt`).toBe(card);
    }
    expect(cardFor(fresh.id)).toBeTruthy();
  });

  it("keeps hidden panes' terminals alive across a maximize round trip", () => {
    // Maximize renders one leaf full-bleed. The others leave the layout, but
    // their PTYs keep running — dropping their xterms would lose everything
    // they printed while hidden.
    const { ids } = seed(["A", "B"], ([a, b]) => row(leaf(a!), leaf(b!)));
    const [a, b] = ids as [string, string];

    const { container } = render(<PaneTree />);
    const cardFor = (id: string) =>
      container.querySelector<HTMLElement>(`[data-terminal-id="${id}"]`);

    const termA = xterm(a);
    const termB = xterm(b);
    const cardB = cardFor(b)!;

    act(() => {
      useUIStore.setState({ maximizedTerminalId: a });
    });
    act(() => {
      useUIStore.setState({ maximizedTerminalId: null });
    });

    expect(termA.disposeCalls).toBe(0);
    expect(termB.disposeCalls).toBe(0);
    expect(cardFor(b)).toBe(cardB);
  });
});
