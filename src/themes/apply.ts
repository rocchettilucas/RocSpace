/** Apply a theme to the document.
 *
 *  One call writes everything the rest of the app reads:
 *    • `data-theme="<id>"` on <html> — for theme-specific CSS escape hatches
 *      and for tests/devtools to see which theme is live;
 *    • the 19 `--rs-*` custom properties — Tailwind tokens (styles.css) and
 *      every `color-mix()` in the codebase resolve through these;
 *    • `color-scheme` — so native widgets (scrollbars, form controls, the
 *      webview's own background) follow light/dark;
 *    • the native window's appearance and background color — the title bar,
 *      its controls, and whatever shows at the growing edge of a resize are
 *      outside the webview and have to be told separately.
 *
 *  Terminals and Monaco are *not* touched here: they own imperative APIs and
 *  subscribe to the settings store instead (see `useXterm.ts` /
 *  `monacoLoader.ts`). */

import { syncNativeWindowTheme } from "@/themes/nativeWindow";
import { getTheme } from "@/themes/registry";
import {
  THEME_TOKEN_KEYS,
  type ThemeDefinition,
  type ThemeTokenKey,
} from "@/themes/types";

/** token key → CSS custom property name. Keep in sync with `styles.css`. */
export const CSS_VAR_BY_TOKEN: Record<ThemeTokenKey, string> = {
  background: "--rs-background",
  panel: "--rs-panel",
  surface: "--rs-surface",
  surfaceHover: "--rs-surface-hover",
  surfaceActive: "--rs-surface-active",
  border: "--rs-border",
  borderHover: "--rs-border-hover",
  borderActive: "--rs-border-active",
  text: "--rs-text",
  text2: "--rs-text-2",
  text3: "--rs-text-3",
  primary: "--rs-primary",
  primaryFg: "--rs-primary-fg",
  info: "--rs-info",
  success: "--rs-success",
  warning: "--rs-warning",
  danger: "--rs-danger",
  termFg: "--rs-term-fg",
  purple: "--rs-purple",
};

/** Write `theme` onto <html>. Exported for callers that already resolved the
 *  definition (theme previews, tests); most code wants `applyTheme(id)`. */
export function applyThemeDefinition(theme: ThemeDefinition): void {
  const root = document.documentElement;
  root.setAttribute("data-theme", theme.id);
  root.style.colorScheme = theme.mode;
  for (const key of THEME_TOKEN_KEYS) {
    root.style.setProperty(CSS_VAR_BY_TOKEN[key], theme.tokens[key]);
  }
  syncNativeWindowTheme(theme);
}

/** Apply the theme with this id (unknown ids fall back to the default). */
export function applyTheme(id: string): void {
  applyThemeDefinition(getTheme(id));
}
