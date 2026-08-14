//! Production-path regression tests for the host-side triage rubric.
//!
//! These tests call the exported production scorer directly (rather than the
//! quality-evaluation/lab scorer).  In particular, a valid trigger must not
//! mask a second candidate that promotes a host-identified downstream symptom
//! to a causal role.

use cd_core::log_analysis::SearchEvidenceIdentity;
use cd_core::triage_quality::{
    score_structured_triage_answer, StructuredTriageAnswer, TriageClaim, TriageHostFacts,
    TriageKnownAnswerKey,
};
use std::collections::BTreeSet;

fn known_key() -> TriageKnownAnswerKey {
    TriageKnownAnswerKey {
        case_id: "production-cardinality-regression".into(),
        time_quality_expected: "wall".into(),
        sources_present: vec!["svc/worker.log".into()],
        sources_omitted: Vec::new(),
        decoy_earliest_error_message_token: None,
        true_trigger_message_token: Some("LEASE_TRIGGER".into()),
        competing_trigger_message_tokens: Vec::new(),
        symptom_message_tokens: vec!["DOWNSTREAM_SYMPTOM".into()],
        root_cause_establishable: true,
        forbidden_claims: Vec::new(),
        required_disclosures: Vec::new(),
    }
}

fn host_facts() -> TriageHostFacts {
    let source = "svc/worker.log".to_string();
    TriageHostFacts {
        time_quality: "wall".into(),
        exact_event_count: 3,
        exact_error_count: Some(2),
        sources_present: BTreeSet::from([source.clone()]),
        evidence: (1..=3)
            .map(|seq| SearchEvidenceIdentity {
                seq,
                source: source.clone(),
                citation_source: None,
                template_id: seq,
            })
            .collect(),
        messages_by_seq: vec![
            (1, source.clone(), "startup complete".into()),
            (2, source.clone(), "LEASE_TRIGGER lease refused".into()),
            (3, source, "DOWNSTREAM_SYMPTOM task failed".into()),
        ],
        ..TriageHostFacts::default()
    }
}

fn valid_answer() -> StructuredTriageAnswer {
    StructuredTriageAnswer {
        observations: vec![TriageClaim {
            text: "The lease refusal was recorded".into(),
            seq: Some(2),
            source: Some("svc/worker.log".into()),
            role: Some("observation".into()),
        }],
        causal_candidates: vec![TriageClaim {
            text: "lease refusal is the initiating trigger".into(),
            seq: Some(2),
            source: Some("svc/worker.log".into()),
            role: Some("trigger".into()),
        }],
        competing_explanations: vec!["A transient worker restart remains possible".into()],
        confidence: "medium".into(),
        confidence_reason: "the trigger is cited; follow-up evidence remains useful".into(),
        missing_or_next_evidence: vec!["worker retry configuration".into()],
        asserted_event_count: Some(3),
        ..StructuredTriageAnswer::default()
    }
}

#[test]
fn production_scorer_rejects_promoted_symptom_with_a_valid_trigger_present() {
    let mut answer = valid_answer();
    answer.causal_candidates.push(TriageClaim {
        text: "downstream symptom task failed".into(),
        seq: Some(3),
        source: Some("svc/worker.log".into()),
        role: Some("trigger".into()),
    });

    let score = score_structured_triage_answer(&answer, &known_key(), &host_facts());
    assert!(
        score.failed_ids().contains(&"symptom_vs_cause"),
        "a valid trigger must not mask a promoted symptom: {:?}",
        score.dimensions
    );
    assert!(
        score
            .dimensions
            .iter()
            .find(|dimension| dimension.id == "trigger_identification")
            .is_some_and(|dimension| dimension.passed),
        "the genuine trigger should remain independently valid: {:?}",
        score.dimensions
    );
}

#[test]
fn production_scorer_keeps_safe_symptom_role_and_single_trigger_green() {
    let key = known_key();
    let host = host_facts();

    let single = score_structured_triage_answer(&valid_answer(), &key, &host);
    assert!(
        single.passed,
        "valid single-trigger answer failed: {:?}",
        single.dimensions
    );

    let mut answer = valid_answer();
    answer.causal_candidates.push(TriageClaim {
        text: "downstream symptom task failed".into(),
        seq: Some(3),
        source: Some("svc/worker.log".into()),
        role: Some("symptom".into()),
    });
    let safe = score_structured_triage_answer(&answer, &key, &host);
    assert!(
        safe.passed,
        "an explicitly marked symptom remains safe alongside a trigger: {:?}",
        safe.dimensions
    );
}
