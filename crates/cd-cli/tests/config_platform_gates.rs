//! CI-facing platform gates for AppConfig persistence versus read-only CLI.
//!
//! Hosted Windows shards previously treated fail-closed `save_config` /
//! `ensure_config_dir` as model, gateway, or doctor failures. This file
//! proves the split: planted fixtures keep read-only commands usable;
//! production save on unsupported hosts is `not_implemented` and does not
//! mutate.

use assert_cmd::Command;
use cd_core::config::AppConfig;
#[cfg(not(unix))]
use cd_core::config::{DURABLE_CONFIG_DIR_UNSUPPORTED, DURABLE_CONFIG_SAVE_UNSUPPORTED};
use serde_json::Value;
use std::path::Path;

#[path = "helpers/app_config.rs"]
mod app_config;

fn cli(data_dir: &Path) -> Command {
    let mut cmd =
        Command::cargo_bin("contextdesk").expect("contextdesk binary built by this workspace");
    cmd.args(["--data-dir", data_dir.to_str().unwrap()]);
    cmd
}

fn jsonl(stdout: &[u8]) -> Vec<Value> {
    String::from_utf8_lossy(stdout)
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).expect("every stdout line is JSON"))
        .collect()
}

#[cfg(not(unix))]
fn parse_envelope(bytes: &[u8]) -> Value {
    serde_json::from_slice(bytes).unwrap_or_else(|error| {
        panic!(
            "stdout is one JSON envelope: {error}; stdout={:?}",
            String::from_utf8_lossy(bytes)
        )
    })
}

#[test]
fn doctor_skip_live_turn_reads_planted_config_without_durable_save() {
    let data = tempfile::tempdir().unwrap();
    app_config::plant_app_config(&data.path().join("config.json"), &AppConfig::default());
    let output = cli(data.path())
        .args(["--jsonl", "doctor", "--skip-live-turn", "--timeout", "3"])
        .output()
        .expect("doctor");
    assert_eq!(
        output.status.code(),
        Some(8),
        "stderr={}",
        String::from_utf8_lossy(&output.stderr)
    );
    let lines = jsonl(&output.stdout);
    assert!(
        lines
            .iter()
            .any(|line| line["type"] == "check" && line["id"] == "config"),
        "planted config must still produce a config check: {lines:?}"
    );
    assert!(
        lines
            .iter()
            .any(|line| line["type"] == "check" && line["id"] == "writable_state"),
        "planted config must still produce a writable_state check: {lines:?}"
    );
}

#[cfg(not(unix))]
#[test]
fn config_init_with_provider_refuses_before_mutation() {
    let data = tempfile::tempdir().unwrap();
    let output = cli(data.path())
        .args([
            "--json",
            "config",
            "init",
            "--non-interactive",
            "--provider-kind",
            "ollama",
            "--chat-model",
            "llama3",
            "--profile-id",
            "platform-gate-ollama",
        ])
        .output()
        .expect("config init");
    assert_eq!(output.status.code(), Some(7));
    let envelope = parse_envelope(&output.stdout);
    assert_eq!(envelope["ok"], false);
    assert_eq!(envelope["error"]["kind"], "not_implemented");
    let message = envelope["error"]["message"].as_str().unwrap_or("");
    assert!(
        message.contains(DURABLE_CONFIG_SAVE_UNSUPPORTED),
        "{message}"
    );
    assert!(!data.path().join("config.json").exists());
    assert!(!data.path().join("cli.toml").exists());
}

#[cfg(not(unix))]
#[test]
fn config_deadline_set_refuses_and_leaves_planted_bytes_unchanged() {
    let data = tempfile::tempdir().unwrap();
    let mut router = AppConfig::default().router;
    router.deadline_ms = 180_000;
    router.deadline_is_explicit = false;
    let cfg = AppConfig {
        router,
        ..AppConfig::default()
    };
    app_config::plant_app_config(&data.path().join("config.json"), &cfg);
    let path = data.path().join("config.json");
    let before = std::fs::read(&path).unwrap();

    let output = cli(data.path())
        .args(["--json", "config", "deadline", "set", "90s"])
        .output()
        .expect("deadline set");
    assert_eq!(output.status.code(), Some(7));
    let envelope = parse_envelope(&output.stdout);
    assert_eq!(envelope["ok"], false);
    assert_eq!(envelope["error"]["kind"], "not_implemented");
    let message = envelope["error"]["message"].as_str().unwrap_or("");
    assert!(
        message.contains(DURABLE_CONFIG_SAVE_UNSUPPORTED),
        "{message}"
    );
    assert_eq!(before, std::fs::read(&path).unwrap());
}

#[cfg(not(unix))]
#[test]
fn config_effort_set_refuses_and_leaves_planted_bytes_unchanged() {
    let data = tempfile::tempdir().unwrap();
    app_config::plant_app_config(&data.path().join("config.json"), &AppConfig::default());
    let path = data.path().join("config.json");
    let before = std::fs::read(&path).unwrap();

    let output = cli(data.path())
        .args(["--json", "config", "effort", "set", "xhigh"])
        .output()
        .expect("effort set");
    assert_eq!(output.status.code(), Some(7));
    let envelope = parse_envelope(&output.stdout);
    assert_eq!(envelope["ok"], false);
    assert_eq!(envelope["error"]["kind"], "not_implemented");
    let message = envelope["error"]["message"].as_str().unwrap_or("");
    assert!(
        message.contains(DURABLE_CONFIG_SAVE_UNSUPPORTED),
        "{message}"
    );
    assert_eq!(before, std::fs::read(&path).unwrap());
}

#[cfg(not(unix))]
#[test]
fn shared_profile_without_data_dir_refuses_directory_creation() {
    let output = Command::cargo_bin("contextdesk")
        .expect("contextdesk binary")
        .args([
            "--json",
            "config",
            "init",
            "--non-interactive",
            "--skip-provider",
        ])
        .output()
        .expect("config init without data-dir");
    assert_eq!(
        output.status.code(),
        Some(7),
        "stderr={} stdout={}",
        String::from_utf8_lossy(&output.stderr),
        String::from_utf8_lossy(&output.stdout)
    );
    let envelope = parse_envelope(&output.stdout);
    assert_eq!(envelope["ok"], false);
    assert_eq!(envelope["error"]["kind"], "not_implemented");
    let message = envelope["error"]["message"].as_str().unwrap_or("");
    assert!(
        message.contains(DURABLE_CONFIG_DIR_UNSUPPORTED),
        "{message}"
    );
}
