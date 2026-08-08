/** Scopes, arranged the way a person thinks about them.
 *
 *  Claude Code files memories by SCOPE, and a git worktree is its own scope:
 *  `~/Storefront` and `~/Storefront/.claude/worktrees/v1.1` are two directories that
 *  never see each other's memories. That is the right thing on disk and the
 *  wrong thing on screen — they are one project, and a flat list puts eight
 *  entries called `v1.1`, `v1.2`, `business-strategy` beside the project they
 *  are all worktrees OF.
 *
 *  So the tree nests them: one node per project, its own memories inside it,
 *  its worktrees as sub-folders. Unifying them is the thing RocSpace can do
 *  that Claude Code today does not.
 *
 *  A worktree whose repository has no memories of its own still gets a project
 *  node — a synthesized one, with no scope of its own. Listing it at the top
 *  level instead would put `v1.2` beside `Storefront` and say nothing about the
 *  relationship, which is the flat list again for the one case where it is
 *  least readable. */

import type { MindScope } from "@/lib/bindings";

export interface MindTreeNode {
  /** Identity for React and for expansion state.
   *
   *  The project's own slug where it has one, and its path otherwise — a
   *  synthesized node has no slug, and keying it on the label would collide
   *  between two checkouts of the same project in different directories. */
  key: string;
  label: string;
  projectPath: string;
  /** The scope holding the project's OWN memories, or null when only its
   *  worktrees have any. Null is what the view renders as a folder you can
   *  open but which has nothing directly inside it. */
  scope: MindScope | null;
  /** Worktree scopes belonging to this project, sorted by label. */
  worktrees: MindScope[];
  /** The project's own memories plus every worktree's — what the folder's
   *  count shows, because that is the question "how much is in here". */
  totalCount: number;
}

/** Group scopes into project folders.
 *
 *  Sorted by label, case-insensitively, with the path as the tiebreak so two
 *  projects with the same directory name have a stable order. */
export function buildMindTree(scopes: readonly MindScope[]): MindTreeNode[] {
  const nodes = new Map<string, MindTreeNode>();

  /** Find or create the node for a project path. Created without a scope; the
   *  project's own scope fills it in if there is one, whichever order they
   *  arrive in. */
  const nodeFor = (projectPath: string, label: string): MindTreeNode => {
    const existing = nodes.get(projectPath);
    if (existing) return existing;
    const node: MindTreeNode = {
      key: projectPath,
      label,
      projectPath,
      scope: null,
      worktrees: [],
      totalCount: 0,
    };
    nodes.set(projectPath, node);
    return node;
  };

  for (const scope of scopes) {
    if (scope.isWorktree && scope.rootPath) {
      const node = nodeFor(scope.rootPath, lastSegment(scope.rootPath));
      node.worktrees.push(scope);
      node.totalCount += scope.count;
      continue;
    }
    // Not a worktree — or a worktree whose repository could not be worked out,
    // which is a scope that has to appear somewhere and has no parent to appear
    // under.
    const node = nodeFor(scope.projectPath, scope.label);
    node.scope = scope;
    node.key = scope.slug;
    node.totalCount += scope.count;
  }

  const list = [...nodes.values()];
  for (const node of list) {
    node.worktrees.sort(byLabel);
  }
  list.sort(
    (a, b) =>
      a.label.toLowerCase().localeCompare(b.label.toLowerCase()) ||
      a.projectPath.localeCompare(b.projectPath),
  );
  return list;
}

const byLabel = (a: MindScope, b: MindScope): number =>
  a.label.toLowerCase().localeCompare(b.label.toLowerCase()) ||
  a.slug.localeCompare(b.slug);

function lastSegment(path: string): string {
  const segments = path.split("/").filter((segment) => segment !== "");
  return segments[segments.length - 1] ?? path;
}

/** Every scope slug a tree node covers — the project's own and its worktrees'.
 *
 *  What "open this folder" has to load, and what the graph of a project draws
 *  when it is asked for the unified view. */
export function slugsOf(node: MindTreeNode): string[] {
  const slugs = node.scope ? [node.scope.slug] : [];
  return slugs.concat(node.worktrees.map((scope) => scope.slug));
}

/** A project path as Claude Code spells it in a scope directory name.
 *
 *  Mirrors `encode_path` in `src-tauri/src/rocmind/mod.rs`: every character
 *  that is not a letter or a digit becomes `-`. Verified against the corpus,
 *  which contains all three interesting cases — `/`, `.` (`.claude`, `v1.1`)
 *  and a space (`Acme Site`).
 *
 *  Used in exactly one place, and only where a wrong guess is survivable: a
 *  project that has no memories yet has no scope to look up, and watching the
 *  slug it WOULD have is what makes its first memory appear without a reload.
 *  Every other path asks Rust, which decodes by walking the filesystem. */
export function encodeScopeSlug(projectPath: string): string {
  return projectPath.replace(/[^A-Za-z0-9]/g, "-");
}

/** Every scope slug that belongs to a project directory.
 *
 *  Three sources, because "the memories of the project I have open" is three
 *  questions: the project's own scope, the scopes of its worktrees (which
 *  Claude Code files separately and which an agent working in one writes to),
 *  and — when the project has no scope at all yet — the slug its first memory
 *  will land under.
 *
 *  A workspace opened directly ON a worktree is covered by the first case: its
 *  path matches that worktree scope's own `projectPath`. */
export function scopeSlugsForProject(
  scopes: readonly MindScope[],
  projectPath: string,
): string[] {
  if (!projectPath) return [];
  const trimmed = projectPath.replace(/\/+$/, "");
  const slugs = new Set<string>();
  let own = false;
  for (const scope of scopes) {
    if (scope.projectPath === trimmed) {
      slugs.add(scope.slug);
      own = true;
    } else if (scope.isWorktree && scope.rootPath === trimmed) {
      slugs.add(scope.slug);
    }
  }
  if (!own) slugs.add(encodeScopeSlug(trimmed));
  return [...slugs];
}

/** The tree node a scope belongs to, or null. */
export function nodeOfScope(
  tree: readonly MindTreeNode[],
  slug: string | null,
): MindTreeNode | null {
  if (!slug) return null;
  return tree.find((node) => slugsOf(node).includes(slug)) ?? null;
}
