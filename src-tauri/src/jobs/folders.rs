use crate::blocking;
use crate::contract::{FolderName, FolderRename};
use crate::error::{AppError, AppResult};
use crate::search::PROJECT_CHARS_MAX;
use crate::workspace::{self, JOB_COUNT_MAX, JobMeta, JobMetaPatch};
use std::collections::BTreeSet;

const FOLDER_COUNT_MAX: u32 = 512;
const FOLDER_ENTRY_BYTES_MAX: u32 = FOLDER_NAME_CHARS_MAX * UTF8_BYTES_PER_CHAR_MAX + 16;
const FOLDER_NAME_CHARS_MAX: u32 = 120;
const FOLDERS_FILE: &str = "folders.json";
const FOLDERS_FILE_BYTES_MAX: u32 = 1 << 20;
const UTF8_BYTES_PER_CHAR_MAX: u32 = 4;

const _: () = assert!(FOLDER_NAME_CHARS_MAX <= PROJECT_CHARS_MAX);
const _: () = assert!(FOLDER_COUNT_MAX * FOLDER_ENTRY_BYTES_MAX <= FOLDERS_FILE_BYTES_MAX);

#[tauri::command(rename_all = "snake_case")]
pub(crate) async fn folder_create(name: FolderName) -> AppResult<()> {
    blocking::run(move || folder_add(&name)).await
}

pub(crate) fn folder_key(name: &str) -> String {
    let key = name.trim().to_lowercase();

    assert_eq!(key, key.trim());
    assert_eq!(key.is_empty(), name.trim().is_empty());

    key
}

pub(crate) fn folder_name_validate(name: &str) -> AppResult<()> {
    if name.is_empty() {
        return Err(AppError::Config("a folder needs a name".into()));
    }

    if name.trim() != name {
        return Err(AppError::Config(format!(
            "the folder name \"{name}\" starts or ends with a space",
        )));
    }

    if name.chars().count() > usize_of!(FOLDER_NAME_CHARS_MAX) {
        return Err(AppError::Config(format!(
            "a folder name is at most {FOLDER_NAME_CHARS_MAX} characters",
        )));
    }

    if name.chars().any(char::is_control) {
        return Err(AppError::Config("a folder name is one line of plain text".into()));
    }

    assert_ne!(name.trim(), "");

    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub(crate) async fn folder_remove(name: FolderName) -> AppResult<()> {
    blocking::run(move || folder_drop(&name)).await
}

#[tauri::command(rename_all = "snake_case")]
pub(crate) async fn folder_rename(rename: FolderRename) -> AppResult<()> {
    blocking::run(move || folder_move(&rename)).await
}

#[tauri::command]
pub(crate) async fn folders_list() -> AppResult<Vec<String>> {
    blocking::run(folders_load).await
}

fn folder_add(name: &str) -> AppResult<()> {
    assert_eq!(name, name.trim());

    let mut folders = folders_load()?;
    let key = folder_key(name);

    if folders.iter().map(String::as_str).map(folder_key).any(|saved| saved == key) {
        return Err(AppError::Config(format!("a folder named \"{name}\" already exists")));
    }

    folders.push(name.to_owned());
    folders_save(&folders)?;

    assert!(folders.iter().any(|saved| saved == name));

    Ok(())
}

fn folder_drop(name: &str) -> AppResult<()> {
    assert_eq!(name, name.trim());

    let key = folder_key(name);
    let refiled = meetings_refile(&key, None)?;
    let mut folders = folders_load()?;
    let folder_count_before = folders.len();

    folders.retain(|saved| folder_key(saved) != key);

    assert!(refiled <= JOB_COUNT_MAX);
    assert!(folders.len() <= folder_count_before);

    if folders.len() == folder_count_before {
        return Ok(());
    }

    folders_save(&folders)
}

fn folder_move(rename: &FolderRename) -> AppResult<()> {
    let target: &str = &rename.to;
    let key_source = folder_key(&rename.from);
    let key_target = folder_key(target);
    let refiled = meetings_refile(&key_source, Some(target))?;
    let mut folders = folders_load()?;

    folders.retain(|saved| ![&key_source, &key_target].contains(&&folder_key(saved)));
    folders.push(target.to_owned());

    assert!(refiled <= JOB_COUNT_MAX);
    assert_eq!(folders.iter().filter(|saved| folder_key(saved) == key_target).count(), 1);

    folders_save(&folders)
}

fn folders_load() -> AppResult<Vec<String>> {
    let path = workspace::root_file_path(FOLDERS_FILE)?;

    if !path.exists() {
        return Ok(Vec::new());
    }

    let raw = workspace::file_read_bounded(&path, FOLDERS_FILE_BYTES_MAX)?;

    let folders: Vec<String> = serde_json::from_str(&raw).map_err(|error| {
        AppError::Config(format!("the saved folders could not be read: {error}"))
    })?;

    folders_validate(&folders)?;

    assert!(folders.len() <= usize_of!(FOLDER_COUNT_MAX));

    Ok(folders)
}

fn folders_save(folders: &[String]) -> AppResult<()> {
    folders_validate(folders)?;

    let path = workspace::root_file_path(FOLDERS_FILE)?;
    let encoded = serde_json::to_string_pretty(folders)?;

    assert!(encoded.len() <= usize_of!(FOLDERS_FILE_BYTES_MAX));
    assert!(path.ends_with(FOLDERS_FILE));

    workspace::atomic_write(&path, encoded.as_bytes())
}

fn folders_validate(folders: &[String]) -> AppResult<()> {
    if folders.len() > usize_of!(FOLDER_COUNT_MAX) {
        return Err(AppError::Config(format!(
            "there are {} folders, over the {FOLDER_COUNT_MAX} this app keeps",
            folders.len(),
        )));
    }

    for folder in folders {
        folder_name_validate(folder)?;
    }

    let keys: BTreeSet<String> = folders.iter().map(String::as_str).map(folder_key).collect();

    if keys.len() != folders.len() {
        return Err(AppError::Config("the saved folders name one folder twice".into()));
    }

    assert!(keys.iter().all(|key| !key.is_empty()));

    Ok(())
}

fn meeting_in_folder(meta: &JobMeta, key: &str) -> bool {
    assert_ne!(key, "");
    assert_ne!(meta.id, "");

    meta.project.as_deref().is_some_and(|project| folder_key(project) == key)
}

fn meetings_refile(key: &str, folder: Option<&str>) -> AppResult<u32> {
    let project = folder.unwrap_or_default();

    assert_ne!(key, "");
    assert_eq!(project, project.trim());

    let mut refiled: u32 = 0;

    for meta in workspace::jobs_list_all()? {
        if !meeting_in_folder(&meta, key) {
            continue;
        }

        let patch = JobMetaPatch { project: Some(project.to_owned()), ..JobMetaPatch::default() };
        let patched = workspace::meta_apply_patch(&meta.id, patch)?;

        assert_eq!(patched.project.as_deref().unwrap_or_default(), project);

        refiled += 1;
    }

    Ok(refiled)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::search::test_support::job_saved;
    use crate::search::{Scope, excerpts_whole};
    use crate::workspace::test_support::root_scoped;
    use serde_json::json;
    use std::fs;

    fn filed(ids: &[&str], project: &str) {
        assert!(ids.iter().all(|id| workspace::job_id_is_valid(id)));

        for id in ids {
            let patch = JobMetaPatch { project: Some(project.to_owned()), ..JobMetaPatch::empty() };
            let patched = workspace::meta_apply_patch(id, patch).unwrap();

            assert_eq!(patched.project.as_deref(), Some(project.trim()));
        }
    }

    fn folder_of(id: &str) -> String {
        assert!(workspace::job_id_is_valid(id));

        let meta = workspace::meta_load(id).unwrap().unwrap();

        assert_eq!(meta.id, id);

        meta.project.unwrap_or_default()
    }

    fn meetings_found(project: &str) -> Vec<String> {
        assert_ne!(project.trim(), "");

        let scope = Scope::Project { project: project.to_owned() };
        let excerpts = excerpts_whole(&scope).unwrap().unwrap();
        let found: BTreeSet<String> = excerpts.into_iter().map(|excerpt| excerpt.job_id).collect();

        assert!(found.iter().all(|id| workspace::job_id_is_valid(id)));

        found.into_iter().collect()
    }

    fn meeting_with_notes(title: &str, held_at_unix: i64) -> String {
        assert!(held_at_unix > 0);

        let id = job_saved(title, held_at_unix);

        workspace::notes_save(&id, b"The invoice review moved to Friday.").unwrap();

        assert!(workspace::job_id_is_valid(&id));

        id
    }

    fn name(text: &str) -> FolderName {
        let parsed: FolderName = serde_json::from_value(json!(text)).unwrap();

        assert_eq!(&*parsed, text.trim());

        parsed
    }

    fn rename(names: serde_json::Value) -> FolderRename {
        assert!(names.is_object());

        let to =
            names.get("to").and_then(serde_json::Value::as_str).map(str::trim).map(str::to_owned);
        let parsed: FolderRename = serde_json::from_value(names).unwrap();

        assert_eq!(Some(&*parsed.to), to.as_deref());

        parsed
    }

    fn saved_raw(folders: &serde_json::Value) {
        assert!(folders.is_array());

        let path = workspace::root_file_path(FOLDERS_FILE).unwrap();

        fs::write(&path, serde_json::to_vec(folders).unwrap()).unwrap();

        assert!(path.exists());
    }

    #[test]
    fn a_folder_is_kept_once_whatever_its_case_and_stays_while_empty() {
        let _root = root_scoped();

        folder_add(&name("Acme")).unwrap();

        let repeated = folder_add(&name("  acme ")).unwrap_err();

        folder_add(&name("Hiring")).unwrap();

        assert!(repeated.to_string().contains("already exists"));
        assert_eq!(folders_load().unwrap(), ["Acme", "Hiring"]);
        assert_eq!(workspace::jobs_list_all().unwrap().len(), 0);
    }

    #[test]
    fn renaming_a_folder_moves_each_of_its_meetings_and_the_search_follows() {
        let _root = root_scoped();
        let alpha = meeting_with_notes("Alpha", 2);
        let beta = meeting_with_notes("Beta", 1);
        let gamma = meeting_with_notes("Gamma", 3);
        let delta = meeting_with_notes("Delta", 4);

        assert_eq!(folder_of(&delta), "");

        folder_add(&name("Acme")).unwrap();
        filed(&[&alpha], "Acme");
        filed(&[&beta], "acme");
        filed(&[&gamma], "Other");

        let moved_before = meetings_found("Acme");

        folder_move(&rename(json!({ "from": "ACME", "to": "Acme Mining" }))).unwrap();

        let mut wanted = vec![alpha.clone(), beta.clone()];

        wanted.sort();

        assert_eq!(moved_before, wanted);
        assert_eq!(folder_of(&alpha), "Acme Mining");
        assert_eq!(folder_of(&beta), "Acme Mining");
        assert_eq!(folder_of(&gamma), "Other");
        assert_eq!(folder_of(&delta), "");
        assert_eq!(folders_load().unwrap(), ["Acme Mining"]);
        assert_eq!(meetings_found("acme mining"), wanted);
        assert_eq!(meetings_found("Acme"), Vec::<String>::new());
        assert_eq!(workspace::jobs_list_all().unwrap().len(), 4);
    }

    #[test]
    fn renaming_a_folder_to_another_case_keeps_one_folder() {
        let _root = root_scoped();
        let alpha = meeting_with_notes("Alpha", 2);

        folder_add(&name("acme")).unwrap();
        filed(&[&alpha], "acme");
        folder_move(&rename(json!({ "from": "acme", "to": "Acme" }))).unwrap();

        assert_eq!(folders_load().unwrap(), ["Acme"]);
        assert_eq!(folder_of(&alpha), "Acme");
    }

    #[test]
    fn deleting_a_folder_keeps_its_meetings_outside_any_folder() {
        let _root = root_scoped();
        let alpha = meeting_with_notes("Alpha", 2);
        let beta = meeting_with_notes("Beta", 1);
        let gamma = meeting_with_notes("Gamma", 3);

        folder_add(&name("Acme")).unwrap();
        folder_add(&name("Hiring")).unwrap();
        filed(&[&alpha], "Acme");
        filed(&[&beta], "ACME");
        filed(&[&gamma], "Hiring");
        folder_drop(&name("acme")).unwrap();

        assert_eq!(folder_of(&alpha), "");
        assert_eq!(folder_of(&beta), "");
        assert_eq!(folder_of(&gamma), "Hiring");
        assert_eq!(folders_load().unwrap(), ["Hiring"]);
        assert_eq!(meetings_found("Acme"), Vec::<String>::new());
        assert_eq!(workspace::jobs_list_all().unwrap().len(), 3);

        folder_drop(&name("Acme")).unwrap();
        folder_drop(&name("Never made")).unwrap();

        assert_eq!(folders_load().unwrap(), ["Hiring"]);
    }

    #[test]
    fn a_folder_name_is_refused_when_blank_too_long_or_more_than_one_line() {
        let longest = "\u{e9}".repeat(120);
        let parsed = name(&longest);
        let refused = ["", "   ", "two\nlines", "tab\there", &"x".repeat(121)];

        for text in refused {
            let error = serde_json::from_value::<FolderName>(json!(text)).unwrap_err();

            assert_ne!(error.to_string(), "");
        }

        assert_eq!(parsed.chars().count(), 120);
        assert_eq!(&*name("  Acme Mining  "), "Acme Mining");
        assert_ne!(folder_name_validate(" Acme").unwrap_err().to_string(), "");

        folder_name_validate("Acme").unwrap();
    }

    #[test]
    fn the_saved_folders_are_refused_when_unreadable_repeated_or_past_the_limit() {
        let _root = root_scoped();
        let path = workspace::root_file_path(FOLDERS_FILE).unwrap();

        fs::write(&path, b"nope").unwrap();

        let unreadable = folders_load().unwrap_err();

        saved_raw(&json!(["Acme", " acme"]));

        let spaced = folders_load().unwrap_err();

        saved_raw(&json!(["Acme", "ACME"]));

        let repeated = folders_load().unwrap_err();
        let full: Vec<String> =
            (0..FOLDER_COUNT_MAX).map(|index| format!("Folder {index}")).collect();

        saved_raw(&json!(full));

        let listed = folders_load().unwrap();
        let past = folder_add(&name("One more")).unwrap_err();

        assert!(unreadable.to_string().contains("could not be read"));
        assert!(spaced.to_string().contains("starts or ends with a space"));
        assert!(repeated.to_string().contains("one folder twice"));
        assert_eq!(listed.len(), usize_of!(FOLDER_COUNT_MAX));
        assert!(past.to_string().contains("over the 512"));
    }
}
