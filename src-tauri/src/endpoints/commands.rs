use super::storage;
use super::types::APIEndpoint;
use crate::blocking;
use crate::error::AppResult;

#[tauri::command]
pub(crate) async fn endpoints_list() -> AppResult<Vec<APIEndpoint>> {
    blocking::run(storage::endpoints_load_all).await
}
