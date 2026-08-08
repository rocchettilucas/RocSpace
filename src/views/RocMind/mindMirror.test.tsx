/** The mirror: a memory written by an agent in a pane, appearing without a
 *  reload — and telling you about it while you are looking somewhere else. */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

let emitChange: ((payload: { scope: string }) => void) | null = null;
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(
    async (_event: string, handler: (e: { payload: unknown }) => void) => {
      emitChange = (payload) => handler({ payload });
      return () => {};
    },
  ),
}));

import { newWorkspace } from "@/lib/factories";
import { encodeScopeSlug, scopeSlugsForProject } from "@/lib/mindTree";
import { resetRocMindModuleState, useRocMindStore } from "@/stores/rocmind";
import { useToastsStore } from "@/stores/toasts";
import { useUIStore } from "@/stores/ui";
import { useWorkspacesStore } from "@/stores/workspaces";
import { useMindMirror } from "@/views/RocMind/useMindMirror";
import type { MindMemory, MindScope } from "@/lib/bindings";

const PROJECT = "/Users/l/Storefront";
const SCOPE = "-Users-l-Storefront";
const WORKTREE = "-Users-l-Storefront--claude-worktrees-v1-1";

const storefront: MindScope = {
  slug: SCOPE,
  projectPath: PROJECT,
  label: "Storefront",
  isWorktree: false,
  rootPath: null,
  count: 1,
};
const worktree: MindScope = {
  slug: WORKTREE,
  projectPath: `${PROJECT}/.claude/worktrees/v1.1`,
  label: "v1.1",
  isWorktree: true,
  rootPath: PROJECT,
  count: 1,
};

const memory = (name: string): MindMemory => ({
  scope: SCOPE,
  path: `/p/${SCOPE}/memory/${name}.md`,
  name,
  description: "",
  memoryType: "project",
  links: [],
  updatedAt: 1,
  bytes: 10,
});

function Harness() {
  useMindMirror();
  return null;
}

let lists: Record<string, MindMemory[]> = {};
let scopes: MindScope[] = [];

function mockIpc() {
  invoke.mockImplementation(
    async (cmd: string, args?: Record<string, string>) => {
      // A fresh array per call, the way IPC deserialization really behaves.
      if (cmd === "mind_scopes") return [...scopes];
      if (cmd === "mind_list") return lists[args?.scope ?? ""] ?? [];
      if (cmd === "mind_read") return "body";
      return null;
    },
  );
}

const watchedSlugs = () =>
  invoke.mock.calls
    .filter(([cmd]) => cmd === "mind_watch")
    .map(([, args]) => (args as { scope: string }).scope);

function openWorkspace(projectPath: string | null) {
  const workspace = newWorkspace({ projectPath, order: 0 });
  useWorkspacesStore.setState({
    workspaces: [workspace],
    activeWorkspaceId: workspace.id,
  });
  return workspace;
}

beforeEach(() => {
  invoke.mockReset();
  emitChange = null;
  scopes = [storefront, worktree];
  lists = { [SCOPE]: [memory("payments-provider-migration")], [WORKTREE]: [] };
  mockIpc();
  resetRocMindModuleState();
  useWorkspacesStore.setState({ workspaces: [], activeWorkspaceId: null });
  useToastsStore.setState({ items: [] });
  useUIStore.setState({ mainView: "terminals" });
});

describe("scopeSlugsForProject", () => {
  it("covers the project's own scope and its worktrees'", () => {
    // The worktree is the half that is easy to miss: an agent running inside
    // one writes there, and Claude Code files it as a separate scope.
    expect(scopeSlugsForProject([storefront, worktree], PROJECT)).toEqual([
      SCOPE,
      WORKTREE,
    ]);
  });

  it("covers a workspace opened directly on a worktree", () => {
    expect(
      scopeSlugsForProject([storefront, worktree], worktree.projectPath),
    ).toEqual([WORKTREE]);
  });

  it("guesses the slug of a project that has no memories yet", () => {
    // Otherwise the FIRST memory in a project is the one memory that needs a
    // reload to be seen.
    expect(scopeSlugsForProject([storefront], "/Users/l/Fresh")).toEqual([
      "-Users-l-Fresh",
    ]);
  });

  it("encodes the way Claude Code does", () => {
    expect(encodeScopeSlug("/Users/l/Storefront/.claude/worktrees/v1.1")).toBe(
      "-Users-l-Storefront--claude-worktrees-v1-1",
    );
    expect(encodeScopeSlug("/Users/l/Acme Site")).toBe("-Users-l-Acme-Site");
  });

  it("ignores a workspace with no directory", () => {
    expect(scopeSlugsForProject([storefront], "")).toEqual([]);
  });
});

describe("the mirror", () => {
  it("watches an open workspace's scopes and its worktrees'", async () => {
    openWorkspace(PROJECT);
    render(<Harness />);
    await waitFor(() => {
      expect(watchedSlugs()).toEqual(expect.arrayContaining([SCOPE, WORKTREE]));
    });
  });

  it("hands the watches back when the workspace closes", async () => {
    openWorkspace(PROJECT);
    const { rerender } = render(<Harness />);
    await waitFor(() => expect(watchedSlugs()).toContain(SCOPE));

    useWorkspacesStore.setState({ workspaces: [], activeWorkspaceId: null });
    rerender(<Harness />);
    await waitFor(() => {
      const unwatched = invoke.mock.calls
        .filter(([cmd]) => cmd === "mind_unwatch")
        .map(([, args]) => (args as { scope: string }).scope);
      expect(unwatched).toEqual(expect.arrayContaining([SCOPE, WORKTREE]));
    });
  });

  it("does not re-take a watch it already holds when the workspace list moves", async () => {
    // Dropping and re-taking would re-seed the scope's baseline in Rust, and a
    // memory written inside that window would never be announced.
    const first = openWorkspace(PROJECT);
    const { rerender } = render(<Harness />);
    await waitFor(() => expect(watchedSlugs()).toContain(SCOPE));
    const before = watchedSlugs().length;

    const other = newWorkspace({ projectPath: "/Users/l/Other", order: 1 });
    useWorkspacesStore.setState({
      workspaces: [first, other],
      activeWorkspaceId: first.id,
    });
    rerender(<Harness />);

    await waitFor(() => {
      expect(watchedSlugs()).toContain(encodeScopeSlug("/Users/l/Other"));
    });
    expect(watchedSlugs().filter((slug) => slug === SCOPE)).toHaveLength(1);
    expect(watchedSlugs().length).toBe(before + 1);
  });

  it("re-reads the scope when a memory appears, and says so", async () => {
    openWorkspace(PROJECT);
    render(<Harness />);
    await waitFor(() =>
      expect(useRocMindStore.getState().memoriesByScope[SCOPE]).toHaveLength(1),
    );

    lists = {
      ...lists,
      [SCOPE]: [
        memory("payments-provider-migration"),
        memory("busyness-latency"),
      ],
    };
    emitChange?.({ scope: SCOPE });

    await waitFor(() => {
      expect(useRocMindStore.getState().memoriesByScope[SCOPE]).toHaveLength(2);
    });
    const toast = useToastsStore.getState().items[0];
    expect(toast?.message).toContain("busyness-latency");
    expect(toast?.message).toContain("Storefront");
  });

  it("says nothing while RocMind is the view you are looking at", async () => {
    // A tree that just grew a row is its own notification.
    useUIStore.setState({ mainView: "rocmind" });
    openWorkspace(PROJECT);
    render(<Harness />);
    await waitFor(() =>
      expect(useRocMindStore.getState().memoriesByScope[SCOPE]).toHaveLength(1),
    );

    lists = { ...lists, [SCOPE]: [memory("a"), memory("b")] };
    emitChange?.({ scope: SCOPE });
    await waitFor(() =>
      expect(useRocMindStore.getState().memoriesByScope[SCOPE]).toHaveLength(2),
    );
    expect(useToastsStore.getState().items).toHaveLength(0);
  });

  it("says nothing about a memory that was only edited", async () => {
    openWorkspace(PROJECT);
    render(<Harness />);
    await waitFor(() =>
      expect(useRocMindStore.getState().memoriesByScope[SCOPE]).toHaveLength(1),
    );

    lists = {
      ...lists,
      [SCOPE]: [{ ...memory("payments-provider-migration"), bytes: 999 }],
    };
    emitChange?.({ scope: SCOPE });
    await waitFor(() => {
      expect(
        useRocMindStore.getState().memoriesByScope[SCOPE]?.[0]?.bytes,
      ).toBe(999);
    });
    expect(useToastsStore.getState().items).toHaveLength(0);
  });

  it("offers to take you to the memory it is reporting", async () => {
    openWorkspace(PROJECT);
    render(<Harness />);
    await waitFor(() =>
      expect(useRocMindStore.getState().memoriesByScope[SCOPE]).toHaveLength(1),
    );

    const fresh = memory("busyness-latency");
    lists = {
      ...lists,
      [SCOPE]: [memory("payments-provider-migration"), fresh],
    };
    emitChange?.({ scope: SCOPE });
    await waitFor(() =>
      expect(useToastsStore.getState().items).toHaveLength(1),
    );

    useToastsStore.getState().items[0]!.action!.run();
    expect(useUIStore.getState().mainView).toBe("rocmind");
    await waitFor(() => {
      expect(useRocMindStore.getState().selected).toBe(fresh.path);
    });
  });

  it("ignores a workspace with no project directory", async () => {
    openWorkspace(null);
    render(<Harness />);
    await waitFor(() => expect(invoke).toHaveBeenCalled());
    expect(watchedSlugs()).toEqual([]);
  });
});
