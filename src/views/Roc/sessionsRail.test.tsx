/** The sessions rail: every pane, in every workspace, and the two independent
 *  gestures on each row.
 *
 *  This file used to be called `RocView.test.tsx` and never once rendered the
 *  view — the shell that composes the three regions had no coverage at all
 *  while its name was taken. `RocView.test.tsx` is now about `RocView`. */

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Profiler, type ProfilerOnRenderCallback } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

const terminalWrite = vi.fn(async (_terminalId: string, _data: string) => {});
vi.mock("@/lib/bindings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/bindings")>()),
  commands: {
    terminalWrite: (terminalId: string, data: string) =>
      terminalWrite(terminalId, data),
  },
}));

import { newOutputLine, newTerminal, newWorkspace } from "@/lib/factories";
import type { PaneNode } from "@/lib/paneTree";
import { dispatchToTargets, resetRocDispatchState } from "@/lib/rocDispatch";
import { useRocStore } from "@/stores/roc";
import { useTerminalsStore } from "@/stores/terminals";
import { useWorkspacesStore } from "@/stores/workspaces";
import {
  groupSessionsByWorkspace,
  SessionsRail,
} from "@/views/Roc/SessionsRail";
import type { TerminalSession, Workspace } from "@/lib/bindings";

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

const leaf = (terminalId: string): PaneNode => ({ kind: "leaf", terminalId });
const row = (first: PaneNode, second: PaneNode): PaneNode => ({
  kind: "split",
  direction: "row",
  ratio: 0.5,
  first,
  second,
});

/** Two workspaces: "front" with Rocky + Roxie, "back" with Rocco. */
function seedTwoWorkspaces() {
  const front = { ...newWorkspace({ projectPath: "/front", order: 0 }) };
  const back = { ...newWorkspace({ projectPath: "/back", order: 1 }) };
  front.name = "Front";
  back.name = "Back";
  const make = (workspaceId: string, name: string) =>
    newTerminal({
      workspaceId,
      name,
      agentType: "claude-code",
      projectPath: "/tmp",
    });
  const rocky = make(front.id, "Rocky");
  const roxie = make(front.id, "Roxie");
  const rocco = make(back.id, "Rocco");
  useTerminalsStore.getState().setTerminals([rocco, roxie, rocky]);
  useWorkspacesStore.setState({
    workspaces: [
      { ...front, paneTree: row(leaf(rocky.id), leaf(roxie.id)) },
      { ...back, paneTree: leaf(rocco.id) },
    ],
    // The BACK one is active, so "active first" is a real reordering rather
    // than the order the workspaces already came in.
    activeWorkspaceId: back.id,
  });
  return { front, back, rocky, roxie, rocco };
}

beforeEach(() => {
  terminalWrite.mockClear();
  resetRocDispatchState();
  useWorkspacesStore.setState({ workspaces: [], activeWorkspaceId: null });
  useTerminalsStore.setState({ byId: {} });
  useRocStore.setState({
    selectedTerminalIds: [],
    focusedRailTerminalId: null,
  });
});

describe("groupSessionsByWorkspace", () => {
  it("puts the active workspace first and the dock's own order within it", () => {
    const { front, back, rocky, roxie, rocco } = seedTwoWorkspaces();
    const { workspaces } = useWorkspacesStore.getState();
    const { byId } = useTerminalsStore.getState();

    const groups = groupSessionsByWorkspace(workspaces, byId, back.id);

    expect(groups.map((g) => g.workspace.id)).toEqual([back.id, front.id]);
    expect(groups[1]!.sessions.map((s) => s.id)).toEqual([rocky.id, roxie.id]);
    expect(groups[0]!.sessions.map((s) => s.id)).toEqual([rocco.id]);
  });

  it("leaves out a workspace with no sessions", () => {
    const empty: Workspace = {
      ...newWorkspace({ projectPath: "/empty", order: 2 }),
    };
    const groups = groupSessionsByWorkspace(
      [empty],
      {} as Record<string, TerminalSession>,
      null,
    );
    expect(groups).toEqual([]);
  });
});

describe("SessionsRail", () => {
  it("lists every session across every workspace", () => {
    seedTwoWorkspaces();
    render(<SessionsRail />);

    for (const name of ["Rocky", "Roxie", "Rocco"]) {
      expect(screen.getByTitle(`Watch ${name}`)).toBeInTheDocument();
    }
    expect(screen.getByText("Front")).toBeInTheDocument();
    expect(screen.getByText("Back")).toBeInTheDocument();
  });

  // Two gestures, two states: you watch one agent while addressing three.
  it("selecting a row and watching a row are different things", () => {
    const { rocky, roxie } = seedTwoWorkspaces();
    render(<SessionsRail />);

    fireEvent.click(screen.getByLabelText("Select Rocky"));
    fireEvent.click(screen.getByLabelText("Select Roxie"));
    expect(useRocStore.getState().selectedTerminalIds).toEqual([
      rocky.id,
      roxie.id,
    ]);
    expect(useRocStore.getState().focusedRailTerminalId).toBeNull();

    fireEvent.click(screen.getByTitle("Watch Rocco"));
    expect(useRocStore.getState().focusedRailTerminalId).not.toBe(rocky.id);
    // …and watching one did not change who is being addressed.
    expect(useRocStore.getState().selectedTerminalIds).toEqual([
      rocky.id,
      roxie.id,
    ]);
  });

  it("selects and clears everything at once", () => {
    seedTwoWorkspaces();
    render(<SessionsRail />);
    const header = screen.getByLabelText("Sessions").querySelector("header")!;

    fireEvent.click(within(header).getByText("All"));
    expect(useRocStore.getState().selectedTerminalIds).toHaveLength(3);

    fireEvent.click(within(header).getByText("None"));
    expect(useRocStore.getState().selectedTerminalIds).toEqual([]);
  });

  it("says so when there is nothing to talk to", () => {
    render(<SessionsRail />);
    expect(screen.getByText(/no sessions open yet/i)).toBeInTheDocument();
  });
});

describe("the All/None button", () => {
  const header = () =>
    within(screen.getByLabelText("Sessions").querySelector("header")!);

  // It compared the SIZE of the selection with the number of rows, which is the
  // same number for "all three of these" and "two of these plus one pane that
  // is not on this rail". The button then offered to clear a selection that was
  // missing a live pane — and clicking it deselected the two that were picked
  // instead of picking the third.
  it("counts who is selected, not how many", () => {
    const { rocky, roxie } = seedTwoWorkspaces();
    // Three ids, three rows — but one of them names a pane this rail does not
    // list, because its workspace is not in the store.
    useRocStore.setState({
      selectedTerminalIds: [rocky.id, roxie.id, "term_from_a_closed_dock"],
    });
    render(<SessionsRail />);

    expect(header().getByText("All")).toBeInTheDocument();
    fireEvent.click(header().getByText("All"));
    expect(useRocStore.getState().selectedTerminalIds).toHaveLength(3);
    expect(header().getByText("None")).toBeInTheDocument();
  });

  // Closing a pane does not reach into the Roc store, so the selection has to
  // notice for itself — otherwise the id lingers for the rest of the session,
  // counted by the button and handed to a dispatch that cannot use it.
  it("forgets a pane that has been closed", () => {
    const { rocky, roxie, rocco } = seedTwoWorkspaces();
    render(<SessionsRail />);
    fireEvent.click(header().getByText("All"));
    expect(useRocStore.getState().selectedTerminalIds).toHaveLength(3);

    act(() => useTerminalsStore.getState().removeTerminal(rocco.id));

    expect(useRocStore.getState().selectedTerminalIds).toEqual([
      rocky.id,
      roxie.id,
    ]);
    // …and with everything that is left still picked, it offers None again.
    expect(header().getByText("None")).toBeInTheDocument();
  });

  it("leaves a selection alone when nothing was removed", () => {
    const { rocky } = seedTwoWorkspaces();
    const selection = [rocky.id];
    useRocStore.setState({ selectedTerminalIds: selection });

    act(() =>
      useTerminalsStore
        .getState()
        .appendOutputLine(rocky.id, newOutputLine("still here")),
    );

    // Same array, not a new one with the same contents: a fresh array on every
    // frame of output would re-render everything that reads the selection.
    expect(useRocStore.getState().selectedTerminalIds).toBe(selection);
  });
});

describe("walking the rail with the keyboard", () => {
  // The rail is a list of sessions and the arrows are how a list is walked.
  // Automatic activation, like the sidebar's workspaces: arrowing to a session
  // and not seeing its terminal would be a cursor that means nothing.
  it("moves the rail's focus, and shows what it lands on", () => {
    const { rocky, rocco } = seedTwoWorkspaces();
    render(<SessionsRail />);
    const row = () => screen.getByTitle("Watch Rocco");

    // Nothing focused yet: the first press claims row one rather than the
    // second, so arriving by Tab and pressing ↓ does not skip a session.
    fireEvent.keyDown(row(), { key: "ArrowDown" });
    expect(useRocStore.getState().focusedRailTerminalId).toBe(rocco.id);

    fireEvent.keyDown(row(), { key: "ArrowDown" });
    expect(useRocStore.getState().focusedRailTerminalId).toBe(rocky.id);

    fireEvent.keyDown(row(), { key: "ArrowUp" });
    expect(useRocStore.getState().focusedRailTerminalId).toBe(rocco.id);
  });

  it("wraps around rather than stopping at the ends", () => {
    const { roxie, rocco } = seedTwoWorkspaces();
    useRocStore.getState().setFocusedRail(rocco.id);
    render(<SessionsRail />);

    fireEvent.keyDown(screen.getByTitle("Watch Rocco"), { key: "ArrowUp" });

    expect(useRocStore.getState().focusedRailTerminalId).toBe(roxie.id);
  });

  it("ticks the row it is on with Space", () => {
    const { rocco } = seedTwoWorkspaces();
    useRocStore.getState().setFocusedRail(rocco.id);
    render(<SessionsRail />);

    fireEvent.keyDown(screen.getByTitle("Watch Rocco"), { key: " " });
    expect(useRocStore.getState().selectedTerminalIds).toEqual([rocco.id]);

    fireEvent.keyDown(screen.getByTitle("Watch Rocco"), { key: " " });
    expect(useRocStore.getState().selectedTerminalIds).toEqual([]);
  });

  // The checkbox already knows what Space means. Taking it here as well would
  // toggle the row twice and land it back where it started.
  it("leaves the checkbox's own Space alone", () => {
    const { rocco } = seedTwoWorkspaces();
    useRocStore.getState().setFocusedRail(rocco.id);
    render(<SessionsRail />);

    fireEvent.keyDown(screen.getByLabelText("Select Rocco"), { key: " " });

    expect(useRocStore.getState().selectedTerminalIds).toEqual([]);
  });

  // The exemption was written as "not an INPUT", which the cancel badge is not
  // either — it is a button. Space on it ticked the row and swallowed the
  // press, so the only way to call off a message parked in front of a
  // permission prompt was unreachable without a mouse.
  it("leaves the cancel badge's own Space alone", async () => {
    const { rocky } = seedTwoWorkspaces();
    act(() =>
      useTerminalsStore.getState().setStatus(rocky.id, "awaiting_approval"),
    );
    useRocStore.getState().setFocusedRail(rocky.id);
    render(<SessionsRail />);

    const pending = dispatchToTargets("ship it", [
      {
        terminalId: rocky.id,
        name: rocky.name,
        workspaceId: rocky.workspaceId,
      },
    ]);
    await act(async () => {});
    const badge = screen.getByLabelText("Cancel the message queued for Rocky");

    // `fireEvent` is false when the press was cancelled — which is how the
    // browser is told not to activate the button underneath it.
    const notSwallowed = fireEvent.keyDown(badge, { key: " " });

    expect(notSwallowed).toBe(true);
    expect(useRocStore.getState().selectedTerminalIds).toEqual([]);

    act(() => useTerminalsStore.getState().setStatus(rocky.id, "idle"));
    await act(async () => {
      await pending;
    });
  });
});

describe("what the last dispatch did to each row", () => {
  const target = (session: TerminalSession) => ({
    terminalId: session.id,
    name: session.name,
    workspaceId: session.workspaceId,
  });

  it("says which panes took the message and which were skipped", async () => {
    const { rocky, rocco } = seedTwoWorkspaces();
    useTerminalsStore.getState().setStatus(rocco.id, "complete");
    render(<SessionsRail />);

    await act(async () => {
      await dispatchToTargets("ship it", [target(rocky), target(rocco)]);
    });

    const rockyRow = screen.getByTitle("Watch Rocky").parentElement!;
    const roccoRow = screen.getByTitle("Watch Rocco").parentElement!;
    expect(within(rockyRow).getByText("Sent")).toBeInTheDocument();
    expect(within(roccoRow).getByText("Skipped")).toBeInTheDocument();
  });

  // Without this the pane holding the fan-out up is invisible from here: the
  // log would say the message went to two agents while one had not read a word.
  it("wears a queued badge while a pane has not taken it yet", async () => {
    const { rocky } = seedTwoWorkspaces();
    act(() =>
      useTerminalsStore.getState().setStatus(rocky.id, "awaiting_approval"),
    );
    render(<SessionsRail />);

    const pending = dispatchToTargets("ship it", [target(rocky)]);
    await act(async () => {});
    expect(screen.getByText("Queued")).toBeInTheDocument();

    act(() => useTerminalsStore.getState().setStatus(rocky.id, "idle"));
    await act(async () => {
      await pending;
    });
    expect(screen.getByText("Sent")).toBeInTheDocument();
  });

  // The badge IS the cancel: a message aimed at a pane that is asking its user
  // something can sit there for five minutes, and the only other way to call it
  // off would be closing the session.
  it("calls the message off when the queued badge is clicked", async () => {
    const { rocky } = seedTwoWorkspaces();
    act(() =>
      useTerminalsStore.getState().setStatus(rocky.id, "awaiting_approval"),
    );
    render(<SessionsRail />);

    const pending = dispatchToTargets("ship it", [target(rocky)]);
    await act(async () => {});

    fireEvent.click(
      screen.getByLabelText("Cancel the message queued for Rocky"),
    );
    await act(async () => {
      await pending;
    });

    expect(screen.queryByText("Queued")).toBeNull();
    // …and the pane clearing afterwards must not deliver it anyway.
    act(() => useTerminalsStore.getState().setStatus(rocky.id, "idle"));
    await act(async () => {});
    expect(terminalWrite).not.toHaveBeenCalled();
  });

  it("says nothing on a row no dispatch has touched", () => {
    seedTwoWorkspaces();
    render(<SessionsRail />);
    expect(screen.queryByText("Sent")).toBeNull();
    expect(screen.queryByText("Queued")).toBeNull();
  });
});

describe("what the rail subscribes to", () => {
  /** Commits of the rail's own subtree. A render that changes nothing does not
   *  commit, so this counts exactly the repaints the rail costs. */
  function renderCounting() {
    let commits = 0;
    const onRender: ProfilerOnRenderCallback = () => {
      commits += 1;
    };
    render(
      <Profiler id="rail" onRender={onRender}>
        <SessionsRail />
      </Profiler>,
    );
    return () => commits;
  }

  // The rail subscribed to `byId` — the map `outputQueue` rewrites on every
  // animation frame that carries PTY output. That is a full regroup (a
  // `leafIds` walk and a sort per workspace, then a fresh `Set`) up to sixty
  // times a second, for every streaming pane, behind a dock the user is not
  // even looking at.
  it("does not repaint while a pane streams output", () => {
    const { rocky } = seedTwoWorkspaces();
    const commits = renderCounting();
    const before = commits();
    expect(before).toBeGreaterThan(0);

    act(() => {
      for (let i = 0; i < 30; i++) {
        useTerminalsStore
          .getState()
          .appendOutputLine(rocky.id, newOutputLine(`chunk ${i}`));
      }
    });

    expect(commits()).toBe(before);
  });

  // The other half of the same claim: what it stopped watching is only the
  // output. Everything a row draws still lands on the next frame.
  it.each([
    [
      "a rename",
      (id: string) => useTerminalsStore.getState().renameTerminal(id, "Rocket"),
      () => screen.getByTitle("Watch Rocket"),
    ],
    [
      "a status change",
      (id: string) => useTerminalsStore.getState().setStatus(id, "complete"),
      () => screen.getByText("Complete"),
    ],
  ])("still repaints for %s", (_label, mutate, find) => {
    const { rocky } = seedTwoWorkspaces();
    const commits = renderCounting();
    const before = commits();

    act(() => mutate(rocky.id));

    expect(commits()).toBeGreaterThan(before);
    expect(find()).toBeInTheDocument();
  });

  it("repaints when a session appears or goes", () => {
    const { front, rocco } = seedTwoWorkspaces();
    const commits = renderCounting();
    const before = commits();

    act(() =>
      useTerminalsStore.getState().addTerminal(
        newTerminal({
          workspaceId: front.id,
          name: "Rex",
          agentType: "shell",
          projectPath: "/tmp",
        }),
      ),
    );
    expect(screen.getByTitle("Watch Rex")).toBeInTheDocument();

    act(() => useTerminalsStore.getState().removeTerminal(rocco.id));
    expect(screen.queryByTitle("Watch Rocco")).toBeNull();
    expect(commits()).toBeGreaterThan(before);
  });
});
