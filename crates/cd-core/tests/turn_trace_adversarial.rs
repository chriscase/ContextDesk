//! Adversarial coverage for the agent turn loop combined with
//! `cd_core::turn_trace`, using `ScriptedBackend` — the same mock-provider
//! mechanism `research_scripted_tool_turn` already uses internally — wrapped
//! in `TracingChatBackend` so every case also proves the trace hook records
//! the real loop faithfully, not just a hand-rolled approximation of it.
//!
//! Covers: zero/one/multiple tool calls in one turn, a failing backend,
//! interrupted (pre-cancelled) streaming, history bounding under a long
//! prior conversation, and secret content surviving redaction end to end
//! through the real loop rather than only through the isolated unit tests in
//! `crates/cd-core/src/turn_trace.rs`.

use async_trait::async_trait;
use cd_core::agent::{run_agent_turn, AgentOptions, ChatBackend, ScriptedBackend};
use cd_core::chat::{ChatCompletion, ChatMessage, FunctionCall, Role, ToolCallMsg};
use cd_core::error::{CoreError, CoreResult};
use cd_core::events::{StreamEvent, ToolPhase};
use cd_core::index::KeywordIndex;
use cd_core::tool_host::ToolHost;
use cd_core::tools::ToolSpec;
use cd_core::turn_trace::{RecordingTurnTrace, TracedOutcome, TracingChatBackend, TurnTraceSink};
use cd_core::workspace::Workspace;
use std::sync::Arc;

fn host() -> ToolHost {
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::new("t", vec![dir.path().to_path_buf()]);
    // Leaked deliberately: the workspace's tempdir must outlive the host in
    // these short-lived tests, and this file has no long-running process to
    // worry about accumulating leaks across.
    std::mem::forget(dir);
    let index = KeywordIndex::build(&ws).unwrap();
    ToolHost::new(ws, index, None)
}

fn options(session_id: &str) -> AgentOptions {
    AgentOptions {
        session_id: session_id.into(),
        model: Some("scripted".into()),
        max_rounds: 6,
        deadline_ms: 60_000,
        max_results_per_source: 8,
        cancel: None,
        ..Default::default()
    }
}

fn traced_backend(responses: Vec<ChatCompletion>) -> (TracingChatBackend, Arc<RecordingTurnTrace>) {
    let recorder = Arc::new(RecordingTurnTrace::new());
    let sink: Arc<dyn TurnTraceSink> = recorder.clone();
    let backend = TracingChatBackend::new(Box::new(ScriptedBackend::new(responses)), sink);
    (backend, recorder)
}

fn stop(content: &str) -> ChatCompletion {
    ChatCompletion {
        content: content.to_string(),
        tool_calls: vec![],
        finish_reason: "stop".to_string(),
    }
}

fn tool_call(id: &str, name: &str, query: &str) -> ToolCallMsg {
    ToolCallMsg {
        id: id.to_string(),
        kind: "function".to_string(),
        function: FunctionCall {
            name: name.to_string(),
            arguments: serde_json::json!({ "query": query, "limit": 8 }).to_string(),
        },
    }
}

// ---------------------------------------------------------------------------
// Zero / one / multiple tool calls
// ---------------------------------------------------------------------------

#[tokio::test]
async fn zero_tool_calls_completes_in_one_round() {
    let (backend, recorder) = traced_backend(vec![stop("no tools needed")]);
    let mut host = host();
    let mut history = vec![];
    let events = run_agent_turn(&backend, &mut host, "hi", &mut history, &options("s0"))
        .await
        .unwrap();

    assert!(events
        .iter()
        .any(|e| matches!(e, StreamEvent::TextDelta{text} if text == "no tools needed")));
    assert!(!events.iter().any(|e| matches!(e, StreamEvent::Tool { .. })));

    let calls = recorder.calls();
    assert_eq!(calls.len(), 1, "one backend call for a zero-tool turn");
    assert!(matches!(
        &calls[0].outcome,
        TracedOutcome::Completed {
            tool_call_count: 0,
            ..
        }
    ));
}

#[tokio::test]
async fn one_tool_call_makes_two_rounds_and_folds_the_result_into_the_next_round() {
    let (backend, recorder) = traced_backend(vec![
        ChatCompletion {
            content: String::new(),
            tool_calls: vec![tool_call("c1", "search_kb", "alpha")],
            finish_reason: "tool_calls".to_string(),
        },
        stop("done after one tool"),
    ]);
    let mut host = host();
    let mut history = vec![];
    let events = run_agent_turn(&backend, &mut host, "hi", &mut history, &options("s1"))
        .await
        .unwrap();

    let tool_events: Vec<_> = events
        .iter()
        .filter(|e| matches!(e, StreamEvent::Tool { .. }))
        .collect();
    assert!(
        !tool_events.is_empty(),
        "expected Tool lifecycle events: {events:?}"
    );
    assert!(events
        .iter()
        .any(|e| matches!(e, StreamEvent::TextDelta{text} if text == "done after one tool")));

    let calls = recorder.calls();
    assert_eq!(
        calls.len(),
        2,
        "one round to request the tool, one to answer"
    );
    assert!(
        calls[0].tool_names.iter().any(|name| name == "search_kb"),
        "round 1 must have offered search_kb: {:?}",
        calls[0].tool_names
    );
    assert!(
        calls[1].messages.iter().any(|m| m.role == "tool"),
        "round 2's traced messages must include the folded-back tool result: {:?}",
        calls[1].messages
    );
}

#[tokio::test]
async fn multiple_tool_calls_in_one_round_all_dispatch_before_the_next_backend_call() {
    let (backend, recorder) = traced_backend(vec![
        ChatCompletion {
            content: String::new(),
            tool_calls: vec![
                tool_call("c1", "search_kb", "alpha"),
                tool_call("c2", "search_kb", "beta"),
            ],
            finish_reason: "tool_calls".to_string(),
        },
        stop("done after two tools"),
    ]);
    let mut host = host();
    let mut history = vec![];
    let events = run_agent_turn(&backend, &mut host, "hi", &mut history, &options("s2"))
        .await
        .unwrap();

    // `Tool { id }` is a fresh UUID `ToolHost::execute` assigns for UI
    // correlation, not the model's own tool_call id — so distinctness (two
    // different ids), not the exact id values, is what proves two separate
    // dispatches happened rather than one call somehow reused for both.
    let finished_tool_ids: std::collections::BTreeSet<&str> = events
        .iter()
        .filter_map(|e| match e {
            StreamEvent::Tool {
                id,
                name,
                phase: ToolPhase::Finished,
                ok,
                ..
            } if name == "search_kb" && *ok == Some(true) => Some(id.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(
        finished_tool_ids.len(),
        2,
        "both tool calls from the single round must finish, with distinct ids: {events:?}"
    );

    // Exactly two backend calls total: both tools were requested in the same
    // completion, so both dispatch before the second (answering) call — not
    // three calls, which would mean the loop was treating them as separate
    // rounds.
    let calls = recorder.calls();
    assert_eq!(
        calls.len(),
        2,
        "two tools in one completion must not cost an extra round"
    );
    assert_eq!(
        calls[1]
            .messages
            .iter()
            .filter(|m| m.role == "tool")
            .count(),
        2,
        "both tool results must be folded into the next round's messages: {:?}",
        calls[1].messages
    );
}

// ---------------------------------------------------------------------------
// Provider failure
// ---------------------------------------------------------------------------

struct AlwaysFails;

#[async_trait]
impl ChatBackend for AlwaysFails {
    async fn complete(
        &self,
        _messages: &[ChatMessage],
        _tools: &[ToolSpec],
    ) -> CoreResult<ChatCompletion> {
        Err(CoreError::Message(
            "synthetic provider failure, key=sk-shouldneverleak0123456789ABCDEF".into(),
        ))
    }
}

#[tokio::test]
async fn a_failing_backend_propagates_the_error_and_still_records_a_redacted_trace() {
    let recorder = Arc::new(RecordingTurnTrace::new());
    let sink: Arc<dyn TurnTraceSink> = recorder.clone();
    let backend = TracingChatBackend::new(Box::new(AlwaysFails), sink);
    let mut host = host();
    let mut history = vec![];
    let result = run_agent_turn(&backend, &mut host, "hi", &mut history, &options("s3")).await;
    assert!(
        result.is_err(),
        "the failure must propagate, not be swallowed"
    );

    let calls = recorder.calls();
    assert_eq!(calls.len(), 1);
    match &calls[0].outcome {
        TracedOutcome::Failed { message } => {
            assert!(
                !message.contains("sk-shouldneverleak"),
                "the recorded failure message leaked a raw secret: {message}"
            );
        }
        other => panic!("expected Failed, got {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// Interrupted streaming
// ---------------------------------------------------------------------------

/// A cancel flag already set before the turn starts must end the turn
/// immediately rather than making the (scripted, would-otherwise-succeed)
/// backend call at all — the same "stop is authoritative" contract
/// `research.rs`'s own tests already prove for provider setup, exercised
/// here through the public agent-loop entry point with a trace sink
/// attached, so the trace/event stream is proven well-formed under
/// interruption too, not just "the turn eventually stops."
#[tokio::test]
async fn a_pre_armed_cancel_flag_stops_the_turn_before_any_backend_call() {
    use std::sync::atomic::AtomicBool;

    let (backend, recorder) = traced_backend(vec![stop("should never be reached")]);
    let mut host = host();
    let mut history = vec![];
    let cancel = Arc::new(AtomicBool::new(true));
    let mut opts = options("s4");
    opts.cancel = Some(cancel);

    let events = run_agent_turn(&backend, &mut host, "hi", &mut history, &opts)
        .await
        .unwrap();

    assert!(
        !events.iter().any(
            |e| matches!(e, StreamEvent::TextDelta { text } if text == "should never be reached")
        ),
        "a pre-cancelled turn must not surface the scripted reply: {events:?}"
    );
    assert!(
        recorder.calls().is_empty(),
        "a pre-cancelled turn must never call the backend at all: {:?}",
        recorder.calls()
    );
}

// ---------------------------------------------------------------------------
// History bounds
// ---------------------------------------------------------------------------

/// A long prior conversation must not balloon the messages actually sent —
/// real context compaction must run, not merely `turn_trace`'s own capture
/// cap (`MAX_TRACED_MESSAGES = 50`) coincidentally hiding an unbounded send.
/// Asserts well under that cap so a regression that only re-introduced *some*
/// growth (say, to 45 messages) would still be caught.
#[tokio::test]
async fn a_long_prior_history_is_compacted_before_the_real_backend_call() {
    let (backend, recorder) = traced_backend(vec![stop("fine")]);
    let mut host = host();
    let mut history: Vec<ChatMessage> = (0..200)
        .map(|i| ChatMessage {
            role: if i % 2 == 0 {
                Role::User
            } else {
                Role::Assistant
            },
            content: format!("message number {i}"),
            tool_call_id: None,
            tool_calls: None,
        })
        .collect();
    let before = history.len();

    run_agent_turn(
        &backend,
        &mut host,
        "the actual new question",
        &mut history,
        &options("s5"),
    )
    .await
    .unwrap();

    assert_eq!(before, 200, "sanity: the seeded history really was long");
    let calls = recorder.calls();
    assert_eq!(calls.len(), 1);
    assert!(
        calls[0].messages.len() < 30,
        "200 prior messages must be compacted well below turn_trace's own 50-message \
         capture cap, not merely hidden by it: sent {} messages",
        calls[0].messages.len()
    );
    assert!(
        calls[0]
            .messages
            .iter()
            .any(|m| m.content.contains("the actual new question")),
        "the new turn itself must still be present after compaction: {:?}",
        calls[0].messages
    );
}

// ---------------------------------------------------------------------------
// Secret leakage through the real loop (tool result content, not just a
// hand-built message — see turn_trace.rs's own unit tests for the isolated
// wrapper case)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_secret_shaped_user_message_never_reaches_the_trace_unredacted() {
    let (backend, recorder) = traced_backend(vec![stop("acknowledged")]);
    let mut host = host();
    let mut history = vec![];
    let secret = "sk-liveSecretShapedTokenABCDEFGHIJKLMNOP01234";
    let question = format!("here is my key: {secret}");

    run_agent_turn(&backend, &mut host, &question, &mut history, &options("s6"))
        .await
        .unwrap();

    let calls = recorder.calls();
    for message in &calls[0].messages {
        assert!(
            !message.content.contains(secret),
            "a raw secret survived into the trace: {}",
            message.content
        );
    }
}
