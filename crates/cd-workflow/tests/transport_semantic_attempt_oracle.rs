//! Transport-retry vs semantic-attempt acceptance oracle — workflow seam.
//!
//! Proves, over the REAL `cd_workflow::turn::run_turn` → `cd-core` provider
//! kernel against a deterministic fault-injecting OpenAI-compatible mock,
//! that HTTP-transport recovery (bounded 429 retries inside
//! `OpenAiCompatibleClient::post_completion_with_429_retry`) and semantic
//! LLM-analysis attempts (application model rounds / candidate analyses)
//! are never conflated:
//!
//! * a semantic attempt is consumed only when a provider response reaches
//!   the stage where ContextDesk can evaluate an analysis;
//! * 429/transport faults before a usable response never consume one;
//! * exhausted transport retries surface as an explicit provider failure —
//!   never as "bad evidence" (`linked_no_tool`) or "analysis invalid"
//!   (`linked_invalid_grounded_answer`);
//! * cancellation during backoff stops promptly without another request;
//! * a completed tool effect is never re-executed by a transport retry.
//!
//! Timing discipline: every 429 fixture that must recover carries
//! `Retry-After: 0` (the established hermetic-time strategy from
//! `cd-core/tests/openai_compatible_provider_matrix.rs`); fixtures that must
//! park in backoff carry `Retry-After: 60` and are cut short by cancellation
//! within milliseconds. No test sleeps for a product-visible duration.
//!
//! Tests marked `RED (known gap at base)` in their doc comment are expected
//! to FAIL on the audited base commit: each pins a contract the product does
//! not yet satisfy, and each is paired with a green positive control in this
//! file so a degenerate "never retry / never classify" implementation cannot
//! pass the pair.

use cd_core::agent::LinkedSynthesisCheckpoint;
use cd_core::config::AppConfig;
use cd_core::events::StreamEvent;
use cd_core::index::KeywordIndex;
use cd_core::keychain_store::MemorySecretStore;
use cd_core::providers::{ProviderConfig, ProviderKind, ProviderProfile};
use cd_core::tool_host::ToolHost;
use cd_core::turn_trace::RecordingTurnTrace;
use cd_core::workspace::Workspace;
use cd_workflow::provider::{resolve_turn_inputs, ResolvedTurnInputs};
use cd_workflow::turn::{bind_linked_corpus, run_turn, TurnExecutionOptions};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, Request, Respond, ResponseTemplate};

const SSE_HELLO: &str = "data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}\n\n\
     data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n\
     data: [DONE]\n\n";

const SSE_EMPTY_STOP: &str = "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n\
     data: [DONE]\n\n";

const SSE_LENGTH_TRUNCATED: &str =
    "data: {\"choices\":[{\"delta\":{\"content\":\"partial answer cut\"}}]}\n\n\
     data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"length\"}]}\n\n\
     data: [DONE]\n\n";

/// One scripted wire response. `retry_after: None` on a 429 exercises the
/// bounded fallback delay; tests that use it must cut the wait short.
#[derive(Clone)]
enum WireStep {
    RateLimited { retry_after: Option<&'static str> },
    Sse(&'static str),
    Json(serde_json::Value),
}

/// Deterministic per-call script. Indexes past the end repeat the last step,
/// so "429 forever" is `vec![RateLimited { .. }]`.
struct ScriptedProvider {
    calls: Arc<AtomicUsize>,
    steps: Vec<WireStep>,
}

impl ScriptedProvider {
    fn mounted(steps: Vec<WireStep>) -> (Self, Arc<AtomicUsize>) {
        let calls = Arc::new(AtomicUsize::new(0));
        (
            Self {
                calls: calls.clone(),
                steps,
            },
            calls,
        )
    }
}

impl Respond for ScriptedProvider {
    fn respond(&self, _request: &Request) -> ResponseTemplate {
        let index = self.calls.fetch_add(1, Ordering::SeqCst);
        let step = self
            .steps
            .get(index)
            .cloned()
            .unwrap_or_else(|| self.steps.last().expect("non-empty script").clone());
        match step {
            WireStep::RateLimited { retry_after } => {
                let mut template = ResponseTemplate::new(429)
                    .set_body_string(r#"{"error":{"message":"provider rate limited"}}"#);
                if let Some(value) = retry_after {
                    template = template.insert_header("retry-after", value);
                }
                template
            }
            WireStep::Sse(body) => ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_raw(body, "text/event-stream"),
            WireStep::Json(body) => ResponseTemplate::new(200)
                .insert_header("content-type", "application/json")
                .set_body_json(body),
        }
    }
}

async fn mount_script(server: &MockServer, steps: Vec<WireStep>) -> Arc<AtomicUsize> {
    let (responder, calls) = ScriptedProvider::mounted(steps);
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(responder)
        .mount(server)
        .await;
    calls
}

fn tool_call_search_logs() -> serde_json::Value {
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
                        "arguments": {"query": "oracle-incident-77", "semantic": false, "k": 5}
                    }
                }]
            }
        }]
    })
}

fn plain_answer(text: &str) -> serde_json::Value {
    serde_json::json!({
        "choices": [{
            "finish_reason": "stop",
            "message": {"role": "assistant", "content": text}
        }]
    })
}

fn resolved_inputs(base_url: &str, tools: bool) -> (MemorySecretStore, ResolvedTurnInputs) {
    let secrets = MemorySecretStore::new();
    let mut profile = ProviderProfile::ollama_local();
    profile.kind = ProviderKind::OpenAiCompatible;
    profile.base_url = base_url.to_string();
    profile.local_only = true;
    profile.chat_model = "oracle-test-model".into();
    profile.capabilities.tools = tools;
    let cfg = AppConfig {
        providers: ProviderConfig {
            active_id: Some(profile.id.clone()),
            profiles: vec![profile],
        },
        ..AppConfig::default()
    };
    let resolved = resolve_turn_inputs(&secrets, &cfg, None, None).expect("resolved inputs");
    (secrets, resolved)
}

fn ordinary_host() -> (tempfile::TempDir, ToolHost) {
    let workspace_dir = tempfile::tempdir().expect("workspace dir");
    let workspace = Workspace::new("t", vec![workspace_dir.path().to_path_buf()]);
    let index = KeywordIndex::build(&workspace).expect("index");
    (workspace_dir, ToolHost::new(workspace, index, None))
}

/// A linked-turn fixture with one real ingested log event, so the mandatory
/// `search_logs` grounding round genuinely succeeds against host evidence.
struct LinkedFixture {
    _workspace_dir: tempfile::TempDir,
    _cache_root: tempfile::TempDir,
    host: ToolHost,
    context: cd_core::agent::LogExplorerTurnContext,
}

fn linked_fixture() -> LinkedFixture {
    let workspace_dir = tempfile::tempdir().expect("workspace dir");
    let workspace = Workspace::new("t", vec![workspace_dir.path().to_path_buf()]);
    let index = KeywordIndex::build(&workspace).expect("index");
    let mut host = ToolHost::new(workspace, index, None);

    let logs_dir = workspace_dir.path().join("logs");
    std::fs::create_dir_all(&logs_dir).expect("logs dir");
    std::fs::write(
        logs_dir.join("worker.log"),
        r#"{"ts":1700000100,"level":"error","service":"worker","message":"oracle-incident-77 pool exhausted"}"#,
    )
    .expect("fixture log line");
    let cache_root = tempfile::tempdir().expect("cache root");
    let report =
        cd_core::log_analysis::ingest_path(cache_root.path(), &logs_dir, "t", None, "none")
            .expect("ingest fixture");
    let corpus_id = report.corpus_id;
    host.set_log_analysis(true, Some(cache_root.path().to_path_buf()));
    bind_linked_corpus(&mut host, cache_root.path(), &corpus_id).expect("corpus binds");
    let context =
        cd_core::agent::LogExplorerTurnContext::for_main_chat(&corpus_id).expect("linked context");
    LinkedFixture {
        _workspace_dir: workspace_dir,
        _cache_root: cache_root,
        host,
        context,
    }
}

fn provider_turn_telemetry(
    events: &[StreamEvent],
) -> cd_core::provider_telemetry::ProviderTurnTelemetry {
    events
        .iter()
        .find_map(|event| match event {
            StreamEvent::ProviderTelemetry { telemetry } => Some((**telemetry).clone()),
            _ => None,
        })
        .expect("run_turn appends one authoritative ProviderTelemetry event")
}

fn error_codes(events: &[StreamEvent]) -> Vec<String> {
    events
        .iter()
        .filter_map(|event| match event {
            StreamEvent::Error { code, .. } => Some(code.clone()),
            _ => None,
        })
        .collect()
}

fn terminal_reason(events: &[StreamEvent]) -> Option<String> {
    events.iter().rev().find_map(|event| match event {
        StreamEvent::TurnCompleted { reason } => Some(reason.clone()),
        _ => None,
    })
}

/// Wait (bounded, millisecond-granular) until the mock has served `n` calls,
/// then flip the cancel flag — the only way to deterministically cancel
/// *during* transport backoff rather than before the first request.
async fn cancel_after_calls(calls: Arc<AtomicUsize>, n: usize, cancel: Arc<AtomicBool>) {
    tokio::spawn(async move {
        for _ in 0..2_000 {
            if calls.load(Ordering::SeqCst) >= n {
                cancel.store(true, Ordering::SeqCst);
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(2)).await;
        }
        cancel.store(true, Ordering::SeqCst);
    });
}

// ---------------------------------------------------------------------------
// Scenario 1 — two 429s then success: three transport attempts, one semantic
// attempt, one accepted analysis. Positive control for the "semantic attempts
// increment before HTTP success" and "never retry" mutants: a mutant that
// consumes a model round per HTTP attempt reports provider_round_count == 3
// here; a mutant that never retries sees wire == 1 and an Err turn.
// ---------------------------------------------------------------------------
#[tokio::test]
async fn ordinary_turn_with_two_429s_consumes_three_transport_attempts_and_one_model_round() {
    let server = MockServer::start().await;
    let wire_calls = mount_script(
        &server,
        vec![
            WireStep::RateLimited {
                retry_after: Some("0"),
            },
            WireStep::RateLimited {
                retry_after: Some("0"),
            },
            WireStep::Sse(SSE_HELLO),
        ],
    )
    .await;

    let (_workspace_dir, mut host) = ordinary_host();
    let (_secrets, resolved) = resolved_inputs(&server.uri(), false);
    let mut history = Vec::new();
    let events = run_turn(
        &mut host,
        &resolved,
        "hi there",
        &mut history,
        "s-oracle-429-recovery",
        TurnExecutionOptions::default(),
        None,
        None,
    )
    .await
    .expect("429s followed by success recover within the same semantic attempt");

    assert_eq!(
        wire_calls.load(Ordering::SeqCst),
        3,
        "three transport attempts must reach the wire (initial + two bounded retries)"
    );
    assert_eq!(terminal_reason(&events).as_deref(), Some("stop"));
    assert!(events
        .iter()
        .any(|e| matches!(e, StreamEvent::TextDelta { text } if text.contains("hello"))));

    let telemetry = provider_turn_telemetry(&events);
    assert_eq!(
        telemetry.provider_round_count, 1,
        "transport retries must not consume application model rounds"
    );
    assert_eq!(telemetry.rounds.len(), 1);
    assert_eq!(telemetry.rounds[0].outcome, "completed");
    assert!(
        telemetry.application_retry_reasons.is_empty(),
        "a transport-level 429 retry is not an application retry"
    );
    assert!(!telemetry.rounds[0].empty_visible_answer);
}

// ---------------------------------------------------------------------------
// Scenario 2 — 429 exhaustion on an ordinary turn.
//
// RED (known gap at base): the shared kernel classifies provider failures
// into typed terminal events only for LINKED turns
// (`terminal_linked_provider_failure`, agent.rs). An ordinary turn's
// exhausted 429 escapes `run_turn` as a raw `Err(CoreError::Message(..))` —
// no `TurnCompleted`, no typed `Error` event, and the authoritative
// `ProviderTelemetry` aggregate is never appended, so CLI and Tauri each see
// an opaque string instead of the same typed status. Worse, the observed
// string on base is `"Streaming rejected by provider
// (capabilities.stream=true but request failed): stream HTTP 429 …"`:
// `CapabilityAwareBackend::complete_streaming` (research.rs) matches the
// literal "stream" in the transport operation label `"stream HTTP 429"` with
// its stream-rejection needle and re-attributes an exhausted rate limit to a
// streaming-capability problem. The contract pinned here: exhaustion must
// yield a typed provider/rate-limit terminal the way linked turns already
// do. Positive controls: `ordinary_turn_with_two_429s…` (recovery is green)
// and `linked_retrieval_429_exhaustion…` (linked classification is green).
// ---------------------------------------------------------------------------
#[tokio::test]
async fn ordinary_turn_429_exhaustion_projects_a_typed_rate_limit_terminal() {
    let server = MockServer::start().await;
    let wire_calls = mount_script(
        &server,
        vec![WireStep::RateLimited {
            retry_after: Some("0"),
        }],
    )
    .await;

    let (_workspace_dir, mut host) = ordinary_host();
    let (_secrets, resolved) = resolved_inputs(&server.uri(), false);
    let mut history = Vec::new();
    let result = run_turn(
        &mut host,
        &resolved,
        "hi there",
        &mut history,
        "s-oracle-429-exhaustion",
        TurnExecutionOptions::default(),
        None,
        None,
    )
    .await;

    assert_eq!(
        wire_calls.load(Ordering::SeqCst),
        3,
        "the bounded transport budget is one initial attempt plus two retries"
    );

    let events = result.expect(
        "RED (known gap at base): an exhausted provider rate limit must terminate as a \
         typed event stream (explicit provider/rate-limit failure + ProviderTelemetry), \
         not an opaque Err that erases the turn's typed telemetry for both hosts",
    );
    let reason = terminal_reason(&events).expect("typed terminal reason");
    assert!(
        reason.contains("provider") || reason.contains("rate"),
        "the terminal reason must name the provider/rate-limit failure, got {reason:?}"
    );
    let telemetry = provider_turn_telemetry(&events);
    assert_eq!(telemetry.provider_round_count, 1);
    assert_eq!(telemetry.rounds[0].outcome, "failed");
}

// ---------------------------------------------------------------------------
// Scenario 2 + mutation "describing an exhausted 429 as evidence failure" —
// linked retrieval stage. PASS_ON_BASE: this is the classification the
// ordinary-turn RED test above demands everywhere.
// ---------------------------------------------------------------------------
#[tokio::test]
async fn linked_retrieval_429_exhaustion_is_provider_error_not_evidence_or_analysis_failure() {
    let server = MockServer::start().await;
    let wire_calls = mount_script(
        &server,
        vec![WireStep::RateLimited {
            retry_after: Some("0"),
        }],
    )
    .await;

    let mut fixture = linked_fixture();
    let (_secrets, resolved) = resolved_inputs(&server.uri(), true);
    let mut history = Vec::new();
    let mut checkpoint: Option<LinkedSynthesisCheckpoint> = None;
    let events = run_turn(
        &mut fixture.host,
        &resolved,
        "What happened in worker.log?",
        &mut history,
        "s-oracle-linked-retrieval-429",
        TurnExecutionOptions {
            context: Some(fixture.context.clone()),
            ..TurnExecutionOptions::default()
        },
        None,
        Some(&mut checkpoint),
    )
    .await
    .expect("linked provider exhaustion is a typed terminal turn, not an Err");

    assert_eq!(wire_calls.load(Ordering::SeqCst), 3);

    let codes = error_codes(&events);
    assert!(
        codes.iter().any(|c| c == "linked_retrieval_provider_error"),
        "exhausted transport retries must surface as an explicit provider failure, got {codes:?}"
    );
    assert!(
        !codes.iter().any(|c| c == "linked_no_tool"),
        "a rate-limited provider must never be described as an evidence failure"
    );
    assert!(
        !codes.iter().any(|c| c == "linked_invalid_grounded_answer"),
        "a rate-limited provider must never be described as an invalid analysis"
    );
    assert_eq!(
        terminal_reason(&events).as_deref(),
        Some("linked_retrieval_provider_error")
    );
    assert!(
        checkpoint.is_none(),
        "no synthesis-only retry exists when retrieval never completed"
    );

    let telemetry = provider_turn_telemetry(&events);
    assert_eq!(
        telemetry.provider_round_count, 1,
        "three wire attempts fold into one failed provider round"
    );
    assert_eq!(telemetry.rounds[0].outcome, "failed");
    let error = telemetry.rounds[0].error.as_deref().unwrap_or_default();
    assert!(
        error.contains("429"),
        "the round error must preserve the rate-limit identity, got {error:?}"
    );
    assert!(
        !error.to_ascii_lowercase().contains("evidence")
            && !error.to_ascii_lowercase().contains("invalid"),
        "the provider failure must not borrow analysis-failure language, got {error:?}"
    );
}

// ---------------------------------------------------------------------------
// Scenario 2/9 — synthesis-stage exhaustion after grounding succeeded:
// still a provider failure, and the retrieved evidence is preserved for a
// synthesis-only retry. The candidate (grounded evidence) stays unassessed —
// it is not rejected and not called invalid.
// ---------------------------------------------------------------------------
#[tokio::test]
async fn linked_synthesis_429_exhaustion_preserves_unassessed_evidence_for_retry() {
    let server = MockServer::start().await;
    let wire_calls = mount_script(
        &server,
        vec![
            WireStep::Json(tool_call_search_logs()),
            WireStep::RateLimited {
                retry_after: Some("0"),
            },
        ],
    )
    .await;

    let mut fixture = linked_fixture();
    let (_secrets, resolved) = resolved_inputs(&server.uri(), true);
    let mut history = Vec::new();
    let mut checkpoint: Option<LinkedSynthesisCheckpoint> = None;
    let events = run_turn(
        &mut fixture.host,
        &resolved,
        "What happened in worker.log?",
        &mut history,
        "s-oracle-linked-synthesis-429",
        TurnExecutionOptions {
            context: Some(fixture.context.clone()),
            ..TurnExecutionOptions::default()
        },
        None,
        Some(&mut checkpoint),
    )
    .await
    .expect("linked synthesis provider exhaustion is a typed terminal turn");

    assert_eq!(
        wire_calls.load(Ordering::SeqCst),
        4,
        "one completed grounding round plus the exhausted 3-attempt synthesis call"
    );

    let codes = error_codes(&events);
    assert!(
        codes.iter().any(|c| c == "linked_synthesis_provider_error"),
        "synthesis-stage exhaustion is an explicit provider failure, got {codes:?}"
    );
    assert!(!codes.iter().any(|c| c == "linked_invalid_grounded_answer"));
    assert!(!codes.iter().any(|c| c == "linked_no_tool"));
    assert!(
        checkpoint.is_some(),
        "successfully retrieved evidence must remain preserved (unassessed, not rejected)"
    );

    let telemetry = provider_turn_telemetry(&events);
    assert_eq!(
        telemetry.provider_round_count, 2,
        "one completed grounding round + one failed synthesis round; transport retries invisible"
    );
    assert_eq!(telemetry.rounds[0].outcome, "completed");
    assert_eq!(telemetry.rounds[1].outcome, "failed");
}

// ---------------------------------------------------------------------------
// Scenario 5 + mutation "retrying after cancellation" — cancellation while
// parked in a 60-second Retry-After backoff must stop promptly, send no
// further request, and consume no semantic attempt.
// ---------------------------------------------------------------------------
#[tokio::test]
async fn cancellation_during_retry_backoff_stops_promptly_without_another_request() {
    let server = MockServer::start().await;
    let wire_calls = mount_script(
        &server,
        vec![WireStep::RateLimited {
            retry_after: Some("60"),
        }],
    )
    .await;

    let (_workspace_dir, mut host) = ordinary_host();
    let (_secrets, resolved) = resolved_inputs(&server.uri(), false);
    let cancel = Arc::new(AtomicBool::new(false));
    cancel_after_calls(wire_calls.clone(), 1, cancel.clone()).await;

    let started = std::time::Instant::now();
    let mut history = Vec::new();
    let result = run_turn(
        &mut host,
        &resolved,
        "hi there",
        &mut history,
        "s-oracle-cancel-backoff",
        TurnExecutionOptions {
            cancel: Some(cancel),
            ..TurnExecutionOptions::default()
        },
        None,
        None,
    )
    .await;
    let elapsed = started.elapsed();

    assert!(
        elapsed < std::time::Duration::from_secs(10),
        "cancellation must interrupt the 60s backoff promptly, took {elapsed:?}"
    );
    assert_eq!(
        wire_calls.load(Ordering::SeqCst),
        1,
        "no further transport attempt may follow a cancellation observed in backoff"
    );
    let events = result.expect("a cancelled turn is a clean typed result, not an Err");
    assert_eq!(
        terminal_reason(&events).as_deref(),
        Some("cancel"),
        "cancellation during backoff is 'cancel' — never a provider or analysis failure"
    );
    assert!(
        !events
            .iter()
            .any(|e| matches!(e, StreamEvent::TextDelta { .. })),
        "no answer text may be fabricated for a cancelled turn"
    );
    let telemetry = provider_turn_telemetry(&events);
    assert!(
        telemetry
            .rounds
            .iter()
            .all(|round| round.outcome != "completed"),
        "a turn cancelled during backoff completed no semantic attempt"
    );
}

// ---------------------------------------------------------------------------
// Mutation "counting a retried tool call twice" — a completed tool effect is
// executed exactly once even when the NEXT provider call needs transport
// retries (its request body replays the tool RESULT, never the tool CALL).
//
// Wire arithmetic: the mocked final answer ("hello") carries no evidence
// citations, so the kernel spends its one bounded correction round before
// accepting the host-cited answer — 1 (tool) + 3 (429,429,success) + 1
// (correction) = 5 transport attempts across 3 semantic rounds.
// ---------------------------------------------------------------------------
#[tokio::test]
async fn transport_retries_never_replay_a_completed_tool_effect() {
    let server = MockServer::start().await;
    let wire_calls = mount_script(
        &server,
        vec![
            WireStep::Json(tool_call_search_logs()),
            WireStep::RateLimited {
                retry_after: Some("0"),
            },
            WireStep::RateLimited {
                retry_after: Some("0"),
            },
            WireStep::Json(plain_answer("hello")),
        ],
    )
    .await;

    let mut fixture = linked_fixture();
    let (_secrets, resolved) = resolved_inputs(&server.uri(), true);
    let mut history = Vec::new();
    let events = run_turn(
        &mut fixture.host,
        &resolved,
        "What happened in worker.log?",
        &mut history,
        "s-oracle-tool-once",
        TurnExecutionOptions {
            context: Some(fixture.context.clone()),
            ..TurnExecutionOptions::default()
        },
        None,
        None,
    )
    .await
    .expect("tool round then 429-retried synthesis completes");

    assert_eq!(wire_calls.load(Ordering::SeqCst), 5);
    assert_eq!(terminal_reason(&events).as_deref(), Some("stop"));

    let search_started = events
        .iter()
        .filter(|e| {
            matches!(e, StreamEvent::Tool { name, phase, .. }
            if name == "search_logs" && *phase == cd_core::events::ToolPhase::Started)
        })
        .count();
    let search_finished = events
        .iter()
        .filter(|e| {
            matches!(e, StreamEvent::Tool { name, phase, ok, .. }
            if name == "search_logs"
                && *phase == cd_core::events::ToolPhase::Finished
                && *ok == Some(true))
        })
        .count();
    assert_eq!(
        (search_started, search_finished),
        (1, 1),
        "the completed search_logs effect must execute exactly once despite transport retries"
    );

    let telemetry = provider_turn_telemetry(&events);
    assert_eq!(
        telemetry.provider_round_count, 3,
        "tool round + uncited synthesis + bounded correction; 429 attempts are transport, not rounds"
    );
    assert_eq!(telemetry.tool_call_count, 1);
}

// ---------------------------------------------------------------------------
// Scenario 8a/8b at the workflow seam — an empty visible answer and a
// length-truncated answer are COMPLETED semantic attempts (typed as such),
// never transport failures and never conflated with provider unavailability.
// ---------------------------------------------------------------------------
#[tokio::test]
async fn empty_visible_answer_is_a_completed_semantic_attempt_with_typed_emptiness() {
    let server = MockServer::start().await;
    let wire_calls = mount_script(&server, vec![WireStep::Sse(SSE_EMPTY_STOP)]).await;

    let (_workspace_dir, mut host) = ordinary_host();
    let (_secrets, resolved) = resolved_inputs(&server.uri(), false);
    let mut history = Vec::new();
    let events = run_turn(
        &mut host,
        &resolved,
        "hi there",
        &mut history,
        "s-oracle-empty-answer",
        TurnExecutionOptions::default(),
        None,
        None,
    )
    .await
    .expect("an empty completed answer is a completed turn, not a transport failure");

    assert_eq!(
        wire_calls.load(Ordering::SeqCst),
        1,
        "an empty visible answer must not trigger any transport retry"
    );
    let telemetry = provider_turn_telemetry(&events);
    assert_eq!(telemetry.provider_round_count, 1);
    assert_eq!(telemetry.rounds[0].outcome, "completed");
    assert!(
        telemetry.empty_visible_answer,
        "typed telemetry must disclose the empty visible answer"
    );
    assert!(!telemetry.truncated_by_length);
}

#[tokio::test]
async fn length_truncated_answer_is_a_completed_semantic_attempt_with_typed_truncation() {
    let server = MockServer::start().await;
    let wire_calls = mount_script(&server, vec![WireStep::Sse(SSE_LENGTH_TRUNCATED)]).await;

    let (_workspace_dir, mut host) = ordinary_host();
    let (_secrets, resolved) = resolved_inputs(&server.uri(), false);
    let mut history = Vec::new();
    let events = run_turn(
        &mut host,
        &resolved,
        "hi there",
        &mut history,
        "s-oracle-length-truncated",
        TurnExecutionOptions::default(),
        None,
        None,
    )
    .await
    .expect("a length-truncated answer is a completed provider-output condition");

    assert_eq!(
        wire_calls.load(Ordering::SeqCst),
        1,
        "provider-side truncation must not trigger any transport retry"
    );
    let telemetry = provider_turn_telemetry(&events);
    assert_eq!(telemetry.provider_round_count, 1);
    assert_eq!(telemetry.rounds[0].outcome, "completed");
    assert!(
        telemetry.truncated_by_length,
        "typed telemetry must disclose provider-side truncation"
    );
    assert_eq!(telemetry.finish_reason.as_deref(), Some("length"));
}

// ---------------------------------------------------------------------------
// Scenario 7 — a real completed but analytically invalid answer consumes
// exactly one semantic attempt, then the bounded correction attempt begins.
// Positive control for the linked exhaustion tests: analysis-failure
// vocabulary appears exactly when the analysis actually failed.
// ---------------------------------------------------------------------------
#[tokio::test]
async fn completed_but_invalid_analysis_consumes_one_attempt_then_bounded_correction() {
    let server = MockServer::start().await;
    // Round 0 grounds. Round 1 completes an answer that cites a fabricated
    // evidence identity (invalid grounding). Round 2 is the bounded
    // correction, which also fails validation -> host withholds.
    let wire_calls = mount_script(
        &server,
        vec![
            WireStep::Json(tool_call_search_logs()),
            WireStep::Json(plain_answer(
                "The cause is proven: seq=999999 source=\"fabricated.log\" template_id=999999",
            )),
            WireStep::Json(plain_answer(
                "Still proven: seq=888888 source=\"also-fabricated.log\" template_id=888888",
            )),
        ],
    )
    .await;

    let mut fixture = linked_fixture();
    let (_secrets, resolved) = resolved_inputs(&server.uri(), true);
    let mut history = Vec::new();
    let events = run_turn(
        &mut fixture.host,
        &resolved,
        "What happened in worker.log?",
        &mut history,
        "s-oracle-invalid-analysis",
        TurnExecutionOptions {
            context: Some(fixture.context.clone()),
            ..TurnExecutionOptions::default()
        },
        None,
        None,
    )
    .await
    .expect("an analytically invalid answer is a typed withheld turn");

    assert_eq!(
        wire_calls.load(Ordering::SeqCst),
        3,
        "grounding + invalid synthesis + one bounded correction — no transport retries"
    );
    let codes = error_codes(&events);
    assert!(
        codes.iter().any(|c| c == "linked_invalid_grounded_answer"),
        "an actually-invalid analysis is the one place analysis-failure vocabulary belongs, got {codes:?}"
    );
    assert!(
        !codes
            .iter()
            .any(|c| c.contains("provider_error") || c.contains("rate")),
        "a completed-but-invalid analysis must never be described as a provider failure"
    );
    let telemetry = provider_turn_telemetry(&events);
    assert_eq!(
        telemetry.provider_round_count, 3,
        "each completed analysis attempt (grounding, invalid answer, correction) is one round"
    );
    assert!(telemetry
        .rounds
        .iter()
        .all(|round| round.outcome == "completed"));
}

// ---------------------------------------------------------------------------
// Scenario 11 + mutation "CLI/Tauri projecting different attempt counts".
//
// Both hosts must derive attempt counters from the same typed capture. The
// qualification projection (`LiveTurnObservation.retries` — used by CLI
// provider-qualify and Tauri's activity_settled live_turn DTO) and the
// aggregate `ProviderTurnTelemetry.application_retry_reasons` (used by CLI
// trace summary and Tauri provider_telemetry DTO) must agree on how many
// application retries this turn performed.
//
// RED (known gap at base): `LiveTurnObservation.retries` is a window
// heuristic (`qualification.rs`) counting any provider call that follows a
// failed OR zero-tool-call completed round. A linked grounding nudge (model
// answers prose, host nudges it toward the required tool, turn recovers) is
// an ordinary semantic continuation — typed application_retry_reasons stays
// empty — yet the heuristic reports retries == 1. The two host-visible
// counters disagree on the same capture.
// ---------------------------------------------------------------------------
#[tokio::test]
async fn qualification_retries_and_typed_retry_reasons_agree_on_attempt_counts() {
    let server = MockServer::start().await;
    let wire_calls = mount_script(
        &server,
        vec![
            WireStep::Json(plain_answer(
                "I will inspect the linked logs and report back shortly.",
            )),
            WireStep::Json(tool_call_search_logs()),
            WireStep::Json(plain_answer("hello")),
        ],
    )
    .await;

    let mut fixture = linked_fixture();
    let (_secrets, resolved) = resolved_inputs(&server.uri(), true);
    let recorder = Arc::new(RecordingTurnTrace::new());
    let mut history = Vec::new();
    let events = run_turn(
        &mut fixture.host,
        &resolved,
        "What happened in worker.log?",
        &mut history,
        "s-oracle-projection-parity",
        TurnExecutionOptions {
            context: Some(fixture.context.clone()),
            telemetry_recorder: Some(recorder.clone()),
            ..TurnExecutionOptions::default()
        },
        None,
        None,
    )
    .await
    .expect("nudged linked turn recovers and completes");

    assert_eq!(
        wire_calls.load(Ordering::SeqCst),
        4,
        "prose round + nudged grounding round + uncited synthesis + bounded correction"
    );
    let telemetry = provider_turn_telemetry(&events);
    let calls = recorder.calls();
    let observation = cd_workflow::provider_telemetry::aggregate_provider_turn_telemetry(
        cd_workflow::provider_telemetry::ProviderTelemetryAggregateInput {
            configured_profile_id: &resolved.profile.id,
            configured_model: &resolved.profile.chat_model,
            events: &events,
            calls: &calls,
        },
    );

    assert_eq!(
        usize::try_from(observation.provider_round_count).expect("provider rounds fit usize"),
        calls.len()
    );
    assert_eq!(
        observation.application_retry_reasons.len(),
        telemetry.application_retry_reasons.len(),
        "RED (known gap at base): the qualification projection's window-heuristic \
         application retry count ({}) disagrees with the typed application_retry_reasons ({:?}) for \
         the same capture — CLI provider-qualify / Tauri live_turn would report a \
         different attempt count than the shared provider_telemetry DTO",
        observation.application_retry_reasons.len(),
        telemetry.application_retry_reasons,
    );
}

// Positive control for the parity RED test: on a genuine application retry
// (gateway rejects native tool calling; kernel notes `tools_unsupported` and
// re-sends without tools), BOTH counters report exactly one retry.
//
// The mock rejects EVERY request whose body offers tools, exactly like a
// real vLLM without --enable-auto-tool-choice: the streaming attempt and the
// OpenAI backend's internal non-stream fallback both fail (one semantic
// attempt, two transport attempts), the kernel notes `tools_unsupported`,
// and the tools-free retry round succeeds.
#[tokio::test]
async fn genuine_application_retry_is_counted_once_by_both_projections() {
    let server = MockServer::start().await;
    struct RejectToolsAlways {
        calls: Arc<AtomicUsize>,
    }
    impl Respond for RejectToolsAlways {
        fn respond(&self, request: &Request) -> ResponseTemplate {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let offers_tools = serde_json::from_slice::<serde_json::Value>(&request.body)
                .ok()
                .and_then(|body| body.get("tools").cloned())
                .is_some();
            if offers_tools {
                ResponseTemplate::new(400).set_body_string(
                    r#"{"message":"\"auto\" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set"}"#,
                )
            } else {
                ResponseTemplate::new(200)
                    .insert_header("content-type", "application/json")
                    .set_body_json(serde_json::json!({
                        "choices": [{
                            "finish_reason": "stop",
                            "message": {"role": "assistant", "content": "hello"}
                        }]
                    }))
            }
        }
    }
    let wire_calls = Arc::new(AtomicUsize::new(0));
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(RejectToolsAlways {
            calls: wire_calls.clone(),
        })
        .mount(&server)
        .await;

    let (_workspace_dir, mut host) = ordinary_host();
    let (_secrets, resolved) = resolved_inputs(&server.uri(), true);
    let recorder = Arc::new(RecordingTurnTrace::new());
    let mut history = Vec::new();
    let events = run_turn(
        &mut host,
        &resolved,
        "hi there",
        &mut history,
        "s-oracle-tools-unsupported-retry",
        TurnExecutionOptions {
            telemetry_recorder: Some(recorder.clone()),
            ..TurnExecutionOptions::default()
        },
        None,
        None,
    )
    .await
    .expect("tools-unsupported gateway recovers without tools");

    assert_eq!(
        wire_calls.load(Ordering::SeqCst),
        3,
        "rejected stream + rejected non-stream fallback (one semantic attempt) + tools-free retry"
    );
    let telemetry = provider_turn_telemetry(&events);
    assert_eq!(telemetry.application_retry_reasons.len(), 1);
    assert_eq!(
        telemetry.application_retry_reasons[0].reason,
        "tools_unsupported"
    );

    let calls = recorder.calls();
    let observation = cd_workflow::provider_telemetry::aggregate_provider_turn_telemetry(
        cd_workflow::provider_telemetry::ProviderTelemetryAggregateInput {
            configured_profile_id: &resolved.profile.id,
            configured_model: &resolved.profile.chat_model,
            events: &events,
            calls: &calls,
        },
    );
    assert_eq!(
        observation.application_retry_reasons.len(),
        1,
        "a genuine application retry is exactly one retry in the shared host projection"
    );
    assert_eq!(
        observation.application_retry_reasons.len(),
        telemetry.application_retry_reasons.len(),
        "both host-visible counters agree on a genuine application retry"
    );
}

// ---------------------------------------------------------------------------
// Host DTO parity control — the wire DTO both hosts render is produced by
// ONE function from ONE typed value. A mutant that forks per-host projection
// (or edits one path's counters) breaks this equality.
// ---------------------------------------------------------------------------
#[tokio::test]
async fn provider_telemetry_wire_dto_is_the_same_typed_value_for_both_hosts() {
    let server = MockServer::start().await;
    let _wire_calls = mount_script(
        &server,
        vec![
            WireStep::RateLimited {
                retry_after: Some("0"),
            },
            WireStep::Sse(SSE_HELLO),
        ],
    )
    .await;

    let (_workspace_dir, mut host) = ordinary_host();
    let (_secrets, resolved) = resolved_inputs(&server.uri(), false);
    let mut history = Vec::new();
    let events = run_turn(
        &mut host,
        &resolved,
        "hi there",
        &mut history,
        "s-oracle-dto-parity",
        TurnExecutionOptions::default(),
        None,
        None,
    )
    .await
    .expect("recovered turn completes");

    let event = events
        .iter()
        .find(|e| matches!(e, StreamEvent::ProviderTelemetry { .. }))
        .expect("aggregate telemetry event");
    let StreamEvent::ProviderTelemetry { telemetry } = event else {
        unreachable!();
    };
    let dto = cd_core::research::event_to_dto(event);
    assert_eq!(dto.kind, "provider_telemetry");
    assert_eq!(
        dto.payload,
        telemetry.to_json(),
        "the host-facing DTO must be a projection of the single typed value"
    );
    assert_eq!(dto.payload["providerRoundCount"], serde_json::json!(1));
}
