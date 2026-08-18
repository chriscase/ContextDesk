//! Owner-only records may keep everything. Share-safe exports are an explicit
//! projection, gated by the real `scan_share_safe_text`.

mod common;

use cd_triage_bench::sha256_hex;
use cd_triage_bench_adapter::{
    project_share_safe, run_offline, AdapterError, AdapterRun, MockEnginePlan, MockTerminalPlan,
};
use cd_triage_sdk::{scan_share_safe_text, PacketPrivacyBoundary};

fn run(plan: &MockEnginePlan) -> AdapterRun {
    let case = common::case();
    let snapshot = common::snapshot();
    let task = common::task(&snapshot);
    run_offline(
        &case,
        &snapshot,
        &task,
        common::policy(),
        Default::default(),
        common::CANCELLATION_ID,
        plan,
        &common::context(),
    )
    .expect("offline run")
}

fn project(plan: &MockEnginePlan) -> (AdapterRun, String) {
    let snapshot = common::snapshot();
    let task = common::task(&snapshot);
    let run = run(plan);
    let projection = project_share_safe(&snapshot, &task, &run.recorded).expect("share-safe");
    assert_eq!(projection.privacy, PacketPrivacyBoundary::ShareSafe);
    let json = serde_json::to_string_pretty(&projection).unwrap();
    (run, json)
}

#[test]
fn share_safe_projection_passes_the_real_share_safe_scan() {
    for plan in [
        common::plan_complete(),
        common::plan_partial(),
        common::plan_failed(),
        common::plan_timed_out(),
        common::plan_cancelled(),
    ] {
        let (_, json) = project(&plan);
        let findings = scan_share_safe_text(&json);
        assert!(
            findings.is_empty(),
            "share-safe projection tripped the real scanner: {findings:?}"
        );
    }
}

#[test]
fn share_safe_projection_carries_no_model_identity() {
    let (run, json) = project(&common::plan_complete());

    for slot in &run.recorded.owner_only.slots {
        let model = slot.model.as_ref().expect("completed slot model");
        assert!(
            !json.contains(&model.profile_id),
            "share-safe export leaked gateway profile {}",
            model.profile_id
        );
        assert!(
            !json.contains(&model.model_id),
            "share-safe export leaked model id {}",
            model.model_id
        );
        // The fingerprint is what survives, not the identity.
        assert!(json.contains(
            slot.model_fingerprint
                .as_deref()
                .expect("completed slot model fingerprint")
        ));
        assert!(json.contains(&slot.slot_fingerprint));
        // Host-authored slot identities do not survive either.
        assert!(
            !json.contains(&format!("\"{}\"", slot.role_slot_id)),
            "share-safe export leaked slot identity {}",
            slot.role_slot_id
        );
    }
}

#[test]
fn share_safe_projection_carries_no_answer_and_no_raw_body() {
    let (run, json) = project(&common::plan_complete());
    let result = run.outcome.result().expect("result");
    let answer = result.answer.as_ref().expect("owner-only answer");

    for claim in answer
        .answer
        .candidates
        .iter()
        .flat_map(|candidate| candidate.claims.iter())
    {
        assert!(
            !json.contains(&claim.text),
            "share-safe export leaked answer claim text"
        );
    }
    for row in &answer.evidence {
        assert!(
            !json.contains(&row.content),
            "share-safe export leaked host evidence content"
        );
    }
    assert!(!json.contains("canonical_citations"));
    assert!(!json.contains("candidates"));
    assert!(!json.contains("semantic_attempts"));

    // Task text, evidence source references, and evidence digests stay out.
    assert!(!json.contains("What initiated the checkout failures"));
    assert!(!json.contains("app/checkout.log"));
    assert!(!json.contains("alerts mailbox"));
    let log_digest =
        sha256_hex(b"2026-01-15T04:12:00Z ERROR checkout upstream inventory timeout\n");
    assert!(
        !json.contains(&log_digest),
        "share-safe export leaked an evidence content digest"
    );

    // And the omissions are declared rather than silent.
    let projection = serde_json::from_str::<serde_json::Value>(&json).unwrap();
    assert_eq!(projection["answer_included"], serde_json::json!(false));
    assert_eq!(projection["raw_output_included"], serde_json::json!(false));
    assert_eq!(projection["usage"], serde_json::json!("unknown"));
    assert_eq!(projection["cost"], serde_json::json!("unknown"));
}

#[test]
fn share_safe_projection_never_carries_case_resolution() {
    let (_, json) = project(&common::plan_complete());
    for forbidden in [
        "inventory service connection pool exhaustion",
        "raise pool size",
        "this SKU service has failed this way before",
    ] {
        assert!(!json.contains(forbidden), "share-safe leaked {forbidden}");
    }
}

#[test]
fn owner_only_record_is_the_one_that_keeps_model_identity_and_the_answer() {
    let run = run(&common::plan_complete());
    let owner_json = String::from_utf8(run.recorded.raw_output.clone()).unwrap();

    assert!(owner_json.contains("gateway-alpha"));
    assert!(owner_json.contains("model-finalize"));
    assert!(owner_json.contains("canonical_citations"));
    assert!(owner_json.contains("What initiated the checkout failures"));
    assert_eq!(
        run.recorded.bench_run.privacy,
        cd_triage_bench::PrivacyClass::OwnerOnly
    );

    // A clean substring scan does not make a record share-safe. The boundary
    // is the explicit projection, not the scanner: the owner-only record
    // retains exactly the material the projection drops, so exporting it
    // directly would leak even when `scan_share_safe_text` finds nothing.
    let snapshot = common::snapshot();
    let task = common::task(&snapshot);
    let projection = project_share_safe(&snapshot, &task, &run.recorded).unwrap();
    let share_safe_json = serde_json::to_string(&projection).unwrap();
    for owner_only_material in ["gateway-alpha", "model-finalize", "canonical_citations"] {
        assert!(owner_json.contains(owner_only_material));
        assert!(
            !share_safe_json.contains(owner_only_material),
            "{owner_only_material} must not survive the projection"
        );
    }
}

#[test]
fn a_credential_shaped_failure_category_fails_the_projection_closed() {
    let mut plan = common::plan_failed();
    plan.terminal = MockTerminalPlan::Failed {
        // Passes the contract's opaque-id rules, but is credential-shaped.
        category: "bearer secret-value".into(),
        partial_result: false,
    };
    let snapshot = common::snapshot();
    let task = common::task(&snapshot);
    let run = run(&plan);
    let error = project_share_safe(&snapshot, &task, &run.recorded).unwrap_err();
    assert!(
        matches!(error, AdapterError::Privacy(_)),
        "expected a fail-closed privacy refusal, got {error:?}"
    );
    // Fail closed means refuse, not redact: the owner-only record is intact.
    assert_eq!(
        run.recorded.owner_only.terminal.category.as_deref(),
        Some("bearer secret-value")
    );
}

#[test]
fn bench_identities_are_projected_as_fingerprints_because_the_scanner_is_substring_based() {
    // `scan_share_safe_text` matches `sk-` anywhere, so a literal bench
    // `task-<hex>` identity is a false positive. The projection therefore
    // exports a task *fingerprint*. This is a real SDK-side wart, recorded
    // here so it is not rediscovered as a mystery.
    let snapshot = common::snapshot();
    let task = common::task(&snapshot);
    assert!(
        !scan_share_safe_text(&task.task_id).is_empty(),
        "expected the literal task id to trip the substring scanner"
    );

    let (_, json) = project(&common::plan_complete());
    assert!(!json.contains(&task.task_id));
    assert!(!json.contains(&snapshot.snapshot_id));
    let projection: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert!(projection["task_fingerprint"]
        .as_str()
        .unwrap()
        .starts_with("tkf-"));
    assert!(projection["snapshot_fingerprint"]
        .as_str()
        .unwrap()
        .starts_with("snf-"));
}

#[test]
fn share_safe_projection_preserves_fairness_and_every_fingerprint() {
    let (run, json) = project(&common::plan_complete());
    let projection: serde_json::Value = serde_json::from_str(&json).unwrap();
    let fingerprints = &run.recorded.owner_only.fingerprints;

    assert_eq!(projection["fairness"], serde_json::json!("same_snapshot"));
    assert_eq!(
        projection["source_kind"],
        serde_json::json!("contextdesk_sdk")
    );
    assert_eq!(
        projection["policy_fingerprint"],
        serde_json::json!(fingerprints.policy)
    );
    assert_eq!(
        projection["request_fingerprint"],
        serde_json::json!(fingerprints.request)
    );
    assert_eq!(
        projection["packet_fingerprint"],
        serde_json::json!(fingerprints.packet)
    );
    assert_eq!(
        projection["corpus_fingerprint"],
        serde_json::json!(fingerprints.corpus)
    );
    assert_eq!(
        projection["model_fingerprints"],
        serde_json::json!(fingerprints.models)
    );
    let slot_fingerprints: Vec<String> = projection["slots"]
        .as_array()
        .unwrap()
        .iter()
        .map(|slot| slot["slot_fingerprint"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(slot_fingerprints, fingerprints.slots);
}

#[test]
fn share_safe_golden_is_stable() {
    let snapshot = common::snapshot();
    let task = common::task(&snapshot);
    let complete = run(&common::plan_complete());
    let projection = project_share_safe(&snapshot, &task, &complete.recorded).unwrap();
    common::assert_golden(
        "share-safe.complete.json",
        &common::golden_json(&projection),
    );

    let failed = run(&common::plan_failed());
    let projection = project_share_safe(&snapshot, &task, &failed.recorded).unwrap();
    common::assert_golden("share-safe.failed.json", &common::golden_json(&projection));
}
