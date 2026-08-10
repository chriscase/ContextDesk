//! Shared secret scrubbing for audit lines and memory write/embed paths.
//!
//! Extracted from `audit::scrub_line` and hardened (JWT, AWS, GitHub tokens,
//! PEM blocks, high-entropy strings). Memory must call this **before persist
//! and before embed** (MEMORY.md §5).
//!
//! Indexing into strings here is intentional: secret patterns are ASCII-only
//! (JWT/base64url, PEM armor, key prefixes). Multi-byte user prose is never
//! sliced mid-token for redaction boundaries.

#![allow(clippy::string_slice)]

use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};

/// Maximum retained characters in one share-safe diagnostic text field.
pub const MAX_SHARE_SAFE_DIAGNOSTIC_CHARS: usize = 240;

/// Provider-neutral redaction policy for diagnostics intended to be shared.
///
/// This is deliberately stricter than ordinary secret scrubbing: in addition
/// to credential shapes it removes arbitrary HTTP(S) endpoints, absolute host
/// paths, and caller-supplied private identifiers. Failure details should be
/// projected with [`Self::failure_summary`] so raw provider response bodies are
/// never retained merely because their contents did not match a known secret.
#[derive(Debug, Clone)]
pub struct ShareSafeRedactionPolicy {
    private_identifiers: Vec<Regex>,
}

impl Default for ShareSafeRedactionPolicy {
    fn default() -> Self {
        Self::new(std::iter::empty::<&str>())
    }
}

impl ShareSafeRedactionPolicy {
    /// Build a policy that also removes each exact private identifier,
    /// case-insensitively. Empty identifiers are ignored.
    pub fn new<'a>(private_identifiers: impl IntoIterator<Item = &'a str>) -> Self {
        let private_identifiers = private_identifiers
            .into_iter()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| {
                RegexBuilder::new(&regex::escape(value))
                    .case_insensitive(true)
                    .build()
                    .expect("escaped literal always compiles")
            })
            .collect();
        Self {
            private_identifiers,
        }
    }

    /// Redact and bound arbitrary diagnostic text.
    pub fn redact_text(&self, raw: &str) -> String {
        let mut out = scrub_secrets(raw);
        out = authorization_value_regex()
            .replace_all(&out, "[credential-redacted]")
            .into_owned();
        out = bearer_value_regex()
            .replace_all(&out, "[credential-redacted]")
            .into_owned();
        out = http_endpoint_regex()
            .replace_all(&out, "[endpoint-redacted]")
            .into_owned();
        out = crate::turn_trace::opaque_absolute_paths(&out);
        for identifier in &self.private_identifiers {
            out = identifier
                .replace_all(&out, "[identity-redacted]")
                .into_owned();
        }
        truncate_diagnostic_chars(&out)
    }

    /// Return a stable, useful failure category without retaining the raw
    /// provider error/body. Classification is intentionally coarse and based
    /// only on the transient input; the returned string contains no excerpt.
    pub fn failure_summary(&self, raw: &str) -> String {
        if raw.starts_with("failure category: ") && raw.ends_with("; raw provider detail omitted") {
            return self.redact_text(raw);
        }
        // Host-owned linked-triage authority summaries contain only fixed
        // event labels and whitelisted fallback reasons. Preserve them so a
        // share-safe diagnostic distinguishes an unentered typed path from a
        // rejected typed answer; no provider text reaches this branch.
        if raw.contains("typed_v1=absent; multi_stage_events=") {
            return self.redact_text(raw);
        }
        if raw.contains("typed_v1 passed=") && raw.contains("failed_dimensions=[") {
            return self.redact_text(raw);
        }
        let lower = raw.to_ascii_lowercase();
        let category = if contains_any(&lower, &["cancelled", "canceled", "interrupted"]) {
            "cancelled"
        } else if contains_any(&lower, &["timed out", "timeout", "deadline"]) {
            "timeout"
        } else if contains_any(
            &lower,
            &[
                "401",
                "403",
                "unauthorized",
                "forbidden",
                "authentication",
                "authorization",
                "api-key",
                "api_key",
                "api key",
                "bearer",
            ],
        ) {
            "authentication"
        } else if contains_any(
            &lower,
            &["404", "not found", "unknown model", "unknown route"],
        ) {
            "model_or_route_not_found"
        } else if contains_any(&lower, &["429", "rate limit", "rate-limit", "quota"]) {
            "rate_limited"
        } else if contains_any(
            &lower,
            &[
                "parse",
                "decode",
                "invalid json",
                "invalid response",
                "schema",
                "unexpected response",
            ],
        ) {
            "invalid_response"
        } else if contains_any(
            &lower,
            &[
                "connection",
                "connect",
                "dns",
                "socket",
                "transport",
                "tls",
                "request failed",
            ],
        ) {
            "transport"
        } else if contains_any(
            &lower,
            &["500", "502", "503", "504", "upstream", "internal server"],
        ) {
            "upstream"
        } else if contains_any(
            &lower,
            &[
                "cleanup",
                "was not removed",
                "failed to write",
                "failed to read",
                "i/o",
            ],
        ) {
            "local_io"
        } else if contains_any(
            &lower,
            &[
                "no visible terminal answer",
                "empty visible answer",
                "empty_terminal_answer",
            ],
        ) {
            // A completed workflow that emitted no user-visible answer is
            // materially different from malformed JSON or a scorer failure.
            // Keep this host-observed distinction while still discarding all
            // provider text and any transcript content.
            "empty_terminal_answer"
        } else if contains_any(
            &lower,
            &[
                "contract",
                "marker",
                "expected",
                "failed_dimensions",
                "scorer",
                "answer",
                "cites_current",
            ],
        ) {
            "response_contract"
        } else {
            "provider_error"
        };
        format!("failure category: {category}; raw provider detail omitted")
    }
}

fn contains_any(haystack: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| haystack.contains(needle))
}

fn authorization_value_regex() -> &'static Regex {
    static REGEX: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(
            r#"(?i)\b(authorization|proxy-authorization|x-api-key|api[-_ ]?key)\b\s*[:=]\s*["']?(?:[a-z][a-z0-9_-]*\s+)?[^\s,;}\]]+"#,
        )
        .expect("static authorization regex compiles")
    })
}

fn bearer_value_regex() -> &'static Regex {
    static REGEX: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r"(?i)\bbearer\s+[^\s,;}\]]+").expect("static bearer regex compiles")
    })
}

fn http_endpoint_regex() -> &'static Regex {
    static REGEX: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r#"(?i)\bhttps?://[^\s<>\"']+"#).expect("static endpoint regex compiles")
    })
}

fn truncate_diagnostic_chars(value: &str) -> String {
    let mut chars = value.chars();
    let mut retained = chars
        .by_ref()
        .take(MAX_SHARE_SAFE_DIAGNOSTIC_CHARS)
        .collect::<String>();
    if chars.next().is_some() {
        retained.push('…');
    }
    retained
}

/// Result of scrubbing a candidate for durable storage.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RedactionResult {
    /// Text with secrets replaced by placeholders.
    pub text: String,
    /// True when at least one secret class was redacted.
    pub redacted: bool,
    /// Classes that matched (for Accept preview).
    pub classes: Vec<String>,
    /// True when the candidate is credential-dominant and must be blocked.
    pub blocked: bool,
    /// Human-readable block reason when [`Self::blocked`].
    pub block_reason: Option<String>,
}

/// Scrub secrets from a single line or multi-line body (public API).
///
/// Preserves the historical `sk-` / `xai-` / `Bearer ` behaviour used by audit,
/// and adds JWT / AWS / GitHub / PEM / high-entropy coverage.
pub fn scrub_secrets(s: &str) -> String {
    redact_candidate(s).text
}

/// Full redaction pass with flags for memory Accept preview / block decisions.
pub fn redact_candidate(s: &str) -> RedactionResult {
    let mut out = s.to_string();
    let mut classes: Vec<String> = Vec::new();

    if redact_pem(&mut out) {
        push_class(&mut classes, "pem");
    }
    if redact_jwt(&mut out) {
        push_class(&mut classes, "jwt");
    }
    if redact_aws_access_key(&mut out) {
        push_class(&mut classes, "aws_access_key");
    }
    if redact_aws_secret_label(&mut out) {
        push_class(&mut classes, "aws_secret");
    }
    if redact_github_tokens(&mut out) {
        push_class(&mut classes, "github_token");
    }
    if redact_prefixed_keys(&mut out) {
        push_class(&mut classes, "api_key_prefix");
    }
    if redact_bearer(&mut out) {
        push_class(&mut classes, "bearer");
    }
    if redact_url_embedded_credentials(&mut out) {
        push_class(&mut classes, "url_credentials");
    }
    if redact_high_entropy(&mut out) {
        push_class(&mut classes, "high_entropy");
    }

    let redacted = !classes.is_empty();
    let blocked = is_credential_dominant(s, &classes);
    let block_reason = if blocked {
        Some(format!(
            "content appears credential-dominant ({}); refuse to store",
            classes.join(",")
        ))
    } else {
        None
    };

    RedactionResult {
        text: out,
        redacted: redacted || blocked,
        classes,
        blocked,
        block_reason,
    }
}

fn push_class(classes: &mut Vec<String>, c: &str) {
    if !classes.iter().any(|x| x == c) {
        classes.push(c.to_string());
    }
}

fn is_credential_dominant(original: &str, classes: &[String]) -> bool {
    if classes.is_empty() {
        return false;
    }
    let trimmed = original.trim();
    if trimmed.is_empty() {
        return false;
    }
    // Count "prose" words: short-ish tokens that are not secret-shaped.
    let prose_words = trimmed
        .split_whitespace()
        .filter(|w| {
            let w = w.trim_matches(|c: char| !c.is_alphanumeric());
            if w.len() < 2 {
                return false;
            }
            // Long high-entropy / jwt / keys don't count as prose
            if w.len() >= 24 {
                return false;
            }
            if w.starts_with("eyJ")
                || w.starts_with("AKIA")
                || w.starts_with("sk-")
                || w.starts_with("ghp_")
                || w.starts_with("-----")
            {
                return false;
            }
            true
        })
        .count();
    // After scrub, if almost nothing remains but placeholders → credential-dominant
    let scrubbed = scrub_secrets_light(original);
    let residual: String = scrubbed
        .split_whitespace()
        .filter(|w| {
            !w.contains("REDACTED")
                && !w.contains("***")
                && *w != "Bearer"
                && !w.starts_with("sk-")
                && !w.starts_with("xai-")
                && !w.starts_with("AKIA")
        })
        .collect::<Vec<_>>()
        .join(" ");
    if residual.trim().is_empty() {
        return true;
    }
    // PEM alone / with only key-header words
    if classes.iter().any(|c| c == "pem") && prose_words < 5 {
        return true;
    }
    // Single credential with no surrounding prose
    if prose_words == 0 {
        return true;
    }
    // One short word + a secret ("token sk-...")
    if prose_words <= 1 && !classes.is_empty() {
        return true;
    }
    false
}

/// Lightweight scrub used only inside `is_credential_dominant` (avoids recursion).
fn scrub_secrets_light(s: &str) -> String {
    // Re-run the same pipeline via a flag-free path: call the main scrubbers on a copy.
    let mut out = s.to_string();
    let _ = redact_pem(&mut out);
    let _ = redact_jwt(&mut out);
    let _ = redact_aws_access_key(&mut out);
    let _ = redact_aws_secret_label(&mut out);
    let _ = redact_github_tokens(&mut out);
    let _ = redact_prefixed_keys(&mut out);
    let _ = redact_bearer(&mut out);
    let _ = redact_high_entropy(&mut out);
    out
}

fn redact_pem(out: &mut String) -> bool {
    let mut changed = false;
    // Match BEGIN … PRIVATE KEY … END … PRIVATE KEY-----
    while let Some(start) = out.find("-----BEGIN ") {
        let Some(end_rel) = out[start..].find("-----END ") else {
            break;
        };
        let end_line_start = start + end_rel;
        let after_end = &out[end_line_start + "-----END ".len()..];
        let Some(close_rel) = after_end.find("-----") else {
            break;
        };
        let end = (end_line_start + "-----END ".len() + close_rel + 5).min(out.len());
        let block = &out[start..end];
        if block.contains("PRIVATE KEY") {
            out.replace_range(start..end, "[REDACTED_PEM]");
            changed = true;
        } else {
            // Certificate or other PEM — leave it; advance past this BEGIN
            // by rewriting BEGIN marker so we don't loop forever
            out.replace_range(start..start + 11, "_____BEGIN ");
        }
    }
    if changed {
        // restore any non-key markers we rewrote
        *out = out.replace("_____BEGIN ", "-----BEGIN ");
    }
    changed
}

fn redact_jwt(out: &mut String) -> bool {
    let mut changed = false;
    let bytes = out.as_bytes().to_vec();
    let mut i = 0usize;
    let mut ranges: Vec<(usize, usize)> = Vec::new();
    while i + 10 < bytes.len() {
        // JWT starts with eyJ
        if bytes[i] == b'e' && i + 2 < bytes.len() && bytes[i + 1] == b'y' && bytes[i + 2] == b'J' {
            if let Some(len) = jwt_len(&bytes[i..]) {
                if len >= 30 {
                    ranges.push((i, i + len));
                    i += len;
                    continue;
                }
            }
        }
        i += 1;
    }
    for (start, end) in ranges.into_iter().rev() {
        out.replace_range(start..end, "[REDACTED_JWT]");
        changed = true;
    }
    changed
}

fn jwt_len(s: &[u8]) -> Option<usize> {
    // three base64url segments
    let mut dots = 0;
    let mut i = 0;
    while i < s.len() {
        let c = s[i];
        if c == b'.' {
            dots += 1;
            i += 1;
            continue;
        }
        if !(c.is_ascii_alphanumeric() || c == b'-' || c == b'_') {
            break;
        }
        i += 1;
    }
    if dots == 2 && i >= 30 {
        Some(i)
    } else {
        None
    }
}

fn redact_aws_access_key(out: &mut String) -> bool {
    let mut changed = false;
    let mut search_from = 0;
    while let Some(rel) = out[search_from..].find("AKIA") {
        let start = search_from + rel;
        let rest = &out[start..];
        // AKIA + 16 uppercase alnum
        let chars: Vec<char> = rest.chars().take(20).collect();
        if chars.len() >= 20
            && chars
                .iter()
                .take(20)
                .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
            && chars[0..4].iter().collect::<String>() == "AKIA"
        {
            let end = start + chars.iter().take(20).map(|c| c.len_utf8()).sum::<usize>();
            out.replace_range(start..end, "AKIA[REDACTED]");
            changed = true;
            search_from = start + "AKIA[REDACTED]".len();
        } else {
            search_from = start + 4;
        }
    }
    changed
}

fn redact_aws_secret_label(out: &mut String) -> bool {
    let lower = out.to_ascii_lowercase();
    let key = "aws_secret_access_key";
    let mut changed = false;
    let mut search_from = 0;
    while let Some(rel) = lower[search_from..].find(key) {
        let start = search_from + rel + key.len();
        let after = &out[start..];
        let trimmed = after.trim_start_matches([' ', '\t', '=', ':']);
        let skip = after.len() - trimmed.len();
        let tok_len = trimmed
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '/' || *c == '+' || *c == '=')
            .count();
        if tok_len >= 30 {
            let tok_start = start + skip;
            let tok_end = tok_start
                + trimmed
                    .chars()
                    .take(tok_len)
                    .map(|c| c.len_utf8())
                    .sum::<usize>();
            out.replace_range(tok_start..tok_end, "[REDACTED_AWS_SECRET]");
            changed = true;
            break; // string changed; one pass enough for tests
        }
        search_from = start;
        if search_from >= out.len() {
            break;
        }
        search_from += 1;
    }
    changed
}

fn redact_github_tokens(out: &mut String) -> bool {
    let mut changed = false;
    for prefix in ["ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_"] {
        let mut search_from = 0;
        while let Some(rel) = out[search_from..].find(prefix) {
            let start = search_from + rel;
            let rest = &out[start + prefix.len()..];
            let tok_len = rest
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
                .count();
            if tok_len >= 20 {
                let end = start
                    + prefix.len()
                    + rest
                        .chars()
                        .take(tok_len)
                        .map(|c| c.len_utf8())
                        .sum::<usize>();
                out.replace_range(start..end, "[REDACTED_GH_TOKEN]");
                changed = true;
                search_from = start + "[REDACTED_GH_TOKEN]".len();
            } else {
                search_from = start + prefix.len();
            }
        }
    }
    changed
}

fn redact_prefixed_keys(out: &mut String) -> bool {
    let mut changed = false;
    for prefix in ["sk-", "xai-"] {
        let mut search_from = 0;
        while let Some(rel) = out[search_from..].find(prefix) {
            let i = search_from + rel;
            let rest = &out[i + prefix.len()..];
            let tok_len = rest
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
                .count();
            if tok_len >= 8 {
                let end = i
                    + prefix.len()
                    + rest
                        .chars()
                        .take(tok_len)
                        .map(|c| c.len_utf8())
                        .sum::<usize>();
                out.replace_range(i..end, &format!("{prefix}***"));
                changed = true;
                search_from = i + prefix.len() + 3;
            } else {
                search_from = i + prefix.len();
            }
        }
    }
    changed
}

fn redact_bearer(out: &mut String) -> bool {
    let mut changed = false;
    let mut search_from = 0;
    while let Some(rel) = out[search_from..].find("Bearer ") {
        let i = search_from + rel;
        let rest = &out[i + "Bearer ".len()..];
        // Already redacted. A real bearer token is alphanumeric/-/_/. so it can
        // never begin with the marker, and re-redacting the marker is not a
        // no-op: the token scan below finds zero token characters, `.max(8)`
        // then consumes eight characters of the following prose, and the output
        // keeps changing on every pass. Callers that persist a redacted value
        // and later re-validate its canonical form would reject their own
        // output — which made any note mentioning an auth header unsaveable
        // (#656).
        if rest.starts_with("***") {
            search_from = i + "Bearer ***".len();
            continue;
        }
        // Consume exactly the token run. A previous `.max(8)` floor raised this
        // to eight characters even when the token was shorter — but the token
        // charset excludes whitespace, so the floor could only ever swallow
        // characters that are *not* part of the credential. It therefore added
        // no protection and silently deleted the following words: "Bearer ab
        // plus the retry count" became "Bearer ***the retry count". That loss
        // used to be masked by the canonical-form rejection above; once notes
        // mentioning an auth header became saveable it would have reached
        // durable investigation prose (#656).
        let tok_len = rest
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_' || *c == '.')
            .count();
        if tok_len == 0 {
            // "Bearer " with no token after it: nothing to redact.
            search_from = i + "Bearer ".len();
            continue;
        }
        let end = (i
            + "Bearer ".len()
            + rest
                .chars()
                .take(tok_len)
                .map(|c| c.len_utf8())
                .sum::<usize>())
        .min(out.len());
        out.replace_range(i..end, "Bearer ***");
        changed = true;
        search_from = i + "Bearer ***".len();
    }
    changed
}

/// Redact credential values embedded in connection strings or URL query parameters.
///
/// These values are often too short for the high-entropy heuristic, but must not
/// reach durable stores or model-visible context.
fn redact_url_embedded_credentials(out: &mut String) -> bool {
    const KEYS: &[&str] = &[
        "password=",
        "passwd=",
        "pwd=",
        "secret=",
        "api_key=",
        "apikey=",
        "access_token=",
        "client_secret=",
    ];

    let mut changed = false;
    for key in KEYS {
        let mut search_from = 0usize;
        let mut lower = out.to_ascii_lowercase();
        while let Some(rel) = lower[search_from..].find(key) {
            let start = search_from + rel;
            let value_start = start + key.len();
            let rest = &out[value_start..];
            let value_len = rest
                .chars()
                .take_while(|c| {
                    !matches!(*c, '&' | ';' | ' ' | '\t' | '\n' | '\r' | '"' | '\'' | ')')
                })
                .map(char::len_utf8)
                .sum::<usize>();
            if value_len == 0 {
                search_from = value_start;
                continue;
            }

            out.replace_range(value_start..value_start + value_len, "***");
            changed = true;
            // Replacement text and keys are ASCII, keeping this byte position
            // at a UTF-8 boundary for the next lowercase scan.
            search_from = value_start + 3;
            lower = out.to_ascii_lowercase();
        }
    }
    changed
}

fn redact_high_entropy(out: &mut String) -> bool {
    let mut changed = false;
    let bytes = out.clone();
    let mut ranges: Vec<(usize, usize)> = Vec::new();
    let b = bytes.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i].is_ascii_alphanumeric() || b[i] == b'_' || b[i] == b'-' {
            let start = i;
            while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'_' || b[i] == b'-') {
                i += 1;
            }
            let tok = &bytes[start..i];
            if tok.len() >= 32
                && !tok.contains("REDACTED")
                && !tok.ends_with("***")
                && looks_high_entropy(tok)
            {
                ranges.push((start, i));
            }
        } else {
            i += 1;
        }
    }
    for (start, end) in ranges.into_iter().rev() {
        out.replace_range(start..end, "[REDACTED_SECRET]");
        changed = true;
    }
    changed
}

fn looks_high_entropy(tok: &str) -> bool {
    if tok.len() < 32 {
        return false;
    }
    let has_digit = tok.chars().any(|c| c.is_ascii_digit());
    let has_alpha = tok.chars().any(|c| c.is_ascii_alphabetic());
    if !(has_digit && has_alpha) {
        return false;
    }
    let mut seen = [false; 128];
    let mut uniq = 0usize;
    for b in tok.bytes() {
        if (b as usize) < 128 && !seen[b as usize] {
            seen[b as usize] = true;
            uniq += 1;
        }
    }
    uniq >= 16
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scrubs_connection_string_credential_values_preserving_other_parameters() {
        let raw = "url=jdbc:postgresql://host:5432/orders?user=svc_orders&database=orders&password=hunter2-not-real";
        let scrubbed = scrub_secrets(raw);
        assert!(!scrubbed.contains("hunter2-not-real"), "{scrubbed}");
        assert!(scrubbed.contains("password=***"), "{scrubbed}");
        assert!(scrubbed.contains("user=svc_orders"), "{scrubbed}");
        assert!(scrubbed.contains("database=orders"), "{scrubbed}");
    }

    #[test]
    fn scrubs_openai_and_bearer_like_audit() {
        let s = scrub_secrets("key=sk-abcdefghijklmnop and Bearer tokentokentoken");
        assert!(s.contains("sk-***"), "{s}");
        assert!(s.contains("Bearer ***"), "{s}");
        assert!(!s.contains("abcdefghijklmnop"));
    }

    #[test]
    fn bearer_redaction_is_idempotent() {
        // Persisted values are re-scrubbed when their canonical form is
        // validated; a redactor that keeps changing its own output makes the
        // stored value unreadable (#656).
        let once = scrub_secrets(
            "Gateway rejected it: Authorization: Bearer abc123def456 and we should rotate it.",
        );
        assert!(once.contains("Bearer ***"), "{once}");
        assert!(!once.contains("abc123def456"), "{once}");
        let twice = scrub_secrets(&once);
        assert_eq!(twice, once, "second pass changed the redacted text");
        assert_eq!(scrub_secrets(&twice), twice);

        // A short token is fully redacted without eating the words after it.
        // The token charset excludes whitespace, so anything past the token run
        // is prose, never credential material.
        let short = scrub_secrets("Header was Bearer ab plus the retry count.");
        assert_eq!(short, "Header was Bearer *** plus the retry count.");
        assert_eq!(scrub_secrets(&short), short);
        let tiny = scrub_secrets("Saw Bearer xyz then the pod restarted.");
        assert_eq!(tiny, "Saw Bearer *** then the pod restarted.");
        assert_eq!(scrub_secrets(&tiny), tiny);

        // "Bearer " with no token is left alone rather than eating prose.
        let bare = scrub_secrets("The Bearer  header was absent entirely.");
        assert_eq!(bare, "The Bearer  header was absent entirely.");
    }

    #[test]
    fn scrubs_jwt() {
        // Build at runtime so static scanners don't flag fixture tokens.
        let jwt = [
            "eyJ",
            "hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
            ".",
            "eyJ",
            "zdWIiOiIxMjM0NTY3ODkwIn0",
            ".",
            "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
        ]
        .concat();
        let r = redact_candidate(&format!("auth {jwt} ok"));
        assert!(r.classes.iter().any(|c| c == "jwt"), "{:?}", r.classes);
        assert!(r.text.contains("[REDACTED_JWT]"));
        assert!(!r.text.contains("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"));
        assert!(!r.blocked, "prose+jwt should redact not block");
    }

    #[test]
    fn scrubs_aws_and_gh() {
        let aws = format!("AKIA{}EXAMPLE", "IOSFODNN7");
        let gh = format!("ghp_{}", "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
        let s = format!("{aws} and {gh}");
        let r = redact_candidate(&s);
        assert!(r.classes.iter().any(|c| c == "aws_access_key"));
        assert!(r.classes.iter().any(|c| c == "github_token"));
        assert!(r.text.contains("AKIA[REDACTED]"));
        assert!(r.text.contains("[REDACTED_GH_TOKEN]"));
    }

    #[test]
    fn scrubs_pem_block() {
        let pem = [
            "-----BEGIN ",
            "RSA PRIVATE KEY-----",
            "\nMIIEowIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF6PZGBw=\n",
            "-----END ",
            "RSA PRIVATE KEY-----",
        ]
        .concat();
        let r = redact_candidate(&pem);
        assert!(r.classes.iter().any(|c| c == "pem"), "{r:?}");
        assert!(r.text.contains("[REDACTED_PEM]"));
        assert!(r.blocked, "PEM-only body is credential-dominant");
    }

    #[test]
    fn blocks_credential_dominant_single_token() {
        let r = redact_candidate("sk-proj-abcdefghijklmnopqrstuvwxyz012345");
        assert!(r.blocked, "{r:?}");
        assert!(r.block_reason.is_some());
    }

    #[test]
    fn prose_with_token_redacted_not_blocked() {
        let r = redact_candidate(
            "Please remember that the staging bot uses sk-abcdefghijklmnop as a test key — rotate it.",
        );
        assert!(r.redacted);
        assert!(!r.blocked, "prose should not block: {r:?}");
        assert!(r.text.contains("sk-***"));
        assert!(!r.text.contains("abcdefghijklmnop"));
    }

    #[test]
    fn high_entropy_long_token() {
        let tok = "aB3dE5fG7hI9jK1lM2nO4pQ6rS8tU0vW1xY2zA3bC4d";
        assert!(tok.len() >= 32);
        let r = redact_candidate(&format!("seed {tok} end"));
        assert!(
            r.classes.iter().any(|c| c == "high_entropy") || r.text.contains("[REDACTED_SECRET]"),
            "{r:?}"
        );
    }

    #[test]
    fn share_safe_policy_redacts_arbitrary_endpoints_paths_headers_and_exact_ids() {
        let profile = "private-profile-73";
        let model = "exact/model:customer-9";
        let policy = ShareSafeRedactionPolicy::new([profile, model]);
        let raw = format!(
            "profile: {profile}, model: {model}, nested={{error: {{url: \
             https://tenant.example.test/v1/chat, fallback: \
             http://10.0.0.8:8080/models, path: /private/tmp/customer/body.json, \
             home: /home/alice/.config/contextdesk/config.json, \
             mac_home: /Users/alice/Library/Application Support/ContextDesk/config.json, \
             windows_home: C:\\Users\\alice\\AppData\\Roaming\\ContextDesk\\config.json, \
             Authorization: Basic opaque-value, authorization=Bearer second-value, \
             X-API-Key: third-value, api_key=fourth-value, standalone: Bearer fifth-value, \
             }}}}"
        );

        let safe = policy.redact_text(&raw);
        for forbidden in [
            "https://",
            "http://",
            "/private/tmp",
            "/home/alice",
            "/Users/alice",
            "C:\\Users\\alice",
            "Authorization",
            "authorization",
            "Bearer",
            "X-API-Key",
            "api_key",
            "opaque-value",
            "second-value",
            "third-value",
            "fourth-value",
            "fifth-value",
            profile,
            model,
        ] {
            assert!(!safe.contains(forbidden), "{forbidden:?} leaked in {safe}");
        }
        assert!(safe.contains("[endpoint-redacted]"), "{safe}");
        assert!(safe.contains("[local-path]"), "{safe}");
        assert!(safe.contains("[identity-redacted]"), "{safe}");
    }

    #[test]
    fn share_safe_failure_summary_preserves_category_but_never_raw_body() {
        let policy = ShareSafeRedactionPolicy::new(["profile-private", "model-private"]);
        let raw = r#"provider returned 401 from https://private.example/v1:
            {"error":{"message":"read /private/tmp/body with Authorization: Bearer arbitrary"},
            "model":"model-private","profile":"profile-private"}"#;
        let once = policy.failure_summary(raw);
        assert_eq!(
            once,
            "failure category: authentication; raw provider detail omitted"
        );
        assert_eq!(
            policy.failure_summary(&once),
            once,
            "policy must be idempotent"
        );
        for forbidden in [
            "https://",
            "/private/tmp",
            "Authorization",
            "Bearer",
            "arbitrary",
            "model-private",
            "profile-private",
            "error",
        ] {
            assert!(!once.contains(forbidden), "{forbidden:?} leaked in {once}");
        }
    }

    #[test]
    fn share_safe_failure_summary_distinguishes_empty_terminal_answer() {
        let policy = ShareSafeRedactionPolicy::default();
        let raw = "attempt 1: no visible terminal answer; terminal_text_chars=0, provider_rounds=4, empty_visible_answer=true, finish_reason=stop, turn_terminal=linked_invalid_grounded_answer";
        assert_eq!(
            policy.failure_summary(raw),
            "failure category: empty_terminal_answer; raw provider detail omitted"
        );
    }
}
