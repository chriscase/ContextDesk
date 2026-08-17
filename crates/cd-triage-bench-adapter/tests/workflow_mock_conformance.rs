//! Non-default conformance against `cd_workflow::triage::MockTriageRunner`.
//!
//! This file compiles only under `--features workflow-mock`, which pulls in
//! `cd-core` (DuckDB, keyring) and `cd-workflow`. It is deliberately outside
//! the default lane so the adapter's own suite stays dependency-light; the
//! default `tests/dependency_direction.rs` proves those crates are absent
//! without this feature.
//!
//! What is claimed here: the adapter's deterministic mock walks the **same
//! phase graph** and maps attempt status to **the same terminal disposition**
//! as the workflow runner, and both streams are accepted by the same real
//! `TriageReplayV1::validate`.
//!
//! What is **not** claimed: identical results. Two divergences are deliberate
//! and asserted below so they cannot drift silently.

#![cfg(feature = "workflow-mock")]

mod common;

use std::collections::BTreeMap;

use cd_core::multi_model::triage_policy::{
    ContributorSlotV2, FinalizerSlotV2, ReviewerConditionV2, ReviewerSlotV2, RolePreflightV2,
    RoleQualificationV2, RoleRequirement, TriagePolicyMode, TriagePolicyPreflightV2,
    TriagePolicyV2,
};
use cd_core::multi_model::{TRIAGE_QUALIFICATION_SCHEMA_V2, TRIAGE_QUALIFICATION_WORKFLOW_V2};
use cd_workflow::triage::{
    MockPacket, MockRoleOutcome, MockRoleScript, MockRunControl, MockRunInput, MockTriageRunner,
};

use cd_triage_bench_adapter::{
    build_request, materialize_bounded_packet, run_deterministic_mock, MockEnginePlan,
    MockSlotOutcome, MockSlotPlan, MockTerminalPlan, MockValidation,
};
use cd_triage_sdk::{
    ModelRef, PacketPrivacyBoundary, TriageAttemptStatus, TriageContributorRole, TriageReplayV1,
    TriageResultKind, TriageRunEventPayloadV2, TriageSlotKindV2, TriageTerminalDispositionV1,
};

fn model(profile: &str, model_id: &str) -> ModelRef {
    ModelRef {
        profile_id: profile.into(),
        model_id: model_id.into(),
    }
}

fn event_kinds(replay: &TriageReplayV1) -> Vec<&'static str> {
    replay
        .events
        .iter()
        .map(|event| match &event.event {
            TriageRunEventPayloadV2::RunStarted { .. } => "run_started",
            TriageRunEventPayloadV2::PacketReady { .. } => "packet_ready",
            TriageRunEventPayloadV2::RoleAttempt { .. } => "role_attempt",
            TriageRunEventPayloadV2::Reconciliation { .. } => "reconciliation",
            TriageRunEventPayloadV2::PreliminaryReconciliation { .. } => {
                "preliminary_reconciliation"
            }
            TriageRunEventPayloadV2::FinalReconciliation { .. } => "final_reconciliation",
            TriageRunEventPayloadV2::Validation { .. } => "validation",
            TriageRunEventPayloadV2::Correction { .. } => "correction",
            TriageRunEventPayloadV2::Completed { .. } => "completed",
            TriageRunEventPayloadV2::Failed { .. } => "failed",
            TriageRunEventPayloadV2::TimedOut { .. } => "timed_out",
            TriageRunEventPayloadV2::Cancelled { .. } => "cancelled",
        })
        .collect()
}

fn adapter_replay(plan: &MockEnginePlan) -> TriageReplayV1 {
    let case = common::case();
    let snapshot = common::snapshot();
    let task = common::task(&snapshot);
    let bounded = materialize_bounded_packet(&case, &snapshot, &task).unwrap();
    let bound = build_request(
        &snapshot,
        &task,
        &bounded,
        common::policy(),
        Default::default(),
        common::CANCELLATION_ID,
    )
    .unwrap();
    run_deterministic_mock(&bound, &bounded, plan)
        .expect("adapter mock")
        .replay
}

fn enhanced_policy() -> TriagePolicyV2 {
    TriagePolicyV2 {
        schema_id: cd_triage_sdk::TRIAGE_POLICY_SCHEMA_V2.into(),
        mode: TriagePolicyMode::Enhanced,
        contributors: vec![
            ContributorSlotV2 {
                slot_id: "observe".into(),
                role: TriageContributorRole::ObservationExtractor,
                model: model("gateway-alpha", "model-observe"),
                requirement: RoleRequirement::Required,
                allow_remote: false,
            },
            ContributorSlotV2 {
                slot_id: "contradict".into(),
                role: TriageContributorRole::ContradictionChecker,
                model: model("gateway-beta", "vendor/model-contradict"),
                requirement: RoleRequirement::Required,
                allow_remote: false,
            },
        ],
        finalizer: Some(FinalizerSlotV2 {
            slot_id: "finalize".into(),
            model: model("gateway-delta", "model-finalize"),
            requirement: RoleRequirement::Required,
            allow_remote: false,
        }),
        reviewer: Some(ReviewerSlotV2 {
            slot_id: "review".into(),
            model: model("gateway-gamma", "model-review"),
            condition: ReviewerConditionV2::ContestedOrIncomplete,
            requirement: RoleRequirement::Optional,
            allow_remote: false,
        }),
        budget: Default::default(),
        execution: Default::default(),
    }
}

fn standard_policy() -> TriagePolicyV2 {
    TriagePolicyV2 {
        schema_id: cd_triage_sdk::TRIAGE_POLICY_SCHEMA_V2.into(),
        mode: TriagePolicyMode::Standard,
        contributors: vec![],
        finalizer: Some(FinalizerSlotV2 {
            slot_id: "finalize".into(),
            model: model("gateway-delta", "model-finalize"),
            requirement: RoleRequirement::Required,
            allow_remote: false,
        }),
        reviewer: None,
        budget: Default::default(),
        execution: Default::default(),
    }
}

fn preflight(policy: &TriagePolicyV2) -> TriagePolicyPreflightV2 {
    let qualified = |slot_id: &str, model: &ModelRef, kind: TriageSlotKindV2| RolePreflightV2 {
        slot_id: slot_id.to_string(),
        model: model.clone(),
        kind,
        available: true,
        qualification: RoleQualificationV2::Qualified,
        remote: false,
        qualification_schema_id: Some(TRIAGE_QUALIFICATION_SCHEMA_V2.into()),
        workflow_id: Some(TRIAGE_QUALIFICATION_WORKFLOW_V2.into()),
        protocol_fingerprint: Some("conformance-fixture-protocol".into()),
    };
    let mut roles: Vec<RolePreflightV2> = policy
        .contributors
        .iter()
        .map(|slot| {
            qualified(
                &slot.slot_id,
                &slot.model,
                TriageSlotKindV2::Contributor(slot.role),
            )
        })
        .collect();
    if let Some(slot) = &policy.reviewer {
        roles.push(qualified(
            &slot.slot_id,
            &slot.model,
            TriageSlotKindV2::Reviewer,
        ));
    }
    if let Some(slot) = &policy.finalizer {
        roles.push(qualified(
            &slot.slot_id,
            &slot.model,
            TriageSlotKindV2::Finalizer,
        ));
    }
    TriagePolicyPreflightV2 { roles }
}

fn workflow_input() -> MockRunInput {
    MockRunInput {
        run_id: "cdrun-conformance".into(),
        request_fingerprint: "req-conformance".into(),
        policy_fingerprint: "pol-conformance".into(),
        packet: MockPacket {
            packet_id: "pkt-conformance".into(),
            packet_digest: "pkf-conformance".into(),
            evidence_count: 3,
        },
        cancellation_id: common::CANCELLATION_ID.into(),
        control: MockRunControl::default(),
    }
}

fn workflow_replay(policy: &TriagePolicyV2, script: MockRoleScript) -> TriageReplayV1 {
    MockTriageRunner::new(script)
        .replay(policy, &preflight(policy), &workflow_input())
        .expect("workflow mock")
}

#[test]
fn enhanced_phase_graphs_agree() {
    let policy = enhanced_policy();
    let script = MockRoleScript::new()
        .with_outcome("observe", MockRoleOutcome::completed())
        .with_outcome("contradict", MockRoleOutcome::completed())
        .with_outcome("review", MockRoleOutcome::completed())
        .with_outcome("finalize", MockRoleOutcome::completed());
    let theirs = workflow_replay(&policy, script);
    let ours = adapter_replay(&common::plan_complete());

    theirs.validate().expect("workflow replay validates");
    ours.validate().expect("adapter replay validates");

    assert_eq!(
        event_kinds(&ours)[..event_kinds(&ours).len() - 1],
        event_kinds(&theirs)[..event_kinds(&theirs).len() - 1],
        "adapter and workflow must walk the same phase graph"
    );
    assert_eq!(
        event_kinds(&ours),
        vec![
            "run_started",
            "packet_ready",
            "role_attempt",
            "role_attempt",
            "preliminary_reconciliation",
            "role_attempt",
            "final_reconciliation",
            "role_attempt",
            "validation",
            "correction",
            "completed",
        ]
    );
}

#[test]
fn standard_phase_graphs_agree() {
    let policy = standard_policy();
    let script = MockRoleScript::new().with_outcome("finalize", MockRoleOutcome::completed());
    let theirs = workflow_replay(&policy, script);
    let ours = adapter_replay(&common::plan_standard());

    theirs.validate().unwrap();
    ours.validate().unwrap();
    assert_eq!(
        event_kinds(&ours)[..event_kinds(&ours).len() - 1],
        event_kinds(&theirs)[..event_kinds(&theirs).len() - 1]
    );
    assert_eq!(
        event_kinds(&ours),
        vec![
            "run_started",
            "packet_ready",
            "role_attempt",
            "reconciliation",
            "validation",
            "completed",
        ]
    );
}

/// Map attempt status to terminal disposition using each crate's own runner.
fn adapter_dispositions() -> BTreeMap<String, TriageTerminalDispositionV1> {
    let mut map = BTreeMap::new();
    for outcome in [
        MockSlotOutcome::completed(),
        MockSlotOutcome::Abstained,
        MockSlotOutcome::Invalid,
        MockSlotOutcome::Unavailable,
        MockSlotOutcome::NotAdmitted,
        MockSlotOutcome::TimedOut,
        MockSlotOutcome::Cancelled,
        MockSlotOutcome::Failed,
    ] {
        let plan = MockEnginePlan {
            slots: vec![MockSlotPlan {
                role_slot_id: "finalize".into(),
                role: TriageSlotKindV2::Finalizer,
                model: model("gateway-delta", "model-finalize"),
                outcome,
            }],
            validation: Some(MockValidation {
                passed: false,
                reason_codes: vec![],
            }),
            correction: None,
            terminal: MockTerminalPlan::CompletedPartial,
        };
        let replay = adapter_replay(&plan);
        insert_disposition(&mut map, &replay);
    }
    map
}

fn workflow_dispositions() -> BTreeMap<String, TriageTerminalDispositionV1> {
    let policy = standard_policy();
    let mut map = BTreeMap::new();
    for outcome in [
        MockRoleOutcome::completed(),
        MockRoleOutcome::Abstained {
            elapsed_ms: 1,
            input_chars: 1,
            output_chars: 1,
        },
        MockRoleOutcome::Invalid {
            reason_codes: vec!["invalid".into()],
            elapsed_ms: 1,
            input_chars: 1,
            output_chars: 1,
        },
        MockRoleOutcome::Unavailable {
            reason_codes: vec!["unavailable".into()],
        },
        MockRoleOutcome::NotAdmitted {
            reason_codes: vec!["not_admitted".into()],
        },
        MockRoleOutcome::TimedOut {
            reason_codes: vec!["deadline".into()],
        },
        MockRoleOutcome::Cancelled {
            reason_codes: vec!["cancelled".into()],
        },
        MockRoleOutcome::Failed {
            reason_codes: vec!["failed".into()],
        },
    ] {
        let replay = workflow_replay(
            &policy,
            MockRoleScript::new().with_outcome("finalize", outcome),
        );
        insert_disposition(&mut map, &replay);
    }
    map
}

fn insert_disposition(
    map: &mut BTreeMap<String, TriageTerminalDispositionV1>,
    replay: &TriageReplayV1,
) {
    for event in &replay.events {
        if let TriageRunEventPayloadV2::RoleAttempt { attempt } = &event.event {
            let key = serde_json::to_string(&attempt.status).unwrap();
            let disposition = attempt
                .terminal_disposition
                .expect("both runners record an explicit disposition");
            map.insert(key, disposition);
        }
    }
}

#[test]
fn terminal_disposition_mapping_agrees_for_every_status() {
    let ours = adapter_dispositions();
    let theirs = workflow_dispositions();
    assert_eq!(ours.len(), 8, "expected one entry per attempt status");
    assert_eq!(
        ours, theirs,
        "adapter and workflow must map attempt status to disposition identically"
    );
}

#[test]
fn both_runners_emit_owner_only_events() {
    let ours = adapter_replay(&common::plan_complete());
    let theirs = workflow_replay(
        &enhanced_policy(),
        MockRoleScript::new().with_outcome("finalize", MockRoleOutcome::completed()),
    );
    for replay in [&ours, &theirs] {
        assert!(replay
            .events
            .iter()
            .all(|event| event.privacy == PacketPrivacyBoundary::OwnerOnly));
    }
}

#[test]
fn deliberate_divergences_are_asserted_rather_than_assumed() {
    // 1. Provider-call accounting. The workflow runner reports one physical
    //    provider call for a completed/abstained/invalid slot; this adapter
    //    contacts nothing at all and reports zero. Recording one would be a
    //    fabricated provider operation.
    let ours = adapter_replay(&common::plan_standard());
    let theirs = workflow_replay(
        &standard_policy(),
        MockRoleScript::new().with_outcome("finalize", MockRoleOutcome::completed()),
    );
    let calls = |replay: &TriageReplayV1| -> Option<u32> {
        replay.events.iter().find_map(|event| match &event.event {
            TriageRunEventPayloadV2::RoleAttempt { attempt } => attempt.physical_provider_calls,
            _ => None,
        })
    };
    assert_eq!(calls(&ours), Some(0));
    assert_eq!(calls(&theirs), Some(1));

    // 2. Result kind. The workflow mock never claims a grounded final answer;
    //    this adapter can be scripted to produce one so the bench has a
    //    completed-run fixture. The answer is identity-derived, never model
    //    text — see `engine::identity_derived_answer`.
    let our_kind = ours.events.last().and_then(|event| match &event.event {
        TriageRunEventPayloadV2::Completed { result } => Some(result.kind),
        _ => None,
    });
    let their_kind = theirs.events.last().and_then(|event| match &event.event {
        TriageRunEventPayloadV2::Completed { result } => Some(result.kind),
        TriageRunEventPayloadV2::Failed { partial_result, .. } => {
            partial_result.as_ref().map(|result| result.kind)
        }
        _ => None,
    });
    assert_eq!(our_kind, Some(TriageResultKind::GroundedFinal));
    assert_eq!(their_kind, Some(TriageResultKind::HonestPartial));
}

#[test]
fn adapter_attempt_statuses_are_the_same_vocabulary() {
    // A cheap guard against the two crates drifting apart on the enum itself.
    for status in [
        TriageAttemptStatus::Completed,
        TriageAttemptStatus::Abstained,
        TriageAttemptStatus::Invalid,
        TriageAttemptStatus::Unavailable,
        TriageAttemptStatus::TimedOut,
        TriageAttemptStatus::Cancelled,
        TriageAttemptStatus::Failed,
        TriageAttemptStatus::NotAdmitted,
    ] {
        let encoded = serde_json::to_string(&status).unwrap();
        let round_trip: cd_core::triage_sdk::TriageAttemptStatus =
            serde_json::from_str(&encoded).unwrap();
        assert_eq!(serde_json::to_string(&round_trip).unwrap(), encoded);
    }
}
