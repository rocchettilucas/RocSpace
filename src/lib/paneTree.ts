/** The binary split tree that lays out a profile's terminal panes.
 *
 *  This module is pure and dependency-free on purpose: it is the shared
 *  vocabulary between the profiles store (which owns a tree per profile), the
 *  renderer (`views/RocDock/PaneTree.tsx`, which walks it into nested
 *  `react-resizable-panels` groups), and persistence (which has to tolerate
 *  whatever an older or hand-edited snapshot holds).
 *
 *  Every function is persistent — it returns a new tree and structurally shares
 *  the branches it did not touch. Nothing here mutates its argument, so callers
 *  can hand it frozen state (immer drafts included, via a `current()` snapshot)
 *  without defensive copying. Functions that find nothing to do return the
 *  *same* tree, which lets callers skip a store write with a `!==` check.
 *
 *  Addressing: a node's `path` is the string of steps taken from the root, `"f"`
 *  for `first` and `"s"` for `second` — so `""` is the root and `"fs"` is the
 *  root's first child's second child. The renderer builds these as it descends
 *  and hands them back to `setRatioAt` on drag end. */

/** `row` = side-by-side (a vertical divider), `column` = stacked. Named for the
 *  flex direction of the split, matching CSS rather than the divider's look. */
export type SplitDirection = "row" | "column";

export type PaneNode =
  | { kind: "leaf"; terminalId: string }
  | {
      kind: "split";
      direction: SplitDirection;
      /** Fraction of the split given to `first`, in [MIN, MAX]. */
      ratio: number;
      first: PaneNode;
      second: PaneNode;
    };

/** A pane may never be dragged smaller than this fraction of its split. Below
 *  ~15% an xterm grid stops holding a usable column count, and a pane dragged
 *  to zero is indistinguishable from a closed one — which it is not, since it
 *  still owns a live PTY. */
export const MIN_PANE_RATIO = 0.15;
export const MAX_PANE_RATIO = 0.85;

const DEFAULT_RATIO = 0.5;

function clampRatio(ratio: number): number {
  return Math.min(MAX_PANE_RATIO, Math.max(MIN_PANE_RATIO, ratio));
}

/** Replace the leaf holding `targetTerminalId` with a split whose `first` is
 *  that leaf and whose `second` is a new leaf for `newTerminalId` — so the new
 *  pane always lands *after* the one it was split from, in `leafIds` order.
 *
 *  Returns the tree unchanged when the target is not present, and when
 *  `newTerminalId` already holds a leaf: one terminal owns exactly one pane.
 *  Two leaves for one id would put two xterms on a single PTY, and the renderer
 *  hosts each terminal's card in one element, so the second pane could only
 *  ever render empty. `buildBalancedTree` and `sanitizePaneTree` enforce the
 *  same rule on the inputs they take. */
export function splitLeaf(
  tree: PaneNode,
  targetTerminalId: string,
  direction: SplitDirection,
  newTerminalId: string,
): PaneNode {
  // Checked once, here, rather than inside the recursion — which would make it
  // a full scan per node.
  if (hasLeaf(tree, newTerminalId)) return tree;
  return splitLeafIn(tree, targetTerminalId, direction, newTerminalId);
}

function splitLeafIn(
  tree: PaneNode,
  targetTerminalId: string,
  direction: SplitDirection,
  newTerminalId: string,
): PaneNode {
  if (tree.kind === "leaf") {
    if (tree.terminalId !== targetTerminalId) return tree;
    return {
      kind: "split",
      direction,
      ratio: DEFAULT_RATIO,
      first: { kind: "leaf", terminalId: targetTerminalId },
      second: { kind: "leaf", terminalId: newTerminalId },
    };
  }

  const first = splitLeafIn(
    tree.first,
    targetTerminalId,
    direction,
    newTerminalId,
  );
  if (first !== tree.first) return { ...tree, first };

  const second = splitLeafIn(
    tree.second,
    targetTerminalId,
    direction,
    newTerminalId,
  );
  if (second !== tree.second) return { ...tree, second };

  return tree;
}

/** Drop a leaf and promote its sibling into the parent's place, which collapses
 *  the now-childless split. Returns `null` when the removed leaf was the last
 *  one (the profile has no panes left), and the tree unchanged when the id is
 *  not present. */
export function removeLeaf(
  tree: PaneNode,
  terminalId: string,
): PaneNode | null {
  if (tree.kind === "leaf") {
    return tree.terminalId === terminalId ? null : tree;
  }

  const first = removeLeaf(tree.first, terminalId);
  if (first === null) return tree.second;
  if (first !== tree.first) return { ...tree, first };

  const second = removeLeaf(tree.second, terminalId);
  if (second === null) return tree.first;
  if (second !== tree.second) return { ...tree, second };

  return tree;
}

/** Terminal ids in render order: depth-first, `first` before `second`. */
export function leafIds(tree: PaneNode): string[] {
  const out: string[] = [];
  const walk = (node: PaneNode) => {
    if (node.kind === "leaf") {
      out.push(node.terminalId);
      return;
    }
    walk(node.first);
    walk(node.second);
  };
  walk(tree);
  return out;
}

export function hasLeaf(tree: PaneNode, terminalId: string): boolean {
  if (tree.kind === "leaf") return tree.terminalId === terminalId;
  return hasLeaf(tree.first, terminalId) || hasLeaf(tree.second, terminalId);
}

/** Lay ids out as an even grid: halve the list at each level and alternate the
 *  split direction, so four panes read as a 2×2 rather than four thin columns.
 *  Used by the launch wizard and by `ensurePaneTree` whenever a stored tree no
 *  longer matches the profile's live sessions.
 *
 *  Duplicates are dropped (first occurrence wins): a tree that names the same
 *  terminal twice would render two xterms bound to one PTY. */
export function buildBalancedTree(
  terminalIds: readonly string[],
): PaneNode | null {
  const unique = [...new Set(terminalIds)];
  if (unique.length === 0) return null;

  const build = (ids: string[], depth: number): PaneNode => {
    if (ids.length === 1) return { kind: "leaf", terminalId: ids[0]! };
    const mid = Math.ceil(ids.length / 2);
    return {
      kind: "split",
      direction: depth % 2 === 0 ? "row" : "column",
      ratio: DEFAULT_RATIO,
      first: build(ids.slice(0, mid), depth + 1),
      second: build(ids.slice(mid), depth + 1),
    };
  };

  return build(unique, 0);
}

/** Set the ratio of the split addressed by `path` (see the module header).
 *  Clamped to [MIN_PANE_RATIO, MAX_PANE_RATIO]. Returns the tree unchanged when
 *  the path does not resolve to a split, or when `ratio` is not a finite
 *  number — a dead path is a stale drag from a tree that has since changed
 *  shape, not something to crash the dock over. */
export function setRatioAt(
  tree: PaneNode,
  path: string,
  ratio: number,
): PaneNode {
  if (!Number.isFinite(ratio)) return tree;

  const apply = (node: PaneNode, index: number): PaneNode => {
    if (node.kind !== "split") return node;
    if (index === path.length) {
      const next = clampRatio(ratio);
      return next === node.ratio ? node : { ...node, ratio: next };
    }
    const step = path[index];
    if (step === "f") {
      const first = apply(node.first, index + 1);
      return first === node.first ? node : { ...node, first };
    }
    if (step === "s") {
      const second = apply(node.second, index + 1);
      return second === node.second ? node : { ...node, second };
    }
    return node;
  };

  return apply(tree, 0);
}

/** Turn an untrusted value (a persisted snapshot, a hand-edited store file)
 *  into a tree or `null`.
 *
 *  Deliberately all-or-nothing: a tree with one bad node cannot be partially
 *  salvaged into something meaningful, and half a layout is worse than the
 *  balanced rebuild `ensurePaneTree` will do from the profile's live sessions.
 *  Out-of-band ratios are the one exception — those are a value problem, not a
 *  shape problem, so they clamp. */
export function sanitizePaneTree(raw: unknown): PaneNode | null {
  const seen = new Set<string>();

  const parse = (value: unknown): PaneNode | null => {
    if (typeof value !== "object" || value === null) return null;
    const node = value as Record<string, unknown>;

    if (node.kind === "leaf") {
      const id = node.terminalId;
      if (typeof id !== "string" || id === "") return null;
      // Two panes bound to one terminal would mount two xterms over one PTY.
      if (seen.has(id)) return null;
      seen.add(id);
      return { kind: "leaf", terminalId: id };
    }

    if (node.kind === "split") {
      if (node.direction !== "row" && node.direction !== "column") return null;
      if (typeof node.ratio !== "number" || !Number.isFinite(node.ratio)) {
        return null;
      }
      const first = parse(node.first);
      if (first === null) return null;
      const second = parse(node.second);
      if (second === null) return null;
      return {
        kind: "split",
        direction: node.direction,
        ratio: clampRatio(node.ratio),
        first,
        second,
      };
    }

    return null;
  };

  return parse(raw);
}
