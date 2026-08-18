//! Focused acceptance for explicit, deterministic comparison exclusions.

mod common;

use cd_triage_bench::report::{build_report, IncomparablePair};
use cd_triage_bench::types::*;
use common::*;
use std::collections::BTreeSet;

fn pair<'a>(pairs: &'a [IncomparablePair], left: &str, right: &str) -> &'a IncomparablePair {
    pairs
        .iter()
        .find(|pair| {
            (pair.left_run_id == left && pair.right_run_id == right)
                || (pair.left_run_id == right && pair.right_run_id == left)
        })
        .expect("pair has an explicit incomparable reason")
}

#[test]
fn every_ineligible_pair_has_one_deterministic_reason() {
    let directory = tempfile::tempdir().unwrap();
    let store = init_store(directory.path());
    let case = resolved_case();
    store.put_case(&case).unwrap();
    let snapshot = snapshot_for(&store, &case.case_id);
    let task = task_for(&store, &snapshot);

    let same = import_named(
        &store,
        &task.task_id,
        SourceKind::Human,
        "same-snapshot",
        Observed::Unknown,
        "same snapshot",
        FairnessClass::SameSnapshot,
        RunStatus::Completed,
        "2026-01-15T08:00:00Z",
    );
    let unknown_a = import_named(
        &store,
        &task.task_id,
        SourceKind::Human,
        "unknown-a",
        Observed::Unknown,
        "unknown a",
        FairnessClass::UnknownVisibility,
        RunStatus::Completed,
        "2026-01-15T08:01:00Z",
    );
    let unknown_b = import_named(
        &store,
        &task.task_id,
        SourceKind::Human,
        "unknown-b",
        Observed::Unknown,
        "unknown b",
        FairnessClass::UnknownVisibility,
        RunStatus::Completed,
        "2026-01-15T08:02:00Z",
    );
    let extra_a = import_named(
        &store,
        &task.task_id,
        SourceKind::Human,
        "extra-a",
        Observed::Unknown,
        "extra a",
        FairnessClass::ExtraEvidence {
            description: "private browser transcript".into(),
        },
        RunStatus::Completed,
        "2026-01-15T08:03:00Z",
    );
    let extra_a_again = import_named(
        &store,
        &task.task_id,
        SourceKind::Human,
        "extra-a-again",
        Observed::Unknown,
        "extra a again",
        FairnessClass::ExtraEvidence {
            description: "private browser transcript".into(),
        },
        RunStatus::Completed,
        "2026-01-15T08:04:00Z",
    );
    let extra_b = import_named(
        &store,
        &task.task_id,
        SourceKind::Human,
        "extra-b",
        Observed::Unknown,
        "extra b",
        FairnessClass::ExtraEvidence {
            description: "internal ticket comments".into(),
        },
        RunStatus::Completed,
        "2026-01-15T08:05:00Z",
    );

    let task_mismatch = EvaluationTask::from_parts(
        PrivacyClass::ShareSafe,
        case.case_id.clone(),
        snapshot.snapshot_id.clone(),
        "Which mitigation should be applied first?".into(),
        task.protocol.clone(),
        task.protocol_version.clone(),
        task.visibility.clone(),
        task.time_constraint.clone(),
        "2026-01-15T07:01:00Z".into(),
    )
    .unwrap();
    store.put_task(&task_mismatch).unwrap();
    let other_task = import_named(
        &store,
        &task_mismatch.task_id,
        SourceKind::Human,
        "other-task",
        Observed::Unknown,
        "other task",
        FairnessClass::SameSnapshot,
        RunStatus::Completed,
        "2026-01-15T08:06:00Z",
    );

    let other_snapshot = EvidenceSnapshot::from_parts(
        PrivacyClass::ShareSafe,
        case.case_id.clone(),
        "2026-01-15T06:01:00Z".into(),
        snapshot.captured_by.clone(),
        snapshot.items.clone(),
        Some("second immutable capture".into()),
    )
    .unwrap();
    store.put_snapshot(&other_snapshot).unwrap();
    let other_snapshot_task = EvaluationTask::from_parts(
        PrivacyClass::ShareSafe,
        case.case_id.clone(),
        other_snapshot.snapshot_id.clone(),
        task.question.clone(),
        task.protocol.clone(),
        task.protocol_version.clone(),
        task.visibility.clone(),
        task.time_constraint.clone(),
        "2026-01-15T07:02:00Z".into(),
    )
    .unwrap();
    store.put_task(&other_snapshot_task).unwrap();
    let other_snapshot_run = import_named(
        &store,
        &other_snapshot_task.task_id,
        SourceKind::Human,
        "other-snapshot",
        Observed::Unknown,
        "other snapshot",
        FairnessClass::SameSnapshot,
        RunStatus::Completed,
        "2026-01-15T08:07:00Z",
    );

    let runs = store.load_runs().unwrap();
    let report = build_report(
        &runs,
        &[],
        &[],
        std::slice::from_ref(&case),
        PrivacyClass::OwnerOnly,
    )
    .unwrap();
    let mut reversed = runs;
    reversed.reverse();
    let reversed_report = build_report(
        &reversed,
        &[],
        &[],
        std::slice::from_ref(&case),
        PrivacyClass::OwnerOnly,
    )
    .unwrap();
    assert_eq!(report, reversed_report);

    assert_eq!(report.groups.len(), 3);
    assert_eq!(
        report
            .groups
            .iter()
            .map(|group| group.runs.len())
            .collect::<BTreeSet<_>>(),
        BTreeSet::from([1, 6])
    );
    assert_eq!(report.incomparable.len(), 28);
    assert_eq!(
        report
            .incomparable
            .iter()
            .map(|pair| {
                let mut ids = [pair.left_run_id.as_str(), pair.right_run_id.as_str()];
                ids.sort_unstable();
                (ids[0].to_string(), ids[1].to_string())
            })
            .collect::<BTreeSet<_>>()
            .len(),
        28
    );

    assert_eq!(
        pair(&report.incomparable, &unknown_a, &unknown_b).reason,
        "unknown_visibility"
    );
    assert_eq!(
        pair(&report.incomparable, &extra_a, &extra_a_again).reason,
        "extra_evidence"
    );
    let unequal_extra = pair(&report.incomparable, &extra_a, &extra_b);
    assert_eq!(unequal_extra.reason, "extra_evidence_description_mismatch");
    assert!(unequal_extra.detail.contains("private browser transcript"));
    assert!(unequal_extra.detail.contains("internal ticket comments"));
    assert_eq!(
        pair(&report.incomparable, &same, &unknown_a).reason,
        "fairness_class_mismatch"
    );
    assert_eq!(
        pair(&report.incomparable, &same, &other_task).reason,
        "snapshot_or_task_mismatch"
    );
    assert_eq!(
        pair(&report.incomparable, &other_task, &other_snapshot_run).reason,
        "snapshot_or_task_mismatch"
    );
}
