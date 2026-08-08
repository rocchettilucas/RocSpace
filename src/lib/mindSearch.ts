/** Finding a memory among sixty-seven.
 *
 *  The corpus was built for this: every memory carries a `description` that is
 *  a one-line summary written to be ranked against. So a title hit beats a
 *  description hit beats a body hit, and that is not a heuristic — it is the
 *  format's own intent, and matching it is why searching this corpus feels
 *  like it knows what you meant.
 *
 *  Ties break by recency. Two memories that match a query equally well are
 *  almost always the same subject twice, and the newer one is the one that is
 *  still true — the corpus has `release-1-1-android-build9` next to
 *  `release-1-2-branch`, and "release" should land on the second.
 *
 *  Bodies are optional. A search runs the moment the user types, against the
 *  headers that are already in memory, and gets better when the bodies arrive
 *  (see `loadBodies` in the store) — rather than showing nothing until sixty
 *  files have been read. */

import type { MindMemory } from "@/lib/bindings";

/** Which field a memory matched on — the strongest one, over all terms. Shown
 *  in the result row so a body hit does not look like an unexplained result. */
export type MindHitField = "name" | "description" | "body";

export interface MindSearchHit {
  memory: MindMemory;
  score: number;
  field: MindHitField;
}

/** What each field is worth per matched term. */
const FIELD_SCORE: Record<MindHitField, number> = {
  name: 3,
  description: 2,
  body: 1,
};

/** Bonus for a name that STARTS with the whole query — typing `payments` should
 *  put `payments-provider-migration` first even though a dozen memories mention
 *  Payments somewhere. */
const PREFIX_BONUS = 4;

/** …and for a name that is exactly it. */
const EXACT_BONUS = 8;

/** Split a query into the terms every result has to satisfy.
 *
 *  Every term, not any: typing more words narrows, which is what a person
 *  typing a second word means. */
export function searchTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term !== "");
}

/** Rank `memories` against `query`.
 *
 *  `bodies` maps a memory's path to its text; a path that is missing simply
 *  cannot contribute a body hit. An empty query returns nothing — the caller
 *  shows the tree, not every memory in a list. */
export function searchMemories(
  memories: readonly MindMemory[],
  bodies: Readonly<Record<string, string>>,
  query: string,
): MindSearchHit[] {
  const terms = searchTerms(query);
  if (terms.length === 0) return [];
  const whole = terms.join(" ");

  const hits: MindSearchHit[] = [];
  for (const memory of memories) {
    const name = memory.name.toLowerCase();
    const description = memory.description.toLowerCase();
    const body = (bodies[memory.path] ?? "").toLowerCase();

    let score = 0;
    let field: MindHitField | null = null;
    let matchedAll = true;
    for (const term of terms) {
      const where: MindHitField | null = name.includes(term)
        ? "name"
        : description.includes(term)
          ? "description"
          : body.includes(term)
            ? "body"
            : null;
      if (where === null) {
        matchedAll = false;
        break;
      }
      score += FIELD_SCORE[where];
      if (field === null || FIELD_SCORE[where] > FIELD_SCORE[field]) {
        field = where;
      }
    }
    if (!matchedAll || field === null) continue;

    if (name === whole) score += EXACT_BONUS;
    else if (name.startsWith(whole)) score += PREFIX_BONUS;

    hits.push({ memory, score, field });
  }

  hits.sort(
    (a, b) =>
      b.score - a.score ||
      b.memory.updatedAt - a.memory.updatedAt ||
      a.memory.name.localeCompare(b.memory.name),
  );
  return hits;
}
