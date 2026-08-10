//! Hermetic adversarial quality-eval suite integration tests.
//!
//! No network, Keychain, Grok session, or live model calls.

use cd_core::quality_eval::{
    expectation_accounting, load_suite, run_hermetic_suite, run_suite_matrix,
    scan_runtime_isolation, CandidateExpectation, HermeticRunOptions, LaneStatus,
    BUNDLED_ADVERSARIAL_V1_RELATIVE, BUNDLED_OPEN_V1_RELATIVE, RUNTIME_FORBIDDEN_EVALUATOR_TOKENS,
};
use std::path::{Path, PathBuf};

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn adversarial_root() -> PathBuf {
    repo_root().join(BUNDLED_ADVERSARIAL_V1_RELATIVE)
}

fn open_root() -> PathBuf {
    repo_root().join(BUNDLED_OPEN_V1_RELATIVE)
}

#[test]
fn adversarial_suite_loads_with_opaque_ids_and_no_truth_leakage() {
    let suite = load_suite(&adversarial_root()).expect("load adversarial suite");
    assert_eq!(suite.manifest.suite_id, "quality-eval-adversarial-v1");
    assert!(suite.cases.len() >= 12, "expected >=12 cases");
    assert_eq!(suite.digest.len(), 64);

    for case in &suite.cases {
        let findings = scan_runtime_isolation(&case.runtime);
        assert!(
            findings.is_empty(),
            "case {} leaked evaluator tokens: {findings:?}",
            case.case_dir
        );
        for doc in &case.runtime.documents {
            assert!(
                doc.id.strip_prefix('d').is_some_and(
                    |digits| !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit())
                ),
                "opaque id required: {}",
                doc.id
            );
        }
        for surface in case
            .runtime
            .documents
            .iter()
            .map(|d| d.text.as_str())
            .chain(case.runtime.questions.values().map(String::as_str))
            .chain(
                case.runtime
                    .candidates
                    .iter()
                    .map(|c| c.conclusion.as_str()),
            )
        {
            let lower = surface.to_ascii_lowercase();
            for token in RUNTIME_FORBIDDEN_EVALUATOR_TOKENS {
                assert!(
                    !lower.contains(&token.to_ascii_lowercase()),
                    "{} contains forbidden token {token}",
                    case.case_dir
                );
            }
            assert!(
                !lower.contains("answer key") && !lower.contains("truth.json"),
                "host truth vocabulary leaked into {}",
                case.case_dir
            );
        }
    }
}

#[test]
fn adversarial_hermetic_run_meets_all_host_expectations() {
    let suite = load_suite(&adversarial_root()).expect("load");
    let record = run_hermetic_suite(&suite, &HermeticRunOptions::default());
    assert_eq!(record.status, LaneStatus::Executed, "suite failed");
    assert!(record.evidence_classes.compatibility_untouched);
    assert!(record.evidence_classes.retrieval_quality);
    assert!(record.evidence_classes.answer_quality);
    assert!(!record.evidence_classes.live_optional);
    assert_eq!(record.judge.status, LaneStatus::NotScheduled);

    let accounting = expectation_accounting(&record);
    assert!(accounting.expected_pass_met > 0);
    assert!(accounting.expected_fail_met > 0);
    assert_eq!(accounting.expected_pass_missed, 0);
    assert_eq!(accounting.expected_fail_missed, 0);
    assert_eq!(accounting.undeclared, 0);

    for case in &record.cases {
        assert_eq!(case.status, LaneStatus::Executed, "{}", case.case_id);
        for ans in &case.answers {
            assert_eq!(ans.expectation_met, Some(true), "{}", ans.candidate_id);
            match ans.expected_outcome {
                Some(CandidateExpectation::Pass) => assert!(ans.passed),
                Some(CandidateExpectation::Fail) => assert!(!ans.passed),
                None => panic!("undeclared {}", ans.candidate_id),
            }
        }
    }
}

#[test]
fn adversarial_trigger_cannot_mask_promoted_symptom() {
    let suite = load_suite(&adversarial_root()).unwrap();
    let record = run_hermetic_suite(&suite, &HermeticRunOptions::default());
    let ans = record
        .cases
        .iter()
        .flat_map(|c| c.answers.iter())
        .find(|a| a.candidate_id == "mut_trigger_plus_promoted_symptom")
        .expect("mutation");
    assert!(!ans.passed);
    assert_eq!(ans.expectation_met, Some(true));
    assert!(ans.failed_ids().contains(&"cause_versus_symptom"));
}

#[test]
fn adversarial_trigger_cannot_mask_absorbed_independent() {
    let suite = load_suite(&adversarial_root()).unwrap();
    let record = run_hermetic_suite(&suite, &HermeticRunOptions::default());
    let ans = record
        .cases
        .iter()
        .flat_map(|c| c.answers.iter())
        .find(|a| a.candidate_id == "mut_absorb_independent")
        .expect("mutation");
    assert!(!ans.passed);
    assert_eq!(ans.expectation_met, Some(true));
    assert!(ans
        .failed_ids()
        .contains(&"independent_incident_separation"));
}

#[test]
fn adversarial_hedged_structured_causality_fails_abstention() {
    let suite = load_suite(&adversarial_root()).unwrap();
    let record = run_hermetic_suite(&suite, &HermeticRunOptions::default());
    let ans = record
        .cases
        .iter()
        .flat_map(|c| c.answers.iter())
        .find(|a| a.candidate_id == "mut_hedged_but_asserts_causality")
        .expect("mutation");
    assert!(!ans.passed);
    assert_eq!(ans.expectation_met, Some(true));
    assert!(
        ans.failed_ids().contains(&"abstention_contract")
            || ans.failed_ids().contains(&"honest_abstention")
    );
}

#[test]
fn adversarial_generic_abstention_without_observation_fails() {
    let suite = load_suite(&adversarial_root()).unwrap();
    let record = run_hermetic_suite(&suite, &HermeticRunOptions::default());
    let ans = record
        .cases
        .iter()
        .flat_map(|c| c.answers.iter())
        .find(|a| a.candidate_id == "mut_generic_abstention")
        .expect("mutation");
    assert!(!ans.passed);
    assert!(ans.failed_ids().contains(&"abstention_evidence_basis"));
}

#[test]
fn adversarial_citation_sprinkle_without_decisive_facts_fails() {
    let suite = load_suite(&adversarial_root()).unwrap();
    let record = run_hermetic_suite(&suite, &HermeticRunOptions::default());
    let ans = record
        .cases
        .iter()
        .flat_map(|c| c.answers.iter())
        .find(|a| a.candidate_id == "mut_citation_sprinkle")
        .expect("mutation");
    assert!(!ans.passed);
    assert!(ans.failed_ids().contains(&"decisive_fact_coverage"));
}

#[test]
fn adversarial_decisive_facts_with_foreign_identity_fail() {
    let suite = load_suite(&adversarial_root()).unwrap();
    let record = run_hermetic_suite(&suite, &HermeticRunOptions::default());
    let ans = record
        .cases
        .iter()
        .flat_map(|c| c.answers.iter())
        .find(|a| a.candidate_id == "mut_decisive_facts_foreign_id")
        .expect("mutation");
    assert!(!ans.passed);
    assert!(
        ans.failed_ids().contains(&"no_forbidden_citations")
            || ans.failed_ids().contains(&"decoy_rejection")
    );
}

#[test]
fn adversarial_unknown_role_and_confidence_fail_closed() {
    let suite = load_suite(&adversarial_root()).unwrap();
    let record = run_hermetic_suite(&suite, &HermeticRunOptions::default());
    for id in ["mut_unknown_role", "mut_unknown_confidence"] {
        let ans = record
            .cases
            .iter()
            .flat_map(|c| c.answers.iter())
            .find(|a| a.candidate_id == id)
            .unwrap_or_else(|| panic!("missing {id}"));
        assert!(!ans.passed, "{id}");
        assert_eq!(ans.expectation_met, Some(true));
        assert!(ans.failed_ids().contains(&"answer_schema_validity"));
    }
}

#[test]
fn adversarial_expected_fail_mutations_are_not_harness_failures() {
    let suite = load_suite(&adversarial_root()).unwrap();
    let record = run_hermetic_suite(&suite, &HermeticRunOptions::default());
    let mut saw = false;
    for case in &record.cases {
        for ans in &case.answers {
            if ans.expected_outcome == Some(CandidateExpectation::Fail) {
                saw = true;
                assert!(!ans.passed);
                assert_eq!(ans.expectation_met, Some(true));
            }
        }
        assert_eq!(case.status, LaneStatus::Executed);
    }
    assert!(saw);
    assert_eq!(record.status, LaneStatus::Executed);
}

#[test]
fn adversarial_candidate_names_carry_no_evaluator_authority() {
    let mut suite = load_suite(&adversarial_root()).unwrap();
    let case = suite
        .cases
        .iter_mut()
        .find(|c| c.case_dir == "adv04-trigger-plus-promoted-symptom")
        .expect("case");
    let renames = [
        ("good_fixed", "alpha_candidate"),
        ("mut_trigger_plus_promoted_symptom", "beta_candidate"),
        ("mut_citation_sprinkle", "gamma_candidate"),
    ];
    for (from, to) in renames {
        case.runtime
            .candidates
            .iter_mut()
            .find(|c| c.candidate_id == from)
            .expect(from)
            .candidate_id = to.into();
        let expectation = case.truth.candidate_expectations.remove(from).expect(from);
        case.truth
            .candidate_expectations
            .insert(to.into(), expectation);
    }
    let record = run_hermetic_suite(&suite, &HermeticRunOptions::default());
    let case_result = record
        .cases
        .iter()
        .find(|c| c.case_id == "adv04-trigger-plus-promoted-symptom")
        .expect("result");
    assert_eq!(case_result.status, LaneStatus::Executed);
}

#[test]
fn adversarial_retrieval_ablations_expose_upstream_versus_final_loss() {
    let suite = load_suite(&adversarial_root()).unwrap();
    let record = run_hermetic_suite(&suite, &HermeticRunOptions::default());
    let case = record
        .cases
        .iter()
        .find(|c| c.case_id == "adv14-retrieval-packet-ablations")
        .expect("adv14");
    assert!(case.retrieval.len() >= 6);
    let dropped = case
        .retrieval
        .iter()
        .find(|m| m.query_id == "q_dropped")
        .expect("q_dropped");
    assert_eq!(dropped.status, LaneStatus::Executed);
    assert!(dropped.upstream_recall_at_k.is_some());
    assert!(dropped.final_recall_at_k.is_some());
    let upstream = dropped.upstream_recall_at_k.unwrap();
    let final_recall = dropped.final_recall_at_k.unwrap();
    assert!(
        upstream > final_recall,
        "dropped decisive evidence should reduce final recall; upstream={upstream} final={final_recall}"
    );
    let short = case
        .retrieval
        .iter()
        .find(|m| m.query_id == "q_short")
        .expect("q_short");
    assert!(short.ndcg_at_k < 1.0);
    let padded = case
        .retrieval
        .iter()
        .find(|m| m.query_id == "q_padded")
        .expect("q_padded");
    assert!(padded.must_exclude_rate > 0.0 || padded.foreign_incident_hits > 0);
}

#[test]
fn open_v1_digest_unchanged_by_adversarial_suite_presence() {
    let open = load_suite(&open_root()).expect("open");
    let open2 = load_suite(&open_root()).expect("open reload");
    assert_eq!(open.digest, open2.digest);
    let adv = load_suite(&adversarial_root()).expect("adv");
    assert_ne!(open.digest, adv.digest);
    assert_eq!(open.manifest.suite_id, "quality-eval-open-v1");
}

#[test]
fn suite_matrix_runs_open_and_adversarial_without_merging_digests() {
    let summary = run_suite_matrix(
        &[open_root(), adversarial_root()],
        &HermeticRunOptions::default(),
    )
    .expect("matrix");
    assert_eq!(summary.status, LaneStatus::Executed);
    assert_eq!(summary.suites.len(), 2);
    assert_ne!(
        summary.suites[0].suite_digest,
        summary.suites[1].suite_digest
    );
    assert_eq!(
        summary.digest_policy,
        "per_suite_digests_preserved_never_merged"
    );
    assert_eq!(summary.readiness_state, "not_evaluated_and_unchanged");
    assert!(summary.evidence_classes.compatibility_untouched);
    assert_eq!(summary.aggregates.expected_good_missed, 0);
    assert_eq!(summary.aggregates.unexpected_passes, 0);
    assert!(summary.aggregates.retrieval_metric_rows > 0);
    assert!(summary.aggregates.answer_metric_rows > 0);
    let json = summary.to_json().expect("json");
    assert!(json.contains("suite_matrix"));
    assert!(!json.to_ascii_lowercase().contains("/users/"));
}

#[test]
fn adversarial_contradiction_and_certainty_mutations_fail() {
    let suite = load_suite(&adversarial_root()).unwrap();
    let record = run_hermetic_suite(&suite, &HermeticRunOptions::default());
    for id in [
        "mut_prose_contradicts_structured",
        "mut_flag_false_but_certainty_prose",
        "mut_unsupported_certainty",
        "mut_recovery_as_cause",
        "mut_popularity_decoy",
    ] {
        let ans = record
            .cases
            .iter()
            .flat_map(|c| c.answers.iter())
            .find(|a| a.candidate_id == id)
            .unwrap_or_else(|| panic!("missing {id}"));
        assert!(!ans.passed, "{id} should fail");
        assert_eq!(ans.expectation_met, Some(true), "{id}");
    }
}

#[test]
fn adversarial_run_is_deterministic_across_repeats() {
    let suite = load_suite(&adversarial_root()).unwrap();
    let a = run_hermetic_suite(&suite, &HermeticRunOptions::default());
    let b = run_hermetic_suite(&suite, &HermeticRunOptions::default());
    let c = run_hermetic_suite(&suite, &HermeticRunOptions::default());
    assert_eq!(a.suite_digest, b.suite_digest);
    assert_eq!(b.suite_digest, c.suite_digest);
    assert_eq!(a.status, b.status);
    assert_eq!(
        a.cases
            .iter()
            .map(|case| (
                case.case_id.clone(),
                case.answers
                    .iter()
                    .map(|ans| (ans.candidate_id.clone(), ans.passed, ans.expectation_met))
                    .collect::<Vec<_>>()
            ))
            .collect::<Vec<_>>(),
        b.cases
            .iter()
            .map(|case| (
                case.case_id.clone(),
                case.answers
                    .iter()
                    .map(|ans| (ans.candidate_id.clone(), ans.passed, ans.expectation_met))
                    .collect::<Vec<_>>()
            ))
            .collect::<Vec<_>>()
    );
}
