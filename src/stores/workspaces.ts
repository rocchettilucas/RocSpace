/** The workspaces store — one project directory, one pane tree, one accent per
 *  entry, and the sidebar order they sit in.
 *
 *  Replaces `stores/workspace.ts` (a single project) and `stores/profiles.ts`
 *  (layouts + groups inside it). The pane-tree actions moved here verbatim,
 *  workspace-scoped: same semantics, same persistent-tree discipline, so the
 *  dock's zero-remount guarantee is untouched by the rename.
 *
 *  Background workspaces stay LIVE, just unrendered — their PTYs keep running,
 *  Phase 1's output queue keeps draining them, and so do their xterms: the dock
 *  hosts every workspace's cards rather than only the active one's, so a switch
 *  adopts panes that were already drawing instead of rebuilding them from the
 *  ring buffer (see `views/RocDock/PaneTree`). Nothing here hibernates
 *  anything. */

import { current, isDraft } from "immer";
import { create } from "zustand";
import { devtools } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";
import { accentForOrder, WORKSPACE_ACCENTS } from "@/lib/accentColors";
import { nextRocName } from "@/lib/agentLabels";
import { commands } from "@/lib/bindings";
import { newTerminal, newWorkspace } from "@/lib/factories";
import {
  buildBalancedTree,
  hasLeaf,
  leafIds,
  removeLeaf,
  setRatioAt,
  splitLeaf,
  type PaneNode,
  type SplitDirection,
} from "@/lib/paneTree";
import { rememberRecent } from "@/lib/recents";
import { spawnTerminal } from "@/lib/spawn";
import { useSettingsStore } from "@/stores/settings";
// Cyclic with this module, and safe for the same reason `terminals` ↔
// `outputQueue` is: both sides only reach for the other inside a function, long
// after either module finished evaluating. `ui` is cyclic for the same reason:
// it mirrors focus down onto the active workspace, and this module mirrors it
// back up on a switch.
import { useTerminalsStore } from "@/stores/terminals";
import { useUIStore } from "@/stores/ui";
import type {
  AgentType,
  TerminalSession,
  Workspace,
  WorkspaceAccent,
} from "@/lib/bindings";

/** Pane counts the new-workspace modal offers. */
export type WorkspacePaneCount = 1 | 2 | 4 | 6 | 8;

export interface CreateWorkspaceOptions {
  name?: string;
  projectPath: string | null;
  paneCount: WorkspacePaneCount;
  /** Cycled across the panes. Empty falls back to the Settings default. */
  agentTypes: AgentType[];
}

export interface WorkspacesState {
  /** Sidebar order. */
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
}

export interface WorkspacesActions {
  /** Replace the whole list — hydration only. */
  setWorkspaces: (
    workspaces: Workspace[],
    activeWorkspaceId?: string | null,
  ) => void;

  /** Build a workspace, its sessions and its tree, and start their PTYs.
   *  Returns the new workspace's id; it is active by the time this returns. */
  createWorkspace: (opts: CreateWorkspaceOptions) => string;
  /** Adopt a workspace and its sessions that were built elsewhere — the
   *  restore half of a saved session (`lib/savedSessions.ts`).
   *
   *  Same post-conditions as `createWorkspace` except one: it starts nothing.
   *  Which restored panes may spawn is a question about the Claude conversation
   *  each one carries, and the caller is what knows the answer. Returns the
   *  workspace's id, active by the time this returns. */
  restoreWorkspace: (
    workspace: Workspace,
    sessions: readonly TerminalSession[],
  ) => string;
  /** Kill the workspace's PTYs, forget its sessions, drop it. If it was
   *  active, its neighbour takes over; closing the last one leaves the empty
   *  state (null active). */
  closeWorkspace: (id: string) => void;
  renameWorkspace: (id: string, name: string) => void;
  setWorkspaceAccent: (id: string, accent: WorkspaceAccent) => void;
  /** Move a sidebar row. **Remove-then-insert**: the row leaves `fromIndex`
   *  first, so `toIndex` addresses the *shortened* list — dragging the head of
   *  `[A, B, C]` to the end is `(0, 2)` → `[B, C, A]`, and dragging the tail to
   *  the front is `(2, 0)` → `[C, A, B]`. The alternative reading (insert
   *  *before* whichever row currently sits at `toIndex`) lands one place short
   *  on every forward drag, so the two are not interchangeable. Out-of-range
   *  `fromIndex` is ignored; `toIndex` clamps. */
  reorderWorkspace: (fromIndex: number, toIndex: number) => void;
  setActiveWorkspace: (id: string) => void;

  // Pane tree (the workspace's split layout) --------------------------------
  /** Replace `targetTerminalId`'s pane with a split holding it and a new pane
   *  for `newTerminalId`, inserted after it. */
  splitTerminalPane: (
    workspaceId: string,
    targetTerminalId: string,
    direction: SplitDirection,
    newTerminalId: string,
  ) => void;
  /** Drop a pane and promote its sibling. `null` tree = no panes left. */
  removeTerminalPane: (workspaceId: string, terminalId: string) => void;
  /** Commit a divider drag. `path` addresses a split — see `lib/paneTree.ts`. */
  setPaneRatio: (workspaceId: string, path: string, ratio: number) => void;
  /** Make the tree describe exactly `terminalIds`, rebuilding it balanced when
   *  it is missing or stale. Called on hydrate and on creation. */
  ensurePaneTree: (workspaceId: string, terminalIds: readonly string[]) => void;
  setFocusedTerminal: (workspaceId: string, terminalId: string | null) => void;
}

const initialState: WorkspacesState = {
  workspaces: [],
  activeWorkspaceId: null,
};

const findMut = (workspaces: Workspace[], id: string) =>
  workspaces.find((w) => w.id === id);

/** Plain snapshot of a tree read off an immer draft.
 *
 *  `lib/paneTree.ts` structurally shares the branches it does not rewrite, so
 *  handing it a draft would leave draft proxies embedded in the value we assign
 *  back — and its `!==` "nothing changed" contract compares proxy identity, not
 *  the underlying node. `current()` costs one shallow walk and removes both
 *  problems. */
const readTree = (tree: PaneNode | null | undefined): PaneNode | null => {
  if (!tree) return null;
  return isDraft(tree) ? (current(tree) as PaneNode) : tree;
};

/** The accent a workspace opened now should wear: the first slot no live
 *  workspace is using, and only once all six are taken, the order-based cycle.
 *
 *  Asking `accentForOrder` for the list's *length* instead collides after any
 *  close — four workspaces minus the second leaves three, so the next create
 *  asks for slot 3 again and gets a second amber while cyan sits free. The
 *  accent is how the user tells one project's panes from another's at a
 *  glance, so a duplicate is a real cost.
 *
 *  Exported because a restore has the same question with one extra clause:
 *  keep the accent the session was saved with if it is free, and fall back to
 *  this when it is not (`lib/savedSessions.ts`). */
export function nextAccent(workspaces: readonly Workspace[]): WorkspaceAccent {
  const inUse = new Set(workspaces.map((w) => w.accent));
  return (
    WORKSPACE_ACCENTS.find((accent) => !inUse.has(accent)) ??
    accentForOrder(workspaces.length)
  );
}

/** Put the app-wide focus back on the pane `workspace` was last left on.
 *
 *  `focusedTerminalId` is written on every pane click but read by nobody until
 *  here, which is the whole reason it is persisted: a switch that left the
 *  app-wide focus where it was would point the Inspector at a pane the dock no
 *  longer renders — and RocTalk dictates into whatever the app-wide focus says,
 *  so it would type into the background workspace's PTY.
 *
 *  Going through `focusTerminal` rather than writing `useUIStore` directly
 *  keeps the two halves in sync: it mirrors the value straight back onto the
 *  now-active workspace, which is a no-op here because it is the value we just
 *  read off that same workspace.
 *
 *  Exported for `lib/persistence.ts`: a cold boot arrives at a workspace like
 *  every other caller here does, and was the one that did not say so. */
export function restoreFocus(workspace: Workspace | null | undefined): void {
  useUIStore.getState().focusTerminal(workspace?.focusedTerminalId ?? null);
}

/** How `createWorkspace` starts a PTY.
 *
 *  Injected rather than called directly so the store is unit-testable without
 *  a Tauri runtime: a test swaps in a recorder and gets the sessions the
 *  creation produced, in order, with nothing crossing the IPC boundary. */
type SessionSpawner = (session: TerminalSession) => void;

const defaultSpawner: SessionSpawner = (session) => {
  void spawnTerminal(session);
};

let spawnSession: SessionSpawner = defaultSpawner;

/** Swap the spawner. Returns a restore function — call it in a test teardown
 *  so one suite cannot leak its recorder into the next. */
export function setWorkspaceSpawner(next: SessionSpawner): () => void {
  const previous = spawnSession;
  spawnSession = next;
  return () => {
    spawnSession = previous;
  };
}

export const useWorkspacesStore = create<WorkspacesState & WorkspacesActions>()(
  devtools(
    immer((set, get) => ({
      ...initialState,

      setWorkspaces: (workspaces, activeWorkspaceId) =>
        set((s) => {
          s.workspaces = workspaces;
          if (activeWorkspaceId !== undefined) {
            // Only honour an id the list actually holds — a snapshot can name
            // a workspace whose entry failed validation on the way in.
            s.activeWorkspaceId = workspaces.some(
              (w) => w.id === activeWorkspaceId,
            )
              ? activeWorkspaceId
              : (workspaces[0]?.id ?? null);
          } else if (
            s.activeWorkspaceId === null ||
            !workspaces.some((w) => w.id === s.activeWorkspaceId)
          ) {
            s.activeWorkspaceId = workspaces[0]?.id ?? null;
          }
        }),

      createWorkspace: (opts) => {
        const workspace = newWorkspace({
          name: opts.name,
          projectPath: opts.projectPath,
          order: get().workspaces.length,
          accent: nextAccent(get().workspaces),
        });

        // Names come from the roc pool, per workspace: a fresh workspace starts
        // at Rocky whatever the other workspaces are called, because the taken
        // set that matters is the one the user sees in this dock.
        const taken = new Set<string>();
        const fallbackAgent =
          useSettingsStore.getState().agentDefaults.agentType;
        const agentTypes =
          opts.agentTypes.length > 0 ? opts.agentTypes : [fallbackAgent];

        const sessions: TerminalSession[] = [];
        for (let i = 0; i < opts.paneCount; i++) {
          const name = nextRocName(taken);
          taken.add(name);
          sessions.push(
            newTerminal({
              workspaceId: workspace.id,
              name,
              agentType: agentTypes[i % agentTypes.length]!,
              // "" is the cwd-less spawn Rust already understands (it falls
              // back to the user's home), which is what a null path means.
              projectPath: opts.projectPath ?? "",
            }),
          );
        }

        workspace.paneTree = buildBalancedTree(sessions.map((t) => t.id));
        workspace.focusedTerminalId = sessions[0]?.id ?? null;

        set((s) => {
          s.workspaces.push(workspace);
          s.activeWorkspaceId = workspace.id;
        });

        for (const session of sessions) {
          useTerminalsStore.getState().addTerminal(session);
        }
        // A create is a switch — it makes the new workspace active — so the
        // app-wide focus has to move with it, or the Inspector and RocTalk stay
        // pointed at the previous workspace's pane. After `addTerminal`, so the
        // id it lands on is one the terminals store already holds.
        restoreFocus(workspace);
        // The directory is worth offering again whether or not the panes come
        // up, so this is recorded before the spawns rather than after them.
        rememberRecent(opts.projectPath);
        // After the store writes, so anything the spawn reports back (pid,
        // Claude session uuid) lands on a session the store already holds.
        for (const session of sessions) spawnSession(session);

        return workspace.id;
      },

      restoreWorkspace: (workspace, sessions) => {
        set((s) => {
          s.workspaces.push(workspace);
          s.activeWorkspaceId = workspace.id;
        });
        for (const session of sessions) {
          useTerminalsStore.getState().addTerminal(session);
        }
        // Same ordering as `createWorkspace`: after `addTerminal`, so the id
        // the focus lands on is one the terminals store already holds.
        restoreFocus(workspace);
        rememberRecent(workspace.projectPath);
        return workspace.id;
      },

      closeWorkspace: (id) => {
        const doomed = Object.values(useTerminalsStore.getState().byId).filter(
          (t) => t.workspaceId === id,
        );
        for (const session of doomed) {
          commands.terminalKill(session.id).catch(() => {
            /* non-fatal: the child may already be gone */
          });
        }
        for (const session of doomed) {
          useTerminalsStore.getState().removeTerminal(session.id);
        }

        set((s) => {
          const index = s.workspaces.findIndex((w) => w.id === id);
          if (index === -1) return;
          s.workspaces.splice(index, 1);
          if (s.activeWorkspaceId !== id) return;
          // The neighbour that slid into the closed one's place, or the one
          // before it when the last row went.
          s.activeWorkspaceId =
            s.workspaces[index]?.id ?? s.workspaces[index - 1]?.id ?? null;
        });

        // `useUIStore` holds app-wide terminal ids, not workspace-scoped ones,
        // so nothing above has moved them off the sessions this just deleted —
        // and a focus naming a dead session is a RocTalk dictation into a PTY
        // that is gone. Resync from whatever is active now: the neighbour's own
        // remembered pane, or null when that was the last workspace.
        const dead = new Set(doomed.map((session) => session.id));
        const ui = useUIStore.getState();
        if (ui.maximizedTerminalId !== null && dead.has(ui.maximizedTerminalId))
          ui.exitMaximize();
        if (ui.focusedTerminalId !== null && dead.has(ui.focusedTerminalId)) {
          const { workspaces, activeWorkspaceId } = get();
          restoreFocus(workspaces.find((w) => w.id === activeWorkspaceId));
        }

        // …and the main view, for the same class of reason one surface out.
        //
        // RocPlan, Roc and RocMind are all drawn by `AppShell`, which `App`
        // stops rendering when the last workspace goes — so `mainView` is left
        // naming a surface that is not on screen and cannot be, and the chords
        // that would move it back (⌘⇧P, ⌘⇧R, ⌘⇧M) are in the shell with it.
        // Nothing looks wrong until the next ⌘T, which opens the new workspace
        // onto the board instead of onto its panes.
        //
        // Only when the list is EMPTY: closing one of several workspaces while
        // reading the board should leave the user on the board, which is the
        // neighbour's board and is exactly where they were.
        if (get().workspaces.length === 0 && ui.mainView !== "terminals") {
          ui.setMainView("terminals");
        }
      },

      renameWorkspace: (id, name) =>
        set((s) => {
          const w = findMut(s.workspaces, id);
          const next = name.trim();
          // An empty name would leave the row with nothing to be addressed by,
          // so it reads as a cancel rather than as a valid new name.
          if (!w || next === "") return;
          w.name = next;
          w.updatedAt = Date.now();
        }),

      setWorkspaceAccent: (id, accent) =>
        set((s) => {
          const w = findMut(s.workspaces, id);
          if (!w) return;
          w.accent = accent;
          w.updatedAt = Date.now();
        }),

      reorderWorkspace: (fromIndex, toIndex) =>
        set((s) => {
          const last = s.workspaces.length - 1;
          if (fromIndex < 0 || fromIndex > last) return;
          const to = Math.min(Math.max(toIndex, 0), last);
          if (to === fromIndex) return;
          // Remove-then-insert — see the contract on `WorkspacesActions`. The
          // insert reads `to` against the list this splice already shortened.
          const [moved] = s.workspaces.splice(fromIndex, 1);
          if (!moved) return;
          s.workspaces.splice(to, 0, moved);
        }),

      setActiveWorkspace: (id) => {
        const workspace = get().workspaces.find((w) => w.id === id);
        if (!workspace) return;
        set((s) => {
          s.activeWorkspaceId = id;
        });
        // After the write, so the focus mirrors onto the workspace we just
        // switched *to*.
        restoreFocus(workspace);
      },

      splitTerminalPane: (
        workspaceId,
        targetTerminalId,
        direction,
        newTerminalId,
      ) =>
        set((s) => {
          const w = findMut(s.workspaces, workspaceId);
          if (!w) return;
          const tree = readTree(w.paneTree);
          // One terminal, one pane. `splitLeaf` enforces this itself, but the
          // missing-target branch below bypasses it — it appends the new pane
          // without consulting the tree — so the guard belongs here too.
          if (tree !== null && hasLeaf(tree, newTerminalId)) return;
          // No tree yet, or a tree that has never heard of the split target
          // (a session created while the tree was stale): put the new pane
          // beside the whole layout rather than dropping it on the floor. It
          // is spawning a PTY either way — it has to be reachable.
          if (tree === null) {
            w.paneTree = splitLeaf(
              { kind: "leaf", terminalId: targetTerminalId },
              targetTerminalId,
              direction,
              newTerminalId,
            );
          } else if (!hasLeaf(tree, targetTerminalId)) {
            w.paneTree = {
              kind: "split",
              direction,
              ratio: 0.5,
              first: tree,
              second: { kind: "leaf", terminalId: newTerminalId },
            };
          } else {
            w.paneTree = splitLeaf(
              tree,
              targetTerminalId,
              direction,
              newTerminalId,
            );
          }
          w.updatedAt = Date.now();
        }),

      removeTerminalPane: (workspaceId, terminalId) =>
        set((s) => {
          const w = findMut(s.workspaces, workspaceId);
          if (!w) return;
          const tree = readTree(w.paneTree);
          if (tree === null) return;
          const next = removeLeaf(tree, terminalId);
          if (next === tree) return;
          w.paneTree = next;
          w.updatedAt = Date.now();
        }),

      setPaneRatio: (workspaceId, path, ratio) =>
        set((s) => {
          const w = findMut(s.workspaces, workspaceId);
          if (!w) return;
          const tree = readTree(w.paneTree);
          if (tree === null) return;
          const next = setRatioAt(tree, path, ratio);
          // A no-op drag (clamped to where it already was, or a path from a
          // tree that has since changed shape) must not schedule an autosave.
          if (next === tree) return;
          w.paneTree = next;
          // Deliberately no `updatedAt` bump: divider drags are the
          // highest-frequency write in the app, and the store subscription
          // already debounces a save for them.
        }),

      ensurePaneTree: (workspaceId, terminalIds) =>
        set((s) => {
          const w = findMut(s.workspaces, workspaceId);
          if (!w) return;
          const tree = readTree(w.paneTree);
          if (tree !== null) {
            const inTree = leafIds(tree);
            const wanted = new Set(terminalIds);
            if (
              inTree.length === wanted.size &&
              inTree.every((id) => wanted.has(id))
            ) {
              return;
            }
          }
          // Stale: a session was added or removed without going through the
          // pane actions (a restored snapshot, a fresh workspace). Rebuilding
          // balanced loses the user's ratios, which is the honest outcome —
          // the tree no longer describes what exists.
          w.paneTree = buildBalancedTree(terminalIds);
        }),

      setFocusedTerminal: (workspaceId, terminalId) =>
        set((s) => {
          const w = findMut(s.workspaces, workspaceId);
          // No `updatedAt` bump: focus follows the pointer around the dock and
          // is not an edit to the layout.
          if (w) w.focusedTerminalId = terminalId;
        }),
    })),
    { name: "workspaces" },
  ),
);

// Selectors --------------------------------------------------------------

export const useWorkspaces = (): Workspace[] =>
  useWorkspacesStore((s) => s.workspaces);

export const useActiveWorkspaceId = (): string | null =>
  useWorkspacesStore((s) => s.activeWorkspaceId);

export const useActiveWorkspace = (): Workspace | null =>
  useWorkspacesStore((s) =>
    s.activeWorkspaceId
      ? (s.workspaces.find((w) => w.id === s.activeWorkspaceId) ?? null)
      : null,
  );

export const useWorkspaceById = (id: string | null): Workspace | null =>
  useWorkspacesStore((s) =>
    id ? (s.workspaces.find((w) => w.id === id) ?? null) : null,
  );

/** The active workspace's split tree. Safe as an effect dependency: the tree is
 *  persistent, so its identity changes exactly when the layout does and not on
 *  any of the unrelated writes the store sees. */
export const useActiveWorkspacePaneTree = (): PaneNode | null =>
  useWorkspacesStore((s) =>
    s.activeWorkspaceId
      ? (s.workspaces.find((w) => w.id === s.activeWorkspaceId)?.paneTree ??
        null)
      : null,
  );
