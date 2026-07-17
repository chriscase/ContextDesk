//! Grok Build session detection and wire headers (opt-in).
//!
//! Does not send credentials to arbitrary URLs — base must be allowlisted.
//! Session material stays in Rust; never log raw tokens.

use crate::error::{CoreError, CoreResult};
use crate::ssrf::{validate_provider_url, SsrfPolicy};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Allowed API hosts for Grok session credentials (exact match).
pub const ALLOWED_GROK_HOSTS: &[&str] = &["api.x.ai"];

/// User-facing message when session is missing/expired and refresh fails.
pub const RELOGIN_MESSAGE: &str =
    "Grok session missing or expired. Run `grok login` (or re-authenticate) then retry. ContextDesk does not store your Grok password.";

/// Presence-only info for Settings (no tokens).
#[derive(Debug, Clone)]
pub struct GrokSessionPresence {
    /// Path to auth.json.
    pub path: PathBuf,
    /// Display email if parseable.
    pub email: Option<String>,
    /// Auth mode.
    pub auth_mode: Option<String>,
    /// True if a refresh_token field is present (not the secret).
    pub has_refresh_token: bool,
    /// True if expires_at is in the past (if present).
    pub expired: bool,
}

/// Wire credentials after explicit opt-in.
#[derive(Debug, Clone)]
pub struct GrokWireCredentials {
    /// Bearer / access token (session key).
    pub bearer: String,
    /// Whether to send CLI OIDC headers.
    pub oidc_token_auth: bool,
    /// Display name (email).
    pub display_name: String,
    /// Optional refresh token (never logged).
    pub refresh_token: Option<String>,
    /// Unix seconds expiry if known.
    pub expires_at: Option<i64>,
    /// OIDC issuer URL for refresh (e.g. https://auth.x.ai).
    pub oidc_issuer: Option<String>,
    /// OIDC client id for refresh.
    pub oidc_client_id: Option<String>,
}

impl GrokWireCredentials {
    /// True if expires_at is set and in the past (skew 60s).
    pub fn is_expired(&self) -> bool {
        match self.expires_at {
            Some(exp) => {
                let now = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(0);
                exp <= now + 60
            }
            None => false,
        }
    }

    /// Build Authorization + OIDC header map (values only; do not log).
    pub fn request_headers(&self) -> Vec<(String, String)> {
        let mut h = vec![
            ("Authorization".into(), format!("Bearer {}", self.bearer)),
            (
                "User-Agent".into(),
                format!("ContextDesk/{}", env!("CARGO_PKG_VERSION")),
            ),
            (
                "X-Grok-Client-Version".into(),
                env!("CARGO_PKG_VERSION").into(),
            ),
        ];
        if self.oidc_token_auth {
            for (k, v) in oidc_extra_headers() {
                h.push((k.into(), v.into()));
            }
        }
        h
    }
}

/// Detect session file without loading token into callers unnecessarily.
pub fn detect_grok_session() -> Option<GrokSessionPresence> {
    let path = dirs::home_dir()?.join(".grok").join("auth.json");
    detect_grok_session_at(&path)
}

/// Detect session at path (tests).
pub fn detect_grok_session_at(path: &Path) -> Option<GrokSessionPresence> {
    if !path.is_file() {
        return None;
    }
    let raw = fs::read_to_string(path).ok()?;
    let v: Value = serde_json::from_str(&raw).ok()?;
    let obj = v.as_object()?;
    let entry = obj.values().next()?.as_object()?;
    let expires_at = entry.get("expires_at").and_then(|e| e.as_i64());
    let expired = expires_at
        .map(|exp| {
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            exp <= now
        })
        .unwrap_or(false);
    Some(GrokSessionPresence {
        path: path.to_path_buf(),
        email: entry
            .get("email")
            .and_then(|e| e.as_str())
            .map(str::to_string),
        auth_mode: entry
            .get("auth_mode")
            .and_then(|e| e.as_str())
            .map(str::to_string),
        has_refresh_token: entry
            .get("refresh_token")
            .and_then(|r| r.as_str())
            .map(|s| !s.is_empty())
            .unwrap_or(false),
        expired,
    })
}

/// Parse credentials from auth.json JSON value (first usable entry).
pub fn parse_grok_credentials_json(v: &Value) -> CoreResult<GrokWireCredentials> {
    let obj = v
        .as_object()
        .ok_or_else(|| CoreError::Config("auth.json shape".into()))?;
    for (_scope, entry) in obj {
        let Some(cred) = entry.as_object() else {
            continue;
        };
        let Some(key) = cred
            .get("key")
            .and_then(|k| k.as_str())
            .filter(|s| !s.is_empty())
        else {
            continue;
        };
        let email = cred
            .get("email")
            .and_then(|e| e.as_str())
            .unwrap_or("Grok session");
        let mode = cred
            .get("auth_mode")
            .and_then(|m| m.as_str())
            .unwrap_or("oidc");
        let refresh_token = cred
            .get("refresh_token")
            .and_then(|r| r.as_str())
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        let expires_at = cred.get("expires_at").and_then(|e| e.as_i64());
        let oidc_issuer = cred
            .get("oidc_issuer")
            .and_then(|i| i.as_str())
            .map(str::to_string);
        let oidc_client_id = cred
            .get("oidc_client_id")
            .and_then(|c| c.as_str())
            .map(str::to_string);
        return Ok(GrokWireCredentials {
            bearer: key.to_string(),
            oidc_token_auth: mode == "oidc",
            display_name: email.to_string(),
            refresh_token,
            expires_at,
            oidc_issuer,
            oidc_client_id,
        });
    }
    Err(CoreError::Config("no usable Grok session entry".into()))
}

/// Load session credentials from path (caller must have user opt-in).
pub fn load_grok_session_credentials_from(path: &Path) -> CoreResult<GrokWireCredentials> {
    let raw = fs::read_to_string(path).map_err(|e| {
        CoreError::Config(format!("{RELOGIN_MESSAGE} (cannot read auth.json: {e})"))
    })?;
    let v: Value = serde_json::from_str(&raw)
        .map_err(|_| CoreError::Config(format!("{RELOGIN_MESSAGE} (auth.json parse failed)")))?;
    parse_grok_credentials_json(&v)
}

/// Load session credentials from default `~/.grok/auth.json` (caller must have user opt-in).
pub fn load_grok_session_credentials() -> CoreResult<GrokWireCredentials> {
    let path = dirs::home_dir()
        .ok_or_else(|| CoreError::Config("no home".into()))?
        .join(".grok")
        .join("auth.json");
    if !path.is_file() {
        return Err(CoreError::Config(RELOGIN_MESSAGE.into()));
    }
    load_grok_session_credentials_from(&path)
}

/// Token endpoint for an OIDC issuer (authorization-server convention).
pub fn token_endpoint_for_issuer(issuer: &str) -> String {
    let base = issuer.trim().trim_end_matches('/');
    format!("{base}/protocol/openid-connect/token")
}

/// Apply a successful refresh response into credentials and optional auth.json update payload.
///
/// Expected OAuth2 fields: `access_token`, optional `refresh_token`, optional `expires_in`.
pub fn apply_token_response(
    mut creds: GrokWireCredentials,
    token_json: &Value,
) -> CoreResult<GrokWireCredentials> {
    let access = token_json
        .get("access_token")
        .or_else(|| token_json.get("key"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            CoreError::Config(format!("{RELOGIN_MESSAGE} (refresh missing access_token)"))
        })?;
    creds.bearer = access.to_string();
    if let Some(rt) = token_json
        .get("refresh_token")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
    {
        creds.refresh_token = Some(rt.to_string());
    }
    if let Some(secs) = token_json.get("expires_in").and_then(|v| v.as_i64()) {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        creds.expires_at = Some(now + secs);
    }
    Ok(creds)
}

/// Build refresh request body (for tests / HTTP clients). Never logs secrets.
pub fn refresh_request_body(creds: &GrokWireCredentials) -> CoreResult<Value> {
    let rt = creds
        .refresh_token
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| CoreError::Config(format!("{RELOGIN_MESSAGE} (no refresh_token)")))?;
    let client_id = creds.oidc_client_id.as_deref().unwrap_or("grok-cli");
    Ok(json!({
        "grant_type": "refresh_token",
        "refresh_token": rt,
        "client_id": client_id,
    }))
}

/// Ensure credentials are fresh: if expired and refresh_token present, call `refresh_http`.
///
/// `refresh_http` receives (token_url, body_json) and returns response JSON.
/// Live network is optional; unit tests inject a mock.
pub async fn ensure_fresh_credentials<F, Fut>(
    creds: GrokWireCredentials,
    refresh_http: F,
) -> CoreResult<GrokWireCredentials>
where
    F: FnOnce(String, Value) -> Fut,
    Fut: std::future::Future<Output = CoreResult<Value>>,
{
    if !creds.is_expired() {
        return Ok(creds);
    }
    if creds.refresh_token.is_none() {
        return Err(CoreError::Config(RELOGIN_MESSAGE.into()));
    }
    let issuer = creds
        .oidc_issuer
        .clone()
        .unwrap_or_else(|| "https://auth.x.ai".into());
    // SSRF: only allow known auth hosts for refresh
    let token_url = token_endpoint_for_issuer(&issuer);
    validate_provider_url(
        &token_url.replace("/protocol/openid-connect/token", ""),
        &SsrfPolicy::default(),
    )
    .or_else(|_| {
        // issuer may be https://auth.x.ai without path
        validate_provider_url(&issuer, &SsrfPolicy::default())
    })
    .map_err(|e| CoreError::Policy(format!("refresh issuer blocked by SSRF: {e}")))?;
    // Exact host pin for refresh (auth.x.ai)
    if let Ok(u) = url::Url::parse(&issuer) {
        let host = u.host_str().unwrap_or("").to_ascii_lowercase();
        if host != "auth.x.ai" {
            return Err(CoreError::Policy(format!(
                "Grok refresh only allowed for auth.x.ai (got `{host}`)"
            )));
        }
    }
    let body = refresh_request_body(&creds)?;
    let resp = refresh_http(token_url, body).await.map_err(|e| {
        // Do not attach secrets
        CoreError::Message(format!("{RELOGIN_MESSAGE} (refresh failed: {e})"))
    })?;
    apply_token_response(creds, &resp)
}

/// Ensure base URL is allowed for Grok session credentials.
///
/// Exact host match only (rejects api.x.ai.evil.com and userinfo tricks).
pub fn assert_grok_base_allowed(base_url: &str) -> CoreResult<()> {
    let url = validate_provider_url(base_url, &SsrfPolicy::default())?;
    let host = url
        .host_str()
        .ok_or_else(|| CoreError::Policy("missing host".into()))?
        .to_ascii_lowercase();
    if !ALLOWED_GROK_HOSTS.contains(&host.as_str()) {
        return Err(CoreError::Policy(format!(
            "Grok session credentials may only target host api.x.ai (got `{host}`)"
        )));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(CoreError::Policy(
            "credentials in URL not allowed for Grok bases".into(),
        ));
    }
    Ok(())
}

/// Header pairs for OIDC CLI auth (values only; names documented).
pub fn oidc_extra_headers() -> Vec<(&'static str, &'static str)> {
    vec![
        ("X-XAI-Token-Auth", "xai-grok-cli"),
        ("x-authenticateresponse", "authenticate-response"),
    ]
}

/// Debug-safe redaction: never print bearer/refresh.
pub fn redacted_debug(creds: &GrokWireCredentials) -> String {
    format!(
        "GrokWireCredentials{{display_name={}, oidc={}, expired={}, has_refresh={}, bearer=***}}",
        creds.display_name,
        creds.oidc_token_auth,
        creds.is_expired(),
        creds.refresh_token.is_some()
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::NamedTempFile;

    fn fixture_auth(expired: bool, with_refresh: bool) -> Value {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        let exp = if expired { now - 100 } else { now + 3600 };
        let mut entry = json!({
            "auth_mode": "oidc",
            "email": "user@example.com",
            "key": "test-access-token-not-real",
            "expires_at": exp,
            "oidc_issuer": "https://auth.x.ai",
            "oidc_client_id": "test-client",
        });
        if with_refresh {
            entry["refresh_token"] = json!("test-refresh-token-not-real");
        }
        json!({
            "https://auth.x.ai::test-scope": entry
        })
    }

    #[test]
    fn blocks_arbitrary_base_for_session() {
        assert!(assert_grok_base_allowed("https://evil.example.com/v1").is_err());
        assert!(assert_grok_base_allowed("https://api.x.ai/v1").is_ok());
        assert!(assert_grok_base_allowed("https://api.x.ai.evil.com/v1").is_err());
        assert!(assert_grok_base_allowed("https://api.x.ai@evil.com/v1").is_err());
    }

    #[test]
    fn parse_includes_refresh_and_expiry() {
        let v = fixture_auth(false, true);
        let c = parse_grok_credentials_json(&v).unwrap();
        assert_eq!(c.bearer, "test-access-token-not-real");
        assert!(c.refresh_token.is_some());
        assert!(c.expires_at.is_some());
        assert!(!c.is_expired());
        assert!(c.oidc_token_auth);
        let dbg = redacted_debug(&c);
        assert!(!dbg.contains("test-access"));
        assert!(!dbg.contains("test-refresh"));
    }

    #[test]
    fn expired_without_refresh_fails_ensure() {
        let v = fixture_auth(true, false);
        let c = parse_grok_credentials_json(&v).unwrap();
        assert!(c.is_expired());
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let err = rt
            .block_on(ensure_fresh_credentials(c, |_u, _b| async {
                Ok(json!({}))
            }))
            .unwrap_err();
        assert!(
            err.to_string().contains("re-authenticate")
                || err.to_string().contains("missing")
                || err.to_string().contains("expired")
                || err.to_string().contains("Grok session"),
            "{err}"
        );
    }

    #[test]
    fn refresh_applies_new_access_token() {
        let v = fixture_auth(true, true);
        let c = parse_grok_credentials_json(&v).unwrap();
        assert!(c.is_expired());
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let fresh = rt
            .block_on(ensure_fresh_credentials(c, |url, body| async move {
                assert!(url.contains("auth.x.ai"));
                assert_eq!(body["grant_type"], "refresh_token");
                assert!(body["refresh_token"].as_str().unwrap().contains("refresh"));
                Ok(json!({
                    "access_token": "new-access-token",
                    "refresh_token": "new-refresh",
                    "expires_in": 7200
                }))
            }))
            .unwrap();
        assert_eq!(fresh.bearer, "new-access-token");
        assert_eq!(fresh.refresh_token.as_deref(), Some("new-refresh"));
        assert!(!fresh.is_expired());
    }

    #[test]
    fn load_from_fixture_file() {
        let mut f = NamedTempFile::new().unwrap();
        write!(f, "{}", fixture_auth(false, true)).unwrap();
        let c = load_grok_session_credentials_from(f.path()).unwrap();
        assert!(c.refresh_token.is_some());
        let p = detect_grok_session_at(f.path()).unwrap();
        assert!(p.has_refresh_token);
        assert!(!p.expired);
    }

    #[test]
    fn headers_include_bearer_and_version() {
        let c = parse_grok_credentials_json(&fixture_auth(false, true)).unwrap();
        let h = c.request_headers();
        assert!(h
            .iter()
            .any(|(k, v)| k == "Authorization" && v.starts_with("Bearer ")));
        assert!(h.iter().any(|(k, _)| k == "X-Grok-Client-Version"));
        assert!(h.iter().any(|(k, _)| k == "X-XAI-Token-Auth"));
    }

    #[test]
    fn refresh_request_body_requires_token() {
        let mut c = parse_grok_credentials_json(&fixture_auth(false, false)).unwrap();
        c.refresh_token = None;
        assert!(refresh_request_body(&c).is_err());
    }
}
