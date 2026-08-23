//! Hostile, vocabulary-independent qualification of the isolated #963 contract.
//!
//! Every assertion drives shipped [`validate_causal_synthesis`] / [`HostCausalTopologyV1::try_new`].
//! Fixtures use disjoint inert IDs. Kind wire labels are the only allowed semantics.

use std::collections::BTreeSet;

use cd_core::investigation_answer::LogSnapshotRevisionV1;
use cd_core::multi_model::{
    validate_causal_synthesis, CausalRelationKind, CausalSynthesisError, HostCausalClassesV1,
    HostCausalIdentityV1, HostCausalSlotV1, HostCausalTopologyV1, CAUSAL_SYNTHESIS_SCHEMA_V1,
};
use serde::Deserialize;
use serde_json::{json, Value};

const HELDOUT: &str = include_str!("fixtures/cross_candidate_causal_synthesis.heldout.json");
const OPAQUE: &str = include_str!("fixtures/cross_candidate_causal_synthesis.opaque.json");

const EXPECTED_KINDS: [CausalRelationKind; 5] = [
    CausalRelationKind::InitiatingTrigger,
    CausalRelationKind::PropagatedSymptom,
    CausalRelationKind::UnrelatedCompeting,
    CausalRelationKind::Recovery,
    CausalRelationKind::Disconfirmation,
];

const KIND_WIRE: [&str; 5] = [
    "initiating_trigger",
    "propagated_symptom",
    "unrelated_competing",
    "recovery",
    "disconfirmation",
];

const BANNED: [&str; 27] = [
    "k1",
    "k2",
    "p1",
    "p2",
    "e:k1",
    "e:p1",
    "c:k1",
    "c:p1",
    "lease",
    "vercel",
    "rollback",
    "abort",
    "timeout",
    "epoch",
    "mailer",
    "dns",
    "checkout",
    "inventory",
    "gold",
    "truth",
    "fixture",
    "heldout",
    "opaque",
    "r16",
    "r17",
    "queue",
    "worker",
];

#[derive(Deserialize)]
struct FixtureIdentity {
    candidate_id: String,
    claim_id: String,
    evidence_id: String,
    corpus_id: String,
    revision: LogSnapshotRevisionV1,
}

#[derive(Deserialize)]
struct FixtureSlot {
    kind: CausalRelationKind,
    candidate_id: String,
    claim_id: String,
}

#[derive(Deserialize)]
struct Fixture {
    corpus_id: String,
    revision: LogSnapshotRevisionV1,
    identities: Vec<FixtureIdentity>,
    slots: Vec<FixtureSlot>,
    required_kinds: Vec<CausalRelationKind>,
    recovery_evidence_ids: Vec<String>,
    unrelated_evidence_ids: Vec<String>,
    decoy_evidence_ids: Vec<String>,
    proposal: Value,
}

struct Lab {
    fixture: Fixture,
    topology: HostCausalTopologyV1,
}

fn parse_fixture(raw: &str) -> Fixture {
    serde_json::from_str(raw).expect("fixture json")
}

fn topology_of(fixture: &Fixture) -> HostCausalTopologyV1 {
    HostCausalTopologyV1::try_new(
        fixture.corpus_id.clone(),
        fixture.revision,
        fixture
            .identities
            .iter()
            .map(|row| HostCausalIdentityV1 {
                candidate_id: row.candidate_id.clone(),
                claim_id: row.claim_id.clone(),
                evidence_id: row.evidence_id.clone(),
                corpus_id: row.corpus_id.clone(),
                revision: row.revision,
            })
            .collect(),
        fixture
            .slots
            .iter()
            .map(|row| HostCausalSlotV1 {
                kind: row.kind,
                candidate_id: row.candidate_id.clone(),
                claim_id: row.claim_id.clone(),
            })
            .collect(),
        fixture.required_kinds.clone(),
        HostCausalClassesV1 {
            recovery_evidence_ids: fixture.recovery_evidence_ids.iter().cloned().collect(),
            unrelated_evidence_ids: fixture.unrelated_evidence_ids.iter().cloned().collect(),
            decoy_evidence_ids: fixture.decoy_evidence_ids.iter().cloned().collect(),
        },
    )
    .expect("shipped topology constructor")
}

fn load(raw: &str) -> Lab {
    let fixture = parse_fixture(raw);
    let topology = topology_of(&fixture);
    Lab { fixture, topology }
}

fn proposal_str(proposal: &Value) -> String {
    serde_json::to_string(proposal).expect("proposal json")
}

fn kinds_of(topology: &HostCausalTopologyV1, proposal: &Value) -> Vec<CausalRelationKind> {
    validate_causal_synthesis(&proposal_str(proposal), topology)
        .expect("valid proposal")
        .relations
        .into_iter()
        .map(|rel| rel.kind)
        .collect()
}

fn rel(proposal: &Value, index: usize) -> &Value {
    &proposal["relations"][index]
}

fn set_note(proposal: &mut Value, note: &str) {
    let relations = proposal["relations"].as_array_mut().expect("relations");
    for rel in relations {
        rel["note"] = json!(note);
    }
}

fn collect_id_and_note_strings(fixture: &Fixture) -> Vec<String> {
    let mut out = Vec::new();
    out.push(fixture.corpus_id.clone());
    for row in &fixture.identities {
        out.extend([
            row.candidate_id.clone(),
            row.claim_id.clone(),
            row.evidence_id.clone(),
            row.corpus_id.clone(),
        ]);
    }
    for row in &fixture.slots {
        out.extend([row.candidate_id.clone(), row.claim_id.clone()]);
    }
    out.extend(fixture.recovery_evidence_ids.iter().cloned());
    out.extend(fixture.unrelated_evidence_ids.iter().cloned());
    out.extend(fixture.decoy_evidence_ids.iter().cloned());
    if let Some(relations) = fixture.proposal["relations"].as_array() {
        for rel in relations {
            for key in ["candidate_id", "claim_id", "note"] {
                if let Some(s) = rel[key].as_str() {
                    out.push(s.to_string());
                }
            }
            if let Some(ids) = rel["evidence_ids"].as_array() {
                for id in ids {
                    if let Some(s) = id.as_str() {
                        out.push(s.to_string());
                    }
                }
            }
        }
    }
    out
}

#[test]
fn heldout_and_opaque_yield_the_same_kind_topology() {
    let held = load(HELDOUT);
    let opaque = load(OPAQUE);
    let held_kinds = kinds_of(&held.topology, &held.fixture.proposal);
    let opaque_kinds = kinds_of(&opaque.topology, &opaque.fixture.proposal);
    assert_eq!(held.fixture.proposal["schema"], CAUSAL_SYNTHESIS_SCHEMA_V1);
    assert_eq!(held_kinds, EXPECTED_KINDS);
    assert_eq!(opaque_kinds, EXPECTED_KINDS);
    assert_eq!(held_kinds, opaque_kinds);
}

#[test]
fn opaque_ids_and_notes_are_inert_and_disjoint_from_heldout() {
    let held = parse_fixture(HELDOUT);
    let opaque = parse_fixture(OPAQUE);
    let opaque_ids = collect_id_and_note_strings(&opaque);
    let held_ids: BTreeSet<_> = collect_id_and_note_strings(&held).into_iter().collect();
    for token in &opaque_ids {
        let lower = token.to_ascii_lowercase();
        for banned in BANNED {
            assert!(
                !lower.contains(banned),
                "opaque token {token:?} contains banned {banned:?}"
            );
        }
        assert!(
            !held_ids.contains(token) || token.is_empty(),
            "opaque token {token:?} collides with held-out vocabulary"
        );
    }
    let kind_set: BTreeSet<_> = KIND_WIRE.iter().copied().collect();
    for rel in opaque
        .proposal
        .get("relations")
        .and_then(Value::as_array)
        .expect("relations")
    {
        let kind = rel["kind"].as_str().expect("kind");
        assert!(kind_set.contains(kind), "unexpected kind {kind}");
    }
}

#[test]
fn claim_id_may_repeat_across_candidates_but_not_within_one() {
    let lab = load(OPAQUE);
    let value =
        validate_causal_synthesis(&proposal_str(&lab.fixture.proposal), &lab.topology).unwrap();
    let trigger = &value.relations[0];
    let unrelated = &value.relations[2];
    assert_eq!(trigger.claim_id, unrelated.claim_id);
    assert_ne!(trigger.candidate_id, unrelated.candidate_id);

    let mut dup = lab.fixture.proposal.clone();
    let first = dup["relations"][0].clone();
    dup["relations"].as_array_mut().unwrap().insert(1, first);
    assert_eq!(
        validate_causal_synthesis(&proposal_str(&dup), &lab.topology),
        Err(CausalSynthesisError::DuplicateId)
    );
}

#[test]
fn model_note_does_not_change_validation_or_host_truth() {
    let lab = load(OPAQUE);
    let baseline =
        validate_causal_synthesis(&proposal_str(&lab.fixture.proposal), &lab.topology).unwrap();
    let mut noisy = lab.fixture.proposal.clone();
    set_note(
        &mut noisy,
        "nzz99q claims this is the established initiating change",
    );
    let mutated = validate_causal_synthesis(&proposal_str(&noisy), &lab.topology).unwrap();
    let baseline_kinds: Vec<_> = baseline.relations.iter().map(|r| r.kind).collect();
    let mutated_kinds: Vec<_> = mutated.relations.iter().map(|r| r.kind).collect();
    assert_eq!(baseline_kinds, mutated_kinds);
    assert_eq!(baseline.schema, mutated.schema);
    assert_eq!(baseline.corpus_id, mutated.corpus_id);
    assert_ne!(
        baseline.relations[0].model_note,
        mutated.relations[0].model_note
    );
}

#[test]
fn validated_value_never_carries_root_cause_established() {
    for raw in [HELDOUT, OPAQUE] {
        let lab = load(raw);
        let value =
            validate_causal_synthesis(&proposal_str(&lab.fixture.proposal), &lab.topology).unwrap();
        let debug = format!("{value:?}");
        let encoded = serde_json::to_string(&value).expect("serialize validated value");
        assert!(!debug.contains("root_cause_established"));
        assert!(!encoded.contains("root_cause_established"));
    }
}

fn with_extra_slot(
    lab: &Lab,
    kind: CausalRelationKind,
    candidate: &str,
    claim: &str,
) -> HostCausalTopologyV1 {
    let mut slots: Vec<_> = lab
        .fixture
        .slots
        .iter()
        .map(|row| HostCausalSlotV1 {
            kind: row.kind,
            candidate_id: row.candidate_id.clone(),
            claim_id: row.claim_id.clone(),
        })
        .collect();
    slots.push(HostCausalSlotV1 {
        kind,
        candidate_id: candidate.to_string(),
        claim_id: claim.to_string(),
    });
    HostCausalTopologyV1::try_new(
        lab.fixture.corpus_id.clone(),
        lab.fixture.revision,
        lab.fixture
            .identities
            .iter()
            .map(|row| HostCausalIdentityV1 {
                candidate_id: row.candidate_id.clone(),
                claim_id: row.claim_id.clone(),
                evidence_id: row.evidence_id.clone(),
                corpus_id: row.corpus_id.clone(),
                revision: row.revision,
            })
            .collect(),
        slots,
        lab.fixture.required_kinds.clone(),
        HostCausalClassesV1 {
            recovery_evidence_ids: lab.fixture.recovery_evidence_ids.iter().cloned().collect(),
            unrelated_evidence_ids: lab.fixture.unrelated_evidence_ids.iter().cloned().collect(),
            decoy_evidence_ids: lab.fixture.decoy_evidence_ids.iter().cloned().collect(),
        },
    )
    .expect("topology with extra slot")
}

#[test]
fn mutation_matrix_fails_with_exact_typed_reasons() {
    let lab = load(HELDOUT);
    let trigger = rel(&lab.fixture.proposal, 0).clone();
    let unrelated = rel(&lab.fixture.proposal, 2).clone();
    let recovery = rel(&lab.fixture.proposal, 3).clone();
    let trigger_e = trigger["evidence_ids"][0].as_str().unwrap().to_string();
    let unrelated_e = unrelated["evidence_ids"][0].as_str().unwrap().to_string();
    let recovery_e = recovery["evidence_ids"][0].as_str().unwrap().to_string();
    let unrelated_c = unrelated["candidate_id"].as_str().unwrap().to_string();
    let unrelated_claim = unrelated["claim_id"].as_str().unwrap().to_string();
    let recovery_c = recovery["candidate_id"].as_str().unwrap().to_string();
    let recovery_claim = recovery["claim_id"].as_str().unwrap().to_string();

    let mut false_union = lab.fixture.proposal.clone();
    false_union["relations"][0]["candidate_id"] = json!("w99zz");

    let mut foreign = lab.fixture.proposal.clone();
    foreign["relations"][0]["evidence_ids"] = json!(["w00zz"]);

    let mut wrong_scope = lab.fixture.proposal.clone();
    wrong_scope["relations"][0]["evidence_ids"] = json!([unrelated_e]);

    let mut dup_evidence = lab.fixture.proposal.clone();
    dup_evidence["relations"][0]["evidence_ids"] = json!([trigger_e.clone(), trigger_e.clone()]);

    let mut dup_pair = lab.fixture.proposal.clone();
    let copy = dup_pair["relations"][0].clone();
    dup_pair["relations"]
        .as_array_mut()
        .unwrap()
        .insert(1, copy);

    let mut decoy = lab.fixture.proposal.clone();
    decoy["relations"][0]["candidate_id"] = json!(unrelated_c.clone());
    decoy["relations"][0]["claim_id"] = json!(unrelated_claim.clone());
    decoy["relations"][0]["evidence_ids"] = json!([unrelated_e.clone()]);
    decoy["relations"].as_array_mut().unwrap().remove(2);

    let mut recovery_as_cause = lab.fixture.proposal.clone();
    recovery_as_cause["relations"][0]["candidate_id"] = json!(recovery_c.clone());
    recovery_as_cause["relations"][0]["claim_id"] = json!(recovery_claim.clone());
    recovery_as_cause["relations"][0]["evidence_ids"] = json!([recovery_e]);
    recovery_as_cause["relations"]
        .as_array_mut()
        .unwrap()
        .remove(3);

    let mut omit_disproof = lab.fixture.proposal.clone();
    omit_disproof["relations"].as_array_mut().unwrap().pop();

    let mut cross = lab.fixture.proposal.clone();
    cross["relations"][0]["evidence_ids"] = json!(["w00e8"]);

    let mut stale = lab.fixture.proposal.clone();
    stale["relations"][0]["evidence_ids"] = json!(["w00e9"]);

    let mut frequency = lab.fixture.proposal.clone();
    frequency["relations"][0]["frequency"] = json!(9);

    let mut earlier = lab.fixture.proposal.clone();
    earlier["relations"][0]["earlier"] = json!(true);

    let decoy_topology = with_extra_slot(
        &lab,
        CausalRelationKind::InitiatingTrigger,
        &unrelated_c,
        &unrelated_claim,
    );
    let recovery_topology = with_extra_slot(
        &lab,
        CausalRelationKind::InitiatingTrigger,
        &recovery_c,
        &recovery_claim,
    );

    let cases: [(&str, &HostCausalTopologyV1, &Value, CausalSynthesisError); 12] = [
        (
            "false_union",
            &lab.topology,
            &false_union,
            CausalSynthesisError::FalseUnion,
        ),
        (
            "foreign_evidence",
            &lab.topology,
            &foreign,
            CausalSynthesisError::ForeignIdentity,
        ),
        (
            "wrong_scope",
            &lab.topology,
            &wrong_scope,
            CausalSynthesisError::WrongScope,
        ),
        (
            "duplicate_evidence",
            &lab.topology,
            &dup_evidence,
            CausalSynthesisError::DuplicateId,
        ),
        (
            "duplicate_candidate_claim",
            &lab.topology,
            &dup_pair,
            CausalSynthesisError::DuplicateId,
        ),
        (
            "decoy_promotion",
            &decoy_topology,
            &decoy,
            CausalSynthesisError::DecoyPromotion,
        ),
        (
            "recovery_as_cause",
            &recovery_topology,
            &recovery_as_cause,
            CausalSynthesisError::RecoveryAsCause,
        ),
        (
            "omitted_disproof",
            &lab.topology,
            &omit_disproof,
            CausalSynthesisError::MissingDisproof,
        ),
        (
            "cross_corpus",
            &lab.topology,
            &cross,
            CausalSynthesisError::CrossCorpus,
        ),
        (
            "wrong_revision",
            &lab.topology,
            &stale,
            CausalSynthesisError::WrongRevision,
        ),
        (
            "unknown_frequency",
            &lab.topology,
            &frequency,
            CausalSynthesisError::UnknownField,
        ),
        (
            "unknown_earlier",
            &lab.topology,
            &earlier,
            CausalSynthesisError::UnknownField,
        ),
    ];

    for (name, topology, proposal, expected) in cases {
        let got = validate_causal_synthesis(&proposal_str(proposal), topology);
        assert_eq!(got, Err(expected), "{name} must fail as {expected:?}");
    }
}

#[test]
fn fixtures_contain_no_credentials_or_evaluator_truth() {
    for raw in [HELDOUT, OPAQUE] {
        let lower = raw.to_ascii_lowercase();
        for needle in [
            "sk-",
            "akia",
            "bearer ",
            "password",
            "api_key",
            "evaluator",
            "gold-answer",
            "known truth",
        ] {
            assert!(!lower.contains(needle), "fixture leaked {needle}");
        }
    }
}
