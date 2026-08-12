//! Host-owned evidence packet envelope (extension schema v1).
//!
//! Maps to existing concepts: `HostEvidenceLedger` / `FastTriagePacketV1` /
//! investigation binding — without re-implementing those modules.

use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

/// Wire schema id for the extension evidence packet envelope.
pub const EVIDENCE_PACKET_SCHEMA_V1: &str = "contextdesk.extension.evidence_packet.v1";

/// Host time-quality label (aligns with log-analysis / fast-triage vocabulary).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TimeQualityLabel {
    Wall,
    Mixed,
    OrderOnly,
    Unknown,
}

impl TimeQualityLabel {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Wall => "wall",
            Self::Mixed => "mixed",
            Self::OrderOnly => "order_only",
            Self::Unknown => "unknown",
        }
    }
}

/// Explicit privacy boundary for a packet (share-safe vs owner-only).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PacketPrivacyBoundary {
    /// Safe to share without secrets, endpoints, private paths, or raw bodies.
    ShareSafe,
    /// Owner-only; may retain more detail but must never be the default export.
    OwnerOnly,
}

/// One permitted opaque evidence row (host-minted id only).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PacketEvidenceRowV1 {
    /// Host-minted opaque id (e.g. `e:trace:alpha:10`). Never a private path.
    pub evidence_id: String,
    /// Host-minted candidate / group id.
    pub candidate_id: String,
    /// Optional host chronology ordinal (`seq` style).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chronology_ordinal: Option<u64>,
    /// Host role label when known (`initiating_cause`, `downstream_symptom`, …).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    /// Structural scope: `candidate` or `independent`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
}

/// Retrieval provenance for optional embed/rerank attachment (no endpoints).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct RetrievalProvenanceV1 {
    /// Retrieval mode label (`keyword`, `hybrid`, `embedding`, `none`).
    #[serde(default)]
    pub mode: String,
    /// Embedding-space schema id when semantic retrieval was used.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub embedding_space_schema_id: Option<String>,
    /// Endpoint fingerprint only (never URL).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub endpoint_fingerprint: Option<String>,
    /// Exact model id string as configured (not a compatibility claim).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    /// Measured dimensions when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dimensions: Option<u32>,
    /// Dialect id for the embed/rerank wire (`openai_embeddings`, …).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dialect: Option<String>,
}

/// Host-owned truncation record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct PacketTruncationV1 {
    /// True when the host truncated the neighborhood or hit set.
    #[serde(default)]
    pub truncated: bool,
    /// Human/machine reason token (content-free preferred).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// Rows kept after truncation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kept: Option<u32>,
    /// Rows omitted by budget.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub omitted: Option<u32>,
}

/// Host binding for the turn (maps to AnswerBindingV1 fields, secret-free).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PacketBindingV1 {
    pub session_id: String,
    pub turn_id: String,
    pub corpus_id: String,
    /// Host ledger digest (hex or framed hash).
    pub ledger_digest: String,
    /// Optional event/template/suppression revisions when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event_revision: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template_analysis_revision: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suppression_revision: Option<u64>,
}

/// Versioned extension evidence packet envelope.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EvidencePacketV1 {
    /// Must equal [`EVIDENCE_PACKET_SCHEMA_V1`].
    pub schema_id: String,
    /// Host packet identity (maps to fast-triage `packet_id`).
    pub packet_id: String,
    /// SHA-256 (or host digest) over permitted rows + binding.
    pub packet_digest: String,
    pub binding: PacketBindingV1,
    pub time_quality: TimeQualityLabel,
    /// Optional IANA timezone when host declared one (e.g. `Asia/Tokyo`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timezone: Option<String>,
    pub privacy: PacketPrivacyBoundary,
    pub evidence: Vec<PacketEvidenceRowV1>,
    #[serde(default)]
    pub retrieval: RetrievalProvenanceV1,
    #[serde(default)]
    pub truncation: PacketTruncationV1,
    /// Maps to existing production schemas this envelope **extends** (not replaces).
    #[serde(default)]
    pub maps_to_schemas: Vec<String>,
}

/// Parse JSON into an evidence packet (structural only; host still owns truth).
pub fn parse_evidence_packet(raw: &str) -> Result<EvidencePacketV1, super::ExtensionContractError> {
    let value: EvidencePacketV1 =
        serde_json::from_str(raw).map_err(|e| super::ExtensionContractError::Parse {
            context: "evidence_packet",
            detail: e.to_string(),
        })?;
    Ok(value)
}

impl EvidencePacketV1 {
    /// Validate host-owned identity and privacy rules (fail closed).
    pub fn validate(&self) -> Result<(), super::ExtensionContractError> {
        if self.schema_id != EVIDENCE_PACKET_SCHEMA_V1 {
            return Err(super::ExtensionContractError::SchemaMismatch {
                expected: EVIDENCE_PACKET_SCHEMA_V1.into(),
                got: self.schema_id.clone(),
            });
        }
        if self.packet_id.trim().is_empty() {
            return Err(super::ExtensionContractError::MalformedIdentity {
                field: "packet_id".into(),
                reason: "empty".into(),
            });
        }
        if self.packet_digest.trim().is_empty() {
            return Err(super::ExtensionContractError::MalformedIdentity {
                field: "packet_digest".into(),
                reason: "empty".into(),
            });
        }
        for field in [
            ("session_id", self.binding.session_id.as_str()),
            ("turn_id", self.binding.turn_id.as_str()),
            ("corpus_id", self.binding.corpus_id.as_str()),
            ("ledger_digest", self.binding.ledger_digest.as_str()),
        ] {
            if field.1.trim().is_empty() {
                return Err(super::ExtensionContractError::MalformedIdentity {
                    field: field.0.into(),
                    reason: "empty".into(),
                });
            }
        }
        if self.evidence.is_empty() {
            return Err(super::ExtensionContractError::EmptyEvidence);
        }
        let mut seen = BTreeSet::new();
        for row in &self.evidence {
            if row.evidence_id.trim().is_empty() || row.candidate_id.trim().is_empty() {
                return Err(super::ExtensionContractError::MalformedIdentity {
                    field: "evidence_id|candidate_id".into(),
                    reason: "empty".into(),
                });
            }
            // Opaque host ids: no path separators, no URL schemes, no secret shapes.
            if row.evidence_id.contains('/')
                || row.evidence_id.contains('\\')
                || row.evidence_id.contains("://")
            {
                return Err(super::ExtensionContractError::MalformedIdentity {
                    field: "evidence_id".into(),
                    reason: "must be opaque (no paths or URLs)".into(),
                });
            }
            if !seen.insert(row.evidence_id.clone()) {
                return Err(super::ExtensionContractError::DuplicateEvidenceId {
                    evidence_id: row.evidence_id.clone(),
                });
            }
        }
        // Retrieval: if dimensions present without dialect, fail closed.
        if self.retrieval.dimensions.is_some()
            && self
                .retrieval
                .dialect
                .as_ref()
                .map(|s| s.is_empty())
                .unwrap_or(true)
        {
            return Err(super::ExtensionContractError::DimensionSpaceMismatch {
                reason: "dimensions present without retrieval dialect".into(),
            });
        }
        if self.privacy == PacketPrivacyBoundary::ShareSafe {
            let blob = serde_json::to_string(self).unwrap_or_default();
            let findings = super::privacy::scan_share_safe_text(&blob);
            if !findings.is_empty() {
                return Err(super::ExtensionContractError::PrivacyLeak {
                    findings: findings.into_iter().map(|f| f.to_string()).collect(),
                });
            }
        }
        Ok(())
    }
}
