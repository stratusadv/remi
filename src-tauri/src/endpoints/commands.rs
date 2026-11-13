use super::storage;
use super::types::{APIEndpoint, APIEndpointPurpose, ServiceStatus};
use crate::blocking;
use crate::contract::APIKey;
use crate::error::AppResult;
use crate::search::vector;

#[tauri::command]
pub(crate) async fn endpoints_list() -> AppResult<Vec<APIEndpoint>> {
    blocking::run(storage::endpoints_load_all).await
}

#[tauri::command(rename_all = "snake_case")]
pub(crate) async fn service_api_key_set(
    purpose: APIEndpointPurpose,
    api_key: APIKey,
) -> AppResult<()> {
    blocking::run(move || storage::api_key_set(purpose, &api_key))
        .await
        .inspect(|()| vector::worker_wake())
}

#[tauri::command]
pub(crate) async fn service_status() -> AppResult<ServiceStatus> {
    blocking::run(storage::service_status_load).await
}
