//! Host-neutral aggregation of provider-turn telemetry.
//!
//! Transport capture lives in `cd_core::provider_telemetry` and is attached to
//! each [`TracedCall`] by the OpenAI-compatible client + `TracingChatBackend`.
//! This module is the **only** place that folds those captures together with
//! configured profile/model, application retry reasons, context-budget
//! snapshots, and final turn outcome into the shared
//! [`ProviderTurnTelemetry`] DTO. CLI and Tauri must project that DTO; they
//! must not invent token counts, costs, or observed routes.
//!
//! # Aggregation policy
//!
//! - Every provider round’s transport is preserved on
//!   [`ProviderTurnTelemetry::rounds`].
//! - Turn-level prompt / completion / reasoning / cached / total tokens and
//!   cost are **sums across all rounds only when every round reports that
//!   metric**. Any omission → that turn-level field is absent/unknown (never
//!   a partial sum, never invented as zero).
//! - Identity fields (`response_model`, `provider_request_id`,
//!   `observed_route`, `finish_reason`) are **not** summed: they come from the
//!   last round that authoritatively reported them (finish reason from the
//!   last completed round).
//!
//! # Round / retry semantics
//!
//! - Ordinary tool-call continuation and tool-result synthesis are **not**
//!   retries and must not carry an application retry reason.
//! - An application retry reason is emitted only when a causal retry decision
//!   was recorded on the [`TracedCall`] at the decision point (e.g.
//!   `tools_unsupported`, `context_compacted`). Missing cause → absent, never
//!   invented as `"application_round"`.

use cd_core::context_budgeting::ContextBudgetTelemetry;
use cd_core::events::StreamEvent;
use cd_core::provider_telemetry::{
    finish_reason_is_length, sanitize_configured_identity, sum_reported_f64_all,
    sum_reported_u64_all, ApplicationRetryReason, ModelIdentityStatus, ObservedRoute,
    ProviderRoundTelemetry, ProviderTurnTelemetry, ResponseModelIdentity,
};
use cd_core::turn_trace::{TracedCall, TracedOutcome};

/// Inputs required to build authoritative turn telemetry.
#[derive(Debug, Clone)]
pub struct ProviderTelemetryAggregateInput<'a> {
    /// Configured provider profile id for this turn.
    pub configured_profile_id: &'a str,
    /// Model id requested / configured for this turn.
    pub configured_model: &'a str,
    /// Provider rounds captured by the shared trace sink.
    pub calls: &'a [TracedCall],
    /// Stream events from the same turn (budget, errors, terminal reason).
    pub events: &'a [StreamEvent],
}

fn last_context_budget(events: &[StreamEvent]) -> Option<ContextBudgetTelemetry> {
    events.iter().rev().find_map(|e| match e {
        StreamEvent::ContextBudget { telemetry } => Some(telemetry.clone()),
        _ => None,
    })
}

fn final_turn_outcome(events: &[StreamEvent]) -> Option<String> {
    events.iter().rev().find_map(|e| match e {
        StreamEvent::TurnCompleted { reason } => Some(reason.clone()),
        _ => None,
    })
}

fn round_from_call(call: &TracedCall) -> ProviderRoundTelemetry {
    let (outcome, finish_reason, tool_call_count, error) = match &call.outcome {
        TracedOutcome::Completed {
            finish_reason,
            tool_call_count,
        } => (
            "completed".to_string(),
            Some(finish_reason.clone()),
            Some(*tool_call_count),
            None,
        ),
        TracedOutcome::Failed { message } => {
            ("failed".to_string(), None, None, Some(message.clone()))
        }
        // Fixed terminal class strings only — never invent bodies from host
        // cancel/deadline paths (those outcomes carry no message by design).
        TracedOutcome::Cancelled => ("cancelled".to_string(), None, None, None),
        TracedOutcome::TimedOut => ("timed_out".to_string(), None, None, None),
    };
    let truncated = finish_reason
        .as_deref()
        .is_some_and(finish_reason_is_length);
    ProviderRoundTelemetry {
        round: u32::try_from(call.seq).unwrap_or(u32::MAX),
        latency_ms: Some(call.elapsed_ms),
        finish_reason,
        tool_call_count,
        outcome,
        error,
        empty_visible_answer: call.empty_visible_answer,
        truncated_by_length: truncated,
        transport: call.transport.clone(),
        // Only the reason captured at the retry decision point — never inferred
        // from round index / ordinary multi-round continuation.
        application_retry_reason: call.application_retry_reason.clone(),
    }
}

/// Last authoritative identity outcome. A rejection is authoritative and must
/// not fall back to an older certified value; absence is not authoritative.
fn last_response_model_identity(
    rounds: &[ProviderRoundTelemetry],
) -> (Option<String>, ModelIdentityStatus) {
    for round in rounds.iter().rev() {
        match round.transport.response_model_identity() {
            ResponseModelIdentity::Certified { value } => {
                return (Some(value), ModelIdentityStatus::Certified);
            }
            ResponseModelIdentity::Rejected => return (None, ModelIdentityStatus::Rejected),
            ResponseModelIdentity::Absent => {}
        }
    }
    (None, ModelIdentityStatus::Absent)
}

fn last_provider_request_id(rounds: &[ProviderRoundTelemetry]) -> Option<String> {
    rounds
        .iter()
        .rev()
        .find_map(|r| r.transport.provider_request_id.clone())
}

fn last_observed_route(rounds: &[ProviderRoundTelemetry]) -> ObservedRoute {
    rounds
        .iter()
        .rev()
        .find_map(|r| match &r.transport.observed_route {
            ObservedRoute::Unknown => None,
            reported @ ObservedRoute::Reported { .. } => Some(reported.clone()),
        })
        .unwrap_or(ObservedRoute::Unknown)
}

fn application_retries_from_rounds(
    rounds: &[ProviderRoundTelemetry],
) -> Vec<ApplicationRetryReason> {
    rounds
        .iter()
        .filter_map(|r| {
            r.application_retry_reason
                .as_ref()
                .map(|reason| ApplicationRetryReason {
                    round: r.round,
                    reason: reason.clone(),
                })
        })
        .collect()
}

fn sum_present_u64<F>(rounds: &[ProviderRoundTelemetry], mut get: F) -> Option<u64>
where
    F: FnMut(&ProviderRoundTelemetry) -> Option<u64>,
{
    let mut seen = false;
    let mut total = 0u64;
    for round in rounds {
        let Some(value) = get(round) else {
            continue;
        };
        seen = true;
        total = total.checked_add(value)?;
    }
    seen.then_some(total)
}

/// Aggregate host-neutral provider-turn telemetry.
///
/// This is the authoritative fold-in shared by CLI and Tauri. It never copies
/// [`ProviderTelemetryAggregateInput::configured_model`] into
/// [`ProviderTurnTelemetry::observed_route`] or [`ProviderTurnTelemetry::response_model`].
pub fn aggregate_provider_turn_telemetry(
    input: ProviderTelemetryAggregateInput<'_>,
) -> ProviderTurnTelemetry {
    let rounds: Vec<ProviderRoundTelemetry> = input.calls.iter().map(round_from_call).collect();

    let retries = application_retries_from_rounds(&rounds);
    let last_completed = rounds.iter().rev().find(|r| r.outcome == "completed");
    let tool_call_count = rounds
        .iter()
        .filter_map(|r| r.tool_call_count)
        .sum::<usize>();
    let latency_ms = if rounds.is_empty() {
        None
    } else {
        Some(rounds.iter().filter_map(|r| r.latency_ms).sum())
    };
    let (response_model, model_identity_status) = last_response_model_identity(&rounds);

    ProviderTurnTelemetry {
        configured_profile_id: sanitize_configured_identity(input.configured_profile_id),
        configured_model: sanitize_configured_identity(input.configured_model),
        response_model,
        model_identity_status,
        provider_request_id: last_provider_request_id(&rounds),
        observed_route: last_observed_route(&rounds),
        prompt_tokens: sum_reported_u64_all(&rounds, |r| r.transport.prompt_tokens),
        completion_tokens: sum_reported_u64_all(&rounds, |r| r.transport.completion_tokens),
        reasoning_tokens: sum_reported_u64_all(&rounds, |r| r.transport.reasoning_tokens),
        reasoning_content_chars: sum_present_u64(&rounds, |r| r.transport.reasoning_content_chars),
        cached_tokens: sum_reported_u64_all(&rounds, |r| r.transport.cached_tokens),
        total_tokens: sum_reported_u64_all(&rounds, |r| r.transport.total_tokens),
        cost: sum_reported_f64_all(&rounds, |r| r.transport.cost),
        context_budget: last_context_budget(input.events),
        provider_round_count: u32::try_from(rounds.len()).unwrap_or(u32::MAX),
        application_retry_reasons: retries,
        final_turn_outcome: final_turn_outcome(input.events),
        finish_reason: last_completed.and_then(|r| r.finish_reason.clone()),
        empty_visible_answer: last_completed
            .map(|r| r.empty_visible_answer)
            .unwrap_or(false),
        truncated_by_length: last_completed
            .map(|r| r.truncated_by_length)
            .unwrap_or(false),
        tool_call_count,
        latency_ms,
        rounds,
    }
}

/// Project aggregated telemetry as the shared stream event both hosts understand.
pub fn provider_telemetry_stream_event(telemetry: ProviderTurnTelemetry) -> StreamEvent {
    StreamEvent::ProviderTelemetry {
        telemetry: Box::new(telemetry),
    }
}

/// Convenience: aggregate and wrap as a stream event.
pub fn aggregate_provider_telemetry_event(
    input: ProviderTelemetryAggregateInput<'_>,
) -> StreamEvent {
    provider_telemetry_stream_event(aggregate_provider_turn_telemetry(input))
}

#[cfg(test)]
mod tests {
    use super::*;
    use cd_core::provider_telemetry::{
        ModelIdentityStatus, ObservedRoute, ProviderTransportTelemetry,
    };
    use cd_core::turn_trace::{TracedCall, TracedMessage, TracedOutcome};

    fn call_with_transport(
        seq: usize,
        transport: ProviderTransportTelemetry,
        finish: &str,
        content_empty: bool,
    ) -> TracedCall {
        call_with_retry(seq, transport, finish, content_empty, None)
    }

    fn call_with_retry(
        seq: usize,
        transport: ProviderTransportTelemetry,
        finish: &str,
        content_empty: bool,
        application_retry_reason: Option<&str>,
    ) -> TracedCall {
        TracedCall {
            seq,
            elapsed_ms: 12,
            tool_names: vec![],
            messages: vec![TracedMessage {
                role: "user".into(),
                content: "hi".into(),
                char_count: 2,
                truncated: false,
            }],
            context_used_chars: 2,
            messages_capped: false,
            outcome: TracedOutcome::Completed {
                finish_reason: finish.into(),
                tool_call_count: 0,
            },
            transport,
            empty_visible_answer: content_empty,
            application_retry_reason: application_retry_reason.map(str::to_string),
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn full_transport(
        prompt: u64,
        completion: u64,
        reasoning: u64,
        cached: u64,
        total: u64,
        cost: f64,
        model: &str,
        req: &str,
    ) -> ProviderTransportTelemetry {
        ProviderTransportTelemetry {
            response_model: Some(model.into()),
            model_identity_status: ModelIdentityStatus::Certified,
            provider_request_id: Some(req.into()),
            observed_route: ObservedRoute::Reported {
                value: "anthropic".into(),
            },
            prompt_tokens: Some(prompt),
            completion_tokens: Some(completion),
            reasoning_tokens: Some(reasoning),
            reasoning_content_chars: None,
            cached_tokens: Some(cached),
            total_tokens: Some(total),
            cost: Some(cost),
            reasoning_effort_requested: None,
            reasoning_effort_effective: None,
        }
    }

    #[test]
    fn configured_model_never_becomes_observed_route() {
        let transport = ProviderTransportTelemetry {
            response_model: Some("anthropic/claude-sonnet-4".into()),
            model_identity_status: ModelIdentityStatus::Certified,
            ..Default::default()
        };
        let calls = vec![call_with_transport(0, transport, "stop", false)];
        let events = vec![StreamEvent::TurnCompleted {
            reason: "stop".into(),
        }];
        let tel = aggregate_provider_turn_telemetry(ProviderTelemetryAggregateInput {
            configured_profile_id: "openai-compatible",
            configured_model: "anthropic/claude-sonnet-4",
            calls: &calls,
            events: &events,
        });
        assert_eq!(tel.configured_model, "anthropic/claude-sonnet-4");
        assert_eq!(
            tel.response_model.as_deref(),
            Some("anthropic/claude-sonnet-4")
        );
        assert_eq!(tel.observed_route, ObservedRoute::Unknown);
    }

    #[test]
    fn vercel_shaped_round_preserves_cost_and_route() {
        let transport = full_transport(
            10,
            20,
            8,
            4,
            30,
            0.00123,
            "anthropic/claude-sonnet-4",
            "chatcmpl-1",
        );
        let calls = vec![call_with_transport(0, transport, "stop", false)];
        let events = vec![StreamEvent::TurnCompleted {
            reason: "stop".into(),
        }];
        let tel = aggregate_provider_turn_telemetry(ProviderTelemetryAggregateInput {
            configured_profile_id: "openai-compatible",
            configured_model: "anthropic/claude-sonnet-4",
            calls: &calls,
            events: &events,
        });
        assert_eq!(tel.cost, Some(0.00123));
        assert_eq!(tel.reasoning_tokens, Some(8));
        assert_eq!(tel.cached_tokens, Some(4));
        assert_eq!(
            tel.observed_route,
            ObservedRoute::Reported {
                value: "anthropic".into()
            }
        );
        assert_eq!(tel.provider_round_count, 1);
    }

    #[test]
    fn length_finish_with_empty_visible_answer() {
        let calls = vec![call_with_transport(
            0,
            ProviderTransportTelemetry::default(),
            "length",
            true,
        )];
        let events = vec![StreamEvent::TurnCompleted {
            reason: "stop".into(),
        }];
        let tel = aggregate_provider_turn_telemetry(ProviderTelemetryAggregateInput {
            configured_profile_id: "p",
            configured_model: "m",
            calls: &calls,
            events: &events,
        });
        assert!(tel.empty_visible_answer);
        assert!(tel.truncated_by_length);
        assert_eq!(tel.finish_reason.as_deref(), Some("length"));
    }

    #[test]
    fn missing_metadata_stays_unknown_and_cost_not_zeroed() {
        let calls = vec![call_with_transport(
            0,
            ProviderTransportTelemetry::default(),
            "stop",
            false,
        )];
        let events = vec![StreamEvent::TurnCompleted {
            reason: "stop".into(),
        }];
        let tel = aggregate_provider_turn_telemetry(ProviderTelemetryAggregateInput {
            configured_profile_id: "p",
            configured_model: "m",
            calls: &calls,
            events: &events,
        });
        assert!(tel.prompt_tokens.is_none());
        assert!(tel.cost.is_none());
        assert!(tel.provider_request_id.is_none());
        assert_eq!(tel.observed_route, ObservedRoute::Unknown);
    }

    #[test]
    fn two_fully_reported_rounds_sum_exactly() {
        let calls = vec![
            call_with_transport(
                0,
                full_transport(10, 20, 2, 1, 30, 0.10, "m-a", "req-a"),
                "tool_calls",
                false,
            ),
            call_with_transport(
                1,
                full_transport(5, 7, 3, 2, 12, 0.05, "m-b", "req-b"),
                "stop",
                false,
            ),
        ];
        let events = vec![StreamEvent::TurnCompleted {
            reason: "stop".into(),
        }];
        let tel = aggregate_provider_turn_telemetry(ProviderTelemetryAggregateInput {
            configured_profile_id: "openai-compatible",
            configured_model: "configured",
            calls: &calls,
            events: &events,
        });
        assert_eq!(tel.prompt_tokens, Some(15));
        assert_eq!(tel.completion_tokens, Some(27));
        assert_eq!(tel.reasoning_tokens, Some(5));
        assert_eq!(tel.cached_tokens, Some(3));
        assert_eq!(tel.total_tokens, Some(42));
        assert!((tel.cost.unwrap() - 0.15).abs() < 1e-9);
        // Identity is last reported, not a sum/conflation.
        assert_eq!(tel.response_model.as_deref(), Some("m-b"));
        assert_eq!(tel.provider_request_id.as_deref(), Some("req-b"));
        assert_eq!(tel.finish_reason.as_deref(), Some("stop"));
        // Per-round preservation.
        assert_eq!(tel.rounds.len(), 2);
        assert_eq!(tel.rounds[0].transport.prompt_tokens, Some(10));
        assert_eq!(tel.rounds[1].transport.prompt_tokens, Some(5));
        assert_eq!(
            tel.rounds[0].transport.provider_request_id.as_deref(),
            Some("req-a")
        );
        assert!(tel.application_retry_reasons.is_empty());
    }

    #[test]
    fn later_rejected_identity_blocks_fallback_to_older_certified_value() {
        let rejected = ProviderTransportTelemetry {
            response_model: None,
            model_identity_status: ModelIdentityStatus::Rejected,
            ..Default::default()
        };
        let calls = vec![
            call_with_transport(
                0,
                full_transport(1, 1, 0, 0, 2, 0.01, "model-a", "req-a"),
                "tool_calls",
                false,
            ),
            call_with_transport(1, rejected, "stop", false),
        ];
        let telemetry = aggregate_provider_turn_telemetry(ProviderTelemetryAggregateInput {
            configured_profile_id: "p",
            configured_model: "configured",
            calls: &calls,
            events: &[],
        });
        assert_eq!(telemetry.response_model, None);
        assert_eq!(
            telemetry.model_identity_status,
            ModelIdentityStatus::Rejected
        );
    }

    #[test]
    fn later_absence_preserves_the_last_authoritative_identity_outcome() {
        let certified_then_absent = vec![
            call_with_transport(
                0,
                full_transport(1, 1, 0, 0, 2, 0.01, "model-a", "req-a"),
                "tool_calls",
                false,
            ),
            call_with_transport(1, ProviderTransportTelemetry::default(), "stop", false),
        ];
        let certified = aggregate_provider_turn_telemetry(ProviderTelemetryAggregateInput {
            configured_profile_id: "p",
            configured_model: "configured",
            calls: &certified_then_absent,
            events: &[],
        });
        assert_eq!(certified.response_model.as_deref(), Some("model-a"));
        assert_eq!(
            certified.model_identity_status,
            ModelIdentityStatus::Certified
        );

        let rejected_then_absent = vec![
            call_with_transport(
                0,
                ProviderTransportTelemetry {
                    response_model: None,
                    model_identity_status: ModelIdentityStatus::Rejected,
                    ..Default::default()
                },
                "tool_calls",
                false,
            ),
            call_with_transport(1, ProviderTransportTelemetry::default(), "stop", false),
        ];
        let rejected = aggregate_provider_turn_telemetry(ProviderTelemetryAggregateInput {
            configured_profile_id: "p",
            configured_model: "configured",
            calls: &rejected_then_absent,
            events: &[],
        });
        assert_eq!(rejected.response_model, None);
        assert_eq!(
            rejected.model_identity_status,
            ModelIdentityStatus::Rejected
        );
    }

    #[test]
    fn three_fully_reported_rounds_sum_exactly() {
        let calls = vec![
            call_with_transport(
                0,
                full_transport(1, 2, 0, 0, 3, 0.01, "m1", "r1"),
                "tool_calls",
                false,
            ),
            call_with_transport(
                1,
                full_transport(4, 5, 1, 1, 9, 0.02, "m2", "r2"),
                "tool_calls",
                false,
            ),
            call_with_transport(
                2,
                full_transport(6, 7, 2, 3, 13, 0.03, "m3", "r3"),
                "stop",
                false,
            ),
        ];
        let events = vec![StreamEvent::TurnCompleted {
            reason: "stop".into(),
        }];
        let tel = aggregate_provider_turn_telemetry(ProviderTelemetryAggregateInput {
            configured_profile_id: "p",
            configured_model: "m",
            calls: &calls,
            events: &events,
        });
        assert_eq!(tel.provider_round_count, 3);
        assert_eq!(tel.prompt_tokens, Some(11));
        assert_eq!(tel.completion_tokens, Some(14));
        assert_eq!(tel.reasoning_tokens, Some(3));
        assert_eq!(tel.cached_tokens, Some(4));
        assert_eq!(tel.total_tokens, Some(25));
        assert!((tel.cost.unwrap() - 0.06).abs() < 1e-9);
        assert_eq!(tel.rounds.len(), 3);
        assert!(tel.application_retry_reasons.is_empty());
    }

    #[test]
    fn one_missing_metric_makes_only_that_aggregate_unknown() {
        let mut incomplete = full_transport(10, 20, 1, 1, 30, 0.1, "m", "r1");
        incomplete.reasoning_tokens = None;
        let calls = vec![
            call_with_transport(0, incomplete, "tool_calls", false),
            call_with_transport(
                1,
                full_transport(5, 5, 2, 2, 10, 0.05, "m", "r2"),
                "stop",
                false,
            ),
        ];
        let events = vec![StreamEvent::TurnCompleted {
            reason: "stop".into(),
        }];
        let tel = aggregate_provider_turn_telemetry(ProviderTelemetryAggregateInput {
            configured_profile_id: "p",
            configured_model: "m",
            calls: &calls,
            events: &events,
        });
        assert!(tel.reasoning_tokens.is_none());
        assert_eq!(tel.prompt_tokens, Some(15));
        assert_eq!(tel.completion_tokens, Some(25));
        assert_eq!(tel.cached_tokens, Some(3));
        assert_eq!(tel.total_tokens, Some(40));
        assert!((tel.cost.unwrap() - 0.15).abs() < 1e-9);
        // Per-round still preserves the known reasoning on round 1.
        assert!(tel.rounds[0].transport.reasoning_tokens.is_none());
        assert_eq!(tel.rounds[1].transport.reasoning_tokens, Some(2));
    }

    #[test]
    fn cost_aggregation_requires_every_round() {
        let with_cost = full_transport(1, 1, 0, 0, 2, 0.25, "m", "r1");
        let mut without_cost = full_transport(1, 1, 0, 0, 2, 0.0, "m", "r2");
        without_cost.cost = None;
        let calls = vec![
            call_with_transport(0, with_cost.clone(), "tool_calls", false),
            call_with_transport(1, without_cost, "stop", false),
        ];
        let events = vec![StreamEvent::TurnCompleted {
            reason: "stop".into(),
        }];
        let tel = aggregate_provider_turn_telemetry(ProviderTelemetryAggregateInput {
            configured_profile_id: "p",
            configured_model: "m",
            calls: &calls,
            events: &events,
        });
        assert!(tel.cost.is_none());
        assert_eq!(tel.rounds[0].transport.cost, Some(0.25));
        assert!(tel.rounds[1].transport.cost.is_none());

        let both = vec![
            call_with_transport(0, with_cost, "tool_calls", false),
            call_with_transport(
                1,
                full_transport(1, 1, 0, 0, 2, 0.75, "m", "r2"),
                "stop",
                false,
            ),
        ];
        let tel2 = aggregate_provider_turn_telemetry(ProviderTelemetryAggregateInput {
            configured_profile_id: "p",
            configured_model: "m",
            calls: &both,
            events: &events,
        });
        assert!((tel2.cost.unwrap() - 1.0).abs() < 1e-9);
    }

    #[test]
    fn single_round_aggregate_matches_that_round() {
        let transport = full_transport(9, 8, 7, 6, 15, 0.42, "solo", "solo-id");
        let calls = vec![call_with_transport(0, transport.clone(), "stop", false)];
        let events = vec![StreamEvent::TurnCompleted {
            reason: "stop".into(),
        }];
        let tel = aggregate_provider_turn_telemetry(ProviderTelemetryAggregateInput {
            configured_profile_id: "p",
            configured_model: "m",
            calls: &calls,
            events: &events,
        });
        assert_eq!(tel.provider_round_count, 1);
        assert_eq!(tel.prompt_tokens, transport.prompt_tokens);
        assert_eq!(tel.completion_tokens, transport.completion_tokens);
        assert_eq!(tel.reasoning_tokens, transport.reasoning_tokens);
        assert_eq!(tel.cached_tokens, transport.cached_tokens);
        assert_eq!(tel.total_tokens, transport.total_tokens);
        assert_eq!(tel.cost, transport.cost);
        assert_eq!(tel.rounds[0].transport, transport);
    }

    #[test]
    fn per_round_transport_is_preserved_independently() {
        let calls = vec![
            call_with_transport(
                0,
                full_transport(1, 2, 0, 0, 3, 0.01, "first", "id-1"),
                "tool_calls",
                false,
            ),
            call_with_transport(
                1,
                full_transport(4, 5, 1, 1, 9, 0.02, "second", "id-2"),
                "stop",
                false,
            ),
        ];
        let events = vec![StreamEvent::TurnCompleted {
            reason: "stop".into(),
        }];
        let tel = aggregate_provider_turn_telemetry(ProviderTelemetryAggregateInput {
            configured_profile_id: "p",
            configured_model: "m",
            calls: &calls,
            events: &events,
        });
        assert_eq!(
            tel.rounds[0].transport.response_model.as_deref(),
            Some("first")
        );
        assert_eq!(
            tel.rounds[1].transport.response_model.as_deref(),
            Some("second")
        );
        assert_eq!(tel.rounds[0].transport.cost, Some(0.01));
        assert_eq!(tel.rounds[1].transport.cost, Some(0.02));
        // Turn identity stays last-reported, not a merge of both.
        assert_eq!(tel.response_model.as_deref(), Some("second"));
        assert_eq!(tel.provider_request_id.as_deref(), Some("id-2"));
    }

    #[test]
    fn ordinary_tool_continuation_has_no_retry_reason() {
        let calls = vec![
            call_with_transport(
                0,
                full_transport(1, 1, 0, 0, 2, 0.01, "m", "r0"),
                "tool_calls",
                false,
            ),
            call_with_transport(
                1,
                full_transport(2, 2, 0, 0, 4, 0.02, "m", "r1"),
                "stop",
                false,
            ),
            call_with_transport(
                2,
                full_transport(3, 3, 0, 0, 6, 0.03, "m", "r2"),
                "stop",
                false,
            ),
        ];
        // Even if unrelated errors appear, without a decision-point capture on
        // TracedCall we must not invent retry reasons from round index.
        let events = vec![
            StreamEvent::Error {
                code: "some_other_error".into(),
                message: "not a retry decision".into(),
            },
            StreamEvent::TurnCompleted {
                reason: "stop".into(),
            },
        ];
        let tel = aggregate_provider_turn_telemetry(ProviderTelemetryAggregateInput {
            configured_profile_id: "p",
            configured_model: "m",
            calls: &calls,
            events: &events,
        });
        assert_eq!(tel.provider_round_count, 3);
        assert!(tel.application_retry_reasons.is_empty());
        assert!(tel
            .rounds
            .iter()
            .all(|r| r.application_retry_reason.is_none()));
        let dumped = tel.to_json().to_string();
        assert!(!dumped.contains("application_round"));
    }

    #[test]
    fn real_application_retry_carries_actual_reason() {
        let calls = vec![
            call_with_transport(0, ProviderTransportTelemetry::default(), "stop", false),
            call_with_retry(
                1,
                full_transport(1, 1, 0, 0, 2, 0.01, "m", "r1"),
                "stop",
                false,
                Some("tools_unsupported"),
            ),
        ];
        let events = vec![
            StreamEvent::Error {
                code: "tools_unsupported".into(),
                message: "tools off".into(),
            },
            StreamEvent::TurnCompleted {
                reason: "stop".into(),
            },
        ];
        let tel = aggregate_provider_turn_telemetry(ProviderTelemetryAggregateInput {
            configured_profile_id: "p",
            configured_model: "m",
            calls: &calls,
            events: &events,
        });
        assert_eq!(tel.application_retry_reasons.len(), 1);
        assert_eq!(tel.application_retry_reasons[0].round, 1);
        assert_eq!(tel.application_retry_reasons[0].reason, "tools_unsupported");
        assert_eq!(
            tel.rounds[1].application_retry_reason.as_deref(),
            Some("tools_unsupported")
        );
        assert!(tel.rounds[0].application_retry_reason.is_none());
    }

    #[test]
    fn multiple_ordinary_rounds_remain_ordinary() {
        let calls: Vec<_> = (0..4)
            .map(|i| {
                call_with_transport(
                    i,
                    full_transport(1, 1, 0, 0, 2, 0.01, "m", &format!("r{i}")),
                    if i == 3 { "stop" } else { "tool_calls" },
                    false,
                )
            })
            .collect();
        let events = vec![StreamEvent::TurnCompleted {
            reason: "stop".into(),
        }];
        let tel = aggregate_provider_turn_telemetry(ProviderTelemetryAggregateInput {
            configured_profile_id: "p",
            configured_model: "m",
            calls: &calls,
            events: &events,
        });
        assert_eq!(tel.provider_round_count, 4);
        assert!(tel.application_retry_reasons.is_empty());
        assert!(tel
            .rounds
            .iter()
            .all(|r| r.application_retry_reason.is_none()));
    }

    #[test]
    fn cli_and_dto_json_agree_on_same_capture() {
        let transport = ProviderTransportTelemetry {
            cost: Some(0.5),
            provider_request_id: Some("req-1".into()),
            ..Default::default()
        };
        let calls = vec![call_with_transport(0, transport, "stop", false)];
        let events = vec![StreamEvent::TurnCompleted {
            reason: "stop".into(),
        }];
        let a = aggregate_provider_turn_telemetry(ProviderTelemetryAggregateInput {
            configured_profile_id: "openai-compatible",
            configured_model: "gpt-test",
            calls: &calls,
            events: &events,
        });
        let event = aggregate_provider_telemetry_event(ProviderTelemetryAggregateInput {
            configured_profile_id: "openai-compatible",
            configured_model: "gpt-test",
            calls: &calls,
            events: &events,
        });
        let StreamEvent::ProviderTelemetry { telemetry: b } = event else {
            panic!("expected provider telemetry event");
        };
        assert_eq!(a.to_json(), b.to_json());
        let dumped = a.to_json().to_string();
        assert!(!dumped.contains("Authorization"));
        assert!(!dumped.contains("sk-"));
    }

    #[test]
    fn reasoning_channel_aggregate_is_present_when_any_round_reports_it() {
        let mut first = ProviderTransportTelemetry {
            reasoning_content_chars: Some(7),
            ..Default::default()
        };
        let second = ProviderTransportTelemetry::default();
        first.response_model = Some("deepseek/deepseek-v4-flash".into());
        first.model_identity_status = ModelIdentityStatus::Certified;
        let calls = vec![
            call_with_transport(0, first, "tool_calls", false),
            call_with_transport(1, second, "stop", false),
        ];
        let events = vec![StreamEvent::TurnCompleted {
            reason: "stop".into(),
        }];
        let telemetry = aggregate_provider_turn_telemetry(ProviderTelemetryAggregateInput {
            configured_profile_id: "p",
            configured_model: "deepseek/deepseek-v4-flash",
            calls: &calls,
            events: &events,
        });
        assert_eq!(telemetry.reasoning_content_chars, Some(7));
        assert_eq!(
            telemetry.rounds[0].transport.reasoning_content_chars,
            Some(7)
        );
        assert_eq!(telemetry.rounds[1].transport.reasoning_content_chars, None);
    }

    #[test]
    fn cli_and_tauri_agree_on_retry_and_continuation_semantics() {
        let calls = vec![
            call_with_transport(
                0,
                full_transport(1, 1, 0, 0, 2, 0.01, "m", "r0"),
                "tool_calls",
                false,
            ),
            call_with_retry(
                1,
                full_transport(2, 2, 0, 0, 4, 0.02, "m", "r1"),
                "stop",
                false,
                Some("context_compacted"),
            ),
        ];
        let events = vec![StreamEvent::TurnCompleted {
            reason: "stop".into(),
        }];
        let cli = aggregate_provider_turn_telemetry(ProviderTelemetryAggregateInput {
            configured_profile_id: "openai-compatible",
            configured_model: "gpt-test",
            calls: &calls,
            events: &events,
        });
        let StreamEvent::ProviderTelemetry { telemetry: tauri } =
            aggregate_provider_telemetry_event(ProviderTelemetryAggregateInput {
                configured_profile_id: "openai-compatible",
                configured_model: "gpt-test",
                calls: &calls,
                events: &events,
            })
        else {
            panic!("expected provider telemetry");
        };
        assert_eq!(cli.to_json(), tauri.to_json());
        assert_eq!(cli.application_retry_reasons.len(), 1);
        assert_eq!(cli.application_retry_reasons[0].reason, "context_compacted");
        assert!(cli.rounds[0].application_retry_reason.is_none());
    }

    #[test]
    fn configured_identity_is_scrubbed_and_bounded() {
        let calls = vec![call_with_transport(
            0,
            ProviderTransportTelemetry::default(),
            "stop",
            false,
        )];
        let events = vec![StreamEvent::TurnCompleted {
            reason: "stop".into(),
        }];
        let tel = aggregate_provider_turn_telemetry(ProviderTelemetryAggregateInput {
            configured_profile_id: "profile-with-Bearer tokentokentoken12345",
            configured_model: "override-sk-abcdefghijklmnop-extra",
            calls: &calls,
            events: &events,
        });
        let dumped = tel.to_json().to_string();
        assert!(!dumped.contains("tokentokentoken12345"));
        assert!(!dumped.contains("sk-abcdefghijklmnop"));
        assert!(!tel.configured_model.contains("sk-abcdefghijklmnop"));
        assert!(!tel.configured_profile_id.contains("tokentokentoken12345"));

        let long_model = format!("model-{}", "x".repeat(500));
        let tel2 = aggregate_provider_turn_telemetry(ProviderTelemetryAggregateInput {
            configured_profile_id: "p",
            configured_model: &long_model,
            calls: &calls,
            events: &events,
        });
        assert!(
            tel2.configured_model.chars().count()
                <= cd_core::provider_telemetry::MAX_TELEMETRY_STRING_CHARS
        );
        // Legitimate ids unchanged.
        let tel3 = aggregate_provider_turn_telemetry(ProviderTelemetryAggregateInput {
            configured_profile_id: "openai-compatible",
            configured_model: "anthropic/claude-sonnet-4",
            calls: &calls,
            events: &events,
        });
        assert_eq!(tel3.configured_profile_id, "openai-compatible");
        assert_eq!(tel3.configured_model, "anthropic/claude-sonnet-4");
    }
}
