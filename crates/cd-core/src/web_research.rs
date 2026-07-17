//! Opt-in open-web research tools: SSRF-safe fetch + DuckDuckGo HTML search.
//!
//! Default off. Agent-callable only when the host enables web research.
//! Not unrestricted curl: scheme/host/IP policy, no credentials in URL,
//! limited redirects, timeout + response size caps.
//!
//! DDG HTML is unofficial and best-effort — parse failures return empty results.

use crate::error::{CoreError, CoreResult};
use crate::ssrf::{validate_provider_url, SsrfPolicy};
use serde::{Deserialize, Serialize};
use url::Url;

/// Max raw HTTP body bytes retained for extraction.
pub const MAX_BODY_BYTES: usize = 512 * 1024;
/// Max characters returned to the model after HTML→text.
pub const MAX_TEXT_CHARS: usize = 24_000;
/// Max redirects followed (each hop re-validated).
pub const MAX_REDIRECTS: usize = 3;
/// Per-request timeout.
pub const REQUEST_TIMEOUT_SECS: u64 = 20;
/// Default number of search hits returned when limit is omitted.
pub const DEFAULT_SEARCH_LIMIT: usize = 8;
/// Hard ceiling for `web_search` result count.
pub const MAX_SEARCH_LIMIT: usize = 15;

/// Strict policy for agent open-web requests (no loopback, no private nets).
pub fn web_ssrf_policy() -> SsrfPolicy {
    SsrfPolicy {
        block_private: true,
        allow_loopback: false,
    }
}

/// One search hit.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WebSearchHit {
    /// Result title.
    pub title: String,
    /// Absolute URL.
    pub url: String,
    /// Snippet / excerpt.
    pub snippet: String,
}

/// Fetched page extract.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WebFetchResult {
    /// Final URL after redirects.
    pub url: String,
    /// Document title if found.
    pub title: String,
    /// Truncated plain text.
    pub text: String,
    /// HTTP status of the final response.
    pub status: u16,
}

/// Validate a user/agent-supplied URL for web tools.
///
/// Stricter than provider probes: rejects credentials in URL, non-http(s),
/// and loopback/private/metadata under [`web_ssrf_policy`].
pub fn validate_web_url(raw: &str) -> CoreResult<Url> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err(CoreError::Policy("empty URL".into()));
    }
    let url = validate_provider_url(raw, &web_ssrf_policy())
        .map_err(|e| CoreError::Policy(format!("web URL rejected: {e}")))?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err(CoreError::Policy(
            "credentials in URL are not allowed for web research".into(),
        ));
    }
    // Fragment-only noise is fine; block data/javascript already via scheme.
    Ok(url)
}

/// Best-effort HTML → readable text (scripts/styles dropped, tags stripped).
/// Title is extracted separately via [`extract_title`]; body text only here.
pub fn html_to_text(html: &str) -> String {
    let cleaned = strip_blocks(html, &["script", "style", "noscript", "svg", "template"]);
    let body = strip_tags(&cleaned);
    collapse_ws(&body).chars().take(MAX_TEXT_CHARS).collect()
}

/// Extract `<title>` content if present.
pub fn extract_title(html: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let Some(start) = lower.find("<title") else {
        return String::new();
    };
    let after = &html[start..];
    let Some(gt) = after.find('>') else {
        return String::new();
    };
    let rest = &after[gt + 1..];
    let rest_l = rest.to_ascii_lowercase();
    let end = rest_l.find("</title>").unwrap_or(rest.len().min(500));
    collapse_ws(&strip_tags(&rest[..end]))
        .chars()
        .take(300)
        .collect()
}

fn strip_blocks(html: &str, tags: &[&str]) -> String {
    let mut out = html.to_string();
    for tag in tags {
        let open_pat = format!("<{tag}");
        let close_pat = format!("</{tag}>");
        loop {
            let lower = out.to_ascii_lowercase();
            let Some(start) = find_tag_open(&lower, &open_pat) else {
                break;
            };
            let Some(close_rel) = lower[start..].find(&close_pat) else {
                // Unclosed: drop open tag only.
                if let Some(gt) = lower[start..].find('>') {
                    out = format!("{}{}", &out[..start], &out[start + gt + 1..]);
                } else {
                    break;
                }
                continue;
            };
            let end = start + close_rel + close_pat.len();
            out = format!("{}{}", &out[..start], &out[end..]);
        }
    }
    out
}

/// Find `<tag` followed by a non-name character (so `<scripted` is not `<script`).
fn find_tag_open(lower: &str, open_pat: &str) -> Option<usize> {
    let mut from = 0;
    while let Some(rel) = lower[from..].find(open_pat) {
        let start = from + rel;
        let after = start + open_pat.len();
        let ok = if after >= lower.len() {
            true
        } else {
            let c = lower.as_bytes()[after];
            !c.is_ascii_alphanumeric()
        };
        if ok {
            return Some(start);
        }
        from = start + 1;
    }
    None
}

fn strip_tags(html: &str) -> String {
    let mut out = String::with_capacity(html.len() / 2);
    let mut in_tag = false;
    for c in html.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    // Basic entities
    out.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
}

fn collapse_ws(s: &str) -> String {
    let mut out = String::new();
    let mut prev_space = false;
    for c in s.chars() {
        if c.is_whitespace() {
            if !prev_space {
                out.push(' ');
                prev_space = true;
            }
        } else {
            out.push(c);
            prev_space = false;
        }
    }
    out.trim().to_string()
}

fn urlencoding_encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            b' ' => out.push_str("%20"),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn build_client() -> CoreResult<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(REQUEST_TIMEOUT_SECS))
        // Manual redirects so each hop is SSRF-checked.
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(concat!(
            "ContextDesk/",
            env!("CARGO_PKG_VERSION"),
            " (web research; user-enabled)"
        ))
        .build()
        .map_err(|e| CoreError::Message(format!("http client: {e}")))
}

/// Fetch a URL, follow limited redirects, return text extract.
pub async fn web_fetch(url: &str) -> CoreResult<WebFetchResult> {
    let mut current = validate_web_url(url)?;
    let client = build_client()?;

    for hop in 0..=MAX_REDIRECTS {
        let resp = client
            .get(current.as_str())
            .header(
                "Accept",
                "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
            )
            .send()
            .await
            .map_err(|e| CoreError::Message(format!("web_fetch: {e}")))?;

        let status = resp.status();
        if status.is_redirection() {
            if hop == MAX_REDIRECTS {
                return Err(CoreError::Policy(format!(
                    "too many redirects (max {MAX_REDIRECTS})"
                )));
            }
            let loc = resp
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| CoreError::Message("redirect without Location".into()))?;
            current = resolve_redirect(&current, loc)?;
            continue;
        }

        if !status.is_success() {
            return Err(CoreError::Message(format!(
                "web_fetch HTTP {} for {}",
                status.as_u16(),
                current
            )));
        }

        // Reject oversized Content-Length when advertised (before download).
        if let Some(cl) = resp.content_length() {
            if cl > MAX_BODY_BYTES as u64 * 4 {
                return Err(CoreError::Policy(format!(
                    "response Content-Length {cl} exceeds safety cap"
                )));
            }
        }

        let bytes = read_body_capped(resp).await?;
        // Lossy UTF-8 for binary-ish pages
        let html = String::from_utf8_lossy(&bytes);
        let title = extract_title(&html);
        let text = html_to_text(&html);
        return Ok(WebFetchResult {
            url: current.to_string(),
            title,
            text,
            status: status.as_u16(),
        });
    }

    Err(CoreError::Policy("redirect loop".into()))
}

fn resolve_redirect(base: &Url, location: &str) -> CoreResult<Url> {
    let joined = base
        .join(location)
        .map_err(|e| CoreError::Message(format!("bad redirect: {e}")))?;
    validate_web_url(joined.as_str())
}

/// Sanitize search query (length + control chars).
pub fn sanitize_search_query(q: &str) -> CoreResult<String> {
    let q = q.trim();
    if q.is_empty() {
        return Err(CoreError::Message("web_search requires query".into()));
    }
    if q.len() > 400 {
        return Err(CoreError::Message(
            "web_search query too long (max 400 chars)".into(),
        ));
    }
    // Strip control characters that could mess with form POST.
    let cleaned: String = q
        .chars()
        .filter(|c| !c.is_control() || *c == '\n' || *c == '\t')
        .collect();
    let cleaned = cleaned.trim();
    if cleaned.is_empty() {
        return Err(CoreError::Message("web_search requires query".into()));
    }
    Ok(cleaned.to_string())
}

/// Clamp result limit.
pub fn clamp_search_limit(limit: Option<u64>) -> usize {
    limit
        .unwrap_or(DEFAULT_SEARCH_LIMIT as u64)
        .clamp(1, MAX_SEARCH_LIMIT as u64) as usize
}

/// DuckDuckGo HTML lite search (best-effort, no API key).
///
/// On block/parse failure returns empty `Ok(vec![])` with no panic — callers
/// surface a graceful summary.
pub async fn web_search_ddg(query: &str, limit: usize) -> CoreResult<Vec<WebSearchHit>> {
    let q = sanitize_search_query(query)?;
    let limit = limit.clamp(1, MAX_SEARCH_LIMIT);
    // Official-ish HTML endpoint used by many scrapers; fragile.
    let search_url = format!(
        "https://html.duckduckgo.com/html/?q={}",
        urlencoding_encode(&q)
    );
    // Validate our own search URL under SSRF (public HTTPS).
    let _ = validate_web_url(&search_url)?;

    let client = build_client()?;
    let resp = client
        .get(&search_url)
        .header("Accept", "text/html")
        .send()
        .await
        .map_err(|e| CoreError::Message(format!("web_search: {e}")))?;

    if !resp.status().is_success() {
        // Graceful empty (rate limit / block)
        tracing::warn!(status = %resp.status(), "web_search DDG non-success");
        return Ok(vec![]);
    }

    let bytes = match read_body_capped(resp).await {
        Ok(b) => b,
        Err(e) => {
            tracing::warn!(error = %e, "web_search body read failed");
            return Ok(vec![]);
        }
    };
    let html = String::from_utf8_lossy(&bytes);
    Ok(parse_ddg_html(&html, limit))
}

/// Read response body stopping after [`MAX_BODY_BYTES`] (does not buffer full multi-MB pages).
async fn read_body_capped(resp: reqwest::Response) -> CoreResult<Vec<u8>> {
    use futures_util::StreamExt;
    let mut stream = resp.bytes_stream();
    let mut buf = Vec::with_capacity(64 * 1024);
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| CoreError::Message(format!("body stream: {e}")))?;
        let remaining = MAX_BODY_BYTES.saturating_sub(buf.len());
        if remaining == 0 {
            break;
        }
        if chunk.len() <= remaining {
            buf.extend_from_slice(&chunk);
        } else {
            buf.extend_from_slice(&chunk[..remaining]);
            break;
        }
    }
    Ok(buf)
}

/// Parse DuckDuckGo HTML results page (fixture-friendly).
///
/// Looks for classic `result__a` links and optional `result__snippet` text.
pub fn parse_ddg_html(html: &str, limit: usize) -> Vec<WebSearchHit> {
    let limit = limit.clamp(1, MAX_SEARCH_LIMIT);
    let mut hits = Vec::new();
    let mut rest = html;

    while hits.len() < limit {
        // Find result link: class="result__a" href="..."
        let Some(idx) = rest.find("result__a") else {
            break;
        };
        // Prefer scanning from nearby <a (class may appear after href).
        let search_from = rest[..idx].rfind("<a").unwrap_or(idx);
        let chunk = &rest[search_from..];
        let chunk_end = chunk
            .find("</a>")
            .map(|i| i + 4)
            .unwrap_or(chunk.len().min(2000));
        let a_tag = &chunk[..chunk_end];

        let href = extract_attr(a_tag, "href").unwrap_or_default();
        let title = collapse_ws(&strip_tags(a_tag));

        // Absolute URL; DDG sometimes uses //duckduckgo.com/l/?uddg=
        let url = normalize_ddg_url(&href);

        // Snippet: look ahead for result__snippet
        let after = &rest[search_from + chunk_end..];
        let snippet = extract_next_snippet(after);

        rest = &rest[search_from + chunk_end..];

        if url.is_empty() || title.is_empty() {
            continue;
        }
        // Skip DDG internal links
        if url.contains("duckduckgo.com") && !url.contains("uddg=") {
            continue;
        }
        // Validate public URL; drop private/metadata hits
        if validate_web_url(&url).is_err() {
            continue;
        }

        hits.push(WebSearchHit {
            title: title.chars().take(200).collect(),
            url,
            snippet: snippet.chars().take(400).collect(),
        });
    }

    // Fallback: bare result blocks with uddg=
    if hits.is_empty() {
        hits = parse_ddg_uddg_fallback(html, limit);
    }

    hits
}

fn extract_attr(tag: &str, name: &str) -> Option<String> {
    // href="..." or href='...'
    let patterns = [
        format!("{name}=\""),
        format!("{name}='"),
        format!("{name} = \""),
    ];
    for p in &patterns {
        if let Some(i) = tag.find(p) {
            let start = i + p.len();
            let quote = if p.ends_with('\'') { '\'' } else { '"' };
            if let Some(end) = tag[start..].find(quote) {
                return Some(tag[start..start + end].to_string());
            }
        }
    }
    None
}

fn extract_next_snippet(after: &str) -> String {
    let lower = after.to_ascii_lowercase();
    // Cap look-ahead so we don't steal next result's text
    let window = &after[..after.len().min(2500)];
    let window_l = &lower[..lower.len().min(2500)];
    if let Some(si) = window_l.find("result__snippet") {
        let from = &window[si..];
        if let Some(gt) = from.find('>') {
            let body = &from[gt + 1..];
            let end = body
                .to_ascii_lowercase()
                .find("</")
                .unwrap_or(body.len().min(500));
            return collapse_ws(&strip_tags(&body[..end]));
        }
    }
    String::new()
}

/// Unwrap DDG redirect URLs to the real destination when present.
pub fn normalize_ddg_url(href: &str) -> String {
    let href = href.trim();
    if href.is_empty() {
        return String::new();
    }
    // Protocol-relative
    let abs = if href.starts_with("//") {
        format!("https:{href}")
    } else if href.starts_with('/') {
        format!("https://duckduckgo.com{href}")
    } else {
        href.to_string()
    };

    // https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com&...
    if let Ok(u) = Url::parse(&abs) {
        if u.host_str()
            .map(|h| h.contains("duckduckgo.com"))
            .unwrap_or(false)
        {
            for (k, v) in u.query_pairs() {
                if k == "uddg" {
                    return v.to_string();
                }
            }
        }
    }
    abs
}

fn parse_ddg_uddg_fallback(html: &str, limit: usize) -> Vec<WebSearchHit> {
    let mut hits = Vec::new();
    let mut rest = html;
    while hits.len() < limit {
        let Some(i) = rest.find("uddg=") else {
            break;
        };
        let after = &rest[i + 5..];
        let end = after
            .find(|c: char| c == '&' || c == '"' || c == '\'' || c == ' ' || c == '>')
            .unwrap_or(after.len().min(2000));
        let encoded = &after[..end];
        let decoded = percent_decode(encoded);
        rest = &after[end..];
        if validate_web_url(&decoded).is_err() {
            continue;
        }
        // Title unknown in this path
        let title = decoded
            .trim_start_matches("https://")
            .trim_start_matches("http://")
            .chars()
            .take(80)
            .collect::<String>();
        if hits.iter().any(|h: &WebSearchHit| h.url == decoded) {
            continue;
        }
        hits.push(WebSearchHit {
            title,
            url: decoded,
            snippet: String::new(),
        });
    }
    hits
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let h = || u8::from_str_radix(std::str::from_utf8(&bytes[i + 1..i + 3]).ok()?, 16).ok();
            if let Some(b) = h() {
                out.push(b);
                i += 3;
                continue;
            }
        }
        if bytes[i] == b'+' {
            out.push(b' ');
        } else {
            out.push(bytes[i]);
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Format search hits for the model/UI trail.
pub fn format_search_hits(hits: &[WebSearchHit], query: &str) -> String {
    if hits.is_empty() {
        return format!(
            "No web search results for `{query}` (engine empty, blocked, or parse failed). Try a simpler query or web_fetch a known URL."
        );
    }
    let mut lines = Vec::new();
    for (i, h) in hits.iter().enumerate() {
        lines.push(format!(
            "{}. {}\n   URL: {}\n   {}",
            i + 1,
            h.title,
            h.url,
            if h.snippet.is_empty() {
                "(no snippet)".into()
            } else {
                h.snippet.clone()
            }
        ));
    }
    lines.join("\n")
}

/// Format fetch result for the model.
pub fn format_fetch_result(r: &WebFetchResult) -> String {
    let mut out = format!("URL: {}\nHTTP: {}\n", r.url, r.status);
    if !r.title.is_empty() {
        out.push_str(&format!("Title: {}\n", r.title));
    }
    out.push_str("---\n");
    out.push_str(&r.text);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ssrf_blocks_private_and_loopback() {
        assert!(validate_web_url("http://127.0.0.1/").is_err());
        assert!(validate_web_url("http://localhost/secret").is_err());
        assert!(validate_web_url("http://10.0.0.5/").is_err());
        assert!(validate_web_url("http://192.168.1.1/").is_err());
        assert!(validate_web_url("http://169.254.169.254/latest").is_err());
        assert!(validate_web_url("http://[::ffff:169.254.169.254]/").is_err());
    }

    #[test]
    fn ssrf_blocks_credentials_and_file() {
        assert!(validate_web_url("https://user:pass@example.com/").is_err());
        assert!(validate_web_url("file:///etc/passwd").is_err());
        assert!(validate_web_url("ftp://example.com/").is_err());
    }

    #[test]
    fn ssrf_allows_public_https() {
        let u = validate_web_url("https://example.com/path?q=1").unwrap();
        assert_eq!(u.host_str(), Some("example.com"));
    }

    #[test]
    fn html_extracts_title_and_strips_script() {
        let html = r#"
        <html><head><title>Hello World</title>
        <script>alert('xss')</script>
        <style>.x{color:red}</style>
        </head><body><p>Paragraph one.</p><p>Two &amp; three</p></body></html>
        "#;
        assert_eq!(extract_title(html), "Hello World");
        let text = html_to_text(html);
        assert!(text.contains("Paragraph one"));
        assert!(text.contains("Two & three"));
        assert!(!text.contains("alert"));
        assert!(!text.contains("color:red"));
    }

    #[test]
    fn parse_ddg_fixture() {
        let fixture = r#"
        <div class="result results_links">
          <a rel="nofollow" class="result__a" href="https://example.com/page">Example Domain</a>
          <a class="result__snippet" href="https://example.com/page">This domain is for use in illustrative examples.</a>
        </div>
        <div class="result results_links">
          <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnews.example.org%2Fstory&rut=abc">News Story</a>
          <div class="result__snippet">Breaking news snippet here.</div>
        </div>
        <div class="result">
          <a class="result__a" href="http://10.0.0.1/internal">Should Skip Private</a>
        </div>
        "#;
        let hits = parse_ddg_html(fixture, 10);
        assert_eq!(hits.len(), 2, "{hits:?}");
        assert_eq!(hits[0].url, "https://example.com/page");
        assert_eq!(hits[0].title, "Example Domain");
        assert!(hits[0].snippet.contains("illustrative"));
        assert_eq!(hits[1].url, "https://news.example.org/story");
        assert!(hits[1].title.contains("News"));
    }

    #[test]
    fn normalize_uddg() {
        let u = normalize_ddg_url(
            "https://duckduckgo.com/l/?uddg=https%3A%2F%2Ffoo.example%2Fbar&rut=x",
        );
        assert_eq!(u, "https://foo.example/bar");
    }

    #[test]
    fn query_sanitize_and_limit() {
        assert!(sanitize_search_query("  ").is_err());
        assert!(sanitize_search_query(&"x".repeat(500)).is_err());
        assert_eq!(
            sanitize_search_query("  hello world  ").unwrap(),
            "hello world"
        );
        assert_eq!(clamp_search_limit(None), DEFAULT_SEARCH_LIMIT);
        assert_eq!(clamp_search_limit(Some(0)), 1);
        assert_eq!(clamp_search_limit(Some(100)), MAX_SEARCH_LIMIT);
    }

    #[test]
    fn format_empty_search_is_graceful() {
        let s = format_search_hits(&[], "quantum");
        assert!(s.contains("No web search"));
        assert!(s.contains("quantum"));
    }
}
