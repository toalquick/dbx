use dbx_core::ai::copilot_auth::{CopilotDeviceAuthorization, CopilotDevicePoll, CopilotUser};

/// Kick off GitHub's OAuth device flow for the Copilot AI provider.
#[tauri::command]
pub async fn copilot_device_start() -> Result<CopilotDeviceAuthorization, String> {
    dbx_core::ai::copilot_auth::copilot_device_start().await
}

/// One device-flow poll; the frontend drives the loop so it can cancel.
#[tauri::command]
pub async fn copilot_device_poll(device_code: String, interval_secs: u64) -> Result<CopilotDevicePoll, String> {
    dbx_core::ai::copilot_auth::copilot_device_poll(&device_code, interval_secs).await
}

/// "Signed in as …" for a stored device-flow token (settings dialog reopen).
#[tauri::command]
pub async fn copilot_current_user(access_token: String) -> Result<CopilotUser, String> {
    dbx_core::ai::copilot_auth::copilot_current_user(&access_token).await
}
