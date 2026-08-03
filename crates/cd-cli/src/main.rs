mod adapters;
mod cli;
mod commands;
mod config;
mod envelope;
mod progress;

use clap::Parser;
use cli::{Cli, Command};
use config::{CliOverrides, OutputFormat, ResolvedConfig};
use envelope::{CliError, Envelope, Render};
use std::path::PathBuf;

#[tokio::main]
async fn main() {
    let cli = Cli::parse();
    let code = run(cli).await;
    std::process::exit(code);
}

async fn run(cli: Cli) -> i32 {
    let paths = match adapters::Paths::resolve(cli.global.app_config.as_deref()) {
        Ok(p) => p,
        Err(e) => return emit_bare_error(&e),
    };

    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let project_path = cli
        .global
        .config
        .clone()
        .unwrap_or_else(|| config::project_config_path(&cwd));

    let global_layer = match config::load_layer(&config::global_config_path(&paths.config_dir)) {
        Ok(l) => l,
        Err(e) => return emit_bare_error(&e),
    };
    let project_layer = match config::load_layer(&project_path) {
        Ok(l) => l,
        Err(e) => return emit_bare_error(&e),
    };

    let format_override = if cli.global.json {
        Some(OutputFormat::Json)
    } else if cli.global.jsonl {
        Some(OutputFormat::Jsonl)
    } else {
        cli.global.format
    };
    let overrides = CliOverrides {
        output_format: format_override,
        color: cli.global.color,
        default_provider_profile: cli.global.profile.clone(),
        default_chat_model: cli.global.model.clone(),
        import_embed: None,
    };
    let resolved = config::resolve(global_layer.as_ref(), project_layer.as_ref(), &overrides);
    let format = resolved.output_format.value;

    let app_cfg = match adapters::load_app_config(&paths) {
        Ok(c) => c,
        Err(e) => return emit_error(format, "startup", e),
    };
    let mut cli_state = match cd_workflow::session::load_cli_state(&paths.cli_state_dir) {
        Ok(s) => s,
        Err(e) => return emit_error(format, "startup", CliError::internal(e.to_string())),
    };

    let result = dispatch(
        &cli.command,
        &paths,
        &app_cfg,
        &resolved,
        &project_path,
        format,
        &mut cli_state,
    )
    .await;

    if let Err(e) = cd_workflow::session::save_cli_state(&paths.cli_state_dir, &cli_state) {
        eprintln!("warning: failed to persist CLI state: {e}");
    }

    result
}

#[allow(clippy::too_many_arguments)]
async fn dispatch(
    command: &Command,
    paths: &adapters::Paths,
    app_cfg: &cd_core::config::AppConfig,
    resolved: &ResolvedConfig,
    project_path: &std::path::Path,
    format: OutputFormat,
    cli_state: &mut cd_workflow::session::CliState,
) -> i32 {
    match command {
        Command::Import(args) => {
            let result = commands::import::run(args, &paths.cache_root, app_cfg, format).await;
            if let Ok(outcome) = &result {
                cli_state.set_current_corpus(outcome.corpus_id.clone());
            }
            emit(format, "import", result)
        }
        Command::Corpus { action } => {
            let result = commands::corpus::run(action, &paths.cache_root);
            if matches!(action, cli::CorpusAction::Use { .. }) {
                if let Ok(output) = &result {
                    cli_state.set_current_corpus(extract_corpus_id(output));
                }
            }
            emit(format, "corpus", result)
        }
        Command::Timezone { action } => {
            let result =
                commands::timezone::run(action, &paths.cache_root, &cli_state.current_corpus_id);
            emit(format, "timezone", result)
        }
        Command::Explore(args) => {
            let result =
                commands::explore::run(args, &paths.cache_root, &cli_state.current_corpus_id);
            emit(format, "explore", result)
        }
        Command::Context(args) => {
            let result =
                commands::context::run(args, &paths.cache_root, &cli_state.current_corpus_id);
            emit(format, "context", result)
        }
        Command::Session { action } => {
            let store = adapters::session_store(paths);
            let result = commands::session::run(action, &store);
            emit(format, "session", result)
        }
        Command::Chat(args) => {
            let secrets = adapters::secret_store();
            let sessions = adapters::session_store(paths);
            let result = commands::chat::run(
                args,
                &paths.cache_root,
                &secrets,
                app_cfg,
                &sessions,
                cli_state,
                format,
                resolved.default_provider_profile.value.as_deref(),
                resolved.default_chat_model.value.as_deref(),
            )
            .await;
            match result {
                Ok(()) => 0,
                Err(e) => emit_error(format, "chat", e),
            }
        }
        Command::Config { action } => {
            let result = commands::config_cmd::run(
                action,
                &paths.config_dir,
                &std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
                Some(project_path),
                resolved,
            );
            emit(format, "config", result)
        }
        Command::Capabilities => emit(
            format,
            "capabilities",
            Ok(commands::capabilities::run(&paths.branding)),
        ),
    }
}

fn extract_corpus_id(output: &dyn Render) -> String {
    output
        .render_json()
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string()
}

fn emit<T: Render>(
    format: OutputFormat,
    command: &'static str,
    result: Result<T, CliError>,
) -> i32 {
    match result {
        Ok(value) => {
            match format {
                OutputFormat::Text => println!("{}", value.render_text()),
                OutputFormat::Json | OutputFormat::Jsonl => {
                    let envelope = Envelope::ok(command, value.render_json());
                    println!(
                        "{}",
                        serde_json::to_string(&envelope).expect("Envelope is always serializable")
                    );
                }
            }
            0
        }
        Err(error) => emit_error(format, command, error),
    }
}

fn emit_error(format: OutputFormat, command: &'static str, error: CliError) -> i32 {
    match format {
        OutputFormat::Text => eprintln!("error: {error}"),
        OutputFormat::Json | OutputFormat::Jsonl => {
            let envelope = Envelope::<()>::err(command, &error);
            println!(
                "{}",
                serde_json::to_string(&envelope).expect("Envelope is always serializable")
            );
        }
    }
    error.category.code()
}

/// Startup failed before any output-format resolution was possible (e.g.
/// the config directory itself could not be created) — fall back to plain
/// stderr text since we cannot know whether the caller wanted JSON.
fn emit_bare_error(error: &CliError) -> i32 {
    eprintln!("error: {error}");
    error.category.code()
}
