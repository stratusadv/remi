pub(crate) mod chunk;
pub(crate) mod query;
pub(crate) mod vector;
pub(crate) mod when;

#[cfg(test)]
mod benchmark;

#[cfg(test)]
pub(crate) mod evaluation;

use crate::contract::JobID;
use crate::error::{AppError, AppResult};
use crate::people::storage::{Person, people_load_all};
use crate::transcription::types::Transcript;
use crate::workspace::{self, JobFiles, JobMeta};
use chrono::{DateTime, Local};
use chunk::{ChunkDraft, ChunkSource, chars_count};
use rusqlite::{
    Connection,
    OptionalExtension as _,
    Row,
    Rows,
    Transaction,
    TransactionBehavior,
    named_params,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;
use vector::QueryVector;
use when::TimeWindow;

const BUSY_TIMEOUT_MS: u64 = 10_000;
const EXCERPT_NEIGHBOURS_MAX: u32 = 2;
const EXCERPTS_RANKED_CHARS_MAX: u32 = 60_000;
const EXCERPTS_RANKED_MAX: u32 = 40;
const EXCERPTS_WHOLE_CHARS_MAX: u32 = 120_000;
pub(crate) const EXCERPTS_WHOLE_MAX: u32 = 400;
const HITS_CHUNKS_MAX: u32 = 20_000;
const HITS_MAX: u32 = 1000;
const INDEX_FILE_NAME: &str = "search.sqlite";
const INDEX_VERSION: i32 = 3;
const LIST_CHUNKS_MAX: u32 = 200;
const MEETINGS_MAX: u32 = 65_536;
pub(crate) const PROJECT_CHARS_MAX: u32 = 200;
pub(crate) const QUERIES_MAX: u32 = 4;
const RRF_K: f64 = 60.0;
const SCOPE_ALL: u8 = 0;
const SCOPE_MEETING: u8 = 2;
const SCOPE_PROJECT: u8 = 1;
pub(crate) const SNIPPET_ELLIPSIS: &str = "\u{2026}";
const SNIPPET_TOKENS_MAX: u32 = 24;
const WEIGHT_BODY: f64 = 1.0;
const WEIGHT_HEADER_NAMES: f64 = 1.0;
const WEIGHT_HEADER_TOPIC: f64 = 0.4;

const _: () = assert!(EXCERPTS_RANKED_MAX < EXCERPTS_WHOLE_MAX);
const _: () = assert!(EXCERPTS_RANKED_MAX * (1 + EXCERPT_NEIGHBOURS_MAX) <= EXCERPTS_WHOLE_MAX);
const _: () = assert!(EXCERPTS_RANKED_CHARS_MAX < EXCERPTS_WHOLE_CHARS_MAX);
const _: () = assert!(EXCERPTS_RANKED_MAX <= LIST_CHUNKS_MAX);
const _: () = assert!(SNIPPET_TOKENS_MAX <= 64);
const _: () = assert!(HITS_MAX < HITS_CHUNKS_MAX);
const _: () = assert!(chunk::CHUNK_CHARS_MAX < EXCERPTS_RANKED_CHARS_MAX);

const SQL_CHUNK_INSERT: &str = "
    INSERT INTO chunk (
        job_id,
        source,
        ordinal,
        heading,
        segment_index_first,
        segment_index_last,
        start_seconds,
        end_seconds,
        characters,
        passage_digest
    )
    VALUES (
        :job_id,
        :source,
        :ordinal,
        :heading,
        :segment_index_first,
        :segment_index_last,
        :start_seconds,
        :end_seconds,
        :characters,
        :passage_digest
    )
";

const SQL_EXCERPT: &str = "
    SELECT
        chunk.job_id,
        chunk.source,
        chunk.ordinal,
        chunk.heading,
        chunk.segment_index_first,
        chunk.segment_index_last,
        chunk.start_seconds,
        chunk.end_seconds,
        chunk.characters,
        meeting.held_at_unix,
        chunk_text.body
    FROM chunk
    JOIN meeting ON meeting.job_id = chunk.job_id
    JOIN chunk_text ON chunk_text.rowid = chunk.chunk_id
    WHERE chunk.chunk_id = :chunk_id
";

const SQL_EXCERPT_AT: &str = "
    SELECT
        chunk.job_id,
        chunk.source,
        chunk.ordinal,
        chunk.heading,
        chunk.segment_index_first,
        chunk.segment_index_last,
        chunk.start_seconds,
        chunk.end_seconds,
        chunk.characters,
        meeting.held_at_unix,
        chunk_text.body
    FROM chunk
    JOIN meeting ON meeting.job_id = chunk.job_id
    JOIN chunk_text ON chunk_text.rowid = chunk.chunk_id
    WHERE chunk.job_id = :job_id AND chunk.source = :source AND chunk.ordinal = :ordinal
";

const SQL_EXCERPTS_SCOPE: &str = "
    SELECT
        chunk.job_id,
        chunk.source,
        chunk.ordinal,
        chunk.heading,
        chunk.segment_index_first,
        chunk.segment_index_last,
        chunk.start_seconds,
        chunk.end_seconds,
        chunk.characters,
        meeting.held_at_unix,
        chunk_text.body
    FROM chunk
    JOIN meeting ON meeting.job_id = chunk.job_id
    JOIN chunk_text ON chunk_text.rowid = chunk.chunk_id
    WHERE :scope_kind = 0
        OR (:scope_kind = 1 AND meeting.project = :scope_value COLLATE NOCASE)
        OR (:scope_kind = 2 AND meeting.job_id = :scope_value)
    ORDER BY meeting.held_at_unix, meeting.job_id, chunk.source, chunk.ordinal
    LIMIT :limit
";

const SQL_HIT_SNIPPET: &str = "
    SELECT snippet(chunk_text, 1, '', '', :ellipsis, :tokens)
    FROM chunk_text
    WHERE chunk_text MATCH :expression AND rowid = :chunk_id
";

const SQL_HITS_BEST: &str = "
    SELECT
        chunk.chunk_id,
        chunk.job_id,
        chunk.source,
        chunk.segment_index_first,
        chunk.segment_index_last,
        chunk.start_seconds
    FROM chunk_text
    JOIN chunk ON chunk.chunk_id = chunk_text.rowid
    WHERE chunk_text MATCH :expression
    ORDER BY bm25(chunk_text, 0.0, 1.0), chunk.chunk_id
    LIMIT :limit
";

const SQL_JOB_DELETE_CHUNKS: &str = "DELETE FROM chunk WHERE job_id = :job_id";
const SQL_JOB_DELETE_MEETING: &str = "DELETE FROM meeting WHERE job_id = :job_id";

const SQL_JOB_DELETE_TEXT: &str =
    "DELETE FROM chunk_text WHERE rowid IN (SELECT chunk_id FROM chunk WHERE job_id = :job_id)";

const SQL_MEETING_DIGEST: &str = "SELECT digest FROM meeting WHERE job_id = :job_id";
const SQL_MEETING_IDS: &str = "SELECT job_id FROM meeting ORDER BY job_id LIMIT :limit";

const SQL_MEETING_INSERT: &str = "
    INSERT INTO meeting (job_id, digest, held_at_unix, names, project)
    VALUES (:job_id, :digest, :held_at_unix, :names, :project)
";

const SQL_MEETING_NAMES: &str = "
    SELECT names
    FROM meeting
    ORDER BY held_at_unix DESC, job_id
    LIMIT :limit
";

const SQL_RANK_LATEST: &str = "
    SELECT chunk.chunk_id
    FROM chunk
    JOIN meeting ON meeting.job_id = chunk.job_id
    WHERE :scope_kind = 0
        OR (:scope_kind = 1 AND meeting.project = :scope_value COLLATE NOCASE)
        OR (:scope_kind = 2 AND meeting.job_id = :scope_value)
    ORDER BY
        meeting.held_at_unix DESC,
        meeting.job_id,
        chunk.source = 'transcript',
        chunk.ordinal
    LIMIT :limit
";

const SQL_RANK_MATCH: &str = "
    SELECT chunk.chunk_id
    FROM chunk_text
    JOIN chunk ON chunk.chunk_id = chunk_text.rowid
    JOIN meeting ON meeting.job_id = chunk.job_id
    WHERE chunk_text MATCH :expression
        AND (
            :scope_kind = 0
            OR (:scope_kind = 1 AND meeting.project = :scope_value COLLATE NOCASE)
            OR (:scope_kind = 2 AND meeting.job_id = :scope_value)
        )
    ORDER BY bm25(chunk_text, :weight_header, :weight_body), chunk.chunk_id
    LIMIT :limit
";

const SQL_RANK_WINDOW: &str = "
    SELECT chunk.chunk_id
    FROM chunk
    JOIN meeting ON meeting.job_id = chunk.job_id
    WHERE meeting.held_at_unix BETWEEN :start_unix AND :end_unix
        AND (
            :scope_kind = 0
            OR (:scope_kind = 1 AND meeting.project = :scope_value COLLATE NOCASE)
            OR (:scope_kind = 2 AND meeting.job_id = :scope_value)
        )
    ORDER BY
        chunk.source = 'transcript',
        abs(meeting.held_at_unix - :center_unix),
        meeting.job_id,
        chunk.ordinal
    LIMIT :limit
";

const SQL_SCHEMA: &str = "
    DROP TABLE IF EXISTS chunk_text;
    DROP TABLE IF EXISTS chunk;
    DROP TABLE IF EXISTS meeting;

    CREATE TABLE meeting (
        job_id TEXT PRIMARY KEY NOT NULL,
        digest BLOB NOT NULL,
        held_at_unix INTEGER NOT NULL,
        names TEXT NOT NULL CHECK (json_type(names) = 'array'),
        project TEXT
    ) STRICT, WITHOUT ROWID;

    CREATE TABLE chunk (
        chunk_id INTEGER PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES meeting (job_id),
        source TEXT NOT NULL CHECK (source IN ('notes', 'transcript')),
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        heading TEXT,
        segment_index_first INTEGER,
        segment_index_last INTEGER,
        start_seconds REAL,
        end_seconds REAL,
        characters INTEGER NOT NULL CHECK (characters > 0),
        passage_digest BLOB NOT NULL CHECK (length(passage_digest) = 32),
        UNIQUE (job_id, source, ordinal)
    ) STRICT;

    CREATE INDEX chunk_passage_digest ON chunk (passage_digest);

    CREATE VIRTUAL TABLE chunk_text USING fts5(
        header,
        body,
        prefix = '2 3',
        tokenize = 'porter unicode61 remove_diacritics 2'
    );

    CREATE TABLE IF NOT EXISTS vector (
        passage_digest BLOB PRIMARY KEY NOT NULL CHECK (length(passage_digest) = 32),
        model TEXT NOT NULL CHECK (model <> ''),
        embedding BLOB NOT NULL CHECK (length(embedding) > 0)
    ) STRICT;
";

const SQL_SCOPE_SIZE: &str = "
    SELECT count(*), coalesce(sum(characters), 0)
    FROM (
        SELECT chunk.characters
        FROM chunk
        JOIN meeting ON meeting.job_id = chunk.job_id
        WHERE :scope_kind = 0
            OR (:scope_kind = 1 AND meeting.project = :scope_value COLLATE NOCASE)
            OR (:scope_kind = 2 AND meeting.job_id = :scope_value)
        LIMIT :limit
    )
";

const SQL_TEXT_INSERT: &str =
    "INSERT INTO chunk_text (rowid, header, body) VALUES (:chunk_id, :header, :body)";

#[derive(Clone, Debug)]
pub(crate) struct Excerpt {
    pub(crate) body: String,
    pub(crate) characters: u32,
    pub(crate) end_seconds: Option<f64>,
    pub(crate) heading: Option<String>,
    pub(crate) held_at_unix: i64,
    pub(crate) job_id: String,
    pub(crate) ordinal: u32,
    pub(crate) segment_index_first: Option<u32>,
    pub(crate) segment_index_last: Option<u32>,
    pub(crate) source: ChunkSource,
    pub(crate) start_seconds: Option<f64>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct RankPlan {
    pub(crate) latest: bool,
    pub(crate) meaning: Option<Vec<i64>>,
    pub(crate) names: Option<String>,
    pub(crate) queries: Vec<String>,
    pub(crate) window: Option<TimeWindow>,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) struct ReconcileReport {
    pub(crate) failed: u32,
    pub(crate) indexed: u32,
    pub(crate) removed: u32,
    pub(crate) unchanged: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Refresh {
    Indexed,
    Removed,
    Unchanged,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum Scope {
    All,
    Meeting { job_id: JobID },
    Project { project: String },
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct SearchHit {
    pub(crate) job_id: String,
    pub(crate) segment_index_first: Option<u32>,
    pub(crate) segment_index_last: Option<u32>,
    pub(crate) snippet: String,
    pub(crate) source: ChunkSource,
    pub(crate) start_seconds: Option<f64>,
}

#[derive(Debug)]
struct RankedList {
    chunk_ids: Vec<i64>,
    weight: f64,
}

#[derive(Debug)]
struct HitRow {
    chunk_id: i64,
    job_id: String,
    segment_index_first: Option<u32>,
    segment_index_last: Option<u32>,
    source: ChunkSource,
    start_seconds: Option<f64>,
}

impl RankPlan {
    pub(crate) fn of_question(question: &str, now: DateTime<Local>) -> Self {
        let terms = query::terms_of(question);
        let queries: Vec<String> = query::match_any(&terms).into_iter().collect();
        let window = when::window_parse(question, now);
        let latest = when::latest_requested(question) || (queries.is_empty() && window.is_none());

        assert!(queries.len() <= 1);
        assert!(latest || !queries.is_empty() || window.is_some());

        Self { latest, meaning: None, names: None, queries, window }
    }
}

impl RankedList {
    fn even(chunk_ids: Vec<i64>) -> Self {
        assert!(chunk_ids.len() <= usize_of!(LIST_CHUNKS_MAX));

        Self { chunk_ids, weight: 1.0_f64 }
    }
}

impl ReconcileReport {
    fn count(&mut self, id: &str, refreshed: &AppResult<Refresh>) {
        assert_ne!(id, "");

        match refreshed {
            Ok(Refresh::Indexed) => self.indexed += 1,
            Ok(Refresh::Removed) => self.removed += 1,
            Ok(Refresh::Unchanged) => self.unchanged += 1,
            Err(error) => {
                tracing::warn!(job = %id, %error, "the search index could not take this job");

                self.failed += 1;
            }
        }
    }
}

impl Scope {
    fn binding(&self) -> (u8, &str) {
        match self {
            Self::All => (SCOPE_ALL, ""),
            Self::Meeting { job_id } => (SCOPE_MEETING, job_id),
            Self::Project { project } => (SCOPE_PROJECT, project.trim()),
        }
    }

    pub(crate) fn validate(&self) -> AppResult<()> {
        let Self::Project { project } = self else {
            return Ok(());
        };

        let trimmed = project.trim();

        if trimmed.is_empty() {
            return Err(AppError::Config("choose a folder to ask about".into()));
        }

        if chars_count(trimmed) > PROJECT_CHARS_MAX {
            return Err(AppError::Config(format!(
                "a folder name is at most {PROJECT_CHARS_MAX} characters",
            )));
        }

        Ok(())
    }
}

pub(crate) fn excerpts_rank(plan: &RankPlan, scope: &Scope) -> AppResult<Vec<Excerpt>> {
    let connection = index_open()?;
    let fused = ranks_fused(&connection, plan, scope)?;
    let chosen = excerpts_choose(&connection, &fused)?;
    let count = chosen.len();
    let mut expanded = excerpts_expand(&connection, chosen)?;

    expanded.sort_by(excerpt_order);

    assert!(expanded.len() >= count);
    assert!(expanded.len() <= count * usize_of!(1 + EXCERPT_NEIGHBOURS_MAX));

    Ok(expanded)
}

pub(crate) fn excerpts_whole(scope: &Scope) -> AppResult<Option<Vec<Excerpt>>> {
    let connection = index_open()?;
    let (kind, value) = scope.binding();

    let (count, characters): (i64, i64) = connection.query_row(
        SQL_SCOPE_SIZE,
        named_params! {
            ":limit": EXCERPTS_WHOLE_MAX + 1,
            ":scope_kind": kind,
            ":scope_value": value,
        },
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;

    let oversized =
        count > i64::from(EXCERPTS_WHOLE_MAX) || characters > i64::from(EXCERPTS_WHOLE_CHARS_MAX);

    if oversized {
        return Ok(None);
    }

    let mut statement = connection.prepare_cached(SQL_EXCERPTS_SCOPE)?;

    let mut rows = statement.query(named_params! {
        ":limit": EXCERPTS_WHOLE_MAX,
        ":scope_kind": kind,
        ":scope_value": value,
    })?;

    let mut excerpts: Vec<Excerpt> = Vec::new();

    while let Some(row) = rows.next()? {
        excerpts.push(excerpt_of(row)?);
    }

    assert!(excerpts.len() <= usize_of!(EXCERPTS_WHOLE_MAX));
    assert!(excerpts.is_sorted_by(|left, right| excerpt_order(left, right).is_le()));

    Ok(Some(excerpts))
}

pub(crate) fn hits_find(query: &str) -> AppResult<Vec<SearchHit>> {
    let Some(terms) = query::match_every_prefix(query) else {
        return Ok(Vec::new());
    };

    let expression = format!("body : ({terms})");
    let connection = index_open()?;
    let best = hits_best(&connection, &expression)?;
    let mut statement = connection.prepare_cached(SQL_HIT_SNIPPET)?;
    let mut hits: Vec<SearchHit> = Vec::with_capacity(best.len());

    for row in best {
        let snippet: String = statement.query_row(
            named_params! {
                ":chunk_id": row.chunk_id,
                ":ellipsis": SNIPPET_ELLIPSIS,
                ":expression": expression,
                ":tokens": SNIPPET_TOKENS_MAX,
            },
            |result| result.get(0),
        )?;

        hits.push(SearchHit {
            job_id: row.job_id,
            segment_index_first: row.segment_index_first,
            segment_index_last: row.segment_index_last,
            snippet: snippet.trim().to_owned(),
            source: row.source,
            start_seconds: row.start_seconds,
        });
    }

    assert!(hits.len() <= usize_of!(HITS_MAX));
    assert!(hits.iter().all(|hit| workspace::job_id_is_valid(&hit.job_id)));

    Ok(hits)
}

pub(crate) fn job_refresh(id: &str) -> AppResult<Refresh> {
    workspace::job_id_validate(id)?;

    let people = people_load_all()?;
    let mut connection = index_open()?;

    job_refresh_with(&mut connection, id, &people)
}

pub(crate) fn meaning_rank(query: &QueryVector, scope: &Scope) -> AppResult<Vec<i64>> {
    let connection = index_open()?;
    let ranked = vector::rank_by_vector(&connection, query, scope)?;

    assert!(ranked.len() <= usize_of!(LIST_CHUNKS_MAX));
    assert!(ranked.iter().all(|chunk_id| *chunk_id > 0));

    Ok(ranked)
}

pub(crate) fn names_recent(count_max: u32) -> AppResult<Vec<String>> {
    assert!(count_max > 0);

    let connection = index_open()?;
    let mut statement = connection.prepare_cached(SQL_MEETING_NAMES)?;
    let mut rows = statement.query(named_params! { ":limit": MEETINGS_MAX })?;
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut names: Vec<String> = Vec::new();

    while let Some(row) = rows.next()? {
        let stored: String = row.get(0)?;
        let listed: Vec<String> = serde_json::from_str(&stored)?;

        for name in listed {
            if seen.insert(name.to_lowercase()) {
                names.push(name);
            }
        }

        if names.len() >= usize_of!(count_max) {
            break;
        }
    }

    names.truncate(usize_of!(count_max));

    assert!(names.len() <= seen.len());
    assert!(names.iter().all(|name| !name.is_empty()));

    Ok(names)
}

pub(crate) fn reconcile() -> AppResult<ReconcileReport> {
    let people = people_load_all()?;
    let mut connection = index_open()?;
    let mut ids = meeting_ids(&connection)?;
    let mut report = ReconcileReport::default();

    ids.extend(workspace::jobs_list_all()?.into_iter().map(|meta| meta.id));

    for id in &ids {
        let refreshed = job_refresh_with(&mut connection, id, &people);

        report.count(id, &refreshed);
    }

    let pruned = vector::vectors_prune_orphans(&connection)?;
    let total = report.failed + report.indexed + report.removed + report.unchanged;

    tracing::debug!(pruned, "vectors whose passages left the index were dropped");

    assert_eq!(usize_of!(total), ids.len());

    Ok(report)
}

pub(crate) fn reconcile_spawn() {
    let _reconciling = tauri::async_runtime::spawn_blocking(|| {
        match reconcile() {
            Ok(report) => tracing::info!(
                failed = report.failed,
                indexed = report.indexed,
                removed = report.removed,
                unchanged = report.unchanged,
                "search index reconciled with the jobs folder",
            ),
            Err(error) => tracing::warn!(%error, "search index could not be reconciled"),
        }

        vector::worker_wake();
    });
}

fn chunks_insert(
    transaction: &Transaction<'_>,
    meta: &JobMeta,
    names: &[String],
    drafts: &[ChunkDraft],
) -> AppResult<()> {
    let header = chunk::header_build(meta, names);
    let mut chunk_statement = transaction.prepare_cached(SQL_CHUNK_INSERT)?;
    let mut text_statement = transaction.prepare_cached(SQL_TEXT_INSERT)?;
    let mut ordinals: BTreeMap<ChunkSource, u32> = BTreeMap::new();

    for draft in drafts {
        let ordinal = ordinals.entry(draft.source).or_insert(0);
        let parts = vector::PassageParts { body: &draft.body, header: &header };
        let digest = vector::passage_digest(&vector::passage_text(parts));

        let chunk_id = chunk_statement.insert(named_params! {
            ":characters": chars_count(&draft.body),
            ":end_seconds": draft.end_seconds,
            ":heading": draft.heading,
            ":job_id": meta.id,
            ":ordinal": *ordinal,
            ":passage_digest": digest,
            ":segment_index_first": draft.segment_index_first,
            ":segment_index_last": draft.segment_index_last,
            ":source": draft.source.name(),
            ":start_seconds": draft.start_seconds,
        })?;

        let inserted = text_statement.execute(named_params! {
            ":body": draft.body,
            ":chunk_id": chunk_id,
            ":header": header,
        })?;

        assert_eq!(inserted, 1);

        *ordinal += 1;
    }

    assert_eq!(usize_of!(ordinals.values().sum::<u32>()), drafts.len());

    Ok(())
}

fn excerpt_at(connection: &Connection, job_id: &str, ordinal: u32) -> AppResult<Option<Excerpt>> {
    assert!(workspace::job_id_is_valid(job_id));
    assert!(ordinal < chunk::CHUNKS_MAX);

    let mut statement = connection.prepare_cached(SQL_EXCERPT_AT)?;

    let mut rows = statement.query(named_params! {
        ":job_id": job_id,
        ":ordinal": ordinal,
        ":source": ChunkSource::Transcript.name(),
    })?;

    let Some(row) = rows.next()? else {
        return Ok(None);
    };

    let excerpt = excerpt_of(row)?;

    assert_eq!(excerpt.job_id, job_id);
    assert_eq!(excerpt.ordinal, ordinal);

    Ok(Some(excerpt))
}

fn excerpt_of(row: &Row<'_>) -> AppResult<Excerpt> {
    let source_text: String = row.get("source")?;

    let source = ChunkSource::parse(&source_text).ok_or_else(|| {
        AppError::Index(format!("a chunk carries the unknown source {source_text:?}"))
    })?;

    let excerpt = Excerpt {
        body: row.get("body")?,
        characters: row.get("characters")?,
        end_seconds: row.get("end_seconds")?,
        heading: row.get("heading")?,
        held_at_unix: row.get("held_at_unix")?,
        job_id: row.get("job_id")?,
        ordinal: row.get("ordinal")?,
        segment_index_first: row.get("segment_index_first")?,
        segment_index_last: row.get("segment_index_last")?,
        source,
        start_seconds: row.get("start_seconds")?,
    };

    assert!(excerpt.characters > 0);
    assert_ne!(excerpt.body, "");

    Ok(excerpt)
}

fn excerpt_order(left: &Excerpt, right: &Excerpt) -> Ordering {
    left.held_at_unix
        .cmp(&right.held_at_unix)
        .then_with(|| left.job_id.cmp(&right.job_id))
        .then_with(|| left.source.cmp(&right.source))
        .then_with(|| left.ordinal.cmp(&right.ordinal))
}

fn excerpts_choose(connection: &Connection, fused: &[(i64, f64)]) -> AppResult<Vec<Excerpt>> {
    let mut statement = connection.prepare_cached(SQL_EXCERPT)?;
    let mut chosen: Vec<Excerpt> = Vec::new();
    let mut characters_total = 0_u32;

    for (chunk_id, _score) in fused {
        if chosen.len() >= usize_of!(EXCERPTS_RANKED_MAX) {
            break;
        }

        let mut rows = statement.query(named_params! { ":chunk_id": chunk_id })?;

        let Some(row) = rows.next()? else {
            continue;
        };

        let excerpt = excerpt_of(row)?;

        if characters_total + excerpt.characters > EXCERPTS_RANKED_CHARS_MAX {
            continue;
        }

        characters_total += excerpt.characters;
        chosen.push(excerpt);
    }

    assert!(characters_total <= EXCERPTS_RANKED_CHARS_MAX);
    assert!(chosen.len() <= usize_of!(EXCERPTS_RANKED_MAX));

    Ok(chosen)
}

fn excerpts_expand(connection: &Connection, hits: Vec<Excerpt>) -> AppResult<Vec<Excerpt>> {
    assert!(hits.len() <= usize_of!(EXCERPTS_RANKED_MAX));

    let mut taken: BTreeSet<(String, u32)> = hits
        .iter()
        .filter(|hit| hit.source == ChunkSource::Transcript)
        .map(|hit| (hit.job_id.clone(), hit.ordinal))
        .collect();

    let mut characters_total: u32 = hits.iter().map(|hit| hit.characters).sum();
    let mut neighbours: Vec<Excerpt> = Vec::new();

    for hit in hits.iter().filter(|hit| hit.source == ChunkSource::Transcript) {
        for ordinal in neighbour_ordinals(hit.ordinal).into_iter().flatten() {
            if !taken.insert((hit.job_id.clone(), ordinal)) {
                continue;
            }

            let Some(neighbour) = excerpt_at(connection, &hit.job_id, ordinal)? else {
                continue;
            };

            if characters_total + neighbour.characters > EXCERPTS_RANKED_CHARS_MAX {
                continue;
            }

            characters_total += neighbour.characters;
            neighbours.push(neighbour);
        }
    }

    assert!(characters_total <= EXCERPTS_RANKED_CHARS_MAX);
    assert!(neighbours.len() <= hits.len() * usize_of!(EXCERPT_NEIGHBOURS_MAX));

    Ok(hits.into_iter().chain(neighbours).collect())
}

fn hits_best(connection: &Connection, expression: &str) -> AppResult<Vec<HitRow>> {
    let mut statement = connection.prepare_cached(SQL_HITS_BEST)?;

    let mut rows = statement.query(named_params! {
        ":expression": expression,
        ":limit": HITS_CHUNKS_MAX,
    })?;

    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut best: Vec<HitRow> = Vec::new();

    while let Some(row) = rows.next()? {
        if best.len() >= usize_of!(HITS_MAX) {
            break;
        }

        let job_id: String = row.get("job_id")?;

        if seen.contains(&job_id) {
            continue;
        }

        let source_text: String = row.get("source")?;

        let source = ChunkSource::parse(&source_text).ok_or_else(|| {
            AppError::Index(format!("a chunk carries the unknown source {source_text:?}"))
        })?;

        let inserted = seen.insert(job_id.clone());

        assert!(inserted);

        best.push(HitRow {
            chunk_id: row.get("chunk_id")?,
            job_id,
            segment_index_first: row.get("segment_index_first")?,
            segment_index_last: row.get("segment_index_last")?,
            source,
            start_seconds: row.get("start_seconds")?,
        });
    }

    assert_eq!(best.len(), seen.len());

    Ok(best)
}

fn ids_collect(rows: &mut Rows<'_>) -> AppResult<Vec<i64>> {
    let mut ranked: Vec<i64> = Vec::new();

    while let Some(row) = rows.next()? {
        if ranked.len() >= usize_of!(LIST_CHUNKS_MAX) {
            break;
        }

        ranked.push(row.get(0)?);
    }

    assert!(ranked.len() <= usize_of!(LIST_CHUNKS_MAX));

    Ok(ranked)
}

fn index_open() -> AppResult<Connection> {
    let path = workspace::root_file_path(INDEX_FILE_NAME)?;
    let mut connection = Connection::open(&path)?;

    connection.busy_timeout(Duration::from_millis(BUSY_TIMEOUT_MS))?;
    connection.pragma_update(None, "foreign_keys", true)?;
    connection.pragma_update(None, "synchronous", "NORMAL")?;

    let journal: String =
        connection.pragma_update_and_check(None, "journal_mode", "WAL", |row| row.get(0))?;

    if !journal.eq_ignore_ascii_case("wal") {
        tracing::debug!("the search index runs in {journal} journal mode");
    }

    schema_ensure(&mut connection)?;

    Ok(connection)
}

fn job_digest(files: &JobFiles, names: &[String]) -> Vec<u8> {
    let mut hasher = Sha256::new();
    let parts = [Some(files.meta.as_str()), files.notes.as_deref(), files.transcript.as_deref()];

    hasher.update(INDEX_VERSION.to_le_bytes());

    for part in parts.into_iter().chain(names.iter().map(|name| Some(name.as_str()))) {
        let Some(text) = part else {
            hasher.update([0_u8]);

            continue;
        };

        let length = u64::try_from(text.len()).unwrap_or(u64::MAX);

        hasher.update([1_u8]);
        hasher.update(length.to_le_bytes());
        hasher.update(text.as_bytes());
    }

    let digest = hasher.finalize().to_vec();

    assert_eq!(digest.len(), 32);

    digest
}

fn job_drafts(files: &JobFiles) -> AppResult<Vec<ChunkDraft>> {
    let mut drafts = files.notes.as_deref().map(chunk::chunks_from_notes).unwrap_or_default();

    if let Some(raw) = files.transcript.as_deref() {
        let transcript: Transcript = serde_json::from_str(raw)?;

        drafts.extend(chunk::chunks_from_transcript(&transcript));
    }

    assert!(drafts.iter().all(|draft| !draft.body.is_empty()));

    Ok(drafts)
}

fn job_forget(transaction: &Transaction<'_>, id: &str) -> AppResult<Refresh> {
    let removed = job_rows_delete(transaction, id)?;

    if removed {
        return Ok(Refresh::Removed);
    }

    Ok(Refresh::Unchanged)
}

fn job_meta_parse(files: &JobFiles, id: &str) -> AppResult<JobMeta> {
    let meta: JobMeta = serde_json::from_str(&files.meta)?;

    if meta.id != id {
        return Err(AppError::Config(format!(
            "the folder for job {id} holds metadata for job {}",
            meta.id,
        )));
    }

    Ok(meta)
}

fn job_refresh_in(
    transaction: &Transaction<'_>,
    id: &str,
    people: &[Person],
) -> AppResult<Refresh> {
    let Some(files) = workspace::job_files_load(id)? else {
        return job_forget(transaction, id);
    };

    let meta = match job_meta_parse(&files, id) {
        Ok(meta) => meta,
        Err(error) => {
            tracing::warn!(
                job = %id,
                %error,
                "a job with unreadable metadata left the search index",
            );

            return job_forget(transaction, id);
        }
    };

    let names = chunk::people_names(&meta, people);
    let digest = job_digest(&files, &names);

    let stored: Option<Vec<u8>> = transaction
        .query_row(SQL_MEETING_DIGEST, named_params! { ":job_id": id }, |row| row.get(0))
        .optional()?;

    if stored.as_deref() == Some(digest.as_slice()) {
        return Ok(Refresh::Unchanged);
    }

    let drafts = job_drafts(&files)?;
    let held_at_unix = meta.recorded_at_unix.unwrap_or(meta.created_at_unix);
    let names_json = serde_json::to_string(&names)?;
    let project = meta.project.as_deref().map(str::trim).filter(|project| !project.is_empty());
    let replaced = job_rows_delete(transaction, id)?;

    let inserted = transaction.execute(
        SQL_MEETING_INSERT,
        named_params! {
            ":digest": digest,
            ":held_at_unix": held_at_unix,
            ":job_id": id,
            ":names": names_json,
            ":project": project,
        },
    )?;

    assert_eq!(inserted, 1);
    assert_eq!(replaced, stored.is_some());

    chunks_insert(transaction, &meta, &names, &drafts)?;

    Ok(Refresh::Indexed)
}

fn job_refresh_with(
    connection: &mut Connection,
    id: &str,
    people: &[Person],
) -> AppResult<Refresh> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let refreshed = job_refresh_in(&transaction, id, people)?;

    transaction.commit()?;

    Ok(refreshed)
}

fn job_rows_delete(transaction: &Transaction<'_>, id: &str) -> AppResult<bool> {
    let texts = transaction.execute(SQL_JOB_DELETE_TEXT, named_params! { ":job_id": id })?;
    let chunks = transaction.execute(SQL_JOB_DELETE_CHUNKS, named_params! { ":job_id": id })?;
    let meetings = transaction.execute(SQL_JOB_DELETE_MEETING, named_params! { ":job_id": id })?;

    assert_eq!(texts, chunks);
    assert!(meetings <= 1);

    if meetings == 0 {
        assert_eq!(chunks, 0);
    }

    Ok(meetings == 1)
}

fn meeting_ids(connection: &Connection) -> AppResult<BTreeSet<String>> {
    let mut statement = connection.prepare_cached(SQL_MEETING_IDS)?;
    let mut rows = statement.query(named_params! { ":limit": MEETINGS_MAX })?;
    let mut ids: BTreeSet<String> = BTreeSet::new();

    while let Some(row) = rows.next()? {
        let inserted = ids.insert(row.get(0)?);

        assert!(inserted);
    }

    assert!(ids.len() <= usize_of!(MEETINGS_MAX));

    Ok(ids)
}

fn neighbour_ordinals(ordinal: u32) -> [Option<u32>; 2] {
    assert!(ordinal < chunk::CHUNKS_MAX);

    let after = ordinal.checked_add(1).filter(|next| *next < chunk::CHUNKS_MAX);
    let ordinals = [after, ordinal.checked_sub(1)];

    assert_eq!(ordinals.len(), usize_of!(EXCERPT_NEIGHBOURS_MAX));
    assert!(ordinals.iter().flatten().all(|neighbour| neighbour.abs_diff(ordinal) == 1));

    ordinals
}

fn rank_by_latest(connection: &Connection, scope: &Scope) -> AppResult<Vec<i64>> {
    let (kind, value) = scope.binding();
    let mut statement = connection.prepare_cached(SQL_RANK_LATEST)?;

    let mut rows = statement.query(named_params! {
        ":limit": LIST_CHUNKS_MAX,
        ":scope_kind": kind,
        ":scope_value": value,
    })?;

    ids_collect(&mut rows)
}

fn rank_by_match(
    connection: &Connection,
    expression: &str,
    scope: &Scope,
    weight_header: f64,
) -> AppResult<Vec<i64>> {
    assert_ne!(expression, "");
    assert!(weight_header >= 0.0_f64);

    let (kind, value) = scope.binding();
    let mut statement = connection.prepare_cached(SQL_RANK_MATCH)?;

    let mut rows = statement.query(named_params! {
        ":expression": expression,
        ":limit": LIST_CHUNKS_MAX,
        ":scope_kind": kind,
        ":scope_value": value,
        ":weight_body": WEIGHT_BODY,
        ":weight_header": weight_header,
    })?;

    ids_collect(&mut rows)
}

fn rank_by_window(
    connection: &Connection,
    window: TimeWindow,
    scope: &Scope,
) -> AppResult<Vec<i64>> {
    assert!(window.start_unix <= window.end_unix);

    let (kind, value) = scope.binding();
    let mut statement = connection.prepare_cached(SQL_RANK_WINDOW)?;

    let mut rows = statement.query(named_params! {
        ":center_unix": window.center_unix(),
        ":end_unix": window.end_unix,
        ":limit": LIST_CHUNKS_MAX,
        ":scope_kind": kind,
        ":scope_value": value,
        ":start_unix": window.start_unix,
    })?;

    ids_collect(&mut rows)
}

fn ranks_fuse(lists: &[RankedList]) -> Vec<(i64, f64)> {
    let mut scores: BTreeMap<i64, f64> = BTreeMap::new();

    for list in lists {
        assert!(list.weight > 0.0_f64);

        for (rank, chunk_id) in (1_u32..).zip(&list.chunk_ids) {
            *scores.entry(*chunk_id).or_insert(0.0_f64) += list.weight / (RRF_K + f64::from(rank));
        }
    }

    let mut fused: Vec<(i64, f64)> = scores.into_iter().collect();

    fused.sort_by(|left, right| right.1.total_cmp(&left.1).then(left.0.cmp(&right.0)));

    assert!(fused.len() <= lists.iter().map(|list| list.chunk_ids.len()).sum());
    assert!(fused.iter().all(|(_chunk_id, score)| *score > 0.0_f64));

    fused
}

fn ranks_fused(
    connection: &Connection,
    plan: &RankPlan,
    scope: &Scope,
) -> AppResult<Vec<(i64, f64)>> {
    assert!(plan.queries.len() <= usize_of!(QUERIES_MAX));

    let mut lists: Vec<RankedList> = Vec::with_capacity(plan.queries.len() + 4);

    for expression in &plan.queries {
        let matched = rank_by_match(connection, expression, scope, WEIGHT_HEADER_TOPIC)?;

        lists.push(RankedList::even(matched));
    }

    if let Some(names) = plan.names.as_deref() {
        lists.push(RankedList::even(rank_by_match(connection, names, scope, WEIGHT_HEADER_NAMES)?));
    }

    if let Some(window) = plan.window {
        lists.push(RankedList::even(rank_by_window(connection, window, scope)?));
    }

    if plan.latest {
        lists.push(RankedList::even(rank_by_latest(connection, scope)?));
    }

    let meaning = plan.meaning.as_ref().zip(weight_meaning(plan));

    if let Some((chunk_ids, weight)) = meaning {
        assert!(chunk_ids.len() <= usize_of!(LIST_CHUNKS_MAX));

        lists.push(RankedList { chunk_ids: chunk_ids.clone(), weight });
    }

    let fused = ranks_fuse(&lists);

    assert!(lists.len() <= usize_of!(QUERIES_MAX) + 4);
    assert!(fused.len() <= lists.len() * usize_of!(LIST_CHUNKS_MAX));

    Ok(fused)
}

fn schema_ensure(connection: &mut Connection) -> AppResult<()> {
    if schema_version(connection)? == INDEX_VERSION {
        return Ok(());
    }

    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;

    if schema_version(&transaction)? != INDEX_VERSION {
        transaction.execute_batch(SQL_SCHEMA)?;
        transaction.pragma_update(None, "user_version", INDEX_VERSION)?;

        tracing::info!("search index created for schema version {INDEX_VERSION}");
    }

    transaction.commit()?;

    assert_eq!(schema_version(connection)?, INDEX_VERSION);

    Ok(())
}

fn schema_version(connection: &Connection) -> AppResult<i32> {
    let version: i32 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;

    assert!(version >= 0_i32);

    Ok(version)
}

fn weight_meaning(plan: &RankPlan) -> Option<f64> {
    assert!(plan.queries.len() <= usize_of!(QUERIES_MAX));

    let topics = u32::try_from(plan.queries.len()).unwrap_or(QUERIES_MAX);

    if topics == 0 {
        return None;
    }

    assert!(topics <= QUERIES_MAX);

    Some(f64::from(topics))
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    use crate::transcription::types::TranscriptSegment;
    use crate::workspace::TranscriptSlot;
    use crate::workspace::test_support::meta_with;

    pub(crate) fn job_saved(title: &str, held_at_unix: i64) -> String {
        assert_ne!(title, "");
        assert!(held_at_unix > 0);

        let id = workspace::job_id_from_text(title);
        let mut meta = meta_with(&id, held_at_unix);

        meta.title = Some(title.to_owned());
        workspace::meta_save(&meta).unwrap();

        id
    }

    pub(crate) fn ranked_jobs(plan: &RankPlan, scope: &Scope) -> Vec<String> {
        let connection = index_open().unwrap();
        let fused = ranks_fused(&connection, plan, scope).unwrap();
        let mut statement =
            connection.prepare("SELECT job_id FROM chunk WHERE chunk_id = :chunk_id").unwrap();

        fused
            .iter()
            .map(|(chunk_id, _score)| {
                statement
                    .query_row(named_params! { ":chunk_id": chunk_id }, |row| row.get(0))
                    .unwrap()
            })
            .collect()
    }

    pub(crate) fn transcript_saved(id: &str, lines: &[&str]) {
        let segments: Vec<TranscriptSegment> = (0_u32..)
            .zip(lines)
            .map(|(index, line)| TranscriptSegment {
                text: (*line).to_owned(),
                start_seconds: f64::from(index) * 30.0,
                end_seconds: f64::from(index + 1) * 30.0,
            })
            .collect();

        let transcript = Transcript { text: lines.join(" "), segments };
        let slot = TranscriptSlot { engine_id: "imported", job_id: id };

        workspace::transcript_save(&slot, &transcript).unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::{job_saved, ranked_jobs, transcript_saved};
    use super::*;
    use crate::workspace::test_support::{meta_with, root_scoped};

    fn generator_next(state: &mut u64) -> u64 {
        *state ^= *state << 13_u32;
        *state ^= *state >> 7_u32;
        *state ^= *state << 17_u32;

        *state
    }

    fn integrity_check() {
        let connection = index_open().unwrap();

        connection
            .execute_batch("INSERT INTO chunk_text (chunk_text) VALUES ('integrity-check')")
            .unwrap();

        let orphans: i64 = connection
            .query_row(
                "SELECT count(*) FROM chunk WHERE NOT EXISTS \
                 (SELECT 1 FROM chunk_text WHERE chunk_text.rowid = chunk.chunk_id)",
                [],
                |row| row.get(0),
            )
            .unwrap();

        let strays: i64 = connection
            .query_row(
                "SELECT count(*) FROM chunk_text WHERE rowid NOT IN (SELECT chunk_id FROM chunk)",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(orphans, 0);
        assert_eq!(strays, 0);
    }

    fn job_id_of(id: &str) -> JobID {
        serde_json::from_value(serde_json::json!(id)).unwrap()
    }

    fn line_random(state: &mut u64, words: &[&str]) -> String {
        let pick = usize::try_from(generator_next(state) % 8).unwrap();
        let length = usize::try_from(generator_next(state) % 240).unwrap();
        let word = words.get(pick).copied().unwrap_or("filler");

        format!("{word} {}", "talk ".repeat(length))
    }

    fn meeting_count() -> i64 {
        let connection = index_open().unwrap();

        connection.query_row("SELECT count(*) FROM meeting", [], |row| row.get(0)).unwrap()
    }

    fn plan_of(words: &[&str]) -> RankPlan {
        let queries = words.iter().map(|word| query::match_any(&[(*word).to_owned()]).unwrap());

        RankPlan { queries: queries.collect(), ..RankPlan::default() }
    }

    #[test]
    fn a_saved_job_is_found_by_the_words_in_its_notes_and_its_transcript() {
        let _root = root_scoped();
        let noted = job_saved("Kickoff", 2);
        let spoken = job_saved("Standup", 1);

        workspace::notes_save(&noted, b"Line one.\n\n# Risks\nThe rollout slipped a week.\n")
            .unwrap();
        transcript_saved(&spoken, &["hello all", "we discussed the ROLLOUT plan", "bye"]);

        let hits = hits_find(" Rollout ").unwrap();
        let found: BTreeMap<&str, &SearchHit> =
            hits.iter().map(|hit| (hit.job_id.as_str(), hit)).collect();

        assert_eq!(hits.len(), 2);
        assert_eq!(found[noted.as_str()].source, ChunkSource::Notes);
        assert!(found[noted.as_str()].snippet.contains("rollout slipped"));

        let transcript_hit = found[spoken.as_str()];

        assert_eq!(transcript_hit.source, ChunkSource::Transcript);
        assert_eq!(transcript_hit.segment_index_first, Some(0));
        assert_eq!(transcript_hit.segment_index_last, Some(1));
        assert_eq!(transcript_hit.start_seconds, Some(0.0_f64));
        assert_eq!(hits_find("roll").unwrap().len(), 2);
        assert_eq!(hits_find("rollout slipped").unwrap().len(), 1);
        assert_eq!(hits_find("absent").unwrap().len(), 0);
        assert_eq!(hits_find("Kickoff").unwrap().len(), 0);
        assert_eq!(hits_find("   ").unwrap().len(), 0);

        integrity_check();
    }

    #[test]
    fn deleting_a_job_or_its_notes_takes_it_out_of_the_index() {
        let _root = root_scoped();
        let kept = job_saved("Kept", 2);
        let gone = job_saved("Gone", 1);

        workspace::notes_save(&kept, b"quarterly forecast").unwrap();
        workspace::notes_save(&gone, b"quarterly forecast").unwrap();

        assert_eq!(hits_find("forecast").unwrap().len(), 2);

        workspace::job_delete(&gone).unwrap();

        let hits = hits_find("forecast").unwrap();

        assert_eq!(hits.len(), 1);
        assert_eq!(hits.first().unwrap().job_id, kept);
        assert_eq!(meeting_count(), 1);

        workspace::notes_save(&kept, b"").unwrap();

        assert_eq!(hits_find("forecast").unwrap().len(), 0);
        assert_eq!(meeting_count(), 1);

        integrity_check();
    }

    #[test]
    fn a_refresh_of_an_unchanged_job_writes_nothing_and_a_change_rewrites_it() {
        let _root = root_scoped();
        let id = job_saved("Steady", 1);

        assert_eq!(job_refresh(&id).unwrap(), Refresh::Unchanged);

        workspace::notes_save(&id, b"first draft").unwrap();

        assert_eq!(job_refresh(&id).unwrap(), Refresh::Unchanged);
        assert_eq!(hits_find("draft").unwrap().len(), 1);

        std::fs::write(workspace::job_notes_path(&id).unwrap(), "second version").unwrap();

        assert_eq!(job_refresh(&id).unwrap(), Refresh::Indexed);
        assert_eq!(hits_find("draft").unwrap().len(), 0);
        assert_eq!(hits_find("version").unwrap().len(), 1);
    }

    #[test]
    fn reconcile_repairs_whatever_changed_behind_its_back() {
        let _root = root_scoped();
        let edited = job_saved("Edited", 3);
        let removed = job_saved("Removed", 2);
        let untouched = job_saved("Untouched", 1);

        workspace::notes_save(&untouched, b"stable words").unwrap();
        std::fs::write(workspace::job_notes_path(&edited).unwrap(), "drifted words").unwrap();
        std::fs::remove_dir_all(workspace::jobs_directory().unwrap().join(&removed)).unwrap();

        assert_eq!(hits_find("drifted").unwrap().len(), 0);
        assert_eq!(meeting_count(), 3);

        let report = reconcile().unwrap();

        assert_eq!(report, ReconcileReport { failed: 0, indexed: 1, removed: 1, unchanged: 1 });
        assert_eq!(hits_find("drifted").unwrap().len(), 1);
        assert_eq!(meeting_count(), 2);
        assert_eq!(reconcile().unwrap().unchanged, 2);
        assert!(!workspace::jobs_directory().unwrap().join(&removed).exists());

        integrity_check();
    }

    #[test]
    fn a_folder_whose_metadata_names_another_job_stays_out_of_the_index() {
        let _root = root_scoped();
        let honest = job_saved("Honest", 1);
        let mut meta = meta_with(&honest, 1);

        meta.id = workspace::job_id_from_text("other");

        let raw = serde_json::to_string(&meta).unwrap();

        workspace::notes_save(&honest, b"confidential plans").unwrap();

        assert_eq!(hits_find("confidential").unwrap().len(), 1);

        std::fs::write(workspace::job_meta_path(&honest).unwrap(), raw).unwrap();

        assert_eq!(job_refresh(&honest).unwrap(), Refresh::Removed);
        assert_eq!(hits_find("confidential").unwrap().len(), 0);
        assert_eq!(meeting_count(), 0);
    }

    #[test]
    fn a_renamed_person_reaches_the_index_through_reconcile() {
        let _root = root_scoped();
        let id = workspace::job_id_from_text("people");
        let mut meta = meta_with(&id, 1);

        let mut person = Person {
            id: "p1".to_owned(),
            name_first: "Jordan".to_owned(),
            name_last: "Reyes".to_owned(),
            role: String::new(),
            description: String::new(),
        };

        crate::people::storage::person_upsert(&person).unwrap();
        meta.person_ids = vec![person.id.clone()];
        workspace::meta_save(&meta).unwrap();
        workspace::notes_save(&id, b"pricing talk").unwrap();

        let plan =
            RankPlan { names: query::match_any(&["Reyes".to_owned()]), ..RankPlan::default() };

        assert_eq!(excerpts_rank(&plan, &Scope::All).unwrap().len(), 1);

        person.name_last = "Okafor".to_owned();
        crate::people::storage::person_upsert(&person).unwrap();

        assert_eq!(reconcile().unwrap().indexed, 1);
        assert_eq!(excerpts_rank(&plan, &Scope::All).unwrap().len(), 0);

        let renamed =
            RankPlan { names: query::match_any(&["Okafor".to_owned()]), ..RankPlan::default() };

        assert_eq!(excerpts_rank(&renamed, &Scope::All).unwrap().len(), 1);
    }

    #[test]
    fn recent_names_come_newest_first_once_each_and_match_every_meta() {
        let _root = root_scoped();
        let older = workspace::job_id_from_text("names-older");
        let newer = workspace::job_id_from_text("names-newer");
        let mut meta_older = meta_with(&older, 1_000);
        let mut meta_newer = meta_with(&newer, 2_000);

        meta_older.attendees = vec!["Ana Lopez".to_owned(), "Ben Ng".to_owned()];
        meta_newer.attendees = vec!["ben ng".to_owned(), " Chris Wu ".to_owned()];
        workspace::meta_save(&meta_older).unwrap();
        workspace::meta_save(&meta_newer).unwrap();

        let names = names_recent(10).unwrap();

        let reference: BTreeSet<String> = workspace::jobs_list_all()
            .unwrap()
            .iter()
            .flat_map(|meta| meta.attendees.iter().map(|name| name.trim().to_lowercase()))
            .collect();

        let indexed: BTreeSet<String> = names.iter().map(|name| name.to_lowercase()).collect();

        assert_eq!(names, ["ben ng", "Chris Wu", "Ana Lopez"]);
        assert_eq!(indexed, reference);
        assert_eq!(names_recent(2).unwrap(), ["ben ng", "Chris Wu"]);

        meta_newer.attendees = vec!["Dana Kim".to_owned()];
        workspace::meta_save(&meta_newer).unwrap();

        assert_eq!(names_recent(10).unwrap(), ["Dana Kim", "Ana Lopez", "Ben Ng"]);
    }

    #[test]
    fn an_index_from_another_schema_version_is_rebuilt_empty_and_refilled() {
        let _root = root_scoped();
        let id = job_saved("Versioned", 1);

        workspace::notes_save(&id, b"migration words").unwrap();

        let connection = index_open().unwrap();

        connection.pragma_update(None, "user_version", INDEX_VERSION + 1_i32).unwrap();
        drop(connection);

        assert_eq!(meeting_count(), 0);
        assert_eq!(hits_find("migration").unwrap().len(), 0);
        assert_eq!(reconcile().unwrap().indexed, 1);
        assert_eq!(hits_find("migration").unwrap().len(), 1);
    }

    #[test]
    fn no_typed_input_breaks_the_search_box_query() {
        let _root = root_scoped();
        let id = job_saved("Fuzz", 1);
        let notes = "Caf\u{e9} \"quoted\" NEAR(a b) col:umn ^start x*y -minus \u{345}\u{2167}";

        workspace::notes_save(&id, notes.as_bytes()).unwrap();

        let alphabet: Vec<char> =
            "ab\"'*^:()-+{}[]., \t\n\u{301}\u{345}\u{2167}\u{e9}\u{4e2d}\u{1f600}0NEAROTD"
                .chars()
                .collect();

        let mut state = 0x2545_F491_4F6C_DD1D_u64;

        for _round in 0..2000_u32 {
            let length = usize::try_from(generator_next(&mut state) % 24).unwrap();

            let input: String = std::iter::repeat_with(|| {
                let pick = usize::try_from(generator_next(&mut state)).unwrap() % alphabet.len();

                alphabet[pick]
            })
            .take(length)
            .collect();

            let hits = hits_find(&input).unwrap_or_else(|error| panic!("{input:?}: {error}"));
            let names = query::match_any(std::slice::from_ref(&input));
            let plan = RankPlan { names, ..RankPlan::default() };

            let ranked = excerpts_rank(&plan, &Scope::All)
                .unwrap_or_else(|error| panic!("{input:?}: {error}"));

            assert!(hits.len() <= 1, "{input:?}");
            assert!(ranked.len() <= 1, "{input:?}");
        }

        for input in ["NEAR", "AND", "OR", "NOT", "\"", "*", "col:", "body : x", "\u{345}", "CAFE"]
        {
            let hits = hits_find(input).unwrap_or_else(|error| panic!("{input:?}: {error}"));

            assert!(hits.len() <= 1, "{input:?}");
        }

        assert_eq!(hits_find("cafe").unwrap().len(), 1);
        assert_eq!(hits_find("NEAR").unwrap().len(), 1);
    }

    #[test]
    fn chunks_matching_more_of_the_queries_rank_first() {
        let _root = root_scoped();
        let both = job_saved("Both", 3);
        let first = job_saved("First", 2);
        let second = job_saved("Second", 1);

        workspace::notes_save(&both, b"radio equipment for the crew").unwrap();
        workspace::notes_save(&first, b"radio channels").unwrap();
        workspace::notes_save(&second, b"equipment budget").unwrap();

        let plan = plan_of(&["radio", "equipment"]);
        let ranked = ranked_jobs(&plan, &Scope::All);

        assert_eq!(ranked.first(), Some(&both));
        assert_eq!(ranked.len(), 3);
        assert!(ranked.contains(&first));
        assert!(ranked.contains(&second));
        assert_eq!(excerpts_rank(&plan, &Scope::All).unwrap().len(), 3);
    }

    #[test]
    fn a_scope_keeps_ranking_inside_its_meeting_or_project() {
        let _root = root_scoped();
        let alpha = job_saved("Alpha", 2);
        let beta = job_saved("Beta", 1);

        let patch = workspace::JobMetaPatch {
            project: Some("Tailspin Toys".to_owned()),
            ..workspace::JobMetaPatch::empty()
        };

        let patched = workspace::meta_apply_patch(&alpha, patch).unwrap();

        workspace::notes_save(&alpha, b"invoice review").unwrap();
        workspace::notes_save(&beta, b"invoice review").unwrap();

        let plan = plan_of(&["invoice"]);
        let project = Scope::Project { project: " tailspin toys ".to_owned() };
        let in_project = excerpts_rank(&plan, &project).unwrap();
        let in_meeting =
            excerpts_rank(&plan, &Scope::Meeting { job_id: job_id_of(&beta) }).unwrap();

        assert_eq!(patched.project.as_deref(), Some("Tailspin Toys"));
        assert_eq!(excerpts_rank(&plan, &Scope::All).unwrap().len(), 2);
        assert_eq!(in_project.len(), 1);
        assert_eq!(in_project.first().unwrap().job_id, alpha);
        assert_eq!(in_meeting.len(), 1);
        assert_eq!(in_meeting.first().unwrap().job_id, beta);

        let blank = Scope::Project { project: "  ".to_owned() }.validate().unwrap_err();
        let long = Scope::Project { project: "x".repeat(201) }.validate().unwrap_err();

        assert!(blank.to_string().contains("choose a folder"));
        assert!(long.to_string().contains("at most"));

        project.validate().unwrap();
    }

    #[test]
    fn a_time_window_brings_in_its_meetings_with_notes_before_transcript() {
        let _root = root_scoped();
        let inside = job_saved("Inside", 1_700_000_000);
        let outside = job_saved("Outside", 1_600_000_000);

        workspace::notes_save(&inside, b"summary of the day").unwrap();
        transcript_saved(&inside, &["opening words", "closing words"]);
        workspace::notes_save(&outside, b"other summary").unwrap();

        let window = TimeWindow { end_unix: 1_700_000_100, start_unix: 1_699_999_000 };
        let plan = RankPlan { window: Some(window), ..RankPlan::default() };
        let excerpts = excerpts_rank(&plan, &Scope::All).unwrap();
        let connection = index_open().unwrap();
        let ranked = rank_by_window(&connection, window, &Scope::All).unwrap();
        let first = excerpts_choose(&connection, &[(*ranked.first().unwrap(), 1.0_f64)]).unwrap();

        assert_eq!(excerpts.len(), 2);
        assert!(excerpts.iter().all(|excerpt| excerpt.job_id == inside));
        assert_eq!(first.first().unwrap().source, ChunkSource::Notes);
    }

    #[test]
    fn the_latest_list_starts_with_the_newest_meeting_and_its_notes() {
        let _root = root_scoped();
        let older = job_saved("Older", 10);
        let newer = job_saved("Newer", 20);

        workspace::notes_save(&older, b"older notes").unwrap();
        transcript_saved(&newer, &["newer transcript"]);
        workspace::notes_save(&newer, b"newer notes").unwrap();

        let plan = RankPlan { latest: true, ..RankPlan::default() };
        let ranked = ranked_jobs(&plan, &Scope::All);
        let connection = index_open().unwrap();
        let latest = rank_by_latest(&connection, &Scope::All).unwrap();
        let first = excerpts_choose(&connection, &[(*latest.first().unwrap(), 1.0_f64)]).unwrap();

        assert_eq!(ranked, [newer.clone(), newer, older]);
        assert_eq!(first.first().unwrap().source, ChunkSource::Notes);
    }

    #[test]
    fn a_small_scope_comes_back_whole_in_meeting_order_and_a_large_one_does_not() {
        let _root = root_scoped();
        let later = job_saved("Later", 20);
        let earlier = job_saved("Earlier", 10);

        workspace::notes_save(&later, b"# Notes\nlater notes").unwrap();
        transcript_saved(&later, &["later transcript"]);
        workspace::notes_save(&earlier, b"earlier notes").unwrap();

        let whole = excerpts_whole(&Scope::All).unwrap().unwrap();
        let order: Vec<(&str, ChunkSource)> =
            whole.iter().map(|excerpt| (excerpt.job_id.as_str(), excerpt.source)).collect();

        assert_eq!(
            order,
            [
                (earlier.as_str(), ChunkSource::Notes),
                (later.as_str(), ChunkSource::Notes),
                (later.as_str(), ChunkSource::Transcript),
            ],
        );

        let big = job_saved("Big", 30);
        let line = "word ".repeat(300);
        let lines: Vec<&str> = vec![line.as_str(); usize_of!(EXCERPTS_WHOLE_MAX)];
        let earlier_scope = Scope::Meeting { job_id: job_id_of(&earlier) };

        transcript_saved(&big, &lines);

        assert!(excerpts_whole(&Scope::All).unwrap().is_none());
        assert_eq!(excerpts_whole(&earlier_scope).unwrap().unwrap().len(), 1);
    }

    #[test]
    fn the_ranked_excerpts_stay_inside_their_count_and_character_budget() {
        let _root = root_scoped();
        let id = job_saved("Budget", 1);
        let line = format!("{} keyword", "filler ".repeat(220));
        let lines = vec![line.as_str(); 120];

        transcript_saved(&id, &lines);

        let excerpts = excerpts_rank(&plan_of(&["keyword"]), &Scope::All).unwrap();
        let characters: u32 = excerpts.iter().map(|excerpt| excerpt.characters).sum();

        assert!(!excerpts.is_empty());
        assert!(excerpts.len() <= usize_of!(EXCERPTS_RANKED_MAX));
        assert!(characters <= EXCERPTS_RANKED_CHARS_MAX);
        assert!(characters > EXCERPTS_RANKED_CHARS_MAX - chunk::CHUNK_CHARS_MAX);
    }

    #[test]
    fn a_transcript_hit_brings_in_the_passages_on_either_side_of_it() {
        let _root = root_scoped();
        let id = job_saved("Supplier review", 1);

        transcript_saved(
            &id,
            &[
                "Let's run through the supplier list.",
                "The order came in short again.",
                "We need someone on the phone with them.",
                "Who is calling the hose supplier?",
                "Priya will phone them on Monday morning.",
                "She will ask for a credit on the shortfall.",
                "Moving on to the parking lot.",
                "It gets repainted on Thursday.",
            ],
        );

        let excerpts = excerpts_rank(&plan_of(&["hose"]), &Scope::All).unwrap();
        let ordinals: Vec<u32> = excerpts.iter().map(|excerpt| excerpt.ordinal).collect();
        let bodies: Vec<&str> = excerpts.iter().map(|excerpt| excerpt.body.as_str()).collect();

        assert_eq!(ordinals, [0, 1, 2]);
        assert!(bodies[0].starts_with("Let's run through"));
        assert!(bodies[1].contains("hose supplier"));
        assert!(bodies[2].starts_with("Priya will phone them"));
        assert!(bodies.iter().all(|body| !body.contains("parking lot")));
    }

    #[test]
    fn expansion_keeps_every_chosen_excerpt_and_adds_only_the_passages_beside_them() {
        let _root = root_scoped();
        let words = ["alpha", "bravo", "charlie", "delta"];
        let mut state = 0x5851_F42D_4C95_7F2D_u64;
        let mut expanded_total = 0_usize;
        let mut budget_reached = false;

        for meeting in 0..12_u32 {
            let id = job_saved(&format!("Meeting {meeting}"), i64::from(meeting) + 1);

            let lines: Vec<String> =
                std::iter::repeat_with(|| line_random(&mut state, &words)).take(40).collect();

            let borrowed: Vec<&str> = lines.iter().map(String::as_str).collect();

            transcript_saved(&id, &borrowed);
        }

        let connection = index_open().unwrap();

        for word in words {
            let fused = ranks_fused(&connection, &plan_of(&[word]), &Scope::All).unwrap();
            let chosen = excerpts_choose(&connection, &fused).unwrap();
            let expanded = excerpts_expand(&connection, chosen.clone()).unwrap();
            let characters: u32 = expanded.iter().map(|excerpt| excerpt.characters).sum();

            let keys: BTreeSet<(&str, u32)> =
                expanded.iter().map(|excerpt| (excerpt.job_id.as_str(), excerpt.ordinal)).collect();

            assert_eq!(keys.len(), expanded.len());
            assert!(characters <= EXCERPTS_RANKED_CHARS_MAX);
            assert!(chosen.iter().all(|hit| keys.contains(&(hit.job_id.as_str(), hit.ordinal))));

            for excerpt in &expanded {
                let beside = chosen.iter().any(|hit| {
                    hit.job_id == excerpt.job_id && hit.ordinal.abs_diff(excerpt.ordinal) <= 1
                });

                assert!(beside, "{word}: {} {}", excerpt.job_id, excerpt.ordinal);
            }

            expanded_total += expanded.len() - chosen.len();
            budget_reached |= characters > EXCERPTS_RANKED_CHARS_MAX - chunk::CHUNK_CHARS_MAX;
        }

        assert!(expanded_total > 0);
        assert!(budget_reached);
    }

    #[test]
    fn fused_ranks_reward_agreement_and_keep_a_stable_order() {
        let fused = ranks_fuse(&[
            RankedList::even(vec![10, 20, 30]),
            RankedList::even(vec![30, 40]),
            RankedList::even(vec![]),
        ]);

        let ids: Vec<i64> = fused.iter().map(|(chunk_id, _score)| *chunk_id).collect();

        assert_eq!(ids, [30, 10, 20, 40]);
        assert_eq!(ranks_fuse(&[]).len(), 0);

        let tied = ranks_fuse(&[RankedList::even(vec![2]), RankedList::even(vec![1])]);

        assert_eq!(tied.iter().map(|(chunk_id, _score)| *chunk_id).collect::<Vec<_>>(), [1, 2]);
    }

    #[test]
    fn a_question_becomes_a_plan_of_terms_time_and_recency() {
        let now = Local::now();
        let topical = RankPlan::of_question("What did we decide about the radios?", now);

        assert_eq!(topical.queries, ["\"decide\" OR \"radios\""]);
        assert!(topical.window.is_none());
        assert!(!topical.latest);

        let timed = RankPlan::of_question("What did we say a week ago?", now);

        assert_eq!(timed.queries.len(), 0);
        assert!(timed.window.is_some());
        assert!(!timed.latest);

        let latest = RankPlan::of_question("Summarize my last meeting", now);
        let empty = RankPlan::of_question("What did we say?", now);

        assert_eq!(latest.queries.len(), 0);
        assert!(latest.latest);
        assert!(empty.latest);
    }
}
