import { Bell } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { AGENT_BADGE } from "@/lib/agentLabels";
import {
  useNotifications,
  useNotificationsStore,
  useUnreadCount,
  type Notification,
} from "@/stores/notifications";
import { useTerminalById, useUIStore, useWorkspacesStore } from "@/stores";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function notifBody(notif: Notification): string {
  const agent = AGENT_BADGE[notif.agentType];
  switch (notif.kind) {
    case "awaiting":
      return `${agent} is awaiting your approval`;
    case "turn-finished":
      // "its turn", not "finished": the agent is alive and waiting for your
      // next prompt, which is a different thing from the row below.
      return `${agent} finished its turn`;
    case "complete":
      return `${agent} exited`;
    case "error":
      return `${agent} exited with an error`;
    case "review":
      // Named after what is waiting rather than what happened: the pane is
      // done, and the thing that needs a person is the card.
      return "card ready for review";
  }
}

function relTime(ts: number): string {
  const secs = Math.floor((Date.now() - ts) / 1000);
  if (secs < 5) return "just now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

const KIND_CHIP: Record<Notification["kind"], string> = {
  awaiting: "bg-status-waiting/20 text-status-waiting",
  "turn-finished": "bg-status-complete/20 text-status-complete",
  complete: "bg-status-complete/20 text-status-complete",
  error: "bg-status-error/20 text-status-error",
  review: "bg-accent-soft text-accent",
};

const KIND_LABEL: Record<Notification["kind"], string> = {
  awaiting: "Awaiting",
  "turn-finished": "Finished",
  complete: "Complete",
  error: "Error",
  review: "Review",
};

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

function NotificationRow({
  notif,
  onAction,
}: {
  notif: Notification;
  onAction: () => void;
}) {
  const terminal = useTerminalById(notif.terminalId);
  const isGone = terminal === null;

  // Take the user to the pane, not just to the idea of it. A notification is
  // usually read while looking at something else — another workspace, the
  // board, Roc — and focusing a terminal that is not on screen changes nothing
  // the user can see. Worse, `focusTerminal` mirrors the id down onto whatever
  // workspace is ACTIVE, so focusing a pane belonging to another one would
  // leave this workspace remembering a pane that is not its own.
  //
  // Order matters: the workspace switch restores its own remembered focus, so
  // it has to happen before we set the focus we actually want.
  const handleClick = () => {
    if (isGone || !terminal) return;
    const ui = useUIStore.getState();

    const workspaces = useWorkspacesStore.getState();
    if (terminal.workspaceId !== workspaces.activeWorkspaceId) {
      workspaces.setActiveWorkspace(terminal.workspaceId);
    }
    // The dock is where panes live; the board and Roc cover it.
    ui.setMainView("terminals");
    // A different pane held full-screen would hide the one we are pointing at.
    if (ui.maximizedTerminalId && ui.maximizedTerminalId !== notif.terminalId) {
      ui.exitMaximize();
    }

    ui.focusTerminal(notif.terminalId);
    ui.setHighlight(notif.terminalId);
    useNotificationsStore.getState().markRead(notif.id);
    onAction();
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={(e) => e.key === "Enter" && handleClick()}
      className={cn(
        "relative flex cursor-pointer flex-col gap-1 rounded px-3 py-2 text-left",
        "transition-colors",
        isGone ? "cursor-default opacity-40" : "hover:bg-surface-3",
        !notif.read && !isGone && "pl-4",
      )}
    >
      {/* Unread accent stripe */}
      {!notif.read && !isGone ? (
        <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-accent" />
      ) : null}

      {/* Header row: agent chip + kind chip + timestamp */}
      <div className="flex items-center gap-1.5">
        <span className="rounded bg-surface-4 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-fg-secondary">
          {AGENT_BADGE[notif.agentType]}
        </span>
        <span
          className={cn(
            "rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider",
            KIND_CHIP[notif.kind],
          )}
        >
          {KIND_LABEL[notif.kind]}
        </span>
        <span className="ml-auto text-[10px] text-fg-muted">
          {relTime(notif.createdAt)}
        </span>
      </div>

      {/* Body: terminal name + message */}
      <p className="text-xs text-fg-primary leading-snug">
        <span className="font-medium">{notif.terminalName}</span>
        {" — "}
        {notifBody(notif)}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bell + Dropdown
// ---------------------------------------------------------------------------

const DROPDOWN_WIDTH = 300;
const DROPDOWN_GAP = 6;

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(
    null,
  );
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const notifications = useNotifications();
  const unread = useUnreadCount();

  useEffect(() => {
    if (!open) return;

    const reposition = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const r = trigger.getBoundingClientRect();
      let left = r.right - DROPDOWN_WIDTH;
      if (left < 8) left = 8;
      if (left + DROPDOWN_WIDTH > window.innerWidth - 8) {
        left = window.innerWidth - DROPDOWN_WIDTH - 8;
      }
      setCoords({ top: r.bottom + DROPDOWN_GAP, left });
    };

    reposition();

    const onDocPointer = (e: PointerEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t)) return;
      if (menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };

    document.addEventListener("pointerdown", onDocPointer, true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      document.removeEventListener("pointerdown", onDocPointer, true);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open]);

  const handleClearAll = (e: React.MouseEvent) => {
    e.stopPropagation();
    useNotificationsStore.getState().clearAll();
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label="Notifications"
        title="Notifications"
        onClick={() => {
          if (!open) useNotificationsStore.getState().markAllRead();
          setOpen((v) => !v);
        }}
        className={cn(
          "relative flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
          open
            ? "bg-surface-3 text-fg-primary"
            : "text-fg-secondary hover:bg-surface-2 hover:text-fg-primary",
        )}
      >
        <Bell className="h-3.5 w-3.5" />
        {unread > 0 ? (
          <span
            className={cn(
              "absolute -right-1 -top-1 flex items-center justify-center",
              "h-3.5 min-w-3.5 rounded-full bg-error px-1",
              "text-[9px] font-bold leading-none text-white",
            )}
          >
            {unread > 99 ? "99+" : unread}
          </span>
        ) : null}
      </button>

      {open && coords
        ? createPortal(
            <div
              ref={menuRef}
              role="menu"
              style={{
                position: "fixed",
                top: coords.top,
                left: coords.left,
                width: DROPDOWN_WIDTH,
                zIndex: 1000,
              }}
              className={cn(
                "flex flex-col rounded-md border border-border bg-surface-2",
                "shadow-lg shadow-black/40",
              )}
            >
              {/* Header */}
              <div className="flex items-center justify-between border-b border-border px-3 py-2">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-fg-muted">
                  Notifications
                </span>
                {notifications.length > 0 ? (
                  <button
                    type="button"
                    onClick={handleClearAll}
                    className="text-[10px] text-fg-muted transition-colors hover:text-fg-secondary"
                  >
                    Clear all
                  </button>
                ) : null}
              </div>

              {/* Body */}
              {notifications.length === 0 ? (
                <p className="px-3 py-6 text-center text-xs text-fg-muted">
                  No notifications yet.
                </p>
              ) : (
                <div
                  className="flex flex-col gap-px overflow-y-auto p-1"
                  style={{ maxHeight: 360 }}
                >
                  {notifications.map((notif) => (
                    <NotificationRow
                      key={notif.id}
                      notif={notif}
                      onAction={() => setOpen(false)}
                    />
                  ))}
                </div>
              )}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
