//! Project shared `cd_core::activity` records for CLI modes.
//!
//! The CLI never reimplements the agent loop: it consumes the same
//! [`RecordingTurnTrace`] timeline Tauri's Activity Inspector uses, then
//! renders a pure projection. Host stream events are fed into that sink
//! **live** (`commands::chat` → `record_host_event`); this module must not
//! re-ingest the stream a second time.

use crate::cli::ActivityLevel;
use crate::envelope::ActivityLine;
use cd_core::activity::{
    status_for_turn_events, ActivityDetailLevel, ActivityRecorder, DataScope, TurnActivityRecord,
    ACTIVITY_CONTRACT_VERSION,
};
use cd_core::events::StreamEvent;
use cd_core::turn_trace::RecordingTurnTrace;

/// Map CLI flag → shared detail level. Full bodies require explicit opt-in.
pub fn detail_level(level: ActivityLevel) -> ActivityDetailLevel {
    match level {
        ActivityLevel::Summary => ActivityDetailLevel::Summary,
        ActivityLevel::Full => ActivityDetailLevel::Full,
    }
}

/// Build one turn activity record from the shared capture path.
///
/// Matches Tauri: `record_timeline(sink.timeline())` then `finish`. Lifecycle
/// markers (TurnStarted / Phase / Error / Tool Started+Finished) must already
/// be on the sink timeline via live `record_host_event` — this function does
/// not re-project the stream.
pub fn project_turn_activity(
    session_id: &str,
    turn_id: &str,
    corpus_id: Option<&str>,
    level: ActivityLevel,
    sink: Option<&RecordingTurnTrace>,
    events: &[StreamEvent],
    total_elapsed_ms: u64,
) -> TurnActivityRecord {
    let scope = match corpus_id {
        Some(id) => DataScope::log_corpus(id),
        None => DataScope::conversation(),
    };
    let mut recorder = ActivityRecorder::new(turn_id, session_id, scope, detail_level(level));
    if let Some(sink) = sink {
        recorder.record_timeline(&sink.timeline());
    } else if !events.is_empty() {
        // No sink (should not happen when --activity is requested): project
        // stream lifecycle only — never a second agent loop.
        recorder.record_stream_events(events);
    }
    let status = status_for_turn_events(events);
    recorder.finish(status, total_elapsed_ms)
}

/// Convert a finished record into stable CLI activity lines (one per event).
pub fn activity_lines(record: &TurnActivityRecord) -> Vec<ActivityLine> {
    record
        .events
        .iter()
        .map(|event| ActivityLine {
            activity_version: record.version.max(ACTIVITY_CONTRACT_VERSION),
            session_id: record.session_id.clone(),
            turn_id: record.turn_id.clone(),
            operation_id: event.operation_id.clone(),
            seq: event.seq,
            phase: wire_enum(&event.phase),
            status: wire_enum(&event.status),
            origin: wire_enum(&event.origin),
            determinism: wire_enum(&event.determinism),
            label: event.label.clone(),
            detail: event.detail.clone(),
            elapsed_ms: event.elapsed_ms,
            turn_truncated: record.is_truncated(),
            omitted_events: record.dropped_events,
        })
        .collect()
}

fn wire_enum<T: serde::Serialize>(value: &T) -> String {
    match serde_json::to_value(value) {
        Ok(serde_json::Value::String(s)) => s,
        other => format!("{other:?}"),
    }
}

/// Human-readable multi-line summary (no ANSI). Suitable for stderr or text
/// mode after the answer. Bodies never appear at Summary.
pub fn render_human_summary(record: &TurnActivityRecord) -> String {
    let mut out = String::new();
    out.push_str(&format!(
        "activity: turn={} status={:?} events={} omitted={} elapsed_ms={}\n",
        record.turn_id,
        record.status,
        record.events.len(),
        record.dropped_events,
        record.total_elapsed_ms
    ));
    for event in &record.events {
        out.push_str(&format!(
            "  [{seq}] {origin:?}/{determinism:?} {phase:?} {status:?} — {label}",
            seq = event.seq,
            origin = event.origin,
            determinism = event.determinism,
            phase = event.phase,
            status = event.status,
            label = event.label,
        ));
        if let Some(detail) = &event.detail {
            out.push_str(&format!(" ({detail})"));
        }
        out.push('\n');
    }
    if record.is_truncated() {
        out.push_str(&format!(
            "  … truncated: {} event(s) omitted by hard bound\n",
            record.dropped_events
        ));
    }
    out
}

/// Structural guard used by tests: a finished record must contain the causal
/// phases a real turn produces (or a truthful prefix when truncated).
#[allow(dead_code)]
pub fn causal_phase_labels(record: &TurnActivityRecord) -> Vec<String> {
    record.events.iter().map(|e| e.label.clone()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use cd_core::activity::{ActivityPhase, ActivityStatus, ToolActivityKind};
    use cd_core::events::{StreamEvent, ToolPhase};
    use cd_core::turn_trace::{
        RecordingTurnTrace, TracedCall, TracedMessage, TracedOutcome, TurnTraceSink,
    };
    use std::collections::HashMap;
    use std::sync::Arc;

    fn empty_kinds() -> HashMap<String, ToolActivityKind> {
        HashMap::new()
    }

    /// Pure projection oracle: feed the **same** path production uses —
    /// live `record_host_event` + provider `record` on the shared sink —
    /// then project with timeline-only (Tauri contract).
    #[test]
    fn pure_oracle_tool_finished_survives_and_causal_order_holds() {
        let sink = Arc::new(RecordingTurnTrace::new());
        let kinds = empty_kinds();

        // Causal live capture order (what chat.rs does as events arrive):
        sink.record_host_event(
            &StreamEvent::TurnStarted {
                session_id: "s".into(),
                model: Some("m".into()),
            },
            &kinds,
        );
        sink.record_host_event(
            &StreamEvent::TurnPhase {
                phase: cd_core::router::AgentPhase::ChoosingEvidence,
            },
            &kinds,
        );

        let call = TracedCall {
            seq: 0,
            elapsed_ms: 5,
            tool_names: vec!["search_kb".into()],
            messages: vec![TracedMessage {
                role: "user".into(),
                content: "q".into(),
                char_count: 1,
                truncated: false,
            }],
            context_used_chars: 1,
            messages_capped: false,
            outcome: TracedOutcome::Completed {
                finish_reason: "tool_calls".into(),
                tool_call_count: 1,
            },
        };
        TurnTraceSink::record(sink.as_ref(), call);

        sink.record_host_event(
            &StreamEvent::Tool {
                id: "call_1".into(),
                name: "search_kb".into(),
                phase: ToolPhase::Started,
                summary: "start".into(),
                detail: None,
                ok: None,
            },
            &kinds,
        );
        sink.record_host_event(
            &StreamEvent::Tool {
                id: "call_1".into(),
                name: "search_kb".into(),
                phase: ToolPhase::Finished,
                summary: "ok".into(),
                detail: None,
                ok: Some(true),
            },
            &kinds,
        );
        sink.record_host_event(
            &StreamEvent::Error {
                code: "linked_no_tool".into(),
                message: "no successful log tool".into(),
            },
            &kinds,
        );
        sink.record_host_event(
            &StreamEvent::TurnCompleted {
                reason: "stop".into(),
            },
            &kinds,
        );

        // Stream slice only for status_for_turn_events (same events).
        let events = vec![
            StreamEvent::TurnStarted {
                session_id: "s".into(),
                model: Some("m".into()),
            },
            StreamEvent::TurnPhase {
                phase: cd_core::router::AgentPhase::ChoosingEvidence,
            },
            StreamEvent::Tool {
                id: "call_1".into(),
                name: "search_kb".into(),
                phase: ToolPhase::Started,
                summary: "start".into(),
                detail: None,
                ok: None,
            },
            StreamEvent::Tool {
                id: "call_1".into(),
                name: "search_kb".into(),
                phase: ToolPhase::Finished,
                summary: "ok".into(),
                detail: None,
                ok: Some(true),
            },
            StreamEvent::Error {
                code: "linked_no_tool".into(),
                message: "no successful log tool".into(),
            },
            StreamEvent::TurnCompleted {
                reason: "stop".into(),
            },
        ];

        let record = project_turn_activity(
            "s",
            "s::t",
            None,
            ActivityLevel::Summary,
            Some(sink.as_ref()),
            &events,
            20,
        );

        // Monotonic seq
        for w in record.events.windows(2) {
            assert!(
                w[0].seq < w[1].seq,
                "seq must be strictly monotonic: {:?}",
                record.events
            );
        }

        let labels: Vec<_> = record.events.iter().map(|e| e.label.as_str()).collect();
        // Turn started before provider round
        let start_idx = labels
            .iter()
            .position(|l| *l == "Turn started")
            .expect("Turn started on timeline");
        let model_idx = labels
            .iter()
            .position(|l| l.contains("Model request"))
            .expect("Model request on timeline");
        assert!(
            start_idx < model_idx,
            "Turn started must precede provider round: {labels:?}"
        );

        // Tool Finished must survive (not only Started/pending)
        let finished = record.events.iter().find(|e| {
            e.operation_id == "tool-call_1"
                && e.phase == ActivityPhase::Completed
                && e.status == ActivityStatus::Ok
        });
        assert!(
            finished.is_some(),
            "Tool Finished (completed/ok) must survive projection; events={:?}",
            record
                .events
                .iter()
                .map(|e| (&e.operation_id, e.phase, e.status, &e.label))
                .collect::<Vec<_>>()
        );

        // Error present when stream had it
        assert!(
            labels.iter().any(|l| l.contains("Error: linked_no_tool")),
            "Error lifecycle missing: {labels:?}"
        );

        // Started + Finished both retained for same tool id (two rows, same operation_id)
        let tool_rows: Vec<_> = record
            .events
            .iter()
            .filter(|e| e.operation_id == "tool-call_1")
            .collect();
        assert!(
            tool_rows.len() >= 2,
            "expected Tool Started and Finished rows, got {tool_rows:?}"
        );
    }

    #[test]
    fn projects_provider_rounds_from_shared_trace_sink() {
        let sink = Arc::new(RecordingTurnTrace::new());
        let call = TracedCall {
            seq: 0,
            elapsed_ms: 12,
            messages: vec![TracedMessage {
                role: "user".into(),
                content: "hello".into(),
                char_count: 5,
                truncated: false,
            }],
            tool_names: vec![],
            context_used_chars: 5,
            messages_capped: false,
            outcome: TracedOutcome::Completed {
                finish_reason: "stop".into(),
                tool_call_count: 0,
            },
        };
        TurnTraceSink::record(sink.as_ref(), call);

        let events = vec![
            StreamEvent::TurnStarted {
                session_id: "s1".into(),
                model: Some("m".into()),
            },
            StreamEvent::TurnCompleted {
                reason: "stop".into(),
            },
        ];
        // Live capture of lifecycle onto sink (production path)
        let kinds = empty_kinds();
        for e in &events {
            sink.record_host_event(e, &kinds);
        }

        let record = project_turn_activity(
            "s1",
            "s1::t1",
            None,
            ActivityLevel::Summary,
            Some(sink.as_ref()),
            &events,
            40,
        );
        assert_eq!(record.version, ACTIVITY_CONTRACT_VERSION);
        assert!(
            record.provider_round_count() >= 1,
            "expected a provider-round event from shared timeline: {record:?}"
        );
        let lines = activity_lines(&record);
        assert!(!lines.is_empty());
        assert_eq!(lines[0].session_id, "s1");
        for event in &record.events {
            if let Some(ctx) = &event.context {
                assert!(ctx.bodies.is_none(), "summary must strip bodies");
            }
        }
        let human = render_human_summary(&record);
        assert!(human.contains("activity:"));
        assert!(!human.contains("sk-"));
    }

    /// Compaction signal on the shipped projection path: agent emits
    /// `StreamEvent::Error { code: "context_compacted" }` after
    /// `fit_model_context_to_budget` / reactive compact; CLI activity must
    /// surface it (same live `record_host_event` → timeline-only project).
    #[test]
    fn projects_context_compacted_signal_from_shared_timeline() {
        let sink = Arc::new(RecordingTurnTrace::new());
        let kinds = empty_kinds();
        let events = vec![
            StreamEvent::TurnStarted {
                session_id: "s".into(),
                model: Some("m".into()),
            },
            StreamEvent::Error {
                code: "context_compacted".into(),
                message: "Conversation grew large — older turns were compacted for the model."
                    .into(),
            },
            StreamEvent::TurnCompleted {
                reason: "stop".into(),
            },
        ];
        for e in &events {
            sink.record_host_event(e, &kinds);
        }
        let record = project_turn_activity(
            "s",
            "s::t",
            None,
            ActivityLevel::Summary,
            Some(sink.as_ref()),
            &events,
            30,
        );
        let labels: Vec<_> = record.events.iter().map(|e| e.label.as_str()).collect();
        assert!(
            labels
                .iter()
                .any(|l| l.contains("Error: context_compacted")),
            "compaction signal must appear on activity timeline: {labels:?}"
        );
        let compact = record
            .events
            .iter()
            .find(|e| e.operation_id == "error-context_compacted")
            .expect("operation_id error-context_compacted");
        assert_eq!(compact.phase, ActivityPhase::Completed);
        assert_eq!(compact.status, ActivityStatus::Failed);
    }

    /// Cancelled host status must project terminal — never leave CLI surfaces
    /// looking live/pending after `TurnCompleted { reason: cancel }`.
    #[test]
    fn projects_cancelled_status_is_terminal() {
        let sink = Arc::new(RecordingTurnTrace::new());
        let kinds = empty_kinds();
        let events = vec![
            StreamEvent::TurnStarted {
                session_id: "s".into(),
                model: Some("m".into()),
            },
            StreamEvent::TurnCompleted {
                reason: "cancel".into(),
            },
        ];
        for e in &events {
            sink.record_host_event(e, &kinds);
        }
        let record = project_turn_activity(
            "s",
            "s::t",
            None,
            ActivityLevel::Summary,
            Some(sink.as_ref()),
            &events,
            12,
        );
        assert_eq!(record.status, ActivityStatus::Cancelled);
        assert!(
            record
                .events
                .iter()
                .any(|e| e.label.contains("Turn completed (cancel)")
                    || e.operation_id == "turn-completed"),
            "expected cancel terminal lifecycle on timeline: {:?}",
            record.events.iter().map(|e| &e.label).collect::<Vec<_>>()
        );
        // No pending-only record after cancel.
        assert_ne!(record.status, ActivityStatus::Pending);
    }
}
