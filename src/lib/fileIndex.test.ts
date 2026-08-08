/** The walk behind ⌘P: what it enters, what it refuses to, and what it keeps
 *  between openings. */

import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import {
  INDEX_TTL_MS,
  MAX_INDEXED_FILES,
  MAX_INDEX_DEPTH,
  READ_CONCURRENCY,
  buildFileIndex,
  cachedFileIndex,
  refreshFileIndex,
  resetFileIndexes,
} from "@/lib/fileIndex";
import type { DirEntryDto } from "@/lib/bindings";

const ROOT = "/code/rocspace";

const dir = (path: string): DirEntryDto => ({
  name: path.slice(path.lastIndexOf("/") + 1),
  path,
  isDir: true,
  size: 0,
  hidden: false,
});
const file = (path: string): DirEntryDto => ({
  name: path.slice(path.lastIndexOf("/") + 1),
  path,
  isDir: false,
  size: 1,
  hidden: false,
});

/** A fake project: a map of directory → what `fs_read_dir` answers for it. */
function project(tree: Record<string, DirEntryDto[]>): void {
  invoke.mockImplementation(async (cmd: string, args: unknown) => {
    if (cmd !== "fs_read_dir") throw new Error(`unexpected command ${cmd}`);
    const { path } = args as { path: string };
    const entries = tree[path];
    if (!entries) throw new Error(`not a directory: ${path}`);
    return entries;
  });
}

beforeEach(() => {
  invoke.mockReset();
  resetFileIndexes();
});

describe("buildFileIndex", () => {
  it("walks the project and records paths relative to the root", async () => {
    project({
      [ROOT]: [dir(`${ROOT}/src`), file(`${ROOT}/README.md`)],
      [`${ROOT}/src`]: [file(`${ROOT}/src/App.tsx`)],
    });

    const { files } = await buildFileIndex(ROOT);

    expect(files.map((f) => f.rel)).toEqual(["README.md", "src/App.tsx"]);
    expect(files[1]).toMatchObject({
      path: `${ROOT}/src/App.tsx`,
      name: "App.tsx",
    });
  });

  it("keeps the paths relative when the root is reached through a symlink", async () => {
    // What every macOS project looks like from one angle or another: the
    // workspace remembers the spelling the user picked, and `fs_read_dir`
    // answers with the canonicalized one — /tmp is /private/tmp, an
    // iCloud-synced ~/Documents is somewhere under ~/Library, an external
    // volume is /System/Volumes/Data/…. The two share no prefix, so every row
    // used to render (and be scored on) its whole absolute path.
    const stored = "/tmp/proj";
    const real = "/private/tmp/proj";
    invoke.mockImplementation(async (_cmd: string, args: unknown) => {
      const { path } = args as { path: string };
      if (path === stored || path === real) {
        return [dir(`${real}/src`), file(`${real}/README.md`)];
      }
      if (path === `${real}/src`) return [file(`${real}/src/App.tsx`)];
      throw new Error(`not a directory: ${path}`);
    });

    const { files } = await buildFileIndex(stored);

    expect(files.map((f) => f.rel)).toEqual(["README.md", "src/App.tsx"]);
    // The absolute path is still the canonical one — it is what `openFile`
    // opens and what the sandbox will resolve anyway.
    expect(files[1]?.path).toBe(`${real}/src/App.tsx`);
  });

  it("is breadth-first, so the shallowest files come first", async () => {
    project({
      [ROOT]: [dir(`${ROOT}/src`), file(`${ROOT}/a.md`)],
      [`${ROOT}/src`]: [dir(`${ROOT}/src/deep`), file(`${ROOT}/src/b.ts`)],
      [`${ROOT}/src/deep`]: [file(`${ROOT}/src/deep/c.ts`)],
    });

    const { files } = await buildFileIndex(ROOT);

    // Which matters with nothing typed: the list is the top of the project
    // rather than whichever branch the walk happened to descend first.
    expect(files.map((f) => f.rel)).toEqual([
      "a.md",
      "src/b.ts",
      "src/deep/c.ts",
    ]);
  });

  it("does not enter the four machine-written directories", async () => {
    project({
      [ROOT]: [
        dir(`${ROOT}/.git`),
        dir(`${ROOT}/node_modules`),
        dir(`${ROOT}/target`),
        dir(`${ROOT}/dist`),
        file(`${ROOT}/a.ts`),
      ],
      // Present, and never asked for: entering them is the difference between
      // a second and a minute on a real repository.
      [`${ROOT}/.git`]: [file(`${ROOT}/.git/HEAD`)],
      [`${ROOT}/node_modules`]: [file(`${ROOT}/node_modules/x.js`)],
      [`${ROOT}/target`]: [file(`${ROOT}/target/x.o`)],
      [`${ROOT}/dist`]: [file(`${ROOT}/dist/x.js`)],
    });

    const { files } = await buildFileIndex(ROOT);

    expect(files.map((f) => f.rel)).toEqual(["a.ts"]);
    const asked = invoke.mock.calls.map((c) => (c[1] as { path: string }).path);
    expect(asked).toEqual([ROOT]);
  });

  it("fails rather than reporting an unreadable ROOT as an empty project", async () => {
    invoke.mockImplementation(async () => {
      throw "read_dir failed: Permission denied";
    });

    // A deleted directory, an unmounted volume and a permission error all
    // reached the finder as `[]`, which it prints as "No files found in this
    // project" — a sentence about the wrong thing.
    await expect(buildFileIndex(ROOT)).rejects.toBe(
      "read_dir failed: Permission denied",
    );
  });

  it("skips a directory it cannot read rather than losing the index", async () => {
    invoke.mockImplementation(async (_cmd: string, args: unknown) => {
      const { path } = args as { path: string };
      if (path === ROOT) return [dir(`${ROOT}/secret`), file(`${ROOT}/a.ts`)];
      throw "read_dir failed: Permission denied";
    });

    const { files } = await buildFileIndex(ROOT);

    expect(files.map((f) => f.rel)).toEqual(["a.ts"]);
  });

  it("stops at the file ceiling, and says that it did", async () => {
    const many = Array.from({ length: MAX_INDEXED_FILES + 50 }, (_, i) =>
      file(`${ROOT}/f${i}.ts`),
    );
    project({ [ROOT]: many });

    const index = await buildFileIndex(ROOT);

    expect(index.files).toHaveLength(MAX_INDEXED_FILES);
    // Silently, the finder answers `Nothing matches “…”` for every file past
    // the cap — which reads as "there is no such file".
    expect(index.truncated).toBe(true);
  });

  it("says so when the depth ceiling is what stopped it", async () => {
    const tree: Record<string, DirEntryDto[]> = {};
    let at = ROOT;
    for (let i = 0; i <= MAX_INDEX_DEPTH + 1; i++) {
      const child = `${at}/d${i}`;
      tree[at] = [file(`${at}/f${i}.ts`), dir(child)];
      at = child;
    }
    tree[at] = [];
    project(tree);

    const index = await buildFileIndex(ROOT);

    expect(index.truncated).toBe(true);
    // Everything down to the ceiling is still in the list — a cap is not a
    // failure, it is a partial answer that has to admit to being one.
    expect(index.files.length).toBe(MAX_INDEX_DEPTH + 1);
  });

  it("is not truncated when the whole project fits", async () => {
    project({
      [ROOT]: [dir(`${ROOT}/src`), file(`${ROOT}/a.ts`)],
      [`${ROOT}/src`]: [file(`${ROOT}/src/b.ts`)],
    });

    expect((await buildFileIndex(ROOT)).truncated).toBe(false);
  });

  it("stops READING at the ceiling too, not just counting", async () => {
    // Thirty directories of eleven thousand files: the cap falls inside the
    // second one. It used to break the innermost loop only, so the walk went
    // on reading the rest of the level — hundreds of round trips whose answers
    // were discarded an entry at a time.
    const dirs = Array.from({ length: 30 }, (_, i) => `${ROOT}/d${i}`);
    const tree: Record<string, DirEntryDto[]> = {
      [ROOT]: dirs.map((d) => dir(d)),
    };
    for (const d of dirs) {
      tree[d] = Array.from({ length: 11_000 }, (_, i) => file(`${d}/f${i}.ts`));
    }
    project(tree);

    const { files } = await buildFileIndex(ROOT);

    expect(files).toHaveLength(MAX_INDEXED_FILES);
    // The root, plus the one batch that was already in flight when the cap
    // fell. Nothing after it was asked for.
    expect(invoke).toHaveBeenCalledTimes(1 + READ_CONCURRENCY);
  });
});

describe("the cache", () => {
  it("is empty until the first walk, and holds what it found", async () => {
    project({ [ROOT]: [file(`${ROOT}/a.ts`)] });
    expect(cachedFileIndex(ROOT)).toBeNull();

    await refreshFileIndex(ROOT);

    expect(cachedFileIndex(ROOT)?.files.map((f) => f.rel)).toEqual(["a.ts"]);
  });

  it("shares one walk between two callers", async () => {
    project({ [ROOT]: [file(`${ROOT}/a.ts`)] });

    // Opening the finder twice in quick succession must not walk twice.
    await Promise.all([refreshFileIndex(ROOT), refreshFileIndex(ROOT)]);

    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("replaces what it holds on the next walk", async () => {
    vi.useFakeTimers();
    try {
      project({ [ROOT]: [file(`${ROOT}/a.ts`)] });
      await refreshFileIndex(ROOT);

      project({ [ROOT]: [file(`${ROOT}/a.ts`), file(`${ROOT}/b.ts`)] });
      // Past the TTL: the project has had time to change, so the finder walks.
      vi.advanceTimersByTime(INDEX_TTL_MS + 1);
      await refreshFileIndex(ROOT);

      expect(cachedFileIndex(ROOT)?.files.map((f) => f.rel)).toEqual([
        "a.ts",
        "b.ts",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("serves what it has rather than re-walking a project it just read", async () => {
    vi.useFakeTimers();
    try {
      project({ [ROOT]: [file(`${ROOT}/a.ts`)] });
      await refreshFileIndex(ROOT);
      invoke.mockClear();

      vi.advanceTimersByTime(INDEX_TTL_MS - 1);
      const again = await refreshFileIndex(ROOT);

      // ⌘P is a reflex — opened, abandoned, opened again. A walk of a large
      // repository on every press is thousands of round trips for a list that
      // cannot have changed.
      expect(invoke).not.toHaveBeenCalled();
      expect(again.files.map((f) => f.rel)).toEqual(["a.ts"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
