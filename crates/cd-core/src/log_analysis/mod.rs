//! Log & large-corpus analysis subsystem (LOG_ANALYSIS.md Phase 1).
//!
//! Pipeline: ingest files → format detect/parse → Drain templates → redact →
//! event store → template embed → hybrid search / cluster / timeline.
//!
//! Corpora are disposable (app cache), never mixed into durable SQLite memory.

pub mod analysis;
pub mod drain;
pub mod ingest;
pub mod parse;
pub mod redact_log;
pub mod search;
pub mod store;
pub mod tools;

pub use analysis::{cluster_problems, timeline, ClusterSummary, TimelineBucket};
pub use drain::{DrainMiner, TemplateInfo};
pub use ingest::{ingest_path, IngestReport, IngestStats};
pub use parse::{detect_format, parse_line, LogFormat, ParsedLine};
pub use search::{search_logs, SearchHit, SearchLogsQuery};
pub use store::{CorpusId, LogCorpus, LogEvent, TemplateRow};
pub use tools::{
    cluster_problems_tool_spec, ingest_logs_tool_spec, is_log_tool, log_tool_specs,
    search_logs_tool_spec, timeline_tool_spec, CLUSTER_PROBLEMS, INGEST_LOGS, LOG_TOOL_NAMES,
    SEARCH_LOGS, TIMELINE,
};
