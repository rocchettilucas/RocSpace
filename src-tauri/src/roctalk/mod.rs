//! RocTalk — local push-to-talk dictation. Owns the audio recorder, the
//! Whisper engine, the global hotkey hook, and the Tauri commands that wire
//! all three to the renderer.

mod audio;
mod events;
mod ptt;
mod whisper;

#[cfg(target_os = "windows")]
mod hotkey;

#[cfg(not(target_os = "windows"))]
mod hotkey {
    use tauri::AppHandle;
    pub fn install(_: AppHandle) -> Result<(), String> {
        Ok(())
    }
    pub fn set_enabled(_: bool) {}
}

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use parking_lot::Mutex;
use tauri::{AppHandle, State};

use whisper::Engine;

/// Managed state attached to the Tauri builder.
///
/// Everything here is keyed by MODEL SIZE where it has to be. The size itself
/// is not stored: it lives in `settings.dat` with the rest of the voice
/// preferences and rides in on the call that needs it, so there is one source
/// of truth for what the user picked.
#[derive(Default)]
pub struct RocTalkState {
    audio: Mutex<Option<audio::Recorder>>,
    /// The loaded engine and the size it was loaded for. Lazy: filled the first
    /// time we transcribe. Switching size drops the old context — two whisper
    /// models resident at once is up to 600 MB for no benefit, since only the
    /// selected one is ever asked to transcribe.
    whisper: Mutex<Option<(String, Arc<Engine>)>>,
    /// "missing" | "downloading" | "ready", per size. A size absent from the
    /// map has not been looked at yet and is resolved from disk on demand.
    model_status: Mutex<HashMap<String, &'static str>>,
    /// Bumped by every stop. Opening a microphone can take seconds (see
    /// `audio::DEVICE_OPEN_TIMEOUT`), and a push-to-talk tap can be over well
    /// before that: a recorder that arrives after its own stop has already run
    /// would hold the microphone open with nobody left to close it. Comparing
    /// this across the wait is how such a start knows to throw itself away.
    stop_epoch: AtomicU64,
}

/// Install the OS-level hotkey hook. Call once from the Tauri setup closure.
pub fn install_hotkey(app: AppHandle) -> Result<(), String> {
    // Log the cpal device inventory once at startup so users can see what
    // their host exposes BEFORE attempting to record. Helps diagnose missing
    // or wrong-default-device situations.
    audio::log_input_devices();
    hotkey::install(app)
}

/// "missing" | "downloading" | "ready" for one size — kept as &'static str so
/// the command can serialize it without a specta-derive dance for a 3-variant
/// enum.
fn model_status_str(app: &AppHandle, state: &RocTalkState, size: &str) -> &'static str {
    {
        let statuses = state.model_status.lock();
        if let Some(cur) = statuses.get(size) {
            if *cur == "downloading" || *cur == "ready" {
                return cur;
            }
        }
    }
    let exists = whisper::model_path(app, size)
        .map(|p| p.exists())
        .unwrap_or(false);
    let resolved = if exists { "ready" } else { "missing" };
    state
        .model_status
        .lock()
        .insert(size.to_string(), resolved);
    resolved
}

/// Begin recording. `input_device` is a name from `roctalk_list_input_devices`;
/// `None` (and the empty string the renderer stores for "system default") means
/// whatever the OS calls the default input.
///
/// Async, and the work is done on a blocking task: waking a microphone is the
/// OS's time to spend, and a synchronous command would spend it on the MAIN
/// thread — a frozen window rather than a slow start.
#[tauri::command]
#[specta::specta]
pub async fn roctalk_start_recording(
    state: State<'_, RocTalkState>,
    app: AppHandle,
    input_device: Option<String>,
) -> Result<(), String> {
    // Idempotent — take any stale recorder rather than erroring out, and stop
    // it on the blocking task with the start it is making way for.
    let stale = state.audio.lock().take();
    let epoch = state.stop_epoch.load(Ordering::SeqCst);
    let device = input_device.filter(|d| !d.is_empty());

    let recorder = tokio::task::spawn_blocking(move || {
        if let Some(old) = stale {
            let _ = old.stop();
        }
        audio::Recorder::start(app, device)
    })
    .await
    .map_err(|e| format!("start recording join: {e}"))??;

    if state.stop_epoch.load(Ordering::SeqCst) != epoch {
        // The hold ended while the microphone was still waking up. Dropping the
        // recorder closes it; keeping it would leave the input live for ever.
        eprintln!("[roctalk] recording was released before the microphone answered");
        drop(recorder);
        return Ok(());
    }
    *state.audio.lock() = Some(recorder);
    Ok(())
}

/// Stop recording and transcribe with `model_size`'s model.
#[tauri::command]
#[specta::specta]
pub async fn roctalk_stop_recording_and_transcribe(
    state: State<'_, RocTalkState>,
    app: AppHandle,
    model_size: String,
) -> Result<String, String> {
    // Before the take, so a start still waiting on a slow microphone sees it.
    state.stop_epoch.fetch_add(1, Ordering::SeqCst);
    let recorder = state.audio.lock().take();
    let Some(recorder) = recorder else {
        return Err("not recording".into());
    };
    let samples = recorder.stop();

    if samples.is_empty() {
        return Ok(String::new());
    }

    // Lazy-load the engine on first transcription, and reload it when the user
    // has switched size since. Cheap to clone the Arc afterwards.
    let engine = {
        let mut slot = state.whisper.lock();
        let loaded = slot.as_ref().is_some_and(|(size, _)| *size == model_size);
        if !loaded {
            let path = whisper::model_path(&app, &model_size)?;
            if !path.exists() {
                return Err("whisper model not downloaded yet".into());
            }
            *slot = Some((model_size.clone(), Engine::load(&path)?));
        }
        slot.as_ref().expect("just inserted").1.clone()
    };

    // Whisper.full() blocks for hundreds of milliseconds — keep it off the
    // tokio runtime threads.
    tokio::task::spawn_blocking(move || engine.transcribe(&samples))
        .await
        .map_err(|e| format!("transcribe join: {e}"))?
}

#[tauri::command]
#[specta::specta]
pub fn roctalk_set_enabled(_state: State<'_, RocTalkState>, enabled: bool) -> Result<(), String> {
    hotkey::set_enabled(enabled);
    Ok(())
}

// Global push-to-talk ----------------------------------------------------
//
// Thin wrappers: `ptt` owns the semantics (and the reason Windows opts out).
// Re-exported here so the whole RocTalk surface is imported from one module.

/// Bind `accelerator` as the global push-to-talk key, replacing any previous
/// binding. An accelerator the OS refuses — or one that is not a shortcut at
/// all — comes back as an error for the picker to show.
#[tauri::command]
#[specta::specta]
pub fn ptt_register(app: AppHandle, accelerator: String) -> Result<(), String> {
    ptt::register(&app, &accelerator)
}

/// Release the global push-to-talk key. Succeeds when nothing is bound.
#[tauri::command]
#[specta::specta]
pub fn ptt_unregister(app: AppHandle) -> Result<(), String> {
    ptt::unregister(&app)
}

/// The accelerator bound right now, or `None`. Always `None` on Windows, where
/// the low-level keyboard hook owns push-to-talk instead.
#[tauri::command]
#[specta::specta]
pub fn ptt_current() -> Option<String> {
    ptt::current()
}

/// Every input device cpal can see. The renderer stores "" for "system
/// default", so that is never in this list.
#[tauri::command]
#[specta::specta]
pub async fn roctalk_list_input_devices() -> Result<Vec<String>, String> {
    // Enumeration talks to CoreAudio / WASAPI and can block for as long as a
    // sleeping Bluetooth headset takes to answer. A synchronous command would
    // do that on the MAIN thread — a frozen window, not a slow dropdown.
    tokio::task::spawn_blocking(audio::input_device_names)
        .await
        .map_err(|e| format!("device enumeration join: {e}"))
}

/// Whether `model_size`'s model is on disk. Refuses a size that is not one of
/// the offered ones — see `whisper::model_file`.
#[tauri::command]
#[specta::specta]
pub fn roctalk_get_model_status(
    state: State<'_, RocTalkState>,
    app: AppHandle,
    model_size: String,
) -> Result<String, String> {
    // Validate before answering: "missing" for a size that does not exist would
    // send the UI on to offer a download that can only fail.
    whisper::model_file(&model_size)?;
    Ok(model_status_str(&app, &state, &model_size).to_string())
}

/// Fetch `model_size`'s model. Each size is its own file and its own `.partial`
/// sidecar, so fetching one never disturbs another that is on disk and in use.
#[tauri::command]
#[specta::specta]
pub async fn roctalk_download_model(
    state: State<'_, RocTalkState>,
    app: AppHandle,
    model_size: String,
) -> Result<(), String> {
    whisper::model_file(&model_size)?;
    {
        let mut statuses = state.model_status.lock();
        // Per size: downloading `small.en` while `base.en` is still coming down
        // is two independent files and two independent progress streams.
        if statuses.get(model_size.as_str()) == Some(&"downloading") {
            return Err("download already in progress".into());
        }
        statuses.insert(model_size.clone(), "downloading");
    }

    let result = whisper::download_model(app.clone(), &model_size).await;

    state
        .model_status
        .lock()
        .insert(model_size, if result.is_ok() { "ready" } else { "missing" });
    result
}
