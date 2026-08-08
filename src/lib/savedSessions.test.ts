/** Saving a workspace and getting it back: what survives, what is minted
 *  fresh, and the one invariant that ties them together — the restored pane
 *  tree names the restored sessions. */

import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import { newTerminal, newWorkspace } from "@/lib/factories";
import { leafIds, type PaneNode } from "@/lib/paneTree";
import {
  parseSavedSession,
  remapPaneTree,
  restoreSavedSession,
  serializeWorkspace,
  sessionSlug,
  type SavedSessionPayload,
} from "@/lib/savedSessions";
import { useHistoryStore } from "@/stores/history";
import { useSavedSessionsStore } from "@/stores/savedSessions";
import { useTerminalsStore } from "@/stores/terminals";
import { useTerminalRuntimeStore } from "@/stores/terminalRuntime";
import { useWorkspacesStore } from "@/stores/workspaces";
import type { AgentType, TerminalSession } from "@/lib/bindings";

/** A workspace with `agents.length` panes, wired into both stores the way the
 *  app would have left it. Returns the workspace id and its sessions. */
function seedWorkspace(
  agents: AgentType[],
  claudeSessionIds: (string | null)[] = [],
) {
  const workspace = newWorkspace({
    name: "rocspace",
    projectPath: "/code/rocspace",
    order: 0,
  });
  const sessions: TerminalSession[] = agents.map((agentType, i) => ({
    ...newTerminal({
      workspaceId: workspace.id,
      name: `Pane ${i + 1}`,
      agentType,
      projectPath: "/code/rocspace",
      taskPrompt: `task ${i + 1}`,
    }),
    claudeSessionId: claudeSessionIds[i] ?? null,
  }));
  workspace.paneTree = {
    kind: "split",
    direction: "row",
    ratio: 0.3,
    first: { kind: "leaf", terminalId: sessions[0]!.id },
    second: { kind: "leaf", terminalId: sessions[1]!.id },
  };
  useWorkspacesStore.setState({
    workspaces: [workspace],
    activeWorkspaceId: workspace.id,
  });
  useTerminalsStore.getState().setTerminals(sessions);
  return { workspace, sessions };
}

beforeEach(() => {
  invoke.mockReset();
  useWorkspacesStore.setState({ workspaces: [], activeWorkspaceId: null });
  useTerminalsStore.setState({ byId: {} });
  useTerminalRuntimeStore.setState({
    hasUserInput: {},
    configDirty: {},
    resumableClaudeSessions: {},
  });
  useSavedSessionsStore.setState({ sessions: [], loaded: false, error: null });
});

describe("sessionSlug", () => {
  // Mirrors `sessions::slugify` in Rust. It has to: the slug is the FILE, and
  // this copy is what the save prompt answers "does this overwrite something?"
  // with. A rule that drifted here would confirm the wrong question.
  it("collapses a traversal attempt into a plain filename", () => {
    expect(sessionSlug("../x")).toBe("x");
    expect(sessionSlug("../../etc/passwd")).toBe("etc-passwd");
    expect(sessionSlug("a/b")).toBe("a-b");
    expect(sessionSlug("a\\b")).toBe("a-b");
  });

  it("returns nothing for a name with no letters or digits", () => {
    for (const hostile of ["", "   ", ".", "..", "...", "~", "/", "???"]) {
      expect(sessionSlug(hostile)).toBe("");
    }
  });

  it("emits only lowercase alphanumerics and single dashes", () => {
    expect(sessionSlug("My Session #2!")).toBe("my-session-2");
    const slug = sessionSlug("Ünïcödé — ✨ Work 42");
    expect(slug).toMatch(/^[a-z0-9-]+$/);
    expect(slug.startsWith("-") || slug.endsWith("-")).toBe(false);
    expect(slug).not.toContain("--");
  });

  it("caps a very long name", () => {
    const slug = sessionSlug("ab ".repeat(200));
    expect(slug.length).toBeLessThanOrEqual(64);
    expect(slug.endsWith("-")).toBe(false);
  });
});

describe("serializeWorkspace", () => {
  it("keeps the names, configs, directory and layout", () => {
    const { workspace, sessions } = seedWorkspace(["claude-code", "shell"]);

    const payload = serializeWorkspace(workspace.id)!;

    expect(payload.workspaceName).toBe("rocspace");
    expect(payload.paneCount).toBe(2);
    expect(payload.workspace.projectPath).toBe("/code/rocspace");
    expect(payload.workspace.accent).toBe(workspace.accent);
    expect(payload.workspace.paneTree).toEqual(workspace.paneTree);
    expect(payload.terminals.map((t) => t.name)).toEqual(["Pane 1", "Pane 2"]);
    expect(payload.terminals[0]!.agentConfig).toEqual(sessions[0]!.agentConfig);
    expect(payload.terminals[0]!.agentConfig.taskPrompt).toBe("task 1");
  });

  it("carries the Claude conversation each pane was in", () => {
    const { workspace } = seedWorkspace(
      ["claude-code", "shell"],
      ["uuid-a", null],
    );

    const payload = serializeWorkspace(workspace.id)!;

    expect(payload.terminals[0]!.claudeSessionId).toBe("uuid-a");
    expect(payload.terminals[1]!.claudeSessionId).toBeNull();
  });

  it("saves no output, pid or session identity", () => {
    // The payload is a shape, not a state. Anything describing a live process
    // would be a lie the moment it is written.
    const { workspace } = seedWorkspace(["shell", "shell"]);

    const payload = serializeWorkspace(workspace.id)!;
    const raw = JSON.stringify(payload);

    expect(raw).not.toContain('"pid"');
    expect(raw).not.toContain('"output"');
    expect(raw).not.toContain('"status"');
  });

  it("falls back to a balanced tree when the layout was never derived", () => {
    const { workspace, sessions } = seedWorkspace(["shell", "shell"]);
    useWorkspacesStore.setState({
      workspaces: [{ ...workspace, paneTree: null }],
    });

    const payload = serializeWorkspace(workspace.id)!;

    expect(leafIds(payload.workspace.paneTree!).sort()).toEqual(
      sessions.map((s) => s.id).sort(),
    );
  });

  it("is null for a workspace that is not there", () => {
    expect(serializeWorkspace("nope")).toBeNull();
    expect(serializeWorkspace(null)).toBeNull();
  });
});

describe("remapPaneTree", () => {
  const tree: PaneNode = {
    kind: "split",
    direction: "row",
    ratio: 0.4,
    first: { kind: "leaf", terminalId: "old-1" },
    second: {
      kind: "split",
      direction: "column",
      ratio: 0.6,
      first: { kind: "leaf", terminalId: "old-2" },
      second: { kind: "leaf", terminalId: "old-3" },
    },
  };

  it("rewrites every leaf and keeps the shape", () => {
    const ids = new Map([
      ["old-1", "new-1"],
      ["old-2", "new-2"],
      ["old-3", "new-3"],
    ]);

    const next = remapPaneTree(tree, ids)!;

    expect(leafIds(next)).toEqual(["new-1", "new-2", "new-3"]);
    expect((next as { ratio: number }).ratio).toBe(0.4);
  });

  it("drops a leaf the map does not name and collapses its split", () => {
    // A saved tree can outlive a session that failed to parse. A leaf naming a
    // terminal that does not exist renders as a pane nothing can close.
    const next = remapPaneTree(tree, new Map([["old-2", "new-2"]]))!;

    expect(next).toEqual({ kind: "leaf", terminalId: "new-2" });
  });

  it("is null when nothing survives", () => {
    expect(remapPaneTree(tree, new Map())).toBeNull();
    expect(remapPaneTree(null, new Map([["a", "b"]]))).toBeNull();
  });
});

describe("restoreSavedSession", () => {
  const roundTrip = (): {
    payload: SavedSessionPayload;
    savedIds: string[];
  } => {
    const { workspace, sessions } = seedWorkspace(
      ["claude-code", "shell"],
      ["uuid-a", null],
    );
    const payload = serializeWorkspace(workspace.id)!;
    return { payload, savedIds: sessions.map((s) => s.id) };
  };

  it("mints new ids and remaps the tree onto them, consistently", () => {
    // The invariant the whole feature stands on: restoring twice must not
    // produce two workspaces claiming one terminal id, and the layout must name
    // the sessions that actually exist.
    const { payload, savedIds } = roundTrip();

    const restored = restoreSavedSession(payload);

    const newIds = restored.sessions.map((s) => s.id);
    expect(newIds).toHaveLength(2);
    for (const id of newIds) expect(savedIds).not.toContain(id);

    const workspace = useWorkspacesStore
      .getState()
      .workspaces.find((w) => w.id === restored.workspaceId)!;
    expect(leafIds(workspace.paneTree!)).toEqual(newIds);
    // …in the saved positions, not just as a set.
    expect(workspace.paneTree).toMatchObject({
      kind: "split",
      direction: "row",
      ratio: 0.3,
      first: { terminalId: newIds[0] },
      second: { terminalId: newIds[1] },
    });
  });

  it("restoring twice gives two independent workspaces", () => {
    const { payload } = roundTrip();

    const first = restoreSavedSession(payload);
    const second = restoreSavedSession(payload);

    expect(second.workspaceId).not.toBe(first.workspaceId);
    const ids = new Set([
      ...first.sessions.map((s) => s.id),
      ...second.sessions.map((s) => s.id),
    ]);
    expect(ids.size).toBe(4);
    expect(useWorkspacesStore.getState().activeWorkspaceId).toBe(
      second.workspaceId,
    );
  });

  const workspaceOf = (restored: { workspaceId: string }) =>
    useWorkspacesStore
      .getState()
      .workspaces.find((w) => w.id === restored.workspaceId)!;

  it("keeps the saved names, configs and directory", () => {
    const { payload } = roundTrip();

    const restored = restoreSavedSession(payload);

    expect(restored.sessions.map((s) => s.name)).toEqual(["Pane 1", "Pane 2"]);
    expect(restored.sessions[0]!.agentConfig.taskPrompt).toBe("task 1");
    const workspace = workspaceOf(restored);
    expect(workspace.name).toBe("rocspace");
    expect(workspace.projectPath).toBe("/code/rocspace");
  });

  it("keeps the saved accent when nothing on screen is wearing it", () => {
    // It is how the user recognises the project, and re-colouring a restore
    // for no reason would make it look like a different workspace.
    const { payload } = roundTrip();
    // The workspace it was saved from has since been closed, so its colour is
    // free again.
    useWorkspacesStore.setState({ workspaces: [], activeWorkspaceId: null });

    const restored = restoreSavedSession(payload);

    expect(workspaceOf(restored).accent).toBe(payload.workspace.accent);
  });

  it("takes a free accent when the saved one is already open", () => {
    // Restoring a session beside the workspace it was saved from is the normal
    // case — that is what "opens beside whatever is already open" means — and
    // it used to produce two rows in one colour, which takes the recognition
    // signal away from both of them.
    const { payload } = roundTrip();

    const restored = restoreSavedSession(payload);

    expect(workspaceOf(restored).accent).not.toBe(payload.workspace.accent);
    const inUse = useWorkspacesStore.getState().workspaces.map((w) => w.accent);
    expect(new Set(inUse).size).toBe(inUse.length);
  });

  it("parks the Claude conversation instead of putting it back on the session", () => {
    // A `claudeSessionId` on the session means "this pane's live process is in
    // that conversation" — `ptyBridge` reads it as "hook-driven" and switches
    // off the fallback heuristic. Nothing is running yet, so it goes where the
    // resume affordance can find it and nothing else mistakes it.
    const { payload } = roundTrip();

    const restored = restoreSavedSession(payload);

    const [claude, shell] = restored.sessions;
    expect(claude!.claudeSessionId).toBeNull();
    expect(restored.resumable.get(claude!.id)).toBe("uuid-a");
    expect(restored.resumable.has(shell!.id)).toBe(false);
    expect(
      useTerminalRuntimeStore.getState().resumableClaudeSessions[claude!.id],
    ).toBe("uuid-a");
  });

  it("adds the workspace beside the open ones and makes it active", () => {
    const { payload } = roundTrip();
    const before = useWorkspacesStore.getState().workspaces.length;

    const restored = restoreSavedSession(payload);

    const { workspaces, activeWorkspaceId } = useWorkspacesStore.getState();
    expect(workspaces).toHaveLength(before + 1);
    expect(activeWorkspaceId).toBe(restored.workspaceId);
  });

  it("starts nothing by itself", () => {
    // Spawning is the caller's call — which panes may start depends on the
    // conversation each carries.
    const { payload } = roundTrip();

    restoreSavedSession(payload);

    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("the saved-sessions store's restore", () => {
  it("spawns every pane that has no conversation waiting, and no others", async () => {
    invoke.mockResolvedValue({ pid: 1, claudeSessionId: null });
    const { workspace } = seedWorkspace(
      ["claude-code", "shell"],
      ["uuid-a", null],
    );
    const payload = serializeWorkspace(workspace.id)!;
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "session_load") return payload;
      return { pid: 1, claudeSessionId: null };
    });

    const id = await useSavedSessionsStore.getState().restore("friday");

    expect(id).not.toBeNull();
    const spawned = invoke.mock.calls
      .filter(([cmd]) => cmd === "terminal_spawn")
      .map(([, args]) => (args as { terminalId: string }).terminalId);
    const restored = Object.values(useTerminalsStore.getState().byId).filter(
      (t) => t.workspaceId === id,
    );
    const resumable =
      useTerminalRuntimeStore.getState().resumableClaudeSessions;
    expect(spawned).toHaveLength(1);
    expect(resumable[spawned[0]!]).toBeUndefined();
    expect(restored).toHaveLength(2);
  });

  it("reports an unreadable file instead of opening an empty workspace", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "session_load") return "not a session";
      return null;
    });

    const id = await useSavedSessionsStore.getState().restore("broken");

    expect(id).toBeNull();
    expect(useSavedSessionsStore.getState().error).toContain("broken");
    expect(useWorkspacesStore.getState().workspaces).toHaveLength(0);
  });

  it("refuses a file that parses but describes no panes", async () => {
    // The reader is total on purpose — it fills in a name and an accent for
    // whatever it is handed — so a truncated or hand-edited file used to
    // restore as an empty workspace called "Restored workspace", with no error
    // and nothing in it. Every one of these is a JSON object, and none of them
    // is a session.
    for (const corrupt of [{}, [], { foo: 1 }, { terminals: [] }]) {
      useHistoryStore.setState({ failures: [] });
      invoke.mockImplementation(async (cmd: string) => {
        if (cmd === "session_load") return corrupt;
        return null;
      });

      const id = await useSavedSessionsStore.getState().restore("friday");

      expect(id).toBeNull();
      expect(useWorkspacesStore.getState().workspaces).toHaveLength(0);
      expect(useSavedSessionsStore.getState().error).toContain("no panes");
      // …and where the user goes looking for it: Settings › History, beside
      // the panes that failed to spawn.
      expect(useHistoryStore.getState().failures).toMatchObject([
        { kind: "restore", name: "friday", workspaceName: null },
      ]);
    }
  });

  it("survives the IPC itself failing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    invoke.mockRejectedValue(new Error("no such file"));

    await expect(
      useSavedSessionsStore.getState().restore("gone"),
    ).resolves.toBeNull();
    expect(useSavedSessionsStore.getState().error).toBe("no such file");
    warn.mockRestore();
  });
});

describe("parseSavedSession", () => {
  it("rejects anything that is not an object", () => {
    for (const raw of [null, undefined, 42, "session", []]) {
      const parsed = parseSavedSession(raw);
      // An array parses as an object with no terminals rather than throwing;
      // what matters is that nothing throws and nothing invents panes.
      expect(parsed === null || parsed.terminals.length === 0).toBe(true);
    }
  });

  it("drops a pane whose agent config is unreadable, keeping the rest", () => {
    const parsed = parseSavedSession({
      workspace: { name: "w", accent: "cyan", projectPath: null },
      terminals: [
        { id: "a", name: "Good", agentConfig: { type: "shell" } },
        { id: "b", name: "Bad", agentConfig: { type: "not-an-agent" } },
        { id: "c", name: "No config" },
      ],
    })!;

    expect(parsed.terminals.map((t) => t.id)).toEqual(["a"]);
    expect(parsed.paneCount).toBe(1);
    expect(parsed.workspace.accent).toBe("cyan");
  });

  /** `custom` is no longer offered by any picker (nothing can write
   *  `customArgs`, so it launches a plain shell wearing the wrong badge) — but
   *  it is still an `AgentType`, and a session saved while it was offerable has
   *  to come back as what it is. Withdrawing the CHOICE must not turn an old
   *  file into a dropped pane. */
  it("still reads a pane saved as the withdrawn Custom type", () => {
    const parsed = parseSavedSession({
      workspace: { name: "w", accent: "cyan", projectPath: null },
      terminals: [{ id: "a", name: "P", agentConfig: { type: "custom" } }],
    })!;

    expect(parsed.terminals[0]!.agentConfig.type).toBe("custom");
  });

  it("falls back to conservative permissions rather than half a set", () => {
    const parsed = parseSavedSession({
      workspace: { name: "w" },
      terminals: [{ id: "a", name: "P", agentConfig: { type: "claude-code" } }],
    })!;

    expect(parsed.terminals[0]!.agentConfig.permissions).toMatchObject({
      autoAcceptEdits: false,
      askBeforeRunningCommands: true,
    });
  });

  it("rejects a pane tree it cannot trust", () => {
    const parsed = parseSavedSession({
      workspace: {
        name: "w",
        paneTree: { kind: "split", direction: "sideways" },
      },
      terminals: [{ id: "a", name: "P", agentConfig: { type: "shell" } }],
    })!;

    expect(parsed.workspace.paneTree).toBeNull();
  });

  it("names an unnamed workspace something addressable", () => {
    const parsed = parseSavedSession({ terminals: [] })!;
    expect(parsed.workspace.name).toBe("Restored workspace");
  });
});
