//! Hermetic proofs for host-only [`HostCausalTopologyV1`] derivation.
//!
//! No provider calls, no production pipeline wiring, and no claim-text
//! authority. Claim uniqueness is pair-keyed like [`KnownClaims`].

use std::collections::BTreeSet;

use cd_core::fast_triage::{FastTriageEvidenceCategory, FastTriageEvidenceScope};
use cd_core::investigation_answer::{
    AnswerBindingV1, EvidenceRole, HostEvidenceEntry, HostEvidenceLedger, LogSnapshotRevisionV1,
};
use cd_core::multi_model::{
    derive_host_causal_topology, validate_candidate_finding, validate_causal_synthesis,
    validate_review_report, CandidateFindingV1, CausalRelationKind, CausalSynthesisError,
    CausalTopologyDeriveError, HostCausalClassesV1, HostCausalIdentityV1, HostCausalSlotV1,
    HostCausalTopologyInput, HostCausalTopologyV1, HostEvidenceClassV1, InvestigationRole,
    KnownClaims, ReviewContradiction, RoleBinding, CANDIDATE_FINDING_SCHEMA_V1,
    CAUSAL_SYNTHESIS_SCHEMA_V1, REVIEW_SCHEMA_V1,
};

fn rev() -> LogSnapshotRevisionV1 {
    LogSnapshotRevisionV1 {
        event_revision: 1,
        template_analysis_revision: 1,
        suppression_revision: 1,
    }
}

fn investigator() -> RoleBinding {
    RoleBinding {
        role: InvestigationRole::Investigator,
        profile_id: "p".into(),
        model: "m".into(),
        semantic_attempts: 1,
    }
}

fn reviewer() -> RoleBinding {
    RoleBinding {
        role: InvestigationRole::Reviewer,
        profile_id: "p".into(),
        model: "m".into(),
        semantic_attempts: 1,
    }
}

fn entry(
    evidence_id: &str,
    candidate_id: &str,
    corpus_id: &str,
    role: EvidenceRole,
) -> HostEvidenceEntry {
    HostEvidenceEntry {
        evidence_id: evidence_id.into(),
        candidate_id: candidate_id.into(),
        source_label: "src".into(),
        locator: "seq=1".into(),
        corpus_id: corpus_id.into(),
        revision: rev(),
        role,
        content: "row".into(),
    }
}

fn ledger(corpus_id: &str, evidence: Vec<HostEvidenceEntry>) -> HostEvidenceLedger {
    let binding = AnswerBindingV1 {
        session_id: "s".into(),
        turn_id: "t".into(),
        corpus_id: corpus_id.into(),
        revision: rev(),
        ledger_digest: HostEvidenceLedger::digest(&evidence),
    };
    HostEvidenceLedger::new(binding, evidence).expect("ledger")
}

fn class(
    evidence_id: &str,
    scope: FastTriageEvidenceScope,
    category: FastTriageEvidenceCategory,
    chronology_ordinal: Option<u64>,
    frequency: Option<u64>,
) -> HostEvidenceClassV1 {
    HostEvidenceClassV1 {
        evidence_id: evidence_id.into(),
        scope,
        category,
        chronology_ordinal,
        frequency,
    }
}

fn focus(evidence_id: &str) -> HostEvidenceClassV1 {
    class(
        evidence_id,
        FastTriageEvidenceScope::Candidate,
        FastTriageEvidenceCategory::Focus,
        Some(4),
        Some(2),
    )
}

fn finding(
    ledger: &HostEvidenceLedger,
    candidate_id: &str,
    section: &str,
    claim_id: &str,
    evidence_id: &str,
) -> CandidateFindingV1 {
    let raw = format!(
        r#"{{"schema":"{CANDIDATE_FINDING_SCHEMA_V1}","candidate_id":"{candidate_id}","{section}":[{{"claim_id":"{claim_id}","text":"n","evidence_ids":["{evidence_id}"]}}]}}"#
    );
    validate_candidate_finding(&raw, ledger, candidate_id, investigator()).expect("finding")
}

fn known_from(findings: &[CandidateFindingV1]) -> KnownClaims {
    findings
        .iter()
        .flat_map(|finding| {
            finding
                .claims
                .iter()
                .map(|claim| (claim.candidate_id.clone(), claim.claim_id.clone()))
        })
        .collect()
}

fn derive(
    ledger: &HostEvidenceLedger,
    findings: &[CandidateFindingV1],
    contradictions: &[ReviewContradiction],
    recovery_evidence_ids: &BTreeSet<String>,
    classifications: &[HostEvidenceClassV1],
) -> Result<HostCausalTopologyV1, CausalTopologyDeriveError> {
    derive_host_causal_topology(HostCausalTopologyInput {
        binding: ledger.binding(),
        ledger,
        findings,
        known_claims: &known_from(findings),
        contradictions,
        recovery_evidence_ids,
        classifications,
    })
}

fn contradiction(
    ledger: &HostEvidenceLedger,
    findings: &[CandidateFindingV1],
    candidate_a: &str,
    claim_a: &str,
    candidate_b: &str,
    claim_b: &str,
    evidence_ids: &[&str],
) -> ReviewContradiction {
    let ids = evidence_ids
        .iter()
        .map(|id| format!("\"{id}\""))
        .collect::<Vec<_>>()
        .join(",");
    let raw = format!(
        r#"{{"schema":"{REVIEW_SCHEMA_V1}","contradictions":[{{"contradiction_id":"x1","candidate_a":"{candidate_a}","claim_a_id":"{claim_a}","candidate_b":"{candidate_b}","claim_b_id":"{claim_b}","text":"n","evidence_ids":[{ids}]}}]}}"#
    );
    validate_review_report(&raw, ledger, &known_from(findings), reviewer())
        .expect("review")
        .contradictions
        .into_iter()
        .next()
        .expect("contradiction")
}

fn relation(kind: &str, candidate: &str, claim: &str, evidence: &str) -> String {
    format!(
        r#"{{"kind":"{kind}","candidate_id":"{candidate}","claim_id":"{claim}","evidence_ids":["{evidence}"]}}"#
    )
}

fn proposal(relations: &[String]) -> String {
    format!(
        r#"{{"schema":"{CAUSAL_SYNTHESIS_SCHEMA_V1}","relations":[{}]}}"#,
        relations.join(",")
    )
}

fn slot(kind: CausalRelationKind, candidate: &str, claim: &str) -> HostCausalSlotV1 {
    HostCausalSlotV1 {
        kind,
        candidate_id: candidate.into(),
        claim_id: claim.into(),
    }
}

fn identity(candidate: &str, claim: &str, evidence: &str, corpus_id: &str) -> HostCausalIdentityV1 {
    HostCausalIdentityV1 {
        candidate_id: candidate.into(),
        claim_id: claim.into(),
        evidence_id: evidence.into(),
        corpus_id: corpus_id.into(),
        revision: rev(),
    }
}

#[test]
fn independent_scope_and_independent_noise_never_create_trigger_or_symptom() {
    let corpus = "cx";
    let noise_ledger = ledger(
        corpus,
        vec![
            entry("e:n", "k-n", corpus, EvidenceRole::Cause),
            entry("e:s", "k1", corpus, EvidenceRole::Symptom),
        ],
    );
    let noise_findings = vec![
        finding(&noise_ledger, "k-n", "causal_candidates", "c:n", "e:n"),
        finding(&noise_ledger, "k1", "symptoms", "c:s", "e:s"),
    ];
    let noise_classes = vec![
        class(
            "e:n",
            FastTriageEvidenceScope::Independent,
            FastTriageEvidenceCategory::IndependentNoise,
            Some(0),
            Some(99),
        ),
        focus("e:s"),
    ];
    assert_eq!(
        derive(
            &noise_ledger,
            &noise_findings,
            &[],
            &BTreeSet::new(),
            &noise_classes
        ),
        Err(CausalTopologyDeriveError::InsufficientHostProof)
    );

    let independent_symptom_ledger = ledger(
        corpus,
        vec![
            entry("e:t", "k1", corpus, EvidenceRole::Cause),
            entry("e:s", "k-n", corpus, EvidenceRole::Symptom),
        ],
    );
    let independent_symptom_findings = vec![
        finding(
            &independent_symptom_ledger,
            "k1",
            "causal_candidates",
            "c:t",
            "e:t",
        ),
        finding(&independent_symptom_ledger, "k-n", "symptoms", "c:s", "e:s"),
    ];
    let independent_symptom_classes = vec![
        focus("e:t"),
        class(
            "e:s",
            FastTriageEvidenceScope::Independent,
            FastTriageEvidenceCategory::IndependentNoise,
            Some(3),
            Some(1),
        ),
    ];
    assert_eq!(
        derive(
            &independent_symptom_ledger,
            &independent_symptom_findings,
            &[],
            &BTreeSet::new(),
            &independent_symptom_classes
        ),
        Err(CausalTopologyDeriveError::InsufficientHostProof)
    );

    let mixed = ledger(
        corpus,
        vec![
            entry("e:t", "k1", corpus, EvidenceRole::Cause),
            entry("e:s", "k1", corpus, EvidenceRole::Symptom),
            entry("e:n", "k-n", corpus, EvidenceRole::Cause),
        ],
    );
    let mixed_findings = vec![
        finding(&mixed, "k1", "causal_candidates", "c:t", "e:t"),
        finding(&mixed, "k1", "symptoms", "c:s", "e:s"),
        finding(&mixed, "k-n", "causal_candidates", "c:n", "e:n"),
    ];
    let mixed_classes = vec![
        focus("e:t"),
        focus("e:s"),
        class(
            "e:n",
            FastTriageEvidenceScope::Independent,
            FastTriageEvidenceCategory::IndependentNoise,
            Some(1),
            Some(50),
        ),
    ];
    let topology = derive(
        &mixed,
        &mixed_findings,
        &[],
        &BTreeSet::new(),
        &mixed_classes,
    )
    .expect("noise may occupy unrelated slots beside a proven chain");
    assert!(topology
        .admitted_claims()
        .contains(&("k-n".into(), "c:n".into())));

    let as_trigger = proposal(&[
        relation("initiating_trigger", "k-n", "c:n", "e:n"),
        relation("propagated_symptom", "k1", "c:s", "e:s"),
    ]);
    // Independent/noise never receives an initiating_trigger slot, so the
    // contract rejects the kind before decoy-promotion on a trigger identity.
    assert_eq!(
        validate_causal_synthesis(&as_trigger, &topology),
        Err(CausalSynthesisError::TopologyViolation)
    );

    let as_unrelated = proposal(&[
        relation("initiating_trigger", "k1", "c:t", "e:t"),
        relation("propagated_symptom", "k1", "c:s", "e:s"),
        relation("unrelated_competing", "k-n", "c:n", "e:n"),
    ]);
    let value = validate_causal_synthesis(&as_unrelated, &topology).expect("unrelated");
    assert_eq!(
        value.relations[2].kind,
        CausalRelationKind::UnrelatedCompeting
    );
}

#[test]
fn chronology_ordinal_frequency_and_same_source_never_create_trigger_or_recovery() {
    let corpus = "cx";
    let preceding = ledger(
        corpus,
        vec![
            entry("e:p", "k1", corpus, EvidenceRole::Cause),
            entry("e:s", "k1", corpus, EvidenceRole::Symptom),
        ],
    );
    let preceding_findings = vec![
        finding(&preceding, "k1", "causal_candidates", "c:p", "e:p"),
        finding(&preceding, "k1", "symptoms", "c:s", "e:s"),
    ];
    let preceding_classes = vec![
        class(
            "e:p",
            FastTriageEvidenceScope::Candidate,
            FastTriageEvidenceCategory::PrecedingSameSource,
            Some(0),
            Some(99),
        ),
        focus("e:s"),
    ];
    assert_eq!(
        derive(
            &preceding,
            &preceding_findings,
            &[],
            &BTreeSet::new(),
            &preceding_classes
        ),
        Err(CausalTopologyDeriveError::InsufficientHostProof)
    );

    let following = ledger(
        corpus,
        vec![
            entry("e:f", "k1", corpus, EvidenceRole::Cause),
            entry("e:s", "k1", corpus, EvidenceRole::Symptom),
        ],
    );
    let following_findings = vec![
        finding(&following, "k1", "causal_candidates", "c:f", "e:f"),
        finding(&following, "k1", "symptoms", "c:s", "e:s"),
    ];
    let following_classes = vec![
        class(
            "e:f",
            FastTriageEvidenceScope::Candidate,
            FastTriageEvidenceCategory::FollowingSameSource,
            Some(9),
            Some(9),
        ),
        focus("e:s"),
    ];
    assert_eq!(
        derive(
            &following,
            &following_findings,
            &[],
            &BTreeSet::new(),
            &following_classes
        ),
        Err(CausalTopologyDeriveError::InsufficientHostProof)
    );

    let chain = ledger(
        corpus,
        vec![
            entry("e:t", "k1", corpus, EvidenceRole::Cause),
            entry("e:s", "k1", corpus, EvidenceRole::Symptom),
            entry("e:f", "k1", corpus, EvidenceRole::Neutral),
        ],
    );
    let chain_findings = vec![
        finding(&chain, "k1", "causal_candidates", "c:t", "e:t"),
        finding(&chain, "k1", "symptoms", "c:s", "e:s"),
        finding(&chain, "k1", "observations", "c:f", "e:f"),
    ];
    let chain_classes = vec![
        class(
            "e:t",
            FastTriageEvidenceScope::Candidate,
            FastTriageEvidenceCategory::Focus,
            Some(0),
            Some(99),
        ),
        focus("e:s"),
        class(
            "e:f",
            FastTriageEvidenceScope::Candidate,
            FastTriageEvidenceCategory::FollowingSameSource,
            Some(12),
            Some(1),
        ),
    ];
    let topology = derive(
        &chain,
        &chain_findings,
        &[],
        &BTreeSet::new(),
        &chain_classes,
    )
    .expect("focus cause still admits a trigger; following does not become recovery");
    let as_recovery = proposal(&[
        relation("initiating_trigger", "k1", "c:t", "e:t"),
        relation("propagated_symptom", "k1", "c:s", "e:s"),
        relation("recovery", "k1", "c:f", "e:f"),
    ]);
    assert_eq!(
        validate_causal_synthesis(&as_recovery, &topology),
        Err(CausalSynthesisError::UnknownClaim)
    );
    let as_trigger = proposal(&[
        relation("initiating_trigger", "k1", "c:f", "e:f"),
        relation("propagated_symptom", "k1", "c:s", "e:s"),
    ]);
    assert_eq!(
        validate_causal_synthesis(&as_trigger, &topology),
        Err(CausalSynthesisError::UnknownClaim)
    );
    let honest = proposal(&[
        relation("initiating_trigger", "k1", "c:t", "e:t"),
        relation("propagated_symptom", "k1", "c:s", "e:s"),
    ]);
    validate_causal_synthesis(&honest, &topology).expect("ordinal/frequency did not establish");

    let propagation = ledger(
        corpus,
        vec![
            entry("e:p", "k1", corpus, EvidenceRole::Cause),
            entry("e:s", "k1", corpus, EvidenceRole::Symptom),
        ],
    );
    let propagation_findings = vec![
        finding(&propagation, "k1", "causal_candidates", "c:p", "e:p"),
        finding(&propagation, "k1", "symptoms", "c:s", "e:s"),
    ];
    let propagation_classes = vec![
        class(
            "e:p",
            FastTriageEvidenceScope::Candidate,
            FastTriageEvidenceCategory::Propagation,
            Some(10),
            None,
        ),
        focus("e:s"),
    ];
    assert_eq!(
        derive(
            &propagation,
            &propagation_findings,
            &[],
            &BTreeSet::new(),
            &propagation_classes,
        ),
        Err(CausalTopologyDeriveError::InsufficientHostProof),
        "a downstream propagation row cannot initiate the causal chain"
    );
}

#[test]
fn exact_corpus_revision_binding_is_required() {
    let corpus = "cx";
    let built = ledger(
        corpus,
        vec![
            entry("e:t", "k1", corpus, EvidenceRole::Cause),
            entry("e:s", "k1", corpus, EvidenceRole::Symptom),
        ],
    );
    let findings = vec![
        finding(&built, "k1", "causal_candidates", "c:t", "e:t"),
        finding(&built, "k1", "symptoms", "c:s", "e:s"),
    ];
    let classifications = vec![focus("e:t"), focus("e:s")];
    let known = known_from(&findings);
    let topology = derive_host_causal_topology(HostCausalTopologyInput {
        binding: built.binding(),
        ledger: &built,
        findings: &findings,
        known_claims: &known,
        contradictions: &[],
        recovery_evidence_ids: &BTreeSet::new(),
        classifications: &classifications,
    })
    .expect("exact binding");
    assert_eq!(topology.corpus_id, corpus);
    assert_eq!(topology.revision, rev());

    let mut other_corpus = built.binding().clone();
    other_corpus.corpus_id = "other-cx".into();
    assert_eq!(
        derive_host_causal_topology(HostCausalTopologyInput {
            binding: &other_corpus,
            ledger: &built,
            findings: &findings,
            known_claims: &known,
            contradictions: &[],
            recovery_evidence_ids: &BTreeSet::new(),
            classifications: &classifications,
        }),
        Err(CausalTopologyDeriveError::WrongRevision)
    );

    let mut other_rev = built.binding().clone();
    other_rev.revision = LogSnapshotRevisionV1 {
        event_revision: 9,
        template_analysis_revision: 1,
        suppression_revision: 1,
    };
    assert_eq!(
        derive_host_causal_topology(HostCausalTopologyInput {
            binding: &other_rev,
            ledger: &built,
            findings: &findings,
            known_claims: &known,
            contradictions: &[],
            recovery_evidence_ids: &BTreeSet::new(),
            classifications: &classifications,
        }),
        Err(CausalTopologyDeriveError::WrongRevision)
    );
}

#[test]
fn duplicate_classification_evidence_id_fails_closed_as_duplicate_id() {
    let corpus = "cx";
    let built = ledger(
        corpus,
        vec![
            entry("e:t", "k1", corpus, EvidenceRole::Cause),
            entry("e:s", "k1", corpus, EvidenceRole::Symptom),
        ],
    );
    let findings = vec![
        finding(&built, "k1", "causal_candidates", "c:t", "e:t"),
        finding(&built, "k1", "symptoms", "c:s", "e:s"),
    ];
    let noise_t = class(
        "e:t",
        FastTriageEvidenceScope::Independent,
        FastTriageEvidenceCategory::IndependentNoise,
        Some(0),
        Some(99),
    );
    // Either order would last-write-win to a different slot kind. Both fail.
    assert_eq!(
        derive(
            &built,
            &findings,
            &[],
            &BTreeSet::new(),
            &[focus("e:t"), noise_t.clone(), focus("e:s")],
        ),
        Err(CausalTopologyDeriveError::DuplicateId)
    );
    assert_eq!(
        derive(
            &built,
            &findings,
            &[],
            &BTreeSet::new(),
            &[noise_t, focus("e:t"), focus("e:s")],
        ),
        Err(CausalTopologyDeriveError::DuplicateId)
    );
    assert_eq!(
        derive(
            &built,
            &findings,
            &[],
            &BTreeSet::new(),
            &[focus("e:t"), focus("e:t"), focus("e:s")],
        ),
        Err(CausalTopologyDeriveError::DuplicateId)
    );
}

#[test]
fn unique_classification_permutation_yields_identical_topology() {
    let corpus = "cx";
    let built = ledger(
        corpus,
        vec![
            entry("e:t", "k1", corpus, EvidenceRole::Cause),
            entry("e:s", "k1", corpus, EvidenceRole::Symptom),
            entry("e:n", "k-n", corpus, EvidenceRole::Cause),
        ],
    );
    let findings = vec![
        finding(&built, "k1", "causal_candidates", "c:t", "e:t"),
        finding(&built, "k1", "symptoms", "c:s", "e:s"),
        finding(&built, "k-n", "causal_candidates", "c:n", "e:n"),
    ];
    let noise_n = class(
        "e:n",
        FastTriageEvidenceScope::Independent,
        FastTriageEvidenceCategory::IndependentNoise,
        Some(1),
        Some(50),
    );
    let forward = [focus("e:t"), focus("e:s"), noise_n.clone()];
    let reversed = [noise_n, focus("e:s"), focus("e:t")];
    let a = derive(&built, &findings, &[], &BTreeSet::new(), &forward).expect("forward");
    let b = derive(&built, &findings, &[], &BTreeSet::new(), &reversed).expect("reversed");
    assert_eq!(a, b);
    let raw = proposal(&[
        relation("initiating_trigger", "k1", "c:t", "e:t"),
        relation("propagated_symptom", "k1", "c:s", "e:s"),
        relation("unrelated_competing", "k-n", "c:n", "e:n"),
    ]);
    assert_eq!(
        validate_causal_synthesis(&raw, &a).expect("forward validate"),
        validate_causal_synthesis(&raw, &b).expect("reversed validate")
    );
}

#[test]
fn duplicate_claim_pair_across_findings_fails_closed_as_duplicate_id() {
    let corpus = "cx";
    let built = ledger(
        corpus,
        vec![
            entry("e:t", "k1", corpus, EvidenceRole::Cause),
            entry("e:s", "k1", corpus, EvidenceRole::Symptom),
        ],
    );
    let trigger_dup = finding(&built, "k1", "causal_candidates", "c:dup", "e:t");
    let symptom_dup = finding(&built, "k1", "symptoms", "c:dup", "e:s");
    let unique_symptom = finding(&built, "k1", "symptoms", "c:s", "e:s");
    let classes = [focus("e:t"), focus("e:s")];
    // Trigger-then-symptom would last-write/merge to a trigger plus c:s.
    // Symptom-then-trigger would keep a symptom and drop the trigger.
    // Both input orders fail closed identically.
    assert_eq!(
        derive(
            &built,
            &[
                trigger_dup.clone(),
                symptom_dup.clone(),
                unique_symptom.clone()
            ],
            &[],
            &BTreeSet::new(),
            &classes,
        ),
        Err(CausalTopologyDeriveError::DuplicateId)
    );
    assert_eq!(
        derive(
            &built,
            &[symptom_dup, trigger_dup, unique_symptom],
            &[],
            &BTreeSet::new(),
            &classes,
        ),
        Err(CausalTopologyDeriveError::DuplicateId)
    );
}

#[test]
fn contradiction_padding_cannot_enlarge_a_claims_evidence_identity_set() {
    let corpus = "cx";
    let built = ledger(
        corpus,
        vec![
            entry("e:t", "k1", corpus, EvidenceRole::Cause),
            entry("e:s", "k1", corpus, EvidenceRole::Symptom),
            entry("e:u", "k2", corpus, EvidenceRole::Neutral),
            entry("e:d", "k2", corpus, EvidenceRole::Neutral),
        ],
    );
    let findings = vec![
        finding(&built, "k1", "causal_candidates", "c:t", "e:t"),
        finding(&built, "k1", "symptoms", "c:s", "e:s"),
        finding(&built, "k2", "causal_candidates", "c:u", "e:u"),
        finding(&built, "k2", "observations", "c:d", "e:d"),
    ];
    let classes = vec![
        focus("e:t"),
        focus("e:s"),
        class(
            "e:u",
            FastTriageEvidenceScope::Independent,
            FastTriageEvidenceCategory::IndependentNoise,
            Some(5),
            Some(5),
        ),
        focus("e:d"),
    ];
    // e:t belongs to (k1, c:t), not (k1, c:s). A reviewer may cite it because
    // review validation permits evidence from either named candidate, but the
    // topology must intersect that citation with each named claim's own
    // validated evidence set. Contradiction order cannot change the result.
    let reuse_a = contradiction(&built, &findings, "k1", "c:s", "k2", "c:d", &["e:t"]);
    let reuse_b = contradiction(&built, &findings, "k2", "c:d", "k1", "c:s", &["e:t"]);
    let topology_a =
        derive(&built, &findings, &[reuse_a], &BTreeSet::new(), &classes).expect("order a");
    let topology_b =
        derive(&built, &findings, &[reuse_b], &BTreeSet::new(), &classes).expect("order b");
    assert_eq!(topology_a, topology_b);

    let padded = proposal(&[
        relation("initiating_trigger", "k1", "c:t", "e:t"),
        relation("propagated_symptom", "k1", "c:s", "e:s"),
        relation("unrelated_competing", "k2", "c:u", "e:u"),
        relation("disconfirmation", "k1", "c:s", "e:t"),
        relation("disconfirmation", "k2", "c:d", "e:d"),
    ]);
    assert_eq!(
        validate_causal_synthesis(&padded, &topology_a),
        Err(CausalSynthesisError::TopologyViolation),
        "the padded trigger id never becomes a disconfirmation identity for c:s"
    );

    // Same-identity reuse of e:t on (k1, c:t) still derives. Candidate-local
    // confinement holds: e:t cannot fill a k2 slot.
    let confined = contradiction(&built, &findings, "k1", "c:t", "k2", "c:d", &["e:t", "e:d"]);
    let topology = derive(&built, &findings, &[confined], &BTreeSet::new(), &classes)
        .expect("same-identity disconfirmation reuse stays candidate-local");
    let steal = proposal(&[
        relation("initiating_trigger", "k1", "c:t", "e:t"),
        relation("propagated_symptom", "k1", "c:s", "e:s"),
        relation("unrelated_competing", "k2", "c:u", "e:u"),
        relation("disconfirmation", "k2", "c:d", "e:t"),
    ]);
    assert_eq!(
        validate_causal_synthesis(&steal, &topology),
        Err(CausalSynthesisError::WrongScope)
    );
    let honest = proposal(&[
        relation("initiating_trigger", "k1", "c:t", "e:t"),
        relation("propagated_symptom", "k1", "c:s", "e:s"),
        relation("unrelated_competing", "k2", "c:u", "e:u"),
        relation("disconfirmation", "k2", "c:d", "e:d"),
    ]);
    validate_causal_synthesis(&honest, &topology).expect("k2 keeps its own evidence");
}

#[test]
fn pair_keyed_shared_raw_claim_id_across_candidates_is_admitted() {
    let corpus = "cx";
    let built = ledger(
        corpus,
        vec![
            entry("e:k1", "k1", corpus, EvidenceRole::Cause),
            entry("e:k2", "k2", corpus, EvidenceRole::Symptom),
        ],
    );
    let findings = vec![
        finding(&built, "k1", "causal_candidates", "same", "e:k1"),
        finding(&built, "k2", "symptoms", "same", "e:k2"),
    ];
    let topology = derive(
        &built,
        &findings,
        &[],
        &BTreeSet::new(),
        &[focus("e:k1"), focus("e:k2")],
    )
    .expect("pair-keyed");
    assert!(topology
        .admitted_claims()
        .contains(&("k1".into(), "same".into())));
    assert!(topology
        .admitted_claims()
        .contains(&("k2".into(), "same".into())));
    let raw = proposal(&[
        relation("initiating_trigger", "k1", "same", "e:k1"),
        relation("propagated_symptom", "k2", "same", "e:k2"),
    ]);
    let value = validate_causal_synthesis(&raw, &topology).expect("shared raw claim_id");
    assert_eq!(value.relations[0].candidate_id, "k1");
    assert_eq!(value.relations[1].candidate_id, "k2");
    assert_eq!(value.relations[0].claim_id, "same");
    assert_eq!(value.relations[1].claim_id, "same");
}

#[test]
fn insufficient_host_proof_is_typed_and_yields_no_topology() {
    let corpus = "cx";
    let built = ledger(
        corpus,
        vec![entry("e:s", "k1", corpus, EvidenceRole::Symptom)],
    );
    let findings = vec![finding(&built, "k1", "symptoms", "c:s", "e:s")];
    assert_eq!(
        derive(&built, &findings, &[], &BTreeSet::new(), &[focus("e:s")]),
        Err(CausalTopologyDeriveError::InsufficientHostProof)
    );
    assert_eq!(
        CausalTopologyDeriveError::InsufficientHostProof.as_str(),
        "insufficient_host_proof"
    );
}

struct Vocab {
    corpus: &'static str,
    k_t: &'static str,
    k_u: &'static str,
    c_t: &'static str,
    c_s: &'static str,
    c_u: &'static str,
    e_t: &'static str,
    e_s: &'static str,
    e_u: &'static str,
}

fn derive_vocab(v: &Vocab) -> (HostCausalTopologyV1, Vec<CausalRelationKind>) {
    let built = ledger(
        v.corpus,
        vec![
            entry(v.e_t, v.k_t, v.corpus, EvidenceRole::Cause),
            entry(v.e_s, v.k_t, v.corpus, EvidenceRole::Symptom),
            entry(v.e_u, v.k_u, v.corpus, EvidenceRole::Neutral),
        ],
    );
    let findings = vec![
        finding(&built, v.k_t, "causal_candidates", v.c_t, v.e_t),
        finding(&built, v.k_t, "symptoms", v.c_s, v.e_s),
        finding(&built, v.k_u, "causal_candidates", v.c_u, v.e_u),
    ];
    let topology = derive(
        &built,
        &findings,
        &[],
        &BTreeSet::new(),
        &[
            focus(v.e_t),
            focus(v.e_s),
            class(
                v.e_u,
                FastTriageEvidenceScope::Independent,
                FastTriageEvidenceCategory::IndependentNoise,
                Some(8),
                Some(8),
            ),
        ],
    )
    .expect("vocab");
    let raw = proposal(&[
        relation("initiating_trigger", v.k_t, v.c_t, v.e_t),
        relation("propagated_symptom", v.k_t, v.c_s, v.e_s),
        relation("unrelated_competing", v.k_u, v.c_u, v.e_u),
    ]);
    let value = validate_causal_synthesis(&raw, &topology).expect("validate vocab");
    let kinds = value.relations.iter().map(|rel| rel.kind).collect();
    (topology, kinds)
}

#[test]
fn opaque_id_bijection_preserves_slot_kinds() {
    let a = Vocab {
        corpus: "cx-a",
        k_t: "aa",
        k_u: "ab",
        c_t: "ca",
        c_s: "cb",
        c_u: "cc",
        e_t: "ea",
        e_s: "eb",
        e_u: "ec",
    };
    let b = Vocab {
        corpus: "cx-b",
        k_t: "za",
        k_u: "zb",
        c_t: "ya",
        c_s: "yb",
        c_u: "yc",
        e_t: "xa",
        e_s: "xb",
        e_u: "xc",
    };
    let (topology_a, kinds_a) = derive_vocab(&a);
    let (topology_b, kinds_b) = derive_vocab(&b);
    assert_eq!(kinds_a, kinds_b);
    assert_eq!(
        kinds_a,
        vec![
            CausalRelationKind::InitiatingTrigger,
            CausalRelationKind::PropagatedSymptom,
            CausalRelationKind::UnrelatedCompeting,
        ]
    );
    assert_eq!(
        topology_a.admitted_claims().len(),
        topology_b.admitted_claims().len()
    );
    let noise_as_trigger_a = proposal(&[
        relation("initiating_trigger", a.k_u, a.c_u, a.e_u),
        relation("propagated_symptom", a.k_t, a.c_s, a.e_s),
    ]);
    let noise_as_trigger_b = proposal(&[
        relation("initiating_trigger", b.k_u, b.c_u, b.e_u),
        relation("propagated_symptom", b.k_t, b.c_s, b.e_s),
    ]);
    assert_eq!(
        validate_causal_synthesis(&noise_as_trigger_a, &topology_a),
        Err(CausalSynthesisError::TopologyViolation)
    );
    assert_eq!(
        validate_causal_synthesis(&noise_as_trigger_b, &topology_b),
        Err(CausalSynthesisError::TopologyViolation)
    );
}

#[test]
fn host_derived_valid_topology_passes_try_new_and_validate_causal_synthesis() {
    let corpus = "cx";
    let built = ledger(
        corpus,
        vec![
            entry("e:k1:t", "k1", corpus, EvidenceRole::Cause),
            entry("e:k1:s", "k1", corpus, EvidenceRole::Symptom),
            entry("e:k2:u", "k2", corpus, EvidenceRole::Neutral),
            entry("e:k1:r", "k1", corpus, EvidenceRole::Neutral),
            entry("e:k2:d", "k2", corpus, EvidenceRole::Neutral),
        ],
    );
    let findings = vec![
        finding(&built, "k1", "causal_candidates", "c:k1:t", "e:k1:t"),
        finding(&built, "k1", "symptoms", "c:k1:s", "e:k1:s"),
        finding(&built, "k2", "causal_candidates", "c:k2:u", "e:k2:u"),
        finding(&built, "k1", "observations", "c:k1:r", "e:k1:r"),
        finding(&built, "k2", "observations", "c:k2:d", "e:k2:d"),
    ];
    let known = known_from(&findings);
    let review_raw = format!(
        r#"{{"schema":"{REVIEW_SCHEMA_V1}","contradictions":[{{"contradiction_id":"x1","candidate_a":"k1","claim_a_id":"c:k1:t","candidate_b":"k2","claim_b_id":"c:k2:d","text":"n","evidence_ids":["e:k2:d"]}}]}}"#
    );
    let review = validate_review_report(&review_raw, &built, &known, reviewer()).expect("review");
    let recovery = BTreeSet::from(["e:k1:r".to_string()]);
    let classifications = vec![
        focus("e:k1:t"),
        focus("e:k1:s"),
        class(
            "e:k2:u",
            FastTriageEvidenceScope::Independent,
            FastTriageEvidenceCategory::IndependentNoise,
            Some(5),
            Some(5),
        ),
        focus("e:k1:r"),
        focus("e:k2:d"),
    ];
    let derived = derive_host_causal_topology(HostCausalTopologyInput {
        binding: built.binding(),
        ledger: &built,
        findings: &findings,
        known_claims: &known,
        contradictions: &review.contradictions,
        recovery_evidence_ids: &recovery,
        classifications: &classifications,
    })
    .expect("derived");

    let reconstructed = HostCausalTopologyV1::try_new(
        corpus,
        rev(),
        vec![
            identity("k1", "c:k1:t", "e:k1:t", corpus),
            identity("k1", "c:k1:s", "e:k1:s", corpus),
            identity("k2", "c:k2:u", "e:k2:u", corpus),
            identity("k1", "c:k1:r", "e:k1:r", corpus),
            identity("k2", "c:k2:d", "e:k2:d", corpus),
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
            recovery_evidence_ids: BTreeSet::from(["e:k1:r".into()]),
            unrelated_evidence_ids: BTreeSet::from(["e:k2:u".into()]),
            decoy_evidence_ids: BTreeSet::from(["e:k2:u".into()]),
        },
    )
    .expect("try_new");
    assert_eq!(derived.corpus_id, reconstructed.corpus_id);
    assert_eq!(derived.revision, reconstructed.revision);
    assert_eq!(derived.admitted_claims(), reconstructed.admitted_claims());
    assert_eq!(
        derived.admitted_candidates(),
        reconstructed.admitted_candidates()
    );

    let raw = proposal(&[
        relation("initiating_trigger", "k1", "c:k1:t", "e:k1:t"),
        relation("propagated_symptom", "k1", "c:k1:s", "e:k1:s"),
        relation("unrelated_competing", "k2", "c:k2:u", "e:k2:u"),
        relation("recovery", "k1", "c:k1:r", "e:k1:r"),
        relation("disconfirmation", "k2", "c:k2:d", "e:k2:d"),
    ]);
    let from_derived = validate_causal_synthesis(&raw, &derived).expect("derived validate");
    let from_try_new = validate_causal_synthesis(&raw, &reconstructed).expect("try_new validate");
    assert_eq!(from_derived.relations.len(), 5);
    assert_eq!(from_try_new.relations.len(), 5);
    assert_eq!(
        from_derived.relations[0].kind,
        CausalRelationKind::InitiatingTrigger
    );
    assert_eq!(
        from_derived.relations[1].kind,
        CausalRelationKind::PropagatedSymptom
    );
    assert_eq!(
        from_derived.relations[2].kind,
        CausalRelationKind::UnrelatedCompeting
    );
    assert_eq!(from_derived.relations[3].kind, CausalRelationKind::Recovery);
    assert_eq!(
        from_derived.relations[4].kind,
        CausalRelationKind::Disconfirmation
    );

    let recovery_as_cause = proposal(&[
        relation("initiating_trigger", "k1", "c:k1:r", "e:k1:r"),
        relation("propagated_symptom", "k1", "c:k1:s", "e:k1:s"),
    ]);
    assert_eq!(
        validate_causal_synthesis(&recovery_as_cause, &derived),
        Err(CausalSynthesisError::TopologyViolation)
    );
    let decoy = proposal(&[
        relation("initiating_trigger", "k2", "c:k2:u", "e:k2:u"),
        relation("propagated_symptom", "k1", "c:k1:s", "e:k1:s"),
    ]);
    assert_eq!(
        validate_causal_synthesis(&decoy, &derived),
        Err(CausalSynthesisError::TopologyViolation)
    );
}
