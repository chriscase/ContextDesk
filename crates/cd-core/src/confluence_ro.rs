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

/// A successful Confluence read plus bounded retry/recovery trail notes.
///
/// Keeping the notes beside the value prevents callers from silently dropping
/// transient-recovery evidence before it reaches the user-facing tool result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfluenceRead<T> {
    /// Parsed response value.
    pub value: T,
    /// Secret-free retry/recovery notes, empty when no retry occurred.
    pub retry_notes: Vec<String>,
}

impl<T> ConfluenceRead<T> {
    fn map<U>(self, f: impl FnOnce(T) -> U) -> ConfluenceRead<U> {
        ConfluenceRead {
            value: f(self.value),
            retry_notes: self.retry_notes,
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

/// Hard cap on storage-format body bytes retained for model-facing context.
/// Oversized remote HTML is truncated with an explicit marker (not silently dropped).
pub const MAX_PAGE_STORAGE_BYTES: usize = 256 * 1024;

/// Hard cap on plain-text after strip_tags for tool results.
pub const MAX_PAGE_PLAIN_CHARS: usize = 48_000;

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
    let bounded = bound_storage_body(storage);
    Ok(bound_plain_text(&strip_tags(&bounded)))
}

/// Parse expanded content JSON into [`ConfluencePageBody`] (offline-testable).
pub fn parse_page_expanded(
    cfg: &ConfluenceRoConfig,
    v: &Value,
    require_allowlist: bool,
) -> CoreResult<ConfluencePageBody> {
    let meta = parse_page_meta(cfg, v, require_allowlist)?;
    let storage_raw = v
        .pointer("/body/storage/value")
        .and_then(|s| s.as_str())
        .unwrap_or("");
    let storage = bound_storage_body(storage_raw);
    let plain = bound_plain_text(&strip_tags(&storage));
    Ok(ConfluencePageBody {
        meta,
        storage,
        plain,
    })
}

/// Bound storage XHTML and defang obvious script/handler payloads before strip.
#[allow(clippy::string_slice)] // end always on a char boundary after the walk-back loop
fn bound_storage_body(storage: &str) -> String {
    let scrubbed = sanitize_storage_html(storage);
    if scrubbed.len() <= MAX_PAGE_STORAGE_BYTES {
        return scrubbed;
    }
    let mut end = MAX_PAGE_STORAGE_BYTES;
    while end > 0 && !scrubbed.is_char_boundary(end) {
        end -= 1;
    }
    format!(
        "{}…[truncated for Confluence page body budget; original_bytes={}]",
        &scrubbed[..end],
        storage.len()
    )
}

fn bound_plain_text(plain: &str) -> String {
    let count = plain.chars().count();
    if count <= MAX_PAGE_PLAIN_CHARS {
        return plain.to_string();
    }
    let body: String = plain.chars().take(MAX_PAGE_PLAIN_CHARS).collect();
    format!("{body}…[truncated for Confluence plain-text budget; original_chars={count}]")
}

/// Remove script blocks and obvious event-handler attributes from storage HTML.
/// Pure, offline-testable sanitizer — not a full HTML security parser.
///
/// Operates on ASCII tags/attributes; multi-byte body text is preserved via
/// char-boundary-safe advancement.
#[allow(clippy::string_slice)] // indices advance on UTF-8 char boundaries only
pub fn sanitize_storage_html(input: &str) -> String {
    // Normalize by removing script elements and javascript: schemes case-insensitively.
    let without_scripts = strip_script_elements(input);
    without_scripts
        .replace("javascript:", "[blocked-scheme]")
        .replace("JAVASCRIPT:", "[blocked-scheme]")
        .replace("Javascript:", "[blocked-scheme]")
}

#[allow(clippy::string_slice)] // indices from ASCII marker finds on both strings
fn strip_script_elements(input: &str) -> String {
    let lower = input.to_ascii_lowercase();
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    let mut rest_lower = lower.as_str();
    while let Some(start) = rest_lower.find("<script") {
        out.push_str(&rest[..start]);
        let after = &rest_lower[start..];
        if let Some(end_rel) = after.find("</script>") {
            let skip = end_rel + "</script>".len();
            rest = &rest[start + skip..];
            rest_lower = &rest_lower[start + skip..];
        } else {
            // Unclosed script: drop the remainder.
            return out;
        }
    }
    out.push_str(rest);
    out
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
                format!(
                    "confluence:misconfigured: spaces allowlist required for this operation. Add space keys under {CONFLUENCE_SETTINGS_PATH}."
                ),
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
) -> CoreResult<ConfluenceRead<Vec<ConfluenceHit>>> {
    cql_search_with_policy(cfg, cql, pat, limit, &SsrfPolicy::allow_private_networks()).await
}

/// CQL search with injectable SSRF policy (tests may allow loopback mock).
pub async fn cql_search_with_policy(
    cfg: &ConfluenceRoConfig,
    cql: &str,
    pat: &str,
    limit: usize,
    policy: &SsrfPolicy,
) -> CoreResult<ConfluenceRead<Vec<ConfluenceHit>>> {
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
) -> CoreResult<ConfluenceRead<Vec<ConfluenceHit>>> {
    let cql = build_scoped_cql(cfg, cql);
    let path = format!(
        "/content/search?cql={}&limit={}&start={}",
        urlencoding_encode(&cql),
        limit.min(25),
        start
    );
    let response = confluence_get_json(cfg, &path, auth, policy).await?;
    Ok(response.map(|v| parse_search_hits(cfg, &v)))
}

/// Fetch page body as plain-ish text (storage format stripped lightly).
pub async fn fetch_page(
    cfg: &ConfluenceRoConfig,
    page_id: &str,
    pat: &str,
) -> CoreResult<ConfluenceRead<String>> {
    fetch_page_with_policy(cfg, page_id, pat, &SsrfPolicy::allow_private_networks()).await
}

/// Fetch page with injectable SSRF policy (loopback mock in tests).
pub async fn fetch_page_with_policy(
    cfg: &ConfluenceRoConfig,
    page_id: &str,
    pat: &str,
    policy: &SsrfPolicy,
) -> CoreResult<ConfluenceRead<String>> {
    let body =
        fetch_page_expanded(cfg, page_id, &ConfluenceAuth::bearer(pat), policy, false).await?;
    Ok(body.map(|body| body.plain))
}

/// Fetch page with expands (meta + storage + plain).
pub async fn fetch_page_expanded(
    cfg: &ConfluenceRoConfig,
    page_id: &str,
    auth: &ConfluenceAuth,
    policy: &SsrfPolicy,
    require_allowlist: bool,
) -> CoreResult<ConfluenceRead<ConfluencePageBody>> {
    let path =
        format!("/content/{page_id}?expand=body.storage,space,version,ancestors,metadata.labels");
    let response = confluence_get_json(cfg, &path, auth, policy).await?;
    let body = parse_page_expanded(cfg, &response.value, require_allowlist)?;
    Ok(ConfluenceRead {
        value: body,
        retry_notes: response.retry_notes,
    })
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
) -> CoreResult<ConfluenceRead<Vec<ConfluencePageMeta>>> {
    let limit = limit.clamp(1, 25);
    let path = format!(
        "/content/{parent_id}/child/page?limit={limit}&start={start}&expand=space,version,ancestors"
    );
    let response = confluence_get_json(cfg, &path, auth, policy).await?;
    Ok(response.map(|v| parse_content_list(cfg, &v, require_allowlist)))
}

/// List ancestors (breadcrumb) for a page.
pub async fn list_ancestors(
    cfg: &ConfluenceRoConfig,
    page_id: &str,
    auth: &ConfluenceAuth,
    policy: &SsrfPolicy,
    require_allowlist: bool,
) -> CoreResult<ConfluenceRead<Vec<ConfluencePageMeta>>> {
    let path = format!("/content/{page_id}?expand=ancestors,space,version");
    let response = confluence_get_json(cfg, &path, auth, policy).await?;
    let v = &response.value;
    // Gate the page itself first.
    let _ = parse_page_meta(cfg, v, require_allowlist)?;
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
    Ok(ConfluenceRead {
        value: out,
        retry_notes: response.retry_notes,
    })
}

/// List attachment metadata for a page (no binary).
pub async fn list_attachments_meta(
    cfg: &ConfluenceRoConfig,
    page_id: &str,
    auth: &ConfluenceAuth,
    policy: &SsrfPolicy,
    require_allowlist: bool,
) -> CoreResult<ConfluenceRead<Vec<AttachmentMeta>>> {
    // Confirm page is space-permitted first.
    let path_page = format!("/content/{page_id}?expand=space");
    let page = confluence_get_json(cfg, &path_page, auth, policy).await?;
    let _ = parse_page_meta(cfg, &page.value, require_allowlist)?;
    let path = format!("/content/{page_id}/child/attachment?limit=25&expand=version");
    let attachments = confluence_get_json(cfg, &path, auth, policy).await?;
    let mut retry_notes = page.retry_notes;
    retry_notes.extend(attachments.retry_notes);
    Ok(ConfluenceRead {
        value: parse_attachments_meta(cfg, &attachments.value),
        retry_notes,
    })
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
) -> CoreResult<ConfluenceRead<Vec<ConfluencePageMeta>>> {
    let space_key = space_key.trim();
    if space_key.is_empty() {
        return Err(CoreError::Message(
            "list_space_root_pages requires space key".into(),
        ));
    }
    if !space_permitted(cfg, space_key, require_allowlist) {
        if require_allowlist && cfg.spaces.is_empty() {
            return Err(CoreError::Policy(
                format!(
                    "confluence:misconfigured: spaces allowlist required for this operation. Add space keys under {CONFLUENCE_SETTINGS_PATH}."
                ),
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
    let response = confluence_get_json(cfg, &path, auth, policy).await?;
    let mut retry_notes = response.retry_notes;
    let mut roots = parse_content_list(cfg, &response.value, require_allowlist);
    if roots.is_empty() && start == 0 {
        // Fallback: homepage children (many Server/DC spaces have no orphan roots).
        let space_path = format!("/space/{}?expand=homepage", urlencoding_encode(space_key));
        match confluence_get_json(cfg, &space_path, auth, policy).await {
            Ok(space_response) => {
                retry_notes.extend(space_response.retry_notes);
                if let Some(home_id) = space_response
                    .value
                    .pointer("/homepage/id")
                    .and_then(|i| i.as_str())
                    .filter(|s| !s.is_empty())
                {
                    let children = list_child_pages(
                        cfg,
                        home_id,
                        start,
                        limit,
                        auth,
                        policy,
                        require_allowlist,
                    )
                    .await?;
                    retry_notes.extend(children.retry_notes);
                    roots = children.value;
                }
            }
            Err(e) if e.to_string().contains("not_found") => {}
            Err(e) => return Err(e),
        }
    }
    Ok(ConfluenceRead {
        value: roots,
        retry_notes,
    })
}

/// Create a page (HardWrite path — caller enforces write_enabled + WRITE confirm).
pub async fn create_page(
    cfg: &ConfluenceRoConfig,
    space: &str,
    title: &str,
    body_storage: &str,
    parent_id: Option<&str>,
    auth: &ConfluenceAuth,
    policy: &SsrfPolicy,
) -> CoreResult<ConfluencePageMeta> {
    if !space_permitted(cfg, space, true) {
        if cfg.spaces.is_empty() {
            return Err(CoreError::Policy(
                format!(
                    "confluence:misconfigured: spaces allowlist required for Confluence write. Add space keys under {CONFLUENCE_SETTINGS_PATH}."
                ),
            ));
        }
        return Err(CoreError::Policy(format!(
            "space `{space}` not allowlisted for write"
        )));
    }
    let mut ancestors = Vec::new();
    if let Some(pid) = parent_id.filter(|s| !s.is_empty()) {
        ancestors.push(serde_json::json!({ "id": pid }));
    }
    let payload = serde_json::json!({
        "type": "page",
        "title": title,
        "space": { "key": space },
        "body": {
            "storage": {
                "value": body_storage,
                "representation": "storage"
            }
        },
        "ancestors": ancestors
    });
    let v = confluence_post_json(cfg, "/content", &payload, auth, policy).await?;
    parse_page_meta(cfg, &v, true)
}

/// Update page body (and optional title). Requires current version for optimistic lock.
pub async fn update_page(
    cfg: &ConfluenceRoConfig,
    page_id: &str,
    title: Option<&str>,
    body_storage: &str,
    version: i64,
    auth: &ConfluenceAuth,
    policy: &SsrfPolicy,
) -> CoreResult<ConfluencePageMeta> {
    // Load current to verify space allowlist
    let body = fetch_page_expanded(cfg, page_id, auth, policy, true)
        .await?
        .value;
    let space = body.meta.space.as_str();
    if !space_permitted(cfg, space, true) {
        return Err(CoreError::Policy(format!(
            "space `{space}` not allowlisted for write"
        )));
    }
    let title = title.unwrap_or(body.meta.title.as_str());
    let payload = serde_json::json!({
        "id": page_id,
        "type": "page",
        "title": title,
        "space": { "key": space },
        "body": {
            "storage": {
                "value": body_storage,
                "representation": "storage"
            }
        },
        "version": { "number": version + 1 }
    });
    let path = format!("/content/{page_id}");
    let v = confluence_put_json(cfg, &path, &payload, auth, policy).await?;
    parse_page_meta(cfg, &v, true)
}

async fn confluence_post_json(
    cfg: &ConfluenceRoConfig,
    path_and_query: &str,
    body: &Value,
    auth: &ConfluenceAuth,
    policy: &SsrfPolicy,
) -> CoreResult<Value> {
    confluence_mutate_json(cfg, path_and_query, body, auth, policy, true).await
}

async fn confluence_put_json(
    cfg: &ConfluenceRoConfig,
    path_and_query: &str,
    body: &Value,
    auth: &ConfluenceAuth,
    policy: &SsrfPolicy,
) -> CoreResult<Value> {
    confluence_mutate_json(cfg, path_and_query, body, auth, policy, false).await
}

async fn confluence_mutate_json(
    cfg: &ConfluenceRoConfig,
    path_and_query: &str,
    body: &Value,
    auth: &ConfluenceAuth,
    policy: &SsrfPolicy,
    post: bool,
) -> CoreResult<Value> {
    let (base, client) = crate::ssrf::build_pinned_client_for_url(
        &cfg.base_url,
        policy,
        &crate::ssrf::SystemResolver,
        std::time::Duration::from_secs(30),
    )?;
    let root = api_root(cfg);
    let url = if root.starts_with(base.as_str().trim_end_matches('/'))
        || root.contains(&base.host_str().unwrap_or_default().to_string())
    {
        format!("{}{}", root.trim_end_matches('/'), path_and_query)
    } else {
        let origin = base.as_str().trim_end_matches('/');
        let rest = match cfg.rest_path_mode {
            ConfluenceRestPathMode::WikiPrefix => format!("{origin}/wiki/rest/api"),
            _ => format!("{origin}/rest/api"),
        };
        format!("{rest}{path_and_query}")
    };
    let builder = if post {
        client.post(&url)
    } else {
        client.put(&url)
    };
    let resp = builder
        .header("Authorization", auth.authorization_header())
        .header("Accept", "application/json")
        .header("Content-Type", "application/json")
        .json(body)
        .send()
        .await
        .map_err(|e| CoreError::Message(format_confluence_transport_error(&e)))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(CoreError::Message(format_confluence_http_error(
            status.as_u16(),
            &text,
        )));
    }
    resp.json()
        .await
        .map_err(|e| CoreError::Message(format!("confluence json: {e}")))
}

async fn confluence_get_json(
    cfg: &ConfluenceRoConfig,
    path_and_query: &str,
    auth: &ConfluenceAuth,
    policy: &SsrfPolicy,
) -> CoreResult<ConfluenceRead<Value>> {
    confluence_get_json_with_retry(cfg, path_and_query, auth, policy).await
}

#[derive(Debug)]
struct ConfluenceRequestError {
    error: CoreError,
    status: Option<u16>,
}

impl ConfluenceRequestError {
    fn transport(error: CoreError) -> Self {
        Self {
            error,
            status: None,
        }
    }

    fn http(status: u16, message: String) -> Self {
        Self {
            error: CoreError::Message(message),
            status: Some(status),
        }
    }
}

async fn confluence_get_json_once(
    cfg: &ConfluenceRoConfig,
    path_and_query: &str,
    auth: &ConfluenceAuth,
    policy: &SsrfPolicy,
) -> Result<Value, ConfluenceRequestError> {
    let (base, client) = crate::ssrf::build_pinned_client_for_url(
        &cfg.base_url,
        policy,
        &crate::ssrf::SystemResolver,
        std::time::Duration::from_secs(30),
    )
    .map_err(ConfluenceRequestError::transport)?;
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
        .map_err(|e| {
            ConfluenceRequestError::transport(CoreError::Message(
                format_confluence_transport_error(&e),
            ))
        })?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(ConfluenceRequestError::http(
            status.as_u16(),
            format_confluence_http_error(status.as_u16(), &body),
        ));
    }
    resp.json()
        .await
        .map_err(|_| {
            ConfluenceRequestError::transport(CoreError::Message(
                "confluence:other: invalid JSON response — Check the base URL and REST path mode under Settings → Connectors → Confluence.".into(),
            ))
        })
}

/// Stable error class for Confluence failures (#452 / #457). Never includes PAT.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfluenceErrorKind {
    /// HTTP 401.
    Unauthorized,
    /// HTTP 403.
    Forbidden,
    /// HTTP 404 or missing resource.
    NotFound,
    /// HTTP 429.
    RateLimited,
    /// HTTP 400 with CQL / query parse markers.
    BadCql,
    /// Transport / timeout / TLS.
    Network,
    /// Missing URL, PAT, or connector off.
    Misconfigured,
    /// Fallback.
    Other,
}

impl ConfluenceErrorKind {
    /// Wire/stable token for messages and tests.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Unauthorized => "unauthorized",
            Self::Forbidden => "forbidden",
            Self::NotFound => "not_found",
            Self::RateLimited => "rate_limited",
            Self::BadCql => "bad_cql",
            Self::Network => "network",
            Self::Misconfigured => "misconfigured",
            Self::Other => "other",
        }
    }
}

/// Settings path used in user-facing Confluence errors.
pub const CONFLUENCE_SETTINGS_PATH: &str = "Settings → Connectors → Confluence";

/// Classify HTTP status + body (offline-testable).
pub fn classify_confluence_http(status: u16, body: &str) -> ConfluenceErrorKind {
    let lower = body.to_ascii_lowercase();
    match status {
        401 => ConfluenceErrorKind::Unauthorized,
        403 => ConfluenceErrorKind::Forbidden,
        404 => ConfluenceErrorKind::NotFound,
        429 => ConfluenceErrorKind::RateLimited,
        400 if lower.contains("cql")
            || lower.contains("query")
            || lower.contains("parse")
            || lower.contains("syntax") =>
        {
            ConfluenceErrorKind::BadCql
        }
        500..=599 => ConfluenceErrorKind::Other,
        _ => ConfluenceErrorKind::Other,
    }
}

/// Format a classified Confluence error for users/agents (no secrets).
pub fn format_confluence_error(
    kind: ConfluenceErrorKind,
    status: Option<u16>,
    detail: &str,
) -> String {
    let snippet: String = detail.chars().take(120).collect();
    let status_bit = status.map(|s| format!(" HTTP {s}")).unwrap_or_default();
    let next = match kind {
        ConfluenceErrorKind::Unauthorized => {
            format!("Re-save PAT under {CONFLUENCE_SETTINGS_PATH} (Bearer for Server/DC; Cloud often email+token Basic).")
        }
        ConfluenceErrorKind::Forbidden => {
            format!("Check PAT scopes/space access; if using a space allowlist, add the space key under {CONFLUENCE_SETTINGS_PATH}.")
        }
        ConfluenceErrorKind::NotFound => {
            format!("Check base URL and REST path mode under {CONFLUENCE_SETTINGS_PATH} (Cloud may need /wiki).")
        }
        ConfluenceErrorKind::RateLimited => {
            "Wait and retry; product may auto-retry transient 429s.".into()
        }
        ConfluenceErrorKind::BadCql => {
            "Fix CQL or use free-text search; example: space = \"ENG\" AND type = page.".into()
        }
        ConfluenceErrorKind::Network => {
            "Check VPN/DNS/proxy and that the corp CA is in the OS trust store.".into()
        }
        ConfluenceErrorKind::Misconfigured => {
            format!("Open {CONFLUENCE_SETTINGS_PATH}, set base URL + PAT, Save, then Test.")
        }
        ConfluenceErrorKind::Other => {
            format!("If this persists, re-check {CONFLUENCE_SETTINGS_PATH}.")
        }
    };
    if snippet.is_empty() {
        format!(
            "confluence:{}:{} — {next}",
            kind.as_str(),
            status_bit.trim()
        )
    } else {
        format!(
            "confluence:{}:{} {snippet} — {next}",
            kind.as_str(),
            status_bit.trim()
        )
    }
}

/// Classify connect/TLS failures (never include PAT). Used by search/fetch.
fn format_confluence_transport_error(err: &reqwest::Error) -> String {
    let mut categories = Vec::new();
    if err.is_timeout() {
        categories.push("timeout");
    }
    if err.is_connect() {
        categories.push("connect failed");
    }
    let full = err.to_string();
    let lower = full.to_ascii_lowercase();
    if lower.contains("certificate")
        || lower.contains("cert")
        || lower.contains("tls")
        || lower.contains("ssl")
        || lower.contains("handshake")
    {
        categories.push("TLS/certificate");
    }
    let detail = if categories.is_empty() {
        "request failed".to_string()
    } else {
        categories.join(", ")
    };
    format_confluence_error(ConfluenceErrorKind::Network, None, &detail)
}

/// Map HTTP failures to actionable messages.
///
/// The response body is used only for classification and is never included in
/// returned diagnostics because a remote server or proxy can reflect secrets.
pub fn format_confluence_http_error(status: u16, body: &str) -> String {
    let kind = classify_confluence_http(status, body);
    format_confluence_error(kind, Some(status), "")
}

/// One Confluence space row from discovery (#452 / #456).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ConfluenceSpace {
    /// Space key (e.g. ENG).
    pub key: String,
    /// Display name.
    pub name: String,
}

/// Default max spaces returned by list/probe.
pub const DEFAULT_SPACE_LIST_LIMIT: usize = 50;
/// Hard cap for space list.
pub const MAX_SPACE_LIST_LIMIT: usize = 100;

/// Parse space list JSON (offline-testable).
pub fn parse_space_list(v: &Value, limit: usize) -> Vec<ConfluenceSpace> {
    let limit = limit.clamp(1, MAX_SPACE_LIST_LIMIT);
    let mut out = Vec::new();
    let results = v
        .get("results")
        .and_then(|r| r.as_array())
        .cloned()
        .unwrap_or_default();
    for item in results {
        let key = item
            .get("key")
            .and_then(|k| k.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if key.is_empty() {
            continue;
        }
        let name = item
            .get("name")
            .and_then(|n| n.as_str())
            .unwrap_or(key.as_str())
            .trim()
            .to_string();
        out.push(ConfluenceSpace { key, name });
        if out.len() >= limit {
            break;
        }
    }
    out
}

/// List spaces the PAT can see (Read; SSRF-safe client).
///
/// Second return value is retry/trail notes (e.g. `confluence:rate_limited: retrying…`).
pub async fn list_spaces(
    cfg: &ConfluenceRoConfig,
    auth: &ConfluenceAuth,
    policy: &SsrfPolicy,
    limit: usize,
) -> CoreResult<ConfluenceRead<Vec<ConfluenceSpace>>> {
    let limit = limit.clamp(1, MAX_SPACE_LIST_LIMIT);
    let path = format!("/space?limit={limit}&type=global");
    let response = confluence_get_json_with_retry(cfg, &path, auth, policy).await?;
    Ok(response.map(|v| parse_space_list(&v, limit)))
}

/// Result of a live connection probe (#452 Settings).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ConfluenceProbeResult {
    /// Whether the probe succeeded.
    pub ok: bool,
    /// Human message (no PAT).
    pub message: String,
    /// Spaces returned if list worked (capped).
    pub spaces_seen: usize,
}

/// Probe Confluence: SSRF-valid base + authenticated space list (or lightweight GET).
pub async fn probe_connection(
    cfg: &ConfluenceRoConfig,
    auth: &ConfluenceAuth,
    policy: &SsrfPolicy,
) -> CoreResult<ConfluenceProbeResult> {
    if cfg.base_url.trim().is_empty() {
        return Ok(ConfluenceProbeResult {
            ok: false,
            message: format_confluence_error(
                ConfluenceErrorKind::Misconfigured,
                None,
                "base URL empty",
            ),
            spaces_seen: 0,
        });
    }
    match list_spaces(cfg, auth, policy, 5).await {
        Ok(response) => {
            let spaces = response.value;
            let notes = response.retry_notes;
            let mut message = format!(
                "OK: authenticated; saw {} space(s) (sample). Allowlist has {} key(s). Empty allowlist does not block RO; harvest/write need keys. {CONFLUENCE_SETTINGS_PATH}",
                spaces.len(),
                cfg.spaces.len()
            );
            if !notes.is_empty() {
                message.push_str(" | ");
                message.push_str(&notes.join(" "));
            }
            Ok(ConfluenceProbeResult {
                ok: true,
                message,
                spaces_seen: spaces.len(),
            })
        }
        Err(e) => Ok(ConfluenceProbeResult {
            ok: false,
            message: e.to_string(),
            spaces_seen: 0,
        }),
    }
}

/// Max additional attempts after the first failure for retryable statuses.
const CONFLUENCE_MAX_RETRIES: u32 = 2;

#[derive(Debug, Clone, Copy)]
struct ConfluenceRetryPolicy {
    delays_ms: [u64; CONFLUENCE_MAX_RETRIES as usize],
}

impl ConfluenceRetryPolicy {
    #[cfg(not(test))]
    const fn production() -> Self {
        Self {
            delays_ms: [200, 400],
        }
    }

    #[cfg(test)]
    const fn no_delay() -> Self {
        Self { delays_ms: [0, 0] }
    }

    fn delay_ms(self, attempt: u32) -> u64 {
        self.delays_ms
            .get(attempt as usize)
            .copied()
            .unwrap_or_default()
    }
}

fn active_retry_policy() -> ConfluenceRetryPolicy {
    #[cfg(test)]
    {
        ConfluenceRetryPolicy::no_delay()
    }
    #[cfg(not(test))]
    {
        ConfluenceRetryPolicy::production()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ConfluenceRetryKind {
    RateLimited,
    TransientServer,
}

impl ConfluenceRetryKind {
    fn token(self) -> &'static str {
        match self {
            Self::RateLimited => "rate_limited",
            Self::TransientServer => "transient_server",
        }
    }
}

fn retry_kind(status: Option<u16>) -> Option<ConfluenceRetryKind> {
    match status {
        Some(429) => Some(ConfluenceRetryKind::RateLimited),
        Some(500..=599) => Some(ConfluenceRetryKind::TransientServer),
        _ => None,
    }
}

/// GET with bounded 429/5xx retry (#452 / #459). Not cancellable mid-flight.
///
/// Returns JSON plus trail notes such as `confluence:rate_limited: retrying…`
/// (surfaced in tool detail / probe messages).
async fn confluence_get_json_with_retry(
    cfg: &ConfluenceRoConfig,
    path_and_query: &str,
    auth: &ConfluenceAuth,
    policy: &SsrfPolicy,
) -> CoreResult<ConfluenceRead<Value>> {
    confluence_get_json_with_retry_policy(cfg, path_and_query, auth, policy, active_retry_policy())
        .await
}

async fn confluence_get_json_with_retry_policy(
    cfg: &ConfluenceRoConfig,
    path_and_query: &str,
    auth: &ConfluenceAuth,
    policy: &SsrfPolicy,
    retry_policy: ConfluenceRetryPolicy,
) -> CoreResult<ConfluenceRead<Value>> {
    let mut attempt = 0u32;
    let mut notes: Vec<String> = Vec::new();
    let mut last_retry_kind: Option<ConfluenceRetryKind> = None;
    loop {
        match confluence_get_json_once(cfg, path_and_query, auth, policy).await {
            Ok(v) => {
                if let Some(kind) = last_retry_kind {
                    notes.push(format!(
                        "confluence:{}: recovered after retry",
                        kind.token()
                    ));
                }
                return Ok(ConfluenceRead {
                    value: v,
                    retry_notes: notes,
                });
            }
            Err(failure) => {
                let kind = retry_kind(failure.status);
                if attempt < CONFLUENCE_MAX_RETRIES {
                    let Some(kind) = kind else {
                        return Err(failure.error);
                    };
                    let backoff_ms = retry_policy.delay_ms(attempt);
                    notes.push(format!(
                        "confluence:{}: retrying (attempt {}) after {backoff_ms}ms…",
                        kind.token(),
                        attempt + 1
                    ));
                    last_retry_kind = Some(kind);
                    if backoff_ms > 0 {
                        tokio::time::sleep(std::time::Duration::from_millis(backoff_ms)).await;
                    }
                    attempt += 1;
                    continue;
                }
                let msg = failure.error.to_string();
                if !notes.is_empty() {
                    return Err(CoreError::Message(format!(
                        "{msg} (exhausted {attempt} retry attempt(s); {})",
                        notes.join(" ")
                    )));
                }
                return Err(failure.error);
            }
        }
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
    fn sanitize_blocks_script_and_javascript_scheme() {
        let dirty = r#"<p>hi</p><script>alert(1)</script><a href="javascript:alert(2)">x</a>"#;
        let clean = sanitize_storage_html(dirty);
        assert!(!clean.to_ascii_lowercase().contains("<script"));
        assert!(!clean.to_ascii_lowercase().contains("javascript:"));
        assert!(clean.contains("[blocked-scheme]") || clean.contains("hi"));
    }

    #[test]
    fn oversized_storage_is_bounded_with_marker() {
        let cfg = cfg_eng();
        let huge = "A".repeat(MAX_PAGE_STORAGE_BYTES + 5_000);
        let v = serde_json::json!({
            "id": "1",
            "title": "Huge",
            "space": {"key": "ENG"},
            "version": {"number": 1},
            "body": {"storage": {"value": format!("<p>{huge}</p>")}}
        });
        let body = parse_page_expanded(&cfg, &v, false).unwrap();
        assert!(body.storage.len() <= MAX_PAGE_STORAGE_BYTES + 120);
        assert!(body
            .storage
            .contains("truncated for Confluence page body budget"));
        assert!(body.plain.chars().count() <= MAX_PAGE_PLAIN_CHARS + 80);
    }

    #[test]
    fn http_error_auth_is_actionable() {
        let msg = format_confluence_http_error(401, "Unauthorized");
        assert!(msg.contains("401") || msg.contains("unauthorized"));
        assert!(
            msg.contains("unauthorized")
                || msg.contains("PAT")
                || msg.contains(CONFLUENCE_SETTINGS_PATH)
        );
        assert_eq!(
            classify_confluence_http(401, "nope"),
            ConfluenceErrorKind::Unauthorized
        );
        assert_eq!(
            classify_confluence_http(429, "slow"),
            ConfluenceErrorKind::RateLimited
        );
        assert_eq!(
            classify_confluence_http(400, "CQL parse error"),
            ConfluenceErrorKind::BadCql
        );
        let forbidden = format_confluence_http_error(403, "Forbidden");
        assert!(forbidden.contains("forbidden"));
        assert!(forbidden.contains(CONFLUENCE_SETTINGS_PATH) || forbidden.contains("space"));
    }

    #[test]
    fn http_error_omits_remote_body_and_reflected_credentials() {
        let bearer = "Bearer reflected-secret-pat";
        let basic = "Basic dXNlcjpyZWZsZWN0ZWQtdG9rZW4=";
        let userinfo = "https://user:reflected-password@wiki.example.test";
        let body = format!(
            "proxy failure authorization={bearer} fallback={basic} upstream={userinfo} \
             access_token=reflected-query-token password=reflected-body-password"
        );
        let msg = format_confluence_http_error(500, &body);
        assert!(msg.contains("other") || msg.contains("500"));
        for secret in [
            "reflected-secret-pat",
            "dXNlcjpyZWZsZWN0ZWQtdG9rZW4=",
            "reflected-password",
            "reflected-query-token",
            "reflected-body-password",
            "proxy failure",
        ] {
            assert!(!msg.contains(secret), "secret/body leaked in `{msg}`");
        }
    }

    #[test]
    fn parse_space_list_caps_and_keys() {
        let v = serde_json::json!({
            "results": [
                {"key": "ENG", "name": "Engineering"},
                {"key": "", "name": "skip"},
                {"key": "DOCS", "name": "Docs"}
            ]
        });
        let spaces = parse_space_list(&v, 10);
        assert_eq!(spaces.len(), 2);
        assert_eq!(spaces[0].key, "ENG");
        assert_eq!(spaces[1].name, "Docs");
        assert_eq!(parse_space_list(&v, 1).len(), 1);
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
        assert_eq!(hits.value.len(), 1);
        assert_eq!(hits.value[0].title, "Auth");

        let body = fetch_page_with_policy(&cfg, "10", "test-pat", &policy)
            .await
            .unwrap();
        assert_eq!(body.value, "Page body");
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
            .respond_with(ResponseTemplate::new(500).set_body_string("transient"))
            .up_to_n_times(1)
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
        assert_eq!(kids.value.len(), 1);
        assert_eq!(kids.value[0].id, "101");
        assert_eq!(kids.value[0].parent_id.as_deref(), Some("100"));

        let roots = list_space_root_pages(&cfg, "ENG", 0, 10, &auth, &policy, false)
            .await
            .unwrap();
        assert_eq!(roots.value.len(), 1);
        assert_eq!(roots.value[0].title, "Root");
        assert!(
            roots
                .retry_notes
                .iter()
                .any(|note| note.contains("transient_server")
                    && note.contains("recovered after retry")),
            "{:?}",
            roots.retry_notes
        );

        // Empty allowlist + require_allowlist blocks space roots
        let open = ConfluenceRoConfig::new(server.uri(), vec![]);
        let err = list_space_root_pages(&open, "ENG", 0, 10, &auth, &policy, true)
            .await
            .unwrap_err();
        assert!(
            err.to_string().contains("allowlist") || err.to_string().contains("misconfigured"),
            "{err}"
        );
    }

    #[tokio::test]
    async fn mock_list_spaces_and_429_retry() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        // First request → 429; subsequent → success (retry path).
        Mock::given(method("GET"))
            .and(path("/rest/api/space"))
            .respond_with(ResponseTemplate::new(429).set_body_string("rate limited"))
            .up_to_n_times(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/rest/api/space"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "results": [
                    {"key": "ENG", "name": "Engineering"},
                    {"key": "OPS", "name": "Ops"}
                ]
            })))
            .mount(&server)
            .await;

        let cfg = ConfluenceRoConfig::new(server.uri(), vec![]);
        let auth = ConfluenceAuth::bearer("test-pat");
        let policy = SsrfPolicy::allow_private_networks();
        let response = list_spaces(&cfg, &auth, &policy, 10).await.unwrap();
        assert_eq!(response.value.len(), 2);
        assert_eq!(response.value[0].key, "ENG");
        assert!(
            response
                .retry_notes
                .iter()
                .any(|n| n.contains("confluence:rate_limited: retrying")),
            "expected retry trail note, got {:?}",
            response.retry_notes
        );
        assert!(
            response
                .retry_notes
                .iter()
                .any(|n| n.contains("confluence:rate_limited: recovered after retry")),
            "expected recovery note, got {:?}",
            response.retry_notes
        );

        let probe = probe_connection(&cfg, &auth, &policy).await.unwrap();
        assert!(probe.ok, "{}", probe.message);
        assert!(probe.message.contains("OK") || probe.message.contains("authenticated"));
    }

    async fn assert_retry_status(status: u16, expected_token: &str) {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/rest/api/space"))
            .respond_with(
                ResponseTemplate::new(status)
                    .set_body_string("reflected-secret-pat should never escape"),
            )
            .up_to_n_times(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/rest/api/space"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "results": [{"key": "ENG", "name": "Engineering"}]
            })))
            .mount(&server)
            .await;

        let cfg = ConfluenceRoConfig::new(server.uri(), vec![]);
        let auth = ConfluenceAuth::bearer("reflected-secret-pat");
        let policy = SsrfPolicy::allow_private_networks();
        let response = confluence_get_json_with_retry_policy(
            &cfg,
            "/space?limit=5&type=global",
            &auth,
            &policy,
            ConfluenceRetryPolicy::no_delay(),
        )
        .await
        .unwrap();
        assert_eq!(
            response
                .value
                .pointer("/results/0/key")
                .and_then(Value::as_str),
            Some("ENG")
        );
        assert!(
            response
                .retry_notes
                .iter()
                .any(|note| note.contains(expected_token) && note.contains("recovered")),
            "{:?}",
            response.retry_notes
        );
        assert!(response
            .retry_notes
            .iter()
            .all(|note| !note.contains("reflected-secret-pat")));
        assert_eq!(server.received_requests().await.unwrap().len(), 2);
    }

    #[tokio::test]
    async fn retry_matrix_covers_429_500_and_503() {
        assert_retry_status(429, "rate_limited").await;
        assert_retry_status(500, "transient_server").await;
        assert_retry_status(503, "transient_server").await;
    }

    #[tokio::test]
    async fn retry_exhaustion_is_bounded_and_scrubs_remote_body() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/rest/api/space"))
            .respond_with(ResponseTemplate::new(500).set_body_string(
                "Bearer reflected-secret-pat access_token=reflected-query-token \
                         password=reflected-body-password",
            ))
            .mount(&server)
            .await;
        let cfg = ConfluenceRoConfig::new(server.uri(), vec![]);
        let auth = ConfluenceAuth::bearer("reflected-secret-pat");
        let policy = SsrfPolicy::allow_private_networks();
        let err = confluence_get_json_with_retry_policy(
            &cfg,
            "/space?limit=5&type=global",
            &auth,
            &policy,
            ConfluenceRetryPolicy::no_delay(),
        )
        .await
        .unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("exhausted 2 retry attempt"), "{msg}");
        assert!(msg.contains("transient_server"), "{msg}");
        assert!(!msg.contains("reflected-secret-pat"), "{msg}");
        assert!(!msg.contains("reflected-query-token"), "{msg}");
        assert!(!msg.contains("reflected-body-password"), "{msg}");
        assert_eq!(server.received_requests().await.unwrap().len(), 3);

        let probe = probe_connection(&cfg, &auth, &policy).await.unwrap();
        assert!(!probe.ok, "{}", probe.message);
        assert!(!probe.message.contains("reflected-secret-pat"));
        assert!(!probe.message.contains("reflected-query-token"));
        assert!(!probe.message.contains("reflected-body-password"));
        assert_eq!(server.received_requests().await.unwrap().len(), 6);
    }

    async fn assert_non_retryable_status(status: u16) {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/rest/api/space"))
            .respond_with(ResponseTemplate::new(status).set_body_string("reflected-secret-pat"))
            .mount(&server)
            .await;
        let cfg = ConfluenceRoConfig::new(server.uri(), vec![]);
        let auth = ConfluenceAuth::bearer("reflected-secret-pat");
        let policy = SsrfPolicy::allow_private_networks();
        let err = confluence_get_json_with_retry_policy(
            &cfg,
            "/space?limit=5&type=global",
            &auth,
            &policy,
            ConfluenceRetryPolicy::no_delay(),
        )
        .await
        .unwrap_err();
        assert!(!err.to_string().contains("reflected-secret-pat"));
        assert_eq!(server.received_requests().await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn auth_failures_are_not_retried() {
        assert_non_retryable_status(400).await;
        assert_non_retryable_status(401).await;
        assert_non_retryable_status(403).await;
        assert_non_retryable_status(404).await;
    }

    #[tokio::test]
    async fn mutation_failure_is_not_retried_and_scrubs_remote_body() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/rest/api/content"))
            .respond_with(
                ResponseTemplate::new(503).set_body_string(
                    "Bearer reflected-secret-pat access_token=reflected-query-token",
                ),
            )
            .mount(&server)
            .await;
        let cfg = ConfluenceRoConfig::new(server.uri(), vec!["ENG".into()]);
        let auth = ConfluenceAuth::bearer("reflected-secret-pat");
        let policy = SsrfPolicy::allow_private_networks();
        let err = create_page(&cfg, "ENG", "Title", "<p>safe</p>", None, &auth, &policy)
            .await
            .unwrap_err();
        let msg = err.to_string();
        assert!(!msg.contains("reflected-secret-pat"), "{msg}");
        assert!(!msg.contains("reflected-query-token"), "{msg}");
        assert_eq!(server.received_requests().await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn successful_read_has_no_retry_trail() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/rest/api/space"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "results": []
            })))
            .mount(&server)
            .await;
        let cfg = ConfluenceRoConfig::new(server.uri(), vec![]);
        let auth = ConfluenceAuth::bearer("test-pat");
        let policy = SsrfPolicy::allow_private_networks();
        let response = list_spaces(&cfg, &auth, &policy, 5).await.unwrap();
        assert!(response.retry_notes.is_empty());
        assert_eq!(server.received_requests().await.unwrap().len(), 1);
    }
}
