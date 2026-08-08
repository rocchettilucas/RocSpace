/** What the dropdown says about each kind.
 *
 *  The chip and the sentence come from `Record`s over `NotificationKind`, so a
 *  kind that is added and not described fails to compile. What a `Record`
 *  cannot check is whether the words are the right ones — "finished" and
 *  "exited" are two different events and the list has to tell them apart. */

import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { newTerminal } from "@/lib/factories";
import { useNotificationsStore } from "@/stores/notifications";
import { useTerminalsStore } from "@/stores/terminals";
import { useUIStore } from "@/stores/ui";
import { useWorkspacesStore } from "@/stores/workspaces";
import { newWorkspace } from "@/lib/factories";
import { NotificationBell } from "@/views/Topbar/NotificationBell";
import type { NotificationKind } from "@/stores/notifications";

function seed(kind: NotificationKind) {
  const terminal = newTerminal({
    workspaceId: "w1",
    name: "Rocky",
    agentType: "claude-code",
    projectPath: "/tmp/proj",
  });
  useTerminalsStore.getState().setTerminals([terminal]);
  useNotificationsStore.getState().push({
    terminalId: terminal.id,
    terminalName: terminal.name,
    agentType: "claude-code",
    kind,
  });
}

function openBell() {
  render(<NotificationBell />);
  fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
}

describe("NotificationBell", () => {
  beforeEach(() => {
    useNotificationsStore.setState({ items: [] });
    useTerminalsStore.setState({ byId: {} });
    useWorkspacesStore.setState({ workspaces: [], activeWorkspaceId: null });
    useUIStore.setState({
      focusedTerminalId: null,
      highlightedTerminalId: null,
      maximizedTerminalId: null,
      mainView: "terminals",
    });
  });

  it("says a turn ended, not that the process did", () => {
    seed("turn-finished");
    openBell();

    expect(screen.getByText("Finished")).toBeInTheDocument();
    expect(screen.getByText(/finished its turn/)).toBeInTheDocument();
  });

  it("still distinguishes a process that exited", () => {
    seed("complete");
    openBell();

    expect(screen.getByText("Complete")).toBeInTheDocument();
    expect(screen.queryByText(/its turn/)).toBeNull();
  });

  // A notification is read while looking at something else — that is what makes
  // it a notification. Clicking one has to actually arrive at the pane, which
  // means the workspace it lives in, the dock rather than the board, and out of
  // any full-screen holding a different pane.
  it("takes you to the pane's workspace, out of the board, and highlights it", () => {
    const other = newWorkspace({
      name: "Other",
      projectPath: "/tmp/a",
      order: 0,
    });
    const home = newWorkspace({
      name: "Home",
      projectPath: "/tmp/b",
      order: 1,
    });
    const pane = newTerminal({
      workspaceId: home.id,
      name: "Roxie",
      agentType: "claude-code",
      projectPath: "/tmp/b",
    });
    const decoy = newTerminal({
      workspaceId: other.id,
      name: "Rocky",
      agentType: "claude-code",
      projectPath: "/tmp/a",
    });
    useWorkspacesStore.setState({
      workspaces: [other, home],
      activeWorkspaceId: other.id,
    });
    useTerminalsStore.getState().setTerminals([pane, decoy]);
    // Reading the board, with the other workspace's pane held full-screen.
    useUIStore.setState({ mainView: "rocplan", maximizedTerminalId: decoy.id });
    useNotificationsStore.getState().push({
      terminalId: pane.id,
      terminalName: pane.name,
      agentType: "claude-code",
      kind: "turn-finished",
    });

    openBell();
    fireEvent.click(screen.getByText(/finished its turn/));

    const ui = useUIStore.getState();
    expect(useWorkspacesStore.getState().activeWorkspaceId).toBe(home.id);
    expect(ui.mainView).toBe("terminals");
    expect(ui.maximizedTerminalId).toBeNull();
    expect(ui.focusedTerminalId).toBe(pane.id);
    expect(ui.highlightedTerminalId).toBe(pane.id);
    // …and the workspace we left still remembers its OWN pane, not this one.
    const left = useWorkspacesStore
      .getState()
      .workspaces.find((w) => w.id === other.id);
    expect(left?.focusedTerminalId).not.toBe(pane.id);
  });
});
