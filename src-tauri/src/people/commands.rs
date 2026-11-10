use super::storage::{
    Group,
    Person,
    group_delete,
    group_upsert,
    groups_load_all,
    people_load_all,
    person_delete,
    person_upsert,
};
use crate::blocking;
use crate::contract::RecordID;
use crate::error::AppResult;

#[tauri::command(rename_all = "snake_case")]
pub(crate) async fn group_remove(id: RecordID) -> AppResult<()> {
    blocking::run(move || group_delete(&id)).await
}

#[tauri::command(rename_all = "snake_case")]
pub(crate) async fn group_save(group: Group) -> AppResult<()> {
    blocking::run(move || group_upsert(&group)).await
}

#[tauri::command]
pub(crate) async fn groups_list() -> AppResult<Vec<Group>> {
    blocking::run(groups_load_all).await
}

#[tauri::command]
pub(crate) async fn people_list() -> AppResult<Vec<Person>> {
    blocking::run(people_load_all).await
}

#[tauri::command(rename_all = "snake_case")]
pub(crate) async fn person_remove(id: RecordID) -> AppResult<()> {
    blocking::run(move || person_delete(&id)).await
}

#[tauri::command(rename_all = "snake_case")]
pub(crate) async fn person_save(person: Person) -> AppResult<()> {
    blocking::run(move || person_upsert(&person)).await
}
