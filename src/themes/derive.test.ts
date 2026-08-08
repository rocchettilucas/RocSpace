import { describe, expect, it } from "vitest";
import { mix, parseColor, toHex, withAlpha } from "@/themes/colors";
import { monacoThemeFor, MONACO_THEME_NAME } from "@/themes/monaco";
import { getTheme, THEMES } from "@/themes/registry";
import { xtermThemeFor } from "@/themes/xterm";

const ANSI_SLOTS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

/** Contrast every ANSI slot has to clear against the terminal background.
 *  Not a WCAG bar — just "this slot is not invisible". */
const MIN_SLOT_CONTRAST = 1.6;

/** `<themeId>.<slot>` pairs allowed to sit on the background. The single entry
 *  is the pre-theme-engine default, where `useXterm.ts` hard-coded ANSI black
 *  to the app background; that literal is pinned byte-for-byte by the RocSpace
 *  Dark test below, and the derivation clears the floor for it once the pins
 *  are stripped. Nothing else may be exempt. */
const CONTRAST_EXEMPT = new Set(["rocspace-dark.black"]);

/** WCAG relative luminance. Written out here rather than imported from
 *  `colors.ts` so the derivation and the check on it cannot share the same
 *  luminance bug. */
function luminance(color: string): number {
  const { r, g, b } = parseColor(color);
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (hi + 0.05) / (lo + 0.05);
}

describe("color math", () => {
  it("parses every hex form plus rgb()/rgba()", () => {
    expect(parseColor("#8b6cea")).toEqual({ r: 139, g: 108, b: 234, a: 1 });
    expect(parseColor("#abc")).toEqual({ r: 170, g: 187, b: 204, a: 1 });
    expect(parseColor("#8b6cea80").a).toBeCloseTo(0.502, 2);
    expect(parseColor("rgba(255,255,255,.45)")).toEqual({
      r: 255,
      g: 255,
      b: 255,
      a: 0.45,
    });
    expect(parseColor("rgb(10, 12, 20)")).toEqual({
      r: 10,
      g: 12,
      b: 20,
      a: 1,
    });
  });

  it("falls back to opaque black instead of throwing on junk", () => {
    expect(parseColor("not-a-color")).toEqual({ r: 0, g: 0, b: 0, a: 1 });
  });

  it("round-trips through toHex and drops the alpha pair when opaque", () => {
    expect(toHex({ r: 10, g: 12, b: 20, a: 1 })).toBe("#0a0c14");
    expect(toHex({ r: 10, g: 12, b: 20, a: 0.5 })).toBe("#0a0c1480");
  });

  it("mixes in sRGB and clamps the amount", () => {
    expect(mix("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(mix("#000000", "#ffffff", 0)).toBe("#000000");
    expect(mix("#000000", "#ffffff", 5)).toBe("#ffffff");
    expect(mix("#6ea8fe", "#4ade80", 0.5)).toBe("#5cc3bf");
  });

  it("re-alphas a color", () => {
    expect(withAlpha("#8b6cea", 1 / 3)).toBe("#8b6cea55");
    expect(withAlpha("#8b6cea", 1)).toBe("#8b6cea");
  });
});

describe("xtermThemeFor", () => {
  it("keeps RocSpace Dark on the palette useXterm.ts used to hard-code", () => {
    // Every key of the pre-theme-engine `ROCSPACE_THEME` literal. The default
    // terminal must stay byte-identical to what shipped before the engine.
    expect(xtermThemeFor(getTheme("rocspace-dark"))).toEqual({
      background: "#0a0c14",
      foreground: "#e9eaf2",
      cursor: "#8b6cea",
      cursorAccent: "#0a0c14",
      selectionBackground: "#8b6cea55",
      black: "#0a0c14",
      red: "#f87171",
      green: "#4ade80",
      yellow: "#fbbf24",
      blue: "#6ea8fe",
      magenta: "#c084fc",
      cyan: "#22d3ee",
      white: "#e9eaf2",
      brightBlack: "#6c7388",
      brightRed: "#fca5a5",
      brightGreen: "#86efac",
      brightYellow: "#fde68a",
      brightBlue: "#93c5fd",
      brightMagenta: "#d8b4fe",
      brightCyan: "#67e8f9",
      brightWhite: "#ffffff",
    });
  });

  it("derives cyan and the bright ramp from the tokens", () => {
    // Tokyo Night pins nothing, so this is the derivation on its own.
    const theme = xtermThemeFor(getTheme("tokyo-night"));
    expect(theme.cyan).toBe("#8ecfb5"); // info ↔ success midpoint
    expect(theme.brightRed).toBe("#e493b2");
    expect(theme.brightGreen).toBe("#aacd9b");
    expect(theme.brightYellow).toBe("#d5b899");
    expect(theme.brightBlue).toBe("#94cdfc");
    expect(theme.brightMagenta).toBe("#bdabf6");
    expect(theme.brightCyan).toBe("#a0cdcb");
  });

  it("lets only the default theme pin literal slots", () => {
    // Pinning opts a slot out of the derivation's guarantees. RocSpace Dark
    // does it to preserve the pre-engine default; every other theme is pure
    // derivation, so a new palette cannot quietly hard-code its way around
    // the checks below.
    for (const definition of THEMES) {
      const pinned = Object.keys(definition.xterm ?? {});
      if (definition.id === "rocspace-dark") {
        expect(pinned.length).toBeGreaterThan(0);
      } else {
        expect(pinned, `${definition.id} must not pin xterm slots`).toEqual([]);
        expect(definition.monaco, `${definition.id} monaco`).toBeUndefined();
      }
    }
  });

  it("defines all 16 ANSI slots for every theme", () => {
    for (const definition of THEMES) {
      const theme = xtermThemeFor(definition);
      for (const slot of ANSI_SLOTS) {
        expect(theme[slot], `${definition.id}.${slot}`).toMatch(
          /^#[0-9a-f]{6}([0-9a-f]{2})?$/,
        );
      }
      expect(theme.background, `${definition.id}.background`).toBe(
        definition.tokens.background,
      );
      expect(theme.foreground, `${definition.id}.foreground`).toBe(
        definition.tokens.termFg,
      );
    }
  });

  it("keeps ANSI black dark and ANSI white light on light themes too", () => {
    for (const definition of THEMES) {
      const theme = xtermThemeFor(definition);
      expect(
        luminance(theme.black!),
        `${definition.id} black darker than white`,
      ).toBeLessThan(luminance(theme.white!));
    }
  });

  it("keeps every ANSI slot visible against the terminal background", () => {
    // The bug this guards: on a light theme `white` used to *be* the
    // background, so white/brightWhite text rendered at 1.00:1 — invisible.
    for (const definition of THEMES) {
      const theme = xtermThemeFor(definition);
      for (const slot of ANSI_SLOTS) {
        const id = `${definition.id}.${slot}`;
        if (CONTRAST_EXEMPT.has(id)) continue;
        expect(
          contrast(theme[slot]!, definition.tokens.background),
          id,
        ).toBeGreaterThanOrEqual(MIN_SLOT_CONTRAST);
      }
    }
  });

  it("clears the same floor from derivation alone, before any pinned slot", () => {
    // Pinned literals are an escape hatch for the default theme's fidelity,
    // not a hole in the derivation: strip them and every slot still clears.
    for (const definition of THEMES) {
      const theme = xtermThemeFor({ ...definition, xterm: undefined });
      for (const slot of ANSI_SLOTS) {
        expect(
          contrast(theme[slot]!, definition.tokens.background),
          `${definition.id}.${slot} (unpinned)`,
        ).toBeGreaterThanOrEqual(MIN_SLOT_CONTRAST);
      }
    }
  });
});

describe("monacoThemeFor", () => {
  it("always uses the same theme name so a switch re-defines in place", () => {
    for (const definition of THEMES) {
      expect(monacoThemeFor(definition).name).toBe(MONACO_THEME_NAME);
    }
  });

  it("keeps RocSpace Dark on the palette monacoLoader.ts used to hard-code", () => {
    const { data } = monacoThemeFor(getTheme("rocspace-dark"));
    expect(data.base).toBe("vs-dark");
    expect(data.inherit).toBe(true);
    expect(data.colors).toMatchObject({
      "editor.background": "#0a0c14",
      "editor.foreground": "#e9eaf2",
      "editorLineNumber.foreground": "#6c7388",
      "editorLineNumber.activeForeground": "#a8b0c2",
      "editor.selectionBackground": "#5363ff66",
      "editor.inactiveSelectionBackground": "#5363ff33",
      "editorCursor.foreground": "#8b6cea",
      "editor.lineHighlightBackground": "#10131c",
      "editorIndentGuide.background1": "#171b26",
      "editorIndentGuide.activeBackground1": "#2d3346",
      "editorWidget.background": "#10131c",
      "editorWidget.border": "#2d3346",
      "scrollbarSlider.background": "#21263580",
      "scrollbarSlider.hoverBackground": "#2d3346cc",
      "scrollbarSlider.activeBackground": "#2d3346",
      "minimap.background": "#0a0c14",
    });
  });

  it("derives the selection from the accent when a theme pins nothing", () => {
    const { data } = monacoThemeFor(getTheme("tokyo-night"));
    expect(data.colors["editor.selectionBackground"]).toBe("#7aa2f766");
    expect(data.colors["editor.inactiveSelectionBackground"]).toBe("#7aa2f733");
  });

  it("switches the Monaco base to `vs` for light themes", () => {
    for (const definition of THEMES) {
      const { data } = monacoThemeFor(definition);
      expect(data.base, definition.id).toBe(
        definition.mode === "light" ? "vs" : "vs-dark",
      );
      for (const [key, value] of Object.entries(data.colors)) {
        expect(value, `${definition.id} ${key}`).toMatch(
          /^#[0-9a-f]{6}([0-9a-f]{2})?$/,
        );
      }
    }
  });
});
