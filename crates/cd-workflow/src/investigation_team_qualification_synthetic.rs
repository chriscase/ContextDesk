//! Deterministic synthetic Investigation Team qualification runner.
//!
//! This is an acceptance tool for the shipped
//! [`crate::investigation_team_qualification::execute`] seam. It never
//! contacts a provider, credential store, network, filesystem, or UI, and it
//! never claims live model quality or real evidence. A trusted host supplies
//! exact [`MemberBinding`] values and an observation timestamp; this module
//! mints an opaque packet plus host-only evaluator truth and forwards the
//! assembled [`QualificationInput`] to `execute`.

use std::collections::{BTreeMap, BTreeSet};

use cd_core::error::{CoreError, CoreResult};
use cd_core::investigation_answer::EvidenceRole;
use cd_core::investigation_team_qualification::{
    policy_budget_identity, AttemptClaim, AttemptRecord, AttemptStatus, CitationRecord,
    EvaluatorTruth, MemberBinding, ProviderFacingDocument, ProviderFacingInput, QualificationInput,
    ToolCallRecord, SCHEMA_ID, SUITE_VERSION,
};

use crate::investigation_team_qualification::{execute, QualificationExecutionResult};

/// Opaque evidence id shown to the synthetic packet only.
const SYNTHETIC_EVIDENCE_ID: &str = "xid-syn-ev-alpha";
/// Host-only source id paired with [`SYNTHETIC_EVIDENCE_ID`].
const SYNTHETIC_SOURCE_ID: &str = "xid-syn-src-alpha";
/// Host-only time anchor paired with [`SYNTHETIC_EVIDENCE_ID`].
const SYNTHETIC_TIME_ANCHOR: &str = "t-syn-alpha-1";
/// Provider-facing packet text. Contains no evaluator truth and no excerpts
/// of a real corpus.
const SYNTHETIC_PACKET_TEXT: &str = "opaque synthetic packet line";
/// Provider-facing question. Not an evaluator key.
const SYNTHETIC_QUESTION: &str = "Which opaque packet lines are required?";
/// Tokens that must never appear in provider-facing bytes.
const SYNTHETIC_FORBIDDEN_TRUTH_TOKEN: &str = "evaluator_truth";
const SYNTHETIC_FORBIDDEN_ANSWER_KEY: &str = "answer_key";
const MAX_TOOL_CALLS: u32 = 4;
const RESOURCE_BUDGET: u64 = 100;
const ATTEMPT_LATENCY_MS: u64 = 20;
const ATTEMPT_RESOURCE_UNITS: u64 = 8;

/// Deterministic synthetic run shape. These modes are fixture scripts, not
/// observed provider outcomes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyntheticQualificationMode {
    /// Every member records a completed attempt that cites the opaque packet.
    Completed,
    /// Every member records an honest partial attempt.
    Partial,
    /// Completed attempts bound to a stale suite version.
    Stale,
}

/// Host-supplied synthetic qualification request.
///
/// `members` and `observed_at` come from the trusted host. Packet bytes and
/// evaluator truth are minted here and are not host-editable through this
/// API, so a caller cannot smuggle evaluator truth into the provider-facing
/// packet.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyntheticQualificationRequest {
    /// Exact pipeline members. Roles must be unique; a model subject may be
    /// shared across distinct roles.
    pub members: Vec<MemberBinding>,
    /// Unix seconds when the host observed the run. Must be positive.
    pub observed_at: i64,
    /// Which synthetic fixture script to assemble.
    pub mode: SyntheticQualificationMode,
}

/// Execute one synthetic qualification against the shipped `execute` seam.
///
/// Naming is deliberate: this is not a live runner. Status values are the
/// existing [`crate::investigation_team_qualification::QualificationStatus`]
/// labels produced by `execute`, not a claim that a model ran.
pub fn execute_synthetic(
    request: SyntheticQualificationRequest,
) -> CoreResult<QualificationExecutionResult> {
    let input = synthetic_qualification_input(request)?;
    execute(input)
}

fn synthetic_qualification_input(
    request: SyntheticQualificationRequest,
) -> CoreResult<QualificationInput> {
    if request.observed_at <= 0 {
        return Err(CoreError::Config(
            "synthetic qualification observed_at must be a positive unix timestamp".into(),
        ));
    }

    let stale = matches!(request.mode, SyntheticQualificationMode::Stale);
    let attempt_status = match request.mode {
        SyntheticQualificationMode::Completed | SyntheticQualificationMode::Stale => {
            AttemptStatus::Completed
        }
        SyntheticQualificationMode::Partial => AttemptStatus::Partial,
    };
    let attempts = request
        .members
        .iter()
        .map(|member| synthetic_attempt(member, attempt_status))
        .collect();

    Ok(QualificationInput {
        schema_id: SCHEMA_ID.into(),
        current_suite_version: SUITE_VERSION.into(),
        suite_version: if stale {
            "contextdesk.investigation_team_qualification.suite.v0".into()
        } else {
            SUITE_VERSION.into()
        },
        observed_at: request.observed_at,
        stale,
        policy_budget_identity: policy_budget_identity(MAX_TOOL_CALLS, RESOURCE_BUDGET),
        max_tool_calls: MAX_TOOL_CALLS,
        resource_budget: RESOURCE_BUDGET,
        members: request.members,
        provider_facing: ProviderFacingInput {
            question: SYNTHETIC_QUESTION.into(),
            evidence_packet: vec![ProviderFacingDocument {
                id: SYNTHETIC_EVIDENCE_ID.into(),
                text: SYNTHETIC_PACKET_TEXT.into(),
            }],
        },
        truth: EvaluatorTruth {
            required_evidence_ids: BTreeSet::from([SYNTHETIC_EVIDENCE_ID.into()]),
            required_sources: BTreeMap::from([(
                SYNTHETIC_EVIDENCE_ID.into(),
                SYNTHETIC_SOURCE_ID.into(),
            )]),
            required_times: BTreeMap::from([(
                SYNTHETIC_EVIDENCE_ID.into(),
                SYNTHETIC_TIME_ANCHOR.into(),
            )]),
            forbidden_provider_tokens: BTreeSet::from([
                SYNTHETIC_FORBIDDEN_TRUTH_TOKEN.into(),
                SYNTHETIC_FORBIDDEN_ANSWER_KEY.into(),
            ]),
        },
        attempts,
    })
}

fn synthetic_attempt(member: &MemberBinding, status: AttemptStatus) -> AttemptRecord {
    let completed = matches!(status, AttemptStatus::Completed);
    AttemptRecord {
        attempt_id: format!("xid-syn-attempt-{}", member.role.as_str()),
        role: member.role,
        model_id: member.model_id.clone(),
        profile_id: member.profile_id.clone(),
        endpoint_fingerprint: member.endpoint_fingerprint.clone(),
        status,
        completion_claimed: completed,
        claims: if completed {
            vec![AttemptClaim {
                text: "opaque packet line is cited".into(),
                evidence_ids: vec![SYNTHETIC_EVIDENCE_ID.into()],
            }]
        } else {
            vec![]
        },
        tool_calls: if completed {
            vec![ToolCallRecord {
                name: "cd_qualify_lookup".into(),
                evidence_ids: vec![SYNTHETIC_EVIDENCE_ID.into()],
            }]
        } else {
            vec![]
        },
        citations: if completed {
            vec![CitationRecord {
                evidence_id: SYNTHETIC_EVIDENCE_ID.into(),
                source_id: SYNTHETIC_SOURCE_ID.into(),
                time_anchor: SYNTHETIC_TIME_ANCHOR.into(),
                role: EvidenceRole::Supporting,
            }]
        } else {
            vec![]
        },
        latency_ms: ATTEMPT_LATENCY_MS,
        resource_units: ATTEMPT_RESOURCE_UNITS,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cd_core::investigation_team_qualification::{
        InvestigationTeamRole, MemberBinding, SCHEMA_ID,
    };

    fn member(role: InvestigationTeamRole) -> MemberBinding {
        MemberBinding::from_deployment(
            role,
            "xid-syn-profile-nimbus",
            "xid-syn-model-orion",
            "https://xid-syn-gateway.example.test/v1",
        )
        .expect("synthetic member")
    }

    #[test]
    fn unit_input_keeps_evaluator_truth_off_the_packet() {
        let input = synthetic_qualification_input(SyntheticQualificationRequest {
            members: vec![member(InvestigationTeamRole::Single)],
            observed_at: 1_777_000_000,
            mode: SyntheticQualificationMode::Completed,
        })
        .expect("synthetic input");
        assert_eq!(input.schema_id, SCHEMA_ID);
        let packet = serde_json::to_string(&input.provider_facing).expect("packet json");
        assert!(packet.contains(SYNTHETIC_PACKET_TEXT));
        assert!(!packet.contains("evaluator_truth"));
        assert!(!packet.contains("answer_key"));
        assert!(!packet.contains("https://"));
        assert!(input
            .truth
            .forbidden_provider_tokens
            .contains("evaluator_truth"));
        let _ = execute_synthetic;
    }
}
