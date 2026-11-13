use crate::blocking;
use crate::contract::MicrophoneRate;
use crate::error::{AppError, AppResult};
use crate::settings;
use crate::state::AppState;
use crate::workspace::{
    self,
    AUDIO_HOURS_MAX,
    AUDIO_SECONDS_MAX,
    PCM16_SAMPLE_BYTES,
    wav_specification_mono_pcm16,
};
use std::fs::{self, File};
use std::io::BufWriter;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Manager, State};

const RECORDING_CHUNK_BYTES_MAX: u32 = 1 << 20;
const RECORDING_FILE_EXTENSION: &str = "wav";
const RECORDING_FILE_PREFIX: &str = "Recording ";
const RECORDING_FILE_TIME_FORMAT: &str = "%Y-%m-%d %H-%M-%S";
const RECORDING_SAMPLE_RATE_MAX: u64 = 48000;
const RECORDING_SAMPLE_RATE_MIN: u64 = 8000;
const RECORDING_SAMPLES_MAX: u64 = RECORDING_SAMPLE_RATE_MAX * AUDIO_SECONDS_MAX;
const RECORDINGS_FOLDER: &str = "Remi Remembers";
const RECORDINGS_FOLDER_FALLBACK: &str = "recordings";

const _: () = assert!(RECORDING_SAMPLE_RATE_MIN < RECORDING_SAMPLE_RATE_MAX);
const _: () = assert!(RECORDING_CHUNK_BYTES_MAX.is_multiple_of(PCM16_SAMPLE_BYTES));
const _: () = assert!((RECORDING_SAMPLES_MAX << PCM16_SAMPLE_BYTES.ilog2()) < (1_u64 << 32));

pub(crate) type RecordingSlot = Arc<Mutex<Option<RecordingActive>>>;

#[cfg(target_os = "linux")]
pub(crate) fn microphone_permission_install(window: &tauri::WebviewWindow) {
    use webkit2gtk::glib::ObjectExt;
    use webkit2gtk::{PermissionRequestExt, UserMediaPermissionRequest, WebViewExt};

    assert_ne!(window.label(), "");

    let installed = window.with_webview(|webview| {
        let _handler = webview.inner().connect_permission_request(|_, request| {
            if request.is::<UserMediaPermissionRequest>() {
                request.allow();

                return true;
            }

            false
        });
    });

    if let Err(error) = installed {
        tracing::warn!("microphone permission handler not installed: {error}");
    }
}

#[cfg(not(target_os = "linux"))]
pub(crate) const fn microphone_permission_install(_window: &tauri::WebviewWindow) {}

pub(crate) struct RecordingActive {
    path: PathBuf,
    sample_rate: u32,
    writer: hound::WavWriter<BufWriter<File>>,
}

#[tauri::command]
pub(crate) async fn recording_append(
    state: State<'_, AppState>,
    request: Request<'_>,
) -> AppResult<()> {
    let bytes = match request.body() {
        InvokeBody::Raw(bytes) => bytes,
        InvokeBody::Json(_) => {
            return Err(AppError::Audio("recording chunk must be raw PCM bytes".into()));
        }
    };

    recording_append_blocking(&state.recording, bytes)
}

#[tauri::command]
pub(crate) async fn recording_discard(app: AppHandle) -> AppResult<()> {
    slot_run(&app, recording_discard_blocking).await
}

#[tauri::command]
pub(crate) async fn recording_finish(app: AppHandle) -> AppResult<String> {
    slot_run(&app, recording_finish_blocking).await
}

#[tauri::command(rename_all = "snake_case")]
pub(crate) async fn recording_start(
    app: AppHandle,
    sample_rate: MicrophoneRate,
) -> AppResult<String> {
    slot_run(&app, move |slot| recording_start_blocking(slot, sample_rate)).await
}

#[tauri::command]
pub(crate) async fn recordings_directory_default() -> AppResult<String> {
    blocking::run(|| {
        recordings_directory_default_resolve()
            .map(|directory| directory.to_string_lossy().into_owned())
    })
    .await
}

fn recording_append_blocking(slot: &RecordingSlot, bytes: &[u8]) -> AppResult<()> {
    if bytes.len() > usize_of!(RECORDING_CHUNK_BYTES_MAX) {
        return Err(AppError::Audio(format!(
            "a recording chunk of {} bytes is over the {} byte limit",
            bytes.len(),
            RECORDING_CHUNK_BYTES_MAX,
        )));
    }

    if !bytes.len().is_multiple_of(usize_of!(PCM16_SAMPLE_BYTES)) {
        return Err(AppError::Audio("a recording chunk has a half sample at its end".into()));
    }

    let mut guard = recording_slot_lock(slot)?;

    let active =
        guard.as_mut().ok_or_else(|| AppError::Audio("no recording is in progress".into()))?;

    let samples_chunk = u64::try_from(bytes.len().div_euclid(usize_of!(PCM16_SAMPLE_BYTES)))
        .map_err(|error| AppError::Audio(format!("recording chunk size: {error}")))?;

    let samples_max = u64::from(active.sample_rate) * AUDIO_SECONDS_MAX;
    let samples_before = u64::from(active.writer.len());

    assert!(samples_max <= RECORDING_SAMPLES_MAX);

    if samples_before + samples_chunk > samples_max {
        return Err(AppError::Audio(format!(
            "the recording reached the limit of {AUDIO_HOURS_MAX} hours; stop it and start a \
             new one",
        )));
    }

    let (pairs, _) = bytes.as_chunks::<{ size_of::<i16>() }>();

    assert_eq!(u64::try_from(pairs.len()).unwrap_or(0), samples_chunk);

    for pair in pairs {
        active
            .writer
            .write_sample(i16::from_le_bytes(*pair))
            .map_err(|error| AppError::Audio(format!("recording write: {error}")))?;
    }

    active.writer.flush().map_err(|error| AppError::Audio(format!("recording flush: {error}")))?;

    assert_eq!(u64::from(active.writer.len()), samples_before + samples_chunk);

    drop(guard);

    Ok(())
}

fn recording_discard_blocking(slot: &RecordingSlot) -> AppResult<()> {
    let RecordingActive { path, writer, .. } = recording_take(slot)?;

    assert!(path.extension().is_some());

    drop(writer.finalize());

    fs::remove_file(&path)?;

    Ok(())
}

fn recording_finish_blocking(slot: &RecordingSlot) -> AppResult<String> {
    let RecordingActive { path, writer, .. } = recording_take(slot)?;
    let sample_count = writer.len();

    writer.finalize().map_err(|error| AppError::Audio(format!("recording finalize: {error}")))?;

    if sample_count == 0 {
        fs::remove_file(&path)?;

        return Err(AppError::Audio(
            "nothing was recorded; check that the microphone is plugged in and not muted".into(),
        ));
    }

    assert!(sample_count > 0);
    assert!(path.extension().is_some());

    Ok(path.to_string_lossy().into_owned())
}

fn recording_open(slot: &RecordingSlot, sample_rate: u32, path: PathBuf) -> AppResult<String> {
    assert!(sample_rate > 0);
    assert!(path.extension().is_some());

    let mut guard = recording_slot_lock(slot)?;

    if guard.is_some() {
        return Err(AppError::Audio("a recording is already in progress".into()));
    }

    let writer = hound::WavWriter::create(&path, wav_specification_mono_pcm16(sample_rate))
        .map_err(|error| AppError::Audio(format!("could not create the recording: {error}")))?;

    let path_text = path.to_string_lossy().into_owned();

    *guard = Some(RecordingActive { path, sample_rate, writer });

    drop(guard);

    assert_ne!(path_text, "");

    Ok(path_text)
}

fn recording_path_new() -> AppResult<PathBuf> {
    let directory = match settings::settings_load()?.recordings_directory {
        Some(chosen) => PathBuf::from(chosen),
        None => recordings_directory_default_resolve()?,
    };

    fs::create_dir_all(&directory).map_err(|error| {
        AppError::Audio(format!(
            "could not open the recordings folder {}: {error}; pick another one in Settings",
            directory.display(),
        ))
    })?;

    let stamp = chrono::Local::now().format(RECORDING_FILE_TIME_FORMAT);
    let file_name = format!("{RECORDING_FILE_PREFIX}{stamp}.{RECORDING_FILE_EXTENSION}");
    let path = directory.join(file_name);

    if path.exists() {
        return Err(AppError::Audio(
            "a recording from this second already exists; try again in a moment".into(),
        ));
    }

    assert!(path.extension().is_some_and(|extension| extension == RECORDING_FILE_EXTENSION));
    assert!(path.starts_with(&directory));

    Ok(path)
}

fn recording_slot_lock(slot: &RecordingSlot) -> AppResult<MutexGuard<'_, Option<RecordingActive>>> {
    slot.lock()
        .map_err(|_poisoned| AppError::Audio("the recording state was poisoned by a crash".into()))
}

fn recording_start_blocking(
    slot: &RecordingSlot,
    sample_rate: MicrophoneRate,
) -> AppResult<String> {
    let MicrophoneRate(rate) = sample_rate;

    if !(RECORDING_SAMPLE_RATE_MIN..=RECORDING_SAMPLE_RATE_MAX).contains(&u64::from(rate)) {
        return Err(AppError::Audio(format!(
            "the microphone sample rate {rate} Hz is outside the supported range",
        )));
    }

    let path = recording_path_new()?;

    assert!(u64::from(rate) >= RECORDING_SAMPLE_RATE_MIN);
    assert!(u64::from(rate) <= RECORDING_SAMPLE_RATE_MAX);

    recording_open(slot, rate, path)
}

fn recording_take(slot: &RecordingSlot) -> AppResult<RecordingActive> {
    let active = recording_slot_lock(slot)?
        .take()
        .ok_or_else(|| AppError::Audio("no recording is in progress".into()))?;

    assert!(active.sample_rate > 0);
    assert!(active.path.extension().is_some());

    Ok(active)
}

fn recordings_directory_default_resolve() -> AppResult<PathBuf> {
    let directory = match dirs::audio_dir() {
        Some(music) => music.join(RECORDINGS_FOLDER),
        None => workspace::root()?.join(RECORDINGS_FOLDER_FALLBACK),
    };

    assert!(directory.file_name().is_some());

    Ok(directory)
}

async fn slot_run<Reply, Work>(app: &AppHandle, work: Work) -> AppResult<Reply>
where
    Reply: Send + 'static,
    Work: FnOnce(&RecordingSlot) -> AppResult<Reply> + Send + 'static,
{
    let slot = Arc::clone(&app.state::<AppState>().recording);

    blocking::run(move || work(&slot)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn slot_new() -> RecordingSlot {
        Arc::new(Mutex::new(None))
    }

    fn path_temporary(name: &str) -> PathBuf {
        let file_name = format!("remi-recording-test-{name}-{}.wav", std::process::id());

        std::env::temp_dir().join(file_name)
    }

    #[test]
    fn an_appended_chunk_is_readable_before_the_recording_finishes() {
        let slot = slot_new();
        let path = recording_open(&slot, 16000, path_temporary("unfinished")).unwrap();

        let samples: Vec<u8> =
            [1_i16, -2, 3].iter().flat_map(|sample| sample.to_le_bytes()).collect();

        recording_append_blocking(&slot, &samples).unwrap();

        let (decoded, rate) = workspace::audio_wav_load(std::path::Path::new(&path)).unwrap();

        assert_eq!(rate, 16000);
        assert_eq!(decoded.len(), 3);

        recording_discard_blocking(&slot).unwrap();
    }

    #[test]
    fn appended_chunks_land_in_the_wav_file() {
        let slot = slot_new();
        let path = recording_open(&slot, 16000, path_temporary("append")).unwrap();

        let samples: Vec<u8> =
            [1_i16, -2, 3].iter().flat_map(|sample| sample.to_le_bytes()).collect();

        recording_append_blocking(&slot, &samples).unwrap();

        let finished = recording_finish_blocking(&slot).unwrap();
        let (decoded, rate) = workspace::audio_wav_load(std::path::Path::new(&finished)).unwrap();

        assert_eq!(finished, path);
        assert_eq!(rate, 16000);
        assert_eq!(decoded.len(), 3);
        assert!(decoded[0] > 0.0);
        assert!(decoded[1] < 0.0);
        assert!(decoded[2] > decoded[0]);
        assert_ne!(finished, "");

        fs::remove_file(&finished).unwrap();
    }

    #[test]
    fn an_empty_recording_is_removed_and_reported() {
        let slot = slot_new();
        let path = recording_open(&slot, 16000, path_temporary("empty")).unwrap();

        assert_ne!(recording_finish_blocking(&slot).unwrap_err().to_string(), "");
        assert!(!std::path::Path::new(&path).exists());
        assert_ne!(recording_discard_blocking(&slot).unwrap_err().to_string(), "");
    }

    #[test]
    fn a_half_sample_chunk_is_rejected() {
        let slot = slot_new();
        let path = recording_open(&slot, 16000, path_temporary("half")).unwrap();

        assert!(recording_append_blocking(&slot, &[1_u8]).is_err());
        assert!(std::path::Path::new(&path).exists());

        recording_discard_blocking(&slot).unwrap();

        assert!(!std::path::Path::new(&path).exists());
    }

    #[test]
    fn a_microphone_rate_outside_the_supported_range_is_refused_without_opening_a_file() {
        let slot = slot_new();
        let rate_high = MicrophoneRate(96_000);
        let rate_low = MicrophoneRate(4_000);

        assert_ne!(recording_start_blocking(&slot, rate_high).unwrap_err().to_string(), "");
        assert_ne!(recording_start_blocking(&slot, rate_low).unwrap_err().to_string(), "");

        let active = slot.lock().unwrap().is_some();

        assert!(!active);
    }

    #[test]
    fn a_second_recording_cannot_open_while_one_is_in_progress() {
        let slot = slot_new();

        let _first = recording_open(&slot, 16000, path_temporary("first")).unwrap();

        assert_ne!(
            recording_open(&slot, 16000, path_temporary("second")).unwrap_err().to_string(),
            "",
        );

        recording_discard_blocking(&slot).unwrap();
    }
}
