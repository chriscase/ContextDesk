//! Secret-safe rendering for assertion messages, debug output, and panics.
//!
//! The gateway must still *record* whatever bytes actually crossed the
//! wire — including a real synthetic secret in an `Authorization` header —
//! because proving the client attached the right credential is part of the
//! contract. What must never happen is a raw secret value landing in test
//! **output**: an assertion failure message, a `panic!`, or anything a CI
//! log captures. `redact` is the seam every such rendering should pass
//! through.

use sha2::{Digest, Sha256};

/// Replace every occurrence of each `secrets` value in `text` with a short,
/// stable, non-reversible marker (`<redacted:XXXXXXXX>`), distinct per
/// distinct secret so tests can still tell two redactions apart without
/// recovering either value.
pub fn redact(text: &str, secrets: &[&str]) -> String {
    let mut out = text.to_string();
    for secret in secrets {
        if secret.is_empty() {
            continue;
        }
        let marker = format!("<redacted:{}>", short_hash(secret));
        out = out.replace(*secret, &marker);
    }
    out
}

fn short_hash(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    digest.iter().take(4).map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_every_occurrence_and_hides_the_raw_value() {
        let out = redact(
            "Authorization: Bearer sk-test-abc123 (also sk-test-abc123 again)",
            &["sk-test-abc123"],
        );
        assert!(!out.contains("sk-test-abc123"));
        assert!(out.contains("<redacted:"));
        assert_eq!(out.matches("<redacted:").count(), 2);
    }

    #[test]
    fn distinct_secrets_get_distinct_stable_markers() {
        let a = redact("one two", &["one"]);
        let b = redact("one two", &["two"]);
        assert_ne!(a, b);
        // Stable: hashing the same secret twice yields the same marker.
        let a_again = redact("one two", &["one"]);
        assert_eq!(a, a_again);
    }
}
