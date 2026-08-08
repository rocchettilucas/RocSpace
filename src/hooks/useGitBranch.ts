/** Live git branch for a directory, for the pane header's chip. */

import { useEffect, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  EVENT_GIT_BRANCH,
  commands,
  type GitBranchEvent,
  type GitWatchHandle,
} from "@/lib/bindings";

/** The branch `path` is on, or null when it is not in a repository (or is not
 *  known yet). Updates within ~2 s of a `git checkout` in that directory.
 *
 *  Two halves, because one alone is not enough: registering the watch answers
 *  *now* (a chip that waited a poll interval to appear would flicker in on
 *  every pane mount), and the events carry changes afterwards. Rust only emits
 *  on an actual change, so the two never fight over the same value.
 *
 *  Both halves come from `gitWatch` on purpose, and this is the whole reason
 *  the command returns a branch at all. Asking `gitBranch` separately made the
 *  opening value and the watcher's baseline two different reads of the same
 *  file: a checkout landing between them left this hook holding the first read
 *  while Rust's baseline held the second, and since Rust only speaks when its
 *  baseline MOVES, it never corrected us. The chip sat on a branch the pane was
 *  not on, indefinitely. One read cannot disagree with itself.
 *
 *  Every Tauri call is guarded: this hook renders in unit tests and in a plain
 *  browser dev server, where there is no IPC to talk to and a rejected promise
 *  would surface as an unhandled rejection rather than a missing chip. */
export function useGitBranch(path: string | null | undefined): string | null {
  // The answer is stored *with* the path it is an answer to. Keeping the two
  // together is what makes a path change resolve to "unknown" immediately
  // rather than showing the previous directory's branch until the new lookup
  // lands — and it does it without a clearing `setState` in the effect body.
  const [resolved, setResolved] = useState<{
    path: string;
    branch: string | null;
  } | null>(null);

  useEffect(() => {
    if (!path) return;

    let live = true;
    let unlisten: UnlistenFn | undefined;
    const setBranch = (branch: string | null) => setResolved({ path, branch });

    // Registering the watch is also how the opening value is fetched — see
    // above for why those cannot be two calls.
    //
    // `root` is the repository the pane's path turned out to be in. Rust keys
    // watches by repo root, not by the path asked about — two panes in one
    // project are one watch — so this, not `path`, is what the events are
    // labelled with.
    //
    // Kept as the promise as well as the value: the pane can unmount before
    // the watch lands, and the cleanup has to release a reference that only
    // exists by then. Awaiting the promise there is what makes an open/close
    // faster than the IPC round trip stop leaking a watch.
    let root: string | null = null;
    const watching: Promise<GitWatchHandle | null> = (async () => {
      try {
        return await commands.gitWatch(path);
      } catch {
        /* no IPC (tests, browser dev server) — the chip just stays hidden */
        return null;
      }
    })();
    void watching.then((handle) => {
      if (handle === null) return;
      root = handle.root;
      if (live) setBranch(handle.branch);
    });

    void (async () => {
      try {
        const stop = await listen<GitBranchEvent>(EVENT_GIT_BRANCH, (event) => {
          // One event stream for every watched repository.
          if (live && root !== null && event.payload.root === root) {
            setBranch(event.payload.branch);
          }
        });
        // The effect may already have been torn down while `listen` was in
        // flight; without this the subscription would outlive the pane.
        if (live) unlisten = stop;
        else stop();
      } catch {
        /* no IPC */
      }
    })();

    return () => {
      live = false;
      unlisten?.();
      void (async () => {
        // By root, not by path — the registry is not keyed by what was asked
        // about — and only after the watch has actually landed, so a pane
        // closed mid-round-trip still gives its reference back.
        const watched = await watching;
        if (watched === null) return;
        try {
          await commands.gitUnwatch(watched.root);
        } catch {
          /* no IPC */
        }
      })();
    };
  }, [path]);

  return resolved !== null && resolved.path === path ? resolved.branch : null;
}
