//! `contextdesk triage-policy` — provider-free V2 policy validation.
//!
//! This is intentionally a thin adapter over the shared core compiler. It
//! reads only the two paths explicitly named by the operator and never loads
//! application config, credentials, discovery state, or a corpus.

use std::path::Path;

use cd_core::model_ref::ModelRef;
use cd_core::multi_model::triage_policy::{
    compile_triage_policy_v2, CompiledRoleSlotV2, CompiledTriagePolicyV2,
    PolicyRejectionCategoryV2, PolicyRejectionV2, RoleRequirement, SlotDispositionV2,
    TriageIndependenceCountsV2, TriagePolicyMode, TriagePolicyPreflightV2, TriagePolicyV2,
    TriageSlotKindV2,
};
use cd_core::triage_policy_store::TriagePolicyStoreV1;
use serde::Serialize;

use crate::cli::{
    TriagePolicyAction, TriagePolicyFileArgs, TriagePolicyStoreAction, TriagePolicyStoreFileArgs,
    TriagePolicyStoreSaveArgs, TriagePolicyStoreSelectArgs,
};
use crate::envelope::{CliError, CliResult, Render};

/// Stable schema for the CLI policy result payload.
pub const TRIAGE_POLICY_CLI_SCHEMA_ID: &str = "contextdesk.cli.triage_policy.v1";

const MAX_POLICY_FILE_BYTES: u64 = 1_048_576;

/// State and external-effects declaration attached to every result.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct OfflinePolicyEvidence {
    /// No network operation is performed.
    pub network: bool,
    /// No credential source is read.
    pub credentials_read: bool,
    /// No AppConfig or CLI state is read or mutated.
    pub app_config_accessed: bool,
    /// No provider qualification or readiness is measured.
    pub live_compatibility: &'static str,
}

impl Default for OfflinePolicyEvidence {
    fn default() -> Self {
        Self {
            network: false,
            credentials_read: false,
            app_config_accessed: false,
            live_compatibility: "not_evaluated",
        }
    }
}

/// Stable provider-free command output.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TriagePolicyCommandOutput {
    /// CLI payload schema.
    pub schema_id: &'static str,
    /// `validate`, `compile`, or `example`.
    pub action: &'static str,
    /// Whether the compiler accepted the policy and preflight facts.
    pub accepted: bool,
    /// Exact profile/model identities make this an owner-local view, not a
    /// share-safe artifact.
    pub privacy: &'static str,
    /// Progressive-disclosure policy level, when input parsing succeeded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<TriagePolicyMode>,
    /// Every configured slot in deterministic order, including dropout.
    #[serde(default)]
    pub slots: Vec<CompiledRoleSlotV2>,
    /// Typed policy-wide and required-role rejection categories.
    #[serde(default)]
    pub rejections: Vec<PolicyRejectionV2>,
    /// Independence accounting for an accepted plan.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub independence: Option<TriageIndependenceCountsV2>,
    /// Full deterministic plan for `compile` only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compiled: Option<CompiledTriagePolicyV2>,
    /// Safe placeholder policy for `example` only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub example_policy: Option<TriagePolicyV2>,
    /// Saved-policy identities for store operations.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub saved_policy_ids: Vec<String>,
    /// Current explicit saved-policy selection, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_policy_id: Option<String>,
    /// Revision written by a store save operation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub saved_revision: Option<u64>,
    /// Explicit proof that this command did not evaluate a provider.
    pub offline: OfflinePolicyEvidence,
}

impl TriagePolicyCommandOutput {
    /// True when validation/compilation succeeded, or when an example was
    /// emitted successfully.
    pub fn accepted(&self) -> bool {
        self.accepted
    }
}

impl Render for TriagePolicyCommandOutput {
    fn render_text(&self) -> String {
        let mut out = format!(
            "Triage Policy V2 — {} (offline)\n\n",
            title_case(self.action)
        );
        if self.action == "example" {
            out.push_str(
                "Standard is the permanent simple default: one explicitly selected model, deterministic host retrieval, and host validation.\n\n",
            );
            out.push_str("Example JSON\n");
            if let Some(policy) = &self.example_policy {
                out.push_str(
                    &serde_json::to_string_pretty(policy)
                        .unwrap_or_else(|_| "{\"error\":\"serialization_failed\"}".into()),
                );
                out.push('\n');
            }
        } else if self.action.starts_with("store_") {
            out.push_str(&format!(
                "Status:  {}\nPrivacy: owner-only (exact policy identities)\n",
                if self.accepted {
                    "ACCEPTED"
                } else {
                    "REJECTED"
                }
            ));
            if !self.saved_policy_ids.is_empty() {
                out.push_str("Saved policies\n");
                for id in &self.saved_policy_ids {
                    out.push_str(&format!("  - {id}\n"));
                }
            }
            if let Some(active) = &self.active_policy_id {
                out.push_str(&format!("Active selection: {active}\n"));
            } else {
                out.push_str("Active selection: none (Standard remains the default)\n");
            }
            if let Some(revision) = self.saved_revision {
                out.push_str(&format!("Saved revision: {revision}\n"));
            }
        } else {
            out.push_str(&format!(
                "Status:  {}\nMode:    {}\nPrivacy: owner-only (contains exact profile/model identities)\n",
                if self.accepted {
                    "ACCEPTED"
                } else {
                    "REJECTED"
                },
                self.mode.map(mode_label).unwrap_or("Unknown")
            ));
            out.push_str("\nSlots\n");
            if self.slots.is_empty() {
                out.push_str("  (none)\n");
            }
            for slot in &self.slots {
                out.push_str(&format!(
                    "  [{}] {}  {}  {}/{}  {}\n",
                    disposition_label(slot.disposition),
                    slot.slot_id,
                    slot_kind_label(slot.kind),
                    slot.model.profile_id,
                    slot.model.model_id,
                    requirement_label(slot.requirement),
                ));
                for rejection in &slot.rejections {
                    out.push_str(&format!("      - {}\n", rejection_label(*rejection)));
                }
            }
            if !self.rejections.is_empty() {
                out.push_str("\nPreflight rejections\n");
                for rejection in &self.rejections {
                    match &rejection.slot_id {
                        Some(slot_id) => out.push_str(&format!(
                            "  - {}: {}\n",
                            slot_id,
                            rejection_label(rejection.category)
                        )),
                        None => {
                            out.push_str(&format!("  - {}\n", rejection_label(rejection.category)))
                        }
                    }
                }
            }
            if let Some(counts) = self.independence {
                out.push_str(&format!(
                    "\nIndependence (not consensus)\n  role slots: {}\n  exact model refs: {}\n  catalog model ids: {}\n  gateways: {}\n",
                    counts.role_slots,
                    counts.distinct_model_refs,
                    counts.distinct_model_ids,
                    counts.distinct_gateways
                ));
            }
        }
        out.push_str(
            "\nExternal effects\n  Network: no\n  Credentials: not read\n  App configuration: not accessed\n  Live compatibility: not evaluated\n  Output privacy: owner-only; review before sharing\n",
        );
        out
    }

    fn render_json(&self) -> serde_json::Value {
        serde_json::to_value(self).expect("triage policy output is serializable")
    }
}

/// Run one provider-free policy command.
pub fn run(action: &TriagePolicyAction) -> CliResult<TriagePolicyCommandOutput> {
    match action {
        TriagePolicyAction::Validate(args) => evaluate("validate", args, false),
        TriagePolicyAction::Compile(args) => evaluate("compile", args, true),
        TriagePolicyAction::Example => Ok(example()),
        TriagePolicyAction::Store { action } => run_store(action),
    }
}

fn run_store(action: &TriagePolicyStoreAction) -> CliResult<TriagePolicyCommandOutput> {
    match action {
        TriagePolicyStoreAction::List(args) => store_list(args),
        TriagePolicyStoreAction::Save(args) => store_save(args),
        TriagePolicyStoreAction::Select(args) => store_select(args),
        TriagePolicyStoreAction::Clear(args) => store_clear(args),
    }
}

fn store_list(args: &TriagePolicyStoreFileArgs) -> CliResult<TriagePolicyCommandOutput> {
    let store = TriagePolicyStoreV1::load(&args.store)
        .map_err(|_| CliError::user("could not load triage policy store"))?;
    Ok(store_output("store_list", &store, None))
}

fn store_save(args: &TriagePolicyStoreSaveArgs) -> CliResult<TriagePolicyCommandOutput> {
    let policy: TriagePolicyV2 = read_json(&args.policy, "policy")?;
    let mut store = TriagePolicyStoreV1::load(&args.store)
        .map_err(|_| CliError::user("could not load triage policy store"))?;
    let revision = store
        .upsert(args.policy_id.clone(), policy)
        .map_err(|_| CliError::user("policy could not be saved to the triage policy store"))?;
    store
        .save(&args.store)
        .map_err(|_| CliError::user("could not publish triage policy store"))?;
    Ok(store_output("store_save", &store, Some(revision)))
}

fn store_select(args: &TriagePolicyStoreSelectArgs) -> CliResult<TriagePolicyCommandOutput> {
    let mut store = TriagePolicyStoreV1::load(&args.store)
        .map_err(|_| CliError::user("could not load triage policy store"))?;
    store
        .select(&args.policy_id)
        .map_err(|_| CliError::user("requested triage policy is not saved"))?;
    store
        .save(&args.store)
        .map_err(|_| CliError::user("could not publish triage policy store"))?;
    Ok(store_output("store_select", &store, None))
}

fn store_clear(args: &TriagePolicyStoreFileArgs) -> CliResult<TriagePolicyCommandOutput> {
    let mut store = TriagePolicyStoreV1::load(&args.store)
        .map_err(|_| CliError::user("could not load triage policy store"))?;
    store.clear_selection();
    store
        .save(&args.store)
        .map_err(|_| CliError::user("could not publish triage policy store"))?;
    Ok(store_output("store_clear", &store, None))
}

fn store_output(
    action: &'static str,
    store: &TriagePolicyStoreV1,
    saved_revision: Option<u64>,
) -> TriagePolicyCommandOutput {
    TriagePolicyCommandOutput {
        schema_id: TRIAGE_POLICY_CLI_SCHEMA_ID,
        action,
        accepted: true,
        privacy: "owner_only",
        mode: None,
        slots: Vec::new(),
        rejections: Vec::new(),
        independence: None,
        compiled: None,
        example_policy: None,
        saved_policy_ids: store
            .policies
            .iter()
            .map(|saved| saved.policy_id.clone())
            .collect(),
        active_policy_id: store.active_policy_id.clone(),
        saved_revision,
        offline: OfflinePolicyEvidence::default(),
    }
}

fn evaluate(
    action: &'static str,
    args: &TriagePolicyFileArgs,
    include_compiled: bool,
) -> CliResult<TriagePolicyCommandOutput> {
    let policy: TriagePolicyV2 = read_json(&args.policy, "policy")?;
    let preflight: TriagePolicyPreflightV2 = read_json(&args.preflight, "preflight")?;
    let mode = policy.mode;
    match compile_triage_policy_v2(&policy, &preflight) {
        Ok(compiled) => Ok(TriagePolicyCommandOutput {
            schema_id: TRIAGE_POLICY_CLI_SCHEMA_ID,
            action,
            accepted: true,
            privacy: "owner_only",
            mode: Some(mode),
            slots: compiled.slots.clone(),
            rejections: Vec::new(),
            independence: Some(compiled.independence_counts),
            compiled: include_compiled.then_some(compiled),
            example_policy: None,
            saved_policy_ids: Vec::new(),
            active_policy_id: None,
            saved_revision: None,
            offline: OfflinePolicyEvidence::default(),
        }),
        Err(failure) => Ok(TriagePolicyCommandOutput {
            schema_id: TRIAGE_POLICY_CLI_SCHEMA_ID,
            action,
            accepted: false,
            privacy: "owner_only",
            mode: Some(mode),
            slots: failure.slots,
            rejections: failure.rejections,
            independence: None,
            compiled: None,
            example_policy: None,
            saved_policy_ids: Vec::new(),
            active_policy_id: None,
            saved_revision: None,
            offline: OfflinePolicyEvidence::default(),
        }),
    }
}

fn example() -> TriagePolicyCommandOutput {
    let policy = TriagePolicyV2::standard(
        ModelRef {
            profile_id: "replace-with-profile-id".into(),
            model_id: "replace-with-exact-catalog-model-id".into(),
        },
        false,
    );
    TriagePolicyCommandOutput {
        schema_id: TRIAGE_POLICY_CLI_SCHEMA_ID,
        action: "example",
        accepted: true,
        privacy: "owner_only",
        mode: Some(TriagePolicyMode::Standard),
        slots: Vec::new(),
        rejections: Vec::new(),
        independence: None,
        compiled: None,
        example_policy: Some(policy),
        saved_policy_ids: Vec::new(),
        active_policy_id: None,
        saved_revision: None,
        offline: OfflinePolicyEvidence::default(),
    }
}

fn read_json<T: serde::de::DeserializeOwned>(path: &Path, label: &str) -> CliResult<T> {
    let metadata = std::fs::metadata(path)
        .map_err(|_| CliError::user(format!("could not read {label} JSON file")))?;
    if !metadata.is_file() || metadata.len() > MAX_POLICY_FILE_BYTES {
        return Err(CliError::user(format!(
            "{label} JSON must be a regular file no larger than 1 MiB"
        )));
    }
    let bytes = std::fs::read(path)
        .map_err(|_| CliError::user(format!("could not read {label} JSON file")))?;
    serde_json::from_slice(&bytes).map_err(|_| {
        CliError::user(format!(
            "{label} JSON is malformed or contains unsupported fields"
        ))
    })
}

fn title_case(action: &str) -> &'static str {
    match action {
        "validate" => "Validate",
        "compile" => "Compile",
        "example" => "Example",
        "store_list" => "Store list",
        "store_save" => "Store save",
        "store_select" => "Store select",
        "store_clear" => "Store clear",
        _ => "Policy",
    }
}

fn mode_label(mode: TriagePolicyMode) -> &'static str {
    match mode {
        TriagePolicyMode::Standard => "Standard",
        TriagePolicyMode::Enhanced => "Enhanced",
        TriagePolicyMode::Advanced => "Advanced",
    }
}

fn disposition_label(disposition: SlotDispositionV2) -> &'static str {
    match disposition {
        SlotDispositionV2::Admitted => "ADMIT",
        SlotDispositionV2::OptionalDegraded => "DEGRADED",
        SlotDispositionV2::RequiredRejected => "REJECT",
    }
}

fn requirement_label(requirement: RoleRequirement) -> &'static str {
    match requirement {
        RoleRequirement::Required => "required",
        RoleRequirement::Optional => "optional",
    }
}

fn slot_kind_label(kind: TriageSlotKindV2) -> &'static str {
    use cd_core::multi_model::triage_policy::TriageContributorRole as Role;
    match kind {
        TriageSlotKindV2::Contributor(Role::ObservationExtractor) => {
            "contributor:observation_extractor"
        }
        TriageSlotKindV2::Contributor(Role::TimelineAnalyst) => "contributor:timeline_analyst",
        TriageSlotKindV2::Contributor(Role::CausalProposer) => "contributor:causal_proposer",
        TriageSlotKindV2::Contributor(Role::ContradictionChecker) => {
            "contributor:contradiction_checker"
        }
        TriageSlotKindV2::Contributor(Role::EvidenceGapFinder) => "contributor:evidence_gap_finder",
        TriageSlotKindV2::Finalizer => "finalizer",
        TriageSlotKindV2::Reviewer => "reviewer",
    }
}

fn rejection_label(category: PolicyRejectionCategoryV2) -> &'static str {
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
