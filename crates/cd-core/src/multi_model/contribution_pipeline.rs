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
    ContributionAvailability, ContributionIdentity, ContributionRole, ContributionRoutingPlan,
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
    /// Explicit result.
    pub outcome: ContributionAvailability,
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
    out
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
    let clock = TurnClock::new(flat_plan(inputs.deadline_ms), inputs.started_at);
    let cancel = inputs.cancel.as_deref();
    let mut attempts = Vec::new();
    let mut stages = Vec::new();
    let mut rounds = 0u32;
    let mut used_chars = 0u64;
    // Both layers are host policy. The per-turn budget is the outer ceiling;
    // the routing plan may impose a smaller route-specific ceiling.
    let max_rounds = inputs
        .budget
        .max_total_provider_rounds
        .min(u32::from(inputs.plan.policy.max_rounds));
    let plan_context_limit = inputs.plan.policy.max_context_chars as u64;

    for slot in inputs.slots.iter().take(inputs.plan.roles.len()) {
        if !inputs.plan.roles.contains(&slot.role) {
            continue;
        }
        let messages = messages_for(inputs.user_text, inputs.packet, slot.role);
        let chars = crate::agent::estimate_context_chars(&messages) as u64;
        on_stage(ContributionStageEvent {
            role: slot.role,
            identity: slot.identity.clone(),
            started: true,
            outcome: None,
            detail: "bounded contribution started".into(),
        });
        let mut terminal =
            |availability: ContributionAvailability, rounds_sent: u32, chars_sent: u64| {
                stages.push(ContributionStageTelemetry {
                    role: slot.role,
                    profile_id: slot.identity.profile_id.clone(),
                    model: slot.identity.model.clone(),
                    qualification: slot.qualification,
                    provider_rounds: rounds_sent,
                    context_chars_sent: chars_sent,
                    outcome: availability,
                });
                on_stage(ContributionStageEvent {
                    role: slot.role,
                    identity: slot.identity.clone(),
                    started: false,
                    outcome: Some(availability),
                    detail: availability.as_str().into(),
                });
            };

        let mut sent = false;

        let availability =
            if rounds >= max_rounds || slot.qualification != ContributionQualification::Qualified {
                ContributionAvailability::Unavailable
            } else if chars > inputs.budget.context_char_budget as u64
                || chars > plan_context_limit
                || inputs
                    .budget
                    .max_context_chars_total
                    .is_some_and(|limit| used_chars.saturating_add(chars) > limit)
                || used_chars.saturating_add(chars) > plan_context_limit
            {
                ContributionAvailability::Malformed
            } else if cancel.is_some_and(|flag| flag.load(Ordering::SeqCst)) {
                ContributionAvailability::Cancelled
            } else if clock.deadline_reached() {
                ContributionAvailability::TimedOut
            } else {
                used_chars = used_chars.saturating_add(chars);
                rounds = rounds.saturating_add(1);
                sent = true;
                let mut buffered = String::new();
                let mut on_text = |text: String| buffered.push_str(&text);
                let completion = within_turn_deadline(
                    &clock,
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
                        match super::contributions::validate_contribution(
                            &body,
                            inputs.packet,
                            slot.identity.clone(),
                            slot.role,
                        ) {
                            Ok(contribution) => {
                                attempts.push(ContributionAttemptV1::completed(contribution));
                                ContributionAvailability::Completed
                            }
                            Err(_) => ContributionAvailability::Malformed,
                        }
                    }
                    Ok(Err(_)) => {
                        if cancel.is_some_and(|flag| flag.load(Ordering::SeqCst)) {
                            ContributionAvailability::Cancelled
                        } else {
                            ContributionAvailability::Failed
                        }
                    }
                    Err(TurnAwaitError::Cancelled) => ContributionAvailability::Cancelled,
                    Err(TurnAwaitError::Deadline) => ContributionAvailability::TimedOut,
                }
            };
        if availability != ContributionAvailability::Completed {
            attempts.push(ContributionAttemptV1::unavailable(
                slot.role,
                slot.identity.clone(),
                availability,
            ));
        }
        terminal(availability, u32::from(sent), if sent { chars } else { 0 });
        if matches!(
            availability,
            ContributionAvailability::Cancelled | ContributionAvailability::TimedOut
        ) {
            break;
        }
    }
    let report = reconcile_contributions(inputs.packet, &attempts);
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
                budget: budget(),
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
        assert_eq!(context_outcome.telemetry.stages[0].provider_rounds, 0);
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
            outcome.report.state,
            super::super::contributions::ReconciliationState::Unavailable
        );
    }
}
