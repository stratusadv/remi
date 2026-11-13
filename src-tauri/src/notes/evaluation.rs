use super::ask::{PROMPT_ASK_SYSTEM, REASONING_EFFORT_ASK, excerpts_find, prompt_build};
use super::remote::{ChatPrompts, ReplySchema, chat_completion, chat_completion_structured};
use crate::endpoints::types::{APIEndpoint, APIEndpointPurpose};
use crate::search::Scope;
use crate::search::evaluation::{
    CASE_BOUNDARY,
    CASES,
    CASES_MEANING,
    QUESTIONS_UNANSWERABLE,
    corpus_save_large,
    local,
};
use crate::workspace::test_support::root_scoped;
use chrono::{DateTime, Local};
use serde::Deserialize;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::LazyLock;
use tokio::runtime::Runtime;

const GRADE_SCHEMA_NAME: &str = "answer_grade";
const GRADE_TOKENS_MAX: u32 = 400;
const NOW: &str = "2026-11-11 15:00";
const REFERENCE_NONE: &str = "NONE";
const THINKING_OFF: &str = "off";

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

#[derive(Debug)]
struct Outcome {
    answer: String,
    cited: BTreeSet<String>,
    markers: BTreeMap<String, String>,
}

async fn answer_of(endpoint: &APIEndpoint, question: &str, now: DateTime<Local>) -> Outcome {
    let excerpts = excerpts_find(endpoint, question, &[], Scope::All, now).await.unwrap();
    let built = prompt_build(question, &[], &excerpts, now).unwrap();
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

    let text = chat_completion_structured(endpoint, &prompts, &reply).await.unwrap();
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
