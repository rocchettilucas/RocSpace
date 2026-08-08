import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import { newTerminal, newWorkspace } from "@/lib/factories";
import {
  MAX_CONCURRENT_SPAWNS,
  spawnQueueDepth,
  spawnTerminal,
  spawnTerminalById,
} from "@/lib/spawn";
import { useHistoryStore } from "@/stores/history";
import { useTerminalsStore } from "@/stores/terminals";
import { useTerminalRuntimeStore } from "@/stores/terminalRuntime";
import { resetToastsState, useToastsStore } from "@/stores/toasts";
import { useWorkspacesStore } from "@/stores/workspaces";
import {
  clearTerminalRegistry,
  registerTerminal,
} from "@/lib/terminalRegistry";

/** Just enough of an xterm for the registry: the two numbers a PTY needs. */
function fakeXterm(cols: number, rows: number) {
  return { cols, rows } as unknown as Parameters<typeof registerTerminal>[1];
}

function makeTerminal(name = "Rocky") {
  const t = newTerminal({
    workspaceId: "w1",
    name,
    agentType: "claude-code",
    projectPath: "/tmp/proj",
    taskPrompt: "ship it",
  });
  useTerminalsStore.getState().addTerminal(t);
  return t;
}

/** Let every settled promise run its continuations. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("spawnTerminal", () => {
  beforeEach(() => {
    invoke.mockReset();
    clearTerminalRegistry();
    useTerminalsStore.setState({ byId: {} });
    useHistoryStore.setState({ failures: [] });
    useTerminalRuntimeStore.setState({
      hasUserInput: {},
      configDirty: {},
      resumableClaudeSessions: {},
    });
  });

  it("sends the whole agent config, not just the type", async () => {
    // The entire point of Phase 1: model / permissions / prompt have to cross
    // the IPC boundary or they can never reach the CLI.
    invoke.mockResolvedValue({ pid: 7, claudeSessionId: "uuid-1" });
    const t = makeTerminal();

    await spawnTerminal(t);

    expect(invoke).toHaveBeenCalledWith("terminal_spawn", {
      terminalId: t.id,
      config: t.agentConfig,
      cwd: "/tmp/proj",
      resumeClaudeSession: null,
      // No pane is registered in this test, so Rust keeps its own default.
      cols: null,
      rows: null,
    });
    const sent = invoke.mock.calls[0]![1] as { config: { taskPrompt: string } };
    expect(sent.config.taskPrompt).toBe("ship it");
  });

  it("records the pid and Claude session id on the session", async () => {
    invoke.mockResolvedValue({ pid: 7, claudeSessionId: "uuid-1" });
    const t = makeTerminal();

    await expect(spawnTerminal(t)).resolves.toBe(true);

    const after = useTerminalsStore.getState().byId[t.id]!;
    expect(after.pid).toBe(7);
    expect(after.claudeSessionId).toBe("uuid-1");
  });

  it("passes a null cwd when the session has no project path", async () => {
    invoke.mockResolvedValue({ pid: null, claudeSessionId: null });
    const t = makeTerminal();
    useTerminalsStore.setState((s) => ({
      byId: { ...s.byId, [t.id]: { ...t, projectPath: "" } },
    }));

    await spawnTerminal(useTerminalsStore.getState().byId[t.id]!);

    expect(invoke.mock.calls[0]![1]).toMatchObject({ cwd: null });
  });

  it("resolves false instead of throwing when the spawn fails", async () => {
    // Callers are fire-and-forget loops over every session; one missing binary
    // must not abort "launch all" for the rest.
    invoke.mockRejectedValue(new Error("no such file"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = makeTerminal();

    await expect(spawnTerminal(t)).resolves.toBe(false);
    expect(useTerminalsStore.getState().byId[t.id]!.pid).toBeNull();
    warn.mockRestore();
  });

  it("files the failure where the user can read it", async () => {
    // Swallowing the error is right — one dead binary must not abort the loop
    // — but swallowed used to mean gone, and a pane that never came up looked
    // like one that had simply not been clicked.
    invoke.mockRejectedValue(new Error("claude: command not found"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    useWorkspacesStore.setState({
      workspaces: [
        newWorkspace({ name: "rocspace", projectPath: null, order: 0 }),
      ],
      activeWorkspaceId: null,
    });
    const t = makeTerminal("Roxie");
    useTerminalsStore.setState((s) => ({
      byId: {
        ...s.byId,
        [t.id]: {
          ...t,
          workspaceId: useWorkspacesStore.getState().workspaces[0]!.id,
        },
      },
    }));

    await spawnTerminal(useTerminalsStore.getState().byId[t.id]!, {
      resumeClaudeSession: "conv-1",
    });

    expect(useHistoryStore.getState().failures[0]).toMatchObject({
      name: "Roxie",
      workspaceName: "rocspace",
      kind: "resume",
      error: "claude: command not found",
    });
    warn.mockRestore();
  });

  it("spawnTerminalById is a no-op for an unknown id", async () => {
    await expect(spawnTerminalById("nope")).resolves.toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("spawnTerminalById reads the CURRENT config, not a stale copy", async () => {
    // The restart-to-apply flow in the Inspector depends on this: the edit
    // lands in the store, then a restart re-reads it.
    invoke.mockResolvedValue({ pid: 1, claudeSessionId: null });
    const t = makeTerminal();
    useTerminalsStore.getState().setTaskPrompt(t.id, "changed my mind");

    await spawnTerminalById(t.id);

    const sent = invoke.mock.calls[0]![1] as {
      config: { taskPrompt: string | null };
    };
    expect(sent.config.taskPrompt).toBe("changed my mind");
  });

  it("reaches the IPC boundary synchronously while the queue is free", async () => {
    // A click handler that spawns a pane has spawned it by the time it
    // returns. The queue must not turn that into a promise the caller has to
    // know about — see `takeSlot`.
    invoke.mockResolvedValue({ pid: 1, claudeSessionId: null });
    const t = makeTerminal();

    const pending = spawnTerminal(t);

    expect(invoke).toHaveBeenCalledOnce();
    await pending;
  });
  // The bug this pins: a restored pane mounts and fits BEFORE its PTY exists,
  // so the resize it fires is dropped ("PTY may not be spawned yet") and the
  // PTY is then born at 80x24. Claude Code reads 80 columns once at startup
  // and draws its interface for them, inside a pane that is narrower — which
  // is the wrapped, doubled render you see until a maximize toggle forces a
  // refit that finally lands on a PTY that exists.
  it("opens the PTY at the size the pane is already showing", async () => {
    const t = makeTerminal();
    registerTerminal(t.id, fakeXterm(55, 30));
    invoke.mockResolvedValue({ pid: 1, claudeSessionId: null });

    await spawnTerminal(t);

    const [, args] = invoke.mock.calls[0]!;
    expect(args).toMatchObject({ cols: 55, rows: 30 });
  });

  it("sends no size when the pane has not mounted, and corrects it if it does", async () => {
    const t = makeTerminal();
    invoke.mockResolvedValue({ pid: 1, claudeSessionId: null });

    await spawnTerminal(t);

    const [, spawnArgs] = invoke.mock.calls[0]!;
    // Nothing to report — Rust keeps its default rather than being handed a
    // guess about a pane that does not exist yet.
    expect(spawnArgs).toMatchObject({ cols: null, rows: null });
  });
});

// ---------------------------------------------------------------------------

describe("resuming a Claude conversation", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue({ pid: 3, claudeSessionId: "conv-1" });
    useTerminalsStore.setState({ byId: {} });
    useTerminalRuntimeStore.setState({
      hasUserInput: {},
      configDirty: {},
      resumableClaudeSessions: {},
    });
    resetToastsState();
  });

  it("passes the conversation uuid through to Rust", async () => {
    const t = makeTerminal();

    await spawnTerminal(t, { resumeClaudeSession: "conv-1" });

    expect(invoke.mock.calls[0]![1]).toMatchObject({
      resumeClaudeSession: "conv-1",
    });
  });

  it("spends the parked offer, whichever way it was answered", async () => {
    // Both buttons on the deferred overlay end here. Once a process is
    // running, "there is a conversation waiting" is no longer true.
    const t = makeTerminal();
    useTerminalRuntimeStore.getState().markResumable(t.id, "conv-1");

    await spawnTerminal(t, { resumeClaudeSession: null });

    expect(
      useTerminalRuntimeStore.getState().resumableClaudeSessions[t.id],
    ).toBeUndefined();
  });

  it("leaves the offer standing when the spawn fails", async () => {
    // Nothing started, so the choice has not been made — the overlay has to
    // still be there to try again.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    invoke.mockRejectedValue(new Error("claude: command not found"));
    const t = makeTerminal();
    useTerminalRuntimeStore.getState().markResumable(t.id, "conv-1");

    await spawnTerminal(t, { resumeClaudeSession: "conv-1" });

    expect(
      useTerminalRuntimeStore.getState().resumableClaudeSessions[t.id],
    ).toBe("conv-1");
    warn.mockRestore();
  });

  /** A `--resume` at a conversation that was never written kills the pane, so
   *  Rust starts a fresh one instead and says so. The pane is alive either
   *  way — what is being asserted here is that the user finds out, because an
   *  agent that has silently forgotten the work it was doing is the same
   *  failure with better manners. */
  it("says so when the conversation could not be recovered", async () => {
    invoke.mockResolvedValue({
      pid: 3,
      claudeSessionId: "conv-fresh",
      conversationLost: true,
    });
    const t = makeTerminal("Roxie");

    await spawnTerminal(t, { resumeClaudeSession: "conv-1" });

    const [toast] = useToastsStore.getState().items;
    expect(toast?.message).toMatch(/Roxie/);
    expect(toast?.message).toMatch(/could not be recovered/);
    expect(toast?.tone).toBe("warn");
    // …and the pane is in the conversation it actually started, not the one it
    // was asked for.
    expect(useTerminalsStore.getState().byId[t.id]!.claudeSessionId).toBe(
      "conv-fresh",
    );
  });

  it("says nothing when the conversation came back", async () => {
    invoke.mockResolvedValue({
      pid: 3,
      claudeSessionId: "conv-1",
      conversationLost: false,
    });
    const t = makeTerminal();

    await spawnTerminal(t, { resumeClaudeSession: "conv-1" });

    expect(useToastsStore.getState().items).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("the spawn queue", () => {
  /** Spawns that hang until the test says otherwise. */
  let settle: Array<() => void>;

  beforeEach(() => {
    invoke.mockReset();
    settle = [];
    useTerminalsStore.setState({ byId: {} });
    invoke.mockImplementation(
      () =>
        new Promise((resolve) => {
          settle.push(() => resolve({ pid: 1, claudeSessionId: null }));
        }),
    );
  });

  /** Settle everything, including the spawns that only START once an earlier
   *  one finishes — releasing a slot admits the next in line, which then has
   *  its own promise to settle. */
  const drain = async () => {
    for (let pass = 0; pass < 20; pass++) {
      while (settle.length > 0) settle.shift()!();
      await flush();
      const { inFlight, waiting } = spawnQueueDepth();
      if (inFlight === 0 && waiting === 0) return;
    }
  };

  afterEach(async () => {
    // The queue is module state, and a spawn left in flight would count
    // against the next test's cap.
    await drain();
    expect(spawnQueueDepth()).toEqual({ inFlight: 0, waiting: 0 });
  });

  it("starts at most four at once, however many are asked for", async () => {
    // A boot restore across four workspaces asks for sixteen in one tick. All
    // sixteen forking a login shell that execs an agent CLI is a thundering
    // herd, and the panes that lose come up `error` for reasons that have
    // nothing to do with the user.
    const all = Array.from({ length: 10 }, (_, i) =>
      spawnTerminal(makeTerminal(`Pane ${i}`)),
    );
    await flush();

    expect(invoke).toHaveBeenCalledTimes(MAX_CONCURRENT_SPAWNS);
    expect(spawnQueueDepth()).toEqual({ inFlight: 4, waiting: 6 });

    // Every finished spawn lets exactly one more start.
    settle.shift()!();
    await flush();
    expect(invoke).toHaveBeenCalledTimes(MAX_CONCURRENT_SPAWNS + 1);

    await drain();
    expect(invoke).toHaveBeenCalledTimes(10);
    await Promise.all(all);
  });

  it("hands the slot on in the order it was asked for", async () => {
    const names = ["a", "b", "c", "d", "e", "f"];
    const all = names.map((n) => spawnTerminal(makeTerminal(n)));
    await flush();

    // Release them one at a time; each release admits the next in line.
    for (let i = 0; i < names.length; i++) {
      settle.shift()?.();
      await flush();
    }
    await Promise.all(all);

    const spawnedNames = invoke.mock.calls.map(([, args]) => {
      const { terminalId } = args as { terminalId: string };
      return useTerminalsStore.getState().byId[terminalId]!.name;
    });
    expect(spawnedNames).toEqual(names);
  });

  it("gives the slot back when a spawn fails", async () => {
    // A slot leaked on the error path would shrink the cap with every failure
    // until nothing could start at all.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    invoke.mockReset();
    invoke.mockRejectedValue(new Error("nope"));

    await Promise.all(
      Array.from({ length: 6 }, (_, i) => spawnTerminal(makeTerminal(`f${i}`))),
    );

    expect(invoke).toHaveBeenCalledTimes(6);
    expect(spawnQueueDepth()).toEqual({ inFlight: 0, waiting: 0 });
    warn.mockRestore();
  });
});
