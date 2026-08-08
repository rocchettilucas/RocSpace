/** The pane header: what it says, and what its controls do. */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const PROJECT = "/Users/roc/code/rocspace";
/** What Rust resolves `PROJECT` to. Deliberately NOT the same string: the
 *  watch is keyed on the repository root, and a pane's cwd is very often a
 *  directory inside one rather than the root itself. Matching events by the
 *  path a pane asked about would silently work if these were equal. */
const REPO_ROOT = "/Users/roc/code";

const { commandMocks, listeners } = vi.hoisted(() => ({
  commandMocks: {
    terminalSpawn: vi.fn(async () => ({ pid: 1, claudeSessionId: null })),
    terminalKill: vi.fn(async () => {}),
    terminalWrite: vi.fn(async () => {}),
    terminalResize: vi.fn(async () => {}),
    // Kept mocked though the header no longer calls it — asserting that is
    // the point of one of the tests below.
    gitBranch: vi.fn(async (_path: string): Promise<string | null> => null),
    gitWatch: vi.fn(
      async (
        _path: string,
      ): Promise<{ root: string; branch: string | null }> => ({
        root: "/Users/roc/code",
        branch: null,
      }),
    ),
    gitUnwatch: vi.fn(async (_root: string) => {}),
  },
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
}));

vi.mock("@/lib/bindings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/bindings")>()),
  commands: commandMocks,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(
    async (name: string, handler: (e: { payload: unknown }) => void) => {
      listeners.set(name, handler);
      return () => listeners.delete(name);
    },
  ),
}));

import { EVENT_GIT_BRANCH } from "@/lib/bindings";
import { newTerminal, newWorkspace } from "@/lib/factories";
import { LIMITS } from "@/lib/limits";
import { leafIds } from "@/lib/paneTree";
import { useTerminalsStore, useUIStore, useWorkspacesStore } from "@/stores";
import { PaneHeader } from "@/views/RocDock/PaneHeader";

/** One workspace holding one session, with a tree over it. */
function seed(overrides: Partial<Parameters<typeof newTerminal>[0]> = {}) {
  const workspace = newWorkspace({ projectPath: PROJECT, order: 0 });
  const session = newTerminal({
    workspaceId: workspace.id,
    name: "Rocky",
    agentType: "claude-code",
    projectPath: PROJECT,
    ...overrides,
  });
  useWorkspacesStore.setState({
    workspaces: [
      { ...workspace, paneTree: { kind: "leaf", terminalId: session.id } },
    ],
    activeWorkspaceId: workspace.id,
  });
  useTerminalsStore.getState().setTerminals([session]);
  return session;
}

/** Render the header for the workspace's one session. Awaited so the effects
 *  that talk to Rust (branch lookup, watch registration) have settled. */
async function mount(session = seed(), focused = false, maximized = false) {
  const view = render(
    <PaneHeader
      terminal={useTerminalsStore.getState().byId[session.id]!}
      isFocused={focused}
      isMaximized={maximized}
    />,
  );
  await act(async () => {});
  return { ...view, session };
}

const nameOf = (id: string) => useTerminalsStore.getState().byId[id]?.name;
const title = () => screen.getByTitle(/double-click to rename/);

/** jsdom does no layout, so the header's width can only come from here.
 *
 *  Deliberately silent until a test calls `resizeTo`: an observer that never
 *  reports leaves the header unmeasured, which is the "assume it is roomy"
 *  path every other test in this file wants. */
const observers = new Set<{ el: Element; cb: ResizeObserverCallback }>();

class TestResizeObserver implements ResizeObserver {
  constructor(private cb: ResizeObserverCallback) {}
  observe(el: Element) {
    observers.add({ el, cb: this.cb });
  }
  unobserve() {}
  disconnect() {
    for (const o of observers) if (o.cb === this.cb) observers.delete(o);
  }
}

vi.stubGlobal("ResizeObserver", TestResizeObserver);

/** Tell every live observer its element's CONTENT box is `width` px wide —
 *  the box `ResizeObserver` reports and the one the header's thresholds are
 *  written against. */
function resizeTo(width: number) {
  act(() => {
    for (const { el, cb } of observers) {
      cb(
        [
          {
            target: el,
            contentRect: { width } as DOMRectReadOnly,
          } as ResizeObserverEntry,
        ],
        {} as ResizeObserver,
      );
    }
  });
}

beforeEach(() => {
  listeners.clear();
  observers.clear();
  vi.clearAllMocks();
  commandMocks.gitWatch.mockResolvedValue({ root: REPO_ROOT, branch: null });
  useWorkspacesStore.setState({ workspaces: [], activeWorkspaceId: null });
  useTerminalsStore.setState({ byId: {} });
  useUIStore.setState({ focusedTerminalId: null, maximizedTerminalId: null });
});

describe("what the header says", () => {
  it("names the pane, its agent and its directory", async () => {
    await mount();

    expect(screen.getByText("Rocky")).toBeInTheDocument();
    expect(screen.getByText("Claude")).toBeInTheDocument();
    // The directory, not the road to it.
    expect(screen.getByText("rocspace")).toBeInTheDocument();
  });

  it("labels the status dot rather than leaving it a coloured circle", async () => {
    const session = seed();
    act(() => useTerminalsStore.getState().setStatus(session.id, "running"));
    await mount(session);

    expect(screen.getByLabelText("Status: Running")).toBeInTheDocument();
  });

  it("follows the session's status", async () => {
    const session = seed();
    act(() =>
      useTerminalsStore.getState().setStatus(session.id, "awaiting_approval"),
    );
    await mount(session);

    expect(
      screen.getByLabelText("Status: Awaiting approval"),
    ).toBeInTheDocument();
  });

  it("says the name is a rename control, not just a name", async () => {
    // Announced as bare "Rocky", the control says what it holds and nothing
    // about being pressable or about what pressing it does.
    await mount();

    expect(
      screen.getByRole("button", { name: "Rename pane (currently Rocky)" }),
    ).toBeInTheDocument();
  });

  it("says the branch chip is a branch", async () => {
    // The icon that makes this a branch is decorative, so an unlabelled chip
    // is announced as the bare word "main" — which could be anything.
    commandMocks.gitWatch.mockResolvedValue({
      root: REPO_ROOT,
      branch: "main",
    });
    await mount();

    expect(screen.getByLabelText("On branch main")).toBeInTheDocument();
  });
});

describe("what the header gives up when it runs out of room", () => {
  // The order matters more than the exact pixel it happens at: the pane's NAME
  // used to be the first casualty and the Close button the last, because the
  // name was the only thing in the header allowed to shrink.
  const name = () => screen.queryByText("Rocky");
  const badge = () => screen.queryByText("Claude");
  const cwd = () => screen.queryByText("rocspace");
  const chip = () => screen.queryByLabelText(/^On branch/);
  const close = () => screen.queryByRole("button", { name: "Close" });

  beforeEach(() =>
    commandMocks.gitWatch.mockResolvedValue({
      root: REPO_ROOT,
      branch: "main",
    }),
  );

  it("shows everything when there is room", async () => {
    await mount();
    resizeTo(600);

    for (const part of [name(), badge(), cwd(), chip(), close()]) {
      expect(part).toBeInTheDocument();
    }
  });

  it("drops the branch chip first", async () => {
    await mount();
    resizeTo(350);

    expect(chip()).toBeNull();
    expect(name()).toBeInTheDocument();
    expect(cwd()).toBeInTheDocument();
    expect(badge()).toBeInTheDocument();
  });

  it("drops the directory next", async () => {
    await mount();
    resizeTo(280);

    expect(chip()).toBeNull();
    expect(cwd()).toBeNull();
    expect(name()).toBeInTheDocument();
    expect(badge()).toBeInTheDocument();
  });

  it("drops the agent badge last, and never the name", async () => {
    await mount();
    resizeTo(220);

    expect(badge()).toBeNull();
    expect(name()).toBeInTheDocument();
  });

  it("keeps the name and every action at a 4-across width", async () => {
    // ~250px is what four panes across a typical dock get. The name is what
    // the user calls the pane and the actions are how they reshape it; both
    // survive, and the pieces the pane's own body can tell them are the ones
    // that leave.
    await mount();
    resizeTo(250);

    expect(name()).toBeInTheDocument();
    expect(close()).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Split right" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Restart" })).toBeVisible();
  });

  it("puts everything back when the pane widens again", async () => {
    await mount();
    resizeTo(220);
    expect(chip()).toBeNull();

    resizeTo(600);

    expect(chip()).toBeInTheDocument();
    expect(cwd()).toBeInTheDocument();
    expect(badge()).toBeInTheDocument();
  });
});

describe("rename", () => {
  it("commits a double-click rename on Enter", async () => {
    const { session } = await mount();

    fireEvent.doubleClick(title());
    const field = screen.getByLabelText("Pane name");
    fireEvent.change(field, { target: { value: "Roxie" } });
    fireEvent.keyDown(field, { key: "Enter" });

    expect(nameOf(session.id)).toBe("Roxie");
  });

  it("is reachable from the keyboard too", async () => {
    const { session } = await mount();

    fireEvent.keyDown(title(), { key: "Enter" });
    const field = screen.getByLabelText("Pane name");
    fireEvent.change(field, { target: { value: "Sprocket" } });
    fireEvent.keyDown(field, { key: "Enter" });

    expect(nameOf(session.id)).toBe("Sprocket");
  });

  it("leaves the name alone on Escape", async () => {
    const { session } = await mount();

    fireEvent.doubleClick(title());
    const field = screen.getByLabelText("Pane name");
    fireEvent.change(field, { target: { value: "discarded" } });
    fireEvent.keyDown(field, { key: "Escape" });

    expect(nameOf(session.id)).toBe("Rocky");
    expect(screen.queryByLabelText("Pane name")).toBeNull();
  });

  it("commits when focus leaves the field", async () => {
    const { session } = await mount();

    fireEvent.doubleClick(title());
    const field = screen.getByLabelText("Pane name");
    fireEvent.change(field, { target: { value: "Rocco" } });
    fireEvent.blur(field);

    expect(nameOf(session.id)).toBe("Rocco");
  });

  it("treats an empty name as a cancel — a pane must stay addressable", async () => {
    const { session } = await mount();

    fireEvent.doubleClick(title());
    const field = screen.getByLabelText("Pane name");
    fireEvent.change(field, { target: { value: "   " } });
    fireEvent.keyDown(field, { key: "Enter" });

    expect(nameOf(session.id)).toBe("Rocky");
  });

  it("commits a click-away rename that follows an Enter rename", async () => {
    // The editor is opened and closed many times over a pane's life, and each
    // opening has to start from the same state. When Enter's "a key already
    // decided this" flag survived into the next editor, the next click-away
    // rename was swallowed by it — silently, and forever after, alternating.
    const { session } = await mount();

    fireEvent.doubleClick(title());
    const first = screen.getByLabelText("Pane name");
    fireEvent.change(first, { target: { value: "Roxie" } });
    fireEvent.keyDown(first, { key: "Enter" });
    expect(nameOf(session.id)).toBe("Roxie");

    fireEvent.doubleClick(title());
    const second = screen.getByLabelText("Pane name");
    fireEvent.change(second, { target: { value: "Rocco" } });
    fireEvent.blur(second);

    expect(nameOf(session.id)).toBe("Rocco");
  });

  it("commits a click-away rename that follows an Escape", async () => {
    const { session } = await mount();

    fireEvent.doubleClick(title());
    const first = screen.getByLabelText("Pane name");
    fireEvent.change(first, { target: { value: "discarded" } });
    fireEvent.keyDown(first, { key: "Escape" });
    expect(nameOf(session.id)).toBe("Rocky");

    fireEvent.doubleClick(title());
    const second = screen.getByLabelText("Pane name");
    fireEvent.change(second, { target: { value: "Rocket" } });
    fireEvent.blur(second);

    expect(nameOf(session.id)).toBe("Rocket");
  });

  it("disambiguates a name a sibling pane already answers to", async () => {
    // A name is the user's handle for a pane, so two panes holding one is the
    // same ambiguity `defaultPaneName` exists to prevent — a rename is just the
    // other road to it. The word they typed survives; the number is added.
    const { session } = await mount();
    const workspaceId = session.workspaceId;
    act(() =>
      useTerminalsStore.getState().addTerminal(
        newTerminal({
          workspaceId,
          name: "Roxie",
          agentType: "claude-code",
          projectPath: PROJECT,
        }),
      ),
    );

    fireEvent.doubleClick(title());
    const field = screen.getByLabelText("Pane name");
    fireEvent.change(field, { target: { value: "Roxie" } });
    fireEvent.keyDown(field, { key: "Enter" });

    expect(nameOf(session.id)).toBe("Roxie 2");
  });

  it("does not renumber a pane re-committing its own name", async () => {
    const { session } = await mount();

    fireEvent.doubleClick(title());
    const field = screen.getByLabelText("Pane name");
    fireEvent.change(field, { target: { value: "Rocky" } });
    fireEvent.keyDown(field, { key: "Enter" });

    expect(nameOf(session.id)).toBe("Rocky");
  });

  it("keeps the keystroke to itself so the pane chords stay quiet", async () => {
    await mount();
    const bubbled = vi.fn();
    document.addEventListener("keydown", bubbled);

    fireEvent.doubleClick(title());
    fireEvent.keyDown(screen.getByLabelText("Pane name"), { key: "w" });

    expect(bubbled).not.toHaveBeenCalled();
    document.removeEventListener("keydown", bubbled);
  });
});

describe("branch chip", () => {
  it("stays away when the directory is not a repository", async () => {
    await mount();

    expect(commandMocks.gitWatch).toHaveBeenCalledWith(PROJECT);
    expect(screen.queryByTitle(/^On branch/)).toBeNull();
  });

  it("takes its opening value from the watch that seeded it", async () => {
    // Not from a second command. Two reads of one file is a race the watcher
    // cannot recover from: it only speaks when its own baseline moves, so a
    // checkout landing between the two would strand the chip on the older
    // read for as long as the pane stayed open.
    await mount();

    expect(commandMocks.gitBranch).not.toHaveBeenCalled();
  });

  it("shows the branch the directory is on", async () => {
    commandMocks.gitWatch.mockResolvedValue({
      root: REPO_ROOT,
      branch: "revamp/phase-1b-chrome",
    });

    await mount();

    expect(
      screen.getByTitle("On branch revamp/phase-1b-chrome"),
    ).toBeInTheDocument();
  });

  it("follows a checkout announced by Rust", async () => {
    commandMocks.gitWatch.mockResolvedValue({
      root: REPO_ROOT,
      branch: "main",
    });
    await mount();

    act(() =>
      listeners.get(EVENT_GIT_BRANCH)!({
        payload: { root: REPO_ROOT, branch: "feature" },
      }),
    );

    await waitFor(() =>
      expect(screen.getByTitle("On branch feature")).toBeInTheDocument(),
    );
    expect(screen.queryByTitle("On branch main")).toBeNull();
  });

  it("ignores a checkout in somebody else's directory", async () => {
    commandMocks.gitWatch.mockResolvedValue({
      root: REPO_ROOT,
      branch: "main",
    });
    await mount();

    act(() =>
      listeners.get(EVENT_GIT_BRANCH)!({
        payload: { root: "/somewhere/else", branch: "feature" },
      }),
    );

    expect(screen.getByTitle("On branch main")).toBeInTheDocument();
  });

  it("watches the directory while the pane is open, and lets go after", async () => {
    const { unmount } = await mount();
    // Asked about the pane's own path…
    expect(commandMocks.gitWatch).toHaveBeenCalledWith(PROJECT);

    unmount();

    // …and released by the root that came back, which is what the reference
    // count is actually keyed on.
    await waitFor(() =>
      expect(commandMocks.gitUnwatch).toHaveBeenCalledWith(REPO_ROOT),
    );
  });

  it("lets go even when the pane closes before the watch lands", async () => {
    // A pane opened and closed faster than the IPC round trip — a split
    // undone, a workspace switched twice. The reference exists by the time the
    // call returns, so not releasing it leaks a watch nothing will ever close.
    let land: (h: { root: string; branch: string | null }) => void = () => {};
    commandMocks.gitWatch.mockReturnValueOnce(
      new Promise<{ root: string; branch: string | null }>((resolve) => {
        land = resolve;
      }),
    );

    const session = seed();
    const { unmount } = render(
      <PaneHeader
        terminal={useTerminalsStore.getState().byId[session.id]!}
        isFocused={false}
        isMaximized={false}
      />,
    );
    unmount();
    expect(commandMocks.gitUnwatch).not.toHaveBeenCalled();

    await act(async () => land({ root: REPO_ROOT, branch: null }));

    await waitFor(() =>
      expect(commandMocks.gitUnwatch).toHaveBeenCalledWith(REPO_ROOT),
    );
  });
});

describe("actions", () => {
  const tree = () => useWorkspacesStore.getState().workspaces[0]!.paneTree!;

  it("splits right", async () => {
    const { session } = await mount();

    fireEvent.click(screen.getByRole("button", { name: "Split right" }));

    expect(leafIds(tree())).toHaveLength(2);
    expect(tree()).toMatchObject({ kind: "split", direction: "row" });
    expect(leafIds(tree())[0]).toBe(session.id);
  });

  it("splits down", async () => {
    await mount();

    fireEvent.click(screen.getByRole("button", { name: "Split down" }));

    expect(tree()).toMatchObject({ kind: "split", direction: "column" });
  });

  it("keeps the split buttons named for what they do at the pane cap", async () => {
    // Both buttons used to be named by their tooltip, so a full workspace left
    // two controls both announcing "Workspace cap reached (16)" — identical,
    // and neither saying which direction it splits. The reason belongs in the
    // tooltip; the name has to stay the action.
    const session = seed();
    const workspaceId = session.workspaceId;
    act(() => {
      for (let i = 1; i < LIMITS.terminalsPerWorkspace; i++) {
        useTerminalsStore.getState().addTerminal(
          newTerminal({
            workspaceId,
            name: `Filler ${i}`,
            agentType: "shell",
            projectPath: PROJECT,
          }),
        );
      }
    });
    await mount(session);

    const right = screen.getByRole("button", { name: "Split right" });
    const down = screen.getByRole("button", { name: "Split down" });
    expect(right).toBeDisabled();
    expect(down).toBeDisabled();
    // …and the reason is still reachable, just not as the name.
    expect(right).toHaveAttribute(
      "title",
      `Workspace cap reached (${LIMITS.terminalsPerWorkspace})`,
    );
  });

  it("maximizes and un-maximizes", async () => {
    const { session } = await mount();

    fireEvent.click(
      screen.getByRole("button", { name: "Focus this terminal" }),
    );

    expect(useUIStore.getState().maximizedTerminalId).toBe(session.id);
  });

  it("offers the way back out while maximized", async () => {
    const session = seed();
    await mount(session, false, true);

    expect(
      screen.getByRole("button", { name: "Exit focus mode" }),
    ).toBeInTheDocument();
  });

  it("restarts the agent", async () => {
    const { session } = await mount();

    fireEvent.click(screen.getByRole("button", { name: "Restart" }));

    await waitFor(() =>
      expect(commandMocks.terminalSpawn).toHaveBeenCalledWith(
        session.id,
        expect.objectContaining({ type: "claude-code" }),
        PROJECT,
        // Restart is a fresh start, not a resume — the button means "run this
        // again", and the pane's own restart affordance is not where a
        // conversation is picked back up.
        null,
        // Restart carries the pane's measured size so the PTY is born at the
        // width the agent will draw into. Null here because jsdom registers no
        // real xterm — in the app these are the live terminal's cols and rows.
        null,
        null,
      ),
    );
  });

  it("closes the pane", async () => {
    const { session } = await mount();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(commandMocks.terminalKill).toHaveBeenCalledWith(session.id);
    expect(useTerminalsStore.getState().byId[session.id]).toBeUndefined();
  });

  it("keeps its clicks out of the card around it", async () => {
    // The card focuses its terminal on click and the buttons sit inside it, so
    // pressing Close would otherwise also be a request to focus the pane being
    // closed.
    const session = seed();
    const onCardClick = vi.fn();
    render(
      <div onClick={onCardClick}>
        <PaneHeader
          terminal={useTerminalsStore.getState().byId[session.id]!}
          isFocused={false}
          isMaximized={false}
        />
      </div>,
    );
    await act(async () => {});

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(onCardClick).not.toHaveBeenCalled();
    expect(useTerminalsStore.getState().byId[session.id]).toBeUndefined();
  });
});
