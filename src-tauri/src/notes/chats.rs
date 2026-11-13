use super::ask::{AskSource, QUESTION_CHARS_MAX, meeting_load, question_validate};
use crate::blocking;
use crate::contract::ChatID;
use crate::error::{AppError, AppResult};
use crate::search::{EXCERPTS_WHOLE_MAX, Scope};
use crate::workspace::{self, JobMeta};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

const CHAT_BYTES_MAX: u32 = 8 << 20;
const CHAT_COUNT_MAX: u32 = 200;
const CHAT_ENTRIES_MAX: u32 = CHAT_COUNT_MAX * 4;
const CHAT_EXCHANGES_MAX: u32 = 30;
const CHAT_EXTENSION: &str = "json";
const CHAT_ID_LENGTH: usize = 36;
const CHATS_FOLDER: &str = "chats";
const EXCHANGE_ID_BYTES_MAX: usize = 64;
const UTF8_BYTES_PER_CHAR_MAX: u32 = 4;

const _: () = assert!(CHAT_COUNT_MAX < CHAT_ENTRIES_MAX);

const _: () =
    assert!(CHAT_EXCHANGES_MAX * QUESTION_CHARS_MAX * UTF8_BYTES_PER_CHAR_MAX < CHAT_BYTES_MAX,);

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub(crate) struct ChatExchange {
    answer: String,
    error: Option<String>,
    id: String,
    question: String,
    scope: Scope,
    sources: Vec<AskSource>,
    state: ExchangeState,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(try_from = "Vec<ChatExchange>")]
pub(crate) struct ChatExchanges(Vec<ChatExchange>);

#[derive(Clone, Debug, Serialize)]
pub(crate) struct ChatOpened {
    exchanges: ChatExchanges,
    id: String,
    meetings: Vec<JobMeta>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct ChatStored {
    exchanges: ChatExchanges,
    id: String,
    updated_at_unix_ms: i64,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct ChatSummary {
    id: String,
    title: String,
    updated_at_unix_ms: i64,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum ExchangeState {
    Done,
    Failed,
    Stopped,
}

impl TryFrom<Vec<ChatExchange>> for ChatExchanges {
    type Error = AppError;

    fn try_from(exchanges: Vec<ChatExchange>) -> AppResult<Self> {
        if exchanges.is_empty() {
            return Err(AppError::Config("a chat holds at least one question".into()));
        }

        if exchanges.len() > usize_of!(CHAT_EXCHANGES_MAX) {
            return Err(AppError::Config(format!(
                "a chat holds at most {CHAT_EXCHANGES_MAX} questions, not {}",
                exchanges.len(),
            )));
        }

        let mut ids: BTreeSet<&str> = BTreeSet::new();

        for exchange in &exchanges {
            exchange_validate(exchange)?;

            if !ids.insert(&exchange.id) {
                return Err(AppError::Config(format!("the chat repeats exchange {}", exchange.id)));
            }
        }

        assert_eq!(ids.len(), exchanges.len());

        Ok(Self(exchanges))
    }
}

#[tauri::command(rename_all = "snake_case")]
pub(crate) async fn chat_get(id: ChatID) -> AppResult<ChatOpened> {
    blocking::run(move || chat_open(&id)).await
}

pub(crate) fn chat_id_validate(id: &str) -> AppResult<()> {
    if id.len() != CHAT_ID_LENGTH {
        return Err(chat_id_refused(id));
    }

    if !id.bytes().all(|byte| matches!(byte, b'-' | b'0'..=b'9' | b'a'..=b'f')) {
        return Err(chat_id_refused(id));
    }

    assert!(id.is_ascii());

    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub(crate) async fn chat_remove(id: ChatID) -> AppResult<()> {
    blocking::run(move || chat_delete(&id)).await
}

#[tauri::command(rename_all = "snake_case")]
pub(crate) async fn chat_save(id: ChatID, exchanges: ChatExchanges) -> AppResult<()> {
    let saved_at_unix_ms = chrono::Utc::now().timestamp_millis();

    blocking::run(move || chat_write(&id, exchanges, saved_at_unix_ms)).await
}

#[tauri::command(rename_all = "snake_case")]
pub(crate) async fn chats_list() -> AppResult<Vec<ChatSummary>> {
    let summaries = blocking::run(chats_summarize).await?;

    assert!(summaries.len() <= usize_of!(CHAT_ENTRIES_MAX));

    Ok(summaries)
}

fn chat_delete(id: &str) -> AppResult<()> {
    let path = chat_path(id)?;
    let removed = fs::remove_file(&path);
    let missing = removed.as_ref().is_err_and(|error| error.kind() == ErrorKind::NotFound);

    if !missing {
        removed?;
    }

    assert!(!path.exists());
    assert!(path.ends_with(format!("{id}.{CHAT_EXTENSION}")));

    Ok(())
}

fn chat_id_refused(id: &str) -> AppError {
    AppError::Config(format!(
        "a chat id is {CHAT_ID_LENGTH} lowercase hex digits and hyphens, not {} bytes of other \
         text",
        id.len(),
    ))
}

fn chat_load(path: &Path) -> AppResult<ChatStored> {
    assert!(path.extension().is_some_and(|extension| extension == CHAT_EXTENSION));

    let raw = workspace::file_read_bounded(path, CHAT_BYTES_MAX)?;

    let chat: ChatStored = serde_json::from_str(&raw).map_err(|error| {
        AppError::Config(format!("the saved chat {} could not be read: {error}", path.display()))
    })?;

    chat_id_validate(&chat.id)?;

    if chat.updated_at_unix_ms <= 0 {
        return Err(AppError::Config(format!(
            "the saved chat {} carries no time it was last used",
            path.display(),
        )));
    }

    assert_ne!(chat.exchanges.0.len(), 0);
    assert!(chat.exchanges.0.len() <= usize_of!(CHAT_EXCHANGES_MAX));

    Ok(chat)
}

fn chat_open(id: &str) -> AppResult<ChatOpened> {
    let path = chat_path(id)?;

    if !path.exists() {
        return Err(AppError::Config("this chat was deleted".into()));
    }

    let chat = chat_load(&path)?;

    if chat.id != id {
        return Err(AppError::Config(format!("the file of chat {id} holds chat {}", chat.id)));
    }

    let meetings = meetings_cited(&chat.exchanges.0);

    assert!(meetings.iter().all(|meeting| workspace::job_id_is_valid(&meeting.id)));
    assert!(meetings.len() <= chat.exchanges.0.len() * usize_of!(EXCERPTS_WHOLE_MAX));

    Ok(ChatOpened { exchanges: chat.exchanges, id: chat.id, meetings })
}

fn chat_path(id: &str) -> AppResult<PathBuf> {
    chat_id_validate(id)?;

    let path = chats_directory()?.join(format!("{id}.{CHAT_EXTENSION}"));

    assert!(path.extension().is_some_and(|extension| extension == CHAT_EXTENSION));
    assert!(path.parent().is_some_and(|parent| parent.ends_with(CHATS_FOLDER)));

    Ok(path)
}

fn chat_summary(chat: ChatStored) -> ChatSummary {
    assert_ne!(chat.exchanges.0.len(), 0);
    assert!(chat.updated_at_unix_ms > 0);

    let ChatStored { exchanges, id, updated_at_unix_ms } = chat;
    let title = exchanges.0.into_iter().next().map_or_default(|exchange| exchange.question);

    assert_ne!(title.len(), 0);

    ChatSummary { id, title, updated_at_unix_ms }
}

fn chat_write(id: &str, exchanges: ChatExchanges, saved_at_unix_ms: i64) -> AppResult<()> {
    assert_ne!(exchanges.0.len(), 0);
    assert!(exchanges.0.len() <= usize_of!(CHAT_EXCHANGES_MAX));
    assert!(saved_at_unix_ms > 0);

    let path = chat_path(id)?;
    let chat = ChatStored { exchanges, id: id.to_owned(), updated_at_unix_ms: saved_at_unix_ms };
    let bytes = serde_json::to_vec(&chat)?;

    if bytes.len() > usize_of!(CHAT_BYTES_MAX) {
        return Err(AppError::Config(format!(
            "this chat is {} bytes, over the {CHAT_BYTES_MAX} that history keeps",
            bytes.len(),
        )));
    }

    workspace::atomic_write(&path, &bytes)?;

    chats_trim()
}

fn chats_directory() -> AppResult<PathBuf> {
    let path = workspace::root()?.join(CHATS_FOLDER);

    fs::create_dir_all(&path)?;

    assert!(path.ends_with(CHATS_FOLDER));
    assert!(path.is_dir());

    Ok(path)
}

fn chats_files() -> AppResult<Vec<PathBuf>> {
    let directory = chats_directory()?;
    let mut paths: Vec<PathBuf> = Vec::new();

    for (entry_index, listed) in fs::read_dir(&directory)?.enumerate() {
        if entry_index >= usize_of!(CHAT_ENTRIES_MAX) {
            return Err(AppError::Config(format!(
                "the chats folder holds more than the {CHAT_ENTRIES_MAX} files this app reads",
            )));
        }

        let path = listed?.path();

        if path.extension().is_some_and(|extension| extension == CHAT_EXTENSION) {
            paths.push(path);
        }
    }

    assert!(paths.len() <= usize_of!(CHAT_ENTRIES_MAX));
    assert!(paths.iter().all(|path| path.starts_with(&directory)));

    Ok(paths)
}

fn chats_summarize() -> AppResult<Vec<ChatSummary>> {
    let paths = chats_files()?;
    let mut summaries: Vec<ChatSummary> = Vec::with_capacity(paths.len());

    for path in &paths {
        match chat_load(path) {
            Ok(chat) => summaries.push(chat_summary(chat)),
            Err(error) => tracing::warn!(path = %path.display(), %error, "saved chat unreadable"),
        }
    }

    summaries.sort_by(|left, right| {
        right.updated_at_unix_ms.cmp(&left.updated_at_unix_ms).then_with(|| left.id.cmp(&right.id))
    });

    assert!(summaries.len() <= paths.len());
    assert!(summaries.iter().all(|summary| summary.updated_at_unix_ms > 0));
    assert!(
        summaries.is_sorted_by(|newer, older| newer.updated_at_unix_ms >= older.updated_at_unix_ms)
    );

    Ok(summaries)
}

fn chats_trim() -> AppResult<()> {
    if chats_files()?.len() <= usize_of!(CHAT_COUNT_MAX) {
        return Ok(());
    }

    let summaries = chats_summarize()?;
    let (kept, dropped) = summaries.split_at(summaries.len().min(usize_of!(CHAT_COUNT_MAX)));

    if !dropped.is_empty() {
        assert_eq!(kept.len(), usize_of!(CHAT_COUNT_MAX));
    }

    for summary in dropped {
        assert!(kept.iter().all(|newer| newer.updated_at_unix_ms >= summary.updated_at_unix_ms));

        tracing::info!(chat = %summary.id, "history is full, so its least recent chat is dropped");

        chat_delete(&summary.id)?;
    }

    Ok(())
}

fn exchange_validate(exchange: &ChatExchange) -> AppResult<()> {
    let question = question_validate(&exchange.question)?;

    assert!(question.len() <= exchange.question.len());

    if question.len() != exchange.question.len() {
        return Err(AppError::Config("a saved question is stored trimmed".into()));
    }

    exchange.scope.validate()?;

    if exchange.id.is_empty() {
        return Err(AppError::Config("each question in a chat carries an id".into()));
    }

    if exchange.id.len() > EXCHANGE_ID_BYTES_MAX {
        return Err(AppError::Config(format!(
            "a question id is at most {EXCHANGE_ID_BYTES_MAX} bytes",
        )));
    }

    if exchange.sources.len() > usize_of!(EXCERPTS_WHOLE_MAX) {
        return Err(AppError::Config(format!(
            "an answer cites at most {EXCERPTS_WHOLE_MAX} passages",
        )));
    }

    for source in &exchange.sources {
        workspace::job_id_validate(source.job_id())?;
    }

    Ok(())
}

fn meetings_cited(exchanges: &[ChatExchange]) -> Vec<JobMeta> {
    let ids: BTreeSet<&str> = exchanges
        .iter()
        .flat_map(|exchange| exchange.sources.iter().map(AskSource::job_id))
        .collect();

    let mut meetings: Vec<JobMeta> = Vec::with_capacity(ids.len());

    for id in &ids {
        match meeting_load(id) {
            Ok(Some(meta)) => meetings.push(meta),
            Ok(None) => {}
            Err(error) => tracing::warn!(job = %id, %error, "a cited meeting could not be read"),
        }
    }

    assert!(meetings.len() <= ids.len());
    assert!(meetings.iter().all(|meeting| ids.contains(meeting.id.as_str())));

    meetings
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::test_support::{meta_with, root_scoped};
    use serde_json::json;

    const CHAT_FIRST: &str = "1b4e28ba-2fa1-41d2-883f-0016d3cca427";
    const CHAT_SECOND: &str = "6fa459ea-ee8a-4ca4-894e-db77e160355e";
    const JOB_GONE: &str = "0123456789abcdef0123456789abcdef";
    const JOB_KEPT: &str = "2cf24dba5fb0a30e26e83b2ac5b9e29e";
    const MEETING_CREATED_AT_UNIX: i64 = 1_775_000_000;
    const SAVED_AT_UNIX_MS: i64 = 1_775_000_000_000;

    fn chat_id(index: u32) -> String {
        assert!(index <= CHAT_COUNT_MAX);

        let id = format!("00000000-0000-4000-8000-{index:012x}");

        assert_eq!(id.len(), CHAT_ID_LENGTH);

        id
    }

    fn chat_stored_raw(id: &str, chat: &serde_json::Value) {
        assert!(chat.is_object());

        let path = chats_directory().unwrap().join(format!("{id}.{CHAT_EXTENSION}"));

        fs::write(&path, serde_json::to_vec(chat).unwrap()).unwrap();

        assert!(path.exists());
    }

    fn exchange(question: &str, job_ids: &[&str]) -> ChatExchange {
        let sources: Vec<serde_json::Value> = job_ids
            .iter()
            .enumerate()
            .map(|(index, job_id)| {
                json!({
                    "end_seconds": null,
                    "heading": "Decisions",
                    "job_id": job_id,
                    "marker": format!("M{}", index + 1),
                    "segment_index_first": null,
                    "segment_index_last": null,
                    "snippet": "Sam drafts the offline banner copy.",
                    "source": "notes",
                    "start_seconds": null,
                })
            })
            .collect();

        let built: ChatExchange = serde_json::from_value(json!({
            "answer": "Sam drafts it [M1].",
            "error": null,
            "id": format!("exchange-{question}"),
            "question": question,
            "scope": { "kind": "meeting", "job_id": JOB_KEPT },
            "sources": sources,
            "state": "done",
        }))
        .unwrap();

        assert_eq!(built.sources.len(), job_ids.len());

        built
    }

    fn exchanges_of(exchanges: Vec<ChatExchange>) -> ChatExchanges {
        let count = exchanges.len();
        let parsed = ChatExchanges::try_from(exchanges).unwrap();

        assert_eq!(parsed.0.len(), count);

        parsed
    }

    fn meeting_store(id: &str) {
        assert!(workspace::job_id_is_valid(id));

        let path = workspace::job_meta_path(id).unwrap();
        let meta = meta_with(id, MEETING_CREATED_AT_UNIX);

        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, serde_json::to_vec(&meta).unwrap()).unwrap();

        assert!(path.exists());
    }

    fn titles(summaries: &[ChatSummary]) -> Vec<&str> {
        assert!(summaries.iter().all(|summary| chat_id_validate(&summary.id).is_ok()));

        summaries.iter().map(|summary| summary.title.as_str()).collect()
    }

    #[test]
    fn a_saved_chat_opens_as_saved_with_the_meetings_it_still_cites() {
        let _root = root_scoped();
        let asked = exchange("Who drafts the banner?", &[JOB_KEPT, JOB_GONE]);
        let exchanges = vec![asked, exchange("When is it due?", &[JOB_KEPT])];

        meeting_store(JOB_KEPT);
        chat_write(CHAT_FIRST, exchanges_of(exchanges.clone()), SAVED_AT_UNIX_MS).unwrap();

        let opened = chat_open(CHAT_FIRST).unwrap();
        let cited: Vec<&str> = opened.meetings.iter().map(|meeting| meeting.id.as_str()).collect();

        assert_eq!(opened.exchanges.0, exchanges);
        assert_eq!(opened.id, CHAT_FIRST);
        assert_eq!(cited, [JOB_KEPT]);
    }

    #[test]
    fn the_list_is_newest_first_and_a_continued_chat_moves_to_the_top() {
        let _root = root_scoped();

        let first = exchanges_of(vec![exchange("First?", &[])]);
        let second = exchanges_of(vec![exchange("Second?", &[])]);

        chat_write(CHAT_FIRST, first, SAVED_AT_UNIX_MS).unwrap();
        chat_write(CHAT_SECOND, second, SAVED_AT_UNIX_MS + 1).unwrap();

        let before = chats_summarize().unwrap();
        let continued = exchanges_of(vec![exchange("First?", &[]), exchange("Then?", &[])]);

        chat_write(CHAT_FIRST, continued, SAVED_AT_UNIX_MS + 2).unwrap();

        let after = chats_summarize().unwrap();

        assert_eq!(titles(&before), ["Second?", "First?"]);
        assert_eq!(titles(&after), ["First?", "Second?"]);
        assert_eq!(after.first().unwrap().updated_at_unix_ms, SAVED_AT_UNIX_MS + 2);
        assert_eq!(chat_open(CHAT_FIRST).unwrap().exchanges.0.len(), 2);
    }

    #[test]
    fn saving_past_the_limit_drops_only_the_least_recent_chat() {
        let _root = root_scoped();

        for index in 0..=CHAT_COUNT_MAX {
            let saved_at_unix_ms = SAVED_AT_UNIX_MS + i64::from(index);
            let again = exchanges_of(vec![exchange("Again?", &[])]);

            chat_write(&chat_id(index), again, saved_at_unix_ms).unwrap();
        }

        let summaries = chats_summarize().unwrap();

        assert_eq!(summaries.len(), usize_of!(CHAT_COUNT_MAX));
        assert!(summaries.iter().all(|summary| summary.id != chat_id(0)));
        assert_eq!(summaries.first().unwrap().id, chat_id(CHAT_COUNT_MAX));
        assert_eq!(summaries.last().unwrap().id, chat_id(1));
    }

    #[test]
    fn a_removed_chat_is_gone_and_removing_it_again_is_harmless() {
        let _root = root_scoped();

        chat_write(CHAT_FIRST, exchanges_of(vec![exchange("First?", &[])]), SAVED_AT_UNIX_MS)
            .unwrap();
        chat_delete(CHAT_FIRST).unwrap();
        chat_delete(CHAT_FIRST).unwrap();

        assert_eq!(chats_summarize().unwrap().len(), 0);
        assert!(chat_open(CHAT_FIRST).unwrap_err().to_string().contains("deleted"));
    }

    #[test]
    fn a_chat_that_is_empty_too_long_repeated_or_off_the_record_is_refused_on_arrival() {
        let long: Vec<ChatExchange> =
            (0..=CHAT_EXCHANGES_MAX).map(|index| exchange(&format!("Q{index}?"), &[])).collect();

        let refused = [
            (Vec::new(), "at least one question"),
            (long, "at most 30 questions"),
            (vec![exchange("Same?", &[]), exchange("Same?", &[])], "repeats exchange"),
            (vec![exchange("Where?", &["../../etc/passwd"])], "is not a job id"),
            (vec![exchange("   ", &[])], "ask a question first"),
        ];

        for (exchanges, reason) in refused {
            let error = serde_json::from_value::<ChatExchanges>(json!(exchanges)).unwrap_err();

            assert!(error.to_string().contains(reason), "{error}");
        }

        let accepted = vec![exchange("Who drafts the banner?", &[JOB_KEPT])];
        let parsed: ChatExchanges = serde_json::from_value(json!(accepted)).unwrap();

        assert_eq!(parsed.0, accepted);
        assert_eq!(serde_json::to_value(&parsed).unwrap(), json!(accepted));
    }

    #[test]
    fn a_saved_chat_edited_out_of_shape_is_left_out_and_will_not_open() {
        let _root = root_scoped();
        let kept = exchanges_of(vec![exchange("Kept?", &[])]);

        chat_write(CHAT_FIRST, kept, SAVED_AT_UNIX_MS).unwrap();

        chat_stored_raw(
            CHAT_SECOND,
            &json!({ "exchanges": [], "id": CHAT_SECOND, "updated_at_unix_ms": SAVED_AT_UNIX_MS }),
        );

        let summaries = chats_summarize().unwrap();
        let error = chat_open(CHAT_SECOND).unwrap_err();

        assert_eq!(titles(&summaries), ["Kept?"]);
        assert!(error.to_string().contains("at least one question"), "{error}");
    }

    #[test]
    fn a_chat_id_is_refused_unless_it_has_the_minted_shape() {
        let parsed: ChatID = serde_json::from_value(json!(CHAT_FIRST)).unwrap();
        let traversal = format!("../{}", "a".repeat(CHAT_ID_LENGTH - 3));

        assert_eq!(&*parsed, CHAT_FIRST);
        assert_eq!(traversal.len(), CHAT_ID_LENGTH);

        for refused in [traversal, CHAT_FIRST.to_uppercase(), String::new()] {
            let error = serde_json::from_value::<ChatID>(json!(refused)).unwrap_err();

            assert!(error.to_string().contains("chat id"), "{error}");
        }
    }
}
