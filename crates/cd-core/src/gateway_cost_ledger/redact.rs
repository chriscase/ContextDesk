//! Reject or redact secrets and non-share-safe material from ledger inputs.

use crate::redact::ShareSafeRedactionPolicy;
use serde_json::Value;
use thiserror::Error;

#[cfg(test)]
use super::schema::{ComparisonCaveat, FailureCategory, MetricF64, MetricU64, TokenUsage};
use super::schema::{IdentityLabel, LedgerRunRecord};

/// Keys whose presence indicates a non-share-safe payload that must be rejected.
const FORBIDDEN_TOP_LEVEL_KEYS: &[&str] = &[
    "authorization",
    "api_key",
    "apiKey",
    "access_token",
    "accessToken",
    "cookie",
    "set-cookie",
    "raw_prompt",
    "raw_response",
    "raw_provider_body",
    "provider_body",
    "prompt",
    "messages",
    "choices",
    "private_capture",
    "credentials",
];

/// Substrings that must never survive in serialized ledger JSON.
const FORBIDDEN_SUBSTRINGS: &[&str] = &[
    "Authorization:",
    "Bearer ",
    "api_key",
    "X-API-Key",
    "/private/",
    "/Users/",
    "C:\\\\Users\\\\",
    "https://",
    "http://",
];

/// Redaction / rejection failures for ledger ingest.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum LedgerRedactionError {
    /// Input contained a forbidden credential or private-capture field.
    #[error("ledger input rejected: forbidden field `{0}`")]
    ForbiddenField(String),
    /// Serialized ledger still contained a forbidden substring after redaction.
    #[error("ledger output is not share-safe: contains `{0}`")]
    NotShareSafe(String),
}

/// Reject payloads that look like private captures or credential dumps.
pub fn reject_forbidden_fields(value: &Value) -> Result<(), LedgerRedactionError> {
    reject_forbidden_fields_rec(value, "")
}

fn reject_forbidden_fields_rec(value: &Value, path: &str) -> Result<(), LedgerRedactionError> {
    match value {
        Value::Object(map) => {
            for (key, child) in map {
                let lower = key.to_ascii_lowercase();
                if FORBIDDEN_TOP_LEVEL_KEYS
                    .iter()
                    .any(|forbidden| forbidden.eq_ignore_ascii_case(&lower))
                    || lower.contains("authorization")
                    || lower.contains("api_key")
                    || lower.contains("raw_prompt")
                    || lower.contains("raw_response")
                    || lower.contains("provider_body")
                {
                    return Err(LedgerRedactionError::ForbiddenField(if path.is_empty() {
                        key.clone()
                    } else {
                        format!("{path}.{key}")
                    }));
                }
                let next = if path.is_empty() {
                    key.clone()
                } else {
                    format!("{path}.{key}")
                };
                reject_forbidden_fields_rec(child, &next)?;
            }
            Ok(())
        }
        Value::Array(items) => {
            for (idx, child) in items.iter().enumerate() {
                reject_forbidden_fields_rec(child, &format!("{path}[{idx}]"))?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

/// Apply share-safe redaction to every free-text field on a ledger run.
pub fn redact_ledger_run(run: &mut LedgerRunRecord) {
    let policy = ShareSafeRedactionPolicy::default();
    run.run_id = policy.redact_text(&run.run_id);
    run.source_ref = policy.redact_text(&run.source_ref);
    if let Some(build) = run.build_identity.as_mut() {
        *build = policy.redact_text(build);
    }
    run.model = redact_identity(&run.model, &policy);
    run.gateway = redact_identity(&run.gateway, &policy);
    if let Some(role) = run.role_hint.as_mut() {
        *role = policy.redact_text(role);
    }
    if let Some(level) = run.level.as_mut() {
        *level = policy.redact_text(level);
    }
    for category in &mut run.failure_categories {
        let summarized = policy.failure_summary(&category.code);
        let trimmed = summarized
            .split(';')
            .next()
            .unwrap_or(summarized.as_str())
            .trim()
            .trim_start_matches("failure category: ")
            .trim();
        category.code = if trimmed.is_empty() {
            policy.redact_text(&category.code)
        } else {
            trimmed.to_string()
        };
    }
    for classification in &mut run.case_classifications {
        *classification = policy.redact_text(classification);
    }
    for caveat in &mut run.caveats {
        caveat.code = policy.redact_text(&caveat.code);
        caveat.detail = policy.redact_text(&caveat.detail);
    }
    // Metrics are numeric — reaffirm honesty: never invent zeros.
    sanitize_metrics(run);
}

fn redact_identity(label: &IdentityLabel, policy: &ShareSafeRedactionPolicy) -> IdentityLabel {
    match label {
        IdentityLabel::Exact { value } => {
            let redacted = policy.redact_text(value);
            if redacted.contains("[credential-redacted]")
                || redacted.contains("[endpoint-redacted]")
                || redacted.contains("[identity-redacted]")
                || redacted.contains("[path-redacted]")
                || redacted.is_empty()
            {
                IdentityLabel::Unknown
            } else {
                IdentityLabel::Exact { value: redacted }
            }
        }
        IdentityLabel::Pseudonym { value } => {
            let redacted = policy.redact_text(value);
            if redacted.is_empty() {
                IdentityLabel::Unknown
            } else {
                IdentityLabel::Pseudonym { value: redacted }
            }
        }
        IdentityLabel::Unknown => IdentityLabel::Unknown,
    }
}

fn sanitize_metrics(run: &mut LedgerRunRecord) {
    // No-op numeric sanitizer kept for mutation-test visibility: callers must
    // not replace Unknown with Known(0).
    let _ = (
        &run.request_count,
        &run.tokens,
        &run.reported_cost,
        &run.elapsed_ms,
    );
}

/// Assert a serialized ledger / comparison document contains no forbidden
/// material. Used by tests and the CLI before emission.
pub fn assert_share_safe_ledger_json(json: &str) -> Result<(), LedgerRedactionError> {
    for needle in FORBIDDEN_SUBSTRINGS {
        if json.contains(needle) {
            return Err(LedgerRedactionError::NotShareSafe((*needle).to_string()));
        }
    }
    // Credential-shaped blobs that may appear without the Authorization: prefix.
    let lower = json.to_ascii_lowercase();
    for needle in ["sk-live-", "sk-proj-", "ghp_", "xoxb-", "begin private key"] {
        if lower.contains(needle) {
            return Err(LedgerRedactionError::NotShareSafe(needle.to_string()));
        }
    }
    Ok(())
}

/// Helper used by mutation tests: build a run that would leak a secret if
/// redaction were skipped.
#[cfg(test)]
pub(crate) fn leaky_run_for_mutation() -> LedgerRunRecord {
    let mut run = LedgerRunRecord::blank("leak-run", "mutation");
    run.source_ref = "/private/tmp/secret-out".into();
    run.model = IdentityLabel::Exact {
        value: "Authorization: Bearer sk-live-mutation-secret".into(),
    };
    run.gateway = IdentityLabel::Exact {
        value: "https://private.gateway.example/v1".into(),
    };
    run.failure_categories.push(FailureCategory {
        code: "raw body: {\"error\":\"secret\"} Authorization: Bearer tok".into(),
    });
    run.caveats.push(ComparisonCaveat {
        code: "path".into(),
        detail: "see /Users/owner/raw-prompt.json".into(),
    });
    run.request_count = MetricU64::Unknown;
    run.tokens = TokenUsage::default();
    run.reported_cost = MetricF64::Unknown;
    run
}
