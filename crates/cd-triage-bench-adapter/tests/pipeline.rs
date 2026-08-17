//! Hermetic end-to-end: snapshot -> packet -> request -> mock -> recorded run.
//!
//! Everything here is offline. No provider, no filesystem store, no clock.

mod common;

use cd_triage_bench::{FairnessClass, Observed, PrivacyClass, RunStatus, SourceKind};
use cd_triage_bench_adapter::{
    build_request, materialize_bounded_packet, run_offline, AdapterError,
};
use cd_triage_sdk::{
    PacketPrivacyBoundary, TriageRequestOverridesV1, TriageRunEventPayloadV2,
    TRIAGE_REQUEST_SCHEMA_V2,
};

fn run_complete() -> cd_triage_bench_adapter::AdapterRun {
    let case = common::case();
    let snapshot = common::snapshot();
    let task = common::task(&snapshot);
    run_offline(
        &case,
        &snapshot,
        &task,
        common::policy(),
        TriageRequestOverridesV1::default(),
        common::CANCELLATION_ID,
        &common::plan_complete(),
        &common::context(),
    )
    .expect("offline run")
}

#[test]
fn snapshot_to_packet_to_mock_to_owner_only_recorded_run() {
    let run = run_complete();

    // Packet is bounded to exactly the task's visible items.
    assert_eq!(run.bounded.evidence_count, 3);
    assert_eq!(
        run.bounded.visible_item_ids,
        vec!["ev-log-1", "ev-mail-1", "ev-ref-1"]
    );

    // The request is the real public DTO and is owner-only by contract.
    assert_eq!(run.bound.request.schema_id, TRIAGE_REQUEST_SCHEMA_V2);
    assert_eq!(run.bound.request.privacy, PacketPrivacyBoundary::OwnerOnly);
    run.bound.request.validate().expect("request validates");

    // The replay is accepted by the real public validator.
    run.outcome.replay.validate().expect("replay validates");
    assert!(matches!(
        run.outcome.terminal(),
        TriageRunEventPayloadV2::Completed { .. }
    ));

    // The recorded bench run is owner-only, ContextDesk-sourced, and complete.
    let bench_run = &run.recorded.bench_run;
    assert_eq!(bench_run.privacy, PrivacyClass::OwnerOnly);
    assert_eq!(bench_run.source_kind, SourceKind::ContextdeskSdk);
    assert_eq!(bench_run.status, RunStatus::Completed);
    assert_eq!(bench_run.case_id, common::CASE_ID);
    bench_run.validate().expect("bench run validates");
}

#[test]
fn recorded_run_is_same_snapshot_with_unknown_usage_and_cost() {
    let run = run_complete();
    let bench_run = &run.recorded.bench_run;

    // Fairness is same_snapshot by construction, and the packet identity in
    // the record is what proves it.
    assert_eq!(bench_run.fairness, FairnessClass::SameSnapshot);
    assert_eq!(bench_run.snapshot_id, run.bounded.packet.snapshot_id);
    assert_eq!(
        run.recorded.owner_only.fingerprints.packet,
        run.bounded.packet_fingerprint
    );

    // The public envelope reports neither usage nor cost. Unknown is not zero.
    assert!(bench_run.cost.is_unknown(), "cost must stay unknown");
    assert!(bench_run.timing.is_unknown(), "timing must stay unknown");
    assert!(
        matches!(bench_run.cost, Observed::Unknown),
        "cost must not be recorded as a known zero"
    );
}

#[test]
fn owner_only_record_retains_exact_model_refs_and_the_full_replay() {
    let run = run_complete();
    let record = &run.recorded.owner_only;

    assert_eq!(record.slots.len(), 4);
    let exact: Vec<String> = record
        .slots
        .iter()
        .map(|slot| format!("{}/{}", slot.model.profile_id, slot.model.model_id))
        .collect();
    assert_eq!(
        exact,
        vec![
            "gateway-alpha/model-observe",
            "gateway-beta/vendor/model-contradict",
            "gateway-gamma/model-review",
            "gateway-delta/model-finalize",
        ]
    );
    // The full replay is retained, including the owner-only answer envelope.
    assert_eq!(record.replay.events.len(), run.outcome.replay.events.len());
    let result = run.outcome.result().expect("completed result");
    assert!(
        result.answer.is_some(),
        "owner-only record keeps the answer"
    );
}

#[test]
fn packet_never_carries_case_resolution() {
    let run = run_complete();
    let packet_json = serde_json::to_string(&run.bounded.packet).unwrap();
    for forbidden in [
        "inventory service connection pool exhaustion",
        "raise pool size",
        "this SKU service has failed this way before",
        "adjudicated_root_cause",
        "domain_expertise",
        "resolution",
    ] {
        assert!(
            !packet_json.contains(forbidden),
            "packet leaked evaluation-only material: {forbidden}"
        );
    }
    // The request is built from the packet and the task, so it is clean too.
    let request_json = serde_json::to_string(&run.bound.request).unwrap();
    assert!(!request_json.contains("inventory service connection pool exhaustion"));
}

#[test]
fn request_identity_binds_to_packet_identity() {
    let case = common::case();
    let snapshot = common::snapshot();

    let wide = common::task(&snapshot);
    let narrow = common::task_with_visibility(&snapshot, vec!["ev-log-1".into()]);

    let wide_packet = materialize_bounded_packet(&case, &snapshot, &wide).unwrap();
    let narrow_packet = materialize_bounded_packet(&case, &snapshot, &narrow).unwrap();
    assert_ne!(wide_packet.packet.packet_id, narrow_packet.packet.packet_id);
    assert_ne!(
        wide_packet.packet_fingerprint,
        narrow_packet.packet_fingerprint
    );
    assert_ne!(
        wide_packet.corpus_fingerprint,
        narrow_packet.corpus_fingerprint
    );

    let wide_request = build_request(
        &snapshot,
        &wide,
        &wide_packet,
        common::policy(),
        TriageRequestOverridesV1::default(),
        common::CANCELLATION_ID,
    )
    .unwrap();
    let narrow_request = build_request(
        &snapshot,
        &narrow,
        &narrow_packet,
        common::policy(),
        TriageRequestOverridesV1::default(),
        common::CANCELLATION_ID,
    )
    .unwrap();

    // A different packet is a different request and a different run identity.
    assert_ne!(
        wide_request.request_fingerprint,
        narrow_request.request_fingerprint
    );
    assert_ne!(wide_request.sdk_run_id, narrow_request.sdk_run_id);

    // The request scope is the snapshot itself, and the replay repeats the
    // request fingerprint the request computed.
    assert_eq!(wide_request.request.scope.corpus_id, snapshot.snapshot_id);
    let run = run_offline(
        &case,
        &snapshot,
        &wide,
        common::policy(),
        TriageRequestOverridesV1::default(),
        common::CANCELLATION_ID,
        &common::plan_complete(),
        &common::context(),
    )
    .unwrap();
    assert_eq!(
        run.outcome.replay.request_fingerprint,
        wide_request.request_fingerprint
    );
    let TriageRunEventPayloadV2::RunStarted {
        request_fingerprint,
        policy_fingerprint,
    } = &run.outcome.replay.events[0].event
    else {
        panic!("first event must be run_started");
    };
    assert_eq!(request_fingerprint, &wide_request.request_fingerprint);
    assert_eq!(policy_fingerprint, &wide_request.policy_fingerprint);
}

#[test]
fn visibility_widening_beyond_the_snapshot_fails_closed() {
    let case = common::case();
    let snapshot = common::snapshot();
    // A task that names an item the snapshot does not hold cannot even be
    // materialized: the bench refuses first.
    let task = common::task_with_visibility(
        &snapshot,
        vec!["ev-log-1".into(), "ev-not-in-snapshot".into()],
    );
    let error = materialize_bounded_packet(&case, &snapshot, &task).unwrap_err();
    assert!(
        matches!(error, AdapterError::Bench(_)),
        "expected a bench refusal, got {error:?}"
    );
}

#[test]
fn visibility_widening_onto_a_withheld_item_fails_closed() {
    let case = common::case();
    let snapshot = common::snapshot();
    // `ev-hidden-1` exists in the snapshot but is marked not visible to
    // strategies. Naming it in the task must not widen the packet.
    let task =
        common::task_with_visibility(&snapshot, vec!["ev-hidden-1".into(), "ev-log-1".into()]);
    let error = materialize_bounded_packet(&case, &snapshot, &task).unwrap_err();
    assert!(
        matches!(error, AdapterError::Bench(_)),
        "expected a fail-closed refusal, got {error:?}"
    );
}

#[test]
fn packet_holds_only_the_items_the_task_allows() {
    let run = run_complete();
    let materialized: Vec<&str> = run
        .bounded
        .packet
        .evidence
        .iter()
        .map(|row| row.item_id.as_str())
        .collect();
    assert_eq!(materialized, vec!["ev-log-1", "ev-mail-1", "ev-ref-1"]);
    assert!(
        !materialized.contains(&"ev-hidden-1"),
        "withheld item must never reach a packet"
    );
    // The packet carries digests, never evidence bytes.
    let packet_json = serde_json::to_string(&run.bounded.packet).unwrap();
    assert!(!packet_json.contains("upstream inventory timeout"));
    assert!(!packet_json.contains("checkout error rate above threshold"));
}

#[test]
fn a_task_bound_to_another_snapshot_is_refused() {
    let case = common::case();
    let snapshot = common::snapshot();
    let task = common::task(&snapshot);
    let bounded = materialize_bounded_packet(&case, &snapshot, &task).unwrap();

    let mut other = common::snapshot();
    other.notes = Some("a different snapshot".into());
    other.snapshot_id = other.compute_snapshot_id().unwrap();

    let error = build_request(
        &other,
        &task,
        &bounded,
        common::policy(),
        TriageRequestOverridesV1::default(),
        common::CANCELLATION_ID,
    )
    .unwrap_err();
    assert!(
        matches!(error, AdapterError::IdentityMismatch(_)),
        "expected an identity mismatch, got {error:?}"
    );
}

#[test]
fn the_legacy_standard_shape_also_produces_a_valid_replay() {
    let case = common::case();
    let snapshot = common::snapshot();
    let task = common::task(&snapshot);
    let run = run_offline(
        &case,
        &snapshot,
        &task,
        common::policy(),
        TriageRequestOverridesV1::default(),
        common::CANCELLATION_ID,
        &common::plan_standard(),
        &common::context(),
    )
    .expect("standard shape run");
    run.outcome.replay.validate().unwrap();
    assert_eq!(run.recorded.bench_run.status, RunStatus::Completed);
    assert_eq!(run.outcome.attempts.len(), 1);
}
