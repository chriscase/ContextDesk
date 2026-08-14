//! Workflow-layer adversarial gates for reviewer runtime resolution.
//!
//! These cover the decisions the pure pipeline deliberately does not make:
//! entry-time degradation for an unconfigured / unqualified / remote-without-
//! acknowledgment / local-only-forbidden reviewer, and the property that a
//! refused reviewer builds no backend (no network). Opaque identifiers only.

use cd_core::config::{AppConfig, MultiModelBudgetConfig, MultiModelSettings, ReviewerRoleConfig};
use cd_core::error::CoreResult;
use cd_core::keychain_store::{MemorySecretStore, SecretStore};
use cd_core::multi_model::{DegradationReason, MultiModelMode};
use cd_core::providers::{ProviderCapabilities, ProviderConfig, ProviderKind, ProviderProfile};
use cd_workflow::multi_model::resolve_reviewer_runtime;
use cd_workflow::provider::{
    resolve_turn_inputs_with_credential_cache, TurnProviderCredentialCache,
};
use std::collections::HashMap;
use std::sync::Mutex;

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
            profiles: vec![
                investigator,
                remote_profile("rev-remote"),
                local_profile("rev-local"),
            ],
        },
        multi_model: MultiModelSettings {
            mode: MultiModelMode::Review,
            reviewer,
            budget: MultiModelBudgetConfig::default(),
        },
        ..AppConfig::default()
    }
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
    secrets: &dyn SecretStore,
    mode: MultiModelMode,
    reviewer_qualified: Option<bool>,
) -> (bool, Option<DegradationReason>) {
    let credentials = TurnProviderCredentialCache::new(secrets);
    let inv = resolve_turn_inputs_with_credential_cache(&credentials, cfg, None, None)
        .expect("investigator resolves");
    let r =
        resolve_reviewer_runtime(cfg, &credentials, mode, &inv, reviewer_qualified, 120_000).await;
    (r.runtime.is_some(), r.entry_degradation)
}

fn credential_config(investigator_ref: Option<&str>, reviewer_ref: Option<&str>) -> AppConfig {
    // Local profiles keep this proof hermetic. Provider input resolution still
    // dereferences their configured refs, while backend construction performs
    // no DNS or remote request.
    let mut investigator = local_profile("inv-credential");
    investigator.api_key_ref = investigator_ref.map(str::to_string);
    let mut reviewer_profile = local_profile("rev-credential");
    reviewer_profile.api_key_ref = reviewer_ref.map(str::to_string);
    AppConfig {
        providers: ProviderConfig {
            active_id: Some(investigator.id.clone()),
            profiles: vec![investigator, reviewer_profile],
        },
        multi_model: MultiModelSettings {
            mode: MultiModelMode::Review,
            reviewer: Some(reviewer("rev-credential", false, false)),
            budget: MultiModelBudgetConfig::default(),
        },
        ..AppConfig::default()
    }
}

#[derive(Default)]
struct CountingSecretStore {
    values: HashMap<String, String>,
    reads: Mutex<HashMap<String, usize>>,
}

impl CountingSecretStore {
    fn with_values(values: impl IntoIterator<Item = (String, String)>) -> Self {
        Self {
            values: values.into_iter().collect(),
            reads: Mutex::new(HashMap::new()),
        }
    }

    fn reads_for(&self, reference: &str) -> usize {
        self.reads
            .lock()
            .expect("read counter")
            .get(reference)
            .copied()
            .unwrap_or_default()
    }
}

impl SecretStore for CountingSecretStore {
    fn get(&self, reference: &str) -> CoreResult<Option<String>> {
        *self
            .reads
            .lock()
            .expect("read counter")
            .entry(reference.to_string())
            .or_default() += 1;
        Ok(self.values.get(reference).cloned())
    }

    fn set(&self, _reference: &str, _secret: &str) -> CoreResult<()> {
        unreachable!("turn resolution must not write secrets")
    }

    fn delete(&self, _reference: &str) -> CoreResult<()> {
        unreachable!("turn resolution must not delete secrets")
    }
}

#[tokio::test]
async fn a_shared_primary_and_reviewer_provider_ref_is_read_once_per_turn() {
    let reference = "provider/shared/api_key";
    let secrets = CountingSecretStore::with_values([(reference.into(), "opaque-secret".into())]);
    let cfg = credential_config(Some(reference), Some(reference));
    let credentials = TurnProviderCredentialCache::new(&secrets);

    let investigator = resolve_turn_inputs_with_credential_cache(&credentials, &cfg, None, None)
        .expect("investigator resolves");
    assert_eq!(investigator.api_key.as_deref(), Some("opaque-secret"));
    let review = resolve_reviewer_runtime(
        &cfg,
        &credentials,
        MultiModelMode::Review,
        &investigator,
        None,
        120_000,
    )
    .await;

    assert!(review.runtime.is_some(), "reviewer backend should build");
    assert_eq!(secrets.reads_for(reference), 1);
}

#[tokio::test]
async fn distinct_primary_and_reviewer_provider_refs_are_each_read_once() {
    let investigator_ref = "provider/investigator/api_key";
    let reviewer_ref = "provider/reviewer/api_key";
    let secrets = CountingSecretStore::with_values([
        (investigator_ref.into(), "opaque-investigator".into()),
        (reviewer_ref.into(), "opaque-reviewer".into()),
    ]);
    let cfg = credential_config(Some(investigator_ref), Some(reviewer_ref));
    let credentials = TurnProviderCredentialCache::new(&secrets);

    let investigator = resolve_turn_inputs_with_credential_cache(&credentials, &cfg, None, None)
        .expect("investigator resolves");
    let review = resolve_reviewer_runtime(
        &cfg,
        &credentials,
        MultiModelMode::Review,
        &investigator,
        None,
        120_000,
    )
    .await;

    assert!(review.runtime.is_some(), "reviewer backend should build");
    assert_eq!(secrets.reads_for(investigator_ref), 1);
    assert_eq!(secrets.reads_for(reviewer_ref), 1);
}

#[tokio::test]
async fn provider_resolution_does_not_touch_unrelated_secret_namespaces() {
    let unrelated = [
        "connector/confluence/pat",
        "connector/example/api_key",
        "retrieval/embedding/api_key",
        "x/default/api_key",
        "module/example/secret",
    ];
    let secrets = CountingSecretStore::with_values(
        unrelated
            .iter()
            .map(|reference| ((*reference).to_string(), "opaque-secret".to_string())),
    );
    let cfg = credential_config(None, None);
    let credentials = TurnProviderCredentialCache::new(&secrets);

    let investigator = resolve_turn_inputs_with_credential_cache(&credentials, &cfg, None, None)
        .expect("investigator resolves");
    let review = resolve_reviewer_runtime(
        &cfg,
        &credentials,
        MultiModelMode::Review,
        &investigator,
        None,
        120_000,
    )
    .await;

    assert!(
        review.runtime.is_some(),
        "keyless reviewer backend should build"
    );
    for reference in unrelated {
        assert_eq!(
            secrets.reads_for(reference),
            0,
            "unexpected read: {reference}"
        );
    }
}

#[test]
fn separately_admitted_turns_do_not_share_provider_credentials() {
    let reference = "provider/repeated/api_key";
    let secrets = CountingSecretStore::with_values([(reference.into(), "opaque-secret".into())]);
    let cfg = credential_config(Some(reference), None);

    for _ in 0..2 {
        let credentials = TurnProviderCredentialCache::new(&secrets);
        let resolved = resolve_turn_inputs_with_credential_cache(&credentials, &cfg, None, None)
            .expect("investigator resolves");
        assert_eq!(resolved.api_key.as_deref(), Some("opaque-secret"));
    }

    assert_eq!(secrets.reads_for(reference), 2);
}

#[tokio::test]
async fn single_mode_never_builds_a_reviewer_and_is_not_a_degradation() {
    let secrets = MemorySecretStore::new();
    let cfg = config(
        local_profile("inv"),
        Some(reviewer("rev-local", false, false)),
    );
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
    let cfg = config(
        local_profile("inv"),
        Some(reviewer("rev-remote", true, false)),
    );
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
    let cfg = config(
        remote_profile("inv"),
        Some(reviewer("rev-remote", false, false)),
    );
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
    let cfg = config(
        local_profile("inv"),
        Some(reviewer("rev-local", false, true)),
    );
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
    let cfg = config(
        local_profile("inv"),
        Some(reviewer("rev-local", false, false)),
    );
    let (has_runtime, degradation) = resolve(&cfg, &secrets, MultiModelMode::Review, None).await;
    assert!(has_runtime, "a permitted local reviewer builds a runtime");
    assert!(degradation.is_none());

    // A measured-qualified reviewer with require_qualified also runs.
    let cfg = config(
        local_profile("inv"),
        Some(reviewer("rev-local", false, true)),
    );
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
    let cfg = config(
        remote_profile("inv"),
        Some(reviewer("rev-remote", false, false)),
    );
    let (_has, degradation) = resolve(&cfg, &secrets, MultiModelMode::Review, None).await;
    // Policy reason, never a provider/connect error — proves the gate ran first.
    assert_eq!(
        degradation,
        Some(DegradationReason::ReviewerEgressNotAcknowledged)
    );
}
