//! Hermetic suite runner: retrieval metrics + scripted answer scores.
//!
//! Produces normalized run records without network, credentials, or readiness
//! store mutation.

use super::answer_score::score_answer;
use super::metrics::score_retrieval;
use super::suite::{known_document_ids, LoadedSuite};
use super::types::{
    CandidateExpectation, CaseRunResult, EvaluationLane, EvidenceClassMarkers, JudgeMetadata,
    LaneStatus, ModelSubject, QualityRunRecord, QualityUnit, TaskMode, QUALITY_EVAL_SCHEMA_VERSION,
    RUN_RECORD_SCHEMA_ID,
};
use crate::capability_qualification::fingerprint_endpoint;

/// Options for a hermetic run.
#[derive(Debug, Clone)]
pub struct HermeticRunOptions {
    /// Build identity string (short SHA or `unknown`).
    pub build_identity: String,
    /// Scripted subject gateway id (hermetic default).
    pub gateway_profile_id: String,
    /// Endpoint string fingerprinted (never stored raw in subject beyond hash).
    pub endpoint_for_fingerprint: String,
    /// Scripted model id.
    pub model_id: String,
}

impl Default for HermeticRunOptions {
    fn default() -> Self {
        Self {
            build_identity: "unknown".into(),
            gateway_profile_id: "hermetic-fixture-gateway".into(),
            endpoint_for_fingerprint: "https://hermetic.example/v1".into(),
            model_id: "scripted-candidate".into(),
        }
    }
}

/// Build the quality unit for a hermetic scripted run.
pub fn hermetic_quality_unit(suite: &LoadedSuite, opts: &HermeticRunOptions) -> QualityUnit {
    QualityUnit {
        build_identity: opts.build_identity.clone(),
        subject: ModelSubject {
            gateway_profile_id: opts.gateway_profile_id.clone(),
            endpoint_fingerprint: fingerprint_endpoint(&opts.endpoint_for_fingerprint),
            model_id: opts.model_id.clone(),
        },
        task_mode: TaskMode::TriageInvestigation,
        prompt_set_hash: "hermetic_scripted".into(),
        answer_schema_version: "contextdesk.quality_eval.candidate_answer.v1".into(),
        suite_id: suite.manifest.suite_id.clone(),
        suite_digest: suite.digest.clone(),
        retrieval_mode: format!(
            "{},{},{}",
            EvaluationLane::FixedPacket.as_str(),
            EvaluationLane::OraclePacket.as_str(),
            EvaluationLane::ProductPathFixture.as_str()
        ),
        sampling_config: "deterministic_scripted".into(),
        orchestration_policy_fingerprint: "none".into(),
        quality_eval_schema_version: QUALITY_EVAL_SCHEMA_VERSION.into(),
    }
}

/// Prove two gateways with the same model id produce distinct quality units.
pub fn quality_units_are_gateway_scoped(a: &QualityUnit, b: &QualityUnit) -> Result<(), String> {
    if a.subject.model_id == b.subject.model_id
        && a.subject.gateway_profile_id != b.subject.gateway_profile_id
        && a.subject.storage_id() == b.subject.storage_id()
    {
        return Err(super::types::failure_reason::CROSS_GATEWAY_IDENTITY_COLLAPSE.into());
    }
    if a.subject.storage_id() == b.subject.storage_id()
        && a.subject.gateway_profile_id != b.subject.gateway_profile_id
    {
        return Err(super::types::failure_reason::CROSS_GATEWAY_IDENTITY_COLLAPSE.into());
    }
    Ok(())
}

/// Run the full hermetic suite.
pub fn run_hermetic_suite(suite: &LoadedSuite, opts: &HermeticRunOptions) -> QualityRunRecord {
    let quality_unit = hermetic_quality_unit(suite, opts);
    let mut case_results = Vec::new();
    let mut any_failed = suite.cases.is_empty();

    for case in &suite.cases {
        let known = known_document_ids(&case.runtime);
        let mut retrieval = Vec::new();
        for ranking in &case.runtime.rankings {
            let Some(qtruth) = case
                .truth
                .queries
                .iter()
                .find(|q| q.query_id == ranking.query_id)
            else {
                retrieval.push(super::types::RetrievalMetrics {
                    query_id: ranking.query_id.clone(),
                    recall_at_k: 0.0,
                    mrr: 0.0,
                    ndcg_at_k: 0.0,
                    must_include_recall: 0.0,
                    must_exclude_rate: 0.0,
                    foreign_incident_hits: 0,
                    upstream_recall_at_k: None,
                    final_recall_at_k: None,
                    status: LaneStatus::Blocked,
                    failure_reasons: vec!["missing_query_truth".into()],
                });
                any_failed = true;
                continue;
            };
            let metrics = score_retrieval(qtruth, ranking, &known);
            if metrics.status == LaneStatus::Failed {
                any_failed = true;
            }
            retrieval.push(metrics);
        }

        let mut answers = Vec::new();
        let mut answer_contract_failed = false;
        for candidate in &case.runtime.candidates {
            let expectation = case
                .truth
                .candidate_expectations
                .get(&candidate.candidate_id)
                .copied();
            let Some(atruth) = case
                .truth
                .answers
                .iter()
                .find(|a| a.task_id == candidate.task_id)
            else {
                answers.push(super::types::AnswerScore {
                    candidate_id: candidate.candidate_id.clone(),
                    task_id: candidate.task_id.clone(),
                    packet_id: candidate.packet_id.clone(),
                    passed: false,
                    dimensions: vec![super::types::AnswerDimension {
                        id: "task_truth".into(),
                        passed: false,
                        reason: "missing_answer_truth".into(),
                    }],
                    status: LaneStatus::Blocked,
                    expected_outcome: expectation,
                    expectation_met: Some(false),
                });
                any_failed = true;
                continue;
            };
            let Some(packet) = case
                .runtime
                .packets
                .iter()
                .find(|p| p.packet_id == candidate.packet_id)
            else {
                answers.push(super::types::AnswerScore {
                    candidate_id: candidate.candidate_id.clone(),
                    task_id: candidate.task_id.clone(),
                    packet_id: candidate.packet_id.clone(),
                    passed: false,
                    dimensions: vec![super::types::AnswerDimension {
                        id: "packet".into(),
                        passed: false,
                        reason: "missing_packet".into(),
                    }],
                    status: LaneStatus::Blocked,
                    expected_outcome: expectation,
                    expectation_met: Some(false),
                });
                any_failed = true;
                continue;
            };
            let mut score = score_answer(candidate, atruth, packet);
            let expectation_met = matches!(
                (expectation, score.passed),
                (Some(CandidateExpectation::Pass), true)
                    | (Some(CandidateExpectation::Fail), false)
            );
            score.expected_outcome = expectation;
            score.expectation_met = Some(expectation_met);
            if !expectation_met {
                answer_contract_failed = true;
                any_failed = true;
            }
            answers.push(score);
        }

        // Case status separates structural failures from host-declared answer
        // expectations. An expected mutation failure is a successful cage
        // check; any expectation mismatch fails the case.
        let retrieval_failed = retrieval.iter().any(|r| r.status == LaneStatus::Failed);
        let no_evidence_rows = retrieval.is_empty() && answers.is_empty();
        let blocked = retrieval.iter().any(|r| r.status == LaneStatus::Blocked)
            || answers.iter().any(|a| a.status == LaneStatus::Blocked);
        let case_status = if blocked {
            any_failed = true;
            LaneStatus::Blocked
        } else if retrieval_failed || answer_contract_failed || no_evidence_rows {
            any_failed = true;
            LaneStatus::Failed
        } else {
            LaneStatus::Executed
        };

        case_results.push(CaseRunResult {
            case_id: case.truth.case_id.clone(),
            title: case.truth.title.clone(),
            status: case_status,
            retrieval,
            answers,
            isolation_findings: Vec::new(),
        });
    }

    let retrieval_quality = case_results.iter().any(|case| !case.retrieval.is_empty());
    let answer_quality = case_results.iter().any(|case| !case.answers.is_empty());
    let orchestration_quality = suite.cases.iter().any(|case| {
        case.runtime
            .candidates
            .iter()
            .any(|c| c.diagnostic.as_ref().is_some_and(|d| !d.roles.is_empty()))
            || case.truth.answers.iter().any(|a| {
                a.diagnostic
                    .as_ref()
                    .is_some_and(|d| !d.required_roles.is_empty())
            })
    });

    QualityRunRecord {
        schema_id: RUN_RECORD_SCHEMA_ID.into(),
        schema_version: QUALITY_EVAL_SCHEMA_VERSION.into(),
        suite_id: suite.manifest.suite_id.clone(),
        suite_digest: suite.digest.clone(),
        quality_unit,
        status: if any_failed {
            LaneStatus::Failed
        } else {
            LaneStatus::Executed
        },
        cases: case_results,
        judge: JudgeMetadata::default(),
        evidence_classes: EvidenceClassMarkers {
            compatibility_untouched: true,
            retrieval_quality,
            answer_quality,
            orchestration_quality,
            live_optional: false,
        },
    }
}

/// True when the optional judge lane is honestly `not_scheduled` (not a pass).
pub fn judge_is_not_scheduled_pass(record: &QualityRunRecord) -> bool {
    record.judge.status == LaneStatus::NotScheduled
}
