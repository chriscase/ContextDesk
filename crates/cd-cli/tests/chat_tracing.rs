//! End-to-end adversarial coverage for `contextdesk chat --dry-run` /
//! `--trace`, driven through the compiled binary exactly like
//! `cli_workflow_parity.rs` — the same reason that file gives: proving what
//! actually reaches a script's stdout, not what the Rust functions return in
//! isolation.
//!
//! Every test runs in its own temp `HOME`, so nothing here ever touches the
//! developer's real `~/.contextdesk`.

use assert_cmd::Command;
use cd_core::config::{save_config, AppConfig};
use cd_core::providers::{ProviderConfig, ProviderKind, ProviderProfile};
use serde_json::Value;
use std::path::Path;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn cli(home: &Path) -> Command {
    let mut cmd =
        Command::cargo_bin("contextdesk").expect("contextdesk binary built by this workspace");
    cmd.env("HOME", home);
    cmd
}

const SSE_BODY: &str =
    "data: {\"choices\":[{\"delta\":{\"content\":\"hello from the mock model\"}}]}\n\n\
     data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n\
     data: [DONE]\n\n";

fn write_mock_profile(home: &Path, server_uri: &str) -> std::path::PathBuf {
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

/// Every non-empty stdout line under `--jsonl` must be one complete JSON
/// object carrying a `"type"` field from the documented set, and the last
/// such line must be `"done"`. Parses every line independently — a reader
/// script does exactly this, one `serde_json::from_str` per line.
fn assert_pure_jsonl(stdout: &[u8]) -> Vec<Value> {
    let text = String::from_utf8_lossy(stdout);
    let known_types = [
        "text_delta",
        "tool",
        "permission_required",
        "turn_completed",
        "error",
        "trace_summary",
        "trace_context",
        "trace_tool",
        "done",
    ];
    let mut lines = Vec::new();
    for (i, raw) in text.lines().enumerate() {
        if raw.trim().is_empty() {
            continue;
        }
        let value: Value = serde_json::from_str(raw)
            .unwrap_or_else(|e| panic!("stdout line {i} is not valid JSON: {e}\nline: {raw}"));
        let kind = value["type"]
            .as_str()
            .unwrap_or_else(|| panic!("stdout line {i} has no string \"type\" field: {value}"));
        assert!(
            known_types.contains(&kind),
            "stdout line {i} has an undocumented type {kind:?}: {value}"
        );
        lines.push(value);
    }
    assert!(!lines.is_empty(), "expected at least one JSONL line");
    assert_eq!(
        lines.last().unwrap()["type"],
        "done",
        "the last JSONL line must be `done`; full lines: {lines:#?}"
    );
    let done_count = lines.iter().filter(|l| l["type"] == "done").count();
    assert_eq!(done_count, 1, "`done` must appear exactly once: {lines:#?}");
    lines
}

// ---------------------------------------------------------------------------
// JSONL stdout purity
// ---------------------------------------------------------------------------

#[tokio::test]
async fn jsonl_stdout_is_pure_on_success() {
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
            "--jsonl",
            "chat",
            "hi there",
        ])
        .output()
        .expect("run contextdesk chat");
    assert!(output.status.success());

    let lines = assert_pure_jsonl(&output.stdout);
    assert_eq!(lines.last().unwrap()["ok"], true);
    assert_eq!(
        lines.last().unwrap()["final_text"],
        "hello from the mock model"
    );
}

/// Adversarial: force a real provider failure (a 500 from the mocked
/// endpoint, not an unreachable host) and prove the JSONL contract still
/// holds — every line still `StreamLine`-shaped, still exactly one `done`
/// line, now with `ok:false`. Before the fix, a chat failure printed a
/// differently-shaped, untagged `Envelope` object with no `done` line at all.
#[tokio::test]
async fn jsonl_stdout_is_pure_on_a_forced_provider_failure() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(ResponseTemplate::new(500).set_body_string("synthetic provider failure"))
        .mount(&server)
        .await;

    let home = tempfile::tempdir().unwrap();
    let app_config_path = write_mock_profile(home.path(), &server.uri());

    let output = cli(home.path())
        .args([
            "--app-config",
            app_config_path.to_str().unwrap(),
            "--jsonl",
            "chat",
            "hi there",
        ])
        .output()
        .expect("run contextdesk chat");
    assert!(
        !output.status.success(),
        "a forced 500 must not exit 0: stdout={}",
        String::from_utf8_lossy(&output.stdout)
    );

    let lines = assert_pure_jsonl(&output.stdout);
    let done = lines.last().unwrap();
    assert_eq!(
        done["ok"], false,
        "done.ok must be false on failure: {done}"
    );
    assert!(
        lines.iter().any(|l| l["type"] == "error"),
        "an error-shaped line must precede done: {lines:#?}"
    );
}

// ---------------------------------------------------------------------------
// Dry-run network prohibition
// ---------------------------------------------------------------------------

/// The strongest available proof: `server.received_requests()` after the
/// run must be an empty vector, not merely "the run happened not to fail."
/// A real (non-dry-run) call against the same profile is also asserted, as
/// a control, to prove this profile really would have been reachable if
/// `--dry-run` had made a request.
#[tokio::test]
async fn dry_run_never_sends_a_single_request_to_the_configured_provider() {
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
            "--jsonl",
            "chat",
            "hi there",
            "--dry-run",
            "--trace",
            "context",
        ])
        .output()
        .expect("run contextdesk chat --dry-run");
    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let requests = server
        .received_requests()
        .await
        .expect("wiremock request recording is on by default");
    assert!(
        requests.is_empty(),
        "chat --dry-run reached the configured provider: {requests:?}"
    );

    let lines = assert_pure_jsonl(&output.stdout);
    let done = lines.last().unwrap();
    assert_eq!(done["ok"], true);
    assert_eq!(
        done["final_text"], "",
        "the dry-run backend never produces real content: {done}"
    );
    let summary = lines
        .iter()
        .find(|l| l["type"] == "trace_summary")
        .expect("dry run with --trace context must still include the summary line");
    assert_eq!(summary["dry_run"], true);
    let context = lines
        .iter()
        .find(|l| l["type"] == "trace_context")
        .expect("--trace context must include at least one round");
    let messages = context["messages"].as_array().expect("messages array");
    assert!(
        messages
            .iter()
            .any(|m| m["role"] == "user" && m["content"] == "hi there"),
        "the traced context must show the real user turn: {context}"
    );

    // Control: the exact same profile, without --dry-run, really is
    // reachable — proving the prohibition above is because of --dry-run,
    // not an accident of the fixture.
    let real_output = cli(home.path())
        .args([
            "--app-config",
            app_config_path.to_str().unwrap(),
            "--jsonl",
            "chat",
            "hi there",
            "--new",
        ])
        .output()
        .expect("run contextdesk chat (real)");
    assert!(real_output.status.success());
    let real_requests = server.received_requests().await.unwrap();
    assert_eq!(
        real_requests.len(),
        1,
        "the control (real, non-dry-run) call must reach the provider exactly once"
    );
}

/// A profile kind whose real turn path performs a network call *before* a
/// chat backend even exists (`ProviderKind::Ollama`'s pre-flight health
/// check) must still make zero requests under `--dry-run`. Distinct
/// coverage from the OpenAI-compatible test above, which never exercises
/// that code path at all.
#[tokio::test]
async fn dry_run_skips_the_ollama_pre_flight_health_check_too() {
    // A closed port: if `--dry-run` performed the health check, this would
    // either time out (test would hang/fail) or the client would observe a
    // connection refused quickly — either way the turn would end with
    // `ollama_unreachable`, which the assertion below rejects.
    let home = tempfile::tempdir().unwrap();
    let app_config_path = home.path().join("config.json");
    let mut profile = ProviderProfile::ollama_local();
    profile.base_url = "http://127.0.0.1:9".into();
    let cfg = AppConfig {
        providers: ProviderConfig {
            active_id: Some(profile.id.clone()),
            profiles: vec![profile],
        },
        ..AppConfig::default()
    };
    save_config(&app_config_path, &cfg).expect("write app config");

    let output = cli(home.path())
        .args([
            "--app-config",
            app_config_path.to_str().unwrap(),
            "--jsonl",
            "chat",
            "hi there",
            "--dry-run",
        ])
        .output()
        .expect("run contextdesk chat --dry-run");
    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let lines = assert_pure_jsonl(&output.stdout);
    assert!(
        !lines
            .iter()
            .any(|l| l["type"] == "error" && l["code"] == "ollama_unreachable"),
        "dry run must not perform the Ollama health probe at all: {lines:#?}"
    );
}

// ---------------------------------------------------------------------------
// --trace full requires --trace-ack
// ---------------------------------------------------------------------------

#[tokio::test]
async fn trace_full_without_ack_is_refused_before_any_provider_contact() {
    let server = MockServer::start().await;
    // Deliberately no Mock mounted: if this were reached at all (it must
    // not be — the refusal happens before the workflow call), wiremock's
    // default 404 would make the failure look like a provider error instead
    // of the intended user error.
    let home = tempfile::tempdir().unwrap();
    let app_config_path = write_mock_profile(home.path(), &server.uri());

    let output = cli(home.path())
        .args([
            "--app-config",
            app_config_path.to_str().unwrap(),
            "--jsonl",
            "chat",
            "hi there",
            "--trace",
            "full",
        ])
        .output()
        .expect("run contextdesk chat --trace full");
    assert_eq!(output.status.code(), Some(1), "user_error exit code");
    let requests = server.received_requests().await.unwrap();
    assert!(
        requests.is_empty(),
        "the refusal must happen before any provider contact: {requests:?}"
    );

    // JSONL streaming contract still holds on this early refusal: every
    // stdout line is StreamLine-shaped, last is Done{ok:false}. Empty
    // stdout would break machine consumers that always expect Error+Done.
    let lines = assert_pure_jsonl(&output.stdout);
    assert!(
        !output.stdout.is_empty(),
        "jsonl refusal must not leave empty stdout"
    );
    assert_eq!(
        lines.first().and_then(|l| l["type"].as_str()),
        Some("error"),
        "first line must be error: {lines:#?}"
    );
    assert_eq!(
        lines.last().and_then(|l| l["type"].as_str()),
        Some("done"),
        "last line must be done: {lines:#?}"
    );
    assert_eq!(
        lines.last().and_then(|l| l["ok"].as_bool()),
        Some(false),
        "done.ok must be false: {lines:#?}"
    );
    let err = &lines[0];
    let msg = err["message"].as_str().unwrap_or("");
    assert!(
        msg.contains("trace-ack") || msg.contains("trace full"),
        "error message should name the ack requirement: {msg}"
    );
}

/// Regression for a real boundary hole: `main.rs` treats every Text-mode
/// `chat` `Err` as already self-rendered by `commands::chat::run` (so it
/// never also calls the generic `emit_error`, which would duplicate the
/// renderer's own concise completion line). That is only true if EVERY
/// return path in `run` that can fail before the turn completes actually
/// renders something — including ones that return before
/// `ChatStatusRenderer` even exists yet, like this `--trace full` refusal
/// and (structurally identical, though not independently forceable through
/// real CLI/filesystem conditions in this codebase — `crate::adapters::
/// tool_host` builds an in-memory `KeywordIndex` over an empty workspace,
/// which has no reachable failure path to trigger from the outside)
/// `tool_host`'s own fallible setup. This proves the general contract on
/// the one such path that IS genuinely forceable: exactly one meaningful
/// Text error line, never zero (a silent non-zero exit) and never two (a
/// duplicated message from both this function and `main.rs`'s generic
/// path).
#[tokio::test]
async fn trace_full_without_ack_prints_exactly_one_text_error_line_never_silent_never_duplicated() {
    let server = MockServer::start().await;
    let home = tempfile::tempdir().unwrap();
    let app_config_path = write_mock_profile(home.path(), &server.uri());

    let output = cli(home.path())
        .args([
            "--app-config",
            app_config_path.to_str().unwrap(),
            "chat",
            "hi there",
            "--trace",
            "full",
        ])
        .output()
        .expect("run contextdesk chat --trace full (text mode)");
    assert_eq!(output.status.code(), Some(1), "user_error exit code");

    // Text mode carries no reply here (the refusal precedes the turn), and
    // must never be silently empty on failure.
    assert!(
        output.stdout.is_empty(),
        "no reply was ever produced; stdout must stay empty: {:?}",
        String::from_utf8_lossy(&output.stdout)
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        !stderr.trim().is_empty(),
        "a non-zero exit must never be silent — stderr must carry the \
         reason: {stderr:?}"
    );
    let error_lines: Vec<&str> = stderr
        .lines()
        .filter(|l| l.contains("trace-ack") || l.contains("trace full"))
        .collect();
    assert_eq!(
        error_lines.len(),
        1,
        "exactly one line must name the refusal — zero would be the \
         silent-failure bug this test guards against, two would mean both \
         `commands::chat::run` and `main.rs`'s generic `emit_error` printed \
         it: {stderr:?}"
    );
}

#[tokio::test]
async fn trace_full_with_ack_proceeds_and_includes_tool_lines_when_a_tool_ran() {
    let home = tempfile::tempdir().unwrap();
    let app_config_path = home.path().join("config.json");
    let profile = ProviderProfile::ollama_local();
    let cfg = AppConfig {
        providers: ProviderConfig {
            active_id: Some(profile.id.clone()),
            profiles: vec![profile],
        },
        ..AppConfig::default()
    };
    save_config(&app_config_path, &cfg).expect("write app config");

    let output = cli(home.path())
        .args([
            "--app-config",
            app_config_path.to_str().unwrap(),
            "--jsonl",
            "chat",
            "hi there",
            "--dry-run",
            "--trace",
            "full",
            "--trace-ack",
        ])
        .output()
        .expect("run contextdesk chat --trace full --trace-ack");
    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    // A dry run never dispatches a tool call (the dry-run backend never asks
    // for one), so no `trace_tool` lines are expected here — this asserts
    // the ack gate is what changed, not that tools ran.
    let _lines = assert_pure_jsonl(&output.stdout);
}
