import { beforeEach, describe, expect, it } from "vitest";
import { ROC_LOG_CAP, useRocStore } from "@/stores/roc";
import { useUIStore } from "@/stores/ui";

beforeEach(() => {
  useUIStore.setState({ mainView: "terminals" });
  useRocStore.setState({
    phase: "idle",
    open: true,
    expanded: false,
    transcript: "",
    selectedTerminalIds: [],
    focusedRailTerminalId: null,
    log: [],
    reply: null,
    brainError: null,
  });
});

describe("phase and transcript", () => {
  it("carries the phase and the live transcript", () => {
    useRocStore.getState().setPhase("listening");
    useRocStore.getState().setTranscript("fix the failing test");

    expect(useRocStore.getState().phase).toBe("listening");
    expect(useRocStore.getState().transcript).toBe("fix the failing test");
  });
});

describe("the widget", () => {
  it("toggles open", () => {
    expect(useRocStore.getState().open).toBe(true);
    useRocStore.getState().toggleOpen();
    expect(useRocStore.getState().open).toBe(false);
    useRocStore.getState().toggleOpen();
    expect(useRocStore.getState().open).toBe(true);
  });
});

describe("expanded ⇄ mainView", () => {
  it("expanding takes the main view to roc, and collapsing gives it back", () => {
    useRocStore.getState().setExpanded(true);
    expect(useUIStore.getState().mainView).toBe("roc");
    expect(useRocStore.getState().expanded).toBe(true);

    useRocStore.getState().setExpanded(false);
    expect(useUIStore.getState().mainView).toBe("terminals");
    expect(useRocStore.getState().expanded).toBe(false);
  });

  // The flag is a mirror, not a second source of truth: anything at all can
  // move the main view (⌘⇧P, a toast's "Watch it work"), and a widget that
  // still thought it was expanded would offer the wrong button.
  it("follows a main-view change it did not make", () => {
    useRocStore.getState().setExpanded(true);

    useUIStore.getState().setMainView("rocplan");
    expect(useRocStore.getState().expanded).toBe(false);

    useUIStore.getState().setMainView("roc");
    expect(useRocStore.getState().expanded).toBe(true);
  });

  // Collapsing while the board is up must not drag the user off the board.
  it("collapsing from a view that is not roc leaves that view alone", () => {
    useUIStore.getState().setMainView("rocplan");

    useRocStore.getState().setExpanded(false);

    expect(useUIStore.getState().mainView).toBe("rocplan");
  });
});

describe("rail selection", () => {
  it("toggles ids in and out", () => {
    useRocStore.getState().toggleSelected("t1");
    useRocStore.getState().toggleSelected("t2");
    expect(useRocStore.getState().selectedTerminalIds).toEqual(["t1", "t2"]);

    useRocStore.getState().toggleSelected("t1");
    expect(useRocStore.getState().selectedTerminalIds).toEqual(["t2"]);
  });

  it("selectOnly replaces the whole selection, de-duplicated", () => {
    useRocStore.getState().toggleSelected("t1");
    useRocStore.getState().selectOnly(["t2", "t3", "t2"]);
    expect(useRocStore.getState().selectedTerminalIds).toEqual(["t2", "t3"]);
  });

  it("clearSelection empties it", () => {
    useRocStore.getState().selectOnly(["t1", "t2"]);
    useRocStore.getState().clearSelection();
    expect(useRocStore.getState().selectedTerminalIds).toEqual([]);
  });

  it("remembers whose live terminal the stage is showing", () => {
    useRocStore.getState().setFocusedRail("t9");
    expect(useRocStore.getState().focusedRailTerminalId).toBe("t9");
    useRocStore.getState().setFocusedRail(null);
    expect(useRocStore.getState().focusedRailTerminalId).toBeNull();
  });
});

describe("the dispatch log", () => {
  const target = (name: string) => ({
    terminalId: `term_${name}`,
    name,
    workspaceId: "ws_1",
  });

  it("keeps the newest entry first", () => {
    useRocStore.getState().pushLog({
      id: "r1",
      at: 1,
      text: "one",
      targets: [target("Rocky")],
      viaBrain: false,
    });
    useRocStore.getState().pushLog({
      id: "r2",
      at: 2,
      text: "two",
      targets: [target("Roxie")],
      viaBrain: false,
    });

    expect(useRocStore.getState().log.map((r) => r.text)).toEqual([
      "two",
      "one",
    ]);
  });

  it(`is capped at ${ROC_LOG_CAP} entries`, () => {
    for (let i = 0; i < ROC_LOG_CAP + 10; i++) {
      useRocStore.getState().pushLog({
        id: `r${i}`,
        at: i,
        text: `#${i}`,
        targets: [],
        viaBrain: false,
      });
    }

    const log = useRocStore.getState().log;
    expect(log).toHaveLength(ROC_LOG_CAP);
    // The oldest ones fell off the end, not the newest off the front.
    expect(log[0]?.text).toBe(`#${ROC_LOG_CAP + 9}`);
  });
});

describe("the reply and the brain's failures", () => {
  it("carries a reply and takes it back down", () => {
    useRocStore.getState().setReply("Told Rocky and Roxie.");
    expect(useRocStore.getState().reply).toBe("Told Rocky and Roxie.");

    useRocStore.getState().setReply(null);
    expect(useRocStore.getState().reply).toBeNull();
  });

  // The one failure mode this phase exists to prevent is silence: a brain that
  // could not run has to leave a sentence behind for the surfaces to render.
  it("carries a brain error", () => {
    useRocStore.getState().setBrainError("Claude Code CLI not found.");
    expect(useRocStore.getState().brainError).toBe(
      "Claude Code CLI not found.",
    );

    useRocStore.getState().setBrainError(null);
    expect(useRocStore.getState().brainError).toBeNull();
  });

  it("has a speaking phase of its own", () => {
    useRocStore.getState().setPhase("speaking");
    expect(useRocStore.getState().phase).toBe("speaking");
  });
});
