/** One workspace in the sidebar's tablist.
 *
 *  36px, radius 8: accent-tinted terminal icon, name, pane-count pill,
 *  hover-reveal close; the active row takes a left accent bar and a tinted
 *  background. The row IS the tab — switching workspaces is the primary thing
 *  a click here does — so everything else on it (rename, close, accent) is a
 *  secondary affordance that stops its own click from reaching the tab. */

import { Terminal, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { WORKSPACE_ACCENTS, accentVar } from "@/lib/accentColors";
import { cn } from "@/lib/utils";
import { confirmAction, useTerminalsStore, useWorkspacesStore } from "@/stores";
import {
  runningSessionsIn,
  useWorkspacePaneCount,
} from "@/views/Sidebar/workspaceSessions";
import type { DropEdge } from "@/views/Sidebar/WorkspaceList";
import type { Workspace, WorkspaceAccent } from "@/lib/bindings";

/** Label for an accent swatch — the accent's own name, capitalized. Written
 *  here rather than as a table in `accentColors` so this component depends on
 *  nothing but the contracted three exports. */
const accentLabel = (accent: WorkspaceAccent) =>
  accent.charAt(0).toUpperCase() + accent.slice(1);

/** Gap between the row and the accent menu below it. */
const MENU_GAP = 4;

export function WorkspaceRow({
  workspace,
  active,
  tabStop,
  index,
  onActivate,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
  dropEdge,
}: {
  workspace: Workspace;
  active: boolean;
  /** Holds the list's one tab stop. Usually the active row, but not always —
   *  the list decides, because "which row does Tab reach" is a question about
   *  the list. */
  tabStop: boolean;
  index: number;
  onActivate: () => void;
  onDragStart: (index: number, e: React.DragEvent) => void;
  onDragEnd: () => void;
  onDragOver: (index: number, e: React.DragEvent) => void;
  onDrop: (index: number, e: React.DragEvent) => void;
  /** Draw the insertion line on this side of the row, or nowhere. A line
   *  rather than a ring: a ring says "into this row", which is not what a drop
   *  does, and reading it as "after it" going down and "before it" going up is
   *  exactly the ambiguity the line removes. */
  dropEdge: DropEdge | null;
}) {
  const renameWorkspace = useWorkspacesStore((s) => s.renameWorkspace);
  const setWorkspaceAccent = useWorkspacesStore((s) => s.setWorkspaceAccent);
  const closeWorkspace = useWorkspacesStore((s) => s.closeWorkspace);

  const accent = accentVar(workspace.accent);
  // The sessions, not the tree: see `workspaceSessions.ts` for why a workspace
  // can hold panes while its layout is still null.
  const paneCount = useWorkspacePaneCount(workspace.id);

  // The accent menu is portalled to the body — see the render below for why —
  // so it needs coordinates rather than a place in the flow. Non-null is what
  // "open" means; there is no moment where it should be up without them.
  const [menuAt, setMenuAt] = useState<{ top: number; left: number } | null>(
    null,
  );
  const rowRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const picking = menuAt !== null;

  /** Every way out of the menu that is not a pick. Focus goes back to the row:
   *  it left the tablist to reach the swatches, and dropping it on `<body>`
   *  would send the next Tab to the top of the app. */
  const dismissPicker = (restoreFocus: boolean) => {
    setMenuAt(null);
    if (restoreFocus) rowRef.current?.focus();
  };

  useEffect(() => {
    if (!picking) return;

    const reposition = () => {
      const rect = rowRef.current?.getBoundingClientRect();
      if (!rect) return;
      setMenuAt({ top: rect.bottom + MENU_GAP, left: rect.left });
    };

    // Escape on the DOCUMENT, not on the row: the swatches take focus when the
    // menu opens, and a handler on the row never hears a key pressed in them —
    // which left Escape working only from the one place the user was not.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismissPicker(true);
    };
    // A menu with no outside-click dismissal is a menu the user has to answer.
    // Capture, so a handler that stops propagation cannot strand it open.
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (rowRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      dismissPicker(false);
    };

    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onPointerDown, true);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onPointerDown, true);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
    // Bound for the lifetime of the open menu, and nothing inside the effect
    // reads anything that changes while it is up.
  }, [picking]);

  const handleClose = async () => {
    // Read imperatively rather than subscribing: a running-pane subscription in
    // every row would re-run on every PTY output chunk, and this answer is only
    // needed at the instant the button is pressed.
    const byId = useTerminalsStore.getState().byId;
    const running = runningSessionsIn(byId, workspace.id);
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
  };

  return (
    // No wrapper: a tablist owns tabs, and `role="presentation"` on a wrapper
    // does not hide what is inside it — it promotes the children, which made
    // the accent menu a direct child of the tablist. The row is the tab, and
    // the menu is portalled out of the list entirely.
    <>
      <div
        ref={rowRef}
        role="tab"
        aria-selected={active}
        // Roving tabindex: one stop for the whole list, the arrows move within
        // it. Named explicitly so the pane count and the close button inside do
        // not end up in the tab's own accessible name.
        tabIndex={tabStop ? 0 : -1}
        aria-label={`${workspace.name}, ${paneCount} pane${
          paneCount === 1 ? "" : "s"
        }`}
        title={workspace.projectPath ?? "No directory"}
        // The edge, in the DOM, so a test can assert the affordance the user
        // is shown rather than a colour.
        data-drop-edge={dropEdge ?? undefined}
        draggable
        onDragStart={(e) => onDragStart(index, e)}
        onDragEnd={onDragEnd}
        onDragOver={(e) => onDragOver(index, e)}
        onDrop={(e) => onDrop(index, e)}
        onClick={onActivate}
        onContextMenu={(e) => {
          e.preventDefault();
          if (picking) {
            dismissPicker(true);
            return;
          }
          const rect = e.currentTarget.getBoundingClientRect();
          setMenuAt({ top: rect.bottom + MENU_GAP, left: rect.left });
        }}
        onKeyDown={(e) => {
          // Enter/Space activate; the arrows belong to the list, which is where
          // they are handled, and Escape to the open menu's own listener.
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onActivate();
          }
        }}
        className={cn(
          "group relative flex h-9 shrink-0 cursor-pointer items-center gap-2 rounded-lg pl-2.5 pr-1.5",
          "text-xs outline-none transition-colors",
          active ? "text-fg-primary" : "text-fg-secondary hover:bg-surface-2",
          "focus-visible:ring-1 focus-visible:ring-accent",
        )}
        style={{
          background: active
            ? `color-mix(in srgb, ${accent} 12%, transparent)`
            : undefined,
          boxShadow: active ? `inset 3px 0 0 0 ${accent}` : undefined,
        }}
      >
        {dropEdge ? (
          <span
            aria-hidden
            className={cn(
              "pointer-events-none absolute inset-x-1 h-0.5 rounded-full bg-accent",
              // Half outside the row, so the line reads as the gap between two
              // rows rather than as a border belonging to this one.
              dropEdge === "before" ? "-top-px" : "-bottom-px",
            )}
          />
        ) : null}
        <Terminal
          aria-hidden
          className="h-3.5 w-3.5 shrink-0"
          style={{ color: accent }}
        />
        <WorkspaceName
          workspace={workspace}
          onRename={(name) => renameWorkspace(workspace.id, name)}
        />
        <span
          aria-hidden
          className="shrink-0 rounded-full px-1.5 py-px text-[10px] font-medium tabular-nums"
          style={{
            color: accent,
            background: `color-mix(in srgb, ${accent} 18%, transparent)`,
          }}
        >
          {paneCount}
        </span>
        {/* On every row, the last one included: closing it is allowed and
            lands on the empty state, which is a place the app knows how to be
            and tells the user how to leave. Hiding the control on the last row
            would make "close this workspace" mean something different
            depending on how many others happen to be open. */}
        <button
          type="button"
          aria-label={`Close ${workspace.name}`}
          title="Close workspace"
          onClick={(e) => {
            e.stopPropagation();
            void handleClose();
          }}
          className={cn(
            "grid h-5 w-5 shrink-0 place-items-center rounded text-fg-muted opacity-0",
            "transition-opacity hover:bg-error/15 hover:text-error",
            "group-hover:opacity-100 focus-visible:opacity-100",
          )}
        >
          <X className="h-3 w-3" />
        </button>
      </div>

      {/* Portalled to the body, the same way the notification dropdown is: a
          popover that lives inside the tablist is a popover the list has to
          explain to a screen reader, and one that the list's own scrolling and
          overflow get to clip. */}
      {menuAt
        ? createPortal(
            <div
              ref={menuRef}
              role="menu"
              aria-label={`Accent for ${workspace.name}`}
              style={{
                position: "fixed",
                top: menuAt.top,
                left: menuAt.left,
                zIndex: 1000,
              }}
              className={cn(
                "flex items-center gap-2 rounded-md border border-border bg-surface-2 px-2 py-1.5",
                "shadow-lg shadow-black/40",
              )}
            >
              {WORKSPACE_ACCENTS.map((option) => (
                <button
                  key={option}
                  type="button"
                  role="menuitemradio"
                  aria-checked={option === workspace.accent}
                  aria-label={accentLabel(option)}
                  title={accentLabel(option)}
                  // The menu takes the keyboard when it opens, landing on the
                  // accent the workspace already has — so the arrow keys and
                  // Escape have somewhere to be pressed, and the row is not
                  // still holding focus for a menu that is covering it.
                  autoFocus={option === workspace.accent}
                  onClick={() => {
                    setWorkspaceAccent(workspace.id, option);
                    dismissPicker(true);
                  }}
                  className={cn(
                    "h-3.5 w-3.5 rounded-full transition-transform hover:scale-125",
                    "outline-none focus-visible:scale-125",
                    option === workspace.accent
                      ? "ring-2 ring-fg-primary ring-offset-1 ring-offset-surface-2"
                      : "ring-1 ring-border-hover",
                  )}
                  style={{ background: accentVar(option) }}
                />
              ))}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

/** The workspace's name, renameable in place.
 *
 *  Same shape as `PaneHeader`'s `PaneTitle`, including the settled flag and
 *  where it is reset: Enter and Escape both unmount the input, so no blur
 *  arrives to clear the flag afterwards. Clearing it on blur is the bug —
 *  the flag then survives into the NEXT editing session and silently swallows
 *  that one's click-away commit, alternating forever. Reset on OPEN. */
function WorkspaceName({
  workspace,
  onRename,
}: {
  workspace: Workspace;
  onRename: (name: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const settled = useRef(false);

  const open = () => {
    settled.current = false;
    setDraft(workspace.name);
  };

  const finish = (commit: boolean) => {
    if (settled.current) return;
    settled.current = true;
    const next = draft?.trim() ?? "";
    setDraft(null);
    // An empty name would leave the workspace with nothing to be addressed by,
    // so it reads as a cancel rather than as a valid new name.
    if (commit && next && next !== workspace.name) onRename(next);
  };

  if (draft === null) {
    return (
      <span
        onDoubleClick={(e) => {
          e.stopPropagation();
          open();
        }}
        className="min-w-0 flex-1 truncate font-medium"
      >
        {workspace.name}
      </span>
    );
  }

  return (
    <input
      aria-label="Workspace name"
      value={draft}
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setDraft(e.target.value)}
      // A click in the field must not reach the row, which would switch
      // workspaces out from under the rename.
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        // Keeps the keystroke away from the tablist's arrow handling and from
        // the app-level chords bound closer to the document.
        e.stopPropagation();
        if (e.key === "Enter") finish(true);
        else if (e.key === "Escape") finish(false);
      }}
      // Clicking away commits, as every rename-in-place field does. `finish`
      // ignores this once a key has decided, so a blur on the way out cannot
      // undo an Escape.
      onBlur={() => finish(true)}
      className="min-w-0 flex-1 rounded-sm border border-border-active bg-surface-0 px-1 text-xs font-medium text-fg-primary outline-none"
    />
  );
}
