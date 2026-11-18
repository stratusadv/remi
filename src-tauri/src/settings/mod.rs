pub(crate) mod commands;

use crate::error::{AppError, AppResult};
use crate::workspace;
use serde::{Deserialize, Serialize};

const SETTINGS_BYTES_MAX: u32 = 64 << 10;
const SETTINGS_FILE: &str = "settings.json";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(crate) struct Settings {
    #[serde(default)]
    pub(crate) jobs_view: Option<String>,
    #[serde(default)]
    pub(crate) mode: Option<String>,
    #[serde(default)]
    pub(crate) notes_template_id_default: Option<String>,
    #[serde(default)]
    pub(crate) palette: Option<String>,
    #[serde(default)]
    pub(crate) recordings_directory: Option<String>,
    #[serde(default)]
    pub(crate) theme: Option<String>,
}

impl Settings {
    pub(crate) fn initial() -> Self {
        Self::default()
    }
}

pub(crate) fn settings_load() -> AppResult<Settings> {
    let path = workspace::root_file_path(SETTINGS_FILE)?;

    if !path.exists() {
        return Ok(Settings::initial());
    }

    let raw = workspace::file_read_bounded(&path, SETTINGS_BYTES_MAX)?;

    let settings = serde_json::from_str(&raw).unwrap_or_else(|error| {
        tracing::warn!(
            target: "remi_lib::settings",
            "settings could not be read, falling back to defaults: {}",
            error,
        );

        Settings::initial()
    });

    Ok(settings)
}

pub(crate) fn settings_save(settings: &Settings) -> AppResult<()> {
    let path = workspace::root_file_path(SETTINGS_FILE)?;
    let encoded = serde_json::to_string_pretty(settings)?;

    if encoded.len() > usize_of!(SETTINGS_BYTES_MAX) {
        return Err(AppError::Config(format!(
            "the settings are {} bytes, over the {SETTINGS_BYTES_MAX} bytes this app keeps",
            encoded.len(),
        )));
    }

    assert!(encoded.starts_with('{'));
    assert!(encoded.ends_with('}'));

    workspace::atomic_write(&path, encoded.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::test_support::root_scoped;
    use std::fs;

    #[test]
    fn settings_are_written_to_disk_and_read_back() {
        let _root = root_scoped();

        let settings = Settings {
            jobs_view: Some("grid".to_owned()),
            mode: Some("dark".to_owned()),
            theme: Some("th\u{e8}me".to_owned()),
            ..Settings::initial()
        };

        assert!(settings_load().unwrap().theme.is_none());

        settings_save(&settings).unwrap();

        let loaded = settings_load().unwrap();

        assert_eq!(loaded.mode.as_deref(), Some("dark"));
        assert_eq!(loaded.theme.as_deref(), Some("th\u{e8}me"));
        assert_eq!(loaded.jobs_view.as_deref(), Some("grid"));
        assert!(loaded.palette.is_none());
    }

    #[test]
    fn a_damaged_settings_file_falls_back_to_defaults_and_an_oversized_one_is_refused() {
        let _root = root_scoped();
        let path = workspace::root_file_path(SETTINGS_FILE).unwrap();
        let directory = Some("x".repeat(usize_of!(SETTINGS_BYTES_MAX)));
        let oversized = Settings { recordings_directory: directory, ..Settings::initial() };

        fs::write(&path, b"{ nope").unwrap();

        assert!(settings_load().unwrap().theme.is_none());
        assert!(settings_save(&oversized).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"{ nope");

        fs::write(&path, "x".repeat(usize_of!(SETTINGS_BYTES_MAX) + 1)).unwrap();

        assert_ne!(settings_load().unwrap_err().to_string(), "");
    }

    #[test]
    fn unknown_keys_in_a_settings_file_are_ignored() {
        let restored: Settings = serde_json::from_str(r#"{"unknown":1,"theme":"dark"}"#).unwrap();

        assert_eq!(restored.theme.as_deref(), Some("dark"));
    }

    #[test]
    fn settings_survive_a_round_trip_through_json() {
        let settings = Settings {
            jobs_view: None,
            mode: Some("light".to_owned()),
            notes_template_id_default: Some("default-standup".to_owned()),
            palette: Some("graphite".to_owned()),
            recordings_directory: None,
            theme: Some("standard".to_owned()),
        };

        let raw = serde_json::to_string(&settings).expect("serialize");
        let restored: Settings = serde_json::from_str(&raw).expect("deserialize");

        assert_eq!(restored.mode.as_deref(), Some("light"));
        assert_eq!(restored.theme.as_deref(), Some("standard"));
        assert_eq!(restored.palette.as_deref(), Some("graphite"));
        assert_eq!(restored.notes_template_id_default.as_deref(), Some("default-standup"));
    }

    #[test]
    fn a_settings_file_written_by_an_older_build_still_reads() {
        let restored: Settings = serde_json::from_str("{}").expect("deserialize");

        assert!(restored.mode.is_none());
        assert!(restored.theme.is_none());
        assert!(restored.notes_template_id_default.is_none());

        let raw = concat!(
            r#"{"api_host": "https://api.example.test", "embeddings_host": null, "#,
            r#""embeddings_model": "", "notes_model": "custom", "#,
            r#""notes_thinking": "xhigh", "theme": "standard"}"#,
        );

        let carried: Settings = serde_json::from_str(raw).expect("deserialize");
        let rewritten = serde_json::to_string(&carried).expect("serialize");

        assert_eq!(carried.theme.as_deref(), Some("standard"));
        assert!(!rewritten.contains("api_host"));
        assert!(!rewritten.contains("notes_thinking"));
    }
}
