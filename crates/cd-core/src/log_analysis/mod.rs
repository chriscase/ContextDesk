//! Log & large-corpus analysis subsystem (LOG_ANALYSIS.md Phase 1–2).
//!
//! Pipeline: ingest files → format detect/parse → Drain templates → redact →
//! DuckDB event store → template embed → hybrid search / cluster / timeline /
//! correlate / anomalies / trace.
//!
//! Corpora are disposable (app cache), never mixed into durable SQLite memory.

pub mod analysis;
pub mod bookmarks;
pub mod diagnostics;
pub mod drain;
pub mod embed_policy;
pub mod format_profile;
pub mod ingest;
pub mod lanes;
pub mod package;
pub mod parse;
pub mod query;
pub mod reanalyze;
pub mod redact_log;
pub mod search;
pub mod store;
pub mod suppression;
pub mod tools;
pub mod view_context;
pub mod why;

pub use analysis::{
    cluster_problems, cluster_problems_with_excluded_templates, timeline,
    timeline_summary_with_excluded_templates, timeline_with_excluded_templates, ClusterSummary,
    TimelineBucket,
};
pub use bookmarks::{
    add_evidence_bookmark, add_line_bookmark, add_range_bookmark, bookmark_summaries,
    delete_bookmark, list_bookmarks, list_resolved_bookmarks, resolve_bookmark, update_bookmark,
    Bookmark, BookmarkEventRef, BookmarkEvidenceStatus, BookmarkSummary, NewBookmark,
    NewEvidenceBookmark, ResolvedBookmark, MAX_BOOKMARK_EVENT_REFS,
};
pub use diagnostics::{
    classify_failed_ingest, FailedIngestDiagnostic, FailedIngestDiagnosticRecorder,
    FailedIngestDiagnosticStore, FailedIngestEvidenceSummary, FailedIngestProgress,
    FailedIngestReason, FailedIngestScanCounts, FailedIngestSourceKind,
    FAILED_INGEST_DIAGNOSTIC_SCHEMA_VERSION, MAX_FAILED_INGEST_EVIDENCE_ENTRIES,
};
pub use drain::{DrainMiner, TemplateInfo};
pub use embed_policy::{
    LogEmbedMode, LogEmbedPolicy, CLOUD_LEAVE_MACHINE_CONFIRM, LOCAL_EMBED_DEFER_SOURCE_BYTES,
};
pub use format_profile::{
    fingerprint_format, BuiltInFormatProfile, BuiltInGrammar, FormatFingerprint,
    FormatFingerprintOutcome, FormatProfileIdentity, BUILT_IN_FORMAT_PROFILES,
    MIN_STRUCTURED_FORMAT_SCORE,
};
pub use ingest::{
    ingest_path, ingest_path_with_observer, ingest_path_with_policy,
    ingest_path_with_policy_and_observer, ingest_path_with_policy_and_observer_managed,
    IngestReport, IngestStats,
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
pub use parse::{
    detect_format, parse_line, parse_line_with_fingerprint, FingerprintedParsedLine, LogFormat,
    ParsedLine,
};
pub use query::{
    classify_ts, corpus_time_quality, query_event_count, query_event_neighborhood,
    query_event_rows, query_events, query_facets, query_shared_timeline_summary,
    query_source_catalog, query_timeline_summary, search_events, search_events_advanced,
    search_events_advanced_with_cancel, EventCount, EventNeighborhood, EventNeighborhoodQuery,
    EventPage, EventQuery, EventRowsPage, EventSearchHit, EventSearchQuery, EventSearchResult,
    ExplorerEvent, LogFacets, LogSourceCatalogEntry, LogSourceCatalogPage, LogSourceCatalogQuery,
    SearchMatchMode, SharedTimelineAxisBucket, SharedTimelineLaneScope, SharedTimelineLaneSummary,
    SharedTimelineSeverity, SharedTimelineSeveritySeries, SharedTimelineSummary,
    SharedTimelineSummaryQuery, TargetResolveStatus, TimeQuality, TimelineSummary,
    TimelineSummaryBucket, TimelineSummaryQuery, DEFAULT_EVENT_PAGE, DEFAULT_NEIGHBORHOOD_RADIUS,
    DEFAULT_SOURCE_CATALOG_PAGE, DEFAULT_TIMELINE_BUCKETS, MAX_EVENT_PAGE,
    MAX_EXCLUDED_TEMPLATE_IDS, MAX_NEIGHBORHOOD_RADIUS, MAX_REGEX_SCAN_EVENTS,
    MAX_SEARCH_EXCERPT_LEN, MAX_SEARCH_PATTERN_LEN, MAX_SHARED_TIMELINE_COUNT_CELLS,
    MAX_SHARED_TIMELINE_LANES, MAX_SOURCE_CATALOG_CURSOR_BYTES, MAX_SOURCE_CATALOG_PAGE,
    MAX_SOURCE_CATALOG_SEARCH_CHARS, MAX_TIMELINE_BUCKETS, MIN_WALL_TS,
    SHARED_TIMELINE_SEVERITY_SERIES,
};
pub use reanalyze::{
    reanalyze_corpus_embeddings, reanalyze_corpus_embeddings_quiet, LOCAL_REANALYZE_TEMPLATE_CAP,
};
pub use search::{
    search_logs, search_logs_with_excluded_templates, SearchEvidenceIdentity, SearchHit,
    SearchLogsQuery, MAX_ANALYSIS_EXCLUDED_TEMPLATE_IDS,
};

pub use store::{
    CorpusEmbeddingStatus, CorpusId, CorpusMeta, CorpusStats, CorpusSummary, EmbeddingState,
    LogCorpus, LogEvent, TemplateRow, TopTemplateSnapshot, EVENT_ENGINE, META_VERSION,
};
pub use suppression::{
    activate_template_suppression, load_suppression_document, mutate_template_suppression_rule,
    preview_template_suppression, ActivateSuppressionPreview, NewSuppressionPreview,
    SuppressionAuditAction, SuppressionAuditEntry, SuppressionDocument, SuppressionLevelCount,
    SuppressionMutationResult, SuppressionPreview, SuppressionRepresentativeEvent, SuppressionRule,
    SuppressionRuleMutation, SuppressionRuleOrigin, SuppressionRuleState,
    SuppressionTemplatePredicate, SuppressionTimeSpan, MAX_SUPPRESSION_AUDIT_ENTRIES,
    MAX_SUPPRESSION_LEVEL_BUCKETS, MAX_SUPPRESSION_PREVIEWS, MAX_SUPPRESSION_REPRESENTATIVES,
    MAX_SUPPRESSION_RULES, SUPPRESSION_SCHEMA_VERSION,
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
pub use why::{
    anomalies, anomalies_with_excluded_templates, correlate, correlate_with_excluded_templates,
    trace, trace_with_excluded_templates, AnomalyHit, CorrelateHit, TraceEvent,
};
