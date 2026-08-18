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

use async_trait::async_trait;
use cd_core::config::AppConfig;
use cd_core::keychain_store::SecretStore;
use cd_core::multi_model::triage_policy::{
    TriagePolicyMode, TriagePolicyPreflightV2, TriagePolicyV2,
};
use cd_core::tool_host::ToolHost;
use cd_core::triage_policy_store::TriagePolicyStoreV1;
use cd_core::triage_role_qualification::TriageRoleQualificationStoreV1;
use cd_core::triage_sdk::{TriageCancellationV1, TriagePolicySelectionV2, TriageReplayV1};
use cd_triage_runtime::{
    TriageEngine, TriageEngineFailure, TriageEngineFailureCategory, TriageEventSink,
    ValidatedTriageRequest,
};
use sha2::{Digest, Sha256};

use crate::triage::compile_preflight;
use crate::triage_host::{
    preflight_for_policy, resolve_v2_host, run_v2_host, HostValidatedAnswerHooks, TriageHostError,
    TriageHostRunInput,
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
        let key = CancellationKey::from(cancellation);
        let owner = Arc::new(AtomicBool::new(false));
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
    policy: TriagePolicyV2,
    preflight: TriagePolicyPreflightV2,
    input: TriageHostRunInput,
    cancellation: TriageCancellationV1,
    cancel_owner: Arc<AtomicBool>,
}

impl std::fmt::Debug for WorkflowTriagePreflightV1 {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("WorkflowTriagePreflightV1")
            .field("policy_mode", &self.policy.mode)
            .field("run_id", &self.input.run_id)
            .field("request_fingerprint", &self.input.request_fingerprint)
            .finish_non_exhaustive()
    }
}

/// Real Saved/Inline public-runtime engine backed by the existing workflow host.
///
/// The engine borrows a run-exclusive [`ToolHost`] and secret store. Policy and
/// role-qualification stores are already-loaded, bounded host snapshots; this
/// type performs no policy-store filesystem I/O of its own.
pub struct WorkflowTriageEngineV1<'a> {
    host: tokio::sync::Mutex<&'a mut ToolHost>,
    cache_root: PathBuf,
    config: AppConfig,
    secrets: &'a dyn SecretStore,
    policies: TriagePolicyStoreV1,
    qualifications: TriageRoleQualificationStoreV1,
    cancellations: TriageCancellationRegistryV1,
}

impl<'a> WorkflowTriageEngineV1<'a> {
    /// Bind an existing run-exclusive host and already-loaded host policy state.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        host: &'a mut ToolHost,
        cache_root: &Path,
        config: AppConfig,
        secrets: &'a dyn SecretStore,
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
        }
    }

    /// Return the shared cancellation registry used by this engine.
    pub fn cancellations(&self) -> &TriageCancellationRegistryV1 {
        &self.cancellations
    }

    fn policy_for_request(
        &self,
        request: &ValidatedTriageRequest,
    ) -> Result<TriagePolicyV2, TriageEngineFailure> {
        let mut policy = match &request.request().policy {
            TriagePolicySelectionV2::Standard { .. } => {
                return Err(preflight_rejected());
            }
            TriagePolicySelectionV2::Inline { document, .. } => {
                serde_json::from_value(document.clone()).map_err(|_| preflight_rejected())?
            }
            TriagePolicySelectionV2::Saved {
                policy_id,
                policy_revision,
            } => self
                .policies
                .policies
                .iter()
                .find(|saved| saved.policy_id == *policy_id && saved.revision == *policy_revision)
                .map(|saved| saved.policy.clone())
                .ok_or_else(preflight_rejected)?,
        };
        if matches!(policy.mode, TriagePolicyMode::Standard) {
            return Err(preflight_rejected());
        }
        if let Some(deadline_ms) = request.request().overrides.deadline_ms {
            policy.budget.whole_turn_deadline_ms = Some(deadline_ms);
        }
        if let Some(max_provider_calls) = request.request().overrides.max_provider_calls {
            policy.budget.max_provider_calls = max_provider_calls;
        }
        Ok(policy)
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
        if deadline_ms == 0 || context_char_budget == 0 {
            return Err(preflight_rejected());
        }
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
}

#[async_trait]
impl TriageEngine for WorkflowTriageEngineV1<'_> {
    type Preflight = WorkflowTriagePreflightV1;

    async fn preflight(
        &self,
        request: &ValidatedTriageRequest,
    ) -> Result<Self::Preflight, TriageEngineFailure> {
        let cancellation = TriageCancellationV1 {
            schema_id: cd_core::triage_sdk::TRIAGE_CANCELLATION_SCHEMA_V1.into(),
            run_id: request.request().run_id.clone(),
            cancellation_id: request.request().cancellation_id.clone(),
        };
        let cancel_owner = self.cancellations.register(&cancellation)?;
        let prepared = (|| {
            self.policies.validate().map_err(|_| preflight_rejected())?;
            self.qualifications
                .validate()
                .map_err(|_| preflight_rejected())?;
            let policy = self.policy_for_request(request)?;
            let preflight = preflight_for_policy(&self.config, &policy, &self.qualifications);
            compile_preflight(&policy, &preflight).map_err(|_| preflight_rejected())?;
            let input = self.host_input(request, &policy, Arc::clone(&cancel_owner))?;
            Ok::<_, TriageEngineFailure>((policy, preflight, input))
        })();
        let (policy, preflight, input) = match prepared {
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
            input,
            cancellation,
            cancel_owner,
        })
    }

    async fn execute(
        &self,
        request: ValidatedTriageRequest,
        prepared: Self::Preflight,
        events: Option<TriageEventSink>,
    ) -> Result<TriageReplayV1, TriageEngineFailure> {
        if prepared.input.run_id != request.request().run_id
            || prepared.input.request_fingerprint != request.fingerprint()
            || prepared.input.cancellation_id != request.request().cancellation_id
        {
            self.cancellations
                .remove_if_owned(&prepared.cancellation, &prepared.cancel_owner);
            return Err(preflight_rejected());
        }

        let event_failed = Arc::new(AtomicBool::new(false));
        let production_sink = events.map(|sink| {
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
            let mut host = self.host.lock().await;
            let resolved = resolve_v2_host(
                &mut host,
                &self.cache_root,
                &self.config,
                self.secrets,
                &prepared.policy,
                &prepared.preflight,
                &prepared.input,
            )
            .await
            .map_err(map_preflight_host_error);
            match resolved {
                Ok(resolved) => run_v2_host(
                    &mut host,
                    resolved,
                    prepared.input,
                    &HostValidatedAnswerHooks::default(),
                    production_sink,
                )
                .await
                .map(|result| result.replay)
                .map_err(map_execution_host_error),
                Err(error) => Err(error),
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
        TriageHostError::Contract(_) => TriageEngineFailureCategory::ExecutionFailed,
    };
    TriageEngineFailure::new(category)
}

fn map_execution_host_error(error: TriageHostError) -> TriageEngineFailure {
    let category = match error {
        TriageHostError::Cancelled => TriageEngineFailureCategory::Cancelled,
        TriageHostError::Deadline => TriageEngineFailureCategory::DeadlineExceeded,
        TriageHostError::Contract(_) => TriageEngineFailureCategory::InvalidEvent,
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
        TriagePolicySelectionV2, TriageRequestOverridesV1, TriageRequestV2, TriageScopeV1,
        TRIAGE_REQUEST_SCHEMA_V2,
    };
    use cd_core::workspace::Workspace;
    use cd_triage_runtime::{triage_with_policy, TriageEngine, TriageRuntimeError};

    struct Fixture {
        _workspace: tempfile::TempDir,
        cache: tempfile::TempDir,
        host: ToolHost,
        config: AppConfig,
        secrets: MemorySecretStore,
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
        let mut qualifications = TriageRoleQualificationStoreV1::default();
        qualifications
            .put(TriageRoleQualificationRecordV1 {
                key,
                qualification: RoleQualificationV2::Qualified,
                physical_provider_calls: 1,
                semantic_corrections: 0,
                reason: "fixture-qualified".into(),
                tested_at: 1,
            })
            .expect("qualification");
        Fixture {
            _workspace: workspace_dir,
            cache,
            host,
            config,
            secrets: MemorySecretStore::new(),
            policies,
            qualifications,
        }
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

    #[tokio::test]
    async fn saved_preflight_is_provider_free_and_registers_exact_cancellation() {
        let mut fixture = fixture();
        let registry = TriageCancellationRegistryV1::default();
        let engine = WorkflowTriageEngineV1::new(
            &mut fixture.host,
            fixture.cache.path(),
            fixture.config,
            &fixture.secrets,
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
        assert_eq!(prepared.input.request_fingerprint, request.fingerprint());
        assert_eq!(registry.len(), 1);
        assert!(registry.cancel(&prepared.cancellation).expect("cancel"));
        assert!(prepared.cancel_owner.load(Ordering::SeqCst));
        registry.remove_if_owned(&prepared.cancellation, &prepared.cancel_owner);
        assert_eq!(registry.len(), 0);
    }

    #[tokio::test]
    async fn inline_standard_document_fails_closed_and_cleans_registration() {
        let mut fixture = fixture();
        let registry = TriageCancellationRegistryV1::default();
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
            &fixture.secrets,
            fixture.policies,
            fixture.qualifications,
            registry.clone(),
        );
        let request = ValidatedTriageRequest::new(request(TriagePolicySelectionV2::Inline {
            schema_id: TRIAGE_POLICY_SCHEMA_V2.into(),
            document: serde_json::to_value(standard).expect("policy"),
        }))
        .expect("request");
        let error = engine.preflight(&request).await.expect_err("must reject");
        assert_eq!(
            error.category(),
            TriageEngineFailureCategory::PreflightRejected
        );
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
            &fixture.secrets,
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
