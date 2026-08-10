//! Safe multi-suite quality-eval matrix summary.
//!
//! Runs hermetic suites independently and emits a combined summary that never
//! merges or rewrites historical suite digests. Does not touch readiness stores.

use super::export::{gate_export_text, serialize_json};
use super::run::HermeticRunOptions;
use super::suite::{expectation_accounting, load_suite, ExpectationAccounting};
use super::types::{
    EvidenceClassMarkers, LaneStatus, QualityRunRecord, QUALITY_EVAL_SCHEMA_VERSION,
};
use crate::error::{CoreError, CoreResult};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Schema id for multi-suite matrix summaries.
pub const SUITE_MATRIX_SCHEMA_ID: &str = "contextdesk.quality_eval.suite_matrix.v1";

/// One suite's contribution to a matrix summary.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SuiteMatrixRow {
    /// Suite id from the manifest.
    pub suite_id: String,
    /// Suite content digest (never rewritten by the matrix).
    pub suite_digest: String,
    /// Repo-relative path label only.
    pub relative_path: String,
    /// Hermetic run status for this suite alone.
    pub status: LaneStatus,
    /// Case count.
    pub case_count: usize,
    /// Host-declared expected-pass candidates that passed.
    pub expected_good_met: u32,
    /// Host-declared expected-pass candidates that failed (unexpected).
    pub expected_good_missed: u32,
    /// Host-declared expected-fail mutations correctly rejected.
    pub expected_fail_rejected: u32,
    /// Host-declared expected-fail mutations that unexpectedly passed.
    pub unexpected_passes: u32,
    /// Candidates without a declared expectation.
    pub undeclared: u32,
    /// Retrieval metric row count.
    pub retrieval_metric_rows: usize,
    /// Answer score row count.
    pub answer_metric_rows: usize,
    /// Lanes honestly recorded as not scheduled / skipped.
    pub skipped_not_scheduled_lanes: Vec<String>,
    /// Compatibility / readiness evidence was not modified.
    pub compatibility_untouched: bool,
}

/// Aggregate totals across suites (additive; digests remain per-suite).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct SuiteMatrixAggregates {
    /// Suites included.
    pub suite_count: usize,
    /// Suites with status executed.
    pub suites_executed: usize,
    /// Suites with status failed.
    pub suites_failed: usize,
    /// Expected-good candidates that passed.
    pub expected_good_met: u32,
    /// Expected-good candidates that failed.
    pub expected_good_missed: u32,
    /// Expected-fail mutations correctly rejected.
    pub expected_fail_rejected: u32,
    /// Expected-fail mutations that unexpectedly passed.
    pub unexpected_passes: u32,
    /// Undeclared candidates.
    pub undeclared: u32,
    /// Retrieval rows across suites.
    pub retrieval_metric_rows: usize,
    /// Answer rows across suites.
    pub answer_metric_rows: usize,
}

/// Combined safe summary across hermetic suites.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SuiteMatrixSummary {
    /// Schema id.
    pub schema_id: String,
    /// Schema version.
    pub schema_version: String,
    /// Overall status: executed only when every suite executed.
    pub status: LaneStatus,
    /// Per-suite rows (digests preserved independently).
    pub suites: Vec<SuiteMatrixRow>,
    /// Additive aggregates.
    pub aggregates: SuiteMatrixAggregates,
    /// Evidence class markers.
    pub evidence_classes: EvidenceClassMarkers,
    /// Explicit reminder that readiness is untouched.
    pub readiness_state: &'static str,
    /// Explicit reminder that digests are not merged.
    pub digest_policy: &'static str,
    /// Judge / live lanes remain not scheduled in hermetic matrix runs.
    pub skipped_not_scheduled_lanes: Vec<String>,
}

impl SuiteMatrixSummary {
    /// Machine-readable JSON body with privacy gate.
    pub fn to_json(&self) -> CoreResult<String> {
        let text = serde_json::to_string_pretty(self)
            .map_err(|e| CoreError::Message(format!("serialize suite matrix: {e}")))?;
        gate_export_text(&text)?;
        Ok(text)
    }
}

/// Resolve a suite path argument that may be a directory name under
/// `fixtures/quality-eval/` or an explicit path containing `suite.json`.
pub fn resolve_matrix_suite_path(label_or_path: &str, repo_hint: &Path) -> CoreResult<PathBuf> {
    let direct = PathBuf::from(label_or_path);
    if direct.join("suite.json").is_file() {
        return Ok(direct);
    }
    let under_fixtures = repo_hint.join("fixtures/quality-eval").join(label_or_path);
    if under_fixtures.join("suite.json").is_file() {
        return Ok(under_fixtures);
    }
    let relative = repo_hint.join(label_or_path);
    if relative.join("suite.json").is_file() {
        return Ok(relative);
    }
    Err(CoreError::Config(format!(
        "matrix suite not found: {label_or_path}"
    )))
}

/// Repo-relative label for a loaded suite path.
pub fn suite_relative_label(path: &Path) -> String {
    let text = path.to_string_lossy();
    if let Some(idx) = text.find("fixtures/quality-eval/") {
        return text
            .get(idx..)
            .unwrap_or("fixtures/quality-eval")
            .replace('\\', "/");
    }
    path.file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("suite")
        .to_string()
}

/// Build one matrix row from a hermetic run record.
pub fn matrix_row_from_record(record: &QualityRunRecord, relative_path: &str) -> SuiteMatrixRow {
    let accounting = expectation_accounting(record);
    let retrieval_metric_rows = record.cases.iter().map(|c| c.retrieval.len()).sum();
    let answer_metric_rows = record.cases.iter().map(|c| c.answers.len()).sum();
    SuiteMatrixRow {
        suite_id: record.suite_id.clone(),
        suite_digest: record.suite_digest.clone(),
        relative_path: relative_path.to_string(),
        status: record.status,
        case_count: record.cases.len(),
        expected_good_met: accounting.expected_pass_met,
        expected_good_missed: accounting.expected_pass_missed,
        expected_fail_rejected: accounting.expected_fail_met,
        unexpected_passes: accounting.expected_fail_missed,
        undeclared: accounting.undeclared,
        retrieval_metric_rows,
        answer_metric_rows,
        skipped_not_scheduled_lanes: vec![
            "judge:not_scheduled".into(),
            "live_optional:not_scheduled".into(),
        ],
        compatibility_untouched: record.evidence_classes.compatibility_untouched,
    }
}

/// Run multiple hermetic suites and build a combined safe summary.
pub fn run_suite_matrix(
    suite_paths: &[PathBuf],
    opts: &HermeticRunOptions,
) -> CoreResult<SuiteMatrixSummary> {
    if suite_paths.is_empty() {
        return Err(CoreError::Config(
            "suite matrix requires at least one suite path".into(),
        ));
    }
    let mut rows = Vec::new();
    let mut aggregates = SuiteMatrixAggregates::default();
    let mut any_failed = false;
    let mut retrieval_quality = false;
    let mut answer_quality = false;

    for path in suite_paths {
        let loaded = load_suite(path)?;
        let record = super::run::run_hermetic_suite(&loaded, opts);
        // Preserve each suite's own digest by scoring in isolation first.
        let _ = serialize_json(&record)?;
        let label = suite_relative_label(path);
        let row = matrix_row_from_record(&record, &label);
        if row.status != LaneStatus::Executed {
            any_failed = true;
        }
        retrieval_quality |= record.evidence_classes.retrieval_quality;
        answer_quality |= record.evidence_classes.answer_quality;
        aggregates.suite_count += 1;
        if row.status == LaneStatus::Executed {
            aggregates.suites_executed += 1;
        } else {
            aggregates.suites_failed += 1;
        }
        aggregates.expected_good_met += row.expected_good_met;
        aggregates.expected_good_missed += row.expected_good_missed;
        aggregates.expected_fail_rejected += row.expected_fail_rejected;
        aggregates.unexpected_passes += row.unexpected_passes;
        aggregates.undeclared += row.undeclared;
        aggregates.retrieval_metric_rows += row.retrieval_metric_rows;
        aggregates.answer_metric_rows += row.answer_metric_rows;
        rows.push(row);
    }

    Ok(SuiteMatrixSummary {
        schema_id: SUITE_MATRIX_SCHEMA_ID.into(),
        schema_version: QUALITY_EVAL_SCHEMA_VERSION.into(),
        status: if any_failed {
            LaneStatus::Failed
        } else {
            LaneStatus::Executed
        },
        suites: rows,
        aggregates,
        evidence_classes: EvidenceClassMarkers {
            compatibility_untouched: true,
            retrieval_quality,
            answer_quality,
            orchestration_quality: false,
            live_optional: false,
        },
        readiness_state: "not_evaluated_and_unchanged",
        digest_policy: "per_suite_digests_preserved_never_merged",
        skipped_not_scheduled_lanes: vec![
            "judge:not_scheduled".into(),
            "live_optional:not_scheduled".into(),
            "orchestration_quality:not_scheduled".into(),
        ],
    })
}

/// Accounting helper re-export for matrix consumers.
pub fn accounting_from_record(record: &QualityRunRecord) -> ExpectationAccounting {
    expectation_accounting(record)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::quality_eval::HermeticRunOptions;
    use std::path::Path;

    fn repo_root() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
    }

    #[test]
    fn matrix_preserves_independent_digests() {
        let open = repo_root().join("fixtures/quality-eval/open-v1");
        let adv = repo_root().join("fixtures/quality-eval/adversarial-v1");
        let summary =
            run_suite_matrix(&[open, adv], &HermeticRunOptions::default()).expect("matrix");
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
        assert_eq!(summary.status, LaneStatus::Executed);
        assert!(summary.aggregates.expected_good_met > 0);
        assert!(summary.aggregates.expected_fail_rejected > 0);
        assert_eq!(summary.aggregates.expected_good_missed, 0);
        assert_eq!(summary.aggregates.unexpected_passes, 0);
    }
}
