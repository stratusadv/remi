use super::chunk::CHUNKS_MAX;
use super::{LIST_CHUNKS_MAX, MEETINGS_MAX, Scope, index_open};
use crate::blocking;
use crate::endpoints::storage::{
    MODEL_EMBEDDINGS,
    embeddings_model_resolve,
    embeddings_target_load,
};
use crate::endpoints::types::EmbeddingsTarget;
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
use crate::settings::settings_load;
use rusqlite::types::ValueRef;
use rusqlite::{Connection, Rows, Transaction, TransactionBehavior, named_params};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use std::cmp::{Ordering, Reverse};
use std::collections::BinaryHeap;
use std::sync::{LazyLock, OnceLock};
use std::time::Duration;
use tokio::sync::mpsc::{self, error::TrySendError};
use tokio::sync::watch;

const API_PATH_EMBEDDINGS: &str = "/v1/embeddings";
const BATCH_PASSAGES_MAX: u32 = 32;
const CONNECT_TIMEOUT_SECONDS: u64 = 10;
const DIGEST_BYTES: u32 = 32;
const DIMENSIONS_MAX: u32 = 8192;
const DOT_BLOCK_LENGTH: usize = 16;
const LABEL_EMBEDDINGS: &str = "embeddings";
const PASSAGE_SEPARATOR: &str = "\n\n";
const PROMPT_DOCUMENT_GEMMA: &str = "title: none | text: ";
const PROMPT_DOCUMENT_NOMIC: &str = "search_document: ";
const PROMPT_QUERY_GEMMA: &str = "task: search result | query: ";
const PROMPT_QUERY_MXBAI: &str = "Represent this sentence for searching relevant passages: ";
const PROMPT_QUERY_NOMIC: &str = "search_query: ";
const PROMPTS_NONE: Prompts = Prompts { document: "", query: "" };
const QUESTION_TIMEOUT_SECONDS: u64 = 8;
const READ_TIMEOUT_SECONDS: u64 = 120;
const REQUEST_TIMEOUT_SECONDS: u64 = 300;
const SPACE_SEPARATOR: &str = " | ";
const VALUE_BYTES: u32 = 4;
const VECTOR_ROWS_MAX: u32 = MEETINGS_MAX * CHUNKS_MAX;
const WARM_TEXT: &str = "warm";
const WORKER_BATCHES_MAX: u32 = 4096;
const WORKER_PASSES_MAX: u32 = 1_000_000;

const _: () = assert!(size_of::<f32>() == 4);
const _: () = assert!(VALUE_BYTES == 4);
const _: () = assert!(CONNECT_TIMEOUT_SECONDS < READ_TIMEOUT_SECONDS);
const _: () = assert!(QUESTION_TIMEOUT_SECONDS < REQUEST_TIMEOUT_SECONDS);
const _: () = assert!(READ_TIMEOUT_SECONDS < REQUEST_TIMEOUT_SECONDS);
const _: () = assert!(LIST_CHUNKS_MAX < VECTOR_ROWS_MAX);

const HTTP_TIMEOUTS: ClientTimeouts = ClientTimeouts {
    connect: Duration::from_secs(CONNECT_TIMEOUT_SECONDS),
    read: Some(Duration::from_secs(READ_TIMEOUT_SECONDS)),
    request: Duration::from_secs(REQUEST_TIMEOUT_SECONDS),
};

const PROMPT_QUERY_QWEN3: &str = concat!(
    "Instruct: Given a question about the user's past meetings, retrieve the notes and ",
    "transcript passages that answer it\nQuery:",
);

const PROMPTS_BY_FAMILY: [(&str, Prompts); 4] = [
    ("embeddinggemma", Prompts { document: PROMPT_DOCUMENT_GEMMA, query: PROMPT_QUERY_GEMMA }),
    ("mxbai-embed-large", Prompts { document: "", query: PROMPT_QUERY_MXBAI }),
    ("nomic-embed-text", Prompts { document: PROMPT_DOCUMENT_NOMIC, query: PROMPT_QUERY_NOMIC }),
    ("qwen3-embedding", Prompts { document: "", query: PROMPT_QUERY_QWEN3 }),
];

const SQL_RANK_VECTOR: &str = "
    SELECT chunk.chunk_id, vector.embedding
    FROM chunk
    JOIN meeting ON meeting.job_id = chunk.job_id
    JOIN vector ON vector.passage_digest = chunk.passage_digest AND vector.model = :space
    WHERE :scope_kind = 0
        OR (:scope_kind = 1 AND meeting.project = :scope_value COLLATE NOCASE)
        OR (:scope_kind = 2 AND meeting.job_id = :scope_value)
    LIMIT :limit
";

const SQL_RANK_VECTOR_ALL: &str = "
    SELECT chunk.chunk_id, vector.embedding
    FROM vector
    CROSS JOIN chunk ON chunk.passage_digest = vector.passage_digest
    WHERE vector.model = :space
    LIMIT :limit
";

const SQL_VECTOR_COUNTS: &str = "
    SELECT
        (SELECT count(DISTINCT passage_digest) FROM chunk),
        (
            SELECT count(*)
            FROM vector
            WHERE model = :space AND passage_digest IN (SELECT passage_digest FROM chunk)
        )
";

const SQL_VECTOR_UPSERT: &str = "
    INSERT INTO vector (passage_digest, model, embedding)
    VALUES (:passage_digest, :space, :embedding)
    ON CONFLICT (passage_digest) DO UPDATE
    SET model = excluded.model, embedding = excluded.embedding
";

const SQL_VECTORS_PENDING: &str = "
    SELECT chunk.passage_digest, chunk_text.header, chunk_text.body
    FROM chunk
    JOIN chunk_text ON chunk_text.rowid = chunk.chunk_id
    JOIN meeting ON meeting.job_id = chunk.job_id
    WHERE NOT EXISTS (
        SELECT 1
        FROM vector
        WHERE vector.passage_digest = chunk.passage_digest AND vector.model = :space
    )
    GROUP BY chunk.passage_digest
    ORDER BY max(meeting.held_at_unix) DESC, chunk.passage_digest
    LIMIT :limit
";

const SQL_VECTORS_PRUNE_ORPHANS: &str =
    "DELETE FROM vector WHERE passage_digest NOT IN (SELECT passage_digest FROM chunk)";

static HTTP_CLIENT: ClientCell = LazyLock::new(|| client_build(&HTTP_TIMEOUTS));
static WORKER: OnceLock<WorkerHandle> = OnceLock::new();

#[derive(Debug, Deserialize)]
struct EmbeddingDatum {
    embedding: Vec<f32>,
    index: u32,
}

#[derive(Debug, Serialize)]
struct EmbeddingRequest<'text> {
    input: &'text [&'text str],
    model: &'text str,
}

#[derive(Debug, Deserialize)]
struct EmbeddingResponse {
    data: Vec<EmbeddingDatum>,
}

#[derive(Debug)]
pub(super) struct Passage {
    pub(super) digest: Vec<u8>,
    pub(super) text: String,
}

#[derive(Clone, Copy, Debug)]
pub(super) struct PassageParts<'text> {
    pub(super) body: &'text str,
    pub(super) header: &'text str,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct Prompts {
    document: &'static str,
    query: &'static str,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct QueryVector {
    pub(crate) space: String,
    pub(crate) values: Vec<f32>,
}

#[derive(Clone, Copy, Debug)]
struct Scored {
    chunk_id: i64,
    similarity: f32,
}

#[derive(Debug, Serialize)]
pub(crate) struct SearchStatus {
    error: Option<String>,
    model: Option<String>,
    model_default: &'static str,
    passages: u32,
    passages_embedded: u32,
}

#[derive(Debug)]
struct Worker {
    failure: watch::Sender<Option<String>>,
    requests: mpsc::Receiver<()>,
}

#[derive(Debug)]
struct WorkerHandle {
    failure: watch::Receiver<Option<String>>,
    requests: mpsc::Sender<()>,
}

impl Prompts {
    pub(super) fn document_text(self, passage: &str) -> String {
        assert_ne!(passage.trim(), "");

        let text = format!("{}{passage}", self.document);

        assert!(text.ends_with(passage));
        assert_eq!(text.len(), self.document.len() + passage.len());

        text
    }

    pub(super) fn query_text(self, question: &str) -> String {
        assert_ne!(question.trim(), "");

        let text = format!("{}{question}", self.query);

        assert!(text.ends_with(question));
        assert_eq!(text.len(), self.query.len() + question.len());

        text
    }
}

impl Eq for Scored {}

impl Ord for Scored {
    fn cmp(&self, other: &Self) -> Ordering {
        self.similarity.total_cmp(&other.similarity).then(other.chunk_id.cmp(&self.chunk_id))
    }
}

impl PartialEq for Scored {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}

impl PartialOrd for Scored {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Worker {
    fn outcome_publish(&self, outcome: &AppResult<u32>) {
        let failure = match outcome {
            Ok(0) => None,
            Ok(embedded) => {
                tracing::info!(embedded, "the search model caught up with the index");

                None
            }
            Err(error) => {
                tracing::warn!(%error, "the search model could not prepare passages");

                Some(error.to_string())
            }
        };

        drop(self.failure.send_replace(failure));

        assert_eq!(self.failure.borrow().is_some(), outcome.is_err());
    }

    async fn run(mut self) {
        for _pass_index in 0..WORKER_PASSES_MAX {
            if self.requests.recv().await.is_none() {
                tracing::warn!("the search model worker stopped because its requests closed");

                return;
            }

            drop(self.failure.send_replace(None));

            let outcome = worker_pass().await;

            self.outcome_publish(&outcome);
        }

        tracing::warn!("the search model worker reached its pass limit");
    }
}

pub(crate) async fn connection_warm() {
    let target = match blocking::run(embeddings_target_load).await {
        Ok(Some(target)) => target,
        Ok(None) => return,
        Err(error) => {
            tracing::debug!(%error, "the search model has no endpoint to warm");

            return;
        }
    };

    match embeddings_create(&target, &[WARM_TEXT]).await {
        Ok(vectors) => assert_eq!(vectors.len(), 1),
        Err(error) => tracing::debug!(%error, "the search model was not warmed"),
    }
}

pub(super) async fn embeddings_create(
    target: &EmbeddingsTarget,
    texts: &[&str],
) -> AppResult<Vec<Vec<f32>>> {
    let url = embeddings_url(&target.host);
    let body = embeddings_body(&target.model, texts);
    let client = client_get(&HTTP_CLIENT)?;

    let response: EmbeddingResponse = retry_run(|| async {
        let mut request = client.post(&url);

        if !target.api_key.is_empty() {
            request = request.bearer_auth(&target.api_key);
        }

        let sent = request.json(&body).send().await?;
        let accepted = response_ensure_ok(sent, LABEL_EMBEDDINGS).await?;

        response_json_bounded::<EmbeddingResponse>(accepted).await
    })
    .await?;

    embeddings_parse(&response, texts.len())
}

pub(super) fn passage_digest(text: &str) -> Vec<u8> {
    assert_ne!(text, "");

    let digest = Sha256::digest(text.as_bytes()).to_vec();

    assert_eq!(digest.len(), usize_of!(DIGEST_BYTES));

    digest
}

pub(super) fn passage_text(parts: PassageParts<'_>) -> String {
    assert_ne!(parts.body.trim(), "");

    let body = parts.body.trim();
    let header = parts.header.trim();

    if header.is_empty() {
        return body.to_owned();
    }

    format!("{header}{PASSAGE_SEPARATOR}{body}")
}

pub(super) async fn passages_embed(
    target: &EmbeddingsTarget,
    passages: &[Passage],
) -> AppResult<Vec<Vec<f32>>> {
    let prompts = prompts_of(&target.model);

    let texts: Vec<String> =
        passages.iter().map(|passage| prompts.document_text(&passage.text)).collect();

    let borrowed: Vec<&str> = texts.iter().map(String::as_str).collect();
    let embeddings = embeddings_create(target, &borrowed).await?;

    assert_eq!(embeddings.len(), passages.len());

    Ok(embeddings)
}

pub(super) fn prompts_of(model: &str) -> Prompts {
    let lowered = model.trim().to_lowercase();

    let prompts = PROMPTS_BY_FAMILY
        .iter()
        .find(|(family, _prompts)| lowered.contains(*family))
        .map_or(PROMPTS_NONE, |(_family, prompts)| *prompts);

    assert!(prompts.query.is_empty() || prompts.query.ends_with([' ', ':']));
    assert!(prompts.document.is_empty() || prompts.document.ends_with(' '));

    prompts
}

pub(crate) async fn question_ranked(question: &str, scope: Scope) -> Option<Vec<i64>> {
    let query = question_vector(question).await?;
    let ranked = blocking::run(move || super::meaning_rank(&query, &scope)).await;

    match ranked {
        Ok(chunk_ids) => Some(chunk_ids),
        Err(error) => {
            tracing::warn!(%error, "the question was ranked by its words alone");

            None
        }
    }
}

pub(crate) async fn question_vector(question: &str) -> Option<QueryVector> {
    let target = match blocking::run(embeddings_target_load).await {
        Ok(Some(target)) => target,
        Ok(None) => return None,
        Err(error) => {
            tracing::warn!(%error, "the question was searched by its words alone");

            return None;
        }
    };

    let limit = Duration::from_secs(QUESTION_TIMEOUT_SECONDS);
    let text = prompts_of(&target.model).query_text(question);
    let created = tokio::time::timeout(limit, embeddings_create(&target, &[text.as_str()])).await;

    let mut vectors = match created {
        Ok(Ok(vectors)) => vectors,
        Ok(Err(error)) => {
            tracing::warn!(%error, "the search model could not read the question");

            return None;
        }
        Err(elapsed) => {
            tracing::warn!(%elapsed, "the search model did not read the question in time");

            return None;
        }
    };

    assert_eq!(vectors.len(), 1);

    vectors.pop().map(|values| QueryVector { space: space_of(&target.model), values })
}

pub(super) fn rank_by_vector(
    connection: &Connection,
    query: &QueryVector,
    scope: &Scope,
) -> AppResult<Vec<i64>> {
    assert_ne!(query.space, "");
    assert_ne!(query.values.len(), 0);

    let mut best: BinaryHeap<Reverse<Scored>> =
        BinaryHeap::with_capacity(usize_of!(LIST_CHUNKS_MAX) + 1);

    if *scope == Scope::All {
        let mut statement = connection.prepare_cached(SQL_RANK_VECTOR_ALL)?;

        let mut rows =
            statement.query(named_params! { ":limit": VECTOR_ROWS_MAX, ":space": query.space })?;

        scored_keep(&mut rows, &query.values, &mut best)?;
    } else {
        let (kind, value) = scope.binding();
        let mut statement = connection.prepare_cached(SQL_RANK_VECTOR)?;

        let mut rows = statement.query(named_params! {
            ":limit": VECTOR_ROWS_MAX,
            ":scope_kind": kind,
            ":scope_value": value,
            ":space": query.space,
        })?;

        scored_keep(&mut rows, &query.values, &mut best)?;
    }

    let ranked: Vec<i64> =
        best.into_sorted_vec().into_iter().map(|Reverse(scored)| scored.chunk_id).collect();

    assert!(ranked.len() <= usize_of!(LIST_CHUNKS_MAX));

    Ok(ranked)
}

#[tauri::command]
pub(crate) async fn search_status() -> AppResult<SearchStatus> {
    blocking::run(status_load).await
}

#[tauri::command]
pub(crate) fn search_vectors_refresh() {
    worker_wake();
}

pub(super) fn space_of(model: &str) -> String {
    assert_ne!(model, "");

    let document = prompts_of(model).document;

    if document.is_empty() {
        return model.to_owned();
    }

    let space = format!("{model}{SPACE_SEPARATOR}{}", document.trim_end());

    assert!(space.starts_with(model));
    assert!(space.len() > model.len());

    space
}

pub(super) fn vectors_pending(space: &str) -> AppResult<Vec<Passage>> {
    assert_ne!(space, "");

    let connection = index_open()?;
    let mut statement = connection.prepare_cached(SQL_VECTORS_PENDING)?;

    let mut rows =
        statement.query(named_params! { ":limit": BATCH_PASSAGES_MAX, ":space": space })?;

    let mut pending: Vec<Passage> = Vec::new();

    while let Some(row) = rows.next()? {
        let header: String = row.get("header")?;
        let body: String = row.get("body")?;
        let digest: Vec<u8> = row.get("passage_digest")?;
        let text = passage_text(PassageParts { body: &body, header: &header });

        pending.push(Passage { digest, text });
    }

    assert!(pending.len() <= usize_of!(BATCH_PASSAGES_MAX));
    assert!(pending.iter().all(|passage| passage.digest.len() == usize_of!(DIGEST_BYTES)));

    Ok(pending)
}

pub(super) fn vectors_prune_orphans(connection: &Connection) -> AppResult<u32> {
    let removed = connection.execute(SQL_VECTORS_PRUNE_ORPHANS, [])?;
    let count = u32::try_from(removed).unwrap_or(u32::MAX);

    assert_eq!(usize_of!(count), removed);

    Ok(count)
}

pub(super) fn vectors_store(
    space: &str,
    passages: &[Passage],
    embeddings: &[Vec<f32>],
) -> AppResult<u32> {
    assert_ne!(space, "");
    assert_eq!(passages.len(), embeddings.len());

    let mut connection = index_open()?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let stored = vectors_store_in(&transaction, space, passages, embeddings)?;

    transaction.commit()?;

    Ok(stored)
}

pub(crate) fn worker_spawn() {
    let (requests_sender, requests_receiver) = mpsc::channel(1);
    let (failure_sender, failure_receiver) = watch::channel(None);
    let handle = WorkerHandle { failure: failure_receiver, requests: requests_sender };

    if WORKER.set(handle).is_err() {
        tracing::warn!("the search model worker was already running");

        return;
    }

    let worker = Worker { failure: failure_sender, requests: requests_receiver };

    assert_eq!(worker.requests.max_capacity(), 1);
    assert!(worker.failure.borrow().is_none());

    let _task = tauri::async_runtime::spawn(worker.run());

    worker_wake();
}

pub(crate) fn worker_wake() {
    let Some(worker) = WORKER.get() else {
        return;
    };

    if worker.requests.try_send(()) == Err(TrySendError::Closed(())) {
        tracing::warn!("the search model worker has stopped, restart remi to resume it");
    }
}

fn embeddings_body<'text>(
    model: &'text str,
    texts: &'text [&'text str],
) -> EmbeddingRequest<'text> {
    assert_ne!(model, "");
    assert_ne!(texts.len(), 0);
    assert!(texts.len() <= usize_of!(BATCH_PASSAGES_MAX));
    assert!(texts.iter().all(|text| !text.trim().is_empty()));

    EmbeddingRequest { input: texts, model }
}

fn embeddings_parse(response: &EmbeddingResponse, expected: usize) -> AppResult<Vec<Vec<f32>>> {
    assert_ne!(expected, 0);
    assert!(expected <= usize_of!(BATCH_PASSAGES_MAX));

    if response.data.len() != expected {
        return Err(AppError::Service(format!(
            "the search model returned {} vectors for {expected} passages",
            response.data.len(),
        )));
    }

    let mut ordered: Vec<&EmbeddingDatum> = response.data.iter().collect();

    ordered.sort_by_key(|datum| datum.index);

    let dimensions = ordered.first().map_or(0, |datum| datum.embedding.len());

    if dimensions > usize_of!(DIMENSIONS_MAX) {
        return Err(AppError::Service(format!(
            "the search model returned {dimensions} values, over the {DIMENSIONS_MAX} kept",
        )));
    }

    let mut vectors: Vec<Vec<f32>> = Vec::with_capacity(expected);

    for (position, datum) in ordered.into_iter().enumerate() {
        if usize_of!(datum.index) != position {
            return Err(AppError::Service("the search model skipped or repeated a passage".into()));
        }

        if datum.embedding.len() != dimensions {
            return Err(AppError::Service("the search model mixed vector lengths".into()));
        }

        let Some(normalized) = vector_normalize(&datum.embedding) else {
            return Err(AppError::Service("the search model returned an empty vector".into()));
        };

        vectors.push(normalized);
    }

    assert_eq!(vectors.len(), expected);
    assert!(vectors.iter().all(|vector| vector.len() == dimensions));

    Ok(vectors)
}

fn embeddings_url(host: &str) -> String {
    assert_ne!(host, "");

    let url = format!("{}{API_PATH_EMBEDDINGS}", host.trim_end_matches('/'));

    assert!(url.ends_with(API_PATH_EMBEDDINGS));

    url
}

fn scored_keep(
    rows: &mut Rows<'_>,
    values: &[f32],
    best: &mut BinaryHeap<Reverse<Scored>>,
) -> AppResult<()> {
    assert_ne!(values.len(), 0);
    assert!(best.len() <= usize_of!(LIST_CHUNKS_MAX));

    while let Some(row) = rows.next()? {
        let ValueRef::Blob(blob) = row.get_ref(1)? else {
            continue;
        };

        let Some(similarity) = vector_dot(values, blob) else {
            continue;
        };

        best.push(Reverse(Scored { chunk_id: row.get(0)?, similarity }));

        if best.len() > usize_of!(LIST_CHUNKS_MAX) {
            let _worst = best.pop();
        }
    }

    assert!(best.len() <= usize_of!(LIST_CHUNKS_MAX));

    Ok(())
}

fn status_load() -> AppResult<SearchStatus> {
    let model = embeddings_model_resolve(&settings_load()?);
    let connection = index_open()?;
    let space = model.as_deref().map_or_default(space_of);

    let (passages, passages_embedded): (u32, u32) =
        connection.query_row(SQL_VECTOR_COUNTS, named_params! { ":space": space }, |row| {
            Ok((row.get(0)?, row.get(1)?))
        })?;

    let error = WORKER.get().and_then(|worker| worker.failure.borrow().clone());

    assert!(passages_embedded <= passages);

    if model.is_none() {
        assert_eq!(passages_embedded, 0);
    }

    Ok(SearchStatus { error, model, model_default: MODEL_EMBEDDINGS, passages, passages_embedded })
}

fn vector_bytes(values: &[f32]) -> Vec<u8> {
    assert_ne!(values.len(), 0);

    let bytes: Vec<u8> = values.iter().flat_map(|value| value.to_le_bytes()).collect();

    assert_eq!(bytes.len(), values.len() * usize_of!(VALUE_BYTES));

    bytes
}

fn vector_dot(query: &[f32], blob: &[u8]) -> Option<f32> {
    assert_ne!(query.len(), 0);

    if blob.len() != query.len() * usize_of!(VALUE_BYTES) {
        return None;
    }

    let (words, rest) = blob.as_chunks::<{ size_of::<f32>() }>();
    let (query_blocks, query_tail) = query.as_chunks::<DOT_BLOCK_LENGTH>();
    let (word_blocks, word_tail) = words.as_chunks::<DOT_BLOCK_LENGTH>();
    let mut lanes = [0.0_f32; DOT_BLOCK_LENGTH];

    for (values, block) in query_blocks.iter().zip(word_blocks) {
        for ((lane, value), word) in lanes.iter_mut().zip(values).zip(block) {
            *lane += value * f32::from_le_bytes(*word);
        }
    }

    let tail: f32 = query_tail
        .iter()
        .zip(word_tail)
        .map(|(value, word)| value * f32::from_le_bytes(*word))
        .sum();

    assert_eq!(rest.len(), 0);
    assert_eq!(query_blocks.len(), word_blocks.len());

    Some(lanes.iter().sum::<f32>() + tail)
}

fn vector_normalize(values: &[f32]) -> Option<Vec<f32>> {
    assert!(values.len() <= usize_of!(DIMENSIONS_MAX));

    if values.iter().any(|value| !value.is_finite()) {
        return None;
    }

    let norm = values.iter().map(|value| value * value).sum::<f32>().sqrt();

    if !norm.is_normal() {
        return None;
    }

    let normalized: Vec<f32> = values.iter().map(|value| value / norm).collect();

    assert_eq!(normalized.len(), values.len());
    assert!(normalized.iter().all(|value| value.abs() <= 1.0_f32 + f32::EPSILON));

    Some(normalized)
}

fn vectors_store_in(
    transaction: &Transaction<'_>,
    space: &str,
    passages: &[Passage],
    embeddings: &[Vec<f32>],
) -> AppResult<u32> {
    let mut statement = transaction.prepare_cached(SQL_VECTOR_UPSERT)?;
    let mut stored = 0_u32;

    for (passage, embedding) in passages.iter().zip(embeddings) {
        let changed = statement.execute(named_params! {
            ":embedding": vector_bytes(embedding),
            ":passage_digest": passage.digest,
            ":space": space,
        })?;

        assert_eq!(changed, 1);

        stored += 1;
    }

    assert_eq!(usize_of!(stored), passages.len());

    Ok(stored)
}

async fn worker_pass() -> AppResult<u32> {
    let Some(target) = blocking::run(embeddings_target_load).await? else {
        return Ok(0);
    };

    let space = space_of(&target.model);
    let mut embedded = 0_u32;

    for _batch_index in 0..WORKER_BATCHES_MAX {
        let space_pending = space.clone();
        let pending = blocking::run(move || vectors_pending(&space_pending)).await?;

        if pending.is_empty() {
            return Ok(embedded);
        }

        let embeddings = passages_embed(&target, &pending).await?;
        let space_store = space.clone();

        let stored =
            blocking::run(move || vectors_store(&space_store, &pending, &embeddings)).await?;

        embedded = embedded.saturating_add(stored);
    }

    worker_wake();

    Ok(embedded)
}

#[cfg(test)]
mod tests {
    use super::super::test_support::{ranked_jobs, transcript_saved};
    use super::super::{RankPlan, meaning_rank, reconcile, weight_meaning};
    use super::*;
    use crate::settings::{Settings, settings_save};
    use crate::workspace;
    use crate::workspace::test_support::{meta_with, root_scoped};
    use chrono::Local;

    const MODEL: &str = "model-a";
    const MODEL_OTHER: &str = "model-b";

    fn embedded_all(model: &str) -> u32 {
        let mut stored = 0_u32;

        for _batch in 0..64_u32 {
            let pending = vectors_pending(model).unwrap();

            if pending.is_empty() {
                return stored;
            }

            let embeddings: Vec<Vec<f32>> =
                pending.iter().map(|passage| embedding_of(&passage.text)).collect();

            stored += vectors_store(model, &pending, &embeddings).unwrap();
        }

        panic!("the passages never ran out");
    }

    fn embedding_of(text: &str) -> Vec<f32> {
        let lower = text.to_lowercase();
        let radios = if lower.contains("radio") { 1.0_f32 } else { 0.0_f32 };
        let invoices = if lower.contains("invoice") { 1.0_f32 } else { 0.0_f32 };

        vector_normalize(&[radios, invoices, 0.25_f32, 0.25_f32]).unwrap()
    }

    fn job_of(connection: &Connection, chunk_id: i64) -> String {
        assert!(chunk_id > 0);

        connection
            .query_row("SELECT job_id FROM chunk WHERE chunk_id = ?1", [chunk_id], |row| row.get(0))
            .unwrap()
    }

    fn meeting_saved(title: &str, project: Option<&str>, lines: &[&str]) -> String {
        let id = workspace::job_id_from_text(title);
        let mut meta = meta_with(&id, 1_790_000_000);

        meta.title = Some(title.to_owned());
        meta.project = project.map(str::to_owned);
        workspace::meta_save(&meta).unwrap();
        transcript_saved(&id, lines);

        id
    }

    fn meetings_saved() -> (String, String) {
        let radios = meeting_saved(
            "Field crew check-in",
            Some("Tailspin Toys"),
            &["The two-way radios are six years old.", "We order twelve radios."],
        );

        let invoices = meeting_saved(
            "Finance sync",
            None,
            &["Contractors send invoices late.", "The invoice deadline is the twentieth."],
        );

        (radios, invoices)
    }

    fn refusal_of(raw: &str) -> String {
        embeddings_parse(&reply_of(raw), 2).unwrap_err().to_string()
    }

    fn reply_of(raw: &str) -> EmbeddingResponse {
        assert!(raw.starts_with('{'));

        serde_json::from_str(raw).unwrap()
    }

    fn reply_wide(dimensions: u32) -> EmbeddingResponse {
        assert_ne!(dimensions, 0);

        let datum = EmbeddingDatum { embedding: vec![1.0_f32; usize_of!(dimensions)], index: 0 };

        EmbeddingResponse { data: vec![datum] }
    }

    #[test]
    fn a_model_that_prompts_its_passages_never_reads_vectors_made_without_the_prompt() {
        let _root = root_scoped();
        let _meetings = meetings_saved();
        let unprompted = embedded_all("nomic-embed-text");
        let space = space_of("nomic-embed-text");

        let settings = Settings {
            embeddings_model: Some("nomic-embed-text".to_owned()),
            ..Settings::initial()
        };

        settings_save(&settings).unwrap();

        assert_ne!(unprompted, 0);
        assert_eq!(space, "nomic-embed-text | search_document:");
        assert_eq!(space_of("qwen3-embedding:0.6b"), "qwen3-embedding:0.6b");
        assert_eq!(space_of(MODEL), MODEL);
        assert_eq!(usize_of!(unprompted), vectors_pending(&space).unwrap().len());
        assert_eq!(status_load().unwrap().passages_embedded, 0);
        assert_eq!(embedded_all(&space), unprompted);

        let ready = status_load().unwrap();

        assert_eq!(ready.passages_embedded, ready.passages);
        assert_eq!(vectors_pending("nomic-embed-text").unwrap().len(), usize_of!(unprompted));
    }

    #[test]
    fn a_passage_carries_a_prompt_only_where_its_model_wants_one() {
        let passage = "Finance sync\n\nThe invoice deadline is the twentieth.";
        let nomic = format!("search_document: {passage}");
        let gemma = format!("title: none | text: {passage}");

        assert_eq!(prompts_of("nomic-embed-text").document_text(passage), nomic);
        assert_eq!(prompts_of("embeddinggemma").document_text(passage), gemma);
        assert_eq!(prompts_of("qwen3-embedding:4b").document_text(passage), passage);
        assert_eq!(prompts_of("mxbai-embed-large").document_text(passage), passage);
        assert_eq!(prompts_of(MODEL).document_text(passage), passage);
    }

    #[test]
    fn a_passage_reads_header_first_and_its_digest_is_sha256_of_the_text() {
        let parts = PassageParts {
            body: " The radios are old. ",
            header: " Field crew check-in\nNathan Cole ",
        };

        let text = passage_text(parts);
        let alone = passage_text(PassageParts { body: "Body only", header: "  " });

        assert_eq!(text, "Field crew check-in\nNathan Cole\n\nThe radios are old.");
        assert_eq!(alone, "Body only");
        assert!(passage_digest("abc").starts_with(&[0xba, 0x78, 0x16, 0xbf]));
        assert!(passage_digest("abc").ends_with(&[0xf2, 0x00, 0x15, 0xad]));
        assert_ne!(passage_digest(&text), passage_digest("The radios are old."));
    }

    #[test]
    fn a_question_carries_the_prompt_its_model_was_trained_with() {
        let question = "Who owns the retry work?";

        let qwen = concat!(
            "Instruct: Given a question about the user's past meetings, retrieve the notes and ",
            "transcript passages that answer it\nQuery:Who owns the retry work?",
        );

        let mxbai =
            "Represent this sentence for searching relevant passages: Who owns the retry work?";

        let nomic = format!("search_query: {question}");
        let gemma = format!("task: search result | query: {question}");

        assert_eq!(prompts_of("qwen3-embedding:0.6b").query_text(question), qwen);
        assert_eq!(prompts_of(" Qwen/Qwen3-Embedding-8B ").query_text(question), qwen);
        assert_eq!(prompts_of("nomic-embed-text:v1.5").query_text(question), nomic);
        assert_eq!(prompts_of("mxbai-embed-large:335m").query_text(question), mxbai);
        assert_eq!(prompts_of("embeddinggemma").query_text(question), gemma);
        assert_eq!(prompts_of(MODEL).query_text(question), question);
    }

    #[test]
    fn a_reply_is_put_back_in_passage_order_and_scaled_to_unit_length() {
        let raw =
            r#"{"data":[{"index":1,"embedding":[0.0,2.0]},{"index":0,"embedding":[3.0,4.0]}]}"#;
        let vectors = embeddings_parse(&reply_of(raw), 2).unwrap();

        assert_eq!(vectors, [vec![0.6_f32, 0.8_f32], vec![0.0_f32, 1.0_f32]]);

        for vector in &vectors {
            let norm: f32 = vector.iter().map(|value| value * value).sum();

            assert!((norm - 1.0_f32).abs() < 1e-6_f32);
        }
    }

    #[test]
    fn a_reply_that_is_short_ragged_repeated_or_empty_is_refused() {
        let short = r#"{"data":[{"index":0,"embedding":[1.0]}]}"#;
        let ragged =
            r#"{"data":[{"index":0,"embedding":[1.0]},{"index":1,"embedding":[1.0,1.0]}]}"#;
        let repeated = r#"{"data":[{"index":0,"embedding":[1.0]},{"index":0,"embedding":[1.0]}]}"#;
        let empty =
            r#"{"data":[{"index":0,"embedding":[0.0,0.0]},{"index":1,"embedding":[1.0,0.0]}]}"#;
        let zero = r#"{"data":[{"index":0,"embedding":[]},{"index":1,"embedding":[]}]}"#;

        assert!(refusal_of(short).ends_with("returned 1 vectors for 2 passages"));
        assert!(refusal_of(ragged).ends_with("mixed vector lengths"));
        assert!(refusal_of(repeated).ends_with("skipped or repeated a passage"));
        assert!(refusal_of(empty).ends_with("returned an empty vector"));
        assert!(refusal_of(zero).ends_with("returned an empty vector"));
        assert_eq!(embeddings_parse(&reply_of(short), 1).unwrap(), [vec![1.0_f32]]);
    }

    #[test]
    fn a_reply_wider_than_the_kept_dimensions_is_refused_at_the_boundary() {
        let kept = embeddings_parse(&reply_wide(DIMENSIONS_MAX), 1).unwrap();
        let refused = embeddings_parse(&reply_wide(DIMENSIONS_MAX + 1), 1).unwrap_err();

        assert_eq!(kept.first().map(Vec::len), Some(usize_of!(DIMENSIONS_MAX)));
        assert!(refused.to_string().ends_with("returned 8193 values, over the 8192 kept"));
    }

    #[test]
    fn a_request_goes_to_the_embeddings_path_under_the_trimmed_host() {
        let texts = ["first passage", "second passage"];
        let body = embeddings_body("qwen3-embedding:0.6b", &texts);
        let encoded = serde_json::to_value(&body).unwrap();
        let local = embeddings_url("http://localhost:11434/");

        assert_eq!(local, "http://localhost:11434/v1/embeddings");
        assert_eq!(embeddings_url("https://api.test"), "https://api.test/v1/embeddings");
        assert_eq!(encoded["model"], "qwen3-embedding:0.6b");
        assert_eq!(encoded["input"][1], "second passage");
        assert_eq!(encoded.as_object().unwrap().len(), 2);
    }

    #[test]
    fn a_vector_survives_the_round_trip_through_its_stored_bytes() {
        let values = vector_normalize(&[1.0_f32, -2.0_f32, 0.5_f32, 4.0_f32]).unwrap();
        let bytes = vector_bytes(&values);
        let self_similarity = vector_dot(&values, &bytes).unwrap();

        assert_eq!(bytes.len(), values.len() * 4);
        assert!((self_similarity - 1.0_f32).abs() < 1e-6_f32);

        let opposite: Vec<f32> = values.iter().map(|value| -value).collect();
        let opposite_similarity = vector_dot(&opposite, &bytes).unwrap();

        assert!((opposite_similarity + 1.0_f32).abs() < 1e-6_f32);
        assert!(vector_dot(&values, &bytes[4..]).is_none());
        assert!(vector_normalize(&[f32::NAN, 1.0_f32]).is_none());
        assert!(vector_normalize(&[0.0_f32; 3]).is_none());
    }

    #[test]
    fn a_vector_whose_passage_left_the_index_is_dropped_by_the_next_reconcile() {
        let _root = root_scoped();
        let (radios, _invoices) = meetings_saved();
        let embedded = embedded_all(MODEL);

        workspace::job_delete(&radios).unwrap();

        let _report = reconcile().unwrap();
        let settings = Settings { embeddings_model: Some(MODEL.to_owned()), ..Settings::initial() };

        settings_save(&settings).unwrap();

        let status = status_load().unwrap();

        assert!(status.passages < embedded);
        assert_eq!(status.passages_embedded, status.passages);
        assert_eq!(vectors_prune_orphans(&index_open().unwrap()).unwrap(), 0);
    }

    #[test]
    fn each_passage_keeps_one_vector_that_a_new_model_replaces() {
        let _root = root_scoped();
        let _meetings = meetings_saved();
        let pending = vectors_pending(MODEL).unwrap();

        assert_ne!(pending.len(), 0);

        for passage in &pending {
            assert_eq!(passage.digest, passage_digest(&passage.text));
            assert!(
                passage.text.starts_with("Field crew check-in")
                    || passage.text.starts_with("Finance sync")
            );
        }

        assert_eq!(usize_of!(embedded_all(MODEL)), pending.len());
        assert_eq!(vectors_pending(MODEL).unwrap().len(), 0);
        assert_eq!(vectors_pending(MODEL_OTHER).unwrap().len(), pending.len());
        assert_eq!(usize_of!(embedded_all(MODEL_OTHER)), pending.len());
        assert_eq!(vectors_pending(MODEL).unwrap().len(), pending.len());

        let rows: u32 = index_open()
            .unwrap()
            .query_row("SELECT count(*) FROM vector", [], |row| row.get(0))
            .unwrap();

        assert_eq!(usize_of!(rows), pending.len());
    }

    #[test]
    fn meaning_joins_the_ranking_only_beside_a_topic_and_brings_in_unworded_matches() {
        let _root = root_scoped();
        let (radios, invoices) = meetings_saved();
        let _embedded = embedded_all(MODEL);
        let words = RankPlan::of_question("When is the invoice deadline?", Local::now());
        let toward_radios = vector_normalize(&[1.0_f32, 0.0_f32, 0.0_f32, 0.0_f32]).unwrap();
        let query = QueryVector { space: MODEL.to_owned(), values: toward_radios };
        let meaning = meaning_rank(&query, &Scope::All).unwrap();
        let hybrid = RankPlan { meaning: Some(meaning.clone()), ..words.clone() };
        let alone = ranked_jobs(&words, &Scope::All);
        let joined = ranked_jobs(&hybrid, &Scope::All);

        assert!(alone.iter().all(|job| *job == invoices));
        assert_eq!(joined.first(), Some(&invoices));
        assert!(joined.contains(&radios));

        let recent = RankPlan { latest: true, ..RankPlan::default() };
        let recent_meaning = RankPlan { meaning: Some(meaning), ..recent.clone() };

        assert!(weight_meaning(&recent_meaning).is_none());
        assert_eq!(weight_meaning(&hybrid), Some(1.0_f64));
        assert_eq!(ranked_jobs(&recent_meaning, &Scope::All), ranked_jobs(&recent, &Scope::All));
    }

    #[test]
    fn meaning_ranks_the_closest_passages_first_and_stays_inside_the_scope() {
        let _root = root_scoped();
        let (radios, invoices) = meetings_saved();
        let _embedded = embedded_all(MODEL);
        let connection = index_open().unwrap();
        let toward_invoices = vector_normalize(&[0.0_f32, 1.0_f32, 0.0_f32, 0.0_f32]).unwrap();
        let query = QueryVector { space: MODEL.to_owned(), values: toward_invoices };
        let all = rank_by_vector(&connection, &query, &Scope::All).unwrap();
        let project = Scope::Project { project: "tailspin toys".to_owned() };
        let inside = rank_by_vector(&connection, &query, &project).unwrap();
        let first = all.first().map(|chunk_id| job_of(&connection, *chunk_id));
        let last = all.last().map(|chunk_id| job_of(&connection, *chunk_id));

        assert_eq!(first.as_deref(), Some(invoices.as_str()));
        assert_eq!(last.as_deref(), Some(radios.as_str()));
        assert_ne!(inside.len(), 0);
        assert!(inside.iter().all(|chunk_id| job_of(&connection, *chunk_id) == radios));

        let other = QueryVector { space: MODEL_OTHER.to_owned(), values: query.values };

        assert_eq!(rank_by_vector(&connection, &other, &Scope::All).unwrap().len(), 0);
    }

    #[test]
    fn the_status_counts_passages_and_the_vectors_ready_for_the_chosen_model() {
        let _root = root_scoped();
        let _meetings = meetings_saved();
        let unset = status_load().unwrap();

        assert_eq!(unset.model.as_deref(), Some(MODEL_EMBEDDINGS));
        assert_eq!(unset.model_default, MODEL_EMBEDDINGS);
        assert_ne!(unset.passages, 0);
        assert_eq!(unset.passages_embedded, 0);

        let emptied = Settings { embeddings_model: Some(String::new()), ..Settings::initial() };

        settings_save(&emptied).unwrap();

        let off = status_load().unwrap();

        assert!(off.model.is_none());
        assert_eq!(off.model_default, MODEL_EMBEDDINGS);
        assert_eq!(off.passages, unset.passages);
        assert_eq!(off.passages_embedded, 0);

        let settings = Settings { embeddings_model: Some(MODEL.to_owned()), ..Settings::initial() };

        settings_save(&settings).unwrap();

        let embedded = embedded_all(MODEL);
        let ready = status_load().unwrap();

        assert_eq!(ready.model.as_deref(), Some(MODEL));
        assert_eq!(ready.passages, embedded);
        assert_eq!(ready.passages_embedded, embedded);
    }

    #[test]
    fn the_worker_publishes_a_failure_until_a_later_pass_succeeds() {
        let (failure, watcher) = watch::channel(None);
        let (_requests_sender, requests) = mpsc::channel(1);
        let worker = Worker { failure, requests };

        worker.outcome_publish(&Err(AppError::Service("the search model is down".into())));

        let published = watcher.borrow().clone();

        assert_eq!(published.as_deref(), Some("api error: the search model is down"));

        worker.outcome_publish(&Ok(3));

        assert!(watcher.borrow().is_none());
    }
}
