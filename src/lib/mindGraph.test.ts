/** The link graph: what it joins, where it settles, and why the layout is
 *  worth keeping. */

import { beforeEach, describe, expect, it } from "vitest";
import {
  buildGraph,
  cachedLayout,
  clampLabelX,
  fitGraph,
  graphBounds,
  hopsFrom,
  hubIndices,
  isSettled,
  labelBudget,
  layoutKey,
  peekLayout,
  placeLabels,
  resetLayoutCache,
  settleLayout,
  stepLayout,
  truncateToWidth,
  MIN_RADIUS,
} from "@/lib/mindGraph";
import type { MindMemory } from "@/lib/bindings";

const memory = (
  name: string,
  links: string[] = [],
  memoryType = "project",
): MindMemory => ({
  scope: "-Users-l-Storefront",
  path: `/memory/${name}.md`,
  name,
  description: "",
  memoryType,
  links,
  updatedAt: 1,
  bytes: 10,
});

beforeEach(() => {
  resetLayoutCache();
});

describe("buildGraph", () => {
  it("joins a link to the memory it names", () => {
    const graph = buildGraph([memory("a", ["b"]), memory("b")]);
    expect(graph.nodes.map((n) => n.name)).toEqual(["a", "b"]);
    expect(graph.edges).toEqual([{ from: 0, to: 1 }]);
  });

  it("counts backlinks, which is what sizes a node", () => {
    // The thing everything points at should be the thing you see first.
    const graph = buildGraph([
      memory("hub"),
      memory("a", ["hub"]),
      memory("b", ["hub"]),
    ]);
    expect(graph.nodes[0]!.backlinks).toBe(2);
    expect(graph.nodes[1]!.backlinks).toBe(0);
  });

  it("draws a mutual link once but counts it on both ends", () => {
    // One LINE per pair, one BACKLINK per direction. Counting on the pair cost
    // the alphabetically-earlier member of every mutual pair its size — seven
    // of the 62 memories in this machine's largest scope were drawn as if
    // nothing pointed at them, next to a pane listing what did.
    const graph = buildGraph([memory("a", ["b"]), memory("b", ["a"])]);
    expect(graph.edges).toHaveLength(1);
    expect(graph.nodes.map((n) => n.backlinks)).toEqual([1, 1]);
  });

  it("counts a mutual pair the same whichever way round it is read", () => {
    const forwards = buildGraph([memory("a", ["b"]), memory("b", ["a"])]);
    const backwards = buildGraph([memory("b", ["a"]), memory("a", ["b"])]);
    expect(forwards.nodes.map((n) => n.backlinks)).toEqual(
      backwards.nodes.map((n) => n.backlinks),
    );
  });

  it("counts a memory that links to the same one twice once", () => {
    // What `backlinks_in` (Rust) and `useMindBacklinks` (store) both answer:
    // how many MEMORIES point here, not how many `[[links]]` were typed.
    const graph = buildGraph([memory("a", ["b", "b"]), memory("b")]);
    expect(graph.nodes[1]!.backlinks).toBe(1);
    expect(graph.edges).toHaveLength(1);
  });

  it("keeps a mutual pair the same size as the hub they both point at", () => {
    // The real shape of the corpus: two memories that cite each other AND a
    // third that cites both. Every node here has exactly one memory pointing
    // at it, so every node is drawn the same size.
    const graph = buildGraph([
      memory("a", ["b"]),
      memory("b", ["a"]),
      memory("c", ["hub"]),
      memory("hub"),
    ]);
    expect(graph.nodes.map((n) => n.backlinks)).toEqual([1, 1, 0, 1]);
  });

  it("ignores a link to a memory outside this graph", () => {
    // A cross-project link is a real link and not an edge of THIS picture —
    // drawing it would need a node with nothing on the other end.
    const graph = buildGraph([memory("a", ["somewhere-else"])]);
    expect(graph.edges).toEqual([]);
  });

  it("ignores a link to itself", () => {
    const graph = buildGraph([memory("a", ["a"])]);
    expect(graph.edges).toEqual([]);
  });

  it("resolves a link case-insensitively", () => {
    const graph = buildGraph([memory("a", ["B"]), memory("b")]);
    expect(graph.edges).toHaveLength(1);
  });

  it("is empty for an empty corpus without dividing by anything", () => {
    const graph = buildGraph([]);
    expect(graph.nodes).toEqual([]);
    expect(() => stepLayout(graph)).not.toThrow();
    expect(graphBounds(graph)).toEqual({
      minX: -1,
      minY: -1,
      maxX: 1,
      maxY: 1,
    });
  });
});

describe("the layout", () => {
  it("is deterministic", () => {
    // Seeded from the index, not from Math.random: the same corpus lays out
    // the same way, which is what makes caching it meaningful.
    const corpus = [memory("a", ["b"]), memory("b"), memory("c")];
    const one = settleLayout(buildGraph(corpus));
    const two = settleLayout(buildGraph(corpus));
    expect(one.nodes.map((n) => [n.x, n.y])).toEqual(
      two.nodes.map((n) => [n.x, n.y]),
    );
  });

  it("settles, and stops being worth another frame", () => {
    const graph = buildGraph([memory("a", ["b"]), memory("b")]);
    expect(isSettled(graph)).toBe(false);
    settleLayout(graph);
    expect(isSettled(graph)).toBe(true);
  });

  it("produces finite positions for a corpus the size of the real one", () => {
    // The failure this rules out is a NaN, which on a canvas is not a wrong
    // picture — it is a blank one.
    const corpus = Array.from({ length: 67 }, (_, i) =>
      memory(`m${i}`, i % 3 === 0 ? [`m${(i + 7) % 67}`] : []),
    );
    const graph = settleLayout(buildGraph(corpus));
    for (const node of graph.nodes) {
      expect(Number.isFinite(node.x)).toBe(true);
      expect(Number.isFinite(node.y)).toBe(true);
    }
  });

  it("pulls linked memories closer than unlinked ones", () => {
    const graph = settleLayout(
      buildGraph([memory("a", ["b"]), memory("b"), memory("c")]),
    );
    const [a, b, c] = graph.nodes as [
      (typeof graph.nodes)[0],
      (typeof graph.nodes)[0],
      (typeof graph.nodes)[0],
    ];
    const between = (p: typeof a, q: typeof a) =>
      Math.hypot(p.x - q.x, p.y - q.y);
    expect(between(a, b)).toBeLessThan(between(a, c));
  });

  it("keeps an unconnected memory on screen", () => {
    // Nothing but repulsion acts on an island, so without the pull to the
    // middle it drifts off the canvas forever. The corpus really has these.
    const graph = settleLayout(
      buildGraph([memory("a", ["b"]), memory("b"), memory("island")]),
    );
    const bounds = graphBounds(graph);
    expect(bounds.maxX - bounds.minX).toBeLessThan(2000);
    expect(bounds.maxY - bounds.minY).toBeLessThan(2000);
  });
});

/** A corpus the shape of this machine's largest scope: 62 memories, a handful
 *  of hubs with several memories pointing at them, a long tail with one, and a
 *  fifth of them linked to nothing. Deterministic, so the assertions below are
 *  about the layout rather than about a seed. */
function realisticCorpus(): MindMemory[] {
  const names = Array.from({ length: 62 }, (_, i) => `memory-number-${i}`);
  return names.map((name, i) => {
    const links: string[] = [];
    // Every third memory cites one of five hubs; a third cite a neighbour;
    // the rest cite nothing.
    if (i % 3 === 0) links.push(names[(i * 7) % 5]!);
    if (i % 3 === 1) links.push(names[(i + 3) % 62]!);
    if (i % 9 === 4) links.push(names[(i * 11) % 62]!);
    return {
      scope: "-Users-l-Storefront",
      path: `/memory/${name}.md`,
      name,
      description: "",
      memoryType: "project",
      links,
      updatedAt: 1,
      bytes: 10,
    };
  });
}

/** The panes RocMind's graph actually gets.
 *
 *  The window is at least 1024×720 and the surface RocMind takes is the dock
 *  panel — 55% of it by default, and never less than 30%. The graph fills that
 *  surface, minus the two fifths the open memory takes beside it. So: about
 *  790×620 with nothing open on a default 1440 window, about 460×560 with a
 *  memory open on the smallest one. Both are tested; the small one is the
 *  exit criterion, and it is deliberately not the generous number. */
const PANES = [
  { what: "a memory open, smallest window", width: 460, height: 560 },
  { what: "nothing open, default window", width: 790, height: 620 },
] as const;

describe("fitting a corpus to the pane the app gives it", () => {
  const settled = () => settleLayout(buildGraph(realisticCorpus()));

  it.each(PANES)("draws no node on top of another ($what)", (pane) => {
    // The old layout put 282 of the 1891 pairs on top of each other in the
    // 288 px rail this used to be drawn in: a smear, not a graph.
    const fit = fitGraph(settled(), pane.width, pane.height);
    const collisions: string[] = [];
    for (let i = 0; i < fit.nodes.length; i += 1) {
      for (let j = i + 1; j < fit.nodes.length; j += 1) {
        const a = fit.nodes[i]!;
        const b = fit.nodes[j]!;
        if (Math.hypot(a.x - b.x, a.y - b.y) < a.r + b.r) {
          collisions.push(`${i}/${j}`);
        }
      }
    }
    expect(collisions).toEqual([]);
  });

  it.each(PANES)("keeps every node inside the canvas ($what)", (pane) => {
    const fit = fitGraph(settled(), pane.width, pane.height);
    for (const node of fit.nodes) {
      expect(node.x - node.r).toBeGreaterThanOrEqual(0);
      expect(node.x + node.r).toBeLessThanOrEqual(pane.width);
      expect(node.y - node.r).toBeGreaterThanOrEqual(0);
      expect(node.y + node.r).toBeLessThanOrEqual(pane.height);
    }
  });

  it.each(PANES)("uses most of the pane it was given ($what)", (pane) => {
    // A picture drawn at a third of the size of its pane is the other way to
    // be illegible.
    const fit = fitGraph(settled(), pane.width, pane.height);
    const xs = fit.nodes.map((n) => n.x);
    const ys = fit.nodes.map((n) => n.y);
    const spread = Math.max(
      (Math.max(...xs) - Math.min(...xs)) / pane.width,
      (Math.max(...ys) - Math.min(...ys)) / pane.height,
    );
    expect(spread).toBeGreaterThan(0.8);
  });

  it("sizes a hub visibly bigger than a memory nothing points at", () => {
    const fit = fitGraph(settled(), 790, 620);
    const radii = fit.nodes.map((n) => n.r);
    expect(Math.max(...radii)).toBeGreaterThan(Math.min(...radii) * 2);
  });

  it("separates one backlink from none, which a linear ramp did not", () => {
    // Most of a real corpus has nought or one backlink and a hub has seven, so
    // a linear ramp drew the majority as the same dot. The square root spends
    // the range where the memories are.
    const graph = buildGraph([
      memory("hub"),
      ...Array.from({ length: 7 }, (_, i) => memory(`cites-${i}`, ["hub"])),
      memory("cited-once"),
      memory("cites-it", ["cited-once"]),
    ]);
    const fit = fitGraph(settleLayout(graph), 790, 620);
    const none = fit.nodes[1]!.r;
    const one = fit.nodes[8]!.r;
    const seven = fit.nodes[0]!.r;
    expect(one - none).toBeGreaterThan(2);
    expect(seven).toBeGreaterThan(one);
  });

  it("shrinks the nodes when the pane is too small for them", () => {
    const graph = settled();
    const squeezed = fitGraph(graph, 300, 380);
    const roomy = fitGraph(graph, 790, 620);
    expect(squeezed.maxRadius).toBeLessThan(roomy.maxRadius);
    expect(squeezed.maxRadius).toBeGreaterThan(MIN_RADIUS);
  });

  it("never overlaps two nodes, whatever the corpus and whatever the pane", () => {
    // Not a tuned threshold: the fit caps every node at half the distance to
    // its nearest neighbour, so this holds for a corpus and a panel size
    // nobody anticipated — including a panel dragged down to a sliver.
    for (const size of [20, 62, 140]) {
      const corpus = Array.from({ length: size }, (_, i) =>
        memory(`m${i}`, [`m${(i * 13 + 1) % size}`, `m${(i * 5) % size}`]),
      );
      const graph = settleLayout(buildGraph(corpus));
      for (const [width, height] of [
        [120, 90],
        [288, 600],
        [460, 560],
        [790, 620],
        [1600, 900],
      ] as const) {
        const fit = fitGraph(graph, width, height);
        for (let i = 0; i < fit.nodes.length; i += 1) {
          for (let j = i + 1; j < fit.nodes.length; j += 1) {
            const a = fit.nodes[i]!;
            const b = fit.nodes[j]!;
            const apart = Math.hypot(a.x - b.x, a.y - b.y);
            // The one exception is the floor that keeps a node visible at all:
            // two memories drawn within a pixel of each other are still two
            // half-pixel dots rather than nothing.
            expect(a.r + b.r).toBeLessThanOrEqual(Math.max(apart, 1));
          }
        }
      }
    }
  });

  it("does not mirror the graph when the pane has no room at all", () => {
    // A panel dragged to nothing makes the padded width negative, and a
    // negative scale mirrors the picture rather than shrinking it.
    const fit = fitGraph(settled(), 10, 10);
    expect(fit.scale).toBeGreaterThan(0);
  });
});

describe("labels", () => {
  const measure = (text: string) => text.length * 6;

  it("shortens a name that will not fit, and keeps one that will", () => {
    expect(truncateToWidth("short", 120, measure)).toBe("short");
    const cut = truncateToWidth("a-very-long-memory-name-indeed", 60, measure);
    expect(measure(cut)).toBeLessThanOrEqual(60);
    expect(cut.endsWith("…")).toBe(true);
  });

  it("draws nothing rather than a stray ellipsis", () => {
    expect(truncateToWidth("anything", 3, measure)).toBe("");
    expect(truncateToWidth("anything", 0, measure)).toBe("");
  });

  it("keeps a centred label inside the canvas", () => {
    // They used to run off both edges: `textAlign: center` on a node 8 px from
    // the side of a 288 px rail.
    expect(clampLabelX(4, 100, 460)).toBe(52);
    expect(clampLabelX(458, 100, 460)).toBe(408);
    expect(clampLabelX(230, 100, 460)).toBe(230);
  });

  it("drops a label that would land on one already drawn", () => {
    const boxes = [
      { x: 10, y: 10, width: 80, height: 12 },
      { x: 40, y: 12, width: 80, height: 12 },
      { x: 200, y: 10, width: 80, height: 12 },
    ];
    expect(placeLabels(boxes)).toEqual([true, false, true]);
  });

  it("names the hubs, and only the hubs, when nothing is hovered", () => {
    const graph = buildGraph([
      memory("hub", []),
      memory("a", ["hub"]),
      memory("b", ["hub"]),
      memory("island"),
    ]);
    expect(hubIndices(graph, 3)).toEqual([0]);
    expect(hubIndices(buildGraph([memory("lonely")]), 3)).toEqual([]);
  });

  it("labels more of a big pane than of a small one", () => {
    expect(labelBudget(790, 620)).toBeGreaterThan(labelBudget(300, 300));
    expect(labelBudget(300, 300)).toBeGreaterThanOrEqual(3);
    expect(labelBudget(4000, 4000)).toBeLessThanOrEqual(8);
  });
});

describe("hopsFrom", () => {
  const chain = () =>
    buildGraph([
      memory("a", ["b"]),
      memory("b", ["c"]),
      memory("c", ["d"]),
      memory("d"),
      memory("island"),
    ]);

  it("counts hops out to the limit and no further", () => {
    expect(hopsFrom(chain(), 0, 2)).toEqual([0, 1, 2, 3, 3]);
  });

  it("puts an unreachable node past the limit", () => {
    expect(hopsFrom(chain(), 0, 2)[4]).toBe(3);
  });

  it("answers for an origin that is not a node", () => {
    expect(hopsFrom(chain(), -1, 2)).toEqual([3, 3, 3, 3, 3]);
  });
});

describe("the layout cache", () => {
  it("hands back the same settled layout rather than re-simulating", () => {
    // Reopening the tab must not rearrange the picture: the spatial memory
    // ("the release cluster is bottom-left") is most of what a graph is for.
    const corpus = [memory("a", ["b"]), memory("b")];
    const key = layoutKey(["-scope"], corpus);
    const first = cachedLayout(key, corpus);
    expect(cachedLayout(key, corpus)).toBe(first);
    expect(peekLayout(key)).toBe(first);
  });

  it("is invalidated by a memory appearing", () => {
    const before = [memory("a")];
    const after = [memory("a"), memory("b")];
    expect(layoutKey(["-scope"], before)).not.toBe(
      layoutKey(["-scope"], after),
    );
  });

  it("keeps different projects apart", () => {
    const corpus = [memory("a")];
    expect(layoutKey(["-one"], corpus)).not.toBe(layoutKey(["-two"], corpus));
  });
});
