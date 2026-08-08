/** ⌘T, ⌘⇧S, ⌘⇧P and ⌘1-9, and the empty state that tells the user about the
 *  first one. */

import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useUIStore, useWorkspacesStore } from "@/stores";
import { WorkspaceEmptyState } from "@/views/Workspaces/WorkspaceEmptyState";
import { useWorkspaceShortcuts } from "@/views/Workspaces/useWorkspaceShortcuts";
import type { Workspace } from "@/lib/bindings";

function workspace(id: string): Workspace {
  return {
    id,
    name: id,
    accent: "violet",
    projectPath: `/code/${id}`,
    paneTree: null,
    focusedTerminalId: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

/** Host for the hook — the listener is on the document, so nothing needs to
 *  be rendered for it to fire. */
function Host() {
  useWorkspaceShortcuts();
  return null;
}

const press = (key: string, init: KeyboardEventInit = {}) =>
  fireEvent.keyDown(document, { key, metaKey: true, ...init });

const activeId = () => useWorkspacesStore.getState().activeWorkspaceId;

beforeEach(() => {
  useWorkspacesStore.setState({
    workspaces: [workspace("a"), workspace("b"), workspace("c")],
    activeWorkspaceId: "a",
  });
  useUIStore.setState({
    isWorkspaceModalOpen: false,
    isSaveSessionModalOpen: false,
    isSettingsOpen: false,
    mainView: "terminals",
  });
});

describe("⌘T", () => {
  it("opens the new-workspace modal", () => {
    render(<Host />);

    press("t");

    expect(useUIStore.getState().isWorkspaceModalOpen).toBe(true);
  });

  it("stands down inside a text field", () => {
    render(<Host />);
    const field = document.createElement("input");
    document.body.appendChild(field);
    field.focus();

    press("t");

    expect(useUIStore.getState().isWorkspaceModalOpen).toBe(false);
    field.remove();
  });

  it("stands down while Settings is open", () => {
    useUIStore.setState({ isSettingsOpen: true });
    render(<Host />);

    press("t");

    expect(useUIStore.getState().isWorkspaceModalOpen).toBe(false);
  });

  it("ignores Ctrl-T — that key belongs to the shell in the pane", () => {
    render(<Host />);

    fireEvent.keyDown(document, { key: "t", ctrlKey: true });

    expect(useUIStore.getState().isWorkspaceModalOpen).toBe(false);
  });
});

describe("⌘⇧S", () => {
  it("opens the save-session prompt", () => {
    render(<Host />);

    press("s", { shiftKey: true });

    expect(useUIStore.getState().isSaveSessionModalOpen).toBe(true);
  });

  it("is not ⌘S — a bare ⌘S is nobody's chord here", () => {
    render(<Host />);

    press("s");

    expect(useUIStore.getState().isSaveSessionModalOpen).toBe(false);
  });

  it("stands down while a modal is already up", () => {
    useUIStore.setState({ isSaveSessionModalOpen: true });
    render(<Host />);

    press("t");

    expect(useUIStore.getState().isWorkspaceModalOpen).toBe(false);
  });
});

describe("⌘⇧P", () => {
  const mainView = () => useUIStore.getState().mainView;

  it("toggles the board and comes back", () => {
    render(<Host />);

    press("p", { shiftKey: true });
    expect(mainView()).toBe("rocplan");

    press("p", { shiftKey: true });
    expect(mainView()).toBe("terminals");
  });

  it("is not ⌘P — that one is reserved for quick-open", () => {
    // Claiming it now would teach the chord for two phases and then move it.
    render(<Host />);

    press("p");

    expect(mainView()).toBe("terminals");
  });

  it("stands down while a modal is up", () => {
    useUIStore.setState({ isSettingsOpen: true });
    render(<Host />);

    press("p", { shiftKey: true });

    expect(mainView()).toBe("terminals");
  });

  it("does not open a board for a workspace that does not exist", () => {
    // The empty state is up: there is no project to plan against, and flipping
    // to a view nobody can see would be a chord that appears to do nothing and
    // then surprises the user on their first workspace.
    useWorkspacesStore.setState({ workspaces: [], activeWorkspaceId: null });
    render(<Host />);

    press("p", { shiftKey: true });

    expect(mainView()).toBe("terminals");
  });

  it("comes back from a board even with no workspaces left", () => {
    // Only the opening direction is refused. Closing the last workspace while
    // the board was up used to leave the chord refusing both ways — a room
    // with no door out, on the one surface that has no other exit.
    useWorkspacesStore.setState({ workspaces: [], activeWorkspaceId: null });
    useUIStore.setState({ mainView: "rocplan" });
    render(<Host />);

    press("p", { shiftKey: true });

    expect(mainView()).toBe("terminals");
  });
});

describe("⌘1-9", () => {
  it("switches to the workspace at that position in the sidebar", () => {
    render(<Host />);

    press("2");

    expect(activeId()).toBe("b");
  });

  it("does nothing for a digit past the end", () => {
    // Landing on the last workspace instead would answer a miss with a switch
    // the user did not ask for.
    render(<Host />);

    press("7");

    expect(activeId()).toBe("a");
  });

  it("stands down while the modal is up", () => {
    useUIStore.setState({ isWorkspaceModalOpen: true });
    render(<Host />);

    press("3");

    expect(activeId()).toBe("a");
  });

  it("lets go of the document when it unmounts", () => {
    const { unmount } = render(<Host />);
    unmount();

    press("2");

    expect(activeId()).toBe("a");
  });
});

describe("the empty state", () => {
  it("names the chord and offers a button for it", () => {
    render(<WorkspaceEmptyState />);

    expect(screen.getByText("No workspaces")).toBeInTheDocument();
    expect(screen.getByText("⌘T")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /New workspace/ }));

    expect(useUIStore.getState().isWorkspaceModalOpen).toBe(true);
  });
});
