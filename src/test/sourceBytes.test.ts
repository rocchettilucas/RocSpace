/** Source has to stay text.
 *
 *  A raw NUL byte (0x00) written where the escape `\0` was meant makes git
 *  classify the file as BINARY: `git diff`, `git show` and `git blame` stop
 *  producing line content, three-way merge refuses the path, and `grep` cannot
 *  see inside it. It has happened twice in this repository — most recently to
 *  `MindTree.tsx`, a core view — and both times it survived typecheck, lint and
 *  the whole suite, because a NUL inside a string literal is valid TypeScript.
 *
 *  So the build asks the question no other gate does. The files are read
 *  through Vite's `?raw` rather than through `node:fs` because the project has
 *  no `@types/node` and a guard is not worth a dependency. */

import { describe, expect, it } from "vitest";
import nulFixture from "@/test/fixtures/nul-byte.txt?raw";

/** Everything a person writes by hand and expects to be able to diff: the
 *  renderer and the Rust crate. Assets (`.png`, `.woff2`) are binary on
 *  purpose and say nothing about whether anyone can review them. */
const RENDERER = import.meta.glob("/src/**/*.{ts,tsx,js,jsx,css,html,json}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const RUST = import.meta.glob("/src-tauri/src/**/*.rs", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** Files allowed to hold NUL bytes, and how many. Empty, and it should stay
 *  that way.
 *
 *  It was not empty when this guard was written: `RocStage.tsx` and
 *  `MindTree.tsx` had each been written with a literal `\0` where the escape
 *  was meant, on two different branches, by two different authors, weeks apart
 *  — which is what earned the whole file. A NUL makes git treat the source as
 *  binary: unreviewable in a diff, unmergeable by three-way merge, invisible to
 *  grep. Both are fixed, so there is nothing left to exempt.
 *
 *  A ceiling rather than an equality, so a fix never has to land in the same
 *  commit as its exemption's deletion. */
const KNOWN: Record<string, number> = {};

/** How many NUL bytes a file's text holds. */
function countNuls(text: string): number {
  let count = 0;
  const NUL = "\u0000";
  for (let at = text.indexOf(NUL); at !== -1; at = text.indexOf(NUL, at + 1)) {
    count += 1;
  }
  return count;
}

describe("the source tree", () => {
  it("contains no NUL bytes, so git can diff and merge every file", () => {
    const offenders: string[] = [];
    for (const [path, text] of Object.entries({ ...RENDERER, ...RUST })) {
      const count = countNuls(text);
      // Named rather than counted: the fix is per file, and a literal NUL is
      // invisible in every editor that would render this message.
      if (count > (KNOWN[path] ?? 0)) {
        offenders.push(`${path} (${count} NUL bytes)`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("is looking at the files it claims to be looking at", () => {
    // The failure this rules out is the glob quietly matching nothing — a
    // guard that passes because it read zero files is not a guard.
    expect(Object.keys(RENDERER).length).toBeGreaterThan(50);
    expect(Object.keys(RUST).length).toBeGreaterThan(10);
    expect(RENDERER["/src/views/RocMind/MindTree.tsx"]).toContain(
      "ProjectNode",
    );
  });

  it("can see a NUL byte at all", () => {
    // The guard's own guard. If `?raw` ever stopped handing back the file's
    // real bytes, every assertion above would pass on nothing — so a fixture
    // that IS one NUL byte proves the mechanism before it proves the tree.
    expect(countNuls(nulFixture)).toBe(1);
    expect(countNuls("no nul here")).toBe(0);
  });
});
