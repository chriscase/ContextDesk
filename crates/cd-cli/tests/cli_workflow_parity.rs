//! End-to-end tests against the compiled `contextdesk` binary, proving the
//! CLI adapter stays thin: chat reaches the exact same
//! `cd_workflow::chat::run_chat_workflow` path (against a mocked HTTP
//! provider, mirroring `cd-workflow`'s own unit test) rather than a
//! CLI-local reimplementation, and import/corpus/explore state written by
//! one invocation is visible, unmodified, to the next — the same
//! `cd_core::log_analysis` corpus cache every host reads.
//!
//! Every test passes its own temporary directory through `--data-dir`, so
//! isolation is explicit and cross-platform. In particular, Windows resolves
//! the shared profile via `FOLDERID_Profile` and intentionally ignores the
//! Unix-specific `HOME` environment variable.

use assert_cmd::Command;
use cd_core::config::{save_config, AppConfig};
use cd_core::providers::{ProviderConfig, ProviderKind, ProviderProfile};
use serde_json::Value;
use std::path::Path;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn cli(data_dir: &Path) -> Command {
    let mut cmd =
        Command::cargo_bin("contextdesk").expect("contextdesk binary built by this workspace");
    cmd.arg("--data-dir").arg(data_dir);
    cmd
}

fn parse_envelope(bytes: &[u8]) -> Value {
    serde_json::from_slice(bytes).expect("stdout is one JSON envelope")
}

const SSE_BODY: &str =
    "data: {\"choices\":[{\"delta\":{\"content\":\"hello from the mock model\"}}]}\n\n\
     data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n\
     data: [DONE]\n\n";

/// The chat command must drive a real HTTP round trip through
/// `cd_workflow::chat::run_chat_workflow` — not a CLI-local reimplementation
/// of provider selection or the agent turn. This mirrors
/// `cd_workflow::chat::tests::run_chat_workflow_completes_an_ordinary_turn_against_a_mock_provider`
/// exactly, but drives it through the compiled `contextdesk` binary instead
/// of calling the Rust function directly — proving the binary's `chat`
/// command is the thin adapter its doc comment claims to be.
#[tokio::test]
async fn chat_command_reaches_the_shared_chat_workflow_against_a_mock_provider() {
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
    let app_config_path = home.path().join("config.json");

    let mut profile = ProviderProfile::ollama_local();
    profile.kind = ProviderKind::OpenAiCompatible;
    profile.base_url = server.uri();
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

    let output = cli(home.path())
        .args([
            "--app-config",
            app_config_path.to_str().unwrap(),
            "--json",
            "chat",
            "hi there",
        ])
        .output()
        .expect("run contextdesk chat");
    assert!(
        output.status.success(),
        "status: {:?}\nstdout: {}\nstderr: {}",
        output.status.code(),
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );

    let envelope = parse_envelope(&output.stdout);
    assert_eq!(envelope["ok"], true);
    assert_eq!(envelope["data"]["final_text"], "hello from the mock model");
    let session_id = envelope["data"]["session_id"]
        .as_str()
        .expect("session_id is a string")
        .to_string();

    // The transcript this turn wrote is durable and visible from a second
    // invocation — the CLI persists through the SAME `SessionStore` the
    // desktop app uses, not a private in-process cache.
    let show = cli(home.path())
        .args([
            "--app-config",
            app_config_path.to_str().unwrap(),
            "--json",
            "session",
            "show",
            &session_id,
        ])
        .output()
        .expect("run contextdesk session show");
    assert!(show.status.success());
    let show_envelope = parse_envelope(&show.stdout);
    let messages = show_envelope["data"]["messages"]
        .as_array()
        .expect("messages array");
    assert!(
        messages
            .iter()
            .any(|m| m["role"] == "assistant" && m["content"] == "hello from the mock model"),
        "persisted session must contain the assistant reply exactly as the mock returned it: {show_envelope}"
    );
}

/// `import` must select via `cd_core::log_analysis::import_preview` (no
/// per-file prompt) and the resulting corpus must be immediately visible to
/// `corpus list` and searchable via `explore` — the same corpus cache
/// backing every host, not a CLI-private store.
#[test]
fn import_creates_a_corpus_immediately_visible_to_corpus_and_explore_commands() {
    let home = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    std::fs::write(
        source.path().join("app.log"),
        "2024-01-01T00:00:00Z INFO service started\n2024-01-01T00:00:01Z ERROR checkout failed\n",
    )
    .unwrap();

    let import_out = cli(home.path())
        .args(["--json", "import", source.path().to_str().unwrap()])
        .output()
        .expect("run contextdesk import");
    assert!(
        import_out.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&import_out.stderr)
    );
    let import_envelope = parse_envelope(&import_out.stdout);
    assert_eq!(import_envelope["ok"], true);
    assert_eq!(import_envelope["data"]["events_imported"], 2);
    let corpus_id = import_envelope["data"]["corpus_id"]
        .as_str()
        .expect("corpus_id is a string")
        .to_string();

    let list_out = cli(home.path())
        .args(["--json", "corpus", "list"])
        .output()
        .expect("run contextdesk corpus list");
    assert!(list_out.status.success());
    let list_envelope = parse_envelope(&list_out.stdout);
    let corpora = list_envelope["data"]["corpora"]
        .as_array()
        .expect("corpora array");
    assert!(
        corpora.iter().any(|c| c["id"] == corpus_id),
        "the imported corpus must appear in a fresh `corpus list` invocation: {list_envelope}"
    );

    // No `--corpus` passed: `explore` must fall back to the CLI's "current
    // corpus" pointer that `import` just set, not require an explicit id
    // for the happy path.
    let explore_out = cli(home.path())
        .args(["--json", "explore", "checkout"])
        .output()
        .expect("run contextdesk explore");
    assert!(
        explore_out.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&explore_out.stderr)
    );
    let explore_envelope = parse_envelope(&explore_out.stdout);
    assert_eq!(explore_envelope["data"]["corpus_id"], corpus_id);
    let hits = explore_envelope["data"]["hits"]
        .as_array()
        .expect("hits array");
    assert!(
        !hits.is_empty(),
        "search for a word actually in the log must find it: {explore_envelope}"
    );
}

/// A command whose grammar is accepted but whose behavior is intentionally
/// not implemented must fail with the documented `not_implemented` exit
/// code and JSON `error.kind` — never exit 0 as if it had done something.
#[test]
fn import_embed_flag_fails_honestly_instead_of_silently_ignoring_the_flag() {
    let home = tempfile::tempdir().unwrap();
    let source = tempfile::tempdir().unwrap();
    std::fs::write(
        source.path().join("app.log"),
        "2024-01-01T00:00:00Z INFO hi\n",
    )
    .unwrap();

    let output = cli(home.path())
        .args([
            "--json",
            "import",
            source.path().to_str().unwrap(),
            "--embed",
        ])
        .output()
        .expect("run contextdesk import --embed");
    assert_eq!(output.status.code(), Some(7), "not_implemented exit code");
    let envelope = parse_envelope(&output.stdout);
    assert_eq!(envelope["ok"], false);
    assert_eq!(envelope["error"]["kind"], "not_implemented");
}

/// `corpus show` on an id that does not exist must fail with the
/// documented `not_found` category, not `internal` or a silent empty
/// success.
#[test]
fn corpus_show_on_an_unknown_id_is_not_found_not_internal() {
    let home = tempfile::tempdir().unwrap();
    let output = cli(home.path())
        .args(["--json", "corpus", "show", "does-not-exist"])
        .output()
        .expect("run contextdesk corpus show");
    assert_eq!(output.status.code(), Some(3), "not_found exit code");
    let envelope = parse_envelope(&output.stdout);
    assert_eq!(envelope["error"]["kind"], "not_found");
}
