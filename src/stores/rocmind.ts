/** RocMind's view of the memory directories under `~/.claude/projects`.
 *
 *  A mirror with one writer, and it is not us. Claude Code owns these files;
 *  this store reads them, follows them, and never writes — which makes it much
 *  simpler than the RocPlan store beside it. There is no debounce, no
 *  write-through and no last-writer-wins, because there is no writing.
 *
 *  What it does have is three caches with different lifetimes:
 *
 *  - `scopes` — the projects that have memories. Cheap, read once on the way
 *    in and again when a scope changes.
 *  - `memoriesByScope` — headers only, per scope. Re-read whole when Rust says
 *    that scope moved; a scope is tens of files, so a diff would be more code
 *    than it saves.
 *  - `bodyByPath` — the text of memories somebody actually opened, plus the
 *    ones a search had to read. Never evicted during a session: the whole
 *    corpus is about 200 KB, and re-reading a memory the user is clicking back
 *    and forth between would be a round trip per click.
 *
 *  `selected` is a PATH rather than a memory object, and that is load-bearing:
 *  the live mirror replaces `memoriesByScope[slug]` wholesale whenever an agent
 *  writes, and a held object would go stale the moment the memory being read is
 *  the one that changed. */

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useMemo } from "react";
import { create } from "zustand";
import { devtools } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";
import {
  EVENT_ROCMIND_CHANGED,
  commands,
  type MindChangedEvent,
  type MindMemory,
  type MindScope,
} from "@/lib/bindings";
import { searchMemories, type MindSearchHit } from "@/lib/mindSearch";
import { buildMindTree, nodeOfScope, type MindTreeNode } from "@/lib/mindTree";

/** How many memory bodies are read at once when a search needs them.
 *
 *  One IPC round trip per file, sixty-odd files in the biggest scope. All at
 *  once floods the blocking pool that terminal spawns and git also use; one at
 *  a time takes a visible second. Eight is neither. */
const BODY_READ_CONCURRENCY = 8;

/** The two readings of the corpus: the folder tree, and the link graph. */
export type MindPanel = "tree" | "graph";

export interface RocMindState {
  /** Every project scope with at least one memory, sorted by label. */
  scopes: MindScope[];
  /** Headers per scope slug. A key exists only for a scope that has been read
   *  at least once — which is how the tree tells "empty" from "not looked at
   *  yet". */
  memoriesByScope: Record<string, MindMemory[]>;
  /** Bodies of memories that have been opened or searched, by path. */
  bodyByPath: Record<string, string>;
  /** The open memory's path, or null. Not the memory itself — see the module
   *  docs. */
  selected: string | null;
  /** Which scope the right-hand side is about. Set by opening a memory and by
   *  clicking a folder, so a folder with nothing selected still scopes the
   *  search and (in the graph tab) what is drawn. */
  activeScope: string | null;
  /** Project folders the tree is showing open, by `MindTreeNode.key`.
   *  Persisted with the workspace snapshot — a tree that forgets what you
   *  opened is a tree you re-open every launch. */
  expandedScopes: string[];
  /** Which reading of the corpus the left side is showing.
   *
   *  Ephemeral rather than persisted, unlike the expanded folders: the tree is
   *  the organisation and the graph is the second look, so opening the app on
   *  the graph would be opening it on the footnote. */
  panel: MindPanel;
  /** The search box. */
  query: string;
  /** Search the whole corpus rather than the active scope. Off by default:
   *  you are usually looking for something in the project you are in. */
  searchAllScopes: boolean;
  scopesLoading: boolean;
  /** Scopes whose header list is being read for the first time. */
  loadingScopes: string[];
  /** The open memory's body is being read. */
  bodyLoading: boolean;
  /** Last failure, or null. One field rather than one per scope: nothing here
   *  is edited, so a failure means "we could not read", which is the same
   *  sentence wherever it happened. */
  error: string | null;
}

export interface RocMindActions {
  /** Read the list of scopes. Safe to call again — it is a refresh. */
  loadScopes: () => Promise<void>;
  /** Read one scope's headers. Safe to call again; that is what an external
   *  change does. */
  loadScope: (slug: string) => Promise<void>;
  /** Select a memory and read its body. Also makes its scope the active one,
   *  so search and the graph follow the selection. */
  openMemory: (path: string) => Promise<void>;
  /** Select the memory called `name`, looking in `scope` first and then
   *  anywhere loaded. Returns whether one was found — a link chip that
   *  resolves to nothing should say so rather than silently doing nothing. */
  openMemoryByName: (name: string, scope?: string | null) => boolean;
  /** Clear the selection (not the scope). */
  closeMemory: () => void;
  setPanel: (panel: MindPanel) => void;
  /** Ask the corpus something: put `query` in the box AND read whatever the
   *  ranking will need that has not been read yet.
   *
   *  The contract's `search(q)`. Distinct from `setQuery`, which only moves the
   *  text: a query is not a search until the bodies it ranks over are in
   *  memory, and working out WHICH bodies those are is the store's business —
   *  it is the same set `useMindSearchResults` ranks. */
  search: (query: string) => Promise<void>;
  setQuery: (query: string) => void;
  setSearchAllScopes: (all: boolean) => void;
  setActiveScope: (slug: string | null) => void;
  toggleExpanded: (key: string) => void;
  setExpanded: (keys: string[]) => void;
  /** Read the bodies of every memory in `slugs` that has not been read yet.
   *  What makes search cover bodies; called when a query becomes non-empty. */
  loadBodies: (slugs: string[]) => Promise<void>;
  /** Follow a scope's directory. Reference-counted on this side too, because
   *  the view and the open workspaces both want the same scopes and neither
   *  may hand back the other's watch. */
  watchScope: (slug: string) => Promise<void>;
  unwatchScope: (slug: string) => void;
}

const initialState: RocMindState = {
  scopes: [],
  memoriesByScope: {},
  bodyByPath: {},
  selected: null,
  activeScope: null,
  expandedScopes: [],
  panel: "tree",
  query: "",
  searchAllScopes: false,
  scopesLoading: false,
  loadingScopes: [],
  bodyLoading: false,
  error: null,
};

const message = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

// Watch bookkeeping --------------------------------------------------------

/** Slugs this renderer holds a watch on, with its own reference count.
 *
 *  Rust reference-counts too; this set is what keeps THIS side's calls
 *  balanced. RocMind's view watches every scope it lists, and the live-mirror
 *  hook watches every open workspace's — the same slug from two holders, and
 *  the one that leaves first must not blind the other.
 *
 *  Moved SYNCHRONOUSLY, by both actions, before either goes near IPC. That is
 *  the whole of the fix for a leak that could not be released: incrementing
 *  after `await ensureChangeListener()` left a window in which `unwatchScope`
 *  found no entry, returned early, and dropped the decrement — `mind_watch`
 *  fired, `mind_unwatch` never did, and the Rust watcher polled that directory
 *  every two seconds for the life of the process with no holder left able to
 *  hand it back. */
const watched = new Map<string, number>();

/** Slugs Rust has actually been told to watch. What `watched` WANTS versus
 *  what is true; `reconcile` closes the gap. */
const live = new Set<string>();

/** The tail of each slug's IPC chain. One at a time per slug, so a watch and
 *  an unwatch cannot cross in flight and leave Rust holding the wrong answer. */
const inFlight = new Map<string, Promise<void>>();

/** Tell Rust what `watched` now says about `slug`.
 *
 *  Chained rather than fired: each run re-reads the count when its turn comes,
 *  so the LAST word wins rather than the fastest round trip. When nothing is in
 *  flight the work starts in the caller's own tick — an unwatch with no watch
 *  pending reaches Rust synchronously, which is what a React cleanup expects.
 *
 *  A watch that fails is not recorded as live, so nothing later tries to hand
 *  back a watch that was never taken. */
function reconcile(slug: string): Promise<void> {
  const run = async (): Promise<void> => {
    const wanted = (watched.get(slug) ?? 0) > 0;
    if (wanted === live.has(slug)) return;
    if (!wanted) {
      live.delete(slug);
      try {
        await commands.mindUnwatch(slug);
      } catch {
        /* no IPC, or the watch is already gone */
      }
      return;
    }
    await ensureChangeListener();
    // Registering the listener is an await of its own, and a holder can leave
    // inside it. Asking again here is what keeps a scope that was watched and
    // released in one tick from reaching Rust at all.
    if ((watched.get(slug) ?? 0) === 0) return;
    try {
      await commands.mindWatch(slug);
      live.add(slug);
    } catch (err) {
      // A scope that cannot be followed still reads; it just goes stale until
      // something asks again. Not worth a banner.
      console.warn(`[rocmind] watch failed for ${slug}:`, err);
    }
  };

  const tail = inFlight.get(slug);
  const next: Promise<void> = tail ? tail.then(run, run) : run();
  const settled: Promise<void> = next.finally(() => {
    if (inFlight.get(slug) === settled) inFlight.delete(slug);
  });
  inFlight.set(slug, settled);
  return settled;
}

/** Module-level so a re-render cannot register a second listener, and held as
 *  the promise so two callers in one tick cannot each start one. `null` inside
 *  means there is no IPC to listen to (unit tests, a browser dev server) — the
 *  tree still works, it just stops being live. */
let changeListener: Promise<UnlistenFn | null> | null = null;

function ensureChangeListener(): Promise<UnlistenFn | null> {
  changeListener ??= (async () => {
    try {
      return await listen<MindChangedEvent>(EVENT_ROCMIND_CHANGED, (event) => {
        const { scope } = event.payload;
        // Not ours: a scope this store has never read, or one whose watch has
        // been handed back since (this is the event that crossed it).
        if (!watched.has(scope)) return;
        void applyChange(scope);
      });
    } catch {
      return null;
    }
  })();
  return changeListener;
}

/** Re-read a scope that moved, then say what appeared in it.
 *
 *  The diff is taken HERE rather than by whoever wants it, because this is the
 *  only place that holds both sides: the list as it was and the list as it is.
 *  A subscriber that tried to work it out afterwards would be racing the next
 *  change. */
async function applyChange(scope: string): Promise<void> {
  const store = useRocMindStore;
  const before = store.getState().memoriesByScope[scope];
  await store.getState().loadScope(scope);
  // The count on the folder comes from the scope list, so a memory appearing
  // has to move that too — otherwise the tree opens to reveal 63 memories
  // under a folder that says 62. Not awaited: nothing below needs it.
  void store.getState().loadScopes();

  const after = store.getState().memoriesByScope[scope] ?? [];
  // A scope we had never read has no "before" — everything in it is not new,
  // it is just newly known. Announcing sixty memories because a folder was
  // opened for the first time is the opposite of the signal.
  const known = new Set((before ?? []).map((memory) => memory.path));
  const added =
    before === undefined ? [] : after.filter((m) => !known.has(m.path));
  for (const observer of observers) observer({ scope, added });

  // …and the open memory's BODY, when it is one of the files that moved.
  //
  // `loadScope` above re-reads the HEADERS, which is what the title, the
  // description chip and the link rows are drawn from — so those refreshed and
  // the markdown underneath them did not. The body lives in `bodyByPath`, which
  // is a cache with no expiry (`loadBodies` skips a path it already holds) and
  // which only `openMemory` ever writes: an agent rewriting the memory on
  // screen changed everything about it except its text, indefinitely, in a
  // module whose whole promise is live mirroring.
  //
  // Through `openMemory` because that is the store's one "read this memory"
  // path, and it keeps showing the copy it has while the read is out — so this
  // corrects the pane rather than blanking it. After the observers, so a read
  // nobody is waiting on does not delay the toast that says a memory appeared.
  //
  // Only when THIS memory moved, not merely when something in its scope did: a
  // scope is tens of files and an agent usually writes one of them, so the
  // headers are what says which. `updatedAt` and `bytes` are the two fields
  // that track a file's contents, and they come back on every listing.
  const { selected } = store.getState();
  if (selected !== null && changedBody(before, after, selected)) {
    await store.getState().openMemory(selected);
  }
}

/** Did the memory at `path` change in this scope's re-read?
 *
 *  Absent from `after` means it is not this scope's (or it was deleted) —
 *  either way there is nothing to re-read. Absent from `before` means it just
 *  appeared under a path something already had open, which is a re-read worth
 *  taking. */
function changedBody(
  before: MindMemory[] | undefined,
  after: readonly MindMemory[],
  path: string,
): boolean {
  const current = after.find((memory) => memory.path === path);
  if (current === undefined) return false;
  const previous = (before ?? []).find((memory) => memory.path === path);
  if (previous === undefined) return true;
  return (
    previous.updatedAt !== current.updatedAt || previous.bytes !== current.bytes
  );
}

/** What a watched scope's change turned out to be. */
export interface MindChange {
  scope: string;
  /** Memories that were not in the scope before this change. Empty when the
   *  change was an EDIT to one that already existed — which is most of them,
   *  and which is not worth telling anybody about. */
  added: MindMemory[];
}

/** Callbacks run after a watched scope changed and was re-read.
 *
 *  The toast that reports a memory appearing subscribes here rather than being
 *  wired into the store, which has no business knowing what a toast is. */
type MindObserver = (change: MindChange) => void;
const observers = new Set<MindObserver>();

/** Subscribe to "a watched scope changed". Returns an unsubscribe. */
export function onMindScopeChanged(observer: MindObserver): () => void {
  observers.add(observer);
  return () => observers.delete(observer);
}

export const useRocMindStore = create<RocMindState & RocMindActions>()(
  devtools(
    immer((set, get) => ({
      ...initialState,

      loadScopes: async () => {
        // Only the FIRST read is a loading state: the live mirror re-reads this
        // whenever any watched scope moves, and a tree that blanked each time
        // an agent wrote a memory would flicker on exactly the workflow it
        // exists for.
        if (get().scopes.length === 0) {
          set((s) => {
            s.scopesLoading = true;
          });
        }
        try {
          const scopes = await commands.mindScopes();
          set((s) => {
            s.scopes = scopes;
            s.scopesLoading = false;
            s.error = null;
          });
        } catch (err) {
          console.warn("[rocmind] could not list scopes:", err);
          set((s) => {
            s.scopesLoading = false;
            s.error = message(err);
          });
        }
      },

      loadScope: async (slug) => {
        if (!slug) return;
        const first = get().memoriesByScope[slug] === undefined;
        if (first) {
          set((s) => {
            if (!s.loadingScopes.includes(slug)) s.loadingScopes.push(slug);
          });
        }
        try {
          const memories = await commands.mindList(slug);
          set((s) => {
            s.memoriesByScope[slug] = memories;
            s.loadingScopes = s.loadingScopes.filter((it) => it !== slug);
            s.error = null;
          });
        } catch (err) {
          console.warn(`[rocmind] could not read scope ${slug}:`, err);
          set((s) => {
            s.loadingScopes = s.loadingScopes.filter((it) => it !== slug);
            s.error = message(err);
          });
        }
      },

      openMemory: async (path) => {
        if (!path) return;
        const scope = findMemory(get(), path)?.scope ?? null;
        set((s) => {
          s.selected = path;
          if (scope) s.activeScope = scope;
          // A body already read is shown immediately and re-read underneath —
          // clicking back to a memory must not blank the pane.
          s.bodyLoading = s.bodyByPath[path] === undefined;
        });
        try {
          const body = await commands.mindRead(path);
          set((s) => {
            s.bodyByPath[path] = body;
            s.bodyLoading = false;
          });
        } catch (err) {
          console.warn(`[rocmind] could not read ${path}:`, err);
          set((s) => {
            s.bodyLoading = false;
            // Only if this is still the memory on screen: a slow read of one
            // the user has already clicked away from must not put an error over
            // the one they are now looking at.
            if (s.selected === path) s.error = message(err);
          });
        }
      },

      openMemoryByName: (name, scope = null) => {
        const state = get();
        const target = name.trim().toLowerCase();
        const inScope = scope ? (state.memoriesByScope[scope] ?? []) : [];
        const anywhere = Object.values(state.memoriesByScope).flat();
        // The memory's own scope first: names are unique within a scope and
        // only usually unique across them, and a link means the one next door.
        const found =
          inScope.find((m) => m.name.toLowerCase() === target) ??
          anywhere.find((m) => m.name.toLowerCase() === target);
        if (!found) return false;
        void get().openMemory(found.path);
        return true;
      },

      closeMemory: () =>
        set((s) => {
          s.selected = null;
        }),

      setPanel: (panel) =>
        set((s) => {
          s.panel = panel;
        }),

      setQuery: (query) =>
        set((s) => {
          s.query = query;
        }),

      search: async (query) => {
        get().setQuery(query);
        // An empty box is not a search, and reading sixty files because
        // somebody cleared it would be work for nothing.
        if (query.trim() === "") return;
        const state = get();
        const scoped = searchSlugs(
          buildMindTree(state.scopes),
          state.activeScope,
        );
        // Everything loaded when the search is unscoped, or when no folder has
        // been opened yet — the same set the results are ranked over.
        const slugs =
          state.searchAllScopes || scoped.length === 0
            ? Object.keys(state.memoriesByScope)
            : scoped;
        await get().loadBodies(slugs);
      },

      setSearchAllScopes: (all) =>
        set((s) => {
          s.searchAllScopes = all;
        }),

      setActiveScope: (slug) =>
        set((s) => {
          s.activeScope = slug;
        }),

      toggleExpanded: (key) =>
        set((s) => {
          const at = s.expandedScopes.indexOf(key);
          if (at === -1) s.expandedScopes.push(key);
          else s.expandedScopes.splice(at, 1);
        }),

      setExpanded: (keys) =>
        set((s) => {
          s.expandedScopes = [...new Set(keys)];
        }),

      loadBodies: async (slugs) => {
        const state = get();
        const missing = slugs
          .flatMap((slug) => state.memoriesByScope[slug] ?? [])
          .map((memory) => memory.path)
          .filter((path) => state.bodyByPath[path] === undefined);
        if (missing.length === 0) return;

        // Bounded fan-out: `missing` can be the whole corpus, and every one of
        // these is a blocking-pool task that terminal spawn and git share.
        let next = 0;
        const worker = async () => {
          for (;;) {
            const index = next;
            next += 1;
            const path = missing[index];
            if (path === undefined) return;
            try {
              const body = await commands.mindRead(path);
              set((s) => {
                s.bodyByPath[path] = body;
              });
            } catch {
              // A memory that will not read simply cannot contribute a body
              // hit. Not an error banner: the search still works, and the file
              // may have been deleted between the listing and this read.
              set((s) => {
                s.bodyByPath[path] = "";
              });
            }
          }
        };
        await Promise.all(
          Array.from(
            { length: Math.min(BODY_READ_CONCURRENCY, missing.length) },
            worker,
          ),
        );
      },

      watchScope: async (slug) => {
        if (!slug) return;
        // The count first, in this tick: an unwatch landing while the IPC is
        // in flight has to find something to decrement.
        watched.set(slug, (watched.get(slug) ?? 0) + 1);
        await reconcile(slug);
      },

      unwatchScope: (slug) => {
        const held = watched.get(slug);
        if (held === undefined) return;
        if (held > 1) {
          watched.set(slug, held - 1);
          return;
        }
        watched.delete(slug);
        void reconcile(slug);
      },
    })),
    { name: "rocmind" },
  ),
);

/** The memory at `path`, from whichever scope holds it. */
function findMemory(state: RocMindState, path: string): MindMemory | null {
  for (const memories of Object.values(state.memoriesByScope)) {
    const found = memories.find((memory) => memory.path === path);
    if (found) return found;
  }
  return null;
}

// Selectors ----------------------------------------------------------------

const EMPTY_MEMORIES: MindMemory[] = [];

export const useMindScopes = (): MindScope[] =>
  useRocMindStore((s) => s.scopes);

export const useMindMemories = (slug: string | null): MindMemory[] =>
  useRocMindStore((s) =>
    slug ? (s.memoriesByScope[slug] ?? EMPTY_MEMORIES) : EMPTY_MEMORIES,
  );

/** The open memory, resolved through the scope lists so it is always the
 *  freshest copy — including after an agent rewrote the file being read. */
export const useMindSelected = (): MindMemory | null => {
  const selected = useRocMindStore((s) => s.selected);
  const byScope = useRocMindStore((s) => s.memoriesByScope);
  return useMemo(() => {
    if (!selected) return null;
    for (const memories of Object.values(byScope)) {
      const found = memories.find((memory) => memory.path === selected);
      if (found) return found;
    }
    return null;
  }, [selected, byScope]);
};

export const useMindBody = (path: string | null): string | undefined =>
  useRocMindStore((s) => (path ? s.bodyByPath[path] : undefined));

/** Project folders, worktrees nested. Memoized on the scope list, because the
 *  tree is rebuilt on every store write otherwise and zustand compares the
 *  selector's result by identity. */
export const useMindTree = (): MindTreeNode[] => {
  const scopes = useMindScopes();
  return useMemo(() => buildMindTree(scopes), [scopes]);
};

export const useMindActiveScope = (): string | null =>
  useRocMindStore((s) => s.activeScope);

export const useMindQuery = (): string => useRocMindStore((s) => s.query);

export const useMindExpanded = (key: string): boolean =>
  useRocMindStore((s) => s.expandedScopes.includes(key));

/** The current query's hits.
 *
 *  Over the active scope's project — its own memories AND its worktrees',
 *  which is the whole point of unifying them — or over everything when the
 *  user asks for it. */
export const useMindSearchResults = (): MindSearchHit[] => {
  const query = useRocMindStore((s) => s.query);
  const all = useRocMindStore((s) => s.searchAllScopes);
  const activeScope = useRocMindStore((s) => s.activeScope);
  const byScope = useRocMindStore((s) => s.memoriesByScope);
  const bodies = useRocMindStore((s) => s.bodyByPath);
  const tree = useMindTree();

  return useMemo(() => {
    const slugs = all ? Object.keys(byScope) : searchSlugs(tree, activeScope);
    const memories = slugs.flatMap((slug) => byScope[slug] ?? []);
    return searchMemories(memories, bodies, query);
  }, [all, activeScope, byScope, bodies, query, tree]);
};

/** Which scopes a scoped search covers: the active scope's whole project, or
 *  everything loaded when nothing is active. */
function searchSlugs(
  tree: readonly MindTreeNode[],
  activeScope: string | null,
): string[] {
  const node = nodeOfScope(tree, activeScope);
  if (!node) return activeScope ? [activeScope] : [];
  return [node.scope?.slug, ...node.worktrees.map((w) => w.slug)].filter(
    (slug): slug is string => slug !== undefined,
  );
}

/** What the graph draws: the whole loaded corpus when **All projects** is on,
 *  otherwise the active project's scopes unified — its own and its worktrees'.
 *
 *  Unified rather than one scope at a time because the split is Claude Code's
 *  filing, not the user's model: a memory written in `v1.1` links to one
 *  written in the repository, and a graph per scope would draw that edge as a
 *  node with nothing on the other end.
 *
 *  `searchAllScopes` is read here as well as on the search paths, and the name
 *  is the only thing about it that is only about search. Without this the
 *  toggle changed its own fill and its `aria-pressed` and left the picture
 *  identical — while every writer of `activeScope` is non-null (a folder click,
 *  a graph node, `openMemory`), so clicking one node narrowed the graph to that
 *  project permanently with no control anywhere that widened it again. The
 *  toggle is that control. */
export const useMindGraphSource = (): {
  memories: MindMemory[];
  scopes: string[];
} => {
  const all = useRocMindStore((s) => s.searchAllScopes);
  const activeScope = useRocMindStore((s) => s.activeScope);
  const byScope = useRocMindStore((s) => s.memoriesByScope);
  const tree = useMindTree();
  return useMemo(() => {
    // The same rule `useMindSearchResults` follows, so the nodes that pulse and
    // the rows a search lists are drawn from one corpus.
    const slugs = all ? Object.keys(byScope) : searchSlugs(tree, activeScope);
    const used = slugs.length > 0 ? slugs : Object.keys(byScope);
    return {
      scopes: used,
      memories: used.flatMap((slug) => byScope[slug] ?? []),
    };
  }, [all, activeScope, byScope, tree]);
};

/** Memories that link TO `name`, within the scopes of its own project.
 *
 *  Computed rather than stored: the links are already in every header, the
 *  corpus is 67 memories, and an index would be a second thing to keep in step
 *  with a directory somebody else is writing. */
export const useMindBacklinks = (memory: MindMemory | null): MindMemory[] => {
  const byScope = useRocMindStore((s) => s.memoriesByScope);
  const tree = useMindTree();
  return useMemo(() => {
    if (!memory) return EMPTY_MEMORIES;
    const slugs = searchSlugs(tree, memory.scope);
    const target = memory.name.toLowerCase();
    return slugs
      .flatMap((slug) => byScope[slug] ?? [])
      .filter(
        (candidate) =>
          candidate.path !== memory.path &&
          candidate.links.some((link) => link.toLowerCase() === target),
      );
  }, [memory, byScope, tree]);
};

/** Test seam: drop the watches and the listener this module holds at module
 *  level. A suite that left one behind would change what the next observes. */
export function resetRocMindModuleState(): void {
  watched.clear();
  live.clear();
  inFlight.clear();
  observers.clear();
  changeListener = null;
  useRocMindStore.setState({ ...initialState });
}
