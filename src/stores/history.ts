/** What went wrong starting things, this run.
 *
 *  A spawn failure is swallowed on purpose — every call site is a loop over
 *  sessions, and one missing binary must not abort "launch all" for the rest
 *  (see `lib/spawn.ts`). Swallowed used to mean *gone*: a `console.warn` in a
 *  desktop app is a message in a DevTools window the user does not have open,
 *  so a pane that never came up looked like a pane that had simply not been
 *  clicked yet. This is where those go instead, and Settings › History is where
 *  they are read.
 *
 *  Session-scoped and never persisted. Every record describes something the
 *  user asked for on this run of the app that did not come up; carrying them
 *  across a restart would be showing the user yesterday's weather. */

import { create } from "zustand";
import { newId } from "@/lib/factories";

/** How many failures are kept. Long enough to cover a bad boot across every
 *  workspace, short enough that the list stays readable. */
export const MAX_HISTORY_FAILURES = 50;

export interface StartupFailure {
  id: string;
  /** Which of the three ways a start can fail. Worth distinguishing: a resume
   *  fails on its own terms (the transcript is gone) and the answer is "start
   *  fresh", which is not the answer to a missing binary — and a restore fails
   *  before there is any pane at all, because the file on disk does not
   *  describe a workspace. */
  kind: "spawn" | "resume" | "restore";
  /** What the user calls the thing that did not come up: a pane's roc name, or
   *  the saved session's name. Never an ulid. */
  name: string;
  /** Where it was headed. Null for a restore — the workspace is the thing that
   *  failed to exist, so naming one would be inventing it. */
  workspaceName: string | null;
  /** The message as Rust reported it, or as the reader made it. */
  error: string;
  at: number;
}

interface HistoryState {
  /** Newest first. */
  failures: StartupFailure[];
  recordFailure: (failure: Omit<StartupFailure, "id" | "at">) => void;
  clearFailures: () => void;
}

export const useHistoryStore = create<HistoryState>((set) => ({
  failures: [],

  recordFailure: (failure) =>
    set((s) => ({
      failures: [
        { ...failure, id: newId(), at: Date.now() },
        ...s.failures,
      ].slice(0, MAX_HISTORY_FAILURES),
    })),

  clearFailures: () => set({ failures: [] }),
}));

export const useStartupFailures = (): StartupFailure[] =>
  useHistoryStore((s) => s.failures);
