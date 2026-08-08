/** The one way to start a PTY.
 *
 *  Every caller needs the same three steps — pass the session's *whole* agent
 *  config (that is what makes model / permissions / task prompt reach the CLI),
 *  then record the returned pid and Claude session uuid on the session, then
 *  swallow the failure so one dead binary can't abort a "launch all" loop. Five
 *  call sites open-coding that is how `pid` stayed null for the app's entire
 *  life, so it lives here instead: workspace creation, the boot respawn, the
 *  card's restart button, a pane split, and Topbar's launch-all all go through
 *  this function.
 *
 *  Being the one way is also what makes a queue possible. Every call through
 *  here is bounded by `MAX_CONCURRENT_SPAWNS` — see the queue section for what
 *  that bound is, and what it is not. */

import { commands, type TerminalSession } from "@/lib/bindings";
import { getTerminal } from "@/lib/terminalRegistry";
import { useHistoryStore } from "@/stores/history";
import { useTerminalRuntimeStore } from "@/stores/terminalRuntime";
import { useTerminalsStore } from "@/stores/terminals";
import { useToastsStore } from "@/stores/toasts";
// Cyclic with this module — the workspaces store spawns the sessions it
// creates — and safe for the same reason `terminals` ↔ `outputQueue` is: both
// sides only reach for the other inside a function, long after either module
// finished evaluating.
import { useWorkspacesStore } from "@/stores/workspaces";

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

/** How many `terminal_spawn` calls may be in flight at once.
 *
 *  What this bounds is the IPC round trip and the fork behind it. `terminal_spawn`
 *  is a synchronous Tauri command, so it runs on the MAIN thread and returns
 *  once Rust has opened a pty pair, forked a login shell and started the reader
 *  threads. Sixteen of those posted in one tick — a boot restore across every
 *  workspace, or an eight-pane workspace created from the modal — is a main
 *  thread that does nothing else until it has worked through all sixteen, which
 *  is a window not painting during exactly the seconds the user is watching it.
 *  Four at a time leaves gaps.
 *
 *  What it does NOT bound is the agent CLI. The shell execs that after the
 *  command has already returned, so the CLI reading its config, resolving a
 *  model and opening a network connection all happen outside this queue —
 *  four at a time here still means every CLI starting up within a second or
 *  two of its neighbours. Spacing *those* out is a different mechanism (the
 *  spawn would have to report readiness back before the next one is released),
 *  and this is not it.
 *
 *  Four is enough to keep the machine busy while leaving a visible stagger in
 *  the panes coming up, which is also the honest thing to show: they arrive in
 *  waves because that is what is happening. */
export const MAX_CONCURRENT_SPAWNS = 4;

let inFlight = 0;
/** FIFO. Resolvers, not tasks: a waiter is released by being handed the slot
 *  its predecessor gave up, so the count never dips below the cap while
 *  anything is still waiting. */
const waiting: Array<() => void> = [];

/** Take a spawn slot. `null` means "you have it, go now"; a promise means
 *  "wait your turn".
 *
 *  Null rather than an already-resolved promise so that an uncontended spawn
 *  reaches the IPC call SYNCHRONOUSLY, exactly as it did before there was a
 *  queue. Awaiting a resolved promise would push every spawn a microtask into
 *  the future, which is invisible in production and a trap everywhere else: a
 *  click handler that spawned a pane would no longer have spawned it by the
 *  time it returned. */
function takeSlot(): Promise<void> | null {
  if (inFlight < MAX_CONCURRENT_SPAWNS) {
    inFlight++;
    return null;
  }
  return new Promise<void>((resolve) => {
    waiting.push(resolve);
  });
}

function releaseSlot(): void {
  const next = waiting.shift();
  // Hand the slot straight over rather than decrementing and letting the next
  // caller re-take it: between those two steps a fresh `spawnTerminal` could
  // jump the queue, which would make the order the panes come up in depend on
  // event-loop luck.
  if (next) next();
  else inFlight--;
}

/** How many spawns are in flight, and how many are queued behind them.
 *  Exported for tests and for anything that wants to say "starting 6 of 16". */
export function spawnQueueDepth(): { inFlight: number; waiting: number } {
  return { inFlight, waiting: waiting.length };
}

// ---------------------------------------------------------------------------
// Spawning
// ---------------------------------------------------------------------------

export interface SpawnOptions {
  /** A Claude Code conversation to rejoin instead of starting a new one. The
   *  CLI is launched with `--resume <uuid>` in place of `--session-id <uuid>`,
   *  and the pane keeps that uuid — see `agents::command::ClaudeSession`.
   *
   *  Only meaningful for a `claude-code` pane; Rust ignores it for the others,
   *  which are never handed a uuid in the first place. */
  resumeClaudeSession?: string | null;
}

/** Spawn (or restart) `terminal`'s PTY and record the process identity.
 *
 *  Resolves either way: a spawn failure is logged and reported in the return
 *  value rather than thrown, because every call site is a fire-and-forget loop
 *  over sessions. The promise settles when the spawn does — which is what the
 *  queue counts, so `await`ing it is also how a caller paces itself. */
export async function spawnTerminal(
  terminal: TerminalSession,
  options: SpawnOptions = {},
): Promise<boolean> {
  const queued = takeSlot();
  if (queued) await queued;
  try {
    // The pane's real size, if it is already on screen. Restores mount the
    // terminal first and spawn a beat later, so this is usually known — and
    // when it is, the PTY starts at the width the agent will actually draw
    // into instead of the 80x24 default it would have to be corrected out of.
    const live = getTerminal(terminal.id);
    const result = await commands.terminalSpawn(
      terminal.id,
      terminal.agentConfig,
      terminal.projectPath || null,
      options.resumeClaudeSession ?? null,
      live?.cols ?? null,
      live?.rows ?? null,
    );
    // …and the other ordering: a brand-new pane spawns before its xterm has
    // measured anything, so the size that mattered was not knowable above.
    // Re-assert it once the PTY exists — the resize this pane already fired
    // was dropped, because there was nothing yet to receive it.
    if (!live) {
      const mounted = getTerminal(terminal.id);
      if (mounted) {
        void commands
          .terminalResize(terminal.id, mounted.cols, mounted.rows)
          .catch(() => {
            /* the pane closed between the spawn and this line */
          });
      }
    }
    useTerminalsStore.getState().recordSpawn(terminal.id, result);
    // The pane came up, but not in the conversation it was asked for: that one
    // is gone, and Rust started a fresh one rather than let `--resume` fail and
    // take the pane with it (see `SpawnResult.conversationLost`). Saying so is
    // the whole difference between a recovery and a lie — the agent in this
    // pane has no memory of the work it was in the middle of, and a user who is
    // not told will spend the next few minutes asking it about that work.
    if (result.conversationLost) {
      useToastsStore.getState().push({
        message: `${terminal.name} started a new conversation — the one it was in could not be recovered.`,
        tone: "warn",
      });
    }
    // The process now carries whatever the config says, so the Inspector's
    // "restart to apply" affordance has nothing left to offer.
    useTerminalRuntimeStore.getState().clearConfigDirty(terminal.id);
    // Whatever conversation this pane was offered, the question is answered:
    // it is either in it now, or it started a new one.
    useTerminalRuntimeStore.getState().clearResumable(terminal.id);
    return true;
  } catch (err) {
    console.warn(`terminalSpawn(${terminal.name}) failed:`, err);
    // A warning in a DevTools window nobody has open is not a report. The pane
    // that never came up is otherwise indistinguishable from one that was
    // never started, so the reason goes somewhere the user can find it:
    // Settings › History.
    useHistoryStore.getState().recordFailure({
      kind: options.resumeClaudeSession ? "resume" : "spawn",
      name: terminal.name,
      workspaceName:
        useWorkspacesStore
          .getState()
          .workspaces.find((w) => w.id === terminal.workspaceId)?.name ??
        "Unknown workspace",
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  } finally {
    releaseSlot();
  }
}

/** Spawn a terminal by id, if it still exists. Convenience for callers that
 *  hold an id (keyboard shortcuts, event handlers) rather than the session. */
export async function spawnTerminalById(
  id: string,
  options: SpawnOptions = {},
): Promise<boolean> {
  const terminal = useTerminalsStore.getState().byId[id];
  if (!terminal) return false;
  return spawnTerminal(terminal, options);
}
