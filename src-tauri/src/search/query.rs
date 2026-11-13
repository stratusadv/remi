use super::chunk::chars_count;
use super::when;
use std::collections::BTreeSet;

const PHRASE_CHARS_MAX: u32 = 120;
const TERM_CHARS_MIN: u32 = 2;
pub(crate) const TERMS_MAX: u32 = 24;

const STOP_WORDS: &[&str] = &[
    "about",
    "again",
    "all",
    "also",
    "am",
    "an",
    "and",
    "any",
    "anyone",
    "anything",
    "are",
    "as",
    "ask",
    "asked",
    "at",
    "be",
    "been",
    "but",
    "by",
    "can",
    "could",
    "cover",
    "covered",
    "did",
    "discuss",
    "discussed",
    "discussion",
    "do",
    "does",
    "doing",
    "everyone",
    "everything",
    "for",
    "from",
    "get",
    "got",
    "had",
    "happen",
    "happened",
    "has",
    "have",
    "he",
    "her",
    "him",
    "his",
    "how",
    "if",
    "in",
    "into",
    "is",
    "it",
    "its",
    "just",
    "know",
    "me",
    "meet",
    "meeting",
    "meetings",
    "mention",
    "mentioned",
    "met",
    "my",
    "no",
    "not",
    "of",
    "on",
    "one",
    "or",
    "our",
    "out",
    "overview",
    "recap",
    "remember",
    "said",
    "say",
    "says",
    "she",
    "should",
    "so",
    "some",
    "someone",
    "something",
    "summarise",
    "summarize",
    "summary",
    "talk",
    "talked",
    "talking",
    "tell",
    "than",
    "that",
    "the",
    "their",
    "them",
    "then",
    "there",
    "these",
    "they",
    "thing",
    "things",
    "think",
    "this",
    "those",
    "to",
    "up",
    "us",
    "was",
    "we",
    "were",
    "what",
    "when",
    "where",
    "which",
    "who",
    "why",
    "will",
    "with",
    "would",
    "you",
    "your",
];

pub(crate) fn match_any(items: &[String]) -> Option<String> {
    let phrases: Vec<String> =
        items.iter().take(usize_of!(TERMS_MAX)).filter_map(|item| phrase_of(item)).collect();

    if phrases.is_empty() {
        return None;
    }

    let expression = phrases.join(" OR ");

    assert!(phrases.len() <= usize_of!(TERMS_MAX));
    assert!(expression.starts_with('"'));

    Some(expression)
}

pub(crate) fn match_every_prefix(input: &str) -> Option<String> {
    let mut phrases: Vec<String> =
        input.split_whitespace().filter_map(phrase_of).take(usize_of!(TERMS_MAX)).collect();

    let last = phrases.last_mut()?;

    last.push('*');

    let expression = phrases.join(" AND ");

    assert!(expression.ends_with("\"*"));
    assert!(phrases.len() <= usize_of!(TERMS_MAX));

    Some(expression)
}

pub(crate) fn terms_of(text: &str) -> Vec<String> {
    let lowered = text.to_lowercase();
    let mut seen: BTreeSet<&str> = BTreeSet::new();
    let mut terms: Vec<String> = Vec::new();

    for word in lowered.split(|character: char| !character.is_alphanumeric()) {
        if terms.len() >= usize_of!(TERMS_MAX) {
            break;
        }

        if chars_count(word) < TERM_CHARS_MIN {
            continue;
        }

        if STOP_WORDS.contains(&word) {
            continue;
        }

        if when::word_is_temporal(word) {
            continue;
        }

        if seen.insert(word) {
            terms.push(word.to_owned());
        }
    }

    assert_eq!(terms.len(), seen.len());
    assert!(terms.len() <= usize_of!(TERMS_MAX));

    terms
}

fn phrase_of(text: &str) -> Option<String> {
    let bounded: String = text.trim().chars().take(usize_of!(PHRASE_CHARS_MAX)).collect();

    if !bounded.chars().any(char::is_alphanumeric) {
        return None;
    }

    let phrase = format!("\"{}\"", bounded.replace('"', "\"\""));

    assert!(phrase.len() >= 3);
    assert!(phrase.starts_with('"'));

    Some(phrase)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_word_must_match_and_the_last_may_be_a_prefix() {
        assert_eq!(
            match_every_prefix("budget q3 rev").unwrap(),
            "\"budget\" AND \"q3\" AND \"rev\"*",
        );
        assert_eq!(match_every_prefix("  rollout ").unwrap(), "\"rollout\"*");
        assert_eq!(match_every_prefix("say \"hi\"").unwrap(), "\"say\" AND \"\"\"hi\"\"\"*");
        assert_eq!(match_every_prefix(" - * ( ) "), None);
        assert_eq!(match_every_prefix(""), None);
    }

    #[test]
    fn any_item_may_match_and_items_without_letters_are_dropped() {
        let items = vec!["Van Dijk".to_owned(), "??".to_owned(), "Ana".to_owned()];

        assert_eq!(match_any(&items).unwrap(), "\"Van Dijk\" OR \"Ana\"");
        assert_eq!(match_any(&[]), None);
        assert_eq!(match_any(&["...".to_owned()]), None);
    }

    #[test]
    fn terms_skip_filler_time_words_and_repeats() {
        let terms =
            terms_of("What did we decide about the Budget, the budget and Q3 last Tuesday?");

        assert_eq!(terms, ["decide", "budget", "q3"]);
        assert_eq!(terms_of("what did we say a week ago").len(), 0);
    }

    #[test]
    fn terms_are_bounded_however_long_the_question() {
        let question: Vec<String> = (0..200_u32).map(|index| format!("word{index}")).collect();

        assert_eq!(terms_of(&question.join(" ")).len(), usize_of!(TERMS_MAX));
    }
}
