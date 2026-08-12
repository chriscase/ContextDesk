//! Trusted host resolution for Triage Policy V2.
//!
//! This module is the boundary between application state and the pure V2
//! runner.  It reuses the existing profile/credential/backend factory and the
//! existing deterministic broad-triage brief; it does not create a second
//! provider client or a second evidence-selection path.

use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::sync::Mutex;

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
    CompiledRoleSlotV2, CompiledTriagePolicyV2, SlotDispositionV2, TriagePolicyPreflightV2,
    TriagePolicyV2, TriageSlotKindV2,
};
use cd_core::tool_host::ToolHost;
use cd_core::triage_sdk::TriageContractError;

use crate::provider::{
    backend_for_resolved_turn, resolve_provider_profile,
    resolve_turn_inputs_from_profile_with_credential_cache, TurnProviderCredentialCache,
};
use crate::triage::compile_preflight;
use crate::triage_production::{AuthorizedTriageBackendV1, TriageProductionAdapterRejectionV1};
use crate::triage_production_runner::{
    resolve_v2_production, ResolvedTriageProductionV1, TriageProductionHooks,
    TriageProductionRunInput, TriageProductionRunResultV1, TriageProductionRunnerError,
    TriageProductionRunnerV1,
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

/// Result of host resolution before a provider operation begins.
pub struct ResolvedTriageHostV1 {
    pub compiled: CompiledTriagePolicyV2,
    pub packet: FastTriagePacketV1,
    pub resolution: ResolvedTriageProductionV1,
    pub binding: LinkedCorpusBinding,
}

/// Content-free errors from the trusted host boundary.
#[derive(Debug, Clone)]
pub enum TriageHostError {
    Corpus(String),
    Scope(String),
    Policy(String),
    Profile(String),
    Backend(String),
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

/// A conservative production hook: contributor/reviewer responses must be
/// non-empty, while only a finalizer may create an authoritative answer
/// envelope.  The envelope is derived from the immutable packet ledger; model
/// text never supplies evidence metadata or authority.
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
            return if response.content.trim().is_empty() {
                crate::triage_production_runner::TriageValidationDecision::rejected(
                    "empty_terminal_answer",
                )
            } else {
                crate::triage_production_runner::TriageValidationDecision::accepted()
            };
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
            Self::Policy(_) => "policy_preflight_rejected",
            Self::Profile(_) => "provider_profile_unavailable",
            Self::Backend(_) => "provider_backend_unavailable",
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
    let compiled = compile_preflight(policy, preflight)
        .map_err(|_| TriageHostError::Policy("policy_preflight_rejected".into()))?;
    if compiled.mode == cd_core::multi_model::triage_policy::TriagePolicyMode::Standard {
        return Err(TriageHostError::Runner(
            TriageProductionRunnerError::Unsupported {
                category: TriageProductionAdapterRejectionV1::StandardUsesEstablishedPath,
                slot_ids: Vec::new(),
            },
        ));
    }
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
    let brief = match host.build_broad_log_triage_brief() {
        Ok(brief) => brief,
        Err(error) => {
            unbind_linked_corpus(host, binding);
            return Err(TriageHostError::Corpus(error.to_string()));
        }
    };
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

    let mut budget_cfg = cfg.clone();
    budget_cfg.router.deadline_ms = input.deadline_ms;
    budget_cfg.router.deadline_is_explicit = true;
    let credentials = TurnProviderCredentialCache::new(secrets);
    let mut authorized = Vec::new();
    for slot in compiled
        .slots
        .iter()
        .filter(|slot| slot.disposition == SlotDispositionV2::Admitted)
    {
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
            let backend = match backend_for_resolved_turn(&resolved).await {
                Ok(backend) => backend,
                Err(_) => {
                    unbind_linked_corpus(host, binding);
                    return Err(TriageHostError::Backend("backend_build_failed".into()));
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
            let backend = match backend_for_resolved_turn(&resolved).await {
                Ok(backend) => backend,
                Err(_) => {
                    unbind_linked_corpus(host, binding);
                    return Err(TriageHostError::Backend("backend_build_failed".into()));
                }
            };
            authorized.push(AuthorizedTriageBackendV1 {
                slot_id: slot.slot_id.clone(),
                model: slot.model.clone(),
                backend: Arc::from(backend),
            });
        }
    }

    let resolution = match resolve_v2_production(
        policy,
        preflight,
        authorized,
        input.deadline_ms,
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
    use cd_core::investigation_answer::{EvidenceRole, HostEvidenceEntry, HostEvidenceLedger};
    use cd_core::model_ref::ModelRef;
    use cd_core::multi_model::triage_policy::{RoleRequirement, TriageSlotKindV2};
    use cd_core::triage_sdk::TriageReconciliationV1;

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
}
