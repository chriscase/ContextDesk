//! Production-path proofs: durable store, ProfileRef resolution, ingest apply.
//!
//! These tests call shipped APIs only (`ReviewedFormatStore`,
//! `ingest_path_with_policy_bindings_and_observer`, `match_profile_with_reviewed`).

use cd_core::log_analysis::import_preview::{preview_import_plan, ImportItemRole};
use cd_core::log_analysis::{
    apply_reviewed_format_bindings, ingest_path_with_policy_bindings_and_observer,
    match_profile_with_reviewed, resolve_profile_ref, select_format, validate_reviewed_format,
    FieldSlot, FormatSelection, ImportProfile, LogEmbedMode, LogEmbedPolicy, MultilineRule,
    ProfileFindingReason, ProfileRef, ProfileScope, ReviewedFormat, ReviewedFormatApplyBinding,
    ReviewedFormatApplyRequest, ReviewedFormatIngestBindings, ReviewedFormatResolveOutcome,
    ReviewedFormatStore, SafePattern, SourceGroupRule, TimeToken, TimestampGrammar,
    IMPORT_PROFILE_SCHEMA_ID, REVIEWED_FORMAT_SCHEMA_ID,
};
use cd_core::process_progress::{CancelFlag, NoopProcessProgress};
use std::fs;

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

fn sample_line() -> &'static str {
    "2024-05-03 12:24:22,729 INFO - Example message\n\tat Worker.run\n"
}

fn none_policy() -> LogEmbedPolicy {
    LogEmbedPolicy {
        mode: LogEmbedMode::None,
        cloud_content_leaves_machine: false,
        cloud_base_url: None,
        model_id: "none".into(),
        defer_above_source_bytes: None,
    }
}

#[test]
fn store_save_reopen_update_delete_survives_restart() {
    let dir = tempfile::tempdir().unwrap();
    let store = ReviewedFormatStore::open(dir.path().join("store")).unwrap();
    let f = app_log_format("prod.app-log", 1);
    assert!(validate_reviewed_format(&f).valid);
    store.save(&f).unwrap();
    let rev = store.revision().unwrap();
    drop(store);
    let store = ReviewedFormatStore::open(dir.path().join("store")).unwrap();
    assert_eq!(store.revision().unwrap(), rev);
    assert_eq!(
        store.load("prod.app-log", 1).unwrap().format_id,
        "prod.app-log"
    );
    let mut f2 = f.clone();
    f2.name = "Updated".into();
    store.update(&f2).unwrap();
    assert_eq!(store.load("prod.app-log", 1).unwrap().name, "Updated");
    assert!(store.delete("prod.app-log", 1).unwrap());
    assert!(store.load("prod.app-log", 1).is_err());
}

#[test]
fn profile_ref_unique_match_ambiguity_conflict_and_stale() {
    let dir = tempfile::tempdir().unwrap();
    let store = ReviewedFormatStore::open(dir.path().join("store")).unwrap();
    let f = app_log_format("prod.app-log", 1);
    store.save(&f).unwrap();
    let sample = sample_line();
    match resolve_profile_ref(&store, "prod.app-log", 1, "logs/app.log", sample).unwrap() {
        ReviewedFormatResolveOutcome::Match { identity } => {
            assert_eq!(identity.format_id, "prod.app-log");
        }
        other => panic!("{other:?}"),
    }
    match resolve_profile_ref(&store, "prod.app-log", 1, "logs/app.log", "{\"x\":1}\n").unwrap() {
        ReviewedFormatResolveOutcome::ContentStale { .. } => {}
        other => panic!("{other:?}"),
    }
    match resolve_profile_ref(&store, "missing", 1, "logs/app.log", sample).unwrap() {
        ReviewedFormatResolveOutcome::Missing => {}
        other => panic!("{other:?}"),
    }
    match resolve_profile_ref(&store, "prod.app-log", 99, "logs/app.log", sample).unwrap() {
        ReviewedFormatResolveOutcome::VersionDrift {
            expected_version: 99,
            ..
        } => {}
        other => panic!("{other:?}"),
    }

    let mut a = app_log_format("a.fmt", 1);
    let mut b = app_log_format("b.fmt", 1);
    a.priority = 5;
    b.priority = 5;
    match select_format(&[a, b], "logs/app.log", sample) {
        FormatSelection::Conflict { format_ids } => {
            assert_eq!(format_ids.len(), 2);
        }
        other => panic!("expected conflict, got {other:?}"),
    }
}

#[test]
fn match_profile_wires_reviewed_format_by_content() {
    let f = app_log_format("prod.app-log", 1);
    let dir = tempfile::tempdir().unwrap();
    let logs = dir.path().join("logs");
    fs::create_dir_all(&logs).unwrap();
    fs::write(logs.join("app.log"), sample_line()).unwrap();
    let plan = preview_import_plan(&logs, None).unwrap();
    // Ensure representative sample text is present for content match.
    let mut report = plan.report.clone();
    for item in &mut report.items {
        if item.identity.contains("app.log") && item.representative.is_none() {
            item.representative = Some(sample_line().trim().to_string());
        }
    }
    let import = ImportProfile {
        schema_id: IMPORT_PROFILE_SCHEMA_ID.into(),
        min_reader_version: 1,
        profile_id: "team.prod".into(),
        version: 1,
        scope: ProfileScope {
            label: "prod".into(),
        },
        name: "prod".into(),
        source_groups: vec![SourceGroupRule {
            group_id: "apps".into(),
            include: vec![SafePattern::new("**/app.log*")],
            exclude: vec![],
            role: ImportItemRole::Log,
            format_profile: Some(ProfileRef {
                id: "prod.app-log".into(),
                version: 1,
            }),
            framing_profile: None,
            timestamp_policy: None,
        }],
    };
    let matched = match_profile_with_reviewed(&import, &report, &[f]);
    assert!(
        matched
            .findings
            .iter()
            .any(|f| matches!(f.reason, ProfileFindingReason::FormatAgrees)),
        "{:?}",
        matched.findings
    );
}

#[test]
fn duplicate_basename_sources_stay_distinct_under_bindings() {
    let f = app_log_format("prod.app-log", 1);
    let mut bindings = ReviewedFormatIngestBindings::new();
    bindings.insert("region-a/app.log".into(), f.clone());
    bindings.insert("region-b/app.log".into(), f);
    assert!(bindings.get("region-a/app.log").is_some());
    assert!(bindings.get("region-b/app.log").is_some());
    assert!(bindings.get("outer.zip!/region-a/app.log").is_some());
    assert!(bindings.get("region-c/app.log").is_none());
}

#[test]
fn ingest_direct_dir_zip_nested_with_bindings_cancel_and_retry() {
    let root = tempfile::tempdir().unwrap();
    let store = ReviewedFormatStore::open(root.path().join("store")).unwrap();
    let format = app_log_format("prod.app-log", 1);
    store.save(&format).unwrap();
    let rev = store.revision().unwrap();
    let digest = format.digest();

    let logs = root.path().join("direct");
    fs::create_dir_all(&logs).unwrap();
    fs::write(logs.join("app.log"), sample_line()).unwrap();
    let bindings = apply_reviewed_format_bindings(
        &store,
        &ReviewedFormatApplyRequest {
            expected_store_revision: rev,
            bindings: vec![ReviewedFormatApplyBinding {
                source_identity: "app.log".into(),
                format_id: "prod.app-log".into(),
                version: 1,
                digest: digest.clone(),
            }],
        },
    )
    .unwrap();
    let cache = root.path().join("cache-direct");
    let report = ingest_path_with_policy_bindings_and_observer(
        &cache,
        &logs,
        "direct",
        &none_policy(),
        None,
        &NoopProcessProgress,
        None,
        None,
        Some(&bindings),
    )
    .unwrap();
    assert!(
        report.stats.lines >= 1,
        "direct ingest events={}",
        report.stats.lines
    );
    assert!(
        report
            .stats
            .timestamp_provenance_counts
            .get("unresolved_local")
            .copied()
            .unwrap_or(0)
            >= 1,
        "offset-less grammar must not invent wall clock: {:?}",
        report.stats.timestamp_provenance_counts
    );

    let cancel = CancelFlag::new();
    cancel.cancel();
    let err = ingest_path_with_policy_bindings_and_observer(
        &root.path().join("cache-cancel"),
        &logs,
        "cancel",
        &none_policy(),
        None,
        &NoopProcessProgress,
        Some(&cancel),
        None,
        Some(&bindings),
    )
    .unwrap_err();
    assert!(matches!(err, cd_core::error::CoreError::Cancelled));
    let report = ingest_path_with_policy_bindings_and_observer(
        &root.path().join("cache-retry"),
        &logs,
        "retry",
        &none_policy(),
        None,
        &NoopProcessProgress,
        None,
        None,
        Some(&bindings),
    )
    .unwrap();
    assert!(report.stats.lines >= 1);

    let zip_path = root.path().join("pack.zip");
    {
        use std::io::Write;
        let file = fs::File::create(&zip_path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default();
        zip.start_file("logs/app.log", opts).unwrap();
        zip.write_all(sample_line().as_bytes()).unwrap();
        zip.finish().unwrap();
    }
    let plan = preview_import_plan(&zip_path, None).unwrap();
    let app_identity = plan
        .report
        .items
        .iter()
        .find(|i| i.identity.contains("app.log"))
        .map(|i| i.identity.clone())
        .expect("app.log in zip preview");
    let bindings = apply_reviewed_format_bindings(
        &store,
        &ReviewedFormatApplyRequest {
            expected_store_revision: rev,
            bindings: vec![ReviewedFormatApplyBinding {
                source_identity: app_identity,
                format_id: "prod.app-log".into(),
                version: 1,
                digest: digest.clone(),
            }],
        },
    )
    .unwrap();
    let report = ingest_path_with_policy_bindings_and_observer(
        &root.path().join("cache-zip"),
        &zip_path,
        "zip",
        &none_policy(),
        None,
        &NoopProcessProgress,
        None,
        None,
        Some(&bindings),
    )
    .unwrap();
    assert!(report.stats.lines >= 1, "zip events={}", report.stats.lines);

    let outer = root.path().join("outer.zip");
    {
        use std::io::Write;
        let inner_bytes = {
            let cursor = std::io::Cursor::new(Vec::new());
            let mut zip = zip::ZipWriter::new(cursor);
            let opts = zip::write::SimpleFileOptions::default();
            zip.start_file("app.log", opts).unwrap();
            zip.write_all(sample_line().as_bytes()).unwrap();
            zip.finish().unwrap().into_inner()
        };
        let file = fs::File::create(&outer).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default();
        zip.start_file("nested.zip", opts).unwrap();
        zip.write_all(&inner_bytes).unwrap();
        zip.finish().unwrap();
    }
    let plan = preview_import_plan(&outer, None).unwrap();
    if let Some(nested_id) = plan
        .report
        .items
        .iter()
        .find(|i| i.identity.contains("app.log"))
        .map(|i| i.identity.clone())
    {
        let bindings = apply_reviewed_format_bindings(
            &store,
            &ReviewedFormatApplyRequest {
                expected_store_revision: rev,
                bindings: vec![ReviewedFormatApplyBinding {
                    source_identity: nested_id,
                    format_id: "prod.app-log".into(),
                    version: 1,
                    digest,
                }],
            },
        )
        .unwrap();
        let report = ingest_path_with_policy_bindings_and_observer(
            &root.path().join("cache-nested"),
            &outer,
            "nested",
            &none_policy(),
            None,
            &NoopProcessProgress,
            None,
            None,
            Some(&bindings),
        )
        .unwrap();
        assert!(
            report.stats.lines >= 1,
            "nested events={}",
            report.stats.lines
        );
    }
}

#[test]
fn apply_fails_closed_on_stale_store_revision() {
    let dir = tempfile::tempdir().unwrap();
    let store = ReviewedFormatStore::open(dir.path()).unwrap();
    let f = app_log_format("prod.app-log", 1);
    store.save(&f).unwrap();
    let dig = f.digest();
    let err = apply_reviewed_format_bindings(
        &store,
        &ReviewedFormatApplyRequest {
            expected_store_revision: 0,
            bindings: vec![ReviewedFormatApplyBinding {
                source_identity: "app.log".into(),
                format_id: "prod.app-log".into(),
                version: 1,
                digest: dig,
            }],
        },
    )
    .unwrap_err();
    assert!(err.to_string().contains("revision stale"), "{err}");
}
