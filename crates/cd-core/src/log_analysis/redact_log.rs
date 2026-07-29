//! Redaction on log ingest (#357) — reuse `cd_core::redact`.

use crate::redact::{redact_candidate, RedactionResult};

/// Maximum UTF-8 bytes persisted for one authoritative redacted source record.
///
/// Redaction is performed on the complete normalized record before this bound
/// is applied, so truncation can never preserve an unredacted prefix.
pub const MAX_ORIGINAL_REDACTED_BYTES: usize = 64 * 1024;

/// Durable, bounded source representation created before parsing/templating.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RedactedOriginal {
    /// Bounded source text after encoding/line-ending normalization and redaction.
    pub text: String,
    /// Source bytes after removing one trailing LF and optional CR.
    pub source_byte_count: u64,
    /// Character count of the complete redacted representation before bounding.
    pub redacted_char_count: u64,
    /// Whether `text` omits a suffix because of the storage bound.
    pub truncated: bool,
    /// Whether invalid UTF-8 was replaced during normalization.
    pub encoding_normalized: bool,
    /// Whether secret redaction changed or blocked the normalized source text.
    pub redaction_applied: bool,
}

/// Complete redacted parser input plus its bounded durable representation.
///
/// The parser never receives the unredacted source record through this path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PreparedOriginal {
    pub parser_text: String,
    pub stored: RedactedOriginal,
}

/// Normalize, redact, and bound one source record before parse/template work.
pub(crate) fn prepare_original_record(raw_record: &[u8]) -> PreparedOriginal {
    let without_lf = raw_record.strip_suffix(b"\n").unwrap_or(raw_record);
    let normalized_bytes = without_lf.strip_suffix(b"\r").unwrap_or(without_lf);
    let source_byte_count = normalized_bytes.len() as u64;
    let decoded = String::from_utf8_lossy(normalized_bytes);
    let encoding_normalized = matches!(decoded, std::borrow::Cow::Owned(_));
    let redaction = redact_candidate(decoded.as_ref());
    // Log records are retained after the full scrub even when the generic
    // memory heuristic calls them credential-dominant. Replacing the entire
    // record would discard non-secret fields and defeat source fidelity; the
    // scrubbed text itself contains the typed secret placeholders.
    let parser_text = redaction.text;
    let redacted_char_count = parser_text.chars().count() as u64;
    let (text, truncated) = truncate_utf8_bytes(&parser_text, MAX_ORIGINAL_REDACTED_BYTES);

    PreparedOriginal {
        parser_text,
        stored: RedactedOriginal {
            text,
            source_byte_count,
            redacted_char_count,
            truncated,
            encoding_normalized,
            redaction_applied: redaction.redacted || redaction.blocked,
        },
    }
}

fn truncate_utf8_bytes(value: &str, max_bytes: usize) -> (String, bool) {
    if value.len() <= max_bytes {
        return (value.to_string(), false);
    }
    let mut end = max_bytes;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    (value.get(..end).unwrap_or_default().to_string(), true)
}

/// Redact a free-form message or param before persist/embed.
pub fn redact_log_text(s: &str) -> RedactionResult {
    redact_candidate(s)
}

/// Redact each param; structure preserved, raw secrets gone.
pub fn redact_params(params: &[String]) -> Vec<String> {
    params
        .iter()
        .map(|p| {
            let r = redact_candidate(p);
            if r.blocked {
                "[REDACTED_CREDENTIAL]".into()
            } else {
                r.text
            }
        })
        .collect()
}

/// Redact message body for store + embed (never blocks the line — structure kept).
pub fn redact_message(message: &str) -> String {
    let r = redact_candidate(message);
    if r.blocked {
        // Keep a typed placeholder rather than dropping the event.
        "[REDACTED_CREDENTIAL_DOMINANT]".into()
    } else {
        r.text
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secrets_stripped_from_params() {
        let params = vec![
            "sk-abcdefghijklmnop".into(),
            "user=42".into(),
            "Bearer eyJhbGciOiJIUzI1NiJ9.aaa.bbb".into(),
        ];
        let out = redact_params(&params);
        assert!(!out[0].contains("abcdefghijklmnop"));
        assert_eq!(out[1], "user=42");
        assert!(!out.iter().any(|p| p.contains("eyJhbGci")));
    }

    #[test]
    fn message_redacts_inline_token() {
        let msg = "auth failed for key sk-abcdefghijklmnop on host";
        let r = redact_message(msg);
        assert!(!r.contains("abcdefghijklmnop"));
        assert!(r.contains("sk-") || r.contains("***") || r.contains("REDACTED"));
    }

    #[test]
    fn original_is_redacted_before_utf8_safe_bounding() {
        let secret = "sk-abcdefghijklmnop";
        let mut raw = format!(
            "prefix={secret} value={}🙂",
            "ordinary value ".repeat(MAX_ORIGINAL_REDACTED_BYTES / 8)
        );
        raw.push('\n');
        let prepared = prepare_original_record(raw.as_bytes());

        assert!(!prepared.parser_text.contains(secret));
        assert!(!prepared.stored.text.contains(secret));
        assert!(prepared.stored.redaction_applied);
        assert!(prepared.stored.truncated);
        assert!(prepared.stored.text.len() <= MAX_ORIGINAL_REDACTED_BYTES);
        assert!(prepared
            .stored
            .text
            .is_char_boundary(prepared.stored.text.len()));
        assert!(prepared.stored.redacted_char_count > prepared.stored.text.chars().count() as u64);
        assert_eq!(prepared.stored.source_byte_count, raw.len() as u64 - 1);
    }

    #[test]
    fn original_records_invalid_utf8_normalization_without_losing_unicode() {
        let prepared = prepare_original_record(b"message=caf\xc3\xa9-\xff\n");
        assert_eq!(prepared.parser_text, "message=café-�");
        assert_eq!(prepared.stored.text, "message=café-�");
        assert!(prepared.stored.encoding_normalized);
        assert!(!prepared.stored.truncated);
        assert_eq!(prepared.stored.source_byte_count, 15);
    }
}
