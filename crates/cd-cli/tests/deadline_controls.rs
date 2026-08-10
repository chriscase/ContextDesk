//! Hermetic deadline-control coverage: config deadline show/auto/set and
//! chat `--deadline` override semantics (no live provider calls).

use assert_cmd::Command;
use std::fs;
use std::path::{Path, PathBuf};

fn cli(data: &Path) -> Command {
    let mut cmd = Command::cargo_bin("contextdesk").expect("contextdesk binary");
    cmd.args(["--data-dir", data.to_str().unwrap()]);
    cmd.env("HOME", data); // keep accidental HOME writes isolated on Unix
    cmd
}

fn isolated_home() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().expect("tempdir");
    let data = dir.path().join("data");
    fs::create_dir_all(&data).unwrap();
    (dir, data)
}

fn run_in(data: &Path, args: &[&str]) -> std::process::Output {
    cli(data).args(args).output().expect("spawn contextdesk")
}

fn app_config_path(data: &Path) -> PathBuf {
    data.join("config.json")
}

fn write_minimal_app_config(data: &Path) {
    // Default AppConfig shape; only router deadline fields matter here.
    let cfg = serde_json::json!({
        "providers": {
            "active_id": null,
            "profiles": []
        },
        "router": {
            "max_sources": 3,
            "max_tool_rounds": 12,
            "max_results_per_source": 8,
            "deadline_ms": 180000,
            "deadline_is_explicit": false,
            "order": ["memory", "files", "mcp", "sql", "wiki"]
        }
    });
    fs::write(
        app_config_path(data),
        serde_json::to_vec_pretty(&cfg).unwrap(),
    )
    .unwrap();
}

#[test]
fn config_deadline_show_human_and_json() {
    let (_tmp, data) = isolated_home();
    write_minimal_app_config(&data);

    let out = run_in(&data, &["config", "deadline", "show"]);
    assert!(
        out.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&out.stderr)
    );
    let text = String::from_utf8_lossy(&out.stdout);
    assert!(text.contains("auto") || text.contains("adaptive"), "{text}");
    assert!(text.contains("3m") || text.contains("180000"), "{text}");

    let out = run_in(&data, &["--format", "json", "config", "deadline", "show"]);
    assert!(out.status.success());
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).expect("json");
    // Envelope wraps the payload; dig for schema.
    let blob = out.stdout.clone();
    let s = String::from_utf8_lossy(&blob);
    assert!(s.contains("contextdesk.deadline.v1"), "{s}");
    assert!(s.contains("\"deadline_ms\""), "{s}");
    assert!(!s.to_lowercase().contains("sk-"), "{s}");
    assert!(!s.contains("http://"), "{s}");
    let _ = v;
}

#[test]
fn config_deadline_set_only_touches_deadline_fields() {
    let (_tmp, data) = isolated_home();
    write_minimal_app_config(&data);
    // Seed extra fields that must survive.
    let mut cfg: serde_json::Value =
        serde_json::from_slice(&fs::read(app_config_path(&data)).unwrap()).unwrap();
    cfg["router"]["max_sources"] = serde_json::json!(7);
    cfg["router"]["max_tool_rounds"] = serde_json::json!(9);
    cfg["default_timezone"] = serde_json::json!("America/Chicago");
    fs::write(
        app_config_path(&data),
        serde_json::to_vec_pretty(&cfg).unwrap(),
    )
    .unwrap();

    let out = run_in(&data, &["config", "deadline", "set", "90s"]);
    assert!(
        out.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&out.stderr)
    );
    let saved: serde_json::Value =
        serde_json::from_slice(&fs::read(app_config_path(&data)).unwrap()).unwrap();
    assert_eq!(saved["router"]["deadline_ms"], 90_000);
    assert_eq!(saved["router"]["deadline_is_explicit"], true);
    assert_eq!(saved["router"]["max_sources"], 7);
    assert_eq!(saved["router"]["max_tool_rounds"], 9);
    assert_eq!(saved["default_timezone"], "America/Chicago");
}

#[test]
fn config_deadline_auto_preserves_numeric_value() {
    let (_tmp, data) = isolated_home();
    write_minimal_app_config(&data);
    let out = run_in(&data, &["config", "deadline", "set", "5m"]);
    assert!(out.status.success());
    let out = run_in(&data, &["config", "deadline", "auto"]);
    assert!(out.status.success());
    let saved: serde_json::Value =
        serde_json::from_slice(&fs::read(app_config_path(&data)).unwrap()).unwrap();
    assert_eq!(saved["router"]["deadline_ms"], 300_000);
    assert_eq!(saved["router"]["deadline_is_explicit"], false);
}

#[test]
fn config_deadline_set_rejects_out_of_range_without_clamping() {
    let (_tmp, data) = isolated_home();
    write_minimal_app_config(&data);
    let before = fs::read(app_config_path(&data)).unwrap();
    let out = run_in(&data, &["config", "deadline", "set", "11m"]);
    assert!(!out.status.success());
    let err = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stderr),
        String::from_utf8_lossy(&out.stdout)
    );
    assert!(
        err.contains("600000") || err.contains("10m") || err.contains("outside"),
        "{err}"
    );
    let after = fs::read(app_config_path(&data)).unwrap();
    assert_eq!(before, after, "invalid set must not rewrite config");
}

#[test]
fn chat_invalid_deadline_fails_before_provider_or_config_mutation() {
    let (_tmp, data) = isolated_home();
    write_minimal_app_config(&data);
    let before = fs::read(app_config_path(&data)).unwrap();
    let out = run_in(&data, &["chat", "--deadline", "nope", "what happened?"]);
    assert!(!out.status.success());
    let err = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stderr),
        String::from_utf8_lossy(&out.stdout)
    );
    assert!(
        err.to_lowercase().contains("deadline") || err.to_lowercase().contains("duration"),
        "{err}"
    );
    let after = fs::read(app_config_path(&data)).unwrap();
    assert_eq!(before, after, "invalid override must not persist");
}

#[test]
fn chat_deadline_override_never_persists_on_dry_run() {
    let (_tmp, data) = isolated_home();
    write_minimal_app_config(&data);
    let before = fs::read(app_config_path(&data)).unwrap();
    // Dry-run may fail later for missing provider/corpus; the override must
    // still be accepted early and must never write AppConfig.
    let out = run_in(
        &data,
        &["chat", "--dry-run", "--deadline", "10m", "what happened?"],
    );
    let combined = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    // Either dry-run succeeds far enough to mention the override, or it fails
    // for missing provider — either way config must be unchanged.
    if combined.contains("one-turn override") {
        assert!(combined.contains("10m") || combined.contains("600000"));
    }
    let after = fs::read(app_config_path(&data)).unwrap();
    assert_eq!(before, after, "override must never write AppConfig");
    let saved: serde_json::Value = serde_json::from_slice(&after).unwrap();
    assert_eq!(saved["router"]["deadline_is_explicit"], false);
    assert_eq!(saved["router"]["deadline_ms"], 180_000);
}

#[test]
fn direct_question_normalization_accepts_deadline() {
    // Process-level: global --deadline + free-text question rewrites to chat
    // and parses without "unexpected argument".
    let (_tmp, data) = isolated_home();
    write_minimal_app_config(&data);
    let out = run_in(&data, &["--deadline", "90s", "what happened?"]);
    let err = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stderr),
        String::from_utf8_lossy(&out.stdout)
    );
    assert!(
        !err.contains("unexpected argument") && !err.contains("unrecognized"),
        "normalization must accept --deadline: {err}"
    );
    // Invalid deadline fails closed with a duration error (proves the flag
    // reached the chat path), without mutating config.
    let before = fs::read(app_config_path(&data)).unwrap();
    let bad = run_in(&data, &["--deadline", "11m", "what happened?"]);
    assert!(!bad.status.success());
    let bad_err = format!(
        "{}{}",
        String::from_utf8_lossy(&bad.stderr),
        String::from_utf8_lossy(&bad.stdout)
    );
    assert!(
        bad_err.to_lowercase().contains("deadline")
            || bad_err.to_lowercase().contains("outside")
            || bad_err.contains("600000"),
        "{bad_err}"
    );
    assert_eq!(before, fs::read(app_config_path(&data)).unwrap());
}
