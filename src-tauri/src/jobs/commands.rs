use crate::blocking;
use crate::contract::{BarCount, ClipEnd, ClipStart, EngineID, JobID, SearchQuery};
use crate::error::{AppError, AppResult};
use crate::transcription::audio::{Waveform, waveform_compute};
use crate::transcription::types::Transcript;
use crate::workspace::{
    self,
    ClipPaths,
    ClipSpan,
    JobListing,
    JobMeta,
    JobMetaPatch,
    JobSearchHit,
    TranscriptSlot,
};

#[tauri::command(rename_all = "snake_case")]
pub(crate) async fn job_audio_clip_get(
    job_id: JobID,
    start_seconds: ClipStart,
    end_seconds: ClipEnd,
) -> AppResult<Option<String>> {
    blocking::run(move || {
        let span = ClipSpan::of(start_seconds, end_seconds)?;
        let path_source = workspace::job_audio_path(&job_id)?;

        if !path_source.exists() {
            return Ok(None);
        }

        let path_clip = workspace::job_audio_clip_path(&job_id, span)?;
        let paths = ClipPaths { clip: &path_clip, source: &path_source };

        workspace::job_audio_clips_remove(&job_id)?;
        workspace::audio_clip_save(&paths, span)?;

        Ok(Some(path_clip.to_string_lossy().into_owned()))
    })
    .await
}

#[tauri::command(rename_all = "snake_case")]
pub(crate) async fn job_audio_path_get(job_id: JobID) -> AppResult<Option<String>> {
    blocking::run(move || {
        let path = workspace::job_audio_path(&job_id)?;

        if !path.exists() {
            return Ok(None);
        }

        Ok(Some(path.to_string_lossy().into_owned()))
    })
    .await
}

#[tauri::command(rename_all = "snake_case")]
pub(crate) async fn job_delete(job_id: JobID) -> AppResult<()> {
    blocking::run(move || workspace::job_delete(&job_id)).await
}

#[tauri::command(rename_all = "snake_case")]
pub(crate) async fn job_meta_get(job_id: JobID) -> AppResult<Option<JobMeta>> {
    blocking::run(move || workspace::meta_load(&job_id)).await
}

#[tauri::command(rename_all = "snake_case")]
pub(crate) async fn job_meta_update(job_id: JobID, patch: JobMetaPatch) -> AppResult<JobMeta> {
    blocking::run(move || workspace::meta_apply_patch(&job_id, patch)).await
}

#[tauri::command(rename_all = "snake_case")]
pub(crate) async fn job_transcript_engines_list(job_id: JobID) -> AppResult<Vec<String>> {
    blocking::run(move || workspace::engines_for_job(&job_id)).await
}

#[tauri::command(rename_all = "snake_case")]
pub(crate) async fn job_transcript_load(
    job_id: JobID,
    engine_id: EngineID,
) -> AppResult<Option<Transcript>> {
    blocking::run(move || {
        let slot = TranscriptSlot { engine_id: &engine_id, job_id: &job_id };

        workspace::transcript_load::<Transcript>(&slot)
    })
    .await
}

#[tauri::command(rename_all = "snake_case")]
pub(crate) async fn job_transcript_save(job_id: JobID, transcript: Transcript) -> AppResult<()> {
    blocking::run(move || {
        if transcript.segments.is_empty() {
            return Err(AppError::Config("a transcript needs at least one segment".into()));
        }

        workspace::transcript_save_edited(&job_id, &transcript)
    })
    .await
}

#[tauri::command(rename_all = "snake_case")]
pub(crate) async fn job_waveform_get(
    job_id: JobID,
    bar_count: BarCount,
) -> AppResult<Option<Waveform>> {
    blocking::run(move || {
        let path = workspace::job_audio_path(&job_id)?;

        if !path.exists() {
            return Ok(None);
        }

        Ok(Some(waveform_compute(&path, bar_count)?))
    })
    .await
}

#[tauri::command]
pub(crate) async fn jobs_list() -> AppResult<Vec<JobListing>> {
    blocking::run(workspace::jobs_listing_all).await
}

#[tauri::command(rename_all = "snake_case")]
pub(crate) async fn jobs_search(query: SearchQuery) -> AppResult<Vec<JobSearchHit>> {
    blocking::run(move || workspace::jobs_search_all(&query)).await
}
