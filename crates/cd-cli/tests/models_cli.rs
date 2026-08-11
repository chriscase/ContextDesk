//! Hermetic CLI contract for `contextdesk models`.
//!
//! The command must remain offline and credential-free: it reads only the
//! explicit data directory's AppConfig and secret-free qualification file.

use assert_cmd::Command;
use cd_core::capability_qualification::{
    qualification_store_path, save_qualification_store, CapabilityCheckResult, CapabilityKind,
    CapabilityStatus, QualificationKey, QualificationReport, QualificationStore,
};
use cd_core::config::{save_config, AppConfig};
use cd_core::providers::{
    ProviderCapabilities, ProviderConfig, ProviderDeadlinePreference, ProviderKind, ProviderProfile,
};

fn configured_gateway() -> (AppConfig, ProviderProfile) {
    let profile = ProviderProfile {
        id: "employer".into(),
        kind: ProviderKind::OpenAiCompatible,
        label: "Employer Gateway".into(),
        base_url: "https://gateway.invalid/v1".into(),
        chat_model: "deepseek-v4-flash".into(),
        api_key_ref: Some("contextdesk.provider.employer.api_key".into()),
        embedding_model: None,
        embedding_base_url: None,
        local_only: false,
        capabilities: ProviderCapabilities {
            tools: true,
            stream: true,
            embeddings: true,
        },
        deadline_preference: ProviderDeadlinePreference::Auto,
    };
    let cfg = AppConfig {
        providers: ProviderConfig {
            active_id: Some(profile.id.clone()),
            profiles: vec![profile.clone()],
        },
        default_chat_model: Some(profile.chat_model.clone()),
        ..AppConfig::default()
    };
    (cfg, profile)
}

#[test]
fn models_reports_persisted_verification_without_network_or_credentials() {
    let data = tempfile::tempdir().unwrap();
    let (cfg, profile) = configured_gateway();
    save_config(&data.path().join("config.json"), &cfg).unwrap();

    let key = QualificationKey::new(&profile.id, &profile.base_url, &profile.chat_model);
    let checks = [
        CapabilityKind::BasicGeneration,
        CapabilityKind::NativeToolCall,
        CapabilityKind::ToolResultContinuation,
        CapabilityKind::StructuredOutput,
    ]
    .into_iter()
    .map(|kind| CapabilityCheckResult {
        kind,
        status: CapabilityStatus::Pass,
        elapsed_ms: 1,
        tested_at: 100,
        reason: "synthetic pass".into(),
        request_mode: kind.expected_request_mode().map(str::to_string),
        dialect: Some("openai_compatible".into()),
        schema_strict: None,
        schema_probe_id: None,
    })
    .collect();
    let mut store = QualificationStore::default();
    store.put(QualificationReport {
        key,
        checks,
        role_hint: "chat".into(),
        cancelled: false,
        stale: false,
        finished_at: 100,
    });
    save_qualification_store(&qualification_store_path(data.path()), &store).unwrap();

    let output = Command::cargo_bin("contextdesk")
        .unwrap()
        .args([
            "--data-dir",
            data.path().to_str().unwrap(),
            "--json",
            "models",
        ])
        .output()
        .unwrap();
    assert!(output.status.success(), "{:?}", output);
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["command"], "models");
    assert_eq!(value["data"]["offline"], true);
    assert_eq!(value["data"]["credentials_read"], false);
    assert_eq!(value["data"]["models"][0]["model_id"], "deepseek-v4-flash");
    assert_eq!(value["data"]["models"][0]["readiness"]["state"], "verified");
    assert_eq!(value["data"]["models"][0]["readiness"]["role"], "chat");
}
