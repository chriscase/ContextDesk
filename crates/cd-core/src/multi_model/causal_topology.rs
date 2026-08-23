//! Host-only derivation of [`HostCausalTopologyV1`].
//!
//! This module is I/O-free and provider-neutral. It does not call providers,
//! render answers, change `root_cause_established`, or treat claim text as
//! authority. It is not wired into the production pipeline: callers hand it
//! already-validated host records and an exact [`AnswerBindingV1`]
//! corpus/revision.
//!
//! Chronology ordinal, frequency, [`FastTriageEvidenceCategory::PrecedingSameSource`],
//! and [`FastTriageEvidenceCategory::FollowingSameSource`] never establish
//! trigger or recovery. Independent scope and
//! [`FastTriageEvidenceCategory::IndependentNoise`] may only occupy
//! unrelated/decoy classes.

use std::collections::{BTreeMap, BTreeSet};

use crate::fast_triage::{FastTriageEvidenceCategory, FastTriageEvidenceScope};
use crate::investigation_answer::{
    is_bidi_formatting_control, is_line_boundary, AnswerBindingV1, ClaimKind, ClaimStatus,
    EvidenceRole, HostEvidenceEntry, HostEvidenceLedger, InvestigationClaimV1,
};

use super::causal_synthesis::{
    CausalRelationKind, CausalSynthesisError, HostCausalClassesV1, HostCausalIdentityV1,
    HostCausalSlotV1, HostCausalTopologyV1,
};
use super::contracts::{CandidateFindingV1, KnownClaims, ReviewContradiction};

/// Typed failure for host topology derivation. Never carries model prose.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CausalTopologyDeriveError {
    /// Exact [`AnswerBindingV1`] corpus/revision does not match the ledger.
    WrongRevision,
    /// Binding identity (session, turn, or digest) does not match the ledger.
    InvalidBinding,
    /// No admitted initiating-trigger or propagated-symptom slot can be proven.
    /// The host must not invent slots.
    InsufficientHostProof,
    /// The validated reviewer reported a cross-candidate contradiction. Model
    /// prose cannot resolve that contest or manufacture disproof authority, so
    /// the production route must remain causal-neutral.
    ContestedReview,
    /// A host identity is not an inert single-line token.
    UnsafeIdentity,
    /// The same evidence id would belong to two distinct identities, the host
    /// supplied two classification rows for one evidence id, or the same
    /// `(candidate_id, claim_id)` pair appears more than once in findings.
    DuplicateId,
}

impl CausalTopologyDeriveError {
    /// Stable diagnostic category.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::WrongRevision => "wrong_revision",
            Self::InvalidBinding => "invalid_binding",
            Self::InsufficientHostProof => "insufficient_host_proof",
            Self::ContestedReview => "contested_review",
            Self::UnsafeIdentity => "unsafe_identity",
            Self::DuplicateId => "duplicate_id",
        }
    }
}

/// Host-owned neighborhood facts for one evidence id.
///
/// Ordinal and frequency are accepted so callers do not strip host-visible
/// chronology; they never establish trigger or recovery.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostEvidenceClassV1 {
    /// Host-minted evidence id.
    pub evidence_id: String,
    /// Host structural scope ([`FastTriageEvidenceScope::Candidate`] vs Independent).
    pub scope: FastTriageEvidenceScope,
    /// Host positional/link category. IndependentNoise is never a trigger.
    pub category: FastTriageEvidenceCategory,
    /// Host chronology ordinal, when the locator carries one.
    pub chronology_ordinal: Option<u64>,
    /// Host-recorded occurrence count, when known. Never a trigger signal.
    pub frequency: Option<u64>,
}

/// Host-owned, already-validated records from which a topology may be derived.
#[derive(Debug, Clone, Copy)]
pub struct HostCausalTopologyInput<'a> {
    /// Exact turn binding. Corpus/revision must match the ledger.
    pub binding: &'a AnswerBindingV1,
    /// Immutable host evidence ledger.
    pub ledger: &'a HostEvidenceLedger,
    /// Host-validated per-candidate findings.
    pub findings: &'a [CandidateFindingV1],
    /// Pair-keyed `(candidate_id, claim_id)` set, like [`KnownClaims`].
    pub known_claims: &'a KnownClaims,
    /// Host-recorded review contradiction pairs already in [`KnownClaims`].
    pub contradictions: &'a [ReviewContradiction],
    /// Recovery evidence ids the host already populated. Never inferred.
    pub recovery_evidence_ids: &'a BTreeSet<String>,
    /// Host neighborhood/scope classification per evidence id.
    pub classifications: &'a [HostEvidenceClassV1],
}

#[derive(Clone)]
struct ClaimAssignment {
    kind: CausalRelationKind,
    evidence_ids: Vec<String>,
    decoy: bool,
}

/// Derive [`HostCausalTopologyV1`] from host-owned validated records only.
///
/// Identities are `(candidate_id, claim_id, evidence_id)` triples present in
/// the ledger, confined to the same candidate, and bound to the exact
/// [`AnswerBindingV1`] corpus/revision. Claim uniqueness is pair-keyed.
/// Missing trigger or symptom returns [`CausalTopologyDeriveError::InsufficientHostProof`].
pub fn derive_host_causal_topology(
    input: HostCausalTopologyInput<'_>,
) -> Result<HostCausalTopologyV1, CausalTopologyDeriveError> {
    let HostCausalTopologyInput {
        binding,
        ledger,
        findings,
        known_claims,
        contradictions,
        recovery_evidence_ids,
        classifications,
    } = input;

    let ledger_binding = ledger.binding();
    if binding.corpus_id != ledger_binding.corpus_id || binding.revision != ledger_binding.revision
    {
        return Err(CausalTopologyDeriveError::WrongRevision);
    }
    if binding.session_id != ledger_binding.session_id
        || binding.turn_id != ledger_binding.turn_id
        || binding.ledger_digest != ledger_binding.ledger_digest
    {
        return Err(CausalTopologyDeriveError::InvalidBinding);
    }

    let class_by_id = index_classifications(classifications)?;
    ensure_unique_claim_pairs(findings)?;

    let mut assignments: BTreeMap<(String, String), ClaimAssignment> = BTreeMap::new();
    for finding in findings {
        for claim in &finding.claims {
            if let Some(assignment) = assign_claim(
                finding,
                claim,
                ledger,
                binding,
                known_claims,
                recovery_evidence_ids,
                &class_by_id,
            ) {
                // Pairs are unique; last-write merge would make kind
                // order-dependent across duplicate findings.
                assignments.insert(
                    (claim.candidate_id.clone(), claim.claim_id.clone()),
                    assignment,
                );
            }
        }
    }

    let mut identities: BTreeMap<String, HostCausalIdentityV1> = BTreeMap::new();
    let mut slots: BTreeSet<HostCausalSlotV1> = BTreeSet::new();
    let mut classes = HostCausalClassesV1::default();

    // Independent / IndependentNoise identities occupy evidence ids first so
    // they cannot be reused as trigger, symptom, or recovery.
    emit_assignments(
        &assignments,
        findings,
        ledger,
        |assignment| assignment.decoy,
        &mut identities,
        &mut slots,
        &mut classes,
    )?;
    emit_assignments(
        &assignments,
        findings,
        ledger,
        |assignment| assignment.kind == CausalRelationKind::Recovery && !assignment.decoy,
        &mut identities,
        &mut slots,
        &mut classes,
    )?;
    emit_assignments(
        &assignments,
        findings,
        ledger,
        |assignment| !assignment.decoy && assignment.kind != CausalRelationKind::Recovery,
        &mut identities,
        &mut slots,
        &mut classes,
    )?;

    admit_disconfirmation(
        contradictions,
        known_claims,
        findings,
        ledger,
        binding,
        &mut identities,
        &mut slots,
    )?;

    let has_trigger = slots
        .iter()
        .any(|slot| slot.kind == CausalRelationKind::InitiatingTrigger);
    let has_symptom = slots
        .iter()
        .any(|slot| slot.kind == CausalRelationKind::PropagatedSymptom);
    if !has_trigger || !has_symptom {
        return Err(CausalTopologyDeriveError::InsufficientHostProof);
    }

    let required_kinds = slots.iter().map(|slot| slot.kind).collect::<BTreeSet<_>>();
    let identity_vec = identities.into_values().collect::<Vec<_>>();
    let slot_vec = slots.into_iter().collect::<Vec<_>>();
    let required_vec = required_kinds.into_iter().collect::<Vec<_>>();

    HostCausalTopologyV1::try_new(
        binding.corpus_id.clone(),
        binding.revision,
        identity_vec,
        slot_vec,
        required_vec,
        classes,
    )
    .map_err(map_try_new)
}

fn map_try_new(err: CausalSynthesisError) -> CausalTopologyDeriveError {
    match err {
        CausalSynthesisError::EmptyTopology | CausalSynthesisError::UnknownClaim => {
            CausalTopologyDeriveError::InsufficientHostProof
        }
        CausalSynthesisError::InvalidBinding => CausalTopologyDeriveError::InvalidBinding,
        CausalSynthesisError::UnsafeIdentity => CausalTopologyDeriveError::UnsafeIdentity,
        CausalSynthesisError::DuplicateId => CausalTopologyDeriveError::DuplicateId,
        CausalSynthesisError::WrongRevision | CausalSynthesisError::CrossCorpus => {
            CausalTopologyDeriveError::WrongRevision
        }
        _ => CausalTopologyDeriveError::InsufficientHostProof,
    }
}

fn assign_claim(
    finding: &CandidateFindingV1,
    claim: &InvestigationClaimV1,
    ledger: &HostEvidenceLedger,
    binding: &AnswerBindingV1,
    known_claims: &KnownClaims,
    recovery_evidence_ids: &BTreeSet<String>,
    class_by_id: &BTreeMap<&str, &HostEvidenceClassV1>,
) -> Option<ClaimAssignment> {
    if finding.candidate_id != claim.candidate_id {
        return None;
    }
    if !known_claims.contains(&(claim.candidate_id.clone(), claim.claim_id.clone())) {
        return None;
    }
    if claim.status != ClaimStatus::Supported {
        return None;
    }
    if !is_inert_id(&claim.candidate_id) || !is_inert_id(&claim.claim_id) {
        return None;
    }

    let mut poison_independent = false;
    let mut independent_ids = Vec::new();
    let mut recovery_ids = Vec::new();
    let mut symptom_ids = Vec::new();
    let mut trigger_ids = Vec::new();
    let mut unrelated_ids = Vec::new();
    let mut all_valid = Vec::new();

    for evidence_id in &claim.evidence_ids {
        let Some(entry) = validated_entry(ledger, binding, claim, evidence_id) else {
            continue;
        };
        if !is_inert_id(&entry.evidence_id) {
            continue;
        }
        let class = class_of(class_by_id, evidence_id);
        // Ordinal and frequency are host-visible and must never establish
        // trigger or recovery. Bind them so they cannot be stripped, then
        // ignore them as establishing signals.
        let _ = (class.chronology_ordinal, class.frequency);
        all_valid.push(entry.evidence_id.clone());
        if is_independent_or_noise(&class) {
            poison_independent = true;
            independent_ids.push(entry.evidence_id.clone());
            continue;
        }
        if recovery_evidence_ids.contains(&entry.evidence_id) {
            recovery_ids.push(entry.evidence_id.clone());
            continue;
        }
        if claim.claim_kind == ClaimKind::Symptom
            && class.scope == FastTriageEvidenceScope::Candidate
        {
            symptom_ids.push(entry.evidence_id.clone());
            continue;
        }
        if is_positional_chronology(&class)
            || class.category == FastTriageEvidenceCategory::Propagation
        {
            // Preceding/following same-source rows never establish trigger
            // or recovery. A propagation row is downstream by host
            // construction and likewise cannot initiate the chain. These
            // rows may remain unrelated competing explanations.
            if claim.claim_kind == ClaimKind::CompetingExplanation {
                unrelated_ids.push(entry.evidence_id.clone());
            }
            continue;
        }
        if class.scope == FastTriageEvidenceScope::Candidate
            && claim.claim_kind != ClaimKind::Symptom
            && (claim.claim_kind == ClaimKind::CausalCandidate || entry.role == EvidenceRole::Cause)
        {
            trigger_ids.push(entry.evidence_id.clone());
            continue;
        }
        if claim.claim_kind == ClaimKind::CompetingExplanation {
            unrelated_ids.push(entry.evidence_id.clone());
        }
    }

    let (kind, decoy, evidence_ids) = if poison_independent {
        (
            CausalRelationKind::UnrelatedCompeting,
            true,
            if independent_ids.is_empty() {
                all_valid
            } else {
                independent_ids
            },
        )
    } else if !recovery_ids.is_empty() {
        (CausalRelationKind::Recovery, false, recovery_ids)
    } else if !symptom_ids.is_empty() {
        (CausalRelationKind::PropagatedSymptom, false, symptom_ids)
    } else if !trigger_ids.is_empty() {
        (CausalRelationKind::InitiatingTrigger, false, trigger_ids)
    } else if !unrelated_ids.is_empty() {
        (CausalRelationKind::UnrelatedCompeting, false, unrelated_ids)
    } else {
        return None;
    };

    Some(ClaimAssignment {
        kind,
        evidence_ids,
        decoy,
    })
}

fn emit_assignments(
    assignments: &BTreeMap<(String, String), ClaimAssignment>,
    findings: &[CandidateFindingV1],
    ledger: &HostEvidenceLedger,
    include: impl Fn(&ClaimAssignment) -> bool,
    identities: &mut BTreeMap<String, HostCausalIdentityV1>,
    slots: &mut BTreeSet<HostCausalSlotV1>,
    classes: &mut HostCausalClassesV1,
) -> Result<(), CausalTopologyDeriveError> {
    for ((candidate_id, claim_id), assignment) in assignments {
        if !include(assignment) {
            continue;
        }
        let Some(claim) = find_claim(findings, candidate_id, claim_id) else {
            continue;
        };
        let mut admitted_for_slot = false;
        for evidence_id in &assignment.evidence_ids {
            let Some(entry) = ledger.get(evidence_id) else {
                continue;
            };
            if !identity_matches_assignment(assignment, claim, entry) {
                continue;
            }
            if identities.contains_key(evidence_id) {
                let existing = &identities[evidence_id];
                if existing.candidate_id != *candidate_id || existing.claim_id != *claim_id {
                    return Err(CausalTopologyDeriveError::DuplicateId);
                }
                admitted_for_slot = true;
                continue;
            }
            identities.insert(
                evidence_id.clone(),
                HostCausalIdentityV1 {
                    candidate_id: candidate_id.clone(),
                    claim_id: claim_id.clone(),
                    evidence_id: evidence_id.clone(),
                    corpus_id: entry.corpus_id.clone(),
                    revision: entry.revision,
                },
            );
            classify_evidence(assignment, evidence_id, classes);
            admitted_for_slot = true;
        }
        if admitted_for_slot {
            slots.insert(HostCausalSlotV1 {
                kind: assignment.kind,
                candidate_id: candidate_id.clone(),
                claim_id: claim_id.clone(),
            });
        }
    }
    Ok(())
}

fn identity_matches_assignment(
    assignment: &ClaimAssignment,
    claim: &InvestigationClaimV1,
    entry: &HostEvidenceEntry,
) -> bool {
    if assignment.decoy {
        return true;
    }
    match assignment.kind {
        CausalRelationKind::Recovery => true,
        CausalRelationKind::PropagatedSymptom => claim.claim_kind == ClaimKind::Symptom,
        CausalRelationKind::InitiatingTrigger => {
            claim.claim_kind == ClaimKind::CausalCandidate || entry.role == EvidenceRole::Cause
        }
        CausalRelationKind::UnrelatedCompeting => true,
        CausalRelationKind::Disconfirmation => false,
    }
}

fn classify_evidence(
    assignment: &ClaimAssignment,
    evidence_id: &str,
    classes: &mut HostCausalClassesV1,
) {
    match assignment.kind {
        CausalRelationKind::Recovery => {
            classes
                .recovery_evidence_ids
                .insert(evidence_id.to_string());
        }
        CausalRelationKind::UnrelatedCompeting => {
            classes
                .unrelated_evidence_ids
                .insert(evidence_id.to_string());
            if assignment.decoy {
                classes.decoy_evidence_ids.insert(evidence_id.to_string());
            }
        }
        _ => {}
    }
}

fn admit_disconfirmation(
    contradictions: &[ReviewContradiction],
    known_claims: &KnownClaims,
    findings: &[CandidateFindingV1],
    ledger: &HostEvidenceLedger,
    binding: &AnswerBindingV1,
    identities: &mut BTreeMap<String, HostCausalIdentityV1>,
    slots: &mut BTreeSet<HostCausalSlotV1>,
) -> Result<(), CausalTopologyDeriveError> {
    for contradiction in contradictions {
        let pair_a = (
            contradiction.candidate_a.clone(),
            contradiction.claim_a_id.clone(),
        );
        let pair_b = (
            contradiction.candidate_b.clone(),
            contradiction.claim_b_id.clone(),
        );
        if pair_a.0 == pair_b.0 {
            continue;
        }
        if !known_claims.contains(&pair_a) || !known_claims.contains(&pair_b) {
            continue;
        }
        // Contradiction prose is untrusted display and is never host authority.
        for pair in [pair_a, pair_b] {
            let evidence_ids = disconfirmation_evidence(
                contradiction,
                &pair.0,
                &pair.1,
                findings,
                ledger,
                binding,
            );
            // Naming a claim pair in reviewer prose is not enough to mint a
            // disconfirmation slot. At least one citation must belong to that
            // exact already-validated claim identity.
            let mut admitted = false;
            for evidence_id in evidence_ids {
                if let Some(existing) = identities.get(&evidence_id) {
                    if existing.candidate_id == pair.0 && existing.claim_id == pair.1 {
                        admitted = true;
                        continue;
                    }
                    // An evidence id already bound to another identity is not
                    // reusable. Silently skipping would hide conflicting
                    // disconfirmation reuse and weaken fail-closed uniqueness.
                    return Err(CausalTopologyDeriveError::DuplicateId);
                }
                let Some(entry) = ledger.get(&evidence_id) else {
                    continue;
                };
                if entry.candidate_id != pair.0
                    || entry.corpus_id != binding.corpus_id
                    || entry.revision != binding.revision
                {
                    continue;
                }
                if !is_inert_id(&evidence_id) || !is_inert_id(&pair.0) || !is_inert_id(&pair.1) {
                    return Err(CausalTopologyDeriveError::UnsafeIdentity);
                }
                identities.insert(
                    evidence_id.clone(),
                    HostCausalIdentityV1 {
                        candidate_id: pair.0.clone(),
                        claim_id: pair.1.clone(),
                        evidence_id: evidence_id.clone(),
                        corpus_id: entry.corpus_id.clone(),
                        revision: entry.revision,
                    },
                );
                admitted = true;
            }
            if admitted {
                slots.insert(HostCausalSlotV1 {
                    kind: CausalRelationKind::Disconfirmation,
                    candidate_id: pair.0,
                    claim_id: pair.1,
                });
            }
        }
    }
    Ok(())
}

fn disconfirmation_evidence(
    contradiction: &ReviewContradiction,
    candidate_id: &str,
    claim_id: &str,
    findings: &[CandidateFindingV1],
    ledger: &HostEvidenceLedger,
    binding: &AnswerBindingV1,
) -> Vec<String> {
    let Some(claim) = find_claim(findings, candidate_id, claim_id) else {
        return Vec::new();
    };
    let claim_evidence = claim
        .evidence_ids
        .iter()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    contradiction
        .evidence_ids
        .iter()
        .filter(|evidence_id| {
            claim_evidence.contains(evidence_id.as_str())
                && ledger.get(evidence_id).is_some_and(|entry| {
                    entry.candidate_id == candidate_id
                        && entry.corpus_id == binding.corpus_id
                        && entry.revision == binding.revision
                })
        })
        .cloned()
        .collect()
}

fn find_claim<'a>(
    findings: &'a [CandidateFindingV1],
    candidate_id: &str,
    claim_id: &str,
) -> Option<&'a InvestigationClaimV1> {
    findings.iter().find_map(|finding| {
        finding
            .claims
            .iter()
            .find(|claim| claim.candidate_id == candidate_id && claim.claim_id == claim_id)
    })
}

fn validated_entry<'a>(
    ledger: &'a HostEvidenceLedger,
    binding: &AnswerBindingV1,
    claim: &InvestigationClaimV1,
    evidence_id: &str,
) -> Option<&'a HostEvidenceEntry> {
    let entry = ledger.get(evidence_id)?;
    if entry.candidate_id != claim.candidate_id {
        return None;
    }
    if entry.corpus_id != binding.corpus_id || entry.revision != binding.revision {
        return None;
    }
    Some(entry)
}

fn ensure_unique_claim_pairs(
    findings: &[CandidateFindingV1],
) -> Result<(), CausalTopologyDeriveError> {
    let mut seen = BTreeSet::new();
    for finding in findings {
        for claim in &finding.claims {
            if !seen.insert((claim.candidate_id.as_str(), claim.claim_id.as_str())) {
                // Duplicate pairs make merge_assignment / find_claim
                // first-match order-dependent. Pipeline inputs are unique.
                return Err(CausalTopologyDeriveError::DuplicateId);
            }
        }
    }
    Ok(())
}

fn index_classifications(
    classifications: &[HostEvidenceClassV1],
) -> Result<BTreeMap<&str, &HostEvidenceClassV1>, CausalTopologyDeriveError> {
    let mut class_by_id = BTreeMap::new();
    for class in classifications {
        if class_by_id
            .insert(class.evidence_id.as_str(), class)
            .is_some()
        {
            // Duplicate evidence_id is not well-formed host input. Last-write
            // wins would make classification order authoritative and could flip
            // Independent/IndependentNoise into Candidate (or the reverse).
            return Err(CausalTopologyDeriveError::DuplicateId);
        }
    }
    Ok(class_by_id)
}

fn class_of(
    class_by_id: &BTreeMap<&str, &HostEvidenceClassV1>,
    evidence_id: &str,
) -> HostEvidenceClassV1 {
    class_by_id
        .get(evidence_id)
        .map(|class| (*class).clone())
        .unwrap_or(HostEvidenceClassV1 {
            evidence_id: evidence_id.to_string(),
            scope: FastTriageEvidenceScope::Candidate,
            // Unclassified neighborhood is IndependentNoise: never a trigger.
            category: FastTriageEvidenceCategory::IndependentNoise,
            chronology_ordinal: None,
            frequency: None,
        })
}

fn is_independent_or_noise(class: &HostEvidenceClassV1) -> bool {
    class.scope == FastTriageEvidenceScope::Independent
        || class.category == FastTriageEvidenceCategory::IndependentNoise
}

fn is_positional_chronology(class: &HostEvidenceClassV1) -> bool {
    matches!(
        class.category,
        FastTriageEvidenceCategory::PrecedingSameSource
            | FastTriageEvidenceCategory::FollowingSameSource
    )
}

fn is_inert_id(id: &str) -> bool {
    !id.is_empty()
        && !id
            .chars()
            .any(|c| c.is_control() || is_line_boundary(c) || is_bidi_formatting_control(c))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derive_error_wire_labels_are_stable() {
        assert_eq!(
            CausalTopologyDeriveError::InsufficientHostProof.as_str(),
            "insufficient_host_proof"
        );
        assert_eq!(
            CausalTopologyDeriveError::WrongRevision.as_str(),
            "wrong_revision"
        );
        assert_eq!(
            CausalTopologyDeriveError::ContestedReview.as_str(),
            "contested_review"
        );
    }
}
