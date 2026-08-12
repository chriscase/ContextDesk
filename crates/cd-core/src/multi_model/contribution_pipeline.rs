//! Bounded provider execution for the contribution contract.
//!
//! The pure contract lives in [`super::contributions`]. This module is the
//! deliberately small runtime seam: it receives already-authorized backends,
//! sends one bounded structured request per selected role, validates every
//! response against the unchanged packet, and returns a host-validated answer
//! floor. It performs no provider discovery, credential reads, or routing by
//! model name; those remain workflow responsibilities.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tokio::time::Instant;

use super::contributions::{
    reconcile_contributions, reconciliation_answer, ContributionAttemptV1,
    ContributionAvailability, ContributionDegradationReason, ContributionIdentity,
    ContributionRole, ContributionRoutingPlan,
};
use super::MultiModelBudget;
use crate::agent::{within_turn_deadline, ChatBackend, TurnAwaitError, TurnClock};
use crate::chat::{ChatMessage, Role};
use crate::error::{CoreError, CoreResult};
use crate::fast_triage::FastTriagePacketV1;
use crate::injection::wrap_untrusted;
use crate::investigation_answer::{render_answer_markdown, AnswerEnvelopeV1};
use crate::router::TurnDeadlinePlan;

/// One host-resolved backend slot. Its identity is host-owned and never read
/// from model output.
#[derive(Clone)]
pub struct ContributionBackendSlot {
    /// Functional role assigned to the backend.
    pub role: ContributionRole,
    /// Exact host profile/model identity.
    pub identity: ContributionIdentity,
    /// Host-measured capability evidence. Model names and transport
    /// compatibility hints never qualify a contributor.
    pub qualification: ContributionQualification,
    /// Already-authorized provider backend.
    pub backend: Arc<dyn ChatBackend>,
}

/// Qualification state required before a contribution backend may receive the
/// host packet. This is intentionally smaller than a provider-specific
/// capability matrix: the workflow layer supplies the exact measured result.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContributionQualification {
    /// The exact role/schema contract was measured successfully.
    Qualified,
    /// No exact role qualification exists yet.
    Unverified,
    /// The exact role/schema contract failed qualification.
    Unqualified,
}

impl std::fmt::Debug for ContributionBackendSlot {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ContributionBackendSlot")
            .field("role", &self.role)
            .field("identity", &self.identity)
            .finish_non_exhaustive()
    }
}

/// Inputs for one contribution run. The packet is immutable and already
/// assembled by the host's deterministic triage path.
pub struct ContributionPipelineInputs<'a> {
    /// User question, wrapped as untrusted prompt data.
    pub user_text: &'a str,
    /// Exact packet sent to every contributor.
    pub packet: &'a FastTriagePacketV1,
    /// Host-selected bounded backends.
    pub slots: &'a [ContributionBackendSlot],
    /// Hard model-call/context ceilings.
    pub budget: MultiModelBudget,
    /// Whole-turn deadline.
    pub deadline_ms: u64,
    /// Shared turn start.
    pub started_at: Option<Instant>,
    /// Shared cooperative cancellation signal.
    pub cancel: Option<Arc<AtomicBool>>,
    /// Host routing plan, including hard contributor bounds.
    pub plan: &'a ContributionRoutingPlan,
}

/// Host-authored progress event for CLI/Tauri activity.
#[derive(Debug, Clone)]
pub struct ContributionStageEvent {
    /// Role being attempted.
    pub role: ContributionRole,
    /// Host model identity.
    pub identity: ContributionIdentity,
    /// True on entry, false on exit.
    pub started: bool,
    /// Bounded outcome label on exit.
    pub outcome: Option<ContributionAvailability>,
    /// Host-authored actionable reason when the stage did not complete.
    pub degradation: Option<ContributionDegradationReason>,
    /// Content-free detail.
    pub detail: String,
}

/// Per-slot share-safe telemetry.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ContributionStageTelemetry {
    /// Functional role.
    pub role: ContributionRole,
    /// Host profile identity.
    pub profile_id: String,
    /// Exact model id.
    pub model: String,
    /// Exact host qualification state used for this slot.
    pub qualification: ContributionQualification,
    /// Logical calls sent (zero or one in this v1 runtime seam).
    pub provider_rounds: u32,
    /// Model-facing characters sent.
    pub context_chars_sent: u64,
    /// Response characters received before validation. Zero when no provider
    /// call was sent or the transport returned nothing.
    #[serde(default)]
    pub output_chars: u64,
    /// Explicit result.
    pub outcome: ContributionAvailability,
    /// Host-authored actionable reason for a non-completed stage.
    #[serde(default)]
    pub degradation: Option<ContributionDegradationReason>,
}

/// Share-safe contribution run telemetry.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ContributionPipelineTelemetry {
    /// Stable schema.
    pub schema: String,
    /// Exact packet identity.
    pub packet_id: String,
    /// Per-slot outcomes.
    pub stages: Vec<ContributionStageTelemetry>,
    /// Reconciliation state.
    pub state: String,
    /// Whether bounded escalation was recommended.
    pub escalation_recommended: bool,
}

/// Completed provider-neutral contribution run.
pub struct ContributionPipelineOutcome {
    /// Explicit attempts, including dropouts.
    pub attempts: Vec<ContributionAttemptV1>,
    /// Deterministic reconciliation report.
    pub report: super::contributions::ReconciliationReportV1,
    /// Host-validated answer floor.
    pub envelope: Box<AnswerEnvelopeV1>,
    /// Host-rendered visible text.
    pub content: String,
    /// Share-safe telemetry.
    pub telemetry: ContributionPipelineTelemetry,
}

/// Content-free reason a policy-bound contribution route stopped before it
/// could produce a typed pipeline outcome.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContributionRouteRefusalV1 {
    /// The deterministic linked-turn route classified the task as focused
    /// rather than broad triage, so the bounded contribution branch is never
    /// reached. A policy-bound run refuses instead of falling through to a
    /// provider path the compiled policy did not admit.
    NotBroadTriage,
    /// The deterministic corpus brief was unavailable, incomplete, or
    /// truncated, so the bounded contribution branch cannot be entered.
    BriefUnavailable,
    /// Host packet validation failed after the brief was assembled.
    PacketInvalid,
    /// The admitted pipeline failed without producing a typed outcome.
    PipelineFailed,
}

impl ContributionRouteRefusalV1 {
    /// Stable machine label for trails, ledgers, and diagnostics.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::NotBroadTriage => "not_broad_triage",
            Self::BriefUnavailable => "brief_unavailable",
            Self::PacketInvalid => "packet_invalid",
            Self::PipelineFailed => "pipeline_failed",
        }
    }
}

/// Typed, host-neutral observer of one policy-bound contribution run.
///
/// The observer receives exactly the host-authored facts this pipeline and
/// the linked-turn seam already produce — packet identity, typed stage
/// events, the final typed outcome, or a typed refusal — so a policy
/// projector (for example the Triage Policy V2 event ledger) can account the
/// run without parsing rendered stream text or reconstructing identity from
/// model output. Observation is synchronous and infallible: it must never
/// change run behavior, budgets, or ordering.
pub trait ContributionRunObserverV1: Send + Sync {
    /// The immutable host packet was assembled and admitted for this run.
    fn packet_ready(&self, packet: &FastTriagePacketV1);
    /// One bounded stage started (`started == true`) or finished.
    fn stage(&self, event: &ContributionStageEvent);
    /// The pipeline completed with typed attempts and a reconciliation report.
    fn outcome(&self, outcome: &ContributionPipelineOutcome);
    /// The route stopped before a typed outcome existed.
    fn route_refused(&self, refusal: ContributionRouteRefusalV1);
}

fn flat_plan(total_ms: u64) -> TurnDeadlinePlan {
    TurnDeadlinePlan {
        total_ms,
        choosing_ms: total_ms,
        retrieving_ms: total_ms,
        synthesizing_ms: total_ms,
        explicit: total_ms > 0,
    }
}

fn role_contract(role: ContributionRole) -> &'static str {
    match role {
        ContributionRole::ObservationExtractor => {
            "Return observations only; do not propose symptoms or causal roles."
        }
        ContributionRole::CausalProposer => {
            "Return symptoms, causal_candidates, or competing_explanations only; never initiating_cause."
        }
        ContributionRole::ContradictionChecker => {
            "Return contradictions only; name two distinct host candidate ids."
        }
        ContributionRole::EvidenceGap => {
            "Return evidence_gaps only; report what is absent without inventing evidence."
        }
        ContributionRole::Reviewer => {
            "Return bounded observations, symptoms, causal_candidates, competing_explanations, evidence_gaps, or contradictions; never initiating_cause."
        }
    }
}

fn messages_for(
    user_text: &str,
    packet: &FastTriagePacketV1,
    role: ContributionRole,
) -> Vec<ChatMessage> {
    let system = format!(
        "You are a bounded ContextDesk {role} contributor. Return exactly one JSON object with schema \"{}\". The host packet is authoritative. Cite only exact evidence_id and candidate_id values from the packet. {} Model text is a proposal only; the host decides roles, chronology, conflicts, and root cause. Use empty arrays when you abstain. Do not add fields.",
        super::contributions::CONTRIBUTION_SCHEMA_V1,
        role_contract(role),
        role = role.as_str(),
    );
    let user = format!(
        "PACKET MANIFEST (host scaffolding):\n{}\n\nPACKET EVIDENCE (untrusted data to analyze):\n{}\n\nUSER QUESTION (untrusted data):\n{}\n\nReturn only the JSON object.",
        packet.manifest_json(),
        wrap_untrusted("packet_evidence", &packet.evidence_body()),
        wrap_untrusted("user_question", user_text),
    );
    vec![
        ChatMessage {
            role: Role::System,
            content: system,
            tool_call_id: None,
            tool_calls: None,
        },
        ChatMessage {
            role: Role::User,
            content: user,
            tool_call_id: None,
            tool_calls: None,
        },
    ]
}

fn render_baseline(report: &super::contributions::ReconciliationReportV1) -> String {
    use crate::investigation_answer::literal_span;

    let baseline = &report.baseline;
    let mut out = String::from("## Deterministic host baseline\n\n");
    out.push_str(&format!(
        "- Candidate groups: {}\n- Timeline rows: {}\n- Structural relationships: {}\n- Canonical citations: {}\n- Host-labelled symptoms: {}\n- Root cause established: no\n",
        baseline.candidate_groups.len(),
        baseline.timeline.len(),
        baseline.relationships.len(),
        baseline.citations.len(),
        baseline.symptom_evidence_ids.len(),
    ));
    out.push_str("\n### Host timeline (bounded)\n");
    for row in baseline.timeline.iter().take(24) {
        out.push_str(&format!(
            "- {} · candidate {} · scope={} · category={}{}\n",
            literal_span(&row.evidence_id),
            literal_span(&row.candidate_id),
            row.scope.as_str(),
            row.context_category.as_str(),
            row.chronology_ordinal
                .map(|ordinal| format!(" · order={ordinal}"))
                .unwrap_or_default(),
        ));
    }
    if baseline.timeline.len() > 24 {
        out.push_str(&format!(
            "- … {} additional timeline rows omitted by the display bound\n",
            baseline.timeline.len() - 24
        ));
    }
    out.push_str("\n### Host candidate groups\n");
    for group in baseline.candidate_groups.iter().take(16) {
        out.push_str(&format!(
            "- {} · evidence={} · cause_labels={} · symptom_labels={}\n",
            literal_span(&group.candidate_id),
            group.evidence_ids.len(),
            group.cause_evidence_ids.len(),
            group.symptom_evidence_ids.len(),
        ));
    }
    if baseline.candidate_groups.len() > 16 {
        out.push_str(&format!(
            "- … {} additional candidate groups omitted by the display bound\n",
            baseline.candidate_groups.len() - 16
        ));
    }
    out.push_str("\n### Host structural relationships\n");
    if baseline.relationships.is_empty() {
        out.push_str("- none\n");
    } else {
        for relationship in baseline.relationships.iter().take(24) {
            out.push_str(&format!(
                "- {} · candidate {} · category={}\n",
                literal_span(&relationship.evidence_id),
                literal_span(&relationship.candidate_id),
                relationship.category.as_str(),
            ));
        }
        if baseline.relationships.len() > 24 {
            out.push_str(&format!(
                "- … {} additional relationships omitted by the display bound\n",
                baseline.relationships.len() - 24
            ));
        }
    }
    out.push_str("\n### Host canonical citations\n");
    if baseline.citations.is_empty() {
        out.push_str("- none\n");
    } else {
        for evidence_id in baseline.citations.iter().take(24) {
            out.push_str(&format!("- {}\n", literal_span(evidence_id)));
        }
        if baseline.citations.len() > 24 {
            out.push_str(&format!(
                "- … {} additional citations omitted by the display bound\n",
                baseline.citations.len() - 24
            ));
        }
    }
    out.push_str("\n### Host-labelled symptoms\n");
    if baseline.symptom_evidence_ids.is_empty() {
        out.push_str("- none\n");
    } else {
        for evidence_id in baseline.symptom_evidence_ids.iter().take(24) {
            out.push_str(&format!("- {}\n", literal_span(evidence_id)));
        }
        if baseline.symptom_evidence_ids.len() > 24 {
            out.push_str(&format!(
                "- … {} additional symptoms omitted by the display bound\n",
                baseline.symptom_evidence_ids.len() - 24
            ));
        }
    }
    out.push_str(&format!(
        "\n### Reconciliation state\n- state={} · escalation_recommended={}\n",
        report.state.as_str(),
        report.escalation_recommended,
    ));
    out.push_str("\n### Reconciliation conflicts\n");
    if report.conflicts.is_empty() && report.reported_contradictions.is_empty() {
        out.push_str("- none\n");
    } else {
        for conflict in report.conflicts.iter().take(16) {
            let kinds = conflict
                .kinds
                .iter()
                .map(|kind| kind.as_str())
                .collect::<Vec<_>>()
                .join(",");
            out.push_str(&format!(
                "- candidate {} · evidence={} · competing_kinds={}\n",
                literal_span(&conflict.candidate_id),
                conflict
                    .evidence_ids
                    .iter()
                    .map(|id| literal_span(id))
                    .collect::<Vec<_>>()
                    .join(","),
                kinds,
            ));
        }
        for contradiction in report.reported_contradictions.iter().take(16) {
            out.push_str(&format!(
                "- contradiction {} · candidates {} / {} · evidence={}\n",
                literal_span(&contradiction.contradiction_id),
                literal_span(&contradiction.candidate_a),
                literal_span(&contradiction.candidate_b),
                contradiction
                    .evidence_ids
                    .iter()
                    .map(|id| literal_span(id))
                    .collect::<Vec<_>>()
                    .join(","),
            ));
        }
    }
    out
}

/// A typed result for one admitted provider slot. The caller records an
/// explicit `ContributionAttemptV1` even when `attempt` is absent.
struct SlotExecution {
    availability: ContributionAvailability,
    degradation: Option<ContributionDegradationReason>,
    provider_rounds: u32,
    context_chars_sent: u64,
    output_chars: u64,
    attempt: Option<ContributionAttemptV1>,
}

/// Validate that workflow resolution preserved the exact configured plan
/// sequence. In particular, equal roles are still distinct slots, so a set
/// membership check would be insufficient here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContributionSlotValidationError {
    /// The resolver returned a different number of slots than the plan.
    SlotCountMismatch,
    /// The resolver returned slots in a different role order or multiplicity.
    SlotOrderMismatch,
}

impl ContributionSlotValidationError {
    /// Stable content-free policy label.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::SlotCountMismatch => "slot_count_mismatch",
            Self::SlotOrderMismatch => "slot_order_mismatch",
        }
    }
}

fn validate_slots(
    slots: &[ContributionBackendSlot],
    plan: &ContributionRoutingPlan,
) -> Result<(), ContributionSlotValidationError> {
    if slots.len() != plan.roles.len() {
        return Err(ContributionSlotValidationError::SlotCountMismatch);
    }
    if slots
        .iter()
        .map(|slot| slot.role)
        .ne(plan.roles.iter().copied())
    {
        return Err(ContributionSlotValidationError::SlotOrderMismatch);
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn execute_slot(
    slot: &ContributionBackendSlot,
    user_text: &str,
    packet: &FastTriagePacketV1,
    budget: MultiModelBudget,
    plan_context_limit: u64,
    clock: &TurnClock,
    cancel: Option<&AtomicBool>,
    rounds: &mut u32,
    used_chars: &mut u64,
) -> SlotExecution {
    let messages = messages_for(user_text, packet, slot.role);
    let chars = crate::agent::estimate_context_chars(&messages) as u64;
    let mut sent = false;
    let mut output_chars = 0u64;
    let (availability, degradation, attempt) =
        if slot.qualification != ContributionQualification::Qualified {
            (
                ContributionAvailability::Unavailable,
                Some(ContributionDegradationReason::QualificationUnavailable),
                None,
            )
        } else if *rounds >= budget.max_total_provider_rounds {
            (
                ContributionAvailability::Unavailable,
                Some(ContributionDegradationReason::ProviderRoundBudgetExhausted),
                None,
            )
        } else if chars > budget.context_char_budget as u64 || chars > plan_context_limit {
            (
                ContributionAvailability::Malformed,
                Some(ContributionDegradationReason::ContextBudgetExhausted),
                None,
            )
        } else if budget
            .max_context_chars_total
            .is_some_and(|limit| used_chars.saturating_add(chars) > limit)
            || used_chars.saturating_add(chars) > plan_context_limit
        {
            (
                ContributionAvailability::Malformed,
                Some(ContributionDegradationReason::TotalContextBudgetExhausted),
                None,
            )
        } else if cancel.is_some_and(|flag| flag.load(Ordering::SeqCst)) {
            (
                ContributionAvailability::Cancelled,
                Some(ContributionDegradationReason::Cancelled),
                None,
            )
        } else if clock.deadline_reached() {
            (
                ContributionAvailability::TimedOut,
                Some(ContributionDegradationReason::Deadline),
                None,
            )
        } else {
            *used_chars = used_chars.saturating_add(chars);
            *rounds = rounds.saturating_add(1);
            sent = true;
            let mut buffered = String::new();
            let mut on_text = |text: String| buffered.push_str(&text);
            let completion = within_turn_deadline(
                clock,
                cancel,
                slot.backend
                    .complete_streaming(&messages, &[], &mut on_text, cancel),
            )
            .await;
            match completion {
                Ok(Ok(completion)) => {
                    let body = if buffered.trim().is_empty() {
                        completion.content
                    } else {
                        buffered
                    };
                    output_chars = body.chars().count() as u64;
                    match super::contributions::validate_contribution(
                        &body,
                        packet,
                        slot.identity.clone(),
                        slot.role,
                    ) {
                        Ok(contribution) => (
                            ContributionAvailability::Completed,
                            None,
                            Some(ContributionAttemptV1::completed(contribution)),
                        ),
                        Err(_) => (
                            ContributionAvailability::Malformed,
                            Some(ContributionDegradationReason::MalformedProposal),
                            None,
                        ),
                    }
                }
                Ok(Err(_)) => {
                    if cancel.is_some_and(|flag| flag.load(Ordering::SeqCst)) {
                        (
                            ContributionAvailability::Cancelled,
                            Some(ContributionDegradationReason::Cancelled),
                            None,
                        )
                    } else {
                        (
                            ContributionAvailability::Failed,
                            Some(ContributionDegradationReason::ProviderFailed),
                            None,
                        )
                    }
                }
                Err(TurnAwaitError::Cancelled) => (
                    ContributionAvailability::Cancelled,
                    Some(ContributionDegradationReason::Cancelled),
                    None,
                ),
                Err(TurnAwaitError::Deadline) => (
                    ContributionAvailability::TimedOut,
                    Some(ContributionDegradationReason::Deadline),
                    None,
                ),
            }
        };
    SlotExecution {
        availability,
        degradation,
        provider_rounds: u32::from(sent),
        context_chars_sent: if sent { chars } else { 0 },
        output_chars: if sent { output_chars } else { 0 },
        attempt,
    }
}

#[allow(clippy::too_many_arguments)]
fn emit_terminal(
    stages: &mut Vec<ContributionStageTelemetry>,
    on_stage: &mut (dyn FnMut(ContributionStageEvent) + Send),
    slot: &ContributionBackendSlot,
    availability: ContributionAvailability,
    degradation: Option<ContributionDegradationReason>,
    provider_rounds: u32,
    context_chars_sent: u64,
    output_chars: u64,
) {
    stages.push(ContributionStageTelemetry {
        role: slot.role,
        profile_id: slot.identity.profile_id.clone(),
        model: slot.identity.model.clone(),
        qualification: slot.qualification,
        provider_rounds,
        context_chars_sent,
        output_chars,
        outcome: availability,
        degradation,
    });
    on_stage(ContributionStageEvent {
        role: slot.role,
        identity: slot.identity.clone(),
        started: false,
        outcome: Some(availability),
        degradation,
        detail: degradation
            .map(ContributionDegradationReason::detail)
            .unwrap_or_else(|| availability.as_str())
            .into(),
    });
}

/// Run one bounded sequential contribution round. Parallel execution can be
/// added behind the same plan later; this v1 deliberately chooses sequential
/// calls so cancellation, deadlines, and telemetry remain easy to audit.
pub async fn run_contribution_pipeline(
    inputs: ContributionPipelineInputs<'_>,
    on_stage: &mut (dyn FnMut(ContributionStageEvent) + Send),
) -> CoreResult<ContributionPipelineOutcome> {
    if inputs.slots.len() > inputs.plan.policy.max_contributors {
        return Err(CoreError::Policy(
            "contribution slots exceed host bound".into(),
        ));
    }
    validate_slots(inputs.slots, inputs.plan)
        .map_err(|error| CoreError::Policy(format!("contribution {}", error.as_str())))?;
    let clock = TurnClock::new(flat_plan(inputs.deadline_ms), inputs.started_at);
    let cancel = inputs.cancel.as_deref();
    let mut attempts = Vec::new();
    let mut stages = Vec::new();
    let mut rounds = 0u32;
    let mut used_chars = 0u64;
    let plan_context_limit = inputs.plan.policy.max_context_chars as u64;
    let reviewer_index = inputs
        .plan
        .roles
        .iter()
        .position(|role| *role == ContributionRole::Reviewer);
    let initial_len = reviewer_index.unwrap_or(inputs.slots.len());

    let mut interrupted = None;
    for (slot_index, slot) in inputs.slots.iter().take(initial_len).enumerate() {
        on_stage(ContributionStageEvent {
            role: slot.role,
            identity: slot.identity.clone(),
            started: true,
            outcome: None,
            degradation: None,
            detail: "bounded contribution started".into(),
        });
        let execution = execute_slot(
            slot,
            inputs.user_text,
            inputs.packet,
            inputs.budget,
            plan_context_limit,
            &clock,
            cancel,
            &mut rounds,
            &mut used_chars,
        )
        .await;
        attempts.push(execution.attempt.unwrap_or_else(|| {
            ContributionAttemptV1::unavailable(
                slot.role,
                slot.identity.clone(),
                execution.availability,
            )
        }));
        emit_terminal(
            &mut stages,
            on_stage,
            slot,
            execution.availability,
            execution.degradation,
            execution.provider_rounds,
            execution.context_chars_sent,
            execution.output_chars,
        );
        if matches!(
            execution.availability,
            ContributionAvailability::Cancelled | ContributionAvailability::TimedOut
        ) {
            interrupted = Some((
                slot_index,
                execution.availability,
                execution.degradation.expect("interruption has a reason"),
            ));
            break;
        }
    }
    // Cancellation/deadline stops admission for the entire remaining plan,
    // including a configured reviewer slot. Every slot still receives a
    // typed attempt and telemetry disposition.
    if let Some((after, availability, degradation)) = interrupted {
        for slot in inputs.slots.iter().skip(after + 1) {
            attempts.push(ContributionAttemptV1::unavailable(
                slot.role,
                slot.identity.clone(),
                availability,
            ));
            emit_terminal(
                &mut stages,
                on_stage,
                slot,
                availability,
                Some(degradation),
                0,
                0,
                0,
            );
        }
    }
    let mut report = reconcile_contributions(inputs.packet, &attempts);
    // The reviewer is a conditional second phase, never a peer in the first
    // phase. Its slot is always final because the routing plan validates that
    // exact ordering before this runtime is entered.
    if interrupted.is_none() {
        if let Some(reviewer_index) = reviewer_index {
            let reviewer = &inputs.slots[reviewer_index];
            let reviewer_disposition = if !report.escalation_recommended {
                Some((
                    ContributionAvailability::NotAdmitted,
                    ContributionDegradationReason::ReviewerNotRequired,
                ))
            } else if !inputs.plan.policy.reviewer_enabled || inputs.plan.policy.max_rounds < 2 {
                Some((
                    ContributionAvailability::NotAdmitted,
                    ContributionDegradationReason::ReviewerPhaseDisabled,
                ))
            } else if cancel.is_some_and(|flag| flag.load(Ordering::SeqCst)) {
                Some((
                    ContributionAvailability::Cancelled,
                    ContributionDegradationReason::Cancelled,
                ))
            } else if clock.deadline_reached() {
                Some((
                    ContributionAvailability::TimedOut,
                    ContributionDegradationReason::Deadline,
                ))
            } else {
                None
            };
            if reviewer_disposition.is_none() {
                on_stage(ContributionStageEvent {
                    role: reviewer.role,
                    identity: reviewer.identity.clone(),
                    started: true,
                    outcome: None,
                    degradation: None,
                    detail: "bounded reviewer phase admitted".into(),
                });
            }
            let execution = if let Some((availability, degradation)) = reviewer_disposition {
                SlotExecution {
                    availability,
                    degradation: Some(degradation),
                    provider_rounds: 0,
                    context_chars_sent: 0,
                    output_chars: 0,
                    attempt: None,
                }
            } else {
                execute_slot(
                    reviewer,
                    inputs.user_text,
                    inputs.packet,
                    inputs.budget,
                    plan_context_limit,
                    &clock,
                    cancel,
                    &mut rounds,
                    &mut used_chars,
                )
                .await
            };
            attempts.push(execution.attempt.unwrap_or_else(|| {
                ContributionAttemptV1::unavailable(
                    reviewer.role,
                    reviewer.identity.clone(),
                    execution.availability,
                )
            }));
            emit_terminal(
                &mut stages,
                on_stage,
                reviewer,
                execution.availability,
                execution.degradation,
                execution.provider_rounds,
                execution.context_chars_sent,
                execution.output_chars,
            );
            report = reconcile_contributions(inputs.packet, &attempts);
        }
    }
    let envelope = reconciliation_answer(inputs.packet, &attempts)
        .map_err(|_| CoreError::Message("reconciliation answer validation failed".into()))?;
    // Keep the host floor visible even when every contributor drops out or
    // abstains. Counts and opaque ids are safe to render; raw provider bodies
    // and credentials never cross this presentation boundary.
    let content = format!(
        "{}\n\n{}",
        render_answer_markdown(&envelope),
        render_baseline(&report)
    );
    let telemetry = ContributionPipelineTelemetry {
        schema: "contextdesk.multi_model.contribution_telemetry.v1".into(),
        packet_id: inputs.packet.packet_id().into(),
        stages,
        state: report.state.as_str().into(),
        escalation_recommended: report.escalation_recommended,
    };
    Ok(ContributionPipelineOutcome {
        attempts,
        report,
        envelope: Box::new(envelope),
        content,
        telemetry,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::ScriptedBackend;
    use crate::chat::ChatCompletion;
    use crate::fast_triage::FastTriagePacketV1;
    use crate::investigation_answer::{
        AnswerBindingV1, EvidenceRole, HostEvidenceEntry, HostEvidenceLedger, LogSnapshotRevisionV1,
    };
    use crate::multi_model::ContributionRoutingPolicy;
    use serde_json::json;

    fn packet() -> FastTriagePacketV1 {
        let revision = LogSnapshotRevisionV1 {
            event_revision: 1,
            template_analysis_revision: 2,
            suppression_revision: 3,
        };
        let entries = vec![
            HostEvidenceEntry {
                evidence_id: "opaque-a".into(),
                candidate_id: "candidate-a".into(),
                source_label: "a.log".into(),
                locator: "seq=10".into(),
                corpus_id: "corpus".into(),
                revision,
                role: EvidenceRole::Cause,
                content: "cause".into(),
            },
            HostEvidenceEntry {
                evidence_id: "opaque-b".into(),
                candidate_id: "candidate-b".into(),
                source_label: "b.log".into(),
                locator: "seq=20".into(),
                corpus_id: "corpus".into(),
                revision,
                role: EvidenceRole::Symptom,
                content: "symptom".into(),
            },
        ];
        let binding = AnswerBindingV1 {
            session_id: "session".into(),
            turn_id: "turn".into(),
            corpus_id: "corpus".into(),
            revision,
            ledger_digest: HostEvidenceLedger::digest(&entries),
        };
        FastTriagePacketV1::from_ledger(
            HostEvidenceLedger::new(binding, entries).unwrap(),
            None,
            true,
        )
    }

    fn identity(model: &str) -> ContributionIdentity {
        ContributionIdentity {
            profile_id: "profile".into(),
            model: model.into(),
        }
    }

    fn response(
        packet: &FastTriagePacketV1,
        role: ContributionRole,
        claims: serde_json::Value,
    ) -> ChatCompletion {
        ChatCompletion::from_parts(
            json!({
                "schema": super::super::contributions::CONTRIBUTION_SCHEMA_V1,
                "packet_id": packet.packet_id(),
                "role": role,
                "claims": claims,
            })
            .to_string(),
            Vec::new(),
            "stop",
        )
    }

    fn slot(
        role: ContributionRole,
        model: &str,
        backend: ScriptedBackend,
    ) -> ContributionBackendSlot {
        ContributionBackendSlot {
            role,
            identity: identity(model),
            qualification: ContributionQualification::Qualified,
            backend: Arc::new(backend),
        }
    }

    fn plan(roles: Vec<ContributionRole>) -> ContributionRoutingPlan {
        ContributionRoutingPlan::new(roles, Default::default()).unwrap()
    }

    fn budget() -> MultiModelBudget {
        MultiModelBudget {
            max_total_provider_rounds: 4,
            context_char_budget: 100_000,
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn successful_roles_produce_host_validated_non_root_answer() {
        let packet = packet();
        let observation = slot(
            ContributionRole::ObservationExtractor,
            "fast-a",
            ScriptedBackend::new(vec![response(
                &packet,
                ContributionRole::ObservationExtractor,
                json!([{"claim_id":"o","candidate_id":"candidate-a","kind":"observation","text":"seen","evidence_ids":["opaque-a"]}]),
            )]),
        );
        let causal = slot(
            ContributionRole::CausalProposer,
            "fast-b",
            ScriptedBackend::new(vec![response(
                &packet,
                ContributionRole::CausalProposer,
                json!([{"claim_id":"c","candidate_id":"candidate-a","kind":"causal_candidate","text":"possible","evidence_ids":["opaque-a"]}]),
            )]),
        );
        let slots = vec![observation, causal];
        let mut events = Vec::new();
        let outcome = run_contribution_pipeline(
            ContributionPipelineInputs {
                user_text: "why?",
                packet: &packet,
                slots: &slots,
                budget: budget(),
                deadline_ms: 10_000,
                started_at: None,
                cancel: None,
                plan: &plan(vec![
                    ContributionRole::ObservationExtractor,
                    ContributionRole::CausalProposer,
                ]),
            },
            &mut |event| events.push(event),
        )
        .await
        .unwrap();
        assert_eq!(
            outcome.report.state,
            super::super::contributions::ReconciliationState::Supported
        );
        assert!(!outcome.envelope.answer.root_cause_established);
        assert_eq!(outcome.attempts.len(), 2);
        assert_eq!(events.iter().filter(|event| event.started).count(), 2);
        assert!(outcome.content.contains("Root cause established: no"));
        assert!(outcome.content.contains("Host structural relationships"));
        assert!(outcome.content.contains("Host canonical citations"));
        assert!(outcome.content.contains("Host-labelled symptoms"));
        assert!(outcome.content.contains("Reconciliation conflicts"));
    }

    #[test]
    fn host_answer_renders_conflicts_without_model_text() {
        let packet = packet();
        let mut report = super::super::contributions::reconcile_contributions(&packet, &[]);
        report
            .conflicts
            .push(super::super::contributions::ReconciliationConflict {
                candidate_id: "candidate-a".into(),
                evidence_ids: vec!["opaque-a".into()],
                kinds: vec![
                    super::super::contributions::ContributionClaimKind::CausalCandidate,
                    super::super::contributions::ContributionClaimKind::CompetingExplanation,
                ],
            });
        report.reported_contradictions.push(
            super::super::contributions::ValidatedContributionContradictionV1 {
                contradiction_id: "contradiction-1".into(),
                candidate_a: "candidate-a".into(),
                candidate_b: "candidate-b".into(),
                evidence_ids: vec!["opaque-a".into(), "opaque-b".into()],
                text: "this model prose must never be rendered here".into(),
            },
        );
        let rendered = render_baseline(&report);
        assert!(rendered.contains("competing_kinds=causal_candidate,competing_explanation"));
        assert!(rendered.contains("contradiction `contradiction-1`"));
        assert!(!rendered.contains("this model prose must never be rendered here"));
    }

    #[tokio::test]
    async fn routing_plan_round_and_context_caps_are_execution_hard_limits() {
        let packet = packet();
        let observation = slot(
            ContributionRole::ObservationExtractor,
            "fast-a",
            ScriptedBackend::new(vec![response(
                &packet,
                ContributionRole::ObservationExtractor,
                json!([]),
            )]),
        );
        let causal = slot(
            ContributionRole::CausalProposer,
            "fast-b",
            ScriptedBackend::new(vec![response(
                &packet,
                ContributionRole::CausalProposer,
                json!([]),
            )]),
        );
        let round_limited = ContributionRoutingPlan::new(
            vec![
                ContributionRole::ObservationExtractor,
                ContributionRole::CausalProposer,
            ],
            ContributionRoutingPolicy {
                max_rounds: 1,
                ..Default::default()
            },
        )
        .unwrap();
        let slots = vec![observation, causal];
        let outcome = run_contribution_pipeline(
            ContributionPipelineInputs {
                user_text: "why?",
                packet: &packet,
                slots: &slots,
                budget: MultiModelBudget {
                    max_total_provider_rounds: 1,
                    ..budget()
                },
                deadline_ms: 10_000,
                started_at: None,
                cancel: None,
                plan: &round_limited,
            },
            &mut |_| {},
        )
        .await
        .unwrap();
        assert_eq!(outcome.telemetry.stages.len(), 2);
        assert_eq!(outcome.telemetry.stages[0].provider_rounds, 1);
        assert_eq!(
            outcome.telemetry.stages[1].outcome,
            ContributionAvailability::Unavailable
        );
        assert_eq!(
            outcome.telemetry.stages[1].degradation,
            Some(ContributionDegradationReason::ProviderRoundBudgetExhausted)
        );

        let context_limited = ContributionRoutingPlan::new(
            vec![ContributionRole::ObservationExtractor],
            ContributionRoutingPolicy {
                max_context_chars: 1,
                ..Default::default()
            },
        )
        .unwrap();
        let context_slot = slot(
            ContributionRole::ObservationExtractor,
            "fast-context",
            ScriptedBackend::new(vec![response(
                &packet,
                ContributionRole::ObservationExtractor,
                json!([]),
            )]),
        );
        let context_outcome = run_contribution_pipeline(
            ContributionPipelineInputs {
                user_text: "why?",
                packet: &packet,
                slots: &[context_slot],
                budget: budget(),
                deadline_ms: 10_000,
                started_at: None,
                cancel: None,
                plan: &context_limited,
            },
            &mut |_| {},
        )
        .await
        .unwrap();
        assert_eq!(
            context_outcome.telemetry.stages[0].outcome,
            ContributionAvailability::Malformed
        );
        assert_eq!(
            context_outcome.telemetry.stages[0].degradation,
            Some(ContributionDegradationReason::ContextBudgetExhausted)
        );
        assert_eq!(context_outcome.telemetry.stages[0].provider_rounds, 0);
    }

    #[tokio::test]
    async fn max_rounds_is_phase_allowance_not_provider_call_cap() {
        let packet = packet();
        let roles = vec![
            ContributionRole::ObservationExtractor,
            ContributionRole::CausalProposer,
            ContributionRole::EvidenceGap,
        ];
        let slots = roles
            .iter()
            .enumerate()
            .map(|(index, role)| {
                slot(
                    *role,
                    &format!("phase-{index}"),
                    ScriptedBackend::new(vec![response(&packet, *role, json!([]))]),
                )
            })
            .collect::<Vec<_>>();
        let routing = ContributionRoutingPlan::new(
            roles,
            ContributionRoutingPolicy {
                max_rounds: 1,
                ..Default::default()
            },
        )
        .unwrap();
        let outcome = run_contribution_pipeline(
            ContributionPipelineInputs {
                user_text: "why?",
                packet: &packet,
                slots: &slots,
                budget: budget(),
                deadline_ms: 10_000,
                started_at: None,
                cancel: None,
                plan: &routing,
            },
            &mut |_| {},
        )
        .await
        .unwrap();
        assert_eq!(outcome.telemetry.stages.len(), 3);
        assert!(outcome
            .telemetry
            .stages
            .iter()
            .all(|stage| stage.provider_rounds == 1));
        assert_eq!(
            outcome.telemetry.stages[2].outcome,
            ContributionAvailability::Completed
        );
    }

    #[tokio::test]
    async fn reviewer_is_second_phase_and_only_runs_after_escalation() {
        let packet = packet();
        let observation = slot(
            ContributionRole::ObservationExtractor,
            "obs",
            ScriptedBackend::new(vec![response(
                &packet,
                ContributionRole::ObservationExtractor,
                json!([{"claim_id":"o","candidate_id":"candidate-a","kind":"observation","text":"seen","evidence_ids":["opaque-a"]}]),
            )]),
        );
        let causal = slot(
            ContributionRole::CausalProposer,
            "cause",
            ScriptedBackend::new(vec![response(
                &packet,
                ContributionRole::CausalProposer,
                json!([{"claim_id":"c","candidate_id":"candidate-a","kind":"causal_candidate","text":"possible","evidence_ids":["opaque-a"]}]),
            )]),
        );
        let reviewer = slot(
            ContributionRole::Reviewer,
            "reviewer",
            ScriptedBackend::new(vec![response(
                &packet,
                ContributionRole::Reviewer,
                json!([]),
            )]),
        );
        let slots = vec![observation, causal, reviewer];
        let routing = plan(vec![
            ContributionRole::ObservationExtractor,
            ContributionRole::CausalProposer,
            ContributionRole::Reviewer,
        ]);
        let outcome = run_contribution_pipeline(
            ContributionPipelineInputs {
                user_text: "why?",
                packet: &packet,
                slots: &slots,
                budget: budget(),
                deadline_ms: 10_000,
                started_at: None,
                cancel: None,
                plan: &routing,
            },
            &mut |_| {},
        )
        .await
        .unwrap();
        assert_eq!(outcome.telemetry.stages.len(), 3);
        assert_eq!(
            outcome.telemetry.stages[2].outcome,
            ContributionAvailability::NotAdmitted
        );
        assert_eq!(
            outcome.telemetry.stages[2].degradation,
            Some(ContributionDegradationReason::ReviewerNotRequired)
        );
        assert_eq!(
            outcome.attempts[2].availability,
            ContributionAvailability::NotAdmitted
        );
        assert!(!outcome.telemetry.escalation_recommended);
    }

    #[tokio::test]
    async fn reviewer_escalation_uses_second_phase_budget() {
        let packet = packet();
        let roles = vec![
            ContributionRole::ObservationExtractor,
            ContributionRole::CausalProposer,
            ContributionRole::Reviewer,
        ];
        let slots = roles
            .iter()
            .enumerate()
            .map(|(index, role)| {
                slot(
                    *role,
                    &format!("escalate-{index}"),
                    ScriptedBackend::new(vec![response(&packet, *role, json!([]))]),
                )
            })
            .collect::<Vec<_>>();
        let outcome = run_contribution_pipeline(
            ContributionPipelineInputs {
                user_text: "why?",
                packet: &packet,
                slots: &slots,
                budget: MultiModelBudget {
                    max_total_provider_rounds: 3,
                    ..budget()
                },
                deadline_ms: 10_000,
                started_at: None,
                cancel: None,
                plan: &plan(roles),
            },
            &mut |_| {},
        )
        .await
        .unwrap();
        assert_eq!(outcome.telemetry.stages.len(), 3);
        assert_eq!(
            outcome.telemetry.stages[2].outcome,
            ContributionAvailability::Completed
        );
        assert_eq!(outcome.telemetry.stages[2].provider_rounds, 1);
        assert!(outcome.telemetry.escalation_recommended);
    }

    #[tokio::test]
    async fn reviewer_is_not_admitted_when_second_phase_is_disabled() {
        let packet = packet();
        let roles = vec![
            ContributionRole::ObservationExtractor,
            ContributionRole::Reviewer,
        ];
        let slots = roles
            .iter()
            .enumerate()
            .map(|(index, role)| {
                slot(
                    *role,
                    &format!("phase-disabled-{index}"),
                    ScriptedBackend::new(vec![response(&packet, *role, json!([]))]),
                )
            })
            .collect::<Vec<_>>();
        let routing = ContributionRoutingPlan::new(
            roles,
            ContributionRoutingPolicy {
                max_rounds: 1,
                ..Default::default()
            },
        )
        .unwrap();
        let outcome = run_contribution_pipeline(
            ContributionPipelineInputs {
                user_text: "why?",
                packet: &packet,
                slots: &slots,
                budget: budget(),
                deadline_ms: 10_000,
                started_at: None,
                cancel: None,
                plan: &routing,
            },
            &mut |_| {},
        )
        .await
        .unwrap();
        assert_eq!(
            outcome.telemetry.stages[1].outcome,
            ContributionAvailability::NotAdmitted
        );
        assert_eq!(
            outcome.telemetry.stages[1].degradation,
            Some(ContributionDegradationReason::ReviewerPhaseDisabled)
        );
    }

    #[tokio::test]
    async fn exact_slot_order_and_multiplicity_are_preflighted() {
        let packet = packet();
        let first = slot(
            ContributionRole::ObservationExtractor,
            "first",
            ScriptedBackend::new(Vec::new()),
        );
        let second = slot(
            ContributionRole::ObservationExtractor,
            "second",
            ScriptedBackend::new(Vec::new()),
        );
        let plan = plan(vec![
            ContributionRole::ObservationExtractor,
            ContributionRole::CausalProposer,
        ]);
        let result = run_contribution_pipeline(
            ContributionPipelineInputs {
                user_text: "why?",
                packet: &packet,
                slots: &[first, second],
                budget: budget(),
                deadline_ms: 10_000,
                started_at: None,
                cancel: None,
                plan: &plan,
            },
            &mut |_| {},
        )
        .await;
        let error = match result {
            Err(error) => error,
            Ok(_) => panic!("role multiplicity/order mismatch must fail before calls"),
        };
        assert!(error.to_string().contains("slot_order_mismatch"));
    }

    #[tokio::test]
    async fn malformed_output_is_explicit_and_still_returns_answer_floor() {
        let packet = packet();
        let malformed = slot(
            ContributionRole::CausalProposer,
            "sloppy",
            ScriptedBackend::new(vec![ChatCompletion::from_parts("not json", vec![], "stop")]),
        );
        let slots = vec![malformed];
        let outcome = run_contribution_pipeline(
            ContributionPipelineInputs {
                user_text: "why?",
                packet: &packet,
                slots: &slots,
                budget: budget(),
                deadline_ms: 10_000,
                started_at: None,
                cancel: None,
                plan: &plan(vec![ContributionRole::CausalProposer]),
            },
            &mut |_| {},
        )
        .await
        .unwrap();
        assert_eq!(
            outcome.report.state,
            super::super::contributions::ReconciliationState::Unavailable
        );
        assert_eq!(
            outcome.telemetry.stages[0].outcome,
            ContributionAvailability::Malformed
        );
        assert_eq!(
            outcome.telemetry.stages[0].degradation,
            Some(ContributionDegradationReason::MalformedProposal)
        );
        assert!(!outcome.envelope.answer.root_cause_established);
    }

    #[tokio::test]
    async fn pre_cancelled_turn_sends_no_provider_call() {
        let packet = packet();
        let backend = ScriptedBackend::new(vec![response(
            &packet,
            ContributionRole::ObservationExtractor,
            json!([]),
        )]);
        let slots = vec![slot(
            ContributionRole::ObservationExtractor,
            "cancelled",
            backend,
        )];
        let cancel = Arc::new(AtomicBool::new(true));
        let outcome = run_contribution_pipeline(
            ContributionPipelineInputs {
                user_text: "why?",
                packet: &packet,
                slots: &slots,
                budget: budget(),
                deadline_ms: 10_000,
                started_at: None,
                cancel: Some(cancel),
                plan: &plan(vec![ContributionRole::ObservationExtractor]),
            },
            &mut |_| {},
        )
        .await
        .unwrap();
        assert_eq!(outcome.telemetry.stages[0].provider_rounds, 0);
        assert_eq!(
            outcome.telemetry.stages[0].outcome,
            ContributionAvailability::Cancelled
        );
        assert_eq!(
            outcome.telemetry.stages[0].degradation,
            Some(ContributionDegradationReason::Cancelled)
        );
        assert_eq!(
            outcome.report.state,
            super::super::contributions::ReconciliationState::Unavailable
        );
        assert!(outcome.content.contains("Deterministic host baseline"));
    }

    #[tokio::test]
    async fn unverified_role_is_explicit_dropout_without_provider_call() {
        let packet = packet();
        let mut slot = slot(
            ContributionRole::ObservationExtractor,
            "unverified",
            ScriptedBackend::new(vec![response(
                &packet,
                ContributionRole::ObservationExtractor,
                json!([]),
            )]),
        );
        slot.qualification = ContributionQualification::Unverified;
        let slots = vec![slot];
        let routing = plan(vec![ContributionRole::ObservationExtractor]);
        let outcome = run_contribution_pipeline(
            ContributionPipelineInputs {
                user_text: "why?",
                packet: &packet,
                slots: &slots,
                budget: budget(),
                deadline_ms: 10_000,
                started_at: None,
                cancel: None,
                plan: &routing,
            },
            &mut |_| {},
        )
        .await
        .unwrap();
        assert!(outcome
            .attempts
            .iter()
            .all(|attempt| attempt.contribution.is_none()));
        assert_eq!(
            outcome.telemetry.stages[0].outcome,
            ContributionAvailability::Unavailable
        );
        assert_eq!(
            outcome.telemetry.stages[0].degradation,
            Some(ContributionDegradationReason::QualificationUnavailable)
        );
        assert_eq!(
            outcome.report.state,
            super::super::contributions::ReconciliationState::Unavailable
        );
    }

    #[tokio::test]
    async fn cancellation_records_unadmitted_roles_with_the_same_host_reason() {
        let packet = packet();
        let roles = vec![
            ContributionRole::ObservationExtractor,
            ContributionRole::CausalProposer,
            ContributionRole::EvidenceGap,
        ];
        let slots = roles
            .iter()
            .enumerate()
            .map(|(index, role)| {
                slot(
                    *role,
                    &format!("cancelled-{index}"),
                    ScriptedBackend::new(Vec::new()),
                )
            })
            .collect::<Vec<_>>();
        let cancel = Arc::new(AtomicBool::new(true));
        let mut events = Vec::new();
        let outcome = run_contribution_pipeline(
            ContributionPipelineInputs {
                user_text: "why?",
                packet: &packet,
                slots: &slots,
                budget: budget(),
                deadline_ms: 10_000,
                started_at: None,
                cancel: Some(cancel),
                plan: &plan(roles),
            },
            &mut |event| events.push(event),
        )
        .await
        .unwrap();

        assert_eq!(outcome.attempts.len(), 3);
        assert_eq!(outcome.telemetry.stages.len(), 3);
        assert!(outcome.telemetry.stages.iter().all(|stage| {
            stage.outcome == ContributionAvailability::Cancelled
                && stage.degradation == Some(ContributionDegradationReason::Cancelled)
        }));
        assert_eq!(events.iter().filter(|event| event.started).count(), 1);
        assert_eq!(events.iter().filter(|event| !event.started).count(), 3);
        assert!(events.iter().skip(1).all(|event| {
            event.degradation == Some(ContributionDegradationReason::Cancelled)
                && event.detail == ContributionDegradationReason::Cancelled.detail()
        }));
    }
}
