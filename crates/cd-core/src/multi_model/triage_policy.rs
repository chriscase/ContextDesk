//! Pure Triage Policy V2 contracts and preflight compiler.
//!
//! This module performs no I/O and never constructs or calls a provider. It
//! turns an explicit policy plus host-observed qualification/egress facts into
//! a deterministic, sequential execution plan. Every configured role remains
//! visible even when it cannot be admitted.

use std::collections::{BTreeMap, BTreeSet};

use serde::{de::DeserializeOwned, Deserialize, Deserializer, Serialize};
use serde_json::Value;

use crate::model_ref::ModelRef;

use super::{ContributionRole, ContributionRoutingPolicy, MultiModelBudget, MultiModelMode};

/// Stable schema identifier for [`TriagePolicyV2`].
pub const TRIAGE_POLICY_SCHEMA_V2: &str = "contextdesk.triage_policy.v2";

/// Stable schema identifier for compiled policy plans.
pub const COMPILED_TRIAGE_POLICY_SCHEMA_V2: &str = "contextdesk.triage_policy.compiled.v2";

/// Exact qualification evidence schema accepted by the V2 role preflight.
///
/// This is intentionally separate from [`TRIAGE_POLICY_SCHEMA_V2`]: a policy
/// names what the host may run, while this stamp names the synthetic probe
/// contract that actually authorized the role.
pub const TRIAGE_QUALIFICATION_SCHEMA_V2: &str = "contextdesk.triage.qualification.v2";
/// Workflow identity bound by a V2 role qualification record.
pub const TRIAGE_QUALIFICATION_WORKFLOW_V2: &str = "contextdesk.triage.role.v2";

/// Public-policy bounds. These are denial-of-service and operator-error
/// ceilings, not recommended runtime defaults.
pub const MAX_TRIAGE_POLICY_SLOTS_V2: usize = 32;
/// Maximum provider calls named by one V2 policy.
pub const MAX_TRIAGE_PROVIDER_CALLS_V2: u32 = 64;
/// Maximum total model-facing characters named by one V2 policy.
pub const MAX_TRIAGE_CONTEXT_CHARS_V2: u64 = 4_000_000;
/// Maximum explicit deadline or phase timeout in milliseconds.
pub const MAX_TRIAGE_DEADLINE_MS_V2: u64 = 3_600_000;

/// Product disclosure level. All modes use the same compiler and authority
/// boundary; this value changes configuration complexity, not trust.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum TriagePolicyMode {
    /// One exact answer model around the deterministic host path.
    #[default]
    Standard,
    /// One saved, preflighted bounded policy.
    Enhanced,
    /// The same policy with all consequential controls visible.
    Advanced,
}

/// A contributor's bounded analytical role. Finalization and review are
/// deliberately separate slot types and cannot be disguised as contributors.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TriageContributorRole {
    /// Extract host-grounded observations.
    ObservationExtractor,
    /// Analyze host-provided chronology without changing host ordinals.
    TimelineAnalyst,
    /// Propose symptoms, causal candidates, and competing explanations.
    CausalProposer,
    /// Identify contradictions between bounded candidates.
    ContradictionChecker,
    /// Identify evidence absent from the bounded packet.
    EvidenceGapFinder,
}

/// Whether failure of a configured role prevents the policy from compiling.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RoleRequirement {
    /// The policy cannot execute without this role.
    Required,
    /// The role may degrade visibly while deterministic work continues.
    Optional,
}

/// One exact contributor assignment.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ContributorSlotV2 {
    /// Stable host-authored identity unique within the policy.
    pub slot_id: String,
    /// Bounded analytical role.
    pub role: TriageContributorRole,
    /// Exact provider-profile and catalog-model identity.
    pub model: ModelRef,
    /// Required or optional failure semantics.
    pub requirement: RoleRequirement,
    /// Explicit authorization for remote evidence-packet egress.
    #[serde(default)]
    pub allow_remote: bool,
}

/// Separately qualified answer-drafting assignment.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FinalizerSlotV2 {
    /// Stable host-authored identity unique within the policy.
    pub slot_id: String,
    /// Exact provider-profile and catalog-model identity.
    pub model: ModelRef,
    /// Standard requires this slot; enhanced policies may make it optional.
    pub requirement: RoleRequirement,
    /// Explicit authorization for remote evidence-packet egress.
    #[serde(default)]
    pub allow_remote: bool,
}

/// Host condition that may admit the reviewer after reconciliation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewerConditionV2 {
    /// Run only when required coverage is incomplete or claims remain contested.
    ContestedOrIncomplete,
    /// Run only after a user explicitly requests review for this turn.
    ExplicitRequest,
}

/// Optional, conditional reviewer assignment. A reviewer is never an ordinary
/// peer contribution or an automatic retry route.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReviewerSlotV2 {
    /// Stable host-authored identity unique within the policy.
    pub slot_id: String,
    /// Exact provider-profile and catalog-model identity.
    pub model: ModelRef,
    /// Condition evaluated by the host after reconciliation.
    pub condition: ReviewerConditionV2,
    /// Required means the qualifying condition cannot be satisfied without it.
    pub requirement: RoleRequirement,
    /// Explicit authorization for remote evidence-packet egress.
    #[serde(default)]
    pub allow_remote: bool,
}

/// Contributor-phase ceilings, distinct from the whole-turn provider-call cap.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ContributorPhaseBudgetV2 {
    /// Provider calls available to initial contributors.
    pub max_provider_calls: u32,
    /// Per-contributor operation cap in milliseconds.
    pub operation_timeout_ms: u64,
    /// Total model-facing characters across initial contributor calls.
    pub max_context_chars: u64,
}

/// Semantic-correction ceilings, independent of transport retries.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CorrectionBudgetV2 {
    /// Corrections allowed for any one stage.
    pub max_per_stage: u8,
    /// Total correction provider calls available across the turn.
    pub max_provider_calls: u32,
    /// Per-correction operation cap in milliseconds.
    pub operation_timeout_ms: u64,
    /// Total model-facing characters across correction calls.
    pub max_context_chars: u64,
}

/// A separately reserved terminal-phase budget.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TerminalPhaseBudgetV2 {
    /// Provider calls available to this phase. V2 permits at most one.
    pub max_provider_calls: u32,
    /// Time protected for this phase inside an explicit whole-turn deadline.
    pub reserve_ms: u64,
    /// Operation cap for the phase.
    pub operation_timeout_ms: u64,
    /// Maximum model-facing characters for the phase.
    pub max_context_chars: u64,
}

/// Independent, host-measurable ceilings for one triage turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TriageBudgetV2 {
    /// Explicit monotonic whole-turn deadline, or `None` to inherit host policy.
    pub whole_turn_deadline_ms: Option<u64>,
    /// Absolute provider-call ceiling across every phase.
    pub max_provider_calls: u32,
    /// Absolute model-facing character ceiling across every phase.
    pub max_context_chars: u64,
    /// Initial contributor allowance.
    pub contributors: ContributorPhaseBudgetV2,
    /// Bounded semantic correction allowance.
    pub corrections: CorrectionBudgetV2,
    /// Explicit finalizer reserve and operation cap.
    pub finalizer: TerminalPhaseBudgetV2,
    /// Conditional reviewer reserve and operation cap.
    pub reviewer: TerminalPhaseBudgetV2,
}

impl Default for TriageBudgetV2 {
    fn default() -> Self {
        Self {
            whole_turn_deadline_ms: None,
            max_provider_calls: 12,
            max_context_chars: 600_000,
            contributors: ContributorPhaseBudgetV2 {
                max_provider_calls: 4,
                operation_timeout_ms: 120_000,
                max_context_chars: 240_000,
            },
            corrections: CorrectionBudgetV2 {
                max_per_stage: 1,
                max_provider_calls: 4,
                operation_timeout_ms: 120_000,
                max_context_chars: 120_000,
            },
            finalizer: TerminalPhaseBudgetV2 {
                max_provider_calls: 1,
                reserve_ms: 120_000,
                operation_timeout_ms: 120_000,
                max_context_chars: 120_000,
            },
            reviewer: TerminalPhaseBudgetV2 {
                max_provider_calls: 1,
                reserve_ms: 120_000,
                operation_timeout_ms: 120_000,
                max_context_chars: 120_000,
            },
        }
    }
}

/// V2 deliberately supports deterministic sequential execution only.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum TriageExecutionPolicyV1 {
    /// Stable slot order; at most one provider operation in flight.
    #[default]
    Sequential,
}

/// Versioned, provider-neutral triage policy.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TriagePolicyV2 {
    /// Must equal [`TRIAGE_POLICY_SCHEMA_V2`].
    pub schema_id: String,
    /// Product disclosure level.
    pub mode: TriagePolicyMode,
    /// Ordered contributor slots. Duplicate roles and models are allowed.
    #[serde(default)]
    pub contributors: Vec<ContributorSlotV2>,
    /// Optional answer-drafting slot.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finalizer: Option<FinalizerSlotV2>,
    /// Optional conditional reviewer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reviewer: Option<ReviewerSlotV2>,
    /// Explicit independent budgets.
    #[serde(default)]
    pub budget: TriageBudgetV2,
    /// Sequential-only in V2.
    #[serde(default)]
    pub execution: TriageExecutionPolicyV1,
}

impl TriagePolicyV2 {
    /// Construct the permanent simple default around one exact answer model.
    pub fn standard(model: ModelRef, allow_remote: bool) -> Self {
        Self {
            schema_id: TRIAGE_POLICY_SCHEMA_V2.into(),
            mode: TriagePolicyMode::Standard,
            contributors: Vec::new(),
            finalizer: Some(FinalizerSlotV2 {
                slot_id: "standard-finalizer".into(),
                model,
                requirement: RoleRequirement::Required,
                allow_remote,
            }),
            reviewer: None,
            budget: TriageBudgetV2::default(),
            execution: TriageExecutionPolicyV1::Sequential,
        }
    }
}

/// Qualification state measured for the exact workflow and role.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RoleQualificationV2 {
    /// Current exact role/workflow evidence passed.
    Qualified,
    /// Current evidence exists and failed.
    Unqualified,
    /// No exact evidence exists.
    Unverified,
    /// Previously positive evidence is stale.
    Stale,
}

/// Host-owned preflight facts for one configured slot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RolePreflightV2 {
    /// Exact policy slot identity.
    pub slot_id: String,
    /// Exact model identity observed by host resolution.
    pub model: ModelRef,
    /// Exact phase/role identity observed by host resolution.
    pub kind: TriageSlotKindV2,
    /// Whether the configured profile/model can currently be constructed.
    pub available: bool,
    /// Exact workflow/role qualification state.
    pub qualification: RoleQualificationV2,
    /// Whether this exact profile is remote for the current host.
    pub remote: bool,
    /// Schema of the exact qualification evidence. `None` is retained for
    /// legacy Standard preflight records and never upgrades a missing verdict.
    #[serde(
        default,
        deserialize_with = "deserialize_non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub qualification_schema_id: Option<String>,
    /// Workflow identity used by the qualification probe.
    #[serde(
        default,
        deserialize_with = "deserialize_non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub workflow_id: Option<String>,
    /// Secret-free fingerprint of the transport protocol/dialect qualified.
    #[serde(
        default,
        deserialize_with = "deserialize_non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub protocol_fingerprint: Option<String>,
}

/// Pure compiler input. No credentials, endpoints, or provider response text.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TriagePolicyPreflightV2 {
    /// Facts keyed by exact slot identity.
    #[serde(default)]
    pub roles: Vec<RolePreflightV2>,
}

/// Typed category for a policy or slot rejected before any provider call.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PolicyRejectionCategoryV2 {
    /// Unknown or stale schema.
    SchemaMismatch,
    /// A host-authored slot identity is malformed.
    InvalidSlotId,
    /// Two configured slots share an identity.
    DuplicateSlotId,
    /// An exact provider/model reference is malformed.
    InvalidModelRef,
    /// Standard mode was given contributors or a reviewer.
    StandardModeExpanded,
    /// Standard mode lacks one required finalizer.
    StandardFinalizerRequired,
    /// Enhanced/Advanced policy contains no model slots.
    EmptyPolicy,
    /// A budget is zero or cannot fit configured phases.
    InvalidBudget,
    /// The policy or supplied preflight exceeds a public contract bound.
    PolicyLimitExceeded,
    /// The host has no current runtime for the configured exact model.
    RoleUnavailable,
    /// Exact workflow/role qualification is absent, stale, or failed.
    QualificationUnavailable,
    /// Remote evidence egress was not explicitly authorized.
    EgressDenied,
    /// Preflight included a slot that is not in the policy.
    UnknownPreflightSlot,
    /// Preflight supplied more than one fact record for the same slot.
    DuplicatePreflightSlot,
    /// Preflight facts do not match the slot's exact model or role binding.
    PreflightBindingMismatch,
    /// The contributor-phase call cap cannot admit this role.
    ProviderCallBudgetInsufficient,
}

/// One content-free compiler rejection. It is share-safe by construction.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PolicyRejectionV2 {
    /// Slot identity when the rejection belongs to one role.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slot_id: Option<String>,
    /// Stable typed reason.
    pub category: PolicyRejectionCategoryV2,
}

/// Final preflight disposition retained for every configured slot.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SlotDispositionV2 {
    /// Eligible for deterministic sequential admission.
    Admitted,
    /// Optional slot cannot run; deterministic work may continue.
    OptionalDegraded,
    /// Required slot cannot run; compilation fails.
    RequiredRejected,
}

/// Kind of a policy slot, with finalizer/reviewer kept distinct.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TriageSlotKindV2 {
    /// Initial bounded analytical contribution.
    Contributor(TriageContributorRole),
    /// Answer drafting from accepted reconciliation only.
    Finalizer,
    /// Conditional post-reconciliation review.
    Reviewer,
}

/// Compiled record for one configured slot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CompiledRoleSlotV2 {
    /// Exact slot identity.
    pub slot_id: String,
    /// Stable phase/role identity.
    pub kind: TriageSlotKindV2,
    /// Exact model identity.
    pub model: ModelRef,
    /// Required/optional semantics.
    pub requirement: RoleRequirement,
    /// Compiler outcome.
    pub disposition: SlotDispositionV2,
    /// Content-free causes for a degraded/rejected disposition.
    #[serde(default)]
    pub rejections: Vec<PolicyRejectionCategoryV2>,
    /// Qualification schema carried through to the immutable execution plan.
    #[serde(
        default,
        deserialize_with = "deserialize_non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub qualification_schema_id: Option<String>,
    /// Qualification workflow carried through to the immutable execution plan.
    #[serde(
        default,
        deserialize_with = "deserialize_non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub workflow_id: Option<String>,
    /// Qualified transport protocol fingerprint carried through to the plan.
    #[serde(
        default,
        deserialize_with = "deserialize_non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub protocol_fingerprint: Option<String>,
}

/// Inputs for honest same-model independence accounting.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelIndependenceGroupV2 {
    /// One exact provider/model identity; repeated roles collapse here.
    pub model: ModelRef,
    /// Stable admitted role slots filled by this same model.
    pub slot_ids: Vec<String>,
}

/// Counts must remain separate; none is a synonym for consensus.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TriageIndependenceCountsV2 {
    /// Admitted role slots.
    pub role_slots: usize,
    /// Distinct exact `(profile, model)` identities.
    pub distinct_model_refs: usize,
    /// Distinct catalog model ids, even when served by several profiles.
    pub distinct_model_ids: usize,
    /// Distinct provider profiles.
    pub distinct_gateways: usize,
}

/// Pure, deterministic execution plan. Runtime code must still account every
/// slot and enforce the same ceilings when operations begin.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CompiledTriagePolicyV2 {
    /// Must equal [`COMPILED_TRIAGE_POLICY_SCHEMA_V2`].
    pub schema_id: String,
    /// Original disclosure mode.
    pub mode: TriagePolicyMode,
    /// Every configured slot in deterministic execution order.
    pub slots: Vec<CompiledRoleSlotV2>,
    /// Same-model grouping inputs, based on admitted slots only.
    pub independence_groups: Vec<ModelIndependenceGroupV2>,
    /// Separate role/model/gateway counts.
    pub independence_counts: TriageIndependenceCountsV2,
    /// Exact budgets to enforce.
    pub budget: TriageBudgetV2,
    /// Always sequential for V2.
    pub execution: TriageExecutionPolicyV1,
}

/// Failed compile with complete slot dispositions and typed reasons.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TriagePolicyCompileFailureV2 {
    /// Policy-wide and per-slot typed rejections.
    pub rejections: Vec<PolicyRejectionV2>,
    /// Every structurally valid configured slot, including optional dropouts.
    pub slots: Vec<CompiledRoleSlotV2>,
}

#[derive(Clone)]
struct SlotInput {
    slot_id: String,
    kind: TriageSlotKindV2,
    model: ModelRef,
    requirement: RoleRequirement,
    allow_remote: bool,
}

/// Compile and preflight a V2 policy without provider, network, credential, or
/// filesystem access.
pub fn compile_triage_policy_v2(
    policy: &TriagePolicyV2,
    preflight: &TriagePolicyPreflightV2,
) -> Result<CompiledTriagePolicyV2, TriagePolicyCompileFailureV2> {
    let mut rejections = Vec::new();
    if policy.schema_id != TRIAGE_POLICY_SCHEMA_V2 {
        reject(
            &mut rejections,
            None,
            PolicyRejectionCategoryV2::SchemaMismatch,
        );
    }
    if policy.mode != TriagePolicyMode::Standard
        && policy.contributors.is_empty()
        && policy.finalizer.is_none()
        && policy.reviewer.is_none()
    {
        reject(
            &mut rejections,
            None,
            PolicyRejectionCategoryV2::EmptyPolicy,
        );
    }

    if policy.mode == TriagePolicyMode::Standard {
        if !policy.contributors.is_empty() || policy.reviewer.is_some() {
            reject(
                &mut rejections,
                None,
                PolicyRejectionCategoryV2::StandardModeExpanded,
            );
        }
        if !matches!(
            policy.finalizer,
            Some(FinalizerSlotV2 {
                requirement: RoleRequirement::Required,
                ..
            })
        ) {
            reject(
                &mut rejections,
                None,
                PolicyRejectionCategoryV2::StandardFinalizerRequired,
            );
        }
    }

    validate_budget(policy, &mut rejections);

    let configured_slot_count = policy
        .contributors
        .len()
        .saturating_add(usize::from(policy.finalizer.is_some()))
        .saturating_add(usize::from(policy.reviewer.is_some()));
    if configured_slot_count > MAX_TRIAGE_POLICY_SLOTS_V2
        || preflight.roles.len() > MAX_TRIAGE_POLICY_SLOTS_V2
    {
        reject(
            &mut rejections,
            None,
            PolicyRejectionCategoryV2::PolicyLimitExceeded,
        );
        return Err(TriagePolicyCompileFailureV2 {
            rejections,
            slots: Vec::new(),
        });
    }

    let inputs = slot_inputs(policy);
    let mut seen = BTreeSet::new();
    for slot in &inputs {
        if !valid_slot_id(&slot.slot_id) {
            reject(
                &mut rejections,
                Some(&slot.slot_id),
                PolicyRejectionCategoryV2::InvalidSlotId,
            );
        }
        if !seen.insert(slot.slot_id.clone()) {
            reject(
                &mut rejections,
                Some(&slot.slot_id),
                PolicyRejectionCategoryV2::DuplicateSlotId,
            );
        }
        if slot.model.validate().is_err() {
            reject(
                &mut rejections,
                Some(&slot.slot_id),
                PolicyRejectionCategoryV2::InvalidModelRef,
            );
        }
    }

    let configured_ids: BTreeSet<&str> = inputs.iter().map(|slot| slot.slot_id.as_str()).collect();
    let mut seen_preflight = BTreeSet::new();
    for fact in &preflight.roles {
        if !configured_ids.contains(fact.slot_id.as_str()) {
            reject(
                &mut rejections,
                Some(&fact.slot_id),
                PolicyRejectionCategoryV2::UnknownPreflightSlot,
            );
        }
        if !seen_preflight.insert(fact.slot_id.as_str()) {
            reject(
                &mut rejections,
                Some(&fact.slot_id),
                PolicyRejectionCategoryV2::DuplicatePreflightSlot,
            );
        }
    }

    let facts: BTreeMap<&str, &RolePreflightV2> = preflight
        .roles
        .iter()
        .map(|fact| (fact.slot_id.as_str(), fact))
        .collect();
    let required_contributors = inputs
        .iter()
        .filter(|input| {
            matches!(input.kind, TriageSlotKindV2::Contributor(_))
                && input.requirement == RoleRequirement::Required
        })
        .count();
    let contributor_call_cap =
        usize::try_from(policy.budget.contributors.max_provider_calls).unwrap_or(usize::MAX);
    let optional_contributor_capacity = contributor_call_cap.saturating_sub(required_contributors);
    let required_contributors_fit = required_contributors <= contributor_call_cap;
    let mut optional_contributors_admitted = 0usize;
    let mut slots = Vec::with_capacity(inputs.len());
    for input in inputs {
        let mut causes = Vec::new();
        let mut qualification_schema_id = None;
        let mut workflow_id = None;
        let mut protocol_fingerprint = None;
        match facts.get(input.slot_id.as_str()) {
            None => causes.push(PolicyRejectionCategoryV2::RoleUnavailable),
            Some(fact) => {
                qualification_schema_id = fact.qualification_schema_id.clone();
                workflow_id = fact.workflow_id.clone();
                protocol_fingerprint = fact.protocol_fingerprint.clone();
                if fact.model != input.model || fact.kind != input.kind {
                    causes.push(PolicyRejectionCategoryV2::PreflightBindingMismatch);
                }
                if !fact.available {
                    causes.push(PolicyRejectionCategoryV2::RoleUnavailable);
                }
                if fact.qualification != RoleQualificationV2::Qualified {
                    causes.push(PolicyRejectionCategoryV2::QualificationUnavailable);
                }
                // A qualified role must carry one complete, current
                // qualification stamp. Legacy Standard records may omit the
                // stamp during migration; omission never upgrades an
                // Enhanced/Advanced record to Qualified.
                if !qualification_binding_is_current(fact, policy.mode) {
                    causes.push(PolicyRejectionCategoryV2::QualificationUnavailable);
                }
                if fact.remote && !input.allow_remote {
                    causes.push(PolicyRejectionCategoryV2::EgressDenied);
                }
            }
        }
        if matches!(input.kind, TriageSlotKindV2::Contributor(_)) {
            if input.requirement == RoleRequirement::Required {
                if !required_contributors_fit {
                    causes.push(PolicyRejectionCategoryV2::ProviderCallBudgetInsufficient);
                }
            } else if causes.is_empty() {
                if optional_contributors_admitted < optional_contributor_capacity {
                    optional_contributors_admitted += 1;
                } else {
                    causes.push(PolicyRejectionCategoryV2::ProviderCallBudgetInsufficient);
                }
            }
        }
        causes.sort_unstable();
        causes.dedup();

        let disposition = if causes.is_empty() {
            SlotDispositionV2::Admitted
        } else if input.requirement == RoleRequirement::Required {
            for cause in &causes {
                reject(&mut rejections, Some(&input.slot_id), *cause);
            }
            SlotDispositionV2::RequiredRejected
        } else {
            SlotDispositionV2::OptionalDegraded
        };
        slots.push(CompiledRoleSlotV2 {
            slot_id: input.slot_id,
            kind: input.kind,
            model: input.model,
            requirement: input.requirement,
            disposition,
            rejections: causes,
            qualification_schema_id,
            workflow_id,
            protocol_fingerprint,
        });
    }

    if !rejections.is_empty() {
        return Err(TriagePolicyCompileFailureV2 { rejections, slots });
    }

    let mut groups: BTreeMap<ModelRef, Vec<String>> = BTreeMap::new();
    for slot in slots
        .iter()
        .filter(|slot| slot.disposition == SlotDispositionV2::Admitted)
    {
        groups
            .entry(slot.model.clone())
            .or_default()
            .push(slot.slot_id.clone());
    }
    let model_ids: BTreeSet<&str> = groups.keys().map(|model| model.model_id.as_str()).collect();
    let gateways: BTreeSet<&str> = groups
        .keys()
        .map(|model| model.profile_id.as_str())
        .collect();
    let independence_counts = TriageIndependenceCountsV2 {
        role_slots: groups.values().map(Vec::len).sum(),
        distinct_model_refs: groups.len(),
        distinct_model_ids: model_ids.len(),
        distinct_gateways: gateways.len(),
    };
    let independence_groups = groups
        .into_iter()
        .map(|(model, slot_ids)| ModelIndependenceGroupV2 { model, slot_ids })
        .collect();

    Ok(CompiledTriagePolicyV2 {
        schema_id: COMPILED_TRIAGE_POLICY_SCHEMA_V2.into(),
        mode: policy.mode,
        slots,
        independence_groups,
        independence_counts,
        budget: policy.budget,
        execution: policy.execution,
    })
}

fn slot_inputs(policy: &TriagePolicyV2) -> Vec<SlotInput> {
    let mut slots: Vec<_> = policy
        .contributors
        .iter()
        .map(|slot| SlotInput {
            slot_id: slot.slot_id.clone(),
            kind: TriageSlotKindV2::Contributor(slot.role),
            model: slot.model.clone(),
            requirement: slot.requirement,
            allow_remote: slot.allow_remote,
        })
        .collect();
    if let Some(slot) = &policy.finalizer {
        slots.push(SlotInput {
            slot_id: slot.slot_id.clone(),
            kind: TriageSlotKindV2::Finalizer,
            model: slot.model.clone(),
            requirement: slot.requirement,
            allow_remote: slot.allow_remote,
        });
    }
    if let Some(slot) = &policy.reviewer {
        slots.push(SlotInput {
            slot_id: slot.slot_id.clone(),
            kind: TriageSlotKindV2::Reviewer,
            model: slot.model.clone(),
            requirement: slot.requirement,
            allow_remote: slot.allow_remote,
        });
    }
    slots
}

fn validate_budget(policy: &TriagePolicyV2, rejections: &mut Vec<PolicyRejectionV2>) {
    let budget = policy.budget;
    let has_finalizer = policy.finalizer.is_some();
    let has_reviewer = policy.reviewer.is_some();
    let phase_calls = budget
        .contributors
        .max_provider_calls
        .saturating_add(budget.corrections.max_provider_calls)
        .saturating_add(if has_finalizer {
            budget.finalizer.max_provider_calls
        } else {
            0
        })
        .saturating_add(if has_reviewer {
            budget.reviewer.max_provider_calls
        } else {
            0
        });
    let phase_chars = budget
        .contributors
        .max_context_chars
        .saturating_add(budget.corrections.max_context_chars)
        .saturating_add(if has_finalizer {
            budget.finalizer.max_context_chars
        } else {
            0
        })
        .saturating_add(if has_reviewer {
            budget.reviewer.max_context_chars
        } else {
            0
        });
    let terminal_reserve = (if has_finalizer {
        budget.finalizer.reserve_ms
    } else {
        0
    })
    .saturating_add(if has_reviewer {
        budget.reviewer.reserve_ms
    } else {
        0
    });

    let invalid = budget.max_provider_calls == 0
        || budget.max_provider_calls > MAX_TRIAGE_PROVIDER_CALLS_V2
        || budget.max_context_chars == 0
        || budget.max_context_chars > MAX_TRIAGE_CONTEXT_CHARS_V2
        || budget
            .whole_turn_deadline_ms
            .is_some_and(|deadline| deadline == 0 || deadline > MAX_TRIAGE_DEADLINE_MS_V2)
        || budget.contributors.max_provider_calls > MAX_TRIAGE_PROVIDER_CALLS_V2
        || budget.contributors.operation_timeout_ms > MAX_TRIAGE_DEADLINE_MS_V2
        || budget.contributors.max_context_chars > MAX_TRIAGE_CONTEXT_CHARS_V2
        || budget.corrections.max_provider_calls > MAX_TRIAGE_PROVIDER_CALLS_V2
        || budget.corrections.operation_timeout_ms > MAX_TRIAGE_DEADLINE_MS_V2
        || budget.corrections.max_context_chars > MAX_TRIAGE_CONTEXT_CHARS_V2
        || budget.finalizer.max_provider_calls > 1
        || budget.finalizer.reserve_ms > MAX_TRIAGE_DEADLINE_MS_V2
        || budget.finalizer.operation_timeout_ms > MAX_TRIAGE_DEADLINE_MS_V2
        || budget.finalizer.max_context_chars > MAX_TRIAGE_CONTEXT_CHARS_V2
        || budget.reviewer.max_provider_calls > 1
        || budget.reviewer.reserve_ms > MAX_TRIAGE_DEADLINE_MS_V2
        || budget.reviewer.operation_timeout_ms > MAX_TRIAGE_DEADLINE_MS_V2
        || budget.reviewer.max_context_chars > MAX_TRIAGE_CONTEXT_CHARS_V2
        || (!policy.contributors.is_empty()
            && (budget.contributors.max_provider_calls == 0
                || budget.contributors.operation_timeout_ms == 0
                || budget.contributors.max_context_chars == 0))
        || (budget.corrections.max_provider_calls > 0
            && (budget.corrections.max_per_stage == 0
                || budget.corrections.operation_timeout_ms == 0
                || budget.corrections.max_context_chars == 0))
        || (has_finalizer
            && (budget.finalizer.max_provider_calls != 1
                || budget.finalizer.operation_timeout_ms == 0
                || budget.finalizer.max_context_chars == 0))
        || (has_reviewer
            && (budget.reviewer.max_provider_calls != 1
                || budget.reviewer.operation_timeout_ms == 0
                || budget.reviewer.max_context_chars == 0))
        || phase_calls > budget.max_provider_calls
        || phase_chars > budget.max_context_chars
        || budget.whole_turn_deadline_ms == Some(0)
        || budget
            .whole_turn_deadline_ms
            .is_some_and(|deadline| terminal_reserve > deadline);
    if invalid {
        reject(rejections, None, PolicyRejectionCategoryV2::InvalidBudget);
    }
}

fn valid_slot_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
}

/// Validate the exact qualification stamp attached to one host fact.
///
/// `None` for all three fields is an explicitly recognized legacy shape only
/// for Standard mode. Partial stamps, stale schema/workflow ids, and malformed
/// protocol fingerprints fail closed in every mode. In particular, a legacy
/// omission is never treated as positive evidence for an expanded policy.
fn qualification_binding_is_current(fact: &RolePreflightV2, mode: TriagePolicyMode) -> bool {
    let fields = (
        fact.qualification_schema_id.as_deref(),
        fact.workflow_id.as_deref(),
        fact.protocol_fingerprint.as_deref(),
    );
    if fields == (None, None, None) {
        return mode == TriagePolicyMode::Standard;
    }
    let (Some(schema), Some(workflow), Some(protocol)) = fields else {
        return false;
    };
    schema == TRIAGE_QUALIFICATION_SCHEMA_V2
        && workflow == TRIAGE_QUALIFICATION_WORKFLOW_V2
        && valid_protocol_fingerprint(protocol)
}

fn valid_protocol_fingerprint(value: &str) -> bool {
    !value.trim().is_empty()
        && value.starts_with("sha256:")
        && value.len() <= 512
        && !value.contains('/')
        && !value.contains('\\')
        && !value.contains("://")
        && !value.chars().any(char::is_control)
}

/// Preserve the wire distinction between an omitted additive field and an
/// explicit JSON null. Missing fields migrate as `None`; present null is
/// malformed and must fail closed, matching the TypeScript contract mirror.
fn deserialize_non_null_option<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: DeserializeOwned,
{
    let value = Value::deserialize(deserializer)?;
    if value.is_null() {
        return Err(serde::de::Error::custom(
            "null is not valid for an additive option",
        ));
    }
    T::deserialize(value)
        .map(Some)
        .map_err(|error| serde::de::Error::custom(error.to_string()))
}

fn reject(
    rejections: &mut Vec<PolicyRejectionV2>,
    slot_id: Option<&str>,
    category: PolicyRejectionCategoryV2,
) {
    rejections.push(PolicyRejectionV2 {
        slot_id: slot_id.map(str::to_owned),
        category,
    });
}

/// Resolved legacy contributor assignment used only by the pure migration
/// helper. It contains no credentials or provider metadata.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LegacyResolvedContributorV1 {
    /// Legacy contribution role.
    pub role: ContributionRole,
    /// Exact resolved model identity.
    pub model: ModelRef,
    /// Legacy qualification flag.
    pub require_qualified: bool,
    /// Legacy egress authorization.
    pub allow_remote: bool,
}

/// Pure input for migrating an already-resolved legacy policy. This helper
/// does not read or mutate application configuration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LegacyResolvedTriagePolicyV1 {
    /// Existing configured mode.
    pub mode: MultiModelMode,
    /// Existing primary/final answer model.
    pub primary: ModelRef,
    /// Existing explicit remote-egress authorization for the primary model.
    pub primary_allow_remote: bool,
    /// Existing optional reviewer assignment.
    pub reviewer: Option<ModelRef>,
    /// Existing contribution assignments.
    pub contributors: Vec<LegacyResolvedContributorV1>,
    /// Existing per-turn budget.
    pub budget: MultiModelBudget,
    /// Existing contribution routing policy.
    pub contribution_policy: ContributionRoutingPolicy,
}

/// Migrate resolved legacy settings without changing the legacy runtime path.
/// The returned policy remains opt-in until a host explicitly selects V2.
pub fn migrate_resolved_legacy_policy_v1(input: LegacyResolvedTriagePolicyV1) -> TriagePolicyV2 {
    let mode = if input.mode == MultiModelMode::Single {
        TriagePolicyMode::Standard
    } else {
        TriagePolicyMode::Enhanced
    };
    let mut reviewer = input.reviewer.map(|model| ReviewerSlotV2 {
        slot_id: "legacy-reviewer".into(),
        model,
        condition: ReviewerConditionV2::ContestedOrIncomplete,
        requirement: RoleRequirement::Optional,
        allow_remote: false,
    });
    let mut contributors = Vec::new();
    for (index, legacy) in input.contributors.into_iter().enumerate() {
        if legacy.role == ContributionRole::Reviewer {
            if reviewer.is_none() {
                reviewer = Some(ReviewerSlotV2 {
                    slot_id: format!("legacy-reviewer-{index}"),
                    model: legacy.model,
                    condition: ReviewerConditionV2::ContestedOrIncomplete,
                    requirement: RoleRequirement::Optional,
                    allow_remote: legacy.allow_remote,
                });
            }
            continue;
        }
        let role = match legacy.role {
            ContributionRole::ObservationExtractor => TriageContributorRole::ObservationExtractor,
            ContributionRole::CausalProposer => TriageContributorRole::CausalProposer,
            ContributionRole::ContradictionChecker => TriageContributorRole::ContradictionChecker,
            ContributionRole::EvidenceGap => TriageContributorRole::EvidenceGapFinder,
            ContributionRole::Reviewer => unreachable!("handled above"),
        };
        contributors.push(ContributorSlotV2 {
            slot_id: format!("legacy-contributor-{index}"),
            role,
            model: legacy.model,
            requirement: RoleRequirement::Optional,
            allow_remote: legacy.allow_remote,
        });
    }

    let mut budget = TriageBudgetV2::default();
    budget.whole_turn_deadline_ms =
        (input.budget.deadline_ms > 0).then_some(input.budget.deadline_ms);
    budget.max_provider_calls = input.budget.max_total_provider_rounds;
    if let Some(total) = input.budget.max_context_chars_total {
        budget.max_context_chars = total;
    }
    budget.contributors.max_provider_calls =
        u32::try_from(input.contribution_policy.max_contributors)
            .unwrap_or(u32::MAX)
            .min(budget.max_provider_calls);
    budget.contributors.operation_timeout_ms = input.budget.deadline_ms.max(1);
    budget.contributors.max_context_chars =
        u64::try_from(input.contribution_policy.max_context_chars)
            .unwrap_or(u64::MAX)
            .min(budget.max_context_chars);
    budget.corrections.max_per_stage = input.budget.max_semantic_corrections_per_stage;
    budget.corrections.max_provider_calls =
        u32::from(input.budget.max_semantic_corrections_per_stage)
            .saturating_mul(u32::try_from(contributors.len() + 2).unwrap_or(u32::MAX))
            .min(
                budget
                    .max_provider_calls
                    .saturating_sub(budget.contributors.max_provider_calls),
            );
    budget.finalizer.max_context_chars = u64::try_from(input.budget.context_char_budget)
        .unwrap_or(u64::MAX)
        .min(budget.max_context_chars);
    budget.reviewer.max_context_chars = budget.finalizer.max_context_chars;
    if let Some(deadline) = budget.whole_turn_deadline_ms {
        let terminal_phases = if reviewer.is_some() { 3 } else { 2 };
        let reserve = deadline / terminal_phases;
        budget.finalizer.reserve_ms = reserve;
        budget.finalizer.operation_timeout_ms = budget.finalizer.operation_timeout_ms.min(deadline);
        budget.reviewer.reserve_ms = reserve;
        budget.reviewer.operation_timeout_ms = budget.reviewer.operation_timeout_ms.min(deadline);
        budget.corrections.operation_timeout_ms =
            budget.corrections.operation_timeout_ms.min(deadline);
    }

    if mode == TriagePolicyMode::Standard {
        TriagePolicyV2::standard(input.primary, input.primary_allow_remote)
    } else {
        TriagePolicyV2 {
            schema_id: TRIAGE_POLICY_SCHEMA_V2.into(),
            mode,
            contributors,
            finalizer: Some(FinalizerSlotV2 {
                slot_id: "legacy-finalizer".into(),
                model: input.primary,
                requirement: RoleRequirement::Required,
                allow_remote: false,
            }),
            reviewer,
            budget,
            execution: TriageExecutionPolicyV1::Sequential,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model(profile: &str, model_id: &str) -> ModelRef {
        ModelRef {
            profile_id: profile.into(),
            model_id: model_id.into(),
        }
    }

    fn facts(policy: &TriagePolicyV2) -> TriagePolicyPreflightV2 {
        TriagePolicyPreflightV2 {
            roles: slot_inputs(policy)
                .into_iter()
                .map(|slot| RolePreflightV2 {
                    slot_id: slot.slot_id,
                    model: slot.model,
                    kind: slot.kind,
                    available: true,
                    qualification: RoleQualificationV2::Qualified,
                    remote: false,
                    qualification_schema_id: Some(TRIAGE_QUALIFICATION_SCHEMA_V2.into()),
                    workflow_id: Some(TRIAGE_QUALIFICATION_WORKFLOW_V2.into()),
                    protocol_fingerprint: Some("sha256:triage-fixture-protocol".into()),
                })
                .collect(),
        }
    }

    fn enhanced() -> TriagePolicyV2 {
        let mut policy = TriagePolicyV2::standard(model("gateway-a", "openai/gpt-oss-120b"), false);
        policy.mode = TriagePolicyMode::Enhanced;
        policy.contributors = vec![
            ContributorSlotV2 {
                slot_id: "observe".into(),
                role: TriageContributorRole::ObservationExtractor,
                model: model("gateway-a", "openai/gpt-oss-120b"),
                requirement: RoleRequirement::Required,
                allow_remote: false,
            },
            ContributorSlotV2 {
                slot_id: "challenge".into(),
                role: TriageContributorRole::ContradictionChecker,
                model: model("gateway-b", "deepseek-v4-flash"),
                requirement: RoleRequirement::Optional,
                allow_remote: false,
            },
        ];
        policy
            .finalizer
            .as_mut()
            .expect("fixture finalizer")
            .slot_id = "finalize".into();
        policy
    }

    #[test]
    fn standard_is_legacy_compatible_and_single_model() {
        let policy = TriagePolicyV2::standard(model("local", "mistral:latest"), false);
        let compiled = compile_triage_policy_v2(&policy, &facts(&policy)).expect("compile");
        assert_eq!(compiled.mode, TriagePolicyMode::Standard);
        assert_eq!(compiled.slots.len(), 1);
        assert_eq!(compiled.slots[0].kind, TriageSlotKindV2::Finalizer);
        assert_eq!(compiled.independence_counts.role_slots, 1);
    }

    #[test]
    fn legacy_standard_qualification_omission_does_not_authorize_enhanced() {
        let standard = TriagePolicyV2::standard(model("local", "mistral:latest"), false);
        let mut legacy = facts(&standard);
        let fact = &mut legacy.roles[0];
        fact.qualification_schema_id = None;
        fact.workflow_id = None;
        fact.protocol_fingerprint = None;
        assert!(compile_triage_policy_v2(&standard, &legacy).is_ok());

        let enhanced = enhanced();
        let mut expanded_legacy = facts(&enhanced);
        for fact in &mut expanded_legacy.roles {
            fact.qualification_schema_id = None;
            fact.workflow_id = None;
            fact.protocol_fingerprint = None;
        }
        assert!(compile_triage_policy_v2(&enhanced, &expanded_legacy).is_err());
    }

    #[test]
    fn explicitly_authorized_remote_standard_model_compiles() {
        let policy =
            TriagePolicyV2::standard(model("company-gateway", "openai/gpt-oss-120b"), true);
        let mut preflight = facts(&policy);
        preflight.roles[0].remote = true;
        assert!(compile_triage_policy_v2(&policy, &preflight).is_ok());

        let denied =
            TriagePolicyV2::standard(model("company-gateway", "openai/gpt-oss-120b"), false);
        let mut denied_facts = facts(&denied);
        denied_facts.roles[0].remote = true;
        assert!(compile_triage_policy_v2(&denied, &denied_facts).is_err());
    }

    #[test]
    fn same_model_in_two_roles_is_one_independence_group() {
        let mut policy = enhanced();
        policy.contributors[1].model = policy.contributors[0].model.clone();
        let compiled = compile_triage_policy_v2(&policy, &facts(&policy)).expect("compile");
        assert_eq!(compiled.independence_counts.role_slots, 3);
        assert_eq!(compiled.independence_counts.distinct_model_refs, 1);
        assert_eq!(compiled.independence_counts.distinct_model_ids, 1);
        assert_eq!(compiled.independence_counts.distinct_gateways, 1);
        assert_eq!(compiled.independence_groups[0].slot_ids.len(), 3);
    }

    #[test]
    fn same_catalog_model_on_two_gateways_reports_each_dimension() {
        let mut policy = enhanced();
        policy.contributors[1].model.model_id = policy.contributors[0].model.model_id.clone();
        let compiled = compile_triage_policy_v2(&policy, &facts(&policy)).expect("compile");
        assert_eq!(compiled.independence_counts.distinct_model_refs, 2);
        assert_eq!(compiled.independence_counts.distinct_model_ids, 1);
        assert_eq!(compiled.independence_counts.distinct_gateways, 2);
    }

    #[test]
    fn optional_dropout_remains_visible_and_compiles() {
        let policy = enhanced();
        let mut preflight = facts(&policy);
        let missing = preflight
            .roles
            .iter_mut()
            .find(|fact| fact.slot_id == "challenge")
            .expect("challenge fact");
        missing.available = false;
        missing.qualification = RoleQualificationV2::Unverified;
        let compiled = compile_triage_policy_v2(&policy, &preflight).expect("optional degrades");
        let challenge = compiled
            .slots
            .iter()
            .find(|slot| slot.slot_id == "challenge")
            .expect("challenge retained");
        assert_eq!(challenge.disposition, SlotDispositionV2::OptionalDegraded);
        assert_eq!(
            challenge.rejections,
            vec![
                PolicyRejectionCategoryV2::RoleUnavailable,
                PolicyRejectionCategoryV2::QualificationUnavailable
            ]
        );
    }

    #[test]
    fn required_dropout_fails_with_every_slot_recorded() {
        let policy = enhanced();
        let mut preflight = facts(&policy);
        preflight.roles.retain(|fact| fact.slot_id != "observe");
        let failure = compile_triage_policy_v2(&policy, &preflight).expect_err("required fails");
        assert_eq!(failure.slots.len(), 3);
        assert_eq!(
            failure
                .slots
                .iter()
                .find(|slot| slot.slot_id == "observe")
                .expect("slot")
                .disposition,
            SlotDispositionV2::RequiredRejected
        );
    }

    #[test]
    fn stale_qualification_and_remote_egress_fail_closed() {
        let policy = enhanced();
        let mut preflight = facts(&policy);
        let observe = preflight
            .roles
            .iter_mut()
            .find(|fact| fact.slot_id == "observe")
            .expect("observe fact");
        observe.qualification = RoleQualificationV2::Stale;
        observe.remote = true;
        let failure = compile_triage_policy_v2(&policy, &preflight).expect_err("must reject");
        let causes = &failure
            .slots
            .iter()
            .find(|slot| slot.slot_id == "observe")
            .expect("slot")
            .rejections;
        assert!(causes.contains(&PolicyRejectionCategoryV2::QualificationUnavailable));
        assert!(causes.contains(&PolicyRejectionCategoryV2::EgressDenied));
    }

    #[test]
    fn preflight_model_and_role_must_match_the_exact_policy_binding() {
        let policy = enhanced();
        for mutate in [true, false] {
            let mut preflight = facts(&policy);
            let observe = preflight
                .roles
                .iter_mut()
                .find(|fact| fact.slot_id == "observe")
                .expect("observe fact");
            if mutate {
                observe.model = model("gateway-a", "different-model");
            } else {
                observe.kind =
                    TriageSlotKindV2::Contributor(TriageContributorRole::ContradictionChecker);
            }
            let failure =
                compile_triage_policy_v2(&policy, &preflight).expect_err("binding mismatch");
            assert!(failure.rejections.iter().any(|rejection| {
                rejection.category == PolicyRejectionCategoryV2::PreflightBindingMismatch
            }));
        }
    }

    #[test]
    fn unqualified_role_cannot_opt_out_of_exact_qualification() {
        let policy = enhanced();
        let mut preflight = facts(&policy);
        preflight.roles[0].qualification = RoleQualificationV2::Unqualified;
        assert!(compile_triage_policy_v2(&policy, &preflight).is_err());
    }

    #[test]
    fn enhanced_qualification_binding_is_exact_and_complete() {
        let policy = enhanced();
        let mut missing = facts(&policy);
        let observe = missing
            .roles
            .iter_mut()
            .find(|fact| fact.slot_id == "observe")
            .expect("observe fact");
        observe.protocol_fingerprint = None;
        let failure = compile_triage_policy_v2(&policy, &missing).expect_err("partial stamp");
        assert!(failure.rejections.iter().any(|rejection| {
            rejection.category == PolicyRejectionCategoryV2::QualificationUnavailable
        }));

        let mut stale = facts(&policy);
        let observe = stale
            .roles
            .iter_mut()
            .find(|fact| fact.slot_id == "observe")
            .expect("observe fact");
        observe.workflow_id = Some("contextdesk.triage.role.v1".into());
        let failure = compile_triage_policy_v2(&policy, &stale).expect_err("stale stamp");
        assert!(failure.rejections.iter().any(|rejection| {
            rejection.category == PolicyRejectionCategoryV2::QualificationUnavailable
        }));

        let mut malformed = facts(&policy);
        let observe = malformed
            .roles
            .iter_mut()
            .find(|fact| fact.slot_id == "observe")
            .expect("observe fact");
        observe.protocol_fingerprint = Some("sha1:not-the-qualified-protocol".into());
        let failure = compile_triage_policy_v2(&policy, &malformed)
            .expect_err("malformed protocol fingerprint");
        assert!(failure.rejections.iter().any(|rejection| {
            rejection.category == PolicyRejectionCategoryV2::QualificationUnavailable
        }));
    }

    #[test]
    fn qualification_additive_fields_reject_explicit_null_but_allow_omission() {
        let policy = enhanced();
        let fact = facts(&policy).roles.into_iter().next().expect("role fact");
        let mut encoded = serde_json::to_value(&fact).expect("encode role fact");
        encoded
            .as_object_mut()
            .expect("role object")
            .remove("qualification_schema_id");
        assert!(serde_json::from_value::<RolePreflightV2>(encoded).is_ok());

        let mut encoded = serde_json::to_value(&fact).expect("encode role fact");
        encoded["qualification_schema_id"] = Value::Null;
        assert!(serde_json::from_value::<RolePreflightV2>(encoded).is_err());
    }

    #[test]
    fn standard_cannot_hide_contributors_or_reviewer() {
        let mut policy = enhanced();
        policy.mode = TriagePolicyMode::Standard;
        let failure = compile_triage_policy_v2(&policy, &facts(&policy)).expect_err("expanded");
        assert!(failure.rejections.iter().any(|rejection| {
            rejection.category == PolicyRejectionCategoryV2::StandardModeExpanded
        }));
    }

    #[test]
    fn duplicate_and_path_shaped_slot_ids_fail_closed() {
        let mut policy = enhanced();
        policy.contributors[1].slot_id = policy.contributors[0].slot_id.clone();
        policy.finalizer.as_mut().expect("finalizer").slot_id = "../../final".into();
        let failure = compile_triage_policy_v2(&policy, &facts(&policy)).expect_err("invalid ids");
        assert!(failure
            .rejections
            .iter()
            .any(|rejection| { rejection.category == PolicyRejectionCategoryV2::DuplicateSlotId }));
        assert!(failure
            .rejections
            .iter()
            .any(|rejection| { rejection.category == PolicyRejectionCategoryV2::InvalidSlotId }));
    }

    #[test]
    fn phase_call_caps_cannot_overcommit_whole_turn_cap() {
        let mut policy = enhanced();
        policy.budget.max_provider_calls = 2;
        let failure = compile_triage_policy_v2(&policy, &facts(&policy)).expect_err("overcommit");
        assert!(failure
            .rejections
            .iter()
            .any(|r| r.category == PolicyRejectionCategoryV2::InvalidBudget));
    }

    #[test]
    fn contributor_call_cap_reserves_required_roles_before_optional_roles() {
        let mut policy = enhanced();
        policy.contributors.insert(
            0,
            ContributorSlotV2 {
                slot_id: "nice-to-have".into(),
                role: TriageContributorRole::EvidenceGapFinder,
                model: model("gateway-c", "model-c"),
                requirement: RoleRequirement::Optional,
                allow_remote: false,
            },
        );
        policy.budget.contributors.max_provider_calls = 2;
        let compiled = compile_triage_policy_v2(&policy, &facts(&policy)).expect("compile");
        let optional_states: Vec<_> = compiled
            .slots
            .iter()
            .filter(|slot| slot.requirement == RoleRequirement::Optional)
            .map(|slot| slot.disposition)
            .collect();
        assert_eq!(
            optional_states,
            vec![
                SlotDispositionV2::Admitted,
                SlotDispositionV2::OptionalDegraded
            ]
        );
        assert_eq!(
            compiled
                .slots
                .iter()
                .find(|slot| slot.slot_id == "observe")
                .expect("required role")
                .disposition,
            SlotDispositionV2::Admitted
        );
    }

    #[test]
    fn unavailable_optional_does_not_starve_a_later_eligible_optional() {
        let mut policy = enhanced();
        policy.contributors.insert(
            0,
            ContributorSlotV2 {
                slot_id: "unavailable-optional".into(),
                role: TriageContributorRole::EvidenceGapFinder,
                model: model("gateway-c", "model-c"),
                requirement: RoleRequirement::Optional,
                allow_remote: false,
            },
        );
        policy.budget.contributors.max_provider_calls = 2;
        let mut preflight = facts(&policy);
        preflight
            .roles
            .iter_mut()
            .find(|fact| fact.slot_id == "unavailable-optional")
            .expect("fact")
            .available = false;
        let compiled = compile_triage_policy_v2(&policy, &preflight).expect("compile");
        assert_eq!(
            compiled
                .slots
                .iter()
                .find(|slot| slot.slot_id == "challenge")
                .expect("later optional")
                .disposition,
            SlotDispositionV2::Admitted
        );
    }

    #[test]
    fn required_contributors_that_cannot_fit_fail_preflight() {
        let mut policy = enhanced();
        policy.budget.contributors.max_provider_calls = 0;
        let failure = compile_triage_policy_v2(&policy, &facts(&policy)).expect_err("must fail");
        assert!(failure.slots.iter().any(|slot| {
            slot.slot_id == "observe"
                && slot
                    .rejections
                    .contains(&PolicyRejectionCategoryV2::ProviderCallBudgetInsufficient)
        }));
    }

    #[test]
    fn terminal_reserves_must_fit_explicit_deadline() {
        let mut policy = enhanced();
        policy.reviewer = Some(ReviewerSlotV2 {
            slot_id: "review".into(),
            model: model("gateway-b", "deepseek-v4-flash"),
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
    }

    #[test]
    fn standard_short_deadline_ignores_inactive_contributor_phase_cap() {
        let mut policy = TriagePolicyV2::standard(model("local", "mistral:latest"), false);
        policy.budget.whole_turn_deadline_ms = Some(60_000);
        policy.budget.finalizer.reserve_ms = 30_000;
        policy.budget.finalizer.operation_timeout_ms = 60_000;
        assert!(compile_triage_policy_v2(&policy, &facts(&policy)).is_ok());
    }

    #[test]
    fn empty_enhanced_and_advanced_policies_fail_closed() {
        for mode in [TriagePolicyMode::Enhanced, TriagePolicyMode::Advanced] {
            let policy = TriagePolicyV2 {
                schema_id: TRIAGE_POLICY_SCHEMA_V2.into(),
                mode,
                contributors: Vec::new(),
                finalizer: None,
                reviewer: None,
                budget: TriageBudgetV2::default(),
                execution: TriageExecutionPolicyV1::Sequential,
            };
            let failure = compile_triage_policy_v2(&policy, &TriagePolicyPreflightV2::default())
                .expect_err("empty policy");
            assert!(failure
                .rejections
                .iter()
                .any(|rejection| rejection.category == PolicyRejectionCategoryV2::EmptyPolicy));
        }
    }

    #[test]
    fn public_policy_slot_and_budget_bounds_fail_closed() {
        let mut oversized = enhanced();
        let template = oversized.contributors[0].clone();
        oversized.contributors = (0..=MAX_TRIAGE_POLICY_SLOTS_V2)
            .map(|index| ContributorSlotV2 {
                slot_id: format!("slot-{index}"),
                ..template.clone()
            })
            .collect();
        let failure =
            compile_triage_policy_v2(&oversized, &facts(&oversized)).expect_err("oversized policy");
        assert!(failure.slots.is_empty());
        assert!(failure.rejections.iter().any(|rejection| {
            rejection.category == PolicyRejectionCategoryV2::PolicyLimitExceeded
        }));

        let mut excessive_budget = enhanced();
        excessive_budget.budget.max_provider_calls = MAX_TRIAGE_PROVIDER_CALLS_V2 + 1;
        let failure = compile_triage_policy_v2(&excessive_budget, &facts(&excessive_budget))
            .expect_err("excessive budget");
        assert!(failure
            .rejections
            .iter()
            .any(|rejection| rejection.category == PolicyRejectionCategoryV2::InvalidBudget));
    }

    #[test]
    fn omitted_defaults_are_sequential_and_bounded() {
        let json = serde_json::json!({
            "schema_id": TRIAGE_POLICY_SCHEMA_V2,
            "mode": "enhanced",
            "contributors": [],
            "finalizer": {
                "slot_id": "finish",
                "model": {"profile_id": "local", "model_id": "mistral:latest"},
                "requirement": "required"
            }
        });
        let policy: TriagePolicyV2 = serde_json::from_value(json).expect("deserialize defaults");
        assert_eq!(policy.execution, TriageExecutionPolicyV1::Sequential);
        assert_eq!(policy.budget, TriageBudgetV2::default());
        assert_eq!(
            policy.finalizer.expect("finalizer").requirement,
            RoleRequirement::Required
        );
    }

    #[test]
    fn unknown_fields_are_rejected() {
        let json = serde_json::json!({
            "schema_id": TRIAGE_POLICY_SCHEMA_V2,
            "mode": "standard",
            "contributors": [],
            "budget": TriageBudgetV2::default(),
            "execution": "sequential",
            "silent_model_fallback": true
        });
        assert!(serde_json::from_value::<TriagePolicyV2>(json).is_err());
    }

    #[test]
    fn parallel_execution_and_duplicate_preflight_facts_fail_closed() {
        let mut json = serde_json::to_value(enhanced()).expect("serialize policy");
        json["execution"] = serde_json::Value::String("parallel".into());
        assert!(serde_json::from_value::<TriagePolicyV2>(json).is_err());

        let policy = enhanced();
        let mut preflight = facts(&policy);
        preflight.roles.push(preflight.roles[0].clone());
        let failure = compile_triage_policy_v2(&policy, &preflight).expect_err("duplicate");
        assert!(failure.rejections.iter().any(|rejection| {
            rejection.category == PolicyRejectionCategoryV2::DuplicatePreflightSlot
        }));
    }

    #[test]
    fn compiled_json_contains_no_secret_endpoint_or_raw_body_fields() {
        let policy = enhanced();
        let compiled = compile_triage_policy_v2(&policy, &facts(&policy)).expect("compile");
        let json = serde_json::to_string(&compiled).expect("serialize");
        for forbidden in [
            "api_key",
            "authorization",
            "endpoint",
            "provider_body",
            "prompt",
            "reasoning",
        ] {
            assert!(
                !json.to_ascii_lowercase().contains(forbidden),
                "{forbidden}"
            );
        }
    }

    #[test]
    fn legacy_single_migrates_to_exact_standard_behavior() {
        let primary = model("legacy", "model-a");
        let migrated = migrate_resolved_legacy_policy_v1(LegacyResolvedTriagePolicyV1 {
            mode: MultiModelMode::Single,
            primary: primary.clone(),
            primary_allow_remote: false,
            reviewer: None,
            contributors: Vec::new(),
            budget: MultiModelBudget::default(),
            contribution_policy: ContributionRoutingPolicy::default(),
        });
        assert_eq!(migrated, TriagePolicyV2::standard(primary, false));
    }

    #[test]
    fn legacy_contribution_reviewer_is_not_migrated_as_peer_contributor() {
        let primary = model("legacy", "model-a");
        let reviewer_model = model("review", "model-b");
        let migrated = migrate_resolved_legacy_policy_v1(LegacyResolvedTriagePolicyV1 {
            mode: MultiModelMode::Contributions,
            primary,
            primary_allow_remote: false,
            reviewer: None,
            contributors: vec![LegacyResolvedContributorV1 {
                role: ContributionRole::Reviewer,
                model: reviewer_model.clone(),
                require_qualified: true,
                allow_remote: true,
            }],
            budget: MultiModelBudget::default(),
            contribution_policy: ContributionRoutingPolicy::default(),
        });
        assert!(migrated.contributors.is_empty());
        assert_eq!(migrated.reviewer.expect("reviewer").model, reviewer_model);
    }

    #[test]
    fn legacy_enhanced_defaults_migrate_to_a_compilable_policy() {
        let migrated = migrate_resolved_legacy_policy_v1(LegacyResolvedTriagePolicyV1 {
            mode: MultiModelMode::Review,
            primary: model("primary", "model-a"),
            primary_allow_remote: false,
            reviewer: Some(model("reviewer", "model-b")),
            contributors: vec![LegacyResolvedContributorV1 {
                role: ContributionRole::ObservationExtractor,
                model: model("contributor", "model-c"),
                require_qualified: true,
                allow_remote: false,
            }],
            budget: MultiModelBudget {
                deadline_ms: 180_000,
                ..MultiModelBudget::default()
            },
            contribution_policy: ContributionRoutingPolicy::default(),
        });
        compile_triage_policy_v2(&migrated, &facts(&migrated)).expect("migrated policy compiles");
    }
}
