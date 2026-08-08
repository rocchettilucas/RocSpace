/** What the ⌘P box considers a match, and which of two matches it prefers. */

import { describe, expect, it } from "vitest";
import { fuzzyMatch } from "@/lib/fuzzy";

const score = (query: string, target: string): number => {
  const match = fuzzyMatch(query, target);
  if (!match) throw new Error(`"${query}" did not match "${target}"`);
  return match.score;
};

describe("fuzzyMatch", () => {
  it("matches letters in order, anywhere", () => {
    expect(fuzzyMatch("app", "src/App.tsx")).not.toBeNull();
    expect(fuzzyMatch("sat", "src/App.tsx")).not.toBeNull();
  });

  it("refuses letters that are not there, or not in order", () => {
    expect(fuzzyMatch("zap", "src/App.tsx")).toBeNull();
    expect(fuzzyMatch("ppa", "src/App.tsx")).toBeNull();
    expect(fuzzyMatch("toolong", "a.ts")).toBeNull();
  });

  it("is case-insensitive but prefers the case you typed", () => {
    expect(fuzzyMatch("APP", "src/App.tsx")).not.toBeNull();
    expect(score("App", "src/App.tsx")).toBeGreaterThan(
      score("apP", "src/App.tsx"),
    );
  });

  it("prefers a run of letters together over the same letters scattered", () => {
    // The whole reason a fuzzy finder feels predictable: `App.tsx` for "app",
    // not the a…p…p that any long path also contains.
    expect(score("app", "App.tsx")).toBeGreaterThan(score("app", "a/p/p.ts"));
  });

  it("prefers a match at the start of a word", () => {
    expect(score("st", "src/stores/ui.ts")).toBeGreaterThan(
      score("st", "src/least.ts"),
    );
  });

  it("tightens a scattered first pass into the run the user meant", () => {
    // The earliest subsequence here is the `s` of `src` and the `t` of `.ts`,
    // nine characters apart. The right-to-left pass pulls the `s` up against
    // the `t` — `stores`, which is what "st" means in this path.
    expect(fuzzyMatch("st", "src/stores/ui.ts")?.positions).toEqual([4, 5]);
  });

  it("sees camelCase word starts", () => {
    const match = fuzzyMatch("rw", "RocWidget.tsx");
    expect(match?.positions).toEqual([0, 3]);
  });

  it("prefers the shorter of two equally good targets", () => {
    expect(score("app", "App.tsx")).toBeGreaterThan(
      score("app", "App.stories.tsx"),
    );
  });

  it("reports the positions it matched, for highlighting", () => {
    expect(fuzzyMatch("app", "src/App.tsx")?.positions).toEqual([4, 5, 6]);
  });

  it("an empty query matches everything, with no opinion about it", () => {
    expect(fuzzyMatch("", "anything")).toEqual({ score: 0, positions: [] });
  });
});
