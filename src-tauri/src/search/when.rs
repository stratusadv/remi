use chrono::{DateTime, Datelike, Days, Local, Months, NaiveDate, TimeZone, Weekday};
use std::ops::{Range, RangeInclusive};

const DAY_SECONDS: i64 = 86_400;
const HOUR_SECONDS: i64 = 3600;
const MONTH_SECONDS: i64 = 30 * DAY_SECONDS;
const QUANTITY_MAX: u32 = 1000;
const RECENT_SECONDS: i64 = 14 * DAY_SECONDS;
const TOKENS_MAX: u32 = 512;
const TOLERANCE_PER_TEN: i64 = 3;
const WEEK_SECONDS: i64 = 7 * DAY_SECONDS;
const YEAR_SECONDS: i64 = 365 * DAY_SECONDS;

const LATEST_WORDS: [&str; 5] = ["last", "latest", "newest", "previous", "recent"];

const MAY_CONTEXT: [&str; 12] = [
    "after",
    "before",
    "during",
    "early",
    "from",
    "in",
    "last",
    "late",
    "mid",
    "of",
    "since",
    "this",
];

const MEETING_WORDS: [&str; 9] =
    ["call", "chat", "conversation", "meeting", "one", "recording", "session", "standup", "sync"];

const MONTH_NAMES: [&str; 12] = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
];

const NUMBER_WORDS: [(&str, u32); 15] = [
    ("eight", 8),
    ("eleven", 11),
    ("fifteen", 15),
    ("five", 5),
    ("four", 4),
    ("nine", 9),
    ("one", 1),
    ("seven", 7),
    ("six", 6),
    ("ten", 10),
    ("thirty", 30),
    ("three", 3),
    ("twelve", 12),
    ("twenty", 20),
    ("two", 2),
];

const TEMPORAL_WORDS: [&str; 30] = [
    "afternoon",
    "ago",
    "couple",
    "day",
    "days",
    "earlier",
    "evening",
    "few",
    "half",
    "hour",
    "hours",
    "last",
    "lately",
    "later",
    "month",
    "months",
    "morning",
    "past",
    "previous",
    "recent",
    "recently",
    "several",
    "since",
    "today",
    "tonight",
    "week",
    "weeks",
    "year",
    "years",
    "yesterday",
];

const WEEKDAY_NAMES: [(&str, Weekday); 7] = [
    ("friday", Weekday::Fri),
    ("monday", Weekday::Mon),
    ("saturday", Weekday::Sat),
    ("sunday", Weekday::Sun),
    ("thursday", Weekday::Thu),
    ("tuesday", Weekday::Tue),
    ("wednesday", Weekday::Wed),
];

const _: () = assert!(DAY_SECONDS < WEEK_SECONDS);
const _: () = assert!(WEEK_SECONDS < MONTH_SECONDS);
const _: () = assert!(MONTH_SECONDS < YEAR_SECONDS);
const _: () = assert!(TOLERANCE_PER_TEN < 10);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct TimeWindow {
    pub(crate) end_unix: i64,
    pub(crate) start_unix: i64,
}

#[derive(Clone, Copy, Debug)]
struct Quantity {
    halves: u32,
    tokens: u32,
}

impl TimeWindow {
    pub(crate) const fn center_unix(self) -> i64 {
        assert!(self.start_unix <= self.end_unix);

        let center = self.start_unix + (self.end_unix - self.start_unix).div_euclid(2);

        assert!(center >= self.start_unix);
        assert!(center <= self.end_unix);

        center
    }
}

pub(crate) fn latest_requested(question: &str) -> bool {
    let lowered = question.to_lowercase();
    let tokens = tokens_of(&lowered);

    let requested = tokens
        .iter()
        .zip(tokens.iter().skip(1))
        .filter(|(first, _second)| LATEST_WORDS.contains(*first))
        .any(|(_first, second)| MEETING_WORDS.contains(second));

    if requested {
        assert!(tokens.len() >= 2);
    }

    requested
}

pub(crate) fn window_parse(question: &str, now: DateTime<Local>) -> Option<TimeWindow> {
    let lowered = question.to_lowercase();
    let tokens = tokens_of(&lowered);

    for position in 0..tokens.len() {
        let rest = tokens.get(position..).unwrap_or_default();
        let before = position.checked_sub(1).and_then(|index| tokens.get(index)).copied();

        let Some(window) = window_at(rest, before, now) else {
            continue;
        };

        assert!(window.start_unix <= window.end_unix);
        assert!(window.end_unix <= now.timestamp());

        return Some(window);
    }

    None
}

pub(crate) fn word_is_temporal(word: &str) -> bool {
    let temporal = TEMPORAL_WORDS.contains(&word)
        || MONTH_NAMES.contains(&word)
        || WEEKDAY_NAMES.iter().any(|(name, _weekday)| *name == word)
        || NUMBER_WORDS.iter().any(|(name, _number)| *name == word);

    if temporal {
        assert_ne!(word, "");
    }

    temporal
}

fn ago_window(rest: &[&str], now: DateTime<Local>) -> Option<TimeWindow> {
    let quantity = quantity_of(rest)?;
    let after_quantity = rest.get(usize_of!(quantity.tokens)..)?;
    let unit_seconds = unit_seconds_of(after_quantity.first()?)?;
    let after_unit = after_quantity.get(1..).unwrap_or_default();
    let (halves_extra, after_half) = half_of(after_unit);

    if after_half.first() != Some(&"ago") {
        return None;
    }

    let halves = i64::from(quantity.halves + halves_extra);
    let offset = (halves * unit_seconds).div_euclid(2);
    let tolerance = (offset * TOLERANCE_PER_TEN).div_euclid(10).max(DAY_SECONDS);
    let center = now.timestamp() - offset;
    let window = window_bounded(center - tolerance..=center + tolerance, now)?;

    assert!(offset > 0);
    assert!(window.start_unix <= center);
    assert!(center <= window.end_unix);

    Some(window)
}

fn day_start(date: NaiveDate) -> Option<i64> {
    let midnight = date.and_hms_opt(0, 0, 0)?;
    let start = Local.from_local_datetime(&midnight).earliest()?.timestamp();

    assert!(start > i64::MIN);

    Some(start)
}

fn day_window(date: NaiveDate, now: DateTime<Local>) -> Option<TimeWindow> {
    dates_window(date..date.succ_opt()?, now)
}

fn dates_window(dates: Range<NaiveDate>, now: DateTime<Local>) -> Option<TimeWindow> {
    assert!(dates.start < dates.end);

    let start = day_start(dates.start)?;
    let end = day_start(dates.end)? - 1;

    window_bounded(start..=end, now)
}

fn day_of(token: &str) -> Option<u32> {
    let digits: String = token.chars().take_while(char::is_ascii_digit).collect();
    let suffix = token.get(digits.len()..)?;

    if !matches!(suffix, "" | "st" | "nd" | "rd" | "th") {
        return None;
    }

    let day: u32 = digits.parse().ok()?;

    (1..=31).contains(&day).then_some(day)
}

fn half_of<'token>(rest: &'token [&'token str]) -> (u32, &'token [&'token str]) {
    match rest {
        ["and", "a", "half", tail @ ..] => (1, tail),
        _ => (0, rest),
    }
}

fn month_of(token: &str) -> Option<u32> {
    let position = MONTH_NAMES.iter().position(|name| *name == token)?;
    let month = u32::try_from(position).ok()? + 1;

    assert!((1..=12).contains(&month));

    Some(month)
}

fn month_window(rest: &[&str], before: Option<&str>, now: DateTime<Local>) -> Option<TimeWindow> {
    let first = *rest.first()?;
    let second = rest.get(1).copied();

    let (month, day) = match (month_of(first), day_of(first)) {
        (Some(month), _) => (month, second.and_then(day_of)),
        (None, Some(day)) => (second.and_then(month_of)?, Some(day)),
        (None, None) => return None,
    };

    let may_named = first == "may" || second == Some("may");
    let may_placed = day.is_some() || before.is_some_and(|word| MAY_CONTEXT.contains(&word));
    let may_ambiguous = may_named && !may_placed;

    if may_ambiguous {
        return None;
    }

    let today = now.date_naive();
    let ahead = month > today.month() || (month == today.month() && day.unwrap_or(1) > today.day());
    let year = if ahead { today.year() - 1_i32 } else { today.year() };

    if let Some(day_number) = day {
        return day_window(NaiveDate::from_ymd_opt(year, month, day_number)?, now);
    }

    let day_first = NaiveDate::from_ymd_opt(year, month, 1)?;

    dates_window(day_first..day_first.checked_add_months(Months::new(1))?, now)
}

fn period_window(rest: &[&str], before: Option<&str>, now: DateTime<Local>) -> Option<TimeWindow> {
    let today = now.date_naive();
    let weekday_offset = Days::new(u64::from(today.weekday().num_days_from_monday()));
    let week_first = today.checked_sub_days(weekday_offset)?;
    let month_first = today.with_day(1)?;
    let year_first = today.with_ordinal(1)?;
    let rolling = before == Some("the");

    match rest {
        ["this", "morning" | "afternoon" | "evening", ..] => day_window(today, now),
        ["this", "week", ..] => window_bounded(day_start(week_first)?..=now.timestamp(), now),
        ["this", "month", ..] => window_bounded(day_start(month_first)?..=now.timestamp(), now),
        ["this", "year", ..] => window_bounded(day_start(year_first)?..=now.timestamp(), now),
        ["last" | "previous", unit @ ("week" | "month" | "year"), ..] if rolling => {
            span_ending(unit_seconds_of(unit)?, now)
        }
        ["last" | "previous", "week", ..] => {
            dates_window(week_first.checked_sub_days(Days::new(7))?..week_first, now)
        }
        ["last" | "previous", "month", ..] => {
            dates_window(month_first.checked_sub_months(Months::new(1))?..month_first, now)
        }
        ["last" | "previous", "year", ..] => {
            dates_window(year_first.with_year(year_first.year() - 1)?..year_first, now)
        }
        ["past", unit @ ("week" | "month" | "year"), ..] => {
            span_ending(unit_seconds_of(unit)?, now)
        }
        ["last" | "past" | "previous", tail @ ..] => span_counted(tail, now),
        _ => None,
    }
}

fn quantity_of(rest: &[&str]) -> Option<Quantity> {
    let (units, tokens): (u32, u32) = match rest {
        ["a" | "an", "couple", "of", ..] => (2, 3),
        ["a" | "an", "couple", ..] | ["couple", "of", ..] => (2, 2),
        ["a" | "an", "few", ..] => (3, 2),
        ["couple", ..] => (2, 1),
        ["few" | "several", ..] => (3, 1),
        ["a" | "an", ..] => (1, 1),
        [word, ..] => (number_of(word)?, 1),
        [] => return None,
    };

    let (halves_extra, _tail) = half_of(rest.get(usize_of!(tokens)..).unwrap_or_default());
    let consumed = if halves_extra > 0 { tokens + 3 } else { tokens };
    let halves = units * 2 + halves_extra;

    assert!(units <= QUANTITY_MAX);
    assert!(halves >= 2);

    Some(Quantity { halves, tokens: consumed })
}

fn number_of(word: &str) -> Option<u32> {
    let named =
        NUMBER_WORDS.iter().find(|(name, _number)| *name == word).map(|(_name, number)| *number);

    let number = match named {
        Some(number) => number,
        None if word.chars().all(|character| character.is_ascii_digit()) => word.parse().ok()?,
        None => return None,
    };

    (1..=QUANTITY_MAX).contains(&number).then_some(number)
}

fn span_counted(rest: &[&str], now: DateTime<Local>) -> Option<TimeWindow> {
    let quantity = quantity_of(rest)?;
    let unit_seconds = unit_seconds_of(rest.get(usize_of!(quantity.tokens))?)?;
    let span = (i64::from(quantity.halves) * unit_seconds).div_euclid(2);

    assert!(span > 0);

    span_ending(span, now)
}

fn span_ending(seconds: i64, now: DateTime<Local>) -> Option<TimeWindow> {
    assert!(seconds > 0);

    window_bounded(now.timestamp() - seconds..=now.timestamp(), now)
}

fn tokens_of(lowered: &str) -> Vec<&str> {
    let tokens: Vec<&str> = lowered
        .split(|character: char| !character.is_alphanumeric())
        .filter(|token| !token.is_empty())
        .take(usize_of!(TOKENS_MAX))
        .collect();

    assert!(tokens.len() <= usize_of!(TOKENS_MAX));
    assert!(tokens.iter().all(|token| !token.is_empty()));

    tokens
}

fn unit_seconds_of(token: &str) -> Option<i64> {
    match token {
        "hour" | "hours" => Some(HOUR_SECONDS),
        "day" | "days" => Some(DAY_SECONDS),
        "week" | "weeks" => Some(WEEK_SECONDS),
        "month" | "months" => Some(MONTH_SECONDS),
        "year" | "years" => Some(YEAR_SECONDS),
        _ => None,
    }
}

fn weekday_window(
    weekday: Weekday,
    before: Option<&str>,
    now: DateTime<Local>,
) -> Option<TimeWindow> {
    let today = now.date_naive();
    let today_index = today.weekday().num_days_from_monday();
    let target_index = weekday.num_days_from_monday();
    let days_back = (today_index + 7 - target_index).rem_euclid(7);
    let skips_today = before == Some("last") && days_back == 0;
    let days = if skips_today { 7 } else { days_back };

    assert!(days <= 7);

    day_window(today.checked_sub_days(Days::new(u64::from(days)))?, now)
}

fn window_at(rest: &[&str], before: Option<&str>, now: DateTime<Local>) -> Option<TimeWindow> {
    let first = *rest.first()?;
    let today = now.date_naive();

    match first {
        "today" | "tonight" => return day_window(today, now),
        "yesterday" => return day_window(today.pred_opt()?, now),
        "recently" | "lately" | "recent" => return span_ending(RECENT_SECONDS, now),
        _ => {}
    }

    if let Some((_name, weekday)) = WEEKDAY_NAMES.iter().find(|(name, _weekday)| *name == first) {
        return weekday_window(*weekday, before, now);
    }

    period_window(rest, before, now)
        .or_else(|| ago_window(rest, now))
        .or_else(|| month_window(rest, before, now))
}

fn window_bounded(span: RangeInclusive<i64>, now: DateTime<Local>) -> Option<TimeWindow> {
    assert!(span.start() <= span.end());

    let (start_unix, end_unix_wanted) = span.into_inner();
    let end_unix = end_unix_wanted.min(now.timestamp());

    if start_unix > end_unix {
        return None;
    }

    assert!(end_unix <= now.timestamp());
    assert!(end_unix <= end_unix_wanted);

    Some(TimeWindow { end_unix, start_unix })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDateTime;

    fn at(stamp: &str) -> DateTime<Local> {
        let naive = NaiveDateTime::parse_from_str(stamp, "%Y-%m-%d %H:%M").unwrap();

        Local.from_local_datetime(&naive).earliest().unwrap()
    }

    fn covers(window: TimeWindow, date: &str) -> bool {
        assert!(window.start_unix <= window.end_unix);

        let noon = at(&format!("{date} 12:00")).timestamp();

        (window.start_unix..=window.end_unix).contains(&noon)
    }

    fn parsed(question: &str, now: DateTime<Local>) -> TimeWindow {
        window_parse(question, now).unwrap_or_else(|| panic!("no window in {question:?}"))
    }

    #[test]
    fn single_days_cover_their_own_noon_and_not_their_neighbours() {
        let now = at("2026-11-11 15:00");
        let today = parsed("what did we say today?", now);
        let yesterday = parsed("Yesterday's sync", now);

        assert!(covers(today, "2026-11-11"));
        assert!(!covers(today, "2026-11-10"));
        assert!(covers(yesterday, "2026-11-10"));
        assert!(!covers(yesterday, "2026-11-11"));
        assert!(!covers(yesterday, "2026-11-09"));
        assert_eq!(today.end_unix, now.timestamp());
    }

    #[test]
    fn a_weekday_means_its_latest_past_occurrence_and_last_skips_today() {
        let wednesday = at("2026-11-11 15:00");
        let monday = parsed("the meeting on Monday", wednesday);
        let today = parsed("on wednesday we met", wednesday);
        let previous = parsed("last Wednesday", wednesday);
        let thursday = parsed("thursday", wednesday);

        assert!(covers(monday, "2026-11-09"));
        assert!(covers(today, "2026-11-11"));
        assert!(covers(previous, "2026-11-04"));
        assert!(!covers(previous, "2026-11-11"));
        assert!(covers(thursday, "2026-11-05"));
    }

    #[test]
    fn an_offset_ago_is_centred_on_its_distance_with_room_either_side() {
        let now = at("2026-11-11 15:00");
        let week_half = parsed("We had that meeting a week and a half ago", now);
        let two_half = parsed("two and a half weeks ago", now);
        let couple = parsed("a couple of weeks ago", now);

        assert!(covers(week_half, "2026-10-31"));
        assert!(!covers(week_half, "2026-11-11"));
        assert!(!covers(week_half, "2026-10-20"));
        assert!(covers(two_half, "2026-10-24"));
        assert!(covers(couple, "2026-10-28"));

        let digits = parsed("about 10 days ago", now);
        let month = parsed("A month ago, something about equipment", now);

        assert!(covers(digits, "2026-11-01"));
        assert!(covers(month, "2026-10-12"));
        assert!(!covers(month, "2026-11-08"));
    }

    #[test]
    fn calendar_periods_follow_the_calendar_and_past_spans_end_now() {
        let now = at("2026-11-11 15:00");
        let calendar_week = parsed("last week", now);
        let this_week = parsed("anything this week?", now);

        assert!(covers(calendar_week, "2026-11-02"));
        assert!(covers(calendar_week, "2026-11-08"));
        assert!(!covers(calendar_week, "2026-11-09"));
        assert!(covers(this_week, "2026-11-09"));
        assert!(!covers(this_week, "2026-11-08"));

        let calendar_month = parsed("what came up last month", now);
        let rolling_month = parsed("in the last month", now);

        assert!(covers(calendar_month, "2026-10-01"));
        assert!(covers(calendar_month, "2026-10-31"));
        assert!(!covers(calendar_month, "2026-11-01"));
        assert!(covers(rolling_month, "2026-10-15"));
        assert!(covers(rolling_month, "2026-11-10"));
        assert!(!covers(rolling_month, "2026-10-01"));
        assert_eq!(rolling_month.end_unix, now.timestamp());

        let rolling_days = parsed("in the past 3 days", now);
        let rolling_weeks = parsed("over the last two weeks", now);

        assert!(covers(rolling_days, "2026-11-09"));
        assert!(!covers(rolling_days, "2026-11-07"));
        assert!(covers(rolling_weeks, "2026-10-29"));
        assert_eq!(rolling_weeks.end_unix, now.timestamp());
    }

    #[test]
    fn month_names_pick_the_latest_past_month_and_may_needs_context() {
        let now = at("2026-11-11 15:00");
        let march = parsed("the March planning call", now);
        let december = parsed("in December", now);
        let dated = parsed("on March 3rd", now);

        assert!(covers(march, "2026-03-15"));
        assert!(!covers(march, "2026-04-01"));
        assert!(covers(december, "2025-12-15"));
        assert!(covers(dated, "2026-03-03"));
        assert!(!covers(dated, "2026-03-04"));

        let day_first = parsed("3 march", now);
        let may = parsed("back in May", now);

        assert!(covers(day_first, "2026-03-03"));
        assert!(covers(may, "2026-05-20"));
        assert_eq!(window_parse("what may we have missed", now), None);
    }

    #[test]
    fn questions_without_a_time_yield_nothing() {
        let now = at("2026-11-11 15:00");

        for question in [
            "What did we decide about the budget?",
            "Who owns the retry work",
            "a plan for next quarter",
            "",
            "last",
            "3 ago",
            "the 45th",
        ] {
            assert_eq!(window_parse(question, now), None, "{question}");
        }
    }

    #[test]
    fn every_parsed_window_is_ordered_and_never_reaches_past_now() {
        let now = at("2026-01-02 09:00");

        for question in [
            "today",
            "yesterday",
            "monday",
            "sunday",
            "last week",
            "this week",
            "last month",
            "this month",
            "last year",
            "this year",
            "recently",
            "an hour ago",
            "a few days ago",
            "several weeks ago",
            "twelve months ago",
            "1000 years ago",
            "december 31",
            "january",
            "past year",
        ] {
            let window = parsed(question, now);
            let span = window.start_unix..=window.end_unix;

            assert!(window.start_unix <= window.end_unix, "{question}");
            assert!(window.end_unix <= now.timestamp(), "{question}");
            assert!(span.contains(&window.center_unix()), "{question}");
        }
    }

    #[test]
    fn a_request_for_the_latest_meeting_is_recognised_only_as_a_pair() {
        for question in [
            "Summarize my last meeting",
            "what happened in the most recent call?",
            "The previous sync, what did Ana own?",
            "and the latest one",
        ] {
            assert!(latest_requested(question), "{question}");
        }

        for question in ["last week", "the meeting on Monday", "last", "meeting", "", "call last"] {
            assert!(!latest_requested(question), "{question}");
        }
    }

    #[test]
    fn temporal_words_are_recognised_and_topic_words_are_not() {
        for word in ["tuesday", "march", "ago", "week", "yesterday", "two"] {
            assert!(word_is_temporal(word), "{word}");
        }

        for word in ["budget", "policy", "equipment", "nathan"] {
            assert!(!word_is_temporal(word), "{word}");
        }
    }
}
