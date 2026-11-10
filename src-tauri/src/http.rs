use crate::error::{AppError, AppResult};
use futures_util::StreamExt;
use serde::Deserialize;
use serde::de::DeserializeOwned;
use std::future::Future;
use std::sync::LazyLock;
use std::time::Duration;

const RESPONSE_BYTES_MAX: u32 = 8 << 20;
const RESPONSE_CHUNK_COUNT_MAX: u32 = 1 << 20;
pub(crate) const RETRY_ATTEMPTS_MAX: u32 = 3;
const RETRY_BACKOFF_MS_BASE: u64 = 500;
const STATUS_CODE_CEILING: u16 = 1000;
const STATUS_CODE_FIRST: u16 = 100;
const STATUS_CODE_LAST: u16 = 599;
const STATUS_CODE_SERVER_FIRST: u16 = 500;
const STATUS_CODE_TOO_MANY_REQUESTS: u16 = 429;

const _: () = assert!(RETRY_ATTEMPTS_MAX >= 1);
const _: () = assert!(RETRY_BACKOFF_MS_BASE > 0);
const _: () = assert!(RESPONSE_BYTES_MAX > 0);
const _: () = assert!(STATUS_CODE_FIRST < STATUS_CODE_SERVER_FIRST);
const _: () = assert!(STATUS_CODE_SERVER_FIRST <= STATUS_CODE_LAST);
const _: () = assert!(STATUS_CODE_LAST < STATUS_CODE_CEILING);

pub(crate) type ClientCell = LazyLock<Result<reqwest::Client, String>>;

#[derive(Debug, Clone, Copy)]
pub(crate) struct ClientTimeouts {
    pub(crate) connect: Duration,
    pub(crate) read: Option<Duration>,
    pub(crate) request: Duration,
}

#[derive(Deserialize)]
struct OpenAIError {
    #[serde(default)]
    message: Option<String>,
    #[serde(default)]
    code: Option<String>,
    #[serde(default, rename = "type")]
    kind: Option<String>,
}

#[derive(Deserialize)]
struct OpenAIErrorEnvelope {
    error: OpenAIError,
}

pub(crate) fn api_status_code(message: &str) -> Option<u16> {
    let head = message.split(':').next()?.trim();
    let code = head.split_whitespace().next()?.parse::<u16>().ok()?;

    if !(STATUS_CODE_FIRST..=STATUS_CODE_LAST).contains(&code) {
        return None;
    }

    assert!(code >= STATUS_CODE_FIRST);
    assert!(code <= STATUS_CODE_LAST);

    Some(code)
}

pub(crate) fn client_build(timeouts: &ClientTimeouts) -> Result<reqwest::Client, String> {
    assert!(!timeouts.connect.is_zero());
    assert!(!timeouts.request.is_zero());

    crypto_provider_install();

    let mut builder =
        reqwest::Client::builder().timeout(timeouts.request).connect_timeout(timeouts.connect);

    if let Some(read) = timeouts.read {
        assert!(read < timeouts.request);

        builder = builder.read_timeout(read);
    }

    builder.build().map_err(|error| format!("the http client could not be built: {error}"))
}

pub(crate) fn client_get(cell: &'static ClientCell) -> AppResult<&'static reqwest::Client> {
    cell.as_ref().map_err(|message| AppError::Config(message.clone()))
}

pub(crate) async fn response_ensure_ok(
    response: reqwest::Response,
    label: &str,
) -> AppResult<reqwest::Response> {
    if response.status().is_success() {
        return Ok(response);
    }

    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    let message_friendly = body_error_friendly(&body).unwrap_or(body);
    let message = format!("{} {label}: {message_friendly}", status.as_u16());

    Err(AppError::Service(message))
}

pub(crate) async fn response_json_bounded<T: DeserializeOwned>(
    response: reqwest::Response,
) -> AppResult<T> {
    let declared =
        response.content_length().filter(|length| *length > u64::from(RESPONSE_BYTES_MAX));

    if let Some(length) = declared {
        return Err(AppError::Service(format!(
            "the response is {length} bytes, over the {RESPONSE_BYTES_MAX} bytes this app reads",
        )));
    }

    let body_bytes_max = usize::try_from(RESPONSE_BYTES_MAX).unwrap_or(usize::MAX);
    let mut body: Vec<u8> = Vec::new();
    let mut stream = response.bytes_stream();

    for _chunk_index in 0..RESPONSE_CHUNK_COUNT_MAX {
        let Some(chunk) = stream.next().await else {
            return Ok(serde_json::from_slice(&body)?);
        };

        let bytes = chunk?;

        if body.len() + bytes.len() > body_bytes_max {
            return Err(AppError::Service(format!(
                "the response ran past the {RESPONSE_BYTES_MAX} bytes this app reads",
            )));
        }

        body.extend_from_slice(&bytes);
    }

    Err(AppError::Service(format!(
        "the response arrived in more than {RESPONSE_CHUNK_COUNT_MAX} pieces without ending",
    )))
}

pub(crate) fn retry_is_transient(error: &AppError) -> bool {
    match error {
        AppError::Network(network) => {
            if network.is_timeout() {
                return true;
            }

            if network.is_connect() {
                return true;
            }

            if network.is_request() {
                return true;
            }

            network.status().is_some_and(|status| status_is_transient(status.as_u16()))
        }
        AppError::Service(message) => api_status_code(message).is_some_and(status_is_transient),
        AppError::Audio(_)
        | AppError::Config(_)
        | AppError::Export(_)
        | AppError::IO(_)
        | AppError::Serde(_)
        | AppError::Task(_)
        | AppError::Transcription(_) => false,
    }
}

pub(crate) async fn retry_run<T, Attempt, Work>(attempt_run: Attempt) -> AppResult<T>
where
    Attempt: Fn() -> Work,
    Work: Future<Output = AppResult<T>>,
{
    for attempt in 0..RETRY_ATTEMPTS_MAX - 1 {
        let error = match attempt_run().await {
            Ok(value) => return Ok(value),
            Err(error) => error,
        };

        if !retry_is_transient(&error) {
            return Err(error);
        }

        let delay = retry_delay(attempt);

        tracing::warn!(
            target: "scribe_lib::http",
            "retry attempt {} after {}ms: {}",
            attempt + 1,
            delay.as_millis(),
            error,
        );

        tokio::time::sleep(delay).await;
    }

    attempt_run().await
}

fn body_error_friendly(body: &str) -> Option<String> {
    let parsed: OpenAIErrorEnvelope = serde_json::from_str(body).ok()?;
    let message = parsed.error.message.unwrap_or_default();

    if message.is_empty() {
        return None;
    }

    if let Some(code) = parsed.error.code.filter(|code| !code.is_empty()) {
        return Some(format!("{message} ({code})"));
    }

    if let Some(kind) = parsed.error.kind.filter(|kind| !kind.is_empty()) {
        return Some(format!("{message} ({kind})"));
    }

    Some(message)
}

fn crypto_provider_install() {
    if rustls::crypto::CryptoProvider::get_default().is_some() {
        return;
    }

    let installed = rustls::crypto::ring::default_provider().install_default();

    if let Err(existing) = installed {
        tracing::debug!(
            target: "scribe_lib::http",
            "a crypto provider was already installed: {existing:?}",
        );
    }

    assert!(rustls::crypto::CryptoProvider::get_default().is_some());
}

fn retry_delay(attempt: u32) -> Duration {
    assert!(attempt + 1 < RETRY_ATTEMPTS_MAX);

    let delay_ms = RETRY_BACKOFF_MS_BASE << attempt;

    assert!(delay_ms >= RETRY_BACKOFF_MS_BASE);

    Duration::from_millis(delay_ms)
}

const fn status_is_transient(code: u16) -> bool {
    assert!(code < STATUS_CODE_CEILING);

    if code == STATUS_CODE_TOO_MANY_REQUESTS {
        return true;
    }

    code >= STATUS_CODE_SERVER_FIRST && code <= STATUS_CODE_LAST
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    #[test]
    fn a_status_code_is_read_from_the_head_of_the_message_within_the_real_range() {
        assert_eq!(api_status_code("100"), Some(100));
        assert_eq!(api_status_code("599 model list: down"), Some(599));
        assert_eq!(api_status_code("  429 chat completion: slow"), Some(429));
        assert_eq!(api_status_code("99 too low"), None);
        assert_eq!(api_status_code("600 too high"), None);
        assert_eq!(api_status_code(""), None);
        assert_eq!(api_status_code("boom: 500"), None);
    }

    #[test]
    fn the_transient_range_starts_at_the_first_server_error_and_ends_at_the_last_status() {
        assert!(!status_is_transient(499));
        assert!(status_is_transient(500));
        assert!(status_is_transient(599));
        assert!(!status_is_transient(600));
        assert!(!status_is_transient(428));
        assert!(!status_is_transient(430));
    }

    #[test]
    fn an_error_body_falls_back_to_its_type_and_then_to_the_bare_message() {
        let typed = r#"{"error":{"message":"bad","code":"","type":"invalid_request_error"}}"#;
        let coded = r#"{"error":{"message":"bad","code":"c","type":"t"}}"#;

        assert_eq!(body_error_friendly(typed), Some("bad (invalid_request_error)".to_owned()));
        assert_eq!(body_error_friendly(coded), Some("bad (c)".to_owned()));
        assert_eq!(body_error_friendly(r#"{"error":{"message":"bad"}}"#), Some("bad".to_owned()));

        assert_eq!(
            body_error_friendly("{\"error\":{\"message\":\"\u{e9} \u{fc}\"}}"),
            Some("\u{e9} \u{fc}".to_owned()),
        );

        assert_eq!(body_error_friendly(r#"{"message":"bad"}"#), None);
        assert_eq!(body_error_friendly(""), None);
    }

    #[test]
    fn a_status_code_past_the_known_range_is_a_plain_failure_and_never_a_crash() {
        let message = "700 chat completion: odd";

        assert_eq!(api_status_code(message), None);
        assert!(!retry_is_transient(&AppError::Service(message.into())));
        assert!(!status_is_transient(999));
    }

    #[test]
    fn errors_other_than_network_and_api_are_never_retried() {
        let serde_error = serde_json::from_str::<u8>("x").unwrap_err();

        assert!(!retry_is_transient(&AppError::Serde(serde_error)));
        assert!(!retry_is_transient(&AppError::IO(std::io::Error::other("disk"))));
        assert!(!retry_is_transient(&AppError::Service("timed out without a status".into())));
        assert!(retry_is_transient(&AppError::Service("503 chat completion: busy".into())));
    }

    #[test]
    fn a_client_is_built_without_a_read_timeout_too() {
        let timeouts = ClientTimeouts {
            connect: Duration::from_secs(1),
            read: None,
            request: Duration::from_secs(3),
        };

        drop(client_build(&timeouts).unwrap());
    }

    #[tokio::test]
    async fn a_permanent_failure_is_returned_after_one_attempt() {
        let attempts = AtomicU32::new(0);

        let result: AppResult<()> = retry_run(|| async {
            let _previous = attempts.fetch_add(1, Ordering::SeqCst);

            Err(AppError::Service("400 chat completion: bad".into()))
        })
        .await;

        assert!(result.is_err());
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn a_transient_failure_is_retried_until_it_succeeds() {
        let attempts = AtomicU32::new(0);

        let recovered: AppResult<u32> = retry_run(|| async {
            let attempt = attempts.fetch_add(1, Ordering::SeqCst) + 1;

            if attempt < 2 {
                return Err(AppError::Service("503 chat completion: busy".into()));
            }

            Ok(attempt)
        })
        .await;

        assert_eq!(recovered.unwrap(), 2);
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn a_transient_failure_gives_up_after_the_last_attempt() {
        let attempts = AtomicU32::new(0);

        let result: AppResult<()> = retry_run(|| async {
            let _previous = attempts.fetch_add(1, Ordering::SeqCst);

            Err(AppError::Service("503 chat completion: busy".into()))
        })
        .await;

        assert!(result.is_err());
        assert_eq!(attempts.load(Ordering::SeqCst), RETRY_ATTEMPTS_MAX);
    }

    #[test]
    fn only_server_side_and_throttled_statuses_are_transient() {
        assert!(status_is_transient(429));
        assert!(status_is_transient(503));
        assert!(!status_is_transient(400));
        assert!(!status_is_transient(404));

        assert!(retry_is_transient(&AppError::Service("429: slow down".into())));
        assert!(!retry_is_transient(&AppError::Service("400: bad request".into())));
        assert!(!retry_is_transient(&AppError::Config("nope".into())));
    }

    #[test]
    fn a_status_code_is_read_only_from_a_real_status_range() {
        assert_eq!(api_status_code("500 remote transcribe: boom"), Some(500));
        assert_eq!(api_status_code("12345 not a status"), None);
        assert_eq!(api_status_code("no digits here"), None);
    }

    #[test]
    fn an_error_body_is_reported_with_its_code_when_it_carries_one() {
        let body = r#"{"error":{"message":"no key","code":"invalid_api_key"}}"#;

        assert_eq!(body_error_friendly(body), Some("no key (invalid_api_key)".to_owned()));
        assert_eq!(body_error_friendly(r#"{"error":{"message":""}}"#), None);
        assert_eq!(body_error_friendly("not json at all"), None);
    }

    #[test]
    fn a_client_is_built_with_the_timeouts_it_was_given() {
        let timeouts = ClientTimeouts {
            connect: Duration::from_secs(1),
            read: Some(Duration::from_secs(2)),
            request: Duration::from_secs(3),
        };

        drop(client_build(&timeouts).unwrap());
    }
}
