//! End-to-end coverage for `cd-triage-bench agreement` (offline, no network).

use assert_cmd::Command;
use cd_triage_bench::{
    import_run, BenchStore, Case, CaseLifecycle, ClaimedCitation, Completeness, ContentDigest,
    EvaluationTask, EvidenceItem, EvidenceSnapshot, EvidenceSource, FairnessClass, HeldContent,
    Observed, PrivacyClass, PromptWorkflow, ReportedProblem, RunImport, RunStatus, SourceKind,
    StrategyIdentity, VisibilityPolicy, CASE_SCHEMA_V1, RUN_IMPORT_SCHEMA_V1,
};

const CREATED_AT: &str = "2026-01-15T08:00:00Z";
const LOG_BYTES: &[u8] = b"2026-01-15T04:12:00Z ERROR checkout failed: inventory timeout\n";

fn bench() -> Command {
    Command::cargo_bin("cd-triage-bench").expect("cd-triage-bench")
}

/// A share-safe library with one visible log item and two imported runs from
/// two distinct sources, both citing that item.
fn library(root: &std::path::Path) -> EvaluationTask {
    let store = BenchStore::init(root, CREATED_AT).expect("init");
    let case = Case {
        schema_id: CASE_SCHEMA_V1.into(),
        case_id: "case-agreement-cli".into(),
        privacy: PrivacyClass::ShareSafe,
        title: "Checkout outage".into(),
        reported_problem: ReportedProblem {
            summary: "checkout requests fail".into(),
            reported_at: None,
            reporter: None,
            symptoms: vec![],
        },
        lifecycle: CaseLifecycle::Unresolved,
        timeline_notes: vec![],
        created_at: CREATED_AT.into(),
        resolution: None,
    };
    store.put_case(&case).expect("case");
    store.put_blob(LOG_BYTES).expect("blob");

    let snapshot = EvidenceSnapshot::from_parts(
        PrivacyClass::ShareSafe,
        case.case_id.clone(),
        CREATED_AT.into(),
        "fixture-operator".into(),
        vec![EvidenceItem::Log {
            item_id: "ev-log-1".into(),
            privacy: PrivacyClass::ShareSafe,
            capture_time: CREATED_AT.into(),
            source: EvidenceSource {
                reference: "checkout.log".into(),
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
    .expect("snapshot");
    store.put_snapshot(&snapshot).expect("put snapshot");

    let task = EvaluationTask::from_parts(
        PrivacyClass::ShareSafe,
        case.case_id.clone(),
        snapshot.snapshot_id.clone(),
        "What caused the checkout failures?".into(),
        "Answer only from visible snapshot evidence.".into(),
        "v1".into(),
        VisibilityPolicy {
            visible_item_ids: vec!["ev-log-1".into()],
            include_summaries: false,
            include_raw_bytes: true,
        },
        None,
        CREATED_AT.into(),
    )
    .expect("task");
    store.put_task(&task).expect("put task");

    for (name, source_kind, raw) in [
        (
            "human-expert",
            SourceKind::Human,
            "The inventory client timed out; the 500 follows it.",
        ),
        (
            "other-product",
            SourceKind::OtherProduct,
            "Exported note: inventory timeout precedes the 500 response.",
        ),
    ] {
        let document = RunImport {
            schema_id: RUN_IMPORT_SCHEMA_V1.into(),
            task_id: task.task_id.clone(),
            strategy: StrategyIdentity {
                name: name.into(),
                version: Observed::Unknown,
                build: Observed::Unknown,
            },
            source_kind,
            prompt_workflow: PromptWorkflow {
                completeness: Completeness::Unknown,
                prompt: Observed::Unknown,
                workflow: Observed::Unknown,
            },
            raw_output_utf8: Some(raw.into()),
            claims: vec![ClaimedCitation {
                claim: "inventory client timeout".into(),
                evidence_item_id: Some("ev-log-1".into()),
                locator: Some("ERROR checkout failed".into()),
            }],
            timing: Observed::Unknown,
            cost: Observed::Unknown,
            uncertainty: Observed::Unknown,
            fairness: FairnessClass::SameSnapshot,
            status: RunStatus::Completed,
            operator: "fixture-operator".into(),
            importer: Some("fixture".into()),
            privacy: PrivacyClass::ShareSafe,
            created_at: CREATED_AT.into(),
        };
        import_run(&store, &document, raw.as_bytes()).expect("import");
    }

    task
}

#[test]
fn agreement_markdown_reports_independent_concurrence_without_ranking() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let root = tmp.path().join("lib");
    let task = library(&root);

    let output = bench()
        .args([
            "--library",
            root.to_str().expect("library path"),
            "agreement",
            "--format",
            "markdown",
            "--privacy",
            "owner-only",
        ])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let text = String::from_utf8(output).expect("utf-8");

    assert!(text.contains("# Triage bench evidence agreement"));
    assert!(text.contains(&task.task_id));
    assert!(text.contains("| `ev-log-1` | unknown | 2 | 2 | 0 | no | — |"));
    assert!(text.contains("Role conflicts: none"));
    assert!(text.contains("Visible evidence never cited: 0 of 1"));
    assert!(text.contains("Agreement is not correctness"));
    // No ranking vocabulary appears in the reported data. The honesty notes
    // deliberately use those words to deny them, so they are excluded here.
    let (data, notes) = text
        .split_once("### Honesty notes")
        .expect("rendered honesty notes");
    for forbidden in ["winner", "best", "score", "rank"] {
        assert!(
            !data.to_ascii_lowercase().contains(forbidden),
            "agreement data used ranking vocabulary {forbidden:?}"
        );
    }
    assert!(notes.contains("assigns no score, rank, readiness, or winner"));
}

#[test]
fn agreement_json_is_byte_stable_across_invocations() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let root = tmp.path().join("lib");
    library(&root);

    let run_once = || {
        let output = bench()
            .args([
                "--library",
                root.to_str().expect("library path"),
                "agreement",
                "--format",
                "json",
            ])
            .assert()
            .success()
            .get_output()
            .stdout
            .clone();
        String::from_utf8(output).expect("utf-8")
    };

    let first = run_once();
    assert_eq!(first, run_once());
    assert!(first.contains("\"anchors\""));
    assert!(first.contains("\"schema_id\": \"contextdesk.triage_bench.agreement_view.v1\""));
}

#[test]
fn share_safe_agreement_output_carries_no_owner_only_material() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let root = tmp.path().join("lib");
    let task = library(&root);

    let output = bench()
        .args([
            "--library",
            root.to_str().expect("library path"),
            "agreement",
            "--format",
            "json",
            "--privacy",
            "share-safe",
        ])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let text = String::from_utf8(output).expect("utf-8");

    assert!(text.contains("contextdesk.triage_bench.agreement_view_share_safe.v1"));
    for forbidden in [
        "ev-log-1",
        "human-expert",
        "other-product",
        "fixture-operator",
        "ERROR checkout failed",
        "inventory client timeout",
        "What caused the checkout failures?",
        task.task_id.as_str(),
        task.snapshot_id.as_str(),
    ] {
        assert!(
            !text.contains(forbidden),
            "share-safe agreement leaked {forbidden:?}"
        );
    }
    assert!(text.contains("\"distinct_source_count\": 2"));
    assert!(text.contains("\"independent\": false"));
}

/// `--task` narrows to one evaluation task without changing the projection.
#[test]
fn agreement_can_be_scoped_to_one_task() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let root = tmp.path().join("lib");
    let task = library(&root);

    bench()
        .args([
            "--library",
            root.to_str().expect("library path"),
            "agreement",
            "--format",
            "json",
            "--task",
            &task.task_id,
        ])
        .assert()
        .success();

    let output = bench()
        .args([
            "--library",
            root.to_str().expect("library path"),
            "agreement",
            "--format",
            "json",
            "--task",
            "task-does-not-exist",
        ])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let text = String::from_utf8(output).expect("utf-8");
    assert_eq!(text.trim(), "[]", "an unmatched task projects nothing");
}
