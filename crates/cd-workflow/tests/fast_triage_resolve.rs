//! Hermetic workflow gates for fast-triage runtime resolution and turn wiring.
//!
//! These tests never contact a provider. They prove that an enabled route is
//! resolved into the host-owned runtime, the disabled/default path stays
//! absent, and fast-triage resolution does not construct or read credentials
//! for an unrelated reviewer role.

use cd_core::agent::FastTriageRuntime;
use cd_core::config::{AppConfig, FastTriageSettings, MultiModelSettings, ReviewerRoleConfig};
use cd_core::fast_triage::{
    FastTriageRouteRecord, FastTriageRouteVerdict, FastTriageWorkflowContract,
};
use cd_core::keychain_store::SecretStore;
use cd_core::providers::{ProviderConfig, ProviderProfile};
use cd_workflow::fast_triage::{resolve_fast_triage_runtime, should_resolve_fast_triage};
use cd_workflow::provider::{
    resolve_turn_inputs_with_credential_cache, TurnProviderCredentialCache,
};
use cd_workflow::turn::TurnExecutionOptions;

fn local_profile(id: &str) -> ProviderProfile {
    let mut profile = ProviderProfile::ollama_local();
    profile.id = id.into();
    profile.chat_model = "m-primary".into();
    profile
}

fn route_record() -> FastTriageRouteRecord {
    FastTriageRouteRecord {
        profile_id: "primary".into(),
        model_id: "m-primary".into(),
        workflow_contract: FastTriageWorkflowContract::HostGroundedSynthesisCompletePacket,
        verdict: FastTriageRouteVerdict::Qualified,
        contract_fingerprint: "fixture-fingerprint".into(),
    }
}

fn config(enabled: bool) -> AppConfig {
    let primary = local_profile("primary");
    AppConfig {
        providers: ProviderConfig {
            active_id: Some(primary.id.clone()),
            profiles: vec![primary],
        },
        fast_triage: FastTriageSettings {
            enabled,
            routes: vec![route_record()],
            fallback: None,
        },
        ..AppConfig::default()
    }
}

#[derive(Default)]
struct PanicSecretStore;

impl SecretStore for PanicSecretStore {
    fn get(&self, reference: &str) -> cd_core::error::CoreResult<Option<String>> {
        panic!("unexpected credential read for {reference}")
    }

    fn set(&self, _reference: &str, _secret: &str) -> cd_core::error::CoreResult<()> {
        unreachable!("fast-triage resolution must not write credentials")
    }

    fn delete(&self, _reference: &str) -> cd_core::error::CoreResult<()> {
        unreachable!("fast-triage resolution must not delete credentials")
    }
}

#[tokio::test]
async fn enabled_route_resolves_a_runtime_with_exact_evidence() {
    let cfg = config(true);
    let secrets = PanicSecretStore;
    let credentials = TurnProviderCredentialCache::new(&secrets);
    let primary = resolve_turn_inputs_with_credential_cache(&credentials, &cfg, None, None)
        .expect("primary profile resolves without credentials");

    let resolved = resolve_fast_triage_runtime(&cfg, &credentials, &primary).await;
    let runtime = resolved.runtime.expect("enabled route should resolve");
    assert!(runtime.enabled);
    assert_eq!(runtime.records, vec![route_record()]);
    assert!(runtime.fallback.is_none());
    assert!(resolved.entry_degradation.is_none());
}

#[tokio::test]
async fn disabled_route_keeps_the_legacy_runtime_absent() {
    let cfg = config(false);
    let secrets = PanicSecretStore;
    let credentials = TurnProviderCredentialCache::new(&secrets);
    let primary = resolve_turn_inputs_with_credential_cache(&credentials, &cfg, None, None)
        .expect("primary profile resolves without credentials");

    let resolved = resolve_fast_triage_runtime(&cfg, &credentials, &primary).await;
    assert!(resolved.runtime.is_none());
    assert_eq!(
        resolved.entry_degradation,
        Some(cd_workflow::fast_triage::FastTriageEntryDegradation::RouteDisabled)
    );
}

#[tokio::test]
async fn enabled_without_route_evidence_degrades_before_core_entry() {
    let mut cfg = config(true);
    cfg.fast_triage.routes.clear();
    let secrets = PanicSecretStore;
    let credentials = TurnProviderCredentialCache::new(&secrets);
    let primary = resolve_turn_inputs_with_credential_cache(&credentials, &cfg, None, None)
        .expect("primary profile resolves without credentials");

    let resolved = resolve_fast_triage_runtime(&cfg, &credentials, &primary).await;
    assert!(resolved.runtime.is_none());
    assert_eq!(
        resolved.entry_degradation,
        Some(cd_workflow::fast_triage::FastTriageEntryDegradation::NoRouteEvidence)
    );
    let event = cd_workflow::fast_triage::entry_degradation_event(
        cd_workflow::fast_triage::FastTriageEntryDegradation::NoRouteEvidence,
    );
    assert!(matches!(
        event,
        cd_core::events::StreamEvent::MultiModelStage {
            stage,
            phase,
            status: Some(status),
            ..
        } if stage == "summary" && phase == "summary" && status == "no_route_evidence"
    ));
}

#[tokio::test]
async fn fast_resolution_does_not_build_or_read_an_unrelated_reviewer() {
    let mut cfg = config(true);
    let mut reviewer = local_profile("reviewer");
    reviewer.api_key_ref = Some("reviewer/secret".into());
    cfg.providers.profiles.push(reviewer);
    cfg.multi_model = MultiModelSettings {
        reviewer: Some(ReviewerRoleConfig {
            profile_id: "reviewer".into(),
            model: None,
            require_qualified: true,
            allow_remote: false,
        }),
        ..MultiModelSettings::default()
    };

    // If fast-triage resolution accidentally constructed the reviewer role,
    // this store would panic before any provider call could occur.
    let secrets = PanicSecretStore;
    let credentials = TurnProviderCredentialCache::new(&secrets);
    let primary = resolve_turn_inputs_with_credential_cache(&credentials, &cfg, None, None)
        .expect("primary profile resolves without credentials");
    let resolved = resolve_fast_triage_runtime(&cfg, &credentials, &primary).await;
    assert!(resolved.runtime.is_some());
}

#[test]
fn turn_options_keep_fast_triage_opt_in_and_reviewer_independent() {
    let legacy = TurnExecutionOptions::default();
    assert!(legacy.fast_triage.is_none());
    assert!(legacy.multi_model.is_none());

    let options = TurnExecutionOptions {
        fast_triage: Some(FastTriageRuntime {
            enabled: true,
            records: vec![route_record()],
            fallback: None,
            fallback_backend: None,
            budget: cd_core::fast_triage::FastTriageBudget::default(),
            neighborhood: cd_core::fast_triage::FastTriageNeighborhoodBudget::default(),
        }),
        ..TurnExecutionOptions::default()
    };
    assert!(options.fast_triage.is_some());
    assert!(options.multi_model.is_none());
}

#[test]
fn host_gate_skips_resolution_before_any_fallback_work_on_cancel() {
    assert!(!should_resolve_fast_triage(true, false, true));
}
