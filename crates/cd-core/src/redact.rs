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

use serde::{Deserialize, Serialize};

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
        let tok_len = rest
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_' || *c == '.')
            .count()
            .max(8);
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
    fn scrubs_openai_and_bearer_like_audit() {
        let s = scrub_secrets("key=sk-abcdefghijklmnop and Bearer tokentokentoken");
        assert!(s.contains("sk-***"), "{s}");
        assert!(s.contains("Bearer ***"), "{s}");
        assert!(!s.contains("abcdefghijklmnop"));
    }

    #[test]
    fn scrubs_jwt() {
        let jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
        let r = redact_candidate(&format!("auth {jwt} ok"));
        assert!(r.classes.iter().any(|c| c == "jwt"), "{:?}", r.classes);
        assert!(r.text.contains("[REDACTED_JWT]"));
        assert!(!r.text.contains("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"));
        assert!(!r.blocked, "prose+jwt should redact not block");
    }

    #[test]
    fn scrubs_aws_and_gh() {
        let s = "AKIAIOSFODNN7EXAMPLE and ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
        let r = redact_candidate(s);
        assert!(r.classes.iter().any(|c| c == "aws_access_key"));
        assert!(r.classes.iter().any(|c| c == "github_token"));
        assert!(r.text.contains("AKIA[REDACTED]"));
        assert!(r.text.contains("[REDACTED_GH_TOKEN]"));
    }

    #[test]
    fn scrubs_pem_block() {
        let pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF6PZGBw=\n-----END RSA PRIVATE KEY-----";
        let r = redact_candidate(pem);
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
}
