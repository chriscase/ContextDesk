//! Hermetic quality-evaluation lab integration tests (issue #867).
//!
//! No network, Keychain, Grok session, or live model calls.

use cd_core::capability_qualification::{QualificationKey, QualificationStore};
use cd_core::quality_eval::{
    apply_judge_cannot_override, assert_suite_digest, gate_export_text, load_suite,
    quality_units_are_gateway_scoped, run_hermetic_suite, scan_privacy_text,
    scan_runtime_isolation, score_retrieval, serialize_json, validate_ranking, write_export,
    CandidateExpectation, HermeticRunOptions, LaneStatus, ModelSubject,
    QUALITY_EVAL_SCHEMA_VERSION, RUNTIME_FORBIDDEN_EVALUATOR_TOKENS,
};
use cd_core::quality_eval::{failure_reason, EvidenceDocument, QueryTruth, RetrievalRanking};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

fn suite_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/quality-eval/open-v1")
}

#[test]
fn open_suite_loads_and_isolates_truth_from_runtime() {
    let suite = load_suite(&suite_root()).expect("load suite");
    assert_eq!(suite.manifest.suite_id, "quality-eval-open-v1");
    assert_eq!(suite.cases.len(), 8);
    assert_eq!(suite.manifest.schema_version, QUALITY_EVAL_SCHEMA_VERSION);
    assert_eq!(suite.digest.len(), 64);

    for case in &suite.cases {
        let findings = scan_runtime_isolation(&case.runtime);
        assert!(
            findings.is_empty(),
            "case {} leaked evaluator tokens: {findings:?}",
            case.case_dir
        );
        // Truth must not be required to score isolation of runtime.
        assert_ne!(case.runtime.schema_id, case.truth.schema_id);
    }
}

#[test]
fn hermetic_run_executes_and_enforces_good_versus_mutation_contract() {
    let suite = load_suite(&suite_root()).expect("load");
    let record = run_hermetic_suite(&suite, &HermeticRunOptions::default());
    assert_eq!(record.status, LaneStatus::Executed, "suite failed");
    assert!(record.evidence_classes.compatibility_untouched);
    assert!(record.evidence_classes.retrieval_quality);
    assert!(record.evidence_classes.answer_quality);
    assert!(!record.evidence_classes.live_optional);
    assert_eq!(record.judge.status, LaneStatus::NotScheduled);

    let mut saw_good = false;
    let mut saw_mut = false;
    for case in &record.cases {
        assert_eq!(case.status, LaneStatus::Executed, "{}", case.case_id);
        let truth = &suite
            .cases
            .iter()
            .find(|loaded| loaded.truth.case_id == case.case_id)
            .expect("case truth")
            .truth;
        for ans in &case.answers {
            match truth.candidate_expectations.get(&ans.candidate_id) {
                Some(CandidateExpectation::Pass) => {
                    saw_good = true;
                    assert_eq!(ans.expected_outcome, Some(CandidateExpectation::Pass));
                    assert_eq!(ans.expectation_met, Some(true));
                    assert!(
                        ans.passed,
                        "expected pass {} failed on {}: {:?}",
                        ans.candidate_id,
                        case.case_id,
                        ans.failed_ids()
                    );
                }
                Some(CandidateExpectation::Fail) => {
                    saw_mut = true;
                    assert_eq!(ans.expected_outcome, Some(CandidateExpectation::Fail));
                    assert_eq!(ans.expectation_met, Some(true));
                    assert!(
                        !ans.passed,
                        "expected failure {} passed on {}",
                        ans.candidate_id, case.case_id
                    );
                }
                None => panic!("missing expectation for {}", ans.candidate_id),
            }
        }
    }
    assert!(saw_good && saw_mut);
}

#[test]
fn incomplete_product_packets_can_receive_correct_abstention_credit() {
    let suite = load_suite(&suite_root()).expect("load");
    let record = run_hermetic_suite(&suite, &HermeticRunOptions::default());
    let abstentions: Vec<_> = record
        .cases
        .iter()
        .flat_map(|case| case.answers.iter())
        .filter(|answer| answer.candidate_id == "good_product_path_abstention")
        .collect();

    assert_eq!(abstentions.len(), 2);
    assert!(abstentions.iter().all(|answer| {
        answer.packet_id == "product_path" && answer.passed && answer.expectation_met == Some(true)
    }));
}

#[test]
fn candidate_expectations_do_not_depend_on_id_prefixes() {
    let mut suite = load_suite(&suite_root()).expect("load");
    let case = &mut suite.cases[0];
    let renames = [
        ("good_fixed", "candidate_a"),
        ("mut_missing_citation", "candidate_b"),
        ("good_oracle", "candidate_c"),
    ];
    for (from, to) in renames {
        case.runtime
            .candidates
            .iter_mut()
            .find(|candidate| candidate.candidate_id == from)
            .expect("candidate")
            .candidate_id = to.into();
        let expectation = case
            .truth
            .candidate_expectations
            .remove(from)
            .expect("expectation");
        case.truth
            .candidate_expectations
            .insert(to.into(), expectation);
    }

    let record = run_hermetic_suite(&suite, &HermeticRunOptions::default());

    assert_eq!(record.status, LaneStatus::Executed);
    assert_eq!(record.cases[0].status, LaneStatus::Executed);
}

#[test]
fn missing_candidate_expectation_fails_closed() {
    let mut suite = load_suite(&suite_root()).expect("load");
    suite.cases[0]
        .truth
        .candidate_expectations
        .remove("good_fixed");

    let record = run_hermetic_suite(&suite, &HermeticRunOptions::default());

    assert_eq!(record.status, LaneStatus::Failed);
    assert_eq!(record.cases[0].status, LaneStatus::Failed);
}

#[test]
fn mutation_missing_citation_has_typed_reason() {
    let suite = load_suite(&suite_root()).unwrap();
    let record = run_hermetic_suite(&suite, &HermeticRunOptions::default());
    let ans = record
        .cases
        .iter()
        .flat_map(|c| c.answers.iter())
        .find(|a| a.candidate_id == "mut_missing_citation")
        .expect("mut");
    assert!(!ans.passed);
    assert!(ans.failed_ids().contains(&"required_evidence_identities"));
}

#[test]
fn mutation_fabricated_citation_has_typed_reason() {
    let suite = load_suite(&suite_root()).unwrap();
    let record = run_hermetic_suite(&suite, &HermeticRunOptions::default());
    let ans = record
        .cases
        .iter()
        .flat_map(|c| c.answers.iter())
        .find(|a| a.candidate_id == "mut_fabricated_citation")
        .expect("mut");
    assert!(ans.failed_ids().contains(&"no_fabricated_citations"));
}

#[test]
fn mutation_symptom_as_cause_has_typed_reason() {
    let suite = load_suite(&suite_root()).unwrap();
    let record = run_hermetic_suite(&suite, &HermeticRunOptions::default());
    let ans = record
        .cases
        .iter()
        .flat_map(|c| c.answers.iter())
        .find(|a| a.candidate_id == "mut_symptom_as_cause")
        .expect("mut");
    assert!(ans.failed_ids().contains(&"cause_versus_symptom"));
}

#[test]
fn mutation_merged_incidents_has_typed_reason() {
    let suite = load_suite(&suite_root()).unwrap();
    let record = run_hermetic_suite(&suite, &HermeticRunOptions::default());
    let ans = record
        .cases
        .iter()
        .flat_map(|c| c.answers.iter())
        .find(|a| a.candidate_id == "mut_merged_incidents")
        .expect("mut");
    assert!(ans
        .failed_ids()
        .contains(&"independent_incident_separation"));
}

#[test]
fn mutation_recovery_as_cause_has_typed_reason() {
    let suite = load_suite(&suite_root()).unwrap();
    let record = run_hermetic_suite(&suite, &HermeticRunOptions::default());
    let ans = record
        .cases
        .iter()
        .flat_map(|c| c.answers.iter())
        .find(|a| a.candidate_id == "mut_recovery_as_cause")
        .expect("mut");
    assert!(ans.failed_ids().contains(&"trigger_versus_recovery"));
}

#[test]
fn mutation_unsupported_certainty_has_typed_reason() {
    let suite = load_suite(&suite_root()).unwrap();
    let record = run_hermetic_suite(&suite, &HermeticRunOptions::default());
    let ans = record
        .cases
        .iter()
        .flat_map(|c| c.answers.iter())
        .find(|a| a.candidate_id == "mut_unsupported_certainty")
        .expect("mut");
    assert!(ans.failed_ids().contains(&"honest_abstention"));
}

#[test]
fn mutation_generic_abstention_has_typed_reason() {
    let suite = load_suite(&suite_root()).unwrap();
    let record = run_hermetic_suite(&suite, &HermeticRunOptions::default());
    let answer = record
        .cases
        .iter()
        .flat_map(|case| case.answers.iter())
        .find(|answer| answer.candidate_id == "mut_generic_abstention")
        .expect("generic abstention mutation");

    assert!(!answer.passed);
    assert!(answer.failed_ids().contains(&"abstention_evidence_basis"));
    assert_eq!(answer.expected_outcome, Some(CandidateExpectation::Fail));
    assert_eq!(answer.expectation_met, Some(true));
}

#[test]
fn mutation_near_match_selected_fails_decoy_or_independent() {
    let suite = load_suite(&suite_root()).unwrap();
    let record = run_hermetic_suite(&suite, &HermeticRunOptions::default());
    let ans = record
        .cases
        .iter()
        .flat_map(|c| c.answers.iter())
        .find(|a| a.candidate_id == "mut_near_match_selected")
        .expect("mut");
    assert!(!ans.passed);
    let failed = ans.failed_ids();
    assert!(
        failed.contains(&"decoy_rejection")
            || failed.contains(&"independent_incident_separation")
            || failed.contains(&"no_forbidden_citations"),
        "unexpected fails: {failed:?}"
    );
}

#[test]
fn ranking_mutations_fail_closed() {
    let known: BTreeSet<String> = ["a", "b"].iter().map(|s| (*s).to_string()).collect();
    let dup = RetrievalRanking {
        query_id: "q".into(),
        ranked_ids: vec!["a".into(), "a".into()],
        upstream_ranked_ids: None,
        k: Some(2),
    };
    let reasons = validate_ranking(&dup, &known);
    assert!(reasons
        .iter()
        .any(|r| r == failure_reason::DUPLICATE_RANK_IDS));

    let unknown = RetrievalRanking {
        query_id: "q".into(),
        ranked_ids: vec!["z".into()],
        upstream_ranked_ids: None,
        k: Some(1),
    };
    let reasons = validate_ranking(&unknown, &known);
    assert!(reasons
        .iter()
        .any(|r| r == failure_reason::UNKNOWN_RANK_IDS));
}

#[test]
fn truth_leak_into_runtime_is_detected() {
    let mut suite = load_suite(&suite_root()).unwrap();
    suite.cases[0].runtime.documents.push(EvidenceDocument {
        id: "leak".into(),
        text: "evaluator_truth marker must not appear".into(),
    });
    let findings = scan_runtime_isolation(&suite.cases[0].runtime);
    assert!(!findings.is_empty());
    assert!(RUNTIME_FORBIDDEN_EVALUATOR_TOKENS
        .iter()
        .any(|t| findings.iter().any(|f| f.contains(t))));
}

#[test]
fn suite_digest_changes_when_content_changes() {
    let suite = load_suite(&suite_root()).unwrap();
    let original = suite.digest.clone();
    let err = assert_suite_digest(&suite, "0".repeat(64).as_str()).unwrap_err();
    assert!(err
        .to_string()
        .contains(failure_reason::SUITE_DIGEST_MISMATCH));
    // Reload is stable.
    let suite2 = load_suite(&suite_root()).unwrap();
    assert_eq!(suite2.digest, original);
}

#[test]
fn same_model_id_two_gateways_do_not_share_quality_unit() {
    let suite = load_suite(&suite_root()).unwrap();
    let a = HermeticRunOptions {
        gateway_profile_id: "gateway-alpha".into(),
        endpoint_for_fingerprint: "https://alpha.example/v1".into(),
        model_id: "deepseek-v4-flash".into(),
        ..Default::default()
    };
    let b = HermeticRunOptions {
        gateway_profile_id: "gateway-beta".into(),
        endpoint_for_fingerprint: "https://beta.example/v1".into(),
        model_id: "deepseek-v4-flash".into(),
        ..Default::default()
    };
    let ua = run_hermetic_suite(&suite, &a).quality_unit;
    let ub = run_hermetic_suite(&suite, &b).quality_unit;
    assert_eq!(ua.subject.model_id, ub.subject.model_id);
    assert_ne!(ua.subject.storage_id(), ub.subject.storage_id());
    assert_ne!(ua.storage_id(), ub.storage_id());
    quality_units_are_gateway_scoped(&ua, &ub).unwrap();

    // Synthetic collapse detection: same storage_id with different gateways is an error.
    let collapsed = ua.subject.clone();
    let bad = ModelSubject {
        gateway_profile_id: "other".into(),
        endpoint_fingerprint: collapsed.endpoint_fingerprint.clone(),
        model_id: collapsed.model_id.clone(),
    };
    // storage_id includes gateway so this remains distinct — prove the formula.
    assert_ne!(collapsed.storage_id(), bad.storage_id());
}

#[test]
fn quality_unit_reuses_compatibility_endpoint_fingerprint() {
    let suite = load_suite(&suite_root()).unwrap();
    let endpoint = "https://Gateway.Example/CaseSensitive/v1/";
    let opts = HermeticRunOptions {
        endpoint_for_fingerprint: endpoint.into(),
        ..Default::default()
    };

    let unit = cd_core::quality_eval::hermetic_quality_unit(&suite, &opts);
    let qualification = QualificationKey::new("profile", endpoint, "model");

    assert_eq!(
        unit.subject.endpoint_fingerprint,
        qualification.endpoint_fingerprint
    );
}

#[test]
fn quality_unit_preserves_the_full_build_identity() {
    let suite = load_suite(&suite_root()).unwrap();
    let full_identity = "0123456789abcdef0123456789abcdef01234567";
    let opts = HermeticRunOptions {
        build_identity: full_identity.into(),
        ..Default::default()
    };

    let unit = cd_core::quality_eval::hermetic_quality_unit(&suite, &opts);

    assert_eq!(unit.build_identity, full_identity);
    assert!(unit.storage_id().contains(full_identity));
}

#[test]
fn storage_ids_length_frame_delimiter_bearing_components() {
    let a = ModelSubject {
        gateway_profile_id: "gateway::alpha".into(),
        endpoint_fingerprint: "fingerprint".into(),
        model_id: "model".into(),
    };
    let b = ModelSubject {
        gateway_profile_id: "gateway".into(),
        endpoint_fingerprint: "alpha::fingerprint".into(),
        model_id: "model".into(),
    };

    assert_ne!(a.storage_id(), b.storage_id());
}

#[test]
fn judge_override_of_deterministic_failure_is_rejected() {
    let suite = load_suite(&suite_root()).unwrap();
    let record = run_hermetic_suite(&suite, &HermeticRunOptions::default());
    let failed = record
        .cases
        .iter()
        .flat_map(|c| c.answers.iter())
        .find(|a| a.candidate_id.starts_with("mut_"))
        .expect("mut");
    let err = apply_judge_cannot_override(failed, true).unwrap_err();
    assert_eq!(err, failure_reason::JUDGE_OVERRIDE_REJECTED);
}

#[test]
fn export_rejects_absolute_paths_and_credential_shapes() {
    assert!(scan_privacy_text("relative/path/ok").is_empty());
    assert!(!scan_privacy_text("leak /Users/nobody/secret").is_empty());
    // Build sk- without a single contiguous literal for naive scanners in this file.
    let shaped = format!("{}{}", "sk", "-abcdefghijklmnop");
    assert!(!scan_privacy_text(&shaped).is_empty());
    let err = gate_export_text(&format!("path=/Users/x/{shaped}")).unwrap_err();
    assert!(err.to_string().contains("export_privacy") || err.to_string().contains("sk-"));
}

#[test]
fn quality_run_does_not_mutate_compatibility_store() {
    let store = QualificationStore::default();
    let key = QualificationKey::new("profile-a", "https://example.invalid/v1", "model-x");
    // Pre-seed nothing; run quality suite; ensure store remains empty and
    // quality_eval never provides an API that takes a QualificationStore.
    let suite = load_suite(&suite_root()).unwrap();
    let record = run_hermetic_suite(&suite, &HermeticRunOptions::default());
    assert!(record.evidence_classes.compatibility_untouched);
    assert!(store.get(&key).is_none());
    assert!(store.by_key.is_empty());
    // Source-level: quality_eval must not call into readiness store APIs.
    for path in [
        "src/quality_eval/run.rs",
        "src/quality_eval/answer_score.rs",
        "src/quality_eval/metrics.rs",
        "src/quality_eval/export.rs",
        "src/quality_eval/suite.rs",
        "src/quality_eval/types.rs",
    ] {
        let src = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join(path))
            .unwrap_or_default();
        assert!(
            !src.contains("QualificationStore") && !src.contains("QualificationReport"),
            "{path} must not write readiness evidence"
        );
    }
}

#[test]
fn export_write_refuses_overwrite_without_force() {
    let suite = load_suite(&suite_root()).unwrap();
    let record = run_hermetic_suite(&suite, &HermeticRunOptions::default());
    let body = serialize_json(&record).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let out = dir.path().join("report.json");
    write_export(&out, &body, false).unwrap();
    let err = write_export(&out, &body, false).unwrap_err();
    assert!(err.to_string().contains("already exists"));
}

#[test]
fn retrieval_metrics_present_for_each_case_with_rankings() {
    let suite = load_suite(&suite_root()).unwrap();
    let record = run_hermetic_suite(&suite, &HermeticRunOptions::default());
    for case in &record.cases {
        if !case.retrieval.is_empty() {
            for m in &case.retrieval {
                assert_eq!(m.status, LaneStatus::Executed, "{}", case.case_id);
            }
        }
    }
    // qe08 has upstream vs final
    let qe08 = record
        .cases
        .iter()
        .find(|c| c.case_id == "qe08-retrieval-ranking")
        .expect("qe08");
    let m = &qe08.retrieval[0];
    assert!(m.upstream_recall_at_k.is_some());
    assert!(m.final_recall_at_k.is_some());
}

#[test]
fn empty_truth_and_zero_hit_edges() {
    let known: BTreeSet<String> = ["n1"].iter().map(|s| (*s).to_string()).collect();
    let truth = QueryTruth {
        query_id: "q".into(),
        question: "none".into(),
        relevant_ids: vec![],
        graded_gains: BTreeMap::new(),
        must_include_ids: vec![],
        must_exclude_ids: vec![],
        foreign_incident_ids: vec![],
        top_k: 1,
    };
    let ranking = RetrievalRanking {
        query_id: "q".into(),
        ranked_ids: vec!["n1".into()],
        upstream_ranked_ids: None,
        k: Some(1),
    };
    let m = score_retrieval(&truth, &ranking, &known);
    assert_eq!(m.status, LaneStatus::Executed);
    assert!((m.recall_at_k - 1.0).abs() < 1e-9);

    let truth2 = QueryTruth {
        query_id: "q".into(),
        question: "miss".into(),
        relevant_ids: vec!["missing".into()],
        graded_gains: BTreeMap::new(),
        must_include_ids: vec!["missing".into()],
        must_exclude_ids: vec![],
        foreign_incident_ids: vec![],
        top_k: 1,
    };
    // ranking only has n1 which is known but not relevant
    let m2 = score_retrieval(&truth2, &ranking, &known);
    assert_eq!(m2.status, LaneStatus::Executed);
    assert_eq!(m2.recall_at_k, 0.0);
    assert_eq!(m2.must_include_recall, 0.0);
}

#[test]
fn not_scheduled_judge_is_not_a_pass_claim() {
    let suite = load_suite(&suite_root()).unwrap();
    let record = run_hermetic_suite(&suite, &HermeticRunOptions::default());
    assert_eq!(record.judge.status, LaneStatus::NotScheduled);
    // Overall suite pass does not depend on judge.
    assert_eq!(record.status, LaneStatus::Executed);
}
