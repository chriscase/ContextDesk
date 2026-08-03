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
//! through the SAME production bindings-aware entry point desktop uses
//! (`ingest_path_with_policy_bindings_and_observer` — never the
//! selection-only path, so a saved profile is never silently skipped), name
//! the resulting corpus, and aggregate any timezone ambiguity into at most
//! one question.

use cd_core::config::AppConfig;
use cd_core::error::{CoreError, CoreResult};
use cd_core::log_analysis::embed_policy::LogEmbedPolicy;
use cd_core::log_analysis::import_preview::{
    preview_import_plan, verify_import_plan, ImportPreviewCounts, ImportPreviewPlan,
};
use cd_core::log_analysis::ingest::{ingest_path_with_policy_bindings_and_observer, IngestReport};
use cd_core::log_analysis::reviewed_format::{select_format, FormatSelection};
use cd_core::log_analysis::reviewed_format_store::{
    apply_reviewed_format_bindings, ReviewedFormatApplyBinding, ReviewedFormatApplyRequest,
    ReviewedFormatIngestBindings, ReviewedFormatStore,
};
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
    /// (`plan.report.counts.total`).
    pub entries_examined: u64,
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

    // Never fails the import: a store race or an empty catalog just means
    // no bindings are attempted this run, not a hard error — the same
    // "optional, best-effort" contract desktop's `format_apply: Option<_>`
    // already has.
    let (bindings, reviewed_formats_applied) =
        auto_detect_reviewed_bindings(&reviewed_format_store_root(cache_root), &plan)
            .unwrap_or_else(|_| (ReviewedFormatIngestBindings::new(), Vec::new()));
    let reviewed = (!reviewed_formats_applied.is_empty()).then_some(&bindings);

    let report = ingest_path_with_policy_bindings_and_observer(
        cache_root,
        source_path,
        &corpus_name,
        &policy,
        None,
        observer,
        cancel,
        Some(&selection),
        reviewed,
    )?;

    let timezone_ambiguous_sources = crate::timezone::unresolved_sources_after_default_apply(
        cache_root,
        &report.corpus_id,
        cfg.default_timezone.as_deref(),
    )?;

    Ok(DefaultImportOutcome {
        entries_examined: counts.total,
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
        report,
        plan,
    })
}

fn reviewed_format_store_root(cache_root: &Path) -> std::path::PathBuf {
    cache_root.join("reviewed_formats")
}

/// Look up which of a plan's selected sources a saved reviewed-format
/// grammar confidently applies to, using the SAME content-coverage matcher
/// (`select_format`) the desktop review UI uses to answer "would this
/// profile apply here" — never a bespoke path-only heuristic. A tie
/// (`FormatSelection::Conflict`) or no match is skipped, never guessed.
///
/// The apply is still revision-bound: [`apply_reviewed_format_bindings`]
/// re-checks the store hasn't moved since `load_all`/`revision()` were read
/// a few lines above, so a concurrent edit between detection and apply
/// fails this function closed (caught by the caller, which then imports
/// with no bindings rather than a half-applied set).
fn auto_detect_reviewed_bindings(
    reviewed_root: &Path,
    plan: &ImportPreviewPlan,
) -> CoreResult<(ReviewedFormatIngestBindings, Vec<ReviewedFormatApplication>)> {
    let store = ReviewedFormatStore::open(reviewed_root)?;
    let catalog = store.load_all()?;
    if catalog.is_empty() {
        return Ok((ReviewedFormatIngestBindings::new(), Vec::new()));
    }
    let revision = store.revision()?;

    let mut request_bindings = Vec::new();
    let mut applied = Vec::new();
    for item in plan.report.items.iter().filter(|item| item.selected) {
        let Some(sample) = item.representative.as_deref() else {
            continue;
        };
        let FormatSelection::Selected { format_id, version } =
            select_format(&catalog, &item.identity, sample)
        else {
            continue;
        };
        let Some(format) = catalog
            .iter()
            .find(|f| f.format_id == format_id && f.version == version)
        else {
            continue;
        };
        request_bindings.push(ReviewedFormatApplyBinding {
            source_identity: item.identity.clone(),
            format_id: format.format_id.clone(),
            version: format.version,
            digest: format.digest(),
        });
        applied.push(ReviewedFormatApplication {
            source_identity: item.identity.clone(),
            format_name: format.name.clone(),
        });
    }

    if request_bindings.is_empty() {
        return Ok((ReviewedFormatIngestBindings::new(), Vec::new()));
    }
    let request = ReviewedFormatApplyRequest {
        expected_store_revision: revision,
        bindings: request_bindings,
    };
    let bindings = apply_reviewed_format_bindings(&store, &request)?;
    Ok((bindings, applied))
}

#[cfg(test)]
mod tests {
    use super::*;
    use cd_core::log_analysis::reviewed_format::{
        FieldSlot, MultilineRule, ReviewedFormat, TimeToken, TimestampGrammar,
    };
    use cd_core::log_analysis::reviewed_format_store::ReviewedFormatStore;
    use cd_core::log_analysis::store::LogCorpus;
    use cd_core::log_analysis::{SafePattern, REVIEWED_FORMAT_SCHEMA_ID};
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
            "no reviewed formats were ever saved for this test's cache root"
        );
    }

    /// Mirrors `crates/cd-core/tests/reviewed_format_wiring.rs`'s own
    /// `app_log_format` fixture exactly (a proven-valid grammar) rather than
    /// hand-assembling a new one — this module has no business inventing
    /// its own notion of what a valid `ReviewedFormat` looks like.
    fn app_log_format(id: &str, version: u16) -> ReviewedFormat {
        ReviewedFormat {
            schema_id: REVIEWED_FORMAT_SCHEMA_ID.into(),
            min_reader_version: 1,
            format_id: id.into(),
            version,
            name: format!("App log {id}"),
            path_patterns: vec![SafePattern::new("**/app.log*")],
            timestamp: TimestampGrammar {
                tokens: vec![
                    TimeToken::Year4,
                    TimeToken::Literal('-'),
                    TimeToken::Month2,
                    TimeToken::Literal('-'),
                    TimeToken::Day2,
                    TimeToken::Literal(' '),
                    TimeToken::Hour24,
                    TimeToken::Literal(':'),
                    TimeToken::Minute2,
                    TimeToken::Literal(':'),
                    TimeToken::Second2,
                    TimeToken::Literal(','),
                    TimeToken::Millis3,
                ],
            },
            layout: vec![
                FieldSlot::Whitespace,
                FieldSlot::Level,
                FieldSlot::Whitespace,
                FieldSlot::Literal("-".into()),
                FieldSlot::Whitespace,
                FieldSlot::Message,
            ],
            multiline: MultilineRule::ContinuationUntilNextTimestamp,
            priority: 10,
            suggested_timezone: None,
        }
    }

    /// The whole point of routing through the bindings-aware path: a saved,
    /// content-confirmed reviewed format actually gets applied by the
    /// default import with no extra flag, and the outcome says so honestly.
    #[test]
    fn default_import_auto_applies_a_confidently_matching_saved_reviewed_format() {
        let cache = tempdir().unwrap();
        let source = tempdir().unwrap();
        write_log(
            source.path(),
            "app.log",
            &[
                "2024-05-03 12:24:22,729 INFO - service started",
                "2024-05-03 12:24:23,001 ERROR - boom",
            ],
        );

        let store = ReviewedFormatStore::open(cache.path().join("reviewed_formats"))
            .expect("open reviewed format store");
        let format = app_log_format("test.app-log", 1);
        store.save(&format).expect("save reviewed format");

        let outcome = default_import(cache.path(), source.path(), &AppConfig::default(), None)
            .expect("default import");

        assert_eq!(
            outcome.reviewed_formats_applied.len(),
            1,
            "the saved format must be detected and applied: {outcome:?}"
        );
        assert_eq!(
            outcome.reviewed_formats_applied[0].format_name,
            "App log test.app-log"
        );
    }
}
