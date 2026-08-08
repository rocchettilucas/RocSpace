//! The memories your agents already wrote, read where they live.
//!
//! Claude Code keeps one directory per project under `~/.claude/projects/`,
//! named after the project's absolute path with every character that is not a
//! letter or a digit replaced by `-`, and writes memories into
//! `<that>/memory/*.md`. The format is already what RocMind wants: YAML-ish
//! frontmatter (`name`, `description`, `metadata.type`), a markdown body, and
//! `[[wikilinks]]` between them.
//!
//! So this module READS. It never writes, never copies, never converts. Claude
//! Code is actively writing these files — a RocSpace-owned mirror of them would
//! disagree with the truth within a day, and the disagreement would be silent.
//! Everything below is a view of a directory somebody else owns.
//!
//! Three things are worth knowing before reading the code.
//!
//! *The slug is lossy.* `-Users-dev-Storefront--claude-worktrees-v1-1`
//! has to come back as `/Users/dev/Storefront/.claude/worktrees/v1.1`,
//! and nothing in the string says which `-` was a `/`, which was a `.` and
//! which was always a `-` (`v1.1` and `v1-1` encode identically). It is decoded
//! by walking the filesystem — see `decode_slug` — because the filesystem is
//! the only thing that knows.
//!
//! *Parsing is tolerant.* A file with no frontmatter is still a memory: its
//! name is the filename stem and its description is empty. Half a frontmatter
//! block is worth exactly the keys it has. Nothing here rejects a file, because
//! the alternative is a memory that exists on disk and not in RocMind, which is
//! the one failure the user cannot debug.
//!
//! *`MEMORY.md` is not a memory.* It is the sibling index Claude Code keeps —
//! one line per memory, a table of contents. Counting it would make every
//! project's count one too high and put a file in the tree that is a duplicate
//! of the tree itself.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Emitter, Manager};

/// Event name — mirrored in `src/lib/bindings.ts`.
pub const EVENT_ROCMIND_CHANGED: &str = "rocmind://changed";

/// How often every watched scope's memory directory is re-listed.
///
/// Two seconds, matching `git_info`. A memory is written by an agent finishing
/// a thought, not by a keystroke, so nobody notices the gap — and the poll is a
/// `read_dir` plus one `metadata` per file over a directory that holds tens of
/// files, not thousands.
const POLL_INTERVAL: Duration = Duration::from_secs(2);

/// Directory Claude Code keeps its per-project state in, relative to `$HOME`.
const PROJECTS_DIR: [&str; 2] = [".claude", "projects"];

/// Subdirectory of a project scope that holds the memories.
const MEMORY_DIR: &str = "memory";

/// The sibling index, excluded from every count and every listing. See the
/// module docs.
const INDEX_FILE: &str = "MEMORY.md";

/// The most one memory body `mind_read` will hand back.
///
/// Same shape of bound as `fs_browse`'s, for the same reason: the renderer puts
/// this in a markdown pane, and nothing good happens when a file somebody
/// redirected a build log into arrives there. Generous enough that the largest
/// real memory (a few kilobytes) is nowhere near it.
const MAX_MEMORY_BYTES: u64 = 5 * 1024 * 1024;

/// The marker a worktree scope's decoded path contains. Claude Code gives a
/// worktree its own scope, so memories written inside one are invisible to the
/// project they were made from — which is the thing RocMind's tree undoes by
/// nesting them.
const WORKTREE_MARKER: &str = "/.claude/worktrees/";

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

/// One memory file, as the tree and the list need it — everything except the
/// body.
///
/// The body is deliberately absent: a scope is 60+ files, the tree shows names
/// and descriptions, and reading every body to draw a list would be the whole
/// corpus in memory for the sake of the one file the user clicks. `mind_read`
/// fetches that one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MindMemory {
    /// The project slug this file lives under — the directory name, not the
    /// decoded path, because that is what `mind_list` and `mind_watch` take.
    pub scope: String,
    /// Absolute path to the `.md`. The handle `mind_read` takes.
    pub path: String,
    /// Frontmatter `name`, or the filename stem when there is none. This is
    /// what `[[wikilinks]]` resolve against — NOT the filename, which can
    /// differ (`type-scaling-v1.2-epic.md` is named `type-scaling-v1-2-epic`).
    pub name: String,
    /// Frontmatter `description`, `""` when absent. Written for ranking: it is
    /// a one-line summary, and search weighs it above the body for that reason.
    pub description: String,
    /// Frontmatter `metadata.type` — `user`, `feedback`, `project`,
    /// `reference` in this corpus — or `""`. Not an enum: it is somebody
    /// else's vocabulary, and a value we have not seen must not turn a memory
    /// into a parse failure.
    pub memory_type: String,
    /// `[[targets]]` in body order, de-duped. Targets are names, so they are
    /// resolved against other memories' `name`, not against filenames.
    pub links: Vec<String>,
    /// mtime in milliseconds since the epoch, like every other timestamp that
    /// crosses the IPC boundary.
    pub updated_at: i64,
    pub bytes: u64,
}

/// One project's memory directory.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MindScope {
    /// The directory name under `~/.claude/projects`, e.g.
    /// `-Users-dev-Storefront`. The scope's identity everywhere.
    pub slug: String,
    /// The slug decoded back to a real path — best effort, see `decode_slug`.
    pub project_path: String,
    /// Last path segment: `Storefront`, or a worktree's own name (`v1.1`).
    pub label: String,
    /// Whether this scope is a git worktree's rather than a repository's.
    pub is_worktree: bool,
    /// For a worktree, the repository it belongs to — which is what lets the
    /// tree nest it under that project instead of listing it beside it.
    pub root_path: Option<String>,
    /// Memories in it, excluding `MEMORY.md`.
    pub count: usize,
}

// ---------------------------------------------------------------------------
// Where the memories are
// ---------------------------------------------------------------------------

/// `~/.claude/projects`, or `None` when the home directory is unknowable.
///
/// Every public entry point resolves this once and passes it down, so the whole
/// module below is a pure function of a root directory — which is what lets the
/// tests point it at a tempdir instead of mutating the process's `HOME`.
pub fn projects_root() -> Option<PathBuf> {
    let mut path = home_dir()?;
    for segment in PROJECTS_DIR {
        path.push(segment);
    }
    Some(path)
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

// ---------------------------------------------------------------------------
// Slug <-> path
// ---------------------------------------------------------------------------

/// A path as Claude Code spells it in a directory name.
///
/// Every character that is not a letter or a digit becomes `-`, one for one.
/// Verified against the corpus on this machine, which contains all three of the
/// interesting cases: `/` (every slug), `.` (`.claude`, `v1.1`) and a space
/// (`Acme Site` → `-Acme-Site`).
///
/// This is somebody else's encoding, reproduced — so it is a GUESS about the
/// characters the corpus does not happen to contain, and it is used in exactly
/// one place where a wrong guess is survivable: naming the scope of a project
/// that has no memories yet, so the watcher can be on it before the first one
/// is written. Reading an existing scope never goes through here; `decode_slug`
/// asks the filesystem, and `match_len` is deliberately looser than this.
pub fn encode_path(path: &str) -> String {
    path.chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect()
}

/// The path a scope slug came from.
///
/// The encoding maps three different characters onto `-`, so the string alone
/// cannot be decoded: `v1-1` is both `v1.1` and `v1-1`, and the corpus on this
/// machine contains a worktree called `v1.1` sitting next to one called
/// `v1.2-type-scaling`. Guessing wrong is not cosmetic — it decides the label
/// in the tree and whether the scope is recognised as a worktree at all.
///
/// So it is decoded against the filesystem: walk down from `/`, and at each
/// step take the child directory whose own encoded name is a prefix of what is
/// left. Longest match first, with backtracking, because `Storefront` and
/// `Storefront-v2` can both be prefixes of the same remainder and only one of them
/// leads anywhere.
///
/// Falls back to `naive_decode` when the walk runs out — a project that has
/// been deleted or is on an unmounted volume still has memories worth showing,
/// and a best-effort path is a better answer than no scope at all.
pub fn decode_slug(slug: &str) -> String {
    let Some(rest) = slug.strip_prefix('-') else {
        // Not a POSIX absolute path — a Windows slug (`C--Users-…`), or
        // something hand-made. Nothing to walk down from.
        return naive_decode(slug);
    };
    match walk_down(Path::new("/"), rest) {
        Some(path) => path.to_string_lossy().into_owned(),
        None => naive_decode(slug),
    }
}

/// One step of `decode_slug`'s descent: find the child of `dir` that `rest`
/// starts with, and recurse on what is left.
fn walk_down(dir: &Path, rest: &str) -> Option<PathBuf> {
    if rest.is_empty() {
        return Some(dir.to_path_buf());
    }
    // (encoded length, name) for every child whose encoded name is a prefix of
    // `rest` ending on a `-` boundary — a child called `Gas` must not match the
    // slug of `Storefront`.
    let mut candidates: Vec<(usize, PathBuf)> = Vec::new();
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        // `entry.path().is_dir()` rather than `entry.file_type()`, because the
        // latter does not follow symlinks and `/var` is one on macOS. Refusing
        // to walk through it puts every path under `/var/folders` — which is
        // where a tempdir lives, and where a scope on this machine really is —
        // on the fallback decode.
        if !entry.path().is_dir() {
            continue;
        }
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if let Some(len) = match_len(rest, name) {
            candidates.push((len, entry.path()));
        }
    }
    // Longest first: a directory whose name accounts for more of the slug is
    // the better guess, and the shorter one is still tried if it leads nowhere.
    candidates.sort_by_key(|candidate| std::cmp::Reverse(candidate.0));
    for (len, path) in candidates {
        let remainder = if len == rest.len() {
            ""
        } else {
            &rest[len + 1..]
        };
        if let Some(found) = walk_down(&path, remainder) {
            return Some(found);
        }
    }
    None
}

/// How much of `rest` the directory called `name` accounts for, as a byte index
/// into `rest`, or `None` when it is not a prefix of it.
///
/// Character by character rather than by re-encoding the name and comparing
/// strings, and looser than `encode_path` on purpose: a `-` in the slug matches
/// ANY character that is not a letter or a digit, while everything else has to
/// match exactly. That way a directory whose name contains a character Claude
/// Code turns out to leave alone (an underscore, an accented letter) is still
/// found, and so is one whose character it replaces — this function does not
/// have to know which, and getting it wrong here would mislabel a scope.
///
/// The match must end on a `-` boundary or at the end of the slug: `Gas` is not
/// a prefix of `Storefront`'s slug, it is a different directory.
fn match_len(rest: &str, name: &str) -> Option<usize> {
    let mut chars = rest.char_indices();
    for expected in name.chars() {
        let (_, actual) = chars.next()?;
        if actual == expected {
            continue;
        }
        if actual == '-' && !expected.is_ascii_alphanumeric() {
            continue;
        }
        return None;
    }
    match chars.next() {
        None => Some(rest.len()),
        Some((at, '-')) => Some(at),
        Some(_) => None,
    }
}

/// The decode for a scope whose directory is no longer on this machine.
///
/// Every `-` becomes `/`, except one that immediately follows a `/` we just
/// wrote — that is the `/.` of `/.claude`, which is the only place a dot
/// reliably appears in these paths. Wrong for a directory with a hyphen in its
/// name, and knowingly so: there is nothing left to check it against.
fn naive_decode(slug: &str) -> String {
    let mut out = String::with_capacity(slug.len());
    let mut after_separator = false;
    for ch in slug.chars() {
        if ch == '-' {
            if after_separator {
                out.push('.');
                after_separator = false;
            } else {
                out.push('/');
                after_separator = true;
            }
        } else {
            out.push(ch);
            after_separator = false;
        }
    }
    out
}

/// Last segment of a decoded path, or the path itself when it has none.
fn label_of(path: &str) -> String {
    path.rsplit('/')
        .find(|segment| !segment.is_empty())
        .unwrap_or(path)
        .to_string()
}

/// The repository a worktree scope belongs to, or `None` for an ordinary
/// project.
fn root_of(path: &str) -> Option<String> {
    let at = path.find(WORKTREE_MARKER)?;
    Some(path[..at].to_string())
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/// What one memory file's frontmatter said, and where its body starts.
#[derive(Debug, Default, PartialEq, Eq)]
struct Frontmatter {
    name: Option<String>,
    description: Option<String>,
    memory_type: Option<String>,
}

/// Split a memory file into its frontmatter and its body.
///
/// The shape is fixed — a `---` fence, `key: value` lines, one nested
/// `metadata:` block — so this is a line reader rather than a YAML dependency.
/// A YAML crate would also be *stricter* than this corpus deserves: the files
/// are written by a model, and one that emits an unquoted value with a colon in
/// it must not lose its memory to a parse error.
///
/// A file with no opening fence, or with an opening fence and no closing one,
/// is all body. The second case matters: a truncated write (an agent killed
/// mid-file) should read as a memory with no metadata, not as a file whose
/// entire contents are frontmatter.
fn split_frontmatter(text: &str) -> (Frontmatter, &str) {
    // A UTF-8 BOM ahead of the fence is invisible in an editor and would
    // otherwise make the first line something other than `---`.
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let Some(after_open) = strip_fence(text) else {
        return (Frontmatter::default(), text);
    };
    let Some((block, body)) = split_at_closing_fence(after_open) else {
        return (Frontmatter::default(), text);
    };
    (parse_frontmatter(block), body)
}

/// Consume an opening `---` line, returning what follows it.
fn strip_fence(text: &str) -> Option<&str> {
    let (first, rest) = match text.split_once('\n') {
        Some((first, rest)) => (first, rest),
        // A file that is nothing but `---` has no frontmatter and no body.
        None => (text, ""),
    };
    if first.trim_end_matches('\r').trim() == "---" {
        Some(rest)
    } else {
        None
    }
}

/// Find the closing `---`, returning (frontmatter block, body).
fn split_at_closing_fence(after_open: &str) -> Option<(&str, &str)> {
    let mut offset = 0usize;
    for line in after_open.split_inclusive('\n') {
        if line.trim_end_matches(['\r', '\n']).trim() == "---" {
            return Some((&after_open[..offset], &after_open[offset + line.len()..]));
        }
        offset += line.len();
    }
    None
}

/// Read `key: value` lines, plus the one nested block that matters.
///
/// Indentation is the whole of the nesting rule: an indented line belongs to
/// the last top-level key that had no value of its own. Only `metadata` is
/// looked at inside, and only `type` within it — anything else Claude Code
/// records there (`node_type`, `originSessionId`, `modified`) is real data
/// about somebody else's system, and reading it would be inventing a contract.
fn parse_frontmatter(block: &str) -> Frontmatter {
    let mut found = Frontmatter::default();
    let mut in_metadata = false;
    for line in block.lines() {
        let trimmed = line.trim_end_matches('\r');
        if trimmed.trim().is_empty() {
            continue;
        }
        let indented = trimmed.starts_with(' ') || trimmed.starts_with('\t');
        let Some((key, value)) = trimmed.split_once(':') else {
            continue;
        };
        let key = key.trim();
        let value = unquote(value.trim());

        if indented {
            if in_metadata && key == "type" && !value.is_empty() {
                found.memory_type = Some(value);
            }
            continue;
        }

        // A top-level key ends whatever block was open, whether or not it opens
        // one of its own.
        in_metadata = key == "metadata";
        match key {
            "name" if !value.is_empty() => found.name = Some(value),
            "description" if !value.is_empty() => found.description = Some(value),
            _ => {}
        }
    }
    found
}

/// Strip one layer of matching quotes. `"a: b"` is one value, not a key and a
/// value; the quotes are YAML's and mean nothing downstream.
fn unquote(value: &str) -> String {
    for quote in ['"', '\''] {
        if value.len() >= 2 && value.starts_with(quote) && value.ends_with(quote) {
            return value[1..value.len() - 1].to_string();
        }
    }
    value.to_string()
}

/// Every `[[target]]` in `body`, in order, de-duped.
///
/// Deliberately not clever about context. A link inside a code fence counts,
/// because "is this line code?" is a markdown question this parser does not
/// otherwise ask, and getting it wrong in the other direction — dropping a real
/// link because it happened to sit in an indented block — costs an edge in the
/// graph that the corpus really has.
///
/// Empty targets are dropped: `[[]]` is not a link to a memory called nothing.
fn extract_links(body: &str) -> Vec<String> {
    let mut links: Vec<String> = Vec::new();
    let mut at = 0usize;
    while let Some(open) = body[at..].find("[[") {
        let start = at + open + 2;
        let Some(close) = body[start..].find("]]") else {
            break;
        };
        let target = body[start..start + close].trim().to_string();
        at = start + close + 2;
        if target.is_empty() || links.contains(&target) {
            continue;
        }
        links.push(target);
    }
    links
}

/// Parse one memory file's contents into everything but its path.
fn parse_memory(stem: &str, text: &str) -> (String, String, String, Vec<String>) {
    let (front, body) = split_frontmatter(text);
    (
        front.name.unwrap_or_else(|| stem.to_string()),
        front.description.unwrap_or_default(),
        front.memory_type.unwrap_or_default(),
        extract_links(body),
    )
}

// ---------------------------------------------------------------------------
// Reading the corpus
// ---------------------------------------------------------------------------

/// `<root>/<slug>/memory`.
fn memory_dir(root: &Path, slug: &str) -> PathBuf {
    root.join(slug).join(MEMORY_DIR)
}

/// Is this directory entry a memory? A `.md` that is not the index.
fn is_memory_file(name: &str) -> bool {
    name.len() > 3
        && name.to_ascii_lowercase().ends_with(".md")
        && !name.eq_ignore_ascii_case(INDEX_FILE)
}

/// mtime as milliseconds since the epoch; 0 when the filesystem will not say.
fn mtime_ms(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Every scope under `root` that holds at least one memory.
///
/// Scopes with an empty (or missing) `memory/` directory are left out
/// deliberately: `~/.claude/projects` has an entry for every directory a Claude
/// Code session has ever been started in — a tempdir, a one-off clone — and
/// listing those would bury the handful of projects that have a corpus.
///
/// Sorted by label so the tree has a stable order that is not "whatever
/// `read_dir` felt like".
pub fn scopes_in(root: &Path) -> Vec<MindScope> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut scopes: Vec<MindScope> = Vec::new();
    for entry in entries.flatten() {
        if !entry.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        let slug = entry.file_name().to_string_lossy().into_owned();
        let count = count_memories(&memory_dir(root, &slug));
        if count == 0 {
            continue;
        }
        let project_path = decode_slug(&slug);
        scopes.push(MindScope {
            label: label_of(&project_path),
            is_worktree: project_path.contains(WORKTREE_MARKER),
            root_path: root_of(&project_path),
            project_path,
            slug,
            count,
        });
    }
    scopes.sort_by(|a, b| {
        a.label
            .to_lowercase()
            .cmp(&b.label.to_lowercase())
            .then_with(|| a.slug.cmp(&b.slug))
    });
    scopes
}

/// How many memories are in a directory — the same question `scan_in` answers,
/// asked without reading any of them.
///
/// Both the name test AND the file test, because this number is the one on the
/// folder in the tree and `scan_in` is what fills the folder when it opens. A
/// directory called `notes.md`, or a symlinked memory, used to be counted here
/// and skipped there: a folder saying 2 that opened to one row. (`DirEntry`'s
/// metadata is an `lstat` on Unix, which is what excludes the symlink, and is
/// deliberately the same call `scan_in` makes.)
fn count_memories(dir: &Path) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    entries
        .flatten()
        .filter(|entry| entry.file_name().to_str().is_some_and(is_memory_file))
        .filter(|entry| entry.metadata().is_ok_and(|meta| meta.is_file()))
        .count()
}

/// Every memory in one scope, headers only.
///
/// A file that cannot be read is SKIPPED rather than failing the listing: one
/// unreadable file in a scope of sixty must not be the reason none of them
/// appear. Sorted by name, case-insensitively — the tree is something people
/// scan, and file order is not an order.
pub fn list_in(root: &Path, slug: &str) -> Vec<MindMemory> {
    scan_in(root, slug)
        .into_iter()
        .map(|(memory, _body)| memory)
        .collect()
}

/// `list_in`, keeping the bodies.
///
/// The whole file is read either way — links live in the body — so search gets
/// its text for free rather than for a second pass. `list_in` throws it away
/// because the renderer's tree does not want 200 KB of prose crossing the IPC
/// boundary to draw a list of names.
fn scan_in(root: &Path, slug: &str) -> Vec<(MindMemory, String)> {
    let dir = memory_dir(root, slug);
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut memories: Vec<(MindMemory, String)> = Vec::new();
    for entry in entries.flatten() {
        let file_name = entry.file_name();
        let Some(file_name) = file_name.to_str() else {
            continue;
        };
        if !is_memory_file(file_name) {
            continue;
        }
        let path = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let Some(text) = read_body(&path, meta.len()) else {
            continue;
        };
        let stem = file_name
            .rsplit_once('.')
            .map(|(stem, _)| stem)
            .unwrap_or(file_name);
        let (name, description, memory_type, links) = parse_memory(stem, &text);
        memories.push((
            MindMemory {
                scope: slug.to_string(),
                path: path.to_string_lossy().into_owned(),
                name,
                description,
                memory_type,
                links,
                updated_at: mtime_ms(&meta),
                bytes: meta.len(),
            },
            text,
        ));
    }
    memories.sort_by(|a, b| {
        a.0.name
            .to_lowercase()
            .cmp(&b.0.name.to_lowercase())
            .then_with(|| a.0.path.cmp(&b.0.path))
    });
    memories
}

/// A memory's text for the scanner, never more than `MAX_MEMORY_BYTES` of it.
///
/// The listing and the search read every file in a scope, and the MCP server
/// serves what the search read straight into a model's context window — so a
/// memory something went wrong writing must not be able to allocate its whole
/// size here. `read_in` REFUSES such a file outright, which is the right answer
/// when a person asked for one file; this takes its first 5 MB instead, so the
/// header still parses and the scope's count still matches its listing.
///
/// Under the cap the read is unchanged, invalid UTF-8 included: a file that is
/// not text is skipped rather than mangled into replacement characters. Over
/// it, the cut is very unlikely to fall on a character boundary, so that one
/// pathological file is read lossily rather than dropped.
fn read_body(path: &Path, len: u64) -> Option<String> {
    if len <= MAX_MEMORY_BYTES {
        return std::fs::read_to_string(path).ok();
    }
    use std::io::Read;
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .ok()?
        .take(MAX_MEMORY_BYTES)
        .read_to_end(&mut bytes)
        .ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

/// The refusal a memory over the cap gets, or `None` when it is within it.
///
/// One function because two readers have to refuse in the same words: the Tauri
/// command that puts a body in the renderer, and the MCP tool that puts one in
/// a model's context window. The MCP side had no cap at all — a 6 MB memory
/// came back whole and went straight into the conversation.
pub fn too_large(bytes: u64) -> Option<String> {
    (bytes > MAX_MEMORY_BYTES).then(|| {
        format!(
            "memory is larger than {} MB",
            MAX_MEMORY_BYTES / (1024 * 1024)
        )
    })
}

/// One memory's body — frontmatter included, because the pane renders the
/// markdown and the frontmatter is part of what the agent wrote.
///
/// `path` is checked before it is opened: canonicalized and required to sit
/// inside `root`. The renderer only ever passes paths this module handed it,
/// which is exactly why the check is here — a command that trusts its caller is
/// a command that reads `~/.ssh/id_rsa` the first time something upstream is
/// wrong.
///
/// **What that sandbox is, exactly:** `root` is `~/.claude/projects` — the whole
/// tree, not `<scope>/memory/*.md`. Any file under any scope passes, including
/// the session transcripts Claude Code writes beside `memory/`. That is the box
/// the plan specified ("must canonicalize inside `~/.claude/projects`") and it
/// is what the error message below now says, rather than the tighter box the
/// phrase "the memory directory" implied. Narrowing it to
/// `<root>/<slug>/memory/*.md` costs nothing in behaviour — every path the
/// renderer holds came from `list_in` — and is ledger item 30.
pub fn read_in(root: &Path, path: &str) -> Result<String, String> {
    let file = ensure_within(root, path)?;
    let meta = std::fs::metadata(&file).map_err(|e| format!("memory not readable: {e}"))?;
    if !meta.is_file() {
        return Err("not a file".to_string());
    }
    if let Some(refusal) = too_large(meta.len()) {
        return Err(refusal);
    }
    std::fs::read_to_string(&file).map_err(|e| format!("memory not readable: {e}"))
}

/// Canonicalize `target` and require it to descend from `root` — the projects
/// root, `~/.claude/projects`, and not one scope's `memory/` directory.
///
/// Both sides are canonicalized, so a symlink inside a scope pointing out of the
/// root is refused too — `..` is the obvious attack and the least interesting
/// one.
///
/// The messages name the box that is actually enforced. They used to say "the
/// memory directory", which describes something tighter than the code does and
/// would have had a reader of the error believe a transcript beside `memory/`
/// was out of reach when it is not.
fn ensure_within(root: &Path, target: &str) -> Result<PathBuf, String> {
    let root = std::fs::canonicalize(root)
        .map_err(|e| format!("~/.claude/projects is not accessible: {e}"))?;
    let file = std::fs::canonicalize(target).map_err(|e| format!("memory not accessible: {e}"))?;
    if !file.starts_with(&root) {
        return Err("path is outside ~/.claude/projects".to_string());
    }
    Ok(file)
}

// ---------------------------------------------------------------------------
// Asking the corpus questions — what the MCP server serves
// ---------------------------------------------------------------------------

/// The scopes that belong to one project directory: its own, and its git
/// worktrees'.
///
/// The worktrees are the half that matters here. An agent working in
/// `~/Storefront/.claude/worktrees/v1.2` writes its memories to that worktree's
/// scope, and Claude Code's own search would never show them to the next
/// session in the main repository. Unifying them is the thing RocSpace can do
/// that Claude Code today does not, and it is as true for an agent asking
/// through MCP as it is for the tree on screen.
///
/// Paths are canonicalized on both sides before comparing, so a project passed
/// with a trailing slash, through a symlink, or as `/var/...` where the scope
/// decoded to `/private/var/...` is still the same project.
pub fn scopes_for_project(root: &Path, project: &Path) -> Vec<MindScope> {
    let target = canonical(project);
    scopes_in(root)
        .into_iter()
        .filter(|scope| {
            canonical(Path::new(&scope.project_path)) == target
                || scope
                    .root_path
                    .as_deref()
                    .is_some_and(|repo| canonical(Path::new(repo)) == target)
        })
        .collect()
}

fn canonical(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// Score weights per field, matching `src/lib/mindSearch.ts`.
///
/// A name hit beats a description hit beats a body hit, and that is the
/// corpus's own intent rather than a heuristic: every memory carries a
/// one-line `description` written to be ranked against.
const SCORE_NAME: i64 = 3;
const SCORE_DESCRIPTION: i64 = 2;
const SCORE_BODY: i64 = 1;
const BONUS_EXACT: i64 = 8;
const BONUS_PREFIX: i64 = 4;

/// One memory and why it matched.
pub struct MindHit {
    pub memory: MindMemory,
    pub score: i64,
}

/// Rank the memories of `slugs` against `query`, best first.
///
/// Every term has to match somewhere — typing a second word narrows, which is
/// what a person typing one means — and ties break by recency, because two
/// memories that match equally are usually the same subject twice and the
/// newer one is the one still true.
pub fn search_in(root: &Path, slugs: &[String], query: &str, limit: usize) -> Vec<MindHit> {
    let terms: Vec<String> = query
        .to_lowercase()
        .split_whitespace()
        .map(str::to_string)
        .collect();
    if terms.is_empty() {
        return Vec::new();
    }
    let whole = terms.join(" ");

    let mut hits: Vec<MindHit> = Vec::new();
    for slug in slugs {
        for (memory, body) in scan_in(root, slug) {
            let name = memory.name.to_lowercase();
            let description = memory.description.to_lowercase();
            let body = body.to_lowercase();

            let mut score = 0;
            let mut matched_all = true;
            for term in &terms {
                let field = if name.contains(term) {
                    SCORE_NAME
                } else if description.contains(term) {
                    SCORE_DESCRIPTION
                } else if body.contains(term) {
                    SCORE_BODY
                } else {
                    matched_all = false;
                    break;
                };
                score += field;
            }
            if !matched_all {
                continue;
            }
            if name == whole {
                score += BONUS_EXACT;
            } else if name.starts_with(&whole) {
                score += BONUS_PREFIX;
            }
            hits.push(MindHit { memory, score });
        }
    }

    hits.sort_by(|a, b| {
        b.score
            .cmp(&a.score)
            .then_with(|| b.memory.updated_at.cmp(&a.memory.updated_at))
            .then_with(|| a.memory.name.cmp(&b.memory.name))
    });
    hits.truncate(limit);
    hits
}

/// The memory called `name` in one of `slugs`, and its body.
///
/// Case-insensitive on the name because that is how a model will type it back,
/// and matched against the frontmatter `name` rather than the filename —
/// `type-scaling-v1.2-epic.md` is called `type-scaling-v1-2-epic`, and the
/// links point at the second.
pub fn find_in(root: &Path, slugs: &[String], name: &str) -> Option<(MindMemory, String)> {
    let wanted = name.trim().to_lowercase();
    for slug in slugs {
        for (memory, body) in scan_in(root, slug) {
            if memory.name.to_lowercase() == wanted {
                return Some((memory, body));
            }
        }
    }
    None
}

/// Memories in `slugs` that link TO `name`.
pub fn backlinks_in(root: &Path, slugs: &[String], name: &str) -> Vec<MindMemory> {
    let wanted = name.trim().to_lowercase();
    let mut sources: Vec<MindMemory> = Vec::new();
    for slug in slugs {
        for memory in list_in(root, slug) {
            if memory.name.to_lowercase() == wanted {
                continue;
            }
            if memory
                .links
                .iter()
                .any(|link| link.trim().to_lowercase() == wanted)
            {
                sources.push(memory);
            }
        }
    }
    sources
}

// ---------------------------------------------------------------------------
// The watcher
// ---------------------------------------------------------------------------

/// What one poll saw of a scope: name, mtime and size per memory, sorted.
///
/// A directory listing rather than the directory's own mtime, because the two
/// answer different questions. A file EDITED in place does not move its
/// parent's mtime on every filesystem, and an editing agent is the common case
/// — Claude Code updates a memory far more often than it creates one.
///
/// Compared whole rather than hashed: a scope holds tens of files, the vector
/// is a few kilobytes, and an exact comparison cannot collide.
type Stamp = Vec<(String, i64, u64)>;

fn stamp_of(dir: &Path) -> Stamp {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut stamp: Stamp = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_str()?.to_string();
            if !is_memory_file(&name) {
                return None;
            }
            let meta = entry.metadata().ok()?;
            Some((name, mtime_ms(&meta), meta.len()))
        })
        .collect();
    stamp.sort();
    stamp
}

/// Payload of `rocmind://changed`. The slug, because that is the key the
/// renderer's `memoriesByScope` is indexed by and the string it passed to
/// `mind_watch`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MindChangedEvent {
    pub scope: String,
}

/// One watched scope.
struct Watched {
    /// How many callers asked for it. A workspace and its worktrees can resolve
    /// to overlapping sets of scopes, and two workspaces open on one project
    /// share a scope outright — the last one out is the only one allowed to
    /// stop the polling.
    refs: usize,
    /// What the watcher last accounted for. Seeded when the scope is first
    /// watched, so a corpus nobody is writing never emits.
    last: Stamp,
}

/// Registry of scopes being followed. Managed by Tauri; the `mind_watch` /
/// `mind_unwatch` commands and the poll thread share it.
#[derive(Default)]
pub struct MindWatcher {
    scopes: Mutex<HashMap<String, Watched>>,
}

impl MindWatcher {
    /// Start following a scope, or add a reference to a watch already on it.
    ///
    /// Seeded with a read, so the first poll of a quiet scope is silent:
    /// `rocmind://changed` means "this changed", never "here is what it has
    /// always been".
    pub fn watch(&self, root: &Path, slug: &str) {
        // Already watched: a map lookup, no IO, nothing held for longer.
        {
            let mut scopes = self.lock();
            if let Some(entry) = scopes.get_mut(slug) {
                entry.refs += 1;
                return;
            }
        }
        // Seeding a NEW scope is a directory listing, which on a stalled volume
        // takes as long as it takes. Done with the registry released, so every
        // other watch, unwatch and poll carries on rather than queueing behind
        // this one directory.
        let last = stamp_of(&memory_dir(root, slug));
        let mut scopes = self.lock();
        match scopes.get_mut(slug) {
            // Somebody watched the same scope while we were reading; their seed
            // is the same read of the same directory. Keep it, take a reference.
            Some(entry) => entry.refs += 1,
            None => {
                scopes.insert(slug.to_string(), Watched { refs: 1, last });
            }
        }
    }

    /// Drop one caller's interest; the last one out stops the watch.
    pub fn unwatch(&self, slug: &str) {
        let mut scopes = self.lock();
        let Some(entry) = scopes.get_mut(slug) else {
            return;
        };
        entry.refs -= 1;
        if entry.refs == 0 {
            scopes.remove(slug);
        }
    }

    /// Re-list every watched scope, returning only the ones that moved.
    fn poll(&self, root: &Path) -> Vec<MindChangedEvent> {
        self.poll_with(|slug| stamp_of(&memory_dir(root, slug)))
    }

    /// `poll`, with the read injected so a test can look at the registry from
    /// inside it.
    ///
    /// Three phases, and the middle one is the point: snapshot the watched
    /// slugs under the lock, read them with the lock RELEASED, then take it
    /// again to compare and write the new baselines. One guard held across
    /// every `read_dir` would mean a single scope on a stalled volume blocking
    /// every `mind_watch` and `mind_unwatch` for as long as it hangs — the same
    /// discipline `git_info`'s poll spells out.
    fn poll_with(&self, mut read: impl FnMut(&str) -> Stamp) -> Vec<MindChangedEvent> {
        let watched: Vec<String> = self.lock().keys().cloned().collect();
        let fresh: Vec<(String, Stamp)> = watched
            .into_iter()
            .map(|slug| {
                let stamp = read(&slug);
                (slug, stamp)
            })
            .collect();

        let mut scopes = self.lock();
        let mut changed = Vec::new();
        for (slug, stamp) in fresh {
            // Unwatched while we were reading — the last holder let go. There
            // is nobody to tell, and re-inserting it would resurrect a watch
            // nothing asked for.
            let Some(entry) = scopes.get_mut(&slug) else {
                continue;
            };
            if entry.last != stamp {
                entry.last = stamp;
                changed.push(MindChangedEvent { scope: slug });
            }
        }
        changed
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Watched>> {
        self.scopes.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// Start the poll thread. Runs for the lifetime of the app; with nothing
/// watched it is a 2-second sleep loop over an empty map.
pub fn spawn_watcher(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(POLL_INTERVAL);
        let Some(watcher) = app.try_state::<MindWatcher>() else {
            return;
        };
        // Resolved per poll rather than captured once: `HOME` is process
        // state, and a root that did not exist at startup (a fresh machine
        // whose first Claude Code session comes later) should start working
        // without a restart.
        let Some(root) = projects_root() else {
            continue;
        };
        for event in watcher.poll(&root) {
            let _ = app.emit(EVENT_ROCMIND_CHANGED, &event);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A scope directory with memories in it. Returns the root.
    fn corpus(root: &Path, slug: &str, files: &[(&str, &str)]) {
        let dir = memory_dir(root, slug);
        std::fs::create_dir_all(&dir).unwrap();
        for (name, body) in files {
            std::fs::write(dir.join(name), body).unwrap();
        }
    }

    const FULL: &str = "---\nname: payments-provider-migration\ndescription: \"Payments provider moved\"\nmetadata: \n  node_type: memory\n  type: project\n  originSessionId: abc\n---\n\nBody text with [[reference-bridgespace]].\n";

    // -- frontmatter -------------------------------------------------------

    #[test]
    fn reads_a_complete_frontmatter_block() {
        let (name, description, memory_type, links) = parse_memory("stem", FULL);
        assert_eq!(name, "payments-provider-migration");
        assert_eq!(description, "Payments provider moved");
        assert_eq!(memory_type, "project");
        assert_eq!(links, vec!["reference-bridgespace".to_string()]);
    }

    #[test]
    fn a_file_with_no_frontmatter_is_still_a_memory() {
        // The tolerance rule: a plain markdown file in the memory directory is
        // a memory named after its file, not a parse failure.
        let (name, description, memory_type, links) =
            parse_memory("hand-written", "# Notes\n\nSomething [[else]].\n");
        assert_eq!(name, "hand-written");
        assert_eq!(description, "");
        assert_eq!(memory_type, "");
        assert_eq!(links, vec!["else".to_string()]);
    }

    #[test]
    fn a_partial_frontmatter_block_is_worth_the_keys_it_has() {
        let (name, description, memory_type, _) =
            parse_memory("stem", "---\nname: only-a-name\n---\n\nBody.\n");
        assert_eq!(name, "only-a-name");
        assert_eq!(description, "");
        assert_eq!(memory_type, "");
    }

    #[test]
    fn metadata_without_a_type_leaves_the_type_empty() {
        let (_, _, memory_type, _) = parse_memory(
            "stem",
            "---\nname: n\nmetadata:\n  node_type: memory\n---\nBody\n",
        );
        assert_eq!(memory_type, "");
    }

    #[test]
    fn keeps_a_description_that_contains_a_colon() {
        // Real corpus: "How to regenerate App Store product images: compose.py
        // pastes fresh sim raws…". Split on the LAST colon and the description
        // loses most of itself.
        let (_, description, _, _) = parse_memory(
            "stem",
            "---\ndescription: \"How to regen: compose.py does it\"\n---\nBody\n",
        );
        assert_eq!(description, "How to regen: compose.py does it");
    }

    #[test]
    fn reads_an_unquoted_description() {
        // Two thirds of this corpus quotes the description and one third does
        // not; both are the same value.
        let (_, description, _, _) = parse_memory(
            "stem",
            "---\ndescription: Payments provider is acct-4417 since Jul 9\n---\nBody\n",
        );
        assert_eq!(description, "Payments provider is acct-4417 since Jul 9");
    }

    #[test]
    fn keeps_unicode_intact() {
        let (name, description, _, _) = parse_memory(
            "stem",
            "---\nname: trends—chart\ndescription: \"1320×2868 raws — em dashes and ünïcode\"\n---\nBody\n",
        );
        assert_eq!(name, "trends—chart");
        assert_eq!(description, "1320×2868 raws — em dashes and ünïcode");
    }

    #[test]
    fn a_type_outside_the_metadata_block_is_not_the_memory_type() {
        // A top-level `type:` is a different key in a different place, and
        // treating it as `metadata.type` would invent a contract.
        let (_, _, memory_type, _) =
            parse_memory("stem", "---\nname: n\ntype: not-this\n---\nBody\n");
        assert_eq!(memory_type, "");
    }

    #[test]
    fn an_unclosed_frontmatter_fence_is_all_body() {
        // A truncated write. Reading the whole file as frontmatter would give a
        // memory with no body at all.
        let text = "---\nname: truncated\ndescription: half a\n";
        let (name, _, _, _) = parse_memory("stem", text);
        assert_eq!(name, "stem", "no closing fence, so no frontmatter");
    }

    #[test]
    fn tolerates_crlf_and_a_leading_bom() {
        let text = "\u{feff}---\r\nname: windows-written\r\nmetadata:\r\n  type: project\r\n---\r\nBody [[a]]\r\n";
        let (name, _, memory_type, links) = parse_memory("stem", text);
        assert_eq!(name, "windows-written");
        assert_eq!(memory_type, "project");
        assert_eq!(links, vec!["a".to_string()]);
    }

    #[test]
    fn a_second_fence_later_in_the_body_does_not_reopen_the_frontmatter() {
        let text = "---\nname: n\n---\nBody\n\n---\n\nname: not-a-key\n";
        let (name, _, _, _) = parse_memory("stem", text);
        assert_eq!(name, "n");
    }

    #[test]
    fn parses_a_one_megabyte_body_without_choking() {
        let body = "lorem ipsum [[link-a]] ".repeat(50_000);
        let text = format!("---\nname: big\n---\n{body}");
        assert!(text.len() > 1024 * 1024, "{}", text.len());
        let (name, _, _, links) = parse_memory("stem", &text);
        assert_eq!(name, "big");
        assert_eq!(
            links,
            vec!["link-a".to_string()],
            "de-duped, not 50k copies"
        );
    }

    // -- links -------------------------------------------------------------

    #[test]
    fn keeps_link_order_and_drops_duplicates() {
        let links = extract_links("[[b]] then [[a]] then [[b]] again");
        assert_eq!(links, vec!["b".to_string(), "a".to_string()]);
    }

    #[test]
    fn counts_a_link_inside_a_code_fence() {
        // Deliberate: this parser does not model markdown, and a dropped edge
        // is worse than an extra one.
        let links = extract_links("```\n[[in-code]]\n```\n");
        assert_eq!(links, vec!["in-code".to_string()]);
    }

    #[test]
    fn ignores_an_empty_or_unterminated_link() {
        assert!(extract_links("[[]] and [[ ]]").is_empty());
        assert!(extract_links("[[never-closed").is_empty());
    }

    #[test]
    fn does_not_read_links_out_of_the_frontmatter() {
        // `links` is "what this memory points at", and the frontmatter is
        // metadata about the file, not prose the agent wrote.
        let (_, _, _, links) =
            parse_memory("stem", "---\ndescription: \"see [[other]]\"\n---\nBody\n");
        assert!(links.is_empty());
    }

    #[test]
    fn trims_whitespace_inside_a_link() {
        assert_eq!(extract_links("[[ spaced ]]"), vec!["spaced".to_string()]);
    }

    // -- slugs -------------------------------------------------------------

    #[test]
    fn decodes_a_project_slug_against_the_filesystem() {
        let tmp = tempfile::tempdir().unwrap();
        let project = tmp.path().join("Storefront");
        std::fs::create_dir_all(&project).unwrap();
        let slug = encode_path(&project.to_string_lossy());

        // The path as it was spelled, not its canonical form: the decode walks
        // symlinks rather than resolving them, so `/var/…` stays `/var/…` —
        // which is the spelling the slug was made from and the one a workspace
        // will have on file.
        assert_eq!(decode_slug(&slug), project.to_string_lossy().into_owned());
    }

    #[test]
    fn decodes_a_worktree_slug_whose_name_contains_dots() {
        // The case the string alone cannot answer: `v1.1` and `v1-1` encode
        // identically, and only one of them is on disk.
        let tmp = tempfile::tempdir().unwrap();
        let worktree = tmp.path().join("Storefront/.claude/worktrees/v1.1");
        std::fs::create_dir_all(&worktree).unwrap();
        let slug = encode_path(&worktree.to_string_lossy());

        let decoded = decode_slug(&slug);
        assert!(
            decoded.ends_with("/Storefront/.claude/worktrees/v1.1"),
            "{decoded}"
        );
        assert!(decoded.contains(WORKTREE_MARKER));
        assert_eq!(label_of(&decoded), "v1.1");
        assert!(root_of(&decoded).unwrap().ends_with("/Storefront"));
    }

    #[test]
    fn decoding_prefers_the_longer_directory_when_two_could_match() {
        // `Storefront` and `Storefront-landing` are both prefixes of the same slug, and
        // taking the short one leaves a remainder that goes nowhere.
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("Storefront")).unwrap();
        let target = tmp.path().join("Storefront-landing/src");
        std::fs::create_dir_all(&target).unwrap();
        let slug = encode_path(&target.to_string_lossy());

        assert!(decode_slug(&slug).ends_with("/Storefront-landing/src"));
    }

    #[test]
    fn decoding_backtracks_out_of_a_dead_end() {
        // The longest match is not always the right one: `v1` exists but has no
        // `2` under it, while `v1-2` does have `epic`.
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("v1")).unwrap();
        let target = tmp.path().join("v1-2/epic");
        std::fs::create_dir_all(&target).unwrap();
        let slug = encode_path(&target.to_string_lossy());

        assert!(
            decode_slug(&slug).ends_with("/v1-2/epic"),
            "{}",
            decode_slug(&slug)
        );
    }

    #[test]
    fn falls_back_to_a_best_effort_path_for_a_project_that_is_gone() {
        let decoded = decode_slug("-nonexistent-rocspace-test-Storefront--claude-worktrees-v1-1");
        assert_eq!(
            decoded,
            "/nonexistent/rocspace/test/Storefront/.claude/worktrees/v1/1"
        );
    }

    #[test]
    fn a_slug_that_is_not_an_absolute_path_is_still_decoded() {
        assert_eq!(decode_slug("relative-thing"), "relative/thing");
    }

    #[test]
    fn encoding_matches_what_claude_code_writes() {
        assert_eq!(
            encode_path("/Users/dev/Storefront/.claude/worktrees/v1.1"),
            "-Users-dev-Storefront--claude-worktrees-v1-1"
        );
        // The case the corpus taught us: a space is a separator too. Getting
        // this wrong turned `Acme Site` into `Acme/Site`.
        assert_eq!(
            encode_path("/Users/dev/Acme Site"),
            "-Users-dev-Acme-Site"
        );
    }

    #[test]
    fn decodes_a_directory_whose_name_contains_a_space() {
        // The real one: `~/Acme Site` encodes exactly like `~/Acme/Site`
        // would, and a decoder that only knows about `/` and `.` labels the
        // scope "Site" and points it at a directory that does not exist.
        let tmp = tempfile::tempdir().unwrap();
        let project = tmp.path().join("Acme Site");
        std::fs::create_dir_all(&project).unwrap();
        let slug = encode_path(&project.to_string_lossy());

        let decoded = decode_slug(&slug);
        assert!(decoded.ends_with("/Acme Site"), "{decoded}");
        assert_eq!(label_of(&decoded), "Acme Site");
    }

    #[test]
    fn decoding_finds_a_name_holding_a_character_the_encoder_might_keep() {
        // `match_len` is looser than `encode_path` for exactly this: whether
        // Claude Code replaces an underscore is not something this corpus can
        // say, and the decode must not depend on the answer.
        let tmp = tempfile::tempdir().unwrap();
        let project = tmp.path().join("deep_work");
        std::fs::create_dir_all(&project).unwrap();
        let base = encode_path(&tmp.path().to_string_lossy());

        for spelling in ["deep_work", "deep-work"] {
            let decoded = decode_slug(&format!("{base}-{spelling}"));
            assert!(decoded.ends_with("/deep_work"), "{spelling}: {decoded}");
        }
    }

    // -- scopes ------------------------------------------------------------

    #[test]
    fn lists_only_scopes_that_have_memories() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        corpus(root, "-a-Project", &[("one.md", FULL)]);
        // A scope with a memory directory and nothing in it — every directory a
        // session was ever started in has one of these.
        std::fs::create_dir_all(memory_dir(root, "-a-Empty")).unwrap();
        // …and one with no memory directory at all.
        std::fs::create_dir_all(root.join("-a-Bare")).unwrap();

        let scopes = scopes_in(root);
        assert_eq!(scopes.len(), 1);
        assert_eq!(scopes[0].slug, "-a-Project");
        assert_eq!(scopes[0].count, 1);
    }

    #[test]
    fn the_index_file_is_not_counted_as_a_memory() {
        // 63 files in Storefront's directory, 62 memories: MEMORY.md is the index.
        let tmp = tempfile::tempdir().unwrap();
        corpus(
            tmp.path(),
            "-a-Project",
            &[("MEMORY.md", "- [a](a.md)\n"), ("a.md", FULL)],
        );
        let scopes = scopes_in(tmp.path());
        assert_eq!(scopes[0].count, 1);
        assert_eq!(list_in(tmp.path(), "-a-Project").len(), 1);
    }

    #[test]
    fn ignores_files_that_are_not_markdown() {
        let tmp = tempfile::tempdir().unwrap();
        corpus(
            tmp.path(),
            "-a-Project",
            &[("notes.txt", "x"), ("a.md", FULL), (".DS_Store", "x")],
        );
        assert_eq!(scopes_in(tmp.path())[0].count, 1);
    }

    #[test]
    fn the_count_on_a_folder_is_what_opening_it_shows() {
        // The count came from the filename alone while the listing also asked
        // whether it was a file, so a DIRECTORY called `notes.md` — or a
        // symlinked memory — made a folder that said 2 and opened to one row.
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        corpus(root, "-a-Project", &[("real.md", FULL)]);
        std::fs::create_dir_all(memory_dir(root, "-a-Project").join("notes.md")).unwrap();

        assert_eq!(scopes_in(root)[0].count, 1);
        assert_eq!(list_in(root, "-a-Project").len(), 1);
    }

    #[test]
    fn a_symlinked_memory_is_counted_the_way_it_is_listed() {
        // `DirEntry::metadata` is an `lstat` on Unix, so a symlink is not a
        // file — the listing has always skipped one, and now so does the count.
        #[cfg(unix)]
        {
            let tmp = tempfile::tempdir().unwrap();
            let root = tmp.path();
            corpus(root, "-a-Project", &[("real.md", FULL)]);
            let shared = root.join("shared.md");
            std::fs::write(&shared, FULL).unwrap();
            std::os::unix::fs::symlink(&shared, memory_dir(root, "-a-Project").join("link.md"))
                .unwrap();

            assert_eq!(
                scopes_in(root)[0].count,
                list_in(root, "-a-Project").len(),
                "the folder's count and its contents have to agree"
            );
        }
    }

    #[test]
    fn a_missing_root_is_no_scopes_rather_than_an_error() {
        assert!(scopes_in(Path::new("/nonexistent-rocspace-mind-root")).is_empty());
    }

    #[test]
    fn scopes_are_sorted_by_label() {
        let tmp = tempfile::tempdir().unwrap();
        for slug in ["-zed-Zeta", "-a-Alpha", "-m-Mid"] {
            corpus(tmp.path(), slug, &[("a.md", FULL)]);
        }
        let labels: Vec<String> = scopes_in(tmp.path()).into_iter().map(|s| s.label).collect();
        assert_eq!(labels, vec!["Alpha", "Mid", "Zeta"]);
    }

    // -- listing -----------------------------------------------------------

    #[test]
    fn lists_a_scopes_memories_with_their_headers() {
        let tmp = tempfile::tempdir().unwrap();
        corpus(tmp.path(), "-a-Project", &[("payments.md", FULL)]);

        let memories = list_in(tmp.path(), "-a-Project");
        assert_eq!(memories.len(), 1);
        let memory = &memories[0];
        assert_eq!(memory.scope, "-a-Project");
        assert_eq!(memory.name, "payments-provider-migration");
        assert_eq!(memory.description, "Payments provider moved");
        assert_eq!(memory.memory_type, "project");
        assert_eq!(memory.links, vec!["reference-bridgespace".to_string()]);
        assert_eq!(memory.bytes, FULL.len() as u64);
        assert!(memory.updated_at > 0);
        assert!(memory.path.ends_with("payments.md"));
    }

    #[test]
    fn a_memory_with_no_frontmatter_is_named_after_its_file() {
        let tmp = tempfile::tempdir().unwrap();
        corpus(tmp.path(), "-a-Project", &[("plain-notes.md", "# hi\n")]);
        assert_eq!(list_in(tmp.path(), "-a-Project")[0].name, "plain-notes");
    }

    #[test]
    fn memories_are_sorted_by_name() {
        let tmp = tempfile::tempdir().unwrap();
        corpus(
            tmp.path(),
            "-a-Project",
            &[
                ("z.md", "---\nname: zebra\n---\n"),
                ("a.md", "---\nname: Apple\n---\n"),
                ("m.md", "---\nname: mango\n---\n"),
            ],
        );
        let names: Vec<String> = list_in(tmp.path(), "-a-Project")
            .into_iter()
            .map(|m| m.name)
            .collect();
        assert_eq!(names, vec!["Apple", "mango", "zebra"]);
    }

    #[test]
    fn listing_an_unknown_scope_is_empty_rather_than_an_error() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(list_in(tmp.path(), "-not-a-scope").is_empty());
    }

    // -- reading -----------------------------------------------------------

    #[test]
    fn reads_a_memory_body_whole() {
        let tmp = tempfile::tempdir().unwrap();
        corpus(tmp.path(), "-a-Project", &[("payments.md", FULL)]);
        let path = memory_dir(tmp.path(), "-a-Project").join("payments.md");

        let text = read_in(tmp.path(), &path.to_string_lossy()).unwrap();
        assert_eq!(text, FULL, "frontmatter included — it is part of the file");
    }

    #[test]
    fn refuses_a_path_outside_the_memory_root() {
        let tmp = tempfile::tempdir().unwrap();
        corpus(tmp.path(), "-a-Project", &[("a.md", FULL)]);
        let outside = tmp.path().parent().unwrap().join("escaped.md");
        std::fs::write(&outside, "secret").unwrap();

        let err = read_in(tmp.path(), &outside.to_string_lossy()).unwrap_err();
        assert!(err.contains("outside"), "{err}");
    }

    #[test]
    fn refuses_a_traversal_out_of_the_memory_root() {
        let tmp = tempfile::tempdir().unwrap();
        corpus(tmp.path(), "-a-Project", &[("a.md", FULL)]);
        let outside = tmp.path().parent().unwrap().join("escaped.md");
        std::fs::write(&outside, "secret").unwrap();
        let traversal = memory_dir(tmp.path(), "-a-Project").join("../../../escaped.md");

        let err = read_in(tmp.path(), &traversal.to_string_lossy()).unwrap_err();
        assert!(err.contains("outside"), "{err}");
    }

    #[test]
    fn refuses_a_symlink_that_points_out_of_the_memory_root() {
        // `..` is the obvious escape and the least interesting one.
        #[cfg(unix)]
        {
            let tmp = tempfile::tempdir().unwrap();
            corpus(tmp.path(), "-a-Project", &[("a.md", FULL)]);
            let outside = tmp.path().parent().unwrap().join("symlink-target.md");
            std::fs::write(&outside, "secret").unwrap();
            let link = memory_dir(tmp.path(), "-a-Project").join("link.md");
            std::os::unix::fs::symlink(&outside, &link).unwrap();

            let err = read_in(tmp.path(), &link.to_string_lossy()).unwrap_err();
            assert!(err.contains("outside"), "{err}");
        }
    }

    #[test]
    fn a_memory_over_the_cap_is_read_no_further_than_the_cap() {
        // The listing and the search read every file in a scope, and the MCP
        // server hands what the search read to a model. A 6 MB memory used to
        // be allocated, scanned and served whole; `read_in` refused it while
        // `find_in` did not.
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        corpus(root, "-a-Project", &[("small.md", FULL)]);
        let huge = "x".repeat(MAX_MEMORY_BYTES as usize + 1024);
        std::fs::write(
            memory_dir(root, "-a-Project").join("huge.md"),
            format!("---\nname: huge-memory\n---\n\n{huge}"),
        )
        .unwrap();

        // Still listed, and still counted — dropping it would put the folder's
        // count and its contents back out of step.
        assert_eq!(scopes_in(root)[0].count, 2);
        let listed = list_in(root, "-a-Project");
        assert_eq!(listed.len(), 2);

        let (_, body) = find_in(root, &["-a-Project".to_string()], "huge-memory").unwrap();
        assert!(
            body.len() as u64 <= MAX_MEMORY_BYTES,
            "served {} bytes",
            body.len()
        );
        // …and the header survived the cut, which is what makes it worth
        // listing at all.
        assert!(listed.iter().any(|m| m.name == "huge-memory"));
    }

    #[test]
    fn the_cap_refuses_in_one_sentence_wherever_it_is_asked() {
        assert_eq!(too_large(10), None);
        assert_eq!(
            too_large(MAX_MEMORY_BYTES + 1).as_deref(),
            Some("memory is larger than 5 MB")
        );
    }

    #[test]
    fn refuses_a_path_that_does_not_exist() {
        let tmp = tempfile::tempdir().unwrap();
        corpus(tmp.path(), "-a-Project", &[("a.md", FULL)]);
        let missing = memory_dir(tmp.path(), "-a-Project").join("gone.md");
        assert!(read_in(tmp.path(), &missing.to_string_lossy()).is_err());
    }

    #[test]
    fn refuses_a_directory() {
        let tmp = tempfile::tempdir().unwrap();
        corpus(tmp.path(), "-a-Project", &[("a.md", FULL)]);
        let dir = memory_dir(tmp.path(), "-a-Project");
        assert!(read_in(tmp.path(), &dir.to_string_lossy()).is_err());
    }

    // -- asking the corpus questions ---------------------------------------

    /// A project directory, plus a memory root that knows about it.
    fn project_corpus(
        files: &[(&str, &str)],
        worktree: &[(&str, &str)],
    ) -> (tempfile::TempDir, tempfile::TempDir, PathBuf) {
        let home = tempfile::tempdir().unwrap();
        let repo = tempfile::tempdir().unwrap();
        let root = home.path().join("projects");
        let project = repo.path().join("Storefront");
        std::fs::create_dir_all(&project).unwrap();
        corpus(&root, &encode_path(&project.to_string_lossy()), files);
        if !worktree.is_empty() {
            let path = project.join(".claude").join("worktrees").join("v1.2");
            std::fs::create_dir_all(&path).unwrap();
            corpus(&root, &encode_path(&path.to_string_lossy()), worktree);
        }
        (home, repo, project)
    }

    const NOTE_A: &str = "---\nname: payments-provider-migration\ndescription: \"Payments provider moved\"\nmetadata:\n  type: project\n---\n\nPublisher acct-4417. See [[internal-builds-test-keys]].\n";
    const NOTE_B: &str = "---\nname: internal-builds-test-keys\ndescription: \"Use test API keys\"\n---\n\nNever ship live payments keys.\n";

    #[test]
    fn a_projects_scopes_include_its_worktrees() {
        // The thing Claude Code's own scoping does not do: a memory written in
        // a worktree is invisible to the repository it was made from.
        let (home, _repo, project) = project_corpus(&[("a.md", NOTE_A)], &[("b.md", NOTE_B)]);
        let root = home.path().join("projects");
        let scopes = scopes_for_project(&root, &project);
        assert_eq!(scopes.len(), 2, "{scopes:?}");
        assert!(scopes.iter().any(|s| !s.is_worktree));
        assert!(scopes.iter().any(|s| s.is_worktree));
    }

    #[test]
    fn a_project_with_no_memories_has_no_scopes() {
        let home = tempfile::tempdir().unwrap();
        let repo = tempfile::tempdir().unwrap();
        assert!(scopes_for_project(&home.path().join("projects"), repo.path()).is_empty());
    }

    #[test]
    fn a_trailing_slash_is_the_same_project() {
        let (home, _repo, project) = project_corpus(&[("a.md", NOTE_A)], &[]);
        let root = home.path().join("projects");
        let spelled = PathBuf::from(format!("{}/", project.display()));
        assert_eq!(scopes_for_project(&root, &spelled).len(), 1);
    }

    #[test]
    fn search_ranks_a_name_hit_above_a_body_hit_and_says_nothing_for_a_miss() {
        let (home, _repo, project) = project_corpus(&[("a.md", NOTE_A), ("b.md", NOTE_B)], &[]);
        let root = home.path().join("projects");
        let slugs: Vec<String> = scopes_for_project(&root, &project)
            .into_iter()
            .map(|s| s.slug)
            .collect();

        let hits = search_in(&root, &slugs, "payments", 10);
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].memory.name, "payments-provider-migration");
        assert!(hits[0].score > hits[1].score);

        assert!(search_in(&root, &slugs, "kubernetes", 10).is_empty());
        assert!(search_in(&root, &slugs, "   ", 10).is_empty());
    }

    #[test]
    fn search_requires_every_word_and_honours_the_limit() {
        let (home, _repo, project) = project_corpus(&[("a.md", NOTE_A), ("b.md", NOTE_B)], &[]);
        let root = home.path().join("projects");
        let slugs: Vec<String> = scopes_for_project(&root, &project)
            .into_iter()
            .map(|s| s.slug)
            .collect();

        assert_eq!(search_in(&root, &slugs, "keys", 10).len(), 2);
        assert_eq!(search_in(&root, &slugs, "keys publisher", 10).len(), 1);
        assert_eq!(search_in(&root, &slugs, "keys", 1).len(), 1);
    }

    #[test]
    fn find_matches_the_frontmatter_name_case_insensitively() {
        let (home, _repo, project) = project_corpus(&[("a.md", NOTE_A)], &[]);
        let root = home.path().join("projects");
        let slugs: Vec<String> = scopes_for_project(&root, &project)
            .into_iter()
            .map(|s| s.slug)
            .collect();

        let (memory, body) = find_in(&root, &slugs, "Payments-Provider-Migration").unwrap();
        assert_eq!(memory.name, "payments-provider-migration");
        assert_eq!(body, NOTE_A, "the whole file, frontmatter included");
        assert!(find_in(&root, &slugs, "not-a-memory").is_none());
    }

    #[test]
    fn backlinks_are_the_memories_pointing_at_one() {
        let (home, _repo, project) = project_corpus(&[("a.md", NOTE_A), ("b.md", NOTE_B)], &[]);
        let root = home.path().join("projects");
        let slugs: Vec<String> = scopes_for_project(&root, &project)
            .into_iter()
            .map(|s| s.slug)
            .collect();

        let sources = backlinks_in(&root, &slugs, "internal-builds-test-keys");
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].name, "payments-provider-migration");
        assert!(backlinks_in(&root, &slugs, "payments-provider-migration").is_empty());
    }

    // -- the watcher -------------------------------------------------------

    #[test]
    fn a_quiet_scope_never_reports_a_change() {
        let tmp = tempfile::tempdir().unwrap();
        corpus(tmp.path(), "-a-Project", &[("a.md", FULL)]);
        let watcher = MindWatcher::default();
        watcher.watch(tmp.path(), "-a-Project");

        assert!(watcher.poll(tmp.path()).is_empty());
    }

    #[test]
    fn reports_a_memory_being_created() {
        let tmp = tempfile::tempdir().unwrap();
        corpus(tmp.path(), "-a-Project", &[("a.md", FULL)]);
        let watcher = MindWatcher::default();
        watcher.watch(tmp.path(), "-a-Project");

        std::fs::write(memory_dir(tmp.path(), "-a-Project").join("b.md"), FULL).unwrap();
        let events = watcher.poll(tmp.path());

        assert_eq!(events.len(), 1);
        assert_eq!(events[0].scope, "-a-Project");
        // …once. The new listing is the baseline now.
        assert!(watcher.poll(tmp.path()).is_empty());
    }

    #[test]
    fn reports_a_memory_being_edited_in_place() {
        // The case a directory-mtime watcher misses, and the common one: an
        // agent updates a memory far more often than it writes a new one.
        let tmp = tempfile::tempdir().unwrap();
        corpus(tmp.path(), "-a-Project", &[("a.md", FULL)]);
        let watcher = MindWatcher::default();
        watcher.watch(tmp.path(), "-a-Project");

        std::fs::write(
            memory_dir(tmp.path(), "-a-Project").join("a.md"),
            format!("{FULL}\nAnd another paragraph.\n"),
        )
        .unwrap();

        assert_eq!(watcher.poll(tmp.path()).len(), 1);
    }

    #[test]
    fn reports_a_memory_being_deleted() {
        let tmp = tempfile::tempdir().unwrap();
        corpus(tmp.path(), "-a-Project", &[("a.md", FULL), ("b.md", FULL)]);
        let watcher = MindWatcher::default();
        watcher.watch(tmp.path(), "-a-Project");

        std::fs::remove_file(memory_dir(tmp.path(), "-a-Project").join("b.md")).unwrap();

        assert_eq!(watcher.poll(tmp.path()).len(), 1);
    }

    #[test]
    fn the_last_holder_out_stops_the_watch() {
        let tmp = tempfile::tempdir().unwrap();
        corpus(tmp.path(), "-a-Project", &[("a.md", FULL)]);
        let watcher = MindWatcher::default();
        watcher.watch(tmp.path(), "-a-Project");
        watcher.watch(tmp.path(), "-a-Project");

        watcher.unwatch("-a-Project");
        std::fs::write(memory_dir(tmp.path(), "-a-Project").join("b.md"), FULL).unwrap();
        assert_eq!(
            watcher.poll(tmp.path()).len(),
            1,
            "still watched by the second holder"
        );

        watcher.unwatch("-a-Project");
        std::fs::write(memory_dir(tmp.path(), "-a-Project").join("c.md"), FULL).unwrap();
        assert!(watcher.poll(tmp.path()).is_empty(), "nobody is watching");
    }

    #[test]
    fn unwatching_something_never_watched_is_a_no_op() {
        let tmp = tempfile::tempdir().unwrap();
        let watcher = MindWatcher::default();
        watcher.unwatch("-never-watched");
        assert!(watcher.poll(tmp.path()).is_empty());
    }

    #[test]
    fn a_scope_with_no_memory_directory_is_watched_without_emitting() {
        // Watched before its first memory exists — a workspace opened on a
        // project nobody has written a memory for yet. It must start reporting
        // when one appears, not refuse the watch.
        let tmp = tempfile::tempdir().unwrap();
        let watcher = MindWatcher::default();
        watcher.watch(tmp.path(), "-a-Fresh");
        assert!(watcher.poll(tmp.path()).is_empty());

        corpus(tmp.path(), "-a-Fresh", &[("first.md", FULL)]);
        assert_eq!(watcher.poll(tmp.path()).len(), 1);
    }

    #[test]
    fn the_registry_is_free_while_the_poll_reads() {
        // A memory directory on a stalled volume must not block every other
        // scope's watch and unwatch behind one guard.
        let tmp = tempfile::tempdir().unwrap();
        corpus(tmp.path(), "-a-Project", &[("a.md", FULL)]);
        let watcher = MindWatcher::default();
        watcher.watch(tmp.path(), "-a-Project");

        let mut reads = 0;
        let events = watcher.poll_with(|slug| {
            reads += 1;
            assert!(
                watcher.scopes.try_lock().is_ok(),
                "the registry was held across the read"
            );
            stamp_of(&memory_dir(tmp.path(), slug))
        });

        assert_eq!(reads, 1);
        assert!(events.is_empty());
    }

    #[test]
    fn a_scope_unwatched_mid_poll_is_not_reported() {
        let tmp = tempfile::tempdir().unwrap();
        corpus(tmp.path(), "-a-Project", &[("a.md", FULL)]);
        let watcher = MindWatcher::default();
        watcher.watch(tmp.path(), "-a-Project");

        let events = watcher.poll_with(|slug| {
            watcher.unwatch(slug);
            vec![("changed.md".to_string(), 1, 1)]
        });

        assert!(events.is_empty(), "nobody is watching that scope now");
        assert!(watcher.scopes.lock().unwrap().is_empty());
    }

    // -- against the real corpus -------------------------------------------

    #[test]
    fn agrees_with_the_corpus_on_this_machine() {
        // Everything above is a fixture, which proves the parser but not the
        // assumption underneath it — that this is the shape Claude Code
        // actually writes. Skipped where there is no corpus (CI, a fresh
        // machine) rather than failing.
        let Some(root) = projects_root() else { return };
        let scopes = scopes_in(&root);
        if scopes.is_empty() {
            eprintln!("[rocmind] skipping: no memories under {}", root.display());
            return;
        }
        let mut links = 0usize;
        for scope in &scopes {
            assert!(
                !scope.label.is_empty() && !scope.label.starts_with('-'),
                "slug {} decoded to {:?}",
                scope.slug,
                scope.project_path
            );
            assert!(
                Path::new(&scope.project_path).is_dir(),
                "slug {} decoded to a path that is not there: {}",
                scope.slug,
                scope.project_path
            );
            let memories = list_in(&root, &scope.slug);
            assert_eq!(memories.len(), scope.count, "scope {}", scope.slug);
            for memory in &memories {
                assert!(!memory.name.is_empty(), "{}", memory.path);
                assert!(read_in(&root, &memory.path).is_ok(), "{}", memory.path);
                links += memory.links.len();
            }
        }
        // The corpus is a linked graph, not a pile of files. Zero here would
        // mean link extraction silently stopped working against the real
        // format while every fixture above still passed.
        assert!(links > 0, "no wikilinks found in {} scopes", scopes.len());
    }
}
