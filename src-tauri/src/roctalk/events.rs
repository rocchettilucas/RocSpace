//! Event names + payloads emitted from the RocTalk runtime to the renderer.
//! Keep in sync with `src/lib/bindings.ts` (EVENT_ROCTALK_* constants).

use serde::Serialize;

// The push-to-talk pair, emitted by whichever source owns PTT on this platform:
// the WH_KEYBOARD_LL hook (`hotkey.rs`) on Windows, the global-shortcut
// accelerator (`ptt.rs`) everywhere else. The renderer listens for these two
// and does not care which one spoke — see `ptt.rs` for why they are mutually
// exclusive.
pub const EVENT_PTT_DOWN: &str = "roctalk://ptt-down";
pub const EVENT_PTT_UP: &str = "roctalk://ptt-up";
pub const EVENT_AMPLITUDE: &str = "roctalk://amplitude";
pub const EVENT_DOWNLOAD_PROGRESS: &str = "roctalk://download-progress";

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RocTalkAmplitudeEvent {
    /// Normalized 0..1.
    pub rms: f32,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RocTalkDownloadProgressEvent {
    /// Which model this progress is about (`"base.en"`, …). Carried because
    /// sizes are downloaded independently: a listener showing `small.en`'s ring
    /// must not fill it with the bytes of a `tiny.en` fetch started earlier.
    pub model_size: String,
    pub received: u64,
    /// May be 0 if the server didn't return a Content-Length header.
    pub total: u64,
}
