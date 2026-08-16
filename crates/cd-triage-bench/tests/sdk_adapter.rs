//! #879 public-SDK adapter acceptance: contracts, visibility, mock engine, privacy.

mod common;

use cd_triage_bench::sdk::{
    materialize_visible_packet, run_mock_task, MockTriageEngine, ModelRef, PublicTriageEngine,
    SdkPolicySelection, SdkRunRequest, SdkScriptedTerminal, SdkTerminal, VisibilityRequest,
    MOCK_GATEWAY_PROFILE, MOCK_MODEL_ID, TRIAGE_REPLAY_SCHEMA_V1, TRIAGE_REQUEST_SCHEMA_V2,
    TRIAGE_RESULT_SCHEMA_V2, TRIAGE_SHARE_SAFE_RESULT_SCHEMA_V2,
};
use cd_triage_bench::types::{Observed, PrivacyClass, RunStatus, SourceKind, VisibilityPolicy};
use common::*;
use serde::Deserialize;
use std::fs;
use std::path::Path;

#[derive(Debug, Deserialize)]
struct ScriptFixture {
    schema_id: String,
    script: String,
    terminal: String,
    run_status: String,
    result_kind: String,
    validation_state: String,
    reason_code: String,
    share_safe_schema_id: String,
    replay_schema_id: String,
}

fn fixture(name: &str) -> ScriptFixture {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("fixtures/sdk")
        .join(name);
    let text = fs::read_to_string(&path).unwrap_or_else(|err| panic!("{path:?}: {err}"));
    serde_json::from_str(&text).unwrap()
}

fn script_from_fixture(name: &str) -> (ScriptFixture, SdkScriptedTerminal) {
    let fx = fixture(name);
    let script = match fx.script.as_str() {
        "completed" => SdkScriptedTerminal::Completed,
        "failed" => SdkScriptedTerminal::Failed,
        "partial" => SdkScriptedTerminal::Partial,
        "timed_out" => SdkScriptedTerminal::TimedOut,
        "cancelled" => SdkScriptedTerminal::Cancelled,
        other => panic!("unknown fixture script {other}"),
    };
    (fx, script)
}

fn seeded_store(root: &Path) -> (cd_triage_bench::BenchStore, String) {
    let store = init_store(root);
    let case = resolved_case();
    store.put_case(&case).unwrap();
    let snapshot = snapshot_for(&store, &case.case_id);
    let task = task_for(&store, &snapshot);
    (store, task.task_id)
}

#[test]
fn public_contract_schema_ids_are_pinned() {
    assert_eq!(TRIAGE_REQUEST_SCHEMA_V2, "contextdesk.triage.request.v2");
    assert_eq!(TRIAGE_RESULT_SCHEMA_V2, "contextdesk.triage.result.v2");
    assert_eq!(
        TRIAGE_SHARE_SAFE_RESULT_SCHEMA_V2,
        "contextdesk.triage.result_share_safe.v2"
    );
    assert_eq!(TRIAGE_REPLAY_SCHEMA_V1, "contextdesk.triage.replay.v1");
}

#[test]
fn crate_source_depends_on_public_contracts_only() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let manifest = fs::read_to_string(root.join("Cargo.toml")).unwrap();
    for forbidden in [
        "cd-core",
        "cd_core",
        "cd-workflow",
        "cd-cli",
        "tauri",
        "keyring",
        "reqwest",
        "tokio",
    ] {
        assert!(
            !manifest.contains(forbidden),
            "bench Cargo.toml must not depend on {forbidden}"
        );
    }

    let mut rust_files = Vec::new();
    collect_rs(root.join("src"), &mut rust_files);
    assert!(
        rust_files
            .iter()
            .any(|path| path.ends_with("sdk.rs") || path.to_string_lossy().contains("/sdk/")),
        "expected sdk adapter sources"
    );
    for path in rust_files {
        let text = fs::read_to_string(&path).unwrap();
        for line in text.lines() {
            let trimmed = line.trim_start();
            if trimmed.starts_with("//") || trimmed.starts_with("//!") || trimmed.starts_with('*') {
                continue;
            }
            assert!(
                !trimmed.contains("use cd_core")
                    && !trimmed.contains("cd_core::")
                    && !trimmed.contains("use cd_workflow")
                    && !trimmed.contains("cd_workflow::"),
                "{} imports a ContextDesk internal crate",
                path.display()
            );
        }
    }
}

#[test]
fn adapter_does_not_add_incident_management_to_contextdesk_crates() {
    let bench = Path::new(env!("CARGO_MANIFEST_DIR"));
    let workspace = bench.join("../..");
    for forbidden in [
        "crates/cd-core/src/triage_bench.rs",
        "crates/cd-core/src/triage_bench",
        "crates/cd-cli/src/triage_bench.rs",
        "desktop/src-tauri/src/triage_bench.rs",
    ] {
        assert!(
            !workspace.join(forbidden).exists(),
            "ContextDesk crate unexpectedly grew incident-management storage at {forbidden}"
        );
    }

    let sdk_dir = bench.join("src/sdk");
    for entry in fs::read_dir(&sdk_dir).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().and_then(|e| e.to_str()) != Some("rs") {
            continue;
        }
        let text = fs::read_to_string(&path).unwrap();
        for needle in [
            "write_qualification",
            "write_readiness",
            "write_routing",
            "keychain_store",
            "put_adjudication",
            "put_score",
        ] {
            assert!(
                !text.contains(needle),
                "{} must not write ContextDesk qualification/readiness/routing or bench scores ({needle})",
                path.display()
            );
        }
    }
}

#[test]
fn snapshot_to_packet_to_mock_engine_to_recorded_run() {
    let dir = tempfile::tempdir().unwrap();
    let (store, task_id) = seeded_store(dir.path());
    let stored = run_mock_task(
        &store,
        SdkRunRequest::mock(&task_id, SdkScriptedTerminal::Completed),
    )
    .unwrap();
    assert!(!stored.duplicate);
    let run = store.get_run(&stored.run_id).unwrap();
    assert_eq!(run.source_kind, SourceKind::ContextdeskSdk);
    assert_eq!(run.status, RunStatus::Completed);
    assert_eq!(
        run.fairness,
        cd_triage_bench::types::FairnessClass::SameSnapshot
    );
    assert!(matches!(run.cost, Observed::Unknown));
    assert!(matches!(run.timing, Observed::Unknown));
    assert_eq!(stored.outcome.terminal, SdkTerminal::Completed);
    assert_eq!(
        stored.outcome.share_safe_result.schema_id,
        TRIAGE_SHARE_SAFE_RESULT_SCHEMA_V2
    );
    assert_eq!(
        stored.outcome.models[0],
        ModelRef {
            profile_id: MOCK_GATEWAY_PROFILE.into(),
            model_id: MOCK_MODEL_ID.into(),
        }
    );
    assert!(!stored.outcome.policy_fingerprint.is_empty());
    assert_eq!(stored.outcome.packet_fingerprint, stored.outcome.packet_id);
    assert_eq!(stored.outcome.corpus_fingerprint, run.snapshot_id);
    assert_eq!(stored.outcome.slots.len(), 1);
    MockTriageEngine.replay(&stored.outcome).unwrap();
    MockTriageEngine.evaluate(&stored.outcome).unwrap();
}

#[test]
fn visibility_widening_fails_closed() {
    let dir = tempfile::tempdir().unwrap();
    let (store, task_id) = seeded_store(dir.path());
    let task = store.get_task(&task_id).unwrap();
    let case = store.get_case(&task.case_id).unwrap();
    let snapshot = store.get_snapshot(&task.snapshot_id).unwrap();
    let requested = vec!["ev-log-1".into(), "ev-not-visible".into()];
    let err = materialize_visible_packet(
        &case,
        &snapshot,
        &task,
        VisibilityRequest {
            requested_item_ids: Some(&requested),
        },
    )
    .unwrap_err();
    assert!(
        err.to_string().contains("visibility widening rejected"),
        "{err}"
    );

    let mut request = SdkRunRequest::mock(&task_id, SdkScriptedTerminal::Completed);
    request.requested_item_ids = Some(&requested);
    let err = run_mock_task(&store, request).unwrap_err();
    assert!(
        err.to_string().contains("visibility widening rejected"),
        "{err}"
    );
}

#[test]
fn packet_does_not_include_items_outside_visibility() {
    let dir = tempfile::tempdir().unwrap();
    let store = init_store(dir.path());
    store.put_case(&resolved_case()).unwrap();
    let snapshot = snapshot_for(&store, "case-checkout-cascade");
    let task = cd_triage_bench::types::EvaluationTask::from_parts(
        PrivacyClass::ShareSafe,
        snapshot.case_id.clone(),
        snapshot.snapshot_id.clone(),
        "Narrow visibility".into(),
        "log only".into(),
        "v1".into(),
        VisibilityPolicy {
            visible_item_ids: vec!["ev-log-1".into()],
            include_summaries: false,
            include_raw_bytes: true,
        },
        None,
        "2026-01-15T07:00:00Z".into(),
    )
    .unwrap();
    store.put_task(&task).unwrap();
    let packet = materialize_visible_packet(
        &store.get_case(&task.case_id).unwrap(),
        &snapshot,
        &task,
        VisibilityRequest::default(),
    )
    .unwrap();
    let ids: Vec<_> = packet
        .evidence
        .iter()
        .map(|item| item.item_id.as_str())
        .collect();
    assert_eq!(ids, vec!["ev-log-1"]);
    assert!(!ids.contains(&"ev-email-1"));
}

#[test]
fn scripted_terminals_match_fixtures_and_typed_run_status() {
    let dir = tempfile::tempdir().unwrap();
    let (store, task_id) = seeded_store(dir.path());
    for name in [
        "complete.json",
        "failed.json",
        "partial.json",
        "timed_out.json",
        "cancelled.json",
    ] {
        let (fx, script) = script_from_fixture(name);
        assert_eq!(
            fx.schema_id,
            "contextdesk.triage_bench.sdk_script_fixture.v1"
        );
        assert_eq!(fx.share_safe_schema_id, TRIAGE_SHARE_SAFE_RESULT_SCHEMA_V2);
        assert_eq!(fx.replay_schema_id, TRIAGE_REPLAY_SCHEMA_V1);
        let stored = run_mock_task(&store, SdkRunRequest::mock(&task_id, script)).unwrap();
        let run = store.get_run(&stored.run_id).unwrap();
        assert_eq!(stored.outcome.terminal.as_str(), fx.terminal, "{name}");
        assert_eq!(run.status.as_str(), fx.run_status, "{name}");
        assert_eq!(
            stored.outcome.share_safe_result.kind, fx.result_kind,
            "{name}"
        );
        assert_eq!(
            stored.outcome.share_safe_result.validation_state, fx.validation_state,
            "{name}"
        );
        assert!(
            stored
                .outcome
                .share_safe_result
                .reason_codes
                .iter()
                .any(|code| code == &fx.reason_code),
            "{name} missing {}",
            fx.reason_code
        );
        assert!(matches!(run.cost, Observed::Unknown), "{name}");
        assert_eq!(run.source_kind, SourceKind::ContextdeskSdk, "{name}");
    }
}

#[test]
fn preflight_rejection_is_a_recorded_failed_run() {
    let dir = tempfile::tempdir().unwrap();
    let (store, task_id) = seeded_store(dir.path());
    let stored = run_mock_task(
        &store,
        SdkRunRequest::mock(&task_id, SdkScriptedTerminal::PreflightRejected),
    )
    .unwrap();
    let run = store.get_run(&stored.run_id).unwrap();
    assert_eq!(run.status, RunStatus::Failed);
    assert_eq!(stored.outcome.terminal, SdkTerminal::Failed);
    assert!(stored
        .outcome
        .share_safe_result
        .reason_codes
        .iter()
        .any(|code| code == "preflight_rejected"));
}

#[test]
fn recorded_run_passes_share_safe_privacy_scan() {
    let dir = tempfile::tempdir().unwrap();
    let (store, task_id) = seeded_store(dir.path());
    let stored = run_mock_task(
        &store,
        SdkRunRequest::mock(&task_id, SdkScriptedTerminal::Completed),
    )
    .unwrap();
    let run_json = serde_json::to_string(&store.get_run(&stored.run_id).unwrap()).unwrap();
    cd_triage_bench::privacy::gate_share_safe_text(&run_json).unwrap();
    let outcome_json = serde_json::to_string(&stored.outcome).unwrap();
    cd_triage_bench::privacy::gate_share_safe_text(&outcome_json).unwrap();
    let lowered = outcome_json.to_ascii_lowercase();
    assert!(!lowered.contains("/users/"));
    assert!(!lowered.contains("bearer "));
    assert!(!lowered.contains("authorization:"));
}

#[test]
fn policy_is_standard_with_gateway_scoped_model_ref() {
    let policy = SdkPolicySelection::mock_standard();
    match &policy {
        SdkPolicySelection::Standard { model } => {
            model.validate().unwrap();
            assert_eq!(model.profile_id, MOCK_GATEWAY_PROFILE);
            assert_eq!(model.model_id, MOCK_MODEL_ID);
        }
    }
    let fingerprint = policy.fingerprint().unwrap();
    assert!(fingerprint.starts_with("policy-"));
}

fn collect_rs(dir: std::path::PathBuf, out: &mut Vec<std::path::PathBuf>) {
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(_) => return,
    };
    for entry in entries {
        let path = entry.unwrap().path();
        if path.is_dir() {
            collect_rs(path, out);
        } else if path.extension().and_then(|e| e.to_str()) == Some("rs") {
            out.push(path);
        }
    }
}
