//! Provider-neutral Investigation Team qualification core V1 (issue #726 slice).
//!
//! Pure scoring, fingerprinting, and redacted report rendering. No I/O,
//! transports, credentials, persistence, UI, or provider calls. Results never
//! transfer across profiles, models, aliases, or deployments. There is no
//! universal “best model” score.

use crate::capability_qualification::fingerprint_endpoint;
use crate::error::{CoreError, CoreResult};
use crate::investigation_answer::EvidenceRole;
use crate::model_ref::ModelRef;
use crate::quality_eval::{
    hex_sha256, scan_privacy_text, ModelSubject, RUNTIME_FORBIDDEN_EVALUATOR_TOKENS,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

/// Versioned contract id for this core slice.
pub const SCHEMA_ID: &str = "contextdesk.investigation_team_qualification.v1";
/// Suite version bound into every fingerprint.
pub const SUITE_VERSION: &str = "contextdesk.investigation_team_qualification.suite.v1";

/// Typed fail-closed reasons.
pub mod failure_reason {
    /// Unknown JSON field (contract drift).
    pub const UNKNOWN_FIELD: &str = "unknown_field";
    /// Duplicate investigation-team role in one pipeline (subject may be shared).
    pub const DUPLICATE_ROLE_IDENTITY: &str = "duplicate_role_identity";
    /// Duplicate attempt identity.
    pub const DUPLICATE_ATTEMPT_IDENTITY: &str = "duplicate_attempt_identity";
    /// Attempt or member identity does not match the pipeline fingerprint.
    pub const CROSSED_FINGERPRINT: &str = "crossed_fingerprint";
    /// Suite version claimed current while stale, or current while marked stale.
    pub const STALE_SUITE_CLAIM: &str = "stale_suite_claim";
    /// Metric or citation field is empty/contradictory.
    pub const INVALID_METRICS: &str = "invalid_metrics";
    /// Completion claimed for a cancelled, timed-out, failed, or partial attempt.
    pub const DISHONEST_COMPLETION: &str = "dishonest_completion";
    /// Report axes do not match the carried attempt scores.
    pub const TAMPERED_AGGREGATES: &str = "tampered_aggregates";
    /// Evaluator truth leaked into provider-facing bytes.
    pub const TRUTH_LEAKAGE: &str = "truth_leakage";
    /// Redacted export would include credentials, endpoints, or private evidence.
    pub const PRIVACY_LEAKAGE: &str = "privacy_leakage";
    /// Schema id/version mismatch.
    pub const SCHEMA_MISMATCH: &str = "schema_mismatch";
}

/// Investigation-team role under qualification (not a name-hint catalog role).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InvestigationTeamRole {
    /// Single-model investigation path.
    Single,
    /// Investigator arm of a split-role pipeline.
    Investigator,
    /// Reviewer arm of a split-role pipeline.
    Reviewer,
    /// Synthesizer arm of a split-role pipeline.
    Synthesizer,
}

impl InvestigationTeamRole {
    /// Stable wire label.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Single => "single",
            Self::Investigator => "investigator",
            Self::Reviewer => "reviewer",
            Self::Synthesizer => "synthesizer",
        }
    }
}

/// Lifecycle of one recorded attempt. Incomplete attempts stay visible.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttemptStatus {
    /// Attempt ran to a terminal model response.
    Completed,
    /// Attempt failed a contract or tool bound.
    Failed,
    /// Attempt produced a partial transcript.
    Partial,
    /// Attempt hit its deadline.
    TimedOut,
    /// Caller cancelled the attempt.
    Cancelled,
}

impl AttemptStatus {
    /// Stable wire label.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Partial => "partial",
            Self::TimedOut => "timed_out",
            Self::Cancelled => "cancelled",
        }
    }

    /// Whether this status may claim completion.
    pub fn may_claim_completion(self) -> bool {
        matches!(self, Self::Completed)
    }
}

/// One exact member of the qualified pipeline.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MemberBinding {
    /// Role this member occupied.
    pub role: InvestigationTeamRole,
    /// Local profile identity (not a secret).
    pub profile_id: String,
    /// Exact catalog model id (aliases are not identity).
    pub model_id: String,
    /// SHA-256 hex of the normalized deployment endpoint.
    pub endpoint_fingerprint: String,
    /// Optional raw deployment URL used only to verify the fingerprint.
    /// Never copied into reports.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deployment_url: Option<String>,
    /// Optional display alias. Never used as identity and never exported.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_alias: Option<String>,
}

impl MemberBinding {
    /// Build a member from a deployment URL, hashing it with the shared helper.
    pub fn from_deployment(
        role: InvestigationTeamRole,
        profile_id: &str,
        model_id: &str,
        deployment_url: &str,
    ) -> CoreResult<Self> {
        let model_ref = ModelRef {
            profile_id: profile_id.to_string(),
            model_id: model_id.to_string(),
        };
        model_ref
            .validate()
            .map_err(|e| CoreError::Config(format!("{}: {e}", failure_reason::INVALID_METRICS)))?;
        Ok(Self {
            role,
            profile_id: profile_id.trim().to_string(),
            model_id: model_id.trim().to_string(),
            endpoint_fingerprint: fingerprint_endpoint(deployment_url),
            deployment_url: Some(deployment_url.to_string()),
            display_alias: None,
        })
    }

    /// Gateway-scoped subject used by quality-eval identity (not weakened).
    pub fn subject(&self) -> ModelSubject {
        ModelSubject {
            gateway_profile_id: self.profile_id.clone(),
            endpoint_fingerprint: self.endpoint_fingerprint.clone(),
            model_id: self.model_id.clone(),
        }
    }
}

/// Model-visible evidence document. Must not carry evaluator labels.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderFacingDocument {
    /// Opaque host-minted evidence id.
    pub id: String,
    /// Model-visible text (no evaluator truth tokens).
    pub text: String,
}

/// Bytes a provider is allowed to see. Evaluator truth is a sibling field on
/// [`QualificationInput`], not a field of this type.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderFacingInput {
    /// Question shown to the model.
    pub question: String,
    /// Evidence packet shown to the model.
    pub evidence_packet: Vec<ProviderFacingDocument>,
}

/// Host-only evaluator truth. Never serialized into provider-facing JSON.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EvaluatorTruth {
    /// Evidence ids that would validate a claim.
    pub required_evidence_ids: BTreeSet<String>,
    /// Required source id for each required evidence id.
    pub required_sources: BTreeMap<String, String>,
    /// Required time anchor for each required evidence id.
    pub required_times: BTreeMap<String, String>,
    /// Tokens that must never appear in provider-facing bytes.
    pub forbidden_provider_tokens: BTreeSet<String>,
}

/// One structured claim on an attempt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AttemptClaim {
    /// Claim prose (not copied into redacted reports).
    pub text: String,
    /// Cited evidence ids.
    pub evidence_ids: Vec<String>,
}

/// One bounded tool invocation recorded on an attempt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToolCallRecord {
    /// Tool name (allowlisted synthetic names only in this slice).
    pub name: String,
    /// Evidence ids the tool returned.
    pub evidence_ids: Vec<String>,
}

/// Exact evidence/source/time citation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CitationRecord {
    /// Evidence id.
    pub evidence_id: String,
    /// Source id.
    pub source_id: String,
    /// Time anchor.
    pub time_anchor: String,
    /// Host citation role from the investigation-answer contract.
    pub role: EvidenceRole,
}

/// One recorded attempt, including incomplete ones.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AttemptRecord {
    /// Stable attempt id.
    pub attempt_id: String,
    /// Role that produced this attempt.
    pub role: InvestigationTeamRole,
    /// Exact model id for this attempt (must match a member).
    pub model_id: String,
    /// Exact profile id for this attempt.
    pub profile_id: String,
    /// Deployment fingerprint for this attempt.
    pub endpoint_fingerprint: String,
    /// Terminal status.
    pub status: AttemptStatus,
    /// Whether the attempt claimed completion.
    pub completion_claimed: bool,
    /// Structured claims.
    pub claims: Vec<AttemptClaim>,
    /// Tool calls.
    pub tool_calls: Vec<ToolCallRecord>,
    /// Citations.
    pub citations: Vec<CitationRecord>,
    /// Observed latency in milliseconds.
    pub latency_ms: u64,
    /// Abstract resource units (tokens/bytes analog; not a cost claim).
    pub resource_units: u64,
}

/// Host-side qualification input. Truth is structurally absent from
/// [`ProviderFacingInput`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct QualificationInput {
    /// Must equal [`SCHEMA_ID`].
    pub schema_id: String,
    /// Suite version the host currently runs.
    pub current_suite_version: String,
    /// Suite version this evidence claims.
    pub suite_version: String,
    /// Unix seconds when the run was observed.
    pub observed_at: i64,
    /// Host-computed stale flag (must be consistent with suite versions).
    pub stale: bool,
    /// Declared policy/budget identity (must match the bound digest).
    pub policy_budget_identity: String,
    /// Maximum tool calls allowed per attempt.
    pub max_tool_calls: u32,
    /// Resource budget in the same units as [`AttemptRecord::resource_units`].
    pub resource_budget: u64,
    /// Pipeline members. Roles must be unique.
    pub members: Vec<MemberBinding>,
    /// Provider-facing packet.
    pub provider_facing: ProviderFacingInput,
    /// Host-only truth.
    pub truth: EvaluatorTruth,
    /// Recorded attempts, including incomplete ones.
    pub attempts: Vec<AttemptRecord>,
}

/// Exact pipeline identity. Qualification never transfers across these fields.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PipelineFingerprint {
    /// Contract id.
    pub schema_id: String,
    /// Suite version bound into this identity.
    pub suite_version: String,
    /// Observation timestamp.
    pub observed_at: i64,
    /// Staleness flag bound into this identity.
    pub stale: bool,
    /// Policy/budget identity.
    pub policy_budget_identity: String,
    /// Sorted member subjects (role + [`ModelSubject::storage_id`]).
    pub members: Vec<FingerprintedMember>,
    /// Canonical digest over the fields above.
    pub digest: String,
}

/// One member as bound into the fingerprint (no aliases, no URLs).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FingerprintedMember {
    /// Role.
    pub role: InvestigationTeamRole,
    /// Reused quality-eval subject identity.
    pub subject_storage_id: String,
    /// Profile id.
    pub profile_id: String,
    /// Exact model id.
    pub model_id: String,
    /// Deployment identity hash.
    pub endpoint_fingerprint: String,
}

/// Per-attempt dimension outcomes used to derive tradeoff axes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AttemptScore {
    /// Attempt id.
    pub attempt_id: String,
    /// Recorded status (preserved).
    pub status: AttemptStatus,
    /// Tool use stayed inside the bound.
    pub bounded_tool_use: bool,
    /// Citations matched host source/time for cited required evidence.
    pub exact_citations: bool,
    /// All required evidence ids were cited.
    pub evidence_coverage: bool,
    /// At least one claim lacked validated evidence.
    pub unsupported_claims: bool,
    /// Status and completion_claimed agree.
    pub failure_honesty: bool,
    /// Fluent claims with no validated evidence.
    pub fluent_without_evidence: bool,
    /// Latency.
    pub latency_ms: u64,
    /// Resource units.
    pub resource_units: u64,
}

/// One tradeoff axis. Never combined into a universal winner.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AxisScore {
    /// Whether this axis met its own contract (not “best”).
    pub contract_met: bool,
    /// Integer metrics for this axis.
    pub metrics: BTreeMap<String, u64>,
    /// Secret-free notes.
    pub notes: Vec<String>,
}

/// Separated capability / quality / speed / resource tradeoffs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TradeoffAxes {
    /// Bounded tools + honest failure/cancel/timeout.
    pub capability: AxisScore,
    /// Citations, coverage, unsupported claims, fluent-without-evidence.
    pub quality: AxisScore,
    /// Honest latency / timeout recording (not a speed ranking).
    pub speed: AxisScore,
    /// Resource units versus budget (not a cost claim).
    pub resource: AxisScore,
}

/// Redacted attempt row in the exportable report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RedactedAttempt {
    /// Attempt id.
    pub attempt_id: String,
    /// Role.
    pub role: InvestigationTeamRole,
    /// Exact model id for this pipeline member.
    pub model_id: String,
    /// Status (incomplete attempts remain).
    pub status: AttemptStatus,
    /// Cited evidence ids only (no excerpts).
    pub citation_evidence_ids: Vec<String>,
    /// Tool call count.
    pub tool_call_count: u32,
    /// Latency.
    pub latency_ms: u64,
    /// Resource units.
    pub resource_units: u64,
}

/// Deterministic qualification report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct QualificationReport {
    /// Contract id.
    pub schema_id: String,
    /// Exact pipeline fingerprint.
    pub fingerprint: PipelineFingerprint,
    /// Per-attempt scores that axes must match.
    pub attempt_scores: Vec<AttemptScore>,
    /// Separated tradeoff axes.
    pub axes: TradeoffAxes,
    /// Redacted attempts.
    pub attempts: Vec<RedactedAttempt>,
    /// Digest over fingerprint + attempt_scores (aggregate tamper check).
    pub scoring_digest: String,
}

fn contract_err(reason: &str, detail: impl Into<String>) -> CoreError {
    CoreError::Config(format!("{reason}: {}", detail.into()))
}

fn policy_err(reason: &str, detail: impl Into<String>) -> CoreError {
    CoreError::Policy(format!("{reason}: {}", detail.into()))
}

/// Digest for max-tool and resource bounds. Callers must pass this as
/// [`QualificationInput::policy_budget_identity`].
pub fn policy_budget_identity(max_tool_calls: u32, resource_budget: u64) -> String {
    let mut buf = Vec::new();
    extend(&mut buf, b"policy_budget_v1");
    extend(&mut buf, max_tool_calls.to_string().as_bytes());
    extend(&mut buf, resource_budget.to_string().as_bytes());
    hex_sha256(&buf)
}

fn extend(buf: &mut Vec<u8>, segment: &[u8]) {
    buf.extend_from_slice(&(segment.len() as u64).to_be_bytes());
    buf.extend_from_slice(segment);
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

fn validate_member(member: &MemberBinding) -> CoreResult<ModelSubject> {
    let model_ref = ModelRef {
        profile_id: member.profile_id.clone(),
        model_id: member.model_id.clone(),
    };
    model_ref
        .validate()
        .map_err(|e| contract_err(failure_reason::INVALID_METRICS, e.to_string()))?;
    if !is_sha256_hex(&member.endpoint_fingerprint) {
        return Err(contract_err(
            failure_reason::INVALID_METRICS,
            "endpoint_fingerprint must be SHA-256 hex",
        ));
    }
    if let Some(url) = &member.deployment_url {
        if fingerprint_endpoint(url) != member.endpoint_fingerprint {
            return Err(contract_err(
                failure_reason::CROSSED_FINGERPRINT,
                "deployment URL does not match endpoint fingerprint",
            ));
        }
    }
    Ok(member.subject())
}

fn packet_ids(input: &QualificationInput) -> BTreeSet<String> {
    input
        .provider_facing
        .evidence_packet
        .iter()
        .map(|doc| doc.id.clone())
        .collect()
}

fn validate_input(input: &QualificationInput) -> CoreResult<()> {
    if input.schema_id != SCHEMA_ID {
        return Err(contract_err(
            failure_reason::SCHEMA_MISMATCH,
            format!("schema_id {} != {SCHEMA_ID}", input.schema_id),
        ));
    }
    if input.current_suite_version != SUITE_VERSION {
        return Err(contract_err(
            failure_reason::SCHEMA_MISMATCH,
            format!(
                "current_suite_version {} != {SUITE_VERSION}",
                input.current_suite_version
            ),
        ));
    }
    if input.suite_version != input.current_suite_version && !input.stale {
        return Err(contract_err(
            failure_reason::STALE_SUITE_CLAIM,
            "non-current suite_version must set stale=true",
        ));
    }
    if input.suite_version == input.current_suite_version && input.stale {
        return Err(contract_err(
            failure_reason::STALE_SUITE_CLAIM,
            "current suite_version cannot be marked stale",
        ));
    }
    let expected_policy = policy_budget_identity(input.max_tool_calls, input.resource_budget);
    if input.policy_budget_identity != expected_policy {
        return Err(contract_err(
            failure_reason::CROSSED_FINGERPRINT,
            "policy_budget_identity does not match declared bounds",
        ));
    }
    if input.members.is_empty() {
        return Err(contract_err(
            failure_reason::INVALID_METRICS,
            "at least one pipeline member is required",
        ));
    }
    let mut roles = BTreeSet::new();
    for member in &input.members {
        validate_member(member)?;
        if !roles.insert(member.role) {
            return Err(contract_err(
                failure_reason::DUPLICATE_ROLE_IDENTITY,
                member.role.as_str(),
            ));
        }
    }
    let mut attempt_ids = BTreeSet::new();
    let packet = packet_ids(input);
    for attempt in &input.attempts {
        if !attempt_ids.insert(attempt.attempt_id.as_str()) {
            return Err(contract_err(
                failure_reason::DUPLICATE_ATTEMPT_IDENTITY,
                attempt.attempt_id.clone(),
            ));
        }
        validate_attempt(input, attempt, &packet)?;
    }
    scan_provider_facing(input)?;
    Ok(())
}

fn member_matches(input: &QualificationInput, attempt: &AttemptRecord) -> bool {
    input.members.iter().any(|member| {
        member.role == attempt.role
            && member.profile_id == attempt.profile_id
            && member.model_id == attempt.model_id
            && member.endpoint_fingerprint == attempt.endpoint_fingerprint
    })
}

fn validate_attempt(
    input: &QualificationInput,
    attempt: &AttemptRecord,
    packet: &BTreeSet<String>,
) -> CoreResult<()> {
    if attempt.attempt_id.trim().is_empty() {
        return Err(contract_err(
            failure_reason::INVALID_METRICS,
            "attempt_id must not be empty",
        ));
    }
    if !member_matches(input, attempt) {
        return Err(contract_err(
            failure_reason::CROSSED_FINGERPRINT,
            format!(
                "attempt {} does not match a pipeline member",
                attempt.attempt_id
            ),
        ));
    }
    if attempt.completion_claimed && !attempt.status.may_claim_completion() {
        return Err(contract_err(
            failure_reason::DISHONEST_COMPLETION,
            format!(
                "attempt {} claimed completion with status {}",
                attempt.attempt_id,
                attempt.status.as_str()
            ),
        ));
    }
    if attempt.status == AttemptStatus::Completed && !attempt.completion_claimed {
        return Err(contract_err(
            failure_reason::DISHONEST_COMPLETION,
            format!(
                "attempt {} completed without completion_claimed",
                attempt.attempt_id
            ),
        ));
    }
    for tool in &attempt.tool_calls {
        if tool.name.trim().is_empty() {
            return Err(contract_err(
                failure_reason::INVALID_METRICS,
                "tool name must not be empty",
            ));
        }
    }
    for citation in &attempt.citations {
        if citation.evidence_id.trim().is_empty()
            || citation.source_id.trim().is_empty()
            || citation.time_anchor.trim().is_empty()
        {
            return Err(contract_err(
                failure_reason::INVALID_METRICS,
                "citation evidence/source/time must not be empty",
            ));
        }
        if !packet.contains(&citation.evidence_id) {
            return Err(contract_err(
                failure_reason::INVALID_METRICS,
                format!(
                    "citation {} is not in the evidence packet",
                    citation.evidence_id
                ),
            ));
        }
    }
    for claim in &attempt.claims {
        if claim.text.trim().is_empty() {
            return Err(contract_err(
                failure_reason::INVALID_METRICS,
                "claim text must not be empty",
            ));
        }
    }
    Ok(())
}

fn provider_facing_blob(input: &QualificationInput) -> CoreResult<String> {
    let mut packet = input.provider_facing.clone();
    packet
        .evidence_packet
        .sort_by(|left, right| left.id.cmp(&right.id));
    serde_json::to_string(&packet)
        .map_err(|e| contract_err(failure_reason::INVALID_METRICS, e.to_string()))
}

fn scan_provider_facing(input: &QualificationInput) -> CoreResult<()> {
    let blob = provider_facing_blob(input)?;
    let lower = blob.to_ascii_lowercase();
    for token in RUNTIME_FORBIDDEN_EVALUATOR_TOKENS {
        if lower.contains(&token.to_ascii_lowercase()) {
            return Err(policy_err(
                failure_reason::TRUTH_LEAKAGE,
                format!("provider-facing contains evaluator token `{token}`"),
            ));
        }
    }
    for token in &input.truth.forbidden_provider_tokens {
        if !token.is_empty() && lower.contains(&token.to_ascii_lowercase()) {
            return Err(policy_err(
                failure_reason::TRUTH_LEAKAGE,
                format!("provider-facing contains host-forbidden token `{token}`"),
            ));
        }
    }
    Ok(())
}

fn sorted_members(input: &QualificationInput) -> Vec<&MemberBinding> {
    let mut members: Vec<&MemberBinding> = input.members.iter().collect();
    members.sort_by(|left, right| {
        left.role
            .cmp(&right.role)
            .then(left.profile_id.cmp(&right.profile_id))
            .then(left.model_id.cmp(&right.model_id))
            .then(left.endpoint_fingerprint.cmp(&right.endpoint_fingerprint))
    });
    members
}

fn fingerprint_from_input(input: &QualificationInput) -> CoreResult<PipelineFingerprint> {
    validate_input(input)?;
    let members: Vec<FingerprintedMember> = sorted_members(input)
        .into_iter()
        .map(|member| FingerprintedMember {
            role: member.role,
            subject_storage_id: member.subject().storage_id(),
            profile_id: member.profile_id.clone(),
            model_id: member.model_id.clone(),
            endpoint_fingerprint: member.endpoint_fingerprint.clone(),
        })
        .collect();
    let mut buf = Vec::new();
    extend(&mut buf, SCHEMA_ID.as_bytes());
    extend(&mut buf, input.suite_version.as_bytes());
    extend(&mut buf, input.observed_at.to_string().as_bytes());
    extend(&mut buf, if input.stale { b"true" } else { b"false" });
    extend(&mut buf, input.policy_budget_identity.as_bytes());
    for member in &members {
        extend(&mut buf, member.role.as_str().as_bytes());
        extend(&mut buf, member.subject_storage_id.as_bytes());
        extend(&mut buf, member.profile_id.as_bytes());
        extend(&mut buf, member.model_id.as_bytes());
        extend(&mut buf, member.endpoint_fingerprint.as_bytes());
    }
    Ok(PipelineFingerprint {
        schema_id: SCHEMA_ID.to_string(),
        suite_version: input.suite_version.clone(),
        observed_at: input.observed_at,
        stale: input.stale,
        policy_budget_identity: input.policy_budget_identity.clone(),
        members,
        digest: hex_sha256(&buf),
    })
}

fn citation_is_exact(truth: &EvaluatorTruth, citation: &CitationRecord) -> bool {
    if let Some(source) = truth.required_sources.get(&citation.evidence_id) {
        if source != &citation.source_id {
            return false;
        }
    }
    if let Some(time) = truth.required_times.get(&citation.evidence_id) {
        if time != &citation.time_anchor {
            return false;
        }
    }
    true
}

fn score_attempt(input: &QualificationInput, attempt: &AttemptRecord) -> AttemptScore {
    let bounded_tool_use =
        u32::try_from(attempt.tool_calls.len()).unwrap_or(u32::MAX) <= input.max_tool_calls;
    let exact_citations = attempt
        .citations
        .iter()
        .all(|citation| citation_is_exact(&input.truth, citation));
    let cited: BTreeSet<&str> = attempt
        .citations
        .iter()
        .map(|citation| citation.evidence_id.as_str())
        .collect();
    let evidence_coverage = input
        .truth
        .required_evidence_ids
        .iter()
        .all(|id| cited.contains(id.as_str()));
    let mut unsupported_claims = false;
    for claim in &attempt.claims {
        let supported = claim.evidence_ids.iter().any(|id| {
            input.truth.required_evidence_ids.contains(id) && cited.contains(id.as_str())
        });
        if !supported {
            unsupported_claims = true;
        }
    }
    let fluent_without_evidence = !attempt.claims.is_empty() && unsupported_claims;
    let failure_honesty = attempt.completion_claimed == attempt.status.may_claim_completion();
    AttemptScore {
        attempt_id: attempt.attempt_id.clone(),
        status: attempt.status,
        bounded_tool_use,
        exact_citations,
        evidence_coverage,
        unsupported_claims,
        failure_honesty,
        fluent_without_evidence,
        latency_ms: attempt.latency_ms,
        resource_units: attempt.resource_units,
    }
}

fn derive_axes(input: &QualificationInput, scores: &[AttemptScore]) -> TradeoffAxes {
    let capability_ok = scores
        .iter()
        .all(|score| score.bounded_tool_use && score.failure_honesty);
    let quality_ok = scores.iter().all(|score| {
        if score.status == AttemptStatus::Completed {
            score.exact_citations
                && score.evidence_coverage
                && !score.unsupported_claims
                && !score.fluent_without_evidence
        } else {
            !score.fluent_without_evidence && score.exact_citations
        }
    });
    // A recorded timeout or cancellation is honest lifecycle evidence, but it
    // is not positive speed evidence. Keep that distinction explicit instead
    // of allowing the presence of an honestly-labelled timeout to satisfy the
    // speed contract.
    let speed_ok = scores.iter().all(|score| {
        !matches!(
            score.status,
            AttemptStatus::TimedOut | AttemptStatus::Cancelled
        )
    }) && !scores.is_empty();
    let resource_ok = scores
        .iter()
        .all(|score| score.resource_units <= input.resource_budget);
    let max_latency = scores.iter().map(|s| s.latency_ms).max().unwrap_or(0);
    let tool_calls = scores
        .iter()
        .filter(|score| !score.bounded_tool_use)
        .count() as u64;
    let mut capability_metrics = BTreeMap::new();
    capability_metrics.insert("attempts".into(), scores.len() as u64);
    capability_metrics.insert(
        "honest_incomplete".into(),
        scores
            .iter()
            .filter(|s| s.status != AttemptStatus::Completed && s.failure_honesty)
            .count() as u64,
    );
    capability_metrics.insert("unbounded_tool_attempts".into(), tool_calls);
    let mut quality_metrics = BTreeMap::new();
    quality_metrics.insert(
        "fluent_without_evidence".into(),
        scores.iter().filter(|s| s.fluent_without_evidence).count() as u64,
    );
    quality_metrics.insert(
        "unsupported_claim_attempts".into(),
        scores.iter().filter(|s| s.unsupported_claims).count() as u64,
    );
    quality_metrics.insert(
        "covered_completed".into(),
        scores
            .iter()
            .filter(|s| s.status == AttemptStatus::Completed && s.evidence_coverage)
            .count() as u64,
    );
    let mut speed_metrics = BTreeMap::new();
    speed_metrics.insert("max_latency_ms".into(), max_latency);
    speed_metrics.insert(
        "timed_out_attempts".into(),
        scores
            .iter()
            .filter(|s| s.status == AttemptStatus::TimedOut)
            .count() as u64,
    );
    speed_metrics.insert(
        "cancelled_attempts".into(),
        scores
            .iter()
            .filter(|s| s.status == AttemptStatus::Cancelled)
            .count() as u64,
    );
    let mut resource_metrics = BTreeMap::new();
    resource_metrics.insert("budget".into(), input.resource_budget);
    resource_metrics.insert(
        "max_units".into(),
        scores.iter().map(|s| s.resource_units).max().unwrap_or(0),
    );
    TradeoffAxes {
        capability: AxisScore {
            contract_met: capability_ok && !scores.is_empty(),
            metrics: capability_metrics,
            notes: vec!["capability is not a quality or speed ranking".into()],
        },
        quality: AxisScore {
            contract_met: quality_ok && !scores.is_empty(),
            metrics: quality_metrics,
            notes: vec!["fluent answers without validated evidence fail quality".into()],
        },
        speed: AxisScore {
            contract_met: speed_ok,
            metrics: speed_metrics,
            notes: vec![
                "speed records latency/timeout honesty, not a fastest-model winner".into(),
                "timed-out or cancelled attempts do not satisfy the speed contract".into(),
            ],
        },
        resource: AxisScore {
            contract_met: resource_ok && !scores.is_empty(),
            metrics: resource_metrics,
            notes: vec!["resource use is a budget contract, not a cheapest-model winner".into()],
        },
    }
}

fn scoring_digest(
    fingerprint: &PipelineFingerprint,
    scores: &[AttemptScore],
) -> CoreResult<String> {
    let mut buf = Vec::new();
    extend(&mut buf, fingerprint.digest.as_bytes());
    let encoded = serde_json::to_string(scores)
        .map_err(|e| contract_err(failure_reason::INVALID_METRICS, e.to_string()))?;
    extend(&mut buf, encoded.as_bytes());
    Ok(hex_sha256(&buf))
}

fn redacted_attempts(input: &QualificationInput) -> Vec<RedactedAttempt> {
    let mut rows: Vec<RedactedAttempt> = input
        .attempts
        .iter()
        .map(|attempt| {
            let mut ids: Vec<String> = attempt
                .citations
                .iter()
                .map(|citation| citation.evidence_id.clone())
                .collect();
            ids.sort();
            ids.dedup();
            RedactedAttempt {
                attempt_id: attempt.attempt_id.clone(),
                role: attempt.role,
                model_id: attempt.model_id.clone(),
                status: attempt.status,
                citation_evidence_ids: ids,
                tool_call_count: u32::try_from(attempt.tool_calls.len()).unwrap_or(u32::MAX),
                latency_ms: attempt.latency_ms,
                resource_units: attempt.resource_units,
            }
        })
        .collect();
    rows.sort_by(|a, b| {
        a.attempt_id
            .cmp(&b.attempt_id)
            .then(a.role.cmp(&b.role))
            .then(a.model_id.cmp(&b.model_id))
    });
    rows
}

fn scan_export(text: &str) -> CoreResult<()> {
    let findings = scan_privacy_text(text);
    if !findings.is_empty() {
        return Err(policy_err(
            failure_reason::PRIVACY_LEAKAGE,
            findings.join("; "),
        ));
    }
    let lower = text.to_ascii_lowercase();
    for token in ["://", "/opt/", "evaluator_truth", "answer_key"] {
        if lower.contains(token) {
            return Err(policy_err(
                failure_reason::PRIVACY_LEAKAGE,
                format!("export contains `{token}`"),
            ));
        }
    }
    Ok(())
}

fn sorted_attempt_scores(mut scores: Vec<AttemptScore>) -> Vec<AttemptScore> {
    scores.sort_by(|a, b| a.attempt_id.cmp(&b.attempt_id));
    scores
}

/// Compute the exact pipeline fingerprint (canonicalize member order).
pub fn pipeline_fingerprint(input: &QualificationInput) -> CoreResult<PipelineFingerprint> {
    fingerprint_from_input(input)
}

/// Serialize only the provider-facing packet (truth is not a field).
pub fn provider_facing_json(input: &QualificationInput) -> CoreResult<String> {
    scan_provider_facing(input)?;
    provider_facing_blob(input)
}

/// Score a qualification input. Incomplete attempts remain visible.
pub fn qualify(input: QualificationInput) -> CoreResult<QualificationReport> {
    let fingerprint = fingerprint_from_input(&input)?;
    let scores = sorted_attempt_scores(
        input
            .attempts
            .iter()
            .map(|attempt| score_attempt(&input, attempt))
            .collect(),
    );
    let axes = derive_axes(&input, &scores);
    let report = QualificationReport {
        schema_id: SCHEMA_ID.to_string(),
        scoring_digest: scoring_digest(&fingerprint, &scores)?,
        fingerprint,
        attempt_scores: scores,
        axes,
        attempts: redacted_attempts(&input),
    };
    validate_report(&report)?;
    scan_export(&render_json_ungated(&report)?)?;
    scan_export(&render_markdown_ungated(&report))?;
    Ok(report)
}

fn render_json_ungated(report: &QualificationReport) -> CoreResult<String> {
    serde_json::to_string(report)
        .map_err(|e| contract_err(failure_reason::INVALID_METRICS, e.to_string()))
}

fn render_markdown_ungated(report: &QualificationReport) -> String {
    let mut out = String::new();
    out.push_str("# Investigation Team qualification report\n\n");
    out.push_str("This report does not declare a universal best model.\n\n");
    out.push_str(&format!("- schema: `{}`\n", report.schema_id));
    out.push_str(&format!(
        "- suite_version: `{}`\n",
        report.fingerprint.suite_version
    ));
    out.push_str(&format!("- fingerprint: `{}`\n", report.fingerprint.digest));
    out.push_str(&format!("- stale: `{}`\n", report.fingerprint.stale));
    out.push_str(&format!(
        "- observed_at: `{}`\n\n",
        report.fingerprint.observed_at
    ));
    out.push_str("## Members\n\n");
    for member in &report.fingerprint.members {
        out.push_str(&format!(
            "- role `{}` model `{}` profile `{}` deployment `{}`\n",
            member.role.as_str(),
            member.model_id,
            member.profile_id,
            member.endpoint_fingerprint
        ));
    }
    out.push_str("\n## Tradeoff axes\n\n");
    for (name, axis) in [
        ("capability", &report.axes.capability),
        ("quality", &report.axes.quality),
        ("speed", &report.axes.speed),
        ("resource", &report.axes.resource),
    ] {
        out.push_str(&format!(
            "- `{name}` contract_met=`{}`\n",
            axis.contract_met
        ));
        for (key, value) in &axis.metrics {
            out.push_str(&format!("  - {key}: `{value}`\n"));
        }
        for note in &axis.notes {
            out.push_str(&format!("  - note: {note}\n"));
        }
    }
    out.push_str("\n## Attempts\n\n");
    for attempt in &report.attempts {
        out.push_str(&format!(
            "- `{}` role=`{}` model=`{}` status=`{}` tools=`{}` latency_ms=`{}` resource=`{}` citations=`{}`\n",
            attempt.attempt_id,
            attempt.role.as_str(),
            attempt.model_id,
            attempt.status.as_str(),
            attempt.tool_call_count,
            attempt.latency_ms,
            attempt.resource_units,
            attempt.citation_evidence_ids.join(","),
        ));
    }
    out
}

/// Deterministic redacted JSON export.
pub fn render_json(report: &QualificationReport) -> CoreResult<String> {
    validate_report(report)?;
    let text = render_json_ungated(report)?;
    scan_export(&text)?;
    Ok(text)
}

/// Deterministic redacted Markdown export.
pub fn render_markdown(report: &QualificationReport) -> CoreResult<String> {
    validate_report(report)?;
    let text = render_markdown_ungated(report);
    scan_export(&text)?;
    Ok(text)
}

fn fingerprint_digest_matches(fingerprint: &PipelineFingerprint) -> bool {
    let mut buf = Vec::new();
    extend(&mut buf, fingerprint.schema_id.as_bytes());
    extend(&mut buf, fingerprint.suite_version.as_bytes());
    extend(&mut buf, fingerprint.observed_at.to_string().as_bytes());
    extend(&mut buf, if fingerprint.stale { b"true" } else { b"false" });
    extend(&mut buf, fingerprint.policy_budget_identity.as_bytes());
    for member in &fingerprint.members {
        extend(&mut buf, member.role.as_str().as_bytes());
        extend(&mut buf, member.subject_storage_id.as_bytes());
        extend(&mut buf, member.profile_id.as_bytes());
        extend(&mut buf, member.model_id.as_bytes());
        extend(&mut buf, member.endpoint_fingerprint.as_bytes());
    }
    fingerprint.digest == hex_sha256(&buf)
}

fn axes_from_scores(scores: &[AttemptScore], resource_budget: u64) -> TradeoffAxes {
    // Resource budget is not in the report; re-derive contract flags that do
    // not need it, and require resource.metrics["budget"] to match axes.
    let capability_ok = scores
        .iter()
        .all(|score| score.bounded_tool_use && score.failure_honesty)
        && !scores.is_empty();
    let quality_ok = scores.iter().all(|score| {
        if score.status == AttemptStatus::Completed {
            score.exact_citations
                && score.evidence_coverage
                && !score.unsupported_claims
                && !score.fluent_without_evidence
        } else {
            !score.fluent_without_evidence && score.exact_citations
        }
    }) && !scores.is_empty();
    let speed_ok = scores.iter().all(|score| {
        !matches!(
            score.status,
            AttemptStatus::TimedOut | AttemptStatus::Cancelled
        )
    }) && !scores.is_empty();
    let resource_ok = scores
        .iter()
        .all(|score| score.resource_units <= resource_budget)
        && !scores.is_empty();
    TradeoffAxes {
        capability: AxisScore {
            contract_met: capability_ok,
            metrics: BTreeMap::new(),
            notes: Vec::new(),
        },
        quality: AxisScore {
            contract_met: quality_ok,
            metrics: BTreeMap::new(),
            notes: Vec::new(),
        },
        speed: AxisScore {
            contract_met: speed_ok,
            metrics: BTreeMap::new(),
            notes: Vec::new(),
        },
        resource: AxisScore {
            contract_met: resource_ok,
            metrics: BTreeMap::new(),
            notes: Vec::new(),
        },
    }
}

fn validate_report(report: &QualificationReport) -> CoreResult<()> {
    if report.schema_id != SCHEMA_ID || report.fingerprint.schema_id != SCHEMA_ID {
        return Err(contract_err(
            failure_reason::SCHEMA_MISMATCH,
            "report schema_id mismatch",
        ));
    }
    if !fingerprint_digest_matches(&report.fingerprint) {
        return Err(contract_err(
            failure_reason::CROSSED_FINGERPRINT,
            "fingerprint digest does not match bound identity fields",
        ));
    }
    let expected_digest = scoring_digest(&report.fingerprint, &report.attempt_scores)?;
    if report.scoring_digest != expected_digest {
        return Err(contract_err(
            failure_reason::TAMPERED_AGGREGATES,
            "scoring_digest does not match attempt scores",
        ));
    }
    let budget = report
        .axes
        .resource
        .metrics
        .get("budget")
        .copied()
        .unwrap_or(0);
    let derived = axes_from_scores(&report.attempt_scores, budget);
    if report.axes.capability.contract_met != derived.capability.contract_met
        || report.axes.quality.contract_met != derived.quality.contract_met
        || report.axes.speed.contract_met != derived.speed.contract_met
        || report.axes.resource.contract_met != derived.resource.contract_met
    {
        return Err(contract_err(
            failure_reason::TAMPERED_AGGREGATES,
            "tradeoff axes do not match attempt scores",
        ));
    }
    if report.attempts.len() != report.attempt_scores.len() {
        return Err(contract_err(
            failure_reason::TAMPERED_AGGREGATES,
            "attempt rows and scores diverged",
        ));
    }
    Ok(())
}

/// Parse and re-validate a report (unknown fields fail closed).
pub fn parse_report(json: &str) -> CoreResult<QualificationReport> {
    let report: QualificationReport = serde_json::from_str(json).map_err(|e| {
        if e.to_string().contains("unknown field") {
            contract_err(failure_reason::UNKNOWN_FIELD, e.to_string())
        } else {
            contract_err(failure_reason::INVALID_METRICS, e.to_string())
        }
    })?;
    validate_report(&report)?;
    scan_export(json)?;
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn policy_identity_is_order_independent_of_call_site() {
        let a = policy_budget_identity(8, 100);
        let b = policy_budget_identity(8, 100);
        assert_eq!(a, b);
        assert_ne!(a, policy_budget_identity(8, 101));
    }
}
