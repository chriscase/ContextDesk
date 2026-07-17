//! Grok Build session detection and wire headers (opt-in Phase 2+).
//!
//! Does not send credentials to arbitrary URLs — base must be allowlisted.

use crate::error::{CoreError, CoreResult};
use crate::ssrf::{validate_provider_url, SsrfPolicy};
use serde_json::Value;
use std::fs;
use std::path::PathBuf;

/// Allowed API hosts for Grok session credentials (exact match).
pub const ALLOWED_GROK_HOSTS: &[&str] = &["api.x.ai"];

/// Presence-only info for Settings (no tokens).
#[derive(Debug, Clone)]
pub struct GrokSessionPresence {
    /// Path to auth.json.
    pub path: PathBuf,
    /// Display email if parseable.
    pub email: Option<String>,
    /// Auth mode.
    pub auth_mode: Option<String>,
}

/// Detect session file without loading token into callers unnecessarily.
pub fn detect_grok_session() -> Option<GrokSessionPresence> {
    let path = dirs::home_dir()?.join(".grok").join("auth.json");
    if !path.is_file() {
        return None;
    }
    let raw = fs::read_to_string(&path).ok()?;
    let v: Value = serde_json::from_str(&raw).ok()?;
    let obj = v.as_object()?;
    let entry = obj.values().next()?.as_object()?;
    Some(GrokSessionPresence {
        path,
        email: entry
            .get("email")
            .and_then(|e| e.as_str())
            .map(str::to_string),
        auth_mode: entry
            .get("auth_mode")
            .and_then(|e| e.as_str())
            .map(str::to_string),
    })
}

/// Wire credentials after explicit opt-in.
#[derive(Debug, Clone)]
pub struct GrokWireCredentials {
    /// Bearer token.
    pub bearer: String,
    /// Whether to send CLI OIDC headers.
    pub oidc_token_auth: bool,
    /// Display name.
    pub display_name: String,
}

/// Load session credentials (caller must have user opt-in).
pub fn load_grok_session_credentials() -> CoreResult<GrokWireCredentials> {
    let path = dirs::home_dir()
        .ok_or_else(|| CoreError::Config("no home".into()))?
        .join(".grok")
        .join("auth.json");
    let raw = fs::read_to_string(&path)?;
    let v: Value = serde_json::from_str(&raw)?;
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
        return Ok(GrokWireCredentials {
            bearer: key.to_string(),
            oidc_token_auth: mode == "oidc",
            display_name: email.to_string(),
        });
    }
    Err(CoreError::Config("no usable Grok session entry".into()))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_arbitrary_base_for_session() {
        assert!(assert_grok_base_allowed("https://evil.example.com/v1").is_err());
        assert!(assert_grok_base_allowed("https://api.x.ai/v1").is_ok());
        assert!(assert_grok_base_allowed("https://api.x.ai.evil.com/v1").is_err());
        assert!(assert_grok_base_allowed("https://api.x.ai@evil.com/v1").is_err());
    }
}
