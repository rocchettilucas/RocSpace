/** The turn-completion signal: what an agent ending a turn does, and to which
 *  pane.
 *
 *  The rule under test is one sentence — **signal the pane you are not looking
 *  at** — and every case here is a different way of not looking at one. Phase 3
 *  removed the per-turn ding because a ten-turn conversation dinged ten times
 *  while the user sat watching it; the answer is not "never ding", it is "never
 *  ding about the pane in front of you". */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ding = vi.fn();
vi.mock("@/lib/notificationSound", () => ({
  playNotificationDing: () => ding(),
}));

import { newTerminal, newWorkspace } from "@/lib/factories";
import {
  mountNotificationsBridge,
  resetNotificationsBridgeState,
} from "@/lib/notificationsBridge";
import {
  confirmAction,
  resetConfirmState,
  useConfirmStore,
} from "@/stores/confirm";
import { useNotificationsStore } from "@/stores/notifications";
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  useSettingsStore,
} from "@/stores/settings";
import { useTerminalsStore } from "@/stores/terminals";
import { useTerminalRuntimeStore } from "@/stores/terminalRuntime";
import { useUIStore } from "@/stores/ui";
import { useWorkspacesStore } from "@/stores/workspaces";
import type { TerminalStatus } from "@/lib/bindings";

/** The active workspace, split in two, with the first pane focused — plus a
 *  second workspace holding one more pane, for the "switched away" case.
 *
 *  Every pane carries a `claudeSessionId` and no parked resume offer, which is
 *  what makes it hook-driven: the whole turn signal is about an agent that
 *  reports the end of its own turn, and a fixture without one would be testing
 *  a pane that can never raise it. */
function seed() {
  const a = newWorkspace({ name: "W0", projectPath: "/tmp/p", order: 0 });
  const b = newWorkspace({ name: "W1", projectPath: "/tmp/p", order: 1 });

  const pane = (workspaceId: string, name: string) => ({
    ...newTerminal({
      workspaceId,
      name,
      agentType: "claude-code",
      projectPath: "/tmp/p",
    }),
    claudeSessionId: `uuid-${name}`,
  });
  const paneA = pane(a.id, "Rocky");
  const paneB = pane(a.id, "Roxie");
  const paneC = pane(b.id, "Rex");

  useWorkspacesStore.setState({
    workspaces: [
      {
        ...a,
        focusedTerminalId: paneA.id,
        paneTree: {
          kind: "split",
          direction: "row",
          ratio: 0.5,
          first: { kind: "leaf", terminalId: paneA.id },
          second: { kind: "leaf", terminalId: paneB.id },
        },
      },
      { ...b, paneTree: { kind: "leaf", terminalId: paneC.id } },
    ],
    activeWorkspaceId: a.id,
  });
  useTerminalsStore.getState().setTerminals([paneA, paneB, paneC]);
  for (const t of [paneA, paneB, paneC]) {
    useTerminalRuntimeStore.getState().notifyUserInput(t.id);
  }
  useUIStore.setState({ focusedTerminalId: paneA.id, mainView: "terminals" });

  return {
    workspaceA: a.id,
    workspaceB: b.id,
    paneA: paneA.id,
    paneB: paneB.id,
    paneC: paneC.id,
  };
}

const setStatus = (id: string, status: TerminalStatus) =>
  useTerminalsStore.getState().setStatus(id, status);

/** One whole turn: the agent works, then the Stop hook lands as `idle`. */
function runTurn(id: string) {
  setStatus(id, "running");
  setStatus(id, "idle");
}

const glowing = (id: string) =>
  !!useTerminalRuntimeStore.getState().turnFinished[id];

/** Every modal that covers the window (or, for Settings, the whole dock), with
 *  the way it is raised and the way it is dismissed. One case per entry rather
 *  than one representative modal, because the bug this covers was a LIST that
 *  someone would extend: a modal that is missing here is a turn end that
 *  vanishes while it is up. Kept in step with `blockingModalOpen` in
 *  `stores/ui.ts`, which is the same list from the chords' side. */
const BLOCKING_MODALS: [string, () => void, () => void][] = [
  [
    "Settings",
    () => useUIStore.setState({ isSettingsOpen: true }),
    () => useUIStore.setState({ isSettingsOpen: false }),
  ],
  [
    "the New Workspace modal",
    () => useUIStore.getState().openWorkspaceModal(),
    () => useUIStore.getState().closeWorkspaceModal(),
  ],
  [
    "the Save session prompt",
    () => useUIStore.getState().openSaveSessionModal(),
    () => useUIStore.getState().closeSaveSessionModal(),
  ],
  [
    "quick open",
    () => useUIStore.setState({ isQuickOpenOpen: true }),
    () => useUIStore.setState({ isQuickOpenOpen: false }),
  ],
  [
    "the command palette",
    () => useUIStore.getState().openCommandPalette(),
    () => useUIStore.getState().closeCommandPalette(),
  ],
  [
    "What's new",
    () => useUIStore.setState({ isWhatsNewOpen: true }),
    () => useUIStore.setState({ isWhatsNewOpen: false }),
  ],
  [
    "the card editor",
    () =>
      useUIStore.setState({
        taskEditor: { projectPath: "/tmp/p", taskId: null },
      }),
    () => useUIStore.setState({ taskEditor: null }),
  ],
  [
    "a Git dialog",
    () => useUIStore.setState({ gitDialog: "branch" }),
    () => useUIStore.setState({ gitDialog: null }),
  ],
  [
    "an editor prompt",
    () =>
      useUIStore.setState({
        editorPrompt: { type: "unsaved-close", path: "/tmp/p/a.ts" },
      }),
    () => useUIStore.setState({ editorPrompt: null }),
  ],
  [
    "the confirm dialog",
    () =>
      void confirmAction({
        title: "Close pane",
        message: "Close it?",
        confirmLabel: "Close pane",
      }),
    () => useConfirmStore.getState().answer(false),
  ],
];

/** Put every modal down. The flags are ephemeral app state, not per-test
 *  fixtures, so one case leaving one up would decide the next one's answer. */
function closeAllModals() {
  useUIStore.setState({
    isSettingsOpen: false,
    isWorkspaceModalOpen: false,
    isSaveSessionModalOpen: false,
    isQuickOpenOpen: false,
    isCommandPaletteOpen: false,
    isWhatsNewOpen: false,
    taskEditor: null,
    gitDialog: null,
    editorPrompt: null,
  });
  resetConfirmState();
}

const kinds = () => useNotificationsStore.getState().items.map((n) => n.kind);

describe("turn-completion signals", () => {
  let unmount: (() => void) | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    ding.mockClear();
    resetNotificationsBridgeState();
    useNotificationsStore.setState({ items: [] });
    useTerminalsStore.setState({ byId: {} });
    useTerminalRuntimeStore.setState({
      hasUserInput: {},
      turnFinished: {},
      resumableClaudeSessions: {},
    });
    useWorkspacesStore.setState({ workspaces: [], activeWorkspaceId: null });
    useUIStore.setState({ focusedTerminalId: null, mainView: "terminals" });
    closeAllModals();
    useSettingsStore.setState({
      notifications: { ...DEFAULT_NOTIFICATION_SETTINGS },
    });
    unmount = mountNotificationsBridge();
  });

  afterEach(() => {
    unmount?.();
    closeAllModals();
    vi.useRealTimers();
  });

  it("glows and dings when a pane you are not focused on ends a turn", () => {
    const { paneA, paneB } = seed();
    // paneA holds focus; paneB is on screen beside it but not focused.

    runTurn(paneB);

    expect(glowing(paneB)).toBe(true);
    expect(kinds()).toEqual(["turn-finished"]);
    expect(ding).toHaveBeenCalledTimes(1);
    expect(glowing(paneA)).toBe(false);
  });

  it("does both for the pane you are watching, too", () => {
    // The rule this replaced signalled only what you were not looking at, on
    // the theory that a visible answer needs no announcing. With several panes
    // working at once the finished one is often simply the pane the cursor
    // happens to be in, and its turn ending is exactly as much news there.
    const { paneA } = seed();

    runTurn(paneA);

    expect(glowing(paneA)).toBe(true);
    expect(kinds()).toEqual(["turn-finished"]);
    expect(ding).toHaveBeenCalledTimes(1);
  });

  it("keeps the glow when you merely look at the pane", () => {
    // Arriving is not answering. If focus cleared it, the pane you are already
    // in would light and go dark in one frame — a flicker, not a signal.
    const { paneB } = seed();
    runTurn(paneB);
    expect(glowing(paneB)).toBe(true);

    useUIStore.getState().focusTerminal(paneB);

    expect(glowing(paneB)).toBe(true);
  });

  it("clears the glow when the pane is sent something new", () => {
    const { paneB } = seed();
    runTurn(paneB);
    expect(glowing(paneB)).toBe(true);

    // The other half of answering it — a click — belongs to TerminalCard,
    // which owns the event. This file only ever sees state, and the state it
    // sees is the pane running again.
    setStatus(paneB, "running");

    expect(glowing(paneB)).toBe(false);
  });

  it("signals a pane in a workspace you have switched away from", () => {
    const { workspaceA, workspaceB, paneC } = seed();
    useWorkspacesStore.getState().setActiveWorkspace(workspaceB);
    useUIStore.getState().focusTerminal(paneC);
    runTurn(paneC);
    // Announced where you are…
    expect(glowing(paneC)).toBe(true);
    expect(ding).toHaveBeenCalledTimes(1);

    // …and still announced once you have left it behind. Answering it is what
    // clears it, and leaving the workspace is not answering.
    useWorkspacesStore.getState().setActiveWorkspace(workspaceA);
    expect(glowing(paneC)).toBe(true);
  });

  it("signals the focused pane while the main area is showing something else", () => {
    // RocPlan takes the dock's place rather than covering it, so the pane is
    // focused and off screen at the same time.
    const { paneA } = seed();
    useUIStore.getState().setMainView("rocplan");

    runTurn(paneA);

    expect(glowing(paneA)).toBe(true);
    expect(ding).toHaveBeenCalledTimes(1);
  });

  describe("a turn ending behind a modal", () => {
    // The signal has exactly one chance to be raised: `idle` is where a Claude
    // pane RESTS, so nothing re-announces a turn whose moment was swallowed.
    // Treating a modal as "you are watching this pane" spent that one chance on
    // a window the user could not see through — and a Settings visit or a ⌘P
    // search is minutes, not the second the old comment assumed.
    for (const [name, open, close] of BLOCKING_MODALS) {
      it(`keeps its glow and its row behind ${name}`, () => {
        const { paneA } = seed();
        open();

        runTurn(paneA);

        expect(glowing(paneA)).toBe(true);
        expect(kinds()).toEqual(["turn-finished"]);
        // The chime is the one half a modal may take: the pane under it is the
        // pane the user was reading a moment ago and is about to read again.
        expect(ding).not.toHaveBeenCalled();

        // …and dismissing the modal does NOT spend it. Closing Settings is not
        // answering an agent, and the border is how the user finds the pane
        // that finished while the window was covered.
        close();
        expect(glowing(paneA)).toBe(true);
      });
    }

    it("still dings for a pane the modal is not covering", () => {
      // A modal covers ONE pane's chime — the aimed one. Every other pane is
      // exactly as unwatched as it was a second ago.
      const { paneB } = seed();
      useUIStore.setState({ isSettingsOpen: true });

      runTurn(paneB);

      expect(glowing(paneB)).toBe(true);
      expect(ding).toHaveBeenCalledTimes(1);
    });

    it("still dings when the pane it covers crashes", () => {
      // Quiet is for the kind that says "your answer is ready". A process that
      // died is not that kind, modal or no modal.
      const { paneA } = seed();
      useUIStore.setState({ isSettingsOpen: true });

      setStatus(paneA, "running");
      setStatus(paneA, "error");

      expect(kinds()).toEqual(["error"]);
      expect(ding).toHaveBeenCalledTimes(1);
    });
  });

  it("makes one sound for two turns inside the debounce window", () => {
    const { paneB } = seed();

    runTurn(paneB);
    vi.advanceTimersByTime(500);
    runTurn(paneB);

    expect(ding).toHaveBeenCalledTimes(1);
    expect(kinds()).toEqual(["turn-finished"]);
    // The glow is not debounced — it is the same glow either way.
    expect(glowing(paneB)).toBe(true);
  });

  it("sounds again for a pane you went back to and then left", () => {
    // What re-arms a turn signal is not only the clock: it is the user having
    // ANSWERED the last one by going to the pane. Both are required here —
    // the window has passed and the pane was read — because a repeat that is
    // still unanswered has nothing new to say (see the row tests below).
    const { paneA, paneB } = seed();

    runTurn(paneB);
    expect(ding).toHaveBeenCalledTimes(1);

    useUIStore.getState().focusTerminal(paneB);
    useUIStore.getState().focusTerminal(paneA);
    vi.advanceTimersByTime(3001);
    runTurn(paneB);

    expect(ding).toHaveBeenCalledTimes(2);
  });

  it("files one row for a run of turns, but rings for each of them", () => {
    // The two halves part company here on purpose. A second ROW says exactly
    // what the first said and costs a slot in a fifty-row list, so the list
    // keeps one per unanswered pane. The CHIME is the event itself — "an agent
    // finished" — and every turn ending is one, which is what was asked for.
    const { paneB } = seed();

    for (let i = 0; i < 60; i++) {
      runTurn(paneB);
      vi.advanceTimersByTime(4000);
    }

    expect(kinds()).toEqual(["turn-finished"]);
    expect(ding).toHaveBeenCalledTimes(60);
    expect(glowing(paneB)).toBe(true);
  });

  it("keeps another pane's crash through a busy background pane", () => {
    // The bell holds fifty rows. Sixty turns on one pane used to evict every
    // other pane's approval and crash — the rows nobody can afford to lose are
    // the ones a repeat pushed out.
    const { paneB, paneC } = seed();
    setStatus(paneC, "running");
    setStatus(paneC, "error");
    expect(kinds()).toContain("error");

    for (let i = 0; i < 60; i++) {
      runTurn(paneB);
      vi.advanceTimersByTime(4000);
    }

    expect(kinds()).toContain("error");
  });

  it("master mute silences without suppressing the border", () => {
    const { paneB } = seed();
    useSettingsStore.setState({
      notifications: { ...DEFAULT_NOTIFICATION_SETTINGS, muted: true },
    });

    runTurn(paneB);

    expect(ding).not.toHaveBeenCalled();
    // Muting the room is asking for quiet, not for blindness.
    expect(glowing(paneB)).toBe(true);
    expect(kinds()).toEqual(["turn-finished"]);
  });

  it("the turn-finished switch silences turns and leaves approvals alone", () => {
    const { paneB } = seed();
    useSettingsStore.setState({
      notifications: {
        ...DEFAULT_NOTIFICATION_SETTINGS,
        turnFinishedSound: false,
      },
    });

    runTurn(paneB);
    expect(ding).not.toHaveBeenCalled();
    expect(glowing(paneB)).toBe(true);

    setStatus(paneB, "running");
    setStatus(paneB, "awaiting_approval");
    expect(ding).toHaveBeenCalledTimes(1);
  });

  it("the approval switch silences approvals and leaves turns alone", () => {
    const { paneB } = seed();
    useSettingsStore.setState({
      notifications: { ...DEFAULT_NOTIFICATION_SETTINGS, approvalSound: false },
    });

    setStatus(paneB, "running");
    setStatus(paneB, "awaiting_approval");
    expect(ding).not.toHaveBeenCalled();
    expect(kinds()).toEqual(["awaiting"]);

    setStatus(paneB, "running");
    setStatus(paneB, "idle");
    expect(ding).toHaveBeenCalledTimes(1);
  });

  it("a crash still sounds through both switches", () => {
    // Neither switch is about a process dying, and there is no third one — the
    // master mute is the only thing that silences an error.
    const { paneB } = seed();
    useSettingsStore.setState({
      notifications: {
        turnFinishedSound: false,
        approvalSound: false,
        muted: false,
      },
    });

    setStatus(paneB, "running");
    setStatus(paneB, "error");

    expect(ding).toHaveBeenCalledTimes(1);
  });

  it("a new turn starting clears the last one's glow", () => {
    // Otherwise a pane you never looked at wears the glow through the next
    // turn, saying "done" about work that is still running.
    const { paneB } = seed();
    runTurn(paneB);
    expect(glowing(paneB)).toBe(true);

    setStatus(paneB, "running");

    expect(glowing(paneB)).toBe(false);
  });

  it("drops the glow when the pane crashes after the turn", () => {
    // running → idle → error. The card reads `turnFinished` FIRST — it is the
    // one thing a status cannot tell it — so a flag nobody cleared left the
    // pane pulsing success-green while its own dot said error.
    const { paneB } = seed();
    runTurn(paneB);
    expect(glowing(paneB)).toBe(true);

    setStatus(paneB, "error");

    expect(glowing(paneB)).toBe(false);
    expect(kinds()).toEqual(["error", "turn-finished"]);
  });

  it("drops the glow when the process exits after the turn", () => {
    // Same rule from the other end: the CLI is gone, so a turn signal is not
    // something the pane can still be acted on through. `complete` lights the
    // card on its own — it does not need a stale flag's help.
    const { paneB } = seed();
    runTurn(paneB);

    setStatus(paneB, "complete");

    expect(glowing(paneB)).toBe(false);
  });

  it("says nothing about a pane the user has never typed into", () => {
    // Same gate the rest of the bridge uses: a freshly spawned pane whose
    // agent banner comes and goes has not finished anything for anyone.
    const { paneB } = seed();
    useTerminalRuntimeStore.setState({ hasUserInput: {}, turnFinished: {} });

    runTurn(paneB);

    expect(glowing(paneB)).toBe(false);
    expect(kinds()).toEqual([]);
    expect(ding).not.toHaveBeenCalled();
  });

  it("does not chime twice when RocPlan files the same turn end", () => {
    // A dispatched pane's turn end raises two rows: this bridge's, and
    // RocPlan's `review` a round trip later, once the board has moved the card.
    // The second row says more than the first and is worth keeping; a second
    // chime a heartbeat after the first is just a stutter.
    const { paneB } = seed();
    runTurn(paneB);

    useNotificationsStore.getState().push({
      terminalId: paneB,
      terminalName: "Roxie",
      agentType: "claude-code",
      kind: "review",
    });

    expect(kinds()).toEqual(["review", "turn-finished"]);
    expect(ding).toHaveBeenCalledTimes(1);
  });

  it("a crash right after a turn end still dings", () => {
    // The one-event-two-rows window is the `turn-finished`/`review` pair and
    // nothing else. A pane that finishes a turn and then dies a second later
    // has said two different things, and the second one is the one that needs
    // a person — silencing it because the first was recent is the worst trade
    // this file could make.
    const { paneB } = seed();
    runTurn(paneB);
    expect(ding).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1500);
    setStatus(paneB, "running");
    setStatus(paneB, "error");

    expect(kinds()).toEqual(["error", "turn-finished"]);
    expect(ding).toHaveBeenCalledTimes(2);
  });

  it("a permission prompt right after a turn end still dings", () => {
    // Same rule, and the sharper case: `awaiting` BLOCKS — the agent is
    // stopped until someone answers — and a turn ending is the kind that does
    // not. The blocking signal must never be the one that goes quiet.
    const { paneB } = seed();
    runTurn(paneB);

    vi.advanceTimersByTime(1500);
    setStatus(paneB, "running");
    setStatus(paneB, "awaiting_approval");

    expect(kinds()).toEqual(["awaiting", "turn-finished"]);
    expect(ding).toHaveBeenCalledTimes(2);
  });

  it("still chimes for a different pane inside the window", () => {
    // The window is per pane. Two agents finishing at once are two events.
    const { paneB, paneC } = seed();

    runTurn(paneB);
    runTurn(paneC);

    expect(ding).toHaveBeenCalledTimes(2);
  });

  describe("only a pane whose agent reports its own turns", () => {
    // `idle` is where every pane RESTS. It is news only when it arrived from a
    // Stop hook; on a shell pane it is the prompt coming back, which has never
    // been a turn ending. Nothing mints that transition for a shell today, but
    // `persistence.ts` and `savedSessions.ts` both write `idle` into the store
    // from disk, so the branch is one status event away from being reachable.

    it("says nothing about a shell pane going idle", () => {
      const w = newWorkspace({ name: "W", projectPath: "/tmp/p", order: 0 });
      const shell = newTerminal({
        workspaceId: w.id,
        name: "sh",
        agentType: "shell",
        projectPath: "/tmp/p",
      });
      useWorkspacesStore.setState({
        workspaces: [
          { ...w, paneTree: { kind: "leaf", terminalId: shell.id } },
        ],
        activeWorkspaceId: w.id,
      });
      useTerminalsStore.getState().setTerminals([shell]);
      useTerminalRuntimeStore.getState().notifyUserInput(shell.id);

      runTurn(shell.id);

      expect(glowing(shell.id)).toBe(false);
      expect(kinds()).toEqual([]);
      expect(ding).not.toHaveBeenCalled();
    });

    it("says nothing about a pane whose uuid is only a resume offer", () => {
      // A hydrated pane keeps the conversation it was in so the offer survives
      // a boot, but that conversation's process died with the last quit — no
      // hook will ever fire for it. The parked offer is what tells the two
      // apart, and it is the reason this asks `isHookDriven` rather than
      // "does it have a uuid".
      const { paneB } = seed();
      useTerminalRuntimeStore.getState().markResumable(paneB, "uuid-Roxie");

      runTurn(paneB);

      expect(glowing(paneB)).toBe(false);
      expect(kinds()).toEqual([]);
    });
  });

  it("keeps the process-exit notification it always pushed", () => {
    const { paneB } = seed();

    setStatus(paneB, "running");
    setStatus(paneB, "complete");

    expect(kinds()).toEqual(["complete"]);
  });
});
