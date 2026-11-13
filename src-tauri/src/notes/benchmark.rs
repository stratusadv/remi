use super::ask::{PROMPT_ASK_SYSTEM, REASONING_EFFORT_ASK, plan_build, prompt_build};
use super::evaluation::endpoint_manual;
use super::remote::{ChatPrompts, ReplyShape, build_request};
use crate::endpoints::types::APIEndpoint;
use crate::http::{ClientTimeouts, client_build};
use crate::search::evaluation::{CASES, corpus_save_large, local};
use crate::search::{self, QUERIES_MAX, RankPlan, Scope};
use crate::workspace::test_support::root_scoped;
use futures_util::StreamExt;
use serde_json::Value;
use std::fmt::Write as _;
use std::iter::repeat_with;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::runtime::Runtime;

const CONNECTION_ROUND_COUNT: u32 = 5;
const EVENTS_PER_CHUNK_MAX: u32 = 4096;
const NOW: &str = "2026-11-11 15:00";
const PROBE_CHARACTERS: [u32; 3] = [30_000, 60_000, 120_000];
const QUESTION_COUNT: u32 = 6;

const PROBE_QUESTIONS: [&str; 4] = [
    "Who owns the retry work?",
    "When is the invoice deadline?",
    "When does the Tailspin Toys launch?",
    "Who compares the battery packs?",
];

const TIMEOUTS: ClientTimeouts = ClientTimeouts {
    connect: Duration::from_secs(15),
    read: Some(Duration::from_secs(120)),
    request: Duration::from_mins(15),
};

#[derive(Clone, Copy, Debug)]
enum Layout {
    DocumentFirst,
    QuestionFirst,
}

#[derive(Debug)]
struct Live {
    client: reqwest::Client,
    endpoint: APIEndpoint,
    runtime: Runtime,
}

#[derive(Clone, Copy, Debug)]
struct ProbeParts<'text> {
    document: &'text str,
    marker: &'text str,
    question: &'text str,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Reading {
    FirstWord,
    Whole,
}

#[derive(Debug, Default)]
struct StreamTiming {
    content_chars: u32,
    content_first: Option<Duration>,
    reasoning_chars: u32,
    total: Duration,
}

impl Layout {
    const fn label(self) -> &'static str {
        match self {
            Self::DocumentFirst => "document first",
            Self::QuestionFirst => "question first",
        }
    }
}

impl StreamTiming {
    const fn done(&self, reading: Reading) -> bool {
        match reading {
            Reading::FirstWord => self.content_first.is_some(),
            Reading::Whole => false,
        }
    }
}

fn answers_time(live: &Live, prompts: &[String]) {
    assert_ne!(prompts.len(), 0);

    for model in models_listed("REMI_BENCH_ANSWER_MODELS", &live.endpoint) {
        for reasoning in [Some(REASONING_EFFORT_ASK), None] {
            let endpoint = endpoint_with(&live.endpoint, &model, reasoning);

            let timings: Vec<StreamTiming> = prompts
                .iter()
                .map(|prompt| {
                    let chat = ChatPrompts { system: PROMPT_ASK_SYSTEM, user: prompt };

                    live.runtime.block_on(stream_timed(
                        &live.client,
                        &endpoint,
                        &chat,
                        Reading::Whole,
                    ))
                })
                .collect();

            let label = format!("{model}, thinking {}", reasoning.unwrap_or("off"));

            assert_eq!(timings.len(), prompts.len());

            timings_report(&label, &timings);
        }
    }
}

fn client_fresh() -> reqwest::Client {
    client_build(&TIMEOUTS).unwrap()
}

fn connections_time(live: &Live) {
    let cold: Vec<Duration> =
        repeat_with(|| live.runtime.block_on(request_models(&client_fresh(), &live.endpoint)))
            .take(usize_of!(CONNECTION_ROUND_COUNT))
            .collect();

    let warm: Vec<Duration> =
        repeat_with(|| live.runtime.block_on(request_models(&live.client, &live.endpoint)))
            .take(usize_of!(CONNECTION_ROUND_COUNT))
            .collect();

    assert_eq!(cold.len(), usize_of!(CONNECTION_ROUND_COUNT));
    assert_eq!(warm.len(), cold.len());

    summary("model list on a new connection", &cold);
    summary("model list on a warm connection", &warm);
}

fn document_of(corpus_text: &str, characters: u32) -> String {
    assert_ne!(corpus_text, "");
    assert!(characters > 0);

    let length = u32::try_from(corpus_text.chars().count()).unwrap();
    let sections = characters.div_ceil(length);
    let mut document = String::with_capacity(usize_of!(characters) + corpus_text.len());

    for section in 0..=sections {
        write!(document, "Section {section}.\n\n{corpus_text}\n\n").unwrap();
    }

    let trimmed: String = document.chars().take(usize_of!(characters)).collect();

    assert_eq!(trimmed.chars().count(), usize_of!(characters));

    trimmed
}

fn endpoint_with(endpoint: &APIEndpoint, model: &str, reasoning: Option<&str>) -> APIEndpoint {
    assert_ne!(model, "");
    assert!(reasoning.is_none_or(|effort| !effort.is_empty()));

    let mut changed = endpoint.clone();

    changed.model = model.to_owned();
    changed.reasoning_effort = reasoning.map(str::to_owned);

    changed
}

fn events_drain(buffer: &mut Vec<u8>) -> Vec<Value> {
    let mut events: Vec<Value> = Vec::new();

    buffer.retain(|byte| *byte != b'\r');

    for _event in 0..EVENTS_PER_CHUNK_MAX {
        let Some(end) = buffer.windows(2).position(|pair| pair == b"\n\n") else {
            break;
        };

        let event: Vec<u8> = buffer.drain(..end + 2).collect();

        for line in String::from_utf8_lossy(&event).lines() {
            let Some(data) = line.strip_prefix("data:").map(str::trim) else {
                continue;
            };

            if let Ok(value) = serde_json::from_str::<Value>(data) {
                events.push(value);
            }
        }
    }

    assert!(buffer.windows(2).all(|pair| pair != b"\n\n"));
    assert!(events.len() <= usize_of!(EVENTS_PER_CHUNK_MAX) * 8);

    events
}

fn models_listed(variable: &str, endpoint: &APIEndpoint) -> Vec<String> {
    let listed: Vec<String> = std::env::var(variable)
        .unwrap_or_else(|_missing| endpoint.model.clone())
        .split(',')
        .map(str::trim)
        .filter(|model| !model.is_empty())
        .map(str::to_owned)
        .collect();

    assert_ne!(listed.len(), 0);
    assert!(listed.iter().all(|model| !model.contains(',')));

    listed
}

fn nonce() -> String {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();

    assert!(nanos > 0);

    format!("Benchmark run {nanos}.")
}

fn parses_time(live: &Live) -> Vec<(&'static str, RankPlan)> {
    let cases = CASES;
    let mut plans: Vec<(&'static str, RankPlan)> = Vec::new();

    for model in models_listed("REMI_BENCH_PARSE_MODELS", &live.endpoint) {
        let endpoint = endpoint_with(&live.endpoint, &model, None);
        let mut samples: Vec<Duration> = Vec::new();

        for case in cases.iter().take(usize_of!(QUESTION_COUNT)) {
            let start = Instant::now();

            let built =
                live.runtime.block_on(plan_build(&endpoint, case.question, &[], local(NOW)));

            samples.push(start.elapsed());

            assert_ne!(built.question, "");
            assert!(built.plan.queries.len() <= usize_of!(QUERIES_MAX));

            if model == live.endpoint.model {
                plans.push((case.question, built.plan));
            }
        }

        summary(&format!("query rewriting call with {model}"), &samples);
    }

    assert_eq!(plans.len(), usize_of!(QUESTION_COUNT));
    assert!(plans.iter().all(|(question, _plan)| !question.is_empty()));

    plans
}

fn probe_prompt(layout: Layout, parts: ProbeParts<'_>) -> String {
    assert_ne!(parts.document, "");
    assert_ne!(parts.question, "");

    let ProbeParts { document, marker, question } = parts;

    let prompt = match layout {
        Layout::DocumentFirst => {
            format!("{marker}\n\n{document}\n\nQuestion: {question}\n\nAnswer:")
        }
        Layout::QuestionFirst => {
            format!("Question: {question}\n\n{marker}\n\n{document}\n\nAnswer:")
        }
    };

    assert!(prompt.contains(document));
    assert!(prompt.ends_with("Answer:"));

    prompt
}

fn probe_time(live: &Live, prompts: &[String]) {
    let corpus_text = prompts.join("\n\n");
    let endpoint = endpoint_with(&live.endpoint, &live.endpoint.model, None);

    assert_ne!(corpus_text, "");

    for characters in PROBE_CHARACTERS {
        let document = document_of(&corpus_text, characters);

        for layout in [Layout::DocumentFirst, Layout::QuestionFirst] {
            let marker = nonce();

            let seconds: Vec<String> = PROBE_QUESTIONS
                .iter()
                .map(|question| {
                    let parts = ProbeParts { document: &document, marker: &marker, question };
                    let user = probe_prompt(layout, parts);
                    let chat = ChatPrompts { system: PROMPT_ASK_SYSTEM, user: &user };

                    let timing = live.runtime.block_on(stream_timed(
                        &live.client,
                        &endpoint,
                        &chat,
                        Reading::FirstWord,
                    ));

                    format!("{:.2} s", timing.content_first.unwrap().as_secs_f64())
                })
                .collect();

            assert_eq!(seconds.len(), PROBE_QUESTIONS.len());

            println!(
                "BENCH first word at {characters} characters, {}: {}",
                layout.label(),
                seconds.join(", "),
            );
        }
    }
}

fn prompts_build(plans: &[(&'static str, RankPlan)]) -> Vec<String> {
    assert_ne!(plans.len(), 0);

    let start = Instant::now();

    let prompts: Vec<String> = plans
        .iter()
        .map(|(question, plan)| {
            let excerpts = search::excerpts_rank(plan, &Scope::All).unwrap();

            prompt_build(question, &[], &excerpts, local(NOW)).unwrap().user
        })
        .collect();

    let elapsed = start.elapsed();

    let sizes: Vec<u32> =
        prompts.iter().map(|prompt| u32::try_from(prompt.chars().count()).unwrap()).collect();

    assert_eq!(prompts.len(), plans.len());
    assert!(prompts.iter().all(|prompt| prompt.ends_with("Answer:")));

    println!("BENCH local search and prompt building, {} questions: {elapsed:?}", prompts.len());
    println!("BENCH answer prompt sizes in characters: {sizes:?}");

    prompts
}

async fn request_models(client: &reqwest::Client, endpoint: &APIEndpoint) -> Duration {
    let url = format!("{}/v1/models", endpoint.host_resolved().trim_end_matches('/'));
    let start = Instant::now();
    let response = client.get(url).bearer_auth(endpoint.api_key_resolved()).send().await.unwrap();
    let status = response.status();
    let body = response.bytes().await.unwrap();
    let elapsed = start.elapsed();

    assert!(status.is_success());
    assert!(!body.is_empty());

    elapsed
}

async fn stream_timed(
    client: &reqwest::Client,
    endpoint: &APIEndpoint,
    prompts: &ChatPrompts<'_>,
    reading: Reading,
) -> StreamTiming {
    let (url, body, api_key) = build_request(endpoint, prompts, ReplyShape::Streamed);
    let start = Instant::now();
    let response = client.post(url).bearer_auth(api_key).json(&body).send().await.unwrap();
    let mut stream = response.error_for_status().unwrap().bytes_stream();
    let mut buffer: Vec<u8> = Vec::new();
    let mut timing = StreamTiming::default();

    while let Some(chunk) = stream.next().await {
        buffer.extend_from_slice(&chunk.unwrap());

        for event in events_drain(&mut buffer) {
            timing_add(&mut timing, &event, start.elapsed());
        }

        if timing.done(reading) {
            break;
        }
    }

    timing.total = start.elapsed();

    assert!(timing.content_first.is_some(), "the service streamed no answer text");
    assert!(timing.content_first <= Some(timing.total));

    timing
}

fn summary(label: &str, samples: &[Duration]) {
    assert_ne!(samples.len(), 0);

    let mut sorted = samples.to_vec();

    sorted.sort();

    let median = sorted[sorted.len().div_euclid(2)];
    let worst = sorted[sorted.len() - 1];

    assert!(median <= worst);

    println!(
        "BENCH {label}: median {:.2} s, worst {:.2} s, over {}",
        median.as_secs_f64(),
        worst.as_secs_f64(),
        sorted.len(),
    );
}

fn timing_add(timing: &mut StreamTiming, event: &Value, elapsed: Duration) {
    assert!(elapsed > Duration::ZERO);
    assert!(timing.content_first.is_none_or(|first| first <= elapsed));

    let delta = &event["choices"][0]["delta"];
    let reasoning = delta["reasoning_content"].as_str().unwrap_or_default();
    let content = delta["content"].as_str().unwrap_or_default();

    timing.reasoning_chars += u32::try_from(reasoning.chars().count()).unwrap();
    timing.content_chars += u32::try_from(content.chars().count()).unwrap();

    if content.is_empty() {
        return;
    }

    if timing.content_first.is_none() {
        timing.content_first = Some(elapsed);
    }
}

fn timings_report(label: &str, timings: &[StreamTiming]) {
    assert_ne!(label, "");
    assert_ne!(timings.len(), 0);

    let first: Vec<Duration> = timings.iter().filter_map(|timing| timing.content_first).collect();
    let total: Vec<Duration> = timings.iter().map(|timing| timing.total).collect();

    assert_eq!(first.len(), timings.len());

    summary(&format!("first answer word, {label}"), &first);
    summary(&format!("whole answer, {label}"), &total);

    let reasoning_chars: Vec<u32> = timings.iter().map(|timing| timing.reasoning_chars).collect();
    let content_chars: Vec<u32> = timings.iter().map(|timing| timing.content_chars).collect();

    println!("BENCH reasoning characters streamed, {label}: {reasoning_chars:?}");
    println!("BENCH answer characters streamed, {label}: {content_chars:?}");
}

#[test]
#[ignore = "benchmark: run with just bench-live"]
fn benchmark_ask_against_the_live_service() {
    let live = Live {
        client: client_fresh(),
        endpoint: endpoint_manual(),
        runtime: Runtime::new().unwrap(),
    };

    let _root = root_scoped();
    let ids = corpus_save_large();

    assert!(ids.len() > usize_of!(QUESTION_COUNT));

    connections_time(&live);

    let plans = parses_time(&live);
    let prompts = prompts_build(&plans);

    answers_time(&live, &prompts);
    probe_time(&live, &prompts);
}
