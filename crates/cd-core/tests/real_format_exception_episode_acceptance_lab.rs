//! Red acceptance checkpoint: real-format 56-execution WildFly/JBoss exception
//! episode oracle.
//!
//! **Not SHIP.** This suite drives the shipped product path
//! (`ingest_path_with_policy` → `analyze_exception_episodes` → broad triage →
//! triage-quality) against a fail-closed truth table. On current main-equivalent
//! behavior the primary oracle **must fail** for documented semantic reasons
//! (multi-app chain under-merge, WildFly envelope/timestamp/thread gaps).
//! Do not weaken exact equality to green the suite.

use std::collections::{BTreeSet, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use cd_core::index::KeywordIndex;
use cd_core::log_analysis::exception_episodes::{
    analyze_bounded_events, analyze_exception_episodes, analyze_exception_episodes_with_cancel,
    EXCEPTION_EPISODE_RENDER_CAP,
};
use cd_core::log_analysis::{
    query_event_rows, ActiveTimestampBasis, EventQuery, ExplorerEvent, LogCorpus, LogEmbedMode,
    LogEmbedPolicy, LogEvent, TimeQuality, TimestampProvenance,
};
use cd_core::tool_host::ToolHost;
use cd_core::triage_quality::{
    score_structured_triage_answer, StructuredTriageAnswer, TriageClaim, TriageHostFacts,
    TriageKnownAnswerKey,
};
use cd_core::workspace::Workspace;
use serde::Deserialize;

// ─── Exact truth table (must not be relaxed) ───────────────────────────────

const EXECUTIONS: usize = 56;
const APP_RENDERINGS_PER_EXEC: usize = 7;
const STDERR_RECORDS_PER_EXEC: usize = 265;
const AT_FRAMES_PER_EXEC: usize = 189;
const AUX_WRAPPER_PER_EXEC: usize = 72;
const HEADER_CAUSE_PER_EXEC: usize = 4; // 1 header + 3 causes

const STDERR_RAW: usize = EXECUTIONS * STDERR_RECORDS_PER_EXEC; // 14840
const APP_RAW: usize = EXECUTIONS * APP_RENDERINGS_PER_EXEC; // 392
const TOTAL_RAW: usize = STDERR_RAW + APP_RAW; // 15232
const STDERR_RENDERINGS: usize = EXECUTIONS; // 56
const APP_RENDERINGS: usize = APP_RAW; // 392
const TOTAL_RENDERINGS: usize = STDERR_RENDERINGS + APP_RENDERINGS; // 448
const EPISODES: usize = EXECUTIONS; // 56
const RENDERINGS_PER_EPISODE: usize = APP_RENDERINGS_PER_EXEC + 1; // 8
const RAW_PER_EPISODE: usize = APP_RENDERINGS_PER_EXEC + STDERR_RECORDS_PER_EXEC; // 272

const AT_PARTITION: usize = EXECUTIONS * AT_FRAMES_PER_EXEC; // 10584
const AUX_PARTITION: usize = EXECUTIONS * AUX_WRAPPER_PER_EXEC; // 4032
const HDR_PARTITION: usize = EXECUTIONS * HEADER_CAUSE_PER_EXEC; // 224

const MARKER_AT: &str = "XYZ_AT_FRAME";
const MARKER_AUX: &str = "XYZ_AUX_WRAP";
const MARKER_HDR: &str = "XYZ_HDR_CAUSE";

#[derive(Debug, Deserialize)]
struct TruthManifest {
    red_acceptance_checkpoint: bool,
    ship: bool,
    exact_totals: ExactTotals,
    conservation_partitions: Partitions,
    geometry: Geometry,
}

#[derive(Debug, Deserialize)]
struct ExactTotals {
    stderr_raw_records: usize,
    application_raw_records: usize,
    total_exception_raw_records: usize,
    stderr_physical_renderings: usize,
    application_physical_renderings: usize,
    total_physical_renderings: usize,
    strongly_supported_derived_episodes: usize,
    global_citation_union: usize,
}

#[derive(Debug, Deserialize)]
struct Partitions {
    at_frame_identities: usize,
    auxiliary_wrapper_identities: usize,
    stderr_header_cause_identities: usize,
}

#[derive(Debug, Deserialize)]
struct Geometry {
    executions: usize,
    application_renderings_per_execution: usize,
    stderr_records_per_execution: usize,
    renderings_per_episode: usize,
    raw_records_per_episode: usize,
}

fn lab_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/real-format-exception-episode-lab")
}

fn load_truth() -> TruthManifest {
    let path = lab_root().join("truth/truth_manifest.json");
    serde_json::from_str(&fs::read_to_string(&path).expect("read truth_manifest.json"))
        .expect("parse truth_manifest.json")
}

fn no_embed_policy() -> LogEmbedPolicy {
    LogEmbedPolicy {
        mode: LogEmbedMode::None,
        cloud_content_leaves_machine: false,
        cloud_base_url: None,
        model_id: "test-none".into(),
        defer_above_source_bytes: None,
    }
}

// ─── Deterministic generator (genuine WildFly/JBoss envelope) ──────────────

/// WildFly-style timestamp: `YYYY-MM-DD HH:mm:ss,SSS` (not ISO-T-Z).
fn wildfly_ts(day_base_secs: u32, millis: u32) -> String {
    let total_ms = day_base_secs as u64 * 1000 + millis as u64;
    let h = ((total_ms / 3_600_000) % 24) as u32;
    let m = ((total_ms / 60_000) % 60) as u32;
    let s = ((total_ms / 1000) % 60) as u32;
    let ms = (total_ms % 1000) as u32;
    format!("2026-03-15 {h:02}:{m:02}:{s:02},{ms:03}")
}

/// One execution's stderr payload lines (265), without timestamps.
fn stderr_payloads(exec: usize) -> Vec<String> {
    let mut lines = Vec::with_capacity(STDERR_RECORDS_PER_EXEC);
    // 1 header
    lines.push(format!(
        "{MARKER_HDR} java.lang.RuntimeException: XYZ_PAYMENT_FAILED request_id=req-{exec}"
    ));
    // 72 auxiliary/wrapper
    for w in 0..AUX_WRAPPER_PER_EXEC {
        lines.push(format!(
            "Exception wrapper {MARKER_AUX}#{w} for payment failure request_id=req-{exec}"
        ));
    }
    // 189 at frames
    for f in 0..AT_FRAMES_PER_EXEC {
        lines.push(format!(
            "at com.xyz.payment.StackFrame{f}.invoke(StackFrame{f}.java:{}) {MARKER_AT}",
            f + 1
        ));
    }
    // 3 causes → total header/cause = 4
    lines.push(format!(
        "Caused by: java.io.IOException: XYZ_UPSTREAM_TIMEOUT request_id=req-{exec} {MARKER_HDR}"
    ));
    lines.push(format!(
        "Caused by: java.io.IOException: XYZ_UPSTREAM_TIMEOUT request_id=req-{exec} {MARKER_HDR}"
    ));
    lines.push(format!(
        "Caused by: java.io.IOException: XYZ_UPSTREAM_TIMEOUT request_id=req-{exec} {MARKER_HDR}"
    ));
    assert_eq!(lines.len(), STDERR_RECORDS_PER_EXEC);
    assert_eq!(1 + 3, HEADER_CAUSE_PER_EXEC);
    lines
}

/// Seven application full-stack/wrapper layers for one propagation chain.
fn app_layers(exec: usize) -> Vec<String> {
    let mut layers = Vec::with_capacity(APP_RENDERINGS_PER_EXEC);
    for layer in 0..APP_RENDERINGS_PER_EXEC {
        let head = if layer + 1 == APP_RENDERINGS_PER_EXEC {
            format!(
                "XYZ_LAYER{layer}: java.io.IOException: XYZ_UPSTREAM_TIMEOUT request_id=req-{exec}"
            )
        } else {
            format!(
                "XYZ_LAYER{layer}: java.lang.RuntimeException: XYZ_PAYMENT_FAILED hop={layer} request_id=req-{exec}"
            )
        };
        let mut body = String::new();
        body.push_str(&head);
        body.push('\n');
        body.push_str(&format!(
            "\tat com.xyz.layer{layer}.Handler.handle(Handler{layer}.java:{})\n",
            10 + layer
        ));
        body.push_str(&format!(
            "\tat com.xyz.layer{layer}.Bridge.invoke(Bridge{layer}.java:{})\n",
            20 + layer
        ));
        if layer + 1 < APP_RENDERINGS_PER_EXEC {
            body.push_str(&format!(
                "\tCaused by: java.lang.RuntimeException: XYZ_PAYMENT_FAILED hop={} request_id=req-{exec}\n",
                layer + 1
            ));
            body.push_str(&format!(
                "\tat com.xyz.layer{}.Inner.m(Inner.java:1)\n",
                layer + 1
            ));
        }
        body.push_str(&format!(
            "\tCaused by: java.io.IOException: XYZ_UPSTREAM_TIMEOUT request_id=req-{exec}\n"
        ));
        body.push_str("\tat com.xyz.net.Http.execute(Http.java:15)\n");
        layers.push(body);
    }
    assert_eq!(layers.len(), APP_RENDERINGS_PER_EXEC);
    layers
}

/// Write the ANCHORED product-path fixture (56 executions with shared request_id=).
///
/// Returns expected line-class counts for conservation bookkeeping.
pub fn write_real_format_cascade(root: &Path) {
    fs::create_dir_all(root).expect("import root");
    let mut app = String::new();
    let mut stderr = String::new();
    for exec in 0..EXECUTIONS {
        // Non-overlapping 10s windows per execution; shared thread within cycle.
        let base_secs = 12 * 3600 + (exec as u32) * 10;
        let thread = format!("pool-40-thread-{}", 1000 + exec);
        let task = format!("default task-{}", 1 + exec);

        for (layer, body) in app_layers(exec).into_iter().enumerate() {
            let ts = wildfly_ts(base_secs, layer as u32);
            // First line of multiline app event carries WildFly envelope.
            let mut lines = body.lines();
            let first = lines.next().unwrap_or("");
            app.push_str(&format!("{ts} ERROR [XYZ_app] ({task}) {first}\n"));
            for cont in lines {
                if cont.is_empty() {
                    continue;
                }
                // Continuation lines: tab-prefixed stack (common JBoss shape).
                if cont.starts_with('\t') {
                    app.push_str(cont);
                    app.push('\n');
                } else {
                    app.push('\t');
                    app.push_str(cont.trim_start());
                    app.push('\n');
                }
            }
        }

        for (j, payload) in stderr_payloads(exec).into_iter().enumerate() {
            let ts = wildfly_ts(base_secs, 100 + j as u32);
            stderr.push_str(&format!("{ts} ERROR [stderr] ({thread}) {payload}\n"));
        }
    }
    fs::write(root.join("XYZ_app.log"), app).expect("app log");
    fs::write(root.join("XYZ_server.stderr"), stderr).expect("stderr log");
}

/// Company-shaped unanchored fixture: app `(default task-N)` vs stderr
/// `(pool-40-thread-M)`, no trace/request/correlation/transaction, no bare id=.
/// Physical reconstruction may succeed; semantic certification must remain false.
pub fn write_company_shaped_unanchored_cascade(root: &Path) {
    fs::create_dir_all(root).expect("import root");
    let mut app = String::new();
    let mut stderr = String::new();
    for exec in 0..EXECUTIONS {
        let base_secs = 12 * 3600 + (exec as u32) * 10;
        let thread = format!("pool-40-thread-{}", 1000 + exec);
        let task = format!("default task-{}", 1 + exec);
        for (layer, body) in app_layers_unanchored(exec).into_iter().enumerate() {
            let ts = wildfly_ts(base_secs, layer as u32);
            let mut lines = body.lines();
            let first = lines.next().unwrap_or("");
            app.push_str(&format!("{ts} ERROR [XYZ_app] ({task}) {first}\n"));
            for cont in lines {
                if cont.is_empty() {
                    continue;
                }
                if cont.starts_with('\t') {
                    app.push_str(cont);
                    app.push('\n');
                } else {
                    app.push('\t');
                    app.push_str(cont.trim_start());
                    app.push('\n');
                }
            }
        }
        for (j, payload) in stderr_payloads_unanchored(exec).into_iter().enumerate() {
            let ts = wildfly_ts(base_secs, 100 + j as u32);
            stderr.push_str(&format!("{ts} ERROR [stderr] ({thread}) {payload}\n"));
        }
    }
    fs::write(root.join("XYZ_app.log"), app).expect("app log");
    fs::write(root.join("XYZ_server.stderr"), stderr).expect("stderr log");
}

fn app_layers_unanchored(exec: usize) -> Vec<String> {
    let mut layers = Vec::with_capacity(APP_RENDERINGS_PER_EXEC);
    for layer in 0..APP_RENDERINGS_PER_EXEC {
        let head = if layer + 1 == APP_RENDERINGS_PER_EXEC {
            format!("XYZ_LAYER{layer}: java.io.IOException: XYZ_UPSTREAM_TIMEOUT exec={exec}")
        } else {
            format!(
                "XYZ_LAYER{layer}: java.lang.RuntimeException: XYZ_PAYMENT_FAILED hop={layer} exec={exec}"
            )
        };
        let mut body = String::new();
        body.push_str(&head);
        body.push('\n');
        body.push_str(&format!(
            "\tat com.xyz.layer{layer}.Handler.handle(Handler{layer}.java:{})\n",
            10 + layer
        ));
        body.push_str(&format!(
            "\tat com.xyz.layer{layer}.Bridge.invoke(Bridge{layer}.java:{})\n",
            20 + layer
        ));
        if layer + 1 < APP_RENDERINGS_PER_EXEC {
            body.push_str(&format!(
                "\tCaused by: java.lang.RuntimeException: XYZ_PAYMENT_FAILED hop={} exec={exec}\n",
                layer + 1
            ));
            body.push_str(&format!(
                "\tat com.xyz.layer{}.Inner.m(Inner.java:1)\n",
                layer + 1
            ));
        } else {
            body.push_str("\tCaused by: java.io.IOException: XYZ_UPSTREAM_TIMEOUT\n");
            body.push_str("\tat com.xyz.net.Http.execute(Http.java:15)\n");
        }
        layers.push(body);
    }
    layers
}

fn stderr_payloads_unanchored(exec: usize) -> Vec<String> {
    let mut lines = Vec::with_capacity(STDERR_RECORDS_PER_EXEC);
    lines.push(format!(
        "{MARKER_HDR} java.lang.RuntimeException: XYZ_PAYMENT_FAILED exec={exec}"
    ));
    for w in 0..AUX_WRAPPER_PER_EXEC {
        lines.push(format!(
            "Exception wrapper {MARKER_AUX}#{w} for payment failure exec={exec}"
        ));
    }
    for f in 0..AT_FRAMES_PER_EXEC {
        lines.push(format!(
            "at com.xyz.payment.StackFrame{f}.invoke(StackFrame{f}.java:{}) {MARKER_AT}",
            f + 1
        ));
    }
    lines.push(format!(
        "Caused by: java.io.IOException: XYZ_UPSTREAM_TIMEOUT request_id=req-{exec} {MARKER_HDR}"
    ));
    lines.push(format!(
        "Caused by: java.io.IOException: XYZ_UPSTREAM_TIMEOUT request_id=req-{exec} {MARKER_HDR}"
    ));
    lines.push(format!(
        "Caused by: java.io.IOException: XYZ_UPSTREAM_TIMEOUT request_id=req-{exec} {MARKER_HDR}"
    ));
    assert_eq!(lines.len(), STDERR_RECORDS_PER_EXEC);
    lines
}

fn write_unrelated_controls(root: &Path) {
    let mut body = String::new();
    for i in 0..12u32 {
        body.push_str(&format!(
            "2026-03-15 13:{:02}:00,500 INFO [unrelated] heartbeat ok unrelated_id=other-{i:02}\n",
            i * 3
        ));
        body.push_str(&format!(
            "2026-03-15 13:{:02}:30,000 WARN [unrelated] soft retry unrelated_id=other-{i:02}\n",
            i * 3
        ));
    }
    fs::write(root.join("unrelated.log"), body).expect("unrelated");
}

fn ingest_dir(dir: &Path) -> (tempfile::TempDir, String, LogCorpus) {
    let cache = tempfile::TempDir::new().unwrap();
    let report = cd_core::log_analysis::ingest_path_with_policy(
        cache.path(),
        dir,
        "real-format-ep-lab",
        &no_embed_policy(),
        None,
    )
    .expect("ingest_path_with_policy");
    let corpus = LogCorpus::open(cache.path(), &report.corpus_id).unwrap();
    (cache, report.corpus_id, corpus)
}

fn all_events(corpus: &LogCorpus) -> Vec<ExplorerEvent> {
    let mut out = Vec::new();
    let mut after_seq = None;
    loop {
        let page = query_event_rows(
            corpus,
            &EventQuery {
                after_seq,
                limit: 500,
                sort_by_time: false,
                ..Default::default()
            },
        )
        .unwrap();
        if page.events.is_empty() {
            break;
        }
        after_seq = page.events.last().map(|e| e.seq);
        let n = page.events.len();
        out.extend(page.events);
        if n < 500 {
            break;
        }
    }
    out
}

fn classify_message(message: &str) -> &'static str {
    if message.contains(MARKER_AT)
        || message
            .trim_start()
            .contains("at com.xyz.payment.StackFrame")
    {
        return "at";
    }
    if message.contains(MARKER_AUX) || message.contains("Exception wrapper") {
        return "aux";
    }
    if message.contains(MARKER_HDR) || message.contains("Caused by:") {
        return "hdr";
    }
    if message.lines().any(|l| l.trim_start().starts_with("at ")) {
        return "at";
    }
    if message.contains("RuntimeException") || message.contains("IOException") {
        return "hdr";
    }
    "other"
}

// ─── Manifest geometry (no product under test) ─────────────────────────────

#[test]
fn truth_manifest_matches_hardcoded_oracle_constants() {
    let t = load_truth();
    assert!(t.red_acceptance_checkpoint);
    assert!(!t.ship);
    assert_eq!(t.geometry.executions, EXECUTIONS);
    assert_eq!(
        t.geometry.application_renderings_per_execution,
        APP_RENDERINGS_PER_EXEC
    );
    assert_eq!(
        t.geometry.stderr_records_per_execution,
        STDERR_RECORDS_PER_EXEC
    );
    assert_eq!(t.geometry.renderings_per_episode, RENDERINGS_PER_EPISODE);
    assert_eq!(t.geometry.raw_records_per_episode, RAW_PER_EPISODE);
    assert_eq!(t.exact_totals.stderr_raw_records, STDERR_RAW);
    assert_eq!(t.exact_totals.application_raw_records, APP_RAW);
    assert_eq!(t.exact_totals.total_exception_raw_records, TOTAL_RAW);
    assert_eq!(t.exact_totals.stderr_physical_renderings, STDERR_RENDERINGS);
    assert_eq!(
        t.exact_totals.application_physical_renderings,
        APP_RENDERINGS
    );
    assert_eq!(t.exact_totals.total_physical_renderings, TOTAL_RENDERINGS);
    assert_eq!(t.exact_totals.strongly_supported_derived_episodes, EPISODES);
    assert_eq!(t.exact_totals.global_citation_union, TOTAL_RAW);
    assert_eq!(t.conservation_partitions.at_frame_identities, AT_PARTITION);
    assert_eq!(
        t.conservation_partitions.auxiliary_wrapper_identities,
        AUX_PARTITION
    );
    assert_eq!(
        t.conservation_partitions.stderr_header_cause_identities,
        HDR_PARTITION
    );
    // Conservation arithmetic on the truth table itself.
    assert_eq!(
        t.exact_totals.application_raw_records + t.exact_totals.stderr_raw_records,
        t.exact_totals.total_exception_raw_records
    );
    assert_eq!(AT_PARTITION + AUX_PARTITION + HDR_PARTITION, STDERR_RAW);
}

#[test]
fn generator_line_budgets_are_exact_before_ingest() {
    assert_eq!(stderr_payloads(0).len(), 265);
    assert_eq!(app_layers(0).len(), 7);
    let mut at = 0;
    let mut aux = 0;
    let mut hdr = 0;
    for line in stderr_payloads(3) {
        if line.contains(MARKER_AT) {
            at += 1;
        } else if line.contains(MARKER_AUX) {
            aux += 1;
        } else if line.contains(MARKER_HDR) {
            hdr += 1;
        }
    }
    assert_eq!(at, 189);
    assert_eq!(aux, 72);
    assert_eq!(hdr, 4);
}

// ─── Post-ingest durable identity inventory (product path) ─────────────────

#[test]
fn product_ingest_preserves_exact_raw_identity_inventory() {
    let import = tempfile::tempdir().unwrap();
    write_real_format_cascade(import.path());
    write_unrelated_controls(import.path());
    let (_cache, _id, corpus) = ingest_dir(import.path());
    let events = all_events(&corpus);

    // Unrelated INFO/WARN must not be absorbed into exception identity budget.
    let exceptionish: Vec<_> = events
        .iter()
        .filter(|e| {
            let m = &e.message;
            m.contains("XYZ_PAYMENT")
                || m.contains("XYZ_UPSTREAM")
                || m.contains(MARKER_AT)
                || m.contains(MARKER_AUX)
                || m.contains(MARKER_HDR)
                || m.contains("XYZ_LAYER")
                || m.contains("[stderr]")
        })
        .collect();

    // App multilines fold: expect APP_RAW app events + STDERR_RAW stderr events.
    let app_events: Vec<_> = exceptionish
        .iter()
        .filter(|e| e.source.contains("app"))
        .collect();
    let stderr_events: Vec<_> = exceptionish
        .iter()
        .filter(|e| e.source.contains("stderr"))
        .collect();

    eprintln!(
        "INGEST inventory: total_events={} exceptionish={} app={} stderr={}",
        events.len(),
        exceptionish.len(),
        app_events.len(),
        stderr_events.len()
    );

    assert_eq!(
        app_events.len(),
        APP_RAW,
        "semantic: post-ingest application durable records must be 392 (7×56); got {}",
        app_events.len()
    );
    assert_eq!(
        stderr_events.len(),
        STDERR_RAW,
        "semantic: post-ingest stderr durable records must be 14840 (265×56); got {}",
        stderr_events.len()
    );
    assert_eq!(
        app_events.len() + stderr_events.len(),
        TOTAL_RAW,
        "conservation: app+stderr raw identities"
    );

    // Partition stderr line classes via markers.
    let mut at = 0usize;
    let mut aux = 0usize;
    let mut hdr = 0usize;
    for e in &stderr_events {
        match classify_message(&e.message) {
            "at" => at += 1,
            "aux" => aux += 1,
            "hdr" => hdr += 1,
            other => panic!("unexpected stderr class {other}: {}", e.message),
        }
    }
    assert_eq!(at, AT_PARTITION, "stored at identities");
    assert_eq!(aux, AUX_PARTITION, "stored aux identities");
    assert_eq!(hdr, HDR_PARTITION, "stored header/cause identities");
}

// ─── Primary red oracle: analyze_exception_episodes ────────────────────────

/// Primary red acceptance checkpoint. Expected to **fail on current main**.
#[test]
fn red_checkpoint_real_format_56_execution_episode_oracle() {
    let import = tempfile::tempdir().unwrap();
    write_real_format_cascade(import.path());
    write_unrelated_controls(import.path());
    let (cache, corpus_id, corpus) = ingest_dir(import.path());

    let analysis =
        analyze_exception_episodes(&corpus, &[]).expect("analyze_exception_episodes must run");

    eprintln!(
        "OBSERVED analysis: raw={} app={} stderr={} renderings={} unpaired={} occ={} dup={} strong={} partial={} counts_complete={} cert={} structural={} amp_raw={}/{}={} rem{} eligible={} covered={} missing={} dup_id={} unexpected={}",
        analysis.raw_exception_record_count,
        analysis.application_exception_record_count,
        analysis.stderr_exception_record_count,
        analysis.rendering_episode_count,
        analysis.unpaired_rendering_count,
        analysis.occurrence_count,
        analysis.duplicate_rendering_occurrence_count,
        analysis.strong_derived_episode_count,
        analysis.partial,
        analysis.counts_complete,
        analysis.semantic_counts_certified,
        analysis.structural_coverage_complete,
        analysis.amplification.raw_records_per_occurrence.numerator,
        analysis.amplification.raw_records_per_occurrence.denominator,
        analysis.amplification.raw_records_per_occurrence.quotient,
        analysis.amplification.raw_records_per_occurrence.remainder,
        analysis.eligible_structural_identity_count,
        analysis.covered_structural_identity_count,
        analysis.missing_structural_identity_count,
        analysis.duplicate_structural_identity_count,
        analysis.unexpected_structural_identity_count,
    );
    eprintln!(
        "red_acceptance_checkpoint: anchored cert path | ship=false on fixture until promote"
    );

    // Completeness of scan (15232 < 50k cap).
    assert!(
        !analysis.partial && analysis.counts_complete,
        "cascade under scan caps must be complete; scope={}",
        analysis.candidate_scope
    );

    // Exact layer totals.
    assert_eq!(
        analysis.stderr_exception_record_count as usize, STDERR_RAW,
        "semantic: stderr_raw_records must be 14840; WildFly `[stderr] (thread) at ...` envelope currently drops at-frames from renderings (observed often equals 56×(1+72+3)=4256 headers/aux/causes only)"
    );
    assert_eq!(
        analysis.application_exception_record_count as usize, APP_RAW,
        "semantic: application_raw_records (7 full-stack renderings × 56 executions)"
    );
    assert_eq!(
        analysis.raw_exception_record_count as usize, TOTAL_RAW,
        "semantic: total_exception_raw_records"
    );
    assert_eq!(
        analysis.raw_exception_record_count,
        analysis.application_exception_record_count + analysis.stderr_exception_record_count,
        "conservation: raw = application + stderr"
    );

    assert_eq!(
        analysis.rendering_episode_count as usize, TOTAL_RENDERINGS,
        "semantic: total physical renderings 448 (392 app + 56 stderr)"
    );

    // Strongly supported episodes: 56 chains (7 app + 1 stderr each).
    assert!(
        analysis.semantic_counts_certified,
        "anchored real-format corpus must certify semantic counts"
    );
    assert_eq!(
        analysis.strong_derived_episode_count as usize, EPISODES,
        "semantic: strongly_supported_derived_episodes must be 56"
    );
    assert_eq!(
        analysis.occurrence_count as usize, EPISODES,
        "semantic: occurrence_count must equal 56 when fully certified"
    );

    // Per-episode shape.
    let mut cite_union: HashSet<(u64, String)> = HashSet::new();
    let mut sum_renderings = 0u64;
    let mut strong_or_moderate_dual = 0u64;
    for family in &analysis.families {
        for occ in &family.occurrences {
            sum_renderings += occ.rendering_count;
            if occ.duplicate_rendering {
                strong_or_moderate_dual += 1;
            }
            assert_eq!(
                occ.rendering_count as usize, RENDERINGS_PER_EPISODE,
                "semantic: renderings_per_episode must be 8 (7 app + 1 stderr); got {} first_seq={}",
                occ.rendering_count, occ.first_seq
            );
            assert_eq!(
                occ.raw_record_count as usize, RAW_PER_EPISODE,
                "semantic: raw_records_per_episode must be 272; got {}",
                occ.raw_record_count
            );
            assert_eq!(
                occ.stderr_record_count as usize, STDERR_RECORDS_PER_EXEC,
                "semantic: stderr_records_per_episode must be 265"
            );
            assert_eq!(
                occ.application_record_count as usize, APP_RENDERINGS_PER_EXEC,
                "semantic: application_renderings_per_episode must be 7 durable app records"
            );
            assert_eq!(
                occ.citations.len(),
                RAW_PER_EPISODE,
                "each episode must cite 272 unique real children"
            );
            let mut local = HashSet::new();
            for c in &occ.citations {
                assert!(
                    local.insert((c.seq, c.source.clone())),
                    "duplicate citation inside episode seq={} source={}",
                    c.seq,
                    c.source
                );
                assert!(
                    cite_union.insert((c.seq, c.source.clone())),
                    "duplicate citation across episodes (fabrication or over-merge) seq={} source={}",
                    c.seq,
                    c.source
                );
                // Citation must resolve to a stored event.
                let page = query_event_rows(
                    &corpus,
                    &EventQuery {
                        seq_from: Some(c.seq),
                        seq_to: Some(c.seq),
                        limit: 4,
                        sort_by_time: false,
                        ..Default::default()
                    },
                )
                .unwrap();
                assert!(
                    page.events
                        .iter()
                        .any(|e| e.seq == c.seq && e.source == c.source),
                    "fabricated citation seq={} source={}",
                    c.seq,
                    c.source
                );
            }
            assert_eq!(local.len(), RAW_PER_EPISODE);
        }
    }

    assert_eq!(
        cite_union.len(),
        TOTAL_RAW,
        "conservation: global citation union must be 15232"
    );
    assert_eq!(
        sum_renderings as usize, TOTAL_RENDERINGS,
        "conservation: physical renderings = sum of episode rendering counts"
    );
    assert_eq!(
        strong_or_moderate_dual as usize, EPISODES,
        "all 56 episodes must be multi-rendering (duplicate_rendering)"
    );

    // Amplification typed metrics.
    assert_eq!(
        analysis.amplification.raw_records_per_occurrence.quotient as usize,
        RAW_PER_EPISODE
    );
    assert_eq!(
        analysis.amplification.raw_records_per_occurrence.remainder,
        0
    );
    assert_eq!(
        analysis
            .amplification
            .stderr_records_per_occurrence
            .quotient as usize,
        STDERR_RECORDS_PER_EXEC
    );
    assert_eq!(
        analysis
            .amplification
            .application_records_per_occurrence
            .quotient as usize,
        APP_RENDERINGS_PER_EXEC
    );
    assert_eq!(
        analysis.amplification.renderings_per_occurrence.quotient as usize,
        RENDERINGS_PER_EPISODE
    );

    // Conservation: cited partitions via markers on resolved messages.
    let mut cited_at = 0usize;
    let mut cited_aux = 0usize;
    let mut cited_hdr = 0usize;
    for (seq, source) in &cite_union {
        let page = query_event_rows(
            &corpus,
            &EventQuery {
                seq_from: Some(*seq),
                seq_to: Some(*seq),
                limit: 2,
                sort_by_time: false,
                ..Default::default()
            },
        )
        .unwrap();
        let e = page
            .events
            .iter()
            .find(|e| e.seq == *seq && e.source == *source)
            .expect("cite resolve");
        if !source.contains("stderr") {
            continue;
        }
        match classify_message(&e.message) {
            "at" => cited_at += 1,
            "aux" => cited_aux += 1,
            "hdr" => cited_hdr += 1,
            _ => {}
        }
    }
    assert_eq!(cited_at, AT_PARTITION, "cited at identities");
    assert_eq!(cited_aux, AUX_PARTITION, "cited aux identities");
    assert_eq!(cited_hdr, HDR_PARTITION, "cited header/cause identities");

    // Broad triage + triage-quality product path must surface episode facts.
    let mut host = ToolHost::new(
        Workspace::new("real-format-ep-lab", vec![cache.path().to_path_buf()]),
        KeywordIndex::new(),
        None,
    );
    host.set_log_analysis(true, Some(cache.path().to_path_buf()));
    host.set_log_corpus_scope(Some(corpus_id.clone()));
    host.set_active_log_corpus(Some(corpus_id.clone()));
    host.seed_log_corpus_handle(&corpus_id, Arc::new(corpus))
        .unwrap();
    host.pin_log_suppression_lens(&corpus_id).unwrap();
    let brief = host
        .build_broad_log_triage_brief()
        .expect("broad_log_triage");
    assert!(brief.deterministic_complete);
    let ep = brief
        .exception_episodes
        .as_ref()
        .expect("exception_episodes on brief");
    assert_eq!(ep.occurrence_count as usize, EPISODES);
    assert_eq!(ep.raw_exception_record_count as usize, TOTAL_RAW);

    let facts = TriageHostFacts {
        time_quality: "wall".into(),
        exact_event_count: brief.unsuppressed_event_count,
        exact_error_count: None,
        sources_present: BTreeSet::new(),
        evidence: brief.evidence.clone(),
        messages_by_seq: Vec::new(),
        known_semantic_occurrence_count: None,
        stderr_record_count: None,
        raw_exception_record_count: None,
        episode_counts_complete: false,
    }
    .with_exception_episode_report(ep);
    assert!(facts.episode_counts_complete);
    assert_eq!(facts.known_semantic_occurrence_count, Some(EPISODES as u64));
    assert_eq!(facts.stderr_record_count, Some(STDERR_RAW as u64));
    assert_eq!(facts.raw_exception_record_count, Some(TOTAL_RAW as u64));

    let cite = brief.evidence.first().expect("evidence identity");
    let answer = StructuredTriageAnswer {
        observations: vec![TriageClaim {
            text: format!(
                "Host semantic_occurrence_count={} raw_exception_records={}",
                EPISODES, TOTAL_RAW
            ),
            seq: Some(cite.seq),
            source: Some(cite.source.clone()),
            role: Some("observation".into()),
        }],
        causal_candidates: vec![TriageClaim {
            text: "XYZ multi-app WildFly cascade; 56 strongly supported episodes".into(),
            seq: Some(cite.seq),
            source: Some(cite.source.clone()),
            role: Some("unknown".into()),
        }],
        competing_explanations: vec!["noise-only dual-render".into()],
        confidence: "medium".into(),
        confidence_reason: "host episode report is complete".into(),
        missing_or_next_evidence: vec!["missing_root_evidence".into()],
        asserted_semantic_occurrence_count: Some(EPISODES as u64),
        ..Default::default()
    };
    let key = TriageKnownAnswerKey {
        case_id: "xyz-real-format-56".into(),
        time_quality_expected: "wall".into(),
        sources_present: vec![],
        sources_omitted: vec![],
        decoy_earliest_error_message_token: None,
        true_trigger_message_token: None,
        symptom_message_tokens: vec![],
        root_cause_establishable: false,
        forbidden_claims: vec!["14840_semantic_occurrences".into()],
        required_disclosures: vec!["missing_root_evidence".into()],
    };
    let scored = score_structured_triage_answer(&answer, &key, &facts);
    assert!(
        !scored.dimensions.is_empty(),
        "triage-quality must score host facts from the product report"
    );
}

// ─── Adversarial mutations (fail closed) ───────────────────────────────────

#[test]
fn mutation_interleaved_threads_do_not_merge_into_one_episode() {
    use cd_core::log_analysis::exception_episodes::analyze_bounded_events;
    use cd_core::log_analysis::{ActiveTimestampBasis, TimeQuality, TimestampProvenance};

    fn ev(seq: u64, ts: i64, source: &str, msg: &str) -> ExplorerEvent {
        ExplorerEvent {
            seq,
            ts,
            timestamp_provenance: TimestampProvenance::ExplicitWallClock,
            active_timestamp_basis: ActiveTimestampBasis::ExplicitWall,
            unresolved_local_timestamp: None,
            time_quality: TimeQuality::Wall,
            level: "error".into(),
            service: Some("xyz".into()),
            host: Some("h".into()),
            template_id: seq + 10,
            trace_id: None,
            message: msg.into(),
            source: source.into(),
        }
    }
    let events = vec![
        ev(
            1,
            100,
            "app.log",
            "thread=worker-A java.lang.RuntimeException: XYZ_I\n at com.xyz.A.m(A.java:1)",
        ),
        ev(
            2,
            100,
            "app.log",
            "thread=worker-B java.lang.RuntimeException: XYZ_I\n at com.xyz.A.m(A.java:1)",
        ),
        ev(
            3,
            100,
            "stderr.log",
            "thread=worker-A [stderr] java.lang.RuntimeException: XYZ_I",
        ),
        ev(
            4,
            100,
            "stderr.log",
            "thread=worker-B [stderr] java.lang.RuntimeException: XYZ_I",
        ),
    ];
    let a = analyze_bounded_events(4, &events);
    // Must not collapse both threads into a single episode.
    assert!(
        a.occurrence_count >= 2,
        "interleaved threads must not form one episode (got {})",
        a.occurrence_count
    );
}

#[test]
fn mutation_conflicting_trace_ids_refuse_duplicate_merge() {
    use cd_core::log_analysis::exception_episodes::analyze_bounded_events;
    use cd_core::log_analysis::{ActiveTimestampBasis, TimeQuality, TimestampProvenance};

    fn ev(seq: u64, ts: i64, source: &str, msg: &str, trace: &str) -> ExplorerEvent {
        ExplorerEvent {
            seq,
            ts,
            timestamp_provenance: TimestampProvenance::ExplicitWallClock,
            active_timestamp_basis: ActiveTimestampBasis::ExplicitWall,
            unresolved_local_timestamp: None,
            time_quality: TimeQuality::Wall,
            level: "error".into(),
            service: Some("xyz".into()),
            host: Some("h".into()),
            template_id: seq + 10,
            trace_id: Some(trace.into()),
            message: msg.into(),
            source: source.into(),
        }
    }
    let events = vec![
        ev(
            1,
            50,
            "app.log",
            "java.lang.RuntimeException: XYZ_T\n at com.xyz.A.m(A.java:1)",
            "trace-A",
        ),
        ev(
            2,
            50,
            "stderr.log",
            "[stderr] java.lang.RuntimeException: XYZ_T",
            "trace-B",
        ),
    ];
    let a = analyze_bounded_events(2, &events);
    assert_eq!(
        a.duplicate_rendering_occurrence_count, 0,
        "conflicting trace_id must refuse dual-render merge"
    );
}

#[test]
fn mutation_cancellation_mid_scan_returns_cancelled() {
    let import = tempfile::tempdir().unwrap();
    write_real_format_cascade(import.path());
    let (_cache, _id, corpus) = ingest_dir(import.path());
    let cancel = AtomicBool::new(true);
    let err = analyze_exception_episodes_with_cancel(&corpus, &[], Some(&cancel)).unwrap_err();
    assert!(
        matches!(err, cd_core::error::CoreError::Cancelled)
            || err.to_string().to_lowercase().contains("cancel"),
        "cancel must be terminal: {err}"
    );
}

#[test]
fn mutation_analysis_does_not_mutate_durable_store_event_count() {
    let import = tempfile::tempdir().unwrap();
    write_real_format_cascade(import.path());
    let (_cache, _id, corpus) = ingest_dir(import.path());
    let before = all_events(&corpus).len();
    let _ = analyze_exception_episodes(&corpus, &[]).unwrap();
    let after = all_events(&corpus).len();
    assert_eq!(
        before, after,
        "analysis must not invent or drop durable events"
    );
}

#[test]
fn mutation_revision_drift_fail_closed_on_real_format_corpus() {
    // Product-path pin → concurrent store mutation mid-scan → fail closed.
    let import = tempfile::tempdir().unwrap();
    write_real_format_cascade(import.path());
    write_unrelated_controls(import.path());
    let (_cache, _id, corpus) = ingest_dir(import.path());

    // Baseline: analysis pins a revision and does not invent exact oracle geometry.
    let baseline = analyze_exception_episodes(&corpus, &[]).unwrap();
    let pinned = baseline
        .pinned_event_revision
        .expect("product analysis pins event revision");
    let again = analyze_exception_episodes(&corpus, &[]).unwrap();
    assert_eq!(again.pinned_event_revision, Some(pinned));
    assert_eq!(again.occurrence_count, baseline.occurrence_count);

    // Between-analyses product path: mutate store, re-analyze, pin advances.
    // Mid-scan revision fail-closed is covered by unit tests (cfg(test) page hook).
    let (_c2, _id2, corpus2) = ingest_dir(import.path());
    let before_mut = analyze_exception_episodes(&corpus2, &[]).unwrap();
    let before_pin = before_mut
        .pinned_event_revision
        .expect("pins event revision");
    corpus2
        .push_events(&[LogEvent {
            seq: 99_999_991,
            ts: 1_700_000_999,
            timestamp_provenance: TimestampProvenance::ExplicitWallClock,
            active_timestamp_basis: ActiveTimestampBasis::ExplicitWall,
            unresolved_local_timestamp: None,
            level: "ERROR".into(),
            service: Some("mutator".into()),
            host: Some("mutator".into()),
            template_id: 42,
            params: vec![],
            trace_id: None,
            message: "java.lang.RuntimeException: XYZ_MUT_MID_SCAN\n at com.xyz.M.m(M.java:1)"
                .into(),
            source: "mutator.log".into(),
        }])
        .expect("push_events");
    corpus2.flush().expect("flush");
    let re = analyze_exception_episodes(&corpus2, &[]).unwrap();
    let re_pin = re
        .pinned_event_revision
        .expect("re-analysis pins event revision");
    assert_ne!(
        re_pin, before_pin,
        "retry after mutation must advance pinned event revision"
    );
    assert_ne!(re_pin, pinned);
    for family in &re.families {
        for occ in &family.occurrences {
            for c in &occ.citations {
                let page = query_event_rows(
                    &corpus2,
                    &EventQuery {
                        seq_from: Some(c.seq),
                        seq_to: Some(c.seq),
                        limit: 2,
                        sort_by_time: false,
                        ..Default::default()
                    },
                )
                .unwrap();
                assert!(
                    page.events
                        .iter()
                        .any(|e| e.seq == c.seq && e.source == c.source),
                    "retry must not invent unresolved citations"
                );
            }
        }
    }
}

#[test]
fn mutation_rotation_files_do_not_form_one_strongly_supported_chain_episode() {
    // Real rotation-style sources: same signature across .log and .log.1 must not
    // invent a single 8-rendering strongly-supported episode.
    let import = tempfile::tempdir().unwrap();
    let root = import.path();
    fs::create_dir_all(root).unwrap();
    // Current rotation: one app layer + few stderr lines.
    fs::write(
        root.join("XYZ_server.log"),
        "\
2026-03-15 12:00:00,000 ERROR [XYZ_app] (default task-1) XYZ_LAYER0: java.lang.RuntimeException: XYZ_ROT id=0
\tat com.xyz.layer0.Handler.handle(Handler0.java:10)
2026-03-15 12:00:00,100 ERROR [stderr] (pool-40-thread-1) XYZ_HDR_CAUSE java.lang.RuntimeException: XYZ_ROT id=0
2026-03-15 12:00:00,101 ERROR [stderr] (pool-40-thread-1) at com.xyz.payment.StackFrame0.invoke(StackFrame0.java:1) XYZ_AT_FRAME
",
    )
    .unwrap();
    // Prior rotation (same family signature, different window/thread).
    fs::write(
        root.join("XYZ_server.log.1"),
        "\
2026-03-15 11:00:00,000 ERROR [XYZ_app] (default task-9) XYZ_LAYER0: java.lang.RuntimeException: XYZ_ROT id=9
\tat com.xyz.layer0.Handler.handle(Handler0.java:10)
2026-03-15 11:00:00,100 ERROR [stderr] (pool-40-thread-9) XYZ_HDR_CAUSE java.lang.RuntimeException: XYZ_ROT id=9
2026-03-15 11:00:00,101 ERROR [stderr] (pool-40-thread-9) at com.xyz.payment.StackFrame0.invoke(StackFrame0.java:1) XYZ_AT_FRAME
",
    )
    .unwrap();
    let (_cache, _id, corpus) = ingest_dir(root);
    let analysis = analyze_exception_episodes(&corpus, &[]).unwrap();
    // Fail closed: no single strongly-supported episode with 8 renderings / 272 records.
    let strong_eight = analysis
        .families
        .iter()
        .flat_map(|f| &f.occurrences)
        .any(|o| {
            o.duplicate_rendering
                && o.rendering_count as usize == RENDERINGS_PER_EPISODE
                && o.raw_record_count as usize == RAW_PER_EPISODE
        });
    assert!(
        !strong_eight,
        "rotation-only shared type must not invent a full 8-rendering chain episode"
    );
    assert!(
        analysis.occurrence_count >= 2 || analysis.rendering_episode_count >= 2,
        "rotation files must remain separable (occ={} renderings={})",
        analysis.occurrence_count,
        analysis.rendering_episode_count
    );
}

#[test]
fn mutation_near_window_timestamp_jitter_without_execution_key_fails_closed() {
    // Same signature, near wall windows (≤2s), no shared thread/trace — must not
    // claim a strongly-supported multi-app 8-rendering episode.
    fn ev(seq: u64, ts: i64, source: &str, msg: &str) -> ExplorerEvent {
        ExplorerEvent {
            seq,
            ts,
            timestamp_provenance: TimestampProvenance::ExplicitWallClock,
            active_timestamp_basis: ActiveTimestampBasis::ExplicitWall,
            unresolved_local_timestamp: None,
            time_quality: TimeQuality::Wall,
            level: "error".into(),
            service: Some("xyz".into()),
            host: Some("h".into()),
            template_id: seq + 10,
            trace_id: None,
            message: msg.into(),
            source: source.into(),
        }
    }
    let mut events = Vec::new();
    // 7 app layers at t=100..106 without thread keys.
    for layer in 0..7u64 {
        events.push(ev(
            layer + 1,
            100 + layer as i64,
            "app.log",
            &format!("java.lang.RuntimeException: XYZ_JITTER\n at com.xyz.L{layer}.m(L.java:1)"),
        ));
    }
    // stderr stream at t=101 with no thread key (jitter within window).
    events.push(ev(
        10,
        101,
        "stderr.log",
        "[stderr] java.lang.RuntimeException: XYZ_JITTER",
    ));
    for f in 0..5u64 {
        events.push(ev(
            11 + f,
            101,
            "stderr.log",
            &format!("[stderr] at com.xyz.F{f}.m(F.java:1)"),
        ));
    }
    let a = analyze_bounded_events(events.len() as u64, &events);
    let invented = a.families.iter().flat_map(|f| &f.occurrences).any(|o| {
        o.rendering_count as usize == RENDERINGS_PER_EPISODE
            && o.application_record_count as usize == APP_RENDERINGS_PER_EXEC
            && o.duplicate_rendering
    });
    assert!(
        !invented,
        "near-window jitter without strong execution key must not invent 7-app chain episode (occ={} dup={})",
        a.occurrence_count,
        a.duplicate_rendering_occurrence_count
    );
}

#[test]
fn mutation_scan_cap_fail_closed_no_invented_exact_episode_totals() {
    // Production path under real caps on the full corpus must complete (15232 < 50k).
    // Cap-hit fail-closed is covered by unit tests (cfg(test) overrides only).
    let import = tempfile::tempdir().unwrap();
    write_real_format_cascade(import.path());
    write_unrelated_controls(import.path());
    let (_cache, _id, corpus) = ingest_dir(import.path());
    let analysis = analyze_exception_episodes(&corpus, &[]).unwrap();
    assert!(
        !analysis.partial && analysis.counts_complete,
        "full real-format inventory must complete under production scan caps: scope={}",
        analysis.candidate_scope
    );
    // Must not invent semantic totals without certification.
    if !analysis.semantic_counts_certified {
        // Unanchored company shape: incomplete semantic is honest.
        assert!(
            analysis.strong_derived_episode_count < EPISODES as u64
                || analysis.unresolved_rendering_count > 0
                || analysis.unpaired_rendering_count > 0
                || !analysis.correlation_complete
        );
    }
}

#[test]
fn mutation_render_cap_discloses_partial_without_inventing_episode_geometry() {
    // Exceed physical rendering cap via analyze_bounded_events.
    fn ev(seq: u64, ts: i64, msg: &str) -> ExplorerEvent {
        ExplorerEvent {
            seq,
            ts,
            timestamp_provenance: TimestampProvenance::ExplicitWallClock,
            active_timestamp_basis: ActiveTimestampBasis::ExplicitWall,
            unresolved_local_timestamp: None,
            time_quality: TimeQuality::Wall,
            level: "error".into(),
            service: Some("xyz".into()),
            host: Some("h".into()),
            template_id: seq + 10,
            trace_id: None,
            message: msg.into(),
            source: format!("src{seq}.log"),
        }
    }
    let n = EXCEPTION_EPISODE_RENDER_CAP + 32;
    let mut events = Vec::with_capacity(n);
    for i in 0..n {
        events.push(ev(
            i as u64 + 1,
            100 + i as i64,
            &format!("java.lang.RuntimeException: XYZ_CAP_RENDER_{i}\n at com.xyz.A.m(A.java:1)"),
        ));
    }
    let analysis = analyze_bounded_events(events.len() as u64, &events);
    assert!(
        analysis.partial
            || analysis.rendering_episode_count as usize <= EXCEPTION_EPISODE_RENDER_CAP,
        "render cap must bound physical renderings or mark partial"
    );
    // Must not invent the real-format 56×8 geometry from unrelated unique exceptions.
    assert_ne!(
        analysis.occurrence_count as usize, EPISODES,
        "render-cap burst must not invent exact 56-episode oracle"
    );
    assert!(
        analysis
            .families
            .iter()
            .flat_map(|f| &f.occurrences)
            .all(|o| o.rendering_count < RENDERINGS_PER_EPISODE as u64
                || o.application_record_count != APP_RENDERINGS_PER_EXEC as u64),
        "must not invent 8-rendering / 7-app chain episodes under cap burst"
    );
}

#[test]
fn mutation_ambiguous_shared_type_without_execution_boundary_fails_closed() {
    // Shared exception type, same wall second, no thread/trace keys, multiple
    // app + stderr streams — must not form a strongly-supported 8-rendering episode.
    fn ev(seq: u64, source: &str, msg: &str) -> ExplorerEvent {
        ExplorerEvent {
            seq,
            ts: 1_000,
            timestamp_provenance: TimestampProvenance::ExplicitWallClock,
            active_timestamp_basis: ActiveTimestampBasis::ExplicitWall,
            unresolved_local_timestamp: None,
            time_quality: TimeQuality::Wall,
            level: "error".into(),
            service: Some("xyz".into()),
            host: Some("h".into()),
            template_id: seq + 10,
            trace_id: None,
            message: msg.into(),
            source: source.into(),
        }
    }
    let mut events = Vec::new();
    for layer in 0..7u64 {
        events.push(ev(
            layer + 1,
            &format!("app{layer}.log"),
            &format!("java.lang.RuntimeException: XYZ_AMBIG\n at com.xyz.L{layer}.m(L.java:1)"),
        ));
    }
    for i in 0..8u64 {
        events.push(ev(
            20 + i,
            &format!("stderr{i}.log"),
            "[stderr] java.lang.RuntimeException: XYZ_AMBIG",
        ));
        events.push(ev(
            40 + i,
            &format!("stderr{i}.log"),
            "[stderr] at com.xyz.A.m(A.java:1)",
        ));
    }
    let a = analyze_bounded_events(events.len() as u64, &events);
    let strong_eight = a.families.iter().flat_map(|f| &f.occurrences).any(|o| {
        o.duplicate_rendering
            && o.rendering_count as usize == RENDERINGS_PER_EPISODE
            && o.application_record_count as usize == APP_RENDERINGS_PER_EXEC
            && o.raw_record_count as usize == RAW_PER_EPISODE
    });
    assert!(
        !strong_eight,
        "ambiguous shared type without execution boundary must not invent a full chain episode (matching_ambiguous={} occ={})",
        a.matching_ambiguous,
        a.occurrence_count
    );
    // Prefer honest ambiguity disclosure when multi-edge graphs exist.
    assert!(
        a.matching_ambiguous
            || a.duplicate_rendering_occurrence_count < EPISODES as u64
            || a.unpaired_rendering_count > 0,
        "ambiguous component must disclose uncertainty or leave unpaired renderings"
    );
}

#[test]
fn mutation_fabricated_citation_rejected_by_resolution() {
    // Any citation from analysis must resolve; empty / invented seqs are rejected.
    let import = tempfile::tempdir().unwrap();
    // Minimal 1-exec fixture via generator constants: write full then only check cites.
    write_real_format_cascade(import.path());
    let (_cache, _id, corpus) = ingest_dir(import.path());
    let analysis = analyze_exception_episodes(&corpus, &[]).unwrap();
    for family in &analysis.families {
        for occ in &family.occurrences {
            for c in &occ.citations {
                let page = query_event_rows(
                    &corpus,
                    &EventQuery {
                        seq_from: Some(c.seq),
                        seq_to: Some(c.seq),
                        limit: 2,
                        sort_by_time: false,
                        ..Default::default()
                    },
                )
                .unwrap();
                assert!(
                    page.events
                        .iter()
                        .any(|e| e.seq == c.seq && e.source == c.source),
                    "fabricated citation not allowed"
                );
            }
        }
    }
}

#[test]
fn mutation_message_equality_alone_does_not_merge_far_windows() {
    use cd_core::log_analysis::exception_episodes::analyze_bounded_events;
    use cd_core::log_analysis::{ActiveTimestampBasis, TimeQuality, TimestampProvenance};

    fn ev(seq: u64, ts: i64, source: &str, msg: &str) -> ExplorerEvent {
        ExplorerEvent {
            seq,
            ts,
            timestamp_provenance: TimestampProvenance::ExplicitWallClock,
            active_timestamp_basis: ActiveTimestampBasis::ExplicitWall,
            unresolved_local_timestamp: None,
            time_quality: TimeQuality::Wall,
            level: "error".into(),
            service: Some("xyz".into()),
            host: Some("h".into()),
            template_id: seq + 10,
            trace_id: None,
            message: msg.into(),
            source: source.into(),
        }
    }
    let events = vec![
        ev(
            1,
            100,
            "a.log",
            "java.lang.RuntimeException: XYZ_SAME\n at com.xyz.A.m(A.java:1)",
        ),
        ev(
            2,
            10_000,
            "b.log",
            "[stderr] java.lang.RuntimeException: XYZ_SAME",
        ),
    ];
    let a = analyze_bounded_events(2, &events);
    assert_eq!(
        a.duplicate_rendering_occurrence_count, 0,
        "message equality + far wall must not dual-merge"
    );
}

#[test]
fn mutation_input_reorder_is_deterministic_for_bounded_events() {
    use cd_core::log_analysis::exception_episodes::analyze_bounded_events;
    use cd_core::log_analysis::{ActiveTimestampBasis, TimeQuality, TimestampProvenance};

    fn ev(seq: u64, ts: i64, source: &str, msg: &str) -> ExplorerEvent {
        ExplorerEvent {
            seq,
            ts,
            timestamp_provenance: TimestampProvenance::ExplicitWallClock,
            active_timestamp_basis: ActiveTimestampBasis::ExplicitWall,
            unresolved_local_timestamp: None,
            time_quality: TimeQuality::Wall,
            level: "error".into(),
            service: Some("xyz".into()),
            host: Some("h".into()),
            template_id: seq + 10,
            trace_id: None,
            message: msg.into(),
            source: source.into(),
        }
    }
    let mut events = vec![
        ev(
            1,
            10,
            "app.log",
            "java.lang.RuntimeException: XYZ_R\n at com.xyz.A.m(A.java:1)",
        ),
        ev(
            2,
            10,
            "stderr.log",
            "[stderr] java.lang.RuntimeException: XYZ_R",
        ),
        ev(3, 10, "stderr.log", "[stderr] at com.xyz.A.m(A.java:1)"),
        ev(
            4,
            30,
            "app.log",
            "java.lang.RuntimeException: XYZ_R\n at com.xyz.A.m(A.java:1)",
        ),
        ev(
            5,
            30,
            "stderr.log",
            "[stderr] java.lang.RuntimeException: XYZ_R",
        ),
    ];
    let forward = analyze_bounded_events(events.len() as u64, &events);
    events.reverse();
    let backward = analyze_bounded_events(events.len() as u64, &events);
    assert_eq!(forward.occurrence_count, backward.occurrence_count);
    assert_eq!(
        forward.duplicate_rendering_occurrence_count,
        backward.duplicate_rendering_occurrence_count
    );
}

#[test]
fn mutation_reused_thread_name_across_far_windows_does_not_cross_merge() {
    use cd_core::log_analysis::exception_episodes::analyze_bounded_events;
    use cd_core::log_analysis::{ActiveTimestampBasis, TimeQuality, TimestampProvenance};

    fn ev(seq: u64, ts: i64, source: &str, msg: &str) -> ExplorerEvent {
        ExplorerEvent {
            seq,
            ts,
            timestamp_provenance: TimestampProvenance::ExplicitWallClock,
            active_timestamp_basis: ActiveTimestampBasis::ExplicitWall,
            unresolved_local_timestamp: None,
            time_quality: TimeQuality::Wall,
            level: "error".into(),
            service: Some("xyz".into()),
            host: Some("h".into()),
            template_id: seq + 10,
            trace_id: None,
            message: msg.into(),
            source: source.into(),
        }
    }
    // Same thread name, hours apart — must not dual-merge.
    let events = vec![
        ev(
            1,
            100,
            "app.log",
            "thread=pool-40-thread-1 java.lang.RuntimeException: XYZ_REUSE\n at com.xyz.A.m(A.java:1)",
        ),
        ev(
            2,
            10_000,
            "stderr.log",
            "thread=pool-40-thread-1 [stderr] java.lang.RuntimeException: XYZ_REUSE",
        ),
    ];
    let a = analyze_bounded_events(2, &events);
    assert_eq!(
        a.duplicate_rendering_occurrence_count, 0,
        "reused thread across far wall windows must not merge"
    );
}

#[test]
fn mutation_missing_stderr_header_does_not_invent_episode_counts() {
    use cd_core::log_analysis::exception_episodes::analyze_bounded_events;
    use cd_core::log_analysis::{ActiveTimestampBasis, TimeQuality, TimestampProvenance};

    fn ev(seq: u64, ts: i64, source: &str, msg: &str) -> ExplorerEvent {
        ExplorerEvent {
            seq,
            ts,
            timestamp_provenance: TimestampProvenance::ExplicitWallClock,
            active_timestamp_basis: ActiveTimestampBasis::ExplicitWall,
            unresolved_local_timestamp: None,
            time_quality: TimeQuality::Wall,
            level: "error".into(),
            service: Some("xyz".into()),
            host: Some("h".into()),
            template_id: seq + 10,
            trace_id: None,
            message: msg.into(),
            source: source.into(),
        }
    }
    // Frames without header — must not invent a full dual-render episode.
    let events = vec![
        ev(
            1,
            10,
            "stderr.log",
            "[stderr] at com.xyz.OnlyFrame.m(Only.java:1)",
        ),
        ev(
            2,
            10,
            "stderr.log",
            "[stderr] at com.xyz.OnlyFrame.n(Only.java:2)",
        ),
    ];
    let a = analyze_bounded_events(2, &events);
    assert_eq!(
        a.duplicate_rendering_occurrence_count, 0,
        "missing header must not invent dual-render episodes"
    );
}

#[test]
fn mutation_naive_divisibility_is_not_acceptance() {
    // Forbidden mutant: total_raw / 272 == 56 is not product proof.
    let naive = TOTAL_RAW / RAW_PER_EPISODE;
    assert_eq!(naive, EPISODES);
    // Product path must still be consulted — divisibility alone is not enough.
    let import = tempfile::tempdir().unwrap();
    write_real_format_cascade(import.path());
    let (_cache, _id, corpus) = ingest_dir(import.path());
    let analysis = analyze_exception_episodes(&corpus, &[]).unwrap();
    // If product under-merges, naive divisibility would falsely claim 56.
    if analysis.occurrence_count as usize != EPISODES {
        eprintln!(
            "naive_divisibility would claim {naive} but product occurrence_count={} — red checkpoint holds",
            analysis.occurrence_count
        );
    }
    // Still require product equality (this test participates in the red suite).
    assert_eq!(
        analysis.occurrence_count as usize, EPISODES,
        "product occurrence_count must equal oracle 56; divisibility alone is not acceptance"
    );
}

// ─── Company-shaped unanchored path (must not certify 56) ──────────────────

#[test]
fn company_shaped_unanchored_remains_uncertified() {
    let import = tempfile::tempdir().unwrap();
    write_company_shaped_unanchored_cascade(import.path());
    write_unrelated_controls(import.path());
    let (_cache, _id, corpus) = ingest_dir(import.path());
    let analysis = analyze_exception_episodes(&corpus, &[]).expect("analyze must run");
    eprintln!(
        "UNANCHORED: raw={} renderings={} strong={} unpaired={} cert={} corr={}",
        analysis.raw_exception_record_count,
        analysis.rendering_episode_count,
        analysis.strong_derived_episode_count,
        analysis.unpaired_rendering_count,
        analysis.semantic_counts_certified,
        analysis.correlation_complete,
    );
    // Physical reconstruction may still recover raw/renderings.
    assert_eq!(analysis.raw_exception_record_count as usize, TOTAL_RAW);
    assert_eq!(analysis.rendering_episode_count as usize, TOTAL_RENDERINGS);
    // Without shared request/trace/correlation, semantic totals must not certify.
    assert!(
        !analysis.semantic_counts_certified,
        "company-shaped unanchored corpus must not certify exact 56 episodes"
    );
    assert!(
        analysis.strong_derived_episode_count < EPISODES as u64
            || !analysis.correlation_complete
            || analysis.unpaired_rendering_count > 0
            || analysis.unresolved_rendering_count > 0,
        "must not report certified strong geometry without anchors"
    );
    // Broad triage must not expose exact semantic 56.
    // (host facts only when certified — covered via with_exception_episode_report)
    let facts = cd_core::triage_quality::TriageHostFacts {
        time_quality: "order_only".into(),
        exact_event_count: TOTAL_RAW as u64,
        exact_error_count: None,
        sources_present: BTreeSet::new(),
        evidence: vec![],
        messages_by_seq: vec![],
        known_semantic_occurrence_count: None,
        stderr_record_count: None,
        raw_exception_record_count: None,
        episode_counts_complete: false,
    }
    .with_exception_episode_report(&analysis);
    assert!(!facts.episode_counts_complete);
    assert!(facts.known_semantic_occurrence_count.is_none());
}
