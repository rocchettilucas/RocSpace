import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import { newTerminal } from "@/lib/factories";
import { InspectorView } from "@/views/RightPanel/InspectorView";
import { useTerminalRuntimeStore } from "@/stores/terminalRuntime";
import { useTerminalsStore } from "@/stores/terminals";
import { useUIStore } from "@/stores/ui";
import type { AgentType, TerminalSession } from "@/lib/bindings";

const RESTART = /restart agent to apply/i;
const APPLIES_AT_LAUNCH = /applies when the agent starts/i;

/** A pane with a process behind it — the only state in which "the running
 *  agent still has the old config" is a true statement. */
const LIVE: Partial<TerminalSession> = { pid: 4242, status: "running" };

function focusNewTerminal(
  overrides: Partial<TerminalSession> = {},
  agentType: AgentType = "claude-code",
) {
  const t = newTerminal({
    workspaceId: "w1",
    name: "Rocky",
    agentType,
    projectPath: "/tmp/proj",
  });
  useTerminalsStore.getState().addTerminal({ ...t, ...overrides });
  useUIStore.setState({ focusedTerminalId: t.id });
  return t.id;
}

const agentOptions = () =>
  Array.from(
    (screen.getByLabelText("Agent type") as HTMLSelectElement).options,
  ).map((o) => o.textContent);

describe("InspectorView", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue({ pid: 1, claudeSessionId: null });
    useTerminalsStore.setState({ byId: {} });
    useTerminalRuntimeStore.setState({ hasUserInput: {}, configDirty: {} });
    useUIStore.setState({ focusedTerminalId: null });
  });

  it("shows nothing to restart until something is edited", () => {
    focusNewTerminal(LIVE);
    render(<InspectorView />);
    expect(screen.queryByRole("button", { name: RESTART })).toBeNull();
    expect(screen.queryByText(APPLIES_AT_LAUNCH)).toBeNull();
  });

  it("offers the restart affordance after a model edit", () => {
    focusNewTerminal(LIVE);
    render(<InspectorView />);

    fireEvent.change(screen.getByLabelText("Model"), {
      target: { value: "claude-opus-4-5" },
    });

    expect(screen.getByRole("button", { name: RESTART })).toBeVisible();
  });

  it("does not claim a running agent on a pane that never spawned one", () => {
    // A fresh pane is `idle` with a null pid. Telling the user "the running
    // agent still has the old one" invents a process they do not have.
    focusNewTerminal();
    render(<InspectorView />);

    fireEvent.change(screen.getByLabelText("Model"), {
      target: { value: "claude-opus-4-5" },
    });

    expect(screen.queryByRole("button", { name: RESTART })).toBeNull();
    expect(screen.getByText(APPLIES_AT_LAUNCH)).toBeVisible();
  });

  it("does not claim a running agent on a pane whose process has exited", () => {
    // `pid` survives the exit; the status is what says the process is gone.
    focusNewTerminal({ pid: 4242, status: "complete" });
    render(<InspectorView />);

    fireEvent.click(screen.getByRole("switch", { name: "Auto-accept edits" }));

    expect(screen.queryByRole("button", { name: RESTART })).toBeNull();
    expect(screen.getByText(APPLIES_AT_LAUNCH)).toBeVisible();
  });

  it("treats a Claude pane resting between turns as live", () => {
    // The Stop hook parks a hook-driven pane at `idle` after every turn. The
    // CLI is still there holding the old config, so status alone must not be
    // the liveness test.
    focusNewTerminal({ pid: 4242, status: "idle" });
    render(<InspectorView />);

    fireEvent.change(screen.getByLabelText("Model"), {
      target: { value: "claude-opus-4-5" },
    });

    expect(screen.getByRole("button", { name: RESTART })).toBeVisible();
  });

  it("restarts with the edited config, not the one the process started with", async () => {
    const id = focusNewTerminal(LIVE);
    render(<InspectorView />);

    fireEvent.change(screen.getByLabelText("Model"), {
      target: { value: "claude-opus-4-5" },
    });
    fireEvent.change(screen.getByLabelText("Task prompt"), {
      target: { value: "ship it" },
    });
    fireEvent.click(screen.getByRole("button", { name: RESTART }));
    await vi.waitFor(() => expect(invoke).toHaveBeenCalled());

    const [command, args] = invoke.mock.calls[0] as [
      string,
      { terminalId: string; config: { model: string; taskPrompt: string } },
    ];
    expect(command).toBe("terminal_spawn");
    expect(args.terminalId).toBe(id);
    expect(args.config.model).toBe("claude-opus-4-5");
    expect(args.config.taskPrompt).toBe("ship it");
  });

  it("drops the affordance once the restart lands", async () => {
    focusNewTerminal(LIVE);
    render(<InspectorView />);

    fireEvent.change(screen.getByLabelText("Model"), {
      target: { value: "sonnet" },
    });
    fireEvent.click(screen.getByRole("button", { name: RESTART }));

    await vi.waitFor(() =>
      expect(screen.queryByRole("button", { name: RESTART })).toBeNull(),
    );
  });

  it("marks permission edits as needing a restart too", () => {
    focusNewTerminal(LIVE);
    render(<InspectorView />);

    fireEvent.click(screen.getByRole("switch", { name: "Auto-accept edits" }));

    expect(screen.getByRole("button", { name: RESTART })).toBeVisible();
  });

  it("does not ask for a restart after a rename — the name never reaches the CLI", () => {
    focusNewTerminal(LIVE);
    render(<InspectorView />);

    fireEvent.change(screen.getByLabelText("Terminal name"), {
      target: { value: "Roxie" },
    });

    expect(screen.queryByRole("button", { name: RESTART })).toBeNull();
    expect(screen.queryByText(APPLIES_AT_LAUNCH)).toBeNull();
  });

  it("has no command-history section — nothing ever wrote to it", () => {
    focusNewTerminal();
    render(<InspectorView />);
    expect(screen.queryByText(/history/i)).toBeNull();
  });

  /** A switch that looks set and is not.
   *
   *  `permission_args` has one caller — `claude_code_spec`. `codex_spec`,
   *  `opencode_spec`, `custom_spec` and the plain shell build their argv with
   *  no permission flags at all, so every one of these six toggles was a
   *  control the user could set, watch turn green, restart the pane for, and
   *  get nothing from. Read-only mode on a Codex pane is the worst of them: it
   *  reads as a promise that the agent cannot write to the disk. */
  describe("permissions on an agent that takes none", () => {
    it("disables the toggles and says which agent they reach", () => {
      focusNewTerminal({}, "codex");
      render(<InspectorView />);

      for (const toggle of screen.getAllByRole("switch")) {
        expect(toggle).toBeDisabled();
      }
      expect(screen.getByText(/only applies to Claude Code/i)).toBeVisible();
      // And it does not stop at "inert" — the pane is running unrestricted,
      // which is the fact the user is entitled to.
      expect(screen.getByText(/no permission flags/i)).toBeVisible();
    });

    it("does not mark the config dirty for a toggle that cannot apply", () => {
      focusNewTerminal(LIVE, "codex");
      render(<InspectorView />);

      fireEvent.click(screen.getByRole("switch", { name: "Read-only mode" }));

      expect(screen.queryByRole("button", { name: RESTART })).toBeNull();
    });

    it("leaves a Claude pane's switches alone", () => {
      focusNewTerminal({}, "claude-code");
      render(<InspectorView />);

      for (const toggle of screen.getAllByRole("switch")) {
        expect(toggle).toBeEnabled();
      }
      expect(screen.queryByText(/only applies to Claude Code/i)).toBeNull();
    });
  });

  /** "Custom" is Shell wearing a different badge: nothing in any UI writes
   *  `customArgs`, so `custom_spec` returns `None` and the pane opens an
   *  interactive shell. Offering the choice is the defect; the type itself
   *  stays, because a persisted pane may carry it. */
  describe("the Custom agent type", () => {
    it("is not offered as a choice", () => {
      focusNewTerminal({}, "claude-code");
      render(<InspectorView />);

      expect(agentOptions()).toEqual([
        "Claude Code",
        "Codex",
        "OpenCode",
        "Shell",
      ]);
    });

    it("is still named by a pane that already is one", () => {
      focusNewTerminal({}, "custom");
      render(<InspectorView />);

      expect(agentOptions()).toContain("Custom");
      expect(
        (screen.getByLabelText("Agent type") as HTMLSelectElement).value,
      ).toBe("custom");
    });
  });
});
