use serde::{Deserialize, Serialize};

const API_PATH_CHAT_DEFAULT: &str = "/v1/chat/completions";
const API_PATH_TRANSCRIBE_DEFAULT: &str = "/v1/audio/transcriptions";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum APIEndpointPurpose {
    Transcription,
    Notes,
}

#[derive(Debug, Clone)]
pub(crate) struct EmbeddingsTarget {
    pub(crate) api_key: String,
    pub(crate) host: String,
    pub(crate) model: String,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct KeyStatus {
    pub(crate) builtin: bool,
    pub(crate) length: u32,
    pub(crate) user: bool,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct SourceStatus {
    pub(crate) builtin: bool,
    pub(crate) user: bool,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct ServiceStatus {
    pub(crate) host: SourceStatus,
    pub(crate) notes: KeyStatus,
    pub(crate) transcription: KeyStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct APIEndpoint {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) purpose: APIEndpointPurpose,
    pub(crate) host: String,
    #[serde(default)]
    pub(crate) api_key: String,
    pub(crate) model: String,
    #[serde(default)]
    pub(crate) temperature: Option<f32>,
    #[serde(default)]
    pub(crate) output_tokens_max: Option<u32>,
    #[serde(default)]
    pub(crate) api_path_chat: Option<String>,
    #[serde(default)]
    pub(crate) api_path_transcribe: Option<String>,
    #[serde(default)]
    pub(crate) transcribe_verbose: Option<bool>,
    #[serde(default)]
    pub(crate) transcribe_chunk_seconds: Option<u32>,
    #[serde(default)]
    pub(crate) reasoning_effort: Option<String>,
    #[serde(default)]
    pub(crate) has_api_key: bool,
}

impl APIEndpoint {
    pub(crate) fn api_key_resolved(&self) -> &str {
        self.api_key.trim()
    }

    pub(crate) fn api_path_chat_resolved(&self) -> String {
        api_path_resolve(self.api_path_chat.as_deref(), API_PATH_CHAT_DEFAULT)
    }

    pub(crate) fn api_path_transcribe_resolved(&self) -> String {
        api_path_resolve(self.api_path_transcribe.as_deref(), API_PATH_TRANSCRIBE_DEFAULT)
    }

    pub(crate) fn host_resolved(&self) -> &str {
        self.host.trim()
    }

    pub(crate) fn model_resolved(&self) -> &str {
        self.model.trim()
    }
}

fn api_path_resolve(path: Option<&str>, path_default: &str) -> String {
    assert!(path_default.starts_with('/'));

    let chosen = path.map(str::trim).filter(|text| !text.is_empty()).unwrap_or(path_default);
    let resolved = if chosen.starts_with('/') { chosen.to_owned() } else { format!("/{chosen}") };

    assert!(resolved.starts_with('/'));
    assert!(resolved.len() >= chosen.len());

    resolved
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_blank_or_unslashed_path_is_made_usable() {
        assert_eq!(api_path_resolve(None, API_PATH_CHAT_DEFAULT), API_PATH_CHAT_DEFAULT);
        assert_eq!(api_path_resolve(Some("  "), API_PATH_CHAT_DEFAULT), API_PATH_CHAT_DEFAULT);
        assert_eq!(api_path_resolve(Some("v2/chat"), API_PATH_CHAT_DEFAULT), "/v2/chat");
        assert_eq!(api_path_resolve(Some(" /v2/chat "), API_PATH_CHAT_DEFAULT), "/v2/chat");
    }

    #[test]
    fn resolved_fields_are_trimmed_and_each_path_has_its_own_default() {
        let raw = concat!(
            r#"{"id":"i","name":"n","purpose":"transcription","host":" https://h.test ","#,
            r#""api_key":" k ","model":" m ","api_path_transcribe":"audio"}"#,
        );

        let endpoint: APIEndpoint = serde_json::from_str(raw).unwrap();

        assert_eq!(endpoint.purpose, APIEndpointPurpose::Transcription);
        assert_eq!(endpoint.host_resolved(), "https://h.test");
        assert_eq!(endpoint.api_key_resolved(), "k");
        assert_eq!(endpoint.model_resolved(), "m");
        assert_eq!(endpoint.api_path_transcribe_resolved(), "/audio");
        assert_eq!(endpoint.api_path_chat_resolved(), API_PATH_CHAT_DEFAULT);

        let raw_minimal = r#"{"id":"i","name":"n","purpose":"notes","host":"h","model":"m"}"#;
        let minimal: APIEndpoint = serde_json::from_str(raw_minimal).unwrap();

        assert_eq!(minimal.purpose, APIEndpointPurpose::Notes);
        assert_eq!(minimal.api_path_transcribe_resolved(), API_PATH_TRANSCRIBE_DEFAULT);
        assert_eq!(minimal.api_key, "");
        assert!(!minimal.has_api_key);
        assert!(minimal.temperature.is_none());

        let refused = serde_json::from_str::<APIEndpointPurpose>(r#""Notes""#);

        assert_ne!(refused.unwrap_err().to_string(), "");
    }
}
