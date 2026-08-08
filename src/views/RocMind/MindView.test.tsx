/** RocMind on screen: the tree, the memory, and the graph the corpus already
 *  has made clickable. */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import { resetRocMindModuleState, useRocMindStore } from "@/stores/rocmind";
import { useUIStore } from "@/stores/ui";
import { MindView } from "@/views/RocMind/MindView";
import { RocMindRow } from "@/views/Sidebar/RocMindRow";
import type { MindMemory, MindScope } from "@/lib/bindings";

const SCOPE = "-Users-l-Storefront";
const WORKTREE = "-Users-l-Storefront--claude-worktrees-v1-1";

const storefront: MindScope = {
  slug: SCOPE,
  projectPath: "/Users/l/Storefront",
  label: "Storefront",
  isWorktree: false,
  rootPath: null,
  count: 2,
};

const worktree: MindScope = {
  slug: WORKTREE,
  projectPath: "/Users/l/Storefront/.claude/worktrees/v1.1",
  label: "v1.1",
  isWorktree: true,
  rootPath: "/Users/l/Storefront",
  count: 1,
};

const memory = (over: Partial<MindMemory> & { name: string }): MindMemory => ({
  scope: SCOPE,
  path: `/p/${SCOPE}/memory/${over.name}.md`,
  description: "",
  memoryType: "project",
  links: [],
  updatedAt: 1,
  bytes: 10,
  ...over,
});

const payments = memory({
  name: "payments-provider-migration",
  description: "Payments provider moved to Acme Pay",
  memoryType: "project",
  links: ["internal-builds-test-keys"],
});
const testAds = memory({
  name: "internal-builds-test-keys",
  description: "Internal builds must use test API keys",
  links: ["payments-provider-migration"],
});
const inWorktree = memory({
  name: "worktree-only-note",
  scope: WORKTREE,
  path: `/p/${WORKTREE}/memory/worktree-only-note.md`,
});

const BODIES: Record<string, string> = {
  [payments.path]:
    "---\nname: payments-provider-migration\n---\n\nPublisher **acct-4417** is live. See [[internal-builds-test-keys]].\n",
  [testAds.path]: "Internal builds only.\n",
  [inWorktree.path]: "Written inside the worktree.\n",
};

function mockCorpus(scopes: MindScope[] = [storefront, worktree]) {
  invoke.mockImplementation(
    async (cmd: string, args?: Record<string, string>) => {
      // A fresh array per call, the way IPC deserialization really behaves —
      // returning the same object would hide every identity-churn bug.
      if (cmd === "mind_scopes") return [...scopes];
      if (cmd === "mind_list") {
        if (args?.scope === SCOPE) return [payments, testAds];
        if (args?.scope === WORKTREE) return [inWorktree];
        return [];
      }
      if (cmd === "mind_read") return BODIES[args?.path ?? ""] ?? "";
      return null;
    },
  );
}

const folder = (name: string | RegExp) =>
  screen.findByRole("button", { name: new RegExp(name) });

beforeEach(() => {
  invoke.mockReset();
  resetRocMindModuleState();
  useUIStore.setState({ mainView: "terminals" });
});

describe("the tree", () => {
  it("shows one folder per project with its total count", async () => {
    mockCorpus();
    render(<MindView />);

    // 2 of its own plus the worktree's 1 — what "how much is in here" means.
    await screen.findByRole("button", { name: /Storefront\s*3/ });
    expect(screen.getByText(/3 memories across 1 project/)).toBeInTheDocument();
  });

  it("opens a project to its memories and nests its worktree underneath", async () => {
    mockCorpus();
    render(<MindView />);
    fireEvent.click(await screen.findByRole("button", { name: /Storefront/ }));

    await screen.findByRole("button", { name: /payments-provider-migration/ });
    expect(
      screen.getByRole("button", { name: /internal-builds-test-keys/ }),
    ).toBeInTheDocument();
    // The worktree is a sub-folder, closed — not a run of rows beside them.
    const nested = screen.getByRole("button", { name: /v1\.1/ });
    expect(nested).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByRole("button", { name: /worktree-only-note/ }),
    ).not.toBeInTheDocument();

    fireEvent.click(nested);
    await screen.findByRole("button", { name: /worktree-only-note/ });
  });

  it("says so when there is nothing to show", async () => {
    mockCorpus([]);
    render(<MindView />);
    expect(await screen.findByText(/No memories yet/)).toBeInTheDocument();
    expect(screen.getByText(/Nothing remembered yet/)).toBeInTheDocument();
  });

  it("does not churn an open folder's watch when the scope list is re-read", async () => {
    // Every change to a watched scope re-reads the scope list, which rebuilds
    // the tree. Keyed on the node object, that dropped and re-took the folder's
    // watch — and a watch re-taken is a baseline re-seeded, so a second write
    // landing in that window would be absorbed silently instead of announced.
    mockCorpus();
    render(<MindView />);
    fireEvent.click(await folder(/Storefront/));
    await waitFor(() =>
      expect(
        invoke.mock.calls.filter(([cmd]) => cmd === "mind_watch"),
      ).not.toHaveLength(0),
    );
    const before = invoke.mock.calls.filter(
      ([cmd]) => cmd === "mind_watch",
    ).length;

    // Through `act`, so the re-render the new scope list causes has actually
    // happened by the time the counts are read.
    await act(async () => {
      await useRocMindStore.getState().loadScopes();
    });

    expect(
      invoke.mock.calls.filter(([cmd]) => cmd === "mind_unwatch"),
    ).toHaveLength(0);
    expect(
      invoke.mock.calls.filter(([cmd]) => cmd === "mind_watch"),
    ).toHaveLength(before);
  });

  it("remembers which folders were open", async () => {
    // The persisted half of it: the store is what `persistence` writes.
    mockCorpus();
    render(<MindView />);
    fireEvent.click(await screen.findByRole("button", { name: /Storefront/ }));
    expect(useRocMindStore.getState().expandedScopes).toEqual([SCOPE]);
  });
});

describe("the memory pane", () => {
  it("asks for a memory before one is picked", async () => {
    mockCorpus();
    render(<MindView />);
    expect(await screen.findByText("Pick a memory")).toBeInTheDocument();
  });

  it("shows the description as a subtitle, the type as a chip, and the body", async () => {
    mockCorpus();
    render(<MindView />);
    fireEvent.click(await folder(/Storefront/));
    fireEvent.click(
      await screen.findByRole("button", { name: /payments-provider/ }),
    );

    await waitFor(() => {
      expect(
        screen.getByText(/Payments provider moved to Acme Pay/),
      ).toBeInTheDocument();
    });
    expect(screen.getByText("project")).toBeInTheDocument();
    // Rendered markdown, with the frontmatter stripped: the pane already shows
    // the name and description in its header.
    expect(screen.getByText("acct-4417")).toBeInTheDocument();
    expect(screen.queryByText(/^---$/)).not.toBeInTheDocument();
  });

  it("follows a link chip to the memory it names", async () => {
    mockCorpus();
    render(<MindView />);
    fireEvent.click(await folder(/Storefront/));
    fireEvent.click(
      await screen.findByRole("button", { name: /payments-provider/ }),
    );
    await screen.findByText(/Links to/);

    const chips = screen
      .getAllByRole("button", { name: "internal-builds-test-keys" })
      .filter((el) => !el.hasAttribute("disabled"));
    fireEvent.click(chips[0]!);

    await waitFor(() => {
      expect(useRocMindStore.getState().selected).toBe(testAds.path);
    });
  });

  it("lists what links back to the open memory", async () => {
    mockCorpus();
    render(<MindView />);
    fireEvent.click(await folder(/Storefront/));
    fireEvent.click(
      await screen.findByRole("button", { name: /payments-provider/ }),
    );

    await screen.findByText(/Linked from/);
    // `internal-builds-test-keys` links to payments, so it is a backlink — computed
    // from the headers, not from an index somebody has to keep in step.
    const section = screen.getByText(/Linked from/).parentElement!;
    expect(section.textContent).toContain("internal-builds-test-keys");
  });

  // `closeMemory` sat in the store with zero call sites, so an opened memory
  // could not be put down: in the tree the pane held the last thing clicked for
  // ever, and in the GRAPH — where the pane only appears once something is
  // selected and then takes two fifths of the surface — one node click
  // permanently shrank the picture that tab exists to show.
  it("can be put down again", async () => {
    mockCorpus();
    render(<MindView />);
    fireEvent.click(await folder(/Storefront/));
    fireEvent.click(
      await screen.findByRole("button", { name: /payments-provider/ }),
    );
    await waitFor(() =>
      expect(useRocMindStore.getState().selected).toBe(payments.path),
    );

    fireEvent.click(screen.getByRole("button", { name: "Close this memory" }));

    expect(useRocMindStore.getState().selected).toBeNull();
    expect(await screen.findByText("Pick a memory")).toBeInTheDocument();
    // The scope stays: which project you are in is not something closing a
    // memory answers.
    expect(useRocMindStore.getState().activeScope).toBe(SCOPE);
  });

  it("does not offer a link that resolves to nothing", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "mind_scopes") return [storefront];
      if (cmd === "mind_list")
        return [memory({ name: "lonely", links: ["gone-memory"] })];
      if (cmd === "mind_read") return "body";
      return null;
    });
    render(<MindView />);
    fireEvent.click(await folder(/Storefront/));
    fireEvent.click(await screen.findByRole("button", { name: /lonely/ }));

    await screen.findByText(/Links to/);
    expect(screen.getByRole("button", { name: "gone-memory" })).toBeDisabled();
  });
});

describe("search", () => {
  it("replaces the tree with ranked results and says which field matched", async () => {
    mockCorpus();
    render(<MindView />);
    fireEvent.click(await folder(/Storefront/));
    await screen.findByRole("button", { name: /payments-provider/ });

    fireEvent.change(screen.getByPlaceholderText("Search memories"), {
      target: { value: "payments" },
    });

    // The folder is gone; the results are in its place.
    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: /Storefront\s*3/ }),
      ).not.toBeInTheDocument();
    });
    const rows = screen.getAllByRole("button", { name: /payments/i });
    expect(rows[0]!.textContent).toContain("payments-provider-migration");
    expect(rows[0]!.textContent).toContain("name");
  });

  it("says nothing matched rather than showing an empty list", async () => {
    mockCorpus();
    render(<MindView />);
    fireEvent.change(await screen.findByPlaceholderText("Search memories"), {
      target: { value: "zzzz" },
    });
    expect(await screen.findByText(/Nothing matches/)).toBeInTheDocument();
  });
});

describe("the sidebar row", () => {
  it("swaps the main area to RocMind and back", () => {
    render(<RocMindRow />);
    const row = screen.getByRole("button", { name: /RocMind/ });

    fireEvent.click(row);
    expect(useUIStore.getState().mainView).toBe("rocmind");
    expect(row).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(row);
    expect(useUIStore.getState().mainView).toBe("terminals");
  });

  it("is never disabled — the corpus is the machine's, not a project's", () => {
    // RocPlan's row refuses with no workspace because a board lives in a
    // repository. Memories do not, and "what was I doing in that project" is a
    // question you ask BEFORE you open it.
    render(<RocMindRow />);
    expect(screen.getByRole("button", { name: /RocMind/ })).toBeEnabled();
  });
});
