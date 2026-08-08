/** The corpus as a picture: memories as nodes, `[[links]]` as edges.
 *
 *  **Canvas 2D, never WebGL.** This is not a preference. WebKit gives a process
 *  a small number of WebGL contexts, the terminals already spend that budget
 *  (the pane cap is 16 for this reason), and a graph that took one more would
 *  evict a pane's renderer — a user's terminal going blank because they looked
 *  at their memories. A hundred nodes on a 2D canvas is nothing.
 *
 *  One canvas rather than a hundred DOM nodes for the same family of reasons:
 *  a force layout moves every node every frame, and a hundred elements with
 *  transforms is a hundred style recalculations per frame.
 *
 *  What is drawn:
 *  - Nodes sized by BACKLINK count — the thing everything points at is the
 *    thing you should see first — and coloured by `metadata.type`, read from
 *    the theme's own CSS variables so a theme switch is not a second palette
 *    to keep in step.
 *  - Hovering dims everything more than two hops away, which is the question
 *    "what does this touch" answered spatially.
 *  - A search query pulses its matches, so typing finds a memory in the
 *    picture as well as in the list.
 *
 *  What is NOT done: no frames are scheduled when this is not mounted (the tab
 *  swap unmounts it), the loop stops the moment the layout settles, and under
 *  `prefers-reduced-motion` there is no loop at all — the settled layout is
 *  computed in one go and drawn once. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildGraph,
  cachedLayout,
  clampLabelX,
  fitGraph,
  hopsFrom,
  hubIndices,
  isSettled,
  labelBudget,
  layoutKey,
  peekLayout,
  placeLabels,
  rememberLayout,
  stepLayout,
  truncateToWidth,
  type LabelBox,
  type MindGraph as Graph,
} from "@/lib/mindGraph";
import { searchTerms } from "@/lib/mindSearch";
import type { MindMemory } from "@/lib/bindings";

/** Hops beyond which a hover dims a node. Two: your neighbours and theirs. */
const HOVER_RADIUS = 2;

/** The label font, and the line height that goes with it. Set on the context
 *  before anything is measured — `measureText` answers for the font that is
 *  set, so measuring before setting it measures the wrong thing. */
const LABEL_FONT = "11px ui-sans-serif, system-ui, -apple-system, sans-serif";
const LABEL_HEIGHT = 12;

/** Theme variable per `metadata.type`.
 *
 *  Canvas takes colours, not classes, so these are read from the document with
 *  `getComputedStyle` — which is how a canvas obeys "theme tokens only, no raw
 *  hex". An unknown type falls back to the muted text colour rather than to a
 *  colour of its own: it is a memory whose author did not say what kind it is,
 *  and inventing a category for it would be a lie in the legend. */
const TYPE_VARIABLE: Record<string, string> = {
  project: "--rs-primary",
  feedback: "--rs-warning",
  user: "--rs-success",
  reference: "--rs-info",
};
const FALLBACK_VARIABLE = "--rs-text-3";

interface Palette {
  edge: string;
  label: string;
  ring: string;
  byType: Record<string, string>;
  fallback: string;
}

function readPalette(element: HTMLElement): Palette {
  const styles = getComputedStyle(element);
  const read = (name: string, fallback: string) =>
    styles.getPropertyValue(name).trim() || fallback;
  const byType: Record<string, string> = {};
  for (const [type, variable] of Object.entries(TYPE_VARIABLE)) {
    byType[type] = read(variable, "#888888");
  }
  return {
    // No background: the canvas is CLEARED rather than filled, so the panel's
    // own surface shows through and a theme change needs nothing from here.
    edge: read("--rs-border", "#333338"),
    label: read("--rs-text-2", "#aaaaaa"),
    ring: read("--rs-text", "#eeeeee"),
    byType,
    fallback: read(FALLBACK_VARIABLE, "#888888"),
  };
}

export interface MindGraphProps {
  /** The memories to draw — a project's own plus its worktrees', or the whole
   *  corpus when nothing is scoped. */
  memories: MindMemory[];
  /** Scope slugs these came from, for the layout cache's key. */
  scopes: string[];
  /** The open memory's path, drawn with a ring. */
  selectedPath: string | null;
  /** The search box's contents. Matches pulse. */
  query: string;
  /** Which memories the query matched, by path — the SAME answer the tree's
   *  result list is built from (`useMindSearchResults` → `searchMemories`).
   *
   *  Handed in rather than worked out here, and that is the fix rather than the
   *  plumbing: this canvas used to match on `node.name` alone, so a query that
   *  found six memories by description or body listed six rows in the tree and
   *  pulsed none of them in the graph — while the header's effect went on
   *  reading every body the ranking needed, for a tab that then threw the
   *  answer away. */
  matchedPaths: ReadonlySet<string>;
  onSelect: (path: string) => void;
}

export function MindGraph({
  memories,
  scopes,
  selectedPath,
  query,
  matchedPaths,
  onSelect,
}: MindGraphProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  /** Where each node ended up ON SCREEN after the last paint, so hit testing
   *  asks the same question the eye did. Kept in a ref: it changes every frame
   *  and nothing renders it. */
  const screen = useRef<{ x: number; y: number; r: number }[]>([]);

  const key = useMemo(() => layoutKey(scopes, memories), [scopes, memories]);

  /** The layout. A cached one is used as-is and drawn settled; a new one starts
   *  from its seed positions and is animated (or settled outright, under
   *  reduced motion) by the effect below. */
  const graph = useMemo<Graph>(() => {
    const reduced = prefersReducedMotion();
    if (reduced) return cachedLayout(key, memories);
    return peekLayout(key) ?? buildGraph(memories);
  }, [key, memories]);

  const matches = useMemo(() => {
    // The query still decides WHETHER anything pulses — an empty box is not a
    // search, and `matchedPaths` is empty for one anyway — but WHICH nodes is
    // the caller's answer, so the picture and the list agree.
    if (searchTerms(query).length === 0) return new Set<number>();
    const hits = new Set<number>();
    graph.nodes.forEach((node, index) => {
      if (matchedPaths.has(node.path)) hits.add(index);
    });
    return hits;
  }, [graph, query, matchedPaths]);

  const selectedIndex = useMemo(
    () => graph.nodes.findIndex((node) => node.path === selectedPath),
    [graph, selectedPath],
  );

  const draw = useCallback(
    (time: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const context = canvas.getContext("2d");
      // jsdom has no 2D context, and neither does a canvas whose GPU process
      // has gone away. Neither is a reason to throw inside a frame callback.
      if (!context) return;

      const ratio = window.devicePixelRatio || 1;
      const width = canvas.clientWidth || 1;
      const height = canvas.clientHeight || 1;
      if (canvas.width !== Math.round(width * ratio)) {
        canvas.width = Math.round(width * ratio);
      }
      if (canvas.height !== Math.round(height * ratio)) {
        canvas.height = Math.round(height * ratio);
      }
      context.setTransform(ratio, 0, 0, ratio, 0, 0);

      const palette = readPalette(canvas);
      context.clearRect(0, 0, width, height);

      // Fit the layout's own units to the canvas — sizing, centring and the
      // squeezed-pane shrink all live in `fitGraph`, where they can be measured
      // against the real corpus without a canvas.
      const positions = fitGraph(graph, width, height).nodes;
      screen.current = positions;

      const hops =
        hovered === null ? null : hopsFrom(graph, hovered, HOVER_RADIUS);
      const dimmed = (index: number) =>
        hops !== null && (hops[index] ?? Infinity) > HOVER_RADIUS;

      // Edges first, under everything.
      context.lineWidth = 1;
      for (const edge of graph.edges) {
        const a = positions[edge.from]!;
        const b = positions[edge.to]!;
        context.globalAlpha = dimmed(edge.from) && dimmed(edge.to) ? 0.06 : 0.5;
        context.strokeStyle = palette.edge;
        context.beginPath();
        context.moveTo(a.x, a.y);
        context.lineTo(b.x, b.y);
        context.stroke();
      }

      // The pulse: a slow sine so a match breathes rather than blinks. Frozen
      // at full strength under reduced motion, where there is no frame loop to
      // animate it and a highlight is the honest version of the same signal.
      const pulse = prefersReducedMotion()
        ? 1
        : 0.55 + 0.45 * Math.sin(time / 260);

      graph.nodes.forEach((node, index) => {
        const at = positions[index]!;
        const colour = palette.byType[node.memoryType] ?? palette.fallback;
        const isMatch = matches.has(index);
        context.globalAlpha = dimmed(index) ? 0.12 : 1;

        if (isMatch) {
          context.beginPath();
          context.arc(at.x, at.y, at.r + 4 + pulse * 3, 0, Math.PI * 2);
          context.fillStyle = colour;
          context.globalAlpha = (dimmed(index) ? 0.06 : 0.25) * pulse;
          context.fill();
          context.globalAlpha = dimmed(index) ? 0.12 : 1;
        }

        context.beginPath();
        context.arc(at.x, at.y, at.r, 0, Math.PI * 2);
        context.fillStyle = colour;
        context.fill();

        if (index === selectedIndex || index === hovered) {
          context.lineWidth = 2;
          context.strokeStyle = palette.ring;
          context.stroke();
          context.lineWidth = 1;
        }
      });

      // Labels last, over the nodes, and only the ones that can be read.
      //
      // Ranked rather than filtered: the hovered memory, then the selection,
      // then what the search matched, then the hover's immediate neighbours,
      // and then — this is the part that makes a graph nobody has touched yet
      // worth looking at — the hubs, as many as the pane has room for. Each
      // name is shortened to fit, kept inside the canvas (they used to run off
      // both edges), and dropped outright if it would land on one already
      // drawn.
      context.font = LABEL_FONT;
      context.textAlign = "center";
      context.textBaseline = "top";
      const measure = (text: string) => context.measureText(text).width;
      const maxLabelWidth = Math.min(150, Math.max(56, width * 0.28));

      const ranked: number[] = [];
      const consider = (index: number | null | undefined) => {
        if (index === null || index === undefined || index < 0) return;
        if (!ranked.includes(index)) ranked.push(index);
      };
      consider(hovered);
      consider(selectedIndex);
      for (const index of matches) consider(index);
      if (hops !== null) {
        graph.nodes.forEach((_, index) => {
          if ((hops[index] ?? Infinity) <= 1) consider(index);
        });
      }
      // At rest — nothing hovered, nothing selected, no query — the hubs are
      // the only labels, which is what tells you what the picture is about.
      for (const index of hubIndices(graph, labelBudget(width, height))) {
        consider(index);
      }

      const labels = ranked.map((index) => {
        const at = positions[index]!;
        const text = truncateToWidth(
          graph.nodes[index]!.name,
          maxLabelWidth,
          measure,
        );
        const textWidth = measure(text);
        const x = clampLabelX(at.x, textWidth, width);
        const y = at.y + at.r + 3;
        const box: LabelBox = {
          x: x - textWidth / 2,
          y,
          width: textWidth,
          height: LABEL_HEIGHT,
        };
        return { index, text, x, y, box };
      });

      const room = placeLabels(labels.map((label) => label.box));
      labels.forEach((label, order) => {
        if (!room[order] || label.text === "") return;
        context.globalAlpha = dimmed(label.index) ? 0.2 : 0.9;
        context.fillStyle = palette.label;
        context.fillText(label.text, label.x, label.y);
      });

      context.globalAlpha = 1;
    },
    [graph, hovered, matches, selectedIndex],
  );

  // The frame loop. Runs only while this component is mounted — the tab swap
  // unmounts it, which is what "no frames when the tab is not visible" means —
  // and stops the moment the layout settles.
  useEffect(() => {
    if (prefersReducedMotion()) {
      draw(0);
      return;
    }
    let frame = 0;
    let running = true;
    const tick = (time: number) => {
      if (!running) return;
      if (!isSettled(graph)) {
        stepLayout(graph);
        if (isSettled(graph)) rememberLayout(key, graph);
      }
      draw(time);
      // A settled layout still needs frames for the hover and the pulse, but
      // only while there is something to animate. Otherwise the loop ends and
      // the canvas keeps its last paint.
      if (isSettled(graph) && matches.size === 0) return;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      running = false;
      cancelAnimationFrame(frame);
    };
  }, [graph, draw, key, matches]);

  // Repaint on hover and on a resize without restarting the simulation.
  useEffect(() => {
    draw(performance.now());
  }, [draw]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => draw(performance.now()));
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [draw]);

  /** Which node is under the pointer, using the positions actually painted. */
  const nodeAt = (
    event: React.MouseEvent<HTMLCanvasElement>,
  ): number | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const box = canvas.getBoundingClientRect();
    const x = event.clientX - box.left;
    const y = event.clientY - box.top;
    let best: number | null = null;
    let bestDistance = Infinity;
    screen.current.forEach((at, index) => {
      const dx = x - at.x;
      const dy = y - at.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      // A little forgiveness around the smallest nodes, which are 4px across.
      if (distance <= at.r + 4 && distance < bestDistance) {
        best = index;
        bestDistance = distance;
      }
    });
    return best;
  };

  if (memories.length === 0) {
    return (
      <div className="grid h-full place-items-center p-6 text-center">
        <p className="max-w-xs text-xs leading-relaxed text-fg-muted">
          Nothing to draw yet. Memories and the `[[links]]` between them appear
          here as soon as your agents write some.
        </p>
      </div>
    );
  }

  return (
    <div className="relative h-full w-full">
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={`${plural(graph.nodes.length, "memory", "memories")}, ${plural(graph.edges.length, "link", "links")}`}
        className="h-full w-full"
        onMouseMove={(event) => setHovered(nodeAt(event))}
        onMouseLeave={() => setHovered(null)}
        onClick={(event) => {
          const index = nodeAt(event);
          if (index !== null) onSelect(graph.nodes[index]!.path);
        }}
      />
      <Legend />
    </div>
  );
}

/** What the colours mean. Four types and an "other", from the same tokens the
 *  canvas reads — so the swatch and the node cannot disagree. */
function Legend() {
  return (
    <ul className="pointer-events-none absolute bottom-2 left-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-fg-muted">
      {Object.keys(TYPE_VARIABLE).map((type) => (
        <li key={type} className="flex items-center gap-1">
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{ background: `var(${TYPE_VARIABLE[type]})` }}
          />
          {type}
        </li>
      ))}
      <li className="flex items-center gap-1">
        <span
          className="inline-block h-2 w-2 rounded-full"
          style={{ background: `var(${FALLBACK_VARIABLE})` }}
        />
        untyped
      </li>
    </ul>
  );
}

const plural = (count: number, one: string, many: string): string =>
  `${count} ${count === 1 ? one : many}`;

/** Does this user ask for less motion?
 *
 *  Asked per call rather than cached, because it can change while the app is
 *  running (macOS's Reduce Motion is a toggle in Accessibility, not a boot
 *  flag), and because the answer is one `matchMedia` lookup. */
function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}
