import { create } from "zustand";

/** Ephemeral, per-terminal runtime flags that don't belong on the persisted
 *  TerminalSession (which mirrors a Rust-bound type). Lives in renderer-only
 *  state because the answer can change without any backend involvement.
 *
 *  `hasUserInput` is set to true the first time the user types into a given
 *  terminal since its last fresh PTY boot. Multiple call sites read it to
 *  gate "first-launch" UI noise:
 *    - TerminalCard suppresses the green ready-glow until the user has typed
 *    - notificationsBridge suppresses awaiting/complete/error notifications
 *      until the user has typed
 *
 *  The flag is reset whenever Rust emits a fresh `running` status (= new PTY
 *  spawn or restart), so a restarted terminal's auto-launched agent banner
 *  doesn't fire stale "awaiting/complete" UX again.
 *
 *  `configDirty` answers "has the agent config been edited since the process
 *  that is running was started?". Agent config is baked into the CLI's argv at
 *  spawn time, so an Inspector edit changes nothing until the pane restarts —
 *  this is what lets the Inspector say so instead of pretending. Ephemeral for
 *  the same reason `hasUserInput` is: it describes a live process, and after a
 *  reload there is none.
 *
 *  `resumableClaudeSessions` answers "is there a Claude conversation this pane
 *  could pick up, and is nothing running in it?". The pane's own
 *  `claudeSessionId` cannot answer that alone: it is set both by a live spawn
 *  and by a snapshot of a conversation whose process died with the last quit,
 *  and `ptyBridge` has to tell those apart or it hands a dead pane's status to
 *  hooks that will never fire (see `isHookDriven`). An entry here is what says
 *  "this uuid is an offer" — parked by `hydration.ts` for a pane it did not
 *  respawn, and by a restore for the panes it did not start, and spent by
 *  `spawnTerminal` the moment one of them is actually started.
 *
 *  `turnFinished` answers "did this pane's agent end a turn while you were
 *  looking somewhere else?" — the green glow's whole state. Set by
 *  `notificationsBridge`, which owns the "am I looking at it" rule, and cleared
 *  the moment the pane becomes the one you are watching or a new turn starts.
 *  It lives here rather than on the session because it describes the RENDERER's
 *  relationship to the pane rather than the pane: the same conversation,
 *  reloaded tomorrow, is not unread.
 */
interface TerminalRuntimeState {
  hasUserInput: Record<string, boolean>;
  configDirty: Record<string, boolean>;
  resumableClaudeSessions: Record<string, string>;
  turnFinished: Record<string, boolean>;
  notifyUserInput: (id: string) => void;
  resetUserInput: (id: string) => void;
  /** Called by every action that edits an agent config. */
  markConfigDirty: (id: string) => void;
  /** Called on spawn — the new process carries the current config. */
  clearConfigDirty: (id: string) => void;
  /** Park a Claude conversation this pane can be resumed into — a snapshot
   *  hydrated at boot, or a restored saved session. */
  markResumable: (id: string, claudeSessionId: string) => void;
  /** The user answered (resume, or start fresh), or the pane started some
   *  other way. Either way the offer is spent. */
  clearResumable: (id: string) => void;
  /** This pane's agent ended a turn and the user was looking elsewhere. */
  markTurnFinished: (id: string) => void;
  /** The user is looking at it now, or a new turn has started. */
  clearTurnFinished: (id: string) => void;
  /** Called when a terminal is deleted. Every map here is keyed by terminal id
   *  and nothing else ever removes an entry, so without this a long session
   *  accumulates a record per pane the user ever closed. */
  forgetTerminal: (id: string) => void;
}

export const useTerminalRuntimeStore = create<TerminalRuntimeState>((set) => ({
  hasUserInput: {},
  configDirty: {},
  resumableClaudeSessions: {},
  turnFinished: {},
  notifyUserInput: (id) =>
    set((s) => {
      if (s.hasUserInput[id]) return s;
      return { hasUserInput: { ...s.hasUserInput, [id]: true } };
    }),
  resetUserInput: (id) =>
    set((s) => {
      if (!s.hasUserInput[id]) return s;
      const next = { ...s.hasUserInput };
      delete next[id];
      return { hasUserInput: next };
    }),
  markConfigDirty: (id) =>
    set((s) => {
      if (s.configDirty[id]) return s;
      return { configDirty: { ...s.configDirty, [id]: true } };
    }),
  clearConfigDirty: (id) =>
    set((s) => {
      if (!s.configDirty[id]) return s;
      const next = { ...s.configDirty };
      delete next[id];
      return { configDirty: next };
    }),
  markResumable: (id, claudeSessionId) =>
    set((s) => {
      if (s.resumableClaudeSessions[id] === claudeSessionId) return s;
      return {
        resumableClaudeSessions: {
          ...s.resumableClaudeSessions,
          [id]: claudeSessionId,
        },
      };
    }),
  clearResumable: (id) =>
    set((s) => {
      if (!(id in s.resumableClaudeSessions)) return s;
      const next = { ...s.resumableClaudeSessions };
      delete next[id];
      return { resumableClaudeSessions: next };
    }),
  markTurnFinished: (id) =>
    set((s) => {
      if (s.turnFinished[id]) return s;
      return { turnFinished: { ...s.turnFinished, [id]: true } };
    }),
  clearTurnFinished: (id) =>
    set((s) => {
      if (!s.turnFinished[id]) return s;
      const next = { ...s.turnFinished };
      delete next[id];
      return { turnFinished: next };
    }),
  forgetTerminal: (id) =>
    set((s) => {
      if (
        !(id in s.hasUserInput) &&
        !(id in s.configDirty) &&
        !(id in s.resumableClaudeSessions) &&
        !(id in s.turnFinished)
      ) {
        return s;
      }
      const hasUserInput = { ...s.hasUserInput };
      const configDirty = { ...s.configDirty };
      const resumableClaudeSessions = { ...s.resumableClaudeSessions };
      const turnFinished = { ...s.turnFinished };
      delete hasUserInput[id];
      delete configDirty[id];
      delete resumableClaudeSessions[id];
      delete turnFinished[id];
      return {
        hasUserInput,
        configDirty,
        resumableClaudeSessions,
        turnFinished,
      };
    }),
}));

export const useTerminalHasUserInput = (id: string): boolean =>
  useTerminalRuntimeStore((s) => !!s.hasUserInput[id]);

export const useTerminalConfigDirty = (id: string): boolean =>
  useTerminalRuntimeStore((s) => !!s.configDirty[id]);

/** The Claude conversation this pane could be resumed into, or null. */
export const useResumableClaudeSession = (id: string): string | null =>
  useTerminalRuntimeStore((s) => s.resumableClaudeSessions[id] ?? null);

/** Did this pane's agent end a turn while the user was looking elsewhere? */
export const useTerminalTurnFinished = (id: string): boolean =>
  useTerminalRuntimeStore((s) => !!s.turnFinished[id]);
