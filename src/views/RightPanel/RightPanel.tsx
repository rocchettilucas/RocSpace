import { FileCode, GitBranch, MonitorPlay, Settings2 } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  useEditorStore,
  useRightDockMode,
  useRightPanelCollapsed,
} from "@/stores";
import type { RightDockMode } from "@/stores";
import { GitView } from "@/views/RightPanel/GitView";
import { InspectorView } from "@/views/RightPanel/InspectorView";
import { WebPreview } from "@/views/WebPreview/WebPreview";
import { EditorView } from "@/views/RocDock/EditorView/EditorView";

interface ModeDef {
  mode: RightDockMode;
  label: string;
  icon: React.ReactNode;
}

const MODES: ModeDef[] = [
  {
    mode: "inspector",
    label: "Inspector",
    icon: <Settings2 className="h-3.5 w-3.5" />,
  },
  {
    mode: "browser",
    label: "Browser",
    icon: <MonitorPlay className="h-3.5 w-3.5" />,
  },
  {
    mode: "editor",
    label: "Editor",
    icon: <FileCode className="h-3.5 w-3.5" />,
  },
  {
    mode: "git",
    label: "Git",
    icon: <GitBranch className="h-3.5 w-3.5" />,
  },
];

/** Right-side dock that swaps between four views. The mode persists per-app
 *  (via useEditorStore + persistence.ts) so it survives reloads. Focusing a
 *  terminal updates the underlying focused-terminal id but does NOT change
 *  the mode — mode is a deliberate user choice. */
export function RightPanel() {
  const mode = useRightDockMode();
  const setMode = useEditorStore((s) => s.setRightDockMode);
  const collapsed = useRightPanelCollapsed();

  // When the topbar toggle collapses the panel, render nothing so child
  // components (notably WebPreview, which owns a native child webview)
  // unmount and their cleanup effects fire. react-resizable-panels otherwise
  // keeps children mounted at width 0 — leaving the native webview alive
  // and visually painting over the rest of the app.
  if (collapsed) return null;

  return (
    <aside className="flex h-full min-h-0 flex-col bg-surface-1">
      <header className="flex h-9 shrink-0 items-center justify-center border-b border-border px-2">
        <SegmentedControl active={mode} onChange={setMode} />
      </header>
      <div className="flex min-h-0 flex-1 flex-col">
        {mode === "inspector" ? <InspectorView /> : null}
        {mode === "browser" ? <WebPreview /> : null}
        {mode === "editor" ? <EditorView compact /> : null}
        {mode === "git" ? <GitView /> : null}
      </div>
    </aside>
  );
}

/** Icons always, the LABEL only for the mode that is on.
 *
 *  Four labelled buttons do not fit: the panel's minimum is 18% of the window,
 *  and four words plus their icons need about 290 px — so on any laptop the
 *  control overflowed its own header the moment Git joined it. Naming just the
 *  active one keeps "what am I looking at" on screen and leaves the other three
 *  as what they already were to a screen reader and a hover: `title` and
 *  `aria-label`, both unchanged. */
function SegmentedControl({
  active,
  onChange,
}: {
  active: RightDockMode;
  onChange: (m: RightDockMode) => void;
}) {
  return (
    <div className="inline-flex items-center gap-0.5 rounded-md bg-surface-2 p-0.5">
      {MODES.map((m) => {
        const isActive = m.mode === active;
        return (
          <button
            key={m.mode}
            type="button"
            onClick={() => onChange(m.mode)}
            title={m.label}
            aria-label={m.label}
            aria-pressed={isActive}
            className={cn(
              "flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors",
              isActive
                ? "bg-surface-0 text-fg-primary shadow-sm"
                : "text-fg-secondary hover:bg-surface-3 hover:text-fg-primary",
            )}
          >
            {m.icon}
            {isActive ? <span>{m.label}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
