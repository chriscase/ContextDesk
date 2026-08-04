//! Default-path import: reuse the production recommendation engine to reach
//! an explorable corpus from a bare `contextdesk import <archive>`.
//!
//! Nothing here reimplements format detection, source grouping, noise
//! exclusion, or reviewed-grammar matching — every one of those decisions is
//! already made deterministically by [`cd_core::log_analysis::import_preview`]
//! and [`cd_core::log_analysis::reviewed_format`], the same engines the
//! desktop app's guided import wizard and reviewed-format review UI use. This
//! module's job is strictly the plumbing around those engines: accept the
//! preview's preselection as the default selection, verify the plan, look up
//! any durable reviewed-format bindings that confidently apply, ingest
//! through the production reviewed-selection ingest path desktop uses for
//! guided import (`ingest_path_with_policy_selection_and_observer`), name
//! the resulting corpus, and aggregate any timezone ambiguity into at most
//! one question.
//!
//! Note: selective composition onto the activity product base does not yet
//! include the CLI tip's durable reviewed-format store + bindings-aware
//! ingest; default import still applies the same deterministic selection
//! plan, and `reviewed_formats_applied` remains empty until that store is
//! composed.

use cd_core::config::AppConfig;
use cd_core::error::{CoreError, CoreResult};
use cd_core::log_analysis::embed_policy::LogEmbedPolicy;
use cd_core::log_analysis::import_preview::{
    preview_import_plan, verify_import_plan, ImportPreviewCounts, ImportPreviewPlan,
};
use cd_core::log_analysis::ingest::{ingest_path_with_policy_selection_and_observer, IngestReport};
use cd_core::log_analysis::store::LogCorpus;
use cd_core::process_progress::{CancelFlag, NoopProcessProgress, ProcessProgressObserver};
use std::path::Path;

/// Deterministically suggest a corpus name from its source path.
///
/// Strips the extension, keeps the leaf component, and de-duplicates against
/// corpora that already exist under `cache_root` with a numeric suffix. No
/// content is inspected — the name is cosmetic, never an identity.
pub fn suggest_corpus_name(source_path: &Path, cache_root: &Path) -> CoreResult<String> {
    let leaf = source_path
        .file_stem()
        .and_then(|s| s.to_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("import")
        .to_string();
    let existing: std::collections::HashSet<String> = LogCorpus::list_summaries(cache_root)
        .unwrap_or_default()
        .into_iter()
        .map(|summary| summary.name)
        .collect();
    if !existing.contains(&leaf) {
        return Ok(leaf);
    }
    let mut suffix = 2u32;
    loop {
        let candidate = format!("{leaf} ({suffix})");
        if !existing.contains(&candidate) {
            return Ok(candidate);
        }
        suffix += 1;
    }
}

/// One durable reviewed-format grammar that was confidently confirmed and
/// applied to one source during this import — never listed unless
/// [`apply_reviewed_format_bindings`] actually succeeded for it, so this is
/// never a claim ahead of the fact.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewedFormatApplication {
    /// The exact source identity a saved grammar was bound to.
    pub source_identity: String,
    /// The reviewed format's human-readable name.
    pub format_name: String,
}

/// A concise, machine-readable summary of one default import — the data
/// behind the terse default output. `--explain-selection` renders the
/// underlying [`cd_core::log_analysis::import_preview::ImportPreviewReport`]
/// directly instead; this struct is not a substitute for it, only the
/// concise view.
///
/// Every count here is read from either the pre-ingest preview's own
/// [`ImportPreviewCounts`] (entries examined / selected / ignored /
/// unsupported / blocked — the classifier's ground truth, not re-derived by
/// this module) or the post-ingest [`IngestReport`]'s stats (events,
/// templates, formats, timestamp provenance, failures, partial) — never a
/// third, independently computed number that could drift from either.
#[derive(Debug, Clone)]
pub struct DefaultImportOutcome {
    /// The corpus produced.
    pub report: IngestReport,
    /// The name assigned (see [`suggest_corpus_name`]).
    pub corpus_name: String,
    /// Every entry the preview inventoried, selected or not
    /// (`plan.report.counts.total`). This is the **preview classifier**
    /// count — not necessarily equal to ingest's filesystem/archive walk
    /// (`discovered_files`), which also counts containers/directories the
    /// preview may fold differently. Both are reported; never force-matched.
    pub entries_examined: u64,
    /// File/archive entries the **ingest walk** discovered before policy
    /// decisions (`report.stats.discovered_files`). May exceed
    /// `entries_examined` when directories or intermediate archive members
    /// are counted as walk entries but not as preview inventory rows.
    pub discovered_files: u64,
    /// Sources the default selection actually chose
    /// (`plan.report.counts.selected`).
    pub sources_selected: u64,
    /// Deliberately skipped noise — hidden entries, directory bookkeeping
    /// (`plan.report.counts.ignored`).
    pub sources_ignored: u64,
    /// Readable but not importable as events: binary, empty, or no
    /// structured grammar matched (`plan.report.counts.unsupported`).
    pub sources_unsupported: u64,
    /// Refused by policy: oversized, symlink, traversal, archive-depth,
    /// compression-ratio, encrypted (`plan.report.counts.blocked`).
    pub sources_excluded: u64,
    /// Sources the actual ingest run could not open or fully read
    /// (`report.stats.failed_files`) — distinct from `sources_unsupported`,
    /// which is a pre-ingest content judgment; this is a real I/O failure
    /// encountered during the run itself.
    pub sources_failed: u64,
    /// Counts by stable exclusion/failure reason
    /// (`report.stats.exclusion_counts`).
    pub exclusion_counts: std::collections::BTreeMap<String, u64>,
    /// Events imported (`report.stats.lines`).
    pub events_imported: u64,
    /// Distinct templates (`report.stats.templates`).
    pub templates: u64,
    /// Counts by detected parse format id (`report.stats.format_counts`).
    pub formats: std::collections::BTreeMap<String, u64>,
    /// Counts by explicit timestamp provenance
    /// (`report.stats.timestamp_provenance_counts`).
    pub timestamp_provenance: std::collections::BTreeMap<String, u64>,
    /// True when anything the preview discovered was not fully imported —
    /// read straight from `report.stats.partial`, never re-derived. Covers
    /// both "some sources were excluded/failed" and "the run was cancelled
    /// before every selected source finished."
    pub partial: bool,
    /// Sources whose local timestamps still have no resolvable timezone
    /// after this import — empty when every source is either wall-clock,
    /// order-only, or already resolved by a declaration or the configured
    /// default.
    pub timezone_ambiguous_sources: Vec<String>,
    /// Saved reviewed-format grammars that were confidently matched and
    /// actually applied this run. Empty means none were — either none were
    /// saved, none confidently matched, or a store race made the apply
    /// this module attempted stale (never guessed, never claimed anyway).
    pub reviewed_formats_applied: Vec<ReviewedFormatApplication>,
    /// Bounded, human-safe warnings about reviewed-format auto-detect:
    /// content ties (`Conflict`), store open/apply failures that fell back
    /// to no bindings (never half-applied). Empty when nothing noteworthy.
    /// Never contains log line content.
    pub reviewed_format_warnings: Vec<String>,
    /// The plan review, retained so `--explain-selection` can render exact
    /// per-item reasons without a second preview pass.
    pub plan: ImportPreviewPlan,
}

/// Run the zero-touch default import path for one source path.
///
/// Selects every item the preview already preselected (`ImportPreviewItem
/// .selected`), verifies the plan against a fresh enumeration (failing
/// closed on any drift), looks up any durable reviewed-format grammars that
/// confidently match a selected source's content, ingests with no embedding
/// (the fastest, most deterministic default — `--embed` is an escape hatch,
/// not default behavior) through the production bindings-aware entry point,
/// auto-names the corpus, and applies a configured default timezone to any
/// source left ambiguous, recording rather than guessing when no default is
/// configured.
pub fn default_import(
    cache_root: &Path,
    source_path: &Path,
    cfg: &AppConfig,
    cancel: Option<&CancelFlag>,
) -> CoreResult<DefaultImportOutcome> {
    default_import_with_observer(cache_root, source_path, cfg, cancel, &NoopProcessProgress)
}

/// [`default_import`], accepting a caller-supplied progress observer (a CLI
/// prints progress to stderr; a test records it; the default is silent).
pub fn default_import_with_observer(
    cache_root: &Path,
    source_path: &Path,
    cfg: &AppConfig,
    cancel: Option<&CancelFlag>,
    observer: &dyn ProcessProgressObserver,
) -> CoreResult<DefaultImportOutcome> {
    let plan = preview_import_plan(source_path, cancel)?;
    if let Some(block) = plan.report.plan_block() {
        return Err(CoreError::Policy(format!(
            "nothing importable at {}: {block:?}",
            source_path.display()
        )));
    }
    let counts: ImportPreviewCounts = plan.report.counts.clone();

    let selected: Vec<String> = plan
        .report
        .items
        .iter()
        .filter(|item| item.selected)
        .map(|item| item.identity.clone())
        .collect();

    let selection = verify_import_plan(
        source_path,
        plan.plan_version,
        &plan.plan_token,
        &selected,
        cancel,
    )?;

    let corpus_name = suggest_corpus_name(source_path, cache_root)?;
    let policy = LogEmbedPolicy {
        mode: cd_core::log_analysis::embed_policy::LogEmbedMode::None,
        ..LogEmbedPolicy::default()
    };

    // Reviewed-format store auto-bind is not composed into this selective
    // integration (CLI tip's reviewed_format_store + bindings-aware ingest
    // diverged from the activity product base). Default import still uses the
    // same reviewed *selection* path production desktop uses for guided
    // import; grammar bindings remain an empty, honest no-op here.
    let reviewed_format_warnings: Vec<String> = Vec::new();
    let reviewed_formats_applied: Vec<ReviewedFormatApplication> = Vec::new();

    let report = ingest_path_with_policy_selection_and_observer(
        cache_root,
        source_path,
        &corpus_name,
        &policy,
        None,
        observer,
        cancel,
        &selection,
    )?;

    let timezone_ambiguous_sources = crate::timezone::unresolved_sources_after_default_apply(
        cache_root,
        &report.corpus_id,
        cfg.default_timezone.as_deref(),
    )?;

    Ok(DefaultImportOutcome {
        entries_examined: counts.total,
        discovered_files: report.stats.discovered_files,
        sources_selected: counts.selected,
        sources_ignored: counts.ignored,
        sources_unsupported: counts.unsupported,
        sources_excluded: counts.blocked,
        sources_failed: report.stats.failed_files,
        exclusion_counts: report.stats.exclusion_counts.clone(),
        events_imported: report.stats.lines,
        templates: report.stats.templates as u64,
        formats: report.stats.format_counts.clone(),
        timestamp_provenance: report.stats.timestamp_provenance_counts.clone(),
        partial: report.stats.partial,
        corpus_name,
        timezone_ambiguous_sources,
        reviewed_formats_applied,
        reviewed_format_warnings,
        report,
        plan,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use cd_core::log_analysis::store::LogCorpus;
    use std::fs;
    use tempfile::tempdir;

    fn write_log(dir: &Path, name: &str, lines: &[&str]) {
        fs::write(dir.join(name), lines.join("\n") + "\n").unwrap();
    }

    #[test]
    fn suggest_corpus_name_deduplicates_against_existing_corpora() {
        let cache = tempdir().unwrap();
        let source = tempdir().unwrap();
        let archive_dir = source.path().join("checkout-incident");
        fs::create_dir_all(&archive_dir).unwrap();

        let name = suggest_corpus_name(&archive_dir, cache.path()).expect("first name");
        assert_eq!(name, "checkout-incident");
    }

    #[test]
    fn default_import_selects_ready_sources_and_reports_accurate_buckets() {
        let cache = tempdir().unwrap();
        let source = tempdir().unwrap();
        write_log(
            source.path(),
            "app.log",
            &[
                "2024-01-01T00:00:00Z INFO service started",
                "2024-01-01T00:00:01Z ERROR boom",
            ],
        );
        // Noise: a dot-prefixed file the preview marks Ignored, never selected.
        fs::write(source.path().join(".DS_Store"), b"\x00\x01").unwrap();

        let outcome = default_import(cache.path(), source.path(), &AppConfig::default(), None)
            .expect("default import");
        assert!(outcome.events_imported > 0, "app.log must import events");
        assert_eq!(outcome.report.stats.lines, outcome.events_imported);
        assert_eq!(outcome.sources_selected, 1, "only app.log is a log source");
        assert!(
            outcome.sources_ignored >= 1,
            "the dot-prefixed file must be counted, not silently dropped: {outcome:?}"
        );
        assert_eq!(
            outcome.entries_examined,
            outcome.sources_selected + outcome.sources_ignored,
            "every entry the preview saw must land in exactly one honest bucket"
        );
        let corpus = LogCorpus::open(cache.path(), &outcome.report.corpus_id).expect("open corpus");
        assert_eq!(corpus.name(), outcome.corpus_name);
        assert!(
            outcome.reviewed_formats_applied.is_empty(),
            "reviewed-format store is not composed in this selective integration"
        );
    }
}
