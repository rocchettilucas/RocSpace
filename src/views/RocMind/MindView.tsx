/** RocMind — every memory your agents wrote, in one place.
 *
 *  A main-area surface like RocPlan and Roc: it takes the RocDock's place while
 *  the dock stays mounted behind it, so coming here costs no terminal output.
 *  ⌘⇧M and the sidebar's RocMind row are the two ways in.
 *
 *  NOT scoped to the active workspace, which is the difference between this and
 *  the board. The board is a file in one repository; this is the whole corpus,
 *  and half the value of putting it on screen is seeing that the thing you are
 *  looking for was written down while you were working on something else.
 *
 *  Left is the tree, right is the memory. The search box replaces the tree with
 *  ranked results while there is a query in it — the same panel, because
 *  results and folders answer the same question and two panels would make you
 *  choose which one to look at.
 *
 *  The GRAPH is not a third thing in the same 288 px rail. A force layout of
 *  sixty-odd memories in a strip that narrow is a smear whichever way it is
 *  drawn, so the graph takes the whole surface and the memory it opens sits
 *  beside it. Which reading you are in is a tab in the header, above both. */

import { Brain, FolderTree, Network, RefreshCw, Search, X } from "lucide-react";
import { useEffect, useMemo } from "react";
import { cn } from "@/lib/utils";
import { searchMemories, type MindSearchHit } from "@/lib/mindSearch";
import {
  useMindGraphSource,
  useMindQuery,
  useMindScopes,
  useMindSearchResults,
  useMindTree,
  useRocMindStore,
} from "@/stores";
import { MemoryPane } from "@/views/RocMind/MemoryPane";
import { MindGraph } from "@/views/RocMind/MindGraph";
import { MindTree } from "@/views/RocMind/MindTree";

export function MindView() {
  const loadScopes = useRocMindStore((s) => s.loadScopes);
  const panel = useRocMindStore((s) => s.panel);
  const query = useMindQuery();

  // Read the scope list on the way in and on every return. The list is one
  // `read_dir` per project directory, and it is what the counts come from — a
  // view that trusted the copy it had from an hour ago would open on a folder
  // saying 62 next to 63 rows.
  useEffect(() => {
    void loadScopes();
  }, [loadScopes]);

  return (
    <div className="flex h-full w-full flex-col bg-surface-0">
      <MindHeader />
      <div className="flex min-h-0 flex-1">
        {panel === "graph" ? <GraphSurface query={query} /> : null}
        {panel === "tree" ? (
          <>
            <div className="flex w-72 shrink-0 flex-col border-r border-border bg-surface-1">
              <div className="min-h-0 flex-1 overflow-y-auto">
                {query.trim() === "" ? <MindTree /> : <SearchResults />}
              </div>
            </div>
            <div className="min-w-0 flex-1">
              <MemoryPane />
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

/** Tree or graph — a header control, because it now decides what the whole
 *  surface is showing rather than what is in one rail.
 *
 *  The graph is UNMOUNTED while the tree is showing, which is the whole of "no
 *  frames scheduled when the tab is not visible": there is no canvas, so there
 *  is no loop. Its layout survives in `lib/mindGraph`'s cache, so coming back
 *  paints the same picture instantly rather than re-simulating — and the
 *  spatial memory the user built up survives with it. */
function PanelTabs() {
  const panel = useRocMindStore((s) => s.panel);
  const setPanel = useRocMindStore((s) => s.setPanel);
  return (
    <div
      role="tablist"
      aria-label="How to read the memories"
      className="flex shrink-0 gap-1 rounded-md bg-surface-2/60 p-0.5"
    >
      {(
        [
          ["tree", "Tree", FolderTree],
          ["graph", "Graph", Network],
        ] as const
      ).map(([id, label, Icon]) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={panel === id}
          onClick={() => setPanel(id)}
          className={cn(
            "flex items-center gap-1.5 rounded px-2 py-1 text-[11px]",
            panel === id
              ? "bg-surface-1 font-medium text-fg-primary"
              : "text-fg-secondary hover:text-fg-primary",
          )}
        >
          <Icon className="h-3 w-3" aria-hidden="true" />
          {label}
        </button>
      ))}
    </div>
  );
}

/** The graph, at the size a graph needs.
 *
 *  It takes the surface rather than the rail: sixty-odd nodes and a hundred
 *  edges fitted into 288 px is a picture that satisfies "the graph renders"
 *  and nothing else. The memory a node opens sits BESIDE it — three parts
 *  graph to two parts reading — rather than under it, because the layout
 *  settles into a disc and it is width the fit runs out of first. */
function GraphSurface({ query }: { query: string }) {
  const { memories, scopes } = useMindGraphSource();
  const selected = useRocMindStore((s) => s.selected);
  const openMemory = useRocMindStore((s) => s.openMemory);
  const loadScope = useRocMindStore((s) => s.loadScope);
  const allScopes = useMindScopes();
  const activeScope = useRocMindStore((s) => s.activeScope);
  const searchAll = useRocMindStore((s) => s.searchAllScopes);
  const bodies = useRocMindStore((s) => s.bodyByPath);

  /** Which memories the query found, by path.
   *
   *  Through `searchMemories` — the same ranking the tree's result list is
   *  built from — rather than the substring test the canvas used to do on its
   *  own, which looked at the NAME and nothing else. A query that found six
   *  memories by description or body listed six rows on the tree tab and
   *  pulsed none of them here, while the header's effect went on reading every
   *  body the ranking needed and this tab threw the answer away.
   *
   *  Over the memories THIS tab is drawing rather than over
   *  `useMindSearchResults`, which is scoped for the tree: a graph that is
   *  showing the whole corpus has to be able to find something in it. */
  const matchedPaths = useMemo(
    () =>
      new Set(
        searchMemories(memories, bodies, query).map((hit) => hit.memory.path),
      ),
    [memories, bodies, query],
  );

  // The graph takes the tree's place, so "open a folder to see something" is
  // advice about a control that is no longer on screen. With no project chosen
  // — or with **All projects** on, which now widens the graph as well as the
  // search — it draws the whole corpus instead, which means reading the scopes
  // nobody has expanded yet: a listing each, and only on the tab that wants
  // them.
  useEffect(() => {
    if (activeScope && !searchAll) return;
    for (const scope of allScopes) void loadScope(scope.slug);
  }, [activeScope, searchAll, allScopes, loadScope]);

  return (
    <>
      <div className="min-h-0 min-w-0 flex-[3]">
        <MindGraph
          memories={memories}
          scopes={scopes}
          selectedPath={selected}
          query={query}
          matchedPaths={matchedPaths}
          onSelect={(path) => void openMemory(path)}
        />
      </div>
      {selected ? (
        <div className="min-w-0 flex-[2] border-l border-border">
          <MemoryPane />
        </div>
      ) : null}
    </>
  );
}

function MindHeader() {
  const query = useMindQuery();
  const setQuery = useRocMindStore((s) => s.setQuery);
  const searchAll = useRocMindStore((s) => s.searchAllScopes);
  const setSearchAll = useRocMindStore((s) => s.setSearchAllScopes);
  const loadScopes = useRocMindStore((s) => s.loadScopes);
  const search = useRocMindStore((s) => s.search);
  const activeScope = useRocMindStore((s) => s.activeScope);
  const byScope = useRocMindStore((s) => s.memoriesByScope);
  const tree = useMindTree();

  const total = tree.reduce((sum, node) => sum + node.totalCount, 0);

  /** Searching covers bodies, and bodies are not in the header listing — so a
   *  query is what pays for reading them.
   *
   *  Deliberately after the first keystroke rather than on mount: sixty file
   *  reads for a view somebody opened to look at the tree is work nobody asked
   *  for. Results appear immediately from names and descriptions and get
   *  better a moment later; see `searchMemories`.
   *
   *  Here rather than on the input's `onChange` because typing is not the only
   *  thing that changes what a search covers: **All projects**, the folder that
   *  was last clicked, and a scope finishing its listing all do. Which scopes
   *  those are is the store's answer, not this header's — see `search`. */
  useEffect(() => {
    if (query.trim() === "") return;
    void search(query);
  }, [query, searchAll, activeScope, byScope, search]);

  return (
    <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2.5">
      <Brain className="h-4 w-4 shrink-0 text-accent" aria-hidden="true" />
      <div className="flex min-w-0 flex-col">
        <h1 className="text-sm font-semibold text-fg-primary">RocMind</h1>
        <p className="truncate text-[11px] text-fg-muted">
          {total === 0
            ? "Nothing remembered yet"
            : `${total} ${total === 1 ? "memory" : "memories"} across ${tree.length} ${tree.length === 1 ? "project" : "projects"}`}
        </p>
      </div>

      <div className="ml-auto flex items-center gap-2">
        <PanelTabs />
        <label className="relative flex items-center">
          <Search
            className="pointer-events-none absolute left-2 h-3.5 w-3.5 text-fg-muted"
            aria-hidden="true"
          />
          <span className="sr-only">Search memories</span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search memories"
            className="w-56 rounded-md border border-border bg-surface-2 py-1 pl-7 pr-7 text-xs text-fg-primary placeholder:text-fg-muted focus:border-border-active focus:outline-none"
          />
          {query !== "" ? (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="Clear search"
              className="absolute right-1.5 rounded p-0.5 text-fg-muted hover:text-fg-primary"
            >
              <X className="h-3 w-3" />
            </button>
          ) : null}
        </label>

        {/* Not only about search any more: it also chooses what the Graph tab
            draws (`useMindGraphSource`), which is what makes it the way back
            out of a graph narrowed by clicking a node. The title says both,
            because a control that reads as being about the search box is a
            control nobody presses to widen a picture. */}
        <button
          type="button"
          aria-pressed={searchAll}
          onClick={() => setSearchAll(!searchAll)}
          title={
            searchAll
              ? "Showing and searching every project"
              : "Showing and searching the project you last opened"
          }
          className={cn(
            "rounded-md px-2 py-1 text-[11px]",
            searchAll
              ? "bg-accent-soft text-accent"
              : "text-fg-secondary hover:bg-surface-2 hover:text-fg-primary",
          )}
        >
          All projects
        </button>

        <button
          type="button"
          onClick={() => void loadScopes()}
          title="Re-read the memory directories"
          aria-label="Refresh"
          className="rounded-md p-1 text-fg-secondary hover:bg-surface-2 hover:text-fg-primary"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </div>
    </header>
  );
}

function SearchResults() {
  const hits = useMindSearchResults();
  const query = useMindQuery();
  const openMemory = useRocMindStore((s) => s.openMemory);
  const selected = useRocMindStore((s) => s.selected);

  if (hits.length === 0) {
    return (
      <p className="px-3 py-3 text-xs text-fg-muted">
        Nothing matches “{query.trim()}”.
      </p>
    );
  }

  return (
    <ul className="flex flex-col py-1">
      {hits.map((hit: MindSearchHit) => (
        <li key={hit.memory.path}>
          <button
            type="button"
            aria-current={selected === hit.memory.path ? "true" : undefined}
            onClick={() => void openMemory(hit.memory.path)}
            className={cn(
              "flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left",
              selected === hit.memory.path
                ? "bg-surface-2"
                : "hover:bg-surface-2",
            )}
          >
            <span className="flex items-baseline gap-1.5">
              <span className="min-w-0 flex-1 truncate text-xs font-medium text-fg-primary">
                {hit.memory.name}
              </span>
              {/* Which field matched. A body hit with no visible reason reads
                  as a wrong result; naming it makes it a right one. */}
              <span className="shrink-0 text-[10px] uppercase tracking-wide text-fg-muted">
                {hit.field}
              </span>
            </span>
            {hit.memory.description ? (
              <span className="line-clamp-2 text-[11px] leading-snug text-fg-muted">
                {hit.memory.description}
              </span>
            ) : null}
          </button>
        </li>
      ))}
    </ul>
  );
}
