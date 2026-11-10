use super::audio::{SAMPLE_RATE_WHISPER, load_for_whisper};
use super::remote::transcribe_audio_file;
use super::types::{TranscribeProgress, Transcript, TranscriptSegment};
use crate::contract::TranscriptReuse;
use crate::endpoints::storage::endpoint_load;
use crate::error::{AppError, AppResult};
use crate::notes::commands::title_generate;
use crate::people::storage::{Person, people_load_all};
use crate::workspace::{self, JobMeta, TranscriptSlot};
use serde::Serialize;
use std::path::{Path, PathBuf};

const ENGINE_ID_IMPORTED: &str = "imported";
const ENGINE_ID_REMOTE_PREFIX: &str = "remote-";
const IMPORT_TEXT_BYTES_MAX: u32 = 16 << 20;
const LABEL_IMPORTED: &str = "Imported transcript";
const SOURCE_PATH_IMPORTED: &str = "(imported transcript)";
const SPELLING_HINT_CHARS_MAX: u32 = 600;

#[derive(Clone, Copy, Debug)]
pub(crate) struct TranscriptImport<'text> {
    pub(crate) title: &'text str,
    pub(crate) transcript_text: &'text str,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct TranscriptionResult {
    pub(crate) job_id: String,
    pub(crate) transcript: Transcript,
    pub(crate) cached: bool,
}

pub(crate) fn audio_prepare_blocking(source_path: &Path) -> AppResult<(String, PathBuf)> {
    let prepared_earlier =
        if source_path.exists() { None } else { audio_prepared_find(source_path)? };

    if let Some(prepared) = prepared_earlier {
        return Ok(prepared);
    }

    let job_id = workspace::job_id_from_source_content(source_path)?;
    let source_metadata = std::fs::metadata(source_path)?;
    let existing = workspace::meta_load(&job_id)?;

    assert_ne!(job_id, "");

    let label = source_path.file_name().map(|name| name.to_string_lossy().into_owned());

    let meta = audio_prepare_meta(&job_id, source_path, &source_metadata, label, existing);

    assert_eq!(meta.id, job_id);

    workspace::meta_save(&meta)?;

    let audio_path = workspace::job_audio_path(&job_id)?;

    if !workspace::audio_wav_is_prepared(&audio_path) {
        let samples = load_for_whisper(source_path)?;

        workspace::audio_wav_save(&samples, SAMPLE_RATE_WHISPER, &audio_path)?;
    }

    Ok((job_id, audio_path))
}

pub(crate) async fn transcribe_remote_async(
    source_path: &Path,
    endpoint_id: &str,
    transcript_reuse: TranscriptReuse,
    progress: Option<TranscribeProgress>,
) -> AppResult<TranscriptionResult> {
    let endpoint = endpoint_load(endpoint_id)?;
    let engine_id = format!("{ENGINE_ID_REMOTE_PREFIX}{endpoint_id}");

    stage_emit(progress.as_ref(), "preparing_audio");

    let source_owned = source_path.to_path_buf();

    let (job_id, audio_path) =
        crate::blocking::run(move || audio_prepare_blocking(&source_owned)).await?;

    let slot = TranscriptSlot { engine_id: &engine_id, job_id: &job_id };

    let reusable = if transcript_reuse == TranscriptReuse::Allowed {
        workspace::transcript_load::<Transcript>(&slot)?
            .filter(|stored| !stored.text.trim().is_empty())
    } else {
        None
    };

    if let Some(cached) = reusable {
        stage_emit(progress.as_ref(), "done");

        return Ok(TranscriptionResult { job_id, transcript: cached, cached: true });
    }

    stage_emit(progress.as_ref(), "transcribing");

    let spelling_hint = transcribe_remote_spelling_hint();

    let transcript =
        transcribe_audio_file(&audio_path, &endpoint, &spelling_hint, progress.as_ref()).await?;

    transcript_store(&slot, &transcript)?;

    transcribe_remote_title_apply(&job_id, &transcript).await;

    stage_emit(progress.as_ref(), "done");

    Ok(TranscriptionResult { job_id, transcript, cached: false })
}

pub(crate) fn transcript_import_blocking(
    import: &TranscriptImport<'_>,
) -> AppResult<TranscriptionResult> {
    let TranscriptImport { title, transcript_text } = *import;

    if transcript_text.len() > usize_of!(IMPORT_TEXT_BYTES_MAX) {
        return Err(AppError::Config(format!(
            "the pasted transcript is {} bytes, over the {IMPORT_TEXT_BYTES_MAX} bytes this app \
             imports",
            transcript_text.len(),
        )));
    }

    let trimmed = transcript_text.trim();

    if trimmed.is_empty() {
        return Err(AppError::Config("transcript text is empty".into()));
    }

    let job_id = workspace::job_id_from_text(trimmed);
    let title_trimmed = title.trim();
    let title_clean = if title_trimmed.is_empty() { None } else { Some(title_trimmed.to_owned()) };
    let source_size_bytes = u64::try_from(trimmed.len()).unwrap_or(u64::MAX);
    let existing = workspace::meta_load(&job_id)?;
    let meta = transcript_import_meta(&job_id, source_size_bytes, title_clean, existing);

    assert_eq!(meta.id, job_id);
    assert_eq!(meta.source_size_bytes, source_size_bytes);

    workspace::meta_save(&meta)?;

    let transcript =
        Transcript { text: trimmed.to_owned(), segments: transcript_import_segments(trimmed) };

    assert_ne!(transcript.segments.len(), 0);

    let slot = TranscriptSlot { engine_id: ENGINE_ID_IMPORTED, job_id: &job_id };

    workspace::transcript_save(&slot, &transcript)?;

    Ok(TranscriptionResult { job_id, transcript, cached: false })
}

fn audio_prepare_meta(
    job_id: &str,
    source_path: &Path,
    source_metadata: &std::fs::Metadata,
    label: Option<String>,
    existing: Option<JobMeta>,
) -> JobMeta {
    let source_path_text = source_path.to_string_lossy().into_owned();
    let source_size_bytes = source_metadata.len();
    let recorded_at_unix = metadata_recorded_at_unix(source_metadata);

    let meta = match existing {
        None => JobMeta {
            id: job_id.to_owned(),
            source_path: source_path_text,
            source_size_bytes,
            created_at_unix: chrono::Utc::now().timestamp(),
            recorded_at_unix,
            label,
            title: None,
            attendees: Vec::new(),
            person_ids: Vec::new(),
            person_ids_mentioned: Vec::new(),
            project: None,
            tags: Vec::new(),
            favourite: false,
        },
        Some(previous) => JobMeta {
            id: job_id.to_owned(),
            source_path: source_path_text,
            source_size_bytes,
            created_at_unix: previous.created_at_unix,
            recorded_at_unix,
            label: previous.label.or(label),
            title: previous.title,
            attendees: previous.attendees,
            person_ids: previous.person_ids,
            person_ids_mentioned: previous.person_ids_mentioned,
            project: previous.project,
            tags: previous.tags,
            favourite: previous.favourite,
        },
    };

    assert_eq!(meta.id, job_id);
    assert_eq!(meta.source_size_bytes, source_size_bytes);

    meta
}

fn audio_prepared_find(source_path: &Path) -> AppResult<Option<(String, PathBuf)>> {
    let source_text = source_path.to_string_lossy();
    let jobs = workspace::jobs_list_all()?;

    for job in jobs.into_iter().filter(|job| job.source_path == source_text) {
        let audio_path = workspace::job_audio_path(&job.id)?;

        if workspace::audio_wav_is_prepared(&audio_path) {
            return Ok(Some((job.id, audio_path)));
        }
    }

    Ok(None)
}

fn metadata_recorded_at_unix(metadata: &std::fs::Metadata) -> Option<i64> {
    let time = metadata.created().or_else(|_| metadata.modified()).ok()?;
    let elapsed = time.duration_since(std::time::UNIX_EPOCH).ok()?;

    i64::try_from(elapsed.as_secs()).ok()
}

fn spelling_hint_build(people: &[Person]) -> String {
    let mut hint = String::new();

    for person in people {
        let name = person.name_full();

        if name.is_empty() {
            continue;
        }

        let separator_length = if hint.is_empty() { 0 } else { 2 };
        let hint_length_next = hint.chars().count() + separator_length + name.chars().count();

        if hint_length_next > usize_of!(SPELLING_HINT_CHARS_MAX) {
            break;
        }

        if !hint.is_empty() {
            hint.push_str(", ");
        }

        hint.push_str(&name);
    }

    assert!(hint.chars().count() <= usize_of!(SPELLING_HINT_CHARS_MAX));

    hint
}

fn stage_emit(progress: Option<&TranscribeProgress>, stage: &str) {
    assert_ne!(stage, "");

    if let Some(reporter) = progress {
        reporter.emit_stage(stage);
    }
}

fn transcribe_remote_spelling_hint() -> String {
    let hint = match people_load_all() {
        Ok(people) => spelling_hint_build(&people),
        Err(error) => {
            tracing::warn!("people unavailable for the spelling hint: {error}");

            String::new()
        }
    };

    assert!(hint.chars().count() <= usize_of!(SPELLING_HINT_CHARS_MAX));

    hint
}

async fn transcribe_remote_title_apply(job_id: &str, transcript: &Transcript) {
    let meta = match workspace::meta_load(job_id) {
        Ok(Some(meta)) => meta,
        Ok(None) => {
            tracing::warn!("no meta for job {job_id}; the recording stays untitled");

            return;
        }
        Err(error) => {
            tracing::warn!("meta for job {job_id} unreadable: {error}; it stays untitled");

            return;
        }
    };

    if meta.title.as_deref().is_some_and(|existing| !existing.trim().is_empty()) {
        return;
    }

    let title = match title_generate(&transcript.text).await {
        Ok(title) => title,
        Err(error) => {
            tracing::warn!("title generation failed for job {job_id}: {error}");

            return;
        }
    };

    assert_ne!(title, "");

    let mut latest = match workspace::meta_load(job_id) {
        Ok(Some(reloaded)) => reloaded,
        Ok(None) => return,
        Err(error) => {
            tracing::warn!("meta for job {job_id} unreadable after titling: {error}");

            return;
        }
    };

    if latest.title.as_deref().is_some_and(|existing| !existing.trim().is_empty()) {
        return;
    }

    latest.title = Some(title);

    if let Err(error) = workspace::meta_save(&latest) {
        tracing::warn!("title for job {job_id} could not be saved: {error}");
    }
}

fn transcript_import_meta(
    job_id: &str,
    source_size_bytes: u64,
    title_clean: Option<String>,
    existing: Option<JobMeta>,
) -> JobMeta {
    assert!(source_size_bytes > 0);

    let label = title_clean.clone().or_else(|| Some(LABEL_IMPORTED.to_owned()));

    let meta = match existing {
        None => JobMeta {
            id: job_id.to_owned(),
            source_path: SOURCE_PATH_IMPORTED.to_owned(),
            source_size_bytes,
            created_at_unix: chrono::Utc::now().timestamp(),
            recorded_at_unix: None,
            label,
            title: title_clean,
            attendees: Vec::new(),
            person_ids: Vec::new(),
            person_ids_mentioned: Vec::new(),
            project: None,
            tags: Vec::new(),
            favourite: false,
        },
        Some(previous) => JobMeta {
            id: job_id.to_owned(),
            source_path: previous.source_path,
            source_size_bytes,
            created_at_unix: previous.created_at_unix,
            recorded_at_unix: previous.recorded_at_unix,
            label: previous.label.or(label),
            title: previous.title.or(title_clean),
            attendees: previous.attendees,
            person_ids: previous.person_ids,
            person_ids_mentioned: previous.person_ids_mentioned,
            project: previous.project,
            tags: previous.tags,
            favourite: previous.favourite,
        },
    };

    assert_eq!(meta.id, job_id);
    assert!(meta.label.is_some());

    meta
}

fn transcript_import_segments(trimmed: &str) -> Vec<TranscriptSegment> {
    assert_ne!(trimmed, "");

    let segments: Vec<TranscriptSegment> = trimmed
        .split('\n')
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(|line| TranscriptSegment {
            text: line.to_owned(),
            start_seconds: 0.0,
            end_seconds: 0.0,
        })
        .collect();

    if segments.is_empty() {
        return vec![TranscriptSegment {
            text: trimmed.to_owned(),
            start_seconds: 0.0,
            end_seconds: 0.0,
        }];
    }

    assert!(segments.iter().all(|segment| !segment.text.is_empty()));

    segments
}

fn transcript_store(slot: &TranscriptSlot<'_>, transcript: &Transcript) -> AppResult<()> {
    if transcript.text.trim().is_empty() {
        return Err(AppError::Transcription(
            "no speech came back for this recording, so no transcript was saved".into(),
        ));
    }

    workspace::transcript_save(slot, transcript)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::test_support::{meta_with, root_scoped};

    fn import_of(fields: &[&str; 2]) -> AppResult<TranscriptionResult> {
        let [title, transcript_text] = *fields;

        transcript_import_blocking(&TranscriptImport { title, transcript_text })
    }

    fn person_named(names: &[&str; 2]) -> Person {
        let [name_first, name_last] = *names;

        Person {
            id: name_first.to_owned(),
            name_first: name_first.to_owned(),
            name_last: name_last.to_owned(),
            role: String::new(),
            description: String::new(),
        }
    }

    #[test]
    fn the_spelling_hint_lists_names_and_stops_at_its_limit() {
        let people = vec![person_named(&["Brayden", "Carlson"]), person_named(&["Jane", "Doe"])];

        assert_eq!(spelling_hint_build(&people), "Brayden Carlson, Jane Doe");
        assert_eq!(spelling_hint_build(&[]), "");

        let many: Vec<Person> = (0_i32..200_i32)
            .map(|index| person_named(&[&format!("Name{index}"), "Long"]))
            .collect();

        let hint = spelling_hint_build(&many);

        assert!(hint.chars().count() <= usize_of!(SPELLING_HINT_CHARS_MAX));
        assert!(!hint.ends_with(','));
    }

    #[test]
    fn a_name_ending_in_a_comma_keeps_the_hint_and_never_crashes() {
        let people = vec![person_named(&["Doe,", ""])];

        assert_eq!(spelling_hint_build(&people), "Doe,");
    }

    #[test]
    fn every_non_blank_line_becomes_its_own_segment() {
        let segments = transcript_import_segments("first\n\n  second  \nthird");

        assert_eq!(segments.len(), 3);
        assert_eq!(segments[1].text, "second");
    }

    #[test]
    fn a_transcript_with_no_line_breaks_is_still_one_segment() {
        let segments = transcript_import_segments("only one line");

        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].text, "only one line");
    }

    #[test]
    fn an_import_past_the_size_limit_is_refused_before_it_is_hashed() {
        let oversized = "a".repeat(usize_of!(IMPORT_TEXT_BYTES_MAX) + 1);

        assert_ne!(import_of(&["", &oversized]).unwrap_err().to_string(), "");
        assert_ne!(import_of(&["", "   \n  "]).unwrap_err().to_string(), "");
    }

    #[test]
    fn a_fresh_file_reports_a_recorded_time_near_now() {
        let path = std::env::temp_dir()
            .join(format!("scribe-recorded-at-test-{}.wav", std::process::id()));

        std::fs::write(&path, b"x").unwrap();

        let recorded_at_unix = metadata_recorded_at_unix(&std::fs::metadata(&path).unwrap());
        let now_unix = chrono::Utc::now().timestamp();

        std::fs::remove_file(&path).unwrap();

        assert!((now_unix - recorded_at_unix.unwrap()).abs() < 60);
    }

    #[test]
    fn a_person_without_any_name_is_left_out_of_the_spelling_hint() {
        let people = vec![person_named(&["", ""]), person_named(&["Jane", ""])];

        assert_eq!(spelling_hint_build(&people), "Jane");
    }

    #[test]
    fn an_imported_transcript_gets_a_job_with_metadata_and_one_segment_per_line() {
        let _root = root_scoped();
        let result = import_of(&["  Kickoff  ", "  first\n\nsecond  "]).unwrap();
        let meta = workspace::meta_load(&result.job_id).unwrap().expect("meta");

        assert_eq!(result.job_id, workspace::job_id_from_text("first\n\nsecond"));
        assert_eq!(meta.title.as_deref(), Some("Kickoff"));
        assert_eq!(meta.label.as_deref(), Some("Kickoff"));
        assert_eq!(meta.source_path, SOURCE_PATH_IMPORTED);
        assert_eq!(meta.source_size_bytes, 13);
        assert!(meta.recorded_at_unix.is_none());
        assert_eq!(result.transcript.text, "first\n\nsecond");

        let slot = TranscriptSlot { engine_id: ENGINE_ID_IMPORTED, job_id: &result.job_id };
        let stored = workspace::transcript_load::<Transcript>(&slot).unwrap().expect("transcript");

        assert_eq!(stored.text, "first\n\nsecond");
        assert_eq!(stored.segments.len(), 2);
        assert_eq!(stored.segments[1].text, "second");

        assert_eq!(
            workspace::engines_for_job(&result.job_id).unwrap(),
            vec![ENGINE_ID_IMPORTED.to_owned()],
        );
    }

    #[test]
    fn re_importing_the_same_text_keeps_the_first_title_and_creation_time() {
        let _root = root_scoped();
        let first = import_of(&["", "same words"]).unwrap();
        let mut meta = workspace::meta_load(&first.job_id).unwrap().expect("meta");

        assert_eq!(meta.label.as_deref(), Some(LABEL_IMPORTED));
        assert!(meta.title.is_none());

        meta.created_at_unix = 5;
        meta.title = Some("Kept".to_owned());
        workspace::meta_save(&meta).unwrap();

        let second = import_of(&["New title", "same words"]).unwrap();
        let reloaded = workspace::meta_load(&second.job_id).unwrap().expect("meta");

        assert_eq!(second.job_id, first.job_id);
        assert_eq!(reloaded.created_at_unix, 5);
        assert_eq!(reloaded.title.as_deref(), Some("Kept"));
        assert_eq!(reloaded.label.as_deref(), Some(LABEL_IMPORTED));
    }

    #[test]
    fn preparing_metadata_keeps_the_previous_record_and_only_refreshes_the_source() {
        let _root = root_scoped();
        let source = root_path().join("meeting.wav");

        std::fs::write(&source, b"abc").unwrap();

        let metadata = std::fs::metadata(&source).unwrap();
        let label = Some("meeting.wav".to_owned());
        let fresh = audio_prepare_meta("id", &source, &metadata, label.clone(), None);
        let mut previous = meta_with("id", 7);

        previous.title = Some("Kept".to_owned());
        previous.label = Some("old.wav".to_owned());

        let kept = audio_prepare_meta("id", &source, &metadata, label, Some(previous));

        assert_eq!(fresh.label.as_deref(), Some("meeting.wav"));
        assert_eq!(fresh.source_size_bytes, 3);
        assert!(fresh.title.is_none());
        assert!(fresh.recorded_at_unix.is_some());
        assert_eq!(kept.created_at_unix, 7);
        assert_eq!(kept.title.as_deref(), Some("Kept"));
        assert_eq!(kept.label.as_deref(), Some("old.wav"));
        assert_eq!(kept.source_path, source.to_string_lossy());
        assert_eq!(kept.source_size_bytes, 3);
    }

    #[test]
    fn preparing_a_recording_writes_a_16k_mono_copy_into_its_job_folder_once() {
        let _root = root_scoped();
        let source = root_path().join("meeting.wav");
        let samples = vec![0.25_f32; 8000];

        workspace::audio_wav_save(&samples, 8000, &source).unwrap();

        let (job_id, audio_path) = audio_prepare_blocking(&source).unwrap();
        let (prepared, sample_rate) = workspace::audio_wav_load(&audio_path).unwrap();
        let meta = workspace::meta_load(&job_id).unwrap().expect("meta");

        assert_eq!(job_id, workspace::job_id_from_source_content(&source).unwrap());
        assert_eq!(audio_path, workspace::job_audio_path(&job_id).unwrap());
        assert_eq!(sample_rate, SAMPLE_RATE_WHISPER);
        assert!(prepared.len().abs_diff(16000) <= 1);
        assert_eq!(meta.label.as_deref(), Some("meeting.wav"));
        assert_eq!(meta.source_size_bytes, std::fs::metadata(&source).unwrap().len());

        std::fs::write(&audio_path, b"kept").unwrap();

        let (job_id_again, audio_path_again) = audio_prepare_blocking(&source).unwrap();

        assert_eq!(job_id_again, job_id);
        assert_eq!(std::fs::read(&audio_path_again).unwrap(), b"kept");

        assert_ne!(
            audio_prepare_blocking(&root_path().join("missing.wav")).unwrap_err().to_string(),
            "",
        );
    }

    #[test]
    fn a_half_written_audio_copy_is_prepared_again_from_the_original() {
        let _root = root_scoped();
        let source = root_path().join("meeting.wav");

        workspace::audio_wav_save(&vec![0.25_f32; 8000], 8000, &source).unwrap();

        let (_job_id, audio_path) = audio_prepare_blocking(&source).unwrap();

        workspace::audio_wav_save(&[], SAMPLE_RATE_WHISPER, &audio_path).unwrap();

        drop(audio_prepare_blocking(&source).unwrap());

        assert!(workspace::audio_wav_duration_seconds(&audio_path).unwrap() > 0.9_f64);
    }

    #[test]
    fn a_recording_with_no_text_is_refused_and_leaves_no_transcript() {
        let _root = root_scoped();
        let id = workspace::job_id_from_text("silence");
        let slot = TranscriptSlot { engine_id: "remote-a", job_id: &id };
        let blank = Transcript { text: " ".to_owned(), segments: Vec::new() };

        assert_ne!(transcript_store(&slot, &blank).unwrap_err().to_string(), "");
        assert!(workspace::transcript_load::<Transcript>(&slot).unwrap().is_none());
    }

    #[test]
    fn a_recording_whose_original_is_gone_prepares_from_its_stored_audio() {
        let _root = root_scoped();
        let source = root_path().join("meeting.wav");

        workspace::audio_wav_save(&vec![0.25_f32; 8000], 8000, &source).unwrap();

        let (job_id, audio_path) = audio_prepare_blocking(&source).unwrap();

        std::fs::remove_file(&source).unwrap();

        let (job_id_again, audio_path_again) = audio_prepare_blocking(&source).unwrap();

        assert_eq!(job_id_again, job_id);
        assert_eq!(audio_path_again, audio_path);
    }

    fn root_path() -> PathBuf {
        workspace::root().unwrap()
    }

    #[test]
    #[ignore = "manual: hits the configured transcription endpoint with SCRIBE_MANUAL_AUDIO"]
    fn manual_remote_transcription_of_a_local_file() {
        let audio = std::env::var("SCRIBE_MANUAL_AUDIO").expect("SCRIBE_MANUAL_AUDIO");
        let endpoint_id = std::env::var("SCRIBE_MANUAL_ENDPOINT").expect("SCRIBE_MANUAL_ENDPOINT");
        let runtime = tokio::runtime::Runtime::new().unwrap();

        tracing_subscriber::fmt().with_env_filter("scribe_lib=debug,info").with_ansi(false).init();

        let started = std::time::Instant::now();

        let outcome = runtime.block_on(transcribe_remote_async(
            Path::new(&audio),
            &endpoint_id,
            TranscriptReuse::Refused,
            None,
        ));

        match outcome {
            Ok(result) => println!(
                "MANUAL_OK job={} segments={} chars={} seconds={}",
                result.job_id,
                result.transcript.segments.len(),
                result.transcript.text.chars().count(),
                started.elapsed().as_secs(),
            ),
            Err(error) => println!("MANUAL_ERROR after {}s: {error}", started.elapsed().as_secs()),
        }
    }
}
