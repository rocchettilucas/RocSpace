/** The card editor: what it opens on, what it saves, and what it asks before
 *  deleting. */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const invoke = vi.fn(async (..._args: unknown[]): Promise<unknown> => null);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import { answerConfirmsWith } from "@/test/confirm";
import { newTerminal, newWorkspace } from "@/lib/factories";
import { resetRocPlanModuleState, useRocPlanStore } from "@/stores/rocplan";
import { useTerminalsStore } from "@/stores/terminals";
import { useUIStore } from "@/stores/ui";
import { useWorkspacesStore } from "@/stores/workspaces";
import { TaskDialog, TaskModal } from "@/views/RocPlan/TaskModal";
import type { RocTask } from "@/lib/bindings";

const PROJECT = "/code/rocspace";

const task = (over: Partial<RocTask> = {}): RocTask => ({
  id: "task_1",
  title: "Wire the board",
  description: "columns first",
  status: "todo",
  priority: "high",
  assignedTerminalName: null,
  findings: [],
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

const titleField = () => screen.getByLabelText("Title") as HTMLInputElement;
const descriptionField = () =>
  screen.getByLabelText("Description") as HTMLTextAreaElement;
const assigneeField = () =>
  screen.getByLabelText("Assigned agent") as HTMLSelectElement;
const mirror = () => useRocPlanStore.getState().tasksByProject[PROJECT] ?? [];

/** One workspace with two named panes, and a LOADED board holding `tasks`.
 *
 *  Through `loadBoard` rather than by writing `tasksByProject` directly,
 *  because the two are not the same board: a mirror the store is not following
 *  takes no mutations at all, so a dialog tested against a hand-poked one would
 *  be a dialog tested against a state the app cannot reach. */
async function seed(
  tasks: RocTask[],
  paneNames: string[] = ["Rocky", "Rhodes"],
) {
  const workspace = newWorkspace({ projectPath: PROJECT, order: 0 });
  const sessions = paneNames.map((name) =>
    newTerminal({
      workspaceId: workspace.id,
      name,
      agentType: "claude-code",
      projectPath: PROJECT,
    }),
  );
  useWorkspacesStore.setState({
    workspaces: [workspace],
    activeWorkspaceId: workspace.id,
  });
  useTerminalsStore.getState().setTerminals(sessions);
  invoke.mockImplementation(async (cmd: unknown) =>
    cmd === "plan_read" ? tasks : null,
  );
  await useRocPlanStore.getState().loadBoard(PROJECT);
}

beforeEach(async () => {
  invoke.mockClear();
  resetRocPlanModuleState();
  useTerminalsStore.setState({ byId: {} });
  useUIStore.setState({ taskEditor: null });
  useRocPlanStore.setState({
    tasksByProject: {},
    loadingByProject: {},
    errorByProject: {},
  });
  await seed([]);
});

describe("opening", () => {
  it("renders nothing while no card is being edited", () => {
    render(<TaskModal />);

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens the create form empty, with the title focused", () => {
    render(<TaskDialog projectPath={PROJECT} taskId={null} />);

    expect(screen.getByText("New task")).toBeInTheDocument();
    expect(titleField()).toHaveValue("");
    expect(titleField()).toHaveFocus();
    // Nothing to delete yet.
    expect(screen.queryByRole("button", { name: /Delete/ })).toBeNull();
  });

  it("opens an existing card on its own values", async () => {
    await seed([task({ assignedTerminalName: "Rhodes" })]);

    render(<TaskDialog projectPath={PROJECT} taskId="task_1" />);

    expect(titleField()).toHaveValue("Wire the board");
    expect(descriptionField()).toHaveValue("columns first");
    expect(screen.getByRole("radio", { name: /High/ })).toBeChecked();
    expect(assigneeField()).toHaveValue("Rhodes");
  });
});

describe("saving", () => {
  it("creates a task from the form and closes", () => {
    useUIStore.getState().openTaskEditor(PROJECT, null);
    render(<TaskModal />);

    fireEvent.change(titleField(), { target: { value: "  Ship it  " } });
    fireEvent.change(descriptionField(), {
      target: { value: "the whole board" },
    });
    fireEvent.click(screen.getByRole("radio", { name: /Critical/ }));
    fireEvent.change(assigneeField(), { target: { value: "Rocky" } });
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));

    expect(mirror()[0]).toMatchObject({
      // Trimmed: a title is what the card is called, and leading space is not
      // part of anybody's name for it.
      title: "Ship it",
      description: "the whole board",
      priority: "critical",
      assignedTerminalName: "Rocky",
      status: "todo",
    });
    expect(useUIStore.getState().taskEditor).toBeNull();
  });

  it("patches an existing card without touching its status or findings", async () => {
    await seed([
      task({
        status: "in_review",
        findings: [{ at: 1, by: "Rocky", text: "Turn finished" }],
      }),
    ]);
    useUIStore.getState().openTaskEditor(PROJECT, "task_1");
    render(<TaskModal />);

    fireEvent.change(titleField(), { target: { value: "Wire the board v2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save task" }));

    expect(mirror()[0]).toMatchObject({
      title: "Wire the board v2",
      status: "in_review",
    });
    expect(mirror()[0]!.findings).toHaveLength(1);
  });

  it("refuses a card with no title", () => {
    render(<TaskDialog projectPath={PROJECT} taskId={null} />);

    expect(screen.getByRole("button", { name: "Create task" })).toBeDisabled();

    fireEvent.change(titleField(), { target: { value: "   " } });
    expect(screen.getByRole("button", { name: "Create task" })).toBeDisabled();
  });

  it("keeps the draft out of the file until Save", () => {
    // A card is a shared document — an agent may be moving it through the MCP
    // server right now — so half-typed titles do not go in the repository.
    render(<TaskDialog projectPath={PROJECT} taskId={null} />);

    fireEvent.change(titleField(), { target: { value: "Half typed" } });

    expect(mirror()).toHaveLength(0);
  });

  it("throws the draft away on Cancel", async () => {
    await seed([task()]);
    useUIStore.getState().openTaskEditor(PROJECT, "task_1");
    render(<TaskModal />);

    fireEvent.change(titleField(), { target: { value: "Never mind" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(mirror()[0]!.title).toBe("Wire the board");
    expect(useUIStore.getState().taskEditor).toBeNull();
  });
});

describe("the assignee list", () => {
  it("offers the workspace's panes, plus Unassigned", () => {
    render(<TaskDialog projectPath={PROJECT} taskId={null} />);

    expect([...assigneeField().options].map((o) => o.textContent)).toEqual([
      "Unassigned",
      "Rocky",
      "Rhodes",
    ]);
  });

  it("carries an ordinary, printable value on the Unassigned option", () => {
    // It was a NUL byte, which made this component's source a binary blob to
    // git and invisible to every grep the repository audits itself with — and
    // which a webview that normalised it could have written into plan.json as
    // an agent's name. Nothing else about the dialog would have caught it.
    render(<TaskDialog projectPath={PROJECT} taskId={null} />);

    expect(assigneeField().options[0]!.value).toMatch(/^[\x20-\x7e]+$/);
  });

  it("keeps a name whose pane has since gone", async () => {
    // Opening a card to read it must not quietly unassign it because the pane
    // it named was closed.
    await seed([task({ assignedTerminalName: "Ghost" })]);

    render(<TaskDialog projectPath={PROJECT} taskId="task_1" />);

    expect(assigneeField()).toHaveValue("Ghost");
    expect([...assigneeField().options].map((o) => o.textContent)).toContain(
      "Ghost",
    );
  });

  it("writes null for Unassigned rather than a placeholder name", async () => {
    await seed([task({ assignedTerminalName: "Rocky" })]);
    useUIStore.getState().openTaskEditor(PROJECT, "task_1");
    render(<TaskModal />);

    fireEvent.change(assigneeField(), {
      target: { value: assigneeField().options[0]!.value },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save task" }));

    expect(mirror()[0]!.assignedTerminalName).toBeNull();
  });
});

describe("findings", () => {
  it("shows the log, read-only", async () => {
    await seed([
      task({
        findings: [
          { at: 1, by: "rocspace", text: "Dispatched to Rocky" },
          { at: 2, by: "mcp:claude", text: "Rate limits landed" },
        ],
      }),
    ]);

    render(<TaskDialog projectPath={PROJECT} taskId="task_1" />);

    expect(screen.getByText("Findings 2")).toBeInTheDocument();
    expect(screen.getByText("Dispatched to Rocky")).toBeInTheDocument();
    expect(screen.getByText("Rate limits landed")).toBeInTheDocument();
    // Two fields, and neither of them is a finding.
    expect(screen.getAllByRole("textbox")).toHaveLength(2);
  });

  it("says nothing at all when there are none", async () => {
    await seed([task()]);

    render(<TaskDialog projectPath={PROJECT} taskId="task_1" />);

    expect(screen.queryByText(/^Findings/)).toBeNull();
  });
});

describe("deleting", () => {
  it("asks first, and keeps the card when refused", async () => {
    await seed([task()]);
    const confirms = answerConfirmsWith(false);
    useUIStore.getState().openTaskEditor(PROJECT, "task_1");
    render(<TaskModal />);

    fireEvent.click(screen.getByRole("button", { name: /Delete/ }));

    await waitFor(() =>
      expect(confirms.asked[0]?.message).toContain("Wire the board"),
    );
    expect(mirror()).toHaveLength(1);
    expect(useUIStore.getState().taskEditor).not.toBeNull();
    confirms.restore();
  });

  it("deletes and closes once confirmed", async () => {
    await seed([task()]);
    const confirms = answerConfirmsWith(true);
    useUIStore.getState().openTaskEditor(PROJECT, "task_1");
    render(<TaskModal />);

    fireEvent.click(screen.getByRole("button", { name: /Delete/ }));

    await waitFor(() => expect(mirror()).toHaveLength(0));
    expect(useUIStore.getState().taskEditor).toBeNull();
    confirms.restore();
  });
});

describe("Escape", () => {
  it("closes from an untouched title field — the state it opens in", async () => {
    // The shell refuses Escape while a text field has the keyboard, and this
    // dialog opens WITH the title focused. Nobody had answered for it, so the
    // key did nothing at all until the user tabbed out of the field.
    await seed([task()]);
    useUIStore.getState().openTaskEditor(PROJECT, "task_1");
    render(<TaskModal />);
    expect(titleField()).toHaveFocus();

    fireEvent.keyDown(titleField(), { key: "Escape" });

    expect(useUIStore.getState().taskEditor).toBeNull();
  });

  it("leaves the field first when there is something to abandon", async () => {
    // Four questions, one Escape: tearing the dialog down to answer "abandon
    // this word" would throw away the other three answers.
    await seed([task()]);
    useUIStore.getState().openTaskEditor(PROJECT, "task_1");
    render(<TaskModal />);

    fireEvent.change(titleField(), { target: { value: "Half typed" } });
    fireEvent.keyDown(titleField(), { key: "Escape" });

    expect(useUIStore.getState().taskEditor).not.toBeNull();
    expect(titleField()).not.toHaveFocus();
    // Still inside the dialog: focus on the body is what the shell's trap
    // exists to prevent.
    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(
      true,
    );
    expect(titleField()).toHaveValue("Half typed");

    // And the second one is the shell's, which now has no text field to stand
    // down for.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(useUIStore.getState().taskEditor).toBeNull();
  });

  it("closes from the description too", async () => {
    await seed([task()]);
    useUIStore.getState().openTaskEditor(PROJECT, "task_1");
    render(<TaskModal />);

    descriptionField().focus();
    fireEvent.keyDown(descriptionField(), { key: "Escape" });

    expect(useUIStore.getState().taskEditor).toBeNull();
  });
});

describe("a change the store refuses", () => {
  it("keeps the dialog and the draft instead of reporting a save", () => {
    // No board is loaded for this project, so a whole-file write would replace
    // a plan this app has never read and `createTask` answers `""`. The version
    // that ignored that return closed the dialog over a task it had dropped —
    // the user is told their work is saved and it is nowhere.
    const ghost = "/code/never-read";
    useUIStore.getState().openTaskEditor(ghost, null);
    render(<TaskModal />);

    fireEvent.change(titleField(), { target: { value: "Ghost" } });
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));

    expect(screen.getByText(/Nothing was saved/)).toBeInTheDocument();
    expect(useUIStore.getState().taskEditor).not.toBeNull();
    expect(titleField()).toHaveValue("Ghost");
    expect(useRocPlanStore.getState().tasksByProject[ghost]).toBeUndefined();
  });

  it("keeps the dialog when a delete does not land either", async () => {
    // A card that is really on the board, and a board the store has stopped
    // following — `unloadBoard` keeps the mirror on purpose, so the dialog
    // renders the card and the store still declines to write.
    await seed([task()]);
    act(() => useRocPlanStore.getState().unloadBoard(PROJECT));
    const confirms = answerConfirmsWith(true);
    useUIStore.getState().openTaskEditor(PROJECT, "task_1");
    render(<TaskModal />);

    fireEvent.click(screen.getByRole("button", { name: /Delete/ }));

    expect(await screen.findByText(/Nothing was saved/)).toBeInTheDocument();
    expect(useUIStore.getState().taskEditor).not.toBeNull();
    confirms.restore();
  });
});

describe("a card that went away underneath", () => {
  it("says so and refuses to save the draft back", async () => {
    await seed([task()]);
    render(<TaskDialog projectPath={PROJECT} taskId="task_1" />);

    // An agent deleted it through the MCP server while the dialog was open.
    act(() => {
      useRocPlanStore.setState({ tasksByProject: { [PROJECT]: [] } });
    });

    expect(screen.getByText(/no longer on the board/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save task" })).toBeDisabled();
  });

  // Only Save was disabled, so Delete stayed live on a card that is not there:
  // it asked `Delete "this task"?` — the fallback title, because the card whose
  // name it would have used is gone — and then reported the refusal as "not
  // holding this project's plan", which is the wrong reason and contradicts the
  // banner directly above it.
  it("does not offer to delete it either", async () => {
    await seed([task()]);
    const confirms = answerConfirmsWith(true);
    render(<TaskDialog projectPath={PROJECT} taskId="task_1" />);

    act(() => {
      useRocPlanStore.setState({ tasksByProject: { [PROJECT]: [] } });
    });

    const remove = screen.getByRole("button", { name: /Delete/ });
    expect(remove).toBeDisabled();
    fireEvent.click(remove);
    expect(screen.queryByText(/Nothing was saved/)).toBeNull();
    confirms.restore();
  });
});
