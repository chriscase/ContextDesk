//! Confluence read-only client (CQL search, page fetch, tree maneuver, space allowlist).
//!
//! #326 PR1: children, ancestors, attachments meta, expanded fetch, `space_permitted`.

use crate::error::{CoreError, CoreResult};
use crate::ssrf::SsrfPolicy;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// How `{base}` maps to the Content REST API root.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConfluenceRestPathMode {
    /// `{base}/rest/api` (Server/DC default).
    #[default]
    Standard,
    /// `{base}/wiki/rest/api` (typical Cloud).
    WikiPrefix,
    /// Same as Standard for request paths until a live probe chooses WikiPrefix.
    Auto,
}

/// Web UI URL style when `_links.webui` is missing.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConfluenceUrlStyle {
    /// `{base}/pages/viewpage.action?pageId={id}`
    #[default]
    ServerViewPage,
    /// `{base}/spaces/{space}/pages/{id}`
    CloudWiki,
    /// Prefer ServerViewPage unless rest path is WikiPrefix → CloudWiki.
    Auto,
}

/// Confluence RO config.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfluenceRoConfig {
    /// Base URL e.g. https://wiki.example.com (no trailing slash).
    pub base_url: String,
    /// Allowed space keys (empty = no filter for RO search / agent browse).
    pub spaces: Vec<String>,
    /// REST path layout. Default Standard (Server/DC).
    #[serde(default)]
    pub rest_path_mode: ConfluenceRestPathMode,
    /// Web UI URL style for link construction.
    #[serde(default)]
    pub url_style: ConfluenceUrlStyle,
}

impl ConfluenceRoConfig {
    /// Convenience constructor (Standard path, ServerViewPage URLs).
    pub fn new(base_url: impl Into<String>, spaces: Vec<String>) -> Self {
        Self {
            base_url: base_url.into(),
            spaces,
            rest_path_mode: ConfluenceRestPathMode::Standard,
            url_style: ConfluenceUrlStyle::ServerViewPage,
        }
    }
}

/// Auth material resolved in the host from keychain — never logged, never webview.
/// Passed only into HTTP call sites; pure parsers take no secrets.
#[derive(Clone)]
pub enum ConfluenceAuth {
    /// Server/DC PAT (shipped path).
    Bearer {
        /// Personal access token (never log).
        token: String,
    },
    /// Cloud email + API token → Basic.
    Basic {
        /// Account email (not secret).
        email: String,
        /// API token (never log).
        token: String,
    },
}

impl ConfluenceAuth {
    /// Build `Authorization` header value (scheme + credentials). Do not Debug-print.
    pub fn authorization_header(&self) -> String {
        match self {
            Self::Bearer { token } => format!("Bearer {token}"),
            Self::Basic { email, token } => {
                let raw = format!("{email}:{token}");
                format!("Basic {}", base64_standard(raw.as_bytes()))
            }
        }
    }

    /// Bearer from a raw PAT string (existing host path).
    pub fn bearer(pat: impl Into<String>) -> Self {
        Self::Bearer { token: pat.into() }
    }
}

impl std::fmt::Debug for ConfluenceAuth {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Bearer { .. } => f.write_str("ConfluenceAuth::Bearer([REDACTED])"),
            Self::Basic { email, .. } => {
                write!(f, "ConfluenceAuth::Basic(email={email}, [REDACTED])")
            }
        }
    }
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

/// Page metadata (tree browse / expanded fetch).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ConfluencePageMeta {
    /// Content id.
    pub id: String,
    /// Page title.
    pub title: String,
    /// Space key.
    pub space: String,
    /// Current version number when expanded.
    pub version: Option<i64>,
    /// Immediate parent content id when known from ancestors.
    pub parent_id: Option<String>,
    /// Absolute web UI URL when constructible.
    pub url: Option<String>,
    /// Label names when metadata.labels was expanded.
    pub labels: Vec<String>,
    /// Optional excerpt from search-shaped payloads.
    pub excerpt: Option<String>,
}

/// Expanded page: meta + storage body + plain strip.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfluencePageBody {
    /// Page metadata (space-gated).
    pub meta: ConfluencePageMeta,
    /// Confluence storage format (XHTML-ish).
    pub storage: String,
    /// Existing strip_tags output (compat).
    pub plain: String,
}

/// Attachment metadata only (no binary download).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AttachmentMeta {
    /// Attachment content id.
    pub id: String,
    /// File title / name.
    pub title: String,
    /// MIME type when present.
    pub media_type: Option<String>,
    /// Size in bytes when present.
    pub file_size: Option<u64>,
    /// Absolute download URL when API provides a link (open externally only).
    pub download_url: Option<String>,
}

/// Validate space is in a non-empty allowlist (case-insensitive).
///
/// **Do not use alone for empty-list semantics** — empty `cfg.spaces` makes this
/// return false for every key. Prefer [`space_permitted`].
pub fn space_allowed(cfg: &ConfluenceRoConfig, space: &str) -> bool {
    cfg.spaces.iter().any(|s| s.eq_ignore_ascii_case(space))
}

/// Space permit helper — correct empty-allowlist semantics.
///
/// - `require_allowlist = false` (RO tools / list_children / agent space roots):
///   empty list → permit all; non-empty → [`space_allowed`].
/// - `require_allowlist = true` (harvest, write, Harvest Browser tree roots):
///   empty list → **deny**; non-empty → [`space_allowed`].
pub fn space_permitted(cfg: &ConfluenceRoConfig, space: &str, require_allowlist: bool) -> bool {
    if cfg.spaces.is_empty() {
        return !require_allowlist;
    }
    space_allowed(cfg, space)
}

/// Content REST API root (`…/rest/api`), no trailing slash.
pub fn api_root(cfg: &ConfluenceRoConfig) -> String {
    let mut base = cfg.base_url.trim().trim_end_matches('/').to_string();
    match cfg.rest_path_mode {
        ConfluenceRestPathMode::WikiPrefix => {
            if !base.ends_with("/wiki") {
                base.push_str("/wiki");
            }
        }
        ConfluenceRestPathMode::Standard | ConfluenceRestPathMode::Auto => {}
    }
    format!("{base}/rest/api")
}

/// Absolute or base-relative web UI URL for a page.
pub fn construct_page_url(
    cfg: &ConfluenceRoConfig,
    page_id: &str,
    space: &str,
    webui_link: Option<&str>,
) -> Option<String> {
    let base = cfg.base_url.trim().trim_end_matches('/');
    if let Some(link) = webui_link.map(str::trim).filter(|s| !s.is_empty()) {
        if link.starts_with("http://") || link.starts_with("https://") {
            return Some(link.to_string());
        }
        if link.starts_with('/') {
            return Some(format!("{base}{link}"));
        }
        return Some(format!("{base}/{link}"));
    }
    if page_id.is_empty() {
        return None;
    }
    let style = match cfg.url_style {
        ConfluenceUrlStyle::Auto => match cfg.rest_path_mode {
            ConfluenceRestPathMode::WikiPrefix => ConfluenceUrlStyle::CloudWiki,
            _ => ConfluenceUrlStyle::ServerViewPage,
        },
        other => other,
    };
    match style {
        ConfluenceUrlStyle::CloudWiki => {
            let space = if space.is_empty() { "_" } else { space };
            Some(format!("{base}/spaces/{space}/pages/{page_id}"))
        }
        ConfluenceUrlStyle::ServerViewPage | ConfluenceUrlStyle::Auto => {
            Some(format!("{base}/pages/viewpage.action?pageId={page_id}"))
        }
    }
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
            if !space_permitted(cfg, &space, false) {
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
    if !space_permitted(cfg, space, false) {
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

/// Parse expanded content JSON into [`ConfluencePageBody`] (offline-testable).
pub fn parse_page_expanded(
    cfg: &ConfluenceRoConfig,
    v: &Value,
    require_allowlist: bool,
) -> CoreResult<ConfluencePageBody> {
    let meta = parse_page_meta(cfg, v, require_allowlist)?;
    let storage = v
        .pointer("/body/storage/value")
        .and_then(|s| s.as_str())
        .unwrap_or("")
        .to_string();
    let plain = strip_tags(&storage);
    Ok(ConfluencePageBody {
        meta,
        storage,
        plain,
    })
}

/// Parse a single content object into meta (space-gated).
pub fn parse_page_meta(
    cfg: &ConfluenceRoConfig,
    v: &Value,
    require_allowlist: bool,
) -> CoreResult<ConfluencePageMeta> {
    let space = v
        .pointer("/space/key")
        .and_then(|s| s.as_str())
        .unwrap_or("")
        .to_string();
    if !space_permitted(cfg, &space, require_allowlist) {
        if require_allowlist && cfg.spaces.is_empty() {
            return Err(CoreError::Policy(
                "spaces allowlist required for this Confluence operation".into(),
            ));
        }
        return Err(CoreError::Policy(format!(
            "space `{space}` not allowlisted"
        )));
    }
    let id = v
        .get("id")
        .and_then(|i| i.as_str())
        .unwrap_or("")
        .to_string();
    let title = v
        .get("title")
        .and_then(|t| t.as_str())
        .unwrap_or("")
        .to_string();
    let version = v
        .pointer("/version/number")
        .and_then(|n| n.as_i64())
        .or_else(|| {
            v.pointer("/version/number")
                .and_then(|n| n.as_u64())
                .map(|u| u as i64)
        });
    let parent_id = v
        .pointer("/ancestors")
        .and_then(|a| a.as_array())
        .and_then(|arr| arr.last())
        .and_then(|p| p.get("id"))
        .and_then(|i| i.as_str())
        .map(str::to_string);
    let webui = v
        .pointer("/_links/webui")
        .and_then(|s| s.as_str())
        .or_else(|| v.pointer("/_links/tinyui").and_then(|s| s.as_str()));
    let url = construct_page_url(cfg, &id, &space, webui);
    let labels = parse_labels(v);
    let excerpt = v
        .get("excerpt")
        .and_then(|e| e.as_str())
        .map(|s| s.chars().take(300).collect());
    Ok(ConfluencePageMeta {
        id,
        title,
        space,
        version,
        parent_id,
        url,
        labels,
        excerpt,
    })
}

fn parse_labels(v: &Value) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(results) = v
        .pointer("/metadata/labels/results")
        .and_then(|r| r.as_array())
    {
        for lab in results {
            if let Some(name) = lab.get("name").and_then(|n| n.as_str()) {
                out.push(name.to_string());
            }
        }
    }
    out
}

/// Parse `results` array of content objects into metas (space-gated, drops failures).
pub fn parse_content_list(
    cfg: &ConfluenceRoConfig,
    v: &Value,
    require_allowlist: bool,
) -> Vec<ConfluencePageMeta> {
    let mut out = Vec::new();
    if let Some(results) = v.get("results").and_then(|r| r.as_array()) {
        for r in results {
            if let Ok(m) = parse_page_meta(cfg, r, require_allowlist) {
                out.push(m);
            }
        }
    }
    out
}

/// Parse attachment list JSON.
pub fn parse_attachments_meta(cfg: &ConfluenceRoConfig, v: &Value) -> Vec<AttachmentMeta> {
    let base = cfg.base_url.trim().trim_end_matches('/');
    let mut out = Vec::new();
    if let Some(results) = v.get("results").and_then(|r| r.as_array()) {
        for r in results {
            let id = r
                .get("id")
                .and_then(|i| i.as_str())
                .unwrap_or("")
                .to_string();
            let title = r
                .get("title")
                .and_then(|t| t.as_str())
                .unwrap_or("")
                .to_string();
            let media_type = r
                .pointer("/metadata/mediaType")
                .and_then(|m| m.as_str())
                .or_else(|| r.get("type").and_then(|t| t.as_str()))
                .map(str::to_string);
            let file_size = r
                .pointer("/extensions/fileSize")
                .and_then(|s| s.as_u64())
                .or_else(|| {
                    r.pointer("/extensions/fileSize")
                        .and_then(|s| s.as_i64())
                        .map(|i| i as u64)
                });
            let download_url = r
                .pointer("/_links/download")
                .and_then(|s| s.as_str())
                .map(|link| {
                    if link.starts_with("http://") || link.starts_with("https://") {
                        link.to_string()
                    } else if link.starts_with('/') {
                        format!("{base}{link}")
                    } else {
                        format!("{base}/{link}")
                    }
                });
            out.push(AttachmentMeta {
                id,
                title,
                media_type,
                file_size,
                download_url,
            });
        }
    }
    out
}

/// CQL search (read-only). Bearer PAT.
pub async fn cql_search(
    cfg: &ConfluenceRoConfig,
    cql: &str,
    pat: &str,
    limit: usize,
) -> CoreResult<Vec<ConfluenceHit>> {
    cql_search_with_policy(cfg, cql, pat, limit, &SsrfPolicy::allow_private_networks()).await
}

/// CQL search with injectable SSRF policy (tests may allow loopback mock).
pub async fn cql_search_with_policy(
    cfg: &ConfluenceRoConfig,
    cql: &str,
    pat: &str,
    limit: usize,
    policy: &SsrfPolicy,
) -> CoreResult<Vec<ConfluenceHit>> {
    cql_search_auth(cfg, cql, &ConfluenceAuth::bearer(pat), limit, 0, policy).await
}

/// CQL search with auth + pagination start.
pub async fn cql_search_auth(
    cfg: &ConfluenceRoConfig,
    cql: &str,
    auth: &ConfluenceAuth,
    limit: usize,
    start: usize,
    policy: &SsrfPolicy,
) -> CoreResult<Vec<ConfluenceHit>> {
    let cql = build_scoped_cql(cfg, cql);
    let path = format!(
        "/content/search?cql={}&limit={}&start={}",
        urlencoding_encode(&cql),
        limit.min(25),
        start
    );
    let v = confluence_get_json(cfg, &path, auth, policy).await?;
    Ok(parse_search_hits(cfg, &v))
}

/// Fetch page body as plain-ish text (storage format stripped lightly).
pub async fn fetch_page(cfg: &ConfluenceRoConfig, page_id: &str, pat: &str) -> CoreResult<String> {
    fetch_page_with_policy(cfg, page_id, pat, &SsrfPolicy::allow_private_networks()).await
}

/// Fetch page with injectable SSRF policy (loopback mock in tests).
pub async fn fetch_page_with_policy(
    cfg: &ConfluenceRoConfig,
    page_id: &str,
    pat: &str,
    policy: &SsrfPolicy,
) -> CoreResult<String> {
    let body =
        fetch_page_expanded(cfg, page_id, &ConfluenceAuth::bearer(pat), policy, false).await?;
    Ok(body.plain)
}

/// Fetch page with expands (meta + storage + plain).
pub async fn fetch_page_expanded(
    cfg: &ConfluenceRoConfig,
    page_id: &str,
    auth: &ConfluenceAuth,
    policy: &SsrfPolicy,
    require_allowlist: bool,
) -> CoreResult<ConfluencePageBody> {
    let path =
        format!("/content/{page_id}?expand=body.storage,space,version,ancestors,metadata.labels");
    let v = confluence_get_json(cfg, &path, auth, policy).await?;
    parse_page_expanded(cfg, &v, require_allowlist)
}

/// List direct child pages of a parent content id.
pub async fn list_child_pages(
    cfg: &ConfluenceRoConfig,
    parent_id: &str,
    start: usize,
    limit: usize,
    auth: &ConfluenceAuth,
    policy: &SsrfPolicy,
    require_allowlist: bool,
) -> CoreResult<Vec<ConfluencePageMeta>> {
    let limit = limit.clamp(1, 25);
    let path = format!(
        "/content/{parent_id}/child/page?limit={limit}&start={start}&expand=space,version,ancestors"
    );
    let v = confluence_get_json(cfg, &path, auth, policy).await?;
    Ok(parse_content_list(cfg, &v, require_allowlist))
}

/// List ancestors (breadcrumb) for a page.
pub async fn list_ancestors(
    cfg: &ConfluenceRoConfig,
    page_id: &str,
    auth: &ConfluenceAuth,
    policy: &SsrfPolicy,
    require_allowlist: bool,
) -> CoreResult<Vec<ConfluencePageMeta>> {
    let path = format!("/content/{page_id}?expand=ancestors,space,version");
    let v = confluence_get_json(cfg, &path, auth, policy).await?;
    // Gate the page itself first.
    let _ = parse_page_meta(cfg, &v, require_allowlist)?;
    let mut out = Vec::new();
    if let Some(arr) = v.get("ancestors").and_then(|a| a.as_array()) {
        for a in arr {
            // Ancestors may omit nested space; inherit from page when missing.
            let mut obj = a.clone();
            if obj.pointer("/space/key").is_none() {
                if let Some(sk) = v.pointer("/space/key") {
                    if let Some(map) = obj.as_object_mut() {
                        map.insert(
                            "space".into(),
                            serde_json::json!({ "key": sk.as_str().unwrap_or("") }),
                        );
                    }
                }
            }
            if let Ok(m) = parse_page_meta(cfg, &obj, require_allowlist) {
                out.push(m);
            }
        }
    }
    Ok(out)
}

/// List attachment metadata for a page (no binary).
pub async fn list_attachments_meta(
    cfg: &ConfluenceRoConfig,
    page_id: &str,
    auth: &ConfluenceAuth,
    policy: &SsrfPolicy,
    require_allowlist: bool,
) -> CoreResult<Vec<AttachmentMeta>> {
    // Confirm page is space-permitted first.
    let path_page = format!("/content/{page_id}?expand=space");
    let page = confluence_get_json(cfg, &path_page, auth, policy).await?;
    let _ = parse_page_meta(cfg, &page, require_allowlist)?;
    let path = format!("/content/{page_id}/child/attachment?limit=25&expand=version");
    let v = confluence_get_json(cfg, &path, auth, policy).await?;
    Ok(parse_attachments_meta(cfg, &v))
}

/// Space root pages (no parent) for tree browse.
///
/// Agent RO: `require_allowlist=false`. Harvest Browser: `true`.
pub async fn list_space_root_pages(
    cfg: &ConfluenceRoConfig,
    space_key: &str,
    start: usize,
    limit: usize,
    auth: &ConfluenceAuth,
    policy: &SsrfPolicy,
    require_allowlist: bool,
) -> CoreResult<Vec<ConfluencePageMeta>> {
    let space_key = space_key.trim();
    if space_key.is_empty() {
        return Err(CoreError::Message(
            "list_space_root_pages requires space key".into(),
        ));
    }
    if !space_permitted(cfg, space_key, require_allowlist) {
        if require_allowlist && cfg.spaces.is_empty() {
            return Err(CoreError::Policy(
                "spaces allowlist required for this Confluence operation".into(),
            ));
        }
        return Err(CoreError::Policy(format!(
            "space `{space_key}` not allowlisted"
        )));
    }
    let limit = limit.clamp(1, 25);
    let cql = format!("space = \"{space_key}\" AND type = page AND parent is null ORDER BY title");
    let path = format!(
        "/content/search?cql={}&limit={}&start={}&expand=space,version",
        urlencoding_encode(&cql),
        limit,
        start
    );
    let v = confluence_get_json(cfg, &path, auth, policy).await?;
    let mut roots = parse_content_list(cfg, &v, require_allowlist);
    if roots.is_empty() && start == 0 {
        // Fallback: homepage children (many Server/DC spaces have no orphan roots).
        let space_path = format!("/space/{}?expand=homepage", urlencoding_encode(space_key));
        if let Ok(space_v) = confluence_get_json(cfg, &space_path, auth, policy).await {
            if let Some(home_id) = space_v
                .pointer("/homepage/id")
                .and_then(|i| i.as_str())
                .filter(|s| !s.is_empty())
            {
                roots =
                    list_child_pages(cfg, home_id, start, limit, auth, policy, require_allowlist)
                        .await?;
            }
        }
    }
    Ok(roots)
}

async fn confluence_get_json(
    cfg: &ConfluenceRoConfig,
    path_and_query: &str,
    auth: &ConfluenceAuth,
    policy: &SsrfPolicy,
) -> CoreResult<Value> {
    let (base, client) = crate::ssrf::build_pinned_client_for_url(
        &cfg.base_url,
        policy,
        &crate::ssrf::SystemResolver,
        std::time::Duration::from_secs(30),
    )?;
    // Prefer api_root from config (may rewrite /wiki), but pinned client is for base_url.
    // If WikiPrefix, requests go to base/wiki/rest/api — ensure host still matches pinned base.
    let root = api_root(cfg);
    // When wiremock/tests set base_url to mock server, api_root uses that host.
    // If SSRF rewrote base slightly, fall back to pinned base + /rest/api path.
    let url = if root.starts_with(base.as_str().trim_end_matches('/'))
        || root.contains(&base.host_str().unwrap_or_default().to_string())
    {
        format!("{}{}", root.trim_end_matches('/'), path_and_query)
    } else {
        // Pinned origin from SSRF (e.g. normalized); append Standard rest path + query.
        let origin = base.as_str().trim_end_matches('/');
        let rest = match cfg.rest_path_mode {
            ConfluenceRestPathMode::WikiPrefix => format!("{origin}/wiki/rest/api"),
            _ => format!("{origin}/rest/api"),
        };
        format!("{rest}{path_and_query}")
    };
    let resp = client
        .get(&url)
        .header("Authorization", auth.authorization_header())
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| CoreError::Message(format_confluence_transport_error(&e)))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(CoreError::Message(format_confluence_http_error(
            status.as_u16(),
            &body,
        )));
    }
    resp.json()
        .await
        .map_err(|e| CoreError::Message(format!("confluence json: {e}")))
}

/// Classify connect/TLS failures (never include PAT). Used by search/fetch.
fn format_confluence_transport_error(err: &reqwest::Error) -> String {
    let mut parts = vec!["confluence transport error".to_string()];
    if err.is_timeout() {
        parts.push("timeout".into());
    }
    if err.is_connect() {
        parts.push("connect failed (VPN/proxy/DNS?)".into());
    }
    if err.is_request() {
        parts.push("request build/send".into());
    }
    let full = err.to_string();
    let lower = full.to_ascii_lowercase();
    if lower.contains("certificate")
        || lower.contains("cert")
        || lower.contains("tls")
        || lower.contains("ssl")
        || lower.contains("handshake")
    {
        parts.push("TLS/certificate — corp CA may need to be in the OS trust store".into());
    }
    let safe = full
        .split('?')
        .next()
        .unwrap_or(&full)
        .chars()
        .take(180)
        .collect::<String>();
    parts.push(safe);
    parts.join(": ")
}

/// Map HTTP failures to actionable messages (no PAT; body truncated).
fn format_confluence_http_error(status: u16, body: &str) -> String {
    let snippet: String = body.chars().take(160).collect();
    match status {
        401 | 403 => format!(
            "confluence HTTP {status} (auth) — check PAT in keychain; Server/DC PATs use Authorization: Bearer <token>; Cloud often needs Basic (email+token)"
        ),
        404 => format!(
            "confluence HTTP 404 — base URL or path wrong (expect …/rest/api/…; Cloud may need /wiki prefix): {snippet}"
        ),
        _ => format!("confluence HTTP {status}: {snippet}"),
    }
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

/// Minimal standard Base64 (no padding issues; used only for Basic auth header).
fn base64_standard(input: &[u8]) -> String {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    let mut i = 0;
    while i + 3 <= input.len() {
        let n = ((input[i] as u32) << 16) | ((input[i + 1] as u32) << 8) | (input[i + 2] as u32);
        out.push(T[((n >> 18) & 63) as usize] as char);
        out.push(T[((n >> 12) & 63) as usize] as char);
        out.push(T[((n >> 6) & 63) as usize] as char);
        out.push(T[(n & 63) as usize] as char);
        i += 3;
    }
    match input.len() - i {
        1 => {
            let n = (input[i] as u32) << 16;
            out.push(T[((n >> 18) & 63) as usize] as char);
            out.push(T[((n >> 12) & 63) as usize] as char);
            out.push('=');
            out.push('=');
        }
        2 => {
            let n = ((input[i] as u32) << 16) | ((input[i + 1] as u32) << 8);
            out.push(T[((n >> 18) & 63) as usize] as char);
            out.push(T[((n >> 12) & 63) as usize] as char);
            out.push(T[((n >> 6) & 63) as usize] as char);
            out.push('=');
        }
        _ => {}
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg_eng() -> ConfluenceRoConfig {
        ConfluenceRoConfig::new("https://example.com", vec!["ENG".into()])
    }

    #[test]
    fn space_gate() {
        let cfg = cfg_eng();
        assert!(space_allowed(&cfg, "ENG"));
        assert!(!space_allowed(&cfg, "HR"));
    }

    #[test]
    fn space_permitted_empty_allowlist() {
        let cfg = ConfluenceRoConfig::new("https://example.com", vec![]);
        assert!(space_permitted(&cfg, "ANY", false));
        assert!(!space_permitted(&cfg, "ANY", true));
        // bare space_allowed is wrong for empty list:
        assert!(!space_allowed(&cfg, "ANY"));
    }

    #[test]
    fn space_permitted_nonempty() {
        let cfg = cfg_eng();
        assert!(space_permitted(&cfg, "eng", false));
        assert!(space_permitted(&cfg, "ENG", true));
        assert!(!space_permitted(&cfg, "HR", true));
    }

    #[test]
    fn api_root_standard_and_wiki() {
        let mut cfg = ConfluenceRoConfig::new("https://wiki.example.com", vec![]);
        assert_eq!(api_root(&cfg), "https://wiki.example.com/rest/api");
        cfg.rest_path_mode = ConfluenceRestPathMode::WikiPrefix;
        assert_eq!(api_root(&cfg), "https://wiki.example.com/wiki/rest/api");
        cfg.base_url = "https://wiki.example.com/wiki".into();
        assert_eq!(api_root(&cfg), "https://wiki.example.com/wiki/rest/api");
    }

    #[test]
    fn construct_url_server_and_cloud() {
        let mut cfg = ConfluenceRoConfig::new("https://wiki.example.com", vec![]);
        assert_eq!(
            construct_page_url(&cfg, "42", "ENG", None).as_deref(),
            Some("https://wiki.example.com/pages/viewpage.action?pageId=42")
        );
        cfg.url_style = ConfluenceUrlStyle::CloudWiki;
        assert_eq!(
            construct_page_url(&cfg, "42", "ENG", None).as_deref(),
            Some("https://wiki.example.com/spaces/ENG/pages/42")
        );
        assert_eq!(
            construct_page_url(&cfg, "42", "ENG", Some("/display/ENG/Page")).as_deref(),
            Some("https://wiki.example.com/display/ENG/Page")
        );
    }

    #[test]
    fn auth_header_bearer_and_basic() {
        let b = ConfluenceAuth::bearer("tok");
        assert_eq!(b.authorization_header(), "Bearer tok");
        let basic = ConfluenceAuth::Basic {
            email: "a@b.co".into(),
            token: "pat".into(),
        };
        assert!(basic.authorization_header().starts_with("Basic "));
        let dbg = format!("{basic:?}");
        assert!(!dbg.contains("pat"));
        assert!(dbg.contains("REDACTED"));
    }

    #[test]
    fn strip_basic_html() {
        assert_eq!(strip_tags("<p>Hello</p>"), "Hello");
    }

    #[test]
    fn http_error_auth_is_actionable() {
        let msg = format_confluence_http_error(401, "Unauthorized");
        assert!(msg.contains("401"));
        assert!(msg.to_ascii_lowercase().contains("auth") || msg.contains("PAT"));
    }

    #[test]
    fn http_error_truncates_body() {
        let long = "x".repeat(500);
        let msg = format_confluence_http_error(500, &long);
        assert!(msg.len() < 400);
        assert!(msg.contains("500"));
    }

    #[test]
    fn build_scoped_cql_appends_spaces_when_missing() {
        let cfg = ConfluenceRoConfig::new("https://example.com", vec!["ENG".into(), "DOCS".into()]);
        let out = build_scoped_cql(&cfg, "text ~ \"auth\"");
        assert!(out.contains("space = \"ENG\""));
        assert!(out.contains("space = \"DOCS\""));
        assert!(out.contains("text ~ \"auth\""));
    }

    #[test]
    fn build_scoped_cql_leaves_explicit_space_clause() {
        let cfg = cfg_eng();
        let q = "space = \"HR\" AND text ~ \"x\"";
        assert_eq!(build_scoped_cql(&cfg, q), q);
    }

    #[test]
    fn parse_search_hits_filters_spaces() {
        let cfg = cfg_eng();
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
        let cfg = cfg_eng();
        let v = serde_json::json!({
            "space": {"key": "SECRET"},
            "body": {"storage": {"value": "<p>x</p>"}}
        });
        let err = parse_page_body(&cfg, &v).unwrap_err();
        assert!(err.to_string().contains("not allowlisted"));
    }

    #[test]
    fn parse_page_strips_tags() {
        let cfg = cfg_eng();
        let v = serde_json::json!({
            "space": {"key": "ENG"},
            "body": {"storage": {"value": "<p>Hello <b>world</b></p>"}}
        });
        assert_eq!(parse_page_body(&cfg, &v).unwrap(), "Hello world");
    }

    #[test]
    fn parse_page_expanded_meta() {
        let cfg = cfg_eng();
        let v = serde_json::json!({
            "id": "99",
            "title": "Runbook",
            "space": {"key": "ENG"},
            "version": {"number": 7},
            "ancestors": [{"id": "1", "title": "Root"}],
            "metadata": {"labels": {"results": [{"name": "ops"}]}},
            "_links": {"webui": "/pages/viewpage.action?pageId=99"},
            "body": {"storage": {"value": "<p>Hi</p>"}}
        });
        let body = parse_page_expanded(&cfg, &v, false).unwrap();
        assert_eq!(body.meta.id, "99");
        assert_eq!(body.meta.version, Some(7));
        assert_eq!(body.meta.parent_id.as_deref(), Some("1"));
        assert_eq!(body.meta.labels, vec!["ops"]);
        assert_eq!(body.plain, "Hi");
        assert!(body.meta.url.as_ref().unwrap().contains("pageId=99"));
    }

    #[test]
    fn parse_page_meta_require_allowlist_empty_denies() {
        let cfg = ConfluenceRoConfig::new("https://example.com", vec![]);
        let v = serde_json::json!({
            "id": "1",
            "title": "x",
            "space": {"key": "ENG"}
        });
        let err = parse_page_meta(&cfg, &v, true).unwrap_err();
        assert!(err.to_string().contains("allowlist required"));
    }

    #[test]
    fn parse_attachments() {
        let cfg = cfg_eng();
        let v = serde_json::json!({
            "results": [{
                "id": "att-1",
                "title": "diagram.png",
                "metadata": {"mediaType": "image/png"},
                "extensions": {"fileSize": 1024},
                "_links": {"download": "/download/attachments/1/diagram.png"}
            }]
        });
        let list = parse_attachments_meta(&cfg, &v);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].title, "diagram.png");
        assert_eq!(list[0].file_size, Some(1024));
        assert!(list[0]
            .download_url
            .as_ref()
            .unwrap()
            .starts_with("https://example.com/"));
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
                "id": "10",
                "title": "Auth",
                "space": {"key": "ENG"},
                "version": {"number": 1},
                "body": {"storage": {"value": "<p>Page body</p>"}}
            })))
            .mount(&server)
            .await;

        let cfg = ConfluenceRoConfig::new(server.uri(), vec!["ENG".into()]);
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

    #[tokio::test]
    async fn mock_http_children_and_space_roots() {
        use wiremock::matchers::{method, path, query_param};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/rest/api/content/100/child/page"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "results": [
                    {
                        "id": "101",
                        "title": "Child",
                        "space": {"key": "ENG"},
                        "version": {"number": 2},
                        "ancestors": [{"id": "100"}]
                    }
                ]
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/rest/api/content/search"))
            .and(query_param(
                "cql",
                "space = \"ENG\" AND type = page AND parent is null ORDER BY title",
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "results": [{
                    "id": "100",
                    "title": "Root",
                    "space": {"key": "ENG"},
                    "version": {"number": 1}
                }]
            })))
            .mount(&server)
            .await;

        let cfg = ConfluenceRoConfig::new(server.uri(), vec!["ENG".into()]);
        let auth = ConfluenceAuth::bearer("test-pat");
        let policy = SsrfPolicy::allow_private_networks();
        let kids = list_child_pages(&cfg, "100", 0, 10, &auth, &policy, false)
            .await
            .unwrap();
        assert_eq!(kids.len(), 1);
        assert_eq!(kids[0].id, "101");
        assert_eq!(kids[0].parent_id.as_deref(), Some("100"));

        let roots = list_space_root_pages(&cfg, "ENG", 0, 10, &auth, &policy, false)
            .await
            .unwrap();
        assert_eq!(roots.len(), 1);
        assert_eq!(roots[0].title, "Root");

        // Empty allowlist + require_allowlist blocks space roots
        let open = ConfluenceRoConfig::new(server.uri(), vec![]);
        let err = list_space_root_pages(&open, "ENG", 0, 10, &auth, &policy, true)
            .await
            .unwrap_err();
        assert!(err.to_string().contains("allowlist required"));
    }
}
