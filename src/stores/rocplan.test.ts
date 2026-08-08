/** The board's mirror: what it holds, when it writes, and what it does when
 *  somebody else writes first. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

/** The `rocplan://changed` handler the store registers, captured so a test can
 *  play the part of Rust noticing an external edit. */
let emitChange: ((payload: { projectPath: string }) => void) | null = null;
const unlisten = vi.fn();
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(
    async (_event: string, handler: (e: { payload: unknown }) => void) => {
      emitChange = (payload) => handler({ payload });
      return unlisten;
    },
  ),
}));

import { listen } from "@tauri-apps/api/event";
import {
  PLAN_WRITE_DEBOUNCE_MS,
  PLAN_WRITE_RETRIES,
  ensureBoardLoaded,
  flushPlanWrites,
  hasPendingPlanWrite,
  isBoardFollowed,
  resetRocPlanModuleState,
  useRocPlanStore,
} from "@/stores/rocplan";
import type { RocTask } from "@/lib/bindings";

const PROJECT = "/code/rocspace";

const task = (over: Partial<RocTask> = {}): RocTask => ({
  id: "task_1",
  title: "Wire the board",
  description: "",
  status: "todo",
  priority: "medium",
  assignedTerminalName: null,
  findings: [],
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

const store = () => useRocPlanStore.getState();
const tasksOf = (projectPath = PROJECT) =>
  store().tasksByProject[projectPath] ?? [];

/** `plan_read` answers with `tasks`; every other command resolves. */
function mockIpc(tasks: RocTask[] = []) {
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "plan_read") return tasks;
    return null;
  });
}

const calls = (cmd: string) =>
  invoke.mock.calls.filter(([name]) => name === cmd);

beforeEach(() => {
  vi.useFakeTimers();
  invoke.mockReset();
  unlisten.mockReset();
  vi.mocked(listen).mockClear();
  emitChange = null;
  mockIpc();
  resetRocPlanModuleState();
  useRocPlanStore.setState({
    tasksByProject: {},
    loadingByProject: {},
    errorByProject: {},
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("loading a board", () => {
  it("reads the plan and takes a watch on the file", async () => {
    mockIpc([task()]);

    await store().loadBoard(PROJECT);

    expect(tasksOf()).toHaveLength(1);
    expect(calls("plan_read")[0]![1]).toEqual({ projectPath: PROJECT });
    expect(calls("plan_watch")).toHaveLength(1);
    expect(store().loadingByProject[PROJECT]).toBe(false);
    expect(store().errorByProject[PROJECT]).toBeNull();
  });

  it("takes exactly one watch however often the board is re-read", async () => {
    // `loadBoard` doubles as the refresh — a mount, a Refresh button, and every
    // external change all land here. Rust reference-counts, so a second watch
    // taken here is one this side never gives back.
    await store().loadBoard(PROJECT);
    await store().loadBoard(PROJECT);

    expect(calls("plan_read")).toHaveLength(2);
    expect(calls("plan_watch")).toHaveLength(1);
  });

  it("leaves no mirror behind when the read fails", async () => {
    // The distinction the mutations depend on: a board nobody could read is not
    // an empty board, and seeding `[]` here would let the next edit write that
    // empty array over a file full of tasks.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "plan_read") throw new Error("permission denied");
      return null;
    });

    await store().loadBoard(PROJECT);

    expect(store().tasksByProject[PROJECT]).toBeUndefined();
    expect(store().errorByProject[PROJECT]).toEqual({
      kind: "read",
      message: "permission denied",
    });
    expect(store().loadingByProject[PROJECT]).toBe(false);
    expect(calls("plan_watch")).toHaveLength(0);
    warn.mockRestore();
  });

  it("shows loading for the first read only", async () => {
    let deliver = (_: RocTask[]) => {};
    const read = new Promise<RocTask[]>((resolve) => {
      deliver = resolve;
    });
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "plan_read") return read;
      return null;
    });

    const first = store().loadBoard(PROJECT);
    expect(store().loadingByProject[PROJECT]).toBe(true);
    deliver([task()]);
    await first;
    expect(store().loadingByProject[PROJECT]).toBe(false);

    // A re-read has a board to keep showing; blanking it would flicker on
    // exactly the workflow the watcher exists for.
    mockIpc([task(), task({ id: "task_2" })]);
    const again = store().loadBoard(PROJECT);
    expect(store().loadingByProject[PROJECT]).toBe(false);
    await again;
  });

  it("ignores an empty project path", async () => {
    await store().loadBoard("");

    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("unloading a board", () => {
  it("gives the watch back", async () => {
    await store().loadBoard(PROJECT);

    store().unloadBoard(PROJECT);

    expect(calls("plan_unwatch")[0]![1]).toEqual({ projectPath: PROJECT });
  });

  it("unwatches once, and only for a board it watched", async () => {
    store().unloadBoard(PROJECT);
    expect(calls("plan_unwatch")).toHaveLength(0);

    await store().loadBoard(PROJECT);
    store().unloadBoard(PROJECT);
    store().unloadBoard(PROJECT);

    expect(calls("plan_unwatch")).toHaveLength(1);
  });

  it("writes a pending edit through before it goes", async () => {
    // Leaving the board is not a reason to lose the edit whose debounce had not
    // fired yet — switching back to the terminals is one keystroke.
    await store().loadBoard(PROJECT);
    store().createTask(PROJECT, { title: "Ship it" });
    expect(calls("plan_write")).toHaveLength(0);

    store().unloadBoard(PROJECT);

    expect(calls("plan_write")).toHaveLength(1);
  });

  it("keeps the mirror so coming back paints instead of flashing", async () => {
    mockIpc([task()]);
    await store().loadBoard(PROJECT);

    store().unloadBoard(PROJECT);

    expect(tasksOf()).toHaveLength(1);
  });
});

describe("mutations", () => {
  beforeEach(async () => {
    await store().loadBoard(PROJECT);
  });

  it("creates a task in todo and hands back its id", () => {
    const id = store().createTask(PROJECT, {
      title: "Wire the board",
      description: "columns first",
      priority: "high",
    });

    expect(id).not.toBe("");
    const created = tasksOf()[0]!;
    expect(created).toMatchObject({
      id,
      title: "Wire the board",
      description: "columns first",
      status: "todo",
      priority: "high",
      assignedTerminalName: null,
      findings: [],
    });
  });

  it("fills a bare draft in with the board's defaults", () => {
    store().createTask(PROJECT, { title: "Bare" });

    expect(tasksOf()[0]).toMatchObject({
      description: "",
      priority: "medium",
      status: "todo",
      assignedTerminalName: null,
    });
  });

  it("patches only the fields the patch names", () => {
    const id = store().createTask(PROJECT, {
      title: "Before",
      description: "keep me",
    });

    store().updateTask(PROJECT, id, {
      title: "After",
      assignedTerminalName: "Rocky",
    });

    expect(tasksOf()[0]).toMatchObject({
      title: "After",
      description: "keep me",
      assignedTerminalName: "Rocky",
    });
  });

  it("moves a card between columns", () => {
    const id = store().createTask(PROJECT, { title: "Move me" });

    store().moveTask(PROJECT, id, "in_progress");

    expect(tasksOf()[0]!.status).toBe("in_progress");
  });

  it("appends findings in order and never rewrites one", () => {
    const id = store().createTask(PROJECT, { title: "Logged" });

    store().appendFinding(PROJECT, id, "you", "first");
    store().appendFinding(PROJECT, id, "mcp:claude", "second");

    expect(tasksOf()[0]!.findings.map((f) => [f.by, f.text])).toEqual([
      ["you", "first"],
      ["mcp:claude", "second"],
    ]);
  });

  it("deletes a task", () => {
    const id = store().createTask(PROJECT, { title: "Doomed" });
    store().createTask(PROJECT, { title: "Survivor" });

    store().deleteTask(PROJECT, id);

    expect(tasksOf().map((t) => t.title)).toEqual(["Survivor"]);
  });

  it("ignores a task id nothing holds", () => {
    store().updateTask(PROJECT, "nope", { title: "x" });
    store().moveTask(PROJECT, "nope", "complete");
    store().appendFinding(PROJECT, "nope", "you", "x");
    store().deleteTask(PROJECT, "nope");

    vi.advanceTimersByTime(PLAN_WRITE_DEBOUNCE_MS);
    expect(calls("plan_write")).toHaveLength(0);
  });
});

describe("a project with no board loaded", () => {
  it("refuses every mutation rather than writing over a file it never read", () => {
    // `plan_write` replaces the file whole. A create here would replace a plan
    // this app has never seen with the one task it happens to hold.
    const id = store().createTask("/code/never-read", { title: "Ghost" });

    expect(id).toBe("");
    expect(store().tasksByProject["/code/never-read"]).toBeUndefined();
    vi.advanceTimersByTime(PLAN_WRITE_DEBOUNCE_MS);
    expect(calls("plan_write")).toHaveLength(0);
  });

  it("refuses an empty project path — a workspace without a directory", () => {
    expect(store().createTask("", { title: "Nowhere" })).toBe("");
    vi.advanceTimersByTime(PLAN_WRITE_DEBOUNCE_MS);
    expect(calls("plan_write")).toHaveLength(0);
  });
});

describe("a board that was loaded and then put down", () => {
  const warned = () => vi.spyOn(console, "warn").mockImplementation(() => {});

  beforeEach(async () => {
    mockIpc([task()]);
    await store().loadBoard(PROJECT);
    store().unloadBoard(PROJECT);
  });

  it("takes no mutations, however alive its mirror looks", () => {
    // The dangerous half of this rule, and the one that used to be missing:
    // `unloadBoard` KEEPS the mirror on purpose, so coming back to a board
    // paints instead of flashing. What it keeps is a snapshot of a file nobody
    // has been watching since — and `plan_write` replaces the file whole, so a
    // mutation here would put an old copy of the plan over everything the
    // repository has taken meanwhile: an agent's whole session of `rocplan_*`
    // calls, a branch switch, a merge.
    const warn = warned();

    expect(
      store().createTask(PROJECT, { title: "Behind the board's back" }),
    ).toBe("");
    expect(store().moveTask(PROJECT, "task_1", "complete")).toBe(false);
    expect(
      store().appendFinding(PROJECT, "task_1", "3B", "turn finished"),
    ).toBe(false);
    expect(store().deleteTask(PROJECT, "task_1")).toBe(false);

    vi.advanceTimersByTime(PLAN_WRITE_DEBOUNCE_MS);
    expect(calls("plan_write")).toHaveLength(0);
    // The mirror is untouched too — a refused change is not half-applied.
    expect(tasksOf()).toHaveLength(1);
    expect(tasksOf()[0]!.status).toBe("todo");
    // Loudly, because it is the caller's bug: a silent no-op is a card that
    // quietly does not move.
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("takes them again after `ensureBoardLoaded`", async () => {
    // What Phase 3B awaits before dispatching from outside the board's mount.
    await ensureBoardLoaded(PROJECT);

    expect(store().moveTask(PROJECT, "task_1", "in_progress")).toBe(true);
    vi.advanceTimersByTime(PLAN_WRITE_DEBOUNCE_MS);
    expect(calls("plan_write")).toHaveLength(1);
  });

  it("does not re-read a board that is already live", async () => {
    await store().loadBoard(PROJECT);
    const reads = calls("plan_read").length;

    await ensureBoardLoaded(PROJECT);

    expect(calls("plan_read")).toHaveLength(reads);
  });

  it("ignores an external change for a board it has put down", () => {
    // The watch is already handed back; this is the event that crossed it.
    emitChange!({ projectPath: PROJECT });

    expect(calls("plan_read")).toHaveLength(1);
  });
});

describe("write-through", () => {
  beforeEach(async () => {
    await store().loadBoard(PROJECT);
  });

  it("updates the mirror synchronously and writes on the trailing edge", () => {
    store().createTask(PROJECT, { title: "Now" });

    // The mirror is already right — the board never waits for the disk.
    expect(tasksOf()).toHaveLength(1);
    expect(calls("plan_write")).toHaveLength(0);

    vi.advanceTimersByTime(PLAN_WRITE_DEBOUNCE_MS);

    const [, args] = calls("plan_write")[0]!;
    expect(args).toMatchObject({ projectPath: PROJECT });
    expect((args as { tasks: RocTask[] }).tasks).toHaveLength(1);
  });

  it("coalesces a burst into one write of the final state", () => {
    // A card dragged through three columns is one edit as far as the disk is
    // concerned.
    const id = store().createTask(PROJECT, { title: "Dragged" });
    vi.advanceTimersByTime(PLAN_WRITE_DEBOUNCE_MS - 50);
    store().moveTask(PROJECT, id, "in_progress");
    vi.advanceTimersByTime(PLAN_WRITE_DEBOUNCE_MS - 50);
    store().moveTask(PROJECT, id, "in_review");
    vi.advanceTimersByTime(PLAN_WRITE_DEBOUNCE_MS);

    expect(calls("plan_write")).toHaveLength(1);
    const { tasks } = calls("plan_write")[0]![1] as { tasks: RocTask[] };
    expect(tasks[0]!.status).toBe("in_review");
  });

  it("does not write for a move that changes nothing", () => {
    // Arrow keys at the end of a row repeat the last column; each repeat must
    // not cost a file write.
    const id = store().createTask(PROJECT, { title: "Still" });
    vi.advanceTimersByTime(PLAN_WRITE_DEBOUNCE_MS);
    expect(calls("plan_write")).toHaveLength(1);

    store().moveTask(PROJECT, id, "todo");
    vi.advanceTimersByTime(PLAN_WRITE_DEBOUNCE_MS);

    expect(calls("plan_write")).toHaveLength(1);
  });

  it("keeps two projects on their own timers", async () => {
    const other = "/code/other";
    await store().loadBoard(other);

    store().createTask(PROJECT, { title: "Mine" });
    store().createTask(other, { title: "Theirs" });
    vi.advanceTimersByTime(PLAN_WRITE_DEBOUNCE_MS);

    expect(
      calls("plan_write").map(
        ([, args]) => (args as { projectPath: string }).projectPath,
      ),
    ).toEqual([PROJECT, other]);
  });

  it("surfaces a write failure on the board it failed for", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "plan_read") return [];
      if (cmd === "plan_write") throw new Error("read-only file system");
      return null;
    });

    store().createTask(PROJECT, { title: "Doomed" });
    vi.advanceTimersByTime(PLAN_WRITE_DEBOUNCE_MS);
    // A write failure, not a read one: the board is showing edits that are not
    // on disk, and the two are different news.
    await vi.waitFor(() =>
      expect(store().errorByProject[PROJECT]).toEqual({
        kind: "write",
        message: "read-only file system",
      }),
    );

    warn.mockRestore();
  });
});

describe("a write that fails", () => {
  /** `plan_read` answers `[]`; `plan_write` throws until `failing` is cleared. */
  function failWrites() {
    const state = { failing: true };
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "plan_read") return [];
      if (cmd === "plan_write" && state.failing) {
        throw new Error("resource busy");
      }
      return null;
    });
    return state;
  }

  beforeEach(async () => {
    await store().loadBoard(PROJECT);
  });

  it("tries again on its own, and clears the banner when one lands", async () => {
    // Nothing retried a failed write. The banner stayed up until the user found
    // a button, and the edit behind it lived in memory until they quit — for a
    // failure (a checkout replacing the directory, a lock held for a moment)
    // that was over a second later.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const disk = failWrites();

    store().createTask(PROJECT, { title: "Unlucky" });
    vi.advanceTimersByTime(PLAN_WRITE_DEBOUNCE_MS);
    await vi.waitFor(() =>
      expect(store().errorByProject[PROJECT]?.kind).toBe("write"),
    );
    expect(calls("plan_write")).toHaveLength(1);

    disk.failing = false;
    await vi.advanceTimersByTimeAsync(PLAN_WRITE_DEBOUNCE_MS * 2);

    expect(calls("plan_write")).toHaveLength(2);
    expect(store().errorByProject[PROJECT]).toBeNull();
    expect(hasPendingPlanWrite(PROJECT)).toBe(false);
    warn.mockRestore();
  });

  it("gives up after a bounded number of tries, still holding the edit", async () => {
    // A read-only volume does not become writable by being written to once a
    // second all afternoon. Giving up is not the same as losing it: the edit
    // is still unwritten, the banner is still up, and a flush still takes it.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const disk = failWrites();

    store().createTask(PROJECT, { title: "Doomed" });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(calls("plan_write")).toHaveLength(1 + PLAN_WRITE_RETRIES);
    expect(store().errorByProject[PROJECT]?.kind).toBe("write");
    expect(hasPendingPlanWrite(PROJECT)).toBe(true);
    expect(tasksOf()).toHaveLength(1);

    disk.failing = false;
    await flushPlanWrites(PROJECT);

    expect(calls("plan_write")).toHaveLength(2 + PLAN_WRITE_RETRIES);
    expect(store().errorByProject[PROJECT]).toBeNull();
    warn.mockRestore();
  });

  // The board rendered-but-unwritable, and the one line that made it so.
  //
  // `loadBoard` returns early — BEFORE `following.add` — when it finds a
  // pending write it cannot flush, and sets `rereadWhenQuiet` on the way out
  // precisely so `settle` finishes the job once the write lands. `settle` then
  // asked `following.has(projectPath)`, which is the flag that early return had
  // never set: the owed read was dropped and the entry deleted. From there the
  // board painted from its kept mirror, highlighted drop targets and offered
  // New task, while every drag, arrow and save was refused to a console. Only
  // leaving and re-entering recovered it.
  it("finishes the load it owed, so the board it painted can be written to", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const disk = failWrites();

    // An edit that cannot reach the disk, retries exhausted.
    store().createTask(PROJECT, { title: "Unwritten" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(hasPendingPlanWrite(PROJECT)).toBe(true);

    // The user leaves the board and comes back. `unloadBoard` stops following
    // it; the mirror is kept on purpose, so the board still paints.
    store().unloadBoard(PROJECT);
    await store().loadBoard(PROJECT);
    expect(store().tasksByProject[PROJECT]).toHaveLength(1);
    expect(isBoardFollowed(PROJECT)).toBe(false);

    // The cause clears and the banner's Try again lands.
    disk.failing = false;
    await flushPlanWrites(PROJECT);

    // …and the read that was owed is taken, which is what makes the board on
    // screen writable again. Without it the user is left looking at a board
    // that highlights drop targets and refuses every one of them.
    await vi.waitFor(() => expect(isBoardFollowed(PROJECT)).toBe(true));
    expect(store().createTask(PROJECT, { title: "Now it lands" })).not.toBe("");
    warn.mockRestore();
  });

  it("is flushed on the way out, so leaving the board does not lose it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const disk = failWrites();

    store().createTask(PROJECT, { title: "On the way out" });
    vi.advanceTimersByTime(PLAN_WRITE_DEBOUNCE_MS);
    await vi.waitFor(() => expect(calls("plan_write")).toHaveLength(1));

    disk.failing = false;
    store().unloadBoard(PROJECT);

    await vi.waitFor(() => expect(calls("plan_write")).toHaveLength(2));
    warn.mockRestore();
  });
});

describe("somebody else writing the file", () => {
  beforeEach(async () => {
    mockIpc([task()]);
    await store().loadBoard(PROJECT);
  });

  it("re-reads the board when rocplan://changed names it", async () => {
    mockIpc([task(), task({ id: "task_2", title: "Added by an agent" })]);

    emitChange!({ projectPath: PROJECT });
    await vi.waitFor(() => expect(tasksOf()).toHaveLength(2));

    expect(tasksOf()[1]!.title).toBe("Added by an agent");
  });

  it("ignores a project this store is not mirroring", () => {
    emitChange!({ projectPath: "/code/somebody-elses" });

    expect(calls("plan_read")).toHaveLength(1);
  });

  it("stands down while one of our own writes is still pending", () => {
    // Our write is about to land. Re-reading now would paint the file as it was
    // and then be overwritten by the very edit being read away — the user would
    // watch their card jump back and then forward again.
    store().createTask(PROJECT, { title: "Mine, unwritten" });

    emitChange!({ projectPath: PROJECT });

    expect(calls("plan_read")).toHaveLength(1);
  });

  it("reads it once the pending write has gone, instead of dropping it", async () => {
    // Standing down was only half an answer. The event was DROPPED — an agent's
    // `rocplan_update_task_status` landing during the user's drag was a change
    // the board never learned about at all, and no second event was coming:
    // Rust suppresses the echo of our own writes, and the file was not going to
    // move again on its own.
    mockIpc([task({ id: "external", title: "Moved by an agent" })]);
    store().createTask(PROJECT, { title: "Mine, mid-drag" });

    emitChange!({ projectPath: PROJECT });
    expect(calls("plan_read")).toHaveLength(1);

    vi.advanceTimersByTime(PLAN_WRITE_DEBOUNCE_MS);

    await vi.waitFor(() => expect(calls("plan_read")).toHaveLength(2));
    expect(tasksOf()[0]!.title).toBe("Moved by an agent");
  });

  it("does not lose a change that arrives inside the IPC round trip", async () => {
    // The blind spot the old debounce had: its entry was deleted BEFORE
    // `plan_write` was awaited, so an event arriving here found nothing pending
    // and re-read the file as it stood before our write — and then our write
    // landed on top of what had just been read. Mirror and disk disagreed from
    // then on, permanently, with no event left to reconcile them.
    let land = () => {};
    const inTheAir = new Promise<null>((resolve) => {
      land = () => resolve(null);
    });
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "plan_read")
        return [task({ id: "external", title: "Moved by an agent" })];
      if (cmd === "plan_write") return inTheAir;
      return null;
    });

    store().createTask(PROJECT, { title: "Mine, being written" });
    vi.advanceTimersByTime(PLAN_WRITE_DEBOUNCE_MS);
    expect(calls("plan_write")).toHaveLength(1);

    // The agent writes while our IPC is out.
    emitChange!({ projectPath: PROJECT });
    expect(calls("plan_read")).toHaveLength(1);
    expect(tasksOf().map((t) => t.title)).toEqual([
      "Wire the board",
      "Mine, being written",
    ]);

    land();

    // Once the write has settled, the change nobody read is read.
    await vi.waitFor(() => expect(calls("plan_read")).toHaveLength(2));
    expect(tasksOf().map((t) => t.title)).toEqual(["Moved by an agent"]);
  });

  it("writes what it is holding before a refresh reads over it", async () => {
    // `loadBoard` is the Refresh button and the write-failure banner's Try
    // again, and it REPLACES the mirror. Re-reading with work outstanding is
    // the undo button for the edit the user just made — and, inside the
    // debounce, the store would then have written that revert to disk.
    store().createTask(PROJECT, { title: "Unwritten" });
    expect(calls("plan_write")).toHaveLength(0);

    await store().loadBoard(PROJECT);

    expect(
      invoke.mock.calls
        .map(([name]) => name)
        .filter((name) => name === "plan_read" || name === "plan_write"),
    ).toEqual(["plan_read", "plan_write", "plan_read"]);
  });

  it("does not read at all when that write could not be made", async () => {
    // The mirror is the newer of the two copies and the file cannot be told so.
    // Taking the file now would be the recovery button destroying exactly the
    // work it was pressed to save.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "plan_read") return [task()];
      if (cmd === "plan_write") throw new Error("read-only file system");
      return null;
    });
    store().createTask(PROJECT, { title: "Unwritten" });

    await store().loadBoard(PROJECT);

    expect(calls("plan_read")).toHaveLength(1);
    expect(tasksOf().map((t) => t.title)).toEqual([
      "Wire the board",
      "Unwritten",
    ]);
    warn.mockRestore();
  });

  it("registers exactly one subscription across many boards", async () => {
    // One event stream for every watched project, taken once and kept — two
    // boards opening in the same tick must not each register a handler, or an
    // agent's edit arrives twice and the board re-reads twice.
    await store().loadBoard("/code/other");

    expect(vi.mocked(listen)).toHaveBeenCalledTimes(1);
  });
});
