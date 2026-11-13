use serde::{Serialize, Serializer};

const ERROR_SOURCE_DEPTH_MAX: u32 = 8;

#[derive(Debug, thiserror::Error)]
pub(crate) enum AppError {
    #[error("audio error: {0}")]
    Audio(String),

    #[error("config error: {0}")]
    Config(String),

    #[error("export error: {0}")]
    Export(String),

    #[error("search index error: {0}")]
    Index(String),

    #[error("io error: {0}")]
    IO(#[from] std::io::Error),

    #[error("network error: {}", error_chain_describe(.0))]
    Network(#[from] reqwest::Error),

    #[error("serde error: {0}")]
    Serde(#[from] serde_json::Error),

    #[error("api error: {0}")]
    Service(String),

    #[error("task error: {0}")]
    Task(String),

    #[error("transcription error: {0}")]
    Transcription(String),
}

impl From<rusqlite::Error> for AppError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Index(error_chain_describe(&error))
    }
}

impl Serialize for AppError {
    fn serialize<Output: Serializer>(
        &self,
        serializer: Output,
    ) -> Result<Output::Ok, Output::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

pub(crate) fn error_chain_describe(error: &dyn std::error::Error) -> String {
    let mut described = error.to_string();
    let mut source = error.source();
    let mut depth: u32 = 0;

    while let Some(cause) = source {
        if depth >= ERROR_SOURCE_DEPTH_MAX {
            break;
        }

        let text = cause.to_string();

        if !described.contains(&text) {
            described.push_str(": ");
            described.push_str(&text);
        }

        source = cause.source();
        depth += 1;
    }

    assert!(depth <= ERROR_SOURCE_DEPTH_MAX);
    assert_ne!(described, "");

    described
}

pub(crate) type AppResult<T> = Result<T, AppError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, thiserror::Error)]
    #[error("{text}")]
    struct Layered {
        text: &'static str,
        source: Option<Box<Self>>,
    }

    fn layered(texts: &[&'static str]) -> Layered {
        assert_ne!(texts.len(), 0);

        let mut error = Layered { text: texts[texts.len() - 1], source: None };

        for text in texts.iter().rev().skip(1) {
            error = Layered { text, source: Some(Box::new(error)) };
        }

        error
    }

    #[test]
    fn an_error_chain_lists_every_cause_once_and_stops_at_its_depth_limit() {
        let chain = layered(&[
            "error sending request for url (x)",
            "sending body",
            "connection reset by peer",
        ]);

        assert_eq!(
            error_chain_describe(&chain),
            "error sending request for url (x): sending body: connection reset by peer",
        );

        let repeated = layered(&["timed out", "timed out"]);

        assert_eq!(error_chain_describe(&repeated), "timed out");

        let deep =
            layered(&["l0", "l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8", "l9", "l10", "l11"]);

        assert_eq!(error_chain_describe(&deep), "l0: l1: l2: l3: l4: l5: l6: l7: l8");
    }
}
