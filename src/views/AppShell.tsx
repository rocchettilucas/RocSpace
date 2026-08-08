import { Component, useEffect, type ReactNode } from "react";
import { Group, Panel, Separator, usePanelRef } from "react-resizable-panels";
import { cn } from "@/lib/utils";
import { Topbar } from "@/views/Topbar/Topbar";
import { Sidebar } from "@/views/Sidebar/Sidebar";
import { RocDock } from "@/views/RocDock/RocDock";
import { RightPanel } from "@/views/RightPanel/RightPanel";
import { useGitCommands } from "@/views/RightPanel/useGitCommands";
import { useGitShortcuts } from "@/views/RightPanel/useGitShortcuts";
import { BoardView } from "@/views/RocPlan/BoardView";
import { RocView } from "@/views/Roc/RocView";
import { useRocShortcuts } from "@/views/Roc/useRocShortcuts";
import { MindView } from "@/views/RocMind/MindView";
import { useMindMirror } from "@/views/RocMind/useMindMirror";
import { useMindShortcuts } from "@/views/RocMind/useMindShortcuts";
import { EditorPrompts } from "@/views/RocDock/EditorView/EditorPrompts";
import { useEditorCommands } from "@/views/RocDock/EditorView/useEditorCommands";
import { useEditorShortcuts } from "@/views/RocDock/EditorView/useEditorShortcuts";
import { useExternalChanges } from "@/views/RocDock/EditorView/useExternalChanges";
import { QuickOpenModal } from "@/views/QuickOpen/QuickOpenModal";
import { TaskModal } from "@/views/RocPlan/TaskModal";
import { SettingsOverlay } from "@/views/Settings/SettingsView";
import { RocWidget } from "@/components/RocWidget";
import { ToastStack } from "@/components/ToastStack";
import { useRocTalk } from "@/hooks/useRocTalk";
import {
  useEditorStore,
  useMainView,
  useRightPanelCollapsed,
  useSidebarCollapsed,
} from "@/stores";

/** Master layout: fixed Topbar over a horizontally-split workspace area
 *  (Sidebar / RocDock / RightPanel). The RightPanel itself swaps between
 *  Inspector / Browser / Editor modes via a segmented control in its header.
 *
 *  Layout strategy: outer div uses flexbox (not CSS grid) so that the
 *  react-resizable-panels Group always receives an explicit computed height.
 *  CSS grid + h-full gives the Group no concrete height during first layout
 *  measurement, causing all panels to collapse to 0px. */
export function AppShell() {
  // RocTalk listens for the global push-to-talk hotkey and writes dictation
  // into the focused terminal. Mounted here rather than in `App` so it only
  // becomes active once there is a workspace to dictate into.
  useRocTalk();

  // ⌘⇧R swaps the main area to Roc and back. Here rather than inside `RocView`
  // for the obvious reason: the chord that opens a view cannot be bound by the
  // view it opens.
  useRocShortcuts();

  // ⌘⇧M does the same for RocMind — same reason, same place.
  useMindShortcuts();

  // …and the mirror it is a view of: a Rust watch on every memory scope an
  // open workspace could write to, so a memory an agent writes in a pane shows
  // up without a reload. Here rather than in `MindView` precisely because the
  // user is looking at their panes when it happens.
  useMindMirror();

  // ⌘⇧K opens the Git panel on its commit box — same reason, one panel over:
  // the chord has to work while the panel is collapsed or showing something
  // else, so it cannot live inside the panel.
  useGitShortcuts();

  // …and the same actions through ⌘K. Registered from the shell rather than
  // from `GitView` because the palette has to be able to OPEN the panel, which
  // a command living inside the panel could not do.
  useGitCommands();
  // ⌘S and ⌘P, and the check for a file that changed underneath the editor.
  // Here rather than in the editor panel because none of the three needs the
  // panel to be open: a buffer stays dirty while the panel is collapsed, ⌘S
  // still has to save it, and an agent in the pane beside it can still edit the
  // file out from under it.
  useEditorShortcuts();
  useExternalChanges();
  // What the editor offers the command palette. Beside the chords rather than
  // in the panel for the same reason: the palette can reach an action whose
  // surface is not on screen, and that is most of the point of having one.
  useEditorCommands();

  // Imperative handle for the right-side Panel — used to drive collapse/expand
  // from the topbar toggle. The Panel also reports drag-collapse via onResize
  // so the toolbar icon stays in sync if the user drags the divider closed.
  const rightPanelRef = usePanelRef();
  const rightPanelCollapsed = useRightPanelCollapsed();
  const setRightPanelCollapsed = useEditorStore(
    (s) => s.setRightPanelCollapsed,
  );
  // The sidebar's half of the same arrangement. Two refs rather than one
  // generic helper because the two panels differ in everything except this
  // wiring — sizes, contents, and which side of the dock they sit on.
  const sidebarRef = usePanelRef();
  const sidebarCollapsed = useSidebarCollapsed();
  const setSidebarCollapsed = useEditorStore((s) => s.setSidebarCollapsed);
  const mainView = useMainView();

  // Sync persisted store state → panel imperative API. Without this, the
  // panel would render at its defaultSize even when the user previously had
  // it collapsed. We also re-sync on store changes (toggle button presses).
  useEffect(() => {
    const panel = rightPanelRef.current;
    if (!panel) return;
    const isCollapsed = panel.isCollapsed();
    if (rightPanelCollapsed && !isCollapsed) panel.collapse();
    else if (!rightPanelCollapsed && isCollapsed) panel.expand();
  }, [rightPanelCollapsed, rightPanelRef]);

  useEffect(() => {
    const panel = sidebarRef.current;
    if (!panel) return;
    const isCollapsed = panel.isCollapsed();
    if (sidebarCollapsed && !isCollapsed) panel.collapse();
    else if (!sidebarCollapsed && isCollapsed) panel.expand();
  }, [sidebarCollapsed, sidebarRef]);

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-surface-0 text-fg-primary">
      <Topbar />
      {/* min-h-0 is essential: flex items have min-height:auto by default,
          which prevents them from shrinking below content height. Without it
          the Group div never gets a concrete height for panel sizing. */}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <ShellErrorBoundary>
          <Group
            id="layout-horizontal"
            orientation="horizontal"
            className="absolute inset-0"
            defaultLayout={{ sidebar: 20, rocdock: 55, "right-panel": 25 }}
          >
            <Panel
              id="sidebar"
              panelRef={sidebarRef}
              defaultSize="20%"
              minSize="14%"
              maxSize="32%"
              collapsible
              collapsedSize="0%"
              onResize={(panelSize, _id, prevPanelSize) => {
                // Same contract as the right panel below: skip the mount fire,
                // then keep the toolbar icon honest when the user drags the
                // divider shut instead of pressing the button.
                if (prevPanelSize === undefined) return;
                const collapsed = (panelSize?.asPercentage ?? 0) <= 0;
                if (collapsed !== sidebarCollapsed) {
                  setSidebarCollapsed(collapsed);
                }
              }}
            >
              <Sidebar />
            </Panel>
            <ResizeBar id="sep-sidebar-rocdock" orientation="vertical" />
            <Panel id="rocdock" defaultSize="55%" minSize="30%">
              {/* Settings overlays the dock only — the sidebar and right panel
                  stay live, and RocDock stays mounted so terminals keep
                  streaming behind it.

                  RocPlan is a SWAP rather than an overlay, but the dock stays
                  mounted for the same reason: `hidden` takes it out of the
                  layout without unmounting a single xterm, so a board session
                  costs no output. The panes do not refit while they measure
                  zero (see `shouldMeasureTerminalElement`) and pick it back up
                  from the resize observer on the way back. */}
              <div className="relative h-full w-full">
                <div
                  className={cn(
                    "h-full w-full",
                    mainView !== "terminals" && "hidden",
                  )}
                >
                  <RocDock />
                </div>
                {mainView === "rocplan" ? <BoardView /> : null}
                {mainView === "roc" ? <RocView /> : null}
                {mainView === "rocmind" ? <MindView /> : null}
                <SettingsOverlay />
              </div>
            </Panel>
            <ResizeBar id="sep-rocdock-rightpanel" orientation="vertical" />
            <Panel
              id="right-panel"
              panelRef={rightPanelRef}
              defaultSize="25%"
              minSize="18%"
              maxSize="50%"
              collapsible
              collapsedSize="0%"
              onResize={(panelSize, _id, prevPanelSize) => {
                // panelSize is `{ asPercentage, inPixels }` — not a number.
                // Skip the initial mount fire (prevPanelSize === undefined): on
                // mount the panel renders at its defaultSize regardless of the
                // persisted collapsed flag, and the sync useEffect below is
                // what actually applies that flag. Reading mount fires here
                // would clobber the persisted state before the effect runs.
                if (prevPanelSize === undefined) return;
                const collapsed = (panelSize?.asPercentage ?? 0) <= 0;
                if (collapsed !== rightPanelCollapsed) {
                  setRightPanelCollapsed(collapsed);
                }
              }}
            >
              <RightPanel />
            </Panel>
          </Group>
        </ShellErrorBoundary>
        <RocWidget />
      </div>
      {/* Outside the error boundary and outside the panel group: the card
          editor is opened from the board but is not part of it, and it has to
          survive whatever the shell underneath is doing. Only ever mounted for
          a board, which only exists inside this shell — unlike ⌘T and ⌘⇧S,
          nothing opens it from the empty state. */}
      <TaskModal />
      {/* The editor's own two questions — a tab closing over unsaved work, a
          file that changed on disk under a dirty buffer. Out here for the same
          reason: the panel they belong to may well be collapsed when the
          question arises. */}
      <EditorPrompts />
      {/* ⌘P. Out here too — it opens over whatever the main area is showing,
          and the file it picks lands in a panel that may currently be
          collapsed (which is what picking one un-collapses). */}
      <QuickOpenModal />
      {/* Outside everything for the same reason, one step further: a toast
          reports what the app did while the user was looking elsewhere, so it
          must outlive the view that raised it. */}
      <ToastStack />
    </div>
  );
}

/** Visible drag handle. `orientation` describes the SPLIT axis. */
function ResizeBar({
  id,
  orientation,
}: {
  id: string;
  orientation: "vertical" | "horizontal";
}) {
  return (
    <Separator
      id={id}
      className={cn(
        "shrink-0 bg-border transition-colors",
        orientation === "vertical"
          ? "w-px cursor-col-resize hover:w-1 hover:bg-accent"
          : "h-px cursor-row-resize hover:h-1 hover:bg-accent",
      )}
    />
  );
}

/** Catches synchronous render errors inside the shell so the user sees a
 * readable message instead of a silent black screen. */
class ShellErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: { componentStack: string }) {
    console.error("[ShellErrorBoundary]", error, info.componentStack);
  }

  override render() {
    if (this.state.error) {
      const err = this.state.error as Error;
      return (
        <div className="grid h-full place-items-center bg-surface-0 p-8">
          <div className="flex max-w-2xl flex-col gap-3">
            <p className="text-sm font-semibold text-error">
              Shell render error — check the DevTools console for the full stack
              trace.
            </p>
            <pre className="overflow-auto rounded-md bg-surface-1 p-4 text-xs text-fg-secondary">
              {err.message}
              {"\n\n"}
              {err.stack}
            </pre>
            <button
              type="button"
              onClick={() => this.setState({ error: null })}
              className="self-start rounded-md bg-surface-2 px-3 py-1.5 text-xs text-fg-primary hover:bg-surface-3"
            >
              Retry
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
