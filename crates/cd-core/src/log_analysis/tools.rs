//! Static tool specs for log analysis (#360–#362).

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

/// All Phase-1 log tool names.
pub const LOG_TOOL_NAMES: &[&str] = &[INGEST_LOGS, SEARCH_LOGS, CLUSTER_PROBLEMS, TIMELINE];

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

/// All Phase-1 log tool specs.
pub fn log_tool_specs() -> Vec<ToolSpec> {
    vec![
        ingest_logs_tool_spec(),
        search_logs_tool_spec(),
        cluster_problems_tool_spec(),
        timeline_tool_spec(),
    ]
}
