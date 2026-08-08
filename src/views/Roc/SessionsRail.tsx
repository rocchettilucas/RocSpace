/** Every session Roc can talk to, across every workspace.
 *
 *  Deliberately not scoped to the active workspace, unlike the dock: the whole
 *  premise of this phase is prompting MANY agents at once, and a user with a
 *  frontend workspace and a backend one wants to say one thing to both. The
 *  workspace each pane belongs to is on its row, because "Rocky" is a name the
 *  pool hands out per app and two docks can hold one each.
 *
 *  Two independent gestures on one row, which is the thing to get right:
 *   • the CHECKBOX picks a pane as a dispatch target (multi-select);
 *   • the ROW picks whose live terminal the panel on the right shows.
 *  Watching one agent while addressing three is the normal case, so they are
 *  not the same state — see `focusedRailTerminalId` vs `selectedTerminalIds`.
 *
 *  A third thing each row says, and only after a dispatch: what happened to it.
 *  A fan-out is mostly waiting, and a pane that is holding the message up
 *  because it has a permission prompt on screen is invisible from here without
 *  the badge — the user would be looking at a log entry saying the message went
 *  to four agents while one of them had not read a word. The queued badge is
 *  also the cancel: a message aimed at a pane that is asking its user something
 *  can sit there for five minutes, and changing your mind should not mean
 *  closing the session.
 *
 *  Keyboard: the rows are buttons, so Tab and Enter already work on the focus
 *  half, and the checkbox is a real checkbox for the same reason. ↑/↓ walk the
 *  rail with automatic activation (arrowing to a session shows its terminal —
 *  the same pattern, and the same argument, as the sidebar's workspace list),
 *  and Space ticks the row the rail is on. */

import { useMemo } from "react";
import { Check } from "lucide-react";
import { AGENT_BADGE } from "@/lib/agentLabels";
import { accentVar } from "@/lib/accentColors";
import { leafIds } from "@/lib/paneTree";
import {
  cancelRocDispatch,
  useRocTargetState,
  type RocTargetState,
} from "@/lib/rocDispatch";
import { cn } from "@/lib/utils";
import {
  useRocSelection,
  useRocStore,
  useTerminalsStore,
  useWorkspacesStore,
} from "@/stores";
import { STATUS_DOT, STATUS_LABEL } from "@/views/RocDock/PaneHeader";
import type { TerminalSession, Workspace } from "@/lib/bindings";

interface RailGroup {
  workspace: Workspace;
  sessions: TerminalSession[];
}

/** Sessions grouped by workspace, in the order the user sees them elsewhere.
 *
 *  Active workspace first — it is the one whose panes are on screen behind this
 *  view, and the one a dispatch most likely means. Within a group, the dock's
 *  own order (pane-tree leaves, then age), which is the same rule
 *  `useActiveWorkspaceTerminals` and `rocplanDispatch` both use: "the first
 *  pane" has to mean the pane at the top left, not whichever id sorted first. */
export function groupSessionsByWorkspace(
  workspaces: readonly Workspace[],
  byId: Readonly<Record<string, TerminalSession>>,
  activeWorkspaceId: string | null,
): RailGroup[] {
  const sessions = Object.values(byId);
  const groups: RailGroup[] = [];
  for (const workspace of workspaces) {
    const mine = sessions.filter((s) => s.workspaceId === workspace.id);
    if (mine.length === 0) continue;
    const order = new Map(
      (workspace.paneTree ? leafIds(workspace.paneTree) : []).map((id, i) => [
        id,
        i,
      ]),
    );
    const rank = (s: TerminalSession) =>
      order.get(s.id) ?? Number.MAX_SAFE_INTEGER;
    mine.sort((a, b) => rank(a) - rank(b) || a.createdAt - b.createdAt);
    groups.push({ workspace, sessions: mine });
  }
  groups.sort((a, b) => {
    if (a.workspace.id === activeWorkspaceId) return -1;
    if (b.workspace.id === activeWorkspaceId) return 1;
    return 0;
  });
  return groups;
}

/** Everything this rail draws from a session, as one string.
 *
 *  The rail must NOT subscribe to `byId`. That map is rewritten on every
 *  animation frame that carries PTY output, so a rail subscribed to it re-runs
 *  the grouping — `Object.values`, a `leafIds` walk and a sort per workspace,
 *  then a fresh `Set` — sixty times a second for every streaming pane, behind a
 *  view the user may not even have open. Same trick, and same reason, as
 *  `RocStage`'s roster: watch the fields that can change what is on screen, let
 *  zustand's identity check swallow the rest.
 *
 *  Five fields, and they are exactly the five a row renders: the id it is keyed
 *  and selected by, the name, the workspace it is grouped under, the status dot
 *  and the agent badge. A change to any of them still repaints on the next
 *  frame; a megabyte of build output does not. */
const rosterOf = (byId: Readonly<Record<string, TerminalSession>>): string =>
  Object.values(byId)
    .map(
      (t) =>
        `${t.id}\u0000${t.name}\u0000${t.workspaceId}\u0000${t.status}\u0000${t.agentConfig.type}`,
    )
    .join("\u0001");

export function SessionsRail() {
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspacesStore((s) => s.activeWorkspaceId);
  const roster = useTerminalsStore((s) => rosterOf(s.byId));
  const selected = useRocSelection();
  const focusedRail = useRocStore((s) => s.focusedRailTerminalId);
  const toggleSelected = useRocStore((s) => s.toggleSelected);
  const selectOnly = useRocStore((s) => s.selectOnly);
  const clearSelection = useRocStore((s) => s.clearSelection);
  const setFocusedRail = useRocStore((s) => s.setFocusedRail);

  const groups = useMemo(
    () =>
      // Read out of the store rather than subscribed to — see `rosterOf` for
      // why the rail must not hold `byId`.
      groupSessionsByWorkspace(
        workspaces,
        useTerminalsStore.getState().byId,
        activeWorkspaceId,
      ),
    // `roster` is the dependency the linter cannot see: a string that changes
    // exactly when the grouping's answer would.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [workspaces, activeWorkspaceId, roster],
  );
  const allIds = useMemo(
    () => groups.flatMap((g) => g.sessions.map((s) => s.id)),
    [groups],
  );

  /** ↑/↓ walk the rail and show what they land on; Space ticks the row they are
   *  on. Automatic activation, like the sidebar's workspace list: arrowing to a
   *  session and NOT seeing its terminal would be a cursor that means nothing.
   *
   *  On the container rather than per row, and focus follows by walking the DOM
   *  — the rows are in the same order the grouping put them in, so there is no
   *  ref bookkeeping to get out of step. */
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (allIds.length === 0) return;

    if (e.key === " ") {
      // Anything with its own idea of Space keeps it. The checkbox already
      // toggles the row, so taking Space here as well would toggle it twice
      // back to where it started — and the queued badge is a BUTTON, which the
      // old tag check let straight through: `preventDefault` swallowed the
      // press and ticked the row instead, leaving a keyboard user with no way
      // at all to call off a message parked in front of a permission prompt.
      //
      // The row itself is a button too, and Space on it IS this shortcut, so it
      // is the one interactive thing that does not opt out.
      const own = (e.target as HTMLElement).closest(
        "button, [role='button'], input, textarea, select, a[href]",
      );
      if (own && !own.hasAttribute("data-rail-row")) return;
      if (!focusedRail) return;
      e.preventDefault();
      toggleSelected(focusedRail);
      return;
    }

    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const at = focusedRail ? allIds.indexOf(focusedRail) : -1;
    const step = e.key === "ArrowDown" ? 1 : -1;
    // With nothing focused the first press claims the first row rather than
    // stepping past it, so arriving by Tab and pressing ↓ lands on row one.
    const next = at === -1 ? 0 : (at + step + allIds.length) % allIds.length;
    setFocusedRail(allIds[next]!);
    e.currentTarget
      .querySelectorAll<HTMLElement>("[data-rail-row]")
      [next]?.focus();
  };

  const selectedSet = new Set(selected);
  // MEMBERSHIP, not size. Comparing counts said "all of them" whenever the two
  // numbers happened to agree — a selection holding one id this rail does not
  // list (a pane in a workspace that has since gone) alongside two it does, and
  // the button offered to clear a selection that was missing a live pane. The
  // button's whole job is to be the answer to what it says on it.
  const allSelected =
    allIds.length > 0 && allIds.every((id) => selectedSet.has(id));

  return (
    <section
      aria-label="Sessions"
      className="flex h-full min-h-0 flex-col bg-surface-1"
    >
      <header className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-fg-muted">
          Sessions
        </span>
        {allIds.length > 0 ? (
          <button
            type="button"
            onClick={() =>
              allSelected ? clearSelection() : selectOnly(allIds)
            }
            className="text-[10px] uppercase tracking-wider text-fg-secondary transition-colors hover:text-fg-primary"
          >
            {allSelected ? "None" : "All"}
          </button>
        ) : null}
      </header>

      <div
        className="min-h-0 flex-1 overflow-auto py-1"
        onKeyDown={handleKeyDown}
      >
        {groups.length === 0 ? (
          <p className="px-3 py-4 text-center text-xs italic text-fg-muted">
            No sessions open yet — every pane in every workspace shows up here,
            and ticking them is how you say a thing to several at once.
          </p>
        ) : (
          groups.map(({ workspace, sessions }) => (
            <div key={workspace.id} className="mb-1">
              <div className="flex items-center gap-1.5 px-3 py-1">
                <span
                  aria-hidden
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ background: accentVar(workspace.accent) }}
                />
                <span className="truncate text-[10px] uppercase tracking-wider text-fg-muted">
                  {workspace.name}
                </span>
              </div>
              {sessions.map((session) => (
                <RailRow
                  key={session.id}
                  session={session}
                  selected={selectedSet.has(session.id)}
                  focused={focusedRail === session.id}
                  onToggle={() => toggleSelected(session.id)}
                  onFocus={() => setFocusedRail(session.id)}
                />
              ))}
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function RailRow({
  session,
  selected,
  focused,
  onToggle,
  onFocus,
}: {
  session: TerminalSession;
  selected: boolean;
  focused: boolean;
  onToggle: () => void;
  onFocus: () => void;
}) {
  return (
    <div
      className={cn(
        "mx-1.5 flex items-center gap-2 rounded-md px-1.5 transition-colors",
        focused ? "bg-surface-3" : "hover:bg-surface-2",
      )}
    >
      {/* A real checkbox rather than a styled div: it is the one control here
          that has a checked state a screen reader has to be able to read and
          toggle, and the browser already knows how to do both. */}
      <label
        className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center"
        title={selected ? `Deselect ${session.name}` : `Select ${session.name}`}
      >
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          aria-label={`Select ${session.name}`}
          className="peer sr-only"
        />
        <span
          aria-hidden
          className={cn(
            "grid h-3.5 w-3.5 place-items-center rounded-[3px] border transition-colors",
            selected
              ? "border-accent bg-accent text-accent-fg"
              : "border-border-hover peer-focus-visible:border-border-active",
          )}
        >
          {selected ? <Check className="h-2.5 w-2.5" strokeWidth={3} /> : null}
        </span>
      </label>

      <button
        type="button"
        data-rail-row
        onClick={onFocus}
        title={`Watch ${session.name}`}
        className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left"
      >
        <span
          aria-hidden
          className={cn(
            "h-1.5 w-1.5 shrink-0 rounded-full",
            STATUS_DOT[session.status],
            session.status === "running" && "motion-safe:animate-pulse",
          )}
        />
        <span
          className={cn(
            "truncate text-xs",
            focused ? "text-fg-primary" : "text-fg-secondary",
          )}
        >
          {session.name}
        </span>
        <span className="sr-only">{STATUS_LABEL[session.status]}</span>
        <span className="ml-auto shrink-0 rounded-sm bg-surface-2 px-1 py-px text-[9px] uppercase tracking-wider text-fg-muted">
          {AGENT_BADGE[session.agentConfig.type]}
        </span>
      </button>

      <DispatchBadge terminalId={session.id} name={session.name} />
    </div>
  );
}

/** What the last dispatch did about this pane.
 *
 *  Outside the row's button rather than inside it, because the queued one is
 *  itself a button — a button inside a button is invalid, and browsers resolve
 *  it by dropping one of them.
 *
 *  Nothing is drawn when there is nothing to say, which is most rows most of
 *  the time: a rail wearing a badge per row would be a rail where the one badge
 *  that matters does not stand out. */
function DispatchBadge({
  terminalId,
  name,
}: {
  terminalId: string;
  name: string;
}) {
  const state = useRocTargetState(terminalId);
  if (!state) return null;

  const { label, className } = BADGE[state];
  if (state !== "queued") {
    return (
      <span
        className={cn(
          "shrink-0 rounded-sm px-1 py-px text-[9px] uppercase tracking-wider",
          className,
        )}
      >
        {label}
      </span>
    );
  }

  // The queued badge IS the cancel. A message aimed at a pane that is asking
  // its user something can sit there for five minutes, and the only other way
  // to call it off would be closing the session.
  return (
    <button
      type="button"
      onClick={() => cancelRocDispatch(terminalId)}
      title={`Cancel — ${name} has not been sent it yet`}
      aria-label={`Cancel the message queued for ${name}`}
      className={cn(
        "shrink-0 rounded-sm px-1 py-px text-[9px] uppercase tracking-wider transition-colors",
        className,
      )}
    >
      {label}
    </button>
  );
}

const BADGE: Record<RocTargetState, { label: string; className: string }> = {
  queued: {
    label: "Queued",
    className: "bg-warning/15 text-warning hover:bg-warning/25",
  },
  sent: { label: "Sent", className: "bg-success/15 text-success" },
  skipped: { label: "Skipped", className: "bg-surface-3 text-fg-muted" },
  failed: { label: "Failed", className: "bg-error/15 text-error" },
};
