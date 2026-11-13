use super::types::{
    APIEndpoint,
    APIEndpointPurpose,
    EmbeddingsTarget,
    KeyStatus,
    ServiceStatus,
    SourceStatus,
};
use crate::error::{AppError, AppResult};
use crate::secrets::{protected_delete, protected_read, protected_write};
use crate::settings::{Settings, settings_load};
use crate::workspace;
use std::collections::HashMap;

const API_HOST_BUILTIN: Option<&str> = option_env!("REMI_API_HOST");
const API_KEY_BUILTIN_NOTES: Option<&str> = option_env!("REMI_API_KEY_NOTES");
const API_KEY_BUILTIN_TRANSCRIPTION: Option<&str> = option_env!("REMI_API_KEY_TRANSCRIPTION");
const API_KEY_CHARS_MAX: u32 = 1024;
pub(crate) const ENDPOINT_ID_NOTES: &str = "builtin-notes";
pub(crate) const ENDPOINT_ID_TRANSCRIPTION: &str = "builtin-transcription";
const KEYS_FILE: &str = "endpoint_keys.bin";
pub(crate) const MODEL_NOTES: &str = "stratus.thinking";
pub(crate) const MODEL_TRANSCRIPTION: &str = "stratus.listen";
const TRANSCRIBE_CHUNK_SECONDS: u32 = 120;

const _: () = assert!(TRANSCRIBE_CHUNK_SECONDS > 0);

struct EndpointSeed {
    id: &'static str,
    model: &'static str,
    name: &'static str,
    purpose: APIEndpointPurpose,
}

#[derive(Clone, Copy, Debug)]
struct KeySources<'key> {
    builtin: Option<&'key str>,
    host_builtin: bool,
    user: Option<&'key str>,
}

pub(crate) fn api_key_builtin_used(id: &str) -> AppResult<bool> {
    let keys = keys_load()?;
    let settings = settings_load()?;
    let status = api_key_status(id, &keys, &settings);

    assert!(!status.builtin || api_key_builtin(id).is_some());
    assert_eq!(status.user, api_key_user(id, &keys).is_some());

    Ok(status.builtin && !status.user)
}

pub(crate) fn api_key_set(purpose: APIEndpointPurpose, api_key: &str) -> AppResult<()> {
    let id = endpoint_id_for(purpose);
    let trimmed = api_key.trim();

    if trimmed.chars().count() > usize_of!(API_KEY_CHARS_MAX) {
        return Err(AppError::Config(format!(
            "the key is too long; a key is under {API_KEY_CHARS_MAX} characters",
        )));
    }

    let mut keys = keys_load()?;

    if trimmed.is_empty() {
        drop(keys.remove(id));
    } else {
        drop(keys.insert(id.to_owned(), trimmed.to_owned()));
    }

    assert!(keys.get(id).map_or(trimmed.is_empty(), |stored| stored == trimmed));

    keys_save(&keys)
}

pub(crate) fn embeddings_target_load() -> AppResult<Option<EmbeddingsTarget>> {
    let settings = settings_load()?;
    let model = settings.embeddings_model.as_deref().map(str::trim).unwrap_or_default();

    if model.is_empty() {
        return Ok(None);
    }

    let host_shared = host_resolve(&settings);
    let host_own = settings.embeddings_host.as_deref().map(str::trim).unwrap_or_default();
    let host = if host_own.is_empty() { host_shared.clone() } else { host_own.to_owned() };

    host_validate(&host)?;

    let api_key = if host == host_shared {
        api_key_resolve(ENDPOINT_ID_NOTES, &keys_load()?, &settings)
    } else {
        String::new()
    };

    assert_ne!(host, "");

    if !api_key.is_empty() {
        assert_eq!(host, host_shared);
    }

    Ok(Some(EmbeddingsTarget { api_key, host, model: model.to_owned() }))
}

pub(crate) fn endpoint_load(id: &str) -> AppResult<APIEndpoint> {
    let mut endpoint = builtins()
        .into_iter()
        .find(|endpoint| endpoint.id == id)
        .ok_or_else(|| AppError::Config(format!("endpoint not found: {id}")))?;

    let settings = settings_load()?;

    endpoint.host = host_resolve(&settings);
    endpoint.api_key = api_key_resolve(id, &keys_load()?, &settings);
    endpoint.has_api_key = !endpoint.api_key.is_empty();

    host_validate(&endpoint.host)?;

    if endpoint.purpose == APIEndpointPurpose::Notes {
        if let Some(model) = settings.notes_model.filter(|model| !model.trim().is_empty()) {
            endpoint.model = model;
        }

        endpoint.reasoning_effort = settings
            .notes_thinking
            .map(|effort| effort.trim().to_owned())
            .filter(|effort| !effort.is_empty());
    }

    assert_eq!(endpoint.id, id);
    assert_ne!(endpoint.host, "");

    Ok(endpoint)
}

const fn endpoint_id_for(purpose: APIEndpointPurpose) -> &'static str {
    match purpose {
        APIEndpointPurpose::Transcription => ENDPOINT_ID_TRANSCRIPTION,
        APIEndpointPurpose::Notes => ENDPOINT_ID_NOTES,
    }
}

pub(crate) fn endpoints_load_all() -> AppResult<Vec<APIEndpoint>> {
    let keys = keys_load()?;
    let settings = settings_load()?;
    let mut result = builtins().to_vec();

    for endpoint in &mut result {
        endpoint.host = host_resolve(&settings);
        endpoint.has_api_key = !api_key_resolve(&endpoint.id, &keys, &settings).is_empty();
    }

    assert_eq!(result.len(), builtins().len());
    assert!(result.iter().all(|endpoint| endpoint.api_key.is_empty()));

    Ok(result)
}

pub(crate) fn service_status_load() -> AppResult<ServiceStatus> {
    let keys = keys_load()?;
    let settings = settings_load()?;

    Ok(ServiceStatus {
        host: host_status(&settings),
        notes: api_key_status(ENDPOINT_ID_NOTES, &keys, &settings),
        transcription: api_key_status(ENDPOINT_ID_TRANSCRIPTION, &keys, &settings),
    })
}

fn api_key_builtin(id: &str) -> Option<&'static str> {
    let key = match id {
        ENDPOINT_ID_TRANSCRIPTION => API_KEY_BUILTIN_TRANSCRIPTION,
        ENDPOINT_ID_NOTES => API_KEY_BUILTIN_NOTES,
        _ => None,
    };

    let usable = key.map(str::trim).filter(|text| !text.is_empty());

    assert!(usable.is_none_or(|text| !text.is_empty()));
    assert!(usable.is_none_or(|text| text.trim() == text));

    usable
}

fn api_key_resolve(id: &str, keys: &HashMap<String, String>, settings: &Settings) -> String {
    let sources = KeySources {
        builtin: api_key_builtin(id),
        host_builtin: host_is_builtin(settings),
        user: api_key_user(id, keys),
    };

    api_key_sent(&sources).unwrap_or_default().to_owned()
}

fn api_key_sent<'key>(sources: &KeySources<'key>) -> Option<&'key str> {
    assert!(sources.builtin.is_none_or(|key| !key.is_empty()));
    assert!(sources.user.is_none_or(|key| !key.is_empty()));

    if sources.user.is_some() {
        return sources.user;
    }

    sources.builtin.filter(|_key| sources.host_builtin)
}

fn api_key_status(id: &str, keys: &HashMap<String, String>, settings: &Settings) -> KeyStatus {
    let length = api_key_resolve(id, keys, settings).chars().count();

    KeyStatus {
        builtin: api_key_builtin(id).is_some() && host_is_builtin(settings),
        length: u32::try_from(length).unwrap_or(API_KEY_CHARS_MAX),
        user: api_key_user(id, keys).is_some(),
    }
}

fn api_key_user<'keys>(id: &str, keys: &'keys HashMap<String, String>) -> Option<&'keys str> {
    keys.get(id).map(String::as_str).filter(|key| !key.is_empty())
}

fn builtin(seed: &EndpointSeed) -> APIEndpoint {
    assert_ne!(seed.id, "");
    assert_ne!(seed.model, "");

    let transcribe = seed.purpose == APIEndpointPurpose::Transcription;

    APIEndpoint {
        id: seed.id.to_owned(),
        name: seed.name.to_owned(),
        purpose: seed.purpose,
        host: String::new(),
        api_key: String::new(),
        model: seed.model.to_owned(),
        temperature: None,
        output_tokens_max: None,
        api_path_chat: None,
        api_path_transcribe: None,
        transcribe_verbose: transcribe.then_some(false),
        transcribe_chunk_seconds: transcribe.then_some(TRANSCRIBE_CHUNK_SECONDS),
        reasoning_effort: None,
        has_api_key: false,
    }
}

fn builtins() -> [APIEndpoint; 2] {
    [
        builtin(&EndpointSeed {
            id: ENDPOINT_ID_TRANSCRIPTION,
            model: MODEL_TRANSCRIPTION,
            name: "Transcription",
            purpose: APIEndpointPurpose::Transcription,
        }),
        builtin(&EndpointSeed {
            id: ENDPOINT_ID_NOTES,
            model: MODEL_NOTES,
            name: "Notes",
            purpose: APIEndpointPurpose::Notes,
        }),
    ]
}

fn host_builtin() -> Option<&'static str> {
    API_HOST_BUILTIN.map(str::trim).filter(|host| !host.is_empty())
}

fn host_is_builtin(settings: &Settings) -> bool {
    let builtin = host_builtin().and_then(|host| reqwest::Url::parse(host).ok());

    host_user_matches(host_user(settings), builtin.as_ref())
}

fn host_resolve(settings: &Settings) -> String {
    let host = host_user(settings)
        .map_or_else(|| host_builtin().unwrap_or_default().to_owned(), str::to_owned);

    assert_eq!(host.trim(), host);

    host
}

fn host_status(settings: &Settings) -> SourceStatus {
    SourceStatus { builtin: host_builtin().is_some(), user: host_user(settings).is_some() }
}

fn host_user(settings: &Settings) -> Option<&str> {
    settings.api_host.as_deref().map(str::trim).filter(|host| !host.is_empty())
}

fn host_user_matches(user: Option<&str>, builtin: Option<&reqwest::Url>) -> bool {
    let Some(user_host) = user else {
        return true;
    };

    assert_ne!(user_host, "");
    assert_eq!(user_host.trim(), user_host);

    reqwest::Url::parse(user_host).is_ok_and(|parsed| Some(&parsed) == builtin)
}

fn host_validate(host: &str) -> AppResult<()> {
    if host.is_empty() {
        return Err(AppError::Config(
            "No API address has been set. Enter one under Settings, AI.".into(),
        ));
    }

    let parsed = reqwest::Url::parse(host).map_err(|error| {
        AppError::Config(format!("The API address {host} is not a valid web address ({error})."))
    })?;

    if matches!(parsed.scheme(), "http" | "https") {
        return Ok(());
    }

    Err(AppError::Config(format!("The API address {host} must start with https:// or http://.")))
}

fn keys_load() -> AppResult<HashMap<String, String>> {
    let path = workspace::root_file_path(KEYS_FILE)?;

    let Some(payload) = protected_read(&path)? else {
        return Ok(HashMap::new());
    };

    let keys = serde_json::from_str(&payload).unwrap_or_else(|error| {
        tracing::warn!(
            target: "remi_lib::endpoints",
            "the key store could not be read and will be replaced on the next save: {}",
            error,
        );

        HashMap::new()
    });

    Ok(keys)
}

fn keys_save(keys: &HashMap<String, String>) -> AppResult<()> {
    let path = workspace::root_file_path(KEYS_FILE)?;

    if keys.is_empty() {
        return protected_delete(&path);
    }

    let payload = serde_json::to_string(keys)?;

    assert!(payload.starts_with('{'));

    protected_write(&path, &payload)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::settings_save;
    use crate::workspace::test_support::root_scoped;

    #[test]
    fn api_key_user_overrides_builtin() {
        let builtin = API_KEY_BUILTIN_NOTES.unwrap_or_default();
        let settings = Settings::initial();
        let mut keys = HashMap::new();

        assert_eq!(api_key_resolve(ENDPOINT_ID_NOTES, &keys, &settings), builtin);

        drop(keys.insert(ENDPOINT_ID_NOTES.to_owned(), " user-key ".to_owned()));
        assert_eq!(api_key_resolve(ENDPOINT_ID_NOTES, &keys, &settings), " user-key ");

        assert_eq!(
            api_key_resolve(ENDPOINT_ID_TRANSCRIPTION, &keys, &settings).is_empty(),
            api_key_builtin(ENDPOINT_ID_TRANSCRIPTION).is_none(),
        );

        drop(keys.insert(ENDPOINT_ID_NOTES.to_owned(), String::new()));
        assert_eq!(api_key_resolve(ENDPOINT_ID_NOTES, &keys, &settings), builtin);
        assert!(!api_key_status(ENDPOINT_ID_NOTES, &keys, &settings).user);
    }

    #[test]
    fn the_builtin_key_goes_only_to_the_builtin_host_and_a_user_key_goes_anywhere() {
        let host = Some("https://elsewhere.test".to_owned());
        let elsewhere = Settings { api_host: host, ..Settings::initial() };
        let mut keys = HashMap::new();

        assert_eq!(api_key_resolve(ENDPOINT_ID_NOTES, &keys, &elsewhere), "");
        assert!(!api_key_status(ENDPOINT_ID_NOTES, &keys, &elsewhere).builtin);
        assert_eq!(api_key_status(ENDPOINT_ID_NOTES, &keys, &elsewhere).length, 0);

        drop(keys.insert(ENDPOINT_ID_NOTES.to_owned(), "user-key".to_owned()));

        assert_eq!(api_key_resolve(ENDPOINT_ID_NOTES, &keys, &elsewhere), "user-key");
        assert!(api_key_status(ENDPOINT_ID_NOTES, &keys, &elsewhere).user);
    }

    #[test]
    fn the_key_sent_is_the_user_key_else_the_builtin_key_for_the_builtin_host_alone() {
        let cases = [
            (None, Some("builtin"), true, Some("builtin")),
            (None, Some("builtin"), false, None),
            (Some("user"), Some("builtin"), true, Some("user")),
            (Some("user"), Some("builtin"), false, Some("user")),
            (Some("user"), None, false, Some("user")),
            (None, None, true, None),
        ];

        for (user, builtin, host_builtin, expected) in cases {
            let sources = KeySources { builtin, host_builtin, user };

            assert_eq!(api_key_sent(&sources), expected, "{sources:?}");
        }
    }

    #[test]
    fn a_user_host_matches_the_builtin_one_only_when_both_name_the_same_address() {
        let parsed = reqwest::Url::parse("https://api.example.test").unwrap();
        let builtin = Some(&parsed);

        assert!(host_user_matches(None, builtin));
        assert!(host_user_matches(None, None));
        assert!(host_user_matches(Some("https://api.example.test/"), builtin));
        assert!(host_user_matches(Some("HTTPS://API.EXAMPLE.TEST"), builtin));
        assert!(!host_user_matches(Some("https://api.example.test.evil"), builtin));
        assert!(!host_user_matches(Some("http://api.example.test"), builtin));
        assert!(!host_user_matches(Some("https://api.example.test:8443"), builtin));
        assert!(!host_user_matches(Some("https://api.example.test"), None));
        assert!(!host_user_matches(Some("not an address"), builtin));
    }

    #[test]
    fn billing_follows_the_builtin_key_and_stops_for_a_user_key_or_a_user_host() {
        let _root = root_scoped();
        let builtin = api_key_builtin(ENDPOINT_ID_TRANSCRIPTION).is_some();

        assert_eq!(api_key_builtin_used(ENDPOINT_ID_TRANSCRIPTION).unwrap(), builtin);

        api_key_set(APIEndpointPurpose::Transcription, "user-key").unwrap();

        assert!(!api_key_builtin_used(ENDPOINT_ID_TRANSCRIPTION).unwrap());

        api_key_set(APIEndpointPurpose::Transcription, "").unwrap();

        let elsewhere = Some("https://elsewhere.test".to_owned());

        settings_save(&Settings { api_host: elsewhere, ..Settings::initial() }).unwrap();

        assert!(!api_key_builtin_used(ENDPOINT_ID_TRANSCRIPTION).unwrap());

        let named = host_builtin().map(str::to_owned);

        settings_save(&Settings { api_host: named, ..Settings::initial() }).unwrap();

        assert_eq!(api_key_builtin_used(ENDPOINT_ID_TRANSCRIPTION).unwrap(), builtin);
    }

    #[test]
    fn host_user_overrides_builtin_and_a_blank_one_falls_through() {
        let mut settings = Settings::initial();

        assert_eq!(host_resolve(&settings), host_builtin().unwrap_or_default());
        assert!(!host_status(&settings).user);

        settings.api_host = Some(" https://example.test ".to_owned());
        assert_eq!(host_resolve(&settings), "https://example.test");
        assert!(host_status(&settings).user);

        settings.api_host = Some("   ".to_owned());
        assert!(!host_status(&settings).user);
    }

    #[test]
    fn a_host_must_be_a_web_address() {
        host_validate("https://example.test").unwrap();
        host_validate("http://localhost:8000").unwrap();

        assert!(host_validate("").is_err());
        assert!(host_validate("example.test").is_err());
        assert!(host_validate("ftp://example.test").is_err());
    }

    #[test]
    fn every_builtin_endpoint_starts_without_a_key_or_a_host() {
        for endpoint in builtins() {
            assert_eq!(endpoint.host, "");
            assert_eq!(endpoint.api_key, "");
            assert!(!endpoint.has_api_key);
        }
    }

    #[test]
    fn builtin_endpoints_carry_chunking_only_for_transcription() {
        let [transcription, notes] = builtins();

        assert_eq!(transcription.purpose, APIEndpointPurpose::Transcription);
        assert_eq!(transcription.transcribe_chunk_seconds, Some(TRANSCRIBE_CHUNK_SECONDS));
        assert_eq!(transcription.transcribe_verbose, Some(false));
        assert_eq!(transcription.model, MODEL_TRANSCRIPTION);
        assert_eq!(notes.purpose, APIEndpointPurpose::Notes);
        assert!(notes.transcribe_chunk_seconds.is_none());
        assert!(notes.transcribe_verbose.is_none());
        assert_eq!(notes.model, MODEL_NOTES);
        assert_eq!(endpoint_id_for(APIEndpointPurpose::Notes), notes.id);
        assert_eq!(endpoint_id_for(APIEndpointPurpose::Transcription), transcription.id);
        assert!(api_key_builtin("unknown").is_none());
    }

    #[test]
    fn a_saved_key_is_trimmed_reported_and_removed_again_with_its_file() {
        let _root = root_scoped();
        let path = workspace::root_file_path(KEYS_FILE).unwrap();

        api_key_set(APIEndpointPurpose::Notes, "  user-key  ").unwrap();

        let keys = keys_load().unwrap();
        let status = service_status_load().unwrap();

        assert_eq!(keys.get(ENDPOINT_ID_NOTES).map(String::as_str), Some("user-key"));
        assert!(path.exists());
        assert!(status.notes.user);
        assert_eq!(usize::try_from(status.notes.length).unwrap(), "user-key".len());
        assert!(!status.transcription.user);
        assert!(!status.host.user);

        api_key_set(APIEndpointPurpose::Notes, "   ").unwrap();

        let removed = service_status_load().unwrap();
        let builtin_length =
            api_key_builtin(ENDPOINT_ID_NOTES).map_or(0, |key| key.chars().count());

        assert_eq!(keys_load().unwrap().len(), 0);
        assert!(!path.exists());
        assert!(!removed.notes.user);
        assert_eq!(usize::try_from(removed.notes.length).unwrap(), builtin_length);
    }

    #[test]
    fn a_key_past_its_length_is_refused_and_length_is_counted_in_characters() {
        let _root = root_scoped();
        let at_limit = "\u{e9}".repeat(usize_of!(API_KEY_CHARS_MAX));
        let past_limit = "k".repeat(usize_of!(API_KEY_CHARS_MAX) + 1);

        api_key_set(APIEndpointPurpose::Transcription, &at_limit).unwrap();

        assert!(api_key_set(APIEndpointPurpose::Transcription, &past_limit).is_err());
        assert_eq!(keys_load().unwrap().get(ENDPOINT_ID_TRANSCRIPTION), Some(&at_limit));
    }

    #[cfg(not(windows))]
    #[test]
    fn an_unreadable_key_store_is_treated_as_empty_rather_than_fatal() {
        let _root = root_scoped();
        let path = workspace::root_file_path(KEYS_FILE).unwrap();

        std::fs::write(&path, b"{ not json").unwrap();

        assert_eq!(keys_load().unwrap().len(), 0);

        api_key_set(APIEndpointPurpose::Notes, "fresh").unwrap();

        assert_eq!(keys_load().unwrap().len(), 1);
    }

    #[test]
    fn a_loaded_notes_endpoint_takes_the_user_host_model_and_thinking_from_settings() {
        let _root = root_scoped();

        let settings = Settings {
            api_host: Some(" https://api.example.test/ ".to_owned()),
            notes_model: Some("custom-model".to_owned()),
            notes_thinking: Some("high".to_owned()),
            ..Settings::initial()
        };

        settings_save(&settings).unwrap();
        api_key_set(APIEndpointPurpose::Notes, "k").unwrap();

        let notes = endpoint_load(ENDPOINT_ID_NOTES).unwrap();

        assert_eq!(notes.host, "https://api.example.test/");
        assert_eq!(notes.model, "custom-model");
        assert_eq!(notes.reasoning_effort.as_deref(), Some("high"));
        assert_eq!(notes.api_key, "k");
        assert!(notes.has_api_key);

        let transcription = endpoint_load(ENDPOINT_ID_TRANSCRIPTION).unwrap();

        assert_eq!(transcription.host, "https://api.example.test/");
        assert_eq!(transcription.model, MODEL_TRANSCRIPTION);
        assert!(transcription.reasoning_effort.is_none());
        assert_eq!(transcription.api_key, "");
        assert_ne!(endpoint_load("unknown").unwrap_err().to_string(), "");
    }

    #[test]
    fn blank_model_and_thinking_settings_fall_back_to_the_builtin_values() {
        let _root = root_scoped();

        let settings = Settings {
            api_host: Some("https://api.example.test".to_owned()),
            notes_model: Some("   ".to_owned()),
            notes_thinking: Some(String::new()),
            ..Settings::initial()
        };

        settings_save(&settings).unwrap();

        let notes = endpoint_load(ENDPOINT_ID_NOTES).unwrap();

        assert_eq!(notes.model, MODEL_NOTES);
        assert!(notes.reasoning_effort.is_none());
    }

    #[test]
    fn a_thinking_setting_is_trimmed_and_whitespace_alone_counts_as_unset() {
        let _root = root_scoped();

        let settings = Settings {
            api_host: Some("https://api.example.test".to_owned()),
            notes_thinking: Some("  high ".to_owned()),
            ..Settings::initial()
        };

        settings_save(&settings).unwrap();

        let loaded = endpoint_load(ENDPOINT_ID_NOTES).unwrap();

        assert_eq!(loaded.reasoning_effort.as_deref(), Some("high"));

        settings_save(&Settings { notes_thinking: Some("   ".to_owned()), ..settings }).unwrap();

        assert!(endpoint_load(ENDPOINT_ID_NOTES).unwrap().reasoning_effort.is_none());
    }

    #[test]
    fn without_a_user_host_an_endpoint_loads_only_when_a_builtin_host_exists() {
        let _root = root_scoped();

        assert_eq!(endpoint_load(ENDPOINT_ID_NOTES).is_ok(), host_builtin().is_some());

        settings_save(&Settings { api_host: Some("ftp://x".to_owned()), ..Settings::initial() })
            .unwrap();

        assert_ne!(endpoint_load(ENDPOINT_ID_NOTES).unwrap_err().to_string(), "");
    }

    #[test]
    fn every_listed_endpoint_reports_its_key_without_carrying_it() {
        let _root = root_scoped();
        let host = Some("https://h.test".to_owned());
        let settings = Settings { api_host: host, ..Settings::initial() };

        api_key_set(APIEndpointPurpose::Notes, "k").unwrap();
        settings_save(&settings).unwrap();

        let endpoints = endpoints_load_all().unwrap();
        let notes = endpoints.iter().find(|endpoint| endpoint.id == ENDPOINT_ID_NOTES).unwrap();

        let transcription =
            endpoints.iter().find(|endpoint| endpoint.id == ENDPOINT_ID_TRANSCRIPTION).unwrap();

        assert_eq!(endpoints.len(), 2);
        assert!(notes.has_api_key);
        assert_eq!(notes.api_key, "");
        assert_eq!(notes.host, "https://h.test");
        assert!(!transcription.has_api_key);
        assert_eq!(transcription.api_key, "");
    }

    #[test]
    fn the_search_model_is_off_until_named_and_shares_the_notes_key_only_with_the_api_host() {
        let _root = root_scoped();

        assert!(embeddings_target_load().unwrap().is_none());

        let shared = Settings {
            api_host: Some("https://api.example.test".to_owned()),
            embeddings_model: Some(" qwen3-embedding:0.6b ".to_owned()),
            embeddings_host: Some("   ".to_owned()),
            ..Settings::initial()
        };

        settings_save(&shared).unwrap();
        api_key_set(APIEndpointPurpose::Notes, "notes-key").unwrap();

        let target = embeddings_target_load().unwrap().unwrap();

        assert_eq!(target.host, "https://api.example.test");
        assert_eq!(target.model, "qwen3-embedding:0.6b");
        assert_eq!(target.api_key, "notes-key");

        let own = Settings {
            embeddings_host: Some(" http://localhost:11434 ".to_owned()),
            ..shared.clone()
        };

        settings_save(&own).unwrap();

        let local = embeddings_target_load().unwrap().unwrap();

        assert_eq!(local.host, "http://localhost:11434");
        assert_eq!(local.api_key, "");

        let refused = Settings { embeddings_host: Some("ftp://files.test".to_owned()), ..shared };

        settings_save(&refused).unwrap();

        let error = embeddings_target_load().unwrap_err().to_string();

        assert!(error.contains("must start with https:// or http://"));
    }
}
