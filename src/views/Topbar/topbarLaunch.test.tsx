/** The topbar's Launch all button, and the one question it never asked.
 *
 *  "Launch" reads like "start what is not started". It is not: `spawnTerminal`
 *  goes to `PtyRuntime::spawn`, whose first act is to kill whatever is on the
 *  terminal id — so pressing this over a dock that is mid-conversation throws
 *  every one of those conversations away. ⌘W asks before doing that to a single
 *  pane and "Close this workspace" asks before doing it to a workspace's worth;
 *  this button reached the same destruction in one click and said nothing.
 *
 *  The palette's "Launch every pane" runs the same function (`launchPanes`), so
 *  the two cannot drift about when the question is worth asking — that half is
 *  covered in `CommandPalette.test.tsx`. */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const { terminalSpawn } = vi.hoisted(() => ({
  terminalSpawn: vi.fn(async () => ({ pid: 1, claudeSessionId: null })),
}));

vi.mock("@/lib/bindings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/bindings")>();
  return {
    ...actual,
    commands: { ...actual.commands, terminalSpawn, terminalKill: vi.fn() },
  };
});

import { answerConfirmsWith, type ConfirmProbe } from "@/test/confirm";
import { newTerminal, newWorkspace } from "@/lib/factories";
import { useTerminalsStore } from "@/stores/terminals";
import { useUIStore } from "@/stores/ui";
import { useWorkspacesStore } from "@/stores/workspaces";
import { Topbar } from "@/views/Topbar/Topbar";
import type { TerminalStatus } from "@/lib/bindings";

let confirms: ConfirmProbe;

/** One workspace, two panes in its tree, the first of them at `status`. */
function seed(status: TerminalStatus) {
  const workspace = newWorkspace({ projectPath: "/tmp/proj", order: 0 });
  const panes = ["Rocky", "Rhodes"].map((name) =>
    newTerminal({
      workspaceId: workspace.id,
      name,
      agentType: "claude-code",
      projectPath: "/tmp/proj",
    }),
  );
  useWorkspacesStore.setState({
    workspaces: [
      {
        ...workspace,
        paneTree: {
          kind: "split",
          direction: "row",
          ratio: 0.5,
          first: { kind: "leaf", terminalId: panes[0]!.id },
          second: { kind: "leaf", terminalId: panes[1]!.id },
        },
      },
    ],
    activeWorkspaceId: workspace.id,
  });
  useTerminalsStore.getState().setTerminals(panes);
  useTerminalsStore.getState().setStatus(panes[0]!.id, status);
}

const launch = () => fireEvent.click(screen.getByLabelText("Launch all"));

beforeEach(() => {
  vi.clearAllMocks();
  useWorkspacesStore.setState({ workspaces: [], activeWorkspaceId: null });
  useTerminalsStore.setState({ byId: {} });
  useUIStore.setState({ mainView: "terminals", isSettingsOpen: false });
  confirms = answerConfirmsWith(true);
});

describe("Launch all", () => {
  it("relaunches an idle dock without a dialog", async () => {
    seed("idle");
    render(<Topbar />);

    launch();

    await waitFor(() => expect(terminalSpawn).toHaveBeenCalledTimes(2));
    expect(confirms.asked).toHaveLength(0);
    confirms.restore();
  });

  it("asks before it kills a turn that is still running", async () => {
    seed("running");
    confirms.restore();
    confirms = answerConfirmsWith(false);
    render(<Topbar />);

    launch();

    await waitFor(() => expect(confirms.asked).toHaveLength(1));
    expect(confirms.asked[0]!.tone).toBe("danger");
    // Declined, so nothing was relaunched and nothing was killed.
    expect(terminalSpawn).not.toHaveBeenCalled();
    confirms.restore();
  });
});
