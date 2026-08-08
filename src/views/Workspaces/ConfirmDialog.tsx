/** The one dialog behind every "are you sure?" in RocSpace.
 *
 *  Mounted once, beside the other window-level modals, and driven entirely by
 *  `stores/confirm` — so a call site asks a question and awaits an answer
 *  without knowing there is a component involved. See that store for why the
 *  native `window.confirm` had to go.
 *
 *  Enter confirms and Escape cancels, both from the dialog itself: focus opens
 *  on the CANCEL button, not the confirm one, because the destructive answer
 *  should never be one stray Return away.
 *
 *  # A key that was already down is not an answer
 *
 *  Confirmations are asked in the middle of typing — the Save session prompt
 *  sends its name on Enter, and a name that collides asks "replace it?" in the
 *  same tick. A Return the user was HOLDING when the question appeared would
 *  autorepeat straight into "yes" and overwrite a session they never saw named,
 *  so `e.repeat` is refused: the first press of a key is a decision, the
 *  hundredth report of the same press is not.
 *
 *  The listener is also scoped to the dialog rather than to the document. The
 *  shell keeps focus inside (it traps Tab and opens on Cancel), so anything
 *  that answers this question comes from in here — and a keystroke aimed at a
 *  surface underneath cannot be read as a yes to a question above it. */

import { useRef } from "react";
import { cn } from "@/lib/utils";
import { useConfirmRequest, useConfirmStore } from "@/stores/confirm";
import { ModalShell } from "@/views/Workspaces/ModalShell";

export function ConfirmDialog() {
  const request = useConfirmRequest();
  if (!request) return null;
  // Keyed on the request so a second question mounts a FRESH dialog rather
  // than re-rendering the first one — otherwise focus stays wherever the
  // previous one left it.
  return <ConfirmBody key={request.id} />;
}

/** Exported for tests; app code renders `ConfirmDialog`. */
export function ConfirmBody() {
  const request = useConfirmRequest();
  const answer = useConfirmStore((s) => s.answer);
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  if (!request) return null;
  const danger = request.tone === "danger";

  return (
    // Enter anywhere in the dialog accepts. On the subtree rather than on
    // either button so it works with focus on both — the one that HAS focus is
    // Cancel, and a Return there would otherwise mean "no" while the user was
    // reading "yes".
    <div
      onKeyDown={(e) => {
        if (e.key !== "Enter") return;
        // Held from before the question existed. See the header.
        if (e.repeat) return;
        e.preventDefault();
        answer(true);
      }}
    >
      <ModalShell
        title={request.title}
        onClose={() => answer(false)}
        initialFocusRef={cancelRef}
        width="w-[420px]"
        footer={
          <>
            <button
              ref={cancelRef}
              type="button"
              onClick={() => answer(false)}
              className="rounded-input px-3 py-1.5 text-xs text-fg-secondary hover:bg-surface-2 hover:text-fg-primary"
            >
              {request.cancelLabel ?? "Cancel"}
            </button>
            <button
              type="button"
              onClick={() => answer(true)}
              className={cn(
                "rounded-input px-3.5 py-1.5 text-xs font-medium",
                // The house tone for destructive, everywhere else in the app:
                // the error color on its own tint, not a solid red slab. There
                // is no on-danger foreground token, and inventing one to fill a
                // button would be a nineteenth token for one button.
                danger
                  ? "border border-error/40 bg-error/15 text-error hover:bg-error/25"
                  : "bg-accent text-accent-fg hover:opacity-90",
              )}
            >
              {request.confirmLabel}
            </button>
          </>
        }
      >
        <div className="flex flex-col gap-2">
          <p className="text-xs leading-relaxed text-fg-primary">
            {request.message}
          </p>
          {request.detail ? (
            <p className="text-[11px] leading-relaxed text-fg-muted">
              {request.detail}
            </p>
          ) : null}
        </div>
      </ModalShell>
    </div>
  );
}
