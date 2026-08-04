//! Project shared `cd_core::activity` records for CLI modes.
//!
//! The CLI never reimplements the agent loop: it consumes the same
//! [`RecordingTurnTrace`] timeline + stream events Tauri's Activity Inspector
//! uses, then renders a pure projection.

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
    } else {
        // Fallback: stream-only projection when no sink was attached (should
        // not happen when --activity is requested — chat always attaches one).
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
    use cd_core::turn_trace::{
        RecordingTurnTrace, TracedCall, TracedMessage, TracedOutcome, TurnTraceSink,
    };
    use std::sync::Arc;

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
        assert!(!lines.is_empty());
        // Summary must not retain bodies
        for event in &record.events {
            if let Some(ctx) = &event.context {
                assert!(ctx.bodies.is_none(), "summary must strip bodies");
            }
        }
        let labels = causal_phase_labels(&record);
        assert!(!labels.is_empty());
        let human = render_human_summary(&record);
        assert!(human.contains("activity:"));
        assert!(!human.contains("sk-")); // no credential-looking noise
    }
}
