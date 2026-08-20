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

/// Live provider probe plus the complete model ids returned by its catalog.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderCatalogProbe {
    /// Reachability/auth verdict.
    pub outcome: ProbeOutcome,
    /// Sorted, de-duplicated provider model ids. Empty when discovery failed.
    pub model_ids: Vec<String>,
    /// Effective API base selected by discovery, when known.
    pub effective_base_url: String,
}

/// Live probe for a profile (host-invoked only — not called from default unit tests).
///
/// Uses models-list / health endpoints with bounded timeouts via existing clients.
///
/// Policy matches [`crate::research::backend_for`]: user-configured remote bases may
/// resolve to private/corp DNS (same trust as chat). Model-driven tools stay SSRF-pinned.
pub async fn probe_provider(
    profile: &crate::providers::ProviderProfile,
    api_key: Option<String>,
) -> ProbeOutcome {
    probe_provider_catalog(profile, api_key).await.outcome
}

/// Probe reachability and return the catalog obtained by the same request.
/// Callers can persist a secret-free inventory fingerprint without making a
/// second network request or resolving the credential again.
pub async fn probe_provider_catalog(
    profile: &crate::providers::ProviderProfile,
    api_key: Option<String>,
) -> ProviderCatalogProbe {
    let policy = if profile.local_only {
        crate::ssrf::SsrfPolicy::local_only()
    } else {
        crate::ssrf::SsrfPolicy::allow_private_networks()
    };

    match profile.kind {
        ProviderKind::Ollama => {
            let listed =
                match crate::chat::OllamaClient::new(&profile.base_url, &profile.chat_model) {
                    Ok(client) => client.list_tags().await.ok(),
                    Err(_) => None,
                };
            match listed {
                Some(mut model_ids) => {
                    model_ids.sort();
                    model_ids.dedup();
                    ProviderCatalogProbe {
                        outcome: ProbeOutcome::Reachable {
                            reason: format!("Ollama models list ok ({} model(s))", model_ids.len()),
                        },
                        model_ids,
                        effective_base_url: profile.base_url.clone(),
                    }
                }
                None if ollama_reachable(&profile.base_url).await => ProviderCatalogProbe {
                    outcome: ProbeOutcome::Reachable {
                        reason: "Ollama health check passed, but its model catalog was unavailable"
                            .into(),
                    },
                    model_ids: Vec::new(),
                    effective_base_url: profile.base_url.clone(),
                },
                None => ProviderCatalogProbe {
                    outcome: ProbeOutcome::Unreachable {
                        reason: format!("Ollama not reachable at {}", profile.base_url),
                    },
                    model_ids: Vec::new(),
                    effective_base_url: profile.base_url.clone(),
                },
            }
        }
        // Prefer TriageTool-parity multi-path probe (plain HTTP, no SSRF pin) so preflight
        // matches Discover / list_models_for_draft for corporate gateways.
        ProviderKind::OpenAiCompatible | ProviderKind::Anthropic => {
            if profile.kind == ProviderKind::OpenAiCompatible
                && is_vercel_ai_gateway(&profile.base_url)
            {
                return probe_vercel_catalog(api_key.as_deref()).await;
            }
            let result =
                crate::ai_probe::probe_ai_gateway(&profile.base_url, api_key.as_deref(), false)
                    .await;
            if result.ok {
                let mut model_ids = result
                    .models
                    .iter()
                    .map(|model| model.id.clone())
                    .collect::<Vec<_>>();
                if model_ids.is_empty() {
                    model_ids.extend(result.chat_candidates.iter().map(|model| model.id.clone()));
                    model_ids.extend(result.embed_candidates.iter().map(|model| model.id.clone()));
                }
                model_ids.sort();
                model_ids.dedup();
                let n = model_ids.len();
                let path = if result.effective_base_url.is_empty() {
                    profile.base_url.clone()
                } else {
                    result.effective_base_url.clone()
                };
                return ProviderCatalogProbe {
                    outcome: ProbeOutcome::Reachable {
                        reason: format!("models list ok ({n} model(s) via {path})"),
                    },
                    model_ids,
                    effective_base_url: path,
                };
            }
            let err_blob = result.errors.join("; ");
            let note_blob = result.notes.join(" ");
            let combined = format!("{err_blob} {note_blob}").to_lowercase();
            if ai_probe_reports_auth_failure(&combined) {
                ProviderCatalogProbe {
                    outcome: ProbeOutcome::KeyRejected {
                        reason: if err_blob.is_empty() {
                            "credentials rejected or missing".into()
                        } else {
                            err_blob.chars().take(180).collect()
                        },
                    },
                    model_ids: Vec::new(),
                    effective_base_url: profile.base_url.clone(),
                }
            } else {
                let reason = if !err_blob.is_empty() {
                    err_blob.chars().take(180).collect()
                } else if !note_blob.is_empty() {
                    note_blob.chars().take(180).collect()
                } else {
                    "gateway probe failed".into()
                };
                ProviderCatalogProbe {
                    outcome: ProbeOutcome::Unreachable { reason },
                    model_ids: Vec::new(),
                    effective_base_url: profile.base_url.clone(),
                }
            }
        }
        ProviderKind::XaiGrokBuild => {
            // Session-based: presence + base allowlist; optional models list if session loads.
            if crate::grok_auth::detect_grok_session().is_none() {
                return ProviderCatalogProbe {
                    outcome: ProbeOutcome::KeyRejected {
                        reason: "no Grok session file".into(),
                    },
                    model_ids: Vec::new(),
                    effective_base_url: profile.base_url.clone(),
                };
            }
            let base = if profile.base_url.trim().is_empty() {
                "https://api.x.ai/v1"
            } else {
                profile.base_url.trim()
            };
            if let Err(e) = crate::grok_auth::assert_grok_base_allowed(base) {
                return ProviderCatalogProbe {
                    outcome: ProbeOutcome::Unreachable {
                        reason: e.to_string(),
                    },
                    model_ids: Vec::new(),
                    effective_base_url: base.to_string(),
                };
            }
            match crate::grok_auth::load_grok_session_credentials() {
                Ok(creds) => {
                    let headers = creds.request_headers();
                    match crate::chat::OpenAiCompatibleClient::new(
                        base,
                        None,
                        &profile.chat_model,
                        &policy,
                    ) {
                        Ok(client) => {
                            let client = client.with_extra_headers(headers);
                            match client.list_models().await {
                                Ok(mut model_ids) => {
                                    model_ids.sort();
                                    model_ids.dedup();
                                    ProviderCatalogProbe {
                                        outcome: ProbeOutcome::Reachable {
                                            reason: format!(
                                                "Grok models list ok ({} model(s))",
                                                model_ids.len()
                                            ),
                                        },
                                        model_ids,
                                        effective_base_url: base.to_string(),
                                    }
                                }
                                Err(e) => ProviderCatalogProbe {
                                    outcome: classify_list_err(&e.to_string()),
                                    model_ids: Vec::new(),
                                    effective_base_url: base.to_string(),
                                },
                            }
                        }
                        Err(e) => ProviderCatalogProbe {
                            outcome: ProbeOutcome::Unreachable {
                                reason: e.to_string(),
                            },
                            model_ids: Vec::new(),
                            effective_base_url: base.to_string(),
                        },
                    }
                }
                Err(e) => ProviderCatalogProbe {
                    outcome: ProbeOutcome::KeyRejected {
                        reason: e.to_string(),
                    },
                    model_ids: Vec::new(),
                    effective_base_url: base.to_string(),
                },
            }
        }
    }
}

/// Whether a configured base belongs to the public Vercel AI Gateway.
pub fn is_vercel_ai_gateway(base_url: &str) -> bool {
    reqwest::Url::parse(base_url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_string))
        .is_some_and(|host| host == "ai-gateway.vercel.sh")
}

async fn probe_vercel_catalog(api_key: Option<&str>) -> ProviderCatalogProbe {
    let endpoint = "https://ai-gateway.vercel.sh/v4/ai/config";
    let client = match crate::ssrf::build_pinned_client_for_url(
        endpoint,
        &crate::ssrf::SsrfPolicy::default(),
        &crate::ssrf::SystemResolver,
        std::time::Duration::from_secs(15),
    ) {
        Ok((_, client)) => client,
        Err(error) => {
            return ProviderCatalogProbe {
                outcome: ProbeOutcome::Unreachable {
                    reason: error.to_string(),
                },
                model_ids: Vec::new(),
                effective_base_url: "https://ai-gateway.vercel.sh/v4/ai".into(),
            };
        }
    };
    let mut request = client
        .get(endpoint)
        .header("ai-gateway-protocol-version", "0.0.1")
        .header("ai-gateway-auth-method", "api-key");
    if let Some(key) = api_key {
        request = request.bearer_auth(key);
    }
    let response = match request.send().await {
        Ok(response) => response,
        Err(error) => {
            return ProviderCatalogProbe {
                outcome: ProbeOutcome::Unreachable {
                    reason: error.to_string(),
                },
                model_ids: Vec::new(),
                effective_base_url: "https://ai-gateway.vercel.sh/v4/ai".into(),
            };
        }
    };
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        return ProviderCatalogProbe {
            outcome: classify_probe_http_status(status),
            model_ids: Vec::new(),
            effective_base_url: "https://ai-gateway.vercel.sh/v4/ai".into(),
        };
    }
    let value: serde_json::Value = match response.json().await {
        Ok(value) => value,
        Err(error) => {
            return ProviderCatalogProbe {
                outcome: ProbeOutcome::Unreachable {
                    reason: format!("Vercel model catalog response: {error}"),
                },
                model_ids: Vec::new(),
                effective_base_url: "https://ai-gateway.vercel.sh/v4/ai".into(),
            };
        }
    };
    let mut model_ids = value
        .get("models")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|row| row.get("id").and_then(serde_json::Value::as_str))
        .map(str::to_string)
        .collect::<Vec<_>>();
    model_ids.sort();
    model_ids.dedup();
    let outcome = if model_ids.is_empty() {
        ProbeOutcome::Unreachable {
            reason: "Vercel model catalog was empty or malformed".into(),
        }
    } else {
        ProbeOutcome::Reachable {
            reason: format!("Vercel v4 catalog ok ({} model(s))", model_ids.len()),
        }
    };
    ProviderCatalogProbe {
        outcome,
        model_ids,
        effective_base_url: "https://ai-gateway.vercel.sh/v4/ai".into(),
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

fn ai_probe_reports_auth_failure(message: &str) -> bool {
    let lower = message.to_lowercase();
    lower.contains("auth failed")
        || lower.contains("no api key")
        || lower.contains("http 401")
        || lower.contains("http 403")
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

        assert!(ai_probe_reports_auth_failure(
            "https://gateway.example/v1/models: HTTP 403"
        ));
        assert!(!ai_probe_reports_auth_failure(
            "http://127.1:64030/v1/models: HTTP 429 rate limited"
        ));
    }
}
