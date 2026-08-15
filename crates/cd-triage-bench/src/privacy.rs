//! Share-safe scanning for reports. Fail closed; never invent redactions.

use crate::error::{BenchError, BenchResult};

pub const PRIVACY_FORBIDDEN_SUBSTRINGS: &[&str] = &[
    "/users/",
    "/home/",
    "c:\\users",
    "sk-",
    "bearer ",
    "xai-",
    "ghp_",
    "authorization:",
];

/// Scan text for credential-shaped or private-path substrings.
pub fn scan_privacy_text(text: &str) -> Vec<String> {
    let normalized = text.to_ascii_lowercase();
    let mut findings = Vec::new();
    for token in PRIVACY_FORBIDDEN_SUBSTRINGS {
        if contains_token(&normalized, token) {
            findings.push(format!("forbidden substring `{token}`"));
        }
    }
    findings.sort();
    findings.dedup();
    findings
}

fn contains_token(haystack: &str, token: &str) -> bool {
    let mut start = 0;
    while let Some(idx) = haystack[start..].find(token) {
        let abs = start + idx;
        let prev = abs
            .checked_sub(1)
            .and_then(|i| haystack.as_bytes().get(i).copied());
        // Avoid matching inside ordinary identifiers (`task-` contains `sk-`).
        let letter_prefix = prev.is_some_and(|b| b.is_ascii_alphabetic());
        if !letter_prefix {
            return true;
        }
        start = abs + 1;
    }
    false
}

pub fn gate_share_safe_text(text: &str) -> BenchResult<()> {
    let findings = scan_privacy_text(text);
    if findings.is_empty() {
        Ok(())
    } else {
        Err(BenchError::Privacy(findings.join("; ")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn share_safe_gate_rejects_key_shaped_text() {
        let err = gate_share_safe_text("token sk-example").unwrap_err();
        assert!(err.to_string().contains("sk-"));
    }

    #[test]
    fn task_ids_are_not_false_positive_openai_keys() {
        gate_share_safe_text("task-abcdef0123456789").unwrap();
    }
}
