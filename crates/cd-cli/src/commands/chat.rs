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

use crate::activity_render::{activity_lines, context_used_from_events, project_turn_activity};
use crate::cli::{ActivityLevel, ChatArgs, TraceLevel};
use crate::config::{ColorMode, OutputFormat};
use crate::envelope::{
    CliError, CliResult, Envelope, ExitCategory, JsonlMetaLine, StreamLine, TraceContextLine,
    TraceSummaryLine, TraceToolLine, TracedMessageLine,
};
use crate::human_hierarchy::{
    render_activity_hierarchy, render_activity_hierarchy_with_context, render_trace_hierarchy,
    HierarchyStyle,
};
use crate::render::{
    ChatOutcomeSummary, ChatStatusRenderer, TerminalCapabilities, TerminalTextSanitizer,
};
use cd_core::capability_qualification::{
    capability_contract_verdict, load_qualification_store, qualification_store_path,
    CapabilityContract, ContractVerdict, QualificationKey, QualificationStore,
};
use cd_core::config::AppConfig;
use cd_core::deadline_controls::{
    apply_turn_override, format_deadline_ms, parse_deadline_duration,
};
use cd_core::events::StreamEvent;
use cd_core::keychain_store::SecretStore;
use cd_core::log_analysis::LogCorpus;
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
    qualification_config_dir: &Path,
    secrets: &dyn SecretStore,
    cfg: &AppConfig,
    sessions: &SessionStore,
    cli_state: &mut CliState,
    format: OutputFormat,
    color: ColorMode,
    profile_override: Option<&str>,
    model_override: Option<&str>,
    implicit_chat: bool,
    // Global `--deadline` (never persisted). Parsed before any host I/O.
    deadline_override: Option<&str>,
) -> CliResult<()> {
    validate_question(args, format)?;
    // Parse the one-turn deadline before any secret-store, corpus, session,
    // or provider work so an invalid value fails closed with zero side effects.
    let deadline_override_ms = match deadline_override {
        Some(raw) => match parse_deadline_duration(raw) {
            Ok(ms) => Some(ms),
            Err(error) => {
                return fail_before_turn(format, CliError::user(error.to_string()));
            }
        },
        None => None,
    };
    let question = args.question.join(" ");
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
    let implicit_profile = if implicit_chat {
        match resolve_implicit_profile_override(cfg, profile_override) {
            Ok(profile) => profile,
            Err(error) => return fail_before_turn(format, error),
        }
    } else {
        None
    };
    let effective_profile_override = profile_override.or(implicit_profile.as_deref());

    if implicit_chat {
        let selected_profile = match cd_workflow::provider::resolve_provider_profile(
            cfg,
            effective_profile_override,
        ) {
            Ok(profile) => profile,
            Err(missing) => {
                return fail_before_turn(
                    format,
                    CliError::user(format!(
                        "provider profile '{missing}' is unavailable; run `contextdesk config show` or choose one with `--profile <id>`"
                    )),
                );
            }
        };
        let selected_model = model_override
            .or(cfg.default_chat_model.as_deref())
            .unwrap_or(&selected_profile.chat_model)
            .trim();
        if selected_model.is_empty() {
            return fail_before_turn(
                format,
                CliError::user(
                    "no chat model is configured; use `--model <id>` or run `contextdesk config init`",
                ),
            );
        }
        let Some(active_corpus) = corpus_id.as_deref() else {
            return fail_before_turn(
                format,
                CliError::user(
                    "no active corpus is selected; import evidence with `contextdesk import <path>` or choose one with `contextdesk corpus use <id>`",
                ),
            );
        };
        let available = match LogCorpus::list_ids(cache_root) {
            Ok(available) => available,
            Err(error) => return fail_before_turn(format, map_workflow_error(error)),
        };
        if !available.iter().any(|id| id == active_corpus) {
            return fail_before_turn(
                format,
                CliError::user(format!(
                    "active corpus '{active_corpus}' is unavailable; run `contextdesk corpus list` and select one with `contextdesk corpus use <id>`"
                )),
            );
        }
    }
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

    // Per-turn override: explicit for this host only. Never writes AppConfig;
    // a later turn without --deadline reloads the saved policy.
    if let Some(ms) = deadline_override_ms {
        let mut budget = host.router_budget().clone();
        if let Err(error) = apply_turn_override(&mut budget, ms) {
            let err = CliError::user(error.to_string());
            if jsonl {
                print_jsonl_failure(&err, "", None);
            } else if matches!(format, OutputFormat::Json) {
                print_json_failure(&err, None);
            }
            if text {
                chat_renderer.finish(ChatOutcomeSummary::Failed {
                    message: &err.message,
                });
            }
            return Err(err);
        }
        host.set_router_budget(budget);
    }
    if text && args.dry_run {
        let budget = host.router_budget();
        if deadline_override_ms.is_some() {
            eprintln!(
                "deadline: one-turn override {} ({} ms); not saved to config",
                format_deadline_ms(budget.deadline_ms),
                budget.deadline_ms
            );
        } else {
            let policy = if budget.deadline_is_explicit {
                "custom"
            } else {
                "auto"
            };
            eprintln!(
                "deadline: saved policy={policy}, stored ceiling={} ({} ms); ContextDesk may finish sooner",
                format_deadline_ms(budget.deadline_ms),
                budget.deadline_ms
            );
        }
    }

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
    let started = Instant::now();
    let mut answer_started = false;
    let mut buffered_answer = String::new();
    let mut terminal_text = TerminalTextSanitizer::for_current_console();
    let mut live_sink = |event: StreamEvent| {
        if let StreamEvent::TurnStarted { session_id, .. } = &event {
            *live_session_id.lock().expect("CLI live session lock") = Some(session_id.clone());
        }
        if let Some(sink) = host_event_sink.as_ref() {
            let kinds = std::collections::HashMap::new();
            sink.record_host_event(&event, &kinds);
        }
        if jsonl {
            let event_elapsed_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
            emit_jsonl(&event, event_elapsed_ms);
        } else if text {
            if let StreamEvent::TextDelta { text } = &event {
                let clean = terminal_text.push(text);
                if implicit_chat {
                    buffered_answer.push_str(&clean);
                } else {
                    chat_renderer.on_event(&event);
                    if stdout_is_tty && !answer_started {
                        println!("+--------+\n| Answer |\n+--------+");
                        answer_started = true;
                    }
                    print!("{clean}");
                    let _ = io::stdout().flush();
                }
            } else {
                chat_renderer.on_event(&event);
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

    let cancel = Arc::new(AtomicBool::new(false));
    // Scoped so the pinned turn future (and its mutable borrow of `host`)
    // is dropped as soon as `result` is settled — `build_trace_lines` below
    // needs `host.model_context_budgets()`, which a live borrow would block.
    let result = {
        // Keep the composite workflow future off the CLI main thread's stack.
        // Windows reserves only 1 MiB there, and stack-pinning this future can
        // overflow while polling the agent pipeline even for a single-model turn.
        let mut turn = Box::pin(run_chat_workflow(
            &mut host,
            secrets,
            cfg,
            sessions,
            cache_root,
            session_id.as_deref(),
            &question,
            ChatWorkflowRequest {
                corpus_id: corpus_id.as_deref(),
                explicit_profile_id: effective_profile_override,
                chat_model_override: model_override,
                dry_run: args.dry_run,
                trace_sink,
                user_selection: args.user_selection.as_deref(),
                multi_model_mode: args.mode.to_core(),
                reviewer_qualified: reviewer_qualification(cfg, qualification_config_dir),
            },
            Some(cancel.clone()),
            Some(&mut live_sink),
            decide_permission,
        ));

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
            result = turn.as_mut() => result.map_err(map_workflow_error),
            _ = tokio::signal::ctrl_c() => {
                cancel.store(true, Ordering::SeqCst);
                if text {
                    chat_renderer.clear_for_interrupt();
                }
                eprintln!("cancelling - waiting for the turn to wind down...");
                let _ = tokio::time::timeout(INTERRUPT_GRACE, turn.as_mut()).await;
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
                // Finish status first so progress never interleaves with
                // activity hierarchy on stderr.
                let summary = if error.category == crate::envelope::ExitCategory::Cancelled {
                    ChatOutcomeSummary::Cancelled
                } else {
                    ChatOutcomeSummary::Failed {
                        message: &error.message,
                    }
                };
                chat_renderer.finish(summary);
                if let Some(record) = &activity_record {
                    // Hierarchy renderer sanitizes leaf values; apply
                    // destination style (TTY color / redirected plain).
                    let style = HierarchyStyle::detect_stderr(color);
                    eprint!("{}", render_activity_hierarchy(record, style));
                }
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
    let withheld_error =
        withheld_cli_error(&outcome.events).or_else(|| failed_turn_cli_error(&outcome.events));

    match format {
        OutputFormat::Text => {
            if withheld_error.is_none() && !outcome.final_text.is_empty() && !implicit_chat {
                println!();
            }
            // Status line first — never interleave with trace/activity sections.
            if let Some(error) = withheld_error.as_ref() {
                chat_renderer.finish(ChatOutcomeSummary::Failed {
                    message: &error.message,
                });
            } else {
                let grounding = grounding_status(corpus_id.as_deref(), &outcome.events);
                chat_renderer.finish(ChatOutcomeSummary::Ok {
                    session_id: &outcome.session_id,
                    grounding,
                });
            }
            if implicit_chat && withheld_error.is_none() {
                let answer = if buffered_answer.trim().is_empty() {
                    &outcome.final_text
                } else {
                    &buffered_answer
                };
                print!("{}", crate::answer_render::render(answer, color));
            }
            // Honest one-line multi-model status to stderr when review was
            // requested this turn (configured or executed differs from single).
            if outcome.multi_model_configured != cd_core::multi_model::MultiModelMode::Single
                || outcome.multi_model_executed != cd_core::multi_model::ExecutedMode::Single
            {
                let reason = outcome
                    .multi_model_entry_degradation
                    .map(|d| format!(" ({})", d.detail()))
                    .unwrap_or_default();
                eprintln!(
                    "multi-model: configured={}, executed={}{}",
                    outcome.multi_model_configured.as_str(),
                    outcome.multi_model_executed.as_str(),
                    reason
                );
            }
            if let Some(lines) = &trace_lines {
                let level = effective_trace.unwrap_or(TraceLevel::Summary);
                let style = HierarchyStyle::detect_stdout(color);
                print!("{}", render_trace_hierarchy(lines, level, style));
            }
            if let Some(record) = &activity_record {
                let style = HierarchyStyle::detect_stderr(color);
                let context_budget = if effective_trace.is_none() {
                    outcome.events.iter().rev().find_map(|event| match event {
                        StreamEvent::ContextBudget { telemetry } => Some(telemetry),
                        _ => None,
                    })
                } else {
                    None
                };
                eprint!(
                    "{}",
                    render_activity_hierarchy_with_context(record, context_budget, style)
                );
            }
            // Ordinary chat gets one concise host summary. Trace/activity modes
            // place the same typed facts inside their hierarchy instead.
            if effective_trace.is_none() && args.activity.is_none() {
                if let Some(summary) = context_used_from_events(&outcome.events) {
                    eprintln!("Context used: {summary}");
                }
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
                ok: withheld_error.is_none(),
                session_id: &outcome.session_id,
                final_text: if withheld_error.is_none() {
                    &outcome.final_text
                } else {
                    ""
                },
            };
            emit_meta(&outcome.session_id, &turn_id, "done", seq, &done);
        }
        OutputFormat::Json => {
            if let Some(error) = withheld_error.as_ref() {
                print_json_failure(error, activity_record.as_ref());
            } else {
                #[derive(Serialize)]
                struct MultiModelSummary<'a> {
                    configured_mode: &'a str,
                    executed_mode: &'a str,
                    #[serde(skip_serializing_if = "Option::is_none")]
                    entry_degradation: Option<&'a str>,
                }
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
                    /// Exact host-validated envelope. `final_text` is only a
                    /// display projection and is never parsed as authority.
                    #[serde(skip_serializing_if = "Option::is_none")]
                    investigation_answer:
                        Option<&'a cd_core::investigation_answer::AnswerEnvelopeV1>,
                    /// Honest configured-vs-executed multi-model mode.
                    #[serde(skip_serializing_if = "Option::is_none")]
                    multi_model: Option<MultiModelSummary<'a>>,
                }
                let context_used = context_used_from_events(&outcome.events);
                let investigation_answer = investigation_answer_from_events(&outcome.events);
                let multi_model = (outcome.multi_model_configured
                    != cd_core::multi_model::MultiModelMode::Single
                    || outcome.multi_model_executed != cd_core::multi_model::ExecutedMode::Single)
                    .then(|| MultiModelSummary {
                        configured_mode: outcome.multi_model_configured.as_str(),
                        executed_mode: outcome.multi_model_executed.as_str(),
                        entry_degradation: outcome
                            .multi_model_entry_degradation
                            .map(|d| d.as_str()),
                    });
                let envelope = Envelope::ok(
                    "chat",
                    ChatSummaryWithActivity {
                        session_id: &outcome.session_id,
                        final_text: &outcome.final_text,
                        context_used,
                        trace: trace_lines,
                        activity: activity_record.as_ref(),
                        investigation_answer,
                        multi_model,
                    },
                );
                println!(
                    "{}",
                    serde_json::to_string(&envelope).expect("Envelope is always serializable")
                );
            }
        }
    }

    match withheld_error {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

fn withheld_cli_error(events: &[StreamEvent]) -> Option<CliError> {
    let reason = cd_core::events::withheld_turn_reason(events)?;
    let message = events
        .iter()
        .rev()
        .find_map(|event| match event {
            StreamEvent::Error { message, .. } => Some(message.clone()),
            _ => None,
        })
        .unwrap_or_else(|| format!("The answer was withheld ({reason})."));
    Some(if reason.ends_with("provider_error") {
        CliError::provider(message)
    } else {
        CliError::new(ExitCategory::NotReady, message)
    })
}

/// A turn the shared classifier calls `Failed` produced no answer, so the CLI
/// must not exit 0 for it.
///
/// Withholding (handled above) is ContextDesk declining to deliver; this is
/// the provider never answering — `provider_rate_limited`,
/// `provider_unauthorized`, `provider_unavailable`, `provider_failed`,
/// `provider_not_wired`, `ollama_unreachable`. Those terminals used to reach
/// the CLI as an opaque `Err`; now that they are typed events, a script that
/// only checks the exit code would otherwise read a dead provider as a
/// successful run. Classification is delegated to
/// [`cd_core::activity::status_for_turn_reason`] so the CLI and the activity
/// journal can never disagree about which terminals are failures.
fn failed_turn_cli_error(events: &[StreamEvent]) -> Option<CliError> {
    let reason = events.iter().rev().find_map(|event| match event {
        StreamEvent::TurnCompleted { reason } => Some(reason.clone()),
        _ => None,
    })?;
    if cd_core::activity::status_for_turn_reason(&reason)
        != cd_core::activity::ActivityStatus::Failed
    {
        return None;
    }
    let message = events
        .iter()
        .rev()
        .find_map(|event| match event {
            StreamEvent::Error { message, .. } => Some(message.clone()),
            _ => None,
        })
        .unwrap_or_else(|| format!("The turn failed ({reason})."));
    Some(CliError::provider(message))
}

/// Return only the typed host event. In particular, no `TextDelta` is parsed
/// as JSON here: visible transcript text is never evidence authority.
fn investigation_answer_from_events(
    events: &[StreamEvent],
) -> Option<&cd_core::investigation_answer::AnswerEnvelopeV1> {
    events.iter().rev().find_map(|event| match event {
        StreamEvent::InvestigationAnswer { envelope } => Some(envelope),
        _ => None,
    })
}

/// Read the shared, secret-free qualification evidence for the configured
/// reviewer. A missing, stale, cancelled, or malformed store is deliberately
/// treated as unqualified/unverified by returning `None`; it must never make
/// review appear authorized merely because a reviewer is named in config.
fn reviewer_qualification(cfg: &AppConfig, config_dir: &Path) -> Option<bool> {
    let path = qualification_store_path(config_dir);
    let store = load_qualification_store(&path).ok()?;
    reviewer_qualification_from_store(cfg, &store)
}

fn reviewer_qualification_from_store(cfg: &AppConfig, store: &QualificationStore) -> Option<bool> {
    let reviewer = cfg.multi_model.reviewer.as_ref()?;
    let profile = cfg
        .providers
        .profiles
        .iter()
        .find(|profile| profile.id == reviewer.profile_id)?;
    let model = reviewer
        .model
        .as_deref()
        .unwrap_or(&profile.chat_model)
        .trim();
    if model.is_empty() {
        return Some(false);
    }
    let key =
        QualificationKey::with_provider_kind(&profile.id, &profile.base_url, model, profile.kind);
    let report = store.get(&key);
    Some(matches!(
        capability_contract_verdict(report, CapabilityContract::JsonProposal),
        ContractVerdict::Qualified
    ))
}

pub fn validate_question(args: &ChatArgs, format: OutputFormat) -> CliResult<()> {
    if args.question.join(" ").trim().is_empty() {
        return fail_before_turn(
            format,
            CliError::user(
                "question cannot be blank; provide a question such as `contextdesk \"What caused the outage?\"`",
            ),
        );
    }
    Ok(())
}

fn fail_before_turn(format: OutputFormat, error: CliError) -> CliResult<()> {
    match format {
        OutputFormat::Jsonl => print_jsonl_failure(&error, "", None),
        OutputFormat::Json => print_json_failure(&error, None),
        OutputFormat::Text => eprintln!("error: {}", error.message),
    }
    Err(error)
}

fn resolve_implicit_profile_override(
    cfg: &AppConfig,
    explicit: Option<&str>,
) -> CliResult<Option<String>> {
    if explicit.is_some() {
        return Ok(None);
    }
    match cfg.providers.active_id.as_deref() {
        Some(active)
            if cfg
                .providers
                .profiles
                .iter()
                .any(|profile| profile.id == active) =>
        {
            Ok(Some(active.to_string()))
        }
        Some(active) => Err(CliError::user(format!(
            "active provider profile '{active}' no longer exists; run `contextdesk config show`, then select or configure a valid profile"
        ))),
        None if cfg.providers.profiles.len() == 1 => {
            Ok(Some(cfg.providers.profiles[0].id.clone()))
        }
        None if cfg.providers.profiles.len() > 1 => Err(CliError::user(
            "multiple provider profiles are configured but none is active; use `--profile <id>` or run `contextdesk config init` to choose a default",
        )),
        None => Ok(None),
    }
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

#[cfg(test)]
mod implicit_resolution_tests {
    use super::*;
    use cd_core::providers::ProviderProfile;

    fn profile(id: &str) -> ProviderProfile {
        let mut profile = ProviderProfile::ollama_local();
        profile.id = id.to_string();
        profile
    }

    #[test]
    fn one_profile_is_a_safe_default_but_multiple_without_active_is_ambiguous() {
        let mut cfg = AppConfig::default();
        cfg.providers.active_id = None;
        cfg.providers.profiles = vec![profile("only")];
        assert_eq!(
            resolve_implicit_profile_override(&cfg, None).unwrap(),
            Some("only".into())
        );

        cfg.providers.profiles.push(profile("second"));
        let error = resolve_implicit_profile_override(&cfg, None).unwrap_err();
        assert!(error.message.contains("multiple provider profiles"));
        assert!(error.message.contains("--profile <id>"));
    }

    #[test]
    fn stale_active_profile_fails_and_explicit_profile_defers_to_shared_workflow() {
        let mut cfg = AppConfig::default();
        cfg.providers.active_id = Some("deleted".into());
        cfg.providers.profiles = vec![profile("available")];
        let error = resolve_implicit_profile_override(&cfg, None).unwrap_err();
        assert!(error.message.contains("no longer exists"));
        assert_eq!(
            resolve_implicit_profile_override(&cfg, Some("available")).unwrap(),
            None
        );
    }
}

#[cfg(test)]
mod reviewer_qualification_tests {
    use super::*;
    use cd_core::capability_qualification::{
        CapabilityCheckResult, CapabilityKind, CapabilityStatus, QualificationReport,
    };
    use cd_core::config::ReviewerRoleConfig;
    use cd_core::providers::ProviderProfile;

    fn profile(id: &str) -> ProviderProfile {
        let mut profile = ProviderProfile::ollama_local();
        profile.id = id.to_string();
        profile.chat_model = "reviewer-model".to_string();
        profile
    }

    fn config() -> AppConfig {
        let mut cfg = AppConfig::default();
        cfg.providers.profiles = vec![profile("reviewer")];
        cfg.multi_model.reviewer = Some(ReviewerRoleConfig {
            profile_id: "reviewer".into(),
            model: None,
            require_qualified: true,
            allow_remote: false,
        });
        cfg
    }

    fn report(cfg: &AppConfig) -> QualificationReport {
        let profile = &cfg.providers.profiles[0];
        QualificationReport {
            key: QualificationKey::with_provider_kind(
                &profile.id,
                &profile.base_url,
                &profile.chat_model,
                profile.kind,
            ),
            checks: vec![
                CapabilityCheckResult {
                    kind: CapabilityKind::BasicGeneration,
                    status: CapabilityStatus::Pass,
                    elapsed_ms: 1,
                    tested_at: 1,
                    reason: "pass".into(),
                    request_mode: Some("plain".into()),
                    dialect: Some("ollama".into()),
                    schema_strict: None,
                    schema_probe_id: None,
                },
                CapabilityCheckResult {
                    kind: CapabilityKind::StructuredOutput,
                    status: CapabilityStatus::Pass,
                    elapsed_ms: 1,
                    tested_at: 1,
                    reason: "pass".into(),
                    // Production reviewer uses plain/prompted JSON — not native json_object.
                    request_mode: Some("prompted_json".into()),
                    dialect: Some("ollama".into()),
                    schema_strict: None,
                    schema_probe_id: None,
                },
            ],
            role_hint: "chat".into(),
            cancelled: false,
            stale: false,
            finished_at: 1,
        }
    }

    #[test]
    fn reviewer_qualification_uses_shared_json_contract() {
        let cfg = config();
        let mut store = QualificationStore::default();
        store.put(report(&cfg));
        assert_eq!(reviewer_qualification_from_store(&cfg, &store), Some(true));
    }

    #[test]
    fn stale_reviewer_evidence_never_authorizes_review() {
        let cfg = config();
        let mut evidence = report(&cfg);
        evidence.stale = true;
        let mut store = QualificationStore::default();
        store.put(evidence);
        assert_eq!(reviewer_qualification_from_store(&cfg, &store), Some(false));
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

fn progress_stream_line(event: &StreamEvent, elapsed_ms: u64) -> Option<StreamLine<'static>> {
    cd_core::events::progress_for_stream_event(event, elapsed_ms).map(StreamLine::Progress)
}

fn emit_jsonl(event: &StreamEvent, elapsed_ms: u64) {
    if let Some(progress) = progress_stream_line(event, elapsed_ms) {
        let wrapped = JsonlMetaLine::wrap("", "live", "progress", 0, progress);
        println!(
            "{}",
            serde_json::to_string(&wrapped).expect("StreamLine is always serializable")
        );
    }
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
        // A Started event has no outcome yet. Its lifecycle is exposed by the
        // progress line above; keep the legacy terminal `tool` result shape so
        // absent `ok` is never misreported as false.
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
        StreamEvent::InvestigationAnswer { envelope } => Some((
            "investigation_answer",
            crate::envelope::StreamLine::InvestigationAnswer { envelope },
        )),
        StreamEvent::MultiModelStage {
            stage,
            phase,
            status,
            detail,
            candidate_id,
        } => Some((
            "multi_model_stage",
            crate::envelope::StreamLine::MultiModelStage {
                stage: stage.clone(),
                phase: phase.clone(),
                status: status.clone(),
                detail: detail.clone(),
                candidate_id: candidate_id.clone(),
            },
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

/// `"not_applicable"` for an ordinary turn. A linked turn is grounded only
/// when it carries at least one host-emitted log citation for the attached
/// corpus and no linked-evidence-validation error. Successful tool lifecycle
/// alone is not evidence: an empty search must remain ungrounded.
///
/// `pub(crate)` so `commands::doctor`'s live-turn grounding check reuses
/// this exact classification instead of re-deriving it.
pub(crate) fn grounding_status(corpus_id: Option<&str>, events: &[StreamEvent]) -> &'static str {
    if corpus_id.is_none() {
        return "not_applicable";
    }
    let corpus_id = corpus_id.expect("checked above");
    let ungrounded = events.iter().any(
        |event| matches!(event, StreamEvent::Error { code, .. } if code.starts_with("linked_")),
    );
    let has_trusted_log_evidence = events.iter().any(|event| match event {
        StreamEvent::Citation {
            source_id,
            corpus_id: citation_corpus_id,
            ..
        } => {
            (source_id.starts_with("log_event:") || source_id.starts_with("log_template:"))
                && citation_corpus_id
                    .as_deref()
                    .is_none_or(|cited| cited == corpus_id)
        }
        _ => false,
    });
    if ungrounded || !has_trusted_log_evidence {
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
    let tools_executed = dedup_tool_names(&outcome.events);
    let mut tools_offered = Vec::new();
    for call in calls {
        for name in &call.tool_names {
            if !tools_offered.contains(name) {
                tools_offered.push(name.clone());
            }
        }
    }
    tools_offered.truncate(MAX_TRACE_SUMMARY_ITEMS);
    let mut tool_names = tools_executed.clone();
    for name in &tools_offered {
        if !tool_names.contains(name) {
            tool_names.push(name.clone());
        }
    }
    tool_names.truncate(MAX_TRACE_SUMMARY_ITEMS);

    // Prefer the last typed ContextBudget event (synthesis) when present.
    let context_budget_telemetry = outcome.events.iter().rev().find_map(|e| match e {
        StreamEvent::ContextBudget { telemetry } => Some(telemetry.clone()),
        _ => None,
    });
    // Authoritative provider telemetry — same DTO Tauri projects via EventDto.
    let provider_telemetry = outcome.events.iter().rev().find_map(|e| match e {
        StreamEvent::ProviderTelemetry { telemetry } => Some(telemetry.as_ref().clone()),
        _ => None,
    });
    // Human-facing hard budget: prefer typed telemetry hard when present so
    // packing vs hard is never mislabeled as the same number.
    let context_budget_chars = context_budget_telemetry
        .as_ref()
        .map(|t| t.hard_budget_chars)
        .unwrap_or(context_budget_chars);
    let context_used_chars = context_budget_telemetry
        .as_ref()
        .map(|t| t.used_chars_estimate)
        .unwrap_or(context_used_chars);

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
        context_budget_telemetry,
        context_messages_capped,
        tool_names,
        tools_executed,
        tools_offered,
        // Prefer the sum of actual backend-call time when a trace sink was
        // active (it is, whenever this function runs); fall back to the
        // whole-command wall clock so the legacy field is never simply
        // absent. The two explicitly scoped fields below must never perform
        // this substitution: a zero-duration provider call and no provider
        // call are both valid observations, while turn wall time remains a
        // separate measurement.
        elapsed_ms: if call_elapsed_ms > 0 {
            call_elapsed_ms
        } else {
            elapsed_ms
        },
        turn_elapsed_ms: elapsed_ms,
        provider_call_elapsed_ms_sum: call_elapsed_ms,
        grounding: grounding_status(corpus_id, &outcome.events).to_string(),
        grounding_scope: if corpus_id.is_some() {
            "citation_identity_only".to_string()
        } else {
            "not_applicable".to_string()
        },
        interpretation_validated: false,
        context_used: context_used_from_events(&outcome.events),
        provider_telemetry: provider_telemetry.map(Box::new),
    };
    lines.push(StreamLine::TraceSummary(summary));

    if matches!(level, TraceLevel::Context | TraceLevel::Full) {
        let round_tel_by_seq: std::collections::HashMap<u32, _> = outcome
            .events
            .iter()
            .rev()
            .find_map(|e| match e {
                StreamEvent::ProviderTelemetry { telemetry } => Some(telemetry.clone()),
                _ => None,
            })
            .map(|t| {
                t.rounds
                    .into_iter()
                    .map(|r| (r.round, r))
                    .collect::<std::collections::HashMap<_, _>>()
            })
            .unwrap_or_default();
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
                // Host cancel/deadline terminals: class only, no invented bodies.
                TracedOutcome::Cancelled => ("cancelled", None, None, None),
                TracedOutcome::TimedOut => ("timed_out", None, None, None),
            };
            let round_key = u32::try_from(call.seq).unwrap_or(u32::MAX);
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
                provider_round_telemetry: round_tel_by_seq.get(&round_key).cloned(),
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
    use cd_core::events::ToolPhase;

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
    fn jsonl_progress_exposes_tool_start_reviewer_stage_and_elapsed_time() {
        let tool = progress_stream_line(
            &StreamEvent::Tool {
                id: "t1".into(),
                name: "broad_log_triage".into(),
                phase: ToolPhase::Started,
                summary: "Preparing bounded triage brief".into(),
                detail: None,
                ok: None,
            },
            412,
        )
        .expect("tool start progress");
        let tool = serde_json::to_value(tool).expect("progress JSON");
        assert_eq!(tool["type"], "progress");
        assert_eq!(tool["category"], "tool");
        assert_eq!(tool["phase"], "started");
        assert_eq!(tool["elapsed_ms"], 412);

        let reviewer = progress_stream_line(
            &StreamEvent::MultiModelStage {
                stage: "reviewer".into(),
                phase: "started".into(),
                status: None,
                detail: "reviewing candidate findings".into(),
                candidate_id: None,
            },
            913,
        )
        .expect("reviewer progress");
        let reviewer = serde_json::to_value(reviewer).expect("progress JSON");
        assert_eq!(reviewer["category"], "multi_model");
        assert_eq!(reviewer["stage"], "reviewer");
        assert_eq!(reviewer["elapsed_ms"], 913);
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
    fn linked_turn_without_trusted_log_evidence_is_ungrounded() {
        assert_eq!(grounding_status(Some("corpus-a"), &[]), "ungrounded");
        assert_eq!(
            grounding_status(Some("corpus-a"), &[citation("file:README.md")]),
            "ungrounded"
        );
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

    #[test]
    fn trace_separates_executed_tools_offered_tools_and_trusted_evidence() {
        let events = vec![
            StreamEvent::Tool {
                id: "host-brief".into(),
                name: "broad_log_triage".into(),
                phase: ToolPhase::Finished,
                summary: "Prepared bounded triage brief".into(),
                detail: None,
                ok: Some(true),
            },
            StreamEvent::Citation {
                source_id: "log_event:7".into(),
                label: "api.log".into(),
                locator: Some("event 7 / template 2".into()),
                corpus_id: Some("corpus-a".into()),
            },
            StreamEvent::TurnCompleted {
                reason: "stop".into(),
            },
        ];
        let outcome = ChatWorkflowOutcome {
            session_id: "session-a".into(),
            turn_id: "turn-a".into(),
            events,
            final_text: "Observed symptom; cause unproven.".into(),
            provider_profile_id: "profile-a".into(),
            chat_model: "model-a".into(),
            corpus_revision: Some(3),
            corpus_snapshot_revision: None,
            history_messages: 3,
            multi_model_configured: cd_core::multi_model::MultiModelMode::Single,
            multi_model_executed: cd_core::multi_model::ExecutedMode::Single,
            multi_model_entry_degradation: None,
        };
        let calls = vec![TracedCall {
            seq: 0,
            elapsed_ms: 5,
            tool_names: vec!["search_logs".into()],
            messages: vec![],
            context_used_chars: 100,
            messages_capped: false,
            outcome: TracedOutcome::Completed {
                finish_reason: "stop".into(),
                tool_call_count: 0,
            },

            transport: Default::default(),
            empty_visible_answer: false,
            application_retry_reason: None,
        }];

        let lines = build_trace_lines(
            TraceLevel::Summary,
            false,
            Some("corpus-a"),
            &outcome,
            &calls,
            5,
            1_000,
        );
        let StreamLine::TraceSummary(summary) = &lines[0] else {
            panic!("expected trace summary")
        };
        assert_eq!(summary.retrieved_evidence, 1);
        assert_eq!(summary.evidence_ids, vec!["log_event:7"]);
        assert_eq!(summary.tools_executed, vec!["broad_log_triage"]);
        assert_eq!(summary.tools_offered, vec!["search_logs"]);
        assert_eq!(summary.grounding_scope, "citation_identity_only");
        assert!(!summary.interpretation_validated);
        assert_eq!(
            summary.tool_names,
            vec!["broad_log_triage", "search_logs"],
            "legacy union remains backward compatible"
        );
    }

    #[test]
    fn trace_keeps_whole_turn_elapsed_separate_from_provider_latency() {
        let outcome = ChatWorkflowOutcome {
            session_id: "session-a".into(),
            turn_id: "turn-a".into(),
            events: vec![StreamEvent::TurnCompleted {
                reason: "budget_time".into(),
            }],
            final_text: String::new(),
            provider_profile_id: "profile-a".into(),
            chat_model: "model-a".into(),
            corpus_revision: None,
            corpus_snapshot_revision: None,
            history_messages: 1,
            multi_model_configured: cd_core::multi_model::MultiModelMode::Single,
            multi_model_executed: cd_core::multi_model::ExecutedMode::Single,
            multi_model_entry_degradation: None,
        };
        let calls = vec![TracedCall {
            seq: 0,
            elapsed_ms: 41_300,
            tool_names: vec![],
            messages: vec![],
            context_used_chars: 100,
            messages_capped: false,
            outcome: TracedOutcome::Failed {
                message: "turn deadline reached".into(),
            },
            transport: Default::default(),
            empty_visible_answer: false,
            application_retry_reason: None,
        }];

        let lines = build_trace_lines(
            TraceLevel::Summary,
            false,
            Some("corpus-a"),
            &outcome,
            &calls,
            76_800,
            1_000,
        );
        let StreamLine::TraceSummary(summary) = &lines[0] else {
            panic!("expected trace summary")
        };

        assert_eq!(summary.turn_elapsed_ms, 76_800);
        assert_eq!(summary.provider_call_elapsed_ms_sum, 41_300);
        assert_eq!(summary.elapsed_ms, 41_300, "legacy alias is preserved");
        let wire = serde_json::to_value(&lines[0]).expect("trace summary serializes");
        assert_eq!(wire["elapsed_ms"], 41_300);
        assert_eq!(wire["turn_elapsed_ms"], 76_800);
        assert_eq!(wire["provider_call_elapsed_ms_sum"], 41_300);
        let rendered = render_trace_hierarchy(&lines, TraceLevel::Summary, HierarchyStyle::plain());
        assert!(rendered.contains("turn_elapsed_ms=76800  provider_call_elapsed_ms_sum=41300"));
        assert!(!rendered.contains("`-- elapsed_ms=41300"));

        let no_call_lines =
            build_trace_lines(TraceLevel::Summary, true, None, &outcome, &[], 8, 1_000);
        let StreamLine::TraceSummary(no_call_summary) = &no_call_lines[0] else {
            panic!("expected trace summary")
        };
        assert_eq!(no_call_summary.turn_elapsed_ms, 8);
        assert_eq!(no_call_summary.provider_call_elapsed_ms_sum, 0);
        assert_eq!(
            no_call_summary.elapsed_ms, 8,
            "legacy no-call fallback is preserved"
        );
    }

    #[test]
    fn trace_summary_carries_typed_context_budget_telemetry() {
        use cd_core::context_budgeting::{
            synthesis_packing_budget, CapacitySourceLabel, ContextBudgetTelemetry,
        };
        let tel = ContextBudgetTelemetry {
            model_round: 1,
            hard_budget_chars: 120_000,
            packing_budget_chars: synthesis_packing_budget(120_000),
            reserved_headroom_chars: 12_000,
            used_chars_estimate: 50_000,
            free_chars_estimate: 70_000,
            evidence_pre_pack_chars: 150_000,
            evidence_included_chars: 90_000,
            evidence_omitted_blocks: 2,
            evidence_omitted_chars: 60_000,
            evidence_identity_lines_included: 10,
            evidence_identity_lines_omitted: 5,
            history_retained_messages: 2,
            history_omitted_messages: 1,
            history_compacted: false,
            provider_capacity_source: CapacitySourceLabel::UnknownConfigured,
            useful_headroom: true,
        };
        let events = vec![
            StreamEvent::ContextBudget {
                telemetry: tel.clone(),
            },
            StreamEvent::SearchTrail {
                steps: vec![tel.trail_step()],
            },
            StreamEvent::TurnCompleted {
                reason: "stop".into(),
            },
        ];
        let outcome = ChatWorkflowOutcome {
            session_id: "s".into(),
            turn_id: "t".into(),
            events,
            final_text: "ok".into(),
            provider_profile_id: "p".into(),
            chat_model: "m".into(),
            corpus_revision: None,
            corpus_snapshot_revision: None,
            history_messages: 1,
            multi_model_configured: cd_core::multi_model::MultiModelMode::Single,
            multi_model_executed: cd_core::multi_model::ExecutedMode::Single,
            multi_model_entry_degradation: None,
        };
        let lines = build_trace_lines(
            TraceLevel::Summary,
            false,
            Some("c"),
            &outcome,
            &[],
            1,
            99_999, // deliberate wrong budget — typed hard must win
        );
        let StreamLine::TraceSummary(summary) = &lines[0] else {
            panic!("expected trace summary");
        };
        let typed = summary
            .context_budget_telemetry
            .as_ref()
            .expect("typed context_budget_telemetry required");
        assert_eq!(typed.hard_budget_chars, 120_000);
        assert_eq!(typed.packing_budget_chars, 108_000);
        assert_eq!(summary.context_budget_chars, 120_000);
        assert_eq!(summary.context_used_chars, 50_000);
        assert_ne!(
            typed.hard_budget_chars, typed.packing_budget_chars,
            "hard and packing must stay distinct"
        );
        // Legacy trail string still available via event (compatibility).
        assert!(outcome_has_legacy_budget_trail(&outcome));
        // Near-ceiling is never healthy in typed snapshot.
        assert!(!cd_core::context_budgeting::has_useful_context_headroom(
            119_900, 120_000
        ));
    }

    fn outcome_has_legacy_budget_trail(outcome: &ChatWorkflowOutcome) -> bool {
        outcome.events.iter().any(|e| match e {
            StreamEvent::SearchTrail { steps } => {
                steps.iter().any(|s| s.starts_with("context_budget:"))
            }
            _ => false,
        })
    }
}
