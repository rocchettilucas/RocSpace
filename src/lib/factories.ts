/** Factories for constructing fresh workspace entities with sensible defaults
 * and stable ULIDs. Used by the workspaces store and the terminal stores. */

import { ulid } from "ulid";
import {
  DEFAULT_PERMISSIONS,
  type AgentConfig,
  type AgentType,
  type OutputStream,
  type PermissionSettings,
  type TerminalOutputLine,
  type TerminalSession,
  type Workspace,
  type WorkspaceAccent,
} from "@/lib/bindings";
import { accentForOrder } from "@/lib/accentColors";
import { useSettingsStore, type PermissionMode } from "@/stores/settings";

export const newId = () => ulid();

/** Last segment of a path, in either separator. What a workspace is named
 *  after when the user does not name it. */
export function directoryTail(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** Settings' three-way permission posture → the six per-terminal toggles.
 *
 *  Inverse of the table in `src-tauri/src/agents/command.rs`: what is set here
 *  is what `launch_spec` reads back out, so "Skip all" in Settings really does
 *  produce `--dangerously-skip-permissions` on the command line. Changing one
 *  side without the other silently downgrades the user's choice. */
export const permissionsForMode = (
  mode: PermissionMode,
): PermissionSettings => {
  switch (mode) {
    case "skipAll":
      return {
        autoAcceptEdits: true,
        askBeforeRunningCommands: false,
        readOnlyMode: false,
        allowFileEdits: true,
        allowPackageInstalls: true,
        allowGitCommands: true,
      };
    case "acceptEdits":
      return {
        ...DEFAULT_PERMISSIONS,
        autoAcceptEdits: true,
        allowFileEdits: true,
      };
    case "ask":
      return { ...DEFAULT_PERMISSIONS };
  }
};

/** Build an agent config from the user's saved defaults.
 *
 *  `type` is explicit because callers pick it per terminal (the new-workspace
 *  modal, a split); model and permissions come from Settings › Agents. */
export const newAgentConfig = (
  type: AgentType,
  taskPrompt: string | null = null,
): AgentConfig => {
  const defaults = useSettingsStore.getState().agentDefaults;
  return {
    type,
    taskPrompt,
    // Settings presents one model field for whatever CLI runs ("Passed to the
    // agent CLI"), so it is not filtered by agent type. `launch_spec` ignores
    // it for the CLIs that take no --model.
    model: defaults.model,
    permissions: permissionsForMode(defaults.permissionMode),
    customArgs: null,
  };
};

export interface NewTerminalParams {
  workspaceId: string;
  name: string;
  agentType: AgentType;
  projectPath: string;
  taskPrompt?: string | null;
}

export const newTerminal = (params: NewTerminalParams): TerminalSession => ({
  id: newId(),
  workspaceId: params.workspaceId,
  name: params.name,
  agentConfig: newAgentConfig(params.agentType, params.taskPrompt ?? null),
  status: "idle",
  projectPath: params.projectPath,
  commandHistory: [],
  output: [],
  createdAt: Date.now(),
  updatedAt: Date.now(),
  pid: null,
  claudeSessionId: null,
});

export interface NewWorkspaceParams {
  /** Blank / omitted falls back to the `projectPath` tail, then to
   *  `"Workspace {order + 1}"`. */
  name?: string | null;
  projectPath: string | null;
  /** Position in the sidebar at creation time — decides the accent. */
  order: number;
  accent?: WorkspaceAccent;
}

export const newWorkspace = (params: NewWorkspaceParams): Workspace => {
  const named = params.name?.trim();
  const fromPath = params.projectPath
    ? directoryTail(params.projectPath).trim()
    : "";
  return {
    id: newId(),
    name: named || fromPath || `Workspace ${params.order + 1}`,
    accent: params.accent ?? accentForOrder(params.order),
    projectPath: params.projectPath,
    // Derived, not authored: the store builds a balanced tree once the
    // workspace's sessions exist. A workspace is created before any of them do.
    paneTree: null,
    focusedTerminalId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
};

export const newOutputLine = (
  text: string,
  stream: OutputStream = "stdout",
): TerminalOutputLine => ({
  id: newId(),
  ts: Date.now(),
  stream,
  text,
});
