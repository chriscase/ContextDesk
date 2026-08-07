//! Host-neutral aggregation of provider-turn telemetry.
//!
//! Transport capture lives in `cd_core::provider_telemetry` and is attached to
//! each [`TracedCall`] by the OpenAI-compatible client + `TracingChatBackend`.
//! This module is the **only** place that folds those captures together with
//! configured profile/model, application retry reasons, context-budget
//! snapshots, and final turn outcome into the shared
//! [`ProviderTurnTelemetry`] DTO. CLI and Tauri must project that DTO; they
//! must not invent token counts, costs, or observed routes.

use cd_core::context_budgeting::ContextBudgetTelemetry;
use cd_core::events::StreamEvent;
use cd_core::provider_telemetry::{
    finish_reason_is_length, ApplicationRetryReason, ProviderRoundTelemetry,
    ProviderTransportTelemetry, ProviderTurnTelemetry,
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

/// Stable application retry reason codes derived only from host stream signals.
fn application_retry_reason_from_error_code(code: &str) -> Option<&'static str> {
    match code {
        "tools_unsupported" => Some("tools_unsupported"),
        "context_compacted" => Some("context_compacted"),
        "context_too_long" => Some("context_too_long"),
        _ => None,
    }
}

/// Map stream error codes that precede a later provider round onto that round.
fn application_retries_for_calls(
    calls: &[TracedCall],
    events: &[StreamEvent],
) -> Vec<ApplicationRetryReason> {
    if calls.len() < 2 {
        return Vec::new();
    }
    let mut reasons: Vec<String> = Vec::new();
    for event in events {
        if let StreamEvent::Error { code, .. } = event {
            if let Some(reason) = application_retry_reason_from_error_code(code) {
                reasons.push(reason.to_string());
            }
        }
    }
    // Assign reasons in order to rounds 1..N (round 0 has no prior retry).
    let mut out = Vec::new();
    for (idx, call) in calls.iter().enumerate().skip(1) {
        let reason = reasons.get(idx - 1).cloned().unwrap_or_else(|| {
            // A subsequent application round without a classified error is still
            // an application retry (tool loop / synthesis), not a gateway-internal
            // count — label it honestly as host-driven continuation.
            "application_round".to_string()
        });
        out.push(ApplicationRetryReason {
            round: u32::try_from(call.seq).unwrap_or(u32::MAX),
            reason,
        });
    }
    out
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

fn round_from_call(call: &TracedCall, retry_reason: Option<String>) -> ProviderRoundTelemetry {
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
        application_retry_reason: retry_reason,
    }
}

fn fold_transport(rounds: &[ProviderRoundTelemetry]) -> ProviderTransportTelemetry {
    let mut folded = ProviderTransportTelemetry::default();
    for round in rounds {
        folded.merge_from(&round.transport);
    }
    folded
}

/// Aggregate host-neutral provider-turn telemetry.
///
/// This is the authoritative fold-in shared by CLI and Tauri. It never copies
/// [`ProviderTelemetryAggregateInput::configured_model`] into
/// [`ProviderTurnTelemetry::observed_route`] or [`ProviderTurnTelemetry::response_model`].
pub fn aggregate_provider_turn_telemetry(
    input: ProviderTelemetryAggregateInput<'_>,
) -> ProviderTurnTelemetry {
    let retries = application_retries_for_calls(input.calls, input.events);
    let retry_by_round: std::collections::HashMap<u32, String> = retries
        .iter()
        .map(|r| (r.round, r.reason.clone()))
        .collect();

    let rounds: Vec<ProviderRoundTelemetry> = input
        .calls
        .iter()
        .map(|call| {
            let round = u32::try_from(call.seq).unwrap_or(u32::MAX);
            round_from_call(call, retry_by_round.get(&round).cloned())
        })
        .collect();

    let folded = fold_transport(&rounds);
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

    ProviderTurnTelemetry {
        configured_profile_id: input.configured_profile_id.to_string(),
        configured_model: input.configured_model.to_string(),
        response_model: folded.response_model.clone(),
        provider_request_id: folded.provider_request_id.clone(),
        observed_route: folded.observed_route.clone(),
        prompt_tokens: folded.prompt_tokens,
        completion_tokens: folded.completion_tokens,
        reasoning_tokens: folded.reasoning_tokens,
        cached_tokens: folded.cached_tokens,
        total_tokens: folded.total_tokens,
        cost: folded.cost,
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

/// Ensure observed route stays unknown when only a configured model exists.
#[cfg(test)]
mod tests {
    use super::*;
    use cd_core::provider_telemetry::ObservedRoute;
    use cd_core::turn_trace::{TracedCall, TracedMessage, TracedOutcome};

    fn call_with_transport(
        seq: usize,
        transport: ProviderTransportTelemetry,
        finish: &str,
        content_empty: bool,
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
        }
    }

    #[test]
    fn configured_model_never_becomes_observed_route() {
        let transport = ProviderTransportTelemetry {
            response_model: Some("anthropic/claude-sonnet-4".into()),
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
        let transport = ProviderTransportTelemetry {
            response_model: Some("anthropic/claude-sonnet-4".into()),
            provider_request_id: Some("chatcmpl-1".into()),
            observed_route: ObservedRoute::Reported {
                value: "anthropic".into(),
            },
            prompt_tokens: Some(10),
            completion_tokens: Some(20),
            reasoning_tokens: Some(8),
            cached_tokens: Some(4),
            total_tokens: Some(30),
            cost: Some(0.00123),
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
    fn application_retry_reasons_from_host_errors_only() {
        let calls = vec![
            call_with_transport(0, ProviderTransportTelemetry::default(), "stop", false),
            call_with_transport(1, ProviderTransportTelemetry::default(), "stop", false),
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
        assert_eq!(tel.provider_round_count, 2);
        assert_eq!(tel.application_retry_reasons.len(), 1);
        assert_eq!(tel.application_retry_reasons[0].round, 1);
        assert_eq!(tel.application_retry_reasons[0].reason, "tools_unsupported");
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
}
