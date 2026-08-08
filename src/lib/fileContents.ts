/** What the editor has read off disk, and what it believes is there now.
 *
 *  A module-level cache rather than per-component state, for two reasons that
 *  only became one reason once the editor could write:
 *
 *   1. Switching tabs must not re-read a file that is already open.
 *   2. Every open editor has to agree on what the file says. A save updates the
 *      baseline, a reload replaces it, and a component holding its own copy
 *      would go on showing the version from before.
 *
 *  The cached `content` is the BASELINE — the bytes this app last saw on disk,
 *  which is what "dirty" is measured against (`useEditorStore.dirtyByPath`) and
 *  what an external-change check compares to. It is deliberately not the
 *  buffer: the buffer is unsaved work and lives in the store, so that losing
 *  this cache costs a re-read and never costs an edit.
 *
 *  Subscription rather than a bare Map because the writes now come from places
 *  no render is below: a ⌘S from a collapsed panel, a reload on window focus.
 *  `useSyncExternalStore` over `fileContentsSnapshot` is what makes those reach
 *  the screen.
 */

import { commands, type FileContentsDto } from "@/lib/bindings";

export interface FileContentsState {
  status: "idle" | "loading" | "ready" | "error";
  data: FileContentsDto | null;
  error: string | null;
}

const IDLE: FileContentsState = { status: "idle", data: null, error: null };
const LOADING: FileContentsState = {
  status: "loading",
  data: null,
  error: null,
};

/** Baselines, by absolute path. */
const contents = new Map<string, FileContentsDto>();
/** Why a read failed, by absolute path. Mutually exclusive with `contents`. */
const failures = new Map<string, string>();
/** Disk content that arrived while the buffer was dirty, waiting on the user's
 *  answer. Not a baseline until they give one — see `EditorPrompts`. */
const external = new Map<string, FileContentsDto>();
/** One read per path at a time. Two mounted editors asking for the same file
 *  (or a focus check landing on a load) must not become two IPC calls. */
const inFlight = new Map<string, Promise<void>>();

/** Frozen `FileContentsState` objects, one per path, rebuilt only when that
 *  path changes. `useSyncExternalStore` requires an unchanged snapshot to be
 *  referentially equal — building one per call would re-render forever. */
const snapshots = new Map<string, FileContentsState>();
const listeners = new Set<() => void>();

/** Invalidate `path`'s snapshot (or every one) and wake the subscribers. */
function announce(path?: string): void {
  if (path === undefined) snapshots.clear();
  else snapshots.delete(path);
  for (const listener of [...listeners]) listener();
}

export function subscribeFileContents(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function fileContentsSnapshot(path: string | null): FileContentsState {
  if (path === null) return IDLE;
  const existing = snapshots.get(path);
  if (existing) return existing;
  const data = contents.get(path);
  const error = failures.get(path);
  const fresh: FileContentsState = data
    ? { status: "ready", data, error: null }
    : error !== undefined
      ? { status: "error", data: null, error }
      : LOADING;
  snapshots.set(path, fresh);
  return fresh;
}

/** The baseline for `path`, or null if nothing has been read. */
export function cachedFile(path: string): FileContentsDto | null {
  return contents.get(path) ?? null;
}

/** Adopt `dto` as the baseline for `path`. Clears any recorded failure — a file
 *  that just read is not a file that failed to.
 *
 *  Keyed on the path the CALLER asked about rather than on `dto.path`: Rust
 *  answers with the canonicalized spelling, and an entry filed under a name
 *  nothing looks up is a permanent spinner. */
export function putFile(path: string, dto: FileContentsDto): void {
  contents.set(path, dto);
  failures.delete(path);
  announce(path);
}

/** Forget everything about `path` so the next open re-reads it. Called when a
 *  tab closes: a file left open in the cache for the rest of the session would
 *  come back stale, and now that other things write to disk, stale is wrong
 *  rather than merely old. */
export function forgetFile(path: string): void {
  // Every delete runs. Chaining them with `||` would short-circuit on the first
  // hit and leave a stashed external change behind a closed tab, where nothing
  // would ever ask about it again and the next open would inherit it.
  const dropped = [
    contents.delete(path),
    failures.delete(path),
    external.delete(path),
  ].some(Boolean);
  inFlight.delete(path);
  if (dropped) announce(path);
}

const byteLength = (text: string): number =>
  new TextEncoder().encode(text).length;

/** Move the baseline to `text` after a successful write, so the file does not
 *  read as changed-behind-our-back the moment we changed it ourselves. A path
 *  with no cached entry is a no-op: there is no baseline to move. */
export function markSaved(path: string, text: string): void {
  const current = contents.get(path);
  if (!current) return;
  contents.set(path, { ...current, content: text, size: byteLength(text) });
  announce(path);
}

/** Read `path` into the cache unless it is already there or already reading. */
export function loadFile(projectRoot: string, path: string): Promise<void> {
  if (contents.has(path)) return Promise.resolve();
  const pending = inFlight.get(path);
  if (pending) return pending;
  const run = commands
    .fsReadFile(projectRoot, path)
    .then((dto) => {
      // Key on the requested path, not `dto.path`: Rust returns the
      // canonicalized one, and a tab addressed by any other spelling would
      // cache under a key nothing ever looks up — a permanent spinner.
      contents.set(path, dto);
      failures.delete(path);
      announce(path);
    })
    .catch((err: unknown) => {
      failures.set(path, typeof err === "string" ? err : String(err));
      contents.delete(path);
      announce(path);
    })
    .finally(() => {
      inFlight.delete(path);
    });
  inFlight.set(path, run);
  return run;
}

/** Read `path` from disk ignoring the cache, and WITHOUT adopting the result.
 *  What a difference means is the caller's question — the answer may be a
 *  dialog. */
export function readFromDisk(
  projectRoot: string,
  path: string,
): Promise<FileContentsDto> {
  return commands.fsReadFile(projectRoot, path);
}

/** Hold disk content that disagrees with a dirty buffer until the user says
 *  which one wins. */
export function stashExternal(path: string, dto: FileContentsDto): void {
  external.set(path, dto);
}

export function peekExternal(path: string): FileContentsDto | null {
  return external.get(path) ?? null;
}

export function clearExternal(path: string): void {
  external.delete(path);
}

/** Test seam: drop every cached read, failure and stash. A suite that left one
 *  would serve it to the next. */
export function resetFileContents(): void {
  contents.clear();
  failures.clear();
  external.clear();
  inFlight.clear();
  announce();
}
