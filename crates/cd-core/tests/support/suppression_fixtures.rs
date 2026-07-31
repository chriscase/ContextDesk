//! Deterministic test-support fixture packages for #819 states that cannot be
//! produced through the shipped UI.
//!
//! Re-analysis in the shipped product does not reparse events, so template
//! identity never moves and a stale rule is unreachable by ordinary use. These
//! generators build each state out of *production* material only — a real
//! corpus, production suppression structs, production serde, the real
//! `export_corpus_zip` writer — and emit a portable
//! `contextdesk.log_corpus.v1` package that the normal release importer accepts
//! and re-resolves from scratch.
//!
//! Two shapes are used, and the difference matters:
//!
//! - [`fingerprint_changed_package`] drives the real preview→confirm activation
//!   path, then moves template identity underneath the rule.
//! - [`target_missing_package`] and [`conflicting_predicates_package`] author
//!   the durable `suppression.json` sidecar directly, because no production
//!   write path can reach those states (see the coverage note below). The
//!   sidecar is still built from production structs and written with production
//!   serde, so every bound in `validate_document` still applies: an
//!   out-of-policy fixture is rejected by the loader that `export_corpus_zip`
//!   runs, not silently packaged.
//!
//! Safety properties:
//! - **Test-only.** Compiled only into integration tests under `tests/support`.
//!   Nothing here is reachable from a release binary and no seeding command is
//!   exposed to the app.
//! - **No weakened validation.** Nothing here bypasses, relaxes, or re-implements
//!   a production check. The historical sidecars are read back through the
//!   ordinary loader, which validates them like any user's sidecar.
//! - **Unmistakable.** Corpora are named with [`FIXTURE_CORPUS_PREFIX`] and
//!   rules with [`FIXTURE_RULE_PREFIX`], so a fixture cannot be confused with a
//!   user corpus in a listing or a diagnostic.
//! - **Disposable.** Callers pass a temp cache root; nothing is written outside
//!   it and no user profile is touched.
//! - **Deterministic.** Fixed timestamps, template text, and rule names. Only
//!   UUIDv7 identities vary and no assertion depends on them.
//! - **Bounded.** One event and one template row per corpus; at most two rules.
//!
//! Coverage note, stated honestly:
//! - `stale_fingerprint_changed` is reachable through production write paths and
//!   is generated that way.
//! - `stale_target_missing` and `conflicting_predicate` are **not** reachable
//!   through the shipped UI: re-analysis does not reparse events (so a rule's
//!   target never disappears), `LogCorpus` exposes no template removal, and
//!   activation refuses a duplicate predicate outright. They are therefore
//!   modelled as historical durable state — exactly what an older corpus on
//!   disk would hold — and proven end-to-end through the ordinary importer.
//! - `legacy unbound finding` is still uncovered here; investigations are not
//!   carried in a corpus package and need a separate schema-3
//!   `InvestigationStore` fixture.

use cd_core::error::CoreResult;
use cd_core::log_analysis::{
    activate_template_suppression, export_corpus_zip, load_suppression_document,
    preview_template_suppression, ActivateSuppressionPreview, ActiveTimestampBasis, LogCorpus,
    LogEvent, NewSuppressionPreview, SuppressionAuditAction, SuppressionAuditEntry,
    SuppressionDocument, SuppressionRule, SuppressionRuleOrigin, SuppressionRuleState,
    SuppressionTemplatePredicate, TemplateInfo, TemplateRow, TimestampProvenance,
    SUPPRESSION_SCHEMA_VERSION,
};
use std::path::{Path, PathBuf};
use uuid::Uuid;

/// Every fixture corpus name starts with this, so it is obvious in any listing.
pub const FIXTURE_CORPUS_PREFIX: &str = "TEST-FIXTURE";
/// Every fixture rule name starts with this.
pub const FIXTURE_RULE_PREFIX: &str = "test-fixture";

/// Durable suppression sidecar name, mirroring `suppression.rs`.
///
/// The production constant is private; the loader that validates what we write
/// is not, so a rename would fail this fixture loudly at export.
const SIDECAR_FILENAME: &str = "suppression.json";

const ROUTINE_TEMPLATE_ID: u64 = 7;
/// The only template id present in the target-missing corpus.
const SURVIVING_TEMPLATE_ID: u64 = 8;
const FIXED_TS: i64 = 1_700_000_000;

/// One generated package plus the facts a test asserts against it.
pub struct FixturePackage {
    /// Absolute path to the written `contextdesk.log_corpus.v1` zip.
    pub path: PathBuf,
    /// Rule names the package is expected to contain, in durable order.
    pub rule_names: Vec<String>,
}

fn template(template_id: u64, pattern: &str, content_hash: &str) -> TemplateRow {
    TemplateRow {
        info: TemplateInfo {
            template_id,
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

fn fixture_event(template_id: u64) -> LogEvent {
    LogEvent {
        seq: 1,
        ts: FIXED_TS,
        timestamp_provenance: TimestampProvenance::ExplicitWallClock,
        active_timestamp_basis: ActiveTimestampBasis::ExplicitWall,
        unresolved_local_timestamp: None,
        level: "info".into(),
        service: Some("fixture".into()),
        host: Some("fixture-host".into()),
        template_id,
        params: vec!["value".into()],
        trace_id: None,
        message: "routine health ok".into(),
        source: "fixture/app.log".into(),
    }
}

/// Build one durable rule exactly as a past activation would have persisted it.
///
/// `resolution` is deliberately `None`: it is ephemeral, is never serialized,
/// and must be re-derived by whichever machine opens the corpus.
fn historical_rule(
    name: &str,
    rationale: &str,
    template_id: u64,
    template_fingerprint: &str,
) -> SuppressionRule {
    SuppressionRule {
        id: Uuid::now_v7().to_string(),
        name: name.to_string(),
        rationale: rationale.to_string(),
        predicate: SuppressionTemplatePredicate {
            template_id,
            template_fingerprint: template_fingerprint.to_string(),
        },
        origin: SuppressionRuleOrigin::Human,
        state: SuppressionRuleState::Enabled,
        created_at: FIXED_TS,
        updated_at: FIXED_TS,
        resolution: None,
    }
}

fn audit_entry(
    revision: u64,
    action: SuppressionAuditAction,
    rule_id: Option<&str>,
    preview_token: Option<&str>,
) -> SuppressionAuditEntry {
    SuppressionAuditEntry {
        id: Uuid::now_v7().to_string(),
        revision,
        action,
        rule_id: rule_id.map(str::to_string),
        preview_token: preview_token.map(str::to_string),
        created_at: FIXED_TS,
    }
}

/// Persist a historical suppression sidecar for `corpus`.
///
/// Each rule gets the audit pair a real preview→activate cycle would have
/// written, with strictly increasing published revisions. The document is
/// serialized by production serde from production structs, so the ephemeral
/// `resolution` / `resolvedTemplateRevision` fields are skipped and the
/// importer has nothing to trust.
fn write_historical_document(corpus: &LogCorpus, rules: Vec<SuppressionRule>) -> CoreResult<()> {
    let mut audit = Vec::with_capacity(rules.len() * 2);
    let mut revision = 0u64;
    for rule in &rules {
        revision += 1;
        audit.push(audit_entry(
            revision,
            SuppressionAuditAction::Previewed,
            None,
            Some(&Uuid::now_v7().to_string()),
        ));
        revision += 1;
        audit.push(audit_entry(
            revision,
            SuppressionAuditAction::Activated,
            Some(&rule.id),
            None,
        ));
    }

    let document = SuppressionDocument {
        schema_version: SUPPRESSION_SCHEMA_VERSION,
        corpus_id: corpus.id().to_string(),
        revision,
        rules,
        // A preview is live, corpus-bound authority; historical state carries none.
        previews: Vec::new(),
        audit,
        resolved_template_revision: None,
    };
    let bytes = serde_json::to_vec_pretty(&document)?;
    let text = String::from_utf8_lossy(&bytes);
    assert!(
        !text.contains("\"resolution\"") && !text.contains("\"resolvedTemplateRevision\""),
        "ephemeral resolution must never be written to the durable sidecar"
    );
    std::fs::write(corpus.root().join(SIDECAR_FILENAME), bytes)?;
    Ok(())
}

/// Flush, close, and export `corpus` to `out_path`.
///
/// Flushing first is required: the writer reads `templates.json` and
/// `events.duckdb` from disk, so unflushed template identity would silently
/// export as a *different* resolution. The handle is dropped before export
/// because Windows exclusive-locks the DuckDB file while it is open.
fn flush_and_export(
    corpus: LogCorpus,
    cache_root: &Path,
    out_path: PathBuf,
) -> CoreResult<PathBuf> {
    corpus.flush()?;
    let corpus_id = corpus.id().to_string();
    drop(corpus);
    export_corpus_zip(cache_root, &corpus_id, &out_path)?;
    Ok(out_path)
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
    corpus.push_events(&[fixture_event(ROUTINE_TEMPLATE_ID)])?;
    corpus.upsert_templates([template(
        ROUTINE_TEMPLATE_ID,
        "routine health <*>",
        "sha256:fixture-routine",
    )])?;

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
        ROUTINE_TEMPLATE_ID,
        "different evidence <*>",
        "sha256:fixture-different",
    )])?;

    let path = flush_and_export(
        corpus,
        cache_root,
        out_dir.join("fixture-fingerprint-changed.zip"),
    )?;
    Ok(FixturePackage {
        path,
        rule_names: vec![rule_name],
    })
}

/// Build a corpus whose catalog holds only [`SURVIVING_TEMPLATE_ID`], plus a
/// historical enabled rule whose target [`ROUTINE_TEMPLATE_ID`] is absent.
///
/// The shipped product cannot produce this: `LogCorpus` exposes only
/// `upsert_templates`, so a live rule's target can never be removed. The rule,
/// its identity, rationale, lifecycle, and audit history are exactly what an
/// older corpus would carry forward, and the importer must re-derive
/// `stale_target_missing` for itself.
pub fn target_missing_package(cache_root: &Path, out_dir: &Path) -> CoreResult<FixturePackage> {
    let corpus = LogCorpus::create(
        cache_root,
        format!("{FIXTURE_CORPUS_PREFIX} target-missing"),
    )?;
    corpus.push_events(&[fixture_event(SURVIVING_TEMPLATE_ID)])?;
    corpus.upsert_templates([template(
        SURVIVING_TEMPLATE_ID,
        "routine health <*>",
        "sha256:fixture-surviving",
    )])?;

    let rule_name = format!("{FIXTURE_RULE_PREFIX}-target-missing");
    write_historical_document(
        &corpus,
        vec![historical_rule(
            &rule_name,
            "Deterministic #819 fixture; the reviewed template no longer exists.",
            ROUTINE_TEMPLATE_ID,
            "sha256:fixture-retired",
        )],
    )?;

    let path = flush_and_export(
        corpus,
        cache_root,
        out_dir.join("fixture-target-missing.zip"),
    )?;
    Ok(FixturePackage {
        path,
        rule_names: vec![rule_name],
    })
}

/// Build a corpus holding [`ROUTINE_TEMPLATE_ID`] plus two historical enabled
/// rules that both claim it.
///
/// Both predicates carry the corpus's real template fingerprint, so each rule
/// would otherwise resolve `matches_current`; only their collision makes them
/// inert. The shipped product cannot produce this either: activation rejects a
/// second rule on an owned predicate ("an active or disabled rule already owns
/// this exact template predicate"), which the integration test re-proves
/// against the imported corpus.
pub fn conflicting_predicates_package(
    cache_root: &Path,
    out_dir: &Path,
) -> CoreResult<FixturePackage> {
    const CONFLICTED_FINGERPRINT: &str = "sha256:fixture-conflicted";

    let corpus = LogCorpus::create(
        cache_root,
        format!("{FIXTURE_CORPUS_PREFIX} conflicting-predicates"),
    )?;
    corpus.push_events(&[fixture_event(ROUTINE_TEMPLATE_ID)])?;
    corpus.upsert_templates([template(
        ROUTINE_TEMPLATE_ID,
        "routine health <*>",
        CONFLICTED_FINGERPRINT,
    )])?;

    let first_name = format!("{FIXTURE_RULE_PREFIX}-conflicting-first");
    let second_name = format!("{FIXTURE_RULE_PREFIX}-conflicting-second");
    write_historical_document(
        &corpus,
        vec![
            historical_rule(
                &first_name,
                "Deterministic #819 fixture; first reviewer suppressed this template.",
                ROUTINE_TEMPLATE_ID,
                CONFLICTED_FINGERPRINT,
            ),
            historical_rule(
                &second_name,
                "Deterministic #819 fixture; a second rule claims the same template.",
                ROUTINE_TEMPLATE_ID,
                CONFLICTED_FINGERPRINT,
            ),
        ],
    )?;

    let path = flush_and_export(
        corpus,
        cache_root,
        out_dir.join("fixture-conflicting-predicates.zip"),
    )?;
    Ok(FixturePackage {
        path,
        rule_names: vec![first_name, second_name],
    })
}
