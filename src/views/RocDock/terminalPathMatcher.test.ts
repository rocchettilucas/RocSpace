import { describe, it, expect } from "vitest";
import {
  findPaths,
  isAbsolutePath,
  normalize,
  resolvePath,
} from "@/views/RocDock/terminalPathMatcher";

describe("findPaths", () => {
  it("matches a relative TS path with line and column", () => {
    const line = "  at handler (src/foo.ts:12:5)";
    const matches = findPaths(line);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      pathText: "src/foo.ts",
      line: 12,
      col: 5,
    });
  });

  it("matches a Windows absolute path with backslashes and a line number", () => {
    const line = "Compile error in C:\\dev\\rocspace\\src\\lib.rs:42";
    const matches = findPaths(line);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.pathText).toBe("C:\\dev\\rocspace\\src\\lib.rs");
    expect(matches[0]?.line).toBe(42);
  });

  it("matches a POSIX absolute path", () => {
    const line = "Loaded /home/user/project/index.js successfully";
    const matches = findPaths(line);
    expect(matches.map((m) => m.pathText)).toContain(
      "/home/user/project/index.js",
    );
  });

  it("matches a leading-./ relative path", () => {
    const line = "Reading ./README.md...";
    const matches = findPaths(line);
    expect(matches.map((m) => m.pathText)).toContain("./README.md");
  });

  it("does not match prose with periods", () => {
    expect(findPaths("Built with Node.js v20.10.1 today.")).toHaveLength(0);
    expect(findPaths("Version 1.2.3 released")).toHaveLength(0);
  });

  it("does not match URLs", () => {
    expect(findPaths("See https://example.com for details")).toHaveLength(0);
    expect(findPaths("docs at https://foo.io/bar")).toHaveLength(0);
  });

  it("matches multiple paths in one line", () => {
    const line = "Linking src/a.ts <- src/b.ts (also tests/c.test.ts)";
    const matches = findPaths(line);
    expect(matches.map((m) => m.pathText)).toEqual([
      "src/a.ts",
      "src/b.ts",
      "tests/c.test.ts",
    ]);
  });

  it("preserves match ranges for the path + suffix", () => {
    const line = "fail: src/foo.ts:12 boom";
    const matches = findPaths(line);
    expect(matches).toHaveLength(1);
    expect(line.slice(matches[0]!.start, matches[0]!.end)).toBe(
      "src/foo.ts:12",
    );
  });
});

describe("isAbsolutePath", () => {
  it("recognizes Windows drive paths", () => {
    expect(isAbsolutePath("C:\\foo")).toBe(true);
    expect(isAbsolutePath("D:/bar")).toBe(true);
  });

  it("recognizes POSIX absolute paths", () => {
    expect(isAbsolutePath("/etc/hosts")).toBe(true);
  });

  it("rejects relative paths", () => {
    expect(isAbsolutePath("src/foo.ts")).toBe(false);
    expect(isAbsolutePath("./foo")).toBe(false);
    expect(isAbsolutePath("../bar")).toBe(false);
  });
});

describe("normalize", () => {
  it("collapses ./ segments on POSIX paths", () => {
    expect(normalize("/a/./b/./c")).toBe("/a/b/c");
  });

  it("resolves ../ on POSIX", () => {
    expect(normalize("/a/b/../c")).toBe("/a/c");
  });

  it("preserves Windows separators", () => {
    expect(normalize("C:\\a\\b\\..\\c")).toBe("C:\\a\\c");
  });

  it("does not pop the Windows drive letter", () => {
    expect(normalize("C:\\..\\foo")).toBe("C:\\..\\foo");
  });
});

describe("resolvePath", () => {
  it("returns absolute paths unchanged (normalized)", () => {
    expect(resolvePath("/a/b.ts", "/cwd")).toBe("/a/b.ts");
    expect(resolvePath("C:\\a\\b.ts", "C:\\cwd")).toBe("C:\\a\\b.ts");
  });

  it("joins relative paths to the cwd using cwd's separator style", () => {
    expect(resolvePath("src/foo.ts", "C:\\dev\\rocspace")).toBe(
      "C:\\dev\\rocspace\\src\\foo.ts",
    );
    expect(resolvePath("src/foo.ts", "/home/user/project")).toBe(
      "/home/user/project/src/foo.ts",
    );
  });

  it("strips a leading ./ from a relative path", () => {
    expect(resolvePath("./README.md", "/home/user")).toBe(
      "/home/user/README.md",
    );
  });

  it("returns null when cwd is empty for a relative path", () => {
    expect(resolvePath("src/foo.ts", "")).toBeNull();
  });
});
