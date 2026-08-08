import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";

// `vi.hoisted` because `vi.mock`'s factory is lifted above every other
// statement in the file — a plain `const` would not exist yet when it runs.
const { terminalSpawn, terminalKill } = vi.hoisted(() => ({
  terminalSpawn: vi.fn(async () => ({
    pid: 1234 as number | null,
    claudeSessionId: null as string | null,
  })),
  terminalKill: vi.fn(async () => {}),
}));

vi.mock("@/lib/bindings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/bindings")>()),
  commands: { terminalSpawn, terminalKill },
}));

/** RocDock is rendered only to mount its keydown bindings; the tree itself has
 *  its own render tests. */
vi.mock("@/views/RocDock/PaneTree", () => ({
  PaneTree: () => <div data-testid="pane-tree" />,
}));

import { answerConfirmsWith, type ConfirmProbe } from "@/test/confirm";
import { ROC_NAMES } from "@/lib/agentLabels";
import { newTerminal, newWorkspace } from "@/lib/factories";
import { LIMITS } from "@/lib/limits";
import { leafIds, type PaneNode } from "@/lib/paneTree";
import {
  resetToastsState,
  useConfirmStore,
  useSettingsStore,
  useTerminalsStore,
  useToastsStore,
  useUIStore,
  useWorkspacesStore,
  DEFAULT_AGENT_DEFAULTS,
} from "@/stores";
import { RocDock } from "@/views/RocDock/RocDock";
import {
  attachPane,
  closeFocusedPane,
  closeTerminalPane,
  launchPanes,
  splitFocused,
  splitTerminal,
} from "@/views/RocDock/paneActions";

const workspacesStore = () => useWorkspacesStore.getState();
const terminals = () => useTerminalsStore.getState();
const ui = () => useUIStore.getState();

let workspaceId = "";

/** One workspace with `count` sessions and a balanced tree over them. Returns
 *  the session ids in tree order. */
function seedWorkspace(count: number): string[] {
  const workspace = newWorkspace({
    name: "W",
    projectPath: "/tmp/proj",
    order: 0,
  });
  workspaceId = workspace.id;
  const sessions = Array.from({ length: count }, (_, i) =>
    newTerminal({
      workspaceId,
      name: `T${i}`,
      agentType: "shell",
      projectPath: "/tmp/proj",
    }),
  );
  useWorkspacesStore.setState({
    workspaces: [workspace],
    activeWorkspaceId: workspaceId,
  });
  terminals().setTerminals(sessions);
  workspacesStore().ensurePaneTree(
    workspaceId,
    sessions.map((t) => t.id),
  );
  return sessions.map((t) => t.id);
}

/** A workspace with no sessions and no tree. */
function seedEmptyWorkspace(): string {
  const workspace = newWorkspace({
    name: "Empty",
    projectPath: "/tmp/proj",
    order: 0,
  });
  workspaceId = workspace.id;
  useWorkspacesStore.setState({
    workspaces: [workspace],
    activeWorkspaceId: workspace.id,
  });
  return workspace.id;
}

const tree = (): PaneNode | null =>
  workspacesStore().workspaces.find((w) => w.id === workspaceId)?.paneTree ??
  null;

const sessionCount = () =>
  Object.values(terminals().byId).filter((t) => t.workspaceId === workspaceId)
    .length;

const toasts = () => useToastsStore.getState().items;

let confirms: ConfirmProbe;

beforeEach(() => {
  vi.clearAllMocks();
  useWorkspacesStore.setState({ workspaces: [], activeWorkspaceId: null });
  useTerminalsStore.setState({ byId: {} });
  useUIStore.setState({
    focusedTerminalId: null,
    maximizedTerminalId: null,
    isSettingsOpen: false,
    isWorkspaceModalOpen: false,
    isSaveSessionModalOpen: false,
    isQuickOpenOpen: false,
    taskEditor: null,
    mainView: "terminals",
  });
  useSettingsStore.setState({ agentDefaults: { ...DEFAULT_AGENT_DEFAULTS } });
  resetToastsState();
  confirms = answerConfirmsWith(true);
});

afterEach(() => {
  confirms.restore();
  vi.restoreAllMocks();
});

describe("splitTerminal", () => {
  it("adds a session, puts it beside its source, and spawns its PTY", () => {
    const [a, b] = seedWorkspace(2);
    ui().focusTerminal(a!);

    expect(splitFocused("row")).toBe(true);

    const ids = leafIds(tree()!);
    expect(ids).toHaveLength(3);
    // Inserted directly after the pane it was split from, not appended.
    expect(ids[0]).toBe(a);
    expect(ids[2]).toBe(b);

    const created = ids[1]!;
    expect(terminals().byId[created]).toBeDefined();
    // The whole agent config goes over IPC, not just the type: model and
    // permissions have to reach the CLI the split-in pane runs. Agent type is
    // the settings default, not the source pane's — splitting a shell to try
    // something out should give you your usual agent.
    expect(terminalSpawn).toHaveBeenCalledWith(
      created,
      expect.objectContaining({ type: DEFAULT_AGENT_DEFAULTS.agentType }),
      "/tmp/proj",
      // A brand new pane has no conversation to rejoin.
      null,
      // Nor a measured size: it spawns before its xterm exists, so Rust keeps
      // its default and `spawnTerminal` re-asserts the real size afterwards.
      null,
      null,
    );
    // …and it takes the keyboard, so the next chord acts on what you just made.
    expect(ui().focusedTerminalId).toBe(created);
  });

  it("records the spawned process identity on the session", async () => {
    terminalSpawn.mockResolvedValueOnce({ pid: 4242, claudeSessionId: "u-1" });
    const [a] = seedWorkspace(1);

    splitTerminal(a!, "row");
    // The spawn is fire-and-forget; let its promise settle before asserting.
    await vi.waitFor(() => {
      const created = leafIds(tree()!).find((id) => id !== a)!;
      expect(terminals().byId[created]!.pid).toBe(4242);
      expect(terminals().byId[created]!.claudeSessionId).toBe("u-1");
    });
  });

  it("inherits the cwd from its source but the agent type from settings", () => {
    const [a] = seedWorkspace(1);
    useSettingsStore.setState({
      agentDefaults: { ...DEFAULT_AGENT_DEFAULTS, agentType: "codex" },
    });

    splitTerminal(a!, "column");

    const created = leafIds(tree()!).find((id) => id !== a)!;
    const session = terminals().byId[created]!;
    expect(session.agentConfig.type).toBe("codex");
    expect(session.projectPath).toBe("/tmp/proj");
    expect(session.workspaceId).toBe(workspaceId);
    expect(tree()).toMatchObject({ kind: "split", direction: "column" });
  });

  it("drops maximize so the new pane is actually on screen", () => {
    const [a] = seedWorkspace(2);
    useUIStore.setState({ maximizedTerminalId: a!, focusedTerminalId: a! });

    splitTerminal(a!, "row");

    expect(ui().maximizedTerminalId).toBeNull();
  });

  it("refuses at the workspace cap without spawning anything", () => {
    const ids = seedWorkspace(LIMITS.terminalsPerWorkspace);
    ui().focusTerminal(ids[0]!);

    expect(splitFocused("row")).toBe(false);

    expect(sessionCount()).toBe(LIMITS.terminalsPerWorkspace);
    expect(leafIds(tree()!)).toHaveLength(LIMITS.terminalsPerWorkspace);
    expect(terminalSpawn).not.toHaveBeenCalled();
  });

  // …and SAYS so. The split buttons in the pane header disable themselves at
  // the cap and put the reason in their tooltip, but ⌘D, ⌘⇧D and ⌘N cannot: a
  // chord that does nothing and writes a console line the user does not have
  // open is a keyboard that looks broken.
  it("tells the user why a chord did nothing at the cap", () => {
    const ids = seedWorkspace(LIMITS.terminalsPerWorkspace);
    ui().focusTerminal(ids[0]!);

    splitFocused("row");

    expect(toasts().map((t) => t.message)).toEqual([
      expect.stringMatching(
        RegExp(`already holds ${LIMITS.terminalsPerWorkspace} panes`),
      ),
    ]);
    expect(toasts()[0]!.tone).toBe("warn");

    // ⌘D autorepeats. A held key must not stack the same warning three deep —
    // which is exactly what the toast stack holds.
    splitFocused("row");
    splitFocused("column");
    expect(toasts()).toHaveLength(1);
  });

  it("splits the first pane when nothing has focus yet", () => {
    const [a] = seedWorkspace(2);

    expect(splitFocused("row")).toBe(true);

    expect(leafIds(tree()!)[0]).toBe(a);
  });

  it("does nothing when there is no active workspace to split into", () => {
    useWorkspacesStore.setState({ workspaces: [], activeWorkspaceId: null });

    expect(splitFocused("row")).toBe(false);
    expect(terminalSpawn).not.toHaveBeenCalled();
  });
});

describe("splitting into an empty workspace", () => {
  // The empty dock tells the user to press ⌘D. It has to work: with no tree
  // there is nothing to split *from*, and the shortcut used to no-op — which
  // left any workspace whose last pane had just been closed permanently
  // without a way back to a terminal.
  it("mints the first pane when the workspace has no tree", () => {
    seedEmptyWorkspace();

    expect(splitFocused("row")).toBe(true);

    const tree = workspacesStore().workspaces[0]!.paneTree!;
    expect(leafIds(tree)).toHaveLength(1);
    const created = leafIds(tree)[0]!;
    expect(terminals().byId[created]).toBeDefined();
    expect(ui().focusedTerminalId).toBe(created);
    expect(terminalSpawn).toHaveBeenCalledOnce();
  });

  it("spawns that first pane in the workspace's own directory", () => {
    // There is no source pane to inherit a cwd from, and a pane opened into
    // the wrong directory is an agent pointed at the wrong repository.
    const id = seedEmptyWorkspace();

    splitFocused("row");

    const created = leafIds(workspacesStore().workspaces[0]!.paneTree!)[0]!;
    expect(terminals().byId[created]!.projectPath).toBe("/tmp/proj");
    expect(terminals().byId[created]!.workspaceId).toBe(id);
  });

  it("spawns it cwd-less when the workspace has no directory", () => {
    const workspace = newWorkspace({ projectPath: null, order: 0 });
    workspaceId = workspace.id;
    useWorkspacesStore.setState({
      workspaces: [workspace],
      activeWorkspaceId: workspace.id,
    });

    splitFocused("row");

    const created = leafIds(tree()!)[0]!;
    expect(terminals().byId[created]!.projectPath).toBe("");
  });

  it("opens a pane again after the last one is closed", () => {
    const [a] = seedWorkspace(1);
    ui().focusTerminal(a!);

    closeFocusedPane();
    expect(tree()).toBeNull();

    expect(splitFocused("row")).toBe(true);
    expect(leafIds(tree()!)).toHaveLength(1);
  });

  it("still refuses at the workspace cap", () => {
    // Sessions without a tree are unusual (a stale snapshot), but the cap is
    // about how many PTYs the workspace owns, not how many are on screen.
    seedWorkspace(LIMITS.terminalsPerWorkspace);
    useWorkspacesStore.setState((s) => ({
      workspaces: s.workspaces.map((w) => ({ ...w, paneTree: null })),
    }));

    expect(splitFocused("row")).toBe(false);
    expect(terminalSpawn).not.toHaveBeenCalled();
  });
});

describe("pane naming", () => {
  /** A workspace whose sessions carry the names given. */
  function seedNamed(names: string[]) {
    const workspace = newWorkspace({
      name: "W",
      projectPath: "/tmp/proj",
      order: 0,
    });
    workspaceId = workspace.id;
    const sessions = names.map((name) =>
      newTerminal({
        workspaceId,
        name,
        agentType: "claude-code",
        projectPath: "/tmp/proj",
      }),
    );
    useWorkspacesStore.setState({
      workspaces: [workspace],
      activeWorkspaceId: workspaceId,
    });
    terminals().setTerminals(sessions);
    workspacesStore().ensurePaneTree(
      workspaceId,
      sessions.map((t) => t.id),
    );
    useSettingsStore.setState({
      agentDefaults: { ...DEFAULT_AGENT_DEFAULTS, agentType: "claude-code" },
    });
    return sessions.map((t) => t.id);
  }

  const nameOf = (id: string) => terminals().byId[id]!.name;
  const newNameAfter = (before: string[]) =>
    leafIds(tree()!)
      .filter((id) => !before.includes(id))
      .map(nameOf)[0];

  it("names a new pane after the agent's CLI no longer — it gets a roc name", () => {
    const ids = seedNamed([ROC_NAMES[0]!]);

    splitTerminal(ids[0]!, "row");

    // The badge already says "Claude"; the name is the user's handle for the
    // pane, and it survives switching which CLI runs in it.
    expect(newNameAfter(ids)).toBe(ROC_NAMES[1]);
  });

  it("does not reuse a name after a pane is closed out of order", () => {
    // Numbering off the live session count is what made this wrong: with three
    // panes open, closing the middle one leaves a count of two, so the next
    // split minted a duplicate of the third. A name is how the user addresses
    // a pane in the sidebar and the inspector — two panes answering to one is
    // ambiguous.
    const ids = seedNamed(ROC_NAMES.slice(0, 3));
    closeTerminalPane(ids[1]!);
    const survivors = [ids[0]!, ids[2]!];

    splitTerminal(ids[0]!, "row");

    const minted = newNameAfter(survivors)!;
    expect(survivors.map(nameOf)).not.toContain(minted);
    // The freed name is the first one going spare, so the pool stays dense.
    expect(minted).toBe(ROC_NAMES[1]);
  });

  it("steps over a name the user has already taken by hand", () => {
    const ids = seedNamed([ROC_NAMES[0]!, "scratch"]);
    terminals().renameTerminal(ids[1]!, ROC_NAMES[2]!);

    splitTerminal(ids[0]!, "row");

    expect(newNameAfter(ids)).toBe(ROC_NAMES[1]);
  });

  it("starts at the head of the pool in a workspace whose panes are all renamed", () => {
    const ids = seedNamed(["scratch", "notes"]);

    splitTerminal(ids[0]!, "row");

    expect(newNameAfter(ids)).toBe(ROC_NAMES[0]);
  });
});

describe("closeTerminalPane", () => {
  it("kills the PTY, drops the leaf, and forgets the session", () => {
    const [a, b] = seedWorkspace(2);

    closeTerminalPane(a!);

    expect(terminalKill).toHaveBeenCalledWith(a);
    expect(terminals().byId[a!]).toBeUndefined();
    expect(tree()).toEqual({ kind: "leaf", terminalId: b });
  });

  it("does not ask before closing a pane that is not running", async () => {
    const [a] = seedWorkspace(2);

    await closeTerminalPane(a!);

    expect(confirms.asked).toHaveLength(0);
  });

  it("asks before closing a running pane, and honours a cancel", async () => {
    const [a] = seedWorkspace(2);
    terminals().setStatus(a!, "running");
    confirms.restore();
    confirms = answerConfirmsWith(false);

    await closeTerminalPane(a!);

    expect(confirms.asked).toHaveLength(1);
    expect(terminalKill).not.toHaveBeenCalled();
    expect(terminals().byId[a!]).toBeDefined();
    expect(leafIds(tree()!)).toHaveLength(2);
  });

  it("hands focus to a surviving pane and leaves focus mode", () => {
    const [a, b] = seedWorkspace(2);
    useUIStore.setState({ focusedTerminalId: a!, maximizedTerminalId: a! });

    closeTerminalPane(a!);

    expect(ui().focusedTerminalId).toBe(b);
    expect(ui().maximizedTerminalId).toBeNull();
  });

  it("clears focus when the last pane goes", () => {
    const [a] = seedWorkspace(1);
    ui().focusTerminal(a!);

    closeFocusedPane();

    expect(tree()).toBeNull();
    expect(ui().focusedTerminalId).toBeNull();
  });
});

// The topbar's Play button and the palette's "Launch every pane" both end up
// here. `spawnTerminal` is not "start if stopped": `PtyRuntime::spawn` opens by
// killing whatever is on the id, so over a working dock this throws away every
// conversation in it — and it was the one route to that which asked nothing,
// while ⌘W asks about a single pane and "Close this workspace" asks about a
// workspace's worth.
describe("launchPanes", () => {
  it("launches an idle dock without asking anything", async () => {
    const ids = seedWorkspace(3);

    await launchPanes(ids);

    expect(confirms.asked).toHaveLength(0);
    expect(terminalSpawn).toHaveBeenCalledTimes(3);
  });

  it("asks once when any pane is still running, and honours a cancel", async () => {
    const ids = seedWorkspace(3);
    terminals().setStatus(ids[1]!, "running");
    confirms.restore();
    confirms = answerConfirmsWith(false);

    await launchPanes(ids);

    expect(confirms.asked).toHaveLength(1);
    expect(confirms.asked[0]!.tone).toBe("danger");
    expect(terminalSpawn).not.toHaveBeenCalled();
  });

  it("launches everything once the question is answered", async () => {
    const ids = seedWorkspace(3);
    terminals().setStatus(ids[1]!, "running");

    await launchPanes(ids);

    expect(confirms.asked).toHaveLength(1);
    expect(terminalSpawn).toHaveBeenCalledTimes(3);
  });

  it("does not spawn onto a pane that went away while the question was up", async () => {
    const ids = seedWorkspace(2);
    terminals().setStatus(ids[0]!, "running");
    confirms.restore();
    confirms = {
      asked: [],
      restore: useConfirmStore.subscribe((state) => {
        if (!state.request) return;
        // The pane closes while the dialog is on screen — the same race
        // `closeTerminalPane` re-reads for.
        terminals().removeTerminal(ids[1]!);
        useConfirmStore.getState().answer(true);
      }),
    };

    await launchPanes(ids);

    expect(terminalSpawn).toHaveBeenCalledTimes(1);
  });
});

describe("attachPane", () => {
  it("splits the focused pane for a session created elsewhere", () => {
    const [a, b] = seedWorkspace(2);
    ui().focusTerminal(b!);
    const extra = newTerminal({
      workspaceId,
      name: "extra",
      agentType: "shell",
      projectPath: "/tmp/proj",
    });
    terminals().addTerminal(extra);

    attachPane(workspaceId, extra.id);

    expect(leafIds(tree()!)).toEqual([a, b, extra.id]);
    expect(ui().focusedTerminalId).toBe(extra.id);
  });

  it("splits the first pane, keeping ratios, when nothing is focused", () => {
    // The rebuild path is balanced, so taking it here would silently throw away
    // every divider the user has dragged. It is reserved for a workspace with
    // no tree at all.
    const [a, b] = seedWorkspace(2);
    workspacesStore().setPaneRatio(workspaceId, "", 0.8);
    const extra = newTerminal({
      workspaceId,
      name: "extra",
      agentType: "shell",
      projectPath: "/tmp/proj",
    });
    terminals().addTerminal(extra);

    attachPane(workspaceId, extra.id);

    expect(leafIds(tree()!)).toEqual([a, extra.id, b]);
    expect(tree()).toMatchObject({ ratio: 0.8 });
  });

  it("does nothing for a session that already has a pane", () => {
    // Called twice for one session (a double-click on the sidebar's + menu, a
    // caller that does not know it already ran), this used to split a second
    // leaf for a terminal that was already on screen.
    const [a, b] = seedWorkspace(2);

    attachPane(workspaceId, b!);

    expect(leafIds(tree()!)).toEqual([a, b]);
  });

  it("builds a tree from scratch for a workspace that has no panes", () => {
    const id = seedEmptyWorkspace();
    const first = newTerminal({
      workspaceId: id,
      name: "first",
      agentType: "shell",
      projectPath: "/tmp/proj",
    });
    terminals().addTerminal(first);

    attachPane(id, first.id);

    expect(workspacesStore().workspaces[0]!.paneTree).toEqual({
      kind: "leaf",
      terminalId: first.id,
    });
  });
});

describe("pane shortcuts", () => {
  /** Fire a chord at the document, as the capture-phase listener sees it. */
  function press(key: string, init: KeyboardEventInit = {}) {
    fireEvent.keyDown(document, { key, metaKey: true, ...init });
  }

  it("⌘D splits right and ⌘⇧D splits down", () => {
    const [a] = seedWorkspace(1);
    ui().focusTerminal(a!);
    render(<RocDock />);

    press("d");
    expect(tree()).toMatchObject({ direction: "row" });

    press("d", { shiftKey: true });
    // The new pane took focus, so the second chord splits it — stacked.
    expect(leafIds(tree()!)).toHaveLength(3);
    expect(tree()).toMatchObject({ second: { direction: "column" } });
  });

  it("⌘N opens a pane beside the focused one", () => {
    const [a] = seedWorkspace(1);
    ui().focusTerminal(a!);
    render(<RocDock />);

    press("n");

    expect(leafIds(tree()!)).toHaveLength(2);
    expect(terminalSpawn).toHaveBeenCalledOnce();
  });

  it("⌘N opens a pane again after ⌘W closed the last one", () => {
    // The round trip the empty-dock copy promises. Closing the last pane
    // leaves the workspace with no tree, which used to make every pane chord
    // dead — the only way back was the sidebar.
    const [a] = seedWorkspace(1);
    ui().focusTerminal(a!);
    render(<RocDock />);

    press("w");
    expect(tree()).toBeNull();

    press("n");
    expect(leafIds(tree()!)).toHaveLength(1);
  });

  it("⌘D opens the first pane of an empty workspace", () => {
    seedEmptyWorkspace();
    render(<RocDock />);

    press("d");

    expect(leafIds(tree()!)).toHaveLength(1);
  });

  it("⌘W closes the focused pane and kills its PTY", () => {
    const [a, b] = seedWorkspace(2);
    ui().focusTerminal(a!);
    render(<RocDock />);

    press("w");

    expect(terminalKill).toHaveBeenCalledWith(a);
    expect(tree()).toEqual({ kind: "leaf", terminalId: b });
  });

  it("stands down while Settings is open", () => {
    const [a] = seedWorkspace(1);
    ui().focusTerminal(a!);
    useUIStore.setState({ isSettingsOpen: true });
    render(<RocDock />);

    press("d");

    expect(leafIds(tree()!)).toHaveLength(1);
  });

  it("stands down while the New Workspace modal is up", () => {
    // The scrim stops the mouse, not the keyboard: without the guard ⌘W closes
    // a pane behind the modal, which the user cannot see and did not aim at.
    const [a, b] = seedWorkspace(2);
    ui().focusTerminal(a!);
    useUIStore.setState({ isWorkspaceModalOpen: true });
    render(<RocDock />);

    press("w");
    expect(leafIds(tree()!)).toHaveLength(2);
    expect(terminalKill).not.toHaveBeenCalled();

    press("d");
    press("d", { shiftKey: true });
    press("n");
    expect(leafIds(tree()!)).toEqual([a, b]);
    expect(terminalSpawn).not.toHaveBeenCalled();
  });

  it("stands down while the Save session prompt is up", () => {
    // The same class of bug as the row above, and the one this guard shipped
    // with: Tab moves to the prompt's Cancel button, so the chord is not even
    // inside a text field, and ⌘W killed the pane behind the dialog.
    const [a, b] = seedWorkspace(2);
    ui().focusTerminal(a!);
    useUIStore.setState({ isSaveSessionModalOpen: true });
    render(<RocDock />);

    press("w");
    expect(leafIds(tree()!)).toHaveLength(2);
    expect(terminalKill).not.toHaveBeenCalled();

    press("d");
    press("d", { shiftKey: true });
    press("n");
    expect(leafIds(tree()!)).toEqual([a, b]);
    expect(terminalSpawn).not.toHaveBeenCalled();
  });

  it("stands down while the Go to file box is up", () => {
    // ⌘P's finder is a modal like the two above: it holds the keyboard, its
    // scrim holds the mouse, and a pane chord firing underneath it acts on a
    // terminal the user cannot see. It is in `blockingModalOpen` for that
    // reason — this is the end of the wire.
    const [a, b] = seedWorkspace(2);
    ui().focusTerminal(a!);
    useUIStore.setState({ isQuickOpenOpen: true });
    render(<RocDock />);

    press("w");
    expect(leafIds(tree()!)).toHaveLength(2);
    expect(terminalKill).not.toHaveBeenCalled();

    press("d");
    press("d", { shiftKey: true });
    press("n");
    expect(leafIds(tree()!)).toEqual([a, b]);
    expect(terminalSpawn).not.toHaveBeenCalled();
  });

  it("stands down while RocPlan has the main area", () => {
    // The board SWAPS the dock out and the dock stays mounted behind `hidden`,
    // so this component — and its document-level listener — is still here while
    // its panes are not on screen. ⌘W closed one anyway, and an idle pane is
    // not even confirmed first: the user was reading a kanban board and a
    // terminal went away behind it.
    const [a, b] = seedWorkspace(2);
    ui().focusTerminal(a!);
    useUIStore.setState({ mainView: "rocplan" });
    render(<RocDock />);

    press("w");
    expect(leafIds(tree()!)).toHaveLength(2);
    expect(terminalKill).not.toHaveBeenCalled();

    press("d");
    press("d", { shiftKey: true });
    press("n");
    expect(leafIds(tree()!)).toEqual([a, b]);
    expect(terminalSpawn).not.toHaveBeenCalled();

    // And they come back with the dock.
    useUIStore.setState({ mainView: "terminals" });
    press("w");
    expect(terminalKill).toHaveBeenCalledWith(a);
  });

  it("stands down while the card editor is open over the board", () => {
    const [a] = seedWorkspace(2);
    ui().focusTerminal(a!);
    useUIStore.getState().openTaskEditor("/tmp/proj", "task_1");
    render(<RocDock />);

    press("w");

    expect(terminalKill).not.toHaveBeenCalled();
  });

  it("stands down while the user is typing in a field", () => {
    const [a] = seedWorkspace(1);
    ui().focusTerminal(a!);
    render(<RocDock />);
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();

    press("w");

    expect(terminalKill).not.toHaveBeenCalled();
    input.remove();
  });

  it("still fires when a terminal holds the keyboard", () => {
    // xterm's input sink is a <textarea> and holds focus the whole time a pane
    // is focused. Treating it as a text field would make every pane chord dead
    // exactly where panes get used.
    const [a] = seedWorkspace(1);
    ui().focusTerminal(a!);
    render(<RocDock />);
    const sink = document.createElement("textarea");
    sink.className = "xterm-helper-textarea";
    document.body.appendChild(sink);
    sink.focus();

    press("d");

    expect(leafIds(tree()!)).toHaveLength(2);
    sink.remove();
  });

  it("ignores Ctrl chords so Ctrl-D stays end-of-input", () => {
    const [a] = seedWorkspace(1);
    ui().focusTerminal(a!);
    render(<RocDock />);

    fireEvent.keyDown(document, { key: "d", ctrlKey: true });

    expect(leafIds(tree()!)).toHaveLength(1);
  });

  it("claims the keystroke so it does not also reach the PTY", () => {
    const [a] = seedWorkspace(1);
    ui().focusTerminal(a!);
    render(<RocDock />);

    const event = new KeyboardEvent("keydown", {
      key: "d",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });
});
