/** Answer RocSpace's confirmation dialog from a test, without rendering it.
 *
 *  The dialog is one component mounted once at the top of the app; a unit test
 *  for a sidebar row or for `closeTerminalPane` has no reason to mount the
 *  whole shell to click a button in it. So this subscribes to the store the
 *  dialog reads and answers each question the instant it is asked — the real
 *  `confirmAction`, the real promise, the real call-site code, with only the
 *  pixels skipped.
 *
 *  Strictly more than the `vi.spyOn(window, "confirm")` this replaced: the
 *  probe also keeps every question, so a test can assert what the user was
 *  actually asked rather than only that something was.
 *
 *  `ConfirmDialog.test.tsx` covers the dialog itself. */

import { useConfirmStore, type ConfirmDraft } from "@/stores/confirm";

export interface ConfirmProbe {
  /** Every question asked while the probe was armed, oldest first. */
  asked: ConfirmDraft[];
  /** Stop answering. Call in a cleanup so one test's probe cannot answer the
   *  next one's questions. */
  restore: () => void;
}

/** Arm the probe. Every confirmation raised from now on resolves to
 *  `accepted`, synchronously, before the dialog would have painted. */
export function answerConfirmsWith(accepted: boolean): ConfirmProbe {
  const asked: ConfirmDraft[] = [];
  const restore = useConfirmStore.subscribe((state) => {
    const request = state.request;
    if (!request) return;
    const { id: _id, resolve: _resolve, ...draft } = request;
    asked.push(draft);
    useConfirmStore.getState().answer(accepted);
  });
  return { asked, restore };
}
