/** Tiny sRGB color math for the places that cannot use CSS `color-mix()`.
 *
 *  xterm and Monaco both parse colors themselves and only understand concrete
 *  values, so the derivations in `xterm.ts` / `monaco.ts` need to blend tokens
 *  in JS. Everything else in the app should use `color-mix()` in CSS instead. */

export interface Rgba {
  /** 0–255 */
  r: number;
  /** 0–255 */
  g: number;
  /** 0–255 */
  b: number;
  /** 0–1 */
  a: number;
}

const RGB_FN = /^rgba?\(([^)]+)\)$/i;

function clamp255(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

/** Parse `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()` and `rgba()`.
 *  Unparseable input degrades to opaque black rather than throwing — a wrong
 *  color is recoverable, a crash mid-render is not. */
export function parseColor(input: string): Rgba {
  const value = input.trim();

  if (value.startsWith("#")) {
    const hex = value.slice(1);
    const expand = (h: string) => parseInt(h.length === 1 ? h + h : h, 16);
    if (hex.length === 3 || hex.length === 4) {
      return {
        r: expand(hex[0]!),
        g: expand(hex[1]!),
        b: expand(hex[2]!),
        a: hex.length === 4 ? expand(hex[3]!) / 255 : 1,
      };
    }
    if (hex.length === 6 || hex.length === 8) {
      return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
        a: hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1,
      };
    }
    return { r: 0, g: 0, b: 0, a: 1 };
  }

  const fn = RGB_FN.exec(value);
  if (fn) {
    const parts = fn[1]!.split(/[\s,/]+/).filter(Boolean);
    const channel = (raw: string | undefined) => {
      if (!raw) return 0;
      return raw.endsWith("%")
        ? clamp255((parseFloat(raw) / 100) * 255)
        : clamp255(parseFloat(raw));
    };
    const alphaRaw = parts[3];
    return {
      r: channel(parts[0]),
      g: channel(parts[1]),
      b: channel(parts[2]),
      a:
        alphaRaw === undefined
          ? 1
          : Math.max(
              0,
              Math.min(
                1,
                alphaRaw.endsWith("%")
                  ? parseFloat(alphaRaw) / 100
                  : parseFloat(alphaRaw),
              ),
            ),
    };
  }

  return { r: 0, g: 0, b: 0, a: 1 };
}

function hex2(n: number): string {
  return clamp255(n).toString(16).padStart(2, "0");
}

/** `#rrggbb`, or `#rrggbbaa` when the color is translucent. */
export function toHex({ r, g, b, a }: Rgba): string {
  const base = `#${hex2(r)}${hex2(g)}${hex2(b)}`;
  return a >= 1 ? base : `${base}${hex2(a * 255)}`;
}

/** Blend `amount` (0–1) of `to` into `from`, in sRGB. */
export function mix(from: string, to: string, amount: number): string {
  const t = Math.max(0, Math.min(1, amount));
  const a = parseColor(from);
  const b = parseColor(to);
  return toHex({
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
    a: a.a + (b.a - a.a) * t,
  });
}

/** WCAG 2.x relative luminance (0–1). Alpha is ignored: callers compare
 *  opaque tones that are about to be painted on top of each other. */
function relativeLuminance(color: string): number {
  const { r, g, b } = parseColor(color);
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio between two colors, 1 (identical) … 21 (black/white). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Same color at a new alpha (0–1), as `#rrggbbaa`. */
export function withAlpha(color: string, alpha: number): string {
  const { r, g, b } = parseColor(color);
  return toHex({ r, g, b, a: Math.max(0, Math.min(1, alpha)) });
}
