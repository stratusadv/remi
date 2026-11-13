use super::{Settings, settings_load, settings_save};
use crate::blocking;
use crate::error::AppResult;
use crate::search::vector;

#[tauri::command]
pub(crate) async fn settings_get() -> AppResult<Settings> {
    blocking::run(settings_load).await
}

#[tauri::command(rename_all = "snake_case")]
pub(crate) async fn settings_update(settings: Settings) -> AppResult<()> {
    blocking::run(move || settings_save(&settings)).await.inspect(|()| vector::worker_wake())
}
