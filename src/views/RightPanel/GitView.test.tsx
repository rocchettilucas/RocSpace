/** The Git panel, from the outside: what it draws for a repository, what it
 *  draws for a directory that is not one, and what pressing things does. */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

/** Handlers by event NAME, so a test can prove which of Rust's two streams the
 *  panel is on — `git://branch` never fires for a commit, which is the whole
 *  reason `git://status` exists. */
const listeners = new Map<string, (e: { payload: unknown }) => void>();
const unlisten = vi.fn();
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(
    async (event: string, handler: (e: { payload: unknown }) => void) => {
      listeners.set(event, handler);
      return unlisten;
    },
  ),
}));

// Monaco pulls five web workers in through Vite's `?worker` syntax and lays
// nothing out in jsdom. The panel's job is to hand it a path and a diff; that
// it does so is the assertion, and the editor itself is not this test's
// business.
vi.mock("@/views/RightPanel/GitDiffPane", () => ({
  GitDiffPane: ({ path, diff }: { path: string; diff: string }) => (
    <div data-testid="diff-pane" data-path={path}>
      {diff}
    </div>
  ),
}));

import {
  EVENT_GIT_BRANCH,
  EVENT_GIT_STATUS,
  type GitStatus,
} from "@/lib/bindings";
import { resetGitState, useGitStore } from "@/stores/git";
import { resetToastsState } from "@/stores/toasts";
import { useUIStore } from "@/stores/ui";
import { useWorkspacesStore } from "@/stores/workspaces";
import { newWorkspace } from "@/lib/factories";
import { GitView } from "@/views/RightPanel/GitView";

const REPO = "/code/rocspace";

const status = (over: Partial<GitStatus> = {}): GitStatus => ({
  branch: "main",
  ahead: 0,
  behind: 0,
  staged: [],
  unstaged: [],
  untracked: [],
  ...over,
});

function route(handlers: Record<string, (args: never) => unknown>): void {
  invoke.mockImplementation((name: string, args: never) => {
    const handler = handlers[name];
    if (!handler)
      return Promise.reject(new Error(`unexpected command ${name}`));
    return Promise.resolve(handler(args));
  });
}

function openWorkspace(projectPath: string | null): void {
  const workspace = newWorkspace({ name: "w", projectPath, order: 0 });
  useWorkspacesStore.setState({
    workspaces: [workspace],
    activeWorkspaceId: workspace.id,
  });
}

beforeEach(() => {
  invoke.mockReset();
  listeners.clear();
  unlisten.mockReset();
  resetGitState();
  resetToastsState();
  useUIStore.setState({ gitDialog: null });
  useWorkspacesStore.setState({ workspaces: [], activeWorkspaceId: null });
});

/** The watcher half of every render below: registering it is what tells the
 *  panel which root the events it hears will be labelled with. */
const watching = (root = REPO) => ({
  git_watch: () => ({ root, branch: "main" }),
  git_unwatch: () => undefined,
});

/** Wait for the panel's subscription to have landed — it is taken across an
 *  await, so an emit before it lands would go nowhere — and hand back an
 *  emitter for it. */
async function subscribed(): Promise<(payload: unknown) => void> {
  await waitFor(() => expect(listeners.has(EVENT_GIT_STATUS)).toBe(true));
  const handler = listeners.get(EVENT_GIT_STATUS)!;
  return (payload) => handler({ payload });
}

describe("GitView", () => {
  it("says so when the workspace has no project directory", () => {
    openWorkspace(null);
    render(<GitView />);
    expect(screen.getByText(/no project directory/i)).toBeVisible();
    // Nothing to ask git about, so nothing was asked.
    expect(invoke).not.toHaveBeenCalled();
  });

  it("draws git's refusal in place for a directory that is not a repository", async () => {
    route({
      git_status: () =>
        Promise.reject("fatal: not a git repository (or any of the parent…)"),
    });
    openWorkspace(REPO);
    render(<GitView />);
    expect(await screen.findByText(/not a git repository/i)).toBeVisible();
  });

  it("shows the branch, the three lists and a clean tree", async () => {
    route({ git_status: () => status({ ahead: 2 }) });
    openWorkspace(REPO);
    render(<GitView />);

    expect(await screen.findByText("main")).toBeVisible();
    expect(screen.getByText("2")).toBeVisible();
    expect(screen.getByText(/working tree is clean/i)).toBeVisible();
  });

  it("loads a file's diff when its row is pressed", async () => {
    const asked: { path?: string; staged?: boolean } = {};
    route({
      git_status: () =>
        status({ unstaged: [{ path: "src/a.ts", status: "modified" }] }),
      git_diff: (args: { path: string; staged: boolean }) => {
        asked.path = args.path;
        asked.staged = args.staged;
        return "@@ -1 +1 @@\n-a\n+b\n";
      },
    });
    openWorkspace(REPO);
    render(<GitView />);

    const row = await screen.findByTitle("src/a.ts — modified");
    await act(async () => {
      fireEvent.click(row);
    });

    expect(asked).toEqual({ path: "src/a.ts", staged: false });
    const pane = await screen.findByTestId("diff-pane");
    expect(pane.getAttribute("data-path")).toBe("src/a.ts");
  });

  it("stages one file from its row and re-reads the status", async () => {
    const staged: string[][] = [];
    route({
      git_status: () =>
        status({ untracked: [{ path: "new.ts", status: "untracked" }] }),
      git_stage: (args: { paths: string[] }) => {
        staged.push(args.paths);
      },
    });
    openWorkspace(REPO);
    render(<GitView />);

    const button = await screen.findByRole("button", { name: "Stage new.ts" });
    await act(async () => {
      fireEvent.click(button);
    });
    expect(staged).toEqual([["new.ts"]]);
  });

  it("stages every changed file at once, untracked ones included", async () => {
    const staged: string[][] = [];
    route({
      git_status: () =>
        status({
          unstaged: [{ path: "a.ts", status: "modified" }],
          untracked: [{ path: "b.ts", status: "untracked" }],
        }),
      git_stage: (args: { paths: string[] }) => {
        staged.push(args.paths);
      },
    });
    openWorkspace(REPO);
    render(<GitView />);

    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Stage all" }));
    });
    expect(staged).toEqual([["a.ts", "b.ts"]]);
  });

  it("will not commit with nothing staged, however good the message", async () => {
    route({
      git_status: () =>
        status({ unstaged: [{ path: "a.ts", status: "modified" }] }),
    });
    openWorkspace(REPO);
    render(<GitView />);

    await screen.findByText("main");
    fireEvent.change(screen.getByLabelText("Commit message"), {
      target: { value: "feat: something" },
    });
    expect(screen.getByRole("button", { name: "Commit" })).toBeDisabled();
  });

  it("commits when there is something staged and something written", async () => {
    const committed: string[] = [];
    route({
      git_status: () =>
        status({ staged: [{ path: "a.ts", status: "modified" }] }),
      git_commit: (args: { message: string }) => {
        committed.push(args.message);
        return "abc1234";
      },
    });
    openWorkspace(REPO);
    render(<GitView />);

    await screen.findByText("main");
    fireEvent.change(screen.getByLabelText("Commit message"), {
      target: { value: "feat: something" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Commit" }));
    });
    expect(committed).toEqual(["feat: something"]);
  });

  it("commits on ⌘Enter from inside the box, and does nothing on a bare Enter", async () => {
    const committed: string[] = [];
    route({
      git_status: () =>
        status({ staged: [{ path: "a.ts", status: "modified" }] }),
      git_commit: (args: { message: string }) => {
        committed.push(args.message);
        return "abc1234";
      },
    });
    openWorkspace(REPO);
    render(<GitView />);

    await screen.findByText("main");
    const box = screen.getByLabelText("Commit message");
    fireEvent.change(box, { target: { value: "feat: something" } });

    // A commit message has a subject and a body; Enter has to be a newline.
    fireEvent.keyDown(box, { key: "Enter" });
    expect(committed).toEqual([]);

    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter", metaKey: true });
    });
    expect(committed).toEqual(["feat: something"]);
  });

  it("re-reads when the repository moves under it, with no window focus", async () => {
    let reads = 0;
    route({
      git_status: () => {
        reads += 1;
        return status();
      },
      ...watching(),
    });
    openWorkspace(REPO);
    render(<GitView />);
    await waitFor(() => expect(reads).toBe(1));
    const emit = await subscribed();

    // An agent staging or committing in the pane beside this one fires no
    // window focus event, and focus was the panel's only signal — so the file
    // list stayed on a pre-commit picture indefinitely.
    await act(async () => {
      emit({ root: REPO });
    });
    await waitFor(() => expect(reads).toBe(2));
  });

  it("follows the status stream, not the branch chip's", async () => {
    route({ git_status: () => status(), ...watching() });
    openWorkspace(REPO);
    render(<GitView />);
    await subscribed();

    // `git://branch` fires only when HEAD moves, and a commit on the branch
    // already checked out moves `refs/heads/<branch>` instead. A panel on that
    // stream can never see the commit that is happening beside it.
    expect(listeners.has(EVENT_GIT_STATUS)).toBe(true);
    expect(listeners.has(EVENT_GIT_BRANCH)).toBe(false);
  });

  it("declines to read a repository nobody can see", async () => {
    let reads = 0;
    route({
      git_status: () => {
        reads += 1;
        return status();
      },
      ...watching(),
    });
    openWorkspace(REPO);
    render(<GitView />);
    await waitFor(() => expect(reads).toBe(1));
    const emit = await subscribed();

    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    try {
      // Minimised, with three agents working: an unbounded `git status` every
      // two seconds on behalf of nobody.
      await act(async () => {
        emit({ root: REPO });
      });
      expect(reads).toBe(1);
    } finally {
      hidden.mockRestore();
    }

    // …and what it declined is collected on the way back in.
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(reads).toBe(2));
  });

  it("ignores a repository it is not showing", async () => {
    let reads = 0;
    route({
      git_status: () => {
        reads += 1;
        return status();
      },
      ...watching(),
    });
    openWorkspace(REPO);
    render(<GitView />);
    await waitFor(() => expect(reads).toBe(1));
    const emit = await subscribed();

    // One event stream for every watched repository — a worktree beside this
    // one, another window's project. Refreshing on all of them would spawn a
    // `git status` for repositories the panel is not drawing.
    await act(async () => {
      emit({ root: "/code/somewhere-else" });
    });
    expect(reads).toBe(1);
  });

  it("gives the watch back when the panel goes away", async () => {
    const unwatched: string[] = [];
    route({
      git_status: () => status(),
      git_watch: () => ({ root: REPO, branch: "main" }),
      git_unwatch: (args: { root: string }) => {
        unwatched.push(args.root);
      },
    });
    openWorkspace(REPO);
    const view = render(<GitView />);
    await subscribed();

    await act(async () => {
      view.unmount();
    });

    expect(unwatched).toEqual([REPO]);
    expect(unlisten).toHaveBeenCalled();
  });

  it("names the state the counters describe, not verbs it cannot perform", async () => {
    // There is no `git_push` and no `git_pull` anywhere behind this panel.
    route({ git_status: () => status({ ahead: 2, behind: 3 }), ...watching() });
    openWorkspace(REPO);
    render(<GitView />);

    await screen.findByText("main");
    expect(screen.getByTitle(/2 commit\(s\) ahead of upstream/)).toBeVisible();
    expect(screen.getByTitle(/3 commit\(s\) behind upstream/)).toBeVisible();
    expect(screen.queryByTitle(/to push/)).toBeNull();
    expect(screen.queryByTitle(/to pull/)).toBeNull();
  });

  it("unstages both halves of a rename, and says what it was renamed from", async () => {
    const unstaged: string[][] = [];
    route({
      git_status: () =>
        status({
          staged: [
            { path: "new.txt", status: "renamed", originPath: "old.txt" },
          ],
        }),
      git_unstage: (args: { paths: string[] }) => {
        unstaged.push(args.paths);
      },
      ...watching(),
    });
    openWorkspace(REPO);
    render(<GitView />);

    // A rename is the one row that never says where it came from, and the
    // per-file diff has no rename header to give it away.
    const row = await screen.findByTitle("new.txt — renamed from old.txt");
    expect(row).toBeVisible();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Unstage new.txt" }));
    });

    // `git reset -- new.txt` alone leaves the origin's staged deletion behind:
    // one `R` row becomes a staged `D old.txt` plus an untracked `new.txt`.
    expect(unstaged).toEqual([["new.txt", "old.txt"]]);
  });

  it("unstages both halves of a rename from the bulk button too", async () => {
    const unstaged: string[][] = [];
    route({
      git_status: () =>
        status({
          staged: [
            { path: "a.ts", status: "modified" },
            { path: "new.txt", status: "renamed", originPath: "old.txt" },
          ],
        }),
      git_unstage: (args: { paths: string[] }) => {
        unstaged.push(args.paths);
      },
      ...watching(),
    });
    openWorkspace(REPO);
    render(<GitView />);

    await act(async () => {
      fireEvent.click(
        await screen.findByRole("button", { name: "Unstage all" }),
      );
    });

    expect(unstaged).toEqual([["a.ts", "new.txt", "old.txt"]]);
  });

  it("re-reads on window focus, because an agent may have been working", async () => {
    let reads = 0;
    route({
      git_status: () => {
        reads += 1;
        return status();
      },
    });
    openWorkspace(REPO);
    render(<GitView />);
    await waitFor(() => expect(reads).toBe(1));

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(reads).toBe(2);
  });

  it("opens the branch dialog from the header, and blocks the pane chords while it is up", async () => {
    route({
      git_status: () => status(),
      git_branches: () => [{ name: "main", isCurrent: true, isRemote: false }],
    });
    openWorkspace(REPO);
    render(<GitView />);

    await act(async () => {
      fireEvent.click(await screen.findByTitle("Switch or create a branch"));
    });

    expect(screen.getByRole("dialog")).toBeVisible();
    // The scrim stops the mouse, not the keyboard — the guard is what stops
    // ⌘W closing a pane the user cannot see behind the dialog.
    expect(useUIStore.getState().gitDialog).toBe("branch");
  });

  it("takes its dialog flag down with it when the panel goes away", async () => {
    route({
      git_status: () => status(),
      git_branches: () => [],
    });
    openWorkspace(REPO);
    const view = render(<GitView />);

    await act(async () => {
      fireEvent.click(await screen.findByTitle("Switch or create a branch"));
    });
    expect(useUIStore.getState().gitDialog).toBe("branch");

    // A flag that outlives its renderer is a dead app: nothing drawn, no scrim,
    // and every chord — ⌘T included — standing down for a modal nobody can
    // close.
    view.unmount();
    expect(useUIStore.getState().gitDialog).toBeNull();
  });

  it("focuses the commit box when the ⌘⇧K nonce moves", async () => {
    route({ git_status: () => status() });
    openWorkspace(REPO);
    render(<GitView />);
    await screen.findByText("main");

    act(() => {
      useGitStore.getState().focusCommitBox();
    });
    expect(document.activeElement).toBe(
      screen.getByLabelText("Commit message"),
    );
  });
});
