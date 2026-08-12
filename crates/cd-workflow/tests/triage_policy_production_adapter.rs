use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
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
    ContributorSlotV2, FinalizerSlotV2, ReviewerConditionV2, ReviewerSlotV2, RolePreflightV2,
    RoleQualificationV2, RoleRequirement, SlotDispositionV2, TriageContributorRole,
    TriagePolicyMode, TriagePolicyPreflightV2, TriagePolicyV2, TriageSlotKindV2,
    TRIAGE_POLICY_SCHEMA_V2, TRIAGE_QUALIFICATION_SCHEMA_V2, TRIAGE_QUALIFICATION_WORKFLOW_V2,
};
use cd_core::multi_model::{
    run_contribution_pipeline, ContributionAvailability, ContributionPipelineInputs,
};
use cd_core::tools::ToolSpec;
use cd_workflow::triage_production::{
    prepare_v2_contribution_runtime, AuthorizedTriageBackendV1, TriageProductionAdapterErrorV1,
    TriageProductionAdapterRejectionV1,
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
            qualification_schema_id: Some(TRIAGE_QUALIFICATION_SCHEMA_V2.into()),
            workflow_id: Some(TRIAGE_QUALIFICATION_WORKFLOW_V2.into()),
            protocol_fingerprint: Some("sha256:triage-fixture-protocol".into()),
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
            qualification_schema_id: Some(TRIAGE_QUALIFICATION_SCHEMA_V2.into()),
            workflow_id: Some(TRIAGE_QUALIFICATION_WORKFLOW_V2.into()),
            protocol_fingerprint: Some("sha256:triage-fixture-protocol".into()),
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
            qualification_schema_id: Some(TRIAGE_QUALIFICATION_SCHEMA_V2.into()),
            workflow_id: Some(TRIAGE_QUALIFICATION_WORKFLOW_V2.into()),
            protocol_fingerprint: Some("sha256:triage-fixture-protocol".into()),
        });
    }
    TriagePolicyPreflightV2 { roles }
}

fn response(
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

fn backend(slot: &ContributorSlotV2, completion: ChatCompletion) -> AuthorizedTriageBackendV1 {
    AuthorizedTriageBackendV1 {
        slot_id: slot.slot_id.clone(),
        model: slot.model.clone(),
        backend: Arc::new(ScriptedBackend::new(vec![completion])),
    }
}

fn empty_backend(slot: &ContributorSlotV2) -> AuthorizedTriageBackendV1 {
    AuthorizedTriageBackendV1 {
        slot_id: slot.slot_id.clone(),
        model: slot.model.clone(),
        backend: Arc::new(ScriptedBackend::new(Vec::new())),
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

fn category(error: TriageProductionAdapterErrorV1) -> TriageProductionAdapterRejectionV1 {
    match error {
        TriageProductionAdapterErrorV1::Unsupported { category, .. } => category,
        TriageProductionAdapterErrorV1::Policy(failure) => {
            panic!("unexpected policy failure: {:?}", failure.rejections)
        }
    }
}

#[tokio::test]
async fn exact_v2_subset_reuses_production_pipeline_and_host_validation() {
    let packet = packet();
    let policy = policy(&[
        TriageContributorRole::ObservationExtractor,
        TriageContributorRole::CausalProposer,
    ]);
    let backends = vec![
        backend(
            &policy.contributors[0],
            response(
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
        backend(
            &policy.contributors[1],
            response(
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
    let prepared = prepare_v2_contribution_runtime(
        &policy,
        &preflight(&policy),
        backends,
        HOST_DEADLINE_MS,
        100_000,
        FastTriageNeighborhoodBudget::default(),
    )
    .expect("supported subset");

    assert_eq!(prepared.bindings.len(), 2);
    assert_eq!(
        prepared.bindings[0].model.model_id, "openai/model-0",
        "namespaced model ids remain exact"
    );
    assert!(prepared
        .compiled
        .slots
        .iter()
        .all(|slot| slot.disposition == SlotDispositionV2::Admitted));
    assert_eq!(prepared.runtime.plan.policy.max_parallel, 1);
    assert!(!prepared.runtime.plan.policy.reviewer_enabled);

    let mut events = Vec::new();
    let outcome = run_contribution_pipeline(
        ContributionPipelineInputs {
            user_text: "What initiated the incident?",
            packet: &packet,
            slots: &prepared.runtime.slots,
            budget: prepared.runtime.budget,
            deadline_ms: HOST_DEADLINE_MS,
            started_at: None,
            cancel: None,
            plan: &prepared.runtime.plan,
        },
        &mut |event| events.push(event),
    )
    .await
    .expect("production contribution path");

    assert_eq!(outcome.attempts.len(), 2);
    assert!(outcome
        .attempts
        .iter()
        .all(|attempt| attempt.availability == ContributionAvailability::Completed));
    assert!(!outcome.envelope.answer.root_cause_established);
    assert!(outcome.content.contains("Deterministic host baseline"));
    assert_eq!(events.iter().filter(|event| event.started).count(), 2);
    assert_eq!(
        events
            .iter()
            .map(|event| event.identity.model.as_str())
            .collect::<BTreeSet<_>>(),
        BTreeSet::from(["openai/model-0", "openai/model-1"])
    );
}

struct CountingBackend {
    calls: Arc<AtomicUsize>,
}

#[async_trait]
impl ChatBackend for CountingBackend {
    async fn complete(
        &self,
        _messages: &[ChatMessage],
        _tools: &[ToolSpec],
    ) -> CoreResult<ChatCompletion> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(ChatCompletion::from_parts("{}", Vec::new(), "stop"))
    }
}

#[tokio::test]
async fn existing_cancellation_stops_every_adapter_backend_before_io() {
    let packet = packet();
    let policy = policy(&[
        TriageContributorRole::ObservationExtractor,
        TriageContributorRole::EvidenceGapFinder,
    ]);
    let calls = Arc::new(AtomicUsize::new(0));
    let backends = policy
        .contributors
        .iter()
        .map(|slot| AuthorizedTriageBackendV1 {
            slot_id: slot.slot_id.clone(),
            model: slot.model.clone(),
            backend: Arc::new(CountingBackend {
                calls: Arc::clone(&calls),
            }),
        })
        .collect();
    let prepared = prepare_v2_contribution_runtime(
        &policy,
        &preflight(&policy),
        backends,
        HOST_DEADLINE_MS,
        100_000,
        Default::default(),
    )
    .expect("supported subset");
    let cancel = Arc::new(AtomicBool::new(true));
    let outcome = run_contribution_pipeline(
        ContributionPipelineInputs {
            user_text: "why?",
            packet: &packet,
            slots: &prepared.runtime.slots,
            budget: prepared.runtime.budget,
            deadline_ms: HOST_DEADLINE_MS,
            started_at: None,
            cancel: Some(cancel),
            plan: &prepared.runtime.plan,
        },
        &mut |_| {},
    )
    .await
    .expect("cancelled deterministic floor");
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert!(outcome
        .attempts
        .iter()
        .all(|attempt| attempt.availability == ContributionAvailability::Cancelled));
}

#[test]
fn standard_stays_separate_and_timeline_is_typed_in_the_v2_runtime() {
    let standard = TriagePolicyV2::standard(model("primary", "openai/model"), false);
    let error = prepare_v2_contribution_runtime(
        &standard,
        &preflight(&standard),
        Vec::new(),
        HOST_DEADLINE_MS,
        100_000,
        Default::default(),
    )
    .expect_err("Standard stays on established path");
    assert_eq!(
        category(error),
        TriageProductionAdapterRejectionV1::StandardUsesEstablishedPath
    );

    let timeline = policy(&[TriageContributorRole::TimelineAnalyst]);
    let prepared = prepare_v2_contribution_runtime(
        &timeline,
        &preflight(&timeline),
        vec![empty_backend(&timeline.contributors[0])],
        HOST_DEADLINE_MS,
        100_000,
        Default::default(),
    )
    .expect("timeline role is admitted through the typed contribution runtime");
    assert_eq!(
        prepared.runtime.slots[0].role,
        cd_core::multi_model::ContributionRole::TimelineAnalyst
    );

    let mut finalizer = policy(&[TriageContributorRole::ObservationExtractor]);
    finalizer.finalizer = Some(FinalizerSlotV2 {
        slot_id: "finalizer".into(),
        model: model("primary", "openai/finalizer"),
        requirement: RoleRequirement::Required,
        allow_remote: false,
    });
    finalizer.budget.finalizer.reserve_ms = HOST_DEADLINE_MS / 2;
    let error = prepare_v2_contribution_runtime(
        &finalizer,
        &preflight(&finalizer),
        vec![empty_backend(&finalizer.contributors[0])],
        HOST_DEADLINE_MS,
        100_000,
        Default::default(),
    )
    .expect_err("finalizer is not silently replaced by host floor");
    assert_eq!(
        category(error),
        TriageProductionAdapterRejectionV1::FinalizerUnsupported
    );

    let mut reviewer = policy(&[TriageContributorRole::ObservationExtractor]);
    reviewer.reviewer = Some(ReviewerSlotV2 {
        slot_id: "reviewer".into(),
        model: model("reviewer", "openai/reviewer"),
        condition: ReviewerConditionV2::ContestedOrIncomplete,
        requirement: RoleRequirement::Optional,
        allow_remote: false,
    });
    reviewer.budget.reviewer.reserve_ms = HOST_DEADLINE_MS / 2;
    let error = prepare_v2_contribution_runtime(
        &reviewer,
        &preflight(&reviewer),
        vec![empty_backend(&reviewer.contributors[0])],
        HOST_DEADLINE_MS,
        100_000,
        Default::default(),
    )
    .expect_err("reviewer semantics are not silently approximated");
    assert_eq!(
        category(error),
        TriageProductionAdapterRejectionV1::ReviewerUnsupported
    );
}

#[test]
fn optional_dropout_and_backend_identity_mismatch_fail_before_runtime() {
    let policy = policy(&[TriageContributorRole::ObservationExtractor]);
    let mut optional = policy.clone();
    optional.contributors[0].requirement = RoleRequirement::Optional;
    let mut facts = preflight(&optional);
    facts.roles[0].qualification = RoleQualificationV2::Unverified;
    let error = prepare_v2_contribution_runtime(
        &optional,
        &facts,
        Vec::new(),
        HOST_DEADLINE_MS,
        100_000,
        Default::default(),
    )
    .expect_err("dropout cannot disappear from production events");
    assert_eq!(
        category(error),
        TriageProductionAdapterRejectionV1::DegradedSlotUnsupported
    );

    let mut wrong = empty_backend(&policy.contributors[0]);
    wrong.model.model_id = "openai/other".into();
    let error = prepare_v2_contribution_runtime(
        &policy,
        &preflight(&policy),
        vec![wrong],
        HOST_DEADLINE_MS,
        100_000,
        Default::default(),
    )
    .expect_err("exact model binding");
    assert_eq!(
        category(error),
        TriageProductionAdapterRejectionV1::BackendBindingMismatch
    );
}

#[test]
fn deadlines_are_not_silently_weakened() {
    let policy = policy(&[TriageContributorRole::ObservationExtractor]);
    let error = prepare_v2_contribution_runtime(
        &policy,
        &preflight(&policy),
        vec![empty_backend(&policy.contributors[0])],
        HOST_DEADLINE_MS + 1,
        100_000,
        Default::default(),
    )
    .expect_err("explicit whole-turn mismatch");
    assert_eq!(
        category(error),
        TriageProductionAdapterRejectionV1::WholeTurnDeadlineMismatch
    );

    let mut smaller_cap = policy.clone();
    smaller_cap.budget.whole_turn_deadline_ms = None;
    smaller_cap.budget.contributors.operation_timeout_ms = HOST_DEADLINE_MS - 1;
    let error = prepare_v2_contribution_runtime(
        &smaller_cap,
        &preflight(&smaller_cap),
        vec![empty_backend(&smaller_cap.contributors[0])],
        HOST_DEADLINE_MS,
        100_000,
        Default::default(),
    )
    .expect_err("unsupported smaller operation cap");
    assert_eq!(
        category(error),
        TriageProductionAdapterRejectionV1::ContributorOperationCapUnsupported
    );
}
