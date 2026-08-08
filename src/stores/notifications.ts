import { create } from "zustand";
import { devtools } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";
import { ulid } from "ulid";
import type { AgentType } from "@/lib/bindings";
import { LIMITS } from "@/lib/limits";

const NOTIFICATIONS_CAP = LIMITS.notifications;

/** What happened. Four of these come from the status bridge watching a PTY;
 *  `review` comes from RocPlan, when a dispatched pane's turn ended and its
 *  card was moved to In Review — the one kind that is about a card rather than
 *  about a process, and it is here rather than in a toast because a card
 *  waiting for a person is still waiting ten minutes later.
 *
 *  `turn-finished` and `complete` are deliberately separate, because the events
 *  are: a turn ending leaves a live agent waiting for your next prompt, while
 *  `complete` is the CLI process gone. Collapsing them is exactly the confusion
 *  that left "an agent finished" signalling nothing for a whole phase. */
export type NotificationKind =
  "awaiting" | "turn-finished" | "complete" | "error" | "review";

export interface Notification {
  id: string;
  terminalId: string;
  /** Snapshot of terminal name at push time — rename-resilient. */
  terminalName: string;
  agentType: AgentType;
  kind: NotificationKind;
  createdAt: number;
  read: boolean;
}

interface NotificationsState {
  /** Newest first. Capped at NOTIFICATIONS_CAP. */
  items: Notification[];
}

interface NotificationsActions {
  push: (n: Omit<Notification, "id" | "createdAt" | "read">) => void;
  markRead: (id: string) => void;
  markAllRead: () => void;
  dismiss: (id: string) => void;
  clearAll: () => void;
}

export const useNotificationsStore = create<
  NotificationsState & NotificationsActions
>()(
  devtools(
    immer((set) => ({
      items: [],

      push: (n) =>
        set((s) => {
          s.items.unshift({
            ...n,
            id: ulid(),
            createdAt: Date.now(),
            read: false,
          });
          if (s.items.length > NOTIFICATIONS_CAP) {
            s.items.length = NOTIFICATIONS_CAP;
          }
        }),

      markRead: (id) =>
        set((s) => {
          const item = s.items.find((n) => n.id === id);
          if (item) item.read = true;
        }),

      markAllRead: () =>
        set((s) => {
          for (const item of s.items) item.read = true;
        }),

      dismiss: (id) =>
        set((s) => {
          const idx = s.items.findIndex((n) => n.id === id);
          if (idx >= 0) s.items.splice(idx, 1);
        }),

      clearAll: () =>
        set((s) => {
          s.items.length = 0;
        }),
    })),
    { name: "notifications" },
  ),
);

// Selectors --------------------------------------------------------------

export const useNotifications = () => useNotificationsStore((s) => s.items);

export const useUnreadCount = () =>
  useNotificationsStore((s) => s.items.filter((n) => !n.read).length);
