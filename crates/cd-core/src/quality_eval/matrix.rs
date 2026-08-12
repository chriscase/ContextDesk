//! Deterministic expectation matrix summaries for hermetic quality runs.
//!
//! Matrix generation is pure and separate from scoring: it cannot invent a
//! pass that the scorer did not emit.

use super::types::{CandidateExpectation, MatrixRow, QualityRunRecord};

/// Build one matrix row per scripted candidate score in run order.
pub fn matrix_summary_rows(record: &QualityRunRecord) -> Vec<MatrixRow> {
    let mut rows = Vec::new();
    for case in &record.cases {
        for ans in &case.answers {
            let expected = match ans.expected_outcome {
                Some(CandidateExpectation::Pass) => "pass",
                Some(CandidateExpectation::Fail) => "fail",
                None => "unset",
            };
            let mut failed_dimensions = Vec::new();
            let mut failure_reasons = Vec::new();
            for dim in &ans.dimensions {
                if !dim.passed {
                    failed_dimensions.push(dim.id.clone());
                    failure_reasons.push(dim.reason.clone());
                }
            }
            rows.push(MatrixRow {
                case_id: case.case_id.clone(),
                candidate_id: ans.candidate_id.clone(),
                expected: expected.into(),
                actual_passed: ans.passed,
                expectation_met: ans.expectation_met.unwrap_or(false),
                failed_dimensions,
                failure_reasons,
            });
        }
    }
    rows
}

/// Stable one-line matrix suitable for CI logs and scratch capture.
pub fn matrix_summary_lines(record: &QualityRunRecord) -> Vec<String> {
    let mut lines = vec![
        "case_id\tcandidate_id\texpected\tactual_passed\texpectation_met\tfailed_dimensions\treasons"
            .into(),
    ];
    for row in matrix_summary_rows(record) {
        lines.push(format!(
            "{}\t{}\t{}\t{}\t{}\t{}\t{}",
            row.case_id,
            row.candidate_id,
            row.expected,
            row.actual_passed,
            row.expectation_met,
            row.failed_dimensions.join(","),
            row.failure_reasons.join(","),
        ));
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::super::types::{
        AnswerDimension, AnswerScore, CaseRunResult, EvidenceClassMarkers, JudgeMetadata,
        LaneStatus, ModelSubject, QualityUnit, TaskMode, QUALITY_EVAL_SCHEMA_VERSION,
        RUN_RECORD_SCHEMA_ID,
    };
    use super::*;

    #[test]
    fn matrix_does_not_invent_passes() {
        let record = QualityRunRecord {
            schema_id: RUN_RECORD_SCHEMA_ID.into(),
            schema_version: QUALITY_EVAL_SCHEMA_VERSION.into(),
            suite_id: "s".into(),
            suite_digest: "d".into(),
            quality_unit: QualityUnit {
                build_identity: "b".into(),
                subject: ModelSubject {
                    gateway_profile_id: "g".into(),
                    endpoint_fingerprint: "f".into(),
                    model_id: "m".into(),
                },
                task_mode: TaskMode::TriageInvestigation,
                prompt_set_hash: "p".into(),
                answer_schema_version: "a".into(),
                suite_id: "s".into(),
                suite_digest: "d".into(),
                retrieval_mode: "fixed".into(),
                sampling_config: "det".into(),
                orchestration_policy_fingerprint: "none".into(),
                quality_eval_schema_version: QUALITY_EVAL_SCHEMA_VERSION.into(),
            },
            status: LaneStatus::Executed,
            cases: vec![CaseRunResult {
                case_id: "c1".into(),
                title: "t".into(),
                status: LaneStatus::Executed,
                retrieval: vec![],
                answers: vec![AnswerScore {
                    candidate_id: "mut_x".into(),
                    task_id: "t1".into(),
                    packet_id: "fixed".into(),
                    passed: false,
                    dimensions: vec![AnswerDimension {
                        id: "cause_versus_symptom".into(),
                        passed: false,
                        reason: "symptom_promoted_to_trigger".into(),
                    }],
                    status: LaneStatus::Executed,
                    expected_outcome: Some(CandidateExpectation::Fail),
                    expectation_met: Some(true),
                }],
                isolation_findings: vec![],
            }],
            judge: JudgeMetadata::default(),
            evidence_classes: EvidenceClassMarkers::default(),
        };
        let rows = matrix_summary_rows(&record);
        assert_eq!(rows.len(), 1);
        assert!(!rows[0].actual_passed);
        assert!(rows[0].expectation_met);
        assert_eq!(rows[0].failed_dimensions, vec!["cause_versus_symptom"]);
        let lines = matrix_summary_lines(&record);
        assert!(lines[1].contains("mut_x"));
        assert!(lines[1].contains("symptom_promoted_to_trigger"));
    }
}
