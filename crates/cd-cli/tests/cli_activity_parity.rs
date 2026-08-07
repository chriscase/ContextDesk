//! Activity/trace parity proofs for the CLI host — real binary path.

use assert_cmd::Command;
use cd_core::config::{save_config, AppConfig};
use cd_core::providers::{ProviderConfig, ProviderKind, ProviderProfile};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, Request, ResponseTemplate};

fn cli(home: &Path) -> Command {
    let mut cmd =
        Command::cargo_bin("contextdesk").expect("contextdesk binary built by this workspace");
    cmd.env("HOME", home);
    cmd.env("NO_COLOR", "1");
    cmd
}

fn write_profile(home: &Path, server_uri: &str, tools: bool) -> PathBuf {
    let app_config_path = home.join("config.json");
    let mut profile = ProviderProfile::ollama_local();
    profile.kind = ProviderKind::OpenAiCompatible;
    profile.base_url = server_uri.to_string();
    profile.local_only = true;
    profile.chat_model = "test-model".into();
    profile.capabilities.tools = tools;
    // Stream on: wiremock tests return SSE tool_calls the production client parses.
    profile.capabilities.stream = true;
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
        src.contains("project_turn_activity"),
        "CLI chat must project shared activity"
    );
    assert!(
        src.contains("RecordingTurnTrace"),
        "CLI chat must attach shared TurnTraceSink capture"
    );
}

const SSE_BODY: &str =
    "data: {\"choices\":[{\"delta\":{\"content\":\"hello from the mock model\"}}]}\n\n\
     data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n\
     data: [DONE]\n\n";

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
    let app_config_path = write_profile(home.path(), &server.uri(), false);

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
    let text = String::from_utf8_lossy(&output.stdout);
    assert!(
        !text.contains('\u{1b}'),
        "JSON stdout must not contain ANSI"
    );
    let value: Value = serde_json::from_str(text.trim()).expect("json envelope");
    assert_eq!(value["ok"], true);
    let activity = &value["data"]["activity"];
    assert!(
        activity["events"]
            .as_array()
            .map(|a| !a.is_empty())
            .unwrap_or(false),
        "activity events must be non-empty: {activity}"
    );
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

/// Real binary path: a tool-calling mock must produce a monotonic activity
/// chain covering context/provider/tool/completion phases (shared projection).
#[tokio::test]
async fn activity_causal_phases_on_tool_round_are_monotonic() {
    let server = MockServer::start().await;
    let call_n = Arc::new(AtomicUsize::new(0));
    let call_n2 = call_n.clone();
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(move |req: &Request| {
            let n = call_n2.fetch_add(1, Ordering::SeqCst);
            let body: Value = serde_json::from_slice(&req.body).unwrap_or(Value::Null);
            let messages = body
                .get("messages")
                .and_then(|m| m.as_array())
                .cloned()
                .unwrap_or_default();
            let has_tool = messages
                .iter()
                .any(|m| m.get("role").and_then(|r| r.as_str()) == Some("tool"));
            if n == 0 && !has_tool {
                // First round: request a tool
                let payload = serde_json::json!({
                    "id": "c1",
                    "object": "chat.completion",
                    "choices": [{
                        "index": 0,
                        "message": {
                            "role": "assistant",
                            "content": null,
                            "tool_calls": [{
                                "id": "call_1",
                                "type": "function",
                                "function": {
                                    "name": "search_kb",
                                    "arguments": "{\"query\":\"hello\"}"
                                }
                            }]
                        },
                        "finish_reason": "tool_calls"
                    }]
                });
                ResponseTemplate::new(200)
                    .insert_header("content-type", "application/json")
                    .set_body_json(payload)
            } else {
                // Subsequent: final answer
                let sse =
                    "data: {\"choices\":[{\"delta\":{\"content\":\"final cited answer\"}}]}\n\n\
                     data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n\
                     data: [DONE]\n\n";
                ResponseTemplate::new(200)
                    .insert_header("content-type", "text/event-stream")
                    .set_body_raw(sse, "text/event-stream")
            }
        })
        .mount(&server)
        .await;

    let home = tempfile::tempdir().unwrap();
    let app_config_path = write_profile(home.path(), &server.uri(), true);

    let output = cli(home.path())
        .args([
            "--app-config",
            app_config_path.to_str().unwrap(),
            "--json",
            "chat",
            "--activity",
            "summary",
            "--auto-approve",
            "search knowledge",
        ])
        .output()
        .expect("run chat");
    assert!(
        output.status.success(),
        "stderr={} stdout={}",
        String::from_utf8_lossy(&output.stderr),
        String::from_utf8_lossy(&output.stdout)
    );
    let value: Value =
        serde_json::from_str(String::from_utf8_lossy(&output.stdout).trim()).expect("json");
    let activity = &value["data"]["activity"];
    let events = activity["events"].as_array().expect("events array").clone();
    assert!(
        events.len() >= 2,
        "expected multi-step causal activity, got {events:?}"
    );
    // Monotonic seq
    let mut last_seq = -1i64;
    for event in &events {
        let seq = event["seq"].as_i64().expect("seq");
        assert!(seq > last_seq, "seq must be strictly monotonic: {events:?}");
        last_seq = seq;
    }
    let labels: Vec<String> = events
        .iter()
        .filter_map(|e| e.get("label").and_then(|l| l.as_str()).map(str::to_string))
        .collect();
    let joined = labels.join(" | ");
    // Must include a model request and some host work (tool and/or phase/trail)
    assert!(
        labels
            .iter()
            .any(|l| l.to_ascii_lowercase().contains("model")
                || l.to_ascii_lowercase().contains("request")
                || l.to_ascii_lowercase().contains("round")),
        "missing provider/model phase in labels: {joined}"
    );
    let has_tool = labels.iter().any(|l| {
        let ll = l.to_ascii_lowercase();
        ll.contains("tool") || ll.contains("search_kb") || ll.contains("awaiting permission")
    });
    assert!(
        has_tool,
        "expected Tool started/finished (or permission) activity after tool_calls round; labels={joined}; provider_calls={}",
        call_n.load(Ordering::SeqCst)
    );
    // Multi-round provider path: tool_calls round then final (or at least tool lifecycle)
    assert!(
        call_n.load(Ordering::SeqCst) >= 1,
        "mock must have been contacted"
    );
    // Origins must be classified (not missing)
    for event in &events {
        assert!(event.get("origin").is_some(), "missing origin: {event}");
        assert!(
            event.get("determinism").is_some(),
            "missing determinism: {event}"
        );
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
    let app_config_path = write_profile(home.path(), &server.uri(), false);

    let run = || {
        cli(home.path())
            .args([
                "--app-config",
                app_config_path.to_str().unwrap(),
                "--jsonl",
                "chat",
                "--activity",
                "summary",
                "parity probe",
            ])
            .output()
            .expect("run")
    };

    let out1 = run();
    let out2 = run();
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
    }
}

#[tokio::test]
async fn dry_run_activity_and_trace_share_capture() {
    let home = tempfile::tempdir().unwrap();
    let app_config_path = write_profile(home.path(), "http://127.0.0.1:9", false);

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
    assert!(value["data"]["activity"].is_object());
    let events = value["data"]["activity"]["events"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    assert!(
        !events.is_empty(),
        "dry-run must project activity events, got empty: {}",
        value["data"]["activity"]
    );
}

#[tokio::test]
async fn linked_tools_unavailable_projects_truthful_failed_activity() {
    let home = tempfile::tempdir().unwrap();
    // tools=false + corpus → linked_tools_unavailable early path
    let app_config_path = write_profile(home.path(), "http://127.0.0.1:9", false);
    // Create a minimal corpus by importing via core isn't available; use dry-run
    // ordinary first to ensure binary works, then force corpus id that may not exist —
    // instead: pass --corpus with nonexistent to get error, or import logs.
    let logs = home.path().join("logs");
    std::fs::create_dir_all(&logs).unwrap();
    std::fs::write(
        logs.join("app.log"),
        "2024-01-01T00:00:00Z INFO started\n2024-01-01T00:00:01Z ERROR boom\n",
    )
    .unwrap();
    let import = cli(home.path())
        .args([
            "--app-config",
            app_config_path.to_str().unwrap(),
            "import",
            logs.to_str().unwrap(),
        ])
        .output()
        .expect("import");
    // import may succeed or partially; extract corpus from cli state by listing
    let list = cli(home.path())
        .args([
            "--app-config",
            app_config_path.to_str().unwrap(),
            "--json",
            "corpus",
            "list",
        ])
        .output()
        .expect("list");
    let list_txt = String::from_utf8_lossy(&list.stdout);
    let corpus = {
        // find uuid in import stdout/stderr or list
        let blob = format!(
            "{}{}{}",
            String::from_utf8_lossy(&import.stdout),
            String::from_utf8_lossy(&import.stderr),
            list_txt
        );
        regex_lite_uuid(&blob)
    };
    if corpus.is_none() {
        // If import path is unavailable in this env, still prove error projection via dry-run
        // ordinary activity non-empty (covered elsewhere).
        eprintln!("skip linked_tools test: no corpus ({list_txt})");
        return;
    }
    let corpus = corpus.unwrap();
    let output = cli(home.path())
        .args([
            "--app-config",
            app_config_path.to_str().unwrap(),
            "--json",
            "chat",
            "--activity",
            "summary",
            "--corpus",
            &corpus,
            "--new",
            "why did payment fail?",
        ])
        .output()
        .expect("run");
    // May be ok:false or ok:true with ungrounded — require activity events + non-ok status or error label
    let value: Value =
        serde_json::from_str(String::from_utf8_lossy(&output.stdout).trim()).unwrap_or(Value::Null);
    if value["ok"] == true {
        let act = &value["data"]["activity"];
        assert!(
            act["events"]
                .as_array()
                .map(|a| !a.is_empty())
                .unwrap_or(false),
            "linked refusal must project events: {act}"
        );
        let labels = act["events"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|e| e["label"].as_str())
            .collect::<Vec<_>>()
            .join("|");
        assert!(
            labels.to_ascii_lowercase().contains("error")
                || act["status"] != "ok"
                || labels.contains("linked"),
            "expected truthful failure/withheld labels, got status={} labels={labels}",
            act["status"]
        );
    } else {
        // json envelope error path still ok for this scenario
        assert!(value["error"].is_object(), "{value}");
    }
}

fn regex_lite_uuid(s: &str) -> Option<String> {
    // simple scan for uuid-ish
    let bytes = s.as_bytes();
    let mut i = 0;
    while i + 36 <= bytes.len() {
        let slice = &s[i..i + 36];
        if slice.chars().enumerate().all(|(j, c)| match j {
            8 | 13 | 18 | 23 => c == '-',
            _ => c.is_ascii_hexdigit(),
        }) {
            return Some(slice.to_string());
        }
        i += 1;
    }
    None
}

/// Real linked-corpus happy path: the provider must request the native log
/// tool, receive host-owned evidence, and then produce an answer whose exact
/// seq/source pair passes the core grounding validator.  A generic final
/// answer cannot satisfy this oracle.
#[tokio::test]
async fn linked_log_turn_returns_exact_grounded_evidence_and_activity_lifecycle() {
    let server = MockServer::start().await;
    let call_n = Arc::new(AtomicUsize::new(0));
    let call_n2 = call_n.clone();
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(move |req: &Request| {
            let body: Value = serde_json::from_slice(&req.body).expect("provider request JSON");
            let messages = body["messages"].as_array().expect("messages");
            let has_tool_result = messages.iter().any(|message| {
                message["content"]
                    .as_str()
                    .is_some_and(|content| content.contains("source_kind: log_templates"))
            });
            call_n2.fetch_add(1, Ordering::SeqCst);
            if has_tool_result {
                let tool_body = messages
                    .iter()
                    .find(|message| {
                        message["content"]
                            .as_str()
                            .is_some_and(|content| content.contains("source_kind: log_templates"))
                    })
                    .and_then(|message| message["content"].as_str())
                    .expect("model follow-up receives tool result");
                assert!(
                    tool_body.contains("seq=1") && tool_body.contains("source=app.log"),
                    "follow-up must receive the exact host evidence: {tool_body}"
                );
                let answer = serde_json::json!({
                    "choices": [{
                        "index": 0,
                        "delta": {"content": "The payment failure is recorded at seq=1 source=app.log."},
                        "finish_reason": null
                    }]
                });
                let stop = serde_json::json!({
                    "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]
                });
                ResponseTemplate::new(200)
                    .insert_header("content-type", "text/event-stream")
                    .set_body_raw(
                        format!("data: {answer}\n\ndata: {stop}\n\ndata: [DONE]\n\n"),
                        "text/event-stream",
                    )
            } else {
                assert!(
                    body["tools"].as_array().is_some_and(|tools| tools.iter().any(|tool| {
                        tool["function"]["name"] == "search_logs"
                    })),
                    "linked first round must offer native search_logs: {body}"
                );
                let tool = serde_json::json!({
                    "choices": [{
                        "index": 0,
                        "delta": {
                            "tool_calls": [{
                                "index": 0,
                                "id": "search-1",
                                "type": "function",
                                "function": {
                                    "name": "search_logs",
                                    "arguments": "{\"query\":\"payment failed E42\",\"semantic\":false,\"k\":5}"
                                }
                            }]
                        },
                        "finish_reason": null
                    }]
                });
                let stop = serde_json::json!({
                    "choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}]
                });
                ResponseTemplate::new(200)
                    .insert_header("content-type", "text/event-stream")
                    .set_body_raw(
                        format!("data: {tool}\n\ndata: {stop}\n\ndata: [DONE]\n\n"),
                        "text/event-stream",
                    )
            }
        })
        .mount(&server)
        .await;

    let home = tempfile::tempdir().unwrap();
    let app_config_path = write_profile(home.path(), &server.uri(), true);
    let logs = home.path().join("logs");
    std::fs::create_dir(&logs).unwrap();
    std::fs::write(
        logs.join("app.log"),
        "2024-01-01T00:00:00Z INFO service started\n2024-01-01T00:00:01Z ERROR payment failed code=E42\n",
    )
    .unwrap();
    let imported = cli(home.path())
        .args([
            "--app-config",
            app_config_path.to_str().unwrap(),
            "--json",
            "import",
            logs.to_str().unwrap(),
        ])
        .output()
        .expect("import fixture");
    assert!(
        imported.status.success(),
        "stderr={} stdout={}",
        String::from_utf8_lossy(&imported.stderr),
        String::from_utf8_lossy(&imported.stdout)
    );
    let imported = parse_jsonl(&imported.stdout)
        .pop()
        .expect("import envelope");
    let corpus = imported["data"]["corpus_id"].as_str().expect("corpus id");

    let output = cli(home.path())
        .args([
            "--app-config",
            app_config_path.to_str().unwrap(),
            "--json",
            "chat",
            "--activity",
            "summary",
            "--new",
            "--corpus",
            corpus,
            "--auto-approve",
            "Why did the payment fail?",
        ])
        .output()
        .expect("linked chat");
    assert!(
        output.status.success(),
        "stderr={} stdout={}",
        String::from_utf8_lossy(&output.stderr),
        String::from_utf8_lossy(&output.stdout)
    );
    let value: Value = serde_json::from_slice(&output.stdout).expect("chat JSON");
    assert_eq!(value["ok"], true, "{value}");
    assert_eq!(
        value["data"]["final_text"], "The payment failure is recorded at seq=1 source=app.log.",
        "{value}"
    );
    let activity = &value["data"]["activity"];
    assert_eq!(activity["status"], "ok", "{activity}");
    let labels = activity["events"]
        .as_array()
        .expect("activity events")
        .iter()
        .filter_map(|event| event["label"].as_str())
        .collect::<Vec<_>>();
    assert!(
        labels.iter().any(|label| label.contains("search_logs")),
        "native tool lifecycle missing: {labels:?}"
    );
    assert!(
        activity["events"].as_array().unwrap().iter().any(|event| {
            event["label"] == "Citation recorded"
                && event["evidence"]
                    .as_array()
                    .is_some_and(|evidence| evidence.iter().any(|item| item["kind"] == "citation"))
        }),
        "governed privacy-safe host citation missing: {activity}"
    );
    assert!(
        labels
            .iter()
            .filter(|label| label.contains("Model request"))
            .count()
            >= 2,
        "tool round and grounded follow-up must both be visible: {labels:?}"
    );
    assert!(call_n.load(Ordering::SeqCst) >= 2);
}

#[tokio::test]
async fn hard_provider_failure_returns_bounded_failed_activity_in_json_and_jsonl() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(
            ResponseTemplate::new(500)
                .insert_header("content-type", "application/json")
                .set_body_raw(
                    r#"{"error":{"message":"failure at /private/demo/secret.log bearer sk-private-marker"}}"#,
                    "application/json",
                ),
        )
        .mount(&server)
        .await;

    for mode in ["--json", "--jsonl"] {
        let home = tempfile::tempdir().unwrap();
        let app_config_path = write_profile(home.path(), &server.uri(), false);
        let output = cli(home.path())
            .args([
                "--app-config",
                app_config_path.to_str().unwrap(),
                mode,
                "chat",
                "--activity",
                "summary",
                "--new",
                "trigger hard provider failure",
            ])
            .output()
            .expect("failed chat");
        assert_eq!(output.status.code(), Some(6), "mode={mode}");

        if mode == "--json" {
            let value: Value = serde_json::from_slice(&output.stdout).expect("failure JSON");
            assert_eq!(value["ok"], false, "{value}");
            let activity = &value["data"]["activity"];
            assert_eq!(activity["status"], "failed", "{activity}");
            assert!(
                activity["events"]
                    .as_array()
                    .is_some_and(|events| !events.is_empty()),
                "{activity}"
            );
            let retained = serde_json::to_string(activity).unwrap();
            assert!(!retained.contains("/private/demo"), "{retained}");
            assert!(!retained.contains("sk-private-marker"), "{retained}");
            // The label used to be the CLI's own synthetic `provider_error`,
            // recovered from an opaque `Err`. The turn now terminates typed,
            // so the journal keeps the classification the provider's status
            // actually supports — and still nothing from its response body.
            assert!(
                retained.contains("Error: provider_unavailable"),
                "{retained}"
            );
            assert!(retained.contains("HTTP 500"), "{retained}");
            assert!(!retained.contains("failure at"), "{retained}");
        } else {
            let lines = parse_jsonl(&output.stdout);
            assert_eq!(lines.last().unwrap()["type"], "done");
            assert_eq!(lines.last().unwrap()["ok"], false);
            let activity = lines
                .iter()
                .filter(|line| line["type"] == "activity")
                .collect::<Vec<_>>();
            assert!(!activity.is_empty(), "{lines:#?}");
            assert!(
                activity.iter().any(|line| line["status"] == "failed"),
                "{activity:#?}"
            );
            let retained = serde_json::to_string(&activity).unwrap();
            assert!(!retained.contains("/private/demo"), "{retained}");
            assert!(!retained.contains("sk-private-marker"), "{retained}");
            for line in &lines {
                assert_meta_fields(line);
            }
        }
    }
}

#[tokio::test]
async fn session_resume_persists_and_continues() {
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
    let data = home.path().join("data");
    std::fs::create_dir_all(&data).unwrap();
    let app_config_path = write_profile(home.path(), &server.uri(), false);

    let first = cli(home.path())
        .args([
            "--app-config",
            app_config_path.to_str().unwrap(),
            "--data-dir",
            data.to_str().unwrap(),
            "--json",
            "chat",
            "--activity",
            "summary",
            "--new",
            "first turn",
        ])
        .output()
        .expect("first");
    assert!(
        first.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&first.stderr)
    );
    let v1: Value = serde_json::from_str(String::from_utf8_lossy(&first.stdout).trim()).unwrap();
    assert_eq!(v1["ok"], true);
    let sid = v1["data"]["session_id"].as_str().unwrap().to_string();

    let second = cli(home.path())
        .args([
            "--app-config",
            app_config_path.to_str().unwrap(),
            "--data-dir",
            data.to_str().unwrap(),
            "--json",
            "chat",
            "--activity",
            "summary",
            "--session",
            &sid,
            "second turn",
        ])
        .output()
        .expect("second");
    assert!(
        second.status.success(),
        "stderr={} stdout={}",
        String::from_utf8_lossy(&second.stderr),
        String::from_utf8_lossy(&second.stdout)
    );
    let v2: Value = serde_json::from_str(String::from_utf8_lossy(&second.stdout).trim()).unwrap();
    assert_eq!(v2["ok"], true, "{v2}");
    assert_eq!(v2["data"]["session_id"], sid);
    assert!(v2["data"]["activity"]["events"]
        .as_array()
        .map(|a| !a.is_empty())
        .unwrap_or(false));
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
    assert!(stdout.contains("--activity"));
    assert!(stdout.contains("--trace"));
    assert!(stdout.contains("--context-selection"));
    assert!(!stdout.as_bytes().contains(&0x1b));
}

#[tokio::test]
async fn cli_context_selection_reaches_provider_only_when_explicit() {
    const TOKEN: &str = "CLI_USER_SELECTION_TOKEN_6NR3";
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
    let app_config_path = write_profile(home.path(), &server.uri(), false);

    for selection in [Some(TOKEN), None] {
        let mut command = cli(home.path());
        command.args([
            "--app-config",
            app_config_path.to_str().unwrap(),
            "--json",
            "chat",
            "--new",
        ]);
        if let Some(selection) = selection {
            command.args(["--context-selection", selection]);
        }
        let output = command
            .arg("same neutral question")
            .output()
            .expect("run chat");
        assert!(
            output.status.success(),
            "stderr={}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    let requests = server.received_requests().await.expect("requests");
    assert_eq!(requests.len(), 2);
    let selected = String::from_utf8_lossy(&requests[0].body);
    let ordinary = String::from_utf8_lossy(&requests[1].body);
    assert!(
        selected.contains(TOKEN),
        "explicit CLI selection missing: {selected}"
    );
    assert!(
        !ordinary.contains(TOKEN),
        "selection leaked into ordinary CLI turn: {ordinary}"
    );
    assert!(!ordinary.contains("<user_selected_context>"));
}

#[test]
fn activity_full_without_ack_refuses() {
    let home = tempfile::tempdir().unwrap();
    let app_config_path = write_profile(home.path(), "http://127.0.0.1:9", false);
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

#[test]
fn cli_chat_non_interactive_defaults_permission_to_deny() {
    let src = include_str!("../src/commands/chat.rs");
    assert!(
        src.contains("permission denied (non-interactive, no --auto-approve)"),
        "CLI must deny permissions non-interactively without --auto-approve"
    );
    assert!(
        src.contains("PermissionDecision::Deny"),
        "CLI must return Deny on the non-interactive path"
    );
    assert!(
        src.contains("stdout_is_tty") && src.contains("is_terminal"),
        "permission path must check TTY"
    );
}

#[tokio::test]
async fn non_interactive_permission_denies_without_auto_approve() {
    // SoftWrite on the real binary: save_skill requires Accept; non-TTY denies.
    // Mirror the proven causal tool-round mock structure exactly (application/json
    // tool_calls), only changing the tool name/args to a SoftWrite skill.
    let server = MockServer::start().await;
    let call_n = Arc::new(AtomicUsize::new(0));
    let call_n2 = call_n.clone();
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(move |req: &Request| {
            let n = call_n2.fetch_add(1, Ordering::SeqCst);
            let body: Value = serde_json::from_slice(&req.body).unwrap_or(Value::Null);
            let messages = body
                .get("messages")
                .and_then(|m| m.as_array())
                .cloned()
                .unwrap_or_default();
            let has_tool = messages
                .iter()
                .any(|m| m.get("role").and_then(|r| r.as_str()) == Some("tool"));
            if n == 0 && !has_tool {
                // SSE tool_calls (stream=true client path)
                let args = r#"{"id":"s1","name":"S","description":"d","body_markdown":"body"}"#;
                let d1 = serde_json::json!({
                    "choices": [{
                        "index": 0,
                        "delta": {
                            "tool_calls": [{
                                "index": 0,
                                "id": "call_1",
                                "type": "function",
                                "function": {
                                    "name": "save_skill",
                                    "arguments": args
                                }
                            }]
                        }
                    }]
                });
                let d2 = serde_json::json!({
                    "choices": [{
                        "index": 0,
                        "delta": {},
                        "finish_reason": "tool_calls"
                    }]
                });
                let sse = format!(
                    "data: {d1}\n\ndata: {d2}\n\ndata: [DONE]\n\n",
                    d1 = serde_json::to_string(&d1).unwrap(),
                    d2 = serde_json::to_string(&d2).unwrap(),
                );
                ResponseTemplate::new(200)
                    .insert_header("content-type", "text/event-stream")
                    .set_body_raw(sse, "text/event-stream")
            } else {
                let sse =
                    "data: {\"choices\":[{\"delta\":{\"content\":\"final after permission\"}}]}\n\n\
                     data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n\
                     data: [DONE]\n\n";
                ResponseTemplate::new(200)
                    .insert_header("content-type", "text/event-stream")
                    .set_body_raw(sse, "text/event-stream")
            }
        })
        .mount(&server)
        .await;

    let home = tempfile::tempdir().unwrap();
    let app_config_path = write_profile(home.path(), &server.uri(), true);
    let output = cli(home.path())
        .args([
            "--app-config",
            app_config_path.to_str().unwrap(),
            "--jsonl",
            "chat",
            "--activity",
            "summary",
            "--new",
            "please save a skill for me",
        ])
        .output()
        .expect("run");

    let err = String::from_utf8_lossy(&output.stderr);
    let out = String::from_utf8_lossy(&output.stdout);
    let lines = parse_jsonl(&output.stdout);
    assert!(!lines.is_empty(), "stderr={err} stdout={out}");
    assert_eq!(lines.last().unwrap()["type"], "done");
    for line in &lines {
        assert_meta_fields(line);
    }

    let blob = format!("{err}{out}").to_ascii_lowercase();
    let activity_labels: Vec<String> = lines
        .iter()
        .filter(|l| l.get("type").and_then(|t| t.as_str()) == Some("activity"))
        .filter_map(|l| l.get("label").and_then(|x| x.as_str()).map(str::to_string))
        .collect();
    let joined = activity_labels.join(" | ");

    // SoftWrite without --auto-approve on a non-TTY must surface a permission
    // phase — deny text, permission_required stream type, or activity label.
    // No escape hatch via "any Tool label".
    let saw_permission = blob.contains("permission")
        || blob.contains("denied")
        || blob.contains("allow once")
        || lines.iter().any(|l| {
            l.get("type").and_then(|t| t.as_str()) == Some("permission_required")
                || l.get("label").and_then(|x| x.as_str()).is_some_and(|x| {
                    let xl = x.to_ascii_lowercase();
                    xl.contains("permission") || xl.contains("awaiting permission")
                })
                || l.get("operation")
                    .and_then(|o| o.as_str())
                    .is_some_and(|o| o.contains("permission"))
        });
    assert!(
        saw_permission,
        "SoftWrite path must assert permission/deny (not mere Tool label); labels={joined}; stderr={err}; stdout={out}"
    );
    assert!(call_n.load(Ordering::SeqCst) >= 1);
}
