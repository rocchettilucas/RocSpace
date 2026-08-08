/** What the Git panel contributes to the command palette, and what it takes
 *  back on the way out. */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import { allCommands } from "@/lib/commands/registry";
import { newWorkspace } from "@/lib/factories";
import { useEditorStore } from "@/stores/editor";
import { resetGitState, useGitStore } from "@/stores/git";
import { useUIStore } from "@/stores/ui";
import { useWorkspacesStore } from "@/stores/workspaces";
import { useGitCommands } from "@/views/RightPanel/useGitCommands";

const REPO = "/code/rocspace";

function Host() {
  useGitCommands();
  return null;
}

const gitCommands = () => allCommands().filter((c) => c.group === "Git");
const byId = (id: string) => gitCommands().find((c) => c.id === id);

function openWorkspace(projectPath: string | null): void {
  const workspace = newWorkspace({ name: "w", projectPath, order: 0 });
  useWorkspacesStore.setState({
    workspaces: [workspace],
    activeWorkspaceId: workspace.id,
  });
}

beforeEach(() => {
  invoke.mockReset();
  resetGitState();
  useWorkspacesStore.setState({ workspaces: [], activeWorkspaceId: null });
  useUIStore.setState({ gitDialog: null });
  useEditorStore.setState({
    rightDockMode: "inspector",
    rightPanelCollapsed: true,
  });
});

describe("useGitCommands", () => {
  it("registers on mount and unregisters on unmount", () => {
    expect(gitCommands()).toEqual([]);
    const view = render(<Host />);
    expect(gitCommands().length).toBeGreaterThan(0);
    // What the palette offers has to be what is mounted; a shell that is gone
    // must not still be advertising actions that would act on nothing.
    view.unmount();
    expect(gitCommands()).toEqual([]);
  });

  it("hides the repository actions when the workspace has no project", () => {
    const view = render(<Host />);
    try {
      openWorkspace(null);
      expect(byId("git.commit")?.enabled?.()).toBe(false);
      openWorkspace(REPO);
      expect(byId("git.commit")?.enabled?.()).toBe(true);
    } finally {
      view.unmount();
    }
  });

  it("opens the panel expanded and in Git mode", () => {
    const view = render(<Host />);
    try {
      openWorkspace(REPO);
      void byId("git.open")?.run();
      expect(useEditorStore.getState().rightPanelCollapsed).toBe(false);
      expect(useEditorStore.getState().rightDockMode).toBe("git");
    } finally {
      view.unmount();
    }
  });

  it("stages everything from a cold panel, reading the status first", async () => {
    const staged: string[][] = [];
    invoke.mockImplementation((name: string, args: never) => {
      if (name === "git_status") {
        return Promise.resolve({
          branch: "main",
          ahead: 0,
          behind: 0,
          staged: [],
          unstaged: [{ path: "a.ts", status: "modified" }],
          untracked: [{ path: "b.ts", status: "untracked" }],
        });
      }
      if (name === "git_stage") {
        staged.push((args as { paths: string[] }).paths);
        return Promise.resolve(undefined);
      }
      return Promise.reject(new Error(`unexpected ${name}`));
    });

    const view = render(<Host />);
    try {
      openWorkspace(REPO);
      // The palette can be opened without the Git panel ever having been
      // shown, so the action has to point the store at the repository and read
      // it before it can act.
      expect(useGitStore.getState().status).toBeNull();
      await byId("git.stage-all")?.run();
      expect(staged).toEqual([["a.ts", "b.ts"]]);
    } finally {
      view.unmount();
    }
  });

  it("refreshes a panel that has already read, and shows it", async () => {
    let reads = 0;
    invoke.mockImplementation((name: string) => {
      if (name !== "git_status")
        return Promise.reject(new Error(`unexpected ${name}`));
      reads += 1;
      return Promise.resolve({
        branch: "main",
        ahead: 0,
        behind: 0,
        staged: [],
        unstaged: [],
        untracked: [],
      });
    });

    const view = render(<Host />);
    try {
      openWorkspace(REPO);
      await byId("git.refresh")?.run();
      expect(reads).toBe(1);

      // The moment you ask for a refresh is exactly the moment the panel HAS
      // read — which is when the old short-circuit made this a no-op.
      await byId("git.refresh")?.run();
      expect(reads).toBe(2);
      // …and it brings the answer on screen, which is the point of asking.
      expect(useEditorStore.getState().rightDockMode).toBe("git");
      expect(useEditorStore.getState().rightPanelCollapsed).toBe(false);
    } finally {
      view.unmount();
    }
  });

  it("stages what is there NOW, not what the panel last read", async () => {
    const staged: string[][] = [];
    let unstagedFiles = [{ path: "a.ts", status: "modified" }];
    invoke.mockImplementation((name: string, args: never) => {
      if (name === "git_status") {
        return Promise.resolve({
          branch: "main",
          ahead: 0,
          behind: 0,
          staged: [],
          unstaged: unstagedFiles,
          untracked: [],
        });
      }
      if (name === "git_stage") {
        staged.push((args as { paths: string[] }).paths);
        return Promise.resolve(undefined);
      }
      return Promise.reject(new Error(`unexpected ${name}`));
    });

    const view = render(<Host />);
    try {
      openWorkspace(REPO);
      await byId("git.stage-all")?.run();
      expect(staged).toEqual([["a.ts"]]);

      // An agent wrote another file in the meantime. A panel that has read
      // once used to act on the list it read then.
      unstagedFiles = [
        { path: "a.ts", status: "modified" },
        { path: "b.ts", status: "modified" },
      ];
      await byId("git.stage-all")?.run();
      expect(staged.at(-1)).toEqual(["a.ts", "b.ts"]);
    } finally {
      view.unmount();
    }
  });

  it("unstages both halves of a rename", async () => {
    const unstaged: string[][] = [];
    invoke.mockImplementation((name: string, args: never) => {
      if (name === "git_status") {
        return Promise.resolve({
          branch: "main",
          ahead: 0,
          behind: 0,
          staged: [
            { path: "new.txt", status: "renamed", originPath: "old.txt" },
          ],
          unstaged: [],
          untracked: [],
        });
      }
      if (name === "git_unstage") {
        unstaged.push((args as { paths: string[] }).paths);
        return Promise.resolve(undefined);
      }
      return Promise.reject(new Error(`unexpected ${name}`));
    });

    const view = render(<Host />);
    try {
      openWorkspace(REPO);
      await byId("git.unstage-all")?.run();
      // Without the origin, `git reset -- new.txt` leaves its staged deletion
      // behind and the rename comes apart.
      expect(unstaged).toEqual([["new.txt", "old.txt"]]);
    } finally {
      view.unmount();
    }
  });

  it("titles the commit row for what it actually does", () => {
    const view = render(<Host />);
    try {
      // It opens the panel and focuses the message box. It does not commit —
      // the button in the panel does, once there is a message.
      expect(byId("git.commit")?.title).not.toMatch(/^Commit staged changes$/);
      expect(byId("git.commit")?.title).toMatch(/commit message/i);
    } finally {
      view.unmount();
    }
  });

  it("opens the panel alongside a dialog, never the dialog alone", async () => {
    invoke.mockImplementation(() =>
      Promise.resolve({
        branch: "main",
        ahead: 0,
        behind: 0,
        staged: [],
        unstaged: [],
        untracked: [],
      }),
    );
    const view = render(<Host />);
    try {
      openWorkspace(REPO);
      await byId("git.new-worktree")?.run();
      expect(useUIStore.getState().gitDialog).toBe("worktree");
      // `GitView` renders the dialogs. Setting the flag without showing the
      // panel would leave the app in a modal state with nothing drawn.
      expect(useEditorStore.getState().rightDockMode).toBe("git");
      expect(useEditorStore.getState().rightPanelCollapsed).toBe(false);
    } finally {
      view.unmount();
    }
  });
});
