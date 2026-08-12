//! Process-level checks for the provider-free Triage SDK CLI facade.

use assert_cmd::Command;
use serde_json::Value;
use std::path::Path;

fn request_json() -> String {
    serde_json::json!({
        "schema_id": "contextdesk.triage.request.v2",
        "run_id": "run:cli-process",
        "privacy": "owner_only",
        "task": "What happened?",
        "scope": {"corpus_id": "corpus:cli-process"},
        "policy": {
            "kind": "standard",
            "model": {"profile_id": "profile:test", "model_id": "model:test"}
        },
        "overrides": {},
        "cancellation_id": "cancel:cli-process"
    })
    .to_string()
}

fn cli() -> Command {
    Command::cargo_bin("contextdesk").expect("contextdesk binary")
}

fn run_request(request_path: &Path, format: &str) -> std::process::Output {
    cli()
        .args([
            "--app-config",
            "/definitely/missing/app-config.json",
            "--data-dir",
            "/definitely/missing/data-dir",
            format,
            "triage",
            "run",
            "--request",
        ])
        .arg(request_path)
        .output()
        .expect("run contextdesk triage")
}

#[test]
fn jsonl_facade_parses_v2_request_and_fails_closed_without_state() {
    let dir = tempfile::tempdir().expect("tempdir");
    let request_path = dir.path().join("request.json");
    std::fs::write(&request_path, request_json()).expect("write request");
    let poison_home = dir.path().join("home-is-a-file");
    std::fs::write(&poison_home, b"unchanged").expect("poison HOME");

    let output = cli()
        .env("HOME", &poison_home)
        .args([
            "--app-config",
            "/definitely/missing/app-config.json",
            "--data-dir",
            "/definitely/missing/data-dir",
            "--jsonl",
            "triage",
            "run",
            "--request",
        ])
        .arg(&request_path)
        .output()
        .expect("run contextdesk triage");
    assert_eq!(output.status.code(), Some(7));
    let json: Value = serde_json::from_slice(&output.stdout).expect("one JSONL object");
    assert_eq!(json["ok"], false);
    assert_eq!(json["command"], "triage_run");
    assert_eq!(json["error"]["kind"], "not_implemented");
    assert_eq!(json["data"]["schema_id"], "contextdesk.cli.triage_run.v1");
    assert_eq!(json["data"]["status"], "unsupported");
    assert_eq!(
        json["data"]["reason_codes"][0],
        "production_runner_not_wired"
    );
    assert_eq!(json["data"]["run_id"], "run:cli-process");
    assert_eq!(json["data"]["evidence"]["network"], false);
    assert_eq!(
        std::fs::read(poison_home).expect("HOME bytes"),
        b"unchanged"
    );
}

#[test]
fn malformed_v2_request_is_a_user_error_before_runner_boundary() {
    let dir = tempfile::tempdir().expect("tempdir");
    let request_path = dir.path().join("request.json");
    std::fs::write(
        &request_path,
        r#"{"schema_id":"contextdesk.triage.request.v99"}"#,
    )
    .expect("write request");
    let output = run_request(&request_path, "--json");
    assert_eq!(output.status.code(), Some(1));
    let json: Value = serde_json::from_slice(&output.stdout).expect("one JSON object");
    assert_eq!(json["ok"], false);
    assert_eq!(json["command"], "triage_run");
    assert_eq!(json["error"]["kind"], "user_error");
}

#[test]
fn triage_run_is_explicitly_registered_and_not_rewritten_as_chat() {
    let output = cli()
        .args(["triage", "run", "--help"])
        .output()
        .expect("run help");
    assert!(output.status.success());
    let help = String::from_utf8_lossy(&output.stdout);
    assert!(help.contains("Run one explicit TriageRequestV2 JSON document"));
}
