//! Portable gold-reference artifact consumed by collab promotion and bench reports.
//!
//! The wire schema is `cd-collab.gold_reference.v1` (camelCase). This module
//! parses that document; it does not invent a second gold schema and does not
//! duplicate bench [`crate::types::Adjudication`] or [`crate::types::ScoreReview`].

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::error::{BenchError, BenchResult};
use crate::types::{validate_id, validate_rfc3339, ClaimedCitation, TriageRun};

/// Portable gold-reference schema shared with collab.
pub const GOLD_REFERENCE_SCHEMA_V1: &str = "cd-collab.gold_reference.v1";

/// Required honesty note on every gold artifact.
pub const GOLD_IS_HUMAN_BENCHMARK: &str =
    "A gold reference is a human benchmark decision, not an infallible truth claim.";

/// Required honesty note on every gold-alignment projection.
pub const GOLD_ALIGNMENT_NOT_CORRECTNESS: &str = "Gold alignment is not a correctness verdict.";

const HELPFULNESS_DIMENSIONS: &[&str] = &[
    "evidence_support",
    "actionability",
    "uncertainty_calibration",
    "unsafe_unsupported_claims",
];

/// Versioned gold reference promoted from an accepted human decision.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GoldReference {
    pub schema_id: String,
    pub gold_id: String,
    pub version: u64,
    pub predecessor_gold_id: Option<String>,
    pub case_id: String,
    pub experiment_id: String,
    pub package_id: String,
    pub task_fingerprint: String,
    pub snapshot_fingerprint: String,
    pub accepted_decision_id: String,
    pub accepted_decision_revision: u64,
    pub audit_refs: Vec<String>,
    pub evidence_anchors: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_relationships: Option<Vec<ExpectedRelationship>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub helpfulness_dimensions: Option<Vec<String>>,
    pub notes: Vec<String>,
    pub promoted_by_id: String,
    pub promoted_by_username: String,
    pub created_at: String,
}

/// Optional expected evidence/role pair selected with the gold.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExpectedRelationship {
    pub evidence_ref: String,
    pub role: String,
}

/// Alignment of one run or candidate against selected gold evidence.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GoldAlignmentStatus {
    Aligned,
    Partial,
    Divergent,
    Unscored,
    Unknown,
    Absent,
}

impl GoldAlignmentStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Aligned => "aligned",
            Self::Partial => "partial",
            Self::Divergent => "divergent",
            Self::Unscored => "unscored",
            Self::Unknown => "unknown",
            Self::Absent => "absent",
        }
    }
}

/// Gold alignment observation. Never a correctness verdict.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GoldAlignment {
    pub status: GoldAlignmentStatus,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub matched_anchors: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub missing_anchors: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub extra_anchors: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub role_mismatches: Vec<ExpectedRelationship>,
    pub notes: Vec<String>,
}

impl GoldReference {
    pub fn parse_json(text: &str) -> BenchResult<Self> {
        let parsed: Self = serde_json::from_str(text).map_err(BenchError::from_serde)?;
        parsed.validate()?;
        Ok(parsed)
    }

    pub fn validate(&self) -> BenchResult<()> {
        if self.schema_id != GOLD_REFERENCE_SCHEMA_V1 {
            return Err(BenchError::Schema(format!(
                "gold schema must be {GOLD_REFERENCE_SCHEMA_V1}, got {}",
                self.schema_id
            )));
        }
        validate_id("goldId", &self.gold_id)?;
        if self.version < 1 {
            return Err(BenchError::Schema("gold version must be >= 1".into()));
        }
        if self.version == 1 && self.predecessor_gold_id.is_some() {
            return Err(BenchError::Schema(
                "version 1 must not name a predecessor".into(),
            ));
        }
        if self.version > 1 && self.predecessor_gold_id.is_none() {
            return Err(BenchError::Schema(
                "version > 1 requires a predecessor".into(),
            ));
        }
        if let Some(predecessor) = &self.predecessor_gold_id {
            validate_id("predecessorGoldId", predecessor)?;
        }
        validate_id("caseId", &self.case_id)?;
        validate_id("experimentId", &self.experiment_id)?;
        validate_id("packageId", &self.package_id)?;
        validate_id("taskFingerprint", &self.task_fingerprint)?;
        validate_id("snapshotFingerprint", &self.snapshot_fingerprint)?;
        validate_id("acceptedDecisionId", &self.accepted_decision_id)?;
        if self.accepted_decision_revision < 1 {
            return Err(BenchError::Schema(
                "acceptedDecisionRevision must be >= 1".into(),
            ));
        }
        if self.evidence_anchors.is_empty() {
            return Err(BenchError::Schema(
                "gold evidenceAnchors must not be empty".into(),
            ));
        }
        let mut seen = BTreeSet::new();
        for anchor in &self.evidence_anchors {
            validate_id("evidenceAnchors", anchor)?;
            if !seen.insert(anchor) {
                return Err(BenchError::Schema(format!(
                    "duplicate gold evidence anchor {anchor}"
                )));
            }
        }
        if let Some(relationships) = &self.expected_relationships {
            let mut rel_seen = BTreeSet::new();
            for rel in relationships {
                validate_id("expectedRelationships.evidenceRef", &rel.evidence_ref)?;
                if rel.role.trim().is_empty() {
                    return Err(BenchError::Schema(
                        "expectedRelationships.role must not be empty".into(),
                    ));
                }
                if !seen.contains(&rel.evidence_ref) {
                    return Err(BenchError::Schema(format!(
                        "expected relationship {} is not a selected gold anchor",
                        rel.evidence_ref
                    )));
                }
                if !rel_seen.insert(&rel.evidence_ref) {
                    return Err(BenchError::Schema(format!(
                        "duplicate expected relationship {}",
                        rel.evidence_ref
                    )));
                }
            }
        }
        if let Some(dimensions) = &self.helpfulness_dimensions {
            let mut dim_seen = BTreeSet::new();
            for dimension in dimensions {
                if !HELPFULNESS_DIMENSIONS.contains(&dimension.as_str()) {
                    return Err(BenchError::Schema(format!(
                        "unknown helpfulness dimension {dimension}"
                    )));
                }
                if !dim_seen.insert(dimension) {
                    return Err(BenchError::Schema(format!(
                        "duplicate helpfulness dimension {dimension}"
                    )));
                }
            }
        }
        if !self
            .notes
            .iter()
            .any(|note| note == GOLD_IS_HUMAN_BENCHMARK)
        {
            return Err(BenchError::Schema(
                "gold notes must include the human-benchmark caveat".into(),
            ));
        }
        validate_id("promotedById", &self.promoted_by_id)?;
        if self.promoted_by_username.trim().is_empty() {
            return Err(BenchError::Schema(
                "promotedByUsername must not be empty".into(),
            ));
        }
        validate_rfc3339("createdAt", &self.created_at)?;
        Ok(())
    }
}

/// Choose the highest-version gold whose fingerprints match a comparison group.
pub fn latest_gold_for<'a>(
    golds: &'a [GoldReference],
    task_id: &str,
    snapshot_id: &str,
) -> Option<&'a GoldReference> {
    golds
        .iter()
        .filter(|gold| gold.task_fingerprint == task_id && gold.snapshot_fingerprint == snapshot_id)
        .max_by_key(|gold| gold.version)
}

/// Align cited evidence ids against a gold reference.
pub fn align_cited_evidence(
    cited: &BTreeSet<String>,
    observed_roles: &BTreeMap<String, String>,
    gold: Option<&GoldReference>,
) -> GoldAlignment {
    let mut notes = vec![GOLD_ALIGNMENT_NOT_CORRECTNESS.to_string()];
    let Some(gold) = gold else {
        return GoldAlignment {
            status: GoldAlignmentStatus::Unknown,
            matched_anchors: Vec::new(),
            missing_anchors: Vec::new(),
            extra_anchors: Vec::new(),
            role_mismatches: Vec::new(),
            notes,
        };
    };
    let gold_set: BTreeSet<&str> = gold.evidence_anchors.iter().map(String::as_str).collect();
    let matched_anchors: Vec<String> = cited
        .iter()
        .filter(|id| gold_set.contains(id.as_str()))
        .cloned()
        .collect();
    let missing_anchors: Vec<String> = gold
        .evidence_anchors
        .iter()
        .filter(|id| !cited.contains(*id))
        .cloned()
        .collect();
    let extra_anchors: Vec<String> = cited
        .iter()
        .filter(|id| !gold_set.contains(id.as_str()))
        .cloned()
        .collect();
    let mut role_mismatches = Vec::new();
    if let Some(expected) = &gold.expected_relationships {
        for rel in expected {
            match observed_roles.get(&rel.evidence_ref) {
                None => {
                    let note = "expected role relationships were not fully observed";
                    if !notes.iter().any(|existing| existing == note) {
                        notes.push(note.into());
                    }
                }
                Some(observed) if observed != &rel.role => {
                    role_mismatches.push(ExpectedRelationship {
                        evidence_ref: rel.evidence_ref.clone(),
                        role: observed.clone(),
                    });
                }
                Some(_) => {}
            }
        }
    }
    let status = if cited.is_empty() {
        GoldAlignmentStatus::Unscored
    } else if matched_anchors.is_empty() {
        GoldAlignmentStatus::Divergent
    } else if !missing_anchors.is_empty() || !role_mismatches.is_empty() {
        GoldAlignmentStatus::Partial
    } else {
        if !extra_anchors.is_empty() {
            notes.push("Candidate cited additional evidence beyond the gold selection.".into());
        }
        GoldAlignmentStatus::Aligned
    };
    GoldAlignment {
        status,
        matched_anchors,
        missing_anchors,
        extra_anchors,
        role_mismatches,
        notes,
    }
}

fn cited_from_claims(claims: &[ClaimedCitation]) -> BTreeSet<String> {
    claims
        .iter()
        .filter_map(|claim| claim.evidence_item_id.clone())
        .filter(|id| !id.is_empty())
        .collect()
}

/// Align a stored run's cited evidence against gold. Claim text is never compared.
pub fn align_run(run: &TriageRun, gold: Option<&GoldReference>) -> GoldAlignment {
    align_cited_evidence(&cited_from_claims(&run.claims), &BTreeMap::new(), gold)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> GoldReference {
        GoldReference::parse_json(include_str!(
            "../../../collab/contracts/fixtures/gold-reference.valid.json"
        ))
        .unwrap()
    }

    #[test]
    fn parses_three_model_checkout_gold_fixture() {
        let gold = fixture();
        assert_eq!(gold.package_id, "pkg-synth-three-model-checkout-v1");
        assert_eq!(
            gold.evidence_anchors,
            vec!["ev-demo-checkout-log", "ev-demo-inventory-timeout"]
        );
        assert!(gold.notes.iter().any(|n| n == GOLD_IS_HUMAN_BENCHMARK));
    }

    #[test]
    fn rejects_unknown_fields() {
        let err = GoldReference::parse_json(include_str!(
            "../../../collab/contracts/fixtures/gold-reference.unknown-field.json"
        ))
        .unwrap_err();
        let message = err.to_string();
        assert!(
            message.contains("unknown") || message.contains("endpoint"),
            "{message}"
        );
    }

    #[test]
    fn alignment_is_not_correctness() {
        let gold = fixture();
        let aligned = align_cited_evidence(
            &BTreeSet::from([
                "ev-demo-checkout-log".into(),
                "ev-demo-inventory-timeout".into(),
            ]),
            &BTreeMap::from([
                ("ev-demo-checkout-log".into(), "symptom".into()),
                ("ev-demo-inventory-timeout".into(), "cause".into()),
            ]),
            Some(&gold),
        );
        assert_eq!(aligned.status, GoldAlignmentStatus::Aligned);
        assert!(aligned
            .notes
            .iter()
            .any(|note| note == GOLD_ALIGNMENT_NOT_CORRECTNESS));

        let partial = align_cited_evidence(
            &BTreeSet::from([
                "ev-demo-checkout-log".into(),
                "ev-demo-inventory-timeout".into(),
                "ev-demo-pool-exhaustion".into(),
            ]),
            &BTreeMap::from([
                ("ev-demo-checkout-log".into(), "symptom".into()),
                ("ev-demo-inventory-timeout".into(), "symptom".into()),
            ]),
            Some(&gold),
        );
        assert_eq!(partial.status, GoldAlignmentStatus::Partial);

        let unknown = align_cited_evidence(&BTreeSet::new(), &BTreeMap::new(), None);
        assert_eq!(unknown.status, GoldAlignmentStatus::Unknown);
    }
}
