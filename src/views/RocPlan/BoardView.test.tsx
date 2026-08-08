/** The board surface: what it draws, and the three ways a card moves. */

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
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import { newTerminal, newWorkspace } from "@/lib/factories";
import { resetRocPlanModuleState, useRocPlanStore } from "@/stores/rocplan";
import { useTerminalsStore } from "@/stores/terminals";
import { resetToastsState, useToastsStore } from "@/stores/toasts";
import { useUIStore } from "@/stores/ui";
import { useWorkspacesStore } from "@/stores/workspaces";
import { BoardView } from "@/views/RocPlan/BoardView";
import { TASK_DRAG_TYPE } from "@/views/RocPlan/TaskCard";
import type { RocTask, TerminalSession } from "@/lib/bindings";

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

/** Boot a workspace on `projectPath` and seed the mirror with `tasks`. */
function seed(tasks: RocTask[], projectPath: string | null = PROJECT) {
  const workspace = newWorkspace({
    name: "rocspace",
    projectPath,
    order: 0,
  });
  useWorkspacesStore.setState({
    workspaces: [workspace],
    activeWorkspaceId: workspace.id,
  });
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "plan_read") return tasks;
    return null;
  });
}

/** Render and let the mount's `plan_read` land, so nothing asserts against a
 *  board that is still loading. */
async function renderBoard() {
  const result = render(<BoardView />);
  await waitFor(() =>
    expect(invoke.mock.calls.some(([cmd]) => cmd === "plan_read")).toBe(true),
  );
  return result;
}

/** A card, by its title. Anchored at the start because the movers inside a
 *  card are named after it too (`Move "…" to In Review`). */
const card = (title: string) =>
  screen.getByRole("button", { name: RegExp(`^${title}`) });
const findCard = (title: string) =>
  screen.findByRole("button", { name: RegExp(`^${title}`) });
const mirror = () => useRocPlanStore.getState().tasksByProject[PROJECT] ?? [];

/** A `dataTransfer` carrying one of the board's cards, shaped the way a browser
 *  hands one over: the TYPES are readable throughout the drag, the data behind
 *  them only at the drop. */
const cardDrag = (taskId: string) => ({
  types: [TASK_DRAG_TYPE],
  getData: (type: string) => (type === TASK_DRAG_TYPE ? taskId : ""),
  dropEffect: "move",
});

/** …and one carrying anything else. A sidebar workspace row drags exactly like
 *  this — `text/plain` and nothing more — from the panel next door. */
const foreignDrag = (text: string) => ({
  types: ["text/plain"],
  getData: (type: string) => (type === "text/plain" ? text : ""),
  dropEffect: "move",
});

/** A drop carrying `taskId`, as the browser would deliver it. */
const drop = (column: HTMLElement, taskId: string) =>
  fireEvent.drop(column, { dataTransfer: cardDrag(taskId) });

/** Give the active workspace a pane called `name`. */
function addPane(name: string): TerminalSession {
  const workspaceId = useWorkspacesStore.getState().workspaces[0]!.id;
  const terminal = newTerminal({
    workspaceId,
    name,
    agentType: "claude-code",
    projectPath: PROJECT,
  });
  useTerminalsStore.getState().addTerminal(terminal);
  return terminal;
}

const wroteTo = (terminalId: string) =>
  invoke.mock.calls.some(
    ([cmd, args]) =>
      cmd === "terminal_write" &&
      (args as { terminalId: string }).terminalId === terminalId,
  );

beforeEach(() => {
  invoke.mockReset();
  useTerminalsStore.setState({ byId: {} });
  resetToastsState();
  resetRocPlanModuleState();
  useRocPlanStore.setState({
    tasksByProject: {},
    loadingByProject: {},
    errorByProject: {},
  });
  useUIStore.setState({ taskEditor: null, mainView: "rocplan" });
  seed([]);
});

describe("the columns", () => {
  it("draws the four working columns and keeps Cancelled behind a toggle", async () => {
    seed([task({ id: "cancelled_1", title: "Dropped", status: "cancelled" })]);
    await renderBoard();

    await screen.findByLabelText(/^To Do,/);
    expect(screen.getByLabelText(/^In Progress,/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^In Review,/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Complete,/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/^Cancelled,/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Show cancelled" }));

    expect(screen.getByLabelText(/^Cancelled,/)).toBeInTheDocument();
    expect(card("Dropped")).toBeInTheDocument();
  });

  it("counts what is in it, in its own label", async () => {
    seed([task(), task({ id: "task_2", title: "Second" })]);
    await renderBoard();

    await screen.findByLabelText("To Do, 2 tasks");
    expect(screen.getByLabelText("In Progress, 0 tasks")).toBeInTheDocument();
  });

  it("says it is empty until something is dragged over it", async () => {
    await renderBoard();

    const todo = await screen.findByLabelText(/^To Do,/);
    expect(screen.getAllByText("No tasks").length).toBe(4);

    fireEvent.dragOver(todo, { dataTransfer: cardDrag("task_1") });

    expect(screen.getByText("Drop here")).toBeInTheDocument();
  });

  // The header's chip counted every card in the file, cancelled ones included —
  // a number that could not be reconciled with the four column counts beneath
  // it, and whose missing cards were behind a toggle the user had not pressed.
  it("counts what is on screen, not what is in the file", async () => {
    seed([
      task(),
      task({ id: "task_2", title: "Second" }),
      task({ id: "task_3", title: "Dropped", status: "cancelled" }),
    ]);
    await renderBoard();
    await findCard("Wire the board");

    const count = () =>
      screen.getByTitle(PROJECT).querySelector("span:last-child")?.textContent;
    expect(count()).toBe("2");

    fireEvent.click(screen.getByRole("button", { name: "Show cancelled" }));
    expect(count()).toBe("3");
  });
});

describe("a card", () => {
  it("says what it is, where it is and how to move it", async () => {
    seed([
      task({
        title: "Ship the board",
        priority: "critical",
        assignedTerminalName: "Rocky",
      }),
    ]);
    await renderBoard();

    const el = await findCard("Ship the board");
    expect(el).toHaveAttribute(
      "aria-label",
      "Ship the board — Critical priority, To Do, assigned to Rocky. Left and right arrows move it between columns; Enter opens it.",
    );
  });

  it("moves right and left with the arrow keys", async () => {
    seed([task()]);
    await renderBoard();

    fireEvent.keyDown(await findCard("Wire the board"), { key: "ArrowRight" });
    expect(mirror()[0]!.status).toBe("in_progress");

    fireEvent.keyDown(card("Wire the board"), { key: "ArrowLeft" });
    expect(mirror()[0]!.status).toBe("todo");
  });

  it("stops at the ends of the row instead of falling off", async () => {
    seed([task()]);
    await renderBoard();

    fireEvent.keyDown(await findCard("Wire the board"), { key: "ArrowLeft" });

    expect(mirror()[0]!.status).toBe("todo");
  });

  it("claims an arrow at the end of the row rather than scrolling the board", async () => {
    // The column strip scrolls horizontally. A left arrow in the first column
    // has nowhere to move the card, and handing it back to the browser scrolls
    // the board sideways out from under the card the user is holding.
    seed([task()]);
    await renderBoard();
    const el = await findCard("Wire the board");

    const event = new KeyboardEvent("keydown", {
      key: "ArrowLeft",
      bubbles: true,
      cancelable: true,
    });
    el.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(mirror()[0]!.status).toBe("todo");
  });

  it("cannot be walked into a column that is hidden", async () => {
    // Cancelled is off screen. An arrow that put a card there would be a card
    // the user watched disappear.
    seed([task({ status: "complete" })]);
    await renderBoard();

    fireEvent.keyDown(await findCard("Wire the board"), { key: "ArrowRight" });
    expect(mirror()[0]!.status).toBe("complete");

    fireEvent.click(screen.getByRole("button", { name: "Show cancelled" }));
    fireEvent.keyDown(card("Wire the board"), { key: "ArrowRight" });

    expect(mirror()[0]!.status).toBe("cancelled");
  });

  it("keeps the movers outside the card's button", async () => {
    // A button's children are presentational as far as ARIA is concerned, so a
    // mover nested inside the card's `role="button"` is a control a screen
    // reader is entitled to never announce — and interactive content inside a
    // button is invalid besides.
    seed([task()]);
    await renderBoard();

    const face = await findCard("Wire the board");
    const mover = screen.getByRole("button", {
      name: 'Move "Wire the board" to In Progress',
    });

    expect(face.contains(mover)).toBe(false);
    expect(face.querySelector("button")).toBeNull();
  });

  it("moves with the hover movers, without opening the editor", async () => {
    seed([task()]);
    await renderBoard();
    await findCard("Wire the board");

    fireEvent.click(
      screen.getByRole("button", {
        name: 'Move "Wire the board" to In Progress',
      }),
    );

    expect(mirror()[0]!.status).toBe("in_progress");
    expect(useUIStore.getState().taskEditor).toBeNull();
  });

  it("opens the editor from anywhere on the card's body", async () => {
    // The face is the card, not the title line. The a11y rewrite moved the
    // movers and the agent chip out of the button — correctly — and took the
    // priority pill and the note count with them, which left a card whose only
    // clickable part was one line of text with a column of dead space under it.
    seed([task({ findings: [{ at: 1, by: "Rocky", text: "looked at it" }] })]);
    await renderBoard();
    const face = await findCard("Wire the board");

    const pill = screen.getByText("Medium");
    const notes = screen.getByText(/^1 note$/);
    expect(face.contains(pill)).toBe(true);
    expect(face.contains(notes)).toBe(true);

    fireEvent.click(pill);
    expect(useUIStore.getState().taskEditor).toEqual({
      projectPath: PROJECT,
      taskId: "task_1",
    });

    act(() => useUIStore.getState().closeTaskEditor());
    fireEvent.click(notes);
    expect(useUIStore.getState().taskEditor).toEqual({
      projectPath: PROJECT,
      taskId: "task_1",
    });
  });

  it("opens the editor on click and on Enter", async () => {
    seed([task()]);
    await renderBoard();

    fireEvent.click(await findCard("Wire the board"));
    expect(useUIStore.getState().taskEditor).toEqual({
      projectPath: PROJECT,
      taskId: "task_1",
    });

    act(() => useUIStore.getState().closeTaskEditor());
    fireEvent.keyDown(card("Wire the board"), { key: "Enter" });
    expect(useUIStore.getState().taskEditor).toEqual({
      projectPath: PROJECT,
      taskId: "task_1",
    });
  });
});

describe("dragging", () => {
  it("moves the dropped card into the column it landed on", async () => {
    seed([task()]);
    await renderBoard();
    await findCard("Wire the board");

    drop(screen.getByLabelText(/^In Review,/), "task_1");

    expect(mirror()[0]!.status).toBe("in_review");
  });

  it("ignores a drop carrying nothing", async () => {
    seed([task()]);
    await renderBoard();
    await findCard("Wire the board");

    drop(screen.getByLabelText(/^Complete,/), "");

    expect(mirror()[0]!.status).toBe("todo");
  });

  // The sidebar is one panel to the left and its workspace rows drag with
  // `text/plain` — which is what the cards used to drag with too. So a
  // workspace hauled across the board tinted the column and said "Drop here",
  // and the drop then asked `moveTask` to move a task whose id was really a
  // workspace's: no such card, silent no-op, and a drop target that had
  // promised something it could not do.
  it("does not offer itself to a drag that is not one of its cards", async () => {
    seed([task()]);
    await renderBoard();
    await findCard("Wire the board");
    const todo = screen.getByLabelText(/^To Do,/);
    const complete = screen.getByLabelText(/^Complete,/);

    // A workspace id, exactly as `WorkspaceList` sets it.
    fireEvent.dragOver(todo, { dataTransfer: foreignDrag("ws_01H") });
    expect(screen.queryByText("Drop here")).toBeNull();

    fireEvent.drop(complete, { dataTransfer: foreignDrag("ws_01H") });
    expect(mirror()[0]!.status).toBe("todo");
  });

  // The one refusal the board had no channel for: `mutate` declines a project
  // whose mirror is not live, the card springs back, and the reason went to a
  // console nobody has open. Every other mutation path already says so.
  it("says so when the board is not holding the plan", async () => {
    seed([task()]);
    await renderBoard();
    await findCard("Wire the board");

    // What `unloadBoard` leaves behind: the mirror is kept on purpose (coming
    // back should paint), so the board renders and refuses.
    act(() => useRocPlanStore.getState().unloadBoard(PROJECT));

    drop(screen.getByLabelText(/^In Review,/), "task_1");

    expect(mirror()[0]!.status).toBe("todo");
    expect(useToastsStore.getState().items.map((t) => t.message)).toEqual([
      expect.stringMatching(/not holding this project's plan/),
    ]);
  });
});

describe("dispatch", () => {
  // The board's job here is to route every move through the dispatch wrapper
  // rather than the store — what the wrapper then decides is its own test.
  it("hands a card dropped on In Progress to its agent", async () => {
    seed([task({ assignedTerminalName: "Rocky" })]);
    const rocky = addPane("Rocky");
    await renderBoard();
    await findCard("Wire the board");

    drop(screen.getByLabelText(/^In Progress,/), "task_1");

    await waitFor(() => expect(wroteTo(rocky.id)).toBe(true));
    expect(mirror()[0]!.status).toBe("in_progress");
  });

  it("dispatches from the arrow keys too, not just the drag", async () => {
    seed([task({ assignedTerminalName: "Rocky" })]);
    const rocky = addPane("Rocky");
    await renderBoard();

    fireEvent.keyDown(await findCard("Wire the board"), { key: "ArrowRight" });

    await waitFor(() => expect(wroteTo(rocky.id)).toBe(true));
  });

  it("jumps to the agent's pane from the card's chip", async () => {
    seed([task({ assignedTerminalName: "Rocky" })]);
    const rocky = addPane("Rocky");
    await renderBoard();
    await findCard("Wire the board");

    fireEvent.click(screen.getByRole("button", { name: "Go to Rocky" }));

    expect(useUIStore.getState().mainView).toBe("terminals");
    expect(useUIStore.getState().focusedTerminalId).toBe(rocky.id);
    // Not the editor: the chip is its own control, not part of the card's face.
    expect(useUIStore.getState().taskEditor).toBeNull();
  });

  it("keeps the agent chip out of the card's button", async () => {
    // Same rule as the movers: a button inside a `role="button"` is a control
    // a screen reader is entitled to never announce.
    seed([task({ assignedTerminalName: "Rocky" })]);
    addPane("Rocky");
    await renderBoard();

    const face = await findCard("Wire the board");
    const chip = screen.getByRole("button", { name: "Go to Rocky" });

    expect(face.contains(chip)).toBe(false);
  });

  it("says nothing to anybody about a card filed in another column", async () => {
    seed([task({ assignedTerminalName: "Rocky" })]);
    const rocky = addPane("Rocky");
    await renderBoard();
    await findCard("Wire the board");

    drop(screen.getByLabelText(/^Complete,/), "task_1");

    await waitFor(() => expect(mirror()[0]!.status).toBe("complete"));
    expect(wroteTo(rocky.id)).toBe(false);
  });
});

describe("the board's own chrome", () => {
  it("re-reads the file on Refresh", async () => {
    await renderBoard();
    const before = invoke.mock.calls.filter(
      ([cmd]) => cmd === "plan_read",
    ).length;

    fireEvent.click(screen.getByRole("button", { name: "Refresh board" }));

    await waitFor(() =>
      expect(
        invoke.mock.calls.filter(([cmd]) => cmd === "plan_read").length,
      ).toBe(before + 1),
    );
  });

  it("opens the create form from the header and from To Do", async () => {
    await renderBoard();

    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    expect(useUIStore.getState().taskEditor).toEqual({
      projectPath: PROJECT,
      taskId: null,
    });

    act(() => useUIStore.getState().closeTaskEditor());
    // The column's own `+`, which is on To Do only — a new task is a to-do.
    fireEvent.click(screen.getByRole("button", { name: "New task in To Do" }));
    expect(useUIStore.getState().taskEditor).toEqual({
      projectPath: PROJECT,
      taskId: null,
    });
    expect(
      screen.queryByRole("button", { name: "New task in Complete" }),
    ).toBeNull();
  });

  it("hands the watch back when the board goes away", async () => {
    const { unmount } = await renderBoard();

    unmount();

    await waitFor(() =>
      expect(invoke.mock.calls.some(([cmd]) => cmd === "plan_unwatch")).toBe(
        true,
      ),
    );
  });
});

describe("a workspace with no directory", () => {
  it("says where a board would have to live instead of offering one", async () => {
    seed([], null);

    render(<BoardView />);

    expect(
      screen.getByText("Pick a project directory to plan against"),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText(/^To Do,/)).toBeNull();
    // Nothing was read: there is no file to read.
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("while the plan is being read", () => {
  it("says what it is doing instead of showing four empty columns", async () => {
    let deliver = (_: RocTask[]) => {};
    const read = new Promise<RocTask[]>((resolve) => {
      deliver = resolve;
    });
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "plan_read") return read;
      return null;
    });

    render(<BoardView />);

    expect(
      screen.getByText("Reading .rocspace/plan.json…"),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText(/^To Do,/)).toBeNull();

    await act(async () => {
      deliver([task()]);
    });

    expect(screen.getByLabelText("To Do, 1 task")).toBeInTheDocument();
  });
});

describe("when the plan cannot be read", () => {
  const failRead = () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "plan_read") throw new Error("permission denied");
      return null;
    });
  };

  it("says so, with the reason, instead of an empty board", async () => {
    // An empty board and an unreadable one look identical, and the difference
    // is whether adding a card would write over somebody's work.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    failRead();

    render(<BoardView />);

    expect(
      await screen.findByText("RocPlan could not read this project's plan"),
    ).toBeInTheDocument();
    expect(screen.getByText("permission denied")).toBeInTheDocument();
    expect(screen.queryByLabelText(/^To Do,/)).toBeNull();
    // Nothing to add a card to, either.
    expect(screen.queryByRole("button", { name: "New task" })).toBeNull();
    warn.mockRestore();
  });

  it("offers to try again, and shows the board once it works", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    failRead();
    render(<BoardView />);
    await screen.findByText("RocPlan could not read this project's plan");

    seed([task()]);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByLabelText("To Do, 1 task")).toBeInTheDocument();
    warn.mockRestore();
  });
});

describe("when a change cannot be written", () => {
  it("says the board is not saved, over the board it is not saving", async () => {
    // The board keeps working — the mirror is right — but the repository is
    // not, and the user has no other way to find that out.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    seed([task()]);
    await renderBoard();
    await findCard("Wire the board");

    await act(async () => {
      useRocPlanStore.setState((s) => {
        s.errorByProject[PROJECT] = {
          kind: "write",
          message: "read-only file system",
        };
      });
    });

    expect(screen.getByText(/These changes are not saved/)).toBeInTheDocument();
    expect(screen.getByText("read-only file system")).toBeInTheDocument();
    // The columns are still there: what is on screen is still the truth about
    // the plan, just not about the file.
    expect(screen.getByLabelText("To Do, 1 task")).toBeInTheDocument();
    warn.mockRestore();
  });

  it("tries the WRITE again, and does not read over the edit", async () => {
    // The banner means the board is showing edits that are not on disk. The
    // button under it used to re-read the file — which replaces those edits
    // with the version that does not have them, and then (inside the debounce)
    // writes the revert. The one control offered to somebody about to lose
    // work was the fastest way to lose it.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    seed([task()]);
    await renderBoard();
    await findCard("Wire the board");

    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "plan_read") return [task()];
      if (cmd === "plan_write") throw new Error("read-only file system");
      return null;
    });

    fireEvent.keyDown(card("Wire the board"), { key: "ArrowRight" });
    await screen.findByText(/These changes are not saved/);

    const count = (cmd: string) =>
      invoke.mock.calls.filter(([name]) => name === cmd).length;
    const reads = count("plan_read");
    const writes = count("plan_write");

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(count("plan_write")).toBe(writes + 1);
    expect(count("plan_read")).toBe(reads);
    expect(mirror()[0]!.status).toBe("in_progress");
    warn.mockRestore();
  });

  it("words a stale read differently from an unsaved write", async () => {
    seed([task()]);
    await renderBoard();
    await findCard("Wire the board");

    await act(async () => {
      useRocPlanStore.setState((s) => {
        s.errorByProject[PROJECT] = { kind: "read", message: "gone" };
      });
    });

    expect(screen.getByText(/may be out of date/)).toBeInTheDocument();
  });
});
