import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (event: { payload: unknown }) => void;
const handlers = new Map<string, Handler>();

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: Handler) => {
    handlers.set(name, handler);
    return () => handlers.delete(name);
  }),
}));

import {
  EVENT_AGENT_STATUS,
  EVENT_TERMINAL_OUTPUT,
  EVENT_TERMINAL_STATUS,
} from "@/lib/bindings";
import { newTerminal, newWorkspace } from "@/lib/factories";
import { mountNotificationsBridge } from "@/lib/notificationsBridge";
import { resetOutputQueues } from "@/lib/outputQueue";
import {
  flushOutputQueues,
  mountPtyBridge,
  notifyTerminalUserInput,
} from "@/lib/ptyBridge";
import { useNotificationsStore } from "@/stores/notifications";
import { useTerminalsStore } from "@/stores/terminals";
import { useTerminalRuntimeStore } from "@/stores/terminalRuntime";
import { useUIStore } from "@/stores/ui";
import { useWorkspacesStore } from "@/stores/workspaces";

function emit(name: string, payload: unknown) {
  const handler = handlers.get(name);
  if (!handler) throw new Error(`nothing listening on ${name}`);
  handler({ payload });
}

function emitOutput(terminalId: string, text = "hello") {
  emit(EVENT_TERMINAL_OUTPUT, {
    terminalId,
    lineId: `l${Math.random()}`,
    ts: 0,
    stream: "stdout",
    text,
  });
}

/** A session with a live Claude Code session id — i.e. one whose status comes
 *  from lifecycle hooks. */
function addTerminal(claudeSessionId: string | null) {
  const t = newTerminal({
    workspaceId: "w1",
    name: "Rocky",
    agentType: claudeSessionId ? "claude-code" : "shell",
    projectPath: "/tmp",
  });
  useTerminalsStore.getState().addTerminal({ ...t, claudeSessionId });
  return t.id;
}

const statusOf = (id: string) => useTerminalsStore.getState().byId[id]!.status;

describe("mountPtyBridge", () => {
  let unmount: (() => void) | undefined;

  beforeEach(async () => {
    vi.useFakeTimers();
    handlers.clear();
    resetOutputQueues();
    useTerminalsStore.setState({ byId: {} });
    useTerminalRuntimeStore.setState({ hasUserInput: {} });
    unmount = await mountPtyBridge();
  });

  afterEach(() => {
    unmount?.();
    vi.useRealTimers();
  });

  it("applies agent://status to the store", () => {
    const id = addTerminal("uuid-1");
    emit(EVENT_AGENT_STATUS, { terminalId: id, status: "awaiting_approval" });
    expect(statusOf(id)).toBe("awaiting_approval");

    emit(EVENT_AGENT_STATUS, { terminalId: id, status: "complete" });
    expect(statusOf(id)).toBe("complete");
  });

  it("bypasses the silence heuristic for a hook-driven terminal", () => {
    const id = addTerminal("uuid-1");
    emit(EVENT_TERMINAL_STATUS, { terminalId: id, status: "running" });
    notifyTerminalUserInput(id);
    emitOutput(id);

    vi.advanceTimersByTime(5000);

    // The heuristic would have called this awaiting_approval seconds ago.
    expect(statusOf(id)).toBe("running");
  });

  it("keeps the silence heuristic for agents with no hooks", () => {
    const id = addTerminal(null);
    emit(EVENT_TERMINAL_STATUS, { terminalId: id, status: "running" });
    notifyTerminalUserInput(id);
    emitOutput(id);

    vi.advanceTimersByTime(5000);

    expect(statusOf(id)).toBe("awaiting_approval");
  });

  it("does not let output overwrite a hook-set awaiting_approval", () => {
    // A permission prompt keeps painting the pane while it waits for an
    // answer; treating that output as "still working" would erase the state
    // the hook just reported.
    const id = addTerminal("uuid-1");
    emit(EVENT_AGENT_STATUS, { terminalId: id, status: "awaiting_approval" });

    emitOutput(id, "Do you want to proceed?");

    expect(statusOf(id)).toBe("awaiting_approval");
  });

  it("lets output clear awaiting_approval for a non-hook terminal", () => {
    const id = addTerminal(null);
    useTerminalsStore.getState().setStatus(id, "awaiting_approval");

    emitOutput(id);

    expect(statusOf(id)).toBe("running");
  });

  it("clears a hook-set awaiting_approval when the user answers the prompt", () => {
    const id = addTerminal("uuid-1");
    emit(EVENT_AGENT_STATUS, { terminalId: id, status: "awaiting_approval" });

    notifyTerminalUserInput(id);

    expect(statusOf(id)).toBe("running");
    expect(useTerminalRuntimeStore.getState().hasUserInput[id]).toBe(true);
  });

  it("leaves a completed hook-driven pane alone when the user starts typing", () => {
    // Composing a follow-up isn't running yet — UserPromptSubmit says that.
    const id = addTerminal("uuid-1");
    emit(EVENT_AGENT_STATUS, { terminalId: id, status: "complete" });

    notifyTerminalUserInput(id);

    expect(statusOf(id)).toBe("complete");
  });

  it("still records PTY output for hook-driven terminals", () => {
    const id = addTerminal("uuid-1");
    emitOutput(id, "banner");

    // Output is batched now (see `outputQueue`): the bridge queues it and the
    // next animation frame writes it to xterm and the ring buffer together.
    expect(useTerminalsStore.getState().byId[id]!.output).toHaveLength(0);
    flushOutputQueues();

    expect(useTerminalsStore.getState().byId[id]!.output).toHaveLength(1);
    expect(useTerminalsStore.getState().byId[id]!.output[0]!.text).toBe(
      "banner",
    );
  });

  it("still applies process exit from terminal://status", () => {
    const id = addTerminal("uuid-1");
    emit(EVENT_AGENT_STATUS, { terminalId: id, status: "running" });
    emit(EVENT_TERMINAL_STATUS, { terminalId: id, status: "error" });
    expect(statusOf(id)).toBe("error");
  });
});

/** The Claude `Stop` hook fires at the end of every assistant turn, so the
 *  status it produces is on the hot path for notifications: one push (plus one
 *  audible ding) per turn, for the pane the user is reading, is exactly the
 *  failure mode Phase 3 removed. Rust maps `Stop` to `idle`; these tests pin
 *  the renderer half — idle is silent FOR THE PANE YOU ARE WATCHING, and the
 *  process exit that really does deserve a notification still gets one.
 *
 *  What happens to a turn ending in a pane you are NOT watching is the same
 *  rule from the other side, and it lives in `notificationsBridge.test.ts`
 *  where the "am I looking at it" fixture does. */
describe("end-of-turn idle vs. process exit", () => {
  let unmountPty: (() => void) | undefined;
  let unmountNotifications: (() => void) | undefined;

  beforeEach(async () => {
    handlers.clear();
    resetOutputQueues();
    useTerminalsStore.setState({ byId: {} });
    useTerminalRuntimeStore.setState({ hasUserInput: {} });
    useNotificationsStore.setState({ items: [] });
    useWorkspacesStore.setState({ workspaces: [], activeWorkspaceId: null });
    useUIStore.setState({ focusedTerminalId: null, mainView: "terminals" });
    unmountPty = await mountPtyBridge();
    unmountNotifications = mountNotificationsBridge();
  });

  afterEach(() => {
    unmountPty?.();
    unmountNotifications?.();
  });

  const notificationCount = () => useNotificationsStore.getState().items.length;

  /** Put the pane on screen and under the user's eye: its workspace active,
   *  the pane focused, the dock showing. */
  function watch(terminalId: string) {
    const workspace = newWorkspace({
      name: "W",
      projectPath: "/tmp",
      order: 0,
    });
    useWorkspacesStore.setState({
      workspaces: [
        { ...workspace, id: "w1", paneTree: { kind: "leaf", terminalId } },
      ],
      activeWorkspaceId: "w1",
    });
    useUIStore.setState({ focusedTerminalId: terminalId });
  }

  it("announces a turn that ends in the pane you are watching too", () => {
    const id = addTerminal("uuid-1");
    watch(id);
    notifyTerminalUserInput(id);
    emit(EVENT_AGENT_STATUS, { terminalId: id, status: "running" });

    // The Stop hook, as Rust now maps it.
    emit(EVENT_AGENT_STATUS, { terminalId: id, status: "idle" });

    expect(statusOf(id)).toBe("idle");
    // Every finished agent is announced now, the one under your cursor
    // included — see `notificationsBridge`. Watching a pane is not answering it.
    expect(notificationCount()).toBe(1);
  });

  it("files one row across many turns you sit through", () => {
    const id = addTerminal("uuid-1");
    watch(id);
    notifyTerminalUserInput(id);
    for (let turn = 0; turn < 5; turn++) {
      emit(EVENT_AGENT_STATUS, { terminalId: id, status: "running" });
      emit(EVENT_AGENT_STATUS, { terminalId: id, status: "idle" });
    }
    // One standing row for a pane nobody has answered — the chime is what
    // repeats per turn, not the list entry.
    expect(notificationCount()).toBe(1);
  });

  it("still notifies once when the CLI actually exits", () => {
    const id = addTerminal("uuid-1");
    notifyTerminalUserInput(id);
    emit(EVENT_AGENT_STATUS, { terminalId: id, status: "running" });

    // The PTY exit waiter — the only signal that says "the process is gone".
    emit(EVENT_TERMINAL_STATUS, { terminalId: id, status: "complete" });

    expect(statusOf(id)).toBe("complete");
    expect(notificationCount()).toBe(1);
    expect(useNotificationsStore.getState().items[0]!.kind).toBe("complete");
  });

  it("notifies on exit even when the last turn left the pane idle", () => {
    const id = addTerminal("uuid-1");
    watch(id);
    notifyTerminalUserInput(id);
    emit(EVENT_AGENT_STATUS, { terminalId: id, status: "running" });
    emit(EVENT_AGENT_STATUS, { terminalId: id, status: "idle" });
    emit(EVENT_TERMINAL_STATUS, { terminalId: id, status: "complete" });

    // Two rows now: the turn that ended, then the process that exited. They
    // are different news, and the second is the one at the top.
    expect(notificationCount()).toBe(2);
    expect(useNotificationsStore.getState().items[0]!.kind).toBe("complete");
  });
});
