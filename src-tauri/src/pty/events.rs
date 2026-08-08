//! Event names + payloads emitted from the PTY runtime to the renderer.
//! Keep in sync with `src/lib/bindings.ts` (EVENT_TERMINAL_* constants) and
//! `src/lib/ptyBridge.ts`, which listens for both.

use serde::Serialize;
use specta::Type;

use crate::models::{OutputStream, TerminalStatus};

pub const EVENT_OUTPUT: &str = "terminal://output";
pub const EVENT_STATUS: &str = "terminal://status";

/// Event payload emitted to the renderer for each chunk of PTY output.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutputEvent {
    pub terminal_id: String,
    /// Stable per-chunk id, used by the renderer for dedupe/keying.
    pub line_id: String,
    pub ts: i64,
    pub stream: OutputStream,
    pub text: String,
}

/// Event payload for status transitions.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TerminalStatusEvent {
    pub terminal_id: String,
    pub status: TerminalStatus,
}
