import { describe, expect, it } from "vitest";
import {
  ACCENT_LABEL,
  ACCENT_TOKEN,
  WORKSPACE_ACCENTS,
  accentForOrder,
  accentHex,
  accentPalette,
  accentVar,
  resolveAccent,
} from "@/lib/accentColors";
import { CSS_VAR_BY_TOKEN } from "@/themes/apply";
import { getTheme, THEMES } from "@/themes/registry";

const DARK = getTheme("rocspace-dark");

describe("WORKSPACE_ACCENTS", () => {
  it("is the six slots, in the order they are handed out", () => {
    expect([...WORKSPACE_ACCENTS]).toEqual([
      "violet",
      "cyan",
      "green",
      "amber",
      "rose",
      "blue",
    ]);
  });

  it("maps each slot to the theme token the group palette used", () => {
    // Ported deliberately unchanged: a workspace migrated out of a v5 profile
    // keeps the colour its project has always had.
    expect(ACCENT_TOKEN).toEqual({
      violet: "purple",
      cyan: "info",
      green: "success",
      amber: "warning",
      rose: "danger",
      blue: "primary",
    });
  });

  it("labels every slot", () => {
    for (const accent of WORKSPACE_ACCENTS) {
      expect(ACCENT_LABEL[accent], accent).toBeTruthy();
    }
  });
});

describe("accentForOrder", () => {
  it("cycles the six slots by creation order", () => {
    expect(WORKSPACE_ACCENTS.map((_, i) => accentForOrder(i))).toEqual([
      ...WORKSPACE_ACCENTS,
    ]);
    expect(accentForOrder(6)).toBe("violet");
    expect(accentForOrder(7)).toBe("cyan");
  });

  it("survives an order a bad snapshot made negative", () => {
    expect(WORKSPACE_ACCENTS).toContain(accentForOrder(-1));
    expect(accentForOrder(-1)).toBe("blue");
  });
});

describe("resolveAccent", () => {
  it("keeps a stored slot", () => {
    expect(resolveAccent("rose")).toBe("rose");
  });

  it("falls back to the order default for anything else", () => {
    // A colour is never worth failing a load over.
    expect(resolveAccent(undefined, 1)).toBe("cyan");
    expect(resolveAccent("chartreuse", 2)).toBe("green");
    expect(resolveAccent(7, 0)).toBe("violet");
  });
});

describe("accentVar", () => {
  it("returns the token's custom property, so a theme switch re-colours", () => {
    expect(accentVar("violet")).toBe(`var(${CSS_VAR_BY_TOKEN.purple})`);
    expect(accentVar("blue")).toBe(`var(${CSS_VAR_BY_TOKEN.primary})`);
  });

  it("gives every slot a distinct variable", () => {
    const vars = WORKSPACE_ACCENTS.map(accentVar);
    expect(new Set(vars).size).toBe(WORKSPACE_ACCENTS.length);
    for (const value of vars) expect(value).toMatch(/^var\(--rs-[a-z-]+\)$/);
  });
});

describe("accentHex", () => {
  it("derives from the theme's tokens, not from a literal table", () => {
    for (const accent of WORKSPACE_ACCENTS) {
      expect(accentHex(accent, DARK)).toBe(DARK.tokens[ACCENT_TOKEN[accent]]);
    }
  });

  it("follows whichever theme it is asked about", () => {
    for (const theme of THEMES) {
      expect(accentHex("green", theme)).toBe(theme.tokens.success);
    }
  });

  it("accentPalette resolves all six at once", () => {
    const palette = accentPalette(DARK);
    expect(Object.keys(palette).sort()).toEqual([...WORKSPACE_ACCENTS].sort());
    for (const accent of WORKSPACE_ACCENTS) {
      expect(palette[accent]).toBe(accentHex(accent, DARK));
    }
  });
});
