/** The palette's fuzzy filter.
 *
 *  Subsequence matching, not substring: "swp" has to find "Switch workspace",
 *  because that is how people type into a palette — initials of the words they
 *  remember. A substring filter would answer nothing and send them back to the
 *  menus the palette exists to replace.
 *
 *  The scoring is deliberately small. Three signals carry almost all of the
 *  quality: a match at a WORD BOUNDARY is what the user meant ("np" → "New
 *  pane", not "ope**n** **p**lan"), CONTIGUOUS characters beat scattered ones,
 *  and a match in the title beats one that only landed in a keyword. Everything
 *  past that is tuning nobody can feel. */

import type { CommandAction } from "@/lib/commands/registry";

/** Characters after which the next character starts a new "word". Includes the
 *  ellipsis and the arrows the titles use, so "New workspace…" scores its `w`
 *  as a boundary either side of the punctuation. */
const BOUNDARY = /[\s\-_./\\:›…(]/;

const MATCH = 12;
const BOUNDARY_BONUS = 10;
const CONTIGUOUS_BONUS = 8;
/** Charged per haystack character that had to be skipped, so a match early in a
 *  short title beats the same match buried in a long one. Small: it must break
 *  ties, never outweigh a boundary hit. */
const SKIP_PENALTY = 1;

/** A keyword hit is a real hit, but a title hit is the one the user can see.
 *  Scaled rather than offset so the shape of the score survives. */
const KEYWORD_WEIGHT = 0.45;
const GROUP_WEIGHT = 0.3;

export interface CommandMatch {
  command: CommandAction;
  score: number;
  /** Indices into `command.title` that the query matched, ascending. Empty when
   *  the match came from a keyword or the group name — there is nothing in the
   *  title to underline, and inventing highlights would point at the wrong
   *  letters. */
  titleIndices: number[];
}

/** Greedy left-to-right subsequence scan.
 *
 *  Greedy rather than optimal (no backtracking): the first `e` in "Close pane"
 *  is taken for a query of "ce" even though a later one might score higher.
 *  Optimal alignment is a dynamic program over a list that is re-filtered on
 *  every keystroke, and the difference is invisible on strings this short —
 *  the boundary bonus already pulls the ranking the right way. */
function scoreSubsequence(
  haystack: string,
  needle: string,
): { score: number; indices: number[] } | null {
  if (needle === "") return { score: 0, indices: [] };

  const lower = haystack.toLowerCase();
  const indices: number[] = [];
  let score = 0;
  let at = 0;
  let previousIndex = -2;

  for (const char of needle) {
    const found = lower.indexOf(char, at);
    if (found === -1) return null;

    score += MATCH;
    const before = found === 0 ? "" : haystack[found - 1]!;
    if (found === 0 || BOUNDARY.test(before)) score += BOUNDARY_BONUS;
    if (found === previousIndex + 1) score += CONTIGUOUS_BONUS;
    score -= SKIP_PENALTY * (found - at);

    indices.push(found);
    previousIndex = found;
    at = found + 1;
  }

  return { score, indices };
}

/** Best score this command can claim for `needle`, and where in the title it
 *  came from. `null` when nothing matched at all. */
function matchCommand(
  command: CommandAction,
  needle: string,
): CommandMatch | null {
  const title = scoreSubsequence(command.title, needle);
  if (title) {
    return { command, score: title.score, titleIndices: title.indices };
  }

  // Keywords are matched one at a time rather than as a joined string: joining
  // lets a query straddle two unrelated words ("git" matching "…**g**rid" plus
  // "…**it**"), which is how a fuzzy filter starts answering nonsense.
  let best = -Infinity;
  for (const keyword of command.keywords ?? []) {
    const hit = scoreSubsequence(keyword, needle);
    if (hit && hit.score > best) best = hit.score;
  }
  if (best > -Infinity) {
    return { command, score: best * KEYWORD_WEIGHT, titleIndices: [] };
  }

  // The heading is the last resort — typing "git" should reach the Git group
  // even for an action whose title and keywords say neither.
  const group = scoreSubsequence(command.group, needle);
  if (group) {
    return { command, score: group.score * GROUP_WEIGHT, titleIndices: [] };
  }

  return null;
}

/** Filter and rank. An empty (or whitespace-only) query keeps every command in
 *  the order it was given, which is registration order — the palette groups it
 *  afterwards, so "no query" shows the full menu rather than an arbitrary
 *  ranking of it. */
export function filterCommands(
  commands: readonly CommandAction[],
  query: string,
): CommandMatch[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") {
    return commands.map((command) => ({ command, score: 0, titleIndices: [] }));
  }

  const matches: CommandMatch[] = [];
  for (const command of commands) {
    const match = matchCommand(command, needle);
    if (match) matches.push(match);
  }
  // Stable sort (guaranteed since ES2019), so equal scores keep registration
  // order rather than shuffling between keystrokes.
  return matches.sort((a, b) => b.score - a.score);
}

/** Split `text` into runs, flagging the ones the query matched. For rendering
 *  the highlight — the palette maps this to `<mark>`-ish spans. Indices are
 *  assumed ascending and in range, which is what `filterCommands` produces. */
export function highlightRuns(
  text: string,
  indices: readonly number[],
): { text: string; hit: boolean }[] {
  if (indices.length === 0) return [{ text, hit: false }];

  const runs: { text: string; hit: boolean }[] = [];
  let at = 0;
  for (let i = 0; i < indices.length;) {
    const start = indices[i]!;
    if (start > at) runs.push({ text: text.slice(at, start), hit: false });
    // Absorb the contiguous run so "New" is one <span>, not three.
    let end = start + 1;
    i += 1;
    while (i < indices.length && indices[i] === end) {
      end += 1;
      i += 1;
    }
    runs.push({ text: text.slice(start, end), hit: true });
    at = end;
  }
  if (at < text.length) runs.push({ text: text.slice(at), hit: false });
  return runs;
}
