//! Streaming event types for the `cd.v1` protocol.

use serde::{Deserialize, Serialize};

use crate::router::AgentPhase;

/// Phase of a tool invocation in the UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolPhase {
    /// Tool call started.
    Started,
    /// Tool call finished (success or error).
    Finished,
}

/// Events emitted by the agent runtime toward hosts.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum StreamEvent {
    /// A turn began.
    TurnStarted {
        /// Session identifier.
        session_id: String,
        /// Model id if known.
        model: Option<String>,
    },
    /// Truthful current lifecycle phase for a bounded agent turn.
    TurnPhase {
        /// Host-authored phase; never inferred from model prose.
        phase: AgentPhase,
    },
    /// Host-confirmed availability of one exact synthesis-only retry.
    ///
    /// Evidence never crosses IPC; these identifiers let the renderer reject
    /// stale events after a chat, corpus, or model switch.
    LinkedSynthesisRetry {
        /// Whether a valid host-only checkpoint currently exists.
        available: bool,
        /// Exact owning session.
        session_id: String,
        /// Exact owning corpus.
        corpus_id: String,
        /// Exact owning provider profile, when known.
        provider_profile_id: Option<String>,
        /// Exact owning model id, when known.
        model_id: Option<String>,
    },
    /// Incremental assistant markdown.
    TextDelta {
        /// UTF-8 chunk (may be partial markdown).
        text: String,
    },
    /// Optional model "thought" channel.
    ThoughtDelta {
        /// Thought chunk.
        text: String,
    },
    /// Tool lifecycle (compact by default in UI).
    Tool {
        /// Correlation id for expand/collapse.
        id: String,
        /// Tool name.
        name: String,
        /// Started or finished.
        phase: ToolPhase,
        /// One-line summary for collapsed UI.
        summary: String,
        /// Optional longer detail (UI may lazy-show).
        detail: Option<String>,
        /// True when finished successfully.
        ok: Option<bool>,
    },
    /// Citation / provenance chip.
    Citation {
        /// Stable source id.
        source_id: String,
        /// Display label (path, page title, etc.).
        label: String,
        /// Optional locator (lines, URL fragment).
        locator: Option<String>,
        /// Host-verified log corpus for governed `log_event:` / `log_template:`
        /// identities. Never model-authored; omitted for non-log citations.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        corpus_id: Option<String>,
    },
    /// Where the router looked.
    SearchTrail {
        /// Human-readable steps.
        steps: Vec<String>,
    },
    /// Typed model-context budget / packing telemetry for one provider request.
    ///
    /// Emitted alongside a legacy `SearchTrail` `context_budget:…` string for
    /// compatibility. Public consumers should read this event (or its JSON
    /// projection) rather than parsing the trail string.
    ContextBudget {
        /// Full typed snapshot (camelCase on the wire).
        telemetry: crate::context_budgeting::ContextBudgetTelemetry,
    },
    /// Authoritative provider-turn telemetry (transport + application fold-in).
    ///
    /// Emitted once per turn by `cd-workflow` aggregation so CLI and Tauri
    /// project the same DTO. Hosts must not invent token/cost/route values.
    /// Boxed to keep [`StreamEvent`] niche-friendly for clippy's large-variant
    /// lint while still carrying the full turn snapshot.
    ProviderTelemetry {
        /// Full typed turn snapshot (camelCase on the wire).
        telemetry: Box<crate::provider_telemetry::ProviderTurnTelemetry>,
    },
    /// Host must obtain a user decision before a write.
    PermissionRequired {
        /// Request id for `permission.respond`.
        request_id: String,
        /// Tool name.
        tool_name: String,
        /// Target description (path, page, …).
        target: String,
        /// Why the model wants this.
        reason: String,
        /// Human preview of content or draft (may be non-JSON).
        preview: String,
        /// Risk hint: local | remote | destructive.
        risk: String,
        /// Original tool arguments for Accept re-execute (host also stores these).
        #[serde(default)]
        arguments: serde_json::Value,
    },
    /// Turn ended.
    TurnCompleted {
        /// Finish reason (stop, cancel, error, …).
        reason: String,
    },
    /// Safe error for UI.
    Error {
        /// Stable code.
        code: String,
        /// User-visible message (no secrets).
        message: String,
    },
}

/// Terminal [`StreamEvent::TurnCompleted`] reasons that mean the turn did
/// NOT deliver a usable, grounded answer — the host withheld it.
///
/// Kept next to the event type so every consumer classifies one shared list
/// instead of string-matching its own subset. Reporting any of these as
/// success is how an empty or ungrounded answer reaches a caller as "ok".
///
/// Deliberately excludes `budget_rounds_answer`: that reason means the round
/// budget ran out but a final answer *was* produced. Its sibling
/// `budget_rounds` means the final answer failed, and is withheld.
/// `awaiting_permission` is also excluded — that turn is paused pending a
/// human decision, which is pending, not withheld.
pub const WITHHELD_TURN_REASONS: &[&str] = &[
    // The answer did not truthfully reference the bounded evidence.
    "linked_invalid_grounded_answer",
    // The corpus changed under the turn; its evidence no longer holds.
    "linked_log_snapshot_stale",
    // Synthesis-only retry evidence no longer matches the live corpus.
    "linked_synthesis_retry_stale",
    // Synthesis exceeded its time budget before producing an answer.
    "linked_synthesis_timeout",
    // The turn could not be fitted into the model context budget.
    "context_too_long",
    // The turn ran out of its time budget before answering.
    "budget_time",
    // The round budget ran out AND the final answer failed.
    "budget_rounds",
    // The provider failed before required linked-log retrieval completed.
    "linked_retrieval_provider_error",
    // The provider failed after retrieval but before grounded synthesis completed.
    "linked_synthesis_provider_error",
];

/// Stable [`StreamEvent::Error`] codes that mean the answer this turn
/// produced is not log-grounded, even though the turn itself completed with
/// an ordinary reason such as `"stop"`.
///
/// This list exists because the two conditions below are signalled by an
/// `Error` event while `TurnCompleted.reason` stays `"stop"` — a consumer
/// that only inspected the reason would report a knowingly ungrounded
/// answer as a clean success.
pub const WITHHELD_TURN_ERROR_CODES: &[&str] = &[
    // Linked investigation finished with no successful bounded log-tool result.
    "linked_no_tool",
    // An explicitly requested bounded source never succeeded.
    "linked_required_source_missing",
];

/// Whether a `TurnCompleted.reason` means the answer was withheld.
pub fn is_withheld_turn_reason(reason: &str) -> bool {
    WITHHELD_TURN_REASONS.contains(&reason)
}

/// Whether an `Error.code` means the delivered answer was not grounded.
pub fn is_withheld_turn_error_code(code: &str) -> bool {
    WITHHELD_TURN_ERROR_CODES.contains(&code)
}

/// The withheld reason this event stream terminated with, if any.
///
/// Checks both signals: the terminal reason, and the ungrounded-answer error
/// codes that accompany an otherwise ordinary completion. Returns `None` for
/// a genuine success.
pub fn withheld_turn_reason(events: &[StreamEvent]) -> Option<&str> {
    let terminal = events.iter().rev().find_map(|event| match event {
        StreamEvent::TurnCompleted { reason } if is_withheld_turn_reason(reason) => {
            Some(reason.as_str())
        }
        _ => None,
    });
    if terminal.is_some() {
        return terminal;
    }
    events.iter().rev().find_map(|event| match event {
        StreamEvent::Error { code, .. } if is_withheld_turn_error_code(code) => Some(code.as_str()),
        _ => None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stream_event_roundtrip_json() {
        let ev = StreamEvent::TextDelta {
            text: "hello".into(),
        };
        let s = serde_json::to_string(&ev).unwrap();
        let back: StreamEvent = serde_json::from_str(&s).unwrap();
        match back {
            StreamEvent::TextDelta { text } => assert_eq!(text, "hello"),
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn turn_phase_uses_stable_snake_case_protocol_values() {
        let value = serde_json::to_value(StreamEvent::TurnPhase {
            phase: AgentPhase::SynthesizingAnswer,
        })
        .unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "type": "turn_phase",
                "phase": "synthesizing_answer"
            })
        );
    }
}
