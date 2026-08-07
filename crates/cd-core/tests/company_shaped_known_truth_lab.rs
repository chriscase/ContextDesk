//! Public-safe company-shaped fixture acceptance lab.
//!
//! The generated logs have WildFly/JBoss structure but no copied payloads,
//! company names, credentials, hosts, or private answer key.

#[path = "support/company_shaped_known_truth_fixture.rs"]
mod fixture;

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use cd_core::log_analysis::{
    apply_source_timezones, ingest_path_with_policy, load_timezone_resolution_state,
    preview_source_timezone, query_event_rows, ActiveTimestampBasis, EventQuery, ExplorerEvent,
    LogCorpus, LogEmbedMode, LogEmbedPolicy, SourceTimezoneApplyRequest, TimestampProvenance,
};
use serde::Deserialize;

use fixture::{
    write_company_shaped_fixture, FixtureScenario, FixtureVariant, GeneratedFixture,
    STDERR_RUN_RECORDS,
};

const CHICAGO_MAY_2017_1410_NORMALIZED_Z: i64 = 1_494_443_400; // 2017-05-10T19:10:00Z

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TruthManifest {
    schema_id: String,
    schema_version: u32,
    evaluator_only: bool,
    source_timezone_iana: String,
    small_ci: SmallTruth,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SmallTruth {
    app_renderings: usize,
    stderr_runs: Vec<usize>,
    stderr_records: usize,
    citable_records: usize,
    explicit_utc_rows: usize,
    order_only_rows: usize,
}

fn truth_manifest() -> TruthManifest {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/company-shaped-known-truth-lab/evaluator-truth/manifest.json");
    serde_json::from_str(&fs::read_to_string(path).expect("read evaluator truth"))
        .expect("parse evaluator truth")
}

fn no_embed_policy() -> LogEmbedPolicy {
    LogEmbedPolicy {
        mode: LogEmbedMode::None,
        cloud_content_leaves_machine: false,
        cloud_base_url: None,
        model_id: "synthetic-fixture-test".into(),
        defer_above_source_bytes: None,
    }
}

fn ingest(root: &Path) -> (tempfile::TempDir, String, LogCorpus) {
    let cache = tempfile::tempdir().expect("cache");
    let report = ingest_path_with_policy(
        cache.path(),
        root,
        "company-shaped-known-truth",
        &no_embed_policy(),
        None,
    )
    .expect("ingest synthetic fixture");
    let corpus = LogCorpus::open(cache.path(), &report.corpus_id).expect("open corpus");
    (cache, report.corpus_id, corpus)
}

fn all_events(corpus: &LogCorpus) -> Vec<ExplorerEvent> {
    let mut events = Vec::new();
    let mut after_seq = None;
    loop {
        let page = query_event_rows(
            corpus,
            &EventQuery {
                after_seq,
                limit: 512,
                sort_by_time: false,
                ..Default::default()
            },
        )
        .expect("query events");
        if page.events.is_empty() {
            break;
        }
        after_seq = page.events.last().map(|event| event.seq);
        let count = page.events.len();
        events.extend(page.events);
        if count < 512 {
            break;
        }
    }
    events
}

fn citation_id(message: &str) -> Option<&str> {
    let (_, value) = message.split_once("synthetic-cite=")?;
    value.split_whitespace().next()
}

fn citation_union(events: &[ExplorerEvent]) -> BTreeSet<String> {
    events
        .iter()
        .filter_map(|event| citation_id(&event.message).map(str::to_string))
        .collect()
}

fn source_is(event: &ExplorerEvent, suffix: &str) -> bool {
    event.source.ends_with(suffix)
}

fn raw_trace_anchors(root: &Path) -> (Vec<String>, Vec<String>) {
    let mut app = Vec::new();
    let mut stderr = Vec::new();
    for path in [root.join("server.log"), root.join("server.log.1")] {
        for line in fs::read_to_string(path).expect("read app log").lines() {
            if line.contains("synthetic-cite=app-") {
                if let Some((_, trace)) = line.split_once("trace_id=") {
                    app.push(
                        trace
                            .split_whitespace()
                            .next()
                            .unwrap_or_default()
                            .to_string(),
                    );
                }
            }
        }
    }
    for entry in fs::read_dir(root).expect("read fixture root") {
        let path = entry.expect("dir entry").path();
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        if !name.starts_with("server.stderr.run-") {
            continue;
        }
        let first = fs::read_to_string(path)
            .expect("read stderr run")
            .lines()
            .next()
            .unwrap_or_default()
            .to_string();
        if let Some((_, trace)) = first.split_once("trace_id=") {
            stderr.push(
                trace
                    .split_whitespace()
                    .next()
                    .unwrap_or_default()
                    .to_string(),
            );
        }
    }
    app.sort();
    stderr.sort();
    (app, stderr)
}

fn semantically_certified_anchor_set(app: &[String], stderr: &[String]) -> bool {
    if app.is_empty() || app.len() != stderr.len() || app != stderr {
        return false;
    }
    app.iter().collect::<BTreeSet<_>>().len() == app.len()
}

#[test]
fn small_ci_fixture_conserves_exact_known_truth_and_citations() {
    let truth = truth_manifest();
    assert_eq!(truth.schema_id, "contextdesk.company_shaped_known_truth.v1");
    assert_eq!(truth.schema_version, 1);
    assert!(truth.evaluator_only);
    assert_eq!(truth.source_timezone_iana, "America/Chicago");

    let import = tempfile::tempdir().expect("import root");
    let generated = write_company_shaped_fixture(
        import.path(),
        FixtureScenario::SmallCi,
        FixtureVariant::Anchored,
    );
    assert_fixture_geometry(&generated, &truth.small_ci);
    assert!(
        !import.path().join("evaluator-truth").exists()
            && !import.path().join("manifest.json").exists(),
        "truth must remain evaluator-only and never ship inside the generated import tree"
    );

    let (_cache, _corpus_id, corpus) = ingest(import.path());
    let events = all_events(&corpus);
    let observed_citations = citation_union(&events);
    let citable_events: Vec<_> = events
        .iter()
        .filter(|event| citation_id(&event.message).is_some())
        .collect();
    let app_citations = observed_citations
        .iter()
        .filter(|id| id.starts_with("app-"))
        .count();
    let stderr_citations = observed_citations
        .iter()
        .filter(|id| id.starts_with("stderr-"))
        .count();

    assert_eq!(
        citable_events.len(),
        truth.small_ci.citable_records,
        "each citable raw identity lands once"
    );
    assert_eq!(app_citations, truth.small_ci.app_renderings);
    assert_eq!(stderr_citations, truth.small_ci.stderr_records);
    assert_eq!(
        app_citations + stderr_citations,
        truth.small_ci.citable_records
    );
    assert_eq!(
        observed_citations, generated.expected_citation_ids,
        "citation union must conserve every independently generated identity exactly once"
    );

    let (app, stderr) = raw_trace_anchors(import.path());
    assert!(semantically_certified_anchor_set(&app, &stderr));
}

#[test]
fn chicago_may_2017_local_rows_normalize_to_z_while_explicit_utc_and_order_only_rows_are_preserved()
{
    let truth = truth_manifest();
    let import = tempfile::tempdir().expect("import root");
    write_company_shaped_fixture(
        import.path(),
        FixtureScenario::SmallCi,
        FixtureVariant::Anchored,
    );
    let (cache, corpus_id, corpus) = ingest(import.path());
    let before = all_events(&corpus);
    let utc_before: BTreeMap<_, _> = before
        .iter()
        .filter(|event| source_is(event, "utc-audit.jsonl"))
        .map(|event| {
            (
                event.message.clone(),
                (
                    event.ts,
                    event.timestamp_provenance,
                    event.active_timestamp_basis,
                ),
            )
        })
        .collect();
    assert_eq!(utc_before.len(), truth.small_ci.explicit_utc_rows);
    assert!(utc_before.values().all(|(_, provenance, basis)| {
        *provenance == TimestampProvenance::ExplicitWallClock
            && *basis == ActiveTimestampBasis::ExplicitWall
    }));
    assert_eq!(
        before
            .iter()
            .filter(|event| source_is(event, "order-only.log"))
            .count(),
        truth.small_ci.order_only_rows
    );
    assert!(before
        .iter()
        .filter(|event| source_is(event, "order-only.log"))
        .all(|event| {
            event.timestamp_provenance == TimestampProvenance::OrderOnly
                && event.active_timestamp_basis == ActiveTimestampBasis::OrderOnly
        }));

    let state =
        load_timezone_resolution_state(cache.path(), &corpus_id).expect("load timezone state");
    let requests: Vec<_> = state
        .sources
        .iter()
        .filter(|source| source.unresolved_local_records > 0)
        .map(|source| {
            let preview = preview_source_timezone(
                cache.path(),
                &corpus_id,
                state.scope.event_revision,
                &source.source,
                &truth.source_timezone_iana,
            )
            .expect("preview explicit IANA source zone");
            SourceTimezoneApplyRequest {
                source: source.source.clone(),
                iana_timezone: truth.source_timezone_iana.clone(),
                preview_token: preview.declaration_fingerprint,
            }
        })
        .collect();
    assert!(
        !requests.is_empty(),
        "fixture must have zone-less local May 2017 rows"
    );
    apply_source_timezones(
        cache.path(),
        &corpus_id,
        state.scope.event_revision,
        &requests,
        1_494_442_800,
    )
    .expect("apply America/Chicago declaration");

    let revised = LogCorpus::open(cache.path(), &corpus_id).expect("reopen revised corpus");
    let after = all_events(&revised);
    let normalized = after
        .iter()
        .find(|event| event.message.contains("synthetic-cite=app-000"))
        .expect("first local application row");
    assert_eq!(
        normalized.ts, CHICAGO_MAY_2017_1410_NORMALIZED_Z,
        "America/Chicago in May 2017 is UTC-05, so 14:10 local is 2017-05-10T19:10:00Z"
    );
    assert_eq!(
        normalized.active_timestamp_basis,
        ActiveTimestampBasis::ResolvedLocal
    );
    let utc_after: BTreeMap<_, _> = after
        .iter()
        .filter(|event| source_is(event, "utc-audit.jsonl"))
        .map(|event| {
            (
                event.message.clone(),
                (
                    event.ts,
                    event.timestamp_provenance,
                    event.active_timestamp_basis,
                ),
            )
        })
        .collect();
    assert_eq!(
        utc_after, utc_before,
        "explicit UTC rows must remain unchanged by source-local normalization"
    );
    assert_eq!(
        after
            .iter()
            .filter(|event| source_is(event, "order-only.log"))
            .count(),
        truth.small_ci.order_only_rows,
        "order-only rows are retained, not discarded during timezone application"
    );
}

#[test]
fn static_reused_trace_conflicting_key_and_unanchored_variants_refuse_semantic_certification() {
    for variant in [
        FixtureVariant::Unanchored,
        FixtureVariant::StaticReusedTrace,
        FixtureVariant::ConflictingKeys,
    ] {
        let import = tempfile::tempdir().expect("negative import root");
        write_company_shaped_fixture(import.path(), FixtureScenario::SmallCi, variant);
        let (app, stderr) = raw_trace_anchors(import.path());
        assert!(
            !semantically_certified_anchor_set(&app, &stderr),
            "{variant:?} must never qualify as a unique, matched execution anchor set"
        );
        if variant == FixtureVariant::Unanchored {
            let all = fs::read_dir(import.path())
                .expect("read generated files")
                .filter_map(Result::ok)
                .filter_map(|entry| fs::read_to_string(entry.path()).ok())
                .collect::<String>();
            assert!(
                !all.contains("trace_id="),
                "unanchored variant contains no named trace key"
            );
            assert!(
                !all.contains("request_id="),
                "unanchored variant contains no named request key"
            );
        }
    }
}

/// Optional larger structural scenario. Run manually or on a dedicated suite:
/// `cargo test -p cd-core --test company_shaped_known_truth_lab -- --ignored`.
#[test]
#[ignore = "optional larger company-shaped generator scenario"]
fn larger_company_shaped_scenario_keeps_run_and_citation_conservation() {
    let import = tempfile::tempdir().expect("large import root");
    let generated = write_company_shaped_fixture(
        import.path(),
        FixtureScenario::LargerOptional,
        FixtureVariant::Anchored,
    );
    let multiplier = FixtureScenario::LargerOptional.multiplier();
    assert_eq!(
        generated.stderr_run_record_counts.len(),
        STDERR_RUN_RECORDS.len() * multiplier
    );
    assert_eq!(
        generated.stderr_records,
        STDERR_RUN_RECORDS.iter().sum::<usize>() * multiplier
    );
    assert_eq!(
        generated.citable_records(),
        generated.app_renderings + generated.stderr_records
    );
}

fn assert_fixture_geometry(generated: &GeneratedFixture, truth: &SmallTruth) {
    assert_eq!(generated.app_renderings, truth.app_renderings);
    assert_eq!(generated.stderr_run_record_counts, truth.stderr_runs);
    assert_eq!(generated.stderr_records, truth.stderr_records);
    assert_eq!(generated.citable_records(), truth.citable_records);
}
