/** The changelog parser, and the guarantees the real file has to keep — the
 *  dialog reads `CHANGELOG.md` directly, so a heading typed the wrong way is a
 *  release nobody is told about. */

import { describe, expect, it } from "vitest";
import {
  CHANGELOG_ENTRIES,
  LATEST_ENTRY,
  parseChangelog,
} from "@/lib/changelog";

describe("parseChangelog", () => {
  it("reads an entry's id, title, date and sections", () => {
    const [entry] = parseChangelog(
      [
        "# Changelog",
        "",
        "## [phase-5] Git, Editor & Finish — 2026-08-05",
        "",
        "### Added",
        "",
        "- A command palette",
        "- Zoom",
        "",
        "### Fixed",
        "- One thing",
        "",
      ].join("\n"),
    );

    expect(entry).toEqual({
      id: "phase-5",
      title: "Git, Editor & Finish",
      date: "2026-08-05",
      lead: [],
      sections: [
        { heading: "Added", items: ["A command palette", "Zoom"] },
        { heading: "Fixed", items: ["One thing"] },
      ],
    });
  });

  it("keeps entries in file order — newest first is the file's job", () => {
    const entries = parseChangelog(
      "## [b] Second — 2026-01-02\n## [a] First — 2026-01-01\n",
    );
    expect(entries.map((e) => e.id)).toEqual(["b", "a"]);
  });

  it("survives a heading with no date and no title", () => {
    const [entry] = parseChangelog("## [0.1.0]\n- something\n");
    expect(entry).toMatchObject({ id: "0.1.0", title: "", date: null });
    // Bullets before any `###` are the entry's lead, not a lost section.
    expect(entry!.lead).toEqual(["something"]);
  });

  it("joins a bullet that wrapped onto the next line", () => {
    const [entry] = parseChangelog(
      [
        "## [x] X",
        "### Added",
        "- one long thing",
        "  continued here",
        "",
      ].join("\n"),
    );
    expect(entry!.sections[0]!.items).toEqual([
      "one long thing continued here",
    ]);
  });

  it("strips the markdown a bullet realistically carries", () => {
    const [entry] = parseChangelog(
      "## [x] X\n- **Bold**, `code`, and a [link](http://example.com)\n",
    );
    expect(entry!.lead).toEqual(["Bold, code, and a link"]);
  });

  it("ignores prose that belongs to no entry, and never throws", () => {
    expect(parseChangelog("")).toEqual([]);
    expect(parseChangelog("# Changelog\n\nJust prose.\n")).toEqual([]);
    // Indentation under nothing is dropped rather than becoming an item.
    expect(parseChangelog("## [x] X\n  orphaned\n")[0]!.lead).toEqual([]);
  });

  it("does not mistake a `##` without brackets for an entry", () => {
    expect(parseChangelog("## Unreleased\n- thing\n")).toEqual([]);
  });
});

// The parser is only half the contract; the file is the other half.
describe("the real CHANGELOG.md", () => {
  it("parses into entries the dialog can show", () => {
    expect(CHANGELOG_ENTRIES.length).toBeGreaterThan(0);
    expect(LATEST_ENTRY).not.toBeNull();
  });

  it("gives the newest entry a title and something to say", () => {
    const items = LATEST_ENTRY!.sections.flatMap((s) => s.items);
    expect(LATEST_ENTRY!.title).not.toBe("");
    expect(items.length).toBeGreaterThan(0);
  });

  // Ids are what settings remembers as "already read". A duplicate would make
  // reading one entry silence another.
  it("has a unique id per entry", () => {
    const ids = CHANGELOG_ENTRIES.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("carries every phase of the revamp, plus what came before it", () => {
    const ids = CHANGELOG_ENTRIES.map((e) => e.id);
    for (const phase of [0, 1, 2, 3, 4, 5]) {
      expect(ids).toContain(`phase-${phase}`);
    }
    expect(ids).toContain("0.1.0");
  });
});
