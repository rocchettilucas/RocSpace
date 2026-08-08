import { RotateCcw } from "lucide-react";
import { useState } from "react";
import { agentChoices, supportsPermissions } from "@/lib/agentLabels";
import { cn } from "@/lib/utils";
import { spawnTerminalById } from "@/lib/spawn";
import {
  useFocusedTerminalId,
  useTerminalById,
  useTerminalConfigDirty,
  useTerminalRuntimeStore,
  useTerminalsStore,
} from "@/stores";
import type {
  AgentType,
  PermissionSettings,
  TerminalStatus,
} from "@/lib/bindings";

const AGENT_LABELS: Record<AgentType, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  "open-code": "OpenCode",
  shell: "Shell",
  custom: "Custom",
};

const STATUS_LABEL: Record<TerminalStatus, string> = {
  idle: "Idle",
  running: "Running",
  awaiting_approval: "Awaiting approval",
  error: "Error",
  complete: "Complete",
  paused: "Paused",
};

const STATUS_COLORS: Record<TerminalStatus, string> = {
  idle: "bg-status-idle",
  running: "bg-status-running",
  awaiting_approval: "bg-status-waiting",
  error: "bg-status-error",
  complete: "bg-status-complete",
  paused: "bg-status-paused",
};

const PERMISSION_FIELDS: Array<{
  key: keyof PermissionSettings;
  label: string;
}> = [
  { key: "allowFileEdits", label: "Allow file edits" },
  { key: "askBeforeRunningCommands", label: "Ask before running commands" },
  { key: "autoAcceptEdits", label: "Auto-accept edits" },
  { key: "allowGitCommands", label: "Allow git commands" },
  { key: "allowPackageInstalls", label: "Allow package installs" },
  { key: "readOnlyMode", label: "Read-only mode" },
];

/** Right-dock mode = "inspector". Shows the focused terminal's agent config,
 *  permissions and task prompt.
 *
 *  Everything here is baked into the CLI's argv at spawn time, so editing a
 *  field changes nothing about the process that is already running. Rather
 *  than let the panel imply otherwise, each edit marks the session dirty and
 *  surfaces a restart button — the one action that actually applies it. */
export function InspectorView() {
  const focusedId = useFocusedTerminalId();
  const terminal = useTerminalById(focusedId);

  const renameTerminal = useTerminalsStore((s) => s.renameTerminal);
  const setAgentConfig = useTerminalsStore((s) => s.setAgentConfig);
  const setPermissions = useTerminalsStore((s) => s.setPermissions);
  const setTaskPrompt = useTerminalsStore((s) => s.setTaskPrompt);
  const markConfigDirty = useTerminalRuntimeStore((s) => s.markConfigDirty);
  const isDirty = useTerminalConfigDirty(terminal?.id ?? "");

  if (!terminal) {
    return (
      <div className="grid flex-1 place-items-center px-4">
        <p className="text-center text-xs italic text-fg-muted">
          Select a terminal in the sidebar or grid to inspect its agent config,
          model, and permissions.
        </p>
      </div>
    );
  }

  const id = terminal.id;
  /** Config edits only take effect on the next launch — say so. Renames are
   *  excluded on purpose: a name never reaches the CLI. */
  const dirty = () => markConfigDirty(id);
  /** Is there actually a process holding the config that was just edited?
   *
   *  `pid` is written on every spawn and cleared for hydrated sessions at
   *  startup, so it answers "has this pane started something this run";
   *  `complete` / `error` say that something is over. The status alone cannot
   *  answer it in either direction — a never-spawned pane and a Claude pane
   *  resting between turns are both `idle`, and only one of them is running. */
  const agentIsLive =
    terminal.pid !== null &&
    terminal.status !== "complete" &&
    terminal.status !== "error";
  /** Do this pane's permission settings reach the process it launches? See
   *  `supportsPermissions` — today only Claude Code's argv carries them. */
  const permissionsApply = supportsPermissions(terminal.agentConfig.type);

  return (
    <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
      {/* Header row */}
      <div className="flex flex-col gap-2">
        <input
          aria-label="Terminal name"
          value={terminal.name}
          onChange={(e) => renameTerminal(id, e.target.value)}
          className="rounded bg-surface-2 px-2 py-1.5 text-sm font-semibold text-fg-primary outline-none focus:ring-1 focus:ring-accent"
        />
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "h-2 w-2 rounded-full",
              STATUS_COLORS[terminal.status],
            )}
          />
          <span className="text-xs text-fg-secondary">
            {STATUS_LABEL[terminal.status]}
          </span>
          <span className="ml-auto text-[10px] uppercase tracking-wider text-fg-muted">
            {AGENT_LABELS[terminal.agentConfig.type]}
          </span>
        </div>
      </div>

      {isDirty ? (
        <ConfigDirtyNote terminalId={id} agentIsLive={agentIsLive} />
      ) : null}

      {/* Agent type */}
      <Section title="Agent">
        <select
          aria-label="Agent type"
          value={terminal.agentConfig.type}
          onChange={(e) => {
            setAgentConfig(id, {
              ...terminal.agentConfig,
              type: e.target.value as AgentType,
            });
            dirty();
          }}
          className="w-full appearance-none rounded bg-surface-2 px-2 py-1.5 text-xs text-fg-primary outline-none hover:bg-surface-3 focus:ring-1 focus:ring-accent"
        >
          {/* Everything a pane may be CHANGED to, plus whatever it already is
              — see `agentChoices`. A pane restored as `custom` still names
              itself here; nothing can newly become one. */}
          {agentChoices(terminal.agentConfig.type).map((v) => (
            <option key={v} value={v} className="bg-surface-1">
              {AGENT_LABELS[v]}
            </option>
          ))}
        </select>
      </Section>

      {/* Model */}
      <Section title="Model">
        <ModelField
          key={id}
          value={terminal.agentConfig.model}
          onCommit={(model) => {
            setAgentConfig(id, { ...terminal.agentConfig, model });
            dirty();
          }}
        />
      </Section>

      {/* Task prompt */}
      <Section title="Task">
        <textarea
          aria-label="Task prompt"
          value={terminal.agentConfig.taskPrompt ?? ""}
          onChange={(e) => {
            setTaskPrompt(id, e.target.value || null);
            dirty();
          }}
          rows={3}
          placeholder="Describe what this agent should do..."
          className="w-full resize-none rounded bg-surface-2 px-2 py-1.5 text-xs text-fg-primary outline-none placeholder:text-fg-muted focus:ring-1 focus:ring-accent"
        />
      </Section>

      {/* Permissions.

          Live for Claude Code and inert for everything else, because that is
          what the argv builder does — `permission_args` is called from
          `claude_code_spec` alone. Shown disabled rather than hidden: hiding
          them would leave a Codex pane looking like a pane with no permission
          question, when the truth is the opposite one. It runs unrestricted,
          and the note under the switches says so. */}
      <Section title="Permissions">
        <div className="flex flex-col gap-1">
          {PERMISSION_FIELDS.map((p) => {
            const enabled = terminal.agentConfig.permissions[p.key];
            return (
              <button
                key={p.key}
                type="button"
                role="switch"
                aria-checked={enabled}
                disabled={!permissionsApply}
                onClick={() => {
                  setPermissions(id, {
                    ...terminal.agentConfig.permissions,
                    [p.key]: !enabled,
                  });
                  dirty();
                }}
                className={cn(
                  "flex items-center justify-between rounded px-2 py-1.5 text-xs",
                  permissionsApply
                    ? "hover:bg-surface-2"
                    : "cursor-not-allowed opacity-45",
                )}
              >
                <span className="text-fg-secondary">{p.label}</span>
                <ToggleDot enabled={enabled} />
              </button>
            );
          })}
        </div>
        {permissionsApply ? null : (
          <p className="mt-1.5 rounded border border-border bg-surface-2 px-2 py-1.5 text-[10px] leading-relaxed text-fg-muted">
            Only applies to Claude Code. RocSpace launches a{" "}
            {AGENT_LABELS[terminal.agentConfig.type]} pane with no permission
            flags, so nothing here restrains it — it can do whatever it could do
            if you had started it yourself in a terminal.
          </p>
        )}
      </Section>

      <p className="mt-auto text-[10px] italic text-fg-muted">
        Project path: <span className="font-mono">{terminal.projectPath}</span>
      </p>
    </div>
  );
}

/** Inline "your edits aren't live yet" note.
 *
 *  Two different true statements, depending on whether a process exists. With
 *  one running, the edit is stranded and restarting is the action that applies
 *  it — restart is the same path the card's restart button uses, and it carries
 *  the session's current config down to the CLI. With nothing running there is
 *  no stale agent to warn about and nothing to restart; the edit is simply
 *  waiting for the next launch, which is all this should say. Claiming "the
 *  running agent still has the old one" over a pane that has never been
 *  spawned invents a process the user does not have. */
function ConfigDirtyNote({
  terminalId,
  agentIsLive,
}: {
  terminalId: string;
  agentIsLive: boolean;
}) {
  if (!agentIsLive) {
    return (
      <div className="rounded border border-border bg-surface-2 px-2 py-1.5">
        <p className="text-[11px] leading-tight text-fg-muted">
          Config changed. Applies when the agent starts.
        </p>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 rounded border border-status-waiting/40 bg-status-waiting/10 px-2 py-1.5">
      <p className="min-w-0 flex-1 text-[11px] leading-tight text-fg-secondary">
        Config changed. The running agent still has the old one.
      </p>
      <button
        type="button"
        onClick={() => void spawnTerminalById(terminalId)}
        className="flex shrink-0 items-center gap-1 rounded bg-surface-3 px-2 py-1 text-[11px] font-medium text-fg-primary hover:bg-surface-2"
      >
        <RotateCcw className="h-3 w-3" />
        Restart agent to apply
      </button>
    </div>
  );
}

/** Free-text model field. Kept as local draft state so typing isn't fought by
 *  the null-normalization the store applies (same reason `AgentsSection` keeps
 *  a draft); `key={id}` in the parent resets it when the pane changes. */
function ModelField({
  value,
  onCommit,
}: {
  value: string | null;
  onCommit: (model: string | null) => void;
}) {
  const [draft, setDraft] = useState(value ?? "");

  return (
    <input
      type="text"
      spellCheck={false}
      aria-label="Model"
      value={draft}
      placeholder="CLI default"
      onChange={(e) => {
        setDraft(e.target.value);
        const trimmed = e.target.value.trim();
        onCommit(trimmed === "" ? null : trimmed);
      }}
      className="w-full rounded bg-surface-2 px-2 py-1.5 font-mono text-xs text-fg-primary outline-none placeholder:text-fg-muted focus:ring-1 focus:ring-accent"
    />
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-fg-muted">
        {title}
      </span>
      {children}
    </div>
  );
}

function ToggleDot({ enabled }: { enabled: boolean }) {
  return (
    <span
      className={cn(
        "relative inline-block h-4 w-7 shrink-0 rounded-full transition-colors",
        enabled ? "bg-accent" : "bg-surface-3",
      )}
    >
      <span
        className={cn(
          "absolute top-1/2 left-0.5 h-3 w-3 -translate-y-1/2 rounded-full bg-white transition-transform",
          enabled ? "translate-x-3" : "translate-x-0",
        )}
      />
    </span>
  );
}
