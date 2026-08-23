use cd_core::quality_eval::{
    live_known_answer_prompt_set_hash, load_suite, parse_live_known_answer_response,
    parse_live_known_answer_response_classified, prepare_live_known_answer_suite,
    score_live_known_answer_response, serialize_live_known_answer_prompt, CandidateAnswer,
    LiveAnswerClaim, LiveCitation, LiveKnownAnswerResponse, LiveKnownAnswerResponseFailure,
    LoadedSuite, PreparedLiveKnownAnswerCase, LIVE_KNOWN_ANSWER_RESPONSE_MAX_BYTES,
    LIVE_KNOWN_ANSWER_RESPONSE_SCHEMA_ID,
};
use std::path::PathBuf;

fn suite() -> LoadedSuite {
    let root =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/quality-eval/open-v1");
    load_suite(&root).expect("load checked-in OPEN suite")
}

fn response_from_candidate(
    prepared: &PreparedLiveKnownAnswerCase,
    candidate: &CandidateAnswer,
) -> LiveKnownAnswerResponse {
    LiveKnownAnswerResponse {
        schema_id: LIVE_KNOWN_ANSWER_RESPONSE_SCHEMA_ID.into(),
        scenario_id: prepared.prompt().scenario_id.clone(),
        asserts_root_cause_established: candidate.asserts_root_cause_established,
        claims: candidate
            .claims
            .iter()
            .map(|claim| LiveAnswerClaim {
                text: claim.text.clone(),
                citations: claim
                    .evidence_ids
                    .iter()
                    .map(|id| {
                        let evidence = prepared
                            .prompt()
                            .evidence
                            .iter()
                            .find(|evidence| &evidence.evidence_id == id)
                            .expect("candidate evidence exists in fixed prompt");
                        LiveCitation {
                            evidence_id: evidence.evidence_id.clone(),
                            source_id: evidence.source_id.clone(),
                            time_anchor: evidence.time_anchor.clone(),
                        }
                    })
                    .collect(),
                role: claim.role.clone(),
            })
            .collect(),
        conclusion: candidate.conclusion.clone(),
        confidence: candidate.confidence.clone(),
    }
}

fn prepared_index<'a>(
    prepared: &'a [PreparedLiveKnownAnswerCase],
    case_id: &str,
) -> &'a PreparedLiveKnownAnswerCase {
    prepared
        .iter()
        .find(|case| case.host_case_id() == case_id)
        .expect("prepared case")
}

fn candidate<'a>(suite: &'a LoadedSuite, case_id: &str, candidate_id: &str) -> &'a CandidateAnswer {
    suite
        .cases
        .iter()
        .find(|case| case.truth.case_id == case_id)
        .and_then(|case| {
            case.runtime
                .candidates
                .iter()
                .find(|candidate| candidate.candidate_id == candidate_id)
        })
        .expect("scripted candidate")
}

fn score_response(
    prepared: &PreparedLiveKnownAnswerCase,
    response: &LiveKnownAnswerResponse,
    diagnostic: Option<cd_core::quality_eval::ScriptedDiagnostic>,
) -> cd_core::quality_eval::LiveKnownAnswerScore {
    score_live_known_answer_response(prepared, response, diagnostic).expect("score live response")
}

#[test]
fn prepares_all_fourteen_cases_in_manifest_order_with_opaque_ids() {
    let suite = suite();
    let prepared = prepare_live_known_answer_suite(&suite).expect("prepare live suite");

    assert_eq!(prepared.len(), 14);
    for (index, case) in prepared.iter().enumerate() {
        assert_eq!(
            case.prompt().scenario_id,
            format!("scenario-{:03}", index + 1)
        );
        assert_eq!(case.host_case_id(), suite.cases[index].truth.case_id);
        assert_eq!(case.host_task_id(), "t1");
        assert!(!case.prompt().evidence.is_empty());
    }
    assert_eq!(
        prepared
            .iter()
            .filter(|case| case.requires_host_diagnostic())
            .count(),
        4
    );
    assert!(prepared[8..12]
        .iter()
        .all(PreparedLiveKnownAnswerCase::requires_host_diagnostic));
    assert!(prepared[..8]
        .iter()
        .chain(&prepared[12..])
        .all(|case| !case.requires_host_diagnostic()));
}

#[test]
fn provider_bytes_exclude_truth_fixture_and_candidate_identity() {
    let suite = suite();
    let prepared = prepare_live_known_answer_suite(&suite).expect("prepare live suite");

    for (index, case) in prepared.iter().enumerate() {
        let json = serialize_live_known_answer_prompt(case).expect("serialize prompt");
        let lower = json.to_ascii_lowercase();
        assert!(!json.contains(case.host_case_id()));
        assert!(!json.contains(&suite.manifest.cases[index]));
        assert!(!lower.contains("candidate_id"));
        assert!(!lower.contains("task_id"));
        assert!(!lower.contains("packet_id"));
        assert!(!lower.contains("candidate_expectation"));
        assert!(!lower.contains("required_fact_tokens"));
        assert!(!lower.contains("must_include"));
        assert!(!lower.contains("answer_key"));
        assert!(!lower.contains("evaluator_truth"));
        assert!(!lower.contains("fixtures/quality-eval"));
        for candidate in &suite.cases[index].runtime.candidates {
            assert!(!json.contains(&candidate.candidate_id));
        }
    }
}

#[test]
fn prompt_set_hash_is_deterministic_and_binds_visible_bytes() {
    let suite = suite();
    let first = prepare_live_known_answer_suite(&suite).expect("first preparation");
    let second = prepare_live_known_answer_suite(&suite).expect("second preparation");
    let first_hash = live_known_answer_prompt_set_hash(&first).expect("first hash");
    let second_hash = live_known_answer_prompt_set_hash(&second).expect("second hash");

    assert_eq!(first_hash, second_hash);
    assert_eq!(first_hash.len(), 64);
    assert!(first_hash
        .chars()
        .all(|character| character.is_ascii_hexdigit()));
}

#[test]
fn good_answer_passes_and_symptom_promotion_fails_shipped_scorer() {
    let suite = suite();
    let prepared = prepare_live_known_answer_suite(&suite).expect("prepare live suite");
    let case_id = "qe02-symptom-versus-trigger";
    let case = prepared_index(&prepared, case_id);

    let good = response_from_candidate(case, candidate(&suite, case_id, "good_fixed"));
    let good_score = score_response(case, &good, None);
    assert!(
        good_score.answer.passed,
        "{:?}",
        good_score.answer.failed_ids()
    );
    assert_eq!(good_score.answer.expected_outcome, None);
    assert_eq!(good_score.answer.expectation_met, None);

    let mutation =
        response_from_candidate(case, candidate(&suite, case_id, "mut_symptom_as_cause"));
    let mutation_score = score_response(case, &mutation, None);
    assert!(!mutation_score.answer.passed);
    assert!(mutation_score
        .answer
        .failed_ids()
        .iter()
        .any(|id| id.contains("cause_versus_symptom")));
}

#[test]
fn exact_source_time_and_duplicate_citation_mutations_fail() {
    let suite = suite();
    let prepared = prepare_live_known_answer_suite(&suite).expect("prepare live suite");
    let case_id = "qe02-symptom-versus-trigger";
    let case = prepared_index(&prepared, case_id);
    let base = response_from_candidate(case, candidate(&suite, case_id, "good_fixed"));

    let mut wrong_source = base.clone();
    wrong_source.claims[0].citations[0].source_id = "source-999".into();
    let score = score_response(case, &wrong_source, None);
    assert!(!score.answer.passed);
    assert!(score
        .answer
        .failed_ids()
        .contains(&"live_exact_source_time_citations"));

    let mut wrong_time = base.clone();
    wrong_time.claims[0].citations[0].time_anchor = "time-999".into();
    let score = score_response(case, &wrong_time, None);
    assert!(!score.answer.passed);
    assert!(score
        .answer
        .failed_ids()
        .contains(&"live_exact_source_time_citations"));

    let mut unknown_evidence = base.clone();
    unknown_evidence.claims[0].citations[0].evidence_id = "d999".into();
    let score = score_response(case, &unknown_evidence, None);
    assert!(!score.answer.passed);
    assert!(score
        .answer
        .failed_ids()
        .contains(&"no_fabricated_citations"));

    let mut duplicate = base.clone();
    let repeated = duplicate.claims[0].citations[0].clone();
    duplicate.claims[0].citations.push(repeated);
    let score = score_response(case, &duplicate, None);
    assert!(!score.answer.passed);
    assert!(score.answer.failed_ids().contains(&"live_unique_citations"));

    let mut uncited = base;
    uncited.claims[0].citations.clear();
    let score = score_response(case, &uncited, None);
    assert!(!score.answer.passed);
    assert!(score
        .answer
        .failed_ids()
        .contains(&"live_claim_citation_contract"));
}

#[test]
fn response_parser_is_strict_bounded_and_scenario_scoped() {
    let suite = suite();
    let prepared = prepare_live_known_answer_suite(&suite).expect("prepare live suite");
    let case_id = "qe02-symptom-versus-trigger";
    let case = prepared_index(&prepared, case_id);
    let response = response_from_candidate(case, candidate(&suite, case_id, "good_fixed"));
    let raw = serde_json::to_string(&response).expect("serialize response");
    assert_eq!(
        parse_live_known_answer_response(case, &raw).expect("parse valid response"),
        response
    );

    let mut unknown: serde_json::Value = serde_json::from_str(&raw).expect("response value");
    unknown["evaluator_truth"] = serde_json::json!("pretend");
    assert!(parse_live_known_answer_response(case, &unknown.to_string()).is_err());

    let mut provider_diagnostic: serde_json::Value =
        serde_json::from_str(&raw).expect("response value");
    provider_diagnostic["diagnostic"] = serde_json::json!({"claims_useful": true});
    assert!(parse_live_known_answer_response(case, &provider_diagnostic.to_string()).is_err());

    let mut wrong_scenario = response.clone();
    wrong_scenario.scenario_id = "scenario-999".into();
    assert!(parse_live_known_answer_response(
        case,
        &serde_json::to_string(&wrong_scenario).expect("wrong scenario response")
    )
    .is_err());
    assert!(score_live_known_answer_response(case, &wrong_scenario, None).is_err());

    let mut unknown_role = response.clone();
    unknown_role.claims[0].role = Some("persuasive_guess".into());
    assert_eq!(
        parse_live_known_answer_response_classified(
            case,
            &serde_json::to_string(&unknown_role).expect("unknown-role response")
        ),
        Err(LiveKnownAnswerResponseFailure::Vocabulary)
    );
    assert!(parse_live_known_answer_response(
        case,
        &serde_json::to_string(&unknown_role).expect("unknown-role response")
    )
    .is_err());

    let mut unknown_confidence = response.clone();
    unknown_confidence.confidence = "certain".into();
    assert!(parse_live_known_answer_response(
        case,
        &serde_json::to_string(&unknown_confidence).expect("unknown-confidence response")
    )
    .is_err());

    let escaped_secret = raw.replacen(
        "\"conclusion\":\"",
        "\"conclusion\":\"\\u0073k-live-secret ",
        1,
    );
    assert!(!escaped_secret.contains("sk-live-secret"));
    assert_eq!(
        parse_live_known_answer_response_classified(case, &escaped_secret),
        Err(LiveKnownAnswerResponseFailure::Privacy)
    );
    assert!(parse_live_known_answer_response(case, &escaped_secret).is_err());

    let oversized = format!(
        "{{\"padding\":\"{}\"}}",
        "x".repeat(LIVE_KNOWN_ANSWER_RESPONSE_MAX_BYTES)
    );
    assert_eq!(
        parse_live_known_answer_response_classified(case, &oversized),
        Err(LiveKnownAnswerResponseFailure::Parser)
    );
    assert!(parse_live_known_answer_response(case, &oversized).is_err());
}

#[test]
fn response_parser_rejects_prompt_echo_without_reclassifying_schema_or_vocabulary_failures() {
    let suite = suite();
    let prepared = prepare_live_known_answer_suite(&suite).expect("prepare live suite");
    let case = &prepared[0];
    let mut response = response_from_candidate(case, &suite.cases[0].runtime.candidates[0]);
    response.conclusion = case.prompt().question.clone();
    assert_eq!(
        parse_live_known_answer_response_classified(
            case,
            &serde_json::to_string(&response).expect("echo response")
        ),
        Err(LiveKnownAnswerResponseFailure::Privacy)
    );

    for citation_field in ["evidence_id", "source_id", "time_anchor"] {
        let mut citation_echo =
            response_from_candidate(case, &suite.cases[0].runtime.candidates[0]);
        let citation = &mut citation_echo.claims[0].citations[0];
        match citation_field {
            "evidence_id" => citation.evidence_id = case.prompt().question.clone(),
            "source_id" => citation.source_id = case.prompt().question.clone(),
            "time_anchor" => citation.time_anchor = case.prompt().question.clone(),
            _ => unreachable!(),
        }
        assert_eq!(
            parse_live_known_answer_response_classified(
                case,
                &serde_json::to_string(&citation_echo).expect("citation echo response")
            ),
            Err(LiveKnownAnswerResponseFailure::Privacy),
            "{citation_field} prompt echo must fail before scoring",
        );
    }

    let mut invalid_role = response_from_candidate(case, &suite.cases[0].runtime.candidates[0]);
    invalid_role.claims[0].role = Some("unbounded_guess".into());
    assert_eq!(
        parse_live_known_answer_response_classified(
            case,
            &serde_json::to_string(&invalid_role).expect("vocabulary response")
        ),
        Err(LiveKnownAnswerResponseFailure::Vocabulary)
    );
}

#[test]
fn response_parser_rejects_endpoint_route_and_address_forms_without_rejecting_model_ids() {
    let suite = suite();
    let prepared = prepare_live_known_answer_suite(&suite).expect("prepare live suite");
    let case = &prepared[0];

    for endpoint in [
        "10.0.0.5",
        "172.16.10.20/v1",
        "192.168.1.5/chat/completions",
        "127.0.0.1",
        "169.254.10.20",
        "8.8.8.8/v1",
        "203.0.113.10/chat/completions",
        "[::1]:8443",
        "[fd00::1]:8443",
        "[fe80::1]/v1",
        "[::ffff:10.0.0.5]:8443",
        "[::ffff:192.168.1.5]/v1",
        "gateway:8443",
        "/v1",
        "v1/chat/completions",
        "api.example.com/v1",
        "gateway.example.test",
        "gateway.internal/v1",
        "gateway.corp/api",
        "backend.intranet",
        "model-gateway.lan",
        "service.namespace.svc.cluster.local/v1",
        "host.docker.internal",
    ] {
        let mut response = response_from_candidate(case, &suite.cases[0].runtime.candidates[0]);
        response.conclusion = format!("Connect to {endpoint}");
        assert_eq!(
            parse_live_known_answer_response_classified(
                case,
                &serde_json::to_string(&response).expect("endpoint response"),
            ),
            Err(LiveKnownAnswerResponseFailure::Privacy),
            "endpoint, route, or address must be rejected: {endpoint}",
        );
    }

    for (field, endpoint) in [
        ("claim", "8.8.8.8/v1"),
        ("evidence_id", "/v1"),
        ("source_id", "gateway:8443"),
        ("time_anchor", "v1/chat/completions"),
    ] {
        let mut response = response_from_candidate(case, &suite.cases[0].runtime.candidates[0]);
        match field {
            "claim" => response.claims[0].text = endpoint.into(),
            "evidence_id" => response.claims[0].citations[0].evidence_id = endpoint.into(),
            "source_id" => response.claims[0].citations[0].source_id = endpoint.into(),
            "time_anchor" => response.claims[0].citations[0].time_anchor = endpoint.into(),
            _ => unreachable!(),
        }
        assert_eq!(
            parse_live_known_answer_response_classified(
                case,
                &serde_json::to_string(&response).expect("identifier endpoint response"),
            ),
            Err(LiveKnownAnswerResponseFailure::Privacy),
            "provider-controlled {field} must reject endpoint form {endpoint}",
        );
    }

    for model_id in [
        "alibaba/qwen3.6-27b",
        "openai/gpt-oss-120b",
        "mistral/ministral-14b",
    ] {
        let mut response = response_from_candidate(case, &suite.cases[0].runtime.candidates[0]);
        response.conclusion = format!("The configured model is {model_id}.");
        assert!(
            parse_live_known_answer_response_classified(
                case,
                &serde_json::to_string(&response).expect("model response"),
            )
            .is_ok(),
            "legitimate model id must remain accepted: {model_id}",
        );
    }
}

#[test]
fn diagnostic_truth_uses_host_owned_envelope_not_provider_json() {
    let suite = suite();
    let prepared = prepare_live_known_answer_suite(&suite).expect("prepare live suite");
    let case_id = "qe09-attempt-usefulness";
    let case = prepared_index(&prepared, case_id);
    let scripted = candidate(&suite, case_id, "good_mixed_accounted");
    let response = response_from_candidate(case, scripted);

    let missing_host_facts = score_response(case, &response, None);
    assert!(!missing_host_facts.answer.passed);
    assert!(missing_host_facts
        .answer
        .failed_ids()
        .contains(&"diagnostic_envelope_present"));

    let host_joined = score_response(case, &response, scripted.diagnostic.clone());
    assert!(
        host_joined.answer.passed,
        "{:?}",
        host_joined.answer.failed_ids()
    );
}
