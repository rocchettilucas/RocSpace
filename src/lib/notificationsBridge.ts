/** Watches the terminals store for status transitions and pushes notifications.
 *  Mount once at app start alongside mountPtyBridge. */

import {
  isAnyBlockingModalOpen,
  useTerminalsStore,
  useTerminalRuntimeStore,
  useUIStore,
  useWorkspacesStore,
} from "@/stores";
import { useNotificationsStore } from "@/stores/notifications";
import { useSettingsStore } from "@/stores/settings";
import { playNotificationDing } from "@/lib/notificationSound";
import { isHookDriven } from "@/lib/ptyBridge";
import type { NotificationKind } from "@/stores/notifications";
import type { TerminalStatus } from "@/lib/bindings";

/** Debounce rapid pushes per terminal — spinner frames driving running→awaiting,
 *  and an agent that ends two turns inside one breath. */
const DEBOUNCE_MS = 3000;

const lastAwaitingPushAt = new Map<string, number>();
const lastTurnPushAt = new Map<string, number>();
const lastPairedSoundAt = new Map<string, number>();

/** Panes whose "a turn ended here" row is still STANDING: filed, and not yet
 *  answered by the user going back to the pane.
 *
 *  The bell holds fifty rows. An agent working a queue of prompts in a
 *  background pane ends a turn every couple of minutes, and each one used to
 *  file a row that said exactly what the last one said — sixty of them push
 *  every approval and every crash out of the list, which is the opposite of
 *  what a notification list is for. One row per pane per unanswered signal is
 *  all a repeat can honestly claim; the glow on the card is what carries the
 *  rest.
 *
 *  This cannot be `turnFinished` itself, which is the obvious thing to reach
 *  for and does nothing: every turn STARTS by clearing that flag (`running`
 *  retires the last turn's glow), so it is always unset by the time the next
 *  `idle` would consult it. The question here has a different lifetime — "has
 *  the user been back since we told them?" — and only becoming watched answers
 *  it. */
const standingTurnRow = new Set<string>();

/** The one pair of kinds that can describe the SAME event twice: this bridge's
 *  `turn-finished`, and RocPlan's `review` a round trip later, once the board
 *  has moved the dispatched pane's card. Both are worth a row — the second says
 *  more than the first — and the second is not worth a chime a heartbeat after
 *  the first.
 *
 *  Nothing else belongs in here, and the window is scoped to this pair rather
 *  than to the pane for one reason: across kinds it silenced the signals that
 *  matter most. A crash, a process exit, or a permission prompt landing inside
 *  three seconds of a turn's ding made no sound at all — the blocking signal
 *  eaten by the non-blocking one. */
const PAIRED_SOUND_KINDS: ReadonlySet<NotificationKind> = new Set([
  "turn-finished",
  "review",
]);

/** Gate notifications on the same "has the user typed yet?" flag the idle
 *  watchdog uses. Prevents the boot-time agent banner — and any auto-exit of
 *  the launched CLI before the user has interacted — from firing notifications
 *  the moment a terminal pane spins up. */
function userHasTouchedTerminal(id: string): boolean {
  return !!useTerminalRuntimeStore.getState().hasUserInput[id];
}

/** The one pane the user has AIMED at, ignoring anything on top of it.
 *
 *  Three ways to not be aimed at a pane, and they are all the same answer:
 *  another pane holds focus, the pane's workspace is not the active one, or the
 *  main area is showing RocPlan or Roc instead of the dock. Written as "which
 *  pane IS it" rather than as a predicate per pane so the three conditions live
 *  in one place.
 *
 *  One reader left, and it is about the SOUND: `chimeCoveredByModal`. The
 *  glow-and-row half this used to gate is gone — "EVERY finished agent is
 *  announced, including the one on screen in front of you" (see the `idle`
 *  branch below), which retired the rule and left `watchedTerminalId` and
 *  `isPaneWatched` behind it as exports nothing has called since. */
function aimedTerminalId(): string | null {
  const ui = useUIStore.getState();
  if (ui.mainView !== "terminals") return null;
  const id = ui.focusedTerminalId;
  if (!id) return null;
  const terminal = useTerminalsStore.getState().byId[id];
  if (!terminal) return null;
  const { activeWorkspaceId } = useWorkspacesStore.getState();
  return terminal.workspaceId === activeWorkspaceId ? id : null;
}

/** Should this row land without a sound because a modal is covering the pane it
 *  is about?
 *
 *  Only for the turn pair, and only for the pane under the modal. Phase 7B's
 *  rule is "never chime about the pane in front of you", and a palette the user
 *  opened a second ago does not change which pane that is — they dismiss it
 *  with the same hand and the glow is right there. What a modal must never do
 *  is silence the kinds that are about something being WRONG or STOPPED: a
 *  permission prompt, a crash and a process exit sound through this, as they
 *  sound through everything else. */
function chimeCoveredByModal(kind: NotificationKind, terminalId: string) {
  return (
    PAIRED_SOUND_KINDS.has(kind) &&
    aimedTerminalId() === terminalId &&
    isAnyBlockingModalOpen()
  );
}

/** Play the chime for one event, or decline to, and record the window.
 *
 *  A function rather than a line inside the list subscription because the two
 *  callers are not the same thing: a new row rings, and so does a turn ending
 *  on a pane that ALREADY has a standing row. The list is deduplicated so it
 *  stays readable; the sound is not, because "an agent finished" is the event
 *  the user asked to hear every time it happens. */
function ring(kind: NotificationKind, terminalId: string): void {
  if (!shouldSound(kind)) return;
  if (chimeCoveredByModal(kind, terminalId)) return;
  const paired = PAIRED_SOUND_KINDS.has(kind);
  if (paired) {
    const since = Date.now() - (lastPairedSoundAt.get(terminalId) ?? 0);
    // Still debounced per pane: two turns inside one breath are one chime.
    if (since < DEBOUNCE_MS) return;
    lastPairedSoundAt.set(terminalId, Date.now());
  }
  playNotificationDing();
}

/** Should this notification make a noise?
 *
 *  The master mute wins over everything. The two switches cover the two kinds
 *  that happen on every conversation; a process exiting, a crash and a card
 *  sent for review have no switch of their own because they happen once and
 *  are worth interrupting for. */
function shouldSound(kind: NotificationKind): boolean {
  const { muted, turnFinishedSound, approvalSound } =
    useSettingsStore.getState().notifications;
  if (muted) return false;
  if (kind === "turn-finished") return turnFinishedSound;
  if (kind === "awaiting") return approvalSound;
  return true;
}

/** Drop the per-pane debounce timestamps. Tests only — the maps are keyed by
 *  ULID, so nothing in the app can collide across mounts, but a test that
 *  re-seeds the same fixture twice would inherit the last one's window. */
export function resetNotificationsBridgeState(): void {
  lastAwaitingPushAt.clear();
  lastTurnPushAt.clear();
  lastPairedSoundAt.clear();
  standingTurnRow.clear();
}

export function mountNotificationsBridge(): () => void {
  // Play the ding whenever the notifications list grows. Watching the store
  // (rather than calling playDing alongside each push) means any future
  // caller of `push` — not just this bridge — gets the sound for free.
  //
  // The only thing that can swallow a ding here is the one-event-two-rows pair
  // (`PAIRED_SOUND_KINDS`), and only per pane. Every other kind sounds on its
  // own terms: an approval prompt, a crash and a process exit are each the
  // reason someone turned the sound on, and a turn ending three seconds earlier
  // is not a reason to keep one of them quiet. The window is recorded only when
  // a ding is actually played, so a kind the user has switched off never eats
  // the next one's sound.
  let lastTopId: string | null =
    useNotificationsStore.getState().items[0]?.id ?? null;
  const unsubscribeSound = useNotificationsStore.subscribe((state) => {
    const top = state.items[0] ?? null;
    if (top && top.id !== lastTopId) ring(top.kind, top.terminalId);
    lastTopId = top?.id ?? null;
  });

  // Acknowledging a glow is ACTING on the pane, not merely having it on screen.
  // That distinction is the whole point now that a watched pane glows too: if
  // arriving were enough, the pane you are already in would light up and go out
  // in the same frame, which is a flicker rather than a signal.
  //
  // The two acts that count are both handled elsewhere, deliberately:
  //   • sending the pane something — its next `running`, cleared below;
  //   • clicking the pane — `TerminalCard`'s own handler, because a click is an
  //     event and this file only ever sees state. `hasUserInput` cannot stand in
  //     for it: it is a one-way latch that is already true for every pane the
  //     user has ever typed in, so it can never mark a SECOND turn as answered.

  const unsubscribeStatus = useTerminalsStore.subscribe((state, prevState) => {
    const curr = state.byId;
    const prev = prevState.byId;

    // Early-exit if no status changed — avoids work on every output-line append.
    let anyChange = false;
    for (const id of Object.keys(curr)) {
      if (curr[id]?.status !== prev[id]?.status) {
        anyChange = true;
        break;
      }
    }
    if (!anyChange) return;

    for (const [id, terminal] of Object.entries(curr)) {
      const prevStatus: TerminalStatus | undefined = prev[id]?.status;
      const nextStatus = terminal.status;

      if (prevStatus === nextStatus || prevStatus === undefined) continue;

      // Three transitions retire the last turn's glow, and they are one rule:
      // the pane has since said something ELSE about itself, so a green "your
      // answer is ready" is no longer what is true about it.
      //
      //   running  — work is going again; claiming "done" over it is the one
      //              thing this signal must never do.
      //   error    — the process died. The card's `isReady` reads the flag
      //              FIRST, so a stale one made a crashed pane pulse
      //              success-green while its own dot said error.
      //   complete — the CLI is gone. The card lights that state on the status
      //              itself; leaving the flag behind would only mean a pane
      //              wearing a turn signal it can no longer act on.
      //
      // Above the user-input gate on purpose: a glow that is no longer true has
      // to go whether or not this pane is one we would have notified about.
      if (
        nextStatus === "running" ||
        nextStatus === "error" ||
        nextStatus === "complete"
      ) {
        useTerminalRuntimeStore.getState().clearTurnFinished(id);
      }

      // Suppress all notifications until the user has interacted with the
      // terminal at least once — the boot-time agent banner shouldn't ping.
      if (!userHasTouchedTerminal(id)) continue;

      // A pane rests at `idle` between turns — that is what the Claude `Stop`
      // hook means. It is a resting state rather than an event, so it is never
      // a reason to interrupt someone who is READING the pane it happened in;
      // for every other pane it is the answer they have been waiting for. A
      // process exit *out of* idle is still an exit, so it counts as "was
      // active" below either way.
      const wasActive =
        prevStatus === "running" ||
        prevStatus === "awaiting_approval" ||
        prevStatus === "idle";

      const push = (kind: NotificationKind) =>
        useNotificationsStore.getState().push({
          terminalId: id,
          terminalName: terminal.name,
          agentType: terminal.agentConfig.type,
          kind,
        });

      if (nextStatus === "awaiting_approval" && prevStatus === "running") {
        const lastPush = lastAwaitingPushAt.get(id) ?? 0;
        if (Date.now() - lastPush < DEBOUNCE_MS) continue;
        lastAwaitingPushAt.set(id, Date.now());
        push("awaiting");
      } else if (nextStatus === "idle" && prevStatus === "running") {
        // The end of a turn — but only for a pane whose agent SAYS so. `idle`
        // is where every pane rests, and it is only news when it arrived from
        // a Stop hook; on a shell pane it means the prompt came back, which is
        // not a turn ending and never was. The status alone cannot tell those
        // apart, which is what `isHookDriven` is for.
        //
        // No path mints `idle` for a shell pane today, but two write it
        // straight into the store from disk — `persistence.ts` sanitizes a
        // session without a status to `idle`, and `savedSessions.ts` restores
        // one the same way — so the guard is one status event away from
        // mattering, and it is the difference between a glow that means
        // something and one that fires on a shell prompt.
        if (!isHookDriven(id)) continue;

        // EVERY finished agent is announced, including the one on screen in
        // front of you. The earlier rule — signal only what you are not looking
        // at — assumed a turn you can see needs no telling, which is false when
        // four panes are working and the finished one is simply the pane your
        // cursor happens to be in. Turning the sound off is a setting; missing
        // the end of a turn is not recoverable.
        //
        // The glow is set before the debounce, not after it: two turns in
        // three seconds are one sound and one notification, but the border is
        // the same border either way and suppressing it would leave the second
        // turn's result unannounced on screen.
        useTerminalRuntimeStore.getState().markTurnFinished(id);
        // A row this pane already has standing says nothing the standing one
        // did not — and it costs a slot in a fifty-row list that someone else's
        // crash needed. See `standingTurnRow`. The CHIME is not suppressed with
        // it: the list is a record, and one row per unanswered pane keeps it
        // readable, but the sound is the event itself and every finished turn
        // is one.
        if (standingTurnRow.has(id)) {
          ring("turn-finished", id);
          continue;
        }
        const lastPush = lastTurnPushAt.get(id) ?? 0;
        if (Date.now() - lastPush < DEBOUNCE_MS) continue;
        lastTurnPushAt.set(id, Date.now());
        standingTurnRow.add(id);
        push("turn-finished");
      } else if (nextStatus === "complete" && wasActive) {
        push("complete");
      } else if (nextStatus === "error" && wasActive) {
        push("error");
      }
    }

    // Clean up debounce maps for removed terminals.
    for (const id of lastAwaitingPushAt.keys()) {
      if (!curr[id]) lastAwaitingPushAt.delete(id);
    }
    for (const id of lastTurnPushAt.keys()) {
      if (!curr[id]) lastTurnPushAt.delete(id);
    }
    for (const id of lastPairedSoundAt.keys()) {
      if (!curr[id]) lastPairedSoundAt.delete(id);
    }
    for (const id of standingTurnRow) {
      if (!curr[id]) standingTurnRow.delete(id);
    }
  });

  return () => {
    unsubscribeSound();

    unsubscribeStatus();
  };
}
