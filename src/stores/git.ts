/** What the Git panel is looking at: one repository, its status, the file
 *  under the cursor and that file's diff.
 *
 *  Ephemeral, like `ui` and unlike `editor`: every field here is a fact about a
 *  working tree that some other process — the user's own shell, an agent in a
 *  pane, a rebase — is free to change while the app is closed. Persisting a
 *  file list would mean opening on a picture of a repository as it was, which
 *  is worse than opening on nothing.
 *
 *  ONE repository at a time, whichever workspace is active. Not a map keyed by
 *  path: a per-repo cache would have to be invalidated by the same events that
 *  make a refresh cheap anyway, and the panel only ever draws one.
 *
 *  Two different failure policies, on purpose:
 *
 *    * A failed REFRESH sets `error` and draws in place. It is the answer to a
 *      question the panel asked on its own (mounting, a window focus), and the
 *      commonest cause is a workspace that is not a repository — a toast per
 *      refresh for that would be a stream of notifications about a thing the
 *      user already knows.
 *    * A failed MUTATION raises a toast carrying git's OWN message. The user
 *      pressed a button; something has to say what happened, and git's sentence
 *      ("nothing to commit", "pathspec did not match", "your local changes
 *      would be overwritten") is better than any paraphrase — it is also the
 *      one they can search for.
 */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { create } from "zustand";
import { devtools } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";
import {
  EVENT_GIT_STATUS,
  commands,
  type GitBranch,
  type GitFileEntry,
  type GitStatus,
  type GitStatusEvent,
  type GitWatchHandle,
} from "@/lib/bindings";
import { useToastsStore } from "@/stores/toasts";

/** Which side of the index a selected file is being read from. */
export interface GitSelection {
  path: string;
  staged: boolean;
}

interface GitState {
  /** Absolute path of the repository, or null when the active workspace has no
   *  project directory. */
  repo: string | null;
  status: GitStatus | null;
  loading: boolean;
  /** Why the last refresh failed — drawn in place, never toasted. */
  error: string | null;

  selection: GitSelection | null;
  diff: string | null;
  diffLoading: boolean;
  diffError: string | null;

  branches: GitBranch[];
  branchesLoading: boolean;

  message: string;
  committing: boolean;
  /** Bumped by ⌘⇧K. The commit box focuses itself when this changes, which is
   *  the only way a chord can reach a field inside a panel that may not even be
   *  mounted when the key is pressed. */
  commitFocusNonce: number;
}

interface GitActions {
  /** Point the panel at a repository. A different path clears everything the
   *  previous one had — including a half-typed commit message, which belongs to
   *  the repository it was being written for. */
  setRepo: (repo: string | null) => void;
  refresh: () => Promise<void>;
  select: (path: string, staged: boolean) => Promise<void>;
  clearSelection: () => void;
  stage: (paths: string[]) => Promise<void>;
  unstage: (paths: string[]) => Promise<void>;
  setMessage: (message: string) => void;
  commit: () => Promise<string | null>;
  loadBranches: () => Promise<void>;
  checkout: (branch: string, create: boolean) => Promise<boolean>;
  focusCommitBox: () => void;
  reset: () => void;
}

const initialState: GitState = {
  repo: null,
  status: null,
  loading: false,
  error: null,
  selection: null,
  diff: null,
  diffLoading: false,
  diffError: null,
  branches: [],
  branchesLoading: false,
  message: "",
  committing: false,
  commitFocusNonce: 0,
};

/** Tauri rejects with the string Rust returned, which for every command in
 *  `src-tauri/src/git` is git's own stderr. Anything else that reaches here is
 *  a bug on this side, and its message is still the most useful thing to say. */
export function gitErrorMessage(err: unknown): string {
  if (typeof err === "string") return err.trim();
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Module-level, like the rocplan store's write bookkeeping: nobody renders
 *  these, and a re-render must not reset them.
 *
 *  Two counters, because the two requests race independently. A refresh that
 *  started before a stage must not overwrite the status the stage produced, and
 *  a diff for the file the user has already clicked past must not land in the
 *  pane. Comparing the token on the way back is what makes "the newest request
 *  wins" true rather than "the slowest response wins". */
let statusToken = 0;
let diffToken = 0;

const toast = (message: string, tone: "info" | "warn" = "warn"): void => {
  useToastsStore.getState().push({ message, tone });
};

export const useGitStore = create<GitState & GitActions>()(
  devtools(
    immer<GitState & GitActions>((set, get) => ({
      ...initialState,

      setRepo: (repo) => {
        if (get().repo === repo) return;
        // Invalidate anything in flight for the previous repository: its status
        // and its diff are about a directory the panel has left.
        statusToken += 1;
        diffToken += 1;
        set((s) => {
          Object.assign(s, initialState);
          s.repo = repo;
        });
      },

      refresh: async () => {
        const repo = get().repo;
        if (!repo) return;
        const token = ++statusToken;
        set((s) => {
          s.loading = true;
        });
        try {
          const status = await commands.gitStatus(repo);
          if (token !== statusToken) return;
          set((s) => {
            s.status = status;
            s.error = null;
            s.loading = false;
          });
        } catch (err) {
          if (token !== statusToken) return;
          set((s) => {
            s.status = null;
            s.error = gitErrorMessage(err);
            s.loading = false;
          });
          return;
        }
        // The selected file may have been staged, committed or reverted by
        // whatever prompted this refresh. Re-read it if it is still listed;
        // drop it if it is not, rather than leaving a stale diff on screen
        // under a filename that no longer appears in any list.
        const { selection, status } = get();
        if (!selection || !status) return;
        if (
          listFor(status, selection.staged).some(
            (e) => e.path === selection.path,
          )
        ) {
          await get().select(selection.path, selection.staged);
        } else {
          get().clearSelection();
        }
      },

      select: async (path, staged) => {
        const repo = get().repo;
        if (!repo) return;
        const token = ++diffToken;
        set((s) => {
          s.selection = { path, staged };
          s.diffLoading = true;
          s.diffError = null;
        });
        try {
          const diff = await commands.gitDiff(repo, path, staged);
          if (token !== diffToken) return;
          set((s) => {
            s.diff = diff;
            s.diffLoading = false;
          });
        } catch (err) {
          if (token !== diffToken) return;
          set((s) => {
            s.diff = null;
            s.diffError = gitErrorMessage(err);
            s.diffLoading = false;
          });
        }
      },

      clearSelection: () => {
        diffToken += 1;
        set((s) => {
          s.selection = null;
          s.diff = null;
          s.diffError = null;
          s.diffLoading = false;
        });
      },

      stage: async (paths) => {
        const repo = get().repo;
        if (!repo || paths.length === 0) return;
        try {
          await commands.gitStage(repo, paths);
        } catch (err) {
          toast(gitErrorMessage(err));
          return;
        }
        // Follow the file across. Without this the selection is dropped by the
        // refresh below (the path left the unstaged list) and the diff the user
        // was reading disappears the moment they stage it — which is the moment
        // they most want to check it.
        const selection = get().selection;
        if (selection && !selection.staged && paths.includes(selection.path)) {
          set((s) => {
            if (s.selection) s.selection.staged = true;
          });
        }
        await get().refresh();
      },

      unstage: async (paths) => {
        const repo = get().repo;
        if (!repo || paths.length === 0) return;
        try {
          await commands.gitUnstage(repo, paths);
        } catch (err) {
          toast(gitErrorMessage(err));
          return;
        }
        const selection = get().selection;
        if (selection && selection.staged && paths.includes(selection.path)) {
          set((s) => {
            if (s.selection) s.selection.staged = false;
          });
        }
        await get().refresh();
      },

      setMessage: (message) =>
        set((s) => {
          s.message = message;
        }),

      commit: async () => {
        const { repo, message, committing } = get();
        if (!repo || committing) return null;
        if (message.trim().length === 0) return null;
        set((s) => {
          s.committing = true;
        });
        try {
          const sha = await commands.gitCommit(repo, message);
          set((s) => {
            s.committing = false;
            s.message = "";
          });
          toast(`Committed ${sha}`, "info");
          await get().refresh();
          return sha;
        } catch (err) {
          set((s) => {
            s.committing = false;
          });
          // The message is deliberately KEPT. A commit that a hook rejected is
          // one the user will retry, and throwing away what they wrote would
          // make the panel worse than the command line at the one moment it has
          // to be as good.
          toast(gitErrorMessage(err));
          return null;
        }
      },

      loadBranches: async () => {
        const repo = get().repo;
        if (!repo) return;
        set((s) => {
          s.branchesLoading = true;
        });
        try {
          const branches = await commands.gitBranches(repo);
          if (get().repo !== repo) return;
          set((s) => {
            s.branches = branches;
            s.branchesLoading = false;
          });
        } catch (err) {
          set((s) => {
            s.branches = [];
            s.branchesLoading = false;
          });
          toast(gitErrorMessage(err));
        }
      },

      checkout: async (branch, create) => {
        const repo = get().repo;
        if (!repo) return false;
        try {
          await commands.gitCheckout(repo, branch, create);
        } catch (err) {
          toast(gitErrorMessage(err));
          return false;
        }
        toast(`Now on ${branch}`, "info");
        get().clearSelection();
        await get().refresh();
        await get().loadBranches();
        return true;
      },

      focusCommitBox: () =>
        set((s) => {
          s.commitFocusNonce += 1;
        }),

      reset: () => {
        statusToken += 1;
        diffToken += 1;
        set((s) => {
          Object.assign(s, initialState);
        });
      },
    })),
    { name: "git" },
  ),
);

/** Follow `repo` and re-read the panel whenever anything `git status` would
 *  answer differently happens in it. Returns the teardown.
 *
 *  Mount and window focus were the panel's only two signals, and an agent
 *  working in the pane beside it fires neither: it never touches the window's
 *  focus, so everything it staged and committed left the file list describing a
 *  working tree that no longer existed, indefinitely, with nothing on screen
 *  saying so. This is the product's daily-driver case, not an edge.
 *
 *  `git://status` rather than `git://branch`, and the difference is the whole
 *  point: HEAD is the one thing staging and committing do not touch. Rust
 *  fingerprints what those operations DO move — `.git/index` above all — and
 *  this is the stream that carries it. See `EVENT_GIT_STATUS`.
 *
 *  The refresh it triggers is one `git status` for one event, and Rust emits at
 *  most one event per repository per two-second poll however much happened in
 *  between, so a rebase replaying forty commits cannot turn into forty reads.
 *
 *  Registering the watch is also how the root is learned, and that is the point
 *  of doing it here rather than matching on `repo`: Rust keys watches by
 *  repository root, canonicalized, while `repo` is whatever spelling the
 *  workspace stored — `/tmp/p` for `/private/tmp/p`, a path through a symlink,
 *  a trailing slash. Comparing the two directly would silently never match on
 *  exactly the machines where it matters most. Same reasoning as
 *  `useGitBranch`, and Rust reference-counts, so a pane already watching this
 *  repository just gains a reference.
 *
 *  The feedback loop this could have been is closed on the Rust side, not here:
 *  a plain `git status` rewrites `.git/index` to refresh its stat cache, which
 *  is precisely the file the watcher keys on, so the read this triggers would
 *  have triggered the next one forever. `git_status` passes
 *  `--no-optional-locks`. RocSpace's own stage/unstage/commit do move the index
 *  and do produce one event — worth exactly one extra `git status` after a
 *  button the user pressed, and then quiet.
 *
 *  Every IPC call is guarded — this runs in unit tests and in a plain browser
 *  dev server, where a rejection would surface as an unhandled one rather than
 *  a panel that simply does not auto-refresh. */
export function watchGitRepo(repo: string): () => void {
  let live = true;
  let unlisten: UnlistenFn | undefined;
  // The label the events for this repository will carry, known once the watch
  // lands. Until then there is nothing an event could be matched against.
  let root: string | null = null;

  const watching: Promise<GitWatchHandle | null> = (async () => {
    try {
      return await commands.gitWatch(repo);
    } catch {
      return null;
    }
  })();
  void watching.then((handle) => {
    if (handle !== null && live) root = handle.root;
  });

  void (async () => {
    try {
      const stop = await listen<GitStatusEvent>(EVENT_GIT_STATUS, (event) => {
        if (!live || root === null) return;
        // One stream for every watched repository — a worktree beside this
        // one, another window's project. Refreshing on all of them would spawn
        // a `git status` per event for repositories nothing is drawing.
        if (event.payload.root !== root) return;
        // And the panel may have been pointed somewhere else since, in which
        // case this refresh would read the wrong repository into it.
        if (useGitStore.getState().repo !== repo) return;
        // A minimised window is not somewhere a file list can be read. Left
        // ungated this is a `git status` every two seconds for as long as the
        // agents keep working, on behalf of nobody — and `GitView` re-reads on
        // the way back in, so nothing is lost by declining now.
        if (typeof document !== "undefined" && document.hidden) return;
        void useGitStore.getState().refresh();
      });
      // The panel may already be gone: `listen` is taken across an await.
      if (live) unlisten = stop;
      else stop();
    } catch {
      /* no IPC */
    }
  })();

  return () => {
    live = false;
    unlisten?.();
    void (async () => {
      // By the root the watch resolved to, and only once it has landed — a
      // panel closed mid-round-trip still gives its reference back.
      const handle = await watching;
      if (handle === null) return;
      try {
        await commands.gitUnwatch(handle.root);
      } catch {
        /* no IPC */
      }
    })();
  };
}

/** The paths `unstage` has to be given to undo one staged row.
 *
 *  A rename is TWO entries in the index — a deletion of the old name and an
 *  addition of the new one — drawn as a single `R` row holding the new path.
 *  Resetting only that path leaves the deletion staged, so one row comes apart
 *  into a staged `D old.txt` plus an untracked `new.txt`: half the rename
 *  undone, and no way to tell from the panel what happened. */
export function unstagePathsFor(entry: GitFileEntry): string[] {
  return entry.originPath ? [entry.path, entry.originPath] : [entry.path];
}

/** The list a selection's `staged` flag addresses.
 *
 *  Untracked files live in their own list but are read with `staged: false` —
 *  they are unstaged in every sense the panel cares about, and Rust synthesizes
 *  their diff — so "not staged" means "either of the two right-hand lists". */
export function listFor(status: GitStatus, staged: boolean): GitFileEntry[] {
  return staged ? status.staged : [...status.unstaged, ...status.untracked];
}

/** Is there anything to commit? The Commit button's whole condition. */
export function hasStagedChanges(status: GitStatus | null): boolean {
  return (status?.staged.length ?? 0) > 0;
}

// Selectors ---------------------------------------------------------------

export const useGitRepo = (): string | null => useGitStore((s) => s.repo);
export const useGitStatus = (): GitStatus | null =>
  useGitStore((s) => s.status);
export const useGitSelection = (): GitSelection | null =>
  useGitStore((s) => s.selection);
export const useGitBranches = (): GitBranch[] => useGitStore((s) => s.branches);
export const useGitMessage = (): string => useGitStore((s) => s.message);

/** Test seam: drop everything AND invalidate anything in flight, so a request
 *  started by one test cannot land in the next one's state. */
export function resetGitState(): void {
  useGitStore.getState().reset();
}
