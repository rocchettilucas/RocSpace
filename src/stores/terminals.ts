import { create } from "zustand";
import { devtools } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";
// Cyclic with this module (the queue writes here every frame), and safe: both
// sides only reach for the other inside a function, long after either module
// finished evaluating. The same holds for the workspaces store below, which
// reaches back here to build and tear down a workspace's sessions.
import { enqueueClear } from "@/lib/outputQueue";
import { leafIds } from "@/lib/paneTree";
import { useActiveWorkspace, useActiveWorkspaceId } from "@/stores/workspaces";
import { useTerminalRuntimeStore } from "@/stores/terminalRuntime";
import type {
  AgentConfig,
  PermissionSettings,
  SpawnResult,
  TerminalOutputLine,
  TerminalSession,
  TerminalStatus,
} from "@/lib/bindings";
import { LIMITS } from "@/lib/limits";

/** Cap on retained output lines per terminal in the renderer. Full transcripts
 * live in Rust (Phase 8+); this ring buffer keeps the UI responsive. */
export const OUTPUT_RING_BUFFER_CAP = LIMITS.outputRingLines;

interface TerminalsState {
  /** The single source of truth for terminal sessions. Indexed by id for O(1)
   *  lookup; render order comes from the owning workspace's pane tree. */
  byId: Record<string, TerminalSession>;
}

interface TerminalsActions {
  setTerminals: (terminals: TerminalSession[]) => void;
  addTerminal: (terminal: TerminalSession) => void;
  removeTerminal: (id: string) => void;

  renameTerminal: (id: string, name: string) => void;
  setStatus: (id: string, status: TerminalStatus) => void;
  /** Record the identity of a freshly spawned PTY (pid + Claude session uuid).
   *  Called from `spawnTerminal`; both fields describe the live process, so a
   *  spawn that reports neither clears whatever the previous one left behind. */
  recordSpawn: (id: string, result: SpawnResult) => void;
  /** Forget a process identity that no longer describes anything running.
   *  Used when a snapshot is hydrated: `pid` and `claudeSessionId` come back
   *  from disk describing processes that died with the last quit.
   *
   *  `keepClaudeSession` leaves the uuid on the session. A cold Claude pane's
   *  uuid is the *offer* to resume that conversation, and the offer has to
   *  outlive the run it was made in — the runtime store's copy of it does not
   *  survive a quit, so clearing this one made the offer good for exactly one
   *  boot. Nothing mistakes a parked uuid for a live process: `ptyBridge` asks
   *  whether an offer is standing over the pane (see `isHookDriven`). */
  clearSpawnIdentity: (
    id: string,
    options?: { keepClaudeSession?: boolean },
  ) => void;
  setAgentConfig: (id: string, agentConfig: AgentConfig) => void;
  setPermissions: (id: string, permissions: PermissionSettings) => void;
  setTaskPrompt: (id: string, prompt: string | null) => void;

  /** Append a single output line — high-frequency call from the streamer.
   * Drops oldest lines once the ring buffer cap is exceeded. */
  appendOutputLine: (id: string, line: TerminalOutputLine) => void;
  /** Append a whole animation frame's worth of output, for every streaming
   *  terminal at once.
   *
   *  This is the hot path (`outputQueue`), and it is one action rather than a
   *  loop over `appendOutputLine` because the cost that matters is the *store
   *  write*, not the append: every write re-runs every selector and re-renders
   *  every mounted card, so eight panes streaming at PTY rate is thousands of
   *  those a second. Batched, it is one per frame. Entries for terminals the
   *  store no longer holds are skipped — output can outlive the session it
   *  came from by a frame. */
  appendOutputBatch: (batch: readonly TerminalOutputBatchEntry[]) => void;
  /** Empty a terminal's scrollback — the ring buffer here AND the pane on
   *  screen, which holds its own and is not driven by this store. */
  clearOutput: (id: string) => void;
}

/** One terminal's share of a flush. */
export interface TerminalOutputBatchEntry {
  terminalId: string;
  lines: readonly TerminalOutputLine[];
}

const initialState: TerminalsState = {
  byId: {},
};

/** Append to a session's ring buffer, dropping the oldest lines once it is
 *  over cap. Written as one trim after the whole append so a batch pays for it
 *  once rather than per line. */
function pushWithinCap(
  terminal: TerminalSession,
  lines: readonly TerminalOutputLine[],
): void {
  for (const line of lines) terminal.output.push(line);
  if (terminal.output.length > OUTPUT_RING_BUFFER_CAP) {
    terminal.output.splice(0, terminal.output.length - OUTPUT_RING_BUFFER_CAP);
  }
}

export const useTerminalsStore = create<TerminalsState & TerminalsActions>()(
  devtools(
    immer((set) => ({
      ...initialState,

      setTerminals: (terminals) =>
        set((s) => {
          s.byId = {};
          for (const t of terminals) s.byId[t.id] = t;
        }),

      addTerminal: (terminal) =>
        set((s) => {
          s.byId[terminal.id] = terminal;
        }),

      removeTerminal: (id) =>
        set((s) => {
          delete s.byId[id];
          // The ephemeral runtime flags are keyed by terminal id and nothing
          // else drops an entry, so a deleted pane would leave its
          // `hasUserInput` / `configDirty` records behind forever.
          useTerminalRuntimeStore.getState().forgetTerminal(id);
        }),

      renameTerminal: (id, name) =>
        set((s) => {
          const t = s.byId[id];
          if (t) {
            t.name = name;
            t.updatedAt = Date.now();
          }
        }),

      setStatus: (id, status) =>
        set((s) => {
          const t = s.byId[id];
          if (t && t.status !== status) {
            t.status = status;
            t.updatedAt = Date.now();
          }
        }),

      recordSpawn: (id, result) =>
        set((s) => {
          const t = s.byId[id];
          if (!t) return;
          t.pid = result.pid;
          t.claudeSessionId = result.claudeSessionId;
          t.updatedAt = Date.now();
        }),

      clearSpawnIdentity: (id, options) =>
        set((s) => {
          const t = s.byId[id];
          if (!t) return;
          const claudeSessionId = options?.keepClaudeSession
            ? t.claudeSessionId
            : null;
          if (t.pid === null && t.claudeSessionId === claudeSessionId) return;
          t.pid = null;
          t.claudeSessionId = claudeSessionId;
          t.updatedAt = Date.now();
        }),

      setAgentConfig: (id, agentConfig) =>
        set((s) => {
          const t = s.byId[id];
          if (t) {
            t.agentConfig = agentConfig;
            t.updatedAt = Date.now();
          }
        }),

      setPermissions: (id, permissions) =>
        set((s) => {
          const t = s.byId[id];
          if (t) {
            t.agentConfig.permissions = permissions;
            t.updatedAt = Date.now();
          }
        }),

      setTaskPrompt: (id, prompt) =>
        set((s) => {
          const t = s.byId[id];
          if (t) {
            t.agentConfig.taskPrompt = prompt;
            t.updatedAt = Date.now();
          }
        }),

      appendOutputLine: (id, line) =>
        set((s) => {
          const t = s.byId[id];
          if (t) pushWithinCap(t, [line]);
        }),

      appendOutputBatch: (batch) =>
        set((s) => {
          for (const { terminalId, lines } of batch) {
            const t = s.byId[terminalId];
            if (t) pushWithinCap(t, lines);
          }
        }),

      clearOutput: (id) =>
        set((s) => {
          const t = s.byId[id];
          if (!t) return;
          t.output.length = 0;
          // Side effect inside the recipe, as with `forgetTerminal` above.
          // Emptying the ring is only half of clearing a pane: the xterm
          // instance holds its own scrollback and does not read this store.
          // It goes through the output queue rather than at the terminal
          // directly so it lands in order with the bytes still waiting for a
          // frame — written after it, those would survive the clear.
          enqueueClear(id);
        }),
    })),
    { name: "terminals" },
  ),
);

// Selectors --------------------------------------------------------------

const EMPTY_TERMINALS: TerminalSession[] = [];

export const useTerminalById = (id: string | null): TerminalSession | null => {
  return useTerminalsStore((s) => (id ? (s.byId[id] ?? null) : null));
};

/** The active workspace's terminals, in its pane tree's render order.
 *
 *  The tree is the ordering authority now that `layoutPosition` is gone: it is
 *  what the user sees, and the only thing that still says which pane is where.
 *  Sessions the tree has not heard of yet (created a tick before the split
 *  landed) come after it, so a "launch all" never misses one. */
export const useActiveWorkspaceTerminals = (): TerminalSession[] => {
  const workspace = useActiveWorkspace();
  const byId = useTerminalsStore((s) => s.byId);
  if (!workspace) return EMPTY_TERMINALS;
  const mine = Object.values(byId).filter(
    (t) => t.workspaceId === workspace.id,
  );
  const order = new Map(
    (workspace.paneTree ? leafIds(workspace.paneTree) : []).map((id, i) => [
      id,
      i,
    ]),
  );
  const rank = (t: TerminalSession) =>
    order.get(t.id) ?? Number.MAX_SAFE_INTEGER;
  mine.sort((a, b) => rank(a) - rank(b) || a.createdAt - b.createdAt);
  return mine;
};

/** How many sessions the active workspace owns. A primitive, so components can
 *  use it as an effect dependency without re-render churn. */
export const useActiveWorkspaceTerminalCount = (): number => {
  const activeWorkspaceId = useActiveWorkspaceId();
  return useTerminalsStore((s) => {
    if (!activeWorkspaceId) return 0;
    let n = 0;
    // for..in over the keys rather than Object.values(): this selector re-runs
    // on EVERY store write, including appendOutputLine for each PTY chunk, so
    // materializing an N-element array here would allocate once per chunk per
    // mounted subscriber.
    for (const id in s.byId) {
      if (s.byId[id]!.workspaceId === activeWorkspaceId) n++;
    }
    return n;
  });
};

/** Whether `workspaceId` has room for another session.
 *
 *  The one place the per-workspace cap is applied. Exported as a plain function
 *  as well as a hook so the imperative check (`paneActions.canAddPane`, called
 *  from event handlers) and the reactive one below cannot drift apart. */
export function hasPaneRoom(
  byId: Record<string, TerminalSession>,
  workspaceId: string | null,
): boolean {
  if (!workspaceId) return false;
  let n = 0;
  for (const id in byId) {
    // Short-circuits at the cap rather than counting the whole map: this runs
    // on every terminals-store write, output chunks included.
    if (
      byId[id]!.workspaceId === workspaceId &&
      ++n >= LIMITS.terminalsPerWorkspace
    ) {
      return false;
    }
  }
  return true;
}

/** Reactive form of `hasPaneRoom`, for controls that gate on the cap.
 *
 *  Components must subscribe rather than call the plain function during render:
 *  read imperatively, the answer is only as fresh as whatever unrelated thing
 *  last re-rendered the component, which makes a disabled state correct by
 *  coincidence. */
export const useCanAddPane = (workspaceId: string | null): boolean => {
  return useTerminalsStore((s) => hasPaneRoom(s.byId, workspaceId));
};
