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

use cd_core::agent::ContributionRuntime;
use cd_core::agent::MultiModelRuntime;
use cd_core::capability_qualification::{
    capability_contract_verdict, CapabilityContract, ContractVerdict, QualificationKey,
    QualificationStore,
};
use cd_core::config::AppConfig;
use cd_core::multi_model::{
    ContributionBackendSlot, ContributionQualification, ContributionRoutingPlan, DegradationReason,
    MultiModelBudget, MultiModelMode, MultiModelRoleIds,
};
use cd_core::providers::ProviderProfile;

use crate::provider::{
    backend_for_resolved_turn, resolve_provider_profile,
    resolve_turn_inputs_from_profile_with_credential_cache, ResolvedTurnInputs,
    TurnProviderCredentialCache,
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

/// Workflow-side resolution result for the opt-in contribution route.
pub struct ResolvedContributions {
    /// Present only when at least one explicitly configured, qualified role
    /// backend was built and the linked turn is eligible.
    pub runtime: Option<ContributionRuntime>,
    /// Host-authored explanation when configuration requested contributions
    /// but they could not be prepared. It contains no provider text or secret.
    pub entry_degradation: Option<&'static str>,
}

impl ResolvedContributions {
    fn disabled() -> Self {
        Self {
            runtime: None,
            entry_degradation: None,
        }
    }

    fn degraded(detail: &'static str) -> Self {
        Self {
            runtime: None,
            entry_degradation: Some(detail),
        }
    }
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
    credentials: &TurnProviderCredentialCache<'_>,
    requested_mode: MultiModelMode,
    investigator: &ResolvedTurnInputs,
    reviewer_qualified: Option<bool>,
    context_char_budget: usize,
) -> ResolvedReview {
    if requested_mode != MultiModelMode::Review {
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
    let reviewer_inputs = resolve_turn_inputs_from_profile_with_credential_cache(
        credentials,
        cfg,
        reviewer_profile,
        reviewer_cfg.model.as_deref(),
    );
    let reviewer_backend = match backend_for_resolved_turn(&reviewer_inputs).await {
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

/// Resolve the persistent contribution-role configuration into already
/// authorized backend slots. This is the only layer that reads config,
/// qualification evidence, credentials, and provider construction; the core
/// pipeline remains provider-neutral. Every role is fail-closed unless the
/// exact prompted-JSON proposal contract is measured for its profile/model.
pub async fn resolve_contribution_runtime(
    cfg: &AppConfig,
    credentials: &TurnProviderCredentialCache<'_>,
    investigator: &ResolvedTurnInputs,
    qualification_store: Option<&QualificationStore>,
    context_char_budget: usize,
    linked_turn: bool,
    force_enable: bool,
) -> ResolvedContributions {
    let settings = &cfg.contributions;
    if !settings.enabled && !force_enable {
        return ResolvedContributions::disabled();
    }
    if !linked_turn && !force_enable {
        return ResolvedContributions::disabled();
    }
    if !linked_turn {
        return ResolvedContributions::degraded(
            "contribution route requested for an ordinary chat; answered with the single-model path",
        );
    }
    if settings.roles.is_empty() {
        return ResolvedContributions::degraded(
            "contribution route is enabled but no role assignments are configured; answered with the deterministic floor",
        );
    }

    let mut slots = Vec::new();
    for assignment in &settings.roles {
        let Ok(profile) = resolve_provider_profile(cfg, Some(&assignment.profile_id)) else {
            continue;
        };
        if is_remote(&profile) && investigator.profile.local_only {
            continue;
        }
        if is_remote(&profile) && !assignment.allow_remote {
            continue;
        }
        let inputs = resolve_turn_inputs_from_profile_with_credential_cache(
            credentials,
            cfg,
            profile,
            assignment.model.as_deref(),
        );
        let key = QualificationKey::with_provider_kind(
            &inputs.profile.id,
            &inputs.profile.base_url,
            &inputs.profile.chat_model,
            inputs.profile.kind,
        );
        let qualification = qualification_store
            .and_then(|store| store.get(&key))
            .map(|report| {
                matches!(
                    capability_contract_verdict(Some(report), CapabilityContract::JsonProposal),
                    ContractVerdict::Qualified
                )
            })
            .map_or(ContributionQualification::Unverified, |qualified| {
                if qualified {
                    ContributionQualification::Qualified
                } else {
                    ContributionQualification::Unqualified
                }
            });
        if assignment.require_qualified && qualification != ContributionQualification::Qualified {
            continue;
        }
        if qualification != ContributionQualification::Qualified {
            continue;
        }
        let Ok(backend) = backend_for_resolved_turn(&inputs).await else {
            continue;
        };
        slots.push(ContributionBackendSlot {
            role: assignment.role,
            identity: cd_core::multi_model::ContributionIdentity {
                profile_id: inputs.profile.id,
                model: inputs.profile.chat_model,
            },
            qualification,
            backend: Arc::from(backend),
        });
    }
    if slots.is_empty() {
        return ResolvedContributions::degraded(
            "no configured contribution role has current qualified evidence; answered with the deterministic floor",
        );
    }
    let roles = slots.iter().map(|slot| slot.role).collect::<Vec<_>>();
    let Ok(plan) = ContributionRoutingPlan::new(roles, settings.policy) else {
        return ResolvedContributions::degraded(
            "contribution role configuration exceeds its host routing policy; answered with the deterministic floor",
        );
    };
    let budget = MultiModelBudget {
        max_total_provider_rounds: settings.budget.max_total_provider_rounds,
        max_semantic_corrections_per_stage: settings.budget.max_semantic_corrections_per_stage,
        context_char_budget: context_char_budget.min(settings.policy.max_context_chars),
        deadline_ms: 0,
        max_context_chars_total: settings.budget.max_context_chars_total,
    };
    ResolvedContributions {
        runtime: Some(ContributionRuntime {
            slots,
            plan,
            budget,
            neighborhood: settings.neighborhood,
            policy_binding: None,
        }),
        entry_degradation: None,
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

#[cfg(test)]
mod tests {
    use super::*;
    use cd_core::config::ContributionRoleConfig;
    use cd_core::keychain_store::SecretStore;
    use cd_core::providers::ProviderConfig;

    struct NoSecrets;
    impl SecretStore for NoSecrets {
        fn get(&self, _reference: &str) -> cd_core::error::CoreResult<Option<String>> {
            Ok(None)
        }

        fn set(&self, _reference: &str, _value: &str) -> cd_core::error::CoreResult<()> {
            Ok(())
        }

        fn delete(&self, _reference: &str) -> cd_core::error::CoreResult<()> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn missing_qualification_degrades_before_backend_construction() {
        let mut cfg = AppConfig {
            providers: ProviderConfig::with_local_ollama(),
            ..AppConfig::default()
        };
        cfg.contributions.enabled = true;
        cfg.contributions.roles = vec![ContributionRoleConfig {
            role: cd_core::multi_model::ContributionRole::ObservationExtractor,
            profile_id: cfg.providers.profiles[0].id.clone(),
            model: Some("cheap-local".into()),
            require_qualified: true,
            allow_remote: false,
        }];
        let secrets = NoSecrets;
        let cache = TurnProviderCredentialCache::new(&secrets);
        let profile = resolve_provider_profile(&cfg, None).unwrap();
        let resolved =
            resolve_turn_inputs_from_profile_with_credential_cache(&cache, &cfg, profile, None);
        let result =
            resolve_contribution_runtime(&cfg, &cache, &resolved, None, 10_000, true, false).await;
        assert!(result.runtime.is_none());
        assert!(result
            .entry_degradation
            .is_some_and(|detail| detail.contains("qualified evidence")));
    }

    #[tokio::test]
    async fn disabled_contributions_are_a_noop_even_with_roles_configured() {
        let mut cfg = AppConfig {
            providers: ProviderConfig::with_local_ollama(),
            ..AppConfig::default()
        };
        cfg.contributions.roles = vec![ContributionRoleConfig {
            role: cd_core::multi_model::ContributionRole::CausalProposer,
            profile_id: cfg.providers.profiles[0].id.clone(),
            model: None,
            require_qualified: true,
            allow_remote: false,
        }];
        let secrets = NoSecrets;
        let cache = TurnProviderCredentialCache::new(&secrets);
        let profile = resolve_provider_profile(&cfg, None).unwrap();
        let resolved =
            resolve_turn_inputs_from_profile_with_credential_cache(&cache, &cfg, profile, None);
        let result =
            resolve_contribution_runtime(&cfg, &cache, &resolved, None, 10_000, true, false).await;
        assert!(result.runtime.is_none());
        assert!(result.entry_degradation.is_none());
    }

    #[tokio::test]
    async fn enabled_contributions_are_a_noop_for_ordinary_chat() {
        let mut cfg = AppConfig {
            providers: ProviderConfig::with_local_ollama(),
            ..AppConfig::default()
        };
        cfg.contributions.enabled = true;
        let secrets = NoSecrets;
        let cache = TurnProviderCredentialCache::new(&secrets);
        let profile = resolve_provider_profile(&cfg, None).unwrap();
        let resolved =
            resolve_turn_inputs_from_profile_with_credential_cache(&cache, &cfg, profile, None);
        let result =
            resolve_contribution_runtime(&cfg, &cache, &resolved, None, 10_000, false, false).await;
        assert!(result.runtime.is_none());
        assert!(result.entry_degradation.is_none());
    }
}
