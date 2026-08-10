//! `contextdesk gateway diagnose` — hermetic end-to-end CLI proof.
//!
//! Drives the compiled `contextdesk` binary against `cd_test_gateway`'s
//! hermetic mock gateway (the same reusable framework the rest of the
//! gateway-wire conformance lab uses — see `gateway_wire_cli_parity.rs`),
//! never a live provider. These tests do not require every synthetic case
//! to *pass* against the mock — a plain canned completion legitimately
//! fails most typed-property checks — they prove the command's own
//! plumbing: consent gating, request bounds, credential single-resolution,
//! the typed JSONL event order, guaranteed cleanup, deadline bounding, and
//! artifact privacy.

use cd_core::config::{save_config, AppConfig};
use cd_core::providers::{ProviderCapabilities, ProviderConfig, ProviderKind, ProviderProfile};
use cd_test_gateway::{MockGateway, Response, Step};
use serde_json::{json, Value};
use std::path::Path;

fn cli(data_dir: &Path) -> assert_cmd::Command {
    let mut cmd = assert_cmd::Command::cargo_bin("contextdesk")
        .expect("contextdesk binary built by this workspace");
    cmd.args(["--data-dir", data_dir.to_str().unwrap()]);
    cmd
}

/// See `gateway_wire_cli_parity.rs`'s identical helper for why this must go
/// through `spawn_blocking`: `Command::output` blocks the calling OS thread,
/// and the mock gateway's own accept loop is a task on this same runtime.
async fn run_blocking(mut cmd: assert_cmd::Command) -> std::process::Output {
    tokio::task::spawn_blocking(move || cmd.output().expect("cli run"))
        .await
        .expect("spawn_blocking join")
}

fn openai_profile_with_ref(base_url: &str, api_key_ref: Option<String>) -> ProviderProfile {
    ProviderProfile {
        id: "gwdx-openai".into(),
        label: "gateway diagnose openai-compatible".into(),
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

/// Synthetic-only credential, matching the discipline already established in
/// `gateway_wire_cli_parity.rs`/`gateway_wire_credentials.rs` — a mode-600
/// temp file, never a real secret, never the OS keychain.
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

fn openai_completion_body(content: &str) -> Value {
    json!({
        "id": "chatcmpl-gwdx",
        "model": "matrix-model",
        "choices": [{"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": content}}],
    })
}

/// Every request this mock sees gets the same plain, tool-free completion —
/// deliberately naive. This makes nearly every synthetic case fail its
/// typed-property check (a real, honestly-reported outcome), which is
/// exactly what lets these tests assert on the command's own mechanics
/// without depending on a hand-scripted response for every one of
/// qualification's internal probes, the tool loop, and the triage contract.
async fn permissive_gateway() -> MockGateway {
    MockGateway::start_routed(|_req| {
        Step::respond(Response::json_ok(&openai_completion_body(
            "a plain mock answer with no tool calls",
        )))
    })
    .await
}

fn parse_jsonl(stdout: &[u8]) -> Vec<Value> {
    String::from_utf8_lossy(stdout)
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| serde_json::from_str(l).unwrap_or_else(|e| panic!("line not JSON: {e}: {l}")))
        .collect()
}

// ---------------------------------------------------------------------------
// Consent gate: never a network call before explicit confirmation.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn refuses_without_yes_in_a_noninteractive_context_and_makes_no_request() {
    let gateway = permissive_gateway().await;
    let data_dir = tempfile::tempdir().unwrap();
    write_config(
        data_dir.path(),
        openai_profile_with_ref(gateway.base_url(), None),
    );

    let mut cmd = cli(data_dir.path());
    cmd.args(["--jsonl", "gateway", "diagnose"]);
    let output = run_blocking(cmd).await;

    assert!(
        !output.status.success(),
        "must refuse without --yes in a non-interactive process"
    );
    assert_eq!(
        gateway.request_count(),
        0,
        "no provider request may occur before consent is given"
    );
}

/// clap-level enforcement: `--raw` alone (without the explicit ack) must be
/// rejected before any command logic runs at all.
#[tokio::test]
async fn raw_without_explicit_ack_is_rejected_by_argument_parsing() {
    let data_dir = tempfile::tempdir().unwrap();
    write_config(
        data_dir.path(),
        openai_profile_with_ref("http://127.0.0.1:1", None),
    );
    let mut cmd = cli(data_dir.path());
    cmd.args(["gateway", "diagnose", "--yes", "--raw"]);
    let output = run_blocking(cmd).await;
    assert!(
        !output.status.success(),
        "--raw without --raw-i-understand must be a usage error"
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("raw-i-understand") || stderr.contains("raw_i_understand"),
        "stderr should name the missing required flag: {stderr}"
    );
}

// ---------------------------------------------------------------------------
// Progressive JSONL stream: plan first, one terminal line, no ANSI, bounded
// requests, credential never leaked.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn jsonl_stream_shows_the_plan_first_and_ends_in_exactly_one_terminal_line() {
    let gateway = permissive_gateway().await;
    let dir = tempfile::tempdir().unwrap();
    let api_key_ref = synthetic_protected_file(&dir, "gwdx.secret", "sk-gwdx-synthetic-only");
    let data_dir = tempfile::tempdir().unwrap();
    write_config(
        data_dir.path(),
        openai_profile_with_ref(&format!("{}/v1", gateway.base_url()), Some(api_key_ref)),
    );

    let mut cmd = cli(data_dir.path());
    cmd.args(["--jsonl", "gateway", "diagnose", "--yes", "--timeout", "30"]);
    let output = run_blocking(cmd).await;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();

    assert!(
        !stdout.contains('\u{1b}'),
        "structured JSONL output must never contain raw ANSI escape bytes: {stdout}"
    );
    assert!(
        !stdout.contains("sk-gwdx-synthetic-only"),
        "the synthetic credential must never reach stdout: {stdout}"
    );

    let lines = parse_jsonl(output.stdout.as_slice());
    assert!(
        !lines.is_empty(),
        "expected at least a plan and a terminal line"
    );
    assert_eq!(
        lines.first().unwrap()["type"],
        "plan",
        "plan line must come first: {lines:?}"
    );
    let plan = &lines[0];
    assert!(
        plan["max_requests"].as_u64().unwrap_or(0) > 0,
        "planned request bound must be stated: {plan}"
    );
    assert!(plan["deadline_secs"].as_u64().unwrap_or(0) > 0);

    let terminal_count = lines
        .iter()
        .filter(|l| l["type"] == "verdict" || l["type"] == "cancelled")
        .count();
    assert_eq!(
        terminal_count, 1,
        "exactly one terminal line must be emitted: {lines:?}"
    );
    assert!(
        lines.last().unwrap()["type"] != "case",
        "the terminal line must be last: {lines:?}"
    );
}

// ---------------------------------------------------------------------------
// Full run: cleanup always balances, artifact bundle is share-safe and
// checksummed, credential never leaks into the artifact either.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn full_run_cleans_up_and_writes_a_checksummed_share_safe_artifact() {
    let gateway = permissive_gateway().await;
    let dir = tempfile::tempdir().unwrap();
    let api_key_ref = synthetic_protected_file(&dir, "gwdx2.secret", "sk-gwdx-artifact-secret");
    let data_dir = tempfile::tempdir().unwrap();
    write_config(
        data_dir.path(),
        openai_profile_with_ref(&format!("{}/v1", gateway.base_url()), Some(api_key_ref)),
    );

    let mut cmd = cli(data_dir.path());
    cmd.args(["--json", "gateway", "diagnose", "--yes", "--timeout", "30"]);
    let output = run_blocking(cmd).await;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    assert!(
        !stdout.contains("sk-gwdx-artifact-secret"),
        "credential must never reach --json stdout: {stdout}"
    );

    let value: Value = serde_json::from_str(&stdout).expect("stdout is one JSON envelope");
    let data = &value["data"];
    let cleanup = &data["cleanup"];
    assert_eq!(
        cleanup["corpora_created"], cleanup["corpora_removed"],
        "every disposable corpus this run created must be removed: {cleanup}"
    );
    assert_eq!(
        cleanup["sessions_created"], cleanup["sessions_removed"],
        "every disposable session this run created must be removed: {cleanup}"
    );
    assert!(
        cleanup["failures"].as_array().unwrap().is_empty(),
        "cleanup must report no failures on a normal run: {cleanup}"
    );

    let artifact_dir = data["artifact_dir"]
        .as_str()
        .expect("artifact_dir must be reported");
    let report_path = Path::new(artifact_dir).join("report.json");
    let manifest_path = Path::new(artifact_dir).join("manifest.json");
    assert!(
        report_path.exists(),
        "report.json must exist at {artifact_dir}"
    );
    assert!(
        manifest_path.exists(),
        "manifest.json must exist at {artifact_dir}"
    );

    let report_bytes = std::fs::read(&report_path).expect("read report.json");
    let report_text = String::from_utf8_lossy(&report_bytes);
    assert!(
        !report_text.contains("sk-gwdx-artifact-secret"),
        "credential must never reach the artifact bundle"
    );
    assert!(
        !report_text.contains(gateway.base_url()),
        "the raw endpoint URL must never reach the share-safe artifact bundle"
    );
    assert!(
        !report_text.contains("matrix-model"),
        "the exact private model id must be pseudonymized in the share-safe artifact bundle"
    );

    let manifest: Value =
        serde_json::from_slice(&std::fs::read(&manifest_path).unwrap()).expect("manifest json");
    let expected_sha = {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(&report_bytes);
        hasher
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    };
    let manifest_sha = manifest["files"][0]["sha256"].as_str().unwrap();
    assert_eq!(
        manifest_sha, expected_sha,
        "manifest checksum must match the actual report.json bytes"
    );

    assert!(
        !Path::new(artifact_dir).join("private").exists(),
        "no private capture directory may exist without --raw"
    );
}

// ---------------------------------------------------------------------------
// Explicit --raw --raw-i-understand: owner-only, local-only, separate file.
// ---------------------------------------------------------------------------

#[cfg(unix)]
#[tokio::test]
async fn raw_capture_is_owner_only_and_separate_from_the_share_safe_bundle() {
    use std::os::unix::fs::PermissionsExt;

    let gateway = permissive_gateway().await;
    let data_dir = tempfile::tempdir().unwrap();
    write_config(
        data_dir.path(),
        openai_profile_with_ref(&format!("{}/v1", gateway.base_url()), None),
    );

    let mut cmd = cli(data_dir.path());
    cmd.args([
        "--json",
        "gateway",
        "diagnose",
        "--yes",
        "--raw",
        "--raw-i-understand",
        "--timeout",
        "30",
    ]);
    let output = run_blocking(cmd).await;
    let value: Value = serde_json::from_slice(&output.stdout).expect("stdout is one JSON envelope");
    assert_eq!(value["data"]["private_capture_written"], true);

    let artifact_dir = value["data"]["artifact_dir"].as_str().unwrap();
    let private_path = Path::new(artifact_dir).join("private").join("capture.json");
    assert!(private_path.exists(), "private capture file must exist");
    let perms = std::fs::metadata(&private_path).unwrap().permissions();
    assert_eq!(
        perms.mode() & 0o777,
        0o600,
        "private capture file must be owner-only (0600)"
    );
    let dir_perms = std::fs::metadata(Path::new(artifact_dir).join("private"))
        .unwrap()
        .permissions();
    assert_eq!(
        dir_perms.mode() & 0o777,
        0o700,
        "private capture directory must be owner-only (0700)"
    );

    // Never silently included in the share-safe report: the private file's
    // path/content is not referenced from report.json.
    let report_text = std::fs::read_to_string(Path::new(artifact_dir).join("report.json")).unwrap();
    assert!(
        !report_text.contains("private/capture.json"),
        "share-safe report must not reference the private capture file"
    );
}

// ---------------------------------------------------------------------------
// Deadline bounding: a permanently stalled gateway must not hang the whole
// operation past the stated `--timeout`.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_permanently_stalled_gateway_is_still_bounded_by_the_overall_deadline() {
    let gateway = MockGateway::start_routed(|_req| Step::Stall).await;
    let data_dir = tempfile::tempdir().unwrap();
    write_config(
        data_dir.path(),
        openai_profile_with_ref(&format!("{}/v1", gateway.base_url()), None),
    );

    let started = std::time::Instant::now();
    let mut cmd = cli(data_dir.path());
    cmd.args(["--json", "gateway", "diagnose", "--yes", "--timeout", "3"]);
    let output = run_blocking(cmd).await;
    let elapsed = started.elapsed();

    assert!(
        elapsed < std::time::Duration::from_secs(20),
        "a permanently stalled gateway must not hang the whole operation \
         past the stated deadline (waited {elapsed:?})"
    );
    let value: Value = serde_json::from_slice(&output.stdout).expect("stdout is one JSON envelope");
    // Whatever the exact case outcomes, cleanup must still have run and
    // balanced, and the report must still be a complete, valid document.
    let cleanup = &value["data"]["cleanup"];
    assert_eq!(cleanup["corpora_created"], cleanup["corpora_removed"]);
    assert_eq!(cleanup["sessions_created"], cleanup["sessions_removed"]);
}

// ---------------------------------------------------------------------------
// No user-state mutation: an unrelated pre-existing corpus/session survives
// a gateway diagnose run untouched.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_preexisting_user_corpus_is_never_touched_by_the_diagnostic_run() {
    let gateway = permissive_gateway().await;
    let data_dir = tempfile::tempdir().unwrap();
    write_config(
        data_dir.path(),
        openai_profile_with_ref(&format!("{}/v1", gateway.base_url()), None),
    );

    // Create a real user corpus first, exactly the way `contextdesk import`
    // would leave one behind.
    let cache_root = data_dir.path().join("cache");
    std::fs::create_dir_all(&cache_root).unwrap();
    let user_corpus =
        cd_core::log_analysis::LogCorpus::create(&cache_root, "real-user-corpus").unwrap();
    let user_corpus_id = user_corpus.id().to_string();
    drop(user_corpus);

    let mut cmd = cli(data_dir.path());
    cmd.args(["--json", "gateway", "diagnose", "--yes", "--timeout", "30"]);
    let _ = run_blocking(cmd).await;

    // The pre-existing corpus must still be loadable after the run.
    let reloaded = cd_core::log_analysis::LogCorpus::open(&cache_root, &user_corpus_id);
    assert!(
        reloaded.is_ok(),
        "gateway diagnose must never remove or corrupt a corpus it did not create itself"
    );
}

// ---------------------------------------------------------------------------
// Regression: every request (direct qualification lane AND product-path
// turns) must hit the exact --profile/--model selection, never the shared
// AppConfig's active/default profile. Two distinct mock gateways stand in
// for "the active/default profile's endpoint" and "the exact selected
// profile's endpoint" — if a single byte of traffic reaches the decoy, a
// case silently used the wrong provider/model and the differential result
// is invalid.
// ---------------------------------------------------------------------------

fn two_profile_config(
    active_base_url: &str,
    active_model: &str,
    selected_id: &str,
    selected_base_url: &str,
    selected_default_model: &str,
) -> AppConfig {
    let active = ProviderProfile {
        id: "active-decoy".into(),
        label: "active decoy profile".into(),
        kind: ProviderKind::OpenAiCompatible,
        base_url: active_base_url.into(),
        api_key_ref: None,
        chat_model: active_model.into(),
        embedding_model: None,
        embedding_base_url: None,
        capabilities: ProviderCapabilities::chat_remote(),
        local_only: false,
        deadline_preference: Default::default(),
    };
    let selected = ProviderProfile {
        id: selected_id.into(),
        label: "selected exact profile".into(),
        kind: ProviderKind::OpenAiCompatible,
        base_url: selected_base_url.into(),
        api_key_ref: None,
        chat_model: selected_default_model.into(),
        embedding_model: None,
        embedding_base_url: None,
        capabilities: ProviderCapabilities::chat_remote(),
        local_only: false,
        deadline_preference: Default::default(),
    };
    AppConfig {
        providers: ProviderConfig {
            // The active/default profile is deliberately NOT the one
            // selected via --profile/--model below.
            active_id: Some(active.id.clone()),
            profiles: vec![active, selected],
        },
        ..AppConfig::default()
    }
}

#[tokio::test]
async fn direct_and_product_lanes_use_the_exact_selected_profile_and_model_not_the_active_default()
{
    let decoy_gateway = MockGateway::start_routed(|_req| {
        Step::respond(Response::json_ok(&openai_completion_body(
            "decoy gateway must never be called",
        )))
    })
    .await;
    let selected_gateway = permissive_gateway().await;

    let data_dir = tempfile::tempdir().unwrap();
    let cfg = two_profile_config(
        &format!("{}/v1", decoy_gateway.base_url()),
        "decoy-model",
        "selected-real",
        &format!("{}/v1", selected_gateway.base_url()),
        "selected-profile-default-model",
    );
    save_config(&data_dir.path().join("config.json"), &cfg).expect("write config");

    let mut cmd = cli(data_dir.path());
    cmd.args([
        "--json",
        "--profile",
        "selected-real",
        "--model",
        "selected-exact-model",
        "gateway",
        "diagnose",
        "--yes",
        "--timeout",
        "30",
    ]);
    let output = run_blocking(cmd).await;
    let stdout = String::from_utf8_lossy(&output.stdout);

    assert_eq!(
        decoy_gateway.request_count(),
        0,
        "not one request may reach the active/default profile's endpoint when \
         --profile/--model explicitly selected a different one: stdout={stdout}"
    );
    assert!(
        selected_gateway.request_count() > 0,
        "the exact selected profile's endpoint must receive this run's requests: stdout={stdout}"
    );

    // Every request that carries a "model" field in its JSON body — both the
    // direct qualification lane and every product-lane chat-workflow call —
    // must name the exact --model override, never the selected profile's own
    // configured default model and never the decoy's model.
    let mut model_carrying_requests = 0usize;
    for request in selected_gateway.requests() {
        let Ok(body) = serde_json::from_slice::<Value>(&request.body) else {
            continue;
        };
        let Some(model) = body.get("model").and_then(Value::as_str) else {
            continue;
        };
        model_carrying_requests += 1;
        assert_eq!(
            model, "selected-exact-model",
            "request carried the wrong model id (path={}): body={body}",
            request.path
        );
    }
    assert!(
        model_carrying_requests > 0,
        "expected at least one request (qualification or product-path) to carry a model field"
    );
}
