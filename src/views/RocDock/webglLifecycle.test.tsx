/** When a pane's GPU renderer is loaded and when it is let go.
 *
 *  Both ends have a cost that is invisible from the pane itself, so they are
 *  pinned here rather than left to whoever next edits the mount effect:
 *
 *   - a context on a *detached* canvas still counts against WebKit's per-process
 *     limit, and a card whose pane is hidden stays mounted — so a renderer has
 *     to follow the host's attachment rather than the card's lifetime;
 *   - disposing the addon before the terminal makes `addon-webgl` construct a
 *     whole DOM renderer for a terminal that is one line from gone (it checks
 *     xterm's own `_isDisposed` flag, which `Terminal.dispose()` sets before
 *     disposing its addons and an explicit dispose does not). */

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";

/** Records what the terminal is asked to do, in order. It disposes its loaded
 *  addons the way xterm's `AddonManager` does — one idempotent wrapper each,
 *  driven from `Terminal.dispose()` — so the ordering under test is the real
 *  one. */
const { FakeTerminal, ops } = vi.hoisted(() => {
  const ops: string[] = [];
  const disposable = () => ({ dispose: () => {} });
  class FakeTerminal {
    element: HTMLElement | null = null;
    options: Record<string, unknown>;
    buffer = { active: { getLine: () => null } };
    addons: { dispose: () => void }[] = [];
    constructor(options: Record<string, unknown> = {}) {
      this.options = { ...options };
    }
    loadAddon(addon: { dispose: () => void }) {
      const own = addon.dispose.bind(addon);
      let disposed = false;
      addon.dispose = () => {
        if (disposed) return;
        disposed = true;
        own();
      };
      this.addons.push(addon);
    }
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
    write() {}
    clear() {}
    dispose() {
      ops.push("terminal.dispose");
      for (const addon of [...this.addons].reverse()) addon.dispose();
    }
  }
  return { FakeTerminal, ops };
});

/** Stand-in for `WebglAddon`, which needs a GPU jsdom does not have. Its
 *  disposals land in the same log as the terminal's, which is where the
 *  ordering is read from. */
const { FakeWebglAddon } = vi.hoisted(() => {
  class FakeWebglAddon {
    static created = 0;
    static disposed = 0;
    constructor() {
      FakeWebglAddon.created++;
    }
    activate() {}
    dispose() {
      FakeWebglAddon.disposed++;
      ops.push("webgl.dispose");
    }
    onContextLoss() {
      return { dispose: () => {} };
    }
  }
  return { FakeWebglAddon };
});

vi.mock("@xterm/xterm", () => ({ Terminal: FakeTerminal }));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: FakeWebglAddon }));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    proposeDimensions() {
      return { cols: 80, rows: 24 };
    }
    fit() {}
    dispose() {}
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
import { resetPaneAttachments } from "@/lib/paneAttachment";
import type { PaneNode } from "@/lib/paneTree";
import { useTerminalsStore, useUIStore, useWorkspacesStore } from "@/stores";
import { PaneTree } from "@/views/RocDock/PaneTree";
import { useXterm } from "@/views/RocDock/useXterm";

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

function TerminalHost({ id }: { id: string }) {
  const { containerRef } = useXterm(id);
  return <div ref={containerRef} />;
}

/** A workspace whose sessions are named by the letters given, laid out by
 *  `shape`. Same seed as `paneStability.test.tsx` — this needs the real
 *  portal-hosted layout, which is where a hidden pane's card keeps running. */
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

/** Two workspaces of one pane each, the first active. The dock hosts both
 *  workspaces' cards, so this is the other way a card ends up mounted with
 *  nothing on screen to render into. */
function seedTwoWorkspaces() {
  const built = ["A", "B"].map((name, order) => {
    const workspace = newWorkspace({
      name,
      projectPath: `/tmp/${name}`,
      order,
    });
    const session = newTerminal({
      workspaceId: workspace.id,
      name,
      agentType: "shell",
      projectPath: `/tmp/${name}`,
    });
    return {
      workspace: {
        ...workspace,
        paneTree: { kind: "leaf", terminalId: session.id } as PaneNode,
      },
      session,
    };
  });
  useTerminalsStore.getState().setTerminals(built.map((b) => b.session));
  useWorkspacesStore.setState({
    workspaces: built.map((b) => b.workspace),
    activeWorkspaceId: built[0]!.workspace.id,
  });
  return built.map((b) => b.workspace.id) as [string, string];
}

const leaf = (terminalId: string): PaneNode => ({ kind: "leaf", terminalId });
const row = (first: PaneNode, second: PaneNode): PaneNode => ({
  kind: "split",
  direction: "row",
  ratio: 0.5,
  first,
  second,
});

beforeEach(() => {
  ops.length = 0;
  FakeWebglAddon.created = 0;
  FakeWebglAddon.disposed = 0;
  resetPaneAttachments();
  useWorkspacesStore.setState({ workspaces: [], activeWorkspaceId: null });
  useTerminalsStore.setState({ byId: {} });
  useUIStore.setState({ focusedTerminalId: null, maximizedTerminalId: null });
});

describe("the GPU renderer's lifetime", () => {
  it("loads the addon onto a freshly opened terminal", () => {
    render(<TerminalHost id="term-1" />);

    expect(FakeWebglAddon.created).toBe(1);
    expect(FakeWebglAddon.disposed).toBe(0);
  });

  it("leaves the addon for Terminal.dispose() to take down", () => {
    // Disposing it first is not just redundant: `addon-webgl` reads it as
    // "this terminal is staying" and builds a DOM renderer to hand rendering
    // back to — per closed pane, thrown away immediately.
    const view = render(<TerminalHost id="term-2" />);

    view.unmount();

    expect(ops).toEqual(["terminal.dispose", "webgl.dispose"]);
    expect(FakeWebglAddon.disposed).toBe(1);
  });

  it("does not load one for a card whose host is off screen", () => {
    // Nothing to render to, and a context taken now is one the visible panes
    // cannot have.
    const host = document.createElement("div");
    render(<TerminalHost id="term-3" />, { container: host });

    expect(FakeWebglAddon.created).toBe(0);
  });
});

describe("hidden panes", () => {
  it("gives up their renderers while another pane is maximized", () => {
    // Maximize renders one leaf full-bleed; the other cards stay mounted with
    // their hosts detached. WebKit allows a small fixed number of WebGL
    // contexts per process and force-loses the oldest to make room — so
    // fifteen panes idling on detached canvases can cost the one on screen its
    // renderer, permanently.
    const { ids } = seed(["A", "B"], ([a, b]) => row(leaf(a!), leaf(b!)));
    const [a] = ids as [string, string];

    render(<PaneTree />);
    expect(FakeWebglAddon.created).toBe(2);
    expect(FakeWebglAddon.disposed).toBe(0);

    act(() => {
      useUIStore.setState({ maximizedTerminalId: a });
    });

    expect(FakeWebglAddon.disposed).toBe(1);
  });

  it("take their renderers back when the layout shows them again", () => {
    const { ids } = seed(["A", "B"], ([a, b]) => row(leaf(a!), leaf(b!)));
    const [a] = ids as [string, string];

    render(<PaneTree />);
    act(() => {
      useUIStore.setState({ maximizedTerminalId: a });
    });
    act(() => {
      useUIStore.setState({ maximizedTerminalId: null });
    });

    expect(FakeWebglAddon.created).toBe(3);
    expect(FakeWebglAddon.disposed).toBe(1);
  });

  it("never gives a background workspace's panes one at all", () => {
    // Every workspace's cards are hosted, which is what stops a switch
    // disposing sixteen terminals. It must not also mean N × 16 GPU contexts:
    // only the workspace on screen has anything to render into, and the rest
    // would be spending a budget the visible panes need.
    seedTwoWorkspaces();

    render(<PaneTree />);

    expect(FakeWebglAddon.created).toBe(1);
    expect(FakeWebglAddon.disposed).toBe(0);
  });

  it("hands the renderer over on a workspace switch", () => {
    const [, second] = seedTwoWorkspaces();

    render(<PaneTree />);
    act(() => {
      useWorkspacesStore.getState().setActiveWorkspace(second);
    });

    // The pane leaving the screen gives its context up; the one arriving takes
    // one. Never both at once.
    expect(FakeWebglAddon.created).toBe(2);
    expect(FakeWebglAddon.disposed).toBe(1);
    // …and no terminal was torn down to make that happen: the renderer moved,
    // the panes did not.
    expect(ops).toEqual(["webgl.dispose"]);
  });

  it("keeps its renderer when a reshape only moves a pane", () => {
    // A reshape hands a card's host from one slot to the next inside a single
    // commit. That is not a detach, and rebuilding a GPU context for every
    // split and close would be a worse trade than the one this is fixing.
    const { workspaceId, ids } = seed(["A", "B", "C"], ([a, b, c]) =>
      row(leaf(a!), row(leaf(b!), leaf(c!))),
    );
    const [a] = ids as [string, string, string];

    render(<PaneTree />);
    expect(FakeWebglAddon.created).toBe(3);

    act(() => {
      useWorkspacesStore.getState().removeTerminalPane(workspaceId, a);
    });

    // Only the closed pane's, and only through its terminal's disposal.
    expect(FakeWebglAddon.created).toBe(3);
    expect(FakeWebglAddon.disposed).toBe(1);
  });
});
