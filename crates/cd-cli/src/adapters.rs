//! Host glue: the paths and constructors a headless CLI process needs to
//! call into `cd_core` / `cd_workflow` exactly the way the desktop app
//! does — same config file, same corpus cache, same sessions directory —
//! so state created in one host is immediately visible from the other.

use crate::envelope::{CliError, CliResult};
use crate::provider_credentials::{
    bind_global_provider_override, identities_from_profiles, participating_profiles,
    retrieval_role_identities, CredentialedIdentity,
};
use cd_core::branding::Branding;
use cd_core::config::{config_path, ensure_config_dir, load_config, save_config, AppConfig};
use cd_core::error::CoreResult;
use cd_core::index::KeywordIndex;
use cd_core::keychain_store::{ReferencedSecretStore, SecretStore};
use cd_core::sessions::SessionStore;
use cd_core::tool_host::ToolHost;
use cd_core::workspace::Workspace;
use std::path::{Path, PathBuf};
use std::sync::Arc;

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
    /// absent OS home/profile directory cannot affect an isolated profile.
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
        Self::resolve_with_shared_paths(
            data_dir_override,
            app_config_override,
            || {
                ensure_config_dir(&branding)
                    .map_err(|e| CliError::internal(format!("resolve config dir: {e}")))
            },
            || config_path(&branding).ok(),
        )
    }

    /// Resolve paths while deferring both OS-profile lookups until the
    /// desktop-shared branch actually needs them.
    ///
    /// Keeping the resolvers lazy is part of the isolation boundary: an
    /// explicit data directory must not even evaluate code that discovers a
    /// user's shared home/profile path. The indirection also gives tests a
    /// platform-independent way to prove that negative property; on Windows,
    /// `dirs::home_dir()` uses `FOLDERID_Profile` and intentionally ignores
    /// the Unix-specific `HOME` environment variable.
    fn resolve_with_shared_paths<SharedDir, SharedAppConfig>(
        data_dir_override: Option<&Path>,
        app_config_override: Option<&Path>,
        resolve_shared_dir: SharedDir,
        resolve_shared_app_config: SharedAppConfig,
    ) -> CliResult<Self>
    where
        SharedDir: FnOnce() -> CliResult<PathBuf>,
        SharedAppConfig: FnOnce() -> Option<PathBuf>,
    {
        let (config_dir, isolated) = match data_dir_override {
            Some(dir) => {
                std::fs::create_dir_all(dir).map_err(|e| {
                    CliError::internal(format!("create data dir {}: {e}", dir.display()))
                })?;
                (dir.to_path_buf(), true)
            }
            None => (resolve_shared_dir()?, false),
        };
        let app_config_path = app_config_override.map(PathBuf::from).unwrap_or_else(|| {
            if isolated {
                config_dir.join("config.json")
            } else {
                resolve_shared_app_config().unwrap_or_else(|| config_dir.join("config.json"))
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

#[cfg(test)]
mod path_tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn isolated_paths_never_evaluate_shared_profile_resolvers() {
        let isolated_dir = tempfile::tempdir().unwrap();
        let paths = Paths::resolve_with_shared_paths(
            Some(isolated_dir.path()),
            None,
            || panic!("isolated resolution consulted the shared config directory"),
            || panic!("isolated resolution consulted the shared app config path"),
        )
        .unwrap();

        assert!(paths.isolated);
        assert_eq!(paths.config_dir, isolated_dir.path());
        assert_eq!(
            paths.app_config_path,
            isolated_dir.path().join("config.json")
        );
        assert_eq!(paths.cache_root, isolated_dir.path().join("cache"));
        assert_eq!(paths.sessions_dir, isolated_dir.path().join("sessions"));
        assert_eq!(paths.cli_state_dir, isolated_dir.path().join("cli"));
    }

    #[test]
    fn shared_paths_evaluate_both_platform_resolvers() {
        let shared_dir = tempfile::tempdir().unwrap();
        let shared_app_config = shared_dir.path().join("shared-config.json");
        let dir_called = Cell::new(false);
        let app_config_called = Cell::new(false);

        let paths = Paths::resolve_with_shared_paths(
            None,
            None,
            || {
                dir_called.set(true);
                Ok(shared_dir.path().to_path_buf())
            },
            || {
                app_config_called.set(true);
                Some(shared_app_config.clone())
            },
        )
        .unwrap();

        assert!(dir_called.get(), "shared config resolver was not exercised");
        assert!(
            app_config_called.get(),
            "shared app-config resolver was not exercised"
        );
        assert!(!paths.isolated);
        assert_eq!(paths.config_dir, shared_dir.path());
        assert_eq!(paths.app_config_path, shared_app_config);
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
/// ephemeral automation and CI, `CONTEXTDESK_PROVIDER_API_KEY` may supply a
/// provider credential for **one** selected keychain-style reference for the
/// lifetime of this process. It is never persisted, never printed, never
/// applied to connector secrets, never applied to protected `file:` refs,
/// and never reused across mixed-provider comparisons.
pub struct CliSecretStore {
    inner: Box<dyn SecretStore>,
    env_override: Option<String>,
    bound_reference: Option<String>,
}

impl std::fmt::Debug for CliSecretStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CliSecretStore")
            .field("bound_reference", &self.bound_reference)
            .field("env_override_set", &self.env_override.is_some())
            .finish_non_exhaustive()
    }
}

impl CliSecretStore {
    fn read_env_override() -> Option<String> {
        std::env::var(PROVIDER_API_KEY_ENV)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    }

    fn new() -> Self {
        Self {
            inner: Box::new(ReferencedSecretStore::new()),
            env_override: Self::read_env_override(),
            bound_reference: None,
        }
    }

    fn with_inner(
        inner: Box<dyn SecretStore>,
        identities: &[CredentialedIdentity],
    ) -> CliResult<Self> {
        let env_override = Self::read_env_override();
        let bound_reference = bind_global_provider_override(env_override.as_deref(), identities)?;
        Ok(Self {
            inner,
            env_override,
            bound_reference,
        })
    }

    fn bound_override_for(&self, reference: &str) -> Option<&str> {
        let bound = self.bound_reference.as_deref()?;
        (bound == reference)
            .then_some(self.env_override.as_deref())
            .flatten()
    }

    #[cfg(test)]
    fn for_test(
        inner: Box<dyn SecretStore>,
        env_override: Option<String>,
        identities: &[CredentialedIdentity],
    ) -> CliResult<Self> {
        let bound_reference = bind_global_provider_override(env_override.as_deref(), identities)?;
        Ok(Self {
            inner,
            env_override,
            bound_reference,
        })
    }
}

impl SecretStore for CliSecretStore {
    fn get(&self, reference: &str) -> CoreResult<Option<String>> {
        if let Some(value) = self.bound_override_for(reference) {
            return Ok(Some(value.to_string()));
        }
        self.inner.get(reference)
    }

    fn set(&self, reference: &str, value: &str) -> CoreResult<()> {
        self.inner.set(reference, value)
    }

    fn delete(&self, reference: &str) -> CoreResult<()> {
        self.inner.delete(reference)
    }
}

/// Unbound store: the global override is loaded but not applied to any
/// reference. Safe for offline commands that never resolve provider secrets.
pub fn secret_store() -> CliSecretStore {
    CliSecretStore::new()
}

/// Bind the process override to the selected live profile (and optional
/// reviewer / extra comparison profiles / retrieval roles).
pub fn secret_store_for_live(
    cfg: &AppConfig,
    selected_profile_id: Option<&str>,
    extra_profile_ids: &[String],
    include_reviewer: bool,
    include_retrieval_roles: bool,
) -> CliResult<CliSecretStore> {
    secret_store_for_identities(&live_identities(
        cfg,
        selected_profile_id,
        extra_profile_ids,
        include_reviewer,
        include_retrieval_roles,
    ))
}

/// Bind the process override to an explicit set of comparison identities.
pub fn secret_store_for_identities(
    identities: &[CredentialedIdentity],
) -> CliResult<CliSecretStore> {
    CliSecretStore::with_inner(Box::new(ReferencedSecretStore::new()), identities)
}

/// Credential identities a live command will actually resolve.
pub fn live_identities(
    cfg: &AppConfig,
    selected_profile_id: Option<&str>,
    extra_profile_ids: &[String],
    include_reviewer: bool,
    include_retrieval_roles: bool,
) -> Vec<CredentialedIdentity> {
    let profiles = participating_profiles(
        cfg,
        selected_profile_id,
        extra_profile_ids,
        include_reviewer,
    );
    let mut identities = identities_from_profiles(&profiles);
    if include_retrieval_roles {
        identities.extend(retrieval_role_identities(cfg));
        identities.sort_by(|a, b| a.id.cmp(&b.id));
        identities.dedup_by(|a, b| a.id == b.id && a.api_key_ref == b.api_key_ref);
    }
    identities
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

/// Attach explicitly enabled retrieval roles to the same production
/// [`ToolHost`] used by CLI chat and linked-log turns. This mirrors the
/// desktop host wiring but keeps the adapter/dialect/SSRF decisions in the
/// shared workflow factory. Optional-role failures preserve the existing
/// keyword/local fallback instead of making ordinary chat unusable.
pub fn apply_configured_retrieval_roles(
    host: &mut ToolHost,
    app_cfg: &AppConfig,
    secrets: &dyn cd_core::keychain_store::SecretStore,
) {
    if let Some(role) = app_cfg
        .retrieval
        .embedding
        .as_ref()
        .filter(|role| role.enabled)
    {
        let backend = if app_cfg.router.deadline_is_explicit {
            cd_workflow::retrieval::build_embedding_backend_with_timeout(
                role,
                Some(secrets),
                app_cfg.router.deadline_ms,
            )
        } else {
            cd_workflow::retrieval::build_embedding_backend(role, Some(secrets))
        };
        match backend {
            Ok(backend) => {
                host.set_embed_backend_with_model(Some(Arc::clone(&backend)), &role.model);
                host.set_log_embed_backend(Some(backend), &role.model);
            }
            Err(error) => {
                tracing::warn!(error = %error, "configured CLI embedding role unavailable; keeping fallback");
            }
        }
    }
    if let Some(role) = app_cfg
        .retrieval
        .reranker
        .as_ref()
        .filter(|role| role.enabled)
    {
        let backend = if app_cfg.router.deadline_is_explicit {
            cd_workflow::retrieval::build_rerank_backend_with_timeout(
                role,
                Some(secrets),
                app_cfg.router.deadline_ms,
            )
        } else {
            cd_workflow::retrieval::build_rerank_backend(role, Some(secrets))
        };
        match backend {
            Ok(backend) => host.set_log_rerank_backend(Some(backend)),
            Err(error) => {
                tracing::warn!(error = %error, "configured CLI reranker role unavailable; preserving pre-rerank order");
            }
        }
    }
}

/// ToolHost with log analysis + optional Confluence from shared AppConfig.
pub fn tool_host_with_app_config(
    cache_root: &Path,
    app_cfg: &AppConfig,
    secrets: &dyn cd_core::keychain_store::SecretStore,
) -> CliResult<ToolHost> {
    let mut host = tool_host(cache_root)?;
    // Keep the CLI on the same whole-turn budget as the shared AppConfig and
    // desktop host. Otherwise cd-core sees ToolHost's 120s default and can
    // silently discard an explicit user deadline resolved by cd-workflow.
    host.set_router_budget(app_cfg.router.clone());
    apply_app_connectors(&mut host, app_cfg, secrets);
    apply_configured_retrieval_roles(&mut host, app_cfg, secrets);
    Ok(host)
}

#[cfg(test)]
mod credential_tests {
    use super::*;

    struct NoSecrets;

    impl cd_core::keychain_store::SecretStore for NoSecrets {
        fn get(&self, _reference: &str) -> CoreResult<Option<String>> {
            Ok(None)
        }

        fn set(&self, _reference: &str, _value: &str) -> CoreResult<()> {
            Ok(())
        }

        fn delete(&self, _reference: &str) -> CoreResult<()> {
            Ok(())
        }
    }

    #[test]
    fn process_override_is_provider_only_and_bound_to_one_profile() {
        use cd_core::keychain_store::MemorySecretStore;
        use cd_core::providers::{
            ProviderCapabilities, ProviderDeadlinePreference, ProviderKind, ProviderProfile,
        };

        let vercel = ProviderProfile {
            id: "vercel".into(),
            label: "Vercel".into(),
            kind: ProviderKind::OpenAiCompatible,
            base_url: "https://ai-gateway.vercel.sh/v1".into(),
            api_key_ref: Some("provider/vercel/api_key".into()),
            chat_model: "synthetic".into(),
            embedding_model: None,
            embedding_base_url: None,
            capabilities: ProviderCapabilities {
                tools: true,
                stream: true,
                embeddings: false,
            },
            local_only: false,
            deadline_preference: ProviderDeadlinePreference::Auto,
        };
        let identities = identities_from_profiles([&vercel]);
        let inner = MemorySecretStore::new();
        inner
            .set("provider/vercel/api_key", "keychain-vercel")
            .unwrap();
        inner
            .set("connector/confluence/pat", "connector-secret")
            .unwrap();
        let store =
            CliSecretStore::for_test(Box::new(inner), Some("ephemeral-value".into()), &identities)
                .unwrap();

        assert_eq!(
            store.get("provider/vercel/api_key").unwrap().as_deref(),
            Some("ephemeral-value")
        );
        assert_eq!(
            store.get("connector/confluence/pat").unwrap().as_deref(),
            Some("connector-secret")
        );
        assert_eq!(store.get("connector/postgres/password").unwrap(), None);
    }

    fn remote_profile(id: &str, api_key_ref: &str) -> cd_core::providers::ProviderProfile {
        use cd_core::providers::{
            ProviderCapabilities, ProviderDeadlinePreference, ProviderKind, ProviderProfile,
        };
        ProviderProfile {
            id: id.into(),
            label: id.into(),
            kind: ProviderKind::OpenAiCompatible,
            base_url: "https://gateway.example/v1".into(),
            api_key_ref: Some(api_key_ref.into()),
            chat_model: "synthetic".into(),
            embedding_model: None,
            embedding_base_url: None,
            capabilities: ProviderCapabilities {
                tools: true,
                stream: true,
                embeddings: false,
            },
            local_only: false,
            deadline_preference: ProviderDeadlinePreference::Auto,
        }
    }

    #[test]
    fn mixed_employer_and_vercel_cannot_cross_use_the_global_override() {
        use cd_core::keychain_store::MemorySecretStore;

        let employer = remote_profile("employer", "provider/employer/api_key");
        let vercel = remote_profile("vercel", "provider/vercel/api_key");
        let identities = identities_from_profiles([&employer, &vercel]);
        let inner = MemorySecretStore::new();
        inner
            .set("provider/employer/api_key", "employer-only-secret")
            .unwrap();
        inner
            .set("provider/vercel/api_key", "vercel-only-secret")
            .unwrap();
        let error = CliSecretStore::for_test(
            Box::new(inner),
            Some("synthetic-shared-key-must-not-leak".into()),
            &identities,
        )
        .unwrap_err();
        let message = error.to_string();
        assert!(message.contains("mixed-provider"));
        assert!(!message.contains("synthetic-shared-key-must-not-leak"));
        assert!(!message.contains("employer-only-secret"));
        assert!(!message.contains("vercel-only-secret"));
    }

    #[test]
    fn without_override_each_profile_keeps_its_own_credential() {
        use cd_core::keychain_store::MemorySecretStore;

        let employer = remote_profile("employer", "provider/employer/api_key");
        let vercel = remote_profile("vercel", "provider/vercel/api_key");
        let identities = identities_from_profiles([&employer, &vercel]);
        let inner = MemorySecretStore::new();
        inner
            .set("provider/employer/api_key", "employer-only-secret")
            .unwrap();
        inner
            .set("provider/vercel/api_key", "vercel-only-secret")
            .unwrap();
        let store = CliSecretStore::for_test(Box::new(inner), None, &identities).unwrap();
        assert_eq!(
            store.get("provider/employer/api_key").unwrap().as_deref(),
            Some("employer-only-secret")
        );
        assert_eq!(
            store.get("provider/vercel/api_key").unwrap().as_deref(),
            Some("vercel-only-secret")
        );
        assert_ne!(
            store.get("provider/employer/api_key").unwrap(),
            store.get("provider/vercel/api_key").unwrap()
        );
    }

    #[test]
    fn missing_profile_credential_does_not_borrow_another_profile() {
        use cd_core::keychain_store::MemorySecretStore;

        let employer = remote_profile("employer", "provider/employer/api_key");
        let identities = identities_from_profiles([&employer]);
        let inner = MemorySecretStore::new();
        inner
            .set("provider/vercel/api_key", "vercel-only-secret")
            .unwrap();
        let store = CliSecretStore::for_test(Box::new(inner), None, &identities).unwrap();
        assert_eq!(store.get("provider/employer/api_key").unwrap(), None);
        assert_eq!(
            store.get("provider/vercel/api_key").unwrap().as_deref(),
            Some("vercel-only-secret")
        );
    }

    #[cfg(unix)]
    #[test]
    fn protected_file_permission_errors_do_not_echo_secret_bytes() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vercel.key");
        std::fs::write(&path, "synthetic-file-secret\n").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        let reference = format!("file:{}", path.display());
        let vercel = remote_profile("vercel", &reference);
        let identities = identities_from_profiles([&vercel]);
        let store = secret_store_for_identities(&identities).unwrap();
        let error = store.get(&reference).unwrap_err().to_string();
        assert!(error.contains("permissions"), "{error}");
        assert!(!error.contains("synthetic-file-secret"));
    }

    #[cfg(unix)]
    #[test]
    fn protected_files_do_not_cross_use_and_missing_files_fail_closed() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let employer_path = dir.path().join("employer.key");
        let vercel_path = dir.path().join("vercel.key");
        std::fs::write(&employer_path, "employer-file-secret\n").unwrap();
        std::fs::write(&vercel_path, "vercel-file-secret\n").unwrap();
        std::fs::set_permissions(&employer_path, std::fs::Permissions::from_mode(0o600)).unwrap();
        std::fs::set_permissions(&vercel_path, std::fs::Permissions::from_mode(0o600)).unwrap();
        let employer_ref = format!("file:{}", employer_path.display());
        let vercel_ref = format!("file:{}", vercel_path.display());
        let employer = remote_profile("employer", &employer_ref);
        let vercel = remote_profile("vercel", &vercel_ref);
        let identities = identities_from_profiles([&employer, &vercel]);
        let store = secret_store_for_identities(&identities).unwrap();
        assert_eq!(
            store.get(&employer_ref).unwrap().as_deref(),
            Some("employer-file-secret")
        );
        assert_eq!(
            store.get(&vercel_ref).unwrap().as_deref(),
            Some("vercel-file-secret")
        );

        let missing = format!("file:{}/gone.key", dir.path().display());
        let error = store.get(&missing).unwrap_err().to_string();
        assert!(!error.contains("employer-file-secret"));
        assert!(!error.contains("vercel-file-secret"));
    }

    #[test]
    fn cli_host_preserves_explicit_app_router_deadline() {
        let dir = tempfile::tempdir().unwrap();
        let mut cfg = AppConfig::default();
        cfg.router.deadline_ms = 600_000;
        cfg.router.deadline_is_explicit = true;

        let host = tool_host_with_app_config(dir.path(), &cfg, &NoSecrets).unwrap();
        assert_eq!(host.router_budget().deadline_ms, 600_000);
        assert!(host.router_budget().deadline_is_explicit);
    }

    #[test]
    fn one_turn_deadline_override_reaches_host_budget_without_persisting() {
        use cd_core::deadline_controls::{
            apply_turn_override, parse_deadline_duration, PATIENT_DEADLINE_MS,
        };
        let dir = tempfile::tempdir().unwrap();
        let mut cfg = AppConfig::default();
        cfg.router.deadline_ms = PATIENT_DEADLINE_MS;
        cfg.router.deadline_is_explicit = false;
        let mut host = tool_host_with_app_config(dir.path(), &cfg, &NoSecrets).unwrap();
        assert!(!host.router_budget().deadline_is_explicit);

        let ms = parse_deadline_duration("10m").unwrap();
        let mut budget = host.router_budget().clone();
        apply_turn_override(&mut budget, ms).unwrap();
        host.set_router_budget(budget);
        assert_eq!(host.router_budget().deadline_ms, 600_000);
        assert!(host.router_budget().deadline_is_explicit);

        // A fresh host from the same AppConfig returns to the saved adaptive policy.
        let next = tool_host_with_app_config(dir.path(), &cfg, &NoSecrets).unwrap();
        assert!(!next.router_budget().deadline_is_explicit);
        assert_eq!(next.router_budget().deadline_ms, PATIENT_DEADLINE_MS);
    }

    #[test]
    fn turn_override_beats_saved_explicit_and_does_not_leak_to_next_host() {
        use cd_core::deadline_controls::{apply_turn_override, parse_deadline_duration};
        let dir = tempfile::tempdir().unwrap();
        let mut cfg = AppConfig::default();
        // Saved explicit custom ceiling (90s).
        cfg.router.deadline_ms = 90_000;
        cfg.router.deadline_is_explicit = true;
        let mut host = tool_host_with_app_config(dir.path(), &cfg, &NoSecrets).unwrap();
        assert_eq!(host.router_budget().deadline_ms, 90_000);
        assert!(host.router_budget().deadline_is_explicit);

        // Per-turn override wins for this host only.
        let ms = parse_deadline_duration("3m").unwrap();
        let mut budget = host.router_budget().clone();
        apply_turn_override(&mut budget, ms).unwrap();
        host.set_router_budget(budget);
        assert_eq!(host.router_budget().deadline_ms, 180_000);

        // AppConfig object (source of truth for persistence) unchanged.
        assert_eq!(cfg.router.deadline_ms, 90_000);
        assert!(cfg.router.deadline_is_explicit);

        // Next turn / next host rebuild from saved policy — no leak.
        let later = tool_host_with_app_config(dir.path(), &cfg, &NoSecrets).unwrap();
        assert_eq!(later.router_budget().deadline_ms, 90_000);
        assert!(later.router_budget().deadline_is_explicit);
    }

    #[test]
    fn configured_loopback_retrieval_roles_attach_to_the_cli_host() {
        let dir = tempfile::tempdir().unwrap();
        let mut cfg = AppConfig::default();
        cfg.retrieval.embedding = Some(cd_core::config::RetrievalRoleModel {
            enabled: true,
            base_url: "http://127.0.0.1:1/v1".into(),
            model: "synthetic-embed".into(),
            dialect: Some("openai_embeddings".into()),
            allow_remote: false,
            api_key_ref: None,
            embed_wire: Default::default(),
            rerank_dialect: Default::default(),
        });
        cfg.retrieval.reranker = Some(cd_core::config::RetrievalRoleModel {
            enabled: true,
            base_url: "http://127.0.0.1:1/v1".into(),
            model: "synthetic-reranker".into(),
            dialect: Some("tei_rerank_v1".into()),
            allow_remote: false,
            api_key_ref: None,
            embed_wire: Default::default(),
            rerank_dialect: Default::default(),
        });

        let host = tool_host_with_app_config(dir.path(), &cfg, &NoSecrets).unwrap();
        assert_eq!(host.embed_model(), "synthetic-embed");
        assert!(host.embed_backend().is_some());
        assert!(host.log_embed_backend().is_some());
        assert!(host.log_rerank_backend().is_some());
    }
}
