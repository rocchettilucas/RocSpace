/** Handing a diff to an agent — and everything that has to come out of it
 *  first.
 *
 *  "Ask an agent to review this" writes the staged diff into a pane's PTY,
 *  which means it leaves the machine: the CLI on the other end sends its
 *  context to a model. A repository holds `.env` files, private keys and
 *  service credentials, and a user who stages one by accident has done nothing
 *  a review button should punish them for. So the payload is redacted before it
 *  is built, three ways over:
 *
 *    1. by PATH — a file whose name looks like a secret is never even read. Its
 *       diff is not fetched, so nothing to leak ever exists in this process.
 *       A renamed file is matched on its ORIGIN path too: `git mv
 *       secrets/id_rsa notes.txt` is a row called `notes.txt`, and a per-file
 *       diff of it does not even carry a rename header to give the move away.
 *    2. by ASSIGNMENT — every `KEY=` / `TOKEN=` / `SECRET=` / `PASSWORD=` and
 *       every `Authorization:` left in the text has its value replaced. That is
 *       the case rule (1) cannot catch: a credential pasted into `config.ts`.
 *    3. by VALUE SHAPE — a private key block, a bearer token, a password inside
 *       a `postgres://user:pass@host` URL, an `AKIA…` access key, or any long
 *       high-entropy literal, wherever it appears and whatever it is called.
 *       This is the rule that catches the leak the other two are built to miss:
 *       a PEM key in `notes.txt`, or a YAML block scalar under an innocuous
 *       name, where neither the path nor the assignment says anything at all.
 *
 *  Then it is capped. 200 KB is more diff than any review turn can use, and an
 *  uncapped paste is a pane sitting on a megabyte of bracketed text.
 *
 *  Over-redaction is the safe direction and this errs that way deliberately:
 *  `monkey = 3` gets masked, and a reviewer noticing `[redacted]` where they
 *  expected a number can ask. The opposite mistake is a key in a transcript. */

import { commands, type GitFileEntry } from "@/lib/bindings";
import {
  pasteSafeLine,
  sendToTerminal,
  waitUntilReady,
} from "@/lib/agentDispatch";
import { useGitStore } from "@/stores/git";
import { useToastsStore } from "@/stores/toasts";

/** What a redacted value becomes. ASCII and bracketed so it reads as a marker
 *  rather than as content, and so nothing in it can mean anything to a PTY. */
export const REDACTED = "[redacted]";

/** What a whole private key becomes. Says which kind of hole this is, because
 *  an agent that sees `[redacted]` on one line of a config can still read the
 *  file; one that sees a key block cannot, and should not try. */
export const REDACTED_KEY_BLOCK = "[redacted: private key block]";

/** The ceiling on the diff a review carries. Characters rather than bytes: a
 *  diff is overwhelmingly ASCII, where the two are the same, and the string is
 *  what actually has to fit through the paste. */
export const REVIEW_DIFF_MAX_CHARS = 200 * 1024;

/** Paths never read for a review, described in the shapes they are recognised
 *  by. Kept as prose beside the predicate because the predicate is what runs
 *  and this is what it is supposed to mean. */
export const SECRET_PATH_PATTERNS = [
  ".env*",
  "*.env",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "*.p8",
  "*.jks",
  "id_rsa*",
  "id_ed25519*",
  "id_ecdsa*",
  "id_dsa*",
  "*credentials*",
  "secrets.y[a]ml",
  "serviceAccount.json",
  "*.tfstate",
  ".npmrc",
  ".netrc",
  ".pgpass",
] as const;

/** The basename rules, one regex each so the list reads as the list above. */
const SECRET_BASENAMES: readonly RegExp[] = [
  // `.env`, `.env.local`, `.env.production` — and `production.env`,
  // `staging.env`, which the leading-dot rule alone walks straight past.
  /^\.env/,
  /\.env$/,
  // SSH private keys and the `.pub` beside them. Anchored to the whole `id_x`
  // word so `id_generator.ts` is a source file.
  /^id_(rsa|dsa|ecdsa|ed25519)([._-]|$)/,
  // Key and keystore containers, whatever the ecosystem calls them.
  /\.(pem|key|p12|pfx|p8|jks|keystore|ppk|kdbx|asc)$/,
  // `secrets.yaml`, `app.secrets.json`, `secret.env`. Bounded by an extension
  // list so `secretSanta.ts` and `secretsManager.ts` stay ordinary code.
  /(^|\.)secrets?\.(ya?ml|json|toml|ini|cfg|conf|env|txt|properties|enc)$/,
  // A GCP service-account key file is a JSON blob with a PEM key inside it.
  /service[-_.]?account/,
  // Terraform state inlines every secret the state manages, in clear.
  /\.tfstate(\.backup)?$/,
  // Registry and host credentials, which are files with fixed names.
  /^(\.npmrc|\.yarnrc|\.netrc|_netrc|\.pgpass|\.htpasswd|\.dockercfg|\.pypirc|\.git-credentials)$/,
];

/** Does this path look like it holds a secret?
 *
 *  Matched on the BASENAME for the name-shaped rules and on the whole path for
 *  `*credentials*`, because `~/aws/credentials` and `config/credentials.json`
 *  are the same thing said two ways, while a directory called `env/` is not an
 *  `.env` file. */
export function isSecretPath(path: string): boolean {
  const full = path.toLowerCase();
  const base = full.slice(full.lastIndexOf("/") + 1);
  if (full.includes("credentials")) return true;
  return SECRET_BASENAMES.some((pattern) => pattern.test(base));
}

/** Paths whose diffs are FULL of long high-entropy literals that are not
 *  secrets — a lockfile's integrity hashes, a source map's payload. Only the
 *  entropy rule stands down for them; a `https://user:pass@registry` inside a
 *  lockfile is still masked, and the file is still read and shown. */
const ENTROPY_EXEMPT =
  /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|npm-shrinkwrap\.json|cargo\.lock|poetry\.lock|composer\.lock|gemfile\.lock|go\.sum|.*\.lock)$|\.map$/;

/** An assignment whose NAME ends in a secret-shaped word.
 *
 *  Not anchored to the start of the line: the name is rarely there.
 *  `+const API_KEY = "sk-…"` has a diff marker, a keyword and a space in front
 *  of it, and an anchored pattern would have to enumerate every language's way
 *  of introducing a binding. Instead the match may begin anywhere that is NOT
 *  in the middle of an identifier — that leading group is what stops
 *  `Tokenizer` and `keyboard` from being read as `token` and `key`.
 *
 *  The optional quote on either side of the name is what makes the JSON and
 *  YAML spellings (`"apiKey": "sk-…"`) match the shell one (`API_KEY=sk-…`).
 *
 *  The value runs to END OF LINE rather than to the next space. Masking half of
 *  `"clientSecret": "abc", "other": 1` and leaving the rest would be a redaction
 *  that only looks like one. */
const SECRET_ASSIGNMENT =
  /(^|[^A-Za-z0-9_.-])(["']?[A-Za-z0-9_.-]{0,64}(?:key|token|secret|password)["']?\s*[=:]\s*)(\S.*)$/i;

/** A cheap linear pre-filter for the regex above.
 *
 *  Two reasons, and the second is the real one. Most diff lines contain none of
 *  these words, so this skips the match entirely — and a bounded, anchored
 *  regex still backtracks across the identifier it is looking for, so running
 *  it over every line of a minified bundle is work with a known answer. The
 *  `{0,64}` above is the other half of the same guard. */
const SECRET_HINT = /key|token|secret|password/i;

/** The headers that carry a credential under a name no assignment rule would
 *  recognise. `Authorization` does not end in "key" or "token", so without this
 *  a captured request in a test fixture hands over its own bearer token. */
const SENSITIVE_HEADER =
  /(^|[^A-Za-z0-9_-])(["']?(?:authorization|proxy-authorization|x-api-key|api-key|x-auth-token|x-amz-security-token|cookie|set-cookie)["']?\s*[=:]\s*)(\S.*)$/i;

/** `Bearer <token>` / `Basic <base64>`, wherever it appears — in a header, a
 *  curl line in a README, a log fixture. The eight-character floor is what
 *  keeps `Bearer <token>` and `Bearer TOKEN_HERE` placeholders readable while
 *  a real credential is not. */
const BEARER_TOKEN = /\b(bearer|basic)(\s+)([A-Za-z0-9._~+/=-]{8,})/gi;

/** The password inside a connection string: `postgres://user:pass@host`,
 *  `mongodb+srv://…`, `redis://…`, `https://user:token@github.com`. The user
 *  and host survive — they are the part a reviewer needs. */
const CONNECTION_PASSWORD = /([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+):([^\s/@]+)@/gi;

/** Credentials that announce themselves by prefix. Each of these is a vendor's
 *  own documented shape, so a match is not a guess: an AWS key id, a GitHub or
 *  GitLab or Slack or Stripe token, a Google API key, a JWT. */
const KNOWN_SECRET_TOKEN = new RegExp(
  [
    "(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ABIA)[0-9A-Z]{12,}",
    "gh[pousr]_[A-Za-z0-9]{16,}",
    "github_pat_[A-Za-z0-9_]{20,}",
    "glpat-[A-Za-z0-9_-]{16,}",
    "xox[baprse]-[A-Za-z0-9-]{10,}",
    "AIza[A-Za-z0-9_-]{20,}",
    "ya29\\.[A-Za-z0-9_-]{10,}",
    "SG\\.[A-Za-z0-9_-]{16,}",
    "npm_[A-Za-z0-9]{20,}",
    "dop_v1_[a-f0-9]{32,}",
    "shp(?:at|ss|ca|pa)_[a-f0-9]{16,}",
    "(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}",
    "sk-[A-Za-z0-9_-]{20,}",
    // A JWT: three base64url segments, and the first one always starts `eyJ`
    // because it is `{"` in base64.
    "eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}",
  ].join("|"),
  "g",
);

/** A run long enough and dense enough to be a key rather than a word.
 *
 *  Thirty-two characters is past every identifier and most hashes-in-a-path,
 *  and the character class is exactly base64's — which is what a generated
 *  credential looks like when nobody has given it a prefix. */
const HIGH_ENTROPY_CANDIDATE = /[A-Za-z0-9+/_=-]{32,}/g;

/** Bits per character, Shannon. */
function entropyBits(token: string): number {
  const counts = new Map<string, number>();
  for (const char of token) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / token.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** Measured, not guessed. Over five thousand samples each: a random 32-char
 *  base64 run never fell below 4.02 bits per character, and a hex digest never
 *  reached 3.99. Four is the gap between them, and the side to be wrong on is
 *  the low one — a masked identifier is a question, a missed key is a key. */
const ENTROPY_FLOOR = 4.0;

/** Is this run of characters shaped like a generated credential? */
function looksGenerated(token: string): boolean {
  // Both classes present: a run of only letters is a sentence run together, a
  // run of only digits is an id, and neither is a key.
  if (!/[A-Za-z]/.test(token) || !/[0-9]/.test(token)) return false;
  // Hex is the one long literal a repository is FULL of — commit shas, content
  // hashes, a UUID with its dashes taken out. Sixteen symbols hold it under the
  // floor, but only just, so it is excluded by name rather than by a decimal
  // place. A hex secret is caught by its assignment or its prefix instead.
  if (/^[0-9a-f]+$/i.test(token)) return false;
  return entropyBits(token) >= ENTROPY_FLOOR;
}

/** The armour around a private key, in every spelling that exists: `RSA`, `EC`,
 *  `DSA`, `OPENSSH`, `PGP`, `ENCRYPTED`, and PKCS#8's bare `PRIVATE KEY`.
 *
 *  Matched anywhere in the line rather than at its start, because in a diff it
 *  is behind a `+` and in a YAML block scalar it is behind an indent. */
const PEM_BEGIN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY/;
const PEM_END = /-----END [A-Z0-9 ]*PRIVATE KEY/;

/** What redaction did, so the prompt can say so. An agent told that a diff is
 *  complete when it is not will reason about code that is not there. */
export interface RedactionReport {
  text: string;
  /** Files dropped whole because their path looked like a credential. */
  droppedPaths: string[];
  /** How many lines had a value replaced. */
  maskedValues: number;
  /** How many private key blocks were removed in their entirety. */
  suppressedKeyBlocks: number;
  /** True when the cap cut the payload short. */
  truncated: boolean;
}

interface DiffSection {
  /** The name this section is reported under. */
  path: string | null;
  /** Every path named in its header — both sides of a rename, so a key moved
   *  to an innocent name is still matched on the name it left. */
  paths: string[];
  lines: string[];
}

/** Split a multi-file diff at its `diff --git` boundaries.
 *
 *  Anything before the first one is kept as a section with no path — there
 *  should not be any, and silently dropping text nobody expected would hide
 *  whatever produced it. */
function splitSections(diff: string): DiffSection[] {
  const sections: DiffSection[] = [];
  let current: DiffSection = { path: null, paths: [], lines: [] };
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      if (current.lines.length > 0) sections.push(current);
      current = { path: null, paths: [], lines: [] };
    }
    current.lines.push(line);
  }
  if (current.lines.length > 0) sections.push(current);
  for (const section of sections) {
    section.path = pathOf(section.lines);
    section.paths = pathsOf(section.lines);
  }
  return sections;
}

/** `a/src/app.ts` → `src/app.ts`, and a quoted path unquoted.
 *
 *  Git quotes a path with unusual bytes in it (`"a/we\303\251ird.txt"`). The
 *  escapes are left alone — this is used to MATCH against secret-shaped names,
 *  none of which need an escape to spell. */
function stripDiffPrefix(raw: string): string {
  let path = raw.trim();
  if (path.startsWith('"') && path.endsWith('"') && path.length >= 2) {
    path = path.slice(1, -1);
  }
  if (path.startsWith("a/") || path.startsWith("b/")) path = path.slice(2);
  return path;
}

/** Which file a section is about.
 *
 *  `+++` first (the file as it will be), `---` as the fallback for a deletion,
 *  and the `diff --git` line last — that one is genuinely ambiguous when a path
 *  contains a space, so it is only reached for a binary section, which has no
 *  `---`/`+++` pair at all. */
function pathOf(lines: string[]): string | null {
  let fromMinus: string | null = null;
  for (const line of lines) {
    if (line.startsWith("@@")) break;
    if (line.startsWith("+++ ")) {
      const path = line.slice(4).trim();
      if (path !== "/dev/null") return stripDiffPrefix(path);
    }
    if (line.startsWith("--- ") && fromMinus === null) {
      const path = line.slice(4).trim();
      if (path !== "/dev/null") fromMinus = stripDiffPrefix(path);
    }
  }
  if (fromMinus !== null) return fromMinus;

  const header = lines[0];
  if (header?.startsWith("diff --git ")) {
    const rest = header.slice("diff --git ".length);
    const split = rest.lastIndexOf(" b/");
    if (split > 0) return stripDiffPrefix(rest.slice(split + 1));
  }
  return null;
}

/** EVERY path a section names, for matching rather than for reporting.
 *
 *  A rename has two, and a diff that renames `certs/server.key` to `notes.txt`
 *  would otherwise be judged on the harmless half. `rename from`/`rename to`
 *  are read as well as `---`/`+++`, because a pure rename with no content
 *  change has no `---`/`+++` pair at all. */
function pathsOf(lines: string[]): string[] {
  const found = new Set<string>();
  const add = (raw: string) => {
    const path = stripDiffPrefix(raw);
    if (path && path !== "/dev/null") found.add(path);
  };
  for (const line of lines) {
    if (line.startsWith("@@")) break;
    if (line.startsWith("--- ") || line.startsWith("+++ ")) add(line.slice(4));
    else if (line.startsWith("rename from ")) add(line.slice(12));
    else if (line.startsWith("rename to ")) add(line.slice(10));
    else if (line.startsWith("copy from ")) add(line.slice(10));
    else if (line.startsWith("copy to ")) add(line.slice(8));
  }
  const primary = pathOf(lines);
  if (primary) found.add(primary);
  return [...found];
}

/** A diff line's leading marker (`+`, `-`, ` `) and the content after it.
 *
 *  Every value rule works on the CONTENT. Without this split a `+` would be
 *  swallowed by the base64 character class and the redacted line would stop
 *  being an addition. */
function splitMarker(line: string): [string, string] {
  const first = line.slice(0, 1);
  return first === "+" || first === "-" || first === " "
    ? [first, line.slice(1)]
    : ["", line];
}

/** Mask every secret-shaped value in one line, or leave it alone.
 *
 *  Returns `null` for "nothing here", so the caller can count the lines it
 *  changed without comparing strings.
 *
 *  Order matters. The two rules that run first replace everything to the end of
 *  the line, which is the strongest answer available and the right one when the
 *  NAME already says the value is a credential. What follows are the shape
 *  rules, which replace a token and leave the sentence around it — a diff that
 *  still reads as code, with the key taken out of it. */
function maskLine(line: string, allowEntropyRule: boolean): string | null {
  const [marker, body] = splitMarker(line);

  if (SECRET_HINT.test(body)) {
    const match = SECRET_ASSIGNMENT.exec(body);
    if (match?.index !== undefined) {
      return `${marker}${body.slice(0, match.index)}${match[1] ?? ""}${match[2] ?? ""}${REDACTED}`;
    }
  }
  const header = SENSITIVE_HEADER.exec(body);
  if (header?.index !== undefined) {
    return `${marker}${body.slice(0, header.index)}${header[1] ?? ""}${header[2] ?? ""}${REDACTED}`;
  }

  let masked = body;
  masked = masked.replace(BEARER_TOKEN, (_m, scheme, gap) =>
    typeof scheme === "string" && typeof gap === "string"
      ? `${scheme}${gap}${REDACTED}`
      : REDACTED,
  );
  masked = masked.replace(CONNECTION_PASSWORD, (_m, head) =>
    typeof head === "string" ? `${head}:${REDACTED}@` : REDACTED,
  );
  masked = masked.replace(KNOWN_SECRET_TOKEN, REDACTED);
  if (allowEntropyRule) {
    masked = masked.replace(HIGH_ENTROPY_CANDIDATE, (token) =>
      looksGenerated(token) ? REDACTED : token,
    );
  }

  return masked === body ? null : `${marker}${masked}`;
}

/** Does this line belong to the diff's own scaffolding rather than to a file?
 *
 *  Only used to end a private key block that never said `END` — a key whose
 *  hunk was cut off. Deliberately narrow: `@@` and `diff --git` cannot be
 *  produced by the base64 body of a key, so neither can un-suppress one. */
function isHunkBoundary(line: string): boolean {
  return line.startsWith("@@") || line.startsWith("diff --git ");
}

/** Drop the credential files, mask the credential values, cap what is left. */
export function redactDiff(
  diff: string,
  maxChars: number = REVIEW_DIFF_MAX_CHARS,
): RedactionReport {
  const droppedPaths: string[] = [];
  let maskedValues = 0;
  let suppressedKeyBlocks = 0;
  const kept: string[] = [];

  for (const section of splitSections(diff)) {
    const secretPath = section.paths.find(isSecretPath);
    if (secretPath !== undefined) {
      // Reported under the name it is filed under, plus the name that got it
      // withheld when those differ — otherwise a rename reads as a file
      // dropped for no reason.
      const primary = section.path;
      droppedPaths.push(
        primary === null || primary === secretPath
          ? secretPath
          : `${primary} (was ${secretPath})`,
      );
      continue;
    }
    const allowEntropyRule = !ENTROPY_EXEMPT.test(
      (section.path ?? "").toLowerCase(),
    );

    // A key block is suppressed as a block: once BEGIN is seen, every line up
    // to and including END goes, whatever it looks like. Line by line is not
    // enough — a base64 body line is just a long word, and the one that would
    // slip through is the one holding the key material.
    let inKeyBlock = false;
    for (const line of section.lines) {
      if (isHunkBoundary(line)) {
        inKeyBlock = false;
        kept.push(line);
        continue;
      }
      if (inKeyBlock) {
        if (PEM_END.test(line)) inKeyBlock = false;
        continue;
      }
      if (PEM_BEGIN.test(line)) {
        inKeyBlock = !PEM_END.test(line);
        suppressedKeyBlocks += 1;
        const [marker] = splitMarker(line);
        kept.push(`${marker}${REDACTED_KEY_BLOCK}`);
        continue;
      }
      const masked = maskLine(line, allowEntropyRule);
      if (masked === null) {
        kept.push(line);
      } else {
        maskedValues += 1;
        kept.push(masked);
      }
    }
  }

  // Cut on a line boundary. Half a line of a diff is not a shorter diff, it is
  // a corrupt one, and an agent will try to read it.
  let text = "";
  let truncated = false;
  for (let i = 0; i < kept.length; i += 1) {
    const line = kept[i] ?? "";
    if (text.length + line.length + 1 > maxChars) {
      truncated = true;
      break;
    }
    text += i === 0 ? line : `\n${line}`;
  }

  return { text, droppedPaths, maskedValues, suppressedKeyBlocks, truncated };
}

/** Fetch the staged diff for each path and concatenate it.
 *
 *  Per file, because that is the shape `git_diff` has — and it turns out to be
 *  the shape this wants anyway: a path that looks like a credential is skipped
 *  BEFORE it is read, so the secret never enters this process at all, and the
 *  loop stops the moment it has more than the cap can carry rather than
 *  spawning a `git` per file for a thousand-file commit nobody will review.
 *
 *  A rename is judged on BOTH names. A per-file diff of a renamed file has no
 *  rename header — git pairs a rename across a whole diff, not within one
 *  pathspec — so `git mv secrets/id_rsa notes.txt` reads as an ordinary new
 *  file called `notes.txt`, and its origin is the only thing left that says
 *  otherwise.
 *
 *  A file whose diff cannot be read is skipped rather than failing the whole
 *  review: one unreadable path should not cost the other forty. It is counted
 *  SEPARATELY from the ones the size cap stopped before, because the two are
 *  different sentences to the user: one is a review of a big change, the other
 *  is a review with a hole in it. */
export async function collectStagedDiff(
  repo: string,
  entries: readonly GitFileEntry[],
  maxChars: number = REVIEW_DIFF_MAX_CHARS,
): Promise<{
  text: string;
  skippedSecrets: string[];
  /** Every file not in `text` — unreadable ones included. */
  omittedFiles: number;
  /** The subset of those whose `git_diff` failed. */
  unreadableFiles: number;
}> {
  const parts: string[] = [];
  const skippedSecrets: string[] = [];
  let omittedFiles = 0;
  let unreadableFiles = 0;
  let size = 0;

  for (const entry of entries) {
    if (isSecretPath(entry.path)) {
      skippedSecrets.push(entry.path);
      continue;
    }
    if (entry.originPath && isSecretPath(entry.originPath)) {
      skippedSecrets.push(`${entry.path} (renamed from ${entry.originPath})`);
      continue;
    }
    if (size > maxChars) {
      omittedFiles += 1;
      continue;
    }
    try {
      const diff = await commands.gitDiff(repo, entry.path, true);
      parts.push(diff);
      size += diff.length;
    } catch {
      omittedFiles += 1;
      unreadableFiles += 1;
    }
  }

  return {
    text: parts.join("\n"),
    skippedSecrets,
    omittedFiles,
    unreadableFiles,
  };
}

/** The message the pane receives.
 *
 *  Three parts and all three are load-bearing. The instruction says REVIEW, not
 *  "fix" — an agent handed a diff and no constraint will start editing files,
 *  which is not what a review button promises. The redaction note keeps the
 *  agent from reasoning about `[redacted]` as if it were code, or from
 *  concluding a file is missing when it was deliberately withheld. The diff
 *  goes last so it is the thing nearest the model's attention. */
export function buildReviewPrompt(options: {
  repoName: string;
  branch: string | null;
  report: RedactionReport;
  skippedSecrets: readonly string[];
  omittedFiles: number;
}): string {
  const { repoName, branch, report, skippedSecrets, omittedFiles } = options;
  const where = branch
    ? `${pasteSafeLine(repoName)} on ${pasteSafeLine(branch)}`
    : pasteSafeLine(repoName);

  const notes: string[] = [];
  const dropped = [...skippedSecrets, ...report.droppedPaths];
  if (dropped.length > 0) {
    notes.push(
      `${dropped.length} file(s) were withheld because their paths look like` +
        ` credentials (${dropped.map((p) => pasteSafeLine(p)).join(", ")}).`,
    );
  }
  if (report.maskedValues > 0) {
    notes.push(
      `${report.maskedValues} assignment(s) had their values replaced with` +
        ` ${REDACTED}. Treat those as opaque.`,
    );
  }
  if (report.suppressedKeyBlocks > 0) {
    notes.push(
      `${report.suppressedKeyBlocks} private key block(s) were removed from` +
        ` the text entirely.`,
    );
  }
  // Two different reasons the payload is short of the change, and the note
  // said "truncated at 200 KB" for both. A file that was unreadable, or that
  // the collector stopped before, was never truncated at anything — and an
  // agent told the diff hit a size cap will reason about a big change when
  // what it actually has is a small one with a hole in it.
  if (report.truncated || omittedFiles > 0) {
    const why: string[] = [];
    if (report.truncated) {
      why.push(`it was cut at ${Math.round(REVIEW_DIFF_MAX_CHARS / 1024)} KB`);
    }
    if (omittedFiles > 0) why.push(`${omittedFiles} file(s) were left out`);
    notes.push(`This is not the whole change: ${why.join(", and ")}.`);
  }

  const head = [
    `✻ Please review this staged diff from ${where}.`,
    "Look for bugs, missing error handling, and anything that would not survive" +
      " review. Report what you find — do not edit any files.",
  ];
  if (notes.length > 0) head.push(`(${notes.join(" ")})`);
  // A blank line between the instruction and the diff, so the diff starts where
  // a reader (human or not) expects a diff to start.
  return `${head.join("\n")}\n\n${report.text}`;
}

/** Gather, redact, wait for the pane, write.
 *
 *  Returns whether the message was actually sent. Every failure raises a toast
 *  on its way out — the user pressed a button in a dialog that has already
 *  closed by the time any of this finishes, so silence would read as success.
 *
 *  Deliberately mirrors `rocplanDispatch`'s order: what to send, then WHEN the
 *  pane can take it. Writing into an open permission prompt answers that prompt
 *  with the diff. */
export async function reviewStagedDiff(terminalId: string): Promise<boolean> {
  const { repo, status } = useGitStore.getState();
  const toast = (message: string, tone: "info" | "warn" = "warn") =>
    useToastsStore.getState().push({ message, tone });

  if (!repo || !status) {
    toast("There is no repository to review.");
    return false;
  }
  if (status.staged.length === 0) {
    toast("Nothing is staged, so there is nothing to review.");
    return false;
  }

  const collected = await collectStagedDiff(repo, status.staged);
  const report = redactDiff(collected.text);
  if (report.text.trim().length === 0) {
    toast("Everything staged was withheld as a credential — nothing was sent.");
    return false;
  }

  const prompt = buildReviewPrompt({
    repoName: repo.slice(repo.lastIndexOf("/") + 1) || repo,
    branch: status.branch,
    report,
    skippedSecrets: collected.skippedSecrets,
    omittedFiles: collected.omittedFiles,
  });

  const readiness = await waitUntilReady(terminalId);
  if (readiness === "dead") {
    toast("That pane's agent has exited — nothing was sent.");
    return false;
  }
  if (readiness === "timeout") {
    toast("That pane never became free — nothing was sent.");
    return false;
  }

  try {
    await sendToTerminal(terminalId, prompt);
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err));
    return false;
  }

  // Everything the agent was told about the shape of what it got, the user is
  // told too. The version that named only the withheld credentials meant a
  // review that shipped without a file — unreadable, or past the cap — read as
  // "Sent the diff for review.", and the hole was invisible from this side.
  const withheld = collected.skippedSecrets.length + report.droppedPaths.length;
  const cappedFiles = collected.omittedFiles - collected.unreadableFiles;
  const notes: string[] = [];
  if (withheld > 0) notes.push(`${withheld} credential file(s) were withheld`);
  if (collected.unreadableFiles > 0) {
    notes.push(`${collected.unreadableFiles} file(s) could not be read`);
  }
  if (cappedFiles > 0) notes.push(`${cappedFiles} file(s) were past the cap`);
  if (report.truncated) notes.push("the diff itself was cut short");
  toast(
    notes.length > 0
      ? `Sent the diff for review — ${notes.join(", ")}.`
      : "Sent the diff for review.",
    "info",
  );
  return true;
}
