/** RocMind's mirror: what it reads, when it re-reads, and what it does about
 *  a directory somebody else is writing. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

/** The `rocmind://changed` handler the store registers, captured so a test can
 *  play the part of Rust noticing an agent's write. */
let emitChange: ((payload: { scope: string }) => void) | null = null;
const unlisten = vi.fn();
/** Held open by the one test that needs to be INSIDE `listen()` when it calls
 *  something else — registering the listener is an await the store used to
 *  move its bookkeeping after. */
let listenGate: Promise<void> | null = null;
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(
    async (_event: string, handler: (e: { payload: unknown }) => void) => {
      if (listenGate) await listenGate;
      emitChange = (payload) => handler({ payload });
      return unlisten;
    },
  ),
}));

import {
  onMindScopeChanged,
  resetRocMindModuleState,
  useRocMindStore,
} from "@/stores/rocmind";
import type { MindMemory, MindScope } from "@/lib/bindings";

const SCOPE = "-Users-l-Storefront";
const WORKTREE = "-Users-l-Storefront--claude-worktrees-v1-1";

const scope = (over: Partial<MindScope> & { slug: string }): MindScope => ({
  projectPath: "/Users/l/Storefront",
  label: "Storefront",
  isWorktree: false,
  rootPath: null,
  count: 1,
  ...over,
});

const memory = (over: Partial<MindMemory> & { name: string }): MindMemory => ({
  scope: SCOPE,
  path: `/home/.claude/projects/${SCOPE}/memory/${over.name}.md`,
  description: "",
  memoryType: "project",
  links: [],
  updatedAt: 1,
  bytes: 10,
  ...over,
});

const store = () => useRocMindStore.getState();

/** The IPC calls of one command, in order. */
const calls = (command: string) =>
  invoke.mock.calls.filter(([cmd]) => cmd === command);

/** Let every queued microtask — including a slug's chained watch/unwatch —
 *  run out before asking what Rust was told. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** A corpus: `mind_scopes` answers with `scopes`, `mind_list` with whatever
 *  `lists` holds for the slug, `mind_read` with `bodies`. */
function mockIpc(options: {
  scopes?: MindScope[];
  lists?: Record<string, MindMemory[]>;
  bodies?: Record<string, string>;
}) {
  invoke.mockImplementation(
    async (cmd: string, args?: Record<string, string>) => {
      if (cmd === "mind_scopes") return options.scopes ?? [];
      if (cmd === "mind_list") return options.lists?.[args?.scope ?? ""] ?? [];
      if (cmd === "mind_read") {
        const body = options.bodies?.[args?.path ?? ""];
        if (body === undefined) throw new Error("no such memory");
        return body;
      }
      return null;
    },
  );
}

beforeEach(() => {
  invoke.mockReset();
  unlisten.mockClear();
  emitChange = null;
  listenGate = null;
  resetRocMindModuleState();
});

afterEach(() => {
  resetRocMindModuleState();
});

describe("loading", () => {
  it("reads the scope list", async () => {
    mockIpc({ scopes: [scope({ slug: SCOPE, count: 62 })] });
    await store().loadScopes();
    expect(store().scopes).toHaveLength(1);
    expect(store().scopes[0]!.count).toBe(62);
    expect(store().scopesLoading).toBe(false);
  });

  it("does not blank the tree while re-reading it", async () => {
    // The live mirror re-reads the scope list every time a watched scope
    // moves. A loading state on that path would flicker the whole tree on
    // exactly the workflow the mirror exists for.
    mockIpc({ scopes: [scope({ slug: SCOPE })] });
    await store().loadScopes();

    let sawLoading = false;
    const stop = useRocMindStore.subscribe((s) => {
      if (s.scopesLoading) sawLoading = true;
    });
    await store().loadScopes();
    stop();
    expect(sawLoading).toBe(false);
  });

  it("keeps working when there is nothing to read", async () => {
    mockIpc({ scopes: [] });
    await store().loadScopes();
    expect(store().scopes).toEqual([]);
    expect(store().error).toBeNull();
  });

  it("reports a read that failed without inventing an empty corpus", async () => {
    invoke.mockRejectedValue(new Error("no home directory"));
    await store().loadScopes();
    expect(store().error).toContain("no home directory");
    expect(store().memoriesByScope).toEqual({});
  });

  it("reads one scope's headers", async () => {
    const a = memory({ name: "payments-provider-migration" });
    mockIpc({ lists: { [SCOPE]: [a] } });
    await store().loadScope(SCOPE);
    expect(store().memoriesByScope[SCOPE]).toEqual([a]);
  });
});

describe("opening a memory", () => {
  it("selects it, reads its body, and makes its scope active", async () => {
    const a = memory({ name: "payments-provider-migration" });
    mockIpc({ lists: { [SCOPE]: [a] }, bodies: { [a.path]: "# body" } });
    await store().loadScope(SCOPE);

    await store().openMemory(a.path);

    expect(store().selected).toBe(a.path);
    expect(store().activeScope).toBe(SCOPE);
    expect(store().bodyByPath[a.path]).toBe("# body");
    expect(store().bodyLoading).toBe(false);
  });

  it("keeps showing a body it already has while re-reading it", async () => {
    // Clicking back to a memory must not blank the pane for a round trip.
    const a = memory({ name: "a" });
    mockIpc({ lists: { [SCOPE]: [a] }, bodies: { [a.path]: "text" } });
    await store().loadScope(SCOPE);
    await store().openMemory(a.path);

    const seen: boolean[] = [];
    const stop = useRocMindStore.subscribe((s) => seen.push(s.bodyLoading));
    await store().openMemory(a.path);
    stop();
    expect(seen).not.toContain(true);
  });

  it("does not put a stale read's failure over the memory now on screen", async () => {
    const good = memory({ name: "good" });
    const bad = memory({ name: "bad" });
    mockIpc({
      lists: { [SCOPE]: [good, bad] },
      bodies: { [good.path]: "fine" },
    });
    await store().loadScope(SCOPE);

    const slow = store().openMemory(bad.path);
    await store().openMemory(good.path);
    await slow;

    expect(store().selected).toBe(good.path);
    expect(store().error).toBeNull();
  });

  it("follows a wikilink by name, preferring the memory's own scope", async () => {
    const here = memory({ name: "shared-name", scope: SCOPE });
    const there = memory({
      name: "shared-name",
      scope: WORKTREE,
      path: `/other/${WORKTREE}/shared-name.md`,
    });
    mockIpc({
      lists: { [SCOPE]: [here], [WORKTREE]: [there] },
      bodies: { [here.path]: "a", [there.path]: "b" },
    });
    await store().loadScope(WORKTREE);
    await store().loadScope(SCOPE);

    expect(store().openMemoryByName("shared-name", WORKTREE)).toBe(true);
    expect(store().selected).toBe(there.path);
  });

  it("reports a link that resolves to nothing rather than doing nothing", async () => {
    mockIpc({ lists: { [SCOPE]: [] } });
    await store().loadScope(SCOPE);
    expect(store().openMemoryByName("not-a-memory", SCOPE)).toBe(false);
    expect(store().selected).toBeNull();
  });
});

describe("bodies for search", () => {
  it("reads every unread body in the given scopes, once", async () => {
    const a = memory({ name: "a" });
    const b = memory({ name: "b" });
    mockIpc({
      lists: { [SCOPE]: [a, b] },
      bodies: { [a.path]: "alpha", [b.path]: "beta" },
    });
    await store().loadScope(SCOPE);

    await store().loadBodies([SCOPE]);
    expect(store().bodyByPath[a.path]).toBe("alpha");
    expect(store().bodyByPath[b.path]).toBe("beta");

    const readsAfter = invoke.mock.calls.filter(
      ([cmd]) => cmd === "mind_read",
    ).length;
    await store().loadBodies([SCOPE]);
    expect(
      invoke.mock.calls.filter(([cmd]) => cmd === "mind_read").length,
    ).toBe(readsAfter);
  });

  it("reads what the ranking needs when the corpus is asked something", async () => {
    // `search(q)` is the contract's action, and it is not `setQuery`: a query
    // is not a search until the bodies it ranks over are in memory. Which
    // bodies those are — the active project's scopes, its worktrees included —
    // is the store's answer, not the header's.
    const own = memory({ name: "own" });
    const inWorktree = memory({
      name: "in-worktree",
      scope: WORKTREE,
      path: `/p/${WORKTREE}/memory/in-worktree.md`,
    });
    const elsewhere = memory({
      name: "elsewhere",
      scope: "-other-Project",
      path: "/p/-other-Project/memory/elsewhere.md",
    });
    mockIpc({
      scopes: [
        scope({ slug: SCOPE }),
        scope({
          slug: WORKTREE,
          label: "v1.1",
          isWorktree: true,
          projectPath: "/Users/l/Storefront/.claude/worktrees/v1.1",
          rootPath: "/Users/l/Storefront",
        }),
        scope({
          slug: "-other-Project",
          label: "Other",
          projectPath: "/Users/l/Other",
        }),
      ],
      lists: {
        [SCOPE]: [own],
        [WORKTREE]: [inWorktree],
        "-other-Project": [elsewhere],
      },
      bodies: {
        [own.path]: "one",
        [inWorktree.path]: "two",
        [elsewhere.path]: "three",
      },
    });
    await store().loadScopes();
    for (const slug of [SCOPE, WORKTREE, "-other-Project"]) {
      await store().loadScope(slug);
    }
    store().setActiveScope(SCOPE);

    await store().search("thing");

    expect(store().query).toBe("thing");
    expect(store().bodyByPath[own.path]).toBe("one");
    expect(store().bodyByPath[inWorktree.path]).toBe("two");
    // Another project is not what was asked about.
    expect(store().bodyByPath[elsewhere.path]).toBeUndefined();

    // …until it is.
    store().setSearchAllScopes(true);
    await store().search("thing");
    expect(store().bodyByPath[elsewhere.path]).toBe("three");
  });

  it("does not read sixty files because the box was cleared", async () => {
    const a = memory({ name: "a" });
    mockIpc({ lists: { [SCOPE]: [a] }, bodies: { [a.path]: "alpha" } });
    await store().loadScope(SCOPE);
    store().setActiveScope(SCOPE);

    await store().search("   ");
    expect(store().query).toBe("   ");
    expect(calls("mind_read")).toHaveLength(0);
  });

  it("does not let one unreadable memory stop the rest", async () => {
    const good = memory({ name: "good" });
    const gone = memory({ name: "gone" });
    mockIpc({
      lists: { [SCOPE]: [good, gone] },
      bodies: { [good.path]: "here" },
    });
    await store().loadScope(SCOPE);

    await store().loadBodies([SCOPE]);
    expect(store().bodyByPath[good.path]).toBe("here");
    // Recorded as empty rather than left missing, so it is not read again on
    // every keystroke.
    expect(store().bodyByPath[gone.path]).toBe("");
  });
});

describe("watching", () => {
  it("takes one Rust watch however many holders ask", async () => {
    mockIpc({});
    await store().watchScope(SCOPE);
    await store().watchScope(SCOPE);
    expect(
      invoke.mock.calls.filter(([cmd]) => cmd === "mind_watch"),
    ).toHaveLength(1);

    // The first holder leaving must not blind the second.
    store().unwatchScope(SCOPE);
    expect(
      invoke.mock.calls.filter(([cmd]) => cmd === "mind_unwatch"),
    ).toHaveLength(0);

    store().unwatchScope(SCOPE);
    expect(
      invoke.mock.calls.filter(([cmd]) => cmd === "mind_unwatch"),
    ).toHaveLength(1);
  });

  it("re-reads the scope and the counts when Rust says it moved", async () => {
    const a = memory({ name: "a" });
    const b = memory({ name: "b" });
    mockIpc({
      scopes: [scope({ slug: SCOPE, count: 1 })],
      lists: { [SCOPE]: [a] },
    });
    await store().loadScopes();
    await store().loadScope(SCOPE);
    await store().watchScope(SCOPE);

    // An agent writes a memory.
    mockIpc({
      scopes: [scope({ slug: SCOPE, count: 2 })],
      lists: { [SCOPE]: [a, b] },
    });
    emitChange?.({ scope: SCOPE });
    await vi.waitFor(() => {
      expect(store().memoriesByScope[SCOPE]).toHaveLength(2);
    });
    // The folder's count comes from the scope list, so it has to move too —
    // otherwise the tree opens to reveal two rows under a folder saying one.
    expect(store().scopes[0]!.count).toBe(2);
  });

  it("ignores a change to a scope nobody is watching", async () => {
    mockIpc({ lists: { [SCOPE]: [] } });
    await store().loadScope(SCOPE);
    await store().watchScope(SCOPE);
    invoke.mockClear();

    emitChange?.({ scope: "-some-other-project" });
    await Promise.resolve();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("tells its observers which scope changed, and what appeared in it", async () => {
    const a = memory({ name: "a" });
    const b = memory({ name: "b" });
    mockIpc({ lists: { [SCOPE]: [a] } });
    await store().loadScope(SCOPE);
    await store().watchScope(SCOPE);

    const seen: { scope: string; added: string[] }[] = [];
    const stop = onMindScopeChanged(({ scope, added }) =>
      seen.push({ scope, added: added.map((m) => m.name) }),
    );

    mockIpc({ lists: { [SCOPE]: [a, b] } });
    emitChange?.({ scope: SCOPE });
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toEqual({ scope: SCOPE, added: ["b"] });

    stop();
    emitChange?.({ scope: SCOPE });
    await Promise.resolve();
    expect(seen).toHaveLength(1);
  });

  it("calls an edit an edit, not an arrival", async () => {
    // An agent updating a memory it already wrote is the common case, and a
    // toast for every one of those is noise about nothing new.
    const a = memory({ name: "a", bytes: 10 });
    mockIpc({ lists: { [SCOPE]: [a] } });
    await store().loadScope(SCOPE);
    await store().watchScope(SCOPE);

    const seen: string[][] = [];
    const stop = onMindScopeChanged(({ added }) =>
      seen.push(added.map((m) => m.name)),
    );
    mockIpc({ lists: { [SCOPE]: [{ ...a, bytes: 99, updatedAt: 2 }] } });
    emitChange?.({ scope: SCOPE });
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toEqual([]);
    stop();
  });

  it("does not call a scope's first reading an arrival", async () => {
    // Sixty memories appearing because a folder was opened for the first time
    // is the opposite of a signal.
    mockIpc({ lists: { [SCOPE]: [memory({ name: "a" })] } });
    await store().watchScope(SCOPE);
    const seen: string[][] = [];
    const stop = onMindScopeChanged(({ added }) =>
      seen.push(added.map((m) => m.name)),
    );

    emitChange?.({ scope: SCOPE });
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toEqual([]);
    stop();
  });

  // The module's whole promise is live mirroring, and this was the half that
  // was not: `applyChange` re-read the HEADERS, so the title and the
  // description chip of the memory on screen updated while the markdown under
  // them stayed as it was — indefinitely, because `bodyByPath` has no expiry,
  // `loadBodies` skips a path it already holds, and only `openMemory` ever
  // re-issues a `mind_read`. The Refresh button did not fix it either; it calls
  // `loadScopes`.
  it("re-reads the open memory's body when its file moves", async () => {
    const a = memory({ name: "a" });
    mockIpc({ lists: { [SCOPE]: [a] }, bodies: { [a.path]: "before" } });
    await store().loadScope(SCOPE);
    await store().watchScope(SCOPE);
    await store().openMemory(a.path);
    expect(store().bodyByPath[a.path]).toBe("before");

    // An agent rewrites it while the user is reading it.
    mockIpc({
      lists: { [SCOPE]: [{ ...a, updatedAt: 2 }] },
      bodies: { [a.path]: "after" },
    });
    emitChange?.({ scope: SCOPE });

    await vi.waitFor(() => expect(store().bodyByPath[a.path]).toBe("after"));
    // Still the memory the user had open — a refresh, not a re-selection.
    expect(store().selected).toBe(a.path);
  });

  it("leaves a body alone when the change was to a different memory", async () => {
    const a = memory({ name: "a" });
    const b = memory({ name: "b" });
    mockIpc({
      lists: { [SCOPE]: [a, b] },
      bodies: { [a.path]: "a body", [b.path]: "b body" },
    });
    await store().loadScope(SCOPE);
    await store().watchScope(SCOPE);
    await store().openMemory(a.path);
    invoke.mockClear();

    // `b` changed; `a` is the one on screen and has nothing to re-read.
    emitChange?.({ scope: SCOPE });

    await vi.waitFor(() => expect(calls("mind_list")).toHaveLength(1));
    await settle();
    expect(calls("mind_read")).toHaveLength(0);
  });

  it("survives a scope that cannot be watched", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "mind_watch") throw new Error("no such scope");
      return [];
    });
    await expect(store().watchScope(SCOPE)).resolves.toBeUndefined();
    expect(store().error).toBeNull();
  });

  it("does not hand back a watch that was never taken", async () => {
    // A failed `mind_watch` leaves Rust holding nothing, so the holder
    // leaving must not tell it to release something.
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "mind_watch") throw new Error("no such scope");
      return [];
    });
    await store().watchScope(SCOPE);
    store().unwatchScope(SCOPE);
    await settle();
    expect(calls("mind_unwatch")).toHaveLength(0);
  });

  it("does not leak a watch when the unwatch lands inside the listener await", async () => {
    // THE leak. `watchScope` used to increment its map AFTER
    // `await ensureChangeListener()`, so an unwatch arriving inside that
    // window found no entry, returned early, and dropped the decrement:
    // `mind_watch` fired, `mind_unwatch` never did, and the Rust watcher
    // polled that directory every two seconds for the life of the process
    // with no holder left able to hand it back.
    //
    // The window is real: `useMindMirror` watches a workspace's encoded slug
    // at boot and drops it the moment `loadScopes()` resolves and the scope's
    // true slug turns out to be different.
    mockIpc({});
    let openListen: () => void = () => {};
    listenGate = new Promise<void>((resolve) => {
      openListen = resolve;
    });

    const watching = store().watchScope(SCOPE);
    await Promise.resolve();
    // Inside the window, before the listener has resolved.
    store().unwatchScope(SCOPE);
    openListen();
    await watching;
    await settle();

    expect(calls("mind_watch").length - calls("mind_unwatch").length).toBe(0);
  });

  it("keeps the count when an unwatch lands while the watch is in flight", async () => {
    // The leak this rules out: the count used to move AFTER
    // `await ensureChangeListener()`, so an unwatch arriving in that window
    // found no entry, returned early, and dropped the decrement. `mind_watch`
    // fired, `mind_unwatch` never did, and Rust polled that directory every
    // two seconds for the rest of the session with nobody able to release it.
    let releaseWatch: () => void = () => {};
    const watchInFlight = new Promise<void>((resolve) => {
      releaseWatch = resolve;
    });
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "mind_watch") await watchInFlight;
      return [];
    });

    const watching = store().watchScope(SCOPE);
    // Let the listener registration resolve, so the watch really is in flight.
    await vi.waitFor(() => expect(calls("mind_watch")).toHaveLength(1));

    // The cleanup that used to be swallowed.
    store().unwatchScope(SCOPE);
    releaseWatch();
    await watching;
    await settle();

    expect(calls("mind_unwatch")).toHaveLength(1);
    // And the ledger is balanced, so a later holder can take it again.
    await store().watchScope(SCOPE);
    expect(calls("mind_watch")).toHaveLength(2);
  });

  it("says nothing to Rust when a watch is taken and dropped in one tick", async () => {
    // The other half of the same window: the effect that watches a phantom
    // slug and unwatches it on the next render must not leave a watch behind
    // — and must not release one it never took either.
    mockIpc({});
    const watching = store().watchScope(SCOPE);
    store().unwatchScope(SCOPE);
    await watching;
    await settle();

    expect(calls("mind_watch")).toHaveLength(0);
    expect(calls("mind_unwatch")).toHaveLength(0);
  });

  it("holds one Rust watch across a re-take that crosses the release", async () => {
    // Two holders churning: the mirror hands its watch back in the same tick
    // the tree takes one. The calls must still balance out at one watch.
    mockIpc({});
    await store().watchScope(SCOPE);
    expect(calls("mind_watch")).toHaveLength(1);

    store().unwatchScope(SCOPE);
    const retaken = store().watchScope(SCOPE);
    await retaken;
    await settle();

    // Whatever order the two round trips resolved in, Rust ends up watching
    // it exactly once more than it was told to stop.
    expect(calls("mind_watch").length - calls("mind_unwatch").length).toBe(1);
  });
});

describe("expansion", () => {
  it("toggles a folder and de-dupes what is restored from disk", () => {
    store().toggleExpanded(SCOPE);
    expect(store().expandedScopes).toEqual([SCOPE]);
    store().toggleExpanded(SCOPE);
    expect(store().expandedScopes).toEqual([]);

    store().setExpanded([SCOPE, SCOPE, WORKTREE]);
    expect(store().expandedScopes).toEqual([SCOPE, WORKTREE]);
  });
});
