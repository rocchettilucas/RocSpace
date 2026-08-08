import { describe, expect, it } from "vitest";
import { parseColor } from "@/themes/colors";
import { DEFAULT_THEME_ID, getTheme, THEMES } from "@/themes/registry";
import { THEME_TOKEN_KEYS } from "@/themes/types";

const KEBAB_CASE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const CSS_COLOR = /^(#[0-9a-fA-F]{3,8}|rgba?\(|hsla?\(|color-mix\()/;

/** The 10 themes this phase ships. Guards against an accidental drop/rename —
 *  ids are persisted in settings.dat. */
const SHIPPED_THEME_IDS = [
  "rocspace-dark",
  "dracula",
  "black",
  "gruvbox-dark",
  "cyber-wave",
  "one-dark-pro",
  "tokyo-night",
  "nord",
  "light",
  "solarized-light",
];

/** WCAG relative luminance. */
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

describe("theme registry", () => {
  it("exposes the token key list used by the CSS-var plumbing", () => {
    expect(THEME_TOKEN_KEYS).toHaveLength(19);
    expect(new Set(THEME_TOKEN_KEYS).size).toBe(THEME_TOKEN_KEYS.length);
  });

  it("ships at least the default theme", () => {
    expect(THEMES.length).toBeGreaterThan(0);
    expect(THEMES.some((t) => t.id === DEFAULT_THEME_ID)).toBe(true);
  });

  it("gives every theme a unique kebab-case id, a name and a description", () => {
    const ids = THEMES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const theme of THEMES) {
      expect(theme.id, `${theme.id} must be kebab-case`).toMatch(KEBAB_CASE);
      expect(theme.name.trim().length, `${theme.id} name`).toBeGreaterThan(0);
      expect(
        theme.description.trim().length,
        `${theme.id} description`,
      ).toBeGreaterThan(0);
      expect(["dark", "light"]).toContain(theme.mode);
    }
  });

  it("defines all 19 tokens as non-empty CSS colors on every theme", () => {
    for (const theme of THEMES) {
      expect(
        Object.keys(theme.tokens).sort(),
        `${theme.id} token key set`,
      ).toEqual([...THEME_TOKEN_KEYS].sort());
      for (const key of THEME_TOKEN_KEYS) {
        const value = theme.tokens[key];
        expect(typeof value, `${theme.id}.${key} type`).toBe("string");
        expect(value.trim().length, `${theme.id}.${key} empty`).toBeGreaterThan(
          0,
        );
        expect(value, `${theme.id}.${key} is a CSS color`).toMatch(CSS_COLOR);
      }
    }
  });

  it("resolves known ids and falls back to the default for unknown ones", () => {
    expect(getTheme(DEFAULT_THEME_ID).id).toBe(DEFAULT_THEME_ID);
    expect(getTheme("nope").id).toBe(DEFAULT_THEME_ID);
    expect(getTheme("").id).toBe(DEFAULT_THEME_ID);
    for (const theme of THEMES) {
      expect(getTheme(theme.id)).toBe(theme);
    }
  });

  it("ships the ten Phase-0 themes, dark ones first", () => {
    expect(THEMES.map((t) => t.id)).toEqual(SHIPPED_THEME_IDS);
    const firstLight = THEMES.findIndex((t) => t.mode === "light");
    expect(THEMES.slice(0, firstLight).every((t) => t.mode === "dark")).toBe(
      true,
    );
    expect(THEMES.slice(firstLight).every((t) => t.mode === "light")).toBe(
      true,
    );
  });

  it("matches each theme's declared mode to its actual background", () => {
    for (const theme of THEMES) {
      const bg = luminance(theme.tokens.background);
      if (theme.mode === "dark") {
        expect(bg, `${theme.id} background should be dark`).toBeLessThan(0.15);
      } else {
        expect(bg, `${theme.id} background should be light`).toBeGreaterThan(
          0.5,
        );
      }
    }
  });

  it("ramps elevation away from the background in one direction", () => {
    for (const theme of THEMES) {
      const t = theme.tokens;
      const ramp = [
        t.background,
        t.panel,
        t.surface,
        t.surfaceHover,
        t.surfaceActive,
      ].map(luminance);
      for (let i = 1; i < ramp.length; i++) {
        const step = ramp[i]! - ramp[i - 1]!;
        if (theme.mode === "dark") {
          expect(step, `${theme.id} elevation step ${i}`).toBeGreaterThan(0);
        } else {
          expect(step, `${theme.id} elevation step ${i}`).toBeLessThan(0);
        }
      }
    }
  });

  it("quiets each text step down the hierarchy", () => {
    // text (primary) → text2 (labels) → text3 (hints, disabled) must get
    // progressively closer to the background, or the muted tone ends up
    // shouting louder than the secondary one.
    for (const theme of THEMES) {
      const t = theme.tokens;
      const [text, text2, text3] = [t.text, t.text2, t.text3].map(
        luminance,
      ) as [number, number, number];
      if (theme.mode === "dark") {
        expect(text, `${theme.id} text vs text2`).toBeGreaterThan(text2);
        expect(text2, `${theme.id} text2 vs text3`).toBeGreaterThanOrEqual(
          text3,
        );
      } else {
        expect(text, `${theme.id} text vs text2`).toBeLessThan(text2);
        expect(text2, `${theme.id} text2 vs text3`).toBeLessThanOrEqual(text3);
      }
    }
  });

  it("keeps text legible on every theme", () => {
    for (const theme of THEMES) {
      const t = theme.tokens;
      expect(
        contrast(t.text, t.background),
        `${theme.id} text`,
      ).toBeGreaterThan(7);
      expect(
        contrast(t.text2, t.background),
        `${theme.id} text2`,
      ).toBeGreaterThan(4.5);
      expect(
        contrast(t.text3, t.background),
        `${theme.id} text3`,
      ).toBeGreaterThan(3.5);
      expect(
        contrast(t.termFg, t.background),
        `${theme.id} termFg`,
      ).toBeGreaterThan(4);
      expect(
        contrast(t.primaryFg, t.primary),
        `${theme.id} primaryFg on primary`,
      ).toBeGreaterThan(3);
    }
  });

  it("gives the six accent slots distinct colors on every theme", () => {
    for (const theme of THEMES) {
      const t = theme.tokens;
      const slots = [
        t.primary,
        t.info,
        t.warning,
        t.purple,
        t.success,
        t.danger,
      ];
      expect(new Set(slots).size, `${theme.id} accent slots`).toBe(
        slots.length,
      );
    }
  });

  it("keeps RocSpace Dark on the pre-theme-engine palette", () => {
    // These are the literal values that lived in styles.css `@theme`, the
    // group palette (now `accentColors.ts`) and useXterm.ts before the theme
    // engine landed. The default look must not drift.
    const tokens = getTheme("rocspace-dark").tokens;
    expect(tokens.background).toBe("#0a0c14");
    expect(tokens.panel).toBe("#10131c");
    expect(tokens.surface).toBe("#171b26");
    expect(tokens.surfaceHover).toBe("#212635");
    expect(tokens.surfaceActive).toBe("#2d3346");
    expect(tokens.text).toBe("#e9eaf2");
    expect(tokens.text2).toBe("#a8b0c2");
    expect(tokens.text3).toBe("#6c7388");
    expect(tokens.primary).toBe("#8b6cea");
    expect(tokens.success).toBe("#4ade80");
    expect(tokens.warning).toBe("#fbbf24");
    expect(tokens.danger).toBe("#f87171");
    expect(tokens.info).toBe("#6ea8fe");
    expect(tokens.termFg).toBe("#e9eaf2");
  });
});
