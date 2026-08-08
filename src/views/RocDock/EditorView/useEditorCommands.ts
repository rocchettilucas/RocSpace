/** What the editor contributes to the command palette.
 *
 *  Registered from a hook rather than at module load so the actions come and go
 *  with the shell that can perform them — and so nothing is registered twice by
 *  a module being imported from two places.
 *
 *  `enabled` matters more here than anywhere: "Save all" with nothing unsaved
 *  and "Revert" on a clean file are rows that can only disappoint, and the
 *  palette asks these the moment it opens. `run` reads the stores imperatively
 *  because these closures outlive any render — they are handed to a registry,
 *  not to a component. */

import { useEffect } from "react";
import { registerCommands } from "@/lib/commands/registry";
import { useEditorStore, useUIStore, useWorkspacesStore } from "@/stores";

/** The active workspace's project directory, or null. Both ⌘P and the editor
 *  panel are useless without one. */
function projectRoot(): string | null {
  const { workspaces, activeWorkspaceId } = useWorkspacesStore.getState();
  return (
    workspaces.find((w) => w.id === activeWorkspaceId)?.projectPath ?? null
  );
}

function activeIsDirty(): boolean {
  const { activePath, dirtyByPath } = useEditorStore.getState();
  return activePath !== null && dirtyByPath[activePath] !== undefined;
}

/** Show the editor panel, expanded. Three of the actions below end this way:
 *  doing something to a file the user cannot see reads as nothing happening. */
function revealEditor(): void {
  useEditorStore.getState().setRightDockMode("editor");
  useEditorStore.getState().setRightPanelCollapsed(false);
}

export function useEditorCommands(): void {
  useEffect(
    () =>
      registerCommands([
        {
          id: "editor.quick-open",
          title: "Go to file…",
          group: "Editor",
          keywords: ["open", "find", "file", "search", "quick open"],
          shortcut: "⌘P",
          enabled: () => projectRoot() !== null,
          run: () => useUIStore.getState().openQuickOpen(),
        },
        {
          id: "editor.save",
          title: "Save the current file",
          group: "Editor",
          keywords: ["write", "disk"],
          shortcut: "⌘S",
          enabled: activeIsDirty,
          run: () => useEditorStore.getState().save(),
        },
        {
          id: "editor.save-all",
          title: "Save all files",
          group: "Editor",
          keywords: ["write", "disk", "everything"],
          // No chord: ⌘⇧S is the session save, and a second meaning for it
          // would be a coin toss. This row is the whole affordance.
          enabled: () =>
            Object.keys(useEditorStore.getState().dirtyByPath).length > 0,
          run: () => useEditorStore.getState().saveAll(),
        },
        {
          id: "editor.revert",
          title: "Revert the current file",
          group: "Editor",
          keywords: ["discard", "undo", "reload", "disk"],
          enabled: activeIsDirty,
          run: () => {
            const { activePath, revert } = useEditorStore.getState();
            if (activePath) revert(activePath);
            revealEditor();
          },
        },
        {
          id: "editor.close-tab",
          title: "Close the current file",
          group: "Editor",
          keywords: ["tab"],
          // No `enabled` guard against unsaved work on purpose: the tab strip's
          // confirmation is on the CLOSE BUTTON, and a palette row that closed
          // a dirty tab outright would walk around it. So it asks the same
          // question, through the same dialog.
          enabled: () => useEditorStore.getState().activePath !== null,
          run: () => {
            const { activePath, dirtyByPath, closeTab } =
              useEditorStore.getState();
            if (!activePath) return;
            if (dirtyByPath[activePath] !== undefined) {
              useUIStore
                .getState()
                .openEditorPrompt({ type: "unsaved-close", path: activePath });
              return;
            }
            closeTab(activePath);
          },
        },
        // There is deliberately no "Show the editor" here. `panel.editor` in
        // the palette's built-ins is the same two store writes, it is
        // registered whether or not this hook is mounted, and — the half that
        // matters — it carries the guard this row never had: when the editor is
        // already up, the guarded row disappears and an unguarded near-duplicate
        // beside it would be the only one left, offering to do what is already
        // done. Two rows with the same title were noise in a list whose whole
        // job is narrowing; one of them being a no-op made it worse.
      ]),
    [],
  );
}
