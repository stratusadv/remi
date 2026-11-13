use super::storage;
use super::types::{APIEndpoint, APIEndpointPurpose, ServiceStatus};
use crate::blocking;
use crate::contract::APIKey;
use crate::error::AppResult;

#[tauri::command]
pub(crate) async fn endpoints_list() -> AppResult<Vec<APIEndpoint>> {
    blocking::run(storage::endpoints_load_all).await
}

#[tauri::command(rename_all = "snake_case")]
pub(crate) async fn service_api_key_set(
    purpose: APIEndpointPurpose,
    api_key: APIKey,
) -> AppResult<()> {
    blocking::run(move || storage::api_key_set(purpose, &api_key)).await
}

#[tauri::command]
pub(crate) async fn service_status() -> AppResult<ServiceStatus> {
    blocking::run(storage::service_status_load).await
}
