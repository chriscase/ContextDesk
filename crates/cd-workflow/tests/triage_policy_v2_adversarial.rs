//! Adversarial, provider-free mutation campaign for the Triage Policy V2
//! workflow/SDK seams.
//!
//! The fixtures are deliberately tiny and identity-only.  They exercise the
//! host-authored state machine, not a provider transport or a model response.

use std::sync::{Arc, Mutex};

use cd_core::extension_contract::PacketPrivacyBoundary;
use cd_core::model_ref::ModelRef;
use cd_core::multi_model::triage_policy::{
    ContributorSlotV2, FinalizerSlotV2, ReviewerConditionV2, ReviewerSlotV2, RolePreflightV2,
    RoleQualificationV2, RoleRequirement, TriageContributorRole, TriagePolicyMode,
    TriagePolicyPreflightV2, TriagePolicyV2, TriageSlotKindV2,
};
use cd_core::triage_sdk::{
    TriageAttemptStatus, TriageContractError, TriageReplayV1, TriageRoleAttemptV1,
    TriageRunEventPayloadV2,
};
use cd_workflow::triage::{
    MockPacket, MockRoleOutcome, MockRoleScript, MockRunControl, MockRunInput, MockTriageRunner,
    TriageRoleExecutor,
};

fn model(profile: &str, model_id: &str) -> ModelRef {
    ModelRef {
        profile_id: profile.into(),
        model_id: model_id.into(),
    }
}

fn policy() -> TriagePolicyV2 {
    TriagePolicyV2 {
        schema_id: "contextdesk.triage_policy.v2".into(),
        mode: TriagePolicyMode::Enhanced,
        contributors: vec![
            ContributorSlotV2 {
                slot_id: "observe".into(),
                role: TriageContributorRole::ObservationExtractor,
                model: model("gateway-a", "model-a"),
                requirement: RoleRequirement::Required,
                allow_remote: false,
            },
            ContributorSlotV2 {
                slot_id: "challenge".into(),
                role: TriageContributorRole::ContradictionChecker,
                model: model("gateway-b", "model-b"),
                requirement: RoleRequirement::Optional,
                allow_remote: false,
            },
        ],
        finalizer: Some(FinalizerSlotV2 {
            slot_id: "finalize".into(),
            model: model("gateway-c", "model-c"),
            requirement: RoleRequirement::Required,
            allow_remote: false,
        }),
        reviewer: Some(ReviewerSlotV2 {
            slot_id: "review".into(),
            model: model("gateway-d", "model-d"),
            condition: ReviewerConditionV2::ContestedOrIncomplete,
            requirement: RoleRequirement::Optional,
            allow_remote: false,
        }),
        budget: Default::default(),
        execution: Default::default(),
    }
}

fn preflight(policy: &TriagePolicyV2) -> TriagePolicyPreflightV2 {
    let mut roles = policy
        .contributors
        .iter()
        .map(|slot| RolePreflightV2 {
            slot_id: slot.slot_id.clone(),
            model: slot.model.clone(),
            kind: TriageSlotKindV2::Contributor(slot.role),
            available: true,
            qualification: RoleQualificationV2::Qualified,
            remote: false,
        })
        .collect::<Vec<_>>();
    if let Some(slot) = &policy.finalizer {
        roles.push(RolePreflightV2 {
            slot_id: slot.slot_id.clone(),
            model: slot.model.clone(),
            kind: TriageSlotKindV2::Finalizer,
            available: true,
            qualification: RoleQualificationV2::Qualified,
            remote: false,
        });
    }
    if let Some(slot) = &policy.reviewer {
        roles.push(RolePreflightV2 {
            slot_id: slot.slot_id.clone(),
            model: slot.model.clone(),
            kind: TriageSlotKindV2::Reviewer,
            available: true,
            qualification: RoleQualificationV2::Qualified,
            remote: false,
        });
    }
    TriagePolicyPreflightV2 { roles }
}

fn input() -> MockRunInput {
    MockRunInput {
        run_id: "run:adversarial:1".into(),
        request_fingerprint: "request:fingerprint:1".into(),
        policy_fingerprint: "policy:fingerprint:1".into(),
        packet: MockPacket {
            packet_id: "packet:adversarial:1".into(),
            packet_digest: "packet:digest:1".into(),
            evidence_count: 2,
        },
        cancellation_id: "cancel:adversarial:1".into(),
        control: MockRunControl::default(),
    }
}

fn attempts(replay: &TriageReplayV1) -> Vec<&TriageRoleAttemptV1> {
    replay
        .events
        .iter()
        .filter_map(|event| match &event.event {
            TriageRunEventPayloadV2::RoleAttempt { attempt } => Some(attempt),
            _ => None,
        })
        .collect()
}

#[derive(Clone, Default)]
struct RecordingExecutor {
    calls: Arc<Mutex<Vec<String>>>,
    fail_slot: Option<String>,
}

impl TriageRoleExecutor for RecordingExecutor {
    fn outcome(
        &self,
        slot: &cd_core::multi_model::triage_policy::CompiledRoleSlotV2,
    ) -> MockRoleOutcome {
        self.calls.lock().unwrap().push(slot.slot_id.clone());
        if self.fail_slot.as_deref() == Some(slot.slot_id.as_str()) {
            MockRoleOutcome::Failed {
                reason_codes: vec!["provider_failed".into()],
            }
        } else {
            MockRoleOutcome::completed()
        }
    }
}

#[test]
fn canonical_phase_order_is_contributor_then_finalizer_then_reviewer() {
    let mut policy = policy();
    // Force the conditional reviewer to run without changing the slot order.
    policy.reviewer.as_mut().unwrap().condition = ReviewerConditionV2::ExplicitRequest;
    let script = MockRoleScript::new()
        .with_outcome("observe", MockRoleOutcome::completed())
        .with_outcome(
            "challenge",
            MockRoleOutcome::Invalid {
                reason_codes: vec!["challenge_invalid".into()],
                elapsed_ms: 2,
                input_chars: 3,
                output_chars: 4,
            },
        )
        .with_outcome("finalize", MockRoleOutcome::completed())
        .with_outcome("review", MockRoleOutcome::completed());
    let mut input = input();
    input.control.explicit_review_requested = true;
    let result = MockTriageRunner::new(script)
        .run(&policy, &preflight(&policy), &input)
        .unwrap();
    let role_kinds = attempts(&result.replay)
        .into_iter()
        .map(|attempt| attempt.role)
        .collect::<Vec<_>>();
    assert_eq!(
        role_kinds,
        vec![
            TriageSlotKindV2::Contributor(TriageContributorRole::ObservationExtractor),
            TriageSlotKindV2::Contributor(TriageContributorRole::ContradictionChecker),
            TriageSlotKindV2::Finalizer,
            TriageSlotKindV2::Reviewer,
        ]
    );
    let phase_kinds = result
        .replay
        .events
        .iter()
        .map(|event| match &event.event {
            TriageRunEventPayloadV2::RunStarted { .. } => "started",
            TriageRunEventPayloadV2::PacketReady { .. } => "packet",
            TriageRunEventPayloadV2::RoleAttempt { attempt }
                if matches!(attempt.role, TriageSlotKindV2::Contributor(_)) =>
            {
                "contributor"
            }
            TriageRunEventPayloadV2::RoleAttempt { attempt }
                if attempt.role == TriageSlotKindV2::Finalizer =>
            {
                "finalizer"
            }
            TriageRunEventPayloadV2::RoleAttempt { attempt }
                if attempt.role == TriageSlotKindV2::Reviewer =>
            {
                "reviewer"
            }
            TriageRunEventPayloadV2::Reconciliation { .. } => "reconcile",
            TriageRunEventPayloadV2::Validation { .. } => "validate",
            event if event.is_terminal() => "terminal",
            _ => "other",
        })
        .collect::<Vec<_>>();
    assert_eq!(
        phase_kinds,
        vec![
            "started",
            "packet",
            "contributor",
            "contributor",
            "reconcile",
            "finalizer",
            "reviewer",
            "validate",
            "terminal",
        ]
    );
    assert!(result
        .replay
        .events
        .windows(2)
        .all(|events| events[0].sequence + 1 == events[1].sequence));
}

#[test]
fn finalizer_is_not_called_after_required_contributor_failure() {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let executor = RecordingExecutor {
        calls: Arc::clone(&calls),
        fail_slot: Some("observe".into()),
    };
    // The required contributor fails; a malicious executor offering a final
    // answer must not get a turn with unaccepted claims.
    let result = MockTriageRunner::new(executor)
        .run(&policy(), &preflight(&policy()), &input())
        .unwrap();
    let role_attempts = attempts(&result.replay);
    assert_eq!(role_attempts[0].status, TriageAttemptStatus::Failed);
    assert_eq!(role_attempts[2].status, TriageAttemptStatus::NotAdmitted);
    assert!(role_attempts[2]
        .reason_codes
        .contains(&"finalizer_not_eligible".into()));
    assert_eq!(*calls.lock().unwrap(), vec!["observe", "challenge"]);
    assert!(matches!(
        result.replay.events.last().unwrap().event,
        TriageRunEventPayloadV2::Failed { .. }
    ));
}

#[test]
fn finalizer_and_reviewer_remain_distinct_even_when_model_is_shared() {
    let mut policy = policy();
    policy.finalizer.as_mut().unwrap().model = model("gateway-shared", "cheap-model");
    policy.reviewer.as_mut().unwrap().model = model("gateway-shared", "cheap-model");
    policy.reviewer.as_mut().unwrap().condition = ReviewerConditionV2::ExplicitRequest;
    let mut input = input();
    input.control.explicit_review_requested = true;
    let script = MockRoleScript::new()
        .with_outcome("observe", MockRoleOutcome::completed())
        .with_outcome("finalize", MockRoleOutcome::completed())
        .with_outcome("review", MockRoleOutcome::completed());
    let result = MockTriageRunner::new(script)
        .run(&policy, &preflight(&policy), &input)
        .unwrap();
    let kinds = attempts(&result.replay)
        .into_iter()
        .map(|attempt| (attempt.role, attempt.model.clone()))
        .collect::<Vec<_>>();
    assert_eq!(kinds[2].0, TriageSlotKindV2::Finalizer);
    assert_eq!(kinds[3].0, TriageSlotKindV2::Reviewer);
    assert_eq!(kinds[2].1, kinds[3].1);
    assert_eq!(
        result
            .compiled
            .unwrap()
            .independence_counts
            .distinct_model_refs,
        3
    );
}

#[test]
fn same_model_roles_never_masquerade_as_independent_consensus() {
    let mut policy = policy();
    let one_model = model("gateway-shared", "cheap-model");
    policy
        .contributors
        .iter_mut()
        .for_each(|slot| slot.model = one_model.clone());
    policy.finalizer.as_mut().unwrap().model = one_model.clone();
    policy.reviewer = None;
    let script = MockRoleScript::new()
        .with_outcome("observe", MockRoleOutcome::completed())
        .with_outcome("challenge", MockRoleOutcome::completed())
        .with_outcome("finalize", MockRoleOutcome::completed());
    let result = MockTriageRunner::new(script)
        .run(&policy, &preflight(&policy), &input())
        .unwrap();
    let compiled = result.compiled.unwrap();
    assert_eq!(compiled.independence_counts.role_slots, 3);
    assert_eq!(compiled.independence_counts.distinct_model_refs, 1);
    assert_eq!(compiled.independence_counts.distinct_model_ids, 1);
    assert_eq!(compiled.independence_counts.distinct_gateways, 1);
    let summary = result
        .replay
        .events
        .iter()
        .find_map(|event| match &event.event {
            TriageRunEventPayloadV2::Reconciliation { summary } => Some(summary),
            _ => None,
        })
        .unwrap();
    assert_eq!(summary.completed_role_slots, 2);
    assert_eq!(summary.distinct_models, 1);
    assert_eq!(summary.distinct_gateways, 1);
}

#[test]
fn optional_dropout_does_not_swallow_cancel_or_timeout_boundaries() {
    for (cancel, expected) in [
        (true, TriageAttemptStatus::Cancelled),
        (false, TriageAttemptStatus::TimedOut),
    ] {
        let policy = policy();
        let mut facts = preflight(&policy);
        facts
            .roles
            .iter_mut()
            .find(|fact| fact.slot_id == "challenge")
            .unwrap()
            .available = false;
        let mut input = input();
        if cancel {
            input.control.cancel_at_slot = Some(1);
        } else {
            input.control.timeout_at_slot = Some(1);
        }
        let result = MockTriageRunner::new(MockRoleScript::new())
            .run(&policy, &facts, &input)
            .unwrap();
        let role_attempts = attempts(&result.replay);
        assert_eq!(role_attempts.len(), 4);
        assert_eq!(role_attempts[0].status, TriageAttemptStatus::Unavailable);
        assert_eq!(role_attempts[1].status, TriageAttemptStatus::NotAdmitted);
        assert_eq!(role_attempts[2].status, expected);
        assert_eq!(role_attempts[3].status, expected);
        assert!(result.replay.events.last().unwrap().event.is_terminal());
    }
}

#[test]
fn budget_and_terminal_reserve_oversubscription_prevents_all_role_calls() {
    for mutate in ["whole_turn_calls", "terminal_reserve"] {
        let mut policy = policy();
        if mutate == "whole_turn_calls" {
            policy.budget.max_provider_calls = 1;
        } else {
            policy.budget.whole_turn_deadline_ms = Some(100_000);
        }
        let calls = Arc::new(Mutex::new(Vec::new()));
        let executor = RecordingExecutor {
            calls: Arc::clone(&calls),
            fail_slot: None,
        };
        let result = MockTriageRunner::new(executor)
            .run(&policy, &preflight(&policy), &input())
            .unwrap();
        assert!(result.compiled.is_err(), "mutation {mutate} must reject");
        assert!(calls.lock().unwrap().is_empty());
        assert!(attempts(&result.replay)
            .iter()
            .all(|attempt| attempt.status == TriageAttemptStatus::NotAdmitted));
    }
}

#[test]
fn malformed_cheap_model_reason_code_fails_closed_at_sdk_boundary() {
    let malformed = (0..65).map(|index| format!("reason-{index}")).collect();
    let script = MockRoleScript::new().with_outcome(
        "observe",
        MockRoleOutcome::Invalid {
            reason_codes: malformed,
            elapsed_ms: 1,
            input_chars: 1,
            output_chars: 1,
        },
    );
    let error = MockTriageRunner::new(script)
        .run(&policy(), &preflight(&policy()), &input())
        .unwrap_err();
    assert_eq!(error, TriageContractError::PayloadTooLarge);
}

#[test]
fn replay_rejects_reordered_events_and_duplicate_terminal_delivery() {
    let script = MockRoleScript::new()
        .with_outcome("observe", MockRoleOutcome::completed())
        .with_outcome("finalize", MockRoleOutcome::completed());
    let baseline = MockTriageRunner::new(script)
        .run(&policy(), &preflight(&policy()), &input())
        .unwrap()
        .replay;

    let mut reordered = baseline.clone();
    reordered.events.swap(1, 2);
    assert_eq!(
        reordered.validate(),
        Err(TriageContractError::InvalidPhaseOrder)
    );

    let mut duplicated = baseline.clone();
    let terminal = duplicated.events.last().unwrap().clone();
    duplicated.events.push(terminal);
    duplicated.events.last_mut().unwrap().sequence = duplicated.events.len() as u64 - 1;
    assert_eq!(
        duplicated.validate(),
        Err(TriageContractError::EventAfterTerminal)
    );
}

#[test]
fn share_safe_projection_rejects_owner_only_material_and_model_identity() {
    let script = MockRoleScript::new()
        .with_outcome("observe", MockRoleOutcome::completed())
        .with_outcome("finalize", MockRoleOutcome::completed());
    let result = MockTriageRunner::new(script)
        .run(&policy(), &preflight(&policy()), &input())
        .unwrap();
    let owner_event = result.replay.events[2].clone();
    let mut share_event = owner_event;
    share_event.privacy = PacketPrivacyBoundary::ShareSafe;
    assert_eq!(
        share_event.validate(),
        Err(TriageContractError::PrivacyLeak)
    );

    let terminal_result = result
        .replay
        .events
        .iter()
        .find_map(|event| match &event.event {
            TriageRunEventPayloadV2::Completed { result } => Some(result),
            _ => None,
        })
        .unwrap();
    let mut share_summary = terminal_result.share_safe_summary();
    share_summary.reason_codes.push("authorization".into());
    assert_eq!(
        share_summary.validate(),
        Err(TriageContractError::PrivacyLeak)
    );
}
