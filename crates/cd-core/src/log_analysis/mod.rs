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
pub mod reanalyze;
pub mod redact_log;
pub mod search;
pub mod store;
pub mod tools;
pub mod view_context;
pub mod why;

pub use analysis::{cluster_problems, timeline, ClusterSummary, TimelineBucket};
pub use bookmarks::{
    add_evidence_bookmark, add_line_bookmark, add_range_bookmark, bookmark_summaries,
    delete_bookmark, list_bookmarks, list_resolved_bookmarks, resolve_bookmark, update_bookmark,
    Bookmark, BookmarkEventRef, BookmarkEvidenceStatus, BookmarkSummary, NewBookmark,
    NewEvidenceBookmark, ResolvedBookmark, MAX_BOOKMARK_EVENT_REFS,
};
pub use drain::{DrainMiner, TemplateInfo};
pub use embed_policy::{
    LogEmbedMode, LogEmbedPolicy, CLOUD_LEAVE_MACHINE_CONFIRM, LOCAL_EMBED_DEFER_SOURCE_BYTES,
};
pub use ingest::{
    ingest_path, ingest_path_with_observer, ingest_path_with_policy,
    ingest_path_with_policy_and_observer, IngestReport, IngestStats,
};
pub use lanes::{
    clamp_lane_count, compute_gaps, link_allowed, nearest_at_or_after, scrub_linked, GapRegion,
    LaneEventRef, LinkScrubResult, PeerPosition, MAX_LANES,
};
pub use package::{
    export_corpus_zip, import_corpus_zip, import_corpus_zip_path, import_corpus_zip_reader,
    validate_package_versions, PackageImportReport, PackageManifest, PackageReader,
    PACKAGE_FORMAT_VERSION, PACKAGE_READERS, PACKAGE_READER_VERSION,
};
pub use parse::{detect_format, parse_line, LogFormat, ParsedLine};
pub use query::{
    classify_ts, corpus_time_quality, query_event_neighborhood, query_events, query_facets,
    query_timeline_summary, search_events, search_events_advanced,
    search_events_advanced_with_cancel, EventNeighborhood, EventNeighborhoodQuery, EventPage,
    EventQuery, EventSearchHit, EventSearchQuery, EventSearchResult, ExplorerEvent, LogFacets,
    SearchMatchMode, TargetResolveStatus, TimeQuality, TimelineSummary, TimelineSummaryBucket,
    TimelineSummaryQuery, DEFAULT_EVENT_PAGE, DEFAULT_NEIGHBORHOOD_RADIUS,
    DEFAULT_TIMELINE_BUCKETS, MAX_EVENT_PAGE, MAX_NEIGHBORHOOD_RADIUS, MAX_REGEX_SCAN_EVENTS,
    MAX_SEARCH_EXCERPT_LEN, MAX_SEARCH_PATTERN_LEN, MAX_TIMELINE_BUCKETS, MIN_WALL_TS,
};
pub use reanalyze::{
    reanalyze_corpus_embeddings, reanalyze_corpus_embeddings_quiet, LOCAL_REANALYZE_TEMPLATE_CAP,
};
pub use search::{search_logs, SearchEvidenceIdentity, SearchHit, SearchLogsQuery};

pub use store::{
    CorpusEmbeddingStatus, CorpusId, CorpusMeta, CorpusStats, CorpusSummary, EmbeddingState,
    LogCorpus, LogEvent, TemplateRow, TopTemplateSnapshot, EVENT_ENGINE, META_VERSION,
};
pub use tools::{
    anomalies_tool_spec, cluster_problems_tool_spec, correlate_tool_spec, ingest_logs_tool_spec,
    is_log_tool, log_tool_specs, search_logs_tool_spec, timeline_tool_spec, trace_tool_spec,
    ANOMALIES, CLUSTER_PROBLEMS, CORRELATE, INGEST_LOGS, LOG_TOOL_NAMES, SEARCH_LOGS, TIMELINE,
    TRACE,
};
pub use view_context::{
    apply_log_nav, build_view_context, parse_log_nav, view_context_brief, ExplorerFilters,
    LaneView, LogNavAction, LogNavApplyResult, ViewContextInput, ViewContextSnapshot,
    MAX_VIEW_BOOKMARKS, MAX_VIEW_SEQS,
};
pub use why::{anomalies, correlate, trace, AnomalyHit, CorrelateHit, TraceEvent};
