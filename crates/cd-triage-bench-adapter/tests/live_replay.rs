//! A live host packet is bound by provenance, never by pretending its packet
//! identity equals the source-neutral benchmark packet.

mod common;

use cd_triage_bench::{FairnessClass, RunStatus};
use cd_triage_bench_adapter::{
    build_live_request, materialize_bounded_packet, project_share_safe, record_live_public_replay,
    run_deterministic_mock, AdapterError, ExecutionPacketState, HostExecutionProof,
    HostPacketEvidenceBinding, HostSourceBinding,
};
use cd_triage_sdk::{
    LogSnapshotRevisionV1, PacketPrivacyBoundary, TriageAttemptStatus, TriageReplayV1,
    TriageRequestOverridesV1, TriageRoleAttemptV1, TriageRunEventPayloadV2, TriageRunEventV2,
    TriageSlotKindV2, TriageTerminalDispositionV1, TRIAGE_REPLAY_SCHEMA_V1,
    TRIAGE_RUN_EVENT_SCHEMA_V2,
};

const LIVE_CORPUS: &str = "019c1234-5678-7000-8000-000000000001";
const LIVE_PACKET: &str = "packet-live-1";
const LIVE_PACKET_DIGEST: &str =
    "sha256:1111111111111111111111111111111111111111111111111111111111111111";
const LIVE_LEDGER_DIGEST: &str = LIVE_PACKET_DIGEST;

fn live_fixture() -> (
    cd_triage_bench::Case,
    cd_triage_bench::EvidenceSnapshot,
    cd_triage_bench::EvaluationTask,
    cd_triage_bench_adapter::BoundedPacket,
    cd_triage_bench_adapter::BoundRequest,
    TriageReplayV1,
    HostExecutionProof,
) {
    let case = common::case();
    let snapshot = common::snapshot();
    let task = common::task_with_visibility(&snapshot, vec!["ev-log-1".into()]);
    let bounded = materialize_bounded_packet(&case, &snapshot, &task).unwrap();
    let bound = build_live_request(
        &snapshot,
        &task,
        &bounded,
        LIVE_CORPUS,
        1,
        common::policy(),
        TriageRequestOverridesV1::default(),
        common::CANCELLATION_ID,
    )
    .unwrap();
    assert!(bound.request.scope.source_ids.is_empty());

    let mut replay = run_deterministic_mock(&bound, &bounded, &common::plan_complete())
        .unwrap()
        .replay;
    let revision = LogSnapshotRevisionV1 {
        event_revision: 1,
        template_analysis_revision: 2,
        suppression_revision: 3,
    };
    for event in &mut replay.events {
        match &mut event.event {
            TriageRunEventPayloadV2::PacketReady {
                packet_id,
                packet_digest,
                evidence_count,
            } => {
                *packet_id = LIVE_PACKET.into();
                *packet_digest = LIVE_PACKET_DIGEST.into();
                *evidence_count = 1;
            }
            TriageRunEventPayloadV2::Completed { result }
            | TriageRunEventPayloadV2::Failed {
                partial_result: Some(result),
                ..
            }
            | TriageRunEventPayloadV2::TimedOut {
                partial_result: Some(result),
                ..
            }
            | TriageRunEventPayloadV2::Cancelled {
                partial_result: Some(result),
                ..
            } => {
                result.packet_id = LIVE_PACKET.into();
                let answer = result.answer.as_mut().expect("complete mock answer");
                answer.binding.corpus_id = LIVE_CORPUS.into();
                answer.binding.revision = revision;
                answer.binding.ledger_digest = LIVE_LEDGER_DIGEST.into();
                for row in &mut answer.evidence {
                    row.source_label = "bench-0000-ev-log-1.log".into();
                    row.corpus_id = LIVE_CORPUS.into();
                    row.revision = revision;
                }
                for citation in &mut answer.answer.canonical_citations {
                    citation.source_label = "bench-0000-ev-log-1.log".into();
                    citation.corpus_id = LIVE_CORPUS.into();
                    citation.revision = revision;
                }
            }
            _ => {}
        }
    }
    replay.validate().expect("production-shaped replay");

    let content = bounded.packet.evidence[0]
        .content
        .as_ref()
        .expect("held log bytes");
    let proof = HostExecutionProof {
        packet_id: LIVE_PACKET.into(),
        packet_digest: LIVE_PACKET_DIGEST.into(),
        policy_fingerprint: replay
            .events
            .first()
            .and_then(|event| match &event.event {
                cd_triage_sdk::TriageRunEventPayloadV2::RunStarted {
                    policy_fingerprint, ..
                } => Some(policy_fingerprint.clone()),
                _ => None,
            })
            .expect("RunStarted policy fingerprint"),
        evidence_count: 1,
        corpus_id: LIVE_CORPUS.into(),
        corpus_revision: 1,
        snapshot_revision: revision,
        ledger_digest: LIVE_LEDGER_DIGEST.into(),
        sources: vec![HostSourceBinding {
            source_label: "bench-0000-ev-log-1.log".into(),
            evidence_item_id: "ev-log-1".into(),
            content_digest: content.digest.wire(),
            byte_length: content.byte_length,
        }],
        packet_evidence: vec![HostPacketEvidenceBinding {
            evidence_id: replay
                .events
                .iter()
                .find_map(|event| match &event.event {
                    TriageRunEventPayloadV2::Completed { result } => result
                        .answer
                        .as_ref()
                        .and_then(|answer| answer.evidence.first())
                        .map(|row| row.evidence_id.clone()),
                    _ => None,
                })
                .expect("host evidence id"),
            source_label: "bench-0000-ev-log-1.log".into(),
        }],
        packet_source_labels: vec!["bench-0000-ev-log-1.log".into()],
    };
    (case, snapshot, task, bounded, bound, replay, proof)
}

#[test]
fn live_packet_records_same_snapshot_with_mapped_citations() {
    let (case, snapshot, task, bounded, bound, replay, proof) = live_fixture();
    let recorded = record_live_public_replay(
        &case,
        &snapshot,
        &task,
        &bounded,
        &bound,
        replay,
        Some(proof.clone()),
        &common::context(),
    )
    .unwrap();

    assert_eq!(recorded.bench_run.fairness, FairnessClass::SameSnapshot);
    assert_eq!(recorded.bench_run.status, RunStatus::Completed);
    assert_eq!(
        recorded.owner_only.execution_packet_state,
        ExecutionPacketState::Matched
    );
    assert_eq!(recorded.owner_only.host_execution, Some(proof));
    assert!(!recorded.bench_run.claims.is_empty());
    assert!(recorded
        .bench_run
        .claims
        .iter()
        .all(|claim| claim.evidence_item_id.as_deref() == Some("ev-log-1")));
    let share_safe = project_share_safe(&snapshot, &task, &recorded).unwrap();
    assert!(share_safe.executed_policy_fingerprint.is_none());
    assert!(share_safe.host_execution_fingerprint.is_some());
    assert!(
        cd_triage_sdk::scan_share_safe_text(&serde_json::to_string(&share_safe).unwrap())
            .is_empty()
    );
}

#[test]
fn live_packet_requires_proof_and_exact_import_digest() {
    let (case, snapshot, task, bounded, bound, replay, mut proof) = live_fixture();
    let missing = record_live_public_replay(
        &case,
        &snapshot,
        &task,
        &bounded,
        &bound,
        replay.clone(),
        None,
        &common::context(),
    )
    .unwrap_err();
    assert!(matches!(missing, AdapterError::IdentityMismatch(_)));

    let mut wrong_policy = proof.clone();
    wrong_policy.policy_fingerprint = "sha256:wrong-policy".into();
    let mismatched = record_live_public_replay(
        &case,
        &snapshot,
        &task,
        &bounded,
        &bound,
        replay.clone(),
        Some(wrong_policy),
        &common::context(),
    )
    .unwrap_err();
    assert!(matches!(mismatched, AdapterError::IdentityMismatch(_)));

    let mut wrong_evidence = proof.clone();
    wrong_evidence.packet_evidence[0].evidence_id = "e:forged".into();
    let mismatched = record_live_public_replay(
        &case,
        &snapshot,
        &task,
        &bounded,
        &bound,
        replay.clone(),
        Some(wrong_evidence),
        &common::context(),
    )
    .unwrap_err();
    assert!(matches!(mismatched, AdapterError::IdentityMismatch(_)));

    let mut wrong_citation_content = replay.clone();
    if let TriageRunEventPayloadV2::Completed { result } =
        &mut wrong_citation_content.events.last_mut().unwrap().event
    {
        result.answer.as_mut().unwrap().answer.canonical_citations[0].content = "tampered".into();
    }
    let mismatched = record_live_public_replay(
        &case,
        &snapshot,
        &task,
        &bounded,
        &bound,
        wrong_citation_content,
        Some(proof.clone()),
        &common::context(),
    )
    .unwrap_err();
    assert!(matches!(mismatched, AdapterError::IdentityMismatch(_)));

    let mut missing_citation = replay.clone();
    if let TriageRunEventPayloadV2::Completed { result } =
        &mut missing_citation.events.last_mut().unwrap().event
    {
        result
            .answer
            .as_mut()
            .unwrap()
            .answer
            .canonical_citations
            .clear();
    }
    let mismatched = record_live_public_replay(
        &case,
        &snapshot,
        &task,
        &bounded,
        &bound,
        missing_citation,
        Some(proof.clone()),
        &common::context(),
    )
    .unwrap_err();
    assert!(matches!(mismatched, AdapterError::IdentityMismatch(_)));

    proof.sources[0].content_digest =
        "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff".into();
    let mismatched = record_live_public_replay(
        &case,
        &snapshot,
        &task,
        &bounded,
        &bound,
        replay,
        Some(proof),
        &common::context(),
    )
    .unwrap_err();
    assert!(matches!(mismatched, AdapterError::IdentityMismatch(_)));
}

#[test]
fn live_pre_packet_failure_records_without_inventing_host_proof() {
    let (case, snapshot, task, bounded, bound, _, _) = live_fixture();
    let event = |sequence, event| TriageRunEventV2 {
        schema_id: TRIAGE_RUN_EVENT_SCHEMA_V2.into(),
        run_id: bound.sdk_run_id.clone(),
        sequence,
        privacy: PacketPrivacyBoundary::OwnerOnly,
        event,
    };
    let replay = TriageReplayV1 {
        schema_id: TRIAGE_REPLAY_SCHEMA_V1.into(),
        run_id: bound.sdk_run_id.clone(),
        request_fingerprint: bound.request_fingerprint.clone(),
        events: vec![
            event(
                0,
                TriageRunEventPayloadV2::RunStarted {
                    request_fingerprint: bound.request_fingerprint.clone(),
                    policy_fingerprint: bound.policy_fingerprint.clone(),
                },
            ),
            event(
                1,
                TriageRunEventPayloadV2::RoleAttempt {
                    attempt: TriageRoleAttemptV1 {
                        attempt_id: "attempt:preflight:finalizer".into(),
                        role_slot_id: "finalize".into(),
                        role: TriageSlotKindV2::Finalizer,
                        model: None,
                        status: TriageAttemptStatus::NotAdmitted,
                        reason_codes: vec!["policy_preflight_rejected".into()],
                        elapsed_ms: 0,
                        input_chars: 0,
                        output_chars: 0,
                        physical_provider_calls: Some(0),
                        semantic_corrections: Some(0),
                        terminal_disposition: Some(TriageTerminalDispositionV1::NotAdmitted),
                    },
                },
            ),
            event(
                2,
                TriageRunEventPayloadV2::Failed {
                    category: "policy_preflight_rejected".into(),
                    partial_result: None,
                },
            ),
        ],
    };

    let recorded = record_live_public_replay(
        &case,
        &snapshot,
        &task,
        &bounded,
        &bound,
        replay,
        None,
        &common::context(),
    )
    .unwrap();
    assert_eq!(recorded.bench_run.status, RunStatus::Failed);
    assert_eq!(
        recorded.owner_only.execution_packet_state,
        ExecutionPacketState::NotProduced
    );
    assert!(recorded.owner_only.host_execution.is_none());
}
