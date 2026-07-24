use super::*;
use cd_core::keychain_store::MemorySecretStore;

fn config() -> cd_core::s3_object_store::S3ObjectStoreConfig {
    let (access_key_ref, secret_key_ref, session_token_ref) = s3_keychain_refs().unwrap();
    cd_core::s3_object_store::S3ObjectStoreConfig {
        enabled: true,
        endpoint: "https://storage.example.com".into(),
        region: "us-east-1".into(),
        bucket: "backup".into(),
        prefix: "team".into(),
        path_style: true,
        allow_private_network: false,
        access_key_ref,
        secret_key_ref,
        session_token_ref: Some(session_token_ref),
    }
}

#[test]
fn s3_settings_ipc_rejects_credential_fields() {
    let raw = serde_json::json!({
        "enabled": true,
        "endpoint": "https://storage.example.com",
        "region": "us-east-1",
        "bucket": "backup",
        "prefix": "team",
        "path_style": true,
        "allow_private_network": false,
        "access_key": "AKIA_TEST_SHOULD_NOT_CROSS_IPC",
        "secret_key": "raw-secret"
    });
    assert!(serde_json::from_value::<SaveS3BackupSettings>(raw).is_err());
}

#[test]
fn restart_roundtrip_persists_refs_not_credentials() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("config.json");
    let app = AppConfig {
        s3_backup: Some(config()),
        ..AppConfig::default()
    };
    save_config(&path, &app).unwrap();
    let text = std::fs::read_to_string(&path).unwrap();
    assert!(text.contains(S3_ACCESS_KEY_REF));
    assert!(text.contains(S3_SECRET_KEY_REF));
    assert!(!text.contains("AKIA_RUNTIME_ONLY"));
    assert!(!text.contains("runtime-secret"));

    let loaded = load_config(&path).unwrap();
    let loaded = loaded.s3_backup.unwrap();
    let secrets = MemorySecretStore::new();
    secrets.set(S3_ACCESS_KEY_REF, "AKIA_RUNTIME_ONLY").unwrap();
    secrets.set(S3_SECRET_KEY_REF, "runtime-secret").unwrap();
    let credentials = resolve_s3_credentials(&secrets, &loaded).unwrap();
    let debug = format!("{credentials:?}");
    assert!(!debug.contains("AKIA_RUNTIME_ONLY"));
    assert!(!debug.contains("runtime-secret"));
}

#[test]
fn native_confirmation_text_contains_every_required_identity_and_estimate() {
    let summary = BackupPlanSummary {
        workspace_name: "Project".into(),
        roots: vec![
            PathBuf::from("/workspace/one"),
            PathBuf::from("/workspace/two"),
        ],
        destination: BackupDestination {
            endpoint_host: "storage.example.com".into(),
            bucket: "backup".into(),
            region: "us-east-1".into(),
            prefix: "team".into(),
        },
        dry_run: false,
        file_count: 3,
        bytes: 42,
        excluded_count: 2,
        excluded_bytes: 7,
        exclusions: Vec::new(),
    };
    let text = backup_confirmation_message(&summary);
    for expected in [
        "REAL UPLOAD",
        "Project",
        "/workspace/one",
        "/workspace/two",
        "storage.example.com",
        "backup",
        "us-east-1",
        "team",
        "content will leave this machine",
        "3 files (42 bytes)",
        "2 entries (7 known bytes)",
    ] {
        assert!(text.contains(expected), "missing {expected:?}: {text}");
    }
}

#[tokio::test]
async fn desktop_plan_seam_uses_core_planner_and_single_transport_prefix() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("safe.txt"), "safe").unwrap();
    let workspace = Workspace {
        id: "workspace".into(),
        name: "Project".into(),
        roots: vec![dir.path().to_path_buf()],
    };
    let mut local_config = config();
    local_config.endpoint = "http://127.0.0.1:9000".into();
    local_config.allow_private_network = true;
    let plan = plan_s3_workspace_backup(
        &workspace,
        &local_config,
        ".contextdesk",
        true,
        cd_core::object_store::ObjectCancellation::default(),
    )
    .await
    .unwrap();
    assert_eq!(plan.summary().destination.prefix, "team");
    assert_eq!(plan.summary().file_count, 1);
    assert!(plan
        .manifest_key()
        .as_str()
        .starts_with("contextdesk-backup/v1/workspaces/"));
}

#[test]
fn audit_fields_are_aggregate_and_contain_no_paths_or_credentials() {
    let summary = BackupRunSummary {
        status: BackupRunStatus::Completed,
        uploaded_files: 2,
        uploaded_bytes: 9,
        skipped_files: 1,
        skipped_bytes: 4,
        excluded_files: 1,
        excluded_bytes: 7,
        exclusion_reasons: Vec::new(),
        failed_files: 0,
        failed_bytes: 0,
        failure: None,
    };
    let (target, detail) = s3_backup_audit_fields(&config(), &summary).unwrap();
    let text = format!("{target}\n{detail}");
    assert!(text.contains("storage.example.com/backup"));
    for forbidden in [
        "/workspace/private",
        "safe.txt",
        "AKIA_RUNTIME_ONLY",
        "runtime-secret",
        "team",
    ] {
        assert!(!text.contains(forbidden));
    }
}

#[test]
fn dry_run_uses_no_remote_transport_and_needs_no_credentials() {
    let secrets = MemorySecretStore::new();
    assert!(build_backup_store(true, &secrets, &config()).is_ok());
    let real = match build_backup_store(false, &secrets, &config()) {
        Ok(_) => panic!("real backup must require credentials"),
        Err(error) => error,
    };
    assert!(real.contains("missing from the OS keychain"));
}
