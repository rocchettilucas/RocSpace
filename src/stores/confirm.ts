/** "Are you sure?", asked in RocSpace's own chrome.
 *
 *  Replaces the last of the `window.confirm` calls. The native dialog was wrong
 *  here for three reasons that all cost something real: it is unthemed (a system
 *  sheet over a Dracula window), it is unstyleable (no way to mark a
 *  *destructive* answer as destructive), and on macOS it blocks the whole
 *  webview — including the PTY reader draining into xterm — for as long as it is
 *  up. A dialog that pauses an agent mid-stream to ask whether to close a
 *  different pane is a bad trade.
 *
 *  # Why a promise
 *
 *  Because `window.confirm` was one, in effect: every call site is written as
 *  "ask, then act", and several of them (`closeTerminalPane`, the save
 *  prompt's overwrite check) are plain functions rather than components, with
 *  nowhere to hang a piece of React state. `await confirmAction({…})` keeps
 *  those call sites the shape they already are; only the `await` is new.
 *
 *  # One at a time
 *
 *  A second ask while one is up resolves the first as CANCELLED rather than
 *  queueing it. Two overlapping confirmations mean two dialogs the user cannot
 *  tell apart, and the safe answer to a question nobody read is no. In practice
 *  it does not happen — every call site is a click or a chord, and the first
 *  dialog owns the keyboard while it is open. */

import { create } from "zustand";
import { ulid } from "ulid";

export interface ConfirmDraft {
  /** The dialog's heading — a short noun phrase ("Close pane"). */
  title: string;
  /** The question, in one sentence. */
  message: string;
  /** Optional second line: the consequence, or what cannot be undone. */
  detail?: string;
  /** The affirmative button. Says what will HAPPEN ("Close pane"), never
   *  "OK" — a button that names its action can be read without the sentence
   *  above it. */
  confirmLabel: string;
  cancelLabel?: string;
  /** `danger` paints the confirm button in the error tone. For answers that
   *  destroy something the user cannot get back. */
  tone?: "default" | "danger";
}

export interface ConfirmRequest extends ConfirmDraft {
  id: string;
  resolve: (answer: boolean) => void;
}

interface ConfirmState {
  request: ConfirmRequest | null;
  /** Settle the open question. No-op when nothing is open, so a stray Escape
   *  after the dialog closed cannot resolve the NEXT one. */
  answer: (accepted: boolean) => void;
}

export const useConfirmStore = create<ConfirmState>()((set, get) => ({
  request: null,
  answer: (accepted) => {
    const open = get().request;
    if (!open) return;
    set({ request: null });
    open.resolve(accepted);
  },
}));

/** Ask, and resolve to what the user answered. Rejects nothing: a dismissed
 *  dialog is `false`, which is the same shape `window.confirm` had. */
export function confirmAction(draft: ConfirmDraft): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    // Cancel whatever was already being asked — see the header.
    useConfirmStore.getState().answer(false);
    useConfirmStore.setState({
      request: { ...draft, id: ulid(), resolve },
    });
  });
}

/** Imperative form for the chord guards. The confirm dialog covers the window
 *  like every other modal, so nothing underneath may keep acting. */
export const isConfirmOpen = (): boolean =>
  useConfirmStore.getState().request !== null;

/** Tests only: drop an open question without answering it. */
export function resetConfirmState(): void {
  useConfirmStore.setState({ request: null });
}

export const useConfirmRequest = (): ConfirmRequest | null =>
  useConfirmStore((s) => s.request);
