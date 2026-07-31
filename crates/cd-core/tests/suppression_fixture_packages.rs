//! #819 — the normal release importer must accept a deterministic fixture
//! package and re-derive trusted resolution from scratch.
//!
//! ## Coverage, stated honestly
//!
//! Three of the four "matches nothing" states are now proven end-to-end through
//! the ordinary `import_corpus_zip` path. They differ in how the fixture is
//! produced, and the distinction is the honest part:
//!
//! - **stale fingerprint changed** — reachable through production write paths.
//!   The fixture drives the real preview→confirm activation and then moves
//!   template identity underneath the rule.
//! - **target missing** — *not* reachable through the shipped UI. Re-analysis
//!   does not reparse events, and `LogCorpus` exposes only `upsert_templates`,
//!   so a live rule's target can never be made to disappear. The fixture
//!   therefore models historical durable state: a `suppression.json` built from
//!   production structs and production serde, read back and validated by the
//!   ordinary loader. No validation is relaxed to make it import.
//! - **conflicting predicates** — also *not* reachable through the shipped UI.
//!   Activation rejects a duplicate predicate outright, which
//!   [`production_activation_still_rejects_duplicate_predicates`] re-proves
//!   against the imported fixture corpus, so two enabled rules can only exist
//!   as history, never as a new creation path.
//! - **legacy unbound finding** — still uncovered here: investigations are not
//!   carried in a corpus package, so this needs a separate schema-3
//!   `InvestigationStore` fixture.
//! - **invalid predicate** — remains automated-only by design: production
//!   validation rejects importing one, which is asserted in `suppression.rs`
//!   unit tests rather than through a package.
//!
//! In every case resolution is *re-derived* on the importing machine. The
//! durable sidecar carries no resolution at all, which each test asserts by
//! reading the imported corpus's `suppression.json` directly.

#[path = "support/suppression_fixtures.rs"]
mod suppression_fixtures;

use cd_core::log_analysis::{
    activate_template_suppression, import_corpus_zip, load_suppression_document,
    mutate_template_suppression_rule, preview_template_suppression, ActivateSuppressionPreview,
    LogCorpus, NewSuppressionPreview, SuppressionAuditAction, SuppressionDocument,
    SuppressionRuleMutation, SuppressionRuleOrigin, SuppressionRuleResolutionKind,
    SuppressionRuleState,
};
use suppression_fixtures::{
    conflicting_predicates_package, fingerprint_changed_package, target_missing_package,
    FixturePackage, FIXTURE_RULE_PREFIX,
};

/// Import a generated package through the ordinary release path into a clean
/// cache, returning the cache (kept alive by the caller) and the new corpus id.
fn import_fixture(fixture: &FixturePackage) -> (tempfile::TempDir, String) {
    let target_cache = tempfile::tempdir().expect("target cache");
    let bytes = std::fs::read(&fixture.path).expect("read package");
    let report = import_corpus_zip(target_cache.path(), &bytes).expect("import fixture package");
    (target_cache, report.corpus_id)
}

/// Assert the durable sidecar carries no resolution, so any resolution a test
/// observes was necessarily re-derived rather than trusted from the package.
fn assert_resolution_is_not_persisted(corpus: &LogCorpus) {
    let raw = std::fs::read_to_string(corpus.root().join("suppression.json"))
        .expect("imported corpus keeps a durable suppression sidecar");
    assert!(
        !raw.contains("\"resolution\""),
        "resolution must be re-derived, never carried in the durable sidecar"
    );
    assert!(
        !raw.contains("\"resolvedTemplateRevision\""),
        "resolved template revision must be re-derived, never carried"
    );
}

fn audit_actions(document: &SuppressionDocument) -> Vec<SuppressionAuditAction> {
    document.audit.iter().map(|entry| entry.action).collect()
}

#[test]
fn importer_accepts_fixture_package_and_rederives_stale_resolution() {
    let source_cache = tempfile::tempdir().expect("source cache");
    let out_dir = tempfile::tempdir().expect("package out");
    let fixture = fingerprint_changed_package(source_cache.path(), out_dir.path())
        .expect("generate fixture package");

    // Import through the ordinary release path into a clean cache.
    let (target_cache, corpus_id) = import_fixture(&fixture);

    let corpus = LogCorpus::open(target_cache.path(), &corpus_id).expect("open imported");
    let document = load_suppression_document(&corpus).expect("resolve imported policy");

    // The rule survives import, is still enabled, and is named unmistakably.
    assert_eq!(document.rules.len(), 1, "rule must survive the round trip");
    let rule = &document.rules[0];
    assert_eq!(rule.name, fixture.rule_names[0]);
    assert!(rule.name.starts_with(FIXTURE_RULE_PREFIX));
    assert_eq!(rule.state, SuppressionRuleState::Enabled);
    assert!(
        !rule.rationale.is_empty(),
        "rationale is required evidence and must round-trip"
    );

    // Resolution is re-derived on the importing machine, not carried over.
    assert_resolution_is_not_persisted(&corpus);
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
    let reopened = LogCorpus::open(target_cache.path(), &corpus_id).expect("reopen");
    let again = load_suppression_document(&reopened).expect("resolve after reopen");
    assert_eq!(
        again.rules[0].resolution.as_ref().map(|r| r.kind),
        Some(SuppressionRuleResolutionKind::StaleFingerprintChanged),
        "resolution must be stable across reopen"
    );
    assert!(again.enabled_template_ids().expect("lens").is_empty());
}

#[test]
fn importer_rederives_target_missing_resolution_from_historical_package() {
    let source_cache = tempfile::tempdir().expect("source cache");
    let out_dir = tempfile::tempdir().expect("package out");
    let fixture = target_missing_package(source_cache.path(), out_dir.path())
        .expect("generate target-missing package");

    let (target_cache, corpus_id) = import_fixture(&fixture);
    let corpus = LogCorpus::open(target_cache.path(), &corpus_id).expect("open imported");
    let document = load_suppression_document(&corpus).expect("resolve imported policy");

    // Rule identity, evidence, and lifecycle all survive the round trip.
    assert_eq!(document.rules.len(), 1, "rule must survive the round trip");
    let rule = &document.rules[0];
    assert_eq!(rule.name, fixture.rule_names[0]);
    assert!(rule.name.starts_with(FIXTURE_RULE_PREFIX));
    assert_eq!(rule.state, SuppressionRuleState::Enabled);
    assert_eq!(rule.origin, SuppressionRuleOrigin::Human);
    assert!(
        rule.rationale.contains("no longer exists"),
        "the human rationale is evidence and must round-trip verbatim"
    );

    // The importer re-derives the verdict; the package never asserted one.
    assert_resolution_is_not_persisted(&corpus);
    let resolution = rule.resolution.as_ref().expect("resolution re-derived");
    assert_eq!(
        resolution.kind,
        SuppressionRuleResolutionKind::StaleTargetMissing,
        "a rule whose target template is absent must resolve stale, not be re-bound"
    );
    assert!(
        resolution.matches_nothing,
        "a rule with no target excludes nothing"
    );

    // Zero exclusions.
    assert!(
        document.enabled_template_ids().expect("lens").is_empty(),
        "a stale rule must contribute no exclusions"
    );

    // The full preview→activate audit pair persists.
    assert_eq!(
        audit_actions(&document),
        vec![
            SuppressionAuditAction::Previewed,
            SuppressionAuditAction::Activated
        ],
        "audit history must survive import in order"
    );
    assert!(
        document
            .audit
            .iter()
            .any(|entry| entry.rule_id.as_deref() == Some(rule.id.as_str())),
        "the activation audit entry must still name its rule"
    );

    // Reopening (restart-equivalent) is identical.
    drop(corpus);
    let reopened = LogCorpus::open(target_cache.path(), &corpus_id).expect("reopen");
    let again = load_suppression_document(&reopened).expect("resolve after reopen");
    assert_eq!(
        again.rules[0].resolution.as_ref().map(|r| r.kind),
        Some(SuppressionRuleResolutionKind::StaleTargetMissing),
        "resolution must be stable across reopen"
    );
    assert!(again.enabled_template_ids().expect("lens").is_empty());
}

#[test]
fn importer_rederives_conflicting_predicate_resolution_from_historical_package() {
    let source_cache = tempfile::tempdir().expect("source cache");
    let out_dir = tempfile::tempdir().expect("package out");
    let fixture = conflicting_predicates_package(source_cache.path(), out_dir.path())
        .expect("generate conflicting-predicates package");

    let (target_cache, corpus_id) = import_fixture(&fixture);
    let corpus = LogCorpus::open(target_cache.path(), &corpus_id).expect("open imported");
    let document = load_suppression_document(&corpus).expect("resolve imported policy");

    assert_eq!(
        document.rules.len(),
        2,
        "both rules must survive the import"
    );
    assert_resolution_is_not_persisted(&corpus);

    let names = document
        .rules
        .iter()
        .map(|rule| rule.name.clone())
        .collect::<Vec<_>>();
    assert_eq!(names, fixture.rule_names, "rule names must round-trip");

    for rule in &document.rules {
        assert!(rule.name.starts_with(FIXTURE_RULE_PREFIX));
        assert_eq!(rule.state, SuppressionRuleState::Enabled);
        assert_eq!(rule.origin, SuppressionRuleOrigin::Human);
        assert!(
            rule.rationale.contains("Deterministic #819 fixture"),
            "each rule keeps its own human rationale"
        );

        // BOTH rules must be re-derived as conflicting; neither wins the id.
        let resolution = rule.resolution.as_ref().expect("resolution re-derived");
        assert_eq!(
            resolution.kind,
            SuppressionRuleResolutionKind::ConflictingPredicate,
            "every enabled rule sharing a template id must resolve conflicting"
        );
        assert!(
            resolution.matches_nothing,
            "a contested predicate excludes nothing"
        );
    }

    // Zero exclusions: a contested template id is never silently applied.
    assert!(
        document.enabled_template_ids().expect("lens").is_empty(),
        "conflicting rules must contribute no exclusions"
    );

    // Two full preview→activate audit pairs persist.
    assert_eq!(
        audit_actions(&document),
        vec![
            SuppressionAuditAction::Previewed,
            SuppressionAuditAction::Activated,
            SuppressionAuditAction::Previewed,
            SuppressionAuditAction::Activated,
        ],
        "audit history for both rules must survive import in order"
    );

    // Reopening (restart-equivalent) is identical.
    drop(corpus);
    let reopened = LogCorpus::open(target_cache.path(), &corpus_id).expect("reopen");
    let again = load_suppression_document(&reopened).expect("resolve after reopen");
    assert_eq!(again.rules.len(), 2);
    for rule in &again.rules {
        assert_eq!(
            rule.resolution.as_ref().map(|resolution| resolution.kind),
            Some(SuppressionRuleResolutionKind::ConflictingPredicate),
            "resolution must be stable across reopen"
        );
    }
    assert!(again.enabled_template_ids().expect("lens").is_empty());
}

/// The conflict must be the *only* defect in the conflicting fixture.
///
/// `resolve_rule_statuses` checks contention before fingerprints, so a fixture
/// whose predicates were also stale would produce the same `conflicting`
/// verdict and hide the difference. Disabling one contender through the
/// production lifecycle path resolves the contention and proves the survivor
/// was valid all along — which is also the operator's real remedy. Both
/// directions are exercised, so neither rule can be quietly stale.
#[test]
fn conflicting_fixture_rules_are_otherwise_valid() {
    let source_cache = tempfile::tempdir().expect("source cache");
    let out_dir = tempfile::tempdir().expect("package out");
    let fixture = conflicting_predicates_package(source_cache.path(), out_dir.path())
        .expect("generate conflicting-predicates package");

    let (target_cache, corpus_id) = import_fixture(&fixture);
    let corpus = LogCorpus::open(target_cache.path(), &corpus_id).expect("open imported");
    let document = load_suppression_document(&corpus).expect("resolve imported policy");
    let contested_template_id = document.rules[0].predicate.template_id;
    let rule_ids = [document.rules[0].id.clone(), document.rules[1].id.clone()];

    // Leave each rule as the sole contender in turn; the survivor must apply.
    for survivor in [0usize, 1] {
        let disabled = 1 - survivor;
        let revision = load_suppression_document(&corpus)
            .expect("resolve before disabling")
            .revision;
        mutate_template_suppression_rule(
            &corpus,
            revision,
            &rule_ids[disabled],
            SuppressionRuleMutation::Disable,
        )
        .expect("disable one contender through the production lifecycle path");

        let resolved = load_suppression_document(&corpus).expect("resolve after disabling");
        assert_eq!(
            resolved.rules[survivor].resolution.as_ref().map(|r| r.kind),
            Some(SuppressionRuleResolutionKind::MatchesCurrent),
            "rule {survivor} was valid; only the conflict made it inert"
        );
        assert_eq!(
            resolved.rules[disabled].resolution.as_ref().map(|r| r.kind),
            Some(SuppressionRuleResolutionKind::Inactive),
            "the disabled rule participates in nothing"
        );
        assert_eq!(
            resolved.enabled_template_ids().expect("lens"),
            vec![contested_template_id],
            "resolving the conflict restores exactly one exclusion"
        );

        // Restore the historical conflict before testing the other direction.
        mutate_template_suppression_rule(
            &corpus,
            resolved.revision,
            &rule_ids[disabled],
            SuppressionRuleMutation::Reenable,
        )
        .expect("re-enable the other contender");
    }

    // Back to the imported state: contested again, and excluding nothing.
    let restored = load_suppression_document(&corpus).expect("resolve after restoring");
    for rule in &restored.rules {
        assert_eq!(
            rule.resolution.as_ref().map(|resolution| resolution.kind),
            Some(SuppressionRuleResolutionKind::ConflictingPredicate),
            "re-enabling restores the contested state"
        );
    }
    assert!(restored.enabled_template_ids().expect("lens").is_empty());
}

/// The conflicting fixture is *history*, not a creation path: production
/// activation still refuses to add another rule on an owned predicate.
#[test]
fn production_activation_still_rejects_duplicate_predicates() {
    let source_cache = tempfile::tempdir().expect("source cache");
    let out_dir = tempfile::tempdir().expect("package out");
    let fixture = conflicting_predicates_package(source_cache.path(), out_dir.path())
        .expect("generate conflicting-predicates package");

    let (target_cache, corpus_id) = import_fixture(&fixture);
    let corpus = LogCorpus::open(target_cache.path(), &corpus_id).expect("open imported");

    let template_id = load_suppression_document(&corpus)
        .expect("resolve imported policy")
        .rules[0]
        .predicate
        .template_id;
    let revision = load_suppression_document(&corpus)
        .expect("resolve imported policy")
        .revision;

    let preview = preview_template_suppression(
        &corpus,
        revision,
        NewSuppressionPreview {
            name: format!("{FIXTURE_RULE_PREFIX}-duplicate-attempt"),
            rationale: "Attempt a third rule on an already owned template.".into(),
            template_id,
            origin: SuppressionRuleOrigin::Human,
        },
    )
    .expect("previewing an owned template is allowed; activating it is not");

    let error = activate_template_suppression(
        &corpus,
        revision + 1,
        ActivateSuppressionPreview {
            preview_token: preview.token.clone(),
        },
    )
    .expect_err("activation must refuse a duplicate template predicate");
    assert!(
        error
            .to_string()
            .contains("an active or disabled rule already owns this exact template predicate"),
        "unexpected rejection: {error}"
    );

    // The refusal left the durable policy alone: still exactly two rules, both
    // still inert.
    let document = load_suppression_document(&corpus).expect("resolve after refusal");
    assert_eq!(
        document.rules.len(),
        2,
        "a refused activation must not add a rule"
    );
    assert!(document.enabled_template_ids().expect("lens").is_empty());
}
