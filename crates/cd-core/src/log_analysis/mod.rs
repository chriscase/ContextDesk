//! Log & large-corpus analysis subsystem (LOG_ANALYSIS.md Phase 1–2).
//!
//! Pipeline: ingest files → format detect/parse → Drain templates → redact →
//! DuckDB event store → template embed → hybrid search / cluster / timeline /
//! correlate / anomalies / trace.
//!
//! Corpora are disposable (app cache), never mixed into durable SQLite memory.

pub mod analysis;
pub mod bookmarks;
pub mod drain;
pub mod embed_policy;
pub mod ingest;
pub mod lanes;
pub mod package;
pub mod parse;
pub mod query;
pub mod redact_log;
pub mod search;
pub mod store;
pub mod tools;
pub mod view_context;
pub mod why;

pub use analysis::{cluster_problems, timeline, ClusterSummary, TimelineBucket};
pub use bookmarks::{
    add_line_bookmark, add_range_bookmark, bookmark_summaries, delete_bookmark, list_bookmarks,
    update_bookmark, Bookmark, BookmarkSummary,
};
pub use drain::{DrainMiner, TemplateInfo};
pub use embed_policy::{LogEmbedMode, LogEmbedPolicy, CLOUD_LEAVE_MACHINE_CONFIRM};
pub use ingest::{
    ingest_path, ingest_path_with_observer, ingest_path_with_policy,
    ingest_path_with_policy_and_observer, IngestReport, IngestStats,
};
pub use lanes::{
    clamp_lane_count, compute_gaps, link_allowed, nearest_at_or_after, scrub_linked, GapRegion,
    LaneEventRef, LinkScrubResult, PeerPosition, MAX_LANES,
};
pub use package::{
    export_corpus_zip, import_corpus_zip, import_corpus_zip_path, validate_package_versions,
    PackageImportReport, PackageManifest, PACKAGE_FORMAT_VERSION, PACKAGE_READER_VERSION,
};
pub use parse::{detect_format, parse_line, LogFormat, ParsedLine};
pub use query::{
    classify_ts, corpus_time_quality, query_events, query_facets, search_events, EventPage,
    EventQuery, EventSearchHit, EventSearchQuery, ExplorerEvent, LogFacets, TimeQuality,
    DEFAULT_EVENT_PAGE, MAX_EVENT_PAGE, MIN_WALL_TS,
};
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
pub use view_context::{
    apply_log_nav, build_view_context, parse_log_nav, view_context_brief, ExplorerFilters,
    LaneView, LogNavAction, LogNavApplyResult, ViewContextSnapshot, MAX_VIEW_BOOKMARKS,
    MAX_VIEW_SEQS,
};
pub use why::{anomalies, correlate, trace, AnomalyHit, CorrelateHit, TraceEvent};
