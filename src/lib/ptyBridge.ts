/** Bridges the Rust PTY runtime to the renderer Zustand stores.
 *  Subscribes to `terminal://output`, `terminal://status` and `agent://status`.
 *  Status events dispatch straight to the store; output is handed to
 *  `outputQueue`, which writes it to xterm and the ring buffer once per
 *  animation frame. Mount once at app start. */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  EVENT_AGENT_STATUS,
  EVENT_TERMINAL_OUTPUT,
  EVENT_TERMINAL_STATUS,
  type AgentStatusEvent,
  type TerminalOutputEvent,
  type TerminalStatusEvent,
} from "@/lib/bindings";
import { enqueueOutput } from "@/lib/outputQueue";
import { useTerminalsStore, useTerminalRuntimeStore } from "@/stores";

/** Re-exported here because this module is the PTY event surface: everything
 *  that arrives on `terminal://output` leaves through the queue's frame loop,
 *  and a test that drives one wants the other. Implementation lives in
 *  `@/lib/outputQueue`. */
export { flushOutputQueues } from "@/lib/outputQueue";

/**
 * Silence duration before a running terminal transitions to awaiting_approval.
 *
 * This is a guess, and it is wrong whenever a tool call takes longer than the
 * timeout — a known misfire kept only for the agents that give us nothing
 * better (codex, opencode, plain shells). Claude Code panes carry a
 * `claudeSessionId` and get their status from lifecycle hooks instead; see
 * `isHookDriven`.
 */
const IDLE_MS = 1500;

/** Per-terminal idle timer. Cleared on any new output or non-running status. */
const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** True when the terminal's agent reports its own lifecycle (Claude Code with
 *  hooks wired up at spawn). For these, hook events are authoritative: the
 *  silence heuristic is disabled and raw output never moves the status, so a
 *  permission prompt that keeps painting the screen cannot erase the
 *  `awaiting_approval` the hook just set.
 *
 *  A uuid alone does not say that. A pane hydrated from a snapshot keeps the
 *  conversation it was in so the resume offer survives more than one boot (see
 *  `lib/hydration.ts`), and that conversation's process died with the last
 *  quit — no hook will ever fire for it again, which is how a cold pane's dot
 *  used to freeze for the whole session. The parked offer is the discriminator:
 *  it exists exactly while the uuid is a question rather than a running
 *  process, and `spawnTerminal` clears it the moment one is started.
 *
 *  Exported for `notificationsBridge`, which asks it about a different thing
 *  and gets the same answer: `idle` only MEANS "a turn ended" when the pane is
 *  one whose agent says so itself. */
export function isHookDriven(terminalId: string): boolean {
  const terminal = useTerminalsStore.getState().byId[terminalId];
  if (!terminal?.claudeSessionId) return false;
  return !useTerminalRuntimeStore.getState().resumableClaudeSessions[
    terminalId
  ];
}

/** Forwards user-input signal to the shared runtime store so the idle watchdog
 *  AND the notifications bridge AND the TerminalCard glow gate all stay in
 *  sync about whether this terminal has been touched yet. */
export function notifyTerminalUserInput(terminalId: string): void {
  useTerminalRuntimeStore.getState().notifyUserInput(terminalId);
  // Answering a permission prompt is a keystroke, and no hook fires for it —
  // Claude Code's next signal may not arrive until the whole turn ends. Typing
  // into an awaiting pane is the user resolving it, so clear the state here
  // rather than leaving the dot amber through the work that follows.
  if (isHookDriven(terminalId)) {
    const terminal = useTerminalsStore.getState().byId[terminalId];
    if (terminal?.status === "awaiting_approval") {
      useTerminalsStore.getState().setStatus(terminalId, "running");
    }
  }
}

function hasUserInput(terminalId: string): boolean {
  return !!useTerminalRuntimeStore.getState().hasUserInput[terminalId];
}

function clearIdleTimer(terminalId: string) {
  const t = idleTimers.get(terminalId);
  if (t !== undefined) {
    clearTimeout(t);
    idleTimers.delete(terminalId);
  }
}

function armIdleTimer(terminalId: string) {
  if (!hasUserInput(terminalId)) return;
  clearIdleTimer(terminalId);
  idleTimers.set(
    terminalId,
    setTimeout(() => {
      idleTimers.delete(terminalId);
      const terminal = useTerminalsStore.getState().byId[terminalId];
      if (terminal?.status === "running") {
        useTerminalsStore.getState().setStatus(terminalId, "awaiting_approval");
      }
    }, IDLE_MS),
  );
}

export async function mountPtyBridge(): Promise<UnlistenFn> {
  const unlistenOutput = await listen<TerminalOutputEvent>(
    EVENT_TERMINAL_OUTPUT,
    (event) => {
      const { terminalId, lineId, ts, stream, text } = event.payload;
      const terminal = useTerminalsStore.getState().byId[terminalId];
      // Hook-driven panes ignore output entirely as a status signal.
      if (terminal && !isHookDriven(terminalId)) {
        // If the agent was awaiting, new output means it's active again.
        if (terminal.status === "awaiting_approval") {
          useTerminalsStore.getState().setStatus(terminalId, "running");
        }
        // Re-arm idle timer whenever output arrives while running.
        if (
          terminal.status === "running" ||
          terminal.status === "awaiting_approval"
        ) {
          armIdleTimer(terminalId);
        }
      }
      // Not written anywhere yet: the bytes join this terminal's queue and
      // reach xterm (and the ring buffer) on the next animation frame. See
      // `outputQueue` for why a per-event write does not survive eight
      // streaming panes.
      enqueueOutput(terminalId, { id: lineId, ts, stream, text });
    },
  );

  const unlistenStatus = await listen<TerminalStatusEvent>(
    EVENT_TERMINAL_STATUS,
    (event) => {
      const { terminalId, status } = event.payload;
      // Clear the idle timer whenever the PTY runtime emits a definitive status.
      if (status !== "running") {
        clearIdleTimer(terminalId);
      }
      // Rust emits `running` once per PTY lifetime (on first byte). Treat it as
      // a fresh boot: reset the user-input gate so the greeting output never
      // triggers awaiting_approval before the user has typed anything.
      if (status === "running") {
        useTerminalRuntimeStore.getState().resetUserInput(terminalId);
      }
      // Process exit (complete/error) still comes from here even for
      // hook-driven panes — the hooks stop firing once the CLI is gone, so
      // this is the only signal that says "it's over".
      useTerminalsStore.getState().setStatus(terminalId, status);
    },
  );

  // Claude Code lifecycle hooks, resolved to a terminal in Rust. Authoritative:
  // whatever the heuristic above believed, this is what the agent says.
  //
  // Note the statuses this can carry: running / awaiting_approval / idle. It
  // never carries `complete` — the end-of-turn hook resolves to `idle`, and
  // "the process is gone" only ever comes from the exit waiter on
  // `terminal://status` below. See `agents::events::status_for_hook`.
  const unlistenAgent = await listen<AgentStatusEvent>(
    EVENT_AGENT_STATUS,
    (event) => {
      const { terminalId, status } = event.payload;
      clearIdleTimer(terminalId);
      useTerminalsStore.getState().setStatus(terminalId, status);
    },
  );

  return () => {
    unlistenOutput();
    unlistenStatus();
    unlistenAgent();
    // Drain all orphan timers on unmount.
    for (const id of idleTimers.keys()) clearIdleTimer(id);
  };
}
