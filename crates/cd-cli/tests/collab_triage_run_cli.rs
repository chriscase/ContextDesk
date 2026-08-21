//! Process-level guards for the Collab host boundary.

use assert_cmd::Command;
use base64::Engine as _;
use predicates::prelude::*;
use serde_json::json;

fn cli() -> Command {
    Command::cargo_bin("contextdesk").expect("contextdesk binary")
}

fn base_request(bytes_base64: &str) -> serde_json::Value {
    json!({
        "schemaId": "cd-collab.triage_run_request.v1",
        "jobId": "job-cli",
        "createdAt": "2026-08-20T00:00:00Z",
        "requestedBy": "user-cli",
        "case": {
            "caseId": "case-cli",
            "title": "CLI case",
            "reportedProblem": {"summary": "A bounded CLI test"},
            "createdAt": "2026-08-20T00:00:00Z"
        },
        "snapshot": {
            "snapshotId": "snapshot-cli",
            "fingerprint": "b93d95e924083031baaf0dac13548417d311c3e1e8402604bf9b255200488120",
            "parentSnapshotId": null,
            "evidence": [{
                "evidenceId": "ev-cli",
                "ordinal": 0,
                "contentHash": null,
                "expectedHash": null,
                "verificationStatus": null,
                "privacyClass": "owner_only"
            }],
            "visibility": "owner_only",
            "protocolVersion": "cd-collab.snapshot.v1",
            "capturedAt": "2026-08-20T00:00:00Z",
            "capturedBy": "user-cli"
        },
        "question": "What happened?",
        "evidence": [{
            "itemId": "ev-cli",
            "bytesBase64": bytes_base64,
            "captureTime": "2026-08-20T00:00:00Z"
        }],
        "candidates": [{
            "candidateId": "candidate-cli",
            "profileId": "profile:test",
            "modelId": "model:test",
            "role": "reviewer"
        }]
    })
}

fn run_request(request: serde_json::Value) -> assert_cmd::assert::Assert {
    let dir = Box::leak(Box::new(tempfile::tempdir().expect("tempdir")));
    let path = dir.path().join("request.json");
    std::fs::write(&path, serde_json::to_vec(&request).expect("request JSON"))
        .expect("request file");
    let path = path.to_path_buf();
    cli()
        .args([
            "--data-dir",
            "/tmp/contextdesk-collab-cli-test",
            "collab-triage-run",
            "--request",
        ])
        .arg(path)
        .assert()
}

#[test]
fn malformed_request_is_a_safe_user_error() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("malformed.json");
    std::fs::write(&path, b"{not-json").expect("malformed request");
    cli()
        .args([
            "--data-dir",
            "/tmp/contextdesk-collab-cli-test",
            "collab-triage-run",
            "--request",
        ])
        .arg(path)
        .assert()
        .failure()
        .code(1)
        .stderr(predicate::str::contains("Collab request JSON is malformed"));
}

#[test]
fn malformed_base64_is_not_echoed() {
    let secret_like = "sk-secret-evidence-not-base64";
    run_request(base_request(secret_like))
        .failure()
        .code(1)
        .stderr(predicate::str::contains("malformed base64"))
        .stderr(predicate::str::contains(secret_like).not());
}

#[test]
fn oversized_evidence_is_rejected_before_host_execution() {
    let bytes = base64::engine::general_purpose::STANDARD.encode(vec![b'x'; 4 * 1024 * 1024 + 1]);
    run_request(base_request(&bytes))
        .failure()
        .code(1)
        .stderr(predicate::str::contains("bounded size"));
}
