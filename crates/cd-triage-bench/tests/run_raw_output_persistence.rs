mod common;

use cd_triage_bench::store::PutRunOutcome;
use cd_triage_bench::types::{
    ClaimedCitation, Completeness, ContentDigest, FairnessClass, Observed, PromptWorkflow,
    RawOutput, RunStatus, SourceKind, StrategyIdentity, TriageRun, RUN_SCHEMA_V2,
};
use cd_triage_bench::BenchStore;

const RAW_OUTPUT: &[u8] = b"Diagnosis: inventory timeout.\n";

fn prepared_store() -> (
    tempfile::TempDir,
    BenchStore,
    cd_triage_bench::EvaluationTask,
) {
    let dir = tempfile::tempdir().unwrap();
    let store = common::init_store(dir.path());
    let case = common::resolved_case();
    store.put_case(&case).unwrap();
    let snapshot = common::snapshot_for(&store, &case.case_id);
    let task = common::task_for(&store, &snapshot);
    (dir, store, task)
}

fn run_for(task: &cd_triage_bench::EvaluationTask, raw_output: &[u8]) -> TriageRun {
    let mut run = TriageRun {
        schema_id: RUN_SCHEMA_V2.into(),
        run_id: String::new(),
        privacy: task.privacy,
        case_id: task.case_id.clone(),
        task_id: task.task_id.clone(),
        snapshot_id: task.snapshot_id.clone(),
        strategy: StrategyIdentity {
            name: "persistence-test".into(),
            version: Observed::Known("v1".into()),
            build: Observed::Unknown,
        },
        source_kind: SourceKind::OtherProduct,
        prompt_workflow: PromptWorkflow {
            completeness: Completeness::Unknown,
            prompt: Observed::Unknown,
            workflow: Observed::Unknown,
        },
        raw_output: RawOutput {
            digest: ContentDigest::of_bytes(raw_output),
            byte_length: raw_output.len() as u64,
            encoding: "utf-8".into(),
        },
        claims: vec![ClaimedCitation {
            claim: "inventory timeout".into(),
            evidence_item_id: Some("ev-log-1".into()),
            locator: None,
        }],
        timing: Observed::Unknown,
        cost: Observed::Unknown,
        uncertainty: Observed::Unknown,
        fairness: FairnessClass::SameSnapshot,
        status: RunStatus::Completed,
        operator: "persistence-test".into(),
        importer: None,
        created_at: "2026-01-15T08:00:00Z".into(),
        near_duplicate_of: None,
    };
    run.run_id = format!("run-{}", run.fingerprint().unwrap());
    run
}

fn blob_path(store: &BenchStore, digest: &ContentDigest) -> std::path::PathBuf {
    store
        .root()
        .join("blobs/sha256")
        .join(&digest.hex[..2])
        .join(&digest.hex)
}

fn force_run_write_failure(store: &BenchStore, run: &TriageRun) {
    let temporary_path = store
        .root()
        .join("runs")
        .join(format!("{}.tmp", run.run_id));
    std::fs::create_dir(temporary_path).unwrap();
}

#[test]
fn mismatched_raw_output_writes_neither_blob_nor_run() {
    let (_dir, store, task) = prepared_store();
    let run = run_for(&task, RAW_OUTPUT);
    let same_length_different_bytes = b"Diagnosis: inventory timeouu.\n";

    let error = store
        .put_run_with_raw_output(&run, same_length_different_bytes)
        .unwrap_err();

    assert!(error.to_string().contains("digest does not match"));
    assert!(!error.to_string().contains("Diagnosis"));
    let error = store
        .put_run_with_raw_output(&run, b"too short")
        .unwrap_err();
    assert!(error.to_string().contains("byte length does not match"));
    assert!(!error.to_string().contains("too short"));
    assert!(!blob_path(&store, &run.raw_output.digest).exists());
    assert!(store.list_runs().unwrap().is_empty());
}

#[test]
fn missing_or_invalid_linkage_writes_no_blob() {
    let (_dir, store, task) = prepared_store();

    let mut missing_task = run_for(&task, RAW_OUTPUT);
    missing_task.task_id = "task-missing".into();
    missing_task.run_id = format!("run-{}", missing_task.fingerprint().unwrap());
    assert!(store
        .put_run_with_raw_output(&missing_task, RAW_OUTPUT)
        .is_err());
    assert!(!blob_path(&store, &missing_task.raw_output.digest).exists());

    let mut invalid_case = run_for(&task, RAW_OUTPUT);
    invalid_case.case_id = "case-wrong".into();
    invalid_case.run_id = format!("run-{}", invalid_case.fingerprint().unwrap());
    assert!(store
        .put_run_with_raw_output(&invalid_case, RAW_OUTPUT)
        .is_err());
    assert!(!blob_path(&store, &invalid_case.raw_output.digest).exists());
    assert!(store.list_runs().unwrap().is_empty());
}

#[test]
fn success_persists_run_and_raw_output() {
    let (_dir, store, task) = prepared_store();
    let run = run_for(&task, RAW_OUTPUT);

    let outcome = store.put_run_with_raw_output(&run, RAW_OUTPUT).unwrap();

    assert_eq!(
        outcome,
        PutRunOutcome::Created {
            run_id: run.run_id.clone()
        }
    );
    assert_eq!(store.get_run(&run.run_id).unwrap(), run);
    assert_eq!(
        store.get_blob(&run.raw_output.digest.hex).unwrap(),
        RAW_OUTPUT
    );
}

#[test]
fn deduplicated_blob_is_preserved_when_later_run_write_fails() {
    let (_dir, store, task) = prepared_store();
    let first_run = run_for(&task, RAW_OUTPUT);
    store
        .put_run_with_raw_output(&first_run, RAW_OUTPUT)
        .unwrap();

    let mut later_run = run_for(&task, RAW_OUTPUT);
    later_run.strategy.name = "later-persistence-test".into();
    later_run.run_id = format!("run-{}", later_run.fingerprint().unwrap());
    force_run_write_failure(&store, &later_run);

    assert!(store
        .put_run_with_raw_output(&later_run, RAW_OUTPUT)
        .is_err());

    assert_eq!(
        store.get_blob(&later_run.raw_output.digest.hex).unwrap(),
        RAW_OUTPUT
    );
    assert_eq!(store.get_run(&first_run.run_id).unwrap(), first_run);
    assert_eq!(store.list_runs().unwrap().len(), 1);
}

#[test]
fn newly_created_blob_is_rolled_back_when_run_write_fails() {
    let (_dir, store, task) = prepared_store();
    let run = run_for(&task, RAW_OUTPUT);
    force_run_write_failure(&store, &run);

    assert!(store.put_run_with_raw_output(&run, RAW_OUTPUT).is_err());

    assert!(!blob_path(&store, &run.raw_output.digest).exists());
    assert!(store.list_runs().unwrap().is_empty());
}
