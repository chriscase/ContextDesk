//! Production [`cd_triage_runtime::TriageEngine`] over the trusted workflow host.
//!
//! The public runtime crate stays free of application configuration, secrets,
//! filesystems, providers, and corpora. This module is the host-owned adapter:
//! callers load bounded policy/qualification stores, provide the existing
//! [`ToolHost`], and receive the same validated replay produced by
//! [`crate::triage_host::run_v2_host`].

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use cd_core::config::AppConfig;
use cd_core::extension_contract::PacketPrivacyBoundary;
use cd_core::keychain_store::SecretStore;
use cd_core::multi_model::triage_policy::{
    CompiledRoleSlotV2, PolicyRejectionCategoryV2, SlotDispositionV2, TriagePolicyMode,
    TriagePolicyPreflightV2, TriagePolicyV2,
};
use cd_core::tool_host::ToolHost;
use cd_core::triage_policy_store::TriagePolicyStoreV1;
use cd_core::triage_role_qualification::TriageRoleQualificationStoreV1;
use cd_core::triage_sdk::{
    TriageAttemptStatus, TriageCancellationV1, TriagePolicySelectionV2, TriageReplayV1,
    TriageRoleAttemptV1, TriageRunEventPayloadV2, TriageRunEventV2, TriageTerminalDispositionV1,
    TRIAGE_REPLAY_SCHEMA_V1, TRIAGE_RUN_EVENT_SCHEMA_V2,
};
use cd_triage_runtime::{
    TriageEngine, TriageEngineFailure, TriageEngineFailureCategory, TriageEventSink,
    ValidatedTriageRequest,
};
use sha2::{Digest, Sha256};

use crate::triage::compile_preflight;
use crate::triage_host::{
    preflight_for_policy, resolve_v2_host_with_packet_proof_observer, run_v2_host,
    HostValidatedAnswerHooks, TriageHostError, TriageHostRunInput, TriagePacketProofObserverV1,
};
use crate::triage_production_runner::TriageEventSink as ProductionEventSink;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct CancellationKey {
    run_id: String,
    cancellation_id: String,
}

impl From<&TriageCancellationV1> for CancellationKey {
    fn from(value: &TriageCancellationV1) -> Self {
        Self {
            run_id: value.run_id.clone(),
            cancellation_id: value.cancellation_id.clone(),
        }
    }
}

/// Shared, content-free cancellation registry for live workflow triage runs.
///
/// A desktop cancel command can retain a clone of this registry while the
/// run-scoped engine owns another clone. Entries are keyed by the exact public
/// run and cancellation identities; unrelated runs can execute concurrently.
#[derive(Debug, Clone, Default)]
pub struct TriageCancellationRegistryV1 {
    inner: Arc<Mutex<BTreeMap<CancellationKey, Arc<AtomicBool>>>>,
}

impl TriageCancellationRegistryV1 {
    /// Signal one exact registered run. `Ok(false)` means no matching run is
    /// active; malformed cancellation DTOs are rejected before lookup.
    pub fn cancel(&self, cancellation: &TriageCancellationV1) -> Result<bool, TriageEngineFailure> {
        cancellation.validate().map_err(|_| {
            TriageEngineFailure::new(TriageEngineFailureCategory::CancellationFailed)
        })?;
        let flag = self
            .inner
            .lock()
            .map_err(|_| TriageEngineFailure::new(TriageEngineFailureCategory::HostUnavailable))?
            .get(&CancellationKey::from(cancellation))
            .cloned();
        if let Some(flag) = flag {
            flag.store(true, Ordering::SeqCst);
            Ok(true)
        } else {
            Ok(false)
        }
    }

    fn register(
        &self,
        cancellation: &TriageCancellationV1,
    ) -> Result<Arc<AtomicBool>, TriageEngineFailure> {
        let owner = Arc::new(AtomicBool::new(false));
        self.register_owner(cancellation, owner)
    }

    fn register_owner(
        &self,
        cancellation: &TriageCancellationV1,
        owner: Arc<AtomicBool>,
    ) -> Result<Arc<AtomicBool>, TriageEngineFailure> {
        let key = CancellationKey::from(cancellation);
        let mut entries = self
            .inner
            .lock()
            .map_err(|_| TriageEngineFailure::new(TriageEngineFailureCategory::HostUnavailable))?;
        if entries.contains_key(&key) {
            return Err(TriageEngineFailure::new(
                TriageEngineFailureCategory::PreflightRejected,
            ));
        }
        entries.insert(key, Arc::clone(&owner));
        Ok(owner)
    }

    fn remove_if_owned(&self, cancellation: &TriageCancellationV1, owner: &Arc<AtomicBool>) {
        let Ok(mut entries) = self.inner.lock() else {
            return;
        };
        let key = CancellationKey::from(cancellation);
        if entries
            .get(&key)
            .is_some_and(|registered| Arc::ptr_eq(registered, owner))
        {
            entries.remove(&key);
        }
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.inner.lock().map_or(0, |entries| entries.len())
    }
}

/// Provider-free result of workflow preflight for one configured-policy run.
///
/// The exact policy and qualification facts are retained for execution, but
/// provider construction, credential reads, packet materialization, and
/// network calls have not happened yet.
pub struct WorkflowTriagePreflightV1 {
    policy: Option<TriagePolicyV2>,
    preflight: Option<TriagePolicyPreflightV2>,
    slots: Vec<CompiledRoleSlotV2>,
    failure_category: Option<&'static str>,
    input: Option<TriageHostRunInput>,
    policy_fingerprint: String,
    deadline_ms: u64,
    cancellation: TriageCancellationV1,
    cancel_owner: Arc<AtomicBool>,
    started_at: tokio::time::Instant,
}

impl std::fmt::Debug for WorkflowTriagePreflightV1 {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("WorkflowTriagePreflightV1")
            .field(
                "policy_mode",
                &self.policy.as_ref().map(|policy| policy.mode),
            )
            .field("run_id", &self.cancellation.run_id)
            .field("policy_resolved", &self.policy.is_some())
            .finish_non_exhaustive()
    }
}

/// Real Standard/Saved/Inline public-runtime engine backed by the workflow host.
///
/// The engine borrows a run-exclusive [`ToolHost`] and secret store. Policy and
/// role-qualification stores are already-loaded, bounded host snapshots; this
/// type performs no policy-store filesystem I/O of its own.
pub struct WorkflowTriageEngineV1<'a> {
    host: tokio::sync::Mutex<&'a mut ToolHost>,
    cache_root: PathBuf,
    config: AppConfig,
    secrets: Arc<dyn SecretStore>,
    policies: TriagePolicyStoreV1,
    qualifications: TriageRoleQualificationStoreV1,
    cancellations: TriageCancellationRegistryV1,
    packet_proof_observer: Option<TriagePacketProofObserverV1>,
    external_cancel_owner: Option<Arc<AtomicBool>>,
}

impl<'a> WorkflowTriageEngineV1<'a> {
    /// Bind an existing run-exclusive host and already-loaded host policy state.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        host: &'a mut ToolHost,
        cache_root: &Path,
        config: AppConfig,
        secrets: Arc<dyn SecretStore>,
        policies: TriagePolicyStoreV1,
        qualifications: TriageRoleQualificationStoreV1,
        cancellations: TriageCancellationRegistryV1,
    ) -> Self {
        Self {
            host: tokio::sync::Mutex::new(host),
            cache_root: cache_root.to_path_buf(),
            config,
            secrets,
            policies,
            qualifications,
            cancellations,
            packet_proof_observer: None,
            external_cancel_owner: None,
        }
    }

    /// Attach an owner-only observer for the exact packet executed by this
    /// engine. Existing callers remain no-op by default.
    pub fn with_packet_proof_observer(mut self, observer: TriagePacketProofObserverV1) -> Self {
        self.packet_proof_observer = Some(observer);
        self
    }

    /// Use a caller-owned cancellation flag directly for this run.
    ///
    /// The same atomic is registered for the public cancellation identity and
    /// passed into host execution, eliminating polling bridges and preserving
    /// cancellation that was requested before public preflight began.
    pub fn with_cancel_owner(mut self, owner: Arc<AtomicBool>) -> Self {
        self.external_cancel_owner = Some(owner);
        self
    }

    /// Return the shared cancellation registry used by this engine.
    pub fn cancellations(&self) -> &TriageCancellationRegistryV1 {
        &self.cancellations
    }

    fn policy_for_request(
        &self,
        request: &ValidatedTriageRequest,
    ) -> Option<(TriagePolicyV2, bool)> {
        let standard_selection = matches!(
            &request.request().policy,
            TriagePolicySelectionV2::Standard { .. }
        );
        let mut rejected = false;
        let mut policy = match &request.request().policy {
            TriagePolicySelectionV2::Standard { model } => {
                let profile = self
                    .config
                    .providers
                    .profiles
                    .iter()
                    .find(|profile| profile.id == model.profile_id);
                if profile.is_none() {
                    rejected = true;
                }
                TriagePolicyV2::standard(
                    model.clone(),
                    profile.is_some_and(|profile| !profile.local_only),
                )
            }
            TriagePolicySelectionV2::Inline { document, .. } => {
                serde_json::from_value(document.clone()).ok()?
            }
            TriagePolicySelectionV2::Saved {
                policy_id,
                policy_revision,
            } => self
                .policies
                .policies
                .iter()
                .find(|saved| saved.policy_id == *policy_id && saved.revision == *policy_revision)
                .map(|saved| saved.policy.clone())?,
        };
        // A Standard document cannot enter through the configured-policy
        // facade. Only the explicit Standard request shape may select the
        // permanent one-finalizer default.
        if matches!(policy.mode, TriagePolicyMode::Standard) && !standard_selection {
            rejected = true;
        }
        if let Some(deadline_ms) = request.request().overrides.deadline_ms {
            policy.budget.whole_turn_deadline_ms = Some(deadline_ms);
        }
        if let Some(max_provider_calls) = request.request().overrides.max_provider_calls {
            policy.budget.max_provider_calls = max_provider_calls;
        }
        Some((policy, rejected))
    }

    fn host_input(
        &self,
        request: &ValidatedTriageRequest,
        policy: &TriagePolicyV2,
        cancel: Arc<AtomicBool>,
    ) -> Result<TriageHostRunInput, TriageEngineFailure> {
        let deadline_ms = policy.budget.whole_turn_deadline_ms.unwrap_or(
            if self.config.router.deadline_is_explicit {
                self.config.router.deadline_ms
            } else {
                300_000
            },
        );
        let context_char_budget =
            usize::try_from(policy.budget.max_context_chars).map_err(|_| preflight_rejected())?;
        let policy_bytes = serde_json::to_vec(policy).map_err(|_| preflight_rejected())?;
        let policy_fingerprint = format!("sha256:{:x}", Sha256::digest(policy_bytes));
        Ok(TriageHostRunInput {
            run_id: request.request().run_id.clone(),
            request_fingerprint: request.fingerprint().to_string(),
            policy_fingerprint,
            corpus_id: request.request().scope.corpus_id.clone(),
            corpus_revision: request.request().scope.corpus_revision,
            source_ids: request.request().scope.source_ids.clone(),
            user_text: request.request().task.clone(),
            cancellation_id: request.request().cancellation_id.clone(),
            explicit_review_requested: false,
            deadline_ms,
            context_char_budget,
            cancel: Some(cancel),
        })
    }

    fn unresolved_policy_fingerprint(
        &self,
        request: &ValidatedTriageRequest,
    ) -> Result<String, TriageEngineFailure> {
        let bytes =
            serde_json::to_vec(&request.request().policy).map_err(|_| preflight_rejected())?;
        Ok(format!("sha256:{:x}", Sha256::digest(bytes)))
    }

    fn unresolved_policy_deadline_ms(&self, request: &ValidatedTriageRequest) -> u64 {
        request.request().overrides.deadline_ms.unwrap_or(
            if self.config.router.deadline_is_explicit {
                self.config.router.deadline_ms
            } else {
                300_000
            },
        )
    }

    fn finish_pre_provider(
        &self,
        request: &ValidatedTriageRequest,
        prepared: &WorkflowTriagePreflightV1,
        terminal: PreProviderTerminalV1,
        events: Option<TriageEventSink>,
    ) -> Result<TriageReplayV1, TriageEngineFailure> {
        let replay = pre_provider_replay(request, prepared, terminal);
        self.cancellations
            .remove_if_owned(&prepared.cancellation, &prepared.cancel_owner);
        emit_authoritative_replay(replay?, events)
    }
}

#[async_trait]
impl TriageEngine for WorkflowTriageEngineV1<'_> {
    type Preflight = WorkflowTriagePreflightV1;

    async fn preflight(
        &self,
        request: &ValidatedTriageRequest,
    ) -> Result<Self::Preflight, TriageEngineFailure> {
        let started_at = tokio::time::Instant::now();
        let cancellation = TriageCancellationV1 {
            schema_id: cd_core::triage_sdk::TRIAGE_CANCELLATION_SCHEMA_V1.into(),
            run_id: request.request().run_id.clone(),
            cancellation_id: request.request().cancellation_id.clone(),
        };
        let cancel_owner = match &self.external_cancel_owner {
            Some(owner) => self
                .cancellations
                .register_owner(&cancellation, Arc::clone(owner))?,
            None => self.cancellations.register(&cancellation)?,
        };
        if cancel_owner.load(Ordering::SeqCst) {
            let policy_fingerprint = match self.unresolved_policy_fingerprint(request) {
                Ok(fingerprint) => fingerprint,
                Err(error) => {
                    self.cancellations
                        .remove_if_owned(&cancellation, &cancel_owner);
                    return Err(error);
                }
            };
            return Ok(WorkflowTriagePreflightV1 {
                policy: None,
                preflight: None,
                slots: Vec::new(),
                failure_category: None,
                input: None,
                policy_fingerprint,
                deadline_ms: self.unresolved_policy_deadline_ms(request),
                cancellation,
                cancel_owner,
                started_at,
            });
        }
        let prepared = (|| {
            let policies_valid = self.policies.validate().is_ok();
            let qualifications_valid = self.qualifications.validate().is_ok();
            let saved_policy_untrusted = !policies_valid
                && matches!(
                    &request.request().policy,
                    TriagePolicySelectionV2::Saved { .. }
                );
            let policy_resolution = (!saved_policy_untrusted)
                .then(|| self.policy_for_request(request))
                .flatten();
            let Some((policy, request_rejected)) = policy_resolution else {
                let policy_fingerprint = self.unresolved_policy_fingerprint(request)?;
                let deadline_ms = self.unresolved_policy_deadline_ms(request);
                return Ok::<_, TriageEngineFailure>((
                    None,
                    None,
                    Vec::new(),
                    Some("policy_preflight_rejected"),
                    None,
                    policy_fingerprint,
                    deadline_ms,
                ));
            };
            let empty_qualifications = TriageRoleQualificationStoreV1::default();
            let qualification_store = if qualifications_valid {
                &self.qualifications
            } else {
                &empty_qualifications
            };
            let preflight = preflight_for_policy(&self.config, &policy, qualification_store);
            let compiled = compile_preflight(&policy, &preflight);
            let (slots, compilation_failed) = match compiled {
                Ok(compiled) => (compiled.slots, false),
                Err(failure) => (failure.slots, true),
            };
            let failure_category = if request_rejected
                || compilation_failed
                || !policies_valid
                || !qualifications_valid
            {
                Some("policy_preflight_rejected")
            } else {
                None
            };
            let input = self.host_input(request, &policy, Arc::clone(&cancel_owner))?;
            let policy_fingerprint = input.policy_fingerprint.clone();
            let deadline_ms = input.deadline_ms;
            Ok::<_, TriageEngineFailure>((
                Some(policy),
                Some(preflight),
                slots,
                failure_category,
                Some(input),
                policy_fingerprint,
                deadline_ms,
            ))
        })();
        let (policy, preflight, slots, failure_category, input, policy_fingerprint, deadline_ms) =
            match prepared {
                Ok(prepared) => prepared,
                Err(error) => {
                    self.cancellations
                        .remove_if_owned(&cancellation, &cancel_owner);
                    return Err(error);
                }
            };
        Ok(WorkflowTriagePreflightV1 {
            policy,
            preflight,
            slots,
            failure_category,
            input,
            policy_fingerprint,
            deadline_ms,
            cancellation,
            cancel_owner,
            started_at,
        })
    }

    async fn execute(
        &self,
        request: ValidatedTriageRequest,
        mut prepared: Self::Preflight,
        mut events: Option<TriageEventSink>,
    ) -> Result<TriageReplayV1, TriageEngineFailure> {
        if prepared.cancellation.run_id != request.request().run_id
            || prepared.cancellation.cancellation_id != request.request().cancellation_id
            || prepared.input.as_ref().is_some_and(|input| {
                input.run_id != request.request().run_id
                    || input.request_fingerprint != request.fingerprint()
                    || input.cancellation_id != request.request().cancellation_id
            })
        {
            self.cancellations
                .remove_if_owned(&prepared.cancellation, &prepared.cancel_owner);
            return Err(preflight_rejected());
        }

        if prepared.cancel_owner.load(Ordering::SeqCst) {
            return self.finish_pre_provider(
                &request,
                &prepared,
                PreProviderTerminalV1::Cancelled,
                events,
            );
        }
        if let Some(category) = prepared.failure_category {
            return self.finish_pre_provider(
                &request,
                &prepared,
                PreProviderTerminalV1::Failed { category },
                events,
            );
        }
        if prepared.started_at.elapsed() >= Duration::from_millis(prepared.deadline_ms) {
            return self.finish_pre_provider(
                &request,
                &prepared,
                PreProviderTerminalV1::TimedOut,
                events,
            );
        }

        if prepared.policy.is_none() || prepared.preflight.is_none() || prepared.input.is_none() {
            self.cancellations
                .remove_if_owned(&prepared.cancellation, &prepared.cancel_owner);
            return Err(preflight_rejected());
        }

        let event_failed = Arc::new(AtomicBool::new(false));
        let production_sink = events.take().map(|sink| {
            let sink = Arc::new(Mutex::new(sink));
            let event_failed = Arc::clone(&event_failed);
            let cancel = Arc::clone(&prepared.cancel_owner);
            Arc::new(move |event: &cd_core::triage_sdk::TriageRunEventV2| {
                let accepted = sink
                    .lock()
                    .ok()
                    .is_some_and(|mut sink| sink.emit(event).is_ok());
                if !accepted {
                    event_failed.store(true, Ordering::SeqCst);
                    cancel.store(true, Ordering::SeqCst);
                }
            }) as ProductionEventSink
        });

        let result = {
            let policy = prepared
                .policy
                .as_ref()
                .expect("resolved policy checked above");
            let preflight = prepared
                .preflight
                .as_ref()
                .expect("resolved preflight checked above");
            let input = prepared.input.take().expect("resolved input checked above");
            let mut host = self.host.lock().await;
            let resolved = resolve_v2_host_with_packet_proof_observer(
                &mut host,
                &self.cache_root,
                &self.config,
                Arc::clone(&self.secrets),
                policy,
                preflight,
                &input,
                self.packet_proof_observer.as_deref(),
            )
            .await;
            match resolved {
                Ok(resolved) => run_v2_host(
                    &mut host,
                    resolved,
                    input,
                    &HostValidatedAnswerHooks::default(),
                    production_sink,
                )
                .await
                .map(|result| result.replay)
                .map_err(map_execution_host_error),
                Err(error) => Err(map_preflight_host_error(error)),
            }
        };
        self.cancellations
            .remove_if_owned(&prepared.cancellation, &prepared.cancel_owner);
        if event_failed.load(Ordering::SeqCst) {
            return Err(TriageEngineFailure::new(
                TriageEngineFailureCategory::InvalidEvent,
            ));
        }
        result
    }

    fn cancel(&self, cancellation: &TriageCancellationV1) -> Result<(), TriageEngineFailure> {
        if self.cancellations.cancel(cancellation)? {
            Ok(())
        } else {
            Err(TriageEngineFailure::new(
                TriageEngineFailureCategory::CancellationFailed,
            ))
        }
    }
}

#[derive(Debug, Clone, Copy)]
enum PreProviderTerminalV1 {
    Failed { category: &'static str },
    TimedOut,
    Cancelled,
}

impl PreProviderTerminalV1 {
    fn reason(self) -> &'static str {
        match self {
            Self::Failed { category } => category,
            Self::TimedOut => "deadline",
            Self::Cancelled => "cancelled",
        }
    }

    fn admitted_status(self) -> TriageAttemptStatus {
        match self {
            Self::Failed { .. } => TriageAttemptStatus::NotAdmitted,
            Self::TimedOut => TriageAttemptStatus::TimedOut,
            Self::Cancelled => TriageAttemptStatus::Cancelled,
        }
    }

    fn failure_category(self) -> TriageEngineFailureCategory {
        match self {
            Self::Failed { .. } => TriageEngineFailureCategory::PreflightRejected,
            Self::TimedOut => TriageEngineFailureCategory::DeadlineExceeded,
            Self::Cancelled => TriageEngineFailureCategory::Cancelled,
        }
    }

    fn payload(self, cancellation_id: &str) -> TriageRunEventPayloadV2 {
        match self {
            Self::Failed { category } => TriageRunEventPayloadV2::Failed {
                category: category.into(),
                partial_result: None,
            },
            Self::TimedOut => TriageRunEventPayloadV2::TimedOut {
                category: "deadline".into(),
                partial_result: None,
            },
            Self::Cancelled => TriageRunEventPayloadV2::Cancelled {
                cancellation_id: cancellation_id.into(),
                partial_result: None,
            },
        }
    }
}

fn pre_provider_replay(
    request: &ValidatedTriageRequest,
    prepared: &WorkflowTriagePreflightV1,
    terminal: PreProviderTerminalV1,
) -> Result<TriageReplayV1, TriageEngineFailure> {
    let mut events = vec![pre_provider_event(
        request.request().run_id.as_str(),
        0,
        TriageRunEventPayloadV2::RunStarted {
            request_fingerprint: request.fingerprint().into(),
            policy_fingerprint: prepared.policy_fingerprint.clone(),
        },
    )];
    for slot in &prepared.slots {
        let status = if slot.disposition == SlotDispositionV2::Admitted {
            terminal.admitted_status()
        } else {
            TriageAttemptStatus::NotAdmitted
        };
        let mut reason_codes = slot
            .rejections
            .iter()
            .map(|category| pre_provider_rejection_code(*category).into())
            .collect::<Vec<_>>();
        if reason_codes.is_empty() {
            reason_codes.push(terminal.reason().into());
        }
        let attempt = TriageRoleAttemptV1 {
            attempt_id: format!("attempt:{}:{}", request.request().run_id, slot.slot_id),
            role_slot_id: slot.slot_id.clone(),
            role: slot.kind,
            model: slot.model.validate().is_ok().then(|| slot.model.clone()),
            status,
            reason_codes,
            elapsed_ms: 0,
            input_chars: 0,
            output_chars: 0,
            physical_provider_calls: Some(0),
            semantic_corrections: Some(0),
            terminal_disposition: Some(pre_provider_disposition(status)),
        };
        events.push(pre_provider_event(
            request.request().run_id.as_str(),
            events.len() as u64,
            TriageRunEventPayloadV2::RoleAttempt { attempt },
        ));
    }
    events.push(pre_provider_event(
        request.request().run_id.as_str(),
        events.len() as u64,
        terminal.payload(&prepared.cancellation.cancellation_id),
    ));
    let replay = TriageReplayV1 {
        schema_id: TRIAGE_REPLAY_SCHEMA_V1.into(),
        run_id: request.request().run_id.clone(),
        request_fingerprint: request.fingerprint().into(),
        events,
    };
    replay
        .validate()
        .map_err(|_| TriageEngineFailure::new(terminal.failure_category()))?;
    Ok(replay)
}

fn emit_authoritative_replay(
    replay: TriageReplayV1,
    mut events: Option<TriageEventSink>,
) -> Result<TriageReplayV1, TriageEngineFailure> {
    if let Some(sink) = &mut events {
        for event in &replay.events {
            sink.emit(event)?;
        }
    }
    Ok(replay)
}

fn pre_provider_event(
    run_id: &str,
    sequence: u64,
    event: TriageRunEventPayloadV2,
) -> TriageRunEventV2 {
    TriageRunEventV2 {
        schema_id: TRIAGE_RUN_EVENT_SCHEMA_V2.into(),
        run_id: run_id.into(),
        sequence,
        privacy: PacketPrivacyBoundary::OwnerOnly,
        event,
    }
}

fn pre_provider_disposition(status: TriageAttemptStatus) -> TriageTerminalDispositionV1 {
    match status {
        TriageAttemptStatus::Completed => TriageTerminalDispositionV1::Completed,
        TriageAttemptStatus::Abstained => TriageTerminalDispositionV1::Abstained,
        TriageAttemptStatus::Invalid => TriageTerminalDispositionV1::Invalid,
        TriageAttemptStatus::Unavailable => TriageTerminalDispositionV1::Unavailable,
        TriageAttemptStatus::TimedOut => TriageTerminalDispositionV1::TimedOut,
        TriageAttemptStatus::Cancelled => TriageTerminalDispositionV1::Cancelled,
        TriageAttemptStatus::Failed => TriageTerminalDispositionV1::Failed,
        TriageAttemptStatus::NotAdmitted => TriageTerminalDispositionV1::NotAdmitted,
    }
}

fn pre_provider_rejection_code(category: PolicyRejectionCategoryV2) -> &'static str {
    match category {
        PolicyRejectionCategoryV2::SchemaMismatch => "schema_mismatch",
        PolicyRejectionCategoryV2::InvalidSlotId => "invalid_slot_id",
        PolicyRejectionCategoryV2::DuplicateSlotId => "duplicate_slot_id",
        PolicyRejectionCategoryV2::InvalidModelRef => "invalid_model_ref",
        PolicyRejectionCategoryV2::StandardModeExpanded => "standard_mode_expanded",
        PolicyRejectionCategoryV2::StandardFinalizerRequired => "standard_finalizer_required",
        PolicyRejectionCategoryV2::EmptyPolicy => "empty_policy",
        PolicyRejectionCategoryV2::InvalidBudget => "invalid_budget",
        PolicyRejectionCategoryV2::PolicyLimitExceeded => "policy_limit_exceeded",
        PolicyRejectionCategoryV2::RoleUnavailable => "role_unavailable",
        PolicyRejectionCategoryV2::QualificationUnavailable => "qualification_unavailable",
        PolicyRejectionCategoryV2::EgressDenied => "egress_denied",
        PolicyRejectionCategoryV2::UnknownPreflightSlot => "unknown_preflight_slot",
        PolicyRejectionCategoryV2::DuplicatePreflightSlot => "duplicate_preflight_slot",
        PolicyRejectionCategoryV2::PreflightBindingMismatch => "preflight_binding_mismatch",
        PolicyRejectionCategoryV2::ProviderCallBudgetInsufficient => {
            "provider_call_budget_insufficient"
        }
    }
}

fn preflight_rejected() -> TriageEngineFailure {
    TriageEngineFailure::new(TriageEngineFailureCategory::PreflightRejected)
}

fn map_preflight_host_error(error: TriageHostError) -> TriageEngineFailure {
    let category = match error {
        TriageHostError::Cancelled => TriageEngineFailureCategory::Cancelled,
        TriageHostError::Deadline => TriageEngineFailureCategory::DeadlineExceeded,
        TriageHostError::Policy(_)
        | TriageHostError::Profile(_)
        | TriageHostError::Scope(_)
        | TriageHostError::Runner(_) => TriageEngineFailureCategory::PreflightRejected,
        TriageHostError::Corpus(_) | TriageHostError::Backend(_) => {
            TriageEngineFailureCategory::HostUnavailable
        }
        TriageHostError::PacketProofObserver => TriageEngineFailureCategory::ExecutionFailed,
        TriageHostError::Contract(_) => TriageEngineFailureCategory::ExecutionFailed,
    };
    TriageEngineFailure::new(category)
}

fn map_execution_host_error(error: TriageHostError) -> TriageEngineFailure {
    let category = match error {
        TriageHostError::Cancelled => TriageEngineFailureCategory::Cancelled,
        TriageHostError::Deadline => TriageEngineFailureCategory::DeadlineExceeded,
        TriageHostError::Contract(_) => TriageEngineFailureCategory::InvalidEvent,
        TriageHostError::PacketProofObserver => TriageEngineFailureCategory::ExecutionFailed,
        TriageHostError::Corpus(_)
        | TriageHostError::Scope(_)
        | TriageHostError::Policy(_)
        | TriageHostError::Profile(_)
        | TriageHostError::Backend(_)
        | TriageHostError::Runner(_) => TriageEngineFailureCategory::ExecutionFailed,
    };
    TriageEngineFailure::new(category)
}

#[cfg(test)]
mod tests {
    use super::*;
    use cd_core::error::CoreResult;
    use cd_core::extension_contract::PacketPrivacyBoundary;
    use cd_core::index::KeywordIndex;
    use cd_core::keychain_store::MemorySecretStore;
    use cd_core::model_ref::ModelRef;
    use cd_core::multi_model::triage_policy::{
        RoleQualificationV2, TriagePolicyMode, TriageSlotKindV2, TRIAGE_POLICY_SCHEMA_V2,
    };
    use cd_core::providers::ProviderProfile;
    use cd_core::triage_role_qualification::{
        triage_protocol_fingerprint, TriageRoleQualificationKeyV1, TriageRoleQualificationRecordV1,
    };
    use cd_core::triage_sdk::{
        TriageAttemptStatus, TriagePolicySelectionV2, TriageRequestOverridesV1, TriageRequestV2,
        TriageRunEventPayloadV2, TriageRunEventV2, TriageScopeV1, TRIAGE_REQUEST_SCHEMA_V2,
    };
    use cd_core::workspace::Workspace;
    use cd_triage_runtime::{
        replay_validated, triage, triage_with_policy, TriageEngine, TriageExecutionTerminal,
        TriageRuntimeError,
    };

    #[derive(Debug, Clone, Default)]
    struct CountingSecretStore {
        inner: MemorySecretStore,
        reads: Arc<std::sync::atomic::AtomicUsize>,
    }

    impl SecretStore for CountingSecretStore {
        fn set(&self, ref_id: &str, secret: &str) -> CoreResult<()> {
            self.inner.set(ref_id, secret)
        }

        fn get(&self, ref_id: &str) -> CoreResult<Option<String>> {
            self.reads.fetch_add(1, Ordering::SeqCst);
            self.inner.get(ref_id)
        }

        fn delete(&self, ref_id: &str) -> CoreResult<()> {
            self.inner.delete(ref_id)
        }
    }

    struct Fixture {
        _workspace: tempfile::TempDir,
        cache: tempfile::TempDir,
        host: ToolHost,
        config: AppConfig,
        secrets: CountingSecretStore,
        policies: TriagePolicyStoreV1,
        qualifications: TriageRoleQualificationStoreV1,
    }

    fn fixture() -> Fixture {
        let workspace_dir = tempfile::tempdir().expect("workspace");
        let cache = tempfile::tempdir().expect("cache");
        let workspace = Workspace::new("triage-runtime", vec![workspace_dir.path().into()]);
        let index = KeywordIndex::build(&workspace).expect("index");
        let host = ToolHost::new(workspace, index, None);
        let mut profile = ProviderProfile::ollama_local();
        profile.id = "profile:test".into();
        profile.chat_model = "model:test".into();
        let mut config = AppConfig::default();
        config.providers.profiles.push(profile.clone());
        let model = ModelRef {
            profile_id: profile.id.clone(),
            model_id: profile.chat_model.clone(),
        };
        let mut policy = TriagePolicyV2::standard(model, false);
        policy.mode = TriagePolicyMode::Enhanced;
        let mut policies = TriagePolicyStoreV1::default();
        policies.upsert("saved:test", policy).expect("saved policy");
        let mut qualifications = TriageRoleQualificationStoreV1::default();
        qualify(&mut qualifications, &profile, TriageSlotKindV2::Finalizer);
        Fixture {
            _workspace: workspace_dir,
            cache,
            host,
            config,
            secrets: CountingSecretStore::default(),
            policies,
            qualifications,
        }
    }

    fn qualify(
        store: &mut TriageRoleQualificationStoreV1,
        profile: &ProviderProfile,
        kind: TriageSlotKindV2,
    ) {
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
        store
            .put(TriageRoleQualificationRecordV1 {
                key,
                qualification: RoleQualificationV2::Qualified,
                physical_provider_calls: 1,
                semantic_corrections: 0,
                reason: "fixture-qualified".into(),
                tested_at: 1,
            })
            .expect("qualification");
    }

    fn request(policy: TriagePolicySelectionV2) -> TriageRequestV2 {
        TriageRequestV2 {
            schema_id: TRIAGE_REQUEST_SCHEMA_V2.into(),
            run_id: "run:test".into(),
            privacy: PacketPrivacyBoundary::OwnerOnly,
            task: "find the root cause".into(),
            scope: TriageScopeV1 {
                corpus_id: "corpus:test".into(),
                corpus_revision: None,
                source_ids: Vec::new(),
            },
            policy,
            overrides: TriageRequestOverridesV1::default(),
            cancellation_id: "cancel:test".into(),
        }
    }

    fn replay_attempts(replay: &TriageReplayV1) -> Vec<&TriageRoleAttemptV1> {
        replay
            .events
            .iter()
            .filter_map(|event| match &event.event {
                TriageRunEventPayloadV2::RoleAttempt { attempt } => Some(attempt),
                _ => None,
            })
            .collect()
    }

    fn assert_provider_free(replay: &TriageReplayV1) {
        assert!(replay.events.iter().all(|event| !matches!(
            &event.event,
            TriageRunEventPayloadV2::PacketReady { .. }
                | TriageRunEventPayloadV2::Reconciliation { .. }
                | TriageRunEventPayloadV2::PreliminaryReconciliation { .. }
                | TriageRunEventPayloadV2::FinalReconciliation { .. }
                | TriageRunEventPayloadV2::Validation { .. }
                | TriageRunEventPayloadV2::Correction { .. }
        )));
        assert!(replay_attempts(replay).iter().all(|attempt| {
            attempt.elapsed_ms == 0
                && attempt.input_chars == 0
                && attempt.output_chars == 0
                && attempt.physical_provider_calls == Some(0)
                && attempt.semantic_corrections == Some(0)
        }));
    }

    #[tokio::test]
    async fn saved_preflight_is_provider_free_and_registers_exact_cancellation() {
        let mut fixture = fixture();
        let registry = TriageCancellationRegistryV1::default();
        let engine = WorkflowTriageEngineV1::new(
            &mut fixture.host,
            fixture.cache.path(),
            fixture.config,
            Arc::new(fixture.secrets.clone()),
            fixture.policies,
            fixture.qualifications,
            registry.clone(),
        );
        let request = ValidatedTriageRequest::new(request(TriagePolicySelectionV2::Saved {
            policy_id: "saved:test".into(),
            policy_revision: 1,
        }))
        .expect("request");
        let prepared = engine.preflight(&request).await.expect("preflight");
        assert_eq!(
            prepared.input.as_ref().unwrap().request_fingerprint,
            request.fingerprint()
        );
        assert_eq!(registry.len(), 1);
        assert!(registry.cancel(&prepared.cancellation).expect("cancel"));
        assert!(prepared.cancel_owner.load(Ordering::SeqCst));
        registry.remove_if_owned(&prepared.cancellation, &prepared.cancel_owner);
        assert_eq!(registry.len(), 0);
    }

    #[tokio::test]
    async fn standard_preflight_builds_the_exact_requested_single_model_policy() {
        let mut fixture = fixture();
        let registry = TriageCancellationRegistryV1::default();
        let model = ModelRef {
            profile_id: "profile:test".into(),
            model_id: "model:test".into(),
        };
        let engine = WorkflowTriageEngineV1::new(
            &mut fixture.host,
            fixture.cache.path(),
            fixture.config,
            Arc::new(fixture.secrets.clone()),
            fixture.policies,
            fixture.qualifications,
            registry.clone(),
        );
        let request = ValidatedTriageRequest::new(request(TriagePolicySelectionV2::Standard {
            model: model.clone(),
        }))
        .expect("request");
        let prepared = engine.preflight(&request).await.expect("preflight");

        let policy = prepared.policy.as_ref().expect("policy");
        assert_eq!(policy.mode, TriagePolicyMode::Standard);
        assert!(policy.contributors.is_empty());
        assert!(policy.reviewer.is_none());
        let finalizer = policy.finalizer.as_ref().expect("finalizer");
        assert_eq!(finalizer.slot_id, "standard-finalizer");
        assert_eq!(finalizer.model, model);
        let preflight = prepared.preflight.as_ref().expect("preflight");
        assert_eq!(preflight.roles.len(), 1);
        assert_eq!(preflight.roles[0].model, finalizer.model);
        assert_eq!(
            prepared.input.as_ref().unwrap().request_fingerprint,
            request.fingerprint()
        );
        assert_eq!(registry.len(), 1);
        registry.remove_if_owned(&prepared.cancellation, &prepared.cancel_owner);
        assert_eq!(registry.len(), 0);
    }

    #[tokio::test]
    async fn inline_standard_document_returns_authoritative_failed_replay() {
        let mut fixture = fixture();
        let registry = TriageCancellationRegistryV1::default();
        let reads = Arc::clone(&fixture.secrets.reads);
        let standard = TriagePolicyV2::standard(
            ModelRef {
                profile_id: "profile:test".into(),
                model_id: "model:test".into(),
            },
            false,
        );
        let engine = WorkflowTriageEngineV1::new(
            &mut fixture.host,
            fixture.cache.path(),
            fixture.config,
            Arc::new(fixture.secrets.clone()),
            fixture.policies,
            fixture.qualifications,
            registry.clone(),
        );
        let request = request(TriagePolicySelectionV2::Inline {
            schema_id: TRIAGE_POLICY_SCHEMA_V2.into(),
            document: serde_json::to_value(standard).expect("policy"),
        });
        let validated = ValidatedTriageRequest::new(request.clone()).expect("request");
        let streamed = Arc::new(Mutex::new(Vec::<TriageRunEventV2>::new()));
        let captured = Arc::clone(&streamed);
        let sink = TriageEventSink::new(&validated, move |event| {
            captured.lock().unwrap().push(event.clone());
        });
        let execution = triage_with_policy(&engine, request, Some(sink))
            .await
            .expect("authoritative failed execution");
        assert!(matches!(
            execution.terminal(),
            TriageExecutionTerminal::Failed { category, partial_result: None }
                if category == "policy_preflight_rejected"
        ));
        execution.replay().validate().unwrap();
        assert_provider_free(execution.replay());
        let attempts = replay_attempts(execution.replay());
        assert_eq!(attempts.len(), 1);
        assert_eq!(attempts[0].role_slot_id, "standard-finalizer");
        assert_eq!(attempts[0].status, TriageAttemptStatus::NotAdmitted);
        assert_eq!(
            streamed.lock().unwrap().as_slice(),
            execution.replay().events.as_slice()
        );
        assert_eq!(reads.load(Ordering::SeqCst), 0);
        assert_eq!(registry.len(), 0);
    }

    #[tokio::test]
    async fn compile_rejection_accounts_the_resolved_slot_without_host_work() {
        let mut fixture = fixture();
        fixture.qualifications = TriageRoleQualificationStoreV1::default();
        let registry = TriageCancellationRegistryV1::default();
        let reads = Arc::clone(&fixture.secrets.reads);
        let request = request(TriagePolicySelectionV2::Saved {
            policy_id: "saved:test".into(),
            policy_revision: 1,
        });
        let engine = WorkflowTriageEngineV1::new(
            &mut fixture.host,
            fixture.cache.path(),
            fixture.config,
            Arc::new(fixture.secrets.clone()),
            fixture.policies,
            fixture.qualifications,
            registry.clone(),
        );

        let execution = triage_with_policy(&engine, request, None)
            .await
            .expect("compile rejection replay");
        assert!(matches!(
            execution.terminal(),
            TriageExecutionTerminal::Failed {
                partial_result: None,
                ..
            }
        ));
        assert_provider_free(execution.replay());
        let attempts = replay_attempts(execution.replay());
        assert_eq!(attempts.len(), 1);
        assert_eq!(attempts[0].role_slot_id, "standard-finalizer");
        assert_eq!(attempts[0].status, TriageAttemptStatus::NotAdmitted);
        assert!(attempts[0]
            .reason_codes
            .contains(&"qualification_unavailable".into()));
        assert_eq!(reads.load(Ordering::SeqCst), 0);
        assert_eq!(registry.len(), 0);
    }

    #[tokio::test]
    async fn unresolved_policy_identity_fails_without_fabricating_slots() {
        let selections = [
            TriagePolicySelectionV2::Saved {
                policy_id: "saved:missing".into(),
                policy_revision: 1,
            },
            TriagePolicySelectionV2::Inline {
                schema_id: TRIAGE_POLICY_SCHEMA_V2.into(),
                document: serde_json::json!({
                    "schema_id": TRIAGE_POLICY_SCHEMA_V2,
                    "mode": 7
                }),
            },
        ];
        for selection in selections {
            let mut fixture = fixture();
            let registry = TriageCancellationRegistryV1::default();
            let reads = Arc::clone(&fixture.secrets.reads);
            let engine = WorkflowTriageEngineV1::new(
                &mut fixture.host,
                fixture.cache.path(),
                fixture.config,
                Arc::new(fixture.secrets.clone()),
                fixture.policies,
                fixture.qualifications,
                registry.clone(),
            );

            let execution = triage_with_policy(&engine, request(selection), None)
                .await
                .expect("unresolved policy replay");
            assert!(matches!(
                execution.terminal(),
                TriageExecutionTerminal::Failed {
                    partial_result: None,
                    ..
                }
            ));
            assert_provider_free(execution.replay());
            assert!(replay_attempts(execution.replay()).is_empty());
            assert_eq!(reads.load(Ordering::SeqCst), 0);
            assert_eq!(registry.len(), 0);
        }
    }

    #[tokio::test]
    async fn cancellation_before_packet_work_returns_authoritative_replay() {
        let mut fixture = fixture();
        let registry = TriageCancellationRegistryV1::default();
        let reads = Arc::clone(&fixture.secrets.reads);
        let proof_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let observed_proof_calls = Arc::clone(&proof_calls);
        let proof_observer: TriagePacketProofObserverV1 = Arc::new(
            move |_proof: &crate::triage_host::TriageExecutedPacketProofV1| {
                observed_proof_calls.fetch_add(1, Ordering::SeqCst);
                Ok(())
            },
        );
        let request = ValidatedTriageRequest::new(request(TriagePolicySelectionV2::Saved {
            policy_id: "saved:test".into(),
            policy_revision: 1,
        }))
        .expect("request");
        let engine = WorkflowTriageEngineV1::new(
            &mut fixture.host,
            fixture.cache.path(),
            fixture.config,
            Arc::new(fixture.secrets.clone()),
            fixture.policies,
            fixture.qualifications,
            registry.clone(),
        )
        .with_packet_proof_observer(proof_observer);
        let prepared = engine.preflight(&request).await.expect("preflight");
        assert!(registry.cancel(&prepared.cancellation).expect("cancel"));

        let replay = engine
            .execute(request.clone(), prepared, None)
            .await
            .expect("cancel replay");
        let execution = replay_validated(&request, replay).expect("bound replay");
        assert!(matches!(
            execution.terminal(),
            TriageExecutionTerminal::Cancelled {
                partial_result: None,
                ..
            }
        ));
        assert_provider_free(execution.replay());
        assert!(replay_attempts(execution.replay())
            .iter()
            .all(|attempt| attempt.status == TriageAttemptStatus::Cancelled));
        assert_eq!(proof_calls.load(Ordering::SeqCst), 0);
        assert_eq!(reads.load(Ordering::SeqCst), 0);
        assert_eq!(registry.len(), 0);
    }

    #[tokio::test]
    async fn caller_owned_precancel_is_direct_and_provider_free() {
        let mut fixture = fixture();
        let registry = TriageCancellationRegistryV1::default();
        let reads = Arc::clone(&fixture.secrets.reads);
        let proof_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let observed_proof_calls = Arc::clone(&proof_calls);
        let proof_observer: TriagePacketProofObserverV1 = Arc::new(
            move |_proof: &crate::triage_host::TriageExecutedPacketProofV1| {
                observed_proof_calls.fetch_add(1, Ordering::SeqCst);
                Ok(())
            },
        );
        let request = ValidatedTriageRequest::new(request(TriagePolicySelectionV2::Saved {
            policy_id: "saved:test".into(),
            policy_revision: 1,
        }))
        .expect("request");
        let owner = Arc::new(AtomicBool::new(true));
        let engine = WorkflowTriageEngineV1::new(
            &mut fixture.host,
            fixture.cache.path(),
            fixture.config,
            Arc::new(fixture.secrets.clone()),
            fixture.policies,
            fixture.qualifications,
            registry.clone(),
        )
        .with_packet_proof_observer(proof_observer)
        .with_cancel_owner(Arc::clone(&owner));

        let prepared = engine.preflight(&request).await.expect("preflight");
        assert!(prepared.policy.is_none());
        assert!(prepared.input.is_none());
        assert!(registry.cancel(&prepared.cancellation).expect("registered"));
        assert!(owner.load(Ordering::SeqCst));

        let replay = engine
            .execute(request.clone(), prepared, None)
            .await
            .expect("cancel replay");
        let execution = replay_validated(&request, replay).expect("bound replay");
        assert!(matches!(
            execution.terminal(),
            TriageExecutionTerminal::Cancelled {
                partial_result: None,
                ..
            }
        ));
        assert_provider_free(execution.replay());
        assert_eq!(proof_calls.load(Ordering::SeqCst), 0);
        assert_eq!(reads.load(Ordering::SeqCst), 0);
        assert_eq!(registry.len(), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn deadline_before_packet_work_returns_authoritative_replay() {
        let mut fixture = fixture();
        let registry = TriageCancellationRegistryV1::default();
        let reads = Arc::clone(&fixture.secrets.reads);
        let proof_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let observed_proof_calls = Arc::clone(&proof_calls);
        let proof_observer: TriagePacketProofObserverV1 = Arc::new(
            move |_proof: &crate::triage_host::TriageExecutedPacketProofV1| {
                observed_proof_calls.fetch_add(1, Ordering::SeqCst);
                Ok(())
            },
        );
        let mut request = request(TriagePolicySelectionV2::Saved {
            policy_id: "saved:test".into(),
            policy_revision: 1,
        });
        request.overrides.deadline_ms = Some(300_000);
        let request = ValidatedTriageRequest::new(request).expect("request");
        let engine = WorkflowTriageEngineV1::new(
            &mut fixture.host,
            fixture.cache.path(),
            fixture.config,
            Arc::new(fixture.secrets.clone()),
            fixture.policies,
            fixture.qualifications,
            registry.clone(),
        )
        .with_packet_proof_observer(proof_observer);
        let prepared = engine.preflight(&request).await.expect("preflight");
        tokio::time::advance(Duration::from_millis(300_001)).await;

        let replay = engine
            .execute(request.clone(), prepared, None)
            .await
            .expect("timeout replay");
        let execution = replay_validated(&request, replay).expect("bound replay");
        assert!(matches!(
            execution.terminal(),
            TriageExecutionTerminal::TimedOut {
                partial_result: None,
                ..
            }
        ));
        assert_provider_free(execution.replay());
        assert!(replay_attempts(execution.replay())
            .iter()
            .all(|attempt| attempt.status == TriageAttemptStatus::TimedOut));
        assert_eq!(proof_calls.load(Ordering::SeqCst), 0);
        assert_eq!(reads.load(Ordering::SeqCst), 0);
        assert_eq!(registry.len(), 0);
    }

    #[tokio::test]
    async fn facade_host_failure_restores_scope_and_cancellation_registration() {
        let mut fixture = fixture();
        fixture
            .host
            .set_log_corpus_scope(Some("prior-scope".into()));
        fixture
            .host
            .set_active_log_corpus(Some("prior-active".into()));
        let registry = TriageCancellationRegistryV1::default();
        let request = request(TriagePolicySelectionV2::Saved {
            policy_id: "saved:test".into(),
            policy_revision: 1,
        });
        let engine = WorkflowTriageEngineV1::new(
            &mut fixture.host,
            fixture.cache.path(),
            fixture.config,
            Arc::new(fixture.secrets.clone()),
            fixture.policies,
            fixture.qualifications,
            registry.clone(),
        );

        let error = triage_with_policy(&engine, request, None)
            .await
            .expect_err("missing corpus must fail before provider setup");
        assert!(matches!(
            error,
            TriageRuntimeError::Engine(error)
                if error.category() == TriageEngineFailureCategory::HostUnavailable
        ));
        drop(engine);

        assert_eq!(fixture.host.log_corpus_scope(), Some("prior-scope"));
        assert_eq!(fixture.host.active_log_corpus(), Some("prior-active"));
        assert_eq!(registry.len(), 0);
    }

    #[tokio::test]
    async fn standard_facade_reaches_the_host_and_cleans_failed_preparation() {
        let mut fixture = fixture();
        fixture
            .host
            .set_log_corpus_scope(Some("prior-scope".into()));
        fixture
            .host
            .set_active_log_corpus(Some("prior-active".into()));
        let registry = TriageCancellationRegistryV1::default();
        let request = request(TriagePolicySelectionV2::Standard {
            model: ModelRef {
                profile_id: "profile:test".into(),
                model_id: "model:test".into(),
            },
        });
        let engine = WorkflowTriageEngineV1::new(
            &mut fixture.host,
            fixture.cache.path(),
            fixture.config,
            Arc::new(fixture.secrets.clone()),
            fixture.policies,
            fixture.qualifications,
            registry.clone(),
        );

        let error = triage(&engine, request, None)
            .await
            .expect_err("missing corpus must fail during host preparation");
        assert!(matches!(
            error,
            TriageRuntimeError::Engine(error)
                if error.category() == TriageEngineFailureCategory::HostUnavailable
        ));
        drop(engine);

        assert_eq!(fixture.host.log_corpus_scope(), Some("prior-scope"));
        assert_eq!(fixture.host.active_log_corpus(), Some("prior-active"));
        assert_eq!(registry.len(), 0);
    }

    #[test]
    fn registry_is_exact_and_does_not_cross_cancel() {
        let registry = TriageCancellationRegistryV1::default();
        let cancellation = TriageCancellationV1 {
            schema_id: cd_core::triage_sdk::TRIAGE_CANCELLATION_SCHEMA_V1.into(),
            run_id: "run:a".into(),
            cancellation_id: "cancel:a".into(),
        };
        let owner = registry.register(&cancellation).expect("register");
        let sibling = TriageCancellationV1 {
            cancellation_id: "cancel:b".into(),
            ..cancellation.clone()
        };
        assert!(!registry.cancel(&sibling).expect("sibling lookup"));
        assert!(!owner.load(Ordering::SeqCst));
        assert!(registry.cancel(&cancellation).expect("exact lookup"));
        assert!(owner.load(Ordering::SeqCst));
        registry.remove_if_owned(&cancellation, &owner);
    }
}
