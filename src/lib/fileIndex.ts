/** The list of files ⌘P searches, and how it is kept.
 *
 *  Built by walking `fs_read_dir` from the workspace's project directory —
 *  there is no "list every file" command and there should not be one: the walk
 *  goes through the same sandbox every other read does, and the skips below are
 *  the difference between a second and a minute on a real repository.
 *
 *  Cached per project root and rebuilt when the finder opens. Not watched: a
 *  watcher over a whole tree is a lot of machinery to keep a list fresh that
 *  nobody is looking at, and the moment it matters is the moment the box is
 *  opened. The stale copy is shown immediately and replaced when the walk
 *  lands, so opening ⌘P a second time is instant and still current. */

import { commands, type DirEntryDto } from "@/lib/bindings";

export interface IndexedFile {
  /** Absolute path, as `fs_read_dir` gave it — what `openFile` wants. */
  path: string;
  /** Path relative to the project root. What the user reads and searches. */
  rel: string;
  /** Basename, scored separately: people type file names, not paths. */
  name: string;
}

/** Directories the walk does not enter.
 *
 *  Not a general "is this interesting" judgement — these four are the ones that
 *  are enormous, machine-written, and never what ⌘P is being asked for. `.git`
 *  alone can be tens of thousands of loose objects. */
export const SKIPPED_DIRS: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  "target",
  "dist",
]);

/** Ceilings, so a walk down someone's home directory cannot run forever. Both
 *  are generous for a project and cheap to hit for a mistake. */
export const MAX_INDEXED_FILES = 20_000;
export const MAX_INDEX_DEPTH = 12;

/** Directories read at once. Sequential is a round trip per directory and a
 *  large repo has thousands; unbounded is thousands of IPC calls in flight.
 *  Exported for the test that pins where a capped walk stops. */
export const READ_CONCURRENCY = 8;

/** How long a walked index is served without walking again.
 *
 *  ⌘P is a reflex — opened, abandoned, opened again — and re-walking a large
 *  repository on each press is thousands of IPC round trips for a list that
 *  cannot have changed much. Short enough that a file created in the pane next
 *  door is findable almost immediately, long enough that a burst of openings
 *  costs one walk. */
export const INDEX_TTL_MS = 10_000;

/** What a walk found, and whether it found all of it.
 *
 *  `truncated` exists because the ceilings above are silent by design and
 *  invisible by accident: a project past either of them yields a list with a
 *  hole in it, and the finder's answer for a file in that hole is
 *  `Nothing matches "…"` — which reads as "no such file". The flag is what lets
 *  the footer say otherwise. */
export interface FileIndex {
  files: IndexedFile[];
  truncated: boolean;
}

/** A directory the walk still has to read, and where it sits in the project. */
interface PendingDir {
  /** Absolute path, as `fs_read_dir` gave it. */
  path: string;
  /** Its path relative to the root, "" for the root itself. */
  rel: string;
}

/** Join a parent's relative path with a child's name. Always "/", including on
 *  Windows: this string is read and typed at, not passed to anything that
 *  opens a file — `path` is what does that. */
function joinRel(parent: string, name: string): string {
  return parent === "" ? name : `${parent}/${name}`;
}

/** Walk the project. Breadth-first, so the shallowest files come first and the
 *  list with no query typed is the top of the project rather than whichever
 *  branch the walk happened to descend.
 *
 *  `rel` is ACCUMULATED from the names on the way down rather than recovered by
 *  stripping `root` off the absolute path afterwards. That subtraction only
 *  works when the two spellings agree, and on macOS they routinely do not:
 *  `fs_read_dir` answers with canonicalized paths while the workspace holds
 *  whatever the user picked, so a project under /tmp (really /private/tmp), an
 *  iCloud-synced ~/Documents or anything reached through a symlinked component
 *  failed the prefix test — and every row then showed its whole absolute path
 *  and was ranked on one, with the length penalty falling on characters nobody
 *  typed. Building the answer on the way down cannot disagree with itself.
 *
 *  REJECTS when the root itself cannot be read. A directory somewhere down the
 *  tree is skipped, but the root failing is not a project with no files in it —
 *  it is a project that has been deleted, renamed, unmounted, or that this
 *  process may not open — and every one of those reached the finder as
 *  "No files found in this project.", a sentence about the wrong thing. */
export async function buildFileIndex(root: string): Promise<FileIndex> {
  const files: IndexedFile[] = [];
  let frontier: PendingDir[] = [{ path: root, rel: "" }];

  for (let depth = 0; depth <= MAX_INDEX_DEPTH; depth++) {
    if (frontier.length === 0) break;
    const next: PendingDir[] = [];
    for (let i = 0; i < frontier.length; i += READ_CONCURRENCY) {
      const batch = frontier.slice(i, i + READ_CONCURRENCY);
      const listings = await Promise.all(
        batch.map((dir) =>
          // A directory that cannot be read is skipped, not fatal: a permission
          // error somewhere down the tree must not cost the user the index.
          // The root is the exception — see above.
          commands.fsReadDir(root, dir.path).catch((err: unknown) => {
            if (dir.rel === "") throw err;
            return [] as DirEntryDto[];
          }),
        ),
      );
      for (let b = 0; b < listings.length; b++) {
        const parent = batch[b]!;
        for (const entry of listings[b]!) {
          const rel = joinRel(parent.rel, entry.name);
          if (entry.isDir) {
            if (!SKIPPED_DIRS.has(entry.name)) {
              next.push({ path: entry.path, rel });
            }
            continue;
          }
          files.push({ path: entry.path, rel, name: entry.name });
          // The ceiling ends the WALK, not the loop it was noticed in.
          // Breaking out of the innermost one left the rest of the level to be
          // read — hundreds of `fs_read_dir` calls whose answers were then
          // thrown away one entry at a time, which is exactly the runaway walk
          // the ceiling exists to prevent.
          if (files.length >= MAX_INDEXED_FILES) {
            return { files, truncated: true };
          }
        }
      }
    }
    frontier = next;
  }

  // Directories still queued when the loop ran out of depth are the ones the
  // other ceiling cut off.
  return { files, truncated: frontier.length > 0 };
}

const indexes = new Map<string, FileIndex>();
const walking = new Map<string, Promise<FileIndex>>();
/** When each root's cached index was walked, for `INDEX_TTL_MS`. */
const walkedAt = new Map<string, number>();

/** What the last walk found, or null if this root has never been walked. */
export function cachedFileIndex(root: string): FileIndex | null {
  return indexes.get(root) ?? null;
}

/** The index for `root`, walking it again if what we have is older than
 *  `INDEX_TTL_MS`.
 *
 *  Three ways this answers without a second walk, in order: a walk already in
 *  flight is shared (opening the finder twice quickly must not walk twice), an
 *  index younger than the TTL is served as it is, and only then is the project
 *  read again. The last one is the expensive one — one `fs_read_dir` per
 *  directory — and ⌘P is pressed far more often than a project changes. */
export function refreshFileIndex(root: string): Promise<FileIndex> {
  const inFlight = walking.get(root);
  if (inFlight) return inFlight;

  const cached = indexes.get(root);
  const at = walkedAt.get(root);
  if (cached && at !== undefined && Date.now() - at < INDEX_TTL_MS) {
    return Promise.resolve(cached);
  }

  const run = buildFileIndex(root)
    .then((index) => {
      indexes.set(root, index);
      walkedAt.set(root, Date.now());
      return index;
    })
    .finally(() => {
      walking.delete(root);
    });
  walking.set(root, run);
  return run;
}

/** Test seam: forget every walked index. */
export function resetFileIndexes(): void {
  indexes.clear();
  walking.clear();
  walkedAt.clear();
}
