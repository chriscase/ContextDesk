//! Default-path import: reuse the production recommendation engine to reach
//! an explorable corpus from a bare `contextdesk import <archive>`.
//!
//! Nothing here reimplements format detection, source grouping, raw
//! fallback, or noise exclusion — every one of those decisions is already
//! made deterministically by [`cd_core::log_analysis::import_preview`], the
//! single guided import entry point every host (desktop, server, or a
//! third-party SDK consumer) is meant to share. This module's job is
//! strictly the plumbing around that engine: accept its preselection as the
//! default selection, verify the plan, ingest it, and — the one genuinely
//! new piece, since no host has ever needed it before — name the resulting
//! corpus and aggregate any timezone ambiguity into at most one question.

use cd_core::config::AppConfig;
use cd_core::error::{CoreError, CoreResult};
use cd_core::log_analysis::embed_policy::LogEmbedPolicy;
use cd_core::log_analysis::import_preview::{
    event_importable, preview_import_plan, verify_import_plan, ImportPreviewPlan,
};
use cd_core::log_analysis::ingest::{ingest_path_with_policy_selection_and_observer, IngestReport};
use cd_core::log_analysis::store::LogCorpus;
use cd_core::log_analysis::timezone_application::{
    apply_source_timezones_with_basis, load_timezone_resolution_state, preview_source_timezone,
    SourceTimezoneApplyRequest,
};
use cd_core::log_analysis::timezone_resolution::TimezoneDeclarationBasis;
use cd_core::process_progress::{CancelFlag, NoopProcessProgress, ProcessProgressObserver};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

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

/// A concise, machine-readable summary of one default import — the data
/// behind the terse default output. `--explain-selection` renders the
/// underlying [`cd_core::log_analysis::import_preview::ImportPreviewReport`]
/// directly instead; this struct is not a substitute for it, only the
/// concise view.
#[derive(Debug, Clone)]
pub struct DefaultImportOutcome {
    /// The corpus produced.
    pub report: IngestReport,
    /// The name assigned (see [`suggest_corpus_name`]).
    pub corpus_name: String,
    /// Items the preview considered but did not select (noise, unsupported,
    /// blocked, or review-only content the default path never guesses at).
    pub excluded_count: u64,
    /// Sources whose local timestamps still have no resolvable timezone
    /// after this import — empty when every source is either wall-clock,
    /// order-only, or already resolved by a declaration or the configured
    /// default.
    pub timezone_ambiguous_sources: Vec<String>,
    /// The plan review, retained so `--explain-selection` can render exact
    /// per-item reasons without a second preview pass.
    pub plan: ImportPreviewPlan,
}

/// Run the zero-touch default import path for one source path.
///
/// Selects every item the preview already preselected (`ImportPreviewItem
/// .selected`), verifies the plan against a fresh enumeration (failing
/// closed on any drift), ingests with no embedding (the fastest, most
/// deterministic default — `--embed` is an escape hatch, not default
/// behavior), auto-names the corpus, and applies a configured default
/// timezone to any source left ambiguous, recording rather than guessing
/// when no default is configured.
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

    let selected: Vec<String> = plan
        .report
        .items
        .iter()
        .filter(|item| item.selected)
        .map(|item| item.identity.clone())
        .collect();
    let excluded_count = plan
        .report
        .items
        .iter()
        .filter(|item| event_importable(item) && !item.selected)
        .count() as u64;

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

    let timezone_ambiguous_sources = aggregate_timezone(
        cache_root,
        &report.corpus_id,
        cfg.default_timezone.as_deref(),
    )?;

    Ok(DefaultImportOutcome {
        report,
        corpus_name,
        excluded_count,
        timezone_ambiguous_sources,
        plan,
    })
}

/// After ingest: apply the configured default timezone (with provenance) to
/// every source that has local-timestamp evidence but no resolvable zone,
/// in ONE call. Returns the sources still ambiguous — empty when a default
/// was configured and applied, or when nothing was ambiguous to begin with.
/// Never prompts per-file; the caller decides what, if anything, to ask
/// given the returned list.
fn aggregate_timezone(
    cache_root: &Path,
    corpus_id: &str,
    default_timezone: Option<&str>,
) -> CoreResult<Vec<String>> {
    let state = load_timezone_resolution_state(cache_root, corpus_id)?;
    let ambiguous: Vec<String> = state
        .sources
        .iter()
        .filter(|source| source.unresolved_local_records > 0)
        .map(|source| source.source.clone())
        .collect();
    if ambiguous.is_empty() {
        return Ok(Vec::new());
    }
    let Some(zone) = default_timezone else {
        return Ok(ambiguous);
    };
    let expected_revision = state.scope.event_revision;
    let mut requests = Vec::with_capacity(ambiguous.len());
    for source in &ambiguous {
        let preview =
            preview_source_timezone(cache_root, corpus_id, expected_revision, source, zone)?;
        requests.push(SourceTimezoneApplyRequest {
            source: source.clone(),
            iana_timezone: zone.to_string(),
            preview_token: preview.declaration_fingerprint,
        });
    }
    let declared_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0);
    apply_source_timezones_with_basis(
        cache_root,
        corpus_id,
        expected_revision,
        &requests,
        declared_at,
        TimezoneDeclarationBasis::ConfiguredDefault,
    )?;
    Ok(Vec::new())
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
    fn default_import_selects_ready_sources_and_excludes_noise() {
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
        assert!(outcome.report.stats.lines > 0, "app.log must import events");
        let corpus = LogCorpus::open(cache.path(), &outcome.report.corpus_id).expect("open corpus");
        assert_eq!(corpus.name(), outcome.corpus_name);
    }
}
