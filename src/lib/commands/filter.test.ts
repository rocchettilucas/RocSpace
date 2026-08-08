/** What the palette's filter is for: finding a command from the initials
 *  somebody remembers, and ranking the obvious answer first. */

import { describe, expect, it } from "vitest";
import { filterCommands, highlightRuns } from "@/lib/commands/filter";
import type { CommandAction } from "@/lib/commands/registry";

const command = (
  id: string,
  title: string,
  extra: Partial<CommandAction> = {},
): CommandAction => ({
  id,
  title,
  group: "Workspace",
  run: () => {},
  ...extra,
});

const rank = (commands: CommandAction[], query: string) =>
  filterCommands(commands, query).map((m) => m.command.id);

describe("filterCommands", () => {
  it("keeps everything, in the given order, for an empty query", () => {
    const list = [command("b", "Beta"), command("a", "Alpha")];
    expect(rank(list, "")).toEqual(["b", "a"]);
    expect(rank(list, "   ")).toEqual(["b", "a"]);
  });

  // The whole reason it is not a substring filter: nobody types
  // "new workspace", they type "nw".
  it("matches initials as a subsequence", () => {
    const list = [command("nw", "New workspace…"), command("sr", "Show Roc")];
    expect(rank(list, "nw")).toEqual(["nw"]);
    expect(rank(list, "sr")).toEqual(["sr"]);
  });

  it("is case-insensitive both ways", () => {
    const list = [command("nw", "New workspace…")];
    expect(rank(list, "NW")).toEqual(["nw"]);
    expect(rank(list, "New Work")).toEqual(["nw"]);
  });

  it("drops what does not match at all", () => {
    const list = [command("nw", "New workspace…")];
    expect(rank(list, "zzz")).toEqual([]);
  });

  it("ranks word-boundary hits above letters buried mid-word", () => {
    const list = [
      command("buried", "Open plan"),
      command("boundary", "New pane"),
    ];
    // "np": word starts in "New pane"; inside "Ope**n** **p**lan" it is not.
    expect(rank(list, "np")[0]).toBe("boundary");
  });

  it("ranks a contiguous run above the same letters scattered", () => {
    const list = [
      // s·t·o·p is in here, spread across three words.
      command("scattered", "Show the top pane"),
      command("contiguous", "Stop all panes"),
    ];
    expect(rank(list, "stop")[0]).toBe("contiguous");
  });

  it("finds a command through its keywords, below any title match", () => {
    const list = [
      command("kw", "Show the Inspector", { keywords: ["permissions"] }),
      command("title", "Permissions of a pane"),
    ];
    expect(rank(list, "permissions")).toEqual(["title", "kw"]);
  });

  // A joined keyword string lets a query straddle two unrelated words, which
  // is how a fuzzy filter starts answering nonsense.
  it("does not let a query straddle two separate keywords", () => {
    const list = [command("x", "Something", { keywords: ["grid", "item"] })];
    expect(rank(list, "gridi")).toEqual([]);
    expect(rank(list, "grid")).toEqual(["x"]);
  });

  it("falls back to the group heading", () => {
    const list = [
      command("g", "Commit staged changes", { group: "Git" }),
      command("w", "New workspace…"),
    ];
    expect(rank(list, "git")).toEqual(["g"]);
  });

  it("reports where in the title the match landed, and only for title hits", () => {
    const list = [
      command("t", "New pane"),
      command("k", "Show Roc", { keywords: ["orb"] }),
    ];
    const [title] = filterCommands([list[0]!], "np");
    expect(title!.titleIndices).toEqual([0, 4]);

    const [keyword] = filterCommands([list[1]!], "orb");
    expect(keyword!.titleIndices).toEqual([]);
  });

  it("keeps registration order between equally-scored commands", () => {
    const list = [
      command("first", "Split pane"),
      command("second", "Split pane"),
    ];
    expect(rank(list, "split")).toEqual(["first", "second"]);
  });
});

describe("highlightRuns", () => {
  it("returns one plain run when nothing matched", () => {
    expect(highlightRuns("New pane", [])).toEqual([
      { text: "New pane", hit: false },
    ]);
  });

  it("absorbs contiguous hits into one run", () => {
    expect(highlightRuns("New pane", [0, 1, 2])).toEqual([
      { text: "New", hit: true },
      { text: " pane", hit: false },
    ]);
  });

  it("splits around scattered hits and keeps the tail", () => {
    expect(highlightRuns("New pane", [0, 4])).toEqual([
      { text: "N", hit: true },
      { text: "ew ", hit: false },
      { text: "p", hit: true },
      { text: "ane", hit: false },
    ]);
  });

  it("emits no empty tail when the match reaches the end", () => {
    expect(highlightRuns("ab", [1])).toEqual([
      { text: "a", hit: false },
      { text: "b", hit: true },
    ]);
  });
});
