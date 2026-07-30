#[path = "support/log_lab_generator.rs"]
mod log_lab_generator;

use cd_core::index::KeywordIndex;
use cd_core::investigations::InvestigationStore;
use cd_core::log_analysis::{
    activate_template_suppression, add_line_bookmark, cluster_problems, export_corpus_zip,
    import_corpus_zip_path, ingest_path, ingest_path_with_observer, list_bookmarks,
    load_suppression_document, mutate_template_suppression_rule, preview_template_suppression,
    query_event_count, query_event_neighborhood, query_event_rows, query_events, query_facets,
    query_shared_timeline_summary, query_source_catalog, query_timeline_summary, search_events,
    search_events_advanced, timeline, ActivateSuppressionPreview, EventNeighborhoodQuery,
    EventQuery, EventSearchQuery, LogCorpus, LogSourceCatalogQuery, NewSuppressionPreview,
    SearchMatchMode, SharedTimelineSummaryQuery, SuppressionRuleMutation, SuppressionRuleOrigin,
    TimeQuality, TimelineSummaryQuery, MAX_EVENT_PAGE, MAX_REGEX_SCAN_EVENTS,
};
use cd_core::process_progress::{
    CancelFlag, ProcessProgress, ProcessProgressObserver, RecordingProcessProgress,
};
use cd_core::tool_host::{
    ToolHost, BROAD_LOG_TRIAGE_BRIEF_MAX_BYTES, BROAD_LOG_TRIAGE_IDENTITY_CAP,
};
use cd_core::workspace::Workspace;
use log_lab_generator::{
    generate_behavior, generate_scale, generate_triage_stress, load_behavior_manifest,
    load_triage_stress_manifest, verify_safety, write_performance_template, BehaviorControls,
    DEFAULT_TRIAGE_STRESS_EVENT_COUNT, MEDIUM_EVENT_COUNT, MEDIUM_PROFILE,
    MIN_TRIAGE_STRESS_EVENT_COUNT, TRIAGE_STRESS_INCIDENT_REPETITIONS,
    TRIAGE_STRESS_PARSER_TEMPLATE_COUNT, TRIAGE_STRESS_SOURCE_COUNT, UI_MEDIUM_PROFILE,
};
use serde_json::Value;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Instant;

fn fixture_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join("fixtures/log-lab")
}

fn scenario_import(name: &str) -> PathBuf {
    fixture_root().join("scenarios").join(name).join("import")
}

fn truth(name: &str) -> Value {
    serde_json::from_slice(
        &fs::read(
            fixture_root()
                .join("scenarios")
                .join(name)
                .join("truth/manifest.json"),
        )
        .unwrap(),
    )
    .unwrap()
}

fn query(
    corpus: &LogCorpus,
    extra: impl FnOnce(&mut EventQuery),
) -> Vec<cd_core::log_analysis::ExplorerEvent> {
    let mut query = EventQuery {
        limit: MAX_EVENT_PAGE,
        ..Default::default()
    };
    extra(&mut query);
    query_events(corpus, &query).unwrap().events
}

fn assert_no_raw_values(bytes: &[u8]) {
    for forbidden in [
        b"sk-LOG-LAB-INVALID-abcdefghijklmnop".as_slice(),
        b"LOG-LAB-INVALID-BEARER-abcdefghijklmnop".as_slice(),
    ] {
        assert!(
            !bytes
                .windows(forbidden.len())
                .any(|window| window == forbidden),
            "raw synthetic credential survived"
        );
    }
}

#[test]
fn log_lab_checkout_directory_zip_query_bookmark_and_package_round_trip() {
    let workspace = tempfile::tempdir().unwrap();
    let cache = workspace.path().join("cache");
    let expected = truth("checkout-cascade");
    let expected_events = expected["expected"]["events"].as_u64().unwrap();

    let report = ingest_path(
        &cache,
        &scenario_import("checkout-cascade"),
        "checkout-cascade",
        None,
        "none",
    )
    .unwrap();
    assert_eq!(report.stats.lines, expected_events);
    assert_eq!(report.stats.files, 6);
    assert_eq!(report.stats.format_counts["json"], 22);
    assert_eq!(report.stats.format_counts["logfmt"], 13);

    let corpus = LogCorpus::open(&cache, &report.corpus_id).unwrap();
    let facets = query_facets(&corpus, &EventQuery::default()).unwrap();
    for source in [
        "api/app.jsonl",
        "audit/deploy.jsonl",
        "db/database.log",
        "edge/access.jsonl",
        "queue/events.jsonl",
        "worker/worker.log",
    ] {
        assert!(
            facets.sources.contains_key(source),
            "missing source {source}"
        );
        assert!(!source.starts_with('/'));
    }

    let poison = query(&corpus, |query| {
        query.keyword = Some("job-7f3a".into());
    });
    assert!(poison.len() >= 6, "poison evidence={poison:?}");
    assert!(
        poison
            .iter()
            .any(|event| event.source == "queue/events.jsonl"),
        "{poison:?}"
    );
    assert!(
        poison.iter().any(|event| event.source == "api/app.jsonl"),
        "{poison:?}"
    );

    let worker_events = query(&corpus, |query| {
        query.sources = vec!["worker/worker.log".into()];
    });
    assert!(
        worker_events
            .iter()
            .any(|event| event.message.contains("event_id=worker-loop")),
        "{worker_events:?}"
    );

    let trace = query(&corpus, |query| {
        query.trace_id = Some("trace-checkout-42".into());
    });
    assert!(trace.iter().any(|event| event.source == "api/app.jsonl"));
    assert!(trace
        .iter()
        .any(|event| event.source == "worker/worker.log"));
    assert!(trace.iter().any(|event| event.source == "db/database.log"));
    assert!(trace
        .iter()
        .any(|event| event.source == "edge/access.jsonl"));

    let errors = query(&corpus, |query| {
        query.levels = vec!["error".into()];
        query.sources = vec!["edge/access.jsonl".into()];
    });
    assert_eq!(errors.len(), 1);
    assert!(errors[0].message.contains("event_id=edge-504"));

    let hidden_truth = query(&corpus, |query| {
        query.keyword = Some("Configuration shrink plus repeated poison-job".into());
    });
    assert!(hidden_truth.is_empty(), "truth manifest entered the corpus");

    let clue = worker_events
        .iter()
        .find(|event| event.message.contains("event_id=worker-loop"))
        .unwrap();
    let bookmark = add_line_bookmark(
        &corpus,
        clue.seq,
        "poison retry loop",
        Some("stable Log Lab clue".into()),
        None,
        Some(clue.ts),
    )
    .unwrap();
    let corpus_id = report.corpus_id.clone();
    drop(corpus);

    let reopened = LogCorpus::open(&cache, &corpus_id).unwrap();
    assert!(list_bookmarks(&reopened)
        .unwrap()
        .iter()
        .any(|saved| saved.id == bookmark.id && saved.seq_from == clue.seq));
    drop(reopened);

    let package_path = workspace.path().join("checkout.cdlog.zip");
    export_corpus_zip(&cache, &corpus_id, &package_path).unwrap();
    let imported = import_corpus_zip_path(&cache, &package_path).unwrap();
    assert_ne!(imported.corpus_id, corpus_id);
    let package_corpus = LogCorpus::open(&cache, &imported.corpus_id).unwrap();
    assert_eq!(package_corpus.event_count() as u64, expected_events);
    drop(package_corpus);

    let zip_cache = workspace.path().join("zip-cache");
    let zip_report = ingest_path(
        &zip_cache,
        &fixture_root().join("archives/checkout-cascade.zip"),
        "checkout-cascade-zip",
        None,
        "none",
    )
    .unwrap();
    assert_eq!(zip_report.stats.lines, expected_events);
    assert_eq!(zip_report.stats.files, 6);
    let zip_corpus = LogCorpus::open(&zip_cache, &zip_report.corpus_id).unwrap();
    assert_eq!(
        query_facets(&zip_corpus, &EventQuery::default())
            .unwrap()
            .sources,
        facets.sources
    );

    eprintln!(
        "PASS checkout events={} templates={} directory_id={} zip_id={} package_id={}",
        expected_events,
        report.stats.templates,
        corpus_id,
        zip_report.corpus_id,
        imported.corpus_id
    );
}

#[test]
fn log_lab_multiformat_provenance_time_quality_and_redaction_are_real() {
    let workspace = tempfile::tempdir().unwrap();

    let provenance_cache = workspace.path().join("provenance-cache");
    let report = ingest_path(
        &provenance_cache,
        &scenario_import("source-provenance"),
        "source-provenance",
        None,
        "none",
    )
    .unwrap();
    let corpus = LogCorpus::open(&provenance_cache, &report.corpus_id).unwrap();
    let facets = query_facets(&corpus, &EventQuery::default()).unwrap();
    assert!(facets.sources.contains_key("region-a/app.jsonl"));
    assert!(facets.sources.contains_key("region-b/app.jsonl"));
    assert_ne!("region-a/app.jsonl", "region-b/app.jsonl");
    assert!(facets
        .sources
        .keys()
        .all(|source| !source.starts_with('/') && !source.contains("/Users/")));
    for format in ["plain", "logfmt", "syslog", "json"] {
        assert!(
            report.stats.format_counts.contains_key(format),
            "multi-file detection lost {format}: {:?}",
            report.stats.format_counts
        );
    }
    let beta = query(&corpus, |query| {
        query.keyword = Some("marker=beta".into());
    });
    assert_eq!(beta.len(), 1);
    assert_eq!(beta[0].source, "region-b/app.jsonl");

    let mixed_cache = workspace.path().join("mixed-cache");
    let mixed_report = ingest_path(
        &mixed_cache,
        &scenario_import("mixed-time-quality"),
        "mixed-time",
        None,
        "none",
    )
    .unwrap();
    let mixed = LogCorpus::open(&mixed_cache, &mixed_report.corpus_id).unwrap();
    assert_eq!(
        query_facets(&mixed, &EventQuery::default())
            .unwrap()
            .time_quality,
        TimeQuality::Mixed
    );
    let wall = query_events(
        &mixed,
        &EventQuery {
            sources: vec!["01-wall.jsonl".into()],
            limit: 50,
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(wall.time_quality, TimeQuality::Wall);
    let order = query_events(
        &mixed,
        &EventQuery {
            sources: vec!["02-order.log".into()],
            limit: 50,
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(order.time_quality, TimeQuality::OrderOnly);

    let redaction_cache = workspace.path().join("redaction-cache");
    let redaction_report = ingest_path(
        &redaction_cache,
        &scenario_import("redaction"),
        "redaction",
        None,
        "none",
    )
    .unwrap();
    let redacted = LogCorpus::open(&redaction_cache, &redaction_report.corpus_id).unwrap();
    let events = query(&redacted, |_| {});
    assert_eq!(events.len(), 3);
    for event in &events {
        assert_no_raw_values(event.message.as_bytes());
    }
    let hits = search_events(
        &redacted,
        &EventSearchQuery {
            query: Some("fictional-user".into()),
            semantic: false,
            k: 20,
            ..Default::default()
        },
        None,
    )
    .unwrap();
    assert!(!hits.is_empty());
    assert_no_raw_values(format!("{hits:?}").as_bytes());
    let redaction_id = redaction_report.corpus_id.clone();
    drop(redacted);

    let package_path = workspace.path().join("redaction.cdlog.zip");
    export_corpus_zip(&redaction_cache, &redaction_id, &package_path).unwrap();
    let file = fs::File::open(package_path).unwrap();
    let mut archive = zip::ZipArchive::new(file).unwrap();
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).unwrap();
        let mut bytes = Vec::new();
        entry.read_to_end(&mut bytes).unwrap();
        assert_no_raw_values(&bytes);
    }

    eprintln!(
        "PASS multiformat={:?} mixed_quality={:?} redacted_events={}",
        report.stats.format_counts,
        query_facets(&mixed, &EventQuery::default())
            .unwrap()
            .time_quality,
        events.len()
    );
}

fn write_raw_zip(path: &Path, entries: &[(&str, &[u8])]) {
    let file = fs::File::create(path).unwrap();
    let mut zip = zip::ZipWriter::new(file);
    let options =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    for (name, body) in entries {
        zip.start_file(*name, options).unwrap();
        zip.write_all(body).unwrap();
    }
    zip.finish().unwrap();
}

fn replace_all_same_len(mut bytes: Vec<u8>, from: &[u8], to: &[u8]) -> Vec<u8> {
    assert_eq!(from.len(), to.len());
    for offset in 0..=bytes.len().saturating_sub(from.len()) {
        if bytes[offset..].starts_with(from) {
            bytes[offset..offset + from.len()].copy_from_slice(to);
        }
    }
    bytes
}

#[test]
fn log_lab_importer_edges_are_honest_and_hostile_archives_fail_closed() {
    let workspace = tempfile::tempdir().unwrap();
    let cache = workspace.path().join("cache");
    let report = ingest_path(
        &cache,
        &scenario_import("importer-edge-cases"),
        "edge-cases",
        None,
        "none",
    )
    .unwrap();
    assert_eq!(report.stats.discovered_files, 4);
    assert_eq!(report.stats.files, 1);
    assert_eq!(report.stats.excluded_files, 2);
    assert_eq!(report.stats.failed_files, 0);
    assert_eq!(report.stats.ignored_files, 1);
    assert!(report.stats.partial);
    assert_eq!(report.stats.exclusion_counts["binary"], 1);
    assert_eq!(report.stats.exclusion_counts["empty"], 1);
    assert_eq!(report.stats.exclusion_counts["hidden"], 1);

    let baseline_ids = LogCorpus::list_ids(&cache).unwrap();
    for (name, entries) in [
        (
            "absolute.zip",
            vec![("/absolute.log", b"INFO no\n".as_slice())],
        ),
        ("drive.zip", vec![("C:/drive.log", b"INFO no\n".as_slice())]),
        (
            "traversal.zip",
            vec![("../escape.log", b"INFO no\n".as_slice())],
        ),
        (
            "backslash.zip",
            vec![("nested\\escape.log", b"INFO no\n".as_slice())],
        ),
        (
            "ambiguous.zip",
            vec![("nested//double.log", b"INFO no\n".as_slice())],
        ),
        (
            "duplicate.zip",
            vec![
                ("same0.log", b"INFO first\n".as_slice()),
                ("same1.log", b"INFO second\n".as_slice()),
            ],
        ),
    ] {
        let path = workspace.path().join(name);
        write_raw_zip(&path, &entries);
        if name == "duplicate.zip" {
            let bytes = fs::read(&path).unwrap();
            let bytes = replace_all_same_len(bytes, b"same0.log", b"same_.log");
            let bytes = replace_all_same_len(bytes, b"same1.log", b"same_.log");
            fs::write(&path, bytes).unwrap();
        }
        let error = ingest_path(&cache, &path, name, None, "none")
            .expect_err("hostile raw log archive must be rejected");
        let diagnostic = format!("{error}");
        assert!(
            diagnostic.contains("zip")
                || diagnostic.contains("archive")
                || diagnostic.contains("entry"),
            "{name}: {diagnostic}"
        );
        assert_eq!(
            LogCorpus::list_ids(&cache).unwrap(),
            baseline_ids,
            "{name} published a corpus"
        );
        assert!(!cache.join(".log_ingest_staging").exists());
    }

    for (name, entries) in [
        ("binary-only.zip", vec![("binary.log", b"x\0y".as_slice())]),
        ("directory-only.zip", vec![("folder/", b"".as_slice())]),
    ] {
        let path = workspace.path().join(name);
        write_raw_zip(&path, &entries);
        let error = ingest_path(&cache, &path, name, None, "none")
            .expect_err("zero-safe-file archive must fail");
        assert!(
            format!("{error}").contains("no safe") || format!("{error}").contains("no importable"),
            "{name}: {error}"
        );
        assert_eq!(LogCorpus::list_ids(&cache).unwrap(), baseline_ids);
        assert!(!cache.join(".log_ingest_staging").exists());
    }

    eprintln!(
        "PASS importer discovered={} imported={} excluded={} ignored={} hostile_archives=8",
        report.stats.discovered_files,
        report.stats.files,
        report.stats.excluded_files,
        report.stats.ignored_files
    );
}

#[test]
fn log_lab_medium_100k_streams_pages_and_cancels_without_publication() {
    let workspace = tempfile::tempdir().unwrap();
    let generated = workspace.path().join("generated");
    let generation = generate_scale(&generated, MEDIUM_PROFILE, MEDIUM_EVENT_COUNT).unwrap();
    assert_eq!(generation.events, MEDIUM_EVENT_COUNT);
    verify_safety(&generated).unwrap();

    let cache = workspace.path().join("cache");
    let recorder = RecordingProcessProgress::default();
    let started = Instant::now();
    let report = ingest_path_with_observer(
        &cache,
        &generated.join("scenarios/scale/import"),
        "log-lab-medium",
        None,
        "none",
        &recorder,
        None,
    )
    .unwrap();
    let elapsed = started.elapsed();
    assert_eq!(report.stats.lines as usize, MEDIUM_EVENT_COUNT);
    assert_eq!(report.stats.files, 4);
    assert!(report.stats.source_bytes > 1_000_000);

    let corpus = LogCorpus::open(&cache, &report.corpus_id).unwrap();
    let first = query_events(
        &corpus,
        &EventQuery {
            limit: 200,
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(first.events.len(), 200);
    assert_eq!(first.total_matched as usize, MEDIUM_EVENT_COUNT);
    let second = query_events(
        &corpus,
        &EventQuery {
            after_seq: first.next_cursor,
            after_ts: first.next_ts,
            limit: 200,
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(second.events.len(), 200);
    assert!(first
        .events
        .iter()
        .all(|left| second.events.iter().all(|right| left.seq != right.seq)));
    drop(corpus);

    let before_cancel = LogCorpus::list_ids(&cache).unwrap();
    let cancel = CancelFlag::new();
    struct CancelAfterLines {
        flag: CancelFlag,
        recorder: RecordingProcessProgress,
    }
    impl ProcessProgressObserver for CancelAfterLines {
        fn progress(&self, update: ProcessProgress) {
            if update.lines_processed.unwrap_or_default() >= 4_000 {
                self.flag.cancel();
            }
            self.recorder.progress(update);
        }
    }
    let observer = CancelAfterLines {
        flag: cancel.clone(),
        recorder: RecordingProcessProgress::default(),
    };
    let error = ingest_path_with_observer(
        &cache,
        &generated.join("scenarios/scale/import"),
        "must-cancel",
        None,
        "none",
        &observer,
        Some(&cancel),
    )
    .unwrap_err();
    assert!(format!("{error}").contains("cancelled"));
    assert_eq!(LogCorpus::list_ids(&cache).unwrap(), before_cancel);
    assert!(!cache.join(".log_ingest_staging").exists());

    let updates = recorder.updates.lock().unwrap();
    let byte_updates = updates
        .iter()
        .filter_map(|update| update.bytes_processed)
        .collect::<Vec<_>>();
    assert!(byte_updates.windows(2).all(|pair| pair[0] <= pair[1]));

    eprintln!(
        "PASS medium events={} files={} source_bytes={} elapsed_ms={} first_page={} second_page={} tree_sha256={}",
        report.stats.lines,
        report.stats.files,
        report.stats.source_bytes,
        elapsed.as_millis(),
        first.events.len(),
        second.events.len(),
        generation.tree_sha256
    );
}

#[test]
fn log_lab_behavior_ui_profile_imports_pages_and_finds_deep_sentinels() {
    // Full ui-medium defaults are 100k; use a reduced but still multi-page count
    // so the default suite stays practical while proving the product path.
    let events = 5_000usize;
    let controls = BehaviorControls::for_profile(UI_MEDIUM_PROFILE, Some(events)).unwrap();
    assert!(controls.source_count >= 6);
    assert!(controls.span_secs >= 2 * 86_400);

    let workspace = tempfile::tempdir().unwrap();
    let generated = workspace.path().join("behavior");
    let gen_started = Instant::now();
    let generation = generate_behavior(&generated, &controls).unwrap();
    let generation_ms = gen_started.elapsed().as_millis();
    assert_eq!(generation.events, events);
    verify_safety(&generated).unwrap();

    let manifest = load_behavior_manifest(&generated).unwrap();
    let deep_token = manifest["investigation"]["sentinels"]["find_deep"]["token"]
        .as_str()
        .unwrap()
        .to_string();
    let beyond_page = manifest["investigation"]["sentinels"]["find_beyond_first_page"]["token"]
        .as_str()
        .unwrap()
        .to_string();
    let bookmark_evict = manifest["investigation"]["sentinels"]["bookmark_evict_window"]["token"]
        .as_str()
        .unwrap()
        .to_string();

    let cache = workspace.path().join("cache");
    let import_started = Instant::now();
    let report = ingest_path(
        &cache,
        &generated.join("scenarios/behavior-scale/import"),
        "behavior-ui",
        None,
        "none",
    )
    .unwrap();
    let import_ms = import_started.elapsed().as_millis();
    assert_eq!(report.stats.lines as usize, events);
    assert!(report.stats.files as usize >= controls.source_count);

    let corpus = LogCorpus::open(&cache, &report.corpus_id).unwrap();
    assert_eq!(
        query_facets(&corpus, &EventQuery::default())
            .unwrap()
            .time_quality,
        TimeQuality::Wall,
        "the wall-time profile must not introduce synthetic-order rows"
    );
    let page_started = Instant::now();
    let first = query_events(
        &corpus,
        &EventQuery {
            limit: 100,
            ..Default::default()
        },
    )
    .unwrap();
    let first_page_ms = page_started.elapsed().as_millis();
    assert_eq!(first.events.len(), 100);
    assert_eq!(first.total_matched as usize, events);

    // Deep sentinel must be findable via keyword search without loading the full
    // corpus into the caller (search returns bounded hits).
    let seek_started = Instant::now();
    let deep_hits = search_events(
        &corpus,
        &EventSearchQuery {
            query: Some(deep_token.clone()),
            semantic: false,
            k: 20,
            ..Default::default()
        },
        None,
    )
    .unwrap();
    let deep_seek_ms = seek_started.elapsed().as_millis();
    assert!(
        !deep_hits.is_empty(),
        "deep sentinel {deep_token} must be searchable"
    );
    assert!(deep_hits
        .iter()
        .any(|hit| hit.event.message.contains(&deep_token)));

    let page_hits = search_events(
        &corpus,
        &EventSearchQuery {
            query: Some(beyond_page.clone()),
            semantic: false,
            k: 20,
            ..Default::default()
        },
        None,
    )
    .unwrap();
    assert!(!page_hits.is_empty(), "{beyond_page}");

    let bookmark_hits = search_events(
        &corpus,
        &EventSearchQuery {
            query: Some(bookmark_evict.clone()),
            semantic: false,
            k: 20,
            ..Default::default()
        },
        None,
    )
    .unwrap();
    assert!(!bookmark_hits.is_empty(), "{bookmark_evict}");
    let clue = bookmark_hits
        .iter()
        .find(|hit| hit.event.message.contains(&bookmark_evict))
        .unwrap();
    let bookmark = add_line_bookmark(
        &corpus,
        clue.event.seq,
        "eviction sentinel",
        Some("behavior profile #542".into()),
        None,
        Some(clue.event.ts),
    )
    .unwrap();
    assert_eq!(bookmark.seq_from, clue.event.seq);

    let perf_path = write_performance_template(&generated, &controls, &generation).unwrap();
    let mut perf: Value = serde_json::from_slice(&fs::read(&perf_path).unwrap()).unwrap();
    perf["measurements"]["generation_ms"] = serde_json::json!(generation_ms);
    perf["measurements"]["import_ms"] = serde_json::json!(import_ms);
    perf["measurements"]["source_bytes"] = serde_json::json!(report.stats.source_bytes);
    perf["measurements"]["first_page_ms"] = serde_json::json!(first_page_ms);
    perf["measurements"]["deep_seek_ms"] = serde_json::json!(deep_seek_ms);
    perf["build"]["mode"] = serde_json::json!("test");
    fs::write(
        workspace.path().join("performance-record.sample.json"),
        serde_json::to_vec_pretty(&perf).unwrap(),
    )
    .unwrap();

    eprintln!(
        "PASS behavior-ui events={} sources={} generation_ms={} import_ms={} first_page_ms={} deep_seek_ms={} source_bytes={} tree_sha256={} (one-machine observation; not a universal claim)",
        events,
        report.stats.files,
        generation_ms,
        import_ms,
        first_page_ms,
        deep_seek_ms,
        report.stats.source_bytes,
        generation.tree_sha256
    );
}

#[test]
fn log_lab_behavior_profiles_keep_their_declared_time_quality_after_import() {
    for (quality, expected) in [
        ("wall", TimeQuality::Wall),
        ("mixed", TimeQuality::Mixed),
        ("order_only", TimeQuality::OrderOnly),
    ] {
        let mut controls = BehaviorControls::for_profile(UI_MEDIUM_PROFILE, Some(900)).unwrap();
        controls.profile = format!("time-quality-{quality}");
        controls.source_count = 10;
        controls.time_quality = quality.into();
        controls.long_line_percent = 6;
        controls.rotation_every = 0;

        let workspace = tempfile::tempdir().unwrap();
        let generated = workspace.path().join("behavior");
        generate_behavior(&generated, &controls).unwrap();
        let manifest = load_behavior_manifest(&generated).unwrap();
        assert_eq!(manifest["expected"]["time_quality"], quality);
        assert!(
            manifest["investigation"]["multiline_count"]
                .as_u64()
                .unwrap_or_default()
                > 0,
            "{quality} profile must exercise escaped multiline events"
        );

        let cache = workspace.path().join("cache");
        let report = ingest_path(
            &cache,
            &generated.join("scenarios/behavior-scale/import"),
            &format!("behavior-{quality}"),
            None,
            "none",
        )
        .unwrap();
        let corpus = LogCorpus::open(&cache, &report.corpus_id).unwrap();
        assert_eq!(
            query_facets(&corpus, &EventQuery::default())
                .unwrap()
                .time_quality,
            expected,
            "generated {quality} profile contradicted its manifest"
        );
        if quality == "wall" {
            assert_eq!(
                report
                    .stats
                    .format_counts
                    .get("plain")
                    .copied()
                    .unwrap_or_default(),
                0,
                "wall profile contained rows that fell back to order-only parsing"
            );
        }
    }
}

#[test]
fn log_lab_triage_stress_minimum_product_path_keeps_rare_incident_signal() {
    let workspace = tempfile::tempdir().unwrap();
    let generated = workspace.path().join("triage-stress");
    let generation = generate_triage_stress(&generated, MIN_TRIAGE_STRESS_EVENT_COUNT).unwrap();
    verify_safety(&generated).unwrap();
    let manifest = load_triage_stress_manifest(&generated).unwrap();
    let import_root = generated.join("scenarios/triage-stress/import");
    let report = ingest_path(
        &workspace.path().join("cache"),
        &import_root,
        "triage-stress-minimum",
        None,
        "none",
    )
    .unwrap();

    assert_eq!(generation.events, MIN_TRIAGE_STRESS_EVENT_COUNT);
    assert_eq!(report.stats.lines as usize, MIN_TRIAGE_STRESS_EVENT_COUNT);
    assert_eq!(report.stats.files as usize, TRIAGE_STRESS_SOURCE_COUNT);
    assert_eq!(
        report.stats.templates as usize,
        TRIAGE_STRESS_PARSER_TEMPLATE_COUNT
    );
    let corpus = LogCorpus::open(&workspace.path().join("cache"), &report.corpus_id).unwrap();
    let facets = query_facets(&corpus, &EventQuery::default()).unwrap();
    assert_eq!(facets.time_quality, TimeQuality::Wall);
    assert_eq!(facets.levels["error"], 1_800);
    assert_eq!(facets.levels["warn"], 1_500);
    assert_eq!(facets.levels["debug"], 300);
    assert_eq!(facets.levels["info"], 6_400);

    let saturation = search_events(
        &corpus,
        &EventSearchQuery {
            query: Some("CDLAB2004".into()),
            semantic: false,
            k: 20,
            ..Default::default()
        },
        None,
    )
    .unwrap();
    assert_eq!(saturation.len(), 16);
    assert!(saturation.iter().all(|hit| {
        hit.event.source == "db/database.log"
            && hit.event.message.contains("database pool exhausted")
            && !hit.event.message.contains("incident_id=")
            && !hit.event.message.contains("role=")
    }));

    let clusters = cluster_problems(&corpus, 40).unwrap();
    assert!(clusters.len() <= 40);
    assert!(
        clusters
            .iter()
            .flat_map(|cluster| &cluster.exemplars)
            .any(|example| example.contains("CDLAB2004")
                || example.contains("CDLAB3102")
                || example.contains("CDLAB4203")),
        "bounded clustering lost every rare severe incident signal"
    );
    let buckets = timeline(&corpus, 60, None, None).unwrap();
    assert_eq!(
        buckets.iter().map(|bucket| bucket.count).sum::<u64>(),
        MIN_TRIAGE_STRESS_EVENT_COUNT as u64
    );
    assert_eq!(
        manifest["expected"]["parser_templates_after_import"],
        report.stats.templates
    );
}

/// Explicit local #744/#745 scale vector. The generated 250k tree lives only in
/// a temporary directory and is never checked into the repository.
#[test]
#[ignore = "explicit 250k triage-stress product-path proof"]
fn log_lab_triage_stress_250k_product_path_is_bounded_and_truthful() {
    let workspace = tempfile::tempdir().unwrap();
    let generated = workspace.path().join("triage-stress-250k");
    let generation_started = Instant::now();
    let generation = generate_triage_stress(&generated, DEFAULT_TRIAGE_STRESS_EVENT_COUNT).unwrap();
    let generation_ms = generation_started.elapsed().as_millis();
    verify_safety(&generated).unwrap();
    let manifest = load_triage_stress_manifest(&generated).unwrap();

    let cache = workspace.path().join("cache");
    let import_started = Instant::now();
    let report = ingest_path(
        &cache,
        &generated.join("scenarios/triage-stress/import"),
        "triage-stress-250k",
        None,
        "none",
    )
    .unwrap();
    let import_ms = import_started.elapsed().as_millis();
    assert_eq!(report.stats.lines, DEFAULT_TRIAGE_STRESS_EVENT_COUNT as u64);
    assert_eq!(report.stats.files as usize, TRIAGE_STRESS_SOURCE_COUNT);
    assert_eq!(
        report.stats.templates as usize,
        TRIAGE_STRESS_PARSER_TEMPLATE_COUNT
    );

    let cold_open_started = Instant::now();
    let corpus = LogCorpus::open(&cache, &report.corpus_id).unwrap();
    let cold_open_ms = cold_open_started.elapsed().as_millis();

    let summary_started = Instant::now();
    let summary = corpus.summary();
    let summary_ms = summary_started.elapsed().as_millis();
    assert_eq!(
        summary.event_count,
        DEFAULT_TRIAGE_STRESS_EVENT_COUNT as u64
    );

    let dominant_template = corpus
        .list_templates()
        .into_iter()
        .max_by_key(|row| row.info.count)
        .expect("250k corpus has templates");
    let suppression_preview_started = Instant::now();
    let empty_policy = load_suppression_document(&corpus).unwrap();
    let preview = preview_template_suppression(
        &corpus,
        empty_policy.revision,
        NewSuppressionPreview {
            name: "Dominant synthetic noise family".into(),
            rationale: "Explicit 250k acceptance proof for a reversible exact-template lens."
                .into(),
            template_id: dominant_template.info.template_id,
            origin: SuppressionRuleOrigin::Human,
        },
    )
    .unwrap();
    let suppression_preview_ms = suppression_preview_started.elapsed().as_millis();
    assert_eq!(
        preview.matching_event_count, dominant_template.info.count,
        "trusted preview count must match the authoritative template"
    );
    assert_eq!(
        preview.incremental_event_count,
        preview.matching_event_count
    );

    let suppression_activate_started = Instant::now();
    let activated = activate_template_suppression(
        &corpus,
        preview.rule_revision,
        ActivateSuppressionPreview {
            preview_token: preview.token,
        },
    )
    .unwrap();
    let suppression_activate_ms = suppression_activate_started.elapsed().as_millis();
    let active_policy = load_suppression_document(&corpus).unwrap();
    assert_eq!(active_policy.revision, activated.revision);
    let excluded_template_ids = active_policy.enabled_template_ids().unwrap();
    assert_eq!(
        excluded_template_ids,
        vec![dominant_template.info.template_id]
    );
    let suppressed_query = EventQuery {
        excluded_template_ids: excluded_template_ids.clone(),
        limit: MAX_EVENT_PAGE,
        ..Default::default()
    };
    let expected_visible = DEFAULT_TRIAGE_STRESS_EVENT_COUNT as u64 - preview.matching_event_count;

    let suppression_rows_started = Instant::now();
    let suppression_rows = query_event_rows(&corpus, &suppressed_query).unwrap();
    let suppression_rows_ms = suppression_rows_started.elapsed().as_millis();
    assert_eq!(suppression_rows.events.len(), MAX_EVENT_PAGE);
    assert!(suppression_rows
        .events
        .iter()
        .all(|event| event.template_id != dominant_template.info.template_id));

    let suppression_count_started = Instant::now();
    let suppression_count = query_event_count(&corpus, &suppressed_query).unwrap();
    let suppression_count_ms = suppression_count_started.elapsed().as_millis();
    assert_eq!(suppression_count.total_matched, expected_visible);

    let suppression_facets_started = Instant::now();
    let suppression_facets = query_facets(&corpus, &suppressed_query).unwrap();
    let suppression_facets_ms = suppression_facets_started.elapsed().as_millis();
    assert_eq!(
        suppression_facets.levels.values().sum::<u64>(),
        expected_visible
    );

    let suppression_timeline_started = Instant::now();
    let suppression_timeline = query_timeline_summary(
        &corpus,
        &TimelineSummaryQuery {
            filter: suppressed_query.clone(),
            max_buckets: 96,
        },
    )
    .unwrap();
    let suppression_timeline_ms = suppression_timeline_started.elapsed().as_millis();
    assert_eq!(suppression_timeline.total_matched, expected_visible);

    let broad_triage_started = Instant::now();
    let mut triage_host = ToolHost::new(
        Workspace::new("triage-stress-250k", vec![workspace.path().to_path_buf()]),
        KeywordIndex::new(),
        None,
    );
    triage_host.set_log_analysis(true, Some(cache.clone()));
    triage_host.set_active_log_corpus(Some(report.corpus_id.clone()));
    triage_host.set_log_corpus_scope(Some(report.corpus_id.clone()));
    triage_host
        .pin_log_suppression_lens(&report.corpus_id)
        .unwrap();
    let broad_triage = triage_host.build_broad_log_triage_brief().unwrap();
    let broad_triage_ms = broad_triage_started.elapsed().as_millis();
    assert_eq!(broad_triage.unsuppressed_event_count, expected_visible);
    assert_eq!(broad_triage.suppression_revision, active_policy.revision);
    assert_eq!(broad_triage.time_quality, TimeQuality::Wall);
    assert!(broad_triage.deterministic_complete);
    assert!(broad_triage.model_text_bytes <= BROAD_LOG_TRIAGE_BRIEF_MAX_BYTES);
    assert!(broad_triage.evidence.len() <= BROAD_LOG_TRIAGE_IDENTITY_CAP);
    assert!(!broad_triage.evidence.is_empty());
    assert!(
        ["CDLAB2004", "CDLAB3102", "CDLAB4203"]
            .iter()
            .any(|signal| broad_triage.model_text.contains(signal)),
        "bounded deterministic brief lost every labeled rare severe incident"
    );

    let first_rows_started = Instant::now();
    let first_rows = query_event_rows(
        &corpus,
        &EventQuery {
            limit: MAX_EVENT_PAGE,
            ..Default::default()
        },
    )
    .unwrap();
    let first_rows_ms = first_rows_started.elapsed().as_millis();
    assert_eq!(first_rows.events.len(), MAX_EVENT_PAGE);
    assert!(first_rows.next_cursor.is_some());

    let exact_count_started = Instant::now();
    let exact_count = query_event_count(&corpus, &EventQuery::default()).unwrap();
    let exact_count_ms = exact_count_started.elapsed().as_millis();
    assert_eq!(
        exact_count.total_matched,
        DEFAULT_TRIAGE_STRESS_EVENT_COUNT as u64
    );

    let facets_started = Instant::now();
    let facets = query_facets(&corpus, &EventQuery::default()).unwrap();
    let facets_ms = facets_started.elapsed().as_millis();
    assert_eq!(facets.levels["error"], 45_000);
    assert_eq!(facets.levels["warn"], 37_500);
    assert_eq!(facets.levels["debug"], 7_500);
    assert_eq!(facets.levels["info"], 160_000);
    assert_eq!(facets.sources.len(), TRIAGE_STRESS_SOURCE_COUNT);

    let source_catalog_started = Instant::now();
    let source_catalog = query_source_catalog(&corpus, &LogSourceCatalogQuery::default()).unwrap();
    let source_catalog_ms = source_catalog_started.elapsed().as_millis();
    assert_eq!(
        source_catalog.total_matched as usize,
        TRIAGE_STRESS_SOURCE_COUNT
    );
    assert_eq!(source_catalog.sources.len(), TRIAGE_STRESS_SOURCE_COUNT);

    let bookmarks_started = Instant::now();
    let bookmarks = list_bookmarks(&corpus).unwrap();
    let bookmarks_ms = bookmarks_started.elapsed().as_millis();
    assert!(bookmarks.is_empty());

    let investigation_started = Instant::now();
    let investigations = InvestigationStore::new(workspace.path().join("investigations"))
        .list()
        .unwrap();
    let investigation_ms = investigation_started.elapsed().as_millis();
    assert!(investigations.is_empty());

    let shared_timeline_started = Instant::now();
    let shared_timeline =
        query_shared_timeline_summary(&corpus, &SharedTimelineSummaryQuery::default()).unwrap();
    let shared_timeline_ms = shared_timeline_started.elapsed().as_millis();
    assert_eq!(
        shared_timeline.total_matched,
        DEFAULT_TRIAGE_STRESS_EVENT_COUNT as u64
    );

    let timeline_started = Instant::now();
    let buckets = timeline(&corpus, 300, None, None).unwrap();
    let timeline_ms = timeline_started.elapsed().as_millis();
    assert_eq!(
        buckets.iter().map(|bucket| bucket.count).sum::<u64>(),
        DEFAULT_TRIAGE_STRESS_EVENT_COUNT as u64
    );

    let cluster_started = Instant::now();
    let clusters = cluster_problems(&corpus, 40).unwrap();
    let cluster_ms = cluster_started.elapsed().as_millis();
    assert!(clusters.len() <= 40);
    for signal in ["CDLAB2004", "CDLAB3102", "CDLAB4203"] {
        let hits = search_events(
            &corpus,
            &EventSearchQuery {
                query: Some(signal.into()),
                semantic: false,
                k: 20,
                filter: suppressed_query.clone(),
                ..Default::default()
            },
            None,
        )
        .unwrap();
        assert_eq!(hits.len(), TRIAGE_STRESS_INCIDENT_REPETITIONS);
    }
    assert_eq!(manifest["expected"]["severities"]["error"], 45_000);
    assert_eq!(manifest["expected"]["severities"]["warn"], 37_500);
    assert_eq!(manifest["expected"]["severities"]["debug"], 7_500);
    assert_eq!(manifest["expected"]["severities"]["info"], 160_000);

    let suppression_disable_started = Instant::now();
    let disabled = mutate_template_suppression_rule(
        &corpus,
        active_policy.revision,
        &activated.rule.id,
        SuppressionRuleMutation::Disable,
    )
    .unwrap();
    let suppression_disable_ms = suppression_disable_started.elapsed().as_millis();
    let disabled_policy = load_suppression_document(&corpus).unwrap();
    assert_eq!(disabled_policy.revision, disabled.revision);
    assert!(disabled_policy.enabled_template_ids().unwrap().is_empty());
    assert_eq!(
        query_event_count(&corpus, &EventQuery::default())
            .unwrap()
            .total_matched,
        DEFAULT_TRIAGE_STRESS_EVENT_COUNT as u64
    );

    eprintln!(
        "PASS triage-stress-250k events={} files={} templates={} source_bytes={} generation_ms={} import_ms={} cold_open_ms={} summary_ms={} first_rows_ms={} exact_count_ms={} facets_ms={} source_catalog_ms={} bookmarks_ms={} investigation_ms={} shared_timeline_ms={} agent_timeline_ms={} cluster_ms={} broad_triage_ms={} broad_triage_bytes={} broad_triage_identities={} suppression_template_id={} suppression_hidden={} suppression_preview_ms={} suppression_activate_ms={} suppression_rows_ms={} suppression_count_ms={} suppression_facets_ms={} suppression_timeline_ms={} suppression_disable_ms={} tree_sha256={} (one-machine observation; not a universal claim)",
        report.stats.lines,
        report.stats.files,
        report.stats.templates,
        report.stats.source_bytes,
        generation_ms,
        import_ms,
        cold_open_ms,
        summary_ms,
        first_rows_ms,
        exact_count_ms,
        facets_ms,
        source_catalog_ms,
        bookmarks_ms,
        investigation_ms,
        shared_timeline_ms,
        timeline_ms,
        cluster_ms,
        broad_triage_ms,
        broad_triage.model_text_bytes,
        broad_triage.evidence.len(),
        dominant_template.info.template_id,
        preview.matching_event_count,
        suppression_preview_ms,
        suppression_activate_ms,
        suppression_rows_ms,
        suppression_count_ms,
        suppression_facets_ms,
        suppression_timeline_ms,
        suppression_disable_ms,
        generation.tree_sha256
    );
}

/// Explicit local acceptance path for #542. Kept out of the default suite
/// because it generates and imports the literal 100k UI profile, but it uses
/// only production core entry points and no network or external service.
#[test]
#[ignore = "explicit 100k Log Lab product-path proof"]
fn log_lab_ui_medium_100k_product_path_is_bounded_and_bidirectional() {
    let controls = BehaviorControls::for_profile(UI_MEDIUM_PROFILE, None).unwrap();
    assert_eq!(controls.event_count, 100_000);

    let workspace = tempfile::tempdir().unwrap();
    let generated = workspace.path().join("behavior-100k");
    let generation_started = Instant::now();
    let generation = generate_behavior(&generated, &controls).unwrap();
    let generation_ms = generation_started.elapsed().as_millis();
    verify_safety(&generated).unwrap();
    assert_eq!(generation.events, 100_000);

    let manifest = load_behavior_manifest(&generated).unwrap();
    let deep_token = manifest["investigation"]["sentinels"]["find_deep"]["token"]
        .as_str()
        .unwrap()
        .to_string();
    let bookmark_token = manifest["investigation"]["sentinels"]["bookmark_evict_window"]["token"]
        .as_str()
        .unwrap()
        .to_string();

    let cache = workspace.path().join("cache");
    let import_started = Instant::now();
    let report = ingest_path(
        &cache,
        &generated.join("scenarios/behavior-scale/import"),
        "behavior-ui-100k",
        None,
        "none",
    )
    .unwrap();
    let import_ms = import_started.elapsed().as_millis();
    assert_eq!(report.stats.lines, 100_000);

    let corpus = LogCorpus::open(&cache, &report.corpus_id).unwrap();
    let first_page_started = Instant::now();
    let first = query_events(
        &corpus,
        &EventQuery {
            limit: 100,
            ..Default::default()
        },
    )
    .unwrap();
    let first_page_ms = first_page_started.elapsed().as_millis();
    assert_eq!(first.events.len(), 100);
    assert_eq!(first.total_matched, 100_000);

    let timeline_started = Instant::now();
    let timeline = query_timeline_summary(
        &corpus,
        &TimelineSummaryQuery {
            max_buckets: 96,
            ..Default::default()
        },
    )
    .unwrap();
    let timeline_ms = timeline_started.elapsed().as_millis();
    assert_eq!(timeline.total_matched, 100_000);
    assert!(timeline.bucket_count <= 96);
    assert!(timeline.buckets.len() <= 96);

    // Traverse enough pages to move well beyond the first resident UI window.
    let traversal_started = Instant::now();
    let mut pages = vec![first];
    for _ in 1..12 {
        let previous = pages.last().unwrap();
        let page = query_events(
            &corpus,
            &EventQuery {
                after_seq: previous.next_cursor,
                after_ts: previous.next_ts,
                limit: 100,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(page.events.len(), 100);
        pages.push(page);
    }
    let forward_ms = traversal_started.elapsed().as_millis();
    let unique = pages
        .iter()
        .flat_map(|page| page.events.iter().map(|event| (event.ts, event.seq)))
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(unique.len(), 1_200, "forward traversal duplicated an event");

    let reverse_started = Instant::now();
    let first_on_last = pages.last().unwrap().events.first().unwrap();
    let reverse = query_events(
        &corpus,
        &EventQuery {
            before_seq: Some(first_on_last.seq),
            before_ts: Some(first_on_last.ts),
            limit: 100,
            ..Default::default()
        },
    )
    .unwrap();
    let reverse_ms = reverse_started.elapsed().as_millis();
    let expected = pages[pages.len() - 2]
        .events
        .iter()
        .map(|event| (event.ts, event.seq))
        .collect::<Vec<_>>();
    let actual = reverse
        .events
        .iter()
        .map(|event| (event.ts, event.seq))
        .collect::<Vec<_>>();
    assert_eq!(
        actual, expected,
        "reverse page must exactly retrace prior page"
    );

    let find_started = Instant::now();
    let deep_hits = search_events(
        &corpus,
        &EventSearchQuery {
            query: Some(deep_token.clone()),
            semantic: false,
            k: 20,
            ..Default::default()
        },
        None,
    )
    .unwrap();
    let find_ms = find_started.elapsed().as_millis();
    assert!(deep_hits
        .iter()
        .any(|hit| hit.event.message.contains(&deep_token)));

    // Exercise the literal production regex work cap on the 100k corpus. The
    // deliberately absent token makes the engine consume its complete bounded
    // scan budget without returning or retaining an unbounded result set.
    let regex_started = Instant::now();
    let regex_result = search_events_advanced(
        &corpus,
        &EventSearchQuery {
            query: Some(r"event_id=never-present-[0-9]{6}".into()),
            match_mode: SearchMatchMode::Regex,
            k: 20,
            ..Default::default()
        },
        None,
    )
    .unwrap();
    let regex_ms = regex_started.elapsed().as_millis();
    assert!(regex_result.hits.is_empty());
    assert_eq!(regex_result.scanned, MAX_REGEX_SCAN_EVENTS as u64);
    assert!(regex_result.partial);
    assert!(
        regex_result
            .diagnostic
            .as_deref()
            .is_some_and(|message| message.contains("scan work cap")),
        "{regex_result:?}"
    );

    let error_summary = query_timeline_summary(
        &corpus,
        &TimelineSummaryQuery {
            filter: EventQuery {
                levels: vec!["error".into()],
                ..Default::default()
            },
            max_buckets: 96,
        },
    )
    .unwrap();
    assert!(error_summary.total_matched > 0);
    assert!(error_summary.total_matched < timeline.total_matched);

    let bookmark_hit = search_events(
        &corpus,
        &EventSearchQuery {
            query: Some(bookmark_token.clone()),
            semantic: false,
            k: 20,
            ..Default::default()
        },
        None,
    )
    .unwrap()
    .into_iter()
    .find(|hit| hit.event.message.contains(&bookmark_token))
    .expect("bookmark sentinel");
    let bookmark = add_line_bookmark(
        &corpus,
        bookmark_hit.event.seq,
        "100k eviction sentinel",
        None,
        None,
        Some(bookmark_hit.event.ts),
    )
    .unwrap();
    let neighborhood = query_event_neighborhood(
        &corpus,
        &EventNeighborhoodQuery {
            target_seq: bookmark.seq_from,
            before: 20,
            after: 20,
            filter: EventQuery::default(),
            sort_by_time: true,
        },
    )
    .unwrap();
    assert_eq!(neighborhood.target.unwrap().seq, bookmark.seq_from);
    assert!(neighborhood.events.len() <= 41);

    eprintln!(
        "PASS ui-medium-100k events={} files={} source_bytes={} generation_ms={} import_ms={} first_page_ms={} timeline_ms={} forward_12_pages_ms={} reverse_page_ms={} deep_find_ms={} bounded_regex_50k_ms={} first_page_rows={} timeline_slots={} neighborhood_rows={} tree_sha256={} (one-machine observation; not a universal claim)",
        report.stats.lines,
        report.stats.files,
        report.stats.source_bytes,
        generation_ms,
        import_ms,
        first_page_ms,
        timeline_ms,
        forward_ms,
        reverse_ms,
        find_ms,
        regex_ms,
        pages[0].events.len(),
        timeline.bucket_count,
        neighborhood.events.len(),
        generation.tree_sha256
    );
}
