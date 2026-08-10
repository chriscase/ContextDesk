mod activity_render;
mod adapters;
mod answer_render;
mod cli;
mod commands;
mod config;
mod envelope;
mod human_hierarchy;
mod presentation;
mod progress;
mod provider_probe;
mod render;

use clap::Parser;
use cli::{Cli, Command, InvocationMode};
use config::{CliOverrides, OutputFormat, ResolvedConfig};
use envelope::{CliError, Envelope, ExitCategory, Render};
use std::path::PathBuf;

#[tokio::main]
async fn main() {
    let (args, invocation) = cli::normalize_invocation_args(std::env::args_os());
    let cli = Cli::parse_from(args);
    if let Command::Chat(args) = &cli.command {
        let format = if cli.global.json {
            OutputFormat::Json
        } else if cli.global.jsonl {
            OutputFormat::Jsonl
        } else {
            cli.global.format.unwrap_or(OutputFormat::Text)
        };
        if let Err(error) = commands::chat::validate_question(args, format) {
            std::process::exit(error.category.code());
        }
    }
    let code = run(cli, invocation).await;
    std::process::exit(code);
}

async fn run(cli: Cli, invocation: InvocationMode) -> i32 {
    if let Some(code) = run_state_free(&cli).await {
        return code;
    }
    let paths = match adapters::Paths::resolve(
        cli.global.data_dir.as_deref(),
        cli.global.app_config.as_deref(),
    ) {
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
        invocation,
        cli.global.deadline.as_deref(),
    )
    .await;

    if let Err(e) = cd_workflow::session::save_cli_state(&paths.cli_state_dir, &cli_state) {
        eprintln!("warning: failed to persist CLI state: {e}");
    }

    result
}

/// Commands in this lane are pure over explicit inputs and must not resolve,
/// read, create, migrate, or save ContextDesk application/CLI state.
async fn run_state_free(cli: &Cli) -> Option<i32> {
    let format = if cli.global.json {
        OutputFormat::Json
    } else if cli.global.jsonl {
        OutputFormat::Jsonl
    } else {
        cli.global.format.unwrap_or(OutputFormat::Text)
    };
    let color = cli.global.color.unwrap_or(config::ColorMode::Auto);
    match &cli.command {
        Command::Normalize(args) => {
            let result = commands::normalize::run(args, format, color).await;
            let verdict = result
                .as_ref()
                .is_ok_and(|output| output.fail_on_partial)
                .then_some(ExitCategory::Partial);
            Some(emit_completed(format, color, "normalize", result, verdict))
        }
        Command::Normalized { action } => {
            let result = commands::normalized::run(action, format, color).await;
            let verdict = result
                .as_ref()
                .is_ok_and(|output| !output.is_conforming())
                .then_some(ExitCategory::NonConforming);
            Some(emit_completed(format, color, "normalized", result, verdict))
        }
        Command::Capabilities => Some(emit(
            format,
            color,
            "capabilities",
            Ok(commands::capabilities::run(
                &cd_core::branding::Branding::embedded(),
            )),
        )),
        Command::Eval { action } => {
            let result = commands::eval::run(action);
            let verdict = result
                .as_ref()
                .ok()
                .filter(|output| output.failed_verdict())
                .map(|_| ExitCategory::NotReady);
            Some(emit_completed(format, color, "eval", result, verdict))
        }
        _ => None,
    }
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
    invocation: InvocationMode,
    // Global `--deadline` for chat only; other commands ignore it.
    deadline_override: Option<&str>,
) -> i32 {
    match command {
        Command::Import(args) => {
            let result = commands::import::run(
                args,
                &paths.cache_root,
                app_cfg,
                format,
                resolved.color.value,
            )
            .await;
            if let Ok(outcome) = &result {
                cli_state.set_current_corpus(outcome.corpus_id.clone());
            }
            emit(format, resolved.color.value, "import", result)
        }
        Command::Normalize(_) | Command::Normalized { .. } | Command::Eval { .. } => {
            unreachable!("state-free commands return before stateful dispatch")
        }
        Command::Corpus { action } => {
            let result = commands::corpus::run(action, &paths.cache_root);
            if matches!(action, cli::CorpusAction::Use { .. }) {
                if let Ok(output) = &result {
                    cli_state.set_current_corpus(extract_corpus_id(output));
                }
            }
            emit(format, resolved.color.value, "corpus", result)
        }
        Command::Timezone { action } => {
            let result =
                commands::timezone::run(action, &paths.cache_root, &cli_state.current_corpus_id);
            emit(format, resolved.color.value, "timezone", result)
        }
        Command::Explore(args) => {
            let result =
                commands::explore::run(args, &paths.cache_root, &cli_state.current_corpus_id);
            emit(format, resolved.color.value, "explore", result)
        }
        Command::Context(args) => {
            let result =
                commands::context::run(args, &paths.cache_root, &cli_state.current_corpus_id);
            emit(format, resolved.color.value, "context", result)
        }
        Command::Session { action } => {
            let store = adapters::session_store(paths);
            let result = commands::session::run(action, &store);
            emit(format, resolved.color.value, "session", result)
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
                resolved.color.value,
                resolved.default_provider_profile.value.as_deref(),
                resolved.default_chat_model.value.as_deref(),
                invocation == InvocationMode::ImplicitChat,
                deadline_override,
            )
            .await;
            match result {
                Ok(()) => 0,
                // `commands::chat::run` already wrote the correct terminal
                // JSONL shape on failure (`StreamLine::Error` +
                // `StreamLine::Done{ok:false}`) before returning this `Err` —
                // the generic one-shot `Envelope` `emit_error` would print
                // is not `StreamLine`-tagged and would break "every stdout
                // line under --jsonl is StreamLine-shaped." Text-mode
                // failures and cancellations are likewise already fully
                // self-rendered by `chat_renderer.finish(...)` (the concise
                // `done`/`cancelled`/`failed` status line) before returning
                // this `Err` — a second `emit_error` line would duplicate
                // it. JSON chat failures may now include the same bounded
                // Activity prefix captured before a provider failure, so the
                // chat command also owns that one-shot failure envelope.
                Err(e)
                    if format == OutputFormat::Jsonl
                        || format == OutputFormat::Json
                        || format == OutputFormat::Text =>
                {
                    e.category.code()
                }
                Err(e) => emit_error(format, "chat", e),
            }
        }
        Command::Config { action } => {
            let secrets = adapters::secret_store();
            let result = commands::config_cmd::run(
                action,
                paths,
                &std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
                Some(project_path),
                resolved,
                app_cfg,
                &secrets,
            )
            .await;
            emit(format, resolved.color.value, "config", result)
        }
        Command::Confluence { action } => {
            let result = commands::confluence_cmd::run(action, paths, app_cfg).await;
            emit(format, resolved.color.value, "confluence", result)
        }
        Command::Capabilities => unreachable!("capabilities is state-free"),
        Command::Doctor(args) => {
            let secrets = adapters::secret_store();
            let sessions = adapters::session_store(paths);
            let result = commands::doctor::run(
                args,
                paths,
                app_cfg,
                &secrets,
                &sessions,
                format,
                resolved.default_provider_profile.value.as_deref(),
                resolved.default_chat_model.value.as_deref(),
            )
            .await;
            match result {
                // `commands::doctor::run` already rendered every check line
                // and the terminal verdict line itself (mirroring `chat`'s
                // own bespoke streaming path) — the exit code reflects the
                // READINESS verdict, not merely "did the command run,"
                // which is why this doesn't go through the shared `emit`.
                Ok(ready) => {
                    if ready {
                        0
                    } else {
                        ExitCategory::NotReady.code()
                    }
                }
                // `commands::doctor::run` already printed its own
                // `DoctorLine::Interrupted` terminal line for `--jsonl`
                // before returning this `Err` (the only way this path is
                // reached at all — see that function's doc comment) —
                // exactly the same reason `chat`'s Jsonl error path skips
                // the generic envelope.
                Err(e) if format == OutputFormat::Jsonl => e.category.code(),
                Err(e) => emit_error(format, "doctor", e),
            }
        }
        Command::LoggingAssessment(args) => {
            let result = commands::logging_assessment::run(
                args,
                &paths.cache_root,
                &cli_state.current_corpus_id,
            );
            emit(format, resolved.color.value, "logging_assessment", result)
        }
        Command::ExceptionEpisodes(args) => {
            let result = commands::exception_episodes::run(
                args,
                &paths.cache_root,
                &cli_state.current_corpus_id,
            );
            emit(format, resolved.color.value, "exception_episodes", result)
        }
        Command::RetrievalStatus(args) => {
            let secrets = adapters::secret_store();
            let result = commands::retrieval_status::run(
                args,
                &paths.cache_root,
                app_cfg,
                &cli_state.current_corpus_id,
                &secrets,
            );
            emit(format, resolved.color.value, "retrieval_status", result)
        }
        Command::Models(args) => {
            let secrets = adapters::secret_store();
            let result = commands::models::run(
                args,
                paths,
                app_cfg,
                resolved.default_provider_profile.value.as_deref(),
                resolved.default_chat_model.value.as_deref(),
                &secrets,
            )
            .await;
            emit(format, resolved.color.value, "models", result)
        }
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
    color: config::ColorMode,
    command: &'static str,
    result: Result<T, CliError>,
) -> i32 {
    match result {
        Ok(value) => {
            match format {
                OutputFormat::Text => {
                    println!("{}", presentation::present(&value.render_text(), color))
                }
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

fn emit_completed<T: Render>(
    format: OutputFormat,
    color: config::ColorMode,
    command: &'static str,
    result: Result<T, CliError>,
    verdict: Option<ExitCategory>,
) -> i32 {
    let code = emit(format, color, command, result);
    completed_verdict_exit(code, verdict)
}

fn completed_verdict_exit(base_code: i32, verdict: Option<ExitCategory>) -> i32 {
    if base_code == 0 {
        verdict.map_or(0, ExitCategory::code)
    } else {
        base_code
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

#[cfg(test)]
mod verdict_tests {
    use super::*;

    #[test]
    fn completed_verdict_never_masks_an_execution_error() {
        assert_eq!(completed_verdict_exit(0, None), 0);
        assert_eq!(
            completed_verdict_exit(0, Some(ExitCategory::NonConforming)),
            9
        );
        assert_eq!(completed_verdict_exit(0, Some(ExitCategory::Partial)), 10);
        assert_eq!(completed_verdict_exit(70, Some(ExitCategory::Partial)), 70);
    }
}
