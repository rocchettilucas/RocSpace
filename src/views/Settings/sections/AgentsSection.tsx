import { useId, useRef, useState } from "react";
import {
  AGENT_NAME,
  agentChoices,
  supportsPermissions,
} from "@/lib/agentLabels";
import type { AgentType } from "@/lib/bindings";
import { cn } from "@/lib/utils";
import {
  PERMISSION_MODES,
  useAgentDefaults,
  useSettingsStore,
  type PermissionMode,
} from "@/stores";
import {
  SettingsNote,
  SettingsRow,
  SettingsSection,
} from "@/views/Settings/rows";

const PERMISSION_COPY: Record<PermissionMode, { label: string; hint: string }> =
  {
    ask: {
      label: "Ask",
      hint: "The agent stops for confirmation before edits and commands.",
    },
    acceptEdits: {
      label: "Auto-accept edits",
      hint: "File edits go through; commands still ask.",
    },
    skipAll: {
      label: "Skip all",
      hint: "No prompts at all — edits and commands run unattended.",
    },
  };

export function AgentsSection() {
  const { agentType, model, permissionMode } = useAgentDefaults();
  const setAgentDefault = useSettingsStore((s) => s.setAgentDefault);
  const agentTypeId = useId();
  const modelId = useId();
  const permissionGroupRef = useRef<HTMLDivElement | null>(null);

  // The store trims and null-normalizes the model, so binding the input
  // straight to it would eat spaces as they are typed. Keep the raw text here
  // and let the store hold the clean value.
  const [modelDraft, setModelDraft] = useState(model ?? "");

  /** Radiogroup keyboard model — deliberately the same one the theme picker in
   *  `AppearanceSection` uses: arrows move *and* select (APG's model for a
   *  radio group), and roving tabindex keeps the whole group to a single tab
   *  stop instead of one per option. Radios are read out of the DOM rather
   *  than off `PERMISSION_MODES` so this order can never drift from the
   *  rendered one. */
  const onPermissionKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const delta =
      e.key === "ArrowRight" || e.key === "ArrowDown"
        ? 1
        : e.key === "ArrowLeft" || e.key === "ArrowUp"
          ? -1
          : 0;
    if (delta === 0) return;
    const radios = Array.from(
      permissionGroupRef.current?.querySelectorAll<HTMLElement>(
        "[data-permission-mode]",
      ) ?? [],
    );
    if (radios.length === 0) return;
    e.preventDefault();
    const current = radios.findIndex(
      (r) => r.dataset.permissionMode === permissionMode,
    );
    const next = radios[(current + delta + radios.length) % radios.length]!;
    const nextMode = PERMISSION_MODES.find(
      (m) => m === next.dataset.permissionMode,
    );
    if (nextMode) setAgentDefault("permissionMode", nextMode);
    next.focus();
  };

  return (
    <SettingsSection
      title="Agents"
      description="What a new terminal starts as when you don't pick something else."
    >
      <SettingsRow
        label="Default agent"
        description="Pre-selected in the launch wizard and the sidebar's + menu."
        htmlFor={agentTypeId}
      >
        <select
          id={agentTypeId}
          value={agentType}
          onChange={(e) =>
            setAgentDefault("agentType", e.target.value as AgentType)
          }
          className="rounded-input border border-border bg-surface-2 px-2 py-1 text-xs text-fg-primary hover:border-border-hover focus:border-border-active focus:outline-none"
        >
          {/* The offerable types, plus the stored one if it is no longer
              offerable — see `agentChoices`. Withdrawing "Custom" must not
              silently rewrite the default of somebody who had picked it. */}
          {agentChoices(agentType).map((type) => (
            <option key={type} value={type}>
              {AGENT_NAME[type]}
            </option>
          ))}
        </select>
      </SettingsRow>

      <SettingsRow
        label="Default model"
        description="Passed to the agent CLI. Leave empty to use whatever the CLI defaults to."
        htmlFor={modelId}
      >
        <input
          id={modelId}
          type="text"
          spellCheck={false}
          value={modelDraft}
          placeholder="CLI default"
          onChange={(e) => {
            setModelDraft(e.target.value);
            setAgentDefault("model", e.target.value);
          }}
          className="w-52 rounded-input border border-border bg-surface-2 px-2 py-1 font-mono text-xs text-fg-primary placeholder:text-fg-muted hover:border-border-hover focus:border-border-active focus:outline-none"
        />
      </SettingsRow>

      <SettingsRow
        label="Permission mode"
        description="How much a fresh agent may do without stopping to ask."
        stacked
      >
        <div
          ref={permissionGroupRef}
          role="radiogroup"
          aria-label="Permission mode"
          onKeyDown={onPermissionKeyDown}
          className="flex flex-col gap-1.5"
        >
          {PERMISSION_MODES.map((mode) => {
            const { label, hint } = PERMISSION_COPY[mode];
            const isActive = mode === permissionMode;
            return (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={isActive}
                // Roving tabindex: the group is one tab stop, arrows move
                // within it.
                tabIndex={isActive ? 0 : -1}
                data-permission-mode={mode}
                onClick={() => setAgentDefault("permissionMode", mode)}
                className={cn(
                  "flex w-full items-start gap-2.5 rounded-input border p-2.5 text-left transition-colors",
                  isActive
                    ? "border-accent bg-accent-soft"
                    : "border-border bg-surface-1 hover:border-border-hover hover:bg-surface-2",
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border",
                    isActive ? "border-accent" : "border-border-hover",
                  )}
                >
                  {isActive ? (
                    <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                  ) : null}
                </span>
                <span className="min-w-0">
                  <span className="block text-xs font-medium text-fg-primary">
                    {label}
                  </span>
                  <span className="mt-0.5 block text-[11px] leading-relaxed text-fg-muted">
                    {hint}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </SettingsRow>

      {permissionMode === "skipAll" ? (
        <SettingsNote tone="warning">
          Skip all lets a Claude Code agent edit files and run shell commands
          with no confirmation. Use it only in a directory you are willing to
          lose.
        </SettingsNote>
      ) : null}

      {/* The scope of the control above, which is narrower than it looks.
          `permission_args` is called from `claude_code_spec` and nowhere else,
          so the mode is a Claude Code setting wearing a general name — and the
          half worth saying out loud is the other one: the panes it does not
          reach are not therefore restrained. */}
      <SettingsNote tone={supportsPermissions(agentType) ? "muted" : "warning"}>
        Permission modes reach only Claude Code — it is the one CLI RocSpace
        hands permission flags to. Codex, OpenCode and shell panes launch with
        no permission flags at all, whichever mode is picked, so nothing here
        restrains them: they can do whatever they could do if you had started
        them yourself in a terminal.
        {supportsPermissions(agentType)
          ? null
          : ` Your default agent is ${AGENT_NAME[agentType]}, so a pane made from it starts that way.`}
      </SettingsNote>

      <SettingsNote>
        Applies to newly created terminals (full wiring lands in Phase 1).
        Existing terminals keep the settings they were spawned with.
      </SettingsNote>
    </SettingsSection>
  );
}
