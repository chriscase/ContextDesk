//! `contextdesk doctor` — one command's answer to "is everything ready for
//! a demonstration right now?"
//!
//! Every check reuses the exact production path another command already
//! exercises — `cd_workflow::provider` for profile/model resolution,
//! `cd_core::discovery` (via [`crate::provider_probe`]) for reachability,
//! `cd_workflow::chat::run_chat_workflow` for the live synthetic turn — this
//! module never re-implements turn logic, tool calling, or grounding
//! classification, only orchestrates existing calls and reports what
//! actually happened. The live turn runs against the REAL configured
//! provider (never a mock): a readiness tool that only simulates success
//! would defeat its own purpose.
//!
//! Eight checks, run in an order chosen so the checks that need to react to
//! the live-turn exercise's own outcome (`provider_connectivity`, whose
//! quick probe can contradict a workflow that actually succeeded) are
//! emitted after it, not before:
//! `config`, `writable_state`, `native_tool_calling`, `grounding`,
//! `tracing`, `session_continuity`, `cleanup`, `provider_connectivity`.
//!
//! `provider_connectivity`'s quick probe is advisory, not authoritative —
//! `cd_core::ai_probe` treats any loopback base URL as "the well-known
//! local Ollama" and reports it unreachable if that specific daemon isn't
//! there, which misfires for a healthy non-Ollama local gateway and for
//! every mock-backed test in this crate. When the four live-turn checks
//! (`native_tool_calling`, `grounding`, `tracing`, `session_continuity`)
//! all pass — direct, authoritative proof the provider actually works —
//! a `provider_connectivity` failure from the quick probe alone is
//! reconciled to a `pass` rather than left standing as a check that
//! contradicts a ready verdict. A genuine live-path failure (any of those
//! four did not pass) leaves the probe's own verdict standing, gating as
//! before.
//!
//! `cleanup` is its own gating check: failing to remove the disposable
//! corpus or the disposable session this run created prevents readiness
//! and is reported in every output format, not only a stderr warning.
//! Cleanup is attempted on every path out of the live-turn exercise —
//! success, a provider failure, a timeout, and an interruption alike (see
//! `run_live_turn_checks`) — nothing this command creates is meant to
//! outlive the check.
//!
//! Every check is defensive: an internal failure (can't build a tool host,
//! can't create the synthetic corpus, a panic-shaped provider response)
//! becomes a `fail` check with an actionable message, never a raw crash —
//! an operator running this right before a demo needs to see what's broken,
//! not a stack trace. The readiness verdict itself is data (`ready: bool`),
//! not the command's own success/failure — a script gates on the process
//! exit code (`ExitCategory::NotReady`, distinct from `Success`), a JSON
//! consumer gates on `data.ready`. `run()` returns `Err` in exactly one
//! case: the operator interrupted the run with Ctrl-C, reported the same
//! way `contextdesk import`'s own interrupt handling already is
//! (`ExitCategory::Cancelled`, exit 130, with cleanup still attempted and
//! its outcome folded into the interrupted message/line) — that is not a
//! failed check, it is the operator choosing to abort, so it is never
//! folded into the `pass`/`fail`/`skip` vocabulary.
//!
//! Credentials: this module never holds a raw secret in a variable it could
//! accidentally serialize or print except the one short-lived value handed
//! straight to `provider_probe::probe_provider`/`run_chat_workflow`, exactly
//! the same as `config init --check-connection` and `chat` already do nor
//! does it ever write to `cli.toml` or the shared `AppConfig` — this is a
//! read-and-probe command, never a config-writing one.

use crate::adapters::Paths;
use crate::cli::DoctorArgs;
use crate::config::OutputFormat;
use crate::envelope::{CliError, CliResult};
use crate::provider_probe;
use cd_core::config::AppConfig;
use cd_core::events::StreamEvent;
use cd_core::keychain_store::SecretStore;
use cd_core::log_analysis::{ActiveTimestampBasis, LogCorpus, LogEvent, TimestampProvenance};
use cd_core::permissions::PermissionDecision;
use cd_core::sessions::SessionStore;
use cd_core::turn_trace::{RecordingTurnTrace, TracedCall, TurnTraceSink};
use cd_workflow::chat::{run_chat_workflow, ChatWorkflowOutcome, ChatWorkflowRequest};
use cd_workflow::provider::resolve_provider_profile;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

const DEFAULT_TIMEOUT_SECS: u64 = 30;
/// Bounded grace period to let an in-flight turn notice cancellation and
/// return cleanly after Ctrl-C, before giving up and proceeding to cleanup
/// regardless. Never blocks the command indefinitely on interruption.
const INTERRUPT_GRACE: Duration = Duration::from_secs(5);
/// Distinctive token identifying this check's own synthetic content —
/// never a real hostname, service name, or company term — so a provider's
/// answer citing it is unambiguous proof the tool actually searched this
/// run's disposable corpus, not something left over from prior use. Also
/// the correlation marker `session_continuity` looks for in the second
/// turn's own traced request (see `second_turn_included_prior_context`):
/// we control this exact text (it lives in turn one's own question), so
/// its presence proves real context threading regardless of how a model
/// phrases its reply.
const SYNTHETIC_MARKER: &str = "SYNTH_DOCTOR_READINESS_CHECK";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CheckStatus {
    Pass,
    Fail,
    Skip,
}

#[derive(Debug, Clone, Serialize)]
pub struct DoctorCheck {
    pub id: &'static str,
    pub status: CheckStatus,
    pub message: String,
}

impl DoctorCheck {
    fn pass(id: &'static str, message: impl Into<String>) -> Self {
        Self {
            id,
            status: CheckStatus::Pass,
            message: message.into(),
        }
    }

    fn fail(id: &'static str, message: impl Into<String>) -> Self {
        Self {
            id,
            status: CheckStatus::Fail,
            message: message.into(),
        }
    }

    fn skip(id: &'static str, message: impl Into<String>) -> Self {
        Self {
            id,
            status: CheckStatus::Skip,
            message: message.into(),
        }
    }
}

fn status_tag(status: CheckStatus) -> &'static str {
    match status {
        CheckStatus::Pass => "PASS",
        CheckStatus::Fail => "FAIL",
        CheckStatus::Skip => "SKIP",
    }
}

/// One line of `--jsonl doctor` output: a `check` line per completed check,
/// streamed as it finishes, then exactly one terminal line — `verdict` when
/// every check ran to completion, or `interrupted` when Ctrl-C aborted the
/// run partway through. Every stdout line under `--jsonl` is always one of
/// these three shapes; `emit_check`/`emit_interrupted`/`emit_verdict` are
/// the only places that ever print one.
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum DoctorLine<'a> {
    Check {
        id: &'a str,
        status: CheckStatus,
        message: &'a str,
    },
    Verdict {
        ready: bool,
        checks_passed: usize,
        checks_failed: usize,
        checks_skipped: usize,
        elapsed_ms: u64,
    },
    Interrupted {
        elapsed_ms: u64,
        /// Whether cleanup — still attempted on an interrupted run — itself
        /// succeeded. An interruption is never a failed check on its own
        /// (exit stays 130 either way), but a cleanup failure during one
        /// must still be visible in structured output, not only stderr.
        cleanup_status: CheckStatus,
        cleanup_detail: String,
    },
}

/// Run every readiness check and render output as each completes. Returns
/// `Ok(ready)` in effectively every case (see module doc comment) — the
/// caller (`main.rs`) turns `ready` into the process exit code.
#[allow(clippy::too_many_arguments)]
pub async fn run(
    args: &DoctorArgs,
    paths: &Paths,
    cfg: &AppConfig,
    secrets: &dyn SecretStore,
    sessions: &SessionStore,
    format: OutputFormat,
    profile_override: Option<&str>,
    model_override: Option<&str>,
) -> CliResult<bool> {
    let started = Instant::now();
    let timeout = Duration::from_secs(args.timeout.unwrap_or(DEFAULT_TIMEOUT_SECS));
    let mut checks: Vec<DoctorCheck> = Vec::new();

    // 1. config — no network, no keychain read.
    let resolved_profile = match resolve_provider_profile(cfg, profile_override) {
        Ok(profile) => {
            let model = model_override
                .map(str::to_string)
                .unwrap_or_else(|| profile.chat_model.clone());
            emit_check(
                format,
                &mut checks,
                DoctorCheck::pass(
                    "config",
                    format!(
                        "profile '{}' ({:?}), model '{model}', data dir {}{}",
                        profile.id,
                        profile.kind,
                        paths.config_dir.display(),
                        if paths.isolated { " (isolated)" } else { "" }
                    ),
                ),
            );
            Some((profile, model))
        }
        Err(message) => {
            emit_check(
                format,
                &mut checks,
                DoctorCheck::fail("config", format!("no usable provider profile: {message}")),
            );
            None
        }
    };

    // 2. writable_state — independent of every other check.
    emit_check(format, &mut checks, check_writable_state(paths));

    // 3-7. native_tool_calling, grounding, tracing, session_continuity,
    // cleanup — all derived from one disposable, synthetic, two-turn live
    // exercise against the real configured provider.
    let live_turn_ids = [
        "native_tool_calling",
        "grounding",
        "tracing",
        "session_continuity",
        "cleanup",
    ];
    if args.skip_live_turn {
        for id in live_turn_ids {
            emit_check(
                format,
                &mut checks,
                DoctorCheck::skip(id, "skipped: --skip-live-turn"),
            );
        }
    } else if let Some((_profile, model)) = &resolved_profile {
        match run_live_turn_checks(
            paths,
            cfg,
            secrets,
            sessions,
            profile_override,
            model,
            timeout,
        )
        .await
        {
            LiveTurnRunOutcome::Checks(live_checks) => {
                for check in live_checks {
                    emit_check(format, &mut checks, check);
                }
            }
            LiveTurnRunOutcome::Interrupted { cleanup } => {
                let elapsed_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
                emit_interrupted(format, elapsed_ms, &cleanup);
                let cleanup_note = if cleanup.status == CheckStatus::Pass {
                    "cleanup succeeded".to_string()
                } else {
                    format!("cleanup FAILED: {}", cleanup.message)
                };
                return Err(CliError::cancelled(format!(
                    "doctor readiness check interrupted before it finished ({cleanup_note})"
                )));
            }
        }
    } else {
        for id in live_turn_ids {
            emit_check(
                format,
                &mut checks,
                DoctorCheck::skip(id, "skipped: no provider profile resolved"),
            );
        }
    }

    // 8. provider_connectivity — bounded, skipped without a resolved
    // profile, RECONCILED against the live-turn checks above rather than
    // emitted eagerly (see module doc comment for why: the quick probe
    // treats any loopback base URL as "the well-known local Ollama" and
    // reports it unreachable regardless of what actually answers there,
    // which would otherwise contradict a `ready` verdict the live turn just
    // proved correct). This check never gates whether the live-turn
    // exercise above is attempted — only its own final displayed status is
    // affected by that exercise's outcome.
    match &resolved_profile {
        Some((profile, _)) => {
            // The keychain read is inside the timed region so a slow (but
            // not literally hanging) keychain still counts against the
            // stated budget rather than being free. It cannot make the
            // budget airtight: `SecretStore::get` is a synchronous trait
            // method with no `.await` point, so if the OS keychain backend
            // itself blocks forever (e.g. an interactive-unlock prompt with
            // no session to answer it, headless CI, a wedged secret-service
            // daemon), this poll cannot yield and `tokio::time::timeout`'s
            // timer cannot fire until that call returns — a real,
            // documented residual limitation shared with every other
            // command that resolves a credential (`chat`, `config init
            // --check-connection`), not something specific to this probe.
            let probe_future = async {
                let secret = match &profile.api_key_ref {
                    Some(key_ref) => secrets.get(key_ref).unwrap_or(None),
                    None => None,
                };
                provider_probe::probe_provider(profile, secret, paths.isolated).await
            };
            let probe = tokio::time::timeout(timeout, probe_future).await;
            let raw_check = match probe {
                Ok(verdict) if verdict.is_pass() => {
                    DoctorCheck::pass("provider_connectivity", verdict.summary())
                }
                Ok(verdict) => DoctorCheck::fail("provider_connectivity", verdict.summary()),
                Err(_elapsed) => DoctorCheck::fail(
                    "provider_connectivity",
                    format!(
                        "timed out after {}s — provider did not respond",
                        timeout.as_secs()
                    ),
                ),
            };
            let live_turn_all_passed = [
                "native_tool_calling",
                "grounding",
                "tracing",
                "session_continuity",
            ]
            .iter()
            .all(|id| {
                checks
                    .iter()
                    .any(|c| c.id == *id && c.status == CheckStatus::Pass)
            });
            let reconciled = if raw_check.status != CheckStatus::Pass && live_turn_all_passed {
                DoctorCheck::pass(
                    "provider_connectivity",
                    format!(
                        "confirmed reachable by the live turn's own successful exchange, \
                         even though the quick probe reported: {}",
                        raw_check.message
                    ),
                )
            } else {
                raw_check
            };
            emit_check(format, &mut checks, reconciled);
        }
        None => {
            emit_check(
                format,
                &mut checks,
                DoctorCheck::skip(
                    "provider_connectivity",
                    "skipped: no provider profile resolved",
                ),
            );
        }
    };

    let ready = checks.iter().all(|c| c.status == CheckStatus::Pass);
    let elapsed_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
    emit_verdict(format, &checks, ready, elapsed_ms);

    Ok(ready)
}

fn emit_check(format: OutputFormat, checks: &mut Vec<DoctorCheck>, check: DoctorCheck) {
    match format {
        OutputFormat::Text => {
            println!(
                "[{}] {:<20} {}",
                status_tag(check.status),
                check.id,
                check.message
            );
        }
        OutputFormat::Jsonl => {
            let line = DoctorLine::Check {
                id: check.id,
                status: check.status,
                message: &check.message,
            };
            println!(
                "{}",
                serde_json::to_string(&line).expect("DoctorLine is always serializable")
            );
        }
        OutputFormat::Json => {}
    }
    checks.push(check);
}

fn emit_verdict(format: OutputFormat, checks: &[DoctorCheck], ready: bool, elapsed_ms: u64) {
    let checks_passed = checks
        .iter()
        .filter(|c| c.status == CheckStatus::Pass)
        .count();
    let checks_failed = checks
        .iter()
        .filter(|c| c.status == CheckStatus::Fail)
        .count();
    let checks_skipped = checks
        .iter()
        .filter(|c| c.status == CheckStatus::Skip)
        .count();
    match format {
        OutputFormat::Text => {
            println!();
            if ready {
                println!("ready — {checks_passed} checks passed in {elapsed_ms}ms");
            } else {
                println!(
                    "not ready — {checks_passed} passed, {checks_failed} failed, \
                     {checks_skipped} skipped in {elapsed_ms}ms (see above)"
                );
            }
        }
        OutputFormat::Jsonl => {
            let line = DoctorLine::Verdict {
                ready,
                checks_passed,
                checks_failed,
                checks_skipped,
                elapsed_ms,
            };
            println!(
                "{}",
                serde_json::to_string(&line).expect("DoctorLine is always serializable")
            );
        }
        OutputFormat::Json => {
            #[derive(Serialize)]
            struct DoctorReport<'a> {
                ready: bool,
                checks: &'a [DoctorCheck],
                elapsed_ms: u64,
            }
            let envelope = crate::envelope::Envelope::ok(
                "doctor",
                DoctorReport {
                    ready,
                    checks,
                    elapsed_ms,
                },
            );
            println!(
                "{}",
                serde_json::to_string(&envelope).expect("Envelope is always serializable")
            );
        }
    }
}

/// The terminal line for an interrupted run. Text and `--jsonl` print their
/// own shape here (mirroring `emit_verdict`), including whether cleanup
/// itself succeeded; `--json` prints nothing directly — `main.rs`'s generic
/// `Envelope::err` fallback is this format's only output for the `Err` this
/// function's caller returns right after this, and that error's own message
/// text folds the same cleanup outcome in, so it is never silently absent
/// from `--json` either.
fn emit_interrupted(format: OutputFormat, elapsed_ms: u64, cleanup: &DoctorCheck) {
    match format {
        OutputFormat::Text => {
            println!();
            println!("interrupted after {elapsed_ms}ms — no readiness verdict was produced");
            println!(
                "[{}] {:<20} {}",
                status_tag(cleanup.status),
                cleanup.id,
                cleanup.message
            );
        }
        OutputFormat::Jsonl => {
            let line = DoctorLine::Interrupted {
                elapsed_ms,
                cleanup_status: cleanup.status,
                cleanup_detail: cleanup.message.clone(),
            };
            println!(
                "{}",
                serde_json::to_string(&line).expect("DoctorLine is always serializable")
            );
        }
        OutputFormat::Json => {}
    }
}

fn check_writable_state(paths: &Paths) -> DoctorCheck {
    let marker = paths.config_dir.join(".doctor-writable-check");
    let write_result = std::fs::write(&marker, b"contextdesk doctor writable-state check")
        .and_then(|()| std::fs::read(&marker))
        .and_then(|content| {
            let ok = content == b"contextdesk doctor writable-state check";
            std::fs::remove_file(&marker)?;
            if ok {
                Ok(())
            } else {
                Err(std::io::Error::other("marker content mismatch after write"))
            }
        });
    match write_result {
        Ok(()) => DoctorCheck::pass(
            "writable_state",
            format!("{} is writable", paths.config_dir.display()),
        ),
        Err(e) => DoctorCheck::fail(
            "writable_state",
            format!("{} is not writable: {e}", paths.config_dir.display()),
        ),
    }
}

/// Outcome of the disposable live-turn exercise, before it has been turned
/// into `DoctorCheck`s — kept separate so cleanup can inspect `session_id`
/// regardless of how the exercise ended.
enum LiveTurnOutcome {
    /// `session_id` is `Some` whenever a session is known to have already
    /// been durably saved before the interrupt was handled — `run_chat_workflow`
    /// persists a non-dry-run session unconditionally on `Ok`, including a
    /// turn that noticed cooperative cancellation and still returned `Ok`
    /// within the grace period, and including turn one's session once turn
    /// two has started. An `Interrupted` outcome must never silently drop a
    /// session id it already has, or cleanup below has nothing to delete.
    Interrupted {
        session_id: Option<String>,
    },
    TimedOut,
    /// A genuine internal failure unrelated to the provider itself (e.g.
    /// could not build a tool host) — still reported as a check failure,
    /// never a crash.
    SetupFailed(String),
    /// The first turn's call to the provider itself failed (unreachable,
    /// malformed response, incompatible model, etc.) — covers "the
    /// production path was exercised and it failed," never silently
    /// downgraded to a skip.
    FirstTurnFailed(String),
    Completed {
        session_id: String,
        tool_called: bool,
        tool_summary: String,
        grounded: bool,
        grounding_detail: String,
        trace_captured: bool,
        continuity: ContinuityOutcome,
    },
}

enum ContinuityOutcome {
    Ok,
    /// The second turn's own dispatch failed outright — a network/protocol
    /// error, a timeout, or the session became unreadable immediately
    /// after being written. An infrastructure-level failure, not a
    /// coherence problem with an otherwise-completed turn.
    SecondTurnFailed(String),
    /// The second turn completed, but failed one or more of
    /// `evaluate_continuity`'s coherence criteria (wrong session id, an
    /// error event, a non-clean terminal reason, an empty answer, history
    /// that did not grow, or a request that did not actually carry
    /// prior-turn context) — every failing criterion is named in the
    /// message, not just the first one found.
    Incoherent(String),
}

impl LiveTurnOutcome {
    fn session_id(&self) -> Option<&str> {
        match self {
            Self::Completed { session_id, .. } => Some(session_id),
            Self::Interrupted { session_id } => session_id.as_deref(),
            _ => None,
        }
    }

    fn into_checks(self) -> Vec<DoctorCheck> {
        match self {
            Self::Interrupted { .. } => vec![
                DoctorCheck::fail("native_tool_calling", "interrupted before completion"),
                DoctorCheck::fail("grounding", "interrupted before completion"),
                DoctorCheck::fail("tracing", "interrupted before completion"),
                DoctorCheck::fail("session_continuity", "interrupted before completion"),
            ],
            Self::TimedOut => vec![
                DoctorCheck::fail("native_tool_calling", "timed out waiting for the provider"),
                DoctorCheck::fail("grounding", "timed out waiting for the provider"),
                DoctorCheck::fail("tracing", "timed out waiting for the provider"),
                DoctorCheck::fail("session_continuity", "timed out waiting for the provider"),
            ],
            Self::SetupFailed(message) => vec![
                DoctorCheck::fail("native_tool_calling", format!("setup failed: {message}")),
                DoctorCheck::fail("grounding", format!("setup failed: {message}")),
                DoctorCheck::fail("tracing", format!("setup failed: {message}")),
                DoctorCheck::fail("session_continuity", format!("setup failed: {message}")),
            ],
            Self::FirstTurnFailed(message) => vec![
                DoctorCheck::fail("native_tool_calling", message.clone()),
                DoctorCheck::fail("grounding", message.clone()),
                DoctorCheck::fail("tracing", message.clone()),
                DoctorCheck::fail("session_continuity", message),
            ],
            Self::Completed {
                tool_called,
                tool_summary,
                grounded,
                grounding_detail,
                trace_captured,
                continuity,
                ..
            } => {
                let mut out = Vec::with_capacity(4);
                out.push(if tool_called {
                    DoctorCheck::pass("native_tool_calling", tool_summary)
                } else {
                    DoctorCheck::fail("native_tool_calling", tool_summary)
                });
                out.push(if grounded {
                    DoctorCheck::pass("grounding", "answer validated against cited evidence")
                } else {
                    DoctorCheck::fail("grounding", grounding_detail)
                });
                out.push(if trace_captured {
                    DoctorCheck::pass("tracing", "turn trace captured at least one provider call")
                } else {
                    DoctorCheck::fail("tracing", "no provider call was recorded by the trace sink")
                });
                out.push(match continuity {
                    ContinuityOutcome::Ok => DoctorCheck::pass(
                        "session_continuity",
                        "second turn continued the same session with a clean stop, a \
                         non-empty answer, growing persisted history, and the first \
                         turn's context confirmed present in its own request",
                    ),
                    ContinuityOutcome::SecondTurnFailed(message) => {
                        DoctorCheck::fail("session_continuity", message)
                    }
                    ContinuityOutcome::Incoherent(message) => {
                        DoctorCheck::fail("session_continuity", message)
                    }
                });
                out
            }
        }
    }
}

/// What actually happened when this run tried to remove the disposable
/// corpus, and — when one was created — the disposable session, it made
/// for the exercise. Attempted on every path out of `run_live_turn_checks`
/// (success, a provider failure, a timeout, and an interruption alike).
/// Surfaced as its own gating `cleanup` check rather than only a stderr
/// warning, so a script gating on the process exit code or a JSON consumer
/// gating on `data.ready` sees — and readiness reflects — a corpus or
/// session that was NOT actually removed.
struct CleanupOutcome {
    corpus_id: String,
    corpus_result: Result<(), String>,
    /// `None` when no session was ever created (e.g. the first turn never
    /// reached a durable `Ok`) — nothing to report there.
    session_result: Option<(String, Result<(), String>)>,
}

impl CleanupOutcome {
    fn into_check(self) -> DoctorCheck {
        let corpus_ok = self.corpus_result.is_ok();
        let session_ok = match &self.session_result {
            None => true,
            Some((_, result)) => result.is_ok(),
        };
        if corpus_ok && session_ok {
            let detail = match &self.session_result {
                Some((id, _)) => {
                    format!(
                        "removed synthetic corpus {} and session {id}",
                        self.corpus_id
                    )
                }
                None => format!(
                    "removed synthetic corpus {} (no session was created)",
                    self.corpus_id
                ),
            };
            DoctorCheck::pass("cleanup", detail)
        } else {
            let mut problems = Vec::new();
            if let Err(e) = &self.corpus_result {
                problems.push(format!("corpus {} was not removed: {e}", self.corpus_id));
            }
            if let Some((id, Err(e))) = &self.session_result {
                problems.push(format!("session {id} was not removed: {e}"));
            }
            DoctorCheck::fail("cleanup", problems.join("; "))
        }
    }
}

/// What `run_live_turn_checks` produced: either a normal set of checks
/// (whatever the exercise's own outcome was — success, a provider failure,
/// or a timeout all still produce a checks list) or an interruption, which
/// carries only the cleanup outcome since no readiness verdict was reached.
enum LiveTurnRunOutcome {
    Checks(Vec<DoctorCheck>),
    Interrupted { cleanup: DoctorCheck },
}

/// Create a disposable synthetic corpus, run two real turns against it
/// through the exact production chat path, and — regardless of how that
/// goes, including a timeout or Ctrl-C — always attempt to delete the
/// corpus and any session it created before returning, folding that
/// attempt's own outcome into the gating `cleanup` check.
async fn run_live_turn_checks(
    paths: &Paths,
    cfg: &AppConfig,
    secrets: &dyn SecretStore,
    sessions: &SessionStore,
    profile_override: Option<&str>,
    model: &str,
    timeout: Duration,
) -> LiveTurnRunOutcome {
    let cache_root = paths.cache_root.clone();
    // `LogCorpus::create` itself already writes a real directory + meta
    // file to disk before returning — the corpus id is captured right
    // away, before seeding, specifically so a *later* failure (seeding,
    // not creation) still has an id to clean up. Folding creation and
    // seeding into one `Result` (as an earlier version of this function
    // did) silently dropped that id on a seed failure, leaking the
    // already-created directory forever.
    let corpus = match LogCorpus::create(&cache_root, "contextdesk-doctor-synthetic") {
        Ok(corpus) => corpus,
        Err(e) => {
            let mut checks = LiveTurnOutcome::SetupFailed(format!(
                "could not create the synthetic readiness-check corpus: {e}"
            ))
            .into_checks();
            checks.push(DoctorCheck::skip(
                "cleanup",
                "skipped: no synthetic corpus was ever created",
            ));
            return LiveTurnRunOutcome::Checks(checks);
        }
    };
    let corpus_id = corpus.id().to_string();
    if let Err(e) = seed_synthetic_events(&corpus) {
        let corpus_result = LogCorpus::discard(&cache_root, &corpus_id).map_err(|e| e.to_string());
        let mut checks = LiveTurnOutcome::SetupFailed(format!(
            "could not seed the synthetic readiness-check corpus: {e}"
        ))
        .into_checks();
        checks.push(
            CleanupOutcome {
                corpus_id,
                corpus_result,
                session_result: None,
            }
            .into_check(),
        );
        return LiveTurnRunOutcome::Checks(checks);
    }
    drop(corpus);

    let outcome = execute_live_turns(
        paths,
        cfg,
        secrets,
        sessions,
        &corpus_id,
        profile_override,
        model,
        timeout,
    )
    .await;

    // Guaranteed cleanup attempt — always made, regardless of outcome —
    // whose own result is now a gating check rather than a silent warning.
    let corpus_result = LogCorpus::discard(&cache_root, &corpus_id).map_err(|e| e.to_string());
    let session_result = outcome.session_id().map(|session_id| {
        let session_id = session_id.to_string();
        let result = sessions.delete(&session_id).map_err(|e| e.to_string());
        (session_id, result)
    });
    let cleanup_check = CleanupOutcome {
        corpus_id,
        corpus_result,
        session_result,
    }
    .into_check();

    if matches!(outcome, LiveTurnOutcome::Interrupted { .. }) {
        return LiveTurnRunOutcome::Interrupted {
            cleanup: cleanup_check,
        };
    }

    let mut checks = outcome.into_checks();
    checks.push(cleanup_check);
    LiveTurnRunOutcome::Checks(checks)
}

fn seed_synthetic_events(corpus: &LogCorpus) -> cd_core::error::CoreResult<()> {
    // A fixed synthetic epoch — never derived from the real current time —
    // so this check's own fixture content is deterministic and can never
    // be mistaken for a real event.
    let base_ts: i64 = 1_800_000_000;
    let events = vec![
        LogEvent {
            seq: 1,
            ts: base_ts,
            timestamp_provenance: TimestampProvenance::ExplicitWallClock,
            active_timestamp_basis: ActiveTimestampBasis::ExplicitWall,
            unresolved_local_timestamp: None,
            level: "ERROR".into(),
            service: Some("doctor-check".into()),
            host: Some("synthetic-host".into()),
            template_id: 1,
            params: vec![],
            trace_id: None,
            message: format!(
                "{SYNTHETIC_MARKER} fired correlation=doctor-1 detail=queue-depth-exceeded"
            ),
            source: "synthetic/doctor-readiness-check.log".into(),
        },
        LogEvent {
            seq: 2,
            ts: base_ts + 1,
            timestamp_provenance: TimestampProvenance::ExplicitWallClock,
            active_timestamp_basis: ActiveTimestampBasis::ExplicitWall,
            unresolved_local_timestamp: None,
            level: "INFO".into(),
            service: Some("doctor-check".into()),
            host: Some("synthetic-host".into()),
            template_id: 2,
            params: vec![],
            trace_id: None,
            message: "doctor readiness follow-up event correlation=doctor-1".into(),
            source: "synthetic/doctor-readiness-check.log".into(),
        },
    ];
    corpus.push_events(&events)?;

    // The corpus store separates raw events from the template/summary
    // metadata a real import always writes alongside them
    // (`cd_workflow::import` computes both together). Skipping this here
    // — the way a first draft of this seed did — still lets a plain
    // keyword search find the events, but the grounding/evidence-
    // validation layer expects a real corpus to have this metadata too, so
    // its absence alone was enough to make an otherwise-successful tool
    // call still classify as ungrounded (`linked_no_tool`). Match a real
    // import: one template row per distinct `template_id` above.
    let templates = [
        (1u64, "queue-depth-exceeded", 4u8),
        (2u64, "readiness follow-up", 1u8),
    ];
    corpus.upsert_templates(templates.iter().map(|(template_id, pattern, severity)| {
        cd_core::log_analysis::TemplateRow {
            info: cd_core::log_analysis::TemplateInfo {
                template_id: *template_id,
                pattern: (*pattern).into(),
                token_count: pattern.split_whitespace().count(),
                count: 1,
                first_seen: base_ts,
                last_seen: base_ts,
                severity: *severity,
                example: (*pattern).into(),
            },
            content_hash: format!("doctor-synthetic-hash-{template_id}"),
            vector: None,
        }
    }))?;
    corpus.write_ingest_summary(
        Some("contextdesk doctor synthetic check".to_string()),
        cd_core::log_analysis::CorpusStats {
            files: 1,
            discovered_files: 1,
            lines: events.len() as u64,
            templates: templates.len() as u64,
            ts_min: Some(base_ts),
            ts_max: Some(base_ts + 1),
            ..Default::default()
        },
        vec![],
        cd_core::log_analysis::CorpusEmbeddingStatus::default(),
    )?;

    corpus.flush()
}

#[allow(clippy::too_many_arguments)]
async fn execute_live_turns(
    paths: &Paths,
    cfg: &AppConfig,
    secrets: &dyn SecretStore,
    sessions: &SessionStore,
    corpus_id: &str,
    profile_override: Option<&str>,
    model: &str,
    timeout: Duration,
) -> LiveTurnOutcome {
    let question_one = format!(
        "Search the logs for {SYNTHETIC_MARKER} and tell me exactly what correlation id it \
         referenced, citing the source."
    );
    let recorder = Arc::new(RecordingTurnTrace::new());
    let trace_sink: Arc<dyn TurnTraceSink> = recorder.clone();
    let cancel = Arc::new(AtomicBool::new(false));

    let mut host = match crate::adapters::tool_host_with_app_config(&paths.cache_root, cfg, secrets)
    {
        Ok(host) => host,
        Err(e) => return LiveTurnOutcome::SetupFailed(format!("could not build tool host: {e}")),
    };

    let turn_one = run_chat_workflow(
        &mut host,
        secrets,
        cfg,
        sessions,
        &paths.cache_root,
        None,
        &question_one,
        ChatWorkflowRequest {
            corpus_id: Some(corpus_id),
            explicit_profile_id: profile_override,
            chat_model_override: Some(model),
            dry_run: false,
            trace_sink: Some(trace_sink),
            user_selection: None,
        },
        Some(cancel.clone()),
        None,
        // This check only ever calls the CLI's own read-only search tool
        // against a corpus it just created and will delete before
        // returning — there is nothing here for an operator to confirm.
        |_tool_name, _target, _reason, _preview, _risk| PermissionDecision::AllowOnce,
    );
    tokio::pin!(turn_one);

    let raced = tokio::select! {
        result = tokio::time::timeout(timeout, &mut turn_one) => result,
        _ = tokio::signal::ctrl_c() => {
            cancel.store(true, Ordering::SeqCst);
            eprintln!("doctor: interrupted — waiting for the in-flight check to stop...");
            // Best-effort: give the turn a bounded chance to notice the
            // cancel flag and wind down cleanly. This run is reported as
            // Interrupted regardless of whether the turn then happened to
            // finish within the grace period — Ctrl-C was pressed, so
            // treating a cooperative-cancel completion as an ordinary
            // outcome would report the wrong exit code for what the user
            // actually did. But `run_chat_workflow` persists a non-dry-run
            // session unconditionally on ANY `Ok` result, including a
            // cooperatively-cancelled one — so if the grace period *did*
            // observe an `Ok`, its session was already saved to disk and
            // must still be captured here for cleanup, or it leaks
            // permanently into the real session store.
            let leaked_session_id = match tokio::time::timeout(INTERRUPT_GRACE, &mut turn_one).await {
                Ok(Ok(outcome)) => Some(outcome.session_id),
                _ => None,
            };
            return LiveTurnOutcome::Interrupted { session_id: leaked_session_id };
        }
    };

    let outcome_one = match raced {
        Ok(Ok(outcome)) => outcome,
        Ok(Err(e)) => return LiveTurnOutcome::FirstTurnFailed(e.to_string()),
        Err(_elapsed) => return LiveTurnOutcome::TimedOut,
    };

    // A linked turn's own provider/retrieval failure (an unreachable
    // endpoint, a malformed response, a rejected model) surfaces as an `Ok`
    // outcome carrying a `StreamEvent::Error` — `run_chat_workflow` still
    // returns successfully because the turn itself was preserved (a session
    // exists) even though no grounded answer was produced. Surface that
    // underlying reason directly in both derived checks below rather than
    // the more confusing "the provider declined to call a tool" framing,
    // which is only actually true when no such error is present.
    let turn_error = outcome_one.events.iter().find_map(|event| match event {
        StreamEvent::Error { code, message } => Some((code.clone(), message.clone())),
        _ => None,
    });

    let tool_called = outcome_one.events.iter().any(|event| {
        matches!(
            event,
            StreamEvent::Tool {
                phase: cd_core::events::ToolPhase::Finished,
                ok: Some(true),
                ..
            }
        )
    });
    let tool_summary = if tool_called {
        "the provider invoked a native tool and it completed successfully".to_string()
    } else if let Some((code, message)) = &turn_error {
        format!("the turn did not complete: {message} ({code})")
    } else {
        "no successful native tool call was observed in the first turn's events".to_string()
    };
    let grounding = crate::commands::chat::grounding_status(Some(corpus_id), &outcome_one.events);
    let grounded = grounding == "grounded";
    let grounding_detail = if let Some((code, message)) = &turn_error {
        format!("answer failed evidence validation: {message} ({code})")
    } else {
        format!("answer failed evidence validation ({grounding})")
    };
    let trace_captured = !recorder.calls().is_empty();
    let session_id = outcome_one.session_id.clone();
    // Baseline for `session_continuity`'s history-growth check below —
    // read back independently rather than trusting a self-reported count,
    // so the check proves what was actually persisted, not just what the
    // workflow claims it persisted. A read failure here is vanishingly
    // unlikely (the session was just written by this same process) and is
    // not worth aborting the exercise over; `0` makes the later growth
    // check strictly *more* demanding, never less, in that edge case.
    let messages_before = sessions
        .load(&session_id)
        .map(|s| s.messages.len())
        .unwrap_or(0);

    let question_two =
        "What correlation id did that event reference? Answer using only what we already found.";
    let mut host_two =
        match crate::adapters::tool_host_with_app_config(&paths.cache_root, cfg, secrets) {
            Ok(host) => host,
            Err(e) => {
                return LiveTurnOutcome::Completed {
                    session_id,
                    tool_called,
                    tool_summary,
                    grounded,
                    grounding_detail,
                    trace_captured,
                    continuity: ContinuityOutcome::SecondTurnFailed(format!(
                        "could not build tool host for the second turn: {e}"
                    )),
                };
            }
        };
    // The second turn gets its own trace capture — separate from turn
    // one's `recorder` above — so `session_continuity` can inspect exactly
    // what request the second call actually sent, not infer it from turn
    // one's trace.
    let recorder_two = Arc::new(RecordingTurnTrace::new());
    let trace_sink_two: Arc<dyn TurnTraceSink> = recorder_two.clone();
    let turn_two = run_chat_workflow(
        &mut host_two,
        secrets,
        cfg,
        sessions,
        &paths.cache_root,
        Some(&session_id),
        question_two,
        ChatWorkflowRequest {
            corpus_id: Some(corpus_id),
            explicit_profile_id: profile_override,
            chat_model_override: Some(model),
            dry_run: false,
            trace_sink: Some(trace_sink_two),
            user_selection: None,
        },
        Some(cancel.clone()),
        None,
        |_tool_name, _target, _reason, _preview, _risk| PermissionDecision::AllowOnce,
    );
    tokio::pin!(turn_two);
    let raced_two = tokio::select! {
        result = tokio::time::timeout(timeout, &mut turn_two) => result,
        _ = tokio::signal::ctrl_c() => {
            cancel.store(true, Ordering::SeqCst);
            eprintln!("doctor: interrupted — waiting for the in-flight check to stop...");
            let _ = tokio::time::timeout(INTERRUPT_GRACE, &mut turn_two).await;
            // Unlike turn one, `session_id` here is already known and was
            // already durably saved by `run_chat_workflow` before turn two
            // even started — capture it unconditionally so cleanup can
            // still remove it, regardless of how turn two's own grace
            // period resolved.
            return LiveTurnOutcome::Interrupted { session_id: Some(session_id.clone()) };
        }
    };

    let continuity = match raced_two {
        Ok(Ok(outcome_two)) => match sessions.load(&session_id) {
            Ok(session_after) => evaluate_continuity(
                &session_id,
                &outcome_two,
                &recorder_two.calls(),
                messages_before,
                session_after.messages.len(),
            ),
            Err(e) => ContinuityOutcome::SecondTurnFailed(format!(
                "could not re-read session '{session_id}': {e}"
            )),
        },
        Ok(Err(e)) => ContinuityOutcome::SecondTurnFailed(e.to_string()),
        Err(_elapsed) => ContinuityOutcome::SecondTurnFailed("second turn timed out".to_string()),
    };

    LiveTurnOutcome::Completed {
        session_id: session_id.clone(),
        tool_called,
        tool_summary,
        grounded,
        grounding_detail,
        trace_captured,
        continuity,
    }
}

/// Every fact this readiness check requires before it will call a second
/// turn genuinely, contextually successful — not merely "the request came
/// back without an error." Every criterion is checked (rather than
/// short-circuiting on the first failure) so a `fail` message names
/// everything actually wrong, not just the first thing found.
fn evaluate_continuity(
    session_id: &str,
    outcome_two: &ChatWorkflowOutcome,
    turn_two_calls: &[TracedCall],
    messages_before: usize,
    messages_after: usize,
) -> ContinuityOutcome {
    let mut problems = Vec::new();

    if outcome_two.session_id != session_id {
        problems.push(format!(
            "second turn returned session '{}' instead of continuing '{session_id}'",
            outcome_two.session_id
        ));
    }

    if let Some((code, message)) = outcome_two.events.iter().find_map(|event| match event {
        StreamEvent::Error { code, message } => Some((code.clone(), message.clone())),
        _ => None,
    }) {
        problems.push(format!(
            "second turn produced an error event: {message} ({code})"
        ));
    }

    match outcome_two
        .events
        .iter()
        .rev()
        .find_map(|event| match event {
            StreamEvent::TurnCompleted { reason } => Some(reason.as_str()),
            _ => None,
        }) {
        Some("stop") => {}
        Some(other) => problems.push(format!(
            "second turn's terminal outcome was '{other}', not a clean stop"
        )),
        None => problems.push("second turn produced no terminal outcome event".to_string()),
    }

    if outcome_two.final_text.trim().is_empty() {
        problems.push("second turn produced an empty final answer".to_string());
    }

    if messages_after < messages_before + 2 {
        problems.push(format!(
            "persisted history only grew from {messages_before} to {messages_after} \
             message(s) — a genuine second turn should add at least a user and an \
             assistant message"
        ));
    }

    if let Err(e) = second_turn_included_prior_context(turn_two_calls) {
        problems.push(e);
    }

    if problems.is_empty() {
        ContinuityOutcome::Ok
    } else {
        ContinuityOutcome::Incoherent(problems.join("; "))
    }
}

/// `Ok` only when at least one message in the second turn's OWN traced
/// request contains the first turn's synthetic marker — direct,
/// provider-agnostic proof that real prior-turn context (not just a bare
/// follow-up question) actually reached the provider on the second call.
///
/// Deliberately checks for a marker WE control — it lives in turn one's
/// own question text (`execute_live_turns` constructs it), never in a
/// model's freeform reply — rather than matching any part of a model's
/// prose, which would be brittle across providers and phrasing. Whether
/// the marker got there via genuine session history or a fresh, successful
/// re-retrieval of the same synthetic evidence, either is legitimate proof
/// of continuity; only its total absence is a problem.
fn second_turn_included_prior_context(calls: &[TracedCall]) -> Result<(), String> {
    if calls.is_empty() {
        return Err("the second turn's own trace sink recorded no provider call".to_string());
    }
    let found = calls.iter().any(|call| {
        call.messages
            .iter()
            .any(|m| m.content.contains(SYNTHETIC_MARKER))
    });
    if found {
        Ok(())
    } else {
        Err(format!(
            "the second turn's own request never included the first turn's synthetic \
             marker ({SYNTHETIC_MARKER}) in any traced message — prior-turn context \
             appears to be missing"
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cd_core::turn_trace::{TracedMessage, TracedOutcome};

    fn call_with_messages(contents: &[&str]) -> TracedCall {
        TracedCall {
            seq: 0,
            elapsed_ms: 1,
            tool_names: vec![],
            messages: contents
                .iter()
                .map(|c| TracedMessage {
                    role: "user".to_string(),
                    content: (*c).to_string(),
                    char_count: c.chars().count(),
                    truncated: false,
                })
                .collect(),
            context_used_chars: contents.iter().map(|c| c.chars().count()).sum(),
            messages_capped: false,
            outcome: TracedOutcome::Completed {
                finish_reason: "stop".into(),
                tool_call_count: 0,
            },
            transport: Default::default(),
            empty_visible_answer: false,
        }
    }

    #[test]
    fn second_turn_context_check_passes_when_the_marker_survives_into_the_request() {
        let calls = vec![call_with_messages(&[
            "system prompt",
            &format!("Search the logs for {SYNTHETIC_MARKER} and tell me..."),
            "the answer was correlation doctor-1",
            "What correlation id did that event reference?",
        ])];
        assert!(second_turn_included_prior_context(&calls).is_ok());
    }

    /// Mutation test: strip the first turn's history from what the second
    /// request carried — exactly what a real history-threading regression
    /// would do — and confirm the check fails instead of silently passing.
    #[test]
    fn second_turn_context_check_fails_when_prior_history_is_removed_from_the_request() {
        let mutated = vec![call_with_messages(&[
            "system prompt",
            "What correlation id did that event reference?",
        ])];
        let result = second_turn_included_prior_context(&mutated);
        assert!(
            result.is_err(),
            "removing the first turn's history from the second request must fail this check"
        );
        assert!(result.unwrap_err().contains(SYNTHETIC_MARKER));
    }

    #[test]
    fn second_turn_context_check_fails_when_no_call_was_recorded_at_all() {
        assert!(second_turn_included_prior_context(&[]).is_err());
    }

    #[test]
    fn evaluate_continuity_passes_only_when_every_criterion_holds() {
        let outcome = ChatWorkflowOutcome {
            session_id: "sess-1".to_string(),
            turn_id: "sess-1::turn-1".to_string(),
            events: vec![StreamEvent::TurnCompleted {
                reason: "stop".to_string(),
            }],
            final_text: "the correlation id was doctor-1".to_string(),
            provider_profile_id: "p".to_string(),
            chat_model: "m".to_string(),
            corpus_revision: None,
            history_messages: 4,
        };
        let calls = vec![call_with_messages(&[&format!(
            "Search the logs for {SYNTHETIC_MARKER} and tell me..."
        )])];
        assert!(matches!(
            evaluate_continuity("sess-1", &outcome, &calls, 2, 4),
            ContinuityOutcome::Ok
        ));
    }

    #[test]
    fn evaluate_continuity_names_every_failing_criterion() {
        let outcome = ChatWorkflowOutcome {
            session_id: "different-session".to_string(),
            turn_id: "different-session::turn-1".to_string(),
            events: vec![
                StreamEvent::Error {
                    code: "linked_no_tool".to_string(),
                    message: "no evidence".to_string(),
                },
                StreamEvent::TurnCompleted {
                    reason: "cancel".to_string(),
                },
            ],
            final_text: String::new(),
            provider_profile_id: "p".to_string(),
            chat_model: "m".to_string(),
            corpus_revision: None,
            history_messages: 2,
        };
        let calls = vec![call_with_messages(&[
            "a follow-up question with no prior context",
        ])];
        let message = match evaluate_continuity("sess-1", &outcome, &calls, 2, 2) {
            ContinuityOutcome::Incoherent(message) => message,
            other => panic!("expected Incoherent, got a different outcome ({})", {
                match other {
                    ContinuityOutcome::Ok => "Ok",
                    ContinuityOutcome::SecondTurnFailed(_) => "SecondTurnFailed",
                    ContinuityOutcome::Incoherent(_) => unreachable!(),
                }
            }),
        };
        assert!(message.contains("different-session"), "{message}");
        assert!(message.contains("error event"), "{message}");
        assert!(message.contains("not a clean stop"), "{message}");
        assert!(message.contains("empty"), "{message}");
        assert!(message.contains("2 to 2"), "{message}");
        assert!(message.contains(SYNTHETIC_MARKER), "{message}");
    }
}
