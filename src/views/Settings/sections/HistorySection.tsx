/** Settings › History: what has been saved, and what failed to start.
 *
 *  Two lists that answer the same kind of question — "what happened to the
 *  thing I asked for?" — from opposite ends. The saved sessions are the same
 *  data the sidebar footer shows, through the same store, so deleting one here
 *  removes the row there too. The failures are this run only: every record
 *  describes an attempt to start a process, and after a restart there are no
 *  such processes to describe. */

import { RotateCcw, Trash2, X } from "lucide-react";
import { useEffect } from "react";
import { cn } from "@/lib/utils";
import {
  confirmAction,
  useHistoryStore,
  useSavedSessionsStore,
  useUIStore,
} from "@/stores";
import { SettingsNote, SettingsSection } from "@/views/Settings/rows";

/** Absolute, to the minute. Settings is where a user goes to check a fact, and
 *  "3h ago" is not one. */
const stamp = (ms: number) =>
  new Date(ms).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });

export function HistorySection() {
  const sessions = useSavedSessionsStore((s) => s.sessions);
  const loaded = useSavedSessionsStore((s) => s.loaded);
  const error = useSavedSessionsStore((s) => s.error);
  const refresh = useSavedSessionsStore((s) => s.refresh);
  const restore = useSavedSessionsStore((s) => s.restore);
  const remove = useSavedSessionsStore((s) => s.remove);
  const failures = useHistoryStore((s) => s.failures);
  const clearFailures = useHistoryStore((s) => s.clearFailures);
  const closeSettings = useUIStore((s) => s.closeSettings);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleRestore = async (name: string) => {
    const id = await restore(name);
    // The restored workspace is now active behind this overlay. Standing in
    // front of it would make the button look like it did nothing.
    if (id) closeSettings();
  };

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
    <>
      <SettingsSection
        title="Saved sessions"
        description="Workspaces written to ~/.rocspace/sessions. Restoring one opens it beside whatever is already open — it never replaces it."
      >
        {/* Whatever last went wrong. A failed delete leaves the row where it
            was and the confirmation reads as a success; a failed restore
            closes nothing and opens nothing. Both were silent. */}
        {error ? (
          <p
            role="alert"
            className="mb-2 rounded-input border border-error/40 bg-error/10 px-2.5 py-2 text-[11px] leading-relaxed break-words text-fg-secondary"
          >
            {error}
          </p>
        ) : null}

        {sessions.length === 0 ? (
          <p className="text-xs text-fg-muted">
            {!loaded
              ? "Loading…"
              : error
                ? // An empty list after a failed read is not an empty folder,
                  // and saying it is invites a ⌘⇧S over sessions that are
                  // still there.
                  "The sessions folder could not be read, so this list may not be everything."
                : "Nothing saved yet. ⌘⇧S names the active workspace and writes it here."}
          </p>
        ) : (
          <ul className="flex flex-col">
            {sessions.map((session) => (
              <li
                key={session.name}
                className="flex items-center gap-3 border-b border-border py-2.5 last:border-b-0"
              >
                <div className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium text-fg-primary">
                    {session.name}
                  </span>
                  <span className="mt-0.5 block text-[11px] text-fg-muted">
                    {session.workspaceName} · {session.paneCount} pane
                    {session.paneCount === 1 ? "" : "s"} ·{" "}
                    {stamp(session.savedAt)}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => void handleRestore(session.name)}
                  className="flex shrink-0 items-center gap-1.5 rounded-input bg-surface-2 px-2.5 py-1.5 text-xs text-fg-primary hover:bg-surface-3"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  Restore
                </button>
                <button
                  type="button"
                  aria-label={`Delete ${session.name}`}
                  onClick={() => void handleDelete(session.name)}
                  className="grid h-7 w-7 shrink-0 place-items-center rounded-input text-fg-muted hover:bg-error/15 hover:text-error"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </SettingsSection>

      <div className="mt-8">
        <SettingsSection
          title="Recent failures"
          description="Panes and saved sessions that could not be opened this run, and why. Cleared when RocSpace restarts."
        >
          {failures.length === 0 ? (
            <p className="text-xs text-fg-muted">
              Nothing has failed to start this run.
            </p>
          ) : (
            <>
              <ul className="flex flex-col">
                {failures.map((failure) => (
                  <li
                    key={failure.id}
                    className="flex items-start gap-3 border-b border-border py-2.5 last:border-b-0"
                  >
                    <span
                      className={cn(
                        "mt-0.5 shrink-0 rounded-full px-1.5 py-px text-[10px] font-medium",
                        "bg-error/15 text-error",
                      )}
                    >
                      {failure.kind}
                    </span>
                    <div className="min-w-0 flex-1">
                      <span className="block text-xs font-medium text-fg-primary">
                        {failure.name}
                        {failure.workspaceName ? (
                          <span className="font-normal text-fg-muted">
                            {" "}
                            in {failure.workspaceName}
                          </span>
                        ) : null}
                      </span>
                      <span className="mt-0.5 block break-words font-mono text-[11px] leading-relaxed text-fg-secondary">
                        {failure.error}
                      </span>
                    </div>
                    <span className="shrink-0 text-[11px] tabular-nums text-fg-muted">
                      {stamp(failure.at)}
                    </span>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                onClick={clearFailures}
                className="mt-3 flex items-center gap-1.5 rounded-input bg-surface-2 px-2.5 py-1.5 text-xs text-fg-secondary hover:bg-surface-3 hover:text-fg-primary"
              >
                <X className="h-3.5 w-3.5" />
                Clear
              </button>
            </>
          )}

          <SettingsNote>
            A resume fails on its own terms: the conversation it names is gone
            from the CLI&apos;s own store, which no amount of retrying fixes.
            Start that pane fresh instead.
          </SettingsNote>
        </SettingsSection>
      </div>
    </>
  );
}
