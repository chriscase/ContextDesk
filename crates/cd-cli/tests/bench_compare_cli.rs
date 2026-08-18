use assert_cmd::Command;
use predicates::prelude::*;
use serde_json::json;

fn candidate(cancellation_id: &str) -> serde_json::Value {
    json!({
        "policy": {
            "kind": "standard",
            "model": {
                "profile_id": "profile:test",
                "model_id": "model:test"
            }
        },
        "cancellation_id": cancellation_id,
        "strategy": {
            "name": "fixture",
            "version": "v1",
            "operator": "test",
            "created_at": "2026-01-15T08:00:00Z"
        },
        "overrides": {
            "deadline_ms": 10000,
            "max_provider_calls": 1
        }
    })
}

#[test]
fn duplicate_candidate_cancellation_ids_fail_before_library_or_provider_access() {
    let data_dir = tempfile::tempdir().expect("data dir");
    let candidates = tempfile::tempdir().expect("candidate dir");
    let first = candidates.path().join("first.json");
    let second = candidates.path().join("second.json");
    std::fs::write(
        &first,
        serde_json::to_vec(&candidate("cancel:same")).expect("candidate JSON"),
    )
    .expect("first candidate");
    std::fs::write(
        &second,
        serde_json::to_vec(&candidate("cancel:same")).expect("candidate JSON"),
    )
    .expect("second candidate");

    let mut command = Command::cargo_bin("contextdesk").expect("contextdesk binary");
    command
        .args([
            "--data-dir",
            data_dir.path().to_str().expect("data path"),
            "bench-compare",
            "--library",
            "/path/that/need-not-exist",
            "--task",
            "task:missing",
            "--candidate",
            first.to_str().expect("first path"),
            "--candidate",
            second.to_str().expect("second path"),
        ])
        .assert()
        .failure()
        .code(1)
        .stderr(predicate::str::contains(
            "candidate cancellation_id values must be unique",
        ));
}
