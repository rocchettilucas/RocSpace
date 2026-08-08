import { beforeEach, describe, expect, it, vi } from "vitest";

/** In-memory stand-in for tauri-plugin-store's `Store`. */
const fakeStore = {
  get: vi.fn(),
  set: vi.fn(),
  save: vi.fn(),
  delete: vi.fn(),
};

vi.mock("@tauri-apps/plugin-store", () => ({
  Store: { load: vi.fn(async () => fakeStore) },
}));

import type { TerminalSession, Workspace } from "@/lib/bindings";
import { leafIds } from "@/lib/paneTree";
import {
  loadSnapshot,
  migrateV5,
  SCHEMA_VERSION,
  startAutosave,
  type SnapshotV6,
} from "@/lib/persistence";
import { getRecents, seedRecents } from "@/lib/recents";
import { DEFAULT_BROWSER_URL } from "@/stores/editor";
import {
  useEditorStore,
  useTerminalsStore,
  useUIStore,
  useWorkspacesStore,
} from "@/stores";

const PROJECT = { path: "/tmp/proj", name: "proj", lastOpenedAt: 11 };

/** A v5 snapshot as the pre-Phase-2 build wrote one: a workspace holding one
 *  project, profiles holding groups + a layout, and terminals pointing back at
 *  a profile through `profileId`. */
function v5Snapshot() {
  return {
    schemaVersion: 5,
    workspace: { id: "ws1", project: PROJECT, createdAt: 1, updatedAt: 2 },
    profiles: [
      {
        id: "p1",
        name: "Default",
        groups: [
          { id: "g1", profileId: "p1", name: "Frontend", color: "violet" },
        ],
        // Removed field — must be tolerated and stripped, not carried forward.
        terminals: [{ id: "ghost", name: "stale duplicate" }],
        layout: {
          mode: "four-grid",
          focusedTerminalId: null,
          paneSizes: {},
        },
        webPreview: {
          url: "http://localhost:5173",
          autoRefresh: false,
          refreshIntervalMs: null,
          position: "right",
        },
        defaultPermissions: {
          autoAcceptEdits: false,
          askBeforeRunningCommands: true,
          readOnlyMode: false,
          allowFileEdits: true,
          allowPackageInstalls: false,
          allowGitCommands: true,
        },
        order: 0,
        createdAt: 1,
        updatedAt: 2,
      },
    ] as Record<string, unknown>[],
    activeProfileId: "p1",
    // Annotated so tests can assign real sessions; a bare [] infers never[].
    terminals: [] as Record<string, unknown>[],
  };
}

/** A v5 session: `profileId` + `groupId` + `layoutPosition`, none of which
 *  survive the migration. Deliberately a loose record, because this describes
 *  bytes on disk rather than a type the app still has. */
function v5Session(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "t1",
    profileId: "p1",
    groupId: "g1",
    name: "Rocky",
    agentConfig: {
      type: "shell",
      taskPrompt: null,
      model: null,
      permissions: {
        autoAcceptEdits: false,
        askBeforeRunningCommands: true,
        readOnlyMode: false,
        allowFileEdits: true,
        allowPackageInstalls: false,
        allowGitCommands: true,
      },
      customArgs: null,
    },
    status: "idle",
    projectPath: "/tmp/proj",
    commandHistory: [],
    output: [],
    createdAt: 1,
    updatedAt: 2,
    layoutPosition: { groupId: "g1", index: 0 },
    pid: null,
    claudeSessionId: null,
    ...overrides,
  };
}

/** A fully-typed v6 session. Not cast through `any`: the return annotation
 *  makes the compiler check every field, so a rename or addition in
 *  `TerminalSession` breaks this file rather than leaving the tests asserting
 *  against a shape the app no longer uses. */
function session(overrides: Partial<TerminalSession> = {}): TerminalSession {
  const { profileId: _p, ...rest } = v5Session() as Record<string, unknown> & {
    profileId?: string;
  };
  void _p;
  return {
    ...(rest as unknown as TerminalSession),
    workspaceId: "w1",
    ...overrides,
  };
}

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: "w1",
    name: "proj",
    accent: "violet",
    projectPath: "/tmp/proj",
    paneTree: null,
    focusedTerminalId: null,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

function v6Snapshot(overrides: Record<string, unknown> = {}) {
  return {
    version: SCHEMA_VERSION,
    workspaces: [workspace()],
    activeWorkspaceId: "w1",
    terminals: [] as TerminalSession[],
    recents: [] as { path: string; lastOpenedAt: number }[],
    ...overrides,
  };
}

const workspaces = () => useWorkspacesStore.getState().workspaces;

beforeEach(() => {
  vi.clearAllMocks();
  useWorkspacesStore.setState({ workspaces: [], activeWorkspaceId: null });
  useTerminalsStore.setState({ byId: {} });
  useEditorStore.setState({
    rightDockMode: "inspector",
    rightPanelCollapsed: false,
    browserUrl: DEFAULT_BROWSER_URL,
    rocViewLayout: null,
    tabs: [],
    activePath: null,
  });
  seedRecents([]);
});

/** Every load in this file: nothing here is testing the filesystem, and the
 *  real prune would reject every fixture path. */
const alwaysExists = { pathExists: async () => true };

describe("migrateV5", () => {
  it("turns the active profile into workspace #1", () => {
    const snap = v5Snapshot();
    snap.profiles[0]!.paneTree = {
      kind: "split",
      direction: "column",
      ratio: 0.8,
      first: { kind: "leaf", terminalId: "t1" },
      second: { kind: "leaf", terminalId: "t2" },
    };
    snap.profiles[0]!.layout = { focusedTerminalId: "t2" };
    snap.terminals = [v5Session({ id: "t1" }), v5Session({ id: "t2" })];

    const v6 = migrateV5(snap);

    expect(v6.version).toBe(SCHEMA_VERSION);
    expect(v6.workspaces).toHaveLength(1);
    const w = v6.workspaces[0]!;
    // Named after the project directory, coloured with the first accent.
    expect(w.name).toBe("proj");
    expect(w.accent).toBe("violet");
    expect(w.projectPath).toBe("/tmp/proj");
    // The tree — ratios and all — is the whole point of migrating rather than
    // rebuilding.
    expect(leafIds(w.paneTree!)).toEqual(["t1", "t2"]);
    expect(w.paneTree).toMatchObject({ ratio: 0.8, direction: "column" });
    // `layout.focusedTerminalId` is the one field of the retired LayoutConfig
    // still worth keeping.
    expect(w.focusedTerminalId).toBe("t2");
    expect(v6.activeWorkspaceId).toBe(w.id);
  });

  it("rewrites profileId into workspaceId and drops the group fields", () => {
    const snap = v5Snapshot();
    snap.terminals = [v5Session({ id: "t1" })];

    const v6 = migrateV5(snap);

    const t = v6.terminals[0]!;
    expect(t.workspaceId).toBe(v6.workspaces[0]!.id);
    expect(t).not.toHaveProperty("profileId");
    expect(t).not.toHaveProperty("groupId");
    expect(t).not.toHaveProperty("layoutPosition");
    // Everything the session is actually about survives.
    expect(t.name).toBe("Rocky");
    expect(t.projectPath).toBe("/tmp/proj");
    expect(t.agentConfig.type).toBe("shell");
  });

  it("keeps the profile's id as the workspace's, so nothing has to be remapped", () => {
    const v6 = migrateV5(v5Snapshot());
    expect(v6.workspaces[0]!.id).toBe("p1");
  });

  it("drops the inactive profiles, and says how many, exactly once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const snap = v5Snapshot();
    snap.profiles.push(
      { ...snap.profiles[0]!, id: "p2" },
      { ...snap.profiles[0]!, id: "p3" },
    );
    snap.terminals = [
      v5Session({ id: "t1", profileId: "p1" }),
      v5Session({ id: "t2", profileId: "p2" }),
    ];

    const v6 = migrateV5(snap);

    expect(v6.workspaces).toHaveLength(1);
    expect(v6.workspaces[0]!.id).toBe("p1");
    // A session of a dropped profile would be an orphan nothing renders and
    // nothing ever closes.
    expect(v6.terminals.map((t) => t.id)).toEqual(["t1"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "[persistence] migrated v5 snapshot: 2 inactive profiles dropped",
    );
    warn.mockRestore();
  });

  it("says nothing when there was only ever one profile", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    migrateV5(v5Snapshot());
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("seeds the recents from the old project path", () => {
    const v6 = migrateV5(v5Snapshot());
    expect(v6.recents).toEqual([{ path: "/tmp/proj", lastOpenedAt: 11 }]);
  });

  it("carries the roctalk and editor slices across untouched", () => {
    const snap = {
      ...v5Snapshot(),
      roctalk: { enabled: true, position: { x: 3, y: 4 } },
      editor: {
        rightDockMode: "browser" as const,
        rightPanelCollapsed: true,
        tabs: [],
        activePath: "/tmp/proj/main.ts",
      },
    };

    const v6 = migrateV5(snap);

    expect(v6.roctalk).toEqual({ enabled: true, position: { x: 3, y: 4 } });
    expect(v6.editor?.activePath).toBe("/tmp/proj/main.ts");
    // …and folds the profile's browser URL in beside them.
    expect(v6.editor?.browserUrl).toBe("http://localhost:5173");
  });

  it("keeps the browser URL the profile's preview was pointed at", () => {
    // The one field of the retired `webPreview` worth migrating. A user on a
    // non-default dev port would otherwise come back to the default, and the
    // next autosave writes that over the only copy of what they had.
    const v6 = migrateV5(v5Snapshot());

    expect(v6.editor?.browserUrl).toBe("http://localhost:5173");
    // The rest of the editor slice has to be a valid one even though v5 wrote
    // no such key at all.
    expect(v6.editor?.tabs).toEqual([]);
    expect(v6.editor?.activePath).toBeNull();
  });

  it("invents no editor slice for a profile with no browser URL", () => {
    const snap = v5Snapshot();
    delete snap.profiles[0]!.webPreview;

    expect(migrateV5(snap).editor).toBeUndefined();
  });

  it("lands on the empty state for a snapshot with no profiles", () => {
    const snap = { ...v5Snapshot(), profiles: [], activeProfileId: null };

    const v6 = migrateV5(snap);

    expect(v6.workspaces).toEqual([]);
    expect(v6.activeWorkspaceId).toBeNull();
    expect(v6.terminals).toEqual([]);
  });

  it("names the workspace when the old project had no path", () => {
    const snap = { ...v5Snapshot(), workspace: null };

    const v6 = migrateV5(snap);

    expect(v6.workspaces[0]!.name).toBe("Workspace 1");
    expect(v6.workspaces[0]!.projectPath).toBeNull();
    expect(v6.recents).toEqual([]);
  });

  it("discards a corrupt pane tree rather than failing", () => {
    const snap = v5Snapshot();
    snap.profiles[0]!.paneTree = {
      kind: "split",
      direction: "sideways",
      ratio: "a lot",
      first: { kind: "leaf" },
    };

    expect(migrateV5(snap).workspaces[0]!.paneTree).toBeNull();
  });
});

describe("loadSnapshot: a v5 snapshot on disk", () => {
  it("round-trips a full v5 workspace into the stores", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const snap = v5Snapshot();
    snap.profiles[0]!.paneTree = {
      kind: "split",
      direction: "row",
      ratio: 0.65,
      first: { kind: "leaf", terminalId: "t1" },
      second: { kind: "leaf", terminalId: "t2" },
    };
    snap.terminals = [
      v5Session({ id: "t1", name: "Rocky" }),
      v5Session({ id: "t2", name: "Roxie", claudeSessionId: "uuid-9" }),
    ];
    fakeStore.get.mockResolvedValue(snap);

    await expect(loadSnapshot(alwaysExists)).resolves.toBe(true);

    expect(workspaces()).toHaveLength(1);
    const w = workspaces()[0]!;
    expect(w.name).toBe("proj");
    expect(useWorkspacesStore.getState().activeWorkspaceId).toBe(w.id);
    expect(leafIds(w.paneTree!)).toEqual(["t1", "t2"]);
    expect(w.paneTree).toMatchObject({ ratio: 0.65 });

    const byId = useTerminalsStore.getState().byId;
    expect(Object.keys(byId).sort()).toEqual(["t1", "t2"]);
    expect(byId.t1!.workspaceId).toBe(w.id);
    // Chat names survive, and so does the uuid Phase 2's resume needs.
    expect(byId.t2!.name).toBe("Roxie");
    expect(byId.t2!.claudeSessionId).toBe("uuid-9");
    expect(getRecents().map((r) => r.path)).toEqual(["/tmp/proj"]);
    // The Browser tab comes back on the port the user was actually running.
    expect(useEditorStore.getState().browserUrl).toBe("http://localhost:5173");
    warn.mockRestore();
  });

  it("falls back to the default URL when the v5 profile named none", async () => {
    const snap = v5Snapshot();
    delete snap.profiles[0]!.webPreview;
    fakeStore.get.mockResolvedValue(snap);

    await loadSnapshot(alwaysExists);

    expect(useEditorStore.getState().browserUrl).toBe(DEFAULT_BROWSER_URL);
  });

  it("derives a tree for a v5 profile that never had one", async () => {
    const snap = v5Snapshot();
    expect(snap.profiles[0]).not.toHaveProperty("paneTree");
    snap.terminals = [v5Session({ id: "t1" }), v5Session({ id: "t2" })];
    fakeStore.get.mockResolvedValue(snap);

    await loadSnapshot(alwaysExists);

    expect(leafIds(workspaces()[0]!.paneTree!)).toEqual(["t1", "t2"]);
  });

  it("rebuilds a tree that names sessions the snapshot no longer has", async () => {
    const snap = v5Snapshot();
    snap.profiles[0]!.paneTree = {
      kind: "split",
      direction: "row",
      ratio: 0.5,
      first: { kind: "leaf", terminalId: "t1" },
      second: { kind: "leaf", terminalId: "vanished" },
    };
    snap.terminals = [v5Session({ id: "t1" })];
    fakeStore.get.mockResolvedValue(snap);

    await loadSnapshot(alwaysExists);

    expect(workspaces()[0]!.paneTree).toEqual({
      kind: "leaf",
      terminalId: "t1",
    });
  });

  it("strips the legacy profile.terminals array instead of resurrecting it", async () => {
    const snap = v5Snapshot();
    fakeStore.get.mockResolvedValue(snap);

    await loadSnapshot(alwaysExists);

    expect(Object.keys(useTerminalsStore.getState().byId)).toEqual([]);
    expect(Object.keys(workspaces()[0]!)).not.toContain("terminals");
  });

  it("loads a v5 session written before claudeSessionId existed", async () => {
    // Additive field: snapshots on disk today have no such key. It must come
    // back as null, not undefined, or the value round-trips into the next save
    // as a missing key on a field the IPC layer types `string | null`.
    const snap = v5Snapshot();
    const legacy = v5Session({ id: "t1" });
    delete legacy.claudeSessionId;
    delete legacy.pid;
    snap.terminals = [legacy];
    fakeStore.get.mockResolvedValue(snap);

    await expect(loadSnapshot(alwaysExists)).resolves.toBe(true);

    const t = useTerminalsStore.getState().byId.t1!;
    expect(t.claudeSessionId).toBeNull();
    expect(t.pid).toBeNull();
  });

  it("hydrates the rest of a snapshot whose terminals key is missing", async () => {
    // A snapshot written before the top-level `terminals` list existed (or one
    // truncated by a crashed save) has no `terminals` key at all. Iterating it
    // bare threw and the catch abandoned the ENTIRE load — workspaces and
    // editor state included, which drops the user into the empty state with
    // their work intact on disk.
    const { terminals: _terminals, ...withoutTerminals } = v5Snapshot();
    void _terminals;
    fakeStore.get.mockResolvedValue({
      ...withoutTerminals,
      editor: {
        rightDockMode: "browser",
        rightPanelCollapsed: true,
        tabs: [],
        activePath: "/tmp/proj/main.ts",
      },
    });

    await expect(loadSnapshot(alwaysExists)).resolves.toBe(true);

    expect(workspaces()).toHaveLength(1);
    expect(useTerminalsStore.getState().byId).toEqual({});
    // Applied after setTerminals, so this is what the aborted load lost.
    const editor = useEditorStore.getState();
    expect(editor.activePath).toBe("/tmp/proj/main.ts");
    expect(editor.rightDockMode).toBe("browser");
    expect(editor.rightPanelCollapsed).toBe(true);
  });
});

describe("loadSnapshot: a v6 snapshot on disk", () => {
  it("loads workspaces, sessions and recents as written", async () => {
    fakeStore.get.mockResolvedValue(
      v6Snapshot({
        workspaces: [
          workspace({
            accent: "amber",
            paneTree: { kind: "leaf", terminalId: "t1" },
            focusedTerminalId: "t1",
          }),
        ],
        terminals: [session({ id: "t1" })],
        recents: [
          { path: "/tmp/proj", lastOpenedAt: 5 },
          { path: "/tmp/other", lastOpenedAt: 9 },
        ],
      }),
    );

    await expect(loadSnapshot(alwaysExists)).resolves.toBe(true);

    expect(workspaces()[0]).toMatchObject({
      id: "w1",
      accent: "amber",
      focusedTerminalId: "t1",
    });
    expect(useTerminalsStore.getState().byId.t1!.workspaceId).toBe("w1");
    // Newest first, whatever order the file held them in.
    expect(getRecents().map((r) => r.path)).toEqual([
      "/tmp/other",
      "/tmp/proj",
    ]);
  });

  it("is not migrated a second time", async () => {
    // `migrateV5` on a v6 snapshot would find no `profiles` and wipe the list.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fakeStore.get.mockResolvedValue(v6Snapshot());

    await loadSnapshot(alwaysExists);

    expect(workspaces()).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("skips a corrupt workspace and loads the rest", async () => {
    // A workspace is a whole project's worth of layout; one bad entry must not
    // cost the user the others.
    fakeStore.get.mockResolvedValue(
      v6Snapshot({
        workspaces: [
          { name: "no id at all" },
          workspace({ id: "w2", name: "Second" }),
          null,
        ],
        activeWorkspaceId: "w2",
        terminals: [session({ id: "t1", workspaceId: "w2" })],
      }),
    );

    await expect(loadSnapshot(alwaysExists)).resolves.toBe(true);

    expect(workspaces().map((w) => w.id)).toEqual(["w2"]);
    expect(useWorkspacesStore.getState().activeWorkspaceId).toBe("w2");
    expect(Object.keys(useTerminalsStore.getState().byId)).toEqual(["t1"]);
  });

  it("drops a session whose workspace did not survive the load", async () => {
    fakeStore.get.mockResolvedValue(
      v6Snapshot({
        workspaces: [{ name: "no id" }],
        activeWorkspaceId: null,
        terminals: [session({ id: "orphan", workspaceId: "gone" })],
      }),
    );

    await loadSnapshot(alwaysExists);

    expect(useTerminalsStore.getState().byId).toEqual({});
  });

  it("repairs a bad accent and a bad tree without failing the load", async () => {
    fakeStore.get.mockResolvedValue(
      v6Snapshot({
        workspaces: [
          workspace({
            accent: "chartreuse" as never,
            paneTree: { kind: "split", direction: "sideways" } as never,
          }),
        ],
      }),
    );

    await expect(loadSnapshot(alwaysExists)).resolves.toBe(true);

    expect(workspaces()[0]!.accent).toBe("violet");
    expect(workspaces()[0]!.paneTree).toBeNull();
  });

  it("falls back to the first workspace when the active id names nothing", async () => {
    fakeStore.get.mockResolvedValue(
      v6Snapshot({
        workspaces: [workspace({ id: "w1" }), workspace({ id: "w2" })],
        activeWorkspaceId: "vanished",
      }),
    );

    await loadSnapshot(alwaysExists);

    expect(useWorkspacesStore.getState().activeWorkspaceId).toBe("w1");
  });

  it("lands the app-wide focus on the pane the user left off on", async () => {
    // A cold boot is an arrival at a workspace like any other, and it was the
    // one that did not restore the focus. `focusedTerminalId` is what the
    // Inspector points at, what RocTalk dictates into, and what the turn signal
    // reads as "the pane the user is looking at" — null says they are looking
    // at nothing, so the first turn to end in the pane in front of them glowed
    // and dinged about itself.
    useUIStore.setState({ focusedTerminalId: null });
    fakeStore.get.mockResolvedValue(
      v6Snapshot({
        workspaces: [
          workspace({
            paneTree: { kind: "leaf", terminalId: "t1" },
            focusedTerminalId: "t1",
          }),
        ],
        terminals: [session({ id: "t1" })],
      }),
    );

    await loadSnapshot(alwaysExists);

    expect(useUIStore.getState().focusedTerminalId).toBe("t1");
  });

  it("leaves the focus null when the active workspace remembers no pane", async () => {
    useUIStore.setState({ focusedTerminalId: "stale-from-a-previous-life" });
    fakeStore.get.mockResolvedValue(v6Snapshot());

    await loadSnapshot(alwaysExists);

    expect(useUIStore.getState().focusedTerminalId).toBeNull();
  });
});

/** Roc's three-region split. It is written by `captureSnapshot` and read at
 *  MOUNT as the view's `defaultLayout`, so the whole feature is the round trip:
 *  a split that does not come back is a divider the user drags every time they
 *  open the view. */
describe("the Roc view's split", () => {
  const ROC_LAYOUT = { "roc-rail": 30, "roc-stage": 40, "roc-live": 30 };

  it("comes back off disk as it was written", async () => {
    fakeStore.get.mockResolvedValue(
      v6Snapshot({
        editor: {
          rightDockMode: "inspector",
          rightPanelCollapsed: false,
          rocViewLayout: ROC_LAYOUT,
          tabs: [],
          activePath: null,
        },
      }),
    );

    await expect(loadSnapshot(alwaysExists)).resolves.toBe(true);

    expect(useEditorStore.getState().rocViewLayout).toEqual(ROC_LAYOUT);
  });

  // Additive field: every snapshot written before Phase 4 has no such key, and
  // the view's own defaults are the right answer for those.
  it("is null, not undefined, in a snapshot written before it existed", async () => {
    useEditorStore.setState({ rocViewLayout: ROC_LAYOUT });
    fakeStore.get.mockResolvedValue(
      v6Snapshot({
        editor: {
          rightDockMode: "inspector",
          rightPanelCollapsed: false,
          tabs: [],
          activePath: null,
        },
      }),
    );

    await loadSnapshot(alwaysExists);

    expect(useEditorStore.getState().rocViewLayout).toBeNull();
  });

  // The other half of the trip, and the half that was missing: the autosave
  // subscription did not watch this field, so a dragged divider was only ever
  // written by luck — if some other store happened to be touched before the
  // quit. On a quiet session it was lost.
  it("is saved when a divider is dragged", async () => {
    vi.useFakeTimers();
    const stop = startAutosave();
    try {
      useEditorStore.getState().setRocViewLayout(ROC_LAYOUT);
      await vi.advanceTimersByTimeAsync(1000);
    } finally {
      stop();
      vi.useRealTimers();
    }

    expect(fakeStore.set).toHaveBeenCalledTimes(1);
    const [, saved] = fakeStore.set.mock.calls[0]!;
    expect((saved as SnapshotV6).editor?.rocViewLayout).toEqual(ROC_LAYOUT);
  });
});

describe("recents", () => {
  it("forgets directories that no longer exist", async () => {
    // Offering a dead path is worse than forgetting it: the workspace it
    // creates spawns every pane into nothing.
    fakeStore.get.mockResolvedValue(
      v6Snapshot({
        recents: [
          { path: "/tmp/here", lastOpenedAt: 9 },
          { path: "/tmp/gone", lastOpenedAt: 8 },
        ],
      }),
    );

    await loadSnapshot({ pathExists: async (p) => p === "/tmp/here" });
    // The prune is deliberately off the critical path, so let it settle.
    await vi.waitFor(() =>
      expect(getRecents().map((r) => r.path)).toEqual(["/tmp/here"]),
    );
  });

  it("drops duplicate and malformed entries on the way in", async () => {
    fakeStore.get.mockResolvedValue(
      v6Snapshot({
        recents: [
          { path: "/tmp/a", lastOpenedAt: 1 },
          { path: "/tmp/a", lastOpenedAt: 2 },
          { path: "", lastOpenedAt: 3 },
          { lastOpenedAt: 4 },
          "not an object",
        ],
      }),
    );

    await loadSnapshot(alwaysExists);

    expect(getRecents()).toEqual([{ path: "/tmp/a", lastOpenedAt: 1 }]);
  });
});

describe("loadSnapshot: refusals", () => {
  it("returns false when no snapshot exists", async () => {
    fakeStore.get.mockResolvedValue(undefined);
    await expect(loadSnapshot(alwaysExists)).resolves.toBe(false);
  });

  it("returns false for a version from the future", async () => {
    // Refusing beats guessing: a partial read looks like data loss and would be
    // written back over the real thing on the next autosave.
    fakeStore.get.mockResolvedValue({ ...v6Snapshot(), version: 99 });
    await expect(loadSnapshot(alwaysExists)).resolves.toBe(false);
    expect(workspaces()).toEqual([]);
  });

  it("returns false for a blob with no version at all", async () => {
    fakeStore.get.mockResolvedValue({ workspaces: [workspace()] });
    await expect(loadSnapshot(alwaysExists)).resolves.toBe(false);
  });
});
