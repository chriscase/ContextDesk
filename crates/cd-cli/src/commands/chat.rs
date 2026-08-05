//! `contextdesk chat` — the second half of the configured happy path.
//! Every decision (provider resolution, corpus binding, the actual model
//! turn, citation enforcement, session persistence) happens in
//! `cd_workflow::chat::run_chat_workflow`. The current selectively composed
//! desktop host has not yet migrated its full turn orchestration to that
//! entry point (the ignored architecture gates document that residual). This module
//! is only the CLI's rendering and permission-prompt strategy around it,
//! plus `--dry-run` / `--trace` rendering, which reads
//! `cd_core::turn_trace` data the workflow call already produced rather
//! than deriving anything of its own.

use crate::activity_render::{
    activity_lines, context_used_from_events, project_turn_activity, render_human_summary,
};
use crate::cli::{ActivityLevel, ChatArgs, TraceLevel};
use crate::config::{ColorMode, OutputFormat};
use crate::envelope::{
    CliError, CliResult, Envelope, JsonlMetaLine, StreamLine, TraceContextLine, TraceSummaryLine,
    TraceToolLine, TracedMessageLine,
};
use crate::render::{ChatOutcomeSummary, ChatStatusRenderer, TerminalCapabilities};
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
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Mirrors `commands::doctor`'s own `INTERRUPT_GRACE` exactly — the same
/// bounded, best-effort window given to an in-flight turn to notice the
/// cancel flag and wind down cleanly before this command stops waiting on
/// it. Kept as its own constant (not shared) since the two commands have no
/// other coupling and a future change to one's grace period should not
/// silently retune the other.
const INTERRUPT_GRACE: Duration = Duration::from_secs(5);

#[allow(clippy::too_many_arguments)]
pub async fn run(
    args: &ChatArgs,
    cache_root: &Path,
    secrets: &dyn SecretStore,
    cfg: &AppConfig,
    sessions: &SessionStore,
    cli_state: &mut CliState,
    format: OutputFormat,
    color: ColorMode,
    profile_override: Option<&str>,
    model_override: Option<&str>,
) -> CliResult<()> {
    // `full` exposes bounded, redacted conversation and tool-call content —
    // still never a secret or pre-redaction value, but real turn content
    // nonetheless. Refuse rather than let a script accidentally capture it.
    // Under `--jsonl` the streaming contract still applies: emit Error then
    // Done{ok:false} before returning (never empty stdout).
    if matches!(args.activity, Some(ActivityLevel::Full)) && !args.activity_ack {
        let err = CliError::user(
            "refusing --activity full without --activity-ack — full activity retains bounded,              redacted message bodies; re-run with --activity-ack to confirm",
        );
        if matches!(format, OutputFormat::Jsonl) {
            print_jsonl_failure(&err, "", None);
        } else if matches!(format, OutputFormat::Json) {
            print_json_failure(&err, None);
        } else if matches!(format, OutputFormat::Text) {
            eprintln!("error: {err}");
        }
        return Err(err);
    }
    if matches!(args.trace, Some(TraceLevel::Full)) && !args.trace_ack {
        let err = CliError::user(
            "refusing --trace full without --trace-ack — full trace exposes bounded, \
             redacted conversation and tool-call content; re-run with --trace-ack to confirm",
        );
        if matches!(format, OutputFormat::Jsonl) {
            print_jsonl_failure(&err, "", None);
        } else if matches!(format, OutputFormat::Json) {
            print_json_failure(&err, None);
        } else if matches!(format, OutputFormat::Text) {
            // This refusal happens before the renderer exists (no turn has
            // started) — `main.rs` now treats every Text-mode chat error as
            // already self-rendered, so this path must print its own line
            // rather than relying on the turn-failure `chat_renderer.finish`
            // call below, which never runs for this early return.
            eprintln!("error: {err}");
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

    let stdout_is_tty = io::stdout().is_terminal();
    let jsonl = matches!(format, OutputFormat::Jsonl);
    let text = matches!(format, OutputFormat::Text);

    // The renderer must exist and announce itself BEFORE any fallible setup
    // step, not just before the turn itself — `tool_host` below can fail
    // (e.g. a corrupt on-disk index), and that `Err` must reach the
    // operator exactly the same way a later turn failure would. `main.rs`
    // treats every Text-mode chat `Err` as already self-rendered by this
    // function; a fallible step that runs before any rendering exists would
    // otherwise produce a silent non-zero exit.
    let chat_renderer = ChatStatusRenderer::new(TerminalCapabilities::detect(color));
    if text {
        chat_renderer.start();
    }

    let mut host = match crate::adapters::tool_host_with_app_config(cache_root, cfg, secrets) {
        Ok(host) => host,
        Err(error) => {
            if jsonl {
                print_jsonl_failure(&error, "", None);
            } else if matches!(format, OutputFormat::Json) {
                print_json_failure(&error, None);
            }
            if text {
                chat_renderer.finish(ChatOutcomeSummary::Failed {
                    message: &error.message,
                });
            }
            return Err(error);
        }
    };

    // Shared capture path: same RecordingTurnTrace Tauri attaches.
    let want_capture = effective_trace.is_some() || args.activity.is_some();
    let recorder = want_capture.then(|| Arc::new(RecordingTurnTrace::new()));
    let trace_sink: Option<Arc<dyn TurnTraceSink>> = recorder
        .clone()
        .map(|recorder| recorder as Arc<dyn TurnTraceSink>);

    // Mirror Tauri: feed host stream events into the shared timeline so
    // ActivityRecorder.record_timeline sees tools/permissions in causal order.
    let host_event_sink = recorder.clone();
    let observed_session_id = Arc::new(Mutex::new(session_id.clone()));
    let live_session_id = observed_session_id.clone();
    let mut live_sink = |event: StreamEvent| {
        if let StreamEvent::TurnStarted { session_id, .. } = &event {
            *live_session_id.lock().expect("CLI live session lock") = Some(session_id.clone());
        }
        if let Some(sink) = host_event_sink.as_ref() {
            let kinds = std::collections::HashMap::new();
            sink.record_host_event(&event, &kinds);
        }
        if jsonl {
            emit_jsonl(&event);
        } else if text {
            chat_renderer.on_event(&event);
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

    let started = Instant::now();
    let cancel = Arc::new(AtomicBool::new(false));
    // Scoped so the pinned turn future (and its mutable borrow of `host`)
    // is dropped as soon as `result` is settled — `build_trace_lines` below
    // needs `host.model_context_budgets()`, which a live borrow would block.
    let result = {
        let turn = run_chat_workflow(
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
            Some(cancel.clone()),
            Some(&mut live_sink),
            decide_permission,
        );
        tokio::pin!(turn);

        // Mirrors `commands::doctor::execute_live_turns`'s own race exactly:
        // on Ctrl-C, set the cooperative cancel flag, give the turn a
        // bounded grace period to notice it and wind down, then report
        // `Cancelled` unconditionally — never re-derive the outcome from
        // whatever the inner future happened to resolve to. `cd_core`'s own
        // cancel-check can settle the turn as a (degraded) `Ok` once it
        // notices the flag; treating that as an ordinary success would
        // report the wrong exit code and render a `done` line for a turn
        // the operator explicitly interrupted.
        tokio::select! {
            result = &mut turn => result.map_err(map_workflow_error),
            _ = tokio::signal::ctrl_c() => {
                cancel.store(true, Ordering::SeqCst);
                if text {
                    chat_renderer.clear_for_interrupt();
                }
                eprintln!("cancelling — waiting for the turn to wind down...");
                let _ = tokio::time::timeout(INTERRUPT_GRACE, &mut turn).await;
                Err(CliError::cancelled("chat turn cancelled"))
            }
        }
    };
    let elapsed_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);

    let outcome = match result {
        Ok(outcome) => outcome,
        Err(error) => {
            // A transport/provider failure can return `Err` after the shared
            // trace has already captured one or more failed provider calls.
            // Preserve that truthful prefix as Activity instead of discarding
            // it merely because no `ChatWorkflowOutcome` was produced.  The
            // synthetic terminal metadata is deliberately generic: the
            // operator-facing error remains in the envelope/stderr, while the
            // activity journal never gains a filesystem path, endpoint, or raw
            // provider body from an error string.
            let failure_events = vec![
                StreamEvent::Error {
                    code: error.category.kind().to_string(),
                    message: "The chat turn failed before completion.".to_string(),
                },
                StreamEvent::TurnCompleted {
                    reason: if error.category == crate::envelope::ExitCategory::Cancelled {
                        "cancelled".to_string()
                    } else {
                        "error".to_string()
                    },
                },
            ];
            if let Some(sink) = recorder.as_ref() {
                let kinds = std::collections::HashMap::new();
                for event in &failure_events {
                    sink.record_host_event(event, &kinds);
                }
            }
            let failure_session_id = observed_session_id
                .lock()
                .expect("CLI live session lock")
                .clone()
                .unwrap_or_default();
            let failure_turn_id = if failure_session_id.is_empty() {
                String::new()
            } else {
                format!("{failure_session_id}::cli")
            };
            let activity_record = args.activity.map(|level| {
                project_turn_activity(
                    &failure_session_id,
                    &failure_turn_id,
                    corpus_id.as_deref(),
                    level,
                    recorder.as_deref(),
                    &failure_events,
                    elapsed_ms,
                )
            });
            if jsonl {
                print_jsonl_failure(&error, &failure_session_id, activity_record.as_ref());
            } else if matches!(format, OutputFormat::Json) {
                print_json_failure(&error, activity_record.as_ref());
            }
            if text {
                if let Some(record) = &activity_record {
                    eprint!("{}", render_human_summary(record));
                }
                let summary = if error.category == crate::envelope::ExitCategory::Cancelled {
                    ChatOutcomeSummary::Cancelled
                } else {
                    ChatOutcomeSummary::Failed {
                        message: &error.message,
                    }
                };
                chat_renderer.finish(summary);
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

    let turn_id = outcome.turn_id.clone();
    let activity_record = args.activity.map(|level| {
        project_turn_activity(
            &outcome.session_id,
            &turn_id,
            corpus_id.as_deref(),
            level,
            recorder.as_deref(),
            &outcome.events,
            elapsed_ms,
        )
    });
    let activity_stream_lines: Option<Vec<StreamLine<'static>>> =
        activity_record.as_ref().map(|record| {
            activity_lines(record)
                .into_iter()
                .map(StreamLine::Activity)
                .collect()
        });

    match format {
        OutputFormat::Text => {
            if !outcome.final_text.is_empty() {
                println!();
            }
            let grounding = grounding_status(corpus_id.as_deref(), &outcome.events);
            chat_renderer.finish(ChatOutcomeSummary::Ok {
                session_id: &outcome.session_id,
                grounding,
            });
            if let Some(lines) = &trace_lines {
                for line in lines {
                    println!("{}", serde_json::to_string_pretty(line).unwrap_or_default());
                }
            }
            if let Some(record) = &activity_record {
                // Keep answer stdout clean; activity summary on stderr.
                eprint!("{}", render_human_summary(record));
            }
            // User-facing “Context used” from host SearchTrail (ordinary chat plan).
            if let Some(summary) = context_used_from_events(&outcome.events) {
                eprintln!("Context used: {summary}");
            }
        }
        OutputFormat::Jsonl => {
            let mut seq: u64 = 0;
            let emit_meta =
                |session: &str, turn: &str, operation: &str, seq: u64, line: &StreamLine<'_>| {
                    let wrapped = JsonlMetaLine::wrap(session, turn, operation, seq, line);
                    println!(
                        "{}",
                        serde_json::to_string(&wrapped).expect("StreamLine is always serializable")
                    );
                };
            if let Some(lines) = &trace_lines {
                for line in lines {
                    let op = match line {
                        StreamLine::TraceSummary(_) => "trace_summary",
                        StreamLine::TraceContext(_) => "trace_context",
                        StreamLine::TraceTool(_) => "trace_tool",
                        _ => "trace",
                    };
                    emit_meta(&outcome.session_id, &turn_id, op, seq, line);
                    seq = seq.saturating_add(1);
                }
            }
            if let Some(lines) = &activity_stream_lines {
                for line in lines {
                    let op = match line {
                        StreamLine::Activity(a) => a.operation_id.as_str(),
                        _ => "activity",
                    };
                    emit_meta(&outcome.session_id, &turn_id, op, seq, line);
                    seq = seq.saturating_add(1);
                }
            }
            if let Some(summary) = context_used_from_events(&outcome.events) {
                let cu = StreamLine::ContextUsed { summary };
                emit_meta(&outcome.session_id, &turn_id, "context_used", seq, &cu);
                seq = seq.saturating_add(1);
            }
            let done = crate::envelope::StreamLine::Done {
                ok: true,
                session_id: &outcome.session_id,
                final_text: &outcome.final_text,
            };
            emit_meta(&outcome.session_id, &turn_id, "done", seq, &done);
        }
        OutputFormat::Json => {
            #[derive(Serialize)]
            struct ChatSummaryWithActivity<'a> {
                session_id: &'a str,
                final_text: &'a str,
                /// Host deterministic context-plan summary when the turn emitted one.
                #[serde(skip_serializing_if = "Option::is_none")]
                context_used: Option<String>,
                #[serde(skip_serializing_if = "Option::is_none")]
                trace: Option<Vec<StreamLine<'static>>>,
                #[serde(skip_serializing_if = "Option::is_none")]
                activity: Option<&'a cd_core::activity::TurnActivityRecord>,
            }
            let context_used = context_used_from_events(&outcome.events);
            let envelope = Envelope::ok(
                "chat",
                ChatSummaryWithActivity {
                    session_id: &outcome.session_id,
                    final_text: &outcome.final_text,
                    context_used,
                    trace: trace_lines,
                    activity: activity_record.as_ref(),
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
    let lower = message.to_ascii_lowercase();
    if lower.contains("provider")
        || lower.contains("connect")
        || lower.contains("http")
        || lower.contains("chat request")
        || lower.contains("backend returned")
    {
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
fn print_jsonl_failure(
    error: &CliError,
    session_id: &str,
    activity: Option<&cd_core::activity::TurnActivityRecord>,
) {
    let turn_id = if session_id.is_empty() {
        String::new()
    } else {
        format!("{session_id}::cli")
    };
    let mut seq = 0u64;
    if let Some(record) = activity {
        for line in activity_lines(record).into_iter().map(StreamLine::Activity) {
            let operation = match &line {
                StreamLine::Activity(activity) => activity.operation_id.clone(),
                _ => "activity".to_string(),
            };
            let wrapped = JsonlMetaLine::wrap(session_id, &turn_id, &operation, seq, line);
            println!(
                "{}",
                serde_json::to_string(&wrapped).expect("StreamLine is always serializable")
            );
            seq = seq.saturating_add(1);
        }
    }
    let error_line = crate::envelope::StreamLine::Error {
        code: error.category.kind(),
        message: &error.message,
    };
    let err_wrapped = JsonlMetaLine::wrap(session_id, &turn_id, "error", seq, error_line);
    println!(
        "{}",
        serde_json::to_string(&err_wrapped).expect("StreamLine is always serializable")
    );
    let done = crate::envelope::StreamLine::Done {
        ok: false,
        // No session id is known on a failure that happened before one
        // could be resolved (e.g. an unknown --profile) — never fabricate one.
        session_id,
        final_text: "",
    };
    let done_wrapped =
        JsonlMetaLine::wrap(session_id, &turn_id, "done", seq.saturating_add(1), done);
    println!(
        "{}",
        serde_json::to_string(&done_wrapped).expect("StreamLine is always serializable")
    );
}

/// One-shot JSON failure shape for chat.  Unlike the generic command error
/// envelope this may carry the shared bounded Activity prefix captured before
/// the failure.  `data` is omitted for pre-turn validation/setup failures.
fn print_json_failure(error: &CliError, activity: Option<&cd_core::activity::TurnActivityRecord>) {
    #[derive(Serialize)]
    struct FailureData<'a> {
        activity: &'a cd_core::activity::TurnActivityRecord,
    }

    #[derive(Serialize)]
    struct ChatFailure<'a> {
        schema_version: u32,
        ok: bool,
        command: &'static str,
        #[serde(skip_serializing_if = "Option::is_none")]
        data: Option<FailureData<'a>>,
        error: crate::envelope::ErrorEnvelope,
    }

    let envelope = ChatFailure {
        schema_version: crate::envelope::ENVELOPE_SCHEMA_VERSION,
        ok: false,
        command: "chat",
        data: activity.map(|activity| FailureData { activity }),
        error: crate::envelope::ErrorEnvelope {
            kind: error.category.kind(),
            message: error.message.clone(),
        },
    };
    println!(
        "{}",
        serde_json::to_string(&envelope).expect("chat failure envelope is serializable")
    );
}

fn emit_jsonl(event: &StreamEvent) {
    let line = match event {
        StreamEvent::TextDelta { text } => Some((
            "text_delta",
            crate::envelope::StreamLine::TextDelta { text },
        )),
        StreamEvent::Tool {
            name,
            phase: cd_core::events::ToolPhase::Finished,
            ok,
            summary,
            ..
        } => Some((
            "tool",
            crate::envelope::StreamLine::Tool {
                name,
                ok: ok.unwrap_or(false),
                summary,
            },
        )),
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
        } => Some((
            "permission",
            crate::envelope::StreamLine::PermissionRequired {
                tool_name,
                target,
                reason,
                risk,
            },
        )),
        StreamEvent::TurnCompleted { reason } => Some((
            "turn_completed",
            crate::envelope::StreamLine::TurnCompleted { reason },
        )),
        StreamEvent::Error { code, message } => Some((
            "error",
            crate::envelope::StreamLine::Error { code, message },
        )),
        _ => None,
    };
    if let Some((operation, line)) = line {
        // Live events may predate a durable session id; keep fields stable
        // and empty rather than inventing identifiers.
        let wrapped = JsonlMetaLine::wrap("", "live", operation, 0, line);
        println!(
            "{}",
            serde_json::to_string(&wrapped).expect("StreamLine is always serializable")
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
///
/// `pub(crate)` so `commands::doctor`'s live-turn grounding check reuses
/// this exact classification instead of re-deriving it.
pub(crate) fn grounding_status(corpus_id: Option<&str>, events: &[StreamEvent]) -> &'static str {
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
        context_used: context_used_from_events(&outcome.events),
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
            corpus_id: None,
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
