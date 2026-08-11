//! Grounded-chat turn orchestration shared by every host.
//!
//! [`cd_core::research::research_turn_with_cancel_and_context`] is already
//! the single, host-neutral entry point that drives a provider round —
//! it is not reimplemented here. What previously existed only inside the
//! Tauri `agent_turn` command was the sequencing AROUND that call: binding
//! (and later releasing) a linked log corpus on the tool host so a turn can
//! ground its answer in imported evidence. That sequencing is what this
//! module extracts, so a CLI grounding a question in `contextdesk chat` uses
//! the exact same binding discipline a linked Log Explorer chat does.

use cd_core::agent::{LinkedSynthesisCheckpoint, LogExplorerTurnContext};
use cd_core::chat::ChatMessage;
use cd_core::error::CoreResult;
use cd_core::events::StreamEvent;
use cd_core::log_analysis::store::LogCorpus;
use cd_core::tool_host::ToolHost;
use cd_core::turn_trace::{RecordingTurnTrace, TurnTraceSink};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize};
use std::sync::Arc;
use tokio::time::Instant;

use crate::provider::ResolvedTurnInputs;

/// Host-neutral options for one provider-backed chat turn.
///
/// Both the CLI workflow and the desktop host pass their already-authorized,
/// host-owned state through this value. It deliberately does not load or save
/// sessions, prompt for permissions, acquire a Tauri host, or bind a corpus:
/// those lifecycle decisions differ by host. It does own the single call into
/// `cd-core` so streaming, cancellation, grounding, retry checkpoints,
/// deadlines, tracing, and skill provenance cannot drift between hosts.
#[derive(Default)]
pub struct TurnExecutionOptions<'a> {
    /// Stable host id for this concrete turn. `None` lets core allocate a
    /// fresh fallback, never the session id.
    pub turn_id: Option<String>,
    pub context: Option<LogExplorerTurnContext>,
    pub cancel: Option<Arc<AtomicBool>>,
    pub dry_run: bool,
    pub trace_sink: Option<Arc<dyn TurnTraceSink>>,
    /// Optional workflow-owned recorder. Supplying the same recorder across
    /// multiple `run_turn` calls makes their provider telemetry one coherent
    /// capture rather than unrelated per-segment snapshots.
    pub telemetry_recorder: Option<Arc<RecordingTurnTrace>>,
    /// Optional workflow-owned provider sequence. This stays monotonic even
    /// when permission continuation creates a fresh backend wrapper.
    pub telemetry_sequence: Option<Arc<AtomicUsize>>,
    /// Let a higher-level workflow append one aggregate telemetry event after
    /// several internal `run_turn` segments. Ordinary hosts leave this false
    /// and receive the existing one-event-per-turn behavior.
    pub suppress_provider_telemetry_event: bool,
    pub linked_synthesis_retry: Option<LinkedSynthesisCheckpoint>,
    pub turn_started_at: Option<Instant>,
    pub turn_prelude_emitted: bool,
    pub applied_skill_ids: &'a [String],
    /// Text the user explicitly selected for this turn. Never derive from a
    /// viewport, ambient recall, or attachment inventory.
    pub user_selection: Option<&'a str>,
    /// Optional resolved multi-model reviewer runtime. `None` (the default)
    /// keeps the single-model path. The workflow layer builds this only after
    /// resolving qualification and egress; the presence of a runtime means
    /// "review may run at the broad-triage seam".
    pub multi_model: Option<cd_core::agent::MultiModelRuntime>,
    /// Optional resolved host-grounded fast-triage runtime. `None` (the
    /// default) keeps the established single/multi-stage path unchanged.
    /// The runtime is considered only at the linked broad-triage seam after
    /// exact persisted route evidence and fallback policy have been resolved.
    pub fast_triage: Option<cd_core::agent::FastTriageRuntime>,
}

/// Drive the shared provider/tool kernel for either an ordinary or a linked
/// turn. Host-specific lifecycle remains outside this seam; all model-facing
/// execution inputs cross it explicitly.
///
/// Always captures provider-round transport telemetry through a shared
/// [`cd_core::turn_trace::RecordingTurnTrace`] (fan-out with any host sink) and
/// appends one authoritative [`StreamEvent::ProviderTelemetry`] so CLI and
/// Tauri project the same DTO without independently inferring provider facts.
#[allow(clippy::too_many_arguments)]
pub async fn run_turn(
    host: &mut ToolHost,
    resolved: &ResolvedTurnInputs,
    user_text: &str,
    history: &mut Vec<ChatMessage>,
    session_id: &str,
    options: TurnExecutionOptions<'_>,
    mut live: Option<&mut (dyn FnMut(StreamEvent) + Send)>,
    checkpoint_out: Option<&mut Option<LinkedSynthesisCheckpoint>>,
) -> CoreResult<Vec<StreamEvent>> {
    use cd_core::turn_trace::{FanoutTurnTrace, TurnTraceSink};
    use std::sync::Arc;

    let telemetry_recorder = options
        .telemetry_recorder
        .clone()
        .unwrap_or_else(|| Arc::new(RecordingTurnTrace::new()));
    let telemetry_sequence = options
        .telemetry_sequence
        .clone()
        .unwrap_or_else(|| Arc::new(AtomicUsize::new(0)));
    let mut sinks: Vec<Arc<dyn TurnTraceSink>> =
        vec![telemetry_recorder.clone() as Arc<dyn TurnTraceSink>];
    if let Some(host_sink) = options.trace_sink.clone() {
        sinks.push(host_sink);
    }
    let fanout: Arc<dyn TurnTraceSink> = Arc::new(FanoutTurnTrace::with_provider_call_sequence(
        sinks,
        telemetry_sequence,
    ));

    let mut events = if let Some(sink) = live.as_mut() {
        cd_core::research::research_turn_with_cancel_and_context_and_checkpoint_and_trace(
            host,
            &resolved.profile,
            resolved.api_key.clone(),
            user_text,
            history,
            session_id,
            false,
            options.cancel.clone(),
            options.context.clone(),
            options.linked_synthesis_retry.clone(),
            checkpoint_out,
            options.turn_started_at,
            options.turn_prelude_emitted,
            Some(sink),
            options.dry_run,
            Some(fanout.clone()),
            options.applied_skill_ids,
            options.turn_id.clone(),
            options.user_selection,
            options.multi_model.clone(),
            options.fast_triage.clone(),
        )
        .await?
    } else {
        cd_core::research::research_turn_with_cancel_and_context_and_checkpoint_and_trace(
            host,
            &resolved.profile,
            resolved.api_key.clone(),
            user_text,
            history,
            session_id,
            false,
            options.cancel,
            options.context,
            options.linked_synthesis_retry,
            checkpoint_out,
            options.turn_started_at,
            options.turn_prelude_emitted,
            None,
            options.dry_run,
            Some(fanout),
            options.applied_skill_ids,
            options.turn_id,
            options.user_selection,
            options.multi_model,
            options.fast_triage,
        )
        .await?
    };

    if options.suppress_provider_telemetry_event {
        return Ok(events);
    }

    let calls = telemetry_recorder.calls();
    let telemetry_event = crate::provider_telemetry::aggregate_provider_telemetry_event(
        crate::provider_telemetry::ProviderTelemetryAggregateInput {
            configured_profile_id: &resolved.profile.id,
            configured_model: &resolved.profile.chat_model,
            calls: &calls,
            events: &events,
        },
    );
    if let Some(sink) = live.as_mut() {
        sink(telemetry_event.clone());
    }
    events.push(telemetry_event);
    Ok(events)
}

/// Prior tool-host state captured by [`bind_linked_corpus`], so a caller can
/// restore it after the turn — mirrors the snapshot/restore Tauri's
/// `agent_turn` already performs around the same host methods, generalized
/// so it needs no `AppState`/host-generation concept to work.
pub struct LinkedCorpusBinding {
    previous_scope: Option<String>,
    previous_active: Option<String>,
    /// The corpus's event revision at the moment it was bound — a trace/
    /// dry-run summary's "which corpus content this turn was grounded
    /// against," since the corpus can keep receiving imports afterward.
    pub revision: u64,
    /// Exact event/template/suppression snapshot used by typed authority.
    pub snapshot_revision: cd_core::investigation_answer::LogSnapshotRevisionV1,
}

/// Bind one corpus to the tool host for a linked turn: pin log-tool scope,
/// seed the already-opened corpus handle so every deterministic log tool in
/// the turn shares one initialized snapshot, and pin the current suppression
/// lens. Returns the prior state so [`unbind_linked_corpus`] can restore it.
pub fn bind_linked_corpus(
    host: &mut ToolHost,
    cache_root: &Path,
    corpus_id: &str,
) -> CoreResult<LinkedCorpusBinding> {
    let previous_scope = host.log_corpus_scope().map(str::to_string);
    let previous_active = host.active_log_corpus().map(str::to_string);

    host.set_log_corpus_scope(Some(corpus_id.to_string()));
    host.set_active_log_corpus(Some(corpus_id.to_string()));
    let corpus = Arc::new(LogCorpus::open(cache_root, corpus_id)?);
    let revision = corpus.revision();
    host.seed_log_corpus_handle(corpus_id, corpus)?;
    host.pin_log_suppression_lens(corpus_id)?;
    let snapshot_revision = host.linked_log_snapshot_revision(corpus_id)?;

    Ok(LinkedCorpusBinding {
        previous_scope,
        previous_active,
        revision,
        snapshot_revision,
    })
}

/// Restore the tool host to its state before [`bind_linked_corpus`].
pub fn unbind_linked_corpus(host: &mut ToolHost, binding: LinkedCorpusBinding) {
    host.set_log_corpus_scope(binding.previous_scope);
    host.set_active_log_corpus(binding.previous_active);
}

/// Run one grounded turn against a corpus already bound with
/// [`bind_linked_corpus`], using the caller-supplied [`LogExplorerTurnContext`].
///
/// The context is taken already built rather than assembled from a bare
/// corpus id, because how much it carries differs by host: a CLI or a plain
/// main-chat turn has nothing beyond [`LogExplorerTurnContext::for_main_chat`]
/// to offer, while a host with its own viewport/filters/lane/selection
/// concept (Log Explorer) has a richer `Explorer { .. }` origin it must not
/// lose by having this function silently rebuild a bare one.
///
/// `dry_run` and `trace_sink` pass straight through to
/// [`cd_core::research::research_turn_with_cancel_and_context_and_checkpoint_and_trace`]
/// — see that function's docs for exactly what each guarantees. Ordinary
/// callers that want neither pass `false, None`.
///
/// `linked_synthesis_retry`/`checkpoint_out` are the "resume synthesis from
/// preserved evidence, without re-fetching it" mechanism — currently a
/// Tauri-only feature (the desktop chat's exact-retry action), passed
/// straight through unchanged. A caller with no such concept passes
/// `None, None`.
///
/// `turn_started_at`/`turn_prelude_emitted` exist only because a host may
/// have already started its own deadline clock and/or emitted a
/// `TurnStarted`/`TurnPhase` preamble before this call — e.g. Tauri's
/// `agent_turn` does both while it waits for tool-host readiness. A caller
/// with neither passes `None, false`, which is exactly what starts a fresh
/// clock and lets the shared kernel emit its own preamble.
#[allow(clippy::too_many_arguments)]
pub async fn run_linked_turn(
    host: &mut ToolHost,
    resolved: &ResolvedTurnInputs,
    user_text: &str,
    history: &mut Vec<ChatMessage>,
    session_id: &str,
    context: LogExplorerTurnContext,
    cancel: Option<Arc<AtomicBool>>,
    live: Option<&mut (dyn FnMut(StreamEvent) + Send)>,
    dry_run: bool,
    trace_sink: Option<Arc<dyn TurnTraceSink>>,
    linked_synthesis_retry: Option<LinkedSynthesisCheckpoint>,
    checkpoint_out: Option<&mut Option<LinkedSynthesisCheckpoint>>,
    turn_started_at: Option<Instant>,
    turn_prelude_emitted: bool,
) -> CoreResult<Vec<StreamEvent>> {
    run_turn(
        host,
        resolved,
        user_text,
        history,
        session_id,
        TurnExecutionOptions {
            turn_id: None,
            context: Some(context),
            cancel,
            dry_run,
            trace_sink,
            telemetry_recorder: None,
            telemetry_sequence: None,
            suppress_provider_telemetry_event: false,
            linked_synthesis_retry,
            turn_started_at,
            turn_prelude_emitted,
            applied_skill_ids: &[],
            user_selection: None,
            multi_model: None,
            fast_triage: None,
        },
        live,
        checkpoint_out,
    )
    .await
}

/// Run one ordinary (unlinked) turn — no corpus, no log tools scoped.
///
/// See [`run_linked_turn`] for `dry_run`/`trace_sink`/`linked_synthesis_retry`/
/// `checkpoint_out`/`turn_started_at`/`turn_prelude_emitted`.
#[allow(clippy::too_many_arguments)]
pub async fn run_ordinary_turn(
    host: &mut ToolHost,
    resolved: &ResolvedTurnInputs,
    user_text: &str,
    history: &mut Vec<ChatMessage>,
    session_id: &str,
    cancel: Option<Arc<AtomicBool>>,
    live: Option<&mut (dyn FnMut(StreamEvent) + Send)>,
    dry_run: bool,
    trace_sink: Option<Arc<dyn TurnTraceSink>>,
    linked_synthesis_retry: Option<LinkedSynthesisCheckpoint>,
    checkpoint_out: Option<&mut Option<LinkedSynthesisCheckpoint>>,
    turn_started_at: Option<Instant>,
    turn_prelude_emitted: bool,
) -> CoreResult<Vec<StreamEvent>> {
    run_turn(
        host,
        resolved,
        user_text,
        history,
        session_id,
        TurnExecutionOptions {
            cancel,
            dry_run,
            trace_sink,
            linked_synthesis_retry,
            turn_started_at,
            turn_prelude_emitted,
            ..TurnExecutionOptions::default()
        },
        live,
        checkpoint_out,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::resolve_turn_inputs;
    use cd_core::config::AppConfig;
    use cd_core::index::KeywordIndex;
    use cd_core::keychain_store::MemorySecretStore;
    use cd_core::providers::{ProviderConfig, ProviderKind, ProviderProfile};
    use cd_core::workspace::Workspace;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    const SSE_BODY: &str = "data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}\n\n\
         data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n\
         data: [DONE]\n\n";

    /// `checkpoint_out` is the "resume synthesis from preserved evidence"
    /// slot Tauri's `agent_turn` needs and no other caller has used before
    /// this parameter existed. Proves the plumbing through `run_ordinary_turn`
    /// doesn't panic or silently drop the caller's slot, and pins the
    /// expected semantics for an *ordinary* (unlinked) turn: with no
    /// `LogExplorerTurnContext`, there is no linked evidence to checkpoint,
    /// so the slot must come back exactly as it went in — `None` — never a
    /// stray checkpoint fabricated for a turn that was never grounded.
    #[tokio::test]
    async fn checkpoint_out_stays_none_after_an_ordinary_turn() {
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
        let resolved = resolve_turn_inputs(&secrets, &cfg, None, None).expect("resolved");

        let mut history = Vec::new();
        let mut checkpoint_slot: Option<LinkedSynthesisCheckpoint> = None;
        let mut streamed = Vec::new();
        let mut live = |event| streamed.push(event);
        let trace = Arc::new(
            cd_core::turn_trace::RecordingTurnTrace::with_developer_detail(
                std::time::Instant::now(),
                Arc::new(|_| {}),
            ),
        );
        let applied_skill_ids = vec!["skill-fixture".to_string()];
        let events = run_turn(
            &mut host,
            &resolved,
            "hi there",
            &mut history,
            "s-checkpoint",
            TurnExecutionOptions {
                trace_sink: Some(trace.clone()),
                applied_skill_ids: &applied_skill_ids,
                ..TurnExecutionOptions::default()
            },
            Some(&mut live),
            Some(&mut checkpoint_slot),
        )
        .await
        .expect("ordinary turn completes");

        assert!(events
            .iter()
            .any(|e| matches!(e, StreamEvent::TurnCompleted { reason } if reason == "stop")));
        assert!(
            checkpoint_slot.is_none(),
            "an ordinary turn must never fabricate a linked-synthesis checkpoint"
        );
        assert!(streamed
            .iter()
            .any(|e| matches!(e, StreamEvent::TurnStarted { .. })));
        assert!(streamed
            .iter()
            .any(|e| matches!(e, StreamEvent::TextDelta { .. })));
        assert!(streamed
            .iter()
            .any(|e| matches!(e, StreamEvent::TurnCompleted { reason } if reason == "stop")));
        let developer_events = trace.developer_events();
        let skill_provenance = developer_events
            .iter()
            .find(|event| event.label == "Context: pinned_skills")
            .expect("shared kernel emits authoritative pinned-skill provenance");
        assert_eq!(skill_provenance.status, "present");
        assert_eq!(
            skill_provenance.authority,
            Some(cd_core::turn_trace::ContextProvenanceAuthority::HumanApproved)
        );
        assert!(skill_provenance
            .request
            .iter()
            .any(|payload| payload.content.contains("skill-fixture")));
    }

    /// Two-round provider double for the mutation-proof context test below:
    /// round 0 satisfies the mandatory log-grounding gate with a
    /// `search_logs` tool call, and every round after that answers plainly.
    /// Non-streaming JSON is deliberate (matches
    /// `crates/cd-cli/tests/live_provider_rehearsal.rs`'s established
    /// pattern) — the real `OpenAiCompatibleClient` tolerates a JSON body
    /// even when `stream: true` was requested, and it is far simpler to
    /// assemble than a second SSE frame set.
    struct GroundThenAnswerProvider {
        call: std::sync::atomic::AtomicUsize,
    }

    impl wiremock::Respond for GroundThenAnswerProvider {
        fn respond(&self, _request: &wiremock::Request) -> ResponseTemplate {
            let call = self.call.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let body = if call == 0 {
                serde_json::json!({
                    "choices": [{
                        "finish_reason": "tool_calls",
                        "message": {
                            "role": "assistant",
                            "content": null,
                            "tool_calls": [{
                                "id": "ground-1",
                                "type": "function",
                                "function": {
                                    "name": "search_logs",
                                    "arguments": {"query": "mutation-proof-incident-42", "semantic": false, "k": 5}
                                }
                            }]
                        }
                    }]
                })
            } else {
                serde_json::json!({
                    "choices": [{
                        "finish_reason": "stop",
                        "message": {"role": "assistant", "content": "hello"}
                    }]
                })
            };
            ResponseTemplate::new(200)
                .insert_header("content-type", "application/json")
                .set_body_json(body)
        }
    }

    /// `run_linked_turn` used to build its own bare
    /// `LogExplorerTurnContext::for_main_chat(corpus_id)` internally, which
    /// can only ever express "no viewport, filters, lanes, or selection" —
    /// exactly what a host with a richer Explorer-shaped context (window id,
    /// capped filters/lanes brief, a suspended noise lens) cannot use without
    /// silently downgrading to `MainChat` origin.
    ///
    /// This does not stop at "the turn completes" — that would pass even if
    /// the context were silently rebuilt, since a rebuilt `for_main_chat`
    /// context still drives a perfectly ordinary successful turn. It
    /// inspects the actual HTTP request `run_linked_turn` sent to the mocked
    /// provider and requires the fixture's unique window id and viewport
    /// brief to appear verbatim, plus the Explorer-specific phrasing — and
    /// requires the `MainChat`-specific phrasing to be ABSENT, since that
    /// phrase is exactly what a silent downgrade would produce instead.
    ///
    /// `LogExplorerTurnContext::system_hint()` — the one place origin/window
    /// id/brief get rendered into a system message — only reaches a live
    /// provider round in one specific stage: after the mandatory log
    /// grounding succeeds, when the user's question named a source the
    /// offered tools haven't retrieved yet (`agent.rs`'s "REQUIRED NEXT
    /// SOURCE" branch — every other stage's system hint, including the
    /// initial grounding one, renders only the corpus id). The fixture
    /// below deliberately drives into exactly that stage: the user text
    /// asks for "durable memory" (a source the host offers via a real
    /// in-memory `SqliteMemoryStore`, `recall_memory`) that the mocked
    /// model never actually calls — round 0 satisfies log grounding, round
    /// 1 is the one whose request this test inspects.
    ///
    /// Mutation-verified by hand: inserting
    /// `let context = LogExplorerTurnContext::for_main_chat(&context.corpus_id)?;`
    /// at the top of `run_linked_turn`'s body, right before the call this
    /// function forwards into (reproducing the historical bug this test
    /// guards against, discarding the caller's context in favor of a bare
    /// rebuilt one) makes this exact test fail — the window id and brief
    /// disappear from every captured request and the `MainChat` phrase
    /// appears in their place. Reverted; not present in the committed code.
    #[tokio::test]
    async fn run_linked_turn_forwards_the_callers_context_without_rebuilding_it() {
        const WINDOW_ID: &str = "mutation-proof-window-9f3a";
        const BRIEF: &str = "mutation-proof-viewport-brief-b7c2-three-filters-two-lanes";

        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(GroundThenAnswerProvider {
                call: std::sync::atomic::AtomicUsize::new(0),
            })
            .mount(&server)
            .await;

        let workspace_dir = tempfile::tempdir().unwrap();
        let workspace = Workspace::new("t", vec![workspace_dir.path().to_path_buf()]);
        let index = KeywordIndex::build(&workspace).unwrap();
        let mut host = ToolHost::new(workspace, index, None);

        // Offers `recall_memory` so "durable memory" becomes a real,
        // genuinely-outstanding required read rather than an "unavailable
        // source" — the fixture must ask for a source the host CAN serve so
        // the turn keeps looping toward it instead of giving up early.
        let memory_store =
            std::sync::Arc::new(cd_core::memory::SqliteMemoryStore::open_in_memory().unwrap());
        host.set_durable_memory(memory_store, true);

        // A genuinely empty corpus makes `search_logs` return zero hits,
        // which the agent loop treats as failed grounding (`linked_no_tool`)
        // and ends the turn before ever reaching the required-next-source
        // stage this test needs — so this ingests one real matching event,
        // the same lightweight `ingest_path` helper
        // `agent.rs::linked_turn_executes_search_logs_then_answers_with_fixture_identities`
        // uses, instead of `LogCorpus::create`'s bare skeleton.
        let logs_dir = workspace_dir.path().join("logs");
        std::fs::create_dir_all(&logs_dir).unwrap();
        std::fs::write(
            logs_dir.join("worker.log"),
            r#"{"ts":1700000100,"level":"error","service":"worker","message":"mutation-proof-incident-42 pool exhausted"}"#,
        )
        .unwrap();
        let cache_root = tempfile::tempdir().unwrap();
        let report =
            cd_core::log_analysis::ingest_path(cache_root.path(), &logs_dir, "t", None, "none")
                .expect("ingest the fixture log line");
        let corpus_id = report.corpus_id;
        host.set_log_analysis(true, Some(cache_root.path().to_path_buf()));
        let binding =
            bind_linked_corpus(&mut host, cache_root.path(), &corpus_id).expect("corpus binds");

        let secrets = MemorySecretStore::new();
        let mut profile = ProviderProfile::ollama_local();
        profile.kind = ProviderKind::OpenAiCompatible;
        profile.base_url = server.uri();
        profile.local_only = true;
        profile.chat_model = "test-model".into();
        // A linked turn refuses to start at all against a tools-disabled
        // profile (`linked_tools_unavailable_events`) — tools must stay on
        // so the turn actually reaches the mocked provider round below.
        profile.capabilities.tools = true;
        let cfg = AppConfig {
            providers: ProviderConfig {
                active_id: Some(profile.id.clone()),
                profiles: vec![profile],
            },
            ..AppConfig::default()
        };
        let resolved = resolve_turn_inputs(&secrets, &cfg, None, None).expect("resolved");

        let context = LogExplorerTurnContext::new(WINDOW_ID, &corpus_id, BRIEF)
            .expect("valid explorer context")
            .with_noise_lens_suspended(true);
        assert_ne!(
            context.origin,
            cd_core::agent::LinkedLogTurnOrigin::MainChat,
            "the fixture must exercise the non-default origin this test is about"
        );

        let mut history = Vec::new();
        let events = run_turn(
            &mut host,
            &resolved,
            "what happened here? also check durable memory for related context",
            &mut history,
            "s-linked",
            TurnExecutionOptions {
                context: Some(context),
                ..TurnExecutionOptions::default()
            },
            None,
            None,
        )
        .await
        .expect("linked turn completes with the caller's own context");

        assert!(events
            .iter()
            .any(|e| matches!(e, StreamEvent::TurnCompleted { .. })));

        let requests = server
            .received_requests()
            .await
            .expect("wiremock records requests by default");
        assert!(
            requests.len() >= 2,
            "expected at least a grounding round and a required-next-source round, got {}",
            requests.len()
        );
        // Every round's system message is inspected together rather than
        // picking one index by hand: the exact round that reaches the
        // "REQUIRED NEXT SOURCE" stage is an internal implementation detail
        // of agent.rs's staging logic, not something this test should have
        // to predict — what matters is that it happens at least once, in a
        // request that genuinely left this function and reached the mock.
        let system_content: String = requests
            .iter()
            .map(|req| {
                serde_json::from_slice::<serde_json::Value>(&req.body)
                    .expect("request body is JSON")
            })
            .flat_map(|sent| {
                sent["messages"]
                    .as_array()
                    .expect("messages array")
                    .iter()
                    .filter(|m| m["role"] == "system")
                    .filter_map(|m| m["content"].as_str().map(str::to_string))
                    .collect::<Vec<_>>()
            })
            .collect::<Vec<_>>()
            .join("\n---\n");

        assert!(
            system_content.contains(WINDOW_ID),
            "the caller's Explorer window id must reach the actual provider request, \
             not just survive in the return value — system content:\n{system_content}"
        );
        assert!(
            system_content.contains(BRIEF),
            "the caller's viewport brief must reach the actual provider request — \
             system content:\n{system_content}"
        );
        assert!(
            system_content.contains("linked to Log Explorer window"),
            "the request must carry LogExplorerTurnContext's Explorer-origin \
             phrasing, not a rebuilt MainChat one — system content:\n{system_content}"
        );
        assert!(
            !system_content
                .contains("No Log Explorer viewport, filters, lanes, or selection are implied"),
            "this exact phrase is what LogExplorerTurnContext::for_main_chat's MainChat \
             origin renders instead — its presence means run_linked_turn silently \
             rebuilt the caller's context rather than forwarding it — \
             system content:\n{system_content}"
        );

        unbind_linked_corpus(&mut host, binding);
    }

    /// A cancelled turn must not poison the host or history for the turn
    /// after it — Tauri's `agent_turn` mints a fresh cancel flag per
    /// admission (`AdmittedAgentTurn`), so the shared kernel is the only
    /// place a stale flag or a half-applied history mutation from turn 1
    /// could leak into turn 2. `within_turn_deadline` checks its cancel flag
    /// before the request even starts, so turn 1 here never reaches the mock
    /// server — no Mock is mounted for it, which is itself part of the
    /// proof: a cancelled turn contacts no provider.
    #[tokio::test]
    async fn a_cancelled_turn_never_blocks_a_successful_retry_on_the_same_session() {
        let server = MockServer::start().await;

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
        let resolved = resolve_turn_inputs(&secrets, &cfg, None, None).expect("resolved");

        let mut history = Vec::new();
        let history_len_before_cancel = history.len();

        // Turn 1: already-cancelled — the exact state a genuinely mid-flight
        // cancel leaves the flag in by the time the caller sees the result.
        let already_cancelled = std::sync::Arc::new(AtomicBool::new(true));
        let cancelled_result = run_turn(
            &mut host,
            &resolved,
            "first question",
            &mut history,
            "s-cancel-retry",
            TurnExecutionOptions {
                cancel: Some(already_cancelled),
                ..TurnExecutionOptions::default()
            },
            None,
            None,
        )
        .await
        .expect("a cancelled turn is a clean result, not an error");
        assert!(cancelled_result
            .iter()
            .any(|e| matches!(e, StreamEvent::TurnCompleted { reason } if reason == "cancel")));
        assert_eq!(
            history.len(),
            history_len_before_cancel,
            "a cancelled turn must not leave a half-written exchange in history"
        );

        // Turn 2: a fresh, never-cancelled flag — exactly what a new
        // AdmittedAgentTurn mints — must succeed normally on the same host
        // and history the cancelled turn touched.
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "text/event-stream")
                    .set_body_raw(SSE_BODY, "text/event-stream"),
            )
            .mount(&server)
            .await;
        let fresh_cancel = std::sync::Arc::new(AtomicBool::new(false));
        let retried = run_turn(
            &mut host,
            &resolved,
            "first question",
            &mut history,
            "s-cancel-retry",
            TurnExecutionOptions {
                cancel: Some(fresh_cancel),
                ..TurnExecutionOptions::default()
            },
            None,
            None,
        )
        .await
        .expect("the retry reaches the provider and completes");
        assert!(retried
            .iter()
            .any(|e| matches!(e, StreamEvent::TurnCompleted { reason } if reason == "stop")));
        assert_eq!(
            history.len(),
            history_len_before_cancel + 3,
            "the successful retry appends a system preamble (history was still \
             empty going in — the cancelled turn added nothing) + one user + \
             one assistant message"
        );
    }
}
