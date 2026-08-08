import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";

/** TerminalCard mounts a real xterm — heavy, and beside the point here. These
 *  tests are about the shape the tree renders, so a stub that names its
 *  terminal is exactly the surface worth asserting on. */
vi.mock("@/views/RocDock/TerminalCard", () => ({
  TerminalCard: ({ terminalId }: { terminalId: string }) => (
    <div data-testid="terminal-card">{terminalId}</div>
  ),
}));

import { buildBalancedTree, type PaneNode } from "@/lib/paneTree";
import { newWorkspace } from "@/lib/factories";
import { useUIStore, useWorkspacesStore } from "@/stores";
import { PaneTree } from "@/views/RocDock/PaneTree";

beforeAll(() => {
  // react-resizable-panels measures with ResizeObserver, which jsdom does not
  // implement. The panels still render (and still expose their separators);
  // only the pixel math is inert.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

function mountWorkspace(paneTree: PaneNode | null) {
  const workspace = {
    ...newWorkspace({ name: "W", projectPath: "/tmp/proj", order: 0 }),
    paneTree,
  };
  useWorkspacesStore.setState({
    workspaces: [workspace],
    activeWorkspaceId: workspace.id,
  });
  return workspace;
}

describe("PaneTree", () => {
  beforeEach(() => {
    useWorkspacesStore.setState({ workspaces: [], activeWorkspaceId: null });
    useUIStore.setState({ maximizedTerminalId: null, focusedTerminalId: null });
  });

  it("renders one card per leaf and one separator per split", () => {
    mountWorkspace(buildBalancedTree(["a", "b", "c"]));

    render(<PaneTree />);

    expect(
      screen.getAllByTestId("terminal-card").map((el) => el.textContent),
    ).toEqual(["a", "b", "c"]);
    // Three leaves need two splits, and every split draws a divider.
    expect(screen.getAllByRole("separator")).toHaveLength(2);
  });

  it("orients each group by its split direction", () => {
    // `column` = stacked, so the group must lay its panels out top-to-bottom.
    // Getting this backwards is the kind of thing that looks fine in a 2-pane
    // screenshot and wrong everywhere else.
    mountWorkspace({
      kind: "split",
      direction: "column",
      ratio: 0.5,
      first: { kind: "leaf", terminalId: "a" },
      second: {
        kind: "split",
        direction: "row",
        ratio: 0.5,
        first: { kind: "leaf", terminalId: "b" },
        second: { kind: "leaf", terminalId: "c" },
      },
    });

    const { container } = render(<PaneTree />);

    const groups = [...container.querySelectorAll<HTMLElement>("[data-group]")];
    expect(groups.map((g) => g.style.flexDirection)).toEqual(["column", "row"]);
    expect(
      [...container.querySelectorAll("[role=separator]")].map((s) =>
        s.getAttribute("aria-orientation"),
      ),
      // The divider's own orientation is the line, not the split axis: a
      // stacked (`column`) split draws a horizontal rule.
    ).toEqual(["horizontal", "vertical"]);
  });

  it("sizes each arm from its split ratio", () => {
    mountWorkspace({
      kind: "split",
      direction: "row",
      ratio: 0.7,
      first: { kind: "leaf", terminalId: "a" },
      second: { kind: "leaf", terminalId: "b" },
    });

    const { container } = render(<PaneTree />);

    const panels = [...container.querySelectorAll<HTMLElement>("[data-panel]")];
    expect(panels.map((p) => p.style.flexGrow)).toEqual(["70", "30"]);
  });

  it("lights the divider when it takes keyboard focus", () => {
    // The separator is focusable and resizable from the keyboard. Styling only
    // hover and drag left that path with no affordance at all: tab to a
    // divider and nothing on screen says you are on one.
    mountWorkspace(buildBalancedTree(["a", "b"]));
    const { container } = render(<PaneTree />);
    const separator = container.querySelector<HTMLElement>("[role=separator]")!;

    act(() => separator.focus());

    // Asserted against the library's own state name, so an upstream rename
    // trips here rather than silently going dark again.
    expect(separator.getAttribute("data-separator")).toBe("focus");
    expect(separator.className).toContain(
      "data-[separator=focus]:bg-border-active",
    );
  });

  it("renders only the maximized leaf, with no dividers", () => {
    mountWorkspace(buildBalancedTree(["a", "b", "c"]));
    useUIStore.setState({ maximizedTerminalId: "b" });

    render(<PaneTree />);

    expect(
      screen.getAllByTestId("terminal-card").map((el) => el.textContent),
    ).toEqual(["b"]);
    expect(screen.queryAllByRole("separator")).toHaveLength(0);
  });

  it("keeps the dock's inset live in both the tree and maximized", () => {
    // The inset used to be inert for the tree and live for maximize: an
    // absolutely positioned child covers its parent's padding, so the tree
    // painted edge to edge while the maximized pane sat 6px in. Toggling focus
    // mode visibly jumped the terminal. The invariant is that whatever fills
    // the padded box is in normal flow, in both modes.
    mountWorkspace(buildBalancedTree(["a", "b"]));
    const { container, rerender } = render(<PaneTree />);
    const dock = () => container.querySelector<HTMLElement>(".p-1\\.5")!;

    const treeDock = dock();
    expect(treeDock.firstElementChild?.className).not.toMatch(/\babsolute\b/);
    const treeClasses = treeDock.className;

    useUIStore.setState({ maximizedTerminalId: "a" });
    rerender(<PaneTree />);

    expect(dock().className).toBe(treeClasses);
    expect(dock().firstElementChild?.className).not.toMatch(/\babsolute\b/);
  });

  it("separates panes by the divider alone, with no padding around a leaf", () => {
    // The specified gutter is the 2px separator. Padding each leaf as well
    // made the visible gap 6px — the two 2px insets plus the divider.
    mountWorkspace(buildBalancedTree(["a", "b"]));

    const { container } = render(<PaneTree />);

    const slots = [
      ...container.querySelectorAll<HTMLElement>("[data-pane-slot]"),
    ];
    expect(slots).toHaveLength(2);
    for (const slot of slots) {
      expect(slot.className).not.toMatch(/(^|\s)p-/);
    }
  });

  it("falls back to the full tree when the maximized terminal is gone", () => {
    // Closing a maximized pane clears the tree entry before the UI flag; the
    // dock must not go blank in between.
    mountWorkspace(buildBalancedTree(["a", "b"]));
    useUIStore.setState({ maximizedTerminalId: "closed-already" });

    render(<PaneTree />);

    expect(screen.getAllByTestId("terminal-card")).toHaveLength(2);
  });

  it("renders the stored ratio after a reshape promotes a subtree", () => {
    // `row(a, row(b,c))`: closing `a` promotes the inner split into the root's
    // position, and the root group survives that as a React instance. The store
    // is the authority for ratios, so the panes must land at 30/70 rather than
    // keeping the 70/30 the group was showing for the old node.
    //
    // Note this covers the store→DOM direction only. jsdom never measures, so
    // the group has no cached measured layout to go stale, and it re-derives
    // from `defaultLayout` here on its own. The imperative correction in
    // `SplitPane` is what holds this up in a real browser, where a group that
    // has been dragged does have one — and there is no way to reach that state
    // without a layout engine.
    const workspace = mountWorkspace({
      kind: "split",
      direction: "row",
      ratio: 0.7,
      first: { kind: "leaf", terminalId: "a" },
      second: {
        kind: "split",
        direction: "row",
        ratio: 0.3,
        first: { kind: "leaf", terminalId: "b" },
        second: { kind: "leaf", terminalId: "c" },
      },
    });

    const { container, rerender } = render(<PaneTree />);
    const rootPanels = () =>
      [
        ...container.querySelectorAll<HTMLElement>(
          "[data-group=true] > [data-panel]",
        ),
      ].slice(0, 2);
    expect(rootPanels().map((p) => p.style.flexGrow)).toEqual(["70", "30"]);

    useWorkspacesStore.getState().removeTerminalPane(workspace.id, "a");
    rerender(<PaneTree />);

    expect(
      screen.getAllByTestId("terminal-card").map((el) => el.textContent),
    ).toEqual(["b", "c"]);
    expect(rootPanels().map((p) => p.style.flexGrow)).toEqual(["30", "70"]);
  });

  it("prompts instead of rendering an empty dock when a workspace has no panes", () => {
    mountWorkspace(null);

    render(<PaneTree />);

    expect(screen.queryAllByTestId("terminal-card")).toHaveLength(0);
    expect(
      screen.getByText(/No terminals in this workspace yet/),
    ).toBeVisible();
  });

  it("says so when there is no workspace at all", () => {
    render(<PaneTree />);
    expect(screen.getByText("No active workspace")).toBeVisible();
  });
});
