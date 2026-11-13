use super::remote::{ChatPrompts, chat_completion, chat_completion_streaming, models_list};
use super::templates::{
    NotesTemplate,
    PROMPT_NOTES_SYSTEM,
    template_delete,
    template_load,
    template_upsert,
    templates_load_all,
};
use crate::blocking;
use crate::contract::{
    EndpointID,
    Instruction,
    JobID,
    Markdown,
    StreamID,
    TemplateID,
    TranscriptText,
};
use crate::endpoints::storage::{
    ENDPOINT_ID_NOTES,
    MODEL_NOTES,
    MODEL_TRANSCRIPTION,
    endpoint_load,
};
use crate::error::{AppError, AppResult};
use crate::people::storage::{Person, people_load_all};
use crate::workspace::{self, JobMeta, NOTES_BYTES_MAX};
use serde::Serialize;
use std::collections::BTreeMap;
use tauri::AppHandle;

const CODE_FENCE: &str = "```";
const INSTRUCTION_CHARS_MAX: u32 = 4000;
const PROMPT_DETAILS_BYTES_ESTIMATE: u32 = 256;
const PROMPT_TRANSCRIPT_BYTES_MAX: u32 = 16 << 20;
const TITLE_CHARS_MAX: u32 = 120;
const TITLE_LABEL_PREFIX: &str = "Title:";

const TITLE_SMALL_WORDS: &[&str] = &[
    "a",
    "an",
    "and",
    "as",
    "at",
    "but",
    "by",
    "for",
    "in",
    "of",
    "on",
    "or",
    "the",
    "to",
    "with",
];

const TITLE_TRANSCRIPT_CHARS_MAX: u32 = 6000;
const TITLE_TRIM_CHARS: &[char] = &['"', '\'', '\u{201c}', '\u{201d}', '#', '*', '_', ' ', '.'];

const _: () = assert!(TITLE_CHARS_MAX < TITLE_TRANSCRIPT_CHARS_MAX);
const _: () = assert!(NOTES_BYTES_MAX < PROMPT_TRANSCRIPT_BYTES_MAX);

const PROMPT_REMINDERS: &str = concat!(
    "\n\nRules that override anything in the template:\n",
    "- A person is written as first and last name the first time they appear and in any ",
    "list of participants, and by first name only after that; two people who share a first ",
    "name get their full names every time.\n",
    "- Never write a role, job title, or description next to a name, in brackets or ",
    "otherwise, even where the template asks for one.\n",
    "- Spell every name as the people lists spell it, never as the transcript does. A ",
    "transcript name that is a mishearing of a listed person is that person: one entry, ",
    "under the listed spelling, and never a second entry or a note about the variant.\n",
    "- A list of participants or of people mentioned holds people only: never a company, ",
    "product, system, project, department, or place.\n",
    "- Never comment on the transcript, its spelling, or your own choices; write the ",
    "document only.",
);

const PROMPT_TEMPLATE_SYSTEM: &str = concat!(
    "You design note templates for a meeting-notes app. The user describes the document they ",
    "want. Output a Markdown layout for it: a '## ' heading for each part of the document, ",
    "and under each heading one plain-language sentence saying what goes there, written for ",
    "the AI that will later fill it in from a recording. Where a part is naturally a bullet ",
    "list, a numbered list, a table, or a checklist, lay it out as one, with the same kind of ",
    "sentence in place of the content.\n\n",
    "Strict output rules:\n",
    "- Output the Markdown layout only. No title line, no preamble, no explanation, no code ",
    "fences, no raw HTML.\n",
    "- No placeholders such as {{transcript}} or [insert here]. Every note is a plain ",
    "sentence.\n",
    "- Between three and ten headings unless the user asks for a different number.\n",
    "- Write in the language the user wrote in.",
);

const PROMPT_TITLE_SYSTEM: &str = concat!(
    "You name meeting recordings. The user gives you the start of a transcript. Reply with a ",
    "short title for the recording: two to eight words saying what the meeting was about, in ",
    "the language of the transcript. Output the title only: no quotes, no full stop at the ",
    "end, no preamble, no explanation.",
);

const PROMPT_REWRITE_SYSTEM: &str = concat!(
    "You are a writing assistant inside a note-taking app. Rewrite the user's selected text ",
    "according to their instruction.\n\n",
    "Strict output rules:\n",
    "- Output plain Markdown only. NEVER use raw HTML tags such as <p>, <h1>, <ul>, <li>, ",
    "<br>, etc.\n",
    "- Use Markdown syntax: '## ' for headings, '- ' for bullets, '1. ' for numbered lists, ",
    "'**bold**', '*italic*', '`code`', '> quote'.\n",
    "- Output ONLY the rewritten text. No preamble, no explanation, no surrounding code ",
    "fences.\n",
    "- The selected text is Markdown. Keep its structure exactly: the same block types in the ",
    "same order, the same number of list items, headings stay headings, paragraphs stay ",
    "paragraphs, and existing inline formatting stays. Change the wording only, unless the ",
    "instruction itself asks for a different structure.\n",
    "- The output replaces the selected text in place, so keep to its scope: a single line ",
    "stays a single line and a paragraph stays a paragraph. Never grow a selection into a ",
    "whole document, wrap it in headings or sections, or restate text outside it.\n",
    "- When a template is given, the text is the whole document written to it: keep the ",
    "template's headings, sections, and their order, and never add sections it does not ",
    "have or drop ones it does.",
);

const PROMPT_TRANSCRIPT_CORRECT_SYSTEM: &str = concat!(
    "You correct a meeting transcript inside a note-taking app. The user gives the transcript ",
    "as numbered lines and an instruction saying what is wrong with it.\n\n",
    "Strict output rules:\n",
    "- Output only the lines that change, one per line, as '<number>: <corrected line>'.\n",
    "- Keep every word the instruction does not touch exactly as it is: never rephrase, ",
    "summarize, merge, split, reorder, add, or remove lines.\n",
    "- Apply the instruction on every line it applies to, not only the first.\n",
    "- If nothing needs to change, output nothing.\n",
    "- If the instruction is not a correction, for example it asks for a summary, a rewrite, ",
    "or a translation, output nothing.\n",
    "- No preamble, no explanation, no code fences.",
);

#[derive(Debug, Clone, Serialize)]
pub(crate) struct NotesModels {
    pub(crate) models: Vec<String>,
    pub(crate) model_default: String,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct LineCorrection {
    pub(crate) index: u32,
    pub(crate) text: String,
}

struct PromptParts<'text> {
    instructions: &'text str,
    meta: Option<&'text JobMeta>,
    people: &'text [Person],
    transcript: &'text str,
}

#[tauri::command(rename_all = "snake_case")]
pub(crate) async fn notes_generate_remote_streaming(
    app: AppHandle,
    stream_id: StreamID,
    job_id: Option<JobID>,
    transcript_text: TranscriptText,
    template_id: TemplateID,
    endpoint_id: EndpointID,
) -> AppResult<String> {
    transcript_text_validate(&transcript_text)?;

    let template = template_load(&template_id)?;
    let endpoint = endpoint_load(&endpoint_id)?;
    let meta = meta_resolve(job_id.as_deref())?;
    let people = people_resolve(meta.as_ref())?;

    let user_prompt = prompt_build(&PromptParts {
        instructions: &template.instructions,
        meta: meta.as_ref(),
        people: &people,
        transcript: &transcript_text,
    });

    let prompts = ChatPrompts { system: PROMPT_NOTES_SYSTEM, user: &user_prompt };

    chat_completion_streaming(app, stream_id, &endpoint, &prompts).await
}

#[tauri::command(rename_all = "snake_case")]
pub(crate) async fn notes_load(job_id: JobID) -> AppResult<Option<String>> {
    blocking::run(move || workspace::notes_load(&job_id)).await
}

#[tauri::command]
pub(crate) async fn notes_models_list() -> AppResult<NotesModels> {
    let endpoint = endpoint_load(ENDPOINT_ID_NOTES)?;

    let models: Vec<String> = models_list(&endpoint)
        .await?
        .into_iter()
        .filter(|model| model != MODEL_TRANSCRIPTION)
        .collect();

    assert!(models.iter().all(|model| model != MODEL_TRANSCRIPTION));

    Ok(NotesModels { models, model_default: MODEL_NOTES.to_owned() })
}

#[tauri::command(rename_all = "snake_case")]
pub(crate) async fn notes_save(job_id: JobID, markdown: Markdown) -> AppResult<()> {
    blocking::run(move || workspace::notes_save(&job_id, markdown.as_bytes())).await
}

#[tauri::command(rename_all = "snake_case")]
pub(crate) async fn notes_template_delete(id: TemplateID) -> AppResult<()> {
    blocking::run(move || template_delete(&id)).await
}

#[tauri::command(rename_all = "snake_case")]
pub(crate) async fn notes_template_generate(
    endpoint_id: EndpointID,
    description: Instruction,
) -> AppResult<String> {
    let endpoint = endpoint_load(&endpoint_id)?;
    let description_trimmed = description.trim();

    if description_trimmed.is_empty() {
        return Err(AppError::Config("describe the document first".into()));
    }

    instruction_length_validate(description_trimmed, "the description")?;

    let user_prompt = format!("Document wanted: {description_trimmed}");
    let prompts = ChatPrompts { system: PROMPT_TEMPLATE_SYSTEM, user: &user_prompt };
    let reply = chat_completion(&endpoint, &prompts).await?;
    let layout = code_fence_strip(&reply).to_owned();

    if layout.is_empty() {
        return Err(AppError::Service("the AI returned an empty template".into()));
    }

    Ok(layout)
}

#[tauri::command(rename_all = "snake_case")]
pub(crate) async fn notes_template_save(template: NotesTemplate) -> AppResult<()> {
    blocking::run(move || template_upsert(template)).await
}

#[tauri::command]
pub(crate) async fn notes_templates_list() -> AppResult<Vec<NotesTemplate>> {
    blocking::run(templates_load_all).await
}

#[tauri::command(rename_all = "snake_case")]
pub(crate) async fn notes_text_rewrite_streaming(
    app: AppHandle,
    stream_id: StreamID,
    endpoint_id: EndpointID,
    text: Markdown,
    instruction: Instruction,
    template_id: Option<TemplateID>,
) -> AppResult<String> {
    let endpoint = endpoint_load(&endpoint_id)?;
    let instruction_trimmed = instruction.trim();

    if instruction_trimmed.is_empty() {
        return Err(AppError::Config("instruction cannot be empty".into()));
    }

    instruction_length_validate(instruction_trimmed, "the instruction")?;

    if text.is_empty() {
        return Err(AppError::Config("selected text cannot be empty".into()));
    }

    if text.len() > usize_of!(NOTES_BYTES_MAX) {
        return Err(AppError::Config(format!(
            "the selected text is {} bytes, over the {NOTES_BYTES_MAX} bytes this app rewrites",
            text.len(),
        )));
    }

    let template_block = match template_id.as_deref() {
        Some(id) => format!("Template the notes follow:\n{}\n\n", template_load(id)?.instructions),
        None => String::new(),
    };

    let selected = &*text;

    let user_prompt = format!(
        "Instruction: {instruction_trimmed}\n\n{template_block}Selected text:\n{selected}\n\n\
         Rewritten text:",
    );

    let prompts = ChatPrompts { system: PROMPT_REWRITE_SYSTEM, user: &user_prompt };

    chat_completion_streaming(app, stream_id, &endpoint, &prompts).await
}

pub(crate) async fn title_generate(transcript_text: &str) -> AppResult<String> {
    let mut endpoint = endpoint_load(ENDPOINT_ID_NOTES)?;

    endpoint.reasoning_effort = None;

    if !endpoint.has_api_key {
        return Err(AppError::Config("no notes API key is set".into()));
    }

    let excerpt: String =
        transcript_text.chars().take(usize_of!(TITLE_TRANSCRIPT_CHARS_MAX)).collect();

    let excerpt_trimmed = excerpt.trim();

    if excerpt_trimmed.is_empty() {
        return Err(AppError::Config("the transcript is empty".into()));
    }

    let user_prompt = format!("Transcript:\n{excerpt_trimmed}");
    let prompts = ChatPrompts { system: PROMPT_TITLE_SYSTEM, user: &user_prompt };
    let reply = chat_completion(&endpoint, &prompts).await?;
    let title = title_clean(&reply);

    if title.is_empty() {
        return Err(AppError::Service("the AI returned no title".into()));
    }

    assert!(title.chars().count() <= usize_of!(TITLE_CHARS_MAX));

    Ok(title)
}

#[tauri::command(rename_all = "snake_case")]
pub(crate) async fn transcript_correct_streaming(
    app: AppHandle,
    stream_id: StreamID,
    endpoint_id: EndpointID,
    lines: Vec<String>,
    instruction: Instruction,
) -> AppResult<Vec<LineCorrection>> {
    let endpoint = endpoint_load(&endpoint_id)?;
    let instruction_trimmed = instruction.trim();

    if instruction_trimmed.is_empty() {
        return Err(AppError::Config("say what to correct first".into()));
    }

    instruction_length_validate(instruction_trimmed, "the instruction")?;

    if lines.is_empty() {
        return Err(AppError::Config("the transcript is empty".into()));
    }

    let Ok(line_count) = u32::try_from(lines.len()) else {
        return Err(AppError::Config("the transcript has too many lines to correct".into()));
    };

    let numbered = lines_number(&lines);

    transcript_text_validate(&numbered)?;

    let user_prompt =
        format!("Transcript:\n{numbered}\n\nInstruction: {instruction_trimmed}\n\nChanged lines:");

    let prompts = ChatPrompts { system: PROMPT_TRANSCRIPT_CORRECT_SYSTEM, user: &user_prompt };
    let reply = chat_completion_streaming(app, stream_id, &endpoint, &prompts).await?;

    Ok(corrections_parse(&reply, line_count))
}

fn code_fence_strip(reply: &str) -> &str {
    let trimmed = reply.trim();

    let Some(after_open) = trimmed.strip_prefix(CODE_FENCE) else {
        return trimmed;
    };

    let body = after_open.split_once('\n').map_or("", |(_, rest)| rest);
    let stripped = body.trim_end().strip_suffix(CODE_FENCE).unwrap_or(body).trim();

    assert!(stripped.len() < reply.len());

    stripped
}

fn corrections_parse(reply: &str, line_count: u32) -> Vec<LineCorrection> {
    assert!(line_count <= PROMPT_TRANSCRIPT_BYTES_MAX);

    let mut by_index: BTreeMap<u32, String> = BTreeMap::new();

    for line in code_fence_strip(reply).lines() {
        let Some((number_text, text)) = line.trim().split_once(':') else {
            continue;
        };

        let Ok(number) = number_text.trim().parse::<u32>() else {
            continue;
        };

        if number == 0 {
            continue;
        }

        if number > line_count {
            continue;
        }

        let text_trimmed = text.trim();

        if text_trimmed.is_empty() {
            continue;
        }

        let _previous = by_index.insert(number - 1, text_trimmed.to_owned());
    }

    let corrections: Vec<LineCorrection> =
        by_index.into_iter().map(|(index, text)| LineCorrection { index, text }).collect();

    assert!(corrections.iter().all(|correction| correction.index < line_count));
    assert!(corrections.is_sorted_by_key(|correction| correction.index));

    corrections
}

fn instruction_length_validate(text: &str, label: &'static str) -> AppResult<()> {
    assert_ne!(label, "");

    if text.chars().count() > usize_of!(INSTRUCTION_CHARS_MAX) {
        return Err(AppError::Config(format!(
            "{label} is too long; keep it under {INSTRUCTION_CHARS_MAX} characters",
        )));
    }

    Ok(())
}

fn lines_number(lines: &[String]) -> String {
    let numbered_lines: Vec<String> = lines
        .iter()
        .enumerate()
        .map(|(position, line)| format!("{}: {}\n", position + 1, line.trim()))
        .collect();

    let numbered = numbered_lines.concat();

    assert!(numbered.lines().count() >= lines.len());

    numbered
}

fn meta_resolve(job_id: Option<&str>) -> AppResult<Option<JobMeta>> {
    job_id.map_or_else(|| Ok(None), workspace::meta_load)
}

fn people_describe(ids: &[String], people: &[Person]) -> String {
    let described: Vec<String> = ids
        .iter()
        .filter_map(|id| people.iter().find(|person| &person.id == id))
        .map(person_describe)
        .collect();

    assert!(described.len() <= ids.len());

    described.join("; ")
}

fn people_present_describe(meta: &JobMeta, people: &[Person]) -> String {
    let described = people_describe(&meta.person_ids, people);

    if described.is_empty() {
        return meta.attendees.join(", ");
    }

    described
}

fn people_resolve(meta: Option<&JobMeta>) -> AppResult<Vec<Person>> {
    let Some(record) = meta else {
        return Ok(Vec::new());
    };

    let nobody_listed = record.person_ids.is_empty() && record.person_ids_mentioned.is_empty();

    if nobody_listed {
        return Ok(Vec::new());
    }

    people_load_all()
}

fn person_describe(person: &Person) -> String {
    let mut text = person.name_full();

    if !person.role.is_empty() {
        text.push_str(" (");
        text.push_str(&person.role);
        text.push(')');
    }

    if !person.description.is_empty() {
        text.push_str(": ");
        text.push_str(&person.description);
    }

    assert!(text.starts_with(person.name_first.trim()));

    text
}

fn prompt_build(parts: &PromptParts<'_>) -> String {
    let PromptParts { instructions, meta, people, transcript } = *parts;
    let title = meta.and_then(|record| record.title.as_deref()).unwrap_or("");
    let project = meta.and_then(|record| record.project.as_deref()).unwrap_or("");

    let people_present =
        meta.map(|record| people_present_describe(record, people)).unwrap_or_default();

    let people_mentioned = meta
        .map(|record| people_describe(&record.person_ids_mentioned, people))
        .unwrap_or_default();

    let tags_joined = meta.map(|record| record.tags.join(", ")).unwrap_or_default();

    let recorded_on = meta
        .map(|record| record.recorded_at_unix.unwrap_or(record.created_at_unix))
        .and_then(|unix| chrono::DateTime::from_timestamp(unix, 0))
        .map(|recorded| recorded.with_timezone(&chrono::Local).format("%Y-%m-%d").to_string())
        .unwrap_or_default();

    let details = [
        ("Title: ", title),
        ("Project: ", project),
        ("People present: ", people_present.as_str()),
        ("People mentioned but not present: ", people_mentioned.as_str()),
        ("Tags: ", tags_joined.as_str()),
        ("Recorded on: ", recorded_on.as_str()),
    ];

    let mut prompt = String::with_capacity(
        instructions.len() + transcript.len() + usize_of!(PROMPT_DETAILS_BYTES_ESTIMATE),
    );

    for (label, value) in details {
        if !value.is_empty() {
            prompt.push_str(label);
            prompt.push_str(value);
            prompt.push('\n');
        }
    }

    if !prompt.is_empty() {
        prompt.push('\n');
    }

    prompt.push_str("Transcript:\n");
    prompt.push_str(transcript);
    prompt.push_str("\n\nTemplate:\n");
    prompt.push_str(instructions.trim());
    prompt.push_str(PROMPT_REMINDERS);

    assert!(prompt.ends_with(PROMPT_REMINDERS));
    assert!(prompt.len() > instructions.trim().len() + transcript.len());

    prompt
}

fn title_case(text: &str) -> String {
    let mut title = String::with_capacity(text.len());

    for (index, word) in text.split_whitespace().enumerate() {
        if index > 0 {
            title.push(' ');
        }

        if index > 0 {
            let lower = word.to_lowercase();

            if TITLE_SMALL_WORDS.contains(&lower.as_str()) {
                title.push_str(&lower);

                continue;
            }
        }

        let mut characters = word.chars();

        if let Some(first) = characters.next() {
            title.extend(first.to_uppercase());
            title.push_str(characters.as_str());
        }
    }

    assert_eq!(title.split_whitespace().count(), text.split_whitespace().count());

    title
}

fn title_clean(reply: &str) -> String {
    let line_first = reply.lines().find(|line| !line.trim().is_empty()).unwrap_or("");
    let line_unlabelled = line_first.trim().strip_prefix(TITLE_LABEL_PREFIX).unwrap_or(line_first);
    let stripped = line_unlabelled.trim_matches(TITLE_TRIM_CHARS);
    let capped: String = stripped.chars().take(usize_of!(TITLE_CHARS_MAX)).collect();
    let title: String = title_case(&capped).chars().take(usize_of!(TITLE_CHARS_MAX)).collect();

    assert!(title.chars().count() <= usize_of!(TITLE_CHARS_MAX));

    title
}

fn transcript_text_validate(transcript_text: &str) -> AppResult<()> {
    if transcript_text.trim().is_empty() {
        return Err(AppError::Config("the transcript is empty".into()));
    }

    if transcript_text.len() > usize_of!(PROMPT_TRANSCRIPT_BYTES_MAX) {
        return Err(AppError::Config(format!(
            "the transcript is {} bytes, over the {PROMPT_TRANSCRIPT_BYTES_MAX} bytes this app \
             sends for notes",
            transcript_text.len(),
        )));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::people::storage::person_upsert;
    use crate::workspace::test_support::{meta_with, root_scoped};

    fn person_with(fields: &[&str; 4]) -> Person {
        let [id, name_first, role, description] = *fields;

        assert_ne!(id, "");

        Person {
            id: id.to_owned(),
            name_first: name_first.to_owned(),
            name_last: String::new(),
            role: role.to_owned(),
            description: description.to_owned(),
        }
    }

    #[test]
    fn title_case_handles_empty_text_small_words_and_non_ascii_initials() {
        assert_eq!(title_case(""), "");
        assert_eq!(title_case("   "), "");
        assert_eq!(title_case("the"), "The");
        assert_eq!(title_case("  \u{e9}lan   vital "), "\u{c9}lan Vital");
        assert_eq!(title_case("plan AND budget"), "Plan and Budget");
        assert_eq!(title_case("\u{df}tra\u{df}e"), "SStra\u{df}e");
        assert_eq!(title_case("a-b of c"), "A-b of C");
    }

    #[test]
    fn a_title_is_capped_in_characters_and_the_label_is_only_stripped_from_the_first_line() {
        let long = "\u{e9}".repeat(usize_of!(TITLE_CHARS_MAX) + 10);
        let capped = title_clean(&long);

        assert_eq!(capped.chars().count(), usize_of!(TITLE_CHARS_MAX));
        assert!(capped.starts_with('\u{c9}'));
        assert_eq!(title_clean("\n\n  Title:   \n"), "");
        assert_eq!(title_clean("**Budget**\nTitle: ignored"), "Budget");
        assert_eq!(title_clean("'quoted words'."), "Quoted Words");
        assert_eq!(title_clean("Title:Kickoff"), "Kickoff");
    }

    #[test]
    fn corrections_ignore_lines_that_are_not_numbered_and_keep_colons_inside_the_text() {
        let reply = concat!(
            "abc: not a number\n",
            "-1: negative\n",
            "99999999999: overflow\n",
            "  2 : time is 10:30  \n",
            "4: last line\n",
            ": no number\n",
            "3\n",
        );

        let corrections = corrections_parse(reply, 4);

        assert_eq!(corrections.len(), 2);
        assert_eq!(corrections[0].index, 1);
        assert_eq!(corrections[0].text, "time is 10:30");
        assert_eq!(corrections[1].index, 3);
        assert_eq!(corrections[1].text, "last line");
        assert_eq!(corrections_parse("1: anything", 0).len(), 0);
        assert_eq!(corrections_parse("1: \u{e9}", 1)[0].text, "\u{e9}");
    }

    #[test]
    fn a_code_fence_is_stripped_even_without_a_closing_fence_or_language() {
        assert_eq!(code_fence_strip("```\n## A\n"), "## A");
        assert_eq!(code_fence_strip("```json\n{}\n```"), "{}");
        assert_eq!(code_fence_strip("```"), "");
        assert_eq!(code_fence_strip("```\n```"), "");
        assert_eq!(code_fence_strip("   \n"), "");
        assert_eq!(code_fence_strip("text ``` inside"), "text ``` inside");
    }

    #[test]
    fn limits_are_inclusive_and_instructions_are_counted_in_characters() {
        let instruction_at_limit = "\u{e9}".repeat(usize_of!(INSTRUCTION_CHARS_MAX));
        let transcript_at_limit = "a".repeat(usize_of!(PROMPT_TRANSCRIPT_BYTES_MAX));

        instruction_length_validate(&instruction_at_limit, "the instruction").unwrap();
        instruction_length_validate("", "the instruction").unwrap();
        transcript_text_validate(&transcript_at_limit).unwrap();
        assert_eq!(lines_number(&[]), "");
    }

    #[test]
    fn people_are_described_by_known_id_only_and_attendees_fill_in_when_none_are_known() {
        let ann = Person { name_last: "Lee".to_owned(), ..person_with(&["a", "Ann", "CFO", ""]) };
        let people = vec![ann, person_with(&["b", "Bo", "", "new hire"])];
        let ids = ["b".to_owned(), "zzz".to_owned(), "a".to_owned()];
        let mut meta = meta_with("job", 1);

        meta.attendees = vec!["Walk-in".to_owned()];

        assert_eq!(people_describe(&ids, &people), "Bo: new hire; Ann Lee (CFO)");
        assert_eq!(people_describe(&[], &people), "");
        assert_eq!(people_present_describe(&meta, &people), "Walk-in");

        meta.person_ids = vec!["a".to_owned()];

        assert_eq!(people_present_describe(&meta, &people), "Ann Lee (CFO)");
    }

    #[test]
    fn a_prompt_without_people_or_a_title_carries_only_the_details_it_has() {
        let mut meta = meta_with("job", 1_737_460_800);

        meta.tags = vec!["a".to_owned(), "b".to_owned()];

        let prompt = prompt_build(&PromptParts {
            instructions: "Summarize.",
            meta: Some(&meta),
            people: &[],
            transcript: "words",
        });

        let head = concat!(
            "Tags: a, b\n",
            "Recorded on: 2025-01-21\n",
            "\nTranscript:\nwords",
            "\n\nTemplate:\nSummarize.",
        );

        assert!(prompt.starts_with(head));
        assert!(!prompt.contains("Title:"));
        assert!(!prompt.contains("People present:"));
        assert!(prompt.ends_with(PROMPT_REMINDERS));
    }

    #[test]
    fn resolving_metadata_and_people_touches_nothing_when_there_is_no_job_or_no_ids() {
        let _root = root_scoped();
        let mut meta = meta_with(&workspace::job_id_from_text("resolve"), 1);

        assert!(meta_resolve(None).unwrap().is_none());
        assert!(meta_resolve(Some(&meta.id)).unwrap().is_none());
        assert_eq!(people_resolve(None).unwrap().len(), 0);
        assert_eq!(people_resolve(Some(&meta)).unwrap().len(), 0);

        workspace::meta_save(&meta).unwrap();
        person_upsert(&person_with(&["p", "Pat", "", ""])).unwrap();
        meta.person_ids_mentioned = vec!["p".to_owned()];

        assert_eq!(meta_resolve(Some(&meta.id)).unwrap().unwrap().id, meta.id);
        assert_eq!(people_resolve(Some(&meta)).unwrap().len(), 1);
        assert_ne!(meta_resolve(Some("bad id")).unwrap_err().to_string(), "");
    }

    #[test]
    fn corrections_keep_only_numbered_lines_inside_the_transcript() {
        let reply = concat!(
            "```\n",
            "Here are the changes:\n",
            "2: Dana said Kalymma, not Kalima.\n",
            "9: out of range\n",
            "0: also out of range\n",
            "3:   \n",
            "1: first\n",
            "1: first, corrected twice\n",
            "```",
        );

        let corrections = corrections_parse(reply, 4);

        assert_eq!(corrections.len(), 2);
        assert_eq!(corrections[0].index, 0);
        assert_eq!(corrections[0].text, "first, corrected twice");
        assert_eq!(corrections[1].index, 1);
        assert_eq!(corrections[1].text, "Dana said Kalymma, not Kalima.");
        assert_eq!(corrections_parse("", 4).len(), 0);
    }

    #[test]
    fn an_ai_reply_that_breaks_the_expected_shape_is_data_and_never_a_crash() {
        let doubled = "```markdown\n```\ncode\n```\n```";
        let title_twice = "Title: Title: Budget";
        let sharp_s_words = "\u{df}".repeat(usize_of!(TITLE_CHARS_MAX));

        assert_eq!(code_fence_strip(doubled), "```\ncode\n```");
        assert_eq!(title_clean(title_twice), "Title: Budget");
        assert_eq!(title_clean(&sharp_s_words).chars().count(), usize_of!(TITLE_CHARS_MAX));
    }

    #[test]
    fn a_line_holding_a_line_break_is_numbered_once_and_never_a_crash() {
        let lines = vec!["one\ntwo".to_owned(), "three".to_owned()];

        assert_eq!(lines_number(&lines), "1: one\ntwo\n2: three\n");
    }

    #[test]
    fn a_template_padded_with_whitespace_still_builds_a_prompt() {
        let instructions = format!("Summarize.{}", " ".repeat(4096));

        let prompt = prompt_build(&PromptParts {
            instructions: &instructions,
            meta: None,
            people: &[],
            transcript: "words",
        });

        assert!(prompt.starts_with("Transcript:\nwords\n\nTemplate:\nSummarize."));
        assert!(prompt.ends_with(&format!("Template:\nSummarize.{PROMPT_REMINDERS}")));
    }

    #[test]
    fn a_person_read_back_untrimmed_is_described_without_a_crash() {
        let person = Person { name_first: " Ann".to_owned(), ..person_with(&["a", "Ann", "", ""]) };

        assert_eq!(person_describe(&person), "Ann");
    }

    #[test]
    fn numbered_lines_start_at_one_and_carry_every_line() {
        let lines = vec![" a ".to_owned(), "b".to_owned()];

        assert_eq!(lines_number(&lines), "1: a\n2: b\n");
    }

    #[test]
    fn every_meeting_detail_is_sent_with_the_instructions() {
        let meta = JobMeta {
            id: "abc".to_owned(),
            source_path: "/tmp/a.wav".to_owned(),
            source_size_bytes: 1,
            created_at_unix: 1_737_460_800,
            recorded_at_unix: Some(1_736_596_800),
            label: None,
            title: Some("Kickoff".to_owned()),
            attendees: vec!["Dana".to_owned(), "Sam".to_owned()],
            person_ids: vec!["p-dana".to_owned(), "p-gone".to_owned()],
            person_ids_mentioned: vec!["p-sam".to_owned()],
            project: Some("Website".to_owned()),
            tags: vec!["weekly".to_owned()],
            favourite: false,
        };

        let people = vec![
            Person {
                id: "p-dana".to_owned(),
                name_first: "Jane".to_owned(),
                name_last: "Doe".to_owned(),
                role: "project manager".to_owned(),
                description: "runs the delivery side".to_owned(),
            },
            Person {
                id: "p-sam".to_owned(),
                name_first: "Sam".to_owned(),
                name_last: String::new(),
                role: String::new(),
                description: String::new(),
            },
        ];

        let prompt = prompt_build(&PromptParts {
            instructions: " Write a summary. ",
            meta: Some(&meta),
            people: &people,
            transcript: "hello",
        });

        let details = concat!(
            "Title: Kickoff\n",
            "Project: Website\n",
            "People present: Jane Doe (project manager): runs the delivery side\n",
            "People mentioned but not present: Sam\n",
            "Tags: weekly\n",
            "Recorded on: 2025-01-11\n",
            "\nTranscript:\nhello",
            "\n\nTemplate:\nWrite a summary.",
        );

        assert_eq!(prompt, format!("{details}{PROMPT_REMINDERS}"));
    }

    #[test]
    fn a_recording_without_metadata_sends_only_instructions_and_transcript() {
        let prompt = prompt_build(&PromptParts {
            instructions: "Write a summary.",
            meta: None,
            people: &[],
            transcript: "hello",
        });

        let details = "Transcript:\nhello\n\nTemplate:\nWrite a summary.";

        assert_eq!(prompt, format!("{details}{PROMPT_REMINDERS}"));
    }

    #[test]
    fn a_title_loses_its_quotes_label_and_full_stop() {
        assert_eq!(title_clean("Title: \"Office Move Plan\".\n\nExtra"), "Office Move Plan");

        assert_eq!(title_clean("## Spring planting\n"), "Spring Planting");
        assert_eq!(title_clean("\n   \n"), "");
    }

    #[test]
    fn a_title_is_set_in_title_case_with_small_words_kept_low() {
        assert_eq!(title_case("the state of the office move"), "The State of the Office Move");
        assert_eq!(title_case("Q3 budget  review with IT"), "Q3 Budget Review with IT");
    }

    #[test]
    fn a_fenced_template_is_unwrapped() {
        assert_eq!(code_fence_strip("```markdown\n## A\nnote\n```\n"), "## A\nnote");
        assert_eq!(code_fence_strip("## A\nnote"), "## A\nnote");
    }

    #[test]
    fn an_empty_or_oversized_transcript_is_refused_before_a_prompt_is_built() {
        let oversized = "a".repeat(usize_of!(PROMPT_TRANSCRIPT_BYTES_MAX) + 1);

        assert!(transcript_text_validate("  \n").is_err());
        transcript_text_validate("hello").unwrap();
        assert!(transcript_text_validate(&oversized).is_err());
    }

    #[test]
    fn an_instruction_past_its_length_is_refused() {
        instruction_length_validate("shorten this", "the instruction").unwrap();

        let long = "a".repeat(usize_of!(INSTRUCTION_CHARS_MAX) + 1);

        assert!(instruction_length_validate(&long, "the instruction").is_err());
    }
}
