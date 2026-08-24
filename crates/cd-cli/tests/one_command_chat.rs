//! Public-process proofs for the top-level question shorthand.

use assert_cmd::Command;
use cd_core::config::AppConfig;
use cd_core::providers::{ProviderConfig, ProviderKind, ProviderProfile};
use serde_json::Value;
use tempfile::TempDir;
use wiremock::MockServer;

#[path = "helpers/app_config.rs"]
mod app_config;

fn isolated_command(data: &TempDir) -> Command {
    let mut command = Command::cargo_bin("contextdesk").expect("contextdesk binary");
    command.arg("--data-dir").arg(data.path());
    command
}

#[test]
fn direct_question_fails_early_with_actionable_active_corpus_guidance() {
    let data = TempDir::new().unwrap();
    let output = isolated_command(&data)
        .arg("What caused the outage?")
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(stderr.contains("no active corpus"), "{stderr}");
    assert!(stderr.contains("contextdesk import <path>"), "{stderr}");
    assert!(stderr.contains("contextdesk corpus use <id>"), "{stderr}");
    assert!(!stderr.contains('\u{1b}'));
}

#[test]
fn direct_question_jsonl_keeps_the_existing_closed_chat_stream_shape() {
    let data = TempDir::new().unwrap();
    let output = isolated_command(&data)
        .arg("--jsonl")
        .arg("What caused the outage?")
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stderr.is_empty());
    let lines = String::from_utf8(output.stdout).unwrap();
    let parsed = lines
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(parsed.len(), 2, "{lines}");
    assert_eq!(parsed[0]["type"], "error");
    assert_eq!(parsed[1]["type"], "done");
    assert_eq!(parsed[1]["ok"], false);
}

#[test]
fn explicit_chat_remains_unlinked_and_automation_compatible() {
    let data = TempDir::new().unwrap();
    let output = isolated_command(&data)
        .args(["chat", "hello", "--dry-run", "--jsonl"])
        .output()
        .unwrap();
    assert!(output.status.success());
    let stdout = String::from_utf8(output.stdout).unwrap();
    let final_line: Value = serde_json::from_str(stdout.lines().last().unwrap()).unwrap();
    assert_eq!(final_line["type"], "done");
    assert_eq!(final_line["ok"], true);
}

#[test]
fn direct_question_accepts_shell_split_words_and_utf8() {
    let data = TempDir::new().unwrap();
    let output = isolated_command(&data)
        .args(["原因は", "何ですか？"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(stderr.contains("no active corpus"), "{stderr}");
}

#[test]
fn end_of_options_allows_literal_and_hyphen_leading_questions() {
    for question in ["-why", "question"] {
        let data = TempDir::new().unwrap();
        let output = isolated_command(&data)
            .args(["--", question])
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(1));
        let stderr = String::from_utf8(output.stderr).unwrap();
        assert!(
            stderr.contains("no active corpus"),
            "question={question:?} {stderr}"
        );
        assert!(!stderr.contains("unexpected argument"), "{stderr}");
    }
}

#[tokio::test]
async fn blank_questions_close_each_output_contract_without_provider_calls() {
    let server = MockServer::start().await;
    let data = TempDir::new().unwrap();
    let app_config = data.path().join("configured-provider.json");

    let invalid_project = TempDir::new().unwrap();
    std::fs::write(
        invalid_project.path().join(".contextdesk.toml"),
        "this is not valid toml = [",
    )
    .unwrap();
    let before_project_config_load = isolated_command(&data)
        .current_dir(invalid_project.path())
        .args(["--json", "   "])
        .output()
        .unwrap();
    assert_eq!(before_project_config_load.status.code(), Some(1));
    assert!(before_project_config_load.stderr.is_empty());
    let envelope: Value = serde_json::from_slice(&before_project_config_load.stdout).unwrap();
    assert_eq!(envelope["ok"], false);
    assert!(envelope["error"]["message"]
        .as_str()
        .unwrap()
        .contains("question cannot be blank"));

    std::fs::write(&app_config, "not valid app config").unwrap();
    let before_config_load = isolated_command(&data)
        .args(["--app-config", app_config.to_str().unwrap(), "   "])
        .output()
        .unwrap();
    assert_eq!(before_config_load.status.code(), Some(1));
    assert!(String::from_utf8(before_config_load.stderr)
        .unwrap()
        .contains("question cannot be blank"));

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        std::fs::set_permissions(&app_config, std::fs::Permissions::from_mode(0o600)).unwrap();
    }

    let mut profile = ProviderProfile::ollama_local();
    profile.kind = ProviderKind::OpenAiCompatible;
    profile.base_url = server.uri();
    profile.local_only = true;
    profile.chat_model = "must-not-be-called".into();
    let cfg = AppConfig {
        providers: ProviderConfig {
            active_id: Some(profile.id.clone()),
            profiles: vec![profile],
        },
        ..AppConfig::default()
    };
    app_config::plant_app_config(&app_config, &cfg);

    let text = isolated_command(&data)
        .args(["--app-config", app_config.to_str().unwrap(), "   "])
        .output()
        .unwrap();
    assert_eq!(text.status.code(), Some(1));
    assert!(text.stdout.is_empty());
    assert!(String::from_utf8(text.stderr)
        .unwrap()
        .contains("question cannot be blank"));

    let json = isolated_command(&data)
        .args(["--app-config", app_config.to_str().unwrap(), "--json", ""])
        .output()
        .unwrap();
    assert_eq!(json.status.code(), Some(1));
    assert!(json.stderr.is_empty());
    let envelope: Value = serde_json::from_slice(&json.stdout).unwrap();
    assert_eq!(envelope["ok"], false);
    assert!(envelope["error"]["message"]
        .as_str()
        .unwrap()
        .contains("question cannot be blank"));

    let jsonl = isolated_command(&data)
        .args([
            "--app-config",
            app_config.to_str().unwrap(),
            "--jsonl",
            "\t",
        ])
        .output()
        .unwrap();
    assert_eq!(jsonl.status.code(), Some(1));
    assert!(jsonl.stderr.is_empty());
    let lines = String::from_utf8(jsonl.stdout).unwrap();
    let values = lines
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(values.len(), 2, "{lines}");
    assert_eq!(values[0]["type"], "error");
    assert_eq!(values[1]["type"], "done");
    assert_eq!(values[1]["ok"], false);

    assert!(server.received_requests().await.unwrap().is_empty());
}

#[test]
fn shorthand_and_explicit_chat_emit_equivalent_shared_workflow_semantics() {
    let data = TempDir::new().unwrap();
    let source = TempDir::new().unwrap();
    std::fs::write(
        source.path().join("service.log"),
        "2026-08-06T10:00:00Z ERROR checkout outage marker=req-7\n",
    )
    .unwrap();
    let imported = isolated_command(&data)
        .args(["--json", "import"])
        .arg(source.path())
        .output()
        .unwrap();
    assert!(
        imported.status.success(),
        "{}",
        String::from_utf8_lossy(&imported.stderr)
    );
    let import_envelope: Value = serde_json::from_slice(&imported.stdout).unwrap();
    let corpus_id = import_envelope["data"]["corpus_id"].as_str().unwrap();

    let implicit = isolated_command(&data)
        .args(["--jsonl", "What caused the outage?", "--new", "--dry-run"])
        .output()
        .unwrap();
    let explicit = isolated_command(&data)
        .args([
            "--jsonl",
            "chat",
            "What caused the outage?",
            "--corpus",
            corpus_id,
            "--new",
            "--dry-run",
        ])
        .output()
        .unwrap();
    assert!(
        implicit.status.success(),
        "{}",
        String::from_utf8_lossy(&implicit.stderr)
    );
    assert!(
        explicit.status.success(),
        "{}",
        String::from_utf8_lossy(&explicit.stderr)
    );

    fn semantics(bytes: &[u8]) -> Vec<Value> {
        String::from_utf8_lossy(bytes)
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .map(|line| match line["type"].as_str().unwrap() {
                "trace_summary" => serde_json::json!({
                    "type": "trace_summary",
                    "provider": line["provider_profile_id"],
                    "model": line["chat_model"],
                    "corpus": line["corpus_id"],
                    "dry_run": line["dry_run"],
                    "tools_offered": line["tools_offered"],
                    "tools_executed": line["tools_executed"],
                    "grounding": line["grounding"],
                    "context_used": line["context_used"],
                }),
                "context_used" => serde_json::json!({
                    "type": "context_used",
                    "summary": line["summary"],
                }),
                "done" => serde_json::json!({
                    "type": "done",
                    "ok": line["ok"],
                    "final_text": line["final_text"],
                }),
                other => serde_json::json!({"type": other}),
            })
            .collect()
    }

    assert_eq!(semantics(&implicit.stdout), semantics(&explicit.stdout));
}
