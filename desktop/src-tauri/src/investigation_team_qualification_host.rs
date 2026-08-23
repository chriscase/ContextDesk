//! Host-owned publication/readout for Investigation Team qualification.
//!
//! The renderer can read the latest process-local result, but it cannot submit
//! evaluator truth or manufacture a qualification. Trusted execution code
//! publishes through [`publish`], after calling the `cd_workflow` seam with a
//! host-built input. Nothing in this store is persisted yet.

use cd_core::config::AppConfig;
use cd_core::error::{CoreError, CoreResult};
use cd_core::investigation_answer::EvidenceRole;
use cd_core::investigation_team_qualification::{
    policy_budget_identity, AttemptClaim, AttemptRecord, AttemptStatus, AxisScore, CitationRecord,
    EvaluatorTruth, InvestigationTeamRole, MemberBinding, ProviderFacingDocument,
    ProviderFacingInput, QualificationInput, ToolCallRecord, SCHEMA_ID, SUITE_VERSION,
};
use cd_workflow::investigation_team_qualification::{
    QualificationExecutionResult, QualificationStatus,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

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

/// A host-controlled outcome used by tests and the explicit local synthetic
/// check. It is never accepted from renderer input.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyntheticQualificationMode {
    /// Every deterministic fixture attempt completes.
    Completed,
    /// One deterministic fixture attempt remains incomplete.
    Partial,
    /// The fixture claims an older suite and must be treated as stale.
    Stale,
}

/// Build the small opaque packet used by the local synthetic qualification
/// check. This function does not contact a provider and does not persist data.
pub fn synthetic_input(
    members: Vec<MemberBinding>,
    observed_at: i64,
    mode: SyntheticQualificationMode,
) -> CoreResult<QualificationInput> {
    if observed_at <= 0 {
        return Err(CoreError::Config(
            "synthetic qualification requires a positive observation timestamp".into(),
        ));
    }
    if members.is_empty() {
        return Err(CoreError::Config(
            "synthetic qualification requires at least one host-owned team member".into(),
        ));
    }

    let evidence_id = "synthetic-evidence-1".to_string();
    let source_id = "synthetic-source-1".to_string();
    let time_anchor = "synthetic-time-1".to_string();
    let max_tool_calls = 4;
    let resource_budget = 100;
    let attempt_status = match mode {
        SyntheticQualificationMode::Completed | SyntheticQualificationMode::Stale => {
            AttemptStatus::Completed
        }
        SyntheticQualificationMode::Partial => AttemptStatus::Partial,
    };
    let suite_version = match mode {
        SyntheticQualificationMode::Stale => {
            "contextdesk.investigation_team_qualification.suite.v0"
        }
        SyntheticQualificationMode::Completed | SyntheticQualificationMode::Partial => {
            SUITE_VERSION
        }
    };

    let attempts = members
        .iter()
        .enumerate()
        .map(|(index, member)| AttemptRecord {
            attempt_id: format!("synthetic-attempt-{}", index + 1),
            role: member.role,
            model_id: member.model_id.clone(),
            profile_id: member.profile_id.clone(),
            endpoint_fingerprint: member.endpoint_fingerprint.clone(),
            status: attempt_status,
            completion_claimed: attempt_status.may_claim_completion(),
            claims: vec![AttemptClaim {
                text: "synthetic contract witness".into(),
                evidence_ids: vec![evidence_id.clone()],
            }],
            tool_calls: vec![ToolCallRecord {
                name: "cd_qualify_lookup".into(),
                evidence_ids: vec![evidence_id.clone()],
            }],
            citations: vec![CitationRecord {
                evidence_id: evidence_id.clone(),
                source_id: source_id.clone(),
                time_anchor: time_anchor.clone(),
                role: EvidenceRole::Supporting,
            }],
            latency_ms: 20,
            resource_units: 8,
        })
        .collect();

    Ok(QualificationInput {
        schema_id: SCHEMA_ID.into(),
        current_suite_version: SUITE_VERSION.into(),
        suite_version: suite_version.into(),
        observed_at,
        stale: matches!(mode, SyntheticQualificationMode::Stale),
        policy_budget_identity: policy_budget_identity(max_tool_calls, resource_budget),
        max_tool_calls,
        resource_budget,
        members,
        provider_facing: ProviderFacingInput {
            question: "Which opaque evidence item is bound to this local contract check?".into(),
            evidence_packet: vec![ProviderFacingDocument {
                id: evidence_id,
                text: "Opaque synthetic evidence for local contract verification.".into(),
            }],
        },
        truth: EvaluatorTruth {
            required_evidence_ids: BTreeSet::from(["synthetic-evidence-1".into()]),
            required_sources: BTreeMap::from([("synthetic-evidence-1".into(), source_id)]),
            required_times: BTreeMap::from([("synthetic-evidence-1".into(), time_anchor)]),
            forbidden_provider_tokens: BTreeSet::new(),
        },
        attempts,
    })
}

/// Execute the explicit local synthetic check through the same host workflow
/// seam used by future real execution. The returned result remains redacted.
pub fn execute_synthetic(
    members: Vec<MemberBinding>,
    observed_at: i64,
) -> CoreResult<QualificationExecutionResult> {
    cd_workflow::investigation_team_qualification::execute(synthetic_input(
        members,
        observed_at,
        SyntheticQualificationMode::Completed,
    )?)
}

fn member_for_profile(
    profile: &cd_core::providers::ProviderProfile,
    role: InvestigationTeamRole,
    model_override: Option<&str>,
) -> CoreResult<MemberBinding> {
    let model = model_override.unwrap_or(&profile.chat_model);
    MemberBinding::from_deployment(role, &profile.id, model, &profile.base_url)
        .map_err(|error| CoreError::Config(format!("invalid team member: {error}")))
}

/// Derive the representable V1 role set from trusted persisted settings.
/// Contribution roles beyond the V1 role vocabulary fail closed instead of
/// being relabeled as a different role.
pub fn members_from_config(cfg: &AppConfig) -> CoreResult<Vec<MemberBinding>> {
    let mode = if cfg.contributions.enabled {
        cd_core::multi_model::MultiModelMode::Contributions
    } else {
        cfg.multi_model.mode
    };
    let active = cfg
        .providers
        .active()
        .ok_or_else(|| CoreError::Config("no active provider profile is configured".into()))?;
    let investigator_role = if matches!(mode, cd_core::multi_model::MultiModelMode::Single) {
        InvestigationTeamRole::Single
    } else {
        InvestigationTeamRole::Investigator
    };
    let mut members = vec![member_for_profile(active, investigator_role, None)?];

    match mode {
        cd_core::multi_model::MultiModelMode::Single => {}
        cd_core::multi_model::MultiModelMode::Review => {
            let reviewer = cfg.multi_model.reviewer.as_ref().ok_or_else(|| {
                CoreError::Config("review mode has no configured reviewer profile".into())
            })?;
            let profile = cfg
                .providers
                .profiles
                .iter()
                .find(|candidate| candidate.id == reviewer.profile_id)
                .ok_or_else(|| {
                    CoreError::Config(format!(
                        "reviewer profile is not present: {}",
                        reviewer.profile_id
                    ))
                })?;
            members.push(member_for_profile(
                profile,
                InvestigationTeamRole::Reviewer,
                reviewer.model.as_deref(),
            )?);
        }
        cd_core::multi_model::MultiModelMode::Contributions => {
            return Err(CoreError::Config(
                "synthetic qualification V1 does not yet represent contribution-role topology; use the host qualification report after a real bounded run".into(),
            ));
        }
    }
    Ok(members)
}

#[cfg(test)]
mod synthetic_tests {
    use super::*;

    fn member(role: InvestigationTeamRole, profile: &str, model: &str) -> MemberBinding {
        MemberBinding::from_deployment(role, profile, model, "https://synthetic.example.test/v1")
            .expect("member")
    }

    #[test]
    fn completed_fixture_is_qualified_and_redacted() {
        let result = execute_synthetic(
            vec![
                member(InvestigationTeamRole::Investigator, "p-a", "m-a"),
                member(InvestigationTeamRole::Reviewer, "p-a", "m-a"),
            ],
            1_777_000_000,
        )
        .expect("synthetic qualification");
        assert_eq!(result.status, QualificationStatus::Qualified);
        assert!(!result.redacted_json.contains("synthetic.example"));
        assert!(!result.redacted_json.contains("contract witness"));
        assert_eq!(result.report.fingerprint.members.len(), 2);
    }

    #[test]
    fn partial_and_stale_modes_are_not_presented_as_qualified() {
        let partial = cd_workflow::investigation_team_qualification::execute(
            synthetic_input(
                vec![member(InvestigationTeamRole::Single, "p-a", "m-a")],
                1_777_000_000,
                SyntheticQualificationMode::Partial,
            )
            .expect("partial input"),
        )
        .expect("partial result");
        assert_eq!(partial.status, QualificationStatus::Partial);

        let stale = cd_workflow::investigation_team_qualification::execute(
            synthetic_input(
                vec![member(InvestigationTeamRole::Single, "p-a", "m-a")],
                1_777_000_000,
                SyntheticQualificationMode::Stale,
            )
            .expect("stale input"),
        )
        .expect("stale result");
        assert_eq!(stale.status, QualificationStatus::Stale);
    }

    #[test]
    fn empty_members_and_non_positive_time_fail_closed() {
        assert!(synthetic_input(
            Vec::new(),
            1_777_000_000,
            SyntheticQualificationMode::Completed
        )
        .is_err());
        assert!(synthetic_input(
            vec![member(InvestigationTeamRole::Single, "p-a", "m-a")],
            0,
            SyntheticQualificationMode::Completed
        )
        .is_err());
    }

    #[test]
    fn duplicate_roles_are_rejected_by_the_shipped_core() {
        let result = cd_workflow::investigation_team_qualification::execute(
            synthetic_input(
                vec![
                    member(InvestigationTeamRole::Single, "p-a", "m-a"),
                    member(InvestigationTeamRole::Single, "p-b", "m-b"),
                ],
                1_777_000_000,
                SyntheticQualificationMode::Completed,
            )
            .expect("input construction"),
        );
        assert!(result.is_err());
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
