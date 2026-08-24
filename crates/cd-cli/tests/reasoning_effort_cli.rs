//! Process-level reasoning-effort controls. Hermetic: no provider or secrets.

use assert_cmd::Command;
use std::fs;
use std::path::{Path, PathBuf};

#[path = "helpers/app_config.rs"]
mod app_config;

fn cli(data: &Path) -> Command {
    let mut cmd = Command::cargo_bin("contextdesk").expect("contextdesk binary");
    cmd.args(["--data-dir", data.to_str().unwrap()]);
    cmd.env("HOME", data);
    cmd
}

fn isolated_data() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().expect("tempdir");
    let data = dir.path().join("data");
    fs::create_dir_all(&data).unwrap();
    (dir, data)
}

fn config_path(data: &Path) -> PathBuf {
    data.join("config.json")
}

fn write_config(data: &Path) {
    let mut cfg = cd_core::config::AppConfig {
        theme: "slate".into(),
        default_timezone: Some("Asia/Tokyo".into()),
        ..Default::default()
    };
    cfg.router.max_sources = 7;
    app_config::plant_app_config(&config_path(data), &cfg);
}

fn run(data: &Path, args: &[&str]) -> std::process::Output {
    cli(data).args(args).output().expect("spawn contextdesk")
}

#[test]
fn effort_show_reads_planted_config_without_writing() {
    let (_tmp, data) = isolated_data();
    write_config(&data);
    let before = fs::read(config_path(&data)).unwrap();
    let show = run(&data, &["--format", "json", "config", "effort", "show"]);
    assert!(
        show.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&show.stderr)
    );
    let output = String::from_utf8_lossy(&show.stdout);
    assert!(
        output.contains("contextdesk.reasoning_effort.v1"),
        "{output}"
    );
    assert_eq!(before, fs::read(config_path(&data)).unwrap());
}

#[cfg(unix)]
#[test]
fn set_show_auto_preserve_unrelated_config() {
    let (_tmp, data) = isolated_data();
    write_config(&data);

    let set = run(&data, &["config", "effort", "set", "xhigh"]);
    assert!(
        set.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&set.stderr)
    );
    let saved = cd_core::config::load_config(&config_path(&data)).unwrap();
    assert_eq!(
        saved.reasoning_effort.level,
        Some(cd_core::reasoning_effort::ReasoningEffortLevel::XHigh)
    );
    assert_eq!(saved.theme, "slate");
    assert_eq!(saved.default_timezone.as_deref(), Some("Asia/Tokyo"));
    assert_eq!(saved.router.max_sources, 7);

    let show = run(&data, &["--format", "json", "config", "effort", "show"]);
    assert!(show.status.success());
    let output = String::from_utf8_lossy(&show.stdout);
    assert!(output.contains("contextdesk.reasoning_effort.v1"));
    assert!(output.contains("xhigh"));
    for forbidden in ["Authorization", "Bearer ", "https://", "/Users/"] {
        assert!(!output.contains(forbidden), "leaked {forbidden}: {output}");
    }

    let auto = run(&data, &["config", "effort", "auto"]);
    assert!(auto.status.success());
    let saved = cd_core::config::load_config(&config_path(&data)).unwrap();
    assert!(saved.reasoning_effort.is_omit());
    assert_eq!(saved.theme, "slate");
    assert_eq!(saved.default_timezone.as_deref(), Some("Asia/Tokyo"));
    assert_eq!(saved.router.max_sources, 7);
}

#[test]
fn malformed_saved_value_and_turn_override_never_rewrite_config() {
    let (_tmp, data) = isolated_data();
    write_config(&data);
    let before = fs::read(config_path(&data)).unwrap();

    for bad in ["ultra", "higher", "1", "HIGHISH"] {
        let output = run(&data, &["config", "effort", "set", bad]);
        assert!(!output.status.success(), "accepted {bad:?}");
        assert_eq!(before, fs::read(config_path(&data)).unwrap());
    }

    let output = run(
        &data,
        &["chat", "--reasoning-effort", "ultra", "what happened?"],
    );
    assert!(!output.status.success());
    let message = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(message.contains("reasoning effort"), "{message}");
    assert_eq!(before, fs::read(config_path(&data)).unwrap());
}

#[test]
fn valid_turn_override_is_non_persistent_even_when_turn_cannot_start() {
    let (_tmp, data) = isolated_data();
    write_config(&data);
    let before = fs::read(config_path(&data)).unwrap();

    // No provider is configured, so the turn may fail later. The accepted
    // one-turn policy must still never be written to AppConfig.
    let _ = run(
        &data,
        &["chat", "--reasoning-effort", "max", "what happened?"],
    );
    assert_eq!(before, fs::read(config_path(&data)).unwrap());
}
