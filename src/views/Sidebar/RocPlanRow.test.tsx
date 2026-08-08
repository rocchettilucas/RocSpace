/** The sidebar's way into the board — and the question it has to answer the
 *  same way ⌘⇧P does. */

import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { newWorkspace } from "@/lib/factories";
import { useUIStore } from "@/stores/ui";
import { useWorkspacesStore } from "@/stores/workspaces";
import { RocPlanRow } from "@/views/Sidebar/RocPlanRow";

const row = () => screen.getByRole("button", { name: /RocPlan/ });
const mainView = () => useUIStore.getState().mainView;

function seedWorkspace() {
  const workspace = newWorkspace({
    name: "rocspace",
    projectPath: "/code/rocspace",
    order: 0,
  });
  useWorkspacesStore.setState({
    workspaces: [workspace],
    activeWorkspaceId: workspace.id,
  });
}

beforeEach(() => {
  useUIStore.setState({ mainView: "terminals" });
  useWorkspacesStore.setState({ workspaces: [], activeWorkspaceId: null });
});

describe("the RocPlan row", () => {
  it("swaps the main area to the board and back", () => {
    seedWorkspace();
    render(<RocPlanRow />);

    fireEvent.click(row());
    expect(mainView()).toBe("rocplan");
    expect(row()).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(row());
    expect(mainView()).toBe("terminals");
  });

  it("refuses to open a board with no workspace to plan against", () => {
    // ⌘⇧P already refused this: the board lives in a project directory, and
    // there is no project. The row opened it anyway, so the app had two entry
    // points disagreeing about whether the thing exists — and the one that
    // worked landed the user on an empty state the chord could not undo.
    render(<RocPlanRow />);

    expect(row()).toBeDisabled();
    fireEvent.click(row());

    expect(mainView()).toBe("terminals");
  });

  it("always offers the way back out", () => {
    // The last workspace closing while the board is up must not leave the user
    // in a room with no door.
    useUIStore.setState({ mainView: "rocplan" });
    render(<RocPlanRow />);

    expect(row()).toBeEnabled();
    fireEvent.click(row());

    expect(mainView()).toBe("terminals");
  });
});
