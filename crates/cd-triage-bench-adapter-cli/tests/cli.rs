use assert_cmd::Command;
use cd_triage_bench::types::{
    Case, CaseLifecycle, ContentDigest, EvaluationTask, EvidenceItem, EvidenceSnapshot,
    EvidenceSource, HeldContent, PrivacyClass, ReportedProblem, VisibilityPolicy, CASE_SCHEMA_V1,
};
use cd_triage_bench::{BenchStore, SourceKind};

fn seed_store(root: &std::path::Path) -> (BenchStore, EvaluationTask) {
    let store = BenchStore::init(root, "2026-01-15T00:00:00Z").unwrap();
    let case = Case {
        schema_id: CASE_SCHEMA_V1.into(),
        case_id: "case-cli-fixture".into(),
        privacy: PrivacyClass::OwnerOnly,
        title: "Synthetic CLI case".into(),
        reported_problem: ReportedProblem {
            summary: "checkout timeout".into(),
            reported_at: None,
            reporter: None,
            symptoms: vec!["timeout".into()],
        },
        lifecycle: CaseLifecycle::Unresolved,
        timeline_notes: vec![],
        created_at: "2026-01-15T00:00:00Z".into(),
        resolution: None,
    };
    store.put_case(&case).unwrap();
    let bytes = b"synthetic timeout\n";
    store.put_blob(bytes).unwrap();
    let snapshot = EvidenceSnapshot::from_parts(
        PrivacyClass::OwnerOnly,
        case.case_id.clone(),
        "2026-01-15T06:00:00Z".into(),
        "fixture".into(),
        vec![EvidenceItem::Log {
            item_id: "ev-log-1".into(),
            privacy: PrivacyClass::OwnerOnly,
            capture_time: "2026-01-15T04:12:00Z".into(),
            source: EvidenceSource {
                reference: "app.log".into(),
                captured_from: "fixture".into(),
            },
            media_type: "text/plain".into(),
            format: "raw".into(),
            content: HeldContent {
                digest: ContentDigest::of_bytes(bytes),
                byte_length: bytes.len() as u64,
            },
            summaries: vec![],
            visible_to_strategies: true,
        }],
        None,
    )
    .unwrap();
    store.put_snapshot(&snapshot).unwrap();
    let task = EvaluationTask::from_parts(
        PrivacyClass::OwnerOnly,
        case.case_id,
        snapshot.snapshot_id,
        "What failed?".into(),
        "Use visible evidence only.".into(),
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
    (store, task)
}

#[test]
fn run_command_persists_only_a_valid_bench_run() {
    let directory = tempfile::tempdir().unwrap();
    let (store, task) = seed_store(directory.path());
    let output = Command::cargo_bin("cd-triage-bench-adapter")
        .unwrap()
        .args([
            "--library",
            directory.path().to_str().unwrap(),
            "run",
            &task.task_id,
            "--script",
            "failed",
            "--operator",
            "cli-test",
            "--created-at",
            "2026-01-15T08:00:00Z",
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("status=failed"));

    let run_ids = store.list_runs().unwrap();
    assert_eq!(run_ids.len(), 1);
    let run = store.get_run(&run_ids[0]).unwrap();
    assert_eq!(run.source_kind, SourceKind::ContextdeskSdk);
    assert_eq!(run.status, cd_triage_bench::RunStatus::Failed);
    assert_eq!(run.privacy, PrivacyClass::OwnerOnly);
    assert!(store.get_blob(&run.raw_output.digest.hex).is_ok());
}
