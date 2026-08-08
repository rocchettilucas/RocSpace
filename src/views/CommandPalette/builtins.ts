/** The actions RocSpace itself contributes to the palette.
 *
 *  Everything here already exists somewhere in the UI — a chord, a topbar
 *  button, a sidebar row. The palette is a second door onto the same room, so
 *  nothing in this file implements behaviour: each `run` calls the function the
 *  button calls, which is what keeps the two from drifting.
 *
 *  # Toggles are two commands, not one
 *
 *  A title is written once and read later, so "Toggle Roc" tells the user
 *  nothing about what is about to happen. Every toggle is registered as a PAIR
 *  whose `enabled()` are each other's negation — "Show Roc" while it is hidden,
 *  "Hide Roc" while it is up — and only one is ever in the list. The palette
 *  asks `enabled()` at open time, which is exactly when the answer is needed.
 *
 *  # What is deliberately NOT here
 *
 *  *Dictation.* RocTalk is push-to-talk: you hold a key and speak into it.
 *  There is no "start dictating" a palette could run, because releasing the
 *  palette's Enter is not releasing the key — so what is offered instead is the
 *  on/off switch the widget already has, plus the Voice settings that rebind
 *  the key.
 *
 *  *Pane actions while another surface has the main area.* RocPlan and Roc take
 *  the dock's place while the panes keep running behind them, which is why the
 *  pane CHORDS stand down there. The palette follows the same rule through
 *  `mainView === "terminals"` rather than through `arePaneChordsBlocked()`:
 *  that predicate also answers "is a modal open", and while the palette is
 *  reading this list, the palette is that modal.
 *
 *  EVERY entry in the `Panes` group carries `onTerminals()`, the two that act
 *  on all of them most of all: "Stop every pane" reached from RocPlan is ⌘K,
 *  "stop", Enter — three keystrokes that kill sixteen agents from a surface
 *  which is not showing a single one of them. The test asserts the whole group
 *  is gone, not one row of it, because a half-populated group is what a missed
 *  `enabled()` looks like.
 *
 *  # The empty state is a surface too
 *
 *  `App` renders `AppShell` only once there is a workspace, and mounts this
 *  palette OUTSIDE that gate — deliberately, because its "New workspace" row is
 *  the way out of the empty state. What follows from that is a rule, not a
 *  special case: an action whose effect is drawn by, or performed by, anything
 *  inside the shell needs `hasWorkspace()`. The panel modes, RocMind, Roc, the
 *  Roc widget and the dictation switch all failed it, and two of them did worse
 *  than nothing: `rocmind.open` and `roc.open` move `mainView` to a surface
 *  nothing is mounted to draw, and the chords that would move it back (⌘⇧M,
 *  ⌘⇧R) are in the shell — so the next ⌘T opened the new workspace onto RocMind
 *  instead of onto its panes. `closeWorkspace` now puts the view back for the
 *  users that got there some other way. */

import { commands } from "@/lib/bindings";
import { LATEST_ENTRY } from "@/lib/changelog";
import { leafIds } from "@/lib/paneTree";
import { pathTail } from "@/lib/utils";
import { DEFAULT_ZOOM, zoomIn, zoomOut, ZOOM_STEPS } from "@/lib/zoom";
import {
  confirmAction,
  ensureBoardLoaded,
  useEditorStore,
  useRocStore,
  useRocTalkStore,
  useSettingsStore,
  useTerminalsStore,
  useUIStore,
  useWorkspacesStore,
} from "@/stores";
import { THEMES } from "@/themes/registry";
import {
  canAddPane,
  closeFocusedPane,
  launchPanes,
  splitFocused,
} from "@/views/RocDock/paneActions";
import { SECTION_META, SETTINGS_SECTIONS } from "@/views/Settings/SettingsNav";
import type { CommandAction } from "@/lib/commands/registry";
import type { Workspace } from "@/lib/bindings";

const ui = () => useUIStore.getState();
const onTerminals = () => ui().mainView === "terminals";
const hasWorkspace = () => useWorkspacesStore.getState().activeWorkspaceId;

/** Is there room in the active workspace for one more pane?
 *
 *  The same predicate the split buttons disable themselves on — `canAddPane`
 *  is the imperative form of the `useCanAddPane` they subscribe to — because a
 *  palette row that stays live at the cap is a row that reads as broken: it
 *  runs, nothing appears, and the reason is a console line. */
const hasPaneRoomHere = (): boolean => {
  const workspaceId = hasWorkspace();
  return workspaceId !== null && canAddPane(workspaceId);
};

/** The pane ids the active workspace is showing, read off its TREE rather than
 *  by filtering sessions — same answer the topbar's Launch/Stop buttons act on,
 *  which is "what is on screen", not "what exists". */
function activePaneIds(): string[] {
  const { workspaces, activeWorkspaceId } = useWorkspacesStore.getState();
  const tree =
    workspaces.find((w) => w.id === activeWorkspaceId)?.paneTree ?? null;
  return tree ? leafIds(tree) : [];
}

function activeProjectPath(): string | null {
  const { workspaces, activeWorkspaceId } = useWorkspacesStore.getState();
  return (
    workspaces.find((w) => w.id === activeWorkspaceId)?.projectPath ?? null
  );
}

type PanelMode = "inspector" | "browser" | "editor";

/** Show the right panel on a given mode. Expanding is part of the action: a
 *  "Show the Browser" that set the mode behind a collapsed panel would report
 *  success and change nothing the user can see. */
function showPanel(mode: PanelMode): void {
  const editor = useEditorStore.getState();
  editor.setRightDockMode(mode);
  editor.setRightPanelCollapsed(false);
}

/** Is there anything for "Show the Inspector" to do?
 *
 *  Both halves, because the action is both: a mode that is already selected
 *  behind a COLLAPSED panel is still worth offering — running it is what puts
 *  it on screen. It is only the mode that is selected AND visible that has
 *  nothing left to change, and offering it there contradicts the pair rule
 *  every other toggle in this file follows. */
function panelHidden(mode: PanelMode): boolean {
  const editor = useEditorStore.getState();
  return editor.rightPanelCollapsed || editor.rightDockMode !== mode;
}

function workspaceCommands(workspaces: readonly Workspace[]): CommandAction[] {
  return workspaces.map((workspace) => ({
    id: `workspace.switch:${workspace.id}`,
    title: `Switch to ${workspace.name}`,
    group: "Workspace" as const,
    keywords: [
      "workspace",
      workspace.name,
      ...(workspace.projectPath ? [pathTail(workspace.projectPath)] : []),
    ],
    // The workspace you are already in is not somewhere to go.
    enabled: () =>
      useWorkspacesStore.getState().activeWorkspaceId !== workspace.id,
    run: () => useWorkspacesStore.getState().setActiveWorkspace(workspace.id),
  }));
}

function settingsCommands(): CommandAction[] {
  return SETTINGS_SECTIONS.map((section) => ({
    id: `settings.section:${section}`,
    title: `Open Settings › ${SECTION_META[section].label}`,
    group: "Settings" as const,
    keywords: ["settings", "preferences", SECTION_META[section].label],
    run: () => ui().openSettings(section),
  }));
}

function themeCommands(): CommandAction[] {
  return THEMES.map((theme) => ({
    id: `settings.theme:${theme.id}`,
    title: `Switch to the ${theme.name} theme`,
    group: "Settings" as const,
    keywords: ["theme", "appearance", "colors", theme.name],
    enabled: () => useSettingsStore.getState().themeId !== theme.id,
    run: () => useSettingsStore.getState().setThemeId(theme.id),
  }));
}

/** Every built-in action, given the workspace list to build the switch entries
 *  from. A function of the workspaces rather than a constant because those
 *  entries are one per row and the rows change; everything else is static and
 *  reads the stores inside `run`. */
export function builtInCommands(
  workspaces: readonly Workspace[],
): CommandAction[] {
  return [
    // Workspace ----------------------------------------------------------
    {
      id: "workspace.new",
      title: "New workspace…",
      group: "Workspace",
      shortcut: "⌘T",
      keywords: ["create", "project", "open folder", "directory"],
      run: () => ui().openWorkspaceModal(),
    },
    ...workspaceCommands(workspaces),
    {
      id: "workspace.save-session",
      title: "Save this workspace as a named session…",
      group: "Workspace",
      shortcut: "⌘⇧S",
      keywords: ["session", "snapshot", "store", "persist"],
      run: () => ui().openSaveSessionModal(),
    },
    {
      id: "workspace.close",
      title: "Close this workspace",
      group: "Workspace",
      keywords: ["quit", "remove", "shut"],
      enabled: () => hasWorkspace() !== null,
      run: async () => {
        const { workspaces, activeWorkspaceId, closeWorkspace } =
          useWorkspacesStore.getState();
        const workspace = workspaces.find((w) => w.id === activeWorkspaceId);
        if (!workspace) return;
        const running = Object.values(useTerminalsStore.getState().byId).filter(
          (t) => t.workspaceId === workspace.id && t.status === "running",
        );
        if (running.length > 0) {
          const ok = await confirmAction({
            title: "Close workspace",
            message: `Close “${workspace.name}”? ${running.length} pane${
              running.length === 1 ? " is" : "s are"
            } still running.`,
            detail:
              "Every pane's process is killed and the workspace leaves the sidebar. Save it as a session first (⌘⇧S) if you want it back.",
            confirmLabel: "Close workspace",
            tone: "danger",
          });
          if (!ok) return;
        }
        closeWorkspace(workspace.id);
      },
    },
    {
      id: "workspace.browse-sessions",
      title: "Browse saved sessions",
      group: "Workspace",
      keywords: ["session", "restore", "reopen", "history"],
      run: () => ui().openSettings("history"),
    },

    // Panes --------------------------------------------------------------
    // One entry, not two: ⌘N and ⌘D are the same call — a new agent in a pane
    // split off to the right of the focused one. Two search results that do
    // exactly the same thing is noise in a list whose whole job is narrowing,
    // so the second chord lives in the keywords and in Settings › Shortcuts.
    {
      id: "pane.new",
      title: "New pane beside the focused one",
      group: "Panes",
      shortcut: "⌘N",
      keywords: ["split right", "⌘D", "terminal", "agent", "add"],
      enabled: () => onTerminals() && hasPaneRoomHere(),
      run: () => {
        splitFocused("row");
      },
    },
    {
      id: "pane.split-down",
      title: "Split the focused pane downwards",
      group: "Panes",
      shortcut: "⌘⇧D",
      keywords: ["horizontal", "below", "terminal", "new pane"],
      enabled: () => onTerminals() && hasPaneRoomHere(),
      run: () => {
        splitFocused("column");
      },
    },
    {
      id: "pane.close",
      title: "Close the focused pane",
      group: "Panes",
      shortcut: "⌘W",
      keywords: ["kill", "terminal", "quit"],
      enabled: () => onTerminals() && ui().focusedTerminalId !== null,
      run: () => closeFocusedPane(),
    },
    {
      id: "pane.maximize",
      title: "Maximize the focused pane",
      group: "Panes",
      keywords: ["zoom", "full", "focus mode"],
      enabled: () => {
        const s = ui();
        return (
          onTerminals() &&
          s.focusedTerminalId !== null &&
          s.maximizedTerminalId !== s.focusedTerminalId
        );
      },
      run: () => {
        const focused = ui().focusedTerminalId;
        if (focused) ui().maximizeTerminal(focused);
      },
    },
    {
      id: "pane.restore",
      title: "Restore the maximized pane",
      group: "Panes",
      keywords: ["unzoom", "exit full", "focus mode"],
      enabled: () => onTerminals() && ui().maximizedTerminalId !== null,
      run: () => ui().exitMaximize(),
    },
    {
      id: "pane.launch-all",
      title: "Launch every pane in this workspace",
      group: "Panes",
      keywords: ["start", "restart", "agents", "spawn"],
      enabled: () => onTerminals() && activePaneIds().length > 0,
      // Through the topbar button's own function, which is where the
      // confirmation lives: a launch KILLS whatever each pane is doing first,
      // and this row reached that from three keystrokes without asking.
      run: () => launchPanes(activePaneIds()),
    },
    {
      id: "pane.stop-all",
      title: "Stop every pane in this workspace",
      group: "Panes",
      keywords: ["kill", "halt", "agents"],
      enabled: () => onTerminals() && activePaneIds().length > 0,
      run: () => {
        for (const id of activePaneIds()) {
          commands.terminalKill(id).catch(() => {
            /* non-fatal: the child may already be gone */
          });
        }
      },
    },

    // The right panel. The editor's own actions (save, quick open) belong to
    // the editor and register themselves; these five are the shell's — which of
    // the panel's modes is on screen, and whether the panel is.
    //
    // All five carry `hasWorkspace()`, and that is the same rule `rocplan.open`
    // follows one group down: the panel is part of `AppShell`, which `App` only
    // renders once there is a workspace, while the palette is mounted OUTSIDE
    // that gate so ⌘K works from the empty state. Every row here without the
    // check was a row the empty state offered, ran, and had nothing to show for
    // — it wrote a flag into a store whose reader is not mounted.
    {
      id: "panel.inspector",
      title: "Show the Inspector",
      group: "Editor",
      keywords: ["right panel", "session", "agent config", "permissions"],
      enabled: () => hasWorkspace() !== null && panelHidden("inspector"),
      run: () => showPanel("inspector"),
    },
    {
      id: "panel.browser",
      title: "Show the Browser",
      group: "Editor",
      keywords: ["right panel", "preview", "localhost", "web"],
      enabled: () => hasWorkspace() !== null && panelHidden("browser"),
      run: () => showPanel("browser"),
    },
    {
      id: "panel.editor",
      title: "Show the Editor",
      group: "Editor",
      // "panel" and "files" came from `editor.show`, which used to say the
      // same thing from `useEditorCommands` without a guard. This row is the
      // whole affordance now, so it answers to both vocabularies.
      keywords: ["right panel", "panel", "code", "monaco", "file", "files"],
      enabled: () => hasWorkspace() !== null && panelHidden("editor"),
      run: () => showPanel("editor"),
    },
    {
      id: "panel.hide",
      title: "Hide the side panel",
      group: "Editor",
      keywords: ["right panel", "collapse", "full width"],
      enabled: () =>
        hasWorkspace() !== null &&
        !useEditorStore.getState().rightPanelCollapsed,
      run: () => useEditorStore.getState().setRightPanelCollapsed(true),
    },
    {
      id: "panel.show",
      title: "Show the side panel",
      group: "Editor",
      keywords: ["right panel", "expand"],
      enabled: () =>
        hasWorkspace() !== null &&
        useEditorStore.getState().rightPanelCollapsed,
      run: () => useEditorStore.getState().setRightPanelCollapsed(false),
    },

    // RocPlan ------------------------------------------------------------
    {
      id: "rocplan.open",
      title: "Show the RocPlan board",
      group: "RocPlan",
      shortcut: "⌘⇧P",
      keywords: ["kanban", "tasks", "cards", "plan"],
      // The board plans against a project, so with no workspace there is
      // nothing for it to be a board OF — the same answer ⌘⇧P gives.
      enabled: () => ui().mainView !== "rocplan" && hasWorkspace() !== null,
      run: () => ui().setMainView("rocplan"),
    },
    {
      id: "rocplan.close",
      title: "Leave the RocPlan board",
      group: "RocPlan",
      shortcut: "⌘⇧P",
      keywords: ["terminals", "back", "close board"],
      enabled: () => ui().mainView === "rocplan",
      run: () => ui().setMainView("terminals"),
    },
    {
      id: "rocplan.new-task",
      title: "New RocPlan card…",
      group: "RocPlan",
      keywords: ["task", "todo", "add", "create"],
      enabled: () => activeProjectPath() !== null,
      // The board FIRST, then the dialog — the order is the whole of this row
      // working. `TaskModal` is mounted app-wide, so it opens over the
      // terminals happily enough; what it cannot do is save, because `mutate`
      // refuses a project the store is not following, and nothing here had
      // read one. The user filled in a card, pressed Create, and was told
      // nothing was saved — with Cancel the only way out and the draft going
      // with it. `ensureBoardLoaded` resolves without reading when the board is
      // already live, so this costs nothing on the common path.
      run: async () => {
        const projectPath = activeProjectPath();
        if (!projectPath) return;
        await ensureBoardLoaded(projectPath);
        ui().openTaskEditor(projectPath, null);
      },
    },

    // RocMind ------------------------------------------------------------
    {
      id: "rocmind.open",
      title: "Show RocMind",
      group: "RocMind",
      shortcut: "⌘⇧M",
      keywords: ["memory", "memories", "notes", "knowledge", "graph", "recall"],
      // The corpus is the machine's rather than a project's, so this row USED
      // to skip the workspace check the board's `rocplan.open` makes. That was
      // reasoning about RocMind and not about where it is drawn: `MindView` is
      // rendered by `AppShell`, and `App` only renders the shell once there is
      // a workspace. With none, this moved `mainView` to a surface nothing was
      // mounted to show — and the chord that would move it back (⌘⇧M) lives in
      // the shell too, so the next ⌘T opened the new workspace onto RocMind
      // instead of onto its panes.
      enabled: () => hasWorkspace() !== null && ui().mainView !== "rocmind",
      run: () => ui().setMainView("rocmind"),
    },
    {
      id: "rocmind.close",
      title: "Leave RocMind",
      group: "RocMind",
      shortcut: "⌘⇧M",
      keywords: ["terminals", "back", "close memories"],
      enabled: () => ui().mainView === "rocmind",
      run: () => ui().setMainView("terminals"),
    },

    // Roc ----------------------------------------------------------------
    //
    // The same gate as RocMind above, for the same reason: `RocView` and the
    // widget are both `AppShell`'s, and so is ⌘⇧R.
    {
      id: "roc.open",
      title: "Show Roc",
      group: "Roc",
      shortcut: "⌘⇧R",
      keywords: ["orchestrator", "dispatch", "broadcast", "sessions"],
      enabled: () => hasWorkspace() !== null && ui().mainView !== "roc",
      run: () => useRocStore.getState().setExpanded(true),
    },
    {
      id: "roc.close",
      title: "Leave Roc",
      group: "Roc",
      shortcut: "⌘⇧R",
      keywords: ["terminals", "back", "collapse"],
      enabled: () => ui().mainView === "roc",
      run: () => useRocStore.getState().setExpanded(false),
    },
    {
      id: "roc.show-widget",
      title: "Show the Roc widget",
      group: "Roc",
      keywords: ["orb", "floating", "mic", "voice"],
      enabled: () => hasWorkspace() !== null && !useRocStore.getState().open,
      run: () => useRocStore.getState().toggleOpen(),
    },
    {
      id: "roc.hide-widget",
      title: "Hide the Roc widget",
      group: "Roc",
      keywords: ["orb", "floating", "dismiss"],
      enabled: () => hasWorkspace() !== null && useRocStore.getState().open,
      run: () => useRocStore.getState().toggleOpen(),
    },

    // Voice --------------------------------------------------------------
    //
    // Both carry `hasWorkspace()` for the same reason the panel rows do, and
    // here the promise in the title is what makes it matter: `useRocTalk` is
    // mounted by `AppShell`, so with no workspace nothing registers the
    // push-to-talk accelerator, nothing opens the microphone and no widget
    // draws the state. The flag would flip and persist — and "dictation is on"
    // would be a sentence about nothing until a workspace existed.
    {
      id: "voice.enable",
      title: "Turn RocTalk dictation on",
      group: "Voice",
      keywords: ["speech", "microphone", "push to talk", "whisper"],
      enabled: () =>
        hasWorkspace() !== null && !useRocTalkStore.getState().enabled,
      run: () => useRocTalkStore.getState().setEnabled(true),
    },
    {
      id: "voice.disable",
      title: "Turn RocTalk dictation off",
      group: "Voice",
      keywords: ["speech", "microphone", "mute", "push to talk"],
      enabled: () =>
        hasWorkspace() !== null && useRocTalkStore.getState().enabled,
      run: () => useRocTalkStore.getState().setEnabled(false),
    },
    // The mode the widget's switch flips, reachable without the widget. A pair
    // whose `enabled()` are each other's negation, per the note at the top:
    // only the one that would change something is ever offered, and both go
    // through `setVoiceOption` so Settings, the widget and this agree.
    {
      id: "voice.route-terminal",
      title: "Switch Roc to dictation",
      group: "Voice",
      keywords: ["dictate", "type", "terminal", "pane", "transcript", "route"],
      enabled: () => useSettingsStore.getState().voice.routeTo !== "terminal",
      run: () =>
        useSettingsStore.getState().setVoiceOption("routeTo", "terminal"),
    },
    {
      id: "voice.route-roc",
      title: "Switch Roc to conversation",
      group: "Voice",
      keywords: ["talk", "ask", "orchestrator", "transcript", "route"],
      enabled: () => useSettingsStore.getState().voice.routeTo !== "roc",
      run: () => useSettingsStore.getState().setVoiceOption("routeTo", "roc"),
    },

    // Settings -----------------------------------------------------------
    {
      id: "view.zoom-in",
      title: "Zoom in",
      group: "Settings",
      shortcut: "⌘+",
      keywords: ["bigger", "larger", "font size", "scale"],
      enabled: () =>
        useSettingsStore.getState().zoom < ZOOM_STEPS[ZOOM_STEPS.length - 1]!,
      run: () => {
        const { zoom, setZoom } = useSettingsStore.getState();
        setZoom(zoomIn(zoom));
      },
    },
    {
      id: "view.zoom-out",
      title: "Zoom out",
      group: "Settings",
      shortcut: "⌘−",
      keywords: ["smaller", "font size", "scale"],
      enabled: () => useSettingsStore.getState().zoom > ZOOM_STEPS[0]!,
      run: () => {
        const { zoom, setZoom } = useSettingsStore.getState();
        setZoom(zoomOut(zoom));
      },
    },
    {
      id: "view.zoom-reset",
      title: "Reset the zoom to 100%",
      group: "Settings",
      shortcut: "⌘0",
      keywords: ["actual size", "default", "scale"],
      enabled: () => useSettingsStore.getState().zoom !== DEFAULT_ZOOM,
      run: () => useSettingsStore.getState().setZoom(DEFAULT_ZOOM),
    },
    {
      id: "help.whats-new",
      title: "What's new in this build",
      group: "Settings",
      keywords: ["changelog", "release notes", "changes", "version"],
      // `WhatsNewModal` renders null without an entry to show, while
      // `isWhatsNewOpen` still counts towards `blockingModalOpen` — so an empty
      // changelog would leave every chord in the app standing down for a dialog
      // that is not on screen and has no Escape to press. Settings › About asks
      // this question before offering its button; this row did not.
      enabled: () => LATEST_ENTRY !== null,
      run: () => ui().openWhatsNew(),
    },
    ...settingsCommands(),
    ...themeCommands(),
  ];
}
