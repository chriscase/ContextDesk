//! End-to-end coverage for the interactive-terminal status renderer
//! (`crate::render`) driven through the compiled binary, exactly like
//! `chat_tracing.rs` — the same reason that file gives: proving what
//! actually reaches stdout/stderr, not what the Rust functions return in
//! isolation.
//!
//! Every test here spawns the real binary with piped (non-tty) stdio —
//! `assert_cmd`/`std::process::Command` never attach a controlling
//! terminal — so this file proves the **redirected-output** degrade path:
//! bounded, one-line-per-transition, ANSI-free by default. The genuinely
//! interactive (real pty, in-place redraw) path is covered separately in
//! `pty_interactive_chat.rs`, since it is unobservable here.

use assert_cmd::Command;
use cd_core::config::{save_config, AppConfig};
use cd_core::providers::{ProviderConfig, ProviderKind, ProviderProfile};
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

/// No stray control sequence of any kind anywhere in the given bytes: not
/// an ANSI escape, not a bare carriage return (the redraw mechanism), not a
/// dangling partial sequence. The redirected/no-color contract is "bounded,
/// plain lines" — this is the one assertion every test in this file reuses.
fn assert_no_ansi_or_cr(bytes: &[u8], label: &str) {
    let text = String::from_utf8_lossy(bytes);
    assert!(
        !text.contains('\u{1b}'),
        "{label} must contain no ANSI escape bytes when redirected/color=auto: {text:?}"
    );
    assert!(
        !text.contains('\r'),
        "{label} must contain no bare carriage return when redirected: {text:?}"
    );
}

#[tokio::test]
async fn redirected_text_mode_status_is_bounded_and_ansi_free() {
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
            "chat",
            "hi there",
        ])
        .output()
        .expect("run contextdesk chat");
    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    // stdout: the reply text only — never the renderer's own content, and
    // never touched by any of this change.
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains("hello from the mock model"),
        "stdout must still carry the reply: {stdout:?}"
    );
    assert_no_ansi_or_cr(&output.stdout, "stdout");

    // stderr: the bounded status render. Redirected stderr means one line
    // per phase transition, never a redraw — and, because there is no
    // controlling terminal here, no ANSI even though color defaults to
    // `auto` (auto requires `interactive`, which redirected output never
    // is).
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("Connecting to provider"),
        "the very first line must announce the phase that has no event of \
         its own: {stderr:?}"
    );
    assert!(
        stderr.contains("done"),
        "the concise completion line must be present: {stderr:?}"
    );
    assert!(
        stderr.contains("session "),
        "the completion line must name the session: {stderr:?}"
    );
    assert_no_ansi_or_cr(&output.stderr, "stderr");

    // Bounded: a handful of short lines, never one line per token.
    let stderr_lines: Vec<&str> = stderr.lines().filter(|l| !l.trim().is_empty()).collect();
    assert!(
        stderr_lines.len() <= 6,
        "redirected status output must stay bounded, not one line per \
         internal event: {stderr_lines:#?}"
    );
}

#[tokio::test]
async fn color_always_forces_ansi_even_when_redirected() {
    // `--color always` is a deliberate override (mirrors `grep
    // --color=always`, `ls --color=always`) — it must win even though
    // nothing here is attached to a real terminal, and even though
    // `NO_COLOR` is also set to prove the explicit flag beats the ambient
    // env convention.
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
        .env("NO_COLOR", "1")
        .args([
            "--app-config",
            app_config_path.to_str().unwrap(),
            "--color",
            "always",
            "chat",
            "hi there",
        ])
        .output()
        .expect("run contextdesk chat --color always");
    assert!(output.status.success());

    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains('\u{1b}'),
        "--color always must emit ANSI even when redirected and NO_COLOR \
         is set: {stderr:?}"
    );
    // Redraw and color are independent: redirected output still never gets
    // an in-place redraw (`\r`), only appended, colored lines.
    assert!(
        !stderr.contains('\r'),
        "redirected output must never redraw in place regardless of \
         color: {stderr:?}"
    );
}

#[tokio::test]
async fn color_never_suppresses_ansi_even_if_something_later_forced_it_on() {
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
            "--color",
            "never",
            "chat",
            "hi there",
        ])
        .output()
        .expect("run contextdesk chat --color never");
    assert!(output.status.success());
    assert_no_ansi_or_cr(&output.stderr, "stderr under --color never");
}

#[tokio::test]
async fn term_dumb_env_never_panics_and_stays_bounded() {
    // TERM=dumb combined with a real controlling terminal is covered by
    // render::tests (unit level, no process needed) and by the pty test.
    // This proves the real binary tolerates the env var end-to-end without
    // panicking or hanging, over the redirected path this crate's other
    // tests already exercise without it.
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
        .env("TERM", "dumb")
        .args([
            "--app-config",
            app_config_path.to_str().unwrap(),
            "chat",
            "hi there",
        ])
        .output()
        .expect("run contextdesk chat under TERM=dumb");
    assert!(output.status.success());
    assert_no_ansi_or_cr(&output.stderr, "stderr under TERM=dumb");
}

/// Adversarial: prove the new Text-mode failure line is not a second,
/// independently-derived rendering of the error — it is the exact same
/// `CliError.message` `--jsonl`'s already-audited `error` line prints
/// (`docs/CLI.md`'s trace/error contract already establishes that message
/// never carries a credential or header). If it ever diverged, that would
/// itself be evidence of a new, unaudited derivation — a new leak surface
/// this change must never introduce.
#[tokio::test]
async fn failed_turn_text_summary_matches_the_jsonl_error_message_byte_for_byte() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(
            ResponseTemplate::new(500).set_body_string("synthetic provider failure marker XYZ123"),
        )
        .mount(&server)
        .await;

    let home = tempfile::tempdir().unwrap();
    let app_config_path = write_mock_profile(home.path(), &server.uri());

    let jsonl_output = cli(home.path())
        .args([
            "--app-config",
            app_config_path.to_str().unwrap(),
            "--jsonl",
            "chat",
            "hi there",
        ])
        .output()
        .expect("run contextdesk chat --jsonl (forced failure)");
    assert!(!jsonl_output.status.success());
    let jsonl_stdout = String::from_utf8_lossy(&jsonl_output.stdout);
    let error_line = jsonl_stdout
        .lines()
        .map(|l| serde_json::from_str::<serde_json::Value>(l).expect("valid json line"))
        .find(|v| v["type"] == "error")
        .expect("an error line must precede done");
    let jsonl_message = error_line["message"]
        .as_str()
        .expect("error.message is a string")
        .to_string();

    let text_output = cli(home.path())
        .args([
            "--app-config",
            app_config_path.to_str().unwrap(),
            "chat",
            "hi there",
            "--new",
        ])
        .output()
        .expect("run contextdesk chat (forced failure, text mode)");
    assert!(!text_output.status.success());
    let stderr = String::from_utf8_lossy(&text_output.stderr);
    assert!(
        stderr.contains(&jsonl_message),
        "the concise Text-mode failure line must carry the exact same, \
         already-audited message the --jsonl contract prints, not a new \
         derivation: stderr={stderr:?} jsonl_message={jsonl_message:?}"
    );
    assert!(
        stderr.contains("failed"),
        "failure must render as `failed`, not `done`: {stderr:?}"
    );
    // Coarse redaction sentinels: neither test provider ever legitimately
    // has reason to mention these in an ordinary error path.
    for sentinel in ["Authorization", "Bearer ", "api_key", "sk-"] {
        assert!(
            !stderr.contains(sentinel),
            "failure line must never contain a credential-shaped \
             substring {sentinel:?}: {stderr:?}"
        );
    }
    assert_no_ansi_or_cr(&text_output.stderr, "stderr on a redirected failure");
}
