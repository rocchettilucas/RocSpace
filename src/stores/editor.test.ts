import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import { newWorkspace } from "@/lib/factories";
import { cachedFile, putFile, resetFileContents } from "@/lib/fileContents";
import { useEditorStore } from "@/stores/editor";
import { resetToastsState, useToastsStore } from "@/stores/toasts";
import { useWorkspacesStore } from "@/stores/workspaces";

const ROOT = "/code/rocspace";

/** A workspace to save into. Every write goes through the ACTIVE one's
 *  directory, and Rust refuses anything outside it. */
function openProject(projectPath: string | null = ROOT): void {
  const workspace = {
    ...newWorkspace({ projectPath, order: 0 }),
    id: "w_1",
  };
  useWorkspacesStore.setState({
    workspaces: [workspace],
    activeWorkspaceId: "w_1",
  });
}

/** Seed a baseline as if the file had been read. */
function baseline(path: string, content: string): void {
  putFile(path, {
    path,
    content,
    size: content.length,
    language: null,
    writable: true,
  });
}

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
  resetFileContents();
  resetToastsState();
  openProject();
});

afterEach(() => {
  // Reset store between tests so they're order-independent.
  useEditorStore.setState({
    rightDockMode: "inspector",
    tabs: [],
    activePath: null,
    dirtyByPath: {},
  });
  useWorkspacesStore.setState({ workspaces: [], activeWorkspaceId: null });
});

describe("useEditorStore", () => {
  it("openFile adds a new tab and makes it active", () => {
    useEditorStore.getState().openFile("C:\\proj\\src\\foo.ts", 12);
    const state = useEditorStore.getState();
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]).toMatchObject({
      path: "C:\\proj\\src\\foo.ts",
      name: "foo.ts",
      pendingLine: 12,
    });
    expect(state.activePath).toBe("C:\\proj\\src\\foo.ts");
  });

  it("openFile on an existing tab focuses it and updates pendingLine", () => {
    const path = "/proj/a.ts";
    useEditorStore.getState().openFile(path, 1);
    useEditorStore.getState().openFile("/proj/b.ts");
    expect(useEditorStore.getState().activePath).toBe("/proj/b.ts");

    useEditorStore.getState().openFile(path, 42);
    const state = useEditorStore.getState();
    expect(state.tabs).toHaveLength(2);
    expect(state.activePath).toBe(path);
    expect(state.tabs.find((t) => t.path === path)?.pendingLine).toBe(42);
  });

  it("closeTab on the active tab activates a neighbor", () => {
    useEditorStore.getState().openFile("/a.ts");
    useEditorStore.getState().openFile("/b.ts");
    useEditorStore.getState().openFile("/c.ts");
    // Active is /c.ts, close it — should fall back to /b.ts.
    useEditorStore.getState().closeTab("/c.ts");
    expect(useEditorStore.getState().activePath).toBe("/b.ts");

    // Close the middle, active stays put if it's not the one closed.
    useEditorStore.getState().setActive("/a.ts");
    useEditorStore.getState().closeTab("/b.ts");
    expect(useEditorStore.getState().activePath).toBe("/a.ts");
  });

  it("closing the last tab nulls the active path", () => {
    useEditorStore.getState().openFile("/only.ts");
    useEditorStore.getState().closeTab("/only.ts");
    expect(useEditorStore.getState().activePath).toBeNull();
    expect(useEditorStore.getState().tabs).toHaveLength(0);
  });

  it("setRightDockMode cycles through inspector/browser/editor/git", () => {
    expect(useEditorStore.getState().rightDockMode).toBe("inspector");
    useEditorStore.getState().setRightDockMode("browser");
    expect(useEditorStore.getState().rightDockMode).toBe("browser");
    useEditorStore.getState().setRightDockMode("editor");
    expect(useEditorStore.getState().rightDockMode).toBe("editor");
    useEditorStore.getState().setRightDockMode("git");
    expect(useEditorStore.getState().rightDockMode).toBe("git");
    useEditorStore.getState().setRightDockMode("inspector");
    expect(useEditorStore.getState().rightDockMode).toBe("inspector");
  });

  it("clearPendingLine wipes the jump-to flag", () => {
    useEditorStore.getState().openFile("/x.ts", 5);
    useEditorStore.getState().clearPendingLine("/x.ts");
    expect(
      useEditorStore.getState().tabs.find((t) => t.path === "/x.ts")
        ?.pendingLine,
    ).toBeUndefined();
  });

  it("caps the tab list and drops the oldest non-active when at capacity", () => {
    // Open 13 tabs; cap is 12. The oldest non-active should be dropped.
    for (let i = 0; i < 13; i++) {
      useEditorStore.getState().openFile(`/f${i}.ts`);
    }
    const tabs = useEditorStore.getState().tabs;
    expect(tabs.length).toBe(12);
    // /f0.ts was the first opened and was no longer active by the time the
    // cap was hit, so it should be the one evicted.
    expect(tabs.find((t) => t.path === "/f0.ts")).toBeUndefined();
    // Newest is active.
    expect(useEditorStore.getState().activePath).toBe("/f12.ts");
  });
});

describe("dirty buffers", () => {
  it("setBuffer marks a file dirty and typing back to the file clears it", () => {
    const store = useEditorStore.getState();
    store.openFile(`${ROOT}/a.ts`);
    store.setBuffer(`${ROOT}/a.ts`, "const a = 2;", "const a = 1;");
    expect(useEditorStore.getState().dirtyByPath[`${ROOT}/a.ts`]).toBe(
      "const a = 2;",
    );

    // Undoing back to what is on disk is not a change. A dot that stayed lit
    // here would mean "you touched this" rather than "this differs".
    store.setBuffer(`${ROOT}/a.ts`, "const a = 1;", "const a = 1;");
    expect(useEditorStore.getState().dirtyByPath).toEqual({});
  });

  it("revert throws the buffer away", () => {
    const store = useEditorStore.getState();
    store.setBuffer(`${ROOT}/a.ts`, "mine", "theirs");
    store.revert(`${ROOT}/a.ts`);
    expect(useEditorStore.getState().dirtyByPath).toEqual({});
  });

  it("closing a tab drops its buffer and its cached read", () => {
    const path = `${ROOT}/a.ts`;
    baseline(path, "on disk");
    const store = useEditorStore.getState();
    store.openFile(path);
    store.setBuffer(path, "typed", "on disk");

    store.closeTab(path);
    expect(useEditorStore.getState().dirtyByPath).toEqual({});
    // The baseline goes too: reopening must re-read, because this app's own
    // panes write to these files while the editor is not looking.
    expect(cachedFile(path)).toBeNull();
  });

  it("evicts the oldest CLEAN tab, skipping the ones holding unsaved work", () => {
    const store = useEditorStore.getState();
    for (let i = 0; i < 12; i++) store.openFile(`/f${i}.ts`);
    // The two oldest have edits in them; /f2.ts is the oldest clean one.
    store.setBuffer("/f0.ts", "typed", "on disk");
    store.setBuffer("/f1.ts", "typed", "on disk");

    store.openFile("/new.ts");

    const paths = useEditorStore.getState().tabs.map((t) => t.path);
    expect(paths).toHaveLength(12);
    expect(paths).toContain("/f0.ts");
    expect(paths).toContain("/f1.ts");
    expect(paths).not.toContain("/f2.ts");
  });

  it("lets the tab list past the cap rather than lose an unsaved edit", () => {
    const store = useEditorStore.getState();
    for (let i = 0; i < 12; i++) store.openFile(`/f${i}.ts`);
    // Every tab but the active one — which is not a candidate either — has an
    // edit in it, so there is nothing the cap is allowed to take.
    for (let i = 0; i < 11; i++) {
      store.setBuffer(`/f${i}.ts`, "typed", "on disk");
    }

    store.openFile("/new.ts");

    const paths = useEditorStore.getState().tabs.map((t) => t.path);
    expect(paths).toHaveLength(13);
    for (let i = 0; i < 11; i++) expect(paths).toContain(`/f${i}.ts`);

    // It comes back under the cap as soon as one of them is clean again.
    store.revert("/f0.ts");
    store.openFile("/another.ts");
    const after = useEditorStore.getState().tabs.map((t) => t.path);
    expect(after).toHaveLength(13);
    expect(after).not.toContain("/f0.ts");
  });
});

describe("save", () => {
  it("writes the buffer, clears the flag and moves the baseline", async () => {
    const path = `${ROOT}/a.ts`;
    baseline(path, "const a = 1;");
    const store = useEditorStore.getState();
    store.openFile(path);
    store.setBuffer(path, "const a = 2;", "const a = 1;");

    await expect(store.save(path)).resolves.toBe(true);

    expect(invoke).toHaveBeenCalledWith("fs_write_file", {
      projectRoot: ROOT,
      path,
      contents: "const a = 2;",
    });
    expect(useEditorStore.getState().dirtyByPath).toEqual({});
    // The baseline has to move with the bytes, or the next external-change
    // check reads our own save as somebody else's edit.
    expect(cachedFile(path)?.content).toBe("const a = 2;");
  });

  it("defaults to the active tab", async () => {
    const store = useEditorStore.getState();
    store.openFile(`${ROOT}/a.ts`);
    store.openFile(`${ROOT}/b.ts`);
    store.setBuffer(`${ROOT}/b.ts`, "b", "");

    await store.save();
    expect(invoke).toHaveBeenCalledWith(
      "fs_write_file",
      expect.objectContaining({ path: `${ROOT}/b.ts` }),
    );
  });

  it("a clean file is a no-op that reports success", async () => {
    const store = useEditorStore.getState();
    store.openFile(`${ROOT}/a.ts`);
    // ⌘S is a reflex, not a request. Answering it with a failure — or with a
    // write of nothing — would both be wrong.
    await expect(store.save()).resolves.toBe(true);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("keeps the buffer and says why when the write is refused", async () => {
    const path = `${ROOT}/a.ts`;
    baseline(path, "on disk");
    invoke.mockRejectedValueOnce("path is outside the project root");
    const store = useEditorStore.getState();
    store.setBuffer(path, "typed", "on disk");

    await expect(store.save(path)).resolves.toBe(false);

    // The buffer survives a refused write — it is the only copy of the edit.
    expect(useEditorStore.getState().dirtyByPath[path]).toBe("typed");
    expect(cachedFile(path)?.content).toBe("on disk");
    const toast = useToastsStore.getState().items.at(-1);
    // Rust's own words, not ours: "outside the project root" tells the user
    // something "could not save" does not.
    expect(toast?.message).toContain("path is outside the project root");
    expect(toast?.tone).toBe("warn");
  });

  it("does not clear the flag when the user typed during the round trip", async () => {
    const path = `${ROOT}/a.ts`;
    baseline(path, "");
    const store = useEditorStore.getState();
    store.setBuffer(path, "first", "");

    let release: () => void = () => {};
    invoke.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = () => resolve();
        }),
    );
    const saving = store.save(path);
    // The user keeps typing while the write is in flight.
    store.setBuffer(path, "first and more", "");
    release();
    await saving;

    // Calling that saved would call an edit written that never reached disk.
    expect(useEditorStore.getState().dirtyByPath[path]).toBe("first and more");
  });

  it("keeps an edit made during the round trip that lands on the old file", async () => {
    const path = `${ROOT}/a.ts`;
    baseline(path, "one");
    const store = useEditorStore.getState();
    store.openFile(path);
    store.setBuffer(path, "one and two", "one");

    let release: () => void = () => {};
    invoke.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = () => resolve();
        }),
    );
    const saving = store.save(path);
    // The user deletes what they typed while the write is in flight, so the
    // buffer is now exactly the bytes the save is replacing. Measured against
    // the OLD baseline that reads as clean — and the save was about to move the
    // baseline on top of it, which undid the deletion and left no dirty dot to
    // show it had happened.
    store.setBuffer(path, "one", "one");
    release();
    await saving;

    expect(useEditorStore.getState().dirtyByPath[path]).toBe("one");
    // The disk has what was written; the buffer is the user's correction to it.
    expect(cachedFile(path)?.content).toBe("one and two");
  });

  it("settles against the untouched file when the write is refused", async () => {
    const path = `${ROOT}/a.ts`;
    baseline(path, "one");
    const store = useEditorStore.getState();
    store.setBuffer(path, "one and two", "one");

    let reject: () => void = () => {};
    invoke.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, fail) => {
          reject = () => fail("read-only file system");
        }),
    );
    const saving = store.save(path);
    store.setBuffer(path, "one", "one");
    reject();

    await expect(saving).resolves.toBe(false);
    // Nothing reached the disk, so the baseline never moved and a buffer equal
    // to it is not an edit — the dot goes away rather than pointing at a file
    // that matches its own contents.
    expect(useEditorStore.getState().dirtyByPath).toEqual({});
    expect(cachedFile(path)?.content).toBe("one");
  });

  it("refuses to write when the workspace has no project directory", async () => {
    openProject(null);
    const store = useEditorStore.getState();
    store.setBuffer("/elsewhere/a.ts", "typed", "");

    await expect(store.save("/elsewhere/a.ts")).resolves.toBe(false);
    expect(invoke).not.toHaveBeenCalled();
    expect(useToastsStore.getState().items.at(-1)?.message).toContain(
      "no project directory",
    );
  });
});

describe("saveAll", () => {
  it("writes every dirty buffer and reports once", async () => {
    const store = useEditorStore.getState();
    for (const name of ["a", "b", "c"]) {
      baseline(`${ROOT}/${name}.ts`, "");
      store.setBuffer(`${ROOT}/${name}.ts`, name, "");
    }

    await store.saveAll();

    expect(invoke).toHaveBeenCalledTimes(3);
    expect(useEditorStore.getState().dirtyByPath).toEqual({});
    const toasts = useToastsStore.getState().items;
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.message).toBe("Saved 3 files.");
  });

  it("counts the ones that failed and leaves their buffers alone", async () => {
    const store = useEditorStore.getState();
    for (const name of ["a", "b"]) {
      baseline(`${ROOT}/${name}.ts`, "");
      store.setBuffer(`${ROOT}/${name}.ts`, name, "");
    }
    invoke.mockRejectedValueOnce("read-only file system");

    await store.saveAll();

    const dirty = useEditorStore.getState().dirtyByPath;
    expect(Object.keys(dirty)).toEqual([`${ROOT}/a.ts`]);
    // Two toasts: the failure in Rust's words, and the count.
    const messages = useToastsStore.getState().items.map((t) => t.message);
    expect(messages.some((m) => m.includes("read-only file system"))).toBe(
      true,
    );
    expect(messages).toContain("Saved 1 of 2 files.");
  });

  it("says so when there is nothing to save", async () => {
    await useEditorStore.getState().saveAll();
    expect(invoke).not.toHaveBeenCalled();
    expect(useToastsStore.getState().items.at(-1)?.message).toBe(
      "Nothing to save — no unsaved changes.",
    );
  });

  // The sidebar's collapse flag is the right panel's twin, and the pair is
  // what the two topbar buttons drive. Independent by construction: hiding the
  // workspaces must not take the side panel with it.
  it("collapses the sidebar and the right panel independently", () => {
    const store = useEditorStore.getState();
    expect(store.sidebarCollapsed).toBe(false);
    expect(store.rightPanelCollapsed).toBe(false);

    useEditorStore.getState().toggleSidebarCollapsed();
    expect(useEditorStore.getState().sidebarCollapsed).toBe(true);
    expect(useEditorStore.getState().rightPanelCollapsed).toBe(false);

    useEditorStore.getState().toggleRightPanelCollapsed();
    expect(useEditorStore.getState().sidebarCollapsed).toBe(true);
    expect(useEditorStore.getState().rightPanelCollapsed).toBe(true);

    useEditorStore.getState().toggleSidebarCollapsed();
    expect(useEditorStore.getState().sidebarCollapsed).toBe(false);
    expect(useEditorStore.getState().rightPanelCollapsed).toBe(true);
  });

  it("setSidebarCollapsed is idempotent, so a drag that reports twice is one state", () => {
    useEditorStore.getState().setSidebarCollapsed(true);
    useEditorStore.getState().setSidebarCollapsed(true);
    expect(useEditorStore.getState().sidebarCollapsed).toBe(true);
    useEditorStore.getState().setSidebarCollapsed(false);
    expect(useEditorStore.getState().sidebarCollapsed).toBe(false);
  });
});
