//! Redaction on log ingest (#357) — reuse `cd_core::redact`.

use crate::redact::{redact_candidate, RedactionResult};

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
}
