//! Trusted host resolution for Triage Policy V2.
//!
//! This module is the boundary between application state and the pure V2
//! runner.  It reuses the existing profile/credential/backend factory and the
//! existing deterministic broad-triage brief; it does not create a second
//! provider client or a second evidence-selection path.

use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use cd_core::agent::build_fast_triage_packet;
use cd_core::chat::{ChatCompletion, ChatMessage, Role};
use cd_core::config::AppConfig;
use cd_core::fast_triage::{
    clock_compatibility_from_time_quality, FastTriageNeighborhoodBudget, FastTriagePacketV1,
};
use cd_core::investigation_answer::{validate_model_answer, AnswerEnvelopeV1};
use cd_core::investigation_answer::{AnswerBindingV1, LogSnapshotRevisionV1};
use cd_core::keychain_store::SecretStore;
use cd_core::multi_model::triage_policy::{
    CompiledRoleSlotV2, CompiledTriagePolicyV2, RolePreflightV2, RoleQualificationV2,
    SlotDispositionV2, TriagePolicyMode, TriagePolicyPreflightV2, TriagePolicyV2, TriageSlotKindV2,
};
use cd_core::tool_host::ToolHost;
use cd_core::triage_role_qualification::{
    triage_protocol_fingerprint, TriageRoleQualificationKeyV1, TriageRoleQualificationStoreV1,
};
use cd_core::triage_sdk::TriageContractError;

use crate::provider::{
    backend_for_resolved_turn, resolve_provider_profile,
    resolve_turn_inputs_from_profile_with_credential_cache, TurnProviderCredentialCache,
};
use crate::triage::compile_preflight;
use crate::triage_production::AuthorizedTriageBackendV1;
use crate::triage_production_runner::{
    authoritative_packet_digest, resolve_v2_production, ResolvedTriageProductionV1,
    TriageProductionHooks, TriageProductionRunInput, TriageProductionRunResultV1,
    TriageProductionRunnerError, TriageProductionRunnerV1,
};
use crate::turn::{bind_linked_corpus, unbind_linked_corpus, LinkedCorpusBinding};

/// Inputs owned by a trusted host for one linked V2 run.
#[derive(Debug, Clone)]
pub struct TriageHostRunInput {
    pub run_id: String,
    pub request_fingerprint: String,
    pub policy_fingerprint: String,
    pub corpus_id: String,
    /// Optional corpus revision requested by the SDK scope. The host proves
    /// the bound corpus is still at this revision before building the packet.
    pub corpus_revision: Option<u64>,
    /// Explicit source restriction from the SDK scope. The current broad
    /// packet builder is whole-corpus, so non-empty restrictions fail closed.
    pub source_ids: Vec<String>,
    pub user_text: String,
    pub cancellation_id: String,
    pub explicit_review_requested: bool,
    pub deadline_ms: u64,
    pub context_char_budget: usize,
    pub cancel: Option<Arc<AtomicBool>>,
}

/// Content-free evidence-to-source binding from the exact executed packet.
///
/// This is an owner-only process-local proof surface. It intentionally omits
/// evidence excerpts and every other raw private byte while retaining the
/// minimum mapping a benchmark recorder needs to translate validated
/// citations back to its source-neutral item identities.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TriageExecutedPacketEvidenceV1 {
    /// Host-minted evidence identity accepted by the production validator.
    pub evidence_id: String,
    /// Exact host source label attached to that evidence row.
    pub source_label: String,
}

/// Authoritative owner-only proof of the packet actually handed to production
/// model roles.
///
/// `packet_digest` is the deterministic evidence-ledger digest and is also the
/// value emitted by the production `PacketReady` event. `packet_id` binds that
/// ledger to the packet's scope, chronology, clock, and neighborhood facts.
/// Together with the corpus/revision and complete evidence-to-source mapping,
/// these fields let a host-local benchmark bridge prove same-snapshot identity
/// without receiving raw evidence bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TriageExecutedPacketProofV1 {
    /// Run identity associated with this materialized packet.
    pub run_id: String,
    /// Fingerprint of the exact public request associated with the run.
    pub request_fingerprint: String,
    /// Explicit privacy boundary; this proof must never cross a share-safe seam.
    pub privacy: cd_core::extension_contract::PacketPrivacyBoundary,
    /// Deterministic identity of the complete production packet.
    pub packet_id: String,
    /// Deterministic digest of the packet's authoritative evidence ledger.
    pub packet_digest: String,
    /// Exact bound corpus identity.
    pub corpus_id: String,
    /// Monotonic event revision of the exact bound corpus handle.
    pub corpus_revision: u64,
    /// Exact event/template/suppression analysis snapshot represented by every
    /// ledger row.
    pub snapshot_revision: LogSnapshotRevisionV1,
    /// Complete deterministic evidence-id to source-label mapping.
    pub evidence: Vec<TriageExecutedPacketEvidenceV1>,
}

impl TriageExecutedPacketProofV1 {
    fn from_packet(
        input: &TriageHostRunInput,
        packet: &FastTriagePacketV1,
        corpus_revision: u64,
    ) -> Self {
        let binding = packet.ledger().binding();
        Self {
            run_id: input.run_id.clone(),
            request_fingerprint: input.request_fingerprint.clone(),
            privacy: cd_core::extension_contract::PacketPrivacyBoundary::OwnerOnly,
            packet_id: packet.packet_id().into(),
            packet_digest: authoritative_packet_digest(packet).into(),
            corpus_id: binding.corpus_id.clone(),
            corpus_revision,
            snapshot_revision: binding.revision,
            evidence: packet
                .ledger()
                .entries()
                .into_iter()
                .map(|entry| TriageExecutedPacketEvidenceV1 {
                    evidence_id: entry.evidence_id,
                    source_label: entry.source_label,
                })
                .collect(),
        }
    }
}

/// Content-free refusal returned by an owner-only packet-proof observer.
/// Observer diagnostics remain with the observer and are never copied into a
/// replay, error string, or share-safe surface.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct TriagePacketProofObserverErrorV1;

impl TriagePacketProofObserverErrorV1 {
    /// Construct a content-free observer refusal.
    pub const fn new() -> Self {
        Self
    }
}

impl std::fmt::Display for TriagePacketProofObserverErrorV1 {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("packet_proof_observer_failed")
    }
}

impl std::error::Error for TriagePacketProofObserverErrorV1 {}

/// Synchronous owner-only callback invoked exactly once after production
/// packet materialization and before credentials, providers, or models.
pub trait TriageExecutedPacketObserverV1: Send + Sync {
    /// Accept or refuse the authoritative packet proof. Refusal fails closed.
    fn observe(
        &self,
        proof: &TriageExecutedPacketProofV1,
    ) -> Result<(), TriagePacketProofObserverErrorV1>;
}

impl<F> TriageExecutedPacketObserverV1 for F
where
    F: Fn(&TriageExecutedPacketProofV1) -> Result<(), TriagePacketProofObserverErrorV1>
        + Send
        + Sync,
{
    fn observe(
        &self,
        proof: &TriageExecutedPacketProofV1,
    ) -> Result<(), TriagePacketProofObserverErrorV1> {
        self(proof)
    }
}

/// Shareable process-local packet-proof observer handle.
pub type TriagePacketProofObserverV1 = Arc<dyn TriageExecutedPacketObserverV1>;

/// Result of host resolution before a provider operation begins.
pub struct ResolvedTriageHostV1 {
    pub compiled: CompiledTriagePolicyV2,
    pub packet: FastTriagePacketV1,
    pub resolution: ResolvedTriageProductionV1,
    pub binding: LinkedCorpusBinding,
}

/// Build exact V2 preflight facts from the trusted local profile set and the
/// separate host-owned role qualification store.  Generic capability reports
/// are intentionally not consulted: transport compatibility alone cannot
/// authorize a packet/validator workflow.  This helper is shared by CLI and
/// Tauri so they cannot drift in identity, egress, or qualification rules.
pub fn preflight_for_policy(
    cfg: &AppConfig,
    policy: &TriagePolicyV2,
    role_store: &TriageRoleQualificationStoreV1,
) -> TriagePolicyPreflightV2 {
    let mut slots = Vec::new();
    slots.extend(policy.contributors.iter().map(|slot| {
        (
            slot.slot_id.clone(),
            TriageSlotKindV2::Contributor(slot.role),
            slot.model.clone(),
        )
    }));
    if let Some(slot) = &policy.finalizer {
        slots.push((
            slot.slot_id.clone(),
            TriageSlotKindV2::Finalizer,
            slot.model.clone(),
        ));
    }
    if let Some(slot) = &policy.reviewer {
        slots.push((
            slot.slot_id.clone(),
            TriageSlotKindV2::Reviewer,
            slot.model.clone(),
        ));
    }

    TriagePolicyPreflightV2 {
        roles: slots
            .into_iter()
            .map(|(slot_id, kind, model)| {
                let profile = cfg
                    .providers
                    .profiles
                    .iter()
                    .find(|profile| profile.id == model.profile_id);
                let available = profile.is_some();
                let remote = profile.is_some_and(|profile| !profile.local_only);
                if policy.mode == TriagePolicyMode::Standard {
                    return RolePreflightV2 {
                        slot_id,
                        model,
                        kind,
                        available,
                        qualification: RoleQualificationV2::Qualified,
                        remote,
                        qualification_schema_id: None,
                        workflow_id: None,
                        protocol_fingerprint: None,
                    };
                }

                let Some(profile) = profile else {
                    return RolePreflightV2 {
                        slot_id,
                        model,
                        kind,
                        available: false,
                        qualification: RoleQualificationV2::Unverified,
                        remote,
                        qualification_schema_id: None,
                        workflow_id: None,
                        protocol_fingerprint: None,
                    };
                };
                let transport =
                    cd_core::capability_qualification::QualificationKey::with_provider_kind(
                        &profile.id,
                        &profile.base_url,
                        &model.model_id,
                        profile.kind,
                    )
                    .transport_protocol;
                let role_key = TriageRoleQualificationKeyV1::current(
                    &profile.id,
                    &profile.base_url,
                    &model.model_id,
                    kind,
                    triage_protocol_fingerprint(&transport),
                );
                let qualification = role_store
                    .get(&role_key)
                    .map(|record| record.qualification)
                    .unwrap_or(RoleQualificationV2::Unverified);
                RolePreflightV2 {
                    slot_id,
                    model,
                    kind,
                    available,
                    qualification,
                    remote,
                    qualification_schema_id: Some(role_key.qualification_schema_id),
                    workflow_id: Some(role_key.workflow_id),
                    protocol_fingerprint: Some(role_key.protocol_fingerprint),
                }
            })
            .collect(),
    }
}

/// Content-free errors from the trusted host boundary.
#[derive(Debug, Clone)]
pub enum TriageHostError {
    Corpus(String),
    Scope(String),
    Cancelled,
    Deadline,
    Policy(String),
    Profile(String),
    Backend(String),
    /// Owner-only packet proof could not be accepted before provider setup.
    PacketProofObserver,
    Runner(TriageProductionRunnerError),
    Contract(TriageContractError),
}

fn validate_requested_scope(
    corpus_revision: Option<u64>,
    source_ids: &[String],
    bound_revision: u64,
) -> Result<(), &'static str> {
    if !source_ids.is_empty() {
        return Err("source_scope_not_supported_by_v2_packet_builder");
    }
    if corpus_revision.is_some_and(|revision| revision != bound_revision) {
        return Err("corpus_revision_changed_before_v2_packet_build");
    }
    Ok(())
}

/// Clamp a stock/default operation cap to the host's remaining whole-turn
/// allowance. Explicit provenance is checked by [`align_stock_phase_caps`].
fn align_stock_phase_cap(configured_ms: u64, remaining_ms: u64) -> u64 {
    configured_ms.min(remaining_ms)
}

fn align_stock_phase_caps(policy: &mut TriagePolicyV2, remaining_ms: u64) {
    if policy.budget.phase_cap_authority
        != cd_core::multi_model::triage_policy::TriagePhaseCapAuthorityV2::StockDefault
    {
        return;
    }
    policy.budget.contributors.operation_timeout_ms = align_stock_phase_cap(
        policy.budget.contributors.operation_timeout_ms,
        remaining_ms,
    );
    policy.budget.corrections.operation_timeout_ms =
        align_stock_phase_cap(policy.budget.corrections.operation_timeout_ms, remaining_ms);
    policy.budget.finalizer.operation_timeout_ms =
        align_stock_phase_cap(policy.budget.finalizer.operation_timeout_ms, remaining_ms);
    policy.budget.reviewer.operation_timeout_ms =
        align_stock_phase_cap(policy.budget.reviewer.operation_timeout_ms, remaining_ms);

    let finalizer_reserve = policy
        .finalizer
        .as_ref()
        .map(|_| policy.budget.finalizer.reserve_ms)
        .unwrap_or(0);
    let reviewer_reserve = policy
        .reviewer
        .as_ref()
        .map(|_| policy.budget.reviewer.reserve_ms)
        .unwrap_or(0);
    let total_reserve = finalizer_reserve.saturating_add(reviewer_reserve);
    if total_reserve > remaining_ms && total_reserve > 0 {
        let bounded_finalizer = ((u128::from(remaining_ms) * u128::from(finalizer_reserve))
            / u128::from(total_reserve)) as u64;
        if policy.finalizer.is_some() {
            policy.budget.finalizer.reserve_ms = bounded_finalizer;
        }
        if policy.reviewer.is_some() {
            policy.budget.reviewer.reserve_ms = remaining_ms.saturating_sub(bounded_finalizer);
        }
    }
}

fn validate_preflight_profile_bindings(
    cfg: &AppConfig,
    preflight: &TriagePolicyPreflightV2,
) -> Result<(), TriageHostError> {
    for fact in &preflight.roles {
        let profile = cfg
            .providers
            .profiles
            .iter()
            .find(|profile| profile.id == fact.model.profile_id);
        let expected_remote = profile.is_some_and(|profile| !profile.local_only);
        if fact.remote != expected_remote {
            return Err(TriageHostError::Profile(
                "preflight_egress_binding_mismatch".into(),
            ));
        }
        if fact.available && profile.is_none() {
            return Err(TriageHostError::Profile(
                "preflight_profile_unavailable".into(),
            ));
        }
    }
    Ok(())
}

fn slot_allows_remote(policy: &TriagePolicyV2, slot_id: &str) -> bool {
    policy
        .contributors
        .iter()
        .find(|slot| slot.slot_id == slot_id)
        .map(|slot| slot.allow_remote)
        .or_else(|| {
            policy
                .finalizer
                .as_ref()
                .filter(|slot| slot.slot_id == slot_id)
                .map(|slot| slot.allow_remote)
        })
        .or_else(|| {
            policy
                .reviewer
                .as_ref()
                .filter(|slot| slot.slot_id == slot_id)
                .map(|slot| slot.allow_remote)
        })
        .unwrap_or(false)
}

fn validate_runtime_egress(
    cfg: &AppConfig,
    policy: &TriagePolicyV2,
    compiled: &CompiledTriagePolicyV2,
) -> Result<(), TriageHostError> {
    for slot in compiled
        .slots
        .iter()
        .filter(|slot| slot.disposition == SlotDispositionV2::Admitted)
    {
        let profile = cfg
            .providers
            .profiles
            .iter()
            .find(|profile| profile.id == slot.model.profile_id)
            .ok_or_else(|| TriageHostError::Profile("provider_profile_unavailable".into()))?;
        if !profile.local_only && !slot_allows_remote(policy, &slot.slot_id) {
            return Err(TriageHostError::Profile("egress_denied".into()));
        }
    }
    Ok(())
}

async fn wait_for_cancel(cancel: Arc<AtomicBool>) {
    loop {
        if cancel.load(std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

/// Await provider construction inside the same host-owned budget as the
/// subsequent provider calls.  Construction can perform authentication or
/// token refresh, so allowing it to run outside the turn deadline would let
/// setup outlive the request and hand the runner a stale allowance.
async fn await_backend_with_turn_budget<F, T>(
    started: Instant,
    deadline_ms: u64,
    cancel: Option<Arc<AtomicBool>>,
    future: F,
) -> Result<T, TriageHostError>
where
    F: Future<Output = cd_core::error::CoreResult<T>>,
{
    let remaining_ms =
        deadline_ms.saturating_sub(started.elapsed().as_millis().min(u64::MAX as u128) as u64);
    if remaining_ms == 0 {
        return Err(TriageHostError::Deadline);
    }
    let cancel_wait: Pin<Box<dyn Future<Output = ()> + Send>> = if let Some(cancel) = cancel {
        Box::pin(wait_for_cancel(cancel))
    } else {
        Box::pin(std::future::pending())
    };
    tokio::pin!(cancel_wait);
    tokio::select! {
        result = tokio::time::timeout(Duration::from_millis(remaining_ms), future) => {
            match result {
                Ok(Ok(value)) => Ok(value),
                Ok(Err(_)) => Err(TriageHostError::Backend("backend_build_failed".into())),
                Err(_) => Err(TriageHostError::Deadline),
            }
        }
        _ = &mut cancel_wait => Err(TriageHostError::Cancelled),
    }
}

/// A conservative production hook: only a finalizer may create an
/// authoritative answer envelope.  Contributor slots are validated by the
/// typed contribution pipeline before this hook is reached.  Reviewer and
/// other generic slots have no equivalent typed validator yet, so they fail
/// closed instead of treating non-empty prose as an accepted contribution.
/// The envelope is derived from the immutable packet ledger; model text never
/// supplies evidence metadata or authority.
#[derive(Debug, Default)]
pub struct HostValidatedAnswerHooks {
    accepted: Mutex<std::collections::BTreeMap<String, AnswerEnvelopeV1>>,
}

#[async_trait::async_trait]
impl TriageProductionHooks for HostValidatedAnswerHooks {
    async fn validate(
        &self,
        slot: &CompiledRoleSlotV2,
        response: &ChatCompletion,
        packet: &FastTriagePacketV1,
        _reconciliation: &cd_core::triage_sdk::TriageReconciliationV1,
    ) -> crate::triage_production_runner::TriageValidationDecision {
        if !matches!(slot.kind, TriageSlotKindV2::Finalizer) {
            return crate::triage_production_runner::TriageValidationDecision::rejected(
                "typed_role_proposal_required",
            );
        }
        let prepared = match cd_core::linked_triage_contract::preparation_for_host_validation(
            &response.content,
        ) {
            Ok(prepared) => prepared,
            Err(category) => {
                return crate::triage_production_runner::TriageValidationDecision::rejected(
                    category.as_str(),
                )
            }
        };
        match validate_model_answer(&prepared, packet.ledger()) {
            Ok(envelope) => {
                if let Ok(mut accepted) = self.accepted.lock() {
                    accepted.insert(slot.slot_id.clone(), envelope);
                    crate::triage_production_runner::TriageValidationDecision::accepted()
                } else {
                    crate::triage_production_runner::TriageValidationDecision::rejected(
                        "host_validation_unavailable",
                    )
                }
            }
            Err(error) => {
                crate::triage_production_runner::TriageValidationDecision::rejected(error.as_str())
            }
        }
    }

    async fn correction_messages(
        &self,
        slot: &CompiledRoleSlotV2,
        _response: &ChatCompletion,
        reason_codes: &[String],
        packet: &FastTriagePacketV1,
        _reconciliation: &cd_core::triage_sdk::TriageReconciliationV1,
    ) -> Option<Vec<ChatMessage>> {
        if !matches!(slot.kind, TriageSlotKindV2::Finalizer) {
            return None;
        }
        Some(vec![
            ChatMessage {
                role: Role::System,
                content: "Return exactly one ContextDesk investigation_answer.v1 JSON object. Use only literal evidence ids from the host manifest; do not add host fields.".into(),
                tool_call_id: None,
                tool_calls: None,
            },
            ChatMessage {
                role: Role::User,
                content: format!(
                    "The previous proposal was rejected for bounded categories: {}. Correct it once.\n\nHOST MANIFEST:\n{}",
                    reason_codes.join(","),
                    packet.manifest_json()
                ),
                tool_call_id: None,
                tool_calls: None,
            },
        ])
    }

    async fn finalize(
        &self,
        slot: &CompiledRoleSlotV2,
        _response: &ChatCompletion,
        _packet: &FastTriagePacketV1,
        _reconciliation: &cd_core::triage_sdk::TriageReconciliationV1,
    ) -> Option<AnswerEnvelopeV1> {
        self.accepted.lock().ok()?.remove(&slot.slot_id)
    }
}

impl std::fmt::Display for TriageHostError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Corpus(_) => "corpus_binding_failed",
            Self::Scope(_) => "triage_scope_rejected",
            Self::Cancelled => "triage_cancelled",
            Self::Deadline => "triage_deadline_exhausted",
            Self::Policy(_) => "policy_preflight_rejected",
            Self::Profile(_) => "provider_profile_unavailable",
            Self::Backend(_) => "provider_backend_unavailable",
            Self::PacketProofObserver => "packet_proof_observer_failed",
            Self::Runner(error) => return write!(f, "{error}"),
            Self::Contract(_) => "triage_contract_failed",
        })
    }
}

impl std::error::Error for TriageHostError {}

/// Resolve exact policy slots to existing authorized chat backends and build
/// the canonical host packet.  No network call occurs here; backend
/// construction is the same production factory used by ordinary chat and is
/// intentionally delayed until exact qualification/egress facts compile.
pub async fn resolve_v2_host(
    host: &mut ToolHost,
    cache_root: &Path,
    cfg: &AppConfig,
    secrets: &dyn SecretStore,
    policy: &TriagePolicyV2,
    preflight: &TriagePolicyPreflightV2,
    input: &TriageHostRunInput,
) -> Result<ResolvedTriageHostV1, TriageHostError> {
    resolve_v2_host_with_packet_proof_observer(
        host, cache_root, cfg, secrets, policy, preflight, input, None,
    )
    .await
}

/// Resolve a production host run while exposing the exact materialized packet
/// to an optional owner-only observer before credential or provider work.
///
/// The established [`resolve_v2_host`] entry point is a no-observer wrapper.
/// An observer refusal restores the prior host corpus binding and fails closed;
/// no credential lookup or backend construction occurs.
#[allow(clippy::too_many_arguments)]
pub async fn resolve_v2_host_with_packet_proof_observer(
    host: &mut ToolHost,
    cache_root: &Path,
    cfg: &AppConfig,
    secrets: &dyn SecretStore,
    policy: &TriagePolicyV2,
    preflight: &TriagePolicyPreflightV2,
    input: &TriageHostRunInput,
    packet_proof_observer: Option<&dyn TriageExecutedPacketObserverV1>,
) -> Result<ResolvedTriageHostV1, TriageHostError> {
    validate_preflight_profile_bindings(cfg, preflight)?;
    let compiled = compile_preflight(policy, preflight)
        .map_err(|_| TriageHostError::Policy("policy_preflight_rejected".into()))?;
    validate_runtime_egress(cfg, policy, &compiled)?;
    if input.deadline_ms == 0 || input.context_char_budget == 0 {
        return Err(TriageHostError::Policy("invalid_host_budget".into()));
    }

    let binding = bind_linked_corpus(host, cache_root, &input.corpus_id)
        .map_err(|error| TriageHostError::Corpus(error.to_string()))?;
    if let Err(reason) =
        validate_requested_scope(input.corpus_revision, &input.source_ids, binding.revision)
    {
        unbind_linked_corpus(host, binding);
        return Err(TriageHostError::Scope(reason.into()));
    }
    let started = Instant::now();
    let job = match host.prepare_broad_log_triage_brief() {
        Ok(job) => job,
        Err(error) => {
            unbind_linked_corpus(host, binding);
            return Err(TriageHostError::Corpus(error.to_string()));
        }
    };
    let abort = job.abort_handle();
    let worker = tokio::task::spawn_blocking(move || job.build());
    let mut deadline = Box::pin(tokio::time::sleep(Duration::from_millis(input.deadline_ms)));
    let cancel_wait: std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> =
        if let Some(cancel) = input.cancel.clone() {
            Box::pin(wait_for_cancel(cancel))
        } else {
            Box::pin(std::future::pending())
        };
    tokio::pin!(cancel_wait);
    let brief = tokio::select! {
        result = worker => match result {
            Ok(Ok(brief)) => brief,
            Ok(Err(error)) => {
                unbind_linked_corpus(host, binding);
                return Err(TriageHostError::Corpus(error.to_string()));
            }
            Err(_) => {
                unbind_linked_corpus(host, binding);
                return Err(TriageHostError::Corpus("deterministic_triage_worker_failed".into()));
            }
        },
        _ = &mut deadline => {
            abort.abort();
            unbind_linked_corpus(host, binding);
            return Err(TriageHostError::Deadline);
        },
        _ = &mut cancel_wait => {
            abort.abort();
            unbind_linked_corpus(host, binding);
            return Err(TriageHostError::Cancelled);
        },
    };
    let elapsed_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
    let mut remaining_deadline_ms = input.deadline_ms.saturating_sub(elapsed_ms);
    if remaining_deadline_ms == 0 {
        unbind_linked_corpus(host, binding);
        return Err(TriageHostError::Deadline);
    }
    let answer_binding = AnswerBindingV1 {
        session_id: format!("triage:{}", input.run_id),
        turn_id: input.run_id.clone(),
        corpus_id: input.corpus_id.clone(),
        revision: LogSnapshotRevisionV1 {
            event_revision: brief.event_revision,
            template_analysis_revision: brief.template_analysis_revision,
            suppression_revision: brief.suppression_revision,
        },
        ledger_digest: String::new(),
    };
    let packet = match build_fast_triage_packet(
        &brief.candidate_groups,
        brief.comparison_context.as_ref(),
        answer_binding,
        clock_compatibility_from_time_quality(brief.time_quality),
        FastTriageNeighborhoodBudget::default(),
    ) {
        Ok(packet) => packet,
        Err(error) => {
            unbind_linked_corpus(host, binding);
            return Err(TriageHostError::Contract(
                TriageContractError::InvalidField(error.as_str()),
            ));
        }
    };

    let packet_binding = packet.ledger().binding();
    if packet_binding.corpus_id != input.corpus_id
        || packet_binding.revision != binding.snapshot_revision
    {
        unbind_linked_corpus(host, binding);
        return Err(TriageHostError::Contract(
            TriageContractError::InvalidField("packet_snapshot_binding"),
        ));
    }

    if let Some(observer) = packet_proof_observer {
        let proof = TriageExecutedPacketProofV1::from_packet(input, &packet, binding.revision);
        if observer.observe(&proof).is_err() {
            unbind_linked_corpus(host, binding);
            return Err(TriageHostError::PacketProofObserver);
        }
    }

    // A proof observer may synchronously request cancellation. Recheck both
    // host controls before even constructing the credential cache so that the
    // observer boundary cannot introduce a secret-read race.
    if input
        .cancel
        .as_ref()
        .is_some_and(|cancel| cancel.load(std::sync::atomic::Ordering::SeqCst))
    {
        unbind_linked_corpus(host, binding);
        return Err(TriageHostError::Cancelled);
    }
    if started.elapsed() >= Duration::from_millis(input.deadline_ms) {
        unbind_linked_corpus(host, binding);
        return Err(TriageHostError::Deadline);
    }

    let mut budget_cfg = cfg.clone();
    budget_cfg.router.deadline_is_explicit = true;
    let credentials = TurnProviderCredentialCache::new(secrets);
    let mut authorized = Vec::new();
    for slot in compiled
        .slots
        .iter()
        .filter(|slot| slot.disposition == SlotDispositionV2::Admitted)
    {
        let slot_remaining_ms = input
            .deadline_ms
            .saturating_sub(started.elapsed().as_millis().min(u64::MAX as u128) as u64);
        if slot_remaining_ms == 0 {
            unbind_linked_corpus(host, binding);
            return Err(TriageHostError::Deadline);
        }
        budget_cfg.router.deadline_ms = slot_remaining_ms;
        let profile = match resolve_provider_profile(&budget_cfg, Some(&slot.model.profile_id)) {
            Ok(profile) => profile,
            Err(error) => {
                unbind_linked_corpus(host, binding);
                return Err(TriageHostError::Profile(error));
            }
        };
        if profile.chat_model != slot.model.model_id {
            // Do not silently replace the selected catalog id with the profile
            // default.  The slot is the exact identity returned by discovery.
            let mut selected = profile.clone();
            selected.chat_model = slot.model.model_id.clone();
            let resolved = resolve_turn_inputs_from_profile_with_credential_cache(
                &credentials,
                &budget_cfg,
                selected,
                Some(slot.model.model_id.as_str()),
            );
            let backend = match await_backend_with_turn_budget(
                started,
                input.deadline_ms,
                input.cancel.clone(),
                backend_for_resolved_turn(&resolved),
            )
            .await
            {
                Ok(backend) => backend,
                Err(error) => {
                    unbind_linked_corpus(host, binding);
                    return Err(error);
                }
            };
            authorized.push(AuthorizedTriageBackendV1 {
                slot_id: slot.slot_id.clone(),
                model: slot.model.clone(),
                backend: Arc::from(backend),
            });
        } else {
            let resolved = resolve_turn_inputs_from_profile_with_credential_cache(
                &credentials,
                &budget_cfg,
                profile,
                Some(slot.model.model_id.as_str()),
            );
            let backend = match await_backend_with_turn_budget(
                started,
                input.deadline_ms,
                input.cancel.clone(),
                backend_for_resolved_turn(&resolved),
            )
            .await
            {
                Ok(backend) => backend,
                Err(error) => {
                    unbind_linked_corpus(host, binding);
                    return Err(error);
                }
            };
            authorized.push(AuthorizedTriageBackendV1 {
                slot_id: slot.slot_id.clone(),
                model: slot.model.clone(),
                backend: Arc::from(backend),
            });
        }
    }

    // Setup/authentication consumed part of the original turn. Never hand
    // the runner the pre-setup allowance after a slow provider factory.
    remaining_deadline_ms = input
        .deadline_ms
        .saturating_sub(started.elapsed().as_millis().min(u64::MAX as u128) as u64);
    if remaining_deadline_ms == 0 {
        unbind_linked_corpus(host, binding);
        return Err(TriageHostError::Deadline);
    }

    // The deterministic phase has consumed part of the user budget. The
    // runner starts now, so bind its compiled whole-turn budget to the actual
    // remaining allowance; otherwise an explicit original deadline would be
    // double-counted and the provider phase could outlive the request.
    //
    // Resolve only stock/default operation caps and terminal reserves against
    // the remaining whole-turn allowance. Explicit user-authored values remain
    // authoritative and fail closed when their active reserves cannot fit.
    let mut execution_policy = policy.clone();
    execution_policy.budget.whole_turn_deadline_ms = Some(remaining_deadline_ms);
    align_stock_phase_caps(&mut execution_policy, remaining_deadline_ms);
    let resolution = match resolve_v2_production(
        &execution_policy,
        preflight,
        authorized,
        remaining_deadline_ms,
        input.context_char_budget,
        FastTriageNeighborhoodBudget::default(),
    ) {
        Ok(resolution) => resolution,
        Err(error) => {
            unbind_linked_corpus(host, binding);
            return Err(TriageHostError::Runner(error));
        }
    };
    Ok(ResolvedTriageHostV1 {
        compiled,
        packet,
        resolution,
        binding,
    })
}

/// Execute one resolved host run and always restore the previous corpus scope.
pub async fn run_v2_host<H: TriageProductionHooks + ?Sized>(
    host: &mut ToolHost,
    resolved: ResolvedTriageHostV1,
    input: TriageHostRunInput,
    hooks: &H,
    event_sink: Option<crate::triage_production_runner::TriageEventSink>,
) -> Result<TriageProductionRunResultV1, TriageHostError> {
    let packet = resolved.packet.clone();
    let runner = TriageProductionRunnerV1::new(resolved.resolution);
    let run_input = TriageProductionRunInput {
        run_id: input.run_id,
        request_fingerprint: input.request_fingerprint,
        policy_fingerprint: input.policy_fingerprint,
        packet,
        user_text: input.user_text,
        cancellation_id: input.cancellation_id,
        explicit_review_requested: input.explicit_review_requested,
        cancel: input.cancel,
    };
    let result = runner
        .run_with_event_sink(run_input, hooks, event_sink)
        .await
        .map_err(TriageHostError::Runner);
    unbind_linked_corpus(host, resolved.binding);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use cd_core::config::AppConfig;
    use cd_core::error::CoreResult;
    use cd_core::index::KeywordIndex;
    use cd_core::investigation_answer::{EvidenceRole, HostEvidenceEntry, HostEvidenceLedger};
    use cd_core::keychain_store::SecretStore;
    use cd_core::model_ref::ModelRef;
    use cd_core::multi_model::triage_policy::{
        ReviewerConditionV2, ReviewerSlotV2, RolePreflightV2, RoleQualificationV2, RoleRequirement,
        TriageBudgetV2, TriageSlotKindV2,
    };
    use cd_core::providers::ProviderProfile;
    use cd_core::triage_role_qualification::{
        triage_protocol_fingerprint, TriageRoleQualificationKeyV1, TriageRoleQualificationRecordV1,
        TriageRoleQualificationStoreV1,
    };
    use cd_core::triage_sdk::TriageReconciliationV1;
    use cd_core::workspace::Workspace;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[derive(Clone, Default)]
    struct SequencedSecretStore {
        reads: Arc<AtomicUsize>,
        order: Arc<Mutex<Vec<&'static str>>>,
    }

    impl SecretStore for SequencedSecretStore {
        fn set(&self, _ref_id: &str, _secret: &str) -> CoreResult<()> {
            Ok(())
        }

        fn get(&self, _ref_id: &str) -> CoreResult<Option<String>> {
            self.reads.fetch_add(1, Ordering::SeqCst);
            self.order.lock().unwrap().push("credential");
            Ok(Some("fixture-secret".into()))
        }

        fn delete(&self, _ref_id: &str) -> CoreResult<()> {
            Ok(())
        }
    }

    struct PacketProofFixture {
        _workspace: tempfile::TempDir,
        cache: tempfile::TempDir,
        host: ToolHost,
        config: AppConfig,
        secrets: SequencedSecretStore,
        policy: TriagePolicyV2,
        preflight: TriagePolicyPreflightV2,
        input: TriageHostRunInput,
    }

    fn packet_proof_fixture() -> PacketProofFixture {
        let workspace = tempfile::tempdir().expect("workspace");
        let logs = workspace.path().join("logs");
        std::fs::create_dir_all(&logs).expect("logs");
        std::fs::write(
            logs.join("worker.log"),
            concat!(
                "2026-08-18T01:00:00Z ERROR worker pool exhausted request=req-7\n",
                "2026-08-18T01:00:01Z WARN worker retrying request=req-7\n"
            ),
        )
        .expect("fixture log");
        let cache = tempfile::tempdir().expect("cache");
        let report =
            cd_core::log_analysis::ingest_path(cache.path(), &logs, "packet-proof", None, "none")
                .expect("ingest fixture");
        let index = KeywordIndex::build(&Workspace::new(
            "packet-proof",
            vec![workspace.path().to_path_buf()],
        ))
        .expect("index");
        let mut host = ToolHost::new(
            Workspace::new("packet-proof", vec![workspace.path().to_path_buf()]),
            index,
            None,
        );
        host.set_log_analysis(true, Some(cache.path().to_path_buf()));
        host.set_log_corpus_scope(Some("prior-scope".into()));
        host.set_active_log_corpus(Some("prior-active".into()));

        let mut profile = ProviderProfile::ollama_local();
        profile.id = "profile:packet-proof".into();
        profile.chat_model = "model:packet-proof".into();
        profile.api_key_ref = Some("secret:packet-proof".into());
        let model = ModelRef {
            profile_id: profile.id.clone(),
            model_id: profile.chat_model.clone(),
        };
        let policy = TriagePolicyV2::standard(model, false);
        let mut config = AppConfig::default();
        config.providers.profiles.push(profile.clone());
        let transport = cd_core::capability_qualification::QualificationKey::with_provider_kind(
            &profile.id,
            &profile.base_url,
            &profile.chat_model,
            profile.kind,
        )
        .transport_protocol;
        let kind = TriageSlotKindV2::Finalizer;
        let mut qualifications = TriageRoleQualificationStoreV1::default();
        qualifications
            .put(TriageRoleQualificationRecordV1 {
                key: TriageRoleQualificationKeyV1::current(
                    &profile.id,
                    &profile.base_url,
                    &profile.chat_model,
                    kind,
                    triage_protocol_fingerprint(&transport),
                ),
                qualification: RoleQualificationV2::Qualified,
                physical_provider_calls: 1,
                semantic_corrections: 0,
                reason: "fixture-qualified".into(),
                tested_at: 1,
            })
            .expect("qualification");
        let preflight = preflight_for_policy(&config, &policy, &qualifications);
        let input = TriageHostRunInput {
            run_id: "run:packet-proof".into(),
            request_fingerprint: "request:packet-proof".into(),
            policy_fingerprint: "policy:packet-proof".into(),
            corpus_id: report.corpus_id,
            corpus_revision: None,
            source_ids: Vec::new(),
            user_text: "what caused the worker failure?".into(),
            cancellation_id: "cancel:packet-proof".into(),
            explicit_review_requested: false,
            deadline_ms: 60_000,
            context_char_budget: 100_000,
            cancel: None,
        };
        PacketProofFixture {
            _workspace: workspace,
            cache,
            host,
            config,
            secrets: SequencedSecretStore::default(),
            policy,
            preflight,
            input,
        }
    }

    fn assert_prior_scope_restored(host: &ToolHost) {
        assert_eq!(host.log_corpus_scope(), Some("prior-scope"));
        assert_eq!(host.active_log_corpus(), Some("prior-active"));
    }

    #[tokio::test]
    async fn provider_setup_observes_remaining_turn_deadline() {
        let result = await_backend_with_turn_budget(Instant::now(), 20, None, async {
            tokio::time::sleep(Duration::from_millis(50)).await;
            Ok::<_, cd_core::error::CoreError>(())
        })
        .await;
        assert!(matches!(result, Err(TriageHostError::Deadline)));
    }

    #[tokio::test]
    async fn provider_setup_observes_turn_cancellation() {
        let cancel = Arc::new(AtomicBool::new(false));
        let signal = Arc::clone(&cancel);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(10)).await;
            signal.store(true, std::sync::atomic::Ordering::SeqCst);
        });
        let result = await_backend_with_turn_budget(Instant::now(), 500, Some(cancel), async {
            tokio::time::sleep(Duration::from_millis(100)).await;
            Ok::<_, cd_core::error::CoreError>(())
        })
        .await;
        assert!(matches!(result, Err(TriageHostError::Cancelled)));
    }

    #[tokio::test]
    async fn packet_proof_precedes_credentials_and_matches_the_executed_packet() {
        let mut fixture = packet_proof_fixture();
        let observed = Arc::new(Mutex::new(None));
        let captured = Arc::clone(&observed);
        let order = Arc::clone(&fixture.secrets.order);
        let observer = move |proof: &TriageExecutedPacketProofV1| {
            order.lock().unwrap().push("proof");
            *captured.lock().unwrap() = Some(proof.clone());
            Ok(())
        };

        let resolved = resolve_v2_host_with_packet_proof_observer(
            &mut fixture.host,
            fixture.cache.path(),
            &fixture.config,
            &fixture.secrets,
            &fixture.policy,
            &fixture.preflight,
            &fixture.input,
            Some(&observer),
        )
        .await
        .expect("host resolves after proof acceptance");

        assert_eq!(
            fixture.secrets.order.lock().unwrap().as_slice(),
            ["proof", "credential"]
        );
        assert_eq!(fixture.secrets.reads.load(Ordering::SeqCst), 1);
        let proof = observed.lock().unwrap().clone().expect("proof");
        let binding = resolved.packet.ledger().binding();
        assert_eq!(proof.run_id, fixture.input.run_id);
        assert_eq!(proof.request_fingerprint, fixture.input.request_fingerprint);
        assert_eq!(
            proof.privacy,
            cd_core::extension_contract::PacketPrivacyBoundary::OwnerOnly
        );
        assert_eq!(proof.packet_id, resolved.packet.packet_id());
        assert_eq!(proof.packet_digest, binding.ledger_digest);
        assert_ne!(proof.packet_digest, proof.packet_id);
        assert_eq!(proof.corpus_id, binding.corpus_id);
        assert_eq!(proof.corpus_revision, resolved.binding.revision);
        assert_eq!(proof.snapshot_revision, binding.revision);
        assert_eq!(proof.snapshot_revision, resolved.binding.snapshot_revision);
        assert_eq!(
            proof.evidence,
            resolved
                .packet
                .ledger()
                .entries()
                .into_iter()
                .map(|entry| TriageExecutedPacketEvidenceV1 {
                    evidence_id: entry.evidence_id,
                    source_label: entry.source_label,
                })
                .collect::<Vec<_>>()
        );
        assert!(!proof.evidence.is_empty());
        assert!(proof
            .evidence
            .iter()
            .all(|entry| !entry.evidence_id.is_empty() && !entry.source_label.is_empty()));
        assert!(!format!("{proof:?}").contains("pool exhausted"));

        unbind_linked_corpus(&mut fixture.host, resolved.binding);
        assert_prior_scope_restored(&fixture.host);
    }

    #[tokio::test]
    async fn packet_proof_refusal_fails_before_credentials_and_restores_scope() {
        let mut fixture = packet_proof_fixture();
        let calls = Arc::new(AtomicUsize::new(0));
        let observed_calls = Arc::clone(&calls);
        let observer = move |_proof: &TriageExecutedPacketProofV1| {
            observed_calls.fetch_add(1, Ordering::SeqCst);
            Err(TriagePacketProofObserverErrorV1::new())
        };

        let result = resolve_v2_host_with_packet_proof_observer(
            &mut fixture.host,
            fixture.cache.path(),
            &fixture.config,
            &fixture.secrets,
            &fixture.policy,
            &fixture.preflight,
            &fixture.input,
            Some(&observer),
        )
        .await;

        assert!(matches!(result, Err(TriageHostError::PacketProofObserver)));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(fixture.secrets.reads.load(Ordering::SeqCst), 0);
        assert_prior_scope_restored(&fixture.host);
    }

    #[tokio::test]
    async fn packet_proof_observer_cancellation_stops_before_credentials_and_cleans_up() {
        let mut fixture = packet_proof_fixture();
        let cancel = Arc::new(AtomicBool::new(false));
        fixture.input.cancel = Some(Arc::clone(&cancel));
        let observer = move |_proof: &TriageExecutedPacketProofV1| {
            cancel.store(true, Ordering::SeqCst);
            Ok(())
        };

        let result = resolve_v2_host_with_packet_proof_observer(
            &mut fixture.host,
            fixture.cache.path(),
            &fixture.config,
            &fixture.secrets,
            &fixture.policy,
            &fixture.preflight,
            &fixture.input,
            Some(&observer),
        )
        .await;

        assert!(matches!(result, Err(TriageHostError::Cancelled)));
        assert_eq!(fixture.secrets.reads.load(Ordering::SeqCst), 0);
        assert_prior_scope_restored(&fixture.host);
    }

    #[tokio::test]
    async fn pre_packet_scope_failure_never_invokes_observer_or_credentials() {
        let mut fixture = packet_proof_fixture();
        fixture.input.source_ids.push("unsupported-source".into());
        let calls = Arc::new(AtomicUsize::new(0));
        let observed_calls = Arc::clone(&calls);
        let observer = move |_proof: &TriageExecutedPacketProofV1| {
            observed_calls.fetch_add(1, Ordering::SeqCst);
            Ok(())
        };

        let result = resolve_v2_host_with_packet_proof_observer(
            &mut fixture.host,
            fixture.cache.path(),
            &fixture.config,
            &fixture.secrets,
            &fixture.policy,
            &fixture.preflight,
            &fixture.input,
            Some(&observer),
        )
        .await;

        assert!(matches!(result, Err(TriageHostError::Scope(_))));
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert_eq!(fixture.secrets.reads.load(Ordering::SeqCst), 0);
        assert_prior_scope_restored(&fixture.host);
    }

    #[test]
    fn requested_scope_accepts_current_revision_without_sources() {
        assert!(validate_requested_scope(Some(7), &[], 7).is_ok());
        assert!(validate_requested_scope(None, &[], 7).is_ok());
    }

    #[test]
    fn requested_scope_rejects_revision_drift_and_unimplemented_sources() {
        assert_eq!(
            validate_requested_scope(Some(6), &[], 7),
            Err("corpus_revision_changed_before_v2_packet_build")
        );
        assert_eq!(
            validate_requested_scope(None, &["source-a".into()], 7),
            Err("source_scope_not_supported_by_v2_packet_builder")
        );
    }

    #[test]
    fn stock_phase_caps_preserve_smaller_operation_limits() {
        let mut policy = TriagePolicyV2::standard(
            ModelRef {
                profile_id: "profile:test".into(),
                model_id: "model:test".into(),
            },
            false,
        );
        policy.mode = TriagePolicyMode::Enhanced;
        let remaining_ms = 300_000;
        align_stock_phase_caps(&mut policy, remaining_ms);
        let stock = TriageBudgetV2::default();
        assert_eq!(
            policy.budget.contributors.operation_timeout_ms,
            stock.contributors.operation_timeout_ms
        );
        assert_eq!(
            policy.budget.corrections.operation_timeout_ms,
            stock.corrections.operation_timeout_ms
        );
        assert_eq!(
            policy.budget.finalizer.operation_timeout_ms,
            stock.finalizer.operation_timeout_ms
        );
        assert_eq!(
            policy.budget.reviewer.operation_timeout_ms,
            stock.reviewer.operation_timeout_ms
        );
        assert!(stock.contributors.operation_timeout_ms < remaining_ms);
    }

    #[test]
    fn stock_phase_caps_and_active_reserves_fit_shorter_remaining_turn() {
        let model = ModelRef {
            profile_id: "profile:test".into(),
            model_id: "model:test".into(),
        };
        let mut policy = TriagePolicyV2::standard(model.clone(), false);
        policy.mode = TriagePolicyMode::Enhanced;
        policy.reviewer = Some(ReviewerSlotV2 {
            slot_id: "reviewer".into(),
            model,
            condition: ReviewerConditionV2::ContestedOrIncomplete,
            requirement: RoleRequirement::Optional,
            allow_remote: false,
        });
        let remaining_ms = 60_000;
        align_stock_phase_caps(&mut policy, remaining_ms);
        assert_eq!(
            policy.budget.contributors.operation_timeout_ms,
            remaining_ms
        );
        assert_eq!(policy.budget.corrections.operation_timeout_ms, remaining_ms);
        assert_eq!(policy.budget.finalizer.operation_timeout_ms, remaining_ms);
        assert_eq!(policy.budget.reviewer.operation_timeout_ms, remaining_ms);
        assert_eq!(policy.budget.finalizer.reserve_ms, 30_000);
        assert_eq!(policy.budget.reviewer.reserve_ms, 30_000);
    }

    #[test]
    fn explicit_smaller_phase_caps_are_not_silently_enlarged() {
        let mut policy = TriagePolicyV2::standard(
            ModelRef {
                profile_id: "profile:test".into(),
                model_id: "model:test".into(),
            },
            false,
        );
        policy.mode = TriagePolicyMode::Enhanced;
        let remaining_ms = 300_000;
        let explicit = remaining_ms - 1;
        policy.budget.mark_phase_caps_explicit();
        policy.budget.contributors.operation_timeout_ms = explicit;
        policy.budget.corrections.operation_timeout_ms = explicit;
        policy.budget.finalizer.operation_timeout_ms = explicit;
        policy.budget.reviewer.operation_timeout_ms = explicit;
        align_stock_phase_caps(&mut policy, remaining_ms);
        assert_eq!(policy.budget.contributors.operation_timeout_ms, explicit);
        assert_eq!(policy.budget.corrections.operation_timeout_ms, explicit);
        assert_eq!(policy.budget.finalizer.operation_timeout_ms, explicit);
        assert_eq!(policy.budget.reviewer.operation_timeout_ms, explicit);
    }

    #[test]
    fn explicit_larger_phase_caps_are_preserved_without_downward_mutation() {
        let mut policy = TriagePolicyV2::standard(
            ModelRef {
                profile_id: "profile:test".into(),
                model_id: "model:test".into(),
            },
            false,
        );
        policy.mode = TriagePolicyMode::Enhanced;
        let remaining_ms = 300_000;
        let explicit = remaining_ms + 1;
        policy.budget.mark_phase_caps_explicit();
        policy.budget.contributors.operation_timeout_ms = explicit;
        policy.budget.corrections.operation_timeout_ms = explicit;
        policy.budget.finalizer.operation_timeout_ms = explicit;
        policy.budget.reviewer.operation_timeout_ms = explicit;
        align_stock_phase_caps(&mut policy, remaining_ms);
        assert_eq!(policy.budget.contributors.operation_timeout_ms, explicit);
        assert_eq!(policy.budget.corrections.operation_timeout_ms, explicit);
        assert_eq!(policy.budget.finalizer.operation_timeout_ms, explicit);
        assert_eq!(policy.budget.reviewer.operation_timeout_ms, explicit);
    }

    #[test]
    fn explicit_stock_valued_phase_caps_are_not_treated_as_defaults() {
        let mut policy = TriagePolicyV2::standard(
            ModelRef {
                profile_id: "profile:test".into(),
                model_id: "model:test".into(),
            },
            false,
        );
        policy.mode = TriagePolicyMode::Enhanced;
        policy.budget.mark_phase_caps_explicit();
        let remaining_ms = 300_000;
        let stock_ms = TriageBudgetV2::default().contributors.operation_timeout_ms;
        assert_eq!(stock_ms, 120_000);
        policy.budget.contributors.operation_timeout_ms = stock_ms;
        policy.budget.corrections.operation_timeout_ms = stock_ms;
        policy.budget.finalizer.operation_timeout_ms = stock_ms;
        policy.budget.reviewer.operation_timeout_ms = stock_ms;
        align_stock_phase_caps(&mut policy, remaining_ms);
        assert_eq!(policy.budget.contributors.operation_timeout_ms, stock_ms);
        assert_eq!(policy.budget.corrections.operation_timeout_ms, stock_ms);
        assert_eq!(policy.budget.finalizer.operation_timeout_ms, stock_ms);
        assert_eq!(policy.budget.reviewer.operation_timeout_ms, stock_ms);
    }

    #[test]
    fn preflight_egress_must_match_profile_local_only_policy() {
        let mut cfg = AppConfig::default();
        let mut profile = ProviderProfile::ollama_local();
        profile.id = "profile:test".into();
        cfg.providers.profiles.push(profile);
        let fact = RolePreflightV2 {
            slot_id: "finalizer".into(),
            model: ModelRef {
                profile_id: "profile:test".into(),
                model_id: "model:test".into(),
            },
            kind: TriageSlotKindV2::Finalizer,
            available: true,
            qualification: RoleQualificationV2::Unverified,
            remote: true,
            qualification_schema_id: None,
            workflow_id: None,
            protocol_fingerprint: None,
        };
        let error = validate_preflight_profile_bindings(
            &cfg,
            &TriagePolicyPreflightV2 { roles: vec![fact] },
        )
        .expect_err("forged remote fact");
        assert!(matches!(error, TriageHostError::Profile(_)));
    }

    #[test]
    fn admitted_remote_slot_rechecks_policy_egress_independent_of_preflight() {
        let mut cfg = AppConfig::default();
        let mut profile = ProviderProfile::ollama_local();
        profile.id = "profile:remote".into();
        profile.chat_model = "model:test".into();
        profile.local_only = false;
        cfg.providers.profiles.push(profile.clone());
        let model = ModelRef {
            profile_id: profile.id,
            model_id: profile.chat_model,
        };
        let denied = TriagePolicyV2::standard(model.clone(), false);
        // Model the exact hostile mutation this second check exists to stop:
        // preflight claims the configured remote profile is local and the
        // compiler therefore admits it. Runtime must derive locality from
        // AppConfig again rather than trusting that compiled disposition.
        let forged = TriagePolicyPreflightV2 {
            roles: vec![RolePreflightV2 {
                slot_id: "standard-finalizer".into(),
                model: model.clone(),
                kind: TriageSlotKindV2::Finalizer,
                available: true,
                qualification: RoleQualificationV2::Qualified,
                remote: false,
                qualification_schema_id: None,
                workflow_id: None,
                protocol_fingerprint: None,
            }],
        };
        let compiled = compile_preflight(&denied, &forged).expect("forged preflight admits slot");
        let error = validate_runtime_egress(&cfg, &denied, &compiled)
            .expect_err("remote profile requires explicit policy permission");
        assert!(matches!(error, TriageHostError::Profile(ref reason) if reason == "egress_denied"));

        let allowed = TriagePolicyV2::standard(model, true);
        let preflight =
            preflight_for_policy(&cfg, &allowed, &TriageRoleQualificationStoreV1::default());
        let compiled = compile_preflight(&allowed, &preflight).expect("standard compiles");
        validate_runtime_egress(&cfg, &allowed, &compiled)
            .expect("explicit remote permission is honored");
    }

    #[test]
    fn shared_preflight_reads_only_exact_role_store_identity() {
        let mut cfg = AppConfig::default();
        let mut profile = ProviderProfile::ollama_local();
        profile.id = "profile:test".into();
        profile.chat_model = "model:test".into();
        cfg.providers.profiles.push(profile.clone());
        let mut policy = TriagePolicyV2::standard(
            ModelRef {
                profile_id: profile.id.clone(),
                model_id: profile.chat_model.clone(),
            },
            false,
        );
        policy.mode = cd_core::multi_model::triage_policy::TriagePolicyMode::Enhanced;
        let kind = TriageSlotKindV2::Finalizer;
        let transport = cd_core::capability_qualification::QualificationKey::with_provider_kind(
            &profile.id,
            &profile.base_url,
            &profile.chat_model,
            profile.kind,
        )
        .transport_protocol;
        let key = TriageRoleQualificationKeyV1::current(
            &profile.id,
            &profile.base_url,
            &profile.chat_model,
            kind,
            triage_protocol_fingerprint(&transport),
        );
        let mut store = TriageRoleQualificationStoreV1::default();
        store
            .put(TriageRoleQualificationRecordV1 {
                key,
                qualification: RoleQualificationV2::Qualified,
                physical_provider_calls: 1,
                semantic_corrections: 0,
                reason: "synthetic role probe passed".into(),
                tested_at: 1,
            })
            .unwrap();
        let preflight = preflight_for_policy(&cfg, &policy, &store);
        assert_eq!(preflight.roles.len(), 1);
        assert_eq!(
            preflight.roles[0].qualification,
            RoleQualificationV2::Qualified
        );
        assert_eq!(
            preflight.roles[0].qualification_schema_id.as_deref(),
            Some(cd_core::multi_model::triage_policy::TRIAGE_QUALIFICATION_SCHEMA_V2)
        );

        let mut sibling_policy = policy;
        sibling_policy.finalizer.as_mut().unwrap().model.model_id = "other".into();
        let sibling = preflight_for_policy(&cfg, &sibling_policy, &store);
        assert_eq!(
            sibling.roles[0].qualification,
            RoleQualificationV2::Unverified
        );
    }

    fn packet() -> FastTriagePacketV1 {
        let revision = LogSnapshotRevisionV1 {
            event_revision: 1,
            template_analysis_revision: 1,
            suppression_revision: 1,
        };
        let entry = HostEvidenceEntry {
            evidence_id: "e:c1:1".into(),
            candidate_id: "c1".into(),
            source_label: "synthetic".into(),
            locator: "seq=1".into(),
            corpus_id: "corpus:test".into(),
            revision,
            role: EvidenceRole::Neutral,
            content: "synthetic evidence".into(),
        };
        let binding = AnswerBindingV1 {
            session_id: "session:test".into(),
            turn_id: "turn:test".into(),
            corpus_id: "corpus:test".into(),
            revision,
            ledger_digest: HostEvidenceLedger::digest(std::slice::from_ref(&entry)),
        };
        FastTriagePacketV1::from_ledger(
            HostEvidenceLedger::new(binding, vec![entry]).expect("ledger"),
            None,
            true,
        )
    }

    fn finalizer() -> CompiledRoleSlotV2 {
        CompiledRoleSlotV2 {
            slot_id: "finalizer".into(),
            kind: TriageSlotKindV2::Finalizer,
            model: ModelRef {
                profile_id: "profile:test".into(),
                model_id: "model:test".into(),
            },
            requirement: RoleRequirement::Required,
            disposition: SlotDispositionV2::Admitted,
            rejections: Vec::new(),
            qualification_schema_id: None,
            workflow_id: None,
            protocol_fingerprint: None,
        }
    }

    fn reconciliation() -> TriageReconciliationV1 {
        TriageReconciliationV1 {
            state: "supported".into(),
            configured_role_slots: 1,
            completed_role_slots: 1,
            distinct_models: 1,
            distinct_gateways: 1,
            supported_claim_ids: Vec::new(),
            conflict_ids: Vec::new(),
            gap_ids: Vec::new(),
            root_cause_established: false,
        }
    }

    #[tokio::test]
    async fn finalizer_hook_derives_envelope_only_from_packet_ledger() {
        let hooks = HostValidatedAnswerHooks::default();
        let response = ChatCompletion::from_parts(
            format!(
                "<think>private</think>\n```json\n{}\n```",
                serde_json::json!({
                        "schema": cd_core::investigation_answer::SCHEMA_V1,
                        "candidates": [{
                            "candidate_id": "c1",
                            "observations": [{
                                "claim_id": "claim-1",
                                "text": "observed",
                                "evidence_ids": ["e:c1:1"]
                            }]
                        }]
                })
            ),
            Vec::new(),
            "stop",
        );
        let slot = finalizer();
        let packet = packet();
        let decision = hooks
            .validate(&slot, &response, &packet, &reconciliation())
            .await;
        assert!(decision.accepted);
        let envelope = hooks
            .finalize(&slot, &response, &packet, &reconciliation())
            .await
            .expect("validated envelope");
        assert_eq!(envelope.evidence[0].evidence_id, "e:c1:1");
        assert!(!envelope.answer.root_cause_established);
    }

    #[tokio::test]
    async fn finalizer_hook_rejects_foreign_evidence_without_echoing_it() {
        let hooks = HostValidatedAnswerHooks::default();
        let response = ChatCompletion::from_parts(
            serde_json::json!({
                "schema": cd_core::investigation_answer::SCHEMA_V1,
                "candidates": [{
                    "candidate_id": "c1",
                    "observations": [{
                        "claim_id": "claim-1",
                        "text": "observed",
                        "evidence_ids": ["foreign"]
                    }]
                }]
            })
            .to_string(),
            Vec::new(),
            "stop",
        );
        let decision = hooks
            .validate(&finalizer(), &response, &packet(), &reconciliation())
            .await;
        assert!(!decision.accepted);
        assert_eq!(decision.reason_codes, vec!["unknown_evidence"]);
    }

    #[tokio::test]
    async fn generic_non_finalizer_hook_fails_closed() {
        let hooks = HostValidatedAnswerHooks::default();
        let response = ChatCompletion::from_parts("ordinary reviewer prose", Vec::new(), "stop");
        let slot = CompiledRoleSlotV2 {
            slot_id: "reviewer".into(),
            kind: TriageSlotKindV2::Reviewer,
            model: ModelRef {
                profile_id: "profile:test".into(),
                model_id: "model:test".into(),
            },
            requirement: RoleRequirement::Optional,
            disposition: SlotDispositionV2::Admitted,
            rejections: Vec::new(),
            qualification_schema_id: None,
            workflow_id: None,
            protocol_fingerprint: None,
        };
        let decision = hooks
            .validate(&slot, &response, &packet(), &reconciliation())
            .await;
        assert!(!decision.accepted);
        assert_eq!(decision.reason_codes, vec!["typed_role_proposal_required"]);
    }
}
