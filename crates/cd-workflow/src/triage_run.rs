//! Production Triage Policy V2 runner: host-neutral resolver, event ledger,
//! and linked-turn execution facade.
//!
//! This module closes the gap between the pure V2 policy compiler, the
//! contributor-subset production adapter, and the established linked-log
//! contribution runtime. It contains three cooperating pieces:
//!
//! 1. [`resolve_triage_policy_v2`] — the only place host configuration,
//!    qualification evidence, and credentials become exact
//!    [`RolePreflightV2`] facts plus already-authorized backends. It never
//!    invents availability: a profile that does not resolve, a model that
//!    does not match, or evidence that is absent/stale/failed stays visible
//!    as exactly that.
//! 2. [`TriageRunLedgerV1`] — a typed projection from the production
//!    contribution run (packet, stage events, typed outcome, refusals) into
//!    the ordered, replay-valid [`TriageRunEventV2`] stream shared by CLI
//!    JSONL, Tauri IPC, and HTTP/SSE adapters. It never parses rendered
//!    prose and fails closed on any identity mismatch.
//! 3. [`run_triage_policy_v2_linked_turn`] — the host-neutral facade that
//!    binds them to the same [`crate::turn::run_turn`] path the CLI and
//!    desktop already use. Standard mode is deliberately refused here: the
//!    established single-model route remains authoritative for it.
//!
//! No function in this module constructs an HTTP client, reads a keychain
//! secret directly, or calls a provider outside the already-authorized
//! backends resolved for the compiled policy.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use cd_core::agent::{ContributionPolicyBindingV1, LogExplorerTurnContext};
use cd_core::capability_qualification::{
    capability_contract_verdict, CapabilityContract, ContractVerdict, QualificationKey,
    QualificationStore,
};
use cd_core::chat::ChatMessage;
use cd_core::config::AppConfig;
use cd_core::events::StreamEvent;
use cd_core::extension_contract::PacketPrivacyBoundary;
use cd_core::fast_triage::{FastTriageNeighborhoodBudget, FastTriagePacketV1};
use cd_core::model_ref::ModelRef;
use cd_core::multi_model::triage_policy::{
    RolePreflightV2, RoleQualificationV2, RoleRequirement, SlotDispositionV2,
    TriagePolicyPreflightV2, TriagePolicyV2, TriageSlotKindV2,
};
use cd_core::multi_model::{
    ContributionAvailability, ContributionPipelineOutcome, ContributionRouteRefusalV1,
    ContributionRunObserverV1, ContributionStageEvent,
};
use cd_core::tool_host::ToolHost;
use cd_core::triage_sdk::{
    TriageAttemptStatus, TriageContractError, TriageReconciliationV1, TriageReplayV1,
    TriageRequestOverridesV1, TriageRequestV2, TriageResultKind, TriageResultV2,
    TriageRoleAttemptV1, TriageRunEventPayloadV2, TriageRunEventV2, TriageValidationState,
    MAX_TRIAGE_EVIDENCE_IDS, MAX_TRIAGE_REASON_CODES, TRIAGE_REPLAY_SCHEMA_V1,
    TRIAGE_RESULT_SCHEMA_V2, TRIAGE_RUN_EVENT_SCHEMA_V2,
};
use tokio::time::Instant;

use crate::provider::{
    backend_for_resolved_turn, resolve_provider_profile,
    resolve_turn_inputs_from_profile_with_credential_cache, ResolvedTurnInputs,
    TurnProviderCredentialCache,
};
use crate::triage::rejection_code;
use crate::triage_production::{
    prepare_v2_contribution_runtime_with_projection, AuthorizedTriageBackendV1,
    PreparedV2ContributionRuntimeV1, TriageProductionAdapterErrorV1, V2ContributionSlotBindingV1,
    V2ProjectionCapabilitiesV1,
};
use crate::turn::{bind_linked_corpus, run_turn, unbind_linked_corpus, TurnExecutionOptions};

/// Sentinel packet identity for a terminal result emitted before any host
/// packet existed (route refusals, compile failures). It is content-free and
/// self-describing rather than an invented packet identity.
pub const TRIAGE_PACKET_NOT_ASSEMBLED: &str = "packet:not_assembled";

/// Live sink receiving every appended ledger event, in order.
pub type TriageRunEventSinkV1 = Box<dyn FnMut(&TriageRunEventV2) + Send>;

/// Host-owned identities for one V2 run. `run_id` and `cancellation_id` come
/// from the validated request; fingerprints come from the shared
/// `cd_core::triage_sdk` helpers so replay identity is content-derived.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TriageRunIdentityV1 {
    /// Opaque run identity, unique per run.
    pub run_id: String,
    /// Content fingerprint of the validated request.
    pub request_fingerprint: String,
    /// Content fingerprint of the authored policy document.
    pub policy_fingerprint: String,
    /// Cancellation identity echoed by a cancelled terminal.
    pub cancellation_id: String,
}

/// Typed failure for the run facade before or after provider execution.
#[derive(Debug)]
pub enum TriagePolicyRunErrorV1 {
    /// The request/policy pair violates the public SDK contract.
    Contract(TriageContractError),
    /// A user-authored override would extend a policy-authored bound.
    OverrideExtendsPolicy {
        /// `deadline_ms` or `max_provider_calls`.
        field: &'static str,
    },
    /// Compilation or production adaptation refused before any provider call.
    Adapter(TriageProductionAdapterErrorV1),
    /// The turn failed and the ledger could not produce a valid replay.
    Ledger(TriageContractError),
}

impl std::fmt::Display for TriagePolicyRunErrorV1 {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Contract(error) => write!(f, "triage contract rejected: {error}"),
            Self::OverrideExtendsPolicy { field } => {
                write!(f, "request override would extend policy `{field}`")
            }
            Self::Adapter(error) => write!(f, "triage policy not runnable: {}", error.category()),
            Self::Ledger(error) => write!(f, "triage ledger invalid: {error}"),
        }
    }
}

impl std::error::Error for TriagePolicyRunErrorV1 {}

/// Apply the request's user-authored overrides to the authored policy.
///
/// Overrides may narrow but never extend policy-authored bounds: a request
/// cannot grant a longer deadline or more provider calls than the policy
/// names. When the policy leaves the whole-turn deadline unset, an explicit
/// request deadline becomes the policy deadline for this run.
pub fn effective_policy_with_overrides(
    policy: &TriagePolicyV2,
    overrides: &TriageRequestOverridesV1,
) -> Result<TriagePolicyV2, TriagePolicyRunErrorV1> {
    let mut effective = policy.clone();
    if let Some(deadline) = overrides.deadline_ms {
        match effective.budget.whole_turn_deadline_ms {
            Some(policy_deadline) if deadline > policy_deadline => {
                return Err(TriagePolicyRunErrorV1::OverrideExtendsPolicy {
                    field: "deadline_ms",
                });
            }
            _ => effective.budget.whole_turn_deadline_ms = Some(deadline),
        }
    }
    if let Some(calls) = overrides.max_provider_calls {
        if calls > effective.budget.max_provider_calls {
            return Err(TriagePolicyRunErrorV1::OverrideExtendsPolicy {
                field: "max_provider_calls",
            });
        }
        effective.budget.max_provider_calls = calls;
    }
    Ok(effective)
}

/// Host-observed facts plus already-authorized backends for one policy.
pub struct ResolvedTriagePolicyV2 {
    /// Exact preflight facts for every configured slot, in slot order.
    pub preflight: TriagePolicyPreflightV2,
    /// Authorized backends for exactly the compiler-admitted contributor
    /// slots. Empty when compilation fails; the adapter then reports the
    /// complete typed failure itself.
    pub backends: Vec<AuthorizedTriageBackendV1>,
}

impl std::fmt::Debug for ResolvedTriagePolicyV2 {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ResolvedTriagePolicyV2")
            .field("preflight_roles", &self.preflight.roles.len())
            .field("backends", &self.backends.len())
            .finish_non_exhaustive()
    }
}

struct SlotToResolve {
    slot_id: String,
    kind: TriageSlotKindV2,
    declared: ModelRef,
}

fn slots_to_resolve(policy: &TriagePolicyV2) -> Vec<SlotToResolve> {
    let mut slots: Vec<SlotToResolve> = policy
        .contributors
        .iter()
        .map(|slot| SlotToResolve {
            slot_id: slot.slot_id.clone(),
            kind: TriageSlotKindV2::Contributor(slot.role),
            declared: slot.model.clone(),
        })
        .collect();
    if let Some(slot) = &policy.finalizer {
        slots.push(SlotToResolve {
            slot_id: slot.slot_id.clone(),
            kind: TriageSlotKindV2::Finalizer,
            declared: slot.model.clone(),
        });
    }
    if let Some(slot) = &policy.reviewer {
        slots.push(SlotToResolve {
            slot_id: slot.slot_id.clone(),
            kind: TriageSlotKindV2::Reviewer,
            declared: slot.model.clone(),
        });
    }
    slots
}

/// Resolve host-observed preflight facts and authorized backends for one
/// policy, without mutating configuration or probing a provider.
///
/// For every configured slot this reports what the host can actually
/// observe right now:
///
/// - `available`: the exact profile resolves and (for contributor slots) a
///   production backend could be constructed from cached credentials;
/// - `model`: the exact identity host resolution observed — a profile whose
///   resolved chat model differs from the declared slot model surfaces the
///   observed identity, which the pure compiler then rejects as a binding
///   mismatch rather than silently substituting;
/// - `qualification`: the measured JSON-proposal contract verdict for the
///   exact profile/endpoint/model key. Absent evidence is `Unverified`,
///   stale evidence is `Stale`, and a failed measurement is `Unqualified` —
///   a model name never qualifies anything;
/// - `remote`: whether the profile can egress beyond loopback. The compiler
///   enforces the slot's explicit `allow_remote` against this.
///
/// Backends are constructed only for contributor slots and returned only
/// for the slots the pure compiler admits, so the production adapter's
/// exact-cover check holds by construction.
pub async fn resolve_triage_policy_v2(
    cfg: &AppConfig,
    credentials: &TurnProviderCredentialCache<'_>,
    qualification_store: Option<&QualificationStore>,
    policy: &TriagePolicyV2,
) -> ResolvedTriagePolicyV2 {
    let mut roles = Vec::new();
    let mut held_backends: BTreeMap<String, AuthorizedTriageBackendV1> = BTreeMap::new();
    for slot in slots_to_resolve(policy) {
        let Ok(profile) = resolve_provider_profile(cfg, Some(&slot.declared.profile_id)) else {
            roles.push(RolePreflightV2 {
                slot_id: slot.slot_id,
                model: slot.declared,
                kind: slot.kind,
                available: false,
                qualification: RoleQualificationV2::Unverified,
                remote: false,
            });
            continue;
        };
        let remote = !profile.local_only;
        let inputs = resolve_turn_inputs_from_profile_with_credential_cache(
            credentials,
            cfg,
            profile,
            Some(&slot.declared.model_id),
        );
        let observed = ModelRef {
            profile_id: inputs.profile.id.clone(),
            model_id: inputs.profile.chat_model.clone(),
        };
        let key = QualificationKey::with_provider_kind(
            &inputs.profile.id,
            &inputs.profile.base_url,
            &inputs.profile.chat_model,
            inputs.profile.kind,
        );
        let qualification = match qualification_store.and_then(|store| store.get(&key)) {
            None => RoleQualificationV2::Unverified,
            Some(report) if report.stale => RoleQualificationV2::Stale,
            Some(report) => {
                match capability_contract_verdict(Some(report), CapabilityContract::JsonProposal) {
                    ContractVerdict::Qualified => RoleQualificationV2::Qualified,
                    ContractVerdict::Unqualified => RoleQualificationV2::Unqualified,
                    ContractVerdict::Inconclusive => RoleQualificationV2::Unverified,
                }
            }
        };
        let available = if matches!(slot.kind, TriageSlotKindV2::Contributor(_)) {
            match backend_for_resolved_turn(&inputs).await {
                Ok(backend) => {
                    held_backends.insert(
                        slot.slot_id.clone(),
                        AuthorizedTriageBackendV1 {
                            slot_id: slot.slot_id.clone(),
                            model: observed.clone(),
                            backend: Arc::from(backend),
                        },
                    );
                    true
                }
                Err(_) => false,
            }
        } else {
            // Finalizer/reviewer slots are never executed by this production
            // subset; their availability fact is profile/model resolution.
            true
        };
        roles.push(RolePreflightV2 {
            slot_id: slot.slot_id,
            model: observed,
            kind: slot.kind,
            available,
            qualification,
            remote,
        });
    }

    let preflight = TriagePolicyPreflightV2 { roles };
    let backends = match crate::triage::compile_preflight(policy, &preflight) {
        Ok(compiled) => {
            let admitted: BTreeSet<&str> = compiled
                .slots
                .iter()
                .filter(|slot| {
                    slot.disposition == SlotDispositionV2::Admitted
                        && matches!(slot.kind, TriageSlotKindV2::Contributor(_))
                })
                .map(|slot| slot.slot_id.as_str())
                .collect();
            held_backends
                .into_values()
                .filter(|backend| admitted.contains(backend.slot_id.as_str()))
                .collect()
        }
        Err(_) => Vec::new(),
    };
    ResolvedTriagePolicyV2 {
        preflight,
        backends,
    }
}

/// How one finished run left the turn, as observed by the caller.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TriageTurnDispositionV1 {
    /// `run_turn` returned events normally.
    Completed,
    /// `run_turn` returned an error; the category is host-authored and
    /// content-free (no provider text).
    TurnError {
        /// Stable content-free class.
        category: String,
    },
}

/// Physical-call accounting for one run, kept separate from the wire
/// contract. Contributor calls on this subset are direct backend calls; the
/// correction allowance is intentionally unused (never exceeded).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TriageRunAccountingV1 {
    /// Physical provider calls sent by admitted contributor slots.
    pub provider_calls: u32,
    /// Physical provider calls spent on semantic corrections (always zero on
    /// the contributor subset; the established route performs none).
    pub correction_calls: u32,
    /// Model-facing characters sent across contributor calls.
    pub context_chars_sent: u64,
    /// Response characters received across contributor calls.
    pub output_chars: u64,
}

/// Validated terminal package for one run.
pub struct TriageRunLedgerOutcomeV1 {
    /// Ordered, replay-valid owner-only event stream.
    pub replay: TriageReplayV1,
    /// Authoritative terminal result (also embedded in the terminal event).
    pub result: TriageResultV2,
    /// Host physical-call accounting.
    pub accounting: TriageRunAccountingV1,
}

#[derive(Debug, Clone)]
struct PacketFactsV1 {
    packet_id: String,
    packet_digest: String,
    evidence_count: u32,
}

#[derive(Debug, Clone)]
struct ObservedStageV1 {
    availability: ContributionAvailability,
    reason: Option<&'static str>,
    elapsed_ms: u64,
}

struct LedgerInner {
    identity: TriageRunIdentityV1,
    compiled: cd_core::multi_model::triage_policy::CompiledTriagePolicyV2,
    bindings: Vec<V2ContributionSlotBindingV1>,
    events: Vec<TriageRunEventV2>,
    sink: Option<TriageRunEventSinkV1>,
    packet: Option<PacketFactsV1>,
    // Stage observations for admitted contributor slots, in execution order.
    stage_cursor: usize,
    stage_started_at: Option<Instant>,
    stages: Vec<Option<ObservedStageV1>>,
    outcome: Option<ProjectedOutcomeV1>,
    refusal: Option<ContributionRouteRefusalV1>,
    poison: Option<&'static str>,
    finalized: bool,
}

struct ProjectedOutcomeV1 {
    attempts: Vec<TriageRoleAttemptV1>,
    reconciliation: TriageReconciliationV1,
    envelope: Option<cd_core::investigation_answer::AnswerEnvelopeV1>,
    accounting: TriageRunAccountingV1,
}

/// Typed projection from the production contribution run into the shared
/// owner-only [`TriageRunEventV2`] stream.
///
/// The ledger is constructed from the exact compiled plan and adapter
/// bindings, so every event it emits carries compiler-authored identity —
/// never identity reconstructed from stream prose or model output. Any
/// observation that contradicts those bindings poisons the ledger, which
/// then terminates as a typed failure instead of misattributing work.
pub struct TriageRunLedgerV1 {
    inner: Mutex<LedgerInner>,
}

impl std::fmt::Debug for TriageRunLedgerV1 {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TriageRunLedgerV1").finish_non_exhaustive()
    }
}

impl TriageRunLedgerV1 {
    /// Bind one ledger to the exact compiled plan and adapter bindings.
    pub fn new(
        identity: TriageRunIdentityV1,
        compiled: cd_core::multi_model::triage_policy::CompiledTriagePolicyV2,
        bindings: Vec<V2ContributionSlotBindingV1>,
    ) -> Arc<Self> {
        let stages = vec![None; bindings.len()];
        Arc::new(Self {
            inner: Mutex::new(LedgerInner {
                identity,
                compiled,
                bindings,
                events: Vec::new(),
                sink: None,
                packet: None,
                stage_cursor: 0,
                stage_started_at: None,
                stages,
                outcome: None,
                refusal: None,
                poison: None,
                finalized: false,
            }),
        })
    }

    /// Stream every appended event to `sink` as it is recorded. Install
    /// before [`TriageRunLedgerV1::start`] to observe the full stream.
    pub fn set_event_sink(&self, sink: TriageRunEventSinkV1) {
        self.lock().sink = Some(sink);
    }

    /// Emit the `run_started` event. Call exactly once, before the turn.
    pub fn start(&self) {
        let mut inner = self.lock();
        if !inner.events.is_empty() {
            inner.poison.get_or_insert("duplicate_run_started");
            return;
        }
        let payload = TriageRunEventPayloadV2::RunStarted {
            request_fingerprint: inner.identity.request_fingerprint.clone(),
            policy_fingerprint: inner.identity.policy_fingerprint.clone(),
        };
        append_event(&mut inner, payload);
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, LedgerInner> {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Close the ledger with the turn's observed disposition and produce the
    /// validated replay, terminal result, and physical-call accounting.
    pub fn finalize(
        &self,
        disposition: TriageTurnDispositionV1,
    ) -> Result<TriageRunLedgerOutcomeV1, TriageContractError> {
        let mut inner = self.lock();
        if inner.finalized {
            return Err(TriageContractError::EventAfterTerminal);
        }
        inner.finalized = true;
        if inner.events.is_empty() {
            // Never emit a replay without run_started; callers must start().
            let payload = TriageRunEventPayloadV2::RunStarted {
                request_fingerprint: inner.identity.request_fingerprint.clone(),
                policy_fingerprint: inner.identity.policy_fingerprint.clone(),
            };
            append_event(&mut inner, payload);
        }

        let packet_id = inner
            .packet
            .as_ref()
            .map(|packet| packet.packet_id.clone())
            .unwrap_or_else(|| TRIAGE_PACKET_NOT_ASSEMBLED.to_string());

        enum TerminalKindV1 {
            Completed,
            Failed(String),
            TimedOut,
            Cancelled,
        }

        let (attempts, reconciliation, envelope, accounting, terminal) =
            if let Some(poison) = inner.poison {
                let attempts = fallback_attempts(&inner, poison);
                let reconciliation = fallback_reconciliation(&inner, "projection_mismatch");
                (
                    attempts,
                    reconciliation,
                    None,
                    TriageRunAccountingV1::default(),
                    TerminalKindV1::Failed("ledger_projection_mismatch".to_string()),
                )
            } else if let Some(outcome) = inner.outcome.take() {
                let mut cancelled = false;
                let mut timed_out = false;
                let mut required_failed = false;
                for (slot, attempt) in inner.compiled.slots.iter().zip(&outcome.attempts) {
                    match attempt.status {
                        TriageAttemptStatus::Cancelled => cancelled = true,
                        TriageAttemptStatus::TimedOut => timed_out = true,
                        TriageAttemptStatus::Completed | TriageAttemptStatus::Abstained => {}
                        TriageAttemptStatus::Invalid
                        | TriageAttemptStatus::Unavailable
                        | TriageAttemptStatus::Failed
                        | TriageAttemptStatus::NotAdmitted => {
                            if slot.requirement == RoleRequirement::Required {
                                required_failed = true;
                            }
                        }
                    }
                }
                let terminal = if cancelled {
                    TerminalKindV1::Cancelled
                } else if timed_out {
                    TerminalKindV1::TimedOut
                } else if required_failed {
                    TerminalKindV1::Failed("required_role_failed".to_string())
                } else {
                    TerminalKindV1::Completed
                };
                (
                    outcome.attempts,
                    outcome.reconciliation,
                    outcome.envelope,
                    outcome.accounting,
                    terminal,
                )
            } else if let Some(refusal) = inner.refusal {
                let attempts = fallback_attempts(&inner, refusal.as_str());
                let reconciliation = fallback_reconciliation(&inner, "route_refused");
                (
                    attempts,
                    reconciliation,
                    None,
                    TriageRunAccountingV1::default(),
                    TerminalKindV1::Failed(refusal.as_str().to_string()),
                )
            } else {
                let category = match &disposition {
                    TriageTurnDispositionV1::TurnError { category } => category.clone(),
                    TriageTurnDispositionV1::Completed => "contribution_route_silent".to_string(),
                };
                let attempts = fallback_attempts(&inner, "run_not_observed");
                let reconciliation = fallback_reconciliation(&inner, "not_observed");
                (
                    attempts,
                    reconciliation,
                    None,
                    TriageRunAccountingV1::default(),
                    TerminalKindV1::Failed(category),
                )
            };

        // A turn-level error outranks a completed-looking projection: the
        // deterministic work stays visible, but the terminal is a failure.
        let terminal = match (&disposition, terminal) {
            (TriageTurnDispositionV1::TurnError { category }, TerminalKindV1::Completed) => {
                TerminalKindV1::Failed(category.clone())
            }
            (_, terminal) => terminal,
        };

        for attempt in &attempts {
            let payload = TriageRunEventPayloadV2::RoleAttempt {
                attempt: attempt.clone(),
            };
            append_event(&mut inner, payload);
        }
        let payload = TriageRunEventPayloadV2::Reconciliation {
            summary: reconciliation.clone(),
        };
        append_event(&mut inner, payload);

        let completed_terminal = matches!(terminal, TerminalKindV1::Completed);
        let mut reason_codes: Vec<String> = attempts
            .iter()
            .flat_map(|attempt| attempt.reason_codes.iter().cloned())
            .collect();
        if let TerminalKindV1::Failed(category) = &terminal {
            reason_codes.push(category.clone());
        }
        let reason_codes = bounded_unique_codes(reason_codes);
        let payload = TriageRunEventPayloadV2::Validation {
            passed: completed_terminal,
            reason_codes: reason_codes.clone(),
        };
        append_event(&mut inner, payload);

        let accepted_evidence_ids = envelope
            .as_ref()
            .map(|envelope| {
                let mut ids: Vec<String> = envelope
                    .evidence
                    .iter()
                    .map(|row| row.evidence_id.clone())
                    .collect::<BTreeSet<_>>()
                    .into_iter()
                    .collect();
                ids.truncate(MAX_TRIAGE_EVIDENCE_IDS);
                ids
            })
            .unwrap_or_default();
        let result = TriageResultV2 {
            schema_id: TRIAGE_RESULT_SCHEMA_V2.into(),
            run_id: inner.identity.run_id.clone(),
            kind: if completed_terminal {
                TriageResultKind::GroundedFinal
            } else {
                TriageResultKind::HonestPartial
            },
            validation_state: if completed_terminal {
                TriageValidationState::Passed
            } else if envelope.is_some() {
                TriageValidationState::Partial
            } else {
                TriageValidationState::Failed
            },
            packet_id,
            reconciliation,
            answer: envelope,
            accepted_evidence_ids,
            reason_codes,
        };
        result.validate()?;

        let terminal_payload = match terminal {
            TerminalKindV1::Completed => TriageRunEventPayloadV2::Completed {
                result: Box::new(result.clone()),
            },
            TerminalKindV1::Failed(category) => TriageRunEventPayloadV2::Failed {
                category,
                partial_result: Some(Box::new(result.clone())),
            },
            TerminalKindV1::TimedOut => TriageRunEventPayloadV2::TimedOut {
                category: "deadline".into(),
                partial_result: Some(Box::new(result.clone())),
            },
            TerminalKindV1::Cancelled => TriageRunEventPayloadV2::Cancelled {
                cancellation_id: inner.identity.cancellation_id.clone(),
                partial_result: Some(Box::new(result.clone())),
            },
        };
        append_event(&mut inner, terminal_payload);

        let replay = TriageReplayV1 {
            schema_id: TRIAGE_REPLAY_SCHEMA_V1.into(),
            run_id: inner.identity.run_id.clone(),
            request_fingerprint: inner.identity.request_fingerprint.clone(),
            events: inner.events.clone(),
        };
        replay.validate()?;
        Ok(TriageRunLedgerOutcomeV1 {
            replay,
            result,
            accounting,
        })
    }
}

fn append_event(inner: &mut LedgerInner, payload: TriageRunEventPayloadV2) {
    let event = TriageRunEventV2 {
        schema_id: TRIAGE_RUN_EVENT_SCHEMA_V2.into(),
        run_id: inner.identity.run_id.clone(),
        sequence: inner.events.len() as u64,
        privacy: PacketPrivacyBoundary::OwnerOnly,
        event: payload,
    };
    if let Some(sink) = inner.sink.as_mut() {
        sink(&event);
    }
    inner.events.push(event);
}

fn availability_reason(
    availability: ContributionAvailability,
    degradation: Option<cd_core::multi_model::ContributionDegradationReason>,
) -> Option<&'static str> {
    degradation
        .map(cd_core::multi_model::ContributionDegradationReason::as_str)
        .or(match availability {
            ContributionAvailability::Completed => None,
            other => Some(other.as_str()),
        })
}

fn attempt_status(availability: ContributionAvailability, abstained: bool) -> TriageAttemptStatus {
    match availability {
        ContributionAvailability::Completed if abstained => TriageAttemptStatus::Abstained,
        ContributionAvailability::Completed => TriageAttemptStatus::Completed,
        ContributionAvailability::Unavailable => TriageAttemptStatus::Unavailable,
        ContributionAvailability::NotAdmitted => TriageAttemptStatus::NotAdmitted,
        ContributionAvailability::TimedOut => TriageAttemptStatus::TimedOut,
        ContributionAvailability::Cancelled => TriageAttemptStatus::Cancelled,
        ContributionAvailability::Malformed => TriageAttemptStatus::Invalid,
        ContributionAvailability::Failed => TriageAttemptStatus::Failed,
    }
}

fn bounded_unique_codes(codes: Vec<String>) -> Vec<String> {
    let mut unique = BTreeSet::new();
    let mut out: Vec<String> = codes
        .into_iter()
        .filter(|code| unique.insert(code.clone()))
        .collect();
    out.truncate(MAX_TRIAGE_REASON_CODES);
    out
}

/// Wire-safe subset of host id lists. Ids that violate the SDK's opaque-id
/// constraints are dropped (never rewritten); the caller records the drop.
fn safe_wire_ids(ids: impl IntoIterator<Item = String>) -> (Vec<String>, bool) {
    let mut dropped = false;
    let mut unique = BTreeSet::new();
    for id in ids {
        let valid = !id.trim().is_empty()
            && id.len() <= 512
            && !id.contains('/')
            && !id.contains('\\')
            && !id.contains("://")
            && !id.chars().any(char::is_control);
        if valid {
            unique.insert(id);
        } else {
            dropped = true;
        }
    }
    let mut out: Vec<String> = unique.into_iter().collect();
    if out.len() > MAX_TRIAGE_EVIDENCE_IDS {
        out.truncate(MAX_TRIAGE_EVIDENCE_IDS);
        dropped = true;
    }
    (out, dropped)
}

fn fallback_attempts(inner: &LedgerInner, reason: &'static str) -> Vec<TriageRoleAttemptV1> {
    let mut admitted_index = 0usize;
    inner
        .compiled
        .slots
        .iter()
        .map(|slot| {
            let observed = if slot.disposition == SlotDispositionV2::Admitted
                && matches!(slot.kind, TriageSlotKindV2::Contributor(_))
            {
                let stage = inner.stages.get(admitted_index).cloned().flatten();
                admitted_index += 1;
                stage
            } else {
                None
            };
            let (status, mut codes, elapsed_ms) = match (&slot.disposition, observed) {
                (SlotDispositionV2::Admitted, Some(stage)) => (
                    attempt_status(stage.availability, false),
                    stage
                        .reason
                        .map(|code| vec![code.to_string()])
                        .unwrap_or_default(),
                    stage.elapsed_ms,
                ),
                (SlotDispositionV2::Admitted, None) => (TriageAttemptStatus::Failed, Vec::new(), 0),
                _ => (
                    TriageAttemptStatus::NotAdmitted,
                    slot.rejections
                        .iter()
                        .map(|category| rejection_code(*category).to_string())
                        .collect(),
                    0,
                ),
            };
            codes.push(reason.to_string());
            TriageRoleAttemptV1 {
                attempt_id: format!("attempt:{}:{}", inner.identity.run_id, slot.slot_id),
                role_slot_id: slot.slot_id.clone(),
                role: slot.kind,
                model: Some(slot.model.clone()),
                status,
                reason_codes: bounded_unique_codes(codes),
                elapsed_ms,
                input_chars: 0,
                output_chars: 0,
            }
        })
        .collect()
}

fn fallback_reconciliation(inner: &LedgerInner, state: &str) -> TriageReconciliationV1 {
    TriageReconciliationV1 {
        state: state.to_string(),
        configured_role_slots: inner.compiled.slots.len() as u32,
        completed_role_slots: 0,
        distinct_models: 0,
        distinct_gateways: 0,
        supported_claim_ids: Vec::new(),
        conflict_ids: Vec::new(),
        gap_ids: Vec::new(),
        root_cause_established: false,
    }
}

impl ContributionRunObserverV1 for TriageRunLedgerV1 {
    fn packet_ready(&self, packet: &FastTriagePacketV1) {
        use sha2::{Digest, Sha256};
        let mut inner = self.lock();
        if inner.packet.is_some() {
            inner.poison.get_or_insert("duplicate_packet");
            return;
        }
        let mut hasher = Sha256::new();
        hasher.update(packet.manifest_json().as_bytes());
        let facts = PacketFactsV1 {
            packet_id: packet.packet_id().to_string(),
            packet_digest: format!("sha256:{:x}", hasher.finalize()),
            evidence_count: u32::try_from(packet.rows().len()).unwrap_or(u32::MAX),
        };
        let payload = TriageRunEventPayloadV2::PacketReady {
            packet_id: facts.packet_id.clone(),
            packet_digest: facts.packet_digest.clone(),
            evidence_count: facts.evidence_count,
        };
        inner.packet = Some(facts);
        append_event(&mut inner, payload);
    }

    fn stage(&self, event: &ContributionStageEvent) {
        let mut inner = self.lock();
        if inner.poison.is_some() {
            return;
        }
        let cursor = inner.stage_cursor;
        let Some(binding) = inner.bindings.get(cursor) else {
            inner.poison = Some("stage_overflow");
            return;
        };
        let matches_binding = event.role == binding.production_role
            && event.identity.profile_id == binding.model.profile_id
            && event.identity.model == binding.model.model_id;
        if !matches_binding {
            inner.poison = Some("stage_binding_mismatch");
            return;
        }
        if event.started {
            if inner.stage_started_at.is_some() {
                inner.poison = Some("stage_reentered");
                return;
            }
            inner.stage_started_at = Some(Instant::now());
            return;
        }
        let elapsed_ms = inner
            .stage_started_at
            .take()
            .map(|started| u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX))
            .unwrap_or(0);
        let Some(outcome) = event.outcome else {
            inner.poison = Some("stage_finished_without_outcome");
            return;
        };
        inner.stages[cursor] = Some(ObservedStageV1 {
            availability: outcome,
            reason: availability_reason(outcome, event.degradation),
            elapsed_ms,
        });
        inner.stage_cursor += 1;
    }

    fn outcome(&self, outcome: &ContributionPipelineOutcome) {
        let mut inner = self.lock();
        if inner.poison.is_some() {
            return;
        }
        if inner.outcome.is_some() {
            inner.poison = Some("duplicate_outcome");
            return;
        }
        if outcome.attempts.len() != inner.bindings.len()
            || outcome.telemetry.stages.len() != inner.bindings.len()
        {
            inner.poison = Some("outcome_arity_mismatch");
            return;
        }

        let mut provider_calls = 0u32;
        let mut context_chars = 0u64;
        let mut output_chars = 0u64;
        let mut admitted: Vec<TriageRoleAttemptV1> = Vec::with_capacity(inner.bindings.len());
        let mut admitted_gap_counts: Vec<usize> = Vec::with_capacity(inner.bindings.len());
        for (index, ((attempt, stage), binding)) in outcome
            .attempts
            .iter()
            .zip(&outcome.telemetry.stages)
            .zip(&inner.bindings)
            .enumerate()
        {
            let attempt_matches = attempt.role == binding.production_role
                && attempt.identity.profile_id == binding.model.profile_id
                && attempt.identity.model == binding.model.model_id;
            let stage_matches = stage.role == binding.production_role
                && stage.profile_id == binding.model.profile_id
                && stage.model == binding.model.model_id;
            if !attempt_matches || !stage_matches {
                inner.poison = Some("outcome_binding_mismatch");
                return;
            }
            provider_calls = provider_calls.saturating_add(stage.provider_rounds);
            context_chars = context_chars.saturating_add(stage.context_chars_sent);
            output_chars = output_chars.saturating_add(stage.output_chars);
            let abstained = attempt
                .contribution
                .as_ref()
                .is_some_and(|contribution| contribution.abstained);
            admitted_gap_counts.push(
                attempt
                    .contribution
                    .as_ref()
                    .map(|contribution| contribution.evidence_gaps.len())
                    .unwrap_or(0),
            );
            let elapsed_ms = inner
                .stages
                .get(index)
                .and_then(|stage| stage.as_ref().map(|stage| stage.elapsed_ms))
                .unwrap_or(0);
            let reason = availability_reason(attempt.availability, stage.degradation);
            admitted.push(TriageRoleAttemptV1 {
                attempt_id: format!("attempt:{}:{}", inner.identity.run_id, binding.slot_id),
                role_slot_id: binding.slot_id.clone(),
                role: TriageSlotKindV2::Contributor(v2_role(binding.production_role)),
                model: Some(binding.model.clone()),
                status: attempt_status(attempt.availability, abstained),
                reason_codes: bounded_unique_codes(
                    reason
                        .map(|code| vec![code.to_string()])
                        .unwrap_or_default(),
                ),
                elapsed_ms,
                input_chars: stage.context_chars_sent,
                output_chars: stage.output_chars,
            });
        }

        // Cross-check the physical-call ceiling the compiler admitted. The
        // pipeline enforces it independently; a disagreement here means the
        // projection can no longer be trusted.
        if provider_calls > inner.compiled.budget.contributors.max_provider_calls
            || provider_calls > inner.compiled.budget.max_provider_calls
        {
            inner.poison = Some("provider_call_budget_exceeded");
            return;
        }

        // Merge admitted attempts back into full configured-slot order, with
        // degraded slots as explicit non-admitted attempts.
        let mut admitted_iter = admitted.into_iter();
        let mut attempts = Vec::with_capacity(inner.compiled.slots.len());
        for slot in &inner.compiled.slots {
            if slot.disposition == SlotDispositionV2::Admitted
                && matches!(slot.kind, TriageSlotKindV2::Contributor(_))
            {
                let Some(next) = admitted_iter.next() else {
                    inner.poison = Some("admitted_slot_uncovered");
                    return;
                };
                if next.role_slot_id != slot.slot_id {
                    inner.poison = Some("admitted_slot_order_mismatch");
                    return;
                }
                attempts.push(next);
            } else {
                attempts.push(TriageRoleAttemptV1 {
                    attempt_id: format!("attempt:{}:{}", inner.identity.run_id, slot.slot_id),
                    role_slot_id: slot.slot_id.clone(),
                    role: slot.kind,
                    model: Some(slot.model.clone()),
                    status: TriageAttemptStatus::NotAdmitted,
                    reason_codes: bounded_unique_codes(
                        slot.rejections
                            .iter()
                            .map(|category| rejection_code(*category).to_string())
                            .collect(),
                    ),
                    elapsed_ms: 0,
                    input_chars: 0,
                    output_chars: 0,
                });
            }
        }
        if admitted_iter.next().is_some() {
            inner.poison = Some("admitted_slot_overflow");
            return;
        }

        let completed: Vec<&TriageRoleAttemptV1> = attempts
            .iter()
            .filter(|attempt| attempt.status == TriageAttemptStatus::Completed)
            .collect();
        let models: BTreeSet<&ModelRef> =
            completed.iter().filter_map(|a| a.model.as_ref()).collect();
        let gateways: BTreeSet<&str> = models
            .iter()
            .map(|model| model.profile_id.as_str())
            .collect();
        let (supported_claim_ids, dropped_claims) = safe_wire_ids(
            outcome
                .report
                .claims
                .iter()
                .map(|claim| claim.candidate_id.clone()),
        );
        let (conflict_ids, dropped_conflicts) = safe_wire_ids(
            outcome
                .report
                .conflicts
                .iter()
                .map(|conflict| conflict.candidate_id.clone()),
        );
        // Gap identities are host-derived and index-aligned with the exact
        // slot bindings: model-authored gap labels never become ledger
        // identity, and same-model slots cannot swap attribution.
        let gap_ids = inner
            .bindings
            .iter()
            .zip(&admitted_gap_counts)
            .flat_map(|(binding, gaps)| {
                (0..*gaps).map(move |index| format!("gap:{}:{index}", binding.slot_id))
            })
            .collect::<Vec<_>>();
        let (gap_ids, _) = safe_wire_ids(gap_ids);

        let mut reconciliation = TriageReconciliationV1 {
            state: outcome.report.state.as_str().to_string(),
            configured_role_slots: inner.compiled.slots.len() as u32,
            completed_role_slots: completed.len() as u32,
            distinct_models: models.len() as u32,
            distinct_gateways: gateways.len() as u32,
            supported_claim_ids,
            conflict_ids,
            gap_ids,
            root_cause_established: outcome.report.root_cause_established,
        };
        if reconciliation.root_cause_established {
            // The contributor subset can never establish root cause; a report
            // claiming so is a projection fault, not an answer upgrade.
            inner.poison = Some("unexpected_root_cause_claim");
            return;
        }
        if dropped_claims || dropped_conflicts {
            reconciliation.state = format!("{}_ids_bounded", reconciliation.state);
        }

        inner.outcome = Some(ProjectedOutcomeV1 {
            attempts,
            reconciliation,
            envelope: Some((*outcome.envelope).clone()),
            accounting: TriageRunAccountingV1 {
                provider_calls,
                correction_calls: 0,
                context_chars_sent: context_chars,
                output_chars,
            },
        });
    }

    fn route_refused(&self, refusal: ContributionRouteRefusalV1) {
        let mut inner = self.lock();
        if inner.refusal.is_none() {
            inner.refusal = Some(refusal);
        }
    }
}

fn v2_role(
    role: cd_core::multi_model::ContributionRole,
) -> cd_core::multi_model::triage_policy::TriageContributorRole {
    use cd_core::multi_model::triage_policy::TriageContributorRole as V2;
    use cd_core::multi_model::ContributionRole as V1;
    match role {
        V1::ObservationExtractor => V2::ObservationExtractor,
        V1::CausalProposer => V2::CausalProposer,
        V1::ContradictionChecker => V2::ContradictionChecker,
        V1::EvidenceGap => V2::EvidenceGapFinder,
        // The adapter never binds a legacy reviewer slot; mapping it to a
        // contributor role would misattribute review work.
        V1::Reviewer => unreachable!("legacy reviewer is never a V2 contributor binding"),
    }
}

/// Share-safe projection of one owner-only run.
#[derive(Debug, Clone)]
pub struct ShareSafeTriageProjectionV1 {
    /// Non-terminal events re-labelled share-safe, each re-validated. Events
    /// that cannot be made share-safe are dropped, never rewritten.
    pub events: Vec<TriageRunEventV2>,
    /// Metadata-only terminal projection, scan-validated.
    pub result: cd_core::triage_sdk::ShareSafeTriageResultV2,
    /// Count of owner-only events dropped from the share-safe stream.
    pub dropped_events: u32,
}

/// Project an owner-only replay into its share-safe form.
///
/// Terminal events (which may embed owner-only results) are always dropped;
/// role attempts lose their exact model identity; every retained event and
/// the result summary are re-validated, including the forbidden-substring
/// scan. Failure to produce a valid share-safe result is an error, not a
/// silent downgrade.
pub fn share_safe_projection(
    replay: &TriageReplayV1,
    result: &TriageResultV2,
) -> Result<ShareSafeTriageProjectionV1, TriageContractError> {
    let mut events = Vec::new();
    let mut dropped = 0u32;
    for event in &replay.events {
        if event.event.is_terminal() {
            dropped += 1;
            continue;
        }
        let mut share_safe = event.clone();
        share_safe.privacy = PacketPrivacyBoundary::ShareSafe;
        if let TriageRunEventPayloadV2::RoleAttempt { attempt } = &mut share_safe.event {
            attempt.model = None;
        }
        if share_safe.validate().is_ok() {
            events.push(share_safe);
        } else {
            dropped += 1;
        }
    }
    let summary = result.share_safe_summary();
    summary.validate()?;
    Ok(ShareSafeTriageProjectionV1 {
        events,
        result: summary,
        dropped_events: dropped,
    })
}

/// Everything one policy-bound linked turn produced.
pub struct TriagePolicyRunOutcomeV1 {
    /// Validated replay, terminal result, and accounting from the ledger.
    pub ledger: TriageRunLedgerOutcomeV1,
    /// The raw host stream events of the underlying turn (progress, tools,
    /// rendered text). Owner-only; hosts may render them as today.
    pub events: Vec<StreamEvent>,
    /// Exact slot bindings used by the production runtime.
    pub bindings: Vec<V2ContributionSlotBindingV1>,
    /// The whole-turn deadline the run actually enforced.
    pub effective_deadline_ms: u64,
    /// The turn disposition observed by the runner.
    pub disposition: TriageTurnDispositionV1,
}

/// Run one Enhanced/Advanced contributor-subset policy on the production
/// linked-turn path, projecting the shared V2 event ledger.
///
/// The caller supplies already-resolved host state: the tool host, the main
/// turn inputs (used for host plumbing only — strict policy binding refuses
/// every provider path outside the admitted contributor backends), the
/// cache root for corpus binding, and the resolver output. Standard-mode
/// policies are refused by the adapter (`standard_uses_established_path`):
/// the established single-model route remains authoritative for Standard.
#[allow(clippy::too_many_arguments)]
pub async fn run_triage_policy_v2_linked_turn(
    host: &mut ToolHost,
    resolved_turn: &ResolvedTurnInputs,
    cache_root: &Path,
    request: &TriageRequestV2,
    policy: &TriagePolicyV2,
    resolved_policy: ResolvedTriagePolicyV2,
    host_context_char_budget: usize,
    neighborhood: FastTriageNeighborhoodBudget,
    cancel: Option<Arc<AtomicBool>>,
    mut live: Option<&mut (dyn FnMut(StreamEvent) + Send)>,
    ledger_sink: Option<TriageRunEventSinkV1>,
) -> Result<TriagePolicyRunOutcomeV1, TriagePolicyRunErrorV1> {
    request
        .validate()
        .map_err(TriagePolicyRunErrorV1::Contract)?;
    let effective = effective_policy_with_overrides(policy, &request.overrides)?;
    let request_fingerprint = cd_core::triage_sdk::request_fingerprint_v2(request)
        .map_err(TriagePolicyRunErrorV1::Contract)?;
    let policy_fingerprint = cd_core::triage_sdk::policy_fingerprint_v2(policy)
        .map_err(TriagePolicyRunErrorV1::Contract)?;

    // The effective whole-turn deadline: the policy's explicit deadline (with
    // overrides already applied) or the host's resolved turn budget.
    let effective_deadline_ms = effective
        .budget
        .whole_turn_deadline_ms
        .unwrap_or(resolved_turn.deadline_plan.total_ms)
        .max(1);

    let prepared: PreparedV2ContributionRuntimeV1 =
        prepare_v2_contribution_runtime_with_projection(
            &effective,
            &resolved_policy.preflight,
            resolved_policy.backends,
            effective_deadline_ms,
            host_context_char_budget,
            neighborhood,
            V2ProjectionCapabilitiesV1 {
                represents_optional_dropout: true,
            },
        )
        .map_err(TriagePolicyRunErrorV1::Adapter)?;

    let identity = TriageRunIdentityV1 {
        run_id: request.run_id.clone(),
        request_fingerprint,
        policy_fingerprint,
        cancellation_id: request.cancellation_id.clone(),
    };
    let ledger = TriageRunLedgerV1::new(
        identity,
        prepared.compiled.clone(),
        prepared.bindings.clone(),
    );
    if let Some(sink) = ledger_sink {
        ledger.set_event_sink(sink);
    }
    ledger.start();

    let mut runtime = prepared.runtime;
    runtime.policy_binding = Some(ContributionPolicyBindingV1 {
        observer: ledger.clone(),
    });

    // Enforce the effective deadline on the host clock the turn actually
    // reads, then restore the caller's budget afterwards.
    let previous_budget = host.router_budget().clone();
    let mut run_budget = previous_budget.clone();
    run_budget.deadline_ms = effective_deadline_ms;
    run_budget.deadline_is_explicit = true;
    host.set_router_budget(run_budget);

    let binding = match bind_linked_corpus(host, cache_root, &request.scope.corpus_id) {
        Ok(binding) => binding,
        Err(_) => {
            host.set_router_budget(previous_budget);
            let ledger_outcome = ledger
                .finalize(TriageTurnDispositionV1::TurnError {
                    category: "corpus_unavailable".into(),
                })
                .map_err(TriagePolicyRunErrorV1::Ledger)?;
            return Ok(TriagePolicyRunOutcomeV1 {
                ledger: ledger_outcome,
                events: Vec::new(),
                bindings: prepared.bindings,
                effective_deadline_ms,
                disposition: TriageTurnDispositionV1::TurnError {
                    category: "corpus_unavailable".into(),
                },
            });
        }
    };
    let context = match LogExplorerTurnContext::for_main_chat(&request.scope.corpus_id) {
        Ok(context) => context,
        Err(_) => {
            unbind_linked_corpus(host, binding);
            host.set_router_budget(previous_budget);
            let ledger_outcome = ledger
                .finalize(TriageTurnDispositionV1::TurnError {
                    category: "corpus_context_invalid".into(),
                })
                .map_err(TriagePolicyRunErrorV1::Ledger)?;
            return Ok(TriagePolicyRunOutcomeV1 {
                ledger: ledger_outcome,
                events: Vec::new(),
                bindings: prepared.bindings,
                effective_deadline_ms,
                disposition: TriageTurnDispositionV1::TurnError {
                    category: "corpus_context_invalid".into(),
                },
            });
        }
    };

    let mut history: Vec<ChatMessage> = Vec::new();
    let session_id = format!("triage-policy:{}", request.run_id);
    let turn = run_turn(
        host,
        resolved_turn,
        &request.task,
        &mut history,
        &session_id,
        TurnExecutionOptions {
            turn_id: Some(format!("triage:{}", request.run_id)),
            context: Some(context),
            cancel,
            contribution_runtime: Some(runtime),
            ..TurnExecutionOptions::default()
        },
        live.take(),
        None,
    )
    .await;
    unbind_linked_corpus(host, binding);
    host.set_router_budget(previous_budget);

    let (events, disposition) = match turn {
        Ok(events) => (events, TriageTurnDispositionV1::Completed),
        Err(error) => (
            Vec::new(),
            TriageTurnDispositionV1::TurnError {
                category: turn_error_category(&error).to_string(),
            },
        ),
    };
    let ledger_outcome = ledger
        .finalize(disposition.clone())
        .map_err(TriagePolicyRunErrorV1::Ledger)?;
    Ok(TriagePolicyRunOutcomeV1 {
        ledger: ledger_outcome,
        events,
        bindings: prepared.bindings,
        effective_deadline_ms,
        disposition,
    })
}

/// Content-free class for a turn-level error. Provider text never enters
/// the ledger.
fn turn_error_category(error: &cd_core::error::CoreError) -> &'static str {
    use cd_core::error::CoreError;
    match error {
        CoreError::Policy(_) => "turn_policy_error",
        CoreError::Message(_) => "turn_error",
        _ => "turn_error",
    }
}

/// Convenience wrapper: resolve, then run, in one call, for hosts that do
/// not need to inspect preflight facts between the two steps.
#[allow(clippy::too_many_arguments)]
pub async fn resolve_and_run_triage_policy_v2(
    host: &mut ToolHost,
    cfg: &AppConfig,
    credentials: &TurnProviderCredentialCache<'_>,
    qualification_store: Option<&QualificationStore>,
    resolved_turn: &ResolvedTurnInputs,
    cache_root: &Path,
    request: &TriageRequestV2,
    policy: &TriagePolicyV2,
    host_context_char_budget: usize,
    neighborhood: FastTriageNeighborhoodBudget,
    cancel: Option<Arc<AtomicBool>>,
    live: Option<&mut (dyn FnMut(StreamEvent) + Send)>,
    ledger_sink: Option<TriageRunEventSinkV1>,
) -> Result<TriagePolicyRunOutcomeV1, TriagePolicyRunErrorV1> {
    let effective = effective_policy_with_overrides(policy, &request.overrides)?;
    let resolved_policy =
        resolve_triage_policy_v2(cfg, credentials, qualification_store, &effective).await;
    run_triage_policy_v2_linked_turn(
        host,
        resolved_turn,
        cache_root,
        request,
        policy,
        resolved_policy,
        host_context_char_budget,
        neighborhood,
        cancel,
        live,
        ledger_sink,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use cd_core::config::AppConfig;
    use cd_core::keychain_store::SecretStore;
    use cd_core::multi_model::triage_policy::{
        ContributorSlotV2, RoleRequirement, TriageBudgetV2, TriageContributorRole,
        TriagePolicyMode, TRIAGE_POLICY_SCHEMA_V2,
    };
    use cd_core::providers::ProviderConfig;

    struct NoSecrets;
    impl SecretStore for NoSecrets {
        fn get(&self, _reference: &str) -> cd_core::error::CoreResult<Option<String>> {
            Ok(None)
        }

        fn set(&self, _reference: &str, _value: &str) -> cd_core::error::CoreResult<()> {
            Ok(())
        }

        fn delete(&self, _reference: &str) -> cd_core::error::CoreResult<()> {
            Ok(())
        }
    }

    fn local_cfg() -> AppConfig {
        AppConfig {
            providers: ProviderConfig::with_local_ollama(),
            ..AppConfig::default()
        }
    }

    fn slot(profile_id: &str, model_id: &str) -> ContributorSlotV2 {
        ContributorSlotV2 {
            slot_id: "observe".into(),
            role: TriageContributorRole::ObservationExtractor,
            model: ModelRef {
                profile_id: profile_id.into(),
                model_id: model_id.into(),
            },
            requirement: RoleRequirement::Required,
            allow_remote: false,
        }
    }

    fn enhanced(contributor: ContributorSlotV2) -> TriagePolicyV2 {
        TriagePolicyV2 {
            schema_id: TRIAGE_POLICY_SCHEMA_V2.into(),
            mode: TriagePolicyMode::Enhanced,
            contributors: vec![contributor],
            finalizer: None,
            reviewer: None,
            budget: TriageBudgetV2::default(),
            execution: Default::default(),
        }
    }

    #[tokio::test]
    async fn unresolvable_profile_is_an_unavailable_fact_not_a_substitution() {
        let cfg = local_cfg();
        let secrets = NoSecrets;
        let credentials = TurnProviderCredentialCache::new(&secrets);
        let policy = enhanced(slot("no-such-profile", "some-model"));
        let resolved = resolve_triage_policy_v2(&cfg, &credentials, None, &policy).await;
        assert_eq!(resolved.preflight.roles.len(), 1);
        let fact = &resolved.preflight.roles[0];
        assert!(!fact.available);
        assert_eq!(fact.qualification, RoleQualificationV2::Unverified);
        assert_eq!(
            fact.model.profile_id, "no-such-profile",
            "the declared identity is echoed, never replaced"
        );
        assert!(resolved.backends.is_empty(), "no backend without admission");
    }

    #[tokio::test]
    async fn observed_model_divergence_surfaces_for_the_compiler_to_reject() {
        let cfg = local_cfg();
        let profile_id = cfg.providers.profiles[0].id.clone();
        let secrets = NoSecrets;
        let credentials = TurnProviderCredentialCache::new(&secrets);
        // The declared model is empty-string-like nonsense the profile cannot
        // serve; host resolution reports what it actually observed.
        let policy = enhanced(slot(&profile_id, ""));
        let resolved = resolve_triage_policy_v2(&cfg, &credentials, None, &policy).await;
        let fact = &resolved.preflight.roles[0];
        assert_eq!(fact.model.profile_id, profile_id);
        assert_ne!(
            fact.model.model_id, "",
            "resolution reports the observed chat model"
        );
        // The exact-binding mismatch must fail compilation, never substitute.
        assert!(crate::triage::compile_preflight(&policy, &resolved.preflight).is_err());
        assert!(resolved.backends.is_empty());
    }

    #[tokio::test]
    async fn missing_qualification_evidence_is_unverified_and_blocks_admission() {
        let cfg = local_cfg();
        let profile_id = cfg.providers.profiles[0].id.clone();
        let model_id = cfg.providers.profiles[0].chat_model.clone();
        let secrets = NoSecrets;
        let credentials = TurnProviderCredentialCache::new(&secrets);
        let policy = enhanced(slot(&profile_id, &model_id));
        let resolved = resolve_triage_policy_v2(&cfg, &credentials, None, &policy).await;
        let fact = &resolved.preflight.roles[0];
        assert_eq!(fact.qualification, RoleQualificationV2::Unverified);
        assert!(
            resolved.backends.is_empty(),
            "an unverified role is never admitted, so no backend is authorized"
        );
        assert!(crate::triage::compile_preflight(&policy, &resolved.preflight).is_err());
    }

    #[test]
    fn overrides_narrow_but_never_extend_policy_bounds() {
        let mut policy = enhanced(slot("p", "m"));
        policy.budget.whole_turn_deadline_ms = Some(60_000);
        let narrowed = effective_policy_with_overrides(
            &policy,
            &TriageRequestOverridesV1 {
                deadline_ms: Some(30_000),
                max_provider_calls: Some(policy.budget.max_provider_calls),
            },
        )
        .expect("narrowing is allowed");
        assert_eq!(narrowed.budget.whole_turn_deadline_ms, Some(30_000));

        let extended = effective_policy_with_overrides(
            &policy,
            &TriageRequestOverridesV1 {
                deadline_ms: Some(120_000),
                max_provider_calls: None,
            },
        );
        assert!(matches!(
            extended,
            Err(TriagePolicyRunErrorV1::OverrideExtendsPolicy {
                field: "deadline_ms"
            })
        ));

        let more_calls = effective_policy_with_overrides(
            &policy,
            &TriageRequestOverridesV1 {
                deadline_ms: None,
                max_provider_calls: Some(policy.budget.max_provider_calls + 1),
            },
        );
        assert!(matches!(
            more_calls,
            Err(TriagePolicyRunErrorV1::OverrideExtendsPolicy {
                field: "max_provider_calls"
            })
        ));
    }

    #[test]
    fn wire_ids_fail_closed_on_path_shaped_identifiers() {
        let (ids, dropped) = safe_wire_ids(vec![
            "candidate-a".to_string(),
            "../../etc/passwd".to_string(),
            "candidate-a".to_string(),
        ]);
        assert_eq!(ids, vec!["candidate-a".to_string()]);
        assert!(dropped);
    }

    #[test]
    fn seam_has_no_host_runtime_imports() {
        let source = include_str!("triage_run.rs");
        let forbidden_imports = [
            "use tauri",
            "use keyring",
            "use keychain",
            "use std::fs",
            "use tokio::fs",
            "use crate::config",
            "use crate::app_config",
        ];
        assert!(source.lines().all(|line| {
            let code = line.split("//").next().unwrap_or_default().trim_start();
            forbidden_imports
                .iter()
                .all(|prefix| !code.starts_with(prefix))
        }));
    }
}
