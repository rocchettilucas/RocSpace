/** The Git panel's mirror: what it holds, which failures speak and which draw
 *  in place, and what happens when two answers race. */

import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import type { GitStatus } from "@/lib/bindings";
import {
  hasStagedChanges,
  listFor,
  resetGitState,
  useGitStore,
} from "@/stores/git";
import { resetToastsState, useToastsStore } from "@/stores/toasts";

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

/** Answer each command by name; anything unmocked rejects loudly rather than
 *  resolving to undefined and failing three assertions later. */
function route(handlers: Record<string, (args: never) => unknown>): void {
  invoke.mockImplementation((name: string, args: never) => {
    const handler = handlers[name];
    if (!handler)
      return Promise.reject(new Error(`unexpected command ${name}`));
    return Promise.resolve(handler(args));
  });
}

const messages = (): string[] =>
  useToastsStore.getState().items.map((t) => t.message);

beforeEach(() => {
  invoke.mockReset();
  resetGitState();
  resetToastsState();
});

describe("setRepo", () => {
  it("drops everything the previous repository had", async () => {
    route({ git_status: () => status({ branch: "topic" }) });
    useGitStore.getState().setRepo(REPO);
    await useGitStore.getState().refresh();
    useGitStore.getState().setMessage("half a sentence");
    expect(useGitStore.getState().status?.branch).toBe("topic");

    useGitStore.getState().setRepo("/code/other");
    const state = useGitStore.getState();
    expect(state.status).toBeNull();
    // The message belonged to the repository it was being written for.
    expect(state.message).toBe("");
    expect(state.selection).toBeNull();
  });

  it("is a no-op for the same path, so a re-render cannot clear the box", () => {
    useGitStore.getState().setRepo(REPO);
    useGitStore.getState().setMessage("keep me");
    useGitStore.getState().setRepo(REPO);
    expect(useGitStore.getState().message).toBe("keep me");
  });
});

describe("refresh", () => {
  it("draws its failure in place rather than raising a toast", async () => {
    // The commonest cause is a workspace that is not a repository, and the
    // panel asks on its own every time it mounts. A toast per ask would be a
    // stream of notifications about something the user already knows.
    route({ git_status: () => Promise.reject("not a git repository") });
    useGitStore.getState().setRepo(REPO);
    await useGitStore.getState().refresh();

    expect(useGitStore.getState().error).toBe("not a git repository");
    expect(useGitStore.getState().status).toBeNull();
    expect(messages()).toEqual([]);
  });

  it("drops a selection whose file no longer appears in any list", async () => {
    route({
      git_status: () =>
        status({ unstaged: [{ path: "a.ts", status: "modified" }] }),
      git_diff: () => "@@ -1 +1 @@\n-a\n+b\n",
    });
    useGitStore.getState().setRepo(REPO);
    await useGitStore.getState().refresh();
    await useGitStore.getState().select("a.ts", false);
    expect(useGitStore.getState().diff).toContain("+b");

    // Somebody else reverted it.
    route({ git_status: () => status() });
    await useGitStore.getState().refresh();
    expect(useGitStore.getState().selection).toBeNull();
    expect(useGitStore.getState().diff).toBeNull();
  });
});

describe("select", () => {
  it("ignores a diff that lands after the user has clicked past it", async () => {
    // A holder rather than a `let`: assigning inside the executor is invisible
    // to TypeScript's control flow, which then narrows the binding to `never`.
    const first: { release?: (value: string) => void } = {};
    route({
      git_diff: (args: { path: string }) =>
        args.path === "slow.ts"
          ? new Promise<string>((resolve) => {
              first.release = resolve;
            })
          : "@@ fast @@",
    });
    useGitStore.getState().setRepo(REPO);

    const slow = useGitStore.getState().select("slow.ts", false);
    const fast = useGitStore.getState().select("fast.ts", false);
    await fast;
    first.release?.("@@ slow @@");
    await slow;

    // The slowest response must not win. The pane shows what was clicked last.
    expect(useGitStore.getState().selection?.path).toBe("fast.ts");
    expect(useGitStore.getState().diff).toBe("@@ fast @@");
  });
});

describe("stage / unstage", () => {
  it("passes the paths through and re-reads the status", async () => {
    const staged: string[][] = [];
    route({
      git_stage: (args: { paths: string[] }) => {
        staged.push(args.paths);
      },
      git_status: () =>
        status({ staged: [{ path: "a.ts", status: "modified" }] }),
    });
    useGitStore.getState().setRepo(REPO);
    await useGitStore.getState().stage(["a.ts", "b.ts"]);

    expect(staged).toEqual([["a.ts", "b.ts"]]);
    expect(useGitStore.getState().status?.staged).toHaveLength(1);
  });

  it("follows the selected file across the index instead of losing it", async () => {
    route({
      git_status: () =>
        status({ staged: [{ path: "a.ts", status: "modified" }] }),
      git_diff: () => "@@ staged @@",
      git_stage: () => undefined,
    });
    useGitStore.getState().setRepo(REPO);
    useGitStore.setState({ selection: { path: "a.ts", staged: false } });

    await useGitStore.getState().stage(["a.ts"]);
    expect(useGitStore.getState().selection).toEqual({
      path: "a.ts",
      staged: true,
    });
    expect(useGitStore.getState().diff).toBe("@@ staged @@");
  });

  it("says what git said when staging fails", async () => {
    route({
      git_stage: () =>
        Promise.reject("fatal: pathspec 'gone.ts' did not match any files"),
    });
    useGitStore.getState().setRepo(REPO);
    await useGitStore.getState().stage(["gone.ts"]);
    expect(messages()).toEqual([
      "fatal: pathspec 'gone.ts' did not match any files",
    ]);
  });

  it("does not spawn git for an empty list", async () => {
    route({});
    useGitStore.getState().setRepo(REPO);
    await useGitStore.getState().stage([]);
    await useGitStore.getState().unstage([]);
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("commit", () => {
  it("clears the box, names the sha, and re-reads the status", async () => {
    route({ git_commit: () => "a1b2c3d", git_status: () => status() });
    useGitStore.getState().setRepo(REPO);
    useGitStore.getState().setMessage("feat: a thing");

    const sha = await useGitStore.getState().commit();
    expect(sha).toBe("a1b2c3d");
    expect(useGitStore.getState().message).toBe("");
    expect(messages()).toEqual(["Committed a1b2c3d"]);
  });

  it("keeps the message when a hook rejects the commit", async () => {
    route({ git_commit: () => Promise.reject("pre-commit hook failed") });
    useGitStore.getState().setRepo(REPO);
    useGitStore.getState().setMessage("feat: a thing");

    expect(await useGitStore.getState().commit()).toBeNull();
    // A rejected commit is one the user will retry; throwing away what they
    // wrote would make the panel worse than the command line.
    expect(useGitStore.getState().message).toBe("feat: a thing");
    expect(messages()).toEqual(["pre-commit hook failed"]);
  });

  it("refuses a blank message without spawning git", async () => {
    route({});
    useGitStore.getState().setRepo(REPO);
    useGitStore.getState().setMessage("   \n  ");
    expect(await useGitStore.getState().commit()).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("checkout", () => {
  it("reloads the status and the branch list after a switch", async () => {
    const calls: string[] = [];
    route({
      git_checkout: (args: { branch: string; create: boolean }) => {
        calls.push(`${args.branch}:${args.create}`);
      },
      git_status: () => status({ branch: "topic" }),
      git_branches: () => [{ name: "topic", isCurrent: true, isRemote: false }],
    });
    useGitStore.getState().setRepo(REPO);

    expect(await useGitStore.getState().checkout("topic", true)).toBe(true);
    expect(calls).toEqual(["topic:true"]);
    expect(useGitStore.getState().status?.branch).toBe("topic");
    expect(useGitStore.getState().branches).toHaveLength(1);
    expect(messages()).toEqual(["Now on topic"]);
  });

  it("reports git's refusal and changes nothing", async () => {
    route({
      git_checkout: () =>
        Promise.reject("error: Your local changes would be overwritten"),
    });
    useGitStore.getState().setRepo(REPO);
    expect(await useGitStore.getState().checkout("topic", false)).toBe(false);
    expect(messages()).toEqual([
      "error: Your local changes would be overwritten",
    ]);
  });
});

describe("derived helpers", () => {
  it("reads untracked files as the unstaged side", () => {
    const s = status({
      staged: [{ path: "s.ts", status: "modified" }],
      unstaged: [{ path: "u.ts", status: "modified" }],
      untracked: [{ path: "n.ts", status: "untracked" }],
    });
    expect(listFor(s, true).map((e) => e.path)).toEqual(["s.ts"]);
    expect(listFor(s, false).map((e) => e.path)).toEqual(["u.ts", "n.ts"]);
  });

  it("knows whether there is anything to commit", () => {
    expect(hasStagedChanges(null)).toBe(false);
    expect(hasStagedChanges(status())).toBe(false);
    expect(
      hasStagedChanges(status({ staged: [{ path: "a", status: "added" }] })),
    ).toBe(true);
  });
});
