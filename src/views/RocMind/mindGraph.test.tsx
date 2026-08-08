/** The graph tab on screen — and the two rules it exists under: Canvas 2D
 *  only, and no frames when it is not showing. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

import { resetLayoutCache } from "@/lib/mindGraph";
import { resetRocMindModuleState, useRocMindStore } from "@/stores/rocmind";
import { MindGraph } from "@/views/RocMind/MindGraph";
import { MindView } from "@/views/RocMind/MindView";
import type { MindMemory, MindScope } from "@/lib/bindings";

const SCOPE = "-Users-l-Storefront";

const storefront: MindScope = {
  slug: SCOPE,
  projectPath: "/Users/l/Storefront",
  label: "Storefront",
  isWorktree: false,
  rootPath: null,
  count: 2,
};

const memory = (name: string, links: string[] = []): MindMemory => ({
  scope: SCOPE,
  path: `/p/${SCOPE}/memory/${name}.md`,
  name,
  description: "",
  memoryType: "project",
  links,
  updatedAt: 1,
  bytes: 10,
});

const corpus = [memory("payments", ["test-ads"]), memory("test-ads")];

const OTHER = "-Users-l-Elsewhere";

/** A second, unrelated project — so scoping the graph to one of them really is
 *  narrower than the corpus, which a project and its own worktrees would not
 *  be (`searchSlugs` unifies those on purpose). */
const elsewhere: MindScope = {
  slug: OTHER,
  projectPath: "/Users/l/Elsewhere",
  label: "Elsewhere",
  isWorktree: false,
  rootPath: null,
  count: 1,
};

const otherNote: MindMemory = {
  ...memory("other-note"),
  scope: OTHER,
  path: `/p/${OTHER}/memory/other-note.md`,
};

/** Two memories whose DESCRIPTIONS carry the word a search will look for, and
 *  whose names do not. */
const described: MindMemory[] = [
  { ...memory("first"), description: "Payments provider moved to Acme Pay" },
  { ...memory("second"), description: "Nothing to do with that" },
];

/** How many nodes were drawn with a pulse ring — the second, wider arc a match
 *  gets at the same centre as its node. The node's own radius is constant
 *  across frames, so a centre that was painted at more than one radius is a
 *  centre that pulsed. */
function pulsedNodes(): number {
  const radiiAt = new Map<string, Set<number>>();
  for (const circle of painted.circles) {
    const key = `${Math.round(circle.x)},${Math.round(circle.y)}`;
    const seen = radiiAt.get(key) ?? new Set<number>();
    seen.add(Math.round(circle.r));
    radiiAt.set(key, seen);
  }
  return [...radiiAt.values()].filter((radii) => radii.size > 1).length;
}

/** The pane the graph actually gets, and deliberately not a generous one: the
 *  window is at least 1024×720, RocMind's surface is the dock panel, and the
 *  graph gives two fifths of that to the memory it opens. This is that case —
 *  smallest window, a memory open — rather than the 790 px the graph has when
 *  nothing is open on a default window. */
const PANE = { width: 460, height: 560 };

/** What the drawing code did, in the order it did it. jsdom has no 2D context
 *  at all, and a component that threw inside a frame callback would take the
 *  view with it — so this is both a stub and the only way to ask what was
 *  painted. `measureText` is the real thing's shape at roughly the width of
 *  the 11 px UI font. */
interface PaintedLabel {
  text: string;
  x: number;
  y: number;
  width: number;
}

interface Painted {
  circles: { x: number; y: number; r: number }[];
  /** Every label ever painted, flat — for the questions that are about one
   *  label at a time ("did any of them run off the edge?"). */
  labels: PaintedLabel[];
  /** …and the same labels grouped by the FRAME that painted them.
   *
   *  Not bookkeeping: it is the difference between a real assertion and a flaky
   *  one. This layout animates — every frame moves the nodes and re-decides
   *  which names still fit — so two labels from different frames are the same
   *  picture at two different moments, and asking whether they overlap means
   *  nothing. The collision test used to walk the flat list and did exactly
   *  that; how many frames had accumulated by the time it looked depended on
   *  how long `waitFor` took to notice the first one, which is machine load. It
   *  failed about one run in seven, and only under the full suite, where
   *  everything is slower and more frames land. Measured on a failing run:
   *  eight frames, twenty-six labels, ZERO overlaps within any frame and fifty
   *  across them.
   *
   *  `clearRect` is what opens a frame — `draw` calls it once, before it paints
   *  anything — so it is what buckets these. */
  frames: PaintedLabel[][];
}

const painted: Painted = { circles: [], labels: [], frames: [] };

/** The labels of each frame that painted at least one. */
const framesWithLabels = (): PaintedLabel[][] =>
  painted.frames.filter((frame) => frame.length > 0);

function fakeContext() {
  const measure = (text: string) => text.length * 6.2;
  return {
    setTransform: vi.fn(),
    // One per `draw`, before anything is painted — so it is the frame marker.
    clearRect: vi.fn(() => painted.frames.push([])),
    beginPath: vi.fn(),
    arc: vi.fn((x: number, y: number, r: number) =>
      painted.circles.push({ x, y, r }),
    ),
    fill: vi.fn(),
    stroke: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    measureText: vi.fn((text: string) => ({ width: measure(text) })),
    fillText: vi.fn((text: string, x: number, y: number) => {
      const label = { text, x, y, width: measure(text) };
      painted.labels.push(label);
      painted.frames[painted.frames.length - 1]?.push(label);
    }),
    globalAlpha: 1,
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    font: "",
    textAlign: "",
    textBaseline: "",
  };
}

const contextRequests: string[] = [];
const originalGetContext = HTMLCanvasElement.prototype.getContext;

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "mind_scopes") return [storefront];
    if (cmd === "mind_list") return corpus;
    if (cmd === "mind_read") return "body";
    return null;
  });
  contextRequests.length = 0;
  painted.circles.length = 0;
  painted.labels.length = 0;
  painted.frames.length = 0;
  resetRocMindModuleState();
  resetLayoutCache();

  // A canvas with a size, since jsdom lays nothing out.
  for (const [property, value] of [
    ["clientWidth", PANE.width],
    ["clientHeight", PANE.height],
  ] as const) {
    Object.defineProperty(HTMLCanvasElement.prototype, property, {
      configurable: true,
      get: () => value,
    });
  }
  HTMLCanvasElement.prototype.getBoundingClientRect = () =>
    ({ left: 0, top: 0, ...PANE }) as DOMRect;
  HTMLCanvasElement.prototype.getContext = ((kind: string) => {
    contextRequests.push(kind);
    return kind === "2d" ? fakeContext() : null;
  }) as typeof HTMLCanvasElement.prototype.getContext;
});

afterEach(() => {
  HTMLCanvasElement.prototype.getContext = originalGetContext;
});

describe("the graph", () => {
  it("only ever asks for a 2D context", async () => {
    // The hard rule. WebKit gives a process a small number of WebGL contexts,
    // the terminals already spend that budget, and one more would evict a
    // pane's renderer — a user's terminal going blank because they looked at
    // their memories.
    render(
      <MindGraph
        memories={corpus}
        scopes={[SCOPE]}
        selectedPath={null}
        query=""
        matchedPaths={new Set()}
        onSelect={() => {}}
      />,
    );
    await waitFor(() => expect(contextRequests.length).toBeGreaterThan(0));
    expect(new Set(contextRequests)).toEqual(new Set(["2d"]));
  });

  it("describes the structure it is drawing", () => {
    render(
      <MindGraph
        memories={corpus}
        scopes={[SCOPE]}
        selectedPath={null}
        query=""
        matchedPaths={new Set()}
        onSelect={() => {}}
      />,
    );
    expect(
      screen.getByRole("img", { name: "2 memories, 1 link" }),
    ).toBeInTheDocument();
  });

  it("asks for a project rather than drawing nothing", () => {
    render(
      <MindGraph
        memories={[]}
        scopes={[]}
        selectedPath={null}
        query=""
        matchedPaths={new Set()}
        onSelect={() => {}}
      />,
    );
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByText(/Nothing to draw yet/)).toBeInTheDocument();
  });

  it("selects the memory under a click", async () => {
    const onSelect = vi.fn();
    render(
      <MindGraph
        memories={corpus}
        scopes={[SCOPE]}
        selectedPath={null}
        query=""
        matchedPaths={new Set()}
        onSelect={onSelect}
      />,
    );
    const canvas = screen.getByRole("img");
    await waitFor(() => expect(contextRequests.length).toBeGreaterThan(0));

    // Where the nodes land is the simulation's business, so the click sweeps
    // rather than assuming a coordinate — what is being tested is that hit
    // testing uses the positions actually painted.
    for (
      let x = 10;
      x < PANE.width && onSelect.mock.calls.length === 0;
      x += 8
    ) {
      for (
        let y = 10;
        y < PANE.height && onSelect.mock.calls.length === 0;
        y += 8
      ) {
        fireEvent.click(canvas, { clientX: x, clientY: y });
      }
    }
    expect(onSelect).toHaveBeenCalled();
    expect(corpus.map((m) => m.path)).toContain(onSelect.mock.calls[0]![0]);
  });

  it("does not schedule frames while the tree tab is showing", async () => {
    // "No loop when the tab is not visible" is achieved by not mounting it:
    // there is no canvas, so there is nothing to schedule.
    render(<MindView />);
    await screen.findByRole("tab", { name: /Graph/ });
    expect(screen.queryByRole("img")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /Graph/ }));
    await waitFor(() => expect(screen.getByRole("img")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("tab", { name: /Tree/ }));
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("keeps the tree as the tab you land on", async () => {
    render(<MindView />);
    const tree = await screen.findByRole("tab", { name: /Tree/ });
    expect(tree).toHaveAttribute("aria-selected", "true");
    expect(useRocMindStore.getState().panel).toBe("tree");
  });

  // A node click makes that memory's scope the active one, and EVERY writer of
  // `activeScope` is non-null (a folder click, a graph node, `openMemory`), so
  // the graph narrowed to one project and stayed there: no control anywhere put
  // the corpus back. **All projects** looked like that control and was not — it
  // was read only on the search paths, so pressing it flipped its own fill and
  // its `aria-pressed` and left the picture identical.
  it("widens back to the whole corpus when All projects is pressed", async () => {
    invoke.mockImplementation(async (cmd: string, args?: { scope: string }) => {
      if (cmd === "mind_scopes") return [storefront, elsewhere];
      if (cmd === "mind_list")
        return args?.scope === OTHER ? [otherNote] : corpus;
      if (cmd === "mind_read") return "body";
      return null;
    });
    render(<MindView />);
    fireEvent.click(await screen.findByRole("tab", { name: /Graph/ }));
    // With nothing scoped the graph draws everything it has read.
    await waitFor(() =>
      expect(screen.getByRole("img", { name: /3 memories/ })).toBeTruthy(),
    );

    // A node click is what narrows it — done through the store here, because
    // where a node lands is the simulation's business.
    act(() => useRocMindStore.getState().setActiveScope(SCOPE));
    await waitFor(() =>
      expect(screen.getByRole("img", { name: /2 memories/ })).toBeTruthy(),
    );

    fireEvent.click(screen.getByRole("button", { name: "All projects" }));

    await waitFor(() =>
      expect(screen.getByRole("img", { name: /3 memories/ })).toBeTruthy(),
    );
  });

  // The canvas matched `node.name` and nothing else, while `lib/mindSearch` —
  // which the tree's result list is built from — matches name, description AND
  // body. A query that listed rows on one tab pulsed nothing on the other,
  // while the header went on paying for every body the ranking needed.
  it("pulses what the search found, not only what the names contain", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "mind_scopes") return [storefront];
      if (cmd === "mind_list") return described;
      if (cmd === "mind_read") return "body";
      return null;
    });
    render(<MindView />);
    fireEvent.click(await screen.findByRole("tab", { name: /Graph/ }));
    await waitFor(() => expect(painted.circles.length).toBeGreaterThan(0));

    // Matches `acme` in one memory's DESCRIPTION and in neither name.
    painted.circles.length = 0;
    fireEvent.change(screen.getByPlaceholderText("Search memories"), {
      target: { value: "acme" },
    });

    await waitFor(() => expect(pulsedNodes()).toBe(1));
  });

  it("gets the whole surface rather than the 288px tree rail", async () => {
    // The exit criterion is a graph somebody can read, and 62 memories with a
    // hundred edges in an 18 rem strip is not one. The tabs live in the header
    // now, so the graph takes the tree's rail AND the pane beside it.
    render(<MindView />);
    fireEvent.click(await screen.findByRole("tab", { name: /Graph/ }));
    const canvas = await screen.findByRole("img");
    const surface = canvas.parentElement!.parentElement!;
    expect(surface.className).not.toContain("w-72");
    // …and the memory pane is not on screen until something is selected.
    expect(screen.queryByText("Pick a memory")).not.toBeInTheDocument();
  });
});

describe("legibility at the pane the app gives it", () => {
  /** A corpus the size of the real one, with hubs, a tail and some islands. */
  const many = Array.from({ length: 62 }, (_, i) =>
    memory(
      `memory-with-a-realistic-name-${i}`,
      i % 3 === 0 ? [`memory-with-a-realistic-name-${(i * 7) % 5}`] : [],
    ),
  );

  const drawn = async () => {
    render(
      <MindGraph
        memories={many}
        scopes={[SCOPE]}
        selectedPath={null}
        query=""
        matchedPaths={new Set()}
        onSelect={() => {}}
      />,
    );
    await waitFor(() => expect(painted.circles.length).toBeGreaterThan(0));
  };

  it("keeps every label inside the canvas", async () => {
    // They used to run off both edges: centred text on a node a few pixels
    // from the side of the rail.
    await drawn();
    expect(painted.labels.length).toBeGreaterThan(0);
    for (const label of painted.labels) {
      expect(label.x - label.width / 2).toBeGreaterThanOrEqual(0);
      expect(label.x + label.width / 2).toBeLessThanOrEqual(PANE.width);
    }
  });

  // Per FRAME, not over every label this component has ever painted — see
  // `Painted.frames` for why that distinction is the whole test. The layout is
  // still moving while this runs, so the flat list holds several pictures at
  // once; asked of it, this assertion was really asking whether two names that
  // were never on screen together happened to occupy the same coordinates, and
  // the answer depended on how many frames had landed. Asked per frame it is
  // the question it was always meant to be — and a stricter one, because it now
  // holds for EVERY frame rather than for one arbitrary union of them.
  it("draws no label on top of another, in every frame", async () => {
    await drawn();
    const frames = framesWithLabels();
    expect(frames.length).toBeGreaterThan(0);

    for (const labels of frames) {
      for (let i = 0; i < labels.length; i += 1) {
        for (let j = i + 1; j < labels.length; j += 1) {
          const a = labels[i]!;
          const b = labels[j]!;
          const apart =
            Math.abs(a.x - b.x) > (a.width + b.width) / 2 ||
            Math.abs(a.y - b.y) > 12;
          // The placement drops a label rather than stacking it, so any two
          // that survive are clear of each other in one axis or the other.
          // Named rather than counted: a bare `false` says nothing about which
          // two names landed on each other.
          expect(apart ? "clear" : `${a.text} lands on ${b.text}`).toBe(
            "clear",
          );
        }
      }
    }
  });

  it("names the hubs even before anything is hovered", async () => {
    // A graph of sixty unlabelled dots says nothing until you touch it.
    await drawn();
    expect(painted.labels.length).toBeGreaterThanOrEqual(3);
    for (const label of painted.labels) {
      expect(label.text.length).toBeGreaterThan(0);
    }
  });

  it("draws every node inside the canvas, none on top of another", async () => {
    await drawn();
    // The pulse ring is drawn at a larger radius than the node; only the node
    // circles matter here, and they are the ones at or under `MAX_RADIUS`.
    const circles = painted.circles.filter((c) => c.r <= 13);
    for (const circle of circles) {
      expect(circle.x - circle.r).toBeGreaterThanOrEqual(0);
      expect(circle.x + circle.r).toBeLessThanOrEqual(PANE.width);
      expect(circle.y - circle.r).toBeGreaterThanOrEqual(0);
      expect(circle.y + circle.r).toBeLessThanOrEqual(PANE.height);
    }
  });
});
