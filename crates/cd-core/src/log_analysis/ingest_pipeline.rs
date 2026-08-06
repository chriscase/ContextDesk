//! Semantic ingest-pipeline identity for disposable log corpora.
//!
//! This identity covers **parsing, framing, normalization/redaction,
//! template-mining, and relevant DuckDB storage semantics** used when a corpus
//! is created. It is intentionally **not** the Git SHA / app build identity —
//! those change continuously without changing how lines are framed or stored.
//!
//! Policy:
//! - New corpora record [`INGEST_PIPELINE_IDENTITY`].
//! - Missing / empty / null → [`IngestPipelineCompatibility::LegacyUnknown`].
//! - Present but ≠ current → [`IngestPipelineCompatibility::DifferentVersion`].
//! - Malformed field values fail soft: corpus remains readable; compatibility
//!   is [`DifferentVersion`] (never "broken").
//! - Identity strings never include source paths, corpus contents, or secrets.

use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// Stable semantic id for the current ingest pipeline (parse/frame/normalize/
/// template/storage). Bump the trailing version component when those semantics
/// change in a way that can affect how already-imported events were shaped.
pub const INGEST_PIPELINE_IDENTITY: &str = "contextdesk.ingest_pipeline.v1";

/// Human-oriented, machine-stable description of what the identity covers.
/// Privacy-safe: no paths, contents, or credentials.
pub const INGEST_PIPELINE_SEMANTICS: &str =
    "parse,frame,normalize_redact,template_mining,duckdb_event_store";

/// Sentinel written when on-disk `ingestPipelineIdentity` is present but not a
/// usable string. Comparing it to [`INGEST_PIPELINE_IDENTITY`] yields
/// [`IngestPipelineCompatibility::DifferentVersion`].
pub(crate) const INGEST_PIPELINE_MALFORMED_SENTINEL: &str = "contextdesk.ingest_pipeline.malformed";

/// How a persisted corpus relates to this process's ingest pipeline.
///
/// Deliberately **not** named "broken" / "corrupt" — age alone is not a defect.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IngestPipelineCompatibility {
    /// Persisted identity matches [`INGEST_PIPELINE_IDENTITY`].
    Current,
    /// Field absent, empty, or null on disk (pre-provenance corpora).
    LegacyUnknown,
    /// Field present but not equal to the current identity (including
    /// future/past versions and soft-failed malformed values).
    DifferentVersion,
}

impl IngestPipelineCompatibility {
    /// Short CLI / UI label (no punctuation noise).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Current => "current",
            Self::LegacyUnknown => "legacy_unknown",
            Self::DifferentVersion => "different_version",
        }
    }

    /// Whether the host should surface a reimport advisory (never auto-mutate).
    pub fn needs_reimport_advisory(self) -> bool {
        matches!(self, Self::LegacyUnknown | Self::DifferentVersion)
    }
}

impl std::fmt::Display for IngestPipelineCompatibility {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Classify a stored identity against this binary's pipeline.
///
/// - `None` / empty → [`LegacyUnknown`]
/// - equal to [`INGEST_PIPELINE_IDENTITY`] → [`Current`]
/// - anything else → [`DifferentVersion`]
pub fn classify_ingest_pipeline_identity(stored: Option<&str>) -> IngestPipelineCompatibility {
    match stored.map(str::trim).filter(|s| !s.is_empty()) {
        None => IngestPipelineCompatibility::LegacyUnknown,
        Some(s) if s == INGEST_PIPELINE_IDENTITY => IngestPipelineCompatibility::Current,
        Some(_) => IngestPipelineCompatibility::DifferentVersion,
    }
}

/// Privacy-safe: identity must be short ASCII token characters only.
pub fn is_well_formed_ingest_pipeline_identity(value: &str) -> bool {
    let trimmed = value.trim();
    !trimmed.is_empty()
        && trimmed.len() <= 160
        && trimmed
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'))
}

/// Deserialize `ingestPipelineIdentity` without failing the whole meta document.
///
/// Non-string / invalid tokens become the malformed sentinel so the corpus
/// still opens and compatibility reports [`DifferentVersion`].
pub fn deserialize_optional_ingest_pipeline_identity<'de, D>(
    deserializer: D,
) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Option::<serde_json::Value>::deserialize(deserializer)?;
    Ok(normalize_ingest_pipeline_identity_value(value))
}

/// Serialize optional identity; omit when `None`.
pub fn serialize_optional_ingest_pipeline_identity<S>(
    value: &Option<String>,
    serializer: S,
) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    match value {
        Some(s) => serializer.serialize_some(s),
        None => serializer.serialize_none(),
    }
}

pub(crate) fn normalize_ingest_pipeline_identity_value(
    value: Option<serde_json::Value>,
) -> Option<String> {
    match value {
        None | Some(serde_json::Value::Null) => None,
        Some(serde_json::Value::String(s)) => {
            let trimmed = s.trim();
            if trimmed.is_empty() {
                None
            } else if is_well_formed_ingest_pipeline_identity(trimmed) {
                Some(trimmed.to_string())
            } else {
                Some(INGEST_PIPELINE_MALFORMED_SENTINEL.to_string())
            }
        }
        Some(_) => Some(INGEST_PIPELINE_MALFORMED_SENTINEL.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_and_empty_are_legacy_unknown() {
        assert_eq!(
            classify_ingest_pipeline_identity(None),
            IngestPipelineCompatibility::LegacyUnknown
        );
        assert_eq!(
            classify_ingest_pipeline_identity(Some("")),
            IngestPipelineCompatibility::LegacyUnknown
        );
        assert_eq!(
            classify_ingest_pipeline_identity(Some("   ")),
            IngestPipelineCompatibility::LegacyUnknown
        );
    }

    #[test]
    fn current_identity_matches() {
        assert_eq!(
            classify_ingest_pipeline_identity(Some(INGEST_PIPELINE_IDENTITY)),
            IngestPipelineCompatibility::Current
        );
    }

    #[test]
    fn past_and_future_versions_are_different() {
        assert_eq!(
            classify_ingest_pipeline_identity(Some("contextdesk.ingest_pipeline.v0")),
            IngestPipelineCompatibility::DifferentVersion
        );
        assert_eq!(
            classify_ingest_pipeline_identity(Some("contextdesk.ingest_pipeline.v99")),
            IngestPipelineCompatibility::DifferentVersion
        );
    }

    #[test]
    fn malformed_values_normalize_softly() {
        assert_eq!(
            normalize_ingest_pipeline_identity_value(Some(serde_json::json!(42))),
            Some(INGEST_PIPELINE_MALFORMED_SENTINEL.to_string())
        );
        assert_eq!(
            normalize_ingest_pipeline_identity_value(Some(serde_json::json!("has spaces"))),
            Some(INGEST_PIPELINE_MALFORMED_SENTINEL.to_string())
        );
        assert_eq!(
            classify_ingest_pipeline_identity(Some(INGEST_PIPELINE_MALFORMED_SENTINEL)),
            IngestPipelineCompatibility::DifferentVersion
        );
    }

    #[test]
    fn identity_has_no_path_or_secret_shape() {
        let blob = format!("{INGEST_PIPELINE_IDENTITY}\n{INGEST_PIPELINE_SEMANTICS}");
        for bad in ["/Users/", "/home/", "api_key", "password=", "Bearer "] {
            assert!(
                !blob.to_lowercase().contains(&bad.to_lowercase()),
                "identity must not contain {bad:?}"
            );
        }
        assert!(!INGEST_PIPELINE_IDENTITY.contains('/'));
    }

    #[test]
    fn advisory_only_for_non_current() {
        assert!(!IngestPipelineCompatibility::Current.needs_reimport_advisory());
        assert!(IngestPipelineCompatibility::LegacyUnknown.needs_reimport_advisory());
        assert!(IngestPipelineCompatibility::DifferentVersion.needs_reimport_advisory());
    }
}
