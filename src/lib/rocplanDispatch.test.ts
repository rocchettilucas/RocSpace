/** Dispatch: what happens between a card reaching In Progress and an agent
 *  reading a prompt, and what happens when that agent finishes. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import { newOutputLine, newTerminal, newWorkspace } from "@/lib/factories";
import {
  DISPATCH_APPROVAL_WAIT_MS,
  DISPATCH_QUIET_MAX_WAIT_MS,
  buildDispatchPrompt,
  dispatchOnMove,
  dispatchedCardFor,
  jumpToAgent,
  mountRocPlanDispatch,
  resetRocPlanDispatchState,
} from "@/lib/rocplanDispatch";
import { useNotificationsStore } from "@/stores/notifications";
import {
  flushPlanWrites,
  resetRocPlanModuleState,
  useRocPlanStore,
} from "@/stores/rocplan";
import { OUTPUT_RING_BUFFER_CAP, useTerminalsStore } from "@/stores/terminals";
import { resetToastsState, useToastsStore } from "@/stores/toasts";
import { useUIStore } from "@/stores/ui";
import { useWorkspacesStore } from "@/stores/workspaces";
import type {
  AgentType,
  RocTask,
  TerminalSession,
  TerminalStatus,
} from "@/lib/bindings";

const PROJECT = "/code/rocspace";

let workspaceId = "";

const task = (over: Partial<RocTask> = {}): RocTask => ({
  id: "task_1",
  title: "Wire the board",
  description: "Make the drag do something.",
  status: "todo",
  priority: "medium",
  assignedTerminalName: null,
  findings: [],
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

function addPane(
  name: string,
  over: { agentType?: AgentType; status?: TerminalStatus } = {},
): TerminalSession {
  const terminal = newTerminal({
    workspaceId,
    name,
    agentType: over.agentType ?? "claude-code",
    projectPath: PROJECT,
  });
  terminal.status = over.status ?? "idle";
  useTerminalsStore.getState().addTerminal(terminal);
  return terminal;
}

/** The plan file, such as it is: `plan_write` puts tasks here and `plan_read`
 *  hands them back. A read that could not see what was written would make
 *  "re-load the board and look again" — which is what auto-advance does from
 *  outside the board — untestable, and it is the interesting half. */
let disk: RocTask[] = [];

/** Seed the mirror through a real read, so the board is FOLLOWED — the store
 *  refuses mutations to a project nobody has loaded. */
async function loadBoard(tasks: RocTask[]): Promise<void> {
  disk = tasks;
  await useRocPlanStore.getState().loadBoard(PROJECT);
}

const mirror = () => useRocPlanStore.getState().tasksByProject[PROJECT] ?? [];
const cardOf = (id = "task_1") => mirror().find((t) => t.id === id)!;
const writes = () =>
  invoke.mock.calls.filter(([cmd]) => cmd === "terminal_write") as [
    string,
    { terminalId: string; data: string },
  ][];
const ipcCalls = (name: string) =>
  invoke.mock.calls.filter(([cmd]) => cmd === name).length;
const planWrites = () => ipcCalls("plan_write");
const toasts = () => useToastsStore.getState().items;
const toastText = () => toasts().map((t) => t.message);

/** Let the queued microtasks (and any zero-delay timer) run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Fill a pane's ring buffer to its cap, as a pane that has been running for a
 *  few minutes is. One batch rather than a loop of appends: the point is the
 *  state, not the writes it took. */
function fillRing(terminalId: string): void {
  useTerminalsStore.getState().appendOutputBatch([
    {
      terminalId,
      lines: Array.from({ length: OUTPUT_RING_BUFFER_CAP }, (_, i) =>
        newOutputLine(`scrollback ${i}`),
      ),
    },
  ]);
}

beforeEach(() => {
  invoke.mockReset();
  disk = [];
  invoke.mockImplementation(async (cmd: string, args: unknown) => {
    if (cmd === "plan_read") return disk;
    if (cmd === "plan_write") {
      disk = (args as { tasks: RocTask[] }).tasks;
      return null;
    }
    return null;
  });
  resetRocPlanModuleState();
  resetRocPlanDispatchState();
  resetToastsState();
  useRocPlanStore.setState({
    tasksByProject: {},
    loadingByProject: {},
    errorByProject: {},
  });
  useTerminalsStore.setState({ byId: {} });
  useNotificationsStore.setState({ items: [] });
  useUIStore.setState({
    focusedTerminalId: null,
    highlightedTerminalId: null,
    mainView: "rocplan",
  });
  const workspace = newWorkspace({
    name: "rocspace",
    projectPath: PROJECT,
    order: 0,
  });
  workspaceId = workspace.id;
  useWorkspacesStore.setState({
    workspaces: [workspace],
    activeWorkspaceId: workspace.id,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the prompt", () => {
  it("is the contract's three lines, naming the card by id", () => {
    expect(buildDispatchPrompt(task())).toBe(
      '✻ Picked up from RocPlan: "Wire the board"\n' +
        "Make the drag do something.\n" +
        "When done, summarize what changed. This task is tracked in RocPlan" +
        " (.rocspace/plan.json) as task_1 — move it with" +
        " rocplan_update_task_status when you finish.",
    );
  });

  it("leaves no blank line where a card has no description", () => {
    expect(buildDispatchPrompt(task({ description: "  " }))).toBe(
      '✻ Picked up from RocPlan: "Wire the board"\n' +
        "When done, summarize what changed. This task is tracked in RocPlan" +
        " (.rocspace/plan.json) as task_1 — move it with" +
        " rocplan_update_task_status when you finish.",
    );
  });

  it("carries no control byte out of a card's own text", () => {
    // plan.json is a file in the user's repository, which arrives with a
    // branch, a clone or a merge. Its text is UNTRUSTED.
    const prompt = buildDispatchPrompt(
      task({
        title: "Wire\x1b[201~\rrm -rf ~\r",
        description: "one\rtwo\x1b]0;pwned\x07\nthree",
        id: "task\x1b[201~\r1",
      }),
    );

    expect(prompt).not.toContain("\x1b");
    expect(prompt).not.toContain("\r");
    expect(prompt).not.toContain("[201~");
    expect(prompt).not.toContain("[200~");
    // A description's own line breaks survive — they are the only control
    // character a pasted block is allowed to keep.
    expect(prompt).toContain("one\ntwo");
    expect(prompt).toContain("\nthree");
  });
});

describe("moving a card to In Progress", () => {
  it("moves it and writes the prompt into the assigned pane", async () => {
    const rocky = addPane("Rocky");
    await loadBoard([task({ assignedTerminalName: "Rocky" })]);

    await dispatchOnMove(PROJECT, "task_1", "in_progress");

    expect(cardOf().status).toBe("in_progress");
    expect(writes()).toHaveLength(1);
    const [, args] = writes()[0]!;
    expect(args.terminalId).toBe(rocky.id);
    expect(args.data).toContain('✻ Picked up from RocPlan: "Wire the board"');
    expect(args.data).toContain("rocplan_update_task_status");
    // Submitted, not just typed — a prompt sitting unsent in the composer is a
    // dispatch that never happened.
    expect(args.data.endsWith("\r")).toBe(true);
  });

  it("sends a poisoned card as text, not as keystrokes", async () => {
    // The one that matters: a card whose title closes the bracketed paste and
    // presses Enter would deliver whatever follows it to the agent's shell as
    // typing. Nothing between the frame markers may be a control byte.
    const rocky = addPane("Rocky");
    await loadBoard([
      task({
        title: "Wire\x1b[201~\rrm -rf ~\r",
        description: "and\rthen\x1b[201~\recho pwned\r",
        assignedTerminalName: "Rocky",
      }),
    ]);

    await dispatchOnMove(PROJECT, "task_1", "in_progress");

    const [, args] = writes()[0]!;
    expect(args.terminalId).toBe(rocky.id);
    // Exactly the frame's own two escapes and its one submitting carriage
    // return — every other one came from the card and must be gone.
    expect(args.data.split("\x1b")).toHaveLength(3);
    expect(args.data.split("\r")).toHaveLength(2);
    expect(args.data.startsWith("\x1b[200~")).toBe(true);
    expect(args.data.endsWith("\x1b[201~\r")).toBe(true);
  });

  it("records the dispatch on the card and toasts it", async () => {
    addPane("Rocky");
    await loadBoard([task({ assignedTerminalName: "Rocky" })]);

    await dispatchOnMove(PROJECT, "task_1", "in_progress");

    expect(cardOf().findings.at(-1)).toMatchObject({
      by: "rocspace",
      text: "Dispatched to Rocky",
    });
    expect(toastText().at(-1)).toBe("Rocky picked up “Wire the board”");
  });

  it("offers Watch it work from the board, and jumps to the pane", async () => {
    const rocky = addPane("Rocky");
    await loadBoard([task({ assignedTerminalName: "Rocky" })]);

    await dispatchOnMove(PROJECT, "task_1", "in_progress");

    const action = toasts().at(-1)!.action;
    expect(action?.label).toBe("Watch it work");
    action!.run();
    expect(useUIStore.getState().mainView).toBe("terminals");
    expect(useUIStore.getState().focusedTerminalId).toBe(rocky.id);
  });

  it("resolves Watch it work in the workspace the user is in when they click", async () => {
    // A toast lives six seconds and the agent works for minutes; by the time
    // it is clicked the user may be in another workspace entirely. Focusing
    // the id the toast captured points the dock at a pane that is not in it.
    addPane("Rocky");
    await loadBoard([task({ assignedTerminalName: "Rocky" })]);
    await dispatchOnMove(PROJECT, "task_1", "in_progress");
    const action = toasts().at(-1)!.action!;

    const elsewhere = newWorkspace({
      name: "elsewhere",
      projectPath: "/elsewhere",
      order: 1,
    });
    useWorkspacesStore.setState((s) => ({
      workspaces: [...s.workspaces, elsewhere],
      activeWorkspaceId: elsewhere.id,
    }));

    action.run();

    // No jump, and a reason rather than a dock pointed at nothing.
    expect(useUIStore.getState().mainView).toBe("rocplan");
    expect(useUIStore.getState().focusedTerminalId).toBeNull();
    expect(toastText().at(-1)).toContain("Rocky");
  });

  it("does not offer it when the panes are already on screen", async () => {
    useUIStore.setState({ mainView: "terminals" });
    addPane("Rocky");
    await loadBoard([task({ assignedTerminalName: "Rocky" })]);

    await dispatchOnMove(PROJECT, "task_1", "in_progress");

    expect(toasts().at(-1)!.action).toBeNull();
  });

  it("dispatches nothing for any other column", async () => {
    addPane("Rocky");
    await loadBoard([task({ assignedTerminalName: "Rocky" })]);

    await dispatchOnMove(PROJECT, "task_1", "in_review");

    expect(cardOf().status).toBe("in_review");
    expect(writes()).toHaveLength(0);
  });

  it("dispatches nothing when the card was already there", async () => {
    addPane("Rocky");
    await loadBoard([
      task({ status: "in_progress", assignedTerminalName: "Rocky" }),
    ]);

    await dispatchOnMove(PROJECT, "task_1", "in_progress");

    expect(writes()).toHaveLength(0);
  });
});

describe("choosing the pane", () => {
  it("auto-assigns the focused pane when the card names nobody", async () => {
    addPane("Alpha");
    const beta = addPane("Beta");
    useUIStore.setState({ focusedTerminalId: beta.id });
    await loadBoard([task()]);

    await dispatchOnMove(PROJECT, "task_1", "in_progress");

    expect(cardOf().assignedTerminalName).toBe("Beta");
    expect(writes()[0]![1].terminalId).toBe(beta.id);
  });

  it("falls back to the first pane when nothing is focused", async () => {
    const alpha = addPane("Alpha");
    addPane("Beta");
    await loadBoard([task()]);

    await dispatchOnMove(PROJECT, "task_1", "in_progress");

    expect(cardOf().assignedTerminalName).toBe("Alpha");
    expect(writes()[0]![1].terminalId).toBe(alpha.id);
  });

  it("ignores a focused pane that belongs to another workspace", async () => {
    const alpha = addPane("Alpha");
    const stranger = newTerminal({
      workspaceId: "other_workspace",
      name: "Stranger",
      agentType: "claude-code",
      projectPath: "/elsewhere",
    });
    useTerminalsStore.getState().addTerminal(stranger);
    useUIStore.setState({ focusedTerminalId: stranger.id });
    await loadBoard([task()]);

    await dispatchOnMove(PROJECT, "task_1", "in_progress");

    expect(writes()[0]![1].terminalId).toBe(alpha.id);
  });

  it("says so and re-aims when the assigned pane is gone", async () => {
    const alpha = addPane("Alpha");
    useUIStore.setState({ focusedTerminalId: alpha.id });
    await loadBoard([task({ assignedTerminalName: "Ghost" })]);

    await dispatchOnMove(PROJECT, "task_1", "in_progress");

    expect(toastText().some((m) => m.includes("Ghost"))).toBe(true);
    expect(cardOf().assignedTerminalName).toBe("Alpha");
    expect(writes()[0]![1].terminalId).toBe(alpha.id);
  });

  it("refuses a pane whose agent has exited, and says so", async () => {
    // Rust keeps an exited session in its map, so the write SUCCEEDS — into a
    // dead file descriptor. The toast said the card had been picked up, the
    // card kept the finding, and the pane it named was never going to answer.
    const rocky = addPane("Rocky", { status: "complete" });
    await loadBoard([task({ assignedTerminalName: "Rocky" })]);

    await dispatchOnMove(PROJECT, "task_1", "in_progress");

    expect(writes()).toHaveLength(0);
    expect(toastText().at(-1)).toBe(
      "Rocky's agent has exited — restart it first",
    );
    expect(cardOf().findings).toHaveLength(0);
    expect(dispatchedCardFor(rocky.id)).toBeNull();
  });

  it("passes over an exited pane when the card names nobody", async () => {
    const dead = addPane("Alpha", { status: "error" });
    const live = addPane("Beta");
    await loadBoard([task()]);

    await dispatchOnMove(PROJECT, "task_1", "in_progress");

    expect(writes()[0]![1].terminalId).toBe(live.id);
    expect(writes().some(([, a]) => a.terminalId === dead.id)).toBe(false);
    expect(cardOf().assignedTerminalName).toBe("Beta");
  });

  it("moves the card and says why nothing picked it up with no panes", async () => {
    await loadBoard([task()]);

    await dispatchOnMove(PROJECT, "task_1", "in_progress");

    // The move is the user's; the dispatch is the app's best effort.
    expect(cardOf().status).toBe("in_progress");
    expect(writes()).toHaveLength(0);
    expect(toastText().at(-1)).toContain("No agent pane");
  });
});

describe("waiting for the pane to be ready", () => {
  it("holds a claude pane's prompt until it stops awaiting approval", async () => {
    const rocky = addPane("Rocky", { status: "awaiting_approval" });
    await loadBoard([task({ assignedTerminalName: "Rocky" })]);

    const pending = dispatchOnMove(PROJECT, "task_1", "in_progress");
    await settle();
    // Writing now would answer the permission prompt with the task prompt.
    expect(writes()).toHaveLength(0);

    useTerminalsStore.getState().setStatus(rocky.id, "idle");
    await pending;

    expect(writes()).toHaveLength(1);
  });

  it("gives up when a pane stays blocked, and says so", async () => {
    vi.useFakeTimers();
    addPane("Rocky", { status: "awaiting_approval" });
    await loadBoard([task({ assignedTerminalName: "Rocky" })]);

    const pending = dispatchOnMove(PROJECT, "task_1", "in_progress");
    // Just past the give-up, and no further: a toast has a lifetime of its own.
    await vi.advanceTimersByTimeAsync(DISPATCH_APPROVAL_WAIT_MS + 10);
    await pending;

    expect(writes()).toHaveLength(0);
    expect(toastText().at(-1)).toContain("Rocky");
  });

  it("waits a second of quiet on a pane with no hooks", async () => {
    vi.useFakeTimers();
    const shell = addPane("Shell", { agentType: "shell", status: "running" });
    await loadBoard([task({ assignedTerminalName: "Shell" })]);

    const pending = dispatchOnMove(PROJECT, "task_1", "in_progress");
    await vi.advanceTimersByTimeAsync(600);
    expect(writes()).toHaveLength(0);

    // Output restarts the clock: the pane is mid-something.
    useTerminalsStore
      .getState()
      .appendOutputLine(shell.id, newOutputLine("building…"));
    await vi.advanceTimersByTimeAsync(700);
    expect(writes()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(400);
    expect(writes()).toHaveLength(1);
    await pending;
  });

  it("does not call a pane at its ring buffer's cap quiet", async () => {
    // The ring holds the last `OUTPUT_RING_BUFFER_CAP` lines and no more, so a
    // pane that has been used for a while sits at that length FOR EVER: every
    // new line drops the oldest. Watching `output.length` for movement on one
    // of those is watching a constant, and every such pane was declared quiet
    // one second into a build it was still streaming.
    vi.useFakeTimers();
    const shell = addPane("Shell", { agentType: "shell", status: "running" });
    fillRing(shell.id);
    await loadBoard([task({ assignedTerminalName: "Shell" })]);

    const pending = dispatchOnMove(PROJECT, "task_1", "in_progress");
    // Output every 600 ms — never a second of silence, never a change in
    // length.
    for (let i = 0; i < 8; i++) {
      await vi.advanceTimersByTimeAsync(600);
      useTerminalsStore
        .getState()
        .appendOutputLine(shell.id, newOutputLine(`building ${i}`));
      expect(useTerminalsStore.getState().byId[shell.id]!.output).toHaveLength(
        OUTPUT_RING_BUFFER_CAP,
      );
    }

    expect(writes()).toHaveLength(0);

    // The cap is what eventually lets the prompt through: a pane streaming a
    // build never has a quiet second, and a prompt that is never sent is worse
    // than one that queues behind the output.
    await vi.advanceTimersByTimeAsync(DISPATCH_QUIET_MAX_WAIT_MS);
    await pending;

    expect(writes()).toHaveLength(1);
  });

  it("stops waiting when the pane is closed", async () => {
    const rocky = addPane("Rocky", { status: "awaiting_approval" });
    await loadBoard([task({ assignedTerminalName: "Rocky" })]);

    const pending = dispatchOnMove(PROJECT, "task_1", "in_progress");
    await settle();
    useTerminalsStore.getState().removeTerminal(rocky.id);
    await pending;

    expect(writes()).toHaveLength(0);
  });

  it("sends one prompt when a card is yanked out and dropped back in", async () => {
    // The wait is parked on a pane that is asking the user something, and the
    // user gets bored and re-drags the card. Two waits on one card means two
    // identical prompts pasted into the pane the moment it clears.
    const rocky = addPane("Rocky", { status: "awaiting_approval" });
    await loadBoard([task({ assignedTerminalName: "Rocky" })]);

    const first = dispatchOnMove(PROJECT, "task_1", "in_progress");
    await settle();
    await dispatchOnMove(PROJECT, "task_1", "todo");
    const second = dispatchOnMove(PROJECT, "task_1", "in_progress");
    await settle();
    useTerminalsStore.getState().setStatus(rocky.id, "idle");
    await Promise.all([first, second]);

    expect(writes()).toHaveLength(1);
    expect(cardOf().findings).toHaveLength(1);
  });

  it("drops a wait for a card that has left In Progress for good", async () => {
    const rocky = addPane("Rocky", { status: "awaiting_approval" });
    await loadBoard([task({ assignedTerminalName: "Rocky" })]);

    const pending = dispatchOnMove(PROJECT, "task_1", "in_progress");
    await settle();
    await dispatchOnMove(PROJECT, "task_1", "todo");
    // The wait is already over — the pane clearing is nothing to do with this
    // card any more, and the promise must not still be holding a subscription.
    await pending;
    useTerminalsStore.getState().setStatus(rocky.id, "idle");
    await settle();

    expect(writes()).toHaveLength(0);
  });

  it("does not write into a card the user has pulled back out", async () => {
    const rocky = addPane("Rocky", { status: "awaiting_approval" });
    await loadBoard([task({ assignedTerminalName: "Rocky" })]);

    const pending = dispatchOnMove(PROJECT, "task_1", "in_progress");
    await settle();
    useRocPlanStore.getState().moveTask(PROJECT, "task_1", "todo");
    useTerminalsStore.getState().setStatus(rocky.id, "idle");
    await pending;

    expect(writes()).toHaveLength(0);
  });
});

describe("when the write fails", () => {
  it("says so and leaves nothing waiting on the pane", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rocky = addPane("Rocky");
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "plan_read") return [task({ assignedTerminalName: "Rocky" })];
      if (cmd === "terminal_write") throw new Error("no such pty");
      return null;
    });
    await useRocPlanStore.getState().loadBoard(PROJECT);

    await dispatchOnMove(PROJECT, "task_1", "in_progress");

    expect(toastText().at(-1)).toContain("Rocky");
    // Nothing is waiting on that pane's next idle, either: no prompt reached
    // it, so there is no turn of its to call finished.
    expect(dispatchedCardFor(rocky.id)).toBeNull();
    expect(cardOf().findings).toHaveLength(0);
    warn.mockRestore();
  });
});

describe("auto-advance", () => {
  let stop: () => void = () => {};

  beforeEach(() => {
    stop = mountRocPlanDispatch();
  });
  afterEach(() => stop());

  /** Dispatch a card to `Rocky` and hand back its pane. */
  async function dispatched(): Promise<TerminalSession> {
    const rocky = addPane("Rocky");
    await loadBoard([task({ assignedTerminalName: "Rocky" })]);
    await dispatchOnMove(PROJECT, "task_1", "in_progress");
    return rocky;
  }

  it("sends the card to In Review when the turn ends", async () => {
    const rocky = await dispatched();

    useTerminalsStore.getState().setStatus(rocky.id, "running");
    useTerminalsStore.getState().setStatus(rocky.id, "idle");
    await settle();

    expect(cardOf().status).toBe("in_review");
    expect(cardOf().findings.at(-1)).toMatchObject({
      by: "Rocky",
      text: "Turn finished — awaiting review",
    });
  });

  it("re-reads the file before filing, so an agent's own move stands", async () => {
    // The race this loses without a fresh read: the agent calls
    // `rocplan_update_task_status(complete)` and its Stop hook fires
    // milliseconds later. The MIRROR still says in_progress — nothing has told
    // it otherwise, and `ensureBoardLoaded` short-circuits on a board that is
    // already being followed — so the card is dragged back out of Complete and
    // the agent's own answer is written away.
    const rocky = await dispatched();
    // The dispatch's own finding reaches the file first, as it would long
    // before a turn ends.
    await flushPlanWrites(PROJECT);
    const writesBefore = planWrites();

    disk = disk.map((t) =>
      t.id === "task_1" ? { ...t, status: "complete" as const } : t,
    );

    useTerminalsStore.getState().setStatus(rocky.id, "running");
    useTerminalsStore.getState().setStatus(rocky.id, "idle");
    await settle();

    expect(cardOf().status).toBe("complete");
    expect(disk[0]!.status).toBe("complete");
    // No move, and nothing written: the file already had the answer.
    expect(planWrites()).toBe(writesBefore);
  });

  it("waits for the turn the prompt started, not the one it queued behind", async () => {
    // The pane was mid-turn when the card was dropped on it: the CLI queues
    // what is typed while it works, so the prompt is not read until the turn
    // the user started has ENDED. Filing the card on that turn's Stop credits
    // the agent with work it has not looked at yet.
    const rocky = addPane("Rocky", { status: "running" });
    await loadBoard([task({ assignedTerminalName: "Rocky" })]);
    await dispatchOnMove(PROJECT, "task_1", "in_progress");

    useTerminalsStore.getState().setStatus(rocky.id, "idle");
    await settle();

    expect(cardOf().status).toBe("in_progress");

    // The queued prompt's own turn is the one that files it.
    useTerminalsStore.getState().setStatus(rocky.id, "running");
    useTerminalsStore.getState().setStatus(rocky.id, "idle");
    await settle();

    expect(cardOf().status).toBe("in_review");
  });

  it("keeps both cards when two are dispatched to one pane", async () => {
    // A second card dropped on a busy pane used to overwrite the first in the
    // map, and the first sat in In Progress for ever with nothing watching it.
    const rocky = addPane("Rocky");
    await loadBoard([
      task({ assignedTerminalName: "Rocky" }),
      task({ id: "task_2", title: "Second", assignedTerminalName: "Rocky" }),
    ]);
    await dispatchOnMove(PROJECT, "task_1", "in_progress");
    await dispatchOnMove(PROJECT, "task_2", "in_progress");

    useTerminalsStore.getState().setStatus(rocky.id, "running");
    useTerminalsStore.getState().setStatus(rocky.id, "idle");
    await settle();

    // One turn, one card — the queue is answered in the order it was made.
    expect(cardOf("task_1").status).toBe("in_review");
    expect(cardOf("task_2").status).toBe("in_progress");

    useTerminalsStore.getState().setStatus(rocky.id, "running");
    useTerminalsStore.getState().setStatus(rocky.id, "idle");
    await settle();

    expect(cardOf("task_2").status).toBe("in_review");
  });

  it("files every outstanding card when the pane's process is gone", async () => {
    // Nothing is ever going to end a turn on a dead pane, so a card left
    // behind here is a card left behind for good.
    const rocky = addPane("Rocky");
    await loadBoard([
      task({ assignedTerminalName: "Rocky" }),
      task({ id: "task_2", title: "Second", assignedTerminalName: "Rocky" }),
    ]);
    await dispatchOnMove(PROJECT, "task_1", "in_progress");
    await dispatchOnMove(PROJECT, "task_2", "in_progress");

    useTerminalsStore.getState().setStatus(rocky.id, "error");
    await settle();

    expect(cardOf("task_1").status).toBe("in_review");
    expect(cardOf("task_2").status).toBe("in_review");
  });

  it("counts a pane exiting as the end of the turn", async () => {
    const rocky = await dispatched();

    useTerminalsStore.getState().setStatus(rocky.id, "complete");
    await settle();

    expect(cardOf().status).toBe("in_review");
  });

  it("does not move a card the agent has already filed itself", async () => {
    // Agents have the MCP tools and are told to use them; the card may well be
    // in Complete before the turn that put it there has ended.
    const rocky = await dispatched();
    useRocPlanStore.getState().moveTask(PROJECT, "task_1", "complete");

    useTerminalsStore.getState().setStatus(rocky.id, "running");
    useTerminalsStore.getState().setStatus(rocky.id, "idle");
    await settle();

    expect(cardOf().status).toBe("complete");
    expect(cardOf().findings).toHaveLength(1);
  });

  it("fires once per dispatch, not once per idle", async () => {
    const rocky = await dispatched();

    useTerminalsStore.getState().setStatus(rocky.id, "running");
    useTerminalsStore.getState().setStatus(rocky.id, "idle");
    await settle();
    // The user takes it back for another go, by hand, without a dispatch.
    useRocPlanStore.getState().moveTask(PROJECT, "task_1", "in_progress");
    useTerminalsStore.getState().setStatus(rocky.id, "running");
    useTerminalsStore.getState().setStatus(rocky.id, "idle");
    await settle();

    expect(cardOf().status).toBe("in_progress");
  });

  it("ignores a pane going idle without having run", async () => {
    const rocky = await dispatched();

    // No `running` in between: nothing started, so nothing finished.
    useTerminalsStore.getState().setStatus(rocky.id, "awaiting_approval");
    useTerminalsStore.getState().setStatus(rocky.id, "idle");
    await settle();

    expect(cardOf().status).toBe("in_progress");
  });

  it("moves a card whose board nobody is looking at", async () => {
    // The whole point: the user dispatched from the board and went back to
    // their panes, so nothing is following the file any more. The store
    // refuses mutations to a board that is not live — this has to load it.
    const rocky = await dispatched();
    useRocPlanStore.getState().unloadBoard(PROJECT);

    useTerminalsStore.getState().setStatus(rocky.id, "running");
    useTerminalsStore.getState().setStatus(rocky.id, "idle");
    await settle();

    expect(cardOf().status).toBe("in_review");
  });

  it("hands back the watch it took to move a card off the board", async () => {
    // Loading a board to mutate it takes a file watch and leaves the mirror
    // LIVE. Left that way, every advance from outside the board takes another
    // watch on a project nobody is showing, and the mirror keeps claiming to
    // agree with a file nothing is following any more.
    const rocky = await dispatched();
    useRocPlanStore.getState().unloadBoard(PROJECT);

    useTerminalsStore.getState().setStatus(rocky.id, "running");
    useTerminalsStore.getState().setStatus(rocky.id, "idle");
    await settle();

    expect(cardOf().status).toBe("in_review");
    expect(ipcCalls("plan_watch")).toBe(ipcCalls("plan_unwatch"));
  });

  it("keeps the watch when the board is the one that took it", async () => {
    // The board is on screen: it owns the watch, and an advance must not hand
    // back somebody else's.
    const rocky = await dispatched();

    useTerminalsStore.getState().setStatus(rocky.id, "running");
    useTerminalsStore.getState().setStatus(rocky.id, "idle");
    await settle();

    expect(cardOf().status).toBe("in_review");
    expect(ipcCalls("plan_unwatch")).toBe(0);
  });

  it("puts it in the bell, where it keeps until somebody looks", async () => {
    // A toast would be gone in six seconds; a card waiting for review is still
    // waiting in ten minutes.
    const rocky = await dispatched();

    useTerminalsStore.getState().setStatus(rocky.id, "running");
    useTerminalsStore.getState().setStatus(rocky.id, "idle");
    await settle();

    expect(useNotificationsStore.getState().items[0]).toMatchObject({
      terminalId: rocky.id,
      terminalName: "Rocky",
      kind: "review",
    });
  });

  it("says nothing when the card was not the one that moved", async () => {
    const rocky = await dispatched();
    useRocPlanStore.getState().moveTask(PROJECT, "task_1", "complete");

    useTerminalsStore.getState().setStatus(rocky.id, "running");
    useTerminalsStore.getState().setStatus(rocky.id, "idle");
    await settle();

    expect(useNotificationsStore.getState().items).toHaveLength(0);
  });

  it("forgets the pane when it is closed", async () => {
    const rocky = await dispatched();
    expect(dispatchedCardFor(rocky.id)).toEqual({
      projectPath: PROJECT,
      taskId: "task_1",
    });

    useTerminalsStore.getState().removeTerminal(rocky.id);

    expect(dispatchedCardFor(rocky.id)).toBeNull();
  });

  it("forgets the card when it leaves In Progress by hand", async () => {
    const rocky = await dispatched();

    await dispatchOnMove(PROJECT, "task_1", "todo");

    expect(dispatchedCardFor(rocky.id)).toBeNull();
  });
});

describe("jumping to an agent", () => {
  it("shows the panes, focuses the named one and highlights it", () => {
    const rocky = addPane("Rocky");

    expect(jumpToAgent("Rocky")).toBe(true);

    expect(useUIStore.getState().mainView).toBe("terminals");
    expect(useUIStore.getState().focusedTerminalId).toBe(rocky.id);
    // Focus is a thin ring on one of up to sixteen panes; the highlight is what
    // makes the jump land somewhere the eye finds.
    expect(useUIStore.getState().highlightedTerminalId).toBe(rocky.id);
  });

  it("says so rather than jumping nowhere", () => {
    // The name is in the repository and outlives the session it names.
    addPane("Rocky");

    expect(jumpToAgent("Ghost")).toBe(false);

    expect(useUIStore.getState().mainView).toBe("rocplan");
    expect(toastText().at(-1)).toContain("Ghost");
  });
});
