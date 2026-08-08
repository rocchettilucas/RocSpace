/** The New Workspace modal: what it asks, and what it asks the store for. */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

const { openDialog } = vi.hoisted(() => ({
  openDialog: vi.fn(async (): Promise<string | null> => null),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: openDialog }));

/** A stand-in for `lib/recents`, whose real implementation is 2A-model's and
 *  arrives at merge. What the modal owes it is the contract, not the storage:
 *  read the list when it opens, read it again after a forget, remember the
 *  directory it just created in. */
const { recents } = vi.hoisted(() => {
  let list: { path: string; lastOpenedAt: number }[] = [];
  return {
    recents: {
      getRecents: vi.fn(() => list),
      rememberRecent: vi.fn((path: string) => {
        list = [
          { path, lastOpenedAt: Date.now() },
          ...list.filter((r) => r.path !== path),
        ];
      }),
      forgetRecent: vi.fn((path: string) => {
        list = list.filter((r) => r.path !== path);
      }),
      /** Seed in the order the module would hand them back: newest first. */
      set: (...paths: string[]) => {
        list = paths.map((path, i) => ({ path, lastOpenedAt: 100 - i }));
      },
    },
  };
});

vi.mock("@/lib/recents", () => ({
  MAX_RECENTS: 8,
  getRecents: recents.getRecents,
  rememberRecent: recents.rememberRecent,
  forgetRecent: recents.forgetRecent,
}));

import { useSettingsStore, useUIStore, useWorkspacesStore } from "@/stores";
import {
  NewWorkspaceDialog,
  NewWorkspaceModal,
} from "@/views/Workspaces/NewWorkspaceModal";

const createWorkspace = vi.fn(() => "ws-1");

const tile = (name: RegExp) => screen.getByRole("radio", { name });
const create = () => screen.getByRole("button", { name: "Create workspace" });

beforeEach(() => {
  vi.clearAllMocks();
  openDialog.mockResolvedValue(null);
  useWorkspacesStore.setState({
    workspaces: [],
    activeWorkspaceId: null,
    createWorkspace,
  });
  recents.set();
  useUIStore.setState({ isWorkspaceModalOpen: true });
  useSettingsStore.setState({
    agentDefaults: {
      agentType: "claude-code",
      model: null,
      permissionMode: "ask",
    },
  });
});

describe("opening and closing", () => {
  it("renders nothing while the modal is closed", () => {
    useUIStore.setState({ isWorkspaceModalOpen: false });

    render(<NewWorkspaceModal />);

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("moves focus into the dialog on open", () => {
    // Left outside, Escape goes to whatever had the keyboard — a terminal,
    // which swallows it as \x1b — and a screen reader never hears about the
    // dialog that just covered the app.
    render(<NewWorkspaceDialog />);

    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
  });

  it("hands focus back to whatever had it when it closes", () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();

    const { unmount } = render(<NewWorkspaceDialog />);
    unmount();

    expect(trigger).toHaveFocus();
    trigger.remove();
  });

  it("closes on Escape", () => {
    render(<NewWorkspaceDialog />);

    fireEvent.keyDown(document, { key: "Escape" });

    expect(useUIStore.getState().isWorkspaceModalOpen).toBe(false);
  });

  it("leaves Escape to a text field that has the keyboard", () => {
    // Escape in a field means "abandon what I typed", not "throw away every
    // other answer I gave". Nothing in the dialog takes text today; 2B's name
    // prompt reuses this shell, and it does.
    render(<NewWorkspaceDialog />);
    const field = document.createElement("input");
    document.body.appendChild(field);
    field.focus();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(useUIStore.getState().isWorkspaceModalOpen).toBe(true);
    field.remove();
  });

  it("still closes on Escape from a control that is not a text field", () => {
    render(<NewWorkspaceDialog />);
    screen.getByRole("radio", { name: /^2 panes/ }).focus();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(useUIStore.getState().isWorkspaceModalOpen).toBe(false);
  });

  it("closes on a click on the scrim, but not inside the dialog", () => {
    const { container } = render(<NewWorkspaceDialog />);
    const scrim = container.firstElementChild!;

    fireEvent.click(screen.getByRole("dialog"));
    expect(useUIStore.getState().isWorkspaceModalOpen).toBe(true);

    fireEvent.click(scrim);
    expect(useUIStore.getState().isWorkspaceModalOpen).toBe(false);
  });

  it("closes on Cancel without creating anything", () => {
    render(<NewWorkspaceDialog />);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(createWorkspace).not.toHaveBeenCalled();
    expect(useUIStore.getState().isWorkspaceModalOpen).toBe(false);
  });
});

describe("the focus trap", () => {
  const closeButton = () => screen.getByRole("button", { name: "Close" });

  it("wraps Tab from the last control back to the first", () => {
    // `aria-modal` claims the app behind is inert. Untrapped that is a lie to
    // the one input method that can still reach it: Tab walks off the last
    // control into the chrome behind the scrim, where every button is
    // invisible, unreachable by mouse, and still live.
    render(<NewWorkspaceDialog />);
    create().focus();

    fireEvent.keyDown(document, { key: "Tab" });

    expect(closeButton()).toHaveFocus();
  });

  it("wraps Shift-Tab from the first control back to the last", () => {
    render(<NewWorkspaceDialog />);
    closeButton().focus();

    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });

    expect(create()).toHaveFocus();
  });

  it("pulls focus back in when it is somewhere else entirely", () => {
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    render(<NewWorkspaceDialog />);
    outside.focus();

    fireEvent.keyDown(document, { key: "Tab" });

    expect(closeButton()).toHaveFocus();
    outside.remove();
  });

  it("leaves the tab alone in the middle of the dialog", () => {
    // The trap is for the two ends. Claiming every Tab would take the ordering
    // away from the browser, which is the one thing here that always has it
    // right.
    render(<NewWorkspaceDialog />);
    const tile = screen.getByRole("radio", { name: /^2 panes/ });
    tile.focus();

    const event = new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(tile).toHaveFocus();
  });

  it("still says it is modal", () => {
    render(<NewWorkspaceDialog />);

    expect(screen.getByRole("dialog")).toHaveAttribute("aria-modal", "true");
  });
});

describe("templates", () => {
  it("offers 1 / 2 / 4 / 6 / 8, with four selected to begin with", () => {
    render(<NewWorkspaceDialog />);

    expect(screen.getAllByRole("radio")).toHaveLength(5);
    expect(tile(/^4 panes/)).toHaveAttribute("aria-checked", "true");
  });

  it("moves the selection to the tile that was picked", () => {
    render(<NewWorkspaceDialog />);

    fireEvent.click(tile(/^6 panes/));

    expect(tile(/^6 panes/)).toHaveAttribute("aria-checked", "true");
    expect(tile(/^4 panes/)).toHaveAttribute("aria-checked", "false");
  });

  it("says what each layout is, not just how many panes", () => {
    render(<NewWorkspaceDialog />);

    expect(tile(/^1 pane —/)).toBeInTheDocument();
    expect(tile(/2×2 grid layout/)).toBeInTheDocument();
  });
});

describe("directory", () => {
  it("creates without one — a workspace does not need a project", () => {
    render(<NewWorkspaceDialog />);

    fireEvent.click(create());

    expect(createWorkspace).toHaveBeenCalledWith({
      projectPath: null,
      paneCount: 4,
      agentTypes: ["claude-code"],
    });
  });

  it("takes the directory the file dialog returns", async () => {
    openDialog.mockResolvedValue("/code/rocspace");
    render(<NewWorkspaceDialog />);

    fireEvent.click(screen.getByRole("button", { name: /Browse/ }));
    expect(await screen.findByTitle("/code/rocspace")).toBeInTheDocument();

    fireEvent.click(create());

    expect(createWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ projectPath: "/code/rocspace" }),
    );
  });

  it("survives a cancelled file dialog", async () => {
    openDialog.mockResolvedValue(null);
    render(<NewWorkspaceDialog />);

    fireEvent.click(screen.getByRole("button", { name: /Browse/ }));
    await Promise.resolve();

    expect(screen.getByText(/No directory/)).toBeInTheDocument();
  });

  it("lists the recents it is given, in that order, and picks one on click", () => {
    recents.set("/code/new", "/code/old");
    render(<NewWorkspaceDialog />);

    const list = screen.getByRole("list", { name: "Recent directories" });
    expect(
      [...list.querySelectorAll("li")].map((li) => li.textContent),
    ).toEqual(["/code/new", "/code/old"]);

    fireEvent.click(screen.getByRole("button", { name: "/code/old" }));
    fireEvent.click(create());

    expect(createWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ projectPath: "/code/old" }),
    );
  });

  it("reads the list once, when it opens", () => {
    // Not a store, so nothing tells the modal the list changed — and nothing
    // needs to. It is read on open and re-read at the one place that edits it.
    recents.set("/code/a");
    render(<NewWorkspaceDialog />);

    fireEvent.click(screen.getByRole("button", { name: /Agents/ }));

    expect(recents.getRecents).toHaveBeenCalledTimes(1);
  });

  it("forgets a recent on demand, and re-reads the list", () => {
    recents.set("/code/old");
    render(<NewWorkspaceDialog />);

    fireEvent.click(screen.getByRole("button", { name: "Forget /code/old" }));

    expect(recents.forgetRecent).toHaveBeenCalledWith("/code/old");
    expect(
      screen.queryByRole("list", { name: "Recent directories" }),
    ).toBeNull();
  });

  it("remembers the directory it just created a workspace in", () => {
    recents.set("/code/a");
    render(<NewWorkspaceDialog />);

    fireEvent.click(screen.getByRole("button", { name: "/code/a" }));
    fireEvent.click(create());

    expect(recents.rememberRecent).toHaveBeenCalledWith("/code/a");
  });

  it("remembers nothing when no directory was picked", () => {
    render(<NewWorkspaceDialog />);

    fireEvent.click(create());

    expect(recents.rememberRecent).not.toHaveBeenCalled();
  });
});

describe("agents", () => {
  it("starts on the user's default agent, with the section collapsed", () => {
    useSettingsStore.setState({
      agentDefaults: { agentType: "codex", model: null, permissionMode: "ask" },
    });
    render(<NewWorkspaceDialog />);

    expect(screen.getByRole("button", { name: /Agents/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    fireEvent.click(create());

    expect(createWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ agentTypes: ["codex"] }),
    );
  });

  it("multi-selects, in the order they were checked", () => {
    render(<NewWorkspaceDialog />);
    fireEvent.click(screen.getByRole("button", { name: /Agents/ }));

    fireEvent.click(screen.getByRole("checkbox", { name: /Shell/ }));
    fireEvent.click(create());

    expect(createWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ agentTypes: ["claude-code", "shell"] }),
    );
  });

  /** "Custom" launched a plain interactive shell: `customArgs` is hard-coded
   *  to null in `factories.ts` and nothing in the app can write it, so
   *  `custom_spec` bails and `launch_spec` returns `None`. Offering it here
   *  sold a bare shell under a "Custom" badge. */
  it("does not offer Custom", () => {
    render(<NewWorkspaceDialog />);
    fireEvent.click(screen.getByRole("button", { name: /Agents/ }));

    expect(
      screen.getAllByRole("checkbox").map((c) => c.parentElement?.textContent),
    ).toEqual(["Claude Code", "Codex", "OpenCode", "Shell"]);
  });

  it("still offers it when the stored default is Custom", () => {
    // The choice is withdrawn, not the type: somebody whose default is already
    // `custom` has to be able to see it and uncheck it.
    useSettingsStore.setState({
      agentDefaults: {
        agentType: "custom",
        model: null,
        permissionMode: "ask",
      },
    });
    render(<NewWorkspaceDialog />);
    fireEvent.click(screen.getByRole("button", { name: /Agents/ }));

    expect(screen.getByRole("checkbox", { name: /Custom/ })).toBeChecked();
  });

  it("falls back to the default when everything is unchecked", () => {
    // Zero agents is not a workspace of zero panes' worth of agents — it is a
    // user who cleared the list, which means the same as never opening it.
    render(<NewWorkspaceDialog />);
    fireEvent.click(screen.getByRole("button", { name: /Agents/ }));

    fireEvent.click(screen.getByRole("checkbox", { name: /Claude Code/ }));
    fireEvent.click(create());

    expect(createWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ agentTypes: ["claude-code"] }),
    );
  });
});

describe("creating", () => {
  it("passes the full choice to the store and closes", () => {
    render(<NewWorkspaceDialog />);

    fireEvent.click(tile(/^2 panes/));
    fireEvent.click(screen.getByRole("button", { name: /Agents/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Shell/ }));
    fireEvent.click(create());

    expect(createWorkspace).toHaveBeenCalledWith({
      projectPath: null,
      paneCount: 2,
      agentTypes: ["claude-code", "shell"],
    });
    expect(useUIStore.getState().isWorkspaceModalOpen).toBe(false);
  });
});
