//! Local AI candidate discovery (no secrets loaded until opt-in).

use crate::providers::ProviderKind;
use serde::{Deserialize, Serialize};

/// A discovered local candidate for Settings UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalCandidate {
    /// Stable id.
    pub id: String,
    /// Display label.
    pub label: String,
    /// Provider kind.
    pub kind: ProviderKind,
    /// Suggested base URL if any.
    pub base_url: Option<String>,
    /// True if credentials appear available (not the secret).
    pub credentials_present: bool,
    /// Notes for UI.
    pub notes: Vec<String>,
}

/// Discover candidates on this machine.
pub fn discover_local() -> Vec<LocalCandidate> {
    let mut out = Vec::new();

    // Ollama default
    out.push(LocalCandidate {
        id: "ollama-local".into(),
        label: "Ollama (local)".into(),
        kind: ProviderKind::Ollama,
        base_url: Some("http://127.0.0.1:11434".into()),
        credentials_present: false,
        notes: vec!["Default local runtime".into()],
    });

    // Env
    if std::env::var("XAI_API_KEY")
        .ok()
        .filter(|s| !s.is_empty())
        .is_some()
    {
        out.push(LocalCandidate {
            id: "env-xai".into(),
            label: "xAI API key (environment)".into(),
            kind: ProviderKind::OpenAiCompatible,
            base_url: Some(
                std::env::var("XAI_API_BASE").unwrap_or_else(|_| "https://api.x.ai/v1".into()),
            ),
            credentials_present: true,
            notes: vec!["XAI_API_KEY is set".into()],
        });
    }
    if std::env::var("OPENAI_API_KEY")
        .ok()
        .filter(|s| !s.is_empty())
        .is_some()
        || std::env::var("AI_API_KEY")
            .ok()
            .filter(|s| !s.is_empty())
            .is_some()
    {
        let base = std::env::var("OPENAI_BASE_URL")
            .or_else(|_| std::env::var("AI_BASE_URL"))
            .ok();
        out.push(LocalCandidate {
            id: "env-openai".into(),
            label: "OpenAI-compatible (environment)".into(),
            kind: ProviderKind::OpenAiCompatible,
            base_url: base,
            credentials_present: true,
            notes: vec!["API key found in environment".into()],
        });
    }

    // Grok Build session — Use requires explicit opt-in in Settings (never auto-active).
    if let Some(home) = dirs::home_dir() {
        let auth = home.join(".grok").join("auth.json");
        if auth.is_file() {
            out.push(LocalCandidate {
                id: "grok-build-session".into(),
                label: "Grok Build session".into(),
                kind: ProviderKind::XaiGrokBuild,
                base_url: Some("https://api.x.ai/v1".into()),
                credentials_present: true,
                notes: vec![
                    "Click Use to opt in — tokens stay in ~/.grok/auth.json".into(),
                    auth_display(&auth),
                ],
            });
        }
    }

    out
}

fn auth_display(path: &std::path::Path) -> String {
    format!("Detected {}", path.display())
}

/// Probe Ollama reachability (async).
pub async fn ollama_reachable(base_url: &str) -> bool {
    match crate::chat::OllamaClient::new(base_url, "mistral") {
        Ok(c) => c.health().await,
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn always_offers_ollama() {
        let c = discover_local();
        assert!(c.iter().any(|x| x.id == "ollama-local"));
    }
}
