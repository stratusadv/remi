use crate::cancellation::stream_id_validate;
use crate::error::{AppError, AppResult};
use crate::workspace::job_id_validate;
use serde::Deserialize;
use std::ops::Deref;

macro_rules! text_wrapper {
    ($name:ident) => {
        #[derive(Clone, Debug, Deserialize)]
        #[serde(transparent)]
        pub(crate) struct $name(String);

        impl Deref for $name {
            type Target = str;

            fn deref(&self) -> &str {
                &self.0
            }
        }
    };
}

text_wrapper!(APIKey);
text_wrapper!(EndpointID);
text_wrapper!(EngineID);
text_wrapper!(Instruction);
text_wrapper!(Markdown);
text_wrapper!(RecordID);
text_wrapper!(SearchQuery);
text_wrapper!(TemplateID);
text_wrapper!(TextRaw);
text_wrapper!(Title);
text_wrapper!(TranscriptText);

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(transparent)]
pub(crate) struct BarCount(pub(crate) u32);

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(transparent)]
pub(crate) struct ClipEnd(pub(crate) f64);

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(transparent)]
pub(crate) struct ClipStart(pub(crate) f64);

#[derive(Clone, Debug, Deserialize)]
#[serde(try_from = "TextRaw")]
pub(crate) struct JobID(String);

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(transparent)]
pub(crate) struct MicrophoneRate(pub(crate) u32);

#[derive(Clone, Debug, Deserialize)]
#[serde(try_from = "TextRaw")]
pub(crate) struct StreamID(String);

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(from = "bool")]
pub(crate) enum TranscriptReuse {
    Allowed,
    Refused,
}

impl Deref for JobID {
    type Target = str;

    fn deref(&self) -> &str {
        &self.0
    }
}

impl Deref for StreamID {
    type Target = str;

    fn deref(&self) -> &str {
        &self.0
    }
}

impl StreamID {
    pub(crate) fn into_string(self) -> String {
        self.0
    }
}

impl From<bool> for TranscriptReuse {
    fn from(allowed: bool) -> Self {
        if allowed {
            return Self::Allowed;
        }

        Self::Refused
    }
}

impl TryFrom<TextRaw> for JobID {
    type Error = AppError;

    fn try_from(raw: TextRaw) -> AppResult<Self> {
        job_id_validate(&raw)?;

        Ok(Self(raw.0))
    }
}

impl TryFrom<TextRaw> for StreamID {
    type Error = AppError;

    fn try_from(raw: TextRaw) -> AppResult<Self> {
        stream_id_validate(&raw)?;

        Ok(Self(raw.0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_job_id_is_refused_unless_it_has_the_minted_shape() {
        let valid = "2cf24dba5fb0a30e26e83b2ac5b9e29e";
        let parsed: JobID = serde_json::from_value(json!(valid)).unwrap();

        assert_eq!(&*parsed, valid);
        assert_eq!(parsed.len(), valid.len());
        assert_ne!(serde_json::from_value::<JobID>(json!("")).unwrap_err().to_string(), "");

        let traversal = serde_json::from_value::<JobID>(json!("../../etc"));

        assert!(traversal.unwrap_err().to_string().contains("is not a job id"));
    }

    #[test]
    fn a_stream_id_is_refused_only_when_it_is_empty() {
        let parsed: StreamID = serde_json::from_value(json!("stream-a")).unwrap();
        let refused = serde_json::from_value::<StreamID>(json!("")).unwrap_err();

        assert_eq!(&*parsed, "stream-a");
        assert_eq!(parsed.into_string(), "stream-a");
        assert!(refused.to_string().contains("the stream id is empty"));
    }

    #[test]
    fn free_text_passes_through_exactly_as_the_window_sent_it() {
        let text = "  any text, even blank ones  ";
        let markdown: Markdown = serde_json::from_value(json!(text)).unwrap();
        let blank: Instruction = serde_json::from_value(json!("")).unwrap();

        assert_eq!(&*markdown, text);
        assert_eq!(&*blank, "");
        assert_eq!(markdown.len(), text.len());
    }

    #[test]
    fn a_number_from_the_window_passes_through_unchanged() {
        let bars: BarCount = serde_json::from_value(json!(360_u32)).unwrap();
        let rate: MicrophoneRate = serde_json::from_value(json!(48_000_u32)).unwrap();
        let start: ClipStart = serde_json::from_value(json!(1.5_f64)).unwrap();
        let end: ClipEnd = serde_json::from_value(json!(2.5_f64)).unwrap();

        assert_eq!(bars.0, 360);
        assert_eq!(rate.0, 48_000);
        assert!((start.0 - 1.5_f64).abs() < f64::EPSILON);
        assert!((end.0 - 2.5_f64).abs() < f64::EPSILON);
    }

    #[test]
    fn a_transcript_reuse_flag_reads_from_the_boolean_the_window_sends() {
        let allowed: TranscriptReuse = serde_json::from_value(json!(true)).unwrap();
        let refused: TranscriptReuse = serde_json::from_value(json!(false)).unwrap();

        assert_eq!(allowed, TranscriptReuse::Allowed);
        assert_eq!(refused, TranscriptReuse::Refused);
        assert_ne!(allowed, refused);
    }
}
