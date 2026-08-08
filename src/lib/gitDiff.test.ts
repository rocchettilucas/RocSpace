/** Turning what git printed into the two documents Monaco compares. */

import { describe, expect, it } from "vitest";
import {
  monacoLanguageForPath,
  NOTE_BINARY,
  NOTE_EMPTY,
  parseUnifiedDiff,
} from "@/lib/gitDiff";

const DIFF = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,4 +1,4 @@",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  " const c = 4;",
  "",
].join("\n");

describe("parseUnifiedDiff", () => {
  it("puts context on both sides and each marker on its own", () => {
    const { original, modified, note } = parseUnifiedDiff(DIFF);
    expect(note).toBeNull();
    expect(original).toBe(
      ["@@ -1,4 +1,4 @@", "const a = 1;", "const b = 2;", "const c = 4;"].join(
        "\n",
      ),
    );
    expect(modified).toBe(
      ["@@ -1,4 +1,4 @@", "const a = 1;", "const b = 3;", "const c = 4;"].join(
        "\n",
      ),
    );
  });

  it("drops the header and never leaks a `---` line into the left side", () => {
    // `--- a/file` starts with a minus. Read as a diff line it would become
    // content, and the left document would open with `- a/src/app.ts`.
    const { original } = parseUnifiedDiff(DIFF);
    expect(original).not.toContain("a/src/app.ts");
    expect(original).not.toContain("index 1111111");
  });

  it("keeps each hunk header as shared context so the sides stay aligned", () => {
    const diff = [
      "diff --git a/x b/x",
      "--- a/x",
      "+++ b/x",
      "@@ -1,2 +1,2 @@",
      " one",
      "-two",
      "+TWO",
      "@@ -40,2 +40,2 @@ fn far_away()",
      " forty",
      "-fortyone",
      "+FORTYONE",
      "",
    ].join("\n");
    const { original, modified } = parseUnifiedDiff(diff);
    // The landmark is identical on both sides — Monaco reads it as unchanged
    // and the two columns do not slide apart across the gap.
    expect(original.split("\n")[3]).toBe("@@ -40,2 +40,2 @@ fn far_away()");
    expect(modified.split("\n")[3]).toBe("@@ -40,2 +40,2 @@ fn far_away()");
    expect(original).toContain("fortyone");
    expect(modified).toContain("FORTYONE");
  });

  it("reads a new file as additions against an empty left side", () => {
    const diff = [
      "diff --git a/new.txt b/new.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.txt",
      "@@ -0,0 +1,2 @@",
      "+alpha",
      "+beta",
      "",
    ].join("\n");
    const { original, modified, note } = parseUnifiedDiff(diff);
    expect(note).toBeNull();
    expect(original).toBe("@@ -0,0 +1,2 @@");
    expect(modified).toBe("@@ -0,0 +1,2 @@\nalpha\nbeta");
  });

  it("ignores the no-trailing-newline marker", () => {
    const diff = [
      "diff --git a/x b/x",
      "--- a/x",
      "+++ b/x",
      "@@ -1 +1 @@",
      "-old",
      "\\ No newline at end of file",
      "+new",
      "\\ No newline at end of file",
      "",
    ].join("\n");
    const { original, modified } = parseUnifiedDiff(diff);
    expect(original).toBe("@@ -1 +1 @@\nold");
    expect(modified).toBe("@@ -1 +1 @@\nnew");
  });

  it("keeps an empty context line on both sides", () => {
    const diff = ["@@ -1,3 +1,3 @@", " a", "", "-b", "+B", ""].join("\n");
    const { original, modified } = parseUnifiedDiff(diff);
    expect(original).toBe("@@ -1,3 +1,3 @@\na\n\nb");
    expect(modified).toBe("@@ -1,3 +1,3 @@\na\n\nB");
  });

  it("handles CRLF diffs", () => {
    const diff = "@@ -1 +1 @@\r\n-old\r\n+new\r\n";
    const { original, modified } = parseUnifiedDiff(diff);
    expect(original).toBe("@@ -1 +1 @@\nold");
    expect(modified).toBe("@@ -1 +1 @@\nnew");
  });

  it("says so for a binary file rather than showing nothing", () => {
    const diff = [
      "diff --git a/logo.png b/logo.png",
      "Binary files a/logo.png and b/logo.png differ",
      "",
    ].join("\n");
    expect(parseUnifiedDiff(diff)).toEqual({
      original: "",
      modified: "",
      note: NOTE_BINARY,
    });
  });

  it("says so for an empty diff", () => {
    expect(parseUnifiedDiff("")).toEqual({
      original: "",
      modified: "",
      note: NOTE_EMPTY,
    });
  });
});

describe("monacoLanguageForPath", () => {
  it("reads the extension, not the directory", () => {
    expect(monacoLanguageForPath("src/views/App.tsx")).toBe("typescript");
    expect(monacoLanguageForPath("src-tauri/src/git/mod.rs")).toBe("rust");
    expect(monacoLanguageForPath("pnpm-lock.yaml")).toBe("yaml");
    expect(monacoLanguageForPath("a.b.c/README.md")).toBe("markdown");
  });

  it("falls back to plaintext for a dotfile or an unknown extension", () => {
    // `.env` is a name, not an extension — a leading dot must not be read as
    // one, or every dotfile would resolve to some language at random.
    expect(monacoLanguageForPath(".env")).toBe("plaintext");
    expect(monacoLanguageForPath("Makefile")).toBe("plaintext");
    expect(monacoLanguageForPath("data.weird")).toBe("plaintext");
  });
});
