//! Versioned schema fixtures for the six core bench entities (#877).
//!
//! Valid fixtures cover the documented import happy path that omits generated
//! ids. Invalid fixtures cover unknown-field rejection and content-addressed
//! identity mismatches.

use cd_triage_bench::types::{
    Adjudication, Case, EvaluationTask, EvidenceSnapshot, RunImport, ScoreReview, TriageRun,
};
use std::fs;
use std::path::PathBuf;

fn fixture(kind: &str, name: &str) -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("fixtures")
        .join(kind)
        .join(name);
    fs::read_to_string(&path).unwrap_or_else(|err| panic!("read {}: {err}", path.display()))
}

#[test]
fn valid_fixtures_parse_for_all_six_entities_when_generated_ids_are_omitted() {
    let case = Case::parse_json(&fixture("valid", "case.json")).unwrap();
    assert_eq!(case.case_id, "case-fixture-1");
    assert!(case.resolution.is_none());

    let snapshot = EvidenceSnapshot::parse_import_json(&fixture("valid", "snapshot.json")).unwrap();
    assert!(snapshot.snapshot_id.starts_with("snap-"));
    assert_eq!(snapshot.items.len(), 1);
    let stored = serde_json::to_string(&snapshot).unwrap();
    assert_eq!(EvidenceSnapshot::parse_json(&stored).unwrap(), snapshot);

    let task = EvaluationTask::parse_import_json(&fixture("valid", "task.json")).unwrap();
    assert!(task.task_id.starts_with("task-"));
    let stored = serde_json::to_string(&task).unwrap();
    assert_eq!(EvaluationTask::parse_json(&stored).unwrap(), task);

    let import = RunImport::parse_json(&fixture("valid", "run.json")).unwrap();
    assert!(import.raw_output_utf8.is_some());
    assert!(import.cost.is_unknown());
    assert!(import.timing.is_unknown());

    let adj = Adjudication::parse_import_json(&fixture("valid", "adjudication.json")).unwrap();
    assert!(adj.adjudication_id.starts_with("adj-"));
    let stored = serde_json::to_string(&adj).unwrap();
    assert_eq!(Adjudication::parse_json(&stored).unwrap(), adj);

    let score = ScoreReview::parse_import_json(&fixture("valid", "score.json")).unwrap();
    assert!(score.score_id.starts_with("score-"));
    let stored = serde_json::to_string(&score).unwrap();
    assert_eq!(ScoreReview::parse_json(&stored).unwrap(), score);
}

#[test]
fn unknown_field_fixtures_are_rejected_for_all_six_entities() {
    let cases = [
        (
            "case-unknown-field.json",
            Case::parse_json(&fixture("invalid", "case-unknown-field.json")).err(),
        ),
        (
            "snapshot-unknown-field.json",
            EvidenceSnapshot::parse_import_json(&fixture("invalid", "snapshot-unknown-field.json"))
                .err(),
        ),
        (
            "task-unknown-field.json",
            EvaluationTask::parse_import_json(&fixture("invalid", "task-unknown-field.json")).err(),
        ),
        (
            "run-unknown-field.json",
            RunImport::parse_json(&fixture("invalid", "run-unknown-field.json")).err(),
        ),
        (
            "adjudication-unknown-field.json",
            Adjudication::parse_import_json(&fixture("invalid", "adjudication-unknown-field.json"))
                .err(),
        ),
        (
            "score-unknown-field.json",
            ScoreReview::parse_import_json(&fixture("invalid", "score-unknown-field.json")).err(),
        ),
    ];
    for (name, err) in cases {
        let err = err.unwrap_or_else(|| panic!("{name} must be rejected"));
        assert!(err.to_string().contains("unknown field"), "{name}: {err}");
    }
}

#[test]
fn identity_mismatch_fixtures_are_rejected_for_content_addressed_records() {
    let snapshot_err =
        EvidenceSnapshot::parse_import_json(&fixture("invalid", "snapshot-identity-mismatch.json"))
            .unwrap_err();
    assert!(
        snapshot_err
            .to_string()
            .contains("snapshot_id does not match"),
        "{snapshot_err}"
    );

    let task_err =
        EvaluationTask::parse_import_json(&fixture("invalid", "task-identity-mismatch.json"))
            .unwrap_err();
    assert!(
        task_err.to_string().contains("task_id does not match"),
        "{task_err}"
    );

    let run_err =
        TriageRun::parse_json(&fixture("invalid", "run-identity-mismatch.json")).unwrap_err();
    assert!(
        run_err.to_string().contains("run_id does not match"),
        "{run_err}"
    );

    let adj_err =
        Adjudication::parse_import_json(&fixture("invalid", "adjudication-identity-mismatch.json"))
            .unwrap_err();
    assert!(
        adj_err
            .to_string()
            .contains("adjudication_id does not match"),
        "{adj_err}"
    );

    let score_err =
        ScoreReview::parse_import_json(&fixture("invalid", "score-identity-mismatch.json"))
            .unwrap_err();
    assert!(
        score_err.to_string().contains("score_id does not match"),
        "{score_err}"
    );
}
