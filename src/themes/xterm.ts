/** Derive an xterm palette from theme tokens.
 *
 *  xterm needs 16 ANSI slots but a theme only carries 19 semantic tokens, so
 *  the mapping is: red/green/yellow/blue/magenta ← danger/success/warning/
 *  info/purple, cyan ← the midpoint of info and success, and every "bright"
 *  variant leans 35% toward the terminal foreground. On dark themes that reads
 *  as brighter; on light themes it darkens instead, which is what keeps bright
 *  colors legible on a pale background.
 *
 *  A theme may pin individual slots via `ThemeDefinition.xterm`; those literals
 *  are applied last and win over everything below. */

import type { ITheme } from "@xterm/xterm";
import { contrastRatio, mix, withAlpha } from "@/themes/colors";
import type { ThemeDefinition } from "@/themes/types";

/** How far a bright ANSI slot leans toward the terminal foreground. */
const BRIGHT_AMOUNT = 0.35;
/** Selection tint over the background (matches the pre-theme `#8b6cea55`). */
const SELECTION_ALPHA = 1 / 3;
/** Contrast an ANSI slot must clear against the terminal background.
 *
 *  Far below the WCAG text minimum on purpose: slots 0 and 7 are "the darkest"
 *  and "the palest" colors of the palette by definition, so the only bar is
 *  that neither *disappears* into the background. `derive.test.ts` asserts the
 *  resulting floor for every slot of every theme. */
const MIN_BACKGROUND_CONTRAST = 1.8;
/** Granularity of the `offBackground` walk — 2% of the way to the foreground. */
const OFF_BACKGROUND_STEPS = 50;

/** The tone nearest `background` that still clears `MIN_BACKGROUND_CONTRAST`,
 *  walking toward `toward`.
 *
 *  This builds the background end of the ANSI ramp — black on dark themes,
 *  white on light ones. Mapping that slot straight onto the background (as
 *  canonical Solarized Light does for white, and as this file used to) makes
 *  white-on-default text render at 1.00:1, i.e. invisible. Walking instead of
 *  using a fixed mix keeps the tone as close to the background as the theme
 *  allows: pale themes need a bigger step than a low-contrast one. */
function offBackground(background: string, toward: string): string {
  let result = background;
  for (let step = 0; step <= OFF_BACKGROUND_STEPS; step++) {
    result = mix(background, toward, step / OFF_BACKGROUND_STEPS);
    if (contrastRatio(result, background) >= MIN_BACKGROUND_CONTRAST) break;
  }
  return result;
}

export function xtermThemeFor(theme: ThemeDefinition): ITheme {
  const t = theme.tokens;
  const bright = (color: string) => mix(color, t.termFg, BRIGHT_AMOUNT);
  // ANSI black must stay the darkest tone and white the palest one, in both
  // modes — on a light theme that means black comes from the text color and
  // white from the background end of the ramp, not the other way round. The
  // background end is stepped off the background so it stays readable.
  const nearBackground = offBackground(t.background, t.termFg);
  const darkest = theme.mode === "dark" ? nearBackground : t.text;
  const lightest = theme.mode === "dark" ? t.termFg : nearBackground;
  const cyan = mix(t.info, t.success, 0.5);

  return {
    background: t.background,
    foreground: t.termFg,
    cursor: t.primary,
    cursorAccent: t.background,
    selectionBackground: withAlpha(t.primary, SELECTION_ALPHA),

    black: darkest,
    red: t.danger,
    green: t.success,
    yellow: t.warning,
    blue: t.info,
    magenta: t.purple,
    cyan,
    white: lightest,

    brightBlack: t.text3,
    brightRed: bright(t.danger),
    brightGreen: bright(t.success),
    brightYellow: bright(t.warning),
    brightBlue: bright(t.info),
    brightMagenta: bright(t.purple),
    brightCyan: bright(cyan),
    // On light themes the whole bright ramp darkens rather than lightens, and
    // brightWhite is no exception: anything paler than `lightest` would land
    // back on the background.
    brightWhite: theme.mode === "dark" ? "#ffffff" : bright(lightest),

    // Theme-pinned literals win: see `ThemeDefinition.xterm`.
    ...theme.xterm,
  };
}
