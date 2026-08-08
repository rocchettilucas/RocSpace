/** Worktrees nested under the project they belong to — the organisation the
 *  flat list of scopes on disk does not have. */

import { describe, expect, it } from "vitest";
import { buildMindTree, nodeOfScope, slugsOf } from "@/lib/mindTree";
import type { MindScope } from "@/lib/bindings";

const scope = (over: Partial<MindScope> & { slug: string }): MindScope => ({
  projectPath: "/Users/l/Storefront",
  label: "Storefront",
  isWorktree: false,
  rootPath: null,
  count: 1,
  ...over,
});

const storefront = scope({
  slug: "-Users-l-Storefront",
  projectPath: "/Users/l/Storefront",
  label: "Storefront",
  count: 62,
});

const worktree = (name: string, count = 3): MindScope =>
  scope({
    slug: `-Users-l-Storefront--claude-worktrees-${name.replace(/\./g, "-")}`,
    projectPath: `/Users/l/Storefront/.claude/worktrees/${name}`,
    label: name,
    isWorktree: true,
    rootPath: "/Users/l/Storefront",
    count,
  });

describe("buildMindTree", () => {
  it("nests a worktree under its repository", () => {
    const tree = buildMindTree([storefront, worktree("v1.1")]);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.label).toBe("Storefront");
    expect(tree[0]!.scope?.slug).toBe(storefront.slug);
    expect(tree[0]!.worktrees.map((w) => w.label)).toEqual(["v1.1"]);
  });

  it("counts the project's own memories plus its worktrees'", () => {
    // What the folder shows, because "how much is in here" is the question a
    // count on a closed folder answers.
    const tree = buildMindTree([
      storefront,
      worktree("v1.1", 3),
      worktree("v1.2", 4),
    ]);
    expect(tree[0]!.totalCount).toBe(69);
  });

  it("gives a worktree a project folder even when the repository has none", () => {
    // A memory written inside a worktree and none at the root. Listing `v1.2`
    // at the top level would say nothing about what it belongs to.
    const tree = buildMindTree([worktree("v1.2")]);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.label).toBe("Storefront");
    expect(tree[0]!.scope).toBeNull();
    expect(tree[0]!.worktrees).toHaveLength(1);
    expect(tree[0]!.key).toBe("/Users/l/Storefront");
  });

  it("keys a project on its slug when it has one", () => {
    // The key is what the persisted expansion state remembers, so it must not
    // change when a worktree is the first scope to arrive.
    const tree = buildMindTree([worktree("v1.2"), storefront]);
    expect(tree[0]!.key).toBe(storefront.slug);
  });

  it("keeps unrelated projects apart and sorts them by label", () => {
    const acme = scope({
      slug: "-Users-l-Acme-Site",
      projectPath: "/Users/l/Acme Site",
      label: "Acme Site",
    });
    const home = scope({
      slug: "-Users-l",
      projectPath: "/Users/l",
      label: "l",
      count: 4,
    });
    const tree = buildMindTree([acme, storefront, home]);
    expect(tree.map((n) => n.label)).toEqual(["Acme Site", "l", "Storefront"]);
  });

  it("sorts worktrees by label", () => {
    const tree = buildMindTree([
      storefront,
      worktree("v1.2"),
      worktree("business-strategy"),
      worktree("v1.1"),
    ]);
    expect(tree[0]!.worktrees.map((w) => w.label)).toEqual([
      "business-strategy",
      "v1.1",
      "v1.2",
    ]);
  });

  it("keeps a worktree whose repository could not be worked out", () => {
    // A scope that has to appear somewhere and has no parent to appear under —
    // dropping it would lose memories rather than misplace them.
    const orphan = scope({
      slug: "-somewhere-else",
      projectPath: "/somewhere/else",
      label: "else",
      isWorktree: true,
      rootPath: null,
    });
    const tree = buildMindTree([orphan]);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.scope?.slug).toBe("-somewhere-else");
  });
});

describe("slugsOf / nodeOfScope", () => {
  it("covers the project's own scope and every worktree's", () => {
    const tree = buildMindTree([storefront, worktree("v1.1")]);
    expect(slugsOf(tree[0]!)).toEqual([storefront.slug, worktree("v1.1").slug]);
  });

  it("finds the project a worktree scope belongs to", () => {
    const tree = buildMindTree([storefront, worktree("v1.1")]);
    expect(nodeOfScope(tree, worktree("v1.1").slug)?.label).toBe("Storefront");
    expect(nodeOfScope(tree, null)).toBeNull();
    expect(nodeOfScope(tree, "-not-a-scope")).toBeNull();
  });
});
