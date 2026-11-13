use super::ask::{PROMPT_ASK_SYSTEM, REASONING_EFFORT_ASK, excerpts_find, prompt_build};
use super::remote::{
    ChatPrompts,
    ReplySchema,
    build_request_counted,
    chat_completion,
    chat_completion_structured,
    stream_event_tokens,
};
use crate::endpoints::types::{APIEndpoint, APIEndpointPurpose};
use crate::http::{ClientTimeouts, client_build};
use crate::search::Scope;
use crate::search::evaluation::{
    CASE_BOUNDARY,
    CASES,
    CASES_MEANING,
    QUESTIONS_UNANSWERABLE,
    corpus_save,
    corpus_save_large,
    local,
};
use crate::workspace::test_support::root_scoped;
use chrono::{DateTime, Local};
use serde::Deserialize;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::LazyLock;
use std::time::Duration;
use tokio::runtime::Runtime;

const GRADE_SCHEMA_NAME: &str = "answer_grade";
const GRADE_TOKENS_MAX: u32 = 400;
const NOW: &str = "2026-11-11 15:00";
const REFERENCE_NONE: &str = "NONE";
const SSE_DATA_PREFIX: &str = "data:";
const SSE_DONE: &str = "[DONE]";
const THINKING_OFF: &str = "off";

const TOKENS_TIMEOUTS: ClientTimeouts = ClientTimeouts {
    connect: Duration::from_secs(15),
    read: Some(Duration::from_secs(120)),
    request: Duration::from_mins(15),
};

const PROMPT_GRADE_SYSTEM: &str = concat!(
    "You grade an answer to a question about a user's meetings against a reference answer. ",
    "Reply with JSON only.\n\n",
    "- correct: true when the answer states the facts of the reference, in any wording, and ",
    "says nothing that contradicts it. Extra true detail is fine. When the reference is NONE, ",
    "correct is true only when the answer says it could not find the information and gives ",
    "no facts as an answer.\n",
    "- reason: one short sentence.",
);

static GRADE_SCHEMA: LazyLock<Value> = LazyLock::new(|| {
    serde_json::json!({
        "type": "object",
        "properties": {
            "correct": { "type": "boolean" },
            "reason": { "type": "string" },
        },
        "required": ["correct", "reason"],
        "additionalProperties": false,
    })
});

#[derive(Clone, Copy, Debug)]
struct Asked<'text> {
    question: &'text str,
    reference: &'text str,
}

#[derive(Debug, Deserialize)]
struct Grade {
    correct: bool,
    reason: String,
}

#[derive(Clone, Copy, Debug)]
struct Counted {
    answer: Option<u32>,
    chars: u32,
    parse: u32,
}

#[derive(Debug)]
struct Outcome {
    answer: String,
    cited: BTreeSet<String>,
    markers: BTreeMap<String, String>,
}

async fn answer_tokens_streamed(endpoint: &APIEndpoint, prompts: &ChatPrompts<'_>) -> Option<u32> {
    let (url, body, api_key) = build_request_counted(endpoint, prompts);
    let client = client_build(&TOKENS_TIMEOUTS).unwrap();
    let mut request = client.post(&url).json(&body);

    if !api_key.is_empty() {
        request = request.bearer_auth(api_key);
    }

    let response = request.send().await.unwrap().error_for_status().unwrap();
    let events = response.text().await.unwrap();

    assert!(events.contains(SSE_DATA_PREFIX), "the answer streamed no events");

    let tokens = events
        .lines()
        .filter_map(|line| line.strip_prefix(SSE_DATA_PREFIX).map(str::trim))
        .filter(|payload| !payload.is_empty() && *payload != SSE_DONE)
        .filter_map(|payload| serde_json::from_str::<Value>(payload).ok())
        .filter_map(|event| stream_event_tokens(&event))
        .next_back();

    assert!(tokens.is_none_or(|count| count > 0));

    tokens
}

async fn answer_of(endpoint: &APIEndpoint, question: &str, now: DateTime<Local>) -> Outcome {
    let found = excerpts_find(endpoint, question, &[], Scope::All, now).await.unwrap();
    let built = prompt_build(question, &[], &found.excerpts, now).unwrap();
    let prompts = ChatPrompts { system: PROMPT_ASK_SYSTEM, user: &built.user };
    let answer = chat_completion(endpoint, &prompts).await.unwrap();

    let markers: BTreeMap<String, String> = (1_u32..)
        .zip(&built.sources)
        .map(|(number, source)| (format!("M{number}"), source.job_id().to_owned()))
        .collect();

    assert_eq!(markers.len(), built.sources.len());
    assert_ne!(answer, "");

    Outcome { cited: markers_cited(&answer), answer, markers }
}

pub(super) fn endpoint_manual() -> APIEndpoint {
    let host = std::env::var("REMI_MANUAL_NOTES_HOST").expect("a notes host");
    let model = std::env::var("REMI_MANUAL_NOTES_MODEL").expect("a notes model");
    let api_key = std::env::var("REMI_MANUAL_NOTES_KEY").unwrap_or_default();
    let has_api_key = !api_key.is_empty();

    let thinking = std::env::var("REMI_MANUAL_NOTES_THINKING")
        .unwrap_or_else(|_missing| REASONING_EFFORT_ASK.to_owned());

    let reasoning_effort = (thinking != THINKING_OFF).then_some(thinking);

    assert_ne!(host.trim(), "");
    assert_ne!(model.trim(), "");

    APIEndpoint {
        id: "manual-notes".to_owned(),
        name: "Notes".to_owned(),
        purpose: APIEndpointPurpose::Notes,
        host,
        api_key,
        model,
        temperature: None,
        output_tokens_max: None,
        api_path_chat: None,
        api_path_transcribe: None,
        transcribe_verbose: None,
        transcribe_chunk_seconds: None,
        reasoning_effort,
        has_api_key,
    }
}

async fn grade_of(endpoint: &APIEndpoint, user: &str) -> Grade {
    let prompts = ChatPrompts { system: PROMPT_GRADE_SYSTEM, user };

    let reply = ReplySchema {
        name: GRADE_SCHEMA_NAME,
        schema: &GRADE_SCHEMA,
        tokens_max: GRADE_TOKENS_MAX,
    };

    let text = chat_completion_structured(endpoint, &prompts, &reply).await.unwrap().text;
    let json = text.get(text.find('{').unwrap()..=text.rfind('}').unwrap()).unwrap();

    assert!(json.starts_with('{'));
    assert!(json.ends_with('}'));

    serde_json::from_str(json).unwrap()
}

fn grade_prompt(asked: Asked<'_>, answer: &str) -> String {
    assert_ne!(asked.question, "");
    assert_ne!(asked.reference, "");

    let Asked { question, reference } = asked;

    format!("Question: {question}\n\nReference: {reference}\n\nAnswer: {answer}")
}

fn markers_cited(answer: &str) -> BTreeSet<String> {
    let mut cited: BTreeSet<String> = BTreeSet::new();

    for group in answer.split('[').skip(1) {
        let Some((inner, _rest)) = group.split_once(']') else {
            continue;
        };

        for part in inner.split(',').map(str::trim) {
            let Some(digits) = part.strip_prefix('M') else {
                continue;
            };

            if digits.is_empty() {
                continue;
            }

            if digits.bytes().all(|byte| byte.is_ascii_digit()) {
                let _inserted = cited.insert(part.to_owned());
            }
        }
    }

    assert!(cited.iter().all(|marker| marker.starts_with('M')));
    assert!(cited.iter().all(|marker| answer.contains(marker.as_str())));

    cited
}

fn question_run(runtime: &Runtime, endpoint: &APIEndpoint, asked: Asked<'_>) -> (Outcome, Grade) {
    assert_ne!(asked.question, "");
    assert_ne!(asked.reference, "");

    let outcome = runtime.block_on(answer_of(endpoint, asked.question, local(NOW)));
    let grade = runtime.block_on(grade_of(endpoint, &grade_prompt(asked, &outcome.answer)));

    (outcome, grade)
}

async fn tokens_counted(endpoint: &APIEndpoint, question: &str, now: DateTime<Local>) -> Counted {
    let found = excerpts_find(endpoint, question, &[], Scope::All, now).await.unwrap();
    let built = prompt_build(question, &[], &found.excerpts, now).unwrap();
    let prompts = ChatPrompts { system: PROMPT_ASK_SYSTEM, user: &built.user };
    let answer = answer_tokens_streamed(endpoint, &prompts).await;
    let chars = u32::try_from(PROMPT_ASK_SYSTEM.len() + built.user.len()).unwrap();

    assert!(chars > 0);
    assert!(built.sources.len() <= found.excerpts.len());

    Counted { answer, chars, parse: found.tokens }
}

fn tokens_summary(label: &str, counted: &[Counted]) {
    let mut totals: Vec<u32> =
        counted.iter().map(|count| count.parse + count.answer.unwrap_or(0)).collect();

    totals.sort_unstable();

    let count = totals.len();

    assert!(count > 0);
    assert_eq!(count, counted.len());

    let chars: u64 = counted.iter().map(|entry| u64::from(entry.chars)).sum();
    let tokens: u64 = totals.iter().copied().map(u64::from).sum();
    let missing = counted.iter().filter(|entry| entry.answer.is_none()).count();

    println!(
        "TOKENS {label}: {count} questions, median {}, p90 {}, max {}, {tokens} tokens over \
         {chars} prompt characters, {missing} answers without usage",
        totals[count.div_euclid(2)],
        totals[(count * 9).div_euclid(10)],
        totals[count - 1],
    );
}

#[test]
fn markers_are_read_from_single_and_grouped_citations_only() {
    let answer = "Ben owns it [M2]. Ana agreed [M1, M4]. See [Monday] and [M3 notes].";
    let expected: BTreeSet<String> = ["M1", "M2", "M4"].map(str::to_owned).into();

    assert_eq!(markers_cited(answer), expected);
    assert!(markers_cited("No citations at all.").is_empty());
    assert!(markers_cited("Cut off at [M1").is_empty());
}

#[test]
#[ignore = "manual: answers the labelled set with REMI_MANUAL_NOTES_HOST, _MODEL, and _KEY"]
fn manual_answers_are_right_cite_their_meeting_and_refuse_what_was_never_said() {
    let endpoint = endpoint_manual();
    let runtime = Runtime::new().unwrap();
    let _root = root_scoped();
    let ids = corpus_save_large();
    let mut misses: Vec<String> = Vec::new();
    let mut passed = 0_u32;

    for case in CASES.iter().chain(&CASES_MEANING).chain([&CASE_BOUNDARY]) {
        let question = case.question;
        let asked = Asked { question, reference: case.reference };
        let (outcome, grade) = question_run(&runtime, &endpoint, asked);
        let expected = &ids[case.expected];
        let cites_known = outcome.cited.iter().all(|marker| outcome.markers.contains_key(marker));

        let cites_meeting =
            outcome.cited.iter().any(|marker| outcome.markers.get(marker) == Some(expected));

        println!("MANUAL {} {cites_meeting} {question:?}: {}", grade.correct, outcome.answer);

        let problem = match (grade.correct, cites_known, cites_meeting) {
            (false, _, _) => Some("is wrong"),
            (true, false, _) => Some("cites a marker it was never given"),
            (true, true, false) => Some("never cites its meeting"),
            (true, true, true) => None,
        };

        let Some(failure) = problem else {
            passed += 1;

            continue;
        };

        misses.push(format!("{question:?} {failure}: {} ({})", outcome.answer, grade.reason));
    }

    for question in QUESTIONS_UNANSWERABLE {
        let asked = Asked { question, reference: REFERENCE_NONE };
        let (outcome, grade) = question_run(&runtime, &endpoint, asked);

        println!("MANUAL {} {question:?}: {}", grade.correct, outcome.answer);

        if !grade.correct {
            let answered = format!("{question:?} was answered: {}", outcome.answer);

            misses.push(format!("{answered} ({})", grade.reason));
        }
    }

    println!("MANUAL {passed} of {} passed every check", CASES.len() + CASES_MEANING.len() + 1);

    assert!(misses.is_empty(), "{misses:#?}");
}

#[test]
#[ignore = "manual: counts tokens per question with REMI_MANUAL_NOTES_HOST, _MODEL, and _KEY"]
fn manual_tokens_per_question_on_a_small_and_a_large_library() {
    let endpoint = endpoint_manual();
    let runtime = Runtime::new().unwrap();

    let questions: Vec<&str> = CASES
        .iter()
        .chain(&CASES_MEANING)
        .map(|case| case.question)
        .chain(QUESTIONS_UNANSWERABLE)
        .collect();

    for large in [false, true] {
        let _root = root_scoped();
        let ids = if large { corpus_save_large() } else { corpus_save() };
        let label = if large { "large library" } else { "small library" };
        let mut counted: Vec<Counted> = Vec::with_capacity(questions.len());

        assert!(!ids.is_empty());

        for question in &questions {
            let count = runtime.block_on(tokens_counted(&endpoint, question, local(NOW)));

            println!(
                "TOKENS {label} parse {} answer {:?} chars {} {question:?}",
                count.parse, count.answer, count.chars,
            );

            counted.push(count);
        }

        tokens_summary(label, &counted);

        assert!(counted.iter().all(|count| count.answer.is_some()), "a stream carried no usage");
    }
}
