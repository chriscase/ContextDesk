//! Immutable evidence items and content-addressed snapshots.

use super::common::{
    require_schema, sha256_hex, validate_bounded_string, validate_id, validate_rfc3339,
    validate_sha256_hex, ContentDigest, PrivacyClass, MAX_EVIDENCE_ITEMS, MAX_STRING_BYTES,
    MAX_SUMMARIES, SNAPSHOT_SCHEMA_V1,
};
use crate::canonical::to_canonical_json;
use crate::error::{BenchError, BenchResult};
use serde::{Deserialize, Serialize};

/// How an external file-server reference was last checked.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VerificationStatus {
    Verified,
    Unverified,
    Unreachable,
}

impl VerificationStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Verified => "verified",
            Self::Unverified => "unverified",
            Self::Unreachable => "unreachable",
        }
    }
}

/// Provenance of a held artifact or reference.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EvidenceSource {
    /// Human-described source/reference (path, mailbox, ticket, URI label).
    pub reference: String,
    pub captured_from: String,
}

/// Held bytes are addressed by digest; originals are never replaced by summaries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HeldContent {
    pub digest: ContentDigest,
    pub byte_length: u64,
}

/// Attributed summary stored beside original bytes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AttributedSummary {
    pub author: String,
    /// `human`, `tool`, or `unknown`.
    pub kind: String,
    pub text: String,
    pub created_at: String,
}

/// One evidence item. Four first-class kinds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum EvidenceItem {
    Log {
        item_id: String,
        #[serde(default)]
        privacy: PrivacyClass,
        capture_time: String,
        source: EvidenceSource,
        media_type: String,
        /// `raw` or `contextdesk.normalized_log_events.v1`.
        format: String,
        content: HeldContent,
        #[serde(default)]
        summaries: Vec<AttributedSummary>,
        #[serde(default = "default_visible")]
        visible_to_strategies: bool,
    },
    Email {
        item_id: String,
        #[serde(default)]
        privacy: PrivacyClass,
        capture_time: String,
        source: EvidenceSource,
        media_type: String,
        content: HeldContent,
        #[serde(default)]
        summaries: Vec<AttributedSummary>,
        #[serde(default = "default_visible")]
        visible_to_strategies: bool,
    },
    Attachment {
        item_id: String,
        #[serde(default)]
        privacy: PrivacyClass,
        capture_time: String,
        source: EvidenceSource,
        media_type: String,
        filename: String,
        content: HeldContent,
        #[serde(default)]
        summaries: Vec<AttributedSummary>,
        #[serde(default = "default_visible")]
        visible_to_strategies: bool,
    },
    ExternalFileServerReference {
        item_id: String,
        #[serde(default)]
        privacy: PrivacyClass,
        capture_time: String,
        source: EvidenceSource,
        uri: String,
        /// Absent when the target was never hashed — visibly unverifiable.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        expected_content_digest: Option<ContentDigest>,
        verification: VerificationStatus,
        #[serde(default)]
        summaries: Vec<AttributedSummary>,
        #[serde(default = "default_visible")]
        visible_to_strategies: bool,
    },
}

fn default_visible() -> bool {
    true
}

impl EvidenceItem {
    pub fn item_id(&self) -> &str {
        match self {
            Self::Log { item_id, .. }
            | Self::Email { item_id, .. }
            | Self::Attachment { item_id, .. }
            | Self::ExternalFileServerReference { item_id, .. } => item_id,
        }
    }

    pub fn privacy(&self) -> PrivacyClass {
        match self {
            Self::Log { privacy, .. }
            | Self::Email { privacy, .. }
            | Self::Attachment { privacy, .. }
            | Self::ExternalFileServerReference { privacy, .. } => *privacy,
        }
    }

    pub fn visible_to_strategies(&self) -> bool {
        match self {
            Self::Log {
                visible_to_strategies,
                ..
            }
            | Self::Email {
                visible_to_strategies,
                ..
            }
            | Self::Attachment {
                visible_to_strategies,
                ..
            }
            | Self::ExternalFileServerReference {
                visible_to_strategies,
                ..
            } => *visible_to_strategies,
        }
    }

    pub fn held_content(&self) -> Option<&HeldContent> {
        match self {
            Self::Log { content, .. }
            | Self::Email { content, .. }
            | Self::Attachment { content, .. } => Some(content),
            Self::ExternalFileServerReference { .. } => None,
        }
    }

    pub fn summaries(&self) -> &[AttributedSummary] {
        match self {
            Self::Log { summaries, .. }
            | Self::Email { summaries, .. }
            | Self::Attachment { summaries, .. }
            | Self::ExternalFileServerReference { summaries, .. } => summaries,
        }
    }

    pub fn validate(&self) -> BenchResult<()> {
        validate_id("item_id", self.item_id())?;
        match self {
            Self::Log {
                capture_time,
                source,
                media_type,
                format,
                content,
                summaries,
                ..
            } => {
                validate_rfc3339("capture_time", capture_time)?;
                validate_source(source)?;
                validate_bounded_string("media_type", media_type, 256)?;
                validate_bounded_string("format", format, 256)?;
                validate_held(content)?;
                validate_summaries(summaries)?;
            }
            Self::Email {
                capture_time,
                source,
                media_type,
                content,
                summaries,
                ..
            }
            | Self::Attachment {
                capture_time,
                source,
                media_type,
                content,
                summaries,
                ..
            } => {
                validate_rfc3339("capture_time", capture_time)?;
                validate_source(source)?;
                validate_bounded_string("media_type", media_type, 256)?;
                validate_held(content)?;
                validate_summaries(summaries)?;
                if let Self::Attachment { filename, .. } = self {
                    validate_bounded_string("filename", filename, 512)?;
                    if filename.contains('/') || filename.contains('\\') || filename.contains("..")
                    {
                        return Err(BenchError::Schema(
                            "filename must be a basename without path separators".into(),
                        ));
                    }
                }
            }
            Self::ExternalFileServerReference {
                capture_time,
                source,
                uri,
                expected_content_digest,
                verification,
                summaries,
                ..
            } => {
                validate_rfc3339("capture_time", capture_time)?;
                validate_source(source)?;
                validate_bounded_string("uri", uri, 4096)?;
                if uri.trim().is_empty() {
                    return Err(BenchError::Schema("external reference uri is empty".into()));
                }
                if let Some(digest) = expected_content_digest {
                    validate_held(&HeldContent {
                        digest: digest.clone(),
                        byte_length: 0,
                    })?;
                } else if *verification == VerificationStatus::Verified {
                    return Err(BenchError::Schema(
                        "verified external references require expected_content_digest".into(),
                    ));
                }
                validate_summaries(summaries)?;
            }
        }
        Ok(())
    }
}

fn validate_source(source: &EvidenceSource) -> BenchResult<()> {
    validate_bounded_string("source.reference", &source.reference, 4096)?;
    validate_bounded_string("source.captured_from", &source.captured_from, 1024)?;
    Ok(())
}

fn validate_held(content: &HeldContent) -> BenchResult<()> {
    if content.digest.algorithm != "sha256" {
        return Err(BenchError::Schema(
            "held content digest algorithm must be sha256".into(),
        ));
    }
    validate_sha256_hex(&content.digest.hex)?;
    Ok(())
}

fn validate_summaries(summaries: &[AttributedSummary]) -> BenchResult<()> {
    if summaries.len() > MAX_SUMMARIES {
        return Err(BenchError::Schema("too many summaries".into()));
    }
    for (i, summary) in summaries.iter().enumerate() {
        validate_bounded_string(&format!("summaries[{i}].author"), &summary.author, 512)?;
        validate_bounded_string(&format!("summaries[{i}].kind"), &summary.kind, 64)?;
        validate_bounded_string(
            &format!("summaries[{i}].text"),
            &summary.text,
            MAX_STRING_BYTES,
        )?;
        validate_rfc3339(&format!("summaries[{i}].created_at"), &summary.created_at)?;
        if !matches!(summary.kind.as_str(), "human" | "tool" | "unknown") {
            return Err(BenchError::Schema(
                "summary kind must be human, tool, or unknown".into(),
            ));
        }
    }
    Ok(())
}

/// Immutable, content-addressed evidence manifest. Identity is the digest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EvidenceSnapshot {
    pub schema_id: String,
    pub snapshot_id: String,
    #[serde(default)]
    pub privacy: PrivacyClass,
    pub case_id: String,
    pub captured_at: String,
    pub captured_by: String,
    pub items: Vec<EvidenceItem>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

/// Body hashed for snapshot identity. Excludes `snapshot_id` so identity is
/// a function of content, not of a caller-supplied label.
#[derive(Serialize)]
struct SnapshotDigestBody<'a> {
    schema_id: &'a str,
    privacy: PrivacyClass,
    case_id: &'a str,
    captured_at: &'a str,
    captured_by: &'a str,
    items: &'a [EvidenceItem],
    notes: &'a Option<String>,
}

impl EvidenceSnapshot {
    pub fn parse_json(text: &str) -> BenchResult<Self> {
        let parsed: Self = serde_json::from_str(text).map_err(BenchError::from_serde)?;
        parsed.validate()?;
        Ok(parsed)
    }

    pub fn validate(&self) -> BenchResult<()> {
        require_schema(&self.schema_id, SNAPSHOT_SCHEMA_V1)?;
        validate_id("snapshot_id", &self.snapshot_id)?;
        validate_id("case_id", &self.case_id)?;
        validate_rfc3339("captured_at", &self.captured_at)?;
        validate_bounded_string("captured_by", &self.captured_by, 512)?;
        if let Some(notes) = &self.notes {
            validate_bounded_string("notes", notes, MAX_STRING_BYTES)?;
        }
        if self.items.len() > MAX_EVIDENCE_ITEMS {
            return Err(BenchError::Schema("too many evidence items".into()));
        }
        if self.items.is_empty() {
            return Err(BenchError::Schema(
                "snapshot must contain at least one item".into(),
            ));
        }
        let mut seen = std::collections::BTreeSet::new();
        let mut last_id: Option<&str> = None;
        for item in &self.items {
            item.validate()?;
            if !seen.insert(item.item_id().to_string()) {
                return Err(BenchError::Schema(format!(
                    "duplicate evidence item_id {}",
                    item.item_id()
                )));
            }
            if let Some(prev) = last_id {
                if item.item_id() < prev {
                    return Err(BenchError::Schema(
                        "evidence items must be sorted by item_id".into(),
                    ));
                }
            }
            last_id = Some(item.item_id());
        }
        let expected = self.compute_snapshot_id()?;
        if self.snapshot_id != expected {
            return Err(BenchError::Integrity(format!(
                "snapshot_id does not match content digest (expected {expected})"
            )));
        }
        Ok(())
    }

    pub fn compute_snapshot_id(&self) -> BenchResult<String> {
        compute_snapshot_id(
            &self.schema_id,
            self.privacy,
            &self.case_id,
            &self.captured_at,
            &self.captured_by,
            &self.items,
            &self.notes,
        )
    }

    /// Build a snapshot, assigning `snapshot_id` from the content digest.
    pub fn from_parts(
        privacy: PrivacyClass,
        case_id: String,
        captured_at: String,
        captured_by: String,
        mut items: Vec<EvidenceItem>,
        notes: Option<String>,
    ) -> BenchResult<Self> {
        items.sort_by(|a, b| a.item_id().cmp(b.item_id()));
        let snapshot_id = compute_snapshot_id(
            SNAPSHOT_SCHEMA_V1,
            privacy,
            &case_id,
            &captured_at,
            &captured_by,
            &items,
            &notes,
        )?;
        let snapshot = Self {
            schema_id: SNAPSHOT_SCHEMA_V1.into(),
            snapshot_id,
            privacy,
            case_id,
            captured_at,
            captured_by,
            items,
            notes,
        };
        snapshot.validate()?;
        Ok(snapshot)
    }

    pub fn item(&self, item_id: &str) -> Option<&EvidenceItem> {
        self.items.iter().find(|item| item.item_id() == item_id)
    }
}

fn compute_snapshot_id(
    schema_id: &str,
    privacy: PrivacyClass,
    case_id: &str,
    captured_at: &str,
    captured_by: &str,
    items: &[EvidenceItem],
    notes: &Option<String>,
) -> BenchResult<String> {
    let body = SnapshotDigestBody {
        schema_id,
        privacy,
        case_id,
        captured_at,
        captured_by,
        items,
        notes,
    };
    let canonical = to_canonical_json(&body)?;
    Ok(format!("snap-{}", sha256_hex(canonical.as_bytes())))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn log_item(bytes: &[u8]) -> EvidenceItem {
        EvidenceItem::Log {
            item_id: "ev-log-1".into(),
            privacy: PrivacyClass::OwnerOnly,
            capture_time: "2026-01-15T04:12:00Z".into(),
            source: EvidenceSource {
                reference: "logs/app.log".into(),
                captured_from: "synthetic fixture".into(),
            },
            media_type: "text/plain".into(),
            format: "raw".into(),
            content: HeldContent {
                digest: ContentDigest::of_bytes(bytes),
                byte_length: bytes.len() as u64,
            },
            summaries: vec![AttributedSummary {
                author: "fixture-author".into(),
                kind: "human".into(),
                text: "Checkout errors around 04:12Z".into(),
                created_at: "2026-01-15T05:00:00Z".into(),
            }],
            visible_to_strategies: true,
        }
    }

    #[test]
    fn snapshot_id_is_content_addressed_and_stable() {
        let bytes = b"error checkout\n";
        let a = EvidenceSnapshot::from_parts(
            PrivacyClass::OwnerOnly,
            "case-1".into(),
            "2026-01-15T06:00:00Z".into(),
            "operator".into(),
            vec![log_item(bytes)],
            None,
        )
        .unwrap();
        let b = EvidenceSnapshot::from_parts(
            PrivacyClass::OwnerOnly,
            "case-1".into(),
            "2026-01-15T06:00:00Z".into(),
            "operator".into(),
            vec![log_item(bytes)],
            None,
        )
        .unwrap();
        assert_eq!(a.snapshot_id, b.snapshot_id);
        let mut mutated = a.clone();
        mutated.notes = Some("tamper".into());
        assert_ne!(mutated.compute_snapshot_id().unwrap(), a.snapshot_id);
    }

    #[test]
    fn unverifiable_external_reference_is_allowed() {
        let item = EvidenceItem::ExternalFileServerReference {
            item_id: "ev-ref-1".into(),
            privacy: PrivacyClass::OwnerOnly,
            capture_time: "2026-01-15T04:12:00Z".into(),
            source: EvidenceSource {
                reference: "fileserver://archives/incident.bin".into(),
                captured_from: "ticket attachment list".into(),
            },
            uri: "fileserver://archives/incident.bin".into(),
            expected_content_digest: None,
            verification: VerificationStatus::Unverified,
            summaries: vec![],
            visible_to_strategies: true,
        };
        item.validate().unwrap();
        let snapshot = EvidenceSnapshot::from_parts(
            PrivacyClass::ShareSafe,
            "case-1".into(),
            "2026-01-15T06:00:00Z".into(),
            "operator".into(),
            vec![item],
            None,
        )
        .unwrap();
        assert!(snapshot.items[0].held_content().is_none());
    }
}
