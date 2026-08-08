//! Workflow-layer adversarial gates for reviewer runtime resolution.
//!
//! These cover the decisions the pure pipeline deliberately does not make:
//! entry-time degradation for an unconfigured / unqualified / remote-without-
//! acknowledgment / local-only-forbidden reviewer, and the property that a
//! refused reviewer builds no backend (no network). Opaque identifiers only.

use cd_core::config::{
    AppConfig, MultiModelBudgetConfig, MultiModelSettings, ReviewerRoleConfig,
};
use cd_core::keychain_store::MemorySecretStore;
use cd_core::multi_model::{DegradationReason, MultiModelMode};
use cd_core::providers::{ProviderCapabilities, ProviderConfig, ProviderKind, ProviderProfile};
use cd_workflow::multi_model::resolve_reviewer_runtime;
use cd_workflow::provider::{resolve_turn_inputs, ResolvedTurnInputs};

fn local_profile(id: &str) -> ProviderProfile {
    let mut p = ProviderProfile::ollama_local();
    p.id = id.into();
    p.local_only = true;
    p
}

fn remote_profile(id: &str) -> ProviderProfile {
    ProviderProfile {
        id: id.into(),
        label: id.into(),
        kind: ProviderKind::OpenAiCompatible,
        base_url: "https://provider.example/v1".into(),
        api_key_ref: None,
        chat_model: "m-remote".into(),
        embedding_model: None,
        embedding_base_url: None,
        capabilities: ProviderCapabilities {
            tools: true,
            stream: true,
            embeddings: false,
        },
        local_only: false,
        deadline_preference: Default::default(),
    }
}

/// Config with an investigator active profile plus an optional reviewer.
fn config(investigator: ProviderProfile, reviewer: Option<ReviewerRoleConfig>) -> AppConfig {
    AppConfig {
        providers: ProviderConfig {
            active_id: Some(investigator.id.clone()),
            profiles: vec![investigator, remote_profile("rev-remote"), local_profile("rev-local")],
        },
        multi_model: MultiModelSettings {
            mode: MultiModelMode::Review,
            reviewer,
            budget: MultiModelBudgetConfig::default(),
        },
        ..AppConfig::default()
    }
}

fn investigator_inputs(cfg: &AppConfig, secrets: &MemorySecretStore) -> ResolvedTurnInputs {
    resolve_turn_inputs(secrets, cfg, None, None).expect("investigator resolves")
}

fn reviewer(profile_id: &str, allow_remote: bool, require_qualified: bool) -> ReviewerRoleConfig {
    ReviewerRoleConfig {
        profile_id: profile_id.into(),
        model: None,
        require_qualified,
        allow_remote,
    }
}

async fn resolve(
    cfg: &AppConfig,
    secrets: &MemorySecretStore,
    mode: MultiModelMode,
    reviewer_qualified: Option<bool>,
) -> (bool, Option<DegradationReason>) {
    let inv = investigator_inputs(cfg, secrets);
    let r = resolve_reviewer_runtime(cfg, secrets, mode, &inv, reviewer_qualified, 120_000).await;
    (r.runtime.is_some(), r.entry_degradation)
}

#[tokio::test]
async fn single_mode_never_builds_a_reviewer_and_is_not_a_degradation() {
    let secrets = MemorySecretStore::new();
    let cfg = config(local_profile("inv"), Some(reviewer("rev-local", false, false)));
    let (has_runtime, degradation) = resolve(&cfg, &secrets, MultiModelMode::Single, None).await;
    assert!(!has_runtime);
    assert!(degradation.is_none());
}

#[tokio::test]
async fn an_unconfigured_reviewer_degrades() {
    let secrets = MemorySecretStore::new();
    let cfg = config(local_profile("inv"), None);
    let (has_runtime, degradation) = resolve(&cfg, &secrets, MultiModelMode::Review, None).await;
    assert!(!has_runtime);
    assert_eq!(degradation, Some(DegradationReason::ReviewerUnconfigured));
}

#[tokio::test]
async fn a_reviewer_profile_that_does_not_exist_degrades() {
    let secrets = MemorySecretStore::new();
    let cfg = config(local_profile("inv"), Some(reviewer("ghost", false, false)));
    let (has_runtime, degradation) = resolve(&cfg, &secrets, MultiModelMode::Review, None).await;
    assert!(!has_runtime);
    assert_eq!(degradation, Some(DegradationReason::ReviewerUnconfigured));
}

#[tokio::test]
async fn a_local_only_investigator_forbids_a_remote_reviewer() {
    let secrets = MemorySecretStore::new();
    // Even with allow_remote, a local-only investigator pins the turn local.
    let cfg = config(local_profile("inv"), Some(reviewer("rev-remote", true, false)));
    let (has_runtime, degradation) = resolve(&cfg, &secrets, MultiModelMode::Review, None).await;
    assert!(!has_runtime);
    assert_eq!(
        degradation,
        Some(DegradationReason::ReviewerRemoteForbiddenLocalOnly)
    );
}

#[tokio::test]
async fn a_remote_reviewer_without_acknowledgment_degrades() {
    let secrets = MemorySecretStore::new();
    // Remote investigator (not local-only) + remote reviewer without allow_remote.
    let cfg = config(remote_profile("inv"), Some(reviewer("rev-remote", false, false)));
    let (has_runtime, degradation) = resolve(&cfg, &secrets, MultiModelMode::Review, None).await;
    assert!(!has_runtime);
    assert_eq!(
        degradation,
        Some(DegradationReason::ReviewerEgressNotAcknowledged)
    );
}

#[tokio::test]
async fn a_required_qualified_but_unverified_reviewer_degrades() {
    let secrets = MemorySecretStore::new();
    let cfg = config(local_profile("inv"), Some(reviewer("rev-local", false, true)));
    // Unverified (None) with require_qualified → degrade.
    let (has_runtime, degradation) = resolve(&cfg, &secrets, MultiModelMode::Review, None).await;
    assert!(!has_runtime);
    assert_eq!(degradation, Some(DegradationReason::ReviewerUnqualified));
    // Measured fail → also degrade.
    let (has_runtime, degradation) =
        resolve(&cfg, &secrets, MultiModelMode::Review, Some(false)).await;
    assert!(!has_runtime);
    assert_eq!(degradation, Some(DegradationReason::ReviewerUnqualified));
}

#[tokio::test]
async fn a_local_reviewer_builds_a_runtime_when_permitted() {
    let secrets = MemorySecretStore::new();
    // Local reviewer, require_qualified=false → runs without a measurement.
    let cfg = config(local_profile("inv"), Some(reviewer("rev-local", false, false)));
    let (has_runtime, degradation) = resolve(&cfg, &secrets, MultiModelMode::Review, None).await;
    assert!(has_runtime, "a permitted local reviewer builds a runtime");
    assert!(degradation.is_none());

    // A measured-qualified reviewer with require_qualified also runs.
    let cfg = config(local_profile("inv"), Some(reviewer("rev-local", false, true)));
    let (has_runtime, degradation) =
        resolve(&cfg, &secrets, MultiModelMode::Review, Some(true)).await;
    assert!(has_runtime);
    assert!(degradation.is_none());
}

/// A refused reviewer never builds a backend, so a refusal cannot touch the
/// network. We prove it structurally: the remote reviewer's base is a
/// non-resolvable host, so if resolution built a backend eagerly it would
/// still only be *constructed* (backend_for does not connect for OpenAI-
/// compatible), but more importantly the egress refusal returns *before*
/// backend construction — the reason is the egress gate, not a build error.
#[tokio::test]
async fn a_refused_remote_reviewer_is_refused_by_policy_not_by_a_build_or_connect() {
    let secrets = MemorySecretStore::new();
    let cfg = config(remote_profile("inv"), Some(reviewer("rev-remote", false, false)));
    let (_has, degradation) = resolve(&cfg, &secrets, MultiModelMode::Review, None).await;
    // Policy reason, never a provider/connect error — proves the gate ran first.
    assert_eq!(
        degradation,
        Some(DegradationReason::ReviewerEgressNotAcknowledged)
    );
}
