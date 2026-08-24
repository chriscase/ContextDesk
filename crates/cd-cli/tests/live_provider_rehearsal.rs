//! Deterministic rehearsal of the live-provider demo path through the
//! compiled CLI: ZIP import, automatic source selection, a native log tool
//! call, grounded synthesis, durable session continuation, and trace output.
//!
//! The provider is a local mock speaking two common OpenAI-compatible
//! variations seen in GPT-OSS gateways: it ignores `stream=true` and returns
//! normal JSON, and it emits decoded object-shaped function arguments.

use assert_cmd::Command;
use cd_core::config::AppConfig;
use cd_core::providers::{ProviderConfig, ProviderKind, ProviderProfile};
use serde_json::{json, Value};
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, Request, Respond, ResponseTemplate};
use zip::write::SimpleFileOptions;

#[path = "helpers/app_config.rs"]
mod app_config;

fn cli(data_dir: &Path) -> Command {
    let mut command =
        Command::cargo_bin("contextdesk").expect("contextdesk binary built by this workspace");
    command.args(["--data-dir", data_dir.to_str().unwrap()]);
    command
}

fn write_synthetic_zip(root: &Path) -> std::path::PathBuf {
    let archive = root.join("synthetic-incident.zip");
    let file = std::fs::File::create(&archive).expect("create synthetic ZIP");
    let mut zip = zip::ZipWriter::new(file);
    zip.start_file("region-a/app.log", SimpleFileOptions::default())
        .unwrap();
    writeln!(
        zip,
        r#"{{"ts":"2026-01-12T09:15:00Z","level":"ERROR","service":"worker","message":"SYNTH_QUEUE_STALL queue stalled correlation=demo-42"}}"#
    )
    .unwrap();
    writeln!(
        zip,
        r#"{{"ts":"2026-01-12T09:14:58Z","level":"INFO","service":"config","message":"SYNTH_POOL_CHANGE db_pool_max changed 32 to 4 correlation=demo-42"}}"#
    )
    .unwrap();
    zip.start_file("docs/screenshot.png", SimpleFileOptions::default())
        .unwrap();
    zip.write_all(b"\x89PNG\r\n\x1a\n\0synthetic-binary-attachment")
        .unwrap();
    zip.finish().unwrap();
    archive
}

#[derive(Clone)]
struct TwoTurnProvider {
    call: Arc<AtomicUsize>,
}

impl Respond for TwoTurnProvider {
    fn respond(&self, _request: &Request) -> ResponseTemplate {
        let response = match self.call.fetch_add(1, Ordering::SeqCst) {
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
                                    "query": "SYNTH_QUEUE_STALL",
                                    "semantic": false,
                                    "k": 5
                                }
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
                        "content": "The worker queue stalled under correlation demo-42 (seq=0 source=\"region-a/app.log\")."
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
                                "arguments": {
                                    "query": "SYNTH_POOL_CHANGE",
                                    "semantic": false,
                                    "k": 5
                                }
                            }
                        }]
                    }
                }]
            }),
            3 => json!({
                "choices": [{
                    "finish_reason": "stop",
                    "message": {
                        "role": "assistant",
                        "content": "In the same incident, db_pool_max changed from 32 to 4 two seconds earlier (seq=1 source=\"region-a/app.log\")."
                    }
                }]
            }),
            unexpected => {
                return ResponseTemplate::new(500)
                    .set_body_string(format!("unexpected provider round {unexpected}"));
            }
        };
        ResponseTemplate::new(200)
            .insert_header("content-type", "application/json")
            .set_body_json(response)
    }
}

fn jsonl(stdout: &[u8]) -> Vec<Value> {
    String::from_utf8_lossy(stdout)
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).expect("every stdout line is JSON"))
        .collect()
}

fn assert_grounded_turn(lines: &[Value]) -> String {
    let done = lines.last().expect("terminal JSONL line");
    assert_eq!(done["type"], "done", "lines={lines:#?}");
    assert_eq!(done["ok"], true, "lines={lines:#?}");
    assert!(lines.iter().any(|line| {
        line["type"] == "tool" && line["name"] == "search_logs" && line["ok"] == true
    }));
    assert!(
        lines
            .iter()
            .filter(|line| line["type"] == "tool")
            .all(|line| line["ok"] == true),
        "a tool-start event must not be mislabeled as a failed terminal outcome: {lines:#?}"
    );
    let trace = lines
        .iter()
        .find(|line| line["type"] == "trace_summary")
        .expect("trace summary");
    assert_eq!(trace["grounding"], "grounded", "trace={trace}");
    done["session_id"].as_str().unwrap().to_string()
}

#[tokio::test]
async fn zip_to_two_grounded_traced_turns_survives_gpt_oss_gateway_variations() {
    let server = MockServer::start().await;
    let counter = Arc::new(AtomicUsize::new(0));
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(TwoTurnProvider {
            call: counter.clone(),
        })
        .mount(&server)
        .await;

    let root = tempfile::tempdir().unwrap();
    let data_dir = root.path().join("data");
    std::fs::create_dir_all(&data_dir).unwrap();
    let archive = write_synthetic_zip(root.path());

    let mut profile = ProviderProfile::ollama_local();
    profile.kind = ProviderKind::OpenAiCompatible;
    profile.base_url = server.uri();
    profile.local_only = true;
    profile.chat_model = "gpt-oss-rehearsal".into();
    profile.capabilities.embeddings = false;
    let config = AppConfig {
        providers: ProviderConfig {
            active_id: Some(profile.id.clone()),
            profiles: vec![profile],
        },
        ..AppConfig::default()
    };
    app_config::plant_app_config(&data_dir.join("config.json"), &config);

    let imported = cli(&data_dir)
        .args(["--json", "import", archive.to_str().unwrap()])
        .output()
        .expect("import synthetic ZIP");
    assert!(
        imported.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&imported.stdout),
        String::from_utf8_lossy(&imported.stderr)
    );
    let import_envelope: Value = serde_json::from_slice(&imported.stdout).unwrap();
    assert_eq!(import_envelope["ok"], true);
    assert_eq!(import_envelope["data"]["events_imported"], 2);
    assert_eq!(import_envelope["data"]["sources_failed"], 0);
    assert_eq!(import_envelope["data"]["sources_unsupported"], 1);

    let first = cli(&data_dir)
        .args([
            "--jsonl",
            "chat",
            "Find the synthetic queue-stall event and cite its exact seq and source.",
            "--new",
            "--trace",
            "full",
            "--trace-ack",
        ])
        .output()
        .expect("first linked turn");
    assert!(
        first.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&first.stdout),
        String::from_utf8_lossy(&first.stderr)
    );
    let first_lines = jsonl(&first.stdout);
    let session_id = assert_grounded_turn(&first_lines);

    let second = cli(&data_dir)
        .args([
            "--jsonl",
            "chat",
            "In that same incident, what configuration change happened immediately before it? Cite exact seq and source.",
            "--trace",
            "full",
            "--trace-ack",
        ])
        .output()
        .expect("second linked turn");
    assert!(
        second.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&second.stdout),
        String::from_utf8_lossy(&second.stderr)
    );
    let second_lines = jsonl(&second.stdout);
    assert_eq!(assert_grounded_turn(&second_lines), session_id);
    assert_eq!(counter.load(Ordering::SeqCst), 4);

    let session = cli(&data_dir)
        .args(["--json", "session", "show", &session_id])
        .output()
        .expect("show durable session");
    assert!(session.status.success());
    let transcript: Value = serde_json::from_slice(&session.stdout).unwrap();
    let messages = transcript["data"]["messages"].as_array().unwrap();
    assert!(messages.iter().any(|message| {
        message["role"] == "user"
            && message["content"]
                .as_str()
                .is_some_and(|text| text.contains("same incident"))
    }));
    assert!(messages.iter().any(|message| {
        message["role"] == "assistant"
            && message["content"]
                .as_str()
                .is_some_and(|text| text.contains("32 to 4"))
    }));

    let requests = server.received_requests().await.unwrap();
    assert_eq!(requests.len(), 4);
    let second_turn_request: Value = serde_json::from_slice(&requests[2].body).unwrap();
    let model_messages = second_turn_request["messages"].as_array().unwrap();
    assert!(model_messages.iter().any(|message| {
        message["role"] == "assistant"
            && message["content"]
                .as_str()
                .is_some_and(|text| text.contains("worker queue stalled"))
    }));
    assert_eq!(second_turn_request["stream"], true);
    assert!(second_turn_request["tools"].is_array());
}
