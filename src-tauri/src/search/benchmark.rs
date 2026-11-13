use super::test_support::transcript_saved;
use super::vector::{QueryVector, rank_by_vector};
use super::when::TimeWindow;
use super::{
    RankPlan,
    Scope,
    excerpts_rank,
    excerpts_whole,
    index_open,
    meaning_rank,
    query,
    ranks_fused,
};
use crate::notes::ask::names_known_load;
use crate::workspace::test_support::{meta_with, root_scoped};
use crate::workspace::{self, JOB_COUNT_MAX};
use std::hint::black_box;
use std::iter::repeat_with;
use std::time::{Duration, Instant};

const DAY_SECONDS: i64 = 86_400;
const DIMENSIONS: [u32; 2] = [1024, 4096];
const HELD_START_UNIX: i64 = 1_700_000_000;
const LINE_COUNT: u32 = 120;
const ROUND_COUNT: u32 = 9;
const SPACE: &str = "benchmark";
const WORD_COMMON_COUNT: u64 = 200;
const WORD_TOPIC_COUNT: u64 = 20_000;
const WORD_TOPIC_EVERY: u32 = 7;
const WORDS_PER_LINE: u32 = 70;

const SCALES: [Scale; 3] = [
    Scale { label: "typical", meetings: 50 },
    Scale { label: "heavy", meetings: 400 },
    Scale { label: "maximum", meetings: JOB_COUNT_MAX },
];

#[derive(Debug)]
struct Scale {
    label: &'static str,
    meetings: u32,
}

#[derive(Debug)]
struct Timing {
    max: Duration,
    median: Duration,
}

fn corpus_grow(state: &mut u64, meetings: std::ops::Range<u32>) {
    assert!(meetings.start <= meetings.end);
    assert!(meetings.end <= JOB_COUNT_MAX);

    for meeting in meetings {
        let id = workspace::job_id_from_text(&format!("benchmark-{meeting}"));
        let held = HELD_START_UNIX + i64::from(meeting) * DAY_SECONDS;
        let mut meta = meta_with(&id, held);

        meta.title = Some(format!("Weekly sync {meeting}"));
        meta.attendees = vec!["Ana Lopez".to_owned(), "Ben Ng".to_owned()];

        workspace::meta_save(&meta).unwrap();

        let lines: Vec<String> =
            repeat_with(|| line_build(state)).take(usize_of!(LINE_COUNT)).collect();

        let borrowed: Vec<&str> = lines.iter().map(String::as_str).collect();

        transcript_saved(&id, &borrowed);
    }
}

fn corpus_report(scale: &Scale) {
    assert!(scale.meetings <= JOB_COUNT_MAX);

    let connection = index_open().unwrap();

    let (chunks, characters): (i64, i64) = connection
        .query_row("SELECT count(*), sum(characters) FROM chunk", [], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .unwrap();

    assert!(chunks > 0);

    println!(
        "BENCH {} library: {} meetings, {chunks} chunks, {characters} characters",
        scale.label, scale.meetings,
    );
}

fn line_build(state: &mut u64) -> String {
    assert_ne!(*state, 0);

    let words: Vec<String> = (0..WORDS_PER_LINE)
        .map(|position| {
            if position % WORD_TOPIC_EVERY == 0 {
                format!("topic{}", next(state) % WORD_TOPIC_COUNT)
            } else {
                format!("word{}", next(state) % WORD_COMMON_COUNT)
            }
        })
        .collect();

    assert_eq!(words.len(), usize_of!(WORDS_PER_LINE));

    words.join(" ")
}

fn next(state: &mut u64) -> u64 {
    assert_ne!(*state, 0);

    *state ^= *state << 13_u32;
    *state ^= *state >> 7_u32;
    *state ^= *state << 17_u32;

    assert_ne!(*state, 0);

    *state
}

fn plans_build() -> Vec<(&'static str, RankPlan)> {
    let names = query::match_any(&["Ana Lopez".to_owned()]);
    let center = HELD_START_UNIX + 30 * DAY_SECONDS;

    let window =
        TimeWindow { end_unix: center + 15 * DAY_SECONDS, start_unix: center - 15 * DAY_SECONDS };

    let plans = vec![
        ("rare words", RankPlan { queries: queries_of("topic"), ..RankPlan::default() }),
        ("common words", RankPlan { queries: queries_of("word"), ..RankPlan::default() }),
        ("a name in every meeting", RankPlan { names: names.clone(), ..RankPlan::default() }),
        ("a time window", RankPlan { window: Some(window), ..RankPlan::default() }),
        (
            "everything",
            RankPlan {
                names,
                queries: queries_of("topic"),
                window: Some(window),
                ..RankPlan::default()
            },
        ),
    ];

    assert_eq!(plans.len(), 5);
    assert!(plans.iter().all(|(label, _plan)| !label.is_empty()));

    plans
}

fn queries_of(prefix: &str) -> Vec<String> {
    assert_ne!(prefix, "");

    let queries: Vec<String> = (0..4_u32)
        .map(|group| {
            let words: Vec<String> =
                (0..3_u32).map(|word| format!("{prefix}{}", group * 37 + word * 11)).collect();

            query::match_any(&words).unwrap()
        })
        .collect();

    assert_eq!(queries.len(), 4);

    queries
}

fn stage_report(scale: &Scale, stage: &str, timing: &Timing) {
    assert!(timing.median <= timing.max);

    println!(
        "BENCH {} {stage}: median {:.1} ms, worst {:.1} ms",
        scale.label,
        timing.median.as_secs_f64() * 1000.0_f64,
        timing.max.as_secs_f64() * 1000.0_f64,
    );
}

fn stage_time<Output, Work: FnMut() -> Output>(mut work: Work) -> Timing {
    let mut samples: Vec<Duration> = Vec::with_capacity(usize_of!(ROUND_COUNT));

    for _round in 0..ROUND_COUNT {
        let start = Instant::now();

        drop(black_box(work()));
        samples.push(start.elapsed());
    }

    samples.sort();

    let median = samples[samples.len().div_euclid(2)];
    let max = samples[samples.len() - 1];

    assert_eq!(samples.len(), usize_of!(ROUND_COUNT));
    assert!(median <= max);

    Timing { max, median }
}

fn vectors_fill(dimensions: u32) -> QueryVector {
    assert!(dimensions > 0);
    assert!(dimensions.is_multiple_of(16));

    let connection = index_open().unwrap();
    let bytes = i64::from(dimensions) * 4;
    let removed = connection.execute("DELETE FROM vector", []).unwrap();

    let inserted = connection
        .execute(
            "INSERT INTO vector (passage_digest, model, embedding) \
             SELECT DISTINCT passage_digest, ?1, zeroblob(?2) FROM chunk",
            (SPACE, bytes),
        )
        .unwrap();

    let probe: Vec<f32> = (0..dimensions).map(|index| if index == 0 { 1.0 } else { 0.0 }).collect();
    let probe_bytes: Vec<u8> = probe.iter().flat_map(|value| value.to_le_bytes()).collect();

    let updated = connection
        .execute(
            "UPDATE vector SET embedding = ?1 WHERE passage_digest = \
             (SELECT passage_digest FROM chunk ORDER BY chunk_id DESC LIMIT 1)",
            [probe_bytes],
        )
        .unwrap();

    assert!(inserted > 0);
    assert_eq!(updated, 1);
    assert!(removed <= inserted);

    QueryVector { space: SPACE.to_owned(), values: probe }
}

#[test]
#[ignore = "benchmark: run with just bench"]
fn benchmark_ask_search_at_each_library_size() {
    let _root = root_scoped();
    let mut state = 0x2545_F491_4F6C_DD1D_u64;
    let mut meetings_built = 0_u32;

    for scale in &SCALES {
        let build = Instant::now();

        corpus_grow(&mut state, meetings_built..scale.meetings);
        meetings_built = scale.meetings;

        println!("BENCH {} index build: {:.1} s", scale.label, build.elapsed().as_secs_f64());

        corpus_report(scale);

        let connection = index_open().unwrap();
        let scope_check = stage_time(|| excerpts_whole(&Scope::All).unwrap());

        let names_known = stage_time(|| names_known_load().unwrap());

        stage_report(scale, "scope size check", &scope_check);
        stage_report(scale, "known names (people file and the index)", &names_known);

        for (label, plan) in plans_build() {
            let timing = stage_time(|| ranks_fused(&connection, &plan, &Scope::All).unwrap());

            stage_report(scale, &format!("keyword ranking, {label}"), &timing);
        }

        for dimensions in DIMENSIONS {
            let vector = vectors_fill(dimensions);
            let fresh = index_open().unwrap();
            let ranked = rank_by_vector(&fresh, &vector, &Scope::All).unwrap();

            let probe: i64 =
                fresh.query_row("SELECT max(chunk_id) FROM chunk", [], |row| row.get(0)).unwrap();

            assert_eq!(ranked.first(), Some(&probe));

            let vector_timing =
                stage_time(|| rank_by_vector(&fresh, &vector, &Scope::All).unwrap());

            let everything = plans_build().pop().unwrap().1;

            let rank_timing = stage_time(|| {
                let meaning = meaning_rank(&vector, &Scope::All).unwrap();
                let plan = RankPlan { meaning: Some(meaning), ..everything.clone() };

                excerpts_rank(&plan, &Scope::All).unwrap()
            });

            stage_report(
                scale,
                &format!("vector ranking, {dimensions} dimensions"),
                &vector_timing,
            );

            stage_report(scale, &format!("whole search, everything at {dimensions}"), &rank_timing);
        }
    }
}
