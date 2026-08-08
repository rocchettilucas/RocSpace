//! Whether a Claude Code conversation is still there to be resumed.
//!
//! **The finding.** RocSpace learns a pane's conversation uuid from Claude
//! Code's own SessionStart hook, persists it, and hands it back as `--resume`
//! when the pane is respawned. But a session the user never sent a turn in
//! leaves no conversation behind — the hook fired, the uuid is real, and there
//! is still nothing to resume:
//!
//! ```text
//! $ claude --resume 9b7dce75-d3db-451d-9aea-187aa433aeb6 --permission-mode default
//! No conversation found with session ID: 9b7dce75-d3db-451d-9aea-187aa433aeb6
//! ```
//!
//! The CLI exits, and the pane it was launched into lands in `status: error`
//! about three seconds after the app opened. Quit RocSpace with agent panes
//! open but un-prompted — the normal way to close a window you are done with —
//! and every one of them dies on the next launch. On the machine this was found
//! on that was four panes out of four: the default experience of restarting the
//! app.
//!
//! **Why the check is here rather than after the fact.** The alternative is to
//! let the CLI fail and recognise it: watch the pane's output for that sentence
//! and respawn fresh. That means pattern-matching somebody else's error text
//! through a PTY stream, it costs the user a visible dead pane and a restart
//! every time, and it cannot answer the OTHER surface at all — the resume
//! *offer* RocSpace shows over a cold pane, which has no process to watch and
//! must not offer a conversation that is gone. One question, asked before the
//! spawn, answers both.
//!
//! **What it looks at.** Claude Code keeps a conversation at
//! `~/.claude/projects/<slugged-cwd>/<uuid>.jsonl`. **That directory is the
//! user's real memory corpus and Claude Code is writing it live.** Nothing here
//! writes, creates, moves or opens anything in it: the whole module is
//! `read_dir` on the one directory and `is_file` on paths under it.
//!
//! **It only ever answers "gone" on proof.** The slug is lossy and reproducing
//! it is a guess (`rocmind::encode_path` says so itself), so the scope is not
//! computed — every scope is checked, and the answer is "gone" only when the
//! projects directory could be read and no scope in it holds that transcript.
//! An unreadable directory, an unknowable home, a uuid that could not name a
//! file: all of those are "cannot say", and cannot say means the launch happens
//! exactly as it did before. Getting this wrong in the other direction would
//! throw away a conversation the user could have had back, which is the one
//! outcome worse than the bug.

use std::path::Path;

/// The transcript's extension. Claude Code writes one JSONL file per
/// conversation, named for its uuid.
const TRANSCRIPT_EXT: &str = "jsonl";

/// Can this uuid name a file, and only a file?
///
/// A session uuid arrives from persisted renderer state, and it is about to be
/// joined onto a path. Anything with a separator (or a `.`, which is how `..`
/// climbs) is not a session id and must not become one — this is `is_file` on
/// the result, so the worst case is a stat somewhere it has no business, but
/// "no business" is the whole objection.
///
/// Deliberately looser than "is a uuid": if Claude Code ever widens the format,
/// a stricter rule here would quietly start refusing every resume.
fn nameable(uuid: &str) -> bool {
    !uuid.is_empty()
        && uuid
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
}

/// True only when this machine can PROVE Claude Code has no conversation for
/// `uuid`. See the module docs for why the burden of proof is that way round.
pub fn conversation_lost(uuid: &str) -> bool {
    match crate::rocmind::projects_root() {
        Some(root) => lost_under(&root, uuid),
        // No home directory to ask about. Nothing is proven.
        None => false,
    }
}

/// `conversation_lost` against an explicit projects root, so the tests can use
/// a temp directory instead of the user's real corpus.
fn lost_under(root: &Path, uuid: &str) -> bool {
    if !nameable(uuid) {
        return false;
    }
    let Ok(scopes) = std::fs::read_dir(root) else {
        // No `~/.claude/projects` yet, or it cannot be read. Both are "cannot
        // say" rather than "gone": a machine that has never run Claude Code
        // has no transcripts for a very different reason.
        return false;
    };
    let transcript = format!("{uuid}.{TRANSCRIPT_EXT}");
    // Every scope, not the one the pane's cwd encodes to. The encoding maps
    // several characters onto `-` and cannot be reproduced with certainty, and
    // a pane whose project directory was edited since the conversation started
    // would miss its own scope anyway. This is one `stat` per project the user
    // has ever run an agent in — tens, on a busy machine — against the cost of
    // wrongly declaring a conversation gone.
    !scopes
        .flatten()
        .any(|scope| scope.path().join(&transcript).is_file())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    const UUID: &str = "9b7dce75-d3db-451d-9aea-187aa433aeb6";

    fn projects(scopes: &[(&str, &[&str])]) -> TempDir {
        let root = TempDir::new().unwrap();
        for (scope, transcripts) in scopes {
            let dir = root.path().join(scope);
            std::fs::create_dir_all(&dir).unwrap();
            for uuid in *transcripts {
                std::fs::write(dir.join(format!("{uuid}.jsonl")), "{}\n").unwrap();
            }
        }
        root
    }

    /// The bug, exactly: a uuid RocSpace learned from a SessionStart hook, for
    /// a session the user never sent a turn in.
    #[test]
    fn a_conversation_that_was_never_written_is_gone() {
        let root = projects(&[("-Users-roc-Storefront", &["11111111-1111-1111-1111-111111111111"])]);

        assert!(lost_under(root.path(), UUID));
    }

    #[test]
    fn a_conversation_with_a_transcript_is_not_gone() {
        let root = projects(&[("-Users-roc-Storefront", &[UUID])]);

        assert!(!lost_under(root.path(), UUID));
    }

    /// The reason every scope is checked rather than the one the cwd encodes
    /// to: the slug cannot be reproduced with certainty, and a pane whose
    /// project directory moved would look at the wrong one.
    #[test]
    fn a_transcript_under_any_scope_at_all_counts() {
        let root = projects(&[
            ("-Users-roc-Storefront", &[]),
            ("-Users-roc-Storefront--claude-worktrees-v1-1", &[UUID]),
        ]);

        assert!(!lost_under(root.path(), UUID));
    }

    /// A machine that has never run Claude Code, or a home directory that
    /// cannot be read. Nothing is proven, so nothing is taken away.
    #[test]
    fn an_unreadable_projects_directory_proves_nothing() {
        let tmp = TempDir::new().unwrap();

        assert!(!lost_under(&tmp.path().join("never-created"), UUID));
    }

    /// A `<uuid>/` directory holding subagent journals sits next to the
    /// transcripts in the real corpus. A directory is not a conversation.
    #[test]
    fn a_directory_named_after_the_uuid_is_not_a_transcript() {
        let root = projects(&[("-Users-roc-Storefront", &[])]);
        std::fs::create_dir_all(root.path().join("-Users-roc-Storefront").join(format!("{UUID}.jsonl")))
            .unwrap();

        assert!(lost_under(root.path(), UUID));
    }

    /// A uuid is about to be joined onto a path. One that could climb out of
    /// the corpus is not answered at all.
    #[test]
    fn a_uuid_that_is_not_a_filename_is_never_joined_onto_a_path() {
        let root = projects(&[("-Users-roc-Storefront", &[UUID])]);

        for hostile in ["../../etc/passwd", "a/b", "", ".."] {
            assert!(
                !lost_under(root.path(), hostile),
                "{hostile} was answered rather than declined"
            );
            assert!(!nameable(hostile), "{hostile} was treated as a filename");
        }
    }
}
