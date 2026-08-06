//! Log & large-corpus analysis subsystem (LOG_ANALYSIS.md Phase 1–2).
//!
//! Pipeline: ingest files → format detect/parse → Drain templates → redact →
//! DuckDB event store → template embed → hybrid search / cluster / timeline /
//! correlate / anomalies / trace.
//!
//! Corpora are disposable (app cache), never mixed into durable SQLite memory.

pub mod analysis;
pub mod bookmarks;
pub mod company_import_lab;
pub mod diagnostics;
pub mod drain;
pub mod embed_policy;
pub mod event_revision;
pub mod exception_episodes;
pub mod format_profile;
pub mod frame;
pub mod governed_citation;
pub mod import_diagnose;
pub mod import_preview;
pub mod import_profile;
pub mod ingest;
mod ingest_confidence;
pub mod ingest_pipeline;
pub mod lanes;
pub mod linked_search_bound;
pub mod logging_quality;
pub mod noise_candidates;
pub mod normalize_export;
pub mod operational_metrics;
pub mod package;
pub mod parse;
pub mod query;
pub mod reanalyze;
pub mod redact_log;
pub mod reviewed_format;
pub mod search;
pub mod store;
pub mod suppression;
pub mod suppression_lens;
pub mod timezone_application;
pub mod timezone_resolution;
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
pub use company_import_lab::{
    generate_company_import_lab, verify_company_import_lab, CompanyImportLabOracle,
    CompanyImportLabPackage, CompanyImportLabSize, CompanyImportLabVerifyReport, PhaseTimingBudget,
    COMPANY_IMPORT_LAB_BASE_TS, COMPANY_IMPORT_LAB_GENERATOR, COMPANY_IMPORT_LAB_ORACLE_SCHEMA,
    COMPANY_IMPORT_LAB_SEED,
};
pub use diagnostics::{
    classify_failed_ingest, FailedIngestDiagnostic, FailedIngestDiagnosticRecorder,
    FailedIngestDiagnosticStore, FailedIngestEvidenceSummary, FailedIngestProgress,
    FailedIngestReason, FailedIngestScanCounts, FailedIngestSourceKind,
    FAILED_INGEST_DIAGNOSTIC_SCHEMA_VERSION, MAX_FAILED_INGEST_EVIDENCE_ENTRIES,
};
pub use drain::{
    DrainMiner, TemplateInfo, MAX_DRAIN_TEMPLATES, MAX_DRAIN_TEMPLATES_PER_LENGTH_BUCKET,
};
pub use embed_policy::{
    LogEmbedMode, LogEmbedPolicy, CLOUD_LEAVE_MACHINE_CONFIRM, LOCAL_EMBED_DEFER_SOURCE_BYTES,
    TRIAGE_STRESS_250K_SOURCE_BYTES,
};
pub use event_revision::{
    apply_event_timestamp_revision, undo_event_revision, EventRevisionMetadata,
    EventRevisionReport, EventTimestampUpdate, EVENT_REVISION_AUDIT_SCHEMA_VERSION,
    EVENT_REVISION_METADATA_SCHEMA_VERSION, MAX_EVENT_REVISION_METADATA_BYTES,
};
pub use exception_episodes::{
    analyze_bounded_events, analyze_exception_episodes, analyze_exception_episodes_with_cancel,
    analyze_exception_episodes_with_cancel_flag, format_exception_episode_brief_section,
    is_exception_candidate, project_template_onto_episodes, ExceptionAmplificationMetrics,
    ExceptionCitationRole, ExceptionCorrelationConfidence, ExceptionCountRatio,
    ExceptionEpisodeAnalysis, ExceptionEpisodeReport, ExceptionEventCitation,
    ExceptionFamilySummary, ExceptionOccurrenceSummary, ExceptionRenderingKind,
    TemplateEpisodeProjection, EXCEPTION_EPISODE_EVENT_SCAN_CAP, EXCEPTION_EPISODE_FAMILY_CAP,
    EXCEPTION_EPISODE_RECORD_CAP, EXCEPTION_EPISODE_RENDER_CAP, EXCEPTION_EPISODE_ROW_WALK_CAP,
    EXCEPTION_EPISODE_SCHEMA_ID, EXCEPTION_EPISODE_SCHEMA_VERSION,
};
pub use format_profile::{
    fingerprint_format, BuiltInFormatProfile, BuiltInGrammar, FormatFingerprint,
    FormatFingerprintOutcome, FormatProfileIdentity, BUILT_IN_FORMAT_PROFILES,
    MIN_STRUCTURED_FORMAT_SCORE,
};
pub use governed_citation::{
    format_governed_log_citation_id, is_governed_log_citation_id, parse_governed_log_citation_id,
    GovernedLogCitationId, GovernedLogCitationKind,
};
pub use import_diagnose::{
    diagnose_log_import, public_report_denylist_patterns, strip_variable_fields,
    write_import_diagnostic_report, AtomicPublicationOutcome, ImportDiagnoseOptions,
    ImportDiagnosticBuild, ImportDiagnosticConfidence, ImportDiagnosticDiscrepancy,
    ImportDiagnosticIngest, ImportDiagnosticInputShape, ImportDiagnosticOutcome,
    ImportDiagnosticOutcomeKind, ImportDiagnosticPreview, ImportDiagnosticPrivacy,
    ImportDiagnosticReport, IMPORT_DIAGNOSTIC_REDACTION_MODE, IMPORT_DIAGNOSTIC_SCHEMA_ID,
    IMPORT_DIAGNOSTIC_SCHEMA_VERSION,
};
pub use ingest::{
    ingest_path, ingest_path_with_observer, ingest_path_with_policy,
    ingest_path_with_policy_and_observer, ingest_path_with_policy_and_observer_managed,
    ingest_path_with_policy_selection_and_observer,
    ingest_path_with_policy_selection_and_observer_managed, IngestPhaseTimings, IngestReport,
    IngestSelection, IngestStats,
};
pub use ingest_confidence::{
    IngestConfidenceCounts, IngestConfidenceReport, IngestFormatOutcome, SourceIngestConfidence,
    UnresolvedTimeReason, MAX_TIMESTAMP_PREFIX_SAMPLES, MAX_TIMESTAMP_PREFIX_SAMPLE_CHARS,
};
pub use ingest_pipeline::{
    classify_ingest_pipeline_identity, IngestPipelineCompatibility, INGEST_PIPELINE_IDENTITY,
    INGEST_PIPELINE_SEMANTICS,
};
pub use lanes::{
    clamp_lane_count, compute_gaps, link_allowed, nearest_at_or_after, scrub_linked, GapRegion,
    LaneEventRef, LinkScrubResult, PeerPosition, MAX_LANES,
};
pub use linked_search_bound::{
    citations_from_search_evidence, BoundDecision, CiteableEvidenceSet,
    LinkedSearchProgressTracker, SearchIntentKey, MAX_MATERIAL_NO_PROGRESS_REFINEMENTS,
};
pub use logging_quality::{
    assess_logging_quality, public_assessment_denylist_patterns, render_logging_quality_markdown,
    validate_logging_quality_json, LoggingQualityAssessment, LoggingQualityConfidence,
    LoggingQualityCorpusRef, LoggingQualityDimensionScore, LoggingQualityEvidenceKind,
    LoggingQualityEvidenceLocator, LoggingQualityFinding, LoggingQualityFindingCategory,
    LoggingQualityFindingConfidence, LoggingQualityFindingSeverity, LoggingQualityGrade,
    LoggingQualityImprovementHint, LoggingQualityMetrics, LoggingQualityPrivacy,
    LoggingQualitySelectionCoverage, LoggingQualitySourceMetrics, LoggingQualityStoredLevelMetrics,
    LoggingQualitySummary, LoggingQualityTemplateMetrics, LoggingQualityTemplateRef,
    LoggingQualityTraceIdMetrics, LOGGING_QUALITY_REDACTION_MODE, LOGGING_QUALITY_SCHEMA_ID,
    LOGGING_QUALITY_SCHEMA_VERSION, MAX_ASSESSMENT_FINDINGS, MAX_ASSESSMENT_SOURCES,
    MAX_CONCENTRATION_TEMPLATES,
};
pub use noise_candidates::{
    propose_noise_candidates, propose_noise_candidates_with_cancel, score_noise_candidate_facts,
    template_eligible_for_noise_candidate, NoiseCandidate, NoiseCandidateOptions,
    NoiseCandidateReasonCode, NoiseCandidateReport, NoiseCandidateRepresentative,
    NoiseCandidateShape, TemplateNoiseFacts, DEFAULT_NOISE_CANDIDATE_CAP,
    DEFAULT_NOISE_REPRESENTATIVE_CAP, MAX_NOISE_CANDIDATES, MAX_NOISE_LEVEL_BUCKETS,
    MAX_NOISE_PATTERN_BYTES, MAX_NOISE_QUERY_COUNT, MAX_NOISE_QUERY_DURATION,
    MAX_NOISE_REPORT_BYTES, MAX_NOISE_REPRESENTATIVES, MAX_NOISE_REPRESENTATIVE_EXCERPT_BYTES,
    MAX_TEMPLATES_SCANNED, MIN_CORPUS_EVENTS_FOR_CANDIDATES, MIN_PROPOSAL_SCORE,
    MIN_TEMPLATE_EVENTS_FOR_CANDIDATE,
};
pub use normalize_export::{
    build_source_batches, documented_level_to_otel, load_events_with_originals,
    load_events_with_originals_page, map_event_to_normalized, map_level_severity, publish_staging,
    severity_absent, severity_from_original, source_jsonl_relative_path, unix_secs_to_rfc3339_z,
    validate_jsonl_file, write_and_validate_staging, write_source_jsonl, EventWithOriginal,
    NormalizationManifest, NormalizationReport, NormalizationSourceReport, NormalizeTimezonePolicy,
    PreviewCountSnapshot, SourceExportBatch, NORMALIZE_EVENT_PAGE, NORMALIZE_PRODUCER_NAME,
    NORMALIZE_PRODUCER_VERSION,
};
pub use operational_metrics::{
    load_operational_metrics_attachment, remove_operational_metrics_attachment,
    save_operational_metrics_attachment, OperationalMetricsAttachment,
    OperationalMetricsAttachmentError, OperationalMetricsAttachmentMetadata,
    OperationalMetricsAttachmentSource, MAX_OPERATIONAL_METRICS_ATTACHMENT_BYTES,
    MAX_OPERATIONAL_METRICS_DISPLAY_LABEL_BYTES, OPERATIONAL_METRICS_ATTACHMENT_SCHEMA_VERSION,
    OPERATIONAL_METRICS_DOCUMENT_SCHEMA_VERSION,
};
pub use package::{
    export_corpus_zip, import_corpus_zip, import_corpus_zip_path, import_corpus_zip_reader,
    validate_package_versions, PackageImportReport, PackageManifest, PackageReader,
    PACKAGE_FORMAT_VERSION, PACKAGE_READERS, PACKAGE_READER_VERSION,
};
pub use parse::{
    detect_format, parse_line, parse_line_with_fingerprint, ActiveTimestampBasis,
    FingerprintedParsedLine, LogFormat, ParsedLine, TimestampProvenance,
};
pub use query::{
    classify_active_timestamp_basis, classify_timestamp_provenance, classify_ts,
    corpus_time_quality, query_event_count, query_event_neighborhood, query_event_rows,
    query_events, query_facets, query_shared_timeline_summary, query_source_catalog,
    query_timeline_summary, search_events, search_events_advanced,
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
    activate_template_suppression, capture_suppression_policy_binding, load_suppression_document,
    mutate_template_suppression_rule, preview_template_suppression,
    suppression_diagnostic_snapshot, ActivateSuppressionPreview, NewSuppressionPreview,
    SuppressionAuditAction, SuppressionAuditEntry, SuppressionDiagnosticAuditEntry,
    SuppressionDiagnosticRule, SuppressionDiagnosticSnapshot, SuppressionDocument,
    SuppressionLevelCount, SuppressionMutationResult, SuppressionPolicyBindingSnapshot,
    SuppressionPreview, SuppressionRepresentativeEvent, SuppressionRule, SuppressionRuleMutation,
    SuppressionRuleOrigin, SuppressionRuleResolution, SuppressionRuleResolutionKind,
    SuppressionRuleState, SuppressionTemplatePredicate, SuppressionTimeSpan,
    MAX_DIAGNOSTIC_SUPPRESSION_AUDIT, MAX_DIAGNOSTIC_SUPPRESSION_RULES,
    MAX_SUPPRESSION_AUDIT_ENTRIES, MAX_SUPPRESSION_LEVEL_BUCKETS, MAX_SUPPRESSION_PREVIEWS,
    MAX_SUPPRESSION_REPRESENTATIVES, MAX_SUPPRESSION_RULES, SUPPRESSION_SCHEMA_VERSION,
};
pub use suppression_lens::{
    apply_lens_to_query, apply_trusted_suppression_lens, invalidate_trusted_suppression_lens,
    trusted_suppression_lens, SuppressionLensApplication, SuppressionLensState,
    TrustedSuppressionLens,
};
pub use timezone_application::{
    apply_source_timezone, apply_source_timezones, clear_source_timezone,
    load_timezone_resolution_state, preview_source_timezone, SourceTimezoneApplyRequest,
    TimezoneResolutionState, TimezoneSourceStatus,
};
pub use timezone_resolution::{
    SourceTimezoneDeclaration, SourceTimezoneResolver, TimestampResolution,
    TimestampResolutionProvenance, TimezoneDeclarationBasis, TimezoneResolutionError,
    TimezoneResolutionPreview, TimezoneResolutionScope, UnresolvedTimestampReason,
    MAX_IANA_TIMEZONE_BYTES, MAX_RESOLVED_WALL_SECONDS, MAX_TIMEZONE_SOURCE_BYTES,
    MIN_RESOLVED_WALL_SECONDS, TIMEZONE_DECLARATION_SCHEMA_VERSION,
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
