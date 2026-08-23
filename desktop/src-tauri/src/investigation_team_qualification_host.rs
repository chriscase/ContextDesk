//! Host-owned publication/readout for Investigation Team qualification.
//!
//! The renderer can read the latest process-local result, but it cannot submit
//! evaluator truth or manufacture a qualification. Trusted execution code
//! publishes through [`publish`], after calling the `cd_workflow` seam with a
//! host-built input. Nothing in this store is persisted yet.

use cd_core::investigation_team_qualification::AxisScore;
use cd_workflow::investigation_team_qualification::{
    QualificationExecutionResult, QualificationStatus,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QualificationAxisDto {
    pub contract_met: bool,
    pub metrics: std::collections::BTreeMap<String, u64>,
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InvestigationTeamQualificationDto {
    pub status: QualificationStatus,
    pub schema_id: String,
    pub suite_version: String,
    pub observed_at: i64,
    pub stale: bool,
    pub incomplete_attempts: bool,
    pub fingerprint_digest: String,
    pub scoring_digest: String,
    pub capability: QualificationAxisDto,
    pub quality: QualificationAxisDto,
    pub speed: QualificationAxisDto,
    pub resource: QualificationAxisDto,
    pub redacted_json: String,
    pub redacted_markdown: String,
}

impl From<AxisScore> for QualificationAxisDto {
    fn from(axis: AxisScore) -> Self {
        Self {
            contract_met: axis.contract_met,
            metrics: axis.metrics,
            notes: axis.notes,
        }
    }
}

impl From<QualificationExecutionResult> for InvestigationTeamQualificationDto {
    fn from(result: QualificationExecutionResult) -> Self {
        let incomplete_attempts = result.has_incomplete_attempt();
        let report = result.report;
        Self {
            status: result.status,
            schema_id: report.schema_id,
            suite_version: report.fingerprint.suite_version.clone(),
            observed_at: report.fingerprint.observed_at,
            stale: report.fingerprint.stale,
            incomplete_attempts,
            fingerprint_digest: report.fingerprint.digest,
            scoring_digest: report.scoring_digest,
            capability: report.axes.capability.into(),
            quality: report.axes.quality.into(),
            speed: report.axes.speed.into(),
            resource: report.axes.resource.into(),
            redacted_json: result.redacted_json,
            redacted_markdown: result.redacted_markdown,
        }
    }
}

#[derive(Debug, Default)]
pub struct InvestigationTeamQualificationStore {
    latest: Option<InvestigationTeamQualificationDto>,
}

impl InvestigationTeamQualificationStore {
    /// Publish only from trusted host execution code; renderer IPC has no
    /// setter for this store.
    #[allow(dead_code)]
    pub fn publish(&mut self, result: QualificationExecutionResult) {
        self.latest = Some(result.into());
    }

    pub fn latest(&self) -> Option<InvestigationTeamQualificationDto> {
        self.latest.clone()
    }

    pub fn clear(&mut self) -> bool {
        self.latest.take().is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn store_is_empty_until_trusted_code_publishes() {
        let store = InvestigationTeamQualificationStore::default();
        assert!(store.latest().is_none());
    }

    #[test]
    fn clear_is_idempotent() {
        let mut store = InvestigationTeamQualificationStore::default();
        assert!(!store.clear());
        assert!(!store.clear());
    }
}
