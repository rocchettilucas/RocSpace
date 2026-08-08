//! Which branch is a directory on, and a thread that says when that changes.
//!
//! The pane header carries a branch chip, so the question gets asked once per
//! pane and again every couple of seconds. That rules out shelling out to
//! `git`: a process spawn per pane per poll is real cost, it needs `git` on
//! PATH, and it inherits whatever the user's `git` config does on a slow
//! network remote. Reading `HEAD` is one small file read and answers the same
//! question — Git writes that file atomically (write to a temp file, rename),
//! so a checkout is never observed half-applied.
//!
//! Std-only and polling, mirroring `pty/runtime.rs` and `agents/events.rs`:
//! a filesystem watcher is another dependency and another set of platform
//! quirks for a chip that nobody notices going stale for two seconds.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, Emitter, Manager};

/// Event name — mirrored in `src/lib/bindings.ts`.
pub const EVENT_GIT_BRANCH: &str = "git://branch";

/// Event name — mirrored in `src/lib/bindings.ts`.
///
/// "Something `git status` would answer differently has happened in this
/// repository." A superset of `git://branch`: every checkout is also this.
///
/// Two events rather than one because they have different audiences and one of
/// them is expensive to wake. The pane header's chip redraws only for a branch,
/// and an agent doing its job stages and commits constantly — pointing the chip
/// at this stream would re-render every pane header in the project several
/// times a minute to set the same string it already had.
pub const EVENT_GIT_STATUS: &str = "git://status";

/// How often every watched path's `HEAD` is re-read.
const POLL_INTERVAL: Duration = Duration::from_secs(2);

/// Length of the abbreviated sha shown for a detached HEAD. Seven is what
/// `git log --oneline` uses, so it is the form the user already reads.
const SHORT_SHA_LEN: usize = 7;

/// Payload of `git://branch`. `branch: None` means "not a repository" — the
/// header hides the chip entirely rather than showing an empty pill.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitBranchEvent {
    /// The repository this is about, as `git_watch` returned it — NOT the path
    /// a pane asked about. One repository has one watch however many panes sit
    /// in it and however deep, so the pane's own cwd is not what identifies
    /// this. The renderer keeps the root `git_watch` handed it and matches on
    /// that.
    pub root: String,
    pub branch: Option<String>,
}

/// Payload of `git://status`. No branch: the answer is "re-read this
/// repository", and the renderer's own `git status` is what says what changed.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusEvent {
    /// The repository this is about, labelled exactly as `GitBranchEvent` is.
    pub root: String,
}

/// What `git_watch` hands back: the key the caller's path resolved to — which
/// is what the `git://branch` events that follow will be labelled with — and
/// the branch that key was seeded with.
///
/// The branch is here rather than behind a second command because the seed and
/// the answer have to be the SAME read. Asked separately, a checkout landing
/// between the two leaves the renderer showing what the first read saw while
/// the watcher's baseline holds what the second read saw — and since the
/// watcher only speaks when its baseline moves, it never corrects the chip.
/// The pane sits on a branch it is not on until something else changes.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitWatchHandle {
    pub root: String,
    pub branch: Option<String>,
}

impl From<WatchSeed> for GitWatchHandle {
    /// Goes through `key_string`, the same function the events go through, so
    /// the string the renderer stores and the strings it matches against
    /// cannot drift apart.
    fn from(seed: WatchSeed) -> Self {
        Self {
            root: key_string(&seed.root),
            branch: seed.branch,
        }
    }
}

/// A registration's result: where it is filed, and the branch on file for it.
pub struct WatchSeed {
    pub root: PathBuf,
    pub branch: Option<String>,
}

/// The branch `path` is on: the checked-out branch name, a 7-character sha
/// when HEAD is detached, or `None` when `path` is not inside a repository.
///
/// Walks up from `path` the way Git itself does, so a pane whose cwd is a
/// subdirectory still reports the repo's branch.
pub fn branch_at(path: &Path) -> Option<String> {
    branch_at_root(&repo_root_at(path)?)
}

/// `branch_at` for a directory already known to be a repository root — the
/// form the watcher uses, because it has already resolved the root once and
/// walking up from it again on every poll would be work with a known answer.
fn branch_at_root(root: &Path) -> Option<String> {
    let git_dir = git_dir_in(root)?;
    let head = std::fs::read_to_string(git_dir.join("HEAD")).ok()?;
    parse_head(&head)
}

/// `HEAD`'s contents → what to show.
///
/// Two shapes exist. A symbolic ref (`ref: refs/heads/main`) is the normal
/// case; anything else is a raw object id, which is what a detached HEAD looks
/// like — mid-rebase, mid-bisect, or on a checked-out tag.
///
/// A ref that is not under `refs/heads/` keeps its full name rather than being
/// trimmed to its last segment: `refs/remotes/origin/main` shortened to `main`
/// would read as the local branch, which is the one thing it is not.
fn parse_head(head: &str) -> Option<String> {
    let head = head.trim();
    if head.is_empty() {
        return None;
    }
    match head.strip_prefix("ref:") {
        Some(reference) => {
            let reference = reference.trim();
            let name = reference.strip_prefix("refs/heads/").unwrap_or(reference);
            // A symbolic ref with nothing after it — `ref:` alone, or
            // `ref: refs/heads/` — is not a branch called "". Left as
            // `Some("")` it reaches the header as a real answer and draws an
            // empty pill, which says a repository is on a branch with no name
            // rather than that we could not tell.
            if name.is_empty() {
                return None;
            }
            Some(name.to_string())
        }
        // Detached: an object id. Abbreviated for the chip, which has room for
        // about that much and no use for the rest.
        None => Some(head.chars().take(SHORT_SHA_LEN).collect()),
    }
}

/// Canonical form of `path`, or `path` as given when it cannot be resolved
/// (it does not exist yet, or the volume is not answering).
///
/// Everything that identifies a directory goes through this, so `~/p`, `~/p/`,
/// `~/p/src/..` and a symlink to `~/p` are one directory rather than four.
fn canonical(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// The repository containing `path`: the nearest ancestor holding a `.git`,
/// canonicalized. `None` when there is no such ancestor.
///
/// Note that a linked worktree IS its own root — it holds its own `.git` — and
/// that is correct, because it also has its own HEAD and can sit on a
/// different branch from the repository it was made from.
pub fn repo_root_at(path: &Path) -> Option<PathBuf> {
    let start = canonical(path);
    let mut dir = start.as_path();
    loop {
        let candidate = dir.join(".git");
        if candidate.is_dir() || candidate.is_file() {
            return Some(dir.to_path_buf());
        }
        dir = dir.parent()?;
    }
}

/// The directory holding `HEAD` for the repository rooted at `root`.
///
/// `.git` is a directory in an ordinary clone and a *file* in a linked
/// worktree or a submodule, where it holds `gitdir: <path>` pointing at the
/// real thing (`<main>/.git/worktrees/<name>`). That indirection is not a
/// detail we can skip: RocSpace's own development happens in worktrees, and
/// without it every pane in one reports "not a repository".
fn git_dir_in(root: &Path) -> Option<PathBuf> {
    let candidate = root.join(".git");
    if candidate.is_dir() {
        return Some(candidate);
    }
    if candidate.is_file() {
        return resolve_gitdir_file(&candidate, root);
    }
    None
}

/// Read a `.git` file's `gitdir:` line. A relative target resolves against the
/// directory the `.git` file lives in, which is what Git does.
fn resolve_gitdir_file(git_file: &Path, base: &Path) -> Option<PathBuf> {
    let contents = std::fs::read_to_string(git_file).ok()?;
    let target = contents
        .lines()
        .find_map(|line| line.trim().strip_prefix("gitdir:"))?
        .trim();
    if target.is_empty() {
        return None;
    }
    let target = Path::new(target);
    Some(if target.is_absolute() {
        target.to_path_buf()
    } else {
        base.join(target)
    })
}

// -- what `git status` reads -----------------------------------------------

/// A file's identity for the one question asked of it here: has git replaced
/// this since the last look? Modification time and length, which is what a
/// single `stat` already answers.
///
/// Git publishes almost everything below by writing a lock file and renaming it
/// over the top, so the file the next poll stats is a different file rather
/// than the same one edited — which is exactly the case mtime is reliable for.
type Stamp = (std::time::SystemTime, u64);

fn stamp(path: &Path) -> Option<Stamp> {
    let meta = std::fs::metadata(path).ok()?;
    Some((meta.modified().ok()?, meta.len()))
}

/// "Would `git status` say something different now?", reduced to five `stat`s.
///
/// The panel's whole problem was that HEAD is the one thing the interesting
/// operations DON'T touch. Measured against a real repository:
///
///   * `git add` / `git reset` rewrite `index` and nothing else.
///   * `git commit` rewrites `index` AND moves `refs/heads/<branch>`.
///   * `git checkout` rewrites `index` and `HEAD`.
///
/// So `index` alone carries staging, unstaging, committing and checking out —
/// the three verbs an agent in the pane next door performs — and the rest are
/// one `stat` each of belt and braces.
///
/// Not covered, and deliberately: a bare edit to a tracked file, which changes
/// what `git status` reports while touching nothing inside `.git` at all.
/// Catching that means watching the working tree, which is a filesystem watcher
/// over the whole project — a different order of machinery, and the window's
/// focus handler already covers the case a human made the edit.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
struct StatusFingerprint {
    /// Staging, unstaging, committing, checking out. The load-bearing one.
    index: Option<Stamp>,
    /// The ref HEAD points at — a commit moves this and leaves HEAD alone.
    head_ref: Option<Stamp>,
    /// …and where refs go when git packs them away instead.
    packed_refs: Option<Stamp>,
    /// A merge or a rebase in flight. The panel does not draw the words, but
    /// every step of one is a moment its file lists change underneath it.
    merge_head: Option<Stamp>,
    rebase_head: Option<Stamp>,
}

/// Everything the watcher remembers about one repository.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
struct RepoSnapshot {
    branch: Option<String>,
    status: StatusFingerprint,
}

/// The loose ref file `HEAD` names, when it names one.
///
/// Absent in a linked worktree — its refs live in the MAIN git dir, not beside
/// its own HEAD — which costs nothing, because the worktree has an `index` of
/// its own and that is the signal that matters. The `..` guard is not about
/// safety (nothing is read, only stat'd) but about never walking out of the
/// repository on the say-so of a file inside it.
fn head_ref_path(git_dir: &Path, head: &str) -> Option<PathBuf> {
    let reference = head.trim().strip_prefix("ref:")?.trim();
    if reference.is_empty() || reference.contains("..") {
        return None;
    }
    Some(git_dir.join(reference))
}

/// One look at a repository: the branch, and the fingerprint above.
///
/// A directory that is not (or is no longer) a repository answers with the
/// default, so it compares equal to another such look and a non-repository
/// stays silent.
fn snapshot_at(root: &Path) -> RepoSnapshot {
    let Some(git_dir) = git_dir_in(root) else {
        return RepoSnapshot::default();
    };
    let head = std::fs::read_to_string(git_dir.join("HEAD")).ok();
    RepoSnapshot {
        branch: head.as_deref().and_then(parse_head),
        status: StatusFingerprint {
            index: stamp(&git_dir.join("index")),
            head_ref: head
                .as_deref()
                .and_then(|h| head_ref_path(&git_dir, h))
                .as_deref()
                .and_then(stamp),
            packed_refs: stamp(&git_dir.join("packed-refs")),
            merge_head: stamp(&git_dir.join("MERGE_HEAD")),
            rebase_head: stamp(&git_dir.join("REBASE_HEAD")),
        },
    }
}

// -- watcher ---------------------------------------------------------------

/// One repository whose state moved, and whether the BRANCH is what moved.
#[derive(Debug, Clone)]
pub struct RepoChange {
    pub root: String,
    pub branch: Option<String>,
    /// `git://branch` is emitted only for these. A `git add`, a commit, a
    /// rebase step: all of them are `git://status` and nothing more.
    pub branch_moved: bool,
}

/// One watched repository: how many panes asked for it, and what was last seen.
struct Watched {
    /// Panes sharing this repository. Several panes usually live in one, and
    /// the last one to close is the only one allowed to stop the polling.
    refs: usize,
    /// What the watcher last saw. Seeded when the repository is first watched,
    /// so one that never changes never emits.
    last: RepoSnapshot,
}

/// The key a path is watched under.
///
/// The repository root, so that every pane in one project — including panes
/// whose cwd is some subdirectory of another pane's — is one entry, one HEAD
/// read per poll, and one event. Keying on the raw string a pane passed in
/// made `~/p`, `~/p/`, `~/p/src` and a symlink to `~/p` four separate watches
/// of the same file, all polling, all emitting, all having to agree.
///
/// A directory that is not in a repository falls back to its own canonical
/// path rather than being refused, so `git init` typed into that pane lights
/// its chip on the next poll instead of needing the pane reopened.
fn watch_key(path: &Path) -> PathBuf {
    repo_root_at(path).unwrap_or_else(|| canonical(path))
}

/// The renderer-facing form of a key. One function so the string `git_watch`
/// returns and the string the events carry cannot drift apart.
fn key_string(key: &Path) -> String {
    key.to_string_lossy().into_owned()
}

/// Registry of repositories whose `HEAD` is being followed. Managed by Tauri;
/// the `git_watch` / `git_unwatch` commands and the poll thread share it.
#[derive(Default)]
pub struct GitWatcher {
    roots: Mutex<HashMap<PathBuf, Watched>>,
}

impl GitWatcher {
    /// Start following the repository `path` is in (or add a reference to a
    /// watch already on it).
    ///
    /// Returns the key it resolved to — the caller must keep it, because it is
    /// what identifies this watch's events and what `unwatch` takes — together
    /// with THE BASELINE, not a fresh read. The current branch is recorded
    /// immediately rather than left blank, so the first poll of a quiet
    /// repository is silent: `git://branch` means "this changed", never "here
    /// is what it has always been". Handing that same value back is what makes
    /// the caller's opening value and the watcher's baseline the same number,
    /// so there is no window in which they can disagree.
    pub fn watch(&self, path: &Path) -> WatchSeed {
        // Resolving the root is itself a `canonicalize` and a few `stat`s, so
        // it happens before the lock is taken rather than under it.
        let root = watch_key(path);

        // Already watched: no read to do, so nothing is held for longer than a
        // map lookup. This is the common case — the second pane in a project,
        // and every pane after it. It gets the standing baseline rather than a
        // reading of its own, which may be up to one poll interval old; that is
        // the right trade, because a value that agrees with the baseline is
        // corrected by the next poll, while a fresher one that disagrees with
        // it never is.
        {
            let mut roots = self.lock();
            if let Some(entry) = roots.get_mut(&root) {
                entry.refs += 1;
                let branch = entry.last.branch.clone();
                return WatchSeed { root, branch };
            }
        }

        // Seeding a NEW repository means a file read, which on a stalled
        // network volume takes as long as it takes. Done with the registry
        // released, so every other pane's watch, unwatch and poll carries on
        // rather than queueing behind this one directory.
        let last = snapshot_at(&root);

        let mut roots = self.lock();
        let branch = match roots.get_mut(&root) {
            // Another pane watched the same repository while we were reading;
            // its seed is the same read of the same file, so keep it and just
            // take our reference — and answer with the baseline that won.
            Some(entry) => {
                entry.refs += 1;
                entry.last.branch.clone()
            }
            None => {
                let branch = last.branch.clone();
                roots.insert(root.clone(), Watched { refs: 1, last });
                branch
            }
        };
        WatchSeed { root, branch }
    }

    /// Drop one reference to `root`; the last one out stops the watch.
    ///
    /// Takes the key `watch` returned rather than the path that produced it:
    /// re-resolving would be another canonicalize, and it would resolve
    /// *differently* for a directory that has since been deleted or unmounted —
    /// which is exactly when panes are closing.
    pub fn unwatch(&self, root: &Path) {
        let mut roots = self.lock();
        let Some(entry) = roots.get_mut(root) else {
            return;
        };
        entry.refs -= 1;
        if entry.refs == 0 {
            roots.remove(root);
        }
    }

    /// Re-read every watched repository, returning only the ones that moved.
    fn poll(&self) -> Vec<RepoChange> {
        self.poll_with(snapshot_at)
    }

    /// `poll`, with the read injected so a test can look at the registry from
    /// inside it.
    ///
    /// Three phases, and the middle one is the point: snapshot the watched
    /// roots under the lock, read them all with the lock RELEASED, then take
    /// it again to compare and write the new baselines. Reading inside the
    /// loop — one guard held across every canonicalize and every file read —
    /// meant a single directory on a stalled network volume blocked the whole
    /// registry for as long as it hung, and `git_watch` / `git_unwatch` queued
    /// behind it.
    fn poll_with(&self, mut read: impl FnMut(&Path) -> RepoSnapshot) -> Vec<RepoChange> {
        let watched: Vec<PathBuf> = self.lock().keys().cloned().collect();
        let fresh: Vec<(PathBuf, RepoSnapshot)> = watched
            .into_iter()
            .map(|root| {
                let snapshot = read(&root);
                (root, snapshot)
            })
            .collect();

        let mut roots = self.lock();
        let mut changed = Vec::new();
        for (root, snapshot) in fresh {
            // Gone while we were reading — the last pane on it closed. There is
            // nobody to tell, and re-inserting it would resurrect a watch
            // nothing asked for.
            let Some(entry) = roots.get_mut(&root) else {
                continue;
            };
            if entry.last == snapshot {
                continue;
            }
            // One change per repository per poll, whatever happened in the two
            // seconds since the last one. This is the whole coalescing story: a
            // rebase replaying forty commits, or a checkout rewriting ten
            // thousand files, moves these files hundreds of times and still
            // produces one event per tick — there is no burst to debounce
            // because the sampling never sees one.
            let branch_moved = entry.last.branch != snapshot.branch;
            entry.last = snapshot.clone();
            changed.push(RepoChange {
                root: key_string(&root),
                branch: snapshot.branch,
                branch_moved,
            });
        }
        changed
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<PathBuf, Watched>> {
        self.roots.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// Start the poll thread. Runs for the lifetime of the app; with nothing
/// watched it is a 2-second sleep loop over an empty map.
pub fn spawn_watcher(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(POLL_INTERVAL);
        let Some(watcher) = app.try_state::<GitWatcher>() else {
            return;
        };
        for change in watcher.poll() {
            // The chip's stream stays narrow — only an actual branch move —
            // while the panel's carries everything. See `EVENT_GIT_STATUS`.
            if change.branch_moved {
                let _ = app.emit(
                    EVENT_GIT_BRANCH,
                    &GitBranchEvent {
                        root: change.root.clone(),
                        branch: change.branch,
                    },
                );
            }
            let _ = app.emit(EVENT_GIT_STATUS, &GitStatusEvent { root: change.root });
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A repository skeleton: just enough of `.git` for `branch_at` to work,
    /// built by hand so the suite does not depend on a `git` binary.
    fn fake_repo(root: &Path, head: &str) {
        let git_dir = root.join(".git");
        std::fs::create_dir_all(&git_dir).unwrap();
        std::fs::write(git_dir.join("HEAD"), head).unwrap();
    }

    /// Run `git` in `repo` and insist it worked. For the tests that are about
    /// what git actually writes, where a hand-built fixture would only prove
    /// the fixture.
    fn git(repo: &Path, args: &[&str]) {
        let out = std::process::Command::new("git")
            .args(args)
            .current_dir(repo)
            .output()
            .expect("git disappeared mid-test");
        assert!(
            out.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    /// A real repository with one commit in it, or `None` where `git` is not
    /// installed — skipped rather than failed, matching `agrees_with_a_…`.
    fn real_repo(dir: &Path) -> Option<&Path> {
        let init = std::process::Command::new("git")
            .args(["init", "-b", "main", "."])
            .current_dir(dir)
            .output()
            .ok()?;
        if !init.status.success() {
            eprintln!("[git_info] skipping: git init failed");
            return None;
        }
        git(dir, &["config", "user.email", "test@rocspace.invalid"]);
        git(dir, &["config", "user.name", "RocSpace Test"]);
        std::fs::write(dir.join("a.txt"), "a\n").unwrap();
        git(dir, &["add", "a.txt"]);
        git(dir, &["commit", "-m", "one"]);
        Some(dir)
    }

    /// Make a tracked file's stat information disagree with the index, which is
    /// what makes `git status` want to rewrite it. Writing the same bytes is
    /// enough — it is the mtime git compares, not the content.
    fn filetime_bump(path: &Path) {
        std::thread::sleep(Duration::from_millis(10));
        let existing = std::fs::read(path).unwrap();
        std::fs::write(path, existing).unwrap();
    }

    /// The exact question `git::git_status` asks, so what this sees is what the
    /// panel would draw.
    fn porcelain(repo: &Path) -> String {
        let out = std::process::Command::new("git")
            .args(["--no-optional-locks", "status", "--porcelain=v1"])
            .current_dir(repo)
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    // -- HEAD parsing ------------------------------------------------------

    #[test]
    fn reads_a_symbolic_head_as_a_bare_branch_name() {
        let tmp = tempfile::tempdir().unwrap();
        fake_repo(tmp.path(), "ref: refs/heads/main\n");
        assert_eq!(branch_at(tmp.path()), Some("main".to_string()));
    }

    #[test]
    fn keeps_the_slashes_in_a_branch_name() {
        let tmp = tempfile::tempdir().unwrap();
        fake_repo(tmp.path(), "ref: refs/heads/revamp/phase-1b-chrome\n");
        assert_eq!(
            branch_at(tmp.path()),
            Some("revamp/phase-1b-chrome".to_string())
        );
    }

    #[test]
    fn shortens_a_detached_head_to_seven_characters() {
        let tmp = tempfile::tempdir().unwrap();
        fake_repo(tmp.path(), "9f8e7d6c5b4a39281706fedcba9876543210abcd\n");
        assert_eq!(branch_at(tmp.path()), Some("9f8e7d6".to_string()));
    }

    #[test]
    fn tolerates_a_head_written_with_crlf() {
        let tmp = tempfile::tempdir().unwrap();
        fake_repo(tmp.path(), "ref: refs/heads/main\r\n");
        assert_eq!(branch_at(tmp.path()), Some("main".to_string()));
    }

    #[test]
    fn keeps_a_ref_that_is_not_a_local_branch_intact() {
        // Trimming this to `main` would read as the local branch, which is the
        // one thing it is not.
        let tmp = tempfile::tempdir().unwrap();
        fake_repo(tmp.path(), "ref: refs/remotes/origin/main\n");
        assert_eq!(
            branch_at(tmp.path()),
            Some("refs/remotes/origin/main".to_string())
        );
    }

    // -- locating the git dir ----------------------------------------------

    #[test]
    fn walks_up_from_a_nested_directory() {
        let tmp = tempfile::tempdir().unwrap();
        fake_repo(tmp.path(), "ref: refs/heads/main\n");
        let nested = tmp.path().join("src").join("views").join("RocDock");
        std::fs::create_dir_all(&nested).unwrap();
        assert_eq!(branch_at(&nested), Some("main".to_string()));
    }

    #[test]
    fn returns_none_outside_a_repository() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(branch_at(tmp.path()), None);
    }

    #[test]
    fn returns_none_when_the_path_does_not_exist() {
        assert_eq!(
            branch_at(Path::new("/nonexistent-rocspace-test-path")),
            None
        );
    }

    #[test]
    fn returns_none_when_head_is_missing() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join(".git")).unwrap();
        assert_eq!(branch_at(tmp.path()), None);
    }

    #[test]
    fn returns_none_for_an_empty_head() {
        let tmp = tempfile::tempdir().unwrap();
        fake_repo(tmp.path(), "\n");
        assert_eq!(branch_at(tmp.path()), None);
    }

    #[test]
    fn returns_none_for_a_symbolic_head_pointing_at_nothing() {
        // `ref:` with no target parsed to `Some("")`, which is not "no branch"
        // to anything downstream — the header would draw an empty pill.
        let tmp = tempfile::tempdir().unwrap();
        fake_repo(tmp.path(), "ref: \n");
        assert_eq!(branch_at(tmp.path()), None);

        fake_repo(tmp.path(), "ref:\n");
        assert_eq!(branch_at(tmp.path()), None);

        fake_repo(tmp.path(), "ref: \t \n");
        assert_eq!(branch_at(tmp.path()), None);
    }

    #[test]
    fn returns_none_for_a_ref_that_is_only_the_heads_prefix() {
        // `refs/heads/` with nothing after it strips to the same empty string.
        let tmp = tempfile::tempdir().unwrap();
        fake_repo(tmp.path(), "ref: refs/heads/\n");
        assert_eq!(branch_at(tmp.path()), None);
    }

    // -- worktrees (a `.git` file, not a directory) ------------------------

    #[test]
    fn follows_a_relative_gitdir_file_into_the_main_repository() {
        // The shape `git worktree add` writes: the worktree's `.git` is a file
        // pointing at `<main>/.git/worktrees/<name>`, which holds its own HEAD.
        // RocSpace itself is developed in worktrees, so getting this wrong
        // means the chip is blank in exactly the repo that built it.
        let tmp = tempfile::tempdir().unwrap();
        let main = tmp.path().join("main");
        let worktree = tmp.path().join("wt-1b");
        let linked = main.join(".git").join("worktrees").join("wt-1b");
        std::fs::create_dir_all(&linked).unwrap();
        std::fs::write(linked.join("HEAD"), "ref: refs/heads/phase-1b\n").unwrap();
        std::fs::create_dir_all(&worktree).unwrap();
        std::fs::write(
            worktree.join(".git"),
            "gitdir: ../main/.git/worktrees/wt-1b\n",
        )
        .unwrap();

        assert_eq!(branch_at(&worktree), Some("phase-1b".to_string()));
    }

    #[test]
    fn follows_an_absolute_gitdir_file() {
        let tmp = tempfile::tempdir().unwrap();
        let real = tmp.path().join("elsewhere");
        std::fs::create_dir_all(&real).unwrap();
        std::fs::write(real.join("HEAD"), "ref: refs/heads/detour\n").unwrap();
        let repo = tmp.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        std::fs::write(repo.join(".git"), format!("gitdir: {}\n", real.display())).unwrap();

        assert_eq!(branch_at(&repo), Some("detour".to_string()));
    }

    #[test]
    fn returns_none_for_a_gitdir_file_with_nothing_useful_in_it() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join(".git"), "not a gitdir line\n").unwrap();
        assert_eq!(branch_at(tmp.path()), None);
    }

    // -- against the real thing --------------------------------------------

    #[test]
    fn agrees_with_a_repository_git_itself_created() {
        // Everything above is a hand-built fixture, which proves the parser but
        // not the assumption underneath it — that this is the layout `git`
        // actually writes. Skipped where `git` is not installed rather than
        // failing: the parser tests already cover the logic.
        let tmp = tempfile::tempdir().unwrap();
        let Ok(out) = std::process::Command::new("git")
            .args(["init", "-b", "rocspace-test", "."])
            .current_dir(tmp.path())
            .output()
        else {
            eprintln!("[git_info] skipping: no git on PATH");
            return;
        };
        if !out.status.success() {
            eprintln!(
                "[git_info] skipping: git init failed: {}",
                String::from_utf8_lossy(&out.stderr)
            );
            return;
        }

        assert_eq!(branch_at(tmp.path()), Some("rocspace-test".to_string()));
    }

    // -- watcher -----------------------------------------------------------

    #[test]
    fn a_quiet_repository_never_reports_a_change() {
        let tmp = tempfile::tempdir().unwrap();
        fake_repo(tmp.path(), "ref: refs/heads/main\n");
        let watcher = GitWatcher::default();
        watcher.watch(tmp.path());

        assert!(watcher.poll().is_empty());
    }

    #[test]
    fn reports_a_checkout() {
        let tmp = tempfile::tempdir().unwrap();
        fake_repo(tmp.path(), "ref: refs/heads/main\n");
        let watcher = GitWatcher::default();
        let root = watcher.watch(tmp.path()).root;

        fake_repo(tmp.path(), "ref: refs/heads/feature\n");
        let events = watcher.poll();

        assert_eq!(events.len(), 1);
        // Labelled with the root, which is what `git_watch` handed the caller.
        assert_eq!(events[0].root, key_string(&root));
        assert_eq!(events[0].branch, Some("feature".to_string()));
        // …once. The new branch is now the baseline.
        assert!(watcher.poll().is_empty());
    }

    #[test]
    fn reports_a_repository_that_stops_being_one() {
        let tmp = tempfile::tempdir().unwrap();
        fake_repo(tmp.path(), "ref: refs/heads/main\n");
        let watcher = GitWatcher::default();
        watcher.watch(tmp.path());

        std::fs::remove_dir_all(tmp.path().join(".git")).unwrap();
        let events = watcher.poll();

        assert_eq!(events.len(), 1);
        assert_eq!(events[0].branch, None);
    }

    #[test]
    fn a_non_repository_is_watched_without_ever_emitting() {
        let tmp = tempfile::tempdir().unwrap();
        let watcher = GitWatcher::default();
        watcher.watch(tmp.path());

        assert!(watcher.poll().is_empty());
    }

    #[test]
    fn a_directory_that_becomes_a_repository_is_still_being_watched() {
        // Why a non-repository falls back to its own path as a key instead of
        // being refused a watch: `git init` typed into that pane should light
        // its chip on the next poll, not on the next time the pane is opened.
        let tmp = tempfile::tempdir().unwrap();
        let watcher = GitWatcher::default();
        watcher.watch(tmp.path());
        assert!(watcher.poll().is_empty());

        fake_repo(tmp.path(), "ref: refs/heads/main\n");
        let events = watcher.poll();

        assert_eq!(events.len(), 1);
        assert_eq!(events[0].branch, Some("main".to_string()));
    }

    #[test]
    fn the_last_pane_out_stops_the_watch() {
        // Panes in one project share a repository, so unwatching on the first
        // close would blind every pane still open on it.
        let tmp = tempfile::tempdir().unwrap();
        fake_repo(tmp.path(), "ref: refs/heads/main\n");
        let watcher = GitWatcher::default();
        let root = watcher.watch(tmp.path()).root;
        watcher.watch(tmp.path());

        watcher.unwatch(&root);
        fake_repo(tmp.path(), "ref: refs/heads/feature\n");
        assert_eq!(watcher.poll().len(), 1, "still watched by the second pane");

        watcher.unwatch(&root);
        fake_repo(tmp.path(), "ref: refs/heads/third\n");
        assert!(
            watcher.poll().is_empty(),
            "no panes left on this repository"
        );
    }

    #[test]
    fn unwatching_something_never_watched_is_a_no_op() {
        let watcher = GitWatcher::default();
        watcher.unwatch(Path::new("/tmp/never-watched"));
        assert!(watcher.poll().is_empty());
    }

    // -- the seed and the answer are one read ------------------------------

    #[test]
    fn watching_answers_with_the_branch_it_seeded() {
        let tmp = tempfile::tempdir().unwrap();
        fake_repo(tmp.path(), "ref: refs/heads/main\n");
        let watcher = GitWatcher::default();

        assert_eq!(watcher.watch(tmp.path()).branch, Some("main".to_string()));
    }

    #[test]
    fn watching_a_non_repository_answers_with_no_branch() {
        let tmp = tempfile::tempdir().unwrap();
        let watcher = GitWatcher::default();

        assert_eq!(watcher.watch(tmp.path()).branch, None);
    }

    #[test]
    fn a_checkout_between_two_reads_cannot_strand_the_answer() {
        // The race this shape exists to remove. Asked as two commands — "what
        // branch is this?" and "start watching" — a checkout landing between
        // them left the caller holding the first read while the watcher's
        // baseline held the second. The watcher only speaks when its baseline
        // MOVES, so it never corrected the caller: the pane sat on a branch it
        // was not on until something else happened to change.
        //
        // Simulated by checking out between the seed and the next poll, which
        // is the same ordering: whatever `watch` answered, the next poll has to
        // be able to correct it.
        let tmp = tempfile::tempdir().unwrap();
        fake_repo(tmp.path(), "ref: refs/heads/main\n");
        let watcher = GitWatcher::default();

        let seed = watcher.watch(tmp.path());
        fake_repo(tmp.path(), "ref: refs/heads/feature\n");
        let events = watcher.poll();

        assert_eq!(seed.branch, Some("main".to_string()));
        assert_eq!(events.len(), 1, "the answer is correctable, not stranded");
        assert_eq!(events[0].branch, Some("feature".to_string()));
    }

    #[test]
    fn a_second_pane_gets_the_standing_baseline_not_a_fresh_read() {
        // A fresher read that disagrees with the baseline is the strand again,
        // one pane along: the watcher would have nothing to announce, because
        // by its own record nothing moved. Agreeing with the baseline is worth
        // more than being up to two seconds newer.
        let tmp = tempfile::tempdir().unwrap();
        fake_repo(tmp.path(), "ref: refs/heads/main\n");
        let watcher = GitWatcher::default();
        watcher.watch(tmp.path());

        // A checkout the watcher has not polled yet.
        fake_repo(tmp.path(), "ref: refs/heads/feature\n");
        let second = watcher.watch(tmp.path());

        assert_eq!(second.branch, Some("main".to_string()), "the baseline");
        // …and the poll that follows corrects both panes at once.
        let events = watcher.poll();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].branch, Some("feature".to_string()));
    }

    // -- one repository, one watch -----------------------------------------

    #[test]
    fn two_panes_in_one_repository_share_a_single_watch() {
        // The dedupe the root key buys. Two panes at different depths of one
        // project used to be two entries reading the same HEAD twice a second
        // and emitting two events for one checkout, under two different labels.
        let tmp = tempfile::tempdir().unwrap();
        fake_repo(tmp.path(), "ref: refs/heads/main\n");
        let nested = tmp.path().join("src").join("views");
        std::fs::create_dir_all(&nested).unwrap();

        let watcher = GitWatcher::default();
        let a = watcher.watch(tmp.path()).root;
        let b = watcher.watch(&nested).root;

        assert_eq!(a, b, "both panes resolved to the same repository");
        assert_eq!(watcher.roots.lock().unwrap().len(), 1);

        fake_repo(tmp.path(), "ref: refs/heads/feature\n");
        assert_eq!(watcher.poll().len(), 1, "one repository, one event");
    }

    #[test]
    fn the_same_directory_spelled_differently_is_one_watch() {
        // `~/p`, `~/p/` and `~/p/src/..` are one directory, and a pane's cwd
        // arrives in whichever form the workspace happened to store.
        let tmp = tempfile::tempdir().unwrap();
        fake_repo(tmp.path(), "ref: refs/heads/main\n");
        let sub = tmp.path().join("src");
        std::fs::create_dir_all(&sub).unwrap();

        let watcher = GitWatcher::default();
        watcher.watch(tmp.path());
        watcher.watch(&tmp.path().join(""));
        watcher.watch(&sub.join(".."));

        assert_eq!(watcher.roots.lock().unwrap().len(), 1);
    }

    #[test]
    fn two_worktrees_of_one_repository_are_two_watches() {
        // The other direction: linked worktrees hold their own HEAD and sit on
        // their own branches, so collapsing them would report one's checkout
        // as the other's.
        let tmp = tempfile::tempdir().unwrap();
        for (name, branch) in [("wt-a", "phase-a"), ("wt-b", "phase-b")] {
            let linked = tmp
                .path()
                .join("main")
                .join(".git")
                .join("worktrees")
                .join(name);
            std::fs::create_dir_all(&linked).unwrap();
            std::fs::write(linked.join("HEAD"), format!("ref: refs/heads/{branch}\n")).unwrap();
            let wt = tmp.path().join(name);
            std::fs::create_dir_all(&wt).unwrap();
            std::fs::write(
                wt.join(".git"),
                format!("gitdir: ../main/.git/worktrees/{name}\n"),
            )
            .unwrap();
        }

        let watcher = GitWatcher::default();
        let a = watcher.watch(&tmp.path().join("wt-a")).root;
        let b = watcher.watch(&tmp.path().join("wt-b")).root;

        assert_ne!(a, b);
        assert_eq!(watcher.roots.lock().unwrap().len(), 2);
    }

    #[test]
    fn a_watch_is_keyed_on_the_repository_not_the_pane_cwd() {
        let tmp = tempfile::tempdir().unwrap();
        fake_repo(tmp.path(), "ref: refs/heads/main\n");
        let nested = tmp.path().join("src").join("views").join("RocDock");
        std::fs::create_dir_all(&nested).unwrap();

        let watcher = GitWatcher::default();
        let root = watcher.watch(&nested).root;

        assert_eq!(root, canonical(tmp.path()));
    }

    // -- the poll's lock discipline ----------------------------------------

    // -- what `git status` reads -------------------------------------------

    /// The findings this whole fingerprint rests on, against the real thing.
    /// Every one of these operations used to be invisible to the watcher,
    /// because none of them touches `HEAD`.
    #[test]
    fn a_real_repository_reports_staging_and_committing() {
        let tmp = tempfile::tempdir().unwrap();
        let Some(repo) = real_repo(tmp.path()) else {
            return;
        };

        let watcher = GitWatcher::default();
        watcher.watch(repo);
        assert!(watcher.poll().is_empty(), "a quiet repository says nothing");

        // Staging. `git add` rewrites `.git/index` and touches nothing else —
        // the branch has not moved, so the chip must not be woken for it.
        std::fs::write(repo.join("b.txt"), "b\n").unwrap();
        git(repo, &["add", "b.txt"]);
        let staged = watcher.poll();
        assert_eq!(staged.len(), 1, "staging is a change to report");
        assert!(!staged[0].branch_moved, "no branch moved; the chip stays put");
        assert!(watcher.poll().is_empty(), "…and it is reported once");

        // Committing. The case the branch watcher could never see: this moves
        // `refs/heads/<branch>`, and `HEAD` still says `ref: refs/heads/main`.
        git(repo, &["commit", "-m", "two"]);
        let committed = watcher.poll();
        assert_eq!(committed.len(), 1, "a commit is a change to report");
        assert!(!committed[0].branch_moved);
        assert!(watcher.poll().is_empty());

        // Checking out, which moves HEAD as well — both streams.
        git(repo, &["checkout", "-b", "topic"]);
        let switched = watcher.poll();
        assert_eq!(switched.len(), 1);
        assert!(switched[0].branch_moved, "this one IS the chip's event");
        assert_eq!(switched[0].branch, Some("topic".to_string()));
    }

    /// The whole thing, end to end, against a repository git built: an agent
    /// commits, nobody touches the window, and the panel is told to look again
    /// at a working tree that now answers differently.
    ///
    /// This is the bug the release was carrying. Everything in it was true
    /// before except the one assertion in the middle, which was `0`.
    #[test]
    fn an_agent_committing_changes_what_the_panel_draws_with_no_user_action() {
        let tmp = tempfile::tempdir().unwrap();
        let Some(repo) = real_repo(tmp.path()) else {
            return;
        };
        let watcher = GitWatcher::default();
        watcher.watch(repo);

        // What the panel has on screen: one staged file, waiting to go in.
        std::fs::write(repo.join("b.txt"), "b\n").unwrap();
        git(repo, &["add", "b.txt"]);
        watcher.poll();
        let before = porcelain(repo);
        assert!(before.contains("b.txt"), "expected a staged file: {before:?}");

        // The agent commits, in its own pane. No window focus, no click, no
        // keystroke anywhere near this panel.
        git(repo, &["commit", "-m", "agent work"]);

        // The watcher is the only thing running, and it is what says to look.
        let changes = watcher.poll();
        assert_eq!(changes.len(), 1, "nothing would have prompted a re-read");
        assert_eq!(changes[0].root, key_string(&canonical(repo)));
        assert!(!changes[0].branch_moved, "HEAD never moved — this is the gap");

        // And the read it prompts draws a different panel: the staged file the
        // user was looking at is committed and gone.
        let after = porcelain(repo);
        assert_ne!(before, after, "the panel would have redrawn the same list");
        assert!(after.trim().is_empty(), "expected a clean tree: {after:?}");
    }

    /// The loop the `--no-optional-locks` flag in `git::git_status` exists to
    /// prevent, demonstrated from this side: a plain `git status` rewrites the
    /// index whenever a tracked file has been touched, which is a change this
    /// watcher would report, which would prompt another `git status`.
    #[test]
    fn reading_the_status_the_way_the_panel_does_is_not_a_change() {
        let tmp = tempfile::tempdir().unwrap();
        let Some(repo) = real_repo(tmp.path()) else {
            return;
        };
        let watcher = GitWatcher::default();
        watcher.watch(repo);

        // Enough to make the index's stat cache stale, which is the state any
        // repository with an agent working in it is permanently in.
        filetime_bump(&repo.join("a.txt"));

        git(repo, &["--no-optional-locks", "status", "--porcelain"]);
        assert!(
            watcher.poll().is_empty(),
            "the panel's own read woke the watcher that prompted it"
        );

        // And the control: without the flag, it does.
        filetime_bump(&repo.join("a.txt"));
        git(repo, &["status", "--porcelain"]);
        assert_eq!(
            watcher.poll().len(),
            1,
            "a plain `git status` rewrites the index — this is the loop"
        );
    }

    #[test]
    fn an_edit_to_a_tracked_file_is_not_reported() {
        // The documented limit of watching `.git`: this changes what `git
        // status` would say and leaves the repository's own files alone. The
        // window's focus handler is what covers it.
        let tmp = tempfile::tempdir().unwrap();
        let Some(repo) = real_repo(tmp.path()) else {
            return;
        };
        let watcher = GitWatcher::default();
        watcher.watch(repo);

        std::fs::write(repo.join("a.txt"), "edited\n").unwrap();

        assert!(watcher.poll().is_empty());
    }

    #[test]
    fn a_merge_in_flight_is_reported() {
        let tmp = tempfile::tempdir().unwrap();
        fake_repo(tmp.path(), "ref: refs/heads/main\n");
        let watcher = GitWatcher::default();
        watcher.watch(tmp.path());

        std::fs::write(tmp.path().join(".git").join("MERGE_HEAD"), "abc\n").unwrap();

        assert_eq!(watcher.poll().len(), 1);
        assert!(!watcher.poll().first().is_some_and(|c| c.branch_moved));
    }

    #[test]
    fn the_head_ref_of_a_worktree_is_absent_rather_than_wrong() {
        // A linked worktree's refs live in the MAIN git dir, so there is no
        // `refs/heads/x` beside its HEAD to stat. Its own `index` is what
        // carries its commits, and this pins that the lookup answers `None`
        // instead of stamping some unrelated path.
        let tmp = tempfile::tempdir().unwrap();
        let linked = tmp.path().join("main").join(".git").join("worktrees").join("wt");
        std::fs::create_dir_all(&linked).unwrap();
        std::fs::write(linked.join("HEAD"), "ref: refs/heads/topic\n").unwrap();
        let worktree = tmp.path().join("wt");
        std::fs::create_dir_all(&worktree).unwrap();
        std::fs::write(worktree.join(".git"), "gitdir: ../main/.git/worktrees/wt\n").unwrap();

        let snapshot = snapshot_at(&worktree);

        assert_eq!(snapshot.branch, Some("topic".to_string()));
        assert_eq!(snapshot.status.head_ref, None);
    }

    #[test]
    fn a_head_that_points_out_of_the_repository_is_not_followed() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(
            head_ref_path(tmp.path(), "ref: ../../../../etc/passwd"),
            None
        );
    }

    #[test]
    fn the_registry_is_free_while_the_poll_reads() {
        // The thing this is really about is a directory that does not answer:
        // a mounted share whose host is gone, a sleeping external disk. Reading
        // it takes as long as the kernel makes it take, and every `git_watch`
        // and `git_unwatch` from a pane opening or closing elsewhere used to
        // wait behind it, because one guard was held across the whole loop.
        let tmp = tempfile::tempdir().unwrap();
        fake_repo(tmp.path(), "ref: refs/heads/main\n");
        let watcher = GitWatcher::default();
        watcher.watch(tmp.path());

        let mut reads = 0;
        let events = watcher.poll_with(|root| {
            reads += 1;
            assert!(
                watcher.roots.try_lock().is_ok(),
                "the registry was held across the read"
            );
            snapshot_at(root)
        });

        assert_eq!(reads, 1);
        assert!(events.is_empty());
    }

    #[test]
    fn a_path_unwatched_mid_poll_is_not_reported() {
        // The window the three-phase poll opens: the last pane on a repository
        // can close between the snapshot and the write-back. Reporting it
        // anyway would emit for a root nobody is listening to and put the entry
        // back in the registry, watching a directory no pane asked about.
        let tmp = tempfile::tempdir().unwrap();
        fake_repo(tmp.path(), "ref: refs/heads/main\n");
        let watcher = GitWatcher::default();
        watcher.watch(tmp.path());

        let events = watcher.poll_with(|root| {
            // Fails rather than deadlocks if the lock is ever held here again.
            assert!(
                watcher.roots.try_lock().is_ok(),
                "the registry was held across the read"
            );
            watcher.unwatch(root);
            RepoSnapshot {
                branch: Some("feature".to_string()),
                ..RepoSnapshot::default()
            }
        });

        assert!(events.is_empty(), "nobody is watching that repository now");
        assert!(watcher.roots.lock().unwrap().is_empty());
    }
}
