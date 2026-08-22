//! Host-bounded cross-candidate causal-synthesis contract (isolated V1).
//!
//! The model may propose relationships among **host-admitted** candidate, claim,
//! and evidence identities. The host supplies the exact admissible topology and
//! is the only authority. This module is I/O-free and provider-neutral: it does
//! not call providers, touch the filesystem, or wire production synthesis.
//!
//! [`crate::investigation_answer::validate_model_answer`] and
//! `root_cause_established` are unchanged. Candidate-local claim and citation
//! confinement stay in those validators. Model prose on a proposal is never
//! host truth.

#![allow(missing_docs)] // DTO field names are the external schema contract.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::investigation_answer::LogSnapshotRevisionV1;
use crate::investigation_answer::{is_bidi_formatting_control, is_line_boundary};

/// Schema id for a causal-synthesis model proposal and host-validated value.
pub const CAUSAL_SYNTHESIS_SCHEMA_V1: &str = "contextdesk.multi_model.causal_synthesis.v1";

/// Host-distinct relationship kinds. Chronology and frequency are not kinds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CausalRelationKind {
    /// Host-admitted initiating trigger / change.
    InitiatingTrigger,
    /// Host-admitted propagated symptom / effect.
    PropagatedSymptom,
    /// Host-admitted unrelated or competing evidence; stays separate.
    UnrelatedCompeting,
    /// Host-admitted recovery. Recovery cannot become cause.
    Recovery,
    /// Host-admitted disconfirmation / required disproof.
    Disconfirmation,
}

impl CausalRelationKind {
    /// Stable wire label.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::InitiatingTrigger => "initiating_trigger",
            Self::PropagatedSymptom => "propagated_symptom",
            Self::UnrelatedCompeting => "unrelated_competing",
            Self::Recovery => "recovery",
            Self::Disconfirmation => "disconfirmation",
        }
    }
}

/// Typed, content-free failure reasons. Never carry model prose.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CausalSynthesisError {
    Parse,
    Schema,
    UnknownField,
    DuplicateId,
    ForeignIdentity,
    UnknownClaim,
    WrongScope,
    CrossCorpus,
    WrongRevision,
    FalseUnion,
    DecoyPromotion,
    RecoveryAsCause,
    MissingTrigger,
    MissingSymptom,
    MissingDisproof,
    EmptyEvidence,
    UnsafeIdentity,
    InvalidBinding,
    EmptyTopology,
    TopologyViolation,
}

impl CausalSynthesisError {
    /// Stable diagnostic category.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Parse => "parse",
            Self::Schema => "schema",
            Self::UnknownField => "unknown_field",
            Self::DuplicateId => "duplicate_id",
            Self::ForeignIdentity => "foreign_identity",
            Self::UnknownClaim => "unknown_claim",
            Self::WrongScope => "wrong_scope",
            Self::CrossCorpus => "cross_corpus",
            Self::WrongRevision => "wrong_revision",
            Self::FalseUnion => "false_union",
            Self::DecoyPromotion => "decoy_promotion",
            Self::RecoveryAsCause => "recovery_as_cause",
            Self::MissingTrigger => "missing_trigger",
            Self::MissingSymptom => "missing_symptom",
            Self::MissingDisproof => "missing_disproof",
            Self::EmptyEvidence => "empty_evidence",
            Self::UnsafeIdentity => "unsafe_identity",
            Self::InvalidBinding => "invalid_binding",
            Self::EmptyTopology => "empty_topology",
            Self::TopologyViolation => "topology_violation",
        }
    }
}

/// One host-admitted identity the model may cite.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostCausalIdentityV1 {
    pub candidate_id: String,
    pub claim_id: String,
    pub evidence_id: String,
    pub corpus_id: String,
    pub revision: LogSnapshotRevisionV1,
}

/// One host-admitted relationship slot. The model cannot invent a slot.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct HostCausalSlotV1 {
    pub kind: CausalRelationKind,
    pub candidate_id: String,
    pub claim_id: String,
}

/// Host classification of evidence that must not be promoted to cause.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct HostCausalClassesV1 {
    pub recovery_evidence_ids: BTreeSet<String>,
    pub unrelated_evidence_ids: BTreeSet<String>,
    pub decoy_evidence_ids: BTreeSet<String>,
}

/// Exact admissible topology supplied by the host. Not model-authored.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostCausalTopologyV1 {
    pub corpus_id: String,
    pub revision: LogSnapshotRevisionV1,
    identities: BTreeMap<String, HostCausalIdentityV1>,
    admitted_candidates: BTreeSet<String>,
    admitted_claims: BTreeSet<(String, String)>,
    allowed_slots: BTreeSet<HostCausalSlotV1>,
    required_kinds: BTreeSet<CausalRelationKind>,
    classes: HostCausalClassesV1,
}

impl HostCausalTopologyV1 {
    /// Build a topology. Rejects empty, duplicate, or unsafe host identities.
    pub fn try_new(
        corpus_id: impl Into<String>,
        revision: LogSnapshotRevisionV1,
        identities: Vec<HostCausalIdentityV1>,
        allowed_slots: Vec<HostCausalSlotV1>,
        required_kinds: Vec<CausalRelationKind>,
        classes: HostCausalClassesV1,
    ) -> Result<Self, CausalSynthesisError> {
        let corpus_id = corpus_id.into();
        if corpus_id.trim().is_empty() {
            return Err(CausalSynthesisError::InvalidBinding);
        }
        if identities.is_empty() || allowed_slots.is_empty() || required_kinds.is_empty() {
            return Err(CausalSynthesisError::EmptyTopology);
        }
        let mut map = BTreeMap::new();
        let mut admitted_candidates = BTreeSet::new();
        let mut admitted_claims = BTreeSet::new();
        for identity in identities {
            if !is_inert_id(&identity.candidate_id)
                || !is_inert_id(&identity.claim_id)
                || !is_inert_id(&identity.evidence_id)
            {
                return Err(CausalSynthesisError::UnsafeIdentity);
            }
            if map
                .insert(identity.evidence_id.clone(), identity.clone())
                .is_some()
            {
                return Err(CausalSynthesisError::DuplicateId);
            }
            admitted_candidates.insert(identity.candidate_id.clone());
            admitted_claims.insert((identity.candidate_id.clone(), identity.claim_id.clone()));
        }
        let mut slots = BTreeSet::new();
        for slot in allowed_slots {
            if !is_inert_id(&slot.candidate_id) || !is_inert_id(&slot.claim_id) {
                return Err(CausalSynthesisError::UnsafeIdentity);
            }
            if !admitted_claims.contains(&(slot.candidate_id.clone(), slot.claim_id.clone())) {
                return Err(CausalSynthesisError::UnknownClaim);
            }
            if !slots.insert(slot) {
                return Err(CausalSynthesisError::DuplicateId);
            }
        }
        Ok(Self {
            corpus_id,
            revision,
            identities: map,
            admitted_candidates,
            admitted_claims,
            allowed_slots: slots,
            required_kinds: required_kinds.into_iter().collect(),
            classes,
        })
    }

    /// Host-admitted candidate ids.
    pub fn admitted_candidates(&self) -> &BTreeSet<String> {
        &self.admitted_candidates
    }

    /// Host-admitted (candidate, claim) pairs.
    pub fn admitted_claims(&self) -> &BTreeSet<(String, String)> {
        &self.admitted_claims
    }
}

/// Strict model proposal. Host-owned authority fields are structurally absent.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelCausalRelationV1 {
    pub kind: CausalRelationKind,
    pub candidate_id: String,
    pub claim_id: String,
    pub evidence_ids: Vec<String>,
    #[serde(default)]
    pub note: String,
}

/// Strict single-object causal-synthesis proposal.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelCausalSynthesisV1 {
    pub schema: String,
    pub relations: Vec<ModelCausalRelationV1>,
}

/// One host-validated relationship. `model_note` is untrusted display only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CausalRelationV1 {
    pub kind: CausalRelationKind,
    pub candidate_id: String,
    pub claim_id: String,
    pub evidence_ids: Vec<String>,
    pub model_note: String,
}

/// Host-validated causal-synthesis value. No `root_cause_established` field.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CausalSynthesisV1 {
    pub schema: String,
    pub corpus_id: String,
    pub revision: LogSnapshotRevisionV1,
    pub relations: Vec<CausalRelationV1>,
}

fn is_inert_id(id: &str) -> bool {
    !id.is_empty()
        && !id
            .chars()
            .any(|c| c.is_control() || is_line_boundary(c) || is_bidi_formatting_control(c))
}

fn parse_proposal(raw: &str) -> Result<ModelCausalSynthesisV1, CausalSynthesisError> {
    match serde_json::from_str::<ModelCausalSynthesisV1>(raw) {
        Ok(proposal) => Ok(proposal),
        Err(err) => {
            let msg = err.to_string();
            if msg.contains("unknown field") {
                Err(CausalSynthesisError::UnknownField)
            } else {
                Err(CausalSynthesisError::Parse)
            }
        }
    }
}

/// Validate a model proposal against the host-supplied admissible topology.
///
/// The model may cite only host-admitted identities and only fill host-admitted
/// slots. Chronology or frequency fields are unknown and fail closed. Recovery
/// evidence cannot occupy an initiating-trigger relation. Unrelated evidence
/// must stay on [`CausalRelationKind::UnrelatedCompeting`]. Required trigger,
/// symptom, and disproof kinds fail closed when omitted. Model `note` text is
/// stored as untrusted and is never host truth.
pub fn validate_causal_synthesis(
    raw: &str,
    topology: &HostCausalTopologyV1,
) -> Result<CausalSynthesisV1, CausalSynthesisError> {
    let proposal = parse_proposal(raw)?;
    if proposal.schema != CAUSAL_SYNTHESIS_SCHEMA_V1 {
        return Err(CausalSynthesisError::Schema);
    }
    if proposal.relations.is_empty() {
        return Err(CausalSynthesisError::EmptyEvidence);
    }

    let mut seen_slots = BTreeSet::new();
    let mut seen_claim_pairs = BTreeSet::new();
    let mut present_kinds = BTreeSet::new();
    let mut relations = Vec::new();

    for rel in proposal.relations {
        if !is_inert_id(&rel.candidate_id) || !is_inert_id(&rel.claim_id) {
            return Err(CausalSynthesisError::UnsafeIdentity);
        }
        if !topology.admitted_candidates.contains(&rel.candidate_id) {
            return Err(CausalSynthesisError::FalseUnion);
        }
        if !topology
            .admitted_claims
            .contains(&(rel.candidate_id.clone(), rel.claim_id.clone()))
        {
            return Err(CausalSynthesisError::UnknownClaim);
        }
        let slot = HostCausalSlotV1 {
            kind: rel.kind,
            candidate_id: rel.candidate_id.clone(),
            claim_id: rel.claim_id.clone(),
        };
        if !topology.allowed_slots.contains(&slot) {
            return Err(CausalSynthesisError::TopologyViolation);
        }
        if !seen_slots.insert(slot) {
            return Err(CausalSynthesisError::DuplicateId);
        }
        if !seen_claim_pairs.insert((rel.candidate_id.clone(), rel.claim_id.clone())) {
            return Err(CausalSynthesisError::DuplicateId);
        }
        if rel.evidence_ids.is_empty() {
            return Err(CausalSynthesisError::EmptyEvidence);
        }
        let mut seen_evidence = BTreeSet::new();
        for evidence_id in &rel.evidence_ids {
            if !is_inert_id(evidence_id) {
                return Err(CausalSynthesisError::UnsafeIdentity);
            }
            if !seen_evidence.insert(evidence_id.clone()) {
                return Err(CausalSynthesisError::DuplicateId);
            }
            let identity = topology
                .identities
                .get(evidence_id)
                .ok_or(CausalSynthesisError::ForeignIdentity)?;
            if identity.candidate_id != rel.candidate_id {
                return Err(CausalSynthesisError::WrongScope);
            }
            if identity.claim_id != rel.claim_id {
                return Err(CausalSynthesisError::UnknownClaim);
            }
            if identity.corpus_id != topology.corpus_id {
                return Err(CausalSynthesisError::CrossCorpus);
            }
            if identity.revision != topology.revision {
                return Err(CausalSynthesisError::WrongRevision);
            }
            if topology.classes.recovery_evidence_ids.contains(evidence_id)
                && rel.kind == CausalRelationKind::InitiatingTrigger
            {
                return Err(CausalSynthesisError::RecoveryAsCause);
            }
            if (topology
                .classes
                .unrelated_evidence_ids
                .contains(evidence_id)
                || topology.classes.decoy_evidence_ids.contains(evidence_id))
                && rel.kind != CausalRelationKind::UnrelatedCompeting
            {
                return Err(CausalSynthesisError::DecoyPromotion);
            }
        }
        present_kinds.insert(rel.kind);
        relations.push(CausalRelationV1 {
            kind: rel.kind,
            candidate_id: rel.candidate_id,
            claim_id: rel.claim_id,
            evidence_ids: rel.evidence_ids,
            model_note: rel.note,
        });
    }

    if topology
        .required_kinds
        .contains(&CausalRelationKind::InitiatingTrigger)
        && !present_kinds.contains(&CausalRelationKind::InitiatingTrigger)
    {
        return Err(CausalSynthesisError::MissingTrigger);
    }
    if topology
        .required_kinds
        .contains(&CausalRelationKind::PropagatedSymptom)
        && !present_kinds.contains(&CausalRelationKind::PropagatedSymptom)
    {
        return Err(CausalSynthesisError::MissingSymptom);
    }
    if topology
        .required_kinds
        .contains(&CausalRelationKind::Disconfirmation)
        && !present_kinds.contains(&CausalRelationKind::Disconfirmation)
    {
        return Err(CausalSynthesisError::MissingDisproof);
    }

    Ok(CausalSynthesisV1 {
        schema: CAUSAL_SYNTHESIS_SCHEMA_V1.to_string(),
        corpus_id: topology.corpus_id.clone(),
        revision: topology.revision,
        relations,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    fn rev() -> LogSnapshotRevisionV1 {
        LogSnapshotRevisionV1 {
            event_revision: 1,
            template_analysis_revision: 1,
            suppression_revision: 1,
        }
    }

    #[test]
    fn kind_wire_labels_are_stable() {
        assert_eq!(
            CausalRelationKind::InitiatingTrigger.as_str(),
            "initiating_trigger"
        );
        assert_eq!(CausalSynthesisError::FalseUnion.as_str(), "false_union");
    }

    #[test]
    fn empty_topology_is_rejected() {
        let err = HostCausalTopologyV1::try_new(
            "cx",
            rev(),
            Vec::new(),
            Vec::new(),
            vec![CausalRelationKind::InitiatingTrigger],
            HostCausalClassesV1::default(),
        );
        assert_eq!(err, Err(CausalSynthesisError::EmptyTopology));
    }

    fn id(c: &str, claim: &str, e: &str) -> HostCausalIdentityV1 {
        HostCausalIdentityV1 {
            candidate_id: c.into(),
            claim_id: claim.into(),
            evidence_id: e.into(),
            corpus_id: "cx".into(),
            revision: rev(),
        }
    }

    fn slot(kind: CausalRelationKind, c: &str, claim: &str) -> HostCausalSlotV1 {
        HostCausalSlotV1 {
            kind,
            candidate_id: c.into(),
            claim_id: claim.into(),
        }
    }

    #[test]
    fn public_validate_accepts_bounded_topology_and_rejects_unknown_fields() {
        let topology = HostCausalTopologyV1::try_new(
            "cx",
            rev(),
            vec![
                id("k1", "c:k1:t", "e:k1:1"),
                id("k1", "c:k1:s", "e:k1:2"),
                id("k2", "c:k2:u", "e:k2:1"),
                id("k1", "c:k1:r", "e:k1:3"),
                id("k2", "c:k2:d", "e:k2:2"),
            ],
            vec![
                slot(CausalRelationKind::InitiatingTrigger, "k1", "c:k1:t"),
                slot(CausalRelationKind::PropagatedSymptom, "k1", "c:k1:s"),
                slot(CausalRelationKind::UnrelatedCompeting, "k2", "c:k2:u"),
                slot(CausalRelationKind::Recovery, "k1", "c:k1:r"),
                slot(CausalRelationKind::Disconfirmation, "k2", "c:k2:d"),
            ],
            vec![
                CausalRelationKind::InitiatingTrigger,
                CausalRelationKind::PropagatedSymptom,
                CausalRelationKind::UnrelatedCompeting,
                CausalRelationKind::Recovery,
                CausalRelationKind::Disconfirmation,
            ],
            HostCausalClassesV1 {
                recovery_evidence_ids: BTreeSet::from(["e:k1:3".into()]),
                unrelated_evidence_ids: BTreeSet::from(["e:k2:1".into()]),
                decoy_evidence_ids: BTreeSet::from(["e:k2:1".into()]),
            },
        )
        .expect("topology");
        let valid = format!(
            r#"{{"schema":"{CAUSAL_SYNTHESIS_SCHEMA_V1}","relations":[{{"kind":"initiating_trigger","candidate_id":"k1","claim_id":"c:k1:t","evidence_ids":["e:k1:1"]}},{{"kind":"propagated_symptom","candidate_id":"k1","claim_id":"c:k1:s","evidence_ids":["e:k1:2"]}},{{"kind":"unrelated_competing","candidate_id":"k2","claim_id":"c:k2:u","evidence_ids":["e:k2:1"]}},{{"kind":"recovery","candidate_id":"k1","claim_id":"c:k1:r","evidence_ids":["e:k1:3"]}},{{"kind":"disconfirmation","candidate_id":"k2","claim_id":"c:k2:d","evidence_ids":["e:k2:2"]}}]}}"#
        );
        let value = validate_causal_synthesis(&valid, &topology).expect("valid");
        assert_eq!(
            value.relations[0].kind,
            CausalRelationKind::InitiatingTrigger
        );
        assert_eq!(
            value.relations[1].kind,
            CausalRelationKind::PropagatedSymptom
        );
        assert_eq!(
            value.relations[2].kind,
            CausalRelationKind::UnrelatedCompeting
        );
        assert_eq!(value.relations[3].kind, CausalRelationKind::Recovery);
        assert_eq!(value.relations[4].kind, CausalRelationKind::Disconfirmation);
        let mutation = valid.replacen(r#""schema":"#, r#""leak":true,"schema":"#, 1);
        assert_eq!(
            validate_causal_synthesis(&mutation, &topology),
            Err(CausalSynthesisError::UnknownField)
        );
    }
}
