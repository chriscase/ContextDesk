//! #819 acceptance — a LEGACY (schema-3) investigation finding must read back
//! as `unbound_legacy` and must never adopt the importing profile's policy.
//!
//! `UnboundLegacy` is the one #819 binding state no production write path can
//! create: every shipped mutation stamps the current schema version and
//! captures an `InvestigationPolicyBinding`. `tests/support/suppression_fixtures.rs`
//! records this gap ("investigations are not carried in a corpus package, so
//! this needs a separate schema-3 `InvestigationStore` fixture"); this file
//! closes it with `tests/support/legacy_investigation_fixture.rs`.
//!
//! What is proven here, using the production `InvestigationStore` loader and no
//! test-only read path:
//!
//! 1. the loader consumes an authored schema-3 document and reports
//!    `InvestigationPolicyBindingStatus::UnboundLegacy`;
//! 2. the finding stays `policy_binding: None` across a reopen, *even when the
//!    corpus has an active suppression policy* — no backfill, no inference;
//! 3. the saved `view_recipe` survives the legacy read intact;
//! 4. the document is still schema 3 on disk afterwards, byte for byte — a read
//!    performs no passive migration and publishes no new revision;
//! 5. the status is not `Current`, which is exactly what
//!    `policyBindingBlocksApply` (`desktop/src/lib/logExplorer/policyBinding.ts`)
//!    keys on, so Apply is blocked;
//! 6. the fixture writes nothing outside the caller-supplied root.

#[path = "support/legacy_investigation_fixture.rs"]
mod legacy_investigation_fixture;

use cd_core::investigations::{
    EvidenceReferenceStatus, InvestigationNoiseLens, InvestigationPolicyBindingStatus,
    InvestigationStore, ResolvedInvestigationDocument,
};
use cd_core::log_analysis::LogCorpus;
use legacy_investigation_fixture::{
    activate_fixture_suppression_rule, install_legacy_unbound_investigation, legacy_fixture_corpus,
    revision_filename, LegacyInvestigationFixture, FIXTURE_LABEL, LEGACY_REVISION,
    LEGACY_SCHEMA_VERSION,
};
use std::path::Path;

/// Temp cache + temp profile root + the installed legacy fixture.
struct Harness {
    _cache: tempfile::TempDir,
    profile: tempfile::TempDir,
    corpus: LogCorpus,
    fixture: LegacyInvestigationFixture,
}

impl Harness {
    fn install() -> Self {
        let cache = tempfile::tempdir().expect("corpus cache");
        let profile = tempfile::tempdir().expect("durable profile root");
        let corpus = legacy_fixture_corpus(cache.path()).expect("fixture corpus");
        let fixture =
            install_legacy_unbound_investigation(profile.path(), &corpus).expect("install fixture");
        Self {
            _cache: cache,
            profile,
            corpus,
            fixture,
        }
    }

    fn store(&self) -> InvestigationStore {
        InvestigationStore::new(self.profile.path())
    }

    fn load(&self, lens: InvestigationNoiseLens) -> ResolvedInvestigationDocument {
        self.store()
            .load_with_policy_lens(&self.fixture.investigation_id, &self.corpus, lens)
            .expect("production loader reads the legacy fixture")
    }

    fn investigation_dir(&self) -> std::path::PathBuf {
        self.profile.path().join(&self.fixture.investigation_id)
    }
}

fn only_finding(resolved: &ResolvedInvestigationDocument) -> &cd_core::investigations::FindingItem {
    assert_eq!(
        resolved.findings.len(),
        1,
        "fixture is bounded to exactly one finding"
    );
    &resolved.findings[0].item
}

fn entries(directory: &Path) -> Vec<String> {
    let mut names = std::fs::read_dir(directory)
        .expect("read directory")
        .map(|entry| {
            entry
                .expect("entry")
                .file_name()
                .to_string_lossy()
                .to_string()
        })
        .collect::<Vec<_>>();
    names.sort();
    names
}

#[test]
fn production_loader_reports_unbound_legacy_for_schema_3_finding() {
    let harness = Harness::install();

    let resolved = harness.load(InvestigationNoiseLens::Active);
    assert_eq!(resolved.document.schema_version, LEGACY_SCHEMA_VERSION);
    assert_eq!(resolved.document.revision, LEGACY_REVISION);
    assert!(
        resolved.document.title.starts_with(FIXTURE_LABEL),
        "fixture identity must be conspicuous in the title: {}",
        resolved.document.title
    );

    let finding = only_finding(&resolved);
    assert_eq!(finding.id, harness.fixture.finding_id);
    assert_eq!(finding.title, harness.fixture.finding_title);
    assert_eq!(
        finding.policy_binding, None,
        "a legacy finding carries no durable binding"
    );
    assert_eq!(
        resolved.findings[0].policy_binding.status,
        InvestigationPolicyBindingStatus::UnboundLegacy
    );
    assert_eq!(resolved.findings[0].policy_binding.binding, None);

    // The lens-free loader must reach the same verdict: an absent binding is
    // decided before any current-lens comparison.
    let without_lens = harness
        .store()
        .load(&harness.fixture.investigation_id, &harness.corpus)
        .expect("lens-free load");
    assert_eq!(
        without_lens.findings[0].policy_binding.status,
        InvestigationPolicyBindingStatus::UnboundLegacy
    );

    // The cited evidence is real: the fixture points at events that exist.
    assert_eq!(resolved.evidence.len(), 1);
    assert_eq!(resolved.evidence[0].item.id, harness.fixture.evidence_id);
    assert_eq!(
        finding.evidence_ids,
        vec![harness.fixture.evidence_id.clone()]
    );
    assert_eq!(resolved.evidence[0].references.len(), 2);
    for reference in &resolved.evidence[0].references {
        assert_eq!(reference.status, EvidenceReferenceStatus::Verified);
    }
}

#[test]
fn unbound_finding_never_adopts_current_policy_across_reopen() {
    let harness = Harness::install();

    // Give the importing profile a real, non-empty current noise policy first,
    // published through the production preview→confirm path.
    let policy_revision =
        activate_fixture_suppression_rule(&harness.corpus).expect("activate fixture rule");
    assert!(
        policy_revision > 0,
        "an active suppression policy now exists"
    );

    for pass in 1..=2 {
        let resolved = harness.load(InvestigationNoiseLens::Active);
        let finding = only_finding(&resolved);
        assert_eq!(
            finding.policy_binding, None,
            "pass {pass}: the durable record must never be backfilled with the current policy"
        );
        assert_eq!(
            resolved.findings[0].policy_binding.status,
            InvestigationPolicyBindingStatus::UnboundLegacy,
            "pass {pass}: an unbound legacy finding never becomes current"
        );
        // The resolution reports the *current* policy honestly next to the
        // absent binding; it must not be mistaken for the finding's binding.
        assert!(
            resolved.findings[0]
                .policy_binding
                .current_suppression_policy_revision
                >= policy_revision,
            "pass {pass}: current policy revision is reported from the corpus"
        );
        assert!(!resolved.findings[0]
            .policy_binding
            .current_effective_policy_sha256
            .is_empty());
    }

    // The suspended lens must not change the verdict either.
    let suspended = harness.load(InvestigationNoiseLens::Suspended);
    assert_eq!(only_finding(&suspended).policy_binding, None);
    assert_eq!(
        suspended.findings[0].policy_binding.status,
        InvestigationPolicyBindingStatus::UnboundLegacy
    );
}

#[test]
fn saved_view_recipe_survives_legacy_load() {
    let harness = Harness::install();

    let resolved = harness.load(InvestigationNoiseLens::Active);
    let recipe = only_finding(&resolved)
        .view_recipe
        .as_ref()
        .expect("legacy finding keeps its saved view recipe");
    assert_eq!(recipe, &harness.fixture.view_recipe);

    // Spot-check the parts that carry the operator's intent, so a future
    // structural change cannot silently drop them.
    assert_eq!(recipe.lanes.len(), 2);
    assert_eq!(recipe.visible_lane_count, 2);
    assert_eq!(recipe.selection.len(), 2);
    assert_eq!(recipe.highlights.len(), 1);
    assert_eq!(recipe.viewport_anchors.len(), 2);
    assert!(recipe.find.is_some());
    assert!(recipe.focused_event.is_some());
    assert_eq!(
        recipe.focused_lane_id.as_deref(),
        Some(recipe.lanes[0].id.as_str())
    );
}

#[test]
fn legacy_document_is_not_migrated_or_rewritten_on_load() {
    let harness = Harness::install();
    let revision_path = &harness.fixture.revision_path;
    let before = std::fs::read(revision_path).expect("read fixture revision bytes");

    // Two full reads under both lens modes; none of them may publish anything.
    let _ = harness.load(InvestigationNoiseLens::Active);
    let _ = harness.load(InvestigationNoiseLens::Suspended);
    let summaries = harness.store().list().expect("list investigations");
    assert_eq!(summaries.len(), 1);
    assert_eq!(summaries[0].revision, LEGACY_REVISION);

    let after = std::fs::read(revision_path).expect("re-read fixture revision bytes");
    assert_eq!(before, after, "load must not rewrite the durable revision");

    let on_disk: serde_json::Value =
        serde_json::from_slice(&after).expect("parse the durable revision as JSON");
    assert_eq!(
        on_disk["schemaVersion"],
        serde_json::json!(LEGACY_SCHEMA_VERSION),
        "the document is still schema 3 on disk after being read"
    );
    assert!(
        on_disk["findings"][0].get("policyBinding").is_none(),
        "no policy binding may appear on disk after a read"
    );

    // No second revision file, so nothing was passively migrated forward.
    assert_eq!(
        entries(&harness.investigation_dir()),
        vec![revision_filename(LEGACY_REVISION)]
    );
    assert!(!harness
        .investigation_dir()
        .join(revision_filename(LEGACY_REVISION + 1))
        .exists());
}

#[test]
fn unbound_legacy_status_blocks_apply() {
    let harness = Harness::install();
    activate_fixture_suppression_rule(&harness.corpus).expect("activate fixture rule");

    for lens in [
        InvestigationNoiseLens::Active,
        InvestigationNoiseLens::Suspended,
    ] {
        let resolved = harness.load(lens);
        let status = resolved.findings[0].policy_binding.status;
        // Rust-side equivalent of `policyBindingBlocksApply(status)`, which is
        // `status !== "current"`.
        assert_ne!(
            status,
            InvestigationPolicyBindingStatus::Current,
            "Apply must stay blocked for an unbound legacy finding"
        );
        assert_eq!(status, InvestigationPolicyBindingStatus::UnboundLegacy);
    }
}

#[test]
fn fixture_writes_only_under_the_supplied_profile_root() {
    let harness = Harness::install();

    assert!(harness
        .fixture
        .revision_path
        .starts_with(harness.profile.path()));
    // Exactly one investigation directory, named by its UUIDv7 id, and exactly
    // one revision file inside it. Nothing else was created.
    assert_eq!(
        entries(harness.profile.path()),
        vec![harness.fixture.investigation_id.clone()]
    );
    assert_eq!(
        entries(&harness.investigation_dir()),
        vec![revision_filename(LEGACY_REVISION)]
    );

    // A relative root is refused outright, so nothing can resolve against the
    // process working directory.
    let error = install_legacy_unbound_investigation(Path::new("relative/root"), &harness.corpus)
        .expect_err("relative profile roots are refused");
    assert!(
        error.to_string().contains("absolute"),
        "unexpected error: {error}"
    );
    assert!(!Path::new("relative/root").exists());
}
