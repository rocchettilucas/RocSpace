/** Ranking, against the shape the corpus was written in: a title hit beats a
 *  description hit beats a body hit, and a tie goes to the newer memory. */

import { describe, expect, it } from "vitest";
import { searchMemories, searchTerms } from "@/lib/mindSearch";
import type { MindMemory } from "@/lib/bindings";

const memory = (over: Partial<MindMemory> & { name: string }): MindMemory => ({
  scope: "-Users-l-Storefront",
  path: `/memory/${over.name}.md`,
  description: "",
  memoryType: "project",
  links: [],
  updatedAt: 1,
  bytes: 100,
  ...over,
});

const names = (hits: { memory: MindMemory }[]) =>
  hits.map((hit) => hit.memory.name);

describe("searchTerms", () => {
  it("splits on whitespace and lowercases", () => {
    expect(searchTerms("  Payments   Account ")).toEqual([
      "payments",
      "account",
    ]);
  });

  it("is empty for an empty query", () => {
    expect(searchTerms("   ")).toEqual([]);
  });
});

describe("searchMemories", () => {
  it("returns nothing for an empty query", () => {
    expect(searchMemories([memory({ name: "a" })], {}, "  ")).toEqual([]);
  });

  it("ranks a name hit above a description hit above a body hit", () => {
    const inName = memory({ name: "payments-provider-migration" });
    const inDescription = memory({
      name: "internal-builds-test-keys",
      description: "Internal builds must use test payments keys",
    });
    const inBody = memory({ name: "release-1-2-branch" });

    const hits = searchMemories(
      [inBody, inDescription, inName],
      { [inBody.path]: "we moved the payments publisher over" },
      "payments",
    );

    expect(names(hits)).toEqual([
      "payments-provider-migration",
      "internal-builds-test-keys",
      "release-1-2-branch",
    ]);
    expect(hits.map((h) => h.field)).toEqual(["name", "description", "body"]);
  });

  it("breaks a tie by recency", () => {
    // Two memories about the same subject: the newer one is the one still
    // true. `release-1-1` and `release-1-2` are the real pair.
    const older = memory({ name: "release-1-1-android-build9", updatedAt: 10 });
    const newer = memory({ name: "release-1-2-branch", updatedAt: 20 });
    expect(names(searchMemories([older, newer], {}, "release"))).toEqual([
      "release-1-2-branch",
      "release-1-1-android-build9",
    ]);
  });

  it("puts an exact name first, then a prefix", () => {
    const exact = memory({ name: "busyness", updatedAt: 1 });
    const prefix = memory({ name: "busyness-latency-budget", updatedAt: 99 });
    const elsewhere = memory({
      name: "m1-scraper",
      description: "the busyness scraper runs here",
      updatedAt: 99,
    });
    expect(
      names(searchMemories([elsewhere, prefix, exact], {}, "busyness")),
    ).toEqual(["busyness", "busyness-latency-budget", "m1-scraper"]);
  });

  it("requires every term to match somewhere", () => {
    const hit = memory({
      name: "busyness-latency-budget",
      description: "M1 budget split",
    });
    expect(names(searchMemories([hit], {}, "busyness budget"))).toEqual([
      "busyness-latency-budget",
    ]);
    expect(searchMemories([hit], {}, "busyness elephant")).toEqual([]);
  });

  it("matches case-insensitively", () => {
    const hit = memory({ name: "Payments-Account" });
    expect(names(searchMemories([hit], {}, "payments"))).toEqual([
      "Payments-Account",
    ]);
  });

  it("works before any body has been read, and improves once they land", () => {
    // The reason bodies are optional: results appear on the first keystroke
    // from headers alone rather than after sixty file reads.
    const bodyOnly = memory({ name: "trends-utc-day-bucket-fix" });
    expect(searchMemories([bodyOnly], {}, "postgres")).toEqual([]);
    expect(
      names(
        searchMemories(
          [bodyOnly],
          { [bodyOnly.path]: "the postgres day bucket was UTC" },
          "postgres",
        ),
      ),
    ).toEqual(["trends-utc-day-bucket-fix"]);
  });
});
