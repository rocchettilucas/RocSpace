import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { terminalKill } = vi.hoisted(() => ({
  terminalKill: vi.fn(async () => {}),
}));

vi.mock("@/lib/bindings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/bindings")>()),
  commands: { terminalKill },
}));

import { ROC_NAMES } from "@/lib/agentLabels";
import { WORKSPACE_ACCENTS } from "@/lib/accentColors";
import { newTerminal, newWorkspace } from "@/lib/factories";
import { MIN_PANE_RATIO, leafIds, type PaneNode } from "@/lib/paneTree";
import { getRecents, seedRecents } from "@/lib/recents";
import { useSettingsStore, DEFAULT_AGENT_DEFAULTS } from "@/stores/settings";
import { useTerminalsStore } from "@/stores/terminals";
import { useUIStore } from "@/stores/ui";
import { setWorkspaceSpawner, useWorkspacesStore } from "@/stores/workspaces";
import type { TerminalSession } from "@/lib/bindings";

const store = () => useWorkspacesStore.getState();
const terminals = () => useTerminalsStore.getState();
const ui = () => useUIStore.getState();

let spawned: TerminalSession[] = [];
let restoreSpawner: () => void = () => {};

beforeEach(() => {
  vi.clearAllMocks();
  useWorkspacesStore.setState({ workspaces: [], activeWorkspaceId: null });
  useTerminalsStore.setState({ byId: {} });
  useUIStore.setState({
    focusedTerminalId: null,
    maximizedTerminalId: null,
    mainView: "terminals",
  });
  useSettingsStore.setState({ agentDefaults: { ...DEFAULT_AGENT_DEFAULTS } });
  seedRecents([]);
  spawned = [];
  restoreSpawner = setWorkspaceSpawner((session) => spawned.push(session));
});

afterEach(() => {
  restoreSpawner();
});

const sessionsOf = (workspaceId: string) =>
  Object.values(terminals().byId).filter((t) => t.workspaceId === workspaceId);

describe("createWorkspace", () => {
  it("builds the sessions, the tree and the spawns in one go", () => {
    const id = store().createWorkspace({
      projectPath: "/tmp/proj",
      paneCount: 4,
      agentTypes: ["claude-code"],
    });

    const workspace = store().workspaces[0]!;
    expect(workspace.id).toBe(id);
    expect(store().activeWorkspaceId).toBe(id);
    expect(sessionsOf(id)).toHaveLength(4);
    // Balanced, not a chain: four panes read as a 2×2.
    expect(leafIds(workspace.paneTree!)).toEqual(
      sessionsOf(id).map((t) => t.id),
    );
    expect(workspace.paneTree).toMatchObject({
      direction: "row",
      first: { kind: "split", direction: "column" },
    });
    // Every pane gets a PTY, and every one of them is a session the store
    // already holds — a spawn reporting a pid back at a session that is not
    // there yet would drop it.
    expect(spawned.map((s) => s.id)).toEqual(sessionsOf(id).map((t) => t.id));
  });

  it("names itself after the project directory, and its panes from the pool", () => {
    const id = store().createWorkspace({
      projectPath: "/Users/roc/code/rocspace",
      paneCount: 2,
      agentTypes: [],
    });

    expect(store().workspaces[0]!.name).toBe("rocspace");
    expect(sessionsOf(id).map((t) => t.name)).toEqual(ROC_NAMES.slice(0, 2));
  });

  it("starts every workspace's names at the head of the pool", () => {
    // Names are the user's handle for a pane *in the dock they are looking at*,
    // so a second workspace opening on "Rocky 5" would be nonsense.
    const a = store().createWorkspace({
      projectPath: "/a",
      paneCount: 2,
      agentTypes: [],
    });
    const b = store().createWorkspace({
      projectPath: "/b",
      paneCount: 2,
      agentTypes: [],
    });

    expect(sessionsOf(a).map((t) => t.name)).toEqual(ROC_NAMES.slice(0, 2));
    expect(sessionsOf(b).map((t) => t.name)).toEqual(ROC_NAMES.slice(0, 2));
  });

  it("falls back to a numbered name when there is no directory", () => {
    store().createWorkspace({
      projectPath: null,
      paneCount: 1,
      agentTypes: [],
    });
    store().createWorkspace({
      projectPath: null,
      paneCount: 1,
      agentTypes: [],
    });

    expect(store().workspaces.map((w) => w.name)).toEqual([
      "Workspace 1",
      "Workspace 2",
    ]);
  });

  it("honours an explicit name over the directory tail", () => {
    store().createWorkspace({
      name: "  Client work  ",
      projectPath: "/tmp/proj",
      paneCount: 1,
      agentTypes: [],
    });

    expect(store().workspaces[0]!.name).toBe("Client work");
  });

  it("hands out the six slots in order, then wraps once they are all taken", () => {
    for (let i = 0; i < WORKSPACE_ACCENTS.length + 1; i++) {
      store().createWorkspace({
        projectPath: null,
        paneCount: 1,
        agentTypes: [],
      });
    }

    expect(store().workspaces.map((w) => w.accent)).toEqual([
      ...WORKSPACE_ACCENTS,
      WORKSPACE_ACCENTS[0],
    ]);
  });

  it("reuses the accent a closed workspace freed", () => {
    // Deriving the accent from the list *length* collides the moment anything
    // is closed: four workspaces minus the second leaves three, so the next
    // create asks for slot 3 again — a second amber, and cyan never reused.
    const ids = [0, 1, 2, 3].map(() =>
      store().createWorkspace({
        projectPath: null,
        paneCount: 1,
        agentTypes: [],
      }),
    );
    expect(store().workspaces.map((w) => w.accent)).toEqual([
      "violet",
      "cyan",
      "green",
      "amber",
    ]);

    store().closeWorkspace(ids[1]!);
    store().createWorkspace({
      projectPath: null,
      paneCount: 1,
      agentTypes: [],
    });

    expect(store().workspaces.map((w) => w.accent)).toEqual([
      "violet",
      "green",
      "amber",
      "cyan",
    ]);
  });

  it("cycles the chosen agent types across the panes", () => {
    const id = store().createWorkspace({
      projectPath: "/tmp/proj",
      paneCount: 4,
      agentTypes: ["claude-code", "shell"],
    });

    expect(sessionsOf(id).map((t) => t.agentConfig.type)).toEqual([
      "claude-code",
      "shell",
      "claude-code",
      "shell",
    ]);
  });

  it("falls back to the settings default when no agents are chosen", () => {
    useSettingsStore.setState({
      agentDefaults: { ...DEFAULT_AGENT_DEFAULTS, agentType: "codex" },
    });

    const id = store().createWorkspace({
      projectPath: "/tmp/proj",
      paneCount: 2,
      agentTypes: [],
    });

    expect(sessionsOf(id).map((t) => t.agentConfig.type)).toEqual([
      "codex",
      "codex",
    ]);
  });

  it("focuses its first pane, so the next chord has a target", () => {
    const id = store().createWorkspace({
      projectPath: "/tmp/proj",
      paneCount: 2,
      agentTypes: [],
    });

    expect(store().workspaces[0]!.focusedTerminalId).toBe(
      sessionsOf(id)[0]!.id,
    );
  });

  it("remembers the directory for the next time the modal opens", () => {
    store().createWorkspace({
      projectPath: "/tmp/proj",
      paneCount: 1,
      agentTypes: [],
    });

    expect(getRecents().map((r) => r.path)).toEqual(["/tmp/proj"]);
  });

  it("remembers nothing for a workspace with no directory", () => {
    store().createWorkspace({
      projectPath: null,
      paneCount: 1,
      agentTypes: [],
    });

    expect(getRecents()).toEqual([]);
  });

  it("spawns panes into the cwd-less spawn Rust understands", () => {
    const id = store().createWorkspace({
      projectPath: null,
      paneCount: 1,
      agentTypes: [],
    });

    expect(sessionsOf(id)[0]!.projectPath).toBe("");
  });
});

describe("closeWorkspace", () => {
  /** Two workspaces, each with `count` panes. Returns their ids in order. */
  function seedTwo(count = 2): [string, string] {
    const a = store().createWorkspace({
      projectPath: "/a",
      paneCount: count as 1 | 2,
      agentTypes: [],
    });
    const b = store().createWorkspace({
      projectPath: "/b",
      paneCount: count as 1 | 2,
      agentTypes: [],
    });
    return [a, b];
  }

  it("kills its PTYs and forgets its sessions", () => {
    const [a, b] = seedTwo();
    const doomed = sessionsOf(a).map((t) => t.id);

    store().closeWorkspace(a);

    for (const id of doomed) {
      expect(terminalKill).toHaveBeenCalledWith(id);
      expect(terminals().byId[id]).toBeUndefined();
    }
    // …and leaves the other workspace's panes running.
    expect(sessionsOf(b)).toHaveLength(2);
  });

  it("hands active to the neighbour that slid into its place", () => {
    const [a, b] = seedTwo();
    store().setActiveWorkspace(a);

    store().closeWorkspace(a);

    expect(store().activeWorkspaceId).toBe(b);
  });

  it("falls back to the one before when the last row goes", () => {
    const [a, b] = seedTwo();
    store().setActiveWorkspace(b);

    store().closeWorkspace(b);

    expect(store().activeWorkspaceId).toBe(a);
  });

  it("leaves the empty state when the only workspace goes", () => {
    const [a, b] = seedTwo();
    store().closeWorkspace(a);
    store().closeWorkspace(b);

    expect(store().workspaces).toEqual([]);
    expect(store().activeWorkspaceId).toBeNull();
    expect(terminals().byId).toEqual({});
  });

  it("does not move active when a background workspace closes", () => {
    const [a, b] = seedTwo();
    store().setActiveWorkspace(b);

    store().closeWorkspace(a);

    expect(store().activeWorkspaceId).toBe(b);
  });

  it("takes the focus and the maximize off the panes it just deleted", () => {
    // Both are app-wide ids, not workspace ones: left pointing at a session
    // that no longer exists, RocTalk writes into a dead PTY and the dock tries
    // to maximize a pane with nothing behind it.
    const [a, b] = seedTwo();
    store().setActiveWorkspace(a);
    const doomed = sessionsOf(a)[1]!.id;
    ui().maximizeTerminal(doomed);
    expect(ui().focusedTerminalId).toBe(doomed);

    store().closeWorkspace(a);

    expect(ui().maximizedTerminalId).toBeNull();
    // Resynced from whatever is active now, which is the neighbour's own
    // remembered pane rather than nothing.
    expect(ui().focusedTerminalId).toBe(sessionsOf(b)[0]!.id);
  });

  // …and nothing on the main view either. RocPlan, Roc and RocMind are all
  // drawn by `AppShell`, which `App` stops rendering when the last workspace
  // goes — and the chords that move `mainView` back (⌘⇧P, ⌘⇧R, ⌘⇧M) are inside
  // the shell with them. Left as it was, the flag sat pointing at a surface
  // nothing could draw until the next ⌘T, which opened the brand new workspace
  // onto the board instead of onto its panes.
  it("leaves the empty state on the terminals, not on a surface that is gone", () => {
    const [a, b] = seedTwo();
    ui().setMainView("rocplan");

    store().closeWorkspace(a);
    // One workspace left: the board is the neighbour's board, which is exactly
    // where the user was.
    expect(ui().mainView).toBe("rocplan");

    store().closeWorkspace(b);
    expect(ui().mainView).toBe("terminals");
  });

  it("leaves the empty state with nothing focused or maximized", () => {
    const [a, b] = seedTwo();
    store().setActiveWorkspace(b);
    ui().maximizeTerminal(sessionsOf(b)[0]!.id);

    store().closeWorkspace(a);
    store().closeWorkspace(b);

    expect(ui().focusedTerminalId).toBeNull();
    expect(ui().maximizedTerminalId).toBeNull();
  });

  it("does not disturb the focus when a background workspace closes", () => {
    const [a, b] = seedTwo();
    store().setActiveWorkspace(b);
    const focused = ui().focusedTerminalId;
    expect(focused).toBe(sessionsOf(b)[0]!.id);

    store().closeWorkspace(a);

    expect(ui().focusedTerminalId).toBe(focused);
  });

  it("ignores an id it does not hold", () => {
    const [a] = seedTwo();
    store().closeWorkspace("ghost");
    expect(store().workspaces).toHaveLength(2);
    expect(store().activeWorkspaceId).not.toBeNull();
    expect(a).toBeTruthy();
  });
});

describe("workspace list management", () => {
  function seedNamed(names: string[]): string[] {
    const workspaces = names.map((name, i) =>
      newWorkspace({ name, projectPath: null, order: i }),
    );
    useWorkspacesStore.setState({
      workspaces,
      activeWorkspaceId: workspaces[0]?.id ?? null,
    });
    return workspaces.map((w) => w.id);
  }

  it("renames, and refuses a blank name", () => {
    const [id] = seedNamed(["Alpha"]);

    store().renameWorkspace(id!, "  Beta  ");
    expect(store().workspaces[0]!.name).toBe("Beta");

    // A row with no name cannot be addressed, so an empty commit reads as a
    // cancel rather than as a valid new name.
    store().renameWorkspace(id!, "   ");
    expect(store().workspaces[0]!.name).toBe("Beta");
  });

  it("sets an accent", () => {
    const [id] = seedNamed(["Alpha"]);
    store().setWorkspaceAccent(id!, "rose");
    expect(store().workspaces[0]!.accent).toBe("rose");
  });

  it("reorders remove-then-insert, in both directions", () => {
    // The contract the sidebar's drag handler is written against: the row
    // leaves `from` first, so `to` addresses the shortened list. Read the other
    // way (insert before whoever sits at `to` now) every forward drag lands one
    // place short.
    const names = () => store().workspaces.map((w) => w.name);
    seedNamed(["A", "B", "C"]);

    store().reorderWorkspace(0, 2);
    expect(names()).toEqual(["B", "C", "A"]);

    store().reorderWorkspace(2, 0);
    expect(names()).toEqual(["A", "B", "C"]);

    // A one-step drag passes exactly one neighbour, in either direction.
    store().reorderWorkspace(1, 0);
    expect(names()).toEqual(["B", "A", "C"]);
    store().reorderWorkspace(0, 1);
    expect(names()).toEqual(["A", "B", "C"]);
  });

  it("reorders without disturbing which one is active", () => {
    const ids = seedNamed(["A", "B", "C"]);
    store().setActiveWorkspace(ids[0]!);

    store().reorderWorkspace(0, 2);

    expect(store().workspaces.map((w) => w.name)).toEqual(["B", "C", "A"]);
    expect(store().activeWorkspaceId).toBe(ids[0]);
  });

  it("clamps a drop past the end and ignores a no-op drag", () => {
    seedNamed(["A", "B", "C"]);

    store().reorderWorkspace(0, 99);
    expect(store().workspaces.map((w) => w.name)).toEqual(["B", "C", "A"]);

    const before = store().workspaces;
    store().reorderWorkspace(1, 1);
    expect(store().workspaces).toBe(before);
    store().reorderWorkspace(7, 0);
    expect(store().workspaces).toBe(before);
  });

  it("setActiveWorkspace ignores an id the list does not hold", () => {
    const ids = seedNamed(["A", "B"]);
    store().setActiveWorkspace("ghost");
    expect(store().activeWorkspaceId).toBe(ids[0]);
  });

  it("setWorkspaces keeps an active id the list holds, repairs one it does not", () => {
    const ids = seedNamed(["A", "B"]);
    const list = store().workspaces;

    store().setWorkspaces(list, ids[1]!);
    expect(store().activeWorkspaceId).toBe(ids[1]);

    // A snapshot naming a workspace whose entry failed validation must not
    // leave the app with an active id nothing answers to.
    store().setWorkspaces(list, "vanished");
    expect(store().activeWorkspaceId).toBe(ids[0]);

    store().setWorkspaces([], null);
    expect(store().activeWorkspaceId).toBeNull();
  });
});

describe("focus follows the workspace", () => {
  /** Two workspaces, each already remembering a pane, A active and focused. */
  function seedFocused(): [string, string] {
    const a = {
      ...newWorkspace({ name: "A", projectPath: null, order: 0 }),
      focusedTerminalId: "a1",
    };
    const b = {
      ...newWorkspace({ name: "B", projectPath: null, order: 1 }),
      focusedTerminalId: "b1",
    };
    useWorkspacesStore.setState({
      workspaces: [a, b],
      activeWorkspaceId: a.id,
    });
    useUIStore.setState({ focusedTerminalId: "a1" });
    return [a.id, b.id];
  }

  it("puts the app-wide focus back on the pane the workspace was left on", () => {
    // The whole point of storing `focusedTerminalId` per workspace. Without the
    // restore the Inspector sits on a pane that is no longer rendered and
    // RocTalk dictates into the background workspace's PTY.
    const [a, b] = seedFocused();

    store().setActiveWorkspace(b);
    expect(ui().focusedTerminalId).toBe("b1");
    // …and the one we left keeps its own memory, for the trip back.
    expect(store().workspaces.find((w) => w.id === a)!.focusedTerminalId).toBe(
      "a1",
    );

    store().setActiveWorkspace(a);
    expect(ui().focusedTerminalId).toBe("a1");
    expect(store().workspaces.find((w) => w.id === b)!.focusedTerminalId).toBe(
      "b1",
    );
  });

  it("clears the app-wide focus for a workspace that remembers none", () => {
    const [, b] = seedFocused();
    store().setFocusedTerminal(b, null);

    store().setActiveWorkspace(b);

    expect(ui().focusedTerminalId).toBeNull();
  });

  it("leaves the focus alone for an id the list does not hold", () => {
    seedFocused();

    store().setActiveWorkspace("ghost");

    expect(ui().focusedTerminalId).toBe("a1");
  });

  it("focuses the first pane of a workspace it has just created", () => {
    // A create is a switch: it makes the new workspace active, so leaving the
    // app-wide focus on the previous workspace's pane is the same bug.
    seedFocused();

    const fresh = store().createWorkspace({
      projectPath: "/tmp/proj",
      paneCount: 2,
      agentTypes: [],
    });

    expect(ui().focusedTerminalId).toBe(sessionsOf(fresh)[0]!.id);
  });
});

describe("pane tree", () => {
  /** One workspace whose tree already holds `ids`, and its id. */
  function seed(ids: string[]): string {
    const workspace = newWorkspace({ name: "W", projectPath: null, order: 0 });
    useWorkspacesStore.setState({
      workspaces: [workspace],
      activeWorkspaceId: workspace.id,
    });
    store().ensurePaneTree(workspace.id, ids);
    return workspace.id;
  }

  const treeOf = (id: string): PaneNode | null =>
    store().workspaces.find((w) => w.id === id)!.paneTree;

  it("splitTerminalPane inserts the new pane right after its target", () => {
    const id = seed(["a", "b"]);

    store().splitTerminalPane(id, "a", "column", "c");

    expect(leafIds(treeOf(id)!)).toEqual(["a", "c", "b"]);
    expect(treeOf(id)).toMatchObject({
      first: { kind: "split", direction: "column" },
    });
  });

  it("splitTerminalPane seeds a tree from nothing", () => {
    const workspace = newWorkspace({ name: "W", projectPath: null, order: 0 });
    useWorkspacesStore.setState({
      workspaces: [workspace],
      activeWorkspaceId: workspace.id,
    });
    expect(workspace.paneTree).toBeNull();

    store().splitTerminalPane(workspace.id, "a", "row", "b");

    expect(leafIds(treeOf(workspace.id)!)).toEqual(["a", "b"]);
  });

  it("splitTerminalPane still places the new pane when the target is missing", () => {
    // The split target can be absent if a session was created while the tree
    // was stale. The new terminal is spawning a PTY regardless, so it has to
    // end up somewhere reachable rather than being silently dropped.
    const id = seed(["a", "b"]);

    store().splitTerminalPane(id, "ghost", "row", "c");

    expect(leafIds(treeOf(id)!)).toEqual(["a", "b", "c"]);
  });

  it("splitTerminalPane will not give one terminal a second pane", () => {
    // Two leaves for one id means two xterms over a single PTY. The
    // missing-target branch above is where this could slip through: it appends
    // the new pane without ever checking whether it is already in the tree.
    const id = seed(["a", "b"]);

    store().splitTerminalPane(id, "a", "row", "b");
    expect(leafIds(treeOf(id)!)).toEqual(["a", "b"]);

    store().splitTerminalPane(id, "ghost", "row", "b");
    expect(leafIds(treeOf(id)!)).toEqual(["a", "b"]);
  });

  it("removeTerminalPane promotes the sibling and empties out at the last pane", () => {
    const id = seed(["a", "b"]);

    store().removeTerminalPane(id, "a");
    expect(treeOf(id)).toEqual({ kind: "leaf", terminalId: "b" });

    store().removeTerminalPane(id, "b");
    expect(treeOf(id)).toBeNull();
  });

  it("removeTerminalPane ignores an id the tree does not hold", () => {
    const id = seed(["a", "b"]);
    const before = treeOf(id);

    store().removeTerminalPane(id, "ghost");

    expect(treeOf(id)).toBe(before);
  });

  it("setPaneRatio commits a drag, clamped, without bumping updatedAt", () => {
    const id = seed(["a", "b"]);
    const updatedAt = store().workspaces[0]!.updatedAt;

    store().setPaneRatio(id, "", 0.72);
    expect(treeOf(id)).toMatchObject({ ratio: 0.72 });

    store().setPaneRatio(id, "", 0.01);
    expect(treeOf(id)).toMatchObject({ ratio: MIN_PANE_RATIO });

    // Drag traffic must not mark the workspace dirty on every frame — the store
    // subscription already debounces the save.
    expect(store().workspaces[0]!.updatedAt).toBe(updatedAt);
  });

  it("setPaneRatio on a stale path leaves the tree identical", () => {
    const id = seed(["a", "b"]);
    const before = treeOf(id);

    store().setPaneRatio(id, "ffs", 0.3);

    expect(treeOf(id)).toBe(before);
  });

  it("ensurePaneTree builds a balanced tree when there is none", () => {
    const id = seed(["a", "b", "c", "d"]);

    expect(leafIds(treeOf(id)!)).toEqual(["a", "b", "c", "d"]);
    // Balanced, not a chain: 4 panes read as a 2×2.
    expect(treeOf(id)).toMatchObject({
      direction: "row",
      first: { kind: "split", direction: "column" },
      second: { kind: "split", direction: "column" },
    });
  });

  it("ensurePaneTree leaves a matching tree — and its ratios — untouched", () => {
    const id = seed(["a", "b"]);
    store().setPaneRatio(id, "", 0.8);
    const before = treeOf(id);

    // Same set, different order: the tree already describes what exists.
    store().ensurePaneTree(id, ["b", "a"]);

    expect(treeOf(id)).toBe(before);
    expect(treeOf(id)).toMatchObject({ ratio: 0.8 });
  });

  it("ensurePaneTree rebuilds when the live sessions have drifted", () => {
    const id = seed(["a", "b"]);

    store().ensurePaneTree(id, ["a", "b", "c"]);
    expect(leafIds(treeOf(id)!)).toEqual(["a", "b", "c"]);

    store().ensurePaneTree(id, ["a"]);
    expect(treeOf(id)).toEqual({ kind: "leaf", terminalId: "a" });

    store().ensurePaneTree(id, []);
    expect(treeOf(id)).toBeNull();
  });

  it("leaves other workspaces alone", () => {
    const a = newWorkspace({ name: "A", projectPath: null, order: 0 });
    const b = newWorkspace({ name: "B", projectPath: null, order: 1 });
    useWorkspacesStore.setState({
      workspaces: [a, b],
      activeWorkspaceId: a.id,
    });

    store().ensurePaneTree(a.id, ["t1", "t2"]);

    expect(store().workspaces[1]!.paneTree).toBeNull();
  });

  it("setFocusedTerminal records a pane per workspace", () => {
    const a = newWorkspace({ name: "A", projectPath: null, order: 0 });
    const b = newWorkspace({ name: "B", projectPath: null, order: 1 });
    useWorkspacesStore.setState({
      workspaces: [a, b],
      activeWorkspaceId: a.id,
    });

    store().setFocusedTerminal(a.id, "t1");
    store().setFocusedTerminal(b.id, "t9");

    expect(store().workspaces[0]!.focusedTerminalId).toBe("t1");
    expect(store().workspaces[1]!.focusedTerminalId).toBe("t9");
  });
});

describe("background workspaces", () => {
  it("keeps a hidden workspace's sessions in the store", () => {
    // Hibernation is deliberately absent: a background workspace's PTYs keep
    // running and the output queue keeps draining them into their ring
    // buffers, so switching back replays rather than restarts.
    const a = store().createWorkspace({
      projectPath: "/a",
      paneCount: 2,
      agentTypes: [],
    });
    const b = store().createWorkspace({
      projectPath: "/b",
      paneCount: 2,
      agentTypes: [],
    });

    store().setActiveWorkspace(b);

    expect(sessionsOf(a)).toHaveLength(2);
    expect(terminalKill).not.toHaveBeenCalled();
  });

  it("a session added by hand still belongs to its own workspace", () => {
    const a = store().createWorkspace({
      projectPath: "/a",
      paneCount: 1,
      agentTypes: [],
    });
    const b = store().createWorkspace({
      projectPath: "/b",
      paneCount: 1,
      agentTypes: [],
    });
    terminals().addTerminal(
      newTerminal({
        workspaceId: a,
        name: "extra",
        agentType: "shell",
        projectPath: "/a",
      }),
    );

    expect(sessionsOf(a)).toHaveLength(2);
    expect(sessionsOf(b)).toHaveLength(1);
  });
});
