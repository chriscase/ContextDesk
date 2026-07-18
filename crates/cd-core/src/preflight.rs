//! Environment preflight checks (structured for Settings UI).
//!
//! Network probes are optional hooks; pure checks run offline in CI.

use crate::config::ConfluenceSettings;
use crate::providers::{ProviderConfig, ProviderKind};
use crate::workspace::Workspace;
use serde::{Deserialize, Serialize};
use std::path::Path;

/// Severity of a preflight row.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PreflightLevel {
    /// Healthy.
    Pass,
    /// Usable but degraded.
    Warn,
    /// Blocking for happy path (UI may still allow continue).
    Fail,
}

/// One preflight result row for the UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PreflightItem {
    /// Stable id (`workspace.roots`, `provider.ollama`, …).
    pub id: String,
    /// Short title.
    pub title: String,
    /// Pass / warn / fail.
    pub level: PreflightLevel,
    /// User-facing detail (no secrets).
    pub detail: String,
    /// Optional settings section to open (`workspace`, `ai`, `general`).
    pub fix_action: Option<String>,
}

/// Full preflight report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PreflightReport {
    /// Individual checks.
    pub items: Vec<PreflightItem>,
    /// True if any Fail.
    pub has_blocking: bool,
}

impl PreflightReport {
    /// Summarize from items.
    pub fn from_items(items: Vec<PreflightItem>) -> Self {
        let has_blocking = items.iter().any(|i| i.level == PreflightLevel::Fail);
        Self {
            items,
            has_blocking,
        }
    }
}

/// Inputs for a local (no-network) preflight pass.
#[derive(Debug, Clone)]
pub struct PreflightInput<'a> {
    /// Active workspace if any.
    pub workspace: Option<&'a Workspace>,
    /// Provider config.
    pub providers: &'a ProviderConfig,
    /// Whether config/data directory is writable (host supplies).
    pub data_dir_writable: bool,
    /// Host-reported: Ollama TCP reachable (optional).
    pub ollama_reachable: Option<bool>,
    /// Host-reported: active provider probe ok (optional).
    pub provider_reachable: Option<bool>,
    /// Host-reported: keychain has key for active profile when required.
    pub active_key_present: Option<bool>,
    /// Confluence settings (optional connector).
    pub confluence: Option<&'a ConfluenceSettings>,
    /// Host-reported: Confluence PAT present in keychain.
    pub confluence_pat_present: Option<bool>,
    /// Host-reported: Grok Build session *presence* only (never the secret).
    pub grok_session_present: Option<bool>,
}

/// Run offline + host-supplied reachability checks.
pub fn run_preflight(input: PreflightInput<'_>) -> PreflightReport {
    let mut items = Vec::new();

    items.push(if input.data_dir_writable {
        PreflightItem {
            id: "app.data_dir".into(),
            title: "App data directory".into(),
            level: PreflightLevel::Pass,
            detail: "Configuration directory is writable.".into(),
            fix_action: None,
        }
    } else {
        PreflightItem {
            id: "app.data_dir".into(),
            title: "App data directory".into(),
            level: PreflightLevel::Fail,
            detail: "Cannot write app data. Check disk permissions.".into(),
            fix_action: Some("general".into()),
        }
    });

    match input.workspace {
        None => items.push(PreflightItem {
            id: "workspace.missing".into(),
            title: "Workspace".into(),
            level: PreflightLevel::Fail,
            detail: "No workspace open. Accept the OS default (Documents/<product>) on Preflight, or add a folder in Workspace settings.".into(),
            fix_action: Some("workspace".into()),
        }),
        Some(ws) if ws.roots.is_empty() => items.push(PreflightItem {
            id: "workspace.roots".into(),
            title: "Workspace roots".into(),
            level: PreflightLevel::Fail,
            detail: "No allowlisted folders. Accept the OS default (Documents/<product>) on Preflight, or pick folders in Workspace settings.".into(),
            fix_action: Some("workspace".into()),
        }),
        Some(ws) => {
            let missing: Vec<_> = ws
                .roots
                .iter()
                .filter(|r| !Path::new(r).exists())
                .map(|r| r.display().to_string())
                .collect();
            if missing.is_empty() {
                items.push(PreflightItem {
                    id: "workspace.roots".into(),
                    title: "Workspace roots".into(),
                    level: PreflightLevel::Pass,
                    detail: format!("{} root(s) configured for “{}”.", ws.roots.len(), ws.name),
                    fix_action: Some("workspace".into()),
                });
            } else {
                items.push(PreflightItem {
                    id: "workspace.roots".into(),
                    title: "Workspace roots".into(),
                    level: PreflightLevel::Fail,
                    detail: format!("Missing path(s): {}", missing.join(", ")),
                    fix_action: Some("workspace".into()),
                });
            }
        }
    }

    match input.providers.active() {
        None => items.push(PreflightItem {
            id: "provider.active".into(),
            title: "AI provider".into(),
            level: PreflightLevel::Fail,
            detail: "No active model profile. Choose or create one in Settings.".into(),
            fix_action: Some("ai".into()),
        }),
        Some(p) => {
            items.push(PreflightItem {
                id: "provider.active".into(),
                title: "AI provider".into(),
                level: PreflightLevel::Pass,
                detail: format!("Active profile “{}” ({:?}).", p.label, p.kind),
                fix_action: Some("ai".into()),
            });

            if p.chat_model.trim().is_empty() {
                items.push(PreflightItem {
                    id: "provider.model".into(),
                    title: "Chat model".into(),
                    level: PreflightLevel::Fail,
                    detail: "Chat model id is empty.".into(),
                    fix_action: Some("ai".into()),
                });
            } else {
                items.push(PreflightItem {
                    id: "provider.model".into(),
                    title: "Chat model".into(),
                    level: PreflightLevel::Pass,
                    detail: format!("Model: {}", p.chat_model),
                    fix_action: Some("ai".into()),
                });
            }

            let needs_key = crate::providers::descriptor_for(p.kind).needs_api_key;
            if needs_key {
                match input.active_key_present {
                    Some(true) => items.push(PreflightItem {
                        id: "provider.key".into(),
                        title: "API credentials".into(),
                        level: PreflightLevel::Pass,
                        detail: "Credential present in secure storage.".into(),
                        fix_action: Some("ai".into()),
                    }),
                    Some(false) => items.push(PreflightItem {
                        id: "provider.key".into(),
                        title: "API credentials".into(),
                        level: PreflightLevel::Fail,
                        detail: "No API key in secure storage for this profile.".into(),
                        fix_action: Some("ai".into()),
                    }),
                    None => items.push(PreflightItem {
                        id: "provider.key".into(),
                        title: "API credentials".into(),
                        level: PreflightLevel::Warn,
                        detail: "Key presence not checked yet.".into(),
                        fix_action: Some("ai".into()),
                    }),
                }
            }

            if p.kind == ProviderKind::Ollama {
                match input.ollama_reachable {
                    Some(true) => items.push(PreflightItem {
                        id: "provider.ollama".into(),
                        title: "Ollama".into(),
                        level: PreflightLevel::Pass,
                        detail: format!("Reachable at {}.", p.base_url),
                        fix_action: Some("ai".into()),
                    }),
                    Some(false) => items.push(PreflightItem {
                        id: "provider.ollama".into(),
                        title: "Ollama".into(),
                        level: PreflightLevel::Fail,
                        detail: "Ollama not reachable. Start Ollama or change provider.".into(),
                        fix_action: Some("ai".into()),
                    }),
                    None => items.push(PreflightItem {
                        id: "provider.ollama".into(),
                        title: "Ollama".into(),
                        level: PreflightLevel::Warn,
                        detail: "Reachability not probed yet.".into(),
                        fix_action: Some("ai".into()),
                    }),
                }
            }

            // #121: Anthropic is wired; key check above covers credentials.

            // Remote kinds (OpenAI-compatible, Anthropic, …) — only report "responded"
            // when the host supplied a real probe result (`provider_reachable`), never
            // for a structural URL-shape check alone (#126).
            let remote_probe_kinds = matches!(
                p.kind,
                ProviderKind::OpenAiCompatible | ProviderKind::Anthropic
            );
            if remote_probe_kinds {
                match input.provider_reachable {
                    Some(true) => items.push(PreflightItem {
                        id: "provider.remote".into(),
                        title: "Provider endpoint".into(),
                        level: PreflightLevel::Pass,
                        detail: "Live probe succeeded (models/health HTTP ok).".into(),
                        fix_action: Some("ai".into()),
                    }),
                    Some(false) => items.push(PreflightItem {
                        id: "provider.remote".into(),
                        title: "Provider endpoint".into(),
                        level: PreflightLevel::Fail,
                        detail: "Live probe failed — check URL, key, and network.".into(),
                        fix_action: Some("ai".into()),
                    }),
                    None => items.push(PreflightItem {
                        id: "provider.remote".into(),
                        title: "Provider endpoint".into(),
                        level: PreflightLevel::Warn,
                        detail: "Not live-tested yet — use Test connection in Settings (URL shape alone is not a probe)."
                            .into(),
                        fix_action: Some("ai".into()),
                    }),
                }
            }
        }
    }

    // Embed path health when chat base ≠ embed base (optional profile fields).
    if let Some(p) = input.providers.active() {
        if let Some(embed_base) = p.embedding_base_url.as_ref() {
            let embed = embed_base.trim();
            let chat = p.base_url.trim().trim_end_matches('/');
            if !embed.is_empty() && embed.trim_end_matches('/') != chat {
                // Structural check only — host may add reachability later.
                if embed.starts_with("http://") || embed.starts_with("https://") {
                    items.push(PreflightItem {
                        id: "provider.embed".into(),
                        title: "Embeddings endpoint".into(),
                        level: PreflightLevel::Pass,
                        detail: format!("Separate embed base configured (chat ≠ embed): {embed}"),
                        fix_action: Some("ai".into()),
                    });
                } else {
                    items.push(PreflightItem {
                        id: "provider.embed".into(),
                        title: "Embeddings endpoint".into(),
                        level: PreflightLevel::Warn,
                        detail: "Embedding base URL is set but not a valid http(s) URL.".into(),
                        fix_action: Some("ai".into()),
                    });
                }
            }
        } else if p.embedding_model.is_some() {
            items.push(PreflightItem {
                id: "provider.embed".into(),
                title: "Embeddings endpoint".into(),
                level: PreflightLevel::Pass,
                detail: "Embed model uses the same base as chat (no separate embed URL).".into(),
                fix_action: Some("ai".into()),
            });
        }
    }

    // Optional: Grok session *presence* only (never auto-uses credentials).
    if let Some(present) = input.grok_session_present {
        items.push(if present {
            PreflightItem {
                id: "provider.grok_session".into(),
                title: "Grok Build session".into(),
                level: PreflightLevel::Pass,
                detail: "Local session material detected (opt-in use only; not auto-enabled)."
                    .into(),
                fix_action: Some("ai".into()),
            }
        } else {
            PreflightItem {
                id: "provider.grok_session".into(),
                title: "Grok Build session".into(),
                level: PreflightLevel::Warn,
                detail: "No local Grok session file detected (optional).".into(),
                fix_action: Some("ai".into()),
            }
        });
    }

    // Confluence (optional — never blocking for core chat)
    if let Some(cf) = input.confluence {
        if cf.enabled {
            if cf.base_url.trim().is_empty() {
                items.push(PreflightItem {
                    id: "confluence.url".into(),
                    title: "Confluence base URL".into(),
                    level: PreflightLevel::Warn,
                    detail: "Confluence is enabled but base URL is empty.".into(),
                    fix_action: Some("connectors".into()),
                });
            } else {
                items.push(PreflightItem {
                    id: "confluence.url".into(),
                    title: "Confluence base URL".into(),
                    level: PreflightLevel::Pass,
                    detail: format!("Base URL: {}", cf.base_url.trim()),
                    fix_action: Some("connectors".into()),
                });
            }
            match input.confluence_pat_present {
                Some(true) => items.push(PreflightItem {
                    id: "confluence.pat".into(),
                    title: "Confluence token".into(),
                    level: PreflightLevel::Pass,
                    detail: "Personal access token present in secure storage.".into(),
                    fix_action: Some("connectors".into()),
                }),
                Some(false) => items.push(PreflightItem {
                    id: "confluence.pat".into(),
                    title: "Confluence token".into(),
                    level: PreflightLevel::Warn,
                    detail: "No token in keychain — paste a PAT in Settings → Connectors.".into(),
                    fix_action: Some("connectors".into()),
                }),
                None => items.push(PreflightItem {
                    id: "confluence.pat".into(),
                    title: "Confluence token".into(),
                    level: PreflightLevel::Warn,
                    detail: "Token presence not checked yet.".into(),
                    fix_action: Some("connectors".into()),
                }),
            }
            if cf.spaces.is_empty() {
                items.push(PreflightItem {
                    id: "confluence.spaces".into(),
                    title: "Confluence spaces".into(),
                    level: PreflightLevel::Warn,
                    detail: "No space allowlist — consider restricting to known keys.".into(),
                    fix_action: Some("connectors".into()),
                });
            }
        }
    }

    PreflightReport::from_items(items)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::ProviderConfig;
    use crate::workspace::Workspace;
    use std::path::PathBuf;

    #[test]
    fn fails_without_workspace() {
        let providers = ProviderConfig::with_local_ollama();
        let report = run_preflight(PreflightInput {
            workspace: None,
            providers: &providers,
            data_dir_writable: true,
            ollama_reachable: Some(true),
            provider_reachable: None,
            active_key_present: None,
            confluence: None,
            confluence_pat_present: None,
            grok_session_present: None,
        });
        assert!(report.has_blocking);
        assert!(report
            .items
            .iter()
            .any(|i| i.id == "workspace.missing" && i.level == PreflightLevel::Fail));
    }

    #[test]
    fn passes_happy_local_path() {
        let root = std::env::temp_dir();
        let ws = Workspace::new("t", vec![PathBuf::from(&root)]);
        let providers = ProviderConfig::with_local_ollama();
        let report = run_preflight(PreflightInput {
            workspace: Some(&ws),
            providers: &providers,
            data_dir_writable: true,
            ollama_reachable: Some(true),
            provider_reachable: None,
            active_key_present: None,
            confluence: None,
            confluence_pat_present: None,
            grok_session_present: Some(false),
        });
        assert!(!report.has_blocking);
        assert!(report
            .items
            .iter()
            .any(|i| i.id == "provider.grok_session" && i.level == PreflightLevel::Warn));
    }

    #[test]
    fn confluence_warns_when_enabled_without_token() {
        use crate::config::ConfluenceSettings;
        let root = std::env::temp_dir();
        let ws = Workspace::new("t", vec![PathBuf::from(&root)]);
        let providers = ProviderConfig::with_local_ollama();
        let cf = ConfluenceSettings {
            enabled: true,
            base_url: "https://wiki.example.com".into(),
            spaces: vec!["ENG".into()],
            pat_ref: None,
        };
        let report = run_preflight(PreflightInput {
            workspace: Some(&ws),
            providers: &providers,
            data_dir_writable: true,
            ollama_reachable: Some(true),
            provider_reachable: None,
            active_key_present: None,
            confluence: Some(&cf),
            confluence_pat_present: Some(false),
            grok_session_present: None,
        });
        assert!(!report.has_blocking);
        assert!(report
            .items
            .iter()
            .any(|i| { i.id == "confluence.pat" && i.level == PreflightLevel::Warn }));
    }

    #[test]
    fn embed_separate_base_reported() {
        let root = std::env::temp_dir();
        let ws = Workspace::new("t", vec![PathBuf::from(&root)]);
        let mut providers = ProviderConfig::with_local_ollama();
        providers.profiles[0].embedding_model = Some("nomic".into());
        providers.profiles[0].embedding_base_url = Some("http://127.0.0.1:8080".into());
        let report = run_preflight(PreflightInput {
            workspace: Some(&ws),
            providers: &providers,
            data_dir_writable: true,
            ollama_reachable: Some(true),
            provider_reachable: None,
            active_key_present: None,
            confluence: None,
            confluence_pat_present: None,
            grok_session_present: None,
        });
        assert!(report
            .items
            .iter()
            .any(|i| i.id == "provider.embed" && i.level == PreflightLevel::Pass));
    }
}
