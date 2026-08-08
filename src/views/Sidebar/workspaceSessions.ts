/** Which live sessions belong to a workspace.
 *
 *  The sidebar used to answer this from the workspace's `paneTree`, and the
 *  tree is the layout, not the roster. `null` there means "not derived yet" —
 *  `ensurePaneTree` builds it FROM the sessions, so there is a window in every
 *  workspace's life where the panes exist and the tree does not, plus a
 *  restored snapshot that lands the same way. A row reading the tree calls that
 *  workspace "0 panes" and closes it without asking, killing running agents in
 *  silence. The sessions are the thing that is running; ask them.
 */

import { useTerminalsStore } from "@/stores";
import type { TerminalSession } from "@/lib/bindings";

const belongsTo = (session: TerminalSession, workspaceId: string): boolean =>
  session.workspaceId === workspaceId;

/** How many panes the workspace holds, live. A primitive, so a row re-renders
 *  when a pane appears or goes and not when one of them prints. */
export const useWorkspacePaneCount = (workspaceId: string): number =>
  useTerminalsStore((s) => {
    let n = 0;
    // for..in over the keys rather than Object.values(): this selector re-runs
    // on EVERY terminals-store write, output chunks included, once per mounted
    // row. Materializing an array here would allocate on each PTY chunk.
    for (const id in s.byId) {
      if (belongsTo(s.byId[id]!, workspaceId)) n++;
    }
    return n;
  });

/** The workspace's sessions that still have something running.
 *
 *  A plain function, not a hook: the answer is needed at the instant the close
 *  button is pressed, and a subscription in every row would re-run on every
 *  output chunk to keep an answer nobody is reading. */
export function runningSessionsIn(
  byId: Record<string, TerminalSession>,
  workspaceId: string,
): TerminalSession[] {
  return Object.values(byId).filter(
    (session) =>
      belongsTo(session, workspaceId) && session.status === "running",
  );
}
