/** Theme token schema.
 *
 *  RocSpace themes are defined by 19 semantic color tokens. Everything the app
 *  renders — chrome, terminals, the editor, group accents — derives from these
 *  (directly, or via `color-mix()` in CSS). Adding a hard-coded hex anywhere
 *  else breaks theming, so route new colors through a token or a mix of tokens.
 *
 *  The tokens are applied as CSS custom properties (`--rs-*`) on
 *  `document.documentElement` — see `src/themes/apply.ts`. */

export interface ThemeTokens {
  /** App background — the deepest surface. */
  background: string;
  /** Sidebar / topbar / panel backgrounds — one step up from `background`. */
  panel: string;
  /** Cards, inputs, popovers — two steps up. */
  surface: string;
  /** Hovered card / input. */
  surfaceHover: string;
  /** Pressed or selected card / input. */
  surfaceActive: string;
  /** Default hairline border. */
  border: string;
  /** Border on hover. */
  borderHover: string;
  /** Border on the focused / selected element (usually the accent). */
  borderActive: string;
  /** Primary text. */
  text: string;
  /** Secondary text (labels, captions). */
  text2: string;
  /** Muted text (hints, disabled). */
  text3: string;
  /** Signature accent — buttons, cursor, active affordances. */
  primary: string;
  /** Foreground that stays legible on top of `primary`. */
  primaryFg: string;
  /** Informational accent (also drives terminal blue). */
  info: string;
  /** Success accent (also drives terminal green). */
  success: string;
  /** Warning accent (also drives terminal yellow). */
  warning: string;
  /** Danger accent (also drives terminal red). */
  danger: string;
  /** Terminal foreground — the default text color inside xterm. */
  termFg: string;
  /** Secondary accent (also drives terminal magenta). */
  purple: string;
}

/** Light or dark. Drives `color-scheme`, the native window appearance, and how
 *  the picker groups themes. */
export type ThemeMode = "dark" | "light";

export interface ThemeDefinition {
  /** Stable kebab-case identifier — persisted in settings.dat. */
  id: string;
  /** Display name shown on the theme card. */
  name: string;
  mode: ThemeMode;
  /** One line, shown under the name on the theme card. */
  description: string;
  tokens: ThemeTokens;
  /** Literal xterm slots that win over the derivation in `xterm.ts`.
   *
   *  Escape hatch, not a design surface: a theme that pins a slot opts out of
   *  the legibility floor the derivation guarantees for it, so every entry
   *  needs a reason. Today the only user is `rocspace-dark`, which pins the
   *  palette `useXterm.ts` hard-coded before the theme engine existed so the
   *  default terminal is byte-identical to what shipped. */
  xterm?: Partial<XtermThemeOverrides>;
  /** Literal Monaco colors that win over the derivation in `monaco.ts`.
   *  Same caveat as `xterm` — `rocspace-dark` pins the brand-blue selection
   *  `monacoLoader.ts` used to hard-code. */
  monaco?: {
    selectionBackground?: string;
    inactiveSelectionBackground?: string;
  };
}

/** The xterm keys a theme may pin. Mirrors the subset of `ITheme` that
 *  `xterm.ts` derives — kept as its own type so `types.ts` stays free of a
 *  runtime dependency on the terminal package. */
export interface XtermThemeOverrides {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

/** Runtime list of token keys, in the order they are written as CSS vars.
 *  Kept in sync with `ThemeTokens` by `registry.test.ts`. */
export const THEME_TOKEN_KEYS = [
  "background",
  "panel",
  "surface",
  "surfaceHover",
  "surfaceActive",
  "border",
  "borderHover",
  "borderActive",
  "text",
  "text2",
  "text3",
  "primary",
  "primaryFg",
  "info",
  "success",
  "warning",
  "danger",
  "termFg",
  "purple",
] as const satisfies readonly (keyof ThemeTokens)[];

export type ThemeTokenKey = (typeof THEME_TOKEN_KEYS)[number];
