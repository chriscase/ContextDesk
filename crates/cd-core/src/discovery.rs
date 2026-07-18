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

/// Result of a provider reachability probe (#126). Secret-free.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProbeOutcome {
    /// HTTP success (e.g. 200 on models list / health).
    Reachable {
        /// Short human reason (no secrets).
        reason: String,
    },
    /// Auth rejected (401/403).
    KeyRejected {
        /// Short human reason.
        reason: String,
    },
    /// Network or other failure.
    Unreachable {
        /// Short human reason.
        reason: String,
    },
}

impl ProbeOutcome {
    /// Whether the endpoint is considered up for preflight `provider_reachable`.
    pub fn is_reachable(&self) -> bool {
        matches!(self, ProbeOutcome::Reachable { .. })
    }
}

/// Classify an HTTP status from a models/health probe (pure, offline-testable).
pub fn classify_probe_http_status(status: u16) -> ProbeOutcome {
    if (200..300).contains(&status) {
        ProbeOutcome::Reachable {
            reason: format!("HTTP {status}"),
        }
    } else if status == 401 || status == 403 {
        ProbeOutcome::KeyRejected {
            reason: format!("credentials rejected (HTTP {status})"),
        }
    } else {
        ProbeOutcome::Unreachable {
            reason: format!("HTTP {status}"),
        }
    }
}

/// Live probe for a profile (host-invoked only — not called from default unit tests).
///
/// Uses models-list / health endpoints with bounded timeouts via existing clients.
pub async fn probe_provider(
    profile: &crate::providers::ProviderProfile,
    api_key: Option<String>,
) -> ProbeOutcome {
    let policy = if profile.local_only {
        crate::ssrf::SsrfPolicy::local_only()
    } else {
        crate::ssrf::SsrfPolicy::default()
    };

    match profile.kind {
        ProviderKind::Ollama => {
            if ollama_reachable(&profile.base_url).await {
                ProbeOutcome::Reachable {
                    reason: "Ollama health ok".into(),
                }
            } else {
                ProbeOutcome::Unreachable {
                    reason: format!("Ollama not reachable at {}", profile.base_url),
                }
            }
        }
        ProviderKind::OpenAiCompatible => {
            match crate::chat::OpenAiCompatibleClient::new(
                &profile.base_url,
                api_key,
                &profile.chat_model,
                &policy,
            ) {
                Ok(client) => match client.list_models().await {
                    Ok(_) => ProbeOutcome::Reachable {
                        reason: "models list ok".into(),
                    },
                    Err(e) => classify_list_err(&e.to_string()),
                },
                Err(e) => ProbeOutcome::Unreachable {
                    reason: e.to_string(),
                },
            }
        }
        ProviderKind::Anthropic => {
            match crate::chat::AnthropicClient::new(
                &profile.base_url,
                api_key,
                &profile.chat_model,
                &policy,
            ) {
                Ok(client) => match client.list_models().await {
                    Ok(_) => ProbeOutcome::Reachable {
                        reason: "Anthropic models list ok".into(),
                    },
                    Err(e) => classify_list_err(&e.to_string()),
                },
                Err(e) => ProbeOutcome::Unreachable {
                    reason: e.to_string(),
                },
            }
        }
        ProviderKind::XaiGrokBuild => {
            // Session-based: presence + base allowlist; optional models list if session loads.
            if crate::grok_auth::detect_grok_session().is_none() {
                return ProbeOutcome::KeyRejected {
                    reason: "no Grok session file".into(),
                };
            }
            let base = if profile.base_url.trim().is_empty() {
                "https://api.x.ai/v1"
            } else {
                profile.base_url.trim()
            };
            if let Err(e) = crate::grok_auth::assert_grok_base_allowed(base) {
                return ProbeOutcome::Unreachable {
                    reason: e.to_string(),
                };
            }
            match crate::grok_auth::load_grok_session_credentials() {
                Ok(creds) => {
                    let headers = creds.request_headers();
                    match crate::chat::OpenAiCompatibleClient::new(
                        base,
                        None,
                        &profile.chat_model,
                        &crate::ssrf::SsrfPolicy::default(),
                    ) {
                        Ok(client) => {
                            let client = client.with_extra_headers(headers);
                            match client.list_models().await {
                                Ok(_) => ProbeOutcome::Reachable {
                                    reason: "Grok models list ok".into(),
                                },
                                Err(e) => classify_list_err(&e.to_string()),
                            }
                        }
                        Err(e) => ProbeOutcome::Unreachable {
                            reason: e.to_string(),
                        },
                    }
                }
                Err(e) => ProbeOutcome::KeyRejected {
                    reason: e.to_string(),
                },
            }
        }
    }
}

fn classify_list_err(msg: &str) -> ProbeOutcome {
    let lower = msg.to_lowercase();
    // Prefer status codes embedded in client errors ("HTTP 401", "models HTTP 403").
    for code in [401u16, 403, 404, 429, 500, 502, 503] {
        if lower.contains(&format!(" {code}"))
            || lower.contains(&format!("http {code}"))
            || lower.contains(&format!("/{code}"))
        {
            return classify_probe_http_status(code);
        }
    }
    if lower.contains("401") || lower.contains("unauthorized") || lower.contains("forbidden") {
        return ProbeOutcome::KeyRejected {
            reason: "credentials rejected".into(),
        };
    }
    ProbeOutcome::Unreachable {
        reason: msg.chars().take(160).collect(),
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

    #[test]
    fn classify_probe_status_offline() {
        assert!(matches!(
            classify_probe_http_status(200),
            ProbeOutcome::Reachable { .. }
        ));
        assert!(matches!(
            classify_probe_http_status(401),
            ProbeOutcome::KeyRejected { .. }
        ));
        assert!(matches!(
            classify_probe_http_status(403),
            ProbeOutcome::KeyRejected { .. }
        ));
        assert!(matches!(
            classify_probe_http_status(500),
            ProbeOutcome::Unreachable { .. }
        ));
        let r = classify_list_err("anthropic models HTTP 401");
        assert!(matches!(r, ProbeOutcome::KeyRejected { .. }), "{r:?}");
        let r2 = classify_list_err("connection refused");
        assert!(matches!(r2, ProbeOutcome::Unreachable { .. }), "{r2:?}");
    }
}
