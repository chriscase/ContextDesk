//! Typed HTTP preset connector (host allowlist; no free-form URL tool).

use crate::error::{CoreError, CoreResult};
use crate::ssrf::{build_pinned_client, validate_provider_url, SsrfPolicy, SystemResolver};
use serde::{Deserialize, Serialize};
use url::Url;

/// HTTP preset definition.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HttpPresetConfig {
    /// Id.
    pub id: String,
    /// Allowed host (exact).
    pub host: String,
    /// Base path prefix e.g. /api/v1.
    pub base_path: String,
    /// GET path templates relative to base (e.g. /users/{id}).
    pub get_routes: Vec<String>,
}

/// Validate host exact match and path under base.
pub fn build_preset_url(
    preset: &HttpPresetConfig,
    route_template: &str,
    allow_private: bool,
) -> CoreResult<Url> {
    if !preset.get_routes.iter().any(|r| r == route_template) {
        return Err(CoreError::Policy(format!(
            "route `{route_template}` not in preset allowlist"
        )));
    }
    let base = format!("https://{}{}", preset.host, preset.base_path);
    let policy = if allow_private {
        SsrfPolicy::allow_private_networks()
    } else {
        SsrfPolicy::default()
    };
    let mut url = validate_provider_url(&base, &policy)?;
    let host = url
        .host_str()
        .ok_or_else(|| CoreError::Config("no host".into()))?
        .to_ascii_lowercase();
    if host != preset.host.to_ascii_lowercase() {
        return Err(CoreError::Policy("host mismatch".into()));
    }
    let path = if route_template.starts_with('/') {
        format!(
            "{}{}",
            preset.base_path.trim_end_matches('/'),
            route_template
        )
    } else {
        format!(
            "{}/{}",
            preset.base_path.trim_end_matches('/'),
            route_template
        )
    };
    url.set_path(&path);
    Ok(url)
}

/// Execute GET on preset route.
pub async fn preset_get(
    preset: &HttpPresetConfig,
    route_template: &str,
    bearer: Option<&str>,
    allow_private: bool,
) -> CoreResult<String> {
    let url = build_preset_url(preset, route_template, allow_private)?;
    let policy = if allow_private {
        SsrfPolicy::allow_private_networks()
    } else {
        SsrfPolicy::default()
    };
    let client = build_pinned_client(
        &url,
        &policy,
        &SystemResolver,
        std::time::Duration::from_secs(30),
    )?;
    let mut req = client.get(url);
    if let Some(b) = bearer {
        req = req.bearer_auth(b);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| CoreError::Message(format!("http get: {e}")))?;
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| CoreError::Message(format!("body: {e}")))?;
    if !status.is_success() {
        return Err(CoreError::Message(format!("HTTP {status}")));
    }
    if text.len() > 64 * 1024 {
        return Ok(format!(
            "{}…",
            crate::text::truncate_bytes(&text, 64 * 1024)
        ));
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_allowlisted_routes() {
        let p = HttpPresetConfig {
            id: "api".into(),
            host: "example.com".into(),
            base_path: "/v1".into(),
            get_routes: vec!["/health".into()],
        };
        assert!(build_preset_url(&p, "/health", false).is_ok());
        assert!(build_preset_url(&p, "/admin", false).is_err());
    }

    /// Cap path: multibyte body straddling 64KiB must not panic (uses truncate_bytes).
    #[test]
    fn truncate_multibyte_body_at_64k_boundary() {
        // Build string whose len is just over 64KiB with multi-byte chars at the cut.
        let mut s = "a".repeat(64 * 1024 - 2);
        s.push('é'); // 2 bytes → total 64KiB+0 mid-char if sliced at exactly 65536
        s.push_str("tail");
        assert!(s.len() > 64 * 1024);
        let t = crate::text::truncate_bytes(&s, 64 * 1024);
        assert!(t.len() <= 64 * 1024);
        assert!(t.is_char_boundary(t.len()));
        let formatted = format!("{}…", t);
        assert!(formatted.ends_with('…'));
    }
}
