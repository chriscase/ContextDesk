//! Provider profile resolution and turn-input assembly.
//!
//! Every function here is pure over `cd_core` types: it takes an
//! [`cd_core::config::AppConfig`] snapshot and a [`ProviderProfile`] set and
//! returns a decision, never touching the keychain, a socket, or disk itself.
//! Extracted from logic that previously lived only inside the Tauri
//! `agent_turn` command (`provider_profile_for_turn`,
//! `model_tools_disabled_reason` / `model_tools_enabled`) — both the Tauri
//! adapter and the CLI now call these instead of each carrying their own
//! copy.

use cd_core::config::AppConfig;
use cd_core::keychain_store::SecretStore;
use cd_core::model_curation::model_selection_key;
use cd_core::providers::ProviderProfile;
use cd_core::router::TurnDeadlinePlan;

/// Resolve which provider profile a turn should use.
///
/// An explicit, non-empty `explicit_profile_id` must name a profile that
/// exists — an id that no longer exists is a hard error (never a silent
/// fallback to another provider). With no explicit id, the active profile is
/// used, falling back to the local Ollama default when none is configured.
pub fn resolve_provider_profile(
    config: &AppConfig,
    explicit_profile_id: Option<&str>,
) -> Result<ProviderProfile, String> {
    let explicit_profile_id = explicit_profile_id
        .map(str::trim)
        .filter(|profile_id| !profile_id.is_empty());
    if let Some(profile_id) = explicit_profile_id {
        return config
            .providers
            .profiles
            .iter()
            .find(|profile| profile.id == profile_id)
            .cloned()
            .ok_or_else(|| profile_id.to_string());
    }
    Ok(config
        .providers
        .active()
        .cloned()
        .unwrap_or_else(ProviderProfile::ollama_local))
}

/// Why native tool calling is unavailable for one model, if it is.
///
/// `"profile"` means the provider profile itself has tools turned off — not
/// overridable per model. `"model"` means this exact model previously
/// rejected native tools and the learned override map remembers it — the
/// profile's tools stay enabled for its other models.
pub fn model_tools_disabled_reason(
    cfg: &AppConfig,
    profile: &ProviderProfile,
    model_id: &str,
) -> Option<&'static str> {
    if !profile.capabilities.tools {
        return Some("profile");
    }
    let canonical = model_selection_key(&profile.id, model_id);
    let legacy = format!("{}::{model_id}", profile.id);
    if cfg.model_tools_enabled.get(&canonical) == Some(&false)
        || cfg.model_tools_enabled.get(&legacy) == Some(&false)
    {
        return Some("model");
    }
    None
}

/// Whether native tool calling is available for one model.
pub fn model_tools_enabled(cfg: &AppConfig, profile: &ProviderProfile, model_id: &str) -> bool {
    model_tools_disabled_reason(cfg, profile, model_id).is_none()
}

/// Every input a provider turn needs, resolved once.
pub struct ResolvedTurnInputs {
    /// The profile to use, with `chat_model` and `capabilities.tools`
    /// already finalized against overrides.
    pub profile: ProviderProfile,
    /// Dereferenced API key, when the profile has one on file.
    pub api_key: Option<String>,
    /// Deadline plan derived from the router budget and this profile.
    pub deadline_plan: TurnDeadlinePlan,
}

/// Resolve profile, per-chat model override, tools-enabled flag, API key, and
/// deadline plan — the block of decisions every turn needs before a provider
/// round can start, previously scattered across ~30 lines of `agent_turn`.
///
/// `chat_model_override` wins first (an explicit per-chat model switch),
/// then `cfg.default_chat_model`, else the profile keeps its own model.
pub fn resolve_turn_inputs(
    secrets: &dyn SecretStore,
    cfg: &AppConfig,
    explicit_profile_id: Option<&str>,
    chat_model_override: Option<&str>,
) -> Result<ResolvedTurnInputs, String> {
    let mut profile = resolve_provider_profile(cfg, explicit_profile_id)?;

    if let Some(model) = chat_model_override
        .map(str::trim)
        .filter(|model| !model.is_empty())
    {
        let selection = cd_core::model_curation::parse_model_selection_key(model);
        profile.chat_model = selection.model_id;
    } else if let Some(model) = cfg
        .default_chat_model
        .as_deref()
        .map(str::trim)
        .filter(|model| !model.is_empty())
    {
        profile.chat_model = model.to_string();
    }

    profile.capabilities.tools = model_tools_enabled(cfg, &profile, &profile.chat_model);

    let api_key = profile
        .api_key_ref
        .as_ref()
        .and_then(|r| secrets.get(r).ok().flatten());
    let deadline_plan = TurnDeadlinePlan::for_profile(&cfg.router, &profile);

    Ok(ResolvedTurnInputs {
        profile,
        api_key,
        deadline_plan,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use cd_core::providers::ProviderConfig;
    use std::collections::HashMap;

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

    fn cfg_with_ollama() -> AppConfig {
        AppConfig {
            providers: ProviderConfig::with_local_ollama(),
            ..AppConfig::default()
        }
    }

    #[test]
    fn explicit_profile_id_must_exist_or_fail_closed() {
        let cfg = cfg_with_ollama();
        let err = resolve_provider_profile(&cfg, Some("does-not-exist")).unwrap_err();
        assert_eq!(err, "does-not-exist");
    }

    #[test]
    fn no_explicit_id_falls_back_to_active_then_ollama_local() {
        let cfg = cfg_with_ollama();
        let resolved = resolve_provider_profile(&cfg, None).expect("active profile");
        assert_eq!(resolved.id, cfg.providers.active().unwrap().id);

        let empty = AppConfig::default();
        let resolved = resolve_provider_profile(&empty, None).expect("ollama_local fallback");
        assert_eq!(resolved.id, ProviderProfile::ollama_local().id);
    }

    #[test]
    fn model_override_beats_default_beats_profile() {
        let mut cfg = cfg_with_ollama();
        cfg.default_chat_model = Some("mistral".to_string());
        let resolved =
            resolve_turn_inputs(&NoSecrets, &cfg, None, Some("qwen2.5")).expect("resolved");
        assert_eq!(resolved.profile.chat_model, "qwen2.5");

        let resolved = resolve_turn_inputs(&NoSecrets, &cfg, None, None).expect("resolved");
        assert_eq!(resolved.profile.chat_model, "mistral");
    }

    #[test]
    fn profile_level_tools_disable_cannot_be_overridden_per_model() {
        let mut cfg = cfg_with_ollama();
        cfg.providers.profiles[0].capabilities.tools = false;
        let resolved = resolve_turn_inputs(&NoSecrets, &cfg, None, None).expect("resolved");
        assert!(!resolved.profile.capabilities.tools);
    }

    #[test]
    fn a_model_specific_learned_rejection_disables_only_that_model() {
        let mut cfg = cfg_with_ollama();
        let profile = cfg.providers.profiles[0].clone();
        let mut overrides = HashMap::new();
        overrides.insert(model_selection_key(&profile.id, "llama3"), false);
        cfg.model_tools_enabled = overrides;

        assert!(!model_tools_enabled(&cfg, &profile, "llama3"));
        assert!(model_tools_enabled(&cfg, &profile, "mistral"));
    }
}
