/** The workspace sidebar: what it shows, and what its controls do. */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

const { commandMocks } = vi.hoisted(() => ({
  commandMocks: {
    terminalSpawn: vi.fn(async () => ({ pid: 1, claudeSessionId: null })),
    terminalKill: vi.fn(async () => {}),
  },
}));

vi.mock("@/lib/bindings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/bindings")>()),
  commands: commandMocks,
}));

import { answerConfirmsWith } from "@/test/confirm";
import { buildBalancedTree } from "@/lib/paneTree";
import { newTerminal } from "@/lib/factories";
import { useTerminalsStore, useUIStore, useWorkspacesStore } from "@/stores";
import { WorkspaceList } from "@/views/Sidebar/WorkspaceList";
import type { Workspace, WorkspaceAccent } from "@/lib/bindings";

/** A workspace with `paneCount` sessions, wired into both stores the way
 *  `createWorkspace` leaves them. Deliberately hand-built rather than routed
 *  through the store's own action: this file is about the sidebar, and the
 *  stand-in store is 2A-model's to test. */
function seedWorkspace(
  name: string,
  paneCount: number,
  accent: WorkspaceAccent = "violet",
): Workspace {
  const id = `ws-${name}`;
  const sessions = Array.from({ length: paneCount }, (_, i) =>
    newTerminal({
      workspaceId: id,
      name: `${name}-${i}`,
      agentType: "claude-code",
      projectPath: `/code/${name}`,
    }),
  );
  for (const s of sessions) useTerminalsStore.getState().addTerminal(s);
  return {
    id,
    name,
    accent,
    projectPath: `/code/${name}`,
    paneTree: buildBalancedTree(sessions.map((s) => s.id)),
    focusedTerminalId: sessions[0]?.id ?? null,
    createdAt: 1,
    updatedAt: 1,
  };
}

/** The same workspace before `ensurePaneTree` has run — panes alive, layout
 *  not derived yet. Reachable on every fresh workspace and on every restore. */
const beforeLayout = (workspace: Workspace): Workspace => ({
  ...workspace,
  paneTree: null,
});

function seed(...workspaces: Workspace[]) {
  useWorkspacesStore.setState({
    workspaces,
    activeWorkspaceId: workspaces[0]?.id ?? null,
  });
}

const rows = () => screen.getAllByRole("tab");
const nameOf = (id: string) =>
  useWorkspacesStore.getState().workspaces.find((w) => w.id === id)?.name;
const order = () => useWorkspacesStore.getState().workspaces.map((w) => w.name);

beforeEach(() => {
  vi.clearAllMocks();
  useWorkspacesStore.setState({ workspaces: [], activeWorkspaceId: null });
  useTerminalsStore.setState({ byId: {} });
  useUIStore.setState({
    isWorkspaceModalOpen: false,
    focusedTerminalId: null,
  });
});

describe("what the list shows", () => {
  it("names the section with the workspace count", () => {
    seed(seedWorkspace("api", 4), seedWorkspace("ui", 2));

    render(<WorkspaceList />);

    expect(screen.getByText("Workspaces 2")).toBeInTheDocument();
  });

  it("renders one tab per workspace, in store order, with its pane count", () => {
    seed(seedWorkspace("api", 4), seedWorkspace("ui", 2));

    render(<WorkspaceList />);

    expect(rows()).toHaveLength(2);
    expect(rows()[0]).toHaveAccessibleName("api, 4 panes");
    expect(rows()[1]).toHaveAccessibleName("ui, 2 panes");
  });

  it("counts the panes a workspace has, not the ones its layout mentions", () => {
    // `paneTree: null` means "not derived yet" — `ensurePaneTree` builds it
    // FROM the sessions, so every workspace passes through a moment where the
    // panes exist and the tree does not. Counted off the tree, that workspace
    // says "0 panes" while four agents run in it.
    seed(beforeLayout(seedWorkspace("api", 4)));

    render(<WorkspaceList />);

    expect(rows()[0]).toHaveAccessibleName("api, 4 panes");
  });

  it("marks the active workspace selected, and only it", () => {
    seed(seedWorkspace("api", 1), seedWorkspace("ui", 1));

    render(<WorkspaceList />);

    expect(rows()[0]).toHaveAttribute("aria-selected", "true");
    expect(rows()[1]).toHaveAttribute("aria-selected", "false");
  });

  it("gives the list a single tab stop, on the active row", () => {
    // Roving tabindex: Tab reaches the list once, the arrows move inside it.
    seed(seedWorkspace("api", 1), seedWorkspace("ui", 1));

    render(<WorkspaceList />);

    expect(rows()[0]).toHaveAttribute("tabindex", "0");
    expect(rows()[1]).toHaveAttribute("tabindex", "-1");
  });

  it("keeps a tab stop when no workspace is active", () => {
    // Reachable: closing the last workspace leaves `activeWorkspaceId` null,
    // and every row at `tabIndex -1` would take the whole list out of the tab
    // order — the sidebar would only answer to the mouse from then on.
    seed(seedWorkspace("api", 1), seedWorkspace("ui", 1));
    useWorkspacesStore.setState({ activeWorkspaceId: null });

    render(<WorkspaceList />);

    expect(rows()[0]).toHaveAttribute("tabindex", "0");
    expect(rows()[1]).toHaveAttribute("tabindex", "-1");
    expect(rows()[0]).toHaveAttribute("aria-selected", "false");
  });

  it("offers a way in when there are no workspaces at all", () => {
    render(<WorkspaceList />);

    expect(screen.getByText(/No workspaces/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "New workspace" }),
    ).toBeInTheDocument();
  });
});

describe("switching", () => {
  it("activates the workspace that was clicked", () => {
    const api = seedWorkspace("api", 1);
    const ui = seedWorkspace("ui", 1);
    seed(api, ui);
    render(<WorkspaceList />);

    fireEvent.click(rows()[1]!);

    expect(useWorkspacesStore.getState().activeWorkspaceId).toBe(ui.id);
  });

  it("moves and selects with the down arrow", () => {
    const api = seedWorkspace("api", 1);
    const ui = seedWorkspace("ui", 1);
    seed(api, ui);
    render(<WorkspaceList />);

    fireEvent.keyDown(rows()[0]!, { key: "ArrowDown" });

    expect(useWorkspacesStore.getState().activeWorkspaceId).toBe(ui.id);
    expect(rows()[1]).toHaveFocus();
  });

  it("wraps around at the ends", () => {
    const api = seedWorkspace("api", 1);
    const ui = seedWorkspace("ui", 1);
    seed(api, ui);
    render(<WorkspaceList />);

    fireEvent.keyDown(rows()[0]!, { key: "ArrowUp" });

    expect(useWorkspacesStore.getState().activeWorkspaceId).toBe(ui.id);
  });

  it("claims the first row from a list with nothing selected", () => {
    // From no selection the first press takes the row the tab stop is already
    // on. Stepping off it instead would skip row 1 entirely — pressing ↓ once
    // would land on row 2, which is a row the user never passed through.
    const api = seedWorkspace("api", 1);
    seed(api, seedWorkspace("ui", 1));
    useWorkspacesStore.setState({ activeWorkspaceId: null });
    render(<WorkspaceList />);

    fireEvent.keyDown(rows()[0]!, { key: "ArrowDown" });

    expect(useWorkspacesStore.getState().activeWorkspaceId).toBe(api.id);
    expect(rows()[0]).toHaveFocus();
  });

  it("claims the first row on the way up too", () => {
    const api = seedWorkspace("api", 1);
    seed(api, seedWorkspace("ui", 1));
    useWorkspacesStore.setState({ activeWorkspaceId: null });
    render(<WorkspaceList />);

    fireEvent.keyDown(rows()[0]!, { key: "ArrowUp" });

    expect(useWorkspacesStore.getState().activeWorkspaceId).toBe(api.id);
  });

  it("opens the new-workspace modal from the header button", () => {
    seed(seedWorkspace("api", 1));
    render(<WorkspaceList />);

    fireEvent.click(screen.getByRole("button", { name: "New workspace" }));

    expect(useUIStore.getState().isWorkspaceModalOpen).toBe(true);
  });
});

describe("rename", () => {
  const open = (row: HTMLElement) =>
    fireEvent.doubleClick(within(row).getByText("api"));

  it("commits on Enter", () => {
    const api = seedWorkspace("api", 1);
    seed(api);
    render(<WorkspaceList />);

    open(rows()[0]!);
    const field = screen.getByLabelText("Workspace name");
    fireEvent.change(field, { target: { value: "backend" } });
    fireEvent.keyDown(field, { key: "Enter" });

    expect(nameOf(api.id)).toBe("backend");
  });

  it("leaves the name alone on Escape", () => {
    const api = seedWorkspace("api", 1);
    seed(api);
    render(<WorkspaceList />);

    open(rows()[0]!);
    const field = screen.getByLabelText("Workspace name");
    fireEvent.change(field, { target: { value: "discarded" } });
    fireEvent.keyDown(field, { key: "Escape" });

    expect(nameOf(api.id)).toBe("api");
    expect(screen.queryByLabelText("Workspace name")).toBeNull();
  });

  it("treats an empty name as a cancel", () => {
    const api = seedWorkspace("api", 1);
    seed(api);
    render(<WorkspaceList />);

    open(rows()[0]!);
    const field = screen.getByLabelText("Workspace name");
    fireEvent.change(field, { target: { value: "   " } });
    fireEvent.keyDown(field, { key: "Enter" });

    expect(nameOf(api.id)).toBe("api");
  });

  it("commits a click-away rename that follows an Enter rename", () => {
    // The settled flag exists for exactly this: cleared on OPEN, never on the
    // blur that Enter's unmount never delivers. Cleared on blur instead, it
    // survives into the next editing session and swallows its commit —
    // silently, and alternating forever after.
    const api = seedWorkspace("api", 1);
    seed(api);
    render(<WorkspaceList />);

    open(rows()[0]!);
    const first = screen.getByLabelText("Workspace name");
    fireEvent.change(first, { target: { value: "backend" } });
    fireEvent.keyDown(first, { key: "Enter" });
    expect(nameOf(api.id)).toBe("backend");

    fireEvent.doubleClick(within(rows()[0]!).getByText("backend"));
    const second = screen.getByLabelText("Workspace name");
    fireEvent.change(second, { target: { value: "core" } });
    fireEvent.blur(second);

    expect(nameOf(api.id)).toBe("core");
  });

  it("commits a click-away rename that follows an Escape", () => {
    const api = seedWorkspace("api", 1);
    seed(api);
    render(<WorkspaceList />);

    open(rows()[0]!);
    const first = screen.getByLabelText("Workspace name");
    fireEvent.change(first, { target: { value: "discarded" } });
    fireEvent.keyDown(first, { key: "Escape" });
    expect(nameOf(api.id)).toBe("api");

    open(rows()[0]!);
    const second = screen.getByLabelText("Workspace name");
    fireEvent.change(second, { target: { value: "core" } });
    fireEvent.blur(second);

    expect(nameOf(api.id)).toBe("core");
  });

  it("does not switch workspaces while the field is being clicked", () => {
    const api = seedWorkspace("api", 1);
    const ui = seedWorkspace("ui", 1);
    seed(api, ui);
    useWorkspacesStore.setState({ activeWorkspaceId: ui.id });
    render(<WorkspaceList />);

    open(rows()[0]!);
    fireEvent.click(screen.getByLabelText("Workspace name"));

    expect(useWorkspacesStore.getState().activeWorkspaceId).toBe(ui.id);
  });
});

describe("closing", () => {
  it("offers the close button on every row, the last one included", () => {
    // Closing the last workspace is allowed and lands on the empty state.
    // Hiding the control there would make "close this workspace" mean
    // something different depending on how many others happen to be open.
    const api = seedWorkspace("api", 1);
    seed(api);
    render(<WorkspaceList />);

    fireEvent.click(screen.getByRole("button", { name: "Close api" }));

    expect(useWorkspacesStore.getState().workspaces).toHaveLength(0);
    expect(useWorkspacesStore.getState().activeWorkspaceId).toBeNull();
  });

  it("closes without a confirm when nothing is running", () => {
    const api = seedWorkspace("api", 1);
    seed(api, seedWorkspace("ui", 1));
    const confirms = answerConfirmsWith(true);
    render(<WorkspaceList />);

    fireEvent.click(screen.getByRole("button", { name: "Close api" }));

    expect(confirms.asked).toHaveLength(0);
    expect(
      useWorkspacesStore.getState().workspaces.map((w) => w.id),
    ).not.toContain(api.id);
    confirms.restore();
  });

  it("asks first when a pane is still running, and obeys a no", async () => {
    const api = seedWorkspace("api", 2);
    seed(api, seedWorkspace("ui", 1));
    const [firstPane] = Object.values(useTerminalsStore.getState().byId);
    act(() => useTerminalsStore.getState().setStatus(firstPane!.id, "running"));
    const confirms = answerConfirmsWith(false);
    render(<WorkspaceList />);

    fireEvent.click(screen.getByRole("button", { name: "Close api" }));

    await waitFor(() => expect(confirms.asked).toHaveLength(1));
    expect(useWorkspacesStore.getState().workspaces.map((w) => w.id)).toContain(
      api.id,
    );
    confirms.restore();
  });

  it("asks first even when the layout has not been derived yet", async () => {
    // The gate used to read the tree, so a workspace with running agents and
    // no tree closed in silence — killing them without the question the
    // confirm exists to ask.
    const api = beforeLayout(seedWorkspace("api", 2));
    seed(api, seedWorkspace("ui", 1));
    const [firstPane] = Object.values(useTerminalsStore.getState().byId);
    act(() => useTerminalsStore.getState().setStatus(firstPane!.id, "running"));
    const confirms = answerConfirmsWith(false);
    render(<WorkspaceList />);

    fireEvent.click(screen.getByRole("button", { name: "Close api" }));

    await waitFor(() =>
      expect(confirms.asked[0]?.message).toContain("1 pane is still running"),
    );
    expect(useWorkspacesStore.getState().workspaces.map((w) => w.id)).toContain(
      api.id,
    );
    confirms.restore();
  });

  it("does not switch to the workspace it is closing", () => {
    const api = seedWorkspace("api", 1);
    const ui = seedWorkspace("ui", 1);
    seed(api, ui);
    useWorkspacesStore.setState({ activeWorkspaceId: ui.id });
    render(<WorkspaceList />);

    fireEvent.click(screen.getByRole("button", { name: "Close api" }));

    expect(useWorkspacesStore.getState().activeWorkspaceId).toBe(ui.id);
  });
});

describe("reordering", () => {
  /** jsdom has no drag-and-drop, so the DataTransfer is the test's. */
  function dataTransfer() {
    const store = new Map<string, string>();
    return {
      effectAllowed: "",
      dropEffect: "",
      setData: (type: string, value: string) => store.set(type, value),
      getData: (type: string) => store.get(type) ?? "",
    };
  }

  const ROW_H = 36;

  /** jsdom lays nothing out, so every rect is zero and every midpoint test
   *  would answer the same way. Give the rows the geometry the sidebar gives
   *  them: 36px tall, stacked. */
  function layOutRows() {
    rows().forEach((row, i) => {
      row.getBoundingClientRect = () =>
        ({
          top: i * ROW_H,
          bottom: (i + 1) * ROW_H,
          height: ROW_H,
          left: 0,
          right: 200,
          width: 200,
          x: 0,
          y: i * ROW_H,
          toJSON: () => ({}),
        }) as DOMRect;
    });
  }

  /** A y inside row `index`, in its top or bottom half. */
  const upper = (index: number) => index * ROW_H + 4;
  const lower = (index: number) => index * ROW_H + ROW_H - 4;

  /** A drag event carrying BOTH a payload and a pointer position.
   *
   *  `fireEvent.dragOver` cannot: jsdom has no `DragEvent`, so
   *  testing-library falls back to plain `Event` and every mouse field —
   *  `clientY` included — is dropped on the floor. A `MouseEvent` keeps the
   *  coordinates, and the payload goes on by hand. */
  function fireDrag(
    type: "dragover" | "drop",
    el: HTMLElement,
    dt: ReturnType<typeof dataTransfer>,
    clientY: number,
  ) {
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientY,
    });
    Object.defineProperty(event, "dataTransfer", { value: dt });
    fireEvent(el, event);
  }

  /** Pick row `from` up and drop it at `clientY`, over row `onto`. */
  function drag(from: number, onto: number, clientY: number) {
    const dt = dataTransfer();
    layOutRows();
    fireEvent.dragStart(rows()[from]!, { dataTransfer: dt });
    fireDrag("dragover", rows()[onto]!, dt, clientY);
    return {
      edgeShown: rows()[onto]!.getAttribute("data-drop-edge"),
      drop: () => fireDrag("drop", rows()[onto]!, dt, clientY),
    };
  }

  const three = () => [
    seedWorkspace("a", 1),
    seedWorkspace("b", 1),
    seedWorkspace("c", 1),
  ];

  it("drops above the row whose top half was aimed at, dragging down", () => {
    seed(...three());
    render(<WorkspaceList />);

    const d = drag(0, 2, upper(2));
    expect(d.edgeShown).toBe("before");
    d.drop();

    expect(order()).toEqual(["b", "a", "c"]);
  });

  it("drops above the row whose top half was aimed at, dragging up", () => {
    seed(...three());
    render(<WorkspaceList />);

    const d = drag(2, 0, upper(0));
    expect(d.edgeShown).toBe("before");
    d.drop();

    expect(order()).toEqual(["c", "a", "b"]);
  });

  it("puts the row in the same place from either direction", () => {
    // The bug the line replaces: dropping ON a row used to mean "after it"
    // going down and "before it" going up, while the ring said the same thing
    // both times. Same visual target, same outcome — a lands directly above b
    // whether it came from above or below.
    seed(...three());
    const { unmount } = render(<WorkspaceList />);
    drag(2, 1, upper(1)).drop();
    expect(order()).toEqual(["a", "c", "b"]);
    unmount();

    seed(...three());
    render(<WorkspaceList />);
    drag(0, 1, upper(1)).drop();
    // `a` was already directly above `b`: the same slot, so nothing moves.
    expect(order()).toEqual(["a", "b", "c"]);
  });

  it("drops below the row whose bottom half was aimed at", () => {
    seed(...three());
    render(<WorkspaceList />);

    const d = drag(0, 1, lower(1));
    expect(d.edgeShown).toBe("after");
    d.drop();

    expect(order()).toEqual(["b", "a", "c"]);
  });

  it("draws no line where the drop would not move the row", () => {
    seed(...three());
    render(<WorkspaceList />);

    expect(drag(1, 1, upper(1)).edgeShown).toBeNull();
    expect(drag(1, 0, lower(0)).edgeShown).toBeNull();
    expect(drag(1, 2, upper(2)).edgeShown).toBeNull();
  });

  it("ignores a drop on the row that was picked up", () => {
    seed(...three());
    render(<WorkspaceList />);

    drag(0, 0, lower(0)).drop();

    expect(order()).toEqual(["a", "b", "c"]);
  });

  it("clears the line when the drag ends without a drop", () => {
    seed(...three());
    render(<WorkspaceList />);

    const d = drag(0, 2, upper(2));
    expect(d.edgeShown).toBe("before");
    fireEvent.dragEnd(rows()[0]!);

    expect(rows()[2]!.getAttribute("data-drop-edge")).toBeNull();
    expect(order()).toEqual(["a", "b", "c"]);
  });
});

describe("accent", () => {
  const openPicker = () => fireEvent.contextMenu(rows()[0]!);
  const swatch = (name: string) => screen.getByRole("menuitemradio", { name });

  it("offers the six accents on right-click and applies the pick", () => {
    const api = seedWorkspace("api", 1);
    seed(api);
    render(<WorkspaceList />);

    openPicker();
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(6);
    expect(swatch("Violet")).toHaveAttribute("aria-checked", "true");

    fireEvent.click(swatch("Cyan"));

    expect(
      useWorkspacesStore.getState().workspaces.find((w) => w.id === api.id)
        ?.accent,
    ).toBe("cyan");
    expect(screen.queryByRole("menuitemradio")).toBeNull();
  });

  it("puts the keyboard on the accent the workspace already has", () => {
    seed(seedWorkspace("api", 1, "cyan"));
    render(<WorkspaceList />);

    openPicker();

    expect(swatch("Cyan")).toHaveFocus();
  });

  it("closes on Escape pressed inside the menu", () => {
    // The menu is not inside the row, and the swatches hold the keyboard while
    // it is open — so a handler on the row never hears this key. Escape used
    // to work from the one place the user could not be.
    seed(seedWorkspace("api", 1));
    render(<WorkspaceList />);
    openPicker();

    fireEvent.keyDown(swatch("Violet"), { key: "Escape" });

    expect(screen.queryByRole("menuitemradio")).toBeNull();
    expect(rows()[0]).toHaveFocus();
  });

  it("closes on a press outside it", () => {
    seed(seedWorkspace("api", 1));
    render(<WorkspaceList />);
    openPicker();

    fireEvent.mouseDown(document.body);

    expect(screen.queryByRole("menuitemradio")).toBeNull();
  });

  it("stays open for a press on its own swatches", () => {
    seed(seedWorkspace("api", 1));
    render(<WorkspaceList />);
    openPicker();

    fireEvent.mouseDown(swatch("Rose"));

    expect(screen.getAllByRole("menuitemradio")).toHaveLength(6);
  });

  it("closes on a second right-click on the row", () => {
    seed(seedWorkspace("api", 1));
    render(<WorkspaceList />);
    openPicker();

    openPicker();

    expect(screen.queryByRole("menuitemradio")).toBeNull();
  });

  it("keeps the menu out of the tablist, which owns tabs and nothing else", () => {
    seed(seedWorkspace("api", 1), seedWorkspace("ui", 1));
    render(<WorkspaceList />);
    openPicker();

    const tablist = screen.getByRole("tablist");
    expect(within(tablist).queryByRole("menu")).toBeNull();
    expect([...tablist.children].map((el) => el.getAttribute("role"))).toEqual([
      "tab",
      "tab",
    ]);
  });
});
