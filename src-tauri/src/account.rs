use crate::blocking;
use crate::contract::{CheckoutSessionID, PromoCode, SignInCode, TextRaw};
use crate::endpoints::storage::{ENDPOINT_ID_TRANSCRIPTION, api_key_builtin_used};
use crate::error::{AppError, AppResult};
use crate::http::{
    ClientCell,
    ClientTimeouts,
    body_error_message,
    client_build,
    client_get,
    response_ensure_ok,
    response_json_bounded,
    retry_run,
    status_is_transient,
};
use crate::secrets::{protected_read, protected_write};
use crate::stripe_tls;
use crate::workspace::{self, AUDIO_SECONDS_MAX};
use num_traits::ToPrimitive;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::num::NonZeroU32;
use std::path::Path;
use std::sync::LazyLock;
use std::time::Duration;
use tauri::WebviewWindow;

const ACCOUNT_HOST_BUILTIN: Option<&str> = option_env!("REMI_ACCOUNT_HOST");
const CHARGE_SECONDS_MAX: u64 = 21_600;
const CHECKOUT_HOURS_MAX: u32 = 10_000;
const CHECKOUT_KEY_PREFIXES: [&str; 2] = ["pk_live_", "pk_test_"];
const CHECKOUT_SECRET_SEPARATOR: &str = "_secret_";
const CHECKOUT_SESSION_ID_PREFIX: &str = "cs_";
const CHECKOUT_TEXT_CHARS_MAX: u32 = 2048;
const CONNECT_TIMEOUT_SECONDS: u64 = 10;

const HTTP_TIMEOUTS: ClientTimeouts = ClientTimeouts {
    connect: Duration::from_secs(CONNECT_TIMEOUT_SECONDS),
    read: None,
    request: Duration::from_secs(REQUEST_TIMEOUT_SECONDS),
};

const LABEL_ACCOUNT: &str = "account";
const LABEL_CHARGE: &str = "transcription charge";
const LABEL_CHECKOUT: &str = "checkout";
const LABEL_CHECKOUT_FINISH: &str = "checkout confirmation";
const LABEL_PROMO: &str = "promo code";
const LABEL_SIGN_UP: &str = "account sign-up";
const MESSAGE_CHECKOUT_HOURS: &str = "That pack of hours is not on offer.";
const MESSAGE_CHECKOUT_MALFORMED: &str = "the account server sent a checkout Remi cannot open";
const MESSAGE_CHECKOUT_UNKNOWN: &str = "That is not a checkout this copy of Remi started.";
const MESSAGE_CODE_INVALID: &str = "That sign-in code is not valid.";
const MESSAGE_KEY_MALFORMED: &str =
    "the account server sent a Stripe key that is not a publishable key";
const MESSAGE_SIGNED_OUT: &str = "This copy of Remi is not signed in to an account.";
const PATH_ACCOUNT: &str = "/api/v1/account/";
const PATH_CHARGE: &str = "/api/v1/account/charge/";
const PATH_CHECKOUT: &str = "/api/v1/account/checkout/";
const PATH_CHECKOUT_FINISH: &str = "/api/v1/account/checkout/finish/";
const PATH_PROMO: &str = "/api/v1/account/promo/";
const REQUEST_TIMEOUT_SECONDS: u64 = 30;
const STATUS_UNAUTHORIZED: u16 = 401;
const TOKEN_CHARS_MAX: u32 = 256;
const TOKEN_FILE: &str = "account_token.bin";

const _: () = assert!(AUDIO_SECONDS_MAX <= CHARGE_SECONDS_MAX);
const _: () = assert!(CONNECT_TIMEOUT_SECONDS < REQUEST_TIMEOUT_SECONDS);

static HTTP_CLIENT: ClientCell = LazyLock::new(|| client_build(&HTTP_TIMEOUTS));

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct Account {
    balance_seconds: i64,
    email: String,
    name: String,
    offers: Vec<Offer>,
    payments: bool,
    publishable_key: PublishableKey,
}

#[derive(Debug, Deserialize)]
struct AccountCreated {
    account: Account,
    token: String,
}

#[derive(Debug, Deserialize, Serialize)]
pub(crate) struct AccountSignUp {
    email: String,
    name: String,
    promo_code: String,
}

#[derive(Clone, Copy, Debug, Serialize)]
pub(crate) struct AccountStatus {
    billing: bool,
    signed_in: bool,
}

#[derive(Clone, Copy, Debug)]
struct Call<'call> {
    host: &'call str,
    label: &'static str,
    path: &'static str,
    token: Option<&'call str>,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct ChargeJob<'job> {
    pub(crate) audio_path: &'job Path,
    pub(crate) endpoint_id: &'job str,
    pub(crate) job_id: &'job str,
}

#[derive(Clone, Copy, Debug, Serialize)]
struct ChargeRequest<'job> {
    job_id: &'job str,
    seconds: u64,
}

#[derive(Clone, Copy, Debug, Serialize)]
struct CheckoutFinishRequest<'session> {
    session_id: &'session str,
}

#[derive(Debug, Deserialize, Serialize)]
pub(crate) struct CheckoutFinished {
    account: Account,
    paid: bool,
}

#[derive(Debug, Deserialize, Serialize)]
pub(crate) struct CheckoutStarted {
    client_secret: String,
    session_id: String,
}

#[derive(Clone, Copy, Debug, Serialize)]
struct CheckoutStartRequest {
    hours: NonZeroU32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct Offer {
    currency: String,
    hours: u32,
    price_cents: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(try_from = "TextRaw")]
struct PublishableKey(String);

#[derive(Clone, Copy, Debug, Serialize)]
struct PromoRequest<'code> {
    code: &'code str,
}

#[derive(Clone, Copy, Debug)]
struct Session<'session> {
    host: &'session str,
    token: &'session str,
}

#[derive(Debug, Deserialize, Serialize)]
struct TokenStored {
    host: String,
    token: String,
}

#[tauri::command(rename_all = "snake_case")]
pub(crate) async fn account_checkout_finish(
    session_id: CheckoutSessionID,
) -> AppResult<CheckoutFinished> {
    if !checkout_session_id_is_valid(&session_id) {
        return Err(AppError::Config(MESSAGE_CHECKOUT_UNKNOWN.into()));
    }

    let host = host_required()?;
    let token = token_required(host).await?;
    let request = CheckoutFinishRequest { session_id: &session_id };

    let call = Call {
        host,
        label: LABEL_CHECKOUT_FINISH,
        path: PATH_CHECKOUT_FINISH,
        token: Some(&token),
    };

    retry_run(|| call_post(&call, &request)).await
}

#[tauri::command(rename_all = "snake_case")]
pub(crate) async fn account_checkout_start(
    window: WebviewWindow,
    hours: NonZeroU32,
) -> AppResult<CheckoutStarted> {
    if !checkout_hours_is_valid(hours) {
        return Err(AppError::Config(MESSAGE_CHECKOUT_HOURS.into()));
    }

    let host = host_required()?;
    let token = token_required(host).await?;
    let call = Call { host, label: LABEL_CHECKOUT, path: PATH_CHECKOUT, token: Some(&token) };
    let body = CheckoutStartRequest { hours };
    let allowing = stripe_tls::api_certificate_allow(&window);
    let starting = retry_run(|| call_post::<_, CheckoutStarted>(&call, &body));
    let (allowed, created) = tokio::join!(allowing, starting);

    if let Err(error) = allowed {
        tracing::warn!(
            target: "remi_lib::account",
            "Stripe's API certificate was not allowed: {error}",
        );
    }

    let started = created?;

    if !checkout_started_is_valid(&started) {
        return Err(AppError::Service(MESSAGE_CHECKOUT_MALFORMED.into()));
    }

    assert!(started.client_secret.starts_with(started.session_id.as_str()));

    Ok(started)
}

#[tauri::command]
pub(crate) async fn account_code_get() -> AppResult<Option<String>> {
    let host = host_required()?;

    blocking::run(move || token_load(host)).await
}

#[tauri::command(rename_all = "snake_case")]
pub(crate) async fn account_create(sign_up: AccountSignUp) -> AppResult<Account> {
    let host = host_required()?;
    let call = Call { host, label: LABEL_SIGN_UP, path: PATH_ACCOUNT, token: None };
    let created: AccountCreated = call_post(&call, &sign_up).await?;

    if !token_is_valid(&created.token) {
        return Err(AppError::Service(format!(
            "the account server sent a malformed token of {} characters",
            created.token.len(),
        )));
    }

    let token = created.token;

    blocking::run(move || token_save(&Session { host, token: &token })).await?;

    Ok(created.account)
}

#[tauri::command]
pub(crate) async fn account_get() -> AppResult<Option<Account>> {
    let host = host_required()?;

    let Some(token) = blocking::run(move || token_load(host)).await? else {
        return Ok(None);
    };

    let session = Session { host, token: &token };

    retry_run(|| account_fetch(&session)).await
}

#[tauri::command(rename_all = "snake_case")]
pub(crate) async fn account_promo_redeem(code: PromoCode) -> AppResult<Account> {
    let host = host_required()?;
    let token = token_required(host).await?;
    let call = Call { host, label: LABEL_PROMO, path: PATH_PROMO, token: Some(&token) };
    let request = PromoRequest { code: code.trim() };

    call_post(&call, &request).await
}

#[tauri::command(rename_all = "snake_case")]
pub(crate) async fn account_sign_in(code: SignInCode) -> AppResult<Account> {
    let host = host_required()?;
    let token = code.trim().to_owned();

    if !token_is_valid(&token) {
        return Err(AppError::Config(MESSAGE_CODE_INVALID.into()));
    }

    let session = Session { host, token: &token };

    let account = retry_run(|| account_fetch(&session))
        .await?
        .ok_or_else(|| AppError::Config(MESSAGE_CODE_INVALID.into()))?;

    blocking::run(move || token_save(&Session { host, token: &token })).await?;

    Ok(account)
}

#[tauri::command]
pub(crate) async fn account_status() -> AppResult<AccountStatus> {
    blocking::run(status_load).await
}

pub(crate) async fn charge_apply(job: &ChargeJob<'_>) -> AppResult<()> {
    let endpoint_id = job.endpoint_id.to_owned();

    let Some(host) = blocking::run(move || billing_host(&endpoint_id)).await? else {
        return Ok(());
    };

    let token = token_required(host).await?;
    let audio_path = job.audio_path.to_path_buf();

    let duration_seconds =
        blocking::run(move || workspace::audio_wav_duration_seconds(&audio_path)).await?;

    let request = ChargeRequest { job_id: job.job_id, seconds: charge_seconds(duration_seconds)? };

    charge_send(&Session { host, token: &token }, &request).await
}

async fn account_fetch(session: &Session<'_>) -> AppResult<Option<Account>> {
    let call = Call {
        host: session.host,
        label: LABEL_ACCOUNT,
        path: PATH_ACCOUNT,
        token: Some(session.token),
    };

    let client = client_get(&HTTP_CLIENT)?;
    let sent = client.get(call_url(&call)).bearer_auth(session.token).send().await?;

    if sent.status().as_u16() == STATUS_UNAUTHORIZED {
        return Ok(None);
    }

    let response = reply_ensure_ok(sent, call.label).await?;

    Ok(Some(response_json_bounded(response).await?))
}

fn billing_host(endpoint_id: &str) -> AppResult<Option<&'static str>> {
    let Some(host) = host_builtin() else {
        return Ok(None);
    };

    if !api_key_builtin_used(endpoint_id)? {
        return Ok(None);
    }

    assert_ne!(host, "");
    assert!(!host.ends_with('/'));

    Ok(Some(host))
}

async fn call_post<Body, Reply>(call: &Call<'_>, body: &Body) -> AppResult<Reply>
where
    Body: Serialize + Sync,
    Reply: DeserializeOwned + Send,
{
    let client = client_get(&HTTP_CLIENT)?;
    let mut request = client.post(call_url(call)).json(body);

    if let Some(token) = call.token {
        request = request.bearer_auth(token);
    }

    let sent = request.send().await?;
    let response = reply_ensure_ok(sent, call.label).await?;

    response_json_bounded(response).await
}

fn call_url(call: &Call<'_>) -> String {
    assert!(call.path.starts_with('/'));
    assert!(!call.host.ends_with('/'));
    assert!(call.token.is_none_or(token_is_valid));

    format!("{}{}", call.host, call.path)
}

fn charge_seconds(duration_seconds: f64) -> AppResult<u64> {
    assert!(duration_seconds.is_finite());
    assert!(duration_seconds >= 0.0_f64);

    let seconds = duration_seconds.ceil().to_u64().unwrap_or(0);

    if (1..=CHARGE_SECONDS_MAX).contains(&seconds) {
        return Ok(seconds);
    }

    Err(AppError::Audio(format!(
        "the prepared audio runs {duration_seconds} seconds, outside the 1 to \
         {CHARGE_SECONDS_MAX} seconds one transcription covers",
    )))
}

async fn charge_send(session: &Session<'_>, request: &ChargeRequest<'_>) -> AppResult<()> {
    let call = Call {
        host: session.host,
        label: LABEL_CHARGE,
        path: PATH_CHARGE,
        token: Some(session.token),
    };

    let _charged: Account = retry_run(|| call_post(&call, request)).await?;

    Ok(())
}

const fn checkout_hours_is_valid(hours: NonZeroU32) -> bool {
    hours.get() <= CHECKOUT_HOURS_MAX
}

fn checkout_key_is_valid(key: &str) -> bool {
    let body = CHECKOUT_KEY_PREFIXES.iter().find_map(|prefix| key.strip_prefix(prefix));

    if key.len() > usize_of!(CHECKOUT_TEXT_CHARS_MAX) {
        return false;
    }

    let Some(text) = body else {
        return false;
    };

    !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_alphanumeric())
}

fn checkout_session_id_is_valid(session_id: &str) -> bool {
    let Some(body) = session_id.strip_prefix(CHECKOUT_SESSION_ID_PREFIX) else {
        return false;
    };

    if session_id.len() > usize_of!(CHECKOUT_TEXT_CHARS_MAX) {
        return false;
    }

    !body.is_empty() && body.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

fn checkout_started_is_valid(started: &CheckoutStarted) -> bool {
    if !checkout_session_id_is_valid(&started.session_id) {
        return false;
    }

    if started.client_secret.len() > usize_of!(CHECKOUT_TEXT_CHARS_MAX) {
        return false;
    }

    let Some(rest) = started.client_secret.strip_prefix(started.session_id.as_str()) else {
        return false;
    };

    let Some(secret) = rest.strip_prefix(CHECKOUT_SECRET_SEPARATOR) else {
        return false;
    };

    !secret.is_empty() && secret.bytes().all(|byte| byte.is_ascii_graphic())
}

fn host_builtin() -> Option<&'static str> {
    host_clean(ACCOUNT_HOST_BUILTIN)
}

fn host_clean(host: Option<&str>) -> Option<&str> {
    let cleaned =
        host.map(|text| text.trim().trim_end_matches('/')).filter(|text| !text.is_empty());

    if let Some(text) = cleaned {
        assert!(!text.ends_with('/'));
        assert_eq!(text, text.trim());
    }

    cleaned
}

fn host_required() -> AppResult<&'static str> {
    host_builtin()
        .ok_or_else(|| AppError::Config("This build of Remi has no account server.".into()))
}

async fn reply_ensure_ok(response: reqwest::Response, label: &str) -> AppResult<reqwest::Response> {
    let status = response.status();

    if !status.is_client_error() {
        return response_ensure_ok(response, label).await;
    }

    if status_is_transient(status.as_u16()) {
        return response_ensure_ok(response, label).await;
    }

    let body = response.text().await.unwrap_or_default();

    let message =
        body_error_message(&body).unwrap_or_else(|| format!("{} {label}: {body}", status.as_u16()));

    Err(AppError::Service(message))
}

fn status_load() -> AppResult<AccountStatus> {
    let Some(host) = billing_host(ENDPOINT_ID_TRANSCRIPTION)? else {
        return Ok(AccountStatus { billing: false, signed_in: false });
    };

    let signed_in = token_load(host)?.is_some();

    Ok(AccountStatus { billing: true, signed_in })
}

fn token_is_valid(token: &str) -> bool {
    if token.is_empty() {
        return false;
    }

    if token.len() > usize_of!(TOKEN_CHARS_MAX) {
        return false;
    }

    token.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn token_load(host: &str) -> AppResult<Option<String>> {
    assert_ne!(host, "");
    assert!(!host.ends_with('/'));

    let path = workspace::root_file_path(TOKEN_FILE)?;

    let Some(payload) = protected_read(&path)? else {
        return Ok(None);
    };

    let stored: TokenStored = match serde_json::from_str(&payload) {
        Ok(stored) => stored,
        Err(error) => {
            tracing::warn!(target: "remi_lib::account", "account token unreadable: {}", error);

            return Ok(None);
        }
    };

    if stored.host != host {
        return Ok(None);
    }

    Ok(Some(stored.token).filter(|token| token_is_valid(token)))
}

async fn token_required(host: &'static str) -> AppResult<String> {
    blocking::run(move || token_load(host))
        .await?
        .ok_or_else(|| AppError::Config(MESSAGE_SIGNED_OUT.into()))
}

fn token_save(session: &Session<'_>) -> AppResult<()> {
    assert_ne!(session.host, "");
    assert!(token_is_valid(session.token));

    let path = workspace::root_file_path(TOKEN_FILE)?;
    let stored = TokenStored { host: session.host.to_owned(), token: session.token.to_owned() };
    let payload = serde_json::to_string(&stored)?;

    protected_write(&path, &payload)
}

impl TryFrom<TextRaw> for PublishableKey {
    type Error = AppError;

    fn try_from(raw: TextRaw) -> AppResult<Self> {
        if raw.is_empty() {
            return Ok(Self(String::new()));
        }

        if !checkout_key_is_valid(&raw) {
            return Err(AppError::Service(MESSAGE_KEY_MALFORMED.into()));
        }

        assert!(raw.starts_with("pk_"));

        Ok(Self(str::to_owned(&raw)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::test_support::root_scoped;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};
    use tokio::task::JoinHandle;

    const ACCOUNT_REPLY: &str = concat!(
        r#"{"balance_seconds": 900000, "email": "avery@example.com", "name": "Avery", "#,
        r#""offers": [{"currency": "cad", "hours": 10, "price_cents": 300}, "#,
        r#"{"currency": "cad", "hours": 50, "price_cents": 1000}], "#,
        r#""payments": false, "publishable_key": ""}"#,
    );

    const CHECKOUT_KEY: &str = "pk_test_51Hremi";
    const CHECKOUT_SECRET: &str = "cs_test_a1B2c3_secret_eyJ1aSI6MX0";
    const CHECKOUT_SESSION: &str = "cs_test_a1B2c3";
    const HOST: &str = "https://remi.example.test";
    const JOB_ID: &str = "86dfb1d3b0140ecf2fd59075421f1cb5";

    const MESSAGE_BALANCE: &str = concat!(
        "This recording needs 2 hours of transcription and the account has 1 hour left. ",
        "Buy more hours to transcribe it.",
    );

    const REPLY_BALANCE: &str = concat!(
        r#"{"error": {"code": "balance_insufficient", "message": "This recording needs 2 "#,
        r#"hours of transcription and the account has 1 hour left. Buy more hours to "#,
        r#"transcribe it.", "type": "billing_error"}}"#,
    );

    const REPLY_BUSY: &str = concat!(
        r#"{"error": {"code": "payments_unavailable", "message": "Payments are not set up on "#,
        r#"this server yet.", "type": "billing_error"}}"#,
    );

    const REPLY_SIGNED_OUT: &str = concat!(
        r#"{"error": {"code": "token_invalid", "message": "This copy of Remi is not signed in "#,
        r#"to an account.", "type": "billing_error"}}"#,
    );

    const REQUEST_READS_MAX: u32 = 64;
    const SESSION: Session<'static> = Session { host: HOST, token: TOKEN };
    const TOKEN: &str = "_5l7Sfe4jlqihWxQ9KAatIUrtHzIF7uQ_90oRpUP2MY";

    fn account_reply_keyed(key: &str) -> String {
        let field = format!(r#""publishable_key": "{key}""#);

        ACCOUNT_REPLY.replace(r#""publishable_key": """#, &field)
    }

    fn checkout_started_sample() -> CheckoutStarted {
        CheckoutStarted {
            client_secret: CHECKOUT_SECRET.to_owned(),
            session_id: CHECKOUT_SESSION.to_owned(),
        }
    }

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

    async fn request_read(stream: &mut TcpStream) -> String {
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

    fn request_parts(request: &str) -> (&str, serde_json::Value) {
        let (head, body) = request.split_once("\r\n\r\n").unwrap();

        (head, serde_json::from_str(body).unwrap())
    }

    async fn service_replying(replies: Vec<(u16, String)>) -> (String, JoinHandle<Vec<String>>) {
        assert_ne!(replies.len(), 0);

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();

        let serving = tokio::spawn(async move {
            let mut requests = Vec::with_capacity(replies.len());

            for (status, body) in replies {
                let (mut stream, _peer) = listener.accept().await.unwrap();

                requests.push(request_read(&mut stream).await);

                let length = body.len();
                let head = format!("HTTP/1.1 {status} X\r\nContent-Length: {length}\r\n");
                let reply = format!("{head}Connection: close\r\n\r\n{body}");

                stream.write_all(reply.as_bytes()).await.unwrap();
            }

            requests
        });

        (format!("http://127.0.0.1:{port}"), serving)
    }

    #[test]
    fn a_token_is_accepted_only_in_the_url_safe_shape_the_server_mints() {
        assert!(token_is_valid(TOKEN));
        assert!(token_is_valid("a"));
        assert!(token_is_valid(&"k".repeat(usize_of!(TOKEN_CHARS_MAX))));
        assert!(!token_is_valid(""));
        assert!(!token_is_valid(&"k".repeat(usize_of!(TOKEN_CHARS_MAX) + 1)));
        assert!(!token_is_valid("two words"));
        assert!(!token_is_valid("line\r\nInjected: header"));
        assert!(!token_is_valid("sl/ash"));
        assert!(!token_is_valid("\u{e9}t\u{e9}"));
    }

    #[test]
    fn a_saved_token_loads_back_only_for_the_host_it_was_issued_by() {
        let _root = root_scoped();
        let path = workspace::root_file_path(TOKEN_FILE).unwrap();

        assert!(token_load(HOST).unwrap().is_none());

        token_save(&SESSION).unwrap();

        assert_eq!(token_load(HOST).unwrap().as_deref(), Some(TOKEN));
        assert!(token_load("https://staging.example.test").unwrap().is_none());
        assert!(path.exists());

        protected_write(&path, "{ not json").unwrap();

        assert!(token_load(HOST).unwrap().is_none());

        protected_write(&path, &format!(r#"{{"host":"{HOST}","token":"bad token"}}"#)).unwrap();

        assert!(token_load(HOST).unwrap().is_none());
    }

    #[test]
    fn a_charge_covers_each_started_second_and_refuses_audio_outside_the_limit() {
        let limit = f64::from(u32::try_from(CHARGE_SECONDS_MAX).unwrap());

        assert_eq!(charge_seconds(0.2_f64).unwrap(), 1);
        assert_eq!(charge_seconds(1.0_f64).unwrap(), 1);
        assert_eq!(charge_seconds(1.5_f64).unwrap(), 2);
        assert_eq!(charge_seconds(3599.01_f64).unwrap(), 3600);
        assert_eq!(charge_seconds(limit).unwrap(), CHARGE_SECONDS_MAX);

        for refused in [limit + 0.5_f64, 0.0_f64] {
            let message = charge_seconds(refused).unwrap_err().to_string();

            assert!(message.contains("outside the 1 to 21600 seconds"), "{message}");
        }
    }

    #[test]
    fn a_started_checkout_is_used_only_when_its_secret_belongs_to_its_session() {
        let secret_long = format!("{CHECKOUT_SESSION}_secret_{}", "k".repeat(2048));

        let secrets = [
            "cs_test_a1B2c3X_secret_eyJ1aSI6MX0",
            "cs_test_a1B2c3_secret_",
            "cs_test_a1B2c3_secret_two words",
            "cs_test_a1B2c3",
            secret_long.as_str(),
        ];

        let sessions = ["pi_3Hscribe", "cs_", "cs_test_a1B2", "cs_test_a1B2c3/"];

        assert!(checkout_started_is_valid(&checkout_started_sample()));

        for secret in secrets {
            let started =
                CheckoutStarted { client_secret: secret.to_owned(), ..checkout_started_sample() };

            assert!(!checkout_started_is_valid(&started), "{started:?}");
        }

        for session in sessions {
            let started =
                CheckoutStarted { session_id: session.to_owned(), ..checkout_started_sample() };

            assert!(!checkout_started_is_valid(&started), "{started:?}");
        }
    }

    #[test]
    fn a_checkout_asks_for_a_pack_of_one_to_ten_thousand_hours() {
        for hours in [1, 50, CHECKOUT_HOURS_MAX] {
            assert!(checkout_hours_is_valid(NonZeroU32::new(hours).unwrap()), "{hours}");
        }

        for hours in [CHECKOUT_HOURS_MAX + 1, u32::MAX] {
            assert!(!checkout_hours_is_valid(NonZeroU32::new(hours).unwrap()), "{hours}");
        }

        for refused in ["0", "-50", "50.5"] {
            let message = serde_json::from_str::<NonZeroU32>(refused).unwrap_err().to_string();

            assert!(!message.is_empty(), "{refused}");
        }
    }

    #[test]
    fn an_account_carries_a_publishable_key_or_none_and_never_a_secret_key() {
        for key in ["", CHECKOUT_KEY, "pk_live_51Hremi"] {
            let account: Account = serde_json::from_str(&account_reply_keyed(key)).unwrap();
            let sent = serde_json::to_value(&account).unwrap();

            assert_eq!(account.publishable_key.0, key);
            assert_eq!(sent["publishable_key"], key);
            assert_eq!(sent["offers"][1]["hours"], 50_u32);
        }

        for key in ["sk_test_51Hremi", "rk_live_51Hremi", "pk_test_", "pk_test_51H/remi"] {
            let reply = account_reply_keyed(key);
            let message = serde_json::from_str::<Account>(&reply).unwrap_err().to_string();

            assert!(message.contains("not a publishable key"), "{message}");
            assert!(!message.contains("51H"), "{message}");
        }
    }

    #[tokio::test]
    async fn a_checkout_finish_refuses_a_session_this_copy_could_not_have_started() {
        let refused = ["", "cs_", "pi_3Hscribe", "cs_test/../account", "cs_test 1", "CS_TEST_1"];

        for text in refused {
            let session_id: CheckoutSessionID = serde_json::from_value(text.into()).unwrap();
            let message = account_checkout_finish(session_id).await.unwrap_err().to_string();

            assert!(message.contains("not a checkout this copy of Remi started"), "{message}");
        }
    }

    #[tokio::test]
    async fn a_checkout_start_and_finish_speak_the_shapes_the_server_sends() {
        let started_reply = serde_json::json!({
            "client_secret": CHECKOUT_SECRET,
            "session_id": CHECKOUT_SESSION,
        });

        let finished_reply = format!(r#"{{"account": {ACCOUNT_REPLY}, "paid": true}}"#);
        let replies = vec![(200, started_reply.to_string()), (200, finished_reply)];
        let (host, serving) = service_replying(replies).await;

        let start =
            Call { host: &host, label: LABEL_CHECKOUT, path: PATH_CHECKOUT, token: Some(TOKEN) };

        let finish = Call {
            host: &host,
            label: LABEL_CHECKOUT_FINISH,
            path: PATH_CHECKOUT_FINISH,
            token: Some(TOKEN),
        };

        let body = CheckoutStartRequest { hours: NonZeroU32::new(50).unwrap() };
        let request = CheckoutFinishRequest { session_id: CHECKOUT_SESSION };
        let started: CheckoutStarted = call_post(&start, &body).await.unwrap();
        let finished: CheckoutFinished = call_post(&finish, &request).await.unwrap();
        let requests = serving.await.unwrap();

        assert!(checkout_started_is_valid(&started));
        assert_eq!(started.session_id, CHECKOUT_SESSION);
        assert!(finished.paid);
        assert_eq!(finished.account.balance_seconds, 900_000);

        let (start_head, start_sent) = request_parts(&requests[0]);

        assert!(start_head.starts_with("POST /api/v1/account/checkout/ HTTP/1.1\r\n"));
        assert_eq!(start_sent, serde_json::json!({ "hours": 50_u32 }));

        let (head, sent) = request_parts(&requests[1]);

        assert!(head.starts_with("POST /api/v1/account/checkout/finish/ HTTP/1.1\r\n"));
        assert_eq!(sent, serde_json::json!({ "session_id": CHECKOUT_SESSION }));
    }

    #[test]
    fn a_builtin_host_is_trimmed_of_space_and_trailing_slashes() {
        assert_eq!(host_clean(Some(" https://remi.example.test/ ")), Some(HOST));
        assert_eq!(host_clean(Some("https://remi.example.test//")), Some(HOST));
        assert_eq!(host_clean(Some(HOST)), Some(HOST));
        assert_eq!(host_clean(Some("  ")), None);
        assert_eq!(host_clean(Some("/")), None);
        assert_eq!(host_clean(None), None);
    }

    #[tokio::test]
    async fn an_account_is_read_with_the_token_and_a_refused_token_reads_as_signed_out() {
        let replies = vec![(200, ACCOUNT_REPLY.to_owned()), (401, REPLY_SIGNED_OUT.to_owned())];
        let (host, serving) = service_replying(replies).await;
        let session = Session { host: &host, token: TOKEN };
        let account = account_fetch(&session).await.unwrap().unwrap();
        let refused = account_fetch(&session).await.unwrap();
        let requests = serving.await.unwrap();
        let header = format!("authorization: bearer {}", TOKEN.to_ascii_lowercase());

        assert!(refused.is_none());
        assert!(requests[0].starts_with("GET /api/v1/account/ HTTP/1.1\r\n"));
        assert!(requests[0].to_ascii_lowercase().contains(&header));
        assert_eq!(account.balance_seconds, 900_000);
        assert_eq!(account.email, "avery@example.com");
        assert_eq!(account.offers.len(), 2);
        assert_eq!(account.offers[1].hours, 50);
        assert_eq!(account.offers[1].price_cents, 1000);
        assert!(!account.payments);
        assert_eq!(account.publishable_key.0, "");
    }

    #[tokio::test]
    async fn a_sign_up_posts_the_form_and_reads_back_the_account_and_its_token() {
        let created = format!(r#"{{"account": {ACCOUNT_REPLY}, "token": "{TOKEN}"}}"#);
        let (host, serving) = service_replying(vec![(201, created)]).await;

        let sign_up = AccountSignUp {
            email: "avery@example.com".to_owned(),
            name: "Avery".to_owned(),
            promo_code: "wib2026".to_owned(),
        };

        let call = Call { host: &host, label: LABEL_SIGN_UP, path: PATH_ACCOUNT, token: None };
        let reply: AccountCreated = call_post(&call, &sign_up).await.unwrap();
        let requests = serving.await.unwrap();
        let (head, sent) = request_parts(&requests[0]);

        assert_eq!(reply.token, TOKEN);
        assert_eq!(reply.account.name, "Avery");
        assert!(head.starts_with("POST /api/v1/account/ HTTP/1.1\r\n"));
        assert!(!head.to_ascii_lowercase().contains("authorization:"));
        assert_eq!(sent["email"], "avery@example.com");
        assert_eq!(sent["name"], "Avery");
        assert_eq!(sent["promo_code"], "wib2026");
    }

    #[tokio::test]
    async fn a_charge_over_the_balance_reports_the_server_message_without_retrying() {
        let (host, serving) = service_replying(vec![(402, REPLY_BALANCE.to_owned())]).await;
        let request = ChargeRequest { job_id: JOB_ID, seconds: 7200 };
        let session = Session { host: &host, token: TOKEN };
        let error = charge_send(&session, &request).await.unwrap_err().to_string();
        let requests = serving.await.unwrap();
        let (head, sent) = request_parts(&requests[0]);

        assert_eq!(error, format!("api error: {MESSAGE_BALANCE}"));
        assert_eq!(requests.len(), 1);
        assert!(head.starts_with("POST /api/v1/account/charge/ HTTP/1.1\r\n"));
        assert_eq!(sent["job_id"], JOB_ID);
        assert_eq!(sent["seconds"], 7200_u64);
    }

    #[tokio::test]
    async fn a_refusal_without_the_error_envelope_keeps_its_status_and_body() {
        let (host, serving) = service_replying(vec![(413, "request too large".to_owned())]).await;
        let request = ChargeRequest { job_id: JOB_ID, seconds: 61 };
        let session = Session { host: &host, token: TOKEN };
        let error = charge_send(&session, &request).await.unwrap_err().to_string();
        let requests = serving.await.unwrap();

        assert_eq!(error, "api error: 413 transcription charge: request too large");
        assert_eq!(requests.len(), 1);
    }

    #[tokio::test]
    async fn a_charge_the_server_could_not_take_is_sent_again_with_the_same_job() {
        let replies = vec![(503, REPLY_BUSY.to_owned()), (200, ACCOUNT_REPLY.to_owned())];
        let (host, serving) = service_replying(replies).await;
        let request = ChargeRequest { job_id: JOB_ID, seconds: 61 };

        charge_send(&Session { host: &host, token: TOKEN }, &request).await.unwrap();

        let requests = serving.await.unwrap();
        let (_head_first, sent_first) = request_parts(&requests[0]);
        let (_head_second, sent_second) = request_parts(&requests[1]);

        assert_eq!(requests.len(), 2);
        assert_eq!(sent_first, sent_second);
        assert_eq!(sent_first["job_id"], JOB_ID);
    }
}
