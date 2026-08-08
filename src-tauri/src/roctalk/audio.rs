//! Microphone capture for RocTalk.
//!
//! Opens the system default input device with cpal, downmixes to mono, and
//! linearly resamples to 16 kHz f32 — Whisper's required input format. Samples
//! accumulate in an Arc<Mutex<Vec<f32>>>; a companion thread emits an RMS
//! amplitude event at ~30 Hz so the pill's waveform animates with the user's voice.
//!
//! cpal's Stream is !Send on Windows (WASAPI requires same-thread control), so
//! we own the stream from a dedicated OS thread and shut it down via a oneshot
//! channel — same threading model as `pty/runtime.rs`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SampleFormat, StreamConfig};
use parking_lot::Mutex;
use tauri::{AppHandle, Emitter};

use super::events::{RocTalkAmplitudeEvent, EVENT_AMPLITUDE};

const TARGET_SAMPLE_RATE: f32 = 16_000.0;
/// How long the DEVICE may take to answer.
///
/// Resolving the input is CoreAudio / WASAPI work — `input_devices()` opens
/// every endpoint to read its name, and a Bluetooth headset that is asleep in
/// its case takes as long as it takes to wake up. It used to share one 1 s
/// budget with the stream wiring, so a mic that answered on the second second
/// failed the whole recording with a console line.
const DEVICE_OPEN_TIMEOUT: Duration = Duration::from_secs(10);
/// How long the STREAM may take once the device has answered. Building and
/// starting it is local work: a second is generous, and a hang here is a bug
/// rather than a sleeping peripheral.
const STREAM_START_TIMEOUT: Duration = Duration::from_secs(1);
/// Hard cap so a stuck key can't OOM us. ~16 MB at f32 mono 16 kHz.
const MAX_SAMPLES: usize = (TARGET_SAMPLE_RATE as usize) * 60;
const RMS_WINDOW_SAMPLES: usize = 1024;
const AMPLITUDE_EMIT_INTERVAL: Duration = Duration::from_millis(33);

/// Every input device cpal can see, in host order.
///
/// Names are the selection key — `Recorder::start` matches on them — so an
/// unnamed device is dropped (it could never be picked back out) and a repeated
/// name is listed once (two rows that do the same thing are one row).
///
/// Blocks: enumeration talks to CoreAudio / WASAPI, which a sleeping Bluetooth
/// headset can keep waiting. Callers on the main thread must go through
/// `spawn_blocking`.
pub fn input_device_names() -> Vec<String> {
    let host = cpal::default_host();
    let devices = match host.input_devices() {
        Ok(d) => d,
        Err(e) => {
            eprintln!("[roctalk-audio] input_devices error: {e}");
            return Vec::new();
        }
    };
    let mut names: Vec<String> = Vec::new();
    for device in devices {
        let Ok(name) = device.name() else { continue };
        if name.is_empty() || names.contains(&name) {
            continue;
        }
        names.push(name);
    }
    names
}

/// Log every input device cpal can see — call once at app startup so device
/// names appear in the dev console BEFORE the first recording attempt.
pub fn log_input_devices() {
    let host = cpal::default_host();
    eprintln!("[roctalk-audio] host = {:?}", host.id());
    match host.default_input_device() {
        Some(d) => eprintln!(
            "[roctalk-audio] default input device = {:?}",
            d.name().ok()
        ),
        None => eprintln!("[roctalk-audio] NO default input device"),
    }
    match host.input_devices() {
        Ok(devices) => {
            for (i, d) in devices.enumerate() {
                let name = d.name().unwrap_or_else(|_| "<unnamed>".to_string());
                let cfg = d
                    .default_input_config()
                    .map(|c| {
                        format!(
                            "{:?}@{}Hz x{}ch",
                            c.sample_format(),
                            c.sample_rate().0,
                            c.channels()
                        )
                    })
                    .unwrap_or_else(|e| format!("config err: {e}"));
                eprintln!("[roctalk-audio]   #{i} \"{name}\" -> {cfg}");
            }
        }
        Err(e) => eprintln!("[roctalk-audio] input_devices error: {e}"),
    }
}

pub struct Recorder {
    samples: Arc<Mutex<Vec<f32>>>,
    /// Total raw input frames the cpal callback has been handed since recording
    /// started. Lets us distinguish "callback never fired" from "callback fired
    /// but received silence".
    callback_frames: Arc<std::sync::atomic::AtomicUsize>,
    stopping: Arc<AtomicBool>,
    stop_tx: Option<mpsc::Sender<()>>,
    audio_thread: Option<JoinHandle<()>>,
    emitter_thread: Option<JoinHandle<()>>,
}

impl Recorder {
    /// Open `preferred_device` (a name from `input_device_names`) or, when it is
    /// `None`, whatever the system calls the default input.
    ///
    /// A name that no longer matches anything falls back to the default rather
    /// than failing: the stored choice outlives the USB mic being unplugged,
    /// and refusing to record because a headset is in its case would be a worse
    /// answer than recording from the built-in one.
    ///
    /// BLOCKS for as long as `DEVICE_OPEN_TIMEOUT` — call it from a blocking
    /// task, never from the main thread.
    pub fn start(app: AppHandle, preferred_device: Option<String>) -> Result<Self, String> {
        use std::sync::atomic::AtomicUsize;
        let samples: Arc<Mutex<Vec<f32>>> = Arc::new(Mutex::new(Vec::with_capacity(64 * 1024)));
        let callback_frames = Arc::new(AtomicUsize::new(0));
        let stopping = Arc::new(AtomicBool::new(false));

        let (ready_tx, ready_rx) = mpsc::channel::<StartSignal>();
        let (stop_tx, stop_rx) = mpsc::channel::<()>();

        let samples_for_audio = samples.clone();
        let callback_frames_for_audio = callback_frames.clone();
        let stopping_for_audio = stopping.clone();

        // Audio thread: creates and owns the cpal stream so its !Send constraints
        // are satisfied. Blocks on stop_rx, then drops the stream and returns.
        let audio_thread = std::thread::Builder::new()
            .name("roctalk-audio".into())
            .spawn(move || {
                let host = cpal::default_host();
                let Some(device) = open_device(&host, preferred_device.as_deref()) else {
                    let _ = ready_tx.send(StartSignal::Failed("no microphone is available".into()));
                    return;
                };
                let device_name = device.name().unwrap_or_else(|_| "<unnamed>".to_string());
                let supported = match device.default_input_config() {
                    Ok(c) => c,
                    Err(e) => {
                        let _ = ready_tx.send(StartSignal::Failed(format!(
                            "{device_name} could not be opened: {e}"
                        )));
                        return;
                    }
                };
                // The device has answered. Everything above this line is the
                // OS's audio subsystem taking its time; everything below is
                // ours, and is held to a much tighter budget.
                let _ = ready_tx.send(StartSignal::DeviceOpen);

                let sample_format = supported.sample_format();
                let channels = supported.channels() as usize;
                let in_rate = supported.sample_rate().0 as f32;
                eprintln!(
                    "[roctalk-audio] device='{device_name}' format={sample_format:?} \
                     in_rate={in_rate} channels={channels}"
                );
                let config: StreamConfig = supported.into();

                let stream_result = build_stream(
                    &device,
                    &config,
                    sample_format,
                    channels,
                    in_rate,
                    samples_for_audio.clone(),
                    callback_frames_for_audio.clone(),
                    stopping_for_audio.clone(),
                );

                let stream = match stream_result {
                    Ok(s) => s,
                    Err(e) => {
                        let _ = ready_tx.send(StartSignal::Failed(e));
                        return;
                    }
                };

                if let Err(e) = stream.play() {
                    let _ = ready_tx.send(StartSignal::Failed(format!(
                        "{device_name} would not start: {e}"
                    )));
                    return;
                }

                let _ = ready_tx.send(StartSignal::Ready(StreamSpec { in_rate, channels }));

                // Park here until the orchestrator signals stop. Dropping `stream`
                // (when this scope ends) closes the WASAPI capture endpoint.
                let _ = stop_rx.recv();
                drop(stream);
            })
            .map_err(|e| format!("spawn audio thread: {e}"))?;

        // Wait for the audio thread to come online or fail — surfacing the
        // error synchronously is much nicer for the renderer than discovering
        // it later via an empty transcript.
        let _spec = await_start(&ready_rx, DEVICE_OPEN_TIMEOUT, STREAM_START_TIMEOUT)?;

        // Emitter thread: reads the tail of the buffer at ~30 Hz, emits RMS as
        // a normalized 0..1 amplitude event for the pill's waveform. Also logs
        // a heartbeat every ~1 s so we can confirm callback liveness from the
        // dev console even when no audio is being received.
        let samples_for_emit = samples.clone();
        let callback_frames_for_emit = callback_frames.clone();
        let stopping_for_emit = stopping.clone();
        let app_for_emit = app.clone();
        let emitter_thread = std::thread::Builder::new()
            .name("roctalk-amplitude".into())
            .spawn(move || {
                use std::sync::atomic::AtomicUsize;
                let mut last_log = std::time::Instant::now();
                let mut last_callback_frames: usize = 0;
                let _phantom: AtomicUsize = AtomicUsize::new(0);
                while !stopping_for_emit.load(Ordering::Relaxed) {
                    let (rms, peak, sample_count) = {
                        let buf = samples_for_emit.lock();
                        if buf.is_empty() {
                            (0.0_f32, 0.0_f32, 0)
                        } else {
                            let start = buf.len().saturating_sub(RMS_WINDOW_SAMPLES);
                            let window = &buf[start..];
                            let sum_sq: f32 = window.iter().map(|s| s * s).sum();
                            let peak = window.iter().fold(0.0f32, |m, s| m.max(s.abs()));
                            (
                                (sum_sq / window.len() as f32).sqrt(),
                                peak,
                                buf.len(),
                            )
                        }
                    };
                    // Perceptual scaling: voice RMS lives in 0.01–0.1 on most
                    // USB mics; a sqrt curve maps quiet speech into the visible
                    // 0.3–0.9 range without pinning loud speech.
                    let normalized = (rms.sqrt() * 2.5).clamp(0.0, 1.0);
                    let _ = app_for_emit.emit(
                        EVENT_AMPLITUDE,
                        &RocTalkAmplitudeEvent { rms: normalized },
                    );

                    if last_log.elapsed() >= Duration::from_secs(1) {
                        let cb_frames =
                            callback_frames_for_emit.load(Ordering::Relaxed);
                        eprintln!(
                            "[roctalk-audio] heartbeat: cpal_frames={} (Δ{}) \
                             samples={} rms={:.5} peak={:.4} normalized={:.3}",
                            cb_frames,
                            cb_frames - last_callback_frames,
                            sample_count,
                            rms,
                            peak,
                            normalized
                        );
                        last_callback_frames = cb_frames;
                        last_log = std::time::Instant::now();
                    }
                    std::thread::sleep(AMPLITUDE_EMIT_INTERVAL);
                }
            })
            .map_err(|e| format!("spawn emitter thread: {e}"))?;

        Ok(Self {
            samples,
            callback_frames,
            stopping,
            stop_tx: Some(stop_tx),
            audio_thread: Some(audio_thread),
            emitter_thread: Some(emitter_thread),
        })
    }

    /// Signal the audio + emitter threads to stop, join them, then return the
    /// captured samples.
    pub fn stop(mut self) -> Vec<f32> {
        self.stopping.store(true, Ordering::Relaxed);
        if let Some(tx) = self.stop_tx.take() {
            let _ = tx.send(());
        }
        if let Some(t) = self.audio_thread.take() {
            let _ = t.join();
        }
        if let Some(t) = self.emitter_thread.take() {
            let _ = t.join();
        }
        let mut buf = self.samples.lock();
        let samples = std::mem::take(&mut *buf);
        let peak = samples.iter().fold(0.0f32, |m, s| m.max(s.abs()));
        let cb_frames = self
            .callback_frames
            .load(std::sync::atomic::Ordering::Relaxed);
        eprintln!(
            "[roctalk-audio] stop: cpal_frames={} resampled_samples={} ({:.2}s) peak={:.4}",
            cb_frames,
            samples.len(),
            samples.len() as f32 / TARGET_SAMPLE_RATE,
            peak
        );
        samples
    }
}

impl Drop for Recorder {
    fn drop(&mut self) {
        self.stopping.store(true, Ordering::Relaxed);
        if let Some(tx) = self.stop_tx.take() {
            let _ = tx.send(());
        }
        if let Some(t) = self.audio_thread.take() {
            let _ = t.join();
        }
        if let Some(t) = self.emitter_thread.take() {
            let _ = t.join();
        }
    }
}

/// Resolve the device to record from: the one named, else the system default.
/// See `Recorder::start` for why a missing name is not an error.
fn open_device(host: &cpal::Host, preferred: Option<&str>) -> Option<cpal::Device> {
    let Some(name) = preferred.filter(|n| !n.is_empty()) else {
        return host.default_input_device();
    };
    let found = host
        .input_devices()
        .ok()
        .and_then(|mut it| it.find(|d| d.name().is_ok_and(|n| n == name)));
    if found.is_none() {
        eprintln!("[roctalk-audio] input device {name:?} is gone — using the system default");
    }
    found.or_else(|| host.default_input_device())
}

/// What the audio thread reports back when its cpal stream is up. The fields
/// are inspected only via `Debug` for diagnostics, hence the allow.
#[derive(Debug)]
#[allow(dead_code)]
struct StreamSpec {
    in_rate: f32,
    channels: usize,
}

/// The audio thread coming up, in the order the caller hears about it.
///
/// Two messages rather than one because the two halves have nothing in common
/// but the thread they run on: resolving the device is the OS's time to spend
/// and needs a patient budget, while building the stream is ours and does not.
#[derive(Debug)]
enum StartSignal {
    /// The input answered and agreed a config. Stream wiring starts now.
    DeviceOpen,
    Ready(StreamSpec),
    Failed(String),
}

/// Block until the audio thread is recording, or until it gives up.
///
/// Split budgets: `device_budget` covers the microphone answering at all,
/// `stream_budget` only the wiring after it has. Errors are phrased for a
/// person — they are shown as a toast.
fn await_start(
    rx: &mpsc::Receiver<StartSignal>,
    device_budget: Duration,
    stream_budget: Duration,
) -> Result<StreamSpec, String> {
    match rx.recv_timeout(device_budget) {
        Ok(StartSignal::DeviceOpen) => {}
        // The thread can't skip the milestone, but a spec is what we were
        // waiting for either way.
        Ok(StartSignal::Ready(spec)) => return Ok(spec),
        Ok(StartSignal::Failed(e)) => return Err(e),
        Err(_) => {
            return Err(format!(
                "the microphone did not answer within {} s — it may be asleep or in use by another application",
                device_budget.as_secs()
            ))
        }
    }
    match rx.recv_timeout(stream_budget) {
        Ok(StartSignal::Ready(spec)) => Ok(spec),
        Ok(StartSignal::Failed(e)) => Err(e),
        Ok(StartSignal::DeviceOpen) => {
            Err("the audio thread reported the same device twice".into())
        }
        Err(_) => Err(format!(
            "the microphone answered but did not start recording within {} s",
            stream_budget.as_secs()
        )),
    }
}

// Every parameter is an independent piece of cpal stream wiring; bundling them
// into a struct would only move the same fan-out one level down.
#[allow(clippy::too_many_arguments)]
fn build_stream(
    device: &cpal::Device,
    config: &StreamConfig,
    sample_format: SampleFormat,
    channels: usize,
    in_rate: f32,
    samples: Arc<Mutex<Vec<f32>>>,
    callback_frames: Arc<std::sync::atomic::AtomicUsize>,
    stopping: Arc<AtomicBool>,
) -> Result<cpal::Stream, String> {
    let err_fn = |e| eprintln!("[roctalk-audio] cpal stream error: {e}");

    // Resample ratio: input rate / 16 kHz. We emit one output sample for every
    // `resample_step` input frames. Cheap linear interpolation; good enough
    // for speech.
    let resample_step = in_rate / TARGET_SAMPLE_RATE;
    let mut last_sample: f32 = 0.0;
    let mut frac: f32 = 0.0;

    macro_rules! make_callback {
        ($t:ty) => {{
            let samples = samples.clone();
            let callback_frames = callback_frames.clone();
            let stopping = stopping.clone();
            move |data: &[$t], _: &_| {
                if stopping.load(Ordering::Relaxed) {
                    return;
                }
                let frame_count = data.len() / channels;
                callback_frames.fetch_add(frame_count, std::sync::atomic::Ordering::Relaxed);
                let mut buf = samples.lock();
                if buf.len() >= MAX_SAMPLES {
                    return;
                }
                for frame in data.chunks_exact(channels) {
                    let sum: f32 = frame.iter().map(|s| to_f32(*s)).sum();
                    let mono = sum / channels as f32;

                    while frac >= 1.0 && buf.len() < MAX_SAMPLES {
                        // Linear interp between previous and current input
                        // frames. `frac - 1.0` is how far past the output point
                        // we already are, so the weight on `mono` is
                        // `1.0 - (frac - 1.0)` and the rest goes to last_sample.
                        let t = 1.0 - (frac - 1.0);
                        let interp = last_sample + (mono - last_sample) * t;
                        buf.push(interp);
                        frac -= 1.0;
                    }
                    frac += 1.0 / resample_step;
                    last_sample = mono;
                }
            }
        }};
    }

    let stream = match sample_format {
        SampleFormat::F32 => device.build_input_stream(config, make_callback!(f32), err_fn, None),
        SampleFormat::I16 => device.build_input_stream(config, make_callback!(i16), err_fn, None),
        SampleFormat::U16 => device.build_input_stream(config, make_callback!(u16), err_fn, None),
        SampleFormat::I32 => device.build_input_stream(config, make_callback!(i32), err_fn, None),
        other => {
            return Err(format!("unsupported sample format: {:?}", other));
        }
    }
    .map_err(|e| format!("build_input_stream: {e}"))?;
    Ok(stream)
}

/// Normalize any cpal sample type into f32 in [-1.0, 1.0]. Each `S` cpal
/// supports declares `f32: FromSample<S>` so we can lean on cpal's own
/// conversion table rather than rolling our own per-format math.
fn to_f32<S>(s: S) -> f32
where
    f32: FromSample<S>,
{
    f32::from_sample(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_device_gets_its_own_budget_and_the_stream_a_tighter_one() {
        // The two used to share one second, so a Bluetooth mic that woke up on
        // the second second failed a recording it was about to be able to do.
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(120));
            let _ = tx.send(StartSignal::DeviceOpen);
            let _ = tx.send(StartSignal::Ready(StreamSpec {
                in_rate: 48_000.0,
                channels: 2,
            }));
        });

        // A device budget long enough for the sleep, and a stream budget that
        // would have expired had it covered the sleep too.
        let spec = await_start(&rx, Duration::from_millis(400), Duration::from_millis(50))
            .expect("a slow device is not a failed recording");
        assert_eq!(spec.channels, 2);
    }

    #[test]
    fn a_device_that_never_answers_says_which_half_gave_up() {
        let (tx, rx) = mpsc::channel::<StartSignal>();
        let err = await_start(&rx, Duration::from_millis(20), Duration::from_millis(20))
            .expect_err("nothing was ever sent");
        assert!(err.contains("microphone did not answer"), "{err}");
        drop(tx);
    }

    #[test]
    fn a_device_that_answers_and_then_hangs_is_not_a_device_error() {
        let (tx, rx) = mpsc::channel::<StartSignal>();
        tx.send(StartSignal::DeviceOpen).unwrap();
        let err = await_start(&rx, Duration::from_millis(20), Duration::from_millis(20))
            .expect_err("the stream never came up");
        assert!(err.contains("did not start recording"), "{err}");
    }

    #[test]
    fn a_failure_is_reported_in_the_words_the_thread_used() {
        // Both halves: the renderer shows these, so they must not be replaced
        // by a timeout message.
        let (tx, rx) = mpsc::channel::<StartSignal>();
        tx.send(StartSignal::Failed("no microphone is available".into()))
            .unwrap();
        let err = await_start(&rx, Duration::from_millis(20), Duration::from_millis(20))
            .expect_err("the device failed");
        assert_eq!(err, "no microphone is available");

        let (tx, rx) = mpsc::channel::<StartSignal>();
        tx.send(StartSignal::DeviceOpen).unwrap();
        tx.send(StartSignal::Failed(
            "Yeti Nano would not start: busy".into(),
        ))
        .unwrap();
        let err = await_start(&rx, Duration::from_millis(20), Duration::from_millis(20))
            .expect_err("the stream failed");
        assert_eq!(err, "Yeti Nano would not start: busy");
    }
}
