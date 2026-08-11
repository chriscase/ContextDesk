//! The bounded fast-triage route driver.
//!
//! One run is deliberately small and deliberately finite:
//!
//! 1. exact persisted evidence selects the route, or it does not run at all;
//! 2. one synthesis attempt against the selected fast model, with the complete
//!    host packet;
//! 3. **at most one** category-specific correction, authored by the host;
//! 4. **at most one** visible escalation to an explicitly configured and
//!    explicitly authorized fallback model, carrying the byte-identical packet;
//! 5. a typed outcome — verified, honest partial, or escalation requested with
//!    the unchanged host packet and the failure categories.
//!
//! There is no loop anywhere in that list. The correction cap is clamped in
//! code rather than trusted from config, the escalation is a single attempt with
//! no correction of its own, and a failed escalation ends the run.
//!
//! The route owns no transport. It is handed already-resolved backends exactly
//! as [`crate::multi_model::pipeline`] is, so config, provider construction,
//! credentials, egress policy, and authorization all stay in the workflow layer
//! and a switch of profile or gateway is impossible to perform silently: this
//! module can only call a backend the caller handed it, under identities the
//! caller named.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tokio::time::Instant;

use crate::agent::{within_turn_deadline, ChatBackend, TurnAwaitError, TurnClock};
use crate::context_budgeting::synthesis_packing_budget;
use crate::error::{CoreError, CoreResult};
use crate::investigation_answer::{render_answer_markdown, AnswerEnvelopeV1};
use crate::router::TurnDeadlinePlan;

use super::packet::FastTriagePacketV1;
use super::prompt::{
    fast_triage_contract_fingerprint, fast_triage_evidence_block, fast_triage_messages,
};
use super::selection::{
    select_fast_triage_route, FastTriageRoleBinding, FastTriageRouteRecord,
    FastTriageRouteRejection, FastTriageRouteRequest, FastTriageRouteSelection,
    FastTriageWorkflowContract,
};
use super::telemetry::{
    FastTriageAttemptOutcome, FastTriageAttemptTelemetry, FastTriageEscalationState,
    FastTriageEscalationTelemetry, FastTriageOutcomeLabel, FastTriagePacketTelemetry,
    FastTriageStage, FastTriageTelemetryV1, FAST_TRIAGE_TELEMETRY_SCHEMA_V1,
};
use super::terminal::{FastTriageTerminal, FastTriageTerminalState};
use super::validate::{validate_fast_answer, FastTriageFailureCategory, FastTriageValidation};

/// Hard ceiling on bounded semantic corrections, enforced in code.
///
/// Config may lower this; nothing can raise it. "Exactly one bounded
/// correction" is a property of the route, not a setting a caller could relax.
pub const FAST_TRIAGE_MAX_CORRECTIONS: u8 = 1;

/// Hard ceiling on escalation attempts, enforced in code.
pub const FAST_TRIAGE_MAX_ESCALATION_ATTEMPTS: u8 = 1;

/// Bound on model-visible response accumulation per attempt, so a verbose
/// stream cannot starve the rest of the turn.
const FAST_TRIAGE_RESPONSE_CHAR_CAP: usize = 32_000;

/// An explicitly configured fallback model for the one visible escalation.
///
/// Both fields are host identities. There is no URL, endpoint, credential, or
/// provider kind here — the workflow layer resolves those and hands over a
/// built backend, so this type cannot describe a gateway to switch to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FastTriageFallback {
    /// Exact fallback provider profile id.
    pub profile_id: String,
    /// Exact fallback model id.
    pub model_id: String,
    /// Explicit authorization to send this packet to the fallback. `false`
    /// means configured-but-not-authorized, which is reported, never assumed.
    pub authorized: bool,
}

/// Per-run ceilings. Deterministic units the host always has.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FastTriageBudget {
    /// Whole-route wall-clock ceiling in ms (`0` = none).
    pub deadline_ms: u64,
    /// Hard model-facing context character budget for one attempt.
    pub context_char_budget: usize,
    /// Requested bounded corrections. Clamped to [`FAST_TRIAGE_MAX_CORRECTIONS`].
    pub max_corrections: u8,
}

impl Default for FastTriageBudget {
    fn default() -> Self {
        Self {
            deadline_ms: 0,
            context_char_budget: crate::sessions::DEFAULT_CONTEXT_CHAR_BUDGET,
            max_corrections: FAST_TRIAGE_MAX_CORRECTIONS,
        }
    }
}

impl FastTriageBudget {
    /// Corrections this run may actually consume.
    fn effective_corrections(&self) -> u8 {
        self.max_corrections.min(FAST_TRIAGE_MAX_CORRECTIONS)
    }
}

/// Inputs for one fast-triage route run.
pub struct FastTriageInputs<'a> {
    /// The user's question, verbatim.
    pub user_text: &'a str,
    /// The complete host-owned packet. Built by the caller from the same
    /// deterministic retrieval, ledger, grouping, and timeline every other
    /// path uses; this route never rebuilds it.
    pub packet: &'a FastTriagePacketV1,
    /// Identity the packet is expected to have. `Some` lets a host that
    /// captured the identity before this call prove the packet did not change
    /// underneath the turn.
    pub expected_packet_id: Option<&'a str>,
    /// Whether the host enabled this route for this turn.
    pub enabled: bool,
    /// Persisted route evidence.
    pub records: &'a [FastTriageRouteRecord],
    /// This turn's resolved provider profile id.
    pub profile_id: Option<&'a str>,
    /// This turn's resolved model id.
    pub model_id: Option<&'a str>,
    /// Explicitly configured fallback for the one visible escalation.
    pub fallback: Option<&'a FastTriageFallback>,
    /// Per-run ceilings.
    pub budget: FastTriageBudget,
    /// Absolute monotonic start shared with the turn.
    pub started_at: Option<Instant>,
    /// Cooperative cancel flag shared with the driving turn.
    pub cancel: Option<Arc<AtomicBool>>,
}

/// One stage-progress signal for hosts to surface. Host-authored: `detail` is
/// host JSON and never contains model text, prompts, or evidence.
#[derive(Debug, Clone)]
pub struct FastTriageStageEvent {
    /// Which bounded stage this signal belongs to.
    pub stage: FastTriageStage,
    /// `true` on entry, `false` on exit.
    pub started: bool,
    /// How the attempt ended, on exit.
    pub outcome: Option<FastTriageAttemptOutcome>,
    /// Host-authored JSON detail.
    pub detail: String,
}

/// The route's typed result.
#[derive(Debug)]
pub enum FastTriageRouteOutcome {
    /// Exact persisted evidence did not authorize this route. The caller keeps
    /// its established behavior unchanged.
    NotSelected {
        /// The exact host reason.
        rejection: FastTriageRouteRejection,
        /// Share-safe telemetry for the non-selection.
        telemetry: Box<FastTriageTelemetryV1>,
    },
    /// A host-validated typed answer.
    Verified {
        /// Host-owned answer, evidence ledger, and turn binding.
        envelope: Box<AnswerEnvelopeV1>,
        /// Deterministic host Markdown projection (visible text).
        content: String,
        /// Share-safe telemetry for the run.
        telemetry: Box<FastTriageTelemetryV1>,
    },
    /// No proposal passed and no escalation could change that. The host reports
    /// an honest partial/inconclusive result rather than an unvalidated answer.
    Partial {
        /// Ordered host validation categories from the final attempt.
        categories: Vec<FastTriageFailureCategory>,
        /// Share-safe telemetry for the run.
        telemetry: Box<FastTriageTelemetryV1>,
    },
    /// No proposal passed and escalation is warranted but could not be
    /// performed here. The **unchanged** host packet is handed back with the
    /// failure categories so a caller can act on it.
    EscalationRequested {
        /// The byte-identical packet that was sent, unchanged.
        packet: Box<FastTriagePacketV1>,
        /// Ordered host validation categories from the final attempt.
        categories: Vec<FastTriageFailureCategory>,
        /// Share-safe telemetry for the run.
        telemetry: Box<FastTriageTelemetryV1>,
    },
    /// The turn was cancelled.
    Cancelled {
        /// Share-safe telemetry for the run.
        telemetry: Box<FastTriageTelemetryV1>,
    },
    /// The route hit its deadline before an answer.
    Deadline {
        /// Share-safe telemetry for the run.
        telemetry: Box<FastTriageTelemetryV1>,
    },
    /// A provider call failed.
    ProviderFailed {
        /// The provider error, for the caller's existing terminal classifier.
        error: Box<CoreError>,
        /// Share-safe telemetry for the run.
        telemetry: Box<FastTriageTelemetryV1>,
    },
}

impl FastTriageRouteOutcome {
    /// The run's share-safe telemetry, whatever the outcome.
    pub fn telemetry(&self) -> &FastTriageTelemetryV1 {
        match self {
            Self::NotSelected { telemetry, .. }
            | Self::Verified { telemetry, .. }
            | Self::Partial { telemetry, .. }
            | Self::EscalationRequested { telemetry, .. }
            | Self::Cancelled { telemetry }
            | Self::Deadline { telemetry }
            | Self::ProviderFailed { telemetry, .. } => telemetry,
        }
    }
}

/// Build a flat deadline plan: every phase caps at the whole-route ceiling, so
/// this sequential route is bounded only by `total_ms`.
fn flat_plan(total_ms: u64) -> TurnDeadlinePlan {
    TurnDeadlinePlan {
        total_ms,
        choosing_ms: total_ms,
        retrieving_ms: total_ms,
        synthesizing_ms: total_ms,
        explicit: total_ms > 0,
    }
}

/// Bounded accumulation of one attempt's streamed text.
struct BoundedStream {
    text: String,
    chars: usize,
    exceeded: bool,
}

impl BoundedStream {
    fn new() -> Self {
        Self {
            text: String::new(),
            chars: 0,
            exceeded: false,
        }
    }

    fn push(&mut self, fragment: &str) {
        if self.exceeded {
            return;
        }
        for c in fragment.chars() {
            if self.chars >= FAST_TRIAGE_RESPONSE_CHAR_CAP {
                self.exceeded = true;
                return;
            }
            self.text.push(c);
            self.chars += 1;
        }
    }

    /// The accumulated text, or empty when the cap was exceeded — an
    /// over-cap stream is truncated evidence about the answer, not the answer.
    fn take(self) -> String {
        if self.exceeded {
            String::new()
        } else {
            self.text
        }
    }
}

/// Running telemetry for one route run.
struct RunTelemetry {
    attempts: Vec<FastTriageAttemptTelemetry>,
    provider_attempts: u32,
    correction_used: bool,
    correction_category: Option<FastTriageFailureCategory>,
    validation_categories: Vec<FastTriageFailureCategory>,
    escalation: FastTriageEscalationTelemetry,
}

/// The result of one bounded provider attempt.
enum AttemptResult {
    Accepted(Box<AnswerEnvelopeV1>),
    Rejected(Vec<FastTriageFailureCategory>),
    Cancelled,
    Deadline,
    ProviderFailed(Box<CoreError>),
}

/// Non-selection telemetry, so a caller reports *why* the established path ran.
fn not_selected_telemetry(
    rejection: FastTriageRouteRejection,
    contract: FastTriageWorkflowContract,
    fingerprint: String,
    deadline_ms: u64,
) -> FastTriageTelemetryV1 {
    FastTriageTelemetryV1 {
        schema: FAST_TRIAGE_TELEMETRY_SCHEMA_V1.into(),
        route_selected: false,
        selection_rejection: Some(rejection),
        workflow_contract: contract,
        contract_fingerprint: fingerprint,
        role: None,
        packet: None,
        attempts: Vec::new(),
        provider_attempts: 0,
        correction_used: false,
        correction_category: None,
        validation_categories: Vec::new(),
        escalation: FastTriageEscalationTelemetry::not_requested(),
        deadline_ms,
        outcome: FastTriageOutcomeLabel::NotSelected,
    }
}

#[allow(clippy::too_many_arguments)] // one bounded attempt has genuinely this many host inputs
async fn run_attempt(
    backend: &dyn ChatBackend,
    clock: &TurnClock,
    cancel: Option<&AtomicBool>,
    packet: &FastTriagePacketV1,
    messages: &[crate::chat::ChatMessage],
    stage: FastTriageStage,
    role: &FastTriageRoleBinding,
    run: &mut RunTelemetry,
    on_stage: &mut (dyn FnMut(FastTriageStageEvent) + Send),
) -> AttemptResult {
    on_stage(FastTriageStageEvent {
        stage,
        started: true,
        outcome: None,
        detail: serde_json::json!({
            "schema": FAST_TRIAGE_TELEMETRY_SCHEMA_V1,
            "stage": stage.as_str(),
            "profile_id": role.profile_id,
            "model_id": role.model_id,
            "packet_id": packet.packet_id(),
            "provider_attempts": run.provider_attempts,
        })
        .to_string(),
    });

    let mut stream = BoundedStream::new();
    let mut on_text = |fragment: String| stream.push(&fragment);
    // Count a logical provider attempt when it is issued. A timeout,
    // cancellation, or provider error consumes the same attempt as a successful
    // completion; transport-library retries stay below this boundary.
    run.provider_attempts = run.provider_attempts.saturating_add(1);
    let completion = match within_turn_deadline(
        clock,
        cancel,
        backend.complete_streaming(messages, &[], &mut on_text, cancel),
    )
    .await
    {
        Ok(Ok(completion)) => completion,
        Ok(Err(error)) => {
            // Cancellation authority is the host flag, never provider-controlled
            // error text: a transport that observes the flag first and returns an
            // ordinary connection error must not manufacture a provider failure.
            let cancelled = cancel.is_some_and(|flag| flag.load(Ordering::Relaxed));
            let outcome = if cancelled {
                FastTriageAttemptOutcome::Cancelled
            } else {
                FastTriageAttemptOutcome::ProviderFailed
            };
            record_attempt(run, stage, role, None, outcome, Vec::new());
            emit_finished(on_stage, stage, outcome, packet, run);
            return if cancelled {
                AttemptResult::Cancelled
            } else {
                AttemptResult::ProviderFailed(Box::new(error))
            };
        }
        Err(TurnAwaitError::Cancelled) => {
            record_attempt(
                run,
                stage,
                role,
                None,
                FastTriageAttemptOutcome::Cancelled,
                Vec::new(),
            );
            emit_finished(
                on_stage,
                stage,
                FastTriageAttemptOutcome::Cancelled,
                packet,
                run,
            );
            return AttemptResult::Cancelled;
        }
        Err(TurnAwaitError::Deadline) => {
            record_attempt(
                run,
                stage,
                role,
                None,
                FastTriageAttemptOutcome::Deadline,
                Vec::new(),
            );
            emit_finished(
                on_stage,
                stage,
                FastTriageAttemptOutcome::Deadline,
                packet,
                run,
            );
            return AttemptResult::Deadline;
        }
    };

    let terminal = FastTriageTerminal::parse(&completion, &stream.take());
    let categories = match terminal.state() {
        FastTriageTerminalState::EmptyVisible => {
            vec![FastTriageFailureCategory::EmptyVisibleAnswer]
        }
        FastTriageTerminalState::Malformed => vec![FastTriageFailureCategory::MalformedTerminal],
        FastTriageTerminalState::TypedObject => {
            let object = terminal.typed_object().unwrap_or_default();
            match validate_fast_answer(object, packet) {
                FastTriageValidation::Accepted(envelope) => {
                    // Re-check identity at the acceptance boundary as well as
                    // at entry: an answer is only accepted against the exact
                    // packet that was sent.
                    if envelope.binding.ledger_digest != packet.ledger().binding().ledger_digest {
                        vec![FastTriageFailureCategory::PacketIdentityChanged]
                    } else {
                        record_attempt(
                            run,
                            stage,
                            role,
                            Some(&terminal),
                            FastTriageAttemptOutcome::Accepted,
                            Vec::new(),
                        );
                        emit_finished(
                            on_stage,
                            stage,
                            FastTriageAttemptOutcome::Accepted,
                            packet,
                            run,
                        );
                        return AttemptResult::Accepted(envelope);
                    }
                }
                FastTriageValidation::Rejected(categories) => categories,
            }
        }
    };
    record_attempt(
        run,
        stage,
        role,
        Some(&terminal),
        FastTriageAttemptOutcome::Rejected,
        categories.clone(),
    );
    emit_finished(
        on_stage,
        stage,
        FastTriageAttemptOutcome::Rejected,
        packet,
        run,
    );
    AttemptResult::Rejected(categories)
}

fn record_attempt(
    run: &mut RunTelemetry,
    stage: FastTriageStage,
    role: &FastTriageRoleBinding,
    terminal: Option<&FastTriageTerminal>,
    outcome: FastTriageAttemptOutcome,
    categories: Vec<FastTriageFailureCategory>,
) {
    run.validation_categories = categories.clone();
    run.attempts.push(FastTriageAttemptTelemetry {
        stage,
        profile_id: role.profile_id.clone(),
        model_id: role.model_id.clone(),
        terminal_state: terminal.map(FastTriageTerminal::state),
        reasoning_present: terminal.is_some_and(FastTriageTerminal::reasoning_present),
        reasoning_chars: terminal.map_or(0, FastTriageTerminal::reasoning_chars),
        visible_chars: terminal.map_or(0, FastTriageTerminal::visible_chars),
        tool_calls: terminal.map_or(0, |terminal| terminal.tool_calls().len()),
        outcome,
        categories,
    });
}

fn emit_finished(
    on_stage: &mut (dyn FnMut(FastTriageStageEvent) + Send),
    stage: FastTriageStage,
    outcome: FastTriageAttemptOutcome,
    packet: &FastTriagePacketV1,
    run: &RunTelemetry,
) {
    on_stage(FastTriageStageEvent {
        stage,
        started: false,
        outcome: Some(outcome),
        detail: serde_json::json!({
            "schema": FAST_TRIAGE_TELEMETRY_SCHEMA_V1,
            "stage": stage.as_str(),
            "outcome": outcome.as_str(),
            "packet_id": packet.packet_id(),
            "provider_attempts": run.provider_attempts,
            "validation_categories": run
                .validation_categories
                .iter()
                .map(|category| category.as_str())
                .collect::<Vec<_>>(),
        })
        .to_string(),
    });
}

/// Run one bounded fast-triage route.
///
/// `fallback_backend` is used **only** when `inputs.fallback` names a
/// configured, authorized fallback. Passing a backend without that
/// configuration can never cause a call: a gateway change requires host config,
/// not a spare handle.
pub async fn run_fast_triage_route(
    primary: &dyn ChatBackend,
    fallback_backend: Option<&dyn ChatBackend>,
    inputs: FastTriageInputs<'_>,
    on_stage: &mut (dyn FnMut(FastTriageStageEvent) + Send),
) -> CoreResult<FastTriageRouteOutcome> {
    let contract = FastTriageWorkflowContract::HostGroundedSynthesisCompletePacket;
    let fingerprint = fast_triage_contract_fingerprint();
    let deadline_ms = inputs.budget.deadline_ms;

    let selection = select_fast_triage_route(
        inputs.records,
        FastTriageRouteRequest {
            enabled: inputs.enabled,
            profile_id: inputs.profile_id,
            model_id: inputs.model_id,
            workflow_contract: contract,
            contract_fingerprint: &fingerprint,
        },
    );
    let selected = match selection {
        FastTriageRouteSelection::Selected(selected) => selected,
        FastTriageRouteSelection::NotSelected(rejection) => {
            return Ok(FastTriageRouteOutcome::NotSelected {
                rejection,
                telemetry: Box::new(not_selected_telemetry(
                    rejection,
                    contract,
                    fingerprint,
                    deadline_ms,
                )),
            })
        }
    };

    let packet = inputs.packet;
    let mut run = RunTelemetry {
        attempts: Vec::new(),
        provider_attempts: 0,
        correction_used: false,
        correction_category: None,
        validation_categories: Vec::new(),
        escalation: FastTriageEscalationTelemetry::not_requested(),
    };
    let finish = |run: RunTelemetry, outcome: FastTriageOutcomeLabel| FastTriageTelemetryV1 {
        schema: FAST_TRIAGE_TELEMETRY_SCHEMA_V1.into(),
        route_selected: true,
        selection_rejection: None,
        workflow_contract: selected.workflow_contract,
        contract_fingerprint: selected.contract_fingerprint.clone(),
        role: Some(selected.role.clone()),
        packet: Some(FastTriagePacketTelemetry::from_packet(packet)),
        attempts: run.attempts,
        provider_attempts: run.provider_attempts,
        correction_used: run.correction_used,
        correction_category: run.correction_category,
        validation_categories: run.validation_categories,
        escalation: run.escalation,
        deadline_ms,
        outcome,
    };

    // A packet that no longer matches the identity the host captured is stale.
    // No provider call is issued for evidence that changed underneath the turn.
    if inputs
        .expected_packet_id
        .is_some_and(|expected| expected != packet.packet_id())
    {
        run.validation_categories = vec![FastTriageFailureCategory::PacketIdentityChanged];
        return Ok(FastTriageRouteOutcome::Partial {
            categories: run.validation_categories.clone(),
            telemetry: Box::new(finish(run, FastTriageOutcomeLabel::PartialInconclusive)),
        });
    }

    let cancel: Option<&AtomicBool> = inputs.cancel.as_deref();
    if cancel.is_some_and(|flag| flag.load(Ordering::Relaxed)) {
        return Ok(FastTriageRouteOutcome::Cancelled {
            telemetry: Box::new(finish(run, FastTriageOutcomeLabel::Cancelled)),
        });
    }

    // Mint the untrusted-data envelope once and replay these exact bytes on the
    // correction and on the escalation: "the unchanged packet was sent" is then
    // true at the byte level, not merely at the identifier level.
    let evidence_block = fast_triage_evidence_block(packet);
    let packing_budget = synthesis_packing_budget(inputs.budget.context_char_budget);
    let initial = fast_triage_messages(inputs.user_text, packet, &evidence_block, None);
    if crate::agent::estimate_context_chars(&initial) > packing_budget {
        // The complete packet is the point of this route. A packet that does
        // not fit is not silently trimmed into a partial one — the route
        // declines and the caller keeps its established behavior.
        return Ok(FastTriageRouteOutcome::NotSelected {
            rejection: FastTriageRouteRejection::RouteDisabled,
            telemetry: Box::new(finish(run, FastTriageOutcomeLabel::NotSelected)),
        });
    }

    let clock = TurnClock::new(flat_plan(deadline_ms), inputs.started_at);
    let corrections_allowed = inputs.budget.effective_corrections();
    let mut correction_category: Option<FastTriageFailureCategory> = None;
    let mut categories: Vec<FastTriageFailureCategory> = Vec::new();

    for attempt in 0..=u32::from(corrections_allowed) {
        let stage = if attempt == 0 {
            FastTriageStage::Primary
        } else {
            FastTriageStage::Correction
        };
        let messages = if attempt == 0 {
            initial.clone()
        } else {
            fast_triage_messages(
                inputs.user_text,
                packet,
                &evidence_block,
                correction_category,
            )
        };
        if stage == FastTriageStage::Correction {
            run.correction_used = true;
            run.correction_category = correction_category;
        }
        match run_attempt(
            primary,
            &clock,
            cancel,
            packet,
            &messages,
            stage,
            &selected.role,
            &mut run,
            on_stage,
        )
        .await
        {
            AttemptResult::Accepted(envelope) => {
                let label = if attempt == 0 {
                    FastTriageOutcomeLabel::VerifiedFastAnswer
                } else {
                    FastTriageOutcomeLabel::VerifiedAfterCorrection
                };
                let content = render_answer_markdown(&envelope);
                return Ok(FastTriageRouteOutcome::Verified {
                    envelope,
                    content,
                    telemetry: Box::new(finish(run, label)),
                });
            }
            AttemptResult::Rejected(rejected) => {
                categories = rejected;
                // A host-side failure is not something a model can repair.
                // Asking it to try would be theatre, so the route stops.
                if categories.iter().any(|category| category.is_host_side()) {
                    return Ok(FastTriageRouteOutcome::Partial {
                        categories,
                        telemetry: Box::new(finish(
                            run,
                            FastTriageOutcomeLabel::PartialInconclusive,
                        )),
                    });
                }
                correction_category = categories.first().copied();
            }
            AttemptResult::Cancelled => {
                return Ok(FastTriageRouteOutcome::Cancelled {
                    telemetry: Box::new(finish(run, FastTriageOutcomeLabel::Cancelled)),
                })
            }
            AttemptResult::Deadline => {
                return Ok(FastTriageRouteOutcome::Deadline {
                    telemetry: Box::new(finish(run, FastTriageOutcomeLabel::Deadline)),
                })
            }
            AttemptResult::ProviderFailed(error) => {
                return Ok(FastTriageRouteOutcome::ProviderFailed {
                    error,
                    telemetry: Box::new(finish(run, FastTriageOutcomeLabel::ProviderFailed)),
                })
            }
        }
    }

    // The fast lane did not produce a verified answer. Escalate exactly once,
    // and only to an explicitly configured, explicitly authorized fallback.
    let escalation_target = match (inputs.fallback, fallback_backend) {
        (Some(fallback), Some(backend)) if fallback.authorized => Some((fallback, backend)),
        (Some(fallback), _) => {
            run.escalation = FastTriageEscalationTelemetry {
                state: if fallback.authorized {
                    FastTriageEscalationState::NotConfigured
                } else {
                    FastTriageEscalationState::NotAuthorized
                },
                profile_id: Some(fallback.profile_id.clone()),
                model_id: Some(fallback.model_id.clone()),
                packet_id: None,
            };
            None
        }
        (None, _) => {
            run.escalation = FastTriageEscalationTelemetry {
                state: FastTriageEscalationState::NotConfigured,
                profile_id: None,
                model_id: None,
                packet_id: None,
            };
            None
        }
    };
    let Some((fallback, backend)) = escalation_target else {
        return Ok(FastTriageRouteOutcome::EscalationRequested {
            packet: Box::new(packet.clone()),
            categories: categories.clone(),
            telemetry: Box::new(finish(run, FastTriageOutcomeLabel::EscalationRequested)),
        });
    };

    let escalation_role = FastTriageRoleBinding {
        profile_id: fallback.profile_id.clone(),
        model_id: fallback.model_id.clone(),
    };
    // The escalation receives the byte-identical packet plus the host's own
    // category instruction — never the rejected proposal, and never a second
    // correction round of its own.
    let escalation_messages = fast_triage_messages(
        inputs.user_text,
        packet,
        &evidence_block,
        categories.first().copied(),
    );
    run.escalation = FastTriageEscalationTelemetry {
        state: FastTriageEscalationState::Requested,
        profile_id: Some(fallback.profile_id.clone()),
        model_id: Some(fallback.model_id.clone()),
        packet_id: Some(packet.packet_id().to_string()),
    };
    let _: u8 = FAST_TRIAGE_MAX_ESCALATION_ATTEMPTS; // one attempt, enforced by shape
    match run_attempt(
        backend,
        &clock,
        cancel,
        packet,
        &escalation_messages,
        FastTriageStage::Escalation,
        &escalation_role,
        &mut run,
        on_stage,
    )
    .await
    {
        AttemptResult::Accepted(envelope) => {
            run.escalation.state = FastTriageEscalationState::Succeeded;
            let content = render_answer_markdown(&envelope);
            Ok(FastTriageRouteOutcome::Verified {
                envelope,
                content,
                telemetry: Box::new(finish(run, FastTriageOutcomeLabel::VerifiedAfterEscalation)),
            })
        }
        AttemptResult::Rejected(rejected) => {
            run.escalation.state = FastTriageEscalationState::Failed;
            Ok(FastTriageRouteOutcome::Partial {
                categories: rejected,
                telemetry: Box::new(finish(run, FastTriageOutcomeLabel::PartialInconclusive)),
            })
        }
        AttemptResult::Cancelled => {
            run.escalation.state = FastTriageEscalationState::Failed;
            Ok(FastTriageRouteOutcome::Cancelled {
                telemetry: Box::new(finish(run, FastTriageOutcomeLabel::Cancelled)),
            })
        }
        AttemptResult::Deadline => {
            run.escalation.state = FastTriageEscalationState::Failed;
            Ok(FastTriageRouteOutcome::Deadline {
                telemetry: Box::new(finish(run, FastTriageOutcomeLabel::Deadline)),
            })
        }
        AttemptResult::ProviderFailed(error) => {
            run.escalation.state = FastTriageEscalationState::Failed;
            Ok(FastTriageRouteOutcome::ProviderFailed {
                error,
                telemetry: Box::new(finish(run, FastTriageOutcomeLabel::ProviderFailed)),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_correction_cap_is_clamped_in_code_not_trusted_from_config() {
        for requested in [0, 1, 2, 5, u8::MAX] {
            let budget = FastTriageBudget {
                max_corrections: requested,
                ..FastTriageBudget::default()
            };
            assert!(budget.effective_corrections() <= FAST_TRIAGE_MAX_CORRECTIONS);
            assert_eq!(
                budget.effective_corrections(),
                requested.min(FAST_TRIAGE_MAX_CORRECTIONS)
            );
        }
        assert_eq!(FAST_TRIAGE_MAX_CORRECTIONS, 1);
        assert_eq!(FAST_TRIAGE_MAX_ESCALATION_ATTEMPTS, 1);
    }

    #[test]
    fn an_over_cap_stream_is_discarded_rather_than_truncated_into_an_answer() {
        let mut stream = BoundedStream::new();
        stream.push(&"x".repeat(FAST_TRIAGE_RESPONSE_CHAR_CAP + 1));
        assert!(stream.exceeded);
        assert!(stream.take().is_empty());

        let mut bounded = BoundedStream::new();
        bounded.push("{\"schema\":\"x\"}");
        assert_eq!(bounded.take(), "{\"schema\":\"x\"}");
    }

    #[test]
    fn the_fallback_type_cannot_express_a_gateway() {
        let debug = format!(
            "{:?}",
            FastTriageFallback {
                profile_id: "profile-b".into(),
                model_id: "model-b".into(),
                authorized: true,
            }
        );
        for forbidden in [
            "url", "http", "host", "port", "endpoint", "api_key", "token",
        ] {
            assert!(
                !debug.to_ascii_lowercase().contains(forbidden),
                "fallback leaked {forbidden}"
            );
        }
    }
}
