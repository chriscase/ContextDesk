//! Workflow-layer resolution of the host-grounded fast-triage runtime.
//!
//! This is where config, provider construction, credentials, egress policy, and
//! explicit authorization are enforced — the decisions the pure `cd-core` route
//! deliberately does not make. The output is either a ready
//! [`cd_core::agent::FastTriageRuntime`] (the route *may* be considered) or a
//! typed non-entry reason (it will not be, and the caller reports why).
//!
//! Two boundaries are load-bearing.
//!
//! **The route is never selected here.** This function decides only whether a
//! runtime can exist. Whether the route actually runs is decided by
//! [`cd_core::fast_triage::select_fast_triage_route`] against exact persisted
//! evidence for this turn's profile, model, workflow contract, and host contract
//! fingerprint. Splitting it this way means no config flag, and no shape of
//! provider resolution, can authorize a route the evidence does not.
//!
//! **A fallback backend is built only for an authorized fallback.** An
//! unauthorized or remote-unacknowledged fallback yields no backend at all, so
//! the route physically cannot call it. A gateway change requires config, not a
//! spare handle.

use std::sync::Arc;

use cd_core::agent::FastTriageRuntime;
use cd_core::config::AppConfig;
use cd_core::fast_triage::{
    FastTriageBudget, FastTriageFallback, FastTriageNeighborhoodBudget, FastTriageRouteRecord,
};
use cd_core::providers::ProviderProfile;

use crate::provider::{
    backend_for_resolved_turn, resolve_provider_profile,
    resolve_turn_inputs_from_profile_with_credential_cache, ResolvedTurnInputs,
    TurnProviderCredentialCache,
};

/// Exactly why a fast-triage runtime was not built, or why its fallback role is
/// unavailable. Every non-entry is one of these; nothing here is silent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FastTriageEntryDegradation {
    /// The route is switched off in config.
    RouteDisabled,
    /// The route is enabled but no persisted route evidence exists at all.
    NoRouteEvidence,
    /// A fallback is configured but the operator did not authorize sending this
    /// turn's evidence packet to it.
    FallbackNotAuthorized,
    /// A fallback is configured but its profile id does not resolve.
    FallbackUnconfigured,
    /// The fallback is remote and remote escalation was not acknowledged.
    FallbackEgressNotAcknowledged,
    /// The fallback is remote but this turn is pinned local-only.
    FallbackRemoteForbiddenLocalOnly,
    /// The fallback's backend could not be built.
    FallbackProviderFailed,
}

impl FastTriageEntryDegradation {
    /// Stable wire label.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::RouteDisabled => "route_disabled",
            Self::NoRouteEvidence => "no_route_evidence",
            Self::FallbackNotAuthorized => "fallback_not_authorized",
            Self::FallbackUnconfigured => "fallback_unconfigured",
            Self::FallbackEgressNotAcknowledged => "fallback_egress_not_acknowledged",
            Self::FallbackRemoteForbiddenLocalOnly => "fallback_remote_forbidden_local_only",
            Self::FallbackProviderFailed => "fallback_provider_failed",
        }
    }

    /// One host-authored sentence for operators. Never model text, never an
    /// endpoint, never a credential.
    pub fn detail(self) -> &'static str {
        match self {
            Self::RouteDisabled => {
                "the host-grounded fast route is disabled; used the established path"
            }
            Self::NoRouteEvidence => {
                "the host-grounded fast route is enabled but no persisted route evidence exists; \
                 used the established path"
            }
            Self::FallbackNotAuthorized => {
                "a fast-triage fallback model is configured but not authorized to receive this \
                 turn's evidence packet; a failed fast answer will be reported, not escalated"
            }
            Self::FallbackUnconfigured => {
                "the configured fast-triage fallback profile could not be resolved; a failed fast \
                 answer will be reported, not escalated"
            }
            Self::FallbackEgressNotAcknowledged => {
                "the fast-triage fallback uses a remote provider and remote escalation was not \
                 acknowledged; a failed fast answer will be reported, not escalated"
            }
            Self::FallbackRemoteForbiddenLocalOnly => {
                "the fast-triage fallback uses a remote provider but this turn is pinned \
                 local-only; a failed fast answer will be reported, not escalated"
            }
            Self::FallbackProviderFailed => {
                "the fast-triage fallback provider could not be prepared; a failed fast answer \
                 will be reported, not escalated"
            }
        }
    }
}

/// End-of-resolution outcome.
pub struct ResolvedFastTriage {
    /// Present iff a runtime could be built. Its presence means "the route may
    /// be *considered*", never "the route will run".
    pub runtime: Option<FastTriageRuntime>,
    /// Present iff something was configured but is unavailable. A runtime and a
    /// degradation can both be present: the route may still run without a
    /// fallback, and the caller reports that honestly.
    pub entry_degradation: Option<FastTriageEntryDegradation>,
}

/// Whether a host may resolve the optional fast-triage runtime for this turn.
///
/// Resolution can build an explicitly authorized fallback backend and read its
/// profile credential, so a turn that is not linked, is forced local, or has
/// already been cancelled must not enter that work at all. The core route
/// still receives the shared cancellation flag for races after admission.
pub fn should_resolve_fast_triage(
    linked_turn: bool,
    force_local: bool,
    already_cancelled: bool,
) -> bool {
    linked_turn && !force_local && !already_cancelled
}

impl ResolvedFastTriage {
    fn off(reason: FastTriageEntryDegradation) -> Self {
        Self {
            runtime: None,
            entry_degradation: Some(reason),
        }
    }
}

/// A profile is remote when it is not pinned local-only. Local-only profiles
/// refuse non-loopback bases in `backend_for`, so a local-only fallback cannot
/// egress; a remote one can, which is what the acknowledgment gates.
fn is_remote(profile: &ProviderProfile) -> bool {
    !profile.local_only
}

/// Resolve the fast-triage runtime for one turn.
///
/// `primary` is the already-resolved main-turn input; its profile and model are
/// what persisted route evidence must match. Route evidence itself is *not*
/// filtered here — the exact match belongs to the core selector, so this layer
/// cannot narrow or widen it by accident.
pub async fn resolve_fast_triage_runtime(
    cfg: &AppConfig,
    credentials: &TurnProviderCredentialCache<'_>,
    primary: &ResolvedTurnInputs,
) -> ResolvedFastTriage {
    let settings = &cfg.fast_triage;
    if !settings.enabled {
        return ResolvedFastTriage::off(FastTriageEntryDegradation::RouteDisabled);
    }
    if settings.routes.is_empty() {
        return ResolvedFastTriage::off(FastTriageEntryDegradation::NoRouteEvidence);
    }

    let records: Vec<FastTriageRouteRecord> = settings.routes.clone();
    let mut entry_degradation = None;
    let mut fallback = None;
    let mut fallback_backend = None;

    if let Some(configured) = settings.fallback.as_ref() {
        // Authorization is checked before any profile, credential, or network
        // work: an unauthorized fallback must not even cause a keychain read.
        if !configured.authorized {
            entry_degradation = Some(FastTriageEntryDegradation::FallbackNotAuthorized);
        } else if let Ok(profile) = resolve_provider_profile(cfg, Some(&configured.profile_id)) {
            let blocked = if is_remote(&profile) {
                if primary.profile.local_only {
                    Some(FastTriageEntryDegradation::FallbackRemoteForbiddenLocalOnly)
                } else if !configured.allow_remote {
                    Some(FastTriageEntryDegradation::FallbackEgressNotAcknowledged)
                } else {
                    None
                }
            } else {
                None
            };
            if let Some(reason) = blocked {
                entry_degradation = Some(reason);
            } else {
                let inputs = resolve_turn_inputs_from_profile_with_credential_cache(
                    credentials,
                    cfg,
                    profile,
                    configured.model.as_deref(),
                );
                match backend_for_resolved_turn(&inputs).await {
                    Ok(backend) => {
                        fallback = Some(FastTriageFallback {
                            profile_id: inputs.profile.id.clone(),
                            model_id: inputs.profile.chat_model.clone(),
                            authorized: true,
                        });
                        fallback_backend = Some(Arc::from(backend));
                    }
                    Err(_) => {
                        entry_degradation =
                            Some(FastTriageEntryDegradation::FallbackProviderFailed);
                    }
                }
            }
        } else {
            entry_degradation = Some(FastTriageEntryDegradation::FallbackUnconfigured);
        }
    }

    ResolvedFastTriage {
        runtime: Some(FastTriageRuntime {
            enabled: true,
            records,
            fallback,
            fallback_backend,
            // Deadline and per-call context budget are the turn's own, applied
            // by the seam; the correction cap is clamped in the core route.
            budget: FastTriageBudget::default(),
            neighborhood: FastTriageNeighborhoodBudget::default(),
        }),
        entry_degradation,
    }
}

/// A stage-progress `StreamEvent` for an entry-time degradation, so the caller
/// reports the exact reason before the established path runs.
pub fn entry_degradation_event(reason: FastTriageEntryDegradation) -> cd_core::events::StreamEvent {
    cd_core::events::StreamEvent::MultiModelStage {
        stage: "summary".into(),
        phase: "summary".into(),
        status: Some(reason.as_str().into()),
        detail: reason.detail().into(),
        candidate_id: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pre_cancelled_or_non_linked_turns_never_enter_resolution() {
        assert!(should_resolve_fast_triage(true, false, false));
        assert!(!should_resolve_fast_triage(true, false, true));
        assert!(!should_resolve_fast_triage(false, false, false));
        assert!(!should_resolve_fast_triage(true, true, false));
    }

    #[test]
    fn every_degradation_has_a_distinct_label_and_a_host_detail() {
        let reasons = [
            FastTriageEntryDegradation::RouteDisabled,
            FastTriageEntryDegradation::NoRouteEvidence,
            FastTriageEntryDegradation::FallbackNotAuthorized,
            FastTriageEntryDegradation::FallbackUnconfigured,
            FastTriageEntryDegradation::FallbackEgressNotAcknowledged,
            FastTriageEntryDegradation::FallbackRemoteForbiddenLocalOnly,
            FastTriageEntryDegradation::FallbackProviderFailed,
        ];
        let labels = reasons.map(FastTriageEntryDegradation::as_str);
        assert_eq!(
            labels
                .iter()
                .collect::<std::collections::BTreeSet<_>>()
                .len(),
            labels.len()
        );
        for reason in reasons {
            assert!(!reason.detail().is_empty());
            // Operator prose must never carry an endpoint or a credential.
            let detail = reason.detail().to_ascii_lowercase();
            for forbidden in ["http", "api_key", "bearer", "token", "/users/", "/home/"] {
                assert!(
                    !detail.contains(forbidden),
                    "{reason:?} detail leaked {forbidden}"
                );
            }
        }
    }
}
