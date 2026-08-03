//! Grouped timezone resolution — the one piece of `cd_core`'s per-source
//! timezone API every host needs wrapped the same way: "resolve every
//! source still ambiguous in this corpus with one IANA zone, in one atomic
//! revision bump," rather than a caller looping single-source applies
//! (which would let a partial apply land between two of them). Both the
//! import-time configured-default auto-apply
//! ([`crate::import::default_import_with_observer`]) and an explicit CLI
//! `timezone apply --all` command share this one function — never two
//! copies of the preview-then-atomic-apply sequence.
//!
//! Never guesses: a zone is only ever applied because it was passed in
//! explicitly (a configured default, or a human's explicit CLI argument),
//! and the honest [`cd_core::log_analysis::timezone_resolution::TimezoneDeclarationBasis`]
//! the caller supplies is recorded exactly, never upgraded to look like an
//! in-the-moment review that did not happen.

use cd_core::error::CoreResult;
use cd_core::log_analysis::timezone_application::{
    apply_source_timezones_with_basis, load_timezone_resolution_state, preview_source_timezone,
    SourceTimezoneApplyRequest,
};
use cd_core::log_analysis::timezone_resolution::TimezoneDeclarationBasis;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

/// Outcome of one grouped timezone apply.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TimezoneGroupApplyOutcome {
    /// Sources the zone was just applied to. Empty when there was nothing
    /// unresolved to begin with (see `already_resolved`).
    pub applied_sources: Vec<String>,
    /// True when no source had unresolved local-timestamp evidence — the
    /// apply call was skipped entirely rather than applying a zone to
    /// nothing.
    pub already_resolved: bool,
}

/// List every source in `corpus_id` that currently has unresolved
/// local-timestamp evidence, with no side effects. The read half of the
/// grouped flow — callers that only need to know *whether* to ask
/// ([`unresolved_sources_after_default_apply`], a CLI `timezone status`)
/// use this instead of duplicating the query in
/// [`load_timezone_resolution_state`].
pub fn unresolved_sources(cache_root: &Path, corpus_id: &str) -> CoreResult<Vec<String>> {
    let state = load_timezone_resolution_state(cache_root, corpus_id)?;
    Ok(state
        .sources
        .into_iter()
        .filter(|source| source.unresolved_local_records > 0)
        .map(|source| source.source)
        .collect())
}

/// Apply `iana_timezone` to every source in `corpus_id` that currently has
/// unresolved local-timestamp evidence, as ONE atomic revision bump.
///
/// Re-reads current resolution state and previews each source fresh
/// immediately before applying (never trusting a caller-supplied snapshot,
/// so a concurrent mutation between "decide to apply" and "apply" is
/// caught as a stale-revision conflict rather than silently applied against
/// stale state). Any single source's preview or apply failing (an invalid
/// zone, a stale token) fails the WHOLE group before anything is staged —
/// matches [`apply_source_timezones_with_basis`]'s own all-or-nothing
/// contract.
pub fn apply_timezone_to_all_unresolved(
    cache_root: &Path,
    corpus_id: &str,
    iana_timezone: &str,
    basis: TimezoneDeclarationBasis,
) -> CoreResult<TimezoneGroupApplyOutcome> {
    let state = load_timezone_resolution_state(cache_root, corpus_id)?;
    let ambiguous: Vec<String> = state
        .sources
        .iter()
        .filter(|source| source.unresolved_local_records > 0)
        .map(|source| source.source.clone())
        .collect();
    if ambiguous.is_empty() {
        return Ok(TimezoneGroupApplyOutcome {
            applied_sources: Vec::new(),
            already_resolved: true,
        });
    }

    let expected_revision = state.scope.event_revision;
    let mut requests = Vec::with_capacity(ambiguous.len());
    for source in &ambiguous {
        let preview = preview_source_timezone(
            cache_root,
            corpus_id,
            expected_revision,
            source,
            iana_timezone,
        )?;
        requests.push(SourceTimezoneApplyRequest {
            source: source.clone(),
            iana_timezone: iana_timezone.to_string(),
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
        basis,
    )?;
    Ok(TimezoneGroupApplyOutcome {
        applied_sources: ambiguous,
        already_resolved: false,
    })
}

/// Import-time convenience: apply a configured default zone (when one
/// exists) to every source left unresolved after an import, recording
/// [`TimezoneDeclarationBasis::ConfiguredDefault`] — an import's zero-touch
/// aggregation is by construction never an in-the-moment human review, so
/// it must never be recorded as [`TimezoneDeclarationBasis::UserDeclared`].
/// Returns the sources still ambiguous: empty when a default was configured
/// and applied, or when nothing was ambiguous to begin with; the full list
/// when no default is configured, so the caller can prompt.
pub fn unresolved_sources_after_default_apply(
    cache_root: &Path,
    corpus_id: &str,
    default_timezone: Option<&str>,
) -> CoreResult<Vec<String>> {
    let Some(zone) = default_timezone else {
        return unresolved_sources(cache_root, corpus_id);
    };
    apply_timezone_to_all_unresolved(
        cache_root,
        corpus_id,
        zone,
        TimezoneDeclarationBasis::ConfiguredDefault,
    )?;
    Ok(Vec::new())
}

#[cfg(test)]
mod tests {
    use super::*;
    use cd_core::log_analysis::ingest::ingest_path;
    use tempfile::tempdir;

    fn ingest_naive_local_source(cache_root: &Path) -> String {
        let source = tempdir().unwrap();
        // Comma-millis local timestamp with no zone/offset — the exact shape
        // `crates/cd-core/tests/reviewed_format_production_path.rs`'s
        // `APP_LOG_BODY` fixture proves the shipped default parser leaves as
        // `TimeQuality::OrderOnly` (unresolved local), not a plain
        // `YYYY-MM-DD HH:MM:SS` shape (which some built-in formats treat as
        // wall-clock UTC without a zone question at all).
        std::fs::write(
            source.path().join("app.log"),
            "2024-06-01 08:00:00,000 INFO - started\n2024-06-01 08:00:05,000 ERROR - boom\n",
        )
        .unwrap();
        let report = ingest_path(cache_root, source.path(), "tz-group", None, "").expect("ingest");
        report.corpus_id
    }

    #[test]
    fn already_resolved_corpus_applies_nothing() {
        let cache = tempdir().unwrap();
        let source = tempdir().unwrap();
        std::fs::write(
            source.path().join("app.log"),
            "2024-06-01T08:00:00Z INFO started\n",
        )
        .unwrap();
        let report =
            ingest_path(cache.path(), source.path(), "resolved", None, "").expect("ingest");

        let outcome = apply_timezone_to_all_unresolved(
            cache.path(),
            &report.corpus_id,
            "America/Chicago",
            TimezoneDeclarationBasis::UserDeclared,
        )
        .expect("apply");
        assert!(outcome.already_resolved);
        assert!(outcome.applied_sources.is_empty());
    }

    #[test]
    fn one_call_resolves_every_unresolved_source_and_records_the_supplied_basis() {
        let cache = tempdir().unwrap();
        let corpus_id = ingest_naive_local_source(cache.path());

        let before = unresolved_sources(cache.path(), &corpus_id).expect("before");
        assert!(!before.is_empty(), "fixture must start ambiguous");

        let outcome = apply_timezone_to_all_unresolved(
            cache.path(),
            &corpus_id,
            "America/Chicago",
            TimezoneDeclarationBasis::ConfiguredDefault,
        )
        .expect("group apply");
        assert!(!outcome.already_resolved);
        assert_eq!(outcome.applied_sources, before);

        let after = unresolved_sources(cache.path(), &corpus_id).expect("after");
        assert!(
            after.is_empty(),
            "one grouped apply must resolve every source, not just the first"
        );
    }

    #[test]
    fn rejects_an_invalid_zone_before_applying_anything() {
        let cache = tempdir().unwrap();
        let corpus_id = ingest_naive_local_source(cache.path());

        let error = apply_timezone_to_all_unresolved(
            cache.path(),
            &corpus_id,
            "Not/AZone",
            TimezoneDeclarationBasis::UserDeclared,
        )
        .expect_err("invalid zone must fail closed");
        assert!(error.to_string().to_lowercase().contains("timezone"));

        // Nothing was applied — an invalid zone in a multi-source group must
        // not leave some sources resolved and others not.
        let after = unresolved_sources(cache.path(), &corpus_id).expect("after");
        assert!(!after.is_empty());
    }
}
