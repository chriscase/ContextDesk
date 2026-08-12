//! Adversarial hermetic audit of Triage Policy V2 semantic-bypass classes.
//!
//! Drives **shipped** entry points only:
//! - [`compile_triage_policy_v2`]
//! - [`run_contribution_pipeline`]
//! - [`TriageReplayV1`] / [`ShareSafeTriageResultV2`] / [`TriageRunEventV2`]
//!
//! No live providers, credentials, or second protocol. ScriptedBackend only.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use cd_core::agent::ScriptedBackend;
use cd_core::chat::ChatCompletion;
use cd_core::extension_contract::PacketPrivacyBoundary;
use cd_core::fast_triage::FastTriagePacketV1;
use cd_core::investigation_answer::{
    AnswerBindingV1, EvidenceRole, HostEvidenceEntry, HostEvidenceLedger, LogSnapshotRevisionV1,
};
use cd_core::model_ref::ModelRef;
use cd_core::multi_model::triage_policy::{
    compile_triage_policy_v2, ContributorSlotV2, FinalizerSlotV2, PolicyRejectionCategoryV2,
    ReviewerConditionV2, ReviewerSlotV2, RolePreflightV2, RoleQualificationV2, RoleRequirement,
    SlotDispositionV2, TriageBudgetV2, TriageContributorRole, TriageExecutionPolicyV1,
    TriagePolicyMode, TriagePolicyPreflightV2, TriagePolicyV2, TriageSlotKindV2,
    TRIAGE_POLICY_SCHEMA_V2,
};
use cd_core::multi_model::{
    run_contribution_pipeline, ContributionAvailability, ContributionBackendSlot,
    ContributionDegradationReason, ContributionIdentity, ContributionPipelineInputs,
    ContributionQualification, ContributionRole, ContributionRoutingError, ContributionRoutingPlan,
    ContributionRoutingPolicy, MultiModelBudget,
};
use cd_core::triage_sdk::{
    ShareSafeTriageResultV2, TriageAttemptStatus, TriageContractError, TriageReconciliationV1,
    TriageReplayV1, TriageResultKind, TriageResultV2, TriageRoleAttemptV1, TriageRunEventPayloadV2,
    TriageRunEventV2, TriageValidationState, MAX_TRIAGE_REASON_CODES, TRIAGE_REPLAY_SCHEMA_V1,
    TRIAGE_RESULT_SCHEMA_V2, TRIAGE_RUN_EVENT_SCHEMA_V2, TRIAGE_SHARE_SAFE_RESULT_SCHEMA_V2,
};
use serde_json::json;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

fn model(profile: &str, model_id: &str) -> ModelRef {
    ModelRef {
        profile_id: profile.into(),
        model_id: model_id.into(),
    }
}

fn facts(policy: &TriagePolicyV2) -> TriagePolicyPreflightV2 {
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

fn enhanced_two_contributors_same_model() -> TriagePolicyV2 {
    let shared = model("gw-a", "catalog/exact-model");
    TriagePolicyV2 {
        schema_id: TRIAGE_POLICY_SCHEMA_V2.into(),
        mode: TriagePolicyMode::Enhanced,
        contributors: vec![
            ContributorSlotV2 {
                slot_id: "observe".into(),
                role: TriageContributorRole::ObservationExtractor,
                model: shared.clone(),
                requirement: RoleRequirement::Required,
                allow_remote: false,
            },
            ContributorSlotV2 {
                slot_id: "causal".into(),
                role: TriageContributorRole::CausalProposer,
                model: shared,
                requirement: RoleRequirement::Required,
                allow_remote: false,
            },
        ],
        finalizer: Some(FinalizerSlotV2 {
            slot_id: "finalize".into(),
            model: model("gw-a", "catalog/exact-model"),
            requirement: RoleRequirement::Optional,
            allow_remote: false,
        }),
        reviewer: None,
        budget: TriageBudgetV2::default(),
        execution: TriageExecutionPolicyV1::default(),
    }
}

fn packet() -> FastTriagePacketV1 {
    let revision = LogSnapshotRevisionV1 {
        event_revision: 1,
        template_analysis_revision: 1,
        suppression_revision: 1,
    };
    let entries = vec![
        HostEvidenceEntry {
            evidence_id: "opaque-a".into(),
            candidate_id: "candidate-a".into(),
            source_label: "a.log".into(),
            locator: "seq=10".into(),
            corpus_id: "corpus".into(),
            revision,
            role: EvidenceRole::Cause,
            content: "cause".into(),
        },
        HostEvidenceEntry {
            evidence_id: "opaque-b".into(),
            candidate_id: "candidate-b".into(),
            source_label: "b.log".into(),
            locator: "seq=20".into(),
            corpus_id: "corpus".into(),
            revision,
            role: EvidenceRole::Symptom,
            content: "symptom".into(),
        },
    ];
    let binding = AnswerBindingV1 {
        session_id: "session".into(),
        turn_id: "turn".into(),
        corpus_id: "corpus".into(),
        revision,
        ledger_digest: HostEvidenceLedger::digest(&entries),
    };
    FastTriagePacketV1::from_ledger(
        HostEvidenceLedger::new(binding, entries).unwrap(),
        None,
        true,
    )
}

fn identity(model: &str) -> ContributionIdentity {
    ContributionIdentity {
        profile_id: "profile".into(),
        model: model.into(),
    }
}

fn response(
    packet: &FastTriagePacketV1,
    role: ContributionRole,
    claims: serde_json::Value,
) -> ChatCompletion {
    ChatCompletion::from_parts(
        json!({
            "schema": cd_core::multi_model::CONTRIBUTION_SCHEMA_V1,
            "packet_id": packet.packet_id(),
            "role": role,
            "claims": claims,
        })
        .to_string(),
        Vec::new(),
        "stop",
    )
}

fn slot(
    role: ContributionRole,
    model: &str,
    qualification: ContributionQualification,
    backend: ScriptedBackend,
) -> ContributionBackendSlot {
    ContributionBackendSlot {
        role,
        identity: identity(model),
        qualification,
        backend: Arc::new(backend),
    }
}

fn budget() -> MultiModelBudget {
    MultiModelBudget {
        max_total_provider_rounds: 4,
        context_char_budget: 100_000,
        ..Default::default()
    }
}

fn claim_obs() -> serde_json::Value {
    json!([{
        "claim_id":"o","candidate_id":"candidate-a","kind":"observation",
        "text":"seen","evidence_ids":["opaque-a"]
    }])
}

fn claim_causal() -> serde_json::Value {
    json!([{
        "claim_id":"c","candidate_id":"candidate-a","kind":"causal_candidate",
        "text":"possible","evidence_ids":["opaque-a"]
    }])
}

// ---------------------------------------------------------------------------
// Compiler mutations
// ---------------------------------------------------------------------------

/// M1: same ModelRef must never inflate independent consensus counts.
#[test]
fn m1_same_model_ref_is_one_independence_group_not_false_consensus() {
    let policy = enhanced_two_contributors_same_model();
    let compiled = compile_triage_policy_v2(&policy, &facts(&policy)).expect("compile");
    assert_eq!(compiled.independence_counts.role_slots, 3);
    assert_eq!(
        compiled.independence_counts.distinct_model_refs, 1,
        "same ModelRef must not be counted as independent consensus"
    );
    assert_eq!(compiled.independence_groups.len(), 1);
    assert_eq!(compiled.independence_groups[0].slot_ids.len(), 3);
}

/// M2: preflight model/kind mismatch is binding failure (hidden substitution).
#[test]
fn m2_stale_or_mismatched_qualification_and_hidden_model_substitution_fail() {
    let policy = enhanced_two_contributors_same_model();
    let mut preflight = facts(&policy);
    preflight.roles[0].model = model("other-gateway", "catalog/substituted");
    let failure = compile_triage_policy_v2(&policy, &preflight).expect_err("must reject");
    assert!(failure.rejections.iter().any(|r| {
        r.category == PolicyRejectionCategoryV2::PreflightBindingMismatch
            && r.slot_id.as_deref() == Some("observe")
    }));

    let mut preflight = facts(&policy);
    preflight.roles[0].qualification = RoleQualificationV2::Unqualified;
    let failure = compile_triage_policy_v2(&policy, &preflight).expect_err("unqualified");
    assert!(failure.rejections.iter().any(|r| {
        r.category == PolicyRejectionCategoryV2::QualificationUnavailable
            && r.slot_id.as_deref() == Some("observe")
    }));
    let observe = failure
        .slots
        .iter()
        .find(|s| s.slot_id == "observe")
        .expect("slot recorded");
    assert_eq!(observe.disposition, SlotDispositionV2::RequiredRejected);

    // Stale qualification is also a fail-closed preflight fact.
    let mut preflight = facts(&policy);
    preflight.roles[0].qualification = RoleQualificationV2::Stale;
    assert!(compile_triage_policy_v2(&policy, &preflight).is_err());
}

/// M3: required-role failure never compiles as success.
#[test]
fn m3_required_role_failure_never_silently_succeeds() {
    let policy = enhanced_two_contributors_same_model();
    let mut preflight = facts(&policy);
    preflight.roles[0].available = false;
    let failure = compile_triage_policy_v2(&policy, &preflight).expect_err("required unavailable");
    assert!(failure.rejections.iter().any(|r| {
        r.category == PolicyRejectionCategoryV2::RoleUnavailable
            && r.slot_id.as_deref() == Some("observe")
    }));
    assert!(
        failure
            .slots
            .iter()
            .any(|s| s.disposition == SlotDispositionV2::RequiredRejected),
        "required dropout must be RequiredRejected, not Admitted"
    );
}

/// M4: optional dropout remains visible and policy can still compile.
#[test]
fn m4_optional_dropout_is_visible_not_erased() {
    let mut policy = enhanced_two_contributors_same_model();
    policy.contributors[1].requirement = RoleRequirement::Optional;
    let mut preflight = facts(&policy);
    preflight.roles[1].available = false;
    let compiled = compile_triage_policy_v2(&policy, &preflight).expect("optional degrades");
    let causal = compiled
        .slots
        .iter()
        .find(|s| s.slot_id == "causal")
        .expect("causal retained");
    assert_eq!(causal.disposition, SlotDispositionV2::OptionalDegraded);
    assert!(!causal.rejections.is_empty());
    assert!(compiled
        .slots
        .iter()
        .any(|s| s.slot_id == "observe" && s.disposition == SlotDispositionV2::Admitted));
}

/// M5: phase/call/context/reserve oversubscription fails closed.
#[test]
fn m5_budget_oversubscription_fails_closed() {
    let mut policy = enhanced_two_contributors_same_model();
    policy.budget.contributors.max_provider_calls = 1;
    let failure = compile_triage_policy_v2(&policy, &facts(&policy)).expect_err("under-cap");
    assert!(failure
        .rejections
        .iter()
        .any(|r| { r.category == PolicyRejectionCategoryV2::ProviderCallBudgetInsufficient }));

    // Terminal reserves that cannot fit an explicit deadline.
    let mut policy = enhanced_two_contributors_same_model();
    policy.reviewer = Some(ReviewerSlotV2 {
        slot_id: "review".into(),
        model: model("gw-b", "catalog/reviewer"),
        condition: ReviewerConditionV2::ContestedOrIncomplete,
        requirement: RoleRequirement::Optional,
        allow_remote: false,
    });
    policy.budget.whole_turn_deadline_ms = Some(200_000);
    let failure = compile_triage_policy_v2(&policy, &facts(&policy)).expect_err("reserve");
    assert!(failure
        .rejections
        .iter()
        .any(|r| r.category == PolicyRejectionCategoryV2::InvalidBudget));

    // Context-char oversubscription: phase char sum exceeds whole-turn ceiling.
    // validate_budget rejects when phase_chars > budget.max_context_chars.
    let mut policy = enhanced_two_contributors_same_model();
    policy.budget.max_context_chars = 100_000;
    policy.budget.contributors.max_context_chars = 80_000;
    policy.budget.corrections.max_context_chars = 40_000; // 80k+40k+finalizer > 100k
                                                          // Finalizer is present with default max_context_chars; keep it positive so
                                                          // the invalid path is oversubscription, not zero terminal chars.
    policy.budget.finalizer.max_context_chars = 10_000;
    policy.budget.finalizer.max_provider_calls = 1;
    policy.budget.finalizer.operation_timeout_ms = 30_000;
    let failure = compile_triage_policy_v2(&policy, &facts(&policy)).expect_err("context oversub");
    assert!(
        failure
            .rejections
            .iter()
            .any(|r| r.category == PolicyRejectionCategoryV2::InvalidBudget),
        "phase context chars exceeding whole-turn max must fail closed: {failure:?}"
    );
}

// ---------------------------------------------------------------------------
// Contribution pipeline
// ---------------------------------------------------------------------------

/// M6: reviewer is a second phase after preliminary reconciliation, never a peer.
#[tokio::test]
async fn m6_reviewer_phase_only_after_escalation_not_before_recon() {
    let pkt = packet();
    let observation = slot(
        ContributionRole::ObservationExtractor,
        "fast-a",
        ContributionQualification::Qualified,
        ScriptedBackend::new(vec![response(
            &pkt,
            ContributionRole::ObservationExtractor,
            claim_obs(),
        )]),
    );
    let causal = slot(
        ContributionRole::CausalProposer,
        "fast-b",
        ContributionQualification::Qualified,
        ScriptedBackend::new(vec![response(
            &pkt,
            ContributionRole::CausalProposer,
            claim_causal(),
        )]),
    );
    // Empty script: accidental early execution panics / fails loudly.
    let reviewer = slot(
        ContributionRole::Reviewer,
        "reviewer",
        ContributionQualification::Qualified,
        ScriptedBackend::new(vec![]),
    );
    let slots = vec![observation, causal, reviewer];
    let plan = ContributionRoutingPlan::new(
        vec![
            ContributionRole::ObservationExtractor,
            ContributionRole::CausalProposer,
            ContributionRole::Reviewer,
        ],
        ContributionRoutingPolicy {
            max_rounds: 2,
            reviewer_enabled: true,
            ..Default::default()
        },
    )
    .unwrap();
    let mut events = Vec::new();
    let outcome = run_contribution_pipeline(
        ContributionPipelineInputs {
            user_text: "why?",
            packet: &pkt,
            slots: &slots,
            budget: budget(),
            deadline_ms: 10_000,
            started_at: None,
            cancel: None,
            plan: &plan,
        },
        &mut |event| events.push(event),
    )
    .await
    .unwrap();

    assert_eq!(
        outcome.attempts[2].availability,
        ContributionAvailability::NotAdmitted
    );
    assert_eq!(
        outcome.telemetry.stages[2].degradation,
        Some(ContributionDegradationReason::ReviewerNotRequired)
    );
    assert!(!outcome.telemetry.escalation_recommended);

    let roles_started: Vec<_> = events
        .iter()
        .filter(|e| e.started)
        .map(|e| e.role)
        .collect();
    let obs = roles_started
        .iter()
        .position(|r| *r == ContributionRole::ObservationExtractor);
    let rev = roles_started
        .iter()
        .position(|r| *r == ContributionRole::Reviewer);
    // Without escalation the reviewer is not "started" as a provider phase.
    assert!(obs.is_some());
    assert!(
        rev.is_none(),
        "reviewer must not start when escalation is not recommended"
    );
}

/// M7: reviewer-before-final plan slot is rejected before any call.
#[test]
fn m7_reviewer_not_final_plan_slot_rejected_at_routing() {
    let err = ContributionRoutingPlan::new(
        vec![
            ContributionRole::Reviewer,
            ContributionRole::ObservationExtractor,
        ],
        Default::default(),
    )
    .expect_err("reviewer must be final");
    assert_eq!(err, ContributionRoutingError::ReviewerNotFinal);
}

/// M8: unqualified slot never becomes a successful attempt.
#[tokio::test]
async fn m8_unqualified_slot_is_unavailable_not_success() {
    let pkt = packet();
    let observation = slot(
        ContributionRole::ObservationExtractor,
        "fast-a",
        ContributionQualification::Unqualified,
        ScriptedBackend::new(vec![response(
            &pkt,
            ContributionRole::ObservationExtractor,
            claim_obs(),
        )]),
    );
    let plan = ContributionRoutingPlan::new(
        vec![ContributionRole::ObservationExtractor],
        Default::default(),
    )
    .unwrap();
    let outcome = run_contribution_pipeline(
        ContributionPipelineInputs {
            user_text: "why?",
            packet: &pkt,
            slots: &[observation],
            budget: budget(),
            deadline_ms: 10_000,
            started_at: None,
            cancel: None,
            plan: &plan,
        },
        &mut |_| {},
    )
    .await
    .unwrap();
    assert_eq!(outcome.attempts.len(), 1);
    assert_eq!(
        outcome.attempts[0].availability,
        ContributionAvailability::Unavailable
    );
    assert_eq!(
        outcome.telemetry.stages[0].degradation,
        Some(ContributionDegradationReason::QualificationUnavailable)
    );
    assert_eq!(outcome.telemetry.stages[0].provider_rounds, 0);
    assert!(!outcome.envelope.answer.root_cause_established);
}

/// M9: cancel stops remaining slots including a trailing reviewer.
#[tokio::test]
async fn m9_cancel_skips_remaining_including_reviewer() {
    let pkt = packet();
    let cancel = Arc::new(AtomicBool::new(true));
    let observation = slot(
        ContributionRole::ObservationExtractor,
        "fast-a",
        ContributionQualification::Qualified,
        ScriptedBackend::new(vec![response(
            &pkt,
            ContributionRole::ObservationExtractor,
            claim_obs(),
        )]),
    );
    let causal = slot(
        ContributionRole::CausalProposer,
        "fast-b",
        ContributionQualification::Qualified,
        ScriptedBackend::new(vec![response(
            &pkt,
            ContributionRole::CausalProposer,
            claim_causal(),
        )]),
    );
    let reviewer = slot(
        ContributionRole::Reviewer,
        "reviewer",
        ContributionQualification::Qualified,
        ScriptedBackend::new(vec![]),
    );
    let plan = ContributionRoutingPlan::new(
        vec![
            ContributionRole::ObservationExtractor,
            ContributionRole::CausalProposer,
            ContributionRole::Reviewer,
        ],
        ContributionRoutingPolicy {
            max_rounds: 2,
            reviewer_enabled: true,
            ..Default::default()
        },
    )
    .unwrap();
    let outcome = run_contribution_pipeline(
        ContributionPipelineInputs {
            user_text: "why?",
            packet: &pkt,
            slots: &[observation, causal, reviewer],
            budget: budget(),
            deadline_ms: 10_000,
            started_at: None,
            cancel: Some(Arc::clone(&cancel)),
            plan: &plan,
        },
        &mut |_| {},
    )
    .await
    .unwrap();
    assert_eq!(outcome.attempts.len(), 3);
    assert!(outcome.attempts.iter().all(|a| {
        a.availability == ContributionAvailability::Cancelled && a.contribution.is_none()
    }));
    assert!(outcome
        .telemetry
        .stages
        .iter()
        .all(|s| s.provider_rounds == 0));
    let _ = cancel.load(Ordering::SeqCst);
}

/// M10: slot order / multiplicity mismatch fails before provider I/O.
#[tokio::test]
async fn m10_slot_order_mismatch_fails_before_calls() {
    let pkt = packet();
    let a = slot(
        ContributionRole::CausalProposer,
        "m",
        ContributionQualification::Qualified,
        ScriptedBackend::new(vec![]),
    );
    let b = slot(
        ContributionRole::ObservationExtractor,
        "m2",
        ContributionQualification::Qualified,
        ScriptedBackend::new(vec![]),
    );
    let plan = ContributionRoutingPlan::new(
        vec![
            ContributionRole::ObservationExtractor,
            ContributionRole::CausalProposer,
        ],
        Default::default(),
    )
    .unwrap();
    let result = run_contribution_pipeline(
        ContributionPipelineInputs {
            user_text: "why?",
            packet: &pkt,
            slots: &[a, b],
            budget: budget(),
            deadline_ms: 10_000,
            started_at: None,
            cancel: None,
            plan: &plan,
        },
        &mut |_| {},
    )
    .await;
    let err = match result {
        Err(error) => error,
        Ok(_) => panic!("role multiplicity/order mismatch must fail before calls"),
    };
    assert!(err.to_string().contains("slot_order_mismatch"));
}

// ---------------------------------------------------------------------------
// SDK / replay / share-safe
// ---------------------------------------------------------------------------

fn base_event(seq: u64, event: TriageRunEventPayloadV2) -> TriageRunEventV2 {
    TriageRunEventV2 {
        schema_id: TRIAGE_RUN_EVENT_SCHEMA_V2.into(),
        run_id: "run:audit:01".into(),
        sequence: seq,
        privacy: PacketPrivacyBoundary::OwnerOnly,
        event,
    }
}

fn minimal_recon() -> TriageReconciliationV1 {
    // Counts must satisfy: completed <= configured, distinct_models <= completed,
    // distinct_gateways <= distinct_models (see TriageReconciliationV1::validate).
    TriageReconciliationV1 {
        state: "insufficient_evidence".into(),
        configured_role_slots: 2,
        completed_role_slots: 1,
        distinct_models: 1,
        distinct_gateways: 1,
        supported_claim_ids: vec![],
        conflict_ids: vec![],
        gap_ids: vec!["gap:1".into()],
        root_cause_established: false,
    }
}

fn partial_result() -> TriageResultV2 {
    TriageResultV2 {
        schema_id: TRIAGE_RESULT_SCHEMA_V2.into(),
        run_id: "run:audit:01".into(),
        kind: TriageResultKind::HonestPartial,
        validation_state: TriageValidationState::Partial,
        packet_id: "packet:audit:01".into(),
        reconciliation: minimal_recon(),
        answer: None,
        accepted_evidence_ids: vec!["evidence:01".into()],
        reason_codes: vec!["required_role_unavailable".into()],
    }
}

/// M11: reordered / non-contiguous sequences and post-terminal events fail.
#[test]
fn m11_duplicate_reordered_or_post_terminal_events_fail_closed() {
    let started = base_event(
        0,
        TriageRunEventPayloadV2::RunStarted {
            request_fingerprint: "req:audit:01".into(),
            policy_fingerprint: "pol:audit:01".into(),
        },
    );
    let packet = base_event(
        1,
        TriageRunEventPayloadV2::PacketReady {
            packet_id: "packet:audit:01".into(),
            packet_digest: "digest:audit:01".into(),
            evidence_count: 1,
        },
    );
    let recon = base_event(
        2,
        TriageRunEventPayloadV2::Reconciliation {
            summary: minimal_recon(),
        },
    );
    let validation = base_event(
        3,
        TriageRunEventPayloadV2::Validation {
            passed: false,
            reason_codes: vec!["mock".into()],
        },
    );
    let terminal = base_event(
        4,
        TriageRunEventPayloadV2::Completed {
            result: Box::new(partial_result()),
        },
    );

    let mut bad_seq = terminal.clone();
    bad_seq.sequence = 99;
    let replay = TriageReplayV1 {
        schema_id: TRIAGE_REPLAY_SCHEMA_V1.into(),
        run_id: "run:audit:01".into(),
        request_fingerprint: "req:audit:01".into(),
        events: vec![
            started.clone(),
            packet.clone(),
            recon.clone(),
            validation.clone(),
            bad_seq,
        ],
    };
    assert!(matches!(
        replay.validate(),
        Err(TriageContractError::NonContiguousSequence)
    ));

    let after = base_event(
        5,
        TriageRunEventPayloadV2::Validation {
            passed: false,
            reason_codes: vec![],
        },
    );
    let replay = TriageReplayV1 {
        schema_id: TRIAGE_REPLAY_SCHEMA_V1.into(),
        run_id: "run:audit:01".into(),
        request_fingerprint: "req:audit:01".into(),
        events: vec![started, packet, recon, validation, terminal, after],
    };
    assert!(matches!(
        replay.validate(),
        Err(TriageContractError::EventAfterTerminal)
    ));
}

/// M12: dual terminals / missing terminal fail closed.
#[test]
fn m12_terminal_count_must_be_exactly_one() {
    let started = base_event(
        0,
        TriageRunEventPayloadV2::RunStarted {
            request_fingerprint: "req:audit:01".into(),
            policy_fingerprint: "pol:audit:01".into(),
        },
    );
    let replay = TriageReplayV1 {
        schema_id: TRIAGE_REPLAY_SCHEMA_V1.into(),
        run_id: "run:audit:01".into(),
        request_fingerprint: "req:audit:01".into(),
        events: vec![started],
    };
    assert!(matches!(
        replay.validate(),
        Err(TriageContractError::TerminalCount(0))
    ));
}

/// M13: share-safe surfaces refuse Completed full result and model identity leaks.
#[test]
fn m13_share_safe_refuses_owner_only_payloads_and_model_identity() {
    let result = partial_result();
    let share = result.share_safe_summary();
    assert_eq!(share.schema_id, TRIAGE_SHARE_SAFE_RESULT_SCHEMA_V2);
    share.validate().expect("clean share-safe ok");

    let completed = TriageRunEventV2 {
        schema_id: TRIAGE_RUN_EVENT_SCHEMA_V2.into(),
        run_id: "run:audit:01".into(),
        sequence: 0,
        privacy: PacketPrivacyBoundary::ShareSafe,
        event: TriageRunEventPayloadV2::Completed {
            result: Box::new(partial_result()),
        },
    };
    assert!(matches!(
        completed.validate(),
        Err(TriageContractError::PrivacyLeak)
    ));

    let attempt = TriageRunEventV2 {
        schema_id: TRIAGE_RUN_EVENT_SCHEMA_V2.into(),
        run_id: "run:audit:01".into(),
        sequence: 0,
        privacy: PacketPrivacyBoundary::ShareSafe,
        event: TriageRunEventPayloadV2::RoleAttempt {
            attempt: TriageRoleAttemptV1 {
                attempt_id: "attempt:01".into(),
                role_slot_id: "observe".into(),
                role: TriageSlotKindV2::Contributor(TriageContributorRole::ObservationExtractor),
                model: Some(model("profile:secret", "model:secret")),
                status: TriageAttemptStatus::Completed,
                reason_codes: vec![],
                elapsed_ms: 1,
                input_chars: 10,
                output_chars: 10,
            },
        },
    };
    assert!(matches!(
        attempt.validate(),
        Err(TriageContractError::PrivacyLeak)
    ));
}

/// M14: reason-code duplicates **and** overflow (>MAX_TRIAGE_REASON_CODES) fail closed.
#[test]
fn m14_reason_code_duplicates_and_overflow_fail_closed() {
    let mut result = partial_result();
    result.reason_codes = vec!["a".into(), "a".into()];
    assert!(matches!(
        result.validate(),
        Err(TriageContractError::InvalidField("reason_codes"))
    ));

    let mut share = ShareSafeTriageResultV2 {
        schema_id: TRIAGE_SHARE_SAFE_RESULT_SCHEMA_V2.into(),
        run_id: "run:audit:01".into(),
        kind: TriageResultKind::HonestPartial,
        validation_state: TriageValidationState::Partial,
        packet_id: "packet:audit:01".into(),
        reconciliation: minimal_recon(),
        accepted_evidence_ids: vec!["evidence:01".into()],
        reason_codes: vec!["dup".into(), "dup".into()],
    };
    assert!(matches!(
        share.validate(),
        Err(TriageContractError::InvalidField("reason_codes"))
    ));

    // Overflow: more than MAX_TRIAGE_REASON_CODES (64) unique opaque codes.
    let overflow: Vec<String> = (0..=MAX_TRIAGE_REASON_CODES)
        .map(|i| format!("code:{i}"))
        .collect();
    assert_eq!(overflow.len(), MAX_TRIAGE_REASON_CODES + 1);
    let mut result = partial_result();
    result.reason_codes = overflow.clone();
    assert!(
        matches!(result.validate(), Err(TriageContractError::PayloadTooLarge)),
        "result reason-code overflow must be PayloadTooLarge"
    );
    share.reason_codes = overflow;
    assert!(
        matches!(share.validate(), Err(TriageContractError::PayloadTooLarge)),
        "share-safe reason-code overflow must be PayloadTooLarge"
    );
}

/// M15: malformed path-shaped slot / attempt ids fail closed.
#[test]
fn m15_malformed_role_attempt_ids_fail_closed() {
    let attempt = TriageRoleAttemptV1 {
        attempt_id: "attempt:01".into(),
        role_slot_id: "../../etc/passwd".into(),
        role: TriageSlotKindV2::Contributor(TriageContributorRole::ObservationExtractor),
        model: None,
        status: TriageAttemptStatus::Completed,
        reason_codes: vec![],
        elapsed_ms: 0,
        input_chars: 0,
        output_chars: 0,
    };
    assert!(attempt.validate().is_err());
}

/// M16: malformed cheap-model / garbage provider body is explicit Malformed, not success.
#[tokio::test]
async fn m16_malformed_cheap_model_garbage_body_is_not_success() {
    let pkt = packet();
    let garbage = slot(
        ContributionRole::CausalProposer,
        "cheap-sloppy",
        ContributionQualification::Qualified,
        ScriptedBackend::new(vec![ChatCompletion::from_parts(
            "not json at all — garbage cheap-model output",
            vec![],
            "stop",
        )]),
    );
    let plan =
        ContributionRoutingPlan::new(vec![ContributionRole::CausalProposer], Default::default())
            .unwrap();
    let outcome = run_contribution_pipeline(
        ContributionPipelineInputs {
            user_text: "why?",
            packet: &pkt,
            slots: &[garbage],
            budget: budget(),
            deadline_ms: 10_000,
            started_at: None,
            cancel: None,
            plan: &plan,
        },
        &mut |_| {},
    )
    .await
    .expect("host still returns an answer floor");
    assert_eq!(outcome.attempts.len(), 1);
    assert_eq!(
        outcome.attempts[0].availability,
        ContributionAvailability::Malformed
    );
    assert!(outcome.attempts[0].contribution.is_none());
    assert_eq!(
        outcome.telemetry.stages[0].degradation,
        Some(ContributionDegradationReason::MalformedProposal)
    );
    assert!(!outcome.envelope.answer.root_cause_established);
    assert!(
        outcome.content.contains("Root cause established: no")
            || outcome.content.contains("Deterministic host baseline")
            || outcome.content.contains("Host"),
        "must keep host floor after garbage body: {}",
        outcome.content
    );
}

/// Ordered graph progress on the contribution path: starts → attempts → host answer.
#[tokio::test]
async fn ordered_contributor_graph_reaches_host_answer_without_root_cause_fabrication() {
    let pkt = packet();
    let observation = slot(
        ContributionRole::ObservationExtractor,
        "fast-a",
        ContributionQualification::Qualified,
        ScriptedBackend::new(vec![response(
            &pkt,
            ContributionRole::ObservationExtractor,
            claim_obs(),
        )]),
    );
    let causal = slot(
        ContributionRole::CausalProposer,
        "fast-b",
        ContributionQualification::Qualified,
        ScriptedBackend::new(vec![response(
            &pkt,
            ContributionRole::CausalProposer,
            claim_causal(),
        )]),
    );
    let plan = ContributionRoutingPlan::new(
        vec![
            ContributionRole::ObservationExtractor,
            ContributionRole::CausalProposer,
        ],
        Default::default(),
    )
    .unwrap();
    let mut events = Vec::new();
    let outcome = run_contribution_pipeline(
        ContributionPipelineInputs {
            user_text: "why?",
            packet: &pkt,
            slots: &[observation, causal],
            budget: budget(),
            deadline_ms: 10_000,
            started_at: None,
            cancel: None,
            plan: &plan,
        },
        &mut |event| events.push(event),
    )
    .await
    .unwrap();
    assert!(events.iter().any(|e| e.started));
    assert!(events.iter().any(|e| e.outcome.is_some()));
    assert_eq!(outcome.attempts.len(), 2);
    assert!(!outcome.envelope.answer.root_cause_established);
    assert!(outcome.content.contains("Root cause established: no"));
}
