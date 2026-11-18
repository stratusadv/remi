use crate::error::{AppError, AppResult};
use futures_util::StreamExt;
use serde::Deserialize;
use serde::de::DeserializeOwned;
use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::sync::LazyLock;
use std::time::Duration;

const BODY_EXCERPT_CHARS_MAX: u32 = 2048;
const RESPONSE_BYTES_MAX: u32 = 8 << 20;
const RESPONSE_CHUNK_COUNT_MAX: u32 = 1 << 20;
pub(crate) const RETRY_ATTEMPTS_LIMIT: u32 = 16;
pub(crate) const RETRY_ATTEMPTS_MAX: u32 = 3;
const RETRY_BACKOFF_DOUBLINGS_MAX: u32 = 3;
const RETRY_BACKOFF_MS_BASE: u64 = 500;

pub(crate) const RETRY_BUDGET_DEFAULT: RetryBudget =
    RetryBudget { attempts_max: RETRY_ATTEMPTS_MAX, backoff_ms_base: RETRY_BACKOFF_MS_BASE };

const STATUS_CODE_CEILING: u16 = 1000;
const STATUS_CODE_FIRST: u16 = 100;
const STATUS_CODE_LAST: u16 = 599;
const STATUS_CODE_SERVER_FIRST: u16 = 500;
const STATUS_CODE_TOO_MANY_REQUESTS: u16 = 429;

const _: () = assert!(BODY_EXCERPT_CHARS_MAX > 0);
const _: () = assert!(RETRY_ATTEMPTS_MAX >= 1);
const _: () = assert!(RETRY_ATTEMPTS_MAX <= RETRY_ATTEMPTS_LIMIT);
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
    code: Option<String>,
    #[serde(default, rename = "type")]
    kind: Option<String>,
    #[serde(default)]
    message: Option<String>,
}

#[derive(Deserialize)]
struct OpenAIErrorEnvelope {
    error: OpenAIError,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct ReplyFailed<'reply> {
    pub(crate) body: &'reply str,
    pub(crate) label: &'reply str,
    pub(crate) status: reqwest::StatusCode,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct RetryBudget {
    pub(crate) attempts_max: u32,
    pub(crate) backoff_ms_base: u64,
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

pub(crate) fn body_error_absent_message(reply: &ReplyFailed<'_>) -> String {
    assert!(!reply.status.is_success());
    assert_ne!(reply.label, "");

    let excerpt: String = reply.body.chars().take(usize_of!(BODY_EXCERPT_CHARS_MAX)).collect();

    tracing::warn!(
        target: "remi_lib::http",
        "{} failed with {} and a body that is not an error envelope: {excerpt:?}",
        reply.label,
        reply.status.as_u16(),
    );

    let reason = reply.status.canonical_reason().unwrap_or("unexpected status").to_lowercase();

    if reply.status.is_server_error() {
        return format!("The server ran into a problem ({reason}). Try again in a few minutes.");
    }

    format!("The server refused the request ({reason}).")
}

pub(crate) fn body_error_message(body: &str) -> Option<String> {
    let parsed: OpenAIErrorEnvelope = serde_json::from_str(body).ok()?;

    parsed.error.message.filter(|message| !message.trim().is_empty())
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
    cell.as_ref().map_err(|message| AppError::Internal(message.clone()))
}

pub(crate) fn crypto_provider_install() {
    if rustls::crypto::CryptoProvider::get_default().is_some() {
        return;
    }

    let installed = rustls::crypto::ring::default_provider().install_default();

    if let Err(existing) = installed {
        tracing::debug!(
            target: "remi_lib::http",
            "a crypto provider was already installed: {existing:?}",
        );
    }

    assert!(rustls::crypto::CryptoProvider::get_default().is_some());
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
    let reply = ReplyFailed { body: &body, label, status };

    let message_friendly =
        body_error_friendly(&body).unwrap_or_else(|| body_error_absent_message(&reply));

    let message = format!("{} {label}: {message_friendly}", status.as_u16());

    Err(AppError::Service(message))
}

pub(crate) async fn response_json_bounded<T: DeserializeOwned>(
    response: reqwest::Response,
) -> AppResult<T> {
    let declared =
        response.content_length().filter(|length| *length > u64::from(RESPONSE_BYTES_MAX));

    if let Some(length) = declared {
        return Err(AppError::Internal(format!(
            "the response is {length} bytes, over the {RESPONSE_BYTES_MAX} bytes this app reads",
        )));
    }

    let body_bytes_max = usize::try_from(RESPONSE_BYTES_MAX).unwrap_or(usize::MAX);
    let mut body: Vec<u8> = Vec::new();
    let mut stream = response.bytes_stream();

    for _chunk_index in 0..RESPONSE_CHUNK_COUNT_MAX {
        let Some(chunk) = stream.next().await else {
            return body_parse(&body);
        };

        let bytes = chunk?;

        if body.len() + bytes.len() > body_bytes_max {
            return Err(AppError::Internal(format!(
                "the response ran past the {RESPONSE_BYTES_MAX} bytes this app reads",
            )));
        }

        body.extend_from_slice(&bytes);
    }

    Err(AppError::Internal(format!(
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
        | AppError::Index(_)
        | AppError::Internal(_)
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
    retry_run_budgeted(&RETRY_BUDGET_DEFAULT, attempt_run).await
}

pub(crate) async fn retry_run_budgeted<T, Attempt, Work>(
    budget: &RetryBudget,
    attempt_run: Attempt,
) -> AppResult<T>
where
    Attempt: Fn() -> Work,
    Work: Future<Output = AppResult<T>>,
{
    for attempt in 0..retry_count_max(budget) {
        let error = match attempt_run().await {
            Ok(value) => return Ok(value),
            Err(error) => error,
        };

        if !retry_is_transient(&error) {
            return Err(error);
        }

        let delay = retry_delay(budget, attempt);

        tracing::warn!(
            target: "remi_lib::http",
            "retry attempt {} after {}ms: {}",
            attempt + 1,
            delay.as_millis(),
            error,
        );

        tokio::time::sleep(delay).await;
    }

    attempt_run().await
}

pub(crate) const fn status_is_transient(code: u16) -> bool {
    assert!(code < STATUS_CODE_CEILING);

    if code == STATUS_CODE_TOO_MANY_REQUESTS {
        return true;
    }

    code >= STATUS_CODE_SERVER_FIRST && code <= STATUS_CODE_LAST
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

fn body_parse<T: DeserializeOwned>(body: &[u8]) -> AppResult<T> {
    let text = String::from_utf8_lossy(body);

    if let Some(message) = body_error_message(&text) {
        return Err(AppError::Service(message));
    }

    Ok(serde_json::from_slice(body)?)
}

fn retry_count_max(budget: &RetryBudget) -> u32 {
    assert!(budget.attempts_max >= 1);
    assert!(budget.attempts_max <= RETRY_ATTEMPTS_LIMIT);

    budget.attempts_max - 1
}

fn retry_delay(budget: &RetryBudget, attempt: u32) -> Duration {
    assert!(attempt + 1 < budget.attempts_max);
    assert!(budget.backoff_ms_base > 0);

    let ceiling_ms = budget.backoff_ms_base << attempt.min(RETRY_BACKOFF_DOUBLINGS_MAX);
    let floor_ms = ceiling_ms.div_euclid(2);
    let delay_ms = floor_ms + retry_jitter_ms(ceiling_ms - floor_ms);

    assert!(delay_ms >= floor_ms);
    assert!(delay_ms <= ceiling_ms);

    Duration::from_millis(delay_ms)
}

fn retry_jitter_ms(span_ms: u64) -> u64 {
    assert!(span_ms > 0);

    let random = RandomState::new().build_hasher().finish();
    let jitter_ms = random % span_ms.saturating_add(1);

    assert!(jitter_ms <= span_ms);

    jitter_ms
}

#[cfg(test)]
pub(crate) mod test_support {
    use tokio::io::AsyncReadExt;
    use tokio::net::TcpStream;

    const REQUEST_READS_MAX: u32 = 64;

    fn request_complete(received: &[u8]) -> bool {
        let text = String::from_utf8_lossy(received);

        let Some((head, body)) = text.split_once("\r\n\r\n") else {
            return false;
        };

        let length = head
            .lines()
            .find_map(|line| {
                line.to_ascii_lowercase().strip_prefix("content-length:").map(str::to_owned)
            })
            .map_or(0, |value| value.trim().parse::<usize>().unwrap());

        body.len() >= length
    }

    pub(crate) async fn request_read(stream: &mut TcpStream) -> String {
        let mut received: Vec<u8> = Vec::new();
        let mut block = [0_u8; 4096];

        for _read_index in 0..REQUEST_READS_MAX {
            let read = stream.read(&mut block).await.unwrap();

            assert_ne!(read, 0);

            received.extend_from_slice(&block[..read]);

            if request_complete(&received) {
                return String::from_utf8(received).unwrap();
            }
        }

        panic!("the request did not end within {REQUEST_READS_MAX} reads");
    }
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
    fn a_reply_padded_with_whitespace_parses_and_an_error_envelope_comes_back_as_its_message() {
        let padded = b"\n\n\n{\"choices\": [{\"message\": {\"content\": \"Budget review\"}}]}";
        let envelope = b"\n{\"error\": {\"message\": \"overloaded\"}}";
        let trimmed = padded.trim_ascii_start();
        let parsed: serde_json::Value = body_parse(padded).unwrap();
        let expected: serde_json::Value = serde_json::from_slice(trimmed).unwrap();
        let failure = body_parse::<serde_json::Value>(envelope);
        let garbled = body_parse::<serde_json::Value>(b"\n\nnot json");

        assert_eq!(parsed, expected);
        assert!(matches!(&failure, Err(AppError::Service(message)) if message == "overloaded"));
        assert!(matches!(garbled, Err(AppError::Serde(_))));
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

    #[tokio::test]
    async fn a_larger_budget_makes_each_of_its_attempts_before_giving_up() {
        let attempts = AtomicU32::new(0);
        let budget = RetryBudget { attempts_max: 7, backoff_ms_base: 1 };

        let result: AppResult<()> = retry_run_budgeted(&budget, || async {
            let _previous = attempts.fetch_add(1, Ordering::SeqCst);

            Err(AppError::Service("503 remote transcribe: down".into()))
        })
        .await;

        assert!(result.is_err());
        assert_eq!(attempts.load(Ordering::SeqCst), budget.attempts_max);
    }

    #[test]
    fn each_retry_waits_between_half_and_all_of_its_capped_backoff() {
        let budget = RetryBudget { attempts_max: 9, backoff_ms_base: 500 };

        for attempt in 0..budget.attempts_max - 1 {
            let doubled = 500_u64 * 2_u64.pow(attempt.min(3));
            let ceiling_ms = doubled.min(4_000);
            let ceiling = Duration::from_millis(ceiling_ms);
            let floor = Duration::from_millis(ceiling_ms.div_euclid(2));

            for _draw in 0_u32..64 {
                let delay = retry_delay(&budget, attempt);

                assert!(delay >= floor, "{attempt}: {delay:?}");
                assert!(delay <= ceiling, "{attempt}: {delay:?}");
            }
        }
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
