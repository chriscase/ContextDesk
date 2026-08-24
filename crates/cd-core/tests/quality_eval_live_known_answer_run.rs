use cd_core::investigation_team_qualification::InvestigationTeamRole;
use cd_core::quality_eval::{
    build_live_known_answer_run, live_known_answer_prompt_set_hash, live_known_answer_quality_unit,
    load_embedded_open_v1_suite, load_suite, parse_live_known_answer_json,
    prepare_live_known_answer_suite, render_live_known_answer_json,
    render_live_known_answer_markdown, AnswerDimension, AnswerScore, LaneStatus,
    LiveKnownAnswerRunStatus, LiveKnownAnswerScenarioObservation, ModelSubject,
    LIVE_KNOWN_ANSWER_JS_SAFE_MAX, LIVE_KNOWN_ANSWER_REQUIRED_SCENARIOS,
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
            model_id: "alibaba/qwen3.6-27b".into(),
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
            message_content_bytes: 100,
            provider_content_bytes: 50,
            reported_model_id: None,
            input_tokens: None,
            output_tokens: None,
            reasoning_tokens: None,
            cached_tokens: None,
            cost_microusd: None,
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
    assert!(json.contains("message_content_bytes"));
    assert!(json.contains("provider_content_bytes"));
    assert!(!json.contains("\"input_bytes\""));
    assert!(!json.contains("\"output_bytes\""));

    let markdown = render_live_known_answer_markdown(&report).expect("markdown");
    assert!(markdown.contains("Passed: 14/14"));
    assert!(markdown.contains("Message/provider content bytes: 1400/700"));
    assert!(markdown.contains("Input/output tokens: unknown/unknown"));
    assert!(markdown.contains("Cost (micro-USD): unknown"));
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
        message_content_bytes: 0,
        provider_content_bytes: 0,
        reported_model_id: None,
        input_tokens: None,
        output_tokens: None,
        reasoning_tokens: None,
        cached_tokens: None,
        cost_microusd: None,
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
fn reported_identity_and_complete_usage_are_preserved_without_rewriting_configuration() {
    let (_, _, unit) = identity();
    let mut rows = observations();
    for row in &mut rows {
        row.reported_model_id = Some("openai/gpt-oss-120b".into());
        row.input_tokens = Some(10);
        row.output_tokens = Some(4);
        row.reasoning_tokens = Some(2);
        row.cached_tokens = Some(3);
        row.cost_microusd = Some(17);
    }
    let report =
        build_live_known_answer_run(1_777_000_000, InvestigationTeamRole::Single, unit, rows)
            .expect("report");
    assert_eq!(
        report.quality_run.quality_unit.subject.model_id,
        "alibaba/qwen3.6-27b"
    );
    assert!(report
        .telemetry
        .iter()
        .all(|row| row.reported_model_id.as_deref() == Some("openai/gpt-oss-120b")));
    assert_eq!(report.metrics.input_tokens, Some(140));
    assert_eq!(report.metrics.output_tokens, Some(56));
    assert_eq!(report.metrics.reasoning_tokens, Some(28));
    assert_eq!(report.metrics.cached_tokens, Some(42));
    assert_eq!(report.metrics.cost_microusd, Some(238));
    let markdown = render_live_known_answer_markdown(&report).expect("markdown");
    assert!(markdown.contains("Configured model: `alibaba/qwen3.6-27b`"));
    assert!(markdown.contains("provider reported `openai/gpt-oss-120b`"));
    assert!(markdown.contains("differs from configured model"));
}

#[test]
fn one_missing_usage_value_keeps_the_aggregate_unknown() {
    let (_, _, unit) = identity();
    let mut rows = observations();
    for row in &mut rows {
        row.input_tokens = Some(10);
    }
    rows[4].input_tokens = None;
    let report =
        build_live_known_answer_run(1_777_000_000, InvestigationTeamRole::Single, unit, rows)
            .expect("report");
    assert_eq!(report.metrics.input_tokens, None);
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

    for unsafe_identity in [
        "https://gateway.internal/v1",
        "/Users/operator/private-profile",
        r"\\private-server\profiles\investigator",
        "gateway.internal:8443/v1",
        "token=private-profile-token",
    ] {
        let (_, _, mut unit) = identity();
        unit.subject.gateway_profile_id = unsafe_identity.into();
        assert!(build_live_known_answer_run(
            1_777_000_000,
            InvestigationTeamRole::Single,
            unit,
            observations(),
        )
        .is_err());
    }
}

#[test]
fn lifecycle_codes_and_dispatch_telemetry_are_closed_and_consistent() {
    let valid_non_executed = [
        (LaneStatus::Failed, "provider_request_failed", 100, 0),
        (LaneStatus::Failed, "provider_response_parse_failed", 100, 0),
        (
            LaneStatus::Failed,
            "provider_response_privacy_rejected",
            100,
            20,
        ),
        (
            LaneStatus::Failed,
            "provider_response_vocabulary_rejected",
            100,
            20,
        ),
        (LaneStatus::Failed, "host_score_failed", 100, 20),
        (LaneStatus::Cancelled, "cancelled_before_dispatch", 0, 0),
        (LaneStatus::Cancelled, "provider_attempt_cancelled", 100, 0),
        (
            LaneStatus::Blocked,
            "host_diagnostic_pipeline_unavailable",
            0,
            0,
        ),
    ];
    for (status, code, message_bytes, provider_bytes) in valid_non_executed {
        let (_, _, unit) = identity();
        let mut rows = observations();
        rows[0].status = status;
        rows[0].answer = None;
        rows[0].message_content_bytes = message_bytes;
        rows[0].provider_content_bytes = provider_bytes;
        rows[0].latency_ms = u64::from(message_bytes > 0);
        rows[0].failure_code = Some(code.into());
        assert!(
            build_live_known_answer_run(1_777_000_000, InvestigationTeamRole::Single, unit, rows,)
                .is_ok(),
            "closed lifecycle tuple must remain valid: {status:?}/{code}",
        );
    }

    for (status, code) in [
        (LaneStatus::Failed, "unknown_failure"),
        (LaneStatus::Failed, "cancelled_before_dispatch"),
        (LaneStatus::Cancelled, "provider_request_failed"),
        (LaneStatus::Blocked, "host_score_failed"),
        (
            LaneStatus::NotScheduled,
            "host_diagnostic_pipeline_unavailable",
        ),
    ] {
        let (_, _, unit) = identity();
        let mut rows = observations();
        rows[0].status = status;
        rows[0].answer = None;
        rows[0].failure_code = Some(code.into());
        assert!(build_live_known_answer_run(
            1_777_000_000,
            InvestigationTeamRole::Single,
            unit,
            rows,
        )
        .is_err());
    }

    let invalid_dispatch = [
        (LaneStatus::Cancelled, "cancelled_before_dispatch", 1, 0),
        (
            LaneStatus::Blocked,
            "host_diagnostic_pipeline_unavailable",
            0,
            1,
        ),
        (LaneStatus::Cancelled, "provider_attempt_cancelled", 0, 0),
        (LaneStatus::Failed, "provider_request_failed", 0, 0),
        (LaneStatus::Failed, "host_score_failed", 100, 0),
    ];
    for (status, code, message_bytes, provider_bytes) in invalid_dispatch {
        let (_, _, unit) = identity();
        let mut rows = observations();
        rows[0].status = status;
        rows[0].answer = None;
        rows[0].message_content_bytes = message_bytes;
        rows[0].provider_content_bytes = provider_bytes;
        rows[0].failure_code = Some(code.into());
        assert!(build_live_known_answer_run(
            1_777_000_000,
            InvestigationTeamRole::Single,
            unit,
            rows,
        )
        .is_err());
    }

    for (message_bytes, provider_bytes) in [(0, 50), (100, 0)] {
        let (_, _, unit) = identity();
        let mut rows = observations();
        rows[0].message_content_bytes = message_bytes;
        rows[0].provider_content_bytes = provider_bytes;
        assert!(build_live_known_answer_run(
            1_777_000_000,
            InvestigationTeamRole::Single,
            unit,
            rows,
        )
        .is_err());
    }

    let (_, _, unit) = identity();
    let mut rows = observations();
    rows[0].status = LaneStatus::Blocked;
    rows[0].answer = None;
    rows[0].latency_ms = 0;
    rows[0].message_content_bytes = 0;
    rows[0].provider_content_bytes = 0;
    rows[0].reported_model_id = Some("openai/gpt-oss-120b".into());
    rows[0].failure_code = Some("host_diagnostic_pipeline_unavailable".into());
    assert!(
        build_live_known_answer_run(1_777_000_000, InvestigationTeamRole::Single, unit, rows,)
            .is_err()
    );
}

#[test]
fn remaining_diagnostic_blocks_stay_on_the_closed_lifecycle() {
    let (_, _, unit) = identity();
    let mut rows = observations();
    for row in rows[8..12].iter_mut() {
        row.status = LaneStatus::Blocked;
        row.answer = None;
        row.failure_code = Some("host_diagnostic_pipeline_unavailable".into());
        row.message_content_bytes = 0;
        row.provider_content_bytes = 0;
        row.latency_ms = 0;
    }
    let report =
        build_live_known_answer_run(1_777_000_000, InvestigationTeamRole::Single, unit, rows)
            .expect("blocked diagnostic report");
    assert_eq!(report.status, LiveKnownAnswerRunStatus::Partial);
    assert_eq!(report.metrics.blocked_scenarios, 4);
    assert_eq!(report.metrics.failed_scenarios, 0);
    assert!(report.telemetry[8..12].iter().all(|row| {
        row.status == LaneStatus::Blocked
            && row.failure_code.as_deref() == Some("host_diagnostic_pipeline_unavailable")
            && row.message_content_bytes == 0
            && row.provider_content_bytes == 0
            && row.latency_ms == 0
    }));
}

#[test]
fn canonical_reload_rejects_mutated_status_code_and_dispatch_contracts() {
    let (_, _, unit) = identity();
    let report = build_live_known_answer_run(
        1_777_000_000,
        InvestigationTeamRole::Single,
        unit,
        observations(),
    )
    .expect("report");

    let mut contradictory = serde_json::to_value(&report).expect("value");
    contradictory["telemetry"][0]["failure_code"] = serde_json::json!("host_score_failed");
    assert!(parse_live_known_answer_json(&contradictory.to_string()).is_err());

    let mut undispatched = serde_json::to_value(&report).expect("value");
    undispatched["telemetry"][0]["message_content_bytes"] = serde_json::json!(0);
    assert!(parse_live_known_answer_json(&undispatched.to_string()).is_err());

    let mut not_scheduled = serde_json::to_value(report).expect("value");
    not_scheduled["telemetry"][0]["status"] = serde_json::json!("not_scheduled");
    not_scheduled["telemetry"][0]["failure_code"] = serde_json::json!("unknown_failure");
    not_scheduled["quality_run"]["cases"][0]["status"] = serde_json::json!("not_scheduled");
    not_scheduled["quality_run"]["cases"][0]["answers"] = serde_json::json!([]);
    assert!(parse_live_known_answer_json(&not_scheduled.to_string()).is_err());
}

#[test]
fn legitimate_provider_and_model_ids_remain_valid() {
    for model_id in [
        "alibaba/qwen3.6-27b",
        "openai/gpt-oss-120b",
        "mistral/ministral-14b",
    ] {
        let (_, _, mut unit) = identity();
        unit.subject.model_id = model_id.into();
        assert!(build_live_known_answer_run(
            1_777_000_000,
            InvestigationTeamRole::Single,
            unit,
            observations(),
        )
        .is_ok());
    }

    for model_id in [
        "8.8.8.8/v1",
        "gateway:8443",
        "/v1",
        "v1/chat/completions",
        "gateway.example.test",
        "gateway.corp/api",
        "service.namespace.svc.cluster.local/v1",
        "[::ffff:10.0.0.5]:8443",
    ] {
        let (_, _, mut unit) = identity();
        unit.subject.model_id = model_id.into();
        assert!(build_live_known_answer_run(
            1_777_000_000,
            InvestigationTeamRole::Single,
            unit,
            observations(),
        )
        .is_err());
    }
}

#[test]
fn report_rejects_unsafe_reported_identity_and_unbound_capture_digest() {
    let (_, _, unit) = identity();
    let mut rows = observations();
    rows[0].reported_model_id = Some("https://private.gateway/models/secret".into());
    assert!(build_live_known_answer_run(
        1_777_000_000,
        InvestigationTeamRole::Single,
        unit.clone(),
        rows,
    )
    .is_err());

    for reported_model_id in [
        "api-key=private-model-key",
        "Bearer private-model-token",
        "10.0.0.5:8443/model",
        "8.8.8.8/v1",
        "gateway:8443",
        "/v1",
        "v1/chat/completions",
        "gateway.example.test",
        "gateway.internal:8443/v1",
        "gateway.corp/api",
        "service.namespace.svc.cluster.local/v1",
        "[::ffff:192.168.1.5]/v1",
        r"\\private-server\models\private",
    ] {
        let (_, _, unit) = identity();
        let mut rows = observations();
        rows[0].reported_model_id = Some(reported_model_id.into());
        assert!(build_live_known_answer_run(
            1_777_000_000,
            InvestigationTeamRole::Single,
            unit,
            rows,
        )
        .is_err());
    }

    let mut report = build_live_known_answer_run(
        1_777_000_000,
        InvestigationTeamRole::Single,
        unit,
        observations(),
    )
    .expect("report");
    report.canonical_capture_sha256 = Some("not-a-sha".into());
    assert!(render_live_known_answer_json(&report).is_err());
}

#[test]
fn telemetry_values_and_aggregates_must_be_javascript_safe() {
    let (_, _, unit) = identity();
    let mut rows = observations();
    rows[0].latency_ms = LIVE_KNOWN_ANSWER_JS_SAFE_MAX + 1;
    assert!(build_live_known_answer_run(
        1_777_000_000,
        InvestigationTeamRole::Single,
        unit.clone(),
        rows,
    )
    .is_err());

    let mut rows = observations();
    rows[0].input_tokens = Some(LIVE_KNOWN_ANSWER_JS_SAFE_MAX);
    for row in &mut rows[1..] {
        row.input_tokens = Some(1);
    }
    assert!(build_live_known_answer_run(
        1_777_000_000,
        InvestigationTeamRole::Single,
        unit.clone(),
        rows,
    )
    .is_err());

    let mut rows = observations();
    rows[0].message_content_bytes = LIVE_KNOWN_ANSWER_JS_SAFE_MAX;
    assert!(
        build_live_known_answer_run(1_777_000_000, InvestigationTeamRole::Single, unit, rows,)
            .is_err()
    );
}
