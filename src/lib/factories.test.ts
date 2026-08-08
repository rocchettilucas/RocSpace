import { beforeEach, describe, expect, it } from "vitest";
import {
  newAgentConfig,
  newTerminal,
  permissionsForMode,
} from "@/lib/factories";
import {
  DEFAULT_AGENT_DEFAULTS,
  useSettingsStore,
  type PermissionMode,
} from "@/stores/settings";

function setDefaults(model: string | null, permissionMode: PermissionMode) {
  useSettingsStore.setState({
    agentDefaults: {
      agentType: "claude-code",
      model,
      permissionMode,
    },
  });
}

describe("newAgentConfig", () => {
  beforeEach(() => {
    useSettingsStore.setState({
      agentDefaults: { ...DEFAULT_AGENT_DEFAULTS },
    });
  });

  it("takes the model from Settings › Agents", () => {
    setDefaults("claude-opus-4-5", "ask");
    expect(newAgentConfig("claude-code").model).toBe("claude-opus-4-5");
  });

  it("leaves the model unset when the user has not chosen one", () => {
    // Used to be the hard-coded string "claude-opus-4-7" — never sent
    // anywhere, and wrong. An unset model means "whatever the CLI defaults to".
    expect(newAgentConfig("claude-code").model).toBeNull();
  });

  it("applies the default permission mode", () => {
    setDefaults(null, "skipAll");
    const config = newAgentConfig("claude-code");
    expect(config.permissions.autoAcceptEdits).toBe(true);
    expect(config.permissions.askBeforeRunningCommands).toBe(false);
  });

  it("keeps the caller's agent type and prompt", () => {
    const config = newAgentConfig("codex", "fix the build");
    expect(config.type).toBe("codex");
    expect(config.taskPrompt).toBe("fix the build");
  });

  it("flows through newTerminal", () => {
    setDefaults("gpt-5", "acceptEdits");
    const t = newTerminal({
      workspaceId: "w1",
      name: "Rocky",
      agentType: "codex",
      projectPath: "/tmp",
    });
    expect(t.agentConfig.model).toBe("gpt-5");
    expect(t.agentConfig.permissions.autoAcceptEdits).toBe(true);
    expect(t.claudeSessionId).toBeNull();
    expect(t.pid).toBeNull();
  });
});

describe("permissionsForMode", () => {
  // These three shapes are the input side of the table in
  // `src-tauri/src/agents/command.rs::permission_args`. If the two drift, a
  // user who picks "Skip all" quietly gets `--permission-mode default`.
  it("ask is the conservative posture", () => {
    const p = permissionsForMode("ask");
    expect(p.autoAcceptEdits).toBe(false);
    expect(p.askBeforeRunningCommands).toBe(true);
    expect(p.readOnlyMode).toBe(false);
  });

  it("acceptEdits auto-accepts edits but still asks about commands", () => {
    const p = permissionsForMode("acceptEdits");
    expect(p.autoAcceptEdits).toBe(true);
    expect(p.allowFileEdits).toBe(true);
    expect(p.askBeforeRunningCommands).toBe(true);
  });

  it("skipAll turns every gate off — the shape Rust reads as skip-permissions", () => {
    expect(permissionsForMode("skipAll")).toEqual({
      autoAcceptEdits: true,
      askBeforeRunningCommands: false,
      readOnlyMode: false,
      allowFileEdits: true,
      allowPackageInstalls: true,
      allowGitCommands: true,
    });
  });

  it("never returns the shared default object", () => {
    const a = permissionsForMode("ask");
    const b = permissionsForMode("ask");
    a.allowFileEdits = false;
    expect(b.allowFileEdits).toBe(true);
  });
});
