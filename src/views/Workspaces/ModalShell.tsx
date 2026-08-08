/** The chrome every centred modal in RocSpace shares: scrim, dialog box,
 *  header with a close button, optional footer — plus the three behaviours that
 *  are easy to get subtly wrong and expensive to get wrong twice.
 *
 *  Extracted when the ⌘⇧S name prompt became the second modal. The focus trap
 *  in particular is not boilerplate: `aria-modal` claims the app behind is
 *  inert, the scrim makes that true for the mouse, and without the trap it stays
 *  false for the keyboard — Tab walks off the last control into chrome that is
 *  invisible, unclickable and still live. One copy, one place to fix it. */

import { X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";
import { isTextEntry } from "@/lib/dom";
import { cn } from "@/lib/utils";

/** What Tab can land on inside the dialog.
 *
 *  Deliberately not filtered by visibility: jsdom lays nothing out, so any
 *  `offsetParent` check would call every control hidden and the trap would test
 *  as working while doing nothing. Everything in these dialogs that is in the
 *  DOM is on screen — collapsed sections unmount rather than hide — so the
 *  enabled/negative-tabindex filter below is the whole question. */
const FOCUSABLE =
  'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** Which dialogs are on screen, oldest first.
 *
 *  Both behaviours below are bound on the DOCUMENT — deliberately, so they hold
 *  when focus has been dropped on a scrim — which means every open dialog hears
 *  every key. With one dialog that is the whole design; with two it is a bug in
 *  both directions: Escape closes the stack instead of the top of it, and the
 *  outer trap yanks Tab back out of the inner dialog on the next press.
 *
 *  Confirmations are what made that reachable — "Delete this card?" is asked
 *  from inside the card editor, over it. So each shell takes a ticket and only
 *  the last one in line answers. Registration happens in an effect, so the
 *  order is mount order; two dialogs opening in ONE commit would register
 *  child-first, which is not a case this app has (a confirmation is always a
 *  later commit than the dialog that asked for it). */
const openDialogs: string[] = [];

/** Is any centred dialog on screen right now?
 *
 *  The same queue `isTopmost` reads, asked from OUTSIDE it — for a surface
 *  that is not a `ModalShell` but is underneath one. Settings is the only such
 *  surface: it is an overlay inside the dock rather than a modal, it answers
 *  Escape on the document like every shell here, and it had no way to know a
 *  confirmation had opened over it. One press then answered "no" to the
 *  question AND closed the screen it was asked from.
 *
 *  Deliberately not `isAnyBlockingModalOpen`, which counts Settings itself and
 *  would therefore be true for the caller's own overlay. What Settings needs
 *  to know is narrower: is something ON TOP of me. */
export function isAnyDialogOpen(): boolean {
  return openDialogs.length > 0;
}

export function ModalShell({
  title,
  onClose,
  initialFocusRef,
  width = "w-[560px]",
  footer,
  children,
}: {
  title: string;
  onClose: () => void;
  /** Focused on open instead of the close button — for a dialog whose whole
   *  point is a field the user should be able to type into immediately. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Tailwind width class for the dialog box. */
  width?: string;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const titleId = useId();
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  // Take a ticket for the lifetime of this dialog. `useId` rather than a
  // counter: it is stable across re-renders and unique per instance, which is
  // exactly what the queue needs to identify a shell.
  const ticket = useId();
  const isTopmost = useCallback(
    () => openDialogs[openDialogs.length - 1] === ticket,
    [ticket],
  );
  useEffect(() => {
    openDialogs.push(ticket);
    return () => {
      const at = openDialogs.indexOf(ticket);
      if (at >= 0) openDialogs.splice(at, 1);
    };
  }, [ticket]);

  // Focus in on open, back out on close — the modal covers the app, so leaving
  // focus behind means Escape goes to a terminal and a screen reader never
  // hears about the dialog.
  useEffect(() => {
    const previous = document.activeElement;
    const target = initialFocusRef?.current ?? closeButtonRef.current;
    target?.focus();
    return () => {
      // Skip a node that left the DOM meanwhile: focusing a detached element
      // drops focus to the body, which is worse than leaving it alone.
      if (previous instanceof HTMLElement && previous.isConnected) {
        previous.focus();
      }
    };
    // Mount-only: the ref's identity is stable and re-running would steal focus
    // back from whatever the user has since tabbed to.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Focus trap. Capture phase and bound on the document so it holds even if
  // focus has somehow ended up outside: the next Tab brings it back in.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      if (!isTopmost()) return;
      const dialog = dialogRef.current;
      if (!dialog) return;

      const stops = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (el) => !el.hasAttribute("disabled") && el.tabIndex >= 0,
      );
      if (stops.length === 0) {
        e.preventDefault();
        return;
      }

      const first = stops[0]!;
      const last = stops[stops.length - 1]!;
      const here = document.activeElement;
      const inside = here instanceof HTMLElement && dialog.contains(here);

      if (e.shiftKey ? here === first || !inside : here === last || !inside) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [isTopmost]);

  // Escape closes, bound on the document so it works whether focus sits in the
  // dialog or was dropped on the scrim by a click.
  //
  // Not while a text field has the keyboard: Escape there means "abandon what I
  // typed", and answering it by tearing the whole dialog down throws away every
  // other answer the user gave. A dialog that is ONE field (the name prompt)
  // handles its own Escape on the input, where the two meanings coincide.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (!isTopmost()) return;
      if (isTextEntry(document.activeElement)) return;
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, isTopmost]);

  return (
    <div
      // Scrim. The click only counts on the scrim itself: a drag that starts
      // inside the dialog and ends outside it must not be a dismissal.
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-6"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={cn(
          "flex max-h-full max-w-full flex-col overflow-hidden",
          "rounded-xl border border-border bg-surface-1 shadow-2xl shadow-black/40",
          width,
        )}
      >
        <header className="flex h-11 shrink-0 items-center justify-between border-b border-border px-4">
          <h2 id={titleId} className="text-sm font-semibold text-fg-primary">
            {title}
          </h2>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            aria-label="Close"
            title="Close (Esc)"
            className="grid h-6 w-6 place-items-center rounded-input text-fg-secondary hover:bg-surface-2 hover:text-fg-primary"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 py-4">
          {children}
        </div>

        {footer ? (
          <footer className="flex h-12 shrink-0 items-center justify-end gap-2 border-t border-border px-4">
            {footer}
          </footer>
        ) : null}
      </div>
    </div>
  );
}
