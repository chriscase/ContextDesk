//! Static tool specs for log analysis (#360–#363).

use crate::tools::{ToolSideEffect, ToolSpec};
use serde_json::json;

/// SoftWrite ingest tool name.
pub const INGEST_LOGS: &str = "ingest_logs";
/// Read hybrid search tool name.
pub const SEARCH_LOGS: &str = "search_logs";
/// Read clusters tool name.
pub const CLUSTER_PROBLEMS: &str = "cluster_problems";
/// Read timeline tool name.
pub const TIMELINE: &str = "timeline";
/// Read correlate tool name (#363).
pub const CORRELATE: &str = "correlate_logs";
/// Read anomalies tool name (#363).
pub const ANOMALIES: &str = "anomalies_logs";
/// Read trace tool name (#363).
pub const TRACE: &str = "trace_logs";

/// Largest reported-time window accepted by `search_logs`.
///
/// Seven days matches the largest deterministic checked-in Log Lab time-span
/// fixture while keeping model-originated incident searches bounded.
pub const MAX_SEARCH_LOG_TIME_WINDOW_SECS: i64 = 7 * 24 * 60 * 60;

/// All Phase-1 + Phase-2 log tool names.
pub const LOG_TOOL_NAMES: &[&str] = &[
    INGEST_LOGS,
    SEARCH_LOGS,
    CLUSTER_PROBLEMS,
    TIMELINE,
    CORRELATE,
    ANOMALIES,
    TRACE,
    crate::investigations::PROPOSE_FINDING_TOOL,
    crate::investigations::PROPOSE_REPORT_SECTION_TOOL,
];

/// True when `name` is a log analysis tool.
pub fn is_log_tool(name: &str) -> bool {
    LOG_TOOL_NAMES.contains(&name)
}

/// SoftWrite: ingest a path/dir into a named corpus.
pub fn ingest_logs_tool_spec() -> ToolSpec {
    ToolSpec {
        name: INGEST_LOGS.into(),
        description: "Ingest a local log file or directory into a disposable analysis corpus (parse, template, and local template embedding when available/below the bulk threshold). SoftWrite — user must Accept. Returns corpus id + truthful template/embedding summary.".into(),
        side_effect: ToolSideEffect::SoftWrite,
        parameters: json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "File or directory path" },
                "name": { "type": "string", "description": "Corpus display name" }
            },
            "required": ["path"]
        }),
    }
}

/// Corpus param: optional when host has an active/default log corpus (wizard handoff).
fn corpus_param() -> serde_json::Value {
    json!({
        "type": "string",
        "description": "Log corpus id. Optional when the host has an active corpus (set by the log wizard or last ingest)."
    })
}

/// Read: hybrid search_logs.
pub fn search_logs_tool_spec() -> ToolSpec {
    ToolSpec {
        name: SEARCH_LOGS.into(),
        description: format!(
            "Search an ingested log corpus (structured + keyword; template-semantic only when \
             that corpus has vectors). When a problem was reported at a known time, use \
             time_from and time_to together for a deterministic bounded search around it; \
             time_from is inclusive, time_to is exclusive, and the window may be at most \
             {MAX_SEARCH_LOG_TIME_WINDOW_SECS} seconds (7 days). Reported wall-clock bounds are \
             refused for order-only corpora rather than being compared with synthetic sequence \
             values. Prefer this bounded search to reading the raw corpus. Cite template ids in \
             conclusions. Omitting corpus uses the host active corpus."
        ),
        side_effect: ToolSideEffect::Read,
        parameters: json!({
            "type": "object",
            "properties": {
                "corpus": corpus_param(),
                "query": { "type": "string" },
                "time_from": {
                    "type": "integer",
                    "description": format!(
                        "Inclusive start as a Unix timestamp in whole seconds. Must be supplied \
                         with time_to; the pair may span at most \
                         {MAX_SEARCH_LOG_TIME_WINDOW_SECS} seconds."
                    )
                },
                "time_to": {
                    "type": "integer",
                    "description": format!(
                        "Exclusive end as a Unix timestamp in whole seconds. Must be supplied \
                         with time_from; the pair may span at most \
                         {MAX_SEARCH_LOG_TIME_WINDOW_SECS} seconds."
                    )
                },
                "level": { "type": "string" },
                "service": { "type": "string" },
                "trace_id": { "type": "string" },
                "semantic": { "type": "boolean" },
                "k": { "type": "integer" },
                "candidate_k": {
                    "type": "integer",
                    "description": "Optional bounded pre-rerank candidate pool. Must be at least k and is capped at 100; omit for the normal k-sized pool."
                }
            },
            "required": []
        }),
    }
}

/// Read: cluster_problems.
pub fn cluster_problems_tool_spec() -> ToolSpec {
    ToolSpec {
        name: CLUSTER_PROBLEMS.into(),
        description: "Group log templates into problem clusters ranked by severity×frequency. Returns citeable template ids + exemplars. Omitting corpus uses the host active corpus.".into(),
        side_effect: ToolSideEffect::Read,
        parameters: json!({
            "type": "object",
            "properties": {
                "corpus": corpus_param(),
                "max_clusters": { "type": "integer" }
            },
            "required": []
        }),
    }
}

/// Read: timeline.
pub fn timeline_tool_spec() -> ToolSpec {
    ToolSpec {
        name: TIMELINE.into(),
        description:
            "Frequency-over-time of log events in a corpus (optional level/service filter). Omitting corpus uses the host active corpus.".into(),
        side_effect: ToolSideEffect::Read,
        parameters: json!({
            "type": "object",
            "properties": {
                "corpus": corpus_param(),
                "width_secs": { "type": "integer" },
                "level": { "type": "string" },
                "service": { "type": "string" }
            },
            "required": []
        }),
    }
}

/// Read: correlate around a template / time.
pub fn correlate_tool_spec() -> ToolSpec {
    ToolSpec {
        name: CORRELATE.into(),
        description: "Find templates that co-occur or precede a focus template near an incident time (temporal + sequence). Cite template ids. Omitting corpus uses the host active corpus.".into(),
        side_effect: ToolSideEffect::Read,
        parameters: json!({
            "type": "object",
            "properties": {
                "corpus": corpus_param(),
                "focus_template_id": { "type": "integer" },
                "around_ts": { "type": "integer" },
                "window_secs": { "type": "integer" },
                "k": { "type": "integer" }
            },
            "required": ["focus_template_id"]
        }),
    }
}

/// Read: anomalies incident vs baseline.
pub fn anomalies_tool_spec() -> ToolSpec {
    ToolSpec {
        name: ANOMALIES.into(),
        description: "New or rare log templates in an incident window vs a baseline window. Cite template ids. Omitting corpus uses the host active corpus.".into(),
        side_effect: ToolSideEffect::Read,
        parameters: json!({
            "type": "object",
            "properties": {
                "corpus": corpus_param(),
                "baseline_from": { "type": "integer" },
                "baseline_to": { "type": "integer" },
                "incident_from": { "type": "integer" },
                "incident_to": { "type": "integer" },
                "k": { "type": "integer" }
            },
            "required": ["baseline_from", "baseline_to", "incident_from", "incident_to"]
        }),
    }
}

/// Read: follow a trace id.
pub fn trace_tool_spec() -> ToolSpec {
    ToolSpec {
        name: TRACE.into(),
        description: "Follow a trace_id/request_id across services and time in a log corpus. Omitting corpus uses the host active corpus."
            .into(),
        side_effect: ToolSideEffect::Read,
        parameters: json!({
            "type": "object",
            "properties": {
                "corpus": corpus_param(),
                "trace_id": { "type": "string" }
            },
            "required": ["trace_id"]
        }),
    }
}

/// All Phase-1 + Phase-2 log tool specs.
pub fn log_tool_specs() -> Vec<ToolSpec> {
    let mut specs = vec![
        ingest_logs_tool_spec(),
        search_logs_tool_spec(),
        cluster_problems_tool_spec(),
        timeline_tool_spec(),
        correlate_tool_spec(),
        anomalies_tool_spec(),
        trace_tool_spec(),
    ];
    // #646: agent/detector proposed findings (SoftWrite → Proposed only).
    specs.push(crate::investigations::propose_finding_tool_spec());
    // #532: agent/detector proposed report sections (SoftWrite → Proposed only).
    specs.push(crate::investigations::propose_report_section_tool_spec());
    specs
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn search_logs_schema_teaches_bounded_reported_time_semantics() {
        let spec = search_logs_tool_spec();
        let properties = spec.parameters["properties"]
            .as_object()
            .expect("search_logs properties");
        let time_from = &properties["time_from"];
        let time_to = &properties["time_to"];

        assert_eq!(time_from["type"], "integer");
        assert_eq!(time_to["type"], "integer");
        assert!(time_from["description"]
            .as_str()
            .is_some_and(|description| description.contains("Inclusive start")));
        assert!(time_to["description"]
            .as_str()
            .is_some_and(|description| description.contains("Exclusive end")));
        assert!(spec.description.contains("problem was reported"));
        assert!(spec.description.contains("deterministic bounded search"));
        assert!(spec.description.contains("refused for order-only corpora"));
        assert!(spec
            .description
            .contains(&MAX_SEARCH_LOG_TIME_WINDOW_SECS.to_string()));
        assert_eq!(properties["candidate_k"]["type"], "integer");
        assert!(properties["candidate_k"]["description"]
            .as_str()
            .is_some_and(|description| description.contains("capped at 100")));
        assert_eq!(spec.parameters["required"], json!([]));
    }

    #[test]
    fn propose_report_section_is_registered_as_a_soft_write_log_tool() {
        let name = crate::investigations::PROPOSE_REPORT_SECTION_TOOL;
        assert!(is_log_tool(name));
        let specs = log_tool_specs();
        let spec = specs
            .iter()
            .find(|spec| spec.name == name)
            .expect("propose_report_section spec registered");
        assert_eq!(spec.side_effect, ToolSideEffect::SoftWrite);
        assert!(
            !crate::tools::may_auto_execute(spec.side_effect),
            "SoftWrite proposals must always pass through the permission prompt"
        );
        // Schema/execution agreement (#532 hardening): expected_revision is
        // required in the schema because execution hard-requires it.
        assert_eq!(
            spec.parameters["required"],
            json!(["expected_revision", "idempotency_key", "kind", "body"])
        );
    }
}
