use super::pipeline::{
    TranscriptImport,
    TranscriptionResult,
    transcribe_remote_async,
    transcript_import_blocking,
};
use super::types::TranscribeProgress;
use crate::blocking;
use crate::contract::{EndpointID, StreamID, Title, TranscriptReuse, TranscriptText};
use crate::error::AppResult;
use std::path::PathBuf;
use tauri::AppHandle;

#[tauri::command(rename_all = "snake_case")]
pub(crate) async fn transcript_import(
    title: Title,
    transcript_text: TranscriptText,
) -> AppResult<TranscriptionResult> {
    blocking::run(move || {
        transcript_import_blocking(&TranscriptImport {
            title: &title,
            transcript_text: &transcript_text,
        })
    })
    .await
}

#[tauri::command(rename_all = "snake_case")]
pub(crate) async fn transcription_remote(
    app: AppHandle,
    audio_path: PathBuf,
    endpoint_id: EndpointID,
    stream_id: Option<StreamID>,
    transcript_reuse: TranscriptReuse,
) -> AppResult<TranscriptionResult> {
    transcribe_remote_async(
        &audio_path,
        &endpoint_id,
        transcript_reuse,
        stream_id.map(|id| TranscribeProgress { app, stream_id: id.into_string() }),
    )
    .await
}
