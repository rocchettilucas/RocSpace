/** Theme registry — the single source of truth for RocSpace color palettes.
 *
 *  Every theme is 19 semantic tokens (see `types.ts`). `apply.ts` turns the
 *  active theme into `--rs-*` CSS custom properties; `xterm.ts`, `monaco.ts`
 *  and `accentColors.ts` derive their palettes from the same tokens, so a theme
 *  switch re-colors chrome, terminals and the editor in one pass.
 *
 *  Palettes live in `palettes/` — dark themes first, then light, which is also
 *  the order the picker renders them in. */

import { DARK_THEMES } from "@/themes/palettes/dark";
import { LIGHT_THEMES } from "@/themes/palettes/light";
import type { ThemeDefinition } from "@/themes/types";

export const DEFAULT_THEME_ID = "rocspace-dark";

export const THEMES: readonly ThemeDefinition[] = [
  ...DARK_THEMES,
  ...LIGHT_THEMES,
];

const BY_ID = new Map(THEMES.map((theme) => [theme.id, theme]));

/** Resolve a theme by id. Unknown / removed ids fall back to the default so a
 *  stale persisted setting can never leave the app unstyled. */
export function getTheme(id: string): ThemeDefinition {
  return BY_ID.get(id) ?? BY_ID.get(DEFAULT_THEME_ID)!;
}
