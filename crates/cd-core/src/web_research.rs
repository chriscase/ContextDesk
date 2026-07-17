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
use serde_json::Value as JsonValue;
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
    let end = rest_l
        .find("</title>")
        .unwrap_or_else(|| crate::text::floor_char_boundary(rest, 500));
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

/// Percent-encode for query strings (public for publisher feed helpers).
pub fn urlencoding_encode(s: &str) -> String {
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
        // Browser-like UA: many news sites 401/403 custom bot agents.
        .user_agent(concat!(
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:128.0) ",
            "Gecko/20100101 Firefox/128.0 ContextDesk/",
            env!("CARGO_PKG_VERSION")
        ))
        .build()
        .map_err(|e| CoreError::Message(format!("http client: {e}")))
}

/// True when HTTP status is a typical bot-block / paywall / soft failure
/// (should not abort the agent turn).
pub fn is_soft_http_failure(status: u16) -> bool {
    matches!(status, 401 | 403 | 404 | 410 | 418 | 429 | 451 | 500..=599)
        || !(200..300).contains(&status)
}

/// Human guidance when a page cannot be read.
pub fn soft_fetch_advice(status: u16, url: &str) -> String {
    let kind = match status {
        401 | 403 => "blocked (login wall, paywall, or bot protection)",
        404 | 410 => "not found",
        429 => "rate-limited",
        451 => "unavailable for legal reasons",
        500..=599 => "server error",
        _ => "non-success response",
    };
    format!(
        "web_fetch could not read this page: HTTP {status} ({kind}) for {url}.\n\
         This is common for major news sites (Reuters, NYT, WSJ, etc.).\n\
         Recovery: (1) use snippets from web_search, (2) try a different URL from search results, \
         (3) prefer open sources (AP, BBC, Wikipedia, gov sites). Do not abort the user answer."
    )
}

/// Fetch a URL, follow limited redirects, return text extract.
///
/// Non-2xx responses return [`Ok`] with `status` set and advisory text — they are
/// **not** hard errors, so the agent can try another URL.
pub async fn web_fetch(url: &str) -> CoreResult<WebFetchResult> {
    let mut current = validate_web_url(url)?;
    let client = build_client()?;

    for hop in 0..=MAX_REDIRECTS {
        let resp = client
            .get(current.as_str())
            .header(
                "Accept",
                "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
            )
            .header("Accept-Language", "en-US,en;q=0.9")
            .send()
            .await
            .map_err(|e| CoreError::Message(format!("web_fetch network: {e}")))?;

        let status = resp.status();
        if status.is_redirection() {
            if hop == MAX_REDIRECTS {
                return Ok(WebFetchResult {
                    url: current.to_string(),
                    title: String::new(),
                    text: soft_fetch_advice(310, current.as_str()) + "\n(too many redirects)",
                    status: 310,
                });
            }
            let loc = resp
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok());
            let Some(loc) = loc else {
                return Ok(WebFetchResult {
                    url: current.to_string(),
                    title: String::new(),
                    text: soft_fetch_advice(status.as_u16(), current.as_str())
                        + "\n(redirect without Location)",
                    status: status.as_u16(),
                });
            };
            match resolve_redirect(&current, loc) {
                Ok(next) => {
                    current = next;
                    continue;
                }
                Err(e) => {
                    return Ok(WebFetchResult {
                        url: current.to_string(),
                        title: String::new(),
                        text: format!(
                            "{}\n(redirect blocked by SSRF policy: {e})",
                            soft_fetch_advice(status.as_u16(), current.as_str())
                        ),
                        status: status.as_u16(),
                    });
                }
            }
        }

        let code = status.as_u16();

        // Cap body even on error pages (sometimes include a short message).
        if let Some(cl) = resp.content_length() {
            if cl > MAX_BODY_BYTES as u64 * 4 && status.is_success() {
                return Ok(WebFetchResult {
                    url: current.to_string(),
                    title: String::new(),
                    text: format!("response too large (Content-Length {cl}); refused download"),
                    status: 413,
                });
            }
        }

        let bytes = match read_body_capped(resp).await {
            Ok(b) => b,
            Err(e) => {
                return Ok(WebFetchResult {
                    url: current.to_string(),
                    title: String::new(),
                    text: format!(
                        "{}\n(body read error: {e})",
                        soft_fetch_advice(code, current.as_str())
                    ),
                    status: if status.is_success() { 502 } else { code },
                });
            }
        };

        let html = String::from_utf8_lossy(&bytes);
        if !status.is_success() {
            let excerpt = html_to_text(&html);
            let mut text = soft_fetch_advice(code, current.as_str());
            if !excerpt.is_empty() {
                text.push_str("\n---\nPartial page text:\n");
                text.push_str(&excerpt.chars().take(1500).collect::<String>());
            }
            return Ok(WebFetchResult {
                url: current.to_string(),
                title: extract_title(&html),
                text,
                status: code,
            });
        }

        let title = extract_title(&html);
        let text = html_to_text(&html);
        return Ok(WebFetchResult {
            url: current.to_string(),
            title,
            text,
            status: code,
        });
    }

    Ok(WebFetchResult {
        url: url.to_string(),
        title: String::new(),
        text: soft_fetch_advice(310, url) + "\n(redirect loop)",
        status: 310,
    })
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

/// Expand a user/agent query into a few complementary Google News queries.
///
/// Long questions get a keyword-condensed form; casualty/name hunts get a
/// focused “named / list / killed” variant; news-y queries get a 30-day window.
pub fn search_query_variants(query: &str) -> Vec<String> {
    let q = query.trim();
    if q.is_empty() {
        return vec![];
    }
    let mut out = Vec::new();
    out.push(q.to_string());

    let condensed = condense_search_query(q);
    if condensed.len() >= 8 && !eq_ignore_ws(&condensed, q) {
        out.push(condensed.clone());
    }

    let lower = q.to_ascii_lowercase();
    let person_hunt = lower.contains("who")
        || lower.contains("killed")
        || lower.contains("assassination")
        || lower.contains("commander")
        || lower.contains("general")
        || lower.contains("minister")
        || lower.contains("mullah")
        || lower.contains("official");
    if person_hunt {
        let base = if condensed.len() >= 8 {
            condensed.as_str()
        } else {
            q
        };
        let named = format!("{base} named killed OR commander OR general");
        if !out.iter().any(|x| x == &named) {
            out.push(named);
        }
        let list = format!("{base} list officials killed");
        if !out.iter().any(|x| x == &list) {
            out.push(list);
        }
    }

    // Google News recency operator (best-effort; ignored by non-GNews backends).
    if looks_like_news_query(q) {
        let recent = format!("{q} when:30d");
        if !out.iter().any(|x| x == &recent) {
            out.push(recent);
        }
    }

    out.truncate(4);
    out
}

fn eq_ignore_ws(a: &str, b: &str) -> bool {
    a.split_whitespace().eq(b.split_whitespace())
}

fn looks_like_news_query(q: &str) -> bool {
    let l = q.to_ascii_lowercase();
    l.contains("today")
        || l.contains("latest")
        || l.contains("killed")
        || l.contains("war")
        || l.contains("strike")
        || l.contains("july")
        || l.contains("2025")
        || l.contains("2026")
        || l.contains("who ")
        || l.contains("news")
}

/// Drop question fluff so news engines match keywords better.
pub fn condense_search_query(q: &str) -> String {
    const STOP: &[&str] = &[
        "who", "what", "when", "where", "which", "whom", "whose", "how", "why", "is", "are", "was",
        "were", "be", "been", "being", "have", "has", "had", "do", "does", "did", "the", "a", "an",
        "of", "in", "on", "at", "to", "for", "from", "by", "with", "about", "into", "over",
        "after", "before", "between", "and", "or", "but", "if", "as", "than", "that", "this",
        "these", "those", "any", "some", "many", "much", "most", "more", "can", "could", "would",
        "should", "will", "just", "please", "tell", "me", "you", "your", "i", "we", "they",
        "their", "there", "here", "been", "being",
    ];
    let words: Vec<&str> = q
        .split(|c: char| c.is_whitespace() || "/\\|".contains(c))
        .map(str::trim)
        .filter(|w| !w.is_empty())
        .filter(|w| {
            let lw = w
                .trim_matches(|c: char| !c.is_alphanumeric())
                .to_ascii_lowercase();
            !lw.is_empty() && !STOP.contains(&lw.as_str())
        })
        .collect();
    words.join(" ")
}

/// Multi-backend public web search (no API keys).
///
/// 1. Google News RSS (multi-query variants)
/// 2. Curated publisher RSS fan-in (`enabled_publisher_ids`, optionally pack-filtered)
/// 3. DDG Instant Answer + DDG HTML fill
///
/// `packs` — optional publisher pack ids (e.g. `middle_east`). Empty = all enabled.
pub async fn web_search(
    query: &str,
    limit: usize,
    enabled_publisher_ids: &std::collections::HashSet<String>,
    packs: &[String],
) -> CoreResult<(Vec<WebSearchHit>, Vec<String>)> {
    let q = sanitize_search_query(query)?;
    let limit = limit.clamp(1, MAX_SEARCH_LIMIT);
    let variants = search_query_variants(&q);
    let mut hits: Vec<WebSearchHit> = Vec::new();
    let mut notes: Vec<String> = Vec::new();

    let (publisher_ids, pack_notes) =
        crate::news_sources::filter_ids_by_packs(enabled_publisher_ids, packs);
    notes.extend(pack_notes);

    let gnews_cap = (limit.max(4) * 2 / 3).max(4).min(limit);
    let per = gnews_cap.div_ceil(variants.len()).clamp(3, gnews_cap);

    for (i, v) in variants.iter().enumerate() {
        if hits.len() >= gnews_cap {
            break;
        }
        match web_search_google_news(v, per).await {
            Ok(n) if !n.is_empty() => {
                notes.push(format!(
                    "gnews[{i}]\"{}\":{} hits",
                    truncate_note(v, 40),
                    n.len()
                ));
                merge_hits(&mut hits, n, gnews_cap);
            }
            Ok(_) => notes.push(format!("gnews[{i}]:empty")),
            Err(e) => notes.push(format!("gnews[{i}]:err({e})")),
        }
    }

    if !publisher_ids.is_empty() {
        let (pub_hits, pub_notes) =
            crate::news_sources::search_publisher_feeds(&q, limit, &publisher_ids).await;
        notes.extend(pub_notes);
        merge_hits(&mut hits, pub_hits, limit);
    }

    if hits.len() < limit {
        match web_search_ddg_instant(&q, limit).await {
            Ok(n) if !n.is_empty() => {
                notes.push(format!("ddg_instant:{} hits", n.len()));
                merge_hits(&mut hits, n, limit);
            }
            Ok(_) => notes.push("ddg_instant:empty".into()),
            Err(e) => notes.push(format!("ddg_instant:err({e})")),
        }
    }

    if hits.len() < limit {
        let ddg_q = {
            let c = condense_search_query(&q);
            if c.len() >= 8 {
                c
            } else {
                q.clone()
            }
        };
        match web_search_ddg_html(&ddg_q, limit).await {
            Ok(n) if !n.is_empty() => {
                notes.push(format!("ddg_html:{} hits", n.len()));
                merge_hits(&mut hits, n, limit);
            }
            Ok(_) => notes.push("ddg_html:empty_or_captcha".into()),
            Err(e) => notes.push(format!("ddg_html:err({e})")),
        }
    }

    Ok((hits, notes))
}

/// Search with all default-enabled publishers (tests / back-compat).
pub async fn web_search_default_publishers(
    query: &str,
    limit: usize,
) -> CoreResult<(Vec<WebSearchHit>, Vec<String>)> {
    let enabled = crate::news_sources::enabled_ids(&std::collections::HashMap::new());
    web_search(query, limit, &enabled, &[]).await
}

fn truncate_note(s: &str, max: usize) -> String {
    let t: String = s.chars().take(max).collect();
    if s.chars().count() > max {
        format!("{t}…")
    } else {
        t
    }
}

fn merge_hits(into: &mut Vec<WebSearchHit>, extra: Vec<WebSearchHit>, limit: usize) {
    for h in extra {
        if into.len() >= limit {
            break;
        }
        if into.iter().any(|x| x.url == h.url) {
            continue;
        }
        into.push(h);
    }
}

/// Google News RSS search (current events; no API key).
pub async fn web_search_google_news(query: &str, limit: usize) -> CoreResult<Vec<WebSearchHit>> {
    let q = sanitize_search_query(query)?;
    let limit = limit.clamp(1, MAX_SEARCH_LIMIT);
    let url = format!(
        "https://news.google.com/rss/search?q={}&hl=en-US&gl=US&ceid=US:en",
        urlencoding_encode(&q)
    );
    let _ = validate_web_url(&url)?;
    let client = build_client()?;
    let resp = client
        .get(&url)
        .header(
            "Accept",
            "application/rss+xml, application/xml, text/xml, */*",
        )
        .send()
        .await
        .map_err(|e| CoreError::Message(format!("google news: {e}")))?;
    if !resp.status().is_success() {
        return Ok(vec![]);
    }
    let bytes = read_body_capped(resp).await?;
    let xml = String::from_utf8_lossy(&bytes);
    Ok(parse_google_news_rss(&xml, limit))
}

/// Parse Google News RSS XML (fixture-friendly).
pub fn parse_google_news_rss(xml: &str, limit: usize) -> Vec<WebSearchHit> {
    let limit = limit.clamp(1, MAX_SEARCH_LIMIT);
    let mut hits = Vec::new();
    let mut rest = xml;
    while hits.len() < limit {
        let Some(start) = rest.find("<item>") else {
            break;
        };
        let Some(end_rel) = rest[start..].find("</item>") else {
            break;
        };
        let item = &rest[start..start + end_rel];
        rest = &rest[start + end_rel + 7..];

        let title = collapse_ws(&strip_tags(&extract_xml_tag(item, "title")));
        let link = extract_xml_tag(item, "link").trim().to_string();
        let desc_raw = extract_xml_tag(item, "description");
        let snippet = collapse_ws(&strip_tags(&decode_basic_entities(&desc_raw)));
        let pub_date = extract_xml_tag(item, "pubDate");

        if title.is_empty() {
            continue;
        }
        // Google News links are https://news.google.com/... (public, SSRF-ok).
        let url = if link.is_empty() {
            format!(
                "https://news.google.com/search?q={}",
                urlencoding_encode(&title)
            )
        } else {
            link
        };
        if validate_web_url(&url).is_err() {
            continue;
        }
        let mut snip = snippet.chars().take(400).collect::<String>();
        if !pub_date.is_empty() {
            if !snip.is_empty() {
                snip.push_str(" · ");
            }
            snip.push_str(&pub_date.chars().take(40).collect::<String>());
        }
        hits.push(WebSearchHit {
            title: title.chars().take(200).collect(),
            url,
            snippet: snip,
        });
    }
    hits
}

fn extract_xml_tag(block: &str, tag: &str) -> String {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let Some(s) = block.find(&open) else {
        // CDATA or attributes on open tag
        let open2 = format!("<{tag} ");
        if let Some(s2) = block.find(&open2) {
            if let Some(gt) = block[s2..].find('>') {
                let start = s2 + gt + 1;
                if let Some(e) = block[start..].find(&close) {
                    return strip_cdata(&block[start..start + e]).to_string();
                }
            }
        }
        return String::new();
    };
    let start = s + open.len();
    let Some(e) = block[start..].find(&close) else {
        return String::new();
    };
    strip_cdata(&block[start..start + e]).to_string()
}

fn strip_cdata(s: &str) -> &str {
    let t = s.trim();
    if let Some(inner) = t
        .strip_prefix("<![CDATA[")
        .and_then(|x| x.strip_suffix("]]>"))
    {
        inner
    } else {
        t
    }
}

fn decode_basic_entities(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
}

/// DuckDuckGo Instant Answer API (no key; sparse for breaking news but unblocked).
pub async fn web_search_ddg_instant(query: &str, limit: usize) -> CoreResult<Vec<WebSearchHit>> {
    let q = sanitize_search_query(query)?;
    let limit = limit.clamp(1, MAX_SEARCH_LIMIT);
    let url = format!(
        "https://api.duckduckgo.com/?q={}&format=json&no_html=1&skip_disambig=1",
        urlencoding_encode(&q)
    );
    let _ = validate_web_url(&url)?;
    let client = build_client()?;
    let resp = client
        .get(&url)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| CoreError::Message(format!("ddg instant: {e}")))?;
    if !resp.status().is_success() {
        return Ok(vec![]);
    }
    let bytes = read_body_capped(resp).await?;
    let text = String::from_utf8_lossy(&bytes);
    Ok(parse_ddg_instant_json(&text, limit))
}

/// Parse DDG Instant Answer JSON.
pub fn parse_ddg_instant_json(text: &str, limit: usize) -> Vec<WebSearchHit> {
    let limit = limit.clamp(1, MAX_SEARCH_LIMIT);
    let Ok(v) = serde_json::from_str::<JsonValue>(text) else {
        return vec![];
    };
    let mut hits = Vec::new();
    let abstract_text = v
        .get("AbstractText")
        .or_else(|| v.get("Abstract"))
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .trim();
    let abstract_url = v
        .get("AbstractURL")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .trim();
    let heading = v
        .get("Heading")
        .and_then(|x| x.as_str())
        .unwrap_or("Overview")
        .trim();
    if !abstract_text.is_empty()
        && !abstract_url.is_empty()
        && validate_web_url(abstract_url).is_ok()
    {
        hits.push(WebSearchHit {
            title: heading.chars().take(200).collect(),
            url: abstract_url.to_string(),
            snippet: abstract_text.chars().take(400).collect(),
        });
    }
    if let Some(arr) = v.get("RelatedTopics").and_then(|a| a.as_array()) {
        for item in arr {
            if hits.len() >= limit {
                break;
            }
            // Nested topics under Name/Topics
            if let Some(nested) = item.get("Topics").and_then(|t| t.as_array()) {
                for n in nested {
                    if hits.len() >= limit {
                        break;
                    }
                    push_ddg_related(&mut hits, n);
                }
                continue;
            }
            push_ddg_related(&mut hits, item);
        }
    }
    hits.truncate(limit);
    hits
}

fn push_ddg_related(hits: &mut Vec<WebSearchHit>, item: &JsonValue) {
    let text = item.get("Text").and_then(|t| t.as_str()).unwrap_or("");
    let url = item.get("FirstURL").and_then(|u| u.as_str()).unwrap_or("");
    if text.is_empty() || url.is_empty() {
        return;
    }
    // FirstURL is often https://duckduckgo.com/Topic — skip pure DDG shells
    // when we already have enough, but keep Wikipedia-style AbstractURL paths.
    if url.contains("duckduckgo.com/") && !url.contains("wikipedia") {
        // Convert DDG topic URLs are not useful for fetch; still show as title context
        // only if no better hits — skip for cleanliness.
        return;
    }
    if validate_web_url(url).is_err() {
        return;
    }
    if hits.iter().any(|h| h.url == url) {
        return;
    }
    let title = text.split(" - ").next().unwrap_or(text);
    hits.push(WebSearchHit {
        title: title.chars().take(200).collect(),
        url: url.to_string(),
        snippet: text.chars().take(400).collect(),
    });
}

/// DuckDuckGo HTML lite search (best-effort, no API key).
///
/// On CAPTCHA/block/parse failure returns empty `Ok(vec![])`.
pub async fn web_search_ddg_html(query: &str, limit: usize) -> CoreResult<Vec<WebSearchHit>> {
    let q = sanitize_search_query(query)?;
    let limit = limit.clamp(1, MAX_SEARCH_LIMIT);
    let search_url = format!(
        "https://html.duckduckgo.com/html/?q={}",
        urlencoding_encode(&q)
    );
    let _ = validate_web_url(&search_url)?;

    let client = build_client()?;
    let resp = client
        .get(&search_url)
        .header("Accept", "text/html")
        .send()
        .await
        .map_err(|e| CoreError::Message(format!("web_search: {e}")))?;

    if !resp.status().is_success() {
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
    if is_ddg_bot_challenge(&html) {
        tracing::warn!("web_search DDG HTML returned bot challenge");
        return Ok(vec![]);
    }
    Ok(parse_ddg_html(&html, limit))
}

/// Detect DDG anomaly/CAPTCHA interstitial.
pub fn is_ddg_bot_challenge(html: &str) -> bool {
    let l = html.to_ascii_lowercase();
    l.contains("anomaly-modal")
        || l.contains("bots use duckduckgo")
        || l.contains("challenge-form")
        || l.contains("select all squares containing a duck")
}

/// Back-compat alias used by older call sites / tests.
pub async fn web_search_ddg(query: &str, limit: usize) -> CoreResult<Vec<WebSearchHit>> {
    let (hits, _) = web_search_default_publishers(query, limit).await?;
    Ok(hits)
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
        let chunk_end = crate::text::floor_char_boundary(
            chunk,
            chunk
                .find("</a>")
                .map(|i| i + 4)
                .unwrap_or(2000.min(chunk.len())),
        );
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
    let win_end = crate::text::floor_char_boundary(after, 2500);
    let window = &after[..win_end];
    let window_l = &lower[..win_end];
    if let Some(si) = window_l.find("result__snippet") {
        let from = &window[si..];
        if let Some(gt) = from.find('>') {
            let body = &from[gt + 1..];
            let end = body
                .to_ascii_lowercase()
                .find("</")
                .unwrap_or_else(|| crate::text::floor_char_boundary(body, 500));
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
            .find(['&', '"', '\'', ' ', '>'])
            .unwrap_or_else(|| crate::text::floor_char_boundary(after, 2000));
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

/// Human-friendly source name for chips / tool output (not the full URL).
///
/// Prefers a publisher suffix from news titles (`… - Al Jazeera`), else the
/// registrable-ish host (`www.bbc.com` → `bbc.com`, Google News → `Google News`).
pub fn source_display_label(title: Option<&str>, url: &str) -> String {
    if let Some(t) = title {
        let t = t.trim();
        // Common wire pattern: "Headline - Publisher"
        if let Some((head, pub_)) = t.rsplit_once(" - ") {
            let pub_ = pub_.trim();
            if !pub_.is_empty()
                && pub_.len() <= 48
                && !pub_.contains("http")
                && head.trim().len() >= 4
            {
                return pub_.to_string();
            }
        }
        // "Headline | Publisher"
        if let Some((head, pub_)) = t.rsplit_once(" | ") {
            let pub_ = pub_.trim();
            if !pub_.is_empty() && pub_.len() <= 48 && head.trim().len() >= 4 {
                return pub_.to_string();
            }
        }
    }
    host_display_label(url)
}

/// Short host label from a URL.
pub fn host_display_label(url: &str) -> String {
    let Ok(u) = Url::parse(url.trim()) else {
        return "source".into();
    };
    let host = u.host_str().unwrap_or("source");
    let host = host.strip_prefix("www.").unwrap_or(host);
    if host.contains("news.google.") {
        return "Google News".into();
    }
    if host.contains("duckduckgo.com") {
        return "DuckDuckGo".into();
    }
    if host.ends_with("wikipedia.org") {
        return "Wikipedia".into();
    }
    // Keep 2–3 labels max for readability
    host.chars().take(40).collect()
}

/// Headline without publisher suffix (for list rows).
pub fn headline_without_publisher(title: &str) -> String {
    let t = title.trim();
    for sep in [" - ", " | "] {
        if let Some((head, pub_)) = t.rsplit_once(sep) {
            let pub_ = pub_.trim();
            if !pub_.is_empty() && pub_.len() <= 48 && head.trim().len() >= 4 {
                return head.trim().to_string();
            }
        }
    }
    t.to_string()
}

/// Format search hits for the model/UI trail.
pub fn format_search_hits(hits: &[WebSearchHit], query: &str) -> String {
    format_search_hits_with_notes(hits, query, &[])
}

/// Format hits plus backend notes (for debugging empty results).
///
/// Does **not** dump giant URLs as the primary line — source name + headline,
/// with a compact `link:` line for the agent to pass to `web_fetch`.
pub fn format_search_hits_with_notes(
    hits: &[WebSearchHit],
    query: &str,
    notes: &[String],
) -> String {
    if hits.is_empty() {
        let backends = if notes.is_empty() {
            String::new()
        } else {
            format!(" Backends: {}.", notes.join("; "))
        };
        return format!(
            "No web search results for `{query}`.{backends} \
             Engines may be CAPTCHA-blocked or empty. Try a shorter query, or web_fetch a known open URL (BBC, Wikipedia, gov)."
        );
    }
    let mut lines = Vec::new();
    if !notes.is_empty() {
        lines.push(format!("[sources: {}]", notes.join(", ")));
    }
    lines.push(
        "Cite sources by short name (e.g. Al Jazeera, BBC). Do not paste full URLs into the user-facing answer."
            .into(),
    );
    lines.push(
        "IMPORTANT: RSS titles/snippets are incomplete. Do NOT claim \"nobody was killed\" / \"no named officials\" \
         unless you fetched open article bodies and still found none — instead say what the titles show and what is unknown. \
         Prefer web_fetch on open publishers (Al Jazeera, Anadolu, Euronews, BBC, Wikipedia) for list/name articles."
            .into(),
    );
    for (i, h) in hits.iter().enumerate() {
        let source = source_display_label(Some(&h.title), &h.url);
        let headline = headline_without_publisher(&h.title);
        let snip = if h.snippet.is_empty() {
            String::new()
        } else {
            format!("\n   {}", h.snippet.chars().take(280).collect::<String>())
        };
        lines.push(format!(
            "{}. [{source}] {headline}{snip}\n   link: {}",
            i + 1,
            h.url
        ));
    }
    lines.join("\n")
}

/// Format fetch result for the model.
pub fn format_fetch_result(r: &WebFetchResult) -> String {
    let source = source_display_label(
        if r.title.is_empty() {
            None
        } else {
            Some(&r.title)
        },
        &r.url,
    );
    let mut out = format!("Source: {source}\nHTTP: {}\n", r.status);
    if !r.title.is_empty() {
        out.push_str(&format!("Title: {}\n", r.title));
    }
    out.push_str(&format!("link: {}\n", r.url));
    if !r.ok() {
        out.push_str("RESULT: failed (soft) — try another URL or use search snippets.\n");
    }
    out.push_str("---\n");
    out.push_str(&r.text);
    out
}

impl WebFetchResult {
    /// Successful 2xx fetch with usable body.
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status) && !self.text.is_empty()
    }
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

    #[test]
    fn soft_http_failure_guidance() {
        assert!(is_soft_http_failure(401));
        assert!(is_soft_http_failure(403));
        assert!(is_soft_http_failure(429));
        let a = soft_fetch_advice(401, "https://www.reuters.com/world/iran/");
        assert!(a.contains("401"));
        assert!(a.contains("web_search") || a.contains("snippets"));
        assert!(a.contains("Do not abort"));
        let r = WebFetchResult {
            url: "https://www.reuters.com/world/iran/".into(),
            title: String::new(),
            text: a,
            status: 401,
        };
        assert!(!r.ok());
        let fmt = format_fetch_result(&r);
        assert!(fmt.contains("failed (soft)"));
        assert!(fmt.contains("401"));
    }

    /// Pre-fix: `extract_title` with no `</title>` and >500 bytes of emoji panicked.
    #[test]
    fn extract_title_emoji_no_close_does_not_panic() {
        let html = format!("<html><title>{}", "🌍".repeat(400));
        let t = extract_title(&html);
        // Truncated prefix is valid UTF-8 (no panic) and non-empty-ish when present
        assert!(t.is_char_boundary(t.len()));
        let _ = t;
    }

    /// Pre-fix: unclosed `<a class="result__a">` + huge CJK tail panicked on chunk_end.
    #[test]
    fn parse_ddg_html_unclosed_cjk_does_not_panic() {
        let cjk = "世".repeat(1500);
        let html = format!(r#"<a class="result__a" href="https://example.com/a">{cjk}"#);
        let hits = parse_ddg_html(&html, 5);
        // May or may not produce a hit depending on validation; must not panic.
        let _ = hits;
    }

    #[test]
    fn extract_next_snippet_multibyte_window_does_not_panic() {
        let tail = "世".repeat(2000);
        let after = format!("prefix result__snippet\">{tail}</div>");
        let s = extract_next_snippet(&after);
        assert!(s.is_char_boundary(s.len()));
    }

    #[test]
    fn parse_ddg_uddg_multibyte_cap_does_not_panic() {
        let encoded = "https%3A%2F%2Fexample.com%2F".to_string() + &"e%CC%81".repeat(800);
        let html = format!("uddg={encoded}");
        let hits = parse_ddg_uddg_fallback(&html, 3);
        let _ = hits;
    }

    #[test]
    fn parse_google_news_rss_fixture() {
        let xml = r#"<?xml version="1.0"?>
        <rss><channel>
          <item>
            <title>Iran war live: US intensifies attacks - Al Jazeera</title>
            <link>https://news.google.com/rss/articles/CBMiabc</link>
            <pubDate>Thu, 16 Jul 2026 23:59:10 GMT</pubDate>
            <description>&lt;a href="https://example.com"&gt;Live updates from the region.&lt;/a&gt;</description>
          </item>
          <item>
            <title>Second story - BBC</title>
            <link>https://news.google.com/rss/articles/CBMidef</link>
            <description>More context here</description>
          </item>
        </channel></rss>"#;
        let hits = parse_google_news_rss(xml, 10);
        assert_eq!(hits.len(), 2);
        assert!(hits[0].title.contains("Al Jazeera"));
        assert!(hits[0].url.contains("news.google.com"));
        assert!(hits[0].snippet.contains("Live updates") || hits[0].snippet.contains("2026"));
    }

    #[test]
    fn parse_ddg_instant_fixture() {
        let j = r#"{
          "Heading":"Iran-Israel conflict",
          "AbstractText":"A long-standing confrontation.",
          "AbstractURL":"https://en.wikipedia.org/wiki/Iran-Israel_conflict",
          "RelatedTopics":[]
        }"#;
        let hits = parse_ddg_instant_json(j, 5);
        assert_eq!(hits.len(), 1);
        assert!(hits[0].url.contains("wikipedia.org"));
    }

    #[test]
    fn detects_ddg_captcha() {
        assert!(is_ddg_bot_challenge(
            r#"<div class="anomaly-modal__title">Unfortunately, bots use DuckDuckGo too.</div>"#
        ));
        assert!(!is_ddg_bot_challenge(
            r#"<a class="result__a" href="https://example.com">x</a>"#
        ));
    }

    #[test]
    fn query_variants_condense_and_person_hunt() {
        let v = search_query_variants(
            "who in the IRGC / mullah command structure of Iran has been killed in July?",
        );
        assert!(v.len() >= 2, "{v:?}");
        assert!(v[0].contains("IRGC") || v[0].to_ascii_lowercase().contains("irgc"));
        let joined = v.join(" | ").to_ascii_lowercase();
        assert!(joined.contains("killed") || joined.contains("commander"));
        let c = condense_search_query(
            "who in the IRGC / mullah command structure of Iran has been killed in July?",
        );
        assert!(c.to_ascii_lowercase().contains("irgc"));
        assert!(c.to_ascii_lowercase().contains("july"));
        assert!(!c
            .to_ascii_lowercase()
            .split_whitespace()
            .any(|w| w == "who"));
    }

    #[test]
    fn source_labels_prefer_publisher_not_full_url() {
        let label = source_display_label(
            Some("Iran war live: US intensifies attacks - Al Jazeera"),
            "https://news.google.com/rss/articles/CBMivwFBVV95cUxOd3lS",
        );
        assert_eq!(label, "Al Jazeera");
        assert_eq!(
            host_display_label("https://www.bbc.com/news/world-123"),
            "bbc.com"
        );
        assert_eq!(
            host_display_label("https://news.google.com/rss/articles/x"),
            "Google News"
        );
        let fmt = format_search_hits(
            &[WebSearchHit {
                title: "Story - Reuters".into(),
                url: "https://news.google.com/rss/articles/abc".into(),
                snippet: "brief".into(),
            }],
            "q",
        );
        assert!(fmt.contains("[Reuters]"));
        assert!(!fmt.contains("URL: https://"));
        assert!(fmt.contains("link: "));
    }

    #[tokio::test]
    #[ignore = "network"]
    async fn live_multi_backend_search() {
        let (hits, notes) = web_search_default_publishers("Iran Israel war today", 6)
            .await
            .unwrap();
        eprintln!("notes={notes:?}");
        for h in &hits {
            eprintln!("- {} | {}", h.title, h.url);
        }
        assert!(
            !hits.is_empty(),
            "expected hits from google news or instant; notes={notes:?}"
        );
    }
}
