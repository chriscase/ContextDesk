//! Replay ingest is source-neutral: mock output and imported JSON share one
//! recording path. This is not live execution.

mod common;

use cd_triage_bench::RunStatus;
use cd_triage_bench_adapter::{
    decode_replay_json, materialize_bounded_packet, project_share_safe, record_public_replay,
    record_run, run_deterministic_mock, run_offline, validate_public_replay, AdapterError,
};
use cd_triage_sdk::{TriageReplayV1, TriageRequestOverridesV1, TriageRunEventPayloadV2};

fn bound_fixture() -> (
    cd_triage_bench::Case,
    cd_triage_bench::EvidenceSnapshot,
    cd_triage_bench::EvaluationTask,
    cd_triage_bench_adapter::BoundedPacket,
    cd_triage_bench_adapter::BoundRequest,
) {
    let case = common::case();
    let snapshot = common::snapshot();
    let task = common::task(&snapshot);
    let bounded = materialize_bounded_packet(&case, &snapshot, &task).unwrap();
    let bound = cd_triage_bench_adapter::build_request(
        &snapshot,
        &task,
        &bounded,
        common::policy(),
        TriageRequestOverridesV1::default(),
        common::CANCELLATION_ID,
    )
    .unwrap();
    (case, snapshot, task, bounded, bound)
}

fn mock_replay() -> TriageReplayV1 {
    let (_, _, _, bounded, bound) = bound_fixture();
    run_deterministic_mock(&bound, &bounded, &common::plan_complete())
        .unwrap()
        .replay
}

#[test]
fn mock_recording_and_replay_recording_are_equivalent() {
    let (case, snapshot, task, bounded, bound) = bound_fixture();
    let context = common::context();
    let mock = run_offline(
        &case,
        &snapshot,
        &task,
        common::policy(),
        TriageRequestOverridesV1::default(),
        common::CANCELLATION_ID,
        &common::plan_complete(),
        &context,
    )
    .unwrap();
    let imported = record_public_replay(
        &case,
        &snapshot,
        &task,
        &bounded,
        &bound,
        mock.outcome.replay.clone(),
        &context,
    )
    .unwrap();
    assert_eq!(imported.owner_only, mock.recorded.owner_only);
    assert_eq!(imported.bench_run.run_id, mock.recorded.bench_run.run_id);
    assert_eq!(imported.raw_output, mock.recorded.raw_output);
    assert_eq!(imported.bench_run.status, RunStatus::Completed);
    assert!(matches!(
        imported.bench_run.cost,
        cd_triage_bench::Observed::Unknown
    ));
}

#[test]
fn completed_partial_failed_timed_out_and_cancelled_preserve_bench_status() {
    let (case, snapshot, task, bounded, bound) = bound_fixture();
    let context = common::context();
    let cases = [
        (common::plan_complete(), RunStatus::Completed),
        (common::plan_partial(), RunStatus::Partial),
        (common::plan_failed(), RunStatus::Failed),
        (common::plan_timed_out(), RunStatus::TimedOut),
        (common::plan_cancelled(), RunStatus::Cancelled),
    ];
    for (plan, expected) in cases {
        let mock = run_deterministic_mock(&bound, &bounded, &plan).unwrap();
        let recorded = record_public_replay(
            &case,
            &snapshot,
            &task,
            &bounded,
            &bound,
            mock.replay,
            &context,
        )
        .unwrap();
        assert_eq!(recorded.bench_run.status, expected);
        if expected == RunStatus::Failed || expected == RunStatus::TimedOut {
            assert!(
                recorded
                    .owner_only
                    .terminal
                    .partial_result_is_provenance_only
            );
        }
    }
}

#[test]
fn malformed_replay_is_rejected_by_the_real_validator() {
    let (_, _, _, _, bound) = bound_fixture();
    let bytes = std::fs::read(common::fixtures_dir().join("replay.bad-sequence.invalid.json"))
        .expect("fixture");
    let replay = decode_replay_json(&bytes).unwrap();
    let error = validate_public_replay(replay, &bound).unwrap_err();
    assert!(matches!(error, AdapterError::Contract(_)));
}

#[test]
fn decode_rejects_non_replay_json() {
    let error = decode_replay_json(br#"{"not":"a-replay"}"#).unwrap_err();
    assert_eq!(error, AdapterError::ReplayJson);
}

#[test]
fn mismatched_run_id_is_rejected() {
    let (_, _, _, _, bound) = bound_fixture();
    let mut replay = mock_replay();
    let forged = "cdrun-ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
    replay.run_id = forged.into();
    for event in &mut replay.events {
        event.run_id = forged.into();
        if let TriageRunEventPayloadV2::Completed { result }
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
        } = &mut event.event
        {
            result.run_id = forged.into();
        }
    }
    let error = validate_public_replay(replay, &bound).unwrap_err();
    assert!(matches!(error, AdapterError::IdentityMismatch(_)));
}

#[test]
fn mismatched_request_fingerprint_is_rejected() {
    let (_, _, _, _, bound) = bound_fixture();
    let mut replay = mock_replay();
    replay.request_fingerprint =
        "req-ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff".into();
    let error = validate_public_replay(replay, &bound).unwrap_err();
    assert!(
        matches!(error, AdapterError::Contract(_))
            || matches!(error, AdapterError::IdentityMismatch(_))
    );
}

#[test]
fn missing_model_is_rejected() {
    let (_, _, _, _, bound) = bound_fixture();
    let mut replay = mock_replay();
    for event in &mut replay.events {
        if let TriageRunEventPayloadV2::RoleAttempt { attempt } = &mut event.event {
            attempt.model = None;
            break;
        }
    }
    let error = validate_public_replay(replay, &bound).unwrap_err();
    assert!(matches!(error, AdapterError::IdentityMismatch(message) if message.contains("model")));
}

#[test]
fn missing_terminal_disposition_is_rejected() {
    let (_, _, _, _, bound) = bound_fixture();
    let mut replay = mock_replay();
    for event in &mut replay.events {
        if let TriageRunEventPayloadV2::RoleAttempt { attempt } = &mut event.event {
            attempt.terminal_disposition = None;
            break;
        }
    }
    let error = validate_public_replay(replay, &bound).unwrap_err();
    assert!(
        matches!(error, AdapterError::IdentityMismatch(message) if message.contains("disposition"))
    );
}

#[test]
fn differing_production_packet_fails_closed() {
    let (case, snapshot, task, bounded, bound) = bound_fixture();
    let replay = mock_replay();
    let mut foreign = bounded.clone();
    foreign.packet.packet_id =
        "pkt-ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff".into();
    foreign.packet_fingerprint =
        "pkf-ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff".into();
    let error = record_public_replay(
        &case,
        &snapshot,
        &task,
        &foreign,
        &bound,
        replay,
        &common::context(),
    )
    .unwrap_err();
    assert!(matches!(error, AdapterError::IdentityMismatch(_)));
}

#[test]
fn packet_ready_mismatch_fails_closed() {
    let (case, snapshot, task, bounded, bound) = bound_fixture();
    let mut replay = mock_replay();
    for event in &mut replay.events {
        if let TriageRunEventPayloadV2::PacketReady {
            packet_id,
            packet_digest,
            ..
        } = &mut event.event
        {
            *packet_id =
                "pkt-ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff".into();
            *packet_digest =
                "pkf-ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff".into();
        }
    }
    let error = record_public_replay(
        &case,
        &snapshot,
        &task,
        &bounded,
        &bound,
        replay,
        &common::context(),
    )
    .unwrap_err();
    assert!(matches!(error, AdapterError::IdentityMismatch(_)));
}

#[test]
fn ingested_replay_share_safe_projection_still_scans() {
    let (case, snapshot, task, bounded, bound) = bound_fixture();
    let recorded = record_public_replay(
        &case,
        &snapshot,
        &task,
        &bounded,
        &bound,
        mock_replay(),
        &common::context(),
    )
    .unwrap();
    let projection = project_share_safe(&snapshot, &task, &recorded).unwrap();
    assert!(!projection.model_fingerprints.is_empty());
    let encoded = serde_json::to_string(&projection).unwrap();
    assert!(cd_triage_sdk::scan_share_safe_text(&encoded).is_empty());
}

#[test]
fn record_run_requires_validated_replay_not_a_caller_assertion() {
    let (_, snapshot, task, bounded, bound) = bound_fixture();
    let replay = mock_replay();
    let outcome = validate_public_replay(replay, &bound).unwrap();
    record_run(
        &snapshot,
        &task,
        &bound,
        &bounded,
        &outcome,
        &common::context(),
    )
    .unwrap();
}
