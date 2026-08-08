/** The left half: memories, by directory.
 *
 *  One expandable node per PROJECT, its memories inside it, and its git
 *  worktrees as sub-folders underneath. Claude Code files a worktree as its own
 *  top-level scope, so a flat list of what is on disk puts eight entries called
 *  `v1.1`, `v1.2`, `business-strategy` beside the project they all belong to.
 *  Nesting them is the organisation this view exists for; the graph tab is the
 *  secondary read of the same data.
 *
 *  A folder loads its memories the first time it is opened rather than on
 *  mount: listing every scope up front is a directory walk and sixty file reads
 *  per project for rows nobody has asked to see. */

import {
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  GitBranch,
} from "lucide-react";
import { useEffect, useMemo } from "react";
import { cn } from "@/lib/utils";
import { slugsOf, type MindTreeNode } from "@/lib/mindTree";
import { useRocMindStore, useMindTree } from "@/stores";
import type { MindMemory, MindScope } from "@/lib/bindings";

export function MindTree() {
  const tree = useMindTree();
  const expanded = useRocMindStore((s) => s.expandedScopes);
  const scopesLoading = useRocMindStore((s) => s.scopesLoading);

  if (scopesLoading && tree.length === 0) {
    return (
      <p className="px-3 py-2 text-xs text-fg-muted">Looking for memories…</p>
    );
  }

  if (tree.length === 0) {
    return (
      <div className="flex flex-col gap-2 px-3 py-4">
        <p className="text-xs font-medium text-fg-secondary">No memories yet</p>
        <p className="text-xs leading-relaxed text-fg-muted">
          RocMind reads what your agents write to{" "}
          <code className="rounded bg-surface-2 px-1">
            ~/.claude/projects/&lt;project&gt;/memory
          </code>
          . Ask Claude Code to remember something and the project appears here.
        </p>
      </div>
    );
  }

  return (
    <ul className="flex flex-col py-1">
      {tree.map((node) => (
        <ProjectNode
          key={node.key}
          node={node}
          open={expanded.includes(node.key)}
        />
      ))}
    </ul>
  );
}

function ProjectNode({ node, open }: { node: MindTreeNode; open: boolean }) {
  const toggleExpanded = useRocMindStore((s) => s.toggleExpanded);
  const setActiveScope = useRocMindStore((s) => s.setActiveScope);
  const loadScope = useRocMindStore((s) => s.loadScope);
  const watchScope = useRocMindStore((s) => s.watchScope);
  const unwatchScope = useRocMindStore((s) => s.unwatchScope);

  // Opening a folder is what reads it, and what makes it live. Every scope it
  // covers, including the worktrees', because the count on the folder is their
  // sum and the search over "this project" is over all of them.
  //
  // The watch is handed back when the folder closes. Reference-counted on both
  // sides, so a project that is ALSO an open workspace stays followed by the
  // mirror after the folder is shut.
  //
  // Keyed on the SLUGS rather than on `node`: every change to a watched scope
  // re-reads the scope list, which rebuilds the tree, which gives this a fresh
  // node object holding exactly the same slugs. Depending on the object made a
  // memory appearing drop and re-take the watch — and a watch re-taken is a
  // baseline re-seeded, so a second write landing in that window would be
  // absorbed silently instead of announced.
  //
  // The key is JSON rather than a joined string: a separator is a character a
  // slug could one day contain, and the last two attempts at picking one that
  // could not both wrote a raw NUL byte into this file, which made git treat a
  // core view as binary. `sourceBytes.test.ts` now fails the build for it.
  const slugsKey = JSON.stringify(slugsOf(node));
  const covered = useMemo(() => JSON.parse(slugsKey) as string[], [slugsKey]);
  useEffect(() => {
    if (!open) return;
    for (const slug of covered) {
      void loadScope(slug);
      void watchScope(slug);
    }
    return () => {
      for (const slug of covered) unwatchScope(slug);
    };
  }, [open, covered, loadScope, watchScope, unwatchScope]);

  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          toggleExpanded(node.key);
          // Clicking a folder aims the search and the graph at that project,
          // whether it is opening or closing — the question "which project am
          // I in" is answered by the last folder you touched.
          setActiveScope(node.scope?.slug ?? node.worktrees[0]?.slug ?? null);
        }}
        title={node.projectPath}
        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs text-fg-secondary hover:bg-surface-2 hover:text-fg-primary"
      >
        <Chevron open={open} />
        <Folder className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
        <span className="min-w-0 flex-1 truncate font-medium">
          {node.label}
        </span>
        <span className="shrink-0 tabular-nums text-[10px] text-fg-muted">
          {node.totalCount}
        </span>
      </button>

      {open ? (
        <div className="pl-3">
          {node.scope ? <ScopeMemories scope={node.scope} /> : null}
          {node.worktrees.map((worktree) => (
            <WorktreeNode key={worktree.slug} scope={worktree} />
          ))}
        </div>
      ) : null}
    </li>
  );
}

/** A worktree, nested under the repository it was made from.
 *
 *  Its own expander rather than a flat run of rows: a project with eight
 *  worktrees would otherwise open into hundreds of memories, and the reason to
 *  open `Storefront` is usually the project's own. */
function WorktreeNode({ scope }: { scope: MindScope }) {
  const key = `worktree:${scope.slug}`;
  const open = useRocMindStore((s) => s.expandedScopes.includes(key));
  const toggleExpanded = useRocMindStore((s) => s.toggleExpanded);
  const setActiveScope = useRocMindStore((s) => s.setActiveScope);

  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          toggleExpanded(key);
          setActiveScope(scope.slug);
        }}
        title={scope.projectPath}
        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs text-fg-secondary hover:bg-surface-2 hover:text-fg-primary"
      >
        <Chevron open={open} />
        <GitBranch className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
        <span className="min-w-0 flex-1 truncate">{scope.label}</span>
        <span className="shrink-0 tabular-nums text-[10px] text-fg-muted">
          {scope.count}
        </span>
      </button>
      {open ? (
        <div className="pl-3">
          <ScopeMemories scope={scope} />
        </div>
      ) : null}
    </div>
  );
}

function ScopeMemories({ scope }: { scope: MindScope }) {
  const memories = useRocMindStore((s) => s.memoriesByScope[scope.slug]);
  const loading = useRocMindStore((s) => s.loadingScopes.includes(scope.slug));

  if (memories === undefined) {
    return (
      <p className="px-2 py-1 text-[11px] text-fg-muted">
        {loading ? "Reading…" : ""}
      </p>
    );
  }
  if (memories.length === 0) {
    return (
      <p className="px-2 py-1 text-[11px] text-fg-muted">
        Nothing written here yet
      </p>
    );
  }
  return (
    <ul className="flex flex-col">
      {memories.map((memory) => (
        <MemoryRow key={memory.path} memory={memory} />
      ))}
    </ul>
  );
}

function MemoryRow({ memory }: { memory: MindMemory }) {
  const selected = useRocMindStore((s) => s.selected === memory.path);
  const openMemory = useRocMindStore((s) => s.openMemory);
  return (
    <li>
      <button
        type="button"
        aria-current={selected ? "true" : undefined}
        onClick={() => void openMemory(memory.path)}
        title={memory.description || memory.name}
        className={cn(
          "flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs",
          selected
            ? "bg-surface-2 font-medium text-fg-primary"
            : "text-fg-secondary hover:bg-surface-2 hover:text-fg-primary",
        )}
      >
        <FileText className="h-3 w-3 shrink-0 text-fg-muted" />
        <span className="min-w-0 flex-1 truncate">{memory.name}</span>
      </button>
    </li>
  );
}

function Chevron({ open }: { open: boolean }) {
  const Icon = open ? ChevronDown : ChevronRight;
  return <Icon className="h-3 w-3 shrink-0 text-fg-muted" aria-hidden="true" />;
}
