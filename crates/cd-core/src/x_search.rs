//! Optional X (Twitter) recent-search via official API bearer token.
//!
//! Not free RSS. Requires a usable X API plan. Soft-fails on 401/403/429 so the
//! agent can continue with other tools.

use crate::error::{CoreError, CoreResult};
use crate::web_research::{urlencoding_encode, WebSearchHit, REQUEST_TIMEOUT_SECS};
use serde::Deserialize;

/// Official recent-search endpoint (v2).
const X_RECENT_SEARCH_URL: &str = "https://api.x.com/2/tweets/search/recent";

/// One X post as a search hit.
pub type XSearchHit = WebSearchHit;

#[derive(Debug, Deserialize)]
struct XApiResponse {
    data: Option<Vec<XTweet>>,
    includes: Option<XIncludes>,
    errors: Option<Vec<XApiError>>,
    meta: Option<XMeta>,
    title: Option<String>,
    detail: Option<String>,
}

#[derive(Debug, Deserialize)]
struct XTweet {
    id: String,
    text: Option<String>,
    author_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct XIncludes {
    users: Option<Vec<XUser>>,
}

#[derive(Debug, Deserialize)]
struct XUser {
    id: String,
    username: Option<String>,
    name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct XApiError {
    detail: Option<String>,
    title: Option<String>,
}

#[derive(Debug, Deserialize)]
struct XMeta {
    result_count: Option<u32>,
}

/// Sanitize a short search query for X recent search.
pub fn sanitize_x_query(raw: &str) -> CoreResult<String> {
    let q = raw.trim();
    if q.is_empty() {
        return Err(CoreError::Message(
            "x_search requires a non-empty query".into(),
        ));
    }
    if q.len() > 512 {
        return Err(CoreError::Message(
            "x_search query too long (max 512 chars)".into(),
        ));
    }
    Ok(q.to_string())
}

/// Search recent posts with a bearer token. Soft-fails into notes on API errors.
pub async fn search_recent(
    query: &str,
    limit: usize,
    bearer: &str,
) -> CoreResult<(Vec<XSearchHit>, Vec<String>)> {
    let q = sanitize_x_query(query)?;
    let bearer = bearer.trim();
    if bearer.is_empty() {
        return Ok((vec![], vec!["x:no_bearer".into()]));
    }
    let limit = limit.clamp(10, 100); // API min 10 for recent search max_results
    let max_results = limit.min(100);

    let url = format!(
        "{X_RECENT_SEARCH_URL}?query={}&max_results={max_results}&tweet.fields=created_at,author_id&expansions=author_id&user.fields=username,name",
        urlencoding_encode(&q)
    );

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| CoreError::Message(format!("x_search client: {e}")))?;

    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {bearer}"))
        .header("User-Agent", "ContextDesk/1.0 (+local research)")
        .send()
        .await
        .map_err(|e| CoreError::Message(format!("x_search network: {e}")))?;

    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| CoreError::Message(format!("x_search body: {e}")))?;

    let mut notes = Vec::new();
    notes.push(format!("x:http_{}", status.as_u16()));

    if status.as_u16() == 401 || status.as_u16() == 403 {
        notes.push(
            "x:auth_failed — check API key / plan; free tier cannot search. Soft fail.".into(),
        );
        return Ok((vec![], notes));
    }
    if status.as_u16() == 429 {
        notes.push("x:rate_limited — try again later. Soft fail.".into());
        return Ok((vec![], notes));
    }
    if !status.is_success() {
        // Parse error payload if present
        if let Ok(err) = serde_json::from_str::<XApiResponse>(&body) {
            if let Some(d) = err.detail.or(err.title) {
                notes.push(format!("x:api_error:{d}"));
            }
            if let Some(errs) = err.errors {
                for e in errs.into_iter().take(3) {
                    let msg = e.detail.or(e.title).unwrap_or_else(|| "error".into());
                    notes.push(format!("x:err:{msg}"));
                }
            }
        } else {
            notes.push(format!(
                "x:http_error_body:{}",
                body.chars().take(120).collect::<String>()
            ));
        }
        return Ok((vec![], notes));
    }

    let parsed: XApiResponse = serde_json::from_str(&body)
        .map_err(|e| CoreError::Message(format!("x_search parse: {e}")))?;

    if let Some(errs) = &parsed.errors {
        for e in errs.iter().take(3) {
            let msg = e
                .detail
                .clone()
                .or_else(|| e.title.clone())
                .unwrap_or_else(|| "error".into());
            notes.push(format!("x:warn:{msg}"));
        }
    }

    let users: std::collections::HashMap<String, &XUser> = parsed
        .includes
        .as_ref()
        .and_then(|i| i.users.as_ref())
        .map(|u| u.iter().map(|user| (user.id.clone(), user)).collect())
        .unwrap_or_default();

    let mut hits = Vec::new();
    for tw in parsed.data.unwrap_or_default() {
        let text = tw.text.unwrap_or_default();
        let handle = tw
            .author_id
            .as_ref()
            .and_then(|id| users.get(id))
            .and_then(|u| u.username.as_ref())
            .map(|s| s.as_str())
            .unwrap_or("user");
        let display = tw
            .author_id
            .as_ref()
            .and_then(|id| users.get(id))
            .and_then(|u| u.name.as_ref())
            .map(|s| s.as_str())
            .unwrap_or(handle);
        let url = format!("https://x.com/{handle}/status/{}", tw.id);
        let title = format!("@{handle} ({display})");
        let snippet: String = text.chars().take(280).collect();
        hits.push(XSearchHit {
            title,
            url,
            snippet,
        });
    }

    if let Some(meta) = parsed.meta {
        if let Some(c) = meta.result_count {
            notes.push(format!("x:result_count:{c}"));
        }
    }
    if hits.is_empty() {
        notes.push("x:empty".into());
    } else {
        notes.push(format!("x:hits:{}", hits.len()));
    }

    // Cap for model (API may return up to max_results)
    hits.truncate(limit.min(25));
    Ok((hits, notes))
}

/// Format hits for the model (same shape as web_search).
pub fn format_x_hits(hits: &[XSearchHit], query: &str, notes: &[String]) -> String {
    let mut out = format!("x_search for `{query}` ({} hit(s))\n", hits.len());
    if !notes.is_empty() {
        out.push_str("notes: ");
        out.push_str(&notes.join("; "));
        out.push('\n');
    }
    for (i, h) in hits.iter().enumerate() {
        out.push_str(&format!(
            "{}. {} — {}\n   {}\n",
            i + 1,
            h.title,
            h.url,
            h.snippet
        ));
    }
    if hits.is_empty() {
        out.push_str(
            "No posts returned. Do not invent posts. Use web_search / web_fetch or report the gap.\n",
        );
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_rejects_empty() {
        assert!(sanitize_x_query("  ").is_err());
    }

    #[test]
    fn sanitize_ok() {
        assert_eq!(sanitize_x_query(" IRGC ").unwrap(), "IRGC");
    }
}
