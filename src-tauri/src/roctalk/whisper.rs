//! Whisper.cpp inference + first-launch model download for RocTalk.
//!
//! The model files live in the Tauri app data dir, ONE PER SIZE
//! (`ggml-tiny.en.bin`, `ggml-base.en.bin`, `ggml-small.en.bin`). On first run
//! the chosen one is missing — `download_model` streams it from Hugging Face,
//! emitting progress events so the pill can render a download ring. Once
//! present, `Engine::load` mmaps it and the context is kept for as long as that
//! size stays selected.
//!
//! Keying the cache by FILE is what makes switching sizes safe: downloading
//! `small.en` writes `ggml-small.en.bin.partial` and renames it into place,
//! never touching the `base.en` the user is dictating with right now. Switching
//! back needs no download at all.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use futures_util::StreamExt;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::AsyncWriteExt;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

use super::events::{RocTalkDownloadProgressEvent, EVENT_DOWNLOAD_PROGRESS};

/// Where the english-only ggml models are published. Public, no auth required.
const MODEL_BASE_URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/";
/// Subdirectory inside the app data dir where we cache downloaded models.
pub const MODEL_SUBDIR: &str = "roctalk";

/// The sizes the picker offers, smallest first. English-only throughout —
/// `transcribe` pins the language to `en`, so a multilingual model would cost
/// download size and inference time for nothing.
pub const MODEL_SIZES: [&str; 3] = ["tiny.en", "base.en", "small.en"];

/// The file a size is cached as.
///
/// An allowlist rather than `format!("ggml-{size}.bin")`: this string arrives
/// from the renderer, and it is about to become a path AND a URL. A size of
/// `../../../etc/passwd` has to fail here, not resolve.
pub fn model_file(size: &str) -> Result<String, String> {
    if !MODEL_SIZES.contains(&size) {
        return Err(format!(
            "unknown whisper model size {size:?} — expected one of {}",
            MODEL_SIZES.join(", ")
        ));
    }
    Ok(format!("ggml-{size}.bin"))
}

/// Where a size is downloaded from. Same allowlist, same reason.
pub fn model_url(size: &str) -> Result<String, String> {
    Ok(format!("{MODEL_BASE_URL}{}", model_file(size)?))
}

pub struct Engine {
    ctx: WhisperContext,
}

impl Engine {
    pub fn load(model_path: &Path) -> Result<Arc<Self>, String> {
        let path_str = model_path
            .to_str()
            .ok_or_else(|| "model path is not valid UTF-8".to_string())?;
        let ctx = WhisperContext::new_with_params(path_str, WhisperContextParameters::default())
            .map_err(|e| format!("WhisperContext::new: {e}"))?;
        Ok(Arc::new(Self { ctx }))
    }

    /// Transcribe a contiguous block of mono 16 kHz f32 PCM. Blocks the calling
    /// thread; callers should run this inside `tokio::task::spawn_blocking`.
    pub fn transcribe(&self, samples: &[f32]) -> Result<String, String> {
        if samples.is_empty() {
            return Ok(String::new());
        }
        let mut state = self
            .ctx
            .create_state()
            .map_err(|e| format!("create_state: {e}"))?;

        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_language(Some("en"));
        params.set_translate(false);
        params.set_no_context(true);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        params.set_print_special(false);
        let n_threads = num_cpus::get_physical().clamp(1, 8) as i32;
        params.set_n_threads(n_threads);

        state
            .full(params, samples)
            .map_err(|e| format!("whisper full: {e}"))?;

        // whisper-rs 0.16 returns i32 directly for n_segments and exposes
        // segment text via the per-segment accessor.
        let n_segments = state.full_n_segments();
        let mut out = String::new();
        for i in 0..n_segments {
            let segment = state
                .get_segment(i)
                .ok_or_else(|| format!("get_segment({i}) returned None"))?;
            let text = segment
                .to_str()
                .map_err(|e| format!("segment.to_str({i}): {e}"))?;
            out.push_str(text);
        }
        Ok(out)
    }
}

/// Resolve `<app_data_dir>/roctalk/ggml-<size>.bin`, creating the parent dir on
/// demand. Returns the path even if the file does not exist yet.
pub fn model_path(app: &AppHandle, size: &str) -> Result<PathBuf, String> {
    let file = model_file(size)?;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?
        .join(MODEL_SUBDIR);
    std::fs::create_dir_all(&dir).map_err(|e| format!("create_dir_all: {e}"))?;
    Ok(dir.join(file))
}

/// Stream `size`'s model from Hugging Face into the app data dir. Writes to a
/// `.partial` sidecar and atomic-renames on success, so a crashed download
/// never leaves a half-baked model file in place — and so a download of one
/// size cannot damage another that is already there and in use.
pub async fn download_model(app: AppHandle, size: &str) -> Result<(), String> {
    let url = model_url(size)?;
    let dest = model_path(&app, size)?;
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("create model dir: {e}"))?;
    }

    let partial = dest.with_extension("partial");
    // If a previous run left a partial behind, start fresh — Hugging Face supports
    // range requests but the integrity story isn't worth it for a one-shot.
    let _ = tokio::fs::remove_file(&partial).await;

    let response = reqwest::get(url)
        .await
        .map_err(|e| format!("download GET: {e}"))?;

    if !response.status().is_success() {
        return Err(format!("download HTTP {}", response.status()));
    }

    let total = response.content_length().unwrap_or(0);
    let mut file = tokio::fs::File::create(&partial)
        .await
        .map_err(|e| format!("create partial: {e}"))?;

    let mut received: u64 = 0;
    let mut last_emit: u64 = 0;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| format!("download chunk: {e}"))?;
        file.write_all(&bytes)
            .await
            .map_err(|e| format!("write chunk: {e}"))?;
        received += bytes.len() as u64;
        // Throttle emissions to ~64 KiB boundaries so we don't flood the bridge.
        if received - last_emit >= 64 * 1024 {
            last_emit = received;
            let _ = app.emit(
                EVENT_DOWNLOAD_PROGRESS,
                &RocTalkDownloadProgressEvent {
                    model_size: size.to_string(),
                    received,
                    total,
                },
            );
        }
    }
    file.flush()
        .await
        .map_err(|e| format!("flush partial: {e}"))?;
    drop(file);

    tokio::fs::rename(&partial, &dest)
        .await
        .map_err(|e| format!("rename partial: {e}"))?;

    let _ = app.emit(
        EVENT_DOWNLOAD_PROGRESS,
        &RocTalkDownloadProgressEvent {
            model_size: size.to_string(),
            received: total.max(received),
            total,
        },
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_offered_size_names_a_file_and_a_url() {
        for size in MODEL_SIZES {
            let file = model_file(size).expect("an offered size must resolve");
            assert!(file.starts_with("ggml-") && file.ends_with(".bin"));
            assert!(model_url(size).unwrap().ends_with(&file));
        }
        // …and the three files are three files, not one shared by three names.
        let mut files: Vec<String> = MODEL_SIZES
            .iter()
            .map(|s| model_file(s).unwrap())
            .collect();
        files.sort();
        files.dedup();
        assert_eq!(files.len(), MODEL_SIZES.len());
    }

    #[test]
    fn a_size_the_renderer_made_up_cannot_become_a_path() {
        // The size crosses IPC as a string and is interpolated into a filename
        // and a URL. Anything not on the list is refused before either.
        for bad in [
            "",
            "base",
            "../../../etc/passwd",
            "base.en/../../secrets",
            "large-v3",
        ] {
            assert!(
                model_file(bad).is_err(),
                "{bad:?} must not resolve to a file"
            );
            assert!(model_url(bad).is_err(), "{bad:?} must not resolve to a URL");
        }
    }
}
