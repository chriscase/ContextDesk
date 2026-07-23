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

/// All Phase-1 + Phase-2 log tool names.
pub const LOG_TOOL_NAMES: &[&str] = &[
    INGEST_LOGS,
    SEARCH_LOGS,
    CLUSTER_PROBLEMS,
    TIMELINE,
    CORRELATE,
    ANOMALIES,
    TRACE,
];

/// True when `name` is a log analysis tool.
pub fn is_log_tool(name: &str) -> bool {
    LOG_TOOL_NAMES.contains(&name)
}

/// SoftWrite: ingest a path/dir into a named corpus.
pub fn ingest_logs_tool_spec() -> ToolSpec {
    ToolSpec {
        name: INGEST_LOGS.into(),
        description: "Ingest a local log file or directory into a disposable analysis corpus (parse, template, embed). SoftWrite — user must Accept. Returns corpus id + template summary.".into(),
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

/// Read: hybrid search_logs.
pub fn search_logs_tool_spec() -> ToolSpec {
    ToolSpec {
        name: SEARCH_LOGS.into(),
        description: "Hybrid search over an ingested log corpus (structured filter + semantic templates + keyword). Cite template ids in conclusions.".into(),
        side_effect: ToolSideEffect::Read,
        parameters: json!({
            "type": "object",
            "properties": {
                "corpus": { "type": "string" },
                "query": { "type": "string" },
                "level": { "type": "string" },
                "service": { "type": "string" },
                "trace_id": { "type": "string" },
                "semantic": { "type": "boolean" },
                "k": { "type": "integer" }
            },
            "required": ["corpus"]
        }),
    }
}

/// Read: cluster_problems.
pub fn cluster_problems_tool_spec() -> ToolSpec {
    ToolSpec {
        name: CLUSTER_PROBLEMS.into(),
        description: "Group log templates into problem clusters ranked by severity×frequency. Returns citeable template ids + exemplars.".into(),
        side_effect: ToolSideEffect::Read,
        parameters: json!({
            "type": "object",
            "properties": {
                "corpus": { "type": "string" },
                "max_clusters": { "type": "integer" }
            },
            "required": ["corpus"]
        }),
    }
}

/// Read: timeline.
pub fn timeline_tool_spec() -> ToolSpec {
    ToolSpec {
        name: TIMELINE.into(),
        description:
            "Frequency-over-time of log events in a corpus (optional level/service filter).".into(),
        side_effect: ToolSideEffect::Read,
        parameters: json!({
            "type": "object",
            "properties": {
                "corpus": { "type": "string" },
                "width_secs": { "type": "integer" },
                "level": { "type": "string" },
                "service": { "type": "string" }
            },
            "required": ["corpus"]
        }),
    }
}

/// Read: correlate around a template / time.
pub fn correlate_tool_spec() -> ToolSpec {
    ToolSpec {
        name: CORRELATE.into(),
        description: "Find templates that co-occur or precede a focus template near an incident time (temporal + sequence). Cite template ids.".into(),
        side_effect: ToolSideEffect::Read,
        parameters: json!({
            "type": "object",
            "properties": {
                "corpus": { "type": "string" },
                "focus_template_id": { "type": "integer" },
                "around_ts": { "type": "integer" },
                "window_secs": { "type": "integer" },
                "k": { "type": "integer" }
            },
            "required": ["corpus", "focus_template_id"]
        }),
    }
}

/// Read: anomalies incident vs baseline.
pub fn anomalies_tool_spec() -> ToolSpec {
    ToolSpec {
        name: ANOMALIES.into(),
        description: "New or rare log templates in an incident window vs a baseline window. Cite template ids.".into(),
        side_effect: ToolSideEffect::Read,
        parameters: json!({
            "type": "object",
            "properties": {
                "corpus": { "type": "string" },
                "baseline_from": { "type": "integer" },
                "baseline_to": { "type": "integer" },
                "incident_from": { "type": "integer" },
                "incident_to": { "type": "integer" },
                "k": { "type": "integer" }
            },
            "required": ["corpus", "baseline_from", "baseline_to", "incident_from", "incident_to"]
        }),
    }
}

/// Read: follow a trace id.
pub fn trace_tool_spec() -> ToolSpec {
    ToolSpec {
        name: TRACE.into(),
        description: "Follow a trace_id/request_id across services and time in a log corpus."
            .into(),
        side_effect: ToolSideEffect::Read,
        parameters: json!({
            "type": "object",
            "properties": {
                "corpus": { "type": "string" },
                "trace_id": { "type": "string" }
            },
            "required": ["corpus", "trace_id"]
        }),
    }
}

/// All Phase-1 + Phase-2 log tool specs.
pub fn log_tool_specs() -> Vec<ToolSpec> {
    vec![
        ingest_logs_tool_spec(),
        search_logs_tool_spec(),
        cluster_problems_tool_spec(),
        timeline_tool_spec(),
        correlate_tool_spec(),
        anomalies_tool_spec(),
        trace_tool_spec(),
    ]
}
