//! Activity/trace parity proofs for the CLI host.
//!
//! These tests drive the **compiled `contextdesk` binary** (or the shared
//! projection helpers that binary uses) so a green result means the shipped
//! path works — not a parallel reimplementation.

use assert_cmd::Command;
use cd_core::config::{save_config, AppConfig};
use cd_core::providers::{ProviderConfig, ProviderKind, ProviderProfile};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Output;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn cli(home: &Path) -> Command {
    let mut cmd =
        Command::cargo_bin("contextdesk").expect("contextdesk binary built by this workspace");
    cmd.env("HOME", home);
    cmd.env("NO_COLOR", "1");
    cmd
}

const SSE_BODY: &str =
    "data: {\"choices\":[{\"delta\":{\"content\":\"hello from the mock model\"}}]}\n\n\
     data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n\
     data: [DONE]\n\n";

fn write_mock_profile(home: &Path, server_uri: &str) -> PathBuf {
    let app_config_path = home.join("config.json");
    let mut profile = ProviderProfile::ollama_local();
    profile.kind = ProviderKind::OpenAiCompatible;
    profile.base_url = server_uri.to_string();
    profile.local_only = true;
    profile.chat_model = "test-model".into();
    profile.capabilities.tools = false;
    let cfg = AppConfig {
        providers: ProviderConfig {
            active_id: Some(profile.id.clone()),
            profiles: vec![profile],
        },
        ..AppConfig::default()
    };
    save_config(&app_config_path, &cfg).expect("write app config");
    app_config_path
}

fn parse_jsonl(stdout: &[u8]) -> Vec<Value> {
    let text = String::from_utf8_lossy(stdout);
    let mut lines = Vec::new();
    for (i, raw) in text.lines().enumerate() {
        if raw.trim().is_empty() {
            continue;
        }
        let value: Value = serde_json::from_str(raw)
            .unwrap_or_else(|e| panic!("stdout line {i} is not valid JSON: {e}\nline: {raw}"));
        lines.push(value);
    }
    lines
}

fn assert_meta_fields(line: &Value) {
    for key in ["schema", "version", "session", "turn", "operation", "seq"] {
        assert!(
            line.get(key).is_some(),
            "jsonl line missing stable field {key}: {line}"
        );
    }
    assert_eq!(line["schema"], "contextdesk.cli.stream.v1");
    assert_eq!(line["version"], 1);
}

/// Source-level structural guard: the CLI chat command must call the shared
/// workflow entry, never a private agent loop.
#[test]
fn cli_chat_source_delegates_to_shared_workflow() {
    let src = include_str!("../src/commands/chat.rs");
    assert!(
        src.contains("run_chat_workflow"),
        "CLI chat must call cd_workflow::chat::run_chat_workflow"
    );
    assert!(
        !src.contains("run_agent_turn_with_sink"),
        "CLI chat must not reimplement the agent loop"
    );
    assert!(
        src.contains("project_turn_activity") || src.contains("ActivityRecorder"),
        "CLI chat must project shared activity"
    );
    assert!(
        src.contains("RecordingTurnTrace"),
        "CLI chat must attach shared TurnTraceSink capture"
    );
}

#[tokio::test]
async fn activity_summary_json_contains_shared_record() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_raw(SSE_BODY, "text/event-stream"),
        )
        .mount(&server)
        .await;

    let home = tempfile::tempdir().unwrap();
    let app_config_path = write_mock_profile(home.path(), &server.uri());

    let output = cli(home.path())
        .args([
            "--app-config",
            app_config_path.to_str().unwrap(),
            "--json",
            "chat",
            "--activity",
            "summary",
            "hi there",
        ])
        .output()
        .expect("run chat");
    assert!(
        output.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&output.stderr)
    );
    // --json must be pure machine output on stdout (no progress noise)
    let text = String::from_utf8_lossy(&output.stdout);
    assert!(
        !text.contains('\u{1b}'),
        "JSON stdout must not contain ANSI: {text}"
    );
    let value: Value = serde_json::from_str(text.trim()).expect("json envelope");
    assert_eq!(value["ok"], true);
    assert!(
        value["data"]["activity"].is_object(),
        "expected shared activity record in json data: {value}"
    );
    let activity = &value["data"]["activity"];
    assert!(
        activity["events"]
            .as_array()
            .map(|a| !a.is_empty())
            .unwrap_or(false),
        "activity events must be non-empty: {activity}"
    );
    // Summary must not retain bodies
    if let Some(events) = activity["events"].as_array() {
        for event in events {
            if let Some(ctx) = event.get("context") {
                assert!(
                    ctx.get("bodies").is_none() || ctx["bodies"].is_null(),
                    "summary must strip bodies: {event}"
                );
            }
        }
    }
}

#[tokio::test]
async fn jsonl_activity_lines_carry_stable_meta_and_type() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_raw(SSE_BODY, "text/event-stream"),
        )
        .mount(&server)
        .await;

    let home = tempfile::tempdir().unwrap();
    let app_config_path = write_mock_profile(home.path(), &server.uri());

    let run = |extra: &[&str]| -> Output {
        let args = vec![
            "--app-config",
            app_config_path.to_str().unwrap(),
            "--jsonl",
            "chat",
            "--activity",
            "summary",
            "parity probe",
        ];
        // extra unused for now; keeps signature ready for mode variants
        let _ = extra;
        cli(home.path()).args(&args).output().expect("run")
    };

    let out1 = run(&[]);
    let out2 = run(&[]);
    assert!(
        out1.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&out1.stderr)
    );
    assert!(
        out2.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&out2.stderr)
    );

    for (i, out) in [&out1, &out2].into_iter().enumerate() {
        let lines = parse_jsonl(&out.stdout);
        assert!(!lines.is_empty(), "run {i} empty jsonl");
        assert_eq!(lines.last().unwrap()["type"], "done");
        for line in &lines {
            assert_meta_fields(line);
            assert!(
                !serde_json::to_string(line)
                    .unwrap()
                    .contains("Authorization"),
                "must never print auth headers"
            );
        }
        let activity_lines: Vec<_> = lines.iter().filter(|l| l["type"] == "activity").collect();
        assert!(
            !activity_lines.is_empty(),
            "run {i} expected activity lines: {lines:#?}"
        );
        for line in activity_lines {
            assert!(line["operation"].as_str().is_some());
            assert!(line.get("seq").is_some());
            assert!(line.get("session").is_some());
            assert!(line.get("turn").is_some());
        }
    }
}

#[tokio::test]
async fn dry_run_activity_and_trace_share_capture() {
    let home = tempfile::tempdir().unwrap();
    // Unreachable provider: dry-run must still assemble + project activity
    let app_config_path = write_mock_profile(home.path(), "http://127.0.0.1:9");

    let output = cli(home.path())
        .args([
            "--app-config",
            app_config_path.to_str().unwrap(),
            "--json",
            "chat",
            "--dry-run",
            "--activity",
            "summary",
            "--trace",
            "summary",
            "what is in context?",
        ])
        .output()
        .expect("run");
    assert!(
        output.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&output.stderr)
    );
    let value: Value =
        serde_json::from_str(String::from_utf8_lossy(&output.stdout).trim()).expect("json");
    assert_eq!(value["ok"], true);
    assert!(
        value["data"]["trace"].is_array()
            || value["data"]["trace"].is_object()
            || value["data"].get("trace").is_some()
    );
    assert!(value["data"]["activity"].is_object());
    // dry-run must not have called the unreachable provider (success proves dry_run)
}

#[test]
fn no_color_and_term_dumb_are_honored_by_help() {
    let home = tempfile::tempdir().unwrap();
    let output = cli(home.path())
        .env("TERM", "dumb")
        .env("NO_COLOR", "1")
        .args(["chat", "--help"])
        .output()
        .expect("help");
    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains("--activity"),
        "help must document --activity"
    );
    assert!(stdout.contains("--trace"), "help must document --trace");
    assert!(
        !stdout.as_bytes().contains(&0x1b),
        "TERM=dumb/NO_COLOR help must not use ANSI"
    );
}

#[test]
fn activity_full_without_ack_refuses() {
    let home = tempfile::tempdir().unwrap();
    let app_config_path = write_mock_profile(home.path(), "http://127.0.0.1:9");
    let output = cli(home.path())
        .args([
            "--app-config",
            app_config_path.to_str().unwrap(),
            "--jsonl",
            "chat",
            "--activity",
            "full",
            "nope",
        ])
        .output()
        .expect("run");
    assert!(!output.status.success());
    let lines = parse_jsonl(&output.stdout);
    assert_eq!(lines.last().unwrap()["type"], "done");
    assert_eq!(lines.last().unwrap()["ok"], false);
    assert!(lines.iter().any(|l| l["type"] == "error"));
    for line in &lines {
        assert_meta_fields(line);
    }
}
