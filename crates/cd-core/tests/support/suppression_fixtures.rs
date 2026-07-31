//! Deterministic test-support fixture packages for #819 states that cannot be
//! produced through the shipped UI.
//!
//! Re-analysis in the shipped product does not reparse events, so template
//! identity never moves and a stale rule is unreachable by ordinary use. This
//! generator builds the state through *production* paths only — a real corpus,
//! the real preview→confirm activation path, and the real `export_corpus_zip`
//! writer — and emits a portable `contextdesk.log_corpus.v1` package that the
//! normal release importer accepts and re-resolves from scratch.
//!
//! Safety properties:
//! - **Test-only.** Compiled only into integration tests under `tests/support`.
//!   Nothing here is reachable from a release binary and no seeding command is
//!   exposed to the app.
//! - **Unmistakable.** Corpora are named with [`FIXTURE_CORPUS_PREFIX`] and
//!   rules with [`FIXTURE_RULE_PREFIX`], so a fixture cannot be confused with a
//!   user corpus in a listing or a diagnostic.
//! - **Disposable.** Callers pass a temp cache root; nothing is written outside
//!   it and no user profile is touched.
//! - **Deterministic.** Fixed timestamps, template text, and rule names. Only
//!   UUIDv7 identities vary and no assertion depends on them.
//! - **Bounded.** One event, two template rows, one rule.
//!
//! Coverage note, stated honestly: only `stale_fingerprint_changed` is
//! reachable through production write paths. See `COVERAGE.md` notes in the
//! integration test for why target-missing, conflicting-predicate, and
//! legacy-unbound are not, and what each would need.

use cd_core::error::CoreResult;
use cd_core::log_analysis::{
    activate_template_suppression, export_corpus_zip, load_suppression_document,
    preview_template_suppression, ActivateSuppressionPreview, ActiveTimestampBasis, LogCorpus,
    LogEvent, NewSuppressionPreview, SuppressionRuleOrigin, TemplateInfo, TemplateRow,
    TimestampProvenance,
};
use std::path::{Path, PathBuf};

/// Every fixture corpus name starts with this, so it is obvious in any listing.
pub const FIXTURE_CORPUS_PREFIX: &str = "TEST-FIXTURE";
/// Every fixture rule name starts with this.
pub const FIXTURE_RULE_PREFIX: &str = "test-fixture";

const ROUTINE_TEMPLATE_ID: u64 = 7;
const FIXED_TS: i64 = 1_700_000_000;

/// One generated package plus the facts a test asserts against it.
pub struct FixturePackage {
    /// Absolute path to the written `contextdesk.log_corpus.v1` zip.
    pub path: PathBuf,
    /// Rule name the package is expected to contain.
    pub rule_name: String,
}

fn template(pattern: &str, content_hash: &str) -> TemplateRow {
    TemplateRow {
        info: TemplateInfo {
            template_id: ROUTINE_TEMPLATE_ID,
            pattern: pattern.to_string(),
            token_count: 3,
            count: 1,
            first_seen: FIXED_TS,
            last_seen: FIXED_TS,
            severity: 1,
            example: pattern.to_string(),
        },
        content_hash: content_hash.to_string(),
        vector: None,
    }
}

/// Build a bounded deterministic corpus with one routine template and rule,
/// then move that template's identity so the rule resolves stale.
///
/// Every step uses a production path: create, push, upsert, preview, activate,
/// export.
pub fn fingerprint_changed_package(
    cache_root: &Path,
    out_dir: &Path,
) -> CoreResult<FixturePackage> {
    let corpus = LogCorpus::create(
        cache_root,
        format!("{FIXTURE_CORPUS_PREFIX} fingerprint-changed"),
    )?;
    corpus.push_events(&[LogEvent {
        seq: 1,
        ts: FIXED_TS,
        timestamp_provenance: TimestampProvenance::ExplicitWallClock,
        active_timestamp_basis: ActiveTimestampBasis::ExplicitWall,
        unresolved_local_timestamp: None,
        level: "info".into(),
        service: Some("fixture".into()),
        host: Some("fixture-host".into()),
        template_id: ROUTINE_TEMPLATE_ID,
        params: vec!["value".into()],
        trace_id: None,
        message: "routine health ok".into(),
        source: "fixture/app.log".into(),
    }])?;
    corpus.upsert_templates([template("routine health <*>", "sha256:fixture-routine")])?;

    let rule_name = format!("{FIXTURE_RULE_PREFIX}-fingerprint-changed");
    let revision = load_suppression_document(&corpus)?.revision;
    let preview = preview_template_suppression(
        &corpus,
        revision,
        NewSuppressionPreview {
            name: rule_name.clone(),
            rationale: "Deterministic #819 fixture; reviewed noise.".into(),
            template_id: ROUTINE_TEMPLATE_ID,
            origin: SuppressionRuleOrigin::Human,
        },
    )?;
    activate_template_suppression(
        &corpus,
        revision + 1,
        ActivateSuppressionPreview {
            preview_token: preview.token.clone(),
        },
    )?;

    // Same numeric id, different content: the rule must never be re-bound.
    corpus.upsert_templates([template(
        "different evidence <*>",
        "sha256:fixture-different",
    )])?;
    // Flush before export: the writer reads events.duckdb from disk, so
    // unflushed template identity would export as a missing target.
    corpus.flush()?;

    let corpus_id = corpus.id().to_string();
    // Drop the handle before export (Windows exclusive-locks events.duckdb).
    drop(corpus);
    let path = out_dir.join("fixture-fingerprint-changed.zip");
    export_corpus_zip(cache_root, &corpus_id, &path)?;
    Ok(FixturePackage { path, rule_name })
}
