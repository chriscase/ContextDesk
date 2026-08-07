//! Hermetic CLI contract for `contextdesk retrieval-status` (no network:
//! probes are opt-in and never used here).

use assert_cmd::cargo::cargo_bin;
use assert_cmd::Command;
use std::fs;
use tempfile::TempDir;

fn bin() -> Command {
    Command::new(cargo_bin!("contextdesk"))
}

#[test]
fn retrieval_status_json_reports_unconfigured_roles_and_baseline_mode() {
    let tmp = TempDir::new().unwrap();
    let data = tmp.path().join("data");
    let out = bin()
        .args([
            "--data-dir",
            data.to_str().unwrap(),
            "--json",
            "retrieval-status",
        ])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let envelope: serde_json::Value = serde_json::from_slice(&out).unwrap();
    assert_eq!(envelope["ok"], true);
    assert_eq!(envelope["command"], "retrieval_status");
    let report = &envelope["data"]["report"];
    assert_eq!(report["schema_id"], "contextdesk.retrieval_status.v1");
    assert_eq!(report["mode_configured"], "structured_keyword");
    assert_eq!(report["probed"], false);
    let roles = report["roles"].as_array().unwrap();
    assert_eq!(roles.len(), 2);
    for role in roles {
        assert_eq!(role["state"], "unconfigured");
        assert!(role["endpoint_fingerprint"].is_null());
    }
}

#[test]
fn retrieval_status_reflects_configured_roles_without_probing_or_secrets() {
    let tmp = TempDir::new().unwrap();
    let data = tmp.path().join("data");
    fs::create_dir_all(&data).unwrap();

    // Configure both roles offline: model names are configuration examples.
    let seed = bin()
        .args([
            "--data-dir",
            data.to_str().unwrap(),
            "--json",
            "retrieval-status",
        ])
        .assert()
        .success();
    drop(seed);
    let config_path = data.join("config.json");
    let mut config: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&config_path).unwrap_or_else(|_| {
            // First run may not persist config; start from the CLI default.
            "{}".into()
        }))
        .unwrap_or_else(|_| serde_json::json!({}));
    if config.get("providers").is_none() {
        // Minimal valid config: reuse whatever default the CLI writes; if
        // none exists, build the smallest loadable shape.
        config = serde_json::json!({
            "providers": {
                "active_id": "ollama-local",
                "profiles": [{
                    "id": "ollama-local",
                    "label": "Ollama (local)",
                    "kind": "ollama",
                    "base_url": "http://127.0.0.1:11434",
                    "api_key_ref": null,
                    "chat_model": "llama3.2",
                    "embedding_model": "nomic-embed-text",
                    "embedding_base_url": null,
                    "capabilities": {"tools": false, "stream": true, "embeddings": true}
                }]
            },
            "setup_completed": true
        });
    }
    config["retrieval"] = serde_json::json!({
        "embedding": {
            "enabled": true,
            "base_url": "http://127.0.0.1:11434",
            "model": "bge-m3",
            "api_key_ref": null
        },
        "reranker": {
            "enabled": false,
            "base_url": "http://127.0.0.1:8080",
            "model": "qwen3-reranker-0.6b",
            "api_key_ref": null
        }
    });
    fs::write(&config_path, serde_json::to_vec_pretty(&config).unwrap()).unwrap();

    let out = bin()
        .args([
            "--data-dir",
            data.to_str().unwrap(),
            "--json",
            "retrieval-status",
        ])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let envelope: serde_json::Value = serde_json::from_slice(&out).unwrap();
    assert_eq!(envelope["ok"], true);
    let report = &envelope["data"]["report"];
    assert_eq!(report["mode_configured"], "hybrid_embedding");
    let roles = report["roles"].as_array().unwrap();
    let embedding = roles.iter().find(|r| r["role"] == "embedding").unwrap();
    assert_eq!(embedding["state"], "configured_unverified");
    assert_eq!(embedding["model"], "bge-m3");
    let fingerprint = embedding["endpoint_fingerprint"].as_str().unwrap();
    assert!(
        !fingerprint.contains("127.0.0.1"),
        "fingerprint never leaks the URL"
    );
    let reranker = roles.iter().find(|r| r["role"] == "reranker").unwrap();
    assert_eq!(reranker["state"], "disabled");
    assert_eq!(reranker["model"], "qwen3-reranker-0.6b");

    // Text rendering exists and never shows raw endpoints either.
    let text = bin()
        .args(["--data-dir", data.to_str().unwrap(), "retrieval-status"])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let text = String::from_utf8(text).unwrap();
    assert!(text.contains("Retrieval roles"));
    assert!(text.contains("configured_unverified"));
    assert!(
        !text.contains("127.0.0.1"),
        "text output never leaks endpoints"
    );
}
