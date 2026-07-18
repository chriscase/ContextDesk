//! Confluence read-only client (CQL search + page fetch, space allowlist).

use crate::error::{CoreError, CoreResult};
use crate::ssrf::SsrfPolicy;
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

/// Append space allowlist to CQL when the query has no `space` clause (#132).
pub fn build_scoped_cql(cfg: &ConfluenceRoConfig, cql: &str) -> String {
    let cql = cql.trim();
    if cfg.spaces.is_empty() || cql.to_lowercase().contains("space") {
        return cql.to_string();
    }
    let spaces = cfg
        .spaces
        .iter()
        .map(|s| format!("space = \"{s}\""))
        .collect::<Vec<_>>()
        .join(" OR ");
    format!("({cql}) AND ({spaces})")
}

/// Parse search JSON and filter to allowlisted spaces (pure, offline-testable).
pub fn parse_search_hits(cfg: &ConfluenceRoConfig, v: &Value) -> Vec<ConfluenceHit> {
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
    hits
}

/// Extract page text after space gate; pure for offline tests (#132).
pub fn parse_page_body(cfg: &ConfluenceRoConfig, v: &Value) -> CoreResult<String> {
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

/// CQL search (read-only). Production uses default SSRF policy.
pub async fn cql_search(
    cfg: &ConfluenceRoConfig,
    cql: &str,
    pat: &str,
    limit: usize,
) -> CoreResult<Vec<ConfluenceHit>> {
    cql_search_with_policy(cfg, cql, pat, limit, &SsrfPolicy::default()).await
}

/// CQL search with injectable SSRF policy (tests may allow loopback mock).
pub async fn cql_search_with_policy(
    cfg: &ConfluenceRoConfig,
    cql: &str,
    pat: &str,
    limit: usize,
    policy: &SsrfPolicy,
) -> CoreResult<Vec<ConfluenceHit>> {
    let (base, client) = crate::ssrf::build_pinned_client_for_url(
        &cfg.base_url,
        policy,
        &crate::ssrf::SystemResolver,
        std::time::Duration::from_secs(30),
    )?;
    let cql = build_scoped_cql(cfg, cql);
    let url = format!(
        "{}/rest/api/content/search?cql={}&limit={}",
        base.as_str().trim_end_matches('/'),
        urlencoding_encode(&cql),
        limit.min(25)
    );
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
    Ok(parse_search_hits(cfg, &v))
}

/// Fetch page body as plain-ish text (storage format stripped lightly).
pub async fn fetch_page(cfg: &ConfluenceRoConfig, page_id: &str, pat: &str) -> CoreResult<String> {
    fetch_page_with_policy(cfg, page_id, pat, &SsrfPolicy::default()).await
}

/// Fetch page with injectable SSRF policy (loopback mock in tests).
pub async fn fetch_page_with_policy(
    cfg: &ConfluenceRoConfig,
    page_id: &str,
    pat: &str,
    policy: &SsrfPolicy,
) -> CoreResult<String> {
    let (base, client) = crate::ssrf::build_pinned_client_for_url(
        &cfg.base_url,
        policy,
        &crate::ssrf::SystemResolver,
        std::time::Duration::from_secs(30),
    )?;
    let url = format!(
        "{}/rest/api/content/{}?expand=body.storage,space",
        base.as_str().trim_end_matches('/'),
        page_id
    );
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
    parse_page_body(cfg, &v)
}

/// Public for tests and skill-tool descriptions.
pub fn strip_tags(html: &str) -> String {
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

    #[test]
    fn build_scoped_cql_appends_spaces_when_missing() {
        let cfg = ConfluenceRoConfig {
            base_url: "https://example.com".into(),
            spaces: vec!["ENG".into(), "DOCS".into()],
        };
        let out = build_scoped_cql(&cfg, "text ~ \"auth\"");
        assert!(out.contains("space = \"ENG\""));
        assert!(out.contains("space = \"DOCS\""));
        assert!(out.contains("text ~ \"auth\""));
    }

    #[test]
    fn build_scoped_cql_leaves_explicit_space_clause() {
        let cfg = ConfluenceRoConfig {
            base_url: "https://example.com".into(),
            spaces: vec!["ENG".into()],
        };
        let q = "space = \"HR\" AND text ~ \"x\"";
        assert_eq!(build_scoped_cql(&cfg, q), q);
    }

    #[test]
    fn parse_search_hits_filters_spaces() {
        let cfg = ConfluenceRoConfig {
            base_url: "https://example.com".into(),
            spaces: vec!["ENG".into()],
        };
        let v = serde_json::json!({
            "results": [
                {"id": "1", "title": "ok", "space": {"key": "ENG"}, "excerpt": "a"},
                {"id": "2", "title": "no", "space": {"key": "HR"}, "excerpt": "b"}
            ]
        });
        let hits = parse_search_hits(&cfg, &v);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, "1");
    }

    #[test]
    fn parse_page_rejects_non_allowlisted_space() {
        let cfg = ConfluenceRoConfig {
            base_url: "https://example.com".into(),
            spaces: vec!["ENG".into()],
        };
        let v = serde_json::json!({
            "space": {"key": "SECRET"},
            "body": {"storage": {"value": "<p>x</p>"}}
        });
        let err = parse_page_body(&cfg, &v).unwrap_err();
        assert!(err.to_string().contains("not allowlisted"));
    }

    #[test]
    fn parse_page_strips_tags() {
        let cfg = ConfluenceRoConfig {
            base_url: "https://example.com".into(),
            spaces: vec!["ENG".into()],
        };
        let v = serde_json::json!({
            "space": {"key": "ENG"},
            "body": {"storage": {"value": "<p>Hello <b>world</b></p>"}}
        });
        assert_eq!(parse_page_body(&cfg, &v).unwrap(), "Hello world");
    }

    /// Offline mock HTTP: Bearer header + space filter + strip_tags (#132).
    #[tokio::test]
    async fn mock_http_search_and_fetch() {
        use wiremock::matchers::{header, method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/rest/api/content/search"))
            .and(header("Authorization", "Bearer test-pat"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "results": [
                    {"id": "10", "title": "Auth", "space": {"key": "ENG"}, "excerpt": "jwt"},
                    {"id": "11", "title": "HR", "space": {"key": "HR"}, "excerpt": "no"}
                ]
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/rest/api/content/10"))
            .and(header("Authorization", "Bearer test-pat"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "space": {"key": "ENG"},
                "body": {"storage": {"value": "<p>Page body</p>"}}
            })))
            .mount(&server)
            .await;

        let cfg = ConfluenceRoConfig {
            base_url: server.uri(),
            spaces: vec!["ENG".into()],
        };
        let policy = SsrfPolicy::allow_private_networks();
        let hits = cql_search_with_policy(&cfg, "text ~ \"auth\"", "test-pat", 10, &policy)
            .await
            .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].title, "Auth");

        let body = fetch_page_with_policy(&cfg, "10", "test-pat", &policy)
            .await
            .unwrap();
        assert_eq!(body, "Page body");
    }
}
