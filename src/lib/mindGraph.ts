/** The graph the corpus already has, laid out.
 *
 *  67 memories and 110 links on this machine, every link resolving — so there
 *  is nothing to infer and nothing to embed. `buildGraph` is a join: a node per
 *  memory, an edge per `[[link]]` that names one.
 *
 *  The layout is a plain force simulation — repulsion between every pair,
 *  springs along the edges, a weak pull to the middle, and a temperature that
 *  cools. O(n²) per tick, which for a corpus of this size is a few thousand
 *  operations: a quadtree would be more code than the whole file for a cost
 *  nobody can measure.
 *
 *  Two properties the view depends on, and both are why this is a module and
 *  not a hook:
 *
 *  *Deterministic.* Initial positions come from the node's index on a golden-
 *  angle spiral, not from `Math.random()`. The same corpus lays out the same
 *  way every time, which is what makes the layout worth caching and what makes
 *  it testable at all.
 *
 *  *Steppable.* `stepLayout` is one tick. The view animates by calling it from
 *  a frame loop, and under `prefers-reduced-motion` it calls `settleLayout`
 *  instead and draws the finished thing once. Neither knows about the other. */

import type { MindMemory } from "@/lib/bindings";

export interface GraphNode {
  /** The memory's path — the identity everything else keys on. */
  path: string;
  name: string;
  /** Frontmatter `metadata.type`, or `""`. Decides the colour. */
  memoryType: string;
  /** How many memories link TO this one. Decides the radius: the thing
   *  everything points at should be the thing you see first. */
  backlinks: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export interface GraphEdge {
  /** Indices into `nodes`. Indices rather than paths because every tick walks
   *  these, and a map lookup per edge per frame is the one cost here that is
   *  avoidable. */
  from: number;
  to: number;
}

export interface MindGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Adjacency, both directions, for the hover dimming's hop counting. */
  neighbours: number[][];
  /** How much heat is left in the simulation. Starts at 1, cools to 0; a
   *  layout at 0 is settled and the view stops scheduling frames. */
  temperature: number;
}

/** Radius of the spiral the nodes start on, in layout units. The layout is
 *  unitless and the view scales it to fit, so this only sets the shape. */
const SEED_RADIUS = 240;

/** The golden angle, which is what makes an index-ordered spiral spread out
 *  evenly instead of forming spokes. */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/** Ideal edge length. Everything else is expressed relative to it. */
const SPRING_LENGTH = 160;

/** How close two nodes may sit before they are pushed apart regardless of what
 *  the rest of the layout wants, in layout units.
 *
 *  Chosen from the drawing rather than from the physics: what the picture needs
 *  is that no two of the 62 memories in this machine's largest scope are drawn
 *  on top of each other in the pane RocMind actually gets. Measured against
 *  that corpus at five pane sizes — see `mindGraph.test.ts`. */
const MIN_SEPARATION = 500;

/** How hard the short-range push is, per unit of overlap. Stiff enough to win
 *  against a hub's springs, soft enough not to make the layout ring. */
const CROWDING = 0.9;

/** How strongly every node is pulled back to the middle, per unit of distance.
 *
 *  This is what decides how SPREAD the picture is, and it was the whole of the
 *  old graph's illegibility: at 0.02 the corpus settled into a box 5 700 units
 *  across while linked memories sat 126 apart, so fitting the box to any pane
 *  squeezed every cluster into a smear. At 0.5 the same corpus settles into a
 *  disc a few hundred units across and the clusters survive the fit. */
const CENTRE_PULL = 0.5;

/** How fast the temperature falls. 0.97 settles in roughly 200 ticks, which is
 *  about three seconds of animation and an imperceptible pause when it is run
 *  all at once for reduced motion. */
const COOLING = 0.97;

/** Below this the layout is settled: nothing moves far enough to see. */
const SETTLED = 0.02;

/** Ticks `settleLayout` runs. Enough that the temperature is well under
 *  `SETTLED` from a cold start. */
export const SETTLE_TICKS = 300;

/** Build the graph of a set of memories.
 *
 *  Links are resolved by NAME, case-insensitively, and only within the set
 *  handed in — a link to a memory in another project is a real link and not an
 *  edge of this graph, and drawing it would need a node that is not on screen.
 *
 *  Duplicated names within a scope cannot happen (they are filenames' stems in
 *  practice), but across a project's unified scopes they can: the first one
 *  wins, which is the same rule `openMemoryByName` follows. */
export function buildGraph(memories: readonly MindMemory[]): MindGraph {
  const nodes: GraphNode[] = memories.map((memory, index) => ({
    path: memory.path,
    name: memory.name,
    memoryType: memory.memoryType,
    backlinks: 0,
    ...seedPosition(index, memories.length),
    vx: 0,
    vy: 0,
  }));

  const byName = new Map<string, number>();
  memories.forEach((memory, index) => {
    const key = memory.name.toLowerCase();
    if (!byName.has(key)) byName.set(key, index);
  });

  const edges: GraphEdge[] = [];
  /** Pairs already drawn — undirected, because two memories that link to each
   *  other are one line. */
  const drawn = new Set<string>();
  /** Links already counted — DIRECTED, because A→B and B→A are two backlinks
   *  even though they are one line. Counting them on the undirected key made
   *  the earlier member of every mutual pair a `MIN_RADIUS` dot: 7 of the 62
   *  memories in this machine's largest scope, drawn as if nothing pointed at
   *  them while the backlinks pane beside the graph listed what did. */
  const counted = new Set<string>();
  memories.forEach((memory, from) => {
    for (const link of memory.links) {
      const to = byName.get(link.trim().toLowerCase());
      if (to === undefined || to === from) continue;

      // Once per source memory, not once per `[[link]]`: a body that names the
      // same memory twice is one memory pointing at it, which is the count
      // `backlinks_in` (Rust) and `useMindBacklinks` (store) both produce.
      const directed = `${from}->${to}`;
      if (!counted.has(directed)) {
        counted.add(directed);
        nodes[to]!.backlinks += 1;
      }

      const pair = from < to ? `${from}:${to}` : `${to}:${from}`;
      if (drawn.has(pair)) continue;
      drawn.add(pair);
      edges.push({ from, to });
    }
  });

  const neighbours: number[][] = nodes.map(() => []);
  for (const edge of edges) {
    neighbours[edge.from]!.push(edge.to);
    neighbours[edge.to]!.push(edge.from);
  }

  return { nodes, edges, neighbours, temperature: 1 };
}

/** Where node `index` of `total` starts. A golden-angle spiral: deterministic,
 *  and already roughly evenly spread, so the simulation spends its ticks on
 *  structure rather than on undoing a bad guess. */
function seedPosition(index: number, total: number): { x: number; y: number } {
  const radius = SEED_RADIUS * Math.sqrt((index + 0.5) / Math.max(total, 1));
  const angle = index * GOLDEN_ANGLE;
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}

/** One tick of the simulation. Mutates `graph` in place. */
export function stepLayout(graph: MindGraph): void {
  const { nodes, edges } = graph;
  if (nodes.length === 0) return;

  // Repulsion, every pair. The `+ 0.01` is not a fudge: two nodes at exactly
  // the same point (a link to itself's neighbour, a corpus of clones) divide by
  // zero and fly off to infinity, and a NaN in a canvas is an empty canvas.
  for (let i = 0; i < nodes.length; i += 1) {
    const a = nodes[i]!;
    for (let j = i + 1; j < nodes.length; j += 1) {
      const b = nodes[j]!;
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const distance = Math.sqrt(dx * dx + dy * dy) + 0.01;
      // Two terms, and the second is what makes the picture readable. The
      // inverse-linear one spreads the graph; on its own it lets a hub's
      // followers pile into a knot the fit then draws as one blob (282 of the
      // 1891 pairs in this machine's largest scope overlapped). The short-range
      // one only exists below `MIN_SEPARATION` and simply pushes two nodes off
      // each other, which is the distance a drawn node plus its ring needs.
      const crowding = Math.max(0, MIN_SEPARATION - distance) * CROWDING;
      const force = (SPRING_LENGTH * SPRING_LENGTH) / distance + crowding;
      const fx = (dx / distance) * force;
      const fy = (dy / distance) * force;
      a.vx += fx;
      a.vy += fy;
      b.vx -= fx;
      b.vy -= fy;
    }
  }

  // Springs along the edges.
  for (const edge of edges) {
    const a = nodes[edge.from]!;
    const b = nodes[edge.to]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const distance = Math.sqrt(dx * dx + dy * dy) + 0.01;
    const force = (distance * distance) / SPRING_LENGTH;
    const fx = (dx / distance) * force;
    const fy = (dy / distance) * force;
    a.vx += fx;
    a.vy += fy;
    b.vx -= fx;
    b.vy -= fy;
  }

  // The pull to the origin. It is what stops the components with no edges
  // between them from drifting apart forever — the corpus really does have
  // isolated memories — and it is also what sets the scale of the whole
  // picture against the distance between two linked memories.
  for (const node of nodes) {
    node.vx -= node.x * CENTRE_PULL;
    node.vy -= node.y * CENTRE_PULL;
  }

  // Move, capped by the temperature: early ticks rearrange, late ticks nudge.
  const limit = graph.temperature * SPRING_LENGTH;
  for (const node of nodes) {
    const speed = Math.sqrt(node.vx * node.vx + node.vy * node.vy) + 0.01;
    const scale = Math.min(speed, limit) / speed;
    node.x += node.vx * scale;
    node.y += node.vy * scale;
    // Velocities are re-accumulated from scratch each tick rather than carried:
    // this is a relaxation, not a physical body, and momentum makes it ring.
    node.vx = 0;
    node.vy = 0;
  }

  graph.temperature *= COOLING;
}

/** Has the simulation stopped being worth another frame? */
export const isSettled = (graph: MindGraph): boolean =>
  graph.temperature < SETTLED || graph.nodes.length === 0;

/** Run the simulation to a standstill in one go — what reduced motion gets, and
 *  what the layout cache stores. */
export function settleLayout(
  graph: MindGraph,
  ticks = SETTLE_TICKS,
): MindGraph {
  for (let i = 0; i < ticks && !isSettled(graph); i += 1) stepLayout(graph);
  return graph;
}

/** The box the laid-out nodes occupy. The view fits this to the canvas rather
 *  than assuming the simulation's units mean anything. */
export function graphBounds(graph: MindGraph): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  if (graph.nodes.length === 0) {
    return { minX: -1, minY: -1, maxX: 1, maxY: 1 };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of graph.nodes) {
    minX = Math.min(minX, node.x);
    minY = Math.min(minY, node.y);
    maxX = Math.max(maxX, node.x);
    maxY = Math.max(maxY, node.y);
  }
  return { minX, minY, maxX, maxY };
}

// -- fitting the layout to a pane -------------------------------------------

/** Node radius, smallest (nothing points at it) to largest. */
export const MIN_RADIUS = 4;
export const MAX_RADIUS = 13;

/** Padding around the fitted layout, in device-independent pixels. Wide enough
 *  for the biggest node plus the line of text under it. */
export const PADDING = 30;

/** The most the layout is ever magnified. A three-memory project should not be
 *  three dinner plates. */
const MAX_SCALE = 1.6;

/** Roughly how much canvas one node wants around it, as a side length, before
 *  the drawing starts shrinking the nodes to keep them apart. Five times the
 *  largest radius: the picture stops being nodes-with-gaps below that. */
const ROOM_PER_NODE = MAX_RADIUS * 5;

/** Where one node is drawn, in canvas pixels. */
export interface FittedNode {
  x: number;
  y: number;
  /** Radius, from the backlink count and how much room the pane has. */
  r: number;
}

export interface Fitted {
  /** Layout units → pixels. */
  scale: number;
  /** The largest radius any node in this pane gets. */
  maxRadius: number;
  nodes: FittedNode[];
}

/** Put a settled layout on a pane of `width` × `height`.
 *
 *  Separated from the canvas because it is where legibility is decided and
 *  because a canvas cannot be measured in a test. Three things happen here:
 *
 *  *Fit.* The layout's own units are scaled so its bounding box sits inside the
 *  padding, magnified no more than `MAX_SCALE`.
 *
 *  *Size.* Radius grows with the SQUARE ROOT of the backlink count, not
 *  linearly: most of a real corpus has nought or one backlink and a handful
 *  have eight, and a linear ramp draws that majority as one indistinguishable
 *  dot size. The largest radius also shrinks when the pane is too small for the
 *  number of nodes, so a squeezed panel gets smaller dots rather than a blob.
 *
 *  *Room.* No node is drawn wider than half the distance to its nearest
 *  neighbour, which makes overlap impossible rather than unlikely: for any pair
 *  `r(a) + r(b) ≤ d(a,b) − 1`. Per node rather than over the whole graph, so
 *  one tight pair costs those two their size and not the picture's. That is
 *  what the O(n²) pass below buys — the same order as one tick of the
 *  simulation, and it runs once per paint rather than once per tick.
 *
 *  *Centre.* The fitted box is centred, so the picture does not drift to a
 *  corner when the panel is resized. */
export function fitGraph(
  graph: MindGraph,
  width: number,
  height: number,
): Fitted {
  const count = graph.nodes.length;
  const bounds = graphBounds(graph);
  const spanX = Math.max(bounds.maxX - bounds.minX, 1);
  const spanY = Math.max(bounds.maxY - bounds.minY, 1);
  // Clamped positive: a panel dragged to nothing (or a canvas that has not
  // been laid out yet) makes the padded width negative, and a negative scale
  // mirrors the whole graph rather than shrinking it.
  const scale = Math.max(
    Math.min(
      (width - PADDING * 2) / spanX,
      (height - PADDING * 2) / spanY,
      MAX_SCALE,
    ),
    0.01,
  );
  const offsetX = width / 2 - ((bounds.minX + bounds.maxX) / 2) * scale;
  const offsetY = height / 2 - ((bounds.minY + bounds.maxY) / 2) * scale;

  // How much canvas there is per node, as a side length.
  const room = Math.sqrt(Math.max(width * height, 1) / Math.max(count, 1));
  const maxRadius = Math.min(
    MAX_RADIUS,
    Math.max(MIN_RADIUS + 1, (room / ROOM_PER_NODE) * MAX_RADIUS),
  );

  const most = graph.nodes.reduce(
    (top, node) => Math.max(top, node.backlinks),
    0,
  );
  const nodes: FittedNode[] = graph.nodes.map((node) => ({
    x: node.x * scale + offsetX,
    y: node.y * scale + offsetY,
    r:
      MIN_RADIUS +
      (maxRadius - MIN_RADIUS) *
        (most === 0 ? 0 : Math.sqrt(node.backlinks / most)),
  }));

  // Nobody is drawn over anybody. Half the distance to the nearest neighbour,
  // less half a pixel, so two circles always have a gap between them however
  // tightly the simulation packed them.
  const nearest = nodes.map(() => Infinity);
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const a = nodes[i]!;
      const b = nodes[j]!;
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      if (distance < nearest[i]!) nearest[i] = distance;
      if (distance < nearest[j]!) nearest[j] = distance;
    }
  }
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i]!;
    // Still a dot: two memories drawn less than a pixel apart (which the
    // simulation's own `+ 0.01` exists for) would otherwise have no radius at
    // all, and an invisible node is worse than two touching ones.
    node.r = Math.max(0.5, Math.min(node.r, nearest[i]! / 2 - 0.5));
  }

  return { scale, maxRadius, nodes };
}

/** The nodes worth naming when nothing is hovered: the most-linked-to, so the
 *  picture says what its hubs are before anybody touches it.
 *
 *  A node nothing points at is never a hub, however empty the graph — labelling
 *  the first `limit` of a corpus with no links at all would be labelling
 *  whatever came first alphabetically. */
export function hubIndices(graph: MindGraph, limit: number): number[] {
  return graph.nodes
    .map((node, index) => ({ index, backlinks: node.backlinks }))
    .filter((it) => it.backlinks > 0)
    .sort((a, b) => b.backlinks - a.backlinks || a.index - b.index)
    .slice(0, Math.max(limit, 0))
    .map((it) => it.index);
}

/** How many labels a pane this size can hold at rest without becoming a smear.
 *  One per ~20 000 px², between three and eight. */
export function labelBudget(width: number, height: number): number {
  const room = Math.floor((width * height) / 20000);
  return Math.min(8, Math.max(3, room));
}

/** `text`, shortened with an ellipsis until it measures no wider than `max`.
 *
 *  `measure` is the canvas's own `measureText`, passed in so this is testable
 *  and so the caller pays for the font it actually set. A name that will not
 *  fit even as one character comes back empty: no label at all beats a stray
 *  "…" under a dot. */
export function truncateToWidth(
  text: string,
  max: number,
  measure: (text: string) => number,
): string {
  if (max <= 0) return "";
  if (measure(text) <= max) return text;
  let kept = text.length - 1;
  while (kept > 0 && measure(`${text.slice(0, kept)}…`) > max) kept -= 1;
  return kept > 0 ? `${text.slice(0, kept)}…` : "";
}

/** Where a centred label's midpoint has to sit so the whole thing stays on the
 *  canvas. The old graph drew labels centred on the node with no clamp, so
 *  every name near an edge ran off it. */
export function clampLabelX(
  x: number,
  labelWidth: number,
  width: number,
): number {
  const half = labelWidth / 2;
  if (labelWidth >= width) return width / 2;
  return Math.min(Math.max(x, half + 2), width - half - 2);
}

/** A label's box on the canvas, top-left anchored. */
export interface LabelBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Which of these labels can be drawn without landing on each other.
 *
 *  Greedy, in the order given, which is the order the caller ranks them in:
 *  the hovered memory's name matters more than a hub's. Two overlapping labels
 *  are worse than one label — the whole reason the old graph drew none at rest
 *  was that sixty-seven of them were a smear — so the loser is simply dropped. */
export function placeLabels(boxes: readonly LabelBox[]): boolean[] {
  const placed: LabelBox[] = [];
  return boxes.map((box) => {
    const clear = placed.every(
      (other) =>
        box.x > other.x + other.width + 2 ||
        other.x > box.x + box.width + 2 ||
        box.y > other.y + other.height + 1 ||
        other.y > box.y + box.height + 1,
    );
    if (clear) placed.push(box);
    return clear;
  });
}

/** How many hops each node is from `origin`, capped at `limit + 1` (which
 *  reads as "further than we care about").
 *
 *  Breadth-first, and the cap is what makes it cheap: hovering a node in a
 *  connected corpus would otherwise walk all 67 every mouse move. */
export function hopsFrom(
  graph: MindGraph,
  origin: number,
  limit: number,
): number[] {
  const beyond = limit + 1;
  const hops = graph.nodes.map(() => beyond);
  if (origin < 0 || origin >= graph.nodes.length) return hops;
  hops[origin] = 0;
  let frontier = [origin];
  for (let depth = 1; depth <= limit && frontier.length > 0; depth += 1) {
    const next: number[] = [];
    for (const index of frontier) {
      for (const neighbour of graph.neighbours[index] ?? []) {
        if (hops[neighbour] !== beyond) continue;
        hops[neighbour] = depth;
        next.push(neighbour);
      }
    }
    frontier = next;
  }
  return hops;
}

// -- the layout cache -------------------------------------------------------

/** Settled layouts, by the scopes they were computed for.
 *
 *  Reopening the graph tab must not re-simulate: three hundred ticks over 67
 *  nodes is a visible pause, and — worse — the graph would REARRANGE, so the
 *  spatial memory the user built up (“the release cluster is bottom-left”) is
 *  gone every time they look away.
 *
 *  Keyed on the corpus itself, not just the scope name, so a memory appearing
 *  invalidates the cache rather than being left out of the picture. */
const layouts = new Map<string, MindGraph>();

/** The cache key for a set of memories: what is in them, in order. */
export function layoutKey(
  scopes: readonly string[],
  memories: readonly MindMemory[],
): string {
  return `${scopes.join("|")}::${memories.map((m) => m.path).join("|")}`;
}

/** A settled layout for these memories — from the cache when it is there. */
export function cachedLayout(
  key: string,
  memories: readonly MindMemory[],
): MindGraph {
  const hit = layouts.get(key);
  if (hit) return hit;
  const graph = settleLayout(buildGraph(memories));
  layouts.set(key, graph);
  return graph;
}

/** A cache entry, if one exists, without computing one. Lets the view animate
 *  a FRESH layout from its seed positions and reuse a settled one instantly. */
export const peekLayout = (key: string): MindGraph | undefined =>
  layouts.get(key);

/** Record a layout the view animated to a standstill itself. */
export function rememberLayout(key: string, graph: MindGraph): void {
  layouts.set(key, graph);
}

/** Test seam: the cache is module-global by design, and a suite that left an
 *  entry behind would change what the next one observes. */
export function resetLayoutCache(): void {
  layouts.clear();
}
