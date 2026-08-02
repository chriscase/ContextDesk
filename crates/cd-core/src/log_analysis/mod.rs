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
pub mod format_profile;
pub mod frame;
pub mod governed_citation;
pub mod import_diagnose;
pub mod import_preview;
pub mod import_profile;
pub mod ingest;
mod ingest_confidence;
pub mod lanes;
pub mod noise_candidates;
pub mod operational_metrics;
pub mod package;
pub mod parse;
pub mod query;
pub mod reanalyze;
pub mod redact_log;
pub mod reviewed_format;
pub mod reviewed_format_store;
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
pub use import_profile::{
    match_profile, match_profile_with_reviewed, validate_profile, ImportProfile,
    ImportProfileIdentity, ProfileApplicability, ProfileDiagnostic, ProfileDiagnosticCode,
    ProfileFinding, ProfileFindingKind, ProfileFindingReason, ProfileMatchReport, ProfileRef,
    ProfileScope, SafePattern, SourceGroupRule, IMPORT_PROFILE_READER_VERSION,
    IMPORT_PROFILE_SCHEMA_ID, MAX_IMPORT_PROFILE_BYTES, MAX_IMPORT_PROFILE_GROUPS,
    MAX_IMPORT_PROFILE_ID_CHARS, MAX_IMPORT_PROFILE_PATTERNS, MAX_IMPORT_PROFILE_PATTERN_CHARS,
    MAX_IMPORT_PROFILE_PATTERN_SEGMENTS, MAX_IMPORT_PROFILE_PATTERN_WILDCARDS,
};

pub use ingest::{
    ingest_path, ingest_path_with_observer, ingest_path_with_policy,
    ingest_path_with_policy_and_observer, ingest_path_with_policy_and_observer_managed,
    ingest_path_with_policy_bindings_and_observer, ingest_path_with_policy_selection_and_observer,
    ingest_path_with_policy_selection_and_observer_managed, IngestPhaseTimings, IngestReport,
    IngestSelection, IngestStats,
};
pub use ingest_confidence::{
    IngestConfidenceCounts, IngestConfidenceReport, IngestFormatOutcome, SourceIngestConfidence,
    UnresolvedTimeReason, MAX_TIMESTAMP_PREFIX_SAMPLES, MAX_TIMESTAMP_PREFIX_SAMPLE_CHARS,
};
pub use lanes::{
    clamp_lane_count, compute_gaps, link_allowed, nearest_at_or_after, scrub_linked, GapRegion,
    LaneEventRef, LinkScrubResult, PeerPosition, MAX_LANES,
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
pub use reviewed_format::{
    assemble_records, is_candidate_for, match_line, match_line_outcome, preview_reviewed_format,
    select_format, validate_reviewed_format, AssembledRecord, ExtractedFields, FieldSlot,
    FormatSelection, LineOutcome, MultilineRule, ReviewedFormat, ReviewedFormatDiagnostic,
    ReviewedFormatDiagnosticCode, ReviewedFormatPreview, ReviewedFormatValidation, TimeToken,
    TimestampGrammar, MAX_FORMAT_ID_CHARS, MAX_FORMAT_PATH_PATTERNS, MAX_LAYOUT_SLOTS,
    MAX_MATCHABLE_LINE_BYTES, MAX_MULTILINE_LINES, MAX_PREVIEW_SAMPLES, MAX_TIMESTAMP_TOKENS,
    REVIEWED_FORMAT_READER_VERSION, REVIEWED_FORMAT_SCHEMA_ID,
};
pub use reviewed_format_store::{
    apply_reviewed_format_bindings, apply_reviewed_format_bindings_with_report,
    resolve_profile_ref, ReviewedFormatAppliedBinding, ReviewedFormatApplyBinding,
    ReviewedFormatApplyRequest, ReviewedFormatApplyResult, ReviewedFormatIdentity,
    ReviewedFormatIngestBindings, ReviewedFormatResolveOutcome, ReviewedFormatStore,
    ReviewedFormatStoreEntry, ReviewedFormatStoreIndex, MAX_REVIEWED_FORMAT_DOCUMENT_BYTES,
    MAX_REVIEWED_FORMAT_STORE_ENTRIES, REVIEWED_FORMAT_STORE_READER_VERSION,
    REVIEWED_FORMAT_STORE_SCHEMA_ID,
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
