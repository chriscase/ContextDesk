//! Host-owned publication/readout for Investigation Team qualification.
//!
//! The renderer can read the latest process-local result, but it cannot submit
//! evaluator truth or manufacture a qualification. Trusted execution code
//! publishes through [`publish`], after calling the `cd_workflow` seam with a
//! host-built input. Nothing in this store is persisted yet.

use cd_core::capability_qualification::{
    QualificationTransport, SyntheticChatRequest, SyntheticChatResponse, SyntheticMessage,
};
use cd_core::config::AppConfig;
use cd_core::error::{CoreError, CoreResult};
use cd_core::investigation_answer::EvidenceRole;
use cd_core::investigation_team_qualification::{
    policy_budget_identity, AttemptClaim, AttemptRecord, AttemptStatus, AxisScore, CitationRecord,
    EvaluatorTruth, FingerprintedMember, InvestigationTeamRole, MemberBinding,
    ProviderFacingDocument, ProviderFacingInput, QualificationInput, ToolCallRecord, SCHEMA_ID,
    SUITE_VERSION,
};
use cd_core::openai_chat_contract::OpenAiChatRequestMode;
use cd_workflow::capability_qualification::{LiveBackendKind, LiveQualificationTransport};
use cd_workflow::investigation_team_qualification::{
    QualificationExecutionResult, QualificationStatus,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

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
    /// Exact non-secret role/profile/model identities used for this report.
    /// This is copied from the host-validated fingerprint, not current settings.
    pub members: Vec<InvestigationTeamMemberDto>,
    pub failures: Vec<InvestigationTeamAttemptFailureDto>,
    pub redacted_json: String,
    pub redacted_markdown: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InvestigationTeamMemberDto {
    pub role: InvestigationTeamRole,
    pub subject_storage_id: String,
    pub profile_id: String,
    pub model_id: String,
    pub endpoint_fingerprint: String,
}

impl From<FingerprintedMember> for InvestigationTeamMemberDto {
    fn from(member: FingerprintedMember) -> Self {
        Self {
            role: member.role,
            subject_storage_id: member.subject_storage_id,
            profile_id: member.profile_id,
            model_id: member.model_id,
            endpoint_fingerprint: member.endpoint_fingerprint,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InvestigationTeamAttemptFailureDto {
    pub attempt_id: String,
    pub role: InvestigationTeamRole,
    pub reason: String,
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
            members: report
                .fingerprint
                .members
                .into_iter()
                .map(Into::into)
                .collect(),
            failures: Vec::new(),
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

    pub fn publish_live(&mut self, execution: LiveQualificationExecutionResult) {
        let failures = execution.failures;
        let mut dto: InvestigationTeamQualificationDto = execution.result.into();
        dto.failures = failures;
        self.latest = Some(dto);
    }

    pub fn latest(&self) -> Option<InvestigationTeamQualificationDto> {
        self.latest.clone()
    }

    pub fn clear(&mut self) -> bool {
        self.latest.take().is_some()
    }
}

/// A trusted provider-backed member target. Credentials and raw deployment
/// details stay inside the host and never enter the DTO or redacted report.
pub struct LiveQualificationTarget {
    pub member: MemberBinding,
    pub backend: LiveBackendKind,
    pub base_url: String,
    pub api_key: Option<String>,
    pub extra_headers: Vec<(String, String)>,
    pub local_only: bool,
}

#[derive(Debug, Clone)]
pub struct LiveQualificationExecutionResult {
    pub result: QualificationExecutionResult,
    pub failures: Vec<InvestigationTeamAttemptFailureDto>,
}

pub const LIVE_QUALIFICATION_CANCEL_KEY: &str = "investigation_team_qualification_live";

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ProviderQualificationAnswer {
    claims: Vec<ProviderQualificationClaim>,
    citations: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ProviderQualificationClaim {
    text: String,
    evidence_ids: Vec<String>,
}

/// A host-controlled outcome used by tests and the explicit local synthetic
/// check. It is never accepted from renderer input.
#[allow(dead_code)]
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

const LIVE_EVIDENCE_ID: &str = "live-qualification-evidence-1";
const LIVE_SOURCE_ID: &str = "live-qualification-source-1";
const LIVE_TIME_ANCHOR: &str = "live-qualification-time-1";
const LIVE_MAX_TOOL_CALLS: u32 = 4;
const LIVE_RESOURCE_BUDGET: u64 = 32_768;

fn live_input_shell(
    members: Vec<MemberBinding>,
    observed_at: i64,
) -> CoreResult<QualificationInput> {
    let mut input = synthetic_input(members, observed_at, SyntheticQualificationMode::Completed)?;
    input.attempts.clear();
    input.max_tool_calls = LIVE_MAX_TOOL_CALLS;
    input.resource_budget = LIVE_RESOURCE_BUDGET;
    input.policy_budget_identity =
        policy_budget_identity(input.max_tool_calls, input.resource_budget);
    input.provider_facing.question =
        "Return a JSON qualification answer using only the opaque evidence ids provided.".into();
    input.provider_facing.evidence_packet = vec![ProviderFacingDocument {
        id: LIVE_EVIDENCE_ID.into(),
        text: "An opaque host-owned evidence item for a bounded qualification check.".into(),
    }];
    input.truth = EvaluatorTruth {
        required_evidence_ids: BTreeSet::from([LIVE_EVIDENCE_ID.into()]),
        required_sources: BTreeMap::from([(LIVE_EVIDENCE_ID.into(), LIVE_SOURCE_ID.into())]),
        required_times: BTreeMap::from([(LIVE_EVIDENCE_ID.into(), LIVE_TIME_ANCHOR.into())]),
        forbidden_provider_tokens: BTreeSet::new(),
    };
    Ok(input)
}

fn live_request(model_id: &str, input: &QualificationInput) -> CoreResult<SyntheticChatRequest> {
    let packet = serde_json::to_string(&input.provider_facing)
        .map_err(|error| CoreError::Config(format!("qualification packet: {error}")))?;
    Ok(SyntheticChatRequest {
        model_id: model_id.into(),
        messages: vec![
            SyntheticMessage {
                role: "system".into(),
                content: "You are completing a bounded ContextDesk response-format check. Return only one JSON object with exactly these keys: claims and citations. claims is an array of objects with text and evidence_ids. citations is an array of evidence id strings. Cite only ids present in the packet.".into(),
                tool_call_id: None,
                tool_calls: Vec::new(),
            },
            SyntheticMessage {
                role: "user".into(),
                content: format!("Qualification packet:\n{packet}"),
                tool_call_id: None,
                tool_calls: Vec::new(),
            },
        ],
        tools: Vec::new(),
        stream: false,
        chat_mode: OpenAiChatRequestMode::PromptedJson,
    })
}

fn live_failure(
    attempt_id: &str,
    role: InvestigationTeamRole,
    reason: impl Into<String>,
) -> InvestigationTeamAttemptFailureDto {
    InvestigationTeamAttemptFailureDto {
        attempt_id: attempt_id.into(),
        role,
        reason: reason.into(),
    }
}

fn attempt_from_response(
    target: &LiveQualificationTarget,
    attempt_id: &str,
    input: &QualificationInput,
    response: SyntheticChatResponse,
    elapsed_ms: u64,
) -> (AttemptRecord, Option<InvestigationTeamAttemptFailureDto>) {
    let resource_units = input.provider_facing.question.len() as u64
        + input
            .provider_facing
            .evidence_packet
            .iter()
            .map(|document| document.id.len() + document.text.len())
            .sum::<usize>() as u64
        + response.content.len() as u64;
    let role = target.member.role;
    let mut failure = None;

    let (status, completion_claimed, claims, citations) = if response.cancelled {
        failure = Some(live_failure(
            attempt_id,
            role,
            "provider attempt was cancelled",
        ));
        (AttemptStatus::Cancelled, false, Vec::new(), Vec::new())
    } else if let Some(reason) = response.raw_error {
        failure = Some(live_failure(attempt_id, role, reason));
        (AttemptStatus::Failed, false, Vec::new(), Vec::new())
    } else {
        match serde_json::from_str::<ProviderQualificationAnswer>(&response.content) {
            Ok(answer) => {
                let invalid_citation = answer
                    .citations
                    .iter()
                    .any(|evidence_id| evidence_id != LIVE_EVIDENCE_ID);
                if invalid_citation {
                    failure = Some(live_failure(
                        attempt_id,
                        role,
                        "provider cited an unknown qualification evidence id",
                    ));
                    (AttemptStatus::Failed, false, Vec::new(), Vec::new())
                } else {
                    let claims = answer
                        .claims
                        .into_iter()
                        .map(|claim| AttemptClaim {
                            text: claim.text,
                            evidence_ids: claim.evidence_ids,
                        })
                        .collect();
                    let citations = answer
                        .citations
                        .into_iter()
                        .map(|evidence_id| CitationRecord {
                            evidence_id,
                            source_id: LIVE_SOURCE_ID.into(),
                            time_anchor: LIVE_TIME_ANCHOR.into(),
                            role: EvidenceRole::Supporting,
                        })
                        .collect();
                    (AttemptStatus::Completed, true, claims, citations)
                }
            }
            Err(error) => {
                failure = Some(live_failure(
                    attempt_id,
                    role,
                    format!("provider response was not strict qualification JSON: {error}"),
                ));
                (AttemptStatus::Failed, false, Vec::new(), Vec::new())
            }
        }
    };

    let tool_calls = response
        .tool_calls
        .into_iter()
        .map(|call| ToolCallRecord {
            name: call.name,
            evidence_ids: Vec::new(),
        })
        .collect();
    (
        AttemptRecord {
            attempt_id: attempt_id.into(),
            role,
            model_id: target.member.model_id.clone(),
            profile_id: target.member.profile_id.clone(),
            endpoint_fingerprint: target.member.endpoint_fingerprint.clone(),
            status,
            completion_claimed,
            claims,
            tool_calls,
            citations,
            latency_ms: elapsed_ms,
            resource_units,
        },
        failure,
    )
}

/// Run one bounded provider-backed qualification attempt per host-owned role.
/// Provider bytes contain only opaque evidence; evaluator truth is attached
/// after the response returns and never crosses the provider boundary.
pub fn execute_live(
    targets: Vec<LiveQualificationTarget>,
    observed_at: i64,
    cancel: &AtomicBool,
) -> CoreResult<LiveQualificationExecutionResult> {
    if targets.is_empty() {
        return Err(CoreError::Config(
            "live qualification requires at least one host-owned target".into(),
        ));
    }
    let members = targets.iter().map(|target| target.member.clone()).collect();
    let mut input = live_input_shell(members, observed_at)?;
    let mut failures = Vec::new();

    for (index, target) in targets.iter().enumerate() {
        let attempt_id = format!("live-qualification-attempt-{}", index + 1);
        if cancel.load(Ordering::SeqCst) {
            failures.push(live_failure(
                &attempt_id,
                target.member.role,
                "provider attempt was cancelled before dispatch",
            ));
            input.attempts.push(AttemptRecord {
                attempt_id: attempt_id.clone(),
                role: target.member.role,
                model_id: target.member.model_id.clone(),
                profile_id: target.member.profile_id.clone(),
                endpoint_fingerprint: target.member.endpoint_fingerprint.clone(),
                status: AttemptStatus::Cancelled,
                completion_claimed: false,
                claims: Vec::new(),
                tool_calls: Vec::new(),
                citations: Vec::new(),
                latency_ms: 0,
                resource_units: 0,
            });
            continue;
        }
        let request = live_request(&target.member.model_id, &input)?;
        let mut transport = LiveQualificationTransport::new(
            target.backend,
            target.base_url.clone(),
            target.api_key.clone(),
            target.local_only,
        )
        .with_extra_headers(target.extra_headers.clone());
        let started = Instant::now();
        let response = match transport.chat_complete(&request, cancel) {
            Ok(response) => response,
            Err(error) => SyntheticChatResponse {
                raw_error: Some(error.reason),
                ..SyntheticChatResponse::default()
            },
        };
        let elapsed_ms = started.elapsed().as_millis() as u64;
        let (attempt, failure) =
            attempt_from_response(target, &attempt_id, &input, response, elapsed_ms);
        if let Some(failure) = failure {
            failures.push(failure);
        }
        input.attempts.push(attempt);
    }

    Ok(LiveQualificationExecutionResult {
        result: cd_workflow::investigation_team_qualification::execute(input)?,
        failures,
    })
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

    fn live_target(role: InvestigationTeamRole) -> LiveQualificationTarget {
        LiveQualificationTarget {
            member: member(role, "p-a", "m-a"),
            backend: LiveBackendKind::OpenAiCompatible,
            base_url: "https://synthetic.example.test/v1".into(),
            api_key: None,
            extra_headers: Vec::new(),
            local_only: false,
        }
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
        let dto = InvestigationTeamQualificationDto::from(result);
        assert_eq!(dto.members.len(), 2);
        assert_eq!(dto.members[0].profile_id, "p-a");
        assert_eq!(dto.members[1].model_id, "m-a");
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

    #[test]
    fn live_response_maps_to_exact_host_citation_without_exposing_truth() {
        let mut target = live_target(InvestigationTeamRole::Single);
        target.api_key = Some("provider-secret".into());
        target.extra_headers = vec![("x-private-header".into(), "private-value".into())];
        let input =
            live_input_shell(vec![target.member.clone()], 1_777_000_000).expect("live input");
        let (attempt, failure) = attempt_from_response(
            &target,
            "live-qualification-attempt-1",
            &input,
            SyntheticChatResponse {
                content: r#"{"claims":[{"text":"opaque answer","evidence_ids":["live-qualification-evidence-1"]}],"citations":["live-qualification-evidence-1"]}"#.into(),
                ..SyntheticChatResponse::default()
            },
            42,
        );
        assert!(failure.is_none());
        assert_eq!(attempt.status, AttemptStatus::Completed);
        assert_eq!(attempt.citations[0].source_id, LIVE_SOURCE_ID);
        assert_eq!(attempt.citations[0].time_anchor, LIVE_TIME_ANCHOR);
        let mut qualified_input = input;
        qualified_input.attempts.push(attempt);
        let result = cd_workflow::investigation_team_qualification::execute(qualified_input)
            .expect("live-shaped input");
        assert_eq!(result.status, QualificationStatus::Qualified);
        assert!(!result.redacted_json.contains(LIVE_SOURCE_ID));
        assert!(!result.redacted_json.contains("opaque answer"));
        let dto = InvestigationTeamQualificationDto::from(result);
        let renderer_wire = serde_json::to_string(&dto).expect("renderer DTO");
        assert!(!renderer_wire.contains("synthetic.example.test"));
        assert!(!renderer_wire.contains("provider-secret"));
        assert!(!renderer_wire.contains("x-private-header"));
        assert_eq!(dto.members.len(), 1);
        assert!(dto.members[0].endpoint_fingerprint.len() >= 64);
    }

    #[test]
    fn live_request_contains_only_opaque_packet_and_strict_wire_mode() {
        let target = live_target(InvestigationTeamRole::Single);
        let input = live_input_shell(vec![target.member], 1_777_000_000).expect("live input");
        let request = live_request("m-a", &input).expect("live request");
        let wire = request
            .messages
            .iter()
            .map(|message| message.content.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        assert_eq!(request.chat_mode, OpenAiChatRequestMode::PromptedJson);
        assert!(wire.contains(LIVE_EVIDENCE_ID));
        assert!(!wire.contains(LIVE_SOURCE_ID));
        assert!(!wire.contains(LIVE_TIME_ANCHOR));
        assert!(!wire.contains("required_evidence_ids"));
    }

    #[test]
    fn live_transport_failure_and_cancellation_keep_measured_incomplete_attempts() {
        let target = live_target(InvestigationTeamRole::Single);
        let input =
            live_input_shell(vec![target.member.clone()], 1_777_000_000).expect("live input");
        let (failed, failure) = attempt_from_response(
            &target,
            "live-qualification-attempt-1",
            &input,
            SyntheticChatResponse {
                raw_error: Some("provider unavailable".into()),
                ..SyntheticChatResponse::default()
            },
            17,
        );
        assert_eq!(failed.status, AttemptStatus::Failed);
        assert_eq!(failed.latency_ms, 17);
        assert!(failed.resource_units > 0);
        assert_eq!(failure.expect("failure").reason, "provider unavailable");

        let (cancelled, failure) = attempt_from_response(
            &target,
            "live-qualification-attempt-2",
            &input,
            SyntheticChatResponse {
                cancelled: true,
                ..SyntheticChatResponse::default()
            },
            3,
        );
        assert_eq!(cancelled.status, AttemptStatus::Cancelled);
        assert!(!cancelled.completion_claimed);
        assert_eq!(
            failure.expect("cancellation").role,
            InvestigationTeamRole::Single
        );
    }

    #[test]
    fn live_unknown_citation_is_failed_and_visible() {
        let target = live_target(InvestigationTeamRole::Single);
        let input =
            live_input_shell(vec![target.member.clone()], 1_777_000_000).expect("live input");
        let (attempt, failure) = attempt_from_response(
            &target,
            "live-qualification-attempt-1",
            &input,
            SyntheticChatResponse {
                content: r#"{"claims":[],"citations":["not-in-packet"]}"#.into(),
                ..SyntheticChatResponse::default()
            },
            42,
        );
        assert_eq!(attempt.status, AttemptStatus::Failed);
        assert_eq!(
            failure.expect("failure").reason,
            "provider cited an unknown qualification evidence id"
        );
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
