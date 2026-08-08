/** The selected file's diff, in Monaco.
 *
 *  Its own module, and the only place in the Git panel that imports Monaco:
 *  `monacoLoader` pulls in five web workers through Vite's `?worker` syntax, so
 *  anything that imports this transitively drags the whole editor into its
 *  bundle — and into any test that renders it. `GitView` is unit-tested; this
 *  is mocked there.
 *
 *  Inline rather than side by side. The right panel is a column between 18% and
 *  50% of the window: two gutters and two viewports inside that is four columns
 *  of about forty characters, and every real line wraps or scrolls out of
 *  sight. */

import { useMemo } from "react";
import { DiffEditor } from "@monaco-editor/react";
import { monacoLanguageForPath, parseUnifiedDiff } from "@/lib/gitDiff";
import { MONACO_THEME_NAME } from "@/themes/monaco";
import { configureMonaco } from "@/views/RocDock/EditorView/monacoLoader";

configureMonaco();

export function GitDiffPane({ path, diff }: { path: string; diff: string }) {
  const parsed = useMemo(() => parseUnifiedDiff(diff), [diff]);

  if (parsed.note !== null) {
    return (
      <div className="grid h-full place-items-center px-6 text-center text-xs text-fg-muted">
        {parsed.note}
      </div>
    );
  }

  return (
    <DiffEditor
      // Keyed on the path so switching files gives Monaco fresh models rather
      // than asking it to re-diff in place — the scroll position of the file
      // you just left is not a sensible place to open the next one.
      key={path}
      height="100%"
      width="100%"
      language={monacoLanguageForPath(path)}
      original={parsed.original}
      modified={parsed.modified}
      theme={MONACO_THEME_NAME}
      options={{
        readOnly: true,
        // Belt and braces: `readOnly` covers the right-hand side, this covers
        // the left. A diff of the index is not somewhere to type.
        originalEditable: false,
        renderSideBySide: false,
        renderOverviewRuler: false,
        minimap: { enabled: false },
        fontFamily: '"JetBrains Mono", "SF Mono", Menlo, Monaco, monospace',
        fontSize: 12,
        lineHeight: 18,
        scrollBeyondLastLine: false,
        smoothScrolling: true,
        wordWrap: "off",
        automaticLayout: true,
      }}
    />
  );
}

export default GitDiffPane;
