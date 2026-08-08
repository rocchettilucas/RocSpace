/** The sidebar's footer: sessions saved to disk, newest first.
 *
 *  A click restores one as a NEW workspace beside whatever is already open —
 *  never over it. Restoring is additive because a saved session is a layout,
 *  not a state of the app: replacing the user's live workspaces with it would
 *  kill running agents to open a snapshot of some older ones.
 *
 *  The list is read once on mount and re-read after every write, the same
 *  discipline the recents list uses: it changes only through this app, and only
 *  through actions that already know to refresh. */

import { Archive, X } from "lucide-react";
import { useEffect } from "react";
import { cn } from "@/lib/utils";
import { confirmAction, useSavedSessionsStore, useUIStore } from "@/stores";

/** How long ago, in the coarsest unit that still says something. */
function ago(ms: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function SavedSessions() {
  const sessions = useSavedSessionsStore((s) => s.sessions);
  const loaded = useSavedSessionsStore((s) => s.loaded);
  const error = useSavedSessionsStore((s) => s.error);
  const refresh = useSavedSessionsStore((s) => s.refresh);
  const restore = useSavedSessionsStore((s) => s.restore);
  const remove = useSavedSessionsStore((s) => s.remove);
  const openSaveSessionModal = useUIStore((s) => s.openSaveSessionModal);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleDelete = async (name: string) => {
    const ok = await confirmAction({
      title: "Delete saved session",
      message: `Delete the saved session “${name}”?`,
      detail:
        "The file is removed from ~/.rocspace/sessions. Workspaces that were restored from it are not touched.",
      confirmLabel: "Delete session",
      tone: "danger",
    });
    if (ok) void remove(name);
  };

  return (
    <div className="shrink-0 border-t border-border pb-2 pt-1">
      <div className="flex h-7 items-center justify-between px-3">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-fg-muted">
          Saved sessions {sessions.length}
        </span>
        <button
          type="button"
          onClick={openSaveSessionModal}
          aria-label="Save session as"
          title="Save session as… (⌘⇧S)"
          className={cn(
            "grid h-5 w-5 place-items-center rounded text-fg-muted",
            "hover:bg-surface-2 hover:text-fg-primary",
          )}
        >
          <Archive className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Whatever last went wrong, wherever the list stands. A failed delete
          leaves the row on screen and a failed restore opens nothing, so
          without this both read as "the click did nothing" — and the second
          one is indistinguishable from a session that restored into a
          workspace the user then has to go looking for. */}
      {error ? (
        <p
          role="alert"
          className="px-3 py-1 text-[10px] leading-tight break-words text-error"
        >
          {error}
        </p>
      ) : null}

      {sessions.length === 0 ? (
        // "Nothing saved" is a claim about the disk, so it is only made when
        // the disk was actually read. After a failure the line above is the
        // whole answer — saying both would cost two lines of a footer that has
        // room for one, and inviting ⌘⇧S here invites a write to a folder the
        // app could not read.
        <p className="px-3 py-1 text-[10px] italic leading-tight text-fg-muted">
          {!loaded ? "Loading…" : error ? null : "Nothing saved — press ⌘⇧S"}
        </p>
      ) : (
        <ul
          aria-label="Saved sessions"
          className="flex max-h-40 flex-col gap-0.5 overflow-y-auto px-1.5"
        >
          {sessions.map((session) => (
            <li key={session.name} className="group flex items-center">
              <button
                type="button"
                onClick={() => void restore(session.name)}
                title={`${session.workspaceName} — ${session.paneCount} pane${
                  session.paneCount === 1 ? "" : "s"
                }, saved ${ago(session.savedAt)}`}
                className={cn(
                  "flex min-w-0 flex-1 items-baseline gap-1.5 rounded-lg px-2 py-1 text-left",
                  "text-xs text-fg-secondary hover:bg-surface-2 hover:text-fg-primary",
                )}
              >
                <span className="min-w-0 flex-1 truncate">{session.name}</span>
                <span className="shrink-0 text-[10px] tabular-nums text-fg-muted">
                  {session.paneCount}
                </span>
              </button>
              <button
                type="button"
                aria-label={`Delete ${session.name}`}
                title="Delete saved session"
                onClick={() => void handleDelete(session.name)}
                className={cn(
                  "grid h-5 w-5 shrink-0 place-items-center rounded text-fg-muted opacity-0",
                  "transition-opacity hover:bg-error/15 hover:text-error",
                  "group-hover:opacity-100 focus-visible:opacity-100",
                )}
              >
                <X className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
