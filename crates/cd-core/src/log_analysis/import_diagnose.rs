//! Privacy-safe offline log-import diagnostic reports.
//!
//! Runs the real preview → plan verification → streaming ingest path into an
//! automatically deleted temporary cache root with embeddings disabled. The
//! default public report is aggregate-only: no payloads, paths, basenames,
//! archive member identities, hashes, credentials, environment values,
//! provider data, or raw timestamps.

use super::diagnostics::{
    classify_failed_ingest, FailedIngestProgress, FailedIngestReason, FailedIngestSourceKind,
};
use super::embed_policy::{LogEmbedMode, LogEmbedPolicy};
use super::import_preview::{
    event_importable, preview_import_plan, verify_import_plan, ImportItemRole, ImportItemStatus,
    ImportPlanBlock, ImportPreviewPlan, ImportPreviewReason, ImportSourceKind,
};
use super::ingest::{
    ingest_path_with_policy_selection_and_observer, IngestPhaseTimings, IngestReport,
};
use super::ingest_confidence::{IngestConfidenceCounts, UnresolvedTimeReason};
use crate::build_identity;
use crate::error::{CoreError, CoreResult};
use crate::process_progress::{
    CancelFlag, ProcessProgress, ProcessProgressKind, ProcessProgressObserver, ProcessProgressPhase,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::Write;
use std::path::Path;
use std::sync::Mutex;
use std::time::Instant;

/// Public schema id for the diagnostic report document.
pub const IMPORT_DIAGNOSTIC_SCHEMA_ID: &str = "contextdesk.import_diagnostic.v1";

/// Schema version for [`ImportDiagnosticReport`].
pub const IMPORT_DIAGNOSTIC_SCHEMA_VERSION: u32 = 1;

/// Explicit redaction mode of the default public report.
pub const IMPORT_DIAGNOSTIC_REDACTION_MODE: &str = "public_safe_default";

/// Wire document for offline import diagnosis (attachable to a bug report).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportDiagnosticReport {
    /// Stable schema id.
    pub schema_id: String,
    /// Schema version ([`IMPORT_DIAGNOSTIC_SCHEMA_VERSION`]).
    pub schema_version: u32,
    /// Product build identity (version/protocol/channel only).
    pub build: ImportDiagnosticBuild,
    /// Explicit privacy/redaction contract.
    pub privacy: ImportDiagnosticPrivacy,
    /// Terminal outcome of the diagnostic run.
    pub outcome: ImportDiagnosticOutcome,
    /// Bounded input shape without any path or member identity.
    pub input: ImportDiagnosticInputShape,
    /// Preview aggregates (no item identities/text).
    pub preview: ImportDiagnosticPreview,
    /// Ingest aggregates when ingest was attempted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ingest: Option<ImportDiagnosticIngest>,
    /// Confidence aggregates when ingest completed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confidence: Option<ImportDiagnosticConfidence>,
    /// Phase timings (may vary across identical inputs).
    pub phase_timings: IngestPhaseTimings,
    /// Progress terminal snapshot.
    pub progress: FailedIngestProgress,
    /// Typed preview/run discrepancy codes.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub discrepancies: Vec<ImportDiagnosticDiscrepancy>,
    /// Wall time for the entire diagnose operation (ms; may vary).
    pub diagnose_wall_ms: u64,
}

/// Build identity fields safe for a public report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportDiagnosticBuild {
    /// Cargo package version.
    pub version: String,
    /// Protocol version.
    pub protocol: String,
    /// Update/UX channel wire form.
    pub channel: String,
}

/// Explicit privacy policy embedded in every report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportDiagnosticPrivacy {
    /// Redaction mode id.
    pub redaction_mode: String,
    /// Human-oriented description of what is stripped.
    pub policy_summary: String,
    /// True when any source inventory was truncated at a bound.
    pub inventory_truncated: bool,
    /// True when any bounded counter or transcript was capped.
    pub counters_capped: bool,
}

/// Terminal outcome of diagnose.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportDiagnosticOutcome {
    /// Coarse result class.
    pub kind: ImportDiagnosticOutcomeKind,
    /// Stable fail/cancel classification when not success.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fail_reason: Option<FailedIngestReason>,
    /// Atomic publication result for the temporary corpus.
    pub atomic_publication: AtomicPublicationOutcome,
    /// True when the temporary cache root was removed after the run.
    pub temporary_corpus_deleted: bool,
}

/// Coarse diagnostic result.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImportDiagnosticOutcomeKind {
    /// Preview + plan + ingest completed with at least one imported file or line.
    Success,
    /// Operation cancelled before durable publish.
    Cancelled,
    /// Failed closed with a useful report.
    FailClosed,
}

/// Whether a temporary corpus was published into the temp cache root.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AtomicPublicationOutcome {
    /// Corpus was published into the temp root and then deleted with it.
    PublishedThenDeleted,
    /// Corpus published, but verified removal of the temporary root failed.
    PublishedCleanupFailed,
    /// Ingest never reached atomic publication.
    NotPublished,
    /// Publication failed; temp root still cleaned.
    PublicationFailed,
}

/// Input shape without paths or member names.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportDiagnosticInputShape {
    /// Coarse source kind from path metadata only.
    pub source_kind: FailedIngestSourceKind,
    /// Preview source kind when preview succeeded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview_source_kind: Option<ImportSourceKind>,
    /// Total entries observed by preview (or 0).
    pub entry_count: u64,
    /// Sum of declared sizes from preview items.
    pub declared_bytes_total: u64,
}

/// Preview-side aggregates.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportDiagnosticPreview {
    /// Whether preview completed.
    pub completed: bool,
    /// Status histogram.
    #[serde(default)]
    pub status_counts: BTreeMap<String, u64>,
    /// Role histogram.
    #[serde(default)]
    pub role_counts: BTreeMap<String, u64>,
    /// Reason histogram.
    #[serde(default)]
    pub reason_counts: BTreeMap<String, u64>,
    /// Format-id histogram (product format ids only).
    #[serde(default)]
    pub format_counts: BTreeMap<String, u64>,
    /// Preview truncated flag.
    pub truncated: bool,
    /// Plan block when publication would be refused.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan_block: Option<ImportPlanBlock>,
    /// Count of event-importable items selected for the diagnostic ingest.
    pub selected_for_import: u64,
    /// Count of event-importable items (selectable log role).
    pub event_importable: u64,
}

/// Ingest-side aggregates (no basenames/examples).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportDiagnosticIngest {
    /// Files imported through EOF.
    pub files: u64,
    /// Files discovered.
    pub discovered_files: u64,
    /// Excluded by policy.
    pub excluded_files: u64,
    /// Failed open/read.
    pub failed_files: u64,
    /// Ignored (hidden / not selected).
    pub ignored_files: u64,
    /// Logical lines/events.
    pub lines: u64,
    /// Distinct templates.
    pub templates: u64,
    /// Source bytes streamed.
    pub source_bytes: u64,
    /// On-disk corpus footprint before deletion.
    pub corpus_bytes: u64,
    /// Partial import flag.
    pub partial: bool,
    /// Level histogram.
    #[serde(default)]
    pub level_counts: BTreeMap<String, u64>,
    /// Format histogram.
    #[serde(default)]
    pub format_counts: BTreeMap<String, u64>,
    /// Timestamp provenance histogram.
    #[serde(default)]
    pub timestamp_provenance_counts: BTreeMap<String, u64>,
    /// Active timestamp basis histogram.
    #[serde(default)]
    pub active_timestamp_basis_counts: BTreeMap<String, u64>,
    /// Exclusion/failure reason histogram (reason codes only).
    #[serde(default)]
    pub exclusion_reason_counts: BTreeMap<String, u64>,
    /// Embedding mode actually used (always none for diagnose).
    pub embed_mode: String,
}

/// Confidence aggregates without per-source identities or samples.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportDiagnosticConfidence {
    /// Corpus-level time quality wire form.
    pub corpus_time_quality: String,
    /// Source-level confidence counts.
    pub counts: IngestConfidenceCounts,
    /// Unresolved-time reason histogram across sources.
    #[serde(default)]
    pub unresolved_time_reason_counts: BTreeMap<String, u64>,
}

/// Typed preview vs run discrepancy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImportDiagnosticDiscrepancy {
    /// Preview selected count differs from files imported.
    SelectedVsImportedCount,
    /// Preview had importable items but ingest produced zero files.
    ImportableButZeroImported,
    /// Ingest reported partial while a selection was provided.
    IngestPartialAgainstSelection,
    /// Preview truncated so unreviewed tail cannot be claimed imported.
    PreviewTruncatedUnreviewedTail,
}

/// Options for [`diagnose_log_import`].
#[derive(Debug, Clone, Default)]
pub struct ImportDiagnoseOptions {
    /// Optional cancel flag shared with the caller.
    pub cancel: Option<CancelFlag>,
}

/// Progress recorder used only for terminal counters (no messages retained).
#[derive(Debug, Default)]
struct DiagnoseProgress {
    inner: Mutex<FailedIngestProgress>,
}

impl ProcessProgressObserver for DiagnoseProgress {
    fn progress(&self, update: ProcessProgress) {
        if update.kind != ProcessProgressKind::LogIngest {
            return;
        }
        let Ok(mut guard) = self.inner.lock() else {
            return;
        };
        guard.last_phase = update.phase;
        guard.updates_seen = guard.updates_seen.saturating_add(1);
        if let Some(v) = update.lines_processed {
            guard.lines_processed = Some(guard.lines_processed.unwrap_or(0).max(v));
        }
        if let Some(v) = update.files_processed {
            guard.files_processed = Some(guard.files_processed.unwrap_or(0).max(v));
        }
        if let Some(v) = update.bytes_processed {
            guard.bytes_processed = Some(guard.bytes_processed.unwrap_or(0).max(v));
        }
        if let Some(v) = update.templates {
            guard.templates = Some(guard.templates.unwrap_or(0).max(v));
        }
    }
}

impl DiagnoseProgress {
    fn snapshot(&self) -> FailedIngestProgress {
        self.inner.lock().map(|g| g.clone()).unwrap_or_default()
    }
}

/// Run the offline import diagnostic against `input`.
///
/// Always uses a temporary cache root that is deleted before return. Never
/// contacts the network, never mutates `input`, never leaves a corpus in the
/// user's real library path.
pub fn diagnose_log_import(
    input: &Path,
    options: ImportDiagnoseOptions,
) -> CoreResult<ImportDiagnosticReport> {
    let wall = Instant::now();
    let build = current_public_build();
    let source_kind = FailedIngestSourceKind::from_path(input);
    let cancel = options.cancel.unwrap_or_default();
    let progress = DiagnoseProgress::default();

    let mut report = base_report(build, source_kind);

    let temp = match tempfile::TempDir::new() {
        Ok(t) => t,
        Err(e) => {
            report.outcome.kind = ImportDiagnosticOutcomeKind::FailClosed;
            report.outcome.fail_reason = Some(FailedIngestReason::WorkerFailed);
            report.outcome.atomic_publication = AtomicPublicationOutcome::NotPublished;
            report.outcome.temporary_corpus_deleted = true;
            report.progress.last_phase = ProcessProgressPhase::Failed;
            report.diagnose_wall_ms = elapsed_ms(wall);
            tracing::error!(error = %e, "diagnose tempdir failed");
            return Ok(report);
        }
    };
    let cache_root = temp.path().to_path_buf();

    let finalize =
        |mut report: ImportDiagnosticReport, temp: tempfile::TempDir| -> ImportDiagnosticReport {
            report.progress = progress.snapshot();
            // Prefer terminal phase from outcome when progress never advanced.
            if report.progress.updates_seen == 0 {
                report.progress.last_phase = match report.outcome.kind {
                    ImportDiagnosticOutcomeKind::Success => ProcessProgressPhase::Completed,
                    ImportDiagnosticOutcomeKind::Cancelled => ProcessProgressPhase::Cancelled,
                    ImportDiagnosticOutcomeKind::FailClosed => ProcessProgressPhase::Failed,
                };
            }
            // `TempDir::close` reports cleanup failure; `Drop` cannot. Never claim
            // that a temporary published corpus was deleted without this proof.
            apply_cleanup_outcome(&mut report, temp.close().is_ok());
            report.diagnose_wall_ms = elapsed_ms(wall);
            report
        };

    if cancel.is_cancelled() {
        report.outcome.kind = ImportDiagnosticOutcomeKind::Cancelled;
        report.outcome.fail_reason = Some(FailedIngestReason::Cancelled);
        report.outcome.atomic_publication = AtomicPublicationOutcome::NotPublished;
        return Ok(finalize(report, temp));
    }

    let plan = match preview_import_plan(input, Some(&cancel)) {
        Ok(p) => p,
        Err(err) => {
            apply_error_outcome(&mut report, &err, &cancel);
            return Ok(finalize(report, temp));
        }
    };

    fill_preview(&mut report, &plan);

    if cancel.is_cancelled() {
        report.outcome.kind = ImportDiagnosticOutcomeKind::Cancelled;
        report.outcome.fail_reason = Some(FailedIngestReason::Cancelled);
        report.outcome.atomic_publication = AtomicPublicationOutcome::NotPublished;
        return Ok(finalize(report, temp));
    }

    if let Some(block) = plan.report.plan_block() {
        report.preview.plan_block = Some(block);
        report.outcome.kind = ImportDiagnosticOutcomeKind::FailClosed;
        report.outcome.fail_reason = Some(match block {
            ImportPlanBlock::SourceEmpty | ImportPlanBlock::NoImportableSources => {
                FailedIngestReason::NoImportableFiles
            }
            ImportPlanBlock::AllSourcesBlocked => FailedIngestReason::PolicyRejected,
        });
        report.outcome.atomic_publication = AtomicPublicationOutcome::NotPublished;
        return Ok(finalize(report, temp));
    }

    let selected: Vec<String> = plan
        .report
        .items
        .iter()
        .filter(|item| event_importable(item))
        .map(|item| item.identity.clone())
        .collect();
    report.preview.selected_for_import = selected.len() as u64;

    if selected.is_empty() {
        report.outcome.kind = ImportDiagnosticOutcomeKind::FailClosed;
        report.outcome.fail_reason = Some(FailedIngestReason::NoImportableFiles);
        report.outcome.atomic_publication = AtomicPublicationOutcome::NotPublished;
        return Ok(finalize(report, temp));
    }

    let selection = match verify_import_plan(
        input,
        plan.plan_version,
        &plan.plan_token,
        &selected,
        Some(&cancel),
    ) {
        Ok(s) => s,
        Err(err) => {
            apply_error_outcome(&mut report, &err, &cancel);
            return Ok(finalize(report, temp));
        }
    };

    let policy = LogEmbedPolicy {
        mode: LogEmbedMode::None,
        cloud_content_leaves_machine: false,
        cloud_base_url: None,
        model_id: "diagnose-none".into(),
        defer_above_source_bytes: None,
    };

    match ingest_path_with_policy_selection_and_observer(
        &cache_root,
        input,
        "import-diagnose",
        &policy,
        None,
        &progress,
        Some(&cancel),
        &selection,
    ) {
        Ok(ingested) => {
            fill_ingest(&mut report, &ingested);
            report.phase_timings = ingested.phase_timings.clone();
            if ingested.stats.files > 0 || ingested.stats.lines > 0 {
                report.outcome.kind = ImportDiagnosticOutcomeKind::Success;
                report.outcome.fail_reason = None;
            } else {
                report.outcome.kind = ImportDiagnosticOutcomeKind::FailClosed;
                report.outcome.fail_reason = Some(FailedIngestReason::NoSafeEvents);
            }
            report.outcome.atomic_publication = AtomicPublicationOutcome::PublishedThenDeleted;
            compute_discrepancies(&mut report);
        }
        Err(err) => {
            apply_error_outcome(&mut report, &err, &cancel);
            report.outcome.atomic_publication = AtomicPublicationOutcome::NotPublished;
        }
    }

    Ok(finalize(report, temp))
}

/// Write `report` as pretty JSON to `output`.
pub fn write_import_diagnostic_report(
    report: &ImportDiagnosticReport,
    output: &Path,
) -> CoreResult<()> {
    let json = serde_json::to_string_pretty(report)
        .map_err(|e| CoreError::Message(format!("serialize import diagnostic: {e}")))?;
    if let Some(parent) = output.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|e| CoreError::Message(format!("create diagnostic output parent: {e}")))?;
        }
    }
    let parent = output.parent().filter(|p| !p.as_os_str().is_empty());
    let temp_parent = parent.unwrap_or_else(|| Path::new("."));
    let mut staged = tempfile::NamedTempFile::new_in(temp_parent)
        .map_err(|e| CoreError::Message(format!("stage import diagnostic: {e}")))?;
    staged
        .write_all(json.as_bytes())
        .and_then(|()| staged.as_file().sync_all())
        .map_err(|e| CoreError::Message(format!("write import diagnostic: {e}")))?;
    staged.persist_noclobber(output).map_err(|_| {
        CoreError::Message(
            "publish import diagnostic: output already exists or cannot be created".into(),
        )
    })?;
    Ok(())
}

/// Zero fields that may differ across identical synthetic inputs.
pub fn strip_variable_fields(report: &mut ImportDiagnosticReport) {
    report.diagnose_wall_ms = 0;
    report.phase_timings = IngestPhaseTimings::default();
    report.progress.updates_seen = 0;
    if let Some(ing) = report.ingest.as_mut() {
        // On-disk footprint can vary by page size; semantic counters stay.
        ing.corpus_bytes = 0;
    }
}

/// Patterns forbidden in the serialized public report (case-insensitive scan).
pub fn public_report_denylist_patterns() -> &'static [&'static str] {
    &[
        // Path / identity leakage
        "/users/",
        "/home/",
        "c:\\\\",
        "\\\\",
        ".contextdesk",
        "log_corpora",
        // Credentials / env
        "api_key",
        "apikey",
        "authorization:",
        "bearer ",
        "password",
        "secret",
        "aws_access",
        // Hash / fingerprint shape (32+ hex)
        // checked separately via regex in tests
        // Provider
        "openai.com",
        "api.x.ai",
        "ollama",
    ]
}

fn apply_error_outcome(report: &mut ImportDiagnosticReport, err: &CoreError, cancel: &CancelFlag) {
    if matches!(err, CoreError::Cancelled) || cancel.is_cancelled() {
        report.outcome.kind = ImportDiagnosticOutcomeKind::Cancelled;
        report.outcome.fail_reason = Some(FailedIngestReason::Cancelled);
        report.progress.last_phase = ProcessProgressPhase::Cancelled;
    } else {
        report.outcome.kind = ImportDiagnosticOutcomeKind::FailClosed;
        report.outcome.fail_reason = Some(classify_failed_ingest(&err.to_string()));
        report.progress.last_phase = ProcessProgressPhase::Failed;
    }
    report.outcome.atomic_publication = AtomicPublicationOutcome::NotPublished;
}

fn apply_cleanup_outcome(report: &mut ImportDiagnosticReport, deleted: bool) {
    report.outcome.temporary_corpus_deleted = deleted;
    if deleted {
        return;
    }
    if report.outcome.atomic_publication == AtomicPublicationOutcome::PublishedThenDeleted {
        report.outcome.atomic_publication = AtomicPublicationOutcome::PublishedCleanupFailed;
    }
    report.outcome.kind = ImportDiagnosticOutcomeKind::FailClosed;
    report.outcome.fail_reason = Some(FailedIngestReason::WorkerFailed);
    report.progress.last_phase = ProcessProgressPhase::Failed;
}

fn current_public_build() -> ImportDiagnosticBuild {
    let id = build_identity::current();
    ImportDiagnosticBuild {
        version: id.version,
        protocol: id.protocol,
        channel: id.channel.as_str().to_string(),
    }
}

fn base_report(
    build: ImportDiagnosticBuild,
    source_kind: FailedIngestSourceKind,
) -> ImportDiagnosticReport {
    ImportDiagnosticReport {
        schema_id: IMPORT_DIAGNOSTIC_SCHEMA_ID.into(),
        schema_version: IMPORT_DIAGNOSTIC_SCHEMA_VERSION,
        build,
        privacy: ImportDiagnosticPrivacy {
            redaction_mode: IMPORT_DIAGNOSTIC_REDACTION_MODE.into(),
            policy_summary:
                "Default public-safe report: aggregate counts and stable reason/format \
codes only. Strips log payloads, representative/template/event text, paths, basenames, archive \
member identities, credentials, environment values, hashes/fingerprints, provider data, and raw \
timestamps."
                    .into(),
            inventory_truncated: false,
            counters_capped: false,
        },
        outcome: ImportDiagnosticOutcome {
            kind: ImportDiagnosticOutcomeKind::FailClosed,
            fail_reason: None,
            atomic_publication: AtomicPublicationOutcome::NotPublished,
            temporary_corpus_deleted: false,
        },
        input: ImportDiagnosticInputShape {
            source_kind,
            preview_source_kind: None,
            entry_count: 0,
            declared_bytes_total: 0,
        },
        preview: ImportDiagnosticPreview::default(),
        ingest: None,
        confidence: None,
        phase_timings: IngestPhaseTimings::default(),
        progress: FailedIngestProgress::default(),
        discrepancies: Vec::new(),
        diagnose_wall_ms: 0,
    }
}

fn fill_preview(report: &mut ImportDiagnosticReport, plan: &ImportPreviewPlan) {
    let r = &plan.report;
    report.preview.completed = true;
    report.preview.truncated = r.truncated;
    report.privacy.inventory_truncated = r.truncated;
    report.input.preview_source_kind = Some(r.source_kind);
    report.input.entry_count = r.counts.total;
    report.input.declared_bytes_total = r.items.iter().map(|i| i.bytes).sum();
    report.preview.plan_block = r.plan_block();

    let mut status = BTreeMap::new();
    let mut role = BTreeMap::new();
    let mut reason = BTreeMap::new();
    let mut format = BTreeMap::new();
    let mut event_importable_n = 0u64;

    for item in &r.items {
        *status
            .entry(status_key(item.status).to_string())
            .or_insert(0) += 1;
        *role.entry(role_key(item.role).to_string()).or_insert(0) += 1;
        for re in &item.reasons {
            *reason.entry(reason_key(*re).to_string()).or_insert(0) += 1;
        }
        if let Some(fid) = &item.format_id {
            *format.entry(fid.clone()).or_insert(0) += 1;
        }
        if event_importable(item) {
            event_importable_n = event_importable_n.saturating_add(1);
        }
    }
    report.preview.status_counts = status;
    report.preview.role_counts = role;
    report.preview.reason_counts = reason;
    report.preview.format_counts = format;
    report.preview.event_importable = event_importable_n;
    if r.truncated {
        report
            .discrepancies
            .push(ImportDiagnosticDiscrepancy::PreviewTruncatedUnreviewedTail);
    }
}

fn fill_ingest(report: &mut ImportDiagnosticReport, ingested: &IngestReport) {
    let s = &ingested.stats;
    report.ingest = Some(ImportDiagnosticIngest {
        files: s.files as u64,
        discovered_files: s.discovered_files,
        excluded_files: s.excluded_files,
        failed_files: s.failed_files,
        ignored_files: s.ignored_files,
        lines: s.lines,
        templates: s.templates as u64,
        source_bytes: s.source_bytes,
        corpus_bytes: s.corpus_bytes,
        partial: s.partial,
        level_counts: s.level_counts.clone(),
        format_counts: s.format_counts.clone(),
        timestamp_provenance_counts: s.timestamp_provenance_counts.clone(),
        active_timestamp_basis_counts: s.active_timestamp_basis_counts.clone(),
        exclusion_reason_counts: s.exclusion_counts.clone(),
        embed_mode: "none".into(),
    });

    let mut unresolved_reasons = BTreeMap::new();
    for source in &ingested.confidence.sources {
        for r in &source.unresolved_reasons {
            *unresolved_reasons
                .entry(unresolved_key(*r).to_string())
                .or_insert(0) += 1;
        }
    }
    report.confidence = Some(ImportDiagnosticConfidence {
        corpus_time_quality: time_quality_key(ingested.confidence.corpus_time_quality),
        counts: ingested.confidence.counts.clone(),
        unresolved_time_reason_counts: unresolved_reasons,
    });
}

fn compute_discrepancies(report: &mut ImportDiagnosticReport) {
    let Some(ing) = report.ingest.as_ref() else {
        return;
    };
    let selected = report.preview.selected_for_import;
    if selected > 0 && !report.preview.truncated {
        if ing.files == 0 {
            report
                .discrepancies
                .push(ImportDiagnosticDiscrepancy::ImportableButZeroImported);
        } else if ing.files != selected {
            report
                .discrepancies
                .push(ImportDiagnosticDiscrepancy::SelectedVsImportedCount);
        }
    }
    if ing.partial {
        report
            .discrepancies
            .push(ImportDiagnosticDiscrepancy::IngestPartialAgainstSelection);
    }
    report.discrepancies.sort();
    report.discrepancies.dedup();
}

fn elapsed_ms(wall: Instant) -> u64 {
    wall.elapsed().as_millis() as u64
}

fn status_key(s: ImportItemStatus) -> &'static str {
    match s {
        ImportItemStatus::Ready => "ready",
        ImportItemStatus::Review => "review",
        ImportItemStatus::RawFallback => "raw_fallback",
        ImportItemStatus::Supporting => "supporting",
        ImportItemStatus::Ignored => "ignored",
        ImportItemStatus::Unsupported => "unsupported",
        ImportItemStatus::Blocked => "blocked",
    }
}

fn role_key(r: ImportItemRole) -> &'static str {
    match r {
        ImportItemRole::Log => "log",
        ImportItemRole::OperationalMetrics => "operational_metrics",
        ImportItemRole::Attachment => "attachment",
        ImportItemRole::Readme => "readme",
        ImportItemRole::Unknown => "unknown",
    }
}

fn reason_key(r: ImportPreviewReason) -> &'static str {
    match r {
        ImportPreviewReason::ManifestDeclared => "manifest_declared",
        ImportPreviewReason::StrongFormatMatch => "strong_format_match",
        ImportPreviewReason::AmbiguousFormatMatch => "ambiguous_format_match",
        ImportPreviewReason::MixedFormatRecords => "mixed_format_records",
        ImportPreviewReason::NoStructuredMatch => "no_structured_match",
        ImportPreviewReason::InsufficientEventEvidence => "insufficient_event_evidence",
        ImportPreviewReason::XmlEventParsingUnsupported => "xml_event_parsing_unsupported",
        ImportPreviewReason::HtmlEventParsingUnsupported => "html_event_parsing_unsupported",
        ImportPreviewReason::BinaryContent => "binary_content",
        ImportPreviewReason::EmptyContent => "empty_content",
        ImportPreviewReason::Oversized => "oversized",
        ImportPreviewReason::Hidden => "hidden",
        ImportPreviewReason::SymlinkRejected => "symlink_rejected",
        ImportPreviewReason::NonRegularRejected => "non_regular_rejected",
        ImportPreviewReason::ArchiveDepthExceeded => "archive_depth_exceeded",
        ImportPreviewReason::CompressionRatioExceeded => "compression_ratio_exceeded",
        ImportPreviewReason::TraversalRejected => "traversal_rejected",
        ImportPreviewReason::DuplicateIdentity => "duplicate_identity",
        ImportPreviewReason::EncryptedEntry => "encrypted_entry",
        ImportPreviewReason::ReadFailed => "read_failed",
        ImportPreviewReason::MetricsDocument => "metrics_document",
        ImportPreviewReason::ReadmeDocument => "readme_document",
        ImportPreviewReason::WeakNameHintOnly => "weak_name_hint_only",
        ImportPreviewReason::NestedArchiveNotInventoried => "nested_archive_not_inventoried",
    }
}

fn unresolved_key(r: UnresolvedTimeReason) -> &'static str {
    match r {
        UnresolvedTimeReason::NoTimezone => "no_timezone",
        UnresolvedTimeReason::ZoneAbbreviationNotResolved => "zone_abbreviation_not_resolved",
    }
}

fn time_quality_key(q: super::query::TimeQuality) -> String {
    match q {
        super::query::TimeQuality::Wall => "wall".into(),
        super::query::TimeQuality::OrderOnly => "order_only".into(),
        super::query::TimeQuality::Mixed => "mixed".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::thread;
    use std::time::Duration;

    fn fixture_root() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/import-diagnose")
    }

    fn ensure_fixtures() {
        let root = fixture_root();
        let required = [
            "direct/app.jsonl",
            "direct/plain.log",
            "timestamps/local_unresolved.log",
            "timestamps/order_only.log",
            "multiline/stack.log",
            "zero/empty.log",
            "zero/.hidden.log",
            "binary/blob.bin",
            "macos_noise/__MACOSX/._junk",
            "macos_noise/app.log",
            "archives/not_a_zip.zip",
            "archives/nested.zip",
        ];
        for relative in required {
            assert!(root.join(relative).is_file(), "missing fixture {relative}");
        }
    }

    fn assert_public_safe(report: &ImportDiagnosticReport, forbidden_substrings: &[&str]) {
        let json = serde_json::to_string(report).unwrap();
        let lower = json.to_ascii_lowercase();
        for pat in public_report_denylist_patterns() {
            assert!(
                !lower.contains(&pat.to_ascii_lowercase()),
                "denylist hit {pat:?} in report"
            );
        }
        for pat in forbidden_substrings {
            assert!(
                !lower.contains(&pat.to_ascii_lowercase()),
                "fixture leak {pat:?} in report (len={})",
                json.len()
            );
        }
        // No absolute-looking unix paths
        assert!(!lower.contains("/users/"), "absolute path leak");
        assert!(!lower.contains("/tmp/"), "tmp path leak");
        // No long hex fingerprints (plan tokens / sha256)
        let hex_re = regex::Regex::new(r"[0-9a-f]{32,}").unwrap();
        assert!(
            !hex_re.is_match(&lower),
            "hash/fingerprint-like hex in report"
        );
        // No raw ISO timestamps in values (allow schema words only)
        let iso_re = regex::Regex::new(r"20\d{2}-\d{2}-\d{2}[t ]\d{2}:\d{2}").unwrap();
        assert!(!iso_re.is_match(&lower), "raw timestamp in report");
    }

    #[test]
    fn diagnose_direct_files_happy_path_is_public_safe() {
        ensure_fixtures();
        let input = fixture_root().join("direct");
        let report = diagnose_log_import(&input, ImportDiagnoseOptions::default()).unwrap();
        assert_eq!(report.schema_id, IMPORT_DIAGNOSTIC_SCHEMA_ID);
        assert_eq!(report.schema_version, IMPORT_DIAGNOSTIC_SCHEMA_VERSION);
        assert!(report.preview.completed);
        assert!(report.outcome.temporary_corpus_deleted);
        assert_eq!(
            report.outcome.atomic_publication,
            AtomicPublicationOutcome::PublishedThenDeleted
        );
        assert_eq!(report.outcome.kind, ImportDiagnosticOutcomeKind::Success);
        let ing = report.ingest.as_ref().expect("ingest");
        assert!(ing.files >= 1);
        assert!(ing.lines >= 1);
        assert_eq!(ing.embed_mode, "none");
        assert_public_safe(
            &report,
            &[
                "hello synthetic",
                "warn synthetic",
                "app.jsonl",
                "plain.log",
                "started synthetic",
            ],
        );
    }

    #[test]
    fn diagnose_is_deterministic_after_stripping_variable_fields() {
        ensure_fixtures();
        let input = fixture_root().join("direct");
        let mut a = diagnose_log_import(&input, ImportDiagnoseOptions::default()).unwrap();
        let mut b = diagnose_log_import(&input, ImportDiagnoseOptions::default()).unwrap();
        strip_variable_fields(&mut a);
        strip_variable_fields(&mut b);
        let ja = serde_json::to_value(&a).unwrap();
        let jb = serde_json::to_value(&b).unwrap();
        assert_eq!(ja, jb, "semantic report must match");
    }

    #[test]
    fn diagnose_zip_and_nested_zip() {
        ensure_fixtures();
        let outer = fixture_root().join("archives/nested.zip");
        let report = diagnose_log_import(&outer, ImportDiagnoseOptions::default()).unwrap();
        assert!(
            matches!(
                report.outcome.kind,
                ImportDiagnosticOutcomeKind::Success | ImportDiagnosticOutcomeKind::FailClosed
            ),
            "{:?}",
            report.outcome
        );
        assert!(report.outcome.temporary_corpus_deleted);
        assert_public_safe(
            &report,
            &[
                "nested synthetic",
                "top synthetic",
                "nested.zip",
                "inner.zip",
            ],
        );
    }

    #[test]
    fn diagnose_macos_noise_and_mixed() {
        ensure_fixtures();
        let report = diagnose_log_import(
            &fixture_root().join("macos_noise"),
            ImportDiagnoseOptions::default(),
        )
        .unwrap();
        assert!(report.preview.completed);
        assert_public_safe(&report, &["real log among noise", "__macosx", "._junk"]);
    }

    #[test]
    fn diagnose_timestamps_and_multiline() {
        ensure_fixtures();
        let report = diagnose_log_import(
            &fixture_root().join("timestamps"),
            ImportDiagnoseOptions::default(),
        )
        .unwrap();
        assert!(report.preview.completed);
        if let Some(c) = &report.confidence {
            // May or may not flag unresolved depending on parser — still public-safe.
            let _ = c.counts.unresolved;
        }
        assert_public_safe(
            &report,
            &["local wall without zone", "order only synthetic"],
        );

        let ml = diagnose_log_import(
            &fixture_root().join("multiline"),
            ImportDiagnoseOptions::default(),
        )
        .unwrap();
        assert_public_safe(&ml, &["boom synthetic", "module.frame"]);
    }

    #[test]
    fn diagnose_binary_and_zero_importable_fail_closed() {
        ensure_fixtures();
        let bin = diagnose_log_import(
            &fixture_root().join("binary"),
            ImportDiagnoseOptions::default(),
        )
        .unwrap();
        assert_eq!(bin.outcome.kind, ImportDiagnosticOutcomeKind::FailClosed);
        assert!(bin.outcome.temporary_corpus_deleted);
        assert_public_safe(&bin, &["blob.bin"]);

        let zero = diagnose_log_import(
            &fixture_root().join("zero"),
            ImportDiagnoseOptions::default(),
        )
        .unwrap();
        assert_eq!(zero.outcome.kind, ImportDiagnosticOutcomeKind::FailClosed);
        assert!(zero.preview.plan_block.is_some() || zero.preview.event_importable == 0);
        assert_public_safe(&zero, &["secret hidden synthetic", ".hidden.log"]);
    }

    #[test]
    fn diagnose_invalid_archive_fail_closed() {
        ensure_fixtures();
        let path = fixture_root().join("archives/not_a_zip.zip");
        let report = diagnose_log_import(&path, ImportDiagnoseOptions::default()).unwrap();
        assert_eq!(report.outcome.kind, ImportDiagnosticOutcomeKind::FailClosed);
        assert!(report.outcome.fail_reason.is_some());
        assert!(report.outcome.temporary_corpus_deleted);
        assert_public_safe(&report, &["not a zip file"]);
    }

    #[test]
    fn diagnose_cancel_cleans_temp_and_reports() {
        ensure_fixtures();
        let flag = CancelFlag::new();
        flag.cancel();
        let report = diagnose_log_import(
            &fixture_root().join("direct"),
            ImportDiagnoseOptions { cancel: Some(flag) },
        )
        .unwrap();
        assert_eq!(report.outcome.kind, ImportDiagnosticOutcomeKind::Cancelled);
        assert_eq!(
            report.outcome.fail_reason,
            Some(FailedIngestReason::Cancelled)
        );
        assert!(report.outcome.temporary_corpus_deleted);
        assert_eq!(
            report.outcome.atomic_publication,
            AtomicPublicationOutcome::NotPublished
        );
    }

    #[test]
    fn diagnose_cancel_mid_flight_cleans() {
        ensure_fixtures();
        let flag = CancelFlag::new();
        let flag2 = flag.clone();
        // Cancel shortly after start on a larger tree if available
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(5));
            flag2.cancel();
        });
        let report = diagnose_log_import(
            &fixture_root().join("direct"),
            ImportDiagnoseOptions { cancel: Some(flag) },
        )
        .unwrap();
        // Either cancelled or completed before cancel landed — both must clean temp.
        assert!(report.outcome.temporary_corpus_deleted);
        assert_public_safe(&report, &["hello synthetic"]);
    }

    #[test]
    fn write_report_roundtrip_and_denylist() {
        ensure_fixtures();
        let report = diagnose_log_import(
            &fixture_root().join("direct"),
            ImportDiagnoseOptions::default(),
        )
        .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("report.json");
        write_import_diagnostic_report(&report, &out).unwrap();
        let raw = fs::read_to_string(&out).unwrap();
        let parsed: ImportDiagnosticReport = serde_json::from_str(&raw).unwrap();
        assert_eq!(parsed.schema_id, IMPORT_DIAGNOSTIC_SCHEMA_ID);
        assert_public_safe(&parsed, &["hello synthetic"]);
    }

    #[test]
    fn write_report_refuses_to_overwrite_existing_input_or_report() {
        ensure_fixtures();
        let input = fixture_root().join("direct/plain.log");
        let original = fs::read(&input).unwrap();
        let report = diagnose_log_import(&input, ImportDiagnoseOptions::default()).unwrap();

        let err = write_import_diagnostic_report(&report, &input).unwrap_err();
        assert!(err.to_string().contains("output already exists"));
        assert_eq!(
            fs::read(&input).unwrap(),
            original,
            "input must be unchanged"
        );

        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("report.json");
        write_import_diagnostic_report(&report, &out).unwrap();
        let first = fs::read(&out).unwrap();
        let err = write_import_diagnostic_report(&report, &out).unwrap_err();
        assert!(err.to_string().contains("output already exists"));
        assert_eq!(
            fs::read(&out).unwrap(),
            first,
            "report must not be clobbered"
        );
    }

    #[test]
    fn temp_corpus_gone_after_diagnose() {
        ensure_fixtures();
        // Spy: run diagnose and ensure no leftover under system temp matching our name
        // by checking that a second call still succeeds and report claims deletion.
        let report = diagnose_log_import(
            &fixture_root().join("direct"),
            ImportDiagnoseOptions::default(),
        )
        .unwrap();
        assert!(report.outcome.temporary_corpus_deleted);
        // No durable library install: corpus_id is never exposed; success still deleted.
        assert_ne!(
            report.outcome.atomic_publication,
            AtomicPublicationOutcome::PublicationFailed
        );
    }

    #[test]
    fn cleanup_failure_is_never_reported_as_deleted_success() {
        let mut report = base_report(
            ImportDiagnosticBuild {
                version: "test".into(),
                protocol: "test".into(),
                channel: "test".into(),
            },
            FailedIngestSourceKind::Directory,
        );
        report.outcome.kind = ImportDiagnosticOutcomeKind::Success;
        report.outcome.atomic_publication = AtomicPublicationOutcome::PublishedThenDeleted;

        apply_cleanup_outcome(&mut report, false);

        assert!(!report.outcome.temporary_corpus_deleted);
        assert_eq!(report.outcome.kind, ImportDiagnosticOutcomeKind::FailClosed);
        assert_eq!(
            report.outcome.atomic_publication,
            AtomicPublicationOutcome::PublishedCleanupFailed
        );
        assert_eq!(
            report.outcome.fail_reason,
            Some(FailedIngestReason::WorkerFailed)
        );
        assert_eq!(report.progress.last_phase, ProcessProgressPhase::Failed);
    }
}
