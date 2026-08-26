//! Process-level guards for the War Room log-time host boundary.
//!
//! Every fixture here is synthetic. The logs describe an invented batch worker
//! and edge gateway; no real host, path, person, or captured log appears.

use assert_cmd::Command;
use base64::Engine as _;
use serde_json::{json, Value};
use std::fs;
use std::path::Path;

fn cli() -> Command {
    Command::cargo_bin("contextdesk").expect("contextdesk binary")
}

fn b64(value: &str) -> String {
    base64::engine::general_purpose::STANDARD.encode(value.as_bytes())
}

/// Zone-less local timestamps spanning the 2024-03-10 US spring-forward.
/// `02:30:00` does not exist in America/Chicago on that date.
const WORKER_LOG: &str = "2024-03-10 01:30:00 INFO  batch worker starting scheduled sweep\n\
                          2024-03-10 01:59:59 INFO  batch worker queue depth 4\n\
                          2024-03-10 02:30:00 WARN  batch worker heartbeat late\n\
                          2024-03-10 03:05:00 ERROR batch worker sweep failed retry 1\n\
                          2024-03-10 03:20:00 INFO  batch worker sweep recovered\n";

/// Explicit UTC. A declaration must never rewrite these.
const GATEWAY_LOG: &str = "2024-03-10T07:30:00Z INFO  edge accepted request rid-0001\n\
                           2024-03-10T07:45:00Z INFO  edge accepted request rid-0002\n\
                           2024-03-10T08:10:00Z ERROR edge upstream timeout rid-0003\n";

/// Zone-less local timestamps spanning the 2024-11-03 US fall-back fold.
const FOLD_LOG: &str = "2024-11-03 01:30:00 WARN  fold worker ambiguous local time\n\
                        2024-11-03 02:30:00 INFO  fold worker after transition\n";

fn run(cache: &Path, request: &Value) -> Value {
    let output = cli()
        .arg("collab-log-time")
        .arg("--request")
        .arg("-")
        .arg("--cache-root")
        .arg(cache)
        .arg("--format")
        .arg("json")
        .write_stdin(serde_json::to_vec(request).expect("request"))
        .output()
        .expect("run collab-log-time");
    serde_json::from_slice(&output.stdout).expect("envelope JSON")
}

fn request(case: &str, action: Value) -> Value {
    json!({
        "schemaId": "cd-collab.log_time_request.v1",
        "caseId": case,
        "action": action,
    })
}

#[test]
fn explicit_log_time_requests_ignore_broken_unrelated_application_state() {
    let tmp = tempfile::tempdir().expect("temp root");
    let poisoned_home = tmp.path().join("home-is-a-file");
    let poisoned_data = tmp.path().join("data-is-a-file");
    let bad_project = tmp.path().join("bad-project.toml");
    let bad_app = tmp.path().join("bad-app.json");
    let cache = tmp.path().join("log-time-cache");
    fs::write(&poisoned_home, b"unchanged-home").expect("poison HOME");
    fs::write(&poisoned_data, b"unchanged-data").expect("poison data dir");
    fs::write(&bad_project, b"not = [valid").expect("bad project config");
    fs::write(&bad_app, b"{not-json").expect("bad app config");

    let input = request(
        "case-synthetic-state-free",
        json!({
            "kind": "build",
            "corpusName": "synthetic state-free corpus",
            "files": [
                {"relativePath": "worker/batch.log", "contentBase64": b64(WORKER_LOG)},
            ],
        }),
    );
    let output = cli()
        .env("HOME", &poisoned_home)
        .arg("--data-dir")
        .arg(&poisoned_data)
        .arg("--config")
        .arg(&bad_project)
        .arg("--app-config")
        .arg(&bad_app)
        .arg("collab-log-time")
        .arg("--request")
        .arg("-")
        .arg("--cache-root")
        .arg(&cache)
        .args(["--format", "json"])
        .write_stdin(serde_json::to_vec(&input).expect("request"))
        .output()
        .expect("run state-free collab-log-time");
    let envelope: Value = serde_json::from_slice(&output.stdout).expect("envelope JSON");

    assert_eq!(envelope["ok"], json!(true), "build failed: {envelope}");
    assert_eq!(fs::read(&poisoned_home).unwrap(), b"unchanged-home");
    assert_eq!(fs::read(&poisoned_data).unwrap(), b"unchanged-data");
    assert_eq!(fs::read(&bad_project).unwrap(), b"not = [valid");
    assert_eq!(fs::read(&bad_app).unwrap(), b"{not-json");
}

fn build(cache: &Path) -> Value {
    build_case(
        cache,
        "case-synthetic-0001",
        vec![
            json!({"relativePath": "worker/batch.log", "contentBase64": b64(WORKER_LOG)}),
            json!({"relativePath": "gateway/edge.log", "contentBase64": b64(GATEWAY_LOG)}),
        ],
    )
}

fn build_case(cache: &Path, case_id: &str, files: Vec<Value>) -> Value {
    let envelope = run(
        cache,
        &request(
            case_id,
            json!({
                "kind": "build",
                "corpusName": "synthetic war room case",
                "files": files,
            }),
        ),
    );
    assert_eq!(envelope["ok"], json!(true), "build failed: {envelope}");
    envelope["data"].clone()
}

fn chronology(
    cache: &Path,
    case_id: &str,
    corpus: &str,
    search: Option<&str>,
    sources: &[&str],
    limit: usize,
    cursor: Option<&str>,
) -> Value {
    run(
        cache,
        &request(
            case_id,
            json!({
                "kind": "chronology",
                "corpusId": corpus,
                "search": search,
                "sources": sources,
                "limit": limit,
                "cursor": cursor,
            }),
        ),
    )
}

fn preview(cache: &Path, corpus: &str, revision: u64, zone: &str) -> Value {
    run(
        cache,
        &request(
            "case-synthetic-0001",
            json!({
                "kind": "preview",
                "corpusId": corpus,
                "expectedRevision": revision,
                "source": "worker/batch.log",
                "ianaTimezone": zone,
            }),
        ),
    )
}

#[test]
fn build_leaves_zone_less_sources_unresolved_instead_of_guessing() {
    let cache = tempfile::tempdir().expect("cache");
    let data = build(cache.path());

    assert_eq!(
        data["build"]["timezoneAmbiguousSources"],
        json!(["worker/batch.log"])
    );
    assert!(
        data["declarations"]
            .as_object()
            .expect("declarations")
            .is_empty(),
        "import must not invent a declaration"
    );
    let sources = data["sources"].as_array().expect("sources");
    let worker = sources
        .iter()
        .find(|s| s["source"] == json!("worker/batch.log"))
        .expect("worker source");
    assert_eq!(worker["unresolvedLocalRecords"], json!(5));
    assert_eq!(worker["resolvedLocalRecords"], json!(0));
}

#[test]
fn preview_reports_the_dst_gap_and_keeps_raw_beside_normalized() {
    let cache = tempfile::tempdir().expect("cache");
    let data = build(cache.path());
    let corpus = data["corpusId"].as_str().expect("corpus id").to_string();
    let revision = data["corpusRevision"].as_u64().expect("revision");

    let envelope = preview(cache.path(), &corpus, revision, "America/Chicago");
    assert_eq!(envelope["ok"], json!(true), "preview failed: {envelope}");
    let preview = &envelope["data"]["preview"];

    assert_eq!(preview["dstGapCount"], json!(1));
    assert_eq!(preview["affectedRecords"], json!(4));

    let samples = preview["samples"].as_array().expect("samples");
    let gap = samples
        .iter()
        .find(|s| s["outcome"] == json!("unresolved"))
        .expect("the gap line stays unresolved");
    assert_eq!(gap["unresolvedReason"], json!("nonexistent_dst_gap"));
    assert_eq!(gap["rawTimestamp"], json!("2024-03-10 02:30:00"));
    assert_eq!(gap["normalizedInstant"], json!(null));

    // The offset moves across the boundary; both sides keep their raw text.
    let before = samples
        .iter()
        .find(|s| s["rawTimestamp"] == json!("2024-03-10 01:30:00"))
        .expect("pre-transition line");
    let after = samples
        .iter()
        .find(|s| s["rawTimestamp"] == json!("2024-03-10 03:05:00"))
        .expect("post-transition line");
    assert_eq!(before["utcOffsetSeconds"], json!(-21600));
    assert_eq!(after["utcOffsetSeconds"], json!(-18000));
    assert_eq!(before["normalizedInstant"], json!("2024-03-10T07:30:00Z"));
}

#[test]
fn preview_never_mutates_the_corpus() {
    let cache = tempfile::tempdir().expect("cache");
    let data = build(cache.path());
    let corpus = data["corpusId"].as_str().expect("corpus id").to_string();
    let revision = data["corpusRevision"].as_u64().expect("revision");

    preview(cache.path(), &corpus, revision, "America/Chicago");
    let after = run(
        cache.path(),
        &request(
            "case-synthetic-0001",
            json!({"kind": "status", "corpusId": corpus}),
        ),
    );
    assert_eq!(after["data"]["corpusRevision"], json!(revision));
    assert!(after["data"]["declarations"]
        .as_object()
        .expect("declarations")
        .is_empty());
}

#[test]
fn an_unrecognized_zone_is_refused_never_repaired_into_a_guess() {
    let cache = tempfile::tempdir().expect("cache");
    let data = build(cache.path());
    let corpus = data["corpusId"].as_str().expect("corpus id").to_string();
    let revision = data["corpusRevision"].as_u64().expect("revision");

    for zone in ["Not/A_Real_Zone", "CST", "GMT+5"] {
        let envelope = preview(cache.path(), &corpus, revision, zone);
        assert_eq!(envelope["ok"], json!(false), "zone {zone} must be refused");
    }
}

#[test]
fn apply_requires_the_exact_preview_fingerprint_and_revision() {
    let cache = tempfile::tempdir().expect("cache");
    let data = build(cache.path());
    let corpus = data["corpusId"].as_str().expect("corpus id").to_string();
    let revision = data["corpusRevision"].as_u64().expect("revision");
    let fingerprint = preview(cache.path(), &corpus, revision, "America/Chicago")["data"]
        ["preview"]["declarationFingerprint"]
        .as_str()
        .expect("fingerprint")
        .to_string();

    let apply = |rev: u64, fp: &str| {
        run(
            cache.path(),
            &request(
                "case-synthetic-0001",
                json!({
                    "kind": "apply",
                    "corpusId": corpus,
                    "expectedRevision": rev,
                    "source": "worker/batch.log",
                    "ianaTimezone": "America/Chicago",
                    "declarationFingerprint": fp,
                    "declaredAt": 1_710_093_600i64,
                }),
            ),
        )
    };

    let tampered = apply(revision, &"0".repeat(64));
    assert_eq!(tampered["ok"], json!(false));
    assert_eq!(tampered["error"]["kind"], json!("conflict"));

    let stale = apply(revision + 50, &fingerprint);
    assert_eq!(stale["ok"], json!(false));
    assert_eq!(stale["error"]["kind"], json!("conflict"));

    let good = apply(revision, &fingerprint);
    assert_eq!(good["ok"], json!(true), "apply failed: {good}");
    assert_eq!(
        good["data"]["revision"]["appliedRevision"],
        json!(revision + 1)
    );
    assert_eq!(good["data"]["revision"]["changedRecords"], json!(4));
}

#[test]
fn applying_preserves_the_unresolvable_line_as_order_only_evidence() {
    let cache = tempfile::tempdir().expect("cache");
    let data = build(cache.path());
    let corpus = data["corpusId"].as_str().expect("corpus id").to_string();
    let revision = data["corpusRevision"].as_u64().expect("revision");
    let fingerprint = preview(cache.path(), &corpus, revision, "America/Chicago")["data"]
        ["preview"]["declarationFingerprint"]
        .as_str()
        .expect("fingerprint")
        .to_string();

    let applied = run(
        cache.path(),
        &request(
            "case-synthetic-0001",
            json!({
                "kind": "apply",
                "corpusId": corpus,
                "expectedRevision": revision,
                "source": "worker/batch.log",
                "ianaTimezone": "America/Chicago",
                "declarationFingerprint": fingerprint,
                "declaredAt": 1_710_093_600i64,
            }),
        ),
    );
    let worker = applied["data"]["sources"]
        .as_array()
        .expect("sources")
        .iter()
        .find(|s| s["source"] == json!("worker/batch.log"))
        .expect("worker source")
        .clone();

    assert_eq!(worker["resolvedLocalRecords"], json!(4));
    assert_eq!(
        worker["unresolvedLocalRecords"],
        json!(1),
        "the DST-gap line must survive as order-only evidence"
    );
}

#[test]
fn chronology_orders_cross_source_instants_before_order_only_and_pages_stably() {
    let cache = tempfile::tempdir().expect("cache");
    let data = build(cache.path());
    let corpus = data["corpusId"].as_str().expect("corpus id");

    let first_envelope = chronology(
        cache.path(),
        "case-synthetic-0001",
        corpus,
        None,
        &[],
        3,
        None,
    );
    assert_eq!(
        first_envelope["ok"],
        json!(true),
        "chronology failed: {first_envelope}"
    );
    let first = &first_envelope["data"]["chronology"];
    assert_eq!(first["totalMatched"], json!(8));
    assert_eq!(first["orderOnlyCount"], json!(5));
    assert_eq!(first["timeQuality"], json!("mixed"));
    let first_rows = first["rows"].as_array().expect("first rows");
    assert_eq!(first_rows.len(), 3);
    assert!(first_rows
        .iter()
        .all(|row| row["source"] == json!("gateway/edge.log")));
    assert_eq!(
        first_rows[0]["normalizedInstant"],
        json!("2024-03-10T07:30:00Z")
    );
    assert_eq!(first_rows[0]["rawTimestamp"], json!(null));

    let cursor = first["nextCursor"].as_str().expect("next cursor");
    let second_envelope = chronology(
        cache.path(),
        "case-synthetic-0001",
        corpus,
        None,
        &[],
        3,
        Some(cursor),
    );
    assert_eq!(
        second_envelope["ok"],
        json!(true),
        "second page failed: {second_envelope}"
    );
    let second_rows = second_envelope["data"]["chronology"]["rows"]
        .as_array()
        .expect("second rows");
    let order_only = second_rows
        .iter()
        .find(|row| row["timeState"] == json!("order_only"))
        .expect("order-only worker row");
    assert_eq!(order_only["source"], json!("worker/batch.log"));
    assert_eq!(order_only["rawTimestamp"], json!("2024-03-10 01:30:00"));
    assert_eq!(order_only["normalizedInstant"], json!(null));
    assert_eq!(order_only["orderOnlyReason"], json!("timezone_unresolved"));
}

#[test]
fn chronology_supports_literal_search_and_exact_source_filter() {
    let cache = tempfile::tempdir().expect("cache");
    let data = build_case(
        cache.path(),
        "case-synthetic-literal",
        vec![json!({
            "relativePath": "literal/source.log",
            "contentBase64": b64("INFO literal 100% marker\n"),
        })],
    );
    let corpus = data["corpusId"].as_str().expect("corpus id");
    let page = chronology(
        cache.path(),
        "case-synthetic-literal",
        corpus,
        Some("%"),
        &["literal/source.log"],
        10,
        None,
    );
    assert_eq!(page["ok"], json!(true), "literal chronology failed: {page}");
    let chronology = &page["data"]["chronology"];
    assert_eq!(chronology["totalMatched"], json!(1));
    assert_eq!(chronology["rows"][0]["source"], json!("literal/source.log"));
    assert!(chronology["rows"][0]["message"]
        .as_str()
        .expect("message")
        .contains("100%"));
}

#[test]
fn chronology_exposes_fold_and_gap_reasons_without_guessing() {
    let cache = tempfile::tempdir().expect("cache");
    let data = build_case(
        cache.path(),
        "case-synthetic-fold",
        vec![json!({
            "relativePath": "fold/worker.log",
            "contentBase64": b64(FOLD_LOG),
        })],
    );
    let corpus = data["corpusId"].as_str().expect("corpus id").to_string();
    let built_revision = data["corpusRevision"].as_u64().expect("revision");
    let preview = run(
        cache.path(),
        &request(
            "case-synthetic-fold",
            json!({
                "kind": "preview",
                "corpusId": corpus,
                "expectedRevision": built_revision,
                "source": "fold/worker.log",
                "ianaTimezone": "America/Chicago",
            }),
        ),
    );
    assert_eq!(preview["ok"], json!(true), "fold preview failed: {preview}");
    assert_eq!(preview["data"]["preview"]["dstFoldCount"], json!(1));
    let fingerprint = preview["data"]["preview"]["declarationFingerprint"]
        .as_str()
        .expect("fingerprint");
    let applied = run(
        cache.path(),
        &request(
            "case-synthetic-fold",
            json!({
                "kind": "apply",
                "corpusId": corpus,
                "expectedRevision": built_revision,
                "source": "fold/worker.log",
                "ianaTimezone": "America/Chicago",
                "declarationFingerprint": fingerprint,
                "declaredAt": 1_730_601_600i64,
            }),
        ),
    );
    assert_eq!(applied["ok"], json!(true), "fold apply failed: {applied}");

    let page = chronology(
        cache.path(),
        "case-synthetic-fold",
        &corpus,
        Some("fold"),
        &["fold/worker.log"],
        10,
        None,
    );
    assert_eq!(page["ok"], json!(true), "fold chronology failed: {page}");
    let rows = page["data"]["chronology"]["rows"].as_array().expect("rows");
    let ambiguous = rows
        .iter()
        .find(|row| row["orderOnlyReason"] == json!("ambiguous_dst_fold"))
        .expect("ambiguous fold row");
    assert_eq!(ambiguous["rawTimestamp"], json!("2024-11-03 01:30:00"));
    assert_eq!(ambiguous["normalizedInstant"], json!(null));
    assert!(rows.iter().any(|row| row["timeState"] == json!("resolved")));
}

#[test]
fn chronology_reflects_apply_clear_and_undo_as_new_read_snapshots() {
    let cache = tempfile::tempdir().expect("cache");
    let data = build(cache.path());
    let corpus = data["corpusId"].as_str().expect("corpus id").to_string();
    let built_revision = data["corpusRevision"].as_u64().expect("revision");
    let before = chronology(
        cache.path(),
        "case-synthetic-0001",
        &corpus,
        Some("heartbeat"),
        &["worker/batch.log"],
        10,
        None,
    );
    assert_eq!(
        before["data"]["chronology"]["rows"][0]["orderOnlyReason"],
        json!("timezone_unresolved")
    );

    let fingerprint = preview(cache.path(), &corpus, built_revision, "America/Chicago")["data"]
        ["preview"]["declarationFingerprint"]
        .as_str()
        .expect("fingerprint")
        .to_string();
    let applied = run(
        cache.path(),
        &request(
            "case-synthetic-0001",
            json!({
                "kind": "apply",
                "corpusId": corpus,
                "expectedRevision": built_revision,
                "source": "worker/batch.log",
                "ianaTimezone": "America/Chicago",
                "declarationFingerprint": fingerprint,
                "declaredAt": 1_710_093_600i64,
            }),
        ),
    );
    let applied_revision = applied["data"]["revision"]["appliedRevision"]
        .as_u64()
        .expect("applied revision");
    let after_apply = chronology(
        cache.path(),
        "case-synthetic-0001",
        &corpus,
        Some("heartbeat"),
        &["worker/batch.log"],
        10,
        None,
    );
    assert_eq!(
        after_apply["data"]["chronology"]["rows"][0]["orderOnlyReason"],
        json!("nonexistent_dst_gap")
    );

    let cleared = run(
        cache.path(),
        &request(
            "case-synthetic-0001",
            json!({
                "kind": "clear",
                "corpusId": corpus,
                "expectedRevision": applied_revision,
                "source": "worker/batch.log",
            }),
        ),
    );
    let cleared_revision = cleared["data"]["revision"]["appliedRevision"]
        .as_u64()
        .expect("cleared revision");
    let after_clear = chronology(
        cache.path(),
        "case-synthetic-0001",
        &corpus,
        Some("heartbeat"),
        &["worker/batch.log"],
        10,
        None,
    );
    assert_eq!(
        after_clear["data"]["chronology"]["rows"][0]["orderOnlyReason"],
        json!("timezone_unresolved")
    );

    let undone = run(
        cache.path(),
        &request(
            "case-synthetic-0001",
            json!({
                "kind": "undo",
                "corpusId": corpus,
                "expectedRevision": cleared_revision,
            }),
        ),
    );
    assert_eq!(undone["ok"], json!(true), "undo failed: {undone}");
    let after_undo = chronology(
        cache.path(),
        "case-synthetic-0001",
        &corpus,
        Some("heartbeat"),
        &["worker/batch.log"],
        10,
        None,
    );
    assert_eq!(
        after_undo["data"]["chronology"]["rows"][0]["orderOnlyReason"],
        json!("nonexistent_dst_gap")
    );
}

#[test]
fn chronology_wire_has_no_secret_or_local_path_material() {
    let cache = tempfile::tempdir().expect("cache");
    let data = build_case(
        cache.path(),
        "case-synthetic-private",
        vec![json!({
            "relativePath": "safe/synthetic.log",
            "contentBase64": b64("ERROR visible synthetic token=sk-abcdefghijklmnop\n"),
        })],
    );
    let corpus = data["corpusId"].as_str().expect("corpus id");
    let page = chronology(
        cache.path(),
        "case-synthetic-private",
        corpus,
        Some("visible synthetic"),
        &["safe/synthetic.log"],
        10,
        None,
    );
    assert_eq!(page["ok"], json!(true), "private chronology failed: {page}");
    let wire = page.to_string();
    assert!(!wire.contains("sk-abcdefghijklmnop"));
    assert!(!wire.contains("/Users/"));
}

#[test]
fn clear_restores_order_only_and_undo_publishes_a_forward_revision() {
    let cache = tempfile::tempdir().expect("cache");
    let data = build(cache.path());
    let corpus = data["corpusId"].as_str().expect("corpus id").to_string();
    let built = data["corpusRevision"].as_u64().expect("revision");
    let fingerprint = preview(cache.path(), &corpus, built, "America/Chicago")["data"]["preview"]
        ["declarationFingerprint"]
        .as_str()
        .expect("fingerprint")
        .to_string();

    let applied = run(
        cache.path(),
        &request(
            "case-synthetic-0001",
            json!({
                "kind": "apply",
                "corpusId": corpus,
                "expectedRevision": built,
                "source": "worker/batch.log",
                "ianaTimezone": "America/Chicago",
                "declarationFingerprint": fingerprint,
                "declaredAt": 1_710_093_600i64,
            }),
        ),
    );
    let after_apply = applied["data"]["revision"]["appliedRevision"]
        .as_u64()
        .expect("applied revision");

    let cleared = run(
        cache.path(),
        &request(
            "case-synthetic-0001",
            json!({
                "kind": "clear",
                "corpusId": corpus,
                "expectedRevision": after_apply,
                "source": "worker/batch.log",
            }),
        ),
    );
    assert_eq!(cleared["ok"], json!(true), "clear failed: {cleared}");
    let after_clear = cleared["data"]["revision"]["appliedRevision"]
        .as_u64()
        .expect("cleared revision");
    assert!(after_clear > after_apply, "clear advances the revision");
    assert!(cleared["data"]["declarations"]
        .as_object()
        .expect("declarations")
        .is_empty());
    let worker = cleared["data"]["sources"]
        .as_array()
        .expect("sources")
        .iter()
        .find(|s| s["source"] == json!("worker/batch.log"))
        .expect("worker source")
        .clone();
    assert_eq!(worker["unresolvedLocalRecords"], json!(5));
    assert_eq!(worker["resolvedLocalRecords"], json!(0));

    // Undo does not delete history: it publishes a new revision whose content
    // matches the step before the clear, and says which one it restored.
    let undone = run(
        cache.path(),
        &request(
            "case-synthetic-0001",
            json!({
                "kind": "undo",
                "corpusId": corpus,
                "expectedRevision": after_clear,
            }),
        ),
    );
    assert_eq!(undone["ok"], json!(true), "undo failed: {undone}");
    let revision = &undone["data"]["revision"];
    assert_eq!(revision["appliedRevision"], json!(after_clear + 1));
    assert_eq!(revision["restoredRevision"], json!(after_clear - 1));
    assert!(undone["data"]["declarations"]
        .as_object()
        .expect("declarations")
        .contains_key("worker/batch.log"));
}

#[test]
fn a_traversing_or_absolute_file_path_is_refused_at_the_boundary() {
    let cache = tempfile::tempdir().expect("cache");
    for path in ["../escape.log", "/etc/passwd", "a/../../b.log"] {
        let envelope = run(
            cache.path(),
            &request(
                "case-synthetic-0001",
                json!({
                    "kind": "build",
                    "corpusName": "synthetic war room case",
                    "files": [{"relativePath": path, "contentBase64": b64(WORKER_LOG)}],
                }),
            ),
        );
        assert_eq!(envelope["ok"], json!(false), "path {path} must be refused");
        assert_eq!(envelope["error"]["kind"], json!("user_error"));
    }
}

#[test]
fn an_unknown_request_field_is_refused_rather_than_ignored() {
    let cache = tempfile::tempdir().expect("cache");
    let mut body = request(
        "case-synthetic-0001",
        json!({"kind": "status", "corpusId": "does-not-exist"}),
    );
    body["defaultTimezone"] = json!("America/Chicago");

    let envelope = run(cache.path(), &body);
    assert_eq!(envelope["ok"], json!(false));
    assert_eq!(envelope["error"]["kind"], json!("user_error"));
}
