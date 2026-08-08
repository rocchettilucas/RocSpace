/** Named sessions: turning the active workspace into something Rust can write
 *  to disk, and turning it back into a live workspace later.
 *
 *  The payload is deliberately NOT a `Workspace` plus `TerminalSession[]`. Both
 *  of those carry identity — ulids, pids, a Claude session uuid, a ring buffer
 *  of output — and identity is exactly what must not come back: restoring a
 *  saved session twice would otherwise produce two workspaces claiming the same
 *  terminal ids, and the terminals store is keyed by id. So a save keeps the
 *  *shape* (names, agent configs, directory, split layout) and a restore mints
 *  fresh ids, remapping the pane tree's leaves onto them in one pass so the
 *  layout the user saved is the layout they get back.
 *
 *  `workspaceName` and `paneCount` sit at the payload's top level because Rust
 *  copies those two into the file's meta for the list rows — see
 *  `src-tauri/src/sessions/mod.rs`. Everything else is opaque to it. */

import { AGENT_TYPES } from "@/lib/agentLabels";
import { resolveAccent } from "@/lib/accentColors";
import { DEFAULT_PERMISSIONS } from "@/lib/bindings";
import { newId, newWorkspace } from "@/lib/factories";
import {
  buildBalancedTree,
  leafIds,
  sanitizePaneTree,
  type PaneNode,
} from "@/lib/paneTree";
import { useTerminalsStore } from "@/stores/terminals";
import { useTerminalRuntimeStore } from "@/stores/terminalRuntime";
import { nextAccent, useWorkspacesStore } from "@/stores/workspaces";
import type {
  AgentConfig,
  AgentType,
  TerminalSession,
  Workspace,
  WorkspaceAccent,
} from "@/lib/bindings";

/** One pane, as saved. The fields that describe what the pane *is* — never
 *  what it was running. */
export interface SavedSessionTerminal {
  /** The id this pane had when it was saved. Kept only so the saved pane tree
   *  can be matched to it; a restore mints a new one. */
  id: string;
  name: string;
  agentConfig: AgentConfig;
  projectPath: string;
  /** The Claude Code conversation this pane was in, if any. Not restored onto
   *  the session (nothing is running, and `ptyBridge` reads a non-null value as
   *  "this pane reports its own status") — it is handed to the resume
   *  affordance instead. */
  claudeSessionId: string | null;
}

/** What `session_save` stores under `data`. */
export interface SavedSessionPayload {
  /** Meta hint for Rust's list rows. Mirrors `workspace.name`. */
  workspaceName: string;
  /** Meta hint for Rust's list rows. Mirrors `terminals.length`. */
  paneCount: number;
  workspace: {
    name: string;
    accent: WorkspaceAccent;
    projectPath: string | null;
    paneTree: PaneNode | null;
  };
  terminals: SavedSessionTerminal[];
}

/** The renderer's copy of `sessions::slugify`.
 *
 *  Two names that slug the same address the same file, so this is what the save
 *  prompt asks "does this overwrite something?" with. It has to agree with Rust
 *  character for character — the alphabet is `[a-z0-9-]`, every other character
 *  is a separator, repeats collapse, the ends are trimmed, and the result is
 *  capped at 64. `""` means "no filename can be made from this name", which is
 *  a refusal on both sides rather than a default. */
export const MAX_SLUG_LENGTH = 64;

export function sessionSlug(name: string): string {
  let out = "";
  let pendingDash = true;
  for (const ch of name) {
    const isAlnum = /[a-zA-Z0-9]/.test(ch);
    if (out.length >= MAX_SLUG_LENGTH) break;
    if (isAlnum) {
      out += ch.toLowerCase();
      pendingDash = false;
    } else if (!pendingDash) {
      out += "-";
      pendingDash = true;
    }
  }
  return out.replace(/-+$/, "");
}

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

/** The workspace's sessions in the order its layout renders them, with any
 *  session the tree has not heard of yet after them. Non-reactive: this runs
 *  once, from a click. */
function sessionsOf(workspace: Workspace): TerminalSession[] {
  const mine = Object.values(useTerminalsStore.getState().byId).filter(
    (t) => t.workspaceId === workspace.id,
  );
  const order = new Map(
    (workspace.paneTree ? leafIds(workspace.paneTree) : []).map((id, i) => [
      id,
      i,
    ]),
  );
  const rank = (t: TerminalSession) =>
    order.get(t.id) ?? Number.MAX_SAFE_INTEGER;
  return mine.sort((a, b) => rank(a) - rank(b) || a.createdAt - b.createdAt);
}

/** Build the payload for `workspaceId`, or null when there is no such
 *  workspace. */
export function serializeWorkspace(
  workspaceId: string | null,
): SavedSessionPayload | null {
  if (!workspaceId) return null;
  const workspace = useWorkspacesStore
    .getState()
    .workspaces.find((w) => w.id === workspaceId);
  if (!workspace) return null;

  const sessions = sessionsOf(workspace);
  return {
    workspaceName: workspace.name,
    paneCount: sessions.length,
    workspace: {
      name: workspace.name,
      accent: workspace.accent,
      projectPath: workspace.projectPath,
      // The tree as it stands, or the balanced shape its sessions imply when
      // it has not been derived yet — a save must not lose the layout just
      // because the workspace was restored a moment ago.
      paneTree:
        workspace.paneTree ?? buildBalancedTree(sessions.map((t) => t.id)),
    },
    terminals: sessions.map((t) => ({
      id: t.id,
      name: t.name,
      agentConfig: t.agentConfig,
      projectPath: t.projectPath,
      claudeSessionId: t.claudeSessionId,
    })),
  };
}

// ---------------------------------------------------------------------------
// Parse (what comes back off disk is untrusted)
// ---------------------------------------------------------------------------

const isAgentType = (value: unknown): value is AgentType =>
  typeof value === "string" && (AGENT_TYPES as string[]).includes(value);

function parseAgentConfig(raw: unknown): AgentConfig | null {
  if (typeof raw !== "object" || raw === null) return null;
  const c = raw as Partial<AgentConfig>;
  if (!isAgentType(c.type)) return null;
  return {
    type: c.type,
    taskPrompt: typeof c.taskPrompt === "string" ? c.taskPrompt : null,
    model: typeof c.model === "string" ? c.model : null,
    // A permission set is six booleans; anything unreadable falls back to the
    // conservative defaults rather than to whatever half survived.
    permissions:
      typeof c.permissions === "object" && c.permissions !== null
        ? { ...DEFAULT_PERMISSIONS, ...c.permissions }
        : { ...DEFAULT_PERMISSIONS },
    customArgs: Array.isArray(c.customArgs)
      ? c.customArgs.filter((a): a is string => typeof a === "string")
      : null,
  };
}

function parseTerminal(raw: unknown): SavedSessionTerminal | null {
  if (typeof raw !== "object" || raw === null) return null;
  const t = raw as Partial<SavedSessionTerminal>;
  if (typeof t.id !== "string" || t.id === "") return null;
  const agentConfig = parseAgentConfig(t.agentConfig);
  if (!agentConfig) return null;
  return {
    id: t.id,
    name: typeof t.name === "string" && t.name ? t.name : "terminal",
    agentConfig,
    projectPath: typeof t.projectPath === "string" ? t.projectPath : "",
    claudeSessionId:
      typeof t.claudeSessionId === "string" ? t.claudeSessionId : null,
  };
}

/** Coerce whatever `session_load` handed back into a payload, or null when it
 *  is not one. Total: no input throws. */
export function parseSavedSession(raw: unknown): SavedSessionPayload | null {
  if (typeof raw !== "object" || raw === null) return null;
  const p = raw as Partial<SavedSessionPayload>;
  const w = (
    typeof p.workspace === "object" && p.workspace !== null ? p.workspace : {}
  ) as Partial<SavedSessionPayload["workspace"]>;

  const terminals = (Array.isArray(p.terminals) ? p.terminals : [])
    .map(parseTerminal)
    .filter((t): t is SavedSessionTerminal => t !== null);

  const name =
    (typeof w.name === "string" ? w.name.trim() : "") ||
    (typeof p.workspaceName === "string" ? p.workspaceName.trim() : "") ||
    "Restored workspace";

  return {
    workspaceName: name,
    paneCount: terminals.length,
    workspace: {
      name,
      accent: resolveAccent(w.accent),
      projectPath: typeof w.projectPath === "string" ? w.projectPath : null,
      paneTree: sanitizePaneTree(w.paneTree),
    },
    terminals,
  };
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

/** Rewrite a tree's leaves through `ids`, dropping leaves the map does not
 *  name and collapsing the splits that leaves behind.
 *
 *  Dropping rather than keeping is the only safe answer: a leaf naming a
 *  terminal that no longer exists renders as an empty pane the user cannot
 *  close, and a saved tree can outlive a session that failed to parse. */
export function remapPaneTree(
  tree: PaneNode | null,
  ids: ReadonlyMap<string, string>,
): PaneNode | null {
  if (!tree) return null;
  if (tree.kind === "leaf") {
    const next = ids.get(tree.terminalId);
    return next ? { kind: "leaf", terminalId: next } : null;
  }
  const first = remapPaneTree(tree.first, ids);
  const second = remapPaneTree(tree.second, ids);
  if (first === null) return second;
  if (second === null) return first;
  return { ...tree, first, second };
}

/** What a restore produced. */
export interface RestoredSession {
  workspaceId: string;
  sessions: TerminalSession[];
  /** New session id → the Claude conversation it can resume into. Restored
   *  panes are not spawned with `--resume` behind the user's back: a saved
   *  session's uuid can be weeks old, and resuming a transcript the CLI has
   *  since dropped kills the pane at launch. The pane offers the choice. */
  resumable: Map<string, string>;
}

/** Turn a payload into a live workspace: fresh ids, the saved names and
 *  configs, the saved layout remapped onto the new ids.
 *
 *  Does NOT spawn. The caller decides which panes start and which wait for the
 *  user to pick resume-or-fresh, because that decision is about the Claude
 *  conversation each one carries. */
export function restoreSavedSession(
  payload: SavedSessionPayload,
): RestoredSession {
  const open = useWorkspacesStore.getState().workspaces;
  const workspace = newWorkspace({
    name: payload.workspace.name,
    projectPath: payload.workspace.projectPath,
    order: open.length,
    // The accent it was saved with — it is how the user recognises the
    // project, and a restore that re-coloured it would look like a different
    // workspace — unless a workspace already on screen is wearing it. Two rows
    // in one colour is worse than one row in the wrong colour: the sidebar's
    // accent is the whole recognition signal, and a duplicate takes it away
    // from both. That case falls back to the rule a fresh workspace uses.
    accent: open.some((w) => w.accent === payload.workspace.accent)
      ? nextAccent(open)
      : payload.workspace.accent,
  });

  const ids = new Map<string, string>();
  const resumable = new Map<string, string>();
  const now = Date.now();
  const sessions: TerminalSession[] = payload.terminals.map((saved) => {
    const id = newId();
    ids.set(saved.id, id);
    if (saved.agentConfig.type === "claude-code" && saved.claudeSessionId) {
      resumable.set(id, saved.claudeSessionId);
    }
    return {
      id,
      workspaceId: workspace.id,
      name: saved.name,
      agentConfig: saved.agentConfig,
      status: "idle",
      projectPath: saved.projectPath,
      commandHistory: [],
      output: [],
      createdAt: now,
      updatedAt: now,
      // Nothing is running yet. The saved uuid lives in `resumable` until the
      // pane is actually started — see `RestoredSession.resumable`.
      pid: null,
      claudeSessionId: null,
    };
  });

  const remapped = remapPaneTree(payload.workspace.paneTree, ids);
  workspace.paneTree = remapped ?? buildBalancedTree(sessions.map((t) => t.id));
  workspace.focusedTerminalId = sessions[0]?.id ?? null;

  useWorkspacesStore.getState().restoreWorkspace(workspace, sessions);
  const runtime = useTerminalRuntimeStore.getState();
  for (const [id, uuid] of resumable) runtime.markResumable(id, uuid);

  return { workspaceId: workspace.id, sessions, resumable };
}
