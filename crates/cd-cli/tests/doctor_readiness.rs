//! Adversarial proof for `contextdesk doctor` — the readiness/preflight
//! command. Every scenario runs the compiled `contextdesk` binary end to
//! end, most against a local `wiremock::MockServer` scripted to exercise
//! one specific production failure mode (unreachable, incompatible model,
//! no tool call, timeout, malformed response, ungrounded answer), plus one
//! full happy-path proof and the process-level guarantees (unwritable
//! state, an interrupted run, JSONL purity).
//!
//! Two things worth knowing about scope, both discovered empirically while
//! writing these tests, not assumed up front:
//! - `provider_connectivity` is deliberately NOT a prerequisite for the
//!   live-turn checks (see `commands::doctor`'s own doc comment on why:
//!   `cd_core::ai_probe::probe_ai_gateway` treats any loopback base URL as
//!   "the well-known local Ollama," so a loopback mock server — exactly
//!   what these tests use — always reports that check `fail`, regardless
//!   of what the mock actually returns). These tests exercise the
//!   LIVE-TURN checks directly and never assert a specific
//!   `provider_connectivity` outcome against a mock.
//! - No test in this file uses a real API key — every profile here is
//!   `local_only` with no `api_key_ref`, matching the mock's own lack of
//!   auth.

use assert_cmd::Command;
use cd_core::config::{save_config, AppConfig};
use cd_core::providers::{ProviderConfig, ProviderKind, ProviderProfile};
use serde_json::{json, Value};
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, Request, Respond, ResponseTemplate};

fn cli(data_dir: &Path) -> Command {
    let mut command =
        Command::cargo_bin("contextdesk").expect("contextdesk binary built by this workspace");
    command.args(["--data-dir", data_dir.to_str().unwrap()]);
    command
}

fn write_profile(data_dir: &Path, base_url: &str, chat_model: &str) {
    let mut profile = ProviderProfile::ollama_local();
    profile.kind = ProviderKind::OpenAiCompatible;
    profile.base_url = base_url.to_string();
    profile.local_only = true;
    profile.chat_model = chat_model.to_string();
    profile.capabilities.embeddings = false;
    let config = AppConfig {
        providers: ProviderConfig {
            active_id: Some(profile.id.clone()),
            profiles: vec![profile],
        },
        ..AppConfig::default()
    };
    save_config(&data_dir.join("config.json"), &config).expect("write synthetic profile");
}

fn jsonl(stdout: &[u8]) -> Vec<Value> {
    String::from_utf8_lossy(stdout)
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).expect("every stdout line is JSON"))
        .collect()
}

fn check(lines: &[Value], id: &str) -> Option<Value> {
    lines
        .iter()
        .find(|line| line["type"] == "check" && line["id"] == id)
        .cloned()
}

fn verdict(lines: &[Value]) -> Value {
    lines
        .iter()
        .find(|line| line["type"] == "verdict")
        .cloned()
        .expect("a verdict line must always be present")
}

/// Corpora doctor's own synthetic-check step leaves under `cache_root` —
/// used to prove cleanup ran even when the run itself failed or was
/// interrupted.
fn synthetic_corpora_left_behind(data_dir: &Path) -> usize {
    let dir = data_dir.join("cache").join("log_corpora");
    if !dir.exists() {
        return 0;
    }
    std::fs::read_dir(dir).unwrap().count()
}

/// Session files doctor's own synthetic-check step leaves under
/// `<data-dir>/sessions` — used to prove session cleanup ran even when the
/// run was interrupted after a session had already been durably saved.
fn synthetic_sessions_left_behind(data_dir: &Path) -> usize {
    let dir = data_dir.join("sessions");
    if !dir.exists() {
        return 0;
    }
    std::fs::read_dir(dir)
        .unwrap()
        .filter_map(Result::ok)
        .filter(|e| e.path().is_file())
        .count()
}

/// Block until the child's stdout has produced `n` complete lines, returning
/// them, or panic after `deadline`. Every interrupt test needs to send
/// SIGINT only once the process is demonstrably past argument parsing,
/// runtime start-up, and the two fast local checks (`config`,
/// `writable_state`) that always print one line each, in that order,
/// before anything else — `provider_connectivity` now runs last (see
/// `commands::doctor`'s own doc comment on why), well after the live-turn
/// exercise these interrupt tests target. A fixed `sleep(...)` before
/// signalling was tried first and was flaky in isolation (though reliable
/// as part of the full suite): a lone `cargo test` invocation pays the
/// *first* spawn's cold-start cost (dynamic linking, page faults for a
/// freshly-built binary) that a shared test-binary process usually doesn't
/// pay again after its first spawn, so a fixed millisecond budget that was
/// safe in one context silently wasn't in the other. Synchronizing on
/// actual observed output removes that entire source of variance instead of
/// padding the guess.
fn wait_for_n_lines(
    stdout: std::process::ChildStdout,
    n: usize,
) -> (Vec<String>, std::sync::mpsc::Receiver<String>) {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        use std::io::BufRead;
        let reader = std::io::BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(line) => {
                    if tx.send(line).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    let mut lines = Vec::with_capacity(n);
    while lines.len() < n {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        match rx.recv_timeout(remaining) {
            Ok(line) => lines.push(line),
            Err(_) => panic!(
                "expected {n} stdout lines from the doctor process within 10s, only saw {}: {lines:?}",
                lines.len()
            ),
        }
    }
    // Return the receiver as a drain guard. Dropping it here makes the
    // reader thread stop at the child's next line and close the pipe; the
    // child can then panic on stdout with EPIPE before it processes SIGINT.
    // Keeping the receiver alive until `wait_with_output` completes leaves
    // the reader thread draining the pipe for the lifetime of the child.
    (lines, rx)
}

// ---------------------------------------------------------------------
// 1. Unavailable provider
// ---------------------------------------------------------------------

#[test]
fn unavailable_provider_fails_connectivity_and_the_overall_verdict() {
    let data_dir = tempfile::tempdir().unwrap();
    // Port 1 is never a real listener on any test host.
    write_profile(data_dir.path(), "http://127.0.0.1:1/v1", "test-model");

    let output = cli(data_dir.path())
        .args(["--jsonl", "doctor", "--timeout", "3"])
        .output()
        .expect("doctor run");
    assert_eq!(output.status.code(), Some(8), "NotReady exit code");

    let lines = jsonl(&output.stdout);
    let connectivity = check(&lines, "provider_connectivity").expect("connectivity check present");
    assert_eq!(connectivity["status"], "fail");
    let v = verdict(&lines);
    assert_eq!(v["ready"], false);
    assert!(v["checks_failed"].as_u64().unwrap() >= 1);
}

// ---------------------------------------------------------------------
// 2. Incompatible model
// ---------------------------------------------------------------------

#[tokio::test]
async fn incompatible_model_surfaces_as_a_clean_failure_not_a_crash() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(ResponseTemplate::new(400).set_body_json(json!({
            "error": {
                "message": "The model 'test-model' does not exist",
                "type": "invalid_request_error"
            }
        })))
        .mount(&server)
        .await;

    let data_dir = tempfile::tempdir().unwrap();
    write_profile(data_dir.path(), &server.uri(), "test-model");

    let output = cli(data_dir.path())
        .args(["--jsonl", "doctor", "--timeout", "10"])
        .output()
        .expect("doctor run");
    assert_eq!(output.status.code(), Some(8));

    let lines = jsonl(&output.stdout);
    let native = check(&lines, "native_tool_calling").expect("native_tool_calling present");
    assert_eq!(native["status"], "fail");
    assert!(
        !native["message"].as_str().unwrap().is_empty(),
        "an actionable message must be present, not an empty string"
    );
    let grounding = check(&lines, "grounding").expect("grounding present");
    assert_eq!(grounding["status"], "fail");
    assert_eq!(verdict(&lines)["ready"], false);
    assert_eq!(
        synthetic_corpora_left_behind(data_dir.path()),
        0,
        "the synthetic corpus must still be cleaned up after a failed turn"
    );
}

// ---------------------------------------------------------------------
// 3. Native-tools rejection (provider completes without calling any tool)
// ---------------------------------------------------------------------

#[tokio::test]
async fn native_tools_rejection_is_reported_distinctly_from_a_hard_error() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "choices": [{
                "finish_reason": "stop",
                "message": {
                    "role": "assistant",
                    "content": "I don't have access to any logs, so I can't answer that."
                }
            }]
        })))
        .mount(&server)
        .await;

    let data_dir = tempfile::tempdir().unwrap();
    write_profile(data_dir.path(), &server.uri(), "test-model");

    let output = cli(data_dir.path())
        .args(["--jsonl", "doctor", "--timeout", "10"])
        .output()
        .expect("doctor run");
    assert_eq!(output.status.code(), Some(8));

    let lines = jsonl(&output.stdout);
    let native = check(&lines, "native_tool_calling").expect("native_tool_calling present");
    assert_eq!(
        native["status"], "fail",
        "a provider that never calls the offered tool must fail this check: {native}"
    );
    // Distinguishing property from the "unavailable provider" and
    // "incompatible model" scenarios: the request itself succeeded (HTTP
    // 200), so this is a behavioral rejection, not a transport failure —
    // still reported through the same check, but proven here by actually
    // driving a well-formed 200 response with no tool_calls.
    assert_eq!(verdict(&lines)["ready"], false);
}

// ---------------------------------------------------------------------
// 4. Timeout
// ---------------------------------------------------------------------

#[tokio::test]
async fn a_slow_provider_is_bounded_by_timeout_not_hung_forever() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_delay(Duration::from_secs(20))
                .set_body_json(json!({
                    "choices": [{"finish_reason": "stop", "message": {"role": "assistant", "content": "late"}}]
                })),
        )
        .mount(&server)
        .await;

    let data_dir = tempfile::tempdir().unwrap();
    write_profile(data_dir.path(), &server.uri(), "test-model");

    let started = std::time::Instant::now();
    let output = cli(data_dir.path())
        .args(["--jsonl", "doctor", "--timeout", "2"])
        .output()
        .expect("doctor run");
    let elapsed = started.elapsed();

    assert_eq!(output.status.code(), Some(8));
    assert!(
        elapsed < Duration::from_secs(15),
        "two independently bounded doctor probes must not wait for either full 20s provider delay when --timeout is 2s (waited {elapsed:?})"
    );

    let lines = jsonl(&output.stdout);
    let native = check(&lines, "native_tool_calling").expect("native_tool_calling present");
    assert_eq!(native["status"], "fail");
    assert!(
        native["message"].as_str().unwrap().contains("timed out"),
        "message={native}"
    );
    assert_eq!(
        synthetic_corpora_left_behind(data_dir.path()),
        0,
        "a timed-out turn must still clean up the synthetic corpus"
    );
}

// ---------------------------------------------------------------------
// 5. Malformed response
// ---------------------------------------------------------------------

#[tokio::test]
async fn a_malformed_response_body_fails_cleanly_without_a_panic() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "application/json")
                .set_body_raw("not valid json at all {{{", "application/json"),
        )
        .mount(&server)
        .await;

    let data_dir = tempfile::tempdir().unwrap();
    write_profile(data_dir.path(), &server.uri(), "test-model");

    let output = cli(data_dir.path())
        .args(["--jsonl", "doctor", "--timeout", "10"])
        .output()
        .expect("doctor run");

    // The whole point: this must never crash the process. A clean, typed
    // failure (exit 8, not a SIGABRT/backtrace) is the proof.
    assert_eq!(
        output.status.code(),
        Some(8),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let lines = jsonl(&output.stdout);
    let native = check(&lines, "native_tool_calling").expect("native_tool_calling present");
    assert_eq!(native["status"], "fail");
    assert_eq!(verdict(&lines)["ready"], false);
}

// ---------------------------------------------------------------------
// 6. Ungrounded answer
// ---------------------------------------------------------------------

#[derive(Clone)]
struct UngroundedProvider {
    call: Arc<AtomicUsize>,
}

impl Respond for UngroundedProvider {
    fn respond(&self, _request: &Request) -> ResponseTemplate {
        let body = match self.call.fetch_add(1, Ordering::SeqCst) {
            // Round 1: call the tool, but search for something that does
            // not exist in the synthetic corpus, so nothing is retrieved.
            0 => json!({
                "choices": [{
                    "finish_reason": "tool_calls",
                    "message": {
                        "role": "assistant",
                        "content": null,
                        "tool_calls": [{
                            "type": "function",
                            "function": {
                                "name": "search_logs",
                                "arguments": {
                                    "query": "NO_SUCH_TOKEN_IN_THIS_CORPUS",
                                    "service": "definitely-missing-doctor-service",
                                    "semantic": false,
                                    "k": 5
                                }
                            }
                        }]
                    }
                }]
            }),
            // Round 2: answer anyway, without any retrieved evidence to
            // cite — the shipped evidence-validation layer must refuse to
            // call this grounded.
            _ => json!({
                "choices": [{
                    "finish_reason": "stop",
                    "message": {"role": "assistant", "content": "I looked but found nothing relevant."}
                }]
            }),
        };
        ResponseTemplate::new(200)
            .insert_header("content-type", "application/json")
            .set_body_json(body)
    }
}

#[tokio::test]
async fn an_answer_with_no_retrieved_evidence_is_reported_ungrounded() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(UngroundedProvider {
            call: Arc::new(AtomicUsize::new(0)),
        })
        .mount(&server)
        .await;

    let data_dir = tempfile::tempdir().unwrap();
    write_profile(data_dir.path(), &server.uri(), "test-model");

    let output = cli(data_dir.path())
        .args(["--jsonl", "doctor", "--timeout", "10"])
        .output()
        .expect("doctor run");
    assert_eq!(
        output.status.code(),
        Some(8),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let lines = jsonl(&output.stdout);
    let grounding = check(&lines, "grounding").expect("grounding present");
    assert_eq!(
        grounding["status"], "fail",
        "an answer with no retrieved evidence must never be reported grounded: {grounding}"
    );
    assert_eq!(verdict(&lines)["ready"], false);
}

// ---------------------------------------------------------------------
// 7. Unwritable state
// ---------------------------------------------------------------------

#[cfg(unix)] // exercises unix mode bits (0o555); Windows has no equivalent chmod semantics
#[test]
fn unwritable_state_fails_that_check_without_blocking_the_others() {
    use std::os::unix::fs::PermissionsExt;

    let data_dir = tempfile::tempdir().unwrap();
    // No provider profile needed: writable_state is independent.
    // r-xr-xr-x: readable/listable but not writable, on this owner or
    // anyone else — deliberately narrower than a bare `set_readonly(false)`
    // restoration would later produce.
    std::fs::set_permissions(data_dir.path(), std::fs::Permissions::from_mode(0o555)).unwrap();

    let output = cli(data_dir.path())
        .args(["--jsonl", "doctor", "--skip-live-turn", "--timeout", "3"])
        .output()
        .expect("doctor run");

    // Restore permissions immediately so the tempdir can be cleaned up
    // regardless of what the assertions below find.
    let _ = std::fs::set_permissions(data_dir.path(), std::fs::Permissions::from_mode(0o755));

    assert_eq!(
        output.status.code(),
        Some(8),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let lines = jsonl(&output.stdout);
    let writable = check(&lines, "writable_state").expect("writable_state present");
    assert_eq!(writable["status"], "fail");
    assert!(writable["message"]
        .as_str()
        .unwrap()
        .contains("not writable"));
    // config still ran and is independent of the writable-state failure.
    assert!(check(&lines, "config").is_some());
}

// ---------------------------------------------------------------------
// 8. Interrupted run
// ---------------------------------------------------------------------

#[tokio::test]
async fn an_interrupted_run_still_cleans_up_the_synthetic_corpus() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_delay(Duration::from_secs(20))
                .set_body_json(json!({
                    "choices": [{"finish_reason": "stop", "message": {"role": "assistant", "content": "late"}}]
                })),
        )
        .mount(&server)
        .await;

    let data_dir = tempfile::tempdir().unwrap();
    write_profile(data_dir.path(), &server.uri(), "test-model");

    let bin = assert_cmd::cargo::cargo_bin("contextdesk");
    let mut child = std::process::Command::new(bin)
        .args([
            "--data-dir",
            data_dir.path().to_str().unwrap(),
            "doctor",
            "--timeout",
            "30",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn contextdesk doctor");

    // Wait for the two fast local checks (config, writable_state) to
    // actually print before signalling, rather than guessing a wall-clock
    // budget for process start-up — see `wait_for_n_lines`. A small buffer
    // after the second line covers the real (if fast) local disk I/O of
    // creating and seeding the synthetic corpus that follows those two
    // checks and precedes turn one's own network wait — signalling the
    // instant the second line is observed sometimes lands SIGINT inside
    // that local I/O, before the process has ever polled `ctrl_c()` even
    // once. The mock's 20s delay on turn one itself guarantees it is still
    // in flight well after this buffer.
    let stdout = child.stdout.take().expect("piped stdout");
    let (_observed, _stdout_drain) = wait_for_n_lines(stdout, 2);
    tokio::time::sleep(Duration::from_millis(1500)).await;

    let pid = child.id();
    let killed = std::process::Command::new("kill")
        .args(["-INT", &pid.to_string()])
        .status()
        .expect("send SIGINT");
    assert!(killed.success(), "kill -INT must itself succeed");

    let output = child
        .wait_with_output()
        .expect("wait for interrupted process");
    assert_eq!(
        output.status.code(),
        Some(130),
        "Cancelled exit code; stderr={}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        synthetic_corpora_left_behind(data_dir.path()),
        0,
        "an interrupted run must still remove the synthetic corpus it created"
    );
}

/// Regression test for an adversarial-review finding: the first turn
/// completes and its session is durably saved (`run_chat_workflow` persists
/// unconditionally on success) BEFORE the second turn starts — an
/// interrupt that lands during the second turn must still clean up that
/// already-saved session, not just the corpus. An earlier version of the
/// Ctrl-C handling discarded the known session id on this exact path,
/// leaking a permanent "doctor readiness check" session into the real,
/// non-isolated session store.
#[derive(Clone)]
struct HangsOnSecondTurnProvider {
    call: Arc<AtomicUsize>,
}

impl Respond for HangsOnSecondTurnProvider {
    fn respond(&self, _request: &Request) -> ResponseTemplate {
        match self.call.fetch_add(1, Ordering::SeqCst) {
            0 => ResponseTemplate::new(200)
                .insert_header("content-type", "application/json")
                .set_body_json(json!({
                    "choices": [{
                        "finish_reason": "tool_calls",
                        "message": {
                            "role": "assistant",
                            "content": null,
                            "tool_calls": [{
                                "type": "function",
                                "function": {
                                    "name": "search_logs",
                                    "arguments": {"query": "SYNTH_DOCTOR_READINESS_CHECK", "semantic": false, "k": 5}
                                }
                            }]
                        }
                    }]
                })),
            1 => ResponseTemplate::new(200)
                .insert_header("content-type", "application/json")
                .set_body_json(json!({
                    "choices": [{
                        "finish_reason": "stop",
                        "message": {
                            "role": "assistant",
                            "content": "The readiness probe fired with correlation doctor-1 (seq=1 source=\"synthetic/doctor-readiness-check.log\")."
                        }
                    }]
                })),
            // Turn two's own call(s) never arrive in time — this is the
            // in-flight request Ctrl-C interrupts.
            _ => ResponseTemplate::new(200)
                .set_delay(Duration::from_secs(20))
                .set_body_json(json!({
                    "choices": [{"finish_reason": "stop", "message": {"role": "assistant", "content": "late"}}]
                })),
        }
    }
}

#[tokio::test]
async fn an_interrupt_during_the_second_turn_still_removes_the_already_saved_session() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(HangsOnSecondTurnProvider {
            call: Arc::new(AtomicUsize::new(0)),
        })
        .mount(&server)
        .await;

    let data_dir = tempfile::tempdir().unwrap();
    write_profile(data_dir.path(), &server.uri(), "test-model");

    let bin = assert_cmd::cargo::cargo_bin("contextdesk");
    let mut child = std::process::Command::new(bin)
        .args([
            "--data-dir",
            data_dir.path().to_str().unwrap(),
            "doctor",
            "--timeout",
            "30",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn contextdesk doctor");

    // Wait for the two fast local checks to print (see `wait_for_n_lines`
    // — this removes process cold-start variance from the timing budget),
    // then give turn one — a real, if local-mock, HTTP round trip plus a
    // session save and second tool-host setup — a bounded window to finish
    // and hand off to turn two. Turn two's own mock response is delayed
    // 20s, so any reasonable margin here still lands SIGINT squarely inside
    // turn two's wait, never inside turn one's.
    let stdout = child.stdout.take().expect("piped stdout");
    let (_observed, _stdout_drain) = wait_for_n_lines(stdout, 2);
    tokio::time::sleep(Duration::from_millis(1800)).await;

    let pid = child.id();
    let killed = std::process::Command::new("kill")
        .args(["-INT", &pid.to_string()])
        .status()
        .expect("send SIGINT");
    assert!(killed.success(), "kill -INT must itself succeed");

    let output = child
        .wait_with_output()
        .expect("wait for interrupted process");
    assert_eq!(
        output.status.code(),
        Some(130),
        "Cancelled exit code; stderr={}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        synthetic_corpora_left_behind(data_dir.path()),
        0,
        "an interrupted run must still remove the synthetic corpus it created"
    );
    assert_eq!(
        synthetic_sessions_left_behind(data_dir.path()),
        0,
        "an interrupt during the second turn must still remove the session \
         the first turn already saved — this is the exact regression the \
         adversarial review caught"
    );
}

// ---------------------------------------------------------------------
// 9. JSONL purity
// ---------------------------------------------------------------------

#[test]
fn jsonl_output_is_pure_even_on_failure() {
    let data_dir = tempfile::tempdir().unwrap();
    write_profile(data_dir.path(), "http://127.0.0.1:1/v1", "test-model");

    let output = cli(data_dir.path())
        .args(["--jsonl", "doctor", "--skip-live-turn", "--timeout", "3"])
        .output()
        .expect("doctor run");

    // Every stdout line must parse as JSON — no prompt text, no bare
    // eprintln leakage, nothing but tagged DoctorLine objects.
    for (i, line) in String::from_utf8_lossy(&output.stdout).lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let value: Value = serde_json::from_str(line)
            .unwrap_or_else(|e| panic!("stdout line {i} is not valid JSON: {line:?}: {e}"));
        assert!(
            value["type"] == "check" || value["type"] == "verdict",
            "unexpected line shape: {value}"
        );
    }
    let lines = jsonl(&output.stdout);
    assert_eq!(
        lines.last().unwrap()["type"],
        "verdict",
        "the terminal line must always be the verdict"
    );
}

// ---------------------------------------------------------------------
// 10. Successful two-turn continuity (happy path)
// ---------------------------------------------------------------------

/// The four scripted response bodies a well-behaved provider gives across a
/// full two-turn, tool-calling doctor exercise: turn one calls the tool,
/// then answers grounded in what it found; turn two calls the tool again
/// (this is fine — grounding is proven by evidence citation, not by
/// forbidding a second lookup) and answers grounded again, referencing the
/// same correlation the first turn already established. Shared by every
/// happy-path test in this file, with or without an artificial response
/// delay layered on top.
fn grounded_two_turn_body(call_index: usize) -> Value {
    match call_index {
        0 => json!({
            "choices": [{
                "finish_reason": "tool_calls",
                "message": {
                    "role": "assistant",
                    "content": null,
                    "tool_calls": [{
                        "type": "function",
                        "function": {
                            "name": "search_logs",
                            "arguments": {"query": "SYNTH_DOCTOR_READINESS_CHECK", "semantic": false, "k": 5}
                        }
                    }]
                }
            }]
        }),
        1 => json!({
            "choices": [{
                "finish_reason": "stop",
                "message": {
                    "role": "assistant",
                    "content": "The readiness probe fired with correlation doctor-1 (seq=1 source=\"synthetic/doctor-readiness-check.log\")."
                }
            }]
        }),
        2 => json!({
            "choices": [{
                "finish_reason": "tool_calls",
                "message": {
                    "role": "assistant",
                    "content": null,
                    "tool_calls": [{
                        "id": "second-search",
                        "type": "function",
                        "function": {
                            "name": "search_logs",
                            "arguments": {"query": "doctor-1", "semantic": false, "k": 5}
                        }
                    }]
                }
            }]
        }),
        _ => json!({
            "choices": [{
                "finish_reason": "stop",
                "message": {
                    "role": "assistant",
                    "content": "The correlation id was doctor-1 (seq=1 source=\"synthetic/doctor-readiness-check.log\")."
                }
            }]
        }),
    }
}

fn grounded_two_turn_response(call_index: usize, request: &Request) -> ResponseTemplate {
    let body = grounded_two_turn_body(call_index);
    let request_body: Value = serde_json::from_slice(&request.body).unwrap_or_default();
    if request_body["stream"] != true {
        return ResponseTemplate::new(200)
            .insert_header("content-type", "application/json")
            .set_body_json(body);
    }
    let choice = &body["choices"][0];
    let message = &choice["message"];
    let delta = if let Some(calls) = message["tool_calls"].as_array() {
        let calls = calls
            .iter()
            .enumerate()
            .map(|(index, call)| {
                let mut call = call.clone();
                call["index"] = json!(index);
                if !call["function"]["arguments"].is_string() {
                    call["function"]["arguments"] =
                        json!(serde_json::to_string(&call["function"]["arguments"]).unwrap());
                }
                call
            })
            .collect::<Vec<_>>();
        json!({"tool_calls": calls})
    } else {
        json!({"content": message["content"]})
    };
    let chunk = json!({"choices": [{"index": 0, "delta": delta}]});
    let stop = json!({
        "choices": [{"index": 0, "delta": {}, "finish_reason": choice["finish_reason"]}]
    });
    ResponseTemplate::new(200)
        .insert_header("content-type", "text/event-stream")
        .set_body_raw(
            format!("data: {chunk}\n\ndata: {stop}\n\ndata: [DONE]\n\n"),
            "text/event-stream",
        )
}

#[derive(Clone)]
struct GroundedTwoTurnProvider {
    call: Arc<AtomicUsize>,
}

impl Respond for GroundedTwoTurnProvider {
    fn respond(&self, request: &Request) -> ResponseTemplate {
        grounded_two_turn_response(self.call.fetch_add(1, Ordering::SeqCst), request)
    }
}

/// Same scripted exchange as `GroundedTwoTurnProvider`, but every response
/// carries a small artificial delay — used only where a test needs a
/// reliable window to act on disk (e.g. to poison a directory's
/// permissions) between "the synthetic corpus/session exists" and "doctor
/// itself reaches cleanup," without depending on a hair-trigger race
/// against near-instant local mock responses.
#[derive(Clone)]
struct DelayedGroundedTwoTurnProvider {
    call: Arc<AtomicUsize>,
    delay: Duration,
}

/// Holds the first provider response until the test has changed only the
/// filesystem permission needed to make final corpus removal fail. Entering
/// the provider proves corpus creation and seeding completed, avoiding a race
/// with DuckDB initialization under parallel test load.
#[derive(Clone)]
struct GatedGroundedTwoTurnProvider {
    call: Arc<AtomicUsize>,
    first_request_entered: Arc<AtomicBool>,
    release_first_response: Arc<AtomicBool>,
}

impl Respond for GatedGroundedTwoTurnProvider {
    fn respond(&self, request: &Request) -> ResponseTemplate {
        let call = self.call.fetch_add(1, Ordering::SeqCst);
        if call == 0 {
            self.first_request_entered.store(true, Ordering::SeqCst);
            let deadline = std::time::Instant::now() + Duration::from_secs(10);
            while !self.release_first_response.load(Ordering::SeqCst)
                && std::time::Instant::now() < deadline
            {
                std::thread::sleep(Duration::from_millis(5));
            }
        }
        grounded_two_turn_response(call, request)
    }
}

impl Respond for DelayedGroundedTwoTurnProvider {
    fn respond(&self, request: &Request) -> ResponseTemplate {
        grounded_two_turn_response(self.call.fetch_add(1, Ordering::SeqCst), request)
            .set_delay(self.delay)
    }
}

/// Poll until `dir` contains at least one entry, returning one of them —
/// used to synchronize on doctor's own synthetic corpus (or session)
/// appearing on disk without guessing a wall-clock budget for how long
/// that takes. Callers that need a specific, unambiguous path (the
/// synthetic corpus directory, which is `log_corpora/`'s only entry) get
/// one; callers that only need "has doctor gotten this far yet" (the
/// sessions directory, which can also gain a sibling meta-cache
/// subdirectory) use the returned path only as a synchronization signal.
fn wait_for_first_entry(dir: &Path) -> std::path::PathBuf {
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        if let Ok(mut entries) = std::fs::read_dir(dir) {
            if let Some(Ok(entry)) = entries.next() {
                return entry.path();
            }
        }
        if std::time::Instant::now() > deadline {
            panic!("no entry appeared under {} within 10s", dir.display());
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn wait_for_flag(flag: &AtomicBool, description: &str) {
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        if flag.load(Ordering::SeqCst) {
            return;
        }
        if std::time::Instant::now() > deadline {
            panic!("{description} did not occur within 10s");
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[tokio::test]
async fn a_well_behaved_provider_passes_every_live_turn_check_and_cleans_up() {
    let server = MockServer::start().await;
    let counter = Arc::new(AtomicUsize::new(0));
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(GroundedTwoTurnProvider {
            call: counter.clone(),
        })
        .mount(&server)
        .await;

    let data_dir = tempfile::tempdir().unwrap();
    write_profile(data_dir.path(), &server.uri(), "test-model");

    let output = cli(data_dir.path())
        .args(["--jsonl", "doctor", "--timeout", "10"])
        .output()
        .expect("doctor run");

    let lines = jsonl(&output.stdout);
    for id in [
        "config",
        "writable_state",
        "native_tool_calling",
        "grounding",
        "tracing",
        "session_continuity",
        "cleanup",
        "provider_connectivity",
    ] {
        let c = check(&lines, id).unwrap_or_else(|| panic!("missing check {id}: {lines:#?}"));
        assert_eq!(
            c["status"], "pass",
            "check {id} must pass against a well-behaved provider: {c}"
        );
    }
    // provider_connectivity's own quick probe still structurally cannot
    // pass against a loopback mock (cd_core::ai_probe::probe_ai_gateway
    // treats any loopback base URL as "the well-known local Ollama" and
    // reports it unreachable regardless of what actually answers there —
    // see commands::doctor's own doc comment) — but the check above still
    // asserted "pass" for it, because doctor now reconciles a
    // provider_connectivity failure against a live turn that actually
    // succeeded rather than leaving a contradictory `fail` standing next to
    // a `ready` verdict. Assert that reconciliation explicitly, not just
    // its end effect, so a regression that silently drops it is caught here
    // rather than only in the dedicated multi-format regression test below.
    let connectivity =
        check(&lines, "provider_connectivity").expect("provider_connectivity present");
    assert!(
        connectivity["message"]
            .as_str()
            .unwrap()
            .contains("confirmed reachable by the live turn"),
        "a reconciled pass must say so, not read like an ordinary probe pass: {connectivity}"
    );
    assert_eq!(
        output.status.code(),
        Some(0),
        "every check passes (provider_connectivity reconciled, cleanup succeeded) \
         so the verdict must be ready — stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(verdict(&lines)["ready"], true);
    assert_eq!(
        counter.load(Ordering::SeqCst),
        4,
        "exactly two rounds per turn, two turns"
    );

    assert_eq!(
        synthetic_corpora_left_behind(data_dir.path()),
        0,
        "the synthetic corpus must be removed even after a fully successful run"
    );
    let sessions_dir = data_dir.path().join("sessions");
    let leftover_sessions = std::fs::read_dir(&sessions_dir)
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .filter(|e| e.path().is_file())
                .count()
        })
        .unwrap_or(0);
    assert_eq!(
        leftover_sessions, 0,
        "the synthetic session must be removed even after a fully successful run"
    );
}

// ---------------------------------------------------------------------
// Bonus: config-only failure (no provider configured at all) — proves the
// skip cascade for an unresolvable profile, distinct from an unreachable
// one.
// ---------------------------------------------------------------------

#[test]
fn no_profile_at_all_still_produces_a_full_honest_report() {
    let data_dir = tempfile::tempdir().unwrap();
    // No config.json written: AppConfig::default() has no profiles and no
    // active_id, but resolve_provider_profile still falls back to a
    // synthesized local Ollama default — so "config" actually passes here.
    // This test instead proves --skip-live-turn's honest "not ready"
    // contract even when every non-live check passes.
    let output = cli(data_dir.path())
        .args(["--jsonl", "doctor", "--skip-live-turn", "--timeout", "3"])
        .output()
        .expect("doctor run");
    assert_eq!(output.status.code(), Some(8));

    let lines = jsonl(&output.stdout);
    for id in [
        "native_tool_calling",
        "grounding",
        "tracing",
        "session_continuity",
        "cleanup",
    ] {
        let c = check(&lines, id).unwrap();
        assert_eq!(c["status"], "skip");
        assert!(c["message"].as_str().unwrap().contains("--skip-live-turn"));
    }
    assert_eq!(
        verdict(&lines)["ready"],
        false,
        "skipped checks must never be reported as ready"
    );
}

// ---------------------------------------------------------------------
// 11. provider_connectivity coherence — the quick heuristic must never
// contradict a live workflow that actually succeeded, in any output
// format.
// ---------------------------------------------------------------------

#[tokio::test]
async fn provider_connectivity_never_contradicts_a_successful_live_workflow_in_any_format() {
    for format in ["text", "json", "jsonl"] {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(GroundedTwoTurnProvider {
                call: Arc::new(AtomicUsize::new(0)),
            })
            .mount(&server)
            .await;

        let data_dir = tempfile::tempdir().unwrap();
        write_profile(data_dir.path(), &server.uri(), "test-model");

        let args: Vec<&str> = match format {
            "json" => vec!["--json", "doctor", "--timeout", "10"],
            "jsonl" => vec!["--jsonl", "doctor", "--timeout", "10"],
            _ => vec!["doctor", "--timeout", "10"],
        };
        let output = cli(data_dir.path())
            .args(&args)
            .output()
            .expect("doctor run");

        assert_eq!(
            output.status.code(),
            Some(0),
            "format={format}: a live workflow that actually succeeded must be ready \
             regardless of what the quick probe alone reported; stdout={} stderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );

        let stdout = String::from_utf8_lossy(&output.stdout);
        match format {
            "json" => {
                let value: Value = serde_json::from_str(stdout.trim()).unwrap_or_else(|e| {
                    panic!("format=json: stdout is not valid JSON: {e}: {stdout}")
                });
                assert_eq!(value["data"]["ready"], true, "format=json: {value}");
                let checks = value["data"]["checks"].as_array().expect("checks array");
                assert!(
                    checks.iter().all(|c| c["status"] != "fail"),
                    "format=json: a ready result must not contain a contradictory FAIL \
                     check: {checks:#?}"
                );
                let connectivity = checks
                    .iter()
                    .find(|c| c["id"] == "provider_connectivity")
                    .expect("provider_connectivity present");
                assert_eq!(
                    connectivity["status"], "pass",
                    "format=json: {connectivity}"
                );
            }
            "jsonl" => {
                let lines = jsonl(&output.stdout);
                assert_eq!(verdict(&lines)["ready"], true, "format=jsonl: {lines:#?}");
                assert!(
                    lines
                        .iter()
                        .filter(|l| l["type"] == "check")
                        .all(|c| c["status"] != "fail"),
                    "format=jsonl: a ready result must not contain a contradictory FAIL \
                     check: {lines:#?}"
                );
                let connectivity =
                    check(&lines, "provider_connectivity").expect("provider_connectivity present");
                assert_eq!(
                    connectivity["status"], "pass",
                    "format=jsonl: {connectivity}"
                );
            }
            _ => {
                assert!(
                    stdout.contains("ready —"),
                    "format=text: expected the ready summary line: {stdout}"
                );
                assert!(
                    !stdout.contains("[FAIL]"),
                    "format=text: a ready result must not print a contradictory FAIL line: {stdout}"
                );
                assert!(
                    stdout.contains("[PASS] provider_connectivity"),
                    "format=text: {stdout}"
                );
            }
        }
    }
}

// ---------------------------------------------------------------------
// 12. Cleanup gating — corpus deletion failure
// ---------------------------------------------------------------------

#[cfg(unix)] // exercises unix mode bits (0o555); Windows has no equivalent chmod semantics
#[tokio::test]
async fn cleanup_check_fails_and_gates_readiness_when_the_synthetic_corpus_cannot_be_removed() {
    use std::os::unix::fs::PermissionsExt;

    let server = MockServer::start().await;
    let first_request_entered = Arc::new(AtomicBool::new(false));
    let release_first_response = Arc::new(AtomicBool::new(false));
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(GatedGroundedTwoTurnProvider {
            call: Arc::new(AtomicUsize::new(0)),
            first_request_entered: first_request_entered.clone(),
            release_first_response: release_first_response.clone(),
        })
        .mount(&server)
        .await;

    let data_dir = tempfile::tempdir().unwrap();
    write_profile(data_dir.path(), &server.uri(), "test-model");

    let bin = assert_cmd::cargo::cargo_bin("contextdesk");
    let child = std::process::Command::new(bin)
        .args([
            "--data-dir",
            data_dir.path().to_str().unwrap(),
            "--jsonl",
            "doctor",
            "--timeout",
            "10",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn contextdesk doctor");

    wait_for_flag(&first_request_entered, "first provider request");
    let corpora_dir = data_dir.path().join("cache").join("log_corpora");
    let corpus_dir = wait_for_first_entry(&corpora_dir);
    assert!(corpus_dir.join("meta.json").is_file());
    assert!(corpus_dir.join("events.duckdb").is_file());
    // The corpus itself stays writable so later read/open behavior (including
    // DuckDB WAL housekeeping) remains production-real. Removing its final
    // directory entry requires write access to `log_corpora`, so poisoning
    // only that parent targets discard and nothing earlier in the workflow.
    std::fs::set_permissions(&corpora_dir, std::fs::Permissions::from_mode(0o555)).unwrap();
    release_first_response.store(true, Ordering::SeqCst);

    let output = child.wait_with_output().expect("doctor run to completion");

    // Restore permissions so the tempdir can be cleaned up on drop
    // regardless of what the assertions below find.
    let _ = std::fs::set_permissions(&corpora_dir, std::fs::Permissions::from_mode(0o755));

    assert_eq!(
        output.status.code(),
        Some(8),
        "a cleanup failure must gate readiness even though every other check passed; \
         stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );

    let lines = jsonl(&output.stdout);
    let cleanup = check(&lines, "cleanup").expect("cleanup present");
    assert_eq!(cleanup["status"], "fail");
    assert!(
        cleanup["message"].as_str().unwrap().contains("corpus"),
        "{cleanup}"
    );
    assert_eq!(verdict(&lines)["ready"], false);

    for id in [
        "native_tool_calling",
        "grounding",
        "tracing",
        "session_continuity",
    ] {
        let c = check(&lines, id).unwrap_or_else(|| panic!("missing check {id}: {lines:#?}"));
        assert_eq!(
            c["status"], "pass",
            "the live workflow itself succeeded; only cleanup should fail: {c}"
        );
    }
}

// ---------------------------------------------------------------------
// 13. Cleanup gating — session deletion failure
// ---------------------------------------------------------------------

#[cfg(unix)] // exercises unix mode bits (0o555); Windows has no equivalent chmod semantics
#[tokio::test]
async fn cleanup_check_fails_and_gates_readiness_when_the_synthetic_session_cannot_be_removed() {
    use std::os::unix::fs::PermissionsExt;

    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(DelayedGroundedTwoTurnProvider {
            call: Arc::new(AtomicUsize::new(0)),
            delay: Duration::from_millis(150),
        })
        .mount(&server)
        .await;

    let data_dir = tempfile::tempdir().unwrap();
    write_profile(data_dir.path(), &server.uri(), "test-model");

    let bin = assert_cmd::cargo::cargo_bin("contextdesk");
    let child = std::process::Command::new(bin)
        .args([
            "--data-dir",
            data_dir.path().to_str().unwrap(),
            "--jsonl",
            "doctor",
            "--timeout",
            "10",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn contextdesk doctor");

    // Wait for the session file turn one persists, then strip write
    // permission from its CONTAINING directory (not the file itself) —
    // deleting a file needs write on its parent, but overwriting an
    // EXISTING file's content in place (what turn two's own save does)
    // only needs write on the file itself, which stays untouched here, so
    // turn two's save still succeeds and only the later delete fails.
    let sessions_dir = data_dir.path().join("sessions");
    wait_for_first_entry(&sessions_dir);
    std::fs::set_permissions(&sessions_dir, std::fs::Permissions::from_mode(0o555)).unwrap();

    let output = child.wait_with_output().expect("doctor run to completion");

    let _ = std::fs::set_permissions(&sessions_dir, std::fs::Permissions::from_mode(0o755));

    assert_eq!(
        output.status.code(),
        Some(8),
        "a cleanup failure must gate readiness even though every other check passed; \
         stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );

    let lines = jsonl(&output.stdout);
    let cleanup = check(&lines, "cleanup").expect("cleanup present");
    assert_eq!(cleanup["status"], "fail");
    assert!(
        cleanup["message"].as_str().unwrap().contains("session"),
        "{cleanup}"
    );
    assert_eq!(verdict(&lines)["ready"], false);

    for id in [
        "native_tool_calling",
        "grounding",
        "tracing",
        "session_continuity",
    ] {
        let c = check(&lines, id).unwrap_or_else(|| panic!("missing check {id}: {lines:#?}"));
        assert_eq!(
            c["status"], "pass",
            "the live workflow itself succeeded; only cleanup should fail: {c}"
        );
    }

    // Corpus cleanup must succeed independently of session cleanup — only
    // the sessions directory was poisoned above.
    assert_eq!(
        synthetic_corpora_left_behind(data_dir.path()),
        0,
        "corpus cleanup must succeed independently of session cleanup"
    );
}

// ---------------------------------------------------------------------
// 14. Interrupted run surfaces cleanup in structured output, not only
// stderr, while still preserving exit 130.
// ---------------------------------------------------------------------

#[tokio::test]
async fn an_interrupted_run_reports_cleanup_in_the_jsonl_interrupted_line_itself() {
    let server = MockServer::start().await;
    let first_request_entered = Arc::new(AtomicBool::new(false));
    let release_first_response = Arc::new(AtomicBool::new(false));
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(GatedGroundedTwoTurnProvider {
            call: Arc::new(AtomicUsize::new(0)),
            first_request_entered: first_request_entered.clone(),
            release_first_response: release_first_response.clone(),
        })
        .mount(&server)
        .await;

    let data_dir = tempfile::tempdir().unwrap();
    write_profile(data_dir.path(), &server.uri(), "test-model");

    let bin = assert_cmd::cargo::cargo_bin("contextdesk");
    let child = std::process::Command::new(bin)
        .args([
            "--data-dir",
            data_dir.path().to_str().unwrap(),
            "--jsonl",
            "doctor",
            "--timeout",
            "30",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn contextdesk doctor");

    // Synchronize on the actual in-flight provider request. A blind sleep can
    // still land before the process installs/polls its Ctrl-C handler under
    // heavy parallel load, terminating by signal instead of the documented
    // cooperative exit 130 and losing the structured interrupted record.
    wait_for_flag(&first_request_entered, "first provider request");
    let pid = child.id();
    let killed = std::process::Command::new("kill")
        .args(["-INT", &pid.to_string()])
        .status()
        .expect("send SIGINT");
    assert!(killed.success(), "kill -INT must itself succeed");

    let output = child
        .wait_with_output()
        .expect("wait for interrupted process");
    release_first_response.store(true, Ordering::SeqCst);
    assert_eq!(
        output.status.code(),
        Some(130),
        "Cancelled exit code must be preserved regardless of cleanup's own outcome; stderr={}",
        String::from_utf8_lossy(&output.stderr)
    );

    let lines = jsonl(&output.stdout);
    let interrupted = lines
        .iter()
        .find(|l| l["type"] == "interrupted")
        .unwrap_or_else(|| panic!("no interrupted line found: {lines:#?}"));
    assert_eq!(
        interrupted["cleanup_status"], "pass",
        "cleanup succeeded (nothing poisoned this run) and that must be visible in the \
         interrupted line itself, not only inferred from a stderr warning: {interrupted}"
    );
    assert!(
        interrupted["cleanup_detail"]
            .as_str()
            .unwrap()
            .contains("removed"),
        "{interrupted}"
    );
    assert_eq!(
        synthetic_corpora_left_behind(data_dir.path()),
        0,
        "an interrupted run must still remove the synthetic corpus it created"
    );
}
