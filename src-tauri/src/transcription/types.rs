use crate::state::AppState;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use tauri::{Emitter, Manager};

pub(crate) const EVENT_TRANSCRIPTION_SEGMENT: &str = "transcription_segment";
pub(crate) const EVENT_TRANSCRIPTION_STAGE: &str = "transcription_stage";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct TranscriptSegment {
    pub(crate) text: String,
    pub(crate) start_seconds: f64,
    pub(crate) end_seconds: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct Transcript {
    pub(crate) text: String,
    pub(crate) segments: Vec<TranscriptSegment>,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct SegmentChunk {
    pub(crate) stream_id: String,
    pub(crate) text: String,
    pub(crate) start_seconds: f64,
    pub(crate) end_seconds: f64,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct StageChunk {
    pub(crate) stream_id: String,
    pub(crate) stage: String,
}

#[derive(Debug)]
pub(crate) struct TranscribeProgress {
    pub(crate) app: tauri::AppHandle,
    pub(crate) stream_id: String,
}

impl TranscribeProgress {
    pub(crate) fn cancel_clear(&self) {
        assert_ne!(self.stream_id, "");
        assert_eq!(self.app.config().identifier, crate::APP_DATA_FOLDER);

        self.app.state::<AppState>().cancellation.clear(&self.stream_id);
    }

    pub(crate) fn cancel_register(&self) -> Arc<AtomicBool> {
        assert_ne!(self.stream_id, "");
        assert_eq!(self.app.config().identifier, crate::APP_DATA_FOLDER);

        self.app.state::<AppState>().cancellation.register(&self.stream_id)
    }

    pub(crate) fn emit_stage(&self, stage: &str) {
        assert_ne!(stage, "");
        assert_ne!(self.stream_id, "");

        let chunk = StageChunk { stream_id: self.stream_id.clone(), stage: stage.to_owned() };

        if let Err(error) = self.app.emit(EVENT_TRANSCRIPTION_STAGE, chunk) {
            tracing::warn!(
                target: "scribe_lib::transcription",
                "emit transcription_stage failed: {}",
                error,
            );
        }
    }
}
