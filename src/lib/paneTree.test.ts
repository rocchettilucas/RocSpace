import { describe, expect, it } from "vitest";
import {
  MAX_PANE_RATIO,
  MIN_PANE_RATIO,
  buildBalancedTree,
  hasLeaf,
  leafIds,
  removeLeaf,
  sanitizePaneTree,
  setRatioAt,
  splitLeaf,
  type PaneNode,
} from "@/lib/paneTree";

/** Freeze a tree all the way down. Every test that mutates through one of these
 *  would throw (module code is strict), so a frozen input is the assertion that
 *  the module is persistent rather than in-place. */
function deepFreeze(node: PaneNode): PaneNode {
  Object.freeze(node);
  if (node.kind === "split") {
    deepFreeze(node.first);
    deepFreeze(node.second);
  }
  return node;
}

const leaf = (terminalId: string): PaneNode => ({ kind: "leaf", terminalId });

/** Longest root→leaf edge count. `leaf` alone is 0. */
function depth(node: PaneNode): number {
  return node.kind === "leaf"
    ? 0
    : 1 + Math.max(depth(node.first), depth(node.second));
}

describe("splitLeaf", () => {
  it("splits a single leaf side-by-side with the target first and the new pane second", () => {
    const tree = deepFreeze(leaf("a"));

    const next = splitLeaf(tree, "a", "row", "b");

    expect(next).toEqual({
      kind: "split",
      direction: "row",
      ratio: 0.5,
      first: leaf("a"),
      second: leaf("b"),
    });
  });

  it("splits a single leaf stacked when the direction is column", () => {
    const next = splitLeaf(deepFreeze(leaf("a")), "a", "column", "b");

    expect(next).toMatchObject({ kind: "split", direction: "column" });
    expect(leafIds(next)).toEqual(["a", "b"]);
  });

  it("splits a nested leaf without disturbing its siblings", () => {
    const tree = deepFreeze({
      kind: "split",
      direction: "row",
      ratio: 0.3,
      first: leaf("a"),
      second: {
        kind: "split",
        direction: "column",
        ratio: 0.6,
        first: leaf("b"),
        second: leaf("c"),
      },
    } satisfies PaneNode);

    const next = splitLeaf(tree, "c", "row", "d");

    expect(leafIds(next)).toEqual(["a", "b", "c", "d"]);
    // Untouched branches keep their ratios (and their identity — nothing above
    // the edited path is rebuilt from defaults).
    expect(next).toMatchObject({
      ratio: 0.3,
      first: { kind: "leaf", terminalId: "a" },
      second: { ratio: 0.6 },
    });
  });

  it("leaves the tree alone when the target is not in it", () => {
    const tree = deepFreeze(
      splitLeaf(leaf("a"), "a", "row", "b"),
    ) satisfies PaneNode;

    expect(splitLeaf(tree, "zzz", "row", "c")).toBe(tree);
  });

  it("does not mutate its input", () => {
    const tree = deepFreeze(splitLeaf(leaf("a"), "a", "row", "b"));

    const next = splitLeaf(tree, "b", "column", "c");

    expect(next).not.toBe(tree);
    expect(leafIds(tree)).toEqual(["a", "b"]);
  });

  it("refuses to give a terminal that already has a pane a second one", () => {
    // One terminal, one leaf, always. Two leaves for one id means two xterms
    // over a single PTY — and the renderer hosts each terminal's card in one
    // element, so the second pane could only render empty.
    const tree = deepFreeze(splitLeaf(leaf("a"), "a", "row", "b"));

    expect(splitLeaf(tree, "a", "row", "b")).toBe(tree);
    expect(splitLeaf(tree, "b", "column", "a")).toBe(tree);
  });

  it("refuses to split a leaf into itself", () => {
    const tree = deepFreeze(leaf("a"));

    expect(splitLeaf(tree, "a", "row", "a")).toBe(tree);
  });
});

describe("removeLeaf", () => {
  it("returns null when the last leaf is removed", () => {
    expect(removeLeaf(deepFreeze(leaf("a")), "a")).toBeNull();
  });

  it("promotes the sibling when one of a pair goes away", () => {
    const tree = deepFreeze(splitLeaf(leaf("a"), "a", "row", "b"));

    expect(removeLeaf(tree, "a")).toEqual(leaf("b"));
    expect(removeLeaf(tree, "b")).toEqual(leaf("a"));
  });

  it("collapses the grandparent by promoting a whole subtree", () => {
    // row( a , column( b , c ) ) — removing `a` must leave the column intact at
    // the root rather than flattening it or stranding an empty split.
    const tree = deepFreeze({
      kind: "split",
      direction: "row",
      ratio: 0.5,
      first: leaf("a"),
      second: {
        kind: "split",
        direction: "column",
        ratio: 0.4,
        first: leaf("b"),
        second: leaf("c"),
      },
    } satisfies PaneNode);

    expect(removeLeaf(tree, "a")).toEqual({
      kind: "split",
      direction: "column",
      ratio: 0.4,
      first: leaf("b"),
      second: leaf("c"),
    });
  });

  it("removes a deeply nested leaf and promotes only its sibling", () => {
    const tree = deepFreeze({
      kind: "split",
      direction: "row",
      ratio: 0.5,
      first: leaf("a"),
      second: {
        kind: "split",
        direction: "column",
        ratio: 0.4,
        first: leaf("b"),
        second: leaf("c"),
      },
    } satisfies PaneNode);

    expect(removeLeaf(tree, "b")).toEqual({
      kind: "split",
      direction: "row",
      ratio: 0.5,
      first: leaf("a"),
      second: leaf("c"),
    });
  });

  it("leaves the tree alone when the id is not in it", () => {
    const tree = deepFreeze(splitLeaf(leaf("a"), "a", "row", "b"));
    expect(removeLeaf(tree, "zzz")).toBe(tree);
  });

  it("does not mutate its input", () => {
    const tree = deepFreeze(
      splitLeaf(splitLeaf(leaf("a"), "a", "row", "b"), "b", "column", "c"),
    );

    removeLeaf(tree, "b");

    expect(leafIds(tree)).toEqual(["a", "b", "c"]);
  });
});

describe("leafIds", () => {
  it("reads left-to-right, first before second, at every depth", () => {
    const tree: PaneNode = {
      kind: "split",
      direction: "row",
      ratio: 0.5,
      first: {
        kind: "split",
        direction: "column",
        ratio: 0.5,
        first: leaf("a"),
        second: leaf("b"),
      },
      second: {
        kind: "split",
        direction: "column",
        ratio: 0.5,
        first: leaf("c"),
        second: leaf("d"),
      },
    };

    expect(leafIds(tree)).toEqual(["a", "b", "c", "d"]);
  });

  it("keeps the surviving order stable across a split and a removal", () => {
    const split = splitLeaf(
      buildBalancedTree(["a", "b", "c"])!,
      "b",
      "row",
      "x",
    );
    expect(leafIds(split)).toEqual(["a", "b", "x", "c"]);

    expect(leafIds(removeLeaf(split, "b")!)).toEqual(["a", "x", "c"]);
  });
});

describe("hasLeaf", () => {
  it("finds ids at any depth and rejects unknown ones", () => {
    const tree = buildBalancedTree(["a", "b", "c", "d", "e"])!;
    for (const id of ["a", "b", "c", "d", "e"]) {
      expect(hasLeaf(tree, id)).toBe(true);
    }
    expect(hasLeaf(tree, "f")).toBe(false);
  });
});

describe("buildBalancedTree", () => {
  it("returns null for an empty id list and a bare leaf for one id", () => {
    expect(buildBalancedTree([])).toBeNull();
    expect(buildBalancedTree(["only"])).toEqual(leaf("only"));
  });

  it("keeps every id, stays balanced, and alternates direction for 1..16 panes", () => {
    for (let n = 1; n <= 16; n++) {
      const ids = Array.from({ length: n }, (_, i) => `t${i}`);
      const tree = buildBalancedTree(ids)!;

      expect(leafIds(tree)).toEqual(ids);
      expect(depth(tree)).toBeLessThanOrEqual(Math.ceil(Math.log2(n)));

      // Direction depends only on depth: every split at the same level agrees,
      // and consecutive levels differ. That is what makes 4 panes a 2×2 rather
      // than four columns.
      const byDepth = new Map<number, Set<string>>();
      const walk = (node: PaneNode, d: number) => {
        if (node.kind === "leaf") return;
        const set = byDepth.get(d) ?? new Set<string>();
        set.add(node.direction);
        byDepth.set(d, set);
        walk(node.first, d + 1);
        walk(node.second, d + 1);
      };
      walk(tree, 0);
      for (const [d, dirs] of byDepth) {
        expect(dirs.size).toBe(1);
        expect([...dirs][0]).toBe(d % 2 === 0 ? "row" : "column");
      }
    }
  });

  it("gives every split an even ratio", () => {
    const tree = buildBalancedTree(["a", "b", "c", "d"])!;
    const ratios: number[] = [];
    const walk = (node: PaneNode) => {
      if (node.kind === "leaf") return;
      ratios.push(node.ratio);
      walk(node.first);
      walk(node.second);
    };
    walk(tree);
    expect(ratios).toEqual([0.5, 0.5, 0.5]);
  });

  it("drops duplicate ids so a stale caller cannot produce two panes for one terminal", () => {
    expect(leafIds(buildBalancedTree(["a", "b", "a"])!)).toEqual(["a", "b"]);
  });

  it("does not mutate the id array it is given", () => {
    const ids = Object.freeze(["a", "b", "c"]) as readonly string[];
    expect(leafIds(buildBalancedTree(ids)!)).toEqual(["a", "b", "c"]);
  });
});

describe("setRatioAt", () => {
  const nested = (): PaneNode => ({
    kind: "split",
    direction: "row",
    ratio: 0.5,
    first: leaf("a"),
    second: {
      kind: "split",
      direction: "column",
      ratio: 0.5,
      first: leaf("b"),
      second: leaf("c"),
    },
  });

  it("sets the root ratio for the empty path", () => {
    const next = setRatioAt(deepFreeze(nested()), "", 0.7);
    expect(next).toMatchObject({ ratio: 0.7 });
  });

  it("walks 'f'/'s' steps to a nested split", () => {
    const next = setRatioAt(deepFreeze(nested()), "s", 0.25);
    expect(next).toMatchObject({ ratio: 0.5, second: { ratio: 0.25 } });
  });

  it("clamps to the usable band so a pane can never be dragged to nothing", () => {
    expect(setRatioAt(nested(), "", 0)).toMatchObject({
      ratio: MIN_PANE_RATIO,
    });
    expect(setRatioAt(nested(), "", 1)).toMatchObject({
      ratio: MAX_PANE_RATIO,
    });
    expect(MIN_PANE_RATIO).toBe(0.15);
    expect(MAX_PANE_RATIO).toBe(0.85);
  });

  it("ignores a path that does not land on a split", () => {
    const tree = deepFreeze(nested());
    expect(setRatioAt(tree, "f", 0.7)).toBe(tree);
    expect(setRatioAt(tree, "sfs", 0.7)).toBe(tree);
    expect(setRatioAt(tree, "q", 0.7)).toBe(tree);
  });

  it("ignores a non-finite ratio rather than poisoning the tree", () => {
    const tree = deepFreeze(nested());
    expect(setRatioAt(tree, "", Number.NaN)).toBe(tree);
  });

  it("does not mutate its input", () => {
    const tree = deepFreeze(nested());
    const next = setRatioAt(tree, "s", 0.25);
    expect(next).not.toBe(tree);
    expect(tree).toMatchObject({ second: { ratio: 0.5 } });
  });
});

describe("sanitizePaneTree", () => {
  it("accepts a well-formed tree and returns a fresh copy", () => {
    const tree = buildBalancedTree(["a", "b", "c"])!;
    const parsed = JSON.parse(JSON.stringify(tree)) as unknown;

    const clean = sanitizePaneTree(parsed);

    expect(clean).toEqual(tree);
    expect(clean).not.toBe(parsed);
  });

  it("rejects everything that is not a tree", () => {
    for (const bad of [
      undefined,
      null,
      42,
      "leaf",
      {},
      { kind: "leaf" },
      { kind: "leaf", terminalId: 7 },
      { kind: "leaf", terminalId: "" },
      { kind: "branch", terminalId: "a" },
      { kind: "split", direction: "row", ratio: 0.5, first: leaf("a") },
      {
        kind: "split",
        direction: "diagonal",
        ratio: 0.5,
        first: leaf("a"),
        second: leaf("b"),
      },
      {
        kind: "split",
        direction: "row",
        ratio: "half",
        first: leaf("a"),
        second: leaf("b"),
      },
      // Corrupt deep inside — the whole tree is untrustworthy, not just the arm.
      {
        kind: "split",
        direction: "row",
        ratio: 0.5,
        first: leaf("a"),
        second: { kind: "split", direction: "row", ratio: 0.5, first: null },
      },
    ]) {
      expect(sanitizePaneTree(bad)).toBeNull();
    }
  });

  it("clamps an out-of-band ratio instead of discarding the tree", () => {
    const clean = sanitizePaneTree({
      kind: "split",
      direction: "row",
      ratio: 0.99,
      first: leaf("a"),
      second: leaf("b"),
    });

    expect(clean).toMatchObject({ ratio: MAX_PANE_RATIO });
  });

  it("rejects a tree that names the same terminal twice", () => {
    expect(
      sanitizePaneTree({
        kind: "split",
        direction: "row",
        ratio: 0.5,
        first: leaf("a"),
        second: leaf("a"),
      }),
    ).toBeNull();
  });
});
