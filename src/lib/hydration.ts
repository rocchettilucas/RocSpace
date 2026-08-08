/** Reconciling a loaded snapshot with what is actually running: nothing.
 *
 *  A snapshot carries `pid` and `claudeSessionId` per terminal — deliberately,
 *  because Phase 2 wants that plumbing for `claude --resume` — but the
 *  processes they describe died with the last quit. Startup respawns only the
 *  panes that were mid-flight when the app closed (`running` /
 *  `awaiting_approval`), so every other pane came back holding a Claude session
 *  uuid for a session that no longer exists.
 *
 *  That is not inert. `ptyBridge` treats a pane whose status comes from Claude
 *  Code's lifecycle hooks as authoritative and switches off the silence
 *  heuristic for it. Read off the uuid alone, that describes a pane which will
 *  never receive another hook event: no status signal at all, and a dot frozen
 *  for the rest of the session.
 *
 *  So the pid is cleared on every hydrated pane before anything is spawned —
 *  nothing is running, and the running app should believe nothing until it has
 *  started a process itself. Panes that do get respawned are handed a fresh pid
 *  and uuid by `recordSpawn` moments later; panes whose respawn fails correctly
 *  keep neither.
 *
 *  The uuid is different, because it has one use left and it is the whole point
 *  of having persisted it: `claude --resume` can put the pane back in that
 *  conversation. A pane that is not being respawned keeps it, and the offer is
 *  parked in the runtime store beside it (see `views/RocDock/ResumeOverlay`,
 *  which is also where the uuid is checked against what Claude Code still has —
 *  a snapshot only knows that a conversation was STARTED, and one that was
 *  never prompted left nothing behind to resume).
 *  That pair is what tells an offer from a live process — `ptyBridge` reads the
 *  parked offer, not the bare uuid, so the heuristic stays on for a cold pane.
 *
 *  Keeping it on the session rather than only in the runtime store is what
 *  makes the offer outlive the run it was made in: the runtime store is
 *  ephemeral, so clearing the persisted uuid meant the question survived
 *  exactly one boot — quit with it unanswered and the conversation was gone for
 *  good. Now it is re-derived from the snapshot every boot until the user
 *  answers, and either answer ends it: `recordSpawn` overwrites the uuid with
 *  the conversation the pane is actually in (a new one for "Start fresh", the
 *  resumed one for "Resume").
 */

import type { TerminalSession, TerminalStatus } from "@/lib/bindings";
import { useTerminalsStore } from "@/stores/terminals";
import { useTerminalRuntimeStore } from "@/stores/terminalRuntime";

/** Statuses that mean "this pane was working when the app quit". Only these
 *  are worth bringing back — a `complete` or `error` pane finished, and an
 *  `idle` one never started. */
const RESPAWN_STATUSES: readonly TerminalStatus[] = [
  "running",
  "awaiting_approval",
];

/** The Claude conversation `terminal` could be put back into, or null.
 *
 *  Only a `claude-code` pane has one: the uuid is `--session-id`'s value, and
 *  no other CLI is handed it. Kept next to the reconcile so the respawn loop
 *  and the deferred overlay ask the same question the same way. */
export function resumeTargetOf(terminal: TerminalSession): string | null {
  if (terminal.agentConfig.type !== "claude-code") return null;
  return terminal.claudeSessionId ?? null;
}

/** Drop every hydrated pane's stale process identity, park the conversations
 *  worth offering, and report which panes are worth respawning. Call once,
 *  right after `loadSnapshot`.
 *
 *  The sessions handed back are snapshots taken BEFORE the clear, so they still
 *  carry the uuid the caller needs for `--resume`. That is deliberate rather
 *  than incidental: a respawning pane's copy has to be clean before anything
 *  reads it, and the respawn loop still has to know what to resume into. */
export function reconcileHydratedTerminals(): TerminalSession[] {
  const store = useTerminalsStore.getState();
  const runtime = useTerminalRuntimeStore.getState();
  const terminals = Object.values(store.byId).map((t) => ({ ...t }));
  const respawn = terminals.filter((t) => RESPAWN_STATUSES.includes(t.status));
  const respawning = new Set(respawn.map((t) => t.id));

  for (const terminal of terminals) {
    // A pane that is about to be respawned gets its conversation from the
    // respawn itself; parking it here too would leave a resume offer standing
    // over a pane that is already in that conversation.
    const resume = resumeTargetOf(terminal);
    const offered = resume !== null && !respawning.has(terminal.id);
    if (offered) runtime.markResumable(terminal.id, resume);
    // The pid always goes — nothing is running. The uuid stays exactly where
    // an offer now stands over it, so the question survives the next quit too;
    // everywhere else (a respawning pane, a non-Claude pane holding a stray)
    // it describes nothing and goes with the pid.
    store.clearSpawnIdentity(terminal.id, { keepClaudeSession: offered });
  }
  return respawn;
}
