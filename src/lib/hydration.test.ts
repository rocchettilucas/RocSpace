import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (event: { payload: unknown }) => void;
const handlers = new Map<string, Handler>();

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: Handler) => {
    handlers.set(name, handler);
    return () => handlers.delete(name);
  }),
}));

import { EVENT_TERMINAL_OUTPUT, EVENT_TERMINAL_STATUS } from "@/lib/bindings";
import { newTerminal } from "@/lib/factories";
import { reconcileHydratedTerminals, resumeTargetOf } from "@/lib/hydration";
import { mountPtyBridge, notifyTerminalUserInput } from "@/lib/ptyBridge";
import { useTerminalsStore } from "@/stores/terminals";
import { useTerminalRuntimeStore } from "@/stores/terminalRuntime";
import type { TerminalStatus } from "@/lib/bindings";

/** A session as it comes back off disk: a status from the last run, plus the
 *  pid and Claude session uuid of a process that died with it. */
function hydrate(status: TerminalStatus, claudeSessionId: string | null) {
  const t = newTerminal({
    workspaceId: "w1",
    name: "Rocky",
    agentType: claudeSessionId ? "claude-code" : "shell",
    projectPath: "/tmp",
  });
  useTerminalsStore
    .getState()
    .setTerminals([
      ...Object.values(useTerminalsStore.getState().byId),
      { ...t, status, pid: 4242, claudeSessionId },
    ]);
  return t.id;
}

const sessionOf = (id: string) =>
  useTerminalsStore.getState().byId[id]!.claudeSessionId;
const pidOf = (id: string) => useTerminalsStore.getState().byId[id]!.pid;
const resumable = () =>
  useTerminalRuntimeStore.getState().resumableClaudeSessions;

describe("reconcileHydratedTerminals", () => {
  beforeEach(() => {
    useTerminalsStore.setState({ byId: {} });
    useTerminalRuntimeStore.setState({
      hasUserInput: {},
      configDirty: {},
      resumableClaudeSessions: {},
    });
  });

  it("returns only the panes that were mid-flight at quit", () => {
    const running = hydrate("running", null);
    const awaiting = hydrate("awaiting_approval", null);
    hydrate("complete", null);
    hydrate("error", null);
    hydrate("idle", null);

    const respawn = reconcileHydratedTerminals().map((t) => t.id);

    expect(respawn.sort()).toEqual([running, awaiting].sort());
  });

  it("clears the dead pid off every hydrated pane", () => {
    const finished = hydrate("complete", "dead-uuid");
    const midFlight = hydrate("running", "also-dead-uuid");
    const shell = hydrate("idle", null);

    reconcileHydratedTerminals();

    // Nothing is running, whatever the snapshot says — and a mid-flight pane
    // is respawned moments later and gets a fresh pid from `recordSpawn`.
    expect(pidOf(finished)).toBeNull();
    expect(pidOf(midFlight)).toBeNull();
    expect(pidOf(shell)).toBeNull();
  });

  it("clears the uuid of a pane it is respawning, and keeps the one it parked", () => {
    const finished = hydrate("complete", "cold-uuid");
    const midFlight = hydrate("running", "hot-uuid");

    reconcileHydratedTerminals();

    // The respawn hands this pane a fresh conversation; until it lands the
    // pane must not claim the dead one.
    expect(sessionOf(midFlight)).toBeNull();
    // The cold one keeps it, because it IS the offer standing over the pane —
    // and the offer has to survive the next quit as well. The runtime store's
    // copy does not; this is the only thing that gets written back to disk.
    expect(sessionOf(finished)).toBe("cold-uuid");
  });

  it("clears a stray uuid nothing can resume", () => {
    // Only Claude Code is ever handed one, so a uuid on a shell pane is
    // leftover nonsense, not an offer.
    const shell = hydrate("complete", null);
    useTerminalsStore.setState((s) => ({
      byId: {
        ...s.byId,
        [shell]: { ...s.byId[shell]!, claudeSessionId: "stray" },
      },
    }));

    reconcileHydratedTerminals();

    expect(sessionOf(shell)).toBeNull();
    expect(resumable()[shell]).toBeUndefined();
  });

  it("offers the same conversation again on the next boot", () => {
    // The bug this replaced: the uuid was wiped off the session while the
    // offer lived only in the ephemeral runtime store, so quitting with the
    // question unanswered answered it — the conversation was gone.
    const finished = hydrate("complete", "conv-cold");

    reconcileHydratedTerminals();
    // A second boot: same persisted session, a runtime store that remembers
    // nothing.
    useTerminalRuntimeStore.setState({ resumableClaudeSessions: {} });
    reconcileHydratedTerminals();

    expect(resumable()[finished]).toBe("conv-cold");
    expect(sessionOf(finished)).toBe("conv-cold");
    expect(pidOf(finished)).toBeNull();
  });

  it("hands back the session so a respawn can still use its config", () => {
    const id = hydrate("running", "dead-uuid");
    const [session] = reconcileHydratedTerminals();
    expect(session?.id).toBe(id);
    expect(session?.agentConfig.type).toBe("claude-code");
  });

  it("hands back the conversation uuid the respawn has to resume into", () => {
    // The store's copy is cleared — nothing running claims it — but the
    // session handed back is a snapshot from before that, because `--resume`
    // needs the value and there is nowhere else left to read it.
    const id = hydrate("running", "conv-1");

    const [session] = reconcileHydratedTerminals();

    expect(resumeTargetOf(session!)).toBe("conv-1");
    expect(sessionOf(id)).toBeNull();
  });

  it("parks the conversation of a pane it is NOT respawning", () => {
    // A finished Claude pane is not restarted behind the user's back, but its
    // conversation is still there to be picked up — that is what the deferred
    // overlay offers.
    const finished = hydrate("complete", "conv-cold");

    reconcileHydratedTerminals();

    expect(resumable()[finished]).toBe("conv-cold");
  });

  it("does not park one for a pane it IS respawning", () => {
    // The respawn puts it in that conversation itself; an offer standing over
    // a pane already in it is a button that means nothing.
    const midFlight = hydrate("running", "conv-hot");

    reconcileHydratedTerminals();

    expect(resumable()[midFlight]).toBeUndefined();
  });

  it("parks nothing for a pane that was never in a conversation", () => {
    const shell = hydrate("complete", null);

    reconcileHydratedTerminals();

    expect(resumable()[shell]).toBeUndefined();
    expect(Object.keys(resumable())).toHaveLength(0);
  });
});

describe("resumeTargetOf", () => {
  it("is null for an agent that is never handed a uuid", () => {
    // Only Claude Code gets `--session-id`, so only it has anything to resume.
    // A uuid on a codex pane could only be leftover nonsense.
    const shell = newTerminal({
      workspaceId: "w1",
      name: "Shelly",
      agentType: "shell",
      projectPath: "/tmp",
    });

    expect(resumeTargetOf({ ...shell, claudeSessionId: "stray" })).toBeNull();
  });
});

describe("a hydrated pane that is not respawned", () => {
  let unmount: (() => void) | undefined;

  beforeEach(async () => {
    vi.useFakeTimers();
    handlers.clear();
    useTerminalsStore.setState({ byId: {} });
    useTerminalRuntimeStore.setState({
      hasUserInput: {},
      configDirty: {},
      resumableClaudeSessions: {},
    });
    unmount = await mountPtyBridge();
  });

  afterEach(() => {
    unmount?.();
    vi.useRealTimers();
  });

  /** The user opens the pane by hand and starts working in it. */
  function work(id: string) {
    handlers.get(EVENT_TERMINAL_STATUS)!({
      payload: { terminalId: id, status: "running" },
    });
    notifyTerminalUserInput(id);
    handlers.get(EVENT_TERMINAL_OUTPUT)!({
      payload: {
        terminalId: id,
        lineId: "l1",
        ts: 0,
        stream: "stdout",
        text: "hello",
      },
    });
    vi.advanceTimersByTime(5000);
  }

  it("is not hook-driven, so its status heuristic still works", () => {
    // The bug: the snapshot's `claudeSessionId` made ptyBridge believe this
    // pane reported its own lifecycle, so it disabled the silence heuristic —
    // for a Claude session that died with the last quit and will never send
    // another hook event. The pane's dot never moved again.
    //
    // The pane KEEPS that uuid now — it is the resume offer, and the offer has
    // to survive a quit — so what answers this question is the parked offer
    // beside it, not the uuid.
    const id = hydrate("complete", "dead-uuid");
    reconcileHydratedTerminals();
    expect(useTerminalsStore.getState().byId[id]!.claudeSessionId).toBe(
      "dead-uuid",
    );

    work(id);

    expect(useTerminalsStore.getState().byId[id]!.status).toBe(
      "awaiting_approval",
    );
  });

  it("is hook-driven again once the offer is answered", () => {
    // The other half of the same seam: a pane that IS in a live conversation
    // must keep its hooks authoritative, or a long tool call gets called
    // `awaiting_approval` by a heuristic that has no business running.
    const id = hydrate("complete", "dead-uuid");
    reconcileHydratedTerminals();
    // What answering the offer does: `recordSpawn` writes the conversation the
    // process is actually in, and `spawnTerminal` spends the offer.
    useTerminalsStore.getState().recordSpawn(id, {
      pid: 9,
      claudeSessionId: "live-uuid",
      conversationLost: false,
    });
    useTerminalRuntimeStore.getState().clearResumable(id);

    work(id);

    expect(useTerminalsStore.getState().byId[id]!.status).toBe("running");
  });
});
