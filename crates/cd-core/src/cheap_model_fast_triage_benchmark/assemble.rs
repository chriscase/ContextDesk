//! Host-owned deterministic assembly of path-B role outputs.
//!
//! Role fragments are proposals only. The host merges them into one
//! investigation-answer JSON object, then the same
//! [`crate::fast_triage::validate_fast_answer`] gate decides acceptance.
//! Nothing here invents evidence ids or roles.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{json, Value};

use crate::investigation_answer::SCHEMA_V1;

use super::candidates::{
    ContradictionRole, ExtractionRole, PathBRoles, ReviewerRole, RoleClaimSection, TypedRoleClaim,
};
use super::cases::BenchmarkCase;

/// Inputs for path-B assembly.
pub struct RoleDecompositionInputs<'a> {
    /// Case under evaluation (host packet + labels).
    pub case: &'a BenchmarkCase,
    /// Scripted role bundle.
    pub roles: &'a PathBRoles,
}

#[derive(Default)]
struct CandidateBuilder {
    observations: Vec<Value>,
    symptoms: Vec<Value>,
    causal_candidates: Vec<Value>,
    initiating_causes: Vec<Value>,
    competing_explanations: Vec<Value>,
    missing_evidence: Vec<Value>,
}

impl CandidateBuilder {
    fn push_claim(&mut self, section: RoleClaimSection, claim: Value) {
        match section {
            RoleClaimSection::Observation => self.observations.push(claim),
            RoleClaimSection::Symptom => self.symptoms.push(claim),
            RoleClaimSection::CausalCandidate => self.causal_candidates.push(claim),
            RoleClaimSection::InitiatingCause => self.initiating_causes.push(claim),
            RoleClaimSection::CompetingExplanation => self.competing_explanations.push(claim),
            RoleClaimSection::MissingEvidence => self.missing_evidence.push(claim),
        }
    }

    fn into_json(self, candidate_id: &str) -> Value {
        let mut obj = serde_json::Map::new();
        obj.insert("candidate_id".into(), json!(candidate_id));
        if !self.observations.is_empty() {
            obj.insert("observations".into(), json!(self.observations));
        }
        if !self.symptoms.is_empty() {
            obj.insert("symptoms".into(), json!(self.symptoms));
        }
        if !self.causal_candidates.is_empty() {
            obj.insert("causal_candidates".into(), json!(self.causal_candidates));
        }
        if !self.initiating_causes.is_empty() {
            obj.insert("initiating_causes".into(), json!(self.initiating_causes));
        }
        if !self.competing_explanations.is_empty() {
            obj.insert(
                "competing_explanations".into(),
                json!(self.competing_explanations),
            );
        }
        if !self.missing_evidence.is_empty() {
            obj.insert("missing_evidence".into(), json!(self.missing_evidence));
        }
        // Ensure every candidate has at least an empty observations array so the
        // object is a well-formed proposal even when roles contributed nothing.
        if obj.len() == 1 {
            obj.insert("observations".into(), json!([]));
        }
        Value::Object(obj)
    }
}

fn claim_value(claim_id: &str, text: &str, evidence_ids: &[String]) -> Value {
    json!({
        "claim_id": claim_id,
        "text": text,
        "evidence_ids": evidence_ids,
    })
}

/// Assemble path-B roles into one proposal body.
///
/// Order of authority (host-owned):
/// 1. If reviewer supplies a full proposal string, return it unchanged for the
///    host validator (reviewer is never trusted without validation).
/// 2. Otherwise merge extraction observations, then causal proposals.
/// 3. Apply contradiction rejects and optional abstention demotion.
/// 4. Ensure every packet candidate appears so incomplete coverage is a
///    host-validator decision, not a silent drop.
pub fn assemble_role_decomposition(inputs: RoleDecompositionInputs<'_>) -> String {
    let RoleDecompositionInputs { case, roles } = inputs;

    if let Some(full) = roles.reviewer.optional_full_proposal.as_ref() {
        // Reviewer synthesis is still only a proposal.
        return full.clone();
    }

    assemble_from_roles(
        case,
        &roles.extraction,
        &roles.causal.claims,
        &roles.contradiction,
        &roles.reviewer,
    )
}

fn assemble_from_roles(
    case: &BenchmarkCase,
    extraction: &ExtractionRole,
    causal_claims: &[TypedRoleClaim],
    contradiction: &ContradictionRole,
    _reviewer: &ReviewerRole,
) -> String {
    let mut by_candidate: BTreeMap<String, CandidateBuilder> = BTreeMap::new();
    for row in case.packet.rows() {
        by_candidate.entry(row.candidate_id.clone()).or_default();
    }

    let rejected = &contradiction.reject_claim_ids;

    // 1) Extraction observations (always observations section).
    for obs in &extraction.observations {
        if rejected.contains(&obs.claim_id) {
            continue;
        }
        let builder = by_candidate.entry(obs.candidate_id.clone()).or_default();
        builder.push_claim(
            RoleClaimSection::Observation,
            claim_value(&obs.claim_id, &obs.text, &obs.evidence_ids),
        );
    }

    // 2) Causal / symptom proposals.
    for claim in causal_claims {
        if rejected.contains(&claim.claim_id) {
            continue;
        }
        let mut section = claim.section;
        if contradiction.force_abstention && section == RoleClaimSection::InitiatingCause {
            section = RoleClaimSection::CausalCandidate;
        }
        let builder = by_candidate.entry(claim.candidate_id.clone()).or_default();
        builder.push_claim(
            section,
            claim_value(&claim.claim_id, &claim.text, &claim.evidence_ids),
        );
    }

    // When force_abstention and no causal claims, leave extraction-only.

    // 3) Drop pure-extraction duplicates when a stronger claim cites the same
    //    evidence id in a non-observation section (deterministic cleanup).
    //    Implemented by tracking evidence placed in non-observation sections.
    let mut non_obs_evidence: BTreeSet<(String, String)> = BTreeSet::new();
    for claim in causal_claims {
        if rejected.contains(&claim.claim_id) {
            continue;
        }
        if claim.section != RoleClaimSection::Observation
            && claim.section != RoleClaimSection::CompetingExplanation
            && claim.section != RoleClaimSection::MissingEvidence
        {
            for eid in &claim.evidence_ids {
                non_obs_evidence.insert((claim.candidate_id.clone(), eid.clone()));
            }
        }
    }

    // Rebuild with optional observation filtering for cleaner strong path.
    let candidates: Vec<Value> = by_candidate
        .into_iter()
        .map(|(candidate_id, mut builder)| {
            if !non_obs_evidence.is_empty() {
                builder.observations.retain(|obs| {
                    let eid = obs
                        .get("evidence_ids")
                        .and_then(|v| v.as_array())
                        .and_then(|a| a.first())
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    !non_obs_evidence.contains(&(candidate_id.clone(), eid.to_string()))
                });
            }
            builder.into_json(&candidate_id)
        })
        .collect();

    json!({
        "schema": SCHEMA_V1,
        "candidates": candidates,
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cheap_model_fast_triage_benchmark::candidates::{path_b_roles, CandidateKind};
    use crate::cheap_model_fast_triage_benchmark::cases::{benchmark_case, CaseId};
    use crate::fast_triage::validate_fast_answer;

    #[test]
    fn strong_path_b_assembly_validates_on_complete_timeline() {
        let case = benchmark_case(CaseId::CompleteTimeline);
        let roles = path_b_roles(&case, CandidateKind::StrongStructured);
        let body = assemble_role_decomposition(RoleDecompositionInputs {
            case: &case,
            roles: &roles,
        });
        assert!(matches!(
            validate_fast_answer(&body, &case.packet),
            crate::fast_triage::FastTriageValidation::Accepted(_)
        ));
    }
}
