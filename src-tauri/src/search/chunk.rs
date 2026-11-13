use crate::people::storage::Person;
use crate::transcription::types::{Transcript, TranscriptSegment};
use crate::workspace::JobMeta;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::mem;

pub(crate) const CHUNK_CHARS_MAX: u32 = 1600;
const CHUNK_CHARS_UNTIMED: u32 = 1100;
const CHUNK_SECONDS_SPAN: f64 = 60.0;
pub(crate) const CHUNKS_MAX: u32 = 16_384;
const HEADING_CHARS_MAX: u32 = 160;
const HEADING_LEVEL_MAX: u32 = 6;
const NAMES_MAX: u32 = 256;

const _: () = assert!(CHUNK_CHARS_UNTIMED < CHUNK_CHARS_MAX);
const _: () = assert!(HEADING_CHARS_MAX < CHUNK_CHARS_MAX);

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ChunkSource {
    Notes,
    Transcript,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ChunkDraft {
    pub(crate) body: String,
    pub(crate) end_seconds: Option<f64>,
    pub(crate) heading: Option<String>,
    pub(crate) segment_index_first: Option<u32>,
    pub(crate) segment_index_last: Option<u32>,
    pub(crate) source: ChunkSource,
    pub(crate) start_seconds: Option<f64>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Timing {
    Timed,
    Untimed,
}

#[derive(Debug)]
struct TranscriptChunker {
    chunks: Vec<ChunkDraft>,
    timing: Timing,
    window: Option<TranscriptWindow>,
}

#[derive(Debug)]
struct TranscriptWindow {
    body: String,
    body_chars: u32,
    end_seconds: f64,
    segment_index_first: u32,
    segment_index_last: u32,
    start_seconds: f64,
}

impl ChunkSource {
    pub(crate) const fn name(self) -> &'static str {
        match self {
            Self::Notes => "notes",
            Self::Transcript => "transcript",
        }
    }

    pub(crate) fn parse(text: &str) -> Option<Self> {
        let parsed = match text {
            "notes" => Some(Self::Notes),
            "transcript" => Some(Self::Transcript),
            _ => None,
        };

        if let Some(source) = parsed {
            assert_eq!(source.name(), text);
        }

        parsed
    }
}

impl TranscriptChunker {
    fn finish(mut self) -> Vec<ChunkDraft> {
        self.window_close();

        assert!(self.window.is_none());
        assert!(self.chunks.iter().all(|chunk| chunk.source == ChunkSource::Transcript));

        self.chunks
    }

    fn full(&self) -> bool {
        self.chunks.len() >= usize_of!(CHUNKS_MAX)
    }

    fn index_last(&self) -> Option<u32> {
        let window_last = self.window.as_ref().map(|window| window.segment_index_last);

        window_last.or_else(|| self.chunks.last()?.segment_index_last)
    }

    const fn of(timing: Timing) -> Self {
        Self { chunks: Vec::new(), timing, window: None }
    }

    fn segment_add(&mut self, index: u32, segment: &TranscriptSegment) {
        assert!(self.index_last().is_none_or(|last| index > last));
        assert!(!self.full());

        let text = segment.text.trim();
        let text_chars = chars_count(text);

        assert_ne!(text, "");

        if text_chars > CHUNK_CHARS_MAX {
            self.window_close();
            self.segment_split(index, segment);

            return;
        }

        let overflows = self
            .window
            .as_ref()
            .is_some_and(|window| window.body_chars + 1 + text_chars > CHUNK_CHARS_MAX);

        if overflows {
            self.window_close();
        }

        if let Some(window) = self.window.as_mut() {
            window.push(index, text, segment);
        } else {
            let (start_seconds, end_seconds) = segment_bounds(segment);

            self.window = Some(TranscriptWindow {
                body: text.to_owned(),
                body_chars: text_chars,
                end_seconds,
                segment_index_first: index,
                segment_index_last: index,
                start_seconds,
            });
        }

        let timing = self.timing;

        if self.window.as_ref().is_some_and(|window| window.complete(timing)) {
            self.window_close();
        }
    }

    fn segment_split(&mut self, index: u32, segment: &TranscriptSegment) {
        assert!(self.window.is_none());
        assert!(self.index_last().is_none_or(|last| index > last));

        let bounds = (self.timing == Timing::Timed).then(|| segment_bounds(segment));

        for piece in pieces_of_words(segment.text.trim(), CHUNK_CHARS_MAX) {
            if self.full() {
                break;
            }

            self.chunks.push(ChunkDraft {
                body: piece,
                end_seconds: bounds.map(|(_start, end)| end),
                heading: None,
                segment_index_first: Some(index),
                segment_index_last: Some(index),
                source: ChunkSource::Transcript,
                start_seconds: bounds.map(|(start, _end)| start),
            });
        }
    }

    fn window_close(&mut self) {
        let Some(window) = self.window.take() else {
            return;
        };

        if self.full() {
            return;
        }

        let draft = window.into_draft(self.timing);

        assert!(chars_count(&draft.body) <= CHUNK_CHARS_MAX);

        self.chunks.push(draft);
    }
}

impl TranscriptWindow {
    fn complete(&self, timing: Timing) -> bool {
        assert!(self.segment_index_first <= self.segment_index_last);

        match timing {
            Timing::Timed => self.end_seconds - self.start_seconds >= CHUNK_SECONDS_SPAN,
            Timing::Untimed => self.body_chars >= CHUNK_CHARS_UNTIMED,
        }
    }

    fn into_draft(self, timing: Timing) -> ChunkDraft {
        let timed = timing == Timing::Timed;

        assert_ne!(self.body, "");
        assert!(self.segment_index_first <= self.segment_index_last);

        ChunkDraft {
            body: self.body,
            end_seconds: timed.then_some(self.end_seconds),
            heading: None,
            segment_index_first: Some(self.segment_index_first),
            segment_index_last: Some(self.segment_index_last),
            source: ChunkSource::Transcript,
            start_seconds: timed.then_some(self.start_seconds),
        }
    }

    fn push(&mut self, index: u32, text: &str, segment: &TranscriptSegment) {
        assert!(index > self.segment_index_last);
        assert_ne!(text, "");

        self.body.push(' ');
        self.body.push_str(text);
        self.body_chars += 1 + chars_count(text);
        self.segment_index_last = index;

        let (start_seconds, end_seconds) = segment_bounds(segment);

        self.end_seconds = self.end_seconds.max(end_seconds);
        self.start_seconds = self.start_seconds.min(start_seconds);
    }
}

pub(crate) fn chars_count(text: &str) -> u32 {
    u32::try_from(text.chars().count()).unwrap_or(u32::MAX)
}

pub(crate) fn chunks_from_notes(markdown: &str) -> Vec<ChunkDraft> {
    let mut chunks: Vec<ChunkDraft> = Vec::new();
    let mut heading: Option<String> = None;
    let mut section: Vec<&str> = Vec::new();

    for line in markdown.lines() {
        if let Some(title) = heading_of(line) {
            chunks.extend(section_drafts(heading.as_deref(), &section));
            heading = Some(title);
            section.clear();
        }

        section.push(line);
    }

    chunks.extend(section_drafts(heading.as_deref(), &section));
    chunks.truncate(usize_of!(CHUNKS_MAX));

    assert!(chunks.iter().all(|chunk| chunk.source == ChunkSource::Notes));
    assert!(chunks.iter().all(|chunk| chars_count(&chunk.body) <= CHUNK_CHARS_MAX));

    chunks
}

pub(crate) fn chunks_from_transcript(transcript: &Transcript) -> Vec<ChunkDraft> {
    let spoken = transcript.segments.iter().any(|segment| !segment.text.trim().is_empty());

    if !spoken {
        return chunks_from_text(&transcript.text);
    }

    let timed = transcript.segments.iter().any(|segment| segment.end_seconds > 0.0_f64);
    let timing = if timed { Timing::Timed } else { Timing::Untimed };
    let mut chunker = TranscriptChunker::of(timing);

    for (position, segment) in transcript.segments.iter().enumerate() {
        let Ok(index) = u32::try_from(position) else {
            break;
        };

        if chunker.full() {
            break;
        }

        if segment.text.trim().is_empty() {
            continue;
        }

        chunker.segment_add(index, segment);
    }

    let chunks = chunker.finish();

    assert!(chunks.len() <= usize_of!(CHUNKS_MAX));

    chunks
}

pub(crate) fn header_build(meta: &JobMeta, names: &[String]) -> String {
    let title = meta.title.as_deref().or(meta.label.as_deref()).unwrap_or_default();
    let project = meta.project.as_deref().unwrap_or_default();
    let tags = meta.tags.join(", ");
    let people = names.join(", ");

    let lines: Vec<&str> = [title, project, tags.as_str(), people.as_str()]
        .into_iter()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();

    assert!(lines.len() <= 4);

    lines.join("\n")
}

pub(crate) fn people_names(meta: &JobMeta, people: &[Person]) -> Vec<String> {
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut names: Vec<String> = Vec::new();

    let listed = people
        .iter()
        .filter(|person| {
            meta.person_ids.contains(&person.id) || meta.person_ids_mentioned.contains(&person.id)
        })
        .map(Person::name_full);

    for name in meta.attendees.iter().cloned().chain(listed) {
        if names.len() >= usize_of!(NAMES_MAX) {
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
    assert!(names.len() <= usize_of!(NAMES_MAX));

    names
}

fn chunks_from_text(text: &str) -> Vec<ChunkDraft> {
    let chunks: Vec<ChunkDraft> = pieces_of_lines(text, CHUNK_CHARS_UNTIMED)
        .into_iter()
        .take(usize_of!(CHUNKS_MAX))
        .map(|body| ChunkDraft {
            body,
            end_seconds: None,
            heading: None,
            segment_index_first: None,
            segment_index_last: None,
            source: ChunkSource::Transcript,
            start_seconds: None,
        })
        .collect();

    assert!(chunks.len() <= usize_of!(CHUNKS_MAX));
    assert!(chunks.iter().all(|chunk| chars_count(&chunk.body) <= CHUNK_CHARS_UNTIMED));

    chunks
}

fn heading_of(line: &str) -> Option<String> {
    let trimmed = line.trim_start();
    let hashes = trimmed.chars().take_while(|character| *character == '#').count();
    let level = u32::try_from(hashes).unwrap_or(u32::MAX);

    if !(1..=HEADING_LEVEL_MAX).contains(&level) {
        return None;
    }

    let rest = trimmed.get(hashes..)?;
    let separated = rest.is_empty() || rest.starts_with([' ', '\t']);

    if !separated {
        return None;
    }

    let title: String = rest
        .trim()
        .trim_end_matches('#')
        .trim()
        .chars()
        .take(usize_of!(HEADING_CHARS_MAX))
        .collect();

    assert!(chars_count(&title) <= HEADING_CHARS_MAX);

    if title.is_empty() {
        return None;
    }

    Some(title)
}

fn pieces_of_chars(word: &str, chars_max: u32) -> Vec<String> {
    assert!(chars_max > 0);

    let characters: Vec<char> = word.chars().collect();
    let pieces: Vec<String> =
        characters.chunks(usize_of!(chars_max)).map(|piece| piece.iter().collect()).collect();

    assert!(pieces.iter().all(|piece| chars_count(piece) <= chars_max));

    pieces
}

fn pieces_of_lines(text: &str, chars_max: u32) -> Vec<String> {
    assert!(chars_max > 0);

    let mut pieces: Vec<String> = Vec::new();
    let mut buffer = String::new();
    let mut buffer_chars = 0_u32;

    for line in text.lines().map(str::trim_end) {
        let line_chars = chars_count(line);

        if line_chars > chars_max {
            pieces.push(mem::take(&mut buffer));
            pieces.extend(pieces_of_words(line, chars_max));
            buffer_chars = 0;

            continue;
        }

        let separator_chars = u32::from(!buffer.is_empty());

        if buffer_chars + separator_chars + line_chars > chars_max {
            pieces.push(mem::take(&mut buffer));
            buffer_chars = 0;
        }

        if !buffer.is_empty() {
            buffer.push('\n');
            buffer_chars += 1;
        }

        buffer.push_str(line);
        buffer_chars += line_chars;
    }

    pieces.push(buffer);
    pieces.retain(|piece| piece.chars().any(char::is_alphanumeric));

    assert!(pieces.iter().all(|piece| chars_count(piece) <= chars_max));

    pieces.into_iter().map(|piece| piece.trim().to_owned()).collect()
}

fn pieces_of_words(text: &str, chars_max: u32) -> Vec<String> {
    assert!(chars_max > 0);

    let mut pieces: Vec<String> = Vec::new();
    let mut buffer = String::new();
    let mut buffer_chars = 0_u32;

    for word in text.split_whitespace() {
        let word_chars = chars_count(word);

        if word_chars > chars_max {
            pieces.push(mem::take(&mut buffer));
            pieces.extend(pieces_of_chars(word, chars_max));
            buffer_chars = 0;

            continue;
        }

        let separator_chars = u32::from(!buffer.is_empty());

        if buffer_chars + separator_chars + word_chars > chars_max {
            pieces.push(mem::take(&mut buffer));
            buffer_chars = 0;
        }

        if !buffer.is_empty() {
            buffer.push(' ');
            buffer_chars += 1;
        }

        buffer.push_str(word);
        buffer_chars += word_chars;
    }

    pieces.push(buffer);
    pieces.retain(|piece| !piece.is_empty());

    assert!(pieces.iter().all(|piece| chars_count(piece) <= chars_max));

    pieces
}

fn section_drafts(heading: Option<&str>, lines: &[&str]) -> Vec<ChunkDraft> {
    let content_present = lines
        .iter()
        .filter(|line| heading_of(line).is_none())
        .any(|line| line.chars().any(char::is_alphanumeric));

    if !content_present {
        return Vec::new();
    }

    let drafts: Vec<ChunkDraft> = pieces_of_lines(&lines.join("\n"), CHUNK_CHARS_MAX)
        .into_iter()
        .map(|body| ChunkDraft {
            body,
            end_seconds: None,
            heading: heading.map(str::to_owned),
            segment_index_first: None,
            segment_index_last: None,
            source: ChunkSource::Notes,
            start_seconds: None,
        })
        .collect();

    assert_ne!(drafts.len(), 0);

    drafts
}

fn segment_bounds(segment: &TranscriptSegment) -> (f64, f64) {
    let start = segment.start_seconds.max(0.0);
    let end = segment.end_seconds.max(start);

    assert!(start >= 0.0_f64);
    assert!(end >= start);

    (start, end)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ops::Range;

    fn segment(text: &str, seconds: Range<f64>) -> TranscriptSegment {
        assert!(seconds.start <= seconds.end);

        TranscriptSegment {
            text: text.to_owned(),
            start_seconds: seconds.start,
            end_seconds: seconds.end,
        }
    }

    fn transcript_of(segments: &[TranscriptSegment]) -> Transcript {
        let text = segments.iter().map(|part| part.text.as_str()).collect::<Vec<_>>().join(" ");

        Transcript { text, segments: segments.to_vec() }
    }

    fn words_of(text: &str) -> Vec<String> {
        text.split_whitespace().map(str::to_owned).collect()
    }

    fn generator_next(state: &mut u64) -> u64 {
        *state ^= *state << 13_u32;
        *state ^= *state >> 7_u32;
        *state ^= *state << 17_u32;

        *state
    }

    #[test]
    fn a_timed_transcript_is_cut_into_spans_that_keep_every_word_in_order() {
        let segments: Vec<TranscriptSegment> = (0..240_u32)
            .map(|index| {
                let start = f64::from(index) * 4.0_f64;

                segment(&format!("word{index} said here"), start..start + 4.0_f64)
            })
            .collect();

        let transcript = transcript_of(&segments);
        let chunks = chunks_from_transcript(&transcript);
        let rejoined: Vec<String> = chunks.iter().flat_map(|chunk| words_of(&chunk.body)).collect();

        assert_eq!(rejoined, words_of(&transcript.text));
        assert!(chunks.len() >= 15);

        for (chunk, next) in chunks.iter().zip(chunks.iter().skip(1)) {
            assert_eq!(chunk.segment_index_last.unwrap() + 1, next.segment_index_first.unwrap());
            assert!(chunk.end_seconds.unwrap() <= next.start_seconds.unwrap());
        }

        for chunk in &chunks {
            let span = chunk.end_seconds.unwrap() - chunk.start_seconds.unwrap();

            assert!(span < CHUNK_SECONDS_SPAN + 4.0_f64 + f64::EPSILON);
            assert!(chars_count(&chunk.body) <= CHUNK_CHARS_MAX);
            assert_eq!(chunk.source, ChunkSource::Transcript);
        }

        assert_eq!(chunks.first().unwrap().segment_index_first, Some(0));
        assert_eq!(chunks.last().unwrap().segment_index_last, Some(239));
    }

    #[test]
    fn an_untimed_transcript_is_cut_by_size_and_carries_no_seconds() {
        let segments: Vec<TranscriptSegment> = (0..300_u32)
            .map(|index| segment(&format!("line {index} of text"), 0.0_f64..0.0_f64))
            .collect();

        let transcript = transcript_of(&segments);
        let chunks = chunks_from_transcript(&transcript);
        let rejoined: Vec<String> = chunks.iter().flat_map(|chunk| words_of(&chunk.body)).collect();

        assert_eq!(rejoined, words_of(&transcript.text));
        assert!(chunks.len() > 1);
        assert!(chunks.iter().all(|chunk| chunk.start_seconds.is_none()));
        assert!(chunks.iter().all(|chunk| chunk.end_seconds.is_none()));
        assert!(chunks.iter().all(|chunk| chars_count(&chunk.body) <= CHUNK_CHARS_MAX));
    }

    #[test]
    fn a_segment_past_the_size_limit_is_split_alone_and_blank_ones_are_skipped() {
        let giant = "alpha ".repeat(900);
        let unbroken = "z".repeat(4000);

        let transcript = transcript_of(&[
            segment("before", 0.0_f64..1.0_f64),
            segment("   ", 1.0_f64..2.0_f64),
            segment(&giant, 2.0_f64..400.0_f64),
            segment(&unbroken, 400.0_f64..410.0_f64),
            segment("after", 410.0_f64..411.0_f64),
        ]);

        let chunks = chunks_from_transcript(&transcript);
        let rejoined: String = chunks.iter().map(|chunk| chunk.body.replace(' ', "")).collect();
        let expected = format!("before{}{}after", "alpha".repeat(900), unbroken);

        assert_eq!(rejoined, expected);
        assert_eq!(chunks.first().unwrap().body, "before");
        assert_eq!(chunks.last().unwrap().body, "after");
        assert!(chunks.iter().all(|chunk| chars_count(&chunk.body) <= CHUNK_CHARS_MAX));

        let giant_pieces: Vec<&ChunkDraft> =
            chunks.iter().filter(|chunk| chunk.segment_index_first == Some(2)).collect();

        assert!(giant_pieces.len() >= 3);
        assert!(giant_pieces.iter().all(|chunk| chunk.segment_index_last == Some(2)));
        assert!(chunks.iter().all(|chunk| chunk.segment_index_first != Some(1)));
    }

    #[test]
    fn random_transcripts_keep_their_words_and_their_bounds() {
        let mut state = 0x9E37_79B9_7F4A_7C15_u64;

        for _round in 0..200_u32 {
            let count = generator_next(&mut state) % 80;
            let mut seconds = 0.0_f64;
            let mut segments = Vec::new();

            for _segment in 0..count {
                let words = generator_next(&mut state) % 120;
                let text: Vec<String> = std::iter::repeat_with(|| {
                    let length = 1 + generator_next(&mut state) % 30;

                    "x".repeat(usize::try_from(length).unwrap())
                })
                .take(usize::try_from(words).unwrap())
                .collect();

                let span = f64::from(u32::try_from(generator_next(&mut state) % 20).unwrap());

                segments.push(segment(&text.join(" "), seconds..seconds + span));
                seconds += span;
            }

            let transcript = transcript_of(&segments);
            let chunks = chunks_from_transcript(&transcript);
            let rejoined: Vec<String> =
                chunks.iter().flat_map(|chunk| words_of(&chunk.body)).collect();

            assert_eq!(rejoined, words_of(&transcript.text));
            assert!(chunks.iter().all(|chunk| chars_count(&chunk.body) <= CHUNK_CHARS_MAX));
            assert!(chunks.iter().all(|chunk| !chunk.body.trim().is_empty()));
        }
    }

    #[test]
    fn notes_are_cut_at_headings_and_keep_every_word() {
        let markdown = "Intro line.\n\n# Decisions\n\n- Ship the retry work.\n\
                        - Budget is approved.\n\n## Action items ##\n\nAna drafts the plan.\n\n\
                        ### Empty\n\n#NotAHeading text\n";

        let chunks = chunks_from_notes(markdown);
        let headings: Vec<Option<&str>> =
            chunks.iter().map(|chunk| chunk.heading.as_deref()).collect();

        assert_eq!(headings, [None, Some("Decisions"), Some("Action items"), Some("Empty")]);
        assert!(chunks[1].body.starts_with("# Decisions"));
        assert!(chunks[3].body.contains("#NotAHeading text"));

        let rejoined: Vec<String> = chunks.iter().flat_map(|chunk| words_of(&chunk.body)).collect();

        assert_eq!(rejoined, words_of(markdown));
        assert!(chunks.iter().all(|chunk| chunk.segment_index_first.is_none()));
    }

    #[test]
    fn a_long_notes_section_is_split_under_its_heading_and_a_bare_heading_is_dropped() {
        let lines: Vec<String> = (0..400_u32).map(|index| format!("- point {index}")).collect();
        let markdown = format!("# Long\n{}\n# Bare\n\n# Last\nend", lines.join("\n"));
        let chunks = chunks_from_notes(&markdown);

        assert!(chunks.len() > 2);
        assert!(chunks.iter().all(|chunk| chunk.heading.as_deref() != Some("Bare")));
        assert_eq!(chunks.last().unwrap().heading.as_deref(), Some("Last"));
        assert!(chunks.iter().all(|chunk| chars_count(&chunk.body) <= CHUNK_CHARS_MAX));

        let rejoined: Vec<String> = chunks.iter().flat_map(|chunk| words_of(&chunk.body)).collect();
        let expected: Vec<String> =
            words_of(&markdown).into_iter().filter(|word| word != "Bare").collect();

        assert_eq!(
            rejoined.iter().filter(|word| *word != "#").collect::<Vec<_>>(),
            expected.iter().filter(|word| *word != "#").collect::<Vec<_>>(),
        );
    }

    #[test]
    fn a_transcript_with_text_but_no_segments_is_cut_from_its_text() {
        let lines: Vec<String> =
            (0..200_u32).map(|index| format!("Sentence {index} of the call.")).collect();

        let transcript = Transcript { text: lines.join("\n"), segments: Vec::new() };
        let chunks = chunks_from_transcript(&transcript);
        let rejoined: Vec<String> = chunks.iter().flat_map(|chunk| words_of(&chunk.body)).collect();

        assert_eq!(rejoined, words_of(&transcript.text));
        assert!(chunks.len() > 1);
        assert!(chunks.iter().all(|chunk| chunk.source == ChunkSource::Transcript));
        assert!(chunks.iter().all(|chunk| chunk.segment_index_first.is_none()));
        assert!(chunks.iter().all(|chunk| chunk.start_seconds.is_none()));
        assert!(chunks.iter().all(|chunk| chars_count(&chunk.body) <= CHUNK_CHARS_UNTIMED));

        let blank_segments = Transcript {
            text: "Only the text holds words.".to_owned(),
            segments: vec![segment("  ", 0.0_f64..1.0_f64)],
        };

        let recovered = chunks_from_transcript(&blank_segments);

        assert_eq!(recovered.len(), 1);
        assert_eq!(recovered.first().unwrap().body, "Only the text holds words.");
    }

    #[test]
    fn empty_sources_yield_no_chunks() {
        let blank = Transcript { text: " \n ".to_owned(), segments: Vec::new() };
        let spaces = transcript_of(&[segment(" ", 0.0_f64..1.0_f64)]);

        assert_eq!(chunks_from_notes("").len(), 0);
        assert_eq!(chunks_from_notes("\n\n   \n# Only a heading\n").len(), 0);
        assert_eq!(chunks_from_transcript(&transcript_of(&[])).len(), 0);
        assert_eq!(chunks_from_transcript(&spaces).len(), 0);
        assert_eq!(chunks_from_transcript(&blank).len(), 0);
    }

    #[test]
    fn a_header_lists_the_title_project_tags_and_people_that_are_present() {
        let mut meta = crate::workspace::test_support::meta_with(&"a".repeat(32), 1);

        meta.label = Some("call.m4a".to_owned());
        meta.project = Some("Tailspin Toys".to_owned());
        meta.tags = vec!["budget".to_owned(), "q3".to_owned()];

        let names = vec!["Ana Lopez".to_owned()];

        assert_eq!(header_build(&meta, &names), "call.m4a\nTailspin Toys\nbudget, q3\nAna Lopez");

        meta.title = Some("Weekly sync".to_owned());
        meta.project = None;
        meta.tags.clear();

        assert_eq!(header_build(&meta, &[]), "Weekly sync");
    }

    #[test]
    fn people_names_merge_attendees_and_known_people_once_each() {
        let mut meta = crate::workspace::test_support::meta_with(&"b".repeat(32), 1);

        let people = vec![
            Person {
                id: "p1".to_owned(),
                name_first: "Ana".to_owned(),
                name_last: "Lopez".to_owned(),
                role: String::new(),
                description: String::new(),
            },
            Person {
                id: "p2".to_owned(),
                name_first: "Ben".to_owned(),
                name_last: "Ng".to_owned(),
                role: String::new(),
                description: String::new(),
            },
        ];

        meta.attendees = vec!["ana lopez".to_owned(), " ".to_owned(), "Chris".to_owned()];
        meta.person_ids = vec!["p1".to_owned()];
        meta.person_ids_mentioned = vec!["p2".to_owned(), "missing".to_owned()];

        assert_eq!(people_names(&meta, &people), ["ana lopez", "Chris", "Ben Ng"]);
    }

    #[test]
    fn a_chunk_source_round_trips_through_its_text() {
        for source in [ChunkSource::Notes, ChunkSource::Transcript] {
            assert_eq!(ChunkSource::parse(source.name()), Some(source));
        }

        assert_eq!(ChunkSource::parse("title"), None);
    }
}
