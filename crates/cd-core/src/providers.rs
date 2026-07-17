//! LLM provider profile model (no network).

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
    /// Anthropic Messages API (future).
    Anthropic,
    /// Grok Build / xAI session path (opt-in; Phase 2+).
    XaiGrokBuild,
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
}
