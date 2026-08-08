/** The ⌘⇧S name prompt: what it saves, and what it asks before overwriting. */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import { answerConfirmsWith } from "@/test/confirm";
import { newWorkspace } from "@/lib/factories";
import { useSavedSessionsStore } from "@/stores/savedSessions";
import { useUIStore } from "@/stores/ui";
import { useWorkspacesStore } from "@/stores/workspaces";
import { useTerminalsStore } from "@/stores/terminals";
import {
  SaveSessionDialog,
  SaveSessionModal,
} from "@/views/Workspaces/SaveSessionModal";
import type { SavedSessionMeta } from "@/lib/bindings";

const field = () => screen.getByLabelText("Name") as HTMLInputElement;
const saveButton = () => screen.getByRole("button", { name: /Save session/ });

const meta = (name: string): SavedSessionMeta => ({
  name,
  savedAt: 1,
  workspaceName: name,
  paneCount: 2,
});

/** `session_list` answers with `list`; everything else resolves empty. */
function mockIpc(list: SavedSessionMeta[] = []) {
  invoke.mockImplementation(async (cmd: string, args: unknown) => {
    if (cmd === "session_list") return list;
    if (cmd === "session_save") {
      const { name } = args as { name: string };
      return meta(name);
    }
    return null;
  });
}

beforeEach(() => {
  invoke.mockReset();
  mockIpc();
  const workspace = newWorkspace({
    name: "rocspace",
    projectPath: "/code/rocspace",
    order: 0,
  });
  useWorkspacesStore.setState({
    workspaces: [workspace],
    activeWorkspaceId: workspace.id,
  });
  useTerminalsStore.setState({ byId: {} });
  useSavedSessionsStore.setState({ sessions: [], loaded: false, error: null });
  useUIStore.setState({ isSaveSessionModalOpen: true });
});

describe("opening", () => {
  it("renders nothing while it is closed", () => {
    useUIStore.setState({ isSaveSessionModalOpen: false });

    render(<SaveSessionModal />);

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens on the workspace's own name, in the field, selected", () => {
    // The name is right most of the time, and selected so typing over it is one
    // gesture rather than a select-all.
    render(<SaveSessionDialog />);

    expect(field()).toHaveValue("rocspace");
    expect(field()).toHaveFocus();
    expect(field().selectionStart).toBe(0);
    expect(field().selectionEnd).toBe("rocspace".length);
  });

  it("says which file the name becomes", () => {
    render(<SaveSessionDialog />);

    fireEvent.change(field(), { target: { value: "Friday Review" } });

    expect(screen.getByText("friday-review.json")).toBeInTheDocument();
  });
});

describe("closing", () => {
  it("closes on Escape from inside the field", () => {
    // The dialog IS the field, so Escape there and Escape for the dialog are
    // one gesture — the shell's document handler stands down for text inputs,
    // and this is what answers instead.
    render(<SaveSessionDialog />);

    fireEvent.keyDown(field(), { key: "Escape" });

    expect(useUIStore.getState().isSaveSessionModalOpen).toBe(false);
  });

  it("closes on Cancel without saving", () => {
    render(<SaveSessionDialog />);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(invoke.mock.calls.some(([cmd]) => cmd === "session_save")).toBe(
      false,
    );
    expect(useUIStore.getState().isSaveSessionModalOpen).toBe(false);
  });
});

describe("saving", () => {
  it("saves the active workspace under the typed name and closes", async () => {
    render(<SaveSessionDialog />);

    fireEvent.change(field(), { target: { value: "Friday Review" } });
    fireEvent.click(saveButton());

    await waitFor(() =>
      expect(useUIStore.getState().isSaveSessionModalOpen).toBe(false),
    );
    const save = invoke.mock.calls.find(([cmd]) => cmd === "session_save")!;
    expect(save[1]).toMatchObject({
      name: "Friday Review",
      payload: { workspaceName: "rocspace", paneCount: 0 },
    });
  });

  it("saves on Enter in the field", async () => {
    render(<SaveSessionDialog />);

    fireEvent.keyDown(field(), { key: "Enter" });

    await waitFor(() =>
      expect(invoke.mock.calls.some(([cmd]) => cmd === "session_save")).toBe(
        true,
      ),
    );
  });

  it("refuses a name no filename can be made from", () => {
    render(<SaveSessionDialog />);

    fireEvent.change(field(), { target: { value: "???" } });

    expect(saveButton()).toBeDisabled();
    expect(screen.getByText(/at least one letter or digit/)).toBeVisible();
  });

  it("stays open when the save fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "session_list") return [];
      throw new Error("disk full");
    });
    render(<SaveSessionDialog />);

    fireEvent.click(saveButton());

    await waitFor(() =>
      expect(useSavedSessionsStore.getState().error).toBe("disk full"),
    );
    expect(useUIStore.getState().isSaveSessionModalOpen).toBe(true);
    warn.mockRestore();
  });
});

describe("a name that is already taken", () => {
  /** Same slug as "rocspace", different capitalisation — the collision the
   *  user cannot see from the two names alone. */
  const existing = [meta("RocSpace")];

  it("asks before replacing, and does not save when refused", async () => {
    mockIpc(existing);
    const confirms = answerConfirmsWith(false);
    render(<SaveSessionDialog />);
    await waitFor(() =>
      expect(useSavedSessionsStore.getState().sessions).toHaveLength(1),
    );

    fireEvent.click(screen.getByRole("button", { name: "Replace" }));

    // `waitFor` because the question is asked after the list read on open has
    // landed, not from the render that started before it — see the boot case
    // at the bottom of this file.
    await waitFor(() =>
      expect(confirms.asked[0]?.message).toContain("RocSpace"),
    );
    expect(invoke.mock.calls.some(([cmd]) => cmd === "session_save")).toBe(
      false,
    );
    expect(useUIStore.getState().isSaveSessionModalOpen).toBe(true);
    confirms.restore();
  });

  it("overwrites once confirmed", async () => {
    mockIpc(existing);
    const confirms = answerConfirmsWith(true);
    render(<SaveSessionDialog />);
    await waitFor(() =>
      expect(useSavedSessionsStore.getState().sessions).toHaveLength(1),
    );

    fireEvent.click(screen.getByRole("button", { name: "Replace" }));

    await waitFor(() =>
      expect(useUIStore.getState().isSaveSessionModalOpen).toBe(false),
    );
    const save = invoke.mock.calls.find(([cmd]) => cmd === "session_save")!;
    expect(save[1]).toMatchObject({ name: "rocspace" });
    confirms.restore();
  });

  it("does not ask for a name nothing holds", async () => {
    mockIpc(existing);
    const confirms = answerConfirmsWith(true);
    render(<SaveSessionDialog />);
    await waitFor(() =>
      expect(useSavedSessionsStore.getState().sessions).toHaveLength(1),
    );

    fireEvent.change(field(), { target: { value: "Something else" } });
    fireEvent.click(saveButton());

    // Waited out to the save itself: asserting "not called" one tick after the
    // click would pass on any code that simply asks later.
    await waitFor(() =>
      expect(invoke.mock.calls.some(([cmd]) => cmd === "session_save")).toBe(
        true,
      ),
    );
    expect(confirms.asked).toHaveLength(0);
    confirms.restore();
  });

  it("asks even when Enter arrives before the list does", async () => {
    // The boot race: ⌘⇧S opens the dialog, `session_list` is still in flight,
    // and Enter lands first. `sessions` is `[]` at that moment, so a save that
    // trusted the render silently replaced the file on disk — the exact data
    // loss the confirmation exists to prevent.
    let deliverList = (_: SavedSessionMeta[]) => {};
    const listed = new Promise<SavedSessionMeta[]>((resolve) => {
      deliverList = resolve;
    });
    invoke.mockImplementation(async (cmd: string, args: unknown) => {
      if (cmd === "session_list") return listed;
      if (cmd === "session_save") return meta((args as { name: string }).name);
      return null;
    });
    const confirms = answerConfirmsWith(false);
    render(<SaveSessionDialog />);

    fireEvent.keyDown(field(), { key: "Enter" });
    // Nothing has been written yet, and nothing has been asked yet: the save
    // is waiting on the answer it needs to ask the right question.
    expect(confirms.asked).toHaveLength(0);
    expect(invoke.mock.calls.some(([cmd]) => cmd === "session_save")).toBe(
      false,
    );

    deliverList([meta("RocSpace")]);

    await waitFor(() =>
      expect(confirms.asked[0]?.message).toContain("RocSpace"),
    );
    expect(invoke.mock.calls.some(([cmd]) => cmd === "session_save")).toBe(
      false,
    );
    expect(useUIStore.getState().isSaveSessionModalOpen).toBe(true);
    confirms.restore();
  });
});

describe("with no workspace open", () => {
  beforeEach(() => {
    useWorkspacesStore.setState({ workspaces: [], activeWorkspaceId: null });
  });

  it("says so instead of saving nothing", () => {
    render(<SaveSessionDialog />);

    expect(screen.getByText(/no workspace open to save/)).toBeVisible();
    expect(saveButton()).toBeDisabled();
  });
});
