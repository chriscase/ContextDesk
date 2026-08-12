//! Role-capability contract for extension multi-model and retrieval roles.
//!
//! Model names must never imply compatibility. Compatibility is only ever
//! established by measured dialect/mode evidence elsewhere
//! ([`crate::capability_qualification`]).

use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

/// Wire schema id for a role-capability descriptor.
pub const ROLE_CAPABILITY_SCHEMA_V1: &str = "contextdesk.extension.role_capability.v1";

/// Extension roles for future multi-model triage / retrieval.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExtensionRole {
    ObservationExtractor,
    TimelineAnalyst,
    EvidenceGapFinder,
    ContradictionChecker,
    /// Synthesizer / reviewer (host still validates).
    SynthesizerReviewer,
    Embedding,
    Reranker,
}

impl ExtensionRole {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ObservationExtractor => "observation_extractor",
            Self::TimelineAnalyst => "timeline_analyst",
            Self::EvidenceGapFinder => "evidence_gap_finder",
            Self::ContradictionChecker => "contradiction_checker",
            Self::SynthesizerReviewer => "synthesizer_reviewer",
            Self::Embedding => "embedding",
            Self::Reranker => "reranker",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim() {
            "observation_extractor" => Some(Self::ObservationExtractor),
            "timeline_analyst" => Some(Self::TimelineAnalyst),
            "evidence_gap_finder" => Some(Self::EvidenceGapFinder),
            "contradiction_checker" => Some(Self::ContradictionChecker),
            "synthesizer_reviewer" | "reviewer" => Some(Self::SynthesizerReviewer),
            "embedding" => Some(Self::Embedding),
            "reranker" => Some(Self::Reranker),
            _ => None,
        }
    }

    /// All roles in stable order.
    pub fn all() -> &'static [Self] {
        &[
            Self::ObservationExtractor,
            Self::TimelineAnalyst,
            Self::EvidenceGapFinder,
            Self::ContradictionChecker,
            Self::SynthesizerReviewer,
            Self::Embedding,
            Self::Reranker,
        ]
    }
}

/// What a role may propose (section / artifact kinds).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RoleCapabilityV1 {
    pub schema_id: String,
    pub role: ExtensionRole,
    /// Stable capability tokens this role requires (negotiation kinds).
    #[serde(default)]
    pub required_capabilities: Vec<String>,
    /// Sections the role may write proposals into.
    #[serde(default)]
    pub may_propose: Vec<String>,
    /// Hard prohibitions (content-free tokens).
    #[serde(default)]
    pub may_not: Vec<String>,
    /// When true, the role may only run after measured qualification evidence.
    #[serde(default)]
    pub requires_measured_qualification: bool,
    /// Optional notes (must remain share-safe).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

pub fn parse_role_capability(raw: &str) -> Result<RoleCapabilityV1, super::ExtensionContractError> {
    serde_json::from_str(raw).map_err(|e| super::ExtensionContractError::Parse {
        context: "role_capability",
        detail: e.to_string(),
    })
}

impl RoleCapabilityV1 {
    /// Built-in capability matrix for each extension role (documentation defaults).
    pub fn builtin(role: ExtensionRole) -> Self {
        match role {
            ExtensionRole::ObservationExtractor => Self {
                schema_id: ROLE_CAPABILITY_SCHEMA_V1.into(),
                role,
                required_capabilities: vec!["plain_chat".into(), "prompted_json".into()],
                may_propose: vec!["observations".into()],
                may_not: vec![
                    "initiating_cause".into(),
                    "mint_evidence".into(),
                    "switch_provider".into(),
                ],
                requires_measured_qualification: true,
                notes: Some("Host-grounded observations only".into()),
            },
            ExtensionRole::TimelineAnalyst => Self {
                schema_id: ROLE_CAPABILITY_SCHEMA_V1.into(),
                role,
                required_capabilities: vec!["plain_chat".into(), "prompted_json".into()],
                may_propose: vec!["observations".into(), "timeline_notes".into()],
                may_not: vec![
                    "initiating_cause".into(),
                    "promote_independent_to_chain".into(),
                ],
                requires_measured_qualification: true,
                notes: Some("Chronology proposals; host ordinals authoritative".into()),
            },
            ExtensionRole::EvidenceGapFinder => Self {
                schema_id: ROLE_CAPABILITY_SCHEMA_V1.into(),
                role,
                required_capabilities: vec!["plain_chat".into(), "prompted_json".into()],
                may_propose: vec!["missing_evidence".into()],
                may_not: vec!["cite_absent_evidence".into(), "initiating_cause".into()],
                requires_measured_qualification: true,
                notes: None,
            },
            ExtensionRole::ContradictionChecker => Self {
                schema_id: ROLE_CAPABILITY_SCHEMA_V1.into(),
                role,
                required_capabilities: vec!["plain_chat".into(), "prompted_json".into()],
                may_propose: vec!["contradictions".into(), "competing_explanations".into()],
                may_not: vec!["merge_candidates".into(), "mint_evidence".into()],
                requires_measured_qualification: true,
                notes: None,
            },
            ExtensionRole::SynthesizerReviewer => Self {
                schema_id: ROLE_CAPABILITY_SCHEMA_V1.into(),
                role,
                required_capabilities: vec![
                    "plain_chat".into(),
                    "prompted_json".into(),
                    "tool_continuation".into(),
                ],
                may_propose: vec![
                    "observations".into(),
                    "symptoms".into(),
                    "causal_candidates".into(),
                    "competing_explanations".into(),
                    "missing_evidence".into(),
                ],
                may_not: vec![
                    "override_host_validation".into(),
                    "establish_root_without_host_cause_role".into(),
                ],
                requires_measured_qualification: true,
                notes: Some("Union of bounded proposals; host validator remains authority".into()),
            },
            ExtensionRole::Embedding => Self {
                schema_id: ROLE_CAPABILITY_SCHEMA_V1.into(),
                role,
                required_capabilities: vec!["embeddings".into()],
                may_propose: vec!["vector_scores".into()],
                may_not: vec![
                    "rewrite_evidence".into(),
                    "cross_space_compare".into(),
                    "imply_compatibility_from_model_name".into(),
                ],
                requires_measured_qualification: true,
                notes: Some(
                    "Bound by embedding_space identity; dimension mismatch fails closed".into(),
                ),
            },
            ExtensionRole::Reranker => Self {
                schema_id: ROLE_CAPABILITY_SCHEMA_V1.into(),
                role,
                required_capabilities: vec!["reranking".into()],
                may_propose: vec!["rerank_permutation".into()],
                may_not: vec![
                    "drop_evidence".into(),
                    "imply_compatibility_from_model_name".into(),
                ],
                requires_measured_qualification: true,
                notes: Some("Invalid scores keep pre-rerank order".into()),
            },
        }
    }

    pub fn validate(&self) -> Result<(), super::ExtensionContractError> {
        if self.schema_id != ROLE_CAPABILITY_SCHEMA_V1 {
            return Err(super::ExtensionContractError::SchemaMismatch {
                expected: ROLE_CAPABILITY_SCHEMA_V1.into(),
                got: self.schema_id.clone(),
            });
        }
        // Model names must not appear as capability tokens.
        let forbidden_as_capability = ["gpt", "claude", "gemini", "deepseek", "qwen", "llama"];
        for cap in &self.required_capabilities {
            let lower = cap.to_ascii_lowercase();
            for needle in forbidden_as_capability {
                if lower.contains(needle) {
                    return Err(super::ExtensionContractError::ModelNameAsCompatibility {
                        token: cap.clone(),
                    });
                }
            }
        }
        if let Some(notes) = &self.notes {
            let findings = super::privacy::scan_share_safe_text(notes);
            if !findings.is_empty() {
                return Err(super::ExtensionContractError::PrivacyLeak {
                    findings: findings.into_iter().map(|f| f.to_string()).collect(),
                });
            }
        }
        // may_not must be non-empty for triage roles (fail closed if empty prohibition set)
        if matches!(
            self.role,
            ExtensionRole::ObservationExtractor
                | ExtensionRole::TimelineAnalyst
                | ExtensionRole::ContradictionChecker
                | ExtensionRole::SynthesizerReviewer
        ) && self.may_not.is_empty()
        {
            return Err(super::ExtensionContractError::RoleProhibitionsMissing {
                role: self.role.as_str().into(),
            });
        }
        let _ = BTreeSet::<String>::new();
        Ok(())
    }
}
