/** Transient messages about something the app just did on the user's behalf.
 *
 *  Deliberately NOT the notification bell. The bell is a log — it keeps what it
 *  is given until the user reads or clears it, and it is about a terminal.
 *  A toast is about an ACTION and is worth exactly the few seconds after it:
 *  "Rocky picked up this card", "the pane that card named is gone, it went to
 *  the focused one instead". Kept, those become a list of things that already
 *  worked; dropped, the user is told once, where they were looking.
 *
 *  The action is a callback rather than a route because there is nothing to
 *  route to: "Watch it work" swaps the main view and focuses a pane, which is
 *  two store writes the caller already knows how to make. Holding the closure
 *  keeps this store from having to know what a terminal is.
 *
 *  Timers live at module level, keyed by id, for the same reason the rocplan
 *  store's do: nobody renders them, and a re-render must not restart one. */

import { create } from "zustand";
import { devtools } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";
import { ulid } from "ulid";
import { LIMITS } from "@/lib/limits";

/** The one thing a toast offers to do about what it is reporting. */
export interface ToastAction {
  label: string;
  run: () => void;
}

export interface Toast {
  id: string;
  message: string;
  /** `warn` is for a toast that reports something the user did not ask for and
   *  might want to undo or re-aim — a dispatch that missed its pane. */
  tone: "info" | "warn";
  action: ToastAction | null;
  createdAt: number;
}

/** How long a toast stays up. Long enough to read a sentence and reach the
 *  button in it; short enough that a burst of dispatches does not become a
 *  wall. */
export const TOAST_TTL_MS = 6_000;

export interface ToastDraft {
  message: string;
  tone?: Toast["tone"];
  action?: ToastAction | null;
  ttlMs?: number;
}

interface ToastsState {
  /** Oldest first — the stack draws downward, so the newest is nearest the
   *  corner the eye is already in. */
  items: Toast[];
}

interface ToastsActions {
  /** Show one. Returns its id, for a caller that wants to take it down early. */
  push: (draft: ToastDraft) => string;
  dismiss: (id: string) => void;
  clearAll: () => void;
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();

function disarm(id: string): void {
  const timer = timers.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    timers.delete(id);
  }
}

export const useToastsStore = create<ToastsState & ToastsActions>()(
  devtools(
    immer((set) => ({
      items: [],

      push: (draft) => {
        const id = ulid();
        set((s) => {
          s.items.push({
            id,
            message: draft.message,
            tone: draft.tone ?? "info",
            action: draft.action ?? null,
            createdAt: Date.now(),
          });
          // Oldest out first: the one still on screen from four dispatches ago
          // is the one nobody is reading.
          while (s.items.length > LIMITS.toasts) {
            const dropped = s.items.shift();
            if (dropped) disarm(dropped.id);
          }
        });
        timers.set(
          id,
          setTimeout(() => {
            timers.delete(id);
            useToastsStore.getState().dismiss(id);
          }, draft.ttlMs ?? TOAST_TTL_MS),
        );
        return id;
      },

      dismiss: (id) => {
        disarm(id);
        set((s) => {
          const index = s.items.findIndex((t) => t.id === id);
          if (index >= 0) s.items.splice(index, 1);
        });
      },

      clearAll: () => {
        for (const id of [...timers.keys()]) disarm(id);
        set((s) => {
          s.items.length = 0;
        });
      },
    })),
    { name: "toasts" },
  ),
);

// Selectors --------------------------------------------------------------

export const useToasts = (): Toast[] => useToastsStore((s) => s.items);

/** Test seam: drop every toast AND the timers holding them. A suite that left
 *  one armed would dismiss a toast belonging to the next one. */
export function resetToastsState(): void {
  useToastsStore.getState().clearAll();
}
