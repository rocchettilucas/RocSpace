/** The editor became writable, which added three moments where guessing costs
 *  somebody their work: closing a tab over an unsaved buffer, a file changing
 *  on disk under one, and ⌘S from wherever the user happens to be standing. */

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

/** Monaco itself is 3–5 MB of editor and a worker bundle; what these tests are
 *  about is the two things `MonacoPane` decides — what it shows and whether it
 *  is taking edits — so the editor is a textarea that reports both. */
vi.mock("@/views/RocDock/EditorView/monacoLoader", () => ({
  configureMonaco: () => {},
}));
vi.mock("@monaco-editor/react", () => ({
  default: ({
    value,
    options,
    onChange,
  }: {
    value?: string;
    options?: { readOnly?: boolean };
    onChange?: (next: string) => void;
  }) => (
    <textarea
      aria-label="Editor"
      value={value ?? ""}
      readOnly={options?.readOnly ?? false}
      onChange={(e) => onChange?.(e.target.value)}
    />
  ),
}));

import { newWorkspace } from "@/lib/factories";
import {
  cachedFile,
  peekExternal,
  putFile,
  resetFileContents,
} from "@/lib/fileContents";
import { resetToastsState } from "@/stores";
import { useEditorStore } from "@/stores/editor";
import { useUIStore } from "@/stores/ui";
import { useWorkspacesStore } from "@/stores/workspaces";
import { EditorPrompts } from "@/views/RocDock/EditorView/EditorPrompts";
import { MonacoPane } from "@/views/RocDock/EditorView/MonacoPane";
import { TabStrip } from "@/views/RocDock/EditorView/TabStrip";
import { useEditorShortcuts } from "@/views/RocDock/EditorView/useEditorShortcuts";
import { useExternalChanges } from "@/views/RocDock/EditorView/useExternalChanges";

const ROOT = "/code/rocspace";
const PATH = `${ROOT}/src/App.tsx`;

function openProject(): void {
  const workspace = {
    ...newWorkspace({ projectPath: ROOT, order: 0 }),
    id: "w_1",
  };
  useWorkspacesStore.setState({
    workspaces: [workspace],
    activeWorkspaceId: "w_1",
  });
}

/** Seed a baseline as if the file had been read, then type into it. */
function openDirty(path: string, onDisk: string, typed: string): void {
  putFile(path, {
    path,
    content: onDisk,
    size: onDisk.length,
    language: null,
    writable: true,
  });
  useEditorStore.getState().openFile(path);
  useEditorStore.getState().setBuffer(path, typed, onDisk);
}

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
  resetFileContents();
  resetToastsState();
  useEditorStore.setState({ tabs: [], activePath: null, dirtyByPath: {} });
  useUIStore.setState({ editorPrompt: null, isSettingsOpen: false });
  openProject();
});

describe("the tab strip", () => {
  it("closes a clean tab on one click", async () => {
    useEditorStore.getState().openFile(PATH);
    render(<TabStrip />);

    fireEvent.click(screen.getByRole("button", { name: "Close App.tsx" }));

    expect(useEditorStore.getState().tabs).toHaveLength(0);
    expect(useUIStore.getState().editorPrompt).toBeNull();
  });

  it("asks first when the tab is holding unsaved work", async () => {
    openDirty(PATH, "on disk", "typed");
    render(<TabStrip />);

    fireEvent.click(
      screen.getByRole("button", { name: "Close App.tsx (unsaved)" }),
    );

    // The tab is still there — the question has not been answered yet.
    expect(useEditorStore.getState().tabs).toHaveLength(1);
    expect(useUIStore.getState().editorPrompt).toEqual({
      type: "unsaved-close",
      path: PATH,
    });
  });
});

describe("the unsaved-close dialog", () => {
  beforeEach(() => {
    openDirty(PATH, "on disk", "typed");
    useUIStore
      .getState()
      .openEditorPrompt({ type: "unsaved-close", path: PATH });
  });

  it("writes the file before it closes the tab", async () => {
    render(<EditorPrompts />);

    fireEvent.click(screen.getByRole("button", { name: "Save and close" }));

    await waitFor(() => {
      expect(useEditorStore.getState().tabs).toHaveLength(0);
    });
    expect(invoke).toHaveBeenCalledWith("fs_write_file", {
      projectRoot: ROOT,
      path: PATH,
      contents: "typed",
    });
    expect(useUIStore.getState().editorPrompt).toBeNull();
  });

  it("keeps the tab open when the write is refused", async () => {
    invoke.mockRejectedValueOnce("read-only file system");
    render(<EditorPrompts />);

    fireEvent.click(screen.getByRole("button", { name: "Save and close" }));

    // Closing on a failed save would discard the buffer AND report the failure
    // in a toast — the worst of both answers.
    await waitFor(() => {
      expect(useEditorStore.getState().dirtyByPath[PATH]).toBe("typed");
    });
    expect(useEditorStore.getState().tabs).toHaveLength(1);
    expect(useUIStore.getState().editorPrompt).not.toBeNull();
  });

  it("discard closes the tab and writes nothing", async () => {
    render(<EditorPrompts />);

    fireEvent.click(screen.getByRole("button", { name: "Discard" }));

    expect(useEditorStore.getState().tabs).toHaveLength(0);
    expect(useEditorStore.getState().dirtyByPath).toEqual({});
    expect(invoke).not.toHaveBeenCalled();
  });

  it("cancel leaves everything exactly as it was", async () => {
    render(<EditorPrompts />);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(useEditorStore.getState().tabs).toHaveLength(1);
    expect(useEditorStore.getState().dirtyByPath[PATH]).toBe("typed");
    expect(useUIStore.getState().editorPrompt).toBeNull();
  });
});

describe("a file that changed on disk", () => {
  function Watcher() {
    useExternalChanges();
    return null;
  }

  const fromDisk = (content: string) => ({
    path: PATH,
    content,
    size: content.length,
    language: null,
    writable: true,
  });

  it("reloads silently when there is nothing unsaved", async () => {
    putFile(PATH, fromDisk("version one"));
    useEditorStore.getState().openFile(PATH);
    invoke.mockResolvedValue(fromDisk("version two"));

    render(<Watcher />);

    await waitFor(() => {
      expect(cachedFile(PATH)?.content).toBe("version two");
    });
    // Nothing to ask about: the user has written nothing the disk would take.
    expect(useUIStore.getState().editorPrompt).toBeNull();
  });

  it("asks when the buffer is dirty, and keeps mine on request", async () => {
    openDirty(PATH, "version one", "mine");
    invoke.mockResolvedValue(fromDisk("theirs"));

    render(
      <>
        <Watcher />
        <EditorPrompts />
      </>,
    );

    await screen.findByRole("button", { name: "Keep mine" });
    expect(peekExternal(PATH)?.content).toBe("theirs");

    fireEvent.click(screen.getByRole("button", { name: "Keep mine" }));

    // The buffer survives; the BASELINE moves to what is on disk, so the same
    // question is not asked again on the next focus.
    expect(useEditorStore.getState().dirtyByPath[PATH]).toBe("mine");
    expect(cachedFile(PATH)?.content).toBe("theirs");
    expect(peekExternal(PATH)).toBeNull();
    expect(useUIStore.getState().editorPrompt).toBeNull();
  });

  it("takes theirs on request, dropping the buffer", async () => {
    openDirty(PATH, "version one", "mine");
    invoke.mockResolvedValue(fromDisk("theirs"));

    render(
      <>
        <Watcher />
        <EditorPrompts />
      </>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Take theirs" }));

    expect(useEditorStore.getState().dirtyByPath).toEqual({});
    expect(cachedFile(PATH)?.content).toBe("theirs");
  });

  it("leaves a dirty buffer alone when the file has gone", async () => {
    openDirty(PATH, "version one", "mine");
    invoke.mockRejectedValue("path not accessible: No such file or directory");

    render(
      <>
        <Watcher />
        <EditorPrompts />
      </>,
    );

    await act(async () => {
      await Promise.resolve();
    });
    // The buffer may be the only copy left, and a dialog offering to take a
    // file that is not there is no offer at all.
    expect(useEditorStore.getState().dirtyByPath[PATH]).toBe("mine");
    expect(useUIStore.getState().editorPrompt).toBeNull();
  });

  it("says nothing when a save is what changed the file", async () => {
    openDirty(PATH, "version one", "mine");
    // The disk now says exactly what the buffer does — someone else made the
    // same edit, or our own save landed. Not a conflict; not even a change.
    invoke.mockResolvedValue(fromDisk("mine"));

    render(
      <>
        <Watcher />
        <EditorPrompts />
      </>,
    );

    await waitFor(() => {
      expect(useEditorStore.getState().dirtyByPath).toEqual({});
    });
    expect(useUIStore.getState().editorPrompt).toBeNull();
  });
});

describe("a file the sandbox would refuse to write", () => {
  const onDisk = (writable: boolean) => ({
    path: PATH,
    content: "locked",
    size: 6,
    language: null,
    writable,
  });

  it("is shown read-only, with the reason on screen", async () => {
    invoke.mockResolvedValue(onDisk(false));
    useEditorStore.getState().openFile(PATH);

    render(<MonacoPane projectRoot={ROOT} />);
    const field = await screen.findByLabelText("Editor");

    // Taking the edit and failing at ⌘S would be a permission error delivered
    // over work already done. The refusal belongs before the typing.
    expect(field).toHaveAttribute("readonly");
    expect(screen.getByRole("status")).toHaveTextContent(/Read-only/);

    fireEvent.change(field, { target: { value: "typed" } });
    expect(useEditorStore.getState().dirtyByPath).toEqual({});
  });

  it("takes edits, and says nothing, when the file is writable", async () => {
    invoke.mockResolvedValue(onDisk(true));
    useEditorStore.getState().openFile(PATH);

    render(<MonacoPane projectRoot={ROOT} />);
    const field = await screen.findByLabelText("Editor");

    expect(field).not.toHaveAttribute("readonly");
    expect(screen.queryByRole("status")).toBeNull();

    fireEvent.change(field, { target: { value: "typed" } });
    expect(useEditorStore.getState().dirtyByPath[PATH]).toBe("typed");
  });
});

describe("⌘S", () => {
  function Shortcuts() {
    useEditorShortcuts();
    return null;
  }

  const press = () => fireEvent.keyDown(document, { key: "s", metaKey: true });

  it("saves the active tab", async () => {
    openDirty(PATH, "on disk", "typed");
    render(<Shortcuts />);

    press();

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("fs_write_file", {
        projectRoot: ROOT,
        path: PATH,
        contents: "typed",
      });
    });
  });

  it("fires from inside the code editor, where a text field would not", async () => {
    openDirty(PATH, "on disk", "typed");
    render(<Shortcuts />);

    // Monaco's sink is a textarea, so the ordinary typing-target rule would
    // make ⌘S dead in the one place it means anything.
    const editor = document.createElement("div");
    editor.className = "monaco-editor";
    const sink = document.createElement("textarea");
    editor.appendChild(sink);
    document.body.appendChild(editor);
    sink.focus();

    press();

    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    document.body.removeChild(editor);
  });

  it("stands down in an ordinary text field", async () => {
    openDirty(PATH, "on disk", "typed");
    render(
      <>
        <Shortcuts />
        <input aria-label="rename" />
      </>,
    );
    screen.getByLabelText("rename").focus();

    press();

    expect(invoke).not.toHaveBeenCalled();
  });

  it("stands down while a modal holds the window", async () => {
    openDirty(PATH, "on disk", "typed");
    useUIStore.setState({ isSettingsOpen: true });
    render(<Shortcuts />);

    press();

    expect(invoke).not.toHaveBeenCalled();
  });

  it("is claimed even with nothing to save, and writes nothing", async () => {
    useEditorStore.getState().openFile(PATH);
    render(<Shortcuts />);
    const seen: KeyboardEvent[] = [];
    document.addEventListener("keydown", (e) => seen.push(e));

    press();

    // Claimed: an unclaimed ⌘S reaches the webview's own save dialog.
    expect(seen.at(-1)?.defaultPrevented).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
  });
});
