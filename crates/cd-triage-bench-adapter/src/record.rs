//! Owner-only recorded run.
//!
//! An owner-only record may retain everything the run actually produced: the
//! exact request (including task text), the full replay, and every exact
//! gateway-scoped [`ModelRef`]. The share-safe export is a separate, explicit
//! projection in [`crate::share_safe`] — never this record with a relabelled
//! privacy boundary.
//!
//! The durable artifacts are the real `cd_triage_sdk` replay and the real
//! `cd_triage_bench::TriageRun`; both carry their own published schema ids.
//! This module declares no schema id of its own.

use cd_triage_bench::{
    canonical::to_canonical_json, ClaimedCitation, Completeness, ContentDigest, EvaluationTask,
    EvidenceSnapshot, FairnessClass, Observed, PrivacyClass, PromptWorkflow, RawOutput, RunStatus,
    SourceKind, StrategyIdentity, TriageRun, RUN_SCHEMA_V1,
};
use cd_triage_sdk::{
    ModelRef, TriageAttemptStatus, TriageReplayV1, TriageRequestV2, TriageResultKind,
    TriageResultV2, TriageRunEventPayloadV2, TriageSlotKindV2, TriageTerminalDispositionV1,
    TriageValidationState,
};
use serde::Serialize;

use crate::engine::MockRunOutcome;
use crate::error::{AdapterError, AdapterResult};
use crate::fingerprint::{fingerprint, MODEL_PREFIX, SLOT_PREFIX};
use crate::packet::BoundedPacket;
use crate::request::BoundRequest;

/// Per-slot provenance. Owner-only: it retains the exact model identity.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SlotProvenance {
    /// Host-owned slot identity.
    pub role_slot_id: String,
    /// Slot kind.
    pub role: TriageSlotKindV2,
    /// Exact gateway-scoped model identity.
    pub model: ModelRef,
    /// Fingerprint of the exact model identity.
    pub model_fingerprint: String,
    /// Fingerprint of the slot identity, kind, and model together.
    pub slot_fingerprint: String,
    /// Recorded attempt status.
    pub status: TriageAttemptStatus,
    /// Explicit per-role terminal disposition.
    pub terminal_disposition: TriageTerminalDispositionV1,
    /// Bounded reason codes.
    pub reason_codes: Vec<String>,
}

/// Every fingerprint the run preserves.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RunFingerprints {
    /// Exact policy selection.
    pub policy: String,
    /// Whole request, binding task, scope, policy, and packet together.
    pub request: String,
    /// Materialized task packet.
    pub packet: String,
    /// Bounded evidence corpus the strategy could see.
    pub corpus: String,
    /// Distinct exact model identities, sorted.
    pub models: Vec<String>,
    /// Per-slot fingerprints, in execution order.
    pub slots: Vec<String>,
}

/// Which SDK terminal the run reached, and how the bench records it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TerminalProvenance {
    /// Terminal event kind, as the public contract names it.
    pub kind: String,
    /// Opaque host failure category for failed/timed-out terminals.
    pub category: Option<String>,
    /// Cancellation identity for a cancelled terminal.
    pub cancellation_id: Option<String>,
    /// Result kind, when the terminal carries a result.
    pub result_kind: Option<TriageResultKind>,
    /// Host validation state, when the terminal carries a result.
    pub validation_state: Option<TriageValidationState>,
    /// Packet identity echoed by the result.
    pub packet_id: Option<String>,
    /// Bounded reason codes from the result.
    pub reason_codes: Vec<String>,
    /// True when a non-completed terminal carried a partial result. The
    /// partial output is provenance only; it never upgrades the bench status.
    pub partial_result_is_provenance_only: bool,
    /// Bench terminal status. Failed stays Failed even with partial output.
    pub bench_status: RunStatus,
}

/// The full owner-only record. Serialized canonically as the bench run's raw
/// output, so the run's content digest covers all of it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct OwnerOnlyRecord {
    /// SDK-side run identity.
    pub sdk_run_id: String,
    /// The exact request, including task text. Owner-only by contract.
    pub request: TriageRequestV2,
    /// The complete replay, retaining exact model identities.
    pub replay: TriageReplayV1,
    /// Preserved fingerprints.
    pub fingerprints: RunFingerprints,
    /// Per-slot provenance.
    pub slots: Vec<SlotProvenance>,
    /// Terminal provenance.
    pub terminal: TerminalProvenance,
    /// Evidence visibility the packet was bounded to.
    pub visible_item_ids: Vec<String>,
}

/// A recorded ContextDesk run: the owner-only record plus the bench row.
#[derive(Debug, Clone, PartialEq)]
pub struct RecordedContextDeskRun {
    /// The real bench run, already accepted by `TriageRun::validate`.
    pub bench_run: TriageRun,
    /// Canonical JSON of [`OwnerOnlyRecord`]; the bench raw-output bytes.
    pub raw_output: Vec<u8>,
    /// The owner-only record itself.
    pub owner_only: OwnerOnlyRecord,
}

/// Who ran the strategy and when. Supplied by the caller; the adapter reads no
/// clock, no environment, and no configuration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordingContext {
    /// Bench strategy identity.
    pub strategy: StrategyIdentity,
    /// Operator label.
    pub operator: String,
    /// RFC3339 creation timestamp.
    pub created_at: String,
}

/// Record one deterministic run as an owner-only bench row.
///
/// Fairness is [`FairnessClass::SameSnapshot`] by construction: the packet was
/// materialized from this snapshot under this task's visibility policy and the
/// run records the packet identity that proves it. Usage and cost stay
/// [`Observed::Unknown`] — the public envelope reports neither, and a gateway
/// that does not report them must not be recorded as zero.
pub fn record_run(
    snapshot: &EvidenceSnapshot,
    task: &EvaluationTask,
    bound: &BoundRequest,
    bounded: &BoundedPacket,
    outcome: &MockRunOutcome,
    context: &RecordingContext,
) -> AdapterResult<RecordedContextDeskRun> {
    if outcome.replay.run_id != bound.sdk_run_id
        || outcome.replay.request_fingerprint != bound.request_fingerprint
    {
        return Err(AdapterError::IdentityMismatch(
            "replay does not carry the bound run identity and request fingerprint".into(),
        ));
    }

    let mut slots = Vec::with_capacity(outcome.attempts.len());
    for attempt in &outcome.attempts {
        let model = attempt.model.clone().ok_or_else(|| {
            AdapterError::IdentityMismatch(format!(
                "attempt {} does not record an exact model identity",
                attempt.attempt_id
            ))
        })?;
        slots.push(SlotProvenance {
            model_fingerprint: fingerprint(MODEL_PREFIX, &model)?,
            slot_fingerprint: fingerprint(
                SLOT_PREFIX,
                &(&attempt.role_slot_id, &attempt.role, &model),
            )?,
            role_slot_id: attempt.role_slot_id.clone(),
            role: attempt.role,
            model,
            status: attempt.status,
            terminal_disposition: attempt.terminal_disposition.ok_or_else(|| {
                AdapterError::IdentityMismatch(format!(
                    "attempt {} does not record a terminal disposition",
                    attempt.attempt_id
                ))
            })?,
            reason_codes: attempt.reason_codes.clone(),
        });
    }

    let mut models: Vec<String> = slots
        .iter()
        .map(|slot| slot.model_fingerprint.clone())
        .collect();
    models.sort();
    models.dedup();

    let fingerprints = RunFingerprints {
        policy: bound.policy_fingerprint.clone(),
        request: bound.request_fingerprint.clone(),
        packet: bounded.packet_fingerprint.clone(),
        corpus: bounded.corpus_fingerprint.clone(),
        models,
        slots: slots
            .iter()
            .map(|slot| slot.slot_fingerprint.clone())
            .collect(),
    };

    let terminal = terminal_provenance(outcome)?;
    if let Some(packet_id) = &terminal.packet_id {
        if packet_id != &bounded.packet.packet_id {
            return Err(AdapterError::IdentityMismatch(
                "terminal result packet identity does not match the materialized packet".into(),
            ));
        }
    }

    let owner_only = OwnerOnlyRecord {
        sdk_run_id: bound.sdk_run_id.clone(),
        request: bound.request.clone(),
        replay: outcome.replay.clone(),
        fingerprints: fingerprints.clone(),
        slots,
        terminal: terminal.clone(),
        visible_item_ids: bounded.visible_item_ids.clone(),
    };

    let raw_output = to_canonical_json(&owner_only)
        .map_err(|_| AdapterError::Serialize)?
        .into_bytes();
    let digest = ContentDigest::of_bytes(&raw_output);
    let fairness = FairnessClass::SameSnapshot;
    let run_fingerprint = cd_triage_bench::run_fingerprint(
        &task.task_id,
        &snapshot.snapshot_id,
        SourceKind::ContextdeskSdk,
        &context.strategy.name,
        &context.strategy.version,
        &digest.hex,
        &fairness,
    )
    .map_err(AdapterError::bench)?;

    let bench_run = TriageRun {
        schema_id: RUN_SCHEMA_V1.to_string(),
        run_id: format!("run-{run_fingerprint}"),
        // The record retains task text, exact model identities, and an
        // owner-only answer envelope, so the row is owner-only.
        privacy: PrivacyClass::OwnerOnly,
        case_id: task.case_id.clone(),
        task_id: task.task_id.clone(),
        snapshot_id: snapshot.snapshot_id.clone(),
        strategy: context.strategy.clone(),
        source_kind: SourceKind::ContextdeskSdk,
        prompt_workflow: PromptWorkflow {
            // The adapter knows the workflow shape exactly and holds no model
            // prompt at all, so completeness is partial rather than exact.
            completeness: Completeness::Partial,
            prompt: Observed::Unknown,
            workflow: Observed::Known(workflow_summary(&fingerprints)),
        },
        raw_output: RawOutput {
            byte_length: raw_output.len() as u64,
            digest,
            encoding: "utf-8".to_string(),
        },
        claims: claimed_citations(outcome.result()),
        // Scripted elapsed values are not measurements, so timing stays
        // unknown rather than reporting fabricated durations.
        timing: Observed::Unknown,
        // The public envelope reports no usage or cost. Unknown is not zero.
        cost: Observed::Unknown,
        uncertainty: if terminal.reason_codes.is_empty() {
            Observed::Unknown
        } else {
            Observed::Known(terminal.reason_codes.join(","))
        },
        fairness,
        status: terminal.bench_status,
        operator: context.operator.clone(),
        importer: Some("cd-triage-bench-adapter".to_string()),
        created_at: context.created_at.clone(),
        near_duplicate_of: None,
    };
    // Real bench validator, including the run-identity fingerprint check.
    bench_run.validate().map_err(AdapterError::bench)?;

    Ok(RecordedContextDeskRun {
        bench_run,
        raw_output,
        owner_only,
    })
}

/// Identity-only workflow description. Deliberately carries no `ModelRef`, so
/// a later share-safe projection of this field cannot leak model identity.
fn workflow_summary(fingerprints: &RunFingerprints) -> String {
    format!(
        "cd-triage-bench-adapter deterministic mock; policy {}; packet {}; corpus {}; slots [{}]",
        fingerprints.policy,
        fingerprints.packet,
        fingerprints.corpus,
        fingerprints.slots.join(" ")
    )
}

fn claimed_citations(result: Option<&TriageResultV2>) -> Vec<ClaimedCitation> {
    let Some(answer) = result.and_then(|result| result.answer.as_ref()) else {
        return Vec::new();
    };
    answer
        .answer
        .candidates
        .iter()
        .flat_map(|candidate| candidate.claims.iter())
        .map(|claim| ClaimedCitation {
            claim: claim.text.clone(),
            evidence_item_id: claim.evidence_ids.first().cloned(),
            locator: None,
        })
        .collect()
}

fn terminal_provenance(outcome: &MockRunOutcome) -> AdapterResult<TerminalProvenance> {
    let (kind, category, cancellation_id, result, provenance_only) = match outcome.terminal() {
        TriageRunEventPayloadV2::Completed { result } => {
            ("completed", None, None, Some(result.as_ref()), false)
        }
        TriageRunEventPayloadV2::Failed {
            category,
            partial_result,
        } => (
            "failed",
            Some(category.clone()),
            None,
            partial_result.as_deref(),
            partial_result.is_some(),
        ),
        TriageRunEventPayloadV2::TimedOut {
            category,
            partial_result,
        } => (
            "timed_out",
            Some(category.clone()),
            None,
            partial_result.as_deref(),
            partial_result.is_some(),
        ),
        TriageRunEventPayloadV2::Cancelled {
            cancellation_id,
            partial_result,
        } => (
            "cancelled",
            None,
            Some(cancellation_id.clone()),
            partial_result.as_deref(),
            partial_result.is_some(),
        ),
        _ => {
            return Err(AdapterError::IdentityMismatch(
                "validated replay did not end in a terminal event".into(),
            ))
        }
    };

    // A Failed or TimedOut terminal stays Failed or TimedOut in the bench even
    // when it carried partial output. Partial output is provenance, not a
    // partial success.
    let bench_status = match (kind, result.map(|result| result.kind)) {
        ("completed", Some(TriageResultKind::GroundedFinal)) => RunStatus::Completed,
        ("completed", _) => RunStatus::Partial,
        ("failed", _) => RunStatus::Failed,
        ("timed_out", _) => RunStatus::TimedOut,
        ("cancelled", _) => RunStatus::Cancelled,
        _ => unreachable!("terminal kinds are exhaustive above"),
    };

    Ok(TerminalProvenance {
        kind: kind.to_string(),
        category,
        cancellation_id,
        result_kind: result.map(|result| result.kind),
        validation_state: result.map(|result| result.validation_state),
        packet_id: result.map(|result| result.packet_id.clone()),
        reason_codes: result
            .map(|result| result.reason_codes.clone())
            .unwrap_or_default(),
        partial_result_is_provenance_only: provenance_only,
        bench_status,
    })
}
