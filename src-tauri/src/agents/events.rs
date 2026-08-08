//! Tailer for the Claude Code hook event log.
//!
//! Claude Code writes each lifecycle event as JSON to the stdin of the hook
//! command registered by `command::hooks_settings_json`; that command is
//! `cat >> ~/.rocspace/agent-events.jsonl`, so the file grows by one payload
//! per event. A background thread follows the file and turns those payloads
//! into `agent://status` events keyed by terminal.
//!
//! This replaces the renderer's 1500 ms silence heuristic for Claude panes.
//! That heuristic guessed "the agent must be waiting for me" from a gap in
//! output and, by its own admission, misfired on every slow tool call. The
//! hooks say so directly.
//!
//! Std-only, mirroring the thread patterns in `pty/runtime.rs`: a polling
//! `std::thread` rather than a filesystem watcher, because 300 ms of latency on
//! a status dot is invisible and a watcher is another dependency plus another
//! set of platform quirks.

use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, Emitter, Manager};

use crate::models::TerminalStatus;
use crate::pty::runtime::PtyRuntime;

/// Event name — mirrored in `src/lib/bindings.ts`.
pub const EVENT_AGENT_STATUS: &str = "agent://status";

/// How often the tail thread looks for appended bytes.
const POLL_INTERVAL: Duration = Duration::from_millis(300);
/// Truncate the log past this size, but only while no Claude session is live —
/// truncating under a running session would strand a half-written payload.
const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;
/// A carry buffer this large means we are stuck on something that will never
/// parse (a binary splat, a payload larger than any real event). Drop it rather
/// than grow forever.
const MAX_CARRY_BYTES: usize = 1024 * 1024;

/// Payload of `agent://status`.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatusEvent {
    pub terminal_id: String,
    pub status: TerminalStatus,
}

/// One hook payload we care about, already mapped onto a terminal status.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HookEvent {
    pub session_id: String,
    pub status: TerminalStatus,
}

/// Hook name → status. `None` means "not a hook we act on" (either one we did
/// not register, or one Claude Code added since).
///
/// | hook               | status             | fires when                          |
/// |--------------------|--------------------|-------------------------------------|
/// | `SessionStart`     | `running`          | the CLI boots a session             |
/// | `UserPromptSubmit` | `running`          | the user submits a prompt           |
/// | `Notification`     | `awaiting_approval`| permission prompt / idle-input nudge|
/// | `Stop`             | `idle`             | the assistant finishes a turn       |
///
/// `Stop` is deliberately **not** `complete`. It fires at the end of *every*
/// assistant turn, so "the agent finished the thing you asked for" is exactly
/// what it does not mean — a ten-turn conversation fires it ten times. Mapping
/// it to `complete` made the renderer push a desktop notification and play the
/// ding once per turn (the `complete` branch of `notificationsBridge` has no
/// debounce). `idle` says what actually happened: the turn is over and the
/// agent is ready for the next prompt. The dot goes neutral and nothing pings.
///
/// `complete` still exists and still means "the process is gone" — it comes
/// from the PTY exit waiter in `pty::runtime`, which is the only thing that
/// knows the CLI is finished for good.
pub fn status_for_hook(hook_event_name: &str) -> Option<TerminalStatus> {
    match hook_event_name {
        "SessionStart" | "UserPromptSubmit" => Some(TerminalStatus::Running),
        "Notification" => Some(TerminalStatus::AwaitingApproval),
        "Stop" => Some(TerminalStatus::Idle),
        _ => None,
    }
}

/// Pull every complete JSON value out of `buffer`, returning the events they
/// map to and how many bytes were consumed. The caller drops the consumed
/// prefix and keeps the rest for the next read.
///
/// Deliberately parses a *stream of JSON values* rather than splitting on
/// newlines: nothing guarantees Claude Code terminates the payload it pipes to
/// a hook with `\n`, so two events can land back to back as `{…}{…}`. A
/// line-splitting reader would either see one unparseable line or, if no
/// newline ever arrived, nothing at all.
pub fn drain_events(buffer: &str) -> (Vec<HookEvent>, usize) {
    let mut events = Vec::new();
    let mut consumed = 0usize;

    loop {
        let rest = &buffer[consumed..];
        let lead = rest.len() - rest.trim_start().len();
        if lead == rest.len() {
            // Nothing but whitespace left — take it and stop.
            consumed = buffer.len();
            break;
        }
        let value = &rest[lead..];
        let mut stream = serde_json::Deserializer::from_str(value).into_iter::<serde_json::Value>();
        match stream.next() {
            Some(Ok(parsed)) => {
                consumed += lead + stream.byte_offset();
                if let Some(event) = event_from_value(&parsed) {
                    events.push(event);
                }
            }
            // A value that is still being written: wait for the rest.
            Some(Err(err)) if err.is_eof() => break,
            // Garbage — a stray byte, an interleaved half-write, anything that
            // will never parse. Resync to the next `{` *after* the byte that
            // failed.
            //
            // Not to the next newline: this whole function exists because hook
            // payloads are not newline-terminated, so a run of back-to-back
            // `{…}{…}` writes contains no newline to skip to. That reader
            // returned `consumed == 0` forever, wedging the tail on one bad
            // byte until the 1 MiB carry cap dropped roughly two thousand
            // buffered events with it.
            //
            // Searching from `+ 1` rather than from the failure point is what
            // guarantees forward progress when the offending byte IS a `{`
            // (`{oops}{…}`). `{` is ASCII and UTF-8 is self-synchronizing, so
            // a byte search cannot land inside a multi-byte character.
            Some(Err(_)) | None => match value.as_bytes()[1..].iter().position(|b| *b == b'{') {
                Some(i) => consumed += lead + 1 + i,
                // Nothing to resync to yet. More bytes may bring the next
                // payload; the caller caps the carry so this cannot grow
                // without bound.
                None => break,
            },
        }
    }

    (events, consumed)
}

/// Both fields are read leniently: a payload that is valid JSON but not a hook
/// event (or names a hook we ignore) is skipped, never treated as an error.
fn event_from_value(value: &serde_json::Value) -> Option<HookEvent> {
    let session_id = value.get("session_id")?.as_str()?;
    let hook = value.get("hook_event_name")?.as_str()?;
    Some(HookEvent {
        session_id: session_id.to_string(),
        status: status_for_hook(hook)?,
    })
}

/// Start following `path`. Reads from the current end of the file, so events
/// written by a previous run of RocSpace are ignored.
pub fn spawn_tailer(app: AppHandle, path: PathBuf) {
    std::thread::spawn(move || tail_loop(app, path));
}

fn tail_loop(app: AppHandle, path: PathBuf) {
    let mut offset = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    let mut carry: Vec<u8> = Vec::new();

    loop {
        std::thread::sleep(POLL_INTERVAL);

        let Ok(len) = std::fs::metadata(&path).map(|m| m.len()) else {
            // The file can vanish (a user cleaning ~/.rocspace). Start over
            // from zero when it comes back rather than seeking past its end.
            offset = 0;
            carry.clear();
            continue;
        };

        // Someone truncated or replaced the file under us.
        if len < offset {
            offset = 0;
            carry.clear();
        }

        if len > offset {
            match read_from(&path, offset) {
                Ok(bytes) => {
                    offset += bytes.len() as u64;
                    carry.extend_from_slice(&bytes);
                    for event in drain_carry(&mut carry) {
                        emit_status(&app, &event);
                    }
                    if carry.len() > MAX_CARRY_BYTES {
                        carry.clear();
                    }
                }
                Err(err) => eprintln!("[agents] events read failed: {err}"),
            }
        }

        if len > MAX_FILE_BYTES && !has_live_claude_sessions(&app) && truncate(&path) {
            offset = 0;
            carry.clear();
        }
    }
}

/// Decode as much of `carry` as is valid UTF-8, drain the JSON values it
/// contains, and leave the remainder (a partial value, or a multi-byte
/// character split across two reads) in place.
fn drain_carry(carry: &mut Vec<u8>) -> Vec<HookEvent> {
    let valid_len = match std::str::from_utf8(carry) {
        Ok(_) => carry.len(),
        Err(err) => err.valid_up_to(),
    };
    if valid_len == 0 {
        return Vec::new();
    }
    let text = std::str::from_utf8(&carry[..valid_len]).expect("checked prefix is valid UTF-8");
    let (events, consumed) = drain_events(text);
    carry.drain(..consumed);
    events
}

fn read_from(path: &Path, offset: u64) -> std::io::Result<Vec<u8>> {
    let mut file = std::fs::File::open(path)?;
    file.seek(SeekFrom::Start(offset))?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf)?;
    Ok(buf)
}

fn truncate(path: &Path) -> bool {
    match std::fs::File::create(path) {
        Ok(_) => true,
        Err(err) => {
            eprintln!("[agents] events truncate failed: {err}");
            false
        }
    }
}

/// Resolve the session id against the live PTY map and emit. Sessions we do not
/// recognize (a `claude` the user started by hand in a shell pane, or one left
/// over from a previous run) are silently ignored — they own no pane here.
fn emit_status(app: &AppHandle, event: &HookEvent) {
    let Some(runtime) = app.try_state::<PtyRuntime>() else {
        return;
    };
    let Some(terminal_id) = runtime.terminal_for_claude_session(&event.session_id) else {
        return;
    };
    let _ = app.emit(
        EVENT_AGENT_STATUS,
        &AgentStatusEvent {
            terminal_id,
            status: event.status,
        },
    );
}

fn has_live_claude_sessions(app: &AppHandle) -> bool {
    app.try_state::<PtyRuntime>()
        .map(|rt| rt.has_live_claude_sessions())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload(session: &str, hook: &str) -> String {
        format!(r#"{{"session_id":"{session}","hook_event_name":"{hook}","cwd":"/tmp"}}"#)
    }

    // -- hook name → status ----------------------------------------------

    #[test]
    fn maps_the_registered_hooks_onto_statuses() {
        assert_eq!(
            status_for_hook("SessionStart"),
            Some(TerminalStatus::Running)
        );
        assert_eq!(
            status_for_hook("UserPromptSubmit"),
            Some(TerminalStatus::Running)
        );
        assert_eq!(
            status_for_hook("Notification"),
            Some(TerminalStatus::AwaitingApproval)
        );
        assert_eq!(status_for_hook("Stop"), Some(TerminalStatus::Idle));
    }

    #[test]
    fn stop_is_idle_not_complete_because_it_fires_every_turn() {
        // `complete` is the renderer's "notify the user, play the ding" state.
        // Stop fires at the end of every assistant turn, so mapping it there
        // dinged once per turn. Only a real process exit is `complete`, and
        // that comes from the PTY waiter, not from here.
        assert_ne!(status_for_hook("Stop"), Some(TerminalStatus::Complete));
        assert_eq!(status_for_hook("Stop"), Some(TerminalStatus::Idle));
    }

    #[test]
    fn ignores_hooks_we_did_not_register() {
        assert_eq!(status_for_hook("PreToolUse"), None);
        assert_eq!(status_for_hook("SubagentStop"), None);
        assert_eq!(status_for_hook(""), None);
    }

    // -- buffer draining ---------------------------------------------------

    #[test]
    fn reads_one_newline_terminated_payload() {
        let buf = format!("{}\n", payload("s1", "Stop"));
        let (events, consumed) = drain_events(&buf);
        assert_eq!(
            events,
            vec![HookEvent {
                session_id: "s1".into(),
                status: TerminalStatus::Idle,
            }]
        );
        assert_eq!(consumed, buf.len());
    }

    #[test]
    fn reads_payloads_written_back_to_back_without_newlines() {
        // `cat >>` appends exactly what Claude Code piped in; nothing promises
        // a trailing newline, so this is the shape a line-splitter would miss.
        let buf = format!("{}{}", payload("s1", "SessionStart"), payload("s1", "Stop"));
        let (events, consumed) = drain_events(&buf);
        assert_eq!(
            events.iter().map(|e| e.status).collect::<Vec<_>>(),
            vec![TerminalStatus::Running, TerminalStatus::Idle]
        );
        assert_eq!(consumed, buf.len());
    }

    #[test]
    fn leaves_a_half_written_payload_for_the_next_read() {
        let whole = payload("s1", "Stop");
        let buf = format!("{}\n{}", whole, &payload("s2", "Stop")[..12]);
        let (events, consumed) = drain_events(&buf);
        assert_eq!(events.len(), 1);
        // Only the finished value is consumed; the separator rides along with
        // the partial one and is skipped as leading whitespace next time.
        assert_eq!(consumed, whole.len());

        // Second read completes it.
        let rest = format!("{}{}", &buf[consumed..], &payload("s2", "Stop")[12..]);
        let (events, consumed) = drain_events(&rest);
        assert_eq!(events[0].session_id, "s2");
        assert_eq!(consumed, rest.len());
    }

    #[test]
    fn skips_payloads_for_hooks_we_ignore_but_keeps_consuming() {
        let buf = format!(
            "{}\n{}\n",
            payload("s1", "PreToolUse"),
            payload("s1", "Notification")
        );
        let (events, consumed) = drain_events(&buf);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].status, TerminalStatus::AwaitingApproval);
        assert_eq!(consumed, buf.len());
    }

    #[test]
    fn skips_json_that_is_not_a_hook_payload() {
        let buf = format!(
            "{{\"unrelated\":true}}\n[1,2,3]\n{}\n",
            payload("s1", "Stop")
        );
        let (events, _) = drain_events(&buf);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].session_id, "s1");
    }

    #[test]
    fn recovers_from_garbage_between_two_payloads_with_no_newlines() {
        // The shape that matters: `cat >>` appends whatever Claude Code piped
        // in, with no separator, so a stray byte lands *inside* a run of
        // back-to-back objects. A reader that resynced to the next newline
        // found none here and consumed nothing, forever.
        let buf = format!(
            "{}\u{1}garbage{}",
            payload("s1", "SessionStart"),
            payload("s2", "Stop")
        );
        assert!(!buf.contains('\n'), "the fixture must not offer a newline");

        let (events, consumed) = drain_events(&buf);
        assert_eq!(
            events,
            vec![
                HookEvent {
                    session_id: "s1".into(),
                    status: TerminalStatus::Running,
                },
                HookEvent {
                    session_id: "s2".into(),
                    status: TerminalStatus::Idle,
                },
            ]
        );
        assert_eq!(consumed, buf.len());
    }

    #[test]
    fn a_leading_stray_byte_does_not_wedge_the_buffer() {
        let buf = format!("\u{1}{}", payload("s1", "Stop"));
        let (events, consumed) = drain_events(&buf);
        assert_eq!(events.len(), 1);
        assert_eq!(consumed, buf.len());
    }

    #[test]
    fn garbage_that_starts_with_a_brace_still_makes_progress() {
        // The resync starts one byte past the failure, so an unparseable
        // object cannot match itself and spin.
        let buf = format!("{{oops{}", payload("s1", "Stop"));
        assert!(!buf.contains('\n'));
        let (events, consumed) = drain_events(&buf);
        assert_eq!(events.len(), 1);
        assert_eq!(consumed, buf.len());
    }

    #[test]
    fn a_truncated_payload_followed_by_a_whole_one_recovers() {
        // Two hooks firing at once can interleave their `cat >>` writes; the
        // survivor must still be read.
        let buf = format!(
            "{}{}",
            &payload("s1", "Stop")[..20],
            payload("s2", "Notification")
        );
        assert!(!buf.contains('\n'));
        let (events, consumed) = drain_events(&buf);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].session_id, "s2");
        assert_eq!(events[0].status, TerminalStatus::AwaitingApproval);
        assert_eq!(consumed, buf.len());
    }

    #[test]
    fn garbage_with_nothing_after_it_waits_rather_than_guessing() {
        // No `{` to resync to yet — the next payload may still be on its way,
        // and the caller caps the carry, so waiting is safe.
        let (events, consumed) = drain_events("not json at all");
        assert!(events.is_empty());
        assert_eq!(consumed, 0);
    }

    #[test]
    fn a_garbage_line_is_still_recovered_when_newlines_do_exist() {
        let buf = format!("not json at all\n{}\n", payload("s1", "Stop"));
        let (events, consumed) = drain_events(&buf);
        assert_eq!(events.len(), 1, "the good line after the garbage is read");
        assert_eq!(consumed, buf.len());
    }

    #[test]
    fn consumes_a_whitespace_only_buffer() {
        let (events, consumed) = drain_events("\n\n  \n");
        assert!(events.is_empty());
        assert_eq!(consumed, 5);
    }

    #[test]
    fn empty_buffer_consumes_nothing() {
        assert_eq!(drain_events(""), (Vec::new(), 0));
    }

    // -- byte-level carry --------------------------------------------------

    #[test]
    fn a_multibyte_character_split_across_reads_is_not_corrupted() {
        let whole = r#"{"session_id":"sé1","hook_event_name":"Stop"}"#.as_bytes();
        let split = whole
            .iter()
            .position(|b| *b == 0xC3)
            .expect("the é lead byte");

        let mut carry = whole[..=split].to_vec();
        assert!(drain_carry(&mut carry).is_empty(), "half a char, no event");

        carry.extend_from_slice(&whole[split + 1..]);
        let events = drain_carry(&mut carry);
        assert_eq!(events[0].session_id, "sé1");
        assert!(carry.is_empty());
    }
}
