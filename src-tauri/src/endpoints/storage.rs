use super::types::{APIEndpoint, APIEndpointPurpose, EmbeddingsTarget};
use crate::account::{gateway_host_builtin, gateway_token_load};
use crate::error::{AppError, AppResult};

pub(crate) const ENDPOINT_ID_NOTES: &str = "builtin-notes";
pub(crate) const ENDPOINT_ID_TRANSCRIPTION: &str = "builtin-transcription";
const MESSAGE_SERVICE_ABSENT: &str = "This build of remi has no account server.";
pub(crate) const MODEL_EMBEDDINGS: &str = "stratus.embed";
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

pub(crate) fn embeddings_target_load() -> AppResult<Option<EmbeddingsTarget>> {
    let Some(host) = gateway_host_builtin() else {
        return Ok(None);
    };

    let Some(api_key) = gateway_token_load()? else {
        return Ok(None);
    };

    assert_ne!(host, "");
    assert!(!host.ends_with('/'));
    assert_ne!(api_key, "");

    Ok(Some(EmbeddingsTarget {
        api_key,
        host: host.to_owned(),
        model: MODEL_EMBEDDINGS.to_owned(),
    }))
}

pub(crate) fn endpoint_is_builtin(endpoint: &APIEndpoint) -> bool {
    assert_ne!(endpoint.id, "");

    let host = endpoint.host_resolved().trim_end_matches('/');
    let builtin = gateway_host_builtin().is_some_and(|gateway| gateway == host);

    if builtin {
        assert_ne!(host, "");
    }

    builtin
}

pub(crate) fn endpoint_load(id: &str) -> AppResult<APIEndpoint> {
    let mut endpoint = builtins()
        .into_iter()
        .find(|endpoint| endpoint.id == id)
        .ok_or_else(|| AppError::Internal(format!("endpoint not found: {id}")))?;

    let host =
        gateway_host_builtin().ok_or_else(|| AppError::Config(MESSAGE_SERVICE_ABSENT.into()))?;

    let api_key = gateway_token_load()?.unwrap_or_default();

    endpoint.has_api_key = !api_key.is_empty();
    endpoint.api_key = api_key;
    host.clone_into(&mut endpoint.host);

    assert_eq!(endpoint.id, id);
    assert_ne!(endpoint.host, "");

    Ok(endpoint)
}

pub(crate) fn endpoints_load_all() -> AppResult<Vec<APIEndpoint>> {
    let has_api_key = gateway_token_load()?.is_some();
    let host = gateway_host_builtin().unwrap_or_default();
    let mut result = builtins().to_vec();

    for endpoint in &mut result {
        endpoint.has_api_key = has_api_key;
        host.clone_into(&mut endpoint.host);
    }

    assert_eq!(result.len(), builtins().len());
    assert!(result.iter().all(|endpoint| endpoint.api_key.is_empty()));

    Ok(result)
}

fn builtin(seed: &EndpointSeed) -> APIEndpoint {
    assert_ne!(seed.id, "");
    assert_ne!(seed.model, "");

    let transcribe = seed.purpose == APIEndpointPurpose::Transcription;

    APIEndpoint {
        api_key: String::new(),
        api_path_chat: None,
        api_path_transcribe: None,
        has_api_key: false,
        host: String::new(),
        id: seed.id.to_owned(),
        model: seed.model.to_owned(),
        name: seed.name.to_owned(),
        output_tokens_max: None,
        purpose: seed.purpose,
        reasoning_effort: None,
        temperature: None,
        transcribe_chunk_seconds: transcribe.then_some(TRANSCRIBE_CHUNK_SECONDS),
        transcribe_verbose: transcribe.then_some(false),
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::account::test_support::token_saved;
    use crate::workspace::test_support::root_scoped;

    #[test]
    fn an_endpoint_is_builtin_only_when_it_names_the_builtin_address() {
        let [mut endpoint, _] = builtins();

        endpoint.host = "https://elsewhere.test".to_owned();

        assert!(!endpoint_is_builtin(&endpoint));

        endpoint.host = String::new();

        assert!(!endpoint_is_builtin(&endpoint));

        if let Some(builtin) = gateway_host_builtin() {
            endpoint.host = builtin.to_owned();

            assert!(endpoint_is_builtin(&endpoint));

            endpoint.host = format!(" {builtin}/ ");

            assert!(endpoint_is_builtin(&endpoint));

            endpoint.host = format!("{builtin}.evil");

            assert!(!endpoint_is_builtin(&endpoint));
        }
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
    }

    #[test]
    fn an_endpoint_loads_with_the_gateway_and_no_thinking_or_not_at_all() {
        let _root = root_scoped();

        assert_ne!(endpoint_load("unknown").unwrap_err().to_string(), "");

        for id in [ENDPOINT_ID_NOTES, ENDPOINT_ID_TRANSCRIPTION] {
            let loaded = endpoint_load(id);

            let Some(builtin) = gateway_host_builtin() else {
                assert!(loaded.unwrap_err().to_string().contains("no account server"));

                continue;
            };

            let endpoint = loaded.unwrap();

            assert_eq!(endpoint.host, builtin);
            assert!(endpoint_is_builtin(&endpoint));
            assert!(endpoint.reasoning_effort.is_none());
            assert_eq!(endpoint.api_key, "");
            assert!(!endpoint.has_api_key);
        }
    }

    #[test]
    fn the_search_target_is_the_gateway_with_the_pinned_model_or_nothing() {
        let _root = root_scoped();

        assert!(embeddings_target_load().unwrap().is_none());

        let Some(token) = token_saved() else {
            assert!(gateway_host_builtin().is_none());
            assert!(embeddings_target_load().unwrap().is_none());

            return;
        };

        let target = embeddings_target_load().unwrap().unwrap();

        assert_eq!(target.host, gateway_host_builtin().unwrap());
        assert_eq!(target.model, MODEL_EMBEDDINGS);
        assert_eq!(target.api_key, token);
    }

    #[test]
    fn every_listed_endpoint_reports_its_key_without_carrying_it() {
        let _root = root_scoped();
        let endpoints = endpoints_load_all().unwrap();
        let host = gateway_host_builtin().unwrap_or_default();

        assert_eq!(endpoints.len(), 2);

        for endpoint in &endpoints {
            assert_eq!(endpoint.api_key, "");
            assert!(!endpoint.has_api_key);
            assert_eq!(endpoint.host, host);
        }
    }
}
