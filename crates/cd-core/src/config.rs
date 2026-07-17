//! Persist non-secret app config under the user config dir.

use crate::branding::Branding;
use crate::error::{CoreError, CoreResult};
use crate::providers::ProviderConfig;
use crate::workspace::Workspace;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

/// On-disk application configuration (no raw API keys).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AppConfig {
    /// Provider profiles (keychain refs only).
    pub providers: ProviderConfig,
    /// Last workspace metadata (roots as strings).
    pub workspace: Option<WorkspaceConfig>,
    /// Theme id.
    #[serde(default = "default_theme")]
    pub theme: String,
    /// Skip first-run banner.
    #[serde(default)]
    pub setup_completed: bool,
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

/// Load config or default.
pub fn load_config(path: &Path) -> CoreResult<AppConfig> {
    if !path.exists() {
        return Ok(AppConfig::default());
    }
    let raw = fs::read_to_string(path)?;
    let cfg: AppConfig = serde_json::from_str(&raw)?;
    // Belt: ensure no accidental secret fields
    for p in &cfg.providers.profiles {
        if let Some(r) = &p.api_key_ref {
            if r.starts_with("sk-") || r.len() > 200 {
                return Err(CoreError::Config(
                    "refusing config that embeds raw secrets in api_key_ref".into(),
                ));
            }
        }
    }
    Ok(cfg)
}

/// Atomic-ish write of config.
pub fn save_config(path: &Path, cfg: &AppConfig) -> CoreResult<()> {
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
        save_config(&path, &cfg).unwrap();
        let loaded = load_config(&path).unwrap();
        assert_eq!(loaded.providers.active().unwrap().id, "ollama-local");
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains("sk-"));
    }
}
