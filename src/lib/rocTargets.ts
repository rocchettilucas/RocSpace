/** Who a message to Roc is for.
 *
 *  Two halves, deliberately apart. `parseRocCommand` is text in, text out — it
 *  knows nothing about sessions and can be run on every keystroke to show the
 *  user what they have typed. `resolveTargets` is the half that looks at the
 *  world, and it reads the stores directly rather than taking them as arguments
 *  for the same reason `rocplanDispatch` does: the caller is a keystroke
 *  handler, and threading four stores through it would only mean four more
 *  chances for a stale snapshot.
 *
 *  A name is not an id, and that is on purpose all the way through: `@Rocky` is
 *  what the user says out loud, it survives a change of agent, and the pool
 *  hands the same one out per app — so two workspaces really can both hold a
 *  Rocky, and naming one addresses both. Ids are what comes back. */

import { leafIds } from "@/lib/paneTree";
import { useRocStore, type RocTarget } from "@/stores/roc";
import { useTerminalsStore } from "@/stores/terminals";
import { useUIStore } from "@/stores/ui";
import { useWorkspacesStore } from "@/stores/workspaces";
import type { TerminalSession } from "@/lib/bindings";

export interface ParsedRocCommand {
  /** The message with its tokens taken out. */
  text: string;
  /** The names as TYPED — resolving them is `resolveTargets`' job, and an
   *  unknown one is handed back in the user's own spelling so the warning can
   *  quote it. */
  explicitNames: string[];
  broadcast: boolean;
}

/** The words that mean "everyone". Kept small on purpose: every alias is a
 *  name a pane can no longer be called. */
const BROADCAST_ALIASES = new Set(["all", "everyone"]);

/** A mention, anywhere in the string: an `@` followed by a run of name
 *  characters. Whether a given hit IS one is decided by its boundaries, below —
 *  the regex only finds the candidates.
 *
 *  The name class stops at whitespace and at punctuation, so `@Rocky,` names
 *  Rocky and leaves the comma in the message. A pane whose name contains a
 *  space (`Rocky 2`, which is what the pool falls back to once it is exhausted,
 *  and what a rename can produce) cannot be addressed by token — the rail's
 *  selection is how those are reached. */
const MENTION = /@([A-Za-z0-9_-]+)/g;

/** What an `@` may not sit against on its left.
 *
 *  This used to be a lookbehind for the start of the string or whitespace, and
 *  it was too strict by half: `(@Rocky) restart`, `—@Rocky`, `path/@Rocky` and
 *  the second half of `@rocky@roxie` all failed it, and a mention that fails to
 *  parse is not reported anywhere — the name vanishes into the message and the
 *  dispatch quietly goes to whoever happened to be focused. That is the worst
 *  outcome available: the user addressed somebody by name and watched it go
 *  somewhere else without a word.
 *
 *  A WORD character is still a hard no, because that is the case the strictness
 *  was for: `dev@example.com` must stay an email address rather than becoming
 *  a mention of "outlook". Punctuation is not a word character, so brackets,
 *  dashes and slashes let a name through. */
const WORD_CHAR = /[A-Za-z0-9_]/;

/** What may follow `@all` / `@everyone` and still mean everybody.
 *
 *  Sentence punctuation may. Anything that keeps the token going may not, and
 *  that is the whole rule: the name class stops at a dot, so `@all.com` matched
 *  the alias and `@everyone.` did too, and once 4D wires the fan-out up a
 *  message with a domain in it would have been pasted into every pane in the
 *  workspace. A broadcast is the one target list nobody can take back.
 *
 *  An alias that does not consume its whole token is left in the message
 *  exactly as typed, the way an email address is: `@all.com` is an address, not
 *  an addressee, and mangling it into ".com" plus a warning about a pane called
 *  "all" would break a legitimate message to explain a mention nobody meant. */
const ALIAS_TAIL = /[\s,;!?)\]}]/;

export function parseRocCommand(input: string): ParsedRocCommand {
  const explicitNames: string[] = [];
  const seen = new Set<string>();
  let broadcast = false;

  // Built by hand rather than with `replace`, because whether a hit counts
  // depends on where the PREVIOUS one ended: in `@rocky@roxie` the second `@`
  // sits against a word character, and the only thing that makes it a mention
  // rather than half an email address is that the word character it touches is
  // a mention this same pass just took.
  let kept = "";
  let cursor = 0;
  let previousEnd = -1;
  MENTION.lastIndex = 0;
  for (let hit = MENTION.exec(input); hit !== null; hit = MENTION.exec(input)) {
    const start = hit.index;
    const end = start + hit[0].length;
    const before = start > 0 ? input[start - 1]! : "";
    if (before !== "" && WORD_CHAR.test(before) && start !== previousEnd) {
      continue;
    }

    const name = hit[1]!;
    const lower = name.toLowerCase();
    if (BROADCAST_ALIASES.has(lower)) {
      // Only if it is the whole token — see `ALIAS_TAIL`.
      const after = end < input.length ? input[end]! : "";
      if (after !== "" && !ALIAS_TAIL.test(after)) continue;
      broadcast = true;
    } else if (!seen.has(lower)) {
      seen.add(lower);
      explicitNames.push(name);
    }

    kept += input.slice(cursor, start);
    cursor = end;
    previousEnd = end;
  }
  kept += input.slice(cursor);

  const text = kept
    // The tokens leave holes; close them up so the message reads the way it was
    // typed rather than with the gaps where the addressing used to be.
    .replace(/[^\S\n]{2,}/g, " ")
    .trim();

  // "everybody, and also Rocky" is still everybody, and a fan-out that visited
  // one pane twice would paste the message twice.
  return broadcast
    ? { text, explicitNames: [], broadcast: true }
    : { text, explicitNames, broadcast: false };
}

/** Every session in a workspace, in the dock's own order.
 *
 *  Same rule as `useActiveWorkspaceTerminals` and `rocplanDispatch`: pane-tree
 *  leaves first, then anything the tree has not heard of yet, by age. "The
 *  first pane" has to mean the one at the top left. */
function panesIn(workspaceId: string): TerminalSession[] {
  const workspace = useWorkspacesStore
    .getState()
    .workspaces.find((w) => w.id === workspaceId);
  const mine = Object.values(useTerminalsStore.getState().byId).filter(
    (t) => t.workspaceId === workspaceId,
  );
  const order = new Map(
    (workspace?.paneTree ? leafIds(workspace.paneTree) : []).map((id, i) => [
      id,
      i,
    ]),
  );
  const rank = (t: TerminalSession) =>
    order.get(t.id) ?? Number.MAX_SAFE_INTEGER;
  mine.sort((a, b) => rank(a) - rank(b) || a.createdAt - b.createdAt);
  return mine;
}

/** Every session Roc can address, active workspace first, dock order within.
 *
 *  Exported (as `addressablePanes`) because Roc's brain has to describe exactly
 *  this list to the model: a roster built from a second walk of the stores
 *  would agree today and drift later, and the drift would show up as an agent
 *  the model was offered and `resolveTargets` cannot find. */
function allPanes(): TerminalSession[] {
  const { workspaces, activeWorkspaceId } = useWorkspacesStore.getState();
  const ids = workspaces.map((w) => w.id);
  ids.sort((a, b) =>
    a === activeWorkspaceId ? -1 : b === activeWorkspaceId ? 1 : 0,
  );
  return ids.flatMap(panesIn);
}

export { allPanes as addressablePanes };

const toTarget = (session: TerminalSession): RocTarget => ({
  terminalId: session.id,
  name: session.name,
  workspaceId: session.workspaceId,
});

/** Same pane twice is one pane. Order of first appearance wins. */
function dedupe(targets: RocTarget[]): RocTarget[] {
  const seen = new Set<string>();
  return targets.filter((t) =>
    seen.has(t.terminalId) ? false : (seen.add(t.terminalId), true),
  );
}

/** Turn a parsed command into the panes it is for.
 *
 *  Precedence, most explicit first:
 *    1. `@all` — every pane in the ACTIVE workspace. Not the world: "@all" said
 *       while looking at one project should not reach into another the user
 *       forgot was open. That is the one place `activeWorkspaceOnly` does not
 *       get a say, because broadcast already means "here".
 *    2. names typed in the message;
 *    3. the rail's selection;
 *    4. whoever is focused — the RAIL's focus first, then the dock's. Inside
 *       Roc, the pane this view is pointed at is the one the user means; the
 *       dock's focus is the answer when they have not pointed it anywhere.
 *
 *  `unknown` carries the names that matched nothing, so the caller can say which
 *  ones rather than silently sending to fewer panes than were asked for. */
export function resolveTargets(
  cmd: ParsedRocCommand,
  opts: { selectedIds: string[]; activeWorkspaceOnly: boolean },
): { targets: RocTarget[]; unknown: string[] } {
  const { activeWorkspaceId } = useWorkspacesStore.getState();

  if (cmd.broadcast) {
    const panes = activeWorkspaceId ? panesIn(activeWorkspaceId) : [];
    return { targets: panes.map(toTarget), unknown: [] };
  }

  if (cmd.explicitNames.length > 0) {
    const scope =
      opts.activeWorkspaceOnly && activeWorkspaceId
        ? panesIn(activeWorkspaceId)
        : allPanes();
    const targets: RocTarget[] = [];
    const unknown: string[] = [];
    for (const name of cmd.explicitNames) {
      const wanted = name.toLowerCase();
      const matches = scope.filter((p) => p.name.toLowerCase() === wanted);
      if (matches.length === 0) unknown.push(name);
      else targets.push(...matches.map(toTarget));
    }
    return { targets: dedupe(targets), unknown };
  }

  const byId = useTerminalsStore.getState().byId;

  if (opts.selectedIds.length > 0) {
    const targets = opts.selectedIds
      // A selection outlives the pane it named — closing a session does not
      // reach into the rail's state — so an id with no session is dropped
      // rather than reported: nothing was asked for by name.
      .map((id) => byId[id])
      .filter((s): s is TerminalSession => s !== undefined)
      .map(toTarget);
    return { targets: dedupe(targets), unknown: [] };
  }

  const focusedId =
    useRocStore.getState().focusedRailTerminalId ??
    useUIStore.getState().focusedTerminalId;
  const focused = focusedId ? byId[focusedId] : undefined;
  return { targets: focused ? [toTarget(focused)] : [], unknown: [] };
}

/** A message, parsed and aimed: the text the panes will actually receive, the
 *  panes it resolved to, and the names that matched nothing. */
export interface AimedRocCommand {
  text: string;
  targets: RocTarget[];
  unknown: string[];
}

/** Both halves at once, which is what every surface that sends actually wants.
 *
 *  Kept next to the two halves rather than in a view, because there were two
 *  copies of this three-line sequence — the stage's and the widget's — and they
 *  had already drifted: one of them dropped `unknown` on the floor. */
export function aimRocCommand(
  input: string,
  opts: { selectedIds: string[]; activeWorkspaceOnly: boolean },
): AimedRocCommand {
  const command = parseRocCommand(input);
  const { targets, unknown } = resolveTargets(command, opts);
  return { text: command.text, targets, unknown };
}

/** Find the panes a past dispatch went to, EACH IN ITS OWN WORKSPACE.
 *
 *  Re-resolving is the whole point of a log entry that can be clicked: a
 *  session restarted since is a new id under the same name, and it is exactly
 *  the pane the user means. But a name only means a pane inside a workspace —
 *  the pool hands `Rocky` out per app, so a broadcast made in /frontend,
 *  re-resolved against every workspace, quietly grew a pane in /backend that
 *  was never addressed. A broadcast cannot be taken back, so the scope has to
 *  be the one it was made in.
 *
 *  A pane that is not there any more is REPORTED rather than swapped for a
 *  same-named pane somewhere else: "Rocky is not open any more" is a true
 *  sentence the user can act on, and sending to the other Rocky is not. */
export function reresolveTargets(recorded: readonly RocTarget[]): {
  targets: RocTarget[];
  unknown: string[];
} {
  const scopes = new Map<string, TerminalSession[]>();
  const targets: RocTarget[] = [];
  const unknown: string[] = [];
  for (const want of recorded) {
    let scope = scopes.get(want.workspaceId);
    if (!scope) {
      // A workspace that has been closed has no panes, so everything it held
      // lands in `unknown` — which is the honest answer.
      scope = panesIn(want.workspaceId);
      scopes.set(want.workspaceId, scope);
    }
    const wanted = want.name.toLowerCase();
    const matches = scope.filter((p) => p.name.toLowerCase() === wanted);
    if (matches.length === 0) unknown.push(want.name);
    else targets.push(...matches.map(toTarget));
  }
  return { targets: dedupe(targets), unknown };
}
