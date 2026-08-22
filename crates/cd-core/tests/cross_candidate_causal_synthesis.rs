//! Behavioural proof for host-bounded cross-candidate causal synthesis.
//!
//! Every assertion drives [`cd_core::multi_model::validate_causal_synthesis`]
//! on the shipped types. Tokens are opaque (`k1`, `e:k1:1`) so incident words
//! and fixture aliases cannot pass the gates. This file does not call
//! providers, the live pipeline, or `root_cause_established`.

use std::collections::BTreeSet;

use cd_core::investigation_answer::LogSnapshotRevisionV1;
use cd_core::multi_model::{
    validate_causal_synthesis, CausalRelationKind, CausalSynthesisError, HostCausalClassesV1,
    HostCausalIdentityV1, HostCausalSlotV1, HostCausalTopologyV1, CAUSAL_SYNTHESIS_SCHEMA_V1,
};

fn revision() -> LogSnapshotRevisionV1 {
    LogSnapshotRevisionV1 {
        event_revision: 4,
        template_analysis_revision: 2,
        suppression_revision: 1,
    }
}

fn other_revision() -> LogSnapshotRevisionV1 {
    LogSnapshotRevisionV1 {
        event_revision: 99,
        template_analysis_revision: 2,
        suppression_revision: 1,
    }
}

struct Vocab {
    corpus: &'static str,
    trigger_c: &'static str,
    symptom_c: &'static str,
    unrelated_c: &'static str,
    trigger_claim: &'static str,
    symptom_claim: &'static str,
    unrelated_claim: &'static str,
    recovery_claim: &'static str,
    disproof_claim: &'static str,
    trigger_e: &'static str,
    symptom_e: &'static str,
    unrelated_e: &'static str,
    recovery_e: &'static str,
    disproof_e: &'static str,
}

const K: Vocab = Vocab {
    corpus: "cx",
    trigger_c: "k1",
    symptom_c: "k1",
    unrelated_c: "k2",
    trigger_claim: "c:k1:t",
    symptom_claim: "c:k1:s",
    unrelated_claim: "c:k2:u",
    recovery_claim: "c:k1:r",
    disproof_claim: "c:k2:d",
    trigger_e: "e:k1:1",
    symptom_e: "e:k1:2",
    unrelated_e: "e:k2:1",
    recovery_e: "e:k1:3",
    disproof_e: "e:k2:2",
};

const P: Vocab = Vocab {
    corpus: "cx",
    trigger_c: "p1",
    symptom_c: "p1",
    unrelated_c: "p2",
    trigger_claim: "c:p1:t",
    symptom_claim: "c:p1:s",
    unrelated_claim: "c:p2:u",
    recovery_claim: "c:p1:r",
    disproof_claim: "c:p2:d",
    trigger_e: "e:p1:1",
    symptom_e: "e:p1:2",
    unrelated_e: "e:p2:1",
    recovery_e: "e:p1:3",
    disproof_e: "e:p2:2",
};

fn identity(
    candidate_id: &str,
    claim_id: &str,
    evidence_id: &str,
    corpus_id: &str,
    revision: LogSnapshotRevisionV1,
) -> HostCausalIdentityV1 {
    HostCausalIdentityV1 {
        candidate_id: candidate_id.to_string(),
        claim_id: claim_id.to_string(),
        evidence_id: evidence_id.to_string(),
        corpus_id: corpus_id.to_string(),
        revision,
    }
}

fn slot(kind: CausalRelationKind, candidate_id: &str, claim_id: &str) -> HostCausalSlotV1 {
    HostCausalSlotV1 {
        kind,
        candidate_id: candidate_id.to_string(),
        claim_id: claim_id.to_string(),
    }
}

fn required_kinds() -> Vec<CausalRelationKind> {
    vec![
        CausalRelationKind::InitiatingTrigger,
        CausalRelationKind::PropagatedSymptom,
        CausalRelationKind::UnrelatedCompeting,
        CausalRelationKind::Recovery,
        CausalRelationKind::Disconfirmation,
    ]
}

fn classes(v: &Vocab) -> HostCausalClassesV1 {
    HostCausalClassesV1 {
        recovery_evidence_ids: BTreeSet::from([v.recovery_e.to_string()]),
        unrelated_evidence_ids: BTreeSet::from([v.unrelated_e.to_string()]),
        decoy_evidence_ids: BTreeSet::from([v.unrelated_e.to_string()]),
    }
}

fn bounded_topology(v: &Vocab) -> HostCausalTopologyV1 {
    HostCausalTopologyV1::try_new(
        v.corpus,
        revision(),
        vec![
            identity(
                v.trigger_c,
                v.trigger_claim,
                v.trigger_e,
                v.corpus,
                revision(),
            ),
            identity(
                v.symptom_c,
                v.symptom_claim,
                v.symptom_e,
                v.corpus,
                revision(),
            ),
            identity(
                v.unrelated_c,
                v.unrelated_claim,
                v.unrelated_e,
                v.corpus,
                revision(),
            ),
            identity(
                v.trigger_c,
                v.recovery_claim,
                v.recovery_e,
                v.corpus,
                revision(),
            ),
            identity(
                v.unrelated_c,
                v.disproof_claim,
                v.disproof_e,
                v.corpus,
                revision(),
            ),
        ],
        vec![
            slot(
                CausalRelationKind::InitiatingTrigger,
                v.trigger_c,
                v.trigger_claim,
            ),
            slot(
                CausalRelationKind::PropagatedSymptom,
                v.symptom_c,
                v.symptom_claim,
            ),
            slot(
                CausalRelationKind::UnrelatedCompeting,
                v.unrelated_c,
                v.unrelated_claim,
            ),
            slot(CausalRelationKind::Recovery, v.trigger_c, v.recovery_claim),
            slot(
                CausalRelationKind::Disconfirmation,
                v.unrelated_c,
                v.disproof_claim,
            ),
        ],
        required_kinds(),
        classes(v),
    )
    .expect("bounded topology")
}

fn relation(
    kind: &str,
    candidate_id: &str,
    claim_id: &str,
    evidence_id: &str,
    note: &str,
) -> String {
    format!(
        r#"{{"kind":"{kind}","candidate_id":"{candidate_id}","claim_id":"{claim_id}","evidence_ids":["{evidence_id}"],"note":"{note}"}}"#
    )
}

fn proposal(v: &Vocab, extra: &[String]) -> String {
    let mut rels = vec![
        relation(
            "initiating_trigger",
            v.trigger_c,
            v.trigger_claim,
            v.trigger_e,
            "model prose is not host truth",
        ),
        relation(
            "propagated_symptom",
            v.symptom_c,
            v.symptom_claim,
            v.symptom_e,
            "",
        ),
        relation(
            "unrelated_competing",
            v.unrelated_c,
            v.unrelated_claim,
            v.unrelated_e,
            "",
        ),
        relation("recovery", v.trigger_c, v.recovery_claim, v.recovery_e, ""),
        relation(
            "disconfirmation",
            v.unrelated_c,
            v.disproof_claim,
            v.disproof_e,
            "",
        ),
    ];
    rels.extend(extra.iter().cloned());
    format!(
        r#"{{"schema":"{CAUSAL_SYNTHESIS_SCHEMA_V1}","relations":[{}]}}"#,
        rels.join(",")
    )
}

fn proposal_without(v: &Vocab, skip_kind: &str) -> String {
    let kinds = [
        (
            "initiating_trigger",
            v.trigger_c,
            v.trigger_claim,
            v.trigger_e,
        ),
        (
            "propagated_symptom",
            v.symptom_c,
            v.symptom_claim,
            v.symptom_e,
        ),
        (
            "unrelated_competing",
            v.unrelated_c,
            v.unrelated_claim,
            v.unrelated_e,
        ),
        ("recovery", v.trigger_c, v.recovery_claim, v.recovery_e),
        (
            "disconfirmation",
            v.unrelated_c,
            v.disproof_claim,
            v.disproof_e,
        ),
    ];
    let rels: Vec<String> = kinds
        .into_iter()
        .filter(|(kind, _, _, _)| *kind != skip_kind)
        .map(|(kind, c, claim, e)| relation(kind, c, claim, e, ""))
        .collect();
    format!(
        r#"{{"schema":"{CAUSAL_SYNTHESIS_SCHEMA_V1}","relations":[{}]}}"#,
        rels.join(",")
    )
}

fn assert_valid(v: &Vocab) {
    let topology = bounded_topology(v);
    let value = validate_causal_synthesis(&proposal(v, &[]), &topology).expect("valid topology");
    assert_eq!(value.schema, CAUSAL_SYNTHESIS_SCHEMA_V1);
    assert_eq!(value.corpus_id, v.corpus);
    let kinds: Vec<_> = value.relations.iter().map(|r| r.kind).collect();
    assert_eq!(
        kinds,
        vec![
            CausalRelationKind::InitiatingTrigger,
            CausalRelationKind::PropagatedSymptom,
            CausalRelationKind::UnrelatedCompeting,
            CausalRelationKind::Recovery,
            CausalRelationKind::Disconfirmation,
        ]
    );
    assert_eq!(value.relations[0].candidate_id, v.trigger_c);
    assert_eq!(value.relations[2].evidence_ids, vec![v.unrelated_e]);
    let debug = format!("{value:?}");
    assert!(
        !debug.contains("root_cause_established"),
        "validated value must not claim establishment"
    );
    assert!(value.relations[0].model_note.contains("not host truth"));
}

#[test]
fn valid_bounded_topology_accepts_distinct_relationship_kinds() {
    assert_valid(&K);
}

#[test]
fn held_out_opaque_vocabulary_yields_the_same_topology() {
    assert_valid(&K);
    assert_valid(&P);
    let k = validate_causal_synthesis(&proposal(&K, &[]), &bounded_topology(&K)).unwrap();
    let p = validate_causal_synthesis(&proposal(&P, &[]), &bounded_topology(&P)).unwrap();
    assert_eq!(
        k.relations.iter().map(|r| r.kind).collect::<Vec<_>>(),
        p.relations.iter().map(|r| r.kind).collect::<Vec<_>>()
    );
}

#[test]
fn unknown_fields_and_chronology_frequency_fail_closed() {
    let topology = bounded_topology(&K);
    let with_leak = proposal(&K, &[]).replacen(r#""schema":"#, r#""leak":true,"schema":"#, 1);
    assert_eq!(
        validate_causal_synthesis(&with_leak, &topology),
        Err(CausalSynthesisError::UnknownField)
    );
    let with_frequency = relation(
        "initiating_trigger",
        K.trigger_c,
        K.trigger_claim,
        K.trigger_e,
        "",
    )
    .replacen('{', r#"{"frequency":9,"#, 1);
    let raw =
        format!(r#"{{"schema":"{CAUSAL_SYNTHESIS_SCHEMA_V1}","relations":[{with_frequency}]}}"#);
    assert_eq!(
        validate_causal_synthesis(&raw, &topology),
        Err(CausalSynthesisError::UnknownField)
    );
}

#[test]
fn false_union_of_an_unadmitted_candidate_fails() {
    let topology = bounded_topology(&K);
    let extra = relation("initiating_trigger", "k9", "c:k9:t", "e:k9:1", "");
    assert_eq!(
        validate_causal_synthesis(&proposal(&K, &[extra]), &topology),
        Err(CausalSynthesisError::FalseUnion)
    );
}

#[test]
fn decoy_promotion_of_unrelated_evidence_to_trigger_fails() {
    let v = &K;
    let mut slots = vec![
        slot(
            CausalRelationKind::InitiatingTrigger,
            v.trigger_c,
            v.trigger_claim,
        ),
        slot(
            CausalRelationKind::PropagatedSymptom,
            v.symptom_c,
            v.symptom_claim,
        ),
        slot(
            CausalRelationKind::UnrelatedCompeting,
            v.unrelated_c,
            v.unrelated_claim,
        ),
        slot(CausalRelationKind::Recovery, v.trigger_c, v.recovery_claim),
        slot(
            CausalRelationKind::Disconfirmation,
            v.unrelated_c,
            v.disproof_claim,
        ),
        slot(
            CausalRelationKind::InitiatingTrigger,
            v.unrelated_c,
            v.unrelated_claim,
        ),
    ];
    let topology = HostCausalTopologyV1::try_new(
        v.corpus,
        revision(),
        vec![
            identity(
                v.trigger_c,
                v.trigger_claim,
                v.trigger_e,
                v.corpus,
                revision(),
            ),
            identity(
                v.symptom_c,
                v.symptom_claim,
                v.symptom_e,
                v.corpus,
                revision(),
            ),
            identity(
                v.unrelated_c,
                v.unrelated_claim,
                v.unrelated_e,
                v.corpus,
                revision(),
            ),
            identity(
                v.trigger_c,
                v.recovery_claim,
                v.recovery_e,
                v.corpus,
                revision(),
            ),
            identity(
                v.unrelated_c,
                v.disproof_claim,
                v.disproof_e,
                v.corpus,
                revision(),
            ),
        ],
        slots.split_off(0),
        required_kinds(),
        classes(v),
    )
    .unwrap();
    let raw = format!(
        r#"{{"schema":"{CAUSAL_SYNTHESIS_SCHEMA_V1}","relations":[{},{},{},{}]}}"#,
        relation(
            "initiating_trigger",
            v.unrelated_c,
            v.unrelated_claim,
            v.unrelated_e,
            "earlier and more frequent"
        ),
        relation(
            "propagated_symptom",
            v.symptom_c,
            v.symptom_claim,
            v.symptom_e,
            ""
        ),
        relation("recovery", v.trigger_c, v.recovery_claim, v.recovery_e, ""),
        relation(
            "disconfirmation",
            v.unrelated_c,
            v.disproof_claim,
            v.disproof_e,
            ""
        ),
    );
    assert_eq!(
        validate_causal_synthesis(&raw, &topology),
        Err(CausalSynthesisError::DecoyPromotion)
    );
}

#[test]
fn recovery_cannot_become_cause() {
    let v = &K;
    let topology = HostCausalTopologyV1::try_new(
        v.corpus,
        revision(),
        vec![
            identity(
                v.trigger_c,
                v.trigger_claim,
                v.trigger_e,
                v.corpus,
                revision(),
            ),
            identity(
                v.symptom_c,
                v.symptom_claim,
                v.symptom_e,
                v.corpus,
                revision(),
            ),
            identity(
                v.unrelated_c,
                v.unrelated_claim,
                v.unrelated_e,
                v.corpus,
                revision(),
            ),
            identity(
                v.trigger_c,
                v.recovery_claim,
                v.recovery_e,
                v.corpus,
                revision(),
            ),
            identity(
                v.unrelated_c,
                v.disproof_claim,
                v.disproof_e,
                v.corpus,
                revision(),
            ),
        ],
        vec![
            slot(
                CausalRelationKind::InitiatingTrigger,
                v.trigger_c,
                v.recovery_claim,
            ),
            slot(
                CausalRelationKind::PropagatedSymptom,
                v.symptom_c,
                v.symptom_claim,
            ),
            slot(
                CausalRelationKind::UnrelatedCompeting,
                v.unrelated_c,
                v.unrelated_claim,
            ),
            slot(CausalRelationKind::Recovery, v.trigger_c, v.recovery_claim),
            slot(
                CausalRelationKind::Disconfirmation,
                v.unrelated_c,
                v.disproof_claim,
            ),
        ],
        required_kinds(),
        HostCausalClassesV1 {
            recovery_evidence_ids: BTreeSet::from([v.recovery_e.to_string()]),
            unrelated_evidence_ids: BTreeSet::from([v.unrelated_e.to_string()]),
            decoy_evidence_ids: BTreeSet::new(),
        },
    )
    .unwrap();
    let raw = format!(
        r#"{{"schema":"{CAUSAL_SYNTHESIS_SCHEMA_V1}","relations":[{},{},{},{}]}}"#,
        relation(
            "initiating_trigger",
            v.trigger_c,
            v.recovery_claim,
            v.recovery_e,
            ""
        ),
        relation(
            "propagated_symptom",
            v.symptom_c,
            v.symptom_claim,
            v.symptom_e,
            ""
        ),
        relation(
            "unrelated_competing",
            v.unrelated_c,
            v.unrelated_claim,
            v.unrelated_e,
            ""
        ),
        relation(
            "disconfirmation",
            v.unrelated_c,
            v.disproof_claim,
            v.disproof_e,
            ""
        ),
    );
    assert_eq!(
        validate_causal_synthesis(&raw, &topology),
        Err(CausalSynthesisError::RecoveryAsCause)
    );
}

#[test]
fn foreign_evidence_on_an_admitted_slot_fails() {
    let v = &K;
    let topology = bounded_topology(v);
    let raw = format!(
        r#"{{"schema":"{CAUSAL_SYNTHESIS_SCHEMA_V1}","relations":[{}]}}"#,
        relation(
            "initiating_trigger",
            v.trigger_c,
            v.trigger_claim,
            "e:zz:1",
            ""
        )
    );
    assert_eq!(
        validate_causal_synthesis(&raw, &topology),
        Err(CausalSynthesisError::ForeignIdentity)
    );
}

#[test]
fn cross_corpus_and_wrong_revision_fail() {
    let v = &K;
    let mut identities = vec![
        identity(
            v.trigger_c,
            v.trigger_claim,
            v.trigger_e,
            v.corpus,
            revision(),
        ),
        identity(
            v.symptom_c,
            v.symptom_claim,
            v.symptom_e,
            v.corpus,
            revision(),
        ),
        identity(
            v.unrelated_c,
            v.unrelated_claim,
            v.unrelated_e,
            v.corpus,
            revision(),
        ),
        identity(
            v.trigger_c,
            v.recovery_claim,
            v.recovery_e,
            v.corpus,
            revision(),
        ),
        identity(
            v.unrelated_c,
            v.disproof_claim,
            v.disproof_e,
            v.corpus,
            revision(),
        ),
        identity(
            v.trigger_c,
            v.trigger_claim,
            "e:k1:x",
            "other-corpus",
            revision(),
        ),
        identity(
            v.trigger_c,
            v.trigger_claim,
            "e:k1:y",
            v.corpus,
            other_revision(),
        ),
    ];
    let topology = HostCausalTopologyV1::try_new(
        v.corpus,
        revision(),
        identities.split_off(0),
        vec![
            slot(
                CausalRelationKind::InitiatingTrigger,
                v.trigger_c,
                v.trigger_claim,
            ),
            slot(
                CausalRelationKind::PropagatedSymptom,
                v.symptom_c,
                v.symptom_claim,
            ),
            slot(
                CausalRelationKind::UnrelatedCompeting,
                v.unrelated_c,
                v.unrelated_claim,
            ),
            slot(CausalRelationKind::Recovery, v.trigger_c, v.recovery_claim),
            slot(
                CausalRelationKind::Disconfirmation,
                v.unrelated_c,
                v.disproof_claim,
            ),
        ],
        required_kinds(),
        HostCausalClassesV1 {
            recovery_evidence_ids: BTreeSet::from([v.recovery_e.to_string()]),
            unrelated_evidence_ids: BTreeSet::from([v.unrelated_e.to_string()]),
            decoy_evidence_ids: BTreeSet::new(),
        },
    )
    .unwrap();
    let cross = format!(
        r#"{{"schema":"{CAUSAL_SYNTHESIS_SCHEMA_V1}","relations":[{}]}}"#,
        relation(
            "initiating_trigger",
            v.trigger_c,
            v.trigger_claim,
            "e:k1:x",
            ""
        )
    );
    assert_eq!(
        validate_causal_synthesis(&cross, &topology),
        Err(CausalSynthesisError::CrossCorpus)
    );
    let stale = format!(
        r#"{{"schema":"{CAUSAL_SYNTHESIS_SCHEMA_V1}","relations":[{}]}}"#,
        relation(
            "initiating_trigger",
            v.trigger_c,
            v.trigger_claim,
            "e:k1:y",
            ""
        )
    );
    assert_eq!(
        validate_causal_synthesis(&stale, &topology),
        Err(CausalSynthesisError::WrongRevision)
    );
}

#[test]
fn shared_raw_claim_id_across_candidates_is_accepted() {
    let topology = HostCausalTopologyV1::try_new(
        "cx",
        revision(),
        vec![
            identity("k1", "same", "e:k1:1", "cx", revision()),
            identity("k1", "c:k1:s", "e:k1:2", "cx", revision()),
            identity("k2", "same", "e:k2:1", "cx", revision()),
            identity("k1", "c:k1:r", "e:k1:3", "cx", revision()),
            identity("k2", "c:k2:d", "e:k2:2", "cx", revision()),
        ],
        vec![
            slot(CausalRelationKind::InitiatingTrigger, "k1", "same"),
            slot(CausalRelationKind::PropagatedSymptom, "k1", "c:k1:s"),
            slot(CausalRelationKind::UnrelatedCompeting, "k2", "same"),
            slot(CausalRelationKind::Recovery, "k1", "c:k1:r"),
            slot(CausalRelationKind::Disconfirmation, "k2", "c:k2:d"),
        ],
        required_kinds(),
        HostCausalClassesV1 {
            recovery_evidence_ids: BTreeSet::from(["e:k1:3".to_string()]),
            unrelated_evidence_ids: BTreeSet::from(["e:k2:1".to_string()]),
            decoy_evidence_ids: BTreeSet::from(["e:k2:1".to_string()]),
        },
    )
    .expect("pair-keyed topology");
    let raw = format!(
        r#"{{"schema":"{CAUSAL_SYNTHESIS_SCHEMA_V1}","relations":[{},{},{},{},{}]}}"#,
        relation("initiating_trigger", "k1", "same", "e:k1:1", ""),
        relation("propagated_symptom", "k1", "c:k1:s", "e:k1:2", ""),
        relation("unrelated_competing", "k2", "same", "e:k2:1", ""),
        relation("recovery", "k1", "c:k1:r", "e:k1:3", ""),
        relation("disconfirmation", "k2", "c:k2:d", "e:k2:2", ""),
    );
    let value = validate_causal_synthesis(&raw, &topology).expect("shared claim_id is pair-keyed");
    assert_eq!(value.relations[0].candidate_id, "k1");
    assert_eq!(value.relations[0].claim_id, "same");
    assert_eq!(value.relations[2].candidate_id, "k2");
    assert_eq!(value.relations[2].claim_id, "same");
    assert_eq!(
        value.relations[0].kind,
        CausalRelationKind::InitiatingTrigger
    );
    assert_eq!(
        value.relations[2].kind,
        CausalRelationKind::UnrelatedCompeting
    );
}

#[test]
fn duplicate_identities_fail() {
    let topology = bounded_topology(&K);
    let dup_evidence = format!(
        r#"{{"kind":"initiating_trigger","candidate_id":"{}","claim_id":"{}","evidence_ids":["{}","{}"],"note":""}}"#,
        K.trigger_c, K.trigger_claim, K.trigger_e, K.trigger_e
    );
    let raw =
        format!(r#"{{"schema":"{CAUSAL_SYNTHESIS_SCHEMA_V1}","relations":[{dup_evidence}]}}"#);
    assert_eq!(
        validate_causal_synthesis(&raw, &topology),
        Err(CausalSynthesisError::DuplicateId)
    );
}

#[test]
fn missing_trigger_symptom_and_required_disproof_fail() {
    let topology = bounded_topology(&K);
    assert_eq!(
        validate_causal_synthesis(&proposal_without(&K, "initiating_trigger"), &topology),
        Err(CausalSynthesisError::MissingTrigger)
    );
    assert_eq!(
        validate_causal_synthesis(&proposal_without(&K, "propagated_symptom"), &topology),
        Err(CausalSynthesisError::MissingSymptom)
    );
    assert_eq!(
        validate_causal_synthesis(&proposal_without(&K, "disconfirmation"), &topology),
        Err(CausalSynthesisError::MissingDisproof)
    );
}

#[test]
fn unsafe_identity_and_wrong_scope_fail() {
    let topology = bounded_topology(&K);
    let unsafe_id = format!(
        r#"{{"schema":"{CAUSAL_SYNTHESIS_SCHEMA_V1}","relations":[{{"kind":"initiating_trigger","candidate_id":"k1","claim_id":"c:k1:t\n","evidence_ids":["e:k1:1"],"note":""}}]}}"#
    );
    assert_eq!(
        validate_causal_synthesis(&unsafe_id, &topology),
        Err(CausalSynthesisError::UnsafeIdentity)
    );
    let wrong_scope = format!(
        r#"{{"schema":"{CAUSAL_SYNTHESIS_SCHEMA_V1}","relations":[{}]}}"#,
        relation(
            "initiating_trigger",
            K.trigger_c,
            K.trigger_claim,
            K.unrelated_e,
            ""
        )
    );
    assert_eq!(
        validate_causal_synthesis(&wrong_scope, &topology),
        Err(CausalSynthesisError::WrongScope)
    );
}

#[test]
fn wrong_schema_fails() {
    let topology = bounded_topology(&K);
    let raw = proposal(&K, &[]).replace(CAUSAL_SYNTHESIS_SCHEMA_V1, "contextdesk.other.v1");
    assert_eq!(
        validate_causal_synthesis(&raw, &topology),
        Err(CausalSynthesisError::Schema)
    );
}
