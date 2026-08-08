import { beforeEach, describe, expect, it } from "vitest";
import { newWorkspace } from "@/lib/factories";
import {
  DEFAULT_SETTINGS_SECTION,
  arePaneChordsBlocked,
  isAnyBlockingModalOpen,
  useUIStore,
} from "@/stores/ui";
import { useWorkspacesStore } from "@/stores/workspaces";

describe("useUIStore", () => {
  beforeEach(() => {
    useWorkspacesStore.setState({ workspaces: [], activeWorkspaceId: null });
    useUIStore.setState({
      focusedTerminalId: null,
      highlightedTerminalId: null,
      maximizedTerminalId: null,
      isCommandPaletteOpen: false,
      isWorkspaceModalOpen: false,
      isSaveSessionModalOpen: false,
      isQuickOpenOpen: false,
      editorPrompt: null,
      isSettingsOpen: false,
      settingsSection: DEFAULT_SETTINGS_SECTION,
      mainView: "terminals",
      taskEditor: null,
      modalStack: [],
    });
  });

  it("focusTerminal sets and clears", () => {
    useUIStore.getState().focusTerminal("term_1");
    expect(useUIStore.getState().focusedTerminalId).toBe("term_1");
    useUIStore.getState().focusTerminal(null);
    expect(useUIStore.getState().focusedTerminalId).toBeNull();
  });

  it("modal stack is LIFO", () => {
    useUIStore.getState().pushModal({
      type: "close-workspace",
      workspaceId: "w_1",
    });
    useUIStore.getState().pushModal({
      type: "delete-terminal",
      terminalId: "t_1",
    });
    expect(useUIStore.getState().modalStack.length).toBe(2);
    useUIStore.getState().popModal();
    expect(useUIStore.getState().modalStack.at(-1)?.type).toBe(
      "close-workspace",
    );
    useUIStore.getState().clearModals();
    expect(useUIStore.getState().modalStack.length).toBe(0);
  });

  // Two readers with two lifetimes: the app-wide focus is ephemeral and drives
  // the inspector, the workspace's copy is persisted and is what "come back to
  // where I was" means. Writing only the first left every workspace remembering
  // its first pane forever.
  it("focusTerminal also records focus on the active workspace", () => {
    const workspace = newWorkspace({ projectPath: "/tmp/proj", order: 0 });
    useWorkspacesStore.setState({
      workspaces: [workspace],
      activeWorkspaceId: workspace.id,
    });

    useUIStore.getState().focusTerminal("term_1");

    expect(useWorkspacesStore.getState().workspaces[0]!.focusedTerminalId).toBe(
      "term_1",
    );

    useUIStore.getState().focusTerminal(null);
    expect(
      useWorkspacesStore.getState().workspaces[0]!.focusedTerminalId,
    ).toBeNull();
  });

  it("maximizing records focus on the workspace too", () => {
    const workspace = newWorkspace({ projectPath: null, order: 0 });
    useWorkspacesStore.setState({
      workspaces: [workspace],
      activeWorkspaceId: workspace.id,
    });

    useUIStore.getState().maximizeTerminal("term_9");
    expect(useWorkspacesStore.getState().workspaces[0]!.focusedTerminalId).toBe(
      "term_9",
    );
  });

  it("focusing with no workspace open is a no-op rather than a throw", () => {
    // The empty state: the dock has no active workspace, and a stray focus
    // (a notification click landing after the last one closed) must not crash.
    expect(() => useUIStore.getState().focusTerminal("term_1")).not.toThrow();
    expect(useUIStore.getState().focusedTerminalId).toBe("term_1");
  });

  it("reports every surface that holds the window, one at a time", () => {
    // What the document-level chords stand down on. It is a single derived
    // answer because the alternative — each handler listing the flags it knows
    // about — already shipped a hole: the pane chords named Settings and the
    // New Workspace modal, and ⌘W kept killing panes under the Save session
    // prompt. A modal added to the store belongs in `blockingModalOpen`, and
    // this is the test that says so.
    expect(isAnyBlockingModalOpen()).toBe(false);

    for (const open of [
      "isSettingsOpen",
      "isWorkspaceModalOpen",
      "isSaveSessionModalOpen",
      "isQuickOpenOpen",
    ] as const) {
      useUIStore.setState({ [open]: true });
      expect(isAnyBlockingModalOpen(), open).toBe(true);
      useUIStore.setState({ [open]: false });
      expect(isAnyBlockingModalOpen(), open).toBe(false);
    }

    // The RocPlan card editor is a real modal too — it just carries its target
    // instead of being a flag, so it cannot join the loop above.
    useUIStore.getState().openTaskEditor("/code/rocspace", "task_1");
    expect(isAnyBlockingModalOpen(), "taskEditor").toBe(true);
    useUIStore.getState().closeTaskEditor();
    expect(isAnyBlockingModalOpen(), "taskEditor").toBe(false);

    // The Git panel's dialogs are one field for the same reason: three
    // mutually exclusive modals, one thing for this predicate to ask about.
    for (const kind of ["branch", "worktree", "review"] as const) {
      useUIStore.getState().openGitDialog(kind);
      expect(isAnyBlockingModalOpen(), kind).toBe(true);
      useUIStore.getState().closeGitDialog();
      expect(isAnyBlockingModalOpen(), kind).toBe(false);
    }
    // The editor's dialogs carry a path for the same reason, and hold the
    // window for the same reason: a ⌘W underneath one closes a pane the user
    // cannot see while they answer a question about a file.
    useUIStore.getState().openEditorPrompt({
      type: "unsaved-close",
      path: "/code/rocspace/src/App.tsx",
    });
    expect(isAnyBlockingModalOpen(), "editorPrompt").toBe(true);
    useUIStore.getState().closeEditorPrompt();
    expect(isAnyBlockingModalOpen(), "editorPrompt").toBe(false);
  });

  it("stands the pane chords down for the board as well as for the modals", () => {
    // RocPlan swaps the dock out and the dock stays MOUNTED behind it, so a
    // document-level ⌘W went on closing panes the user could not see — the
    // same bug the modal guard exists for, one surface further out. Every
    // answer above is still an answer here.
    expect(arePaneChordsBlocked()).toBe(false);

    useUIStore.getState().setMainView("rocplan");
    expect(arePaneChordsBlocked(), "rocplan").toBe(true);
    // Not a modal, though: ⌘⇧P has to be able to swap back.
    expect(isAnyBlockingModalOpen(), "rocplan").toBe(false);

    useUIStore.getState().setMainView("terminals");
    expect(arePaneChordsBlocked()).toBe(false);

    // Roc's expanded view is the same swap for the same reason, and gets the
    // same answer — it holds a command bar the user types into, and ⌘W behind
    // it would close a pane they cannot see.
    useUIStore.getState().setMainView("roc");
    expect(arePaneChordsBlocked(), "roc").toBe(true);
    expect(isAnyBlockingModalOpen(), "roc").toBe(false);

    useUIStore.getState().setMainView("terminals");
    expect(arePaneChordsBlocked()).toBe(false);

    useUIStore.setState({ isSettingsOpen: true });
    expect(arePaneChordsBlocked(), "settings").toBe(true);
    useUIStore.setState({ isSettingsOpen: false });
  });

  it("the card editor remembers which card it was opened on", () => {
    useUIStore.getState().openTaskEditor("/code/rocspace", "task_1");
    expect(useUIStore.getState().taskEditor).toEqual({
      projectPath: "/code/rocspace",
      taskId: "task_1",
    });

    // No id is the create form — one dialog, two jobs.
    useUIStore.getState().openTaskEditor("/code/rocspace");
    expect(useUIStore.getState().taskEditor).toEqual({
      projectPath: "/code/rocspace",
      taskId: null,
    });
  });

  it("the main view swaps between the terminals and the board", () => {
    expect(useUIStore.getState().mainView).toBe("terminals");
    useUIStore.getState().setMainView("rocplan");
    expect(useUIStore.getState().mainView).toBe("rocplan");
    useUIStore.getState().setMainView("terminals");
    expect(useUIStore.getState().mainView).toBe("terminals");
  });

  it("the workspace modal opens and closes", () => {
    expect(useUIStore.getState().isWorkspaceModalOpen).toBe(false);
    useUIStore.getState().openWorkspaceModal();
    expect(useUIStore.getState().isWorkspaceModalOpen).toBe(true);
    useUIStore.getState().closeWorkspaceModal();
    expect(useUIStore.getState().isWorkspaceModalOpen).toBe(false);
  });

  it("maximizeTerminal sets the id and also focuses it; exitMaximize clears", () => {
    useUIStore.getState().maximizeTerminal("term_1");
    expect(useUIStore.getState().maximizedTerminalId).toBe("term_1");
    expect(useUIStore.getState().focusedTerminalId).toBe("term_1");
    useUIStore.getState().exitMaximize();
    expect(useUIStore.getState().maximizedTerminalId).toBeNull();
  });

  it("toggleMaximizeTerminal toggles same id off and switches between ids", () => {
    useUIStore.getState().toggleMaximizeTerminal("term_1");
    expect(useUIStore.getState().maximizedTerminalId).toBe("term_1");
    // Same id again → exit focus mode
    useUIStore.getState().toggleMaximizeTerminal("term_1");
    expect(useUIStore.getState().maximizedTerminalId).toBeNull();
    // Different id while another is maximized → switch focus to that id
    useUIStore.getState().toggleMaximizeTerminal("term_1");
    useUIStore.getState().toggleMaximizeTerminal("term_2");
    expect(useUIStore.getState().maximizedTerminalId).toBe("term_2");
    expect(useUIStore.getState().focusedTerminalId).toBe("term_2");
  });

  it("openSettings jumps to a section and remembers it after closing", () => {
    useUIStore.getState().openSettings("terminal");
    expect(useUIStore.getState().isSettingsOpen).toBe(true);
    expect(useUIStore.getState().settingsSection).toBe("terminal");

    useUIStore.getState().closeSettings();
    expect(useUIStore.getState().isSettingsOpen).toBe(false);
    // Reopening with no argument lands where the user left off.
    useUIStore.getState().openSettings();
    expect(useUIStore.getState().settingsSection).toBe("terminal");
  });

  it("toggleSettings closes on a repeat and switches across sections", () => {
    const ui = () => useUIStore.getState();

    ui().toggleSettings();
    expect(ui().isSettingsOpen).toBe(true);
    // Gear again → closed.
    ui().toggleSettings();
    expect(ui().isSettingsOpen).toBe(false);

    ui().toggleSettings("agents");
    expect(ui().isSettingsOpen).toBe(true);
    // A *different* section while open switches instead of closing.
    ui().toggleSettings("voice");
    expect(ui().isSettingsOpen).toBe(true);
    expect(ui().settingsSection).toBe("voice");
    // The same one closes.
    ui().toggleSettings("voice");
    expect(ui().isSettingsOpen).toBe(false);
    expect(ui().settingsSection).toBe("voice");
  });

  it("toggleCommandPalette flips and openCommandPalette is idempotent", () => {
    useUIStore.getState().toggleCommandPalette();
    expect(useUIStore.getState().isCommandPaletteOpen).toBe(true);
    useUIStore.getState().openCommandPalette();
    expect(useUIStore.getState().isCommandPaletteOpen).toBe(true);
    useUIStore.getState().closeCommandPalette();
    expect(useUIStore.getState().isCommandPaletteOpen).toBe(false);
  });
});
