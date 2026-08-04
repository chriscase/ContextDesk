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
use std::collections::{HashMap, VecDeque};
use std::fmt;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
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

/// Maximum UTF-8 bytes retained for one developer-detail payload.
pub const MAX_DEVELOPER_PAYLOAD_BYTES: usize = 8 * 1024;

/// Maximum developer-detail events retained for one turn.
pub const MAX_DEVELOPER_EVENTS: usize = 256;

/// Maximum process-local developer-detail turns retained by the host.
pub const MAX_DEVELOPER_TURNS: usize = 100;

/// A redacted, byte-bounded payload shown only in explicit developer detail.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeveloperPayload {
    /// Redacted retained prefix.
    pub content: String,
    /// Bytes after redaction but before bounding.
    pub original_bytes: usize,
    /// Bytes actually retained.
    pub retained_bytes: usize,
    /// True when the retained content is only a prefix.
    pub truncated: bool,
}

impl fmt::Debug for DeveloperPayload {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DeveloperPayload")
            .field("original_bytes", &self.original_bytes)
            .field("retained_bytes", &self.retained_bytes)
            .field("truncated", &self.truncated)
            .finish_non_exhaustive()
    }
}

impl DeveloperPayload {
    /// Redact and byte-bound arbitrary text before it can reach a sink.
    pub fn text(value: &str) -> Self {
        let redacted = crate::redact::scrub_secrets(value);
        Self::from_redacted(redacted)
    }

    /// Redact known secret-bearing object fields recursively, then serialize
    /// and byte-bound the result.
    pub fn json(value: &serde_json::Value) -> Self {
        let redacted = redact_developer_json(value);
        let encoded = serde_json::to_string_pretty(&redacted)
            .unwrap_or_else(|_| "[unavailable: JSON serialization failed]".to_string());
        Self::from_redacted(crate::redact::scrub_secrets(&encoded))
    }

    fn from_redacted(value: String) -> Self {
        let original_bytes = value.len();
        let mut end = original_bytes.min(MAX_DEVELOPER_PAYLOAD_BYTES);
        while !value.is_char_boundary(end) {
            end = end.saturating_sub(1);
        }
        let content = value.get(..end).unwrap_or_default().to_string();
        Self {
            retained_bytes: content.len(),
            truncated: end < original_bytes,
            original_bytes,
            content,
        }
    }
}

fn is_secret_field(key: &str) -> bool {
    let normalized = key
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect::<String>();
    matches!(
        normalized.as_str(),
        "authorization"
            | "proxyauthorization"
            | "apikey"
            | "accesstoken"
            | "refreshtoken"
            | "bearertoken"
            | "password"
            | "passwd"
            | "secret"
            | "clientsecret"
            | "cookie"
            | "setcookie"
    ) || normalized.ends_with("token")
        || normalized.ends_with("password")
        || normalized.ends_with("secret")
}

fn redact_developer_json(value: &serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Object(map) => serde_json::Value::Object(
            map.iter()
                .map(|(key, value)| {
                    (
                        key.clone(),
                        if is_secret_field(key) {
                            serde_json::Value::String("[REDACTED]".to_string())
                        } else {
                            redact_developer_json(value)
                        },
                    )
                })
                .collect(),
        ),
        serde_json::Value::Array(values) => {
            serde_json::Value::Array(values.iter().map(redact_developer_json).collect())
        }
        serde_json::Value::String(value) => {
            serde_json::Value::String(crate::redact::scrub_secrets(value))
        }
        other => other.clone(),
    }
}

/// Developer-detail category. Every variant is opt-in and process-local.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeveloperDetailKind {
    /// One completed/failed provider request and response.
    ProviderExchange,
    /// A model-selected tool call before host execution.
    ToolCall,
    /// A host tool result or rejection.
    ToolResult,
    /// A permission gate (the ordinary activity record owns the decision).
    Permission,
    /// A deterministic host phase.
    DeterministicStage,
    /// A cancellation observed by the host.
    Cancellation,
}

/// Safe draft accepted by [`TurnTraceSink`]. Its constructors redact and
/// bound content before a sink can observe it.
#[derive(Clone)]
pub struct DeveloperDetailDraft {
    /// Event category.
    pub kind: DeveloperDetailKind,
    /// Plain metadata label.
    pub label: String,
    /// Provider profile label/id when applicable.
    pub provider: Option<String>,
    /// Model id when applicable.
    pub model: Option<String>,
    /// Zero-based model round when applicable.
    pub round: Option<u32>,
    /// Tool name when applicable.
    pub tool_name: Option<String>,
    /// Offered tool names for a provider exchange.
    pub offered_tools: Vec<String>,
    /// Redacted request messages or arguments.
    pub request: Vec<DeveloperPayload>,
    /// Redacted response/result/error.
    pub response: Option<DeveloperPayload>,
    /// Coarse status label.
    pub status: String,
}

impl fmt::Debug for DeveloperDetailDraft {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DeveloperDetailDraft")
            .field("kind", &self.kind)
            .field("label", &self.label)
            .field("round", &self.round)
            .field("tool_name", &self.tool_name)
            .field("request_payloads", &self.request.len())
            .field("has_response", &self.response.is_some())
            .field("status", &self.status)
            .finish_non_exhaustive()
    }
}

impl DeveloperDetailDraft {
    /// Build a model-selected tool call from already-parsed arguments.
    pub fn tool_call(round: u32, name: &str, arguments: &serde_json::Value) -> Self {
        Self {
            kind: DeveloperDetailKind::ToolCall,
            label: format!("Selected tool: {name}"),
            provider: None,
            model: None,
            round: Some(round),
            tool_name: Some(name.to_string()),
            offered_tools: Vec::new(),
            request: vec![DeveloperPayload::json(arguments)],
            response: None,
            status: "selected".to_string(),
        }
    }

    /// Build a tool result/error from host-returned content.
    pub fn tool_result(round: u32, name: &str, ok: bool, content: &str) -> Self {
        Self {
            kind: DeveloperDetailKind::ToolResult,
            label: format!("Tool result: {name}"),
            provider: None,
            model: None,
            round: Some(round),
            tool_name: Some(name.to_string()),
            offered_tools: Vec::new(),
            request: Vec::new(),
            response: Some(DeveloperPayload::text(content)),
            status: if ok { "ok" } else { "failed" }.to_string(),
        }
    }

    /// Build a deterministic stage with no content payload.
    pub fn stage(label: impl Into<String>, status: impl Into<String>) -> Self {
        Self {
            kind: DeveloperDetailKind::DeterministicStage,
            label: label.into(),
            provider: None,
            model: None,
            round: None,
            tool_name: None,
            offered_tools: Vec::new(),
            request: Vec::new(),
            response: None,
            status: status.into(),
        }
    }
}

/// One sequenced developer-detail event. Payload content is sensitive even
/// after redaction and must be prominently labelled by every renderer.
#[derive(Clone, Serialize, Deserialize)]
pub struct DeveloperDetailEvent {
    /// Monotonic order shared with the ordinary model/host trace.
    pub seq: u64,
    /// Milliseconds from the turn origin; `None` is used when unknown.
    pub elapsed_ms: Option<u64>,
    /// Event category.
    pub kind: DeveloperDetailKind,
    /// Plain metadata label.
    pub label: String,
    /// Provider profile label/id.
    pub provider: Option<String>,
    /// Model id.
    pub model: Option<String>,
    /// Zero-based round.
    pub round: Option<u32>,
    /// Tool name.
    pub tool_name: Option<String>,
    /// Offered tool names.
    pub offered_tools: Vec<String>,
    /// Redacted request payloads.
    pub request: Vec<DeveloperPayload>,
    /// Redacted response/result/error.
    pub response: Option<DeveloperPayload>,
    /// Coarse status.
    pub status: String,
    /// Always true: this surface contains conversation/source content.
    pub sensitive: bool,
}

impl fmt::Debug for DeveloperDetailEvent {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DeveloperDetailEvent")
            .field("seq", &self.seq)
            .field("kind", &self.kind)
            .field("label", &self.label)
            .field("request_payloads", &self.request.len())
            .field("has_response", &self.response.is_some())
            .field("status", &self.status)
            .finish_non_exhaustive()
    }
}

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

/// Metadata-only host event retained beside provider calls so an inspector can
/// preserve the order in which model and host work actually completed.
///
/// Deliberately omits tool arguments/results, permission targets/reasons/
/// previews, search text, and citation display text. The activity capture is
/// an audit index, not a second transcript or source-content store.
#[derive(Debug, Clone)]
pub enum TracedHostEvent {
    /// Tool lifecycle metadata.
    Tool {
        /// Host correlation id.
        id: String,
        /// Registered tool name.
        name: String,
        /// Started or finished.
        phase: crate::events::ToolPhase,
        /// Terminal result when known.
        ok: Option<bool>,
        /// Host-known authority classification.
        kind: crate::activity::ToolActivityKind,
    },
    /// A host permission gate was raised; no human decision has happened yet.
    PermissionRequired {
        /// Pending request correlation id.
        request_id: String,
        /// Registered tool name.
        tool_name: String,
        /// Coarse risk label only; target and preview are omitted.
        risk: String,
        /// Host-known authority classification of the requested action.
        kind: crate::activity::ToolActivityKind,
    },
    /// Count-only retrieval trail observation.
    SearchTrail {
        /// Number of host-reported steps; step text is omitted.
        step_count: usize,
    },
    /// Citation identity without display/source content.
    Citation {
        /// Stable source identifier.
        source_id: String,
    },
}

/// One item on the shared provider/host capture timeline.
#[derive(Debug, Clone)]
pub enum TracedTimelineItem {
    /// A completed or failed provider call.
    ProviderCall(TracedCall),
    /// A metadata-only host observation.
    HostEvent(TracedHostEvent),
}

/// A causally ordered capture item. `elapsed_ms` is measured from the same
/// turn origin for provider and host work; `seq` is authoritative when two
/// observations share a millisecond.
#[derive(Debug, Clone)]
pub struct TracedTimelineEntry {
    /// Monotonic capture order.
    pub seq: u64,
    /// Milliseconds since the shared turn origin.
    pub elapsed_ms: u64,
    /// Provider or host observation.
    pub item: TracedTimelineItem,
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

    /// Whether the caller should construct content-bearing developer detail.
    fn developer_detail_enabled(&self) -> bool {
        false
    }

    /// Record one provider call plus its separately gated safe detail.
    fn record_provider(&self, call: TracedCall, detail: Option<DeveloperDetailDraft>) {
        self.record(call);
        if let Some(detail) = detail {
            self.record_developer(detail);
        }
    }

    /// Record a redacted/bounded developer-detail item.
    fn record_developer(&self, _detail: DeveloperDetailDraft) {}
}

/// Cloneable/debug-safe handle placed in [`crate::agent::AgentOptions`] so
/// the tool loop can contribute to the same opt-in trace.
#[derive(Clone)]
pub struct TurnTraceObserver(Arc<dyn TurnTraceSink>);

impl TurnTraceObserver {
    /// Wrap a shared sink.
    pub fn new(sink: Arc<dyn TurnTraceSink>) -> Self {
        Self(sink)
    }

    /// Whether developer content is explicitly enabled.
    pub fn developer_detail_enabled(&self) -> bool {
        self.0.developer_detail_enabled()
    }

    /// Record one already-redacted/bounded developer item.
    pub fn record_developer(&self, detail: DeveloperDetailDraft) {
        self.0.record_developer(detail);
    }
}

impl fmt::Debug for TurnTraceObserver {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("TurnTraceObserver(..)")
    }
}

/// Discards every call. The default when no `--trace`/dry-run inspection was
/// requested — tracing must cost nothing when it is not asked for.
#[derive(Debug, Clone, Copy, Default)]
pub struct NoopTurnTrace;

impl TurnTraceSink for NoopTurnTrace {
    fn record(&self, _call: TracedCall) {}
}

/// Captures every call in order, for a caller to render or assert on.
pub struct RecordingTurnTrace {
    started_at: Instant,
    next_seq: AtomicU64,
    timeline: Mutex<Vec<TracedTimelineEntry>>,
    developer_enabled: bool,
    developer: Mutex<Vec<DeveloperDetailEvent>>,
    developer_observer: Option<Arc<dyn Fn(DeveloperDetailEvent) + Send + Sync>>,
}

impl fmt::Debug for RecordingTurnTrace {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RecordingTurnTrace")
            .field("developer_enabled", &self.developer_enabled)
            .finish_non_exhaustive()
    }
}

impl Default for RecordingTurnTrace {
    fn default() -> Self {
        Self::new()
    }
}

impl RecordingTurnTrace {
    /// New, empty recorder.
    pub fn new() -> Self {
        Self::with_started_at(Instant::now())
    }

    /// Start capture against a host-supplied turn origin.
    pub fn with_started_at(started_at: Instant) -> Self {
        Self {
            started_at,
            next_seq: AtomicU64::new(0),
            timeline: Mutex::new(Vec::new()),
            developer_enabled: false,
            developer: Mutex::new(Vec::new()),
            developer_observer: None,
        }
    }

    /// Start capture with explicit process-local developer detail.
    pub fn with_developer_detail(
        started_at: Instant,
        observer: Arc<dyn Fn(DeveloperDetailEvent) + Send + Sync>,
    ) -> Self {
        Self {
            started_at,
            next_seq: AtomicU64::new(0),
            timeline: Mutex::new(Vec::new()),
            developer_enabled: true,
            developer: Mutex::new(Vec::new()),
            developer_observer: Some(observer),
        }
    }

    fn push(&self, item: TracedTimelineItem) {
        let elapsed_ms = u64::try_from(self.started_at.elapsed().as_millis()).unwrap_or(u64::MAX);
        let seq = self.next_seq.fetch_add(1, Ordering::SeqCst);
        let mut timeline = self.timeline.lock().expect("turn trace lock");
        timeline.push(TracedTimelineEntry {
            seq,
            elapsed_ms,
            item,
        });
    }

    /// Record the metadata-only subset of a host event at the instant the
    /// live stream observes it.
    pub fn record_host_event(
        &self,
        event: &crate::events::StreamEvent,
        tool_kinds: &std::collections::HashMap<String, crate::activity::ToolActivityKind>,
    ) {
        use crate::events::StreamEvent;
        if self.developer_enabled {
            let detail = match event {
                StreamEvent::TurnPhase { phase } => Some(DeveloperDetailDraft::stage(
                    format!("Host phase: {phase:?}"),
                    "running",
                )),
                StreamEvent::PermissionRequired {
                    tool_name,
                    risk,
                    arguments,
                    ..
                } => Some(DeveloperDetailDraft {
                    kind: DeveloperDetailKind::Permission,
                    label: format!("Permission required: {tool_name}"),
                    provider: None,
                    model: None,
                    round: None,
                    tool_name: Some(tool_name.clone()),
                    offered_tools: Vec::new(),
                    request: vec![DeveloperPayload::json(arguments)],
                    response: None,
                    status: format!("pending ({risk})"),
                }),
                StreamEvent::TurnCompleted { reason }
                    if reason == "cancel" || reason == "cancelled" =>
                {
                    Some(DeveloperDetailDraft {
                        kind: DeveloperDetailKind::Cancellation,
                        label: "Turn cancelled".to_string(),
                        provider: None,
                        model: None,
                        round: None,
                        tool_name: None,
                        offered_tools: Vec::new(),
                        request: Vec::new(),
                        response: None,
                        status: reason.clone(),
                    })
                }
                _ => None,
            };
            if let Some(detail) = detail {
                self.record_developer(detail);
            }
        }
        let item = match event {
            StreamEvent::Tool {
                id,
                name,
                phase,
                ok,
                ..
            } => TracedHostEvent::Tool {
                id: id.clone(),
                name: name.clone(),
                phase: *phase,
                ok: *ok,
                kind: tool_kinds.get(name).copied().unwrap_or_default(),
            },
            StreamEvent::PermissionRequired {
                request_id,
                tool_name,
                risk,
                ..
            } => TracedHostEvent::PermissionRequired {
                request_id: request_id.clone(),
                tool_name: tool_name.clone(),
                risk: risk.clone(),
                kind: tool_kinds.get(tool_name).copied().unwrap_or_default(),
            },
            StreamEvent::SearchTrail { steps } => TracedHostEvent::SearchTrail {
                step_count: steps.len(),
            },
            StreamEvent::Citation { source_id, .. } => TracedHostEvent::Citation {
                source_id: source_id.clone(),
            },
            _ => return,
        };
        self.push(TracedTimelineItem::HostEvent(item));
    }

    /// Snapshot of every call recorded so far, in call order.
    pub fn calls(&self) -> Vec<TracedCall> {
        self.timeline
            .lock()
            .expect("turn trace lock")
            .iter()
            .filter_map(|entry| match &entry.item {
                TracedTimelineItem::ProviderCall(call) => Some(call.clone()),
                TracedTimelineItem::HostEvent(_) => None,
            })
            .collect()
    }

    /// Snapshot of provider and metadata-only host observations in their
    /// actual capture order.
    pub fn timeline(&self) -> Vec<TracedTimelineEntry> {
        let mut timeline = self.timeline.lock().expect("turn trace lock").clone();
        timeline.sort_by_key(|entry| entry.seq);
        timeline
    }

    /// Snapshot of opt-in content-bearing detail, in shared causal order.
    pub fn developer_events(&self) -> Vec<DeveloperDetailEvent> {
        let mut events = self.developer.lock().expect("developer trace lock").clone();
        events.sort_by_key(|event| event.seq);
        events
    }
}

impl RecordingTurnTrace {
    fn push_developer(&self, detail: DeveloperDetailDraft) {
        if !self.developer_enabled {
            return;
        }
        let elapsed_ms = u64::try_from(self.started_at.elapsed().as_millis()).unwrap_or(u64::MAX);
        let event = DeveloperDetailEvent {
            seq: self.next_seq.fetch_add(1, Ordering::SeqCst),
            elapsed_ms: Some(elapsed_ms),
            kind: detail.kind,
            label: detail.label,
            provider: detail.provider,
            model: detail.model,
            round: detail.round,
            tool_name: detail.tool_name,
            offered_tools: detail.offered_tools,
            request: detail.request,
            response: detail.response,
            status: detail.status,
            sensitive: true,
        };
        let retained = {
            let mut events = self.developer.lock().expect("developer trace lock");
            if events.len() >= MAX_DEVELOPER_EVENTS {
                false
            } else {
                events.push(event.clone());
                true
            }
        };
        if retained {
            if let Some(observer) = self.developer_observer.as_ref() {
                observer(event);
            }
        }
    }
}

impl TurnTraceSink for RecordingTurnTrace {
    fn record(&self, call: TracedCall) {
        self.push(TracedTimelineItem::ProviderCall(call));
    }

    fn developer_detail_enabled(&self) -> bool {
        self.developer_enabled
    }

    fn record_provider(&self, call: TracedCall, detail: Option<DeveloperDetailDraft>) {
        self.record(call);
        if let Some(detail) = detail {
            self.push_developer(detail);
        }
    }

    fn record_developer(&self, detail: DeveloperDetailDraft) {
        self.push_developer(detail);
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct DeveloperTurnKey {
    session_id: String,
    message_id: String,
}

/// Bounded, process-local developer payload store. It has deliberately no
/// serialization or filesystem API.
#[derive(Debug, Default)]
pub struct DeveloperDetailStore {
    records: HashMap<DeveloperTurnKey, Vec<DeveloperDetailEvent>>,
    order: VecDeque<DeveloperTurnKey>,
}

impl DeveloperDetailStore {
    /// Insert or replace one exact session/message record.
    pub fn insert(
        &mut self,
        session_id: &str,
        message_id: &str,
        mut events: Vec<DeveloperDetailEvent>,
    ) {
        events.truncate(MAX_DEVELOPER_EVENTS);
        let key = DeveloperTurnKey {
            session_id: session_id.to_string(),
            message_id: message_id.to_string(),
        };
        if !self.records.contains_key(&key) {
            self.order.push_back(key.clone());
        }
        self.records.insert(key, events);
        while self.records.len() > MAX_DEVELOPER_TURNS {
            if let Some(oldest) = self.order.pop_front() {
                self.records.remove(&oldest);
            }
        }
    }

    /// Read one exact session/message record. Cross-session lookup cannot
    /// alias because both identities are part of the key.
    pub fn get(&self, session_id: &str, message_id: &str) -> Option<&[DeveloperDetailEvent]> {
        self.records
            .get(&DeveloperTurnKey {
                session_id: session_id.to_string(),
                message_id: message_id.to_string(),
            })
            .map(Vec::as_slice)
    }

    /// Delete every sensitive developer record for one chat session.
    pub fn forget_session(&mut self, session_id: &str) {
        self.records
            .retain(|key, _| key.session_id.as_str() != session_id);
        self.order
            .retain(|key| key.session_id.as_str() != session_id);
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
    developer_provider: Option<String>,
    developer_model: Option<String>,
}

impl TracingChatBackend {
    /// Wrap `inner`, recording every call into `sink`.
    pub fn new(inner: Box<dyn ChatBackend>, sink: Arc<dyn TurnTraceSink>) -> Self {
        Self {
            inner,
            sink,
            seq: AtomicUsize::new(0),
            developer_provider: None,
            developer_model: None,
        }
    }

    /// Attach provider/model metadata used only by explicit developer detail.
    pub fn with_developer_context(
        mut self,
        provider: impl Into<String>,
        model: impl Into<String>,
    ) -> Self {
        self.developer_provider = Some(provider.into());
        self.developer_model = Some(model.into());
        self
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
        let call = TracedCall {
            seq,
            elapsed_ms,
            tool_names,
            messages: stored_messages,
            context_used_chars,
            messages_capped,
            outcome,
        };
        let developer = self.sink.developer_detail_enabled().then(|| {
            let request = messages
                .iter()
                .take(MAX_TRACED_MESSAGES)
                .map(|message| {
                    DeveloperPayload::json(&serde_json::json!({
                        "role": message.role.as_str(),
                        "content": message.content,
                        "tool_call_id": message.tool_call_id,
                        "tool_calls": message.tool_calls,
                    }))
                })
                .collect();
            let response = match result {
                Ok(completion) => DeveloperPayload::json(&serde_json::json!({
                    "content": completion.content,
                    "tool_calls": completion.tool_calls,
                    "finish_reason": completion.finish_reason,
                })),
                Err(error) => DeveloperPayload::text(&error.to_string()),
            };
            DeveloperDetailDraft {
                kind: DeveloperDetailKind::ProviderExchange,
                label: format!("Model exchange (round {})", seq + 1),
                provider: self.developer_provider.clone(),
                model: self.developer_model.clone(),
                round: Some(u32::try_from(seq).unwrap_or(u32::MAX)),
                tool_name: None,
                offered_tools: call.tool_names.clone(),
                request,
                response: Some(response),
                status: match result {
                    Ok(_) => "completed".to_string(),
                    Err(_) => "failed".to_string(),
                },
            }
        });
        self.sink.record_provider(call, developer);
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
            TracedOutcome::Completed {
                tool_call_count: 0,
                ..
            }
        ));
    }

    #[tokio::test]
    async fn secrets_in_message_content_are_scrubbed_before_recording() {
        let sink = Arc::new(RecordingTurnTrace::new());
        let backend = TracingChatBackend::new(Box::new(DryRunBackend), sink.clone());
        let secret = "sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD";
        backend
            .complete(&[msg(Role::Tool, &format!("leaked key: {secret}"))], &[])
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
        assert!(
            result.is_err(),
            "the underlying failure must still propagate"
        );

        let calls = sink.calls();
        match &calls[0].outcome {
            TracedOutcome::Failed { message } => {
                assert!(!message.contains("sk-realsecretvalue"), "{message}");
            }
            other => panic!("expected Failed, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn developer_detail_is_off_by_default_and_captures_no_payload() {
        let sink = Arc::new(RecordingTurnTrace::new());
        let backend = TracingChatBackend::new(Box::new(DryRunBackend), sink.clone())
            .with_developer_context("provider", "model");
        backend
            .complete(&[msg(Role::User, "private-default-off-sentinel")], &[])
            .await
            .unwrap();
        assert!(sink.developer_events().is_empty());
        assert!(!format!("{sink:?}").contains("private-default-off-sentinel"));
    }

    #[test]
    fn developer_payload_redacts_known_fields_and_reports_byte_truncation() {
        let payload = DeveloperPayload::json(&serde_json::json!({
            "Authorization": "Bearer top-secret-value",
            "nested": {
                "api_key": "sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD",
                "password": "hunter2",
                "ordinary": "visible"
            },
            "long": "x".repeat(MAX_DEVELOPER_PAYLOAD_BYTES * 2),
        }));
        assert!(!payload.content.contains("top-secret-value"));
        assert!(!payload.content.contains("hunter2"));
        assert!(!payload.content.contains("sk-abcdefghijklmnopqrstuvwxyz"));
        assert!(payload.content.contains("[REDACTED]"));
        assert!(payload.truncated);
        assert_eq!(payload.retained_bytes, payload.content.len());
        assert!(payload.retained_bytes <= MAX_DEVELOPER_PAYLOAD_BYTES);
        assert!(payload.original_bytes > payload.retained_bytes);
    }

    #[test]
    fn developer_store_is_exactly_session_scoped_and_forget_clears_it() {
        let event = DeveloperDetailEvent {
            seq: 1,
            elapsed_ms: Some(2),
            kind: DeveloperDetailKind::ToolResult,
            label: "Tool result".into(),
            provider: None,
            model: None,
            round: Some(0),
            tool_name: Some("search_kb".into()),
            offered_tools: Vec::new(),
            request: Vec::new(),
            response: Some(DeveloperPayload::text("bounded result")),
            status: "ok".into(),
            sensitive: true,
        };
        let mut store = DeveloperDetailStore::default();
        store.insert("session-a", "same-message", vec![event]);
        assert!(store.get("session-a", "same-message").is_some());
        assert!(store.get("session-b", "same-message").is_none());
        store.forget_session("session-a");
        assert!(store.get("session-a", "same-message").is_none());
    }
}
