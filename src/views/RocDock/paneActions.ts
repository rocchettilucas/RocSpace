/** Everything that adds or removes a pane.
 *
 *  Split, close, and "give this new session a pane" all have to touch three
 *  stores and the PTY runtime in the right order, so they live here rather than
 *  being reimplemented in each caller (card buttons, keyboard shortcuts, the
 *  sidebar). Written as plain functions over `store.getState()`, not hooks:
 *  every caller is an event handler.
 *
 *  Splitting spawns a NEW terminal in the same cwd as the pane it was split
 *  from, inserted directly after it. */

import { nextRocName, uniqueName } from "@/lib/agentLabels";
import { commands } from "@/lib/bindings";
import { newTerminal } from "@/lib/factories";
import { LIMITS } from "@/lib/limits";
import { hasLeaf, leafIds, type SplitDirection } from "@/lib/paneTree";
import { spawnTerminal } from "@/lib/spawn";
import {
  confirmAction,
  hasPaneRoom,
  useSettingsStore,
  useTerminalsStore,
  useToastsStore,
  useUIStore,
  useWorkspacesStore,
} from "@/stores";
import type { TerminalSession } from "@/lib/bindings";

const sessionsIn = (workspaceId: string): TerminalSession[] =>
  Object.values(useTerminalsStore.getState().byId).filter(
    (t) => t.workspaceId === workspaceId,
  );

/** The first roc name the workspace is not already using.
 *
 *  Scoped to the workspace, not the app: the taken set that matters is the one
 *  the user can see in this dock, so every workspace starts at Rocky.
 *
 *  Deliberately not a function of the agent type: the pane's badge already says
 *  which CLI is running, and the name is the user's handle for the pane, which
 *  should survive switching that CLI. See `nextRocName` for why the taken set
 *  is the input rather than a count. */
export function defaultPaneName(workspaceId: string): string {
  return nextRocName(new Set(sessionsIn(workspaceId).map((t) => t.name)));
}

/** `name`, made unique within the workspace — the rule a rename goes through.
 *
 *  A name is how the user addresses a pane, so two panes answering to one is
 *  the same ambiguity `defaultPaneName` exists to prevent; a rename is just the
 *  other way to reach it. Disambiguating rather than rejecting is the choice
 *  here: the user typed a word they meant, and a rename that silently refuses
 *  (or holds the field open on a name that looks perfectly good) reads as a
 *  broken control. They get the word plus a number, which is the same answer
 *  the pool gives when it runs out, and can rename again to something else.
 *
 *  `exceptId` is the pane being renamed: it holds its own current name, and
 *  re-committing that must not turn Rocky into "Rocky 2". */
export function uniquePaneName(
  workspaceId: string,
  name: string,
  exceptId: string,
): string {
  const taken = new Set(
    sessionsIn(workspaceId)
      .filter((t) => t.id !== exceptId)
      .map((t) => t.name),
  );
  return uniqueName(name, taken);
}

/** True when the workspace still has room for another session. Imperative form
 *  of the `useCanAddPane` selector — same rule, one implementation, so a
 *  control's disabled state and the action behind it cannot disagree. */
export function canAddPane(workspaceId: string): boolean {
  return hasPaneRoom(useTerminalsStore.getState().byId, workspaceId);
}

/** The toast this module last put up about the cap, while it is still on
 *  screen. ⌘D autorepeats, and a held key at the cap was otherwise three
 *  identical warnings stacked on top of each other — the toast stack holds
 *  three, so the user would have seen exactly that. */
let capToastId: string | null = null;

/** Refuse a pane, out loud.
 *
 *  The split BUTTONS disable themselves at the cap and say why in their tooltip
 *  (see `PaneHeader`), so what reaches here is the routes that cannot: ⌘D, ⌘⇧D,
 *  ⌘N. A chord that does nothing and writes a line to a console the user does
 *  not have open is a broken keyboard as far as they can tell — which is what
 *  this was until it said something.
 *
 *  Returns false so the callers can `return refuseAtCap(…)`. */
function refuseAtCap(what: string): false {
  console.warn(
    `[panes] ${what} refused: workspace is at its ${LIMITS.terminalsPerWorkspace}-terminal cap`,
  );
  const toasts = useToastsStore.getState();
  if (capToastId !== null && toasts.items.some((t) => t.id === capToastId)) {
    return false;
  }
  capToastId = toasts.push({
    message: `This workspace already holds ${LIMITS.terminalsPerWorkspace} panes — close one to open another.`,
    tone: "warn",
  });
  return false;
}

/** Launch (or relaunch) every pane in `terminalIds`, asking first when any of
 *  them is still running.
 *
 *  `spawnTerminal` is not "start if stopped": `PtyRuntime::spawn` opens by
 *  killing whatever is on that id, so "Launch all" over a working dock is
 *  sixteen agents losing the turn they were mid-way through. ⌘W asks before
 *  doing that to one pane and "Close this workspace" asks before doing it to a
 *  workspace's worth; this is the same question about the same risk, and it was
 *  the one route to it that never asked.
 *
 *  Shared by the topbar's Play button and the palette's "Launch every pane" so
 *  the two cannot disagree about when the question is worth asking. */
export async function launchPanes(
  terminalIds: readonly string[],
): Promise<void> {
  const byId = useTerminalsStore.getState().byId;
  const sessions = terminalIds
    .map((id) => byId[id])
    .filter((t): t is TerminalSession => t !== undefined);
  if (sessions.length === 0) return;

  const running = sessions.filter((t) => t.status === "running");
  if (running.length > 0) {
    const ok = await confirmAction({
      title: "Launch every pane",
      message: `Relaunch ${sessions.length} pane${
        sessions.length === 1 ? "" : "s"
      }? ${running.length === 1 ? "1 is" : `${running.length} are`} still running.`,
      detail:
        "Launching a pane kills what it is doing first, so a conversation in progress is lost. The scrollback stays.",
      confirmLabel: "Launch every pane",
      tone: "danger",
    });
    if (!ok) return;
  }

  // Read again after the await, for the same reason `closeTerminalPane` does:
  // a pane can exit — or a whole workspace close — while the question is on
  // screen, and spawning onto an id nothing holds any more is a pane the dock
  // has no leaf for.
  const live = useTerminalsStore.getState().byId;
  for (const session of sessions) {
    const current = live[session.id];
    if (current) void spawnTerminal(current);
  }
}

/** Split `terminalId`'s pane, spawning a fresh agent beside it. Returns false
 *  (and spawns nothing) when the workspace is at its cap. */
export function splitTerminal(
  terminalId: string,
  direction: SplitDirection,
): boolean {
  const source = useTerminalsStore.getState().byId[terminalId];
  if (!source) return false;

  const { workspaceId } = source;
  if (!canAddPane(workspaceId)) return refuseAtCap("split");

  const agentType = useSettingsStore.getState().agentDefaults.agentType;
  const session = newTerminal({
    workspaceId,
    name: defaultPaneName(workspaceId),
    agentType,
    projectPath: source.projectPath,
  });

  useTerminalsStore.getState().addTerminal(session);
  useWorkspacesStore
    .getState()
    .splitTerminalPane(workspaceId, terminalId, direction, session.id);

  const ui = useUIStore.getState();
  // A maximized pane hides the whole tree, so a split under one would spawn an
  // agent the user cannot see. Drop back to the tree and focus what they made.
  if (ui.maximizedTerminalId !== null) ui.exitMaximize();
  ui.focusTerminal(session.id);

  // `spawnTerminal` is the one spawn path: it passes the session's whole agent
  // config (so a split-in pane honours the user's model and permissions) and
  // records the returned pid / Claude session id back onto the session.
  void spawnTerminal(session);
  return true;
}

/** ⌘D / ⌘⇧D / ⌘N. Splits the focused pane, falling back to the first pane in
 *  the active workspace's tree when focus has not landed anywhere yet — and to
 *  minting the workspace's first pane when there is no tree at all. */
export function splitFocused(direction: SplitDirection): boolean {
  const target = resolveTargetTerminalId();
  if (target !== null) return splitTerminal(target, direction);
  return openFirstPane(direction);
}

/** Open the active workspace's first pane, for the case where there is nothing
 *  to split from: a workspace whose panes were all closed.
 *
 *  Without this the pane chords are dead exactly where the empty dock tells the
 *  user to press ⌘D, and closing the last pane is a one-way door — nothing in
 *  the dock can reopen one. */
function openFirstPane(direction: SplitDirection): boolean {
  const { workspaces, activeWorkspaceId } = useWorkspacesStore.getState();
  const workspace = workspaces.find((w) => w.id === activeWorkspaceId);
  if (!workspace) return false;

  if (!canAddPane(workspace.id)) return refuseAtCap("new pane");

  const agentType = useSettingsStore.getState().agentDefaults.agentType;
  const session = newTerminal({
    workspaceId: workspace.id,
    // No source pane to inherit a cwd from, so the workspace's own directory is
    // the only sensible answer. "" is the cwd-less spawn Rust understands.
    projectPath: workspace.projectPath ?? "",
    name: defaultPaneName(workspace.id),
    agentType,
  });

  useTerminalsStore.getState().addTerminal(session);
  // `attachPane` owns the no-tree case already (it rebuilds around every
  // session the workspace has, not just this one), plus the focus and maximize
  // bookkeeping.
  attachPane(workspace.id, session.id, direction);
  void spawnTerminal(session);
  return true;
}

/** Kill the PTY, drop the pane, forget the session. Confirms first only when
 *  the agent is still running — closing an idle or finished pane is not a
 *  decision worth a dialog.
 *
 *  Async since the confirmation became a real dialog rather than
 *  `window.confirm`. Callers `void` it: nothing waits on a pane closing, and
 *  the one thing that used to be true while a native dialog was up — that the
 *  whole webview was frozen, PTY readers included — is exactly what this stops
 *  doing. Which is also why the session is read AGAIN after the await: an
 *  agent that exits, or a workspace that closes, while the question is on
 *  screen would otherwise be torn down twice. */
export async function closeTerminalPane(terminalId: string): Promise<void> {
  const terminal = useTerminalsStore.getState().byId[terminalId];
  if (!terminal) return;

  if (terminal.status === "running") {
    const ok = await confirmAction({
      title: "Close pane",
      message: `Close “${terminal.name}”? It is still running.`,
      detail:
        "The agent's process is killed and its scrollback goes with the pane.",
      confirmLabel: "Close pane",
      tone: "danger",
    });
    if (!ok) return;
    if (!useTerminalsStore.getState().byId[terminalId]) return;
  }

  commands.terminalKill(terminalId).catch(() => {
    /* non-fatal: the child may already be gone */
  });
  useWorkspacesStore
    .getState()
    .removeTerminalPane(terminal.workspaceId, terminalId);
  useTerminalsStore.getState().removeTerminal(terminalId);

  const ui = useUIStore.getState();
  if (ui.maximizedTerminalId === terminalId) ui.exitMaximize();
  if (ui.focusedTerminalId === terminalId) {
    // Hand focus to whatever is now first, so the next ⌘W has a target and the
    // inspector does not sit on a session that no longer exists.
    const tree = workspaceTree(terminal.workspaceId);
    ui.focusTerminal(tree ? (leafIds(tree)[0] ?? null) : null);
  }
}

/** ⌘W. */
export function closeFocusedPane(): void {
  const target = resolveTargetTerminalId();
  if (target !== null) void closeTerminalPane(target);
}

/** Give a session that was created elsewhere a pane: split the focused one when
 *  there is one, otherwise rebuild the workspace's tree so the new session is
 *  included.
 *
 *  Call AFTER `addTerminal` — the rebuild path reads the store. */
export function attachPane(
  workspaceId: string,
  terminalId: string,
  direction: SplitDirection = "row",
): void {
  const tree = workspaceTree(workspaceId);
  // Already on screen. Called twice for one session — a double-click on a
  // control, a caller that does not know it already ran — this would otherwise
  // split a second leaf for a terminal that has one, putting two xterms on a
  // single PTY.
  if (tree !== null && hasLeaf(tree, terminalId)) return;

  const focusedId = useUIStore.getState().focusedTerminalId;

  // Split something rather than rebuild whenever there is anything to split —
  // a rebuild is balanced, which silently throws away every ratio the user has
  // dragged. Falling back to the first pane keeps them.
  const target =
    tree === null
      ? null
      : focusedId !== null &&
          focusedId !== terminalId &&
          hasLeaf(tree, focusedId)
        ? focusedId
        : (leafIds(tree).find((id) => id !== terminalId) ?? null);

  if (target !== null) {
    useWorkspacesStore
      .getState()
      .splitTerminalPane(workspaceId, target, direction, terminalId);
  } else {
    useWorkspacesStore.getState().ensurePaneTree(
      workspaceId,
      sessionsIn(workspaceId).map((t) => t.id),
    );
  }

  const ui = useUIStore.getState();
  if (ui.maximizedTerminalId !== null) ui.exitMaximize();
  ui.focusTerminal(terminalId);
}

function workspaceTree(workspaceId: string) {
  return (
    useWorkspacesStore.getState().workspaces.find((w) => w.id === workspaceId)
      ?.paneTree ?? null
  );
}

/** The pane a keyboard shortcut acts on: the focused one, or the first in the
 *  active workspace's tree when nothing has focus yet (fresh boot, or focus was
 *  just released by a close). */
function resolveTargetTerminalId(): string | null {
  const focusedId = useUIStore.getState().focusedTerminalId;
  const { workspaces, activeWorkspaceId } = useWorkspacesStore.getState();
  const tree =
    workspaces.find((w) => w.id === activeWorkspaceId)?.paneTree ?? null;
  if (tree === null) return null;
  if (focusedId !== null && hasLeaf(tree, focusedId)) return focusedId;
  return leafIds(tree)[0] ?? null;
}
