//! Confluence read-only client (CQL search + page fetch, space allowlist).

use crate::error::{CoreError, CoreResult};
use crate::ssrf::{validate_provider_url, SsrfPolicy};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Confluence RO config.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfluenceRoConfig {
    /// Base URL e.g. https://wiki.example.com.
    pub base_url: String,
    /// Allowed space keys.
    pub spaces: Vec<String>,
}

/// Search hit.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfluenceHit {
    /// Page id.
    pub id: String,
    /// Title.
    pub title: String,
    /// Space key.
    pub space: String,
    /// Excerpt.
    pub excerpt: String,
}

/// Validate space is allowlisted.
pub fn space_allowed(cfg: &ConfluenceRoConfig, space: &str) -> bool {
    cfg.spaces.iter().any(|s| s.eq_ignore_ascii_case(space))
}

/// CQL search (read-only).
pub async fn cql_search(
    cfg: &ConfluenceRoConfig,
    cql: &str,
    pat: &str,
    limit: usize,
) -> CoreResult<Vec<ConfluenceHit>> {
    let policy = SsrfPolicy::default();
    let base = validate_provider_url(&cfg.base_url, &policy)?;
    // Restrict CQL to allowed spaces when possible
    let mut cql = cql.to_string();
    if !cfg.spaces.is_empty() && !cql.to_lowercase().contains("space") {
        let spaces = cfg
            .spaces
            .iter()
            .map(|s| format!("space = \"{s}\""))
            .collect::<Vec<_>>()
            .join(" OR ");
        cql = format!("({cql}) AND ({spaces})");
    }
    let url = format!(
        "{}/rest/api/content/search?cql={}&limit={}",
        base.as_str().trim_end_matches('/'),
        urlencoding_encode(&cql),
        limit.min(25)
    );
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| CoreError::Message(format!("http: {e}")))?;
    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {pat}"))
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| CoreError::Message(format!("confluence: {e}")))?;
    if !resp.status().is_success() {
        return Err(CoreError::Message(format!(
            "confluence HTTP {}",
            resp.status()
        )));
    }
    let v: Value = resp
        .json()
        .await
        .map_err(|e| CoreError::Message(format!("json: {e}")))?;
    let mut hits = Vec::new();
    if let Some(results) = v.get("results").and_then(|r| r.as_array()) {
        for r in results {
            let space = r
                .pointer("/space/key")
                .and_then(|s| s.as_str())
                .unwrap_or("")
                .to_string();
            if !cfg.spaces.is_empty() && !space_allowed(cfg, &space) {
                continue;
            }
            hits.push(ConfluenceHit {
                id: r
                    .get("id")
                    .and_then(|i| i.as_str())
                    .unwrap_or("")
                    .to_string(),
                title: r
                    .get("title")
                    .and_then(|t| t.as_str())
                    .unwrap_or("")
                    .to_string(),
                space,
                excerpt: r
                    .pointer("/excerpt")
                    .and_then(|e| e.as_str())
                    .unwrap_or("")
                    .chars()
                    .take(300)
                    .collect(),
            });
        }
    }
    Ok(hits)
}

/// Fetch page body as plain-ish text (storage format stripped lightly).
pub async fn fetch_page(cfg: &ConfluenceRoConfig, page_id: &str, pat: &str) -> CoreResult<String> {
    let policy = SsrfPolicy::default();
    let base = validate_provider_url(&cfg.base_url, &policy)?;
    let url = format!(
        "{}/rest/api/content/{}?expand=body.storage,space",
        base.as_str().trim_end_matches('/'),
        page_id
    );
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| CoreError::Message(format!("http: {e}")))?;
    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {pat}"))
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| CoreError::Message(format!("confluence: {e}")))?;
    if !resp.status().is_success() {
        return Err(CoreError::Message(format!(
            "confluence HTTP {}",
            resp.status()
        )));
    }
    let v: Value = resp
        .json()
        .await
        .map_err(|e| CoreError::Message(format!("json: {e}")))?;
    let space = v
        .pointer("/space/key")
        .and_then(|s| s.as_str())
        .unwrap_or("");
    if !cfg.spaces.is_empty() && !space_allowed(cfg, space) {
        return Err(CoreError::Policy(format!(
            "space `{space}` not allowlisted"
        )));
    }
    let storage = v
        .pointer("/body/storage/value")
        .and_then(|s| s.as_str())
        .unwrap_or("");
    Ok(strip_tags(storage))
}

fn strip_tags(html: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    for c in html.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out.chars().take(32_000).collect()
}

fn urlencoding_encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn space_gate() {
        let cfg = ConfluenceRoConfig {
            base_url: "https://example.com".into(),
            spaces: vec!["ENG".into()],
        };
        assert!(space_allowed(&cfg, "ENG"));
        assert!(!space_allowed(&cfg, "HR"));
    }

    #[test]
    fn strip_basic_html() {
        assert_eq!(strip_tags("<p>Hello</p>"), "Hello");
    }
}
