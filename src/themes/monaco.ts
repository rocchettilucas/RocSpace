/** Derive the Monaco editor theme from theme tokens.
 *
 *  The theme NAME is constant (`rocspace-themed`) so components can hard-code
 *  it: switching themes redefines the same name and re-applies it, instead of
 *  registering a new theme per palette.
 *
 *  A theme may pin its selection colors via `ThemeDefinition.monaco`; those
 *  literals are applied last and win over the derivation. */

import type { editor } from "monaco-editor";
import { withAlpha } from "@/themes/colors";
import type { ThemeDefinition } from "@/themes/types";

export const MONACO_THEME_NAME = "rocspace-themed";

export function monacoThemeFor(theme: ThemeDefinition): {
  name: string;
  data: editor.IStandaloneThemeData;
} {
  const t = theme.tokens;
  const selection =
    theme.monaco?.selectionBackground ?? withAlpha(t.primary, 0.4);
  const inactiveSelection =
    theme.monaco?.inactiveSelectionBackground ?? withAlpha(t.primary, 0.2);
  return {
    name: MONACO_THEME_NAME,
    data: {
      // `vs` / `vs-dark` supply the syntax token rules; we only override the
      // chrome colors so highlighting stays sane on every palette.
      base: theme.mode === "light" ? "vs" : "vs-dark",
      inherit: true,
      rules: [],
      colors: {
        "editor.background": t.background,
        "editor.foreground": t.text,
        "editorLineNumber.foreground": t.text3,
        "editorLineNumber.activeForeground": t.text2,
        "editor.selectionBackground": selection,
        "editor.inactiveSelectionBackground": inactiveSelection,
        "editorCursor.foreground": t.primary,
        "editor.lineHighlightBackground": t.panel,
        "editorIndentGuide.background1": t.surface,
        "editorIndentGuide.activeBackground1": t.surfaceActive,
        "editorWidget.background": t.panel,
        "editorWidget.border": t.borderHover,
        "scrollbarSlider.background": withAlpha(t.surfaceHover, 0.5),
        "scrollbarSlider.hoverBackground": withAlpha(t.surfaceActive, 0.8),
        "scrollbarSlider.activeBackground": t.surfaceActive,
        "minimap.background": t.background,
      },
    },
  };
}
