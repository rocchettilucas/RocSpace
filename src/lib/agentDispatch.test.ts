/** The primitives every dispatch in the app is built out of: what text is safe
 *  to put in a PTY, how it is framed so a multi-line prompt arrives as one
 *  paste, when a pane is safe to write into, and the write itself. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import {
  DISPATCH_APPROVAL_WAIT_MS,
  DISPATCH_QUIET_MAX_WAIT_MS,
  DISPATCH_QUIET_MS,
  hasExited,
  pasteSafeLine,
  sanitizeForPty,
  sendToTerminal,
  toBracketedPaste,
  waitUntilReady,
} from "@/lib/agentDispatch";
import { newOutputLine, newTerminal } from "@/lib/factories";
import { useTerminalsStore } from "@/stores/terminals";
import { useTerminalRuntimeStore } from "@/stores/terminalRuntime";
import type {
  AgentType,
  TerminalSession,
  TerminalStatus,
} from "@/lib/bindings";

const WORKSPACE = "workspace_1";

function addPane(
  name: string,
  over: { agentType?: AgentType; status?: TerminalStatus } = {},
): TerminalSession {
  const terminal = newTerminal({
    workspaceId: WORKSPACE,
    name,
    agentType: over.agentType ?? "claude-code",
    projectPath: "/code/rocspace",
  });
  terminal.status = over.status ?? "idle";
  useTerminalsStore.getState().addTerminal(terminal);
  return terminal;
}

/** Let queued microtasks (and any zero-delay timer) run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const writes = () =>
  invoke.mock.calls.filter(([cmd]) => cmd === "terminal_write");

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async () => null);
  useTerminalsStore.setState({ byId: {} });
  useTerminalRuntimeStore.setState({ hasUserInput: {} });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("sanitizeForPty", () => {
  it("keeps newlines and drops every other control byte", () => {
    expect(sanitizeForPty("one\ntwo\x07three\x00four")).toBe(
      "one\ntwothreefour",
    );
  });

  it("folds a carriage return into a newline rather than dropping it", () => {
    // Inside a paste a bare \r is a submit on every ink-based CLI, so a
    // description written on Windows line endings would end the paste early.
    expect(sanitizeForPty("one\r\ntwo\rthree")).toBe("one\ntwo\nthree");
  });

  it("strips the escape that would close the paste", () => {
    expect(sanitizeForPty("safe\x1b[201~\rrm -rf /")).toBe(
      "safe[201 ~\nrm -rf /",
    );
  });

  it("breaks a paste marker that has no escape left on it", () => {
    // Belt and braces: a terminal resynchronising on a stray byte, or a caller
    // that frames this some other way, could rebuild the marker from the text.
    expect(sanitizeForPty("[200~ and [201~")).toBe("[200 ~ and [201 ~");
  });
});

describe("pasteSafeLine", () => {
  it("folds every line break into a space", () => {
    expect(pasteSafeLine("one\ntwo\r\nthree")).toBe("one two three");
  });

  it("drops control bytes and neutralizes paste markers", () => {
    expect(pasteSafeLine("hi\x1b[201~\x07there")).toBe("hi[201 ~there");
  });
});

describe("toBracketedPaste", () => {
  it("frames the text and ends it with the carriage return that sends it", () => {
    expect(toBracketedPaste("ship it")).toBe("\x1b[200~ship it\x1b[201~\r");
  });

  it("sanitizes the body, so the only escape is the frame's own", () => {
    const framed = toBracketedPaste("a\x1b[201~\rb");
    expect(framed).toBe("\x1b[200~a[201 ~\nb\x1b[201~\r");
    // One opener, one closer, one carriage return: the text cannot have
    // smuggled a second submit in.
    expect([...framed].filter((c) => c === "\x1b")).toHaveLength(2);
    expect([...framed].filter((c) => c === "\r")).toHaveLength(1);
  });
});

describe("hasExited", () => {
  it.each([
    ["complete", true],
    ["error", true],
    ["idle", false],
    ["running", false],
    ["awaiting_approval", false],
    ["paused", false],
  ] as const)("is %s -> %s", (status, expected) => {
    const pane = addPane("Rocky", { status });
    expect(hasExited(pane)).toBe(expected);
  });
});

describe("waitUntilReady", () => {
  it("refuses a terminal the store has never heard of", async () => {
    await expect(waitUntilReady("nope")).resolves.toBe("dead");
  });

  it.each(["complete", "error"] as const)(
    "refuses a pane whose agent has %s'd",
    async (status) => {
      // Rust keeps an exited session in its map, so the write would succeed
      // into a dead descriptor and nothing would ever say so.
      const pane = addPane("Rocky", { status });
      await expect(waitUntilReady(pane.id)).resolves.toBe("dead");
    },
  );

  it("goes straight through on an idle claude pane", async () => {
    const pane = addPane("Rocky", { status: "idle" });
    await expect(waitUntilReady(pane.id)).resolves.toBe("ready");
  });

  it("goes through on a claude pane mid-turn — the CLI queues what is typed", async () => {
    const pane = addPane("Rocky", { status: "running" });
    await expect(waitUntilReady(pane.id)).resolves.toBe("ready");
  });

  it("holds while a claude pane is asking the user something", async () => {
    const pane = addPane("Rocky", { status: "awaiting_approval" });
    const settled = vi.fn();
    const pending = waitUntilReady(pane.id).then(settled);
    await settle();
    // Writing now would ANSWER the question on screen with the message.
    expect(settled).not.toHaveBeenCalled();

    useTerminalsStore.getState().setStatus(pane.id, "idle");
    await pending;
    expect(settled).toHaveBeenCalledWith("ready");
  });

  it("gives up on a pane that never stops asking", async () => {
    vi.useFakeTimers();
    const pane = addPane("Rocky", { status: "awaiting_approval" });
    const pending = waitUntilReady(pane.id);
    await vi.advanceTimersByTimeAsync(DISPATCH_APPROVAL_WAIT_MS + 10);
    await expect(pending).resolves.toBe("timeout");
  });

  it("takes a shorter budget from the caller", async () => {
    vi.useFakeTimers();
    const pane = addPane("Rocky", { status: "awaiting_approval" });
    const pending = waitUntilReady(pane.id, { timeoutMs: 500 });
    await vi.advanceTimersByTimeAsync(510);
    await expect(pending).resolves.toBe("timeout");
  });

  it("stops waiting when the pane is closed", async () => {
    const pane = addPane("Rocky", { status: "awaiting_approval" });
    const pending = waitUntilReady(pane.id);
    await settle();
    useTerminalsStore.getState().removeTerminal(pane.id);
    await expect(pending).resolves.toBe("dead");
  });

  it("stops waiting when the agent quits mid-question", async () => {
    // The pane will never clear its prompt now, and parking on it until the
    // five-minute give-up would hold a subscription for an answer that is
    // never coming.
    const pane = addPane("Rocky", { status: "awaiting_approval" });
    const pending = waitUntilReady(pane.id);
    await settle();
    useTerminalsStore.getState().setStatus(pane.id, "error");
    await expect(pending).resolves.toBe("dead");
  });

  it("waits a second of quiet on a pane with no hooks", async () => {
    vi.useFakeTimers();
    const pane = addPane("Shell", { agentType: "shell", status: "running" });
    const settled = vi.fn();
    const pending = waitUntilReady(pane.id).then(settled);

    await vi.advanceTimersByTimeAsync(DISPATCH_QUIET_MS - 400);
    expect(settled).not.toHaveBeenCalled();

    // Output restarts the clock: the pane is mid-something.
    useTerminalsStore
      .getState()
      .appendOutputLine(pane.id, newOutputLine("building…"));
    await vi.advanceTimersByTimeAsync(DISPATCH_QUIET_MS - 300);
    expect(settled).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(400);
    await pending;
    expect(settled).toHaveBeenCalledWith("ready");
  });

  it("writes anyway once a noisy pane has run out its cap", async () => {
    vi.useFakeTimers();
    const pane = addPane("Shell", { agentType: "shell", status: "running" });
    const pending = waitUntilReady(pane.id);
    for (let i = 0; i < 20; i++) {
      await vi.advanceTimersByTimeAsync(DISPATCH_QUIET_MS - 400);
      useTerminalsStore
        .getState()
        .appendOutputLine(pane.id, newOutputLine(`building ${i}`));
    }
    await vi.advanceTimersByTimeAsync(DISPATCH_QUIET_MAX_WAIT_MS);
    // A prompt that is never sent because the pane is busy is worse than a
    // prompt that queues behind the build's output.
    await expect(pending).resolves.toBe("ready");
  });

  it("stops a quiet wait when the pane's process ends", async () => {
    const pane = addPane("Shell", { agentType: "shell", status: "running" });
    const pending = waitUntilReady(pane.id);
    await settle();
    useTerminalsStore.getState().setStatus(pane.id, "complete");
    await expect(pending).resolves.toBe("dead");
  });

  it("lets a caller call the wait off", async () => {
    const pane = addPane("Rocky", { status: "awaiting_approval" });
    const controller = new AbortController();
    const pending = waitUntilReady(pane.id, { signal: controller.signal });
    await settle();
    controller.abort();
    await expect(pending).resolves.toBe("timeout");

    // …and the wait let go of the store: the pane clearing afterwards must not
    // resolve anything a second time.
    useTerminalsStore.getState().setStatus(pane.id, "idle");
    await settle();
  });

  it("does not start a wait that has already been called off", async () => {
    const pane = addPane("Rocky", { status: "awaiting_approval" });
    const controller = new AbortController();
    controller.abort();
    await expect(
      waitUntilReady(pane.id, { signal: controller.signal }),
    ).resolves.toBe("timeout");
  });
});

describe("sendToTerminal", () => {
  it("writes the framed, sanitized text", async () => {
    const pane = addPane("Rocky");
    await sendToTerminal(pane.id, "ship it");
    expect(writes()).toHaveLength(1);
    expect(writes()[0]![1]).toEqual({
      terminalId: pane.id,
      data: "\x1b[200~ship it\x1b[201~\r",
    });
  });

  it("marks the pane as having had user input, because it has", async () => {
    // The idle watchdog and the notification bridge both gate on this flag: a
    // pane dispatched to without it would neither warn about a permission
    // prompt nor ping when it finished.
    const pane = addPane("Rocky");
    await sendToTerminal(pane.id, "ship it");
    expect(useTerminalRuntimeStore.getState().hasUserInput[pane.id]).toBe(true);
  });

  it("does not claim user input for a write that failed", async () => {
    const pane = addPane("Rocky");
    invoke.mockRejectedValueOnce(new Error("pipe closed"));
    await expect(sendToTerminal(pane.id, "ship it")).rejects.toThrow(
      "pipe closed",
    );
    expect(useTerminalRuntimeStore.getState().hasUserInput[pane.id]).toBe(
      undefined,
    );
  });
});
