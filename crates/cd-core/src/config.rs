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

/// Stable keychain ref for X (Twitter) API bearer token (never the token itself).
pub const X_API_KEY_REF: &str = "x/default/api_key";

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
    /// When true, register write tools (still HardWrite-gated). Default false. (#326)
    #[serde(default)]
    pub write_enabled: bool,
    /// Max pages per harvest Accept batch. Default 25. (#326)
    #[serde(default = "default_harvest_batch_max")]
    pub harvest_batch_max: u32,
    /// REST path layout. Default Standard (Server/DC). (#326)
    #[serde(default)]
    pub rest_path_mode: crate::confluence_ro::ConfluenceRestPathMode,
    /// Auth header mode. Default Bearer. (#326)
    #[serde(default)]
    pub auth_mode: ConfluenceAuthMode,
    /// Email for Basic auth (not secret); token still in keychain.
    #[serde(default)]
    pub basic_email: Option<String>,
    /// Web UI URL style when `_links.webui` missing. (#326)
    #[serde(default)]
    pub url_style: crate::confluence_ro::ConfluenceUrlStyle,
}

/// Confluence HTTP auth mode (credentials still in keychain for tokens).
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConfluenceAuthMode {
    /// `Authorization: Bearer {pat}` (Server/DC default).
    #[default]
    Bearer,
    /// `Authorization: Basic base64(email:token)` (typical Cloud).
    Basic,
}

fn default_harvest_batch_max() -> u32 {
    25
}

/// X (Twitter) search connector (bearer token in keychain under [`X_API_KEY_REF`]).
///
/// Not free RSS: search requires a paid/usable X API plan. When disabled or
/// missing a key, `x_search` is not registered for the agent.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct XSettings {
    /// When false, connector is ignored even if a key exists.
    #[serde(default)]
    pub enabled: bool,
    /// Keychain reference id when a bearer has been saved (never the secret).
    #[serde(default)]
    pub api_key_ref: Option<String>,
}

impl XSettings {
    /// True when enabled and a keychain ref is recorded (host still checks key presence).
    pub fn is_configured(&self) -> bool {
        self.enabled && self.api_key_ref.is_some()
    }
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
            rest_path_mode: self.rest_path_mode,
            url_style: self.url_style,
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
    /// X (Twitter) search connector (optional paid API key).
    #[serde(default)]
    pub x: XSettings,
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
    /// Retrieval / agent router budgets (enforced on the live turn path).
    #[serde(default)]
    pub router: crate::router::RouterBudget,
    /// Soft max files for indexing (default 100_000). Truncation is recorded, not silent.
    #[serde(default = "default_index_max_files")]
    pub index_max_files: usize,
    /// In-RAM working-set byte budget for the keyword index (default 256 MiB).
    /// The persistent store still holds every chunk on disk; this bounds resident
    /// memory by keeping the most-recently-modified files searchable. Capping is
    /// recorded (`KeywordIndex::is_bytes_capped`), never silent. `0` → default.
    #[serde(default = "default_index_max_bytes")]
    pub index_max_bytes: usize,
    /// Workspace connector registry entries (#127). No secrets — keychain refs only.
    #[serde(default)]
    pub connectors: Vec<crate::connectors::ConnectorConfig>,
    /// Opt-in hybrid retrieval for `search_kb` (#119). Default false — keyword-only path
    /// unchanged. When true, `search_kb` uses `KeywordIndex::search_hybrid` (keyword +
    /// recency + optional semantic when an embed backend is attached on the host).
    #[serde(default)]
    pub hybrid_retrieval: bool,
    /// Enabled external module ids (#136). Install is local-only (NON_GOALS #7).
    #[serde(default)]
    pub enabled_modules: Vec<String>,
    /// Opt-in module registry browse (#139). Default **false** — no fetch until enabled.
    ///
    /// Browse is metadata-only (NON_GOALS #7); never auto-installs.
    #[serde(default)]
    pub module_registry_enabled: bool,
    /// Registry index URL (http/https). **Empty by default** — no hardcoded company URL
    /// (AGENTS.md #2). Fetch is SSRF-gated when non-empty and enabled.
    #[serde(default)]
    pub module_registry_url: String,
    /// Durable memory + ambient recall settings (MEMORY.md §10 defaults).
    #[serde(default)]
    pub memory: crate::memory::MemoryConfig,
}

fn default_index_max_files() -> usize {
    100_000
}

fn default_index_max_bytes() -> usize {
    256 * 1024 * 1024
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
    if let Some(r) = &cfg.x.api_key_ref {
        if looks_like_raw_secret(r) {
            return Err(CoreError::Config(
                "refusing config that embeds raw X secrets in api_key_ref".into(),
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
        let cfg = AppConfig {
            providers: ProviderConfig::with_local_ollama(),
            theme: "dark".into(),
            confluence: ConfluenceSettings {
                enabled: true,
                base_url: "https://wiki.example.com".into(),
                spaces: vec!["ENG".into()],
                pat_ref: Some(CONFLUENCE_PAT_REF.into()),
                ..ConfluenceSettings::default()
            },
            web_research_enabled: true,
            x: XSettings {
                enabled: true,
                api_key_ref: Some(X_API_KEY_REF.into()),
            },
            connectors: vec![crate::connectors::ConnectorConfig {
                id: "files-main".into(),
                kind: "files".into(),
                enabled: true,
                settings: serde_json::json!({}),
            }],
            ..AppConfig::default()
        };
        save_config(&path, &cfg).unwrap();
        let loaded = load_config(&path).unwrap();
        assert_eq!(loaded.providers.active().unwrap().id, "ollama-local");
        assert!(loaded.confluence.is_configured());
        assert_eq!(loaded.confluence.spaces, vec!["ENG"]);
        assert!(loaded.web_research_enabled);
        assert!(loaded.x.is_configured());
        assert_eq!(loaded.connectors.len(), 1);
        assert_eq!(loaded.connectors[0].kind, "files");
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains("sk-"));
        assert!(!text.contains("ATATT"));
        assert!(text.contains("wiki.example.com"));
        assert!(text.contains(CONFLUENCE_PAT_REF));
        assert!(text.contains(X_API_KEY_REF));
        assert!(text.contains("web_research_enabled"));
        assert!(text.contains("files-main"));
    }

    #[test]
    fn x_defaults_off() {
        let cfg = AppConfig::default();
        assert!(!cfg.x.enabled);
        assert!(!cfg.x.is_configured());
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.json");
        std::fs::write(&path, r#"{"providers":{"profiles":[],"active_id":null}}"#).unwrap();
        let loaded = load_config(&path).unwrap();
        assert!(!loaded.x.enabled);
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
            ..ConfluenceSettings::default()
        };
        assert!(!c.is_configured());
    }

    #[test]
    fn refuses_raw_secret_in_api_key_ref() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.json");
        let mut providers = ProviderConfig::with_local_ollama();
        providers.profiles[0].api_key_ref = Some("sk-proj-totally-a-secret".into());
        let mut cfg = AppConfig {
            providers,
            ..AppConfig::default()
        };
        assert!(save_config(&path, &cfg).is_err());
        // Path-shaped refs are OK
        cfg.providers.profiles[0].api_key_ref = Some("provider/openai-compatible/api_key".into());
        assert!(save_config(&path, &cfg).is_ok());
    }
}
