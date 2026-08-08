/** The saved-session list, as the sidebar footer and Settings › History both
 *  read it.
 *
 *  A store rather than a `useState` in each of them: the two lists are the same
 *  data, and a delete in one that left the other showing the row would be a
 *  lie the user finds out about by clicking it. Session-scoped and never
 *  persisted — the files on disk are the durable copy, this is just what the
 *  last `session_list` said.
 *
 *  Every action swallows its IPC failure into `error` rather than throwing:
 *  these run from clicks, and a rejected promise from a click handler is an
 *  unhandled rejection nobody sees. */

import { create } from "zustand";
import { commands, type SavedSessionMeta } from "@/lib/bindings";
import {
  parseSavedSession,
  restoreSavedSession,
  serializeWorkspace,
} from "@/lib/savedSessions";
import { spawnTerminal } from "@/lib/spawn";
import { useHistoryStore } from "@/stores/history";
import { useWorkspacesStore } from "@/stores/workspaces";

interface SavedSessionsState {
  sessions: SavedSessionMeta[];
  /** False until the first `refresh` settles — the difference between "no
   *  saved sessions" and "we have not looked yet". */
  loaded: boolean;
  /** The last failure, shown by both lists.
   *
   *  Both of them read it, which was the whole point and for a while was not
   *  true of either: six writers, no readers. An empty list after a failed
   *  `session_list` is not "nothing saved" — that is a claim about the disk the
   *  app has just failed to check, and it invites the user to overwrite the
   *  folder it could not read. Cleared by the next action that succeeds. */
  error: string | null;

  refresh: () => Promise<void>;
  /** Save the active workspace under `name`, overwriting a same-slug session.
   *  Returns the meta it was saved with, or null when it could not be. */
  saveActiveWorkspace: (name: string) => Promise<SavedSessionMeta | null>;
  /** Load `name` and open it as a new, active workspace. Returns its id. */
  restore: (name: string) => Promise<string | null>;
  remove: (name: string) => Promise<void>;
}

const message = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

export const useSavedSessionsStore = create<SavedSessionsState>((set, get) => ({
  sessions: [],
  loaded: false,
  error: null,

  refresh: async () => {
    try {
      const sessions = await commands.sessionList();
      set({ sessions, loaded: true, error: null });
    } catch (err) {
      console.warn("[sessions] list failed:", err);
      set({ loaded: true, error: message(err) });
    }
  },

  saveActiveWorkspace: async (name) => {
    const payload = serializeWorkspace(
      useWorkspacesStore.getState().activeWorkspaceId,
    );
    if (!payload) return null;
    try {
      const meta = await commands.sessionSave(name, payload);
      await get().refresh();
      return meta;
    } catch (err) {
      console.warn("[sessions] save failed:", err);
      set({ error: message(err) });
      return null;
    }
  },

  restore: async (name) => {
    let payload;
    try {
      payload = parseSavedSession(await commands.sessionLoad(name));
    } catch (err) {
      // Filed, not only stored. This is the branch for a session file that was
      // deleted, renamed or made unreadable OUTSIDE the app — the click then
      // did nothing at all: no toast, no row change, no history entry, and the
      // row it was aimed at still sitting there inviting another try. The
      // empty-payload branch below has always recorded it; the difference
      // between them is which layer noticed, which is not something the user
      // is asking about.
      console.warn("[sessions] load failed:", err);
      const error = message(err);
      set({ error });
      useHistoryStore.getState().recordFailure({
        kind: "restore",
        name,
        // Null for the same reason as below: the workspace is the thing that
        // failed to exist, so naming one would be inventing it.
        workspaceName: null,
        error,
      });
      return null;
    }
    if (!payload) {
      set({ error: `"${name}" is not a readable session file` });
      return null;
    }
    // A JSON object is not a session. `{}`, `[]` and `{"foo":1}` all parse —
    // the reader is total by design, and it fills in a name and an accent for
    // whatever it is handed — so a truncated or hand-edited file used to
    // restore as a workspace called "Restored workspace" with no panes, no
    // error, and nothing to close but the workspace itself. A session with no
    // panes is not a session; say so instead of opening it.
    if (payload.terminals.length === 0) {
      const error = `"${name}" has no panes in it — the file is empty or corrupt`;
      set({ error });
      useHistoryStore.getState().recordFailure({
        kind: "restore",
        name,
        // Deliberately null: the workspace is what failed to exist. The name
        // the payload carries would be the reader's fallback, not the user's.
        workspaceName: null,
        error,
      });
      return null;
    }

    const { workspaceId, sessions, resumable } = restoreSavedSession(payload);
    set({ error: null });
    // Panes with a Claude conversation waiting are left cold on purpose: the
    // saved uuid can be weeks old, and `--resume` into a transcript the CLI has
    // since dropped kills the pane at launch. Those panes offer the choice
    // instead (see `RestoredSession.resumable`). Everything else starts now.
    for (const session of sessions) {
      if (resumable.has(session.id)) continue;
      void spawnTerminal(session);
    }
    return workspaceId;
  },

  remove: async (name) => {
    try {
      await commands.sessionDelete(name);
      set((s) => ({
        sessions: s.sessions.filter((entry) => entry.name !== name),
        error: null,
      }));
    } catch (err) {
      console.warn("[sessions] delete failed:", err);
      set({ error: message(err) });
    }
  },
}));

export const useSavedSessions = (): SavedSessionMeta[] =>
  useSavedSessionsStore((s) => s.sessions);
