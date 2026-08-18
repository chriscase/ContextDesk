//! Shared schema identifiers, privacy, unknown-preserving observations, and ids.

use crate::error::{BenchError, BenchResult};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const LIBRARY_SCHEMA_V1: &str = "contextdesk.triage_bench.library.v1";
pub const CASE_SCHEMA_V1: &str = "contextdesk.triage_bench.case.v1";
pub const SNAPSHOT_SCHEMA_V1: &str = "contextdesk.triage_bench.evidence_snapshot.v1";
pub const TASK_SCHEMA_V1: &str = "contextdesk.triage_bench.evaluation_task.v1";
pub const PACKET_SCHEMA_V1: &str = "contextdesk.triage_bench.task_packet.v1";
pub const PACKET_SCHEMA_V2: &str = "contextdesk.triage_bench.task_packet.v2";
pub const REVIEW_PACKET_SCHEMA_V1: &str = "contextdesk.triage_bench.review_packet.v1";
pub const REVIEW_PACKET_SCHEMA_V2: &str = "contextdesk.triage_bench.review_packet.v2";
pub const RUN_SCHEMA_V1: &str = "contextdesk.triage_bench.triage_run.v1";
pub const RUN_SCHEMA_V2: &str = "contextdesk.triage_bench.triage_run.v2";
pub const RUN_IMPORT_SCHEMA_V1: &str = "contextdesk.triage_bench.run_import.v1";
pub const ADJUDICATION_SCHEMA_V1: &str = "contextdesk.triage_bench.adjudication.v1";
pub const ADJUDICATION_SCHEMA_V2: &str = "contextdesk.triage_bench.adjudication.v2";
pub const SCORE_SCHEMA_V1: &str = "contextdesk.triage_bench.score_review.v1";
pub const REPORT_SCHEMA_V1: &str = "contextdesk.triage_bench.backtest_report.v1";
pub const REPORT_SCHEMA_V2: &str = "contextdesk.triage_bench.backtest_report.v2";
pub const RUBRIC_V1: &str = "contextdesk.triage_bench.rubric.v1";
pub const RUBRIC_V2: &str = "contextdesk.triage_bench.rubric.v2";

pub const MAX_ID_CHARS: usize = 192;
pub const MAX_STRING_BYTES: usize = 64 * 1024;
pub const MAX_RAW_INLINE_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_EVIDENCE_ITEMS: usize = 4096;
pub const MAX_CLAIMS: usize = 256;
pub const MAX_SUMMARIES: usize = 64;
pub const MAX_TIMELINE_NOTES: usize = 64;
pub const MAX_RATIONALE_BYTES: usize = 32 * 1024;

/// Privacy class carried on every durable artifact. Default is owner-only.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum PrivacyClass {
    #[default]
    OwnerOnly,
    ShareSafe,
}

impl PrivacyClass {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::OwnerOnly => "owner_only",
            Self::ShareSafe => "share_safe",
        }
    }

    /// Combine privacy labels without ever weakening either input.
    pub fn restrict_with(self, other: Self) -> Self {
        if self == Self::OwnerOnly || other == Self::OwnerOnly {
            Self::OwnerOnly
        } else {
            Self::ShareSafe
        }
    }

    /// True when `self` would expose material classified as `source`.
    pub fn is_downgrade_from(self, source: Self) -> bool {
        self == Self::ShareSafe && source == Self::OwnerOnly
    }
}

/// Per-field completeness. Never reconstructed by the bench.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Completeness {
    Exact,
    Partial,
    Unknown,
}

impl Completeness {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Exact => "exact",
            Self::Partial => "partial",
            Self::Unknown => "unknown",
        }
    }
}

/// Observed value that can be genuinely unknown. Distinct from zero or empty.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, Default)]
#[serde(tag = "status", content = "value", rename_all = "snake_case")]
pub enum Observed<T> {
    #[default]
    Unknown,
    Known(T),
}

impl<T> Observed<T> {
    pub fn is_unknown(&self) -> bool {
        matches!(self, Self::Unknown)
    }

    pub fn known(value: T) -> Self {
        Self::Known(value)
    }
}

/// SHA-256 content digest. Algorithm is explicit so unknown hashes stay unknown.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ContentDigest {
    pub algorithm: String,
    pub hex: String,
}

impl ContentDigest {
    pub fn sha256_hex(hex: impl Into<String>) -> BenchResult<Self> {
        let hex = hex.into().to_ascii_lowercase();
        validate_sha256_hex(&hex)?;
        Ok(Self {
            algorithm: "sha256".into(),
            hex,
        })
    }

    pub fn of_bytes(bytes: &[u8]) -> Self {
        Self {
            algorithm: "sha256".into(),
            hex: sha256_hex(bytes),
        }
    }

    pub fn wire(&self) -> String {
        format!("{}:{}", self.algorithm, self.hex)
    }
}

/// SHA-256 hex of `bytes`.
pub fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub fn validate_sha256_hex(hex: &str) -> BenchResult<()> {
    if hex.len() == 64 && hex.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f')) {
        Ok(())
    } else {
        Err(BenchError::Schema(
            "content digest hex must be 64 lowercase sha256 characters".into(),
        ))
    }
}

/// Opaque durable identity. Filesystem-safe; no path separators.
pub fn validate_id(field: &str, value: &str) -> BenchResult<()> {
    if value.is_empty() || value.len() > MAX_ID_CHARS {
        return Err(BenchError::Schema(format!(
            "{field} must be 1..{MAX_ID_CHARS} characters"
        )));
    }
    if value.contains("..") || value.contains('/') || value.contains('\\') {
        return Err(BenchError::Schema(format!(
            "{field} must not contain path separators or '..'"
        )));
    }
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return Err(BenchError::Schema(format!("{field} is empty")));
    };
    if !first.is_ascii_alphanumeric() {
        return Err(BenchError::Schema(format!(
            "{field} must start with an ASCII alphanumeric"
        )));
    }
    if !chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ':')) {
        return Err(BenchError::Schema(format!(
            "{field} contains an unsupported character"
        )));
    }
    Ok(())
}

pub fn validate_bounded_string(field: &str, value: &str, max_bytes: usize) -> BenchResult<()> {
    if value.len() > max_bytes {
        return Err(BenchError::Schema(format!(
            "{field} exceeds {max_bytes} bytes"
        )));
    }
    if value.contains('\0') {
        return Err(BenchError::Schema(format!("{field} contains a NUL byte")));
    }
    Ok(())
}

pub fn validate_rfc3339(field: &str, value: &str) -> BenchResult<()> {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|_| ())
        .map_err(|_| BenchError::Schema(format!("{field} must be RFC3339")))
}

pub fn require_schema(got: &str, expected: &str) -> BenchResult<()> {
    if got == expected {
        Ok(())
    } else {
        Err(BenchError::Schema(format!(
            "schema_id must be {expected}, got {got}"
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_is_distinct_from_known_zero() {
        let unknown: Observed<u64> = Observed::Unknown;
        let zero = Observed::Known(0);
        assert_ne!(unknown, zero);
        let json = serde_json::to_string(&unknown).unwrap();
        assert_eq!(json, "{\"status\":\"unknown\"}");
        let back: Observed<u64> = serde_json::from_str(&json).unwrap();
        assert!(back.is_unknown());
    }

    #[test]
    fn default_privacy_is_owner_only() {
        assert_eq!(PrivacyClass::default(), PrivacyClass::OwnerOnly);
    }

    #[test]
    fn path_like_ids_are_rejected() {
        assert!(validate_id("case_id", "../secret").is_err());
        assert!(validate_id("case_id", "a/b").is_err());
        assert!(validate_id("case_id", "case-ok").is_ok());
    }
}
