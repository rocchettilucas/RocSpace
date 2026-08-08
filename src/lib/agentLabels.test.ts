/** The roc-name generator.
 *
 *  A pane's name is how the user addresses it — in the sidebar, in the
 *  inspector, in a future "send this to Rocky" dispatch — so the one property
 *  that actually matters is that no two live panes answer to the same name.
 *  These tests hold that against the two ways it used to break: a name freed by
 *  an out-of-order close, and a name the user typed in by hand. */

import { describe, expect, it } from "vitest";
import { ROC_NAMES, nextRocName, uniqueName } from "@/lib/agentLabels";

describe("ROC_NAMES", () => {
  it("offers at least sixteen distinct names", () => {
    expect(ROC_NAMES.length).toBeGreaterThanOrEqual(16);
    expect(new Set(ROC_NAMES).size).toBe(ROC_NAMES.length);
  });
});

describe("nextRocName", () => {
  it("starts at the head of the pool", () => {
    expect(nextRocName(new Set())).toBe(ROC_NAMES[0]);
  });

  it("skips names that are taken", () => {
    expect(nextRocName(new Set([ROC_NAMES[0]!]))).toBe(ROC_NAMES[1]);
    expect(nextRocName(new Set([ROC_NAMES[0]!, ROC_NAMES[1]!]))).toBe(
      ROC_NAMES[2],
    );
  });

  it("takes back a name freed out of order rather than pushing past it", () => {
    // The bug the old counter had: with the first three names in use, closing
    // the middle pane left a count of two, so the next pane minted a duplicate
    // of the third. Asking what is taken — not how many there are — reuses the
    // hole instead.
    const taken = new Set([ROC_NAMES[0]!, ROC_NAMES[2]!]);
    expect(nextRocName(taken)).toBe(ROC_NAMES[1]);
  });

  it("steps over a name the user typed in by hand", () => {
    const taken = new Set(["scratch", ROC_NAMES[0]!, "notes"]);
    expect(nextRocName(taken)).toBe(ROC_NAMES[1]);
  });

  it("ignores names that are not in the pool at all", () => {
    expect(nextRocName(new Set(["scratch", "notes", "Rocky 7"]))).toBe(
      ROC_NAMES[0],
    );
  });

  it("suffixes once the pool is exhausted", () => {
    const taken = new Set<string>(ROC_NAMES);
    expect(nextRocName(taken)).toBe(`${ROC_NAMES[0]} 2`);
  });

  it("rolls the suffix over a whole extra pass", () => {
    const taken = new Set<string>([
      ...ROC_NAMES,
      ...ROC_NAMES.map((n) => `${n} 2`),
    ]);
    expect(nextRocName(taken)).toBe(`${ROC_NAMES[0]} 3`);
  });

  it("never repeats itself across forty draws", () => {
    // Forty is well past the pool, so this covers the wrap into suffixes as
    // well as the plain names — and forty is more panes than any profile can
    // hold, so a real workspace can never see a collision.
    const taken = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const name = nextRocName(taken);
      expect(taken.has(name)).toBe(false);
      taken.add(name);
    }
    expect(taken.size).toBe(40);
  });

  it("does not mutate the set it is given", () => {
    // Snapshotted rather than frozen: `Object.freeze` locks a Set's *own
    // properties*, and its contents live in internal slots — a frozen Set takes
    // `.add` and `.delete` without complaint, so freezing here asserted
    // nothing. Comparing the contents against a copy taken beforehand is what
    // actually catches a caller that writes into its argument.
    const taken: ReadonlySet<string> = new Set([ROC_NAMES[0]!, "scratch"]);
    const before = [...taken];

    nextRocName(taken);

    expect([...taken]).toEqual(before);
  });
});

describe("uniqueName", () => {
  it("hands back a name nothing holds", () => {
    expect(uniqueName("scratch", new Set(["notes"]))).toBe("scratch");
  });

  it("suffixes a name already in use", () => {
    expect(uniqueName("scratch", new Set(["scratch"]))).toBe("scratch 2");
  });

  it("takes the lowest free number rather than counting collisions", () => {
    // With 2 and 4 taken, 3 is free and is the answer — the same "what is
    // taken, not how many" rule `nextRocName` follows.
    const taken = new Set(["scratch", "scratch 2", "scratch 4"]);
    expect(uniqueName("scratch", taken)).toBe("scratch 3");
  });

  it("keeps suffixing a name that is itself already suffixed", () => {
    expect(uniqueName("Rocky 2", new Set(["Rocky 2"]))).toBe("Rocky 2 2");
  });

  it("never repeats itself across a run of names", () => {
    const taken = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const name = uniqueName("scratch", taken);
      expect(taken.has(name)).toBe(false);
      taken.add(name);
    }
    expect(taken.size).toBe(10);
  });

  it("does not mutate the set it is given", () => {
    const taken: ReadonlySet<string> = new Set(["scratch"]);
    const before = [...taken];
    uniqueName("scratch", taken);
    expect([...taken]).toEqual(before);
  });
});
