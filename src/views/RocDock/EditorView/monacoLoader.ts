/** Wire Monaco workers + theme. Runs once when MonacoPane is first imported.
 *
 *  We import Monaco from local node_modules (not CDN) so the editor works
 *  offline inside the Tauri webview. Vite's `?worker` syntax bundles each
 *  worker as a separate chunk; `MonacoEnvironment.getWorker` hands them out
 *  to Monaco at runtime. */

import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import { useSettingsStore } from "@/stores/settings";
import { monacoThemeFor } from "@/themes/monaco";
import { getTheme } from "@/themes/registry";

import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

declare global {
  interface Window {
    MonacoEnvironment?: monaco.Environment;
  }
}

let configured = false;

export function configureMonaco(): void {
  if (configured) return;
  configured = true;

  self.MonacoEnvironment = {
    getWorker(_workerId, label) {
      if (label === "json") return new jsonWorker();
      if (label === "css" || label === "scss" || label === "less")
        return new cssWorker();
      if (label === "html" || label === "handlebars" || label === "razor")
        return new htmlWorker();
      if (label === "typescript" || label === "javascript")
        return new tsWorker();
      return new editorWorker();
    },
  };

  // Theme is derived from the active RocSpace theme tokens (src/themes/
  // monaco.ts). The name never changes, so a theme switch just re-defines it
  // and re-applies it to every open editor.
  applyMonacoTheme(useSettingsStore.getState().themeId);
  useSettingsStore.subscribe((state, prev) => {
    if (state.themeId === prev.themeId) return;
    applyMonacoTheme(state.themeId);
  });

  loader.config({ monaco });
}

function applyMonacoTheme(themeId: string): void {
  const { name, data } = monacoThemeFor(getTheme(themeId));
  monaco.editor.defineTheme(name, data);
  // defineTheme alone does not repaint editors that already resolved the
  // theme, so re-select it.
  monaco.editor.setTheme(name);
}
