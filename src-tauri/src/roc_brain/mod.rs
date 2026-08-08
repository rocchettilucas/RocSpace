//! Roc's brain — the reasoning turn behind a spoken request.
//!
//! Phase 4 gave Roc a microphone and a fan-out; what it did not give it was a
//! thought. A transcript went to the panes as typed, so "ask Rocky to fix the
//! auth test and have Roxie update the login form" reached both agents as that
//! whole sentence, addressed to nobody in particular. This module is the step in
//! between: it runs the request through the **Claude Code CLI in print mode**
//! (`claude -p … --output-format json`) and hands the renderer back the model's
//! answer, which `lib/rocBrain` parses into a reply plus one tailored prompt per
//! agent.
//!
//! Three rules hold here, and each of them is a bug that has already been paid
//! for somewhere else in this app:
//!
//!   * **ARGV, never a shell string.** The prompt is a sentence a speech model
//!     produced from a room's worth of audio — `$(rm -rf ~)` is a thing Whisper
//!     can type. `Command::arg` hands each value to `execve` as one element, so
//!     the only thing that can interpret a backtick is the model reading it as a
//!     character. There is no `sh -c` here and there must never be one; the
//!     tests assert it by trying. The same goes for the reply this module
//!     speaks: `say` gets argv too.
//!   * **PATH is the trap.** A packaged RocSpace launched from Finder inherits a
//!     minimal PATH — no nvm, no homebrew, no `~/.local/bin` — and `claude` is
//!     almost always in one of those. So the binary is looked for in three
//!     places in turn (this process's PATH, an INTERACTIVE login shell, the
//!     handful of paths `claude` actually installs itself to), a HIT is
//!     remembered and a MISS never is, and a miss is a typed error naming the
//!     fix rather than a silent nothing. That chain lives in `crate::cli_binary`
//!     now — the agent panes had the same trap and were failing it, so it is
//!     shared rather than owned by this module.
//!   * **Nothing unbounded.** A child that never exits, a pipe nobody drains, a
//!     model that answers with a megabyte of prose: each of those is a hang or a
//!     heap, so there is a deadline on the wait, a cap on every read, and a kill
//!     when the deadline passes.
//!
//! Not the Anthropic API directly, for the reason the whole app shells out to
//! CLIs: the user's `claude` already holds their credentials, their model
//! access and their config. A second client would need an API key this app has
//! no business asking for.
//!
//! The cwd is the OS temp directory rather than a project. `claude -p` reads
//! `CLAUDE.md` from wherever it is run and would happily route a request using
//! the instructions in whichever repository the app happened to be launched
//! from — routing is about the session roster in the prompt, and nothing else.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::cli_binary::{self, env_binary};

/// How long a thought may take before the child is killed. Generous because a
/// cold `claude` start plus a model turn is seconds, not milliseconds; bounded
/// because a wedged child is a spinner that never stops.
pub const DEFAULT_TIMEOUT_SECS: u32 = 60;

/// The ceiling on a caller-supplied timeout. Ten minutes is far past any
/// routing turn and far short of "never".
const MAX_TIMEOUT_SECS: u32 = 600;

/// The most stdout one thought may produce. The envelope is a few kilobytes;
/// anything approaching this is a model that has lost the plot, and reading it
/// into a `Vec<u8>` is the renderer's memory.
const MAX_STDOUT_BYTES: usize = 1024 * 1024;

/// Stderr is a sentence for a toast, not a payload.
const MAX_STDERR_BYTES: usize = 64 * 1024;

/// How much of a failure's output is quoted back to the user. Two kilobytes is
/// a paragraph — enough to see the actual complaint, short enough for a toast.
const ERROR_TAIL_BYTES: usize = 2 * 1024;

/// How often the wait wakes to ask whether the child is done. Small enough that
/// a fast answer feels immediate, large enough that a minute of waiting is a
/// few thousand cheap syscalls rather than a spin.
const POLL_INTERVAL: Duration = Duration::from_millis(25);

// ---------------------------------------------------------------------------
// DTOs (mirrored by hand into src/lib/bindings.ts)
// ---------------------------------------------------------------------------

/// One completed thought.
///
/// `cost_usd` is carried because it is real money and the user should be able
/// to see it: Claude Code re-sends its own system prompt on every print-mode
/// call, so even a one-sentence routing question is a few cents. `None` means
/// the envelope did not say.
///
/// `is_error` is the envelope's own flag. It is `false` on every value this
/// module returns today — a failed turn comes back as `Err` with the best
/// sentence available, because a caller that dispatched the "text" of an errored
/// turn would paste an error message into somebody's agent. It is kept because
/// the renderer's contract names it and because a future partial answer (an
/// error the model can still say something useful about) has somewhere to go.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RocThinkResult {
    /// The model's answer — the envelope's `result` field, verbatim.
    pub text: String,
    pub is_error: bool,
    pub cost_usd: Option<f64>,
    /// Wall clock, spawn to exit. Ours rather than the envelope's, because what
    /// the user waited through includes starting the process.
    pub duration_ms: u32,
}

// ---------------------------------------------------------------------------
// Finding `claude`
// ---------------------------------------------------------------------------

/// The `claude` this process will run, or the sentence to show the user.
///
/// The chain itself — process PATH, then an INTERACTIVE login shell, then the
/// places the installer uses — lives in `crate::cli_binary`, because the agent
/// panes need exactly the same answer and were shipping a bare `claude` into a
/// non-interactive shell for want of it.
pub fn claude_binary() -> Result<PathBuf, String> {
    cli_binary::resolve(cli_binary::CLAUDE)
}

// ---------------------------------------------------------------------------
// Running a child without hanging on it
// ---------------------------------------------------------------------------

struct Finished {
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    status: ExitStatus,
}

impl Finished {
    fn stderr_text(&self) -> String {
        String::from_utf8_lossy(&self.stderr).trim().to_string()
    }

    fn stdout_text(&self) -> String {
        String::from_utf8_lossy(&self.stdout).trim().to_string()
    }
}

/// Read at most `limit` bytes, then drain the rest into nothing.
///
/// Draining is not optional: stopping at the cap and walking away leaves the
/// child blocked writing into a full pipe, which turns a big answer into a hang.
fn read_capped(pipe: &mut impl Read, limit: usize) -> Vec<u8> {
    let mut buf = Vec::new();
    let _ = pipe.take(limit as u64).read_to_end(&mut buf);
    let _ = std::io::copy(pipe, &mut std::io::sink());
    buf
}

/// Wait for `child`, capping both pipes and killing it at the deadline.
///
/// Both pipes are read on their own threads. Not decoration: with one reader and
/// both pipes filling, the child blocks writing to the one nobody is draining
/// while we block reading the one it is not writing — a deadlock that only shows
/// up on the runs with the most to say.
fn wait_capped(mut child: Child, limit: Duration) -> Result<Finished, String> {
    let mut out_pipe = child
        .stdout
        .take()
        .ok_or_else(|| "child stdout unavailable".to_string())?;
    let mut err_pipe = child
        .stderr
        .take()
        .ok_or_else(|| "child stderr unavailable".to_string())?;
    let out_reader = std::thread::spawn(move || read_capped(&mut out_pipe, MAX_STDOUT_BYTES));
    let err_reader = std::thread::spawn(move || read_capped(&mut err_pipe, MAX_STDERR_BYTES));

    let deadline = Instant::now() + limit;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(e) => return Err(format!("could not wait for the child: {e}")),
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            // The readers are LEFT RUNNING, and that is the whole point of the
            // deadline. Killing a process does not close a pipe its own
            // children inherited, so a `claude` that spawned anything at all
            // leaves both pipes open with nobody left to write to them — and a
            // join here would sit on that grandchild for as long as it felt
            // like living, which is a timeout that does not time out. (The
            // first version of this joined. A test whose stub was `sleep 30`
            // took thirty seconds to report a three-hundred-millisecond
            // deadline.) Each thread holds one fd and a capped buffer, drains
            // to a sink, and ends when the last writer does.
            drop(out_reader);
            drop(err_reader);
            return Err(format!(
                "Claude Code took longer than {}s and was stopped",
                limit.as_secs()
            ));
        }
        std::thread::sleep(POLL_INTERVAL);
    };

    let stdout = out_reader
        .join()
        .map_err(|_| "stdout reader panicked".to_string())?;
    let stderr = err_reader
        .join()
        .map_err(|_| "stderr reader panicked".to_string())?;
    Ok(Finished {
        stdout,
        stderr,
        status,
    })
}

/// What a reader thread collected, if it can be had by `limit`.
///
/// A thread that has not finished by then is LEFT RUNNING and its answer given
/// up on, for the same reason `wait_capped` leaves its own readers: a pipe is
/// only closed when the last process holding it lets go, and that can be
/// something the child started rather than the child. Joining it is how a
/// bounded wait becomes an unbounded one. Each detached thread holds one fd and
/// a capped buffer, drains to a sink, and ends when the last writer does.
fn join_capped(reader: std::thread::JoinHandle<Vec<u8>>, limit: Duration) -> Vec<u8> {
    let deadline = Instant::now() + limit;
    while !reader.is_finished() {
        if Instant::now() >= deadline {
            return Vec::new();
        }
        std::thread::sleep(POLL_INTERVAL);
    }
    reader.join().unwrap_or_default()
}

/// The last `ERROR_TAIL_BYTES` of something that went wrong, on a char
/// boundary. The TAIL rather than the head because a CLI's last words are the
/// complaint; everything before it is progress it no longer matters about.
fn tail(text: &str) -> String {
    if text.len() <= ERROR_TAIL_BYTES {
        return text.to_string();
    }
    let mut start = text.len() - ERROR_TAIL_BYTES;
    while start < text.len() && !text.is_char_boundary(start) {
        start += 1;
    }
    format!("…{}", &text[start..])
}

// ---------------------------------------------------------------------------
// Thinking
// ---------------------------------------------------------------------------

/// The envelope's `result`, however the CLI framed it.
///
/// Tolerant on purpose. `--output-format json` prints one object and nothing
/// else — until the day it prints an update notice above it, and a strict parse
/// would turn a working answer into "Claude Code did not answer with JSON". So
/// the whole of stdout is tried first, and then each line from the bottom up.
fn parse_envelope(stdout: &str) -> Option<serde_json::Value> {
    let whole = stdout.trim();
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(whole) {
        if value.is_object() {
            return Some(value);
        }
    }
    whole.lines().rev().find_map(|line| {
        serde_json::from_str::<serde_json::Value>(line.trim())
            .ok()
            .filter(serde_json::Value::is_object)
    })
}

/// Run one thought through `bin`.
///
/// Split from `think_blocking` so the tests can point it at a stub script
/// without touching the process environment — every assertion about argv,
/// timeouts and envelopes is about this function.
fn think_with(
    bin: &Path,
    prompt: &str,
    model: Option<&str>,
    limit: Duration,
) -> Result<RocThinkResult, String> {
    if prompt.trim().is_empty() {
        return Err("there is nothing to think about".to_string());
    }
    if prompt.contains('\0') {
        return Err("the request contains a NUL byte".to_string());
    }
    let model = model.map(str::trim).filter(|m| !m.is_empty());
    if model.is_some_and(|m| m.contains('\0')) {
        return Err("the model name contains a NUL byte".to_string());
    }

    let mut command = Command::new(bin);
    command.arg("-p").arg("--output-format").arg("json");
    if let Some(model) = model {
        command.arg("--model").arg(model);
    }
    // `--` and then the prompt, always last. The prompt is a positional
    // argument (`claude [options] [prompt]`), so a request that happens to
    // start with a dash — "-- fix the tests", which is a thing a person says —
    // would otherwise be read as an option and rejected.
    command.arg("--").arg(prompt);

    command
        // NOT a project directory: see the module docs. `claude` reads
        // CLAUDE.md from its cwd, and the routing decision must depend on the
        // roster in the prompt rather than on whichever repository the app was
        // launched from.
        .current_dir(std::env::temp_dir())
        // Nothing to type at it. A child that inherits this process's stdin
        // would sit waiting on a terminal that is not there.
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let started = Instant::now();
    let child = command
        .spawn()
        .map_err(|e| format!("could not run {}: {e}", bin.display()))?;
    let finished = wait_capped(child, limit)?;
    let duration_ms = started.elapsed().as_millis().min(u128::from(u32::MAX)) as u32;

    if !finished.status.success() {
        let stderr = finished.stderr_text();
        let stdout = finished.stdout_text();
        let detail = if !stderr.is_empty() {
            tail(&stderr)
        } else if !stdout.is_empty() {
            tail(&stdout)
        } else {
            match finished.status.code() {
                Some(code) => format!("exit status {code}"),
                None => "killed by a signal".to_string(),
            }
        };
        return Err(format!("Claude Code failed: {detail}"));
    }

    let stdout = finished.stdout_text();
    let Some(envelope) = parse_envelope(&stdout) else {
        return Err(format!(
            "Claude Code did not answer with JSON: {}",
            tail(&stdout)
        ));
    };

    let is_error = envelope
        .get("is_error")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let text = envelope
        .get("result")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_string();

    if is_error {
        // The envelope says the turn failed. Whatever is in `result` is the
        // model's account of the failure, not an answer — dispatching it would
        // paste an error into somebody's agent — so it becomes the message.
        let stderr = finished.stderr_text();
        let detail = if !stderr.is_empty() {
            tail(&stderr)
        } else if !text.trim().is_empty() {
            tail(text.trim())
        } else {
            "no reason given".to_string()
        };
        return Err(format!("Claude Code reported an error: {detail}"));
    }

    if envelope.get("result").is_none() {
        return Err(format!(
            "Claude Code's answer had no result: {}",
            tail(&stdout)
        ));
    }

    Ok(RocThinkResult {
        text,
        is_error: false,
        cost_usd: envelope
            .get("total_cost_usd")
            .and_then(serde_json::Value::as_f64),
        duration_ms,
    })
}

/// One thought, on the caller's thread. `roc_think` is the async wrapper.
pub fn think_blocking(
    prompt: &str,
    model: Option<&str>,
    timeout_secs: Option<u32>,
) -> Result<RocThinkResult, String> {
    let seconds = timeout_secs
        .unwrap_or(DEFAULT_TIMEOUT_SECS)
        .clamp(1, MAX_TIMEOUT_SECS);
    think_with(
        &claude_binary()?,
        prompt,
        model,
        Duration::from_secs(u64::from(seconds)),
    )
}

// ---------------------------------------------------------------------------
// Speaking
// ---------------------------------------------------------------------------

/// The test seam for `say`, and nothing else: there is no user-facing reason to
/// point RocSpace at a different speech binary, so this is deliberately not a
/// setting.
const SAY_BIN_ENV: &str = "ROCSPACE_SAY_BIN";

/// Absolute, so a PATH that does not include `/usr/bin` (see the module docs on
/// how little PATH a Finder-launched app has) still finds it.
const SAY_BIN: &str = "/usr/bin/say";

/// The most text one reply may be spoken. Two kilobytes is around two minutes
/// of speech; a reply longer than that is a bug upstream, and the user cannot
/// interrupt a paragraph they did not ask for except by pressing Stop.
const MAX_SPOKEN_BYTES: usize = 2 * 1024;

/// How often the speaking wait wakes. Coarser than the thinking poll because
/// speech is seconds long and nothing is waiting on the millisecond.
const SPEECH_POLL: Duration = Duration::from_millis(50);

/// The band `say -r` may be asked for, mirroring `ROC_SPEECH_RATE_MIN` /
/// `ROC_SPEECH_RATE_MAX` in `src/stores/settings.ts`.
///
/// Clamped HERE as well as in the picker, and that is the point: the renderer's
/// slider is one caller, a `settings.dat` somebody edited by hand is another,
/// and a command that trusted its argument would speak a reply at six words a
/// minute or at a rate that is not language. Clamped rather than rejected —
/// there is no useful error for "your voice was going to be too fast", and the
/// nearest audible rate is what the user meant.
const SPEECH_RATE_MIN: u16 = 120;
const SPEECH_RATE_MAX: u16 = 260;

/// How long a `say` that FAILED gets to explain itself. Its complaint is one
/// line and it is already written by the time the process is gone; a reader
/// still going after half a second is holding a pipe on something else's
/// account, and the exit status is a good enough answer to wait no longer.
const SPEECH_STDERR_WAIT: Duration = Duration::from_millis(500);

/// The one voice, and the generation that owns it.
///
/// The id is what makes "am I still the current speaker" answerable after the
/// fact: a reply that is replaced mid-sentence must not report the kill it just
/// suffered as a failure, and a stop that lands between the wait and the
/// bookkeeping must not have its state overwritten by the speaker it stopped.
struct Speaking {
    id: u64,
    child: Arc<Mutex<Child>>,
}

/// The slot, and the right to change what is in it.
///
/// One lock, held across the whole of "stop what is speaking, start this, and
/// say that this is what is speaking" — see `speak_with`. Two callers that each
/// stopped, spawned and registered without it (Settings' Audition button pressed
/// while a reply is reading is exactly two callers) both found an empty slot,
/// both started a `say`, and the second registration orphaned a child that was
/// talking with nothing left in the app that could reach it. Two voices at once,
/// and a Stop that silenced one of them.
static SPEAKING: Mutex<Option<Speaking>> = Mutex::new(None);
static SPEECH_SEQ: AtomicU64 = AtomicU64::new(0);

fn say_binary() -> PathBuf {
    env_binary(SAY_BIN_ENV).unwrap_or_else(|| PathBuf::from(SAY_BIN))
}

/// What is safe to hand `say`.
///
/// Control bytes are stripped — they are nothing to a synthesizer and something
/// to a terminal, and this text has been through a language model — and the
/// whole is capped. Newlines become spaces so a two-line reply is one sentence
/// rather than two silences.
fn sanitize_spoken(text: &str) -> String {
    let mut cleaned = String::with_capacity(text.len().min(MAX_SPOKEN_BYTES));
    for ch in text.chars() {
        if cleaned.len() >= MAX_SPOKEN_BYTES {
            break;
        }
        if ch == '\n' || ch == '\r' || ch == '\t' {
            cleaned.push(' ');
        } else if !ch.is_control() {
            cleaned.push(ch);
        }
    }
    cleaned.trim().to_string()
}

/// Empty the slot, killing whoever was in it. The caller holds the lock, which
/// is the point: a stop and the start that replaces it are one atomic act.
///
/// Killing under the lock is safe because nothing that holds the CHILD's lock
/// ever waits for this one: the speaker's poll takes it for the length of a
/// `try_wait`, which cannot block, and its bookkeeping takes the slot's lock
/// while holding nothing.
fn silence(slot: &mut Option<Speaking>) {
    if let Some(speaking) = slot.take() {
        let mut child = speaking.child.lock();
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// Stop whatever is speaking. Safe when nothing is.
pub fn stop_speaking() {
    silence(&mut SPEAKING.lock());
}

/// Give up the slot if it is still ours. Answers whether it was — a speaker
/// that finds somebody else's generation there was replaced or stopped, and has
/// nothing to report.
fn release_if_current(id: u64) -> bool {
    let mut slot = SPEAKING.lock();
    if slot.as_ref().is_some_and(|s| s.id == id) {
        *slot = None;
        return true;
    }
    false
}

/// Speak `text` through `bin`, replacing whatever was speaking.
///
/// Resolves when the speech ENDS — that is what lets the renderer hold the
/// "speaking" phase for exactly as long as there is sound, and what makes Stop
/// (which kills the child) resolve it immediately.
///
/// **Stopping, starting and registering are one atomic act**, under the slot's
/// lock. Doing them without it is a race with a voice in it: two callers
/// (Settings' Audition button pressed while a reply is reading) each stopped
/// nothing, each started a `say`, and whichever registered second left the other
/// one talking with nothing in the app that could reach it — so both were heard
/// at once, and Stop ended only one of them.
///
/// `rate` is words per minute, or `None` for whatever `say` does on its own —
/// which is what a user who has never touched the slider should hear, and is
/// not the same thing as passing that machine's default back to it.
#[cfg(any(target_os = "macos", test))]
fn speak_with(
    bin: &Path,
    text: &str,
    voice: Option<&str>,
    rate: Option<u16>,
) -> Result<(), String> {
    let spoken = sanitize_spoken(text);

    let mut slot = SPEAKING.lock();
    // Nothing to say is still "stop saying the last thing": a reply that
    // sanitizes to nothing must not leave the previous one talking over it.
    silence(&mut slot);
    if spoken.is_empty() {
        return Ok(());
    }

    let mut command = Command::new(bin);
    if let Some(voice) = voice
        .map(str::trim)
        .filter(|v| !v.is_empty() && !v.contains('\0'))
    {
        command.arg("-v").arg(voice);
    }
    // Two argv elements — `-r` and the number — never one string, and never a
    // number this module has not bounded itself.
    if let Some(rate) = rate {
        command
            .arg("-r")
            .arg(rate.clamp(SPEECH_RATE_MIN, SPEECH_RATE_MAX).to_string());
    }
    // Same rule as the prompt: `--`, then the text as one argument. A reply
    // that begins with a dash is a reply, not a flag.
    command
        .arg("--")
        .arg(&spoken)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|e| format!("could not run {}: {e}", bin.display()))?;
    let stderr_reader = child
        .stderr
        .take()
        .map(|mut pipe| std::thread::spawn(move || read_capped(&mut pipe, MAX_STDERR_BYTES)));

    let id = SPEECH_SEQ.fetch_add(1, Ordering::SeqCst) + 1;
    let shared = Arc::new(Mutex::new(child));
    *slot = Some(Speaking {
        id,
        child: shared.clone(),
    });
    // Registered, and only now is anybody else allowed to stop it. Everything
    // above this line was one caller's turn; everything below is a wait.
    drop(slot);

    let status = loop {
        let waited = { shared.lock().try_wait() };
        match waited {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(e) => {
                release_if_current(id);
                return Err(format!("could not wait for say: {e}"));
            }
        }
        std::thread::sleep(SPEECH_POLL);
    };

    // Replaced or stopped: the non-zero status is the kill we asked for, not a
    // failure worth telling anybody about — and there is therefore nothing to
    // read. The reader is DROPPED rather than joined, which is the same
    // discipline (and the same reason) as the timeout in `wait_capped`: killing
    // `say` does not close the stderr pipe anything IT started inherited, so a
    // join here waits out a grandchild long after the Stop the user pressed.
    // That is a `roc_speak` promise still pending — and a blocking worker still
    // parked — for the whole length of a speech that has already been silenced.
    if !release_if_current(id) {
        return Ok(());
    }
    if status.success() {
        return Ok(());
    }

    // A real failure, so its own words are worth a bounded wait. `say` writes
    // one line and has already exited; a reader still going after this is
    // holding a pipe somebody else has open, and the exit status says enough.
    let stderr = stderr_reader
        .map(|reader| join_capped(reader, SPEECH_STDERR_WAIT))
        .unwrap_or_default();
    let detail = String::from_utf8_lossy(&stderr).trim().to_string();
    let detail = if detail.is_empty() {
        match status.code() {
            Some(code) => format!("exit status {code}"),
            None => "killed by a signal".to_string(),
        }
    } else {
        tail(&detail)
    };
    Err(format!("Could not speak that: {detail}"))
}

/// Say `text` aloud, replacing whatever was speaking. Resolves when it stops.
#[cfg(target_os = "macos")]
pub fn speak_blocking(
    text: &str,
    voice: Option<&str>,
    rate: Option<u16>,
) -> Result<(), String> {
    speak_with(&say_binary(), text, voice, rate)
}

/// Everywhere else there is no `say`, and a UI that had to branch on the
/// platform for a feature it cannot offer is a UI with a dead button in it. So
/// this succeeds having done nothing, and `roc_list_voices` answers with an
/// empty list — which the picker already renders as "system default only".
#[cfg(not(target_os = "macos"))]
pub fn speak_blocking(
    _text: &str,
    _voice: Option<&str>,
    _rate: Option<u16>,
) -> Result<(), String> {
    Ok(())
}

/// The names out of `say -v ?`.
///
/// The format is `<name><spaces><locale>    # <sample sentence>`, and the name
/// is not one word: `Eddy (English (UK)) en_GB` is a real line, with a single
/// space between the name and the locale. So the sample is cut at the `#`, the
/// trailing locale-shaped token is dropped, and everything left is the name.
fn parse_voice_names(listing: &str) -> Vec<String> {
    let mut names = Vec::new();
    for line in listing.lines() {
        let head = line.split('#').next().unwrap_or_default().trim();
        if head.is_empty() {
            continue;
        }
        let name = match head.rsplit_once(char::is_whitespace) {
            Some((name, last)) if is_locale(last) => name.trim_end(),
            _ => head,
        };
        if name.is_empty() {
            continue;
        }
        // `say` lists one line per voice per locale, and two locales can share a
        // display name. The picker is a list of names.
        if !names.iter().any(|existing| existing == name) {
            names.push(name.to_string());
        }
    }
    names
}

fn is_locale(token: &str) -> bool {
    token.len() >= 2
        && token.starts_with(|c: char| c.is_ascii_alphabetic())
        && token
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// Every voice `say` offers. Empty off macOS, and empty rather than an error
/// when `say` cannot be run — a picker with no choices is a picker that says
/// "system default", which is the truth.
pub fn list_voices_blocking() -> Vec<String> {
    if !cfg!(target_os = "macos") && env_binary(SAY_BIN_ENV).is_none() {
        return Vec::new();
    }
    let Ok(child) = Command::new(say_binary())
        .arg("-v")
        .arg("?")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    else {
        return Vec::new();
    };
    let Ok(finished) = wait_capped(child, Duration::from_secs(10)) else {
        return Vec::new();
    };
    if !finished.status.success() {
        return Vec::new();
    }
    parse_voice_names(&String::from_utf8_lossy(&finished.stdout))
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Reason about `prompt` and hand back the model's answer.
///
/// Async, and the work is done on a blocking task, for the reason `lib.rs`
/// documents about every command in this app: a synchronous command runs on the
/// MAIN thread, and this one waits on a subprocess for up to a minute. That is
/// not a slow answer, it is a frozen window.
#[tauri::command]
#[specta::specta]
pub async fn roc_think(
    prompt: String,
    model: Option<String>,
    timeout_secs: Option<u32>,
) -> Result<RocThinkResult, String> {
    tokio::task::spawn_blocking(move || think_blocking(&prompt, model.as_deref(), timeout_secs))
        .await
        .map_err(|e| format!("roc_think join: {e}"))?
}

/// Say `text` aloud. Resolves when the speech finishes — or immediately, when
/// `roc_stop_speaking` or another reply cuts it off.
///
/// `rate` is words per minute. `None` leaves `say` to its own default; anything
/// outside the band this module holds is clamped rather than believed, because
/// the caller is a settings file as often as it is a slider.
#[tauri::command]
#[specta::specta]
pub async fn roc_speak(
    text: String,
    voice: Option<String>,
    rate: Option<u16>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || speak_blocking(&text, voice.as_deref(), rate))
        .await
        .map_err(|e| format!("roc_speak join: {e}"))?
}

/// Stop the current reply. Succeeds when nothing is speaking.
#[tauri::command]
#[specta::specta]
pub async fn roc_stop_speaking() -> Result<(), String> {
    tokio::task::spawn_blocking(stop_speaking)
        .await
        .map_err(|e| format!("roc_stop_speaking join: {e}"))
}

/// Every voice the system offers. Empty off macOS.
#[tauri::command]
#[specta::specta]
pub async fn roc_list_voices() -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(list_voices_blocking)
        .await
        .map_err(|e| format!("roc_list_voices join: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    // -- stubs -----------------------------------------------------------
    //
    // Every test that runs a child runs a shell script this file wrote. That
    // is the point: the assertions are about what reaches the child's argv and
    // what this module does with what comes back, and a real `claude` would
    // answer neither question (and would cost money asking).

    #[cfg(unix)]
    fn stub(dir: &Path, name: &str, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join(name);
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        let mut perms = std::fs::metadata(&path).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&path, perms).unwrap();
        path
    }

    #[cfg(unix)]
    const OK_ENVELOPE: &str = r#"{"type":"result","subtype":"success","is_error":false,"result":"the answer","session_id":"abc","total_cost_usd":0.17}"#;

    #[cfg(unix)]
    fn short() -> Duration {
        Duration::from_secs(20)
    }

    // -- the envelope ----------------------------------------------------

    #[test]
    fn parses_a_plain_envelope() {
        let value = parse_envelope(r#"{"result":"hi"}"#).unwrap();
        assert_eq!(value.get("result").unwrap(), "hi");
    }

    #[test]
    fn finds_the_envelope_under_a_notice() {
        let value = parse_envelope("Update available: 2.0.0\nnot json either\n{\"result\":\"hi\"}")
            .unwrap();
        assert_eq!(value.get("result").unwrap(), "hi");
    }

    #[test]
    fn refuses_output_with_no_object_in_it() {
        assert!(parse_envelope("command not found\n[1,2,3]").is_none());
    }

    #[test]
    fn tail_keeps_the_end_and_stays_on_a_char_boundary() {
        let text = "é".repeat(ERROR_TAIL_BYTES);
        let cut = tail(&text);
        assert!(cut.starts_with('…'));
        assert!(cut.ends_with('é'));
    }

    // -- thinking --------------------------------------------------------

    #[cfg(unix)]
    #[test]
    fn a_successful_turn_carries_the_text_and_the_cost() {
        let tmp = TempDir::new().unwrap();
        let bin = stub(tmp.path(), "claude", &format!("echo '{OK_ENVELOPE}'"));

        let result = think_with(&bin, "who is doing what?", None, short()).unwrap();

        assert_eq!(result.text, "the answer");
        assert!(!result.is_error);
        assert_eq!(result.cost_usd, Some(0.17));
    }

    #[cfg(unix)]
    #[test]
    fn an_envelope_that_says_is_error_is_an_error() {
        let tmp = TempDir::new().unwrap();
        let bin = stub(
            tmp.path(),
            "claude",
            "echo 'credit balance too low' >&2\n\
             echo '{\"is_error\":true,\"result\":\"could not answer\"}'",
        );

        let err = think_with(&bin, "who is doing what?", None, short()).unwrap_err();

        assert!(err.contains("credit balance too low"), "got: {err}");
    }

    #[cfg(unix)]
    #[test]
    fn an_is_error_envelope_with_a_silent_stderr_quotes_the_result() {
        let tmp = TempDir::new().unwrap();
        let bin = stub(
            tmp.path(),
            "claude",
            "echo '{\"is_error\":true,\"result\":\"max turns exceeded\"}'",
        );

        let err = think_with(&bin, "who is doing what?", None, short()).unwrap_err();

        assert!(err.contains("max turns exceeded"), "got: {err}");
    }

    #[cfg(unix)]
    #[test]
    fn output_that_is_not_json_is_reported_with_what_was_said() {
        let tmp = TempDir::new().unwrap();
        let bin = stub(tmp.path(), "claude", "echo 'Welcome to Claude Code!'");

        let err = think_with(&bin, "who is doing what?", None, short()).unwrap_err();

        assert!(err.contains("did not answer with JSON"), "got: {err}");
        assert!(err.contains("Welcome to Claude Code!"), "got: {err}");
    }

    #[cfg(unix)]
    #[test]
    fn a_non_zero_exit_reports_the_stderr_tail() {
        let tmp = TempDir::new().unwrap();
        let bin = stub(
            tmp.path(),
            "claude",
            "echo 'Invalid API key · Please run /login' >&2\nexit 1",
        );

        let err = think_with(&bin, "who is doing what?", None, short()).unwrap_err();

        assert!(err.contains("Invalid API key"), "got: {err}");
    }

    #[cfg(unix)]
    #[test]
    fn a_missing_binary_names_the_path_it_tried() {
        let tmp = TempDir::new().unwrap();
        let missing = tmp.path().join("not-here");

        let err = think_with(&missing, "who is doing what?", None, short()).unwrap_err();

        assert!(err.contains("not-here"), "got: {err}");
    }

    #[cfg(unix)]
    #[test]
    fn a_child_that_never_finishes_is_killed_at_the_deadline() {
        let tmp = TempDir::new().unwrap();
        let bin = stub(tmp.path(), "claude", "sleep 30");

        let started = Instant::now();
        let err =
            think_with(&bin, "who is doing what?", None, Duration::from_millis(300)).unwrap_err();

        assert!(err.contains("took longer"), "got: {err}");
        // Comfortably inside the stub's own thirty seconds: the deadline has to
        // be answered by the deadline, not by the child eventually giving up.
        // The stub is `sleep 30` under `/bin/sh`, so killing the shell leaves a
        // grandchild holding both pipes — see `wait_capped`.
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "the wait did not come back at the deadline"
        );
    }

    #[test]
    fn an_empty_prompt_is_refused_before_anything_is_spawned() {
        let err = think_with(Path::new("/does/not/exist"), "   ", None, short()).unwrap_err();
        assert!(err.contains("nothing to think about"), "got: {err}");
    }

    #[test]
    fn a_prompt_with_a_nul_is_refused() {
        let err = think_with(Path::new("/does/not/exist"), "a\0b", None, short()).unwrap_err();
        assert!(err.contains("NUL"), "got: {err}");
    }

    // -- argv ------------------------------------------------------------

    #[cfg(unix)]
    fn argv_of(prompt: &str, model: Option<&str>) -> (Vec<String>, String, TempDir) {
        let tmp = TempDir::new().unwrap();
        let argv = tmp.path().join("argv");
        let pwd = tmp.path().join("pwd");
        let bin = stub(
            tmp.path(),
            "claude",
            &format!(
                "printf '%s\\n' \"$@\" > '{}'\nprintf '%s' \"$PWD\" > '{}'\necho '{OK_ENVELOPE}'",
                argv.display(),
                pwd.display(),
            ),
        );
        think_with(&bin, prompt, model, short()).unwrap();
        let recorded = std::fs::read_to_string(&argv).unwrap();
        // `printf '%s\n'` puts a newline after every argument, so the split
        // leaves one empty string at the end.
        let mut args: Vec<String> = recorded.split('\n').map(str::to_string).collect();
        args.pop();
        (args, std::fs::read_to_string(&pwd).unwrap(), tmp)
    }

    #[cfg(unix)]
    #[test]
    fn the_prompt_is_one_argument_after_a_double_dash() {
        let (args, _, _tmp) = argv_of("fix the failing auth test", None);
        assert_eq!(
            args,
            vec![
                "-p",
                "--output-format",
                "json",
                "--",
                "fix the failing auth test"
            ]
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_model_rides_in_front_of_the_prompt() {
        let (args, _, _tmp) = argv_of("hello", Some("claude-haiku-4-5-20251001"));
        assert_eq!(
            args,
            vec![
                "-p",
                "--output-format",
                "json",
                "--model",
                "claude-haiku-4-5-20251001",
                "--",
                "hello"
            ]
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_blank_model_is_left_off_rather_than_passed_empty() {
        let (args, _, _tmp) = argv_of("hello", Some("   "));
        assert!(!args.contains(&"--model".to_string()), "got: {args:?}");
    }

    /// The whole security argument for this module, asserted by trying it: a
    /// prompt shaped like shell reaches the child as ONE argument, with its
    /// quotes, newlines, substitutions and leading dashes intact and nothing
    /// having run.
    #[cfg(unix)]
    #[test]
    fn a_prompt_shaped_like_shell_arrives_as_text() {
        let tmp = TempDir::new().unwrap();
        let argv = tmp.path().join("argv");
        let canary = tmp.path().join("pwned");
        let bin = stub(
            tmp.path(),
            "claude",
            &format!(
                "printf '%s\\n' \"$@\" > '{}'\necho '{OK_ENVELOPE}'",
                argv.display()
            ),
        );

        let nasty = format!(
            "-- \"quoted\" 'single' $(touch {}) `touch {}`\nsecond line; rm -rf /",
            canary.display(),
            canary.display()
        );
        think_with(&bin, &nasty, None, short()).unwrap();

        let recorded = std::fs::read_to_string(&argv).unwrap();
        assert!(
            recorded.contains(&nasty),
            "the prompt did not arrive intact: {recorded}"
        );
        assert!(!canary.exists(), "a substitution in the prompt executed");
    }

    #[cfg(unix)]
    #[test]
    fn thinking_happens_outside_any_project() {
        let (_, pwd, _tmp) = argv_of("hello", None);
        let ran_in = std::fs::canonicalize(pwd).unwrap();
        let temp = std::fs::canonicalize(std::env::temp_dir()).unwrap();
        assert_eq!(ran_in, temp);
    }

    // -- speaking --------------------------------------------------------

    /// There is exactly ONE voice per process, on purpose (a second reply talks
    /// over the first), and `cargo test` runs these in parallel inside one.
    /// Without this, two speaking tests are two replies: each `speak_with` stops
    /// the other's child mid-sentence, and both then correctly report that being
    /// replaced is not a failure — which is the module working and the
    /// assertions failing. Every test that SPEAKS takes this; the ones that only
    /// sanitize or parse do not need it.
    #[cfg(unix)]
    static ONE_VOICE: Mutex<()> = Mutex::new(());

    #[test]
    fn spoken_text_is_capped_and_stripped_of_control_bytes() {
        let spoken = sanitize_spoken("all\u{7} good\nnow\u{0}");
        assert_eq!(spoken, "all good now");

        let long = "a".repeat(MAX_SPOKEN_BYTES * 2);
        assert_eq!(sanitize_spoken(&long).len(), MAX_SPOKEN_BYTES);
    }

    /// What `say` was actually asked for. The stub records its whole argv, so
    /// every assertion below is about the array `execve` gets — there is no
    /// shell anywhere in this path and these are what would notice if one
    /// appeared.
    #[cfg(unix)]
    fn say_argv(text: &str, voice: Option<&str>, rate: Option<u16>) -> String {
        let tmp = TempDir::new().unwrap();
        let argv = tmp.path().join("argv");
        let bin = stub(
            tmp.path(),
            "say",
            &format!("printf '%s\\n' \"$@\" > '{}'", argv.display()),
        );
        speak_with(&bin, text, voice, rate).unwrap();
        std::fs::read_to_string(&argv).unwrap()
    }

    #[cfg(unix)]
    #[test]
    fn speaking_passes_the_voice_and_the_text_as_argv() {
        let _one_voice = ONE_VOICE.lock();
        let recorded = say_argv("-all done", Some("Samantha"), None);
        assert_eq!(recorded, "-v\nSamantha\n--\n-all done\n");
    }

    /// No rate is no flag — not `-r 175`. The user who never touched the
    /// slider gets whatever `say` does on its own, which is the one rate this
    /// app can be sure sounds like their machine.
    #[cfg(unix)]
    #[test]
    fn no_rate_asked_for_is_no_rate_flag() {
        let _one_voice = ONE_VOICE.lock();
        let recorded = say_argv("all done", None, None);
        assert_eq!(recorded, "--\nall done\n");
    }

    #[cfg(unix)]
    #[test]
    fn a_rate_rides_as_its_own_argv_pair_in_front_of_the_text() {
        let _one_voice = ONE_VOICE.lock();

        let recorded = say_argv("all done", None, Some(200));
        assert_eq!(recorded, "-r\n200\n--\nall done\n");

        // …and beside a voice, both before the `--`.
        let recorded = say_argv("all done", Some("Samantha"), Some(140));
        assert_eq!(recorded, "-v\nSamantha\n-r\n140\n--\nall done\n");
    }

    /// The UI clamps, and that is not a reason to trust what arrives: a
    /// hand-edited `settings.dat` reaches this command with whatever is in it,
    /// and 6 wpm or 60000 wpm is a reply nobody can hear.
    #[cfg(unix)]
    #[test]
    fn a_nonsense_rate_is_clamped_here_rather_than_trusted() {
        let _one_voice = ONE_VOICE.lock();

        let recorded = say_argv("all done", None, Some(1));
        assert_eq!(recorded, format!("-r\n{SPEECH_RATE_MIN}\n--\nall done\n"));

        let recorded = say_argv("all done", None, Some(u16::MAX));
        assert_eq!(recorded, format!("-r\n{SPEECH_RATE_MAX}\n--\nall done\n"));

        // A rate already inside the band is passed through untouched.
        let recorded = say_argv("all done", None, Some(SPEECH_RATE_MAX));
        assert_eq!(recorded, format!("-r\n{SPEECH_RATE_MAX}\n--\nall done\n"));
    }

    #[cfg(unix)]
    #[test]
    fn a_new_reply_kills_the_one_that_was_speaking() {
        let _one_voice = ONE_VOICE.lock();
        let tmp = TempDir::new().unwrap();
        let slow = stub(tmp.path(), "slow-say", "sleep 30");
        let quick = stub(tmp.path(), "say", "exit 0");

        let started = Instant::now();
        let handle = std::thread::spawn({
            let slow = slow.clone();
            move || speak_with(&slow, "the long one", None, None)
        });
        // Let the first child actually start before replacing it.
        std::thread::sleep(Duration::from_millis(200));

        speak_with(&quick, "the new one", None, None).unwrap();
        // The replaced call comes back — killed, and reporting no failure,
        // because being replaced is not one.
        assert!(handle.join().unwrap().is_ok());
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "the replaced speech was not killed"
        );
        stop_speaking();
    }

    /// Two replies started AT ONCE — which is one press of the Settings Test
    /// button while a reply is reading, and the reason stopping, starting and
    /// registering are one act under one lock.
    ///
    /// Without it both callers found an empty slot, both started a `say`, and
    /// whichever registered second orphaned a child that was still talking:
    /// two voices at once, and a Stop that could only reach one of them. The
    /// survivor is what this asserts on — the marker is written by a shell that
    /// lived through its own sleep, and no shell should.
    ///
    /// Five rounds because it is a race: one pass through the window is one
    /// sample, and the barrier is there to make every pass a real attempt.
    #[cfg(unix)]
    #[test]
    fn two_replies_at_once_leave_one_voice_that_stop_can_reach() {
        let _one_voice = ONE_VOICE.lock();
        let tmp = TempDir::new().unwrap();
        let survived = tmp.path().join("survived");
        let bin = stub(
            tmp.path(),
            "say",
            &format!("sleep 1\nprintf 'x' >> '{}'", survived.display()),
        );

        for round in 0..5 {
            let gate = Arc::new(std::sync::Barrier::new(2));
            let voices: Vec<_> = (0..2)
                .map(|i| {
                    let bin = bin.clone();
                    let gate = gate.clone();
                    std::thread::spawn(move || {
                        gate.wait();
                        speak_with(&bin, &format!("reply {i}"), None, None)
                    })
                })
                .collect();
            // Long enough for both to have spawned, short enough to be inside
            // the stub's own second.
            std::thread::sleep(Duration::from_millis(150));
            stop_speaking();
            for voice in voices {
                // Being stopped is not a failure, whichever of the two it was.
                assert!(voice.join().unwrap().is_ok(), "round {round}");
            }
        }

        // Long enough for any survivor to finish its second and say so.
        std::thread::sleep(Duration::from_millis(1400));
        assert!(
            !survived.exists(),
            "a voice went on speaking through Stop — the slot lost track of a child"
        );
    }

    /// Stop has to end the CALL, not only the sound.
    ///
    /// `say` is killed, but anything it started still holds the stderr pipe it
    /// inherited — so a join on that reader sits there for as long as the
    /// speech would have lasted. The `roc_speak` promise stayed pending for all
    /// of it, with a blocking worker parked behind it, while the orb and the
    /// button had already moved on. Exactly the trap `wait_capped` documents,
    /// re-introduced forty lines below it.
    #[cfg(unix)]
    #[test]
    fn stopping_ends_the_call_even_when_something_still_holds_the_pipe() {
        let _one_voice = ONE_VOICE.lock();
        let tmp = TempDir::new().unwrap();
        // The `sleep` is a grandchild, and it inherits stderr: killing the
        // shell leaves that pipe open with nobody left to write to it.
        let bin = stub(tmp.path(), "say", "sleep 5");

        let started = Instant::now();
        let speaking = std::thread::spawn({
            let bin = bin.clone();
            move || speak_with(&bin, "a long reply", None, None)
        });
        std::thread::sleep(Duration::from_millis(200));
        stop_speaking();

        // Being stopped is not a failure, and it is not a wait either.
        assert!(speaking.join().unwrap().is_ok());
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "the call outlived the Stop by {:?}",
            started.elapsed()
        );
    }

    #[cfg(unix)]
    #[test]
    fn stopping_is_safe_when_nothing_is_speaking() {
        let _one_voice = ONE_VOICE.lock();
        stop_speaking();
        stop_speaking();
    }

    #[cfg(unix)]
    #[test]
    fn a_reply_that_sanitizes_to_nothing_says_nothing() {
        let _one_voice = ONE_VOICE.lock();
        let tmp = TempDir::new().unwrap();
        let argv = tmp.path().join("argv");
        let bin = stub(
            tmp.path(),
            "say",
            &format!("printf 'ran\\n' > '{}'", argv.display()),
        );

        speak_with(&bin, "\u{7}\u{0}\n", None, None).unwrap();

        assert!(!argv.exists(), "say was run for an empty reply");
    }

    #[cfg(unix)]
    #[test]
    fn a_say_that_fails_says_why() {
        let _one_voice = ONE_VOICE.lock();
        let tmp = TempDir::new().unwrap();
        let bin = stub(
            tmp.path(),
            "say",
            "echo 'Voice not found: Nobody' >&2\nexit 1",
        );

        let err = speak_with(&bin, "hello", Some("Nobody"), None).unwrap_err();

        assert!(err.contains("Voice not found"), "got: {err}");
    }

    /// Off macOS there is nothing to run, and the UI must not have to know.
    #[cfg(not(target_os = "macos"))]
    #[test]
    fn speaking_is_a_no_op_where_there_is_no_say() {
        assert!(speak_blocking("hello", None, None).is_ok());
        assert!(list_voices_blocking().is_empty());
    }

    // -- voices ----------------------------------------------------------

    #[test]
    fn voice_names_survive_spaces_and_brackets() {
        let listing = "\
Albert              en_US    # Hello! My name is Albert.
Bad News            en_US    # Hello! My name is Bad News.
Eddy (English (UK)) en_GB    # Hello! My name is Eddy.
Eddy (English (US)) en_US    # Hello! My name is Eddy.
";
        assert_eq!(
            parse_voice_names(listing),
            vec![
                "Albert",
                "Bad News",
                "Eddy (English (UK))",
                "Eddy (English (US))"
            ]
        );
    }

    #[test]
    fn a_repeated_name_is_offered_once() {
        let listing = "Alice  it_IT  # ciao\nAlice  it_IT  # ciao\n";
        assert_eq!(parse_voice_names(listing), vec!["Alice"]);
    }
}
