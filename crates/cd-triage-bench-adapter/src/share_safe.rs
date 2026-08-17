//! Explicit share-safe projection.
//!
//! This is a projection, not a filter. Every field is named and copied by
//! hand from the owner-only record, so a new owner-only field is invisible to
//! share-safe output until someone deliberately adds it here.
//!
//! Structurally excluded: the exact [`cd_triage_sdk::ModelRef`], the answer
//! envelope, the task text, evidence content and digests, evidence source
//! references, host-authored slot and item identities, and the raw output
//! bytes. Only fingerprints, counts, and typed dispositions survive.
//!
//! The projection is then gated by the real
//! [`cd_triage_sdk::scan_share_safe_text`]; a finding is a refusal, never a
//! redaction.

use cd_triage_bench::{EvaluationTask, EvidenceSnapshot};
use cd_triage_sdk::{
    scan_share_safe_text, PacketPrivacyBoundary, ShareSafeTriageResultV2, TriageAttemptStatus,
    TriageResultKind, TriageSlotKindV2, TriageTerminalDispositionV1, TriageValidationState,
};
use serde::{Deserialize, Serialize};

use crate::error::{AdapterError, AdapterResult};
use crate::fingerprint::{fingerprint, SNAPSHOT_PREFIX, TASK_PREFIX};
use crate::record::RecordedContextDeskRun;

/// Share-safe view of one role slot. Carries fingerprints and dispositions
/// only: no slot identity, no model identity.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ShareSafeSlot {
    /// Fingerprint over slot identity, kind, and model.
    pub slot_fingerprint: String,
    /// Fingerprint over the exact model identity. Not the identity itself.
    pub model_fingerprint: String,
    /// Slot kind.
    pub role: TriageSlotKindV2,
    /// Recorded attempt status.
    pub status: TriageAttemptStatus,
    /// Explicit terminal disposition.
    pub terminal_disposition: TriageTerminalDispositionV1,
    /// Bounded reason codes.
    pub reason_codes: Vec<String>,
}

/// Share-safe export for one recorded ContextDesk run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ShareSafeAdapterRun {
    /// Always [`PacketPrivacyBoundary::ShareSafe`].
    pub privacy: PacketPrivacyBoundary,
    /// Bench run identity.
    pub bench_run_id: String,
    /// SDK-side run identity.
    pub sdk_run_id: String,
    /// Fingerprint of the bench task identity.
    pub task_fingerprint: String,
    /// Fingerprint of the bench snapshot identity.
    pub snapshot_fingerprint: String,
    /// Exact policy-selection fingerprint.
    pub policy_fingerprint: String,
    /// Whole-request fingerprint.
    pub request_fingerprint: String,
    /// Materialized packet fingerprint.
    pub packet_fingerprint: String,
    /// Bounded evidence-corpus fingerprint.
    pub corpus_fingerprint: String,
    /// Distinct model fingerprints, sorted. Never model identities.
    pub model_fingerprints: Vec<String>,
    /// Per-slot share-safe views.
    pub slots: Vec<ShareSafeSlot>,
    /// Always `contextdesk_sdk`.
    pub source_kind: String,
    /// Always `same_snapshot`: the packet came from this snapshot under this
    /// task's visibility policy.
    pub fairness: String,
    /// Bench terminal status.
    pub status: String,
    /// Public terminal event kind.
    pub terminal_kind: String,
    /// Opaque host failure category, when the terminal carried one.
    pub terminal_category: Option<String>,
    /// Result kind, when the terminal carried a result.
    pub result_kind: Option<TriageResultKind>,
    /// Host validation state, when the terminal carried a result.
    pub validation_state: Option<TriageValidationState>,
    /// True when a non-completed terminal carried partial output as
    /// provenance. The status above is unaffected.
    pub partial_result_is_provenance_only: bool,
    /// Bounded reason codes.
    pub reason_codes: Vec<String>,
    /// Configured role slots.
    pub configured_role_slots: u32,
    /// Role slots that completed.
    pub completed_role_slots: u32,
    /// Distinct models among completed slots.
    pub distinct_models: u32,
    /// Distinct gateways among completed slots.
    pub distinct_gateways: u32,
    /// Whether the run established a root cause.
    pub root_cause_established: bool,
    /// Count of visible evidence rows. Never their identities or digests.
    pub visible_evidence_count: u32,
    /// Always `unknown`: the public envelope reports no token usage.
    pub usage: String,
    /// Always `unknown`: the public envelope reports no cost.
    pub cost: String,
    /// Always false. Present so a reader can see the omission is deliberate.
    pub answer_included: bool,
    /// Always false. Present so a reader can see the omission is deliberate.
    pub raw_output_included: bool,
    /// The SDK's own share-safe result projection, when the terminal carried a
    /// result. Produced by `TriageResultV2::share_safe_summary` and validated
    /// by `ShareSafeTriageResultV2::validate` — the adapter writes no second
    /// share-safe result shape.
    pub sdk_result: Option<ShareSafeTriageResultV2>,
}

/// Project a recorded run to share-safe output, or refuse.
pub fn project_share_safe(
    snapshot: &EvidenceSnapshot,
    task: &EvaluationTask,
    recorded: &RecordedContextDeskRun,
) -> AdapterResult<ShareSafeAdapterRun> {
    let record = &recorded.owner_only;
    let terminal = &record.terminal;

    let sdk_result = match recorded_result(recorded) {
        Some(result) => {
            let summary = result.share_safe_summary();
            // Real public validator, including its own privacy scan.
            summary.validate()?;
            Some(summary)
        }
        None => None,
    };

    let projection = ShareSafeAdapterRun {
        privacy: PacketPrivacyBoundary::ShareSafe,
        bench_run_id: recorded.bench_run.run_id.clone(),
        sdk_run_id: record.sdk_run_id.clone(),
        // Bench ids are projected as fingerprints, never verbatim: a literal
        // `task-…` identity trips the SDK's `sk-` credential heuristic.
        task_fingerprint: fingerprint(TASK_PREFIX, &task.task_id)?,
        snapshot_fingerprint: fingerprint(SNAPSHOT_PREFIX, &snapshot.snapshot_id)?,
        policy_fingerprint: record.fingerprints.policy.clone(),
        request_fingerprint: record.fingerprints.request.clone(),
        packet_fingerprint: record.fingerprints.packet.clone(),
        corpus_fingerprint: record.fingerprints.corpus.clone(),
        model_fingerprints: record.fingerprints.models.clone(),
        slots: record
            .slots
            .iter()
            .map(|slot| ShareSafeSlot {
                slot_fingerprint: slot.slot_fingerprint.clone(),
                model_fingerprint: slot.model_fingerprint.clone(),
                role: slot.role,
                status: slot.status,
                terminal_disposition: slot.terminal_disposition,
                reason_codes: slot.reason_codes.clone(),
            })
            .collect(),
        source_kind: "contextdesk_sdk".to_string(),
        fairness: "same_snapshot".to_string(),
        status: recorded.bench_run.status.as_str().to_string(),
        terminal_kind: terminal.kind.clone(),
        terminal_category: terminal.category.clone(),
        result_kind: terminal.result_kind,
        validation_state: terminal.validation_state,
        partial_result_is_provenance_only: terminal.partial_result_is_provenance_only,
        reason_codes: terminal.reason_codes.clone(),
        configured_role_slots: sdk_result
            .as_ref()
            .map(|result| result.reconciliation.configured_role_slots)
            .unwrap_or(record.slots.len() as u32),
        completed_role_slots: sdk_result
            .as_ref()
            .map(|result| result.reconciliation.completed_role_slots)
            .unwrap_or_default(),
        distinct_models: sdk_result
            .as_ref()
            .map(|result| result.reconciliation.distinct_models)
            .unwrap_or_default(),
        distinct_gateways: sdk_result
            .as_ref()
            .map(|result| result.reconciliation.distinct_gateways)
            .unwrap_or_default(),
        root_cause_established: sdk_result
            .as_ref()
            .is_some_and(|result| result.reconciliation.root_cause_established),
        visible_evidence_count: record.visible_item_ids.len() as u32,
        usage: "unknown".to_string(),
        cost: "unknown".to_string(),
        answer_included: false,
        raw_output_included: false,
        sdk_result,
    };

    gate(&projection)?;
    Ok(projection)
}

/// Refuse a projection that the real share-safe scanner flags.
fn gate(projection: &ShareSafeAdapterRun) -> AdapterResult<()> {
    let encoded = serde_json::to_string(projection).map_err(|_| AdapterError::Serialize)?;
    let findings = scan_share_safe_text(&encoded);
    if findings.is_empty() {
        Ok(())
    } else {
        Err(AdapterError::Privacy(
            findings
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>()
                .join("; "),
        ))
    }
}

fn recorded_result(recorded: &RecordedContextDeskRun) -> Option<&cd_triage_sdk::TriageResultV2> {
    use cd_triage_sdk::TriageRunEventPayloadV2;
    match &recorded.owner_only.replay.events.last()?.event {
        TriageRunEventPayloadV2::Completed { result } => Some(result),
        TriageRunEventPayloadV2::Failed { partial_result, .. }
        | TriageRunEventPayloadV2::TimedOut { partial_result, .. }
        | TriageRunEventPayloadV2::Cancelled { partial_result, .. } => partial_result.as_deref(),
        _ => None,
    }
}
