use crate::blocking;
use crate::contract::JobID;
use crate::convert;
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::workspace;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};

const EXPORT_EXTENSION_DOCX: &str = "docx";
const EXPORT_EXTENSION_MARKDOWN: &str = "md";
const INNER_LENGTH_MAX: u32 = 24;
const INNER_LENGTH_MIN: u32 = 2;
const PAGE_BYTES_ESTIMATE: u32 = 1024;
const PRINT_FILE_NAME: &str = "print.html";

const PRINT_PAGE_STYLE: &str = r#"
:root { color-scheme: light; }
body { margin: 0; padding: 2rem; max-width: 52rem; margin-inline: auto; color: #1a1a1a;
  font: 11pt/1.5 system-ui, "Segoe UI", Roboto, sans-serif; background: #fff; }
.banner { background: #fff5d6; border: 1px solid #e0c060; border-radius: 6px; padding: 0.75rem 1rem;
  margin-bottom: 1.5rem; font-size: 10pt; }
h1 { font-size: 20pt; margin: 1.2em 0 0.4em; } h2 { font-size: 16pt; margin: 1.2em 0 0.4em; }
h3 { font-size: 13pt; margin: 1em 0 0.3em; } h4, h5, h6 { font-size: 11pt; margin: 1em 0 0.3em; }
p, ul, ol, pre, table, blockquote { margin: 0 0 0.8em; }
code { font-family: Consolas, "Courier New", monospace; font-size: 10pt;
  background: #f2f2f2; padding: 0 0.2em; }
pre { background: #f2f2f2; padding: 0.75em; overflow-x: auto; white-space: pre-wrap; }
pre code { background: none; padding: 0; }
blockquote { border-left: 3px solid #bfbfbf; margin-left: 0; padding-left: 1em; color: #404040; }
table { border-collapse: collapse; width: 100%; }
th, td { border: 1px solid #bfbfbf; padding: 0.3em 0.6em; text-align: left; vertical-align: top; }
th { background: #f2f2f2; }
hr { border: 0; border-top: 1px solid #bfbfbf; margin: 1.2em 0; }
a { color: #0563c1; }
input[type=checkbox] { vertical-align: middle; margin-right: 0.4em; }
ul:has(> li > input[type=checkbox]) { list-style: none; padding-left: 0; }
@page { margin: 2cm; }
@media print { .banner { display: none; } body { padding: 0; max-width: none; } }
"#;

const PRINT_WINDOW_HEIGHT: f64 = 1100.0;
const PRINT_WINDOW_LABEL: &str = "print";
const PRINT_WINDOW_WIDTH: f64 = 960.0;
const TIGHTENED_PUNCTUATION: &[char] = &['.', ',', ';', ':', '!', '?', ')', ']', '}'];
const TITLE_DEFAULT: &str = "Notes";

const _: () = assert!(INNER_LENGTH_MIN < INNER_LENGTH_MAX);

struct PrintPage<'text> {
    body_html: &'text str,
    title: &'text str,
}

#[tauri::command(rename_all = "snake_case")]
pub(crate) async fn notes_export(
    state: State<'_, AppState>,
    job_id: JobID,
    target_path: PathBuf,
) -> AppResult<String> {
    let written = target_path.clone();

    let exported = blocking::run(move || {
        notes_export_write_blocking(&job_id, &target_path)?;

        Ok(target_path.to_string_lossy().into_owned())
    })
    .await?;

    *export_last_lock(&state.export_last)? = Some(written);

    Ok(exported)
}

#[tauri::command(rename_all = "snake_case")]
pub(crate) async fn notes_print(app: AppHandle, job_id: JobID) -> AppResult<()> {
    let page_path = blocking::run(move || notes_print_page_write_blocking(&job_id)).await?;

    let url = tauri::Url::parse(&asset_url(&page_path))
        .map_err(|error| AppError::Export(format!("print page url: {error}")))?;

    assert_ne!(url.scheme(), "");

    if let Some(existing) = app.get_webview_window(PRINT_WINDOW_LABEL) {
        existing
            .close()
            .map_err(|error| AppError::Export(format!("could not close print window: {error}")))?;
    }

    let _window = WebviewWindowBuilder::new(&app, PRINT_WINDOW_LABEL, WebviewUrl::External(url))
        .title("Print notes")
        .inner_size(PRINT_WINDOW_WIDTH, PRINT_WINDOW_HEIGHT)
        .on_page_load(|window, payload| {
            if payload.event() != PageLoadEvent::Finished {
                return;
            }

            if let Err(error) = window.print() {
                tracing::warn!("print dialog could not be opened: {}", error);
            }
        })
        .build()
        .map_err(|error| AppError::Export(format!("could not open print window: {error}")))?;

    Ok(())
}

fn asset_url(path: &Path) -> String {
    let path_text = path.to_string_lossy();

    let encoded_bytes: Vec<String> = path_text
        .bytes()
        .map(|byte| {
            let plain = byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~');

            if plain {
                return char::from(byte).to_string();
            }

            format!("%{byte:02X}")
        })
        .collect();

    let encoded = encoded_bytes.concat();

    assert!(encoded.len() >= path_text.len());
    assert!(!encoded.contains(' '));

    if cfg!(windows) {
        format!("http://asset.localhost/{encoded}")
    } else {
        format!("asset://localhost/{encoded}")
    }
}

fn html_text_escape(text: &str) -> String {
    let escaped = text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");

    assert!(!escaped.contains('<'));
    assert!(!escaped.contains('>'));

    escaped
}

pub(crate) fn export_last_lock(
    slot: &Mutex<Option<PathBuf>>,
) -> AppResult<MutexGuard<'_, Option<PathBuf>>> {
    slot.lock()
        .map_err(|_poisoned| AppError::Export("the export state was poisoned by a crash".into()))
}

fn notes_export_write_blocking(job_id: &str, target_path: &Path) -> AppResult<()> {
    let extension = target_path
        .extension()
        .map(|extension| extension.to_string_lossy().to_lowercase())
        .unwrap_or_default();

    let markdown = notes_markdown_load(job_id)?;

    let bytes = match extension.as_str() {
        EXPORT_EXTENSION_DOCX => convert::markdown_to_docx(&markdown)?,
        EXPORT_EXTENSION_MARKDOWN => markdown.into_bytes(),
        _ => {
            return Err(AppError::Export(format!(
                "target path must end with .{EXPORT_EXTENSION_DOCX} or .{EXPORT_EXTENSION_MARKDOWN}"
            )));
        }
    };

    assert_ne!(bytes.len(), 0);

    if let Some(parent) = target_path.parent() {
        fs::create_dir_all(parent)?;
    }

    fs::write(target_path, &bytes)?;

    Ok(())
}

fn notes_markdown_load(job_id: &str) -> AppResult<String> {
    assert_ne!(job_id, "");

    let markdown = workspace::notes_load(job_id)?
        .ok_or_else(|| AppError::Export(format!("no notes found for job {job_id}")))?;

    if markdown.trim().is_empty() {
        return Err(AppError::Export("notes are empty".into()));
    }

    let stripped = timestamps_strip(&markdown);

    assert!(stripped.len() <= markdown.len());

    if stripped.is_empty() {
        return Err(AppError::Export("notes are empty".into()));
    }

    Ok(stripped)
}

fn notes_print_page_write_blocking(job_id: &str) -> AppResult<PathBuf> {
    let markdown = notes_markdown_load(job_id)?;
    let body_html = convert::markdown_to_html(&markdown)?;

    let title = workspace::meta_load(job_id)?
        .and_then(|meta| meta.title)
        .filter(|title| !title.trim().is_empty())
        .unwrap_or_else(|| TITLE_DEFAULT.to_owned());

    let page = print_page_html(&PrintPage { body_html: &body_html, title: &title });
    let path = workspace::job_directory(job_id)?.join(PRINT_FILE_NAME);

    assert!(page.starts_with("<!doctype html>"));

    workspace::atomic_write(&path, page.as_bytes())?;

    assert!(path.ends_with(PRINT_FILE_NAME));

    Ok(path)
}

fn print_page_html(page_parts: &PrintPage<'_>) -> String {
    let PrintPage { body_html, title } = *page_parts;
    let capacity = body_html.len() + PRINT_PAGE_STYLE.len() + usize_of!(PAGE_BYTES_ESTIMATE);
    let mut page = String::with_capacity(capacity);

    page.push_str("<!doctype html><html><head><meta charset=\"utf-8\"><title>");
    page.push_str(&html_text_escape(title));
    page.push_str("</title><style>");
    page.push_str(PRINT_PAGE_STYLE);
    page.push_str("</style></head><body><div class=\"banner\">");
    page.push_str("The print dialog opens with this page. Choose ");
    page.push_str("\u{201c}Save as PDF\u{201d} as the printer to save a PDF file, ");
    page.push_str("then close this window.");
    page.push_str("</div>");
    page.push_str(body_html);
    page.push_str("</body></html>");

    assert!(page.len() > body_html.len());
    assert!(page.ends_with("</html>"));

    page
}

fn timestamp_match_at(chars: &[char], index: usize) -> Option<usize> {
    assert!(index < chars.len());

    if *chars.get(index)? != '[' {
        return None;
    }

    let inner_start = index + 1;
    let mut has_colon = false;
    let mut has_digit_or_marker = false;
    let inner = chars.iter().enumerate().skip(inner_start).take(usize_of!(INNER_LENGTH_MAX) + 1);

    for (offset, character) in inner {
        if *character == ']' {
            if !has_colon {
                return None;
            }

            if !has_digit_or_marker {
                return None;
            }

            let inner_length = offset - inner_start;

            if !(usize_of!(INNER_LENGTH_MIN)..=usize_of!(INNER_LENGTH_MAX)).contains(&inner_length)
            {
                return None;
            }

            assert!(offset + 1 > index);
            assert!(offset < chars.len());

            return Some(offset + 1);
        }

        match *character {
            ':' => has_colon = true,
            'm' | 's' | 'h' | 'M' | 'S' | 'H' => has_digit_or_marker = true,
            '-' | '\u{2013}' | '\u{2014}' | ',' | ' ' | '.' => {}
            digit if digit.is_ascii_digit() => has_digit_or_marker = true,
            _ => return None,
        }
    }

    None
}

fn timestamps_strip(markdown: &str) -> String {
    let chars: Vec<char> = markdown.chars().collect();
    let mut without_timestamps = String::with_capacity(markdown.len());
    let mut index = 0;

    while let Some(&character) = chars.get(index) {
        if let Some(end_index) = timestamp_match_at(&chars, index) {
            assert!(end_index > index);

            let at_line_start = index == 0 || chars.get(index - 1) == Some(&'\n');

            index = end_index;

            if at_line_start {
                while chars.get(index) == Some(&' ') {
                    index += 1;
                }

                continue;
            }

            without_timestamps.push(' ');

            continue;
        }

        without_timestamps.push(character);
        index += 1;
    }

    assert_eq!(index, chars.len());

    let collapsed = timestamps_strip_spaces_collapse(&without_timestamps);
    let tightened = timestamps_strip_punctuation_tighten(&collapsed);
    let trimmed = timestamps_strip_line_ends(&tightened);

    assert!(trimmed.len() <= without_timestamps.len());

    trimmed
}

fn timestamps_strip_line_ends(text: &str) -> String {
    let mut trimmed = String::with_capacity(text.len());

    for line in text.split_inclusive('\n') {
        let (body, newline) = line.strip_suffix('\n').map_or((line, ""), |rest| (rest, "\n"));

        trimmed.push_str(body.trim_end_matches([' ', '\t']));
        trimmed.push_str(newline);
    }

    assert!(trimmed.len() <= text.len());
    assert_eq!(trimmed.matches('\n').count(), text.matches('\n').count());

    trimmed
}

fn timestamps_strip_punctuation_tighten(text: &str) -> String {
    let mut tightened = String::with_capacity(text.len());
    let mut remaining = text.chars().peekable();
    let mut previous = '\n';
    let mut line_indent_open = true;

    for _character_index in 0..text.len() {
        let Some(character) = remaining.next() else {
            break;
        };

        let space_before_punctuation = character == ' '
            && !line_indent_open
            && remaining.peek().is_some_and(|next| TIGHTENED_PUNCTUATION.contains(next));

        if space_before_punctuation {
            let task_marker_space = previous == '[' && remaining.peek() == Some(&']');

            if task_marker_space {
                tightened.push(character);
            }
        } else {
            tightened.push(character);
        }

        line_indent_open =
            character == '\n' || (line_indent_open && matches!(character, ' ' | '\t'));

        previous = character;
    }

    assert!(tightened.len() <= text.len());
    assert!(tightened.lines().all(|line| !line.trim_start().contains(" .")));
    assert!(tightened.lines().all(|line| !line.trim_start().contains(" ,")));

    tightened
}

fn timestamps_strip_spaces_collapse(text: &str) -> String {
    let mut collapsed = String::with_capacity(text.len());
    let mut line_indent_open = true;
    let mut space_horizontal_open = false;

    for character in text.chars() {
        if !matches!(character, ' ' | '\t') {
            collapsed.push(character);
            line_indent_open = character == '\n';
            space_horizontal_open = false;

            continue;
        }

        if line_indent_open {
            collapsed.push(character);

            continue;
        }

        if !space_horizontal_open {
            collapsed.push(' ');
        }

        space_horizontal_open = true;
    }

    assert!(collapsed.len() <= text.len());
    assert!(collapsed.lines().all(|line| !line.trim_start().contains("  ")));

    collapsed
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::test_support::{meta_with, root_scoped};

    #[test]
    fn timestamp_markers_are_removed_and_spacing_is_tidied() {
        let stripped =
            timestamps_strip("Budget approved [1:23] by Dana (12:04).\nNext item [0:07] .\n");

        assert_eq!(stripped, "Budget approved by Dana (12:04).\nNext item.\n");
    }

    #[test]
    fn a_nested_list_keeps_its_nesting_in_an_export() {
        let notes = "- Launch moves [1:23]\n  - Tell support\n    - Tell sales\n- Budget stays\n";

        assert_eq!(
            timestamps_strip(notes),
            "- Launch moves\n  - Tell support\n    - Tell sales\n- Budget stays\n",
        );

        assert_eq!(
            timestamps_strip("```\n    }\n    . dot\n```\n"),
            "```\n    }\n    . dot\n```\n",
        );
    }

    #[test]
    fn a_real_time_or_ratio_in_round_brackets_survives_an_export() {
        let notes = "The standup moves to (9:30) and the split stays (3:1).\n";

        assert_eq!(timestamps_strip(notes), notes);
    }

    #[test]
    fn a_marker_at_the_start_of_a_line_leaves_no_leading_space() {
        assert_eq!(timestamps_strip("[0:00] Hello\n"), "Hello\n");
        assert_eq!(timestamps_strip("Intro\n[0:07] Second line\n"), "Intro\nSecond line\n");
        assert_eq!(timestamps_strip("- [0:00] Hello\n"), "- Hello\n");
    }

    #[test]
    fn task_markers_keep_their_space() {
        assert_eq!(timestamps_strip("- [ ] todo [0:07]\n- [x] done\n"), "- [ ] todo\n- [x] done\n");
    }

    #[test]
    fn text_without_markers_survives_untouched() {
        assert_eq!(timestamps_strip("Plain [note] here.\n"), "Plain [note] here.\n");
    }

    #[test]
    fn a_bracket_that_runs_on_too_long_is_not_a_marker() {
        let long = format!("[{}:00] end", "1".repeat(40));

        assert_eq!(timestamps_strip(&long), long);

        let deep = "[1:00:00:00:00:00:00:00:00:00:00] x";

        assert_eq!(timestamps_strip(deep), deep);
    }

    #[test]
    fn markup_characters_in_a_title_are_escaped() {
        assert_eq!(html_text_escape("a <b> & c"), "a &lt;b&gt; &amp; c");
    }

    #[test]
    fn timestamps_of_every_supported_shape_are_removed_and_lookalikes_are_kept() {
        assert_eq!(timestamps_strip("a [1:02:03] b\n"), "a b\n");
        assert_eq!(timestamps_strip("a (0:07) b\n"), "a (0:07) b\n");
        assert_eq!(timestamps_strip("a [1:23\u{2013}1:45] b\n"), "a b\n");
        assert_eq!(timestamps_strip("a [1:23 - 1:45] b\n"), "a b\n");
        assert_eq!(timestamps_strip("a\t\t[1:00]\tb"), "a b");
        assert_eq!(timestamps_strip("## Recap [0:10]\n- [0:00] Hello\n"), "## Recap\n- Hello\n");
        assert_eq!(timestamps_strip("\u{e9} [1:00] \u{fc}"), "\u{e9} \u{fc}");
        assert_eq!(timestamps_strip("a [12m 30s] b\n"), "a [12m 30s] b\n");
        assert_eq!(timestamps_strip("a [a:b] b\n"), "a [a:b] b\n");
        assert_eq!(timestamps_strip("a [:] b\n"), "a [:] b\n");
        assert_eq!(timestamps_strip("a [1:23 b\n"), "a [1:23 b\n");
        assert_eq!(timestamps_strip(""), "");
    }

    #[test]
    fn runs_of_horizontal_space_collapse_and_line_ends_are_trimmed() {
        assert_eq!(timestamps_strip_spaces_collapse("a \t  b\n\n  c"), "a b\n\n  c");
        assert_eq!(timestamps_strip_spaces_collapse(""), "");
        assert_eq!(timestamps_strip_line_ends("a  \nb\t\n\nc "), "a\nb\n\nc");
        assert_eq!(timestamps_strip_line_ends("no newline  "), "no newline");
        assert_eq!(timestamps_strip_line_ends(""), "");
    }

    #[test]
    fn punctuation_is_tightened_against_the_word_before_it_except_inside_a_task_marker() {
        assert_eq!(timestamps_strip_punctuation_tighten("a , b ; c ) d ? e !"), "a, b; c) d? e!");
        assert_eq!(timestamps_strip_punctuation_tighten("- [ ] todo"), "- [ ] todo");
        assert_eq!(timestamps_strip_punctuation_tighten("x ] y"), "x] y");
        assert_eq!(timestamps_strip_punctuation_tighten("\u{e9} ."), "\u{e9}.");
        assert_eq!(timestamps_strip_punctuation_tighten(""), "");
    }

    #[test]
    fn the_print_page_wraps_the_body_with_an_escaped_title() {
        let page = print_page_html(&PrintPage { body_html: "<h1>Body</h1>", title: "A & <B>" });

        assert!(page.starts_with("<!doctype html>"));
        assert!(page.contains("<title>A &amp; &lt;B&gt;</title>"));
        assert!(page.contains("<h1>Body</h1>"));
        assert!(page.ends_with("</body></html>"));
        assert_eq!(html_text_escape(""), "");
        assert_eq!(html_text_escape("\"quoted\" 'single'"), "\"quoted\" 'single'");
    }

    #[test]
    fn an_asset_url_percent_encodes_every_byte_outside_the_unreserved_set() {
        let url = asset_url(Path::new("/tmp/my notes/\u{e9}~1.html"));
        let prefix = if cfg!(windows) { "http://asset.localhost/" } else { "asset://localhost/" };

        assert_eq!(url, format!("{prefix}%2Ftmp%2Fmy%20notes%2F%C3%A9~1.html"));
        assert_eq!(asset_url(Path::new("")), prefix);
    }

    #[test]
    fn notes_export_writes_markdown_or_docx_by_extension_and_refuses_the_rest() {
        let _root = root_scoped();
        let id = workspace::job_id_from_text("export");
        let target = workspace::root().unwrap().join("out");

        assert!(notes_export_write_blocking(&id, &target.join("notes.md")).is_err());

        workspace::notes_save(&id, b"Budget approved [1:23].\n").unwrap();
        notes_export_write_blocking(&id, &target.join("notes.md")).unwrap();
        notes_export_write_blocking(&id, &target.join("notes.DOCX")).unwrap();

        assert_eq!(fs::read_to_string(target.join("notes.md")).unwrap(), "Budget approved.\n");
        assert!(fs::read(target.join("notes.DOCX")).unwrap().starts_with(b"PK\x03\x04"));
        assert!(notes_export_write_blocking(&id, &target.join("notes.pdf")).is_err());
        assert!(notes_export_write_blocking(&id, &target.join("notes")).is_err());

        workspace::notes_save(&id, b"  \n").unwrap();

        assert!(notes_export_write_blocking(&id, &target.join("notes.md")).is_err());
    }

    #[test]
    fn notes_holding_nothing_but_a_timestamp_are_refused_rather_than_written_empty() {
        let _root = root_scoped();
        let id = workspace::job_id_from_text("timestamp-only");
        let target = workspace::root().unwrap().join("out").join("notes.md");

        workspace::notes_save(&id, b"[1:23]").unwrap();

        assert!(notes_export_write_blocking(&id, &target).is_err());
        assert!(!target.exists());
    }

    #[test]
    fn the_print_page_lands_in_the_job_folder_titled_from_its_metadata() {
        let _root = root_scoped();
        let id = workspace::job_id_from_text("print");

        assert_ne!(notes_print_page_write_blocking(&id).unwrap_err().to_string(), "");

        workspace::notes_save(&id, b"# Agenda\n\nHello [0:01].\n").unwrap();

        let path = notes_print_page_write_blocking(&id).unwrap();
        let untitled = fs::read_to_string(&path).unwrap();

        assert_eq!(path, workspace::job_directory(&id).unwrap().join(PRINT_FILE_NAME));
        assert!(untitled.contains("<title>Notes</title>"));
        assert!(untitled.contains("Agenda"));
        assert!(untitled.contains("Hello."));

        let mut meta = meta_with(&id, 1);

        meta.title = Some("  ".to_owned());
        workspace::meta_save(&meta).unwrap();

        let blank = fs::read_to_string(notes_print_page_write_blocking(&id).unwrap()).unwrap();

        assert!(blank.contains("<title>Notes</title>"));

        meta.title = Some("Q3 <Review>".to_owned());
        workspace::meta_save(&meta).unwrap();

        let titled = fs::read_to_string(notes_print_page_write_blocking(&id).unwrap()).unwrap();

        assert!(titled.contains("<title>Q3 &lt;Review&gt;</title>"));
    }
}
