//! CLI acceptance for #881 report-only comparison (offline, no SDK runner).

mod common;

use assert_cmd::Command;
use cd_triage_bench::privacy::scan_privacy_text;
use cd_triage_bench::types::*;
use cd_triage_bench::{import_run, ImportOutcome};
use common::*;

fn bench() -> Command {
    Command::cargo_bin("cd-triage-bench").expect("cd-triage-bench")
}

#[allow(clippy::too_many_arguments)]
fn import_status(
    store: &cd_triage_bench::BenchStore,
    task_id: &str,
    source_kind: SourceKind,
    name: &str,
    version: Observed<String>,
    raw: &str,
    fairness: FairnessClass,
    status: RunStatus,
    created_at: &str,
) -> String {
    let document = RunImport {
        schema_id: RUN_IMPORT_SCHEMA_V1.into(),
        task_id: task_id.into(),
        strategy: StrategyIdentity {
            name: name.into(),
            version,
            build: Observed::Unknown,
        },
        source_kind,
        prompt_workflow: PromptWorkflow {
            completeness: Completeness::Unknown,
            prompt: Observed::Unknown,
            workflow: Observed::Unknown,
        },
        raw_output_utf8: Some(raw.into()),
        claims: vec![],
        timing: Observed::Unknown,
        cost: Observed::Unknown,
        uncertainty: Observed::Unknown,
        fairness,
        status,
        operator: "operator-a".into(),
        importer: Some("importer-b".into()),
        privacy: PrivacyClass::ShareSafe,
        created_at: created_at.into(),
    };
    match import_run(store, &document, raw.as_bytes()).unwrap() {
        ImportOutcome::Created { run_id, .. } | ImportOutcome::Duplicate { run_id } => run_id,
    }
}

#[allow(clippy::too_many_arguments)]
fn adjudicate(
    store: &cd_triage_bench::BenchStore,
    run_id: &str,
    reviewer: &str,
    created_at: &str,
    diagnosis: DimensionVerdict,
    evidence: DimensionVerdict,
    action: DimensionVerdict,
    uncertainty: DimensionVerdict,
    unsafe_claims: DimensionVerdict,
) {
    let run = store.get_run(run_id).unwrap();
    let adj = Adjudication::from_parts(
        PrivacyClass::ShareSafe,
        run.case_id,
        run.task_id,
        run.snapshot_id,
        run.run_id,
        reviewer.into(),
        ConflictOfInterest {
            declared: false,
            notes: None,
        },
        RUBRIC_V1.into(),
        BlindingState::Blinded,
        outcomes(diagnosis, evidence, action, uncertainty, unsafe_claims),
        created_at.into(),
    )
    .unwrap();
    store.put_adjudication(&adj).unwrap();
}

#[test]
fn issue_881_report_only_acceptance() {
    let dir = tempfile::tempdir().unwrap();
    let store = init_store(dir.path());
    store.put_case(&resolved_case()).unwrap();
    let mut private = unresolved_case();
    private.title = "owner notes in /Users/alex/incidents/ticket.md".into();
    store.put_case(&private).unwrap();
    let snapshot = snapshot_for(&store, "case-checkout-cascade");
    let task = task_for(&store, &snapshot);

    let human = import_named(
        &store,
        &task.task_id,
        SourceKind::Human,
        "human-expert",
        Observed::Unknown,
        HUMAN_RAW,
        FairnessClass::SameSnapshot,
        RunStatus::Completed,
        "2026-01-15T08:00:00Z",
    );
    adjudicate(
        &store,
        &human,
        "reviewer-a",
        "2026-01-15T10:00:00Z",
        DimensionVerdict::Score { value: 3 },
        DimensionVerdict::Score { value: 3 },
        DimensionVerdict::Score { value: 2 },
        DimensionVerdict::Score { value: 2 },
        DimensionVerdict::Score { value: 3 },
    );

    let web_v1 = import_named(
        &store,
        &task.task_id,
        SourceKind::WebOnly,
        "web-assistant",
        Observed::Known("1.0".into()),
        WEB_RAW,
        FairnessClass::UnknownVisibility,
        RunStatus::Failed,
        "2026-01-15T08:05:00Z",
    );
    adjudicate(
        &store,
        &web_v1,
        "reviewer-a",
        "2026-01-15T10:10:00Z",
        DimensionVerdict::Score { value: 0 },
        DimensionVerdict::Score { value: 0 },
        DimensionVerdict::Score { value: 3 },
        DimensionVerdict::Score { value: 0 },
        DimensionVerdict::Score { value: 0 },
    );

    let web_v2 = import_named(
        &store,
        &task.task_id,
        SourceKind::WebOnly,
        "web-assistant",
        Observed::Known("2.0".into()),
        HUMAN_V2_RAW,
        FairnessClass::SameSnapshot,
        RunStatus::Completed,
        "2026-01-15T08:06:00Z",
    );
    adjudicate(
        &store,
        &web_v2,
        "reviewer-a",
        "2026-01-15T10:11:00Z",
        DimensionVerdict::Score { value: 3 },
        DimensionVerdict::Score { value: 2 },
        DimensionVerdict::Score { value: 1 },
        DimensionVerdict::Score { value: 1 },
        DimensionVerdict::Score { value: 2 },
    );

    let _partial = import_named(
        &store,
        &task.task_id,
        SourceKind::OtherProduct,
        "other-product",
        Observed::Known("9.1".into()),
        OTHER_RAW,
        FairnessClass::SameSnapshot,
        RunStatus::Partial,
        "2026-01-15T08:10:00Z",
    );
    let _unscored = import_status(
        &store,
        &task.task_id,
        SourceKind::Human,
        "second-human",
        Observed::Unknown,
        "No adjudication yet.\n",
        FairnessClass::SameSnapshot,
        RunStatus::Completed,
        "2026-01-15T08:20:00Z",
    );

    let mut items = four_kind_items();
    if let EvidenceItem::Log { capture_time, .. } = &mut items[2] {
        *capture_time = "2026-01-15T04:12:01Z".into();
    }
    store.put_blob(LOG_BYTES).unwrap();
    store.put_blob(EMAIL_BYTES).unwrap();
    store.put_blob(ATTACH_BYTES).unwrap();
    let snap_b = EvidenceSnapshot::from_parts(
        PrivacyClass::ShareSafe,
        "case-checkout-cascade".into(),
        "2026-01-15T06:00:01Z".into(),
        "fixture-operator".into(),
        items,
        None,
    )
    .unwrap();
    store.put_snapshot(&snap_b).unwrap();
    let task_b = EvaluationTask::from_parts(
        PrivacyClass::ShareSafe,
        snap_b.case_id.clone(),
        snap_b.snapshot_id.clone(),
        "What caused the checkout failures, and what should we do next?".into(),
        "Answer only from visible snapshot evidence. Do not invent a root cause.".into(),
        "v1".into(),
        VisibilityPolicy {
            visible_item_ids: vec!["ev-log-1".into()],
            include_summaries: true,
            include_raw_bytes: true,
        },
        None,
        "2026-01-15T07:00:01Z".into(),
    )
    .unwrap();
    store.put_task(&task_b).unwrap();
    let _other_snap = import_named(
        &store,
        &task_b.task_id,
        SourceKind::Human,
        "human-expert",
        Observed::Unknown,
        "different snapshot write-up",
        FairnessClass::SameSnapshot,
        RunStatus::Completed,
        "2026-01-15T08:40:00Z",
    );

    let private_task = EvaluationTask::from_parts(
        PrivacyClass::OwnerOnly,
        private.case_id.clone(),
        {
            store.put_blob(LOG_BYTES).unwrap();
            let snap = EvidenceSnapshot::from_parts(
                PrivacyClass::OwnerOnly,
                private.case_id.clone(),
                "2026-01-16T06:00:00Z".into(),
                "fixture-operator".into(),
                vec![EvidenceItem::Log {
                    item_id: "ev-log-u".into(),
                    privacy: PrivacyClass::OwnerOnly,
                    capture_time: "2026-01-16T04:12:00Z".into(),
                    source: EvidenceSource {
                        reference: "app.log".into(),
                        captured_from: "fixture".into(),
                    },
                    media_type: "text/plain".into(),
                    format: "raw".into(),
                    content: HeldContent {
                        digest: ContentDigest::of_bytes(LOG_BYTES),
                        byte_length: LOG_BYTES.len() as u64,
                    },
                    summaries: vec![],
                    visible_to_strategies: true,
                }],
                None,
            )
            .unwrap();
            store.put_snapshot(&snap).unwrap();
            snap.snapshot_id
        },
        "What is going on?".into(),
        "Do not invent a root cause.".into(),
        "v1".into(),
        VisibilityPolicy {
            visible_item_ids: vec!["ev-log-u".into()],
            include_summaries: false,
            include_raw_bytes: true,
        },
        None,
        "2026-01-16T07:00:00Z".into(),
    )
    .unwrap();
    store.put_task(&private_task).unwrap();
    let private_doc = RunImport {
        schema_id: RUN_IMPORT_SCHEMA_V1.into(),
        task_id: private_task.task_id,
        strategy: StrategyIdentity {
            name: "human-expert".into(),
            version: Observed::Unknown,
            build: Observed::Unknown,
        },
        source_kind: SourceKind::Human,
        prompt_workflow: PromptWorkflow {
            completeness: Completeness::Unknown,
            prompt: Observed::Unknown,
            workflow: Observed::Unknown,
        },
        raw_output_utf8: Some("private write-up".into()),
        claims: vec![],
        timing: Observed::Unknown,
        cost: Observed::Unknown,
        uncertainty: Observed::Unknown,
        fairness: FairnessClass::SameSnapshot,
        status: RunStatus::Partial,
        operator: "operator-a".into(),
        importer: None,
        privacy: PrivacyClass::OwnerOnly,
        created_at: "2026-01-16T08:00:00Z".into(),
    };
    import_run(&store, &private_doc, b"private write-up").unwrap();

    let library = dir.path().to_str().unwrap();
    let json1 = bench()
        .args(["--library", library, "report", "--format", "json"])
        .output()
        .unwrap();
    assert!(
        json1.status.success(),
        "{}",
        String::from_utf8_lossy(&json1.stderr)
    );
    let json2 = bench()
        .args(["--library", library, "report", "--format", "json"])
        .output()
        .unwrap();
    assert_eq!(json1.stdout, json2.stdout);

    let jsonl1 = bench()
        .args(["--library", library, "report", "--format", "jsonl"])
        .output()
        .unwrap();
    let jsonl2 = bench()
        .args(["--library", library, "report", "--format", "jsonl"])
        .output()
        .unwrap();
    assert_eq!(jsonl1.stdout, jsonl2.stdout);
    let jsonl = String::from_utf8(jsonl1.stdout).unwrap();
    assert!(jsonl.lines().count() > 3);
    assert!(jsonl.contains("\"type\":\"meta\""));
    assert!(jsonl.contains("\"type\":\"incomparable\""));
    assert!(jsonl.contains("\"type\":\"version_pair\""));

    let md = bench()
        .args(["--library", library, "report", "--format", "markdown"])
        .output()
        .unwrap();
    assert!(md.status.success());
    let md = String::from_utf8(md.stdout).unwrap();
    assert!(md.contains("## Counts"));
    assert!(md.contains("unscored"));
    assert!(md.contains("failed"));
    assert!(md.contains("partial"));
    assert!(md.contains("drill-down"));
    assert!(md.contains("incomparable") || md.contains("Incomparable"));
    assert!(md.contains("/Users/alex/incidents/ticket.md"));
    assert!(!md.to_ascii_lowercase().contains("ready"));
    assert!(!md.contains("leaderboard"));

    let owner: serde_json::Value = serde_json::from_slice(&json1.stdout).unwrap();
    assert!(owner["counts"]["unscored"].as_u64().unwrap() >= 1);
    assert!(owner["counts"]["failed"].as_u64().unwrap() >= 1);
    assert!(owner["counts"]["partial"].as_u64().unwrap() >= 1);
    assert!(owner["groups"].as_array().unwrap().iter().any(|g| {
        g["runs"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["status"] == "failed" || r["status"] == "partial" || r["scored"] == false)
    }));
    assert!(owner["incomparable"].as_array().unwrap().iter().any(|p| {
        p["reason"]
            .as_str()
            .unwrap()
            .contains("snapshot_or_task_mismatch")
    }));
    let pair = owner["version_pairs"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["strategy_name"] == "web-assistant")
        .expect("version pair");
    let changes: Vec<&str> = pair["dimensions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| d["change"].as_str().unwrap())
        .collect();
    assert!(changes.contains(&"improved"));
    assert!(changes.contains(&"regressed"));
    assert!(pair["case_id"].as_str().unwrap().starts_with("case-"));
    assert!(pair["older_run_id"].as_str().unwrap().starts_with("run-"));
    assert!(pair["newer_run_id"].as_str().unwrap().starts_with("run-"));
    assert!(!pair["older_adjudication_ids"]
        .as_array()
        .unwrap()
        .is_empty());
    assert!(owner["cases"].as_array().unwrap().iter().any(|c| c["title"]
        .as_str()
        .is_some_and(|t| t.contains("/Users/alex/incidents"))));

    let share = bench()
        .args([
            "--library",
            library,
            "report",
            "--format",
            "json",
            "--privacy",
            "share-safe",
        ])
        .output()
        .unwrap();
    assert!(
        share.status.success(),
        "{}",
        String::from_utf8_lossy(&share.stderr)
    );
    let share_text = String::from_utf8(share.stdout).unwrap();
    assert!(scan_privacy_text(&share_text).is_empty(), "{share_text}");
    assert!(!share_text.contains("/Users/"));
    assert!(!share_text.contains("SKU service"));
    assert!(!share_text.contains(std::str::from_utf8(LOG_BYTES).unwrap().trim()));
    let share_json: serde_json::Value = serde_json::from_str(&share_text).unwrap();
    assert!(share_json["cases"]
        .as_array()
        .unwrap()
        .iter()
        .all(|c| c.get("title").is_none() || c["title"].is_null()));
    assert!(!share_text.contains("diagnosis rationale") && !share_text.contains("\"rationale\""));

    assert!(!jsonl.contains("write_qualification"));
}
