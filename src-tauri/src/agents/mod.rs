//! Agent launch + lifecycle plumbing.
//!
//! `command` turns an `AgentConfig` into a concrete program + argv.
//! The JSONL file named here is the channel between Claude Code's hooks
//! (registered by `command::hooks_settings_json`) and RocSpace: hooks append
//! one JSON line per lifecycle event, and the tailer reads them back.
//! `transcript` answers the one question those hooks cannot: whether the
//! conversation a uuid names still exists to be resumed.

pub mod command;
pub mod events;
pub mod transcript;

use std::path::PathBuf;

/// Directory RocSpace owns in the user's home. Deliberately not the Tauri app
/// data dir: the path is baked into a shell command that Claude Code runs from
/// its own process, so it has to be stable, short, and free of the spaces and
/// platform-specific nesting that `~/Library/Application Support/...` brings.
const ROCSPACE_DIR: &str = ".rocspace";
const EVENTS_FILE: &str = "agent-events.jsonl";

/// `~/.rocspace`. Falls back to `./.rocspace` when the home directory is
/// unknowable, which keeps spawn working (with a local events file) instead of
/// failing outright.
///
/// Shared with `sessions`, which keeps its saved-session files in the same
/// directory: one answer to "where does RocSpace put things", resolved once.
pub fn rocspace_dir() -> PathBuf {
    home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(ROCSPACE_DIR)
}

/// `~/.rocspace/agent-events.jsonl`.
pub fn events_path() -> PathBuf {
    rocspace_dir().join(EVENTS_FILE)
}

/// Create `~/.rocspace/` and touch the events file so the tailer has something
/// to open and the hooks' `cat >>` never has to create it under a race.
/// Called once at startup; errors are reported, not fatal.
pub fn ensure_events_file() -> std::io::Result<PathBuf> {
    let path = events_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)?;
    Ok(path)
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_path_lives_under_the_rocspace_dir() {
        let path = events_path();
        assert!(
            path.ends_with(PathBuf::from(ROCSPACE_DIR).join(EVENTS_FILE)),
            "{path:?}"
        );
    }

    #[test]
    fn ensure_events_file_is_idempotent_and_never_truncates() {
        let tmp = tempfile::tempdir().expect("tempdir");
        with_home(tmp.path(), || {
            let path = ensure_events_file().expect("created");
            assert!(path.exists());
            assert!(path.starts_with(tmp.path()));
            std::fs::write(&path, b"{}\n").unwrap();
            ensure_events_file().expect("created again");
            assert_eq!(std::fs::read_to_string(&path).unwrap(), "{}\n");
        });
    }

    /// `HOME`/`USERPROFILE` are process-global; this restores them afterwards.
    fn with_home(dir: &std::path::Path, body: impl FnOnce()) {
        let prev_home = std::env::var_os("HOME");
        let prev_profile = std::env::var_os("USERPROFILE");
        // SAFETY: the body is single-threaded and both vars are restored below.
        unsafe {
            std::env::set_var("HOME", dir);
            std::env::set_var("USERPROFILE", dir);
        }
        body();
        unsafe {
            match prev_home {
                Some(v) => std::env::set_var("HOME", v),
                None => std::env::remove_var("HOME"),
            }
            match prev_profile {
                Some(v) => std::env::set_var("USERPROFILE", v),
                None => std::env::remove_var("USERPROFILE"),
            }
        }
    }
}
