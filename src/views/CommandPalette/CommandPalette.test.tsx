/** The palette surface: what it shows, how the keyboard drives it, and the two
 *  rules that make ⌘K safe to press from anywhere. */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { renderHook } from "@testing-library/react";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import {
  registerCommands,
  resetCommandRegistry,
  type CommandAction,
} from "@/lib/commands/registry";
import { newTerminal, newWorkspace } from "@/lib/factories";
import { LIMITS } from "@/lib/limits";
import { answerConfirmsWith } from "@/test/confirm";
import { useEditorStore } from "@/stores/editor";
import { isBoardFollowed, resetRocPlanModuleState } from "@/stores/rocplan";
import { useTerminalsStore } from "@/stores/terminals";
import { DEFAULT_VOICE_SETTINGS, useSettingsStore } from "@/stores/settings";
import { arePaneChordsBlocked, isAnyBlockingModalOpen } from "@/stores/ui";
import { useUIStore } from "@/stores/ui";
import { useWorkspacesStore } from "@/stores/workspaces";
import {
  CommandPalette,
  CommandPaletteDialog,
} from "@/views/CommandPalette/CommandPalette";
import { useCommandPaletteShortcut } from "@/views/CommandPalette/useCommandPaletteShortcut";

const action = (
  id: string,
  title: string,
  extra: Partial<CommandAction> = {},
): CommandAction => ({
  id,
  title,
  group: "Workspace",
  run: () => {},
  ...extra,
});

const search = () => screen.getByRole("combobox") as HTMLInputElement;
const optionTitles = () =>
  screen.queryAllByRole("option").map((el) => el.textContent);
const selected = () =>
  screen.queryAllByRole("option").find((el) => el.ariaSelected === "true")
    ?.textContent ?? null;

/** ⌘K, on the document, the way the capture-phase listener hears it. */
const pressMetaK = (target: Document | Element = document) =>
  fireEvent.keyDown(target, { key: "k", metaKey: true });

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(null);
  resetCommandRegistry();
  resetRocPlanModuleState();
  useWorkspacesStore.setState({ workspaces: [], activeWorkspaceId: null });
  useTerminalsStore.setState({ byId: {} });
  useEditorStore.setState({
    rightDockMode: "inspector",
    rightPanelCollapsed: false,
  });
  useSettingsStore.setState({ voice: { ...DEFAULT_VOICE_SETTINGS } });
  useUIStore.setState({
    isCommandPaletteOpen: false,
    isSettingsOpen: false,
    isWorkspaceModalOpen: false,
    isSaveSessionModalOpen: false,
    taskEditor: null,
    mainView: "terminals",
    focusedTerminalId: null,
    maximizedTerminalId: null,
  });
});

describe("CommandPaletteDialog", () => {
  it("groups commands under their headings, in the union's order", () => {
    registerCommands([
      action("s", "Open Settings", { group: "Settings" }),
      action("w", "New workspace…"),
      action("p", "New pane", { group: "Panes" }),
    ]);
    render(<CommandPaletteDialog />);

    // Workspace before Panes before Settings — COMMAND_GROUPS order, not the
    // order they were registered in.
    expect(optionTitles()).toEqual([
      "New workspace…",
      "New pane",
      "Open Settings",
    ]);
    expect(screen.getByRole("group", { name: "Panes" })).toBeInTheDocument();
  });

  // The rule that makes the list trustworthy: a snapshot, not a live view.
  it("asks enabled() once, on open, and hides what says no", () => {
    const enabled = vi.fn(() => false);
    registerCommands([
      action("hidden", "Cannot do this", { enabled }),
      action("shown", "Can do this"),
    ]);
    render(<CommandPaletteDialog />);

    expect(optionTitles()).toEqual(["Can do this"]);
    expect(enabled).toHaveBeenCalledTimes(1);

    // Re-filtering must not re-ask: the answer could change under a cursor the
    // user is already moving.
    fireEvent.change(search(), { target: { value: "can" } });
    expect(enabled).toHaveBeenCalledTimes(1);
  });

  it("filters as you type and says so when nothing matches", () => {
    registerCommands([action("a", "New workspace…"), action("b", "Show Roc")]);
    render(<CommandPaletteDialog />);

    fireEvent.change(search(), { target: { value: "nw" } });
    expect(optionTitles()).toEqual(["New workspace…"]);

    fireEvent.change(search(), { target: { value: "zzzz" } });
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText(/No command matches/)).toBeInTheDocument();
  });

  it("shows the shortcut badge a command declares", () => {
    registerCommands([action("a", "New workspace…", { shortcut: "⌘T" })]);
    render(<CommandPaletteDialog />);
    expect(screen.getByText("⌘T")).toBeInTheDocument();
  });

  it("arrows walk the list in the order it is rendered, and wrap", () => {
    registerCommands([
      action("s", "Open Settings", { group: "Settings" }),
      action("w", "New workspace…"),
    ]);
    render(<CommandPaletteDialog />);

    expect(selected()).toBe("New workspace…");
    fireEvent.keyDown(search(), { key: "ArrowDown" });
    expect(selected()).toBe("Open Settings");
    fireEvent.keyDown(search(), { key: "ArrowDown" });
    expect(selected()).toBe("New workspace…");
    fireEvent.keyDown(search(), { key: "ArrowUp" });
    expect(selected()).toBe("Open Settings");
  });

  it("puts the highlight back on the first row when the query changes", () => {
    registerCommands([action("a", "Alpha"), action("b", "Beta")]);
    render(<CommandPaletteDialog />);

    fireEvent.keyDown(search(), { key: "ArrowDown" });
    expect(selected()).toBe("Beta");
    fireEvent.change(search(), { target: { value: "a" } });
    expect(selected()).toBe("Alpha");
  });

  it("Enter runs the highlighted command and closes", () => {
    const run = vi.fn();
    useUIStore.setState({ isCommandPaletteOpen: true });
    registerCommands([action("a", "Alpha"), action("b", "Beta", { run })]);
    render(<CommandPaletteDialog />);

    fireEvent.keyDown(search(), { key: "ArrowDown" });
    fireEvent.keyDown(search(), { key: "Enter" });

    expect(run).toHaveBeenCalledTimes(1);
    expect(useUIStore.getState().isCommandPaletteOpen).toBe(false);
  });

  it("Enter with nothing matching runs nothing", () => {
    const run = vi.fn();
    useUIStore.setState({ isCommandPaletteOpen: true });
    registerCommands([action("a", "Alpha", { run })]);
    render(<CommandPaletteDialog />);

    fireEvent.change(search(), { target: { value: "zzz" } });
    fireEvent.keyDown(search(), { key: "Enter" });

    expect(run).not.toHaveBeenCalled();
    expect(useUIStore.getState().isCommandPaletteOpen).toBe(true);
  });

  it("clicking a row runs it", () => {
    const run = vi.fn();
    useUIStore.setState({ isCommandPaletteOpen: true });
    registerCommands([action("a", "Alpha", { run })]);
    render(<CommandPaletteDialog />);

    fireEvent.click(screen.getByRole("option", { name: "Alpha" }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(useUIStore.getState().isCommandPaletteOpen).toBe(false);
  });

  // The shell's document-level Escape stands down for text fields, and this
  // dialog IS its text field — so the input has to answer instead.
  it("Escape in the search box closes without running anything", () => {
    const run = vi.fn();
    useUIStore.setState({ isCommandPaletteOpen: true });
    registerCommands([action("a", "Alpha", { run })]);
    render(<CommandPaletteDialog />);

    fireEvent.keyDown(search(), { key: "Escape" });
    expect(run).not.toHaveBeenCalled();
    expect(useUIStore.getState().isCommandPaletteOpen).toBe(false);
  });
});

/** Mount the gate closed, then open it — which is the only order that ever
 *  happens: the built-ins are registered by the gate's effect, and effects run
 *  after the subtree renders, so a palette that mounted already-open would read
 *  an empty registry. Nothing can open it before it is mounted. */
function openPalette() {
  render(<CommandPalette />);
  act(() => {
    useUIStore.getState().openCommandPalette();
  });
}

/** One workspace with one pane IN ITS TREE.
 *
 *  The tree is what "Launch every pane" and "Stop every pane" count, so a
 *  workspace without one hides them for a reason that has nothing to do with
 *  which surface has the main area — and a test built on that would pass with
 *  the guard removed. */
/** A row by the ID of the command behind it rather than by its label.
 *
 *  These assertions are about specific `enabled()` guards, and labels are a bad
 *  handle for that: "Show Roc" is a prefix of "Show RocMind", and every row's
 *  accessible name also carries its shortcut badge. */
const row = (commandId: string): HTMLElement | null =>
  document.getElementById(`command-option-${commandId}`);

function seedWorkspaceWithPane() {
  const workspace = newWorkspace({ projectPath: "/a", order: 0 });
  useWorkspacesStore.setState({
    workspaces: [
      { ...workspace, paneTree: { kind: "leaf", terminalId: "t1" } },
    ],
    activeWorkspaceId: workspace.id,
  });
}

describe("CommandPalette", () => {
  it("renders nothing while closed, and the built-ins once opened", () => {
    render(<CommandPalette />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    act(() => {
      useUIStore.getState().openCommandPalette();
    });
    // Seeded from the built-ins — the chord's own action is in there.
    expect(
      screen.getByRole("option", { name: /New workspace/ }),
    ).toBeInTheDocument();
  });

  it("offers one switch action per workspace, never the one you are in", () => {
    const alpha = newWorkspace({ name: "alpha", projectPath: "/a", order: 0 });
    const beta = newWorkspace({ name: "beta", projectPath: "/b", order: 1 });
    useWorkspacesStore.setState({
      workspaces: [alpha, beta],
      activeWorkspaceId: alpha.id,
    });
    openPalette();

    expect(screen.getByRole("option", { name: "Switch to beta" })).toBeTruthy();
    expect(
      screen.queryByRole("option", { name: "Switch to alpha" }),
    ).not.toBeInTheDocument();
  });

  // The WHOLE group, not one row of it. "Stop every pane in this workspace"
  // was the row that lacked the guard, and a test that only asked about "New
  // pane" passed while ⌘K → "stop" → Enter killed every agent in the workspace
  // from a board that shows none of them.
  it.each(["rocplan", "roc"] as const)(
    "hides every pane action while %s has the main area",
    (mainView) => {
      seedWorkspaceWithPane();
      useUIStore.setState({ mainView, focusedTerminalId: "t1" });
      openPalette();

      expect(screen.queryByRole("group", { name: "Panes" })).toBeNull();
      // `\b` so "Hide the side panel" — an Editor action, still legitimately
      // on offer here — is not read as a pane action.
      expect(screen.queryByRole("option", { name: /\bpanes?\b/i })).toBeNull();
    },
  );

  it("offers the way back out of RocPlan instead", () => {
    seedWorkspaceWithPane();
    useUIStore.setState({ mainView: "rocplan" });
    openPalette();

    // A regex because a row's accessible name also carries its shortcut badge,
    // which is what a screen reader should hear.
    expect(
      screen.getByRole("option", { name: /Leave the RocPlan board/ }),
    ).toBeInTheDocument();
  });

  // The other half of the rule: on the terminals view those same two entries
  // ARE offered, so the test above is about the surface and not about a
  // workspace that happens to have no panes.
  it("offers the launch and stop actions on the terminals view", () => {
    seedWorkspaceWithPane();
    useUIStore.setState({ mainView: "terminals" });
    openPalette();

    expect(screen.getByRole("group", { name: "Panes" })).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: /Stop every pane/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: /Launch every pane/ }),
    ).toBeInTheDocument();
  });

  // Every other toggle in `builtins` is a pair whose two halves are each
  // other's negation, and the right panel's modes are no different: offering
  // "Show the Inspector" while the Inspector is on screen is a row that cannot
  // change anything the user can see.
  it("does not offer the panel mode that is already on screen", () => {
    // The panel lives in `AppShell`, which needs a workspace — see the empty
    // state's own test below.
    seedWorkspaceWithPane();
    useEditorStore.setState({
      rightDockMode: "inspector",
      rightPanelCollapsed: false,
    });
    openPalette();

    expect(
      screen.queryByRole("option", { name: "Show the Inspector" }),
    ).toBeNull();
    expect(
      screen.getByRole("option", { name: "Show the Browser" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "Show the Editor" }),
    ).toBeInTheDocument();
  });

  // …but it IS offered behind a collapsed panel, because running it is what
  // brings the panel back: `showPanel` expands as well as switching.
  it("offers the selected mode again while the panel is collapsed", () => {
    seedWorkspaceWithPane();
    useEditorStore.setState({
      rightDockMode: "inspector",
      rightPanelCollapsed: true,
    });
    openPalette();

    expect(
      screen.getByRole("option", { name: "Show the Inspector" }),
    ).toBeInTheDocument();
  });

  // The widget's mode switch, reachable without the widget — and a pair, so
  // only the one that would change something is ever on the list.
  it("offers the voice mode you are not in, and switches to it", () => {
    expect(useSettingsStore.getState().voice.routeTo).toBe("terminal");
    openPalette();

    expect(
      screen.queryByRole("option", { name: /Switch Roc to dictation/ }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("option", { name: /Switch Roc to conversation/ }),
    );

    expect(useSettingsStore.getState().voice.routeTo).toBe("roc");

    // Reopened rather than remounted: `enabled()` is asked at open time, and
    // the pair has to have swapped over by the next ⌘K.
    act(() => useUIStore.getState().openCommandPalette());
    expect(
      screen.getByRole("option", { name: /Switch Roc to dictation/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: /Switch Roc to conversation/ }),
    ).toBeNull();
  });

  // `App` renders `AppShell` only once there is a workspace and mounts the
  // palette OUTSIDE that gate, so ⌘K works from the empty state — which is
  // deliberate, because "New workspace" is the way out of it. What was not
  // deliberate is these ten: every one of them writes a store field whose only
  // reader is inside the shell, so from the empty state they ran, reported
  // success and changed nothing on screen.
  it("offers nothing the empty state has no surface for", () => {
    expect(useWorkspacesStore.getState().workspaces).toHaveLength(0);
    openPalette();

    for (const id of [
      "rocmind.open",
      "roc.open",
      "roc.hide-widget",
      "roc.show-widget",
      "panel.inspector",
      "panel.browser",
      "panel.editor",
      "panel.hide",
      "panel.show",
      "voice.enable",
      "voice.disable",
    ]) {
      expect(row(id)).toBeNull();
    }
    // …and the way out of the empty state still is.
    expect(row("workspace.new")).not.toBeNull();
  });

  // The split buttons in the pane header disable themselves at the cap and say
  // why in their tooltip. These two rows stayed live and did nothing: the
  // action `console.warn`ed and returned false, which is a broken row as far as
  // anybody looking at the palette is concerned.
  it("stops offering a new pane once the workspace is full", () => {
    const workspace = newWorkspace({ projectPath: "/a", order: 0 });
    const panes = Array.from({ length: LIMITS.terminalsPerWorkspace }, (_, i) =>
      newTerminal({
        workspaceId: workspace.id,
        name: `pane-${i}`,
        agentType: "claude-code",
        projectPath: "/a",
      }),
    );
    useWorkspacesStore.setState({
      workspaces: [
        { ...workspace, paneTree: { kind: "leaf", terminalId: panes[0]!.id } },
      ],
      activeWorkspaceId: workspace.id,
    });
    // One short of the cap.
    useTerminalsStore.setState({
      byId: Object.fromEntries(panes.slice(0, -1).map((t) => [t.id, t])),
    });
    openPalette();
    expect(row("pane.new")).not.toBeNull();
    expect(row("pane.split-down")).not.toBeNull();

    act(() => {
      const last = panes[panes.length - 1]!;
      useTerminalsStore.setState((s) => ({
        byId: { ...s.byId, [last.id]: last },
      }));
    });
    // `enabled()` is asked at open time, so the answer has to be re-asked —
    // and in two commits, or React never sees the palette close.
    act(() => useUIStore.getState().closeCommandPalette());
    act(() => useUIStore.getState().openCommandPalette());

    expect(row("pane.new")).toBeNull();
    expect(row("pane.split-down")).toBeNull();
    // The rows that do not add a pane are untouched.
    expect(row("pane.stop-all")).not.toBeNull();
  });

  // ⌘W confirms before killing one pane and "Close this workspace" confirms
  // before killing a workspace's worth. This row reached the same destruction
  // from ⌘K, "launch", Enter and asked nothing — `spawnTerminal` opens by
  // killing whatever is on the id.
  it("asks before relaunching panes that are still running", async () => {
    const workspace = newWorkspace({ projectPath: "/a", order: 0 });
    const pane = newTerminal({
      workspaceId: workspace.id,
      name: "Rocky",
      agentType: "claude-code",
      projectPath: "/a",
    });
    useWorkspacesStore.setState({
      workspaces: [
        { ...workspace, paneTree: { kind: "leaf", terminalId: pane.id } },
      ],
      activeWorkspaceId: workspace.id,
    });
    useTerminalsStore.setState({
      byId: { [pane.id]: { ...pane, status: "running" } },
    });
    const confirms = answerConfirmsWith(false);
    openPalette();

    fireEvent.click(screen.getByRole("option", { name: /Launch every pane/ }));

    await vi.waitFor(() => expect(confirms.asked).toHaveLength(1));
    expect(confirms.asked[0]!.title).toBe("Launch every pane");
    // Declined, so nothing was killed and nothing respawned.
    expect(invoke.mock.calls.some(([cmd]) => cmd === "terminal_spawn")).toBe(
      false,
    );
    confirms.restore();
  });

  // `TaskModal` is mounted app-wide, so this row happily opened its dialog over
  // the terminals — and then `createTask` refused, because `mutate` declines a
  // project the store is not following and nothing here had read one. The user
  // filled in a whole card, pressed Create, was told nothing was saved, and had
  // Cancel as the only way out: the draft went with it.
  it("reads the board before it opens the card editor", async () => {
    const project = "/code/rocspace";
    const workspace = newWorkspace({ projectPath: project, order: 0 });
    useWorkspacesStore.setState({
      workspaces: [workspace],
      activeWorkspaceId: workspace.id,
    });
    invoke.mockImplementation(async (cmd: unknown) =>
      cmd === "plan_read" ? [] : null,
    );
    openPalette();

    fireEvent.click(screen.getByRole("option", { name: /New RocPlan card/ }));

    await vi.waitFor(() =>
      expect(useUIStore.getState().taskEditor).toEqual({
        projectPath: project,
        taskId: null,
      }),
    );
    // The half that makes the dialog usable: a board the store is FOLLOWING is
    // the only kind a card can be written to.
    expect(isBoardFollowed(project)).toBe(true);
  });

  it("runs a built-in for real — Switch to beta changes the active workspace", () => {
    const alpha = newWorkspace({ name: "alpha", projectPath: "/a", order: 0 });
    const beta = newWorkspace({ name: "beta", projectPath: "/b", order: 1 });
    useWorkspacesStore.setState({
      workspaces: [alpha, beta],
      activeWorkspaceId: alpha.id,
    });
    openPalette();

    fireEvent.click(screen.getByRole("option", { name: "Switch to beta" }));
    expect(useWorkspacesStore.getState().activeWorkspaceId).toBe(beta.id);
    expect(useUIStore.getState().isCommandPaletteOpen).toBe(false);
  });
});

describe("useCommandPaletteShortcut", () => {
  it("⌘K opens it, and ⌘K again closes it", () => {
    renderHook(() => useCommandPaletteShortcut());

    pressMetaK();
    expect(useUIStore.getState().isCommandPaletteOpen).toBe(true);
    pressMetaK();
    expect(useUIStore.getState().isCommandPaletteOpen).toBe(false);
  });

  it("stands down inside a real text field", () => {
    renderHook(() => useCommandPaletteShortcut());
    const field = document.createElement("input");
    document.body.append(field);
    field.focus();

    pressMetaK(field);
    expect(useUIStore.getState().isCommandPaletteOpen).toBe(false);
    field.remove();
  });

  // A focused terminal is a <textarea>, and it is where the user spends the
  // whole session. Standing down there would make the chord dead in practice.
  it("fires from a focused terminal", () => {
    renderHook(() => useCommandPaletteShortcut());
    const sink = document.createElement("textarea");
    sink.className = "xterm-helper-textarea";
    document.body.append(sink);
    sink.focus();

    pressMetaK(sink);
    expect(useUIStore.getState().isCommandPaletteOpen).toBe(true);
    sink.remove();
  });

  it("does not open on top of another modal", () => {
    renderHook(() => useCommandPaletteShortcut());
    useUIStore.setState({ isSettingsOpen: true });

    pressMetaK();
    expect(useUIStore.getState().isCommandPaletteOpen).toBe(false);
  });

  // Closing has to work from the search box the palette opens focus into, or
  // the chord opens a box the same chord cannot dismiss.
  it("closes from inside its own search field", () => {
    renderHook(() => useCommandPaletteShortcut());
    useUIStore.setState({ isCommandPaletteOpen: true });
    const field = document.createElement("input");
    document.body.append(field);
    field.focus();

    pressMetaK(field);
    expect(useUIStore.getState().isCommandPaletteOpen).toBe(false);
    field.remove();
  });

  it("ignores ⌘⇧K and ⌃K", () => {
    renderHook(() => useCommandPaletteShortcut());

    fireEvent.keyDown(document, { key: "k", metaKey: true, shiftKey: true });
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    expect(useUIStore.getState().isCommandPaletteOpen).toBe(false);
  });
});

// A scrim stops the mouse, not the keyboard: the palette has to join the
// family every other chord asks about, or ⌘W closes a pane behind it.
describe("the palette counts as a blocking modal", () => {
  it("blocks the workspace chords and the pane chords while open", () => {
    expect(isAnyBlockingModalOpen()).toBe(false);
    expect(arePaneChordsBlocked()).toBe(false);

    useUIStore.getState().openCommandPalette();
    expect(isAnyBlockingModalOpen()).toBe(true);
    expect(arePaneChordsBlocked()).toBe(true);

    useUIStore.getState().closeCommandPalette();
    expect(isAnyBlockingModalOpen()).toBe(false);
  });
});
