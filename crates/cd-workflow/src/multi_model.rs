//! Workflow-layer resolution of the multi-model reviewer runtime.
//!
//! This is where config, provider construction, qualification, egress, and
//! local-only policy are enforced — the decisions the pure cd-core pipeline
//! deliberately does not make. The output is either a ready
//! [`cd_core::agent::MultiModelRuntime`] (review may run) or a typed entry
//! degradation with an exact reason (review will not run; the caller uses the
//! single-model path and reports the reason). Nothing here is silent.
//!
//! Both hosts share this: the CLI drives it from [`crate::chat`], and the
//! desktop host calls [`resolve_reviewer_runtime`] directly before its own
//! `run_turn`. Credentials are resolved from the keychain into the reviewer
//! backend in Rust; they never cross IPC.

use std::sync::Arc;

use cd_core::agent::MultiModelRuntime;
use cd_core::config::AppConfig;
use cd_core::keychain_store::SecretStore;
use cd_core::multi_model::{
    DegradationReason, MultiModelBudget, MultiModelMode, MultiModelRoleIds,
};
use cd_core::providers::ProviderProfile;

use crate::provider::{
    resolve_provider_profile, resolve_turn_inputs_from_profile, ResolvedTurnInputs,
};

/// End-of-resolution outcome. Exactly one of `runtime` / `entry` is set for a
/// review request; `Single` requests set neither.
pub struct ResolvedReview {
    /// Present iff review may run.
    pub runtime: Option<MultiModelRuntime>,
    /// Present iff review was requested but cannot run; carries the exact
    /// reason to report alongside `configured_mode = review`.
    pub entry_degradation: Option<DegradationReason>,
    /// What the caller asked for this turn.
    pub configured_mode: MultiModelMode,
}

impl ResolvedReview {
    fn single() -> Self {
        Self {
            runtime: None,
            entry_degradation: None,
            configured_mode: MultiModelMode::Single,
        }
    }

    fn degraded(reason: DegradationReason) -> Self {
        Self {
            runtime: None,
            entry_degradation: Some(reason),
            configured_mode: MultiModelMode::Review,
        }
    }
}

/// A profile is remote when it is not pinned local-only. Local-only profiles
/// refuse non-loopback bases in `backend_for`, so a local-only reviewer cannot
/// egress; a remote reviewer can, which is what the acknowledgment gates.
fn is_remote(profile: &ProviderProfile) -> bool {
    !profile.local_only
}

/// Resolve the reviewer runtime for one turn.
///
/// `requested_mode` is the per-turn choice (a config default may be overridden
/// per turn). `investigator` is the already-resolved main-turn inputs (its
/// profile fills the investigator and synthesizer roles). `reviewer_qualified`
/// is the host-resolved measured verdict: `Some(true)` = measured pass,
/// `Some(false)` = measured fail, `None` = unverified (no measurement). A
/// name is never a qualification.
pub async fn resolve_reviewer_runtime(
    cfg: &AppConfig,
    secrets: &dyn SecretStore,
    requested_mode: MultiModelMode,
    investigator: &ResolvedTurnInputs,
    reviewer_qualified: Option<bool>,
    context_char_budget: usize,
) -> ResolvedReview {
    if requested_mode == MultiModelMode::Single {
        return ResolvedReview::single();
    }

    let Some(reviewer_cfg) = cfg.multi_model.reviewer.as_ref() else {
        return ResolvedReview::degraded(DegradationReason::ReviewerUnconfigured);
    };
    // Resolve the reviewer's profile by id (provider-neutral; never a kind).
    let Ok(reviewer_profile) = resolve_provider_profile(cfg, Some(&reviewer_cfg.profile_id)) else {
        return ResolvedReview::degraded(DegradationReason::ReviewerUnconfigured);
    };

    // Egress + local-only policy, before any credential or network work.
    if is_remote(&reviewer_profile) {
        if investigator.profile.local_only {
            return ResolvedReview::degraded(DegradationReason::ReviewerRemoteForbiddenLocalOnly);
        }
        if !reviewer_cfg.allow_remote {
            return ResolvedReview::degraded(DegradationReason::ReviewerEgressNotAcknowledged);
        }
    }

    // Qualification: a required-but-unverified/failed reviewer degrades.
    if reviewer_cfg.require_qualified && reviewer_qualified != Some(true) {
        return ResolvedReview::degraded(DegradationReason::ReviewerUnqualified);
    }

    // Resolve the reviewer's model + credential (keychain only) and build its
    // backend. A build failure is an honest provider degradation.
    let reviewer_inputs = resolve_turn_inputs_from_profile(
        secrets,
        cfg,
        reviewer_profile,
        reviewer_cfg.model.as_deref(),
    );
    let reviewer_backend = match cd_core::research::backend_for(
        &reviewer_inputs.profile,
        reviewer_inputs.api_key.clone(),
    )
    .await
    {
        Ok(backend) => Arc::from(backend),
        Err(_) => return ResolvedReview::degraded(DegradationReason::ReviewerProviderFailed),
    };

    let budget = MultiModelBudget {
        max_total_provider_rounds: cfg.multi_model.budget.max_total_provider_rounds,
        max_semantic_corrections_per_stage: cfg
            .multi_model
            .budget
            .max_semantic_corrections_per_stage,
        // Per-call context budget comes from the turn's resolved budget.
        context_char_budget,
        // Deadline is the turn's real deadline, applied by the seam.
        deadline_ms: 0,
        max_context_chars_total: cfg.multi_model.budget.max_context_chars_total,
    };

    let role_ids = MultiModelRoleIds {
        investigator_profile: investigator.profile.id.clone(),
        investigator_model: investigator.profile.chat_model.clone(),
        reviewer_profile: reviewer_inputs.profile.id.clone(),
        reviewer_model: reviewer_inputs.profile.chat_model.clone(),
        synthesizer_profile: investigator.profile.id.clone(),
        synthesizer_model: investigator.profile.chat_model.clone(),
    };

    ResolvedReview {
        runtime: Some(MultiModelRuntime {
            configured_mode: MultiModelMode::Review,
            role_ids,
            budget,
            reviewer_backend,
        }),
        entry_degradation: None,
        configured_mode: MultiModelMode::Review,
    }
}

/// A stage-progress `StreamEvent` for an entry-time degradation, so the caller
/// reports the configured mode, executed mode, and exact reason honestly
/// before the single-model turn runs.
pub fn entry_degradation_event(reason: DegradationReason) -> cd_core::events::StreamEvent {
    cd_core::events::StreamEvent::MultiModelStage {
        stage: "summary".into(),
        phase: "summary".into(),
        status: Some("single".into()),
        detail: reason.detail().into(),
        candidate_id: None,
    }
}
