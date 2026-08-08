/** The toasts, bottom-right, newest nearest the corner.
 *
 *  A portal onto `document.body` rather than a child of the shell: a toast
 *  reports something that has already happened, and it must not be clipped by
 *  whichever panel the user happens to be resizing — or vanish with the view it
 *  was raised from. Below the notification dropdown in the stacking order
 *  (1000), because a menu the user opened deliberately outranks a message the
 *  app raised on its own.
 *
 *  The container ignores the pointer and each toast takes it back, so the strip
 *  of empty space above a single toast is not a hole in the app. */

import { X } from "lucide-react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { useToasts, useToastsStore } from "@/stores/toasts";

export function ToastStack() {
  const toasts = useToasts();
  if (toasts.length === 0) return null;

  const dismiss = (id: string) => useToastsStore.getState().dismiss(id);

  return createPortal(
    <div
      // Polite rather than assertive: nothing here is an interruption, and a
      // screen reader mid-sentence should finish it.
      aria-live="polite"
      className="pointer-events-none fixed bottom-4 right-4 flex w-80 flex-col gap-2"
      style={{ zIndex: 900 }}
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role="status"
          className={cn(
            "pointer-events-auto flex items-start gap-2 rounded-card border px-3 py-2",
            "bg-surface-2 shadow-lg shadow-black/40",
            toast.tone === "warn" ? "border-warning/50" : "border-border",
          )}
        >
          <p className="min-w-0 flex-1 text-[11px] leading-relaxed text-fg-primary">
            {toast.message}
          </p>
          {toast.action ? (
            <button
              type="button"
              onClick={() => {
                // Taken down on the way out: the offer has been accepted, and a
                // toast still sitting there afterwards invites a second press.
                dismiss(toast.id);
                toast.action?.run();
              }}
              className="shrink-0 rounded-input px-2 py-0.5 text-[11px] font-medium text-accent hover:bg-surface-3"
            >
              {toast.action.label}
            </button>
          ) : null}
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => dismiss(toast.id)}
            className="grid h-4 w-4 shrink-0 place-items-center rounded text-fg-muted hover:bg-surface-3 hover:text-fg-primary"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}
