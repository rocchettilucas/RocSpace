import {
  AudioLines,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Play,
  Settings,
  Square,
  SquareKanban,
} from "lucide-react";
import { useMemo } from "react";
import {
  useActiveWorkspace,
  useActiveWorkspacePaneTree,
  useEditorStore,
  useRightPanelCollapsed,
  useRocOpen,
  useRocStore,
  useSidebarCollapsed,
  useUIStore,
} from "@/stores";
import { accentVar } from "@/lib/accentColors";
import { commands } from "@/lib/bindings";
import { leafIds } from "@/lib/paneTree";
import { cn, pathTail } from "@/lib/utils";
import { launchPanes } from "@/views/RocDock/paneActions";
import rocLogo from "@/assets/roc-logo.png";
import { useAppVersion } from "@/hooks/useAppVersion";
import { NotificationBell } from "@/views/Topbar/NotificationBell";

export function Topbar() {
  const version = useAppVersion();
  const workspace = useActiveWorkspace();
  const paneTree = useActiveWorkspacePaneTree();
  const rocOpen = useRocOpen();
  const toggleRocOpen = useRocStore((s) => s.toggleOpen);
  const rightPanelCollapsed = useRightPanelCollapsed();
  const toggleRightPanel = useEditorStore((s) => s.toggleRightPanelCollapsed);
  const sidebarCollapsed = useSidebarCollapsed();
  const toggleSidebar = useEditorStore((s) => s.toggleSidebarCollapsed);
  const isSettingsOpen = useUIStore((s) => s.isSettingsOpen);
  const toggleSettings = useUIStore((s) => s.toggleSettings);
  const mainView = useUIStore((s) => s.mainView);

  // The active workspace's panes, from its tree — which is what "all" means
  // here. Read off the tree rather than by filtering sessions so the two
  // buttons act on exactly what is on screen.
  const paneIds = useMemo(
    () => (paneTree ? leafIds(paneTree) : []),
    [paneTree],
  );

  // `launchPanes` owns the confirmation, because terminalSpawn kills any
  // running PTY first: this button is "restart everything", and over a dock
  // that is mid-conversation it throws those conversations away. The palette's
  // "Launch every pane" calls the same function, so the two ask the same
  // question at the same moment.
  const handleLaunchAll = () => {
    void launchPanes(paneIds);
  };

  const handleStopAll = () => {
    for (const id of paneIds) {
      commands.terminalKill(id).catch(() => {
        /* non-fatal */
      });
    }
  };

  return (
    <header
      className={cn(
        "relative flex h-11 items-center justify-between border-b border-border bg-surface-1 px-3",
        "select-none",
      )}
    >
      {/* Center: who you are working on. Absolute so it centers on the window,
          not on whatever the two flex clusters happen to measure. Settings
          covers the dock, so while it is up it says so instead. */}
      <div className="pointer-events-none absolute inset-y-0 left-1/2 flex max-w-[45%] -translate-x-1/2 items-center gap-1.5 text-xs">
        {isSettingsOpen ? (
          <span className="flex items-center gap-1.5 font-medium text-fg-secondary">
            <Settings className="h-3.5 w-3.5" />
            Settings
          </span>
        ) : workspace ? (
          <>
            <span
              aria-hidden
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ background: accentVar(workspace.accent) }}
            />
            <span className="truncate font-medium text-fg-primary">
              {workspace.name}
            </span>
            {/* What the main area is showing. On the board that is the board —
                the directory is already in the board's own project chip, and
                saying it twice would leave the topbar naming a surface that is
                not on screen. */}
            {mainView === "rocplan" ? (
              <>
                <span className="shrink-0 text-fg-muted">›</span>
                <span className="flex shrink-0 items-center gap-1 text-fg-secondary">
                  <SquareKanban className="h-3.5 w-3.5" />
                  RocPlan
                </span>
              </>
            ) : workspace.projectPath ? (
              <>
                <span className="shrink-0 text-fg-muted">›</span>
                <span
                  className="truncate text-fg-muted"
                  title={workspace.projectPath}
                >
                  {pathTail(workspace.projectPath)}
                </span>
              </>
            ) : null}
          </>
        ) : null}
      </div>

      {/* Left: the sidebar's toggle, then the brand.
          The toggle leads because it belongs to the panel directly beneath it,
          and its icon is the mirror of the right panel's at the other end of
          the bar — the two controls read as one pair holding the dock between
          them. */}
      <div className="flex items-center gap-2">
        <TopbarButton
          icon={
            sidebarCollapsed ? (
              <PanelLeftOpen className="h-3.5 w-3.5" />
            ) : (
              <PanelLeftClose className="h-3.5 w-3.5" />
            )
          }
          label={sidebarCollapsed ? "Show workspaces" : "Hide workspaces"}
          variant="ghost"
          active={sidebarCollapsed}
          onClick={toggleSidebar}
          iconOnly
        />
        <img
          src={rocLogo}
          alt="Roc"
          draggable={false}
          className="h-6 w-6 select-none object-contain"
        />
        <span className="text-sm font-semibold tracking-tight text-fg-primary">
          RocSpace
        </span>
        {/* Metadata, not branding: quiet enough that the wordmark stays the
            thing you read, present enough to answer "which build is this?"
            without opening Settings. Absent rather than "v?" before the
            runtime answers — see useAppVersion. */}
        {version ? (
          <span
            title={`RocSpace ${version}`}
            className="select-none rounded-full border border-border bg-surface-2 px-1.5 py-px text-[10px] font-medium leading-4 tabular-nums text-fg-muted"
          >
            v{version}
          </span>
        ) : null}
      </div>

      {/* Right: global controls */}
      <div className="flex items-center gap-1">
        <TopbarButton
          icon={<Play className="h-3.5 w-3.5" />}
          label="Launch all"
          onClick={handleLaunchAll}
          disabled={paneIds.length === 0}
        />
        <TopbarButton
          icon={<Square className="h-3.5 w-3.5" />}
          label="Stop all"
          variant="ghost"
          onClick={handleStopAll}
          disabled={paneIds.length === 0}
        />
        <span className="mx-1 h-4 w-px bg-border" />
        {/* The way back to a widget the user closed — and the only one, which
            is why it is here rather than in a menu. Voice on/off moved onto the
            widget itself when the pill became it (Settings › Voice still holds
            the same flag), so the topbar asks the one question the widget
            cannot ask about itself: are you there? */}
        <TopbarButton
          icon={<AudioLines className="h-3.5 w-3.5" />}
          label={rocOpen ? "Hide Roc" : "Show Roc"}
          variant="ghost"
          active={rocOpen}
          onClick={toggleRocOpen}
          iconOnly
        />
        <span className="mx-1 h-4 w-px bg-border" />
        <NotificationBell />
        <TopbarButton
          icon={<Settings className="h-3.5 w-3.5" />}
          label="Settings"
          variant="ghost"
          active={isSettingsOpen}
          onClick={() => toggleSettings()}
          iconOnly
        />
        <TopbarButton
          icon={
            rightPanelCollapsed ? (
              <PanelRightOpen className="h-3.5 w-3.5" />
            ) : (
              <PanelRightClose className="h-3.5 w-3.5" />
            )
          }
          label={rightPanelCollapsed ? "Show side panel" : "Hide side panel"}
          variant="ghost"
          active={rightPanelCollapsed}
          onClick={toggleRightPanel}
          iconOnly
        />
      </div>
    </header>
  );
}

function TopbarButton({
  icon,
  label,
  variant = "default",
  onClick,
  disabled = false,
  active = false,
  iconOnly = false,
}: {
  icon: React.ReactNode;
  label: string;
  variant?: "default" | "ghost";
  onClick?: () => void;
  disabled?: boolean;
  active?: boolean;
  iconOnly?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={cn(
        "flex items-center rounded-md text-xs font-medium transition-colors",
        iconOnly ? "h-7 w-7 justify-center" : "gap-1.5 px-2.5 py-1",
        variant === "default"
          ? "bg-surface-2 text-fg-primary hover:bg-surface-3"
          : active
            ? "bg-surface-3 text-fg-primary"
            : "text-fg-secondary hover:bg-surface-2 hover:text-fg-primary",
        disabled && "cursor-not-allowed opacity-40 hover:bg-transparent",
      )}
    >
      {icon}
      {!iconOnly && label}
    </button>
  );
}
