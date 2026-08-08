/** Ordering the file index against what has been typed.
 *
 *  Two scores per file, not one: people type file NAMES. Matching only the
 *  relative path would rank `src/name/other.ts` above `src/other/name.ts` for
 *  "name" purely on where the letters fell, and matching only the name would
 *  make `views/tab` — a perfectly ordinary thing to type — match nothing at
 *  all. So both are scored and the better one wins, with the name given a head
 *  start big enough that a real name match beats a scattered path one. */

import { fuzzyMatch } from "@/lib/fuzzy";
import type { IndexedFile } from "@/lib/fileIndex";

/** How much a basename hit is worth over the same score against the path. */
const NAME_BONUS = 12;

/** Rows the list shows. Long enough that scrolling is worth it, short enough
 *  that an empty query does not render the whole workspace. */
export const MAX_RESULTS = 60;

export interface RankedFile {
  file: IndexedFile;
  score: number;
  /** Indices into `file.rel` that matched, for highlighting. */
  positions: number[];
}

export function rankFiles(
  files: readonly IndexedFile[],
  query: string,
): RankedFile[] {
  const trimmed = query.trim();
  if (trimmed === "") {
    // Nothing typed: the index as it is. It is breadth-first, so this is the
    // top of the project rather than an arbitrary branch of it.
    return files.slice(0, MAX_RESULTS).map((file) => ({
      file,
      score: 0,
      positions: [],
    }));
  }

  const ranked: RankedFile[] = [];
  for (const file of files) {
    const byPath = fuzzyMatch(trimmed, file.rel);
    const byName = fuzzyMatch(trimmed, file.name);
    let best = byPath;
    let offset = 0;
    if (byName && (!byPath || byName.score + NAME_BONUS > byPath.score)) {
      best = { score: byName.score + NAME_BONUS, positions: byName.positions };
      // The name is the tail of the relative path, so its indices shift by the
      // length of the directory part — which is what lets the row highlight
      // either kind of match against one string.
      offset = file.rel.length - file.name.length;
    }
    if (!best) continue;
    ranked.push({
      file,
      score: best.score,
      positions:
        offset === 0 ? best.positions : best.positions.map((p) => p + offset),
    });
  }

  // Score first, then the shorter path — a tie between two files means the one
  // with less around the match is the one that matched more of itself.
  ranked.sort(
    (a, b) => b.score - a.score || a.file.rel.length - b.file.rel.length,
  );
  return ranked.slice(0, MAX_RESULTS);
}
