//! #819 — the normal release importer must accept a deterministic fixture
//! package and re-derive trusted resolution from scratch.
//!
//! ## Coverage, stated honestly
//!
//! Only `stale_fingerprint_changed` is reachable through production write
//! paths, so it is the only state proven end-to-end here. The others are
//! blocked by production behaviour, not by omission:
//!
//! - **target missing** — `LogCorpus` exposes only `upsert_templates`; there is
//!   no removal, so a rule's target cannot be made to disappear through any
//!   production path. Producing it needs either a bounded template-removal
//!   capability in core or a package writer that can omit a template.
//! - **conflicting predicates** — activation rejects a duplicate predicate
//!   outright (`suppression.rs`: "an active or disabled rule already owns this
//!   exact template predicate"), so two enabled rules can never claim one id
//!   through the product. Producing it needs a package whose `suppression.json`
//!   is authored directly, which in turn needs `zip` as a dev-dependency.
//! - **legacy unbound finding** — investigations are not carried in a corpus
//!   package, so this needs a separate schema-3 `InvestigationStore` fixture.
//! - **invalid predicate** — remains automated-only by design: production
//!   validation rejects importing one, which is asserted in `suppression.rs`
//!   unit tests rather than through a package.

#[path = "support/suppression_fixtures.rs"]
mod suppression_fixtures;

use cd_core::log_analysis::{
    import_corpus_zip, load_suppression_document, LogCorpus, SuppressionRuleResolutionKind,
    SuppressionRuleState,
};
use suppression_fixtures::{fingerprint_changed_package, FIXTURE_RULE_PREFIX};

#[test]
fn importer_accepts_fixture_package_and_rederives_stale_resolution() {
    let source_cache = tempfile::tempdir().expect("source cache");
    let out_dir = tempfile::tempdir().expect("package out");
    let fixture = fingerprint_changed_package(source_cache.path(), out_dir.path())
        .expect("generate fixture package");

    // Import through the ordinary release path into a clean cache.
    let target_cache = tempfile::tempdir().expect("target cache");
    let bytes = std::fs::read(&fixture.path).expect("read package");
    let report = import_corpus_zip(target_cache.path(), &bytes).expect("import fixture package");

    let corpus = LogCorpus::open(target_cache.path(), &report.corpus_id).expect("open imported");
    let document = load_suppression_document(&corpus).expect("resolve imported policy");

    // The rule survives import, is still enabled, and is named unmistakably.
    assert_eq!(document.rules.len(), 1, "rule must survive the round trip");
    let rule = &document.rules[0];
    assert_eq!(rule.name, fixture.rule_name);
    assert!(rule.name.starts_with(FIXTURE_RULE_PREFIX));
    assert_eq!(rule.state, SuppressionRuleState::Enabled);
    assert!(
        !rule.rationale.is_empty(),
        "rationale is required evidence and must round-trip"
    );

    // Resolution is re-derived on the importing machine, not carried over.
    let resolution = rule.resolution.as_ref().expect("resolution re-derived");
    assert_eq!(
        resolution.kind,
        SuppressionRuleResolutionKind::StaleFingerprintChanged,
        "a reused template id must never be re-bound"
    );
    assert!(resolution.matches_nothing, "stale rules exclude nothing");

    // Zero exclusions: the lens must be empty for a stale rule.
    assert!(
        document.enabled_template_ids().expect("lens").is_empty(),
        "a stale rule must contribute no exclusions"
    );

    // Durable audit is retained across the package round trip.
    assert!(
        !document.audit.is_empty(),
        "audit history must survive import"
    );

    // Reopening (restart-equivalent) yields the same trusted resolution.
    drop(corpus);
    let reopened = LogCorpus::open(target_cache.path(), &report.corpus_id).expect("reopen");
    let again = load_suppression_document(&reopened).expect("resolve after reopen");
    assert_eq!(
        again.rules[0].resolution.as_ref().map(|r| r.kind),
        Some(SuppressionRuleResolutionKind::StaleFingerprintChanged),
        "resolution must be stable across reopen"
    );
    assert!(again.enabled_template_ids().expect("lens").is_empty());
}
