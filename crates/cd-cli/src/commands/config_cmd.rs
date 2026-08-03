//! `contextdesk config` — init / validate / show / path for the CLI's own
//! TOML config (see [`crate::config`] for the schema and precedence rules).

use crate::cli::{ConfigAction, ConfigInitArgs};
use crate::config::{
    global_config_path, load_layer, project_config_path, save_layer, CliConfigFile, ImportSection,
    OutputSection, ResolvedConfig, WorkflowSection,
};
use crate::envelope::{CliError, CliResult, Render};
use serde::Serialize;
use std::io::{self, IsTerminal, Write};
use std::path::Path;

#[derive(Debug, Serialize)]
pub struct InitOutput {
    pub path: String,
    pub created: bool,
}

impl Render for InitOutput {
    fn render_text(&self) -> String {
        format!(
            "{} {}",
            if self.created { "wrote" } else { "updated" },
            self.path
        )
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

pub fn run(
    action: &ConfigAction,
    config_dir: &Path,
    cwd: &Path,
    explicit_project_path: Option<&Path>,
    resolved: &ResolvedConfig,
) -> CliResult<Box<dyn Render>> {
    match action {
        ConfigAction::Init(args) => run_init(args, config_dir, cwd),
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
                global: global_config_path(config_dir).display().to_string(),
                project_exists: project.exists(),
                project: project.display().to_string(),
            }))
        }
    }
}

fn run_init(args: &ConfigInitArgs, config_dir: &Path, cwd: &Path) -> CliResult<Box<dyn Render>> {
    let path = if args.project {
        project_config_path(cwd)
    } else {
        global_config_path(config_dir)
    };
    if path.exists() && !args.force {
        return Err(CliError::user(format!(
            "{} already exists — pass --force to overwrite",
            path.display()
        )));
    }

    let interactive = args.interactive || (!args.non_interactive && io::stdin().is_terminal());

    let cfg = if interactive {
        prompt_wizard(args)?
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

    let created = !path.exists();
    save_layer(&path, &cfg)?;
    Ok(Box::new(InitOutput {
        path: path.display().to_string(),
        created,
    }))
}

fn prompt_wizard(args: &ConfigInitArgs) -> CliResult<CliConfigFile> {
    let stdin = io::stdin();
    let mut stdout = io::stdout();

    let format = args.format.unwrap_or(
        ask_enum(
            &stdin,
            &mut stdout,
            "Output format",
            &["text", "json", "jsonl"],
            "text",
        )?
        .parse_output_format(),
    );
    let color = args.color.unwrap_or(
        ask_enum(
            &stdin,
            &mut stdout,
            "Color",
            &["auto", "always", "never"],
            "auto",
        )?
        .parse_color_mode(),
    );
    let profile = if args.default_provider_profile.is_some() {
        args.default_provider_profile.clone()
    } else {
        let raw = ask_line(
            &stdin,
            &mut stdout,
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
