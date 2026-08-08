/** Workspace persistence via tauri-plugin-store.
 *
 *  - Serializes workspaces + terminals + activeWorkspaceId + recents as one
 *    blob keyed by `snapshot` in the file `workspace.dat` (under app data dir).
 *  - Save is debounced to absorb rapid mutation bursts (PTY output,
 *    drag-resize, etc.).
 *  - Load runs on app startup; hydrates the persistent stores, migrating a
 *    v1–v5 snapshot on the way in. */

import { Store } from "@tauri-apps/plugin-store";
import { resolveAccent } from "@/lib/accentColors";
import { commands } from "@/lib/bindings";
import { directoryTail, newId } from "@/lib/factories";
import { sanitizePaneTree } from "@/lib/paneTree";
import {
  getRecents,
  onRecentsChanged,
  pruneRecents,
  sanitizeRecents,
  seedRecents,
  type PathExists,
} from "@/lib/recents";
import { DEFAULT_BROWSER_URL } from "@/stores/editor";
import {
  restoreFocus,
  useEditorStore,
  useRocMindStore,
  useRocTalkStore,
  useTerminalsStore,
  useWorkspacesStore,
  type RightDockMode,
  type EditorTab,
} from "@/stores";
import type { RecentProject, TerminalSession, Workspace } from "@/lib/bindings";

const FILE = "workspace.dat";
const KEY = "snapshot";
// Bump when the persisted schema shape changes incompatibly.
//   v1: original.
//   v2: added optional `roctalk`.
//   v3: added optional `editor` (tabs, active, dockView).
//   v4: editor.dockView ('terminals'|'editor') replaced by rightDockMode
//       ('inspector'|'browser'|'editor'). Old v3 saves migrate to 'inspector'.
//   v5: editor.rightPanelCollapsed (bool) added; missing → defaults to false.
//   v6: workspaces replace workspace+profiles+groups. `TerminalSession`
//       loses `groupId`/`layoutPosition` and renames `profileId` →
//       `workspaceId`; the top-level list becomes
//       { version, workspaces, terminals, activeWorkspaceId, recents }.
//       v1–v5 all funnel through `migrateV5` (they only ever differed in the
//       optional `roctalk`/`editor` slices, which it carries across untouched).
//
// The version key itself moved: v1–v5 wrote `schemaVersion`, v6 writes
// `version`. `readVersion` accepts either, which is also how a v6 snapshot is
// told apart from the v5 it migrated from.
export const SCHEMA_VERSION = 6;
const MIGRATABLE_VERSIONS = new Set([1, 2, 3, 4, 5]);
const SAVE_DEBOUNCE_MS = 500;

/** Re-exported so "the recents live in persistence" stays true at the call
 *  site: the list's durability is this module's job, its state is
 *  `lib/recents.ts` (which the workspaces store writes to on creation without
 *  importing the module that imports it). */
export {
  getRecents,
  rememberRecent,
  forgetRecent,
  MAX_RECENTS,
  type PathExists,
} from "@/lib/recents";

interface PersistedExtras {
  roctalk?: {
    enabled: boolean;
    position: { x: number; y: number };
  };
  editor?: {
    /** v4+. Falls back to 'inspector' when loading older snapshots. */
    rightDockMode?: RightDockMode;
    /** v3 legacy field. Read only — never written. */
    dockView?: "terminals" | "editor";
    /** v5+. Falls back to false (panel visible) when loading older snapshots. */
    rightPanelCollapsed?: boolean;
    /** v6+. The workspace sidebar's twin of the flag above; a snapshot written
     *  before the sidebar had a toggle has no key here and opens expanded. */
    sidebarCollapsed?: boolean;
    /** v6+. Was `profile.webPreview.url` before workspaces landed; a v5
     *  snapshot has no such key here and falls back to the default. */
    browserUrl?: string;
    /** How Roc's expanded view is split (Phase 4). Additive and optional, so a
     *  snapshot written before it existed loads with the view's defaults — no
     *  version bump, because a missing key is not an incompatible shape. */
    rocViewLayout?: Record<string, number> | null;
    tabs: EditorTab[];
    activePath: string | null;
  };
  /** RocMind's tree, as far as it is worth remembering: which project folders
   *  are open.
   *
   *  Additive and optional, like `rocViewLayout` above and for the same reason
   *  — a missing key is not an incompatible shape, so this costs no version
   *  bump. Which memory was selected is deliberately NOT here: reopening the
   *  app on a memory you read yesterday is a worse landing than the tree.
   *
   *  In the workspace snapshot rather than in settings because it is what the
   *  app looked like, not something the user chose — the same slice of the
   *  world as `editor.tabs` and `rightPanelCollapsed`. */
  mind?: {
    expandedScopes?: string[];
  };
}

export interface SnapshotV6 extends PersistedExtras {
  version: 6;
  workspaces: Workspace[];
  terminals: TerminalSession[];
  activeWorkspaceId: string | null;
  recents: RecentProject[];
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

/** The shape of the v5 snapshot, as far as the migration needs to read it.
 *  Deliberately loose — this describes bytes on someone's disk, not a type the
 *  app still has, and a field being absent or the wrong shape is the normal
 *  case rather than an error. */
interface LegacySnapshot extends PersistedExtras {
  schemaVersion?: number;
  workspace?: {
    id?: string;
    project?: { path?: string; name?: string; lastOpenedAt?: number } | null;
    createdAt?: number;
    updatedAt?: number;
  } | null;
  profiles?: {
    id?: string;
    name?: string;
    paneTree?: unknown;
    layout?: { focusedTerminalId?: string | null } | null;
    /** Where the Browser tab was pointed. Per-profile in v5, one per app (on
     *  the editor slice) in v6. */
    webPreview?: { url?: string } | null;
    createdAt?: number;
    updatedAt?: number;
  }[];
  activeProfileId?: string | null;
  terminals?: (Partial<TerminalSession> & {
    profileId?: string;
    groupId?: string;
    layoutPosition?: unknown;
  })[];
}

/** Carry the v5 profile's browser URL onto the v6 editor slice.
 *
 *  It is the one field of `profile.webPreview` worth keeping — the rest
 *  (auto-refresh, position) describes a preview pane that no longer exists —
 *  and dropping it is not cosmetic: a user on a non-default dev port comes back
 *  to `DEFAULT_BROWSER_URL`, and the next autosave writes that over the only
 *  copy of what they had. A URL the editor slice already names wins, being the
 *  newer of the two. */
function withBrowserUrl(
  editor: PersistedExtras["editor"],
  url: string | undefined,
): PersistedExtras["editor"] {
  if (typeof url !== "string" || url.trim() === "") return editor;
  if (!editor) return { browserUrl: url, tabs: [], activePath: null };
  return { ...editor, browserUrl: editor.browserUrl || url };
}

/** v1–v5 → v6.
 *
 *  The active profile becomes workspace #1 and keeps its id, so every session
 *  that pointed at it through `profileId` needs only the field renamed to point
 *  at the workspace. Everything else the old model carried is dropped on the
 *  floor deliberately:
 *
 *   - **Other profiles.** A profile was a saved layout inside one project;
 *     a workspace is a project. There is no honest way to turn N layouts of one
 *     directory into N projects, and inventing N copies of the same directory
 *     would be worse than losing the layouts. One `console.warn` says how many
 *     went, because it is the user's data.
 *   - **Groups.** Their whole job — a colour telling panes apart inside one
 *     layout — is now the workspace accent's, one level up.
 *   - **`layout.mode`.** Retired with the five fixed layouts in Phase 1;
 *     `layout.focusedTerminalId` is the one field still worth keeping, and it
 *     moves onto the workspace.
 *
 *  Exported for tests. Total: it returns a valid v6 snapshot for any input,
 *  including one with no profiles at all (which lands as the empty state). */
export function migrateV5(raw: unknown): SnapshotV6 {
  const snap = (raw ?? {}) as LegacySnapshot;
  const profiles = Array.isArray(snap.profiles) ? snap.profiles : [];
  const active =
    profiles.find((p) => p.id === snap.activeProfileId) ?? profiles[0] ?? null;

  const dropped = profiles.length - (active ? 1 : 0);
  if (dropped > 0) {
    console.warn(
      `[persistence] migrated v5 snapshot: ${dropped} inactive profiles dropped`,
    );
  }

  const projectPath = snap.workspace?.project?.path ?? null;
  const recents: RecentProject[] = projectPath
    ? [
        {
          path: projectPath,
          lastOpenedAt:
            snap.workspace?.project?.lastOpenedAt ??
            snap.workspace?.updatedAt ??
            Date.now(),
        },
      ]
    : [];

  if (!active) {
    return {
      version: SCHEMA_VERSION,
      workspaces: [],
      terminals: [],
      activeWorkspaceId: null,
      recents,
      roctalk: snap.roctalk,
      editor: snap.editor,
    };
  }

  // The profile's id carries over as the workspace's, which is what makes the
  // session rewrite below a rename rather than a remap.
  const workspaceId = typeof active.id === "string" ? active.id : newId();
  const workspace: Workspace = {
    id: workspaceId,
    name:
      (projectPath ? directoryTail(projectPath).trim() : "") || "Workspace 1",
    accent: "violet",
    projectPath,
    paneTree: sanitizePaneTree(active.paneTree),
    focusedTerminalId: active.layout?.focusedTerminalId ?? null,
    createdAt: active.createdAt ?? snap.workspace?.createdAt ?? Date.now(),
    updatedAt: active.updatedAt ?? snap.workspace?.updatedAt ?? Date.now(),
  };

  const legacyTerminals = Array.isArray(snap.terminals) ? snap.terminals : [];
  const terminals = legacyTerminals
    // Sessions of a dropped profile go with it: they were panes of a layout
    // that no longer exists, and keeping them would leave orphans no workspace
    // renders and nothing ever closes.
    .filter((t) => t.profileId === undefined || t.profileId === workspaceId)
    .map((t) => sanitizeSession({ ...t, workspaceId }))
    .filter((t): t is TerminalSession => t !== null);

  return {
    version: SCHEMA_VERSION,
    workspaces: [workspace],
    terminals,
    activeWorkspaceId: workspaceId,
    recents,
    roctalk: snap.roctalk,
    editor: withBrowserUrl(snap.editor, active.webPreview?.url),
  };
}

// ---------------------------------------------------------------------------
// Sanitizers
// ---------------------------------------------------------------------------

/** Rebuild a workspace from only the fields the app still owns, or `null` when
 *  the entry is too broken to be one.
 *
 *  Tolerance is deliberately lopsided: an id and a name are what make a row in
 *  the sidebar, so an entry without them is not salvageable — but a bad accent
 *  is a colour and a bad tree is a layout, and neither is worth costing the
 *  user the rest of their snapshot. Both fall back. */
function sanitizeWorkspace(raw: unknown, order: number): Workspace | null {
  if (typeof raw !== "object" || raw === null) return null;
  const w = raw as Partial<Workspace>;
  if (typeof w.id !== "string" || w.id === "") return null;
  const projectPath = typeof w.projectPath === "string" ? w.projectPath : null;
  const name =
    (typeof w.name === "string" ? w.name.trim() : "") ||
    (projectPath ? directoryTail(projectPath) : "") ||
    `Workspace ${order + 1}`;
  return {
    id: w.id,
    name,
    accent: resolveAccent(w.accent, order),
    projectPath,
    paneTree: sanitizePaneTree(w.paneTree),
    focusedTerminalId:
      typeof w.focusedTerminalId === "string" ? w.focusedTerminalId : null,
    createdAt: typeof w.createdAt === "number" ? w.createdAt : Date.now(),
    updatedAt: typeof w.updatedAt === "number" ? w.updatedAt : Date.now(),
  };
}

/** Fill in session fields added after a snapshot was written, and drop the ones
 *  the model retired.
 *
 *  `claudeSessionId` is additive within schema v5 (it describes a process, not
 *  user data, so it never justified a version bump). Snapshots from before it
 *  existed come back with the key missing, and `undefined` on a field the store
 *  and the IPC layer both type as `string | null` leaks straight into the next
 *  save — so normalize on the way in. `groupId` / `layoutPosition` are stripped
 *  by construction: this rebuilds the session field by field rather than
 *  spreading it, so a v5 session cannot smuggle them into the next v6 save. */
function sanitizeSession(raw: unknown): TerminalSession | null {
  if (typeof raw !== "object" || raw === null) return null;
  const t = raw as Partial<TerminalSession>;
  if (typeof t.id !== "string" || t.id === "") return null;
  if (typeof t.workspaceId !== "string" || t.workspaceId === "") return null;
  if (!t.agentConfig) return null;
  return {
    id: t.id,
    workspaceId: t.workspaceId,
    name: t.name ?? "terminal",
    agentConfig: t.agentConfig,
    status: t.status ?? "idle",
    projectPath: t.projectPath ?? "",
    commandHistory: t.commandHistory ?? [],
    output: t.output ?? [],
    createdAt: t.createdAt ?? Date.now(),
    updatedAt: t.updatedAt ?? Date.now(),
    pid: t.pid ?? null,
    claudeSessionId: t.claudeSessionId ?? null,
  };
}

/** Point every workspace's pane tree at its live sessions. Exported so callers
 *  that hydrate the stores by other means can run the same reconciliation. */
export function reconcilePaneTrees(): void {
  const sessions = Object.values(useTerminalsStore.getState().byId);
  const { workspaces, ensurePaneTree } = useWorkspacesStore.getState();
  for (const workspace of workspaces) {
    ensurePaneTree(
      workspace.id,
      sessions.filter((t) => t.workspaceId === workspace.id).map((t) => t.id),
    );
  }
}

/** Whether a path still exists, as the load-time prune asks it.
 *
 *  `fsReadDir(path, path)` is the cheapest existence question the command
 *  surface already answers: it canonicalizes both arguments before doing
 *  anything, so a directory that has been moved or deleted rejects. */
const defaultPathExists: PathExists = async (path) => {
  try {
    await commands.fsReadDir(path, path);
    return true;
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------------------
// Load / save
// ---------------------------------------------------------------------------

let storePromise: Promise<Store> | null = null;
function getStore(): Promise<Store> {
  if (!storePromise) storePromise = Store.load(FILE);
  return storePromise;
}

function readVersion(raw: unknown): number | null {
  if (typeof raw !== "object" || raw === null) return null;
  const snap = raw as { version?: unknown; schemaVersion?: unknown };
  if (typeof snap.version === "number") return snap.version;
  if (typeof snap.schemaVersion === "number") return snap.schemaVersion;
  return null;
}

/** Load saved workspaces and rehydrate the stores. Returns true if a snapshot
 *  existed and produced at least the shape of one. */
export async function loadSnapshot(
  options: { pathExists?: PathExists } = {},
): Promise<boolean> {
  try {
    const store = await getStore();
    const raw = await store.get<unknown>(KEY);
    const version = readVersion(raw);
    if (version === null) return false;

    let snap: SnapshotV6;
    if (version === SCHEMA_VERSION) {
      snap = raw as SnapshotV6;
    } else if (MIGRATABLE_VERSIONS.has(version)) {
      snap = migrateV5(raw);
    } else {
      // From the future, or from nowhere. Refusing beats guessing: a partial
      // read would look like data loss to the user and would be written back
      // over the real thing on the next autosave.
      return false;
    }

    // One bad entry must not cost the rest of the list — a workspace is a whole
    // project's worth of work.
    const workspaces = (Array.isArray(snap.workspaces) ? snap.workspaces : [])
      .map((w, i) => sanitizeWorkspace(w, i))
      .filter((w): w is Workspace => w !== null);
    const live = new Set(workspaces.map((w) => w.id));
    const terminals = (Array.isArray(snap.terminals) ? snap.terminals : [])
      .map(sanitizeSession)
      .filter((t): t is TerminalSession => t !== null)
      // A session whose workspace failed to load has nowhere to be rendered
      // and nothing that would ever close it.
      .filter((t) => live.has(t.workspaceId));

    useWorkspacesStore
      .getState()
      .setWorkspaces(workspaces, snap.activeWorkspaceId ?? null);
    useTerminalsStore.getState().setTerminals(terminals);

    // Reconcile each workspace's split tree against the sessions that actually
    // restored. Runs after both stores are populated, and covers three cases at
    // once: a migrated snapshot (no tree), a rejected tree (sanitized to null),
    // and a tree that names sessions the terminals list no longer has.
    reconcilePaneTrees();

    // Land on the pane the user left off on. Creating a workspace, restoring
    // one and switching to one all do this; a cold boot was the one arrival
    // that did not, and the app-wide focus is not cosmetic. It is what the
    // Inspector points at, what RocTalk dictates into — and what the turn
    // signal reads as "the pane the user is looking at". Starting at null said
    // the user was looking at NOTHING, so the first turn to end in the pane
    // they were staring at glowed and dinged about itself.
    //
    // After `setTerminals`, so the id it lands on is one the terminals store
    // already holds.
    const restored = useWorkspacesStore.getState();
    restoreFocus(
      restored.workspaces.find((w) => w.id === restored.activeWorkspaceId),
    );

    seedRecents(sanitizeRecents(snap.recents));
    // Off the critical path on purpose: the prune is one IPC round trip per
    // remembered directory, and nothing on screen at boot is waiting for it.
    void pruneRecents(options.pathExists ?? defaultPathExists);

    if (snap.roctalk) {
      useRocTalkStore.getState().setEnabled(snap.roctalk.enabled);
      useRocTalkStore.getState().setPosition(snap.roctalk.position);
    }

    if (snap.editor) {
      useEditorStore.setState({
        rightDockMode: snap.editor.rightDockMode ?? "inspector",
        rightPanelCollapsed: snap.editor.rightPanelCollapsed ?? false,
        sidebarCollapsed: snap.editor.sidebarCollapsed ?? false,
        browserUrl: snap.editor.browserUrl || DEFAULT_BROWSER_URL,
        rocViewLayout: snap.editor.rocViewLayout ?? null,
        tabs: snap.editor.tabs ?? [],
        activePath: snap.editor.activePath ?? null,
      });
    }

    if (Array.isArray(snap.mind?.expandedScopes)) {
      useRocMindStore
        .getState()
        .setExpanded(
          snap.mind.expandedScopes.filter(
            (key): key is string => typeof key === "string",
          ),
        );
    }

    return true;
  } catch (err) {
    console.warn("[persistence] loadSnapshot failed:", err);
    return false;
  }
}

/** Build a snapshot from current store state. */
function captureSnapshot(): SnapshotV6 {
  const workspaces = useWorkspacesStore.getState();
  const terminals = useTerminalsStore.getState();
  const roctalk = useRocTalkStore.getState();
  const editor = useEditorStore.getState();
  return {
    version: SCHEMA_VERSION,
    workspaces: workspaces.workspaces,
    activeWorkspaceId: workspaces.activeWorkspaceId,
    terminals: Object.values(terminals.byId),
    recents: [...getRecents()],
    roctalk: { enabled: roctalk.enabled, position: roctalk.position },
    editor: {
      rightDockMode: editor.rightDockMode,
      rightPanelCollapsed: editor.rightPanelCollapsed,
      sidebarCollapsed: editor.sidebarCollapsed,
      browserUrl: editor.browserUrl,
      rocViewLayout: editor.rocViewLayout,
      // Strip pendingLine — we don't want a stale jump-to to fire on reload.
      tabs: editor.tabs.map(({ path, name }) => ({ path, name })),
      activePath: editor.activePath,
    },
    mind: { expandedScopes: useRocMindStore.getState().expandedScopes },
  };
}

let saveTimer: number | null = null;
async function flushSave() {
  saveTimer = null;
  try {
    const store = await getStore();
    await store.set(KEY, captureSnapshot());
    await store.save();
  } catch (err) {
    console.warn("[persistence] save failed:", err);
  }
}

function scheduleSave() {
  if (saveTimer !== null) return;
  saveTimer = window.setTimeout(flushSave, SAVE_DEBOUNCE_MS);
}

/** Subscribe to the persistent stores and trigger a debounced save on change.
 *  Returns an unsubscribe function. */
export function startAutosave(): () => void {
  const unsubA = useWorkspacesStore.subscribe(scheduleSave);
  const unsubB = useTerminalsStore.subscribe(scheduleSave);
  // Only enabled + position persist; amplitude ticks at ~30 Hz during a press,
  // so we gate on the actual persisted fields instead of scheduling on any tick.
  const unsubC = useRocTalkStore.subscribe((s, prev) => {
    if (s.enabled !== prev.enabled || s.position !== prev.position) {
      scheduleSave();
    }
  });
  // Editor: pendingLine is transient — only persist on tab list / active /
  // mode changes. (Avoids a save on every Monaco reveal.)
  const unsubD = useEditorStore.subscribe((s, prev) => {
    if (
      s.rightDockMode !== prev.rightDockMode ||
      s.rightPanelCollapsed !== prev.rightPanelCollapsed ||
      s.browserUrl !== prev.browserUrl ||
      // Roc's three-region split. `captureSnapshot` has always written it, but
      // nothing here asked for a save when it changed, so a dragged divider
      // persisted only if some other store happened to be written afterwards —
      // and a quiet session ended with the drag lost. Safe on the hot path:
      // `setRocViewLayout` fires on drag END, not per pointer move.
      s.rocViewLayout !== prev.rocViewLayout ||
      s.activePath !== prev.activePath ||
      s.tabs.length !== prev.tabs.length ||
      s.tabs.some((t, i) => t.path !== prev.tabs[i]?.path)
    ) {
      scheduleSave();
    }
  });
  // RocMind: only the expanded folders persist. Everything else in that store
  // is a cache of files on disk, and saving on every re-read would mean a write
  // every time an agent touches a memory.
  const unsubMind = useRocMindStore.subscribe((s, prev) => {
    if (s.expandedScopes !== prev.expandedScopes) scheduleSave();
  });
  // Recents are not a store, so they announce their own changes.
  const unsubE = onRecentsChanged(scheduleSave);
  return () => {
    unsubA();
    unsubB();
    unsubC();
    unsubD();
    unsubMind();
    unsubE();
    if (saveTimer !== null) {
      window.clearTimeout(saveTimer);
      saveTimer = null;
    }
  };
}

/** Wipe persisted state (used by "reset workspace" actions and tests). */
export async function clearSnapshot(): Promise<void> {
  seedRecents([]);
  try {
    const store = await getStore();
    await store.delete(KEY);
    await store.save();
  } catch (err) {
    console.warn("[persistence] clearSnapshot failed:", err);
  }
}
