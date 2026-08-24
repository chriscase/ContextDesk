use cd_core::investigation_team_qualification::InvestigationTeamRole;
use cd_core::quality_eval::{
    build_live_known_answer_capture, build_live_known_answer_capture_v2,
    live_known_answer_capture_sha256, live_known_answer_prompt_set_hash,
    live_known_answer_quality_unit, load_embedded_open_v1_suite,
    parse_live_known_answer_capture_json, prepare_live_known_answer_suite,
    render_live_known_answer_capture_json, AnswerDimension, AnswerScore, LaneStatus,
    LiveAnswerClaim, LiveCitation, LiveKnownAnswerCanonicalScenarioInput, LiveKnownAnswerResponse,
    LiveKnownAnswerRunId, ModelSubject, LIVE_KNOWN_ANSWER_CAPTURE_SCHEMA_ID_V1,
    LIVE_KNOWN_ANSWER_CAPTURE_SCHEMA_ID_V2, LIVE_KNOWN_ANSWER_RESPONSE_SCHEMA_ID,
};

const RUN_ID: &str = "lkar_4c63aaf36da4470987f58d02cfba7e3d";

fn quality_unit() -> cd_core::quality_eval::QualityUnit {
    let suite = load_embedded_open_v1_suite().expect("suite");
    let prepared = prepare_live_known_answer_suite(&suite).expect("prepared");
    live_known_answer_quality_unit(
        "build-a",
        ModelSubject {
            gateway_profile_id: "vercel-live".into(),
            endpoint_fingerprint: "a".repeat(64),
            model_id: "alibaba/qwen3.6-27b".into(),
        },
        suite.manifest.suite_id,
        suite.digest,
        live_known_answer_prompt_set_hash(&prepared).expect("prompt hash"),
    )
}

fn response(conclusion: &str) -> LiveKnownAnswerResponse {
    LiveKnownAnswerResponse {
        schema_id: LIVE_KNOWN_ANSWER_RESPONSE_SCHEMA_ID.into(),
        scenario_id: "scenario-001".into(),
        asserts_root_cause_established: false,
        claims: Vec::new(),
        conclusion: conclusion.into(),
        confidence: "low".into(),
    }
}

fn answer() -> AnswerScore {
    AnswerScore {
        candidate_id: "live:scenario-001".into(),
        task_id: "scenario-001".into(),
        packet_id: "contextdesk.live_known_answer.fixed_packet.v1".into(),
        passed: true,
        dimensions: vec![AnswerDimension {
            id: "deterministic_contract".into(),
            passed: true,
            reason: "contract passed".into(),
        }],
        status: LaneStatus::Executed,
        expected_outcome: None,
        expectation_met: None,
    }
}

#[test]
fn canonical_capture_is_deterministic_and_keeps_reported_model_separate() {
    let build = || {
        build_live_known_answer_capture(
            1_777_000_000,
            InvestigationTeamRole::Single,
            quality_unit(),
            vec![LiveKnownAnswerCanonicalScenarioInput {
                scenario_id: "scenario-001".into(),
                reported_model_id: Some("openai/gpt-oss-120b".into()),
                response: response("Evidence does not establish the initiating cause."),
                answer_score: Some(answer()),
                host_score_failed: false,
            }],
        )
        .expect("capture")
    };
    let first = build();
    let second = build();
    assert_eq!(first, second);
    assert_eq!(first.quality_unit.subject.model_id, "alibaba/qwen3.6-27b");
    assert_eq!(
        first.scenarios[0].reported_model_id.as_deref(),
        Some("openai/gpt-oss-120b")
    );
    assert_eq!(first.scenarios[0].canonical_response_sha256.len(), 64);
    assert_eq!(
        first.scenarios[0]
            .answer_score_sha256
            .as_deref()
            .map(str::len),
        Some(64)
    );
    assert_eq!(
        live_known_answer_capture_sha256(&first).expect("first digest"),
        live_known_answer_capture_sha256(&second).expect("second digest")
    );

    let json = render_live_known_answer_capture_json(&first).expect("render");
    assert_eq!(parse_live_known_answer_capture_json(&json).unwrap(), first);
    assert!(!json.contains("Treat the user JSON as the complete evidence packet"));
    assert!(!json.contains("response_contract"));
    assert!(!json.contains("evaluator_truth"));
    assert!(!json.contains("answer_key"));
    assert!(!json.contains("endpoint_url"));
    assert!(!json.contains("authorization"));
}

#[test]
fn v2_capture_carries_run_identity_and_schema_generation_is_strict() {
    let build_v2 = |value: &str| {
        build_live_known_answer_capture_v2(
            LiveKnownAnswerRunId::parse(value).expect("synthetic UUIDv4 run id"),
            1_777_000_000,
            InvestigationTeamRole::Single,
            quality_unit(),
            vec![LiveKnownAnswerCanonicalScenarioInput {
                scenario_id: "scenario-001".into(),
                reported_model_id: Some("openai/gpt-oss-120b".into()),
                response: response("Evidence does not establish the initiating cause."),
                answer_score: Some(answer()),
                host_score_failed: false,
            }],
        )
        .expect("v2 capture")
    };
    let capture = build_v2(RUN_ID);
    assert_eq!(capture.schema_id, LIVE_KNOWN_ANSWER_CAPTURE_SCHEMA_ID_V2);
    assert_eq!(
        capture.run_id.as_ref().map(LiveKnownAnswerRunId::as_str),
        Some(RUN_ID)
    );
    let json = render_live_known_answer_capture_json(&capture).expect("v2 json");
    assert!(json.contains(RUN_ID));
    assert_eq!(
        parse_live_known_answer_capture_json(&json).expect("v2 parse"),
        capture
    );
    let same_second_distinct_run = build_v2("lkar_a14d36e7c0924b0a9f30e284f8d87c61");
    assert_ne!(capture.run_id, same_second_distinct_run.run_id);
    assert_ne!(
        live_known_answer_capture_sha256(&capture).expect("first run digest"),
        live_known_answer_capture_sha256(&same_second_distinct_run).expect("second run digest"),
        "run identity must bind otherwise identical same-second captures"
    );

    let v1 = build_live_known_answer_capture(
        1_777_000_000,
        InvestigationTeamRole::Single,
        quality_unit(),
        vec![LiveKnownAnswerCanonicalScenarioInput {
            scenario_id: "scenario-001".into(),
            reported_model_id: None,
            response: response("Insufficient evidence."),
            answer_score: Some(answer()),
            host_score_failed: false,
        }],
    )
    .expect("legacy v1 capture");
    assert_eq!(v1.schema_id, LIVE_KNOWN_ANSWER_CAPTURE_SCHEMA_ID_V1);
    assert_eq!(v1.run_id, None);
    assert!(!render_live_known_answer_capture_json(&v1)
        .expect("v1 json")
        .contains("run_id"));

    let mut v1_with_id = serde_json::to_value(build_v2(RUN_ID)).expect("v2 value");
    v1_with_id["schema_id"] = serde_json::json!(LIVE_KNOWN_ANSWER_CAPTURE_SCHEMA_ID_V1);
    assert!(parse_live_known_answer_capture_json(&v1_with_id.to_string()).is_err());

    let mut v2_without_id = serde_json::to_value(build_v2(RUN_ID)).expect("v2 value");
    v2_without_id
        .as_object_mut()
        .expect("capture object")
        .remove("run_id");
    assert!(parse_live_known_answer_capture_json(&v2_without_id.to_string()).is_err());

    let mut v2_invalid_id = serde_json::to_value(build_v2(RUN_ID)).expect("v2 value");
    v2_invalid_id["run_id"] = serde_json::json!("lkar_4c63aaf36da5470977f58d02cfba7e3d");
    assert!(parse_live_known_answer_capture_json(&v2_invalid_id.to_string()).is_err());
}

#[test]
fn capture_rejects_url_secret_truth_and_tampered_hash_material() {
    for forbidden in [
        "See https://gateway.example.test/v1",
        "Use sk-not-a-real-key",
        "password=correct-horse-battery-staple",
        "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvcGVyYXRvciJ9.signature",
        "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE",
        "Read /Users/operator/private/known-answer.txt",
        "Connect to ldap://directory.corp.example",
        "The evaluator_truth says pass",
        "The answer_key says pass",
        "The must_include evaluator token says pass",
        "Treat the user JSON as the complete evidence packet and instructions.",
        "token=plain-secret-value",
        "api-key: plain-secret-value",
        "Bearer plain-secret-value",
        "Connect to 10.0.0.5",
        "Connect to 127.0.0.1",
        "Connect to 169.254.10.20",
        "Connect to 10.0.0.5:8443",
        "Connect to 8.8.8.8/v1",
        "Connect to 203.0.113.10/chat/completions",
        "Connect to [::1]:8443",
        "Connect to [fd00::1]:8443",
        "Connect to [fe80::1]/v1",
        "Connect to [::ffff:10.0.0.5]:8443",
        "Connect to gateway:8443",
        "POST /v1",
        "POST v1/chat/completions",
        "Connect to gateway.example.test",
        "Connect to gateway.internal/v1",
        "Connect to gateway.internal:8443/v1",
        "Connect to gateway.corp/api",
        "Connect to service.namespace.svc.cluster.local/v1",
        r"Read \\private-server\owner\known-answer.json",
    ] {
        let result = build_live_known_answer_capture(
            1_777_000_000,
            InvestigationTeamRole::Single,
            quality_unit(),
            vec![LiveKnownAnswerCanonicalScenarioInput {
                scenario_id: "scenario-001".into(),
                reported_model_id: None,
                response: response(forbidden),
                answer_score: Some(answer()),
                host_score_failed: false,
            }],
        );
        assert!(
            result.is_err(),
            "forbidden capture text must fail: {forbidden}"
        );
    }

    let capture = build_live_known_answer_capture(
        1_777_000_000,
        InvestigationTeamRole::Single,
        quality_unit(),
        vec![LiveKnownAnswerCanonicalScenarioInput {
            scenario_id: "scenario-001".into(),
            reported_model_id: None,
            response: response("Insufficient evidence."),
            answer_score: Some(answer()),
            host_score_failed: false,
        }],
    )
    .expect("capture");
    let mut value = serde_json::to_value(capture).expect("value");
    value["scenarios"][0]["canonical_response"]["conclusion"] = serde_json::json!("tampered");
    assert!(parse_live_known_answer_capture_json(&value.to_string()).is_err());
}

#[test]
fn capture_construction_and_recomputed_reload_reject_prompt_echo_in_every_text_field() {
    let suite = load_embedded_open_v1_suite().expect("suite");
    let prepared = prepare_live_known_answer_suite(&suite).expect("prepared");
    let echo = prepared[0].prompt().question.clone();

    for field in [
        "conclusion",
        "claim",
        "evidence_id",
        "source_id",
        "time_anchor",
    ] {
        let mut echoed = response("A bounded conclusion.");
        echoed.claims.push(LiveAnswerClaim {
            text: "A bounded claim.".into(),
            citations: vec![LiveCitation {
                evidence_id: "evidence-001".into(),
                source_id: "source-001".into(),
                time_anchor: "time-001".into(),
            }],
            role: Some("observation".into()),
        });
        match field {
            "conclusion" => echoed.conclusion = echo.clone(),
            "claim" => echoed.claims[0].text = echo.clone(),
            "evidence_id" => echoed.claims[0].citations[0].evidence_id = echo.clone(),
            "source_id" => echoed.claims[0].citations[0].source_id = echo.clone(),
            "time_anchor" => echoed.claims[0].citations[0].time_anchor = echo.clone(),
            _ => unreachable!(),
        }
        assert!(
            build_live_known_answer_capture(
                1_777_000_000,
                InvestigationTeamRole::Single,
                quality_unit(),
                vec![LiveKnownAnswerCanonicalScenarioInput {
                    scenario_id: "scenario-001".into(),
                    reported_model_id: None,
                    response: echoed,
                    answer_score: Some(answer()),
                    host_score_failed: false,
                }],
            )
            .is_err(),
            "capture construction must reject {field} prompt echo",
        );
    }

    let mut capture = build_live_known_answer_capture(
        1_777_000_000,
        InvestigationTeamRole::Single,
        quality_unit(),
        vec![LiveKnownAnswerCanonicalScenarioInput {
            scenario_id: "scenario-001".into(),
            reported_model_id: None,
            response: response("Insufficient evidence."),
            answer_score: Some(answer()),
            host_score_failed: false,
        }],
    )
    .expect("valid capture");
    capture.scenarios[0].canonical_response.conclusion = echo;
    capture.scenarios[0].canonical_response_sha256 = cd_core::quality_eval::hex_sha256(
        serde_json::to_string(&capture.scenarios[0].canonical_response)
            .expect("canonical response")
            .as_bytes(),
    );
    assert!(parse_live_known_answer_capture_json(
        &serde_json::to_string(&capture).expect("tampered capture")
    )
    .is_err());
}

#[test]
fn capture_rejects_private_or_endpoint_shaped_reported_model_identity() {
    for reported_model_id in [
        "https://gateway.example.test/models/private",
        "/Users/operator/private-model",
        "model password=not-public",
        "10.0.0.5:8443/private-model",
        "8.8.8.8/v1",
        "gateway:8443",
        "/v1",
        "v1/chat/completions",
        "gateway.example.test",
        "gateway.internal:8443/v1",
        "service.namespace.svc.cluster.local/v1",
        "[::ffff:192.168.1.5]:8443",
        r"\\private-server\models\qwen",
    ] {
        assert!(build_live_known_answer_capture(
            1_777_000_000,
            InvestigationTeamRole::Single,
            quality_unit(),
            vec![LiveKnownAnswerCanonicalScenarioInput {
                scenario_id: "scenario-001".into(),
                reported_model_id: Some(reported_model_id.into()),
                response: response("Insufficient evidence."),
                answer_score: Some(answer()),
                host_score_failed: false,
            }],
        )
        .is_err());
    }

    for reported_model_id in [
        "alibaba/qwen3.6-27b",
        "openai/gpt-oss-120b",
        "mistral/ministral-14b",
    ] {
        assert!(build_live_known_answer_capture(
            1_777_000_000,
            InvestigationTeamRole::Single,
            quality_unit(),
            vec![LiveKnownAnswerCanonicalScenarioInput {
                scenario_id: "scenario-001".into(),
                reported_model_id: Some(reported_model_id.into()),
                response: response("Insufficient evidence."),
                answer_score: Some(answer()),
                host_score_failed: false,
            }],
        )
        .is_ok());
    }
}

#[test]
fn only_explicit_host_score_failure_capture_can_omit_the_score_digest() {
    let capture = build_live_known_answer_capture(
        1_777_000_000,
        InvestigationTeamRole::Single,
        quality_unit(),
        vec![LiveKnownAnswerCanonicalScenarioInput {
            scenario_id: "scenario-001".into(),
            reported_model_id: None,
            response: response("Insufficient evidence."),
            answer_score: None,
            host_score_failed: true,
        }],
    )
    .expect("unscored capture");
    assert_eq!(capture.scenarios[0].answer_score_sha256, None);
    assert!(capture.scenarios[0].host_score_failed);

    let mut mutated = serde_json::to_value(&capture).expect("capture value");
    mutated["scenarios"][0]["host_score_failed"] = serde_json::json!(false);
    assert!(parse_live_known_answer_capture_json(&mutated.to_string()).is_err());

    assert!(build_live_known_answer_capture(
        1_777_000_000,
        InvestigationTeamRole::Single,
        quality_unit(),
        vec![LiveKnownAnswerCanonicalScenarioInput {
            scenario_id: "scenario-001".into(),
            reported_model_id: None,
            response: response("Insufficient evidence."),
            answer_score: None,
            host_score_failed: false,
        }],
    )
    .is_err());

    assert!(build_live_known_answer_capture(
        1_777_000_000,
        InvestigationTeamRole::Single,
        quality_unit(),
        vec![LiveKnownAnswerCanonicalScenarioInput {
            scenario_id: "scenario-001".into(),
            reported_model_id: None,
            response: response("Insufficient evidence."),
            answer_score: Some(answer()),
            host_score_failed: true,
        }],
    )
    .is_err());
}
