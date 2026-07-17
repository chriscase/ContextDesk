//! Environment preflight checks (structured for Settings UI).
//!
//! Network probes are optional hooks; pure checks run offline in CI.

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
            detail: "No workspace open. Add at least one folder root.".into(),
            fix_action: Some("workspace".into()),
        }),
        Some(ws) if ws.roots.is_empty() => items.push(PreflightItem {
            id: "workspace.roots".into(),
            title: "Workspace roots".into(),
            level: PreflightLevel::Fail,
            detail: "Workspace has no allowlisted folders.".into(),
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

            let needs_key = matches!(
                p.kind,
                ProviderKind::OpenAiCompatible
                    | ProviderKind::Anthropic
                    | ProviderKind::XaiGrokBuild
            );
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

            if matches!(
                p.kind,
                ProviderKind::OpenAiCompatible | ProviderKind::Anthropic
            ) {
                match input.provider_reachable {
                    Some(true) => items.push(PreflightItem {
                        id: "provider.remote".into(),
                        title: "Provider endpoint".into(),
                        level: PreflightLevel::Pass,
                        detail: "Endpoint responded successfully.".into(),
                        fix_action: Some("ai".into()),
                    }),
                    Some(false) => items.push(PreflightItem {
                        id: "provider.remote".into(),
                        title: "Provider endpoint".into(),
                        level: PreflightLevel::Fail,
                        detail: "Could not reach provider (check URL, key, network).".into(),
                        fix_action: Some("ai".into()),
                    }),
                    None => items.push(PreflightItem {
                        id: "provider.remote".into(),
                        title: "Provider endpoint".into(),
                        level: PreflightLevel::Warn,
                        detail: "Connection not tested yet. Use Test connection in Settings."
                            .into(),
                        fix_action: Some("ai".into()),
                    }),
                }
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
        });
        assert!(!report.has_blocking);
    }
}
