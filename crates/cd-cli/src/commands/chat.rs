//! `contextdesk chat` — the second half of the configured happy path.
//! Every decision (provider resolution, corpus binding, the actual model
//! turn, citation enforcement, session persistence) happens in
//! `cd_workflow::chat::run_chat_workflow` — the SAME entry point the
//! desktop app's `agent_turn` Tauri command is meant to call. This module
//! is only the CLI's rendering and permission-prompt strategy around it,
//! plus `--dry-run` / `--trace` rendering, which reads
//! `cd_core::turn_trace` data the workflow call already produced rather
//! than deriving anything of its own.

use crate::cli::{ChatArgs, TraceLevel};
use crate::config::OutputFormat;
use crate::envelope::{
    CliError, CliResult, Envelope, StreamLine, TraceContextLine, TraceSummaryLine, TraceToolLine,
    TracedMessageLine,
};
use cd_core::config::AppConfig;
use cd_core::events::StreamEvent;
use cd_core::keychain_store::SecretStore;
use cd_core::permissions::PermissionDecision;
use cd_core::sessions::SessionStore;
use cd_core::turn_trace::{RecordingTurnTrace, TracedCall, TracedOutcome, TurnTraceSink};
use cd_workflow::chat::{run_chat_workflow, ChatWorkflowOutcome, ChatWorkflowRequest};
use cd_workflow::session::CliState;
use serde::Serialize;
use std::io::{self, IsTerminal, Write};
use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

#[derive(Debug, Serialize)]
struct ChatSummary<'a> {
    session_id: &'a str,
    final_text: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    trace: Option<Vec<StreamLine<'static>>>,
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
    // `full` exposes bounded, redacted conversation and tool-call content —
    // still never a secret or pre-redaction value, but real turn content
    // nonetheless. Refuse rather than let a script accidentally capture it.
    // Under `--jsonl` the streaming contract still applies: emit Error then
    // Done{ok:false} before returning (never empty stdout).
    if matches!(args.trace, Some(TraceLevel::Full)) && !args.trace_ack {
        let err = CliError::user(
            "refusing --trace full without --trace-ack — full trace exposes bounded, \
             redacted conversation and tool-call content; re-run with --trace-ack to confirm",
        );
        if matches!(format, OutputFormat::Jsonl) {
            print_jsonl_failure(&err);
        }
        return Err(err);
    }
    // A dry run with no explicit --trace would print nothing useful at all
    // (the dry-run backend never produces text) — default it to summary
    // rather than silently doing nothing.
    let effective_trace = args.trace.or(if args.dry_run {
        Some(TraceLevel::Summary)
    } else {
        None
    });

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

    let recorder = effective_trace.map(|_| Arc::new(RecordingTurnTrace::new()));
    let trace_sink: Option<Arc<dyn TurnTraceSink>> = recorder
        .clone()
        .map(|recorder| recorder as Arc<dyn TurnTraceSink>);

    let started = Instant::now();
    let result = run_chat_workflow(
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
            dry_run: args.dry_run,
            trace_sink,
        },
        None,
        Some(&mut live_sink),
        decide_permission,
    )
    .await
    .map_err(map_workflow_error);
    let elapsed_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);

    let outcome = match result {
        Ok(outcome) => outcome,
        Err(error) => {
            if jsonl {
                print_jsonl_failure(&error);
            }
            return Err(error);
        }
    };

    cli_state.current_session_id = Some(outcome.session_id.clone());
    if let Some(corpus_id) = &corpus_id {
        cli_state.current_corpus_id = Some(corpus_id.clone());
    }

    let trace_lines = match effective_trace {
        Some(level) => {
            let calls = recorder.as_ref().map(|r| r.calls()).unwrap_or_default();
            let budget_chars = host
                .model_context_budgets()
                .resolve(Some(&outcome.chat_model));
            Some(build_trace_lines(
                level,
                args.dry_run,
                corpus_id.as_deref(),
                &outcome,
                &calls,
                elapsed_ms,
                budget_chars,
            ))
        }
        None => None,
    };

    match format {
        OutputFormat::Text => {
            if !outcome.final_text.is_empty() {
                println!();
            }
            eprintln!("(session {})", outcome.session_id);
            if let Some(lines) = &trace_lines {
                for line in lines {
                    println!("{}", serde_json::to_string_pretty(line).unwrap_or_default());
                }
            }
        }
        OutputFormat::Jsonl => {
            if let Some(lines) = &trace_lines {
                for line in lines {
                    println!(
                        "{}",
                        serde_json::to_string(line).expect("StreamLine is always serializable")
                    );
                }
            }
            let done = crate::envelope::StreamLine::Done {
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
                    trace: trace_lines,
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

fn map_workflow_error(e: cd_core::error::CoreError) -> CliError {
    let message = e.to_string();
    if message.contains("provider") || message.contains("connect") || message.contains("http") {
        CliError::provider(message)
    } else {
        CliError::internal(message)
    }
}

/// Terminal lines for a failed `--jsonl` streaming command: one
/// `StreamLine::Error` naming the failure, then `StreamLine::Done{ok:false}`.
/// The only place these two lines are constructed, so "every stdout line
/// under `--jsonl` is `StreamLine`-shaped, and the last one is `done`" holds
/// on failure exactly as it does on success. Any `StreamLine`s already
/// printed via `live_sink` before the failure (e.g. a mid-turn `Tool` or
/// `Error` event) are left as they were — this only supplies the missing
/// terminal shape, never rewrites what already streamed.
fn print_jsonl_failure(error: &CliError) {
    let error_line = crate::envelope::StreamLine::Error {
        code: error.category.kind(),
        message: &error.message,
    };
    println!(
        "{}",
        serde_json::to_string(&error_line).expect("StreamLine is always serializable")
    );
    let done = crate::envelope::StreamLine::Done {
        ok: false,
        // No session id is known on a failure that happened before one
        // could be resolved (e.g. an unknown --profile) — never fabricate one.
        session_id: "",
        final_text: "",
    };
    println!(
        "{}",
        serde_json::to_string(&done).expect("StreamLine is always serializable")
    );
}

fn emit_jsonl(event: &StreamEvent) {
    let line = match event {
        StreamEvent::TextDelta { text } => Some(crate::envelope::StreamLine::TextDelta { text }),
        StreamEvent::Tool {
            name,
            phase: cd_core::events::ToolPhase::Finished,
            ok,
            summary,
            ..
        } => Some(crate::envelope::StreamLine::Tool {
            name,
            ok: ok.unwrap_or(false),
            summary,
        }),
        // A Started event has no outcome yet. Rendering its absent `ok` as
        // false makes one successful tool call look like a failure followed
        // by a success. JSONL exposes only the terminal tool outcome; full
        // lifecycle detail remains available through trace_tool.
        StreamEvent::Tool { .. } => None,
        StreamEvent::PermissionRequired {
            tool_name,
            target,
            reason,
            risk,
            ..
        } => Some(crate::envelope::StreamLine::PermissionRequired {
            tool_name,
            target,
            reason,
            risk,
        }),
        StreamEvent::TurnCompleted { reason } => {
            Some(crate::envelope::StreamLine::TurnCompleted { reason })
        }
        StreamEvent::Error { code, message } => {
            Some(crate::envelope::StreamLine::Error { code, message })
        }
        _ => None,
    };
    if let Some(line) = line {
        println!(
            "{}",
            serde_json::to_string(&line).expect("StreamLine is always serializable")
        );
    }
}

// ---------------------------------------------------------------------------
// Trace rendering — reads outcome.events (already produced by the workflow
// call for the UI/JSONL stream) and cd_core::turn_trace::TracedCall (the new
// hook), never re-derives anything the workflow itself did not already
// compute.
// ---------------------------------------------------------------------------

/// Most evidence ids / tool names a summary line will list — a trace exists
/// to be read; unbounded lists defeat that regardless of format.
const MAX_TRACE_SUMMARY_ITEMS: usize = 100;

fn dedup_citation_ids(events: &[StreamEvent]) -> Vec<String> {
    let mut seen = std::collections::BTreeSet::new();
    let mut ids = Vec::new();
    for event in events {
        if let StreamEvent::Citation { source_id, .. } = event {
            if seen.insert(source_id.clone()) {
                ids.push(source_id.clone());
                if ids.len() >= MAX_TRACE_SUMMARY_ITEMS {
                    break;
                }
            }
        }
    }
    ids
}

fn dedup_tool_names(events: &[StreamEvent]) -> Vec<String> {
    let mut seen = std::collections::BTreeSet::new();
    let mut names = Vec::new();
    for event in events {
        if let StreamEvent::Tool { name, .. } = event {
            if seen.insert(name.clone()) {
                names.push(name.clone());
                if names.len() >= MAX_TRACE_SUMMARY_ITEMS {
                    break;
                }
            }
        }
    }
    names
}

/// `"not_applicable"` for an ordinary turn; otherwise `"grounded"` unless the
/// turn ended with one of the linked-evidence-validation error codes, which
/// are always prefixed `linked_` (see `cd_core::research`).
fn grounding_status(corpus_id: Option<&str>, events: &[StreamEvent]) -> &'static str {
    if corpus_id.is_none() {
        return "not_applicable";
    }
    let ungrounded = events.iter().any(
        |event| matches!(event, StreamEvent::Error { code, .. } if code.starts_with("linked_")),
    );
    if ungrounded {
        "ungrounded"
    } else {
        "grounded"
    }
}

fn traced_call_context_used_chars(call: &TracedCall) -> usize {
    // Prefer the full-request sum recorded by turn_trace (honest when the
    // stored `messages` vec was capped). Fall back to summing stored bodies
    // for older test fixtures that only populated `messages`.
    if call.context_used_chars > 0 {
        call.context_used_chars
    } else {
        call.messages.iter().map(|m| m.char_count).sum()
    }
}

#[allow(clippy::too_many_arguments)]
fn build_trace_lines(
    level: TraceLevel,
    dry_run: bool,
    corpus_id: Option<&str>,
    outcome: &ChatWorkflowOutcome,
    calls: &[TracedCall],
    elapsed_ms: u64,
    context_budget_chars: usize,
) -> Vec<StreamLine<'static>> {
    let mut lines = Vec::new();

    let evidence_ids = dedup_citation_ids(&outcome.events);
    let call_elapsed_ms: u64 = calls.iter().map(|c| c.elapsed_ms).sum();
    let context_used_chars = calls
        .last()
        .map(traced_call_context_used_chars)
        .unwrap_or(0);
    let context_messages_capped = calls.last().is_some_and(|c| c.messages_capped);
    let mut tool_names = dedup_tool_names(&outcome.events);
    for call in calls {
        for name in &call.tool_names {
            if !tool_names.contains(name) {
                tool_names.push(name.clone());
            }
        }
    }
    tool_names.truncate(MAX_TRACE_SUMMARY_ITEMS);

    let summary = TraceSummaryLine {
        provider_profile_id: outcome.provider_profile_id.clone(),
        chat_model: outcome.chat_model.clone(),
        corpus_id: corpus_id.map(str::to_string),
        corpus_revision: outcome.corpus_revision,
        dry_run,
        history_messages: outcome.history_messages,
        retrieved_evidence: evidence_ids.len(),
        evidence_ids,
        context_budget_chars,
        context_used_chars,
        context_messages_capped,
        tool_names,
        // Prefer the sum of actual backend-call time when a trace sink was
        // active (it is, whenever this function runs); fall back to the
        // whole-command wall clock so the field is never simply absent.
        elapsed_ms: if call_elapsed_ms > 0 {
            call_elapsed_ms
        } else {
            elapsed_ms
        },
        grounding: grounding_status(corpus_id, &outcome.events).to_string(),
    };
    lines.push(StreamLine::TraceSummary(summary));

    if matches!(level, TraceLevel::Context | TraceLevel::Full) {
        for call in calls {
            let (outcome_str, finish_reason, tool_call_count, error) = match &call.outcome {
                TracedOutcome::Completed {
                    finish_reason,
                    tool_call_count,
                } => (
                    "completed",
                    Some(finish_reason.clone()),
                    Some(*tool_call_count),
                    None,
                ),
                TracedOutcome::Failed { message } => ("failed", None, None, Some(message.clone())),
            };
            let context = TraceContextLine {
                round: call.seq,
                elapsed_ms: call.elapsed_ms,
                tool_names: call.tool_names.clone(),
                messages: call
                    .messages
                    .iter()
                    .map(|m| TracedMessageLine {
                        role: m.role.clone(),
                        content: m.content.clone(),
                        char_count: m.char_count,
                        truncated: m.truncated,
                    })
                    .collect(),
                outcome: outcome_str,
                finish_reason,
                tool_call_count,
                error,
            };
            lines.push(StreamLine::TraceContext(context));
        }
    }

    if matches!(level, TraceLevel::Full) {
        for event in &outcome.events {
            if let StreamEvent::Tool {
                id,
                name,
                phase: cd_core::events::ToolPhase::Finished,
                summary,
                detail,
                ok,
            } = event
            {
                let tool = TraceToolLine {
                    id: id.clone(),
                    name: name.clone(),
                    ok: ok.unwrap_or(false),
                    summary: summary.clone(),
                    detail: detail.clone(),
                };
                lines.push(StreamLine::TraceTool(tool));
            }
        }
    }

    lines
}

#[cfg(test)]
mod grounding_tests {
    use super::*;

    fn citation(source_id: &str) -> StreamEvent {
        StreamEvent::Citation {
            source_id: source_id.to_string(),
            label: "label".to_string(),
            locator: None,
        }
    }

    fn linked_error(code: &str) -> StreamEvent {
        StreamEvent::Error {
            code: code.to_string(),
            message: "message".to_string(),
        }
    }

    #[test]
    fn ordinary_turn_is_not_applicable_regardless_of_events() {
        // Adversarial: a Citation event present on an ordinary (unlinked)
        // turn must not be read as grounding — there is no corpus to be
        // grounded against, so the status must say so rather than guess.
        let events = vec![citation("log_event:1")];
        assert_eq!(grounding_status(None, &events), "not_applicable");
    }

    #[test]
    fn linked_turn_with_no_evidence_error_is_grounded() {
        let events = vec![citation("log_event:1"), citation("log_event:2")];
        assert_eq!(grounding_status(Some("corpus-a"), &events), "grounded");
    }

    #[test]
    fn a_linked_evidence_error_makes_the_turn_ungrounded_even_with_a_citation_present() {
        // Adversarial: a spurious Citation must not mask a real
        // evidence-validation failure — the error is authoritative.
        let events = vec![
            citation("log_event:1"),
            linked_error("linked_required_source_missing"),
        ];
        assert_eq!(grounding_status(Some("corpus-a"), &events), "ungrounded");
    }

    #[test]
    fn a_non_linked_error_code_does_not_flip_grounding() {
        // Adversarial: an ordinary provider error code (not the `linked_`
        // family) must not be misread as an evidence-validation failure.
        let events = vec![citation("log_event:1"), linked_error("ollama_unreachable")];
        assert_eq!(grounding_status(Some("corpus-a"), &events), "grounded");
    }

    #[test]
    fn evidence_ids_are_deduplicated_and_order_preserved() {
        let events = vec![
            citation("log_event:1"),
            citation("log_event:2"),
            citation("log_event:1"),
        ];
        assert_eq!(
            dedup_citation_ids(&events),
            vec!["log_event:1", "log_event:2"]
        );
    }

    #[test]
    fn evidence_ids_are_bounded() {
        let events: Vec<StreamEvent> = (0..(MAX_TRACE_SUMMARY_ITEMS + 50))
            .map(|i| citation(&format!("log_event:{i}")))
            .collect();
        assert!(dedup_citation_ids(&events).len() <= MAX_TRACE_SUMMARY_ITEMS);
    }
}
