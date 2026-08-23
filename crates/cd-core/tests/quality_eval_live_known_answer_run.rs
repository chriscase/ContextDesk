use cd_core::investigation_team_qualification::InvestigationTeamRole;
use cd_core::quality_eval::{
    build_live_known_answer_run, live_known_answer_prompt_set_hash, live_known_answer_quality_unit,
    load_embedded_open_v1_suite, load_suite, parse_live_known_answer_json,
    prepare_live_known_answer_suite, render_live_known_answer_json,
    render_live_known_answer_markdown, AnswerDimension, AnswerScore, LaneStatus,
    LiveKnownAnswerRunStatus, LiveKnownAnswerScenarioObservation, ModelSubject,
    LIVE_KNOWN_ANSWER_REQUIRED_SCENARIOS,
};
use std::path::PathBuf;

fn answer(passed: bool) -> AnswerScore {
    AnswerScore {
        candidate_id: "host-only-candidate".into(),
        task_id: "host-only-task".into(),
        packet_id: "host-only-packet".into(),
        passed,
        dimensions: vec![AnswerDimension {
            id: "deterministic_contract".into(),
            passed,
            reason: if passed {
                "contract passed".into()
            } else {
                "contract_failed".into()
            },
        }],
        status: LaneStatus::Executed,
        expected_outcome: None,
        expectation_met: None,
    }
}

fn identity() -> (String, String, cd_core::quality_eval::QualityUnit) {
    let suite = load_embedded_open_v1_suite().expect("embedded suite");
    let prepared = prepare_live_known_answer_suite(&suite).expect("prepared suite");
    let prompt_hash = live_known_answer_prompt_set_hash(&prepared).expect("prompt hash");
    let unit = live_known_answer_quality_unit(
        "0123456789abcdef",
        ModelSubject {
            gateway_profile_id: "profile-a".into(),
            endpoint_fingerprint: "a".repeat(64),
            model_id: "model-a".into(),
        },
        suite.manifest.suite_id.clone(),
        suite.digest.clone(),
        prompt_hash.clone(),
    );
    (suite.digest, prompt_hash, unit)
}

fn observations() -> Vec<LiveKnownAnswerScenarioObservation> {
    (1..=LIVE_KNOWN_ANSWER_REQUIRED_SCENARIOS)
        .map(|index| LiveKnownAnswerScenarioObservation {
            scenario_id: format!("scenario-{index:03}"),
            status: LaneStatus::Executed,
            answer: Some(answer(true)),
            latency_ms: index as u64,
            input_bytes: 100,
            output_bytes: 50,
            failure_code: None,
        })
        .collect()
}

#[test]
fn embedded_suite_is_byte_identical_to_the_checked_in_suite() {
    let embedded = load_embedded_open_v1_suite().expect("embedded");
    let filesystem = load_suite(
        &PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/quality-eval/open-v1"),
    )
    .expect("filesystem");
    assert_eq!(embedded.digest, filesystem.digest);
    assert_eq!(embedded.manifest, filesystem.manifest);
    assert_eq!(embedded.cases.len(), 14);
}

#[test]
fn qualified_report_is_exact_redacted_and_canonical() {
    let (suite_digest, prompt_hash, unit) = identity();
    let report = build_live_known_answer_run(
        1_777_000_000,
        InvestigationTeamRole::Investigator,
        unit,
        observations(),
    )
    .expect("report");
    assert_eq!(report.status, LiveKnownAnswerRunStatus::Qualified);
    assert_eq!(report.metrics.passed_scenarios, 14);
    assert_eq!(report.metrics.executed_scenarios, 14);
    assert_eq!(report.metrics.input_tokens, None);
    assert_eq!(report.metrics.cost_microusd, None);
    assert_eq!(report.quality_run.quality_unit.suite_digest, suite_digest);
    assert_eq!(report.quality_run.quality_unit.prompt_set_hash, prompt_hash);

    let json = render_live_known_answer_json(&report).expect("json");
    let reparsed = parse_live_known_answer_json(&json).expect("parse");
    assert_eq!(reparsed, report);
    assert!(!json.contains("qe01-simple-diagnosis"));
    assert!(!json.contains("host-only-task"));
    assert!(!json.contains("host-only-candidate"));
    assert!(!json.contains("evaluator_truth"));
    assert!(!json.contains("answer_key"));

    let markdown = render_live_known_answer_markdown(&report).expect("markdown");
    assert!(markdown.contains("Passed: 14/14"));
    assert!(markdown.contains("Tokens: unknown"));
    assert!(markdown.contains("Cost: unknown"));
}

#[test]
fn cancellation_is_partial_and_never_silently_passes() {
    let (_, _, unit) = identity();
    let mut rows = observations();
    rows[13] = LiveKnownAnswerScenarioObservation {
        scenario_id: "scenario-014".into(),
        status: LaneStatus::Cancelled,
        answer: None,
        latency_ms: 0,
        input_bytes: 0,
        output_bytes: 0,
        failure_code: Some("cancelled_before_dispatch".into()),
    };
    let report =
        build_live_known_answer_run(1_777_000_000, InvestigationTeamRole::Reviewer, unit, rows)
            .expect("partial");
    assert_eq!(report.status, LiveKnownAnswerRunStatus::Partial);
    assert_eq!(report.metrics.passed_scenarios, 13);
    assert_eq!(report.metrics.cancelled_scenarios, 1);
    assert_eq!(report.quality_run.status, LaneStatus::Failed);
}

#[test]
fn quality_failure_is_failed_but_still_measured() {
    let (_, _, unit) = identity();
    let mut rows = observations();
    rows[4].answer = Some(answer(false));
    let report =
        build_live_known_answer_run(1_777_000_000, InvestigationTeamRole::Single, unit, rows)
            .expect("failed report");
    assert_eq!(report.status, LiveKnownAnswerRunStatus::Failed);
    assert_eq!(report.metrics.executed_scenarios, 14);
    assert_eq!(report.metrics.passed_scenarios, 13);
    assert_eq!(report.metrics.failed_scenarios, 1);
}

#[test]
fn unknown_fields_and_tampered_aggregates_fail_closed() {
    let (_, _, unit) = identity();
    let report = build_live_known_answer_run(
        1_777_000_000,
        InvestigationTeamRole::Single,
        unit,
        observations(),
    )
    .expect("report");
    let mut value: serde_json::Value =
        serde_json::from_str(&render_live_known_answer_json(&report).expect("json"))
            .expect("value");
    value["unknown"] = serde_json::json!(true);
    assert!(parse_live_known_answer_json(&value.to_string()).is_err());

    let mut value = serde_json::to_value(report).expect("value");
    value["metrics"]["passed_scenarios"] = serde_json::json!(99);
    assert!(parse_live_known_answer_json(&value.to_string()).is_err());
}

#[test]
fn malformed_lifecycle_and_privacy_shaped_identity_fail_closed() {
    let (_, _, unit) = identity();
    let mut rows = observations();
    rows[0].failure_code = Some("secret body".into());
    assert!(build_live_known_answer_run(
        1_777_000_000,
        InvestigationTeamRole::Single,
        unit.clone(),
        rows,
    )
    .is_err());

    let mut leaked = unit;
    leaked.subject.gateway_profile_id = "sk-abcdefghijklmnopqrst".into();
    assert!(build_live_known_answer_run(
        1_777_000_000,
        InvestigationTeamRole::Single,
        leaked,
        observations(),
    )
    .is_err());
}
