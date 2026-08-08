//! [`run_chat_workflow`]: the CLI's complete chat lifecycle for one exchange
//! — session load/create, linked-corpus bind/unbind, the provider round,
//! a bounded permission grant-and-continue loop, and durable persistence,
//! all in one call. This is CLI-shaped orchestration, not a second "shared
//! entry point" hosts converge on — see the correction below.
//!
//! **What is actually shared with Tauri's desktop host, and what is not.**
//! Earlier revisions of this module described this file itself as "the
//! shared chat entry point for both Tauri and the CLI." That is no longer
//! (and was never fully) accurate, and this comment used to claim more
//! lifecycle parity than exists — corrected here rather than left to mislead
//! a future reader:
//!
//! - **Shared**: [`crate::provider`] (provider/model-override/tools-capability/
//!   deadline resolution) and [`crate::turn`] (linked-corpus bind/unbind plus
//!   the actual turn-driving call into `cd_core::research`) are the real
//!   kernel both hosts call. Tauri's `agent_turn` command
//!   (`desktop/src-tauri/src/lib.rs`) calls
//!   `crate::provider::resolve_turn_inputs_from_profile` and
//!   `crate::turn::run_turn` directly — the same function
//!   [`run_chat_workflow`] below calls — so CLI and GUI turns given
//!   equivalent inputs produce equivalent grounding decisions, trace facts,
//!   and tool results.
//! - **NOT shared — `run_chat_workflow` itself**: Tauri's `agent_turn` does
//!   not call this function. Everything in this file beyond the
//!   provider/turn kernel — session load/create, the permission
//!   grant-and-continue loop, and persistence — is a CLI-specific
//!   composition of that kernel, kept in this crate only so the CLI has
//!   somewhere host-neutral to live, not because Tauri reuses it.
//! - **Why persistence stays host-owned**: `run_chat_workflow` unconditionally
//!   saves the session on every successful (non-dry-run) turn. Tauri's
//!   `agent_turn` does not — it only persists durably on a *linked-turn
//!   failure* (`persist_linked_provider_loop_terminal_at`); an ordinary or
//!   successful-linked turn's durable save happens later, via a separate
//!   renderer-triggered command, after the UI has a chance to reconcile
//!   client-generated message ids with what the host actually produced.
//!   Routing Tauri through `run_chat_workflow` would make it save twice (or
//!   prematurely, before that reconciliation) — a real regression, not a
//!   simplification, so this was deliberately left alone.
//! - **Why permission continuation stays host-owned**: `cd_core::research`'s
//!   turn functions surface a mid-turn `PermissionRequired` event and stop
//!   for that tool call. A CLI process can prompt synchronously and loop
//!   right there, which is exactly what this module's grant-and-continue
//!   loop does. Tauri cannot: the decision comes from a renderer permission
//!   modal over IPC, asynchronously, on a completely different event-loop
//!   turn — so `agent_turn` instead ends its own call at that point and the
//!   desktop app resumes the tool call as a *separate* follow-up command
//!   once the modal returns. Collapsing that into a synchronous loop is not
//!   possible without changing the IPC/UI contract, which is out of scope
//!   for sharing a provider/turn kernel.
//!
//! What this module still gets for free from `cd_core`/other modules in this
//! crate: [`cd_core::sessions::SessionStore`] is the SAME durable transcript
//! store the desktop app already uses, so a session started in the GUI can
//! continue from the CLI and vice versa; [`cd_core::keychain_store::KeychainSecretStore`]
//! is the SAME OS keychain access, so a provider configured in the GUI works
//! immediately from the CLI with no separate credential setup.

use crate::provider::{resolve_turn_inputs, ResolvedTurnInputs};
use crate::turn::{bind_linked_corpus, run_turn, unbind_linked_corpus, TurnExecutionOptions};
use cd_core::agent::LogExplorerTurnContext;
use cd_core::chat::{ChatMessage, Role};
use cd_core::config::AppConfig;
use cd_core::error::{CoreError, CoreResult};
use cd_core::events::StreamEvent;
use cd_core::keychain_store::SecretStore;
use cd_core::permissions::PermissionDecision;
use cd_core::sessions::{Session, SessionStore, StoredMessage};
use cd_core::tool_host::ToolHost;
use cd_core::turn_trace::{RecordingTurnTrace, TurnTraceSink};
use serde_json::Value;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize};
use std::sync::Arc;

/// Bound on synchronous grant-and-continue rounds within one workflow call —
/// a person answering three permission prompts in a row for one question is
/// already an unusual turn; a fourth pending request ends the turn honestly
/// rather than prompting forever.
pub const MAX_PERMISSION_ROUNDS: usize = 3;

/// One chat request, host-neutral.
#[derive(Default)]
pub struct ChatWorkflowRequest<'a> {
    /// Corpus to ground this turn in, if any. `None` runs an ordinary,
    /// unlinked turn.
    pub corpus_id: Option<&'a str>,
    /// Explicit provider profile id, if the caller wants to override the
    /// active/default profile for this turn only.
    pub explicit_profile_id: Option<&'a str>,
    /// Explicit per-turn chat model override.
    pub chat_model_override: Option<&'a str>,
    /// Construct the exact same bounded, redacted conversation and grounded
    /// log context a real turn would, but guarantee no provider request
    /// occurs (see `cd_core::research`'s `..._and_trace` entry point for the
    /// exact mechanism). Session/corpus resolution and binding happen
    /// exactly as normal; only persistence is skipped — see
    /// [`run_chat_workflow`].
    pub dry_run: bool,
    /// Capture every backend call this turn makes — real, or under
    /// `dry_run`, synthetic — for the caller to render at whatever trace
    /// level it wants. `None` costs nothing extra: no wrapping backend is
    /// constructed at all.
    pub trace_sink: Option<Arc<dyn TurnTraceSink>>,
    /// Text explicitly selected by the user for this turn only. This is not
    /// inferred from linked corpus, viewport, ambient memory, or attachments.
    pub user_selection: Option<&'a str>,
    /// Multi-model mode for this turn. `Single` (the default) runs the
    /// established path unchanged; `Review` opts in to the reviewer pipeline
    /// with deterministic degradation.
    pub multi_model_mode: cd_core::multi_model::MultiModelMode,
    /// Host-resolved reviewer qualification verdict: `Some(true)` measured
    /// pass, `Some(false)` measured fail, `None` unverified. A caller with no
    /// qualification store leaves this `None`; a `require_qualified` reviewer
    /// then degrades honestly.
    pub reviewer_qualified: Option<bool>,
}

/// Outcome of one workflow call.
pub struct ChatWorkflowOutcome {
    /// The session this turn ran against (existing or newly created).
    pub session_id: String,
    /// Stable id for this concrete workflow turn.
    pub turn_id: String,
    /// Every stream event across every internal permission round.
    pub events: Vec<StreamEvent>,
    /// Convenience: the concatenation of every `TextDelta` chunk.
    pub final_text: String,
    /// Resolved provider profile id this turn used — a real request under
    /// this identity for an ordinary call, or the identity a real turn
    /// would have used, for a dry run.
    pub provider_profile_id: String,
    /// Resolved chat model id, same caveat as `provider_profile_id`.
    pub chat_model: String,
    /// The linked corpus's event revision at bind time, if this turn was
    /// corpus-linked.
    pub corpus_revision: Option<u64>,
    /// Exact event/template/suppression revision for typed answer authority.
    pub corpus_snapshot_revision: Option<cd_core::investigation_answer::LogSnapshotRevisionV1>,
    /// Total messages in this session's chat history after the turn
    /// (system preamble + every prior + new turn) — a trace summary's
    /// "history count."
    pub history_messages: usize,
    /// Configured multi-model mode for this turn (what was requested).
    pub multi_model_configured: cd_core::multi_model::MultiModelMode,
    /// Executed multi-model mode, honest about degradation. `single` when
    /// review was not requested or degraded at entry; the seam reports
    /// `review` / `review_degraded` via the event stream.
    pub multi_model_executed: cd_core::multi_model::ExecutedMode,
    /// Exact entry-time degradation reason, if review was requested but could
    /// not run. Mid-pipeline degradations are reported on the event stream.
    pub multi_model_entry_degradation: Option<cd_core::multi_model::DegradationReason>,
}

fn role_str(role: &Role) -> &'static str {
    match role {
        Role::User => "user",
        Role::Assistant => "assistant",
        Role::System => "system",
        Role::Tool => "tool",
    }
}

/// Metadata key reserved for a host-produced investigation envelope.  It is
/// deliberately written only from [`StreamEvent::InvestigationAnswer`], never
/// from a rendered transcript or a caller-provided JSON value.
pub const INVESTIGATION_ANSWER_META_KEY: &str = "investigation_answer_envelope_v1";

fn stored_from_chat(
    message: &ChatMessage,
    investigation_answer: Option<&cd_core::investigation_answer::AnswerEnvelopeV1>,
) -> StoredMessage {
    StoredMessage {
        id: uuid::Uuid::new_v4().to_string(),
        role: role_str(&message.role).to_string(),
        content: message.content.clone(),
        tools: None,
        citations: None,
        trail: None,
        meta: investigation_answer
            .map(|envelope| serde_json::json!({ INVESTIGATION_ANSWER_META_KEY: envelope })),
    }
}

fn investigation_answer_for_turn<'a>(
    events: &'a [StreamEvent],
    session_id: &str,
    turn_id: &str,
    request_corpus_id: Option<&str>,
    session_corpus_id: Option<&str>,
    corpus_snapshot_revision: Option<cd_core::investigation_answer::LogSnapshotRevisionV1>,
) -> Option<&'a cd_core::investigation_answer::AnswerEnvelopeV1> {
    let (Some(request_corpus_id), Some(session_corpus_id), Some(corpus_snapshot_revision)) = (
        request_corpus_id,
        session_corpus_id,
        corpus_snapshot_revision,
    ) else {
        return None;
    };
    if request_corpus_id != session_corpus_id {
        return None;
    }
    events.iter().rev().find_map(|event| match event {
        StreamEvent::InvestigationAnswer { envelope }
            if envelope.binding.session_id == session_id
                && envelope.binding.turn_id == turn_id
                && envelope.binding.corpus_id == request_corpus_id
                && envelope.binding.revision == corpus_snapshot_revision =>
        {
            Some(envelope)
        }
        _ => None,
    })
}

fn has_pending_permission(events: &[StreamEvent]) -> Option<(String, String, Value)> {
    events.iter().find_map(|event| match event {
        StreamEvent::PermissionRequired {
            request_id,
            tool_name,
            arguments,
            ..
        } => Some((request_id.clone(), tool_name.clone(), arguments.clone())),
        _ => None,
    })
}

/// Run one CLI chat turn end to end: resolve the profile, load or create the
/// session, bind the corpus if linked, drive the turn (resuming through up
/// to [`MAX_PERMISSION_ROUNDS`] synchronous permission prompts), persist the
/// new messages, and unbind. Desktop cannot call this CLI-shaped lifecycle
/// because its permission and transcript persistence handshakes are
/// asynchronous renderer interactions; both hosts converge one layer down in
/// [`run_turn`].
///
/// `request.dry_run` changes exactly one thing about this sequence:
/// **nothing is persisted**. Profile resolution, session load/creation,
/// corpus binding, and context assembly all happen exactly as they would for
/// a real turn — a dry run inspects the real machinery, it does not take a
/// separate path through it — but `sessions.save` is never called, so a dry
/// run against an existing session can never silently add a stray empty
/// "assistant reply" to that session's durable history, and a dry run with
/// no `--session` never creates one at all.
#[allow(clippy::too_many_arguments)]
pub async fn run_chat_workflow(
    host: &mut ToolHost,
    secrets: &dyn SecretStore,
    cfg: &AppConfig,
    sessions: &SessionStore,
    cache_root: &Path,
    session_id: Option<&str>,
    user_text: &str,
    request: ChatWorkflowRequest<'_>,
    cancel: Option<Arc<AtomicBool>>,
    live: Option<&mut (dyn FnMut(StreamEvent) + Send)>,
    mut decide_permission: impl FnMut(&str, &str, &str, &str, &str) -> PermissionDecision,
) -> CoreResult<ChatWorkflowOutcome> {
    let resolved: ResolvedTurnInputs = resolve_turn_inputs(
        secrets,
        cfg,
        request.explicit_profile_id,
        request.chat_model_override,
    )
    .map_err(CoreError::Message)?;

    let mut session = match session_id {
        Some(id) => sessions.load(id)?,
        None => Session::new(cd_core::sessions::title_from_prompt(user_text, 40)),
    };
    if let Some(corpus_id) = request.corpus_id {
        session.set_linked_corpus_id(Some(corpus_id.to_string()));
    }
    let session_id = session.id.clone();

    let mut history = session.to_chat_history();
    let before_len = history.len();

    // Resolve the multi-model reviewer runtime. Review is only meaningful for a
    // corpus-linked investigation turn (the reviewer pipeline runs at the
    // broad-triage seam), so an unlinked turn stays single-model regardless of
    // the requested mode. The reviewer's per-call context budget matches the
    // turn's resolved budget.
    let review_context_budget = host
        .model_context_budgets()
        .resolve(Some(resolved.profile.chat_model.as_str()));
    let review_mode = if request.corpus_id.is_some() {
        request.multi_model_mode
    } else {
        cd_core::multi_model::MultiModelMode::Single
    };
    let review = crate::multi_model::resolve_reviewer_runtime(
        cfg,
        secrets,
        review_mode,
        &resolved,
        request.reviewer_qualified,
        review_context_budget,
    )
    .await;
    let multi_model_runtime = review.runtime.clone();
    let multi_model_configured = review.configured_mode;
    let multi_model_entry_degradation = review.entry_degradation;

    let binding = match request.corpus_id {
        Some(corpus_id) => Some(bind_linked_corpus(host, cache_root, corpus_id)?),
        None => None,
    };
    // `run_linked_turn` takes an already-built context rather than a bare
    // corpus id — a host with its own viewport/filters/lane concept (Log
    // Explorer) needs to pass its own richer context through unmodified.
    // This CLI-shaped caller has nothing beyond "one corpus attached to a
    // durable chat," so it builds exactly the bare shape here instead of
    // leaving that construction implicit inside the shared function.
    let linked_context = match request.corpus_id {
        Some(corpus_id) => match LogExplorerTurnContext::for_main_chat(corpus_id) {
            Ok(context) => Some(context),
            Err(error) => {
                if let Some(binding) = binding {
                    unbind_linked_corpus(host, binding);
                }
                return Err(error);
            }
        },
        None => None,
    };

    let turn_id = format!("{}::{}", session_id, uuid::Uuid::new_v4());
    let mut all_events = Vec::new();
    let mut rounds = 0usize;
    // The CLI's synchronous permission grants resume one user turn through
    // several `run_turn` segments. Keep one recorder and sequence across them
    // so the final DTO is workflow-scoped, has unique round ids, and never
    // drops the provider call that preceded the permission prompt.
    let workflow_telemetry_recorder = Arc::new(RecordingTurnTrace::new());
    let workflow_telemetry_sequence = Arc::new(AtomicUsize::new(0));
    // A concrete, always-present sink lets each loop iteration reborrow the
    // SAME `&mut dyn FnMut`, which the borrow checker tracks precisely across
    // iterations; matching `live` fresh inside the loop does not, because
    // the option's inner lifetime is fixed by the outer signature rather
    // than shrinkable per loop turn — so it is unwrapped exactly once here,
    // before the loop, into a plain `&mut dyn FnMut` that gets reborrowed
    // per iteration instead.
    let mut noop_sink = |_event: StreamEvent| {};
    let live_sink: &mut (dyn FnMut(StreamEvent) + Send) = match live {
        Some(sink) => sink,
        None => &mut noop_sink,
    };
    // An entry-time reviewer degradation is reported once, before the turn, so
    // the caller knows review was requested but is running single-model and
    // why. Mid-pipeline degradations are reported by the seam itself.
    if let Some(reason) = multi_model_entry_degradation {
        let event = crate::multi_model::entry_degradation_event(reason);
        live_sink(event.clone());
        all_events.push(event);
    }
    loop {
        let events = run_turn(
            host,
            &resolved,
            user_text,
            &mut history,
            &session_id,
            TurnExecutionOptions {
                turn_id: Some(turn_id.clone()),
                context: linked_context.clone(),
                cancel: cancel.clone(),
                dry_run: request.dry_run,
                trace_sink: request.trace_sink.clone(),
                telemetry_recorder: Some(workflow_telemetry_recorder.clone()),
                telemetry_sequence: Some(workflow_telemetry_sequence.clone()),
                suppress_provider_telemetry_event: true,
                user_selection: request.user_selection,
                multi_model: multi_model_runtime.clone(),
                ..TurnExecutionOptions::default()
            },
            Some(&mut *live_sink),
            None,
        )
        .await;
        let events = match events {
            Ok(events) => events,
            Err(error) => {
                if let Some(binding) = binding {
                    unbind_linked_corpus(host, binding);
                }
                return Err(error);
            }
        };
        all_events.extend(events.iter().cloned());

        let Some((request_id, tool_name, arguments)) = has_pending_permission(&events) else {
            break;
        };
        if rounds >= MAX_PERMISSION_ROUNDS {
            break;
        }
        rounds += 1;
        let (target, reason, preview, risk) = events
            .iter()
            .find_map(|event| match event {
                StreamEvent::PermissionRequired {
                    target,
                    reason,
                    preview,
                    risk,
                    ..
                } => Some((
                    target.clone(),
                    reason.clone(),
                    preview.clone(),
                    risk.clone(),
                )),
                _ => None,
            })
            .unwrap_or_default();
        let decision = decide_permission(&tool_name, &target, &reason, &preview, &risk);
        let grant_events = cd_core::research::grant_and_execute(
            host,
            &request_id,
            decision,
            None,
            &tool_name,
            &arguments,
            Some(&mut history),
        )
        .await?;
        all_events.extend(grant_events);
    }

    // Emit precisely one shared DTO for the whole CLI chat workflow. This is
    // deliberately after permission continuation and grant events so every
    // provider call in the user-visible turn contributes to the aggregate.
    let telemetry_event = crate::provider_telemetry::aggregate_provider_telemetry_event(
        crate::provider_telemetry::ProviderTelemetryAggregateInput {
            configured_profile_id: &resolved.profile.id,
            configured_model: &resolved.profile.chat_model,
            calls: &workflow_telemetry_recorder.calls(),
            events: &all_events,
        },
    );
    live_sink(telemetry_event.clone());
    all_events.push(telemetry_event);

    let corpus_revision = binding.as_ref().map(|b| b.revision);
    let corpus_snapshot_revision = binding.as_ref().map(|b| b.snapshot_revision);
    if let Some(binding) = binding {
        unbind_linked_corpus(host, binding);
    }

    // A dry run has zero persistent side effects: it inspects the real
    // machinery without ever writing what that inspection produced. The
    // turn's (empty) synthetic reply is never appended to `session` and
    // `sessions.save` is never called — an existing session named with
    // `--session` is read for its real history but left byte-for-byte
    // unchanged on disk, and no session file is created when none existed.
    if !request.dry_run {
        // The event is the sole authority boundary.  In particular, do not
        // parse `TextDelta` back into JSON: transcript text is presentation,
        // while this envelope was validated against this turn's fresh ledger.
        let investigation_answer = investigation_answer_for_turn(
            &all_events,
            &session_id,
            &turn_id,
            request.corpus_id,
            session.linked_corpus_id.as_deref(),
            corpus_snapshot_revision,
        );
        for message in &history[before_len..] {
            session.messages.push(stored_from_chat(
                message,
                (message.role == Role::Assistant)
                    .then_some(investigation_answer)
                    .flatten(),
            ));
        }
        session.maybe_auto_title_from_first_user();
        session.touch();
        sessions.ensure()?;
        sessions.save(&session)?;
    }

    let final_text = all_events
        .iter()
        .filter_map(|event| match event {
            StreamEvent::TextDelta { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("");

    let multi_model_executed = executed_mode_from_events(&all_events);
    Ok(ChatWorkflowOutcome {
        session_id,
        turn_id,
        events: all_events,
        provider_profile_id: resolved.profile.id.clone(),
        chat_model: resolved.profile.chat_model.clone(),
        corpus_revision,
        corpus_snapshot_revision,
        history_messages: history.len(),
        final_text,
        multi_model_configured,
        multi_model_executed,
        multi_model_entry_degradation,
    })
}

/// Derive the executed multi-model mode from the event stream's summary line.
/// The seam and the entry-degradation both emit a `multi_model_stage` summary
/// with a status of `single` / `review` / `review_degraded`; absent one, the
/// turn was single-model.
fn executed_mode_from_events(events: &[StreamEvent]) -> cd_core::multi_model::ExecutedMode {
    use cd_core::multi_model::ExecutedMode;
    events
        .iter()
        .rev()
        .find_map(|event| match event {
            StreamEvent::MultiModelStage { stage, status, .. } if stage == "summary" => {
                match status.as_deref() {
                    Some("review") => Some(ExecutedMode::Review),
                    Some("review_degraded") => Some(ExecutedMode::ReviewDegraded),
                    _ => Some(ExecutedMode::Single),
                }
            }
            _ => None,
        })
        .unwrap_or(ExecutedMode::Single)
}

#[cfg(test)]
mod tests {
    use super::*;
    use cd_core::index::KeywordIndex;
    use cd_core::keychain_store::MemorySecretStore;
    use cd_core::providers::{ProviderConfig, ProviderKind, ProviderProfile};
    use cd_core::workspace::Workspace;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn summary_event(status: &str) -> StreamEvent {
        StreamEvent::MultiModelStage {
            stage: "summary".into(),
            phase: "summary".into(),
            status: Some(status.into()),
            detail: "d".into(),
            candidate_id: None,
        }
    }

    #[test]
    fn executed_mode_reads_the_last_summary_status_honestly() {
        use cd_core::multi_model::ExecutedMode;
        // No summary at all → single.
        assert_eq!(executed_mode_from_events(&[]), ExecutedMode::Single);
        // A review summary → review.
        assert_eq!(
            executed_mode_from_events(&[summary_event("review")]),
            ExecutedMode::Review
        );
        // A degraded summary → review_degraded.
        assert_eq!(
            executed_mode_from_events(&[summary_event("review_degraded")]),
            ExecutedMode::ReviewDegraded
        );
        // An entry-degradation single summary → single.
        assert_eq!(
            executed_mode_from_events(&[summary_event("single")]),
            ExecutedMode::Single
        );
        // The LAST summary wins (a per-stage line then the terminal summary).
        assert_eq!(
            executed_mode_from_events(&[
                StreamEvent::MultiModelStage {
                    stage: "reviewer".into(),
                    phase: "finished".into(),
                    status: Some("completed".into()),
                    detail: "d".into(),
                    candidate_id: None,
                },
                summary_event("review"),
            ]),
            ExecutedMode::Review
        );
    }

    /// Genuine SSE frames — a plain JSON body with a top-level `finish_reason`
    /// would be misparsed as an SSE finish-only frame by `complete_stream_cb`
    /// and silently drop the content (verified by reading the real parser).
    const SSE_BODY: &str =
        "data: {\"choices\":[{\"delta\":{\"content\":\"hello from the mock model\"}}]}\n\n\
         data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n\
         data: [DONE]\n\n";

    fn typed_answer_event(
        session_id: &str,
        turn_id: &str,
        corpus_id: &str,
        revision: cd_core::investigation_answer::LogSnapshotRevisionV1,
    ) -> StreamEvent {
        use cd_core::investigation_answer::{
            AnswerBindingV1, AnswerEnvelopeV1, InvestigationAnswerV1, SCHEMA_V1,
        };
        StreamEvent::InvestigationAnswer {
            envelope: AnswerEnvelopeV1 {
                binding: AnswerBindingV1 {
                    session_id: session_id.into(),
                    turn_id: turn_id.into(),
                    corpus_id: corpus_id.into(),
                    revision,
                    ledger_digest: "host-digest".into(),
                },
                evidence: Vec::new(),
                answer: InvestigationAnswerV1 {
                    schema: SCHEMA_V1.into(),
                    candidates: Vec::new(),
                    canonical_citations: Vec::new(),
                    root_cause_established: false,
                },
                semantic_attempts: 0,
            },
        }
    }

    /// The machine contract and the human contract are different projections
    /// of the same validated envelope, and only the typed one is authority.
    #[test]
    fn persistence_keeps_the_typed_envelope_exact_while_visible_text_is_markdown() {
        use cd_core::investigation_answer::{
            render_answer_markdown, CanonicalCitationV1, ClaimKind, ClaimStatus,
            InvestigationCandidateV1, InvestigationClaimV1, LogSnapshotRevisionV1,
        };

        let revision = LogSnapshotRevisionV1 {
            event_revision: 3,
            template_analysis_revision: 2,
            suppression_revision: 1,
        };
        let StreamEvent::InvestigationAnswer { mut envelope } =
            typed_answer_event("session", "turn", "corpus-a", revision)
        else {
            unreachable!("fixture builds a typed answer event")
        };
        envelope.answer.candidates.push(InvestigationCandidateV1 {
            candidate_id: "k1".into(),
            claims: vec![InvestigationClaimV1 {
                claim_id: "c1".into(),
                claim_kind: ClaimKind::Observation,
                text: "opaque host-validated statement".into(),
                candidate_id: "k1".into(),
                evidence_ids: vec!["ev1".into()],
                status: ClaimStatus::Supported,
            }],
        });
        envelope
            .answer
            .canonical_citations
            .push(CanonicalCitationV1 {
                evidence_id: "ev1".into(),
                candidate_id: "k1".into(),
                source_label: "one/two.jsonl".into(),
                locator: "seq=9".into(),
                corpus_id: "corpus-a".into(),
                revision,
                content: String::new(),
            });

        let markdown = render_answer_markdown(&envelope);
        let stored = stored_from_chat(
            &ChatMessage {
                role: Role::Assistant,
                content: markdown.clone(),
                tool_call_id: None,
                tool_calls: None,
            },
            Some(&envelope),
        );

        // Human projection: readable Markdown, never the authoritative JSON.
        assert!(stored.content.starts_with("# Investigation answer"));
        assert!(serde_json::from_str::<serde_json::Value>(stored.content.trim()).is_err());
        assert!(stored.content.contains("`ev1`"), "{}", stored.content);

        // Machine projection: byte-exact typed envelope under the reserved key.
        let meta = stored.meta.expect("assistant metadata");
        let persisted = meta
            .get(INVESTIGATION_ANSWER_META_KEY)
            .expect("typed envelope persisted");
        assert_eq!(
            persisted,
            &serde_json::to_value(&envelope).expect("typed value")
        );
        let round_trip: cd_core::investigation_answer::AnswerEnvelopeV1 =
            serde_json::from_value(persisted.clone()).expect("exact round trip");
        assert_eq!(round_trip, envelope);

        // Re-entry: the rendered text is never a path back to authority. A
        // stream carrying only the Markdown yields no investigation answer.
        let display_only = vec![StreamEvent::TextDelta { text: markdown }];
        assert!(investigation_answer_for_turn(
            &display_only,
            "session",
            "turn",
            Some("corpus-a"),
            Some("corpus-a"),
            Some(revision),
        )
        .is_none());
    }

    #[test]
    fn investigation_answer_persistence_requires_exact_linked_scope_and_revision() {
        let revision = cd_core::investigation_answer::LogSnapshotRevisionV1 {
            event_revision: 7,
            template_analysis_revision: 11,
            suppression_revision: 13,
        };
        let events = vec![typed_answer_event("session", "turn", "corpus-a", revision)];
        assert!(investigation_answer_for_turn(
            &events,
            "session",
            "turn",
            Some("corpus-a"),
            Some("corpus-a"),
            Some(revision),
        )
        .is_some());
        assert!(investigation_answer_for_turn(
            &events,
            "session",
            "next-turn",
            Some("corpus-a"),
            Some("corpus-a"),
            Some(revision),
        )
        .is_none());
        for changed in [
            cd_core::investigation_answer::LogSnapshotRevisionV1 {
                event_revision: revision.event_revision + 1,
                ..revision
            },
            cd_core::investigation_answer::LogSnapshotRevisionV1 {
                template_analysis_revision: revision.template_analysis_revision + 1,
                ..revision
            },
            cd_core::investigation_answer::LogSnapshotRevisionV1 {
                suppression_revision: revision.suppression_revision + 1,
                ..revision
            },
        ] {
            assert!(investigation_answer_for_turn(
                &events,
                "session",
                "turn",
                Some("corpus-a"),
                Some("corpus-a"),
                Some(changed),
            )
            .is_none());
        }
        for (request_corpus, session_corpus, snapshot_revision) in [
            (None, Some("corpus-a"), Some(revision)),
            (Some("corpus-a"), None, Some(revision)),
            (Some("corpus-a"), Some("corpus-b"), Some(revision)),
            (
                Some("corpus-a"),
                Some("corpus-a"),
                Some(cd_core::investigation_answer::LogSnapshotRevisionV1 {
                    template_analysis_revision: 12,
                    ..revision
                }),
            ),
            (Some("corpus-a"), Some("corpus-a"), None),
        ] {
            assert!(investigation_answer_for_turn(
                &events,
                "session",
                "turn",
                request_corpus,
                session_corpus,
                snapshot_revision,
            )
            .is_none());
        }
    }

    /// End to end, offline: a `ChatWorkflowRequest` with no linked corpus
    /// reaches a real `OpenAiCompatibleClient` HTTP call (via
    /// `run_ordinary_turn` -> `research_turn_with_cancel_and_context` ->
    /// `backend_for`) against a local `wiremock` server standing in for the
    /// provider, and the resulting text and session persistence are exactly
    /// what a thin CLI or Tauri adapter would need to render.
    #[tokio::test]
    async fn run_chat_workflow_completes_an_ordinary_turn_against_a_mock_provider() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "text/event-stream")
                    .set_body_raw(SSE_BODY, "text/event-stream"),
            )
            .mount(&server)
            .await;

        let workspace_dir = tempfile::tempdir().unwrap();
        let workspace = Workspace::new("t", vec![workspace_dir.path().to_path_buf()]);
        let index = KeywordIndex::build(&workspace).unwrap();
        let mut host = ToolHost::new(workspace, index, None);

        let secrets = MemorySecretStore::new();
        secrets.set("test/fake/api_key", "sk-test-key").unwrap();

        let mut profile = ProviderProfile::ollama_local();
        profile.kind = ProviderKind::OpenAiCompatible;
        profile.base_url = server.uri();
        profile.local_only = true;
        profile.api_key_ref = Some("test/fake/api_key".into());
        profile.chat_model = "test-model".into();
        profile.capabilities.tools = false;

        let cfg = AppConfig {
            providers: ProviderConfig {
                active_id: Some(profile.id.clone()),
                profiles: vec![profile],
            },
            ..AppConfig::default()
        };

        let sessions_dir = tempfile::tempdir().unwrap();
        let sessions = SessionStore::new(sessions_dir.path());

        let outcome = run_chat_workflow(
            &mut host,
            &secrets,
            &cfg,
            &sessions,
            workspace_dir.path(),
            None,
            "hi there",
            ChatWorkflowRequest {
                corpus_id: None,
                explicit_profile_id: None,
                chat_model_override: None,
                dry_run: false,
                trace_sink: None,
                user_selection: None,
                ..ChatWorkflowRequest::default()
            },
            None,
            None,
            |_tool, _target, _reason, _preview, _risk| PermissionDecision::Deny,
        )
        .await
        .expect("chat workflow should complete against the mocked provider");

        assert_eq!(outcome.final_text, "hello from the mock model");
        assert!(outcome
            .turn_id
            .starts_with(&format!("{}::", outcome.session_id)));
        assert_ne!(outcome.turn_id, outcome.session_id);
        assert_ne!(outcome.turn_id, format!("{}::cli", outcome.session_id));
        assert!(outcome.events.iter().any(
            |event| matches!(event, StreamEvent::TurnCompleted { reason } if reason == "stop")
        ));

        // A brand-new session has no system message yet, so the agent loop
        // injects one ahead of the user turn (`agent.rs`'s
        // `history.push(... Role::System ...)` for empty history) — that
        // becomes part of the persisted transcript alongside the user
        // message and the assistant reply.
        let saved = sessions
            .load(&outcome.session_id)
            .expect("session persisted");
        assert_eq!(
            saved.messages.len(),
            3,
            "system preamble + user turn + assistant reply"
        );
        assert_eq!(saved.messages[0].role, "system");
        assert_eq!(saved.messages[1].role, "user");
        assert_eq!(saved.messages[1].content, "hi there");
        assert_eq!(saved.messages[2].role, "assistant");
        assert_eq!(saved.messages[2].content, "hello from the mock model");
    }

    /// A CLI permission grant resumes the same user-visible chat turn through
    /// a second `run_turn` segment. Telemetry must remain one workflow-scoped
    /// DTO: both provider responses stay present, their metrics aggregate, and
    /// the new backend wrapper cannot reset round ids and cross-associate the
    /// final response with the call that requested permission.
    #[tokio::test]
    async fn permission_continuation_keeps_provider_telemetry_workflow_scoped() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use wiremock::{Request, Respond};

        struct PermissionThenAnswer {
            calls: AtomicUsize,
        }

        impl Respond for PermissionThenAnswer {
            fn respond(&self, _request: &Request) -> ResponseTemplate {
                let body = match self.calls.fetch_add(1, Ordering::SeqCst) {
                    0 => concat!(
                        "data: {\"id\":\"request-before-permission\",\"model\":\"response-model-a\",\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"save-1\",\"function\":{\"name\":\"save_memory\",\"arguments\":\"{\\\"title\\\":\\\"telemetry fixture\\\",\\\"body_markdown\\\":\\\"fixture\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":2,\"total_tokens\":12,\"cost\":0.1}}\n\n",
                        "data: [DONE]\n\n"
                    ),
                    1 => concat!(
                        "data: {\"id\":\"request-after-permission\",\"model\":\"response-model-b\",\"choices\":[{\"delta\":{\"content\":\"permission continuation complete\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":4,\"total_tokens\":7,\"cost\":0.2}}\n\n",
                        "data: [DONE]\n\n"
                    ),
                    _ => panic!("workflow must make exactly two provider calls"),
                };
                ResponseTemplate::new(200)
                    .insert_header("content-type", "text/event-stream")
                    .set_body_raw(body, "text/event-stream")
            }
        }

        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(PermissionThenAnswer {
                calls: AtomicUsize::new(0),
            })
            .mount(&server)
            .await;

        let workspace_dir = tempfile::tempdir().unwrap();
        let workspace = Workspace::new("permission-telemetry", vec![workspace_dir.path().into()]);
        let index = KeywordIndex::build(&workspace).unwrap();
        let mut host = ToolHost::new(workspace, index, None);
        let secrets = MemorySecretStore::new();
        let mut profile = ProviderProfile::ollama_local();
        profile.kind = ProviderKind::OpenAiCompatible;
        profile.base_url = server.uri();
        profile.local_only = true;
        profile.chat_model = "configured-model".into();
        profile.capabilities.tools = true;
        let cfg = AppConfig {
            providers: ProviderConfig {
                active_id: Some(profile.id.clone()),
                profiles: vec![profile],
            },
            ..AppConfig::default()
        };
        let sessions_dir = tempfile::tempdir().unwrap();
        let sessions = SessionStore::new(sessions_dir.path());
        let trace = Arc::new(RecordingTurnTrace::new());
        let trace_sink: Arc<dyn TurnTraceSink> = trace.clone();

        let outcome = run_chat_workflow(
            &mut host,
            &secrets,
            &cfg,
            &sessions,
            workspace_dir.path(),
            None,
            "save the telemetry fixture",
            ChatWorkflowRequest {
                corpus_id: None,
                explicit_profile_id: None,
                chat_model_override: None,
                dry_run: false,
                trace_sink: Some(trace_sink),
                user_selection: None,
                ..ChatWorkflowRequest::default()
            },
            None,
            None,
            |_tool, _target, _reason, _preview, _risk| PermissionDecision::AllowOnce,
        )
        .await
        .expect("permission continuation workflow should complete");

        let telemetry_events: Vec<_> = outcome
            .events
            .iter()
            .filter_map(|event| match event {
                StreamEvent::ProviderTelemetry { telemetry } => Some(telemetry.as_ref()),
                _ => None,
            })
            .collect();
        assert_eq!(telemetry_events.len(), 1, "one DTO for the CLI workflow");
        let telemetry = telemetry_events[0];
        assert_eq!(telemetry.provider_round_count, 2);
        assert_eq!(telemetry.prompt_tokens, Some(13));
        assert_eq!(telemetry.completion_tokens, Some(6));
        assert_eq!(telemetry.total_tokens, Some(19));
        assert!((telemetry.cost.expect("both rounds report cost") - 0.3).abs() < 1e-9);
        assert_eq!(
            telemetry.response_model.as_deref(),
            Some("response-model-b")
        );
        assert_eq!(
            telemetry.provider_request_id.as_deref(),
            Some("request-after-permission")
        );
        assert_eq!(telemetry.rounds.len(), 2);
        assert_eq!(telemetry.rounds[0].round, 0);
        assert_eq!(telemetry.rounds[1].round, 1);
        assert_eq!(
            telemetry.rounds[0].transport.provider_request_id.as_deref(),
            Some("request-before-permission")
        );
        assert_eq!(
            telemetry.rounds[1].transport.provider_request_id.as_deref(),
            Some("request-after-permission")
        );

        let calls = trace.calls();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].seq, 0);
        assert_eq!(calls[1].seq, 1);
        for call in &calls {
            let round = telemetry
                .rounds
                .iter()
                .find(|round| round.round == call.seq as u32)
                .expect("unique trace sequence must resolve to one telemetry round");
            assert_eq!(round.transport, call.transport);
        }
        assert!(outcome.events.iter().any(
            |event| matches!(event, StreamEvent::PermissionRequired { tool_name, .. } if tool_name == "save_memory")
        ));
    }

    #[tokio::test]
    async fn explicit_user_selection_reaches_provider_only_when_supplied() {
        const TOKEN: &str = "WORKFLOW_USER_SELECTION_8ZP4_ONLY";
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "text/event-stream")
                    .set_body_raw(SSE_BODY, "text/event-stream"),
            )
            .mount(&server)
            .await;

        let workspace_dir = tempfile::tempdir().unwrap();
        let workspace = Workspace::new("t", vec![workspace_dir.path().to_path_buf()]);
        let index = KeywordIndex::build(&workspace).unwrap();
        let mut host = ToolHost::new(workspace, index, None);
        let secrets = MemorySecretStore::new();
        let mut profile = ProviderProfile::ollama_local();
        profile.kind = ProviderKind::OpenAiCompatible;
        profile.base_url = server.uri();
        profile.local_only = true;
        profile.chat_model = "test-model".into();
        profile.capabilities.tools = false;
        let cfg = AppConfig {
            providers: ProviderConfig {
                active_id: Some(profile.id.clone()),
                profiles: vec![profile],
            },
            ..AppConfig::default()
        };
        let sessions_dir = tempfile::tempdir().unwrap();
        let sessions = SessionStore::new(sessions_dir.path());

        for selection in [Some(TOKEN), None] {
            run_chat_workflow(
                &mut host,
                &secrets,
                &cfg,
                &sessions,
                workspace_dir.path(),
                None,
                "same neutral question",
                ChatWorkflowRequest {
                    corpus_id: None,
                    explicit_profile_id: None,
                    chat_model_override: None,
                    dry_run: false,
                    trace_sink: None,
                    user_selection: selection,
                    ..ChatWorkflowRequest::default()
                },
                None,
                None,
                |_tool, _target, _reason, _preview, _risk| PermissionDecision::Deny,
            )
            .await
            .expect("production workflow turn");
        }

        let requests = server.received_requests().await.expect("requests");
        assert_eq!(requests.len(), 2);
        let bodies: Vec<String> = requests
            .iter()
            .map(|request| String::from_utf8_lossy(&request.body).into_owned())
            .collect();
        assert!(
            bodies[0].contains(TOKEN),
            "explicit selection missing: {}",
            bodies[0]
        );
        assert_eq!(
            bodies[0].matches(TOKEN).count(),
            1,
            "selection must have one model-facing injection source: {}",
            bodies[0]
        );
        assert!(
            bodies[0].contains("<user_selected_context>"),
            "selection must be visibly delimited as untrusted client evidence"
        );
        let selected_body: Value = serde_json::from_str(&bodies[0]).expect("provider JSON");
        let messages = selected_body["messages"].as_array().expect("messages");
        let selection_index = messages
            .iter()
            .position(|message| message.to_string().contains(TOKEN))
            .expect("selection message");
        assert!(
            selection_index > 0,
            "untrusted selection must not precede the primary system instruction: {messages:?}"
        );
        assert!(
            !bodies[1].contains(TOKEN) && !bodies[1].contains("<user_selected_context>"),
            "ordinary turn fabricated selection context: {}",
            bodies[1]
        );

        let resolved = resolve_turn_inputs(&secrets, &cfg, None, None).expect("resolved");
        let mut linked_history = Vec::new();
        let linked_error = run_turn(
            &mut host,
            &resolved,
            "linked question",
            &mut linked_history,
            "linked-selection-policy",
            TurnExecutionOptions {
                context: Some(
                    LogExplorerTurnContext::for_main_chat("synthetic-corpus")
                        .expect("linked context"),
                ),
                user_selection: Some(TOKEN),
                ..TurnExecutionOptions::default()
            },
            None,
            None,
        )
        .await
        .expect_err("linked selection must fail closed");
        assert!(linked_error.to_string().contains("linked-log turns"));
        assert_eq!(
            server.received_requests().await.expect("requests").len(),
            2,
            "linked selection policy must fail before provider I/O"
        );
    }

    /// The same shared `ChatWorkflow` path, this time proving the
    /// content+tool_calls-in-one-delta and multi-byte-UTF-8 protocol fixes
    /// (`cd_core::chat`) hold all the way through provider resolution, the
    /// real agent turn, and session persistence — not just at the
    /// `OpenAiCompatibleClient` unit level. Narration text and a tool call
    /// arrive combined in a single SSE event, and the narration itself
    /// contains non-ASCII text a naive per-chunk UTF-8 decode would have
    /// corrupted at a chunk boundary in the streaming path this exercises.
    #[tokio::test]
    async fn run_chat_workflow_preserves_combined_content_and_tool_call_with_non_ascii_text() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use wiremock::{Request, Respond};

        struct TwoRoundProvider {
            call: std::sync::Arc<AtomicUsize>,
        }
        impl Respond for TwoRoundProvider {
            fn respond(&self, _request: &Request) -> ResponseTemplate {
                let body = match self.call.fetch_add(1, Ordering::SeqCst) {
                    0 => "data: {\"choices\":[{\"delta\":{\"content\":\"revisando los registros \u{1f4c4}\",\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"search_kb\",\"arguments\":\"{\\\"query\\\":\\\"timeout\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n\
                         data: [DONE]\n\n"
                        .to_string(),
                    _ => SSE_BODY.to_string(),
                };
                ResponseTemplate::new(200)
                    .insert_header("content-type", "text/event-stream")
                    .set_body_raw(body, "text/event-stream")
            }
        }

        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(TwoRoundProvider {
                call: std::sync::Arc::new(AtomicUsize::new(0)),
            })
            .mount(&server)
            .await;

        let workspace_dir = tempfile::tempdir().unwrap();
        let workspace = Workspace::new("t", vec![workspace_dir.path().to_path_buf()]);
        let index = KeywordIndex::build(&workspace).unwrap();
        let mut host = ToolHost::new(workspace, index, None);

        let secrets = MemorySecretStore::new();
        let mut profile = ProviderProfile::ollama_local();
        profile.kind = ProviderKind::OpenAiCompatible;
        profile.base_url = server.uri();
        profile.local_only = true;
        profile.chat_model = "test-model".into();
        profile.capabilities.tools = true;

        let cfg = AppConfig {
            providers: ProviderConfig {
                active_id: Some(profile.id.clone()),
                profiles: vec![profile],
            },
            ..AppConfig::default()
        };

        let sessions_dir = tempfile::tempdir().unwrap();
        let sessions = SessionStore::new(sessions_dir.path());

        let outcome = run_chat_workflow(
            &mut host,
            &secrets,
            &cfg,
            &sessions,
            workspace_dir.path(),
            None,
            "what timed out?",
            ChatWorkflowRequest {
                corpus_id: None,
                explicit_profile_id: None,
                chat_model_override: None,
                dry_run: false,
                trace_sink: None,
                user_selection: None,
                ..ChatWorkflowRequest::default()
            },
            None,
            None,
            |_tool, _target, _reason, _preview, _risk| PermissionDecision::AllowOnce,
        )
        .await
        .expect("chat workflow should complete a tool round then a final answer");

        let saved = sessions
            .load(&outcome.session_id)
            .expect("session persisted");
        let assistant_first_round = saved
            .messages
            .iter()
            .find(|m| m.content.contains("revisando los registros"))
            .expect("the narration text combined with the tool call must survive intact");
        assert_eq!(
            assistant_first_round.content, "revisando los registros \u{1f4c4}",
            "non-ASCII narration text must round-trip byte-for-byte through the streaming path"
        );
    }

    /// A dry run against an *existing* session must leave that session's
    /// saved file byte-for-byte untouched — not merely "no new session
    /// created," but "the one the caller pointed at is not mutated either."
    #[tokio::test]
    async fn dry_run_never_persists_and_never_touches_an_existing_session() {
        // Deliberately no Mock mounted for /v1/chat/completions: if the dry
        // run were to make a real request, `run_ordinary_turn` would either
        // get wiremock's default 404 (surfacing as a provider error) or, if
        // this profile were misconfigured to skip that path, silently
        // succeed with unexpected content — either way the assertions below
        // would catch it.
        let server = MockServer::start().await;

        let workspace_dir = tempfile::tempdir().unwrap();
        let workspace = Workspace::new("t", vec![workspace_dir.path().to_path_buf()]);
        let index = KeywordIndex::build(&workspace).unwrap();
        let mut host = ToolHost::new(workspace, index, None);

        let secrets = MemorySecretStore::new();
        secrets.set("test/fake/api_key", "sk-test-key").unwrap();

        let mut profile = ProviderProfile::ollama_local();
        profile.kind = ProviderKind::OpenAiCompatible;
        profile.base_url = server.uri();
        profile.local_only = true;
        profile.api_key_ref = Some("test/fake/api_key".into());
        profile.chat_model = "test-model".into();
        profile.capabilities.tools = false;

        let cfg = AppConfig {
            providers: ProviderConfig {
                active_id: Some(profile.id.clone()),
                profiles: vec![profile],
            },
            ..AppConfig::default()
        };

        let sessions_dir = tempfile::tempdir().unwrap();
        let sessions = SessionStore::new(sessions_dir.path());

        // Seed a real, pre-existing session the dry run will point at.
        let mut existing = cd_core::sessions::Session::new("existing".to_string());
        existing.messages.push(cd_core::sessions::StoredMessage {
            id: "m1".into(),
            role: "user".into(),
            content: "previously said this".into(),
            tools: None,
            citations: None,
            trail: None,
            meta: None,
        });
        sessions.ensure().unwrap();
        sessions.save(&existing).unwrap();
        let before = std::fs::read(sessions_dir.path().join(format!("{}.json", existing.id)))
            .expect("session file exists before the dry run");

        let outcome = run_chat_workflow(
            &mut host,
            &secrets,
            &cfg,
            &sessions,
            workspace_dir.path(),
            Some(&existing.id),
            "dry run question",
            ChatWorkflowRequest {
                corpus_id: None,
                explicit_profile_id: None,
                chat_model_override: None,
                dry_run: true,
                trace_sink: None,
                user_selection: None,
                ..ChatWorkflowRequest::default()
            },
            None,
            None,
            |_tool, _target, _reason, _preview, _risk| PermissionDecision::Deny,
        )
        .await
        .expect("dry run must complete without a real provider request");

        assert_eq!(outcome.session_id, existing.id);
        assert!(outcome
            .turn_id
            .starts_with(&format!("{}::", outcome.session_id)));
        assert_ne!(outcome.turn_id, outcome.session_id);
        assert_eq!(
            outcome.final_text, "",
            "the dry-run backend never produces real content"
        );
        assert!(outcome.events.iter().any(
            |event| matches!(event, StreamEvent::TurnCompleted { reason } if reason == "stop")
        ));
        assert_eq!(
            outcome.provider_profile_id,
            cfg.providers.active_id.clone().unwrap()
        );
        assert_eq!(outcome.chat_model, "test-model");

        let after = std::fs::read(sessions_dir.path().join(format!("{}.json", existing.id)))
            .expect("session file still exists after the dry run");
        assert_eq!(
            before, after,
            "a dry run must not mutate the existing session file at all"
        );

        let reloaded = sessions.load(&existing.id).unwrap();
        assert_eq!(
            reloaded.messages.len(),
            1,
            "the dry run's own (empty) turn must never be appended"
        );
    }
}
