/** Enough markdown to read a memory — and, more to the point, never enough to
 *  turn one into markup. */

import { describe, expect, it } from "vitest";
import {
  inlineText,
  parseInline,
  parseMarkdown,
  stripFrontmatter,
  type Block,
} from "@/lib/markdown";

const first = (text: string): Block => parseMarkdown(text)[0]!;

describe("stripFrontmatter", () => {
  it("drops a complete block and keeps the body", () => {
    const text = "---\nname: a\ndescription: b\n---\nBody line\n";
    expect(stripFrontmatter(text)).toBe("Body line\n");
  });

  it("keeps everything when the fence never closes", () => {
    // A truncated write. Treating it as frontmatter would show an empty pane
    // over a file that has text in it — the same rule the Rust parser follows.
    const text = "---\nname: a\nhalf a des";
    expect(stripFrontmatter(text)).toBe(text);
  });

  it("leaves a file that does not open with a fence alone", () => {
    expect(stripFrontmatter("# Notes\n\nbody")).toBe("# Notes\n\nbody");
  });

  it("does not treat a rule further down as the closing fence's twin", () => {
    const text = "# Title\n\n---\n\nmore";
    expect(stripFrontmatter(text)).toBe(text);
  });
});

describe("blocks", () => {
  it("reads ATX headings at their level", () => {
    expect(first("### Capture recipe")).toEqual({
      type: "heading",
      level: 3,
      children: [{ type: "text", text: "Capture recipe" }],
    });
  });

  it("keeps a fenced code block verbatim", () => {
    const block = first("```bash\nadb emu geo fix -3.7 40.4\n```\n");
    expect(block).toEqual({
      type: "code",
      lang: "bash",
      text: "adb emu geo fix -3.7 40.4",
    });
  });

  it("does not parse markers inside a code fence", () => {
    // A memory about a shell command is full of asterisks and brackets.
    const block = first("```\nrm -rf **/*.md and [[not-a-link]]\n```");
    expect(block).toEqual({
      type: "code",
      lang: "",
      text: "rm -rf **/*.md and [[not-a-link]]",
    });
  });

  it("runs an unterminated fence to the end rather than eating the file", () => {
    const block = first("```\nlog line one\nlog line two\n");
    expect(block.type).toBe("code");
    expect(block).toMatchObject({ text: "log line one\nlog line two" });
  });

  it("reads a bullet list, keeping nesting depth", () => {
    const block = first("- top\n  - nested\n- back\n");
    expect(block).toMatchObject({
      type: "list",
      ordered: false,
      items: [{ depth: 0 }, { depth: 1 }, { depth: 0 }],
    });
  });

  it("reads a numbered list", () => {
    expect(first("1. first\n2. second\n")).toMatchObject({
      type: "list",
      ordered: true,
      items: [{ depth: 0 }, { depth: 0 }],
    });
  });

  it("reads `---` as a rule, not as a one-item list", () => {
    expect(first("---\n")).toEqual({ type: "rule" });
  });

  it("joins a block quote's lines into one quote", () => {
    expect(first("> one\n> two\n")).toMatchObject({ type: "quote" });
  });

  it("keeps consecutive lines in one paragraph and splits on a blank line", () => {
    const blocks = parseMarkdown("one\ntwo\n\nthree\n");
    expect(blocks).toHaveLength(2);
    const paragraph = blocks[0]!;
    expect(paragraph.type).toBe("paragraph");
    if (paragraph.type !== "paragraph") throw new Error("unreachable");
    expect(inlineText(paragraph.children)).toBe("one\ntwo");
  });

  it("parses a memory-shaped document end to end", () => {
    const blocks = parseMarkdown(
      [
        "Regenerated 2026-07-14. `compose.py` rebuilds ALL ten store images.",
        "",
        "Capture recipe:",
        "- Copy the dev-client .app between sims — no rebuild needed.",
        "- First launch needs one tap.",
        "",
        "See [[landing-screenshot-workflow]] for the landing shots.",
      ].join("\n"),
    );
    expect(blocks.map((b) => b.type)).toEqual([
      "paragraph",
      "paragraph",
      "list",
      "paragraph",
    ]);
  });
});

describe("inline", () => {
  it("reads a wikilink as its own node", () => {
    expect(parseInline("see [[payments-provider-migration]] first")).toEqual([
      { type: "text", text: "see " },
      { type: "wikilink", target: "payments-provider-migration" },
      { type: "text", text: " first" },
    ]);
  });

  it("prefers a code span over the markers inside it", () => {
    expect(parseInline("run `git commit -m **wip**`")).toEqual([
      { type: "text", text: "run " },
      { type: "code", text: "git commit -m **wip**" },
    ]);
  });

  it("reads bold before emphasis", () => {
    expect(parseInline("**Opus 5**")).toEqual([
      { type: "strong", children: [{ type: "text", text: "Opus 5" }] },
    ]);
  });

  it("reads a link's label and href without swallowing later parentheses", () => {
    expect(
      parseInline("[docs](https://example.com/a(b)) and (an aside)"),
    ).toMatchObject([
      { type: "link", href: "https://example.com/a(b)" },
      { type: "text", text: " and (an aside)" },
    ]);
  });

  it("leaves an unmatched marker as text", () => {
    // 2 * 3 * 4 is arithmetic, not two levels of emphasis.
    expect(inlineText(parseInline("a * b and `unclosed"))).toBe(
      "a * b and `unclosed",
    );
  });

  it("honours a backslash escape", () => {
    expect(inlineText(parseInline("\\*not emphasis\\*"))).toBe(
      "*not emphasis*",
    );
  });

  it("treats an empty wikilink as text", () => {
    expect(parseInline("[[]]")).toEqual([{ type: "text", text: "[[]]" }]);
  });

  it("terminates on every character of a pathological input", () => {
    // The loop's totality is the property that matters here: a marker that
    // never closes must consume one character and move on, not spin.
    const nasty = "*".repeat(200) + "[[".repeat(50) + "`".repeat(50);
    expect(() => parseInline(nasty)).not.toThrow();
    expect(inlineText(parseInline(nasty))).toBe(nasty);
  });
});
