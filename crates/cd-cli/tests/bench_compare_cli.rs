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

fn write_two_candidates(dir: &std::path::Path) -> (std::path::PathBuf, std::path::PathBuf) {
    let first = dir.join("first.json");
    let second = dir.join("second.json");
    std::fs::write(
        &first,
        serde_json::to_vec(&candidate("cancel:one")).expect("candidate JSON"),
    )
    .expect("first candidate");
    std::fs::write(
        &second,
        serde_json::to_vec(&candidate("cancel:two")).expect("candidate JSON"),
    )
    .expect("second candidate");
    (first, second)
}

/// A host boundary bounds its callers. `--max-blob-bytes` may be lowered and
/// must never be raised above the production import bound the bridge
/// publishes, and the refusal lands before any library or provider access.
#[test]
fn byte_limits_cannot_be_raised_above_the_public_import_bound() {
    let data_dir = tempfile::tempdir().expect("data dir");
    let candidates = tempfile::tempdir().expect("candidate dir");
    let (first, second) = write_two_candidates(candidates.path());

    for (flag, value) in [
        (
            "--max-blob-bytes",
            (cd_triage_bench_live::DEFAULT_LIVE_MAX_BLOB_BYTES + 1).to_string(),
        ),
        (
            "--max-aggregate-bytes",
            (cd_triage_bench_live::DEFAULT_LIVE_MAX_AGGREGATE_BYTES + 1).to_string(),
        ),
        ("--max-blob-bytes", u64::MAX.to_string()),
        ("--max-blob-bytes", "0".to_string()),
    ] {
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
                flag,
                &value,
            ])
            .assert()
            .failure()
            .code(1)
            .stderr(predicate::str::contains(
                "bench-compare byte limits must be greater than zero",
            ));
    }
}

/// A limit at or below the published bound is accepted by validation, so the
/// command proceeds far enough to fail on the missing library instead.
#[test]
fn byte_limits_may_be_lowered() {
    let data_dir = tempfile::tempdir().expect("data dir");
    let candidates = tempfile::tempdir().expect("candidate dir");
    let (first, second) = write_two_candidates(candidates.path());

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
            "--max-blob-bytes",
            "1024",
        ])
        .assert()
        .failure()
        .stderr(predicate::str::contains(
            "benchmark library could not be opened",
        ));
}

#[test]
fn three_candidates_pass_count_validation_before_library_access() {
    let data_dir = tempfile::tempdir().expect("data dir");
    let candidates = tempfile::tempdir().expect("candidate dir");
    let first = candidates.path().join("first.json");
    let second = candidates.path().join("second.json");
    let third = candidates.path().join("third.json");
    for (path, cancellation) in [
        (&first, "cancel:one"),
        (&second, "cancel:two"),
        (&third, "cancel:three"),
    ] {
        std::fs::write(
            path,
            serde_json::to_vec(&candidate(cancellation)).expect("candidate JSON"),
        )
        .expect("candidate");
    }

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
            "--candidate",
            third.to_str().expect("third path"),
        ])
        .assert()
        .failure()
        .stderr(predicate::str::contains(
            "benchmark library could not be opened",
        ))
        .stderr(predicate::str::contains("requires at least two").not());
}
