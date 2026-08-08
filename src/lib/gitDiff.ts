/** A unified diff, as Monaco's diff editor wants it.
 *
 *  Rust hands back what `git diff` printed — one text, with `+`/`-` markers in
 *  column zero. Monaco's `DiffEditor` does not read that: it takes TWO
 *  documents and re-derives the difference itself. So something has to turn one
 *  into the other, and this is it.
 *
 *  The reconstruction is exact for the lines a hunk covers: every context line
 *  goes to both sides, every `-` to the left, every `+` to the right, and
 *  Monaco re-diffing those two produces the same result git described. What it
 *  is NOT is the whole file — a hunk carries three lines of context and nothing
 *  else, so the gaps between hunks are missing and the line numbers down the
 *  gutter count the reconstruction, not the file.
 *
 *  Which is why the hunk HEADER (`@@ -12,7 +12,9 @@ fn render()`) is emitted
 *  into both sides as an ordinary line. It costs one row, it lands as identical
 *  context so Monaco keeps the two sides aligned across the gap, and it says in
 *  git's own notation where in the real file the next block lives. Without it
 *  two unrelated hunks would abut with nothing to mark the join, and the gutter
 *  would look like a lie rather than an abbreviation.
 *
 *  Asking Rust for a huge `-U` instead — a whole-file diff, with real line
 *  numbers and no gaps — was the alternative. Rejected: it doubles the transfer
 *  for every file (both sides in full) to fix the line numbers on a panel whose
 *  next click is "stage this", and it puts a one-line change in a vendored 5 MB
 *  file over the 10 MB cap. */

/** The two sides, or a reason there are none. */
export interface ParsedDiff {
  original: string;
  modified: string;
  /** Non-null when there is nothing a side-by-side view can show, and what to
   *  say instead. `original`/`modified` are empty when this is set. */
  note: string | null;
}

export const NOTE_BINARY = "Binary file — nothing to show side by side.";
export const NOTE_EMPTY = "No changes in this file.";

/** Split a unified diff into the two documents it describes. */
export function parseUnifiedDiff(diff: string): ParsedDiff {
  const original: string[] = [];
  const modified: string[] = [];
  let sawHunk = false;
  let binary = false;

  // A trailing newline would otherwise arrive as a final empty line and be
  // pushed onto both sides as phantom context.
  const lines = diff.replace(/\r?\n$/, "").split(/\r?\n/);

  for (const line of lines) {
    if (line.startsWith("@@")) {
      sawHunk = true;
      // Identical on both sides: a landmark, not a change.
      original.push(line);
      modified.push(line);
      continue;
    }
    if (!sawHunk) {
      // Still in the header. `git diff` says "Binary files a/x and b/x differ";
      // with `--binary` it says "GIT binary patch" and follows it with base85,
      // which is worth even less to a reader.
      if (
        line.startsWith("Binary files") ||
        line.startsWith("GIT binary patch")
      ) {
        binary = true;
      }
      continue;
    }
    // "\ No newline at end of file" is a note about the line above, not a line.
    if (line.startsWith("\\")) continue;

    const marker = line[0] ?? " ";
    const body = line.slice(1);
    if (marker === "+") {
      modified.push(body);
    } else if (marker === "-") {
      original.push(body);
    } else {
      // A context line — including the degenerate empty one, which some
      // producers write as "" rather than as a lone space.
      original.push(body);
      modified.push(body);
    }
  }

  if (!sawHunk) {
    return {
      original: "",
      modified: "",
      note: binary ? NOTE_BINARY : NOTE_EMPTY,
    };
  }
  return {
    original: original.join("\n"),
    modified: modified.join("\n"),
    note: null,
  };
}

/** Best-guess Monaco language id for a path, so a diff is highlighted.
 *
 *  A second, smaller copy of the mapping `fs_browse::extension_to_language`
 *  owns in Rust — deliberately, and not a drift risk worth solving: that one
 *  answers for a file the editor opened, this one for a path that may not exist
 *  any more (a deletion) and never crosses the IPC boundary at all. Asking Rust
 *  would be a round trip per selection to colour some text. */
export function monacoLanguageForPath(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1) : "";
  switch (extension) {
    case "ts":
    case "mts":
    case "cts":
    case "tsx":
      return "typescript";
    case "js":
    case "mjs":
    case "cjs":
    case "jsx":
      return "javascript";
    case "json":
      return "json";
    case "md":
    case "markdown":
      return "markdown";
    case "css":
      return "css";
    case "scss":
    case "sass":
      return "scss";
    case "html":
    case "htm":
      return "html";
    case "rs":
      return "rust";
    case "toml":
      return "toml";
    case "yml":
    case "yaml":
    case "lock":
      return "yaml";
    case "py":
      return "python";
    case "go":
      return "go";
    case "java":
      return "java";
    case "kt":
    case "kts":
      return "kotlin";
    case "c":
    case "h":
      return "c";
    case "cpp":
    case "cc":
    case "cxx":
    case "hpp":
    case "hh":
    case "hxx":
      return "cpp";
    case "cs":
      return "csharp";
    case "rb":
      return "ruby";
    case "php":
      return "php";
    case "sh":
    case "bash":
    case "zsh":
      return "shell";
    case "sql":
      return "sql";
    case "xml":
      return "xml";
    default:
      return "plaintext";
  }
}
