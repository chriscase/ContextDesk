//! CLI tests for `cd-triage-bench` (offline, no credentials, no network).

mod common;

use assert_cmd::Command;
use common::*;
use predicates::prelude::*;
use serde_json::json;
use std::fs;
use std::path::Path;

fn bench() -> Command {
    Command::cargo_bin("cd-triage-bench").expect("cd-triage-bench")
}

fn write_json(path: &Path, value: &serde_json::Value) {
    fs::write(path, serde_json::to_vec_pretty(value).unwrap()).unwrap();
}

#[test]
fn init_and_import_work_with_poisoned_home() {
    let tmp = tempfile::tempdir().unwrap();
    let library = tmp.path().join("lib");
    let home_file = tmp.path().join("home-is-a-file");
    fs::write(&home_file, b"must remain unchanged").unwrap();

    bench()
        .env("HOME", &home_file)
        .args(["--library", library.to_str().unwrap(), "init"])
        .assert()
        .success();

    let case_path = tmp.path().join("case.json");
    write_json(
        &case_path,
        &json!({
            "schema_id": "contextdesk.triage_bench.case.v1",
            "case_id": "case-cli",
            "privacy": "share_safe",
            "title": "CLI case",
            "reported_problem": { "summary": "checkout 500s" },
            "lifecycle": "unresolved",
            "timeline_notes": [],
            "created_at": "2026-01-15T00:00:00Z"
        }),
    );

    bench()
        .env("HOME", &home_file)
        .args([
            "--library",
            library.to_str().unwrap(),
            "import-case",
            case_path.to_str().unwrap(),
        ])
        .assert()
        .success()
        .stdout("case-cli\n");

    let blob = tmp.path().join("app.log");
    fs::write(&blob, LOG_BYTES).unwrap();
    let digest = cd_triage_bench::types::ContentDigest::of_bytes(LOG_BYTES);
    let snapshot_path = tmp.path().join("snapshot.json");
    write_json(
        &snapshot_path,
        &json!({
            "schema_id": "contextdesk.triage_bench.evidence_snapshot.v1",
            "privacy": "share_safe",
            "case_id": "case-cli",
            "captured_at": "2026-01-15T06:00:00Z",
            "captured_by": "cli",
            "items": [{
                "kind": "log",
                "item_id": "ev-log-1",
                "privacy": "share_safe",
                "capture_time": "2026-01-15T04:12:00Z",
                "source": { "reference": "app.log", "captured_from": "cli" },
                "media_type": "text/plain",
                "format": "raw",
                "content": { "digest": { "algorithm": "sha256", "hex": digest.hex }, "byte_length": LOG_BYTES.len() },
                "summaries": [],
                "visible_to_strategies": true
            }]
        }),
    );

    let snap_out = bench()
        .env("HOME", &home_file)
        .args([
            "--library",
            library.to_str().unwrap(),
            "import-snapshot",
            snapshot_path.to_str().unwrap(),
            "--blob",
            blob.to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert!(
        snap_out.status.success(),
        "{}",
        String::from_utf8_lossy(&snap_out.stderr)
    );
    let snapshot_id = String::from_utf8(snap_out.stdout)
        .unwrap()
        .trim()
        .to_string();

    let task_path = tmp.path().join("task.json");
    write_json(
        &task_path,
        &json!({
            "schema_id": "contextdesk.triage_bench.evaluation_task.v1",
            "privacy": "share_safe",
            "case_id": "case-cli",
            "snapshot_id": snapshot_id,
            "question": "What failed?",
            "protocol": "visible evidence only",
            "protocol_version": "v1",
            "visibility": {
                "visible_item_ids": ["ev-log-1"],
                "include_summaries": true,
                "include_raw_bytes": true
            },
            "created_at": "2026-01-15T07:00:00Z"
        }),
    );
    let task_out = bench()
        .env("HOME", &home_file)
        .args([
            "--library",
            library.to_str().unwrap(),
            "import-task",
            task_path.to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert!(
        task_out.status.success(),
        "{}",
        String::from_utf8_lossy(&task_out.stderr)
    );
    let task_id = String::from_utf8(task_out.stdout)
        .unwrap()
        .trim()
        .to_string();

    let md = format!(
        "```json\n{}\n```\n\nHuman write-up: inventory timeout.\n",
        serde_json::json!({
            "schema_id": "contextdesk.triage_bench.run_import.v1",
            "task_id": task_id,
            "strategy": {
                "name": "human-expert",
                "version": { "status": "unknown" },
                "build": { "status": "unknown" }
            },
            "source_kind": "human",
            "prompt_workflow": {
                "completeness": "unknown",
                "prompt": { "status": "unknown" },
                "workflow": { "status": "unknown" }
            },
            "timing": { "status": "unknown" },
            "cost": { "status": "unknown" },
            "uncertainty": { "status": "unknown" },
            "fairness": { "kind": "same_snapshot" },
            "status": "completed",
            "operator": "alice",
            "importer": "bob",
            "privacy": "share_safe",
            "created_at": "2026-01-15T08:00:00Z"
        })
    );
    let md_path = tmp.path().join("human.md");
    fs::write(&md_path, md).unwrap();
    bench()
        .env("HOME", &home_file)
        .args([
            "--library",
            library.to_str().unwrap(),
            "import-run",
            md_path.to_str().unwrap(),
        ])
        .assert()
        .success()
        .stdout(predicate::str::starts_with("created run-"));

    let web_path = tmp.path().join("web.json");
    write_json(
        &web_path,
        &json!({
            "schema_id": "contextdesk.triage_bench.run_import.v1",
            "task_id": task_id,
            "strategy": {
                "name": "web-assistant",
                "version": { "status": "known", "value": "paste" },
                "build": { "status": "unknown" }
            },
            "source_kind": "web_only",
            "prompt_workflow": {
                "completeness": "unknown",
                "prompt": { "status": "unknown" },
                "workflow": { "status": "unknown" }
            },
            "raw_output_utf8": "Pasted assistant transcript: looks like DNS.",
            "timing": { "status": "unknown" },
            "cost": { "status": "unknown" },
            "uncertainty": { "status": "unknown" },
            "fairness": { "kind": "unknown_visibility" },
            "status": "completed",
            "operator": "alice",
            "privacy": "share_safe",
            "created_at": "2026-01-15T08:05:00Z"
        }),
    );
    bench()
        .env("HOME", &home_file)
        .args([
            "--library",
            library.to_str().unwrap(),
            "import-run",
            web_path.to_str().unwrap(),
        ])
        .assert()
        .success();

    let other_raw = tmp.path().join("other.txt");
    fs::write(
        &other_raw,
        "JSON export from another product: timeout likely.",
    )
    .unwrap();
    let other_path = tmp.path().join("other.json");
    write_json(
        &other_path,
        &json!({
            "schema_id": "contextdesk.triage_bench.run_import.v1",
            "task_id": task_id,
            "strategy": {
                "name": "other-product",
                "version": { "status": "known", "value": "9.1" },
                "build": { "status": "unknown" }
            },
            "source_kind": "other_product",
            "prompt_workflow": {
                "completeness": "partial",
                "prompt": { "status": "unknown" },
                "workflow": { "status": "known", "value": "exported after a UI session" }
            },
            "timing": { "status": "unknown" },
            "cost": { "status": "unknown" },
            "uncertainty": { "status": "known", "value": "inconclusive" },
            "fairness": { "kind": "same_snapshot" },
            "status": "partial",
            "operator": "carol",
            "privacy": "share_safe",
            "created_at": "2026-01-15T08:10:00Z"
        }),
    );
    bench()
        .env("HOME", &home_file)
        .args([
            "--library",
            library.to_str().unwrap(),
            "import-run",
            other_path.to_str().unwrap(),
            "--raw",
            other_raw.to_str().unwrap(),
        ])
        .assert()
        .success();

    bench()
        .env("HOME", &home_file)
        .args(["--library", library.to_str().unwrap(), "list", "runs"])
        .assert()
        .success()
        .stdout(predicate::str::contains("run-"));

    let packet = bench()
        .env("HOME", &home_file)
        .args(["--library", library.to_str().unwrap(), "packet", &task_id])
        .output()
        .unwrap();
    assert!(packet.status.success());
    let packet_text = String::from_utf8_lossy(&packet.stdout);
    assert!(!packet_text.contains("adjudicated_root_cause"));
    assert!(!packet_text.contains("resolution"));

    let report = bench()
        .env("HOME", &home_file)
        .args([
            "--library",
            library.to_str().unwrap(),
            "report",
            "--format",
            "json",
            "--privacy",
            "share-safe",
        ])
        .output()
        .unwrap();
    assert!(
        report.status.success(),
        "{}",
        String::from_utf8_lossy(&report.stderr)
    );
    let report_text = String::from_utf8(report.stdout).unwrap();
    let once = report_text.clone();
    let report2 = bench()
        .env("HOME", &home_file)
        .args([
            "--library",
            library.to_str().unwrap(),
            "report",
            "--format",
            "json",
            "--privacy",
            "share-safe",
        ])
        .output()
        .unwrap();
    assert_eq!(once, String::from_utf8(report2.stdout).unwrap());
    assert!(once.contains("fairness_class_mismatch") || once.contains("unknown_visibility"));
    assert!(!once.to_ascii_lowercase().contains("ready"));
    assert_eq!(fs::read(&home_file).unwrap(), b"must remain unchanged");
}

#[test]
fn unknown_field_imports_are_rejected_without_generated_ids() {
    let tmp = tempfile::tempdir().unwrap();
    let library = tmp.path().join("lib");
    bench()
        .args(["--library", library.to_str().unwrap(), "init"])
        .assert()
        .success();
    let fixtures = Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/invalid");
    for (command, file) in [
        ("import-case", "case-unknown-field.json"),
        ("import-snapshot", "snapshot-unknown-field.json"),
        ("import-task", "task-unknown-field.json"),
        ("import-run", "run-unknown-field.json"),
        ("import-adjudication", "adjudication-unknown-field.json"),
    ] {
        bench()
            .args([
                "--library",
                library.to_str().unwrap(),
                command,
                fixtures.join(file).to_str().unwrap(),
            ])
            .assert()
            .failure()
            .stderr(predicate::str::contains("unknown field"));
    }
}

#[test]
fn identity_mismatch_imports_are_rejected() {
    let tmp = tempfile::tempdir().unwrap();
    let library = tmp.path().join("lib");
    bench()
        .args(["--library", library.to_str().unwrap(), "init"])
        .assert()
        .success();
    let fixtures = Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/invalid");
    bench()
        .args([
            "--library",
            library.to_str().unwrap(),
            "import-snapshot",
            fixtures
                .join("snapshot-identity-mismatch.json")
                .to_str()
                .unwrap(),
        ])
        .assert()
        .failure()
        .stderr(predicate::str::contains("snapshot_id does not match"));
    bench()
        .args([
            "--library",
            library.to_str().unwrap(),
            "import-task",
            fixtures
                .join("task-identity-mismatch.json")
                .to_str()
                .unwrap(),
        ])
        .assert()
        .failure()
        .stderr(predicate::str::contains("task_id does not match"));
    bench()
        .args([
            "--library",
            library.to_str().unwrap(),
            "import-adjudication",
            fixtures
                .join("adjudication-identity-mismatch.json")
                .to_str()
                .unwrap(),
        ])
        .assert()
        .failure()
        .stderr(predicate::str::contains("adjudication_id does not match"));
}

#[test]
fn run_sdk_mock_records_a_contextdesk_run() {
    let tmp = tempfile::tempdir().unwrap();
    let library = tmp.path().join("lib");
    let store = init_store(&library);
    store.put_case(&resolved_case()).unwrap();
    let snapshot = snapshot_for(&store, "case-checkout-cascade");
    let task = task_for(&store, &snapshot);

    bench()
        .args([
            "--library",
            library.to_str().unwrap(),
            "run-sdk",
            &task.task_id,
            "--engine",
            "mock",
            "--script",
            "completed",
        ])
        .assert()
        .success()
        .stdout(predicate::str::contains("created run-"))
        .stdout(predicate::str::contains("status=completed"));
}
