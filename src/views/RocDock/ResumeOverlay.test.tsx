/** The deferred choice on a cold Claude pane: who gets asked, and what each
 *  answer starts. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import { newTerminal } from "@/lib/factories";
import { useHistoryStore } from "@/stores/history";
import { useTerminalsStore } from "@/stores/terminals";
import { useTerminalRuntimeStore } from "@/stores/terminalRuntime";
import { ResumeOverlay } from "@/views/RocDock/ResumeOverlay";
import type { AgentType } from "@/lib/bindings";

function pane(
  agentType: AgentType = "claude-code",
  pid: number | null = null,
  /** As hydration leaves a cold Claude pane: the conversation stays on the
   *  session so the offer outlives the run — see `lib/hydration.ts`. */
  claudeSessionId: string | null = null,
) {
  const t = {
    ...newTerminal({
      workspaceId: "w1",
      name: "Rocky",
      agentType,
      projectPath: "/tmp/proj",
    }),
    pid,
    claudeSessionId,
  };
  useTerminalsStore.getState().addTerminal(t);
  return t;
}

const resume = () =>
  screen.getByRole("button", { name: /Resume conversation/ });
const fresh = () => screen.getByRole("button", { name: /Start fresh/ });
const spawnArgs = () =>
  invoke.mock.calls.find(([cmd]) => cmd === "terminal_spawn")![1] as {
    terminalId: string;
    resumeClaudeSession: string | null;
  };

/** Command-aware, because the overlay asks two different things: whether the
 *  conversation it is about to offer still exists, and (once answered) for a
 *  PTY. `exists` is what the first one says. */
function mockBackend(exists = true, spawn = { claudeSessionId: "conv-1" }) {
  invoke.mockImplementation(async (cmd: string) =>
    cmd === "claude_conversation_exists"
      ? exists
      : { pid: 9, conversationLost: false, ...spawn },
  );
}

beforeEach(() => {
  invoke.mockReset();
  mockBackend();
  useTerminalsStore.setState({ byId: {} });
  useTerminalRuntimeStore.setState({
    hasUserInput: {},
    configDirty: {},
    resumableClaudeSessions: {},
  });
});

describe("when it appears", () => {
  it("offers the choice on a cold pane with a conversation waiting", () => {
    const t = pane();
    useTerminalRuntimeStore.getState().markResumable(t.id, "conv-1");

    render(<ResumeOverlay terminalId={t.id} />);

    expect(resume()).toBeInTheDocument();
    expect(fresh()).toBeInTheDocument();
  });

  it("says nothing for a pane with no conversation waiting", () => {
    // Which is every pane the app started itself, and every non-Claude pane.
    const t = pane("shell");

    render(<ResumeOverlay terminalId={t.id} />);

    expect(screen.queryByRole("button")).toBeNull();
  });

  it("says nothing once something is running in the pane", () => {
    // A pid is the pane answering for itself: whatever started it, the offer
    // is stale and covering a live terminal.
    const t = pane("claude-code", 4242);
    useTerminalRuntimeStore.getState().markResumable(t.id, "conv-1");

    render(<ResumeOverlay terminalId={t.id} />);

    expect(screen.queryByRole("button")).toBeNull();
  });

  it("says nothing for a pane that has been closed", () => {
    useTerminalRuntimeStore.getState().markResumable("ghost", "conv-1");

    render(<ResumeOverlay terminalId="ghost" />);

    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("answering it", () => {
  it("Resume conversation spawns with the parked uuid", async () => {
    const t = pane();
    useTerminalRuntimeStore.getState().markResumable(t.id, "conv-1");
    render(<ResumeOverlay terminalId={t.id} />);

    fireEvent.click(resume());

    await waitFor(() => expect(invoke).toHaveBeenCalled());
    expect(spawnArgs()).toMatchObject({
      terminalId: t.id,
      resumeClaudeSession: "conv-1",
    });
  });

  it("Start fresh spawns without it, and forgets it", async () => {
    const t = pane();
    useTerminalRuntimeStore.getState().markResumable(t.id, "conv-1");
    render(<ResumeOverlay terminalId={t.id} />);

    fireEvent.click(fresh());

    await waitFor(() => expect(invoke).toHaveBeenCalled());
    expect(spawnArgs().resumeClaudeSession).toBeNull();
    // Forgotten once the spawn LANDS, not when the button is pressed: until
    // then the parked uuid is the only copy of the conversation there is.
    await waitFor(() =>
      expect(
        useTerminalRuntimeStore.getState().resumableClaudeSessions[t.id],
      ).toBeUndefined(),
    );
  });

  it("Start fresh leaves the pane in the conversation it started", async () => {
    // The offer is re-derived from the pane's own uuid on every boot, so an
    // answer that left the old uuid there would be asked again tomorrow.
    // `recordSpawn` overwrites it with the conversation the new process is
    // actually in, which is what ends the question.
    mockBackend(true, { claudeSessionId: "conv-2" });
    const t = pane("claude-code", null, "conv-1");
    useTerminalRuntimeStore.getState().markResumable(t.id, "conv-1");
    render(<ResumeOverlay terminalId={t.id} />);

    fireEvent.click(fresh());

    await waitFor(() =>
      expect(useTerminalsStore.getState().byId[t.id]!.claudeSessionId).toBe(
        "conv-2",
      ),
    );
    expect(
      useTerminalRuntimeStore.getState().resumableClaudeSessions[t.id],
    ).toBeUndefined();
  });

  it("goes away the instant it is answered, not a round trip later", () => {
    // A button that stays put under the cursor while the IPC is in flight
    // invites a second press, and a second press is a second PTY.
    const t = pane();
    useTerminalRuntimeStore.getState().markResumable(t.id, "conv-1");
    render(<ResumeOverlay terminalId={t.id} />);

    fireEvent.click(resume());

    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("when the spawn fails", () => {
  /** The failure modes this pane is *for*: `claude` not on PATH, or a
   *  conversation the CLI has since dropped. Either way the pane does not come
   *  up — and the uuid must survive it, because there is nowhere else left to
   *  read the conversation from. */
  beforeEach(() => {
    // The conversation is there; it is the SPAWN that fails. Rejecting both
    // would be testing two things at once.
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "claude_conversation_exists") return true;
      throw new Error("claude: command not found");
    });
    useHistoryStore.setState({ failures: [] });
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps the conversation and stands the offer back up", async () => {
    const t = pane();
    useTerminalRuntimeStore.getState().markResumable(t.id, "conv-1");
    render(<ResumeOverlay terminalId={t.id} />);

    fireEvent.click(resume());

    // Both answers are on offer again, and the uuid is still there to answer
    // with — clearing it up front made a failed resume destroy the
    // conversation permanently.
    await waitFor(() => expect(resume()).toBeInTheDocument());
    expect(fresh()).toBeInTheDocument();
    expect(
      useTerminalRuntimeStore.getState().resumableClaudeSessions[t.id],
    ).toBe("conv-1");
  });

  it("says so, and files the reason where the user can read it", async () => {
    const t = pane();
    useTerminalRuntimeStore.getState().markResumable(t.id, "conv-1");
    render(<ResumeOverlay terminalId={t.id} />);

    fireEvent.click(resume());

    expect(await screen.findByText(/That did not start/)).toBeInTheDocument();
    const [failure] = useHistoryStore.getState().failures;
    expect(failure).toMatchObject({
      kind: "resume",
      error: "claude: command not found",
    });
  });

  it("survives a second attempt failing too", async () => {
    // The offer is not spent by trying: a user who fixes their PATH and comes
    // back has to find the same two buttons.
    const t = pane();
    useTerminalRuntimeStore.getState().markResumable(t.id, "conv-1");
    render(<ResumeOverlay terminalId={t.id} />);

    fireEvent.click(fresh());
    await waitFor(() => expect(fresh()).toBeInTheDocument());
    fireEvent.click(fresh());

    await waitFor(() => expect(fresh()).toBeInTheDocument());
    expect(
      useTerminalRuntimeStore.getState().resumableClaudeSessions[t.id],
    ).toBe("conv-1");
  });
});

/** Offering a conversation that no longer exists is the resume bug wearing a
 *  different face: a session nobody ever prompted leaves no transcript, so
 *  "pick it up where it left off" was an offer to run a command that fails and
 *  takes the pane down with it. */
describe("when the conversation is gone", () => {
  it("does not offer to resume it", async () => {
    mockBackend(false);
    const t = pane();
    useTerminalRuntimeStore.getState().markResumable(t.id, "conv-1");

    render(<ResumeOverlay terminalId={t.id} />);

    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /Resume conversation/ }),
      ).toBeNull(),
    );
    // …and the pane is still worth having, so the only thing left to do is
    // still on offer.
    expect(fresh()).toBeInTheDocument();
  });

  it("says the conversation is gone rather than quietly dropping the button", async () => {
    mockBackend(false);
    const t = pane();
    useTerminalRuntimeStore.getState().markResumable(t.id, "conv-1");

    render(<ResumeOverlay terminalId={t.id} />);

    expect(await screen.findByText(/no longer available/)).toBeInTheDocument();
    expect(screen.getByText(/never prompted/)).toBeInTheDocument();
  });

  it("keeps the offer when the question itself could not be answered", async () => {
    // An unreadable home directory proves nothing. Withdrawing the offer on
    // "cannot say" would throw away a conversation the user could have had
    // back, which is worse than the bug this check exists for.
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "claude_conversation_exists") throw new Error("nope");
      return { pid: 9, claudeSessionId: "conv-1", conversationLost: false };
    });
    const t = pane();
    useTerminalRuntimeStore.getState().markResumable(t.id, "conv-1");

    render(<ResumeOverlay terminalId={t.id} />);

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("claude_conversation_exists", {
        claudeSessionId: "conv-1",
      }),
    );
    expect(resume()).toBeInTheDocument();
  });
});
