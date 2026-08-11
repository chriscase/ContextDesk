//! Multi-model investigation — reviewer-first V1.
//!
//! A provider-neutral pipeline in which more than one model can contribute to
//! one investigation while the host stays the sole authority. This module
//! owns the *pure* parts: the shared role vocabulary, the typed inter-stage
//! contracts (proposal → host-validated), per-stage budgets and telemetry, and
//! the sequential reviewer pipeline ([`pipeline::run_review_pipeline`]).
//!
//! What lives here is deliberately I/O-free and provider-agnostic. It never
//! parses config, constructs a provider client, reads a keychain, or names a
//! provider kind. Config resolution, backend construction, egress/qualification
//! decisions, and persistence are the workflow/host layer's job; this module
//! is handed already-resolved backends and a plan.
//!
//! Invariants this module upholds, mirroring
//! [`crate::investigation_answer`]:
//!
//! * The host is the only authority. Every stage output is a strict model
//!   *proposal* the host validates into a typed value against the immutable
//!   evidence ledger. One model's prose is never another model's authority.
//! * Every inter-stage reference is bounded by the host. Evidence ids and
//!   candidate ids are host-minted: a stage may never introduce one the host
//!   did not create, and may never cite across candidate scope. Claim / gap /
//!   contradiction ids are model-authored labels; a downstream stage may
//!   reference only the (candidate, claim) pairs the host recorded from
//!   already-validated findings, never a pair the host did not record.
//! * Causal establishment is never produced here. The final synthesis reuses
//!   [`crate::investigation_answer::validate_model_answer`], whose
//!   `root_cause_established` requires host `Cause` provenance.
//! * Every dynamic value that could be displayed passes through the shared
//!   presentation boundary ([`crate::investigation_answer::literal_span`]).

pub mod contracts;
/// Provider-neutral contribution proposals and deterministic reconciliation.
pub mod contributions;
pub mod pipeline;

pub use contracts::*;
pub use contributions::*;
pub use pipeline::*;

use serde::{Deserialize, Serialize};

/// Configured multi-model mode. Additive; `Single` is the default and leaves
/// the established single-model path byte-identical.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum MultiModelMode {
    /// One model, the existing multi-stage/single-stage path. Default floor.
    #[default]
    Single,
    /// One investigator + one reviewer (same or distinct provider), then
    /// host synthesis. Opt-in; degrades to `Single` on any unavailability.
    Review,
}

impl MultiModelMode {
    /// Stable wire label for DTOs and diagnostics.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Single => "single",
            Self::Review => "review",
        }
    }
}

/// Functional role in the pipeline. A role is filled by a `(profile, model)`
/// pair through host resolution; roles never name a provider kind.
///
/// Critic and panel roles are deliberately out of V1 scope.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InvestigationRole {
    /// Investigates one candidate independently; emits typed candidate findings.
    Investigator,
    /// Reviews typed candidate findings for evidence gaps and contradictions.
    Reviewer,
    /// Produces the final host-validated investigation answer.
    Synthesizer,
}

impl InvestigationRole {
    /// Stable wire label.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Investigator => "investigator",
            Self::Reviewer => "reviewer",
            Self::Synthesizer => "synthesizer",
        }
    }
}

/// Host-owned provenance for one stage's model call. Never model-supplied.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RoleBinding {
    /// Functional role this call filled.
    pub role: InvestigationRole,
    /// Provider profile id (host config identity; never a provider kind).
    pub profile_id: String,
    /// Exact model id used.
    pub model: String,
    /// Semantic corrections consumed for this stage (re-prompts on validation
    /// failure). Independent of transport retries, which live below the
    /// pipeline in the provider client and never increment this.
    pub semantic_attempts: u8,
}

/// Whether a role's model was verified for the capabilities its stage needs.
///
/// The host resolves this from the measured capability-qualification store;
/// the pipeline only reads it. A name hint is never a `Qualified`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QualificationState {
    /// Measured pass for the stage's required capabilities.
    Qualified,
    /// Measured but did not pass (or degraded).
    Unqualified,
    /// No measurement exists yet. Honest "unknown", never treated as a pass.
    Unverified,
}

/// Which path actually executed, reported honestly beside the configured mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutedMode {
    /// The existing single-model path ran; review was never attempted.
    Single,
    /// Investigator + reviewer + synthesis all ran; review contributed.
    Review,
    /// The multi-model pipeline ran but the reviewer stage did not contribute;
    /// synthesis proceeded from the typed candidate findings without review.
    ReviewDegraded,
}

impl ExecutedMode {
    /// Stable wire label.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Single => "single",
            Self::Review => "review",
            Self::ReviewDegraded => "review_degraded",
        }
    }
}

/// Exactly why review did not run, or did not contribute. Every degradation is
/// one of these; the pipeline never degrades silently.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DegradationReason {
    /// No reviewer role was configured / resolvable.
    ReviewerUnconfigured,
    /// The reviewer model was not measured-qualified and the role required it.
    ReviewerUnqualified,
    /// The reviewer's provider is remote and remote review was not acknowledged.
    ReviewerEgressNotAcknowledged,
    /// The reviewer's provider is remote but this turn is pinned local-only.
    ReviewerRemoteForbiddenLocalOnly,
    /// The whole-turn round budget could not fit a reviewer call.
    BudgetRoundsInsufficient,
    /// The whole-turn usage (context-char) budget could not fit a reviewer call.
    BudgetUsageInsufficient,
    /// The reviewer provider failed (rate limit / server / transport exhausted).
    ReviewerProviderFailed,
    /// The reviewer call exceeded the turn deadline.
    ReviewerDeadline,
    /// The reviewer's output failed host validation after its bounded correction.
    ReviewerSemanticInvalid,
    /// Fewer than two candidates were eligible for a reviewed comparison.
    NotEligible,
}

impl DegradationReason {
    /// Stable wire label.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ReviewerUnconfigured => "reviewer_unconfigured",
            Self::ReviewerUnqualified => "reviewer_unqualified",
            Self::ReviewerEgressNotAcknowledged => "reviewer_egress_not_acknowledged",
            Self::ReviewerRemoteForbiddenLocalOnly => "reviewer_remote_forbidden_local_only",
            Self::BudgetRoundsInsufficient => "budget_rounds_insufficient",
            Self::BudgetUsageInsufficient => "budget_usage_insufficient",
            Self::ReviewerProviderFailed => "reviewer_provider_failed",
            Self::ReviewerDeadline => "reviewer_deadline",
            Self::ReviewerSemanticInvalid => "reviewer_semantic_invalid",
            Self::NotEligible => "not_eligible",
        }
    }

    /// One host-authored, non-model sentence for operators. Never contains
    /// model text, provider prose, or a domain word.
    pub fn detail(self) -> &'static str {
        match self {
            Self::ReviewerUnconfigured => {
                "no reviewer model configured; answered with the single-model path"
            }
            Self::ReviewerUnqualified => {
                "reviewer model is not measured-qualified for structured output; \
                 answered with the single-model path"
            }
            Self::ReviewerEgressNotAcknowledged => {
                "reviewer uses a remote provider and remote review was not acknowledged; \
                 answered with the single-model path"
            }
            Self::ReviewerRemoteForbiddenLocalOnly => {
                "reviewer uses a remote provider but this turn is pinned local-only; \
                 answered with the single-model path"
            }
            Self::BudgetRoundsInsufficient => {
                "the turn's model-call budget could not fit a reviewer call; \
                 answered without review"
            }
            Self::BudgetUsageInsufficient => {
                "the turn's usage budget could not fit a reviewer call; answered without review"
            }
            Self::ReviewerProviderFailed => "the reviewer provider failed; answered without review",
            Self::ReviewerDeadline => "the reviewer call ran out of time; answered without review",
            Self::ReviewerSemanticInvalid => {
                "the reviewer output failed host validation; answered without review"
            }
            Self::NotEligible => {
                "fewer than two candidates were eligible; used the single-model path"
            }
        }
    }
}

/// Per-turn ceilings shared across all stages. Deliberately in units the host
/// always has: model-call rounds and model-facing characters. No currency is
/// invented — an honest deterministic usage budget, not dollars.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct MultiModelBudget {
    /// Hard ceiling on **logical provider attempts** across every stage. One
    /// attempt is one `complete_streaming` invocation actually sent — initial or
    /// a semantic-correction re-prompt — whether it then succeeds, fails, times
    /// out, or is cancelled; transport-library retries beneath it are not
    /// attempts. Each stage is clamped to what this ceiling still allows and each
    /// attempt is counted the moment before it is sent, so the total attempts
    /// issued never exceed this value even across failed stages. A stage with no
    /// room is not started (the investigator stops taking candidates, the
    /// reviewer degrades, and — only if even the mandatory synthesis has no room
    /// — the turn falls through to the single-model path). This bounds calls
    /// sent, not calls that returned successfully; per-stage `provider_rounds`
    /// telemetry likewise counts attempts sent.
    pub max_total_provider_rounds: u32,
    /// Per-stage semantic-correction cap (re-prompts on validation failure).
    /// Independent of transport retries.
    pub max_semantic_corrections_per_stage: u8,
    /// Hard model-facing context character budget per stage call.
    pub context_char_budget: usize,
    /// Whole-turn wall-clock deadline in ms (`0` = inherit turn default).
    pub deadline_ms: u64,
    /// Optional deterministic **whole-turn hard ceiling** on model-facing
    /// characters. Every stage call — investigator, reviewer, synthesis, and
    /// every semantic-correction re-prompt — is preflighted against the running
    /// total before it is sent, and no call is ever allowed to cross it: the
    /// sum of `context_chars_sent` across all stages never exceeds this value.
    /// The stages differ only in how exhaustion is handled: an over-ceiling
    /// *optional* reviewer degrades (`budget_usage_insufficient`) while an
    /// over-ceiling *required* investigator or synthesis fails closed (or, for
    /// the investigator phase, falls through to the single-model path). This is
    /// a hard cap on total characters, not merely a reviewer gate. `None` = no
    /// usage ceiling (rounds still bound the turn). Chars are a metric the host
    /// always knows, unlike provider-reported cost — no currency is invented.
    pub max_context_chars_total: Option<u64>,
}

impl Default for MultiModelBudget {
    fn default() -> Self {
        Self {
            // investigator per candidate (<=4) + reviewer (1) + synthesis (1)
            // + one bounded correction each. Conservative; the caller may lower.
            max_total_provider_rounds: 12,
            max_semantic_corrections_per_stage: 1,
            context_char_budget: crate::sessions::DEFAULT_CONTEXT_CHAR_BUDGET,
            deadline_ms: 0,
            max_context_chars_total: None,
        }
    }
}

/// Outcome of one stage's model interaction, for typed per-stage telemetry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StageOutcomeKind {
    /// The stage produced a host-validated typed value.
    Completed,
    /// The stage's model failed validation after its bounded correction.
    SemanticInvalid,
    /// The provider failed (rate limit / server / transport exhausted).
    ProviderFailed,
    /// The stage exceeded the turn deadline.
    Deadline,
    /// The turn was cancelled during the stage.
    Cancelled,
    /// A message would have crossed the per-call or whole-turn character
    /// ceiling, so it was never sent.
    BudgetExhausted,
    /// The stage was skipped (budget, degradation) without a model call.
    Skipped,
}

impl StageOutcomeKind {
    /// Stable wire label.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::SemanticInvalid => "semantic_invalid",
            Self::ProviderFailed => "provider_failed",
            Self::Deadline => "deadline",
            Self::Cancelled => "cancelled",
            Self::BudgetExhausted => "budget_exhausted",
            Self::Skipped => "skipped",
        }
    }
}

/// Typed per-stage telemetry. Transport retries are intentionally not counted
/// here: a 429 that recovers below the pipeline is invisible to
/// `provider_rounds` (the recovered call is one attempt), and a 429 that
/// exhausts surfaces as one counted attempt plus a `ProviderFailed` outcome —
/// exactly the transport-vs-semantic separation the existing oracle pins.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StageTelemetry {
    /// Which functional role this stage filled.
    pub role: InvestigationRole,
    /// Provider profile id used (host identity; never a provider kind).
    pub profile_id: String,
    /// Exact model id used.
    pub model: String,
    /// Logical provider attempts sent in this stage — each a `complete_streaming`
    /// invocation (initial or a semantic-correction re-prompt), counted whether
    /// it returned, failed, timed out, or was cancelled. Transport-library
    /// retries beneath it are not attempts. This is calls sent, not calls that
    /// returned an evaluable completion.
    pub provider_rounds: u32,
    /// Semantic corrections consumed (re-prompts on validation failure).
    pub semantic_corrections: u8,
    /// Model-facing characters sent across this stage's calls (usage metric).
    pub context_chars_sent: u64,
    /// How the stage ended.
    pub outcome: StageOutcomeKind,
}

/// Whole-turn multi-model telemetry: configured vs executed mode, the exact
/// degradation reason if any, and every stage's typed telemetry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MultiModelTurnTelemetry {
    /// Stable schema id for DTOs.
    pub schema: String,
    /// What config asked for.
    pub configured_mode: MultiModelMode,
    /// What actually ran.
    pub executed_mode: ExecutedMode,
    /// Present exactly when `executed_mode` is not `Review`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub degradation: Option<DegradationReason>,
    /// Per-stage typed telemetry, in execution order.
    pub stages: Vec<StageTelemetry>,
    /// Total logical provider attempts sent across the turn — the sum of every
    /// stage's `provider_rounds`. Never exceeds `max_total_provider_rounds`.
    pub total_provider_rounds: u32,
    /// Total model-facing characters sent across the turn (usage metric).
    pub total_context_chars_sent: u64,
}

/// Schema id for [`MultiModelTurnTelemetry`].
pub const MULTI_MODEL_TELEMETRY_SCHEMA_V1: &str = "contextdesk.multi_model.telemetry.v1";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wire_labels_are_stable_snake_case() {
        assert_eq!(MultiModelMode::Single.as_str(), "single");
        assert_eq!(MultiModelMode::Review.as_str(), "review");
        assert_eq!(InvestigationRole::Reviewer.as_str(), "reviewer");
        assert_eq!(ExecutedMode::ReviewDegraded.as_str(), "review_degraded");
        assert_eq!(
            DegradationReason::ReviewerRemoteForbiddenLocalOnly.as_str(),
            "reviewer_remote_forbidden_local_only"
        );
        assert_eq!(StageOutcomeKind::ProviderFailed.as_str(), "provider_failed");
        assert_eq!(
            StageOutcomeKind::BudgetExhausted.as_str(),
            "budget_exhausted"
        );
    }

    #[test]
    fn default_mode_is_single_and_budget_reserves_a_correction() {
        assert_eq!(MultiModelMode::default(), MultiModelMode::Single);
        let budget = MultiModelBudget::default();
        assert_eq!(budget.max_semantic_corrections_per_stage, 1);
        assert!(budget.max_total_provider_rounds >= 6);
        assert!(budget.max_context_chars_total.is_none());
    }

    #[test]
    fn every_degradation_reason_has_a_non_empty_host_detail() {
        for reason in [
            DegradationReason::ReviewerUnconfigured,
            DegradationReason::ReviewerUnqualified,
            DegradationReason::ReviewerEgressNotAcknowledged,
            DegradationReason::ReviewerRemoteForbiddenLocalOnly,
            DegradationReason::BudgetRoundsInsufficient,
            DegradationReason::BudgetUsageInsufficient,
            DegradationReason::ReviewerProviderFailed,
            DegradationReason::ReviewerDeadline,
            DegradationReason::ReviewerSemanticInvalid,
            DegradationReason::NotEligible,
        ] {
            assert!(!reason.detail().is_empty());
            assert!(!reason.as_str().is_empty());
        }
    }
}
