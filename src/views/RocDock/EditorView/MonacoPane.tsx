import { useEffect, useRef } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import type { editor as MonacoEditor } from "monaco-editor";
import { useActiveEditorTab, useDirtyBuffer, useEditorStore } from "@/stores";
import { useFileContents } from "@/views/RocDock/EditorView/useFileContents";
import { configureMonaco } from "@/views/RocDock/EditorView/monacoLoader";
import { MONACO_THEME_NAME } from "@/themes/monaco";

configureMonaco();

interface MonacoPaneProps {
  projectRoot: string;
}

export function MonacoPane({ projectRoot }: MonacoPaneProps) {
  const tab = useActiveEditorTab();
  const clearPendingLine = useEditorStore((s) => s.clearPendingLine);
  const setBuffer = useEditorStore((s) => s.setBuffer);
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const { status, data, error } = useFileContents(
    projectRoot,
    tab?.path ?? null,
  );
  // The unsaved buffer, when there is one. What the editor SHOWS is the buffer
  // over the baseline: a tab switched away from and back must come back with
  // the user's edit, not with the file.
  const buffer = useDirtyBuffer(tab?.path ?? null);

  // Reveal the requested line whenever a fresh content load lands and the tab
  // has a pendingLine. We also re-reveal if the user clicks the same path
  // again with a new line (pendingLine bumped by openFile).
  useEffect(() => {
    if (!tab || !editorRef.current || status !== "ready") return;
    if (tab.pendingLine !== undefined) {
      const line = Math.max(1, tab.pendingLine);
      editorRef.current.revealLineInCenter(line);
      editorRef.current.setPosition({ lineNumber: line, column: 1 });
      clearPendingLine(tab.path);
    }
  }, [tab, status, clearPendingLine]);

  const handleMount: OnMount = (editor) => {
    editorRef.current = editor;
  };

  if (!tab) {
    return (
      <div className="grid h-full place-items-center text-xs text-fg-muted">
        Select a file from the tree to start.
      </div>
    );
  }

  if (status === "loading" || status === "idle") {
    return (
      <div className="grid h-full place-items-center text-xs text-fg-muted">
        Loading {tab.name}…
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="grid h-full place-items-center px-6 text-center text-xs text-status-error">
        <div>
          <div className="mb-1 font-semibold">Couldn't open {tab.name}</div>
          <div className="text-fg-muted">{error}</div>
        </div>
      </div>
    );
  }

  const baseline = data?.content ?? "";
  // A file the sandbox would refuse to write is shown, not offered. Monaco
  // would happily take an edit to it and ⌘S would then fail — which is a
  // permission error delivered at the worst possible moment, over work that
  // has already been done. The reason is on screen instead, where it costs
  // nothing. `writable` is a moment out of date by definition (the mode can
  // change under an open tab); `fs_write_file` asks again and its answer is
  // the one that decides.
  const readOnly = data?.writable !== true;

  return (
    <div className="flex h-full flex-col">
      {readOnly ? (
        <div
          role="status"
          className="shrink-0 border-b border-border bg-surface-2 px-3 py-1.5 text-[11px] text-fg-muted"
        >
          <span className="font-medium text-fg-secondary">Read-only</span> —{" "}
          {tab.name} cannot be written with its current permissions, so the
          editor is not taking edits to it.
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        <Editor
          key={tab.path}
          height="100%"
          width="100%"
          language={data?.language ?? "plaintext"}
          value={buffer ?? baseline}
          theme={MONACO_THEME_NAME}
          onMount={handleMount}
          // Every keystroke, measured against the baseline rather than
          // accumulated: typing a character and deleting it again leaves a file
          // that is not dirty, which is the difference between a dot that means
          // something and one that only means "you touched this".
          //
          // The `readOnly` guard is not Monaco's job to do twice — it is that a
          // buffer for an unwritable file is the exact thing this pane must not
          // create, and `options.readOnly` is a request to a component while
          // this is the rule.
          onChange={(next) => {
            if (readOnly) return;
            setBuffer(tab.path, next ?? "", baseline);
          }}
          options={{
            readOnly,
            minimap: { enabled: false },
            fontFamily: '"JetBrains Mono", "SF Mono", Menlo, Monaco, monospace',
            fontSize: 12,
            lineHeight: 18,
            scrollBeyondLastLine: false,
            renderLineHighlight: "line",
            smoothScrolling: true,
            wordWrap: "off",
            automaticLayout: true,
          }}
        />
      </div>
    </div>
  );
}

export default MonacoPane;
