//! Host glue: the paths and constructors a headless CLI process needs to
//! call into `cd_core` / `cd_workflow` exactly the way the desktop app
//! does — same config file, same corpus cache, same sessions directory —
//! so state created in one host is immediately visible from the other.

use crate::envelope::{CliError, CliResult};
use cd_core::branding::Branding;
use cd_core::config::{config_path, ensure_config_dir, load_config, save_config, AppConfig};
use cd_core::error::CoreResult;
use cd_core::index::KeywordIndex;
use cd_core::keychain_store::{KeychainSecretStore, SecretStore};
use cd_core::sessions::SessionStore;
use cd_core::tool_host::ToolHost;
use cd_core::workspace::Workspace;
use std::path::{Path, PathBuf};

/// Every filesystem location this process needs, resolved once at startup.
pub struct Paths {
    pub config_dir: PathBuf,
    /// The SAME `AppConfig` file the desktop app reads and writes
    /// (`~/.contextdesk/config.json` by default) — provider profiles,
    /// the configured default timezone, and router budgets live there,
    /// once, for both hosts.
    pub app_config_path: PathBuf,
    /// Log corpus cache root — same layout desktop uses
    /// (`<config_dir>/cache`), so a corpus imported from either host is
    /// visible from the other.
    pub cache_root: PathBuf,
    /// Durable chat session store — same layout desktop uses
    /// (`<config_dir>/sessions`).
    pub sessions_dir: PathBuf,
    /// This CLI's own "current corpus / current session" pointer
    /// (`cd_workflow::session::CliState`) — the one piece of state that is
    /// legitimately CLI-only, since a GUI window already has its own live
    /// notion of "what's open."
    pub cli_state_dir: PathBuf,
    /// True when `config_dir` came from an explicit `--data-dir` /
    /// `--profile-dir` override rather than the default, desktop-shared
    /// `~/.contextdesk`. Isolated state never touches `$HOME` — a broken or
    /// absent `$HOME` cannot affect an isolated profile.
    pub isolated: bool,
}

impl Paths {
    /// Resolve every state location for this process.
    ///
    /// `data_dir_override` (`--data-dir` / `--profile-dir`), when given,
    /// bypasses `dirs::home_dir()` entirely — `config_dir` becomes exactly
    /// this directory (created if absent), and every derived path is a
    /// plain join under it. This is what makes isolation deterministic,
    /// cross-platform, and testable without ever overriding `HOME`: two
    /// processes given two different `--data-dir` values cannot observe or
    /// mutate each other's state no matter what `$HOME` resolves to.
    ///
    /// `app_config_override` (`--app-config`) still wins over either
    /// default when given, isolated or not.
    pub fn resolve(
        data_dir_override: Option<&std::path::Path>,
        app_config_override: Option<&std::path::Path>,
    ) -> CliResult<Self> {
        let branding = Branding::embedded();
        let (config_dir, isolated) = match data_dir_override {
            Some(dir) => {
                std::fs::create_dir_all(dir).map_err(|e| {
                    CliError::internal(format!("create data dir {}: {e}", dir.display()))
                })?;
                (dir.to_path_buf(), true)
            }
            None => {
                let dir = ensure_config_dir(&branding)
                    .map_err(|e| CliError::internal(format!("resolve config dir: {e}")))?;
                (dir, false)
            }
        };
        let app_config_path = app_config_override.map(PathBuf::from).unwrap_or_else(|| {
            if isolated {
                config_dir.join("config.json")
            } else {
                config_path(&branding).unwrap_or_else(|_| config_dir.join("config.json"))
            }
        });
        Ok(Self {
            cache_root: config_dir.join("cache"),
            sessions_dir: config_dir.join("sessions"),
            cli_state_dir: config_dir.join("cli"),
            app_config_path,
            config_dir,
            isolated,
        })
    }
}

/// Load the shared `AppConfig` (provider profiles, configured default
/// timezone, router budgets) — the exact same load path the desktop app
/// uses, including its schema migration and raw-secret refusal.
pub fn load_app_config(paths: &Paths) -> CliResult<AppConfig> {
    load_config(&paths.app_config_path).map_err(|e| CliError::internal(format!("load config: {e}")))
}

/// Save the shared `AppConfig`, atomically (temp-file + rename), to the
/// exact path this process resolved — isolated or not.
pub fn save_app_config(paths: &Paths, cfg: &AppConfig) -> CliResult<()> {
    save_config(&paths.app_config_path, cfg)
        .map_err(|e| CliError::internal(format!("save config: {e}")))
}

pub fn session_store(paths: &Paths) -> SessionStore {
    SessionStore::new(&paths.sessions_dir)
}

/// OS-keychain-backed secret store, same service name the desktop app
/// uses — a provider configured in the GUI works immediately from the CLI
/// with no separate credential setup, and nothing this crate does ever
/// touches secrets except through this trait object.
pub const PROVIDER_API_KEY_ENV: &str = "CONTEXTDESK_PROVIDER_API_KEY";

/// CLI credential adapter.
///
/// Normal interactive use shares the desktop application's OS keychain. For
/// ephemeral automation and CI, `CONTEXTDESK_PROVIDER_API_KEY` supplies only
/// provider credentials for the lifetime of this process. It is never
/// persisted and never substitutes for connector secrets.
pub struct CliSecretStore {
    keychain: KeychainSecretStore,
    provider_override: Option<String>,
}

impl CliSecretStore {
    fn new() -> Self {
        let provider_override = std::env::var(PROVIDER_API_KEY_ENV)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        Self {
            keychain: KeychainSecretStore::new(),
            provider_override,
        }
    }

    fn provider_override(&self, reference: &str) -> Option<String> {
        reference
            .starts_with("provider/")
            .then(|| self.provider_override.clone())
            .flatten()
    }
}

impl SecretStore for CliSecretStore {
    fn get(&self, reference: &str) -> CoreResult<Option<String>> {
        if let Some(value) = self.provider_override(reference) {
            return Ok(Some(value));
        }
        self.keychain.get(reference)
    }

    fn set(&self, reference: &str, value: &str) -> CoreResult<()> {
        self.keychain.set(reference, value)
    }

    fn delete(&self, reference: &str) -> CoreResult<()> {
        self.keychain.delete(reference)
    }
}

pub fn secret_store() -> CliSecretStore {
    CliSecretStore::new()
}

/// Build a `ToolHost` for a headless process: an empty workspace (the CLI's
/// first slice is corpus/chat-oriented, not workspace file search — a
/// non-empty workspace is a later, explicit `--workspace` flag, not an
/// implicit default) and an index built over it. No window, no webview
/// concept anywhere — `ToolHost::new` never needed one.
///
/// Always enables log analysis against `cache_root` — the same corpus
/// cache every other command in this crate reads and writes — so a linked
/// chat turn's `bind_linked_corpus` (which seeds a corpus handle on this
/// host) has a cache dir to resolve against instead of failing closed with
/// `"log cache dir not configured"`.
pub fn tool_host(cache_root: &Path) -> CliResult<ToolHost> {
    let workspace = Workspace::new("contextdesk-cli", Vec::new());
    let index = KeywordIndex::build(&workspace)
        .map_err(|e| CliError::internal(format!("build empty keyword index: {e}")))?;
    let mut host = ToolHost::new(workspace, index, None);
    host.set_log_analysis(true, Some(cache_root.to_path_buf()));
    Ok(host)
}

/// Apply optional connectors from the shared `AppConfig` (same contract as
/// desktop `apply_host_connectors`). Secret-store reads happen only when a
/// credential **reference** is recorded — keyless profiles perform zero
/// secret-store reads. Delegates to [`ToolHost::apply_confluence_from_settings`].
pub fn apply_app_connectors(
    host: &mut ToolHost,
    app_cfg: &AppConfig,
    secrets: &dyn cd_core::keychain_store::SecretStore,
) {
    host.apply_confluence_from_settings(&app_cfg.confluence, secrets);
}

/// ToolHost with log analysis + optional Confluence from shared AppConfig.
pub fn tool_host_with_app_config(
    cache_root: &Path,
    app_cfg: &AppConfig,
    secrets: &dyn cd_core::keychain_store::SecretStore,
) -> CliResult<ToolHost> {
    let mut host = tool_host(cache_root)?;
    apply_app_connectors(&mut host, app_cfg, secrets);
    Ok(host)
}

#[cfg(test)]
mod credential_tests {
    use super::*;

    #[test]
    fn process_override_is_provider_only() {
        let store = CliSecretStore {
            keychain: KeychainSecretStore::new(),
            provider_override: Some("ephemeral-value".to_string()),
        };

        assert_eq!(
            store
                .provider_override("provider/vercel/api_key")
                .as_deref(),
            Some("ephemeral-value")
        );
        assert_eq!(store.provider_override("connector/confluence/pat"), None);
        assert_eq!(store.provider_override("connector/postgres/password"), None);
    }
}
