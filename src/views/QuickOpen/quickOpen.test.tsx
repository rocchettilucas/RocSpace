/** ⌘P: the chord, the ordering, and what picking a file actually does. */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import { resetFileIndexes, type IndexedFile } from "@/lib/fileIndex";
import { allCommands, resetCommandRegistry } from "@/lib/commands/registry";
import { newWorkspace } from "@/lib/factories";
import { useEditorStore } from "@/stores/editor";
import { useUIStore } from "@/stores/ui";
import { useWorkspacesStore } from "@/stores/workspaces";
import { QuickOpenDialog } from "@/views/QuickOpen/QuickOpenModal";
import { rankFiles } from "@/views/QuickOpen/rankFiles";
import { useEditorCommands } from "@/views/RocDock/EditorView/useEditorCommands";
import { useEditorShortcuts } from "@/views/RocDock/EditorView/useEditorShortcuts";
import type { DirEntryDto } from "@/lib/bindings";

const ROOT = "/code/rocspace";

const indexed = (rel: string): IndexedFile => ({
  path: `${ROOT}/${rel}`,
  rel,
  name: rel.slice(rel.lastIndexOf("/") + 1),
});

const entry = (rel: string, isDir = false): DirEntryDto => ({
  name: rel.slice(rel.lastIndexOf("/") + 1),
  path: `${ROOT}/${rel}`,
  isDir,
  size: 1,
  hidden: false,
});

function openProject(projectPath: string | null = ROOT): void {
  useWorkspacesStore.setState({
    workspaces: [{ ...newWorkspace({ projectPath, order: 0 }), id: "w_1" }],
    activeWorkspaceId: "w_1",
  });
}

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue([]);
  resetFileIndexes();
  resetCommandRegistry();
  useEditorStore.setState({
    tabs: [],
    activePath: null,
    dirtyByPath: {},
    rightDockMode: "inspector",
    rightPanelCollapsed: true,
  });
  useUIStore.setState({ isQuickOpenOpen: false, isSettingsOpen: false });
  openProject();
});

describe("rankFiles", () => {
  const files = [
    indexed("src/App.tsx"),
    indexed("src/views/AppShell.tsx"),
    indexed("docs/a/p/p.md"),
    indexed("src/stores/ui.ts"),
  ];

  it("shows the index as it is with nothing typed", () => {
    expect(rankFiles(files, "").map((r) => r.file.rel)).toEqual(
      files.map((f) => f.rel),
    );
  });

  it("puts a file-name match above a path that merely contains the letters", () => {
    // People type file names. Scoring only the relative path would rank on
    // where the letters happened to fall.
    const ranked = rankFiles(files, "app");
    expect(ranked[0]?.file.rel).toBe("src/App.tsx");
    expect(ranked.map((r) => r.file.rel)).not.toContain("src/stores/ui.ts");
  });

  it("matches a path fragment nobody could type as a name", () => {
    const ranked = rankFiles(files, "views/app");
    expect(ranked[0]?.file.rel).toBe("src/views/AppShell.tsx");
  });

  it("reports positions against the relative path, whichever half matched", () => {
    const ranked = rankFiles([indexed("src/App.tsx")], "app");
    // Matched on the NAME, highlighted on the path: the offset is what lets
    // one string carry either kind of match.
    expect(ranked[0]?.positions).toEqual([4, 5, 6]);
  });
});

describe("the Go to file dialog", () => {
  it("lists the project and opens the file that is picked", async () => {
    invoke.mockResolvedValue([entry("src", true)]);
    invoke.mockImplementation(async (_cmd: string, args: unknown) => {
      const { path } = args as { path: string };
      if (path === ROOT) return [entry("src", true), entry("README.md")];
      if (path === `${ROOT}/src`) return [entry("src/App.tsx")];
      return [];
    });

    render(<QuickOpenDialog />);
    await screen.findByRole("button", { name: /src\/App\.tsx/ });

    fireEvent.change(screen.getByLabelText("File name"), {
      target: { value: "app" },
    });
    fireEvent.keyDown(screen.getByLabelText("File name"), { key: "Enter" });

    const editor = useEditorStore.getState();
    expect(editor.tabs.map((t) => t.path)).toEqual([`${ROOT}/src/App.tsx`]);
    // Picking a file from a finder is an unambiguous request to look at it —
    // landing on a tab behind a collapsed panel would read as nothing having
    // happened.
    expect(editor.rightDockMode).toBe("editor");
    expect(editor.rightPanelCollapsed).toBe(false);
    expect(useUIStore.getState().isQuickOpenOpen).toBe(false);
  });

  it("moves the highlight with the arrows", async () => {
    invoke.mockImplementation(async (_cmd: string, args: unknown) => {
      const { path } = args as { path: string };
      return path === ROOT ? [entry("a.ts"), entry("b.ts")] : [];
    });

    render(<QuickOpenDialog />);
    const field = await screen.findByLabelText("File name");
    await screen.findByRole("button", { name: /a\.ts/ });

    fireEvent.keyDown(field, { key: "ArrowDown" });
    fireEvent.keyDown(field, { key: "Enter" });

    expect(useEditorStore.getState().tabs.map((t) => t.path)).toEqual([
      `${ROOT}/b.ts`,
    ]);
  });

  it("Escape closes it from inside the field", async () => {
    render(<QuickOpenDialog />);
    const field = await screen.findByLabelText("File name");
    useUIStore.setState({ isQuickOpenOpen: true });

    fireEvent.keyDown(field, { key: "Escape" });

    // The dialog IS this field, so its Escape and the dialog's are the same
    // gesture — which is why `ModalShell`'s handler stands down for text entry
    // and this one answers instead.
    expect(useUIStore.getState().isQuickOpenOpen).toBe(false);
  });

  it("says so when nothing matches", async () => {
    invoke.mockImplementation(async (_cmd: string, args: unknown) => {
      const { path } = args as { path: string };
      return path === ROOT ? [entry("a.ts")] : [];
    });

    render(<QuickOpenDialog />);
    await screen.findByRole("button", { name: /a\.ts/ });

    fireEvent.change(screen.getByLabelText("File name"), {
      target: { value: "zzzz" },
    });

    expect(screen.getByText(/Nothing matches/)).toBeInTheDocument();
  });

  it("says what went wrong when the project directory cannot be read", async () => {
    invoke.mockImplementation(async () => {
      throw "read_dir failed: Permission denied";
    });

    render(<QuickOpenDialog />);

    expect(await screen.findByText(/Permission denied/)).toBeInTheDocument();
    // "No files found in this project." is a sentence about the project, and
    // the project is fine — the read of it is what failed. A deleted directory
    // and a permission error both arrived here as emptiness.
    expect(screen.queryByText(/No files found/)).toBeNull();
  });

  it("says when the walk stopped short of the whole project", async () => {
    // One file and one directory per level, deeper than the walk goes. Under a
    // silent cap the file below it produces `Nothing matches "…"`, which reads
    // as "this file does not exist".
    const tree: Record<string, DirEntryDto[]> = {};
    let dir = ROOT;
    for (let i = 0; i <= 13; i++) {
      const child = `${dir}/d${i}`;
      tree[dir] = [
        {
          name: `f${i}.ts`,
          path: `${dir}/f${i}.ts`,
          isDir: false,
          size: 1,
          hidden: false,
        },
        { name: `d${i}`, path: child, isDir: true, size: 0, hidden: false },
      ];
      dir = child;
    }
    tree[dir] = [];
    invoke.mockImplementation(
      async (_cmd: string, args: unknown) =>
        tree[(args as { path: string }).path] ?? [],
    );

    render(<QuickOpenDialog />);
    await screen.findByRole("button", { name: /f0\.ts/ });

    expect(
      await screen.findByText(/larger than the finder walks/i),
    ).toBeInTheDocument();
  });

  it("has nothing to search without a project directory", async () => {
    openProject(null);
    render(<QuickOpenDialog />);
    expect(
      await screen.findByText(/no project directory to search/),
    ).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("⌘P", () => {
  function Host() {
    useEditorShortcuts();
    return null;
  }
  const press = () => fireEvent.keyDown(document, { key: "p", metaKey: true });

  it("opens the finder", () => {
    render(<Host />);
    press();
    expect(useUIStore.getState().isQuickOpenOpen).toBe(true);
  });

  it("is left unclaimed when there is no project to search", () => {
    openProject(null);
    render(<Host />);
    const seen: KeyboardEvent[] = [];
    document.addEventListener("keydown", (e) => seen.push(e));

    press();

    expect(useUIStore.getState().isQuickOpenOpen).toBe(false);
    expect(seen.at(-1)?.defaultPrevented).toBe(false);
  });

  it("leaves ⌘⇧P to the board", () => {
    render(<Host />);
    fireEvent.keyDown(document, { key: "p", metaKey: true, shiftKey: true });
    expect(useUIStore.getState().isQuickOpenOpen).toBe(false);
  });

  it("stands down while a modal holds the window", () => {
    useUIStore.setState({ isSettingsOpen: true });
    render(<Host />);
    press();
    expect(useUIStore.getState().isQuickOpenOpen).toBe(false);
  });
});

describe("the editor's palette actions", () => {
  function Host() {
    useEditorCommands();
    return null;
  }

  it("registers under the Editor group and unregisters on unmount", () => {
    const { unmount } = render(<Host />);
    const ids = allCommands().map((a) => a.id);
    expect(ids).toContain("editor.quick-open");
    expect(ids).toContain("editor.save-all");
    expect(allCommands().every((a) => a.group === "Editor")).toBe(true);

    unmount();
    expect(allCommands()).toHaveLength(0);
  });

  it("hides the ones that could only disappoint", async () => {
    render(<Host />);
    const by = (id: string) => allCommands().find((a) => a.id === id)!;

    // Nothing open, nothing dirty.
    expect(by("editor.save").enabled?.()).toBe(false);
    expect(by("editor.save-all").enabled?.()).toBe(false);
    expect(by("editor.close-tab").enabled?.()).toBe(false);
    // Finding a file needs a project.
    expect(by("editor.quick-open").enabled?.()).toBe(true);
    // …and "Show the editor" is not one of these at all any more: it was a
    // near-duplicate of the built-ins' `panel.editor` with no `enabled` of its
    // own, so with the editor already up the guarded row hid and this one stayed
    // on offer, doing nothing.
    expect(allCommands().some((a) => a.id === "editor.show")).toBe(false);

    useEditorStore.getState().openFile(`${ROOT}/a.ts`);
    useEditorStore.getState().setBuffer(`${ROOT}/a.ts`, "typed", "");
    expect(by("editor.save").enabled?.()).toBe(true);
    expect(by("editor.revert").enabled?.()).toBe(true);
    expect(by("editor.close-tab").enabled?.()).toBe(true);

    openProject(null);
    expect(by("editor.quick-open").enabled?.()).toBe(false);
  });

  it("closing a dirty file from the palette asks the same question the × does", async () => {
    render(<Host />);
    useEditorStore.getState().openFile(`${ROOT}/a.ts`);
    useEditorStore.getState().setBuffer(`${ROOT}/a.ts`, "typed", "");

    await allCommands()
      .find((a) => a.id === "editor.close-tab")!
      .run();

    // A palette row that closed it outright would walk around the tab strip's
    // confirmation.
    expect(useEditorStore.getState().tabs).toHaveLength(1);
    expect(useUIStore.getState().editorPrompt).toEqual({
      type: "unsaved-close",
      path: `${ROOT}/a.ts`,
    });
  });

  it("save all writes every dirty buffer", async () => {
    render(<Host />);
    for (const name of ["a", "b"]) {
      useEditorStore.getState().openFile(`${ROOT}/${name}.ts`);
      useEditorStore.getState().setBuffer(`${ROOT}/${name}.ts`, name, "");
    }
    invoke.mockResolvedValue(undefined);

    await allCommands()
      .find((a) => a.id === "editor.save-all")!
      .run();

    await waitFor(() => {
      expect(useEditorStore.getState().dirtyByPath).toEqual({});
    });
  });
});
