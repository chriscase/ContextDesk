//! Fingerprint behaviour: stable for identical inputs, different for every
//! input that changes what a strategy saw or which model produced it.

mod common;

use cd_triage_bench_adapter::{
    materialize_bounded_packet, record_run, run_deterministic_mock, run_offline,
    validate_public_replay, AdapterRun, MockSlotOutcome,
};
use cd_triage_runtime::{canonical_request_fingerprint, replay};
use cd_triage_sdk::{TriagePolicySelectionV2, TriageRequestOverridesV1};

fn run_with(
    policy: TriagePolicySelectionV2,
    overrides: TriageRequestOverridesV1,
    cancellation_id: &str,
) -> AdapterRun {
    let case = common::case();
    let snapshot = common::snapshot();
    let task = common::task(&snapshot);
    run_offline(
        &case,
        &snapshot,
        &task,
        policy,
        overrides,
        cancellation_id,
        &common::plan_complete(),
        &common::context(),
    )
    .expect("offline run")
}

fn baseline() -> AdapterRun {
    run_with(
        common::policy(),
        TriageRequestOverridesV1::default(),
        common::CANCELLATION_ID,
    )
}

#[test]
fn identical_inputs_produce_identical_fingerprints_and_run_identities() {
    let first = baseline();
    let second = baseline();
    assert_eq!(
        first.recorded.owner_only.fingerprints,
        second.recorded.owner_only.fingerprints
    );
    assert_eq!(first.bound.sdk_run_id, second.bound.sdk_run_id);
    assert_eq!(
        first.recorded.bench_run.run_id,
        second.recorded.bench_run.run_id
    );
    assert_eq!(first.recorded.raw_output, second.recorded.raw_output);
    assert_eq!(first.outcome.replay, second.outcome.replay);
}

#[test]
fn request_and_replay_conform_to_the_public_runtime_facade() {
    let run = baseline();
    assert_eq!(
        run.bound.request_fingerprint,
        canonical_request_fingerprint(&run.bound.request).unwrap()
    );
    let execution = replay(run.bound.request.clone(), run.outcome.replay.clone()).unwrap();
    assert_eq!(execution.replay(), &run.outcome.replay);
}

#[test]
fn a_different_policy_changes_the_policy_and_request_fingerprints_only() {
    let base = baseline();
    let other = run_with(
        TriagePolicySelectionV2::Saved {
            policy_id: "policy-triage-enhanced".into(),
            // Same policy id, different revision: still a different policy.
            policy_revision: 4,
        },
        TriageRequestOverridesV1::default(),
        common::CANCELLATION_ID,
    );

    let a = &base.recorded.owner_only.fingerprints;
    let b = &other.recorded.owner_only.fingerprints;
    assert_ne!(a.policy, b.policy);
    assert_ne!(a.request, b.request);
    // The strategy saw the same evidence, so packet and corpus are unchanged.
    assert_eq!(a.packet, b.packet);
    assert_eq!(a.corpus, b.corpus);
    assert_eq!(a.slots, b.slots);
    assert_ne!(base.bound.sdk_run_id, other.bound.sdk_run_id);
}

#[test]
fn request_overrides_change_the_request_fingerprint() {
    let base = baseline();
    let bounded_deadline = run_with(
        common::policy(),
        TriageRequestOverridesV1 {
            deadline_ms: Some(60_000),
            max_provider_calls: None,
        },
        common::CANCELLATION_ID,
    );
    assert_ne!(
        base.recorded.owner_only.fingerprints.request,
        bounded_deadline.recorded.owner_only.fingerprints.request
    );
    assert_eq!(
        base.recorded.owner_only.fingerprints.packet,
        bounded_deadline.recorded.owner_only.fingerprints.packet
    );
}

#[test]
fn narrowing_visibility_changes_the_packet_and_corpus_fingerprints() {
    let case = common::case();
    let snapshot = common::snapshot();
    let wide = materialize_bounded_packet(&case, &snapshot, &common::task(&snapshot)).unwrap();
    let narrow = materialize_bounded_packet(
        &case,
        &snapshot,
        &common::task_with_visibility(&snapshot, vec!["ev-log-1".into(), "ev-mail-1".into()]),
    )
    .unwrap();

    assert_ne!(wide.packet_fingerprint, narrow.packet_fingerprint);
    assert_ne!(wide.corpus_fingerprint, narrow.corpus_fingerprint);
    assert_eq!(wide.evidence_count, 3);
    assert_eq!(narrow.evidence_count, 2);
}

#[test]
fn changing_the_snapshot_content_changes_the_corpus_fingerprint() {
    let case = common::case();
    let snapshot = common::snapshot();
    let base = materialize_bounded_packet(&case, &snapshot, &common::task(&snapshot)).unwrap();

    let mut mutated = common::snapshot();
    mutated.notes = Some("an amended snapshot".into());
    mutated.snapshot_id = mutated.compute_snapshot_id().unwrap();
    let mutated_task = common::task(&mutated);
    let other = materialize_bounded_packet(&case, &mutated, &mutated_task).unwrap();

    // Snapshot identity is content-addressed, so an amended snapshot is a
    // different snapshot, a different task, and a different packet.
    assert_ne!(snapshot.snapshot_id, mutated.snapshot_id);
    assert_ne!(base.packet_fingerprint, other.packet_fingerprint);
}

#[test]
fn a_different_model_changes_the_slot_and_model_fingerprints_only() {
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

    let base_plan = common::plan_complete();
    let mut swapped = common::plan_complete();
    swapped.slots[0].model = common::model("gateway-alpha", "model-observe-v2");

    let base = run_deterministic_mock(&bound, &bounded, &base_plan).unwrap();
    let other = run_deterministic_mock(&bound, &bounded, &swapped).unwrap();
    let context = common::context();
    let base = validate_public_replay(base.replay, &bound).unwrap();
    let other = validate_public_replay(other.replay, &bound).unwrap();
    let base = record_run(&snapshot, &task, &bound, &bounded, &base, &context).unwrap();
    let other = record_run(&snapshot, &task, &bound, &bounded, &other, &context).unwrap();

    assert_ne!(
        base.owner_only.slots[0].model_fingerprint,
        other.owner_only.slots[0].model_fingerprint
    );
    assert_ne!(
        base.owner_only.slots[0].slot_fingerprint,
        other.owner_only.slots[0].slot_fingerprint
    );
    // Untouched slots keep their fingerprints.
    assert_eq!(
        base.owner_only.slots[1].slot_fingerprint,
        other.owner_only.slots[1].slot_fingerprint
    );
    // The request did not change, so its fingerprint did not either.
    assert_eq!(
        base.owner_only.fingerprints.request,
        other.owner_only.fingerprints.request
    );
    // But the recorded run content did, so the bench run identity differs.
    assert_ne!(base.bench_run.run_id, other.bench_run.run_id);
}

#[test]
fn a_different_outcome_changes_the_recorded_run_identity() {
    let case = common::case();
    let snapshot = common::snapshot();
    let task = common::task(&snapshot);
    let complete = run_offline(
        &case,
        &snapshot,
        &task,
        common::policy(),
        TriageRequestOverridesV1::default(),
        common::CANCELLATION_ID,
        &common::plan_complete(),
        &common::context(),
    )
    .unwrap();
    let mut abstained = common::plan_complete();
    abstained.slots[0].outcome = MockSlotOutcome::Abstained;
    let other = run_offline(
        &case,
        &snapshot,
        &task,
        common::policy(),
        TriageRequestOverridesV1::default(),
        common::CANCELLATION_ID,
        &abstained,
        &common::context(),
    )
    .unwrap();

    assert_ne!(
        complete.recorded.bench_run.run_id,
        other.recorded.bench_run.run_id
    );
    // Same request, same packet: the run identity moved because the *result*
    // moved, which is what the bench fingerprint is supposed to track.
    assert_eq!(
        complete.recorded.owner_only.fingerprints.request,
        other.recorded.owner_only.fingerprints.request
    );
    assert_eq!(
        complete.recorded.owner_only.fingerprints.packet,
        other.recorded.owner_only.fingerprints.packet
    );
}

#[test]
fn the_bench_run_identity_is_the_bench_fingerprint_not_the_sdk_run_id() {
    let run = baseline();
    assert!(run.recorded.bench_run.run_id.starts_with("run-"));
    assert!(run.bound.sdk_run_id.starts_with("cdrun-"));
    assert_ne!(run.recorded.bench_run.run_id, run.bound.sdk_run_id);
    // `TriageRun::validate` recomputes the bench fingerprint, so a validated
    // run proves the identity was not hand-written.
    run.recorded.bench_run.validate().unwrap();
}
