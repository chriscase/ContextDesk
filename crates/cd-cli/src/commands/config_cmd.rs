//! `contextdesk config` — init / validate / show / path.
//!
//! `init` writes to two SEPARATE files, and this module is the only place
//! that ever writes either of them from a wizard:
//! - `cli.toml` (this crate's own [`crate::config`] schema) — CLI-only
//!   behavior preferences (output format, color, the CLI's profile pointer).
//! - the shared `AppConfig` (`cd_core::config`, same file the desktop app
//!   reads/writes) — provider profiles (credential refs only, never a raw
//!   secret) and the configured default timezone.
//!
//! Data-location configuration is report-only here: `--data-dir` /
//! `--profile-dir` is a global flag resolved once in `main.rs` before any
//! command runs (see [`crate::adapters::Paths`]), so by the time this
//! wizard runs the location is already fixed — it can only tell the user
//! what was chosen, never choose it itself (there is nothing to read a
//! saved choice from until a config file exists at that location).
//!
//! A credential selected for Keychain import is committed as the single last
//! fallible step of the whole command. A protected-file reference is validated
//! and saved directly and is never copied into Keychain.
//! Every wizard prompt writes to stderr, never stdout, so an interactive
//! run under `--json`/`--jsonl` still emits one clean, parseable envelope
//! on stdout.

use crate::adapters::{load_app_config, save_app_config, Paths};
use crate::cli::{ConfigAction, ConfigInitArgs, DeadlineAction, EffortAction, ProviderKindArg};
use crate::config::{
    global_config_path, load_layer, project_config_path, save_layer, CliConfigFile, ImportSection,
    OutputSection, ResolvedConfig, WorkflowSection,
};
use crate::envelope::{CliError, CliResult, Render};
use crate::provider_probe;
use cd_core::config::{is_valid_iana_timezone, AppConfig};
use cd_core::deadline_controls::{
    apply_auto_policy, apply_explicit_deadline_ms, deadline_status, format_deadline_ms,
    parse_deadline_duration, DeadlineStatus,
};
use cd_core::keychain_store::{
    file_secret_ref, key_ref_for_profile, read_file_secret_ref, SecretStore,
};
use cd_core::providers::{
    descriptor_for, ProviderDeadlinePreference, ProviderKind, ProviderProfile,
};
use cd_core::reasoning_effort::{
    effort_status, ReasoningEffortLevel, ReasoningEffortStatus, REASONING_EFFORT_SCHEMA_V1,
};
use cd_core::ssrf::{validate_provider_url, SsrfPolicy};
use serde::Serialize;
use std::io::{self, IsTerminal, Write};
use std::path::Path;

#[derive(Debug, Serialize)]
pub struct InitOutput {
    pub path: String,
    pub created: bool,
    /// Where every piece of state this process touches lives — the same
    /// value `contextdesk config path` and `capabilities` would report.
    pub data_dir: String,
    /// True when `data_dir` came from `--data-dir` / `--profile-dir`
    /// rather than the default, desktop-shared `~/.contextdesk`.
    pub isolated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_profile_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credential_configured: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credential_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_timezone: Option<String>,
    /// Human-readable outcome of the optional connectivity check — never
    /// present unless `--check-connection` (or its interactive prompt) was
    /// accepted.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connectivity_check: Option<String>,
    /// Number of model ids saved from the setup catalog request.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub discovered_models: Option<usize>,
}

impl Render for InitOutput {
    fn render_text(&self) -> String {
        let mut lines = vec![
            format!(
                "{} {}",
                if self.created { "wrote" } else { "updated" },
                self.path
            ),
            format!(
                "data location: {}{}",
                self.data_dir,
                if self.isolated {
                    " (isolated)"
                } else {
                    " (shared with desktop app)"
                }
            ),
        ];
        if let Some(id) = &self.provider_profile_id {
            lines.push(format!(
                "provider: {id} ({})",
                self.provider_kind.as_deref().unwrap_or("unknown kind")
            ));
            lines.push(format!(
                "credential: {}",
                if self.credential_configured.unwrap_or(false) {
                    self.credential_source
                        .as_deref()
                        .unwrap_or("configured reference")
                } else {
                    "not configured"
                }
            ));
        }
        if let Some(tz) = &self.default_timezone {
            lines.push(format!("default timezone: {tz}"));
        }
        if let Some(check) = &self.connectivity_check {
            lines.push(format!("connectivity check: {check}"));
        }
        if let Some(count) = self.discovered_models {
            lines.push(format!(
                "model catalog: {count} discovered (run `contextdesk models` for role/readiness details)"
            ));
        }
        lines.join("\n")
    }

    fn render_json(&self) -> serde_json::Value {
        serde_json::to_value(self).expect("InitOutput is always serializable")
    }
}

#[derive(Debug, Serialize)]
pub struct ValidateOutput {
    pub path: String,
    pub valid: bool,
}

impl Render for ValidateOutput {
    fn render_text(&self) -> String {
        format!("{}: valid", self.path)
    }

    fn render_json(&self) -> serde_json::Value {
        serde_json::to_value(self).expect("ValidateOutput is always serializable")
    }
}

impl Render for ResolvedConfig {
    fn render_text(&self) -> String {
        format!(
            "output.format = {} ({})\noutput.color = {} ({})\nworkflow.default_provider_profile = {} ({})\nworkflow.default_chat_model = {} ({})\nimport.embed = {} ({})",
            self.output_format.value,
            self.output_format.source,
            self.color.value,
            self.color.source,
            self.default_provider_profile.value.as_deref().unwrap_or("(unset — falls back to AppConfig)"),
            self.default_provider_profile.source,
            self.default_chat_model.value.as_deref().unwrap_or("(unset — falls back to AppConfig)"),
            self.default_chat_model.source,
            self.import_embed.value,
            self.import_embed.source,
        )
    }

    fn render_json(&self) -> serde_json::Value {
        serde_json::to_value(self).expect("ResolvedConfig is always serializable")
    }
}

#[derive(Debug, Serialize)]
pub struct PathOutput {
    pub global: String,
    pub project: String,
    pub project_exists: bool,
}

impl Render for PathOutput {
    fn render_text(&self) -> String {
        format!(
            "global:  {}\nproject: {}{}",
            self.global,
            self.project,
            if self.project_exists {
                ""
            } else {
                " (not present)"
            }
        )
    }

    fn render_json(&self) -> serde_json::Value {
        serde_json::to_value(self).expect("PathOutput is always serializable")
    }
}

#[allow(clippy::too_many_arguments)]
pub async fn run(
    action: &ConfigAction,
    paths: &Paths,
    cwd: &Path,
    explicit_project_path: Option<&Path>,
    resolved: &ResolvedConfig,
    app_cfg: &AppConfig,
    secrets: &dyn SecretStore,
) -> CliResult<Box<dyn Render>> {
    match action {
        ConfigAction::Init(args) => run_init(args, paths, cwd, app_cfg, secrets).await,
        ConfigAction::Validate { path } => {
            let target = path
                .clone()
                .or_else(|| explicit_project_path.map(Path::to_path_buf))
                .unwrap_or_else(|| project_config_path(cwd));
            if load_layer(&target)?.is_none() {
                return Err(CliError::not_found(format!(
                    "no config file at {}",
                    target.display()
                )));
            }
            Ok(Box::new(ValidateOutput {
                path: target.display().to_string(),
                valid: true,
            }))
        }
        ConfigAction::Show => Ok(Box::new(resolved.clone())),
        ConfigAction::Path => {
            let project = explicit_project_path
                .map(Path::to_path_buf)
                .unwrap_or_else(|| project_config_path(cwd));
            Ok(Box::new(PathOutput {
                global: global_config_path(&paths.config_dir).display().to_string(),
                project_exists: project.exists(),
                project: project.display().to_string(),
            }))
        }
        ConfigAction::Deadline(action) => run_deadline(action, paths, app_cfg),
        ConfigAction::Effort(action) => run_effort(action, paths, app_cfg),
    }
}

/// Read-only / mutating reasoning-effort controls for AppConfig.reasoning_effort.
fn run_effort(
    action: &EffortAction,
    paths: &Paths,
    app_cfg: &AppConfig,
) -> CliResult<Box<dyn Render>> {
    match action {
        EffortAction::Show => Ok(Box::new(EffortCommandOutput {
            schema: REASONING_EFFORT_SCHEMA_V1,
            action: "show",
            status: effort_status(&app_cfg.reasoning_effort),
            changed: false,
        })),
        EffortAction::Auto => {
            let mut cfg = load_app_config(paths)?;
            // Only the effort settings field is rewritten.
            cfg.reasoning_effort.apply_omit();
            save_app_config(paths, &cfg)?;
            Ok(Box::new(EffortCommandOutput {
                schema: REASONING_EFFORT_SCHEMA_V1,
                action: "auto",
                status: effort_status(&cfg.reasoning_effort),
                changed: true,
            }))
        }
        EffortAction::Set { level } => {
            let level =
                ReasoningEffortLevel::parse(level).map_err(|e| CliError::user(e.to_string()))?;
            let mut cfg = load_app_config(paths)?;
            cfg.reasoning_effort.apply_level(level);
            save_app_config(paths, &cfg)?;
            Ok(Box::new(EffortCommandOutput {
                schema: REASONING_EFFORT_SCHEMA_V1,
                action: "set",
                status: effort_status(&cfg.reasoning_effort),
                changed: true,
            }))
        }
    }
}

#[derive(Debug, Serialize)]
struct EffortCommandOutput {
    schema: &'static str,
    action: &'static str,
    #[serde(flatten)]
    status: ReasoningEffortStatus,
    changed: bool,
}

impl Render for EffortCommandOutput {
    fn render_text(&self) -> String {
        let mut lines = vec![
            format!("reasoning-effort policy: {}", self.status.policy),
            format!(
                "level: {}",
                self.status
                    .level
                    .as_deref()
                    .unwrap_or("(omit / provider default)")
            ),
            self.status.note.clone(),
        ];
        if self.changed {
            lines.push(format!("saved via config effort {}", self.action));
        }
        lines.join("\n")
    }

    fn render_json(&self) -> serde_json::Value {
        serde_json::to_value(self).expect("EffortCommandOutput is always serializable")
    }
}

/// Read-only / mutating whole-turn deadline controls for AppConfig.router.
fn run_deadline(
    action: &DeadlineAction,
    paths: &Paths,
    app_cfg: &AppConfig,
) -> CliResult<Box<dyn Render>> {
    match action {
        DeadlineAction::Show => {
            let status = deadline_status(&app_cfg.router);
            Ok(Box::new(DeadlineCommandOutput {
                action: "show",
                status,
                changed: false,
            }))
        }
        DeadlineAction::Auto => {
            // Reload so concurrent GUI edits are not clobbered beyond the two
            // deadline fields we intentionally touch.
            let mut cfg = load_app_config(paths)?;
            apply_auto_policy(&mut cfg.router);
            save_app_config(paths, &cfg)?;
            Ok(Box::new(DeadlineCommandOutput {
                action: "auto",
                status: deadline_status(&cfg.router),
                changed: true,
            }))
        }
        DeadlineAction::Set { duration } => {
            let ms =
                parse_deadline_duration(duration).map_err(|e| CliError::user(e.to_string()))?;
            let mut cfg = load_app_config(paths)?;
            apply_explicit_deadline_ms(&mut cfg.router, ms)
                .map_err(|e| CliError::user(e.to_string()))?;
            save_app_config(paths, &cfg)?;
            Ok(Box::new(DeadlineCommandOutput {
                action: "set",
                status: deadline_status(&cfg.router),
                changed: true,
            }))
        }
    }
}

#[derive(Debug, Serialize)]
struct DeadlineCommandOutput {
    action: &'static str,
    #[serde(flatten)]
    status: DeadlineStatus,
    changed: bool,
}

impl Render for DeadlineCommandOutput {
    fn render_text(&self) -> String {
        let policy = if self.status.deadline_is_explicit {
            "custom (explicit whole-turn ceiling)"
        } else {
            "auto (adaptive by provider class)"
        };
        let mut lines = vec![
            format!("deadline policy: {policy}"),
            format!(
                "stored ceiling: {} ({} ms)",
                self.status.deadline_human, self.status.deadline_ms
            ),
        ];
        if !self.status.deadline_is_explicit {
            lines.push(
                "effective total under auto: 3m for managed profiles, 5m for local/private \
                 (ContextDesk may finish sooner)."
                    .into(),
            );
        } else {
            lines.push(format!(
                "this is the maximum whole-turn time ({}); ContextDesk may finish sooner.",
                format_deadline_ms(self.status.deadline_ms)
            ));
        }
        if self.changed {
            lines.push(format!("saved via config deadline {}", self.action));
        }
        lines.join("\n")
    }

    fn render_json(&self) -> serde_json::Value {
        serde_json::to_value(self).expect("DeadlineCommandOutput is always serializable")
    }
}

/// Writes cli.toml, then (if a provider was configured) the shared
/// `AppConfig`, then — as the single LAST fallible step of the entire
/// command — commits any resolved credential to the OS keychain.
///
/// That ordering is deliberate: every prompt and every validation runs
/// first (a rejected timezone or URL never leaves a half-written cli.toml
/// behind), then both config files are written, and only once they have
/// both landed does the credential itself get stored. A failure at the
/// keychain step therefore never orphans a stored secret that nothing
/// references — worst case, `cfg`'s profile references a keychain entry
/// that doesn't exist yet, which is self-healing: re-running `config init
/// --force` with the same (or an explicit `--profile-id`) fills it in.
async fn run_init(
    args: &ConfigInitArgs,
    paths: &Paths,
    cwd: &Path,
    app_cfg: &AppConfig,
    secrets: &dyn SecretStore,
) -> CliResult<Box<dyn Render>> {
    let path = if args.project {
        project_config_path(cwd)
    } else {
        global_config_path(&paths.config_dir)
    };
    if path.exists() && !args.force {
        return Err(CliError::user(format!(
            "{} already exists — pass --force to overwrite",
            path.display()
        )));
    }

    let interactive = args.interactive || (!args.non_interactive && io::stdin().is_terminal());
    let stdin = io::stdin();
    // Prompts go to stderr, never stdout: stdout is reserved for the final
    // JSON/JSONL envelope under --json/--jsonl, and an interactive wizard
    // is fully reachable in that mode (auto-detection only decides
    // interactive-vs-not from whether stdin is a tty, independent of
    // --format) — prompt text on stdout would otherwise corrupt it.
    let mut stderr = io::stderr();

    let cli_cfg = if interactive {
        prompt_wizard(args, paths, &stdin, &mut stderr)?
    } else {
        CliConfigFile {
            schema_version: crate::config::CLI_CONFIG_SCHEMA_VERSION,
            output: OutputSection {
                format: args.format,
                color: args.color,
            },
            workflow: WorkflowSection {
                default_provider_profile: args.default_provider_profile.clone(),
                default_chat_model: None,
            },
            import: ImportSection { embed: None },
        }
    };

    let configure_provider = if args.skip_provider {
        false
    } else if interactive {
        ask_yes_no(&stdin, &mut stderr, "Configure an AI provider now?", true)?
    } else {
        args.provider_kind.is_some()
    };

    let provider_setup = if configure_provider {
        Some(
            configure_provider_profile(args, interactive, paths, app_cfg, &stdin, &mut stderr)
                .await?,
        )
    } else {
        None
    };

    // Timezone is independent of provider setup: `config init --default-timezone
    // America/Chicago --skip-provider` must still land the IANA id on AppConfig
    // so import's default-timezone apply path can use it without any provider.
    // When a provider was configured, that path already resolved timezone.
    let independent_timezone = if provider_setup.is_none() {
        resolve_timezone_without_provider(args, interactive, &stdin, &mut stderr)?
    } else {
        None
    };

    // Both layers are fully built (and every validation has already run)
    // before either write happens — a rejected timezone or URL never
    // leaves a half-written cli.toml behind.
    let created = !path.exists();
    save_layer(&path, &cli_cfg)?;

    let timezone_written = provider_setup
        .as_ref()
        .and_then(|s| s.timezone.clone())
        .or_else(|| independent_timezone.clone());

    if let Some(setup) = &provider_setup {
        save_app_config(paths, &setup.cfg)?;
    } else if let Some(tz) = &independent_timezone {
        let mut cfg = app_cfg.clone();
        cfg.default_timezone = Some(tz.clone());
        save_app_config(paths, &cfg)?;
    }

    // Save the catalog before the credential, preserving the credential write
    // as the command's final fallible step. The snapshot contains model ids
    // plus endpoint/profile fingerprints only, never the key or raw endpoint.
    if let Some(setup) = &provider_setup {
        if !setup.catalog_models.is_empty() {
            let profile =
                setup.cfg.providers.active().ok_or_else(|| {
                    CliError::internal("configured provider has no active profile")
                })?;
            let store_path =
                cd_core::capability_qualification::qualification_store_path(&paths.config_dir);
            let mut store =
                cd_core::capability_qualification::load_qualification_store(&store_path)
                    .map_err(|error| CliError::internal(format!("load model catalog: {error}")))?;
            store.note_catalog(
                &profile.id,
                &profile.base_url,
                setup.catalog_models.iter().cloned(),
            );
            cd_core::capability_qualification::save_qualification_store(&store_path, &store)
                .map_err(|error| CliError::internal(format!("save model catalog: {error}")))?;
        }
    }

    // The one remaining fallible step, deliberately last: see this
    // function's doc comment for why the credential is stored here and not
    // inside `configure_provider_profile`.
    if let Some(setup) = &provider_setup {
        if setup.persist_secret {
            if let Some(secret) = &setup.secret {
                let key_ref = key_ref_for_profile(&setup.profile_id);
                secrets
                    .set(&key_ref, secret)
                    .map_err(|e| CliError::internal(format!("store credential: {e}")))?;
            }
        }
    }

    Ok(Box::new(InitOutput {
        path: path.display().to_string(),
        created,
        data_dir: paths.config_dir.display().to_string(),
        isolated: paths.isolated,
        provider_profile_id: provider_setup.as_ref().map(|s| s.profile_id.clone()),
        provider_kind: provider_setup.as_ref().map(|s| s.kind_label.to_string()),
        credential_configured: provider_setup.as_ref().map(|s| s.credential_configured),
        credential_source: provider_setup
            .as_ref()
            .map(|s| s.credential_source.to_string()),
        default_timezone: timezone_written,
        connectivity_check: provider_setup
            .as_ref()
            .and_then(|s| s.probe_summary.clone()),
        discovered_models: provider_setup
            .as_ref()
            .map(|setup| setup.catalog_models.len())
            .filter(|count| *count > 0),
    }))
}

/// Resolve `--default-timezone` (or an interactive prompt) when no provider
/// profile is being configured. Call only when `provider_setup` is `None`.
fn resolve_timezone_without_provider(
    args: &ConfigInitArgs,
    interactive: bool,
    stdin: &io::Stdin,
    stderr: &mut io::Stderr,
) -> CliResult<Option<String>> {
    if let Some(tz) = &args.default_timezone {
        if !is_valid_iana_timezone(tz) {
            return Err(CliError::user(format!(
                "{tz:?} is not a recognized IANA timezone"
            )));
        }
        return Ok(Some(tz.clone()));
    }
    if interactive {
        let raw = ask_line(
            stdin,
            stderr,
            "Default timezone for ambiguous local timestamps (blank = leave unset, IANA id e.g. America/Chicago)",
        )?;
        if raw.is_empty() {
            return Ok(None);
        }
        if !is_valid_iana_timezone(&raw) {
            return Err(CliError::user(format!(
                "{raw:?} is not a recognized IANA timezone"
            )));
        }
        return Ok(Some(raw));
    }
    Ok(None)
}

fn prompt_wizard(
    args: &ConfigInitArgs,
    paths: &Paths,
    stdin: &io::Stdin,
    stderr: &mut io::Stderr,
) -> CliResult<CliConfigFile> {
    writeln!(
        stderr,
        "Data location: {}{}",
        paths.config_dir.display(),
        if paths.isolated {
            " (isolated — pass the same --data-dir to reuse this profile)"
        } else {
            " (shared with the desktop app)"
        }
    )
    .map_err(|e| CliError::internal(e.to_string()))?;

    let format = args.format.unwrap_or(
        ask_enum(
            stdin,
            stderr,
            "Output format",
            &["text", "json", "jsonl"],
            "text",
        )?
        .parse_output_format(),
    );
    let color = args.color.unwrap_or(
        ask_enum(stdin, stderr, "Color", &["auto", "always", "never"], "auto")?.parse_color_mode(),
    );
    let profile = if args.default_provider_profile.is_some() {
        args.default_provider_profile.clone()
    } else {
        let raw = ask_line(
            stdin,
            stderr,
            "Default provider profile id (blank = use the shared AppConfig's active profile)",
        )?;
        (!raw.trim().is_empty()).then(|| raw.trim().to_string())
    };

    Ok(CliConfigFile {
        schema_version: crate::config::CLI_CONFIG_SCHEMA_VERSION,
        output: OutputSection {
            format: Some(format),
            color: Some(color),
        },
        workflow: WorkflowSection {
            default_provider_profile: profile,
            default_chat_model: None,
        },
        import: ImportSection { embed: None },
    })
}

/// Everything `run_init` needs from a provider-configuration pass: the
/// `AppConfig` with the new/updated profile merged in (not yet saved), plus
/// the bits `InitOutput` reports back to the caller.
///
/// `secret`, if present, has NOT been stored anywhere yet — `cfg`'s profile
/// already carries the `api_key_ref` it *will* be stored under, but the
/// actual `secrets.set` call is deferred to `run_init`, after both config
/// files are written successfully (see `run_init`'s doc comment). Never log
/// or print this field outside a test assertion.
#[derive(Debug)]
struct ProviderSetupResult {
    cfg: AppConfig,
    profile_id: String,
    kind_label: &'static str,
    credential_configured: bool,
    secret: Option<String>,
    persist_secret: bool,
    credential_source: &'static str,
    timezone: Option<String>,
    probe_summary: Option<String>,
    catalog_models: Vec<String>,
}

async fn configure_provider_profile(
    args: &ConfigInitArgs,
    interactive: bool,
    paths: &Paths,
    app_cfg: &AppConfig,
    stdin: &io::Stdin,
    stderr: &mut io::Stderr,
) -> CliResult<ProviderSetupResult> {
    let kind = match args.provider_kind {
        Some(k) => provider_kind_from_arg(k),
        None if interactive => parse_provider_kind(&ask_enum(
            stdin,
            stderr,
            "Provider kind",
            &["ollama", "openai-compatible", "anthropic", "xai-grok-build"],
            "ollama",
        )?)?,
        None => ProviderKind::Ollama,
    };
    let descriptor = descriptor_for(kind);

    let base_url = if let Some(u) = &args.base_url {
        u.clone()
    } else if interactive {
        let default = descriptor.default_base_url.unwrap_or_default();
        let prompt = if default.is_empty() {
            "Base URL".to_string()
        } else {
            format!("Base URL (default {default})")
        };
        let raw = ask_line(stdin, stderr, &prompt)?;
        if raw.is_empty() {
            default.to_string()
        } else {
            raw
        }
    } else {
        descriptor
            .default_base_url
            .map(str::to_string)
            .ok_or_else(|| {
                CliError::user(
                    "--base-url is required for this provider kind in --non-interactive mode",
                )
            })?
    };
    if base_url.trim().is_empty() {
        return Err(CliError::user("a base URL is required"));
    }
    let policy = if descriptor.is_local {
        SsrfPolicy::local_only()
    } else {
        SsrfPolicy::allow_private_networks()
    };
    validate_provider_url(&base_url, &policy)
        .map_err(|e| CliError::user(format!("invalid base URL: {e}")))?;

    let requested_chat_model = args.chat_model.clone();

    // An isolated profile must never collide with the desktop-shared
    // keychain entry for the same provider kind: the default id, unlike an
    // explicit --profile-id, is scoped by the data dir itself when
    // isolated, so the single most common invocation shape (no
    // --profile-id) can never silently read/overwrite the shared profile's
    // credential. Deterministic (same --data-dir -> same id across runs),
    // so `config init --force` against the same isolated profile still
    // targets the same keychain entry.
    let profile_id = args.profile_id.clone().unwrap_or_else(|| {
        if paths.isolated {
            isolated_profile_id(descriptor.profile_id_slug, &paths.config_dir)
        } else {
            descriptor.profile_id_slug.to_string()
        }
    });
    let profile_label = args
        .profile_label
        .clone()
        .unwrap_or_else(|| descriptor.default_label.to_string());

    // Resolved (read into memory) here so a missing env var / unreadable
    // file fails before anything else runs, but NOT stored anywhere yet —
    // see this module's `run_init` doc comment for why storing is deferred
    // to the very end of the whole command.
    let direct_file_ref = args
        .api_key_file_ref
        .as_deref()
        .map(file_secret_ref)
        .transpose()
        .map_err(|error| CliError::user(error.to_string()))?;
    let secret = if let Some(reference) = direct_file_ref.as_deref() {
        read_file_secret_ref(reference).map_err(|error| CliError::user(error.to_string()))?
    } else {
        resolve_credential(args, descriptor.needs_api_key, interactive, stdin, stderr)?
    };
    let credential_configured = secret.is_some();

    let want_check = if args.check_connection {
        true
    } else if interactive {
        ask_yes_no(
            stdin,
            stderr,
            "Discover available models and test the connection now? (catalog request only; never corpus content)",
            true,
        )?
    } else {
        false
    };

    // The profile holds a reference only. Direct protected files keep their
    // exact `file:` reference; imported values use the deterministic Keychain
    // reference and are written only at the end of `run_init`.
    let api_key_ref = direct_file_ref
        .clone()
        .or_else(|| secret.as_ref().map(|_| key_ref_for_profile(&profile_id)));
    let provisional_model = requested_chat_model.clone().unwrap_or_else(|| {
        if matches!(kind, ProviderKind::Ollama) {
            "mistral".into()
        } else {
            "catalog-probe".into()
        }
    });
    let mut profile = ProviderProfile {
        id: profile_id.clone(),
        label: profile_label,
        kind,
        base_url,
        api_key_ref,
        chat_model: provisional_model,
        embedding_model: None,
        embedding_base_url: None,
        capabilities: descriptor.default_capabilities,
        local_only: descriptor.is_local,
        deadline_preference: ProviderDeadlinePreference::Auto,
    };
    let (probe_summary, catalog_models) = if want_check {
        let (verdict, models) =
            provider_probe::probe_provider_catalog(&profile, secret.clone(), paths.isolated).await;
        (Some(verdict.summary()), models)
    } else {
        (None, Vec::new())
    };
    profile.chat_model = choose_setup_chat_model(
        requested_chat_model,
        kind,
        interactive,
        &catalog_models,
        stdin,
        stderr,
    )?;

    let timezone = if let Some(tz) = &args.default_timezone {
        if !is_valid_iana_timezone(tz) {
            return Err(CliError::user(format!(
                "{tz:?} is not a recognized IANA timezone"
            )));
        }
        Some(tz.clone())
    } else if interactive {
        let raw = ask_line(
            stdin,
            stderr,
            "Default timezone for ambiguous local timestamps (blank = leave unset, IANA id e.g. America/Chicago)",
        )?;
        if raw.is_empty() {
            None
        } else if is_valid_iana_timezone(&raw) {
            Some(raw)
        } else {
            return Err(CliError::user(format!(
                "{raw:?} is not a recognized IANA timezone"
            )));
        }
    } else {
        None
    };

    let mut cfg = app_cfg.clone();
    cfg.providers.profiles.retain(|p| p.id != profile.id);
    cfg.providers.profiles.push(profile.clone());
    cfg.providers.active_id = Some(profile.id.clone());
    if let Some(tz) = &timezone {
        cfg.default_timezone = Some(tz.clone());
    }

    Ok(ProviderSetupResult {
        cfg,
        profile_id,
        kind_label: descriptor.default_label,
        credential_configured,
        secret,
        persist_secret: direct_file_ref.is_none(),
        credential_source: if direct_file_ref.is_some() {
            "protected_file"
        } else if credential_configured {
            "keychain"
        } else {
            "none"
        },
        timezone,
        probe_summary,
        catalog_models,
    })
}

fn choose_setup_chat_model(
    requested: Option<String>,
    kind: ProviderKind,
    interactive: bool,
    catalog_models: &[String],
    stdin: &io::Stdin,
    stderr: &mut io::Stderr,
) -> CliResult<String> {
    if let Some(model) = requested.map(|model| model.trim().to_string()) {
        if model.is_empty() {
            return Err(CliError::user("a chat model id is required"));
        }
        return Ok(model);
    }
    if !interactive {
        if matches!(kind, ProviderKind::Ollama) {
            return Ok("mistral".into());
        }
        return Err(CliError::user(
            "--chat-model is required in --non-interactive mode; run `contextdesk models discover` to inspect the catalog",
        ));
    }

    let mut candidates = catalog_models
        .iter()
        .filter(|model| {
            matches!(
                cd_core::model_role_hints::classify_model_role(model).role,
                cd_core::model_role_hints::ModelRoleHint::Investigator
                    | cd_core::model_role_hints::ModelRoleHint::Unknown
            )
        })
        .cloned()
        .collect::<Vec<_>>();
    candidates = cd_core::model_role_hints::sort_ids_for_chat_picker(&candidates);
    if !candidates.is_empty() {
        if candidates.len() > 20 {
            let filter = ask_line(
                stdin,
                stderr,
                "The gateway has many chat candidates. Filter model ids (blank = first 20 recommended)",
            )?;
            if !filter.is_empty() {
                let needle = filter.to_ascii_lowercase();
                candidates.retain(|model| model.to_ascii_lowercase().contains(&needle));
            }
            candidates.truncate(20);
        }
        if !candidates.is_empty() {
            writeln!(
                stderr,
                "Available chat candidates (role suggested by name):"
            )
            .map_err(|error| CliError::internal(error.to_string()))?;
            for (index, model) in candidates.iter().enumerate() {
                writeln!(stderr, "  {}) {model}", index + 1)
                    .map_err(|error| CliError::internal(error.to_string()))?;
            }
            let answer = ask_line(
                stdin,
                stderr,
                "Choose a model number or enter an exact model id",
            )?;
            if let Ok(index) = answer.parse::<usize>() {
                if let Some(model) = index.checked_sub(1).and_then(|index| candidates.get(index)) {
                    return Ok(model.clone());
                }
                return Err(CliError::user(
                    "model selection is outside the displayed list",
                ));
            }
            if !answer.is_empty() {
                return Ok(answer);
            }
        }
    }

    let default = if matches!(kind, ProviderKind::Ollama) {
        "mistral"
    } else {
        ""
    };
    let prompt = if default.is_empty() {
        "Chat model id"
    } else {
        "Chat model id (default mistral)"
    };
    let answer = ask_line(stdin, stderr, prompt)?;
    let model = if answer.is_empty() { default } else { &answer };
    if model.trim().is_empty() {
        return Err(CliError::user("a chat model id is required"));
    }
    Ok(model.trim().to_string())
}

/// A deterministic id suffix scoped to `config_dir`, so an isolated
/// profile's default (no explicit `--profile-id`) keychain entry can never
/// collide with the desktop-shared default for the same provider kind, and
/// two isolated profiles at different `--data-dir` values never collide
/// with each other either. Not a cryptographic hash — collision-worthy
/// only if two different data dirs happened to hash identically, which is
/// not a security boundary here (the keychain entry itself is), only a
/// convenience default a caller can always override with `--profile-id`.
fn isolated_profile_id(slug: &str, config_dir: &Path) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let canonical = std::fs::canonicalize(config_dir).unwrap_or_else(|_| config_dir.to_path_buf());
    let mut hasher = DefaultHasher::new();
    canonical.hash(&mut hasher);
    format!("{slug}-{:08x}", hasher.finish() as u32)
}

/// Collect an API key without ever accepting it as a literal CLI flag value
/// (which would leak via shell history / `ps`): an environment variable
/// name, a file path, or a single stdin line — read exactly once, handed
/// back to the caller to store in the keychain, then dropped.
fn resolve_credential(
    args: &ConfigInitArgs,
    needs_api_key: bool,
    interactive: bool,
    stdin: &io::Stdin,
    stderr: &mut io::Stderr,
) -> CliResult<Option<String>> {
    if let Some(name) = &args.api_key_env {
        let v = std::env::var(name)
            .map_err(|_| CliError::user(format!("environment variable {name} is not set")))?;
        return Ok(non_empty(v));
    }
    if let Some(path) = &args.api_key_file {
        let raw = std::fs::read_to_string(path)
            .map_err(|e| CliError::user(format!("reading {}: {e}", path.display())))?;
        return Ok(non_empty(raw));
    }
    if args.api_key_stdin {
        return Ok(non_empty(read_stdin_line(stdin)?));
    }
    if !needs_api_key || !interactive {
        return Ok(None);
    }

    let choice = ask_enum(
        stdin,
        stderr,
        "Credential source",
        &["env", "file", "stdin", "skip"],
        "skip",
    )?;
    match choice.as_str() {
        "env" => {
            let name = ask_line(stdin, stderr, "Environment variable name")?;
            if name.is_empty() {
                return Err(CliError::user("environment variable name required"));
            }
            let v = std::env::var(&name)
                .map_err(|_| CliError::user(format!("environment variable {name} is not set")))?;
            Ok(non_empty(v))
        }
        "file" => {
            let path = ask_line(stdin, stderr, "Path to file containing the key")?;
            if path.is_empty() {
                return Err(CliError::user("file path required"));
            }
            let raw = std::fs::read_to_string(&path)
                .map_err(|e| CliError::user(format!("reading {path}: {e}")))?;
            Ok(non_empty(raw))
        }
        "stdin" => Ok(non_empty(read_stdin_line(stdin)?)),
        _ => Ok(None),
    }
}

fn read_stdin_line(stdin: &io::Stdin) -> CliResult<String> {
    let mut line = String::new();
    stdin
        .read_line(&mut line)
        .map_err(|e| CliError::internal(e.to_string()))?;
    Ok(line.trim().to_string())
}

/// `None` for blank/whitespace-only input; otherwise the value with
/// incidental leading/trailing whitespace stripped — applied uniformly
/// regardless of source (env var, file, stdin) so a credential set via a
/// wrapper script or a sourced `.env` file isn't silently stored padded
/// while the same value via `--api-key-file`/`--api-key-stdin` would not
/// have been.
fn non_empty(s: String) -> Option<String> {
    let trimmed = s.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn provider_kind_from_arg(arg: ProviderKindArg) -> ProviderKind {
    match arg {
        ProviderKindArg::Ollama => ProviderKind::Ollama,
        ProviderKindArg::OpenAiCompatible => ProviderKind::OpenAiCompatible,
        ProviderKindArg::Anthropic => ProviderKind::Anthropic,
        ProviderKindArg::XaiGrokBuild => ProviderKind::XaiGrokBuild,
    }
}

fn parse_provider_kind(s: &str) -> CliResult<ProviderKind> {
    match s {
        "ollama" => Ok(ProviderKind::Ollama),
        "openai-compatible" => Ok(ProviderKind::OpenAiCompatible),
        "anthropic" => Ok(ProviderKind::Anthropic),
        "xai-grok-build" => Ok(ProviderKind::XaiGrokBuild),
        _ => Err(CliError::user(format!(
            "{s:?} is not a known provider kind"
        ))),
    }
}

/// Every wizard prompt writes here, never to stdout: stdout is reserved for
/// the final `--json`/`--jsonl` envelope, and interactive mode is reachable
/// in that output mode too (auto-detected from whether stdin is a tty,
/// independent of `--format`).
fn ask_line(stdin: &io::Stdin, stderr: &mut io::Stderr, prompt: &str) -> CliResult<String> {
    write!(stderr, "{prompt}: ").map_err(|e| CliError::internal(e.to_string()))?;
    stderr
        .flush()
        .map_err(|e| CliError::internal(e.to_string()))?;
    let mut line = String::new();
    stdin
        .read_line(&mut line)
        .map_err(|e| CliError::internal(e.to_string()))?;
    Ok(line.trim().to_string())
}

fn ask_enum(
    stdin: &io::Stdin,
    stderr: &mut io::Stderr,
    prompt: &str,
    options: &[&str],
    default: &str,
) -> CliResult<String> {
    let answer = ask_line(
        stdin,
        stderr,
        &format!("{prompt} [{}] (default {default})", options.join("/")),
    )?;
    if answer.is_empty() {
        return Ok(default.to_string());
    }
    if options.contains(&answer.as_str()) {
        Ok(answer)
    } else {
        Err(CliError::user(format!(
            "{answer:?} is not one of {options:?}"
        )))
    }
}

fn ask_yes_no(
    stdin: &io::Stdin,
    stderr: &mut io::Stderr,
    prompt: &str,
    default: bool,
) -> CliResult<bool> {
    let default_str = if default { "Y/n" } else { "y/N" };
    let raw = ask_line(stdin, stderr, &format!("{prompt} [{default_str}]"))?;
    if raw.is_empty() {
        return Ok(default);
    }
    match raw.to_lowercase().as_str() {
        "y" | "yes" => Ok(true),
        "n" | "no" => Ok(false),
        _ => Err(CliError::user(format!("{raw:?} is not y/n"))),
    }
}

trait ParseChoice {
    fn parse_output_format(&self) -> crate::config::OutputFormat;
    fn parse_color_mode(&self) -> crate::config::ColorMode;
}

impl ParseChoice for str {
    fn parse_output_format(&self) -> crate::config::OutputFormat {
        match self {
            "json" => crate::config::OutputFormat::Json,
            "jsonl" => crate::config::OutputFormat::Jsonl,
            _ => crate::config::OutputFormat::Text,
        }
    }

    fn parse_color_mode(&self) -> crate::config::ColorMode {
        match self {
            "always" => crate::config::ColorMode::Always,
            "never" => crate::config::ColorMode::Never,
            _ => crate::config::ColorMode::Auto,
        }
    }
}

/// In-process unit tests for `configure_provider_profile` and `run_init` —
/// deliberately NOT exercised through the compiled binary (see
/// `crates/cd-cli/tests/cli_isolation.rs`'s module doc comment): calling
/// the production functions directly with an injected `MemorySecretStore`
/// proves the exact same credential-handling code path as a real
/// `--api-key-env` run, without ever touching the real OS keychain (which
/// can block a headless run on a GUI authorization prompt).
#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::ProviderKindArg;
    use cd_core::keychain_store::MemorySecretStore;

    /// Every field explicit, defaulted to "do nothing beyond the base
    /// wizard" — each test overrides only what it needs, so a field added
    /// to `ConfigInitArgs` later has to be given an explicit inert default
    /// here rather than silently inheriting one.
    fn base_args() -> ConfigInitArgs {
        ConfigInitArgs {
            project: false,
            interactive: false,
            non_interactive: true,
            force: false,
            format: None,
            color: None,
            default_provider_profile: None,
            skip_provider: false,
            provider_kind: None,
            base_url: None,
            chat_model: None,
            default_timezone: None,
            profile_id: None,
            profile_label: None,
            api_key_env: None,
            api_key_file: None,
            api_key_file_ref: None,
            api_key_stdin: false,
            check_connection: false,
        }
    }

    fn isolated_paths() -> (tempfile::TempDir, Paths) {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::resolve(Some(dir.path()), None).unwrap();
        assert!(paths.isolated);
        (dir, paths)
    }

    /// `configure_provider_profile` resolves and returns the credential but
    /// must never store it itself — storing is `run_init`'s job, deferred
    /// until after both config files are written (see this module's
    /// `run_init` doc comment). The keychain reference it computes must
    /// still be deterministic and already embedded in the returned
    /// `AppConfig`, even though nothing has landed in the secret store yet.
    #[tokio::test]
    async fn configure_provider_profile_resolves_the_credential_but_defers_storing_it() {
        let env_var = "CD_CONFIG_CMD_TEST_KEY_DEFERRED";
        std::env::set_var(env_var, "sk-in-process-test-secret");
        let (_dir, paths) = isolated_paths();
        let mut args = base_args();
        args.provider_kind = Some(ProviderKindArg::OpenAiCompatible);
        args.base_url = Some("http://127.0.0.1:1/v1".into());
        args.chat_model = Some("test-model".into());
        args.profile_id = Some("test-profile-deferred".into());
        args.api_key_env = Some(env_var.into());

        let secrets = MemorySecretStore::new();
        let stdin = io::stdin();
        let mut stderr = io::stderr();
        let result = configure_provider_profile(
            &args,
            false,
            &paths,
            &AppConfig::default(),
            &stdin,
            &mut stderr,
        )
        .await
        .expect("provider setup must succeed");
        std::env::remove_var(env_var);

        assert!(result.credential_configured);
        assert_eq!(result.secret.as_deref(), Some("sk-in-process-test-secret"));
        let serialized = serde_json::to_string(&result.cfg).expect("AppConfig serializes");
        assert!(
            !serialized.contains("sk-in-process-test-secret"),
            "the secret must never appear in the serialized AppConfig, deferred or not"
        );
        let key_ref = key_ref_for_profile("test-profile-deferred");
        assert!(
            serialized.contains(&key_ref),
            "the keychain reference must already be recorded in AppConfig"
        );
        assert_eq!(
            secrets.get(&key_ref).unwrap(),
            None,
            "configure_provider_profile must not itself write to the secret store"
        );
    }

    /// The end-to-end guarantee: after a full successful `run_init`, the
    /// credential really has landed in the secret store, and neither
    /// on-disk config file contains it.
    #[tokio::test]
    async fn run_init_stores_the_credential_only_after_both_config_files_are_written() {
        let env_var = "CD_CONFIG_CMD_TEST_KEY_LANDS";
        std::env::set_var(env_var, "sk-should-land-in-keychain");
        let (dir, paths) = isolated_paths();
        let mut args = base_args();
        args.provider_kind = Some(ProviderKindArg::OpenAiCompatible);
        args.base_url = Some("http://127.0.0.1:1/v1".into());
        args.chat_model = Some("test-model".into());
        args.profile_id = Some("test-profile-lands".into());
        args.api_key_env = Some(env_var.into());

        let secrets = MemorySecretStore::new();
        run_init(&args, &paths, dir.path(), &AppConfig::default(), &secrets)
            .await
            .expect("run_init must succeed");
        std::env::remove_var(env_var);

        let key_ref = key_ref_for_profile("test-profile-lands");
        assert_eq!(
            secrets.get(&key_ref).unwrap().as_deref(),
            Some("sk-should-land-in-keychain"),
            "the credential must actually reach the secret store by the end of run_init"
        );
        let app_config_text = std::fs::read_to_string(&paths.app_config_path).unwrap();
        assert!(!app_config_text.contains("sk-should-land-in-keychain"));
        assert!(app_config_text.contains(&key_ref));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn run_init_can_keep_a_protected_file_without_touching_keychain_store() {
        use std::os::unix::fs::PermissionsExt;

        let (dir, paths) = isolated_paths();
        let credential_path = dir.path().join("vercel.key");
        std::fs::write(&credential_path, "synthetic-file-credential\n").unwrap();
        std::fs::set_permissions(&credential_path, std::fs::Permissions::from_mode(0o600)).unwrap();

        let mut args = base_args();
        args.provider_kind = Some(ProviderKindArg::OpenAiCompatible);
        args.base_url = Some("http://127.0.0.1:1/v1".into());
        args.chat_model = Some("test-model".into());
        args.profile_id = Some("test-profile-file-ref".into());
        args.api_key_file_ref = Some(credential_path.clone());

        let secrets = MemorySecretStore::new();
        let out = run_init(&args, &paths, dir.path(), &AppConfig::default(), &secrets)
            .await
            .expect("protected-file setup must succeed");

        let key_ref = key_ref_for_profile("test-profile-file-ref");
        assert_eq!(
            secrets.get(&key_ref).unwrap(),
            None,
            "direct protected-file setup must not import into the secret store"
        );
        let cfg = cd_core::config::load_config(&paths.app_config_path).unwrap();
        let profile = cfg.providers.active().unwrap();
        let expected_reference = format!("file:{}", credential_path.display());
        assert_eq!(
            profile.api_key_ref.as_deref(),
            Some(expected_reference.as_str())
        );
        let rendered = out.render_json();
        assert_eq!(rendered["credential_source"], "protected_file");
        let serialized = std::fs::read_to_string(&paths.app_config_path).unwrap();
        assert!(!serialized.contains("synthetic-file-credential"));
    }

    /// A rejected value (invalid timezone) must abort `run_init` before
    /// either config file is written AND before the credential is stored —
    /// proving the full command, not just one function inside it, can never
    /// leave an orphaned secret in the keychain for a run that produced no
    /// saved config.
    #[tokio::test]
    async fn a_rejected_timezone_leaves_no_config_and_no_stored_credential() {
        let env_var = "CD_CONFIG_CMD_TEST_KEY_REJECTED";
        std::env::set_var(env_var, "sk-should-never-be-stored");
        let (dir, paths) = isolated_paths();
        let mut args = base_args();
        args.provider_kind = Some(ProviderKindArg::OpenAiCompatible);
        args.base_url = Some("http://127.0.0.1:1/v1".into());
        args.chat_model = Some("test-model".into());
        args.profile_id = Some("test-profile-rejected".into());
        args.api_key_env = Some(env_var.into());
        args.default_timezone = Some("Not/A_Real_Zone".into());

        let secrets = MemorySecretStore::new();
        // `Box<dyn Render>` isn't `Debug`, so `expect_err` (which requires
        // the Ok type to be Debug) can't be used here.
        let err = match run_init(&args, &paths, dir.path(), &AppConfig::default(), &secrets).await {
            Err(e) => e,
            Ok(_) => panic!("an invalid IANA timezone must be rejected"),
        };
        std::env::remove_var(env_var);

        assert_eq!(err.category, crate::envelope::ExitCategory::UserError);
        assert!(!err.message.contains("sk-should-never-be-stored"));
        let key_ref = key_ref_for_profile("test-profile-rejected");
        assert_eq!(
            secrets.get(&key_ref).unwrap(),
            None,
            "a rejected run must never leave the credential in the secret store"
        );
        assert!(!paths.app_config_path.exists());
        assert!(!global_config_path(&paths.config_dir).exists());
    }

    /// `--default-timezone` must land on AppConfig even when the caller
    /// skips every provider step (`--skip-provider` / no `--provider-kind`).
    #[tokio::test]
    async fn default_timezone_works_with_skip_provider() {
        let (dir, paths) = isolated_paths();
        let mut args = base_args();
        args.skip_provider = true;
        args.default_timezone = Some("America/Chicago".into());

        let secrets = MemorySecretStore::new();
        let out = run_init(&args, &paths, dir.path(), &AppConfig::default(), &secrets)
            .await
            .expect("timezone-only init must succeed");
        let json = out.render_json();
        assert_eq!(json["default_timezone"], "America/Chicago");
        assert!(json.get("provider_profile_id").is_none() || json["provider_profile_id"].is_null());

        let cfg = cd_core::config::load_config(&paths.app_config_path)
            .expect("app config must be written");
        assert_eq!(
            cfg.default_timezone.as_deref(),
            Some("America/Chicago"),
            "AppConfig.default_timezone must be set without any provider profile"
        );
        assert!(cfg.providers.profiles.is_empty());
    }

    /// A provider kind that doesn't need a key (Ollama) must never touch
    /// the secret store at all, even when `configure_provider_profile` runs
    /// to completion.
    #[tokio::test]
    async fn a_provider_needing_no_key_never_touches_the_secret_store() {
        let (_dir, paths) = isolated_paths();
        let mut args = base_args();
        args.provider_kind = Some(ProviderKindArg::Ollama);
        args.chat_model = Some("llama3".into());
        args.profile_id = Some("test-profile-no-key".into());

        let stdin = io::stdin();
        let mut stderr = io::stderr();
        let result = configure_provider_profile(
            &args,
            false,
            &paths,
            &AppConfig::default(),
            &stdin,
            &mut stderr,
        )
        .await
        .expect("ollama with no credential flags must succeed");

        assert!(!result.credential_configured);
        assert!(result.secret.is_none());
        let profile = result
            .cfg
            .providers
            .active()
            .expect("an active profile must be set");
        assert!(profile.api_key_ref.is_none());
    }

    /// The isolation-collision fix: an isolated profile with no explicit
    /// `--profile-id` must never default to the same id (and therefore the
    /// same keychain entry) the desktop-shared profile would use — and two
    /// isolated profiles at two different `--data-dir` values must not
    /// collide with each other either. Re-running against the SAME
    /// `--data-dir` must still be deterministic (same id every time), so a
    /// repeat `config init` targets the same keychain entry it created
    /// before.
    #[tokio::test]
    async fn isolated_default_profile_ids_are_scoped_by_data_dir_and_deterministic() {
        let (_dir_a, paths_a) = isolated_paths();
        let (_dir_b, paths_b) = isolated_paths();

        let mut args = base_args();
        args.provider_kind = Some(ProviderKindArg::Anthropic);
        args.chat_model = Some("claude".into());

        let stdin = io::stdin();
        let mut stderr = io::stderr();
        let result_a = configure_provider_profile(
            &args,
            false,
            &paths_a,
            &AppConfig::default(),
            &stdin,
            &mut stderr,
        )
        .await
        .expect("isolated profile A must succeed");
        let result_a_again = configure_provider_profile(
            &args,
            false,
            &paths_a,
            &AppConfig::default(),
            &stdin,
            &mut stderr,
        )
        .await
        .expect("re-running against the same data dir must succeed");
        let result_b = configure_provider_profile(
            &args,
            false,
            &paths_b,
            &AppConfig::default(),
            &stdin,
            &mut stderr,
        )
        .await
        .expect("isolated profile B must succeed");

        assert_ne!(
            result_a.profile_id, "anthropic",
            "an isolated profile must never default to the shared profile's id"
        );
        assert_eq!(
            result_a.profile_id, result_a_again.profile_id,
            "the same --data-dir must deterministically produce the same default id"
        );
        assert_ne!(
            result_a.profile_id, result_b.profile_id,
            "two different --data-dir values must never default to the same id"
        );
    }

    /// The xai-grok-build isolation fix: `--check-connection` for this kind
    /// must be refused (not silently run) when the profile is isolated,
    /// since `cd_core::discovery::probe_provider` reads the real
    /// `~/.grok/auth.json` for this kind regardless of any key passed to
    /// it. This test never touches that file — the guard must short-circuit
    /// before `discovery::probe_provider` is ever called.
    #[tokio::test]
    async fn xai_grok_build_check_connection_is_refused_when_isolated() {
        let (_dir, paths) = isolated_paths();
        let mut args = base_args();
        args.provider_kind = Some(ProviderKindArg::XaiGrokBuild);
        args.chat_model = Some("grok-4".into());
        args.check_connection = true;

        let stdin = io::stdin();
        let mut stderr = io::stderr();
        let result = configure_provider_profile(
            &args,
            false,
            &paths,
            &AppConfig::default(),
            &stdin,
            &mut stderr,
        )
        .await
        .expect("must still succeed — the check is skipped, not an error");

        let check = result
            .probe_summary
            .expect("--check-connection must still populate a summary");
        assert!(
            check.contains("skipped"),
            "an isolated profile must refuse to probe a Grok Build session: {check}"
        );
    }

    /// A credential sourced via `--api-key-env` must be trimmed exactly
    /// like `--api-key-file`/`--api-key-stdin` already are — incidental
    /// whitespace from a wrapper script or a sourced `.env` file must not
    /// be silently stored as part of the key.
    #[tokio::test]
    async fn env_var_credential_is_trimmed_like_file_and_stdin_credentials() {
        let env_var = "CD_CONFIG_CMD_TEST_KEY_PADDED";
        std::env::set_var(env_var, "  sk-padded-value  ");
        let (_dir, paths) = isolated_paths();
        let mut args = base_args();
        args.provider_kind = Some(ProviderKindArg::OpenAiCompatible);
        args.base_url = Some("http://127.0.0.1:1/v1".into());
        args.chat_model = Some("test-model".into());
        args.profile_id = Some("test-profile-padded".into());
        args.api_key_env = Some(env_var.into());

        let stdin = io::stdin();
        let mut stderr = io::stderr();
        let result = configure_provider_profile(
            &args,
            false,
            &paths,
            &AppConfig::default(),
            &stdin,
            &mut stderr,
        )
        .await
        .expect("provider setup must succeed");
        std::env::remove_var(env_var);

        assert_eq!(
            result.secret.as_deref(),
            Some("sk-padded-value"),
            "leading/trailing whitespace from the environment variable must be trimmed"
        );
    }
}
