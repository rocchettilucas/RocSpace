import { lazy, Suspense, useRef, useState } from "react";
import {
  Group,
  Panel,
  Separator,
  type PanelImperativeHandle,
} from "react-resizable-panels";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  useActiveEditorPath,
  useActiveWorkspace,
  useEditorStore,
  useIsDirty,
} from "@/stores";
import { FileTree } from "@/views/RocDock/EditorView/FileTree";
import { TabStrip } from "@/views/RocDock/EditorView/TabStrip";

// Monaco is heavy (~3-5 MB after worker chunks) — defer loading until the
// editor view is actually opened.
const MonacoPane = lazy(() => import("./MonacoPane"));

interface EditorViewProps {
  /** When true, the file tree starts collapsed and a leading toggle button
   *  is shown on the toolbar row. Use in narrow contexts (e.g. RightPanel). */
  compact?: boolean;
}

export function EditorView({ compact = false }: EditorViewProps) {
  // The editor browses the ACTIVE workspace's directory: it is the one the
  // dock beside it is showing, so switching workspaces switches the tree.
  const projectRoot = useActiveWorkspace()?.projectPath ?? null;
  const treePanelRef = useRef<PanelImperativeHandle | null>(null);
  const [treeOpen, setTreeOpen] = useState(!compact);

  if (!projectRoot) {
    return (
      <div className="grid h-full place-items-center bg-surface-0 text-xs text-fg-muted">
        Open a project to browse files.
      </div>
    );
  }

  const toggleTree = () => {
    const panel = treePanelRef.current;
    if (!panel) return;
    if (panel.isCollapsed()) {
      panel.expand();
      setTreeOpen(true);
    } else {
      panel.collapse();
      setTreeOpen(false);
    }
  };

  return (
    <div className="h-full bg-surface-0">
      <Group
        id={compact ? "editor-horizontal-compact" : "editor-horizontal"}
        orientation="horizontal"
        className="h-full"
        defaultLayout={
          compact
            ? { "editor-tree": 0, "editor-main": 100 }
            : { "editor-tree": 25, "editor-main": 75 }
        }
      >
        <Panel
          id="editor-tree"
          panelRef={treePanelRef}
          defaultSize={compact ? "0%" : "25%"}
          minSize={compact ? "30%" : "12%"}
          maxSize={compact ? "70%" : "45%"}
          collapsible={compact}
          collapsedSize="0%"
          className="border-r border-border bg-surface-1"
        >
          <FileTree projectRoot={projectRoot} />
        </Panel>
        <Separator
          id={compact ? "editor-tree-sep-compact" : "editor-tree-sep"}
          className={cn(
            "shrink-0 cursor-col-resize bg-border transition-colors",
            "w-px hover:w-1 hover:bg-accent",
          )}
        />
        <Panel
          id="editor-main"
          defaultSize={compact ? "100%" : "75%"}
          minSize="40%"
        >
          <div className="flex h-full flex-col">
            <div className="flex h-8 shrink-0 items-stretch border-b border-border bg-surface-1">
              {compact ? (
                <button
                  type="button"
                  onClick={toggleTree}
                  title={treeOpen ? "Hide files" : "Show files"}
                  aria-label={treeOpen ? "Hide files" : "Show files"}
                  className={cn(
                    "grid h-full w-8 shrink-0 place-items-center border-r border-border text-fg-muted transition-colors",
                    "hover:bg-surface-2 hover:text-fg-primary",
                    treeOpen && "text-fg-primary",
                  )}
                >
                  {treeOpen ? (
                    <PanelLeftClose className="h-3.5 w-3.5" />
                  ) : (
                    <PanelLeftOpen className="h-3.5 w-3.5" />
                  )}
                </button>
              ) : null}
              <TabStrip />
              <SaveControls />
            </div>
            <div className="flex-1 overflow-hidden">
              <Suspense
                fallback={
                  <div className="grid h-full place-items-center text-xs text-fg-muted">
                    Loading editor…
                  </div>
                }
              >
                <MonacoPane projectRoot={projectRoot} />
              </Suspense>
            </div>
          </div>
        </Panel>
      </Group>
    </div>
  );
}

/** Save and Revert for the active tab, shown only while there is something to
 *  save.
 *
 *  ⌘S is the real gesture and the dot on the tab is the real signal, but
 *  neither is discoverable, and a revert with no button is a feature only
 *  somebody who read the palette knows about. Absent when the file is clean, so
 *  the toolbar does not carry two permanently disabled buttons. */
function SaveControls() {
  const path = useActiveEditorPath();
  const dirty = useIsDirty(path);
  const save = useEditorStore((s) => s.save);
  const revert = useEditorStore((s) => s.revert);

  if (!path || !dirty) return null;

  return (
    <div className="flex shrink-0 items-center gap-1 border-l border-border px-1.5">
      <button
        type="button"
        onClick={() => revert(path)}
        title="Discard the unsaved changes and reload from disk"
        className="rounded px-1.5 py-0.5 text-[11px] text-fg-muted hover:bg-surface-2 hover:text-fg-primary"
      >
        Revert
      </button>
      <button
        type="button"
        onClick={() => void save(path)}
        title="Save (⌘S)"
        className="rounded bg-accent px-2 py-0.5 text-[11px] font-medium text-accent-fg hover:opacity-90"
      >
        Save
      </button>
    </div>
  );
}
