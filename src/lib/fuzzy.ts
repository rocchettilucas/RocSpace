/** Subsequence matching with a score, for the ⌘P file finder.
 *
 *  The rule everyone expects from a quick-open box: the letters you typed have
 *  to appear in order, and matches that land where a human would have started
 *  reading — the beginning of a word, a run of letters together — come first.
 *  `src/App.tsx` for "app", not the `a`…`p`…`p` scattered through
 *  `src/components/RocWidget.tsx`.
 *
 *  Two linear passes rather than an exhaustive search. A best-of-all-alignments
 *  match is the textbook answer and is quadratic; this runs over every path in
 *  the workspace on every keystroke. The first pass finds the earliest
 *  subsequence, which proves the match exists; the second pulls every character
 *  as far right as it will go without passing the one after it, which turns
 *  "the first s, and the first t after it" into "the s immediately before that
 *  t". That second pass is what makes `st` find `stores` in `src/stores/ui.ts`
 *  instead of the `s` of `src` and a `t` nine characters later — the alignment
 *  that matters, without the search that finds all of them. */

export interface FuzzyMatch {
  score: number;
  /** Indices into the target that the query matched, for highlighting. */
  positions: number[];
}

/** Characters after which a new "word" starts, in a path or a filename. */
const BOUNDARY_BEFORE = new Set(["/", "\\", "_", "-", ".", " "]);

function isBoundary(target: string, index: number): boolean {
  if (index === 0) return true;
  const previous = target[index - 1]!;
  if (BOUNDARY_BEFORE.has(previous)) return true;
  // camelCase: the C in RocWidget starts a word too.
  const here = target[index]!;
  return previous === previous.toLowerCase() && here !== here.toLowerCase();
}

/** Match `query` against `target`. Null when the letters are not there in
 *  order; otherwise a score where higher is better and the positions matched.
 *
 *  An empty query matches everything, with no score — the finder shows the
 *  index as it is until something is typed. */
export function fuzzyMatch(query: string, target: string): FuzzyMatch | null {
  if (query === "") return { score: 0, positions: [] };
  if (query.length > target.length) return null;

  const q = query.toLowerCase();
  const t = target.toLowerCase();

  // Pass one: the earliest subsequence there is. If this fails, no alignment
  // exists and there is nothing to score.
  const positions: number[] = [];
  let from = 0;
  for (const needle of q) {
    const at = t.indexOf(needle, from);
    if (at < 0) return null;
    positions.push(at);
    from = at + 1;
  }

  // Pass two: tighten from the right. Each character moves as far right as it
  // can without reaching the one after it, and the loop can never run past its
  // own earliest position — which is a match by construction, so the walk
  // always lands on one.
  for (let i = positions.length - 2; i >= 0; i--) {
    const floor = positions[i]!;
    let at = positions[i + 1]! - 1;
    while (at > floor && t[at] !== q[i]) at--;
    positions[i] = at;
  }

  let score = 0;
  for (let i = 0; i < positions.length; i++) {
    const at = positions[i]!;
    let step = 1;
    // A run of letters together is the strongest signal there is: it is what
    // makes typing the start of a name beat the same letters found one at a
    // time down a long path.
    if (i > 0 && at === positions[i - 1]! + 1) step += 8;
    if (isBoundary(target, at)) step += 6;
    // Same letter, same case — a tiebreak, not a requirement.
    if (target[at] === query[i]) step += 1;
    const gap = i === 0 ? at : at - positions[i - 1]! - 1;
    step -= Math.min(gap, 8) * 0.5;
    score += step;
  }
  if (positions[0] === 0) score += 8;
  // Between two files that match equally well, the shorter name is the one
  // that matched more of itself.
  score -= target.length * 0.05;
  return { score, positions };
}
