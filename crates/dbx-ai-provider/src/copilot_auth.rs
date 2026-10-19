//! GitHub sign-in for the Copilot AI provider.
//!
//! Copilot's chat API does not accept personal access tokens. It wants a
//! short-lived (~30 min) session token that GitHub only mints for its own
//! editor clients after an OAuth device flow — the same handshake Zed,
//! copilot.vim, and LiteLLM use. The stored `api_key` therefore holds the
//! long-lived `gho_` OAuth token from the device flow, and every request-time
//! entry point in [`crate::ai`] calls [`apply_copilot_auth`] to swap in a
//! fresh session token (cached per `gho_` token until shortly before expiry).

use std::collections::HashMap;
use std::sync::{OnceLock, RwLock};

use serde::Serialize;
use serde_json::Value;

use crate::ai::{AiConfig, AiProvider};

/// Public client ID of the VS Code Copilot extension (public client, no
/// secret) — the de-facto client third-party Copilot integrations use.
const COPILOT_CLIENT_ID: &str = "Iv1.b507a08c87ecfe98";
const COPILOT_DEVICE_CODE_URL: &str = "https://github.com/login/device/code";
const COPILOT_DEVICE_TOKEN_URL: &str = "https://github.com/login/oauth/access_token";
const COPILOT_TOKEN_EXCHANGE_URL: &str = "https://api.github.com/copilot_internal/v2/token";
const COPILOT_USER_URL: &str = "https://api.github.com/user";
/// Copilot's gateway inspects these to route the request; LiteLLM and the
/// editor extensions send the same shape. `pub(crate)` so the request-time
/// header builder in `ai.rs` sends the identical values.
pub(crate) const COPILOT_EDITOR_VERSION: &str = "vscode/1.85.1";
pub(crate) const COPILOT_EDITOR_PLUGIN_VERSION: &str = "copilot/1.155.0";
pub(crate) const COPILOT_USER_AGENT: &str = "GithubCopilot/1.155.0";
const COPILOT_DEVICE_GRANT_TYPE: &str = "urn:ietf:params:oauth:grant-type:device_code";
/// Refresh this many seconds before `expires_at` so a request never starts on
/// a token that dies mid-flight.
const COPILOT_REFRESH_MARGIN_SECS: u64 = 300;
const COPILOT_DEVICE_CLIENT_TIMEOUT_SECS: u64 = 20;
const MIN_DEVICE_POLL_INTERVAL_SECS: u64 = 5;
/// The endpoint GitHub's own clients fall back to when the exchange response
/// does not name one (e.g. enterprise customers get their own host).
const COPILOT_FALLBACK_API_ENDPOINT: &str = "https://api.githubcopilot.com";

/// Device-flow kickoff response; the frontend shows `user_code` and opens
/// `verification_uri`, then polls every `interval_secs`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopilotDeviceAuthorization {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub interval_secs: u64,
    pub expires_in_secs: u64,
}

/// One device-flow poll result (the frontend drives the loop so it can cancel).
/// `rename_all` on an enum only renames the variants (the tag values), not the
/// struct-variant fields — `rename_all_fields` is what puts `access_token` on
/// the wire as `accessToken` for the frontend discriminated union.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "status")]
pub enum CopilotDevicePoll {
    /// Not decided yet; wait `interval_secs` (already includes `slow_down`
    /// backoff) and poll again.
    Pending { interval_secs: u64 },
    Success { access_token: String },
    Expired,
    Denied { reason: Option<String> },
}

/// A Copilot session token plus where to use it. Deliberately no `Debug`:
/// `token` is a live credential and must not leak into logs.
#[derive(Clone)]
struct CopilotSessionToken {
    token: String,
    expires_at: u64,
    api_endpoint: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopilotUser {
    pub login: String,
}

fn copilot_error(message: impl Into<String>) -> String {
    format!("GitHub Copilot authentication failed: {}", message.into())
}

/// Classic (`ghp_…`) and fine-grained (`github_pat_…`) personal access tokens.
/// Copilot's API rejects both — only device-flow `gho_` tokens work.
fn is_pat_token(token: &str) -> bool {
    let token = token.trim();
    token.starts_with("ghp_") || token.starts_with("github_pat_")
}

fn now_unix_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn session_expired(expires_at: u64) -> bool {
    now_unix_secs().saturating_add(COPILOT_REFRESH_MARGIN_SECS) >= expires_at
}

fn api_endpoint_from(value: &Value) -> String {
    let endpoint = value
        .get("endpoints")
        .and_then(|endpoints| endpoints.get("api"))
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("")
        .trim_end_matches('/');
    if endpoint.is_empty() {
        COPILOT_FALLBACK_API_ENDPOINT.to_string()
    } else {
        endpoint.to_string()
    }
}

/// Map a device-token-endpoint JSON body onto the poll state machine.
fn classify_device_poll(value: &Value, current_interval: u64) -> Result<CopilotDevicePoll, String> {
    if let Some(access_token) = value.get("access_token").and_then(Value::as_str).filter(|token| !token.trim().is_empty()) {
        return Ok(CopilotDevicePoll::Success {
            access_token: access_token.to_string(),
        });
    }
    let description = value.get("error_description").and_then(Value::as_str).map(str::to_string);
    match value.get("error").and_then(Value::as_str).unwrap_or("") {
        "authorization_pending" => Ok(CopilotDevicePoll::Pending {
            interval_secs: current_interval,
        }),
        "slow_down" => Ok(CopilotDevicePoll::Pending {
            interval_secs: current_interval + 5,
        }),
        "expired_token" => Ok(CopilotDevicePoll::Expired),
        "access_denied" => Ok(CopilotDevicePoll::Denied { reason: description }),
        "" => Err(copilot_error("device authorization response missing 'access_token'")),
        other => Err(copilot_error(format!(
            "device authorization refused ({other}){}",
            description.map(|detail| format!(": {detail}")).unwrap_or_default()
        ))),
    }
}

fn session_cache() -> &'static RwLock<HashMap<String, CopilotSessionToken>> {
    static CACHE: OnceLock<RwLock<HashMap<String, CopilotSessionToken>>> = OnceLock::new();
    CACHE.get_or_init(|| RwLock::new(HashMap::new()))
}

fn device_flow_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(COPILOT_DEVICE_CLIENT_TIMEOUT_SECS))
        .build()
        .map_err(|err| copilot_error(format!("failed to build HTTP client: {err}")))
}

/// Kick off the GitHub device flow for Copilot sign-in.
pub async fn copilot_device_start() -> Result<CopilotDeviceAuthorization, String> {
    copilot_device_start_url(COPILOT_DEVICE_CODE_URL).await
}

async fn copilot_device_start_url(device_code_url: &str) -> Result<CopilotDeviceAuthorization, String> {
    let client = device_flow_client()?;
    // The Accept header is mandatory: without it github.com answers with an
    // HTML page instead of the JSON body this flow needs.
    let response = client
        .post(device_code_url)
        .header("accept", "application/json")
        .form(&[("client_id", COPILOT_CLIENT_ID), ("scope", "read:user")])
        .send()
        .await
        .map_err(|err| copilot_error(format!("device authorization request failed: {err}")))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|err| copilot_error(format!("device authorization response failed: {err}")))?;
    if !status.is_success() {
        return Err(copilot_error(format!("device authorization failed (HTTP {status})")));
    }
    let value: Value =
        serde_json::from_str(&body).map_err(|err| copilot_error(format!("device authorization response was not JSON: {err}")))?;
    let required = |key: &str| {
        value
            .get(key)
            .and_then(Value::as_str)
            .filter(|text| !text.trim().is_empty())
            .map(str::to_string)
            .ok_or_else(|| copilot_error(format!("device authorization response missing '{key}'")))
    };
    Ok(CopilotDeviceAuthorization {
        device_code: required("device_code")?,
        user_code: required("user_code")?,
        verification_uri: required("verification_uri")?,
        interval_secs: value
            .get("interval")
            .and_then(Value::as_u64)
            .unwrap_or(MIN_DEVICE_POLL_INTERVAL_SECS)
            .max(MIN_DEVICE_POLL_INTERVAL_SECS),
        expires_in_secs: value.get("expires_in").and_then(Value::as_u64).unwrap_or(900),
    })
}

/// Poll the device flow once. `authorization_pending` / `slow_down` come back
/// as `Pending`, never as errors — they are normal states.
pub async fn copilot_device_poll(device_code: &str, interval_secs: u64) -> Result<CopilotDevicePoll, String> {
    copilot_device_poll_url(COPILOT_DEVICE_TOKEN_URL, device_code, interval_secs).await
}

async fn copilot_device_poll_url(
    device_token_url: &str,
    device_code: &str,
    interval_secs: u64,
) -> Result<CopilotDevicePoll, String> {
    let current_interval = interval_secs.max(MIN_DEVICE_POLL_INTERVAL_SECS);
    let client = device_flow_client()?;
    let response = client
        .post(device_token_url)
        .header("accept", "application/json")
        .form(&[
            ("client_id", COPILOT_CLIENT_ID),
            ("device_code", device_code),
            ("grant_type", COPILOT_DEVICE_GRANT_TYPE),
        ])
        .send()
        .await
        .map_err(|err| copilot_error(format!("device authorization poll failed: {err}")))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|err| copilot_error(format!("device authorization poll response failed: {err}")))?;
    let value: Value = match serde_json::from_str(&body) {
        Ok(value) => value,
        Err(_) if !status.is_success() => return Err(copilot_error(format!("device authorization poll failed (HTTP {status})"))),
        Err(err) => return Err(copilot_error(format!("device authorization poll response was not JSON: {err}"))),
    };
    classify_device_poll(&value, current_interval)
}

/// "Signed in as …" — resolves the login behind a stored `gho_` token.
pub async fn copilot_current_user(access_token: &str) -> Result<CopilotUser, String> {
    copilot_current_user_url(COPILOT_USER_URL, access_token).await
}

async fn copilot_current_user_url(user_url: &str, access_token: &str) -> Result<CopilotUser, String> {
    let token = access_token.trim();
    if token.is_empty() {
        return Err(copilot_error("no GitHub token stored — sign in with your GitHub account first"));
    }
    let client = device_flow_client()?;
    let response = client
        .get(user_url)
        .header("accept", "application/json")
        .header("authorization", format!("token {token}"))
        .header("user-agent", COPILOT_USER_AGENT)
        .send()
        .await
        .map_err(|err| copilot_error(format!("GitHub user request failed: {err}")))?;
    let status = response.status();
    if !status.is_success() {
        return Err(copilot_error(format!("GitHub user request failed (HTTP {status}) — sign in again")));
    }
    let value: Value = response
        .json()
        .await
        .map_err(|err| copilot_error(format!("GitHub user response was not JSON: {err}")))?;
    let login = value
        .get("login")
        .and_then(Value::as_str)
        .filter(|login| !login.trim().is_empty())
        .map(|login| login.to_string())
        .ok_or_else(|| copilot_error("GitHub user response missing 'login'"))?;
    Ok(CopilotUser { login })
}

/// Exchange a `gho_` OAuth token for a short-lived Copilot session token.
async fn exchange_session_token(
    client: &reqwest::Client,
    gho_token: &str,
    exchange_url: &str,
) -> Result<CopilotSessionToken, String> {
    let response = client
        .get(exchange_url)
        .header("accept", "application/json")
        .header("authorization", format!("token {gho_token}"))
        .header("editor-version", COPILOT_EDITOR_VERSION)
        .header("editor-plugin-version", COPILOT_EDITOR_PLUGIN_VERSION)
        .header("user-agent", COPILOT_USER_AGENT)
        .send()
        .await
        .map_err(|err| copilot_error(format!("session token request failed: {err}")))?;
    let status = response.status();
    // Never echo the response body here: error payloads are safe today, but a
    // token in a body would end up in logs and toast messages.
    if !status.is_success() {
        return Err(copilot_error(format!(
            "session token request failed (HTTP {status}) — sign in with your GitHub account again"
        )));
    }
    let value: Value = response
        .json()
        .await
        .map_err(|err| copilot_error(format!("session token response was not JSON: {err}")))?;
    let token = value
        .get("token")
        .and_then(Value::as_str)
        .filter(|token| !token.trim().is_empty())
        .map(str::to_string)
        .ok_or_else(|| copilot_error("session token response missing 'token'"))?;
    let expires_at = value.get("expires_at").and_then(Value::as_u64).unwrap_or(0);
    if expires_at == 0 {
        return Err(copilot_error("session token response missing 'expires_at'"));
    }
    Ok(CopilotSessionToken {
        token,
        expires_at,
        api_endpoint: api_endpoint_from(&value),
    })
}

async fn cached_session_token(
    client: &reqwest::Client,
    gho_token: &str,
    exchange_url: &str,
) -> Result<CopilotSessionToken, String> {
    if let Some(cached) = session_cache().read().unwrap().get(gho_token) {
        if !session_expired(cached.expires_at) {
            return Ok(cached.clone());
        }
    }
    let session = exchange_session_token(client, gho_token, exchange_url).await?;
    session_cache().write().unwrap().insert(gho_token.to_string(), session.clone());
    Ok(session)
}

/// Swap a stored Copilot `api_key` (a device-flow `gho_` token) for a fresh
/// session token in `config`, and point the endpoint at the API host GitHub
/// names for this account. No-op for every other provider.
///
/// Called at request time by every AI entry point, before
/// [`crate::ai::validate_config`], so the "sign in with GitHub" guidance wins
/// over the generic "API key is required" error.
pub async fn apply_copilot_auth(config: &mut AiConfig) -> Result<(), String> {
    apply_copilot_auth_at(config, COPILOT_TOKEN_EXCHANGE_URL).await
}

async fn apply_copilot_auth_at(config: &mut AiConfig, exchange_url: &str) -> Result<(), String> {
    if !matches!(config.provider, AiProvider::GithubCopilot) {
        return Ok(());
    }
    let gho_token = config.api_key.trim().to_string();
    if gho_token.is_empty() {
        return Err(copilot_error(
            "sign in with your GitHub account first (AI settings → GitHub Copilot → Sign in with GitHub)",
        ));
    }
    if is_pat_token(&gho_token) {
        return Err(copilot_error(
            "GitHub Copilot rejects personal access tokens — clear the API key and use 'Sign in with GitHub' instead",
        ));
    }
    // Reuse the provider HTTP client so proxy and skip-TLS settings apply.
    let client = crate::ai::build_ai_http_client(config, COPILOT_DEVICE_CLIENT_TIMEOUT_SECS)?;
    let session = cached_session_token(&client, &gho_token, exchange_url).await?;
    // Bare origin: resolve_endpoint appends /chat/completions (and the model
    // list path gets /models) on the Copilot branch without a /v1 prefix.
    config.endpoint = session.api_endpoint;
    config.api_key = session.token;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    struct CapturedRequest {
        headers: String,
        body: String,
    }

    /// Hand-rolled one-shot HTTP server (ai.rs `spawn_json_capture_server`
    /// pattern) that answers one fixed JSON body and captures the raw request.
    async fn spawn_capture_server(status_line: &'static str, response_body: &'static str) -> (String, tokio::task::JoinHandle<CapturedRequest>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut chunk = [0_u8; 4096];
            let header_end = loop {
                if let Some(index) = request.windows(4).position(|window| window == b"\r\n\r\n") {
                    break index + 4;
                }
                let read = socket.read(&mut chunk).await.unwrap();
                assert!(read > 0, "request ended before headers were complete");
                request.extend_from_slice(&chunk[..read]);
            };
            let headers = String::from_utf8(request[..header_end].to_vec()).unwrap();
            // GETs carry no body and often no Content-Length header at all.
            let content_length = headers
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length").then(|| value.trim().parse::<usize>().unwrap())
                })
                .unwrap_or(0);
            while request.len() < header_end + content_length {
                let read = socket.read(&mut chunk).await.unwrap();
                assert!(read > 0, "request ended before body was complete");
                request.extend_from_slice(&chunk[..read]);
            }
            let body = String::from_utf8(request[header_end..header_end + content_length].to_vec()).unwrap();
            let response = format!(
                "HTTP/1.1 {status_line}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response_body}",
                response_body.len()
            );
            socket.write_all(response.as_bytes()).await.unwrap();
            CapturedRequest { headers, body }
        });
        (format!("http://{address}"), server)
    }

    fn copilot_config(api_key: &str) -> AiConfig {
        serde_json::from_value(serde_json::json!({
            "provider": "github-copilot",
            "model": "gpt-4.1",
            "apiKey": api_key,
            "endpoint": "https://api.githubcopilot.com",
        }))
        .unwrap()
    }

    #[test]
    fn pat_tokens_are_recognized() {
        assert!(is_pat_token("ghp_abcdef"));
        assert!(is_pat_token("github_pat_11ABCDEFG"));
        assert!(!is_pat_token("gho_abcdef"));
        assert!(!is_pat_token(""));
    }

    #[test]
    fn session_expiry_uses_refresh_margin() {
        let far_future = now_unix_secs() + 3600;
        assert!(!session_expired(far_future));
        let just_inside_margin = now_unix_secs() + COPILOT_REFRESH_MARGIN_SECS + 10;
        assert!(!session_expired(just_inside_margin));
        let at_margin = now_unix_secs() + COPILOT_REFRESH_MARGIN_SECS;
        assert!(session_expired(at_margin));
        assert!(session_expired(now_unix_secs()));
    }

    #[test]
    fn api_endpoint_falls_back_to_public_host() {
        let named = serde_json::json!({"token": "t", "expires_at": 1, "endpoints": {"api": "https://api.enterprise.githubcopilot.com/"}});
        assert_eq!(api_endpoint_from(&named), "https://api.enterprise.githubcopilot.com");
        let missing = serde_json::json!({"token": "t", "expires_at": 1});
        assert_eq!(api_endpoint_from(&missing), COPILOT_FALLBACK_API_ENDPOINT);
    }

    #[test]
    fn device_poll_classification_covers_all_states() {
        let pending = serde_json::json!({"error": "authorization_pending"});
        assert!(matches!(classify_device_poll(&pending, 5), Ok(CopilotDevicePoll::Pending { interval_secs: 5 })));
        let slow = serde_json::json!({"error": "slow_down"});
        assert!(matches!(classify_device_poll(&slow, 5), Ok(CopilotDevicePoll::Pending { interval_secs: 10 })));
        assert!(matches!(classify_device_poll(&serde_json::json!({"error": "expired_token"}), 5), Ok(CopilotDevicePoll::Expired)));
        let denied = serde_json::json!({"error": "access_denied", "error_description": "nope"});
        assert!(matches!(
            classify_device_poll(&denied, 5),
            Ok(CopilotDevicePoll::Denied { reason: Some(ref reason) }) if reason == "nope"
        ));
        let success = serde_json::json!({"access_token": "gho_ok"});
        assert!(matches!(classify_device_poll(&success, 5), Ok(CopilotDevicePoll::Success { ref access_token }) if access_token == "gho_ok"));
        assert!(classify_device_poll(&serde_json::json!({"error": "unsupported_grant_type"}), 5).is_err());
        assert!(classify_device_poll(&serde_json::json!({}), 5).is_err());
    }

    #[test]
    fn device_poll_serializes_the_frontend_union_shape() {
        // The desktop/web frontends match on `status` and read camelCase fields
        // (`accessToken`, `intervalSecs`); enum-level `rename_all` alone leaves
        // struct-variant fields in snake_case, which once surfaced as a poll
        // "success" whose token the dialog could not read.
        assert_eq!(
            serde_json::to_value(CopilotDevicePoll::Pending { interval_secs: 7 }).unwrap(),
            serde_json::json!({"status": "pending", "intervalSecs": 7})
        );
        assert_eq!(
            serde_json::to_value(CopilotDevicePoll::Success { access_token: "gho_ok".to_string() }).unwrap(),
            serde_json::json!({"status": "success", "accessToken": "gho_ok"})
        );
        assert_eq!(
            serde_json::to_value(CopilotDevicePoll::Expired).unwrap(),
            serde_json::json!({"status": "expired"})
        );
        assert_eq!(
            serde_json::to_value(CopilotDevicePoll::Denied { reason: Some("nope".to_string()) }).unwrap(),
            serde_json::json!({"status": "denied", "reason": "nope"})
        );
        assert_eq!(
            serde_json::to_value(&CopilotDeviceAuthorization {
                device_code: "dc".to_string(),
                user_code: "ABCD-1234".to_string(),
                verification_uri: "https://github.com/login/device".to_string(),
                interval_secs: 5,
                expires_in_secs: 900,
            })
            .unwrap(),
            serde_json::json!({"deviceCode": "dc", "userCode": "ABCD-1234", "verificationUri": "https://github.com/login/device", "intervalSecs": 5, "expiresInSecs": 900})
        );
    }

    #[tokio::test]
    async fn device_start_posts_client_id_scope_and_json_accept() {
        let (base, server) = spawn_capture_server(
            "200 OK",
            r#"{"device_code":"dc-1","user_code":"ABCD-1234","verification_uri":"https://github.com/login/device","expires_in":900,"interval":5}"#,
        )
        .await;
        let authorization = copilot_device_start_url(&format!("{base}/login/device/code")).await.unwrap();
        let captured = server.await.unwrap();
        assert_eq!(authorization.device_code, "dc-1");
        assert_eq!(authorization.user_code, "ABCD-1234");
        assert_eq!(authorization.verification_uri, "https://github.com/login/device");
        assert_eq!(authorization.interval_secs, 5);
        assert!(captured.headers.to_ascii_lowercase().contains("accept: application/json"));
        assert!(captured.body.contains("client_id=Iv1.b507a08c87ecfe98"));
        assert!(captured.body.contains("scope=read%3Auser"));
    }

    #[tokio::test]
    async fn device_poll_posts_device_grant_urn_and_returns_access_token() {
        let (base, server) = spawn_capture_server("200 OK", r#"{"access_token":"gho_poll"}"#).await;
        let poll = copilot_device_poll_url(&format!("{base}/login/oauth/access_token"), "dc-9", 4).await.unwrap();
        let captured = server.await.unwrap();
        assert!(matches!(poll, CopilotDevicePoll::Success { ref access_token } if access_token == "gho_poll"));
        assert!(captured.body.contains("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code"));
        assert!(captured.body.contains("device_code=dc-9"));
        assert!(captured.body.contains("client_id=Iv1.b507a08c87ecfe98"));
    }

    #[tokio::test]
    async fn exchange_sends_editor_headers_and_parses_session() {
        let (base, server) = spawn_capture_server(
            "200 OK",
            r#"{"token":"sess-tok","expires_at":99999999999,"endpoints":{"api":"https://api.enterprise.githubcopilot.com"}}"#,
        )
        .await;
        let client = device_flow_client().unwrap();
        let session = exchange_session_token(&client, "gho_x1", &format!("{base}/copilot_internal/v2/token"))
            .await
            .unwrap();
        let captured = server.await.unwrap();
        assert_eq!(session.token, "sess-tok");
        assert_eq!(session.api_endpoint, "https://api.enterprise.githubcopilot.com");
        let headers = captured.headers.to_ascii_lowercase();
        assert!(headers.contains("authorization: token gho_x1"));
        assert!(headers.contains("editor-version: vscode/1.85.1"));
        assert!(headers.contains("editor-plugin-version: copilot/1.155.0"));
        assert!(headers.contains("user-agent: githubcopilot/1.155.0"));
    }

    #[tokio::test]
    async fn apply_copilot_auth_rejects_missing_and_pat_keys_before_any_request() {
        // Unreachable URL: both rejections must happen without network I/O.
        let exchange_url = "http://127.0.0.1:1/copilot_internal/v2/token";
        let mut missing = copilot_config("");
        let error = apply_copilot_auth_at(&mut missing, exchange_url).await.unwrap_err();
        assert!(error.contains("sign in with your GitHub account"), "{error}");
        let mut pat = copilot_config("ghp_classic");
        let error = apply_copilot_auth_at(&mut pat, exchange_url).await.unwrap_err();
        assert!(error.contains("rejects personal access tokens"), "{error}");
    }

    #[tokio::test]
    async fn apply_copilot_auth_swaps_key_and_endpoint() {
        let (base, server) = spawn_capture_server(
            "200 OK",
            r#"{"token":"sess-42","expires_at":99999999999,"endpoints":{"api":"https://api.enterprise.githubcopilot.com"}}"#,
        )
        .await;
        let mut config = copilot_config("gho_swapped");
        apply_copilot_auth_at(&mut config, &format!("{base}/copilot_internal/v2/token"))
            .await
            .unwrap();
        server.await.unwrap();
        assert_eq!(config.api_key, "sess-42");
        assert_eq!(config.endpoint, "https://api.enterprise.githubcopilot.com");
    }

    #[tokio::test]
    async fn session_tokens_are_cached_per_gho_token() {
        let (base, server) = spawn_capture_server("200 OK", r#"{"token":"sess-cached","expires_at":99999999999}"#).await;
        let mut first = copilot_config("gho_cached");
        apply_copilot_auth_at(&mut first, &format!("{base}/copilot_internal/v2/token"))
            .await
            .unwrap();
        server.await.unwrap();

        // Second call hits the cache: the unreachable exchange URL is never
        // contacted and the same session token comes back.
        let mut second = copilot_config("gho_cached");
        apply_copilot_auth_at(&mut second, "http://127.0.0.1:1/copilot_internal/v2/token")
            .await
            .unwrap();
        assert_eq!(second.api_key, "sess-cached");
        assert_eq!(second.endpoint, COPILOT_FALLBACK_API_ENDPOINT);
    }

    #[tokio::test]
    async fn apply_copilot_auth_ignores_other_providers() {
        let mut config = copilot_config("gho_ignore");
        config.provider = AiProvider::Openai;
        // Unreachable URL proves the function returned before any request.
        apply_copilot_auth_at(&mut config, "http://127.0.0.1:1/never").await.unwrap();
        assert_eq!(config.api_key, "gho_ignore");
    }

    #[tokio::test]
    async fn copilot_current_user_reports_login() {
        let (base, server) = spawn_capture_server("200 OK", r#"{"login":"octocat"}"#).await;
        let user = copilot_current_user_url(&format!("{base}/user"), "gho_who").await.unwrap();
        let captured = server.await.unwrap();
        assert_eq!(user.login, "octocat");
        assert!(captured.headers.to_ascii_lowercase().contains("authorization: token gho_who"));
    }
}
