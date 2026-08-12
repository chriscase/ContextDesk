//! Adversarial hermetic audit of the V2 → production contribution adapter.
//!
//! Entry point: [`prepare_v2_contribution_runtime`].
//! No credentials, network, or second protocol. ScriptedBackend only.

use std::sync::Arc;

use cd_core::agent::ScriptedBackend;
use cd_core::fast_triage::FastTriageNeighborhoodBudget;
use cd_core::model_ref::ModelRef;
use cd_core::multi_model::triage_policy::{
    ContributorSlotV2, FinalizerSlotV2, ReviewerConditionV2, ReviewerSlotV2, RolePreflightV2,
    RoleQualificationV2, RoleRequirement, TriageContributorRole, TriagePolicyMode,
    TriagePolicyPreflightV2, TriagePolicyV2, TriageSlotKindV2, TRIAGE_POLICY_SCHEMA_V2,
};
use cd_core::triage_sdk::{TriageRunEventPayloadV2, TRIAGE_REPLAY_SCHEMA_V1};
use cd_workflow::triage::{
    MockPacket, MockRoleOutcome, MockRoleScript, MockRunControl, MockRunInput, MockTriageRunner,
};
use cd_workflow::triage_production::{
    prepare_v2_contribution_runtime, AuthorizedTriageBackendV1, TriageProductionAdapterErrorV1,
    TriageProductionAdapterRejectionV1,
};

const HOST_DEADLINE_MS: u64 = 60_000;

fn model(profile: &str, model_id: &str) -> ModelRef {
    ModelRef {
        profile_id: profile.into(),
        model_id: model_id.into(),
    }
}

fn contributor_policy(roles: &[TriageContributorRole]) -> TriagePolicyV2 {
    let mut policy = TriagePolicyV2 {
        schema_id: TRIAGE_POLICY_SCHEMA_V2.into(),
        mode: TriagePolicyMode::Enhanced,
        contributors: roles
            .iter()
            .enumerate()
            .map(|(index, role)| ContributorSlotV2 {
                slot_id: format!("slot-{index}"),
                role: *role,
                model: model(
                    &format!("profile-{index}"),
                    &format!("catalog/model-{index}"),
                ),
                requirement: RoleRequirement::Required,
                allow_remote: false,
            })
            .collect(),
        finalizer: None,
        reviewer: None,
        budget: Default::default(),
        execution: Default::default(),
    };
    policy.budget.whole_turn_deadline_ms = Some(HOST_DEADLINE_MS);
    // Production adapter rejects per-contributor caps smaller than host deadline.
    policy.budget.contributors.operation_timeout_ms = HOST_DEADLINE_MS;
    policy
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

fn empty_backend(slot: &ContributorSlotV2) -> AuthorizedTriageBackendV1 {
    AuthorizedTriageBackendV1 {
        slot_id: slot.slot_id.clone(),
        model: slot.model.clone(),
        backend: Arc::new(ScriptedBackend::new(vec![])),
    }
}

fn neighborhood() -> FastTriageNeighborhoodBudget {
    FastTriageNeighborhoodBudget::default()
}

fn reject_category(err: &TriageProductionAdapterErrorV1) -> TriageProductionAdapterRejectionV1 {
    match err {
        TriageProductionAdapterErrorV1::Unsupported { category, .. } => *category,
        other => panic!("expected Unsupported, got {}", other.category()),
    }
}

/// M-A1: finalizer cannot be silently approximated by the production adapter.
#[test]
fn ma1_finalizer_unsupported_fail_closed() {
    let mut policy = contributor_policy(&[TriageContributorRole::ObservationExtractor]);
    policy.finalizer = Some(FinalizerSlotV2 {
        slot_id: "finalizer".into(),
        model: model("primary", "catalog/finalizer"),
        requirement: RoleRequirement::Required,
        allow_remote: false,
    });
    policy.budget.finalizer.reserve_ms = HOST_DEADLINE_MS / 2;
    policy.budget.finalizer.operation_timeout_ms = HOST_DEADLINE_MS / 2;
    policy.budget.finalizer.max_provider_calls = 1;
    policy.budget.finalizer.max_context_chars = 10_000;
    let err = prepare_v2_contribution_runtime(
        &policy,
        &preflight(&policy),
        vec![empty_backend(&policy.contributors[0])],
        HOST_DEADLINE_MS,
        50_000,
        neighborhood(),
    )
    .expect_err("finalizer must not silently map");
    assert_eq!(
        reject_category(&err),
        TriageProductionAdapterRejectionV1::FinalizerUnsupported
    );
}

/// M-A2: reviewer cannot be silently approximated.
#[test]
fn ma2_reviewer_unsupported_fail_closed() {
    let mut policy = contributor_policy(&[TriageContributorRole::ObservationExtractor]);
    policy.reviewer = Some(ReviewerSlotV2 {
        slot_id: "reviewer".into(),
        model: model("reviewer", "catalog/reviewer"),
        condition: ReviewerConditionV2::ContestedOrIncomplete,
        requirement: RoleRequirement::Optional,
        allow_remote: false,
    });
    policy.budget.reviewer.reserve_ms = HOST_DEADLINE_MS / 2;
    policy.budget.reviewer.operation_timeout_ms = HOST_DEADLINE_MS / 2;
    policy.budget.reviewer.max_provider_calls = 1;
    policy.budget.reviewer.max_context_chars = 10_000;
    let err = prepare_v2_contribution_runtime(
        &policy,
        &preflight(&policy),
        vec![empty_backend(&policy.contributors[0])],
        HOST_DEADLINE_MS,
        50_000,
        neighborhood(),
    )
    .expect_err("reviewer must not silently map");
    assert_eq!(
        reject_category(&err),
        TriageProductionAdapterRejectionV1::ReviewerUnsupported
    );
}

/// M-A3: hidden model substitution via backend binding mismatch fails closed.
#[test]
fn ma3_backend_binding_mismatch_is_hidden_model_substitution() {
    let policy = contributor_policy(&[TriageContributorRole::ObservationExtractor]);
    let mut backend = empty_backend(&policy.contributors[0]);
    backend.model = model("other", "catalog/substituted");
    let err = prepare_v2_contribution_runtime(
        &policy,
        &preflight(&policy),
        vec![backend],
        HOST_DEADLINE_MS,
        50_000,
        neighborhood(),
    )
    .expect_err("exact model binding");
    assert_eq!(
        reject_category(&err),
        TriageProductionAdapterRejectionV1::BackendBindingMismatch
    );
}

/// M-A4: optional degraded slot is not erased into a success path.
#[test]
fn ma4_degraded_optional_slot_unsupported_not_erased() {
    let mut policy = contributor_policy(&[
        TriageContributorRole::ObservationExtractor,
        TriageContributorRole::CausalProposer,
    ]);
    policy.contributors[1].requirement = RoleRequirement::Optional;
    let mut facts = preflight(&policy);
    facts.roles[1].available = false;
    let err = prepare_v2_contribution_runtime(
        &policy,
        &facts,
        vec![empty_backend(&policy.contributors[0])],
        HOST_DEADLINE_MS,
        50_000,
        neighborhood(),
    )
    .expect_err("degraded optional must not be omitted silently");
    assert_eq!(
        reject_category(&err),
        TriageProductionAdapterRejectionV1::DegradedSlotUnsupported
    );
}

/// M-A5: MockTriageRunner ordered stream: packet → roles → recon → validation → terminal.
#[test]
fn ma5_mock_runner_ordered_graph_before_terminal() {
    // Standard policy: finalizer-only; mock still emits ordered graph events.
    let policy = TriagePolicyV2::standard(model("local", "mistral:latest"), false);
    let facts = {
        let mut p = preflight(&policy);
        // standard() has only finalizer
        p.roles = vec![RolePreflightV2 {
            slot_id: policy.finalizer.as_ref().unwrap().slot_id.clone(),
            model: policy.finalizer.as_ref().unwrap().model.clone(),
            kind: TriageSlotKindV2::Finalizer,
            available: true,
            qualification: RoleQualificationV2::Qualified,
            remote: false,
        }];
        p
    };
    let script = MockRoleScript::new().with_outcome(
        &policy.finalizer.as_ref().unwrap().slot_id,
        MockRoleOutcome::completed(),
    );
    let input = MockRunInput {
        run_id: "run:mock:audit".into(),
        request_fingerprint: "req:mock:audit".into(),
        policy_fingerprint: "pol:mock:audit".into(),
        packet: MockPacket {
            packet_id: "packet:mock:audit".into(),
            packet_digest: "digest:mock:audit".into(),
            evidence_count: 1,
        },
        cancellation_id: "cancel:mock:audit".into(),
        control: MockRunControl::default(),
    };
    let result = MockTriageRunner::new(script)
        .run(&policy, &facts, &input)
        .expect("mock run");
    result.replay.validate().expect("replay valid");
    assert_eq!(result.replay.schema_id, TRIAGE_REPLAY_SCHEMA_V1);

    let kinds: Vec<&'static str> = result
        .replay
        .events
        .iter()
        .map(|e| match &e.event {
            TriageRunEventPayloadV2::RunStarted { .. } => "started",
            TriageRunEventPayloadV2::PacketReady { .. } => "packet",
            TriageRunEventPayloadV2::RoleAttempt { .. } => "role",
            TriageRunEventPayloadV2::Reconciliation { .. } => "recon",
            TriageRunEventPayloadV2::Validation { .. } => "validation",
            TriageRunEventPayloadV2::Completed { .. } => "completed",
            TriageRunEventPayloadV2::Failed { .. } => "failed",
            TriageRunEventPayloadV2::TimedOut { .. } => "timeout",
            TriageRunEventPayloadV2::Cancelled { .. } => "cancelled",
        })
        .collect();
    assert_eq!(kinds.first().copied(), Some("started"));
    assert_eq!(kinds.get(1).copied(), Some("packet"));
    assert!(kinds.contains(&"recon"));
    assert!(kinds.contains(&"validation"));
    let recon_i = kinds.iter().position(|k| *k == "recon").unwrap();
    let val_i = kinds.iter().position(|k| *k == "validation").unwrap();
    let term_i = kinds.len() - 1;
    assert!(recon_i < val_i);
    assert!(val_i < term_i);
    assert!(result.replay.events.last().unwrap().event.is_terminal());
    assert_eq!(
        result
            .replay
            .events
            .iter()
            .filter(|e| e.event.is_terminal())
            .count(),
        1
    );
}
