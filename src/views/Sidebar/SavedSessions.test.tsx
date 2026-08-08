/** The sidebar footer: the sessions on disk, and the two things you can do to
 *  one of them. */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import { answerConfirmsWith } from "@/test/confirm";
import { useSavedSessionsStore } from "@/stores/savedSessions";
import { useTerminalsStore } from "@/stores/terminals";
import { useUIStore } from "@/stores/ui";
import { useWorkspacesStore } from "@/stores/workspaces";
import { SavedSessions } from "@/views/Sidebar/SavedSessions";
import type { SavedSessionMeta } from "@/lib/bindings";

const meta = (name: string, paneCount = 2): SavedSessionMeta => ({
  name,
  savedAt: Date.now() - 60_000,
  workspaceName: name,
  paneCount,
});

const payload = {
  workspaceName: "rocspace",
  paneCount: 1,
  workspace: {
    name: "rocspace",
    accent: "cyan",
    projectPath: "/code/rocspace",
    paneTree: { kind: "leaf", terminalId: "saved-1" },
  },
  terminals: [
    {
      id: "saved-1",
      name: "Rocky",
      agentConfig: { type: "shell" },
      projectPath: "/code/rocspace",
      claudeSessionId: null,
    },
  ],
};

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "session_list") return [meta("friday"), meta("spike", 4)];
    if (cmd === "session_load") return payload;
    return null;
  });
  useSavedSessionsStore.setState({ sessions: [], loaded: false, error: null });
  useWorkspacesStore.setState({ workspaces: [], activeWorkspaceId: null });
  useTerminalsStore.setState({ byId: {} });
  useUIStore.setState({ isSaveSessionModalOpen: false });
});

const rows = async () => {
  const list = await screen.findByRole("list", { name: "Saved sessions" });
  return [...list.querySelectorAll("li")];
};

it("lists what is on disk, read once on mount", async () => {
  render(<SavedSessions />);

  expect((await rows()).map((li) => li.textContent)).toEqual([
    "friday2",
    "spike4",
  ]);
  expect(invoke.mock.calls.filter(([c]) => c === "session_list")).toHaveLength(
    1,
  );
});

it("says so when nothing is saved, rather than showing an empty box", async () => {
  invoke.mockImplementation(async () => []);
  render(<SavedSessions />);

  expect(await screen.findByText(/Nothing saved/)).toBeInTheDocument();
});

it("restores a session as a new workspace beside the open ones", async () => {
  render(<SavedSessions />);
  await rows();

  fireEvent.click(screen.getByRole("button", { name: /^friday/ }));

  await waitFor(() =>
    expect(useWorkspacesStore.getState().workspaces).toHaveLength(1),
  );
  const workspace = useWorkspacesStore.getState().workspaces[0]!;
  expect(workspace.name).toBe("rocspace");
  expect(useWorkspacesStore.getState().activeWorkspaceId).toBe(workspace.id);
  const sessions = Object.values(useTerminalsStore.getState().byId);
  expect(sessions.map((s) => s.name)).toEqual(["Rocky"]);
  // A new id, not the one the file names — restoring twice must not put two
  // workspaces on one terminal id.
  expect(sessions[0]!.id).not.toBe("saved-1");
});

it("confirms before deleting, and drops the row once it is gone", async () => {
  let confirms = answerConfirmsWith(false);
  render(<SavedSessions />);
  await rows();

  fireEvent.click(screen.getByRole("button", { name: "Delete friday" }));
  await waitFor(() => expect(confirms.asked[0]?.message).toContain("friday"));
  expect(invoke.mock.calls.some(([c]) => c === "session_delete")).toBe(false);

  confirms.restore();
  confirms = answerConfirmsWith(true);
  fireEvent.click(screen.getByRole("button", { name: "Delete friday" }));

  await waitFor(() =>
    expect(
      useSavedSessionsStore.getState().sessions.map((s) => s.name),
    ).toEqual(["spike"]),
  );
  confirms.restore();
});

it("offers the save prompt from the header", async () => {
  render(<SavedSessions />);
  await rows();

  fireEvent.click(screen.getByRole("button", { name: "Save session as" }));

  expect(useUIStore.getState().isSaveSessionModalOpen).toBe(true);
});

describe("when the store cannot be read", () => {
  /** "Nothing saved — press ⌘⇧S" is a claim about the disk. Making it after a
   *  failed `session_list` tells the user their sessions are gone, and invites
   *  them to overwrite the folder that could not be read. */
  it("says the list failed rather than that nothing is saved", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    invoke.mockRejectedValue(new Error("no permission"));
    render(<SavedSessions />);

    expect(await screen.findByText(/no permission/)).toBeInTheDocument();
    expect(screen.queryByText(/Nothing saved/)).toBeNull();
    expect(useSavedSessionsStore.getState().error).toBe("no permission");
    warn.mockRestore();
  });

  it("shows a restore that failed instead of doing nothing at all", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    render(<SavedSessions />);
    await rows();
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "session_list") return [meta("friday")];
      if (cmd === "session_load") throw new Error("No such file or directory");
      return null;
    });

    fireEvent.click(screen.getByRole("button", { name: /^friday/ }));

    expect(
      await screen.findByText(/No such file or directory/),
    ).toBeInTheDocument();
    expect(useWorkspacesStore.getState().workspaces).toHaveLength(0);
    warn.mockRestore();
  });
});
