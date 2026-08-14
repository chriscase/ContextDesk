//! Gateway wire conformance lab — Phase 11: CLI/desktop-host parity.
//!
//! Every other phase in this lab drives `cd_core`/`cd_workflow` directly
//! against a hermetic `cd_test_gateway::MockGateway`. This file proves the
//! SAME reusable mock-gateway framework — not a parallel wiremock-based
//! substitute — reaches those exact code paths through the compiled
//! `contextdesk` binary's structured (`--json`/`--jsonl`) output, so a
//! defect that would only show up at the process boundary (argument
//! wiring, credential plumbing, output serialization) cannot hide behind
//! green core-layer tests alone.
//!
//! Desktop-host parity is proven differently, in
//! `crates/cd-workflow/tests/architecture_tauri_delegates_to_shared_provider_logic.rs`:
//! `desktop/src-tauri` is a nested Cargo workspace this crate cannot call
//! into directly (see that file's own doc comment), so parity there is
//! established architecturally — pinning that the Tauri commands for
//! discovery (`probe_ai_gateway_cmd`) and qualification
//! (`start_capability_qualification`) call `cd_core::ai_probe::probe_ai_gateway`
//! and `cd_core::capability_qualification::run_qualification` directly, the
//! same functions this lab exercises hermetically, rather than carrying a
//! parallel implementation. `cd-cli`'s own `models verify` (see
//! `crates/cd-cli/src/commands/models.rs`) calls the identical
//! `cd_workflow::capability_qualification::LiveQualificationTransport` +
//! `cd_core::capability_qualification::run_qualification` pair, so CLI and
//! desktop qualification genuinely share one implementation, not two that
//! merely look alike.

use cd_core::config::{save_config, AppConfig};
use cd_core::providers::{ProviderCapabilities, ProviderConfig, ProviderKind, ProviderProfile};
use cd_test_gateway::{Body, MockGateway, Response, Step};
use serde_json::{json, Value};
use std::path::Path;

fn cli(data_dir: &Path) -> assert_cmd::Command {
    let mut cmd = assert_cmd::Command::cargo_bin("contextdesk")
        .expect("contextdesk binary built by this workspace");
    cmd.args(["--data-dir", data_dir.to_str().unwrap()]);
    cmd
}

/// Runs a fully-configured CLI command via `spawn_blocking`. `Command::output`
/// blocks the calling OS thread until the child exits; calling it directly
/// from an `async fn` on the default single-threaded test runtime would
/// starve every other task on that runtime — including `MockGateway`'s own
/// accept-loop task, which is `tokio::spawn`-ed onto that same runtime (by
/// design, so its scripted delays stay compatible with paused-clock tests —
/// see gateway_wire_latency_cancellation.rs's comment on the same hazard
/// from the opposite direction). Without this, the child process's
/// connection attempts to the mock would never be accepted at all.
async fn run_blocking(mut cmd: assert_cmd::Command) -> std::process::Output {
    tokio::task::spawn_blocking(move || cmd.output().expect("cli run"))
        .await
        .expect("spawn_blocking join")
}

fn ollama_profile(base_url: &str) -> ProviderProfile {
    let mut profile = ProviderProfile::ollama_local();
    profile.id = "cli-parity-ollama".into();
    profile.base_url = base_url.into();
    profile
}

fn openai_profile_with_ref(base_url: &str, api_key_ref: Option<String>) -> ProviderProfile {
    ProviderProfile {
        id: "cli-parity-openai".into(),
        label: "cli parity openai-compatible".into(),
        kind: ProviderKind::OpenAiCompatible,
        base_url: base_url.into(),
        api_key_ref,
        chat_model: "matrix-model".into(),
        embedding_model: None,
        embedding_base_url: None,
        capabilities: ProviderCapabilities::chat_remote(),
        local_only: false,
        deadline_preference: Default::default(),
    }
}

fn write_config(data_dir: &Path, profile: ProviderProfile) {
    let cfg = AppConfig {
        providers: ProviderConfig {
            active_id: Some(profile.id.clone()),
            profiles: vec![profile],
        },
        ..AppConfig::default()
    };
    save_config(&data_dir.join("config.json"), &cfg).expect("write config");
}

/// Synthetic-only credential, matching the discipline in
/// `crates/cd-workflow/tests/gateway_wire_credentials.rs` — a mode-600 temp
/// file, never a real secret, never the OS keychain.
fn synthetic_protected_file(dir: &tempfile::TempDir, name: &str, secret: &str) -> String {
    let path = dir.path().join(name);
    std::fs::write(&path, secret).expect("write synthetic secret");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).expect("chmod 600");
    }
    cd_core::keychain_store::file_secret_ref(&path).expect("valid protected file reference")
}

// ---------------------------------------------------------------------------
// Discovery: the same MockGateway-scripted catalog gateway_wire_discovery.rs
// proves at the cd_core::discovery::probe_provider_catalog layer, now
// observed through `contextdesk models discover --json`.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn discover_via_mock_gateway_reaches_probe_provider_catalog_and_the_cli_reports_the_same_ids()
{
    // Identical fixture to gateway_wire_discovery.rs's
    // probe_provider_catalog_ollama_reachable_reports_model_ids: an Ollama
    // /api/tags-shaped catalog with a duplicate entry, proving dedup
    // survives through the CLI too.
    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::json_ok(&json!({
        "models": [{"name": "mistral"}, {"name": "mistral"}]
    })))])
    .await;
    let data_dir = tempfile::tempdir().unwrap();
    write_config(data_dir.path(), ollama_profile(gateway.base_url()));

    let mut cmd = cli(data_dir.path());
    cmd.args(["--json", "models", "discover"]);
    let output = run_blocking(cmd).await;
    assert!(
        output.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );

    let value: Value = serde_json::from_slice(&output.stdout).expect("stdout is one JSON envelope");
    assert_eq!(value["data"]["action"], "discover");
    assert_eq!(
        value["data"]["offline"], false,
        "a live discover must report offline=false"
    );
    let model_ids: Vec<&str> = value["data"]["models"]
        .as_array()
        .expect("models array")
        .iter()
        .map(|m| m["model_id"].as_str().expect("model_id"))
        .collect();
    assert_eq!(
        model_ids,
        vec!["mistral"],
        "the wire-scripted catalog's deduplicated id must reach CLI JSON output unchanged: {value}"
    );
    assert_eq!(gateway.request_count(), 1);
}

#[tokio::test]
async fn discover_via_mock_gateway_401_reaches_the_cli_as_a_clean_failure_not_a_crash() {
    // Same wire input as gateway_wire_discovery.rs's
    // probe_provider_catalog_openai_compatible_401_is_key_rejected (a bare
    // 401 on the catalog route), but exercised through the CLI's full
    // credential-reference resolution (ReferencedSecretStore, the same
    // production code path — see gateway_wire_credentials.rs), not a key
    // passed directly to the core function.
    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::status_only(401))]).await;
    let dir = tempfile::tempdir().unwrap();
    let api_key_ref =
        synthetic_protected_file(&dir, "cli-parity.secret", "sk-test-cli-parity-wrong");

    let data_dir = tempfile::tempdir().unwrap();
    write_config(
        data_dir.path(),
        openai_profile_with_ref(&format!("{}/v1", gateway.base_url()), Some(api_key_ref)),
    );

    let mut cmd = cli(data_dir.path());
    cmd.args(["--json", "models", "discover"]);
    let output = run_blocking(cmd).await;

    assert!(
        !output.status.success(),
        "a 401 catalog response must not be reported as a successful discovery"
    );
    // --json mode reports failures as a JSON envelope on stdout (ok:false,
    // error:{...}), not as plain text on stderr — confirmed empirically:
    // stdout={"schema_version":1,"ok":false,"command":"models","error":{...}}.
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stdout.contains("model catalog discovery failed"),
        "must fail with the documented discovery-failure message, not a panic or an unrelated \
         error: stdout={stdout} stderr={stderr}"
    );
    assert!(
        !stdout.contains("sk-test-cli-parity-wrong") && !stderr.contains("sk-test-cli-parity-wrong"),
        "the synthetic credential must never appear in error output: stdout={stdout} stderr={stderr}"
    );
}

// ---------------------------------------------------------------------------
// Timeout classification: a truly indefinite stall (Body::NeverEnds — the
// same fixture Phase 9's permanently_stalled_provider_* tests use), not a
// merely-slow wiremock delay, still classifies as a timeout through
// `contextdesk doctor`'s JSONL output.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn doctor_classifies_a_permanently_stalled_mock_gateway_response_as_a_timeout() {
    let gateway = MockGateway::start_ordered(vec![Step::respond(
        Response::new(200, Body::NeverEnds).with_header("content-type", "text/event-stream"),
    )])
    .await;
    let data_dir = tempfile::tempdir().unwrap();
    let mut profile = ollama_profile(gateway.base_url());
    profile.kind = ProviderKind::OpenAiCompatible;
    profile.local_only = true;
    profile.capabilities.embeddings = false;
    write_config(data_dir.path(), profile);

    let started = std::time::Instant::now();
    let mut cmd = cli(data_dir.path());
    cmd.args(["--jsonl", "doctor", "--timeout", "2"]);
    let output = run_blocking(cmd).await;
    let elapsed = started.elapsed();

    assert_eq!(output.status.code(), Some(8), "NotReady exit code");
    assert!(
        elapsed < std::time::Duration::from_secs(15),
        "a connection that never sends a byte of body must still be bounded by --timeout \
         (waited {elapsed:?})"
    );

    let lines: Vec<Value> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| serde_json::from_str(l).expect("every stdout line is JSON"))
        .collect();
    let native = lines
        .iter()
        .find(|l| l["type"] == "check" && l["id"] == "native_tool_calling")
        .expect("native_tool_calling check present");
    assert_eq!(native["status"], "fail");
    assert!(
        native["message"].as_str().unwrap().contains("timed out"),
        "message={native}"
    );
    let verdict = lines
        .iter()
        .find(|l| l["type"] == "verdict")
        .expect("verdict present");
    assert_eq!(verdict["ready"], false);
}
