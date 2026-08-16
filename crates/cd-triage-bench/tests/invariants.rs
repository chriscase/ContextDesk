//! Library/store invariants for the headless triage bench (#877–#879 slice).

mod common;

use cd_triage_bench::report::{
    blinded_run_view, build_report, reject_cross_snapshot_rank, render_report_json,
};
use cd_triage_bench::types::*;
use cd_triage_bench::{import_run, materialize_task_packet, ImportOutcome};
use common::*;
use std::fs;

#[test]
fn crate_does_not_depend_on_cd_core_or_desktop() {
    let manifest = fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.toml")).unwrap();
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
}

#[test]
fn four_evidence_kinds_round_trip_and_summaries_do_not_replace_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let store = init_store(dir.path());
    store.put_case(&resolved_case()).unwrap();
    let snapshot = snapshot_for(&store, "case-checkout-cascade");
    assert_eq!(snapshot.items.len(), 4);
    let loaded = store.get_snapshot(&snapshot.snapshot_id).unwrap();
    assert_eq!(loaded, snapshot);
    let log = store
        .get_blob(&ContentDigest::of_bytes(LOG_BYTES).hex)
        .unwrap();
    assert_eq!(log, LOG_BYTES);
    let email_item = loaded.item("ev-email-1").unwrap();
    assert!(!email_item.summaries().is_empty());
    assert_eq!(
        email_item.held_content().unwrap().digest,
        ContentDigest::of_bytes(EMAIL_BYTES)
    );
}

#[test]
fn mutated_blob_fails_snapshot_verification() {
    let dir = tempfile::tempdir().unwrap();
    let store = init_store(dir.path());
    store.put_case(&resolved_case()).unwrap();
    let snapshot = snapshot_for(&store, "case-checkout-cascade");
    let hex = ContentDigest::of_bytes(LOG_BYTES).hex;
    let blob_path = store.root().join("blobs/sha256").join(&hex[..2]).join(&hex);
    fs::write(&blob_path, b"mutated-bytes").unwrap();
    let err = store.get_snapshot(&snapshot.snapshot_id).unwrap_err();
    assert!(err.to_string().contains("digest verification"), "{err}");
}

#[test]
fn task_packet_excludes_evaluation_only_resolution() {
    let dir = tempfile::tempdir().unwrap();
    let store = init_store(dir.path());
    let case = resolved_case();
    store.put_case(&case).unwrap();
    let snapshot = snapshot_for(&store, &case.case_id);
    let task = task_for(&store, &snapshot);
    let packet = materialize_task_packet(&case, &snapshot, &task).unwrap();
    let json = serde_json::to_string(&packet).unwrap();
    assert!(!json.contains("adjudicated_root_cause"));
    assert!(!json.contains("domain_expertise"));
    assert!(!json.contains("evaluation-only"));
    assert!(!json.contains("SKU service"));
    assert!(json.contains("ev-log-1"));
    assert!(json.contains("fileserver://archives/heap.bin"));
}

#[test]
fn unresolved_case_has_no_root_cause_and_stays_valid() {
    let dir = tempfile::tempdir().unwrap();
    let store = init_store(dir.path());
    let case = unresolved_case();
    store.put_case(&case).unwrap();
    let loaded = store.get_case(&case.case_id).unwrap();
    assert!(loaded.resolution.is_none());
    assert!(!loaded.diagnosis_is_applicable());
}

#[test]
fn unknown_cost_and_timing_survive_round_trip() {
    let dir = tempfile::tempdir().unwrap();
    let store = init_store(dir.path());
    store.put_case(&resolved_case()).unwrap();
    let snapshot = snapshot_for(&store, "case-checkout-cascade");
    let task = task_for(&store, &snapshot);
    let run_id = import_named(
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
    let run = store.get_run(&run_id).unwrap();
    assert!(run.cost.is_unknown());
    assert!(run.timing.is_unknown());
    assert!(run.strategy.version.is_unknown());
    assert_eq!(run.prompt_workflow.completeness, Completeness::Unknown);
    let json = serde_json::to_string(&run).unwrap();
    assert!(json.contains("\"status\":\"unknown\""));
    assert!(!json.contains("\"amount\":\"0\""));
}

#[test]
fn manual_import_preserves_raw_bytes_and_source_kinds() {
    let dir = tempfile::tempdir().unwrap();
    let store = init_store(dir.path());
    store.put_case(&resolved_case()).unwrap();
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
    let web = import_named(
        &store,
        &task.task_id,
        SourceKind::WebOnly,
        "web-assistant",
        Observed::Known("2026-01-15".into()),
        WEB_RAW,
        FairnessClass::UnknownVisibility,
        RunStatus::Completed,
        "2026-01-15T08:05:00Z",
    );
    let other = import_named(
        &store,
        &task.task_id,
        SourceKind::OtherProduct,
        "other-product",
        Observed::Known("1.0".into()),
        OTHER_RAW,
        FairnessClass::SameSnapshot,
        RunStatus::Partial,
        "2026-01-15T08:10:00Z",
    );
    let human_run = store.get_run(&human).unwrap();
    let web_run = store.get_run(&web).unwrap();
    let other_run = store.get_run(&other).unwrap();
    assert_eq!(human_run.source_kind, SourceKind::Human);
    assert_eq!(web_run.source_kind, SourceKind::WebOnly);
    assert_eq!(other_run.source_kind, SourceKind::OtherProduct);
    assert_eq!(
        store.get_blob(&human_run.raw_output.digest.hex).unwrap(),
        HUMAN_RAW.as_bytes()
    );
    assert_eq!(human_run.operator, "operator-a");
    assert_eq!(human_run.importer.as_deref(), Some("importer-b"));
    assert_eq!(other_run.status, RunStatus::Partial);
}

#[test]
fn identical_import_is_explicit_dedupe_and_near_duplicate_is_new() {
    let dir = tempfile::tempdir().unwrap();
    let store = init_store(dir.path());
    store.put_case(&resolved_case()).unwrap();
    let snapshot = snapshot_for(&store, "case-checkout-cascade");
    let task = task_for(&store, &snapshot);
    let first = import_named(
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
    let document = RunImport {
        schema_id: RUN_IMPORT_SCHEMA_V1.into(),
        task_id: task.task_id.clone(),
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
        raw_output_utf8: Some(HUMAN_RAW.into()),
        claims: vec![],
        timing: Observed::Unknown,
        cost: Observed::Unknown,
        uncertainty: Observed::Unknown,
        fairness: FairnessClass::SameSnapshot,
        status: RunStatus::Completed,
        operator: "operator-a".into(),
        importer: Some("importer-b".into()),
        privacy: PrivacyClass::ShareSafe,
        created_at: "2026-01-15T09:00:00Z".into(),
    };
    match import_run(&store, &document, HUMAN_RAW.as_bytes()).unwrap() {
        ImportOutcome::Duplicate { run_id } => assert_eq!(run_id, first),
        other => panic!("expected duplicate, got {other:?}"),
    }
    let near = import_named(
        &store,
        &task.task_id,
        SourceKind::Human,
        "human-expert",
        Observed::Unknown,
        HUMAN_RAW,
        FairnessClass::ExtraEvidence {
            description: "also looked at a later log file".into(),
        },
        RunStatus::Completed,
        "2026-01-15T09:30:00Z",
    );
    assert_ne!(near, first);
    assert_eq!(
        store.get_run(&near).unwrap().near_duplicate_of.as_deref(),
        Some(first.as_str())
    );
}

#[test]
fn fairness_class_is_required_and_immutable() {
    let dir = tempfile::tempdir().unwrap();
    let store = init_store(dir.path());
    store.put_case(&resolved_case()).unwrap();
    let snapshot = snapshot_for(&store, "case-checkout-cascade");
    let task = task_for(&store, &snapshot);
    let run_id = import_named(
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
    let mut run = store.get_run(&run_id).unwrap();
    run.fairness = FairnessClass::UnknownVisibility;
    let err = store.put_run(&run).unwrap_err();
    assert!(
        err.to_string().contains("immutable") || err.to_string().contains("fingerprint"),
        "{err}"
    );
}

#[test]
fn cross_snapshot_run_is_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let store = init_store(dir.path());
    store.put_case(&resolved_case()).unwrap();
    let snap_a = snapshot_for(&store, "case-checkout-cascade");
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
    let task_a = task_for(&store, &snap_a);
    let document = RunImport {
        schema_id: RUN_IMPORT_SCHEMA_V1.into(),
        task_id: task_a.task_id.clone(),
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
        raw_output_utf8: Some(HUMAN_RAW.into()),
        claims: vec![],
        timing: Observed::Unknown,
        cost: Observed::Unknown,
        uncertainty: Observed::Unknown,
        fairness: FairnessClass::SameSnapshot,
        status: RunStatus::Completed,
        operator: "op".into(),
        importer: None,
        privacy: PrivacyClass::ShareSafe,
        created_at: "2026-01-15T08:00:00Z".into(),
    };
    let outcome = import_run(&store, &document, HUMAN_RAW.as_bytes()).unwrap();
    let run_id = match outcome {
        ImportOutcome::Created { run_id, .. } | ImportOutcome::Duplicate { run_id } => run_id,
    };
    let mut run = store.get_run(&run_id).unwrap();
    run.snapshot_id = snap_b.snapshot_id.clone();
    let err = store.put_run(&run).unwrap_err();
    assert!(
        matches!(err, cd_triage_bench::BenchError::CrossSnapshot(_))
            || err.to_string().contains("fingerprint")
            || err.to_string().contains("immutable"),
        "{err}"
    );
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
    let run_b = import_named(
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
    let left = store.get_run(&run_id).unwrap();
    let right = store.get_run(&run_b).unwrap();
    assert!(reject_cross_snapshot_rank(&left, &right).is_err());
}

#[test]
fn unknown_fields_and_malformed_records_are_rejected() {
    let err = Case::parse_json(
        r#"{"schema_id":"contextdesk.triage_bench.case.v1","case_id":"c","title":"t","reported_problem":{"summary":"s"},"lifecycle":"open","created_at":"2026-01-15T00:00:00Z","nope":1}"#,
    )
    .unwrap_err();
    assert!(err.to_string().contains("unknown field"));
    let err = TriageRun::parse_json("{}").unwrap_err();
    assert!(err.to_string().contains("schema") || err.to_string().contains("missing"));
}

#[test]
fn adjudication_disagreement_and_unresolved_diagnosis_na() {
    let dir = tempfile::tempdir().unwrap();
    let store = init_store(dir.path());
    store.put_case(&resolved_case()).unwrap();
    store.put_case(&unresolved_case()).unwrap();
    let resolved_snap = snapshot_for(&store, "case-checkout-cascade");
    let resolved_task = task_for(&store, &resolved_snap);
    let human = import_named(
        &store,
        &resolved_task.task_id,
        SourceKind::Human,
        "human-expert",
        Observed::Unknown,
        HUMAN_RAW,
        FairnessClass::SameSnapshot,
        RunStatus::Completed,
        "2026-01-15T08:00:00Z",
    );
    let web = import_named(
        &store,
        &resolved_task.task_id,
        SourceKind::WebOnly,
        "web-assistant",
        Observed::Known("1.0".into()),
        WEB_RAW,
        FairnessClass::UnknownVisibility,
        RunStatus::Failed,
        "2026-01-15T08:05:00Z",
    );
    let web_v2 = import_named(
        &store,
        &resolved_task.task_id,
        SourceKind::WebOnly,
        "web-assistant",
        Observed::Known("2.0".into()),
        HUMAN_V2_RAW,
        FairnessClass::SameSnapshot,
        RunStatus::Completed,
        "2026-01-15T08:06:00Z",
    );
    let flags = citation_assist_flags(
        &snapshot_ids(&resolved_snap),
        &store.get_run(&web).unwrap().claims,
    );
    assert!(flags.iter().any(|f| f.contains("citation_not_in_snapshot")));

    let adj_a = Adjudication::from_parts(
        PrivacyClass::ShareSafe,
        "case-checkout-cascade".into(),
        resolved_task.task_id.clone(),
        resolved_snap.snapshot_id.clone(),
        human.clone(),
        "reviewer-a".into(),
        ConflictOfInterest {
            declared: false,
            notes: None,
        },
        RUBRIC_V1.into(),
        BlindingState::Blinded,
        outcomes(
            DimensionVerdict::Score { value: 3 },
            DimensionVerdict::Score { value: 3 },
            DimensionVerdict::Score { value: 2 },
            DimensionVerdict::Score { value: 2 },
            DimensionVerdict::Score { value: 3 },
        ),
        "2026-01-15T10:00:00Z".into(),
    )
    .unwrap();
    let adj_b = Adjudication::from_parts(
        PrivacyClass::ShareSafe,
        "case-checkout-cascade".into(),
        resolved_task.task_id.clone(),
        resolved_snap.snapshot_id.clone(),
        human.clone(),
        "reviewer-b".into(),
        ConflictOfInterest {
            declared: true,
            notes: Some("authored the human write-up".into()),
        },
        RUBRIC_V1.into(),
        BlindingState::Unblinded {
            reason: "distinctive first-person write-up".into(),
        },
        outcomes(
            DimensionVerdict::Score { value: 2 },
            DimensionVerdict::Score { value: 3 },
            DimensionVerdict::Score { value: 1 },
            DimensionVerdict::Score { value: 2 },
            DimensionVerdict::Score { value: 3 },
        ),
        "2026-01-15T10:05:00Z".into(),
    )
    .unwrap();
    store.put_adjudication(&adj_a).unwrap();
    store.put_adjudication(&adj_b).unwrap();

    let mut unsafe_outcomes = outcomes(
        DimensionVerdict::Score { value: 0 },
        DimensionVerdict::Score { value: 0 },
        DimensionVerdict::Score { value: 3 },
        DimensionVerdict::Score { value: 0 },
        DimensionVerdict::Score { value: 0 },
    );
    unsafe_outcomes[4].assist_flags = flags.clone();
    let adj_web = Adjudication::from_parts(
        PrivacyClass::ShareSafe,
        "case-checkout-cascade".into(),
        resolved_task.task_id.clone(),
        resolved_snap.snapshot_id.clone(),
        web.clone(),
        "reviewer-a".into(),
        ConflictOfInterest {
            declared: false,
            notes: None,
        },
        RUBRIC_V1.into(),
        BlindingState::Blinded,
        unsafe_outcomes,
        "2026-01-15T10:10:00Z".into(),
    )
    .unwrap();
    store.put_adjudication(&adj_web).unwrap();

    let adj_web_v2 = Adjudication::from_parts(
        PrivacyClass::ShareSafe,
        "case-checkout-cascade".into(),
        resolved_task.task_id.clone(),
        resolved_snap.snapshot_id.clone(),
        web_v2.clone(),
        "reviewer-a".into(),
        ConflictOfInterest {
            declared: false,
            notes: None,
        },
        RUBRIC_V1.into(),
        BlindingState::Blinded,
        outcomes(
            DimensionVerdict::Score { value: 3 },
            DimensionVerdict::Score { value: 2 },
            DimensionVerdict::Score { value: 1 },
            DimensionVerdict::Score { value: 1 },
            DimensionVerdict::Score { value: 2 },
        ),
        "2026-01-15T10:11:00Z".into(),
    )
    .unwrap();
    store.put_adjudication(&adj_web_v2).unwrap();

    let unresolved_snap = EvidenceSnapshot::from_parts(
        PrivacyClass::OwnerOnly,
        "case-open-question".into(),
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
    store.put_blob(LOG_BYTES).unwrap();
    store.put_snapshot(&unresolved_snap).unwrap();
    let unresolved_task = EvaluationTask::from_parts(
        PrivacyClass::OwnerOnly,
        "case-open-question".into(),
        unresolved_snap.snapshot_id.clone(),
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
    store.put_task(&unresolved_task).unwrap();
    let unresolved_run = import_named(
        &store,
        &unresolved_task.task_id,
        SourceKind::Human,
        "human-expert",
        Observed::Unknown,
        "Evidence shows errors; cause unknown.",
        FairnessClass::SameSnapshot,
        RunStatus::Partial,
        "2026-01-16T08:00:00Z",
    );
    let adj_unresolved = Adjudication::from_parts(
        PrivacyClass::OwnerOnly,
        "case-open-question".into(),
        unresolved_task.task_id.clone(),
        unresolved_snap.snapshot_id.clone(),
        unresolved_run,
        "reviewer-a".into(),
        ConflictOfInterest {
            declared: false,
            notes: None,
        },
        RUBRIC_V1.into(),
        BlindingState::Blinded,
        outcomes(
            DimensionVerdict::NotApplicable,
            DimensionVerdict::Score { value: 2 },
            DimensionVerdict::Score { value: 1 },
            DimensionVerdict::Score { value: 3 },
            DimensionVerdict::Score { value: 3 },
        ),
        "2026-01-16T10:00:00Z".into(),
    )
    .unwrap();
    store.put_adjudication(&adj_unresolved).unwrap();

    let v1_score = store
        .get_score(&adj_a.to_score_review().unwrap().score_id)
        .unwrap();
    let adj_v2 = Adjudication::from_parts(
        PrivacyClass::ShareSafe,
        "case-checkout-cascade".into(),
        resolved_task.task_id.clone(),
        resolved_snap.snapshot_id.clone(),
        human.clone(),
        "reviewer-a".into(),
        ConflictOfInterest {
            declared: false,
            notes: None,
        },
        "contextdesk.triage_bench.rubric.v2".into(),
        BlindingState::Blinded,
        outcomes(
            DimensionVerdict::Score { value: 1 },
            DimensionVerdict::Score { value: 1 },
            DimensionVerdict::Score { value: 1 },
            DimensionVerdict::Score { value: 1 },
            DimensionVerdict::Score { value: 1 },
        ),
        "2026-01-15T11:00:00Z".into(),
    )
    .unwrap();
    store.put_adjudication(&adj_v2).unwrap();
    let still_v1 = store.get_score(&v1_score.score_id).unwrap();
    assert_eq!(still_v1, v1_score);

    let blinded = blinded_run_view(&store.get_run(&human).unwrap());
    assert!(blinded.strategy_masked);
    assert!(blinded.unblindable_reason.is_none());

    let report = build_report(
        &store.load_runs().unwrap(),
        &store.load_adjudications().unwrap(),
        &store.load_scores().unwrap(),
        PrivacyClass::OwnerOnly,
    )
    .unwrap();
    let share_safe = build_report(
        &store.load_runs().unwrap(),
        &store.load_adjudications().unwrap(),
        &store.load_scores().unwrap(),
        PrivacyClass::ShareSafe,
    )
    .unwrap();
    let once = render_report_json(&report).unwrap();
    let twice = render_report_json(&report).unwrap();
    assert_eq!(once, twice);
    assert!(report.groups.iter().any(|g| g
        .runs
        .iter()
        .any(|r| !r.scored || matches!(r.status, RunStatus::Failed | RunStatus::Partial))));
    assert!(report
        .incomparable
        .iter()
        .any(|p| p.reason.contains("snapshot")
            || p.reason.contains("fairness")
            || p.reason.contains("mismatch")));
    let pair = report
        .version_pairs
        .iter()
        .find(|p| p.strategy_name == "web-assistant")
        .expect("version pair");
    assert!(pair.dimensions.iter().any(|d| d.change == "improved"));
    assert!(pair.dimensions.iter().any(|d| d.change == "regressed"));
    assert!(!once.to_ascii_lowercase().contains("ready"));
    assert!(!once.to_ascii_lowercase().contains("leaderboard"));
    let share_text = render_report_json(&share_safe).unwrap();
    assert!(!share_text.contains("/Users/"));
    assert!(!share_text.contains("SKU service"));
}
