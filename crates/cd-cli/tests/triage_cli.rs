//! Process-level checks for the Triage SDK CLI facade.

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

fn inline_request_json() -> String {
    serde_json::json!({
        "schema_id": "contextdesk.triage.request.v2",
        "run_id": "run:cli-inline",
        "privacy": "owner_only",
        "task": "What happened?",
        "scope": {"corpus_id": "corpus:cli-process"},
        "policy": {
            "kind": "inline",
            "schema_id": "contextdesk.triage_policy.v2",
            "document": {
                "schema_id": "contextdesk.triage_policy.v2",
                "mode": "enhanced"
            }
        },
        "overrides": {},
        "cancellation_id": "cancel:cli-inline"
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
fn standard_request_reaches_the_stateful_runtime_and_reports_failed_terminal() {
    let dir = tempfile::tempdir().expect("tempdir");
    let request_path = dir.path().join("request.json");
    std::fs::write(&request_path, request_json()).expect("write request");
    let data_dir = dir.path().join("data");
    let missing_config = dir.path().join("missing-app-config.json");
    let poison_home = dir.path().join("home-is-a-file");
    std::fs::write(&poison_home, b"unchanged").expect("poison HOME");

    let output = cli()
        .env("HOME", &poison_home)
        .arg("--app-config")
        .arg(&missing_config)
        .arg("--data-dir")
        .arg(&data_dir)
        .args(["--jsonl", "triage", "run", "--request"])
        .arg(&request_path)
        .output()
        .expect("run contextdesk triage");
    assert_eq!(output.status.code(), Some(8));
    let json: Value = serde_json::from_slice(&output.stdout).expect("one JSONL object");
    assert_eq!(json["ok"], true);
    assert_eq!(json["command"], "triage_run");
    assert_eq!(json["data"]["status"], "failed");
    assert_eq!(json["data"]["reason_codes"][0], "policy_preflight_rejected");
    assert_eq!(json["data"]["evidence"]["provider_calls"], 0);
    assert_eq!(json["data"]["evidence"]["network"], false);
    assert_eq!(
        json["data"]["replay"]["events"][2]["event"]["kind"],
        "failed"
    );
    assert_eq!(
        std::fs::read(poison_home).expect("HOME bytes"),
        b"unchanged"
    );
}

#[test]
fn standard_stdin_request_is_parsed_once_before_stateful_dispatch() {
    let dir = tempfile::tempdir().expect("tempdir");
    let output = cli()
        .arg("--app-config")
        .arg(dir.path().join("missing-app-config.json"))
        .arg("--data-dir")
        .arg(dir.path().join("data"))
        .args(["--jsonl", "triage", "run", "--request", "-"])
        .write_stdin(request_json())
        .output()
        .expect("run contextdesk triage from stdin");

    assert_eq!(output.status.code(), Some(8));
    let json: Value = serde_json::from_slice(&output.stdout).expect("one JSONL object");
    assert_eq!(json["ok"], true);
    assert_eq!(json["command"], "triage_run");
    assert_eq!(json["data"]["status"], "failed");
    assert_eq!(json["data"]["reason_codes"][0], "policy_preflight_rejected");
    assert!(!String::from_utf8_lossy(&output.stdout).contains("could not be parsed"));
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

#[test]
fn caller_preflight_is_rejected_before_app_state_for_every_runtime_mode() {
    let dir = tempfile::tempdir().expect("tempdir");
    let missing_data = dir.path().join("must-not-be-created");
    let missing_config = dir.path().join("must-not-be-read.json");
    let missing_preflight = dir.path().join("must-not-be-read-preflight.json");

    for (name, request) in [
        ("standard", request_json()),
        ("enhanced", inline_request_json()),
    ] {
        let request_path = dir.path().join(format!("{name}-request.json"));
        std::fs::write(&request_path, request).expect("write request");
        let output = cli()
            .args(["--app-config"])
            .arg(&missing_config)
            .args(["--data-dir"])
            .arg(&missing_data)
            .args(["--json", "triage", "run", "--request"])
            .arg(&request_path)
            .arg("--preflight")
            .arg(&missing_preflight)
            .output()
            .expect("run contextdesk triage");

        assert_eq!(output.status.code(), Some(1), "{name}");
        let json: Value = serde_json::from_slice(&output.stdout).expect("one JSON object");
        assert_eq!(json["ok"], false, "{name}");
        assert_eq!(json["command"], "triage_run", "{name}");
        assert_eq!(json["error"]["kind"], "user_error", "{name}");
        assert_eq!(
            json["error"]["message"], "caller_preflight_not_authoritative",
            "{name}"
        );
        assert!(!missing_data.exists(), "{name} must remain state-free");
        assert!(!missing_config.exists(), "{name} must not load app config");
        assert!(
            !missing_preflight.exists(),
            "{name} must not consume caller preflight"
        );
    }
}
