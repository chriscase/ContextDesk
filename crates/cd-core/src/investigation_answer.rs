//! Strict, host-validated investigation answer contract.
//!
//! Model JSON is only a proposal.  Evidence metadata, citations, acceptance,
//! and turn binding are created by the host and never accepted from the model.

#![allow(missing_docs)] // DTO field names are the external schema contract.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

/// Stable schema for model proposals and validated answers.
pub const SCHEMA_V1: &str = "contextdesk.investigation_answer.v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ClaimKind {
    Observation,
    Symptom,
    CausalCandidate,
    InitiatingCause,
    CompetingExplanation,
    MissingEvidence,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceRole {
    Cause,
    Supporting,
    Symptom,
    Neutral,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ClaimStatus {
    Supported,
    Unsupported,
    Withheld,
}

/// The only model-owned claim fields.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelClaimV1 {
    pub claim_id: String,
    pub text: String,
    pub evidence_ids: Vec<String>,
}

/// The only model-owned candidate fields.  Section fixes claim kind by shape.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelCandidateV1 {
    pub candidate_id: String,
    #[serde(default)]
    pub observations: Vec<ModelClaimV1>,
    #[serde(default)]
    pub symptoms: Vec<ModelClaimV1>,
    #[serde(default)]
    pub causal_candidates: Vec<ModelClaimV1>,
    #[serde(default)]
    pub initiating_causes: Vec<ModelClaimV1>,
    #[serde(default)]
    pub competing_explanations: Vec<ModelClaimV1>,
    #[serde(default)]
    pub missing_evidence: Vec<ModelClaimV1>,
}

/// Strict single-object model proposal.  Host-owned fields are intentionally absent.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelInvestigationAnswerV1 {
    pub schema: String,
    pub candidates: Vec<ModelCandidateV1>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InvestigationClaimV1 {
    pub claim_id: String,
    pub claim_kind: ClaimKind,
    pub text: String,
    pub candidate_id: String,
    pub evidence_ids: Vec<String>,
    pub status: ClaimStatus,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InvestigationCandidateV1 {
    pub candidate_id: String,
    pub claims: Vec<InvestigationClaimV1>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CanonicalCitationV1 {
    pub evidence_id: String,
    pub candidate_id: String,
    pub source_label: String,
    pub locator: String,
    pub corpus_id: String,
    pub revision: String,
    /// Host-owned bounded excerpt used by future renderers.
    pub content: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InvestigationAnswerV1 {
    pub schema: String,
    pub candidates: Vec<InvestigationCandidateV1>,
    pub canonical_citations: Vec<CanonicalCitationV1>,
    pub root_cause_established: bool,
}

/// Host-owned row, immutable for the turn.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostEvidenceEntry {
    pub evidence_id: String,
    pub candidate_id: String,
    pub source_label: String,
    pub locator: String,
    pub corpus_id: String,
    pub revision: String,
    pub role: EvidenceRole,
    /// Host-owned bounded excerpt; never supplied by the model.
    pub content: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AnswerBindingV1 {
    pub session_id: String,
    pub turn_id: String,
    pub corpus_id: String,
    pub revision: String,
    pub ledger_digest: String,
}
/// Persistable authoritative state for later host-only CLI/GUI/session lookup.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AnswerEnvelopeV1 {
    pub binding: AnswerBindingV1,
    pub evidence: Vec<HostEvidenceEntry>,
    pub answer: InvestigationAnswerV1,
    pub semantic_attempts: u8,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ValidationError {
    Parse,
    Schema,
    DuplicateId,
    UnknownEvidence,
    WrongScope,
    WrongRevision,
    EmptyEvidence,
    RootRole,
    EmptyLedger,
    InvalidBinding,
    DigestMismatch,
}

#[derive(Debug, Clone)]
pub struct HostEvidenceLedger {
    binding: AnswerBindingV1,
    entries: BTreeMap<String, HostEvidenceEntry>,
}
impl HostEvidenceLedger {
    pub fn new(
        binding: AnswerBindingV1,
        evidence: Vec<HostEvidenceEntry>,
    ) -> Result<Self, ValidationError> {
        if binding.session_id.trim().is_empty()
            || binding.turn_id.trim().is_empty()
            || binding.corpus_id.trim().is_empty()
            || binding.revision.trim().is_empty()
            || binding.ledger_digest.trim().is_empty()
        {
            return Err(ValidationError::InvalidBinding);
        }
        if evidence.is_empty() {
            return Err(ValidationError::EmptyLedger);
        }
        let mut entries = BTreeMap::new();
        for entry in evidence {
            if entry.evidence_id.is_empty()
                || entries.insert(entry.evidence_id.clone(), entry).is_some()
            {
                return Err(ValidationError::DuplicateId);
            }
        }
        let canonical = entries.values().cloned().collect::<Vec<_>>();
        if binding.ledger_digest != Self::digest(&canonical) {
            return Err(ValidationError::DigestMismatch);
        }
        Ok(Self { binding, entries })
    }
    pub fn binding(&self) -> &AnswerBindingV1 {
        &self.binding
    }
    pub fn digest(entries: &[HostEvidenceEntry]) -> String {
        let mut rows = entries.to_vec();
        rows.sort_by(|a, b| a.evidence_id.cmp(&b.evidence_id));
        let mut h = Sha256::new();
        for e in rows {
            h.update([match e.role {
                EvidenceRole::Cause => 1,
                EvidenceRole::Supporting => 2,
                EvidenceRole::Symptom => 3,
                EvidenceRole::Neutral => 4,
            }]);
            for part in [
                &e.evidence_id,
                &e.candidate_id,
                &e.source_label,
                &e.locator,
                &e.corpus_id,
                &e.revision,
                &e.content,
            ] {
                h.update(part.as_bytes());
                h.update([0]);
            }
        }
        format!("{:x}", h.finalize())
    }
    pub fn entries(&self) -> Vec<HostEvidenceEntry> {
        self.entries.values().cloned().collect()
    }
}

/// Parse exactly one JSON object; no fences, prefixes, schema defaults, or embeds.
pub fn parse_model_json(raw: &str) -> Result<ModelInvestigationAnswerV1, ValidationError> {
    let value: ModelInvestigationAnswerV1 =
        serde_json::from_str(raw).map_err(|_| ValidationError::Parse)?;
    if value.schema != SCHEMA_V1 {
        return Err(ValidationError::Schema);
    }
    Ok(value)
}

/// Validate a proposal against the exact immutable host ledger and derive all authority.
pub fn validate_model_answer(
    raw: &str,
    ledger: &HostEvidenceLedger,
) -> Result<AnswerEnvelopeV1, ValidationError> {
    if ledger.entries.is_empty() {
        return Err(ValidationError::EmptyLedger);
    }
    let proposal = parse_model_json(raw)?;
    let mut candidate_ids = BTreeSet::new();
    let mut claim_ids = BTreeSet::new();
    let mut citations = BTreeMap::new();
    let mut candidates = Vec::new();
    let mut root = false;
    for candidate in proposal.candidates {
        if candidate.candidate_id.is_empty()
            || !candidate_ids.insert(candidate.candidate_id.clone())
        {
            return Err(ValidationError::DuplicateId);
        }
        let mut claims = Vec::new();
        for (kind, section) in [
            (ClaimKind::Observation, candidate.observations),
            (ClaimKind::Symptom, candidate.symptoms),
            (ClaimKind::CausalCandidate, candidate.causal_candidates),
            (ClaimKind::InitiatingCause, candidate.initiating_causes),
            (
                ClaimKind::CompetingExplanation,
                candidate.competing_explanations,
            ),
            (ClaimKind::MissingEvidence, candidate.missing_evidence),
        ] {
            for model_claim in section {
                if model_claim.claim_id.is_empty()
                    || !claim_ids.insert(model_claim.claim_id.clone())
                {
                    return Err(ValidationError::DuplicateId);
                }
                let mut ids = BTreeSet::new();
                if model_claim.evidence_ids.is_empty() && kind != ClaimKind::MissingEvidence {
                    return Err(ValidationError::EmptyEvidence);
                }
                for id in &model_claim.evidence_ids {
                    if !ids.insert(id.clone()) {
                        return Err(ValidationError::DuplicateId);
                    }
                    let entry = ledger
                        .entries
                        .get(id)
                        .ok_or(ValidationError::UnknownEvidence)?;
                    if entry.candidate_id != candidate.candidate_id {
                        return Err(ValidationError::WrongScope);
                    }
                    if entry.corpus_id != ledger.binding.corpus_id
                        || entry.revision != ledger.binding.revision
                    {
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
                            revision: entry.revision.clone(),
                            content: entry.content.clone(),
                        });
                }
                let supporting_root = kind == ClaimKind::InitiatingCause
                    && model_claim.evidence_ids.iter().any(|id| {
                        ledger.entries.get(id).is_some_and(|e| {
                            matches!(e.role, EvidenceRole::Cause | EvidenceRole::Supporting)
                        })
                    });
                let status = if kind == ClaimKind::InitiatingCause && !supporting_root {
                    ClaimStatus::Withheld
                } else {
                    ClaimStatus::Supported
                };
                root |= supporting_root;
                claims.push(InvestigationClaimV1 {
                    claim_id: model_claim.claim_id,
                    claim_kind: kind,
                    text: model_claim.text,
                    candidate_id: candidate.candidate_id.clone(),
                    evidence_ids: model_claim.evidence_ids,
                    status,
                });
            }
        }
        candidates.push(InvestigationCandidateV1 {
            candidate_id: candidate.candidate_id,
            claims,
        });
    }
    let ledger_candidates = ledger
        .entries
        .values()
        .map(|entry| entry.candidate_id.clone())
        .collect::<BTreeSet<_>>();
    if candidate_ids != ledger_candidates {
        return Err(ValidationError::WrongScope);
    }
    Ok(AnswerEnvelopeV1 {
        binding: ledger.binding.clone(),
        evidence: ledger.entries(),
        answer: InvestigationAnswerV1 {
            schema: SCHEMA_V1.into(),
            candidates,
            canonical_citations: citations.into_values().collect(),
            root_cause_established: root,
        },
        semantic_attempts: 0,
    })
}

pub fn authoritative_json(envelope: &AnswerEnvelopeV1) -> String {
    serde_json::to_string(&envelope.answer).unwrap_or_else(|_| "{}".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn ledger() -> HostEvidenceLedger {
        let evidence = vec![
            HostEvidenceEntry {
                evidence_id: "e-a".into(),
                candidate_id: "a".into(),
                source_label: "one".into(),
                locator: "line 1".into(),
                corpus_id: "c".into(),
                revision: "r".into(),
                role: EvidenceRole::Cause,
                content: "host excerpt one".into(),
            },
            HostEvidenceEntry {
                evidence_id: "e-b".into(),
                candidate_id: "b".into(),
                source_label: "two".into(),
                locator: "line 2".into(),
                corpus_id: "c".into(),
                revision: "r".into(),
                role: EvidenceRole::Symptom,
                content: "host excerpt two".into(),
            },
        ];
        let binding = AnswerBindingV1 {
            session_id: "s".into(),
            turn_id: "t".into(),
            corpus_id: "c".into(),
            revision: "r".into(),
            ledger_digest: HostEvidenceLedger::digest(&evidence),
        };
        HostEvidenceLedger::new(binding, evidence).unwrap()
    }
    fn proposal(body: &str) -> String {
        format!(r#"{{"schema":"{SCHEMA_V1}","candidates":[{body}]}}"#)
    }
    #[test]
    fn strict_and_host_owned_fields_rejected() {
        assert!(parse_model_json("```json {} ```").is_err());
        assert!(parse_model_json(&format!(
            r#"{{"schema":"{SCHEMA_V1}","candidates":[],"canonical_citations":[]}}"#
        ))
        .is_err());
    }
    #[test]
    fn forged_scope_revision_and_duplicates_fail() {
        let l = ledger();
        for b in [
            r#"{"candidate_id":"a","observations":[{"claim_id":"x","text":"x","evidence_ids":["fake"]}]}"#,
            r#"{"candidate_id":"a","observations":[{"claim_id":"x","text":"x","evidence_ids":["e-b"]}]}"#,
            r#"{"candidate_id":"a","observations":[{"claim_id":"x","text":"x","evidence_ids":["e-a","e-a"]}]}"#,
        ] {
            assert!(validate_model_answer(&proposal(b), &l).is_err());
        }
        let mut stale = l.entries();
        stale[0].revision = "old".into();
        let mut stale_binding = l.binding().clone();
        stale_binding.ledger_digest = HostEvidenceLedger::digest(&stale);
        let stale = HostEvidenceLedger::new(stale_binding, stale).unwrap();
        let both = format!(
            r#"{{"schema":"{SCHEMA_V1}","candidates":[{{"candidate_id":"a","observations":[{{"claim_id":"a","text":"x","evidence_ids":["e-a"]}}]}},{{"candidate_id":"b","observations":[{{"claim_id":"b","text":"x","evidence_ids":["e-b"]}}]}}]}}"#
        );
        assert_eq!(
            validate_model_answer(&both, &stale),
            Err(ValidationError::WrongRevision)
        );
    }
    #[test]
    fn duplicate_candidate_and_claim_ids_fail() {
        let l = ledger();
        let duplicate_candidate = format!(
            r#"{{"schema":"{SCHEMA_V1}","candidates":[{{"candidate_id":"a","observations":[{{"claim_id":"one","text":"x","evidence_ids":["e-a"]}}]}},{{"candidate_id":"a","observations":[{{"claim_id":"two","text":"x","evidence_ids":["e-a"]}}]}}]}}"#
        );
        assert_eq!(
            validate_model_answer(&duplicate_candidate, &l),
            Err(ValidationError::DuplicateId)
        );
        let duplicate_claim = format!(
            r#"{{"schema":"{SCHEMA_V1}","candidates":[{{"candidate_id":"a","observations":[{{"claim_id":"same","text":"x","evidence_ids":["e-a"]}}]}},{{"candidate_id":"b","observations":[{{"claim_id":"same","text":"x","evidence_ids":["e-b"]}}]}}]}}"#
        );
        assert_eq!(
            validate_model_answer(&duplicate_claim, &l),
            Err(ValidationError::DuplicateId)
        );
    }
    #[test]
    fn empty_or_unbound_ledger_is_never_authoritative() {
        let empty = HostEvidenceLedger::new(
            AnswerBindingV1 {
                session_id: "s".into(),
                turn_id: "t".into(),
                corpus_id: "c".into(),
                revision: "r".into(),
                ledger_digest: "x".into(),
            },
            Vec::new(),
        );
        assert!(matches!(empty, Err(ValidationError::EmptyLedger)));
        let mut binding = ledger().binding().clone();
        binding.turn_id.clear();
        assert!(matches!(
            HostEvidenceLedger::new(binding, ledger().entries()),
            Err(ValidationError::InvalidBinding)
        ));
    }
    #[test]
    fn digest_binds_every_rendered_host_fact_and_round_trips_envelope() {
        let l = ledger();
        for change in 0..4 {
            let mut rows = l.entries();
            match change {
                0 => rows[0].source_label.push('x'),
                1 => rows[0].locator.push('x'),
                2 => rows[0].role = EvidenceRole::Supporting,
                _ => rows[0].content.push('x'),
            }
            assert!(matches!(
                HostEvidenceLedger::new(l.binding().clone(), rows),
                Err(ValidationError::DigestMismatch)
            ));
        }
        let raw = format!(
            r#"{{"schema":"{SCHEMA_V1}","candidates":[{{"candidate_id":"a","observations":[{{"claim_id":"a","text":"x","evidence_ids":["e-a"]}}]}},{{"candidate_id":"b","observations":[{{"claim_id":"b","text":"x","evidence_ids":["e-b"]}}]}}]}}"#
        );
        let envelope = validate_model_answer(&raw, &l).unwrap();
        let round_trip: AnswerEnvelopeV1 =
            serde_json::from_str(&serde_json::to_string(&envelope).unwrap()).unwrap();
        assert_eq!(round_trip, envelope);
        let event = crate::events::StreamEvent::InvestigationAnswer { envelope };
        let event_round_trip: crate::events::StreamEvent =
            serde_json::from_str(&serde_json::to_string(&event).unwrap()).unwrap();
        match event_round_trip {
            crate::events::StreamEvent::InvestigationAnswer { envelope: got } => {
                assert_eq!(got, round_trip);
            }
            other => panic!("expected typed envelope event, got {other:?}"),
        }
    }
    #[test]
    fn root_is_withheld_for_symptom_only() {
        let raw = format!(
            r#"{{"schema":"{SCHEMA_V1}","candidates":[{{"candidate_id":"a","observations":[{{"claim_id":"a","text":"x","evidence_ids":["e-a"]}}]}},{{"candidate_id":"b","initiating_causes":[{{"claim_id":"x","text":"x","evidence_ids":["e-b"]}}]}}]}}"#
        );
        let e = validate_model_answer(&raw, &ledger()).unwrap();
        assert!(!e.answer.root_cause_established);
        assert_eq!(
            e.answer.candidates[1].claims[0].status,
            ClaimStatus::Withheld
        );
    }
}
