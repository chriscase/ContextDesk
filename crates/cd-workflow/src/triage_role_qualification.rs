//! Exact-role qualification for the Triage Policy V2 production graph.
//!
//! Generic model capability evidence is deliberately not enough to admit a
//! V2 slot.  This module runs a tiny synthetic packet through the same
//! `ChatBackend`, contribution pipeline, and finalizer validator used by a
//! real turn, then returns only a bounded host-authored record for the local
//! role-qualification store.  It never imports provider output or credentials
//! into the record.

use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use cd_core::agent::ChatBackend;
use cd_core::capability_qualification::QualificationKey;
use cd_core::chat::{ChatCompletion, ChatMessage};
use cd_core::config::AppConfig;
use cd_core::fast_triage::FastTriagePacketV1;
use cd_core::investigation_answer::{
    AnswerBindingV1, EvidenceRole, HostEvidenceEntry, HostEvidenceLedger, LogSnapshotRevisionV1,
    SCHEMA_V1,
};
use cd_core::keychain_store::SecretStore;
use cd_core::model_ref::ModelRef;
use cd_core::multi_model::contribution_pipeline::ContributionStageEvent;
use cd_core::multi_model::contributions::{
    ContributionIdentity, ContributionRole, ContributionRoutingPlan, ContributionRoutingPolicy,
};
use cd_core::multi_model::triage_policy::{
    RoleQualificationV2, TriageContributorRole, TriageSlotKindV2, MAX_TRIAGE_DEADLINE_MS_V2,
};
use cd_core::multi_model::MultiModelBudget;
use cd_core::triage_role_qualification::{
    triage_protocol_fingerprint, TriageRoleQualificationKeyV1, TriageRoleQualificationRecordV1,
};
use cd_core::triage_sdk::TriageReconciliationV1;

use crate::provider::{
    backend_for_resolved_turn, resolve_provider_profile,
    resolve_turn_inputs_from_profile_with_credential_cache, TurnProviderCredentialCache,
};
use crate::triage_host::HostValidatedAnswerHooks;
use crate::triage_production_runner::{
    role_messages, TriageProductionHooks, TriageValidationDecision,
};

/// One explicit exact-role qualification request.
#[derive(Debug, Clone)]
pub struct TriageRoleProbeRequest {
    /// Local provider profile identity.
    pub profile_id: String,
    /// Exact catalog model id returned by discovery or selected by the owner.
    pub model_id: String,
    /// Exact V2 phase/role to qualify.
    pub kind: TriageSlotKindV2,
    /// Whole probe deadline.  The host may choose a larger value for slow
    /// models, but the global V2 safety maximum still applies.
    pub deadline_ms: u64,
}

/// Host-resolved inputs for the hermetic/backend seam.  The backend is
/// already authorized by the caller; this type deliberately keeps provider
/// construction outside the probe contract.
pub struct TriageRoleProbeBackendInput {
    /// Local provider profile identity.
    pub profile_id: String,
    /// Configured endpoint, used only to derive the persisted fingerprint.
    pub base_url: String,
    /// Exact catalog model id.
    pub model_id: String,
    /// Exact V2 phase/role to qualify.
    pub kind: TriageSlotKindV2,
    /// Typed transport protocol label, fingerprinted before persistence.
    pub protocol: String,
    /// Whole probe deadline.
    pub deadline_ms: u64,
    /// Cooperative cancellation signal.
    pub cancel: Option<Arc<AtomicBool>>,
    /// Existing production chat backend.
    pub backend: Arc<dyn ChatBackend>,
}

/// Content-free failure from the role-probe host boundary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TriageRoleProbeError {
    /// The configured profile does not exist.
    ProfileUnavailable,
    /// The request is malformed or exceeds the global bound.
    InvalidRequest(&'static str),
    /// The existing provider backend could not be constructed.
    BackendUnavailable,
    /// The synthetic probe could not be executed by the host.
    ProbeFailed,
}

impl std::fmt::Display for TriageRoleProbeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ProfileUnavailable => f.write_str("triage_role_probe_profile_unavailable"),
            Self::InvalidRequest(field) => write!(f, "triage_role_probe_invalid_{field}"),
            Self::BackendUnavailable => f.write_str("triage_role_probe_backend_unavailable"),
            Self::ProbeFailed => f.write_str("triage_role_probe_failed"),
        }
    }
}

impl std::error::Error for TriageRoleProbeError {}

fn now_unix_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| i64::try_from(duration.as_secs()).ok())
        .unwrap_or(0)
}

fn record(
    key: TriageRoleQualificationKeyV1,
    qualification: RoleQualificationV2,
    physical_provider_calls: u32,
    reason: &'static str,
) -> TriageRoleQualificationRecordV1 {
    TriageRoleQualificationRecordV1 {
        key,
        qualification,
        physical_provider_calls,
        semantic_corrections: 0,
        reason: reason.into(),
        tested_at: now_unix_seconds(),
    }
}

fn synthetic_packet() -> FastTriagePacketV1 {
    let revision = LogSnapshotRevisionV1 {
        event_revision: 1,
        template_analysis_revision: 1,
        suppression_revision: 1,
    };
    let entry = HostEvidenceEntry {
        evidence_id: "evidence:role-probe".into(),
        candidate_id: "candidate:role-probe".into(),
        source_label: "synthetic-role-probe.log".into(),
        locator: "seq=1".into(),
        corpus_id: "corpus:role-probe".into(),
        revision,
        role: EvidenceRole::Neutral,
        content: "ContextDesk synthetic role qualification evidence.".into(),
    };
    let binding = AnswerBindingV1 {
        session_id: "session:role-probe".into(),
        turn_id: "turn:role-probe".into(),
        corpus_id: "corpus:role-probe".into(),
        revision,
        ledger_digest: HostEvidenceLedger::digest(std::slice::from_ref(&entry)),
    };
    FastTriagePacketV1::from_ledger(
        HostEvidenceLedger::new(binding, vec![entry]).expect("synthetic ledger"),
        None,
        true,
    )
}

fn contribution_role(kind: TriageSlotKindV2) -> Option<ContributionRole> {
    match kind {
        TriageSlotKindV2::Contributor(TriageContributorRole::ObservationExtractor) => {
            Some(ContributionRole::ObservationExtractor)
        }
        TriageSlotKindV2::Contributor(TriageContributorRole::CausalProposer) => {
            Some(ContributionRole::CausalProposer)
        }
        TriageSlotKindV2::Contributor(TriageContributorRole::ContradictionChecker) => {
            Some(ContributionRole::ContradictionChecker)
        }
        TriageSlotKindV2::Contributor(TriageContributorRole::EvidenceGapFinder) => {
            Some(ContributionRole::EvidenceGap)
        }
        TriageSlotKindV2::Contributor(TriageContributorRole::TimelineAnalyst)
        | TriageSlotKindV2::Finalizer
        | TriageSlotKindV2::Reviewer => None,
    }
}

fn probe_key(
    profile_id: &str,
    base_url: &str,
    model_id: &str,
    kind: TriageSlotKindV2,
    protocol: &str,
) -> TriageRoleQualificationKeyV1 {
    TriageRoleQualificationKeyV1::current(
        profile_id,
        base_url,
        model_id,
        kind,
        triage_protocol_fingerprint(protocol),
    )
}

fn budget(deadline_ms: u64) -> MultiModelBudget {
    MultiModelBudget {
        max_total_provider_rounds: 1,
        max_semantic_corrections_per_stage: 0,
        context_char_budget: 120_000,
        deadline_ms,
        max_context_chars_total: Some(120_000),
    }
}

fn reconciliation() -> TriageReconciliationV1 {
    TriageReconciliationV1 {
        state: "deterministic_baseline".into(),
        configured_role_slots: 1,
        completed_role_slots: 0,
        distinct_models: 0,
        distinct_gateways: 0,
        supported_claim_ids: Vec::new(),
        conflict_ids: Vec::new(),
        gap_ids: Vec::new(),
        root_cause_established: false,
    }
}

fn finalizer_slot(model: ModelRef) -> cd_core::multi_model::triage_policy::CompiledRoleSlotV2 {
    cd_core::multi_model::triage_policy::CompiledRoleSlotV2 {
        slot_id: "role-probe-finalizer".into(),
        kind: TriageSlotKindV2::Finalizer,
        model,
        requirement: cd_core::multi_model::triage_policy::RoleRequirement::Required,
        disposition: cd_core::multi_model::triage_policy::SlotDispositionV2::Admitted,
        rejections: Vec::new(),
        qualification_schema_id: None,
        workflow_id: None,
        protocol_fingerprint: None,
    }
}

async fn wait_for_cancel(cancel: Arc<AtomicBool>) {
    while !cancel.load(Ordering::SeqCst) {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

async fn complete_once(
    backend: &dyn ChatBackend,
    messages: &[ChatMessage],
    deadline_ms: u64,
    cancel: Option<Arc<AtomicBool>>,
) -> Result<ChatCompletion, &'static str> {
    let cancel_wait: Pin<Box<dyn Future<Output = ()> + Send>> = if let Some(flag) = cancel {
        Box::pin(wait_for_cancel(flag))
    } else {
        Box::pin(std::future::pending())
    };
    tokio::pin!(cancel_wait);
    let mut streamed = String::new();
    let mut on_text = |text: String| streamed.push_str(&text);
    let result = tokio::select! {
        _ = &mut cancel_wait => return Err("cancelled"),
        result = tokio::time::timeout(
            Duration::from_millis(deadline_ms),
            backend.complete_streaming(messages, &[], &mut on_text, None),
        ) => result,
    };
    let completion = match result {
        Ok(Ok(completion)) => completion,
        Ok(Err(_)) => return Err("provider_failed"),
        Err(_) => return Err("deadline"),
    };
    if streamed.trim().is_empty() {
        Ok(completion)
    } else {
        Ok(ChatCompletion {
            content: streamed,
            ..completion
        })
    }
}

async fn qualify_with_backend(
    input: TriageRoleProbeBackendInput,
) -> TriageRoleQualificationRecordV1 {
    let TriageRoleProbeBackendInput {
        profile_id,
        base_url,
        model_id,
        kind,
        protocol,
        deadline_ms,
        cancel,
        backend,
    } = input;
    let key = probe_key(&profile_id, &base_url, &model_id, kind, &protocol);
    let packet = synthetic_packet();

    if matches!(
        kind,
        TriageSlotKindV2::Contributor(TriageContributorRole::TimelineAnalyst)
    ) {
        return record(
            key,
            RoleQualificationV2::Unqualified,
            0,
            "timeline_role_unsupported",
        );
    }
    if matches!(kind, TriageSlotKindV2::Reviewer) {
        return record(
            key,
            RoleQualificationV2::Unqualified,
            0,
            "reviewer_execution_unavailable",
        );
    }

    if let Some(role) = contribution_role(kind) {
        let plan = match ContributionRoutingPlan::new(
            vec![role],
            ContributionRoutingPolicy {
                max_contributors: 1,
                max_parallel: 1,
                max_rounds: 1,
                max_context_chars: 120_000,
                reviewer_enabled: false,
            },
        ) {
            Ok(plan) => plan,
            Err(_) => {
                return record(
                    key,
                    RoleQualificationV2::Unqualified,
                    0,
                    "probe_plan_invalid",
                )
            }
        };
        let identity = ContributionIdentity {
            profile_id: profile_id.clone(),
            model: model_id.clone(),
        };
        let slot = cd_core::multi_model::contribution_pipeline::ContributionBackendSlot {
            role,
            identity,
            qualification:
                cd_core::multi_model::contribution_pipeline::ContributionQualification::Qualified,
            backend,
        };
        let mut events = Vec::<ContributionStageEvent>::new();
        let outcome = cd_core::multi_model::contribution_pipeline::run_contribution_pipeline(
            cd_core::multi_model::contribution_pipeline::ContributionPipelineInputs {
                user_text: "Synthetic role qualification probe; do not infer production facts.",
                packet: &packet,
                slots: std::slice::from_ref(&slot),
                budget: budget(deadline_ms),
                deadline_ms,
                started_at: None,
                cancel,
                plan: &plan,
            },
            &mut |event| events.push(event),
        )
        .await;
        let Ok(outcome) = outcome else {
            return record(
                key,
                RoleQualificationV2::Unqualified,
                0,
                "probe_pipeline_failed",
            );
        };
        let calls = outcome
            .telemetry
            .stages
            .first()
            .map(|stage| stage.provider_rounds)
            .unwrap_or(0);
        let attempt = outcome.attempts.first();
        let completed = attempt.is_some_and(|attempt| {
            attempt.availability
                == cd_core::multi_model::contributions::ContributionAvailability::Completed
        });
        return record(
            key,
            if completed {
                RoleQualificationV2::Qualified
            } else {
                RoleQualificationV2::Unqualified
            },
            calls,
            if completed {
                "role_probe_passed"
            } else {
                "role_probe_response_rejected"
            },
        );
    }

    // Finalizer qualification uses the same generic prompt, host hook, and
    // immutable-packet validator as the production runner, with corrections
    // intentionally disabled so the result measures one exact call.
    let model = ModelRef {
        profile_id: profile_id.clone(),
        model_id: model_id.clone(),
    };
    let slot = finalizer_slot(model);
    let mut messages = role_messages(
        "Synthetic role qualification probe; return a minimal valid answer.",
        &packet,
        kind,
    );
    messages[0].content = format!(
        "Return exactly one JSON object with schema \"{}\". Use every literal candidate/evidence id from the host packet and no host-owned fields. Do not establish a root cause.",
        SCHEMA_V1
    );
    let response = match complete_once(&*backend, &messages, deadline_ms, None).await {
        Ok(response) => response,
        Err(reason) => return record(key, RoleQualificationV2::Unqualified, 1, reason),
    };
    let hooks = HostValidatedAnswerHooks::default();
    let decision: TriageValidationDecision = hooks
        .validate(&slot, &response, &packet, &reconciliation())
        .await;
    let accepted = decision.accepted
        && hooks
            .finalize(&slot, &response, &packet, &reconciliation())
            .await
            .is_some();
    record(
        key,
        if accepted {
            RoleQualificationV2::Qualified
        } else {
            RoleQualificationV2::Unqualified
        },
        1,
        if accepted {
            "role_probe_passed"
        } else {
            "finalizer_probe_response_rejected"
        },
    )
}

/// Run one exact-role probe with an already-constructed production backend.
/// This is the hermetic seam used by tests and the live host wrapper.
pub async fn qualify_role_v2_with_backend(
    input: TriageRoleProbeBackendInput,
) -> Result<TriageRoleQualificationRecordV1, TriageRoleProbeError> {
    if input.profile_id.trim().is_empty() {
        return Err(TriageRoleProbeError::InvalidRequest("profile_id"));
    }
    if input.base_url.trim().is_empty() {
        return Err(TriageRoleProbeError::InvalidRequest("base_url"));
    }
    if input.model_id.trim().is_empty() {
        return Err(TriageRoleProbeError::InvalidRequest("model_id"));
    }
    if input.deadline_ms == 0 || input.deadline_ms > MAX_TRIAGE_DEADLINE_MS_V2 {
        return Err(TriageRoleProbeError::InvalidRequest("deadline_ms"));
    }
    Ok(qualify_with_backend(input).await)
}

/// Resolve the exact configured profile and use the existing provider
/// backend/credential plumbing to run one role probe.  No generic capability
/// report is consulted and no secret is returned to the caller.
pub async fn qualify_configured_role_v2(
    cfg: &AppConfig,
    secrets: &dyn SecretStore,
    request: &TriageRoleProbeRequest,
    cancel: Option<Arc<AtomicBool>>,
) -> Result<TriageRoleQualificationRecordV1, TriageRoleProbeError> {
    if request.deadline_ms == 0 || request.deadline_ms > MAX_TRIAGE_DEADLINE_MS_V2 {
        return Err(TriageRoleProbeError::InvalidRequest("deadline_ms"));
    }
    let profile = resolve_provider_profile(cfg, Some(&request.profile_id))
        .map_err(|_| TriageRoleProbeError::ProfileUnavailable)?;
    let protocol = QualificationKey::with_provider_kind(
        &profile.id,
        &profile.base_url,
        &request.model_id,
        profile.kind,
    )
    .transport_protocol;
    if matches!(
        request.kind,
        TriageSlotKindV2::Contributor(TriageContributorRole::TimelineAnalyst)
            | TriageSlotKindV2::Reviewer
    ) {
        return Ok(record(
            probe_key(
                &profile.id,
                &profile.base_url,
                &request.model_id,
                request.kind,
                &protocol,
            ),
            RoleQualificationV2::Unqualified,
            0,
            if matches!(request.kind, TriageSlotKindV2::Reviewer) {
                "reviewer_execution_unavailable"
            } else {
                "timeline_role_unsupported"
            },
        ));
    }
    let credentials = TurnProviderCredentialCache::new(secrets);
    let mut inputs = resolve_turn_inputs_from_profile_with_credential_cache(
        &credentials,
        cfg,
        profile.clone(),
        Some(&request.model_id),
    );
    inputs.deadline_plan.total_ms = request.deadline_ms;
    let backend = backend_for_resolved_turn(&inputs)
        .await
        .map_err(|_| TriageRoleProbeError::BackendUnavailable)?;
    qualify_role_v2_with_backend(TriageRoleProbeBackendInput {
        profile_id: profile.id.clone(),
        base_url: profile.base_url.clone(),
        model_id: request.model_id.clone(),
        kind: request.kind,
        protocol,
        deadline_ms: request.deadline_ms,
        cancel,
        backend: Arc::from(backend),
    })
    .await
}

/// Atomically publish one host-authored role record in the shared local store.
/// CLI and Tauri use this helper so persistence validation and replacement
/// semantics cannot drift between hosts.
pub fn publish_role_qualification_record(
    config_dir: &Path,
    record: TriageRoleQualificationRecordV1,
) -> Result<(), TriageRoleProbeError> {
    let path = cd_core::triage_role_qualification::triage_role_qualification_store_path(config_dir);
    let mut store = cd_core::triage_role_qualification::TriageRoleQualificationStoreV1::load(&path)
        .map_err(|_| TriageRoleProbeError::ProbeFailed)?;
    store
        .put(record)
        .map_err(|_| TriageRoleProbeError::ProbeFailed)?;
    store
        .save(&path)
        .map_err(|_| TriageRoleProbeError::ProbeFailed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use cd_core::agent::ScriptedBackend;

    fn protocol() -> &'static str {
        "openai-chat-completions"
    }

    fn valid_contribution(packet: &FastTriagePacketV1, role: ContributionRole) -> String {
        serde_json::json!({
            "schema": cd_core::multi_model::contributions::CONTRIBUTION_SCHEMA_V1,
            "packet_id": packet.packet_id(),
            "role": role,
            "abstained": true,
            "claims": [],
            "evidence_gaps": [],
            "contradictions": []
        })
        .to_string()
    }

    fn valid_finalizer(_packet: &FastTriagePacketV1) -> String {
        serde_json::json!({
            "schema": SCHEMA_V1,
            "candidates": [{
                "candidate_id": "candidate:role-probe",
                "observations": [{
                    "claim_id": "claim:probe",
                    "text": "synthetic observation",
                    "evidence_ids": ["evidence:role-probe"]
                }]
            }]
        })
        .to_string()
    }

    #[tokio::test]
    async fn contributor_probe_uses_pipeline_and_qualifies_valid_schema() {
        let packet = synthetic_packet();
        let role = ContributionRole::ObservationExtractor;
        let backend = Arc::new(ScriptedBackend::new(vec![ChatCompletion::from_parts(
            valid_contribution(&packet, role),
            Vec::new(),
            "stop",
        )]));
        let record = qualify_role_v2_with_backend(TriageRoleProbeBackendInput {
            profile_id: "profile:test".into(),
            base_url: "https://gateway.example/v1".into(),
            model_id: "model:test".into(),
            kind: TriageSlotKindV2::Contributor(TriageContributorRole::ObservationExtractor),
            protocol: protocol().into(),
            deadline_ms: 5_000,
            cancel: None,
            backend,
        })
        .await
        .expect("probe");
        assert_eq!(record.qualification, RoleQualificationV2::Qualified);
        assert_eq!(record.physical_provider_calls, 1);
        assert_eq!(record.semantic_corrections, 0);
    }

    #[tokio::test]
    async fn malformed_and_unsupported_roles_fail_closed_without_credit() {
        let malformed = Arc::new(ScriptedBackend::new(vec![ChatCompletion::from_parts(
            "not json",
            Vec::new(),
            "stop",
        )]));
        let bad = qualify_role_v2_with_backend(TriageRoleProbeBackendInput {
            profile_id: "profile:test".into(),
            base_url: "https://gateway.example/v1".into(),
            model_id: "model:test".into(),
            kind: TriageSlotKindV2::Contributor(TriageContributorRole::CausalProposer),
            protocol: protocol().into(),
            deadline_ms: 5_000,
            cancel: None,
            backend: malformed,
        })
        .await
        .expect("probe");
        assert_eq!(bad.qualification, RoleQualificationV2::Unqualified);
        assert_eq!(bad.physical_provider_calls, 1);
        let timeline = qualify_role_v2_with_backend(TriageRoleProbeBackendInput {
            profile_id: "profile:test".into(),
            base_url: "https://gateway.example/v1".into(),
            model_id: "model:test".into(),
            kind: TriageSlotKindV2::Contributor(TriageContributorRole::TimelineAnalyst),
            protocol: protocol().into(),
            deadline_ms: 5_000,
            cancel: None,
            backend: Arc::new(ScriptedBackend::new(Vec::new())),
        })
        .await
        .expect("probe");
        assert_eq!(timeline.qualification, RoleQualificationV2::Unqualified);
        assert_eq!(timeline.physical_provider_calls, 0);
    }

    #[tokio::test]
    async fn finalizer_probe_uses_host_validator_and_exact_ids() {
        let packet = synthetic_packet();
        let backend = Arc::new(ScriptedBackend::new(vec![ChatCompletion::from_parts(
            valid_finalizer(&packet),
            Vec::new(),
            "stop",
        )]));
        let record = qualify_role_v2_with_backend(TriageRoleProbeBackendInput {
            profile_id: "profile:test".into(),
            base_url: "https://gateway.example/v1".into(),
            model_id: "model:test".into(),
            kind: TriageSlotKindV2::Finalizer,
            protocol: protocol().into(),
            deadline_ms: 5_000,
            cancel: None,
            backend,
        })
        .await
        .expect("probe");
        assert_eq!(record.qualification, RoleQualificationV2::Qualified);
        assert_eq!(record.physical_provider_calls, 1);
    }
}
