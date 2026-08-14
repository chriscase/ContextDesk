//! Hermetic cheap-model fast-triage contribution benchmark (integration).
//!
//! Drives the **shipped** packet builder, `validate_fast_answer`, and host
//! assembly. No network, credentials, Keychain, second HTTP client, or fake
//! production workflow.

use cd_core::cheap_model_fast_triage_benchmark::{
    assemble_role_decomposition, benchmark_case, golden_matrix, list_case_ids, path_a_candidate,
    path_b_roles, run_benchmark_matrix, score_path_a, score_path_b, CandidateKind, CaseId,
    ContributionVerdict, PathLabel, RoleDecompositionInputs,
    CHEAP_MODEL_FAST_TRIAGE_BENCHMARK_SCHEMA_V1,
};
use cd_core::fast_triage::{validate_fast_answer, FastTriageFailureCategory, FastTriageValidation};
use cd_core::quality_eval::{scan_privacy_text, PRIVACY_FORBIDDEN_SUBSTRINGS};

#[test]
fn schema_id_is_stable() {
    assert_eq!(
        CHEAP_MODEL_FAST_TRIAGE_BENCHMARK_SCHEMA_V1,
        "contextdesk.cheap_model_fast_triage_benchmark.v1"
    );
}

#[test]
fn cases_cover_required_scenario_shapes() {
    let ids = list_case_ids();
    assert!(ids.contains(&CaseId::CompleteTimeline));
    assert!(ids.contains(&CaseId::TriggerRecoveryCrossSource));
    assert!(ids.contains(&CaseId::ContradictionAndDecoy));
    assert!(ids.contains(&CaseId::ChronologySensitive));

    let complete = benchmark_case(CaseId::CompleteTimeline);
    assert!(complete.true_cause_evidence_id.is_some());
    assert!(complete.primary_symptom_evidence_id.is_some());
    assert!(!complete.independent_noise_ids.is_empty());

    let recovery = benchmark_case(CaseId::TriggerRecoveryCrossSource);
    assert!(recovery.recovery_evidence_id.is_some());

    // Opaque host ids only.
    for id in ids {
        let case = benchmark_case(*id);
        for row in case.packet.rows() {
            assert!(row.evidence_id.starts_with("e:"));
            assert!(!row.evidence_id.contains("sk-"));
            assert!(!row.evidence_id.contains("/Users/"));
            assert!(!row.evidence_id.contains("http"));
        }
    }
}

#[test]
fn path_a_strong_and_sloppy_accept_on_complete_timeline() {
    let case = benchmark_case(CaseId::CompleteTimeline);
    for kind in [
        CandidateKind::StrongStructured,
        CandidateKind::SloppyRecoverable,
    ] {
        let score = score_path_a(&case, &path_a_candidate(&case, kind));
        assert_eq!(score.verdict, ContributionVerdict::Accepted, "{kind:?}");
        assert!(score.credit.root_cause_established, "{kind:?}");
        assert!(score.credit.roles.prose_alone_never_credits);
    }
}

#[test]
fn path_a_mutations_fail_closed() {
    let case = benchmark_case(CaseId::CompleteTimeline);
    let checks = [
        (
            CandidateKind::FabricatedCitation,
            FastTriageFailureCategory::ForeignEvidenceId,
        ),
        (
            CandidateKind::InvalidStructuredOutput,
            FastTriageFailureCategory::MalformedTerminal,
        ),
        (
            CandidateKind::OverconfidentCheapAnswer,
            FastTriageFailureCategory::MalformedTerminal,
        ),
        (
            CandidateKind::SymptomPromotedToCause,
            FastTriageFailureCategory::SymptomPromotedToCause,
        ),
        (
            CandidateKind::RoleConfusion,
            FastTriageFailureCategory::ContradictoryRoles,
        ),
        (
            CandidateKind::OmittedEvidence,
            FastTriageFailureCategory::RoleCoverage,
        ),
    ];
    for (kind, expected) in checks {
        let score = score_path_a(&case, &path_a_candidate(&case, kind));
        assert_eq!(
            score.verdict,
            ContributionVerdict::Rejected,
            "{kind:?} should reject"
        );
        assert!(
            score.failure_categories.contains(&expected),
            "{kind:?} expected {expected:?}, got {:?}",
            score.failure_categories
        );
        assert!(!score.credit.root_cause_established);
    }
}

#[test]
fn chronology_error_fails_on_chronology_sensitive_case() {
    let case = benchmark_case(CaseId::ChronologySensitive);
    let score = score_path_a(
        &case,
        &path_a_candidate(&case, CandidateKind::ChronologyError),
    );
    assert_eq!(score.verdict, ContributionVerdict::Rejected);
    assert!(
        score.failure_categories.iter().any(|c| matches!(
            c,
            FastTriageFailureCategory::ChronologyInverted
                | FastTriageFailureCategory::SymptomPromotedToCause
                | FastTriageFailureCategory::ContradictoryRoles
        )),
        "got {:?}",
        score.failure_categories
    );
}

#[test]
fn unsupported_causal_claim_never_earns_root() {
    let case = benchmark_case(CaseId::CompleteTimeline);
    let score = score_path_a(
        &case,
        &path_a_candidate(&case, CandidateKind::UnsupportedCausalClaim),
    );
    assert_eq!(score.verdict, ContributionVerdict::Rejected);
    assert!(!score.credit.root_cause_established);
}

#[test]
fn partial_extraction_may_credit_but_not_accept() {
    let case = benchmark_case(CaseId::CompleteTimeline);
    let score = score_path_a(
        &case,
        &path_a_candidate(&case, CandidateKind::UsefulPartialExtraction),
    );
    assert_eq!(score.verdict, ContributionVerdict::Rejected);
    assert!(score.credit.partial_extraction_credit || score.credit.roles.extraction_useful);
    assert!(!score.credit.root_cause_established);
}

#[test]
fn path_b_strong_assembly_uses_real_validator() {
    let case = benchmark_case(CaseId::CompleteTimeline);
    let roles = path_b_roles(&case, CandidateKind::StrongStructured);
    let body = assemble_role_decomposition(RoleDecompositionInputs {
        case: &case,
        roles: &roles,
    });
    match validate_fast_answer(&body, &case.packet) {
        FastTriageValidation::Accepted(env) => {
            assert!(env.answer.root_cause_established);
        }
        FastTriageValidation::Rejected(cats) => {
            panic!("path B strong rejected: {cats:?}\nbody={body}");
        }
    }
    let score = score_path_b(&case, &roles);
    assert_eq!(score.verdict, ContributionVerdict::Accepted);
    assert!(score.credit.roles.extraction_useful);
    assert!(score.credit.roles.causal_proposal_useful);
}

#[test]
fn path_b_fabricated_and_invalid_fail_closed() {
    let case = benchmark_case(CaseId::TriggerRecoveryCrossSource);
    for kind in [
        CandidateKind::FabricatedCitation,
        CandidateKind::InvalidStructuredOutput,
        CandidateKind::OverconfidentCheapAnswer,
    ] {
        let score = score_path_b(&case, &path_b_roles(&case, kind));
        assert_eq!(score.verdict, ContributionVerdict::Rejected, "{kind:?}");
        assert!(!score.credit.root_cause_established, "{kind:?}");
    }
}

#[test]
fn path_b_partial_extraction_with_abstention_stays_host_owned() {
    let case = benchmark_case(CaseId::ContradictionAndDecoy);
    let roles = path_b_roles(&case, CandidateKind::UsefulPartialExtraction);
    assert!(roles.contradiction.force_abstention);
    let score = score_path_b(&case, &roles);
    assert_eq!(score.verdict, ContributionVerdict::Rejected);
    // Must not invent root cause from extraction alone.
    assert!(!score.credit.root_cause_established);
}

#[test]
fn full_matrix_matches_goldens_deterministically() {
    let first = run_benchmark_matrix();
    let second = run_benchmark_matrix();
    assert_eq!(first.rows.len(), second.rows.len());
    assert_eq!(first.matched, second.matched);
    assert_eq!(first.mismatched, 0, "first run had mismatches");
    assert_eq!(second.mismatched, 0, "second run had mismatches");
    for (a, b) in first.rows.iter().zip(second.rows.iter()) {
        assert_eq!(a.matched_golden, b.matched_golden);
        assert_eq!(a.score.verdict, b.score.verdict);
        assert_eq!(a.score.failure_categories, b.score.failure_categories);
        // Latency/token are labels only — stable for the same fixtures.
        assert_eq!(a.latency_label_ms, b.latency_label_ms);
        assert_eq!(a.token_budget_label, b.token_budget_label);
    }
    // 4 cases × 12 kinds × 2 paths
    assert_eq!(first.rows.len(), 96);
    assert_eq!(first.matched, 96);
}

#[test]
fn golden_matrix_covers_both_paths_and_failure_shapes() {
    let g = golden_matrix();
    assert!(g.iter().any(|e| e.path == PathLabel::A));
    assert!(g.iter().any(|e| e.path == PathLabel::B));
    assert!(g
        .iter()
        .any(|e| e.kind == CandidateKind::FabricatedCitation));
    assert!(g.iter().any(|e| e.kind == CandidateKind::ChronologyError));
    assert!(g
        .iter()
        .any(|e| e.kind == CandidateKind::UsefulPartialExtraction));
}

#[test]
fn fixtures_are_share_safe() {
    for id in list_case_ids() {
        let case = benchmark_case(*id);
        for row in case.packet.rows() {
            for needle in PRIVACY_FORBIDDEN_SUBSTRINGS {
                assert!(
                    !row.evidence_id.to_lowercase().contains(needle),
                    "evidence id leaked privacy needle {needle}"
                );
            }
            let scan = scan_privacy_text(&row.evidence_id);
            assert!(
                scan.is_empty(),
                "privacy scan failed for {}: {scan:?}",
                row.evidence_id
            );
        }
        for kind in [
            CandidateKind::StrongStructured,
            CandidateKind::OverconfidentCheapAnswer,
            CandidateKind::FabricatedCitation,
        ] {
            let body = path_a_candidate(&case, kind).proposal_body;
            for forbidden in [
                "sk-",
                "/Users/",
                "api_key",
                "Authorization",
                "Bearer ",
                "http://",
                "https://",
            ] {
                assert!(
                    !body.contains(forbidden),
                    "proposal leaked {forbidden} for {:?}",
                    kind
                );
            }
        }
    }
}

#[test]
fn unsupported_cause_never_earns_partial_credit_on_any_case_or_path() {
    for id in list_case_ids() {
        let case = benchmark_case(*id);
        for kind in [
            CandidateKind::UnsupportedCausalClaim,
            CandidateKind::RoleConfusion,
            CandidateKind::SymptomPromotedToCause,
            CandidateKind::FabricatedCitation,
        ] {
            let a = score_path_a(&case, &path_a_candidate(&case, kind));
            let b = score_path_b(&case, &path_b_roles(&case, kind));
            assert_eq!(
                a.verdict,
                ContributionVerdict::Rejected,
                "{id:?} {kind:?} A"
            );
            assert_eq!(
                b.verdict,
                ContributionVerdict::Rejected,
                "{id:?} {kind:?} B"
            );
            assert!(
                !a.credit.partial_extraction_credit,
                "path A partial wrongly set for {id:?} {kind:?}"
            );
            assert!(
                !b.credit.partial_extraction_credit,
                "path B partial wrongly set for {id:?} {kind:?}"
            );
        }
    }
}

#[test]
fn path_b_invalid_structure_is_not_overconfident_prose_duplicate() {
    let case = benchmark_case(CaseId::CompleteTimeline);
    let invalid = path_b_roles(&case, CandidateKind::InvalidStructuredOutput);
    let overconfident = path_b_roles(&case, CandidateKind::OverconfidentCheapAnswer);
    let inv_body = invalid
        .reviewer
        .optional_full_proposal
        .as_deref()
        .expect("invalid path B must supply a full proposal body");
    let over_body = overconfident
        .reviewer
        .optional_full_proposal
        .as_deref()
        .expect("overconfident path B must supply a full proposal body");
    assert_ne!(
        inv_body, over_body,
        "path B InvalidStructuredOutput must not reuse overconfident free-text"
    );
    assert!(
        inv_body.contains("```") || inv_body.contains("\"not\""),
        "invalid structure fixture should be non-schema JSON, got {inv_body}"
    );
    let score = score_path_b(&case, &invalid);
    assert_eq!(score.verdict, ContributionVerdict::Rejected);
    assert!(score
        .failure_categories
        .contains(&FastTriageFailureCategory::MalformedTerminal));
    assert!(!score.credit.partial_extraction_credit);
}

#[test]
fn matrix_forbids_partial_credit_when_golden_disallows_it() {
    let run = run_benchmark_matrix();
    for row in &run.rows {
        if !row.expectation.allow_partial_extraction_credit {
            assert!(
                !row.score.credit.partial_extraction_credit,
                "golden forbids partial credit: {} {} {}",
                row.expectation.case_id.as_str(),
                row.expectation.path.as_str(),
                row.expectation.kind.as_str()
            );
        }
    }
    assert_eq!(run.mismatched, 0);
}

#[test]
fn latency_and_token_labels_do_not_affect_verdict() {
    let case = benchmark_case(CaseId::CompleteTimeline);
    let mut a = path_a_candidate(&case, CandidateKind::StrongStructured);
    let base = score_path_a(&case, &a);
    a.latency_label_ms = 99_999;
    a.token_budget_label = 1;
    let mutated_labels = score_path_a(&case, &a);
    assert_eq!(base.verdict, mutated_labels.verdict);
    assert_eq!(
        base.credit.root_cause_established,
        mutated_labels.credit.root_cause_established
    );
}
