//! Host-neutral Triage Policy V2 workflow seam.
//!
//! This module deliberately stops at the workflow boundary: it compiles an
//! already supplied policy/preflight pair and offers a deterministic scripted
//! executor for contract and replay tests. It does not read configuration,
//! credentials, a filesystem, or construct/call a provider. A future host
//! adapter can implement [`TriageRoleExecutor`] while retaining this exact
//! event and terminal accounting.

use std::collections::{BTreeMap, BTreeSet};

use cd_core::extension_contract::PacketPrivacyBoundary;
use cd_core::multi_model::triage_policy::{
    compile_triage_policy_v2, CompiledRoleSlotV2, CompiledTriagePolicyV2,
    PolicyRejectionCategoryV2, ReviewerConditionV2, RoleRequirement, SlotDispositionV2,
    TriagePolicyCompileFailureV2, TriagePolicyPreflightV2, TriagePolicyV2, TriageSlotKindV2,
};
use cd_core::triage_sdk::{
    TriageAttemptStatus, TriageContractError, TriageReconciliationV1, TriageReplayV1,
    TriageResultKind, TriageResultV2, TriageRoleAttemptV1, TriageRunEventPayloadV2,
    TriageRunEventV2, TriageTerminalDispositionV1, TriageValidationState, TRIAGE_REPLAY_SCHEMA_V1,
    TRIAGE_RUN_EVENT_SCHEMA_V2,
};

/// Compile the exact policy and host-observed role facts without touching
/// configuration, credentials, providers, or a filesystem.
pub fn compile_preflight(
    policy: &TriagePolicyV2,
    preflight: &TriagePolicyPreflightV2,
) -> Result<CompiledTriagePolicyV2, TriagePolicyCompileFailureV2> {
    compile_triage_policy_v2(policy, preflight)
}

/// A deterministic role result used by mock/replay adapters. Counts are host
/// metrics only; no provider response body or model text is accepted here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MockRoleOutcome {
    /// The scripted role produced a usable typed proposal.
    Completed {
        elapsed_ms: u64,
        input_chars: u64,
        output_chars: u64,
    },
    /// The scripted role explicitly abstained.
    Abstained {
        elapsed_ms: u64,
        input_chars: u64,
        output_chars: u64,
    },
    /// The scripted role returned a contract-invalid proposal.
    Invalid {
        reason_codes: Vec<String>,
        elapsed_ms: u64,
        input_chars: u64,
        output_chars: u64,
    },
    /// No mock backend/result was available for the role.
    Unavailable { reason_codes: Vec<String> },
    /// The compiled plan intentionally did not admit this slot.
    NotAdmitted { reason_codes: Vec<String> },
    /// The scripted role exceeded its bounded operation.
    TimedOut { reason_codes: Vec<String> },
    /// The scripted role observed cooperative cancellation.
    Cancelled { reason_codes: Vec<String> },
    /// The scripted role failed without a usable proposal.
    Failed { reason_codes: Vec<String> },
}

impl MockRoleOutcome {
    /// A compact completed result for deterministic tests.
    pub fn completed() -> Self {
        Self::Completed {
            elapsed_ms: 1,
            input_chars: 1,
            output_chars: 1,
        }
    }

    fn status_and_metrics(&self) -> (TriageAttemptStatus, Vec<String>, u64, u64, u64) {
        match self {
            Self::Completed {
                elapsed_ms,
                input_chars,
                output_chars,
            } => (
                TriageAttemptStatus::Completed,
                Vec::new(),
                *elapsed_ms,
                *input_chars,
                *output_chars,
            ),
            Self::Abstained {
                elapsed_ms,
                input_chars,
                output_chars,
            } => (
                TriageAttemptStatus::Abstained,
                vec!["role_abstained".into()],
                *elapsed_ms,
                *input_chars,
                *output_chars,
            ),
            Self::Invalid {
                reason_codes,
                elapsed_ms,
                input_chars,
                output_chars,
            } => (
                TriageAttemptStatus::Invalid,
                reason_codes.clone(),
                *elapsed_ms,
                *input_chars,
                *output_chars,
            ),
            Self::Unavailable { reason_codes } => (
                TriageAttemptStatus::Unavailable,
                reason_codes.clone(),
                0,
                0,
                0,
            ),
            Self::NotAdmitted { reason_codes } => (
                TriageAttemptStatus::NotAdmitted,
                reason_codes.clone(),
                0,
                0,
                0,
            ),
            Self::TimedOut { reason_codes } => {
                (TriageAttemptStatus::TimedOut, reason_codes.clone(), 0, 0, 0)
            }
            Self::Cancelled { reason_codes } => (
                TriageAttemptStatus::Cancelled,
                reason_codes.clone(),
                0,
                0,
                0,
            ),
            Self::Failed { reason_codes } => {
                (TriageAttemptStatus::Failed, reason_codes.clone(), 0, 0, 0)
            }
        }
    }
}

/// Host-supplied deterministic source of scripted role outcomes. A future
/// provider adapter can implement this trait without changing the event seam.
pub trait TriageRoleExecutor {
    /// Return the bounded outcome for one compiled role slot.
    fn outcome(&self, slot: &CompiledRoleSlotV2) -> MockRoleOutcome;
}

/// A deterministic slot-id keyed mock script.
#[derive(Debug, Clone, Default)]
pub struct MockRoleScript {
    outcomes: BTreeMap<String, MockRoleOutcome>,
}

impl MockRoleScript {
    /// Construct an empty script. Missing slots become explicit unavailable
    /// attempts rather than being silently omitted.
    pub fn new() -> Self {
        Self::default()
    }

    /// Add or replace one slot outcome.
    pub fn with_outcome(mut self, slot_id: impl Into<String>, outcome: MockRoleOutcome) -> Self {
        self.outcomes.insert(slot_id.into(), outcome);
        self
    }
}

impl TriageRoleExecutor for MockRoleScript {
    fn outcome(&self, slot: &CompiledRoleSlotV2) -> MockRoleOutcome {
        self.outcomes
            .get(&slot.slot_id)
            .cloned()
            .unwrap_or_else(|| MockRoleOutcome::Unavailable {
                reason_codes: vec!["mock_outcome_missing".into()],
            })
    }
}

/// Identity-only packet metadata supplied by the host after packet assembly.
/// The mock seam never reads or reconstructs packet contents.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MockPacket {
    /// Opaque packet identity.
    pub packet_id: String,
    /// Opaque packet digest.
    pub packet_digest: String,
    /// Host-counted evidence rows.
    pub evidence_count: u32,
}

/// Deterministic run controls. These simulate host cancellation/deadline
/// boundaries without sleeping or contacting a provider.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct MockRunControl {
    /// Cancel before any admitted role is allowed to run.
    pub cancel_before_run: bool,
    /// Cancel before the zero-based slot index is admitted.
    pub cancel_at_slot: Option<usize>,
    /// Time out before any admitted role is allowed to run.
    pub timeout_before_run: bool,
    /// Time out before the zero-based slot index is admitted.
    pub timeout_at_slot: Option<usize>,
    /// Explicit request used by `explicit_request` reviewer conditions.
    pub explicit_review_requested: bool,
}

/// Host-owned identity and packet inputs for one mock run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MockRunInput {
    /// Opaque run identity.
    pub run_id: String,
    /// Opaque request fingerprint repeated by `run_started` and replay.
    pub request_fingerprint: String,
    /// Opaque compiled-policy fingerprint.
    pub policy_fingerprint: String,
    /// Packet identity and bounded count.
    pub packet: MockPacket,
    /// Cancellation identity carried by a cancelled terminal.
    pub cancellation_id: String,
    /// Deterministic cancellation/deadline controls.
    pub control: MockRunControl,
}

/// Result of one deterministic mock run. Compilation failures remain attached
/// to the result while still producing a complete, replay-valid event stream.
#[derive(Debug, Clone)]
pub struct MockRunResult {
    /// Compiled plan on success, or complete slot dispositions on failure.
    pub compiled: Result<CompiledTriagePolicyV2, TriagePolicyCompileFailureV2>,
    /// Ordered SDK replay, including exactly one terminal event.
    pub replay: TriageReplayV1,
}

impl MockRunResult {
    /// Validate the event/replay contract.
    pub fn validate(&self) -> Result<(), TriageContractError> {
        self.replay.validate()
    }
}

/// Deterministic policy compiler + event/replay runner.
#[derive(Debug, Clone)]
pub struct MockTriageRunner<E> {
    executor: E,
}

impl<E> MockTriageRunner<E>
where
    E: TriageRoleExecutor,
{
    /// Bind one deterministic role executor.
    pub fn new(executor: E) -> Self {
        Self { executor }
    }

    /// Compile/preflight and emit one replay-valid owner-only event stream.
    pub fn run(
        &self,
        policy: &TriagePolicyV2,
        preflight: &TriagePolicyPreflightV2,
        input: &MockRunInput,
    ) -> Result<MockRunResult, TriageContractError> {
        let compiled = compile_preflight(policy, preflight);
        let slots = match &compiled {
            Ok(plan) => plan.slots.clone(),
            Err(failure) => failure.slots.clone(),
        };
        let mut events = vec![event(
            &input.run_id,
            0,
            TriageRunEventPayloadV2::RunStarted {
                request_fingerprint: input.request_fingerprint.clone(),
                policy_fingerprint: input.policy_fingerprint.clone(),
            },
        )];
        events.push(event(
            &input.run_id,
            1,
            TriageRunEventPayloadV2::PacketReady {
                packet_id: input.packet.packet_id.clone(),
                packet_digest: input.packet.packet_digest.clone(),
                evidence_count: input.packet.evidence_count,
            },
        ));

        let mut attempts = Vec::with_capacity(slots.len());
        let mut interruption = if input.control.cancel_before_run {
            Some(Interruption::Cancelled)
        } else if input.control.timeout_before_run {
            Some(Interruption::TimedOut)
        } else {
            None
        };
        // Standard intentionally retains the established event graph. It has
        // one finalizer slot and no V2 multi-phase orchestration, so changing
        // its replay would be a product behavior change for the default mode.
        if policy.mode == cd_core::multi_model::triage_policy::TriagePolicyMode::Standard {
            for slot in &slots {
                run_scripted_slot(
                    self,
                    slot,
                    policy,
                    &compiled,
                    input,
                    &mut interruption,
                    &mut attempts,
                    &mut events,
                    None,
                );
            }
            let summary = reconciliation(&slots, &attempts);
            events.push(event(
                &input.run_id,
                events.len() as u64,
                TriageRunEventPayloadV2::Reconciliation {
                    summary: summary.clone(),
                },
            ));
            let terminal = terminal_kind(&compiled, &slots, &attempts, interruption);
            let mut reason_codes = attempts
                .iter()
                .flat_map(|attempt| attempt.reason_codes.iter().cloned())
                .collect::<Vec<_>>();
            if compiled.is_err() {
                reason_codes.push("policy_preflight_rejected".into());
            }
            if reason_codes.is_empty() {
                reason_codes.push("mock_no_authoritative_answer".into());
            }
            let reason_codes = unique_codes(reason_codes);
            let validation_passed = false;
            events.push(event(
                &input.run_id,
                events.len() as u64,
                TriageRunEventPayloadV2::Validation {
                    passed: validation_passed,
                    reason_codes: reason_codes.clone(),
                },
            ));
            let result = partial_result(
                &input.run_id,
                &input.packet.packet_id,
                summary,
                &attempts,
                &reason_codes,
                terminal == Terminal::Completed,
            );
            events.push(event(
                &input.run_id,
                events.len() as u64,
                terminal.payload(result, &input.cancellation_id),
            ));
            return finish_replay(input, compiled, events);
        }

        // Enhanced/Advanced use an explicit phase graph. Slots are grouped by
        // phase rather than policy storage order so a finalizer can never run
        // before the reviewer/challenger has seen the preliminary merge.
        let contributor_slots = slots
            .iter()
            .filter(|slot| matches!(slot.kind, TriageSlotKindV2::Contributor(_)))
            .cloned()
            .collect::<Vec<_>>();
        let reviewer_slots = slots
            .iter()
            .filter(|slot| is_reviewer(slot))
            .cloned()
            .collect::<Vec<_>>();
        let finalizer_slots = slots
            .iter()
            .filter(|slot| matches!(slot.kind, TriageSlotKindV2::Finalizer))
            .cloned()
            .collect::<Vec<_>>();
        let mut execution_slots = contributor_slots.clone();
        execution_slots.extend(reviewer_slots.iter().cloned());
        execution_slots.extend(finalizer_slots.iter().cloned());

        for slot in &contributor_slots {
            run_scripted_slot(
                self,
                slot,
                policy,
                &compiled,
                input,
                &mut interruption,
                &mut attempts,
                &mut events,
                None,
            );
        }
        let preliminary_attempts = attempts.clone();
        let preliminary_summary = reconciliation(&contributor_slots, &preliminary_attempts);
        events.push(event(
            &input.run_id,
            events.len() as u64,
            TriageRunEventPayloadV2::PreliminaryReconciliation {
                summary: preliminary_summary,
            },
        ));

        for slot in &reviewer_slots {
            let needed = reviewer_needed_for_slot(
                slot,
                policy,
                &attempts,
                input.control.explicit_review_requested,
            );
            run_scripted_slot(
                self,
                slot,
                policy,
                &compiled,
                input,
                &mut interruption,
                &mut attempts,
                &mut events,
                (!needed).then_some("reviewer_not_required"),
            );
        }

        let final_reconciliation_slots = contributor_slots
            .iter()
            .chain(reviewer_slots.iter())
            .cloned()
            .collect::<Vec<_>>();
        let final_reconciliation_attempts = attempts.clone();
        let final_summary =
            reconciliation(&final_reconciliation_slots, &final_reconciliation_attempts);
        events.push(event(
            &input.run_id,
            events.len() as u64,
            TriageRunEventPayloadV2::FinalReconciliation {
                summary: final_summary.clone(),
            },
        ));

        for slot in &finalizer_slots {
            run_scripted_slot(
                self,
                slot,
                policy,
                &compiled,
                input,
                &mut interruption,
                &mut attempts,
                &mut events,
                None,
            );
        }

        let terminal = terminal_kind(&compiled, &execution_slots, &attempts, interruption);
        let mut reason_codes = attempts
            .iter()
            .flat_map(|attempt| attempt.reason_codes.iter().cloned())
            .collect::<Vec<_>>();
        if compiled.is_err() {
            reason_codes.push("policy_preflight_rejected".into());
        }
        if reason_codes.is_empty() {
            reason_codes.push("mock_no_authoritative_answer".into());
        }
        reason_codes.push("mock_correction_not_wired".into());
        let reason_codes = unique_codes(reason_codes);
        let validation_passed = false;
        events.push(event(
            &input.run_id,
            events.len() as u64,
            TriageRunEventPayloadV2::Validation {
                passed: validation_passed,
                reason_codes: reason_codes.clone(),
            },
        ));
        let result = partial_result(
            &input.run_id,
            &input.packet.packet_id,
            final_summary,
            &attempts,
            &reason_codes,
            terminal == Terminal::Completed,
        );
        // The provider-neutral runner has no correction backend. Still emit
        // the bounded checkpoint so consumers cannot mistake validation for
        // the terminal boundary or infer an unbounded retry loop.
        events.push(event(
            &input.run_id,
            events.len() as u64,
            TriageRunEventPayloadV2::Correction {
                applied: false,
                reason_codes: vec!["mock_correction_not_wired".into()],
            },
        ));
        events.push(event(
            &input.run_id,
            events.len() as u64,
            terminal.payload(result, &input.cancellation_id),
        ));
        finish_replay(input, compiled, events)
    }

    /// Execute the same deterministic run and return only its validated
    /// ordered replay stream for SDK/JSONL contract tests.
    pub fn replay(
        &self,
        policy: &TriagePolicyV2,
        preflight: &TriagePolicyPreflightV2,
        input: &MockRunInput,
    ) -> Result<TriageReplayV1, TriageContractError> {
        self.run(policy, preflight, input)
            .map(|result| result.replay)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Interruption {
    Cancelled,
    TimedOut,
}

impl Interruption {
    fn outcome(self) -> MockRoleOutcome {
        match self {
            Self::Cancelled => MockRoleOutcome::Cancelled {
                reason_codes: vec!["cancelled".into()],
            },
            Self::TimedOut => MockRoleOutcome::TimedOut {
                reason_codes: vec!["deadline".into()],
            },
        }
    }
}

/// Execute one slot at the runner's current graph position. The helper keeps
/// cancellation/deadline accounting independent from role kind and records an
/// explicit attempt for every configured slot, including a conditional
/// reviewer that was not needed.
fn run_scripted_slot<E>(
    runner: &MockTriageRunner<E>,
    slot: &CompiledRoleSlotV2,
    _policy: &TriagePolicyV2,
    compiled: &Result<CompiledTriagePolicyV2, TriagePolicyCompileFailureV2>,
    input: &MockRunInput,
    interruption: &mut Option<Interruption>,
    attempts: &mut Vec<TriageRoleAttemptV1>,
    events: &mut Vec<TriageRunEventV2>,
    skip_reason: Option<&str>,
) -> TriageRoleAttemptV1
where
    E: TriageRoleExecutor,
{
    let index = attempts.len();
    let outcome = if compiled.is_err() {
        MockRoleOutcome::NotAdmitted {
            reason_codes: vec!["policy_preflight_rejected".into()],
        }
    } else if slot.disposition != SlotDispositionV2::Admitted {
        MockRoleOutcome::NotAdmitted {
            reason_codes: slot
                .rejections
                .iter()
                .map(|category| rejection_code(*category).into())
                .collect(),
        }
    } else if let Some(reason) = *interruption {
        reason.outcome()
    } else if input.control.cancel_at_slot == Some(index) {
        *interruption = Some(Interruption::Cancelled);
        Interruption::Cancelled.outcome()
    } else if input.control.timeout_at_slot == Some(index) {
        *interruption = Some(Interruption::TimedOut);
        Interruption::TimedOut.outcome()
    } else if let Some(reason) = skip_reason {
        MockRoleOutcome::NotAdmitted {
            reason_codes: vec![reason.into()],
        }
    } else {
        runner.executor.outcome(slot)
    };
    let attempt = role_attempt(&input.run_id, slot, outcome);
    events.push(event(
        &input.run_id,
        events.len() as u64,
        TriageRunEventPayloadV2::RoleAttempt {
            attempt: attempt.clone(),
        },
    ));
    attempts.push(attempt.clone());
    attempt
}

fn finish_replay(
    input: &MockRunInput,
    compiled: Result<CompiledTriagePolicyV2, TriagePolicyCompileFailureV2>,
    events: Vec<TriageRunEventV2>,
) -> Result<MockRunResult, TriageContractError> {
    let replay = TriageReplayV1 {
        schema_id: TRIAGE_REPLAY_SCHEMA_V1.into(),
        run_id: input.run_id.clone(),
        request_fingerprint: input.request_fingerprint.clone(),
        events,
    };
    replay.validate()?;
    Ok(MockRunResult { compiled, replay })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Terminal {
    Completed,
    Failed,
    TimedOut,
    Cancelled,
}

impl Terminal {
    fn payload(self, result: TriageResultV2, cancellation_id: &str) -> TriageRunEventPayloadV2 {
        match self {
            Self::Completed => TriageRunEventPayloadV2::Completed {
                result: Box::new(result),
            },
            Self::Failed => TriageRunEventPayloadV2::Failed {
                category: "required_role_failed".into(),
                partial_result: Some(Box::new(result)),
            },
            Self::TimedOut => TriageRunEventPayloadV2::TimedOut {
                category: "deadline".into(),
                partial_result: Some(Box::new(result)),
            },
            Self::Cancelled => TriageRunEventPayloadV2::Cancelled {
                cancellation_id: cancellation_id.into(),
                partial_result: Some(Box::new(result)),
            },
        }
    }
}

fn event(run_id: &str, sequence: u64, event: TriageRunEventPayloadV2) -> TriageRunEventV2 {
    TriageRunEventV2 {
        schema_id: TRIAGE_RUN_EVENT_SCHEMA_V2.into(),
        run_id: run_id.into(),
        sequence,
        privacy: PacketPrivacyBoundary::OwnerOnly,
        event,
    }
}

fn is_reviewer(slot: &CompiledRoleSlotV2) -> bool {
    matches!(slot.kind, TriageSlotKindV2::Reviewer)
}

fn reviewer_needed_for_slot(
    slot: &CompiledRoleSlotV2,
    policy: &TriagePolicyV2,
    attempts: &[TriageRoleAttemptV1],
    explicit_request: bool,
) -> bool {
    if !is_reviewer(slot) {
        return true;
    }
    let Some(reviewer) = policy.reviewer.as_ref() else {
        return false;
    };
    match reviewer.condition {
        ReviewerConditionV2::ExplicitRequest => explicit_request,
        ReviewerConditionV2::ContestedOrIncomplete => attempts.iter().any(|attempt| {
            matches!(attempt.role, TriageSlotKindV2::Contributor(_))
                && attempt.status != TriageAttemptStatus::Completed
        }),
    }
}

fn role_attempt(
    run_id: &str,
    slot: &CompiledRoleSlotV2,
    outcome: MockRoleOutcome,
) -> TriageRoleAttemptV1 {
    let (status, reasons, elapsed_ms, input_chars, output_chars) = outcome.status_and_metrics();
    let physical_provider_calls = match status {
        TriageAttemptStatus::Completed
        | TriageAttemptStatus::Abstained
        | TriageAttemptStatus::Invalid => Some(1),
        TriageAttemptStatus::Unavailable
        | TriageAttemptStatus::NotAdmitted
        | TriageAttemptStatus::TimedOut
        | TriageAttemptStatus::Cancelled
        | TriageAttemptStatus::Failed => Some(0),
    };
    let terminal_disposition = Some(match status {
        TriageAttemptStatus::Completed => TriageTerminalDispositionV1::Completed,
        TriageAttemptStatus::Abstained => TriageTerminalDispositionV1::Abstained,
        TriageAttemptStatus::Invalid => TriageTerminalDispositionV1::Invalid,
        TriageAttemptStatus::Unavailable => TriageTerminalDispositionV1::Unavailable,
        TriageAttemptStatus::TimedOut => TriageTerminalDispositionV1::TimedOut,
        TriageAttemptStatus::Cancelled => TriageTerminalDispositionV1::Cancelled,
        TriageAttemptStatus::Failed => TriageTerminalDispositionV1::Failed,
        TriageAttemptStatus::NotAdmitted => TriageTerminalDispositionV1::NotAdmitted,
    });
    TriageRoleAttemptV1 {
        attempt_id: format!("attempt:{run_id}:{}", slot.slot_id),
        role_slot_id: slot.slot_id.clone(),
        role: slot.kind,
        model: slot.model.validate().ok().map(|_| slot.model.clone()),
        status,
        reason_codes: unique_codes(reasons),
        elapsed_ms,
        input_chars,
        output_chars,
        physical_provider_calls,
        semantic_corrections: Some(0),
        terminal_disposition,
    }
}

fn reconciliation(
    slots: &[CompiledRoleSlotV2],
    attempts: &[TriageRoleAttemptV1],
) -> TriageReconciliationV1 {
    let completed = attempts
        .iter()
        .filter(|attempt| attempt.status == TriageAttemptStatus::Completed)
        .collect::<Vec<_>>();
    let models = completed
        .iter()
        .filter_map(|attempt| attempt.model.as_ref())
        .collect::<BTreeSet<_>>();
    let gateways = models
        .iter()
        .map(|model| model.profile_id.as_str())
        .collect::<BTreeSet<_>>();
    let state = if completed.is_empty() {
        "deterministic_baseline"
    } else if completed.len() == slots.len()
        && attempts
            .iter()
            .all(|attempt| attempt.status == TriageAttemptStatus::Completed)
    {
        "supported"
    } else {
        "insufficient_evidence"
    };
    TriageReconciliationV1 {
        state: state.into(),
        configured_role_slots: slots.len() as u32,
        completed_role_slots: completed.len() as u32,
        distinct_models: models.len() as u32,
        distinct_gateways: gateways.len() as u32,
        supported_claim_ids: Vec::new(),
        conflict_ids: Vec::new(),
        gap_ids: Vec::new(),
        root_cause_established: false,
    }
}

fn partial_result(
    run_id: &str,
    packet_id: &str,
    summary: TriageReconciliationV1,
    attempts: &[TriageRoleAttemptV1],
    reason_codes: &[String],
    completed_terminal: bool,
) -> TriageResultV2 {
    TriageResultV2 {
        schema_id: cd_core::triage_sdk::TRIAGE_RESULT_SCHEMA_V2.into(),
        run_id: run_id.into(),
        kind: TriageResultKind::HonestPartial,
        validation_state: if completed_terminal {
            TriageValidationState::Partial
        } else {
            TriageValidationState::Failed
        },
        packet_id: packet_id.into(),
        reconciliation: summary,
        answer: None,
        accepted_evidence_ids: Vec::new(),
        reason_codes: unique_codes(
            reason_codes
                .iter()
                .cloned()
                .chain(
                    attempts
                        .iter()
                        .flat_map(|attempt| attempt.reason_codes.iter().cloned()),
                )
                .collect(),
        ),
    }
}

fn terminal_kind(
    compiled: &Result<CompiledTriagePolicyV2, TriagePolicyCompileFailureV2>,
    slots: &[CompiledRoleSlotV2],
    attempts: &[TriageRoleAttemptV1],
    interruption: Option<Interruption>,
) -> Terminal {
    if compiled.is_err() {
        return Terminal::Failed;
    }
    if let Some(interruption) = interruption {
        return match interruption {
            Interruption::Cancelled => Terminal::Cancelled,
            Interruption::TimedOut => Terminal::TimedOut,
        };
    }
    for (slot, attempt) in slots.iter().zip(attempts) {
        if slot.requirement != RoleRequirement::Required {
            continue;
        }
        match attempt.status {
            TriageAttemptStatus::Cancelled => return Terminal::Cancelled,
            TriageAttemptStatus::TimedOut => return Terminal::TimedOut,
            TriageAttemptStatus::Completed | TriageAttemptStatus::Abstained => {}
            TriageAttemptStatus::NotAdmitted
                if is_reviewer(slot)
                    && attempt
                        .reason_codes
                        .iter()
                        .any(|reason| reason == "reviewer_not_required") => {}
            TriageAttemptStatus::Invalid
            | TriageAttemptStatus::Unavailable
            | TriageAttemptStatus::Failed
            | TriageAttemptStatus::NotAdmitted => return Terminal::Failed,
        }
    }
    Terminal::Completed
}

fn rejection_code(category: PolicyRejectionCategoryV2) -> &'static str {
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

fn unique_codes(codes: Vec<String>) -> Vec<String> {
    let mut unique = BTreeSet::new();
    codes
        .into_iter()
        .filter(|code| unique.insert(code.clone()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use cd_core::model_ref::ModelRef;
    use cd_core::multi_model::triage_policy::{
        ContributorSlotV2, FinalizerSlotV2, ReviewerConditionV2, ReviewerSlotV2, RolePreflightV2,
        RoleQualificationV2, TriageContributorRole, TriagePolicyMode,
    };

    fn model(profile: &str, model_id: &str) -> ModelRef {
        ModelRef {
            profile_id: profile.into(),
            model_id: model_id.into(),
        }
    }

    fn policy() -> TriagePolicyV2 {
        TriagePolicyV2 {
            schema_id: cd_core::multi_model::triage_policy::TRIAGE_POLICY_SCHEMA_V2.into(),
            mode: TriagePolicyMode::Enhanced,
            contributors: vec![ContributorSlotV2 {
                slot_id: "observe".into(),
                role: TriageContributorRole::ObservationExtractor,
                model: model("gateway-a", "model-a"),
                requirement: RoleRequirement::Required,
                allow_remote: false,
            }],
            finalizer: Some(FinalizerSlotV2 {
                slot_id: "finalize".into(),
                model: model("gateway-a", "model-a"),
                requirement: RoleRequirement::Required,
                allow_remote: false,
            }),
            reviewer: Some(ReviewerSlotV2 {
                slot_id: "review".into(),
                model: model("gateway-b", "model-b"),
                condition: ReviewerConditionV2::ContestedOrIncomplete,
                requirement: RoleRequirement::Optional,
                allow_remote: false,
            }),
            budget: Default::default(),
            execution: Default::default(),
        }
    }

    fn preflight(policy: &TriagePolicyV2) -> TriagePolicyPreflightV2 {
        let mut roles = vec![RolePreflightV2 {
            slot_id: "observe".into(),
            model: model("gateway-a", "model-a"),
            kind: TriageSlotKindV2::Contributor(TriageContributorRole::ObservationExtractor),
            available: true,
            qualification: RoleQualificationV2::Qualified,
            remote: false,
            qualification_schema_id: Some(TRIAGE_QUALIFICATION_SCHEMA_V2.into()),
            workflow_id: Some(TRIAGE_QUALIFICATION_WORKFLOW_V2.into()),
            protocol_fingerprint: Some("sha256:triage-fixture-protocol".into()),
        }];
        roles.push(RolePreflightV2 {
            slot_id: "finalize".into(),
            model: model("gateway-a", "model-a"),
            kind: TriageSlotKindV2::Finalizer,
            available: true,
            qualification: RoleQualificationV2::Qualified,
            remote: false,
            qualification_schema_id: Some(TRIAGE_QUALIFICATION_SCHEMA_V2.into()),
            workflow_id: Some(TRIAGE_QUALIFICATION_WORKFLOW_V2.into()),
            protocol_fingerprint: Some("sha256:triage-fixture-protocol".into()),
        });
        roles.push(RolePreflightV2 {
            slot_id: "review".into(),
            model: model("gateway-b", "model-b"),
            kind: TriageSlotKindV2::Reviewer,
            available: true,
            qualification: RoleQualificationV2::Qualified,
            remote: false,
            qualification_schema_id: Some(TRIAGE_QUALIFICATION_SCHEMA_V2.into()),
            workflow_id: Some(TRIAGE_QUALIFICATION_WORKFLOW_V2.into()),
            protocol_fingerprint: Some("sha256:triage-fixture-protocol".into()),
        });
        let _ = policy;
        TriagePolicyPreflightV2 { roles }
    }

    fn input() -> MockRunInput {
        MockRunInput {
            run_id: "run:mock:1".into(),
            request_fingerprint: "request:fingerprint:1".into(),
            policy_fingerprint: "policy:fingerprint:1".into(),
            packet: MockPacket {
                packet_id: "packet:mock:1".into(),
                packet_digest: "packet:digest:1".into(),
                evidence_count: 2,
            },
            cancellation_id: "cancel:mock:1".into(),
            control: MockRunControl::default(),
        }
    }

    #[test]
    fn compile_and_mock_stream_is_ordered_and_single_terminal() {
        let script = MockRoleScript::new()
            .with_outcome("observe", MockRoleOutcome::completed())
            .with_outcome("finalize", MockRoleOutcome::completed());
        let result = MockTriageRunner::new(script)
            .run(&policy(), &preflight(&policy()), &input())
            .expect("mock replay");
        result.validate().unwrap();
        assert!(result.compiled.is_ok());
        assert!(matches!(
            result.replay.events.first().unwrap().event,
            TriageRunEventPayloadV2::RunStarted { .. }
        ));
        assert!(matches!(
            result.replay.events[1].event,
            TriageRunEventPayloadV2::PacketReady { .. }
        ));
        assert_eq!(
            result
                .replay
                .events
                .iter()
                .filter(|event| event.event.is_terminal())
                .count(),
            1
        );
        assert!(matches!(
            result.replay.events.last().unwrap().event,
            TriageRunEventPayloadV2::Completed { .. }
        ));
        let attempts = result
            .replay
            .events
            .iter()
            .filter_map(|event| match &event.event {
                TriageRunEventPayloadV2::RoleAttempt { attempt } => Some(attempt),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(attempts[1].status, TriageAttemptStatus::NotAdmitted);
        assert!(attempts[1]
            .reason_codes
            .contains(&"reviewer_not_required".into()));
    }

    #[test]
    fn stream_order_places_reconciliation_and_validation_before_terminal() {
        let script = MockRoleScript::new()
            .with_outcome("observe", MockRoleOutcome::completed())
            .with_outcome("finalize", MockRoleOutcome::completed());
        let result = MockTriageRunner::new(script)
            .run(&policy(), &preflight(&policy()), &input())
            .unwrap();
        let kinds = result
            .replay
            .events
            .iter()
            .map(|event| &event.event)
            .collect::<Vec<_>>();
        assert!(matches!(
            kinds[2],
            TriageRunEventPayloadV2::RoleAttempt { .. }
        ));
        assert!(matches!(
            kinds[3],
            TriageRunEventPayloadV2::PreliminaryReconciliation { .. }
        ));
        assert!(matches!(
            kinds[4],
            TriageRunEventPayloadV2::RoleAttempt { .. }
        ));
        assert!(matches!(
            kinds[5],
            TriageRunEventPayloadV2::FinalReconciliation { .. }
        ));
        assert!(matches!(
            kinds[6],
            TriageRunEventPayloadV2::RoleAttempt { .. }
        ));
        assert!(matches!(
            kinds[7],
            TriageRunEventPayloadV2::Validation { .. }
        ));
        assert!(matches!(
            kinds[8],
            TriageRunEventPayloadV2::Correction { .. }
        ));
        assert!(kinds[9].is_terminal());
    }

    #[test]
    fn canonical_graph_reconciles_before_reviewer_and_finalizer() {
        let mut policy = policy();
        policy.reviewer.as_mut().unwrap().condition = ReviewerConditionV2::ExplicitRequest;
        let script = MockRoleScript::new()
            .with_outcome("observe", MockRoleOutcome::completed())
            .with_outcome("review", MockRoleOutcome::completed())
            .with_outcome("finalize", MockRoleOutcome::completed());
        let mut input = input();
        input.control.explicit_review_requested = true;
        let result = MockTriageRunner::new(script)
            .run(&policy, &preflight(&policy), &input)
            .expect("canonical replay");
        result.validate().unwrap();

        let events = &result.replay.events;
        let attempts = events
            .iter()
            .filter_map(|event| match &event.event {
                TriageRunEventPayloadV2::RoleAttempt { attempt } => Some(attempt),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(
            attempts
                .iter()
                .map(|attempt| attempt.role_slot_id.as_str())
                .collect::<Vec<_>>(),
            ["observe", "review", "finalize"]
        );
        let preliminary = events
            .iter()
            .find_map(|event| match &event.event {
                TriageRunEventPayloadV2::PreliminaryReconciliation { summary } => Some(summary),
                _ => None,
            })
            .expect("preliminary reconciliation");
        assert_eq!(preliminary.configured_role_slots, 1);
        assert_eq!(preliminary.completed_role_slots, 1);
        let final_summary = events
            .iter()
            .find_map(|event| match &event.event {
                TriageRunEventPayloadV2::FinalReconciliation { summary } => Some(summary),
                _ => None,
            })
            .expect("final reconciliation");
        assert_eq!(final_summary.configured_role_slots, 2);
        assert_eq!(final_summary.completed_role_slots, 2);
        assert_eq!(final_summary.distinct_models, 2);

        let final_reconciliation_index = events
            .iter()
            .position(|event| {
                matches!(
                    event.event,
                    TriageRunEventPayloadV2::FinalReconciliation { .. }
                )
            })
            .unwrap();
        let finalizer_index = events
            .iter()
            .position(|event| {
                matches!(
                    event.event,
                    TriageRunEventPayloadV2::RoleAttempt { ref attempt }
                        if attempt.role_slot_id == "finalize"
                )
            })
            .unwrap();
        let validation_index = events
            .iter()
            .position(|event| matches!(event.event, TriageRunEventPayloadV2::Validation { .. }))
            .unwrap();
        let correction_index = events
            .iter()
            .position(|event| matches!(event.event, TriageRunEventPayloadV2::Correction { .. }))
            .unwrap();
        assert!(final_reconciliation_index < finalizer_index);
        assert!(finalizer_index < validation_index);
        assert!(validation_index < correction_index);
        assert!(correction_index + 1 == events.len() - 1);
    }

    #[test]
    fn standard_graph_retains_legacy_single_finalizer_sequence() {
        let policy = TriagePolicyV2::standard(model("gateway-a", "model-a"), false);
        let preflight = TriagePolicyPreflightV2 {
            roles: vec![RolePreflightV2 {
                slot_id: "standard-finalizer".into(),
                model: model("gateway-a", "model-a"),
                kind: TriageSlotKindV2::Finalizer,
                available: true,
                qualification: RoleQualificationV2::Qualified,
                remote: false,
            }],
        };
        let input = input();
        let result = MockTriageRunner::new(
            MockRoleScript::new().with_outcome("standard-finalizer", MockRoleOutcome::completed()),
        )
        .run(&policy, &preflight, &input)
        .expect("standard replay");
        result.validate().unwrap();
        let kinds = result
            .replay
            .events
            .iter()
            .map(|event| &event.event)
            .collect::<Vec<_>>();
        assert!(matches!(
            kinds[2],
            TriageRunEventPayloadV2::RoleAttempt { .. }
        ));
        assert!(matches!(
            kinds[3],
            TriageRunEventPayloadV2::Reconciliation { .. }
        ));
        assert!(matches!(
            kinds[4],
            TriageRunEventPayloadV2::Validation { .. }
        ));
        assert!(kinds[5].is_terminal());
        assert!(!kinds.iter().any(|event| {
            matches!(
                *event,
                TriageRunEventPayloadV2::PreliminaryReconciliation { .. }
                    | TriageRunEventPayloadV2::FinalReconciliation { .. }
                    | TriageRunEventPayloadV2::Correction { .. }
            )
        }));
    }

    #[test]
    fn same_model_roles_are_one_reconciliation_model() {
        let mut policy = policy();
        policy.contributors[0].model = model("gateway-a", "shared-model");
        policy.finalizer.as_mut().unwrap().model = model("gateway-a", "shared-model");
        policy.reviewer.as_mut().unwrap().model = model("gateway-a", "shared-model");
        policy.reviewer.as_mut().unwrap().condition = ReviewerConditionV2::ExplicitRequest;
        let script = MockRoleScript::new()
            .with_outcome("observe", MockRoleOutcome::completed())
            .with_outcome("review", MockRoleOutcome::completed())
            .with_outcome("finalize", MockRoleOutcome::completed());
        let mut input = input();
        input.control.explicit_review_requested = true;
        let result = MockTriageRunner::new(script)
            .run(&policy, &preflight(&policy), &input)
            .expect("same-model replay");
        let summary = result
            .replay
            .events
            .iter()
            .find_map(|event| match &event.event {
                TriageRunEventPayloadV2::FinalReconciliation { summary } => Some(summary),
                _ => None,
            })
            .expect("final reconciliation");
        assert_eq!(summary.completed_role_slots, 2);
        assert_eq!(summary.distinct_models, 1);
        assert_eq!(summary.distinct_gateways, 1);
    }

    #[test]
    fn optional_dropout_is_explicit_and_reviewer_is_not_admitted_without_need() {
        let mut policy = policy();
        policy.contributors[0].requirement = RoleRequirement::Optional;
        let mut facts = preflight(&policy);
        facts.roles[0].available = false;
        let result = MockTriageRunner::new(MockRoleScript::new())
            .run(&policy, &facts, &input())
            .expect("optional policy remains compilable");
        let attempts = result
            .replay
            .events
            .iter()
            .filter_map(|event| match &event.event {
                TriageRunEventPayloadV2::RoleAttempt { attempt } => Some(attempt),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(attempts.len(), 3);
        assert_eq!(attempts[0].status, TriageAttemptStatus::NotAdmitted);
        assert!(attempts[0]
            .reason_codes
            .contains(&"role_unavailable".into()));
        assert_eq!(attempts[2].status, TriageAttemptStatus::Unavailable);
        assert!(attempts[2]
            .reason_codes
            .contains(&"mock_outcome_missing".into()));
    }

    #[test]
    fn explicit_request_condition_is_the_only_reviewer_trigger() {
        let mut policy = policy();
        policy.reviewer.as_mut().unwrap().condition = ReviewerConditionV2::ExplicitRequest;
        let script = MockRoleScript::new()
            .with_outcome("observe", MockRoleOutcome::completed())
            .with_outcome("finalize", MockRoleOutcome::completed());
        let mut input = input();
        let no_request = MockTriageRunner::new(script.clone())
            .run(&policy, &preflight(&policy), &input)
            .unwrap();
        let no_request_attempts = no_request
            .replay
            .events
            .iter()
            .filter_map(|event| match &event.event {
                TriageRunEventPayloadV2::RoleAttempt { attempt } => Some(attempt),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert!(no_request_attempts[1]
            .reason_codes
            .contains(&"reviewer_not_required".into()));

        input.control.explicit_review_requested = true;
        let requested = MockTriageRunner::new(script)
            .run(&policy, &preflight(&policy), &input)
            .unwrap();
        let requested_attempts = requested
            .replay
            .events
            .iter()
            .filter_map(|event| match &event.event {
                TriageRunEventPayloadV2::RoleAttempt { attempt } => Some(attempt),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert!(requested_attempts[1]
            .reason_codes
            .contains(&"mock_outcome_missing".into()));
    }

    #[test]
    fn compile_failure_still_accounts_slots_and_fails_once() {
        let policy = policy();
        let mut facts = preflight(&policy);
        facts.roles[0].qualification = RoleQualificationV2::Unqualified;
        let result = MockTriageRunner::new(MockRoleScript::new())
            .run(&policy, &facts, &input())
            .unwrap();
        assert!(result.compiled.is_err());
        result.validate().unwrap();
        let attempts = result
            .replay
            .events
            .iter()
            .filter_map(|event| match &event.event {
                TriageRunEventPayloadV2::RoleAttempt { attempt } => Some(attempt),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(attempts.len(), 3);
        assert!(attempts
            .iter()
            .all(|attempt| attempt.status == TriageAttemptStatus::NotAdmitted));
        assert!(matches!(
            result.replay.events.last().unwrap().event,
            TriageRunEventPayloadV2::Failed {
                partial_result: Some(_),
                ..
            }
        ));
    }

    #[test]
    fn cancellation_has_all_attempts_and_one_cancelled_terminal() {
        let mut input = input();
        input.control.cancel_at_slot = Some(1);
        let script = MockRoleScript::new()
            .with_outcome("observe", MockRoleOutcome::completed())
            .with_outcome("finalize", MockRoleOutcome::completed());
        let result = MockTriageRunner::new(script)
            .run(&policy(), &preflight(&policy()), &input)
            .expect("cancelled replay");
        result.validate().unwrap();
        let attempts = result
            .replay
            .events
            .iter()
            .filter_map(|event| match &event.event {
                TriageRunEventPayloadV2::RoleAttempt { attempt } => Some(attempt),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(attempts.len(), 3);
        assert!(attempts
            .iter()
            .skip(1)
            .all(|attempt| attempt.status == TriageAttemptStatus::Cancelled));
        assert!(matches!(
            result.replay.events.last().unwrap().event,
            TriageRunEventPayloadV2::Cancelled { .. }
        ));
    }

    #[test]
    fn timeout_has_all_attempts_and_one_timed_out_terminal() {
        let mut input = input();
        input.control.timeout_before_run = true;
        let result = MockTriageRunner::new(MockRoleScript::new())
            .run(&policy(), &preflight(&policy()), &input)
            .expect("timed-out replay");
        result.validate().unwrap();
        let attempts = result
            .replay
            .events
            .iter()
            .filter_map(|event| match &event.event {
                TriageRunEventPayloadV2::RoleAttempt { attempt } => Some(attempt),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(attempts.len(), 3);
        assert!(attempts
            .iter()
            .skip(1)
            .all(|attempt| attempt.status == TriageAttemptStatus::TimedOut));
        assert!(matches!(
            result.replay.events.last().unwrap().event,
            TriageRunEventPayloadV2::TimedOut { .. }
        ));
    }

    #[test]
    fn required_dropout_fails_with_honest_partial_and_replays_deterministically() {
        let script = MockRoleScript::new().with_outcome(
            "observe",
            MockRoleOutcome::Failed {
                reason_codes: vec!["mock_provider_failed".into()],
            },
        );
        let first = MockTriageRunner::new(script.clone())
            .run(&policy(), &preflight(&policy()), &input())
            .unwrap();
        let second = MockTriageRunner::new(script)
            .run(&policy(), &preflight(&policy()), &input())
            .unwrap();
        assert_eq!(first.replay, second.replay);
        assert!(matches!(
            first.replay.events.last().unwrap().event,
            TriageRunEventPayloadV2::Failed {
                partial_result: Some(_),
                ..
            }
        ));
    }

    #[test]
    fn mock_stream_contains_no_task_or_provider_body_text() {
        let mut input = input();
        input.request_fingerprint = "request:fingerprint:secret-task-never-added".into();
        let result = MockTriageRunner::new(MockRoleScript::new())
            .run(&policy(), &preflight(&policy()), &input)
            .unwrap();
        let encoded = serde_json::to_string(&result.replay).unwrap();
        assert!(!encoded.contains("provider response"));
        assert!(!encoded.contains("user task"));
        assert!(encoded.contains("request:fingerprint:secret-task-never-added"));
    }

    #[test]
    fn seam_has_no_host_runtime_imports() {
        let source = include_str!("triage.rs");
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
