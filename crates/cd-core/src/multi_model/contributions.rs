//! Provider-neutral contribution contracts and deterministic reconciliation.
//!
//! This module is the small seam between a future multi-contributor router and
//! the existing host-owned answer validator.  A contributor may suggest an
//! observation, symptom, causal candidate, or competing explanation, but it
//! cannot establish an initiating cause.  Evidence and candidate ids always
//! come from the host packet; model text is never used to decide agreement.
//!
//! The reconciliation result is useful even when no model is available.  Its
//! deterministic baseline is a projection of the packet's timeline, candidate
//! groups, host relationships, and citations.  Consequently a provider outage
//! degrades answer quality gracefully instead of producing an empty answer or
//! silently switching providers.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::fast_triage::{FastTriageEvidenceCategory, FastTriageEvidenceScope, FastTriagePacketV1};
use crate::investigation_answer::{
    validate_model_answer, AnswerEnvelopeV1, EvidenceRole, ValidationError, SCHEMA_V1,
};

/// Stable schema id for model contribution proposals.
pub const CONTRIBUTION_SCHEMA_V1: &str = "contextdesk.multi_model.contribution.v1";

/// Functional role of one bounded contributor.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContributionRole {
    /// Extracts host-grounded observations.
    ObservationExtractor,
    /// Analyzes host-provided chronology without changing host ordinals or
    /// assigning causal authority.
    TimelineAnalyst,
    /// Proposes symptoms, causal candidates, and competing explanations.
    CausalProposer,
    /// Checks disagreement, contradictions, and whether to abstain.
    ContradictionChecker,
    /// Reports evidence that would be useful but is absent from the packet.
    EvidenceGap,
    /// Optional final reviewer. Still cannot establish a root cause.
    Reviewer,
}

impl ContributionRole {
    /// Stable wire label.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ObservationExtractor => "observation_extractor",
            Self::TimelineAnalyst => "timeline_analyst",
            Self::CausalProposer => "causal_proposer",
            Self::ContradictionChecker => "contradiction_checker",
            Self::EvidenceGap => "evidence_gap",
            Self::Reviewer => "reviewer",
        }
    }
}

/// Claim kind a contributor may propose.  `InitiatingCause` is intentionally
/// absent: only host provenance can establish that role.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContributionClaimKind {
    /// A directly observed fact.
    Observation,
    /// A downstream effect or symptom.
    Symptom,
    /// A supported hypothesis, not an established cause.
    CausalCandidate,
    /// An alternative explanation kept separate from the main chain.
    CompetingExplanation,
}

impl ContributionClaimKind {
    /// Stable wire label.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Observation => "observation",
            Self::Symptom => "symptom",
            Self::CausalCandidate => "causal_candidate",
            Self::CompetingExplanation => "competing_explanation",
        }
    }
}

/// Why one contributor did or did not produce a usable proposal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContributionAvailability {
    /// Proposal parsed and passed host validation.
    Completed,
    /// No backend was configured for this role.
    Unavailable,
    /// The configured slot was intentionally not admitted to this phase.
    NotAdmitted,
    /// The bounded call exceeded its deadline.
    TimedOut,
    /// The turn was cancelled before completion.
    Cancelled,
    /// The provider returned a malformed or contract-invalid proposal.
    Malformed,
    /// The provider/transport failed after its bounded attempts.
    Failed,
}

impl ContributionAvailability {
    /// Stable wire label.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::Unavailable => "unavailable",
            Self::NotAdmitted => "not_admitted",
            Self::TimedOut => "timed_out",
            Self::Cancelled => "cancelled",
            Self::Malformed => "malformed",
            Self::Failed => "failed",
        }
    }
}

/// Host-authored reason a contribution was not admitted or did not complete.
///
/// `ContributionAvailability` remains the coarse compatibility/status label;
/// this enum carries the actionable cause for stage progress and share-safe
/// telemetry. It never contains provider text, credentials, or model output.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContributionDegradationReason {
    /// The slot lacked current qualified evidence, so no provider call was sent.
    QualificationUnavailable,
    /// The host/provider-round ceiling was exhausted before this slot.
    ProviderRoundBudgetExhausted,
    /// This slot's model-facing context exceeded its per-call host budget.
    ContextBudgetExhausted,
    /// The route's cumulative model-facing context budget was exhausted.
    TotalContextBudgetExhausted,
    /// The turn was cancelled before this slot completed.
    Cancelled,
    /// The turn deadline elapsed before this slot completed.
    Deadline,
    /// The authorized provider/transport failed after bounded attempts.
    ProviderFailed,
    /// The provider response failed host validation.
    MalformedProposal,
    /// The deterministic first phase did not recommend reviewer escalation.
    ReviewerNotRequired,
    /// The optional reviewer phase was disabled by the route's phase allowance.
    ReviewerPhaseDisabled,
}

impl ContributionDegradationReason {
    /// Stable wire label for diagnostics and telemetry.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::QualificationUnavailable => "qualification_unavailable",
            Self::ProviderRoundBudgetExhausted => "provider_round_budget_exhausted",
            Self::ContextBudgetExhausted => "context_budget_exhausted",
            Self::TotalContextBudgetExhausted => "total_context_budget_exhausted",
            Self::Cancelled => "cancelled",
            Self::Deadline => "deadline",
            Self::ProviderFailed => "provider_failed",
            Self::MalformedProposal => "malformed_proposal",
            Self::ReviewerNotRequired => "reviewer_not_required",
            Self::ReviewerPhaseDisabled => "reviewer_phase_disabled",
        }
    }

    /// One host-authored, content-free explanation for an operator-facing
    /// stage event. Dynamic provider/model text never enters this boundary.
    pub fn detail(self) -> &'static str {
        match self {
            Self::QualificationUnavailable => {
                "contributor lacked current qualified evidence; no provider call was sent"
            }
            Self::ProviderRoundBudgetExhausted => {
                "host provider-round budget was exhausted before this contributor was admitted"
            }
            Self::ContextBudgetExhausted => {
                "host per-call context budget was exhausted before this contributor was admitted"
            }
            Self::TotalContextBudgetExhausted => {
                "host total contribution context budget was exhausted before this contributor was admitted"
            }
            Self::Cancelled => "turn was cancelled before this contributor completed",
            Self::Deadline => "turn deadline elapsed before this contributor completed",
            Self::ProviderFailed => {
                "authorized contributor provider failed; deterministic host floor retained"
            }
            Self::MalformedProposal => {
                "contributor proposal failed host validation; deterministic host floor retained"
            }
            Self::ReviewerNotRequired => {
                "deterministic reconciliation did not recommend reviewer escalation"
            }
            Self::ReviewerPhaseDisabled => {
                "optional reviewer phase is disabled by the host routing policy"
            }
        }
    }
}

/// Hard upper bounds for one future contribution turn. These are host policy,
/// not model suggestions, and prevent an opt-in multi-model route from turning
/// into an unbounded panel or retry loop.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContributionRoutingPolicy {
    /// Maximum contributor calls, including an optional reviewer.
    pub max_contributors: usize,
    /// Maximum calls allowed to run concurrently.
    pub max_parallel: usize,
    /// Maximum phase allowance: `1` admits the initial contributor phase;
    /// `2` also permits the conditional reviewer phase. This is not a
    /// provider-call cap; `MultiModelBudget::max_total_provider_rounds` owns
    /// that ceiling.
    pub max_rounds: u8,
    /// Maximum host packet/context characters assigned to the route.
    pub max_context_chars: usize,
    /// Whether a reviewer slot may be planned.
    pub reviewer_enabled: bool,
}

impl Default for ContributionRoutingPolicy {
    fn default() -> Self {
        Self {
            max_contributors: 4,
            max_parallel: 3,
            max_rounds: 2,
            max_context_chars: 120_000,
            reviewer_enabled: true,
        }
    }
}

/// Host-authored routing plan. It names roles only; provider/model resolution
/// remains in the workflow layer and is never inferred from a model name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContributionRoutingPlan {
    /// Ordered role slots. Duplicate roles are allowed for independent models.
    pub roles: Vec<ContributionRole>,
    /// Bounds used to validate this plan.
    pub policy: ContributionRoutingPolicy,
}

/// Why a proposed contribution plan was rejected before any provider call.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContributionRoutingError {
    /// At least one role slot is required.
    EmptyPlan,
    /// The plan exceeds the contributor cap.
    TooManyContributors,
    /// The requested parallelism exceeds the contributor cap.
    TooMuchParallelism,
    /// At least one bounded round is required.
    NoRounds,
    /// A non-empty context budget is required.
    NoContextBudget,
    /// Reviewer was requested while policy forbids it.
    ReviewerDisabled,
    /// More than one reviewer slot was requested.
    MultipleReviewers,
    /// The single reviewer slot must be the final plan slot.
    ReviewerNotFinal,
}

impl ContributionRoutingError {
    /// Stable wire label.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::EmptyPlan => "empty_plan",
            Self::TooManyContributors => "too_many_contributors",
            Self::TooMuchParallelism => "too_much_parallelism",
            Self::NoRounds => "no_rounds",
            Self::NoContextBudget => "no_context_budget",
            Self::ReviewerDisabled => "reviewer_disabled",
            Self::MultipleReviewers => "multiple_reviewers",
            Self::ReviewerNotFinal => "reviewer_not_final",
        }
    }
}

impl ContributionRoutingPlan {
    /// Validate a host-authored bounded role plan without contacting a model.
    pub fn new(
        roles: Vec<ContributionRole>,
        policy: ContributionRoutingPolicy,
    ) -> Result<Self, ContributionRoutingError> {
        if roles.is_empty() {
            return Err(ContributionRoutingError::EmptyPlan);
        }
        if roles.len() > policy.max_contributors {
            return Err(ContributionRoutingError::TooManyContributors);
        }
        if policy.max_parallel == 0 || policy.max_parallel > policy.max_contributors {
            return Err(ContributionRoutingError::TooMuchParallelism);
        }
        if policy.max_rounds == 0 {
            return Err(ContributionRoutingError::NoRounds);
        }
        if policy.max_context_chars == 0 {
            return Err(ContributionRoutingError::NoContextBudget);
        }
        let reviewer_count = roles
            .iter()
            .filter(|role| **role == ContributionRole::Reviewer)
            .count();
        if reviewer_count > 1 {
            return Err(ContributionRoutingError::MultipleReviewers);
        }
        if reviewer_count == 1 && roles.last() != Some(&ContributionRole::Reviewer) {
            return Err(ContributionRoutingError::ReviewerNotFinal);
        }
        if reviewer_count == 1 && !policy.reviewer_enabled {
            return Err(ContributionRoutingError::ReviewerDisabled);
        }
        Ok(Self { roles, policy })
    }
}

/// A model-authored claim proposal.  The host validates every id and role
/// before turning this into a [`ValidatedContributionV1`].
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelContributionClaimV1 {
    /// Inert model label used only for diagnostics; it never grants authority.
    pub claim_id: String,
    /// Candidate id minted by the host packet.
    pub candidate_id: String,
    /// Proposed non-root claim kind.
    pub kind: ContributionClaimKind,
    /// Human-readable model text. Reconciliation deliberately ignores it.
    pub text: String,
    /// Host-minted evidence ids cited by the proposal.
    #[serde(default)]
    pub evidence_ids: Vec<String>,
}

/// A model-authored evidence-gap proposal.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelEvidenceGapV1 {
    /// Inert model label.
    pub gap_id: String,
    /// Candidate the gap concerns, when known.
    pub candidate_id: Option<String>,
    /// Human-readable explanation, never used for authority.
    pub text: String,
}

/// A model-authored contradiction between two distinct host candidates.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelContributionContradictionV1 {
    /// Inert model label.
    pub contradiction_id: String,
    /// First host candidate.
    pub candidate_a: String,
    /// Second host candidate; must differ from `candidate_a`.
    pub candidate_b: String,
    /// Host evidence ids relevant to the conflict.
    #[serde(default)]
    pub evidence_ids: Vec<String>,
    /// Human-readable explanation, never used for authority.
    pub text: String,
}

/// A strict, provider-neutral model proposal.  The packet id is echoed by the
/// model and must match the exact host packet used for the call.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelContributionProposalV1 {
    /// Must equal [`CONTRIBUTION_SCHEMA_V1`].
    pub schema: String,
    /// Exact host packet identity.
    pub packet_id: String,
    /// The host-assigned role for this call.
    pub role: ContributionRole,
    /// True when the contributor explicitly declines to make a claim.
    #[serde(default)]
    pub abstained: bool,
    /// Non-root claims.
    #[serde(default)]
    pub claims: Vec<ModelContributionClaimV1>,
    /// Optional evidence gaps.
    #[serde(default)]
    pub evidence_gaps: Vec<ModelEvidenceGapV1>,
    /// Optional contradictions between host candidates.
    #[serde(default)]
    pub contradictions: Vec<ModelContributionContradictionV1>,
}

/// Host identity for a contributor.  It is not accepted from model output.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct ContributionIdentity {
    /// Config profile identity.
    pub profile_id: String,
    /// Exact catalog model id.
    pub model: String,
}

/// One host-validated claim.  All ids and role permissions have already been
/// checked against the immutable packet.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ValidatedContributionClaimV1 {
    /// Inert model label.
    pub claim_id: String,
    /// Host-minted candidate id.
    pub candidate_id: String,
    /// Non-root claim kind.
    pub kind: ContributionClaimKind,
    /// Model text retained for an owner-local detail view.
    pub text: String,
    /// Host-minted evidence ids.
    pub evidence_ids: Vec<String>,
}

/// Host-validated contribution, bound to one exact packet and contributor.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ValidatedContributionV1 {
    /// Exact packet identity.
    pub packet_id: String,
    /// Functional role.
    pub role: ContributionRole,
    /// Host identity of the model call.
    pub identity: ContributionIdentity,
    /// Whether the contributor abstained.
    pub abstained: bool,
    /// Validated claims.
    pub claims: Vec<ValidatedContributionClaimV1>,
    /// Model-authored gap labels/text, retained but not trusted as evidence.
    pub evidence_gaps: Vec<ModelEvidenceGapV1>,
    /// Host-scoped contradiction reports.
    pub contradictions: Vec<ValidatedContributionContradictionV1>,
}

/// Host-validated contradiction report. It does not merge candidates or
/// establish which side is true.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ValidatedContributionContradictionV1 {
    /// Inert model label.
    pub contradiction_id: String,
    /// First host candidate.
    pub candidate_a: String,
    /// Second host candidate.
    pub candidate_b: String,
    /// Sorted host evidence ids.
    pub evidence_ids: Vec<String>,
    /// Model explanation retained for an owner-local detail view.
    pub text: String,
}

/// A contribution attempt, including explicit dropout state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContributionAttemptV1 {
    /// Functional role that was attempted.
    pub role: ContributionRole,
    /// Host identity of the attempted contributor.
    pub identity: ContributionIdentity,
    /// Explicit completion/dropout state.
    pub availability: ContributionAvailability,
    /// Present only when the proposal passed host validation.
    pub contribution: Option<ValidatedContributionV1>,
}

impl ContributionAttemptV1 {
    /// Construct a completed attempt after validation.
    pub fn completed(contribution: ValidatedContributionV1) -> Self {
        Self {
            role: contribution.role,
            identity: contribution.identity.clone(),
            availability: ContributionAvailability::Completed,
            contribution: Some(contribution),
        }
    }

    /// Construct an explicit non-completed attempt.
    pub fn unavailable(
        role: ContributionRole,
        identity: ContributionIdentity,
        availability: ContributionAvailability,
    ) -> Self {
        debug_assert_ne!(availability, ContributionAvailability::Completed);
        Self {
            role,
            identity,
            availability,
            contribution: None,
        }
    }
}

/// A host-authored reason a proposal was rejected.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContributionValidationError {
    /// JSON was not the strict contribution schema.
    Malformed,
    /// Schema id did not match.
    Schema,
    /// Proposal referred to another packet or stale revision.
    StalePacket,
    /// Model attempted a role it was not assigned.
    WrongRole,
    /// Candidate id was not minted in the packet.
    ForeignCandidate,
    /// Evidence id was not minted in the packet.
    ForeignEvidence,
    /// Evidence crossed candidate scope or independent timeline scope.
    WrongScope,
    /// Evidence was used for an unauthorized causal role.
    RoleMismatch,
    /// A model-authored label was unsafe or duplicated.
    InvalidLabel,
}

impl ContributionValidationError {
    /// Stable wire label.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Malformed => "malformed",
            Self::Schema => "schema",
            Self::StalePacket => "stale_packet",
            Self::WrongRole => "wrong_role",
            Self::ForeignCandidate => "foreign_candidate",
            Self::ForeignEvidence => "foreign_evidence",
            Self::WrongScope => "wrong_scope",
            Self::RoleMismatch => "role_mismatch",
            Self::InvalidLabel => "invalid_label",
        }
    }
}

fn safe_label(value: &str) -> bool {
    !value.is_empty()
        && !value
            .chars()
            .any(|c| c.is_control() || c == '\u{2028}' || c == '\u{2029}')
}

fn role_allows(role: ContributionRole, kind: ContributionClaimKind) -> bool {
    match role {
        ContributionRole::ObservationExtractor | ContributionRole::TimelineAnalyst => {
            kind == ContributionClaimKind::Observation
        }
        ContributionRole::CausalProposer => matches!(
            kind,
            ContributionClaimKind::Symptom
                | ContributionClaimKind::CausalCandidate
                | ContributionClaimKind::CompetingExplanation
        ),
        ContributionRole::ContradictionChecker | ContributionRole::EvidenceGap => false,
        ContributionRole::Reviewer => true,
    }
}

fn role_allows_gaps(role: ContributionRole) -> bool {
    matches!(
        role,
        ContributionRole::EvidenceGap | ContributionRole::Reviewer
    )
}

fn role_allows_contradictions(role: ContributionRole) -> bool {
    matches!(
        role,
        ContributionRole::ContradictionChecker | ContributionRole::Reviewer
    )
}

/// Parse and validate one proposal against the exact host packet.
pub fn validate_contribution(
    raw: &str,
    packet: &FastTriagePacketV1,
    identity: ContributionIdentity,
    expected_role: ContributionRole,
) -> Result<ValidatedContributionV1, ContributionValidationError> {
    let proposal: ModelContributionProposalV1 =
        serde_json::from_str(raw).map_err(|_| ContributionValidationError::Malformed)?;
    if proposal.schema != CONTRIBUTION_SCHEMA_V1 {
        return Err(ContributionValidationError::Schema);
    }
    if proposal.packet_id != packet.packet_id() {
        return Err(ContributionValidationError::StalePacket);
    }
    if proposal.role != expected_role {
        return Err(ContributionValidationError::WrongRole);
    }
    if identity.profile_id.trim().is_empty() || identity.model.trim().is_empty() {
        return Err(ContributionValidationError::InvalidLabel);
    }
    let mut labels = BTreeSet::new();
    let candidate_ids = packet.candidate_ids();
    let mut claims = Vec::with_capacity(proposal.claims.len());
    for claim in proposal.claims {
        if !safe_label(&claim.claim_id) || !labels.insert(claim.claim_id.clone()) {
            return Err(ContributionValidationError::InvalidLabel);
        }
        if !role_allows(expected_role, claim.kind) {
            return Err(ContributionValidationError::RoleMismatch);
        }
        if !candidate_ids.contains(&claim.candidate_id) {
            return Err(ContributionValidationError::ForeignCandidate);
        }
        if claim.evidence_ids.is_empty() {
            return Err(ContributionValidationError::ForeignEvidence);
        }
        let mut evidence_ids = BTreeSet::new();
        for evidence_id in claim.evidence_ids {
            if !evidence_ids.insert(evidence_id.clone()) {
                return Err(ContributionValidationError::InvalidLabel);
            }
            let Some(row) = packet.row(&evidence_id) else {
                return Err(ContributionValidationError::ForeignEvidence);
            };
            if row.scope != FastTriageEvidenceScope::Candidate
                || row.candidate_id != claim.candidate_id
            {
                return Err(ContributionValidationError::WrongScope);
            }
            if row.role == EvidenceRole::Symptom
                && matches!(
                    claim.kind,
                    ContributionClaimKind::CausalCandidate
                        | ContributionClaimKind::CompetingExplanation
                )
            {
                return Err(ContributionValidationError::RoleMismatch);
            }
        }
        let mut evidence_ids = evidence_ids.into_iter().collect::<Vec<_>>();
        evidence_ids.sort();
        claims.push(ValidatedContributionClaimV1 {
            claim_id: claim.claim_id,
            candidate_id: claim.candidate_id,
            kind: claim.kind,
            text: claim.text,
            evidence_ids,
        });
    }
    let mut evidence_gaps = Vec::with_capacity(proposal.evidence_gaps.len());
    if !proposal.evidence_gaps.is_empty() && !role_allows_gaps(expected_role) {
        return Err(ContributionValidationError::WrongRole);
    }
    for gap in proposal.evidence_gaps {
        if !safe_label(&gap.gap_id) || !labels.insert(gap.gap_id.clone()) {
            return Err(ContributionValidationError::InvalidLabel);
        }
        if let Some(candidate_id) = &gap.candidate_id {
            if !candidate_ids.contains(candidate_id) {
                return Err(ContributionValidationError::ForeignCandidate);
            }
        }
        evidence_gaps.push(gap);
    }
    let mut contradictions = Vec::with_capacity(proposal.contradictions.len());
    if !proposal.contradictions.is_empty() && !role_allows_contradictions(expected_role) {
        return Err(ContributionValidationError::WrongRole);
    }
    for contradiction in proposal.contradictions {
        if !safe_label(&contradiction.contradiction_id)
            || !labels.insert(contradiction.contradiction_id.clone())
        {
            return Err(ContributionValidationError::InvalidLabel);
        }
        if contradiction.candidate_a == contradiction.candidate_b
            || !candidate_ids.contains(&contradiction.candidate_a)
            || !candidate_ids.contains(&contradiction.candidate_b)
        {
            return Err(ContributionValidationError::ForeignCandidate);
        }
        if contradiction.evidence_ids.is_empty() {
            return Err(ContributionValidationError::ForeignEvidence);
        }
        let mut evidence_ids = BTreeSet::new();
        for evidence_id in contradiction.evidence_ids {
            if !evidence_ids.insert(evidence_id.clone()) {
                return Err(ContributionValidationError::InvalidLabel);
            }
            let Some(row) = packet.row(&evidence_id) else {
                return Err(ContributionValidationError::ForeignEvidence);
            };
            if row.scope != FastTriageEvidenceScope::Candidate
                || (row.candidate_id != contradiction.candidate_a
                    && row.candidate_id != contradiction.candidate_b)
            {
                return Err(ContributionValidationError::WrongScope);
            }
        }
        contradictions.push(ValidatedContributionContradictionV1 {
            contradiction_id: contradiction.contradiction_id,
            candidate_a: contradiction.candidate_a,
            candidate_b: contradiction.candidate_b,
            evidence_ids: evidence_ids.into_iter().collect(),
            text: contradiction.text,
        });
    }
    claims.sort_by(|a, b| {
        (&a.candidate_id, a.kind, &a.evidence_ids, &a.claim_id).cmp(&(
            &b.candidate_id,
            b.kind,
            &b.evidence_ids,
            &b.claim_id,
        ))
    });
    Ok(ValidatedContributionV1 {
        packet_id: packet.packet_id().to_string(),
        role: expected_role,
        identity,
        abstained: proposal.abstained,
        claims,
        evidence_gaps,
        contradictions,
    })
}

/// High-level deterministic reconciliation state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReconciliationState {
    /// No usable model contribution; the host baseline is the answer floor.
    DeterministicBaseline,
    /// Contributions agree on one or more bounded proposals.
    Supported,
    /// Contributors disagree on the same host evidence.
    Contested,
    /// Some contributors completed, but required role coverage is incomplete.
    InsufficientEvidence,
    /// All usable contributors explicitly abstained.
    Abstained,
    /// A bounded escalation/reviewer is appropriate.
    EscalationRecommended,
    /// Every attempted contributor was unavailable or failed.
    Unavailable,
}

impl ReconciliationState {
    /// Stable wire label.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::DeterministicBaseline => "deterministic_baseline",
            Self::Supported => "supported",
            Self::Contested => "contested",
            Self::InsufficientEvidence => "insufficient_evidence",
            Self::Abstained => "abstained",
            Self::EscalationRecommended => "escalation_recommended",
            Self::Unavailable => "unavailable",
        }
    }
}

/// Host timeline row in the deterministic minimum-useful answer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BaselineTimelineRow {
    /// Host evidence id.
    pub evidence_id: String,
    /// Host candidate id.
    pub candidate_id: String,
    /// Host scope.
    pub scope: FastTriageEvidenceScope,
    /// Host chronology ordinal, when available.
    pub chronology_ordinal: Option<u64>,
    /// Host positional/link category.
    pub context_category: FastTriageEvidenceCategory,
}

/// Candidate-group projection in the deterministic baseline.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BaselineCandidateGroup {
    /// Host candidate id.
    pub candidate_id: String,
    /// Evidence ids in this group.
    pub evidence_ids: Vec<String>,
    /// Host-labelled cause ids, if any.
    pub cause_evidence_ids: Vec<String>,
    /// Host-labelled symptom ids, if any.
    pub symptom_evidence_ids: Vec<String>,
}

/// A host relationship that is structural, not a model causal assertion.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BaselineRelationship {
    /// Evidence id.
    pub evidence_id: String,
    /// Candidate id.
    pub candidate_id: String,
    /// Host-proven positional/link category.
    pub category: FastTriageEvidenceCategory,
}

/// Deterministic answer floor, available without any model.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeterministicBaselineV1 {
    /// Bounded host timeline.
    pub timeline: Vec<BaselineTimelineRow>,
    /// Host candidate groups.
    pub candidate_groups: Vec<BaselineCandidateGroup>,
    /// Structural host relationships.
    pub relationships: Vec<BaselineRelationship>,
    /// Canonical host citations, by evidence id.
    pub citations: Vec<String>,
    /// Host-labelled downstream symptom ids.
    pub symptom_evidence_ids: Vec<String>,
    /// Always false: a model or adjacency never establishes a root here.
    pub root_cause_established: bool,
}

/// A normalized claim key used for deterministic agreement.  Model text and
/// model-authored claim ids are intentionally absent, giving permutation and
/// vocabulary invariance.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct ReconciledClaim {
    /// Candidate id.
    pub candidate_id: String,
    /// Non-root kind.
    pub kind: ContributionClaimKind,
    /// Sorted host evidence ids.
    pub evidence_ids: Vec<String>,
    /// Number of distinct functional roles supporting the key.
    #[serde(default)]
    pub role_count: usize,
    /// Number of distinct exact gateway-scoped model identities supporting
    /// the key. Reusing one exact model in several roles counts once.
    pub contributor_count: usize,
    /// Number of distinct catalog model ids, independent of gateway profile.
    #[serde(default)]
    pub model_id_count: usize,
    /// Number of distinct gateway profiles.
    #[serde(default)]
    pub gateway_count: usize,
}

/// Deterministic kind of support between independently sourced claims.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReconciliationSupportKind {
    /// Independent model identities cited the exact same evidence set.
    ExactAgreement,
    /// Independent model identities cited overlapping, non-identical evidence
    /// sets for the same candidate and claim kind.
    CompatibleSupport,
}

/// Host-normalized support relation. Model prose and model-authored claim ids
/// are intentionally absent.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct ReconciliationSupportV1 {
    /// Candidate id shared by the supported claims.
    pub candidate_id: String,
    /// Shared non-root claim kind.
    pub kind: ContributionClaimKind,
    /// Exact agreement or compatible partial support.
    pub support_kind: ReconciliationSupportKind,
    /// Sorted union of host evidence ids participating in the relation.
    pub evidence_ids: Vec<String>,
    /// Distinct functional roles participating in the relation.
    pub role_count: usize,
    /// Distinct exact gateway-scoped model identities. This is always at
    /// least two; one model reused across roles never creates a relation.
    pub model_ref_count: usize,
    /// Distinct catalog model ids, independent of gateway profile.
    pub model_id_count: usize,
    /// Distinct gateway profiles.
    pub gateway_count: usize,
}

/// Typed deterministic coverage or unresolved-question class.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReconciliationGapKind {
    /// No accepted observation claim exists.
    MissingObservationCoverage,
    /// No accepted symptom/causal/competing claim exists.
    MissingCausalCoverage,
    /// A completed contributor reported absent evidence for an unresolved
    /// question. Model prose is not retained in this normalized class.
    UnresolvedQuestion,
}

/// One typed reconciliation gap without model prose.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct ReconciliationGapV1 {
    /// Gap class.
    pub kind: ReconciliationGapKind,
    /// Host candidate id when the report was candidate-specific.
    pub candidate_id: Option<String>,
    /// Number of distinct exact gateway-scoped models reporting this gap.
    /// Deterministic host coverage gaps use zero.
    pub reporter_model_count: usize,
}

/// One deterministic disagreement between bounded contributors.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct ReconciliationConflict {
    /// Candidate id.
    pub candidate_id: String,
    /// Host evidence ids shared by the competing claims.
    pub evidence_ids: Vec<String>,
    /// Competing kinds.
    pub kinds: Vec<ContributionClaimKind>,
}

/// Reconciled result, including explicit availability and deterministic floor.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReconciliationReportV1 {
    /// Exact packet identity.
    pub packet_id: String,
    /// Deterministic state.
    pub state: ReconciliationState,
    /// Whether a bounded reviewer/escalation is recommended.
    pub escalation_recommended: bool,
    /// Explicitly recorded model outcomes.
    pub availability: Vec<(ContributionRole, ContributionAvailability)>,
    /// Normalized supported claims.
    pub claims: Vec<ReconciledClaim>,
    /// Exact agreement and compatible support between independent models.
    #[serde(default)]
    pub support: Vec<ReconciliationSupportV1>,
    /// Normalized conflicts.
    pub conflicts: Vec<ReconciliationConflict>,
    /// Typed missing coverage and unresolved questions.
    #[serde(default)]
    pub gaps: Vec<ReconciliationGapV1>,
    /// Host-scoped contradiction reports from checker/reviewer roles.
    pub reported_contradictions: Vec<ValidatedContributionContradictionV1>,
    /// Host answer floor.
    pub baseline: DeterministicBaselineV1,
    /// Always false; included so consumers cannot mistake proposal support for
    /// host root-cause authority.
    pub root_cause_established: bool,
}

/// Build the deterministic answer floor from the immutable packet.
pub fn deterministic_baseline(packet: &FastTriagePacketV1) -> DeterministicBaselineV1 {
    let timeline = packet
        .rows()
        .iter()
        .map(|row| BaselineTimelineRow {
            evidence_id: row.evidence_id.clone(),
            candidate_id: row.candidate_id.clone(),
            scope: row.scope,
            chronology_ordinal: row.chronology_ordinal,
            context_category: row.context_category,
        })
        .collect::<Vec<_>>();
    let mut groups = BTreeMap::<String, BaselineCandidateGroup>::new();
    for row in packet.rows() {
        let group =
            groups
                .entry(row.candidate_id.clone())
                .or_insert_with(|| BaselineCandidateGroup {
                    candidate_id: row.candidate_id.clone(),
                    evidence_ids: Vec::new(),
                    cause_evidence_ids: Vec::new(),
                    symptom_evidence_ids: Vec::new(),
                });
        group.evidence_ids.push(row.evidence_id.clone());
        match row.role {
            EvidenceRole::Cause => group.cause_evidence_ids.push(row.evidence_id.clone()),
            EvidenceRole::Symptom => group.symptom_evidence_ids.push(row.evidence_id.clone()),
            EvidenceRole::Supporting | EvidenceRole::Neutral => {}
        }
    }
    let relationships = packet
        .rows()
        .iter()
        .map(|row| BaselineRelationship {
            evidence_id: row.evidence_id.clone(),
            candidate_id: row.candidate_id.clone(),
            category: row.context_category,
        })
        .collect::<Vec<_>>();
    let citations = packet
        .rows()
        .iter()
        .map(|row| row.evidence_id.clone())
        .collect::<Vec<_>>();
    let symptom_evidence_ids = packet
        .rows()
        .iter()
        .filter(|row| row.role == EvidenceRole::Symptom)
        .map(|row| row.evidence_id.clone())
        .collect::<Vec<_>>();
    DeterministicBaselineV1 {
        timeline,
        candidate_groups: groups.into_values().collect(),
        relationships,
        citations,
        symptom_evidence_ids,
        root_cause_established: false,
    }
}

/// Reconcile completed and unavailable contributors deterministically.
pub fn reconcile_contributions(
    packet: &FastTriagePacketV1,
    attempts: &[ContributionAttemptV1],
) -> ReconciliationReportV1 {
    let baseline = deterministic_baseline(packet);
    let mut availability = attempts
        .iter()
        .map(|attempt| (attempt.role, attempt.availability))
        .collect::<Vec<_>>();
    availability.sort();

    let mut claim_supporters = BTreeMap::<
        (String, ContributionClaimKind, Vec<String>),
        BTreeSet<(ContributionRole, String, String)>,
    >::new();
    let mut unresolved_gap_reporters =
        BTreeMap::<Option<String>, BTreeSet<(String, String)>>::new();
    let mut completed = 0usize;
    let mut non_abstained = 0usize;
    let mut has_observation_claim = false;
    let mut has_causal_claim = false;
    let mut reported_contradictions = Vec::new();
    for attempt in attempts {
        let Some(contribution) = attempt.contribution.as_ref() else {
            continue;
        };
        if attempt.availability != ContributionAvailability::Completed {
            continue;
        }
        completed += 1;
        if !contribution.abstained {
            non_abstained += 1;
        }
        for claim in &contribution.claims {
            has_observation_claim |= claim.kind == ContributionClaimKind::Observation;
            has_causal_claim |= matches!(
                claim.kind,
                ContributionClaimKind::Symptom
                    | ContributionClaimKind::CausalCandidate
                    | ContributionClaimKind::CompetingExplanation
            );
            let key = (
                claim.candidate_id.clone(),
                claim.kind,
                claim.evidence_ids.clone(),
            );
            claim_supporters.entry(key).or_default().insert((
                contribution.role,
                contribution.identity.profile_id.clone(),
                contribution.identity.model.clone(),
            ));
        }
        for gap in &contribution.evidence_gaps {
            unresolved_gap_reporters
                .entry(gap.candidate_id.clone())
                .or_default()
                .insert((
                    contribution.identity.profile_id.clone(),
                    contribution.identity.model.clone(),
                ));
        }
        reported_contradictions.extend(contribution.contradictions.iter().cloned());
    }
    let contributor_counts = |contributors: &BTreeSet<(ContributionRole, String, String)>| {
        let roles = contributors
            .iter()
            .map(|(role, _, _)| *role)
            .collect::<BTreeSet<_>>();
        let model_refs = contributors
            .iter()
            .map(|(_, profile_id, model_id)| (profile_id.clone(), model_id.clone()))
            .collect::<BTreeSet<_>>();
        let model_ids = contributors
            .iter()
            .map(|(_, _, model_id)| model_id.clone())
            .collect::<BTreeSet<_>>();
        let gateways = contributors
            .iter()
            .map(|(_, profile_id, _)| profile_id.clone())
            .collect::<BTreeSet<_>>();
        (
            roles.len(),
            model_refs.len(),
            model_ids.len(),
            gateways.len(),
        )
    };
    let claims = claim_supporters
        .iter()
        .map(|((candidate_id, kind, evidence_ids), contributors)| {
            let (role_count, model_ref_count, model_id_count, gateway_count) =
                contributor_counts(contributors);
            ReconciledClaim {
                candidate_id: candidate_id.clone(),
                kind: *kind,
                evidence_ids: evidence_ids.clone(),
                role_count,
                contributor_count: model_ref_count,
                model_id_count,
                gateway_count,
            }
        })
        .collect::<Vec<_>>();

    let mut support_relations = BTreeSet::new();
    for ((candidate_id, kind, evidence_ids), contributors) in &claim_supporters {
        let (role_count, model_ref_count, model_id_count, gateway_count) =
            contributor_counts(contributors);
        if model_ref_count >= 2 {
            support_relations.insert(ReconciliationSupportV1 {
                candidate_id: candidate_id.clone(),
                kind: *kind,
                support_kind: ReconciliationSupportKind::ExactAgreement,
                evidence_ids: evidence_ids.clone(),
                role_count,
                model_ref_count,
                model_id_count,
                gateway_count,
            });
        }
    }
    let claim_entries = claim_supporters.iter().collect::<Vec<_>>();
    for left_index in 0..claim_entries.len() {
        let ((left_candidate, left_kind, left_evidence), left_contributors) =
            claim_entries[left_index];
        for ((right_candidate, right_kind, right_evidence), right_contributors) in
            claim_entries.iter().skip(left_index + 1).copied()
        {
            if left_candidate != right_candidate
                || left_kind != right_kind
                || left_evidence == right_evidence
                || !left_evidence
                    .iter()
                    .any(|evidence_id| right_evidence.binary_search(evidence_id).is_ok())
            {
                continue;
            }
            let mut contributors = left_contributors.clone();
            contributors.extend(right_contributors.iter().cloned());
            let (role_count, model_ref_count, model_id_count, gateway_count) =
                contributor_counts(&contributors);
            if model_ref_count < 2 {
                continue;
            }
            let evidence_ids = left_evidence
                .iter()
                .chain(right_evidence.iter())
                .cloned()
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect();
            support_relations.insert(ReconciliationSupportV1 {
                candidate_id: left_candidate.clone(),
                kind: *left_kind,
                support_kind: ReconciliationSupportKind::CompatibleSupport,
                evidence_ids,
                role_count,
                model_ref_count,
                model_id_count,
                gateway_count,
            });
        }
    }
    let support = support_relations.into_iter().collect::<Vec<_>>();

    let mut gaps = BTreeSet::new();
    if !has_observation_claim {
        gaps.insert(ReconciliationGapV1 {
            kind: ReconciliationGapKind::MissingObservationCoverage,
            candidate_id: None,
            reporter_model_count: 0,
        });
    }
    if !has_causal_claim {
        gaps.insert(ReconciliationGapV1 {
            kind: ReconciliationGapKind::MissingCausalCoverage,
            candidate_id: None,
            reporter_model_count: 0,
        });
    }
    for (candidate_id, reporters) in unresolved_gap_reporters {
        gaps.insert(ReconciliationGapV1 {
            kind: ReconciliationGapKind::UnresolvedQuestion,
            candidate_id,
            reporter_model_count: reporters.len(),
        });
    }
    let gaps = gaps.into_iter().collect::<Vec<_>>();

    let mut by_candidate_evidence =
        BTreeMap::<(String, Vec<String>), BTreeSet<ContributionClaimKind>>::new();
    for claim in &claims {
        by_candidate_evidence
            .entry((claim.candidate_id.clone(), claim.evidence_ids.clone()))
            .or_default()
            .insert(claim.kind);
    }
    let conflicts = by_candidate_evidence
        .into_iter()
        .filter_map(|((candidate_id, evidence_ids), kinds)| {
            // Descriptive observations may share a row with a hypothesis. Only
            // mutually competing causal readings are a conflict.
            let causal_kinds = kinds
                .iter()
                .copied()
                .filter(|kind| *kind != ContributionClaimKind::Observation)
                .collect::<BTreeSet<_>>();
            (causal_kinds.len() > 1).then(|| ReconciliationConflict {
                candidate_id,
                evidence_ids,
                kinds: causal_kinds.into_iter().collect(),
            })
        })
        .collect::<Vec<_>>();

    let has_dropout = attempts.iter().any(|attempt| {
        !matches!(
            attempt.availability,
            ContributionAvailability::Completed | ContributionAvailability::NotAdmitted
        )
    });
    reported_contradictions.sort_by(|a, b| {
        (
            &a.candidate_a,
            &a.candidate_b,
            &a.evidence_ids,
            &a.contradiction_id,
        )
            .cmp(&(
                &b.candidate_a,
                &b.candidate_b,
                &b.evidence_ids,
                &b.contradiction_id,
            ))
    });
    let has_conflict = !conflicts.is_empty() || !reported_contradictions.is_empty();
    let missing_role_coverage = !has_observation_claim || !has_causal_claim;
    let escalation_recommended =
        has_conflict || has_dropout || missing_role_coverage || !gaps.is_empty();
    let state = if attempts.is_empty() {
        ReconciliationState::DeterministicBaseline
    } else if completed == 0 {
        ReconciliationState::Unavailable
    } else if non_abstained == 0 {
        ReconciliationState::Abstained
    } else if has_conflict {
        ReconciliationState::Contested
    } else if missing_role_coverage {
        ReconciliationState::InsufficientEvidence
    } else if has_dropout || !gaps.is_empty() {
        ReconciliationState::EscalationRecommended
    } else {
        ReconciliationState::Supported
    };
    ReconciliationReportV1 {
        packet_id: packet.packet_id().to_string(),
        state,
        escalation_recommended,
        availability,
        claims,
        support,
        conflicts,
        gaps,
        reported_contradictions,
        baseline,
        root_cause_established: false,
    }
}

/// Replay comparison of the host floor, one contributor, and a bounded set of
/// contributors. It contains only normalized counts/states, so it is safe to
/// persist as a hermetic quality-evaluation artifact.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReconciliationReplayV1 {
    /// Exact packet identity.
    pub packet_id: String,
    /// State with no model attempts.
    pub deterministic_only: ReconciliationState,
    /// State after the optional single-contributor attempt.
    pub single_contributor: ReconciliationState,
    /// State after the bounded multi-contributor attempts.
    pub bounded_multi_model: ReconciliationState,
    /// Normalized claim count for the single attempt.
    pub single_claim_count: usize,
    /// Normalized claim count for the bounded attempts.
    pub bounded_claim_count: usize,
    /// Number of bounded conflicts.
    pub bounded_conflict_count: usize,
}

/// Replay the same immutable packet through three host-only evaluation modes.
pub fn replay_reconciliation(
    packet: &FastTriagePacketV1,
    single: Option<&ContributionAttemptV1>,
    bounded: &[ContributionAttemptV1],
) -> ReconciliationReplayV1 {
    let deterministic = reconcile_contributions(packet, &[]);
    let single_report = single
        .map(|attempt| reconcile_contributions(packet, std::slice::from_ref(attempt)))
        .unwrap_or_else(|| reconcile_contributions(packet, &[]));
    let bounded_report = reconcile_contributions(packet, bounded);
    ReconciliationReplayV1 {
        packet_id: packet.packet_id().to_string(),
        deterministic_only: deterministic.state,
        single_contributor: single_report.state,
        bounded_multi_model: bounded_report.state,
        single_claim_count: single_report.claims.len(),
        bounded_claim_count: bounded_report.claims.len(),
        bounded_conflict_count: bounded_report.conflicts.len()
            + bounded_report.reported_contradictions.len(),
    }
}

/// Build a host-validated investigation answer from normalized contributions.
///
/// This is the deterministic answer floor for a contribution route: it uses
/// only claims that passed packet validation, includes every host candidate,
/// and never emits an initiating-cause claim. The ordinary single/reviewer
/// synthesizer may still produce a richer answer later, but this function is a
/// complete, safe answer when no synthesizer is available.
pub fn reconciliation_answer(
    packet: &FastTriagePacketV1,
    attempts: &[ContributionAttemptV1],
) -> Result<AnswerEnvelopeV1, ValidationError> {
    let mut claims_by_key = BTreeMap::<(String, ContributionClaimKind, Vec<String>), String>::new();
    for attempt in attempts {
        if attempt.availability != ContributionAvailability::Completed {
            continue;
        }
        let Some(contribution) = attempt.contribution.as_ref() else {
            continue;
        };
        for claim in &contribution.claims {
            let key = (
                claim.candidate_id.clone(),
                claim.kind,
                claim.evidence_ids.clone(),
            );
            // Deterministically choose the lexicographically smallest bounded
            // model text for one normalized claim key. Text never decides
            // agreement, and no provider gets precedence by arrival order.
            claims_by_key
                .entry(key)
                .and_modify(|text| {
                    if claim.text.as_str() < text.as_str() {
                        *text = claim.text.clone();
                    }
                })
                .or_insert_with(|| claim.text.clone());
        }
    }

    let mut by_candidate = BTreeMap::<String, serde_json::Map<String, serde_json::Value>>::new();
    for candidate_id in packet.ledger().candidate_ids() {
        let mut object = serde_json::Map::new();
        object.insert("candidate_id".into(), serde_json::json!(candidate_id));
        by_candidate.insert(candidate_id, object);
    }
    let mut claim_index = 0usize;
    for ((candidate_id, kind, evidence_ids), text) in claims_by_key {
        let section = match kind {
            ContributionClaimKind::Observation => "observations",
            ContributionClaimKind::Symptom => "symptoms",
            ContributionClaimKind::CausalCandidate => "causal_candidates",
            ContributionClaimKind::CompetingExplanation => "competing_explanations",
        };
        let claim = serde_json::json!({
            "claim_id": format!("reconciled-{claim_index}"),
            "text": text,
            "evidence_ids": evidence_ids,
        });
        claim_index = claim_index.saturating_add(1);
        by_candidate
            .get_mut(&candidate_id)
            .ok_or(ValidationError::WrongScope)?
            .entry(section)
            .or_insert_with(|| serde_json::Value::Array(Vec::new()))
            .as_array_mut()
            .ok_or(ValidationError::Schema)?
            .push(claim);
    }
    let proposal = serde_json::json!({
        "schema": SCHEMA_V1,
        "candidates": by_candidate.into_values().map(serde_json::Value::Object).collect::<Vec<_>>(),
    })
    .to_string();
    validate_model_answer(&proposal, packet.ledger())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fast_triage::FastTriagePacketV1;
    use crate::investigation_answer::{
        AnswerBindingV1, HostEvidenceEntry, HostEvidenceLedger, LogSnapshotRevisionV1,
    };
    use serde_json::{json, Value};

    fn packet() -> FastTriagePacketV1 {
        let revision = LogSnapshotRevisionV1 {
            event_revision: 1,
            template_analysis_revision: 2,
            suppression_revision: 3,
        };
        let entries = vec![
            HostEvidenceEntry {
                evidence_id: "opaque-a".into(),
                candidate_id: "candidate-a".into(),
                source_label: "a.log".into(),
                locator: "seq=10".into(),
                corpus_id: "corpus".into(),
                revision,
                role: EvidenceRole::Cause,
                content: "cause".into(),
            },
            HostEvidenceEntry {
                evidence_id: "opaque-b".into(),
                candidate_id: "candidate-b".into(),
                source_label: "b.log".into(),
                locator: "seq=20".into(),
                corpus_id: "corpus".into(),
                revision,
                role: EvidenceRole::Symptom,
                content: "symptom".into(),
            },
            HostEvidenceEntry {
                evidence_id: "opaque-noise".into(),
                candidate_id: "timeline".into(),
                source_label: "noise.log".into(),
                locator: "seq=30".into(),
                corpus_id: "corpus".into(),
                revision,
                role: EvidenceRole::Neutral,
                content: "noise".into(),
            },
        ];
        let binding = AnswerBindingV1 {
            session_id: "session".into(),
            turn_id: "turn".into(),
            corpus_id: "corpus".into(),
            revision,
            ledger_digest: HostEvidenceLedger::digest(&entries),
        };
        FastTriagePacketV1::from_ledger(
            HostEvidenceLedger::new(binding, entries).unwrap(),
            Some("timeline"),
            true,
        )
    }

    fn packet_with_overlapping_candidate_evidence() -> FastTriagePacketV1 {
        let revision = LogSnapshotRevisionV1 {
            event_revision: 1,
            template_analysis_revision: 2,
            suppression_revision: 3,
        };
        let entries = vec![
            HostEvidenceEntry {
                evidence_id: "opaque-a".into(),
                candidate_id: "candidate-a".into(),
                source_label: "a.log".into(),
                locator: "seq=10".into(),
                corpus_id: "corpus".into(),
                revision,
                role: EvidenceRole::Cause,
                content: "cause".into(),
            },
            HostEvidenceEntry {
                evidence_id: "opaque-a-support".into(),
                candidate_id: "candidate-a".into(),
                source_label: "a.log".into(),
                locator: "seq=11".into(),
                corpus_id: "corpus".into(),
                revision,
                role: EvidenceRole::Supporting,
                content: "support".into(),
            },
        ];
        let binding = AnswerBindingV1 {
            session_id: "session".into(),
            turn_id: "turn".into(),
            corpus_id: "corpus".into(),
            revision,
            ledger_digest: HostEvidenceLedger::digest(&entries),
        };
        FastTriagePacketV1::from_ledger(
            HostEvidenceLedger::new(binding, entries).unwrap(),
            None,
            true,
        )
    }

    fn identity(name: &str) -> ContributionIdentity {
        ContributionIdentity {
            profile_id: "profile".into(),
            model: name.into(),
        }
    }

    fn proposal(packet: &FastTriagePacketV1, role: ContributionRole, claims: Value) -> String {
        json!({
            "schema": CONTRIBUTION_SCHEMA_V1,
            "packet_id": packet.packet_id(),
            "role": role,
            "claims": claims,
        })
        .to_string()
    }

    fn extraction(packet: &FastTriagePacketV1, model: &str) -> ContributionAttemptV1 {
        let raw = proposal(
            packet,
            ContributionRole::ObservationExtractor,
            json!([{"claim_id":"obs-a","candidate_id":"candidate-a","kind":"observation","text":"seen","evidence_ids":["opaque-a"]}]),
        );
        ContributionAttemptV1::completed(
            validate_contribution(
                &raw,
                packet,
                identity(model),
                ContributionRole::ObservationExtractor,
            )
            .unwrap(),
        )
    }

    fn causal(packet: &FastTriagePacketV1, model: &str) -> ContributionAttemptV1 {
        let raw = proposal(
            packet,
            ContributionRole::CausalProposer,
            json!([{"claim_id":"cause-a","candidate_id":"candidate-a","kind":"causal_candidate","text":"possible","evidence_ids":["opaque-a"]}]),
        );
        ContributionAttemptV1::completed(
            validate_contribution(
                &raw,
                packet,
                identity(model),
                ContributionRole::CausalProposer,
            )
            .unwrap(),
        )
    }

    #[test]
    fn validates_exact_packet_and_never_allows_root_or_independent_noise() {
        let packet = packet();
        let root = json!({
            "schema": CONTRIBUTION_SCHEMA_V1,
            "packet_id": packet.packet_id(),
            "role": "causal_proposer",
            "claims": [{"claim_id":"x","candidate_id":"candidate-a","kind":"initiating_cause","text":"root","evidence_ids":["opaque-a"]}]
        })
        .to_string();
        assert_eq!(
            validate_contribution(
                &root,
                &packet,
                identity("m"),
                ContributionRole::CausalProposer
            ),
            Err(ContributionValidationError::Malformed)
        );
        let noise = proposal(
            &packet,
            ContributionRole::CausalProposer,
            json!([{"claim_id":"x","candidate_id":"candidate-a","kind":"causal_candidate","text":"noise","evidence_ids":["opaque-noise"]}]),
        );
        assert_eq!(
            validate_contribution(
                &noise,
                &packet,
                identity("m"),
                ContributionRole::CausalProposer
            ),
            Err(ContributionValidationError::WrongScope)
        );
        let stale = json!({
            "schema": CONTRIBUTION_SCHEMA_V1,
            "packet_id": "stale",
            "role": "observation_extractor",
            "claims": []
        })
        .to_string();
        assert_eq!(
            validate_contribution(
                &stale,
                &packet,
                identity("m"),
                ContributionRole::ObservationExtractor
            ),
            Err(ContributionValidationError::StalePacket)
        );
    }

    #[test]
    fn host_labelled_symptom_cannot_be_proposed_as_causal_candidate() {
        let packet = packet();
        let raw = proposal(
            &packet,
            ContributionRole::CausalProposer,
            json!([{
                "claim_id": "symptom-as-cause",
                "candidate_id": "candidate-b",
                "kind": "causal_candidate",
                "text": "downstream symptom promoted to cause",
                "evidence_ids": ["opaque-b"]
            }]),
        );
        assert_eq!(
            validate_contribution(
                &raw,
                &packet,
                identity("m"),
                ContributionRole::CausalProposer
            ),
            Err(ContributionValidationError::RoleMismatch)
        );
    }

    #[test]
    fn timeline_analyst_is_typed_and_cannot_assign_causal_roles() {
        let packet = packet();
        let observation = proposal(
            &packet,
            ContributionRole::TimelineAnalyst,
            json!([{
                "claim_id": "timeline-observation",
                "candidate_id": "candidate-a",
                "kind": "observation",
                "text": "host ordinal preserved",
                "evidence_ids": ["opaque-a"]
            }]),
        );
        let validated = validate_contribution(
            &observation,
            &packet,
            identity("timeline-model"),
            ContributionRole::TimelineAnalyst,
        )
        .expect("timeline observations use the typed contribution contract");
        assert_eq!(validated.role, ContributionRole::TimelineAnalyst);
        assert_eq!(validated.claims.len(), 1);

        let causal = proposal(
            &packet,
            ContributionRole::TimelineAnalyst,
            json!([{
                "claim_id": "timeline-cause",
                "candidate_id": "candidate-a",
                "kind": "causal_candidate",
                "text": "must be rejected",
                "evidence_ids": ["opaque-a"]
            }]),
        );
        assert_eq!(
            validate_contribution(
                &causal,
                &packet,
                identity("timeline-model"),
                ContributionRole::TimelineAnalyst,
            ),
            Err(ContributionValidationError::RoleMismatch)
        );
    }

    #[test]
    fn baseline_is_useful_and_explicitly_not_a_root_cause() {
        let baseline = deterministic_baseline(&packet());
        assert_eq!(baseline.timeline.len(), 3);
        assert_eq!(baseline.candidate_groups.len(), 3);
        assert_eq!(baseline.citations, ["opaque-a", "opaque-b", "opaque-noise"]);
        assert_eq!(baseline.symptom_evidence_ids, ["opaque-b"]);
        assert!(!baseline.root_cause_established);
    }

    #[test]
    fn all_unavailable_yields_explicit_unavailable_with_baseline() {
        let packet = packet();
        let attempts = vec![ContributionAttemptV1::unavailable(
            ContributionRole::CausalProposer,
            identity("slow"),
            ContributionAvailability::TimedOut,
        )];
        let report = reconcile_contributions(&packet, &attempts);
        assert_eq!(report.state, ReconciliationState::Unavailable);
        assert!(report.baseline.timeline.len() == 3);
        assert!(!report.root_cause_established);
    }

    #[test]
    fn agreement_is_independent_of_model_text_and_claim_labels() {
        let packet = packet();
        let first = extraction(&packet, "m1");
        let mut second = extraction(&packet, "m2");
        second.contribution.as_mut().unwrap().claims[0].claim_id = "different-label".into();
        second.contribution.as_mut().unwrap().claims[0].text = "different words".into();
        let report = reconcile_contributions(
            &packet,
            &[first, second, causal(&packet, "m3"), causal(&packet, "m4")],
        );
        assert_eq!(report.state, ReconciliationState::Supported);
        assert_eq!(report.claims[0].contributor_count, 2);
        assert_eq!(report.support.len(), 2);
        assert!(report.support.iter().all(|support| {
            support.support_kind == ReconciliationSupportKind::ExactAgreement
                && support.model_ref_count == 2
        }));
        assert!(!report.root_cause_established);
    }

    #[test]
    fn one_exact_model_reused_across_roles_does_not_inflate_consensus() {
        let packet = packet();
        let extractor = extraction(&packet, "shared-model");
        let reviewer_raw = proposal(
            &packet,
            ContributionRole::Reviewer,
            json!([{"claim_id":"review-obs","candidate_id":"candidate-a","kind":"observation","text":"same claim","evidence_ids":["opaque-a"]}]),
        );
        let reviewer = ContributionAttemptV1::completed(
            validate_contribution(
                &reviewer_raw,
                &packet,
                identity("shared-model"),
                ContributionRole::Reviewer,
            )
            .unwrap(),
        );
        let report = reconcile_contributions(&packet, &[extractor, reviewer]);
        let observation = report
            .claims
            .iter()
            .find(|claim| claim.kind == ContributionClaimKind::Observation)
            .unwrap();
        assert_eq!(observation.role_count, 2);
        assert_eq!(observation.contributor_count, 1);
        assert_eq!(observation.model_id_count, 1);
        assert_eq!(observation.gateway_count, 1);
        assert!(report.support.is_empty());
    }

    #[test]
    fn independent_overlapping_claims_are_compatible_support() {
        let packet = packet_with_overlapping_candidate_evidence();
        let narrow = proposal(
            &packet,
            ContributionRole::CausalProposer,
            json!([{"claim_id":"narrow","candidate_id":"candidate-a","kind":"causal_candidate","text":"narrow","evidence_ids":["opaque-a"]}]),
        );
        let broad = proposal(
            &packet,
            ContributionRole::Reviewer,
            json!([{"claim_id":"broad","candidate_id":"candidate-a","kind":"causal_candidate","text":"broad","evidence_ids":["opaque-a","opaque-a-support"]}]),
        );
        let attempts = [
            ContributionAttemptV1::completed(
                validate_contribution(
                    &narrow,
                    &packet,
                    identity("model-a"),
                    ContributionRole::CausalProposer,
                )
                .unwrap(),
            ),
            ContributionAttemptV1::completed(
                validate_contribution(
                    &broad,
                    &packet,
                    identity("model-b"),
                    ContributionRole::Reviewer,
                )
                .unwrap(),
            ),
        ];
        let report = reconcile_contributions(&packet, &attempts);
        assert_eq!(report.support.len(), 1);
        assert_eq!(
            report.support[0].support_kind,
            ReconciliationSupportKind::CompatibleSupport
        );
        assert_eq!(
            report.support[0].evidence_ids,
            ["opaque-a", "opaque-a-support"]
        );
        assert_eq!(report.support[0].model_ref_count, 2);
    }

    #[test]
    fn unresolved_questions_and_missing_coverage_are_typed() {
        let packet = packet();
        let gap_raw = json!({
            "schema": CONTRIBUTION_SCHEMA_V1,
            "packet_id": packet.packet_id(),
            "role": "evidence_gap",
            "evidence_gaps": [{
                "gap_id": "missing-trace",
                "candidate_id": "candidate-a",
                "text": "a bounded trace would resolve this"
            }]
        })
        .to_string();
        let gap = ContributionAttemptV1::completed(
            validate_contribution(
                &gap_raw,
                &packet,
                identity("gap-model"),
                ContributionRole::EvidenceGap,
            )
            .unwrap(),
        );
        let report = reconcile_contributions(
            &packet,
            &[
                extraction(&packet, "extractor"),
                causal(&packet, "causal"),
                gap,
            ],
        );
        assert_eq!(report.state, ReconciliationState::EscalationRecommended);
        assert!(report.escalation_recommended);
        assert_eq!(
            report.gaps,
            [ReconciliationGapV1 {
                kind: ReconciliationGapKind::UnresolvedQuestion,
                candidate_id: Some("candidate-a".into()),
                reporter_model_count: 1,
            }]
        );

        let baseline = reconcile_contributions(&packet, &[]);
        assert_eq!(
            baseline
                .gaps
                .iter()
                .map(|gap| gap.kind)
                .collect::<BTreeSet<_>>(),
            BTreeSet::from([
                ReconciliationGapKind::MissingObservationCoverage,
                ReconciliationGapKind::MissingCausalCoverage,
            ])
        );
    }

    #[test]
    fn conflicting_kinds_are_contested_and_recommend_bounded_escalation() {
        let packet = packet();
        let causal_candidate = causal(&packet, "m1");
        let competing_raw = proposal(
            &packet,
            ContributionRole::Reviewer,
            json!([{"claim_id":"alt","candidate_id":"candidate-a","kind":"competing_explanation","text":"alternative","evidence_ids":["opaque-a"]}]),
        );
        let competing = ContributionAttemptV1::completed(
            validate_contribution(
                &competing_raw,
                &packet,
                identity("m2"),
                ContributionRole::Reviewer,
            )
            .unwrap(),
        );
        let report = reconcile_contributions(&packet, &[causal_candidate, competing]);
        assert_eq!(report.state, ReconciliationState::Contested);
        assert!(report.escalation_recommended);
        assert_eq!(report.conflicts.len(), 1);
    }

    #[test]
    fn dropout_is_explicit_and_does_not_hide_a_useful_partial_result() {
        let packet = packet();
        let attempts = vec![
            extraction(&packet, "fast"),
            ContributionAttemptV1::unavailable(
                ContributionRole::CausalProposer,
                identity("slow"),
                ContributionAvailability::TimedOut,
            ),
        ];
        let report = reconcile_contributions(&packet, &attempts);
        assert_eq!(report.state, ReconciliationState::InsufficientEvidence);
        assert!(report.escalation_recommended);
        assert_eq!(report.availability.len(), 2);
        assert_eq!(report.claims.len(), 1);
    }

    #[test]
    fn complete_role_coverage_with_dropout_recommends_escalation() {
        let packet = packet();
        let attempts = vec![
            extraction(&packet, "fast"),
            causal(&packet, "careful"),
            ContributionAttemptV1::unavailable(
                ContributionRole::Reviewer,
                identity("reviewer"),
                ContributionAvailability::TimedOut,
            ),
        ];
        let report = reconcile_contributions(&packet, &attempts);
        assert_eq!(report.state, ReconciliationState::EscalationRecommended);
        assert!(report.escalation_recommended);
    }

    #[test]
    fn explicit_abstention_is_not_reported_as_support() {
        let packet = packet();
        let raw = json!({
            "schema": CONTRIBUTION_SCHEMA_V1,
            "packet_id": packet.packet_id(),
            "role": "causal_proposer",
            "abstained": true,
            "claims": []
        })
        .to_string();
        let attempt = ContributionAttemptV1::completed(
            validate_contribution(
                &raw,
                &packet,
                identity("careful"),
                ContributionRole::CausalProposer,
            )
            .unwrap(),
        );
        let report = reconcile_contributions(&packet, &[attempt]);
        assert_eq!(report.state, ReconciliationState::Abstained);
        assert!(report.claims.is_empty());
    }

    #[test]
    fn abstaining_required_role_keeps_partial_result_insufficient() {
        let packet = packet();
        let raw = json!({
            "schema": CONTRIBUTION_SCHEMA_V1,
            "packet_id": packet.packet_id(),
            "role": "causal_proposer",
            "abstained": true,
            "claims": []
        })
        .to_string();
        let abstaining_causal = ContributionAttemptV1::completed(
            validate_contribution(
                &raw,
                &packet,
                identity("careful"),
                ContributionRole::CausalProposer,
            )
            .unwrap(),
        );
        let report =
            reconcile_contributions(&packet, &[extraction(&packet, "fast"), abstaining_causal]);
        assert_eq!(report.state, ReconciliationState::InsufficientEvidence);
        assert!(report.escalation_recommended);
    }

    #[test]
    fn contradiction_checker_is_scoped_and_marks_report_contested() {
        let packet = packet();
        let raw = json!({
            "schema": CONTRIBUTION_SCHEMA_V1,
            "packet_id": packet.packet_id(),
            "role": "contradiction_checker",
            "contradictions": [{
                "contradiction_id": "cx",
                "candidate_a": "candidate-a",
                "candidate_b": "candidate-b",
                "evidence_ids": ["opaque-a", "opaque-b"],
                "text": "two candidates disagree"
            }]
        })
        .to_string();
        let checker = ContributionAttemptV1::completed(
            validate_contribution(
                &raw,
                &packet,
                identity("checker"),
                ContributionRole::ContradictionChecker,
            )
            .unwrap(),
        );
        let report = reconcile_contributions(&packet, &[checker]);
        assert_eq!(report.state, ReconciliationState::Contested);
        assert!(report.escalation_recommended);
        assert_eq!(report.reported_contradictions.len(), 1);
    }

    #[test]
    fn vocabulary_and_order_permutations_produce_same_normalized_claims() {
        let packet = packet();
        let mut first = extraction(&packet, "m1");
        let mut second = extraction(&packet, "m2");
        first.contribution.as_mut().unwrap().claims[0]
            .evidence_ids
            .reverse();
        second.contribution.as_mut().unwrap().claims.reverse();
        let left = reconcile_contributions(&packet, &[first.clone(), second.clone()]);
        let right = reconcile_contributions(&packet, &[second, first]);
        assert_eq!(left.claims, right.claims);
        assert_eq!(left.baseline, right.baseline);
    }

    #[test]
    fn routing_plan_allows_multiple_models_per_role_but_enforces_hard_bounds() {
        let policy = ContributionRoutingPolicy {
            max_contributors: 3,
            max_parallel: 2,
            ..ContributionRoutingPolicy::default()
        };
        let plan = ContributionRoutingPlan::new(
            vec![
                ContributionRole::ObservationExtractor,
                ContributionRole::ObservationExtractor,
                ContributionRole::CausalProposer,
            ],
            policy,
        )
        .expect("bounded plan");
        assert_eq!(plan.roles.len(), 3);
        assert_eq!(
            ContributionRoutingPlan::new(
                vec![ContributionRole::Reviewer],
                ContributionRoutingPolicy {
                    reviewer_enabled: false,
                    ..ContributionRoutingPolicy::default()
                }
            ),
            Err(ContributionRoutingError::ReviewerDisabled)
        );
        assert_eq!(
            ContributionRoutingPlan::new(
                vec![ContributionRole::Reviewer],
                ContributionRoutingPolicy {
                    max_parallel: 0,
                    ..ContributionRoutingPolicy::default()
                }
            ),
            Err(ContributionRoutingError::TooMuchParallelism)
        );
        assert_eq!(
            ContributionRoutingPlan::new(
                vec![
                    ContributionRole::Reviewer,
                    ContributionRole::ObservationExtractor
                ],
                ContributionRoutingPolicy::default(),
            ),
            Err(ContributionRoutingError::ReviewerNotFinal)
        );
        assert_eq!(
            ContributionRoutingPlan::new(
                vec![
                    ContributionRole::ObservationExtractor,
                    ContributionRole::Reviewer,
                    ContributionRole::Reviewer
                ],
                ContributionRoutingPolicy::default(),
            ),
            Err(ContributionRoutingError::MultipleReviewers)
        );
    }

    #[test]
    fn replay_compares_deterministic_single_and_bounded_modes_without_network() {
        let packet = packet();
        let observation = extraction(&packet, "fast");
        let causal = causal(&packet, "careful");
        let replay =
            replay_reconciliation(&packet, Some(&observation), &[observation.clone(), causal]);
        assert_eq!(
            replay.deterministic_only,
            ReconciliationState::DeterministicBaseline
        );
        assert_eq!(
            replay.single_contributor,
            ReconciliationState::InsufficientEvidence
        );
        assert_eq!(replay.bounded_multi_model, ReconciliationState::Supported);
        assert_eq!(replay.single_claim_count, 1);
        assert_eq!(replay.bounded_claim_count, 2);
        assert_eq!(replay.bounded_conflict_count, 0);
    }

    #[test]
    fn reconciliation_answer_is_host_validated_and_never_establishes_root() {
        let packet = packet();
        let attempts = vec![extraction(&packet, "fast"), causal(&packet, "careful")];
        let envelope = reconciliation_answer(&packet, &attempts).expect("answer floor");
        assert!(!envelope.answer.root_cause_established);
        assert_eq!(envelope.answer.candidates.len(), 3);
        assert!(envelope
            .answer
            .candidates
            .iter()
            .flat_map(|candidate| candidate.claims.iter())
            .all(
                |claim| claim.claim_kind != crate::investigation_answer::ClaimKind::InitiatingCause
            ));
        let rendered = crate::investigation_answer::render_answer_markdown(&envelope);
        assert!(rendered.contains("Root cause established: no"));
    }
}
