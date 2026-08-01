//! Deterministic LEGACY (schema-3) investigation fixture for #819.
//!
//! `InvestigationPolicyBindingStatus::UnboundLegacy` is the one #819 state that
//! no production write path can produce. Every shipped mutation stamps
//! `schema_version = INVESTIGATION_SCHEMA_VERSION` and captures an
//! `InvestigationPolicyBinding`, so an unbound finding can only come from a
//! record written by an older build. This module authors exactly that record —
//! a schema-3 [`InvestigationDocument`] with one finding whose `policy_binding`
//! is `None` — using the production typed structs, production serde, and the
//! production on-disk layout, so the release loader reads it unmodified.
//!
//! On-disk layout reproduced here (see `InvestigationStore` in
//! `crates/cd-core/src/investigations.rs`):
//!
//! ```text
//! <profile_root>/
//!   <investigation-uuidv7>/
//!     revision-00000000000000000001.json
//! ```
//!
//! The directory name is the investigation's UUIDv7 id and each revision file
//! is `revision-{revision:020}.json`; the store reads the highest-numbered
//! revision file. Writing exactly one revision file means "the latest readable
//! revision" is unambiguously the legacy document.
//!
//! # Safety properties
//!
//! - **Caller-scoped writes only.** Every path is derived from the
//!   `profile_root` argument. Nothing here reads a home directory, a user
//!   profile location, `dirs::*`, or any environment variable, and
//!   [`install_legacy_unbound_investigation`] refuses a relative `profile_root`
//!   and re-checks that the file it is about to create is inside that root.
//!   Callers pass a `tempfile::TempDir` path, so the fixture is disposable.
//! - **Test-support only.** This file lives under `tests/support` and is pulled
//!   in with `#[path = ...] mod ...` by an integration test, so it is compiled
//!   only into `cfg(test)` integration binaries. It is not part of the `cd-core`
//!   library, is not reachable from any release binary, and exposes no command,
//!   Tauri handler, capability, or release backdoor. It only *writes* a legacy
//!   document; it does not relax, bypass, or re-implement any validation — the
//!   production loader validates the fixture exactly as it validates a real
//!   record, and a fixture that failed validation would fail the test.
//! - **Unmistakable.** The investigation, the finding, the evidence item and the
//!   corpus all carry the conspicuous [`FIXTURE_LABEL`] (`TEST-FIXTURE`) prefix,
//!   so a fixture can never be mistaken for a user's investigation in a listing
//!   or a diagnostic.
//! - **Deterministic.** Fixed timestamps, fixed sequences, fixed titles, fixed
//!   lane ids, fixed revision number. The only values that vary between runs are
//!   the UUIDv7 identities (which production validation requires to be UUIDv7)
//!   and the corpus id; no assertion depends on their contents.
//! - **Bounded.** One investigation, one revision, one finding, one evidence
//!   item, two event references, two lanes.

#![allow(dead_code)]

use cd_core::error::{CoreError, CoreResult};
use cd_core::investigations::{
    EvidenceItem, EvidenceProvenance, FindingItem, FindingKind, FindingLifecycle,
    FindingViewFilters, FindingViewFind, FindingViewFindMatchMode, FindingViewLane,
    FindingViewRecipe, FindingViewTimeLinkMode, FindingViewViewportAnchor, HumanProvenance,
    InvestigationCorpusLink, InvestigationDocument, InvestigationStatus,
};
use cd_core::log_analysis::{
    activate_template_suppression, load_suppression_document, preview_template_suppression,
    ActivateSuppressionPreview, ActiveTimestampBasis, BookmarkEventRef, LogCorpus, LogEvent,
    NewSuppressionPreview, SuppressionRuleOrigin, TemplateInfo, TemplateRow, TimeQuality,
    TimestampProvenance,
};
use std::io::Write;
use std::path::{Path, PathBuf};
use uuid::Uuid;

/// Conspicuous prefix carried by every durable name this fixture writes.
pub const FIXTURE_LABEL: &str = "TEST-FIXTURE";

/// Schema version of the authored legacy document.
///
/// Schema 3 is the last version that could hold a finding view recipe without a
/// policy binding: `validate_document` rejects a recipe below 3 and rejects a
/// `policy_binding` below 4. It is still readable because
/// `MIN_INVESTIGATION_SCHEMA_VERSION` is 1.
pub const LEGACY_SCHEMA_VERSION: u32 = 3;

/// The single revision this fixture publishes.
pub const LEGACY_REVISION: u64 = 1;

/// Investigation title, deliberately self-identifying as a fixture.
pub const LEGACY_INVESTIGATION_TITLE: &str =
    "TEST-FIXTURE legacy schema-3 investigation (unbound finding)";
/// Finding title, deliberately self-identifying as a fixture.
pub const LEGACY_FINDING_TITLE: &str = "TEST-FIXTURE unbound legacy finding";
/// Evidence title, deliberately self-identifying as a fixture.
pub const LEGACY_EVIDENCE_TITLE: &str = "TEST-FIXTURE legacy evidence selection";
/// Rationale stored on the legacy finding.
pub const LEGACY_WHY_IT_MATTERS: &str =
    "Saved before noise-policy bindings existed, so this finding must stay unbound on read.";

/// Fixed creation instant for every item in the fixture.
pub const FIXED_CREATED_AT: i64 = 1_700_000_000;
/// Fixed update instant for every item in the fixture.
pub const FIXED_UPDATED_AT: i64 = 1_700_000_060;

/// Sequence of the fixture's API event.
pub const API_SEQ: u64 = 10;
/// Sequence of the fixture's worker event.
pub const WORKER_SEQ: u64 = 12;
const API_TS: i64 = 1_700_000_010;
const WORKER_TS: i64 = 1_700_000_012;
const API_SOURCE: &str = "fixture-api/app.log";
const WORKER_SOURCE: &str = "fixture-worker/worker.log";
const API_LANE_ID: &str = "lane-fixture-api";
const WORKER_LANE_ID: &str = "lane-fixture-worker";
const FIXTURE_TEMPLATE_ID: u64 = 41;

/// One installed legacy fixture plus the facts a test asserts against it.
#[derive(Debug, Clone)]
pub struct LegacyInvestigationFixture {
    /// UUIDv7 id of the installed investigation; also its directory name.
    pub investigation_id: String,
    /// UUIDv7 id of the single unbound finding.
    pub finding_id: String,
    /// UUIDv7 id of the single evidence item the finding cites.
    pub evidence_id: String,
    /// Investigation title, carrying the `TEST-FIXTURE` label.
    pub title: String,
    /// Finding title, carrying the `TEST-FIXTURE` label.
    pub finding_title: String,
    /// Revision number written (always [`LEGACY_REVISION`]).
    pub revision: u64,
    /// Absolute path of the single revision file written under `profile_root`.
    pub revision_path: PathBuf,
    /// Exact view recipe stored on the finding, for survival assertions.
    pub view_recipe: FindingViewRecipe,
}

/// Build the bounded, deterministic corpus the legacy fixture cites.
///
/// Writes only under `cache_root` (a caller-supplied temp dir). Two events with
/// explicit wall-clock timestamps so saved references resolve as verified, plus
/// one template row so a suppression rule can later be activated against it.
pub fn legacy_fixture_corpus(cache_root: &Path) -> CoreResult<LogCorpus> {
    let corpus = LogCorpus::create(cache_root, format!("{FIXTURE_LABEL} legacy investigation"))?;
    corpus.push_events(&[
        LogEvent {
            seq: API_SEQ,
            ts: API_TS,
            timestamp_provenance: TimestampProvenance::ExplicitWallClock,
            active_timestamp_basis: ActiveTimestampBasis::ExplicitWall,
            unresolved_local_timestamp: None,
            level: "error".into(),
            service: Some("fixture-api".into()),
            host: Some("fixture-host".into()),
            template_id: FIXTURE_TEMPLATE_ID,
            params: vec!["value".into()],
            trace_id: None,
            message: "fixture request failed".into(),
            source: API_SOURCE.into(),
        },
        LogEvent {
            seq: WORKER_SEQ,
            ts: WORKER_TS,
            timestamp_provenance: TimestampProvenance::ExplicitWallClock,
            active_timestamp_basis: ActiveTimestampBasis::ExplicitWall,
            unresolved_local_timestamp: None,
            level: "warn".into(),
            service: Some("fixture-worker".into()),
            host: Some("fixture-host".into()),
            template_id: FIXTURE_TEMPLATE_ID,
            params: vec!["value".into()],
            trace_id: None,
            message: "fixture worker retry".into(),
            source: WORKER_SOURCE.into(),
        },
    ])?;
    corpus.upsert_templates([TemplateRow {
        info: TemplateInfo {
            template_id: FIXTURE_TEMPLATE_ID,
            pattern: "fixture worker retry <*>".into(),
            token_count: 4,
            count: 1,
            first_seen: API_TS,
            last_seen: WORKER_TS,
            severity: 1,
            example: "fixture worker retry value".into(),
        },
        content_hash: "sha256:fixture-legacy-investigation".into(),
        vector: None,
    }])?;
    corpus.flush()?;
    Ok(corpus)
}

/// Activate one suppression rule through the production preview→confirm path.
///
/// A test uses this to give the corpus a non-trivial *current* noise policy
/// before reading the fixture, so "the finding is still unbound" is a real
/// assertion rather than a comparison against an empty policy.
pub fn activate_fixture_suppression_rule(corpus: &LogCorpus) -> CoreResult<u64> {
    let revision = load_suppression_document(corpus)?.revision;
    let preview = preview_template_suppression(
        corpus,
        revision,
        NewSuppressionPreview {
            name: format!("{FIXTURE_LABEL} reviewed worker retry"),
            rationale: "Deterministic #819 legacy-fixture policy; reviewed noise.".into(),
            template_id: FIXTURE_TEMPLATE_ID,
            origin: SuppressionRuleOrigin::Human,
        },
    )?;
    let mutation = activate_template_suppression(
        corpus,
        revision + 1,
        ActivateSuppressionPreview {
            preview_token: preview.token.clone(),
        },
    )?;
    Ok(mutation.revision)
}

/// Install a legacy schema-3 investigation with one UNBOUND finding.
///
/// The document is built from production typed structs, serialized with the
/// production serde representation, and written into the production on-disk
/// layout (`<profile_root>/<uuidv7>/revision-{revision:020}.json`) so that
/// `InvestigationStore::new(profile_root).load_with_policy_lens(..)` reads it
/// with no fixture-specific code path.
///
/// The finding has `policy_binding: None` (the legacy state under test) and a
/// populated `view_recipe`, and cites one evidence item holding two exact,
/// payload-free event references into `corpus`.
///
/// # Path safety
///
/// Every byte is written under `profile_root`. `profile_root` must be absolute
/// so nothing can resolve against the process working directory; the target
/// file is re-checked to be inside `profile_root` before it is created, and the
/// revision file is created with `create_new(true)` so an existing record can
/// never be clobbered. No home directory, user profile, or environment variable
/// is consulted.
pub fn install_legacy_unbound_investigation(
    profile_root: &Path,
    corpus: &LogCorpus,
) -> CoreResult<LegacyInvestigationFixture> {
    install_legacy_unbound_investigation_for_corpus_id(profile_root, corpus.id())
}

/// Install the same fixture bound to an explicit corpus id.
///
/// Production `import_corpus_zip` **always mints a new corpus id** and records
/// the packaged one as `origin_corpus_id` (see `package.rs`), so an
/// investigation generated ahead of time can never match the id a user's import
/// will produce. Binding is therefore a separate, explicit step: import the
/// paired corpus first, then install the investigation against the id the
/// importer actually assigned. This keeps import and loader rules untouched —
/// nothing rewrites a corpus id after the fact.
pub fn install_legacy_unbound_investigation_for_corpus_id(
    profile_root: &Path,
    corpus_id: &str,
) -> CoreResult<LegacyInvestigationFixture> {
    if corpus_id.trim().is_empty() {
        return Err(CoreError::Message(
            "legacy investigation fixture requires a non-empty corpus id".into(),
        ));
    }
    if !profile_root.is_absolute() {
        return Err(CoreError::Message(
            "legacy investigation fixture requires an absolute caller-supplied profile root".into(),
        ));
    }

    let investigation_id = Uuid::now_v7().to_string();
    let evidence_id = Uuid::now_v7().to_string();
    let finding_id = Uuid::now_v7().to_string();

    let view_recipe = legacy_view_recipe(corpus_id);
    let document = InvestigationDocument {
        schema_version: LEGACY_SCHEMA_VERSION,
        id: investigation_id.clone(),
        revision: LEGACY_REVISION,
        title: LEGACY_INVESTIGATION_TITLE.to_string(),
        status: InvestigationStatus::Active,
        corpus_links: vec![InvestigationCorpusLink {
            corpus_id: corpus_id.to_string(),
        }],
        evidence: vec![EvidenceItem {
            id: evidence_id.clone(),
            title: LEGACY_EVIDENCE_TITLE.to_string(),
            provenance: EvidenceProvenance::Human,
            corpus_id: corpus_id.to_string(),
            event_refs: vec![
                fixture_event_ref(corpus_id, API_SEQ, API_SOURCE, API_TS),
                fixture_event_ref(corpus_id, WORKER_SEQ, WORKER_SOURCE, WORKER_TS),
            ],
            created_at: FIXED_CREATED_AT,
            updated_at: FIXED_CREATED_AT,
        }],
        findings: vec![FindingItem {
            id: finding_id.clone(),
            kind: FindingKind::Observation,
            lifecycle: FindingLifecycle::Accepted,
            title: LEGACY_FINDING_TITLE.to_string(),
            why_it_matters: LEGACY_WHY_IT_MATTERS.to_string(),
            evidence_ids: vec![evidence_id.clone()],
            view_recipe: Some(view_recipe.clone()),
            // The legacy state under test. A pre-schema-4 build had no binding
            // to write, and the loader must never infer or backfill one.
            policy_binding: None,
            provenance: HumanProvenance::Human,
            created_at: FIXED_CREATED_AT,
            updated_at: FIXED_UPDATED_AT,
        }],
        notes: Vec::new(),
        proposed_findings: Vec::new(),
        report_sections: Vec::new(),
        proposed_report_sections: Vec::new(),
        created_at: FIXED_CREATED_AT,
        updated_at: FIXED_UPDATED_AT,
    };

    let bytes = serde_json::to_vec_pretty(&document)?;
    // Fail before touching the filesystem if the authored document does not
    // round-trip. This never weakens validation; the production loader still
    // validates independently on read.
    let reparsed: InvestigationDocument = serde_json::from_slice(&bytes)?;
    if reparsed != document {
        return Err(CoreError::Message(
            "legacy investigation fixture failed serialization round-trip".into(),
        ));
    }
    if reparsed.schema_version != LEGACY_SCHEMA_VERSION
        || reparsed
            .findings
            .iter()
            .any(|finding| finding.policy_binding.is_some())
    {
        return Err(CoreError::Message(
            "legacy investigation fixture must serialize as schema 3 with no policy binding".into(),
        ));
    }

    let directory = profile_root.join(&investigation_id);
    let revision_path = directory.join(revision_filename(LEGACY_REVISION));
    // Belt and braces: the only writes are the ones the caller asked for, in
    // the caller's root. `investigation_id` is a UUIDv7, so it cannot contain a
    // separator or `..`, and this re-check makes that structural rather than
    // assumed.
    if !directory.starts_with(profile_root) || !revision_path.starts_with(profile_root) {
        return Err(CoreError::Message(
            "legacy investigation fixture refused to write outside the supplied profile root"
                .into(),
        ));
    }

    std::fs::create_dir_all(&directory).map_err(|error| {
        CoreError::Message(format!("create legacy fixture investigation dir: {error}"))
    })?;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&revision_path)
        .map_err(|error| {
            CoreError::Message(format!("create legacy fixture revision file: {error}"))
        })?;
    file.write_all(&bytes)
        .and_then(|()| file.sync_all())
        .map_err(|error| {
            CoreError::Message(format!("write legacy fixture revision file: {error}"))
        })?;

    Ok(LegacyInvestigationFixture {
        investigation_id,
        finding_id,
        evidence_id,
        title: LEGACY_INVESTIGATION_TITLE.to_string(),
        finding_title: LEGACY_FINDING_TITLE.to_string(),
        revision: LEGACY_REVISION,
        revision_path,
        view_recipe,
    })
}

/// Production revision file naming: `revision-{revision:020}.json`.
pub fn revision_filename(revision: u64) -> String {
    format!("revision-{revision:020}.json")
}

/// Export the fixture corpus through the production packager.
///
/// The legacy investigation cites events *in a corpus*, so the investigation
/// artifact is useless on its own: a machine that has never seen this corpus
/// cannot resolve the evidence. Emitting the paired package is what makes the
/// fixture executable natively.
///
/// Flush before export (the writer reads `templates.json` and `events.duckdb`
/// from disk) and drop the handle first (Windows exclusive-locks DuckDB).
pub fn export_legacy_fixture_corpus(
    corpus: LogCorpus,
    cache_root: &Path,
    out_path: PathBuf,
) -> CoreResult<PathBuf> {
    corpus.flush()?;
    let corpus_id = corpus.id().to_string();
    drop(corpus);
    cd_core::log_analysis::export_corpus_zip(cache_root, &corpus_id, &out_path)?;
    Ok(out_path)
}

/// Exact, payload-free reference in the canonical stored form.
fn fixture_event_ref(corpus_id: &str, seq: u64, source: &str, ts: i64) -> BookmarkEventRef {
    BookmarkEventRef {
        corpus_id: corpus_id.to_string(),
        seq,
        source: source.to_string(),
        timestamp_hint: ts,
        time_quality_hint: TimeQuality::Wall,
    }
}

/// The saved view recipe carried by the legacy finding.
///
/// Values are already in the canonical stored form the production validator
/// requires (strictly ascending filter values, viewport anchors in lane order,
/// selection and highlights in ascending sequence order), so nothing here
/// depends on a sanitizer being lenient.
fn legacy_view_recipe(corpus_id: &str) -> FindingViewRecipe {
    FindingViewRecipe {
        filters: FindingViewFilters {
            levels: vec!["error".into(), "warn".into()],
            sources: vec![API_SOURCE.into(), WORKER_SOURCE.into()],
            services: vec!["fixture-api".into(), "fixture-worker".into()],
            hosts: vec!["fixture-host".into()],
            time_from: Some(1_700_000_000),
            time_to: Some(1_700_000_100),
            seq_from: Some(API_SEQ),
            seq_to: Some(WORKER_SEQ),
            template_id: Some(FIXTURE_TEMPLATE_ID),
            trace_id: None,
            keyword: Some("fixture retry".into()),
        },
        lanes: vec![
            FindingViewLane {
                id: API_LANE_ID.into(),
                label: "Fixture API".into(),
                sources: vec![API_SOURCE.into()],
            },
            FindingViewLane {
                id: WORKER_LANE_ID.into(),
                label: "Fixture worker".into(),
                sources: vec![WORKER_SOURCE.into()],
            },
        ],
        visible_lane_count: 2,
        time_link_mode: FindingViewTimeLinkMode::AlignTime,
        focused_lane_id: Some(API_LANE_ID.into()),
        focused_event: Some(fixture_event_ref(corpus_id, API_SEQ, API_SOURCE, API_TS)),
        selection: vec![
            fixture_event_ref(corpus_id, API_SEQ, API_SOURCE, API_TS),
            fixture_event_ref(corpus_id, WORKER_SEQ, WORKER_SOURCE, WORKER_TS),
        ],
        highlights: vec![fixture_event_ref(
            corpus_id,
            WORKER_SEQ,
            WORKER_SOURCE,
            WORKER_TS,
        )],
        find: Some(FindingViewFind {
            query: "fixture retry".into(),
            match_mode: FindingViewFindMatchMode::Literal,
            case_sensitive: false,
            semantic: false,
        }),
        viewport_anchors: vec![
            FindingViewViewportAnchor {
                lane_id: API_LANE_ID.into(),
                event_ref: fixture_event_ref(corpus_id, API_SEQ, API_SOURCE, API_TS),
            },
            FindingViewViewportAnchor {
                lane_id: WORKER_LANE_ID.into(),
                event_ref: fixture_event_ref(corpus_id, WORKER_SEQ, WORKER_SOURCE, WORKER_TS),
            },
        ],
    }
}
