//! Log & large-corpus analysis subsystem (LOG_ANALYSIS.md Phase 1–2).
//!
//! Pipeline: ingest files → format detect/parse → Drain templates → redact →
//! DuckDB event store → template embed → hybrid search / cluster / timeline /
//! correlate / anomalies / trace.
//!
//! Corpora are disposable (app cache), never mixed into durable SQLite memory.

pub mod analysis;
pub mod drain;
pub mod embed_policy;
pub mod ingest;
pub mod package;
pub mod parse;
pub mod redact_log;
pub mod search;
pub mod store;
pub mod tools;
pub mod why;

pub use analysis::{cluster_problems, timeline, ClusterSummary, TimelineBucket};
pub use drain::{DrainMiner, TemplateInfo};
pub use embed_policy::{LogEmbedMode, LogEmbedPolicy, CLOUD_LEAVE_MACHINE_CONFIRM};
pub use ingest::{
    ingest_path, ingest_path_with_observer, ingest_path_with_policy,
    ingest_path_with_policy_and_observer, IngestReport, IngestStats,
};
pub use package::{
    export_corpus_zip, import_corpus_zip, import_corpus_zip_path, import_corpus_zip_reader,
    validate_package_versions, PackageImportReport, PackageManifest, PACKAGE_FORMAT_VERSION,
    PACKAGE_READER_VERSION,
};
pub use parse::{detect_format, parse_line, LogFormat, ParsedLine};
pub use search::{search_logs, SearchHit, SearchLogsQuery};

pub use store::{
    CorpusId, CorpusMeta, CorpusStats, CorpusSummary, LogCorpus, LogEvent, TemplateRow,
    TopTemplateSnapshot, EVENT_ENGINE, META_VERSION,
};
pub use tools::{
    anomalies_tool_spec, cluster_problems_tool_spec, correlate_tool_spec, ingest_logs_tool_spec,
    is_log_tool, log_tool_specs, search_logs_tool_spec, timeline_tool_spec, trace_tool_spec,
    ANOMALIES, CLUSTER_PROBLEMS, CORRELATE, INGEST_LOGS, LOG_TOOL_NAMES, SEARCH_LOGS, TIMELINE,
    TRACE,
};
pub use why::{anomalies, correlate, trace, AnomalyHit, CorrelateHit, TraceEvent};
