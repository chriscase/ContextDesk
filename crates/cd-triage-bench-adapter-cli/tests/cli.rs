use assert_cmd::Command;
use cd_triage_bench::report::{build_report, ScoreVisibility};
use cd_triage_bench::types::{
    Adjudication, BlindingState, Case, CaseLifecycle, ConflictOfInterest, ContentDigest,
    DimensionOutcome, DimensionVerdict, EvaluationTask, EvidenceItem, EvidenceSnapshot,
    EvidenceSource, HeldContent, PrivacyClass, ReportedProblem, ReviewPhase, RubricDimension,
    VisibilityPolicy, CASE_SCHEMA_V1, RUBRIC_V1, RUN_SCHEMA_V2,
};
use cd_triage_bench::{
    BenchStore, FairnessClass, Observed, RunStatus, SourceKind, StrategyIdentity,
};
use cd_triage_bench_adapter::{
    decode_replay_json, materialize_bounded_packet, project_share_safe, record_public_replay,
    run_deterministic_mock, MockEnginePlan, MockSlotOutcome, MockSlotPlan, MockTerminalPlan,
    MockValidation, RecordingContext,
};
use cd_triage_sdk::{ModelRef, TriagePolicySelectionV2, TriageSlotKindV2};

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

fn replay_plan(status: RunStatus) -> MockEnginePlan {
    let (outcome, validation, terminal) = match status {
        RunStatus::Completed => (
            MockSlotOutcome::completed(),
            Some(MockValidation {
                passed: true,
                reason_codes: vec![],
            }),
            MockTerminalPlan::Completed,
        ),
        RunStatus::Partial => (
            MockSlotOutcome::Abstained,
            Some(MockValidation {
                passed: false,
                reason_codes: vec!["mock_partial".into()],
            }),
            MockTerminalPlan::CompletedPartial,
        ),
        RunStatus::Failed => (
            MockSlotOutcome::Failed,
            Some(MockValidation {
                passed: false,
                reason_codes: vec!["mock_failed".into()],
            }),
            MockTerminalPlan::Failed {
                category: "mock_failed".into(),
                partial_result: true,
            },
        ),
        RunStatus::TimedOut => (
            MockSlotOutcome::TimedOut,
            Some(MockValidation {
                passed: false,
                reason_codes: vec!["mock_timed_out".into()],
            }),
            MockTerminalPlan::TimedOut {
                category: "mock_timed_out".into(),
                partial_result: true,
            },
        ),
        RunStatus::Cancelled => (
            MockSlotOutcome::Cancelled,
            None,
            MockTerminalPlan::Cancelled {
                partial_result: false,
            },
        ),
        RunStatus::Unscorable => panic!("unscorable is not an SDK replay terminal"),
    };
    MockEnginePlan {
        slots: vec![MockSlotPlan {
            role_slot_id: "standard-finalizer".into(),
            role: TriageSlotKindV2::Finalizer,
            model: ModelRef {
                profile_id: "profile:mock-gateway".into(),
                model_id: "mock-finalizer-v1".into(),
            },
            outcome,
        }],
        validation,
        correction: None,
        terminal,
    }
}

fn support_outcomes() -> Vec<DimensionOutcome> {
    RubricDimension::all()
        .into_iter()
        .map(|dimension| DimensionOutcome {
            dimension,
            verdict: if dimension == RubricDimension::DiagnosisCorrectness {
                DimensionVerdict::NotApplicable
            } else {
                DimensionVerdict::Score { value: 2 }
            },
            rationale: "hermetic acceptance review".into(),
            assist_flags: vec![],
        })
        .collect()
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

#[test]
fn record_replay_ingests_a_validated_public_sdk_replay() {
    let directory = tempfile::tempdir().unwrap();
    let (store, task) = seed_store(directory.path());
    let case = store.get_case(&task.case_id).unwrap();
    let snapshot = store.get_snapshot(&task.snapshot_id).unwrap();
    let bounded =
        cd_triage_bench_adapter::materialize_bounded_packet(&case, &snapshot, &task).unwrap();
    let bound = cd_triage_bench_adapter::build_request(
        &snapshot,
        &task,
        &bounded,
        cd_triage_sdk::TriagePolicySelectionV2::Standard {
            model: cd_triage_sdk::ModelRef {
                profile_id: "profile:mock-gateway".into(),
                model_id: "mock-finalizer-v1".into(),
            },
        },
        Default::default(),
        &format!("cancel-{}", task.task_id),
    )
    .unwrap();
    let mock = cd_triage_bench_adapter::run_deterministic_mock(
        &bound,
        &bounded,
        &cd_triage_bench_adapter::MockEnginePlan {
            slots: vec![cd_triage_bench_adapter::MockSlotPlan {
                role_slot_id: "standard-finalizer".into(),
                role: cd_triage_sdk::TriageSlotKindV2::Finalizer,
                model: cd_triage_sdk::ModelRef {
                    profile_id: "profile:mock-gateway".into(),
                    model_id: "mock-finalizer-v1".into(),
                },
                outcome: cd_triage_bench_adapter::MockSlotOutcome::Failed,
            }],
            validation: Some(cd_triage_bench_adapter::MockValidation {
                passed: false,
                reason_codes: vec!["mock_failed".into()],
            }),
            correction: None,
            terminal: cd_triage_bench_adapter::MockTerminalPlan::Failed {
                category: "mock_failed".into(),
                partial_result: true,
            },
        },
    )
    .unwrap();
    let replay_path = directory.path().join("replay.json");
    std::fs::write(&replay_path, serde_json::to_vec(&mock.replay).unwrap()).unwrap();

    let output = Command::cargo_bin("cd-triage-bench-adapter")
        .unwrap()
        .args([
            "--library",
            directory.path().to_str().unwrap(),
            "record-replay",
            &task.task_id,
            "--replay",
            replay_path.to_str().unwrap(),
            "--operator",
            "cli-ingest",
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
}

#[test]
fn record_replay_rejects_a_directory() {
    let directory = tempfile::tempdir().unwrap();
    let (_store, task) = seed_store(directory.path());
    let output = Command::cargo_bin("cd-triage-bench-adapter")
        .unwrap()
        .args([
            "--library",
            directory.path().to_str().unwrap(),
            "record-replay",
            &task.task_id,
            "--replay",
            directory.path().to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("regular file"));
}

#[test]
fn replay_ingest_persists_and_reaches_adjudication_and_comparison() {
    let directory = tempfile::tempdir().unwrap();
    let (store, task) = seed_store(directory.path());
    let case = store.get_case(&task.case_id).unwrap();
    let snapshot = store.get_snapshot(&task.snapshot_id).unwrap();
    let bounded = materialize_bounded_packet(&case, &snapshot, &task).unwrap();
    let bound = cd_triage_bench_adapter::build_request(
        &snapshot,
        &task,
        &bounded,
        TriagePolicySelectionV2::Standard {
            model: ModelRef {
                profile_id: "profile:mock-gateway".into(),
                model_id: "mock-finalizer-v1".into(),
            },
        },
        Default::default(),
        &format!("cancel-{}", task.task_id),
    )
    .unwrap();
    let context = RecordingContext {
        strategy: StrategyIdentity {
            name: "contextdesk-sdk".into(),
            version: Observed::Known("public-contract-v2".into()),
            build: Observed::Known("replay-ingest-acceptance".into()),
        },
        operator: "acceptance-test".into(),
        created_at: "2026-01-15T08:00:00Z".into(),
    };

    let statuses = [
        RunStatus::Completed,
        RunStatus::Failed,
        RunStatus::Partial,
        RunStatus::TimedOut,
        RunStatus::Cancelled,
    ];
    let mut expected_runs = Vec::new();
    let mut completed = None;
    for expected_status in statuses {
        let mock = run_deterministic_mock(&bound, &bounded, &replay_plan(expected_status)).unwrap();
        let encoded_replay = serde_json::to_vec(&mock.replay).unwrap();
        let ingested_replay = decode_replay_json(&encoded_replay).unwrap();
        let recorded = record_public_replay(
            &case,
            &snapshot,
            &task,
            &bounded,
            &bound,
            ingested_replay,
            &context,
        )
        .unwrap();

        assert_eq!(recorded.bench_run.schema_id, RUN_SCHEMA_V2);
        assert_eq!(recorded.bench_run.status, expected_status);
        assert_eq!(recorded.bench_run.fairness, FairnessClass::SameSnapshot);
        assert_eq!(recorded.bench_run.privacy, PrivacyClass::OwnerOnly);
        assert!(matches!(recorded.bench_run.cost, Observed::Unknown));
        assert!(matches!(recorded.bench_run.timing, Observed::Unknown));
        assert!(recorded
            .raw_output
            .windows(b"mock-finalizer-v1".len())
            .any(|window| { window == b"mock-finalizer-v1" }));

        let share_safe = project_share_safe(&snapshot, &task, &recorded).unwrap();
        assert_eq!(share_safe.usage, "unknown");
        assert_eq!(share_safe.cost, "unknown");
        assert_eq!(share_safe.fairness, "same_snapshot");

        let digest = store.put_blob(&recorded.raw_output).unwrap();
        assert_eq!(digest, recorded.bench_run.raw_output.digest);
        let outcome = store.put_run(&recorded.bench_run).unwrap();
        assert!(matches!(
            outcome,
            cd_triage_bench::store::PutRunOutcome::Created { .. }
        ));

        let reopened = store.get_run(&recorded.bench_run.run_id).unwrap();
        assert_eq!(reopened, recorded.bench_run);
        assert_eq!(
            store.get_blob(&reopened.raw_output.digest.hex).unwrap(),
            recorded.raw_output
        );
        expected_runs.push((reopened.run_id.clone(), expected_status));
        if expected_status == RunStatus::Completed {
            completed = Some(recorded);
        }
    }

    let completed = completed.expect("completed replay was recorded");
    let review_packet = store
        .materialize_review_packet(&completed.bench_run.run_id, ReviewPhase::Support)
        .unwrap();
    assert_eq!(review_packet.run_id, completed.bench_run.run_id);
    assert_eq!(review_packet.run.status, RunStatus::Completed);
    assert_eq!(
        review_packet.raw_output_utf8.as_deref().map(str::as_bytes),
        Some(completed.raw_output.as_slice())
    );
    assert!(matches!(
        review_packet.blinding,
        BlindingState::Unblinded { ref reason }
            if reason == "raw output is an owner-only ContextDesk SDK replay envelope"
    ));

    let adjudication = Adjudication::from_parts_with_packet(
        PrivacyClass::OwnerOnly,
        completed.bench_run.case_id.clone(),
        completed.bench_run.task_id.clone(),
        completed.bench_run.snapshot_id.clone(),
        completed.bench_run.run_id.clone(),
        "reviewer-acceptance".into(),
        ConflictOfInterest {
            declared: false,
            notes: None,
        },
        RUBRIC_V1.into(),
        ReviewPhase::Support,
        review_packet.packet_id,
        review_packet.blinding,
        support_outcomes(),
        "2026-01-15T09:00:00Z".into(),
    )
    .unwrap();
    let score = store.import_adjudication(adjudication).unwrap();
    assert_eq!(score.run_id, completed.bench_run.run_id);

    let report = build_report(
        &store.load_runs().unwrap(),
        &store.load_adjudications().unwrap(),
        &store.load_scores().unwrap(),
        &store.load_cases().unwrap(),
        PrivacyClass::OwnerOnly,
    )
    .unwrap();
    for (run_id, expected_status) in expected_runs {
        let summary = report
            .groups
            .iter()
            .flat_map(|group| &group.runs)
            .find(|run| run.run_id == run_id)
            .expect("persisted replay appears in the comparison report");
        assert_eq!(summary.status, expected_status);
        assert_eq!(summary.fairness, "same_snapshot");
        assert!(summary.comparison_eligible);
    }
    let completed_summary = report
        .groups
        .iter()
        .flat_map(|group| &group.runs)
        .find(|run| run.run_id == completed.bench_run.run_id)
        .unwrap();
    assert_eq!(completed_summary.score_visibility, ScoreVisibility::Partial);
    assert!(completed_summary.scores.iter().any(|dimension| {
        dimension
            .verdicts
            .iter()
            .any(|verdict| verdict.adjudication_id == score.adjudication_id)
    }));
    assert!(report.generated_from.score_ids.contains(&score.score_id));
}
