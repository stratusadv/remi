use crate::cancellation::{CancellationRegistry, is_cancelled};
use crate::contract::StreamID;
use crate::endpoints::types::APIEndpoint;
use crate::error::{AppError, AppResult};
use crate::http::{
    ClientCell,
    ClientTimeouts,
    client_build,
    client_get,
    response_ensure_ok,
    response_json_bounded,
    retry_run,
};
use crate::state::AppState;
use crate::workspace::NOTES_BYTES_MAX;
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::Value;
use std::sync::LazyLock;
use std::sync::atomic::AtomicBool;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

const API_PATH_MODELS: &str = "/v1/models";
const CONNECT_TIMEOUT_SECONDS: u64 = 15;
pub(super) const EVENT_NOTES_CHUNK: &str = "notes_generate_chunk";

const HTTP_TIMEOUTS: ClientTimeouts = ClientTimeouts {
    connect: Duration::from_secs(CONNECT_TIMEOUT_SECONDS),
    read: Some(Duration::from_secs(READ_TIMEOUT_SECONDS)),
    request: Duration::from_secs(REQUEST_TIMEOUT_SECONDS),
};

const LABEL_CHAT: &str = "chat completion";
const LABEL_MODELS: &str = "model list";
const MODEL_COUNT_MAX: u32 = 256;
const READ_TIMEOUT_SECONDS: u64 = 120;
const REASONING_BYTES_MAX: u32 = 16 << 20;
const REQUEST_TIMEOUT_SECONDS: u64 = 900;
const SSE_DATA_PREFIX: &str = "data:";
const SSE_DONE: &str = "[DONE]";
const SSE_EVENT_BYTES_MAX: u32 = 1 << 20;
const SSE_SEPARATOR: &[u8] = b"\n\n";
const SSE_SEPARATOR_CRLF: &[u8] = b"\r\n\r\n";
const STREAM_CHUNK_COUNT_MAX: u32 = 1 << 22;

const _: () = assert!(SSE_SEPARATOR.len() == 2);
const _: () = assert!(SSE_SEPARATOR_CRLF.len() == 4);
const _: () = assert!(SSE_EVENT_BYTES_MAX < NOTES_BYTES_MAX);
const _: () = assert!(NOTES_BYTES_MAX < REASONING_BYTES_MAX);
const _: () = assert!(CONNECT_TIMEOUT_SECONDS < READ_TIMEOUT_SECONDS);
const _: () = assert!(READ_TIMEOUT_SECONDS < REQUEST_TIMEOUT_SECONDS);

static HTTP_CLIENT: ClientCell = LazyLock::new(|| client_build(&HTTP_TIMEOUTS));

#[derive(Debug, Clone, serde::Serialize)]
pub(super) struct ChatChunk {
    pub(super) stream_id: String,
    pub(super) text: String,
    pub(super) done: bool,
}

#[derive(Debug, serde::Serialize)]
struct ChatMessage<'prompt> {
    role: &'static str,
    content: &'prompt str,
}

#[derive(Debug)]
pub(super) struct Completion {
    pub(super) text: String,
    pub(super) tokens: Option<u32>,
}

#[derive(Debug)]
pub(super) struct ChatPrompts<'prompt> {
    pub(super) system: &'prompt str,
    pub(super) user: &'prompt str,
}

#[derive(Debug, serde::Serialize)]
pub(super) struct ChatRequest<'prompt> {
    model: &'prompt str,
    messages: [ChatMessage<'prompt>; 2],
    stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    stream_options: Option<StreamOptions>,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reasoning_effort: Option<&'prompt str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    response_format: Option<Value>,
    chat_template_kwargs: ChatTemplateKwargs,
}

#[derive(Debug, serde::Serialize)]
struct ChatTemplateKwargs {
    enable_thinking: bool,
}

#[derive(Debug, Deserialize)]
struct ModelEntry {
    id: String,
}

#[derive(Debug, Deserialize)]
struct ModelsResponse {
    data: Vec<ModelEntry>,
}

#[derive(Debug, Deserialize)]
struct ReplyMessage {
    #[serde(default)]
    content: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ReplyChoice {
    #[serde(default)]
    message: Option<ReplyMessage>,
}

#[derive(Debug, Deserialize)]
struct ChatResponse {
    choices: Vec<ReplyChoice>,
    #[serde(default)]
    usage: Option<ReplyUsage>,
}

#[derive(Clone, Copy, Debug, Deserialize)]
struct ReplyUsage {
    total_tokens: u64,
}

#[derive(Debug)]
struct ChatSend<'prompt> {
    api_key: &'prompt str,
    body: ChatRequest<'prompt>,
    url: String,
}

#[derive(Debug)]
pub(super) struct ReplySchema<'schema> {
    pub(super) name: &'static str,
    pub(super) schema: &'schema Value,
    pub(super) tokens_max: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum ReplyShape {
    Streamed,
    Whole,
}

#[derive(Clone, Copy, Debug, serde::Serialize)]
struct StreamOptions {
    include_usage: bool,
}

struct StreamState {
    accumulated: String,
    byte_buffer: Vec<u8>,
    reasoning_bytes: u64,
    tokens: Option<u32>,
}

impl ReplyUsage {
    fn tokens(self) -> u32 {
        let tokens = u32::try_from(self.total_tokens).unwrap_or(u32::MAX);

        assert!(u64::from(tokens) <= self.total_tokens);
        assert!(tokens > 0 || self.total_tokens == 0);

        tokens
    }
}

pub(super) async fn chat_completion(
    endpoint: &APIEndpoint,
    prompts: &ChatPrompts<'_>,
) -> AppResult<String> {
    let (url, body, api_key) = build_request(endpoint, prompts, ReplyShape::Whole);
    let completion = chat_completion_send(&ChatSend { api_key, body, url }).await?;

    Ok(completion.text)
}

pub(super) async fn chat_completion_structured(
    endpoint: &APIEndpoint,
    prompts: &ChatPrompts<'_>,
    reply: &ReplySchema<'_>,
) -> AppResult<Completion> {
    let (url, body, api_key) = build_request_structured(endpoint, prompts, reply);

    chat_completion_send(&ChatSend { api_key, body, url }).await
}

pub(super) async fn chat_completion_streaming(
    app: AppHandle,
    stream_id: StreamID,
    endpoint: &APIEndpoint,
    prompts: &ChatPrompts<'_>,
) -> AppResult<String> {
    let (url, body, api_key) = build_request(endpoint, prompts, ReplyShape::Streamed);
    let outgoing = ChatSend { api_key, body, url };
    let completion = chat_completion_stream_send(app, stream_id, &outgoing).await?;

    Ok(completion.text)
}

pub(super) async fn chat_completion_streaming_counted(
    app: AppHandle,
    stream_id: StreamID,
    endpoint: &APIEndpoint,
    prompts: &ChatPrompts<'_>,
) -> AppResult<Completion> {
    let (url, body, api_key) = build_request_counted(endpoint, prompts);
    let outgoing = ChatSend { api_key, body, url };

    chat_completion_stream_send(app, stream_id, &outgoing).await
}

pub(super) async fn models_list(endpoint: &APIEndpoint) -> AppResult<Vec<String>> {
    let url = format!("{}{}", endpoint.host_resolved().trim_end_matches('/'), API_PATH_MODELS);
    let api_key = endpoint.api_key_resolved();
    let client = client_get(&HTTP_CLIENT)?;

    let parsed: ModelsResponse = retry_run(|| async {
        let mut request = client.get(&url);

        if !api_key.is_empty() {
            request = request.bearer_auth(api_key);
        }

        let sent = request.send().await?;
        let response = response_ensure_ok(sent, LABEL_MODELS).await?;

        response_json_bounded::<ModelsResponse>(response).await
    })
    .await?;

    let mut models: Vec<String> =
        parsed.data.into_iter().take(usize_of!(MODEL_COUNT_MAX)).map(|entry| entry.id).collect();

    models.sort();
    models.dedup();

    assert!(models.len() <= usize_of!(MODEL_COUNT_MAX));

    Ok(models)
}

pub(super) fn build_request<'prompt>(
    endpoint: &'prompt APIEndpoint,
    prompts: &ChatPrompts<'prompt>,
    shape: ReplyShape,
) -> (String, ChatRequest<'prompt>, &'prompt str) {
    let path = endpoint.api_path_chat_resolved();
    let url = format!("{}{}", endpoint.host_resolved().trim_end_matches('/'), path);

    assert!(path.starts_with('/'));
    assert!(url.ends_with(&path));

    let body = ChatRequest {
        model: endpoint.model_resolved(),
        messages: [
            ChatMessage { role: "system", content: prompts.system },
            ChatMessage { role: "user", content: prompts.user },
        ],
        stream: shape == ReplyShape::Streamed,
        stream_options: None,
        temperature: endpoint.temperature,
        max_tokens: endpoint.output_tokens_max,
        reasoning_effort: endpoint.reasoning_effort.as_deref(),
        response_format: None,
        chat_template_kwargs: ChatTemplateKwargs {
            enable_thinking: endpoint.reasoning_effort.is_some(),
        },
    };

    (url, body, endpoint.api_key_resolved())
}

async fn chat_completion_send(outgoing: &ChatSend<'_>) -> AppResult<Completion> {
    let client = client_get(&HTTP_CLIENT)?;

    let parsed: ChatResponse = retry_run(|| async {
        let mut request = client.post(&outgoing.url);

        if !outgoing.api_key.is_empty() {
            request = request.bearer_auth(outgoing.api_key);
        }

        let sent = request.json(&outgoing.body).send().await?;
        let response = response_ensure_ok(sent, LABEL_CHAT).await?;

        response_json_bounded::<ChatResponse>(response).await
    })
    .await?;

    let tokens = parsed.usage.map(ReplyUsage::tokens);

    let text = parsed
        .choices
        .into_iter()
        .next()
        .and_then(|choice| choice.message)
        .and_then(|message| message.content)
        .map(|content| content.trim().to_owned())
        .ok_or_else(|| AppError::Service("no content in chat response".into()))?;

    Ok(Completion { text, tokens })
}

async fn chat_completion_stream_send(
    app: AppHandle,
    stream_id: StreamID,
    outgoing: &ChatSend<'_>,
) -> AppResult<Completion> {
    let client = client_get(&HTTP_CLIENT)?;

    let response = retry_run(|| async {
        let mut request = client.post(&outgoing.url);

        if !outgoing.api_key.is_empty() {
            request = request.bearer_auth(outgoing.api_key);
        }

        let sent = request.json(&outgoing.body).send().await?;

        response_ensure_ok(sent, LABEL_CHAT).await
    })
    .await?;

    let state = app.state::<AppState>();
    let cancellation = &state.cancellation;
    let cancel_flag = cancellation.register(&stream_id);
    let read = chat_completion_stream_read(&app, &stream_id, &cancel_flag, response).await;

    chat_completion_stream_end(&app, cancellation, stream_id.into_string());

    let streamed = read?;
    let text = streamed.text.trim().to_owned();

    assert!(text.len() <= usize_of!(NOTES_BYTES_MAX));

    Ok(Completion { text, tokens: streamed.tokens })
}

pub(super) fn build_request_counted<'prompt>(
    endpoint: &'prompt APIEndpoint,
    prompts: &ChatPrompts<'prompt>,
) -> (String, ChatRequest<'prompt>, &'prompt str) {
    let (url, mut body, api_key) = build_request(endpoint, prompts, ReplyShape::Streamed);

    body.stream_options = Some(StreamOptions { include_usage: true });

    assert!(body.stream);
    assert!(body.response_format.is_none());

    (url, body, api_key)
}

fn build_request_structured<'prompt>(
    endpoint: &'prompt APIEndpoint,
    prompts: &ChatPrompts<'prompt>,
    reply: &ReplySchema<'_>,
) -> (String, ChatRequest<'prompt>, &'prompt str) {
    assert_ne!(reply.name, "");
    assert!(reply.tokens_max > 0);

    let (url, mut body, api_key) = build_request(endpoint, prompts, ReplyShape::Whole);

    body.chat_template_kwargs = ChatTemplateKwargs { enable_thinking: false };
    body.max_tokens = Some(reply.tokens_max);
    body.reasoning_effort = None;
    body.temperature = Some(0.0);

    body.response_format = Some(serde_json::json!({
        "type": "json_schema",
        "json_schema": { "name": reply.name, "schema": reply.schema, "strict": true },
    }));

    assert!(!body.stream);

    (url, body, api_key)
}

fn chat_completion_stream_drain(app: &AppHandle, stream_id: &str, state: &mut StreamState) {
    while let Some((position, separator_length)) = sse_event_end(&state.byte_buffer) {
        let event_end = usize_of!(position + separator_length);

        assert!(event_end <= state.byte_buffer.len());

        let event_bytes: Vec<u8> = state.byte_buffer.drain(..event_end).collect();

        assert_eq!(event_bytes.len(), event_end);

        let event_text = String::from_utf8_lossy(&event_bytes);

        for line in event_text.lines() {
            let Some(payload) = line.strip_prefix(SSE_DATA_PREFIX).map(str::trim) else {
                continue;
            };

            if payload == SSE_DONE {
                continue;
            }

            if payload.is_empty() {
                continue;
            }

            chat_completion_stream_event_apply(app, stream_id, payload.as_bytes(), state);
        }
    }
}

fn chat_completion_stream_end(
    app: &AppHandle,
    cancellation: &CancellationRegistry,
    stream_id: String,
) {
    assert_ne!(stream_id, "");

    cancellation.clear(&stream_id);
    chunk_emit(app, ChatChunk { stream_id, text: String::new(), done: true });
}

fn chat_completion_stream_event_apply(
    app: &AppHandle,
    stream_id: &str,
    payload: &[u8],
    state: &mut StreamState,
) {
    assert_ne!(payload.len(), 0);

    let parsed = match serde_json::from_slice::<Value>(payload) {
        Ok(parsed) => parsed,
        Err(error) => {
            tracing::debug!("notes stream {stream_id} carried an event that is not JSON: {error}");

            return;
        }
    };

    let delta = parsed
        .get("choices")
        .and_then(|choices| choices.get(0))
        .and_then(|choice| choice.get("delta"));

    let reasoning_text =
        delta.and_then(|fields| fields.get("reasoning_content")).and_then(Value::as_str);

    if let Some(text) = reasoning_text {
        let reasoned = u64::try_from(text.len()).unwrap_or(u64::MAX);

        state.reasoning_bytes = state.reasoning_bytes.saturating_add(reasoned);
    }

    let delta_text = delta.and_then(|fields| fields.get("content")).and_then(Value::as_str);

    if let Some(text) = delta_text {
        state.accumulated.push_str(text);

        chunk_emit(
            app,
            ChatChunk { stream_id: stream_id.to_owned(), text: text.to_owned(), done: false },
        );
    }

    if let Some(tokens) = stream_event_tokens(&parsed) {
        state.tokens = Some(tokens);
    }
}

fn chat_completion_stream_limits(state: &StreamState) -> AppResult<()> {
    if state.accumulated.len() > usize_of!(NOTES_BYTES_MAX) {
        return Err(AppError::Service(format!(
            "the notes service streamed more than {} MB without finishing",
            NOTES_BYTES_MAX >> 20,
        )));
    }

    if state.byte_buffer.len() > usize_of!(SSE_EVENT_BYTES_MAX) {
        return Err(AppError::Service(format!(
            "the notes service sent more than {} MB without ending an event",
            SSE_EVENT_BYTES_MAX >> 20,
        )));
    }

    if state.reasoning_bytes > u64::from(REASONING_BYTES_MAX) {
        return Err(AppError::Service(format!(
            "the notes service spent more than {} MB thinking without writing notes",
            REASONING_BYTES_MAX >> 20,
        )));
    }

    Ok(())
}

async fn chat_completion_stream_read(
    app: &AppHandle,
    stream_id: &str,
    cancel_flag: &AtomicBool,
    response: reqwest::Response,
) -> AppResult<Completion> {
    let mut stream = response.bytes_stream();

    let mut state = StreamState {
        accumulated: String::new(),
        byte_buffer: Vec::new(),
        reasoning_bytes: 0,
        tokens: None,
    };

    for _chunk_index in 0..STREAM_CHUNK_COUNT_MAX {
        let Some(chunk) = stream.next().await else {
            tracing::info!(
                "notes stream {stream_id} finished: {} bytes of notes after {} bytes of model \
                 reasoning",
                state.accumulated.len(),
                state.reasoning_bytes,
            );

            return Ok(Completion { text: state.accumulated, tokens: state.tokens });
        };

        if is_cancelled(cancel_flag) {
            return Err(AppError::Service("Cancelled".into()));
        }

        state.byte_buffer.extend_from_slice(&chunk?);

        chat_completion_stream_drain(app, stream_id, &mut state);
        chat_completion_stream_limits(&state)?;
    }

    Err(AppError::Service(format!(
        "the notes service sent more than {STREAM_CHUNK_COUNT_MAX} pieces without finishing",
    )))
}

fn chunk_emit(app: &AppHandle, chunk: ChatChunk) {
    assert_ne!(chunk.stream_id, "");

    if let Err(error) = app.emit(EVENT_NOTES_CHUNK, chunk) {
        tracing::warn!("notes chunk event could not be emitted: {}", error);
    }
}

fn find_subsequence<Needle>(haystack: &[u8], needle: &Needle) -> Option<usize>
where
    Needle: AsRef<[u8]> + ?Sized,
{
    let bytes = needle.as_ref();

    assert_ne!(bytes.len(), 0);

    let position = haystack.windows(bytes.len()).position(|window| window == bytes);

    assert!(position.is_none_or(|found| found + bytes.len() <= haystack.len()));

    position
}

fn sse_event_end(buffer: &[u8]) -> Option<(u32, u32)> {
    [SSE_SEPARATOR, SSE_SEPARATOR_CRLF]
        .into_iter()
        .filter_map(|separator| {
            let position = u32::try_from(find_subsequence(buffer, separator)?).ok()?;
            let length = u32::try_from(separator.len()).ok()?;

            Some((position, length))
        })
        .min_by_key(|(position, _)| *position)
}

pub(super) fn stream_event_tokens(parsed: &Value) -> Option<u32> {
    let usage = ReplyUsage::deserialize(parsed.get("usage")?).ok()?;

    Some(usage.tokens())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::endpoints::types::APIEndpointPurpose;

    const PROMPTS: ChatPrompts<'static> = ChatPrompts { system: "sys", user: "user" };

    fn message_first(response: ChatResponse) -> Option<ReplyMessage> {
        assert!(response.choices.len() <= 2);

        response.choices.into_iter().next()?.message
    }

    fn state_with(accumulated: &str, byte_buffer: &[u8], reasoning_bytes: u64) -> StreamState {
        assert!(reasoning_bytes <= u64::from(REASONING_BYTES_MAX) + 1);

        StreamState {
            accumulated: accumulated.to_owned(),
            byte_buffer: byte_buffer.to_vec(),
            reasoning_bytes,
            tokens: None,
        }
    }

    fn endpoint_with(host: &str, reasoning_effort: Option<&str>) -> APIEndpoint {
        APIEndpoint {
            id: "builtin-notes".to_owned(),
            name: "Notes".to_owned(),
            purpose: APIEndpointPurpose::Notes,
            host: host.to_owned(),
            api_key: " secret ".to_owned(),
            model: " stratus.thinking ".to_owned(),
            temperature: Some(0.5),
            output_tokens_max: Some(4096),
            api_path_chat: None,
            api_path_transcribe: None,
            transcribe_verbose: None,
            transcribe_chunk_seconds: None,
            reasoning_effort: reasoning_effort.map(str::to_owned),
            has_api_key: true,
        }
    }

    #[test]
    fn a_request_targets_the_chat_path_under_the_trimmed_host() {
        let mut endpoint = endpoint_with(" https://api.example.test/ ", None);
        let (url, body, api_key) = build_request(&endpoint, &PROMPTS, ReplyShape::Whole);

        assert_eq!(url, "https://api.example.test/v1/chat/completions");
        assert_eq!(api_key, "secret");
        assert_eq!(body.model, "stratus.thinking");
        assert!(!body.stream);

        endpoint.api_path_chat = Some("custom/chat".to_owned());

        let (url_custom, body_custom, _) = build_request(&endpoint, &PROMPTS, ReplyShape::Streamed);

        assert_eq!(url_custom, "https://api.example.test/custom/chat");
        assert!(body_custom.stream);
    }

    #[test]
    fn a_request_carries_the_system_prompt_before_the_user_prompt() {
        let endpoint = endpoint_with("https://api.example.test", None);
        let prompts = ChatPrompts { system: "be terse", user: "hello" };
        let (_, body, _) = build_request(&endpoint, &prompts, ReplyShape::Streamed);
        let value = serde_json::to_value(&body).unwrap();
        let messages = value["messages"].as_array().unwrap();

        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0]["role"], "system");
        assert_eq!(messages[0]["content"], "be terse");
        assert_eq!(messages[1]["role"], "user");
        assert_eq!(messages[1]["content"], "hello");
        assert_eq!(value["stream"], true);
        assert_eq!(value["model"], "stratus.thinking");
    }

    #[test]
    fn sampling_settings_are_forwarded_and_absent_ones_are_left_out_of_the_body() {
        let endpoint = endpoint_with("https://api.example.test", None);
        let mut bare = endpoint_with("https://api.example.test", Some("high"));

        bare.temperature = None;
        bare.output_tokens_max = None;

        let shape = ReplyShape::Whole;
        let value = serde_json::to_value(build_request(&endpoint, &PROMPTS, shape).1).unwrap();
        let value_bare = serde_json::to_value(build_request(&bare, &PROMPTS, shape).1).unwrap();

        assert_eq!(value["temperature"], 0.5_f64);
        assert_eq!(value["max_tokens"], 4_096_i32);
        assert!(value.get("reasoning_effort").is_none());
        assert_eq!(value["chat_template_kwargs"]["enable_thinking"], false);
        assert!(value_bare.get("temperature").is_none());
        assert!(value_bare.get("max_tokens").is_none());
        assert_eq!(value_bare["reasoning_effort"], "high");
        assert_eq!(value_bare["chat_template_kwargs"]["enable_thinking"], true);
    }

    #[test]
    fn a_structured_request_asks_for_the_schema_without_thinking_or_sampling_noise() {
        let endpoint = endpoint_with("https://api.example.test", Some("high"));
        let schema = serde_json::json!({ "type": "object" });
        let reply = ReplySchema { name: "meeting_search", schema: &schema, tokens_max: 300 };
        let (url, body, _) = build_request_structured(&endpoint, &PROMPTS, &reply);
        let value = serde_json::to_value(&body).unwrap();

        assert_eq!(url, "https://api.example.test/v1/chat/completions");
        assert_eq!(value["stream"], false);
        assert_eq!(value["temperature"], 0.0_f64);
        assert_eq!(value["max_tokens"], 300_i32);
        assert!(value.get("reasoning_effort").is_none());
        assert_eq!(value["chat_template_kwargs"]["enable_thinking"], false);
        assert_eq!(value["response_format"]["type"], "json_schema");
        assert_eq!(value["response_format"]["json_schema"]["name"], "meeting_search");
        assert_eq!(value["response_format"]["json_schema"]["schema"], schema);
        assert_eq!(value["response_format"]["json_schema"]["strict"], true);

        let plain = serde_json::to_value(build_request(&endpoint, &PROMPTS, ReplyShape::Whole).1);

        assert!(plain.unwrap().get("response_format").is_none());
    }

    #[test]
    fn a_chat_reply_yields_its_first_content_or_nothing() {
        let full: ChatResponse =
            serde_json::from_str(r#"{"choices":[{"message":{"content":" hi "}},{}]}"#).unwrap();

        let empty: ChatResponse = serde_json::from_str(r#"{"choices":[]}"#).unwrap();
        let blank: ChatResponse = serde_json::from_str(r#"{"choices":[{"message":{}}]}"#).unwrap();
        let bare: ChatResponse = serde_json::from_str(r#"{"choices":[{}]}"#).unwrap();

        let full_text = message_first(full).and_then(|message| message.content);

        assert_eq!(full_text.as_deref(), Some(" hi "));
        assert!(message_first(empty).is_none());
        assert!(message_first(blank).and_then(|message| message.content).is_none());
        assert!(message_first(bare).is_none());
        assert_ne!(serde_json::from_str::<ChatResponse>("{}").unwrap_err().to_string(), "");
    }

    #[test]
    fn a_whole_reply_reads_its_token_count_only_when_the_service_reports_one() {
        let raw = concat!(
            r#"{"choices":[{"message":{"content":"hi"}}],"#,
            r#""usage":{"prompt_tokens":9,"completion_tokens":3,"total_tokens":12}}"#,
        );

        let counted: ChatResponse = serde_json::from_str(raw).unwrap();
        let bare: ChatResponse = serde_json::from_str(r#"{"choices":[]}"#).unwrap();

        assert_eq!(counted.usage.map(ReplyUsage::tokens), Some(12));
        assert!(bare.usage.is_none());
        assert_eq!(ReplyUsage { total_tokens: u64::MAX }.tokens(), u32::MAX);
        assert_eq!(ReplyUsage { total_tokens: u64::from(u32::MAX) }.tokens(), u32::MAX);
        assert_eq!(ReplyUsage { total_tokens: 0 }.tokens(), 0);
    }

    #[test]
    fn a_stream_event_reports_tokens_only_when_it_carries_a_usage_total() {
        let usage_only =
            serde_json::json!({ "choices": [], "usage": { "total_tokens": 4321_u64 } });
        let content = serde_json::json!({ "choices": [{ "delta": { "content": "hi" } }] });
        let partial = serde_json::json!({ "usage": { "prompt_tokens": 7_u64 } });
        let absent = serde_json::json!({ "usage": null });

        assert_eq!(stream_event_tokens(&usage_only), Some(4321));
        assert_eq!(stream_event_tokens(&content), None);
        assert_eq!(stream_event_tokens(&partial), None);
        assert_eq!(stream_event_tokens(&absent), None);
    }

    #[test]
    fn a_counted_stream_asks_for_usage_and_a_plain_stream_leaves_it_out() {
        let endpoint = endpoint_with("https://api.example.test", Some("low"));
        let (url_counted, counted, _) = build_request_counted(&endpoint, &PROMPTS);
        let (url_plain, plain, _) = build_request(&endpoint, &PROMPTS, ReplyShape::Streamed);
        let counted_value = serde_json::to_value(&counted).unwrap();
        let plain_value = serde_json::to_value(&plain).unwrap();

        assert_eq!(url_counted, url_plain);
        assert_eq!(counted_value["stream"], true);
        assert_eq!(counted_value["stream_options"]["include_usage"], true);
        assert!(plain_value.get("stream_options").is_none());
        assert_eq!(counted_value["messages"], plain_value["messages"]);
        assert_eq!(counted_value["reasoning_effort"], "low");
    }

    #[test]
    fn a_model_list_reads_only_the_ids() {
        let raw = r#"{"object":"list","data":[{"id":"b","owned_by":"x"},{"id":"a"}]}"#;
        let parsed: ModelsResponse = serde_json::from_str(raw).unwrap();
        let ids: Vec<&str> = parsed.data.iter().map(|entry| entry.id.as_str()).collect();

        assert_eq!(ids, vec!["b", "a"]);

        assert_ne!(
            serde_json::from_str::<ModelsResponse>(r#"{"data":[{}]}"#).unwrap_err().to_string(),
            "",
        );
    }

    #[test]
    fn an_event_boundary_is_found_only_on_a_full_separator() {
        assert_eq!(find_subsequence(b"data: a\n\ndata: b", SSE_SEPARATOR), Some(7));
        assert_eq!(find_subsequence(b"data: a\n", SSE_SEPARATOR), None);
        assert_eq!(find_subsequence(b"", SSE_SEPARATOR), None);
    }

    #[test]
    fn an_event_ends_at_the_earliest_lf_or_crlf_separator() {
        assert_eq!(sse_event_end(b"data: a\n\ndata: b"), Some((7, 2)));
        assert_eq!(sse_event_end(b"data: a\r\n\r\ndata: b"), Some((7, 4)));
        assert_eq!(sse_event_end(b"data: a\r\n\r\ndata: b\n\n"), Some((7, 4)));
        assert_eq!(sse_event_end(b"data: a\n\ndata: b\r\n\r\n"), Some((7, 2)));
        assert_eq!(sse_event_end(b"data: a\r\n"), None);
    }

    #[test]
    fn a_subsequence_is_reported_at_its_first_position_and_never_past_the_end() {
        assert_eq!(find_subsequence(b"\n\n", SSE_SEPARATOR), Some(0));
        assert_eq!(find_subsequence(b"a\n\nb\n\n", SSE_SEPARATOR), Some(1));
        assert_eq!(find_subsequence(b"ab\n\n", SSE_SEPARATOR), Some(2));
        assert_eq!(find_subsequence(b"\n", SSE_SEPARATOR), None);
        assert_eq!(find_subsequence(b"\n\r\n", SSE_SEPARATOR), None);
        assert_eq!(find_subsequence(b"abc", b"abcd"), None);
        assert_eq!(find_subsequence(b"abc", b"c"), Some(2));
    }

    #[test]
    fn a_stream_exactly_at_a_limit_is_still_accepted() {
        let notes_at_limit = "a".repeat(usize_of!(NOTES_BYTES_MAX));
        let event_at_limit = vec![0_u8; usize_of!(SSE_EVENT_BYTES_MAX)];

        chat_completion_stream_limits(&state_with(&notes_at_limit, b"", 0)).unwrap();
        chat_completion_stream_limits(&state_with("", &event_at_limit, 0)).unwrap();
        chat_completion_stream_limits(&state_with("", b"", 0)).unwrap();
    }

    #[test]
    fn a_stream_that_never_stops_is_refused_at_its_limit() {
        let oversized = "a".repeat(usize_of!(NOTES_BYTES_MAX) + 1);

        assert!(chat_completion_stream_limits(&state_with(&oversized, b"", 0)).is_err());
        chat_completion_stream_limits(&state_with("ok", b"partial event", 0)).unwrap();

        let unended = vec![0_u8; usize_of!(SSE_EVENT_BYTES_MAX) + 1];

        assert!(chat_completion_stream_limits(&state_with("ok", &unended, 0)).is_err());
    }

    #[test]
    fn a_model_that_only_thinks_is_refused_at_its_reasoning_limit() {
        let at_limit = state_with("", b"", u64::from(REASONING_BYTES_MAX));
        let past_limit = state_with("", b"", u64::from(REASONING_BYTES_MAX) + 1);

        chat_completion_stream_limits(&at_limit).unwrap();
        assert!(chat_completion_stream_limits(&past_limit).is_err());
    }
}
