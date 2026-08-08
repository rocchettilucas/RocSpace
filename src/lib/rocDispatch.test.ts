/** The fan-out: one message, many panes, each on its own clock. */

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
  DISPATCH_QUIET_MS,
} from "@/lib/agentDispatch";
import { newTerminal, newWorkspace } from "@/lib/factories";
import {
  cancelRocDispatch,
  dispatchBrainTurn,
  dispatchToTargets,
  getRocTargetState,
  resendRocDispatch,
  resetRocDispatchState,
} from "@/lib/rocDispatch";
import { useRocStore, type RocTarget } from "@/stores/roc";
import { useTerminalsStore } from "@/stores/terminals";
import { useTerminalRuntimeStore } from "@/stores/terminalRuntime";
import { resetToastsState, useToastsStore } from "@/stores/toasts";
import { useWorkspacesStore } from "@/stores/workspaces";
import type {
  AgentType,
  TerminalSession,
  TerminalStatus,
} from "@/lib/bindings";

let workspaceId = "";

function addPaneIn(
  inWorkspace: string,
  name: string,
  over: { agentType?: AgentType; status?: TerminalStatus } = {},
): RocTarget {
  const terminal = newTerminal({
    workspaceId: inWorkspace,
    name,
    agentType: over.agentType ?? "claude-code",
    projectPath: "/code/rocspace",
  });
  terminal.status = over.status ?? "idle";
  useTerminalsStore.getState().addTerminal(terminal);
  return { terminalId: terminal.id, name, workspaceId: inWorkspace };
}

const addPane = (
  name: string,
  over: { agentType?: AgentType; status?: TerminalStatus } = {},
): RocTarget => addPaneIn(workspaceId, name, over);

/** A second dock, so "this workspace" can be told from "any workspace". */
function otherWorkspace(): string {
  const workspace = newWorkspace({
    name: "backend",
    projectPath: "/code/backend",
    order: 1,
  });
  useWorkspacesStore.setState((s) => ({
    workspaces: [...s.workspaces, workspace],
  }));
  return workspace.id;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const writes = (): { terminalId: string; data: string }[] =>
  invoke.mock.calls
    .filter(([cmd]) => cmd === "terminal_write")
    .map(([, args]) => args as { terminalId: string; data: string });

/** Everything written into one pane, as one string. */
const wroteTo = (target: RocTarget): string =>
  writes()
    .filter((w) => w.terminalId === target.terminalId)
    .map((w) => w.data)
    .join("");

const toastText = () => useToastsStore.getState().items.map((t) => t.message);

const stateOf = (target: RocTarget) => getRocTargetState(target.terminalId);

const paneOf = (target: RocTarget): TerminalSession =>
  useTerminalsStore.getState().byId[target.terminalId]!;

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async () => null);
  resetRocDispatchState();
  resetToastsState();
  useTerminalsStore.setState({ byId: {} });
  useTerminalRuntimeStore.setState({ hasUserInput: {} });
  useRocStore.setState({ log: [], phase: "idle", selectedTerminalIds: [] });
  const workspace = newWorkspace({
    name: "rocspace",
    projectPath: "/code/rocspace",
    order: 0,
  });
  workspaceId = workspace.id;
  useWorkspacesStore.setState({
    workspaces: [workspace],
    activeWorkspaceId: workspace.id,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("dispatchToTargets", () => {
  it("writes the message into every target, framed as one paste", async () => {
    const rocky = addPane("Rocky");
    const roxie = addPane("Roxie");

    await dispatchToTargets("ship it", [rocky, roxie]);

    expect(writes()).toHaveLength(2);
    expect(
      writes()
        .map((w) => w.terminalId)
        .sort(),
    ).toEqual([rocky.terminalId, roxie.terminalId].sort());
    for (const write of writes()) {
      expect(write.data).toBe("\x1b[200~ship it\x1b[201~\r");
    }
  });

  it("waits on the targets AT THE SAME TIME, not one after another", async () => {
    // The whole point of the fan-out. Three shells each need a quiet second;
    // done in series that is three seconds, and the third agent starts work
    // two seconds after the first.
    vi.useFakeTimers();
    const panes = [
      addPane("One", { agentType: "shell", status: "running" }),
      addPane("Two", { agentType: "shell", status: "running" }),
      addPane("Three", { agentType: "shell", status: "running" }),
    ];

    const pending = dispatchToTargets("ship it", panes);
    await vi.advanceTimersByTimeAsync(DISPATCH_QUIET_MS + 10);
    await pending;

    expect(writes()).toHaveLength(3);
  });

  it("does not let one blocked pane hold up the others", async () => {
    const blocked = addPane("Blocked", { status: "awaiting_approval" });
    const ready = addPane("Ready");

    const pending = dispatchToTargets("ship it", [blocked, ready]);
    await settle();

    // The ready one has already been written to; the blocked one has not.
    expect(writes()).toHaveLength(1);
    expect(writes()[0]!.terminalId).toBe(ready.terminalId);

    useTerminalsStore.getState().setStatus(blocked.terminalId, "idle");
    await pending;
    expect(writes()).toHaveLength(2);
  });

  it("marks a pane it is waiting on as queued, then sent", async () => {
    const blocked = addPane("Blocked", { status: "awaiting_approval" });

    const pending = dispatchToTargets("ship it", [blocked]);
    await settle();
    expect(stateOf(blocked)).toBe("queued");

    useTerminalsStore.getState().setStatus(blocked.terminalId, "idle");
    await pending;
    expect(stateOf(blocked)).toBe("sent");
  });

  it("skips a pane whose agent has exited, and says whose", async () => {
    // Rust keeps an exited session in its map, so the write would succeed into
    // a dead descriptor and the user would think three agents had the message.
    const dead = addPane("Rocky", { status: "complete" });
    const live = addPane("Roxie");

    const outcome = await dispatchToTargets("ship it", [dead, live]);

    expect(writes()).toHaveLength(1);
    expect(writes()[0]!.terminalId).toBe(live.terminalId);
    expect(outcome.skipped).toEqual(["Rocky"]);
    expect(stateOf(dead)).toBe("skipped");
    expect(toastText().join(" ")).toContain("Rocky");
  });

  it("names every dead pane in one toast rather than one each", async () => {
    const a = addPane("Rocky", { status: "complete" });
    const b = addPane("Roxie", { status: "error" });

    await dispatchToTargets("ship it", [a, b]);

    expect(useToastsStore.getState().items).toHaveLength(1);
    expect(toastText()[0]).toContain("Rocky");
    expect(toastText()[0]).toContain("Roxie");
  });

  it("says so when there is nobody to send to", async () => {
    const outcome = await dispatchToTargets("ship it", []);

    expect(writes()).toHaveLength(0);
    expect(outcome.sent).toEqual([]);
    expect(toastText()).toHaveLength(1);
    expect(useRocStore.getState().log).toHaveLength(0);
  });

  it("sends nothing for a message that is only whitespace", async () => {
    const rocky = addPane("Rocky");
    await dispatchToTargets("   \n ", [rocky]);
    expect(writes()).toHaveLength(0);
    expect(useRocStore.getState().log).toHaveLength(0);
  });

  it("marks the panes as having had user input", async () => {
    // The idle watchdog and the notification bridge both gate on this flag.
    const rocky = addPane("Rocky");
    await dispatchToTargets("ship it", [rocky]);
    expect(
      useTerminalRuntimeStore.getState().hasUserInput[rocky.terminalId],
    ).toBe(true);
  });

  it("says so when a write fails, and does not claim it was sent", async () => {
    const rocky = addPane("Rocky");
    invoke.mockRejectedValueOnce(new Error("pipe closed"));

    const outcome = await dispatchToTargets("ship it", [rocky]);

    expect(outcome.failed).toEqual(["Rocky"]);
    expect(outcome.sent).toEqual([]);
    expect(stateOf(rocky)).toBe("failed");
    // A tick late, because a failure that arrives late is said alongside the
    // others that arrive with it — see "saying a late failure once".
    await settle();
    expect(toastText()).toEqual(["Could not send to Rocky"]);
  });
});

/** A broadcast to five agents all sitting on a permission prompt reaches the
 *  five-minute budget five times at once. That used to be five notifications
 *  saying the same sentence about five names — a wall the user dismisses
 *  without reading, which is how the one name that mattered goes unread. The
 *  dead panes known UP FRONT were bundled from the start; these are the same
 *  message and were not. */
describe("saying a late failure once", () => {
  it("names every pane that ran out of patience in one toast", async () => {
    vi.useFakeTimers();
    const panes = ["Rocky", "Roxie", "Rex"].map((name) =>
      addPane(name, { status: "awaiting_approval" }),
    );

    const pending = dispatchToTargets("ship it", panes);
    await vi.advanceTimersByTimeAsync(DISPATCH_APPROVAL_WAIT_MS + 10);
    await pending;

    expect(toastText()).toEqual([
      "Rocky, Roxie and Rex are still waiting on you —" +
        " nothing was sent to them",
    ]);
  });

  it("names every pane that died while it waited in one toast", async () => {
    const a = addPane("Rocky", { status: "awaiting_approval" });
    const b = addPane("Roxie", { status: "awaiting_approval" });

    const pending = dispatchToTargets("ship it", [a, b]);
    await settle();
    // Both agents exit while the message is parked in front of their prompts.
    // The fan-out's up-front summary went out before either of them did.
    useTerminalsStore.getState().setStatus(a.terminalId, "complete");
    useTerminalsStore.getState().setStatus(b.terminalId, "complete");
    await pending;
    await settle();

    expect(toastText()).toEqual([
      "Rocky and Roxie have exited — nothing was sent to them",
    ]);
  });

  it("names every write that failed in one toast", async () => {
    const a = addPane("Rocky");
    const b = addPane("Roxie");
    invoke.mockRejectedValue(new Error("pipe closed"));

    await dispatchToTargets("ship it", [a, b]);
    await settle();

    expect(toastText()).toEqual(["Could not send to Rocky and Roxie"]);
  });

  it("keeps two kinds of failure in two sentences", async () => {
    // One sentence for the lot would name panes the user cannot act on as a
    // group: an agent that has exited is a session to restart, and a write that
    // threw is not.
    const dying = addPane("Rocky");
    const broken = addPane("Roxie");
    invoke.mockImplementation(async (cmd: unknown, args: unknown) => {
      const { terminalId } = args as { terminalId?: string };
      if (cmd === "terminal_write" && terminalId === broken.terminalId) {
        throw new Error("pipe closed");
      }
      return null;
    });

    const pending = dispatchToTargets("ship it", [dying, broken]);
    // Between the fan-out's up-front check, which runs before it awaits
    // anything, and the job reaching this pane. So it is late by construction:
    // the summary naming the dead has already gone out without it.
    useTerminalsStore.getState().setStatus(dying.terminalId, "complete");
    await pending;
    await settle();

    expect(toastText().sort()).toEqual([
      "Could not send to Roxie",
      "Rocky's agent has exited — nothing was sent to it",
    ]);
  });

  it("still says a lone late failure on its own terms", async () => {
    // Bundling must not turn one pane into a list of one.
    const rocky = addPane("Rocky", { status: "awaiting_approval" });

    const pending = dispatchToTargets("ship it", [rocky]);
    await settle();
    useTerminalsStore.getState().setStatus(rocky.terminalId, "complete");
    await pending;
    await settle();

    expect(toastText()).toEqual([
      "Rocky's agent has exited — nothing was sent to it",
    ]);
  });

  it("does not hold a failure back for a pane that is still waiting", async () => {
    // The window is a tick, not the fan-out: a write that fails now, sent
    // alongside a pane parked in front of a permission prompt, must not sit
    // unreported for the five minutes that pane is allowed to take.
    vi.useFakeTimers();
    const parked = addPane("Rocky", { status: "awaiting_approval" });
    const broken = addPane("Roxie");
    invoke.mockImplementation(async (cmd: unknown, args: unknown) => {
      const { terminalId } = args as { terminalId?: string };
      if (cmd === "terminal_write" && terminalId === broken.terminalId) {
        throw new Error("pipe closed");
      }
      return null;
    });

    const pending = dispatchToTargets("ship it", [parked, broken]);
    await vi.advanceTimersByTimeAsync(50);

    expect(toastText()).toEqual(["Could not send to Roxie"]);

    await vi.advanceTimersByTimeAsync(DISPATCH_APPROVAL_WAIT_MS + 10);
    await pending;
  });

  it("says nothing about a suite that has been reset out from under it", async () => {
    const rocky = addPane("Rocky");
    invoke.mockRejectedValue(new Error("pipe closed"));

    await dispatchToTargets("ship it", [rocky]);
    resetRocDispatchState();
    await settle();

    expect(toastText()).toEqual([]);
  });
});

describe("the log", () => {
  it("records what was said and who it went to, newest first", async () => {
    const rocky = addPane("Rocky");
    const roxie = addPane("Roxie");

    await dispatchToTargets("first", [rocky]);
    await dispatchToTargets("second", [rocky, roxie]);

    const log = useRocStore.getState().log;
    expect(log).toHaveLength(2);
    expect(log[0]!.text).toBe("second");
    expect(log[0]!.targets.map((t) => t.name)).toEqual(["Rocky", "Roxie"]);
    expect(log[1]!.targets.map((t) => t.name)).toEqual(["Rocky"]);
  });

  // A name alone cannot say which dock it was in, and `Rocky` is a name the
  // pool hands out per app — so the record keeps the whole target.
  it("remembers which workspace each pane was in", async () => {
    const rocky = addPane("Rocky");
    await dispatchToTargets("ship it", [rocky]);

    expect(useRocStore.getState().log[0]!.targets).toEqual([
      { terminalId: rocky.terminalId, name: "Rocky", workspaceId },
    ]);
  });

  it("records the trimmed message, which is what was actually sent", async () => {
    const rocky = addPane("Rocky");
    await dispatchToTargets("  ship it  ", [rocky]);
    expect(useRocStore.getState().log[0]!.text).toBe("ship it");
    expect(writes()[0]!.data).toBe("\x1b[200~ship it\x1b[201~\r");
  });

  it("records nothing when every target was skipped", async () => {
    const dead = addPane("Rocky", { status: "complete" });
    await dispatchToTargets("ship it", [dead]);
    expect(useRocStore.getState().log).toHaveLength(0);
  });

  it("is written before the slow panes answer, so the user sees it go", async () => {
    const blocked = addPane("Blocked", { status: "awaiting_approval" });

    const pending = dispatchToTargets("ship it", [blocked]);
    await settle();
    expect(useRocStore.getState().log).toHaveLength(1);

    useTerminalsStore.getState().setStatus(blocked.terminalId, "idle");
    await pending;
  });
});

describe("the phase", () => {
  it("is dispatching until the last pane has answered", async () => {
    const blocked = addPane("Blocked", { status: "awaiting_approval" });

    const pending = dispatchToTargets("ship it", [blocked]);
    await settle();
    expect(useRocStore.getState().phase).toBe("dispatching");

    useTerminalsStore.getState().setStatus(blocked.terminalId, "idle");
    await pending;
    expect(useRocStore.getState().phase).toBe("idle");
  });

  // The other end of the same rule, and the one that was missing: the phase was
  // taken unconditionally on the way in and given back only from "dispatching",
  // so a fan-out that started while the microphone was open would have taken a
  // recording state that nothing would ever hand back.
  it("does not take the orb from a microphone that is already open", async () => {
    const rocky = addPane("Rocky");
    useRocStore.getState().setPhase("listening");

    await dispatchToTargets("ship it", [rocky]);

    expect(useRocStore.getState().phase).toBe("listening");
    // …and it still sent, because the phase is a label and not a gate.
    expect(writes()).toHaveLength(1);
  });

  it("does not stomp on a microphone that opened mid-dispatch", async () => {
    const blocked = addPane("Blocked", { status: "awaiting_approval" });

    const pending = dispatchToTargets("ship it", [blocked]);
    await settle();
    useRocStore.getState().setPhase("listening");
    useTerminalsStore.getState().setStatus(blocked.terminalId, "idle");
    await pending;

    expect(useRocStore.getState().phase).toBe("listening");
  });
});

describe("one pane at a time, in order", () => {
  it("queues a second message behind the first rather than racing it", async () => {
    const rocky = addPane("Rocky", { status: "awaiting_approval" });

    const first = dispatchToTargets("first", [rocky]);
    const second = dispatchToTargets("second", [rocky]);
    await settle();
    expect(writes()).toHaveLength(0);
    expect(stateOf(rocky)).toBe("queued");

    useTerminalsStore.getState().setStatus(rocky.terminalId, "idle");
    await Promise.all([first, second]);

    expect(writes().map((w) => w.data)).toEqual([
      "\x1b[200~first\x1b[201~\r",
      "\x1b[200~second\x1b[201~\r",
    ]);
  });

  // The badge was whatever the last job to finish wrote, so a pane that took
  // the first message while the second was still on its way wore "Sent" — and
  // the queued badge IS the cancel, so the one message that could still be
  // called off was the one with no button on it.
  it("still offers the cancel while a later message is outstanding", async () => {
    const rocky = addPane("Rocky");
    let releaseSecond = () => {};
    let written = 0;
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd !== "terminal_write") return null;
      written += 1;
      // The second write is held open, which is where a real one spends its
      // time: an IPC round trip into Rust and out to a PTY.
      if (written === 2) await new Promise<void>((r) => (releaseSecond = r));
      return null;
    });

    const first = dispatchToTargets("first", [rocky]);
    const second = dispatchToTargets("second", [rocky]);
    await first;
    await settle();

    expect(writes()).toHaveLength(2);
    expect(stateOf(rocky)).toBe("queued");

    releaseSecond();
    await second;
    expect(stateOf(rocky)).toBe("sent");
  });

  it("keeps each pane on its own clock", async () => {
    // Rocky is blocked and Roxie is not; Roxie's second message must not wait
    // for Rocky's first.
    const rocky = addPane("Rocky", { status: "awaiting_approval" });
    const roxie = addPane("Roxie");

    const first = dispatchToTargets("first", [rocky, roxie]);
    const second = dispatchToTargets("second", [roxie]);
    await settle();

    expect(
      writes().filter((w) => w.terminalId === roxie.terminalId),
    ).toHaveLength(2);

    useTerminalsStore.getState().setStatus(rocky.terminalId, "idle");
    await Promise.all([first, second]);
  });
});

describe("cancelling", () => {
  it("drops a queued message and lets go of the wait", async () => {
    const rocky = addPane("Rocky", { status: "awaiting_approval" });

    const pending = dispatchToTargets("ship it", [rocky]);
    await settle();
    cancelRocDispatch(rocky.terminalId);
    await pending;

    expect(stateOf(rocky)).toBeUndefined();

    // The pane clearing afterwards must not deliver the message anyway.
    useTerminalsStore.getState().setStatus(rocky.terminalId, "idle");
    await settle();
    expect(writes()).toHaveLength(0);
  });

  it("drops everything queued behind it too", async () => {
    const rocky = addPane("Rocky", { status: "awaiting_approval" });

    const first = dispatchToTargets("first", [rocky]);
    const second = dispatchToTargets("second", [rocky]);
    await settle();
    cancelRocDispatch(rocky.terminalId);
    await Promise.all([first, second]);

    useTerminalsStore.getState().setStatus(rocky.terminalId, "idle");
    await settle();
    expect(writes()).toHaveLength(0);
  });

  // A cancel used to throw the pane's chain away along with the jobs on it. A
  // job already inside its write cannot be called back by an abort, so the
  // next message started its own write beside it: two writes racing into one
  // PTY, which is the exact thing the chain exists to prevent — and caused by
  // the button whose whole job is to make LESS happen.
  it("does not let the next message overlap a write already in the air", async () => {
    const rocky = addPane("Rocky");
    const order: string[] = [];
    let releaseFirst = () => {};
    invoke.mockImplementation(async (cmd: string, args: unknown) => {
      if (cmd !== "terminal_write") return null;
      // The message inside the framing, which is all this test is about.
      const which = (args as { data: string }).data.includes("first")
        ? "first"
        : "second";
      order.push(`start ${which}`);
      if (which === "first") await new Promise<void>((r) => (releaseFirst = r));
      order.push(`end ${which}`);
      return null;
    });

    const first = dispatchToTargets("first", [rocky]);
    await settle();
    cancelRocDispatch(rocky.terminalId);
    const second = dispatchToTargets("second", [rocky]);
    await settle();

    // The second one is waiting its turn rather than writing over the top of
    // the first, which has not come back yet.
    expect(order).toEqual(["start first"]);

    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual([
      "start first",
      "end first",
      "start second",
      "end second",
    ]);
  });

  // …and that job cannot come back claiming success. The cancel took the badge
  // down; a tick painted over it afterwards would be the app answering "stop"
  // with "done". It says what really happened instead, because the bytes did
  // go and believing otherwise is the worse half of the same lie.
  it("does not report a cancelled write as sent", async () => {
    const rocky = addPane("Rocky");
    let releaseWrite = () => {};
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd !== "terminal_write") return null;
      await new Promise<void>((r) => (releaseWrite = r));
      return null;
    });

    const pending = dispatchToTargets("ship it", [rocky]);
    await settle();
    cancelRocDispatch(rocky.terminalId);
    releaseWrite();
    const summary = await pending;

    expect(summary.sent).toEqual([]);
    expect(stateOf(rocky)).toBeUndefined();
    expect(toastText().join(" ")).toContain("too late");
  });

  it("leaves the other panes alone", async () => {
    const rocky = addPane("Rocky", { status: "awaiting_approval" });
    const roxie = addPane("Roxie", { status: "awaiting_approval" });

    const pending = dispatchToTargets("ship it", [rocky, roxie]);
    await settle();
    cancelRocDispatch(rocky.terminalId);
    useTerminalsStore.getState().setStatus(roxie.terminalId, "idle");
    await pending;

    expect(writes()).toHaveLength(1);
    expect(writes()[0]!.terminalId).toBe(roxie.terminalId);
  });
});

describe("re-sending from the log", () => {
  it("finds the panes again by the names the record kept", async () => {
    const rocky = addPane("Rocky");
    await dispatchToTargets("ship it", [rocky]);
    const record = useRocStore.getState().log[0]!;
    invoke.mockClear();

    await resendRocDispatch(record);

    expect(writes()).toHaveLength(1);
    expect(writes()[0]!.terminalId).toBe(rocky.terminalId);
  });

  it("follows a renamed session's name, not a stale id", async () => {
    const rocky = addPane("Rocky");
    await dispatchToTargets("ship it", [rocky]);
    const record = useRocStore.getState().log[0]!;

    // The pane the record names is closed and a new one takes the name — which
    // is exactly what happens when a session is restarted.
    useTerminalsStore.getState().removeTerminal(rocky.terminalId);
    const again = addPane("Rocky");
    invoke.mockClear();

    await resendRocDispatch(record);

    expect(writes()).toHaveLength(1);
    expect(writes()[0]!.terminalId).toBe(again.terminalId);
  });

  // `Rocky` is a name the pool hands out per app, so two docks can each hold
  // one. Re-resolved across every workspace, a broadcast made in one project
  // grew a target in another — two panes became three, and the pane that was
  // never addressed got the message anyway.
  it("stays inside the workspace the message was sent in", async () => {
    const here = addPane("Rocky");
    const there = addPaneIn(otherWorkspace(), "Rocky");
    await dispatchToTargets("ship it", [here]);
    const record = useRocStore.getState().log[0]!;
    invoke.mockClear();

    await resendRocDispatch(record);

    expect(writes()).toHaveLength(1);
    expect(writes()[0]!.terminalId).toBe(here.terminalId);
    expect(writes().some((w) => w.terminalId === there.terminalId)).toBe(false);
  });

  // …and it must not quietly stand the other one in for it either: a pane that
  // is gone is a sentence the user can act on, and a same-named pane in another
  // project is not the pane they meant.
  it("reports a pane that has gone rather than finding it elsewhere", async () => {
    const here = addPane("Rocky");
    const there = addPaneIn(otherWorkspace(), "Rocky");
    await dispatchToTargets("ship it", [here]);
    const record = useRocStore.getState().log[0]!;
    useTerminalsStore.getState().removeTerminal(here.terminalId);
    resetToastsState();
    invoke.mockClear();

    await resendRocDispatch(record);

    expect(writes()).toHaveLength(0);
    expect(writes().some((w) => w.terminalId === there.terminalId)).toBe(false);
    expect(toastText().join(" ")).toContain("Rocky");
  });

  // A brain turn's `text` is the SENTENCE the person said; each agent was given
  // its own instruction. Sending that sentence again is the addressed-to-nobody
  // blast the brain exists to replace, one click away in the log.
  it("gives each agent its own instruction back, not the request", async () => {
    const rocky = addPane("Rocky");
    const roxie = addPane("Roxie");
    await dispatchBrainTurn("ask Rocky and Roxie to get on it", [
      { target: rocky, prompt: "Fix the auth test." },
      { target: roxie, prompt: "Update the login form." },
    ]);
    const record = useRocStore.getState().log[0]!;
    invoke.mockClear();

    await resendRocDispatch(record);

    expect(writes()).toHaveLength(2);
    expect(wroteTo(rocky)).toContain("Fix the auth test.");
    expect(wroteTo(roxie)).toContain("Update the login form.");
    expect(writes().some((w) => w.data.includes("ask Rocky and Roxie"))).toBe(
      false,
    );
    // One entry for the re-sent turn, marked and carrying the prompts again —
    // so the entry it wrote can itself be pressed.
    const written = useRocStore.getState().log[0]!;
    expect(written.viaBrain).toBe(true);
    expect(written.prompts).toEqual({
      Rocky: "Fix the auth test.",
      Roxie: "Update the login form.",
    });
  });

  // Same reason the names are re-resolved at all: a session restarted since is
  // a new id under the same name, and it is the same agent as far as the
  // instruction is concerned.
  it("finds a restarted session by name and gives it that name's prompt", async () => {
    const rocky = addPane("Rocky");
    await dispatchBrainTurn("ask Rocky", [
      { target: rocky, prompt: "Fix the auth test." },
    ]);
    const record = useRocStore.getState().log[0]!;
    useTerminalsStore.getState().removeTerminal(rocky.terminalId);
    const again = addPane("Rocky");
    invoke.mockClear();

    await resendRocDispatch(record);

    expect(writes()).toHaveLength(1);
    expect(writes()[0]!.terminalId).toBe(again.terminalId);
    expect(wroteTo(again)).toContain("Fix the auth test.");
  });

  // Belt and braces for a record with no prompts on it: say so rather than
  // falling back to the request, which is the one thing that must not happen.
  it("refuses to fall back to the sentence when the prompts are gone", async () => {
    const rocky = addPane("Rocky");
    await dispatchToTargets("ship it", [rocky]);
    const record = { ...useRocStore.getState().log[0]!, viaBrain: true };
    resetToastsState();
    invoke.mockClear();

    await resendRocDispatch(record);

    expect(writes()).toHaveLength(0);
    expect(toastText().join(" ")).toContain("ask Roc again");
  });

  it("says so when none of those sessions are open any more", async () => {
    const rocky = addPane("Rocky");
    await dispatchToTargets("ship it", [rocky]);
    const record = useRocStore.getState().log[0]!;
    useTerminalsStore.getState().removeTerminal(rocky.terminalId);
    resetToastsState();
    invoke.mockClear();

    await resendRocDispatch(record);

    expect(writes()).toHaveLength(0);
    expect(toastText().join(" ")).toContain("Rocky");
  });
});

describe("stale marks", () => {
  it("clears a finished pane's mark when the next dispatch starts", async () => {
    const rocky = addPane("Rocky");
    const roxie = addPane("Roxie");
    await dispatchToTargets("first", [rocky]);
    expect(stateOf(rocky)).toBe("sent");

    await dispatchToTargets("second", [roxie]);

    // The rail shows the LAST dispatch, so a row that had nothing to do with
    // it must not still be wearing a tick from the one before.
    expect(stateOf(rocky)).toBeUndefined();
    expect(stateOf(roxie)).toBe("sent");
  });

  it("leaves a pane that is still waiting alone", async () => {
    const blocked = addPane("Blocked", { status: "awaiting_approval" });
    const other = addPane("Other");

    const first = dispatchToTargets("first", [blocked]);
    await settle();
    await dispatchToTargets("second", [other]);
    expect(stateOf(blocked)).toBe("queued");

    useTerminalsStore.getState().setStatus(blocked.terminalId, "idle");
    await first;
  });

  it("forgets a pane that has been closed", async () => {
    const rocky = addPane("Rocky");
    await dispatchToTargets("ship it", [rocky]);
    expect(stateOf(rocky)).toBe("sent");
    expect(paneOf(rocky).name).toBe("Rocky");

    useTerminalsStore.getState().removeTerminal(rocky.terminalId);
    await settle();

    expect(stateOf(rocky)).toBeUndefined();
  });
});
