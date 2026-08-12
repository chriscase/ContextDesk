//! `contextdesk triage-policy` — V2 policy validation, compilation, and the
//! production contributor-subset run.
//!
//! `validate` / `compile` / `example` remain thin, provider-free adapters
//! over the shared core compiler: they read only the operator-named files
//! and never load application config, credentials, discovery state, or a
//! corpus. `run` is the stateful production caller: it resolves the policy
//! through the shared `cd-workflow` resolver, executes the linked
//! contribution turn, and emits the shared owner-only V2 event ledger.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use cd_core::capability_qualification::{load_qualification_store, qualification_store_path};
use cd_core::config::AppConfig;
use cd_core::extension_contract::PacketPrivacyBoundary;
use cd_core::keychain_store::SecretStore;
use cd_core::model_ref::ModelRef;
use cd_core::multi_model::triage_policy::{
    compile_triage_policy_v2, CompiledRoleSlotV2, CompiledTriagePolicyV2,
    PolicyRejectionCategoryV2, PolicyRejectionV2, RoleRequirement, SlotDispositionV2,
    TriageIndependenceCountsV2, TriagePolicyMode, TriagePolicyPreflightV2, TriagePolicyV2,
    TriageSlotKindV2, TRIAGE_POLICY_SCHEMA_V2,
};
use cd_core::triage_sdk::{
    TriageReconciliationV1, TriageReplayV1, TriageRequestOverridesV1, TriageRequestV2,
    TriageResultKind, TriageRoleAttemptV1, TriageRunEventV2, TriageScopeV1, TriageValidationState,
    TRIAGE_REQUEST_SCHEMA_V2,
};
use cd_workflow::session::CliState;
use cd_workflow::triage_production::TriageProductionAdapterErrorV1;
use cd_workflow::triage_run::{
    resolve_and_run_triage_policy_v2, share_safe_projection, TriagePolicyRunErrorV1,
    TriageRunAccountingV1, TriageTurnDispositionV1,
};
use serde::Serialize;

use crate::cli::{TriagePolicyAction, TriagePolicyFileArgs, TriagePolicyRunArgs};
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
        TriagePolicyAction::Run(_) => Err(CliError::user(
            "triage-policy run requires the stateful dispatch path".to_string(),
        )),
    }
}

/// Stable schema for the CLI run result payload.
pub const TRIAGE_POLICY_RUN_CLI_SCHEMA_ID: &str = "contextdesk.cli.triage_policy_run.v1";

/// Typed pre-run refusal surfaced to the operator.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TriagePolicyRunRefusal {
    /// Stable content-free category.
    pub category: String,
    /// Relevant host-authored slot ids, when the refusal names slots.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub slot_ids: Vec<String>,
}

/// Owner-only output of one production policy run.
#[derive(Serialize)]
pub struct TriagePolicyRunOutput {
    /// CLI payload schema.
    pub schema_id: &'static str,
    /// True only when the run reached a `completed` terminal.
    pub accepted: bool,
    /// Exact identities and evidence ids make this owner-only.
    pub privacy: &'static str,
    /// Run identity echoed by every ledger event.
    pub run_id: String,
    /// Corpus the run was grounded in.
    pub corpus_id: String,
    /// Terminal event kind: `completed`, `failed`, `timed_out`, `cancelled`,
    /// or `refused` when no run started.
    pub terminal: String,
    /// Result kind when a terminal result exists.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result_kind: Option<TriageResultKind>,
    /// Host validation state when a terminal result exists.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub validation_state: Option<TriageValidationState>,
    /// Deterministic reconciliation summary when a run happened.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reconciliation: Option<TriageReconciliationV1>,
    /// Every role attempt, in configured slot order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attempts: Vec<TriageRoleAttemptV1>,
    /// Physical provider-call accounting for the run.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accounting: Option<TriagePolicyRunAccountingOutput>,
    /// The full owner-only replay (ordered events, exactly one terminal).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replay: Option<TriageReplayV1>,
    /// Typed refusal when compilation/adaptation stopped before any run.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refusal: Option<TriagePolicyRunRefusal>,
    /// Complete slot dispositions for a compile-time refusal.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub slots: Vec<CompiledRoleSlotV2>,
    /// Typed compile rejections for a compile-time refusal.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub rejections: Vec<PolicyRejectionV2>,
    /// Where the owner-only JSONL event stream was written, when requested.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub events_out: Option<String>,
    /// Where the share-safe projection was written, when requested.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub share_safe_out: Option<String>,
}

/// Serializable accounting mirror for the CLI payload.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct TriagePolicyRunAccountingOutput {
    /// Physical provider calls sent by admitted contributor slots.
    pub provider_calls: u32,
    /// Semantic-correction provider calls (always zero on this subset).
    pub correction_calls: u32,
    /// Model-facing characters sent.
    pub context_chars_sent: u64,
    /// Response characters received.
    pub output_chars: u64,
}

impl From<TriageRunAccountingV1> for TriagePolicyRunAccountingOutput {
    fn from(value: TriageRunAccountingV1) -> Self {
        Self {
            provider_calls: value.provider_calls,
            correction_calls: value.correction_calls,
            context_chars_sent: value.context_chars_sent,
            output_chars: value.output_chars,
        }
    }
}

impl TriagePolicyRunOutput {
    /// True only for a completed grounded terminal.
    pub fn accepted(&self) -> bool {
        self.accepted
    }
}

impl Render for TriagePolicyRunOutput {
    fn render_text(&self) -> String {
        let mut out = format!(
            "Triage Policy V2 — Run\n\nStatus:   {}\nRun:      {}\nCorpus:   {}\nTerminal: {}\nPrivacy:  owner-only (exact identities and evidence ids)\n",
            if self.accepted { "COMPLETED" } else { "NOT COMPLETED" },
            self.run_id,
            self.corpus_id,
            self.terminal,
        );
        if let Some(refusal) = &self.refusal {
            out.push_str(&format!(
                "\nRefused before any provider call\n  category: {}\n",
                refusal.category
            ));
            for slot in &refusal.slot_ids {
                out.push_str(&format!("  slot: {slot}\n"));
            }
        }
        for rejection in &self.rejections {
            match &rejection.slot_id {
                Some(slot_id) => out.push_str(&format!(
                    "  - {}: {}\n",
                    slot_id,
                    rejection_label(rejection.category)
                )),
                None => out.push_str(&format!("  - {}\n", rejection_label(rejection.category))),
            }
        }
        if !self.attempts.is_empty() {
            out.push_str("\nRole attempts\n");
            for attempt in &self.attempts {
                out.push_str(&format!(
                    "  [{}] {}  {}  {}ms in={} out={}\n",
                    attempt_status_label(attempt),
                    attempt.role_slot_id,
                    slot_kind_label(attempt.role),
                    attempt.elapsed_ms,
                    attempt.input_chars,
                    attempt.output_chars,
                ));
                for code in &attempt.reason_codes {
                    out.push_str(&format!("      - {code}\n"));
                }
            }
        }
        if let Some(summary) = &self.reconciliation {
            out.push_str(&format!(
                "\nReconciliation (independence, not consensus)\n  state: {}\n  configured/completed role slots: {}/{}\n  distinct models: {}\n  distinct gateways: {}\n  supported claims: {}\n  conflicts: {}\n  gaps: {}\n",
                summary.state,
                summary.configured_role_slots,
                summary.completed_role_slots,
                summary.distinct_models,
                summary.distinct_gateways,
                summary.supported_claim_ids.len(),
                summary.conflict_ids.len(),
                summary.gap_ids.len(),
            ));
        }
        if let Some(accounting) = &self.accounting {
            out.push_str(&format!(
                "\nPhysical provider calls\n  contributor calls: {}\n  correction calls:  {}\n  context chars sent: {}\n  output chars:       {}\n",
                accounting.provider_calls,
                accounting.correction_calls,
                accounting.context_chars_sent,
                accounting.output_chars,
            ));
        }
        if let Some(path) = &self.events_out {
            out.push_str(&format!("\nOwner-only event JSONL written to {path}\n"));
        }
        if let Some(path) = &self.share_safe_out {
            out.push_str(&format!("Share-safe projection written to {path}\n"));
        }
        out.push_str("\nStandard mode note: Standard stays on the established single-model chat path; this command runs Enhanced/Advanced contributor policies only.\n");
        out
    }

    fn render_json(&self) -> serde_json::Value {
        serde_json::to_value(self).expect("triage policy run output is serializable")
    }
}

fn attempt_status_label(attempt: &TriageRoleAttemptV1) -> &'static str {
    use cd_core::triage_sdk::TriageAttemptStatus as Status;
    match attempt.status {
        Status::Completed => "OK",
        Status::Abstained => "ABSTAIN",
        Status::Invalid => "INVALID",
        Status::Unavailable => "UNAVAILABLE",
        Status::TimedOut => "TIMEOUT",
        Status::Cancelled => "CANCELLED",
        Status::Failed => "FAILED",
        Status::NotAdmitted => "DROPOUT",
    }
}

/// Execute one production policy run on the shared workflow facade.
pub async fn run_policy(
    args: &TriagePolicyRunArgs,
    cache_root: &Path,
    qualification_config_dir: &Path,
    secrets: &dyn SecretStore,
    cfg: &AppConfig,
    cli_state: &mut CliState,
) -> CliResult<TriagePolicyRunOutput> {
    let policy: TriagePolicyV2 = read_json(&args.policy, "policy")?;
    let corpus_id = args
        .corpus
        .clone()
        .or_else(|| cli_state.current_corpus_id.clone())
        .ok_or_else(|| {
            CliError::user("no corpus selected; pass --corpus or run `corpus use` first")
        })?;
    let run_id = args
        .run_id
        .clone()
        .unwrap_or_else(|| format!("triage-run-{}", uuid::Uuid::now_v7()));
    let cancellation_id = format!("cancel-{run_id}");
    let request = TriageRequestV2 {
        schema_id: TRIAGE_REQUEST_SCHEMA_V2.into(),
        run_id: run_id.clone(),
        privacy: PacketPrivacyBoundary::OwnerOnly,
        task: args.task.clone(),
        scope: TriageScopeV1 {
            corpus_id: corpus_id.clone(),
            corpus_revision: None,
            source_ids: Vec::new(),
        },
        policy: cd_core::triage_sdk::TriagePolicySelectionV2::Inline {
            schema_id: TRIAGE_POLICY_SCHEMA_V2.into(),
            document: serde_json::to_value(&policy)
                .map_err(|_| CliError::user("policy JSON could not be re-serialized"))?,
        },
        overrides: TriageRequestOverridesV1 {
            deadline_ms: args.deadline_ms,
            max_provider_calls: args.max_provider_calls,
        },
        cancellation_id,
    };
    request
        .validate()
        .map_err(|error| CliError::user(format!("triage request invalid: {error}")))?;

    let mut host = crate::adapters::tool_host_with_app_config(cache_root, cfg, secrets)?;
    let credentials = cd_workflow::provider::TurnProviderCredentialCache::new(secrets);
    let resolved_turn = cd_workflow::provider::resolve_turn_inputs_with_credential_cache(
        &credentials,
        cfg,
        None,
        None,
    )
    .map_err(CliError::user)?;
    let qualification_store =
        load_qualification_store(&qualification_store_path(qualification_config_dir)).ok();
    let context_char_budget = host
        .model_context_budgets()
        .resolve(Some(resolved_turn.profile.chat_model.as_str()));

    let cancel = Arc::new(AtomicBool::new(false));
    let live_events: Arc<Mutex<Vec<TriageRunEventV2>>> = Arc::new(Mutex::new(Vec::new()));
    let sink_events = live_events.clone();
    let run = {
        let mut turn = Box::pin(resolve_and_run_triage_policy_v2(
            &mut host,
            cfg,
            &credentials,
            qualification_store.as_ref(),
            &resolved_turn,
            cache_root,
            &request,
            &policy,
            context_char_budget,
            cfg.contributions.neighborhood,
            Some(cancel.clone()),
            None,
            Some(Box::new(move |event: &TriageRunEventV2| {
                if let Ok(mut events) = sink_events.lock() {
                    events.push(event.clone());
                }
            })),
        ));
        tokio::select! {
            run = turn.as_mut() => run,
            _ = tokio::signal::ctrl_c() => {
                cancel.store(true, Ordering::SeqCst);
                eprintln!("cancelling - waiting for the triage run to wind down...");
                match tokio::time::timeout(std::time::Duration::from_secs(30), turn.as_mut()).await
                {
                    Ok(run) => run,
                    Err(_) => {
                        return Err(CliError::cancelled("triage policy run cancelled"));
                    }
                }
            }
        }
    };

    let outcome = match run {
        Ok(outcome) => outcome,
        Err(TriagePolicyRunErrorV1::Contract(error)) => {
            return Err(CliError::user(format!("triage request invalid: {error}")));
        }
        Err(TriagePolicyRunErrorV1::OverrideExtendsPolicy { field }) => {
            return Err(CliError::user(format!(
                "request override would extend policy `{field}`; overrides may only narrow policy bounds"
            )));
        }
        Err(TriagePolicyRunErrorV1::Adapter(error)) => {
            return Ok(refused_output(run_id, corpus_id, error));
        }
        Err(TriagePolicyRunErrorV1::Ledger(error)) => {
            return Err(CliError::internal(format!(
                "triage event ledger failed validation: {error}"
            )));
        }
    };

    let replay = outcome.ledger.replay.clone();
    let result = outcome.ledger.result.clone();
    let terminal = replay
        .events
        .last()
        .map(|event| terminal_label(&event.event).to_string())
        .unwrap_or_else(|| "unknown".to_string());
    let attempts: Vec<TriageRoleAttemptV1> = replay
        .events
        .iter()
        .filter_map(|event| match &event.event {
            cd_core::triage_sdk::TriageRunEventPayloadV2::RoleAttempt { attempt } => {
                Some(attempt.clone())
            }
            _ => None,
        })
        .collect();

    let events_out = match &args.events_out {
        Some(path) => {
            let mut lines = String::new();
            for event in &replay.events {
                let line = serde_json::to_string(event)
                    .map_err(|_| CliError::internal("event serialization failed"))?;
                lines.push_str(&line);
                lines.push('\n');
            }
            std::fs::write(path, lines)
                .map_err(|_| CliError::user("could not write --events-out file"))?;
            Some(path.display().to_string())
        }
        None => None,
    };
    let share_safe_out = match &args.share_safe_out {
        Some(path) => {
            let projection = share_safe_projection(&replay, &result).map_err(|error| {
                CliError::user(format!(
                    "share-safe projection unavailable for this run: {error}"
                ))
            })?;
            let document = serde_json::json!({
                "schema_id": "contextdesk.cli.triage_share_safe_projection.v1",
                "events": projection.events,
                "result": projection.result,
                "dropped_events": projection.dropped_events,
            });
            std::fs::write(
                path,
                serde_json::to_string_pretty(&document)
                    .map_err(|_| CliError::internal("share-safe serialization failed"))?,
            )
            .map_err(|_| CliError::user("could not write --share-safe-out file"))?;
            Some(path.display().to_string())
        }
        None => None,
    };

    let accepted = matches!(outcome.disposition, TriageTurnDispositionV1::Completed)
        && terminal == "completed";
    Ok(TriagePolicyRunOutput {
        schema_id: TRIAGE_POLICY_RUN_CLI_SCHEMA_ID,
        accepted,
        privacy: "owner_only",
        run_id,
        corpus_id,
        terminal,
        result_kind: Some(result.kind),
        validation_state: Some(result.validation_state),
        reconciliation: Some(result.reconciliation.clone()),
        attempts,
        accounting: Some(outcome.ledger.accounting.into()),
        replay: Some(replay),
        refusal: None,
        slots: Vec::new(),
        rejections: Vec::new(),
        events_out,
        share_safe_out,
    })
}

fn terminal_label(payload: &cd_core::triage_sdk::TriageRunEventPayloadV2) -> &'static str {
    use cd_core::triage_sdk::TriageRunEventPayloadV2 as Payload;
    match payload {
        Payload::Completed { .. } => "completed",
        Payload::Failed { .. } => "failed",
        Payload::TimedOut { .. } => "timed_out",
        Payload::Cancelled { .. } => "cancelled",
        _ => "unknown",
    }
}

fn refused_output(
    run_id: String,
    corpus_id: String,
    error: TriageProductionAdapterErrorV1,
) -> TriagePolicyRunOutput {
    let (refusal, slots, rejections) = match error {
        TriageProductionAdapterErrorV1::Policy(failure) => (
            TriagePolicyRunRefusal {
                category: "policy_preflight_rejected".into(),
                slot_ids: Vec::new(),
            },
            failure.slots,
            failure.rejections,
        ),
        TriageProductionAdapterErrorV1::Unsupported { category, slot_ids } => (
            TriagePolicyRunRefusal {
                category: category.as_str().into(),
                slot_ids,
            },
            Vec::new(),
            Vec::new(),
        ),
    };
    TriagePolicyRunOutput {
        schema_id: TRIAGE_POLICY_RUN_CLI_SCHEMA_ID,
        accepted: false,
        privacy: "owner_only",
        run_id,
        corpus_id,
        terminal: "refused".into(),
        result_kind: None,
        validation_state: None,
        reconciliation: None,
        attempts: Vec::new(),
        accounting: None,
        replay: None,
        refusal: Some(refusal),
        slots,
        rejections,
        events_out: None,
        share_safe_out: None,
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
