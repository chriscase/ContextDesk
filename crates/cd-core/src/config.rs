//! Persist non-secret app config under the user config dir.

use crate::branding::Branding;
use crate::error::{CoreError, CoreResult};
use crate::providers::ProviderConfig;
use crate::workspace::Workspace;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

/// Stable keychain ref for Confluence personal access token (never the token itself).
pub const CONFLUENCE_PAT_REF: &str = "confluence/default/pat";

/// Confluence connector settings (token lives in keychain under [`CONFLUENCE_PAT_REF`]).
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct ConfluenceSettings {
    /// When false, connector is ignored.
    #[serde(default)]
    pub enabled: bool,
    /// Wiki base URL, e.g. `https://wiki.example.com` (no trailing path required).
    #[serde(default)]
    pub base_url: String,
    /// Space keys allowlist (empty = all spaces the token can see — prefer setting these).
    #[serde(default)]
    pub spaces: Vec<String>,
    /// Keychain reference id when a PAT has been saved (never the secret).
    #[serde(default)]
    pub pat_ref: Option<String>,
}

impl ConfluenceSettings {
    /// True when base URL is non-empty and looks configured.
    pub fn is_configured(&self) -> bool {
        self.enabled && !self.base_url.trim().is_empty()
    }

    /// Convert to runtime RO client config.
    pub fn to_ro_config(&self) -> crate::confluence_ro::ConfluenceRoConfig {
        crate::confluence_ro::ConfluenceRoConfig {
            base_url: self.base_url.trim().trim_end_matches('/').to_string(),
            spaces: self.spaces.clone(),
        }
    }
}

/// On-disk application configuration (no raw API keys / PATs).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AppConfig {
    /// Provider profiles (keychain refs only).
    pub providers: ProviderConfig,
    /// Last workspace metadata (roots as strings).
    pub workspace: Option<WorkspaceConfig>,
    /// Confluence read-only connector.
    #[serde(default)]
    pub confluence: ConfluenceSettings,
    /// Theme id.
    #[serde(default = "default_theme")]
    pub theme: String,
    /// Skip first-run banner.
    #[serde(default)]
    pub setup_completed: bool,
    /// Default chat model for new sessions (falls back to active profile model).
    #[serde(default)]
    pub default_chat_model: Option<String>,
    /// When true, agent may call `web_search` / `web_fetch` (open web; SSRF-gated).
    /// Default false — opt-in; no secrets required.
    #[serde(default)]
    pub web_research_enabled: bool,
    /// Per-publisher RSS enable flags (source id → enabled).
    /// Missing keys use each source's registry default (typically true).
    #[serde(default)]
    pub web_research_sources: std::collections::HashMap<String, bool>,
}

fn default_theme() -> String {
    "dark".into()
}

/// Serializable workspace.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceConfig {
    /// Id.
    pub id: String,
    /// Name.
    pub name: String,
    /// Allowlisted roots.
    pub roots: Vec<PathBuf>,
}

impl From<&Workspace> for WorkspaceConfig {
    fn from(w: &Workspace) -> Self {
        Self {
            id: w.id.clone(),
            name: w.name.clone(),
            roots: w.roots.clone(),
        }
    }
}

impl WorkspaceConfig {
    /// Convert to runtime workspace.
    pub fn into_workspace(self) -> Workspace {
        Workspace {
            id: self.id,
            name: self.name,
            roots: self.roots,
        }
    }
}

/// Resolve `~/<config_dir_name>/config.json`.
pub fn config_path(branding: &Branding) -> CoreResult<PathBuf> {
    let home = dirs::home_dir().ok_or_else(|| CoreError::Config("no home dir".into()))?;
    Ok(home.join(&branding.config_dir_name).join("config.json"))
}

/// Ensure config directory exists.
pub fn ensure_config_dir(branding: &Branding) -> CoreResult<PathBuf> {
    let home = dirs::home_dir().ok_or_else(|| CoreError::Config("no home dir".into()))?;
    let dir = home.join(&branding.config_dir_name);
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn refuse_raw_secret_refs(cfg: &AppConfig) -> CoreResult<()> {
    use crate::keychain_store::looks_like_raw_secret;
    for p in &cfg.providers.profiles {
        if let Some(r) = &p.api_key_ref {
            if looks_like_raw_secret(r) {
                return Err(CoreError::Config(
                    "refusing config that embeds raw secrets in api_key_ref".into(),
                ));
            }
        }
    }
    if let Some(r) = &cfg.confluence.pat_ref {
        if looks_like_raw_secret(r) || r.contains("ATATT") {
            return Err(CoreError::Config(
                "refusing config that embeds raw Confluence secrets in pat_ref".into(),
            ));
        }
    }
    Ok(())
}

/// Load config or default.
pub fn load_config(path: &Path) -> CoreResult<AppConfig> {
    if !path.exists() {
        return Ok(AppConfig::default());
    }
    let raw = fs::read_to_string(path)?;
    let cfg: AppConfig = serde_json::from_str(&raw)?;
    refuse_raw_secret_refs(&cfg)?;
    Ok(cfg)
}

/// Atomic-ish write of config.
pub fn save_config(path: &Path, cfg: &AppConfig) -> CoreResult<()> {
    refuse_raw_secret_refs(cfg)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let raw = serde_json::to_string_pretty(cfg)?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, raw)?;
    fs::rename(&tmp, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::ProviderConfig;
    use tempfile::tempdir;

    #[test]
    fn save_load_roundtrip() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.json");
        let mut cfg = AppConfig::default();
        cfg.providers = ProviderConfig::with_local_ollama();
        cfg.theme = "dark".into();
        cfg.confluence = ConfluenceSettings {
            enabled: true,
            base_url: "https://wiki.example.com".into(),
            spaces: vec!["ENG".into()],
            pat_ref: Some(CONFLUENCE_PAT_REF.into()),
        };
        cfg.web_research_enabled = true;
        save_config(&path, &cfg).unwrap();
        let loaded = load_config(&path).unwrap();
        assert_eq!(loaded.providers.active().unwrap().id, "ollama-local");
        assert!(loaded.confluence.is_configured());
        assert_eq!(loaded.confluence.spaces, vec!["ENG"]);
        assert!(loaded.web_research_enabled);
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains("sk-"));
        assert!(!text.contains("ATATT"));
        assert!(text.contains("wiki.example.com"));
        assert!(text.contains(CONFLUENCE_PAT_REF));
        assert!(text.contains("web_research_enabled"));
    }

    #[test]
    fn web_research_defaults_off() {
        let cfg = AppConfig::default();
        assert!(!cfg.web_research_enabled);
        // Missing field on disk → false
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.json");
        std::fs::write(&path, r#"{"providers":{"profiles":[],"active_id":null}}"#).unwrap();
        let loaded = load_config(&path).unwrap();
        assert!(!loaded.web_research_enabled);
    }

    #[test]
    fn confluence_not_configured_when_disabled() {
        let c = ConfluenceSettings {
            enabled: false,
            base_url: "https://wiki.example.com".into(),
            spaces: vec![],
            pat_ref: None,
        };
        assert!(!c.is_configured());
    }

    #[test]
    fn refuses_raw_secret_in_api_key_ref() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.json");
        let mut cfg = AppConfig::default();
        cfg.providers = ProviderConfig::with_local_ollama();
        cfg.providers.profiles[0].api_key_ref = Some("sk-proj-totally-a-secret".into());
        assert!(save_config(&path, &cfg).is_err());
        // Path-shaped refs are OK
        cfg.providers.profiles[0].api_key_ref = Some("provider/openai-compatible/api_key".into());
        assert!(save_config(&path, &cfg).is_ok());
    }
}
