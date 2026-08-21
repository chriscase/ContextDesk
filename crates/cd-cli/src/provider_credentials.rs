//! Mixed-provider credential isolation for the CLI secret adapter.
//!
//! `CONTEXTDESK_PROVIDER_API_KEY` is a process-wide value. Applying it to
//! every `provider/<profile>/api_key` reference would send one gateway
//! credential to another profile during a mixed live comparison. This module
//! binds that override to at most one selected keychain-style reference, or
//! rejects it when more than one credentialed profile participates.

use crate::envelope::{CliError, CliResult};
use cd_core::config::AppConfig;
use cd_core::keychain_store::FILE_SECRET_REF_PREFIX;
use cd_core::providers::ProviderProfile;
use cd_workflow::provider::resolve_provider_profile;

/// One participating credential owner: a provider profile or retrieval role.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CredentialedIdentity {
    /// Profile id or a stable retrieval-role label. Never a secret.
    pub id: String,
    /// Explicit `api_key_ref` from configuration. Never the secret bytes.
    pub api_key_ref: String,
}

impl CredentialedIdentity {
    fn from_profile(profile: &ProviderProfile) -> Option<Self> {
        let api_key_ref = profile.api_key_ref.as_deref()?.trim();
        if api_key_ref.is_empty() {
            return None;
        }
        Some(Self {
            id: profile.id.clone(),
            api_key_ref: api_key_ref.to_string(),
        })
    }
}

/// True for explicit Keychain-style provider refs the global override may bind.
pub fn is_provider_keychain_ref(reference: &str) -> bool {
    let reference = reference.trim();
    reference.starts_with("provider/") && !reference.starts_with(FILE_SECRET_REF_PREFIX)
}

/// Collect credentialed identities from already-resolved profiles.
pub fn identities_from_profiles<'a>(
    profiles: impl IntoIterator<Item = &'a ProviderProfile>,
) -> Vec<CredentialedIdentity> {
    let mut identities: Vec<CredentialedIdentity> = profiles
        .into_iter()
        .filter_map(CredentialedIdentity::from_profile)
        .collect();
    identities.sort_by(|a, b| a.id.cmp(&b.id));
    identities.dedup_by(|a, b| a.id == b.id && a.api_key_ref == b.api_key_ref);
    identities
}

/// Collect retrieval-role credential refs that a live probe/diagnose may read.
pub fn retrieval_role_identities(cfg: &AppConfig) -> Vec<CredentialedIdentity> {
    let mut identities = Vec::new();
    if let Some(role) = cfg.retrieval.embedding.as_ref().filter(|role| role.enabled) {
        if let Some(reference) = role
            .api_key_ref
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            identities.push(CredentialedIdentity {
                id: "retrieval.embedding".into(),
                api_key_ref: reference.to_string(),
            });
        }
    }
    if let Some(role) = cfg.retrieval.reranker.as_ref().filter(|role| role.enabled) {
        if let Some(reference) = role
            .api_key_ref
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            identities.push(CredentialedIdentity {
                id: "retrieval.reranker".into(),
                api_key_ref: reference.to_string(),
            });
        }
    }
    identities
}

/// Resolve participating provider profiles plus optional extras.
pub fn participating_profiles(
    cfg: &AppConfig,
    selected_profile_id: Option<&str>,
    extra_profile_ids: &[String],
    include_reviewer: bool,
) -> Vec<ProviderProfile> {
    let mut ids = extra_profile_ids.to_vec();
    if let Ok(profile) = resolve_provider_profile(cfg, selected_profile_id) {
        ids.push(profile.id);
    }
    if include_reviewer {
        if let Some(reviewer) = cfg.multi_model.reviewer.as_ref() {
            let id = reviewer.profile_id.trim();
            if !id.is_empty() {
                ids.push(id.to_string());
            }
        }
    }
    ids.sort();
    ids.dedup();
    cfg.providers
        .profiles
        .iter()
        .filter(|profile| ids.iter().any(|id| id == &profile.id))
        .cloned()
        .collect()
}

/// Bind or reject `CONTEXTDESK_PROVIDER_API_KEY` for this live operation.
///
/// Returns `Ok(Some(reference))` when the override may apply to that exact
/// keychain-style provider reference. `Ok(None)` means the override is unused
/// (unset, keyless, or a single protected-file profile). Mixed credentialed
/// identities fail closed without returning or echoing secret material.
pub fn bind_global_provider_override(
    env_override: Option<&str>,
    identities: &[CredentialedIdentity],
) -> CliResult<Option<String>> {
    let env_override = env_override
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let Some(_env) = env_override else {
        return Ok(None);
    };

    let mut unique_refs: Vec<&str> = identities
        .iter()
        .map(|identity| identity.api_key_ref.as_str())
        .collect();
    unique_refs.sort_unstable();
    unique_refs.dedup();

    if unique_refs.len() > 1 {
        let ids = identities
            .iter()
            .map(|identity| identity.id.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        return Err(mixed_provider_override_error(&ids));
    }

    let Some(reference) = unique_refs.first().copied() else {
        return Ok(None);
    };
    if reference.starts_with(FILE_SECRET_REF_PREFIX) {
        // Protected files are explicit per-profile credentials. The global
        // override must not replace them, even for a single-profile command.
        return Ok(None);
    }
    if !is_provider_keychain_ref(reference) {
        return Ok(None);
    }
    Ok(Some(reference.to_string()))
}

/// Operator-facing refusal. Profile ids are not secrets; secret bytes and
/// `file:` paths are omitted.
pub fn mixed_provider_override_error(profile_ids: &str) -> CliError {
    CliError::user(format!(
        "CONTEXTDESK_PROVIDER_API_KEY cannot be used for mixed-provider comparisons (profiles: {profile_ids}). Unset it and configure each selected profile with its own Keychain or protected-file reference."
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use cd_core::config::{
        MultiModelBudgetConfig, MultiModelSettings, RetrievalRoleModel, RetrievalSettings,
        ReviewerRoleConfig,
    };
    use cd_core::keychain_store::key_ref_for_profile;
    use cd_core::providers::{
        ProviderCapabilities, ProviderConfig, ProviderDeadlinePreference, ProviderKind,
    };

    fn remote_profile(id: &str, api_key_ref: Option<&str>) -> ProviderProfile {
        ProviderProfile {
            id: id.into(),
            label: id.into(),
            kind: ProviderKind::OpenAiCompatible,
            base_url: "https://gateway.example/v1".into(),
            api_key_ref: api_key_ref.map(str::to_string),
            chat_model: "synthetic-model".into(),
            embedding_model: None,
            embedding_base_url: None,
            capabilities: ProviderCapabilities {
                tools: true,
                stream: true,
                embeddings: false,
            },
            local_only: false,
            deadline_preference: ProviderDeadlinePreference::Auto,
        }
    }

    fn env_value() -> &'static str {
        "synthetic-shared-key-must-not-leak"
    }

    #[test]
    fn two_identities_sharing_one_reference_still_bind() {
        let employer = remote_profile("employer", Some("provider/employer/api_key"));
        let identities = vec![
            CredentialedIdentity::from_profile(&employer).unwrap(),
            CredentialedIdentity {
                id: "retrieval.embedding".into(),
                api_key_ref: "provider/employer/api_key".into(),
            },
        ];
        let bound = bind_global_provider_override(Some(env_value()), &identities).unwrap();
        assert_eq!(bound.as_deref(), Some("provider/employer/api_key"));
    }

    #[test]
    fn single_keychain_profile_binds_the_global_override() {
        let employer = remote_profile("employer", Some("provider/employer/api_key"));
        let identities = identities_from_profiles([&employer]);
        let bound = bind_global_provider_override(Some(env_value()), &identities).unwrap();
        assert_eq!(bound.as_deref(), Some("provider/employer/api_key"));
    }

    #[test]
    fn mixed_employer_and_vercel_profiles_reject_the_global_override() {
        let employer = remote_profile("employer", Some("provider/employer/api_key"));
        let vercel = remote_profile("vercel", Some("provider/vercel/api_key"));
        let identities = identities_from_profiles([&employer, &vercel]);
        let error = bind_global_provider_override(Some(env_value()), &identities).unwrap_err();
        let message = error.to_string();
        assert!(message.contains("mixed-provider"));
        assert!(message.contains("employer"));
        assert!(message.contains("vercel"));
        assert!(
            !message.contains(env_value()),
            "refusal must never echo the override value: {message}"
        );
        assert!(!message.contains("provider/employer/api_key") || message.contains("profiles:"));
    }

    #[test]
    fn unset_override_allows_mixed_profiles() {
        let employer = remote_profile("employer", Some("provider/employer/api_key"));
        let vercel = remote_profile("vercel", Some("provider/vercel/api_key"));
        let identities = identities_from_profiles([&employer, &vercel]);
        assert_eq!(
            bind_global_provider_override(None, &identities).unwrap(),
            None
        );
    }

    #[test]
    fn protected_file_profile_does_not_consume_the_global_override() {
        let vercel = remote_profile(
            "vercel",
            Some("file:/Users/demo/.contextdesk/credentials/vercel.key"),
        );
        let identities = identities_from_profiles([&vercel]);
        assert_eq!(
            bind_global_provider_override(Some(env_value()), &identities).unwrap(),
            None
        );
    }

    #[test]
    fn mixed_file_and_keychain_profiles_still_reject_the_override() {
        let employer = remote_profile("employer", Some("provider/employer/api_key"));
        let vercel = remote_profile(
            "vercel",
            Some("file:/Users/demo/.contextdesk/credentials/vercel.key"),
        );
        let identities = identities_from_profiles([&employer, &vercel]);
        let error = bind_global_provider_override(Some(env_value()), &identities).unwrap_err();
        assert!(!error.to_string().contains(env_value()));
        assert!(error.to_string().contains("mixed-provider"));
    }

    #[test]
    fn connector_and_file_refs_are_not_keychain_override_targets() {
        assert!(!is_provider_keychain_ref("connector/confluence/pat"));
        assert!(!is_provider_keychain_ref(
            "file:/Users/demo/.contextdesk/credentials/vercel.key"
        ));
        assert!(is_provider_keychain_ref(&key_ref_for_profile("vercel")));
    }

    #[test]
    fn participating_profiles_include_reviewer_when_requested() {
        let investigator = remote_profile("employer", Some("provider/employer/api_key"));
        let reviewer = remote_profile("vercel", Some("provider/vercel/api_key"));
        let cfg = AppConfig {
            providers: ProviderConfig {
                active_id: Some("employer".into()),
                profiles: vec![investigator, reviewer],
            },
            multi_model: MultiModelSettings {
                mode: cd_core::multi_model::MultiModelMode::Review,
                reviewer: Some(ReviewerRoleConfig {
                    profile_id: "vercel".into(),
                    model: None,
                    require_qualified: false,
                    allow_remote: true,
                }),
                budget: MultiModelBudgetConfig::default(),
            },
            ..AppConfig::default()
        };
        let selected_only = participating_profiles(&cfg, None, &[], false);
        assert_eq!(
            selected_only
                .iter()
                .map(|p| p.id.as_str())
                .collect::<Vec<_>>(),
            vec!["employer"]
        );
        let with_reviewer = participating_profiles(&cfg, None, &[], true);
        let ids: Vec<_> = with_reviewer.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids, vec!["employer", "vercel"]);
    }

    #[test]
    fn retrieval_roles_are_separate_credential_identities() {
        let cfg = AppConfig {
            retrieval: RetrievalSettings {
                embedding: Some(RetrievalRoleModel {
                    enabled: true,
                    base_url: "https://ai-gateway.vercel.sh/v1".into(),
                    model: "voyage-4".into(),
                    dialect: None,
                    allow_remote: true,
                    api_key_ref: Some("provider/vercel/api_key".into()),
                    embed_wire: Default::default(),
                    rerank_dialect: Default::default(),
                }),
                reranker: Some(RetrievalRoleModel {
                    enabled: true,
                    base_url: "https://gateway.example/v1".into(),
                    model: "rerank".into(),
                    dialect: None,
                    allow_remote: true,
                    api_key_ref: Some("provider/employer/api_key".into()),
                    embed_wire: Default::default(),
                    rerank_dialect: Default::default(),
                }),
            },
            ..AppConfig::default()
        };
        let identities = retrieval_role_identities(&cfg);
        let error = bind_global_provider_override(Some(env_value()), &identities).unwrap_err();
        assert!(error.to_string().contains("mixed-provider"));
        assert!(!error.to_string().contains(env_value()));
    }
}
