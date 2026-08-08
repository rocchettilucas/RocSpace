/** Light palettes.
 *
 *  Same 19 tokens as the dark themes, but the elevation ramp runs the other
 *  way: `background` is the lightest tone and each step down the ramp gets
 *  slightly darker. `termFg` is dark here — the derivations in xterm.ts read
 *  `mode` and flip ANSI black/white accordingly. */

import type { ThemeDefinition } from "@/themes/types";

const light: ThemeDefinition = {
  id: "light",
  name: "Light",
  mode: "light",
  description: "Clean and bright for daylight work.",
  tokens: {
    background: "#fafbfc",
    panel: "#f5f6f8",
    surface: "#f0f2f5",
    surfaceHover: "#e5e8ed",
    surfaceActive: "#dce2ea",
    border: "#d1d5dc",
    borderHover: "#bcc5d2",
    borderActive: "#2563eb",
    text: "#1a1d26",
    text2: "#4b5563",
    text3: "#5b6472",
    primary: "#2563eb",
    primaryFg: "#ffffff",
    info: "#0891b2",
    success: "#16a34a",
    warning: "#ca8a04",
    danger: "#dc2626",
    termFg: "#1a1d26",
    purple: "#7c3aed",
  },
};

const solarizedLight: ThemeDefinition = {
  id: "solarized-light",
  name: "Solarized Light",
  mode: "light",
  description: "Warm paper tones with precision-tuned accents.",
  tokens: {
    background: "#fdf6e3",
    panel: "#f7f1de",
    surface: "#eee8d5",
    surfaceHover: "#e6dfc8",
    surfaceActive: "#dcd5be",
    border: "#e0d9c3",
    borderHover: "#d3cbb2",
    borderActive: "#268bd2",
    text: "#073642",
    text2: "#586e75",
    text3: "#657b83",
    primary: "#268bd2",
    primaryFg: "#fdf6e3",
    info: "#2aa198",
    success: "#859900",
    warning: "#b58900",
    danger: "#dc322f",
    termFg: "#657b83",
    purple: "#6c71c4",
  },
};

export const LIGHT_THEMES: readonly ThemeDefinition[] = [light, solarizedLight];
