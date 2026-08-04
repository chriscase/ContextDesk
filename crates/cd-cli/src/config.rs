//! The CLI's own versioned TOML configuration.
//!
//! This is deliberately a SEPARATE file from `cd_core::config::AppConfig`
//! (the shared JSON config both hosts read for provider profiles and the
//! configured default timezone — see [`crate::adapters::Paths`]). Provider
//! profiles and secrets are never duplicated here; this file only holds
//! CLI-specific behavior preferences (output shape, color, which provider
//! profile a bare `contextdesk chat` should prefer). A CLI is legitimately
//! file/flag-configured the way `cd-server` already is (its own doc
//! comment says so) — AGENTS.md's "Settings-first" non-negotiable governs
//! the *desktop* happy path, not a terminal tool.
//!
//! Precedence, lowest to highest:
//! 1. compiled-in defaults
//! 2. global config (`~/.contextdesk/cli.toml`)
//! 3. explicitly selected project config (`./.contextdesk.toml` in the
//!    current directory, or a path passed via `--config`)
//! 4. environment variables (`CONTEXTDESK_*`)
//! 5. CLI flags
//!
//! Layers 4 and 5 are folded into one by `clap`'s `env` attribute on each
//! flag (a flag wins over its paired env var when both are present); this
//! module only has to merge "defaults < global < project" and then let the
//! already-resolved CLI value win last.

use crate::envelope::{CliError, CliResult};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Schema version for `cli.toml` / `.contextdesk.toml`.
pub const CLI_CONFIG_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, clap::ValueEnum)]
#[serde(rename_all = "snake_case")]
#[value(rename_all = "snake_case")]
pub enum OutputFormat {
    Text,
    Json,
    Jsonl,
}

impl std::fmt::Display for OutputFormat {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            OutputFormat::Text => "text",
            OutputFormat::Json => "json",
            OutputFormat::Jsonl => "jsonl",
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, clap::ValueEnum)]
#[serde(rename_all = "snake_case")]
#[value(rename_all = "snake_case")]
pub enum ColorMode {
    Auto,
    Always,
    Never,
}

impl std::fmt::Display for ColorMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            ColorMode::Auto => "auto",
            ColorMode::Always => "always",
            ColorMode::Never => "never",
        })
    }
}

/// One layer of config as written on disk — every field optional, since
/// "absent" (fall through to the next layer) is meaningfully different
/// from "set to the default value" only at the resolution step, not here.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CliConfigFile {
    #[serde(default)]
    pub schema_version: u32,
    #[serde(default)]
    pub output: OutputSection,
    #[serde(default)]
    pub workflow: WorkflowSection,
    #[serde(default)]
    pub import: ImportSection,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct OutputSection {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<OutputFormat>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<ColorMode>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct WorkflowSection {
    /// Provider profile id a bare `contextdesk chat` should use. Empty /
    /// absent falls through to `AppConfig`'s active profile, then the
    /// zero-config local Ollama default — never a credential, only an id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_provider_profile: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_chat_model: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ImportSection {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub embed: Option<bool>,
}

impl CliConfigFile {
    fn migrate(&mut self) {
        if self.schema_version < CLI_CONFIG_SCHEMA_VERSION {
            self.schema_version = CLI_CONFIG_SCHEMA_VERSION;
        }
    }
}

/// Concrete values after applying every layer, plus where each came from —
/// `config show` renders the provenance so a confusing effective value is
/// debuggable instead of mysterious.
#[derive(Debug, Clone, Serialize)]
pub struct ResolvedConfig {
    pub output_format: Field<OutputFormat>,
    pub color: Field<ColorMode>,
    pub default_provider_profile: Field<Option<String>>,
    pub default_chat_model: Field<Option<String>>,
    pub import_embed: Field<bool>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Field<T: Serialize> {
    pub value: T,
    pub source: &'static str,
}

fn pick<T: Clone + Serialize>(layers: &[(&'static str, Option<T>)]) -> Field<T> {
    for (source, value) in layers.iter().rev() {
        if let Some(value) = value {
            return Field {
                value: value.clone(),
                source,
            };
        }
    }
    unreachable!("caller must supply a default-layer entry that is always Some")
}

/// Everything a fully-parsed `clap` invocation may have supplied — already
/// folding env (layer 4) under flags (layer 5) via `clap`'s own `env`
/// attribute, so this struct only represents "the CLI-resolved value, if
/// the user set it any way at all."
#[derive(Debug, Clone, Default)]
pub struct CliOverrides {
    pub output_format: Option<OutputFormat>,
    pub color: Option<ColorMode>,
    pub default_provider_profile: Option<String>,
    pub default_chat_model: Option<String>,
    pub import_embed: Option<bool>,
}

pub fn global_config_path(config_dir: &Path) -> PathBuf {
    config_dir.join("cli.toml")
}

pub fn project_config_path(cwd: &Path) -> PathBuf {
    cwd.join(".contextdesk.toml")
}

/// Load and parse one config layer; `Ok(None)` when the file does not
/// exist (an absent layer is not an error at any layer).
pub fn load_layer(path: &Path) -> CliResult<Option<CliConfigFile>> {
    if !path.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(path)
        .map_err(|e| CliError::internal(format!("read {}: {e}", path.display())))?;
    let mut parsed: CliConfigFile = toml::from_str(&raw)
        .map_err(|e| CliError::user(format!("invalid config at {}: {e}", path.display())))?;
    parsed.migrate();
    Ok(Some(parsed))
}

/// Atomically write one config layer, always stamped with the current
/// schema version.
pub fn save_layer(path: &Path, cfg: &CliConfigFile) -> CliResult<()> {
    let mut cfg = cfg.clone();
    cfg.migrate();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| CliError::internal(format!("create {}: {e}", parent.display())))?;
    }
    let raw = toml::to_string_pretty(&cfg)
        .map_err(|e| CliError::internal(format!("serialize config: {e}")))?;
    let tmp = path.with_extension("toml.tmp");
    std::fs::write(&tmp, raw)
        .map_err(|e| CliError::internal(format!("write {}: {e}", tmp.display())))?;
    std::fs::rename(&tmp, path)
        .map_err(|e| CliError::internal(format!("publish {}: {e}", path.display())))?;
    Ok(())
}

/// Merge every layer into concrete, sourced values.
pub fn resolve(
    global: Option<&CliConfigFile>,
    project: Option<&CliConfigFile>,
    cli: &CliOverrides,
) -> ResolvedConfig {
    let default_format = Some(OutputFormat::Text);
    let default_color = Some(ColorMode::Auto);
    let default_embed = Some(false);

    ResolvedConfig {
        output_format: pick(&[
            ("default", default_format),
            ("global", global.and_then(|c| c.output.format)),
            ("project", project.and_then(|c| c.output.format)),
            ("cli", cli.output_format),
        ]),
        color: pick(&[
            ("default", default_color),
            ("global", global.and_then(|c| c.output.color)),
            ("project", project.and_then(|c| c.output.color)),
            ("cli", cli.color),
        ]),
        default_provider_profile: pick(&[
            ("default", Some(None)),
            (
                "global",
                global.map(|c| c.workflow.default_provider_profile.clone()),
            ),
            (
                "project",
                project.map(|c| c.workflow.default_provider_profile.clone()),
            ),
            ("cli", cli.default_provider_profile.clone().map(Some)),
        ]),
        default_chat_model: pick(&[
            ("default", Some(None)),
            (
                "global",
                global.map(|c| c.workflow.default_chat_model.clone()),
            ),
            (
                "project",
                project.map(|c| c.workflow.default_chat_model.clone()),
            ),
            ("cli", cli.default_chat_model.clone().map(Some)),
        ]),
        import_embed: pick(&[
            ("default", default_embed),
            ("global", global.and_then(|c| c.import.embed)),
            ("project", project.and_then(|c| c.import.embed)),
            ("cli", cli.import_embed),
        ]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn absent_layers_resolve_to_compiled_in_defaults() {
        let resolved = resolve(None, None, &CliOverrides::default());
        assert_eq!(resolved.output_format.value, OutputFormat::Text);
        assert_eq!(resolved.output_format.source, "default");
        assert_eq!(resolved.color.value, ColorMode::Auto);
        assert!(!resolved.import_embed.value);
    }

    #[test]
    fn precedence_is_default_then_global_then_project_then_cli() {
        let global = CliConfigFile {
            output: OutputSection {
                format: Some(OutputFormat::Json),
                color: None,
            },
            ..CliConfigFile::default()
        };
        let project = CliConfigFile {
            output: OutputSection {
                format: Some(OutputFormat::Jsonl),
                color: None,
            },
            ..CliConfigFile::default()
        };

        // Global alone beats the default.
        let resolved = resolve(Some(&global), None, &CliOverrides::default());
        assert_eq!(resolved.output_format.value, OutputFormat::Json);
        assert_eq!(resolved.output_format.source, "global");

        // Project beats global.
        let resolved = resolve(Some(&global), Some(&project), &CliOverrides::default());
        assert_eq!(resolved.output_format.value, OutputFormat::Jsonl);
        assert_eq!(resolved.output_format.source, "project");

        // A CLI-resolved (env-or-flag) value beats everything.
        let cli = CliOverrides {
            output_format: Some(OutputFormat::Text),
            ..CliOverrides::default()
        };
        let resolved = resolve(Some(&global), Some(&project), &cli);
        assert_eq!(resolved.output_format.value, OutputFormat::Text);
        assert_eq!(resolved.output_format.source, "cli");
    }

    #[test]
    fn round_trips_through_disk_and_stamps_schema_version() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("cli.toml");
        let cfg = CliConfigFile {
            output: OutputSection {
                format: Some(OutputFormat::Json),
                color: Some(ColorMode::Never),
            },
            workflow: WorkflowSection {
                default_provider_profile: Some("ollama-local".into()),
                default_chat_model: None,
            },
            import: ImportSection { embed: Some(true) },
            ..CliConfigFile::default()
        };
        save_layer(&path, &cfg).unwrap();
        let loaded = load_layer(&path).unwrap().expect("file exists");
        assert_eq!(loaded.schema_version, CLI_CONFIG_SCHEMA_VERSION);
        assert_eq!(loaded.output.format, Some(OutputFormat::Json));
        assert_eq!(
            loaded.workflow.default_provider_profile.as_deref(),
            Some("ollama-local")
        );
        assert_eq!(loaded.import.embed, Some(true));
    }

    #[test]
    fn a_config_without_schema_version_loads_and_is_stamped() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("cli.toml");
        std::fs::write(&path, "[output]\nformat = \"json\"\n").unwrap();
        let loaded = load_layer(&path).unwrap().expect("file exists");
        assert_eq!(loaded.schema_version, CLI_CONFIG_SCHEMA_VERSION);
        assert_eq!(loaded.output.format, Some(OutputFormat::Json));
    }

    #[test]
    fn absent_file_loads_as_none_not_an_error() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("does-not-exist.toml");
        assert!(load_layer(&path).unwrap().is_none());
    }

    #[test]
    fn malformed_toml_is_a_user_error_not_internal() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("cli.toml");
        std::fs::write(&path, "this is not [valid toml").unwrap();
        let err = load_layer(&path).unwrap_err();
        assert_eq!(err.category, crate::envelope::ExitCategory::UserError);
    }
}
