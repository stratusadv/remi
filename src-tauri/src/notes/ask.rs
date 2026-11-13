use super::remote::{
    ChatPrompts,
    Completion,
    ReplySchema,
    chat_completion_streaming,
    chat_completion_streaming_counted,
    chat_completion_structured,
    models_list,
};
use crate::account::{self, QuestionAccount, QuestionFinish, QuestionStarted};
use crate::blocking;
use crate::cancellation::is_cancelled;
use crate::contract::{EndpointID, Instruction, StreamID};
use crate::endpoints::storage::{ENDPOINT_ID_NOTES, endpoint_load};
use crate::endpoints::types::APIEndpoint;
use crate::error::{AppError, AppResult};
use crate::people::storage::{Person, people_load_all};
use crate::search::chunk::{self, ChunkSource};
use crate::search::{self, Excerpt, QUERIES_MAX, RankPlan, SNIPPET_ELLIPSIS, Scope, query, vector};
use crate::state::AppState;
use crate::workspace::{self, JobMeta};
use chrono::{DateTime, Local, TimeZone};
use num_traits::ToPrimitive;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

const CITATION_GROUPS_MAX: u32 = 512;
const CITATION_MARKERS_MAX: u32 = 8;
const DATE_FORMAT: &str = "%A %-d %B %Y, %H:%M";
const EVENT_ASK_SOURCES: &str = "notes_ask_sources";
const EVENT_ASK_WAIT: &str = "notes_ask_wait";
const HISTORY_ANSWER_CHARS_MAX: u32 = 2000;
const HISTORY_TURNS_MAX: u32 = 4;
const MESSAGE_CANCELLED: &str = "Cancelled";
const MESSAGE_NOTHING_INDEXED: &str = "There are no notes or transcripts to search here yet.";
const MESSAGE_TURN_MISSED: &str =
    "remi could not get a turn for this question. Ask again in a few minutes.";
const NAMES_KNOWN_MAX: u32 = 200;
const NAMES_PARSED_MAX: u32 = 8;
const PARSE_QUERIES_MAX: u32 = 3;
const PARSE_SCHEMA_NAME: &str = "meeting_search";
const PARSE_TIMEOUT_SECONDS: u64 = 8;
const PARSE_TOKENS_MAX: u32 = 600;
pub(super) const QUESTION_CHARS_MAX: u32 = 1000;
const QUESTION_WAIT_SECONDS_MAX: u32 = 3600;
const QUESTION_WAIT_TICK: Duration = Duration::from_secs(1);
const QUESTION_WAITS_MAX: u32 = 4;
pub(super) const REASONING_EFFORT_ASK: &str = "low";
const SNIPPET_CHARS_MAX: u32 = 200;
const TITLE_UNTITLED: &str = "Untitled recording";
const WARM_INTERVAL_SECONDS: u64 = 30;

const _: () = assert!(PARSE_QUERIES_MAX < QUERIES_MAX);
const _: () = assert!(WARM_INTERVAL_SECONDS > PARSE_TIMEOUT_SECONDS);
const _: () = assert!(NAMES_PARSED_MAX < NAMES_KNOWN_MAX);
const _: () = assert!(QUESTION_CHARS_MAX < HISTORY_ANSWER_CHARS_MAX);
const _: () = assert!(SNIPPET_CHARS_MAX < chunk::CHUNK_CHARS_MAX);

pub(super) const PROMPT_ASK_SYSTEM: &str = concat!(
    "You answer questions about the user's own past meetings inside a meeting-notes app. The ",
    "user gives excerpts from their meetings, then today's date, any earlier questions and ",
    "answers from this conversation, and the question. The excerpts are grouped under the ",
    "meeting they come from, with its title, date, project, and people, and each excerpt is ",
    "headed by a marker such as [M1].\n\n",
    "Strict output rules:\n",
    "- Answer only from the excerpts. Never guess, and never use outside knowledge.\n",
    "- The earlier questions and answers only show what the question refers back to, such as ",
    "who \"she\" is or what \"that\" means. Never answer from an earlier answer.\n",
    "- The question may word things differently from the meeting, and the transcript may ",
    "mishear words, so match on meaning rather than exact wording. When the meeting phrases it ",
    "differently, answer with the meeting's own wording.\n",
    "- Dates in the question, such as last week or a month ago, count back from today's date. ",
    "Use each meeting's date to decide which meeting the question means.\n",
    "- After each statement, cite the excerpt it came from with its marker in square ",
    "brackets, such as [M2]. Cite every excerpt you draw on, each in its own brackets.\n",
    "- When the excerpts do not answer the question, say in one sentence that you could not ",
    "find it in their meetings.\n",
    "- Keep the answer short: a few sentences, or a short list when it has several parts.\n",
    "- Write plain text. No headings, no tables, no bold, no raw HTML, no preamble.\n",
    "- Write in the language of the question.",
);

const PROMPT_PARSE_SYSTEM: &str = concat!(
    "You turn a question about the user's past meetings into keyword searches over their ",
    "meeting notes and transcripts. Reply with JSON only.\n\n",
    "- question: the question rewritten to stand on its own. When it refers back to the earlier ",
    "conversation, such as \"what about Sam?\" or \"when is that due?\", fill in what it means ",
    "from that conversation. Otherwise repeat the question unchanged.\n",
    "- queries: one to three searches for the topic of the rewritten question. Each search is a ",
    "few plain keywords: the question's own key words first, then other words people would ",
    "likely say out loud about the same thing, such as synonyms, product names, and everyday ",
    "terms. Leave out dates, times, names of people, and filler words.\n",
    "- names: the people the question mentions, written as they appear in the list of known ",
    "people when one matches. Leave it empty when the question mentions nobody.",
);

static PARSE_SCHEMA: LazyLock<Value> = LazyLock::new(|| {
    serde_json::json!({
        "type": "object",
        "properties": {
            "question": { "type": "string" },
            "queries": { "type": "array", "items": { "type": "string" } },
            "names": { "type": "array", "items": { "type": "string" } },
        },
        "required": ["question", "queries", "names"],
        "additionalProperties": false,
    })
});

#[derive(Debug)]
struct AskCancel {
    app: AppHandle,
    flag: Arc<AtomicBool>,
    stream_id: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Serialize)]
pub(crate) struct AskSource {
    end_seconds: Option<f64>,
    heading: Option<String>,
    job_id: String,
    marker: String,
    segment_index_first: Option<u32>,
    segment_index_last: Option<u32>,
    snippet: String,
    source: ChunkSource,
    start_seconds: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
struct AskSources {
    meetings: Vec<JobMeta>,
    notice: String,
    sources: Vec<AskSource>,
    stream_id: String,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct AskTurn {
    answer: String,
    question: String,
}

#[derive(Debug, Clone, Serialize)]
struct AskWait {
    notice: String,
    stream_id: String,
}

#[derive(Debug)]
pub(super) struct ExcerptsFound {
    pub(super) excerpts: Vec<Excerpt>,
    pub(super) tokens: u32,
}

#[derive(Debug)]
pub(super) struct PlanBuilt {
    pub(super) plan: RankPlan,
    pub(super) question: String,
    pub(super) tokens: u32,
}

#[derive(Debug)]
pub(super) struct PromptBuilt {
    pub(super) meetings: Vec<JobMeta>,
    pub(super) sources: Vec<AskSource>,
    pub(super) user: String,
}

#[derive(Debug)]
struct QuestionAdmitted {
    account: QuestionAccount<'static>,
    notice: String,
    question_id: u64,
    tokens: Option<u32>,
}

#[derive(Debug, Default, Deserialize)]
struct QuestionParse {
    #[serde(default)]
    names: Vec<String>,
    #[serde(default)]
    queries: Vec<String>,
    #[serde(default)]
    question: String,
}

#[derive(Debug, Default)]
pub(crate) struct WarmThrottle {
    warmed_at_unix: AtomicU64,
}

impl AskCancel {
    fn cancelled(&self) -> bool {
        is_cancelled(&self.flag)
    }

    fn register(app: &AppHandle, stream_id: &str) -> Self {
        assert_ne!(stream_id, "");

        let flag = app.state::<AppState>().cancellation.register(stream_id);

        Self { app: app.clone(), flag, stream_id: stream_id.to_owned() }
    }
}

impl Drop for AskCancel {
    fn drop(&mut self) {
        self.app.state::<AppState>().cancellation.clear(&self.stream_id);
    }
}

impl AskSource {
    pub(super) fn job_id(&self) -> &str {
        assert_ne!(self.marker, "");
        assert!(self.marker.starts_with('M'));

        &self.job_id
    }

    fn of(marker: String, excerpt: &Excerpt) -> Self {
        assert!(marker.starts_with('M'));
        assert!(workspace::job_id_is_valid(&excerpt.job_id));

        Self {
            end_seconds: excerpt.end_seconds,
            heading: excerpt.heading.clone(),
            job_id: excerpt.job_id.clone(),
            marker,
            segment_index_first: excerpt.segment_index_first,
            segment_index_last: excerpt.segment_index_last,
            snippet: snippet_of(&excerpt.body),
            source: excerpt.source,
            start_seconds: excerpt.start_seconds,
        }
    }
}

impl QuestionAdmitted {
    fn finish(&self) -> Option<QuestionFinish> {
        assert!(self.question_id > 0);

        let tokens = self.tokens?;
        let bounded = tokens.clamp(1, account::QUESTION_TOKENS_MAX);

        assert!(bounded <= tokens.max(1));

        Some(QuestionFinish::new(self.question_id, bounded))
    }

    fn tally_answer(&mut self, completion: &Completion) {
        assert!(self.question_id > 0);
        assert!(completion.text.len() <= usize_of!(workspace::NOTES_BYTES_MAX));

        self.tokens = self
            .tokens
            .zip(completion.tokens)
            .map(|(counted, answer)| counted.saturating_add(answer));
    }

    fn tally_parse(&mut self, found: &ExcerptsFound) {
        assert!(self.question_id > 0);
        assert!(found.excerpts.len() <= usize_of!(search::EXCERPTS_WHOLE_MAX));

        self.tokens = self.tokens.map(|counted| counted.saturating_add(found.tokens));
    }
}

impl QuestionParse {
    fn standalone(&self, question: &str, history: &[AskTurn]) -> String {
        assert_ne!(question, "");
        assert!(history.len() <= usize_of!(HISTORY_TURNS_MAX));

        let rewritten = self.question.trim();

        let usable = !history.is_empty()
            && !rewritten.is_empty()
            && rewritten.chars().count() <= usize_of!(QUESTION_CHARS_MAX);

        if usable {
            return rewritten.to_owned();
        }

        question.to_owned()
    }
}

impl WarmThrottle {
    fn claim(&self, now_unix: u64) -> bool {
        assert!(now_unix <= i64::MAX.cast_unsigned());

        let warmed = self.warmed_at_unix.load(Ordering::Relaxed);

        if now_unix.saturating_sub(warmed) < WARM_INTERVAL_SECONDS {
            return false;
        }

        let claimed = self
            .warmed_at_unix
            .compare_exchange(warmed, now_unix, Ordering::Relaxed, Ordering::Relaxed)
            .is_ok();

        if claimed {
            assert!(now_unix >= warmed + WARM_INTERVAL_SECONDS);
        }

        claimed
    }
}

#[tauri::command(rename_all = "snake_case")]
pub(crate) async fn notes_ask_streaming(
    app: AppHandle,
    stream_id: StreamID,
    endpoint_id: EndpointID,
    question: Instruction,
    scope: Scope,
    history: Vec<AskTurn>,
) -> AppResult<String> {
    let text = question_validate(&question)?.to_owned();
    let turns = history_validate(&history)?;

    scope.validate()?;

    let mut endpoint = endpoint_load(&endpoint_id)?;

    endpoint.reasoning_effort = Some(REASONING_EFFORT_ASK.to_owned());

    let cancel = AskCancel::register(&app, &stream_id);
    let mut admitted = question_admit(&app, &stream_id, &endpoint_id, &cancel).await?;
    let now = Local::now();
    let found = excerpts_find(&endpoint, &text, &turns, scope, now).await?;

    if cancel.cancelled() {
        return Err(AppError::Service(MESSAGE_CANCELLED.to_owned()));
    }

    if let Some(turn) = admitted.as_mut() {
        turn.tally_parse(&found);
    }

    let question_text = text.clone();
    let excerpts = found.excerpts;
    let built = blocking::run(move || prompt_build(&question_text, &turns, &excerpts, now)).await?;
    let notice = admitted.as_ref().map(|turn| turn.notice.clone()).unwrap_or_default();

    let sources = AskSources {
        meetings: built.meetings,
        notice,
        sources: built.sources,
        stream_id: stream_id.to_string(),
    };

    let answerable = !sources.sources.is_empty();

    sources_emit(&app, sources);

    if !answerable {
        if let Some(turn) = admitted.as_ref() {
            question_finish_logged(turn).await;
        }

        return Ok(MESSAGE_NOTHING_INDEXED.to_owned());
    }

    let prompts = ChatPrompts { system: PROMPT_ASK_SYSTEM, user: &built.user };

    let Some(mut turn) = admitted else {
        return chat_completion_streaming(app, stream_id, &endpoint, &prompts).await;
    };

    let completion = chat_completion_streaming_counted(app, stream_id, &endpoint, &prompts).await?;

    turn.tally_answer(&completion);
    question_finish_logged(&turn).await;

    Ok(completion.text)
}

#[tauri::command]
pub(crate) async fn notes_ask_warm(state: State<'_, AppState>) -> AppResult<()> {
    let now = u64::try_from(Local::now().timestamp()).unwrap_or(0);

    if state.warm_throttle.claim(now) {
        connections_warm().await;
    }

    Ok(())
}

fn citation_group_is(inner: &str) -> bool {
    let markers_max = usize_of!(CITATION_MARKERS_MAX);
    let parts: Vec<&str> = inner.split(',').map(str::trim_start).take(markers_max + 1).collect();

    assert_ne!(parts.len(), 0);
    assert!(parts.len() <= markers_max + 1);

    parts.len() <= markers_max && parts.iter().all(|part| citation_marker_is(part))
}

fn citation_marker_is(text: &str) -> bool {
    text.strip_prefix('M').is_some_and(|digits| {
        !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit())
    })
}

fn citations_strip(text: &str) -> String {
    let mut kept = String::with_capacity(text.len());
    let mut rest = text;

    for _ in 0..CITATION_GROUPS_MAX {
        let Some((before, from)) = rest.find("[M").and_then(|open| rest.split_at_checked(open))
        else {
            break;
        };

        let group = from
            .find(']')
            .and_then(|close| from.get(1..close))
            .filter(|inner| citation_group_is(inner));

        if let Some(inner) = group {
            kept.push_str(before.trim_end());
            rest = from.get(inner.len() + 2..).unwrap_or_default();
        } else {
            kept.push_str(before);
            kept.push('[');
            rest = from.get(1..).unwrap_or_default();
        }
    }

    kept.push_str(rest);

    assert!(kept.len() <= text.len());

    kept
}

fn clock_format(seconds: f64) -> String {
    assert!(seconds >= 0.0_f64);

    let whole = seconds.floor().to_u64().unwrap_or(0);
    let hours = whole.div_euclid(3600);
    let minutes = whole.rem_euclid(3600).div_euclid(60);
    let rest = whole.rem_euclid(60);

    assert!(minutes < 60);
    assert!(rest < 60);

    if hours > 0 {
        return format!("{hours}:{minutes:02}:{rest:02}");
    }

    format!("{minutes}:{rest:02}")
}

async fn connections_warm() {
    match endpoint_load(ENDPOINT_ID_NOTES) {
        Ok(endpoint) => {
            if let Err(error) = models_list(&endpoint).await {
                tracing::debug!(%error, "the notes service connection was not warmed");
            }
        }
        Err(error) => tracing::debug!(%error, "the notes service has no endpoint to warm"),
    }

    vector::connection_warm().await;
}

fn excerpt_block(marker: &str, excerpt: &Excerpt) -> String {
    assert!(marker.starts_with('M'));
    assert_ne!(excerpt.body, "");

    let label = match (excerpt.source, excerpt.start_seconds, excerpt.end_seconds) {
        (ChunkSource::Notes, _, _) => "Notes".to_owned(),
        (ChunkSource::Transcript, Some(start), Some(end)) => {
            format!("Transcript, {} to {}", clock_format(start), clock_format(end))
        }
        (ChunkSource::Transcript, _, _) => "Transcript".to_owned(),
    };

    format!("[{marker}] {label}:\n{}", excerpt.body.trim())
}

pub(super) async fn excerpts_find(
    endpoint: &APIEndpoint,
    question: &str,
    history: &[AskTurn],
    scope: Scope,
    now: DateTime<Local>,
) -> AppResult<ExcerptsFound> {
    let scope_whole = scope.clone();
    let whole = blocking::run(move || search::excerpts_whole(&scope_whole)).await?;

    if let Some(excerpts) = whole {
        return Ok(ExcerptsFound { excerpts, tokens: 0 });
    }

    let (plan, tokens) = if history.is_empty() {
        let (built, meaning) = tokio::join!(
            plan_build(endpoint, question, history, now),
            vector::question_ranked(question, scope.clone()),
        );

        (RankPlan { meaning, ..built.plan }, built.tokens)
    } else {
        let built = plan_build(endpoint, question, history, now).await;
        let meaning = vector::question_ranked(&built.question, scope.clone()).await;

        (RankPlan { meaning, ..built.plan }, built.tokens)
    };

    let excerpts = blocking::run(move || excerpts_ranked(&plan, &scope)).await?;

    Ok(ExcerptsFound { excerpts, tokens })
}

fn excerpts_ranked(plan: &RankPlan, scope: &Scope) -> AppResult<Vec<Excerpt>> {
    let ranked = search::excerpts_rank(plan, scope)?;

    if plan.latest {
        return Ok(ranked);
    }

    if !ranked.is_empty() {
        return Ok(ranked);
    }

    let latest = RankPlan { latest: true, ..RankPlan::default() };
    let recent = search::excerpts_rank(&latest, scope)?;

    assert_eq!(latest.queries.len(), 0);
    assert!(latest.window.is_none());

    Ok(recent)
}

fn history_prefix(turns: &[AskTurn]) -> String {
    assert!(turns.len() <= usize_of!(HISTORY_TURNS_MAX));

    let blocks: Vec<String> = turns
        .iter()
        .map(|turn| {
            format!("Earlier question: {}\nEarlier answer: {}\n\n", turn.question, turn.answer)
        })
        .collect();

    assert_eq!(blocks.len(), turns.len());

    blocks.concat()
}

fn history_validate(history: &[AskTurn]) -> AppResult<Vec<AskTurn>> {
    if history.len() > usize_of!(HISTORY_TURNS_MAX) {
        return Err(AppError::Config(format!(
            "the conversation carries {} earlier questions, over the {HISTORY_TURNS_MAX} this \
             app sends",
            history.len(),
        )));
    }

    let count = history.len();
    let mut turns: Vec<AskTurn> = Vec::with_capacity(count);

    for turn in history {
        let question = question_validate(&turn.question)?.to_owned();

        let clipped: String =
            turn.answer.chars().take(usize_of!(HISTORY_ANSWER_CHARS_MAX)).collect();

        let answer = citations_strip(&clipped).trim().to_owned();

        turns.push(AskTurn { answer, question });
    }

    assert_eq!(turns.len(), count);
    assert!(
        turns.iter().all(|turn| turn.answer.chars().count() <= usize_of!(HISTORY_ANSWER_CHARS_MAX))
    );

    Ok(turns)
}

fn meeting_heading(meta: &JobMeta, people: &[Person]) -> String {
    let names = chunk::people_names(meta, people);
    let held_unix = meta.recorded_at_unix.unwrap_or(meta.created_at_unix);

    let held = Local
        .timestamp_opt(held_unix, 0)
        .single()
        .map_or_else(|| "unknown".to_owned(), |moment| moment.format(DATE_FORMAT).to_string());

    let mut lines = vec![format!("Meeting: {}", meeting_title(meta)), format!("Held: {held}")];

    if let Some(project) =
        meta.project.as_deref().map(str::trim).filter(|project| !project.is_empty())
    {
        lines.push(format!("Project: {project}"));
    }

    if !names.is_empty() {
        lines.push(format!("People: {}", names.join(", ")));
    }

    assert!(lines.len() >= 2);
    assert!(lines.len() <= 4);

    lines.join("\n")
}

pub(super) fn meeting_load(id: &str) -> AppResult<Option<JobMeta>> {
    let Some(meta) = workspace::meta_load(id)? else {
        return Ok(None);
    };

    if meta.id != id {
        tracing::warn!(
            job = %id,
            held = %meta.id,
            "a meeting folder holds another meeting's metadata",
        );

        return Ok(None);
    }

    Ok(Some(meta))
}

fn meeting_title(meta: &JobMeta) -> &str {
    meta.title
        .as_deref()
        .or(meta.label.as_deref())
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .unwrap_or(TITLE_UNTITLED)
}

pub(crate) fn names_known_load() -> AppResult<Vec<String>> {
    let people = people_load_all()?;
    let recent = search::names_recent(NAMES_KNOWN_MAX)?;
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut names: Vec<String> = Vec::new();

    for name in people.iter().map(Person::name_full).chain(recent) {
        if names.len() >= usize_of!(NAMES_KNOWN_MAX) {
            break;
        }

        let trimmed = name.trim();

        if trimmed.is_empty() {
            continue;
        }

        if seen.insert(trimmed.to_lowercase()) {
            names.push(trimmed.to_owned());
        }
    }

    assert_eq!(names.len(), seen.len());
    assert!(names.len() <= usize_of!(NAMES_KNOWN_MAX));

    Ok(names)
}

fn parse_prompt_build(question: &str, history: &[AskTurn], names_known: &[String]) -> String {
    assert_ne!(question, "");
    assert!(names_known.len() <= usize_of!(NAMES_KNOWN_MAX));

    let known =
        if names_known.is_empty() { "none listed".to_owned() } else { names_known.join(", ") };

    let earlier = history_prefix(history);

    format!("Known people: {known}\n\n{earlier}Question: {question}")
}

fn parse_reply(text: &str) -> AppResult<QuestionParse> {
    let bounds = text.find('{').zip(text.rfind('}'));

    let json = bounds
        .filter(|(first, last)| first < last)
        .and_then(|(first, last)| text.get(first..=last))
        .ok_or_else(|| AppError::Service("the notes service did not reply with JSON".into()))?;

    let parsed: QuestionParse = serde_json::from_str(json)?;

    assert!(json.starts_with('{'));
    assert!(json.ends_with('}'));

    Ok(parsed)
}

pub(super) async fn plan_build(
    endpoint: &APIEndpoint,
    question: &str,
    history: &[AskTurn],
    now: DateTime<Local>,
) -> PlanBuilt {
    let names_known = blocking::run(names_known_load).await.unwrap_or_else(|error| {
        tracing::warn!(%error, "the known people could not be listed for the question");

        Vec::new()
    });

    let (reply, tokens) = match question_parse(endpoint, question, history, &names_known).await {
        Ok((parsed, tokens)) => (Some(parsed), tokens),
        Err(error) => {
            tracing::warn!(%error, "the question was searched by its own words alone");

            (None, 0)
        }
    };

    let standalone = reply
        .as_ref()
        .map_or_else(|| question.to_owned(), |parsed| parsed.standalone(question, history));

    let mut plan = RankPlan::of_question(&standalone, now);

    if let Some(parsed) = &reply {
        plan_extend(&mut plan, parsed);
    }

    assert!(plan.queries.len() <= usize_of!(QUERIES_MAX));
    assert_ne!(standalone, "");

    PlanBuilt { plan, question: standalone, tokens }
}

fn plan_extend(plan: &mut RankPlan, parsed: &QuestionParse) {
    let expressions = parsed
        .queries
        .iter()
        .take(usize_of!(PARSE_QUERIES_MAX))
        .filter_map(|text| query::match_any(&query::terms_of(text)));

    for expression in expressions {
        if plan.queries.len() >= usize_of!(QUERIES_MAX) {
            break;
        }

        if !plan.queries.contains(&expression) {
            plan.queries.push(expression);
        }
    }

    let names: Vec<String> = parsed
        .names
        .iter()
        .take(usize_of!(NAMES_PARSED_MAX))
        .map(|name| name.trim().to_owned())
        .collect();

    plan.names = query::match_any(&names);

    assert!(plan.queries.len() <= usize_of!(QUERIES_MAX));
    assert!(names.len() <= usize_of!(NAMES_PARSED_MAX));
}

pub(super) fn prompt_build(
    question: &str,
    history: &[AskTurn],
    excerpts: &[Excerpt],
    now: DateTime<Local>,
) -> AppResult<PromptBuilt> {
    assert_ne!(question, "");
    assert!(excerpts.len() <= usize_of!(search::EXCERPTS_WHOLE_MAX));

    let people = people_load_all()?;
    let mut meetings: Vec<JobMeta> = Vec::new();
    let mut sources: Vec<AskSource> = Vec::with_capacity(excerpts.len());
    let mut blocks: Vec<String> = Vec::with_capacity(excerpts.len() * 2);
    let mut skipped: BTreeSet<&str> = BTreeSet::new();

    for excerpt in excerpts {
        let id = excerpt.job_id.as_str();

        if skipped.contains(id) {
            continue;
        }

        let opened = meetings.last().is_some_and(|meta| meta.id == id);

        if !opened {
            let Some(meta) = meeting_load(id)? else {
                let inserted = skipped.insert(id);

                assert!(inserted);

                continue;
            };

            blocks.push(meeting_heading(&meta, &people));
            meetings.push(meta);
        }

        let marker = format!("M{}", sources.len() + 1);

        blocks.push(excerpt_block(&marker, excerpt));
        sources.push(AskSource::of(marker, excerpt));
    }

    let today = now.format(DATE_FORMAT);
    let earlier = history_prefix(history);
    let body = blocks.join("\n\n");

    let user = format!(
        "Excerpts, grouped by meeting:\n\n{body}\n\n\
         Today is {today}.\n\n{earlier}Question: {question}\n\nAnswer:",
    );

    assert!(sources.len() <= excerpts.len());
    assert!(meetings.len() <= sources.len());

    Ok(PromptBuilt { meetings, sources, user })
}

async fn question_admit(
    app: &AppHandle,
    stream_id: &StreamID,
    endpoint_id: &EndpointID,
    cancel: &AskCancel,
) -> AppResult<Option<QuestionAdmitted>> {
    let Some(account) = account::question_account(endpoint_id).await? else {
        return Ok(None);
    };

    for _attempt in 0..QUESTION_WAITS_MAX {
        let started = account::question_start(&account).await?;

        if let Some(question_id) = started.question_id {
            let notice = started.notice;

            return Ok(Some(QuestionAdmitted { account, notice, question_id, tokens: Some(0) }));
        }

        let wait = AskWait { notice: started.notice.clone(), stream_id: stream_id.to_string() };

        wait_emit(app, wait);
        question_wait(&started, &cancel.flag).await?;
    }

    Err(AppError::Service(MESSAGE_TURN_MISSED.to_owned()))
}

async fn question_finish_logged(turn: &QuestionAdmitted) {
    let Some(finish) = turn.finish() else {
        return;
    };

    let finished = account::question_finish(&turn.account, &finish).await;

    if let Err(error) = finished {
        tracing::warn!(%error, "the tokens of question {} were not recorded", turn.question_id);
    }
}

async fn question_parse(
    endpoint: &APIEndpoint,
    question: &str,
    history: &[AskTurn],
    names_known: &[String],
) -> AppResult<(QuestionParse, u32)> {
    let user = parse_prompt_build(question, history, names_known);
    let prompts = ChatPrompts { system: PROMPT_PARSE_SYSTEM, user: &user };

    let reply = ReplySchema {
        name: PARSE_SCHEMA_NAME,
        schema: &PARSE_SCHEMA,
        tokens_max: PARSE_TOKENS_MAX,
    };

    let completion = chat_completion_structured(endpoint, &prompts, &reply);
    let limit = Duration::from_secs(PARSE_TIMEOUT_SECONDS);

    let completed = tokio::time::timeout(limit, completion).await.map_err(|elapsed| {
        AppError::Service(format!("the notes service did not read the question in time: {elapsed}"))
    })??;

    let parsed = parse_reply(&completed.text)?;

    Ok((parsed, completed.tokens.unwrap_or(0)))
}

pub(super) fn question_validate(question: &str) -> AppResult<&str> {
    let trimmed = question.trim();

    if trimmed.is_empty() {
        return Err(AppError::Config("ask a question first".into()));
    }

    let length = trimmed.chars().count();

    if length > usize_of!(QUESTION_CHARS_MAX) {
        return Err(AppError::Config(format!(
            "the question is {length} characters, over the {QUESTION_CHARS_MAX} this app sends",
        )));
    }

    assert_ne!(trimmed, "");
    assert!(length <= usize_of!(QUESTION_CHARS_MAX));

    Ok(trimmed)
}

async fn question_wait(started: &QuestionStarted, flag: &AtomicBool) -> AppResult<()> {
    if started.wait_seconds > QUESTION_WAIT_SECONDS_MAX {
        return Err(AppError::Service(started.notice.clone()));
    }

    for _second in 0..started.wait_seconds {
        if is_cancelled(flag) {
            return Err(AppError::Service(MESSAGE_CANCELLED.to_owned()));
        }

        tokio::time::sleep(QUESTION_WAIT_TICK).await;
    }

    if is_cancelled(flag) {
        return Err(AppError::Service(MESSAGE_CANCELLED.to_owned()));
    }

    Ok(())
}

fn snippet_marker_is(word: &str) -> bool {
    let ordered = word.strip_suffix(['.', ')']).is_some_and(|digits| {
        !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit())
    });

    let task = matches!(word, "[x]" | "[X]");
    let symbols =
        word.chars().all(|character| matches!(character, '>' | '-' | '*' | '+' | '[' | ']'));

    ordered || task || symbols
}

fn snippet_of(body: &str) -> String {
    let characters_max = usize_of!(SNIPPET_CHARS_MAX);

    let words: Vec<&str> = body
        .lines()
        .filter(|line| !line.trim_start().starts_with('#'))
        .flat_map(|line| line.split_whitespace().skip_while(|word| snippet_marker_is(word)))
        .map(|word| word.trim_matches(['*', '_', '`']))
        .filter(|word| !word.is_empty())
        .take(characters_max)
        .collect();

    let joined = words.join(" ");

    if joined.chars().count() <= characters_max {
        return joined;
    }

    let cut: String = joined.chars().take(characters_max).collect();

    let kept = cut
        .rfind(' ')
        .and_then(|space| cut.get(..space))
        .filter(|kept| !kept.is_empty())
        .unwrap_or(&cut)
        .trim_end_matches([',', '.', ';', ':']);

    assert!(kept.chars().count() <= characters_max);
    assert_ne!(words.len(), 0);

    format!("{kept}{SNIPPET_ELLIPSIS}")
}

fn sources_emit(app: &AppHandle, sources: AskSources) {
    assert_ne!(sources.stream_id, "");
    assert!(sources.meetings.len() <= sources.sources.len());

    if let Err(error) = app.emit(EVENT_ASK_SOURCES, sources) {
        tracing::warn!("ask sources event could not be emitted: {error}");
    }
}

fn wait_emit(app: &AppHandle, wait: AskWait) {
    assert_ne!(wait.stream_id, "");
    assert_ne!(wait.notice, "");

    if let Err(error) = app.emit(EVENT_ASK_WAIT, wait) {
        tracing::warn!("ask wait event could not be emitted: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::account::test_support::question_account_at;
    use crate::search::test_support::{job_saved, transcript_saved};
    use crate::transcription::types::Transcript;
    use crate::workspace::TranscriptSlot;
    use crate::workspace::test_support::{meta_with, root_scoped};
    use chrono::NaiveDateTime;

    fn local(stamp: &str) -> DateTime<Local> {
        let naive = NaiveDateTime::parse_from_str(stamp, "%Y-%m-%d %H:%M").unwrap();

        Local.from_local_datetime(&naive).single().unwrap()
    }

    #[test]
    fn a_question_is_refused_when_empty_or_too_long() {
        let long = "word ".repeat(usize_of!(QUESTION_CHARS_MAX));
        let trimmed = question_validate("  Who owns the rollout?  ").unwrap();

        assert_eq!(trimmed, "Who owns the rollout?");
        assert!(question_validate("   ").unwrap_err().to_string().contains("ask a question"));
        assert!(question_validate(&long).unwrap_err().to_string().contains("over the"));
    }

    #[test]
    fn the_prompt_and_sources_come_from_the_indexed_meetings() {
        let _root = root_scoped();
        let renewal = workspace::job_id_from_text("renewal-call");
        let mut renewal_meta = meta_with(&renewal, local("2026-11-07 11:00").timestamp());

        renewal_meta.title = Some("Northwind renewal call".to_owned());
        renewal_meta.attendees = vec!["Hannah Roy".to_owned()];
        renewal_meta.project = Some("Northwind".to_owned());
        workspace::meta_save(&renewal_meta).unwrap();
        workspace::notes_save(&renewal, b"## Decisions\n- Northwind renews for two years.\n")
            .unwrap();

        let standup = workspace::job_id_from_text("standup");
        let spoken =
            Transcript { text: "Quick update on hiring.".to_owned(), segments: Vec::new() };
        let slot = TranscriptSlot { engine_id: "imported", job_id: &standup };

        workspace::meta_save(&meta_with(&standup, local("2026-11-09 09:00").timestamp())).unwrap();
        workspace::transcript_save(&slot, &spoken).unwrap();

        let excerpts = search::excerpts_whole(&Scope::All).unwrap().unwrap();
        let built =
            prompt_build("What did Hannah agree to?", &[], &excerpts, local("2026-11-10 12:00"))
                .unwrap();
        let markers: Vec<&str> =
            built.sources.iter().map(|source| source.marker.as_str()).collect();
        let meetings: Vec<&str> = built.meetings.iter().map(|meta| meta.id.as_str()).collect();

        assert_eq!(markers, ["M1", "M2"]);
        assert_eq!(meetings, [renewal.as_str(), standup.as_str()]);
        assert!(built.user.starts_with("Excerpts, grouped by meeting:\n\nMeeting:"));
        assert!(built.user.contains("Question: What did Hannah agree to?"));
        assert!(
            built
                .user
                .contains("Meeting: Northwind renewal call\nHeld: Saturday 7 November 2026, 11:00")
        );
        assert!(built.user.contains("Project: Northwind\nPeople: Hannah Roy"));
        assert!(
            built.user.contains("[M1] Notes:\n## Decisions\n- Northwind renews for two years.")
        );
        assert!(built.user.contains("Meeting: Untitled recording"));
        assert!(built.user.contains("[M2] Transcript:\nQuick update on hiring."));
        assert!(built.user.ends_with("Answer:"));

        let tail = concat!(
            "Quick update on hiring.\n\nToday is Tuesday 10 November 2026, 12:00.\n\n",
            "Question: What did Hannah agree to?\n\nAnswer:",
        );

        assert!(built.user.ends_with(tail));
        assert_eq!(built.user.matches("Question: What did Hannah agree to?").count(), 1);
    }

    #[test]
    fn a_meeting_whose_folder_now_holds_another_meeting_is_left_out_of_the_prompt() {
        let _root = root_scoped();
        let kept = job_saved("Kept", 2);
        let moved = job_saved("Moved", 1);

        workspace::notes_save(&kept, b"kept words").unwrap();
        workspace::notes_save(&moved, b"moved words").unwrap();

        let excerpts = search::excerpts_whole(&Scope::All).unwrap().unwrap();
        let foreign = meta_with(&workspace::job_id_from_text("foreign"), 1);

        std::fs::write(
            workspace::job_meta_path(&moved).unwrap(),
            serde_json::to_string(&foreign).unwrap(),
        )
        .unwrap();

        let built = prompt_build("What was said?", &[], &excerpts, Local::now()).unwrap();

        assert_eq!(excerpts.len(), 2);
        assert_eq!(built.sources.len(), 1);
        assert_eq!(built.sources.first().unwrap().job_id, kept);
        assert_eq!(built.sources.first().unwrap().marker, "M1");
        assert!(!built.user.contains("moved words"));
    }

    #[test]
    fn a_transcript_excerpt_is_labelled_with_its_time_range() {
        let _root = root_scoped();
        let id = job_saved("Timed", 1);

        transcript_saved(&id, &["first line", "second line", "third line"]);

        let excerpts = search::excerpts_whole(&Scope::All).unwrap().unwrap();
        let built = prompt_build("What was said?", &[], &excerpts, Local::now()).unwrap();

        assert!(built.user.contains("[M1] Transcript, 0:00 to 1:00:\nfirst line second line"));
        assert!(built.user.contains("[M2] Transcript, 1:00 to 1:30:\nthird line"));
        assert_eq!(built.sources[1].start_seconds, Some(60.0_f64));
        assert_eq!(built.sources[1].segment_index_first, Some(2));
    }

    fn finish_tokens(finish: &QuestionFinish) -> u64 {
        let sent = serde_json::to_value(finish).unwrap();

        assert!(sent["question_id"].as_u64().unwrap() > 0);

        sent["tokens"].as_u64().unwrap()
    }

    fn wait_of(wait_seconds: u32) -> QuestionStarted {
        assert!(wait_seconds > 0);

        QuestionStarted { notice: "Wait a little.".to_owned(), question_id: None, wait_seconds }
    }

    #[tokio::test]
    async fn a_turn_wait_ends_at_once_when_cancelled_or_too_long_and_otherwise_runs_out() {
        let cancelled = AtomicBool::new(true);
        let running = AtomicBool::new(false);
        let started = std::time::Instant::now();
        let longest = wait_of(QUESTION_WAIT_SECONDS_MAX);
        let refused = question_wait(&longest, &cancelled).await.unwrap_err();
        let too_long = wait_of(QUESTION_WAIT_SECONDS_MAX + 1);
        let refused_long = question_wait(&too_long, &running).await.unwrap_err();
        let refused_after = started.elapsed();

        question_wait(&wait_of(1), &running).await.unwrap();

        assert_eq!(refused.to_string(), format!("api error: {MESSAGE_CANCELLED}"));
        assert_eq!(refused_long.to_string(), "api error: Wait a little.");
        assert!(refused_after < QUESTION_WAIT_TICK);
        assert!(started.elapsed() >= QUESTION_WAIT_TICK);
    }

    #[test]
    fn a_question_tally_adds_the_parse_and_the_answer_and_drops_an_unreported_answer() {
        let account = question_account_at("https://remi.example.test");

        let mut turn =
            QuestionAdmitted { account, notice: String::new(), question_id: 7, tokens: Some(0) };

        assert_eq!(turn.finish().map(|finish| finish_tokens(&finish)), Some(1));

        let found = ExcerptsFound { excerpts: Vec::new(), tokens: 900 };
        let counted = Completion { text: "Sam drafts it.".to_owned(), tokens: Some(4100) };

        turn.tally_parse(&found);
        turn.tally_answer(&counted);

        assert_eq!(turn.finish().map(|finish| finish_tokens(&finish)), Some(5000));

        turn.tokens = Some(u32::MAX - 10);
        turn.tally_answer(&counted);

        let tokens_max = u64::from(account::QUESTION_TOKENS_MAX);

        assert_eq!(turn.finish().map(|finish| finish_tokens(&finish)), Some(tokens_max));

        let unreported = Completion { text: "Sam drafts it.".to_owned(), tokens: None };

        turn.tally_answer(&unreported);

        assert!(turn.finish().is_none());
    }

    #[test]
    fn a_warm_up_is_claimed_once_per_interval_and_never_on_a_clock_that_went_back() {
        let throttle = WarmThrottle::default();
        let interval = WARM_INTERVAL_SECONDS;

        assert!(!throttle.claim(interval - 1));
        assert!(throttle.claim(interval));
        assert!(!throttle.claim(interval + 1));
        assert!(!throttle.claim(2 * interval - 1));
        assert!(throttle.claim(2 * interval));
        assert!(!throttle.claim(10));
    }

    #[test]
    fn clock_times_read_as_minutes_or_hours() {
        assert_eq!(clock_format(0.0), "0:00");
        assert_eq!(clock_format(59.999), "0:59");
        assert_eq!(clock_format(75.9), "1:15");
        assert_eq!(clock_format(3725.0), "1:02:05");
        assert_eq!(clock_format(36_000.0), "10:00:00");
    }

    #[test]
    fn a_parse_reply_is_read_from_bare_or_fenced_json_and_refused_otherwise() {
        let bare = parse_reply(r#"{"queries": ["radios"], "names": ["Ana Lopez"]}"#).unwrap();
        let fenced = parse_reply("```json\n{\"queries\": [\"budget\"]}\n```").unwrap();

        assert_eq!(bare.queries, ["radios"]);
        assert_eq!(bare.names, ["Ana Lopez"]);
        assert_eq!(fenced.queries, ["budget"]);
        assert_eq!(fenced.names.len(), 0);

        let prose = parse_reply("no json here").unwrap_err();
        let backwards = parse_reply("} backwards {").unwrap_err();
        let mistyped = parse_reply(r#"{"queries": "not a list"}"#).unwrap_err();

        assert!(prose.to_string().contains("did not reply with JSON"));
        assert!(backwards.to_string().contains("did not reply with JSON"));
        assert!(mistyped.to_string().contains("expected a sequence"));
    }

    #[test]
    fn a_parse_extends_the_plan_with_bounded_queries_and_names() {
        let now = local("2026-11-11 15:00");
        let mut plan = RankPlan::of_question("What did Nate say about the talking equipment?", now);

        let parsed = QuestionParse {
            names: vec!["Nathan Cole".to_owned(), " ".to_owned()],
            queries: vec![
                "talking equipment".to_owned(),
                "radios walkie talkies last week".to_owned(),
                "communication devices".to_owned(),
                "dropped fourth query".to_owned(),
            ],
            question: String::new(),
        };

        plan_extend(&mut plan, &parsed);

        assert_eq!(plan.queries.len(), usize_of!(QUERIES_MAX));
        assert_eq!(plan.queries[1], "\"equipment\"");
        assert_eq!(plan.queries[2], "\"radios\" OR \"walkie\" OR \"talkies\"");
        assert!(plan.queries.iter().all(|expression| !expression.contains("dropped")));
        assert_eq!(plan.names.as_deref(), Some("\"Nathan Cole\""));

        let mut empty = RankPlan::of_question("budget", now);

        plan_extend(&mut empty, &QuestionParse::default());

        assert_eq!(empty.queries, ["\"budget\""]);
        assert!(empty.names.is_none());
    }

    #[test]
    fn nothing_matched_falls_back_to_the_latest_meetings_and_an_empty_scope_finds_nothing() {
        let _root = root_scoped();
        let plan = RankPlan::of_question("What about the zeppelin?", Local::now());

        assert!(excerpts_ranked(&plan, &Scope::All).unwrap().is_empty());

        let older = job_saved("Older", 1);
        let newer = job_saved("Newer", 2);

        workspace::notes_save(&older, b"older words").unwrap();
        workspace::notes_save(&newer, b"newer words").unwrap();

        let excerpts = excerpts_ranked(&plan, &Scope::All).unwrap();

        assert_eq!(excerpts.len(), 2);
        assert!(!plan.latest);
        assert_eq!(excerpts.last().unwrap().job_id, newer);
    }

    #[test]
    fn the_known_people_list_merges_people_and_attendees_once_each() {
        let _root = root_scoped();
        let id = workspace::job_id_from_text("names");
        let mut meta = meta_with(&id, 1);

        meta.attendees = vec!["Ana Lopez".to_owned(), "ana lopez".to_owned(), "Ben".to_owned()];
        workspace::meta_save(&meta).unwrap();

        let person = Person {
            id: "p1".to_owned(),
            name_first: "Ana".to_owned(),
            name_last: "Lopez".to_owned(),
            role: String::new(),
            description: String::new(),
        };

        crate::people::storage::person_upsert(&person).unwrap();

        let names = names_known_load().unwrap();
        let prompt = parse_prompt_build("Who spoke?", &[], &names);

        assert_eq!(names, ["Ana Lopez", "Ben"]);
        assert_eq!(prompt, "Known people: Ana Lopez, Ben\n\nQuestion: Who spoke?");
        assert_eq!(
            parse_prompt_build("Who?", &[], &[]),
            "Known people: none listed\n\nQuestion: Who?",
        );
    }

    fn rewrite(question: &str) -> QuestionParse {
        QuestionParse { question: question.to_owned(), ..QuestionParse::default() }
    }

    fn turn_banner() -> AskTurn {
        AskTurn {
            answer: "Sam drafts it.".to_owned(),
            question: "Who drafts the banner?".to_owned(),
        }
    }

    #[test]
    fn citations_leave_an_earlier_answer_while_other_brackets_stay() {
        let examples = [
            ("Sam owns it [M1]. Ana agreed [M2, M3].", "Sam owns it. Ana agreed."),
            ("[M1]Leading words", "Leading words"),
            ("See [Monday] and [M1 notes].", "See [Monday] and [M1 notes]."),
            ("Cut off at [M1", "Cut off at [M1"),
            ("Nine [M1,M2,M3,M4,M5,M6,M7,M8,M9] stay", "Nine [M1,M2,M3,M4,M5,M6,M7,M8,M9] stay"),
            ("No markers at all.", "No markers at all."),
        ];

        for (answer, expected) in examples {
            let once = citations_strip(answer);

            assert_eq!(once, expected);
            assert_eq!(citations_strip(&once), once);
        }

        let nested = citations_strip("[M[M1]1]");

        assert!(nested.len() <= "[M[M1]1]".len());
    }

    #[test]
    fn earlier_turns_are_bounded_trimmed_and_stripped_of_citations() {
        let earlier = vec![AskTurn {
            answer: "Sam does [M1].".to_owned(),
            question: "  Who drafts the banner?  ".to_owned(),
        }];

        let turns = history_validate(&earlier).unwrap();

        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0].question, "Who drafts the banner?");
        assert_eq!(turns[0].answer, "Sam does.");

        let long = "a".repeat(usize_of!(HISTORY_ANSWER_CHARS_MAX) + 50);
        let lengthy = AskTurn { answer: long, question: "Why?".to_owned() };
        let clipped = history_validate(&[lengthy]).unwrap();

        assert_eq!(clipped[0].answer.chars().count(), usize_of!(HISTORY_ANSWER_CHARS_MAX));

        let many = vec![turn_banner(); usize_of!(HISTORY_TURNS_MAX) + 1];
        let blank = vec![AskTurn { question: "   ".to_owned(), ..turn_banner() }];

        assert!(history_validate(&many).unwrap_err().to_string().contains("over the 4"));
        assert!(history_validate(&blank).unwrap_err().to_string().contains("ask a question"));
        assert_eq!(history_validate(&[]).unwrap().len(), 0);
    }

    #[test]
    fn earlier_turns_lead_the_question_in_both_prompts() {
        let _root = root_scoped();
        let id = job_saved("Banner review", 1);

        workspace::notes_save(&id, b"## Decisions\n- Sam drafts the **offline** banner copy.\n")
            .unwrap();

        let excerpts = search::excerpts_whole(&Scope::All).unwrap().unwrap();
        let earlier = [turn_banner()];
        let now = local("2026-11-10 12:00");
        let built = prompt_build("When is it due?", &earlier, &excerpts, now).unwrap();

        let conversation = "Earlier question: Who drafts the banner?\n\
                            Earlier answer: Sam drafts it.\n\n\
                            Question: When is it due?";

        assert!(built.user.ends_with(&format!("12:00.\n\n{conversation}\n\nAnswer:")));
        assert_eq!(built.sources[0].snippet, "Sam drafts the offline banner copy.");

        assert_eq!(
            parse_prompt_build("When is it due?", &earlier, &[]),
            format!("Known people: none listed\n\n{conversation}"),
        );
    }

    #[test]
    fn a_rewritten_question_is_used_only_for_a_follow_up_and_only_when_usable() {
        let earlier = [turn_banner()];
        let long = "word ".repeat(usize_of!(QUESTION_CHARS_MAX));

        let rewritten = rewrite(" When is the banner copy due? ");

        assert_eq!(
            rewritten.standalone("When is it due?", &earlier),
            "When is the banner copy due?",
        );
        assert_eq!(rewritten.standalone("When is it due?", &[]), "When is it due?");
        assert_eq!(rewrite("  ").standalone("When is it due?", &earlier), "When is it due?");
        assert_eq!(rewrite(&long).standalone("When is it due?", &earlier), "When is it due?");
    }

    #[test]
    fn a_snippet_reads_as_plain_text_and_is_cut_at_a_word_with_an_ellipsis() {
        let markdown = "## Plan\n\n1. Ship   the *retry* work\n- [x] `banner` done\n> quoted";

        assert_eq!(snippet_of(markdown), "Ship the retry work banner done quoted");
        assert_eq!(snippet_of("It went up to 3. Then down."), "It went up to 3. Then down.");
        assert_eq!(snippet_of("  \n ## \n - "), "");

        let words = snippet_of(&"word, ".repeat(100));
        let unbroken = snippet_of(&"x".repeat(500));

        assert!(words.ends_with("word\u{2026}"));
        assert!(words.chars().count() <= usize_of!(SNIPPET_CHARS_MAX) + 1);
        assert_eq!(unbroken.chars().count(), usize_of!(SNIPPET_CHARS_MAX) + 1);
        assert!(unbroken.ends_with(SNIPPET_ELLIPSIS));
    }
}
