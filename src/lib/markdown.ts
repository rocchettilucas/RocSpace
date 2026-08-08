/** Enough markdown to read a memory.
 *
 *  A parser rather than a dependency, and rather than `dangerouslySetInnerHTML`
 *  over one. The corpus is written by agents — it contains shell snippets,
 *  URLs, and prose about HTML — and the one thing this pane must never do is
 *  interpret a memory as markup. So the body is parsed into a small tree of
 *  blocks and inlines here, and rendered as React elements by `MarkdownView`;
 *  nothing anywhere turns a string into DOM.
 *
 *  Deliberately partial. What the 67 memories on this machine actually use:
 *  ATX headings, fenced code, bullet and numbered lists (nested one or two
 *  deep), block quotes, horizontal rules, and inline code / bold / italic /
 *  links / `[[wikilinks]]`. Tables, reference links, setext headings and HTML
 *  are not supported and degrade to the text they are written as, which is
 *  readable — the failure mode of an incomplete parser here is a line that
 *  looks like its source, not a line that disappears.
 *
 *  `[[wikilinks]]` are the reason this is not just `<pre>`: they are the graph
 *  the corpus already has, and clicking one has to select that memory. */

export type Inline =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "strong"; children: Inline[] }
  | { type: "em"; children: Inline[] }
  | { type: "link"; href: string; children: Inline[] }
  /** `[[target]]` — a link to another memory, by its frontmatter `name`. */
  | { type: "wikilink"; target: string };

export interface ListItem {
  /** Nesting level, 0 for a top-level bullet. Two spaces (or one tab) per
   *  level, which is what the corpus writes. */
  depth: number;
  children: Inline[];
}

export type Block =
  | { type: "heading"; level: number; children: Inline[] }
  | { type: "paragraph"; children: Inline[] }
  | { type: "code"; lang: string; text: string }
  | { type: "list"; ordered: boolean; items: ListItem[] }
  | { type: "quote"; children: Inline[] }
  | { type: "rule" };

/** Drop a leading `---` frontmatter block.
 *
 *  The pane shows `name`, `description` and the type as its own header, so
 *  rendering the block again underneath would say everything twice. Mirrors
 *  `split_frontmatter` in `src-tauri/src/rocmind/mod.rs` — including the rule
 *  that an UNCLOSED fence is not frontmatter at all, so a half-written file
 *  keeps its text instead of losing all of it.
 *
 *  A file that does not open with a fence is returned untouched. */
export function stripFrontmatter(text: string): string {
  const body = text.startsWith("﻿") ? text.slice(1) : text;
  const lines = body.split("\n");
  if ((lines[0] ?? "").trim() !== "---") return body;
  for (let i = 1; i < lines.length; i += 1) {
    if ((lines[i] ?? "").trim() === "---") {
      return lines.slice(i + 1).join("\n");
    }
  }
  return body;
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const FENCE = /^\s*(```|~~~)\s*([\w+-]*)\s*$/;
const RULE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;
const BULLET = /^(\s*)([-*+])\s+(.*)$/;
const NUMBERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;

/** Parse a memory body into blocks. */
export function parseMarkdown(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  /** Lines of the paragraph being accumulated. Flushed by anything that is not
   *  more paragraph. */
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push({
      type: "paragraph",
      children: parseInline(paragraph.join("\n")),
    });
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";

    if (line.trim() === "") {
      flushParagraph();
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      flushParagraph();
      const marker = fence[1] ?? "```";
      const body: string[] = [];
      i += 1;
      // An unterminated fence runs to the end of the file rather than
      // swallowing the rest as a paragraph: an agent's log pasted without a
      // closing fence should still read as a log.
      while (i < lines.length && !(lines[i] ?? "").trim().startsWith(marker)) {
        body.push(lines[i] ?? "");
        i += 1;
      }
      if (i >= lines.length) {
        // Ran to the end of the file. The last line of a file that ends in a
        // newline is an empty string, which would otherwise show as a blank
        // line inside the block — an artifact of splitting, not of the text.
        while (body[body.length - 1] === "") body.pop();
      }
      blocks.push({
        type: "code",
        lang: fence[2] ?? "",
        text: body.join("\n"),
      });
      continue;
    }

    // Checked before the bullet rule, because `---` matches both and a
    // horizontal rule is the commoner meaning of a line that is only dashes.
    if (RULE.test(line)) {
      flushParagraph();
      blocks.push({ type: "rule" });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph();
      blocks.push({
        type: "heading",
        level: (heading[1] ?? "#").length,
        children: parseInline(heading[2] ?? ""),
      });
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote) {
      flushParagraph();
      const body = [quote[1] ?? ""];
      while (i + 1 < lines.length) {
        const next = QUOTE.exec(lines[i + 1] ?? "");
        if (!next) break;
        body.push(next[1] ?? "");
        i += 1;
      }
      blocks.push({ type: "quote", children: parseInline(body.join("\n")) });
      continue;
    }

    if (BULLET.test(line) || NUMBERED.test(line)) {
      flushParagraph();
      const ordered = !BULLET.test(line);
      const items: ListItem[] = [];
      // One list runs until a line that is neither an item nor a continuation
      // of one. Blank lines inside a list are kept as list separators rather
      // than ending it, which is what a "loose" list is written as.
      while (i < lines.length) {
        const current = lines[i] ?? "";
        const match = BULLET.exec(current) ?? NUMBERED.exec(current);
        if (match) {
          const indent = (match[1] ?? "").replace(/\t/g, "  ").length;
          items.push({
            depth: Math.floor(indent / 2),
            children: parseInline(match[3] ?? ""),
          });
          i += 1;
          continue;
        }
        if (current.trim() === "" && items.length > 0) {
          // Only a separator if the list carries on after it.
          const next = lines[i + 1] ?? "";
          if (BULLET.test(next) || NUMBERED.test(next)) {
            i += 1;
            continue;
          }
        }
        break;
      }
      i -= 1;
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    paragraph.push(line);
  }
  flushParagraph();
  return blocks;
}

/** Parse one run of text into inline nodes.
 *
 *  Single pass, longest marker first. Code spans win over everything, because
 *  `` `**not bold**` `` is a literal in this corpus far more often than it is a
 *  mistake — a memory about a shell command is full of asterisks. */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let plain = "";

  const flush = () => {
    if (plain === "") return;
    out.push({ type: "text", text: plain });
    plain = "";
  };

  let at = 0;
  while (at < text.length) {
    const taken = takeMarker(text.slice(at));
    if (taken) {
      flush();
      out.push(taken.node);
      at += taken.length;
      continue;
    }
    // Nothing starts here — one character of plain text, and on to the next.
    // Advancing by one unconditionally is what makes this loop total: every
    // branch above either consumes a positive number of characters or declines,
    // so there is no input this can spin on.
    plain += text[at];
    at += 1;
  }
  flush();
  return out;
}

/** The inline node starting at the beginning of `rest`, or null when the next
 *  character is ordinary text.
 *
 *  Order is the precedence: an escape beats everything, a code span beats every
 *  marker inside it (`` `**not bold**` `` is a literal in this corpus far more
 *  often than a mistake), a wikilink beats an ordinary link because `[[a]]`
 *  also starts with `[`, and `**` is tried before `*` so bold is not read as
 *  emphasis of an empty string. */
function takeMarker(rest: string): { node: Inline; length: number } | null {
  // Backslash escape — the one place a marker can be written literally.
  if (rest.startsWith("\\") && rest.length > 1) {
    return { node: { type: "text", text: rest[1] ?? "" }, length: 2 };
  }

  if (rest.startsWith("`")) {
    const end = rest.indexOf("`", 1);
    // `end > 1`, not `> 0`: an EMPTY span is two literal backticks, which is
    // what a memory quoting a shell prompt writes. Reading it as a code span
    // containing nothing made the pair disappear from the page.
    if (end > 1) {
      return {
        node: { type: "code", text: rest.slice(1, end) },
        length: end + 1,
      };
    }
  }

  if (rest.startsWith("[[")) {
    const end = rest.indexOf("]]");
    if (end > 2) {
      const target = rest.slice(2, end).trim();
      if (target !== "") {
        return { node: { type: "wikilink", target }, length: end + 2 };
      }
    }
  }

  if (rest.startsWith("[")) {
    const link = matchLink(rest);
    if (link) {
      return {
        node: {
          type: "link",
          href: link.href,
          children: parseInline(link.label),
        },
        length: link.length,
      };
    }
  }

  for (const [marker, type] of [
    ["**", "strong"],
    ["__", "strong"],
    ["*", "em"],
    ["_", "em"],
  ] as const) {
    if (!rest.startsWith(marker)) continue;
    const end = rest.indexOf(marker, marker.length);
    // An empty pair (`****`) is four markers, not emphasis of nothing.
    if (end <= marker.length) continue;
    return {
      node: { type, children: parseInline(rest.slice(marker.length, end)) },
      length: end + marker.length,
    };
  }

  return null;
}

/** `[label](href)` at the start of `rest`, or null.
 *
 *  Hand-matched rather than a regex because a label may contain brackets
 *  (`[see [[memory]]](url)`) and a URL may contain parentheses — both of which
 *  a greedy or lazy regex gets wrong in opposite directions. */
function matchLink(
  rest: string,
): { label: string; href: string; length: number } | null {
  let depth = 0;
  let close = -1;
  for (let i = 0; i < rest.length; i += 1) {
    const ch = rest[i];
    if (ch === "[") depth += 1;
    else if (ch === "]") {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === -1 || rest[close + 1] !== "(") return null;
  let parens = 0;
  for (let i = close + 1; i < rest.length; i += 1) {
    const ch = rest[i];
    if (ch === "(") parens += 1;
    else if (ch === ")") {
      parens -= 1;
      if (parens === 0) {
        return {
          label: rest.slice(1, close),
          href: rest.slice(close + 2, i).trim(),
          length: i + 1,
        };
      }
    }
  }
  return null;
}

/** Plain text of a parsed body, for search and for a one-line preview. */
export function inlineText(nodes: Inline[]): string {
  return nodes
    .map((node) => {
      switch (node.type) {
        case "text":
        case "code":
          return node.text;
        case "wikilink":
          return node.target;
        default:
          return inlineText(node.children);
      }
    })
    .join("");
}
