//! Who else moved the board.
//!
//! `.rocspace/plan.json` has two writers — this app and the `rocspace-mcp`
//! server running inside an agent's session — plus the user's editor and
//! whatever `git checkout` does to it. The board on screen has to follow all of
//! those, so a thread re-reads the file once a second and emits
//! `rocplan://changed` when its stamp moves (see `Stamp` for why that is a read
//! and not a `stat`).
//!
//! Polling rather than a filesystem watcher, for the reasons `git_info` gives:
//! another dependency and another set of platform quirks, for a file that is
//! allowed to be a second stale.
//!
//! The one thing a plain mtime watcher gets wrong is the app's OWN writes. The
//! board saves through `plan_write` on a 300 ms debounce, so a naive watcher
//! would answer every save with "the file changed, reload" — a round trip that
//! can only ever replace the store's state with what it just wrote, and that
//! lands in the middle of the user's next drag. So `plan_write` reports the
//! stamp it produced and the watcher adopts it as the baseline: our own write
//! is already accounted for before the next poll can see it.
//!
//! Reporting the stamp is not on its own enough, because publishing the file
//! and recording its stamp cannot happen at the same instant. `plan_write`
//! holds a `SelfWrite` guard across the whole thing, which takes the project
//! out of the poll's reach for as long as the write is in flight.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, Emitter, Manager};

use super::{stamp_of, Stamp};

/// Event name — mirrored in `src/lib/bindings.ts`.
pub const EVENT_ROCPLAN_CHANGED: &str = "rocplan://changed";

/// How often every watched project's plan file is re-read. One second: an
/// agent moving a card through the MCP server should land on the board while
/// the user is still looking at it, and a few kilobytes per open board is
/// nothing.
const POLL_INTERVAL: Duration = Duration::from_secs(1);

/// Payload of `rocplan://changed`. `projectPath` is the string the caller
/// passed to `plan_watch` — NOT the canonical path it was filed under — because
/// that is the key the renderer's `tasksByProject` is indexed by.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RocPlanChangedEvent {
    pub project_path: String,
}

/// One watched project.
struct Watched {
    /// Every `projectPath` spelling that asked for this file, with its own
    /// reference count.
    ///
    /// The map is keyed on the canonical directory so `~/p` and `~/p/` are one
    /// file, one stat per poll — but the renderer knows the project by the
    /// string it passed in, so a change has to be announced under every
    /// spelling that is currently watching. Refcounts live per spelling because
    /// that is the granularity `plan_unwatch` is called at.
    labels: HashMap<String, usize>,
    /// The stamp this watcher last accounted for: seeded when the project is
    /// first watched (so a board that never changes never emits) and replaced
    /// either by a poll that found a change or by `note_self_write`.
    last: Option<Stamp>,
    /// Writes this application has started on this board and not yet finished
    /// accounting for. A count and not a flag, because two saves can overlap.
    /// While it is above zero the poll leaves the project alone entirely — see
    /// `SelfWrite`.
    writing: usize,
}

/// A write this application is in the middle of.
///
/// The reason it exists rather than just `note_self_write`: publishing the file
/// and recording its stamp cannot be one instant. `rename` returns, and from
/// that moment the new file is what a poll would find, while the watcher's
/// baseline still says otherwise — so a poll in between reports the user's own
/// save back to them and the board reloads what it just wrote, in the middle of
/// whatever they are doing next. Recording the stamp BEFORE the rename does not
/// fix it, it inverts it: the baseline is then ahead of the file, and a poll in
/// that window reports the OLD contents as a change.
///
/// So the window is made invisible instead. While a `SelfWrite` is alive the
/// project is skipped by the poll — its file is allowed to be mid-change and
/// nothing about it is anyone else's news — and by the time the guard drops,
/// `note_self_write` has set the baseline to what was actually published.
///
/// Drop-based so an early return cannot leave a board permanently muted.
pub struct SelfWrite<'a> {
    watcher: &'a RocPlanWatcher,
    /// The path as the caller spelled it; resolved to a key on each end,
    /// because a project can be rekeyed while a write is in flight.
    project: PathBuf,
}

impl Drop for SelfWrite<'_> {
    fn drop(&mut self) {
        let mut projects = self.watcher.lock();
        let Some(key) = key_in(&projects, &self.project) else {
            return;
        };
        if let Some(entry) = projects.get_mut(&key) {
            entry.writing = entry.writing.saturating_sub(1);
        }
    }
}

/// Registry of the projects whose board file is being followed. Managed by
/// Tauri; the four `plan_*` commands and the poll thread share it.
#[derive(Default)]
pub struct RocPlanWatcher {
    projects: Mutex<HashMap<PathBuf, Watched>>,
}

/// The two keys a project could be filed under: the canonical directory, and
/// the path exactly as it was given.
///
/// The project directory rather than the plan file: `.rocspace/plan.json` does
/// not exist until the first card is created, and `canonicalize` on a path that
/// is not there fails — which would file the same project under two different
/// keys either side of its first save.
///
/// But `canonicalize` fails on the DIRECTORY too, when the directory is not
/// there: a project not created yet, a volume that is not mounted, a workspace
/// restored while its disk was still waking up. A watch registered in that
/// state is filed under the raw path, and the moment the directory turns up the
/// canonical form starts resolving — so `note_self_write`, which computes the
/// key fresh every time, would look under a name nothing is filed under, do
/// nothing, and let the board answer every one of its own saves with a reload.
///
/// Hence a pair, and every lookup tries both. The map converges on the
/// canonical spelling in the poll, which is the one place that already has the
/// registry, the lock and a reason to touch the filesystem.
fn watch_keys(project: &Path) -> (PathBuf, PathBuf) {
    let raw = project.to_path_buf();
    let canonical = std::fs::canonicalize(project).unwrap_or_else(|_| raw.clone());
    (canonical, raw)
}

/// The key `project` is filed under right now, or `None` when nobody is
/// watching it.
fn key_in(projects: &HashMap<PathBuf, Watched>, project: &Path) -> Option<PathBuf> {
    let (canonical, raw) = watch_keys(project);
    if projects.contains_key(&canonical) {
        return Some(canonical);
    }
    projects.contains_key(&raw).then_some(raw)
}

/// Move a watch from `from` to `to`, merging into whatever is already there.
/// Returns the key the watch lives under afterwards.
fn rekey(projects: &mut HashMap<PathBuf, Watched>, from: &Path, to: PathBuf) -> PathBuf {
    let Some(moving) = projects.remove(from) else {
        return from.to_path_buf();
    };
    match projects.get_mut(&to) {
        // Both spellings somehow ended up in the map. Fold the refcounts
        // together rather than dropping one side's watchers on the floor; the
        // surviving entry's baseline is the one that keeps being compared, so
        // this round is skipped and the next one speaks for both.
        Some(existing) => {
            for (label, refs) in moving.labels {
                *existing.labels.entry(label).or_insert(0) += refs;
            }
        }
        None => {
            projects.insert(to.clone(), moving);
        }
    }
    to
}

impl RocPlanWatcher {
    /// Start following `project_path`'s board (or add a reference to a watch
    /// already on it).
    ///
    /// The baseline is read here rather than left empty, so a board nobody
    /// touches never emits: `rocplan://changed` means "somebody else wrote
    /// this", never "here is what it has always been".
    pub fn watch(&self, project_path: &str) {
        let project = Path::new(project_path);

        // Already watched — under either spelling: nothing to read, so the lock
        // is held for a map lookup. The new caller inherits the standing
        // baseline rather than taking a reading of its own — same trade as
        // `git_info`, and for the same reason: a fresher value that disagrees
        // with the baseline is never corrected, because the watcher only speaks
        // when the baseline MOVES.
        {
            let mut projects = self.lock();
            if let Some(key) = key_in(&projects, project) {
                let entry = projects.get_mut(&key).expect("just looked it up");
                *entry.labels.entry(project_path.to_string()).or_insert(0) += 1;
                return;
            }
        }

        // A new project means a read, which on a stalled network volume takes
        // as long as it takes. Done with the registry released so every other
        // board's watch, unwatch and poll carries on.
        let (key, _) = watch_keys(project);
        let last = stamp_of(&key);

        let mut projects = self.lock();
        let entry = projects.entry(key).or_insert(Watched {
            labels: HashMap::new(),
            // Another caller may have inserted while we were reading; its seed
            // is the same read of the same file, so either value is right.
            last,
            writing: 0,
        });
        *entry.labels.entry(project_path.to_string()).or_insert(0) += 1;
    }

    /// Mark the start of a write this application is making, so the poll leaves
    /// the board alone until the guard is dropped.
    ///
    /// A no-op for a project nobody is watching, and safe to hold over one that
    /// stops being watched: there is nothing to suppress and nothing to
    /// restore.
    pub fn begin_self_write(&self, project: &Path) -> SelfWrite<'_> {
        {
            let mut projects = self.lock();
            if let Some(key) = key_in(&projects, project) {
                if let Some(entry) = projects.get_mut(&key) {
                    entry.writing += 1;
                }
            }
        }
        SelfWrite {
            watcher: self,
            project: project.to_path_buf(),
        }
    }

    /// Drop one caller's interest in `project_path`; the last one out stops the
    /// watch. Unwatching something that was never watched is a no-op.
    pub fn unwatch(&self, project_path: &str) {
        let mut projects = self.lock();
        let Some(key) = key_in(&projects, Path::new(project_path)) else {
            return;
        };
        let Some(entry) = projects.get_mut(&key) else {
            return;
        };
        if let Some(refs) = entry.labels.get_mut(project_path) {
            *refs -= 1;
            if *refs == 0 {
                entry.labels.remove(project_path);
            }
        }
        if entry.labels.is_empty() {
            projects.remove(&key);
        }
    }

    /// Record a write this application just made, so the poll that follows does
    /// not report it as somebody else's change.
    ///
    /// A no-op for a project nobody is watching — there is no board on screen
    /// to tell, and inserting an entry here would start following a file that
    /// nothing asked about.
    pub fn note_self_write(&self, project: &Path, stamp: Stamp) {
        let mut projects = self.lock();
        let Some(key) = key_in(&projects, project) else {
            return;
        };
        if let Some(entry) = projects.get_mut(&key) {
            entry.last = Some(stamp);
        }
    }

    /// Re-stat every watched board, returning an event per watching spelling of
    /// every project whose file moved.
    fn poll(&self) -> Vec<RocPlanChangedEvent> {
        self.poll_with(stamp_of)
    }

    /// `poll`, with the stat injected so a test can look at the registry from
    /// inside it.
    ///
    /// Three phases, and the middle one is the point (the shape `git_info`
    /// arrived at): snapshot under the lock, stat with the lock RELEASED, then
    /// take it again to compare and write the new baselines. A project on a
    /// volume that has stopped answering must not hold every other board's
    /// commands behind it.
    ///
    /// The snapshot carries each project's baseline as well as its key, because
    /// the released window is exactly when `note_self_write` lands: a project
    /// whose baseline moved while we were reading is left alone entirely.
    /// Writing our stale reading back over the app's own write would emit a
    /// change for that write and then a second one for the reading that
    /// replaced it.
    fn poll_with(&self, mut stat: impl FnMut(&Path) -> Option<Stamp>) -> Vec<RocPlanChangedEvent> {
        let watched: Vec<(PathBuf, Option<Stamp>)> = self
            .lock()
            .iter()
            .map(|(key, entry)| (key.clone(), entry.last))
            .collect();
        let fresh: Vec<(PathBuf, PathBuf, Option<Stamp>, Option<Stamp>)> = watched
            .into_iter()
            .map(|(key, baseline)| {
                // Re-resolved every round, because a directory that was not
                // there when the watch was registered may be there now — see
                // `watch_keys`. Another filesystem call with the lock released,
                // where it belongs.
                let (canonical, _) = watch_keys(&key);
                let stamp = stat(&key);
                (key, canonical, baseline, stamp)
            })
            .collect();

        let mut projects = self.lock();
        let mut changed = Vec::new();
        for (key, canonical, baseline, stamp) in fresh {
            // The directory turned up since this watch was registered, so the
            // key it was filed under is no longer the one a fresh lookup
            // produces. Move it here, holding the lock we already hold, so the
            // map converges on one spelling and one read per file.
            let key = if canonical == key {
                key
            } else {
                rekey(&mut projects, &key, canonical)
            };
            // Gone while we were reading — the board was closed. There is
            // nobody to tell, and re-inserting it would follow a file nothing
            // asked about.
            let Some(entry) = projects.get_mut(&key) else {
                continue;
            };
            // A write of ours is in flight. Whatever this reading caught — the
            // old bytes, the new ones, or a rename that has not happened yet —
            // it is not somebody else's change, and the baseline it should be
            // compared against does not exist until the write finishes. Left
            // entirely alone, baseline included.
            if entry.writing > 0 {
                continue;
            }
            if entry.last != baseline {
                continue;
            }
            if entry.last == stamp {
                continue;
            }
            entry.last = stamp;
            // Sorted so the order is the same run to run; a board watched under
            // two spellings is two entries in the renderer's map and both need
            // telling.
            let mut labels: Vec<&String> = entry.labels.keys().collect();
            labels.sort();
            changed.extend(labels.into_iter().map(|project_path| RocPlanChangedEvent {
                project_path: project_path.clone(),
            }));
        }
        changed
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<PathBuf, Watched>> {
        self.projects.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// Start the poll thread. Runs for the lifetime of the app; with no board open
/// it is a one-second sleep loop over an empty map.
pub fn spawn_watcher(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(POLL_INTERVAL);
        let Some(watcher) = app.try_state::<RocPlanWatcher>() else {
            return;
        };
        for event in watcher.poll() {
            let _ = app.emit(EVENT_ROCPLAN_CHANGED, &event);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rocplan::{write_tasks, RocTask};

    fn board(project: &Path, count: usize) -> Stamp {
        let tasks: Vec<RocTask> = (0..count)
            .map(|n| RocTask::new(format!("Task {n}"), ""))
            .collect();
        write_tasks(project, &tasks).expect("written")
    }

    fn paths(events: &[RocPlanChangedEvent]) -> Vec<&str> {
        events.iter().map(|e| e.project_path.as_str()).collect()
    }

    // -- Nothing to say ----------------------------------------------------

    #[test]
    fn a_quiet_board_never_reports_a_change() {
        let tmp = tempfile::tempdir().unwrap();
        board(tmp.path(), 2);
        let watcher = RocPlanWatcher::default();
        watcher.watch(&tmp.path().to_string_lossy());

        assert!(watcher.poll().is_empty());
    }

    #[test]
    fn a_project_with_no_board_yet_is_watched_without_emitting() {
        // Every project starts here: `.rocspace/` does not exist until the
        // first card. Watching it anyway is what lights the board up when an
        // agent creates that card through the MCP server.
        let tmp = tempfile::tempdir().unwrap();
        let watcher = RocPlanWatcher::default();
        watcher.watch(&tmp.path().to_string_lossy());
        assert!(watcher.poll().is_empty());

        board(tmp.path(), 1);

        assert_eq!(watcher.poll().len(), 1);
    }

    // -- Somebody else wrote -----------------------------------------------

    #[test]
    fn an_external_write_is_reported_once() {
        let tmp = tempfile::tempdir().unwrap();
        board(tmp.path(), 1);
        let project = tmp.path().to_string_lossy().into_owned();
        let watcher = RocPlanWatcher::default();
        watcher.watch(&project);

        board(tmp.path(), 5);
        let events = watcher.poll();

        assert_eq!(paths(&events), vec![project.as_str()]);
        // …once. The new stamp is the baseline now.
        assert!(watcher.poll().is_empty());
    }

    #[test]
    fn a_board_that_is_deleted_is_reported() {
        let tmp = tempfile::tempdir().unwrap();
        board(tmp.path(), 3);
        let watcher = RocPlanWatcher::default();
        watcher.watch(&tmp.path().to_string_lossy());

        std::fs::remove_file(crate::rocplan::plan_path(tmp.path())).unwrap();

        assert_eq!(watcher.poll().len(), 1);
        assert!(watcher.poll().is_empty());
    }

    // -- …but not us -------------------------------------------------------

    #[test]
    fn the_apps_own_write_is_not_reported_back_to_it() {
        // The whole reason `write_tasks` reports a stamp. Without this the
        // board answers its own debounced save with a reload, every save.
        let tmp = tempfile::tempdir().unwrap();
        board(tmp.path(), 1);
        let watcher = RocPlanWatcher::default();
        watcher.watch(&tmp.path().to_string_lossy());

        let stamp = board(tmp.path(), 9);
        watcher.note_self_write(tmp.path(), stamp);

        assert!(watcher.poll().is_empty(), "our own write echoed back");
    }

    #[test]
    fn a_write_by_somebody_else_after_ours_is_still_reported() {
        // Suppression is per-stamp, not a mute: adopting our write as the
        // baseline must not blind the watcher to the next one.
        let tmp = tempfile::tempdir().unwrap();
        board(tmp.path(), 1);
        let watcher = RocPlanWatcher::default();
        watcher.watch(&tmp.path().to_string_lossy());

        let stamp = board(tmp.path(), 4);
        watcher.note_self_write(tmp.path(), stamp);
        board(tmp.path(), 40);

        assert_eq!(watcher.poll().len(), 1);
    }

    #[test]
    fn our_write_landing_mid_poll_does_not_become_a_change() {
        // The window the three-phase poll opens. The stat happens with the
        // registry released, so a `plan_write` can complete between the reading
        // and the write-back: the reading is then older than the baseline, and
        // storing it would emit once for our own write and again for the stale
        // value that replaced it.
        let tmp = tempfile::tempdir().unwrap();
        board(tmp.path(), 1);
        let watcher = RocPlanWatcher::default();
        watcher.watch(&tmp.path().to_string_lossy());

        let events = watcher.poll_with(|key| {
            let stale = stamp_of(key);
            let stamp = board(tmp.path(), 12);
            watcher.note_self_write(tmp.path(), stamp);
            stale
        });

        assert!(events.is_empty(), "our own write, reported as a change");
        // …and the next poll agrees with the file, so nothing is stranded.
        assert!(watcher.poll().is_empty());
    }

    #[test]
    fn a_poll_between_our_rename_and_our_stamp_reports_nothing() {
        // The window this closes: `rename` returns, the new file is what any
        // poll would find, and the watcher has not been told yet. A poll
        // landing there told the board to reload the save it had just made —
        // in the middle of whatever the user did next. One second of polling
        // against a 300 ms debounce makes that narrow, not closed.
        let tmp = tempfile::tempdir().unwrap();
        board(tmp.path(), 1);
        let watcher = RocPlanWatcher::default();
        watcher.watch(&tmp.path().to_string_lossy());

        let writing = watcher.begin_self_write(tmp.path());
        let stamp = board(tmp.path(), 9);
        assert!(watcher.poll().is_empty(), "the file is published, we are not");
        watcher.note_self_write(tmp.path(), stamp);
        assert!(watcher.poll().is_empty());

        drop(writing);
        assert!(watcher.poll().is_empty(), "our own write echoed back");
    }

    #[test]
    fn a_poll_before_our_rename_reports_nothing_either() {
        // The mirror image, and the reason the stamp alone cannot do this job:
        // handing it over BEFORE the rename only inverts the window, to one
        // where the baseline is ahead of the file and a poll reports the OLD
        // contents as a change.
        let tmp = tempfile::tempdir().unwrap();
        board(tmp.path(), 1);
        let watcher = RocPlanWatcher::default();
        watcher.watch(&tmp.path().to_string_lossy());

        let writing = watcher.begin_self_write(tmp.path());
        // A stamp for bytes that are not published yet.
        let coming = crate::rocplan::write_tasks(tmp.path(), &[]).expect("written");
        watcher.note_self_write(tmp.path(), coming);
        board(tmp.path(), 4); // the write this stamp does NOT describe
        assert!(watcher.poll().is_empty(), "the baseline was ahead of the file");

        let stamp = stamp_of(tmp.path()).expect("a file");
        watcher.note_self_write(tmp.path(), stamp);
        drop(writing);
        assert!(watcher.poll().is_empty());
    }

    #[test]
    fn somebody_elses_write_during_ours_is_reported_once_ours_lands() {
        // Suppression is a pause, not a mute. A `git checkout` that lands while
        // the board is saving must still reach the screen.
        let tmp = tempfile::tempdir().unwrap();
        board(tmp.path(), 1);
        let watcher = RocPlanWatcher::default();
        watcher.watch(&tmp.path().to_string_lossy());

        let writing = watcher.begin_self_write(tmp.path());
        let stamp = board(tmp.path(), 9);
        watcher.note_self_write(tmp.path(), stamp);
        board(tmp.path(), 40);
        drop(writing);

        assert_eq!(watcher.poll().len(), 1);
        assert!(watcher.poll().is_empty(), "…once");
    }

    #[test]
    fn two_overlapping_writes_both_have_to_finish_before_the_watch_re_arms() {
        let tmp = tempfile::tempdir().unwrap();
        board(tmp.path(), 1);
        let watcher = RocPlanWatcher::default();
        watcher.watch(&tmp.path().to_string_lossy());

        let first = watcher.begin_self_write(tmp.path());
        let second = watcher.begin_self_write(tmp.path());
        board(tmp.path(), 9);

        drop(first);
        assert!(watcher.poll().is_empty(), "one write is still in flight");

        let stamp = stamp_of(tmp.path()).expect("a file");
        watcher.note_self_write(tmp.path(), stamp);
        drop(second);
        assert!(watcher.poll().is_empty());
    }

    #[test]
    fn a_self_write_guard_for_an_unwatched_project_is_a_no_op() {
        let tmp = tempfile::tempdir().unwrap();
        let watcher = RocPlanWatcher::default();

        drop(watcher.begin_self_write(tmp.path()));

        assert!(watcher.projects.lock().unwrap().is_empty());
    }

    // -- One project, two spellings of its path ----------------------------

    #[cfg(unix)]
    #[test]
    fn a_watch_registered_before_the_directory_existed_still_hears_our_writes() {
        // `canonicalize` fails on a directory that is not there, so the watch
        // is filed under the raw path. The moment the directory appears the
        // canonical form starts resolving, and `note_self_write` — which
        // recomputes the key every call — went looking under a name nothing was
        // filed under, found nothing, and did nothing. Every save after that
        // came back as somebody else's change.
        let tmp = tempfile::tempdir().unwrap();
        let real = tmp.path().join("real");
        let link = tmp.path().join("link");

        let watcher = RocPlanWatcher::default();
        watcher.watch(&link.to_string_lossy());

        std::fs::create_dir_all(&real).unwrap();
        std::os::unix::fs::symlink(&real, &link).unwrap();
        assert_ne!(
            std::fs::canonicalize(&link).unwrap(),
            link,
            "the premise: the two spellings differ once it resolves"
        );

        let stamp = board(&link, 3);
        watcher.note_self_write(&link, stamp);

        assert!(watcher.poll().is_empty(), "our own write echoed back");
        // …and somebody else's is still reported, under the spelling the
        // renderer indexes by.
        board(&link, 7);
        assert_eq!(paths(&watcher.poll()), vec![link.to_string_lossy()]);
    }

    #[cfg(unix)]
    #[test]
    fn a_watch_moves_to_the_canonical_key_once_the_directory_resolves() {
        // Convergence: the map must not keep two names for one file, or a
        // second workspace opening the same project would stat it twice.
        let tmp = tempfile::tempdir().unwrap();
        let real = tmp.path().join("real");
        let link = tmp.path().join("link");
        let watcher = RocPlanWatcher::default();
        watcher.watch(&link.to_string_lossy());
        assert_eq!(watcher.projects.lock().unwrap().keys().next(), Some(&link));

        std::fs::create_dir_all(&real).unwrap();
        std::os::unix::fs::symlink(&real, &link).unwrap();
        watcher.poll();

        let canonical = std::fs::canonicalize(&link).unwrap();
        let projects = watcher.projects.lock().unwrap();
        assert_eq!(projects.len(), 1, "one file, one entry");
        assert_eq!(projects.keys().next(), Some(&canonical));
        // The renderer's spelling is untouched — that is what events are
        // labelled with.
        assert!(projects[&canonical].labels.contains_key(&*link.to_string_lossy()));
    }

    #[cfg(unix)]
    #[test]
    fn unwatching_by_the_spelling_it_was_watched_under_still_works() {
        let tmp = tempfile::tempdir().unwrap();
        let real = tmp.path().join("real");
        let link = tmp.path().join("link");
        let watcher = RocPlanWatcher::default();
        watcher.watch(&link.to_string_lossy());

        std::fs::create_dir_all(&real).unwrap();
        std::os::unix::fs::symlink(&real, &link).unwrap();

        watcher.unwatch(&link.to_string_lossy());

        assert!(watcher.projects.lock().unwrap().is_empty());
    }

    #[test]
    fn a_self_write_for_an_unwatched_project_is_a_no_op() {
        let tmp = tempfile::tempdir().unwrap();
        let watcher = RocPlanWatcher::default();
        let stamp = board(tmp.path(), 1);

        watcher.note_self_write(tmp.path(), stamp);

        assert!(watcher.projects.lock().unwrap().is_empty());
    }

    // -- Reference counting ------------------------------------------------

    #[test]
    fn the_last_watcher_out_stops_the_watch() {
        let tmp = tempfile::tempdir().unwrap();
        board(tmp.path(), 1);
        let project = tmp.path().to_string_lossy().into_owned();
        let watcher = RocPlanWatcher::default();
        watcher.watch(&project);
        watcher.watch(&project);

        watcher.unwatch(&project);
        board(tmp.path(), 6);
        assert_eq!(
            watcher.poll().len(),
            1,
            "still watched by the second caller"
        );

        watcher.unwatch(&project);
        board(tmp.path(), 60);
        assert!(watcher.poll().is_empty(), "nobody is watching that board");
        assert!(watcher.projects.lock().unwrap().is_empty());
    }

    #[test]
    fn unwatching_something_never_watched_is_a_no_op() {
        let watcher = RocPlanWatcher::default();
        watcher.unwatch("/tmp/never-watched-rocplan");
        assert!(watcher.poll().is_empty());
    }

    // -- One file, one stat, every spelling told ---------------------------

    #[test]
    fn the_same_project_spelled_differently_is_one_watch_and_two_events() {
        // A workspace's `projectPath` arrives in whatever form it was stored,
        // and the renderer's board map is keyed on that exact string — so the
        // file is stat'ed once but both spellings have to hear about it.
        let tmp = tempfile::tempdir().unwrap();
        board(tmp.path(), 1);
        let plain = tmp.path().to_string_lossy().into_owned();
        let trailing = format!("{plain}/");
        let watcher = RocPlanWatcher::default();
        watcher.watch(&plain);
        watcher.watch(&trailing);

        assert_eq!(watcher.projects.lock().unwrap().len(), 1, "one stat");

        board(tmp.path(), 7);
        let events = watcher.poll();

        let mut spellings = paths(&events);
        spellings.sort();
        assert_eq!(spellings, vec![plain.as_str(), trailing.as_str()]);
    }

    #[test]
    fn one_spelling_leaving_does_not_take_the_other_with_it() {
        let tmp = tempfile::tempdir().unwrap();
        board(tmp.path(), 1);
        let plain = tmp.path().to_string_lossy().into_owned();
        let trailing = format!("{plain}/");
        let watcher = RocPlanWatcher::default();
        watcher.watch(&plain);
        watcher.watch(&trailing);

        watcher.unwatch(&trailing);
        board(tmp.path(), 8);

        assert_eq!(paths(&watcher.poll()), vec![plain.as_str()]);
    }

    #[test]
    fn two_projects_are_two_watches() {
        let tmp = tempfile::tempdir().unwrap();
        let a = tmp.path().join("a");
        let b = tmp.path().join("b");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        board(&a, 1);
        board(&b, 1);
        let watcher = RocPlanWatcher::default();
        watcher.watch(&a.to_string_lossy());
        watcher.watch(&b.to_string_lossy());

        board(&b, 5);
        let events = watcher.poll();

        assert_eq!(events.len(), 1);
        assert!(events[0].project_path.ends_with('b'), "{events:?}");
    }

    // -- The poll's lock discipline ----------------------------------------

    #[test]
    fn the_registry_is_free_while_the_poll_stats() {
        // A board on a mounted share whose host is gone takes as long as the
        // kernel makes it take, and every `plan_watch` / `plan_unwatch` from a
        // workspace opening elsewhere used to queue behind it when one guard
        // was held across the loop.
        let tmp = tempfile::tempdir().unwrap();
        board(tmp.path(), 1);
        let watcher = RocPlanWatcher::default();
        watcher.watch(&tmp.path().to_string_lossy());

        let mut stats = 0;
        let events = watcher.poll_with(|key| {
            stats += 1;
            assert!(
                watcher.projects.try_lock().is_ok(),
                "the registry was held across the stat"
            );
            stamp_of(key)
        });

        assert_eq!(stats, 1);
        assert!(events.is_empty());
    }

    #[test]
    fn a_project_unwatched_mid_poll_is_not_reported() {
        let tmp = tempfile::tempdir().unwrap();
        board(tmp.path(), 1);
        let project = tmp.path().to_string_lossy().into_owned();
        let watcher = RocPlanWatcher::default();
        watcher.watch(&project);

        let events = watcher.poll_with(|_| {
            watcher.unwatch(&project);
            None
        });

        assert!(events.is_empty(), "nobody is watching that board now");
        assert!(watcher.projects.lock().unwrap().is_empty());
    }

    // -- The event's shape -------------------------------------------------

    #[test]
    fn the_event_serializes_the_key_the_renderer_indexes_by() {
        let value = serde_json::to_value(RocPlanChangedEvent {
            project_path: "/Users/roc/proj".to_string(),
        })
        .unwrap();

        assert_eq!(value["projectPath"], "/Users/roc/proj");
    }
}
