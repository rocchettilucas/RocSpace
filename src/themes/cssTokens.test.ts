/** Guards how token utilities are used across the app.
 *
 *  This is a source-text check rather than a rendering one: Tailwind resolves
 *  utilities at build time, so a "wrong token for the job" mistake only exists
 *  in the class names themselves. (styles.css cannot be asserted from here —
 *  vitest runs with `css: false`, which blanks CSS imports; the `@theme`
 *  mapping is verified against the compiled bundle at build time.) */

import { describe, expect, it } from "vitest";

const SOURCES = import.meta.glob("/src/**/*.{ts,tsx}", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

describe("token utilities", () => {
  it("never draws a line with an elevation token", () => {
    // `surface-3/4` are hover/pressed *fills*. They happen to equal
    // `border`/`border-hover` on RocSpace Dark, so using them for borders looks
    // right on the default theme and collapses panel separation on every other
    // one — which is exactly how the whole app ended up doing it. Lines use
    // `border`/`border-hover`/`border-active`; fills keep `surface-*`.
    const offenders: string[] = [];
    for (const [path, source] of Object.entries(SOURCES)) {
      if (/\.(test|spec)\.tsx?$/.test(path)) continue;
      for (const match of source.matchAll(
        /\b(?:border|ring|divide|outline)-surface-\d\b/g,
      )) {
        offenders.push(`${path}: ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
