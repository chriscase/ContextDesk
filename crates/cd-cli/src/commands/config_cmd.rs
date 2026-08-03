//! `contextdesk config` — init / validate / show / path.
//!
//! `init` writes to two SEPARATE files, and this module is the only place
//! that ever writes either of them from a wizard:
//! - `cli.toml` (this crate's own [`crate::config`] schema) — CLI-only
//!   behavior preferences (output format, color, the CLI's profile pointer).
//! - the shared `AppConfig` (`cd_core::config`, same file the desktop app
//!   reads/writes) — provider profiles (keychain refs only, never a raw
//!   secret) and the configured default timezone.
//!
//! Data-location configuration is report-only here: `--data-dir` /
//! `--profile-dir` is a global flag resolved once in `main.rs` before any
//! command runs (see [`crate::adapters::Paths`]), so by the time this
//! wizard runs the location is already fixed — it can only tell the user
//! what was chosen, never choose it itself (there is nothing to read a
//! saved choice from until a config file exists at that location).

use crate::adapters::{save_app_config, Paths};
use crate::cli::{ConfigAction, ConfigInitArgs, ProviderKindArg};
use crate::config::{
    global_config_path, load_layer, project_config_path, save_layer, CliConfigFile, ImportSection,
    OutputSection, ResolvedConfig, WorkflowSection,
};
use crate::envelope::{CliError, CliResult, Render};
use cd_core::config::{is_valid_iana_timezone, AppConfig};
use cd_core::discovery::{self, ProbeOutcome};
use cd_core::keychain_store::{key_ref_for_profile, SecretStore};
use cd_core::providers::{
    descriptor_for, ProviderDeadlinePreference, ProviderKind, ProviderProfile,
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
    pub default_timezone: Option<String>,
    /// Human-readable outcome of the optional connectivity check — never
    /// present unless `--check-connection` (or its interactive prompt) was
    /// accepted.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connectivity_check: Option<String>,
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
                    "configured (keychain reference only)"
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
    }
}

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
    let mut stdout = io::stdout();

    let cli_cfg = if interactive {
        prompt_wizard(args, paths, &stdin, &mut stdout)?
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
        ask_yes_no(&stdin, &mut stdout, "Configure an AI provider now?", true)?
    } else {
        args.provider_kind.is_some()
    };

    let provider_setup = if configure_provider {
        Some(
            configure_provider_profile(args, interactive, app_cfg, secrets, &stdin, &mut stdout)
                .await?,
        )
    } else {
        None
    };

    // Both layers are fully built (and every validation has already run)
    // before either write happens — a rejected timezone or URL never
    // leaves a half-written cli.toml behind.
    let created = !path.exists();
    save_layer(&path, &cli_cfg)?;
    if let Some(setup) = &provider_setup {
        save_app_config(paths, &setup.cfg)?;
    }

    Ok(Box::new(InitOutput {
        path: path.display().to_string(),
        created,
        data_dir: paths.config_dir.display().to_string(),
        isolated: paths.isolated,
        provider_profile_id: provider_setup.as_ref().map(|s| s.profile_id.clone()),
        provider_kind: provider_setup.as_ref().map(|s| s.kind_label.to_string()),
        credential_configured: provider_setup.as_ref().map(|s| s.credential_configured),
        default_timezone: provider_setup.as_ref().and_then(|s| s.timezone.clone()),
        connectivity_check: provider_setup
            .as_ref()
            .and_then(|s| s.probe_summary.clone()),
    }))
}

fn prompt_wizard(
    args: &ConfigInitArgs,
    paths: &Paths,
    stdin: &io::Stdin,
    stdout: &mut io::Stdout,
) -> CliResult<CliConfigFile> {
    writeln!(
        stdout,
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
            stdout,
            "Output format",
            &["text", "json", "jsonl"],
            "text",
        )?
        .parse_output_format(),
    );
    let color = args.color.unwrap_or(
        ask_enum(stdin, stdout, "Color", &["auto", "always", "never"], "auto")?.parse_color_mode(),
    );
    let profile = if args.default_provider_profile.is_some() {
        args.default_provider_profile.clone()
    } else {
        let raw = ask_line(
            stdin,
            stdout,
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
#[derive(Debug)]
struct ProviderSetupResult {
    cfg: AppConfig,
    profile_id: String,
    kind_label: &'static str,
    credential_configured: bool,
    timezone: Option<String>,
    probe_summary: Option<String>,
}

async fn configure_provider_profile(
    args: &ConfigInitArgs,
    interactive: bool,
    app_cfg: &AppConfig,
    secrets: &dyn SecretStore,
    stdin: &io::Stdin,
    stdout: &mut io::Stdout,
) -> CliResult<ProviderSetupResult> {
    let kind = match args.provider_kind {
        Some(k) => provider_kind_from_arg(k),
        None if interactive => parse_provider_kind(&ask_enum(
            stdin,
            stdout,
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
        let raw = ask_line(stdin, stdout, &prompt)?;
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

    let chat_model = if let Some(m) = &args.chat_model {
        m.clone()
    } else if interactive {
        let default = if matches!(kind, ProviderKind::Ollama) {
            "mistral"
        } else {
            ""
        };
        let prompt = if default.is_empty() {
            "Chat model".to_string()
        } else {
            format!("Chat model (default {default})")
        };
        let raw = ask_line(stdin, stdout, &prompt)?;
        if raw.is_empty() {
            default.to_string()
        } else {
            raw
        }
    } else if matches!(kind, ProviderKind::Ollama) {
        "mistral".to_string()
    } else {
        return Err(CliError::user(
            "--chat-model is required for this provider kind in --non-interactive mode",
        ));
    };
    if chat_model.trim().is_empty() {
        return Err(CliError::user("a chat model id is required"));
    }

    let profile_id = args
        .profile_id
        .clone()
        .unwrap_or_else(|| descriptor.profile_id_slug.to_string());
    let profile_label = args
        .profile_label
        .clone()
        .unwrap_or_else(|| descriptor.default_label.to_string());

    // Resolved (read into memory) here so a missing env var / unreadable
    // file fails before anything else runs, but NOT stored yet — storing
    // happens last, after every other validation, so a later rejection
    // (e.g. an invalid timezone below) can never leave an orphaned
    // credential in the keychain that no saved config ever references.
    let secret = resolve_credential(args, descriptor.needs_api_key, interactive, stdin, stdout)?;
    let credential_configured = secret.is_some();

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
            stdout,
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

    // The last question that can itself be rejected (an interactive
    // y/n typo) — resolved before the one fallible side effect below, so
    // a rejected answer here can never leave an orphaned credential in the
    // keychain with no saved config that references it.
    let want_check = if args.check_connection {
        true
    } else if interactive {
        ask_yes_no(
            stdin,
            stdout,
            "Test connection now? (sends only the base URL and, if configured, the key — never corpus content)",
            false,
        )?
    } else {
        false
    };

    // Every validation and every remaining prompt has already succeeded —
    // this is the last fallible step, and the only one with a side effect
    // outside this function's own return value.
    let api_key_ref = if let Some(secret) = &secret {
        let key_ref = key_ref_for_profile(&profile_id);
        secrets
            .set(&key_ref, secret)
            .map_err(|e| CliError::internal(format!("store credential: {e}")))?;
        Some(key_ref)
    } else {
        None
    };
    drop(secret);

    let profile = ProviderProfile {
        id: profile_id.clone(),
        label: profile_label,
        kind,
        base_url,
        api_key_ref,
        chat_model,
        embedding_model: None,
        embedding_base_url: None,
        capabilities: descriptor.default_capabilities,
        local_only: descriptor.is_local,
        deadline_preference: ProviderDeadlinePreference::Auto,
    };

    let mut cfg = app_cfg.clone();
    cfg.providers.profiles.retain(|p| p.id != profile.id);
    cfg.providers.profiles.push(profile.clone());
    cfg.providers.active_id = Some(profile.id.clone());
    if let Some(tz) = &timezone {
        cfg.default_timezone = Some(tz.clone());
    }

    let probe_summary = if want_check {
        let probe_key = match &profile.api_key_ref {
            Some(r) => secrets
                .get(r)
                .map_err(|e| CliError::internal(format!("read credential: {e}")))?,
            None => None,
        };
        Some(summarize_probe(
            discovery::probe_provider(&profile, probe_key).await,
        ))
    } else {
        None
    };

    Ok(ProviderSetupResult {
        cfg,
        profile_id,
        kind_label: descriptor.default_label,
        credential_configured,
        timezone,
        probe_summary,
    })
}

fn summarize_probe(outcome: ProbeOutcome) -> String {
    match outcome {
        ProbeOutcome::Reachable { reason } => format!("reachable ({reason})"),
        ProbeOutcome::KeyRejected { reason } => format!("key rejected ({reason})"),
        ProbeOutcome::Unreachable { reason } => format!("unreachable ({reason})"),
    }
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
    stdout: &mut io::Stdout,
) -> CliResult<Option<String>> {
    if let Some(name) = &args.api_key_env {
        let v = std::env::var(name)
            .map_err(|_| CliError::user(format!("environment variable {name} is not set")))?;
        return Ok(non_empty(v));
    }
    if let Some(path) = &args.api_key_file {
        let raw = std::fs::read_to_string(path)
            .map_err(|e| CliError::user(format!("reading {}: {e}", path.display())))?;
        return Ok(non_empty(raw.trim().to_string()));
    }
    if args.api_key_stdin {
        return Ok(non_empty(read_stdin_line(stdin)?));
    }
    if !needs_api_key || !interactive {
        return Ok(None);
    }

    let choice = ask_enum(
        stdin,
        stdout,
        "Credential source",
        &["env", "file", "stdin", "skip"],
        "skip",
    )?;
    match choice.as_str() {
        "env" => {
            let name = ask_line(stdin, stdout, "Environment variable name")?;
            if name.is_empty() {
                return Err(CliError::user("environment variable name required"));
            }
            let v = std::env::var(&name)
                .map_err(|_| CliError::user(format!("environment variable {name} is not set")))?;
            Ok(non_empty(v))
        }
        "file" => {
            let path = ask_line(stdin, stdout, "Path to file containing the key")?;
            if path.is_empty() {
                return Err(CliError::user("file path required"));
            }
            let raw = std::fs::read_to_string(&path)
                .map_err(|e| CliError::user(format!("reading {path}: {e}")))?;
            Ok(non_empty(raw.trim().to_string()))
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

fn non_empty(s: String) -> Option<String> {
    (!s.trim().is_empty()).then_some(s)
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

fn ask_line(stdin: &io::Stdin, stdout: &mut io::Stdout, prompt: &str) -> CliResult<String> {
    write!(stdout, "{prompt}: ").map_err(|e| CliError::internal(e.to_string()))?;
    stdout
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
    stdout: &mut io::Stdout,
    prompt: &str,
    options: &[&str],
    default: &str,
) -> CliResult<String> {
    let answer = ask_line(
        stdin,
        stdout,
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
    stdout: &mut io::Stdout,
    prompt: &str,
    default: bool,
) -> CliResult<bool> {
    let default_str = if default { "Y/n" } else { "y/N" };
    let raw = ask_line(stdin, stdout, &format!("{prompt} [{default_str}]"))?;
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

/// In-process unit tests for `configure_provider_profile` — deliberately
/// NOT exercised through the compiled binary (see
/// `crates/cd-cli/tests/cli_isolation.rs`'s module doc comment): calling
/// the production function directly with an injected `MemorySecretStore`
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
            api_key_stdin: false,
            check_connection: false,
        }
    }

    #[tokio::test]
    async fn credential_is_redacted_from_appconfig_and_lands_only_in_the_secret_store() {
        let env_var = "CD_CONFIG_CMD_TEST_KEY_REDACTION";
        std::env::set_var(env_var, "sk-in-process-test-secret");
        let mut args = base_args();
        args.provider_kind = Some(ProviderKindArg::OpenAiCompatible);
        args.base_url = Some("http://127.0.0.1:1/v1".into());
        args.chat_model = Some("test-model".into());
        args.profile_id = Some("test-profile-redaction".into());
        args.api_key_env = Some(env_var.into());

        let secrets = MemorySecretStore::new();
        let stdin = io::stdin();
        let mut stdout = io::stdout();
        let result = configure_provider_profile(
            &args,
            false,
            &AppConfig::default(),
            &secrets,
            &stdin,
            &mut stdout,
        )
        .await
        .expect("provider setup must succeed");
        std::env::remove_var(env_var);

        assert!(result.credential_configured);
        let serialized = serde_json::to_string(&result.cfg).expect("AppConfig serializes");
        assert!(
            !serialized.contains("sk-in-process-test-secret"),
            "the secret must never appear in the serialized AppConfig"
        );
        let key_ref = key_ref_for_profile("test-profile-redaction");
        assert!(
            serialized.contains(&key_ref),
            "a keychain reference must be recorded in AppConfig"
        );
        assert_eq!(
            secrets.get(&key_ref).unwrap().as_deref(),
            Some("sk-in-process-test-secret"),
            "the secret must actually reach the secret store, not be silently dropped"
        );
    }

    /// The write ordering fix: a later validation failure (an invalid
    /// timezone) must reject before the credential is ever stored — proving
    /// `configure_provider_profile` cannot leave an orphaned secret in the
    /// keychain for a run that never produces a saved config.
    #[tokio::test]
    async fn a_rejected_timezone_never_stores_the_credential() {
        let env_var = "CD_CONFIG_CMD_TEST_KEY_REJECTED";
        std::env::set_var(env_var, "sk-should-never-be-stored");
        let mut args = base_args();
        args.provider_kind = Some(ProviderKindArg::OpenAiCompatible);
        args.base_url = Some("http://127.0.0.1:1/v1".into());
        args.chat_model = Some("test-model".into());
        args.profile_id = Some("test-profile-rejected".into());
        args.api_key_env = Some(env_var.into());
        args.default_timezone = Some("Not/A_Real_Zone".into());

        let secrets = MemorySecretStore::new();
        let stdin = io::stdin();
        let mut stdout = io::stdout();
        let err = configure_provider_profile(
            &args,
            false,
            &AppConfig::default(),
            &secrets,
            &stdin,
            &mut stdout,
        )
        .await
        .expect_err("an invalid IANA timezone must be rejected");
        std::env::remove_var(env_var);

        assert_eq!(err.category, crate::envelope::ExitCategory::UserError);
        assert!(!err.message.contains("sk-should-never-be-stored"));
        let key_ref = key_ref_for_profile("test-profile-rejected");
        assert_eq!(
            secrets.get(&key_ref).unwrap(),
            None,
            "a rejected run must never leave the credential in the secret store"
        );
    }

    /// A provider kind that doesn't need a key (Ollama) must never touch
    /// the secret store at all, even when `configure_provider_profile` runs
    /// to completion.
    #[tokio::test]
    async fn a_provider_needing_no_key_never_touches_the_secret_store() {
        let mut args = base_args();
        args.provider_kind = Some(ProviderKindArg::Ollama);
        args.chat_model = Some("llama3".into());
        args.profile_id = Some("test-profile-no-key".into());

        let secrets = MemorySecretStore::new();
        let stdin = io::stdin();
        let mut stdout = io::stdout();
        let result = configure_provider_profile(
            &args,
            false,
            &AppConfig::default(),
            &secrets,
            &stdin,
            &mut stdout,
        )
        .await
        .expect("ollama with no credential flags must succeed");

        assert!(!result.credential_configured);
        let profile = result
            .cfg
            .providers
            .active()
            .expect("an active profile must be set");
        assert!(profile.api_key_ref.is_none());
    }
}
