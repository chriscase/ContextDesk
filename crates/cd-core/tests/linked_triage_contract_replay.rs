//! Provider-neutral linked multi-stage **contract / replay** suite.
//!
//! Drives the production normalization + host validation path used by
//! multi-stage candidate assessment and final comparison — never a second
//! HTTP client or parallel agent loop. Synthetic fixtures only; no live
//! gateways, Keychain, credentials, URLs, or private paths.
//!
//! Variants cover OpenAI-compatible response shapes observed or plausible
//! for reasoning gateways (including DeepSeek-class servers) without
//! hard-coding any model id.

use cd_core::investigation_answer::{
    validate_model_answer, AnswerBindingV1, ClaimKind, EvidenceRole, HostEvidenceEntry,
    HostEvidenceLedger, LogSnapshotRevisionV1, ValidationError, SCHEMA_V1,
};
use cd_core::linked_triage_contract::{
    classify_final_comparison_outcome, is_empty_visible_terminal, normalize_known_json_wrapper,
    preparation_for_host_validation, visible_text_leaks_reasoning_markers,
    LinkedTriageDiagnosticCategory,
};
use serde_json::json;

fn revision() -> LogSnapshotRevisionV1 {
    LogSnapshotRevisionV1 {
        event_revision: 1,
        template_analysis_revision: 2,
        suppression_revision: 3,
    }
}

fn ledger_two_candidates() -> HostEvidenceLedger {
    let evidence = vec![
        HostEvidenceEntry {
            evidence_id: "e:trace:alpha:11".into(),
            candidate_id: "trace:alpha".into(),
            source_label: "alpha.log".into(),
            locator: "seq=11".into(),
            corpus_id: "c".into(),
            revision: revision(),
            role: EvidenceRole::Cause,
            content: "synthetic alpha evidence".into(),
        },
        HostEvidenceEntry {
            evidence_id: "e:trace:bravo:22".into(),
            candidate_id: "trace:bravo".into(),
            source_label: "bravo.log".into(),
            locator: "seq=22".into(),
            corpus_id: "c".into(),
            revision: revision(),
            role: EvidenceRole::Symptom,
            content: "synthetic bravo evidence".into(),
        },
    ];
    let binding = AnswerBindingV1 {
        session_id: "s".into(),
        turn_id: "t".into(),
        corpus_id: "c".into(),
        revision: revision(),
        ledger_digest: HostEvidenceLedger::digest(&evidence),
    };
    HostEvidenceLedger::new(binding, evidence).unwrap()
}

fn valid_final_json() -> String {
    json!({
        "schema": SCHEMA_V1,
        "candidates": [
            {
                "candidate_id": "trace:alpha",
                "observations": [{
                    "claim_id": "a",
                    "text": "synthetic observation alpha",
                    "evidence_ids": ["e:trace:alpha:11"]
                }]
            },
            {
                "candidate_id": "trace:bravo",
                "observations": [{
                    "claim_id": "b",
                    "text": "synthetic observation bravo",
                    "evidence_ids": ["e:trace:bravo:22"]
                }]
            }
        ]
    })
    .to_string()
}

fn validate_after_normalize(
    raw: &str,
) -> Result<cd_core::investigation_answer::AnswerEnvelopeV1, ValidationError> {
    let prepared = preparation_for_host_validation(raw).map_err(|_| ValidationError::Parse)?;
    validate_model_answer(&prepared, &ledger_two_candidates())
}

// ---------------------------------------------------------------------------
// Variant matrix: bare / fenced / reasoning wrappers
// ---------------------------------------------------------------------------

#[test]
fn bare_candidate_json_validates_on_production_path() {
    let raw = valid_final_json();
    let envelope = validate_after_normalize(&raw).expect("bare JSON");
    let rendered = cd_core::investigation_answer::render_answer_markdown(&envelope);
    let authority = cd_core::investigation_answer::authoritative_json(&envelope);
    assert!(!visible_text_leaks_reasoning_markers(&rendered));
    assert!(!visible_text_leaks_reasoning_markers(&authority));
    assert_eq!(
        classify_final_comparison_outcome(false, Ok(()), 0, false, false),
        LinkedTriageDiagnosticCategory::CompatibleSuccess
    );
}

#[test]
fn fenced_json_unwraps_then_validates() {
    let raw = format!("```json\n{}\n```", valid_final_json());
    let unwrapped = normalize_known_json_wrapper(&raw).expect("fence");
    assert!(unwrapped.starts_with('{'));
    assert!(!unwrapped.contains("```"));
    validate_model_answer(&unwrapped, &ledger_two_candidates()).expect("fenced");
}

#[test]
fn think_wrapper_plus_json_discards_reasoning_from_authority() {
    let reasoning = "I will choose alpha as root but this must never leak";
    let raw = format!("<think>{reasoning}</think>\n{}", valid_final_json());
    let unwrapped = normalize_known_json_wrapper(&raw).expect("think unwrap");
    assert!(!unwrapped.contains(reasoning));
    assert!(!unwrapped.contains("<think>"));
    let envelope = validate_model_answer(&unwrapped, &ledger_two_candidates()).unwrap();
    let rendered = cd_core::investigation_answer::render_answer_markdown(&envelope);
    let authority = cd_core::investigation_answer::authoritative_json(&envelope);
    assert!(!rendered.contains(reasoning));
    assert!(!authority.contains(reasoning));
    assert!(!visible_text_leaks_reasoning_markers(&rendered));
    assert!(!visible_text_leaks_reasoning_markers(&authority));
}

#[test]
fn analysis_wrapper_plus_fenced_json() {
    let raw = format!(
        "<analysis>private chain of thought</analysis>\n```json\n{}\n```",
        valid_final_json()
    );
    let unwrapped = normalize_known_json_wrapper(&raw).expect("analysis+fence");
    assert!(!unwrapped.contains("private chain"));
    validate_model_answer(&unwrapped, &ledger_two_candidates()).unwrap();
}

#[test]
fn reasoning_tag_wrapper_plus_json() {
    let raw = format!(
        "<reasoning>telemetry only</reasoning>\n{}",
        valid_final_json()
    );
    let unwrapped = normalize_known_json_wrapper(&raw).expect("reasoning tag");
    assert!(!unwrapped.contains("telemetry only"));
    validate_model_answer(&unwrapped, &ledger_two_candidates()).unwrap();
}

// ---------------------------------------------------------------------------
// Empty visible + reasoning telemetry → empty terminal, not success
// ---------------------------------------------------------------------------

#[test]
fn empty_visible_with_reasoning_telemetry_is_empty_terminal() {
    let raw = "<think>I have no JSON yet</think>\n   ";
    assert!(is_empty_visible_terminal(raw));
    assert_eq!(
        preparation_for_host_validation(raw),
        Err(LinkedTriageDiagnosticCategory::EmptyTerminalAnswer)
    );
    assert_eq!(
        classify_final_comparison_outcome(true, Ok(()), 0, false, false).as_str(),
        "empty_terminal_answer"
    );
    // Must not be misclassified as compatible success.
    assert_ne!(
        classify_final_comparison_outcome(true, Ok(()), 0, false, false),
        LinkedTriageDiagnosticCategory::CompatibleSuccess
    );
}

// ---------------------------------------------------------------------------
// Malformed JSON / contract failures
// ---------------------------------------------------------------------------

#[test]
fn malformed_json_fails_closed_as_final_comparison_failure() {
    let raw = "{not-json";
    let prepared = preparation_for_host_validation(raw).unwrap();
    let err = validate_model_answer(&prepared, &ledger_two_candidates()).unwrap_err();
    assert_eq!(err, ValidationError::Parse);
    assert_eq!(
        classify_final_comparison_outcome(false, Err(err), 0, false, false),
        LinkedTriageDiagnosticCategory::FinalComparisonFailure
    );
}

#[test]
fn fenced_malformed_json_fails_closed() {
    let raw = "```json\n{broken\n```";
    // Incomplete object inside fence → no unwrap (or unwrap fails validation).
    match normalize_known_json_wrapper(raw) {
        None => {
            // fence with non-object body is rejected by normalizer
        }
        Some(object) => {
            assert!(validate_model_answer(&object, &ledger_two_candidates()).is_err());
        }
    }
}

// ---------------------------------------------------------------------------
// Host-owned evidence / scope / revision / citation fail-closed
// ---------------------------------------------------------------------------

#[test]
fn duplicate_claim_ids_fail_closed() {
    let raw = json!({
        "schema": SCHEMA_V1,
        "candidates": [{
            "candidate_id": "trace:alpha",
            "observations": [
                {"claim_id": "same", "text": "one", "evidence_ids": ["e:trace:alpha:11"]},
                {"claim_id": "same", "text": "two", "evidence_ids": ["e:trace:alpha:11"]}
            ]
        }, {
            "candidate_id": "trace:bravo",
            "observations": [
                {"claim_id": "b", "text": "b", "evidence_ids": ["e:trace:bravo:22"]}
            ]
        }]
    })
    .to_string();
    assert_eq!(
        validate_model_answer(&raw, &ledger_two_candidates()).unwrap_err(),
        ValidationError::DuplicateId
    );
}

#[test]
fn wrong_candidate_evidence_scope_fails_closed() {
    // Bravo evidence attached to alpha candidate.
    let raw = json!({
        "schema": SCHEMA_V1,
        "candidates": [{
            "candidate_id": "trace:alpha",
            "observations": [{
                "claim_id": "a",
                "text": "cross scope",
                "evidence_ids": ["e:trace:bravo:22"]
            }]
        }, {
            "candidate_id": "trace:bravo",
            "observations": [{
                "claim_id": "b",
                "text": "ok",
                "evidence_ids": ["e:trace:bravo:22"]
            }]
        }]
    })
    .to_string();
    assert_eq!(
        validate_model_answer(&raw, &ledger_two_candidates()).unwrap_err(),
        ValidationError::WrongScope
    );
}

#[test]
fn wrong_revision_fails_closed_at_ledger_construction() {
    // Production host ledger construction refuses entry/binding revision
    // mismatch (WrongRevision). validate_model_answer's WrongRevision arm is
    // defensive once a ledger is built — see investigation_answer unit tests.
    let mut evidence = ledger_two_candidates().entries();
    evidence[0].revision.event_revision = 99;
    let binding = AnswerBindingV1 {
        session_id: "s".into(),
        turn_id: "t".into(),
        corpus_id: "c".into(),
        revision: revision(), // event_revision still 1
        ledger_digest: HostEvidenceLedger::digest(&evidence),
    };
    assert_eq!(
        HostEvidenceLedger::new(binding, evidence).unwrap_err(),
        ValidationError::WrongRevision
    );
}

#[test]
fn unknown_evidence_citation_fails_closed() {
    let forged = json!({
        "schema": SCHEMA_V1,
        "candidates": [{
            "candidate_id": "trace:alpha",
            "observations": [{
                "claim_id": "a",
                "text": "forged",
                "evidence_ids": ["e:trace:alpha:11"]
            }]
        }, {
            "candidate_id": "trace:bravo",
            "observations": [{
                "claim_id": "b",
                "text": "ok",
                "evidence_ids": ["e:nonexistent:0"]
            }]
        }]
    })
    .to_string();
    assert_eq!(
        validate_model_answer(&forged, &ledger_two_candidates()).unwrap_err(),
        ValidationError::UnknownEvidence
    );
}

// ---------------------------------------------------------------------------
// Valid candidate then invalid final comparison
// ---------------------------------------------------------------------------

#[test]
fn valid_then_invalid_final_comparison_classified_distinctly() {
    // Candidate-shaped JSON normalizes (production unwrap path). Final
    // comparison against host ledger fails closed with a real ValidationError.
    let candidate_like = json!({
        "schema": "contextdesk.candidate_assessment.v1",
        "candidate_id": "trace:alpha",
        "classification": "supporting_evidence",
        "analysis": "bounded",
        "evidence_seqs": [11]
    })
    .to_string();
    assert!(normalize_known_json_wrapper(&candidate_like).is_some());

    let bad_final = r#"{"schema":"contextdesk.investigation_answer.v1","candidates":[]}"#;
    let err = validate_model_answer(bad_final, &ledger_two_candidates()).unwrap_err();
    // Production multi-stage maps non-empty validation failure → FinalComparisonFailure
    // (see agent::tests::multi_stage_final_comparison_preserves_ordered_validation_categories).
    let cat = classify_final_comparison_outcome(false, Err(err), 0, false, false);
    assert_eq!(cat, LinkedTriageDiagnosticCategory::FinalComparisonFailure);
    assert_ne!(
        cat.as_str(),
        LinkedTriageDiagnosticCategory::CandidateContractFailure.as_str(),
        "final comparison failure must not collapse into candidate_contract"
    );
    assert_ne!(
        cat.as_str(),
        LinkedTriageDiagnosticCategory::EmptyTerminalAnswer.as_str()
    );
}

// ---------------------------------------------------------------------------
// Empty vs parse fork (production preparation_for_host_validation)
// Full multi-stage correction/timeout/transport mapping is in agent::tests.
// ---------------------------------------------------------------------------

#[test]
fn preparation_path_distinguishes_empty_terminal_from_malformed_parse() {
    assert_eq!(
        preparation_for_host_validation("<think>only thoughts</think>"),
        Err(LinkedTriageDiagnosticCategory::EmptyTerminalAnswer)
    );
    let malformed = preparation_for_host_validation("{not-json").unwrap();
    assert_eq!(
        validate_model_answer(&malformed, &ledger_two_candidates()).unwrap_err(),
        ValidationError::Parse
    );
    assert!(is_empty_visible_terminal("<think>x</think>"));
    assert!(!is_empty_visible_terminal("{not-json"));
}

// ---------------------------------------------------------------------------
// Tool-call continuation vs final-answer channels
// ---------------------------------------------------------------------------

#[test]
fn tool_call_shaped_payload_is_not_a_final_answer() {
    // OpenAI tool-call channel: no investigation schema — must not validate as answer.
    let tool_channel = json!({
        "role": "assistant",
        "tool_calls": [{
            "id": "call_1",
            "type": "function",
            "function": {"name": "search_logs", "arguments": "{}"}
        }]
    })
    .to_string();
    let prepared = preparation_for_host_validation(&tool_channel).unwrap();
    assert!(
        validate_model_answer(&prepared, &ledger_two_candidates()).is_err(),
        "tool-call channel must not pass as final investigation answer"
    );
}

#[test]
fn final_answer_channel_is_json_object_not_tool_calls() {
    let final_channel = valid_final_json();
    let envelope = validate_after_normalize(&final_channel).unwrap();
    let authority = cd_core::investigation_answer::authoritative_json(&envelope);
    assert!(authority.contains(SCHEMA_V1));
    assert!(!authority.contains("tool_calls"));
}

// ---------------------------------------------------------------------------
// Category labels (stable wire strings) — production multi-stage mapping is
// proven in agent::tests::multi_stage_*_empty_terminal_* and
// multi_stage_outcome_classifier_maps_transport_and_timeout.
// ---------------------------------------------------------------------------

#[test]
fn transport_and_timeout_labels_remain_distinct_from_contract_failures() {
    assert_ne!(
        LinkedTriageDiagnosticCategory::TransportFailure.as_str(),
        LinkedTriageDiagnosticCategory::FinalComparisonFailure.as_str()
    );
    assert_ne!(
        LinkedTriageDiagnosticCategory::Timeout.as_str(),
        LinkedTriageDiagnosticCategory::CandidateContractFailure.as_str()
    );
    assert_ne!(
        LinkedTriageDiagnosticCategory::EmptyTerminalAnswer.as_str(),
        LinkedTriageDiagnosticCategory::FinalComparisonFailure.as_str()
    );
}

// ---------------------------------------------------------------------------
// Reasoning never in authoritative JSON after successful unwrap
// ---------------------------------------------------------------------------

#[test]
fn think_then_valid_json_authoritative_json_has_no_reasoning() {
    let secret_thought = "SECRET_REASONING_TOKEN_xyz";
    let raw = format!("<think>{secret_thought}</think>\n{}", valid_final_json());
    let object = normalize_known_json_wrapper(&raw).unwrap();
    let envelope = validate_model_answer(&object, &ledger_two_candidates()).unwrap();
    let authority = cd_core::investigation_answer::authoritative_json(&envelope);
    let rendered = cd_core::investigation_answer::render_answer_markdown(&envelope);
    assert!(!authority.contains(secret_thought));
    assert!(!rendered.contains(secret_thought));
    assert!(!authority.contains("<think>"));
    assert!(!rendered.contains("<think>"));
}

// ---------------------------------------------------------------------------
// Category matrix completeness
// ---------------------------------------------------------------------------

#[test]
fn diagnostic_category_matrix_covers_required_labels() {
    let required = [
        "candidate_contract_failure",
        "final_comparison_failure",
        "empty_terminal_answer",
        "transport_failure",
        "timeout",
        "successful_bounded_correction",
        "compatible_success",
    ];
    let labels = [
        LinkedTriageDiagnosticCategory::CandidateContractFailure,
        LinkedTriageDiagnosticCategory::FinalComparisonFailure,
        LinkedTriageDiagnosticCategory::EmptyTerminalAnswer,
        LinkedTriageDiagnosticCategory::TransportFailure,
        LinkedTriageDiagnosticCategory::Timeout,
        LinkedTriageDiagnosticCategory::SuccessfulBoundedCorrection,
        LinkedTriageDiagnosticCategory::CompatibleSuccess,
    ]
    .map(|c| c.as_str());
    for (need, got) in required.iter().zip(labels.iter()) {
        assert_eq!(need, got);
    }
    // All unique.
    let set: std::collections::BTreeSet<_> = labels.into_iter().collect();
    assert_eq!(set.len(), 7);
}

#[test]
fn fixtures_contain_no_secrets_urls_or_private_paths() {
    let samples = [
        valid_final_json(),
        format!("<think>x</think>\n{}", valid_final_json()),
        "```json\n{\"schema\":\"contextdesk.investigation_answer.v1\",\"candidates\":[]}\n```"
            .into(),
    ];
    for s in samples {
        assert!(!s.contains("sk-"));
        assert!(!s.contains("Bearer "));
        assert!(!s.contains("/Users/"));
        assert!(!s.contains("api_key"));
        assert!(!s.contains("https://"));
        assert!(!s.contains("Authorization"));
    }
}

// Silence unused ClaimKind import warning if not used — use in comment-level assert
#[test]
fn claim_kind_surface_still_exported_for_hosts() {
    let _ = ClaimKind::Observation;
}
