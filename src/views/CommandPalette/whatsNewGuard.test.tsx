/** "What's new in this build", on a build that has no changelog entry.
 *
 *  Unreachable today — `CHANGELOG.md` has entries and `changelog.test.ts` fails
 *  the build if the top one is empty — which is exactly why it is worth a test
 *  of its own: the failure is silent and total. `openWhatsNew` sets a flag that
 *  `blockingModalOpen` counts, while `WhatsNewModal` renders `null` without an
 *  entry to show. Every chord in the app would stand down for a dialog that is
 *  not on screen and has no Escape to press, with nothing to say why.
 *
 *  Settings › About asks the same question before it offers its button
 *  (`AboutSection` renders the row only `{LATEST_ENTRY ? … }`); the palette row
 *  did not, and this is that guard.
 *
 *  Its own file because the fixture is a module mock: `LATEST_ENTRY` is a
 *  constant read at import time, so the only way to have a build without one is
 *  to be a test file that says so. */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));

vi.mock("@/lib/changelog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/changelog")>()),
  CHANGELOG_ENTRIES: [],
  LATEST_ENTRY: null,
}));

import { resetCommandRegistry } from "@/lib/commands/registry";
import { useUIStore } from "@/stores/ui";
import { useWorkspacesStore } from "@/stores/workspaces";
import { CommandPalette } from "@/views/CommandPalette/CommandPalette";

beforeEach(() => {
  resetCommandRegistry();
  useWorkspacesStore.setState({ workspaces: [], activeWorkspaceId: null });
  useUIStore.setState({ isCommandPaletteOpen: false, isWhatsNewOpen: false });
});

describe("help.whats-new", () => {
  it("is not offered on a build with nothing to announce", () => {
    render(<CommandPalette />);
    act(() => useUIStore.getState().openCommandPalette());

    expect(document.getElementById("command-option-help.whats-new")).toBeNull();
    expect(
      screen.queryByRole("option", { name: /What's new/ }),
    ).not.toBeInTheDocument();
  });
});
