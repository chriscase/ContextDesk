use assert_cmd::Command;
use predicates::prelude::*;
use serde_json::json;

#[path = "helpers/app_config.rs"]
mod app_config;

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

/// A host boundary bounds its callers. `--concurrency` may be lowered to 1
/// and must never be raised above the published ceiling; the refusal lands
/// before any library or provider access.
#[test]
fn concurrency_cannot_be_raised_above_the_published_ceiling() {
    let data_dir = tempfile::tempdir().expect("data dir");
    let candidates = tempfile::tempdir().expect("candidate dir");
    let (first, second) = write_two_candidates(candidates.path());

    for value in ["0", "5", &(usize::MAX.to_string())] {
        let mut command = Command::cargo_bin("contextdesk").expect("contextdesk binary");
        command
            .args([
                "--data-dir",
                data_dir.path().to_str().expect("data path"),
                "bench-compare",
                "--library",
                "/path/that-need-not-exist",
                "--task",
                "task:missing",
                "--candidate",
                first.to_str().expect("first path"),
                "--candidate",
                second.to_str().expect("second path"),
                "--concurrency",
                value,
            ])
            .assert()
            .failure()
            .code(1)
            .stderr(predicate::str::contains(
                "bench-compare --concurrency must be between 1 and",
            ));
    }
}

#[test]
fn concurrency_one_is_accepted_and_fails_on_the_missing_library() {
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
            "/path/that-need-not-exist",
            "--task",
            "task:missing",
            "--candidate",
            first.to_str().expect("first path"),
            "--candidate",
            second.to_str().expect("second path"),
            "--concurrency",
            "1",
        ])
        .assert()
        .failure()
        .stderr(predicate::str::contains(
            "benchmark library could not be opened",
        ));
}

fn remote_profile(id: &str, api_key_ref: &str) -> cd_core::providers::ProviderProfile {
    use cd_core::providers::{
        ProviderCapabilities, ProviderDeadlinePreference, ProviderKind, ProviderProfile,
    };
    ProviderProfile {
        id: id.into(),
        label: id.into(),
        kind: ProviderKind::OpenAiCompatible,
        base_url: "https://gateway.example/v1".into(),
        api_key_ref: Some(api_key_ref.into()),
        chat_model: "synthetic-model".into(),
        embedding_model: None,
        embedding_base_url: None,
        capabilities: ProviderCapabilities {
            tools: true,
            stream: true,
            embeddings: false,
        },
        local_only: false,
        deadline_preference: ProviderDeadlinePreference::Auto,
    }
}

fn write_app_config(
    data_dir: &std::path::Path,
    profiles: Vec<cd_core::providers::ProviderProfile>,
) -> std::path::PathBuf {
    use cd_core::config::AppConfig;
    use cd_core::providers::ProviderConfig;
    let active_id = profiles.first().map(|profile| profile.id.clone());
    let cfg = AppConfig {
        providers: ProviderConfig {
            active_id,
            profiles,
        },
        ..AppConfig::default()
    };
    let data_dir = data_dir.canonicalize().expect("canonical data dir");
    app_config::plant_app_config(&data_dir.join("config.json"), &cfg);
    data_dir
}

fn candidate_for_profile(profile_id: &str, cancellation_id: &str) -> serde_json::Value {
    json!({
        "policy": {
            "kind": "standard",
            "model": {
                "profile_id": profile_id,
                "model_id": "synthetic-model"
            }
        },
        "cancellation_id": cancellation_id,
        "strategy": {
            "name": "fixture",
            "operator": "test",
            "created_at": "2026-01-15T08:00:00Z"
        }
    })
}

#[test]
fn mixed_employer_and_vercel_reject_the_global_api_key_before_library_or_provider_access() {
    let data_dir = tempfile::tempdir().expect("data dir");
    let data_root = write_app_config(
        data_dir.path(),
        vec![
            remote_profile("employer", "provider/employer/api_key"),
            remote_profile("vercel", "provider/vercel/api_key"),
        ],
    );
    let candidates = tempfile::tempdir().expect("candidate dir");
    let first = candidates.path().join("employer.json");
    let second = candidates.path().join("vercel.json");
    std::fs::write(
        &first,
        serde_json::to_vec(&candidate_for_profile("employer", "cancel:employer"))
            .expect("candidate JSON"),
    )
    .expect("employer candidate");
    std::fs::write(
        &second,
        serde_json::to_vec(&candidate_for_profile("vercel", "cancel:vercel"))
            .expect("candidate JSON"),
    )
    .expect("vercel candidate");

    const SHARED: &str = "synthetic-shared-key-must-not-leak";
    let mut command = Command::cargo_bin("contextdesk").expect("contextdesk binary");
    command
        .env("CONTEXTDESK_PROVIDER_API_KEY", SHARED)
        .args([
            "--data-dir",
            data_root.to_str().expect("data path"),
            "bench-compare",
            "--library",
            "/path/that-must-not-be-opened",
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
        .stderr(predicate::str::contains("mixed-provider"))
        .stderr(predicate::str::contains("employer"))
        .stderr(predicate::str::contains("vercel"))
        .stderr(predicate::str::contains(SHARED).not())
        .stderr(predicate::str::contains("benchmark library").not());
}

#[test]
fn single_profile_comparison_still_accepts_the_global_override() {
    let data_dir = tempfile::tempdir().expect("data dir");
    let data_root = write_app_config(
        data_dir.path(),
        vec![remote_profile("vercel", "provider/vercel/api_key")],
    );
    let candidates = tempfile::tempdir().expect("candidate dir");
    let first = candidates.path().join("a.json");
    let second = candidates.path().join("b.json");
    std::fs::write(
        &first,
        serde_json::to_vec(&candidate_for_profile("vercel", "cancel:one")).expect("candidate JSON"),
    )
    .expect("first candidate");
    std::fs::write(
        &second,
        serde_json::to_vec(&candidate_for_profile("vercel", "cancel:two")).expect("candidate JSON"),
    )
    .expect("second candidate");

    let mut command = Command::cargo_bin("contextdesk").expect("contextdesk binary");
    command
        .env(
            "CONTEXTDESK_PROVIDER_API_KEY",
            "synthetic-shared-key-must-not-leak",
        )
        .args([
            "--data-dir",
            data_root.to_str().expect("data path"),
            "bench-compare",
            "--library",
            "/path/that-need-not-exist",
            "--task",
            "task:missing",
            "--candidate",
            first.to_str().expect("first path"),
            "--candidate",
            second.to_str().expect("second path"),
        ])
        .assert()
        .failure()
        .stderr(predicate::str::contains(
            "benchmark library could not be opened",
        ))
        .stderr(predicate::str::contains("mixed-provider").not())
        .stderr(predicate::str::contains("synthetic-shared-key-must-not-leak").not());
}
