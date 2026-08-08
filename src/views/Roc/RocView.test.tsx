/** The Roc view's own shell: the three regions it composes, the way out, and
 *  what it does with the split it finds on disk.
 *
 *  A file with this name existed before and tested the sessions rail — so the
 *  view itself, the one surface the whole workstream opens into, had never been
 *  rendered by a test at all. The rail's tests are in `sessionsRail.test.tsx`.
 *
 *  The persisted layout is the part worth being careful with. `rocViewLayout`
 *  is read at MOUNT as `defaultLayout` and comes off disk, which means it can
 *  be anything a previous version of this view (or a truncated save) left
 *  behind: panel ids that no longer exist, percentages that do not add up, a
 *  key with nothing under it. None of that may cost the user the view. */

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("@/lib/bindings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/bindings")>()),
  commands: {
    roctalkDownloadModel: vi.fn(async () => {}),
    terminalWrite: vi.fn(async () => {}),
  },
}));

import { newTerminal, newWorkspace } from "@/lib/factories";
import { useEditorStore } from "@/stores/editor";
import { useRocStore } from "@/stores/roc";
import { useRocTalkStore } from "@/stores/roctalk";
import { useTerminalsStore } from "@/stores/terminals";
import { useUIStore } from "@/stores/ui";
import { useWorkspacesStore } from "@/stores/workspaces";
import { RocView } from "@/views/Roc/RocView";

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

function seed() {
  const workspace = newWorkspace({ projectPath: "/proj", order: 0 });
  const rocky = newTerminal({
    workspaceId: workspace.id,
    name: "Rocky",
    agentType: "shell",
    projectPath: "/proj",
  });
  useTerminalsStore.getState().setTerminals([rocky]);
  useWorkspacesStore.setState({
    workspaces: [
      { ...workspace, paneTree: { kind: "leaf", terminalId: rocky.id } },
    ],
    activeWorkspaceId: workspace.id,
  });
  return { workspace, rocky };
}

/** The three regions, by the names a screen reader would read out. */
const regions = () => ({
  rail: screen.queryByLabelText("Sessions"),
  stage: screen.queryByLabelText("Roc"),
  live: screen.queryByLabelText("Live terminal"),
});

beforeEach(() => {
  vi.clearAllMocks();
  useWorkspacesStore.setState({ workspaces: [], activeWorkspaceId: null });
  useTerminalsStore.setState({ byId: {} });
  useUIStore.setState({ mainView: "roc", focusedTerminalId: null });
  useRocStore.setState({
    phase: "idle",
    expanded: true,
    transcript: "",
    selectedTerminalIds: [],
    focusedRailTerminalId: null,
    log: [],
  });
  useRocTalkStore.setState({
    enabled: true,
    status: "idle",
    modelStatus: "ready",
  });
  useEditorStore.setState({ rocViewLayout: null });
});

describe("RocView", () => {
  it("puts all three regions on screen at once", () => {
    seed();
    render(<RocView />);

    const { rail, stage, live } = regions();
    expect(rail).toBeInTheDocument();
    expect(stage).toBeInTheDocument();
    expect(live).toBeInTheDocument();
    // The rail lists the panes, the stage takes the message, and the live
    // panel is waiting to be pointed at one.
    expect(screen.getByTitle("Watch Rocky")).toBeInTheDocument();
    expect(
      screen.getByLabelText("Message for your agents"),
    ).toBeInTheDocument();
    expect(screen.getByText(/pick a session on the left/i)).toBeInTheDocument();
  });

  // The rail's focus is what the live panel is for; this is the wiring between
  // two regions that nothing else covers.
  it("shows the session the rail has focused", () => {
    const { rocky } = seed();
    useRocStore.setState({ focusedRailTerminalId: rocky.id });
    render(<RocView />);

    expect(screen.getByLabelText("Live terminal")).toHaveTextContent("Rocky");
  });

  // The only way back to the terminals other than the chord.
  it("gives the dock back when the header's button is pressed", () => {
    seed();
    render(<RocView />);

    fireEvent.click(screen.getByLabelText("Back to terminals"));

    expect(useUIStore.getState().mainView).toBe("terminals");
    expect(useRocStore.getState().expanded).toBe(false);
  });
});

describe("the split it finds on disk", () => {
  it("opens on the persisted layout when there is one", () => {
    seed();
    useEditorStore.setState({
      rocViewLayout: { "roc-rail": 30, "roc-stage": 40, "roc-live": 30 },
    });

    expect(() => render(<RocView />)).not.toThrow();
    const { rail, stage, live } = regions();
    expect(rail).toBeInTheDocument();
    expect(stage).toBeInTheDocument();
    expect(live).toBeInTheDocument();
  });

  // Everything here is bytes off somebody's disk, written by a version of this
  // view that may not have had these panels. A layout that cannot be applied
  // has to fall back to the defaults, not take the view down — the user would
  // have no way to fix it from inside the app.
  it.each([
    ["a layout naming panels that no longer exist", { "roc-editor": 100 }],
    [
      "a layout that has lost a panel",
      { "roc-rail": 50, "roc-stage": 50 } as Record<string, number>,
    ],
    ["percentages that do not add up", { "roc-rail": 5, "roc-stage": 5 }],
    ["an empty record", {}],
    [
      "numbers that are not numbers",
      {
        "roc-rail": Number.NaN,
        "roc-stage": Number.POSITIVE_INFINITY,
        "roc-live": -40,
      },
    ],
    [
      "junk under the right keys",
      {
        "roc-rail": "22%",
        "roc-stage": null,
        "roc-live": undefined,
      } as unknown as Record<string, number>,
    ],
  ])("survives %s", (_label, layout) => {
    seed();
    useEditorStore.setState({ rocViewLayout: layout });

    expect(() => render(<RocView />)).not.toThrow();
    const { rail, stage, live } = regions();
    expect(rail).toBeInTheDocument();
    expect(stage).toBeInTheDocument();
    expect(live).toBeInTheDocument();
  });
});
