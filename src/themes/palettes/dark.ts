/** Dark palettes. Ordered as they appear in the theme picker.
 *
 *  Every theme is the same 19 tokens; the elevation ramp
 *  (background → panel → surface → surfaceHover → surfaceActive) gets
 *  progressively lighter, and border/borderHover sit alongside it.
 *  `borderActive` is the focus color, almost always the theme's accent. */

import type { ThemeDefinition } from "@/themes/types";

/** The pre-theme-engine RocSpace palette, tokenized verbatim. Values come from
 *  the old `@theme` block in styles.css (surfaces, text, accent, status) and
 *  useXterm.ts (termFg, purple = ANSI magenta). Do not drift these: this theme
 *  defines the app's default look. */
const rocspaceDark: ThemeDefinition = {
  id: "rocspace-dark",
  name: "RocSpace Dark",
  mode: "dark",
  description: "The house palette — deep indigo surfaces, violet accent.",
  tokens: {
    background: "#0a0c14",
    panel: "#10131c",
    surface: "#171b26",
    surfaceHover: "#212635",
    surfaceActive: "#2d3346",
    border: "#212635",
    borderHover: "#2d3346",
    borderActive: "#8b6cea",
    text: "#e9eaf2",
    text2: "#a8b0c2",
    text3: "#6c7388",
    primary: "#8b6cea",
    primaryFg: "#0a0c14",
    info: "#6ea8fe",
    success: "#4ade80",
    warning: "#fbbf24",
    danger: "#f87171",
    termFg: "#e9eaf2",
    purple: "#c084fc",
  },
  // The pre-theme-engine terminal palette, verbatim from `useXterm.ts`. The
  // derivation reproduces the other slots exactly; these seven do not fall out
  // of 19 tokens (the old cyan is a true cyan, not the info↔success midpoint,
  // and the old bright ramp is Tailwind's 300-level, not a 35% lean toward the
  // foreground). Pinned rather than "close enough": this is the default look.
  xterm: {
    // The one slot deliberately left on the background: the classic
    // "ANSI black == terminal background" mapping the old palette shipped
    // with. New themes get the derivation's readable black instead.
    black: "#0a0c14",
    cyan: "#22d3ee",
    brightRed: "#fca5a5",
    brightGreen: "#86efac",
    brightYellow: "#fde68a",
    brightBlue: "#93c5fd",
    brightMagenta: "#d8b4fe",
    brightCyan: "#67e8f9",
  },
  // Likewise from `monacoLoader.ts`: the editor selection is brand blue, not
  // the violet accent the derivation would pick.
  monaco: {
    selectionBackground: "#5363ff66",
    inactiveSelectionBackground: "#5363ff33",
  },
};

const dracula: ThemeDefinition = {
  id: "dracula",
  name: "Dracula",
  mode: "dark",
  description: "The classic — pink accent over soft slate.",
  tokens: {
    background: "#282a36",
    panel: "#2f303c",
    surface: "#333540",
    surfaceHover: "#3d3f49",
    surfaceActive: "#474952",
    border: "#41434d",
    borderHover: "#52535c",
    borderActive: "#ff79c6",
    text: "#e4e4e0",
    text2: "#a5a6a7",
    text3: "#9a9ca7",
    primary: "#ff79c6",
    primaryFg: "#282a36",
    info: "#8be9fd",
    success: "#50fa7b",
    warning: "#f1fa8c",
    danger: "#ff5555",
    termFg: "#f8f8f2",
    purple: "#bd93f9",
  },
};

const black: ThemeDefinition = {
  id: "black",
  name: "Black",
  mode: "dark",
  description: "Pure black, zero distraction — kind to OLED panels.",
  tokens: {
    background: "#000000",
    panel: "#050505",
    surface: "#0a0a0a",
    surfaceHover: "#141414",
    surfaceActive: "#1a1a1a",
    border: "#1f1f1f",
    borderHover: "#2a2a2a",
    borderActive: "rgba(255,255,255,.45)",
    text: "#ebebeb",
    text2: "#999999",
    text3: "#8c8c8c",
    primary: "#ffffff",
    primaryFg: "#000000",
    info: "#7b8794",
    success: "#4ade80",
    warning: "#facc15",
    danger: "#ef4444",
    termFg: "#ebebeb",
    purple: "#93c5fd",
  },
};

const gruvboxDark: ThemeDefinition = {
  id: "gruvbox-dark",
  name: "Gruvbox Dark",
  mode: "dark",
  description: "Retro warmth, amber accents, easy on long sessions.",
  tokens: {
    background: "#282828",
    panel: "#2e2e2c",
    surface: "#32312f",
    surfaceHover: "#3c3a36",
    surfaceActive: "#45433d",
    border: "#403e39",
    borderHover: "#4f4c44",
    borderActive: "#fc802d",
    text: "#d8c9a4",
    // Deliberate deviation from the Gruvbox values in the research doc, which
    // had these two the wrong way round: text3 (hints, disabled) must be the
    // quieter of the pair, and #a49c87 is the brighter tone.
    text2: "#a49c87",
    text3: "#9d937b",
    primary: "#fc802d",
    primaryFg: "#282828",
    info: "#689d6a",
    success: "#98971a",
    warning: "#d79921",
    danger: "#cc241d",
    termFg: "#ebdbb2",
    purple: "#83a598",
  },
};

const cyberWave: ThemeDefinition = {
  id: "cyber-wave",
  name: "Cyber Wave",
  mode: "dark",
  description: "Deep teal with neon highlights.",
  tokens: {
    background: "#001319",
    panel: "#081a20",
    surface: "#0d1f25",
    surfaceHover: "#1a2b30",
    surfaceActive: "#26363b",
    border: "#1f3035",
    borderHover: "#334247",
    borderActive: "#d0d1fe",
    text: "#e6e8e8",
    text2: "#99a1a3",
    text3: "#7d888b",
    primary: "#5a58b8",
    primaryFg: "#ffffff",
    info: "#d0d1fe",
    success: "#b4fa72",
    warning: "#fefdc2",
    danger: "#ff8272",
    termFg: "#ffffff",
    purple: "#a5d5fe",
  },
};

const oneDarkPro: ThemeDefinition = {
  id: "one-dark-pro",
  name: "One Dark Pro",
  mode: "dark",
  description: "Atom's One Dark — balanced blues, muted syntax.",
  tokens: {
    background: "#282c34",
    panel: "#2f343d",
    surface: "#353b45",
    surfaceHover: "#3e4451",
    surfaceActive: "#4b5263",
    border: "#3b4048",
    borderHover: "#4b5263",
    borderActive: "#61afef",
    text: "#d7dae0",
    text2: "#abb2bf",
    text3: "#7f8797",
    primary: "#61afef",
    primaryFg: "#282c34",
    info: "#56b6c2",
    success: "#98c379",
    warning: "#e5c07b",
    danger: "#e06c75",
    termFg: "#abb2bf",
    purple: "#c678dd",
  },
};

const tokyoNight: ThemeDefinition = {
  id: "tokyo-night",
  name: "Tokyo Night",
  mode: "dark",
  description: "Midnight blues with a neon skyline glow.",
  tokens: {
    background: "#1a1b26",
    panel: "#1f2335",
    surface: "#24283b",
    surfaceHover: "#2f334d",
    surfaceActive: "#3b4261",
    border: "#292e42",
    borderHover: "#3b4261",
    borderActive: "#7aa2f7",
    text: "#c0caf5",
    text2: "#a9b1d6",
    text3: "#7a82ab",
    primary: "#7aa2f7",
    primaryFg: "#1a1b26",
    info: "#7dcfff",
    success: "#9ece6a",
    warning: "#e0af68",
    danger: "#f7768e",
    termFg: "#c0caf5",
    purple: "#bb9af7",
  },
};

const nord: ThemeDefinition = {
  id: "nord",
  name: "Nord",
  mode: "dark",
  description: "Arctic, north-bluish and calm.",
  tokens: {
    background: "#2e3440",
    panel: "#3b4252",
    surface: "#434c5e",
    surfaceHover: "#4c566a",
    surfaceActive: "#5a677d",
    border: "#434c5e",
    borderHover: "#4c566a",
    borderActive: "#88c0d0",
    text: "#eceff4",
    text2: "#d8dee9",
    text3: "#8792a8",
    primary: "#88c0d0",
    primaryFg: "#2e3440",
    info: "#81a1c1",
    success: "#a3be8c",
    warning: "#ebcb8b",
    danger: "#bf616a",
    termFg: "#d8dee9",
    purple: "#b48ead",
  },
};

export const DARK_THEMES: readonly ThemeDefinition[] = [
  rocspaceDark,
  dracula,
  black,
  gruvboxDark,
  cyberWave,
  oneDarkPro,
  tokyoNight,
  nord,
];
