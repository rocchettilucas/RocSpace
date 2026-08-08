import { beforeEach, describe, expect, it } from "vitest";
import { OUTPUT_RING_BUFFER_CAP, useTerminalsStore } from "@/stores/terminals";
import { useTerminalRuntimeStore } from "@/stores/terminalRuntime";
import { newOutputLine, newTerminal } from "@/lib/factories";

describe("useTerminalsStore", () => {
  beforeEach(() => {
    useTerminalsStore.setState({ byId: {} });
    useTerminalRuntimeStore.setState({ hasUserInput: {}, configDirty: {} });
  });

  const makeT = () =>
    newTerminal({
      workspaceId: "ws_1",
      name: "T1",
      agentType: "claude-code",
      projectPath: "/tmp",
    });

  it("addTerminal makes it findable by id", () => {
    const t = makeT();
    useTerminalsStore.getState().addTerminal(t);
    expect(useTerminalsStore.getState().byId[t.id]?.name).toBe("T1");
  });

  it("setStatus only mutates when status differs", () => {
    const t = makeT();
    useTerminalsStore.getState().addTerminal(t);
    const updated0 = useTerminalsStore.getState().byId[t.id]!.updatedAt;
    useTerminalsStore.getState().setStatus(t.id, "idle"); // same status
    const updated1 = useTerminalsStore.getState().byId[t.id]!.updatedAt;
    expect(updated1).toBe(updated0);
    useTerminalsStore.getState().setStatus(t.id, "running");
    const updated2 = useTerminalsStore.getState().byId[t.id]!.updatedAt;
    expect(updated2).toBeGreaterThanOrEqual(updated0);
    expect(useTerminalsStore.getState().byId[t.id]!.status).toBe("running");
  });

  it("appendOutputLine respects ring buffer cap", () => {
    const t = makeT();
    useTerminalsStore.getState().addTerminal(t);
    const append = useTerminalsStore.getState().appendOutputLine;
    for (let i = 0; i < OUTPUT_RING_BUFFER_CAP + 50; i++) {
      append(t.id, newOutputLine(`line ${i}`));
    }
    const out = useTerminalsStore.getState().byId[t.id]!.output;
    expect(out.length).toBe(OUTPUT_RING_BUFFER_CAP);
    expect(out[0]!.text).toBe("line 50");
    expect(out.at(-1)!.text).toBe(`line ${OUTPUT_RING_BUFFER_CAP + 49}`);
  });

  it("clearOutput empties the buffer but keeps the terminal", () => {
    const t = makeT();
    useTerminalsStore.getState().addTerminal(t);
    useTerminalsStore.getState().appendOutputLine(t.id, newOutputLine("a"));
    useTerminalsStore.getState().clearOutput(t.id);
    expect(useTerminalsStore.getState().byId[t.id]?.output.length).toBe(0);
  });

  it("removeTerminal drops it from byId", () => {
    const t = makeT();
    useTerminalsStore.getState().addTerminal(t);
    useTerminalsStore.getState().removeTerminal(t.id);
    expect(useTerminalsStore.getState().byId[t.id]).toBeUndefined();
  });

  it("removeTerminal takes the pane's ephemeral runtime flags with it", () => {
    // Both maps are keyed by terminal id and nothing else ever removes an
    // entry, so a session spent opening and closing panes would keep a record
    // of every one of them.
    const t = makeT();
    useTerminalsStore.getState().addTerminal(t);
    useTerminalRuntimeStore.getState().notifyUserInput(t.id);
    useTerminalRuntimeStore.getState().markConfigDirty(t.id);

    useTerminalsStore.getState().removeTerminal(t.id);

    const runtime = useTerminalRuntimeStore.getState();
    expect(t.id in runtime.configDirty).toBe(false);
    expect(t.id in runtime.hasUserInput).toBe(false);
  });

  it("removing one terminal leaves another's flags alone", () => {
    const doomed = makeT();
    const keeper = makeT();
    useTerminalsStore.getState().addTerminal(doomed);
    useTerminalsStore.getState().addTerminal(keeper);
    useTerminalRuntimeStore.getState().markConfigDirty(doomed.id);
    useTerminalRuntimeStore.getState().markConfigDirty(keeper.id);

    useTerminalsStore.getState().removeTerminal(doomed.id);

    expect(useTerminalRuntimeStore.getState().configDirty).toEqual({
      [keeper.id]: true,
    });
  });

  it("recordSpawn stores the pid and Claude session id", () => {
    const t = makeT();
    useTerminalsStore.getState().addTerminal(t);
    expect(useTerminalsStore.getState().byId[t.id]!.pid).toBeNull();

    useTerminalsStore.getState().recordSpawn(t.id, {
      pid: 4242,
      claudeSessionId: "1a2b3c",
      conversationLost: false,
    });

    const after = useTerminalsStore.getState().byId[t.id]!;
    expect(after.pid).toBe(4242);
    expect(after.claudeSessionId).toBe("1a2b3c");
  });

  it("recordSpawn clears the previous identity when the new spawn has none", () => {
    // Switching a pane from Claude to a plain shell must not leave the dead
    // Claude session id behind — the hook tailer would keep treating that pane
    // as hook-driven.
    const t = makeT();
    useTerminalsStore.getState().addTerminal(t);
    useTerminalsStore.getState().recordSpawn(t.id, {
      pid: 1,
      claudeSessionId: "old",
      conversationLost: false,
    });
    useTerminalsStore.getState().recordSpawn(t.id, {
      pid: 2,
      claudeSessionId: null,
      conversationLost: false,
    });

    const after = useTerminalsStore.getState().byId[t.id]!;
    expect(after.pid).toBe(2);
    expect(after.claudeSessionId).toBeNull();
  });

  it("recordSpawn is a no-op for an unknown terminal", () => {
    useTerminalsStore.getState().recordSpawn("nope", {
      pid: 1,
      claudeSessionId: null,
      conversationLost: false,
    });
    expect(useTerminalsStore.getState().byId).toEqual({});
  });
});
