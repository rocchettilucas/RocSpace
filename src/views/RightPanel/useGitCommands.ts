/** Everything the Git panel can do, contributed to the command palette.
 *
 *  Registered from an effect rather than at module scope so the list goes away
 *  with the shell: with no workspace open there is no repository, and a palette
 *  offering "Commit staged changes" with nothing to commit it in is a menu of
 *  dead ends.
 *
 *  Every action here is written to work from a COLD panel. The palette can be
 *  opened without the Git mode ever having been shown, in which case the store
 *  has no repository and no status — so each action points the store at the
 *  active workspace and reads once before acting. That is one `git status` for
 *  a keystroke the user made deliberately, and the alternative is a palette
 *  whose git entries silently do nothing until you have visited the panel. */

import { useEffect } from "react";
import { registerCommands } from "@/lib/commands/registry";
import { useEditorStore } from "@/stores/editor";
import { unstagePathsFor, useGitStore } from "@/stores/git";
import { useUIStore } from "@/stores/ui";
import { useWorkspacesStore } from "@/stores/workspaces";

/** The repository the panel would be looking at, whether or not it is open. */
function activeRepoPath(): string | null {
  const { workspaces, activeWorkspaceId } = useWorkspacesStore.getState();
  if (!activeWorkspaceId) return null;
  return (
    workspaces.find((w) => w.id === activeWorkspaceId)?.projectPath ?? null
  );
}

/** Bring the panel on screen — expanded, in Git mode. */
function showGitPanel(): void {
  const editor = useEditorStore.getState();
  editor.setRightPanelCollapsed(false);
  editor.setRightDockMode("git");
}

/** Point the store at the active repository and read it, NOW.
 *
 *  Returns false when there is nothing to act on, so every caller can bail with
 *  one line instead of re-deriving the same three conditions.
 *
 *  Unconditionally, which is the whole point and was not always true: reading
 *  only when the store had never read made every action here act on whatever
 *  the panel last saw, and made the refresh row itself a no-op in exactly the
 *  case someone would use it. One `git status` for a keystroke the user made
 *  deliberately is the trade this file already documents. */
async function ensureGitLoaded(): Promise<boolean> {
  const repo = activeRepoPath();
  if (!repo) return false;
  useGitStore.getState().setRepo(repo);
  await useGitStore.getState().refresh();
  return useGitStore.getState().status !== null;
}

/** Open the panel AND a dialog on it. The dialogs are rendered by `GitView`, so
 *  the flag on its own would put the app in a modal state with nothing drawn. */
function openGitDialog(kind: "branch" | "worktree" | "review"): void {
  showGitPanel();
  useUIStore.getState().openGitDialog(kind);
}

export function useGitCommands(): void {
  useEffect(
    () =>
      registerCommands([
        {
          id: "git.open",
          title: "Open the Git panel",
          group: "Git",
          keywords: ["source control", "changes", "diff", "vcs"],
          run: showGitPanel,
        },
        {
          // Titled for what it does. It opens the panel and puts the cursor in
          // the message box; the button under that box is what commits, once
          // there is something to commit and something written.
          id: "git.commit",
          title: "Write a commit message…",
          group: "Git",
          keywords: ["commit", "message", "checkin", "staged"],
          shortcut: "⌘⇧K",
          enabled: () => activeRepoPath() !== null,
          run: () => {
            showGitPanel();
            useGitStore.getState().focusCommitBox();
          },
        },
        {
          id: "git.refresh",
          title: "Refresh the Git status",
          group: "Git",
          keywords: ["reload", "status"],
          enabled: () => activeRepoPath() !== null,
          run: async () => {
            // On screen as well as re-read: a refresh whose answer lands in a
            // collapsed panel is a `git status` nobody can see.
            showGitPanel();
            await ensureGitLoaded();
          },
        },
        {
          id: "git.stage-all",
          title: "Stage every change",
          group: "Git",
          keywords: ["add", "index", "all"],
          enabled: () => activeRepoPath() !== null,
          run: async () => {
            if (!(await ensureGitLoaded())) return;
            const status = useGitStore.getState().status;
            if (!status) return;
            await useGitStore
              .getState()
              .stage(
                [...status.unstaged, ...status.untracked].map((e) => e.path),
              );
          },
        },
        {
          id: "git.unstage-all",
          title: "Unstage everything",
          group: "Git",
          keywords: ["reset", "index"],
          enabled: () => activeRepoPath() !== null,
          run: async () => {
            if (!(await ensureGitLoaded())) return;
            const status = useGitStore.getState().status;
            if (!status) return;
            await useGitStore
              .getState()
              .unstage(status.staged.flatMap(unstagePathsFor));
          },
        },
        {
          id: "git.switch-branch",
          title: "Switch or create a branch…",
          group: "Git",
          keywords: ["checkout", "branch", "new branch"],
          enabled: () => activeRepoPath() !== null,
          run: () => openGitDialog("branch"),
        },
        {
          id: "git.new-worktree",
          title: "New worktree…",
          group: "Git",
          keywords: ["worktree", "parallel", "branch", "clone"],
          enabled: () => activeRepoPath() !== null,
          run: () => openGitDialog("worktree"),
        },
        {
          id: "git.review-diff",
          title: "Ask an agent to review the staged diff",
          group: "Git",
          keywords: ["review", "agent", "diff", "claude"],
          enabled: () => activeRepoPath() !== null,
          run: async () => {
            // Loaded before the dialog opens so it can say how many files are
            // staged rather than "nothing" on a panel that has never read.
            await ensureGitLoaded();
            openGitDialog("review");
          },
        },
      ]),
    [],
  );
}
