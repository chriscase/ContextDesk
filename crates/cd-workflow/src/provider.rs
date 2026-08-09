//! Provider profile resolution and turn-input assembly.
//!
//! Profile/model selection and deadline shaping are pure over `cd_core` types.
//! Turn-input resolvers additionally receive an explicit host-owned
//! [`SecretStore`]; they never open a socket or disk and never retain provider
//! credentials beyond the caller-owned turn cache. Extracted from logic that
//! previously lived only inside the Tauri
//! `agent_turn` command (`provider_profile_for_turn`,
//! `model_tools_disabled_reason` / `model_tools_enabled`) — both the Tauri
//! adapter and the CLI now call these instead of each carrying their own
//! copy.

use cd_core::config::AppConfig;
use cd_core::keychain_store::SecretStore;
use cd_core::model_curation::model_selection_key;
use cd_core::providers::ProviderProfile;
use cd_core::router::TurnDeadlinePlan;
use std::collections::HashMap;
use std::sync::Mutex;

/// Ephemeral provider-credential cache for one admitted turn.
///
/// The cache deliberately accepts a [`ProviderProfile`], rather than an
/// arbitrary secret reference: only that profile's recorded `api_key_ref` can
/// be cached. Hosts create this after connector/host setup and discard it when
/// the turn ends, so connector credentials retain their independent lifecycle
/// and no secret is retained process-wide.
pub struct TurnProviderCredentialCache<'a> {
    secrets: &'a dyn SecretStore,
    values: Mutex<HashMap<String, Option<String>>>,
}

impl<'a> TurnProviderCredentialCache<'a> {
    /// Create an empty cache for one admitted chat turn.
    pub fn new(secrets: &'a dyn SecretStore) -> Self {
        Self {
            secrets,
            values: Mutex::new(HashMap::new()),
        }
    }

    /// Resolve one provider profile's configured credential at most once.
    ///
    /// This deliberately preserves the existing fail-closed-to-keyless
    /// behavior for secret-store failures: callers receive `None`, but a
    /// repeated primary/reviewer resolution cannot retrigger an interactive
    /// secret-store request during the same turn.
    fn api_key_for_provider_profile(&self, profile: &ProviderProfile) -> Option<String> {
        let reference = profile.api_key_ref.as_deref()?;
        // A poisoned cache must fail closed without consulting the secret
        // store again. The turn will surface the same keyless/provider
        // failure shape as an ordinary secret-store error.
        let mut values = self.values.lock().ok()?;
        if let Some(value) = values.get(reference) {
            return value.clone();
        }
        let value = self.secrets.get(reference).ok().flatten();
        values.insert(reference.to_string(), value.clone());
        value
    }
}

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
    let profile = resolve_provider_profile(cfg, explicit_profile_id)?;
    let api_key = provider_api_key(secrets, &profile);
    Ok(resolve_turn_inputs_from_profile_with_api_key(
        cfg,
        profile,
        chat_model_override,
        api_key,
    ))
}

/// Resolve primary turn inputs through one turn-scoped provider-only cache.
///
/// The same cache must be handed to reviewer resolution for this turn so a
/// shared primary/reviewer provider reference is read from the OS store once.
pub fn resolve_turn_inputs_with_credential_cache(
    credentials: &TurnProviderCredentialCache<'_>,
    cfg: &AppConfig,
    explicit_profile_id: Option<&str>,
    chat_model_override: Option<&str>,
) -> Result<ResolvedTurnInputs, String> {
    let profile = resolve_provider_profile(cfg, explicit_profile_id)?;
    Ok(resolve_turn_inputs_from_profile_with_credential_cache(
        credentials,
        cfg,
        profile,
        chat_model_override,
    ))
}

/// The same override/capabilities/api-key/deadline-plan sequence as
/// [`resolve_turn_inputs`], but over an **already-resolved** profile instead
/// of re-resolving one from `explicit_profile_id`.
///
/// Exists for callers that need their own profile-resolution error shape —
/// Tauri's `agent_turn` resolves via `provider_profile_for_turn` first so it
/// can build a `provider_profile_unavailable` terminal event carrying the
/// exact missing profile id, then needs exactly this remaining sequence.
/// Infallible: an already-resolved profile can't fail to resolve again, and
/// this deliberately accepts a profile that no longer appears in
/// `cfg.providers.profiles` (e.g. one resolved from a config snapshot taken
/// a moment earlier) without erroring — re-resolution is the caller's job,
/// already done.
pub fn resolve_turn_inputs_from_profile(
    secrets: &dyn SecretStore,
    cfg: &AppConfig,
    profile: ProviderProfile,
    chat_model_override: Option<&str>,
) -> ResolvedTurnInputs {
    let api_key = provider_api_key(secrets, &profile);
    resolve_turn_inputs_from_profile_with_api_key(cfg, profile, chat_model_override, api_key)
}

/// Resolve already-selected provider inputs through one turn-scoped,
/// provider-only credential cache.
pub fn resolve_turn_inputs_from_profile_with_credential_cache(
    credentials: &TurnProviderCredentialCache<'_>,
    cfg: &AppConfig,
    profile: ProviderProfile,
    chat_model_override: Option<&str>,
) -> ResolvedTurnInputs {
    let api_key = credentials.api_key_for_provider_profile(&profile);
    resolve_turn_inputs_from_profile_with_api_key(cfg, profile, chat_model_override, api_key)
}

fn provider_api_key(secrets: &dyn SecretStore, profile: &ProviderProfile) -> Option<String> {
    profile
        .api_key_ref
        .as_ref()
        .and_then(|reference| secrets.get(reference).ok().flatten())
}

fn resolve_turn_inputs_from_profile_with_api_key(
    cfg: &AppConfig,
    mut profile: ProviderProfile,
    chat_model_override: Option<&str>,
    api_key: Option<String>,
) -> ResolvedTurnInputs {
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

    let deadline_plan = TurnDeadlinePlan::for_profile(&cfg.router, &profile);

    ResolvedTurnInputs {
        profile,
        api_key,
        deadline_plan,
    }
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

    // -----------------------------------------------------------------
    // Fail-first characterization for `resolve_turn_inputs_from_profile`
    // (#chat-tracing / Tauri kernel-sharing migration).
    //
    // `agent_turn` (desktop/src-tauri/src/lib.rs) resolves a profile through
    // its OWN error-shaped `provider_profile_for_turn` first (so it can build
    // a "provider_profile_unavailable" terminal event carrying the exact
    // missing profile id), then needs the SAME override/capabilities/
    // api_key/deadline_plan sequence `resolve_turn_inputs` already performs
    // — but `resolve_turn_inputs` re-resolves the profile itself and can't
    // take an already-resolved one. These tests pin the exact behavior the
    // infallible variant must have BEFORE it exists, so the Tauri migration
    // has a proven-equivalent function to call instead of its own ~25-line
    // inline duplicate.
    // -----------------------------------------------------------------

    #[test]
    fn from_profile_matches_resolve_turn_inputs_for_every_precedence_case() {
        let mut cfg = cfg_with_ollama();
        cfg.default_chat_model = Some("mistral".to_string());
        let base_profile = resolve_provider_profile(&cfg, None).expect("active profile");

        for (chat_model_override, expected_model) in [
            (Some("qwen2.5"), "qwen2.5"),
            (Some("  "), "mistral"), // whitespace-only override must fall through
            (None, "mistral"),
        ] {
            let via_resolve = resolve_turn_inputs(&NoSecrets, &cfg, None, chat_model_override)
                .expect("resolve_turn_inputs");
            let via_from_profile = resolve_turn_inputs_from_profile(
                &NoSecrets,
                &cfg,
                base_profile.clone(),
                chat_model_override,
            );
            assert_eq!(via_from_profile.profile.chat_model, expected_model);
            assert_eq!(
                via_from_profile.profile.chat_model,
                via_resolve.profile.chat_model
            );
            assert_eq!(
                via_from_profile.profile.capabilities.tools,
                via_resolve.profile.capabilities.tools
            );
            assert_eq!(via_from_profile.api_key, via_resolve.api_key);
        }
    }

    #[test]
    fn from_profile_recomputes_tools_enabled_for_the_new_model_not_the_old_one() {
        // Adversarial: switching models must re-evaluate model_tools_enabled
        // against the NEW model id, not carry over whatever the caller's
        // already-resolved profile happened to have — a provider/model
        // switch must never leave stale tools-capability state behind.
        let mut cfg = cfg_with_ollama();
        let profile = cfg.providers.profiles[0].clone();
        let mut overrides = HashMap::new();
        overrides.insert(model_selection_key(&profile.id, "llama3"), false);
        cfg.model_tools_enabled = overrides;

        let resolved =
            resolve_turn_inputs_from_profile(&NoSecrets, &cfg, profile.clone(), Some("llama3"));
        assert!(
            !resolved.profile.capabilities.tools,
            "llama3 was learned-rejected and must stay tools-disabled"
        );

        let resolved = resolve_turn_inputs_from_profile(&NoSecrets, &cfg, profile, Some("mistral"));
        assert!(
            resolved.profile.capabilities.tools,
            "switching to mistral must re-enable tools, not inherit llama3's rejection"
        );
    }

    #[test]
    fn from_profile_never_re_resolves_or_can_fail_on_a_stale_profile_id() {
        // The whole point of the `_from_profile` variant: it must accept a
        // profile that no longer appears in `cfg.providers.profiles` (e.g.
        // one resolved a moment earlier from a config snapshot that has
        // since been edited) without erroring, since re-resolution is
        // exactly what the caller already did with its own error handling.
        let cfg = cfg_with_ollama();
        let mut vanished = cfg.providers.profiles[0].clone();
        vanished.id = "a-profile-id-not-in-cfg".to_string();
        let resolved = resolve_turn_inputs_from_profile(&NoSecrets, &cfg, vanished.clone(), None);
        assert_eq!(resolved.profile.id, "a-profile-id-not-in-cfg");
    }

    /// Tauri's `agent_turn` used to accept "a bare model id or a
    /// provider::model selection key" for its per-chat model override
    /// (`parse_selection_key(m)`, a thin wrapper over the same
    /// `cd_core::model_curation::parse_model_selection_key` this function
    /// calls) — pickers persist the CANONICAL v1-encoded selection key (see
    /// `model_selection_key`'s own doc: "New writes always use v1"), not the
    /// legacy bare `provider::model` string the other tests in this module
    /// exercise. Proves `resolve_turn_inputs_from_profile` unwraps that
    /// exact canonical key back down to the bare model id — not left as the
    /// full scoped string — AND that the tools-capability lookup afterward
    /// keys off that correctly-extracted model id, not the raw override
    /// text: a learned tools-rejection recorded for "qwen2.5" only takes
    /// effect if the resolved `chat_model` field really is "qwen2.5".
    #[test]
    fn from_profile_unwraps_a_canonical_selection_key_and_keys_the_tools_lookup_off_it() {
        let mut cfg = cfg_with_ollama();
        let profile = cfg.providers.profiles[0].clone();
        let canonical_key = model_selection_key(&profile.id, "qwen2.5");
        // Canonical keys are prefixed/encoded, never equal to the bare model
        // id — otherwise this test could pass by accident even if
        // extraction were a no-op.
        assert_ne!(canonical_key, "qwen2.5");

        let mut overrides = HashMap::new();
        overrides.insert(model_selection_key(&profile.id, "qwen2.5"), false);
        cfg.model_tools_enabled = overrides;

        let resolved = resolve_turn_inputs_from_profile(
            &NoSecrets,
            &cfg,
            profile.clone(),
            Some(&canonical_key),
        );

        assert_eq!(
            resolved.profile.chat_model, "qwen2.5",
            "a canonical provider/model selection key must resolve to the bare \
             model id, not survive as the full scoped string"
        );
        assert!(
            !resolved.profile.capabilities.tools,
            "the tools-capability lookup must key off the extracted model id \
             (\"qwen2.5\") to find this learned rejection — if extraction left \
             the scoped key in chat_model instead, the lookup would miss and \
             tools would incorrectly stay enabled"
        );
    }
}
