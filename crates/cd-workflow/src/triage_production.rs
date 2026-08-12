//! Trusted-host adapter from Triage Policy V2 to the established contribution runtime.
//!
//! This is intentionally a **subset** adapter. It prepares the existing
//! [`cd_core::agent::ContributionRuntime`] only when every V2 semantic can be
//! preserved by that runtime. The existing linked-triage path then continues
//! to own packet assembly, provider execution, cancellation, stage events,
//! deterministic reconciliation, rendering, and cleanup.
//!
//! The adapter never reads configuration or credentials, constructs an HTTP
//! client, performs retrieval, or calls a provider. A trusted Rust host must
//! supply exact already-authorized backends after qualification and egress
//! preflight. Unsupported V2 roles fail with a typed, content-free rejection
//! before any backend can be returned.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use cd_core::agent::{ChatBackend, ContributionRuntime};
use cd_core::fast_triage::FastTriageNeighborhoodBudget;
use cd_core::model_ref::ModelRef;
use cd_core::multi_model::triage_policy::{
    CompiledRoleSlotV2, CompiledTriagePolicyV2, SlotDispositionV2, TriageContributorRole,
    TriagePolicyCompileFailureV2, TriagePolicyMode, TriagePolicyPreflightV2, TriagePolicyV2,
    TriageSlotKindV2,
};
use cd_core::multi_model::{
    ContributionBackendSlot, ContributionIdentity, ContributionQualification, ContributionRole,
    ContributionRoutingPlan, ContributionRoutingPolicy, MultiModelBudget,
};

use crate::triage::compile_preflight;

/// Exact backend binding resolved and authorized by the trusted Rust host.
///
/// The backend is opaque to the adapter. The host remains responsible for
/// profile lookup, credential resolution, endpoint/dialect selection,
/// qualification freshness, and egress authorization before constructing it.
#[derive(Clone)]
pub struct AuthorizedTriageBackendV1 {
    /// Exact policy slot identity.
    pub slot_id: String,
    /// Exact provider-profile and catalog-model identity.
    pub model: ModelRef,
    /// Existing production chat backend.
    pub backend: Arc<dyn ChatBackend>,
}

impl std::fmt::Debug for AuthorizedTriageBackendV1 {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AuthorizedTriageBackendV1")
            .field("slot_id", &self.slot_id)
            .field("model", &self.model)
            .finish_non_exhaustive()
    }
}

/// Content-free reason the current production contribution runtime cannot
/// preserve an exact V2 policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TriageProductionAdapterRejectionV1 {
    /// Standard is deliberately left on the established single-model path.
    StandardUsesEstablishedPath,
    /// This slice requires at least one admitted contributor.
    NoAdmittedContributors,
    /// The legacy contribution schema has no timeline-analyst role.
    TimelineAnalystUnsupported,
    /// The legacy contribution route has no separately qualified finalizer.
    FinalizerUnsupported,
    /// V2 reviewer condition/requirement/reserve semantics are not equivalent.
    ReviewerUnsupported,
    /// A configured optional role was degraded and cannot yet be represented
    /// in the production contribution event stream without being omitted.
    DegradedSlotUnsupported,
    /// The host supplied no finite positive whole-turn deadline.
    InvalidHostDeadline,
    /// An explicit V2 whole-turn deadline differs from the host-resolved one.
    WholeTurnDeadlineMismatch,
    /// The established route cannot enforce a smaller per-contributor cap yet.
    ContributorOperationCapUnsupported,
    /// The host supplied no usable per-call context allowance.
    InvalidHostContextBudget,
    /// More than one backend binding named the same slot.
    DuplicateBackendSlot,
    /// The backend set does not exactly cover the admitted contributor slots.
    BackendSetMismatch,
    /// A backend slot is bound to a different exact ModelRef.
    BackendBindingMismatch,
    /// A V2 bound cannot be represented by the current platform `usize`.
    BudgetNotRepresentable,
    /// The mapped legacy routing plan rejected its own bounds.
    RoutingPlanRejected,
}

impl TriageProductionAdapterRejectionV1 {
    /// Stable machine label for logs, CLI, and later SDK projection.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::StandardUsesEstablishedPath => "standard_uses_established_path",
            Self::NoAdmittedContributors => "no_admitted_contributors",
            Self::TimelineAnalystUnsupported => "timeline_analyst_unsupported",
            Self::FinalizerUnsupported => "finalizer_unsupported",
            Self::ReviewerUnsupported => "reviewer_unsupported",
            Self::DegradedSlotUnsupported => "degraded_slot_unsupported",
            Self::InvalidHostDeadline => "invalid_host_deadline",
            Self::WholeTurnDeadlineMismatch => "whole_turn_deadline_mismatch",
            Self::ContributorOperationCapUnsupported => "contributor_operation_cap_unsupported",
            Self::InvalidHostContextBudget => "invalid_host_context_budget",
            Self::DuplicateBackendSlot => "duplicate_backend_slot",
            Self::BackendSetMismatch => "backend_set_mismatch",
            Self::BackendBindingMismatch => "backend_binding_mismatch",
            Self::BudgetNotRepresentable => "budget_not_representable",
            Self::RoutingPlanRejected => "routing_plan_rejected",
        }
    }
}

/// Typed failure before provider execution. Policy compiler failures retain
/// their complete slot dispositions; adapter failures identify only inert
/// slot ids and a stable category.
#[derive(Debug, Clone)]
pub enum TriageProductionAdapterErrorV1 {
    /// Pure V2 compilation/preflight failed.
    Policy(TriagePolicyCompileFailureV2),
    /// The compiled policy exceeds the current production subset.
    Unsupported {
        /// Stable content-free category.
        category: TriageProductionAdapterRejectionV1,
        /// Relevant host-authored slot ids, sorted and deduplicated.
        slot_ids: Vec<String>,
    },
}

impl std::fmt::Display for TriageProductionAdapterErrorV1 {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.category())
    }
}

impl std::error::Error for TriageProductionAdapterErrorV1 {}

impl TriageProductionAdapterErrorV1 {
    fn unsupported(
        category: TriageProductionAdapterRejectionV1,
        slot_ids: impl IntoIterator<Item = String>,
    ) -> Self {
        let mut slot_ids = slot_ids.into_iter().collect::<Vec<_>>();
        slot_ids.sort();
        slot_ids.dedup();
        Self::Unsupported { category, slot_ids }
    }

    /// Stable category independent of model/provider prose.
    pub fn category(&self) -> &'static str {
        match self {
            Self::Policy(_) => "policy_preflight_rejected",
            Self::Unsupported { category, .. } => category.as_str(),
        }
    }
}

/// Exact slot mapping retained beside the existing runtime for host telemetry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V2ContributionSlotBindingV1 {
    /// Exact V2 slot identity.
    pub slot_id: String,
    /// Exact V2 model identity.
    pub model: ModelRef,
    /// Existing production role used for this subset.
    pub production_role: ContributionRole,
}

/// Prepared default-off bridge into the existing linked contribution path.
///
/// Supplying `runtime` to the established linked-turn options does not create
/// another packet, HTTP, retrieval, renderer, cancellation, event, or cleanup
/// path. `compiled` and `bindings` let a future V2 event projector retain exact
/// policy accounting without reconstructing identity from model output.
#[derive(Debug, Clone)]
pub struct PreparedV2ContributionRuntimeV1 {
    /// Exact pure-compiler output used for admission.
    pub compiled: CompiledTriagePolicyV2,
    /// Existing production runtime consumed by the linked triage path.
    pub runtime: ContributionRuntime,
    /// Deterministic exact slot-to-production-role bindings.
    pub bindings: Vec<V2ContributionSlotBindingV1>,
}

/// What the caller's event projection can represent for one prepared run.
///
/// The established production contribution event stream cannot show a
/// configured-but-not-admitted slot, so the plain adapter refuses degraded
/// optional slots. A caller that owns a V2 event ledger emitting one explicit
/// `role_attempt` for every configured slot — dropout included — may declare
/// that here and keep visibly degraded optional slots inert instead.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct V2ProjectionCapabilitiesV1 {
    /// The caller accounts every configured slot, including optional dropout,
    /// in its own explicit V2 event stream.
    pub represents_optional_dropout: bool,
}

/// Compile and adapt the exact V2 contributor-only subset to the established
/// production contribution runtime.
///
/// `host_turn_deadline_ms` and `host_context_char_budget` must be the already
/// resolved values the linked turn will actually enforce. The current runtime
/// has only a whole-turn clock, so a smaller V2 per-contributor operation cap
/// is rejected rather than silently ignored.
#[allow(clippy::too_many_arguments)]
pub fn prepare_v2_contribution_runtime(
    policy: &TriagePolicyV2,
    preflight: &TriagePolicyPreflightV2,
    authorized_backends: Vec<AuthorizedTriageBackendV1>,
    host_turn_deadline_ms: u64,
    host_context_char_budget: usize,
    neighborhood: FastTriageNeighborhoodBudget,
) -> Result<PreparedV2ContributionRuntimeV1, TriageProductionAdapterErrorV1> {
    prepare_v2_contribution_runtime_with_projection(
        policy,
        preflight,
        authorized_backends,
        host_turn_deadline_ms,
        host_context_char_budget,
        neighborhood,
        V2ProjectionCapabilitiesV1::default(),
    )
}

/// [`prepare_v2_contribution_runtime`] with explicit projection capabilities.
///
/// With `represents_optional_dropout`, an optional slot the pure compiler
/// degraded stays configured-and-inert: it receives no backend and never
/// runs, and the caller's ledger must account it as an explicit non-admitted
/// role attempt. Admitted slots keep the exact same contributor-only subset
/// rules in every mode.
#[allow(clippy::too_many_arguments)]
pub fn prepare_v2_contribution_runtime_with_projection(
    policy: &TriagePolicyV2,
    preflight: &TriagePolicyPreflightV2,
    authorized_backends: Vec<AuthorizedTriageBackendV1>,
    host_turn_deadline_ms: u64,
    host_context_char_budget: usize,
    neighborhood: FastTriageNeighborhoodBudget,
    projection: V2ProjectionCapabilitiesV1,
) -> Result<PreparedV2ContributionRuntimeV1, TriageProductionAdapterErrorV1> {
    let compiled =
        compile_preflight(policy, preflight).map_err(TriageProductionAdapterErrorV1::Policy)?;

    if compiled.mode == TriagePolicyMode::Standard {
        return Err(TriageProductionAdapterErrorV1::unsupported(
            TriageProductionAdapterRejectionV1::StandardUsesEstablishedPath,
            std::iter::empty(),
        ));
    }
    if host_turn_deadline_ms == 0 {
        return Err(TriageProductionAdapterErrorV1::unsupported(
            TriageProductionAdapterRejectionV1::InvalidHostDeadline,
            std::iter::empty(),
        ));
    }
    if compiled
        .budget
        .whole_turn_deadline_ms
        .is_some_and(|deadline| deadline != host_turn_deadline_ms)
    {
        return Err(TriageProductionAdapterErrorV1::unsupported(
            TriageProductionAdapterRejectionV1::WholeTurnDeadlineMismatch,
            std::iter::empty(),
        ));
    }
    if compiled.budget.contributors.operation_timeout_ms < host_turn_deadline_ms {
        return Err(TriageProductionAdapterErrorV1::unsupported(
            TriageProductionAdapterRejectionV1::ContributorOperationCapUnsupported,
            contributor_slot_ids(&compiled),
        ));
    }
    if host_context_char_budget == 0 {
        return Err(TriageProductionAdapterErrorV1::unsupported(
            TriageProductionAdapterRejectionV1::InvalidHostContextBudget,
            std::iter::empty(),
        ));
    }

    let degraded = compiled
        .slots
        .iter()
        .filter(|slot| slot.disposition != SlotDispositionV2::Admitted)
        .map(|slot| slot.slot_id.clone())
        .collect::<Vec<_>>();
    if !degraded.is_empty() && !projection.represents_optional_dropout {
        return Err(TriageProductionAdapterErrorV1::unsupported(
            TriageProductionAdapterRejectionV1::DegradedSlotUnsupported,
            degraded,
        ));
    }

    // Kind-based refusals apply to slots that could actually run. A degraded
    // optional slot under a dropout-capable projection is configured-and-inert;
    // it never executes, so only admitted slots are checked here.
    let admitted = |slot: &&CompiledRoleSlotV2| slot.disposition == SlotDispositionV2::Admitted;
    let unsupported_timeline = compiled
        .slots
        .iter()
        .filter(admitted)
        .filter(|slot| {
            matches!(
                slot.kind,
                TriageSlotKindV2::Contributor(TriageContributorRole::TimelineAnalyst)
            )
        })
        .map(|slot| slot.slot_id.clone())
        .collect::<Vec<_>>();
    if !unsupported_timeline.is_empty() {
        return Err(TriageProductionAdapterErrorV1::unsupported(
            TriageProductionAdapterRejectionV1::TimelineAnalystUnsupported,
            unsupported_timeline,
        ));
    }
    let finalizers = admitted_slot_ids_of_kind(&compiled, |kind| {
        matches!(kind, TriageSlotKindV2::Finalizer)
    });
    if !finalizers.is_empty() {
        return Err(TriageProductionAdapterErrorV1::unsupported(
            TriageProductionAdapterRejectionV1::FinalizerUnsupported,
            finalizers,
        ));
    }
    let reviewers =
        admitted_slot_ids_of_kind(&compiled, |kind| matches!(kind, TriageSlotKindV2::Reviewer));
    if !reviewers.is_empty() {
        // Even the superficially similar contested/incomplete reviewer is
        // rejected: V2 has explicit requirement and reserve semantics the
        // current contribution reviewer event stream cannot preserve.
        return Err(TriageProductionAdapterErrorV1::unsupported(
            TriageProductionAdapterRejectionV1::ReviewerUnsupported,
            reviewers,
        ));
    }

    let contributor_slots = compiled
        .slots
        .iter()
        .filter(admitted)
        .filter(|slot| matches!(slot.kind, TriageSlotKindV2::Contributor(_)))
        .collect::<Vec<_>>();
    if contributor_slots.is_empty() {
        return Err(TriageProductionAdapterErrorV1::unsupported(
            TriageProductionAdapterRejectionV1::NoAdmittedContributors,
            std::iter::empty(),
        ));
    }

    let mut backend_map = BTreeMap::new();
    for backend in authorized_backends {
        if backend_map
            .insert(backend.slot_id.clone(), backend)
            .is_some()
        {
            return Err(TriageProductionAdapterErrorV1::unsupported(
                TriageProductionAdapterRejectionV1::DuplicateBackendSlot,
                backend_map.keys().cloned(),
            ));
        }
    }
    let expected_ids = contributor_slots
        .iter()
        .map(|slot| slot.slot_id.as_str())
        .collect::<BTreeSet<_>>();
    let actual_ids = backend_map
        .keys()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    if expected_ids != actual_ids {
        return Err(TriageProductionAdapterErrorV1::unsupported(
            TriageProductionAdapterRejectionV1::BackendSetMismatch,
            expected_ids
                .symmetric_difference(&actual_ids)
                .map(|id| (*id).to_owned()),
        ));
    }

    let mut slots = Vec::with_capacity(contributor_slots.len());
    let mut bindings = Vec::with_capacity(contributor_slots.len());
    let mut roles = Vec::with_capacity(contributor_slots.len());
    for slot in contributor_slots {
        let backend = backend_map
            .remove(&slot.slot_id)
            .expect("exact backend id set checked above");
        if backend.model != slot.model {
            return Err(TriageProductionAdapterErrorV1::unsupported(
                TriageProductionAdapterRejectionV1::BackendBindingMismatch,
                [slot.slot_id.clone()],
            ));
        }
        let role = production_role(slot);
        roles.push(role);
        bindings.push(V2ContributionSlotBindingV1 {
            slot_id: slot.slot_id.clone(),
            model: slot.model.clone(),
            production_role: role,
        });
        slots.push(ContributionBackendSlot {
            role,
            identity: ContributionIdentity {
                profile_id: slot.model.profile_id.clone(),
                model: slot.model.model_id.clone(),
            },
            // The pure compiler admitted this exact role/model only after the
            // trusted host supplied current exact-role qualification facts.
            qualification: ContributionQualification::Qualified,
            backend: backend.backend,
        });
    }

    let phase_context =
        usize::try_from(compiled.budget.contributors.max_context_chars).map_err(|_| {
            TriageProductionAdapterErrorV1::unsupported(
                TriageProductionAdapterRejectionV1::BudgetNotRepresentable,
                contributor_slot_ids(&compiled),
            )
        })?;
    let plan = ContributionRoutingPlan::new(
        roles,
        ContributionRoutingPolicy {
            max_contributors: slots.len(),
            max_parallel: 1,
            max_rounds: 1,
            max_context_chars: phase_context,
            reviewer_enabled: false,
        },
    )
    .map_err(|_| {
        TriageProductionAdapterErrorV1::unsupported(
            TriageProductionAdapterRejectionV1::RoutingPlanRejected,
            contributor_slot_ids(&compiled),
        )
    })?;

    let total_context = compiled
        .budget
        .max_context_chars
        .min(compiled.budget.contributors.max_context_chars);
    let runtime = ContributionRuntime {
        slots,
        plan,
        budget: MultiModelBudget {
            max_total_provider_rounds: compiled
                .budget
                .max_provider_calls
                .min(compiled.budget.contributors.max_provider_calls),
            // The current production contribution runtime makes one proposal
            // attempt per slot and performs no semantic correction. A V2
            // correction allowance is therefore left unused, never exceeded.
            max_semantic_corrections_per_stage: 0,
            context_char_budget: host_context_char_budget.min(phase_context),
            deadline_ms: host_turn_deadline_ms,
            max_context_chars_total: Some(total_context),
        },
        neighborhood,
        policy_binding: None,
    };

    Ok(PreparedV2ContributionRuntimeV1 {
        compiled,
        runtime,
        bindings,
    })
}

fn contributor_slot_ids(compiled: &CompiledTriagePolicyV2) -> Vec<String> {
    slot_ids_of_kind(compiled, |kind| {
        matches!(kind, TriageSlotKindV2::Contributor(_))
    })
}

fn slot_ids_of_kind(
    compiled: &CompiledTriagePolicyV2,
    predicate: impl Fn(TriageSlotKindV2) -> bool,
) -> Vec<String> {
    compiled
        .slots
        .iter()
        .filter(|slot| predicate(slot.kind))
        .map(|slot| slot.slot_id.clone())
        .collect()
}

fn admitted_slot_ids_of_kind(
    compiled: &CompiledTriagePolicyV2,
    predicate: impl Fn(TriageSlotKindV2) -> bool,
) -> Vec<String> {
    compiled
        .slots
        .iter()
        .filter(|slot| slot.disposition == SlotDispositionV2::Admitted && predicate(slot.kind))
        .map(|slot| slot.slot_id.clone())
        .collect()
}

fn production_role(slot: &CompiledRoleSlotV2) -> ContributionRole {
    match slot.kind {
        TriageSlotKindV2::Contributor(TriageContributorRole::ObservationExtractor) => {
            ContributionRole::ObservationExtractor
        }
        TriageSlotKindV2::Contributor(TriageContributorRole::CausalProposer) => {
            ContributionRole::CausalProposer
        }
        TriageSlotKindV2::Contributor(TriageContributorRole::ContradictionChecker) => {
            ContributionRole::ContradictionChecker
        }
        TriageSlotKindV2::Contributor(TriageContributorRole::EvidenceGapFinder) => {
            ContributionRole::EvidenceGap
        }
        TriageSlotKindV2::Contributor(TriageContributorRole::TimelineAnalyst)
        | TriageSlotKindV2::Finalizer
        | TriageSlotKindV2::Reviewer => {
            unreachable!("unsupported slot kinds are rejected before mapping")
        }
    }
}
