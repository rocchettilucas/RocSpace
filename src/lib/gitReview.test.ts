/** What comes out of a diff before it is written into a pane.
 *
 *  This is the security test of the workstream: everything here is about text
 *  that is one `terminalWrite` away from leaving the machine. */

import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import {
  REDACTED,
  REDACTED_KEY_BLOCK,
  buildReviewPrompt,
  collectStagedDiff,
  isSecretPath,
  redactDiff,
  reviewStagedDiff,
  type RedactionReport,
} from "@/lib/gitReview";
import type { GitFileEntry, GitStatus } from "@/lib/bindings";
import { resetGitState, useGitStore } from "@/stores/git";
import { resetToastsState, useToastsStore } from "@/stores/toasts";
import { useTerminalsStore } from "@/stores/terminals";
import { newTerminal } from "@/lib/factories";

const REPO = "/code/rocspace";

const fileDiff = (path: string, lines: string[]): string =>
  [
    `diff --git a/${path} b/${path}`,
    "index 1111111..2222222 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1,2 +1,2 @@",
    ...lines,
  ].join("\n");

const messages = (): string[] =>
  useToastsStore.getState().items.map((t) => t.message);

beforeEach(() => {
  invoke.mockReset();
  resetGitState();
  resetToastsState();
  useTerminalsStore.setState({ byId: {} });
});

describe("isSecretPath", () => {
  it("catches every shape the phase plan named", () => {
    for (const path of [
      ".env",
      ".env.local",
      "apps/web/.env.production",
      "certs/server.pem",
      "certs/server.key",
      "keys/id_rsa",
      "keys/id_rsa.pub",
      "config/credentials.json",
      "aws/credentials",
      "certs/bundle.p12",
      // Case is not a defence.
      "Certs/SERVER.PEM",
    ]) {
      expect(isSecretPath(path), path).toBe(true);
    }
  });

  it("catches the shapes the first net walked past", () => {
    for (const path of [
      // An env file that does not LEAD with the dot.
      "config/production.env",
      "deploy/staging.env",
      // The ssh keys that are not RSA — the default since 2021.
      "keys/id_ed25519",
      "keys/id_ecdsa",
      "keys/id_dsa",
      "infra/secrets.yml",
      "infra/secrets.yaml",
      "k8s/app.secrets.json",
      "gcp/serviceAccount.json",
      "gcp/service-account.json",
      "terraform/terraform.tfstate",
      "terraform/terraform.tfstate.backup",
      ".npmrc",
      "packages/web/.npmrc",
      ".netrc",
      ".pgpass",
      "certs/keystore.jks",
      "certs/bundle.pfx",
      "certs/apple.p8",
    ]) {
      expect(isSecretPath(path), path).toBe(true);
    }
  });

  it("does not swallow ordinary files that merely look similar", () => {
    for (const path of [
      "src/env.ts",
      "src/environment/config.ts",
      "docs/keyboard.md",
      "src/keys.ts",
      "README.md",
      // The widened net has to stop somewhere, and it stops before code.
      "src/lib/secretSanta.ts",
      "src/lib/secretsManager.ts",
      "src/lib/id_generator.ts",
      "src/services/account.ts",
      "docs/environment.md",
    ]) {
      expect(isSecretPath(path), path).toBe(false);
    }
  });
});

describe("redactDiff", () => {
  it("drops a credential file whole and keeps the rest", () => {
    const diff = [
      fileDiff("src/app.ts", ["-const a = 1;", "+const a = 2;"]),
      fileDiff(".env.local", ["+STRIPE_SECRET=sk_live_abcdef"]),
      fileDiff("src/other.ts", ["+export const b = 3;"]),
    ].join("\n");

    const report = redactDiff(diff);
    expect(report.droppedPaths).toEqual([".env.local"]);
    expect(report.text).not.toContain("sk_live_abcdef");
    expect(report.text).not.toContain(".env.local");
    expect(report.text).toContain("const a = 2;");
    expect(report.text).toContain("export const b = 3;");
  });

  it("masks the value of a secret-shaped assignment in an ordinary file", () => {
    const diff = fileDiff("src/config.ts", [
      '+const API_KEY = "sk-live-9999";',
      '+const apiToken: string = "ghp_zzzz";',
      '+  "clientSecret": "abc123",',
      "+export DB_PASSWORD=hunter2",
      "+const retries = 3;",
    ]);

    const report = redactDiff(diff);
    expect(report.maskedValues).toBe(4);
    for (const leak of ["sk-live-9999", "ghp_zzzz", "abc123", "hunter2"]) {
      expect(report.text, leak).not.toContain(leak);
    }
    // The diff is still a diff: markers, names and structure survive.
    expect(report.text).toContain(`+const API_KEY = ${REDACTED}`);
    expect(report.text).toContain("+const retries = 3;");
    expect(report.text).toContain("@@ -1,2 +1,2 @@");
  });

  it("masks a removed line too — a rotated key is still a key", () => {
    const diff = fileDiff("src/config.ts", [
      '-const API_KEY = "old-secret";',
      '+const API_KEY = "new-secret";',
    ]);
    const report = redactDiff(diff);
    expect(report.text).not.toContain("old-secret");
    expect(report.text).not.toContain("new-secret");
    expect(report.maskedValues).toBe(2);
  });

  it("leaves a word that merely contains a keyword alone", () => {
    const diff = fileDiff("src/ui.ts", [
      "+const keyboard: Keyboard = makeKeyboard();",
      "+const tokenizer = new Tokenizer();",
    ]);
    const report = redactDiff(diff);
    expect(report.maskedValues).toBe(0);
    expect(report.text).toContain("makeKeyboard()");
  });

  it("cuts on a line boundary and says it did", () => {
    const lines = Array.from({ length: 400 }, (_, i) => `+line ${i}`);
    const report = redactDiff(fileDiff("src/big.ts", lines), 200);
    expect(report.truncated).toBe(true);
    expect(report.text.length).toBeLessThanOrEqual(200);
    // Never half a line. Half a line of a diff is not a shorter diff, it is a
    // corrupt one — and an agent will try to read it.
    const full = fileDiff("src/big.ts", lines).split("\n");
    for (const line of report.text.split("\n")) {
      expect(full, line).toContain(line);
    }
  });

  it("survives a diff with no header at all", () => {
    const report = redactDiff("@@ -1 +1 @@\n-a\n+b\n");
    expect(report.droppedPaths).toEqual([]);
    expect(report.text).toContain("+b");
  });

  it("removes a private key block from a file with an innocent name", () => {
    // The leak the path rule is built to miss: `git mv secrets/id_rsa
    // notes.txt` and the whole key reads as an ordinary added file.
    const diff = fileDiff("notes.txt", [
      "+-----BEGIN OPENSSH PRIVATE KEY-----",
      "+b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtz",
      "+c2gtZWQyNTUxOQAAACDkS3hunter2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "+-----END OPENSSH PRIVATE KEY-----",
      "+and an ordinary line after it",
    ]);

    const report = redactDiff(diff);
    expect(report.suppressedKeyBlocks).toBe(1);
    expect(report.text).not.toContain("b3BlbnNzaC1rZXktdjE");
    expect(report.text).not.toContain("hunter2");
    expect(report.text).toContain(REDACTED_KEY_BLOCK);
    // The rest of the file still gets reviewed.
    expect(report.text).toContain("+and an ordinary line after it");
  });

  it("removes a key written as a YAML block scalar", () => {
    // Indented, so nothing here starts at column zero and nothing is an
    // assignment whose name says "key" on the same line as the value.
    const diff = fileDiff("config.yaml", [
      "+tls:",
      "+  privateKey: |",
      "+    -----BEGIN RSA PRIVATE KEY-----",
      "+    MIIEowIBAAKCAQEAhunter2ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ",
      "+    -----END RSA PRIVATE KEY-----",
      "+  minVersion: 1.2",
    ]);

    const report = redactDiff(diff);
    expect(report.text).not.toContain("hunter2");
    expect(report.text).not.toContain("MIIEowIBAAKCAQEA");
    expect(report.text).toContain("+  minVersion: 1.2");
  });

  it("keeps a key block from swallowing the rest of the diff", () => {
    // A key whose END fell outside the hunk. Suppression stops at the hunk
    // boundary rather than eating every file after it.
    const diff = [
      fileDiff("half.pem.txt", [
        "+-----BEGIN PRIVATE KEY-----",
        "+MIIEowIBAAKCAQEAZZZZZZZZZZZZZZZZZZ",
      ]),
      fileDiff("src/after.ts", ["+export const after = true;"]),
    ].join("\n");

    const report = redactDiff(diff);
    expect(report.text).not.toContain("MIIEowIBAAKCAQEA");
    expect(report.text).toContain("+export const after = true;");
  });

  it("masks a bearer token in a header, which no assignment rule sees", () => {
    const diff = fileDiff("src/client.ts", [
      '+  "Authorization": "Bearer sk-proj-A1b2C3d4E5f6G7h8I9j0K1l2",',
      "+  curl -H 'Authorization: Bearer ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6'",
    ]);

    const report = redactDiff(diff);
    expect(report.text).not.toContain("sk-proj-A1b2C3d4E5f6G7h8I9j0K1l2");
    expect(report.text).not.toContain("ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6");
    expect(report.maskedValues).toBe(2);
  });

  it("masks the password inside a connection string", () => {
    const diff = fileDiff("docker-compose.yml", [
      "+  DATABASE_URL=postgres://appuser:s3cr3t-p4ss@db.internal:5432/app",
      "+  CACHE=redis://default:hunter2@cache.internal:6379",
      "+  PUBLIC=https://example.com/health",
    ]);

    const report = redactDiff(diff);
    expect(report.text).not.toContain("s3cr3t-p4ss");
    expect(report.text).not.toContain("hunter2");
    // The half a reviewer needs survives: which database, which user, which
    // host. Only the password goes.
    expect(report.text).toContain("postgres://appuser");
    expect(report.text).toContain("db.internal:5432/app");
    expect(report.text).toContain("+  PUBLIC=https://example.com/health");
  });

  it("masks an AWS key id, whose NAME ends in `_ID`", () => {
    // `AWS_ACCESS_KEY_ID=` does not end in a secret word, so the assignment
    // rule never sees it. The value's own shape is all there is.
    const diff = fileDiff("deploy/notes.md", [
      "+AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE",
      "+aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    ]);

    const report = redactDiff(diff);
    expect(report.text).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(report.text).not.toContain("wJalrXUtnFEMI");
  });

  it("masks a long generated literal that nothing else names", () => {
    const diff = fileDiff("src/setup.ts", [
      '+await client.connect("Zx9Kq2Lm7Pv4Rt8Wn3Yb6Hd1Fg5Js0Cu");',
      "+const commit = '4f3a2b1c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a';",
      "+const componentDisplayName = someVeryLongIdentifierName;",
    ]);

    const report = redactDiff(diff);
    expect(report.text).not.toContain("Zx9Kq2Lm7Pv4Rt8Wn3Yb6Hd1Fg5Js0Cu");
    // A commit sha is hex, which is what a repository is full of, and stays.
    expect(report.text).toContain("4f3a2b1c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a");
    expect(report.text).toContain("someVeryLongIdentifierName");
  });

  it("leaves a lockfile's integrity hashes alone", () => {
    // High-entropy by the ton and secret by none. Only the entropy rule stands
    // down — the file is still read, and a password in it would still go.
    const diff = fileDiff("pnpm-lock.yaml", [
      "+      resolution: {integrity: sha512-Xq2Kv9Lm4Pt7Rn3Wb6Yd1Hg5Js8Cu0Az/QwErTyUiOpAsDfGhJkLzXcVbNm==}",
      "+      registry: https://user:hunter2@npm.internal/",
    ]);

    const report = redactDiff(diff);
    expect(report.text).toContain("sha512-Xq2Kv9Lm4Pt7Rn3Wb6Yd1Hg5Js8Cu0Az");
    expect(report.text).not.toContain("hunter2");
  });

  it("drops a file renamed OUT of a credential name", () => {
    // The whole-diff form of the same leak: git names both sides in the
    // header, so the origin is right there to be matched on.
    const diff = [
      "diff --git a/certs/server.key b/notes.txt",
      "similarity index 98%",
      "rename from certs/server.key",
      "rename to notes.txt",
      "--- a/certs/server.key",
      "+++ b/notes.txt",
      "@@ -1 +1,2 @@",
      "+leaked-key-material",
    ].join("\n");

    const report = redactDiff(diff);
    expect(report.text).not.toContain("leaked-key-material");
    expect(report.droppedPaths).toEqual(["notes.txt (was certs/server.key)"]);
  });

  it("reads a deletion's path from the `---` side", () => {
    const diff = [
      "diff --git a/.env b/.env",
      "deleted file mode 100644",
      "--- a/.env",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-TOKEN=abcdef",
    ].join("\n");
    const report = redactDiff(diff);
    expect(report.droppedPaths).toEqual([".env"]);
    expect(report.text).not.toContain("abcdef");
  });
});

describe("collectStagedDiff", () => {
  const entry = (path: string): GitFileEntry => ({ path, status: "modified" });

  it("never asks git for a credential file's diff", async () => {
    const asked: string[] = [];
    invoke.mockImplementation((_name: string, args: { path: string }) => {
      asked.push(args.path);
      return Promise.resolve(fileDiff(args.path, ["+x"]));
    });

    const result = await collectStagedDiff(REPO, [
      entry("src/app.ts"),
      entry(".env"),
      entry("certs/key.pem"),
    ]);

    // The point of skipping by path rather than filtering afterwards: the
    // secret never enters this process, so there is nothing to leak.
    expect(asked).toEqual(["src/app.ts"]);
    expect(result.skippedSecrets).toEqual([".env", "certs/key.pem"]);
  });

  it("never asks for a file renamed OUT of a credential name", async () => {
    // A per-file diff of a renamed file has no rename header at all — git
    // pairs a rename across a whole diff, not within one pathspec — so this is
    // the only place the move can be seen.
    const asked: string[] = [];
    invoke.mockImplementation((_name: string, args: { path: string }) => {
      asked.push(args.path);
      return Promise.resolve(fileDiff(args.path, ["+x"]));
    });

    const result = await collectStagedDiff(REPO, [
      { path: "notes.txt", status: "renamed", originPath: "secrets/id_rsa" },
      { path: "src/app.ts", status: "modified" },
    ]);

    expect(asked).toEqual(["src/app.ts"]);
    expect(result.skippedSecrets).toEqual([
      "notes.txt (renamed from secrets/id_rsa)",
    ]);
  });

  it("stops reading once it has more than the cap can carry", async () => {
    let reads = 0;
    invoke.mockImplementation(() => {
      reads += 1;
      return Promise.resolve("x".repeat(120));
    });

    const entries = Array.from({ length: 50 }, (_, i) => entry(`f${i}.ts`));
    const result = await collectStagedDiff(REPO, entries, 200);

    expect(reads).toBeLessThan(5);
    expect(result.omittedFiles).toBeGreaterThan(0);
  });

  it("skips a file it cannot read rather than failing the whole review", async () => {
    invoke.mockImplementation((_name: string, args: { path: string }) =>
      args.path === "bad.ts"
        ? Promise.reject("fatal: something")
        : Promise.resolve(fileDiff(args.path, ["+ok"])),
    );

    const result = await collectStagedDiff(REPO, [
      entry("bad.ts"),
      entry("good.ts"),
    ]);
    expect(result.omittedFiles).toBe(1);
    expect(result.text).toContain("+ok");
  });
});

describe("buildReviewPrompt", () => {
  it("says what was withheld, so the agent does not reason about a hole", () => {
    const prompt = buildReviewPrompt({
      repoName: "rocspace",
      branch: "main",
      report: {
        text: "@@ -1 +1 @@\n+ok",
        droppedPaths: [],
        maskedValues: 2,
        suppressedKeyBlocks: 0,
        truncated: false,
      },
      skippedSecrets: [".env"],
      omittedFiles: 0,
    });

    expect(prompt).toContain("rocspace on main");
    expect(prompt).toContain("do not edit any files");
    expect(prompt).toContain("1 file(s) were withheld");
    expect(prompt).toContain(".env");
    expect(prompt).toContain(`2 assignment(s) had their values replaced`);
    expect(prompt.endsWith("@@ -1 +1 @@\n+ok")).toBe(true);
  });

  it("says which of the two reasons the diff is short of the change", () => {
    const report = (over: Partial<RedactionReport> = {}): RedactionReport => ({
      text: "+ok",
      droppedPaths: [],
      maskedValues: 0,
      suppressedKeyBlocks: 0,
      truncated: false,
      ...over,
    });
    const prompt = (over: Partial<RedactionReport>, omittedFiles: number) =>
      buildReviewPrompt({
        repoName: "rocspace",
        branch: "main",
        report: report(over),
        skippedSecrets: [],
        omittedFiles,
      });

    // A file that could not be read was never truncated at anything, and an
    // agent told the payload hit a size cap will reason about a big change
    // when what it has is a small one with a hole in it.
    const omittedOnly = prompt({}, 2);
    expect(omittedOnly).toContain("This is not the whole change");
    expect(omittedOnly).toContain("2 file(s) were left out");
    expect(omittedOnly).not.toContain("KB");

    const cutOnly = prompt({ truncated: true }, 0);
    expect(cutOnly).toContain("it was cut at 200 KB");
    expect(cutOnly).not.toContain("left out");

    const both = prompt({ truncated: true }, 3);
    expect(both).toContain("it was cut at 200 KB");
    expect(both).toContain("3 file(s) were left out");
  });

  it("says nothing about redaction when nothing was redacted", () => {
    const prompt = buildReviewPrompt({
      repoName: "rocspace",
      branch: null,
      report: {
        text: "+ok",
        droppedPaths: [],
        maskedValues: 0,
        suppressedKeyBlocks: 0,
        truncated: false,
      },
      skippedSecrets: [],
      omittedFiles: 0,
    });
    expect(prompt).not.toContain("withheld");
    expect(prompt).not.toContain("replaced");
  });
});

describe("reviewStagedDiff", () => {
  const status = (over: Partial<GitStatus> = {}): GitStatus => ({
    branch: "main",
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    untracked: [],
    ...over,
  });

  /** A shell pane: no hooks, so `waitUntilReady` uses the quiet heuristic and
   *  resolves on its own without a store transition to wait for. */
  function livePane(): string {
    const terminal = newTerminal({
      workspaceId: "w1",
      name: "Rocky",
      agentType: "claude-code",
      projectPath: REPO,
    });
    useTerminalsStore.getState().addTerminal({ ...terminal, status: "idle" });
    return terminal.id;
  }

  it("refuses with a toast when nothing is staged", async () => {
    useGitStore.setState({ repo: REPO, status: status() });
    expect(await reviewStagedDiff("t1")).toBe(false);
    expect(messages()).toEqual([
      "Nothing is staged, so there is nothing to review.",
    ]);
  });

  it("sends nothing when everything staged was a credential", async () => {
    useGitStore.setState({
      repo: REPO,
      status: status({ staged: [{ path: ".env", status: "modified" }] }),
    });
    expect(await reviewStagedDiff("t1")).toBe(false);
    expect(messages()[0]).toContain("withheld as a credential");
    // Not one call: the path was refused before git was asked.
    expect(invoke).not.toHaveBeenCalled();
  });

  it("writes the redacted diff into the pane and says what it withheld", async () => {
    const id = livePane();
    const written: string[] = [];
    invoke.mockImplementation((name: string, args: Record<string, string>) => {
      if (name === "git_diff") {
        return Promise.resolve(
          fileDiff("src/config.ts", ['+const API_KEY = "sk-live-1";']),
        );
      }
      if (name === "terminal_write") {
        written.push(args.data ?? "");
        return Promise.resolve(undefined);
      }
      return Promise.reject(new Error(`unexpected ${name}`));
    });

    useGitStore.setState({
      repo: REPO,
      status: status({
        staged: [
          { path: "src/config.ts", status: "modified" },
          { path: ".env", status: "modified" },
        ],
      }),
    });

    expect(await reviewStagedDiff(id)).toBe(true);
    expect(written).toHaveLength(1);
    const sent = written[0] ?? "";
    expect(sent).not.toContain("sk-live-1");
    expect(sent).toContain(REDACTED);
    expect(sent).toContain("Please review this staged diff");
    // Bracketed paste, one message and one Enter — the framing every dispatch
    // in the app shares.
    expect(sent.startsWith("\x1b[200~")).toBe(true);
    expect(sent.endsWith("\x1b[201~\r")).toBe(true);
    expect(messages()[0]).toContain("1 credential file(s) were withheld");
  });

  it("tells the user which files the review went out without", async () => {
    const id = livePane();
    invoke.mockImplementation((name: string, args: Record<string, string>) => {
      if (name === "git_diff") {
        return args.path === "src/broken.ts"
          ? Promise.reject("fatal: unable to read src/broken.ts")
          : Promise.resolve(fileDiff("src/a.ts", ["+ok"]));
      }
      if (name === "terminal_write") return Promise.resolve(undefined);
      return Promise.reject(new Error(`unexpected ${name}`));
    });

    useGitStore.setState({
      repo: REPO,
      status: status({
        staged: [
          { path: "src/a.ts", status: "modified" },
          { path: "src/broken.ts", status: "modified" },
        ],
      }),
    });

    expect(await reviewStagedDiff(id)).toBe(true);
    // The agent is told the diff has a hole in it. The user was told "Sent the
    // diff for review." — a review that shipped without a file reads as a
    // complete one, and the file it is missing is invisible from here.
    expect(messages()[0]).toContain("1 file(s) could not be read");
  });

  it("says so rather than writing into a pane whose agent has exited", async () => {
    const terminal = newTerminal({
      workspaceId: "w1",
      name: "Gone",
      agentType: "claude-code",
      projectPath: REPO,
    });
    useTerminalsStore
      .getState()
      .addTerminal({ ...terminal, status: "complete" });
    invoke.mockResolvedValue(fileDiff("src/a.ts", ["+ok"]));
    useGitStore.setState({
      repo: REPO,
      status: status({ staged: [{ path: "src/a.ts", status: "modified" }] }),
    });

    expect(await reviewStagedDiff(terminal.id)).toBe(false);
    expect(messages()[0]).toContain("has exited");
  });
});
