/** The worktree dialog — the one place in the panel that CREATES something the
 *  rest of the app then has to know about. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(async () => null),
}));

import { open as openDirectoryDialog } from "@tauri-apps/plugin-dialog";
import { resetGitState, useGitStore } from "@/stores/git";
import { resetToastsState, useToastsStore } from "@/stores/toasts";
import { setWorkspaceSpawner, useWorkspacesStore } from "@/stores/workspaces";
import { useTerminalsStore } from "@/stores/terminals";
import {
  GitWorktreeDialog,
  suggestWorktreePath,
} from "@/views/RightPanel/GitWorktreeDialog";

const REPO = "/code/rocspace";

let restoreSpawner: () => void = () => {};

beforeEach(() => {
  invoke.mockReset();
  // The dialog asks for the branch list on open, for the datalist behind the
  // "check out an existing branch" half. Rust always answers with an array.
  invoke.mockImplementation((name: string) =>
    Promise.resolve(name === "git_branches" ? [] : undefined),
  );
  resetGitState();
  resetToastsState();
  useWorkspacesStore.setState({ workspaces: [], activeWorkspaceId: null });
  useTerminalsStore.setState({ byId: {} });
  useGitStore.setState({ repo: REPO });
  restoreSpawner = setWorkspaceSpawner(() => {});
});

afterEach(() => {
  restoreSpawner();
});

describe("suggestWorktreePath", () => {
  it("puts the worktree beside the repository, named for the branch", () => {
    expect(suggestWorktreePath("/code/rocspace", "feature/thing")).toBe(
      "/code/rocspace-feature-thing",
    );
    // A trailing slash on the repository must not double up.
    expect(suggestWorktreePath("/code/rocspace/", "topic")).toBe(
      "/code/rocspace-topic",
    );
  });

  it("suggests nothing until there is a branch to name it after", () => {
    expect(suggestWorktreePath(REPO, "")).toBe("");
    expect(suggestWorktreePath(REPO, "///")).toBe("");
  });
});

describe("GitWorktreeDialog", () => {
  it("creates the worktree with the typed branch and the suggested path", async () => {
    const calls: Record<string, unknown>[] = [];
    invoke.mockImplementation((name: string, args: Record<string, unknown>) => {
      if (name === "git_worktree_add") calls.push(args);
      return Promise.resolve(name === "git_branches" ? [] : undefined);
    });

    render(<GitWorktreeDialog onClose={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText("feature/thing"), {
      target: { value: "topic" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create worktree" }));
    });

    expect(calls).toEqual([
      {
        repo: REPO,
        path: "/code/rocspace-topic",
        branch: "topic",
        createBranch: true,
      },
    ]);
  });

  it("offers to open the new worktree as a workspace, and does", async () => {
    invoke.mockImplementation((name: string) =>
      Promise.resolve(name === "git_branches" ? [] : undefined),
    );

    render(<GitWorktreeDialog onClose={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText("feature/thing"), {
      target: { value: "topic" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create worktree" }));
    });

    // A worktree with nothing running in it is just a directory; this is the
    // step that makes it a place to work.
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Open as workspace" }),
      );
    });

    const workspaces = useWorkspacesStore.getState().workspaces;
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]?.projectPath).toBe("/code/rocspace-topic");
    expect(useWorkspacesStore.getState().activeWorkspaceId).toBe(
      workspaces[0]?.id,
    );
  });

  it("says what git said and stays open when the branch already exists", async () => {
    invoke.mockImplementation((name: string) =>
      name === "git_worktree_add"
        ? Promise.reject("fatal: a branch named 'topic' already exists")
        : Promise.resolve(name === "git_branches" ? [] : undefined),
    );

    render(<GitWorktreeDialog onClose={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText("feature/thing"), {
      target: { value: "topic" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create worktree" }));
    });

    expect(useToastsStore.getState().items.map((t) => t.message)).toEqual([
      "fatal: a branch named 'topic' already exists",
    ]);
    // Still on the form, with what was typed — the fix is usually one word.
    expect(
      screen.getByRole("button", { name: "Create worktree" }),
    ).toBeVisible();
  });

  it("says so when the directory picker will not open", async () => {
    vi.mocked(openDirectoryDialog).mockRejectedValueOnce(
      "dialog plugin is not initialised",
    );

    render(<GitWorktreeDialog onClose={() => {}} />);
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Choose a directory" }),
      );
    });

    // A `console.warn` here meant clicking the folder icon did nothing, with
    // no sentence anywhere the user can see — the other failure in this same
    // dialog toasts, and so does this one now.
    expect(useToastsStore.getState().items.map((t) => t.message)).toEqual([
      "Could not open the directory picker: dialog plugin is not initialised",
    ]);
  });

  it("will not create anything without a branch name", () => {
    render(<GitWorktreeDialog onClose={() => {}} />);
    expect(
      screen.getByRole("button", { name: "Create worktree" }),
    ).toBeDisabled();
  });
});
