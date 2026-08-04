//! Bounded, redacted capture of what one chat turn actually sends a
//! provider — the shared model behind CLI `chat --dry-run` / `--trace`, and
//! whatever the future Tauri adapter needs for the same inspection.
//!
//! Two pieces, deliberately separate from [`crate::agent`]:
//!
//! - [`DryRunBackend`] is a [`crate::agent::ChatBackend`] that never touches
//!   a socket. It holds no HTTP client, no credentials, and no base URL —
//!   the "no provider request occurs" guarantee is a property of the type,
//!   not of code that remembers to check a flag before sending.
//! - [`TracingChatBackend`] wraps any backend (real or [`DryRunBackend`])
//!   and records one [`TracedCall`] per `complete`/`complete_streaming`
//!   invocation into a [`TurnTraceSink`], then forwards to the wrapped
//!   backend unchanged.
//!
//! Neither type changes how a turn is driven. Both are constructed upstream
//! of [`crate::agent::run_agent_turn_with_sink_and_checkpoint`] and handed
//! to it exactly like any other `&dyn ChatBackend` — the multi-round loop,
//! history bounding, retrieval, and tool-schema assembly in `agent.rs` are
//! unmodified and unaware that tracing is happening.
//!
//! Captured message content is always redacted
//! ([`crate::redact::scrub_secrets`]) and length-bounded before it leaves
//! this module — a [`TurnTraceSink`] never sees the raw bytes a real
//! provider call would have sent. Provider API keys and HTTP headers never
//! reach this boundary at all: [`crate::agent::ChatBackend::complete`]'s
//! signature is `(&[ChatMessage], &[ToolSpec])`, which carries conversation
//! content only, never credentials.

use crate::agent::ChatBackend;
use crate::chat::{ChatCompletion, ChatMessage};
use crate::error::CoreResult;
use crate::tools::ToolSpec;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

/// Most messages captured per call. A turn's real history can run to the
/// model's full context budget (up to 480k characters); a trace exists to be
/// read, not to reproduce that payload byte for byte.
pub const MAX_TRACED_MESSAGES: usize = 50;

/// Most characters captured per message, after redaction.
pub const MAX_TRACED_MESSAGE_CHARS: usize = 4_000;

/// Most tool names captured per call.
pub const MAX_TRACED_TOOL_NAMES: usize = 64;

/// One message as it was actually about to be sent, redacted and bounded.
// `Deserialize`/`Eq` so an activity record that opted into retaining
// bodies can round-trip through durable storage; the trace itself only
// ever writes them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TracedMessage {
    /// `"system" | "user" | "assistant" | "tool"`.
    pub role: String,
    /// Redacted content, capped at [`MAX_TRACED_MESSAGE_CHARS`].
    pub content: String,
    /// Character count of the redacted content *before* capping — lets a
    /// reader tell a short message from a long one that got cut.
    pub char_count: usize,
    /// True when `content` was cut to the cap.
    pub truncated: bool,
}

/// What the backend call actually produced.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum TracedOutcome {
    /// The call returned a completion (whether or not it asked for tools).
    Completed {
        /// Provider/backend finish reason (`stop`, `dry_run`, …).
        finish_reason: String,
        /// How many tool calls the completion carried.
        tool_call_count: usize,
    },
    /// The call failed. `message` is already redacted.
    Failed {
        /// Redacted error text.
        message: String,
    },
}

/// One `complete`/`complete_streaming` invocation, captured whole.
#[derive(Debug, Clone, Serialize)]
pub struct TracedCall {
    /// 0-based order this call was made in, within one turn.
    pub seq: usize,
    /// Wall-clock time the call took.
    pub elapsed_ms: u64,
    /// Tool names offered this call (capped at [`MAX_TRACED_TOOL_NAMES`]).
    ///
    /// Names only, never full JSON Schemas — schemas are static and
    /// secret-free, but names are all a trace reader needs to answer "which
    /// tools were even offered this round."
    pub tool_names: Vec<String>,
    /// Messages sent, in order (capped at [`MAX_TRACED_MESSAGES`]).
    pub messages: Vec<TracedMessage>,
    /// Sum of scrubbed character counts across **all** messages offered to
    /// the backend this call — not just the stored (capped) `messages` vec.
    /// Use this for honest `context_used_chars` reporting.
    pub context_used_chars: usize,
    /// True when more messages were sent than [`MAX_TRACED_MESSAGES`], so
    /// `messages` is a prefix of the real request.
    pub messages_capped: bool,
    /// What came back.
    pub outcome: TracedOutcome,
}

/// Receives one [`TracedCall`] per backend invocation.
///
/// Mirrors the existing [`crate::process_progress::ProcessProgressObserver`]
/// shape used throughout ingest: a trait object passed by reference, a
/// no-op default, and a recording implementation for tests and for hosts
/// that want to render the trace afterward rather than streaming it live.
pub trait TurnTraceSink: Send + Sync {
    /// Record one completed (or failed) backend call.
    fn record(&self, call: TracedCall);
}

/// Discards every call. The default when no `--trace`/dry-run inspection was
/// requested — tracing must cost nothing when it is not asked for.
#[derive(Debug, Clone, Copy, Default)]
pub struct NoopTurnTrace;

impl TurnTraceSink for NoopTurnTrace {
    fn record(&self, _call: TracedCall) {}
}

/// Captures every call in order, for a caller to render or assert on.
#[derive(Debug, Default)]
pub struct RecordingTurnTrace {
    calls: Mutex<Vec<TracedCall>>,
}

impl TurnTraceSink for RecordingTurnTrace {
    fn record(&self, call: TracedCall) {
        self.calls.lock().expect("turn trace lock").push(call);
    }
}

impl RecordingTurnTrace {
    /// New, empty recorder.
    pub fn new() -> Self {
        Self::default()
    }

    /// Snapshot of every call recorded so far, in call order.
    pub fn calls(&self) -> Vec<TracedCall> {
        self.calls.lock().expect("turn trace lock").clone()
    }
}

/// A [`ChatBackend`] that never reaches a socket.
///
/// Returns an immediate, empty, successful completion (`finish_reason =
/// "stop"`, no tool calls) — the same shape [`crate::agent`]'s multi-round
/// loop already treats as "the model produced a final answer," which ends
/// the turn after exactly one round. That one round is where every piece of
/// real context assembly (system prompt, bounded history, tool schemas, and
/// — when the caller's turn is corpus-linked — grounded log evidence) is
/// built and handed to this backend, so `chat --dry-run` sees precisely what
/// a real turn would have sent, without ever sending it.
///
/// Holds no HTTP client, no base URL, no credentials — there is nothing in
/// this struct capable of making a network call, by construction rather
/// than by convention.
#[derive(Debug, Clone, Copy, Default)]
pub struct DryRunBackend;

#[async_trait]
impl ChatBackend for DryRunBackend {
    async fn complete(
        &self,
        _messages: &[ChatMessage],
        _tools: &[ToolSpec],
    ) -> CoreResult<ChatCompletion> {
        Ok(ChatCompletion {
            content: String::new(),
            tool_calls: Vec::new(),
            finish_reason: "stop".to_string(),
        })
    }
}

/// Wraps a backend and records one [`TracedCall`] per invocation before
/// forwarding to it. Works over any inner backend — a real provider client
/// (for `--trace` on an ordinary turn) or [`DryRunBackend`] (for
/// `--dry-run`, where the inner call itself is inert).
pub struct TracingChatBackend {
    inner: Box<dyn ChatBackend>,
    sink: Arc<dyn TurnTraceSink>,
    seq: AtomicUsize,
}

impl TracingChatBackend {
    /// Wrap `inner`, recording every call into `sink`.
    pub fn new(inner: Box<dyn ChatBackend>, sink: Arc<dyn TurnTraceSink>) -> Self {
        Self {
            inner,
            sink,
            seq: AtomicUsize::new(0),
        }
    }

    fn record(
        &self,
        started: Instant,
        messages: &[ChatMessage],
        tools: &[ToolSpec],
        result: &CoreResult<ChatCompletion>,
    ) {
        let seq = self.seq.fetch_add(1, Ordering::SeqCst);
        let elapsed_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
        let tool_names = tools
            .iter()
            .take(MAX_TRACED_TOOL_NAMES)
            .map(|tool| tool.name.clone())
            .collect();
        let outcome = match result {
            Ok(completion) => TracedOutcome::Completed {
                finish_reason: completion.finish_reason.clone(),
                tool_call_count: completion.tool_calls.len(),
            },
            Err(error) => TracedOutcome::Failed {
                message: crate::redact::scrub_secrets(&error.to_string()),
            },
        };
        let (stored_messages, context_used_chars, messages_capped) = traced_messages(messages);
        self.sink.record(TracedCall {
            seq,
            elapsed_ms,
            tool_names,
            messages: stored_messages,
            context_used_chars,
            messages_capped,
            outcome,
        });
    }
}

/// Stored message bodies (capped) plus the **full** scrubbed character sum
/// across every input message — so callers reporting `context_used_chars`
/// stay honest when only the first [`MAX_TRACED_MESSAGES`] bodies are retained.
fn traced_messages(messages: &[ChatMessage]) -> (Vec<TracedMessage>, usize, bool) {
    let mut total_chars = 0usize;
    for message in messages {
        let scrubbed = crate::redact::scrub_secrets(&message.content);
        total_chars = total_chars.saturating_add(scrubbed.chars().count());
    }
    let messages_capped = messages.len() > MAX_TRACED_MESSAGES;
    let stored = messages
        .iter()
        .take(MAX_TRACED_MESSAGES)
        .map(|message| {
            let scrubbed = crate::redact::scrub_secrets(&message.content);
            let char_count = scrubbed.chars().count();
            let (content, truncated) = bound_chars(&scrubbed, MAX_TRACED_MESSAGE_CHARS);
            TracedMessage {
                role: message.role.as_str().to_string(),
                content,
                char_count,
                truncated,
            }
        })
        .collect();
    (stored, total_chars, messages_capped)
}

fn bound_chars(text: &str, max_chars: usize) -> (String, bool) {
    if text.chars().count() <= max_chars {
        (text.to_string(), false)
    } else {
        (text.chars().take(max_chars).collect(), true)
    }
}

#[async_trait]
impl ChatBackend for TracingChatBackend {
    async fn complete(
        &self,
        messages: &[ChatMessage],
        tools: &[ToolSpec],
    ) -> CoreResult<ChatCompletion> {
        let started = Instant::now();
        let result = self.inner.complete(messages, tools).await;
        self.record(started, messages, tools, &result);
        result
    }

    async fn complete_streaming(
        &self,
        messages: &[ChatMessage],
        tools: &[ToolSpec],
        on_text: &mut (dyn FnMut(String) + Send),
        cancel: Option<&std::sync::atomic::AtomicBool>,
    ) -> CoreResult<ChatCompletion> {
        let started = Instant::now();
        let result = self
            .inner
            .complete_streaming(messages, tools, on_text, cancel)
            .await;
        self.record(started, messages, tools, &result);
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::Role;
    use crate::tools::ToolSideEffect;

    fn msg(role: Role, content: &str) -> ChatMessage {
        ChatMessage {
            role,
            content: content.to_string(),
            tool_call_id: None,
            tool_calls: None,
        }
    }

    fn spec(name: &str) -> ToolSpec {
        ToolSpec {
            name: name.to_string(),
            description: "d".into(),
            side_effect: ToolSideEffect::Read,
            parameters: serde_json::json!({}),
        }
    }

    #[tokio::test]
    async fn dry_run_backend_completes_immediately_with_no_tool_calls() {
        let backend = DryRunBackend;
        let c = backend
            .complete(&[msg(Role::User, "hi")], &[spec("search_kb")])
            .await
            .unwrap();
        assert_eq!(c.content, "");
        assert!(c.tool_calls.is_empty());
        assert_eq!(c.finish_reason, "stop");
    }

    #[tokio::test]
    async fn tracing_backend_records_one_call_per_invocation() {
        let sink = Arc::new(RecordingTurnTrace::new());
        let backend = TracingChatBackend::new(Box::new(DryRunBackend), sink.clone());
        backend
            .complete(&[msg(Role::User, "hello")], &[spec("search_kb")])
            .await
            .unwrap();
        backend
            .complete(&[msg(Role::User, "hello"), msg(Role::Assistant, "hi")], &[])
            .await
            .unwrap();

        let calls = sink.calls();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].seq, 0);
        assert_eq!(calls[1].seq, 1);
        assert_eq!(calls[0].tool_names, vec!["search_kb".to_string()]);
        assert!(calls[1].tool_names.is_empty());
        assert!(matches!(
            calls[0].outcome,
            TracedOutcome::Completed { tool_call_count: 0, .. }
        ));
    }

    #[tokio::test]
    async fn secrets_in_message_content_are_scrubbed_before_recording() {
        let sink = Arc::new(RecordingTurnTrace::new());
        let backend = TracingChatBackend::new(Box::new(DryRunBackend), sink.clone());
        let secret = "sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD";
        backend
            .complete(
                &[msg(Role::Tool, &format!("leaked key: {secret}"))],
                &[],
            )
            .await
            .unwrap();

        let calls = sink.calls();
        let traced = &calls[0].messages[0];
        assert!(
            !traced.content.contains(secret),
            "raw secret survived redaction: {}",
            traced.content
        );
    }

    #[tokio::test]
    async fn oversized_message_and_tool_lists_are_bounded() {
        let sink = Arc::new(RecordingTurnTrace::new());
        let backend = TracingChatBackend::new(Box::new(DryRunBackend), sink.clone());

        let long = "x".repeat(MAX_TRACED_MESSAGE_CHARS * 3);
        let many_messages: Vec<ChatMessage> = (0..(MAX_TRACED_MESSAGES * 2))
            .map(|i| msg(Role::User, &format!("m{i}")))
            .chain(std::iter::once(msg(Role::User, &long)))
            .collect();
        let many_tools: Vec<ToolSpec> = (0..(MAX_TRACED_TOOL_NAMES * 2))
            .map(|i| spec(&format!("tool_{i}")))
            .collect();

        backend.complete(&many_messages, &many_tools).await.unwrap();

        let calls = sink.calls();
        let call = &calls[0];
        assert!(call.messages.len() <= MAX_TRACED_MESSAGES);
        assert!(call.tool_names.len() <= MAX_TRACED_TOOL_NAMES);
        assert!(
            call.messages_capped,
            "more messages were sent than stored — messages_capped must be true"
        );
        // Strictly greater, not merely >=: this request sent more messages
        // than storage retains, so a `context_used_chars` that only summed
        // the stored prefix would under-report how much context actually
        // went to the provider. `>=` would pass even for that bug.
        let stored_sum: usize = call.messages.iter().map(|m| m.char_count).sum();
        assert!(
            call.context_used_chars > stored_sum,
            "context_used_chars ({}) must exceed the stored-body sum ({}) when \
             messages were dropped — otherwise it is counting only the prefix",
            call.context_used_chars,
            stored_sum
        );
        assert!(call
            .messages
            .iter()
            .all(|m| m.content.chars().count() <= MAX_TRACED_MESSAGE_CHARS));
    }

    #[tokio::test]
    async fn a_failed_inner_call_is_recorded_and_still_propagated() {
        struct AlwaysFails;
        #[async_trait]
        impl ChatBackend for AlwaysFails {
            async fn complete(
                &self,
                _messages: &[ChatMessage],
                _tools: &[ToolSpec],
            ) -> CoreResult<ChatCompletion> {
                Err(crate::error::CoreError::Message(
                    "provider unreachable, key=sk-realsecretvalue0123456789ABCDEF".into(),
                ))
            }
        }
        let sink = Arc::new(RecordingTurnTrace::new());
        let backend = TracingChatBackend::new(Box::new(AlwaysFails), sink.clone());
        let result = backend.complete(&[msg(Role::User, "hi")], &[]).await;
        assert!(result.is_err(), "the underlying failure must still propagate");

        let calls = sink.calls();
        match &calls[0].outcome {
            TracedOutcome::Failed { message } => {
                assert!(!message.contains("sk-realsecretvalue"), "{message}");
            }
            other => panic!("expected Failed, got {other:?}"),
        }
    }
}
