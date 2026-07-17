//! LLM provider profile model (no network).
//!
//! # Adding a provider kind
//! Adding a generic kind = edit [`ProviderKind`] + [`descriptor_for`] +
//! [`crate::research::backend_for`], nothing else. Hosts must not grow new
//! per-kind if-chains (see #122).

use serde::{Deserialize, Serialize};

/// Wire protocol kind for a profile.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ProviderKind {
    /// Local Ollama HTTP API.
    #[default]
    Ollama,
    /// OpenAI-compatible `/v1/chat/completions` (generic gateways).
    OpenAiCompatible,
    /// Anthropic Messages API.
    Anthropic,
    /// Grok Build / xAI session path (opt-in; Phase 2+).
    XaiGrokBuild,
}

/// Static metadata for a [`ProviderKind`] (ids, labels, defaults).
///
/// Exhaustive via [`descriptor_for`]: a new enum variant fails to compile
/// until a row is added here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProviderDescriptor {
    /// Stable profile id slug used for keychain refs (e.g. `ollama-local`).
    pub profile_id_slug: &'static str,
    /// Default human label for a new profile of this kind.
    pub default_label: &'static str,
    /// Group label for model-picker UI.
    pub group_label: &'static str,
    /// Whether chat requires an API key (or session credential) in secure storage.
    pub needs_api_key: bool,
    /// Prefer local-only / loopback defaults.
    pub is_local: bool,
    /// Default base URL when the user leaves the field empty.
    pub default_base_url: Option<&'static str>,
}

/// Return the descriptor for `kind`.
///
/// Adding a generic kind = edit the enum + this table + `backend_for`, nothing else.
pub fn descriptor_for(kind: ProviderKind) -> ProviderDescriptor {
    match kind {
        ProviderKind::Ollama => ProviderDescriptor {
            profile_id_slug: "ollama-local",
            default_label: "Ollama (local)",
            group_label: "Ollama",
            needs_api_key: false,
            is_local: true,
            default_base_url: Some("http://127.0.0.1:11434"),
        },
        ProviderKind::OpenAiCompatible => ProviderDescriptor {
            profile_id_slug: "openai-compatible",
            default_label: "OpenAI-compatible gateway",
            group_label: "OpenAI-compatible",
            needs_api_key: true,
            is_local: false,
            default_base_url: None,
        },
        ProviderKind::Anthropic => ProviderDescriptor {
            profile_id_slug: "anthropic",
            default_label: "Anthropic",
            group_label: "Anthropic",
            needs_api_key: true,
            is_local: false,
            default_base_url: Some("https://api.anthropic.com"),
        },
        ProviderKind::XaiGrokBuild => ProviderDescriptor {
            profile_id_slug: "xai-grok-build",
            default_label: "Grok Build session",
            group_label: "Grok Build",
            needs_api_key: true,
            is_local: false,
            default_base_url: Some("https://api.x.ai/v1"),
        },
    }
}

/// All known kinds (for registry completeness tests).
pub fn all_provider_kinds() -> &'static [ProviderKind] {
    &[
        ProviderKind::Ollama,
        ProviderKind::OpenAiCompatible,
        ProviderKind::Anthropic,
        ProviderKind::XaiGrokBuild,
    ]
}

/// Capability flags discovered or assumed for a profile.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct ProviderCapabilities {
    /// Native tool calling likely available.
    pub tools: bool,
    /// SSE / stream supported.
    pub stream: bool,
    /// Embeddings available on this profile (or embed override).
    pub embeddings: bool,
}

/// Named provider profile (secrets stored as keychain refs, not inline).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderProfile {
    /// Stable id (uuid or slug).
    pub id: String,
    /// Human label.
    pub label: String,
    /// Protocol kind.
    pub kind: ProviderKind,
    /// Base URL (no secrets). Empty for some session-based kinds.
    pub base_url: String,
    /// Keychain reference id (not the secret).
    pub api_key_ref: Option<String>,
    /// Chat model id.
    pub chat_model: String,
    /// Embedding model id if any.
    pub embedding_model: Option<String>,
    /// Optional separate embed base URL.
    pub embedding_base_url: Option<String>,
    /// Capabilities.
    pub capabilities: ProviderCapabilities,
    /// When true, refuse remote non-loopback bases.
    #[serde(default)]
    pub local_only: bool,
}

impl ProviderProfile {
    /// Create a local Ollama default profile.
    pub fn ollama_local() -> Self {
        Self {
            id: "ollama-local".into(),
            label: "Ollama (local)".into(),
            kind: ProviderKind::Ollama,
            base_url: "http://127.0.0.1:11434".into(),
            api_key_ref: None,
            chat_model: "mistral".into(),
            embedding_model: Some("nomic-embed-text".into()),
            embedding_base_url: None,
            capabilities: ProviderCapabilities {
                tools: true,
                stream: true,
                embeddings: true,
            },
            local_only: true,
        }
    }
}

/// Collection of profiles plus active selection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct ProviderConfig {
    /// Active profile id.
    pub active_id: Option<String>,
    /// Saved profiles.
    pub profiles: Vec<ProviderProfile>,
}

impl ProviderConfig {
    /// Default config with local Ollama candidate.
    pub fn with_local_ollama() -> Self {
        let p = ProviderProfile::ollama_local();
        Self {
            active_id: Some(p.id.clone()),
            profiles: vec![p],
        }
    }

    /// Resolve active profile.
    pub fn active(&self) -> Option<&ProviderProfile> {
        let id = self.active_id.as_deref()?;
        self.profiles.iter().find(|p| p.id == id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_ollama_active() {
        let cfg = ProviderConfig::with_local_ollama();
        let p = cfg.active().expect("active");
        assert_eq!(p.kind, ProviderKind::Ollama);
        assert!(p.local_only);
        assert!(p.api_key_ref.is_none());
    }

    #[test]
    fn profile_roundtrip_json() {
        let cfg = ProviderConfig::with_local_ollama();
        let s = serde_json::to_string_pretty(&cfg).unwrap();
        assert!(!s.contains("sk-"));
        let back: ProviderConfig = serde_json::from_str(&s).unwrap();
        assert_eq!(back.profiles.len(), 1);
    }

    #[test]
    fn descriptor_covers_every_provider_kind() {
        for kind in all_provider_kinds() {
            let d = descriptor_for(*kind);
            assert!(!d.profile_id_slug.is_empty(), "{kind:?}");
            assert!(!d.default_label.is_empty(), "{kind:?}");
            assert!(!d.group_label.is_empty(), "{kind:?}");
        }
        // Exhaustive: every variant appears in all_provider_kinds (compile-checked via match).
        let _ = descriptor_for(ProviderKind::Ollama);
        let _ = descriptor_for(ProviderKind::OpenAiCompatible);
        let _ = descriptor_for(ProviderKind::Anthropic);
        let _ = descriptor_for(ProviderKind::XaiGrokBuild);
        assert_eq!(all_provider_kinds().len(), 4);
        assert!(descriptor_for(ProviderKind::Anthropic).needs_api_key);
        assert!(!descriptor_for(ProviderKind::Ollama).needs_api_key);
        assert_eq!(
            descriptor_for(ProviderKind::Anthropic).default_base_url,
            Some("https://api.anthropic.com")
        );
    }
}
