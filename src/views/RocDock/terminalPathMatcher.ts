/** Detect filesystem paths inside a terminal output line and resolve them
 *  against a session's working directory. The matcher requires a known file
 *  extension so prose like `Node.js` or version strings don't get underlined. */

const EXTENSIONS = [
  "ts",
  "tsx",
  "mts",
  "cts",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "json",
  "md",
  "markdown",
  "css",
  "scss",
  "sass",
  "html",
  "htm",
  "rs",
  "toml",
  "yml",
  "yaml",
  "py",
  "go",
  "java",
  "kt",
  "kts",
  "c",
  "h",
  "cpp",
  "hpp",
  "cc",
  "cxx",
  "hxx",
  "cs",
  "rb",
  "php",
  "sh",
  "bash",
  "zsh",
  "ps1",
  "psm1",
  "sql",
  "xml",
  "txt",
  "log",
  "env",
  "lock",
  "dockerfile",
];

function buildPathRegex(): RegExp {
  const ext = EXTENSIONS.join("|");
  const seg = `[A-Za-z0-9._\\-]+`;
  // Either: starts with an explicit prefix (drive / `./` / `../` / `/`) and
  // any number of segments — OR: no prefix but at least one separator in the
  // body (so single-token names like `Node.js` don't match).
  const withPrefix = `(?:[A-Za-z]:[\\\\/]|\\.{1,2}[\\\\/]|[\\\\/])${seg}(?:[\\\\/]${seg})*\\.(?:${ext})`;
  const multiSegment = `${seg}(?:[\\\\/]${seg})+\\.(?:${ext})`;
  const path = `(?:${withPrefix}|${multiSegment})`;
  const lineCol = `(?::\\d+(?::\\d+)?)?`;
  // Boundary on the left rejects matches that start right after letters,
  // digits, or URL-ish punctuation (`:` to block `://example.c`,
  // `/` and `\` to block running into a longer path that already started).
  return new RegExp(`(?<![A-Za-z0-9:/\\\\])(${path})(${lineCol})`, "g");
}

const PATH_REGEX = buildPathRegex();

export interface PathMatch {
  pathText: string;
  line?: number;
  col?: number;
  start: number;
  end: number;
}

export function findPaths(line: string): PathMatch[] {
  PATH_REGEX.lastIndex = 0;
  const out: PathMatch[] = [];
  let m: RegExpExecArray | null;
  while ((m = PATH_REGEX.exec(line)) !== null) {
    const pathText = m[1]!;
    const suffix = m[2] ?? "";
    let lineNum: number | undefined;
    let colNum: number | undefined;
    if (suffix) {
      const parts = suffix.slice(1).split(":");
      lineNum = parts[0] ? parseInt(parts[0], 10) : undefined;
      colNum = parts[1] ? parseInt(parts[1], 10) : undefined;
    }
    out.push({
      pathText,
      line: lineNum,
      col: colNum,
      start: m.index,
      end: m.index + pathText.length + suffix.length,
    });
  }
  return out;
}

export function isAbsolutePath(p: string): boolean {
  if (/^[A-Za-z]:[\\/]/.test(p)) return true;
  if (p.startsWith("/")) return true;
  if (p.startsWith("\\")) return true;
  return false;
}

export function normalize(p: string): string {
  const isWin = /^[A-Za-z]:/.test(p) || p.includes("\\");
  const sep = isWin ? "\\" : "/";
  const parts = p.split(/[\\/]/);
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") {
      if (out.length === 0 && part === "") out.push("");
      continue;
    }
    if (part === "..") {
      const last = out[out.length - 1];
      if (last && last !== ".." && !/^[A-Za-z]:$/.test(last)) {
        out.pop();
      } else {
        out.push("..");
      }
      continue;
    }
    out.push(part);
  }
  let joined = out.join(sep);
  if (isWin && /^[A-Za-z]:$/.test(out[0] ?? "")) {
    joined = `${out[0]}${sep}${out.slice(1).join(sep)}`;
  }
  return joined;
}

export function resolvePath(token: string, cwd: string): string | null {
  if (isAbsolutePath(token)) return normalize(token);
  if (!cwd) return null;
  let rel = token;
  while (rel.startsWith("./") || rel.startsWith(".\\")) {
    rel = rel.slice(2);
  }
  const sep = cwd.includes("\\") ? "\\" : "/";
  const cwdNoTrail = cwd.replace(/[\\/]+$/, "");
  return normalize(`${cwdNoTrail}${sep}${rel}`);
}
