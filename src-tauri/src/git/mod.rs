//! Git, as a review-and-commit panel needs it: status, diff, staging, commits,
//! branches, checkout and worktrees.
//!
//! Every one of these is a `git` subprocess with an ARGV. Not a shell string —
//! not once, not for the "safe" ones. Every value that reaches this module came
//! from a repository the user cloned or a box they typed into, and a branch
//! called `; rm -rf ~` is a legal branch name. `Command::arg` hands each value
//! to `execve` as one element, so the only thing that can interpret a semicolon
//! is `git` itself, which reads it as a character in a name. There is no
//! `sh -c` here and there must never be one; the tests assert it by trying.
//!
//! Not libgit2, for the reason the whole app shells out to CLIs: the user's
//! `git` is the one that knows their config, their credential helper, their
//! hooks and their `include`s. A second implementation would agree with it
//! right up until it did not, and the place it stopped agreeing would be
//! somebody's commit.
//!
//! Not `git_info`, either, which sits next door and answers "which branch is
//! this directory on" by READING `.git/HEAD`. That module is a per-pane poll —
//! a process spawn every two seconds per pane was the thing it existed to
//! avoid. This one runs when a human clicks something. Different frequency,
//! different answer, and `git_status` borrows `git_info::branch_at` for the one
//! case porcelain cannot name (see below), so the two do not drift.
//!
//! Three rules hold everywhere in this file:
//!
//!   * **Absolute repo, run from its ROOT.** A relative `repo` would resolve
//!     against the app's working directory, which is wherever the launcher
//!     happened to leave it. And a repo that is a SUBDIRECTORY would disagree
//!     with the paths `git status` prints, which are always root-relative — see
//!     `repo_path`, where the walk up happens.
//!   * **Inside the repo.** Every file path is repo-RELATIVE with no `..`
//!     component, so a panel bug (or a crafted `plan.json`, or a future caller)
//!     cannot stage `../../.ssh/id_rsa`. Paths are passed after `--`, so a file
//!     named `-f` is a file.
//!   * **Capped output.** `git diff` on a vendored directory is unbounded, and
//!     an unbounded read into a `Vec<u8>` is the renderer's memory. Ten
//!     megabytes in, then the child is killed and the caller is told. Truncating
//!     instead was rejected for `status`: half a `--porcelain -z` stream is not
//!     a shorter answer, it is a WRONG one, and the panel would stage against
//!     it.

use std::ffi::OsStr;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};
use specta::Type;

/// The ceiling on what one `git` invocation may hand back. Ten megabytes is far
/// past any diff a person reads and far short of anything that hurts.
pub const MAX_OUTPUT_BYTES: usize = 10 * 1024 * 1024;

/// Stderr is a sentence for a toast, not a payload. Anything past this is a
/// hook writing a novel; it is drained and dropped so the child can still exit.
const MAX_STDERR_BYTES: u64 = 64 * 1024;

// ---------------------------------------------------------------------------
// DTOs (mirrored by hand into src/lib/bindings.ts)
// ---------------------------------------------------------------------------

/// What happened to one file, in the vocabulary the panel draws.
///
/// Narrower than git's own two-letter code on purpose: the panel shows a letter
/// and a colour, and the codes that do not change that answer are folded in.
/// `typechange` is a modification, a copy is a rename with a different origin,
/// and every unmerged combination is one word — `conflicted` — because the only
/// thing the user can do about any of them is open the file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum GitFileStatus {
    Modified,
    Added,
    Deleted,
    Renamed,
    Untracked,
    Conflicted,
}

/// One row in one of the three lists.
///
/// `path` is repo-relative and is the SAME string `git_stage` / `git_diff`
/// take back — the round trip is the contract. For a rename it is the new path.
///
/// `origin_path` is where a renamed or copied file came FROM, which the panel
/// does not draw — it has one line per row and the diff shows the move anyway.
/// It is carried for the agent review, which decides whether to send a file by
/// looking at its name: `git mv secrets/id_rsa notes.txt` produces a row called
/// `notes.txt`, and a per-file diff of it has no rename header to give the move
/// away (git pairs a rename across the whole diff, not within one pathspec), so
/// without the origin the whole key reads as an ordinary added file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitFileEntry {
    pub path: String,
    pub status: GitFileStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin_path: Option<String>,
}

/// The whole panel's state in one read.
///
/// `branch` is `None` only when there is genuinely nothing to say — an empty
/// repository with an unreadable HEAD. A detached HEAD reports its short sha
/// rather than nothing, so the header says where you are instead of going
/// blank at the one moment (mid-rebase, mid-bisect) that matters most.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub branch: Option<String>,
    /// Commits this branch has that its upstream does not. Zero when there is
    /// no upstream — "ahead of nothing" is not a number worth showing.
    pub ahead: u32,
    pub behind: u32,
    pub staged: Vec<GitFileEntry>,
    pub unstaged: Vec<GitFileEntry>,
    pub untracked: Vec<GitFileEntry>,
}

/// A branch the switcher can offer.
///
/// Remote-tracking refs are included and flagged rather than filtered: "check
/// out the branch my colleague pushed" is the common reason to open a branch
/// list at all. `refs/remotes/*/HEAD` is dropped — it is a symbolic ref to the
/// default branch, so listing it offers the same branch twice under a name
/// (`origin/HEAD`) that is not one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitBranch {
    /// `main` for a local branch, `origin/main` for a remote-tracking one.
    pub name: String,
    pub is_current: bool,
    pub is_remote: bool,
}

// ---------------------------------------------------------------------------
// Argument validation
// ---------------------------------------------------------------------------

/// A NUL cannot survive `execve`, and the failure it produces on the way there
/// is an `io::Error` about a "nul byte in provided data" — true, and useless in
/// a toast. Caught here so the message names the field.
fn reject_nul(label: &str, value: &str) -> Result<(), String> {
    if value.contains('\0') {
        return Err(format!("{label} contains a NUL byte"));
    }
    Ok(())
}

/// The repository a command runs in: absolute, existing, a directory — and then
/// its ROOT.
///
/// Canonicalized so `~/p`, `~/p/`, and `~/p/src/..` are one repo — the same
/// normalization `git_info` does, for the same reason: this string is compared
/// against others (the workspace's project path, a worktree's path) and three
/// spellings of one directory is three bugs.
///
/// Then walked UP to the repository root, which is not a nicety. `git status
/// --porcelain` prints every path relative to the ROOT no matter which
/// directory git ran in, and the panel hands those exact strings back to
/// `git add`, `git diff` and `git reset`, which resolve a pathspec relative to
/// git's own working directory. Point a workspace at `repo/src` and the two
/// disagree about every file: `git -C repo/src add -- src/main.rs` looks for
/// `repo/src/src/main.rs` and fails, the diff comes back empty, and `git reset`
/// — which exits 0 for a pathspec that matches nothing — quietly does nothing
/// at all. Running every command from the root is what makes the round trip the
/// contract this module claims it is.
///
/// `git_info::repo_root_at` does the walking, so the panel and the per-pane
/// branch chip cannot disagree about where a repository starts — including the
/// `.git`-as-a-FILE case of a linked worktree, which RocSpace's own development
/// happens in.
///
/// A directory in no repository is passed through as itself rather than refused
/// here: the sentence the user should read is git's own "not a git repository",
/// which names the problem better than anything this function could say.
fn repo_path(repo: &str) -> Result<PathBuf, String> {
    reject_nul("repository path", repo)?;
    let path = Path::new(repo);
    if !path.is_absolute() {
        return Err("repository path must be absolute".into());
    }
    let canonical =
        std::fs::canonicalize(path).map_err(|e| format!("repository not accessible: {e}"))?;
    if !canonical.is_dir() {
        return Err("repository path is not a directory".into());
    }
    Ok(crate::git_info::repo_root_at(&canonical).unwrap_or(canonical))
}

/// A file path INSIDE the repository, exactly as `git status` spelled it.
///
/// Lexical, not `canonicalize`: a deleted file has no inode to resolve, and it
/// is precisely the file the panel most wants to stage. So the rule is on the
/// string — no absolute paths, no `..`, no root — which is strictly stronger
/// than a resolve would be anyway (a symlink inside the repo pointing out of it
/// still cannot be *named* out of it here).
fn repo_relative(path: &str) -> Result<String, String> {
    reject_nul("path", path)?;
    if path.is_empty() {
        return Err("path is empty".into());
    }
    let candidate = Path::new(path);
    if candidate.is_absolute() {
        return Err(format!("path must be relative to the repository: {path}"));
    }
    for component in candidate.components() {
        match component {
            Component::Normal(_) | Component::CurDir => {}
            Component::ParentDir => {
                return Err(format!("path escapes the repository: {path}"));
            }
            // A Windows drive letter or a UNC share — absolute by another
            // spelling, which `is_absolute` alone does not always catch.
            Component::RootDir | Component::Prefix(_) => {
                return Err(format!("path must be relative to the repository: {path}"));
            }
        }
    }
    Ok(path.to_string())
}

/// A directory a worktree may be created at: absolute, and not required to
/// exist (git creates it). Whether it is empty is git's question, and git's
/// refusal is a better sentence than ours would be.
fn new_absolute_path(path: &str) -> Result<String, String> {
    reject_nul("worktree path", path)?;
    if path.is_empty() {
        return Err("worktree path is empty".into());
    }
    if !Path::new(path).is_absolute() {
        return Err("worktree path must be absolute".into());
    }
    Ok(path.to_string())
}

/// `git check-ref-format --branch`, inlined.
///
/// Not paranoia about the shell — there is no shell. It is about the ARGV
/// position: `git checkout <name>` has no `--` that separates names from flags
/// the way pathspecs do, so a "branch" called `--exec=...` would be read as an
/// option by whatever git version parses it. Rejecting the whole malformed-name
/// class costs one function and means the panel can never construct that call.
///
/// The rules are git's own, minus the ones only a plumbing caller can trip.
fn validate_branch_name(name: &str) -> Result<(), String> {
    reject_nul("branch name", name)?;
    let bad = |why: &str| Err(format!("invalid branch name ({why}): {name}"));
    if name.is_empty() {
        return bad("empty");
    }
    if name.starts_with('-') {
        return bad("starts with a dash");
    }
    if name.starts_with('/') || name.ends_with('/') || name.contains("//") {
        return bad("misplaced slash");
    }
    if name.ends_with('.') || name.contains("..") {
        return bad("misplaced dot");
    }
    if name.ends_with(".lock") {
        return bad("ends with .lock");
    }
    if name == "@" || name.contains("@{") {
        return bad("reserved");
    }
    if name
        .chars()
        .any(|c| c.is_ascii_control() || " ~^:?*[\\".contains(c))
    {
        return bad("illegal character");
    }
    // Git refuses a component starting with a dot too — `foo/.bar` is not a
    // ref, and neither is `.bar`.
    if name.split('/').any(|part| part.starts_with('.')) {
        return bad("component starts with a dot");
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Running git
// ---------------------------------------------------------------------------

/// What one invocation produced.
#[derive(Debug)]
struct GitRun {
    stdout: Vec<u8>,
    stderr: String,
    success: bool,
    code: Option<i32>,
}

impl GitRun {
    /// The best sentence available about a failure — git's own, whichever pipe
    /// it chose. `commit` is the reason both are consulted: "nothing to commit,
    /// working tree clean" is the message a user needs and git prints it on
    /// STDOUT, with an empty stderr and a non-zero exit.
    fn error(&self) -> String {
        let stderr = self.stderr.trim();
        if !stderr.is_empty() {
            return stderr.to_string();
        }
        let stdout = String::from_utf8_lossy(&self.stdout);
        let stdout = stdout.trim();
        if !stdout.is_empty() {
            return stdout.to_string();
        }
        match self.code {
            Some(code) => format!("git exited with status {code}"),
            None => "git was killed by a signal".into(),
        }
    }

    fn text(&self) -> String {
        // Lossy, because a repository may hold paths that are not UTF-8 and the
        // DTOs that carry them are `String`. A replacement character in a
        // filename is a row the user cannot act on; a hard error would be a
        // whole panel they cannot open.
        String::from_utf8_lossy(&self.stdout).into_owned()
    }
}

/// Spawn `git -C <repo> <args…>` and collect at most `limit` bytes of stdout.
///
/// The `limit` is a parameter rather than the constant so it can be tested:
/// asserting the cap by generating eleven megabytes would be a slow test of a
/// fast rule. Public callers all pass `MAX_OUTPUT_BYTES`.
///
/// Stderr is read on its own thread. Not decoration: with both pipes full and
/// only one reader, git blocks writing to the one nobody is draining and we
/// block waiting for the one it is not writing — a deadlock that shows up only
/// on the repositories with the most to say.
fn run_git_limited<I, S>(repo: &Path, args: I, limit: usize) -> Result<GitRun, String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let mut command = Command::new("git");
    command
        // A forced `core.pager` would otherwise wrap the output we are about to
        // parse, and a forced `color.ui = always` would paint ANSI escapes
        // through the middle of a diff.
        .arg("--no-pager")
        // Every path in this module is a NAME, never a pattern. Without this,
        // git reads its own pathspec magic in one: `*.txt` is a glob that
        // stages three other files, `:weird.txt` is a magic prefix that matches
        // nothing at all, and `!x` negates. `--` protects a path from being
        // read as an OPTION and does nothing about any of that; this is the
        // half `--` does not cover. Refs are unaffected — `for-each-ref`'s
        // patterns and `checkout`'s branch are not pathspecs.
        .arg("--literal-pathspecs")
        // Every path in this module is a NAME, never a pattern. Without this,
        // git reads its own pathspec magic in one: `*.txt` is a glob that
        // stages three other files, `:weird.txt` is a magic prefix that matches
        // nothing at all, and `!x` negates. `--` protects a path from being
        // read as an OPTION and does nothing about any of that; this is the
        // half `--` does not cover. Refs are unaffected — `for-each-ref`'s
        // patterns and `checkout`'s branch are not pathspecs.
        .arg("-c")
        .arg("color.ui=false")
        .arg("-C")
        .arg(repo)
        .args(args)
        // A repository whose remote wants a password must fail, not hang: this
        // process has no terminal to ask on, and a blocked child is a spinner
        // that never stops.
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|e| format!("could not run git: {e}"))?;

    let mut stderr_pipe = child
        .stderr
        .take()
        .ok_or_else(|| "git stderr unavailable".to_string())?;
    let stderr_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = (&mut stderr_pipe)
            .take(MAX_STDERR_BYTES)
            .read_to_end(&mut buf);
        // Drain the rest into nothing. Stopping at the cap and walking away
        // would leave git wedged on a full pipe forever.
        let _ = std::io::copy(&mut stderr_pipe, &mut std::io::sink());
        buf
    });

    let mut stdout_pipe = child
        .stdout
        .take()
        .ok_or_else(|| "git stdout unavailable".to_string())?;
    let mut stdout = Vec::new();
    // One byte past the limit, so "exactly at the limit" and "over it" are
    // distinguishable without reading the overflow.
    let read_error = (&mut stdout_pipe)
        .take(limit.saturating_add(1) as u64)
        .read_to_end(&mut stdout)
        .err();
    let overflowed = stdout.len() > limit;
    if overflowed {
        // Nothing else will read this pipe, so the child would block on it.
        let _ = child.kill();
    }
    let _ = std::io::copy(&mut stdout_pipe, &mut std::io::sink());

    let status = child.wait().map_err(|e| format!("git did not exit: {e}"))?;
    let stderr_bytes = stderr_reader
        .join()
        .map_err(|_| "git stderr reader panicked".to_string())?;

    if let Some(err) = read_error {
        return Err(format!("could not read git output: {err}"));
    }
    if overflowed {
        return Err(format!(
            "git produced more than {limit} bytes of output; this file is too large to show here"
        ));
    }

    Ok(GitRun {
        stdout,
        stderr: String::from_utf8_lossy(&stderr_bytes).into_owned(),
        success: status.success(),
        code: status.code(),
    })
}

fn run_git<I, S>(repo: &Path, args: I) -> Result<GitRun, String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    run_git_limited(repo, args, MAX_OUTPUT_BYTES)
}

/// Run, and turn a non-zero exit into git's own message.
fn run_git_ok<I, S>(repo: &Path, args: I) -> Result<GitRun, String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let run = run_git(repo, args)?;
    if !run.success {
        return Err(run.error());
    }
    Ok(run)
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

/// `## …`, the first record of `--porcelain --branch`, into a branch and a
/// distance from its upstream.
///
/// Four shapes exist, and all four are here because the panel's header is the
/// first thing a user looks at and a wrong one is worse than none:
///
/// ```text
/// ## main                              — no upstream
/// ## main...origin/main [ahead 1, behind 2]
/// ## No commits yet on main            — a fresh repository
/// ## HEAD (no branch)                  — detached
/// ```
fn parse_branch_header(rest: &str) -> (Option<String>, u32, u32) {
    let (names, tracking) = match rest.find(" [") {
        Some(index) => (&rest[..index], &rest[index + 2..]),
        None => (rest, ""),
    };
    let ahead = parse_tracking_count(tracking, "ahead ");
    let behind = parse_tracking_count(tracking, "behind ");
    // `local...remote` — everything before the ellipsis is the local branch.
    let name = names.split("...").next().unwrap_or(names).trim();
    let branch = if name == "HEAD (no branch)" {
        None
    } else if let Some(fresh) = name.strip_prefix("No commits yet on ") {
        Some(fresh.trim().to_string())
    } else if name.is_empty() {
        None
    } else {
        Some(name.to_string())
    };
    (branch, ahead, behind)
}

fn parse_tracking_count(tracking: &str, key: &str) -> u32 {
    let Some(index) = tracking.find(key) else {
        return 0;
    };
    tracking[index + key.len()..]
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect::<String>()
        .parse()
        .unwrap_or(0)
}

/// One half of git's two-letter code, in the panel's vocabulary. `None` means
/// "nothing happened on this side" — a space, or a code this list does not
/// model.
fn code_to_status(code: char) -> Option<GitFileStatus> {
    match code {
        // A typechange (file → symlink, mode flip) is a modification as far as
        // anything the panel offers to do about it is concerned.
        'M' | 'T' => Some(GitFileStatus::Modified),
        'A' => Some(GitFileStatus::Added),
        'D' => Some(GitFileStatus::Deleted),
        // A copy carries an origin path exactly like a rename does, and the row
        // reads the same. Folded rather than given a seventh word nobody would
        // draw differently.
        'R' | 'C' => Some(GitFileStatus::Renamed),
        _ => None,
    }
}

/// The unmerged combinations, per `git status`'s own documentation: `DD`, `AU`,
/// `UD`, `UA`, `DU`, `AA`, `UU`.
fn is_conflict(x: char, y: char) -> bool {
    x == 'U' || y == 'U' || (x == 'A' && y == 'A') || (x == 'D' && y == 'D')
}

/// `--porcelain=v1 -z --branch` into a `GitStatus`.
///
/// `-z` rather than the human format for one reason: without it git QUOTES any
/// path with a space, a quote or a non-ASCII byte in it, and the panel would
/// hand that quoted spelling straight back to `git add`, which would look for a
/// file whose name really did contain backslashes. NUL-separated records have
/// no escaping to undo.
fn parse_status(text: &str) -> GitStatus {
    let mut branch = None;
    let mut ahead = 0;
    let mut behind = 0;
    let mut staged = Vec::new();
    let mut unstaged = Vec::new();
    let mut untracked = Vec::new();

    let mut records = text.split('\0').filter(|r| !r.is_empty()).peekable();
    if let Some(first) = records.peek() {
        if let Some(rest) = first.strip_prefix("## ") {
            let parsed = parse_branch_header(rest);
            branch = parsed.0;
            ahead = parsed.1;
            behind = parsed.2;
            records.next();
        }
    }

    while let Some(record) = records.next() {
        // `XY<space>path`. Anything shorter is not a record.
        if record.len() < 4 {
            continue;
        }
        let mut chars = record.chars();
        let (Some(x), Some(y)) = (chars.next(), chars.next()) else {
            continue;
        };
        let path = record[3..].to_string();

        // `!!` only appears with --ignored, which we never pass.
        if x == '?' && y == '?' {
            untracked.push(GitFileEntry {
                path,
                status: GitFileStatus::Untracked,
                origin_path: None,
            });
            continue;
        }
        if x == '!' {
            continue;
        }
        // A rename or copy spends a SECOND record on its origin path. It has to
        // be consumed here or it would be read as the next file's status line —
        // and it is KEPT, because a file's old name is the only thing that says
        // a credential was moved somewhere innocuous. See `GitFileEntry`.
        let origin_path = if x == 'R' || x == 'C' {
            records.next().map(str::to_string)
        } else {
            None
        };
        if is_conflict(x, y) {
            // Filed under unstaged: the only move available is to open the file
            // and resolve it, and that is what the unstaged list means.
            unstaged.push(GitFileEntry {
                path,
                status: GitFileStatus::Conflicted,
                origin_path,
            });
            continue;
        }
        if let Some(status) = code_to_status(x) {
            staged.push(GitFileEntry {
                path: path.clone(),
                status,
                origin_path: origin_path.clone(),
            });
        }
        if let Some(status) = code_to_status(y) {
            unstaged.push(GitFileEntry {
                path,
                status,
                origin_path,
            });
        }
    }

    GitStatus {
        branch,
        ahead,
        behind,
        staged,
        unstaged,
        untracked,
    }
}

/// Everything the panel draws: the branch, its distance from upstream, and the
/// three file lists.
///
/// `--untracked-files=all` rather than the default `normal`, which collapses an
/// untracked DIRECTORY into one row. A collapsed row cannot be staged
/// selectively and cannot be diffed, so the panel would show "src/" and be
/// unable to say anything else about it.
///
/// `--no-optional-locks` because this command is now WATCHED. `git status`
/// opportunistically rewrites `.git/index` to refresh its stat cache — any
/// tracked file touched since the last run is enough — and `git_info`'s watcher
/// wakes the panel when that file moves. Without this flag the two feed each
/// other: the watcher fires, the panel reads, the read rewrites the index, the
/// watcher fires. One `git status` every two seconds, forever, on a repository
/// where nothing is happening. The flag is exactly what git documents it for,
/// and the output is byte-identical.
#[tauri::command]
#[specta::specta]
pub async fn git_status(repo: String) -> Result<GitStatus, String> {
    let root = repo_path(&repo)?;
    let run = run_git_ok(
        &root,
        [
            "--no-optional-locks",
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            "--branch",
        ],
    )?;
    let mut status = parse_status(&run.text());
    // Porcelain says `HEAD (no branch)` and stops. `git_info` reads the same
    // HEAD this command just walked and abbreviates the object id, which is
    // what `git log --oneline` shows and therefore what the user recognises.
    if status.branch.is_none() {
        status.branch = crate::git_info::branch_at(&root);
    }
    Ok(status)
}

// ---------------------------------------------------------------------------
// diff
// ---------------------------------------------------------------------------

/// A unified diff for one file, staged or unstaged.
///
/// Untracked files are the awkward case: `git diff` knows nothing about a file
/// git has never seen, so it prints nothing, and a panel that showed an empty
/// diff for every new file would be useless exactly when a new file is the
/// whole change. So an untracked file's diff is SYNTHESIZED here — every line
/// an addition against `/dev/null`, which is byte-for-byte the diff git itself
/// produces once the file is staged. `--no-index` would have been the git-native
/// route and was rejected: it needs a null-device path spelled differently on
/// every platform.
#[tauri::command]
#[specta::specta]
pub async fn git_diff(repo: String, path: String, staged: bool) -> Result<String, String> {
    let root = repo_path(&repo)?;
    let relative = repo_relative(&path)?;

    let mut args = vec!["diff".to_string()];
    if staged {
        args.push("--cached".to_string());
    }
    // Everything after `--` is a pathspec, so a file called `--output` is a
    // file. This is the reason paths never need escaping anywhere in this file.
    args.push("--".to_string());
    args.push(relative.clone());

    let run = run_git_ok(&root, &args)?;
    let diff = run.text();
    if !diff.is_empty() || staged {
        return Ok(diff);
    }

    // Empty and unstaged: either genuinely unchanged, or untracked.
    let tracked = run_git(
        &root,
        ["ls-files", "--error-unmatch", "--", relative.as_str()],
    )?;
    if tracked.success {
        return Ok(diff);
    }
    synthesize_untracked_diff(&root, &relative)
}

/// The diff a file would have if it were staged right now — all additions.
///
/// This is the one place in the module that reads a file itself instead of
/// asking git, so it is the one place that has to enforce what git enforces for
/// free. Two rules, both about following a link out of the repository and
/// printing what is on the other end:
///
///   * the FINAL component is never followed. `fs::metadata` follows it, so a
///     symlink called `notes.txt` pointing at `~/.ssh/id_rsa` would be read and
///     its contents returned as an added file. `symlink_metadata` stops at the
///     link, and a link is then rendered the way git renders one: mode 120000
///     with the TARGET PATH as the content, which is exactly what git would
///     store and says nothing about what the target holds.
///   * the DIRECTORIES above it must resolve inside the root. Git never
///     descends through a symlinked directory, so no such path can come out of
///     `git status` — but `git_diff` is a command anything may call, and
///     `link/passwd` for a `link -> /etc` would otherwise be read.
///
/// A regular file is what is left, and only a regular file is read: a fifo
/// would block forever and a device has no length worth trusting.
fn synthesize_untracked_diff(root: &Path, relative: &str) -> Result<String, String> {
    let full = root.join(relative);

    if let Some(parent) = full.parent() {
        let resolved = std::fs::canonicalize(parent).map_err(|e| format!("stat failed: {e}"))?;
        if !resolved.starts_with(root) {
            return Err(format!("path escapes the repository: {relative}"));
        }
    }

    let metadata = std::fs::symlink_metadata(&full).map_err(|e| format!("stat failed: {e}"))?;
    if metadata.file_type().is_symlink() {
        return symlink_diff(&full, relative);
    }
    if metadata.is_dir() {
        return Err("path is a directory".into());
    }
    if !metadata.is_file() {
        return Err("path is not a regular file".into());
    }
    if metadata.len() as usize > MAX_OUTPUT_BYTES {
        return Err(format!(
            "this file is larger than {MAX_OUTPUT_BYTES} bytes and is too large to show here"
        ));
    }
    let bytes = std::fs::read(&full).map_err(|e| format!("read failed: {e}"))?;
    let header = format!("diff --git a/{relative} b/{relative}\nnew file mode 100644\n");
    let Ok(text) = String::from_utf8(bytes) else {
        // Same sentence git uses, so the panel does not need a second vocabulary
        // for "there is nothing here a diff view can show".
        return Ok(format!(
            "{header}Binary files /dev/null and b/{relative} differ\n"
        ));
    };
    if text.is_empty() {
        return Ok(header);
    }
    let ends_with_newline = text.ends_with('\n');
    let lines: Vec<&str> = text
        .strip_suffix('\n')
        .unwrap_or(&text)
        .split('\n')
        .collect();
    let mut out = header;
    out.push_str("--- /dev/null\n");
    out.push_str(&format!("+++ b/{relative}\n"));
    out.push_str(&format!("@@ -0,0 +1,{} @@\n", lines.len()));
    for line in &lines {
        out.push('+');
        out.push_str(line);
        out.push('\n');
    }
    if !ends_with_newline {
        out.push_str("\\ No newline at end of file\n");
    }
    Ok(out)
}

/// A symlink as git spells one: mode 120000, and the TARGET PATH as the whole
/// content — never what is at the other end of it.
///
/// Byte-for-byte what `git diff` prints for the same link once it is staged,
/// including the "no newline" marker: git stores a target without a trailing
/// newline, so its diff always carries one.
fn symlink_diff(full: &Path, relative: &str) -> Result<String, String> {
    let target = std::fs::read_link(full).map_err(|e| format!("readlink failed: {e}"))?;
    let target = target.to_string_lossy();
    Ok(format!(
        "diff --git a/{relative} b/{relative}\n\
         new file mode 120000\n\
         --- /dev/null\n\
         +++ b/{relative}\n\
         @@ -0,0 +1 @@\n\
         +{target}\n\
         \\ No newline at end of file\n"
    ))
}

// ---------------------------------------------------------------------------
// staging
// ---------------------------------------------------------------------------

/// Move files into the index. Handles deletions too — modern `git add` records
/// a removal, so the panel needs no second verb for a file that is gone.
#[tauri::command]
#[specta::specta]
pub async fn git_stage(repo: String, paths: Vec<String>) -> Result<(), String> {
    let root = repo_path(&repo)?;
    if paths.is_empty() {
        return Ok(());
    }
    let mut args = vec!["add".to_string(), "--".to_string()];
    for path in &paths {
        args.push(repo_relative(path)?);
    }
    run_git_ok(&root, &args)?;
    Ok(())
}

/// Move files back out of the index, leaving the working tree alone.
///
/// `git reset` rather than the friendlier `git restore --staged`, for one
/// reason found by testing: `restore` resolves HEAD, and a repository with no
/// commits yet has no HEAD, so unstaging the very first `git add` a user ever
/// makes would fail with `fatal: could not resolve HEAD`. `reset` treats an
/// unborn branch as the empty tree and does the right thing.
///
/// It also, unlike `add`, exits 0 for a pathspec that matches NOTHING — so the
/// naive version of this command reported success for every failure it had, and
/// the panel drew a row that would not go away with no sentence saying why.
/// Hence the check first: git's own list of what is actually staged under those
/// paths, and a real error naming the ones that are not.
#[tauri::command]
#[specta::specta]
pub async fn git_unstage(repo: String, paths: Vec<String>) -> Result<(), String> {
    let root = repo_path(&repo)?;
    if paths.is_empty() {
        return Ok(());
    }
    let mut relatives = Vec::with_capacity(paths.len());
    for path in &paths {
        relatives.push(repo_relative(path)?);
    }

    let unmatched = staged_pathspecs_that_match_nothing(&root, &relatives)?;
    if !unmatched.is_empty() {
        return Err(format!(
            "nothing staged matches {} — the panel's list may be out of date",
            unmatched.join(", ")
        ));
    }

    let mut args = vec!["reset".to_string(), "-q".to_string(), "--".to_string()];
    args.extend(relatives);
    run_git_ok(&root, &args)?;
    Ok(())
}

/// Which of `relatives` name nothing that is currently staged.
///
/// `diff --cached --name-only` is the right question because it is the same
/// question `reset` answers: what differs between HEAD and the index. Notably
/// it still names a staged DELETION, whose path is by then gone from both the
/// index and the working tree — so `ls-files --error-unmatch`, the obvious
/// check, would reject exactly the row a user most often wants to undo.
/// `-z` for the reason `status` uses it: no quoting to undo.
///
/// A path counts as matched by an exact hit or as a directory prefix, so a
/// caller that passes `src` to unstage a subtree is not told it matched
/// nothing. An unborn HEAD is fine here — git diffs against the empty tree.
fn staged_pathspecs_that_match_nothing(
    root: &Path,
    relatives: &[String],
) -> Result<Vec<String>, String> {
    let mut args = vec![
        "diff".to_string(),
        "--cached".to_string(),
        "--name-only".to_string(),
        // A rename is two paths, and the panel holds the new one. Without this
        // the pair is reported as one entry under the NEW name only when git
        // feels like it; `--no-renames` makes it always a delete plus an add,
        // so both spellings are present and either one matches.
        "--no-renames".to_string(),
        "-z".to_string(),
        "--".to_string(),
    ];
    args.extend(relatives.iter().cloned());
    let run = run_git_ok(root, &args)?;
    let text = run.text();
    let staged: Vec<&str> = text.split('\0').filter(|s| !s.is_empty()).collect();

    Ok(relatives
        .iter()
        .filter(|wanted| {
            let prefix = format!("{wanted}/");
            !staged
                .iter()
                .any(|name| *name == wanted.as_str() || name.starts_with(&prefix))
        })
        .cloned()
        .collect())
}

// ---------------------------------------------------------------------------
// commit
// ---------------------------------------------------------------------------

/// Commit what is staged, and answer with the short sha.
///
/// The message goes in as ONE argv entry, so a multi-line message keeps its
/// newlines and a message containing `$(…)` commits that text. No `--no-verify`
/// and no `-a`: the user's hooks are part of their repository, and a panel that
/// quietly skipped them would be committing something the command line would
/// have refused.
#[tauri::command]
#[specta::specta]
pub async fn git_commit(repo: String, message: String) -> Result<String, String> {
    let root = repo_path(&repo)?;
    reject_nul("commit message", &message)?;
    if message.trim().is_empty() {
        return Err("a commit needs a message".into());
    }
    run_git_ok(&root, ["commit", "-m", message.as_str()])?;
    let head = run_git_ok(&root, ["rev-parse", "--short", "HEAD"])?;
    Ok(head.text().trim().to_string())
}

// ---------------------------------------------------------------------------
// branches
// ---------------------------------------------------------------------------

/// Every local and remote-tracking branch, current one flagged.
///
/// `for-each-ref` rather than `branch --list`: the latter's output is formatted
/// for a human (a `* ` marker, colour, `(HEAD detached at …)` as if it were a
/// branch name) and would have to be un-formatted. `%(HEAD)` is git's own
/// answer to "is this the checked-out one", and a tab cannot appear in a ref
/// name, so the split is unambiguous.
#[tauri::command]
#[specta::specta]
pub async fn git_branches(repo: String) -> Result<Vec<GitBranch>, String> {
    let root = repo_path(&repo)?;
    let run = run_git_ok(
        &root,
        [
            "for-each-ref",
            "--format=%(HEAD)%09%(refname)",
            "refs/heads",
            "refs/remotes",
        ],
    )?;
    Ok(parse_branches(&run.text()))
}

fn parse_branches(text: &str) -> Vec<GitBranch> {
    let mut branches = Vec::new();
    for line in text.lines() {
        let Some((head, refname)) = line.split_once('\t') else {
            continue;
        };
        let is_current = head.trim() == "*";
        if let Some(name) = refname.strip_prefix("refs/heads/") {
            branches.push(GitBranch {
                name: name.to_string(),
                is_current,
                is_remote: false,
            });
        } else if let Some(name) = refname.strip_prefix("refs/remotes/") {
            // `origin/HEAD` is a pointer at another entry in this same list.
            if name.split('/').next_back() == Some("HEAD") {
                continue;
            }
            branches.push(GitBranch {
                name: name.to_string(),
                is_current,
                is_remote: true,
            });
        }
    }
    branches
}

/// Switch branches, optionally creating one first.
///
/// `checkout` rather than `switch` because `switch` arrived in git 2.23 and
/// this is the one command in the file a user on an old distribution would
/// notice missing.
///
/// Checking out a remote-tracking name (`origin/topic`) directly would detach
/// HEAD, which is never what a click on a branch row means — so the CALLER
/// passes the short name (`topic`) and git's own DWIM creates the local branch
/// tracking it. See `GitView`'s branch dialog.
#[tauri::command]
#[specta::specta]
pub async fn git_checkout(repo: String, branch: String, create: bool) -> Result<(), String> {
    let root = repo_path(&repo)?;
    validate_branch_name(&branch)?;
    let args: Vec<&str> = if create {
        vec!["checkout", "-b", branch.as_str()]
    } else {
        vec!["checkout", branch.as_str()]
    };
    run_git_ok(&root, args)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// worktrees
// ---------------------------------------------------------------------------

/// Add a linked worktree — a second checkout of the same repository, on its own
/// branch, in its own directory.
///
/// This is the command the whole "run three agents on three branches" workflow
/// rests on: each worktree is a directory a workspace can point at, sharing one
/// object store, with no clone and no stashing between them.
///
/// `create_branch` is `-b`: fail if the branch already exists, rather than
/// silently checking out somebody else's work in progress.
#[tauri::command]
#[specta::specta]
pub async fn git_worktree_add(
    repo: String,
    path: String,
    branch: String,
    create_branch: bool,
) -> Result<(), String> {
    let root = repo_path(&repo)?;
    let target = new_absolute_path(&path)?;
    validate_branch_name(&branch)?;
    let args: Vec<&str> = if create_branch {
        vec!["worktree", "add", "-b", branch.as_str(), target.as_str()]
    } else {
        vec!["worktree", "add", target.as_str(), branch.as_str()]
    };
    run_git_ok(&root, args)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use tempfile::TempDir;

    /// Run a setup command in `dir`, failing loudly. Test scaffolding only —
    /// the code under test never builds a command this way.
    fn git(dir: &Path, args: &[&str]) {
        let output = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .expect("git should be on PATH for these tests");
        assert!(
            output.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    /// A repository with an identity of its own, so the developer's global
    /// config (signing keys, hooks, a `user.email` they do not have) cannot
    /// decide whether these tests pass.
    fn init_repo() -> TempDir {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path();
        git(dir, &["init", "-q", "-b", "main"]);
        git(dir, &["config", "user.email", "test@example.invalid"]);
        git(dir, &["config", "user.name", "RocSpace Tests"]);
        git(dir, &["config", "commit.gpgsign", "false"]);
        // Any hooks the developer installed globally must not run here.
        git(
            dir,
            &["config", "core.hooksPath", "hooks-that-do-not-exist"],
        );
        tmp
    }

    fn write(dir: &Path, name: &str, contents: &str) {
        let path = dir.join(name);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, contents).unwrap();
    }

    /// `canonicalize` resolves the macOS `/var` → `/private/var` symlink, and
    /// the commands under test canonicalize too — so a test comparing paths has
    /// to be looking at the same spelling.
    fn repo_string(tmp: &TempDir) -> String {
        std::fs::canonicalize(tmp.path())
            .unwrap()
            .to_str()
            .unwrap()
            .to_string()
    }

    fn commit_all(dir: &Path, message: &str) {
        git(dir, &["add", "-A"]);
        git(dir, &["commit", "-q", "-m", message]);
    }

    // -- validation ------------------------------------------------------

    #[test]
    fn repo_path_rejects_a_relative_path() {
        let err = repo_path("some/relative/repo").unwrap_err();
        assert!(err.contains("must be absolute"), "got: {err}");
    }

    #[test]
    fn repo_path_rejects_a_file() {
        let tmp = TempDir::new().unwrap();
        write(tmp.path(), "notadir", "x");
        let path = tmp.path().join("notadir");
        let err = repo_path(path.to_str().unwrap()).unwrap_err();
        assert!(err.contains("not a directory"), "got: {err}");
    }

    #[test]
    fn repo_relative_rejects_traversal() {
        let err = repo_relative("../../etc/passwd").unwrap_err();
        assert!(err.contains("escapes the repository"), "got: {err}");
        let err = repo_relative("src/../../outside").unwrap_err();
        assert!(err.contains("escapes the repository"), "got: {err}");
    }

    #[test]
    fn repo_relative_rejects_absolute_and_empty() {
        assert!(repo_relative("/etc/passwd")
            .unwrap_err()
            .contains("must be relative"));
        assert!(repo_relative("").unwrap_err().contains("empty"));
    }

    #[test]
    fn repo_relative_keeps_an_ordinary_path() {
        assert_eq!(repo_relative("src/lib.rs").unwrap(), "src/lib.rs");
        // A file whose name starts with a dash is a file; `--` protects it.
        assert_eq!(repo_relative("-weird.txt").unwrap(), "-weird.txt");
    }

    #[test]
    fn nul_bytes_are_refused_everywhere() {
        assert!(repo_relative("a\0b").unwrap_err().contains("NUL"));
        assert!(validate_branch_name("a\0b").unwrap_err().contains("NUL"));
        assert!(new_absolute_path("/tmp/a\0b").unwrap_err().contains("NUL"));
    }

    #[test]
    fn branch_names_follow_check_ref_format() {
        for good in ["main", "feature/thing", "release-1.2", "origin/main"] {
            assert!(validate_branch_name(good).is_ok(), "rejected {good}");
        }
        for bad in [
            "",
            "-b",
            "--exec=rm",
            "has space",
            "has~tilde",
            "has^caret",
            "has:colon",
            "double..dot",
            "trailing.",
            "ends.lock",
            "/leading",
            "trailing/",
            "double//slash",
            ".hidden",
            "dir/.hidden",
            "@",
            "main@{1}",
        ] {
            assert!(validate_branch_name(bad).is_err(), "accepted {bad:?}");
        }
    }

    #[test]
    fn worktree_path_must_be_absolute() {
        assert!(new_absolute_path("relative/dir")
            .unwrap_err()
            .contains("must be absolute"));
    }

    // -- parsing ---------------------------------------------------------

    #[test]
    fn branch_header_shapes() {
        assert_eq!(parse_branch_header("main"), (Some("main".into()), 0, 0));
        assert_eq!(
            parse_branch_header("main...origin/main [ahead 1, behind 2]"),
            (Some("main".into()), 1, 2)
        );
        assert_eq!(
            parse_branch_header("main...origin/main [behind 7]"),
            (Some("main".into()), 0, 7)
        );
        assert_eq!(
            parse_branch_header("main...origin/main [gone]"),
            (Some("main".into()), 0, 0)
        );
        assert_eq!(
            parse_branch_header("No commits yet on main"),
            (Some("main".into()), 0, 0)
        );
        assert_eq!(parse_branch_header("HEAD (no branch)"), (None, 0, 0));
    }

    #[test]
    fn status_records_split_into_three_lists() {
        let text = "## main...origin/main [ahead 1]\0M  staged.txt\0 M dirty.txt\0MM both.txt\0?? new.txt\0D  gone.txt\0";
        let status = parse_status(text);
        assert_eq!(status.branch.as_deref(), Some("main"));
        assert_eq!(status.ahead, 1);
        assert_eq!(status.behind, 0);
        let staged: Vec<&str> = status.staged.iter().map(|e| e.path.as_str()).collect();
        assert_eq!(staged, vec!["staged.txt", "both.txt", "gone.txt"]);
        let unstaged: Vec<&str> = status.unstaged.iter().map(|e| e.path.as_str()).collect();
        assert_eq!(unstaged, vec!["dirty.txt", "both.txt"]);
        assert_eq!(status.untracked.len(), 1);
        assert_eq!(status.untracked[0].status, GitFileStatus::Untracked);
        assert_eq!(status.staged[2].status, GitFileStatus::Deleted);
    }

    #[test]
    fn a_rename_consumes_its_origin_record() {
        // Without consuming `old.txt`, it would be read as the next status line
        // and the file after it would vanish.
        let text = "## main\0R  new.txt\0old.txt\0 M after.txt\0";
        let status = parse_status(text);
        assert_eq!(status.staged.len(), 1);
        assert_eq!(status.staged[0].path, "new.txt");
        assert_eq!(status.staged[0].status, GitFileStatus::Renamed);
        // …and keeps it: the old name is what says a credential was moved.
        assert_eq!(status.staged[0].origin_path.as_deref(), Some("old.txt"));
        assert_eq!(status.unstaged.len(), 1);
        assert_eq!(status.unstaged[0].path, "after.txt");
        assert_eq!(status.unstaged[0].origin_path, None);
    }

    /// End to end, because the record ORDER is the part a unit test can get
    /// wrong: `-z` puts the new path in the status record and the origin in the
    /// one after it, which is the opposite way round from the human format's
    /// `R  old -> new`.
    #[tokio::test]
    async fn a_renamed_file_reports_where_it_came_from() {
        let tmp = init_repo();
        let repo = repo_string(&tmp);
        write(
            tmp.path(),
            "secrets/id_rsa",
            "-----BEGIN PRIVATE KEY-----\n",
        );
        commit_all(tmp.path(), "init");
        git(tmp.path(), &["mv", "secrets/id_rsa", "notes.txt"]);
        git(tmp.path(), &["add", "-A"]);

        let status = git_status(repo).await.unwrap();
        assert_eq!(status.staged.len(), 1);
        assert_eq!(status.staged[0].path, "notes.txt");
        assert_eq!(status.staged[0].status, GitFileStatus::Renamed);
        assert_eq!(
            status.staged[0].origin_path.as_deref(),
            Some("secrets/id_rsa")
        );
    }

    #[test]
    fn unmerged_entries_are_one_word() {
        let text = "## main\0UU both.txt\0AA added.txt\0DD deleted.txt\0";
        let status = parse_status(text);
        assert!(status.staged.is_empty());
        assert_eq!(status.unstaged.len(), 3);
        assert!(status
            .unstaged
            .iter()
            .all(|e| e.status == GitFileStatus::Conflicted));
    }

    #[test]
    fn branch_list_drops_the_remote_head_pointer() {
        let text = "*\trefs/heads/main\n \trefs/heads/topic\n \trefs/remotes/origin/HEAD\n \trefs/remotes/origin/main\n";
        let branches = parse_branches(text);
        assert_eq!(branches.len(), 3);
        assert_eq!(branches[0].name, "main");
        assert!(branches[0].is_current);
        assert!(!branches[0].is_remote);
        assert_eq!(branches[2].name, "origin/main");
        assert!(branches[2].is_remote);
        assert!(!branches[2].is_current);
    }

    // -- the commands, against real repositories -------------------------

    #[tokio::test]
    async fn status_reports_a_fresh_repository() {
        let tmp = init_repo();
        write(tmp.path(), "a.txt", "hello\n");
        let status = git_status(repo_string(&tmp)).await.unwrap();
        assert_eq!(status.branch.as_deref(), Some("main"));
        assert_eq!(status.untracked.len(), 1);
        assert_eq!(status.untracked[0].path, "a.txt");
    }

    /// The workspace-is-a-subdirectory case, which is most of them: a project
    /// opened at `repo/apps/web`, or at the `src` of a monorepo.
    ///
    /// Every command has to run from the ROOT, because that is the only place
    /// the paths `git status` hands out mean what they say. Run from the
    /// subdirectory, `add` fails outright, `diff` silently returns nothing, and
    /// `reset` reports success while doing nothing — three different wrong
    /// answers to the same mistake, which is why this is one test.
    #[tokio::test]
    async fn commands_run_from_the_root_when_the_workspace_is_a_subdirectory() {
        let tmp = init_repo();
        write(tmp.path(), "sub/a.txt", "hello\n");
        let subdir = std::fs::canonicalize(tmp.path().join("sub"))
            .unwrap()
            .to_str()
            .unwrap()
            .to_string();

        // Root-relative, exactly as it would be from the repository itself.
        let status = git_status(subdir.clone()).await.unwrap();
        assert_eq!(status.untracked.len(), 1);
        assert_eq!(status.untracked[0].path, "sub/a.txt");

        // …and that same string round-trips through every mutation.
        git_stage(subdir.clone(), vec!["sub/a.txt".into()])
            .await
            .unwrap();
        let status = git_status(subdir.clone()).await.unwrap();
        assert_eq!(status.staged.len(), 1);
        assert_eq!(status.staged[0].path, "sub/a.txt");

        let diff = git_diff(subdir.clone(), "sub/a.txt".into(), true)
            .await
            .unwrap();
        assert!(diff.contains("+hello"), "got: {diff}");

        git_unstage(subdir.clone(), vec!["sub/a.txt".into()])
            .await
            .unwrap();
        let status = git_status(subdir).await.unwrap();
        assert!(status.staged.is_empty());
        assert_eq!(status.untracked.len(), 1);
    }

    /// A linked worktree is its own root even though it sits inside no `.git`
    /// directory of its own — RocSpace is developed in one, so this is the path
    /// the app takes every day.
    #[tokio::test]
    async fn a_subdirectory_of_a_linked_worktree_resolves_to_the_worktree() {
        let tmp = init_repo();
        let repo = repo_string(&tmp);
        write(tmp.path(), "a.txt", "hello\n");
        commit_all(tmp.path(), "init");

        let elsewhere = TempDir::new().unwrap();
        let target = elsewhere.path().join("wt");
        git_worktree_add(
            repo,
            target.to_str().unwrap().to_string(),
            "wt-branch".into(),
            true,
        )
        .await
        .unwrap();

        write(&target, "deep/b.txt", "beta\n");
        let deep = std::fs::canonicalize(target.join("deep"))
            .unwrap()
            .to_str()
            .unwrap()
            .to_string();

        let status = git_status(deep.clone()).await.unwrap();
        // The worktree's branch, not the main checkout's — proof the walk
        // stopped at the `.git` FILE rather than climbing past it.
        assert_eq!(status.branch.as_deref(), Some("wt-branch"));
        assert_eq!(status.untracked[0].path, "deep/b.txt");
        git_stage(deep, vec!["deep/b.txt".into()]).await.unwrap();
    }

    /// A directory in no repository keeps git's own sentence, which is the one
    /// that tells the user what to do about it.
    #[tokio::test]
    async fn a_directory_that_is_not_a_repository_reports_gits_own_words() {
        let tmp = TempDir::new().unwrap();
        let err = git_status(repo_string(&tmp)).await.unwrap_err();
        assert!(err.contains("not a git repository"), "got: {err}");
    }

    #[tokio::test]
    async fn stage_then_unstage_moves_a_file_between_the_lists() {
        let tmp = init_repo();
        let repo = repo_string(&tmp);
        write(tmp.path(), "a.txt", "hello\n");

        git_stage(repo.clone(), vec!["a.txt".into()]).await.unwrap();
        let status = git_status(repo.clone()).await.unwrap();
        assert_eq!(status.staged.len(), 1);
        assert_eq!(status.staged[0].status, GitFileStatus::Added);
        assert!(status.untracked.is_empty());

        // The unborn-HEAD case: `git restore --staged` would fail here.
        git_unstage(repo.clone(), vec!["a.txt".into()])
            .await
            .unwrap();
        let status = git_status(repo).await.unwrap();
        assert!(status.staged.is_empty());
        assert_eq!(status.untracked.len(), 1);
    }

    /// A path is a NAME. `*.txt` is a file called `*.txt`, and staging it must
    /// not sweep up its neighbours — the row the user clicked is the file they
    /// meant, and `--` does nothing about pathspec magic.
    #[tokio::test]
    async fn a_file_named_like_a_glob_stages_only_itself() {
        let tmp = init_repo();
        let repo = repo_string(&tmp);
        write(tmp.path(), "*.txt", "star\n");
        write(tmp.path(), "one.txt", "one\n");
        write(tmp.path(), "two.txt", "two\n");

        git_stage(repo.clone(), vec!["*.txt".into()]).await.unwrap();
        let status = git_status(repo.clone()).await.unwrap();
        let staged: Vec<&str> = status.staged.iter().map(|e| e.path.as_str()).collect();
        assert_eq!(staged, vec!["*.txt"]);
        assert_eq!(status.untracked.len(), 2);

        let diff = git_diff(repo.clone(), "*.txt".into(), true).await.unwrap();
        assert!(diff.contains("+star"), "got: {diff}");
        // `one`/`two` never entered the index, so they cannot be in the diff.
        assert!(!diff.contains("+one"), "got: {diff}");

        git_unstage(repo.clone(), vec!["*.txt".into()])
            .await
            .unwrap();
        let status = git_status(repo).await.unwrap();
        assert!(status.staged.is_empty());
    }

    /// The other half: a leading colon is git's magic-pathspec prefix, so a file
    /// called `:weird.txt` could not be staged at all.
    #[tokio::test]
    async fn a_file_named_with_a_magic_prefix_can_still_be_staged() {
        let tmp = init_repo();
        let repo = repo_string(&tmp);
        for name in [":weird.txt", "!bang.txt"] {
            write(tmp.path(), name, "contents\n");
            git_stage(repo.clone(), vec![name.to_string()])
                .await
                .unwrap();
            let status = git_status(repo.clone()).await.unwrap();
            assert_eq!(status.staged.len(), 1, "{name}");
            assert_eq!(status.staged[0].path, name);
            git_unstage(repo.clone(), vec![name.to_string()])
                .await
                .unwrap();
            std::fs::remove_file(tmp.path().join(name)).unwrap();
        }
    }

    /// `git reset` exits 0 for a pathspec that matches nothing, so this is the
    /// one mutation in the file that could report success having done nothing.
    #[tokio::test]
    async fn unstaging_something_that_is_not_staged_is_an_error() {
        let tmp = init_repo();
        let repo = repo_string(&tmp);
        write(tmp.path(), "a.txt", "hello\n");
        commit_all(tmp.path(), "init");
        write(tmp.path(), "a.txt", "changed\n");

        // Modified but NOT staged: `reset` would have said nothing.
        let err = git_unstage(repo.clone(), vec!["a.txt".into()])
            .await
            .unwrap_err();
        assert!(err.contains("nothing staged matches"), "got: {err}");
        assert!(err.contains("a.txt"), "got: {err}");

        // A file that does not exist at all is the same answer.
        let err = git_unstage(repo, vec!["never/existed.txt".into()])
            .await
            .unwrap_err();
        assert!(err.contains("nothing staged matches"), "got: {err}");
    }

    /// …and the check must not reject the rows that ARE staged, including the
    /// two whose paths are absent from the index or the working tree.
    #[tokio::test]
    async fn unstaging_still_works_for_a_deletion_and_a_rename() {
        let tmp = init_repo();
        let repo = repo_string(&tmp);
        write(tmp.path(), "gone.txt", "bye\n");
        write(tmp.path(), "old.txt", "move me\n");
        commit_all(tmp.path(), "init");

        std::fs::remove_file(tmp.path().join("gone.txt")).unwrap();
        git(tmp.path(), &["mv", "old.txt", "new.txt"]);
        git(tmp.path(), &["add", "-A"]);

        // A deletion's path is in neither the index nor the working tree, which
        // is why `ls-files --error-unmatch` is the wrong check for it.
        git_unstage(repo.clone(), vec!["gone.txt".into()])
            .await
            .unwrap();
        // A rename is TWO index entries and git reports it as one row, so both
        // spellings have to pass the check — the new path the panel holds and
        // the origin path that undoing the move puts back.
        git_unstage(repo.clone(), vec!["new.txt".into(), "old.txt".into()])
            .await
            .unwrap();
        let status = git_status(repo).await.unwrap();
        assert!(status.staged.is_empty(), "{:?}", status.staged);
    }

    #[tokio::test]
    async fn staging_a_deletion_records_the_removal() {
        let tmp = init_repo();
        let repo = repo_string(&tmp);
        write(tmp.path(), "a.txt", "hello\n");
        commit_all(tmp.path(), "init");
        std::fs::remove_file(tmp.path().join("a.txt")).unwrap();

        git_stage(repo.clone(), vec!["a.txt".into()]).await.unwrap();
        let status = git_status(repo).await.unwrap();
        assert_eq!(status.staged.len(), 1);
        assert_eq!(status.staged[0].status, GitFileStatus::Deleted);
    }

    #[tokio::test]
    async fn diff_reads_the_working_tree_and_the_index_separately() {
        let tmp = init_repo();
        let repo = repo_string(&tmp);
        write(tmp.path(), "a.txt", "one\n");
        commit_all(tmp.path(), "init");

        write(tmp.path(), "a.txt", "two\n");
        git_stage(repo.clone(), vec!["a.txt".into()]).await.unwrap();
        write(tmp.path(), "a.txt", "three\n");

        let staged = git_diff(repo.clone(), "a.txt".into(), true).await.unwrap();
        assert!(staged.contains("-one"), "got: {staged}");
        assert!(staged.contains("+two"), "got: {staged}");

        let unstaged = git_diff(repo, "a.txt".into(), false).await.unwrap();
        assert!(unstaged.contains("-two"), "got: {unstaged}");
        assert!(unstaged.contains("+three"), "got: {unstaged}");
    }

    #[tokio::test]
    async fn an_untracked_file_gets_a_synthesized_diff() {
        let tmp = init_repo();
        let repo = repo_string(&tmp);
        write(tmp.path(), "new.txt", "alpha\nbeta\n");

        let diff = git_diff(repo, "new.txt".into(), false).await.unwrap();
        assert!(diff.contains("new file mode"), "got: {diff}");
        assert!(diff.contains("--- /dev/null"), "got: {diff}");
        assert!(diff.contains("@@ -0,0 +1,2 @@"), "got: {diff}");
        assert!(diff.contains("+alpha\n+beta\n"), "got: {diff}");
    }

    #[tokio::test]
    async fn an_untracked_binary_file_says_so_rather_than_returning_bytes() {
        let tmp = init_repo();
        let repo = repo_string(&tmp);
        std::fs::write(tmp.path().join("blob.bin"), [0xff, 0xfe, 0x00, 0x80]).unwrap();

        let diff = git_diff(repo, "blob.bin".into(), false).await.unwrap();
        assert!(diff.contains("Binary files"), "got: {diff}");
    }

    #[tokio::test]
    async fn an_untracked_file_with_no_trailing_newline_is_marked() {
        let tmp = init_repo();
        let repo = repo_string(&tmp);
        write(tmp.path(), "new.txt", "no newline");

        let diff = git_diff(repo, "new.txt".into(), false).await.unwrap();
        assert!(diff.contains("\\ No newline at end of file"), "got: {diff}");
    }

    /// The synthesized diff is the only code in the module that reads a file
    /// itself, so it is the only code that can be made to read the WRONG one.
    /// An untracked symlink shows the link, never what it points at — which is
    /// both what git does and the difference between a diff and a disclosure.
    #[cfg(unix)]
    #[tokio::test]
    async fn an_untracked_symlink_shows_the_link_not_what_it_points_at() {
        let tmp = init_repo();
        let repo = repo_string(&tmp);

        let secrets = TempDir::new().unwrap();
        let outside = secrets.path().join("id_rsa");
        std::fs::write(&outside, "-----BEGIN PRIVATE KEY-----\nhunter2\n").unwrap();
        std::os::unix::fs::symlink(&outside, tmp.path().join("notes.txt")).unwrap();

        let diff = git_diff(repo, "notes.txt".into(), false).await.unwrap();
        assert!(!diff.contains("hunter2"), "read through the link: {diff}");
        assert!(!diff.contains("BEGIN PRIVATE KEY"), "got: {diff}");
        // Rendered the way git renders a link: the mode says symlink and the
        // target path is the content.
        assert!(diff.contains("new file mode 120000"), "got: {diff}");
        assert!(
            diff.contains(&format!("+{}", outside.display())),
            "got: {diff}"
        );
    }

    /// The same escape one level up: git never descends through a symlinked
    /// directory, so `git status` cannot produce this path — but `git_diff` is
    /// a command, and a command takes what it is given.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_path_through_a_symlinked_directory_is_refused() {
        let tmp = init_repo();
        let repo = repo_string(&tmp);

        let secrets = TempDir::new().unwrap();
        std::fs::write(secrets.path().join("id_rsa"), "hunter2\n").unwrap();
        std::os::unix::fs::symlink(secrets.path(), tmp.path().join("link")).unwrap();

        let err = git_diff(repo, "link/id_rsa".into(), false)
            .await
            .unwrap_err();
        assert!(err.contains("escapes the repository"), "got: {err}");
    }

    /// …and a symlink that stays INSIDE the repository still renders, so the
    /// guard above is a rule about escaping and not a ban on links.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_symlink_inside_the_repository_still_diffs() {
        let tmp = init_repo();
        let repo = repo_string(&tmp);
        write(tmp.path(), "real/a.txt", "alpha\n");
        std::os::unix::fs::symlink("real", tmp.path().join("aliased")).unwrap();

        let diff = git_diff(repo, "aliased/a.txt".into(), false).await.unwrap();
        assert!(diff.contains("+alpha"), "got: {diff}");
    }

    #[tokio::test]
    async fn commit_returns_the_short_sha() {
        let tmp = init_repo();
        let repo = repo_string(&tmp);
        write(tmp.path(), "a.txt", "hello\n");
        git_stage(repo.clone(), vec!["a.txt".into()]).await.unwrap();

        let sha = git_commit(repo.clone(), "feat: a file".into())
            .await
            .unwrap();
        assert!(
            sha.len() >= 7 && sha.chars().all(|c| c.is_ascii_hexdigit()),
            "got: {sha}"
        );
        let status = git_status(repo).await.unwrap();
        assert!(status.staged.is_empty());
    }

    #[tokio::test]
    async fn commit_refuses_an_empty_message_without_running_git() {
        let tmp = init_repo();
        let err = git_commit(repo_string(&tmp), "   \n".into())
            .await
            .unwrap_err();
        assert!(err.contains("needs a message"), "got: {err}");
    }

    #[tokio::test]
    async fn commit_surfaces_gits_own_refusal() {
        let tmp = init_repo();
        write(tmp.path(), "a.txt", "hello\n");
        commit_all(tmp.path(), "init");
        // Nothing staged. Git says so on stdout, with a non-zero exit.
        let err = git_commit(repo_string(&tmp), "nothing here".into())
            .await
            .unwrap_err();
        assert!(err.contains("nothing to commit"), "got: {err}");
    }

    #[tokio::test]
    async fn branches_and_checkout_round_trip() {
        let tmp = init_repo();
        let repo = repo_string(&tmp);
        write(tmp.path(), "a.txt", "hello\n");
        commit_all(tmp.path(), "init");

        git_checkout(repo.clone(), "topic".into(), true)
            .await
            .unwrap();
        let branches = git_branches(repo.clone()).await.unwrap();
        let names: Vec<&str> = branches.iter().map(|b| b.name.as_str()).collect();
        assert!(
            names.contains(&"main") && names.contains(&"topic"),
            "{names:?}"
        );
        assert_eq!(
            branches
                .iter()
                .find(|b| b.is_current)
                .map(|b| b.name.as_str()),
            Some("topic")
        );

        git_checkout(repo.clone(), "main".into(), false)
            .await
            .unwrap();
        let status = git_status(repo).await.unwrap();
        assert_eq!(status.branch.as_deref(), Some("main"));
    }

    #[tokio::test]
    async fn a_detached_head_reports_its_short_sha() {
        let tmp = init_repo();
        let repo = repo_string(&tmp);
        write(tmp.path(), "a.txt", "hello\n");
        commit_all(tmp.path(), "init");
        git(tmp.path(), &["checkout", "-q", "--detach", "HEAD"]);

        let status = git_status(repo).await.unwrap();
        let branch = status
            .branch
            .expect("a detached HEAD still says where it is");
        assert_eq!(branch.len(), 7, "got: {branch}");
        assert!(
            branch.chars().all(|c| c.is_ascii_hexdigit()),
            "got: {branch}"
        );
    }

    #[tokio::test]
    async fn worktree_add_creates_a_second_checkout_on_a_new_branch() {
        let tmp = init_repo();
        let repo = repo_string(&tmp);
        write(tmp.path(), "a.txt", "hello\n");
        commit_all(tmp.path(), "init");

        let elsewhere = TempDir::new().unwrap();
        let target = elsewhere.path().join("wt");
        git_worktree_add(
            repo,
            target.to_str().unwrap().to_string(),
            "wt-branch".into(),
            true,
        )
        .await
        .unwrap();

        assert!(target.join("a.txt").is_file());
        let status = git_status(target.to_str().unwrap().to_string())
            .await
            .unwrap();
        assert_eq!(status.branch.as_deref(), Some("wt-branch"));
    }

    #[tokio::test]
    async fn worktree_add_refuses_a_relative_target() {
        let tmp = init_repo();
        let err = git_worktree_add(
            repo_string(&tmp),
            "relative/wt".into(),
            "wt-branch".into(),
            true,
        )
        .await
        .unwrap_err();
        assert!(err.contains("must be absolute"), "got: {err}");
    }

    // -- the two rules that are the whole point --------------------------

    #[tokio::test]
    async fn no_argument_reaches_a_shell() {
        let tmp = init_repo();
        let repo = repo_string(&tmp);
        let canary = tmp.path().join("pwned.txt");

        // Every metacharacter that would matter if any of this went through
        // `sh -c`. Each one is passed as a single argv entry, so git looks for
        // a pathspec / a branch with that literal name and says it does not
        // exist. Nothing runs.
        let injections = [
            "a.txt; touch pwned.txt",
            "a.txt && touch pwned.txt",
            "$(touch pwned.txt)",
            "`touch pwned.txt`",
            "a.txt | touch pwned.txt",
            "a.txt\ntouch pwned.txt",
        ];
        for injection in injections {
            let _ = git_stage(repo.clone(), vec![injection.to_string()]).await;
            let _ = git_diff(repo.clone(), injection.to_string(), false).await;
            let _ = git_unstage(repo.clone(), vec![injection.to_string()]).await;
            let _ = git_commit(repo.clone(), injection.to_string()).await;
            let _ = git_checkout(repo.clone(), injection.to_string(), true).await;
            assert!(
                !canary.exists(),
                "a shell ran something for input {injection:?}"
            );
        }
    }

    #[tokio::test]
    async fn a_filename_full_of_metacharacters_is_just_a_filename() {
        let tmp = init_repo();
        let repo = repo_string(&tmp);
        // The proof that the injection test above is testing the right thing:
        // these bytes are handled LITERALLY, not escaped away.
        let name = "we;ird $(x) `y` |z.txt";
        write(tmp.path(), name, "contents\n");

        git_stage(repo.clone(), vec![name.to_string()])
            .await
            .unwrap();
        let status = git_status(repo.clone()).await.unwrap();
        assert_eq!(status.staged.len(), 1);
        assert_eq!(status.staged[0].path, name);

        let diff = git_diff(repo, name.to_string(), true).await.unwrap();
        assert!(diff.contains("+contents"), "got: {diff}");
    }

    #[tokio::test]
    async fn a_repository_path_with_spaces_works() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("my repo (v2)");
        std::fs::create_dir(&dir).unwrap();
        git(&dir, &["init", "-q", "-b", "main"]);
        write(&dir, "a.txt", "hello\n");

        let status = git_status(dir.to_str().unwrap().to_string()).await.unwrap();
        assert_eq!(status.untracked.len(), 1);
    }

    #[test]
    fn output_over_the_cap_is_an_error_not_a_truncation() {
        let tmp = init_repo();
        write(
            tmp.path(),
            "a.txt",
            "one line that is comfortably over ten bytes\n",
        );
        let root = std::fs::canonicalize(tmp.path()).unwrap();

        // A tiny limit rather than eleven megabytes: the rule is the same and
        // the test is a millisecond.
        let err = run_git_limited(&root, ["status", "--porcelain"], 8).unwrap_err();
        assert!(err.contains("more than 8 bytes"), "got: {err}");

        // …and the same call under a limit it fits in still works, so the test
        // above is measuring the cap and not a broken command.
        let ok = run_git_limited(&root, ["status", "--porcelain"], 4096).unwrap();
        assert!(ok.success);
        assert!(String::from_utf8_lossy(&ok.stdout).contains("a.txt"));
    }

    #[test]
    fn the_public_cap_is_ten_megabytes() {
        assert_eq!(MAX_OUTPUT_BYTES, 10 * 1024 * 1024);
    }

    #[tokio::test]
    async fn commands_refuse_a_relative_repository() {
        let relative = "not/absolute".to_string();
        assert!(git_status(relative.clone()).await.is_err());
        assert!(git_diff(relative.clone(), "a.txt".into(), false)
            .await
            .is_err());
        assert!(git_stage(relative.clone(), vec!["a.txt".into()])
            .await
            .is_err());
        assert!(git_unstage(relative.clone(), vec!["a.txt".into()])
            .await
            .is_err());
        assert!(git_commit(relative.clone(), "m".into()).await.is_err());
        assert!(git_branches(relative.clone()).await.is_err());
        assert!(git_checkout(relative.clone(), "main".into(), false)
            .await
            .is_err());
        assert!(
            git_worktree_add(relative, "/tmp/wt".into(), "b".into(), true)
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn diff_refuses_a_path_outside_the_repository() {
        let tmp = init_repo();
        let err = git_diff(repo_string(&tmp), "../../../etc/passwd".into(), false)
            .await
            .unwrap_err();
        assert!(err.contains("escapes the repository"), "got: {err}");
    }
}
