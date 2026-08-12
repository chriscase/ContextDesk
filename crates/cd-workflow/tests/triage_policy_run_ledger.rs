//! Production V2 event-ledger tests: the exact projection agent hosts wire
//! through `ContributionRunObserverV1`, driven by the real production
//! contribution pipeline with scripted backends. No network, credentials,
//! configuration, or filesystem state is used.

use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use async_trait::async_trait;
use cd_core::agent::{ChatBackend, ScriptedBackend};
use cd_core::chat::{ChatCompletion, ChatMessage};
use cd_core::error::CoreResult;
use cd_core::fast_triage::{FastTriageNeighborhoodBudget, FastTriagePacketV1};
use cd_core::investigation_answer::{
    AnswerBindingV1, EvidenceRole, HostEvidenceEntry, HostEvidenceLedger, LogSnapshotRevisionV1,
};
use cd_core::model_ref::ModelRef;
use cd_core::multi_model::triage_policy::{
    ContributorSlotV2, RolePreflightV2, RoleQualificationV2, RoleRequirement,
    TriageContributorRole, TriagePolicyMode, TriagePolicyPreflightV2, TriagePolicyV2,
    TriageSlotKindV2, TRIAGE_POLICY_SCHEMA_V2,
};
use cd_core::multi_model::{
    run_contribution_pipeline, ContributionPipelineInputs, ContributionRouteRefusalV1,
    ContributionRunObserverV1,
};
use cd_core::tools::ToolSpec;
use cd_core::triage_sdk::{
    TriageAttemptStatus, TriageResultKind, TriageRunEventPayloadV2, TriageValidationState,
};
use cd_workflow::triage_production::{
    prepare_v2_contribution_runtime_with_projection, AuthorizedTriageBackendV1,
    PreparedV2ContributionRuntimeV1, V2ProjectionCapabilitiesV1,
};
use cd_workflow::triage_run::{
    share_safe_projection, TriageRunIdentityV1, TriageRunLedgerOutcomeV1, TriageRunLedgerV1,
    TriageTurnDispositionV1,
};
use serde_json::json;

const HOST_DEADLINE_MS: u64 = 60_000;

fn model(profile: &str, model_id: &str) -> ModelRef {
    ModelRef {
        profile_id: profile.into(),
        model_id: model_id.into(),
    }
}

fn policy(roles: &[TriageContributorRole]) -> TriagePolicyV2 {
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
                    &format!("openai/model-{index}"),
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
    policy
}

fn preflight(policy: &TriagePolicyV2) -> TriagePolicyPreflightV2 {
    TriagePolicyPreflightV2 {
        roles: policy
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
            .collect(),
    }
}

fn packet() -> FastTriagePacketV1 {
    let revision = LogSnapshotRevisionV1 {
        event_revision: 1,
        template_analysis_revision: 2,
        suppression_revision: 3,
    };
    let entries = vec![HostEvidenceEntry {
        evidence_id: "opaque-a".into(),
        candidate_id: "candidate-a".into(),
        source_label: "service.log".into(),
        locator: "seq=10".into(),
        corpus_id: "corpus".into(),
        revision,
        role: EvidenceRole::Cause,
        content: "bounded host evidence".into(),
    }];
    let binding = AnswerBindingV1 {
        session_id: "session".into(),
        turn_id: "turn".into(),
        corpus_id: "corpus".into(),
        revision,
        ledger_digest: HostEvidenceLedger::digest(&entries),
    };
    FastTriagePacketV1::from_ledger(
        HostEvidenceLedger::new(binding, entries).expect("valid host ledger"),
        None,
        true,
    )
}

fn identity() -> TriageRunIdentityV1 {
    TriageRunIdentityV1 {
        run_id: "run-fixture-1".into(),
        request_fingerprint: "sha256:fixture-request".into(),
        policy_fingerprint: "sha256:fixture-policy".into(),
        cancellation_id: "cancel-fixture-1".into(),
    }
}

fn contribution(
    packet: &FastTriagePacketV1,
    role: cd_core::multi_model::ContributionRole,
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

fn scripted(slot: &ContributorSlotV2, completion: ChatCompletion) -> AuthorizedTriageBackendV1 {
    AuthorizedTriageBackendV1 {
        slot_id: slot.slot_id.clone(),
        model: slot.model.clone(),
        backend: Arc::new(ScriptedBackend::new(vec![completion])),
    }
}

fn prepare(
    policy: &TriagePolicyV2,
    facts: &TriagePolicyPreflightV2,
    backends: Vec<AuthorizedTriageBackendV1>,
) -> PreparedV2ContributionRuntimeV1 {
    prepare_v2_contribution_runtime_with_projection(
        policy,
        facts,
        backends,
        HOST_DEADLINE_MS,
        100_000,
        FastTriageNeighborhoodBudget::default(),
        V2ProjectionCapabilitiesV1 {
            represents_optional_dropout: true,
        },
    )
    .expect("supported subset")
}

/// Drive the real production pipeline with the ledger observing it exactly
/// as `cd_core::agent` wires a policy-bound run.
async fn run_with_ledger(
    prepared: &PreparedV2ContributionRuntimeV1,
    packet: &FastTriagePacketV1,
    cancel: Option<Arc<AtomicBool>>,
    deadline_ms: u64,
) -> TriageRunLedgerOutcomeV1 {
    let ledger = TriageRunLedgerV1::new(
        identity(),
        prepared.compiled.clone(),
        prepared.bindings.clone(),
    );
    ledger.start();
    ledger.packet_ready(packet);
    let result = run_contribution_pipeline(
        ContributionPipelineInputs {
            user_text: "What initiated the incident?",
            packet,
            slots: &prepared.runtime.slots,
            budget: prepared.runtime.budget,
            deadline_ms,
            started_at: None,
            cancel,
            plan: &prepared.runtime.plan,
        },
        &mut |event| ledger.stage(&event),
    )
    .await;
    match result {
        Ok(outcome) => ledger.outcome(&outcome),
        Err(_) => ledger.route_refused(ContributionRouteRefusalV1::PipelineFailed),
    }
    ledger
        .finalize(TriageTurnDispositionV1::Completed)
        .expect("ledger replay must validate")
}

fn attempts(outcome: &TriageRunLedgerOutcomeV1) -> Vec<&cd_core::triage_sdk::TriageRoleAttemptV1> {
    outcome
        .replay
        .events
        .iter()
        .filter_map(|event| match &event.event {
            TriageRunEventPayloadV2::RoleAttempt { attempt } => Some(attempt),
            _ => None,
        })
        .collect()
}

#[tokio::test(start_paused = true)]
async fn completed_run_projects_grounded_final_with_exact_accounting() {
    let packet = packet();
    let policy = policy(&[
        TriageContributorRole::ObservationExtractor,
        TriageContributorRole::CausalProposer,
    ]);
    let backends = vec![
        scripted(
            &policy.contributors[0],
            contribution(
                &packet,
                cd_core::multi_model::ContributionRole::ObservationExtractor,
                json!([{
                    "claim_id": "observation-1",
                    "candidate_id": "candidate-a",
                    "kind": "observation",
                    "text": "observed",
                    "evidence_ids": ["opaque-a"]
                }]),
            ),
        ),
        scripted(
            &policy.contributors[1],
            contribution(
                &packet,
                cd_core::multi_model::ContributionRole::CausalProposer,
                json!([{
                    "claim_id": "candidate-1",
                    "candidate_id": "candidate-a",
                    "kind": "causal_candidate",
                    "text": "possible",
                    "evidence_ids": ["opaque-a"]
                }]),
            ),
        ),
    ];
    let prepared = prepare(&policy, &preflight(&policy), backends);
    let outcome = run_with_ledger(&prepared, &packet, None, HOST_DEADLINE_MS).await;

    assert!(matches!(
        outcome.replay.events.last().expect("terminal").event,
        TriageRunEventPayloadV2::Completed { .. }
    ));
    assert_eq!(outcome.result.kind, TriageResultKind::GroundedFinal);
    assert_eq!(
        outcome.result.validation_state,
        TriageValidationState::Passed
    );
    assert_eq!(outcome.result.packet_id, packet.packet_id());
    assert_eq!(outcome.result.reconciliation.configured_role_slots, 2);
    assert_eq!(outcome.result.reconciliation.completed_role_slots, 2);
    assert_eq!(outcome.result.reconciliation.distinct_models, 2);
    assert_eq!(outcome.result.reconciliation.distinct_gateways, 2);
    assert!(!outcome.result.reconciliation.root_cause_established);
    assert_eq!(
        outcome.result.reconciliation.supported_claim_ids,
        vec!["candidate-a".to_string()]
    );
    assert_eq!(outcome.result.accepted_evidence_ids, vec!["opaque-a"]);
    assert!(outcome.result.answer.is_some(), "grounded answer attached");
    assert_eq!(outcome.accounting.provider_calls, 2);
    assert_eq!(outcome.accounting.correction_calls, 0);
    assert!(outcome.accounting.context_chars_sent > 0);
    assert!(outcome.accounting.output_chars > 0);

    let attempts = attempts(&outcome);
    assert_eq!(attempts.len(), 2);
    assert!(attempts
        .iter()
        .all(|attempt| attempt.status == TriageAttemptStatus::Completed));
    assert!(attempts
        .iter()
        .all(|attempt| attempt.input_chars > 0 && attempt.output_chars > 0));
    assert!(attempts.iter().all(|attempt| attempt.model.is_some()));

    // The packet event carries exact host identity and a digest.
    let packet_event = outcome
        .replay
        .events
        .iter()
        .find_map(|event| match &event.event {
            TriageRunEventPayloadV2::PacketReady {
                packet_id,
                packet_digest,
                evidence_count,
            } => Some((packet_id.clone(), packet_digest.clone(), *evidence_count)),
            _ => None,
        })
        .expect("packet event");
    assert_eq!(packet_event.0, packet.packet_id());
    assert!(packet_event.1.starts_with("sha256:"));
    assert_eq!(packet_event.2, packet.rows().len() as u32);
}

#[tokio::test(start_paused = true)]
async fn same_model_two_roles_reports_non_independence() {
    let packet = packet();
    let mut policy = policy(&[
        TriageContributorRole::ObservationExtractor,
        TriageContributorRole::EvidenceGapFinder,
    ]);
    policy.contributors[1].model = policy.contributors[0].model.clone();
    let backends = vec![
        scripted(
            &policy.contributors[0],
            contribution(
                &packet,
                cd_core::multi_model::ContributionRole::ObservationExtractor,
                json!([{
                    "claim_id": "observation-1",
                    "candidate_id": "candidate-a",
                    "kind": "observation",
                    "text": "observed",
                    "evidence_ids": ["opaque-a"]
                }]),
            ),
        ),
        scripted(
            &policy.contributors[1],
            contribution(
                &packet,
                cd_core::multi_model::ContributionRole::EvidenceGap,
                json!([]),
            ),
        ),
    ];
    let prepared = prepare(&policy, &preflight(&policy), backends);
    assert_eq!(prepared.compiled.independence_counts.distinct_model_refs, 1);
    let outcome = run_with_ledger(&prepared, &packet, None, HOST_DEADLINE_MS).await;
    assert_eq!(outcome.result.reconciliation.completed_role_slots, 2);
    assert_eq!(
        outcome.result.reconciliation.distinct_models, 1,
        "one exact model in two roles is one model, not two witnesses"
    );
    assert_eq!(outcome.result.reconciliation.distinct_gateways, 1);
}

#[tokio::test(start_paused = true)]
async fn required_malformed_contribution_is_honest_partial_failure() {
    let packet = packet();
    let policy = policy(&[TriageContributorRole::ObservationExtractor]);
    let backends = vec![AuthorizedTriageBackendV1 {
        slot_id: policy.contributors[0].slot_id.clone(),
        model: policy.contributors[0].model.clone(),
        backend: Arc::new(ScriptedBackend::new(vec![ChatCompletion::from_parts(
            "not a contribution proposal",
            Vec::new(),
            "stop",
        )])),
    }];
    let prepared = prepare(&policy, &preflight(&policy), backends);
    let outcome = run_with_ledger(&prepared, &packet, None, HOST_DEADLINE_MS).await;

    assert!(matches!(
        &outcome.replay.events.last().expect("terminal").event,
        TriageRunEventPayloadV2::Failed { category, .. } if category == "required_role_failed"
    ));
    assert_eq!(outcome.result.kind, TriageResultKind::HonestPartial);
    assert_eq!(
        outcome.result.validation_state,
        TriageValidationState::Partial,
        "deterministic floor still validated"
    );
    assert!(
        outcome.result.answer.is_some(),
        "completed deterministic work is not hidden"
    );
    let attempts = attempts(&outcome);
    assert_eq!(attempts[0].status, TriageAttemptStatus::Invalid);
    assert!(attempts[0]
        .reason_codes
        .contains(&"malformed_proposal".to_string()));
}

#[tokio::test(start_paused = true)]
async fn abstention_is_typed_and_never_counts_as_support() {
    let packet = packet();
    let policy = policy(&[TriageContributorRole::ObservationExtractor]);
    let backends = vec![scripted(
        &policy.contributors[0],
        ChatCompletion::from_parts(
            json!({
                "schema": cd_core::multi_model::CONTRIBUTION_SCHEMA_V1,
                "packet_id": packet.packet_id(),
                "role": cd_core::multi_model::ContributionRole::ObservationExtractor,
                "abstained": true,
                "claims": [],
            })
            .to_string(),
            Vec::new(),
            "stop",
        ),
    )];
    let prepared = prepare(&policy, &preflight(&policy), backends);
    let outcome = run_with_ledger(&prepared, &packet, None, HOST_DEADLINE_MS).await;
    let attempts = attempts(&outcome);
    assert_eq!(attempts[0].status, TriageAttemptStatus::Abstained);
    assert_eq!(
        outcome.result.reconciliation.completed_role_slots, 0,
        "abstention is not completion support"
    );
    assert!(matches!(
        outcome.replay.events.last().expect("terminal").event,
        TriageRunEventPayloadV2::Completed { .. }
    ));
}

#[tokio::test(start_paused = true)]
async fn cancellation_projects_cancelled_terminal_with_exact_identity() {
    let packet = packet();
    let policy = policy(&[
        TriageContributorRole::ObservationExtractor,
        TriageContributorRole::CausalProposer,
    ]);
    let backends = policy
        .contributors
        .iter()
        .map(|slot| AuthorizedTriageBackendV1 {
            slot_id: slot.slot_id.clone(),
            model: slot.model.clone(),
            backend: Arc::new(ScriptedBackend::new(Vec::new())),
        })
        .collect();
    let prepared = prepare(&policy, &preflight(&policy), backends);
    let cancel = Arc::new(AtomicBool::new(true));
    let outcome = run_with_ledger(&prepared, &packet, Some(cancel), HOST_DEADLINE_MS).await;

    assert!(matches!(
        &outcome.replay.events.last().expect("terminal").event,
        TriageRunEventPayloadV2::Cancelled { cancellation_id, .. }
            if cancellation_id == "cancel-fixture-1"
    ));
    assert_eq!(outcome.result.kind, TriageResultKind::HonestPartial);
    assert!(attempts(&outcome)
        .iter()
        .all(|attempt| attempt.status == TriageAttemptStatus::Cancelled));
    assert_eq!(outcome.accounting.provider_calls, 0);
}

struct SlowBackend;

#[async_trait]
impl ChatBackend for SlowBackend {
    async fn complete(
        &self,
        _messages: &[ChatMessage],
        _tools: &[ToolSpec],
    ) -> CoreResult<ChatCompletion> {
        tokio::time::sleep(std::time::Duration::from_millis(HOST_DEADLINE_MS * 2)).await;
        Ok(ChatCompletion::from_parts("{}", Vec::new(), "stop"))
    }
}

#[tokio::test(start_paused = true)]
async fn deadline_projects_timed_out_terminal() {
    let packet = packet();
    let policy = policy(&[TriageContributorRole::ObservationExtractor]);
    let backends = vec![AuthorizedTriageBackendV1 {
        slot_id: policy.contributors[0].slot_id.clone(),
        model: policy.contributors[0].model.clone(),
        backend: Arc::new(SlowBackend),
    }];
    let prepared = prepare(&policy, &preflight(&policy), backends);
    let outcome = run_with_ledger(&prepared, &packet, None, HOST_DEADLINE_MS).await;

    assert!(matches!(
        &outcome.replay.events.last().expect("terminal").event,
        TriageRunEventPayloadV2::TimedOut { category, .. } if category == "deadline"
    ));
    let attempts = attempts(&outcome);
    assert_eq!(attempts[0].status, TriageAttemptStatus::TimedOut);
    assert!(attempts[0].reason_codes.contains(&"deadline".to_string()));
}

#[tokio::test(start_paused = true)]
async fn optional_dropout_is_an_explicit_role_attempt() {
    let packet = packet();
    let mut policy = policy(&[
        TriageContributorRole::ObservationExtractor,
        TriageContributorRole::EvidenceGapFinder,
    ]);
    policy.contributors[1].requirement = RoleRequirement::Optional;
    let mut facts = preflight(&policy);
    facts.roles[1].qualification = RoleQualificationV2::Unverified;
    facts.roles[1].available = false;
    let backends = vec![scripted(
        &policy.contributors[0],
        contribution(
            &packet,
            cd_core::multi_model::ContributionRole::ObservationExtractor,
            json!([{
                "claim_id": "observation-1",
                "candidate_id": "candidate-a",
                "kind": "observation",
                "text": "observed",
                "evidence_ids": ["opaque-a"]
            }]),
        ),
    )];
    let prepared = prepare(&policy, &facts, backends);
    assert_eq!(prepared.runtime.slots.len(), 1, "only admitted slots run");
    assert_eq!(prepared.compiled.slots.len(), 2, "dropout stays configured");
    let outcome = run_with_ledger(&prepared, &packet, None, HOST_DEADLINE_MS).await;

    let attempts = attempts(&outcome);
    assert_eq!(attempts.len(), 2, "every configured slot is accounted");
    assert_eq!(attempts[0].status, TriageAttemptStatus::Completed);
    assert_eq!(attempts[1].status, TriageAttemptStatus::NotAdmitted);
    assert!(attempts[1]
        .reason_codes
        .contains(&"role_unavailable".to_string()));
    assert!(attempts[1]
        .reason_codes
        .contains(&"qualification_unavailable".to_string()));
    assert!(matches!(
        outcome.replay.events.last().expect("terminal").event,
        TriageRunEventPayloadV2::Completed { .. }
    ));
    assert_eq!(outcome.result.reconciliation.configured_role_slots, 2);
    assert_eq!(outcome.result.reconciliation.completed_role_slots, 1);
}

#[tokio::test(start_paused = true)]
async fn route_refusal_terminates_failed_with_every_slot_accounted() {
    let packet = packet();
    let policy = policy(&[TriageContributorRole::ObservationExtractor]);
    let backends = vec![scripted(
        &policy.contributors[0],
        contribution(
            &packet,
            cd_core::multi_model::ContributionRole::ObservationExtractor,
            json!([]),
        ),
    )];
    let prepared = prepare(&policy, &preflight(&policy), backends);
    let ledger = TriageRunLedgerV1::new(
        identity(),
        prepared.compiled.clone(),
        prepared.bindings.clone(),
    );
    ledger.start();
    ledger.route_refused(ContributionRouteRefusalV1::NotBroadTriage);
    let outcome = ledger
        .finalize(TriageTurnDispositionV1::Completed)
        .expect("refusal replay validates");
    assert!(matches!(
        &outcome.replay.events.last().expect("terminal").event,
        TriageRunEventPayloadV2::Failed { category, .. } if category == "not_broad_triage"
    ));
    assert_eq!(
        outcome.result.packet_id,
        cd_workflow::triage_run::TRIAGE_PACKET_NOT_ASSEMBLED
    );
    assert_eq!(outcome.result.kind, TriageResultKind::HonestPartial);
    assert_eq!(
        outcome.result.validation_state,
        TriageValidationState::Failed
    );
    let attempts = attempts(&outcome);
    assert_eq!(attempts.len(), 1);
    assert_eq!(attempts[0].status, TriageAttemptStatus::Failed);
    assert!(attempts[0]
        .reason_codes
        .contains(&"not_broad_triage".to_string()));
}

#[tokio::test(start_paused = true)]
async fn projection_mismatch_poisons_instead_of_misattributing() {
    let packet = packet();
    let policy = policy(&[TriageContributorRole::ObservationExtractor]);
    let backends = vec![scripted(
        &policy.contributors[0],
        contribution(
            &packet,
            cd_core::multi_model::ContributionRole::ObservationExtractor,
            json!([]),
        ),
    )];
    let prepared = prepare(&policy, &preflight(&policy), backends);
    let ledger = TriageRunLedgerV1::new(
        identity(),
        prepared.compiled.clone(),
        prepared.bindings.clone(),
    );
    ledger.start();
    ledger.packet_ready(&packet);
    // A stage event whose identity does not match the exact binding.
    ledger.stage(&cd_core::multi_model::ContributionStageEvent {
        role: cd_core::multi_model::ContributionRole::ObservationExtractor,
        identity: cd_core::multi_model::ContributionIdentity {
            profile_id: "unexpected-profile".into(),
            model: "unexpected-model".into(),
        },
        started: true,
        outcome: None,
        degradation: None,
        detail: "spoofed".into(),
    });
    let outcome = ledger
        .finalize(TriageTurnDispositionV1::Completed)
        .expect("poisoned replay still validates");
    assert!(matches!(
        &outcome.replay.events.last().expect("terminal").event,
        TriageRunEventPayloadV2::Failed { category, .. }
            if category == "ledger_projection_mismatch"
    ));
    assert!(attempts(&outcome).iter().all(|attempt| attempt
        .reason_codes
        .contains(&"stage_binding_mismatch".to_string())));
}

#[tokio::test(start_paused = true)]
async fn share_safe_projection_drops_models_terminals_and_scans_clean() {
    let packet = packet();
    let policy = policy(&[TriageContributorRole::ObservationExtractor]);
    let backends = vec![scripted(
        &policy.contributors[0],
        contribution(
            &packet,
            cd_core::multi_model::ContributionRole::ObservationExtractor,
            json!([{
                "claim_id": "observation-1",
                "candidate_id": "candidate-a",
                "kind": "observation",
                "text": "observed",
                "evidence_ids": ["opaque-a"]
            }]),
        ),
    )];
    let prepared = prepare(&policy, &preflight(&policy), backends);
    let outcome = run_with_ledger(&prepared, &packet, None, HOST_DEADLINE_MS).await;

    let projection =
        share_safe_projection(&outcome.replay, &outcome.result).expect("share-safe projection");
    assert!(projection
        .events
        .iter()
        .all(|event| !event.event.is_terminal()));
    assert_eq!(projection.dropped_events, 1, "exactly the terminal dropped");
    let encoded = serde_json::to_string(&projection.events).expect("serialize");
    assert!(
        !encoded.contains("openai/model-0"),
        "share-safe events never carry exact model identity"
    );
    assert!(!encoded.contains("bounded host evidence"));
    projection.result.validate().expect("share-safe result");

    // The owner-only replay retains exact identity and the validated answer
    // envelope (bounded evidence excerpts are owner-only by design), but the
    // task text itself never enters the ledger — only its fingerprint does.
    let owner_encoded = serde_json::to_string(&outcome.replay).expect("serialize");
    assert!(owner_encoded.contains("openai/model-0"));
    assert!(!owner_encoded.contains("What initiated the incident?"));
}

#[tokio::test(start_paused = true)]
async fn migrated_legacy_policy_runs_on_the_production_ledger_path() {
    use cd_core::multi_model::triage_policy::{
        migrate_resolved_legacy_policy_v1, LegacyResolvedContributorV1,
        LegacyResolvedTriagePolicyV1,
    };
    use cd_core::multi_model::{
        ContributionRole, ContributionRoutingPolicy, MultiModelBudget, MultiModelMode,
    };

    let packet = packet();
    let migrated = migrate_resolved_legacy_policy_v1(LegacyResolvedTriagePolicyV1 {
        mode: MultiModelMode::Contributions,
        primary: model("primary", "openai/answer-model"),
        primary_allow_remote: false,
        reviewer: None,
        contributors: vec![LegacyResolvedContributorV1 {
            role: ContributionRole::ObservationExtractor,
            model: model("legacy-profile", "openai/legacy-model"),
            require_qualified: true,
            allow_remote: false,
        }],
        budget: MultiModelBudget {
            deadline_ms: HOST_DEADLINE_MS,
            ..MultiModelBudget::default()
        },
        contribution_policy: ContributionRoutingPolicy::default(),
    });
    assert_eq!(migrated.mode, TriagePolicyMode::Enhanced);

    // The migrated finalizer cannot run on this subset; it must degrade
    // visibly (it is required, so the compiler refuses unless the host marks
    // it unavailable — mirror an unavailable legacy primary honestly here by
    // making the finalizer optional before the run).
    let mut policy = migrated.clone();
    if let Some(finalizer) = policy.finalizer.as_mut() {
        finalizer.requirement = RoleRequirement::Optional;
    }
    let mut facts = TriagePolicyPreflightV2 {
        roles: policy
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
            .collect(),
    };
    if let Some(finalizer) = &policy.finalizer {
        facts.roles.push(RolePreflightV2 {
            slot_id: finalizer.slot_id.clone(),
            model: finalizer.model.clone(),
            kind: TriageSlotKindV2::Finalizer,
            available: false,
            qualification: RoleQualificationV2::Unverified,
            remote: false,
        });
    }
    let backends = vec![scripted(
        &policy.contributors[0],
        contribution(
            &packet,
            cd_core::multi_model::ContributionRole::ObservationExtractor,
            json!([{
                "claim_id": "observation-1",
                "candidate_id": "candidate-a",
                "kind": "observation",
                "text": "observed",
                "evidence_ids": ["opaque-a"]
            }]),
        ),
    )];
    let prepared = prepare(&policy, &facts, backends);
    let outcome = run_with_ledger(&prepared, &packet, None, HOST_DEADLINE_MS).await;
    assert!(matches!(
        outcome.replay.events.last().expect("terminal").event,
        TriageRunEventPayloadV2::Completed { .. }
    ));
    let attempts = attempts(&outcome);
    assert_eq!(attempts.len(), 2);
    assert!(matches!(attempts[1].role, TriageSlotKindV2::Finalizer));
    assert_eq!(attempts[1].status, TriageAttemptStatus::NotAdmitted);
}

#[tokio::test(start_paused = true)]
async fn fingerprints_are_deterministic_and_content_sensitive() {
    use cd_core::extension_contract::PacketPrivacyBoundary;
    use cd_core::triage_sdk::{
        policy_fingerprint_v2, request_fingerprint_v2, TriagePolicySelectionV2, TriageRequestV2,
        TriageScopeV1, TRIAGE_REQUEST_SCHEMA_V2,
    };

    let policy = policy(&[TriageContributorRole::ObservationExtractor]);
    let first = policy_fingerprint_v2(&policy).expect("fingerprint");
    let second = policy_fingerprint_v2(&policy).expect("fingerprint");
    assert_eq!(first, second);
    let mut changed = policy.clone();
    changed.contributors[0].allow_remote = true;
    assert_ne!(first, policy_fingerprint_v2(&changed).expect("fingerprint"));

    let request = TriageRequestV2 {
        schema_id: TRIAGE_REQUEST_SCHEMA_V2.into(),
        run_id: "run-1".into(),
        privacy: PacketPrivacyBoundary::OwnerOnly,
        task: "why did ingestion fail?".into(),
        scope: TriageScopeV1 {
            corpus_id: "corpus-1".into(),
            corpus_revision: None,
            source_ids: Vec::new(),
        },
        policy: TriagePolicySelectionV2::Standard {
            model: model("p", "m"),
        },
        overrides: Default::default(),
        cancellation_id: "cancel-1".into(),
    };
    let base = request_fingerprint_v2(&request).expect("fingerprint");
    let mut task_changed = request.clone();
    task_changed.task = "why did ingestion succeed?".into();
    assert_ne!(
        base,
        request_fingerprint_v2(&task_changed).expect("fingerprint")
    );
}

/// Committed golden: the exact Rust serialization of one deterministic
/// production-ledger replay. TypeScript parity consumes the same file.
fn golden_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/triage-sdk/v2/replay.production-contributors.json")
}

async fn golden_outcome() -> TriageRunLedgerOutcomeV1 {
    let packet = packet();
    let policy = policy(&[
        TriageContributorRole::ObservationExtractor,
        TriageContributorRole::CausalProposer,
    ]);
    let backends = vec![
        scripted(
            &policy.contributors[0],
            contribution(
                &packet,
                cd_core::multi_model::ContributionRole::ObservationExtractor,
                json!([{
                    "claim_id": "observation-1",
                    "candidate_id": "candidate-a",
                    "kind": "observation",
                    "text": "observed",
                    "evidence_ids": ["opaque-a"]
                }]),
            ),
        ),
        scripted(
            &policy.contributors[1],
            contribution(
                &packet,
                cd_core::multi_model::ContributionRole::CausalProposer,
                json!([{
                    "claim_id": "candidate-1",
                    "candidate_id": "candidate-a",
                    "kind": "causal_candidate",
                    "text": "possible",
                    "evidence_ids": ["opaque-a"]
                }]),
            ),
        ),
    ];
    let prepared = prepare(&policy, &preflight(&policy), backends);
    run_with_ledger(&prepared, &packet, None, HOST_DEADLINE_MS).await
}

#[tokio::test(start_paused = true)]
async fn production_ledger_golden_is_exact_rust_serialization() {
    let outcome = golden_outcome().await;
    let encoded = format!(
        "{}\n",
        serde_json::to_string_pretty(&outcome.replay).expect("serialize replay")
    );
    let committed = std::fs::read_to_string(golden_path()).expect(
        "committed production replay golden; regenerate with \
         `cargo test -p cd-workflow --test triage_policy_run_ledger regenerate -- --ignored`",
    );
    assert_eq!(encoded, committed, "golden replay must be byte-exact");
}

#[tokio::test(start_paused = true)]
#[ignore = "regenerates the committed Rust-owned production replay golden"]
async fn regenerate_production_ledger_golden() {
    let outcome = golden_outcome().await;
    let encoded = format!(
        "{}\n",
        serde_json::to_string_pretty(&outcome.replay).expect("serialize replay")
    );
    std::fs::write(golden_path(), encoded).expect("write golden");
}
