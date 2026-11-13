use crate::error::{AppError, AppResult};
use crate::workspace;
use serde::{Deserialize, Serialize};

const TEMPLATE_CHARS_MAX: u32 =
    TEMPLATE_NAME_CHARS_MAX + TEMPLATE_DESCRIPTION_CHARS_MAX + TEMPLATE_INSTRUCTIONS_CHARS_MAX;

const TEMPLATE_COUNT_MAX: u32 = 256;
const TEMPLATE_DESCRIPTION_CHARS_MAX: u32 = 240;
const TEMPLATE_INSTRUCTIONS_CHARS_MAX: u32 = 16 * 1024;
const TEMPLATE_NAME_CHARS_MAX: u32 = 120;
const TEMPLATES_FILE: &str = "notes_templates.json";
const TEMPLATES_FILE_BYTES_MAX: u32 = 64 << 20;

const _: () = assert!(TEMPLATES_FILE_BYTES_MAX >= TEMPLATE_COUNT_MAX * TEMPLATE_CHARS_MAX * 8);

pub(crate) const PROMPT_NOTES_SYSTEM: &str = concat!(
    "You turn a recording's transcript into a finished document in Markdown. The user gives ",
    "you a template: a Markdown layout with headings, and under each heading a short note ",
    "saying what belongs there. The template is the exact shape of the document. Keep every ",
    "heading, in the same order and at the same level, and keep every table, bullet list, ",
    "numbered list, and checklist in the same form as the template. Replace the note under ",
    "each heading with the real content from the recording; the note itself never appears in ",
    "the document. A table in the template shows its columns; fill it with one row per item ",
    "and keep the header row as given. A checklist item in the template shows the shape of ",
    "one item; write one `- [ ]` item per real item. Add no sections the template does not ",
    "have. If the recording has nothing for a section, keep the heading and write ",
    "'Nothing recorded.' under it rather than inventing content or dropping the section.\n\n",
    "Facts: only include what was actually said. Never invent names, numbers, prices, dates, ",
    "or decisions. Where the recording is unclear or people disagreed without resolving it, ",
    "say so plainly. Use the meeting details you were given (title, project, people present, ",
    "tags, recorded-on date) as given. The people present may carry a role in brackets, ",
    "like 'John Doe (project manager)'; when the transcript has no speaker labels, use those ",
    "roles and what each person says about themselves to work out who is speaking, and ",
    "attribute a statement to a person only when that is clear. When a people present list is ",
    "given it ",
    "is the complete list of who was in the meeting: never add a participant who is not on ",
    "it, and never invent one from a name that comes up in the recording. A name that comes ",
    "up in the recording and is not on the list belongs to someone who was talked about, not ",
    "someone who was there. People listed as mentioned but not present were talked about, ",
    "not in the room: use their names and roles to recognise them when they come up, and ",
    "never present them as a speaker. If a speaker is not named in the details or the ",
    "transcript, refer to them by role or as 'a participant', never by a guessed name.\n\n",
    "Names: the transcript is machine-generated and often mishears or misspells names. The ",
    "people lists in the meeting details are the only source of truth for how a name is ",
    "spelled. When a name in the transcript sounds like or is close to a person in the ",
    "details, it is that person: write their name exactly as the details spell it, every ",
    "time, and never the transcript's spelling. This applies to the people mentioned but not ",
    "present as much as to the people present. Write a person's first and last name, when ",
    "both are given, the first time they appear in the document and in any list of ",
    "participants; after that refer to them by first name only. The one exception is two ",
    "people who share a first name: write both their full names every time. The roles and ",
    "descriptions in the details are for your understanding only and never appear in the ",
    "document: no role in brackets after a name, no job title in a participants list, even ",
    "where a template's note asks for one.\n\n",
    "Timestamps: the transcript lines are prefixed with `[m:ss]` markers. Those are for your ",
    "reference only. Never copy a timestamp or any `[m:ss]` marker into the document.\n\n",
    "Style: plain, everyday language a non-technical reader understands. Complete sentences, ",
    "past tense, no filler, no commentary about the transcript or about yourself. Keep bullet ",
    "points to one idea each. Use bold only where the template does. Keep table cells brief ",
    "and separate points inside a cell with semicolons.\n\n",
    "Output only the document: no preamble, no explanation, no surrounding code fences.",
);

const INSTRUCTIONS_MEETING: &str = concat!(
    "## Date\n\n",
    "The meeting date if it was said in the recording, otherwise the recorded-on date, ",
    "written like Jan 21, 2025.\n\n",
    "## Participants\n\n",
    "- The people present from the details, one per bullet, first and last name only. ",
    "Nobody else. Only if no people were given, list the people who speak in the ",
    "recording.\n\n",
    "## Mentioned\n\n",
    "- People only, never a company, product, system, project, department, or place. One ",
    "person per bullet: the people mentioned from the details by name, plus anyone else ",
    "named in the recording who was not present, with a few words on why they came up. ",
    "Leave the section as 'Nothing recorded.' if no absent person came up.\n\n",
    "## Goals\n\n",
    "- What the meeting set out to achieve, one goal per bullet.\n\n",
    "## Recordings\n\n",
    "- The meeting title and date, like Sales Direction - 2025-07-11.\n\n",
    "## Discussion topics\n\n",
    "| Item | Talking Points | Feedback |\n",
    "| --- | --- | --- |\n",
    "| Short name of the topic | Questions raised or points made | What people answered, ",
    "agreed, or pushed back on |\n\n",
    "## Action items\n\n",
    "- [ ] **Person's name** what they need to do, and by when if a date was mentioned. ",
    "Include every open question that needs a follow-up.\n\n",
    "## Decisions\n\n",
    "- Every decision that was actually made, one per bullet, written as a statement. Leave ",
    "out things that were only discussed.",
);

const INSTRUCTIONS_SUMMARY: &str = concat!(
    "## Summary\n\n",
    "Two or three sentences covering the main point, so someone could read it in one ",
    "minute.\n\n",
    "## Key details\n\n",
    "- The most important details that came up: names, numbers, prices, and dates, one per ",
    "bullet.",
);

const INSTRUCTIONS_SITE_VISIT: &str = concat!(
    "## What we looked at\n\n",
    "- Each area, machine, or job that was inspected, one per bullet.\n\n",
    "## Problems found\n\n",
    "- Each problem, with any measurement or quantity that was mentioned.\n\n",
    "## Parts and materials needed\n\n",
    "| Item | Quantity | Notes |\n",
    "| --- | --- | --- |\n",
    "| The part or material | How many, as said | Size, supplier, or anything else said |\n\n",
    "## Costs and quotes\n\n",
    "- Every price, quote, or cost that was mentioned, with what it was for.\n\n",
    "## Next steps\n\n",
    "- [ ] **Person's name** what they need to do, and by when if a date was mentioned.",
);

const INSTRUCTIONS_PROCEDURE: &str = concat!(
    "## Before you begin\n\n",
    "- The tools, parts, and preparation needed before starting.\n\n",
    "## Steps\n\n",
    "1. Each step in the order it was explained, written so a new person could follow it.\n\n",
    "## Safety warnings\n\n",
    "- Every safety warning that was mentioned.\n\n",
    "## Common mistakes\n\n",
    "- Mistakes to avoid that were mentioned.",
);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct NotesTemplate {
    pub(crate) id: String,
    pub(crate) name: String,
    #[serde(default)]
    pub(crate) description: String,
    pub(crate) instructions: String,
    #[serde(default)]
    pub(crate) edited: bool,
}

pub(crate) fn template_delete(id: &str) -> AppResult<()> {
    let mut templates = templates_load_all()?;
    let templates_count_before = templates.len();

    templates.retain(|template| template.id != id);

    assert!(templates.len() <= templates_count_before);
    assert!(templates.iter().all(|template| template.id != id));

    templates_save_all(&templates)
}

pub(crate) fn template_load(id: &str) -> AppResult<NotesTemplate> {
    let template = templates_load_all()?
        .into_iter()
        .find(|template| template.id == id)
        .ok_or_else(|| AppError::Config(format!("template not found: {id}")))?;

    assert_eq!(template.id, id);

    Ok(template)
}

pub(crate) fn template_upsert(template: NotesTemplate) -> AppResult<()> {
    template_validate(&template)?;

    let edited = NotesTemplate { edited: true, ..template };
    let id = edited.id.clone();
    let mut templates = templates_load_all()?;

    match templates.iter_mut().find(|existing| existing.id == edited.id) {
        Some(existing) => *existing = edited,
        None => templates.push(edited),
    }

    assert!(templates.iter().any(|existing| existing.id == id));

    templates_save_all(&templates)
}

pub(crate) fn templates_load_all() -> AppResult<Vec<NotesTemplate>> {
    let path = workspace::root_file_path(TEMPLATES_FILE)?;

    if !path.exists() {
        return Ok(default_templates_seed());
    }

    let raw = workspace::file_read_bounded(&path, TEMPLATES_FILE_BYTES_MAX)?;

    let mut templates: Vec<NotesTemplate> = serde_json::from_str(&raw).map_err(|error| {
        AppError::Config(format!("the saved note templates could not be read: {error}"))
    })?;

    templates_count_validate(&templates)?;

    if seeds_refresh(&mut templates) {
        templates_save_all(&templates)?;
    }

    assert!(templates.len() <= usize_of!(TEMPLATE_COUNT_MAX));

    Ok(templates)
}

fn default_templates_seed() -> Vec<NotesTemplate> {
    let seeds = vec![
        NotesTemplate {
            id: "default-meeting-notes".to_owned(),
            name: "Meeting notes".to_owned(),
            description: concat!(
                "Who was there, what was discussed, decisions made, and who does ",
                "what next.",
            )
            .to_owned(),
            instructions: INSTRUCTIONS_MEETING.to_owned(),
            edited: false,
        },
        NotesTemplate {
            id: "default-summary".to_owned(),
            name: "Quick summary".to_owned(),
            description: concat!(
                "A few sentences on the main point and the key names, numbers, ",
                "and dates.",
            )
            .to_owned(),
            instructions: INSTRUCTIONS_SUMMARY.to_owned(),
            edited: false,
        },
        NotesTemplate {
            id: "default-site-visit".to_owned(),
            name: "Site visit or job notes".to_owned(),
            description: concat!(
                "What was inspected, problems found, parts and quotes, and next ",
                "steps.",
            )
            .to_owned(),
            instructions: INSTRUCTIONS_SITE_VISIT.to_owned(),
            edited: false,
        },
        NotesTemplate {
            id: "default-procedure".to_owned(),
            name: "Step-by-step procedure".to_owned(),
            description: concat!(
                "How to do a task: preparation, numbered steps, safety warnings, ",
                "and mistakes to avoid.",
            )
            .to_owned(),
            instructions: INSTRUCTIONS_PROCEDURE.to_owned(),
            edited: false,
        },
    ];

    assert!(seeds.iter().all(|seed| !seed.edited));
    assert!(seeds.len() <= usize_of!(TEMPLATE_COUNT_MAX));

    seeds
}

fn seeds_refresh(templates: &mut [NotesTemplate]) -> bool {
    let seeds = default_templates_seed();
    let mut changed = false;

    assert!(seeds.iter().all(|seed| !seed.id.is_empty()));

    for template in templates.iter_mut().filter(|template| !template.edited) {
        let Some(seed) = seeds.iter().find(|seed| seed.id == template.id) else {
            continue;
        };

        if template.instructions != seed.instructions {
            template.instructions.clone_from(&seed.instructions);
            changed = true;
        }

        if template.description != seed.description {
            template.description.clone_from(&seed.description);
            changed = true;
        }
    }

    changed
}

fn template_validate(template: &NotesTemplate) -> AppResult<()> {
    if template.id.trim().is_empty() {
        return Err(AppError::Config("the template has no id".into()));
    }

    if template.name.trim().is_empty() {
        return Err(AppError::Config("give the template a name before saving".into()));
    }

    if template.instructions.trim().is_empty() {
        return Err(AppError::Config(
            "describe what the notes should include before saving".into(),
        ));
    }

    if template.name.chars().count() > usize_of!(TEMPLATE_NAME_CHARS_MAX) {
        return Err(AppError::Config(format!(
            "the template name is too long; keep it under {TEMPLATE_NAME_CHARS_MAX} characters",
        )));
    }

    if template.description.chars().count() > usize_of!(TEMPLATE_DESCRIPTION_CHARS_MAX) {
        return Err(AppError::Config(format!(
            "the template description is too long; keep it under \
             {TEMPLATE_DESCRIPTION_CHARS_MAX} characters",
        )));
    }

    if template.instructions.chars().count() > usize_of!(TEMPLATE_INSTRUCTIONS_CHARS_MAX) {
        return Err(AppError::Config(format!(
            "the template text is too long; keep it under {TEMPLATE_INSTRUCTIONS_CHARS_MAX} \
             characters",
        )));
    }

    Ok(())
}

fn templates_count_validate(templates: &[NotesTemplate]) -> AppResult<()> {
    if templates.len() > usize_of!(TEMPLATE_COUNT_MAX) {
        return Err(AppError::Config(format!(
            "there are {} templates, over the {TEMPLATE_COUNT_MAX} this app keeps",
            templates.len(),
        )));
    }

    Ok(())
}

fn templates_save_all(templates: &[NotesTemplate]) -> AppResult<()> {
    templates_count_validate(templates)?;

    let path = workspace::root_file_path(TEMPLATES_FILE)?;
    let encoded = serde_json::to_string_pretty(templates)?;

    if encoded.len() > usize_of!(TEMPLATES_FILE_BYTES_MAX) {
        return Err(AppError::Config(format!(
            "the saved templates are {} bytes, over the {TEMPLATES_FILE_BYTES_MAX} bytes this \
             app keeps",
            encoded.len(),
        )));
    }

    workspace::atomic_write(&path, encoded.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::test_support::root_scoped;
    use std::fs;

    #[test]
    fn an_unedited_seed_takes_the_current_wording_and_an_edited_one_keeps_its_own() {
        let mut templates = vec![
            NotesTemplate {
                id: "default-meeting-notes".to_owned(),
                name: "Meeting notes".to_owned(),
                description: String::new(),
                instructions: "old wording".to_owned(),
                edited: false,
            },
            NotesTemplate {
                id: "default-summary".to_owned(),
                name: "Mine".to_owned(),
                description: String::new(),
                instructions: "my wording".to_owned(),
                edited: true,
            },
        ];

        assert!(seeds_refresh(&mut templates));
        assert_eq!(templates[0].instructions, INSTRUCTIONS_MEETING);
        assert_eq!(templates[1].instructions, "my wording");
        assert!(!seeds_refresh(&mut templates));
    }

    fn template_with(fields: &[&str; 2]) -> NotesTemplate {
        let [name, instructions] = *fields;

        NotesTemplate {
            id: "test".to_owned(),
            name: name.to_owned(),
            description: String::new(),
            instructions: instructions.to_owned(),
            edited: false,
        }
    }

    #[test]
    fn every_seeded_template_passes_validation() {
        let seeded = default_templates_seed();

        assert_ne!(seeded.len(), 0);

        for template in seeded {
            template_validate(&template).unwrap();
        }
    }

    #[test]
    fn a_template_without_a_name_or_instructions_is_refused() {
        assert!(template_validate(&template_with(&["  ", "Write a summary."])).is_err());
        assert!(template_validate(&template_with(&["Summary", "\n"])).is_err());

        let unidentified = NotesTemplate { id: " ".to_owned(), ..template_with(&["Summary", "x"]) };

        assert!(template_validate(&unidentified).is_err());
    }

    #[test]
    fn a_template_over_a_size_limit_is_refused_and_length_is_counted_in_characters() {
        let name_long = "n".repeat(usize_of!(TEMPLATE_NAME_CHARS_MAX) + 1);
        let name_multibyte = "\u{e9}".repeat(usize_of!(TEMPLATE_NAME_CHARS_MAX));
        let instructions_long = "i".repeat(usize_of!(TEMPLATE_INSTRUCTIONS_CHARS_MAX) + 1);
        let mut described = template_with(&["Summary", "Write a summary."]);

        described.description = "d".repeat(usize_of!(TEMPLATE_DESCRIPTION_CHARS_MAX) + 1);

        assert!(template_validate(&template_with(&[&name_long, "Write a summary."])).is_err());
        template_validate(&template_with(&[&name_multibyte, "Write a summary."])).unwrap();
        assert!(template_validate(&template_with(&["Summary", &instructions_long])).is_err());
        assert!(template_validate(&described).is_err());
    }

    #[test]
    fn a_template_count_past_the_limit_is_refused() {
        let template = template_with(&["Summary", "Write a summary."]);
        let at_limit = vec![template.clone(); usize_of!(TEMPLATE_COUNT_MAX)];
        let past_limit = vec![template; usize_of!(TEMPLATE_COUNT_MAX) + 1];

        templates_count_validate(&at_limit).unwrap();
        assert!(templates_count_validate(&past_limit).is_err());
    }

    #[test]
    fn seeds_refresh_touches_only_known_unedited_ids() {
        let mut templates = vec![
            NotesTemplate {
                id: "custom".to_owned(),
                name: "Custom".to_owned(),
                description: "d".to_owned(),
                instructions: "i".to_owned(),
                edited: false,
            },
            NotesTemplate {
                id: "default-procedure".to_owned(),
                name: "Step-by-step procedure".to_owned(),
                description: "old".to_owned(),
                instructions: INSTRUCTIONS_PROCEDURE.to_owned(),
                edited: false,
            },
        ];

        assert!(seeds_refresh(&mut templates));
        assert_eq!(templates[0].instructions, "i");
        assert_eq!(templates[0].description, "d");
        assert!(templates[1].description.starts_with("How to do a task"));
        assert!(!seeds_refresh(&mut templates));
        assert!(!seeds_refresh(&mut []));
    }

    #[test]
    fn a_template_exactly_at_its_limits_is_accepted_and_old_files_fill_in_defaults() {
        let name = "n".repeat(usize_of!(TEMPLATE_NAME_CHARS_MAX));
        let instructions = "i".repeat(usize_of!(TEMPLATE_INSTRUCTIONS_CHARS_MAX));
        let mut template = template_with(&[&name, &instructions]);

        template.description = "d".repeat(usize_of!(TEMPLATE_DESCRIPTION_CHARS_MAX));

        let raw = r#"{"id":"t","name":"T","instructions":"x"}"#;
        let restored: NotesTemplate = serde_json::from_str(raw).unwrap();

        template_validate(&template).unwrap();

        assert_eq!(restored.description, "");
        assert!(!restored.edited);
    }

    #[test]
    fn without_a_saved_file_the_seeds_are_served_and_nothing_is_written() {
        let _root = root_scoped();
        let path = workspace::root_file_path(TEMPLATES_FILE).unwrap();
        let templates = templates_load_all().unwrap();

        assert_eq!(templates.len(), default_templates_seed().len());
        assert!(!path.exists());

        let mut ids: Vec<&str> = templates.iter().map(|template| template.id.as_str()).collect();

        ids.sort_unstable();
        ids.dedup();

        assert_eq!(ids.len(), templates.len());
        assert!(templates.iter().all(|template| !template.edited));
        assert_eq!(template_load("default-summary").unwrap().instructions, INSTRUCTIONS_SUMMARY);
        assert_ne!(template_load("absent").unwrap_err().to_string(), "");
    }

    #[test]
    fn a_saved_template_is_marked_edited_and_survives_until_deleted() {
        let _root = root_scoped();
        let template = template_with(&["Mine", "Write mine."]);
        let seed_count = default_templates_seed().len();

        template_upsert(template.clone()).unwrap();

        let saved = template_load("test").unwrap();

        assert!(saved.edited);
        assert_eq!(saved.name, "Mine");
        assert_eq!(templates_load_all().unwrap().len(), seed_count + 1);

        template_upsert(NotesTemplate { name: "Renamed".to_owned(), ..template }).unwrap();

        assert_eq!(template_load("test").unwrap().name, "Renamed");
        assert_eq!(templates_load_all().unwrap().len(), seed_count + 1);

        template_delete("test").unwrap();

        assert_ne!(template_load("test").unwrap_err().to_string(), "");
        assert_eq!(templates_load_all().unwrap().len(), seed_count);
        assert!(template_upsert(template_with(&[" ", "x"])).is_err());
    }

    #[test]
    fn a_stale_unedited_seed_on_disk_is_refreshed_and_written_back() {
        let _root = root_scoped();
        let path = workspace::root_file_path(TEMPLATES_FILE).unwrap();

        let stale = vec![NotesTemplate {
            id: "default-summary".to_owned(),
            name: "Quick summary".to_owned(),
            description: "old".to_owned(),
            instructions: "old".to_owned(),
            edited: false,
        }];

        fs::write(&path, serde_json::to_string(&stale).unwrap()).unwrap();

        let templates = templates_load_all().unwrap();
        let raw = fs::read_to_string(&path).unwrap();
        let on_disk: Vec<NotesTemplate> = serde_json::from_str(&raw).unwrap();

        assert_eq!(templates.len(), 1);
        assert_eq!(templates[0].instructions, INSTRUCTIONS_SUMMARY);
        assert_eq!(on_disk[0].instructions, INSTRUCTIONS_SUMMARY);
        assert_eq!(on_disk[0].description, default_templates_seed()[1].description);
        assert!(!on_disk[0].edited);
    }

    #[test]
    fn a_saved_template_without_an_id_is_read_rather_than_crashing_the_seed_refresh() {
        let mut templates = vec![template_with(&["Summary", "x"])];

        templates[0].id = String::new();

        assert!(!seeds_refresh(&mut templates));
        assert_eq!(templates[0].instructions, "x");
    }

    #[test]
    fn a_damaged_templates_file_is_an_error_rather_than_the_seeds() {
        let _root = root_scoped();

        fs::write(workspace::root_file_path(TEMPLATES_FILE).unwrap(), b"[").unwrap();

        assert_ne!(templates_load_all().unwrap_err().to_string(), "");
        assert_ne!(template_load("default-summary").unwrap_err().to_string(), "");
        assert!(template_upsert(template_with(&["Mine", "x"])).is_err());
    }
}
