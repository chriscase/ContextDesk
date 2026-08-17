//! Deterministic, offline mock engine.
//!
//! This module emits a genuine `cd_triage_sdk` event stream and hands it to
//! the genuine [`TriageReplayV1::validate`]. It declares no event schema, no
//! phase-order table, and no terminal-count rule of its own: if the public
//! validator rejects the stream, the adapter fails closed.
//!
//! The mock performs no provider operation. It therefore reports zero
//! physical provider calls and zero semantic corrections, and every attempt is
//! a scripted host observation rather than a measurement. Any "answer" it
//! produces is derived from packet identities — never from model text and
//! never from evidence bytes, which the adapter does not hold.

use std::collections::BTreeSet;

use cd_triage_sdk::{
    AnswerBindingV1, AnswerEnvelopeV1, CanonicalCitationV1, ClaimKind, ClaimStatus, EvidenceRole,
    HostEvidenceEntry, InvestigationAnswerV1, InvestigationCandidateV1, InvestigationClaimV1,
    LogSnapshotRevisionV1, ModelRef, PacketPrivacyBoundary, TriageAttemptStatus,
    TriageReconciliationV1, TriageReplayV1, TriageResultKind, TriageResultV2, TriageRoleAttemptV1,
    TriageRunEventPayloadV2, TriageRunEventV2, TriageSlotKindV2, TriageValidationState, SCHEMA_V1,
    TRIAGE_REPLAY_SCHEMA_V1, TRIAGE_RESULT_SCHEMA_V2, TRIAGE_RUN_EVENT_SCHEMA_V2,
};

use crate::error::{AdapterError, AdapterResult};
use crate::fingerprint::fingerprint;
use crate::packet::BoundedPacket;
use crate::request::BoundRequest;

/// Reason code stamped on every mock result so a recorded run can never be
/// mistaken for a model-produced answer.
pub const DETERMINISTIC_MOCK_REASON_CODE: &str = "deterministic_mock";

/// Scripted outcome for one role slot. Counts are host metrics; no provider
/// response body or model text is accepted here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MockSlotOutcome {
    /// The slot produced a usable typed proposal.
    Completed {
        /// Scripted elapsed milliseconds. Not a measurement.
        elapsed_ms: u64,
        /// Scripted input character count.
        input_chars: u64,
        /// Scripted output character count.
        output_chars: u64,
    },
    /// The slot explicitly abstained.
    Abstained,
    /// The slot returned a contract-invalid proposal.
    Invalid,
    /// No mock backend was available for the slot.
    Unavailable,
    /// The compiled plan intentionally did not admit the slot.
    NotAdmitted,
    /// The slot exceeded its bounded operation.
    TimedOut,
    /// The slot observed cooperative cancellation.
    Cancelled,
    /// The slot failed without a usable proposal.
    Failed,
}

impl MockSlotOutcome {
    /// A compact completed outcome for deterministic fixtures.
    pub fn completed() -> Self {
        Self::Completed {
            elapsed_ms: 1,
            input_chars: 1,
            output_chars: 1,
        }
    }

    fn status(&self) -> TriageAttemptStatus {
        match self {
            Self::Completed { .. } => TriageAttemptStatus::Completed,
            Self::Abstained => TriageAttemptStatus::Abstained,
            Self::Invalid => TriageAttemptStatus::Invalid,
            Self::Unavailable => TriageAttemptStatus::Unavailable,
            Self::NotAdmitted => TriageAttemptStatus::NotAdmitted,
            Self::TimedOut => TriageAttemptStatus::TimedOut,
            Self::Cancelled => TriageAttemptStatus::Cancelled,
            Self::Failed => TriageAttemptStatus::Failed,
        }
    }

    fn reason_code(&self) -> Option<&'static str> {
        match self {
            Self::Completed { .. } => None,
            Self::Abstained => Some("role_abstained"),
            Self::Invalid => Some("role_invalid_proposal"),
            Self::Unavailable => Some("role_unavailable"),
            Self::NotAdmitted => Some("role_not_admitted"),
            Self::TimedOut => Some("role_deadline"),
            Self::Cancelled => Some("role_cancelled"),
            Self::Failed => Some("role_failed"),
        }
    }

    fn metrics(&self) -> (u64, u64, u64) {
        match self {
            Self::Completed {
                elapsed_ms,
                input_chars,
                output_chars,
            } => (*elapsed_ms, *input_chars, *output_chars),
            _ => (0, 0, 0),
        }
    }
}

/// One scripted role slot: its identity, its exact model, and its outcome.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MockSlotPlan {
    /// Host-owned slot identity.
    pub role_slot_id: String,
    /// Slot kind. Finalizer and reviewer stay distinct from contributors.
    pub role: TriageSlotKindV2,
    /// Exact gateway-scoped model identity for the slot.
    pub model: ModelRef,
    /// Scripted outcome.
    pub outcome: MockSlotOutcome,
}

/// The host validation checkpoint.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MockValidation {
    /// Whether host validation passed.
    pub passed: bool,
    /// Bounded reason codes.
    pub reason_codes: Vec<String>,
}

/// The bounded semantic-correction checkpoint.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MockCorrection {
    /// Whether a correction was applied.
    pub applied: bool,
    /// Bounded reason codes.
    pub reason_codes: Vec<String>,
}

/// Which terminal the scripted run reaches.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MockTerminalPlan {
    /// Grounded final answer. Requires a passed validation checkpoint.
    Completed,
    /// Completed terminal carrying an honest partial result.
    CompletedPartial,
    /// Failed terminal. `partial_result` is provenance only; the recorded run
    /// stays Failed.
    Failed {
        /// Opaque host failure category.
        category: String,
        /// Attach an honest-partial result as provenance.
        partial_result: bool,
    },
    /// Timed-out terminal.
    TimedOut {
        /// Opaque host failure category.
        category: String,
        /// Attach an honest-partial result as provenance.
        partial_result: bool,
    },
    /// Cancelled terminal. The contract allows this before validation.
    Cancelled {
        /// Attach an honest-partial result as provenance.
        partial_result: bool,
    },
}

/// A complete deterministic script for one run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MockEnginePlan {
    /// Role slots in execution order.
    pub slots: Vec<MockSlotPlan>,
    /// Host validation checkpoint. `None` is only legal for a cancelled
    /// terminal, which the public contract allows to precede validation.
    pub validation: Option<MockValidation>,
    /// Optional bounded correction checkpoint, emitted after validation.
    pub correction: Option<MockCorrection>,
    /// Terminal event.
    pub terminal: MockTerminalPlan,
}

/// The validated output of one deterministic run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MockRunOutcome {
    /// Ordered owner-only replay. Already accepted by the real validator.
    pub replay: TriageReplayV1,
    /// Every recorded role attempt, in emission order.
    pub attempts: Vec<TriageRoleAttemptV1>,
    /// Reconciliation summary carried by the terminal result, when there is one.
    pub reconciliation: TriageReconciliationV1,
}

impl MockRunOutcome {
    /// The single terminal payload. The replay validator has already proved
    /// exactly one exists and that it is last.
    pub fn terminal(&self) -> &TriageRunEventPayloadV2 {
        &self
            .replay
            .events
            .last()
            .expect("validated replay has a terminal event")
            .event
    }

    /// The authoritative or partial result attached to the terminal, if any.
    pub fn result(&self) -> Option<&TriageResultV2> {
        match self.terminal() {
            TriageRunEventPayloadV2::Completed { result } => Some(result),
            TriageRunEventPayloadV2::Failed { partial_result, .. }
            | TriageRunEventPayloadV2::TimedOut { partial_result, .. }
            | TriageRunEventPayloadV2::Cancelled { partial_result, .. } => {
                partial_result.as_deref()
            }
            _ => None,
        }
    }
}

/// Run `plan` against the bound request and packet, and return a replay the
/// real public validator accepted.
pub fn run_deterministic_mock(
    bound: &BoundRequest,
    bounded: &BoundedPacket,
    plan: &MockEnginePlan,
) -> AdapterResult<MockRunOutcome> {
    if plan.validation.is_none() && !matches!(plan.terminal, MockTerminalPlan::Cancelled { .. }) {
        return Err(AdapterError::UnrealizablePlan(
            "only a cancelled terminal may omit the host validation checkpoint".into(),
        ));
    }

    let run_id = bound.sdk_run_id.as_str();
    let mut events = Vec::new();
    let mut attempts = Vec::new();

    push(
        &mut events,
        run_id,
        TriageRunEventPayloadV2::RunStarted {
            request_fingerprint: bound.request_fingerprint.clone(),
            policy_fingerprint: bound.policy_fingerprint.clone(),
        },
    );
    push(
        &mut events,
        run_id,
        TriageRunEventPayloadV2::PacketReady {
            packet_id: bounded.packet.packet_id.clone(),
            packet_digest: bounded.packet_fingerprint.clone(),
            evidence_count: bounded.evidence_count,
        },
    );

    let contributors: Vec<&MockSlotPlan> = plan
        .slots
        .iter()
        .filter(|slot| matches!(slot.role, TriageSlotKindV2::Contributor(_)))
        .collect();
    let reviewers: Vec<&MockSlotPlan> = plan
        .slots
        .iter()
        .filter(|slot| slot.role == TriageSlotKindV2::Reviewer)
        .collect();
    let finalizers: Vec<&MockSlotPlan> = plan
        .slots
        .iter()
        .filter(|slot| slot.role == TriageSlotKindV2::Finalizer)
        .collect();
    if finalizers.len() > 1 || reviewers.len() > 1 {
        return Err(AdapterError::UnrealizablePlan(
            "the public phase order admits at most one finalizer and one reviewer".into(),
        ));
    }

    // The legacy "standard" shape is a lone finalizer with a single
    // reconciliation. Anything with contributors or a reviewer uses the V2
    // preliminary/final reconciliation graph. This mirrors the phase table the
    // public validator enforces; it does not restate it.
    let legacy_shape = contributors.is_empty() && reviewers.is_empty();
    // The reconciliation event and the terminal result must agree about
    // whether a root cause was established, in both shapes.
    let root_cause = matches!(plan.terminal, MockTerminalPlan::Completed);

    if legacy_shape {
        for slot in &finalizers {
            attempts.push(emit_attempt(&mut events, run_id, slot, attempts.len())?);
        }
        let summary = reconcile(&plan.slots, &attempts, root_cause)?;
        push(
            &mut events,
            run_id,
            TriageRunEventPayloadV2::Reconciliation {
                summary: summary.clone(),
            },
        );
        finish(
            &mut events,
            run_id,
            bound,
            bounded,
            plan,
            &attempts,
            summary.clone(),
        )?;
        return assemble(bound, events, attempts, summary);
    }

    for slot in &contributors {
        attempts.push(emit_attempt(&mut events, run_id, slot, attempts.len())?);
    }
    let preliminary = reconcile(&plan.slots, &attempts, false)?;
    push(
        &mut events,
        run_id,
        TriageRunEventPayloadV2::PreliminaryReconciliation {
            summary: preliminary,
        },
    );
    for slot in &reviewers {
        attempts.push(emit_attempt(&mut events, run_id, slot, attempts.len())?);
    }
    // The finalizer runs after the final reconciliation, so its own attempt is
    // scripted first and emitted after. Counting it in the final summary keeps
    // the summary and the result consistent.
    let mut projected = attempts.clone();
    for slot in &finalizers {
        projected.push(scripted_attempt(run_id, slot, projected.len())?);
    }
    let summary = reconcile(&plan.slots, &projected, root_cause)?;
    push(
        &mut events,
        run_id,
        TriageRunEventPayloadV2::FinalReconciliation {
            summary: summary.clone(),
        },
    );
    for slot in &finalizers {
        attempts.push(emit_attempt(&mut events, run_id, slot, attempts.len())?);
    }
    finish(
        &mut events,
        run_id,
        bound,
        bounded,
        plan,
        &attempts,
        summary.clone(),
    )?;
    assemble(bound, events, attempts, summary)
}

fn assemble(
    bound: &BoundRequest,
    events: Vec<TriageRunEventV2>,
    attempts: Vec<TriageRoleAttemptV1>,
    reconciliation: TriageReconciliationV1,
) -> AdapterResult<MockRunOutcome> {
    let replay = TriageReplayV1 {
        schema_id: TRIAGE_REPLAY_SCHEMA_V1.to_string(),
        run_id: bound.sdk_run_id.clone(),
        request_fingerprint: bound.request_fingerprint.clone(),
        events,
    };
    // The real public validator owns phase order, sequence contiguity,
    // terminal count, run identity, and share-safe leakage.
    replay.validate()?;
    Ok(MockRunOutcome {
        replay,
        attempts,
        reconciliation,
    })
}

fn finish(
    events: &mut Vec<TriageRunEventV2>,
    run_id: &str,
    bound: &BoundRequest,
    bounded: &BoundedPacket,
    plan: &MockEnginePlan,
    attempts: &[TriageRoleAttemptV1],
    summary: TriageReconciliationV1,
) -> AdapterResult<()> {
    if let Some(validation) = &plan.validation {
        push(
            events,
            run_id,
            TriageRunEventPayloadV2::Validation {
                passed: validation.passed,
                reason_codes: validation.reason_codes.clone(),
            },
        );
    }
    if let Some(correction) = &plan.correction {
        push(
            events,
            run_id,
            TriageRunEventPayloadV2::Correction {
                applied: correction.applied,
                reason_codes: correction.reason_codes.clone(),
            },
        );
    }

    let reasons = collected_reason_codes(attempts);
    let terminal = match &plan.terminal {
        MockTerminalPlan::Completed => TriageRunEventPayloadV2::Completed {
            result: Box::new(grounded_final(bound, bounded, summary, reasons)?),
        },
        MockTerminalPlan::CompletedPartial => TriageRunEventPayloadV2::Completed {
            result: Box::new(honest_partial(bound, bounded, summary, reasons)?),
        },
        MockTerminalPlan::Failed {
            category,
            partial_result,
        } => TriageRunEventPayloadV2::Failed {
            category: category.clone(),
            partial_result: optional_partial(bound, bounded, summary, reasons, *partial_result)?,
        },
        MockTerminalPlan::TimedOut {
            category,
            partial_result,
        } => TriageRunEventPayloadV2::TimedOut {
            category: category.clone(),
            partial_result: optional_partial(bound, bounded, summary, reasons, *partial_result)?,
        },
        MockTerminalPlan::Cancelled { partial_result } => TriageRunEventPayloadV2::Cancelled {
            cancellation_id: bound.request.cancellation_id.clone(),
            partial_result: optional_partial(bound, bounded, summary, reasons, *partial_result)?,
        },
    };
    push(events, run_id, terminal);
    Ok(())
}

fn optional_partial(
    bound: &BoundRequest,
    bounded: &BoundedPacket,
    summary: TriageReconciliationV1,
    reasons: Vec<String>,
    attach: bool,
) -> AdapterResult<Option<Box<TriageResultV2>>> {
    if attach {
        Ok(Some(Box::new(honest_partial(
            bound, bounded, summary, reasons,
        )?)))
    } else {
        Ok(None)
    }
}

fn grounded_final(
    bound: &BoundRequest,
    bounded: &BoundedPacket,
    mut summary: TriageReconciliationV1,
    mut reason_codes: Vec<String>,
) -> AdapterResult<TriageResultV2> {
    let answer = identity_derived_answer(bound, bounded);
    let accepted = answer
        .evidence
        .iter()
        .map(|row| row.evidence_id.clone())
        .collect::<Vec<_>>();
    summary.root_cause_established = true;
    summary.supported_claim_ids = answer
        .answer
        .candidates
        .iter()
        .flat_map(|candidate| candidate.claims.iter().map(|claim| claim.claim_id.clone()))
        .collect();
    push_unique(&mut reason_codes, DETERMINISTIC_MOCK_REASON_CODE);
    let result = TriageResultV2 {
        schema_id: TRIAGE_RESULT_SCHEMA_V2.to_string(),
        run_id: bound.sdk_run_id.clone(),
        kind: TriageResultKind::GroundedFinal,
        validation_state: TriageValidationState::Passed,
        packet_id: bounded.packet.packet_id.clone(),
        reconciliation: summary,
        answer: Some(answer),
        accepted_evidence_ids: accepted,
        reason_codes,
    };
    result.validate()?;
    Ok(result)
}

fn honest_partial(
    bound: &BoundRequest,
    bounded: &BoundedPacket,
    mut summary: TriageReconciliationV1,
    mut reason_codes: Vec<String>,
) -> AdapterResult<TriageResultV2> {
    summary.root_cause_established = false;
    summary.supported_claim_ids.clear();
    push_unique(&mut reason_codes, DETERMINISTIC_MOCK_REASON_CODE);
    push_unique(&mut reason_codes, "no_authoritative_answer");
    let result = TriageResultV2 {
        schema_id: TRIAGE_RESULT_SCHEMA_V2.to_string(),
        run_id: bound.sdk_run_id.clone(),
        kind: TriageResultKind::HonestPartial,
        validation_state: TriageValidationState::Partial,
        packet_id: bounded.packet.packet_id.clone(),
        reconciliation: summary,
        // A partial run has no authoritative answer envelope. Recording an
        // empty one would be a fabricated result, not an honest partial.
        answer: None,
        accepted_evidence_ids: Vec::new(),
        reason_codes,
    };
    result.validate()?;
    Ok(result)
}

/// Build the owner-only answer envelope from packet **identities**.
///
/// There is no model text and no evidence body anywhere in this function: a
/// [`crate::packet::BoundedPacket`] carries digests only.
fn identity_derived_answer(bound: &BoundRequest, bounded: &BoundedPacket) -> AnswerEnvelopeV1 {
    let candidate_id = "cand-mock-1".to_string();
    // Bench snapshots are content-addressed and carry no log-analysis
    // revision triple, so the SDK revision is recorded as zero rather than
    // invented.
    let revision = LogSnapshotRevisionV1 {
        event_revision: 0,
        template_analysis_revision: 0,
        suppression_revision: 0,
    };
    let mut evidence = Vec::new();
    let mut citations = Vec::new();
    let mut claims = Vec::new();
    for row in &bounded.packet.evidence {
        let content = match (&row.content, &row.expected_content_digest) {
            (Some(held), _) => format!("{} ({} bytes held)", held.digest.wire(), held.byte_length),
            (None, Some(expected)) => format!("{} (external reference)", expected.wire()),
            (None, None) => "unverified external reference".to_string(),
        };
        evidence.push(HostEvidenceEntry {
            evidence_id: row.item_id.clone(),
            candidate_id: candidate_id.clone(),
            source_label: row.kind.clone(),
            locator: row.item_id.clone(),
            corpus_id: bounded.packet.snapshot_id.clone(),
            revision,
            role: EvidenceRole::Supporting,
            content: content.clone(),
        });
        citations.push(CanonicalCitationV1 {
            evidence_id: row.item_id.clone(),
            candidate_id: candidate_id.clone(),
            source_label: row.kind.clone(),
            locator: row.item_id.clone(),
            corpus_id: bounded.packet.snapshot_id.clone(),
            revision,
            content,
        });
        claims.push(InvestigationClaimV1 {
            claim_id: format!("claim-{}", row.item_id),
            claim_kind: ClaimKind::Observation,
            text: format!(
                "deterministic mock: {} evidence {} is in scope for {candidate_id}",
                row.kind, row.item_id
            ),
            candidate_id: candidate_id.clone(),
            evidence_ids: vec![row.item_id.clone()],
            status: ClaimStatus::Supported,
        });
    }
    AnswerEnvelopeV1 {
        binding: AnswerBindingV1 {
            session_id: bound.sdk_run_id.clone(),
            turn_id: format!("{}-turn-1", bound.sdk_run_id),
            corpus_id: bounded.packet.snapshot_id.clone(),
            revision,
            ledger_digest: bounded.packet_fingerprint.clone(),
        },
        evidence,
        answer: InvestigationAnswerV1 {
            schema: SCHEMA_V1.to_string(),
            candidates: vec![InvestigationCandidateV1 {
                candidate_id,
                claims,
            }],
            canonical_citations: citations,
            root_cause_established: true,
        },
        semantic_attempts: 1,
    }
}

fn reconcile(
    slots: &[MockSlotPlan],
    attempts: &[TriageRoleAttemptV1],
    root_cause_established: bool,
) -> AdapterResult<TriageReconciliationV1> {
    let completed: Vec<&TriageRoleAttemptV1> = attempts
        .iter()
        .filter(|attempt| attempt.status == TriageAttemptStatus::Completed)
        .collect();
    let models: BTreeSet<&ModelRef> = completed
        .iter()
        .filter_map(|attempt| attempt.model.as_ref())
        .collect();
    let gateways: BTreeSet<&str> = models
        .iter()
        .map(|model| model.profile_id.as_str())
        .collect();
    let summary = TriageReconciliationV1 {
        state: if completed.is_empty() {
            "incomplete".to_string()
        } else {
            "reconciled".to_string()
        },
        configured_role_slots: slots.len() as u32,
        completed_role_slots: completed.len() as u32,
        distinct_models: models.len() as u32,
        distinct_gateways: gateways.len() as u32,
        supported_claim_ids: Vec::new(),
        conflict_ids: Vec::new(),
        gap_ids: Vec::new(),
        root_cause_established,
    };
    summary.validate()?;
    Ok(summary)
}

fn scripted_attempt(
    run_id: &str,
    slot: &MockSlotPlan,
    index: usize,
) -> AdapterResult<TriageRoleAttemptV1> {
    let (elapsed_ms, input_chars, output_chars) = slot.outcome.metrics();
    let status = slot.outcome.status();
    let attempt = TriageRoleAttemptV1 {
        attempt_id: fingerprint("att", &(run_id, index, &slot.role_slot_id))?,
        role_slot_id: slot.role_slot_id.clone(),
        role: slot.role,
        // Owner-only events retain the exact gateway-scoped identity. The
        // share-safe projection replaces it with a fingerprint.
        model: Some(slot.model.clone()),
        status,
        reason_codes: slot
            .outcome
            .reason_code()
            .map(|code| vec![code.to_string()])
            .unwrap_or_default(),
        elapsed_ms,
        input_chars,
        output_chars,
        // The deterministic mock contacts no provider and applies no semantic
        // correction, so both counters are a truthful zero rather than absent.
        physical_provider_calls: Some(0),
        semantic_corrections: Some(0),
        terminal_disposition: Some(terminal_disposition(status)),
    };
    attempt.validate()?;
    Ok(attempt)
}

fn emit_attempt(
    events: &mut Vec<TriageRunEventV2>,
    run_id: &str,
    slot: &MockSlotPlan,
    index: usize,
) -> AdapterResult<TriageRoleAttemptV1> {
    let attempt = scripted_attempt(run_id, slot, index)?;
    push(
        events,
        run_id,
        TriageRunEventPayloadV2::RoleAttempt {
            attempt: attempt.clone(),
        },
    );
    Ok(attempt)
}

fn terminal_disposition(status: TriageAttemptStatus) -> cd_triage_sdk::TriageTerminalDispositionV1 {
    use cd_triage_sdk::TriageTerminalDispositionV1 as D;
    match status {
        TriageAttemptStatus::Completed => D::Completed,
        TriageAttemptStatus::Abstained => D::Abstained,
        TriageAttemptStatus::Invalid => D::Invalid,
        TriageAttemptStatus::Unavailable => D::Unavailable,
        TriageAttemptStatus::TimedOut => D::TimedOut,
        TriageAttemptStatus::Cancelled => D::Cancelled,
        TriageAttemptStatus::Failed => D::Failed,
        TriageAttemptStatus::NotAdmitted => D::NotAdmitted,
    }
}

fn collected_reason_codes(attempts: &[TriageRoleAttemptV1]) -> Vec<String> {
    let mut codes: Vec<String> = Vec::new();
    for attempt in attempts {
        for code in &attempt.reason_codes {
            push_unique(&mut codes, code);
        }
    }
    codes
}

fn push_unique(codes: &mut Vec<String>, code: &str) {
    if !codes.iter().any(|existing| existing == code) {
        codes.push(code.to_string());
    }
}

fn push(events: &mut Vec<TriageRunEventV2>, run_id: &str, event: TriageRunEventPayloadV2) {
    let sequence = events.len() as u64;
    events.push(TriageRunEventV2 {
        schema_id: TRIAGE_RUN_EVENT_SCHEMA_V2.to_string(),
        run_id: run_id.to_string(),
        sequence,
        // The stream carries exact model identity and, at the terminal, an
        // owner-only answer envelope. Share-safe output is a separate,
        // explicit projection — never this stream with a relabelled boundary.
        privacy: PacketPrivacyBoundary::OwnerOnly,
        event,
    });
}
