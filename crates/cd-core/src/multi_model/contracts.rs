//! Typed inter-stage contracts: strict model proposals and host-validated
//! values, following the [`crate::investigation_answer`] pattern exactly.
//!
//! Each stage speaks a `Model…V1` proposal (`deny_unknown_fields`, model-owned
//! fields only) and the host produces a `…V1` validated value via a
//! `validate_*` function against the immutable [`HostEvidenceLedger`]. A stage
//! can only ever *reference* host-owned ids; it can never introduce an
//! evidence, claim, or candidate id, and can never cross candidate scope.

#![allow(missing_docs)] // DTO field names are the external schema contract.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use super::RoleBinding;
use crate::investigation_answer::{
    literal_span, CanonicalCitationV1, ClaimKind, ClaimStatus, HostEvidenceLedger,
    InvestigationClaimV1, ModelClaimV1, ValidationError,
};

/// Schema id for a stage-2 candidate-finding proposal.
pub const CANDIDATE_FINDING_SCHEMA_V1: &str = "contextdesk.multi_model.candidate_finding.v1";
/// Schema id for a stage-3 review proposal.
pub const REVIEW_SCHEMA_V1: &str = "contextdesk.multi_model.review.v1";

// ---------------------------------------------------------------------------
// Stage 2 — candidate finding (one per candidate, candidate-scoped)
// ---------------------------------------------------------------------------

/// Strict investigator proposal for one candidate. Host-owned fields (status,
/// citations, role) are structurally absent. The investigator proposes only
/// observations, symptoms, causal *candidates*, and self-flagged gaps — never
/// an established cause. Establishment is host-only, at final synthesis.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelCandidateFindingV1 {
    pub schema: String,
    pub candidate_id: String,
    #[serde(default)]
    pub observations: Vec<ModelClaimV1>,
    #[serde(default)]
    pub symptoms: Vec<ModelClaimV1>,
    #[serde(default)]
    pub causal_candidates: Vec<ModelClaimV1>,
    #[serde(default)]
    pub missing_evidence: Vec<ModelClaimV1>,
}

/// Host-validated candidate finding. Every claim carries a host status and
/// cites only host-derived canonical citations for this candidate.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CandidateFindingV1 {
    pub candidate_id: String,
    pub claims: Vec<InvestigationClaimV1>,
    pub citations: Vec<CanonicalCitationV1>,
    pub role_binding: RoleBinding,
}

/// Parse and validate one candidate-finding proposal against the candidate's
/// own ledger scope.
///
/// The `ledger` may be the union ledger; `candidate_id` fixes the scope, and
/// any cited id whose host entry belongs to another candidate is `WrongScope`,
/// exactly as the final synthesis enforces.
pub fn validate_candidate_finding(
    raw: &str,
    ledger: &HostEvidenceLedger,
    candidate_id: &str,
    role_binding: RoleBinding,
) -> Result<CandidateFindingV1, ValidationError> {
    let proposal: ModelCandidateFindingV1 =
        serde_json::from_str(raw).map_err(|_| ValidationError::Parse)?;
    if proposal.schema != CANDIDATE_FINDING_SCHEMA_V1 {
        return Err(ValidationError::Schema);
    }
    if proposal.candidate_id != candidate_id {
        return Err(ValidationError::WrongScope);
    }
    let binding = ledger.binding().clone();
    let mut claim_ids = BTreeSet::new();
    let mut citations: BTreeMap<String, CanonicalCitationV1> = BTreeMap::new();
    let mut claims = Vec::new();
    for (kind, section) in [
        (ClaimKind::Observation, proposal.observations),
        (ClaimKind::Symptom, proposal.symptoms),
        (ClaimKind::CausalCandidate, proposal.causal_candidates),
        (ClaimKind::MissingEvidence, proposal.missing_evidence),
    ] {
        for model_claim in section {
            if model_claim.claim_id.is_empty() || !claim_ids.insert(model_claim.claim_id.clone()) {
                return Err(ValidationError::DuplicateId);
            }
            if model_claim.evidence_ids.is_empty() && kind != ClaimKind::MissingEvidence {
                return Err(ValidationError::EmptyEvidence);
            }
            let mut seen = BTreeSet::new();
            for id in &model_claim.evidence_ids {
                if !seen.insert(id.clone()) {
                    return Err(ValidationError::DuplicateId);
                }
                let entry = ledger.get(id).ok_or(ValidationError::UnknownEvidence)?;
                if entry.candidate_id != candidate_id {
                    return Err(ValidationError::WrongScope);
                }
                if entry.corpus_id != binding.corpus_id || entry.revision != binding.revision {
                    return Err(ValidationError::WrongRevision);
                }
                citations
                    .entry(id.clone())
                    .or_insert_with(|| CanonicalCitationV1 {
                        evidence_id: entry.evidence_id.clone(),
                        candidate_id: entry.candidate_id.clone(),
                        source_label: entry.source_label.clone(),
                        locator: entry.locator.clone(),
                        corpus_id: entry.corpus_id.clone(),
                        revision: entry.revision,
                        content: entry.content.clone(),
                    });
            }
            // No section here establishes a cause. A causal *candidate* is a
            // supported hypothesis, not an establishment; establishment is a
            // host decision made only at final synthesis from `Cause` roles.
            claims.push(InvestigationClaimV1 {
                claim_id: model_claim.claim_id,
                claim_kind: kind,
                text: model_claim.text,
                candidate_id: candidate_id.to_string(),
                evidence_ids: model_claim.evidence_ids,
                status: ClaimStatus::Supported,
            });
        }
    }
    Ok(CandidateFindingV1 {
        candidate_id: candidate_id.to_string(),
        claims,
        citations: citations.into_values().collect(),
        role_binding,
    })
}

// ---------------------------------------------------------------------------
// Stage 3 — review (evidence gaps + contradictions, by id only)
// ---------------------------------------------------------------------------

/// One model-proposed evidence gap. References a candidate and, optionally,
/// host evidence ids belonging to that candidate.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelGapV1 {
    pub gap_id: String,
    pub candidate_id: String,
    pub text: String,
    #[serde(default)]
    pub related_evidence_ids: Vec<String>,
}

/// One model-proposed contradiction between two *distinct* candidates' claims.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelContradictionV1 {
    pub contradiction_id: String,
    pub candidate_a: String,
    pub claim_a_id: String,
    pub candidate_b: String,
    pub claim_b_id: String,
    pub text: String,
    #[serde(default)]
    pub evidence_ids: Vec<String>,
}

/// Strict reviewer proposal. Host-owned ids are only ever referenced.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelReviewReportV1 {
    pub schema: String,
    #[serde(default)]
    pub evidence_gaps: Vec<ModelGapV1>,
    #[serde(default)]
    pub contradictions: Vec<ModelContradictionV1>,
}

/// Host-validated evidence gap.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReviewGap {
    pub gap_id: String,
    pub candidate_id: String,
    pub text: String,
    pub evidence_ids: Vec<String>,
}

/// Host-validated contradiction between two distinct candidates.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReviewContradiction {
    pub contradiction_id: String,
    pub candidate_a: String,
    pub claim_a_id: String,
    pub candidate_b: String,
    pub claim_b_id: String,
    pub text: String,
    pub evidence_ids: Vec<String>,
}

/// Host-validated review report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReviewReportV1 {
    pub gaps: Vec<ReviewGap>,
    pub contradictions: Vec<ReviewContradiction>,
    pub role_binding: RoleBinding,
}

/// Where each known claim id lives, for reviewer scope checks.
/// `claim_id -> candidate_id`.
pub type KnownClaims = BTreeMap<String, String>;

/// Parse and validate one review proposal against the union ledger and the set
/// of host-known claim ids produced by stage 2.
///
/// Rejects: unknown/duplicate gap or contradiction ids; a gap for an unknown
/// candidate; a related evidence id that is unknown or out of the gap's
/// candidate scope; a contradiction that names one candidate twice, an unknown
/// claim id, a claim id that does not belong to the named candidate, or an
/// evidence id outside either named candidate. No new id can be introduced.
pub fn validate_review_report(
    raw: &str,
    ledger: &HostEvidenceLedger,
    known_claims: &KnownClaims,
    role_binding: RoleBinding,
) -> Result<ReviewReportV1, ValidationError> {
    let proposal: ModelReviewReportV1 =
        serde_json::from_str(raw).map_err(|_| ValidationError::Parse)?;
    if proposal.schema != REVIEW_SCHEMA_V1 {
        return Err(ValidationError::Schema);
    }
    let binding = ledger.binding().clone();
    let candidate_ids = ledger.candidate_ids();
    let mut ids = BTreeSet::new();

    let mut gaps = Vec::new();
    for gap in proposal.evidence_gaps {
        if gap.gap_id.is_empty() || !ids.insert(gap.gap_id.clone()) {
            return Err(ValidationError::DuplicateId);
        }
        if !candidate_ids.contains(&gap.candidate_id) {
            return Err(ValidationError::WrongScope);
        }
        let mut seen = BTreeSet::new();
        for id in &gap.related_evidence_ids {
            if !seen.insert(id.clone()) {
                return Err(ValidationError::DuplicateId);
            }
            let entry = ledger.get(id).ok_or(ValidationError::UnknownEvidence)?;
            if entry.candidate_id != gap.candidate_id {
                return Err(ValidationError::WrongScope);
            }
            if entry.corpus_id != binding.corpus_id || entry.revision != binding.revision {
                return Err(ValidationError::WrongRevision);
            }
        }
        gaps.push(ReviewGap {
            gap_id: gap.gap_id,
            candidate_id: gap.candidate_id,
            text: gap.text,
            evidence_ids: gap.related_evidence_ids,
        });
    }

    let mut contradictions = Vec::new();
    for c in proposal.contradictions {
        if c.contradiction_id.is_empty() || !ids.insert(c.contradiction_id.clone()) {
            return Err(ValidationError::DuplicateId);
        }
        // A contradiction must span two *distinct* candidates. It can never
        // merge candidates or manufacture a within-candidate conflict.
        if c.candidate_a == c.candidate_b
            || !candidate_ids.contains(&c.candidate_a)
            || !candidate_ids.contains(&c.candidate_b)
        {
            return Err(ValidationError::WrongScope);
        }
        if known_claims.get(&c.claim_a_id) != Some(&c.candidate_a) {
            return Err(ValidationError::WrongScope);
        }
        if known_claims.get(&c.claim_b_id) != Some(&c.candidate_b) {
            return Err(ValidationError::WrongScope);
        }
        let mut seen = BTreeSet::new();
        for id in &c.evidence_ids {
            if !seen.insert(id.clone()) {
                return Err(ValidationError::DuplicateId);
            }
            let entry = ledger.get(id).ok_or(ValidationError::UnknownEvidence)?;
            if entry.candidate_id != c.candidate_a && entry.candidate_id != c.candidate_b {
                return Err(ValidationError::WrongScope);
            }
            if entry.corpus_id != binding.corpus_id || entry.revision != binding.revision {
                return Err(ValidationError::WrongRevision);
            }
        }
        contradictions.push(ReviewContradiction {
            contradiction_id: c.contradiction_id,
            candidate_a: c.candidate_a,
            claim_a_id: c.claim_a_id,
            candidate_b: c.candidate_b,
            claim_b_id: c.claim_b_id,
            text: c.text,
            evidence_ids: c.evidence_ids,
        });
    }

    Ok(ReviewReportV1 {
        gaps,
        contradictions,
        role_binding,
    })
}

// ---------------------------------------------------------------------------
// Review projection — deterministic, presentation-boundary confined
// ---------------------------------------------------------------------------

/// Deterministic host Markdown projection of a validated review report.
///
/// Every dynamic value — gap/contradiction text and every id — passes through
/// [`literal_span`], the same presentation boundary the answer projection
/// uses: single-line, control/bidi-free, inert as a code span. Ordering is by
/// host-owned identifier so a permuted report renders byte-identically. This
/// is display only; the typed report stays the machine contract, and nothing
/// parses this text back.
pub fn render_review_markdown(report: &ReviewReportV1) -> String {
    let mut out = String::from("## Review\n\n");
    out.push_str(&format!(
        "- Reviewer: role {} · profile {} · model {}\n",
        report.role_binding.role.as_str(),
        literal_span(&report.role_binding.profile_id),
        literal_span(&report.role_binding.model),
    ));

    let mut gaps = report.gaps.iter().collect::<Vec<_>>();
    gaps.sort_by(|a, b| a.gap_id.cmp(&b.gap_id));
    if gaps.is_empty() {
        out.push_str("\n**Evidence gaps**\n\n- none reported\n");
    } else {
        out.push_str("\n**Evidence gaps**\n\n");
        for gap in gaps {
            out.push_str(&format!(
                "- {} (candidate {}): {}",
                literal_span(&gap.gap_id),
                literal_span(&gap.candidate_id),
                literal_span(&gap.text),
            ));
            let mut ev = gap
                .evidence_ids
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>();
            ev.sort_unstable();
            ev.dedup();
            if !ev.is_empty() {
                let rendered = ev
                    .iter()
                    .map(|id| literal_span(id))
                    .collect::<Vec<_>>()
                    .join(", ");
                out.push_str(&format!(" — relates {rendered}"));
            }
            out.push('\n');
        }
    }

    let mut contradictions = report.contradictions.iter().collect::<Vec<_>>();
    contradictions.sort_by(|a, b| a.contradiction_id.cmp(&b.contradiction_id));
    if contradictions.is_empty() {
        out.push_str("\n**Contradictions**\n\n- none reported\n");
    } else {
        out.push_str("\n**Contradictions**\n\n");
        for c in contradictions {
            out.push_str(&format!(
                "- {}: candidate {} claim {} vs candidate {} claim {} — {}",
                literal_span(&c.contradiction_id),
                literal_span(&c.candidate_a),
                literal_span(&c.claim_a_id),
                literal_span(&c.candidate_b),
                literal_span(&c.claim_b_id),
                literal_span(&c.text),
            ));
            let mut ev = c
                .evidence_ids
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>();
            ev.sort_unstable();
            ev.dedup();
            if !ev.is_empty() {
                let rendered = ev
                    .iter()
                    .map(|id| literal_span(id))
                    .collect::<Vec<_>>()
                    .join(", ");
                out.push_str(&format!(" — cites {rendered}"));
            }
            out.push('\n');
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::investigation_answer::{
        AnswerBindingV1, EvidenceRole, HostEvidenceEntry, LogSnapshotRevisionV1,
    };

    fn revision() -> LogSnapshotRevisionV1 {
        LogSnapshotRevisionV1 {
            event_revision: 1,
            template_analysis_revision: 2,
            suppression_revision: 3,
        }
    }

    fn entry(id: &str, candidate: &str) -> HostEvidenceEntry {
        HostEvidenceEntry {
            evidence_id: id.into(),
            candidate_id: candidate.into(),
            source_label: format!("src/{candidate}.log"),
            locator: format!("seq={}", id.len()),
            corpus_id: "c".into(),
            revision: revision(),
            role: EvidenceRole::Neutral,
            content: String::new(),
        }
    }

    /// Two candidates `k1`,`k2`; ids `e:k1:1`,`e:k2:2`. Opaque by construction.
    fn union_ledger() -> HostEvidenceLedger {
        let evidence = vec![entry("e:k1:1", "k1"), entry("e:k2:2", "k2")];
        let binding = AnswerBindingV1 {
            session_id: "s".into(),
            turn_id: "t".into(),
            corpus_id: "c".into(),
            revision: revision(),
            ledger_digest: HostEvidenceLedger::digest(&evidence),
        };
        HostEvidenceLedger::new(binding, evidence).unwrap()
    }

    fn rb(role: super::super::InvestigationRole) -> RoleBinding {
        RoleBinding {
            role,
            profile_id: "p".into(),
            model: "m".into(),
            semantic_attempts: 0,
        }
    }

    #[test]
    fn candidate_finding_validates_scoped_ids_and_rejects_escapes() {
        let ledger = union_ledger();
        let ok = format!(
            r#"{{"schema":"{CANDIDATE_FINDING_SCHEMA_V1}","candidate_id":"k1","observations":[{{"claim_id":"o1","text":"x","evidence_ids":["e:k1:1"]}}]}}"#
        );
        let finding = validate_candidate_finding(
            &ok,
            &ledger,
            "k1",
            rb(super::super::InvestigationRole::Investigator),
        )
        .expect("valid finding");
        assert_eq!(finding.candidate_id, "k1");
        assert_eq!(finding.claims.len(), 1);
        assert_eq!(finding.claims[0].status, ClaimStatus::Supported);
        assert_eq!(finding.citations.len(), 1);

        // Cross-candidate citation → WrongScope.
        let cross = format!(
            r#"{{"schema":"{CANDIDATE_FINDING_SCHEMA_V1}","candidate_id":"k1","observations":[{{"claim_id":"o1","text":"x","evidence_ids":["e:k2:2"]}}]}}"#
        );
        assert_eq!(
            validate_candidate_finding(
                &cross,
                &ledger,
                "k1",
                rb(super::super::InvestigationRole::Investigator)
            ),
            Err(ValidationError::WrongScope)
        );

        // Unknown id → UnknownEvidence.
        let unknown = format!(
            r#"{{"schema":"{CANDIDATE_FINDING_SCHEMA_V1}","candidate_id":"k1","observations":[{{"claim_id":"o1","text":"x","evidence_ids":["e:ghost:9"]}}]}}"#
        );
        assert_eq!(
            validate_candidate_finding(
                &unknown,
                &ledger,
                "k1",
                rb(super::super::InvestigationRole::Investigator)
            ),
            Err(ValidationError::UnknownEvidence)
        );

        // candidate_id mismatch → WrongScope.
        let mismatch = format!(
            r#"{{"schema":"{CANDIDATE_FINDING_SCHEMA_V1}","candidate_id":"k2","observations":[{{"claim_id":"o1","text":"x","evidence_ids":["e:k2:2"]}}]}}"#
        );
        assert_eq!(
            validate_candidate_finding(
                &mismatch,
                &ledger,
                "k1",
                rb(super::super::InvestigationRole::Investigator)
            ),
            Err(ValidationError::WrongScope)
        );

        // Host-owned field in the proposal → deny_unknown_fields → Parse.
        let forged = format!(
            r#"{{"schema":"{CANDIDATE_FINDING_SCHEMA_V1}","candidate_id":"k1","status":"supported","observations":[]}}"#
        );
        assert_eq!(
            validate_candidate_finding(
                &forged,
                &ledger,
                "k1",
                rb(super::super::InvestigationRole::Investigator)
            ),
            Err(ValidationError::Parse)
        );
    }

    #[test]
    fn review_validates_gaps_and_contradictions_by_id_only() {
        let ledger = union_ledger();
        let known: KnownClaims = [
            ("a1".to_string(), "k1".to_string()),
            ("b1".to_string(), "k2".to_string()),
        ]
        .into_iter()
        .collect();
        let ok = format!(
            r#"{{"schema":"{REVIEW_SCHEMA_V1}","evidence_gaps":[{{"gap_id":"g1","candidate_id":"k1","text":"x","related_evidence_ids":["e:k1:1"]}}],"contradictions":[{{"contradiction_id":"x1","candidate_a":"k1","claim_a_id":"a1","candidate_b":"k2","claim_b_id":"b1","text":"conflict","evidence_ids":["e:k1:1","e:k2:2"]}}]}}"#
        );
        let report = validate_review_report(
            &ok,
            &ledger,
            &known,
            rb(super::super::InvestigationRole::Reviewer),
        )
        .expect("valid review");
        assert_eq!(report.gaps.len(), 1);
        assert_eq!(report.contradictions.len(), 1);

        // A contradiction that names one candidate twice → WrongScope.
        let same = format!(
            r#"{{"schema":"{REVIEW_SCHEMA_V1}","contradictions":[{{"contradiction_id":"x1","candidate_a":"k1","claim_a_id":"a1","candidate_b":"k1","claim_b_id":"a1","text":"x","evidence_ids":[]}}]}}"#
        );
        assert_eq!(
            validate_review_report(
                &same,
                &ledger,
                &known,
                rb(super::super::InvestigationRole::Reviewer)
            ),
            Err(ValidationError::WrongScope)
        );

        // A contradiction whose claim id does not belong to the named candidate.
        let wrong_claim = format!(
            r#"{{"schema":"{REVIEW_SCHEMA_V1}","contradictions":[{{"contradiction_id":"x1","candidate_a":"k1","claim_a_id":"b1","candidate_b":"k2","claim_b_id":"a1","text":"x","evidence_ids":[]}}]}}"#
        );
        assert_eq!(
            validate_review_report(
                &wrong_claim,
                &ledger,
                &known,
                rb(super::super::InvestigationRole::Reviewer)
            ),
            Err(ValidationError::WrongScope)
        );

        // A gap evidence id from another candidate → WrongScope.
        let cross_gap = format!(
            r#"{{"schema":"{REVIEW_SCHEMA_V1}","evidence_gaps":[{{"gap_id":"g1","candidate_id":"k1","text":"x","related_evidence_ids":["e:k2:2"]}}]}}"#
        );
        assert_eq!(
            validate_review_report(
                &cross_gap,
                &ledger,
                &known,
                rb(super::super::InvestigationRole::Reviewer)
            ),
            Err(ValidationError::WrongScope)
        );
    }
}
