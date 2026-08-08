/** The card's split affordance against the workspace's terminal cap, and the
 *  accent stripe it wears. */

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, renderHook, screen } from "@testing-library/react";

vi.mock("@/lib/bindings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/bindings")>()),
  commands: {
    terminalSpawn: vi.fn(async () => ({ pid: 1, claudeSessionId: null })),
    terminalKill: vi.fn(async () => {}),
    terminalWrite: vi.fn(async () => {}),
    terminalResize: vi.fn(async () => {}),
  },
}));

import { accentVar } from "@/lib/accentColors";
import { newTerminal, newWorkspace } from "@/lib/factories";
import { LIMITS } from "@/lib/limits";
import {
  useCanAddPane,
  useTerminalRuntimeStore,
  useTerminalsStore,
  useUIStore,
  useWorkspacesStore,
} from "@/stores";
import { TerminalCard, paneShadow } from "@/views/RocDock/TerminalCard";
import type { WorkspaceAccent } from "@/lib/bindings";

beforeAll(() => {
  // Mounting a real xterm in jsdom needs two browser APIs it does not ship.
  window.matchMedia ??= ((query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

/** A workspace holding `count` sessions. Returns the workspace id and the id
 *  of the session the card under test renders. */
function seed(count: number, accent: WorkspaceAccent = "violet") {
  const workspace = newWorkspace({
    name: "W",
    projectPath: "/tmp/proj",
    order: 0,
    accent,
  });
  const sessions = Array.from({ length: count }, (_, i) =>
    newTerminal({
      workspaceId: workspace.id,
      name: `T${i}`,
      agentType: "shell",
      projectPath: "/tmp/proj",
    }),
  );
  useWorkspacesStore.setState({
    workspaces: [
      { ...workspace, paneTree: { kind: "leaf", terminalId: sessions[0]!.id } },
    ],
    activeWorkspaceId: workspace.id,
  });
  useTerminalsStore.getState().setTerminals(sessions);
  return { workspaceId: workspace.id, first: sessions[0]!.id };
}

const addSession = (workspaceId: string) =>
  useTerminalsStore.getState().addTerminal(
    newTerminal({
      workspaceId,
      name: "extra",
      agentType: "shell",
      projectPath: "/tmp/proj",
    }),
  );

beforeEach(() => {
  useWorkspacesStore.setState({ workspaces: [], activeWorkspaceId: null });
  useTerminalsStore.setState({ byId: {} });
  useTerminalRuntimeStore.setState({ hasUserInput: {}, turnFinished: {} });
  useUIStore.setState({ focusedTerminalId: null, maximizedTerminalId: null });
});

describe("useCanAddPane", () => {
  // The card used to call a plain `canAddPane()` during render, which is only
  // as fresh as whatever else happened to re-render it. A selector makes the
  // cap a subscription instead of a coincidence.
  it("flips as the workspace fills up", () => {
    const { workspaceId } = seed(LIMITS.terminalsPerWorkspace - 1);
    const { result } = renderHook(() => useCanAddPane(workspaceId));
    expect(result.current).toBe(true);

    act(() => addSession(workspaceId));

    expect(result.current).toBe(false);
  });

  it("counts only the workspace asked about", () => {
    const { workspaceId } = seed(LIMITS.terminalsPerWorkspace);
    const { result } = renderHook(() => useCanAddPane("some-other-workspace"));
    expect(result.current).toBe(true);
    expect(renderHook(() => useCanAddPane(workspaceId)).result.current).toBe(
      false,
    );
  });

  it("says no when there is no workspace", () => {
    expect(renderHook(() => useCanAddPane(null)).result.current).toBe(false);
  });
});

describe("paneShadow", () => {
  // The workspace accent, as a theme variable — what `accentVar` hands the card.
  const STRIPE = accentVar("green");

  it("draws the focus ring even when the pane wears a stripe", () => {
    // The bug: the ring lived in a `shadow-[…]` class while the stripe was set
    // inline, and an inline `boxShadow` replaces the property outright. Every
    // pane has a stripe, so the ring was dead everywhere.
    const shadow = paneShadow({
      isFocused: true,
      accentColor: STRIPE,
      isReady: false,
    });

    expect(shadow).toContain(STRIPE);
    expect(shadow).toContain("var(--rs-primary)");
  });

  it("puts the accent stripe in front of the ring", () => {
    // Paint order is declaration order, so the left edge keeps saying which
    // workspace the pane is in even while it holds focus.
    const shadow = paneShadow({
      isFocused: true,
      accentColor: STRIPE,
      isReady: false,
    })!;

    expect(shadow.indexOf(STRIPE)).toBeLessThan(
      shadow.indexOf("var(--rs-primary)"),
    );
  });

  it("stacks the ready glow with both", () => {
    const shadow = paneShadow({
      isFocused: true,
      accentColor: STRIPE,
      isReady: true,
    })!;

    expect(shadow).toContain(STRIPE);
    expect(shadow).toContain("var(--rs-primary)");
    expect(shadow).toContain("var(--ready-glow");
  });

  it("keeps every part inset, because an outer shadow clips at the gutter", () => {
    const shadow = paneShadow({
      isFocused: true,
      accentColor: STRIPE,
      isReady: true,
    })!;

    for (const part of shadowParts(shadow)) {
      expect(part.trim().startsWith("inset")).toBe(true);
    }
  });

  /** Split on the commas *between* shadows — `color-mix()` is full of the
   *  other kind. */
  function shadowParts(shadow: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let current = "";
    for (const ch of shadow) {
      if (ch === "(") depth++;
      if (ch === ")") depth--;
      if (ch === "," && depth === 0) {
        parts.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
    parts.push(current);
    return parts;
  }

  it("is nothing at all when there is nothing to draw", () => {
    expect(
      paneShadow({ isFocused: false, accentColor: null, isReady: false }),
    ).toBeUndefined();
  });
});

describe("the card's stripe", () => {
  it("is the active workspace's accent", () => {
    // Group colours retired with groups; what the stripe says now is which
    // project the pane belongs to.
    const { first } = seed(1, "amber");

    const { container } = render(<TerminalCard terminalId={first} />);

    const card = container.querySelector<HTMLElement>(
      `[data-terminal-id="${first}"]`,
    )!;
    expect(card.style.boxShadow).toContain(accentVar("amber"));
  });

  it("follows a recolour of the workspace", () => {
    const { workspaceId, first } = seed(1, "amber");
    const { container } = render(<TerminalCard terminalId={first} />);
    const card = () =>
      container.querySelector<HTMLElement>(`[data-terminal-id="${first}"]`)!;

    act(() =>
      useWorkspacesStore.getState().setWorkspaceAccent(workspaceId, "rose"),
    );

    expect(card().style.boxShadow).toContain(accentVar("rose"));
    expect(card().style.boxShadow).not.toContain(accentVar("amber"));
  });
});

describe("the ready glow", () => {
  const card = (container: HTMLElement, id: string) =>
    container.querySelector<HTMLElement>(`[data-terminal-id="${id}"]`)!;

  it("lights up when the agent ended a turn you were not watching", () => {
    // The signal Phase 3 removed. `idle` is a resting state — the status alone
    // cannot say whether anything happened — so the glow reads the flag the
    // bridge sets when a turn ends on a pane nobody is looking at.
    const { first } = seed(1);
    const { container } = render(<TerminalCard terminalId={first} />);
    expect(card(container, first).style.boxShadow).not.toContain(
      "var(--ready-glow",
    );

    act(() => useTerminalRuntimeStore.getState().markTurnFinished(first));

    expect(card(container, first).style.boxShadow).toContain(
      "var(--ready-glow",
    );
    expect(card(container, first).className).toContain("terminal-ready-pulse");
  });

  it("goes out when the flag is cleared", () => {
    const { first } = seed(1);
    useTerminalRuntimeStore.getState().markTurnFinished(first);
    const { container } = render(<TerminalCard terminalId={first} />);

    act(() => useTerminalRuntimeStore.getState().clearTurnFinished(first));

    expect(card(container, first).style.boxShadow).not.toContain(
      "var(--ready-glow",
    );
  });

  it("still needs the user to have typed before a status lights the pane", () => {
    // Unchanged: a freshly spawned pane whose CLI exits before anyone has
    // touched it must not light up green.
    const { first } = seed(1);
    act(() => useTerminalsStore.getState().setStatus(first, "complete"));
    const { container } = render(<TerminalCard terminalId={first} />);
    expect(card(container, first).style.boxShadow).not.toContain(
      "var(--ready-glow",
    );

    act(() => useTerminalRuntimeStore.getState().notifyUserInput(first));

    expect(card(container, first).style.boxShadow).toContain(
      "var(--ready-glow",
    );
  });
});

describe("TerminalCard split buttons", () => {
  const splitButtons = () =>
    screen.getAllByRole("button", { name: /Split |Workspace cap reached/ });

  it("offers both splits below the cap", () => {
    const { first } = seed(2);

    render(<TerminalCard terminalId={first} />);

    const buttons = splitButtons();
    expect(buttons).toHaveLength(2);
    for (const button of buttons) expect(button).toBeEnabled();
  });

  it("disables them at the workspace cap, and says why", () => {
    const { first } = seed(LIMITS.terminalsPerWorkspace);

    render(<TerminalCard terminalId={first} />);

    const buttons = splitButtons();
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      expect(button).toBeDisabled();
      // The reason lives in the tooltip. It used to be the accessible NAME,
      // which left both buttons announcing the same sentence and neither
      // saying which direction it splits — see below.
      expect(button).toHaveAttribute(
        "title",
        `Workspace cap reached (${LIMITS.terminalsPerWorkspace})`,
      );
    }
  });

  it("keeps the two split buttons tellable apart at the cap", () => {
    const { first } = seed(LIMITS.terminalsPerWorkspace);

    render(<TerminalCard terminalId={first} />);

    expect(
      screen.getByRole("button", { name: "Split right" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Split down" }),
    ).toBeInTheDocument();
  });

  it("disables them the moment the cap is reached", () => {
    const { workspaceId, first } = seed(LIMITS.terminalsPerWorkspace - 1);
    render(<TerminalCard terminalId={first} />);
    for (const button of splitButtons()) expect(button).toBeEnabled();

    act(() => addSession(workspaceId));

    for (const button of splitButtons()) expect(button).toBeDisabled();
  });
});
