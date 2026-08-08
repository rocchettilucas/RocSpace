/** Roc — the orchestrator you talk to.
 *
 *  One store behind two surfaces: the floating widget (`components/RocWidget`)
 *  and the expanded view it opens into (`views/Roc/RocView`). Everything here
 *  is ephemeral, like `useUIStore`: a phase, a transcript, what the rail has
 *  selected, and a short log of what was sent where. Nothing about a live
 *  conversation is worth carrying across a quit.
 *
 *  The one field that is NOT this store's own answer is `expanded`. It has to
 *  agree with `useUIStore.mainView === "roc"` — the Roc view takes the dock's
 *  place through the same swap RocPlan uses — and the two cannot be allowed to
 *  drift, because anything at all can move the main view: ⌘⇧P, a toast's
 *  "Watch it work", a workspace opening. So `expanded` is kept as a MIRROR of
 *  the main view (see the subscription at the bottom) rather than as a second
 *  source of truth, and `setExpanded` moves the main view and lets the mirror
 *  follow. It stays a field rather than becoming a selector because the shared
 *  interface for this phase names it one, and the parallel workstreams read it.
 */

import { create } from "zustand";
import { devtools } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";
import { useTerminalsStore } from "@/stores/terminals";
import { useUIStore } from "@/stores/ui";

/** What Roc is doing right now. Drives the orb, the phase label, and (in wave
 *  2) whether the command bar accepts a dispatch.
 *
 *  "thinking" was a label with nothing behind it until Phase 6: a transcript
 *  arriving set it and the next thing that happened put it back. It is now the
 *  reasoning turn and ONLY that — `runRocBrain` holds it for as long as
 *  `claude -p` is out, and a dictated sentence waiting on the stage for the
 *  user to do something with it leaves the orb alone. "Speaking" is the reply
 *  being said aloud, which is the one phase the user can hear as well as see.
 *
 *  Each phase is taken by one thing and given back by the same thing, which is
 *  what makes any of them mean anything: the fan-out owns "dispatching", the
 *  brain owns "thinking", the voice owns "speaking", and the microphone's
 *  "listening" outranks all three (see `rocBrain`'s two yield lists and
 *  `rocDispatch.HOLDS_THE_ORB`). */
export type RocPhase =
  "idle" | "listening" | "thinking" | "dispatching" | "speaking";

/** A pane a dispatch can be aimed at. Carries the name because that is what the
 *  user typed (`@Rocky`) and what the log reads back, and the workspace because
 *  the rail spans every workspace — an id alone cannot say which dock it is
 *  in. */
export interface RocTarget {
  terminalId: string;
  name: string;
  workspaceId: string;
}

/** One thing Roc was asked to say, and who it went to.
 *
 *  The whole target rather than the name, and that is the point: the log
 *  outlives the panes it names, so a re-send has to look them up again — but
 *  `Rocky` is a name the pool hands out PER APP, and two workspaces really can
 *  both hold one. A record that remembered only "Rocky" was a record that could
 *  not tell them apart, and re-sending a broadcast made in one project put it
 *  into panes in another. The workspace is what makes the name mean a pane
 *  again; the id is what lets a re-send notice the session is the same one. */
export interface RocDispatchRecord {
  /** This entry, and no other. The log was keyed on `at` plus the text, and
   *  both of those are things two dispatches can share: pressing the same
   *  log entry twice, or a re-send racing an Enter, puts two records with the
   *  same millisecond and the same words in the list, React finds duplicate
   *  keys and refuses to render. An id is the only thing that cannot collide. */
  id: string;
  at: number;
  text: string;
  targets: RocTarget[];
  /** Did Roc's brain decide who this went to?
   *
   *  A brain turn writes ONE record naming every agent it fed, rather than one
   *  per assignment: the user said one thing, and a log that split it into
   *  three entries would read as three messages they never sent. The text of
   *  such a record is what they actually said — each agent got its own tailored
   *  prompt, and there is no single sentence that was sent to all of them.
   *
   *  Which is why it is drawn differently (the log marks these), and why it is
   *  re-sent differently — see `prompts`. */
  viaBrain: boolean;
  /** On a brain turn: the instruction each AGENT was actually given, by name.
   *
   *  What makes re-sending one of these possible at all. `text` is the sentence
   *  the person said, and sending THAT again would paste "ask Rocky to fix the
   *  auth test and have Roxie update the login form" into both panes — the
   *  Phase-4 behaviour this whole phase exists to replace, one click away in the
   *  log. So the prompts travel with the record and each pane gets its own back.
   *
   *  By name rather than by terminal id because a re-send re-resolves names: a
   *  session restarted since is a new id under the same name, and it is the same
   *  agent as far as the instruction is concerned. Absent on everything else — a
   *  typed message is one sentence to every pane, which `text` already is. */
  prompts?: Record<string, string>;
}

/** How many dispatches the log remembers. A session's worth of context, not an
 *  archive — the panes themselves hold the transcript. */
export const ROC_LOG_CAP = 50;

interface RocState {
  phase: RocPhase;
  /** Is the floating widget on screen? Its own flag rather than a derivative of
   *  anything: closing the widget is the user saying "not now", and it must
   *  survive expanding into the view and coming back. */
  open: boolean;
  /** Mirrors `mainView === "roc"`. Never written directly except by the mirror
   *  below and by `setExpanded`, which moves the main view first. */
  expanded: boolean;
  /** The live (or last) transcript — dictated or typed. */
  transcript: string;
  /** The rail's multi-select. Ids, in the order they were picked. */
  selectedTerminalIds: string[];
  /** Whose live terminal the expanded view is showing. Deliberately separate
   *  from the selection: watching one agent while addressing three is the
   *  normal case. */
  focusedRailTerminalId: string | null;
  /** Newest first, capped at `ROC_LOG_CAP`. */
  log: RocDispatchRecord[];
  /** What Roc last said back, or null. Shown on the stage and the widget, and
   *  spoken when `settings.roc.speakReplies` is on. */
  reply: string | null;
  /** Why the last reasoning turn produced nothing. A sentence for the user —
   *  a missing CLI, a timeout, an answer that was not JSON — never a stack
   *  trace, and never silence: a brain that fails without saying so is
   *  indistinguishable from the Phase 4 Roc this phase exists to replace. */
  brainError: string | null;
}

interface RocActions {
  setPhase: (p: RocPhase) => void;
  setTranscript: (t: string) => void;
  clearTranscript: () => void;
  toggleOpen: () => void;
  setExpanded: (v: boolean) => void;
  toggleSelected: (terminalId: string) => void;
  selectOnly: (ids: string[]) => void;
  clearSelection: () => void;
  setFocusedRail: (terminalId: string | null) => void;
  pushLog: (rec: RocDispatchRecord) => void;
  setReply: (text: string | null) => void;
  setBrainError: (message: string | null) => void;
}

const initialState: RocState = {
  phase: "idle",
  open: true,
  expanded: false,
  transcript: "",
  selectedTerminalIds: [],
  focusedRailTerminalId: null,
  log: [],
  reply: null,
  brainError: null,
};

export const useRocStore = create<RocState & RocActions>()(
  devtools(
    immer((set) => ({
      ...initialState,

      setPhase: (p) =>
        set((s) => {
          s.phase = p;
        }),

      setTranscript: (t) =>
        set((s) => {
          s.transcript = t;
        }),

      /** The transcript has been dealt with — sent, edited into the bar, or
       *  thrown away — so take it off the stage.
       *
       *  And nothing else. This used to put the phase back to "idle" when it
       *  found "thinking", because a transcript ARRIVING used to set that: a
       *  label with nothing behind it, which then stayed on until something
       *  happened to move it. Now that "thinking" means a reasoning turn is
       *  actually out, taking it back here would put the orb to sleep on a
       *  `claude -p` call that is still running — and the turn's own release
       *  would find the phase already gone. Whoever took the phase gives it
       *  back; clearing a line of text is not that. */
      clearTranscript: () =>
        set((s) => {
          s.transcript = "";
        }),

      toggleOpen: () =>
        set((s) => {
          s.open = !s.open;
        }),

      setExpanded: (v) => {
        set((s) => {
          s.expanded = v;
        });
        const ui = useUIStore.getState();
        if (v) {
          if (ui.mainView !== "roc") ui.setMainView("roc");
          return;
        }
        // Only ever give the dock back from OUR view. Collapsing while the
        // board is up would otherwise drag the user off the board.
        if (ui.mainView === "roc") ui.setMainView("terminals");
      },

      toggleSelected: (terminalId) =>
        set((s) => {
          const at = s.selectedTerminalIds.indexOf(terminalId);
          if (at === -1) s.selectedTerminalIds.push(terminalId);
          else s.selectedTerminalIds.splice(at, 1);
        }),

      selectOnly: (ids) =>
        set((s) => {
          s.selectedTerminalIds = [...new Set(ids)];
        }),

      clearSelection: () =>
        set((s) => {
          s.selectedTerminalIds = [];
        }),

      setFocusedRail: (terminalId) =>
        set((s) => {
          s.focusedRailTerminalId = terminalId;
        }),

      pushLog: (rec) =>
        set((s) => {
          s.log.unshift(rec);
          if (s.log.length > ROC_LOG_CAP) s.log.length = ROC_LOG_CAP;
        }),

      setReply: (text) =>
        set((s) => {
          s.reply = text;
        }),

      setBrainError: (message) =>
        set((s) => {
          s.brainError = message;
        }),
    })),
    { name: "roc" },
  ),
);

/** Keep `expanded` honest about which view is actually up.
 *
 *  Module level, and never unsubscribed: it has exactly the store's lifetime,
 *  and there is no mount for it to hang off — the widget can be closed while
 *  the view is open, and the chord that opens the view is bound on the
 *  document. Cheap by construction: it returns on the first line for every
 *  write to the UI store that is not a view swap, which is all of them bar a
 *  handful per session. */
useUIStore.subscribe((s, prev) => {
  if (s.mainView === prev.mainView) return;
  const expanded = s.mainView === "roc";
  if (useRocStore.getState().expanded === expanded) return;
  useRocStore.setState({ expanded });
});

/** Forget a pane the moment it stops existing.
 *
 *  A selection that outlives its pane is not harmless bookkeeping: the rail's
 *  All/None button reads it, `resolveTargets` reads it, and a stale id makes
 *  both of them describe a fan-out that is smaller than it says it is. Closing
 *  a pane — or a whole workspace — does not reach into this store, so this is
 *  where the reaching happens.
 *
 *  `focusedRailTerminalId` is deliberately NOT pruned. It is the answer to
 *  "whose screen am I watching", and the live terminal has something to say
 *  about a session that has gone ("That session is gone.") — blanking the panel
 *  instead would leave the user wondering what they had been looking at.
 *
 *  Cheap on the hot path by construction: the terminals store is rewritten on
 *  every frame that carries PTY output, and this returns on its first line for
 *  every user who has not selected anything. */
useTerminalsStore.subscribe((s, prev) => {
  if (s.byId === prev.byId) return;
  const { selectedTerminalIds } = useRocStore.getState();
  if (selectedTerminalIds.length === 0) return;
  const live = selectedTerminalIds.filter((id) => s.byId[id] !== undefined);
  if (live.length === selectedTerminalIds.length) return;
  useRocStore.setState({ selectedTerminalIds: live });
});

// Selectors --------------------------------------------------------------

export const useRocPhase = (): RocPhase => useRocStore((s) => s.phase);
export const useRocOpen = (): boolean => useRocStore((s) => s.open);
export const useRocExpanded = (): boolean => useRocStore((s) => s.expanded);
export const useRocTranscript = (): string => useRocStore((s) => s.transcript);
export const useRocSelection = (): string[] =>
  useRocStore((s) => s.selectedTerminalIds);
export const useRocLog = (): RocDispatchRecord[] => useRocStore((s) => s.log);
export const useRocFocusedRail = (): string | null =>
  useRocStore((s) => s.focusedRailTerminalId);
export const useRocReply = (): string | null => useRocStore((s) => s.reply);
export const useRocBrainError = (): string | null =>
  useRocStore((s) => s.brainError);
