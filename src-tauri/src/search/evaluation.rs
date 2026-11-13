use super::test_support::{ranked_jobs, transcript_saved};
use super::vector::{
    QueryVector,
    embeddings_create,
    passages_embed,
    prompts_of,
    space_of,
    vectors_pending,
    vectors_store,
};
use super::{EXCERPTS_WHOLE_MAX, RankPlan, Scope, excerpts_rank, excerpts_whole, meaning_rank};
use crate::endpoints::types::EmbeddingsTarget;
use crate::workspace;
use crate::workspace::test_support::{meta_with, root_scoped};
use chrono::{DateTime, Local, NaiveDateTime, TimeZone};
use std::collections::BTreeMap;

const DISTRACTOR_COUNT: u32 = 52;
const DISTRACTOR_LINE_COUNT: u32 = 16;
const DISTRACTOR_LINE_TOPIC_FIRST: u32 = 5;
const DISTRACTOR_LINE_TOPIC_SECOND: u32 = 11;
const DISTRACTOR_START: &str = "2025-11-13 15:00";
const RANK_DEPTH: u32 = 5;
const RECIPROCAL_RANK_MEAN_MIN: f64 = 0.75;
const WEEK_SECONDS: i64 = 604_800;

const _: () = assert!(DISTRACTOR_LINE_TOPIC_SECOND < DISTRACTOR_LINE_COUNT);
const _: () = assert!(DISTRACTOR_COUNT * DISTRACTOR_LINE_COUNT > 2 * EXCERPTS_WHOLE_MAX);

const ATTENDEES_ROTATION: [&[&str]; 4] = [
    &["Ana Lopez", "Ben Ng"],
    &["Priya Shah", "Nathan Cole"],
    &["Marco Ruiz", "Ana Lopez"],
    &["Ben Ng", "Priya Shah"],
];

pub(crate) const CASE_BOUNDARY: Case = Case {
    answer: "Priya will phone",
    expected: "supplier",
    question: "Who is calling the hose supplier?",
    reference: "Priya will phone the hose supplier on Monday morning.",
};

pub(crate) const CASES: [Case; 12] = [
    Case {
        answer: "twelve",
        expected: "radios",
        question: "What did we decide about the radios?",
        reference: "They decided to order twelve new two-way radios for the field crew.",
    },
    Case {
        answer: "forty thousand",
        expected: "budget_recent",
        question: "We had that meeting a week and a half ago, and I think Nathan said something \
                   about the budget",
        reference: "Nathan said the budget for the trailer refit is capped at forty thousand.",
    },
    Case {
        answer: "radios",
        expected: "radios",
        question: "A month ago, there was something about talking equipment",
        reference: "The field crew check-in discussed replacing the old two-way radios.",
    },
    Case {
        answer: "shorter sign up form",
        expected: "onboarding",
        question: "What did Ana say about the onboarding flow last Tuesday?",
        reference: "Ana thinks the onboarding flow needs a shorter sign up form.",
    },
    Case {
        answer: "owns the retry work",
        expected: "retry",
        question: "Who owns the retry work?",
        reference: "Ben owns the retry work for failed uploads.",
    },
    Case {
        answer: "March 2nd",
        expected: "launch",
        question: "What is the plan for the Tailspin Toys launch?",
        reference: "The launch moves to March 2nd, with a soft opening for staff the week before.",
    },
    Case {
        answer: "cleaning",
        expected: "latest",
        question: "Summarize my last meeting",
        reference: "The vendor call agreed to renew the cleaning contract for one year and to ask \
                    for weekend coverage.",
    },
    Case {
        answer: "twentieth",
        expected: "invoices",
        question: "When is the invoice deadline?",
        reference: "The invoice deadline for contractors is the twentieth of each month.",
    },
    Case {
        answer: "technicians",
        expected: "hiring_march",
        question: "What did we say in March about hiring?",
        reference: "They planned to open two field technician roles for the spring.",
    },
    Case {
        answer: "next weekend",
        expected: "migration_recent",
        question: "Did anyone mention the server migration recently?",
        reference: "Yes, the server migration to the new data centre finishes next weekend.",
    },
    Case {
        answer: "battery packs",
        expected: "radios",
        question: "Did Ana compare the battery packs?",
        reference: "Ana said she would compare the battery packs before the radios are ordered.",
    },
    Case {
        answer: "forty thousand",
        expected: "budget_recent",
        question: "Where did we land on the trailer refit?",
        reference: "The trailer refit budget is capped at forty thousand.",
    },
];

pub(crate) const CASES_MEANING: [Case; 6] = [
    Case {
        answer: "radios",
        expected: "radios",
        question: "Which meeting was about walkie-talkies?",
        reference: "The field crew check-in, about ordering new two-way radios.",
    },
    Case {
        answer: "address step",
        expected: "onboarding",
        question: "Why do customers abandon registration?",
        reference: "Half of new users quit at the address step of the sign up form.",
    },
    Case {
        answer: "retry",
        expected: "retry",
        question: "Who is fixing the broken file transfers?",
        reference: "Ben owns the retry work for uploads that fail when the connection drops.",
    },
    Case {
        answer: "renew",
        expected: "latest",
        question: "Are we keeping the janitorial service?",
        reference: "Yes, they decided to renew the cleaning contract for one year.",
    },
    Case {
        answer: "twentieth",
        expected: "invoices",
        question: "By what date do freelancers have to bill us?",
        reference: "Contractors must send invoices by the twentieth of each month.",
    },
    Case {
        answer: "travel",
        expected: "budget_old",
        question: "Is the conference trip money on hold?",
        reference: "Yes, travel spending is frozen until further notice.",
    },
];

const LINES_FILLER: [&str; 24] = [
    "Morning, let's give people a minute to join.",
    "Can everyone see the shared screen?",
    "Nothing new from my side this week.",
    "The printer on the second floor is jammed again.",
    "Please fill in the holiday calendar before Friday.",
    "The fire drill moved to next Tuesday.",
    "Parking passes are at the front desk.",
    "Lunch is catered on Thursday for the team.",
    "Remember to lock the side door when you leave.",
    "Let's keep this one short.",
    "I'll send the notes around after this.",
    "Same as last week, mostly heads down.",
    "Any blockers before we wrap up?",
    "No blockers here.",
    "Thanks everyone, see you next week.",
    "Who is taking minutes today?",
    "The wifi in the boardroom keeps dropping.",
    "We are still waiting on the new badge photos.",
    "The kitchen fridge gets emptied on Friday.",
    "Can someone check the projector cable?",
    "Good progress overall, nothing to flag.",
    "The plants by the window need watering.",
    "The visitor log moved to the tablet at reception.",
    "Two people are out sick this week.",
];

const LINES_TOPICAL: [&str; 10] = [
    "The radios came up again but we ran out of time.",
    "We will look at the budget numbers next month.",
    "Hiring is on the agenda for the next review.",
    "The onboarding survey results are not in yet.",
    "Somebody asked about the invoice portal login.",
    "The launch checklist lives in the shared drive.",
    "The migration notes are still being written up.",
    "Retry logic came up but nobody owns it yet.",
    "The trailer at the south site needs a wash.",
    "The supplier portal is down for maintenance.",
];

const MEETING_SUPPLIER: Meeting = Meeting {
    attendees: &["Priya Shah", "Marco Ruiz"],
    held: "2026-10-15 11:00",
    key: "supplier",
    notes: "",
    project: None,
    title: "Operations sync",
    transcript: &[
        "Let's run through the parts list first.",
        "The hydraulic order came in short again.",
        "We need someone on the phone with them this week.",
        "Who is calling the hose supplier about the shortfall?",
        "Priya will phone them on Monday morning.",
        "She will ask for a credit on the missing parts.",
        "Next is the parking lot schedule.",
        "That gets repainted on Thursday.",
    ],
};

pub(crate) const QUESTIONS_UNANSWERABLE: [&str; 3] = [
    "When does the zeppelin delivery arrive?",
    "What did we decide about the Denver office lease?",
    "Who designed the new mascot costume?",
];

const MEETINGS: [Meeting; 16] = [
    Meeting {
        attendees: &["Nathan Cole", "Ana Lopez"],
        held: "2026-10-12 10:00",
        key: "radios",
        notes: "# Decisions\n- Order twelve new two-way radios for the field crew.\n\
                - Ana compares battery packs before ordering.\n\
                # Action items\n- Nathan collects quotes from two suppliers.",
        project: Some("Tailspin Toys"),
        title: "Field crew check-in",
        transcript: &[
            "Morning everyone, let's start with the crew updates.",
            "The handheld units keep dropping out past the ridge.",
            "We need better communication equipment out there before winter.",
            "The two-way radios we have are six years old.",
            "Nathan: I can get quotes from two suppliers by Friday.",
            "Ana: I'll compare the battery packs, the old ones die by noon.",
            "Let's order twelve and keep two spares in the truck.",
            "Okay, that's everything for today.",
        ],
    },
    Meeting {
        attendees: &["Nathan Cole", "Priya Shah"],
        held: "2026-11-01 10:00",
        key: "budget_recent",
        notes: "",
        project: None,
        title: "Quarterly planning",
        transcript: &[
            "Thanks for making time on a Sunday.",
            "First item is the trailer refit for the north site.",
            "Nathan said the budget for the trailer refit is capped at forty thousand.",
            "Priya asked whether that covers the new flooring.",
            "It does, as long as the contractor starts before December.",
            "We'll revisit the numbers once the quotes are in.",
        ],
    },
    Meeting {
        attendees: &["Priya Shah"],
        held: "2026-09-02 10:00",
        key: "budget_old",
        notes: "# Budget\n- The marketing budget moves to the second quarter.\n\
                - Travel spending is frozen for now.",
        project: None,
        title: "Budget review",
        transcript: &[
            "Let's go through the budget line by line.",
            "Marketing can wait until the second quarter.",
            "Travel is frozen until further notice.",
        ],
    },
    Meeting {
        attendees: &["Ana Lopez"],
        held: "2026-11-10 10:00",
        key: "onboarding",
        notes: "",
        project: None,
        title: "Product sync",
        transcript: &[
            "Quick sync today, mostly about the app.",
            "Ana thinks the onboarding flow needs a shorter sign up form.",
            "Half of new users quit at the address step.",
            "We could ask for the address later, after the first booking.",
            "Ana will mock up a two step version by next week.",
        ],
    },
    Meeting {
        attendees: &["Ben Ng"],
        held: "2026-10-22 10:00",
        key: "retry",
        notes: "# Action items\n- Ben owns the retry work for failed uploads.\n\
                - Logs move to the new dashboard.",
        project: None,
        title: "Engineering standup",
        transcript: &[
            "Uploads fail when the connection drops halfway.",
            "We should retry with a backoff instead of giving up.",
            "Ben said he can take that this sprint.",
        ],
    },
    Meeting {
        attendees: &["Ana Lopez", "Priya Shah"],
        held: "2026-10-27 10:00",
        key: "launch",
        notes: "# Launch\n- The Tailspin Toys launch moves to March 2nd.\n\
                - A soft opening for staff runs the week before.\n\
                - Signage goes up in February.",
        project: Some("Tailspin Toys"),
        title: "Launch plan",
        transcript: &[
            "The site won't be ready in January.",
            "So we push the opening to March and do a soft opening for staff first.",
        ],
    },
    Meeting {
        attendees: &["Marco Ruiz"],
        held: "2026-11-11 13:00",
        key: "latest",
        notes: "# Decisions\n- Renew the cleaning contract for one year.\n\
                - Ask for weekend coverage in the renewal.",
        project: None,
        title: "Vendor call",
        transcript: &[
            "The cleaning crew has been reliable this year.",
            "Let's renew for a year and ask about weekend coverage.",
        ],
    },
    Meeting {
        attendees: &["Priya Shah"],
        held: "2026-09-27 10:00",
        key: "invoices",
        notes: "",
        project: None,
        title: "Finance sync",
        transcript: &[
            "Contractors keep sending invoices late.",
            "The invoice deadline for the contractors is the twentieth of each month.",
            "Anything after that rolls into the next pay run.",
        ],
    },
    Meeting {
        attendees: &["Ana Lopez"],
        held: "2026-03-18 10:00",
        key: "hiring_march",
        notes: "# Hiring\n- Open two roles for field technicians in the spring.\n\
                - Post the roles on the trade school boards.",
        project: None,
        title: "Hiring plan",
        transcript: &[
            "We are short two technicians for the spring season.",
            "Hiring should start in April at the latest.",
        ],
    },
    Meeting {
        attendees: &["Ben Ng"],
        held: "2026-11-06 10:00",
        key: "hiring_recent",
        notes: "",
        project: None,
        title: "Team update",
        transcript: &["Headcount stays flat for now.", "We paused hiring until the new year."],
    },
    Meeting {
        attendees: &["Ben Ng", "Marco Ruiz"],
        held: "2026-11-07 10:00",
        key: "migration_recent",
        notes: "",
        project: None,
        title: "Infrastructure review",
        transcript: &[
            "Status on the data centre move?",
            "The server migration to the new data centre finishes next weekend.",
            "Backups run twice before the cutover.",
        ],
    },
    Meeting {
        attendees: &["Ben Ng"],
        held: "2026-07-14 10:00",
        key: "migration_old",
        notes: "# Plan\n- Plan the server migration for the autumn.\n- Price out two data centres.",
        project: None,
        title: "Infrastructure kickoff",
        transcript: &[],
    },
    Meeting {
        attendees: &["Ana Lopez", "Ben Ng"],
        held: "2026-10-05 10:00",
        key: "filler_october",
        notes: "",
        project: None,
        title: "Weekly sync",
        transcript: &[
            "Thanks everyone for joining, let's get started.",
            "Nothing new on my side this week.",
            "Same here, mostly heads down.",
            "Okay, see you all next week.",
        ],
    },
    Meeting {
        attendees: &["Ana Lopez", "Ben Ng"],
        held: "2026-10-19 10:00",
        key: "filler_mid",
        notes: "",
        project: None,
        title: "Weekly sync",
        transcript: &[
            "Can everyone hear me?",
            "Let's keep it short, a few people are out.",
            "No blockers from the team.",
        ],
    },
    Meeting {
        attendees: &["Priya Shah", "Nathan Cole"],
        held: "2026-11-03 10:00",
        key: "filler_november",
        notes: "",
        project: None,
        title: "Weekly sync",
        transcript: &[
            "Morning, we'll wait a minute for the others.",
            "The parking lot is being repainted on Thursday.",
            "Remember to submit timesheets by Friday.",
        ],
    },
    Meeting {
        attendees: &["Marco Ruiz"],
        held: "2026-11-09 10:00",
        key: "filler_monday",
        notes: "",
        project: None,
        title: "Check-in",
        transcript: &["Short one today.", "The office is closed on Wednesday for the holiday."],
    },
];

#[derive(Debug)]
pub(crate) struct Case {
    pub(crate) answer: &'static str,
    pub(crate) expected: &'static str,
    pub(crate) question: &'static str,
    pub(crate) reference: &'static str,
}

#[derive(Debug)]
struct Meeting {
    attendees: &'static [&'static str],
    held: &'static str,
    key: &'static str,
    notes: &'static str,
    project: Option<&'static str>,
    title: &'static str,
    transcript: &'static [&'static str],
}

pub(crate) fn corpus_save() -> BTreeMap<&'static str, String> {
    let mut ids: BTreeMap<&'static str, String> = BTreeMap::new();

    for meeting in &MEETINGS {
        let previous = ids.insert(meeting.key, meeting_save(meeting));

        assert!(previous.is_none());
    }

    assert_eq!(ids.len(), MEETINGS.len());

    ids
}

pub(crate) fn corpus_save_large() -> BTreeMap<&'static str, String> {
    let mut ids = corpus_save();
    let previous = ids.insert(MEETING_SUPPLIER.key, meeting_save(&MEETING_SUPPLIER));

    distractors_save();

    assert!(previous.is_none());
    assert!(excerpts_whole(&Scope::All).unwrap().is_none());

    ids
}

fn distractor_lines(week: u32) -> Vec<&'static str> {
    assert!(week < DISTRACTOR_COUNT);

    let lines: Vec<&'static str> = (0..DISTRACTOR_LINE_COUNT)
        .map(|line| match line {
            DISTRACTOR_LINE_TOPIC_FIRST => LINES_TOPICAL[usize_of!(week) % LINES_TOPICAL.len()],
            DISTRACTOR_LINE_TOPIC_SECOND => {
                LINES_TOPICAL[usize_of!(week * 3 + 7) % LINES_TOPICAL.len()]
            }
            _ => LINES_FILLER[usize_of!(week * 5 + line * 7) % LINES_FILLER.len()],
        })
        .collect();

    assert_eq!(lines.len(), usize_of!(DISTRACTOR_LINE_COUNT));
    assert!(lines.iter().all(|line| !line.is_empty()));

    lines
}

fn distractors_save() {
    let start = local(DISTRACTOR_START).timestamp();
    let last = start + i64::from(DISTRACTOR_COUNT - 1) * WEEK_SECONDS;
    let newest = MEETINGS.iter().map(|meeting| local(meeting.held).timestamp()).max().unwrap();

    assert!(last < newest);

    for week in 0..DISTRACTOR_COUNT {
        let id = workspace::job_id_from_text(&format!("distractor-{week}"));
        let mut meta = meta_with(&id, start + i64::from(week) * WEEK_SECONDS);
        let attendees = ATTENDEES_ROTATION[usize_of!(week) % ATTENDEES_ROTATION.len()];

        meta.attendees = attendees.iter().map(|name| (*name).to_owned()).collect();
        meta.title = Some(format!("Weekly sync {}", week + 1));
        workspace::meta_save(&meta).unwrap();
        transcript_saved(&id, &distractor_lines(week));
    }
}

fn embedded_all(runtime: &tokio::runtime::Runtime, target: &EmbeddingsTarget) {
    assert_ne!(target.model, "");

    let space = space_of(&target.model);

    for _batch in 0..64_u32 {
        let pending = vectors_pending(&space).unwrap();

        if pending.is_empty() {
            return;
        }

        let embeddings = runtime.block_on(passages_embed(target, &pending)).unwrap();
        let stored = vectors_store(&space, &pending, &embeddings).unwrap();

        assert_eq!(usize_of!(stored), pending.len());
    }

    panic!("the labelled set never finished embedding");
}

pub(crate) fn local(stamp: &str) -> DateTime<Local> {
    let naive = NaiveDateTime::parse_from_str(stamp, "%Y-%m-%d %H:%M").unwrap();
    let moment = Local.from_local_datetime(&naive).earliest().unwrap();

    assert_eq!(moment.naive_local(), naive);

    moment
}

fn meeting_save(meeting: &Meeting) -> String {
    let id = workspace::job_id_from_text(meeting.key);
    let mut meta = meta_with(&id, local(meeting.held).timestamp());

    meta.attendees = meeting.attendees.iter().map(|name| (*name).to_owned()).collect();
    meta.project = meeting.project.map(str::to_owned);
    meta.title = Some(meeting.title.to_owned());
    workspace::meta_save(&meta).unwrap();

    if !meeting.notes.is_empty() {
        workspace::notes_save(&id, meeting.notes.as_bytes()).unwrap();
    }

    if !meeting.transcript.is_empty() {
        transcript_saved(&id, meeting.transcript);
    }

    assert!(workspace::job_id_is_valid(&id));

    id
}

fn reciprocal_rank(ranked: &[String], expected: &str) -> f64 {
    assert_ne!(expected, "");

    let rank = ranked
        .iter()
        .take(usize_of!(RANK_DEPTH))
        .position(|job| job == expected)
        .map_or(0.0_f64, |index| 1.0_f64 / f64::from(u32::try_from(index + 1).unwrap()));

    assert!(rank >= 0.0_f64);
    assert!(rank <= 1.0_f64);

    rank
}

#[test]
fn each_labelled_question_finds_its_meeting_near_the_top() {
    let _root = root_scoped();
    let ids = corpus_save();
    let now = local("2026-11-11 15:00");
    let mut misses: Vec<String> = Vec::new();
    let mut reciprocal_sum = 0.0_f64;

    for case in &CASES {
        let expected = &ids[case.expected];
        let plan = RankPlan::of_question(case.question, now);
        let ranked = ranked_jobs(&plan, &Scope::All);
        let position = ranked.iter().position(|job| job == expected);

        match position {
            Some(index) if index < usize_of!(RANK_DEPTH) => {
                reciprocal_sum += 1.0_f64 / f64::from(u32::try_from(index + 1).unwrap());
            }
            Some(_) | None => misses.push(format!("{:?} ranked {position:?}", case.question)),
        }
    }

    let reciprocal_mean = reciprocal_sum / f64::from(u32::try_from(CASES.len()).unwrap());

    assert!(misses.is_empty(), "{misses:#?}");
    assert!(reciprocal_mean >= RECIPROCAL_RANK_MEAN_MIN, "{reciprocal_mean}");
}

#[test]
fn each_labelled_answer_reaches_the_excerpts_sent_to_the_model() {
    let _root = root_scoped();
    let ids = corpus_save_large();
    let now = local("2026-11-11 15:00");
    let mut misses: Vec<String> = Vec::new();

    assert!(ids.contains_key(CASE_BOUNDARY.expected));

    for case in CASES.iter().chain([&CASE_BOUNDARY]) {
        let expected = &ids[case.expected];
        let plan = RankPlan::of_question(case.question, now);
        let excerpts = excerpts_rank(&plan, &Scope::All).unwrap();
        let answer = case.answer.to_lowercase();

        let reached = excerpts.iter().any(|excerpt| {
            excerpt.job_id == *expected && excerpt.body.to_lowercase().contains(&answer)
        });

        if !reached {
            misses.push(format!("{:?} lost {:?}", case.question, case.answer));
        }
    }

    assert!(misses.is_empty(), "{misses:#?}");
}

#[test]
#[ignore = "manual: embeds the labelled set with REMI_MANUAL_EMBEDDINGS_HOST, _MODEL, and _KEY"]
fn manual_meaning_finds_paraphrased_questions_without_losing_worded_ones() {
    let host = std::env::var("REMI_MANUAL_EMBEDDINGS_HOST").expect("an embeddings host");
    let model = std::env::var("REMI_MANUAL_EMBEDDINGS_MODEL").expect("an embeddings model");
    let api_key = std::env::var("REMI_MANUAL_EMBEDDINGS_KEY").unwrap_or_default();
    let target = EmbeddingsTarget { api_key, host, model };
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let _root = root_scoped();
    let ids = corpus_save();
    let now = local("2026-11-11 15:00");
    let mut misses: Vec<String> = Vec::new();
    let mut reciprocal_words = 0.0_f64;
    let mut reciprocal_meaning = 0.0_f64;

    embedded_all(&runtime, &target);

    for case in CASES.iter().chain(&CASES_MEANING) {
        let expected = &ids[case.expected];
        let words = RankPlan::of_question(case.question, now);
        let text = prompts_of(&target.model).query_text(case.question);
        let mut created = runtime.block_on(embeddings_create(&target, &[text.as_str()])).unwrap();
        let values = created.pop().unwrap();
        let vector = QueryVector { space: space_of(&target.model), values };
        let ranked = meaning_rank(&vector, &Scope::All).unwrap();
        let meaning = RankPlan { meaning: Some(ranked), ..words.clone() };
        let ranked_words = ranked_jobs(&words, &Scope::All);
        let ranked_meaning = ranked_jobs(&meaning, &Scope::All);
        let position_words = ranked_words.iter().position(|job| job == expected);
        let position_meaning = ranked_meaning.iter().position(|job| job == expected);
        let rank_meaning = reciprocal_rank(&ranked_meaning, expected);

        println!("MANUAL {position_words:?} {position_meaning:?} {:?}", case.question);

        reciprocal_words += reciprocal_rank(&ranked_words, expected);
        reciprocal_meaning += rank_meaning;

        if rank_meaning == 0.0_f64 {
            misses.push(format!("{:?} ranked {position_meaning:?}", case.question));
        }
    }

    let count = f64::from(u32::try_from(CASES.len() + CASES_MEANING.len()).unwrap());

    println!(
        "MANUAL mean reciprocal rank: words {:.3}, words and meaning {:.3}",
        reciprocal_words / count,
        reciprocal_meaning / count,
    );

    assert!(misses.is_empty(), "{misses:#?}");
    assert!(reciprocal_meaning > reciprocal_words);
}

#[test]
fn a_question_scoped_to_a_project_never_reaches_outside_it() {
    let _root = root_scoped();
    let ids = corpus_save();
    let now = local("2026-11-11 15:00");
    let scope = Scope::Project { project: "tailspin toys".to_owned() };
    let inside = [&ids["radios"], &ids["launch"]];

    for case in &CASES {
        let plan = RankPlan::of_question(case.question, now);
        let ranked = ranked_jobs(&plan, &scope);

        assert!(ranked.iter().all(|job| inside.contains(&job)), "{:?}", case.question);
    }

    let plan = RankPlan::of_question("What is the plan for the launch?", now);
    let ranked = ranked_jobs(&plan, &scope);

    assert_ne!(ranked.len(), 0);
    assert_eq!(ranked.first(), Some(inside[1]));
}
