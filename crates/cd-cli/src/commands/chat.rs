//! `contextdesk chat` — the second half of the configured happy path.
//! Every decision (provider resolution, corpus binding, the actual model
//! turn, citation enforcement, session persistence) happens in
//! `cd_workflow::chat::run_chat_workflow` — the SAME entry point the
//! desktop app's `agent_turn` Tauri command is meant to call. This module
//! is only the CLI's rendering and permission-prompt strategy around it.

use crate::cli::ChatArgs;
use crate::config::OutputFormat;
use crate::envelope::{CliError, CliResult, Envelope, StreamLine};
use cd_core::config::AppConfig;
use cd_core::events::StreamEvent;
use cd_core::keychain_store::SecretStore;
use cd_core::permissions::PermissionDecision;
use cd_core::sessions::SessionStore;
use cd_workflow::chat::{run_chat_workflow, ChatWorkflowRequest};
use cd_workflow::session::CliState;
use serde::Serialize;
use std::io::{self, IsTerminal, Write};
use std::path::Path;

#[derive(Debug, Serialize)]
struct ChatSummary<'a> {
    session_id: &'a str,
    final_text: &'a str,
}

#[allow(clippy::too_many_arguments)]
pub async fn run(
    args: &ChatArgs,
    cache_root: &Path,
    secrets: &dyn SecretStore,
    cfg: &AppConfig,
    sessions: &SessionStore,
    cli_state: &mut CliState,
    format: OutputFormat,
    profile_override: Option<&str>,
    model_override: Option<&str>,
) -> CliResult<()> {
    let corpus_id = args
        .corpus
        .clone()
        .or_else(|| cli_state.current_corpus_id.clone());
    let session_id = if args.new {
        None
    } else {
        args.session
            .clone()
            .or_else(|| cli_state.current_session_id.clone())
    };

    let mut host = crate::adapters::tool_host(cache_root)?;

    let stdout_is_tty = io::stdout().is_terminal();
    let jsonl = matches!(format, OutputFormat::Jsonl);
    let text = matches!(format, OutputFormat::Text);

    let mut live_sink = |event: StreamEvent| {
        if jsonl {
            emit_jsonl(&event);
        } else if text {
            if let StreamEvent::TextDelta { text } = &event {
                print!("{text}");
                let _ = io::stdout().flush();
            }
        }
    };

    let auto_approve = args.auto_approve;
    let decide_permission = |tool_name: &str,
                             target: &str,
                             reason: &str,
                             preview: &str,
                             risk: &str| {
        if auto_approve {
            return PermissionDecision::AllowOnce;
        }
        if !stdout_is_tty || !io::stdin().is_terminal() {
            eprintln!(
                "permission denied (non-interactive, no --auto-approve): {tool_name} wants {target} ({reason}, risk={risk})"
            );
            return PermissionDecision::Deny;
        }
        eprintln!("\n{tool_name} wants to act on {target}");
        eprintln!("  reason: {reason}");
        eprintln!("  risk:   {risk}");
        if !preview.is_empty() {
            eprintln!("  preview: {preview}");
        }
        eprint!("Allow once? [y/N] ");
        let _ = io::stderr().flush();
        let mut answer = String::new();
        let _ = io::stdin().read_line(&mut answer);
        if answer.trim().eq_ignore_ascii_case("y") {
            PermissionDecision::AllowOnce
        } else {
            PermissionDecision::Deny
        }
    };

    let outcome = run_chat_workflow(
        &mut host,
        secrets,
        cfg,
        sessions,
        cache_root,
        session_id.as_deref(),
        &args.question,
        ChatWorkflowRequest {
            corpus_id: corpus_id.as_deref(),
            explicit_profile_id: profile_override,
            chat_model_override: model_override,
        },
        None,
        Some(&mut live_sink),
        decide_permission,
    )
    .await
    .map_err(|e| {
        let message = e.to_string();
        if message.contains("provider") || message.contains("connect") || message.contains("http") {
            CliError::provider(message)
        } else {
            CliError::internal(message)
        }
    })?;

    cli_state.current_session_id = Some(outcome.session_id.clone());
    if let Some(corpus_id) = &corpus_id {
        cli_state.current_corpus_id = Some(corpus_id.clone());
    }

    match format {
        OutputFormat::Text => {
            if !outcome.final_text.is_empty() {
                println!();
            }
            eprintln!("(session {})", outcome.session_id);
        }
        OutputFormat::Jsonl => {
            let done = StreamLine::Done {
                ok: true,
                session_id: &outcome.session_id,
                final_text: &outcome.final_text,
            };
            println!(
                "{}",
                serde_json::to_string(&done).expect("StreamLine is always serializable")
            );
        }
        OutputFormat::Json => {
            let envelope = Envelope::ok(
                "chat",
                ChatSummary {
                    session_id: &outcome.session_id,
                    final_text: &outcome.final_text,
                },
            );
            println!(
                "{}",
                serde_json::to_string(&envelope).expect("Envelope is always serializable")
            );
        }
    }

    Ok(())
}

fn emit_jsonl(event: &StreamEvent) {
    let line = match event {
        StreamEvent::TextDelta { text } => Some(StreamLine::TextDelta { text }),
        StreamEvent::Tool {
            name, ok, summary, ..
        } => Some(StreamLine::Tool {
            name,
            ok: ok.unwrap_or(false),
            summary,
        }),
        StreamEvent::PermissionRequired {
            tool_name,
            target,
            reason,
            risk,
            ..
        } => Some(StreamLine::PermissionRequired {
            tool_name,
            target,
            reason,
            risk,
        }),
        StreamEvent::TurnCompleted { reason } => Some(StreamLine::TurnCompleted { reason }),
        StreamEvent::Error { code, message } => Some(StreamLine::Error { code, message }),
        _ => None,
    };
    if let Some(line) = line {
        println!(
            "{}",
            serde_json::to_string(&line).expect("StreamLine is always serializable")
        );
    }
}
