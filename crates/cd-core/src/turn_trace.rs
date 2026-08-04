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

/// Most characters retained for a single metadata field (`label`,
/// `provider`, `model`, `tool_name`, `status`, one offered-tool name) at the
/// sink boundary — enforced regardless of how a caller built its draft.
pub const MAX_DEVELOPER_FIELD_CHARS: usize = 200;

/// Most offered tool names retained per developer-detail event.
pub const MAX_DEVELOPER_OFFERED_TOOLS: usize = MAX_TRACED_TOOL_NAMES;

/// Most request/argument payloads retained per developer-detail event.
pub const MAX_DEVELOPER_REQUEST_ITEMS: usize = 20;

/// Maximum approximate UTF-8 bytes retained for one developer-detail event
/// (label + fields + offered tools + request payloads + response), enforced
/// at the sink boundary regardless of how large a caller's draft was.
pub const MAX_DEVELOPER_EVENT_BYTES: usize = 64 * 1024;

/// Maximum approximate UTF-8 bytes retained for one turn's developer-detail
/// events in the process-lifetime store.
pub const MAX_DEVELOPER_TURN_BYTES: usize = 512 * 1024;

/// Maximum approximate UTF-8 bytes retained across the whole process-lifetime
/// developer-detail store (every turn, every session).
pub const MAX_DEVELOPER_STORE_BYTES: usize = 8 * 1024 * 1024;

/// Deepest structured-JSON level inspected before bounding a raw value.
/// Applied BEFORE redaction/serialization so an adversarial or accidental
/// deeply-nested value cannot cost more than this many recursion levels.
const MAX_JSON_DEPTH: usize = 8;

/// Most object entries / array items kept from a single JSON level.
const MAX_JSON_ITEMS_PER_LEVEL: usize = 100;

/// Total JSON nodes (objects, arrays, and scalars) inspected across one
/// value, regardless of shape. This is the real backstop against a
/// pathologically wide-and-deep value: per-level and per-depth limits alone
/// can still multiply out to a huge node count, so a shared budget is
/// decremented on every recursive step and traversal stops the instant it
/// hits zero.
const MAX_JSON_NODES: usize = 2_000;

/// Most characters kept from one JSON string leaf before it is even handed
/// to redaction/serialization.
const MAX_JSON_STRING_CHARS: usize = 2_000;

/// Most characters kept from one JSON object key before it is even handed
/// to redaction/serialization or used to index the bounded output map.
const MAX_JSON_KEY_CHARS: usize = 200;

/// Most characters retained for a `DeveloperDetailStore` key component
/// (`session_id`/`message_id`), enforced uniformly by every entry point
/// (`insert`/`get`/`forget_session`) so a caller cannot bypass
/// [`MAX_DEVELOPER_STORE_BYTES`] by handing the public API an oversized id,
/// and so the same id always maps to the same bounded key.
const MAX_DEVELOPER_KEY_CHARS: usize = 256;

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
    ///
    /// Bounding happens in a specific order for a reason: depth, item-count,
    /// and string-length limits are applied to the raw/structured `value`
    /// FIRST (via [`bound_json_value`]), and only the already-bounded result
    /// is redacted, pretty-printed, and byte-capped. Redacting or
    /// `to_string_pretty`-ing an unbounded value before any size check would
    /// let an arbitrarily deep or large JSON payload (adversarial or just a
    /// large tool result) burn unbounded memory/CPU before the byte cap ever
    /// gets a chance to matter.
    pub fn json(value: &serde_json::Value) -> Self {
        let bounded = bound_json_value(value);
        let redacted = redact_developer_json(&bounded);
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

/// Bound a raw/structured JSON value BEFORE it is redacted or serialized.
///
/// Applies three limits at once, in a single traversal driven by one shared
/// node budget (see [`MAX_JSON_NODES`]): a depth ceiling
/// ([`MAX_JSON_DEPTH`]), a per-level item-count ceiling
/// ([`MAX_JSON_ITEMS_PER_LEVEL`]), and a per-string character ceiling
/// ([`MAX_JSON_STRING_CHARS`]). The per-level cap alone cannot bound total
/// work — a wide value at every one of [`MAX_JSON_DEPTH`] levels can still
/// multiply out to an enormous node count — so the shared budget is the real
/// backstop and traversal stops the instant it is exhausted.
///
/// Every omission is left as a visible marker (`__omitted_fields__`, an
/// `"[N item(s) omitted]"` array entry, a depth placeholder, or a truncated
/// string) rather than silently dropped, so a caller inspecting the bounded
/// value cannot mistake it for the complete one.
fn bound_json_value(value: &serde_json::Value) -> serde_json::Value {
    let mut budget = MAX_JSON_NODES;
    bound_json_value_inner(value, 0, &mut budget)
}

fn bound_json_value_inner(
    value: &serde_json::Value,
    depth: usize,
    budget: &mut usize,
) -> serde_json::Value {
    if *budget == 0 {
        return serde_json::Value::String("[omitted: size budget exceeded]".to_string());
    }
    *budget -= 1;
    if depth >= MAX_JSON_DEPTH {
        return serde_json::Value::String("[omitted: max depth exceeded]".to_string());
    }
    match value {
        serde_json::Value::Object(map) => {
            let mut out = serde_json::Map::new();
            let mut omitted = 0usize;
            for (index, (key, item)) in map.iter().enumerate() {
                if index >= MAX_JSON_ITEMS_PER_LEVEL || *budget == 0 {
                    omitted += map.len() - index;
                    break;
                }
                // Bound the key itself before it is ever cloned/allocated at
                // full size: `bound_json_key` takes a bounded prefix
                // straight off `key`, so a pathologically long key never
                // costs an allocation proportional to its real length.
                let bounded_key = unique_bounded_key(&out, bound_json_key(key));
                out.insert(bounded_key, bound_json_value_inner(item, depth + 1, budget));
            }
            if omitted > 0 {
                out.insert(
                    "__omitted_fields__".to_string(),
                    serde_json::Value::String(format!("{omitted} field(s) omitted")),
                );
            }
            serde_json::Value::Object(out)
        }
        serde_json::Value::Array(values) => {
            let mut out = Vec::new();
            let mut omitted = 0usize;
            for (index, item) in values.iter().enumerate() {
                if index >= MAX_JSON_ITEMS_PER_LEVEL || *budget == 0 {
                    omitted += values.len() - index;
                    break;
                }
                out.push(bound_json_value_inner(item, depth + 1, budget));
            }
            if omitted > 0 {
                out.push(serde_json::Value::String(format!(
                    "[{omitted} item(s) omitted]"
                )));
            }
            serde_json::Value::Array(out)
        }
        serde_json::Value::String(text) => {
            if text.chars().count() > MAX_JSON_STRING_CHARS {
                let mut prefix: String = text.chars().take(MAX_JSON_STRING_CHARS).collect();
                prefix.push_str("…[truncated]");
                serde_json::Value::String(prefix)
            } else {
                serde_json::Value::String(text.clone())
            }
        }
        other => other.clone(),
    }
}

/// Bound one JSON object key to [`MAX_JSON_KEY_CHARS`], taking the prefix
/// directly off `key` rather than cloning the full string first — the
/// allocation this produces is never larger than the bound itself, even for
/// a pathologically long input key.
fn bound_json_key(key: &str) -> String {
    if key.chars().count() > MAX_JSON_KEY_CHARS {
        let mut truncated: String = key.chars().take(MAX_JSON_KEY_CHARS).collect();
        truncated.push_str("…[key truncated]");
        truncated
    } else {
        key.chars().collect()
    }
}

/// Disambiguate `candidate` against `out` deterministically when two
/// distinct raw keys collide after [`bound_json_key`] truncation. Never
/// silently overwrites: the first key to arrive keeps the bounded name, and
/// every later collision gets a visible, deterministic `__dupN` suffix so
/// both values are retained rather than one clobbering the other with no
/// signal.
fn unique_bounded_key(
    out: &serde_json::Map<String, serde_json::Value>,
    candidate: String,
) -> String {
    if !out.contains_key(&candidate) {
        return candidate;
    }
    let mut suffix = 1usize;
    loop {
        let attempt = format!("{candidate}__dup{suffix}");
        if !out.contains_key(&attempt) {
            return attempt;
        }
        suffix += 1;
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
            | "cookies"
            | "credentials"
            | "credential"
            | "clientcredentials"
            | "private"
            | "privatekey"
    ) || normalized.ends_with("token")
        || normalized.ends_with("password")
        || normalized.ends_with("secret")
        || normalized.ends_with("auth")
        || normalized.ends_with("apikey")
        || normalized.ends_with("credentials")
        || normalized.ends_with("credential")
        || normalized.ends_with("privatekey")
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
    /// Offered tool names, capped at [`MAX_DEVELOPER_OFFERED_TOOLS`].
    pub offered_tools: Vec<String>,
    /// How many offered tool names the sink boundary dropped beyond the cap.
    /// Never zero-with-data-loss: a non-zero value here is the visible
    /// signal that names were omitted, not a silent drop.
    #[serde(default)]
    pub offered_tools_omitted: usize,
    /// Redacted request payloads, capped at [`MAX_DEVELOPER_REQUEST_ITEMS`]
    /// (and further trimmed if the event's own byte ceiling requires it).
    pub request: Vec<DeveloperPayload>,
    /// How many request/argument payloads the sink boundary dropped beyond
    /// the cap or the event byte ceiling.
    #[serde(default)]
    pub request_omitted: usize,
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
            .field("request_omitted", &self.request_omitted)
            .field("offered_tools_omitted", &self.offered_tools_omitted)
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
    /// Events the recorder itself never retained because the live
    /// [`MAX_DEVELOPER_EVENTS`] cap was already full. Distinct from
    /// post-store truncation: a store-level "omitted" marker cannot
    /// retroactively account for a call this recorder never observed in the
    /// first place, so this counter is the recorder's own honest tally of
    /// that separate loss point.
    developer_dropped: AtomicUsize,
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
            developer_dropped: AtomicUsize::new(0),
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
            developer_dropped: AtomicUsize::new(0),
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

    /// Exact count of developer-detail events this recorder itself dropped
    /// because [`MAX_DEVELOPER_EVENTS`] was already full when they arrived.
    /// A caller storing [`Self::developer_events`] durably must fold this
    /// into its own omitted-count accounting — it is not visible in the
    /// returned vec at all, since these events were never retained here.
    pub fn developer_dropped(&self) -> usize {
        self.developer_dropped.load(Ordering::SeqCst)
    }
}

impl RecordingTurnTrace {
    fn push_developer(&self, detail: DeveloperDetailDraft) {
        if !self.developer_enabled {
            return;
        }
        let elapsed_ms = u64::try_from(self.started_at.elapsed().as_millis()).unwrap_or(u64::MAX);
        let seq = self.next_seq.fetch_add(1, Ordering::SeqCst);
        // The sink is the trust boundary: bound and redact here, on the
        // actual insert path, so ANY caller of `record_developer` /
        // `record_provider` is covered — not only callers that happened to
        // go through `DeveloperDetailDraft`'s convenience constructors.
        let event = bound_developer_event(seq, Some(elapsed_ms), detail);
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
        } else {
            // Never a silent loss: this event never entered `developer` at
            // all, so no later store-side truncation marker could ever know
            // about it. Track it here, at the exact point it was dropped.
            self.developer_dropped.fetch_add(1, Ordering::SeqCst);
        }
    }
}

/// Reseal one payload at the sink boundary: re-scrub for secrets and
/// re-derive byte bounds from the content actually present, rather than
/// trusting `original_bytes` / `retained_bytes` / `truncated` a caller may
/// have set by hand. [`DeveloperPayload`]'s fields are all `pub` so a caller
/// can construct one directly, bypassing [`DeveloperPayload::text`] /
/// [`DeveloperPayload::json`] entirely; this makes the guarantee a property
/// of the sink, not of caller discipline.
///
/// Idempotent: `crate::redact::scrub_secrets` is idempotent on its own
/// output, and re-bounding an already-bounded string is a no-op, so
/// resealing an honestly-built payload changes nothing.
fn reseal_payload(payload: DeveloperPayload) -> DeveloperPayload {
    let scrubbed = crate::redact::scrub_secrets(&payload.content);
    DeveloperPayload::from_redacted(scrubbed)
}

/// Scrub secrets from, then char-bound, one plain metadata field (`label`,
/// `status`, `provider`, `model`, `tool_name`, one `offered_tools` entry).
///
/// These fields are short labels, not payload bodies, but they are still
/// caller-supplied strings that can carry a literal secret (a tool name
/// templated with an argument, a status string echoing a header) — scrubbing
/// them is exactly as much the sink's job as bounding their length is.
/// Scrub runs before bounding so a secret is never split by the character
/// cut before the scrubber gets a chance to see the whole token.
fn scrub_and_bound_field(value: &str) -> String {
    bound_chars(
        &crate::redact::scrub_secrets(value),
        MAX_DEVELOPER_FIELD_CHARS,
    )
    .0
}

/// Bound and redact one developer-detail draft into the event actually
/// stored — the trust-boundary enforcement point every caller passes
/// through, regardless of how the draft was built.
fn bound_developer_event(
    seq: u64,
    elapsed_ms: Option<u64>,
    detail: DeveloperDetailDraft,
) -> DeveloperDetailEvent {
    let label = scrub_and_bound_field(&detail.label);
    let status = scrub_and_bound_field(&detail.status);
    let provider = detail.provider.as_deref().map(scrub_and_bound_field);
    let model = detail.model.as_deref().map(scrub_and_bound_field);
    let tool_name = detail.tool_name.as_deref().map(scrub_and_bound_field);

    let offered_tools_omitted = detail
        .offered_tools
        .len()
        .saturating_sub(MAX_DEVELOPER_OFFERED_TOOLS);
    let offered_tools: Vec<String> = detail
        .offered_tools
        .iter()
        .take(MAX_DEVELOPER_OFFERED_TOOLS)
        .map(|tool| scrub_and_bound_field(tool))
        .collect();

    let request_omitted_by_count = detail
        .request
        .len()
        .saturating_sub(MAX_DEVELOPER_REQUEST_ITEMS);
    let mut request: Vec<DeveloperPayload> = detail
        .request
        .into_iter()
        .take(MAX_DEVELOPER_REQUEST_ITEMS)
        .map(reseal_payload)
        .collect();
    let response = detail.response.map(reseal_payload);

    // Explicit per-event byte ceiling, enforced last: trim the least
    // important content first (trailing request items) rather than let an
    // oversized draft — however it was built — blow past this event's
    // budget. Every item dropped here is added to the visible
    // `request_omitted` count, never silently discarded.
    let base_bytes = label.len()
        + status.len()
        + provider.as_ref().map_or(0, String::len)
        + model.as_ref().map_or(0, String::len)
        + tool_name.as_ref().map_or(0, String::len)
        + offered_tools.iter().map(String::len).sum::<usize>()
        + response.as_ref().map_or(0, |payload| payload.content.len());
    let mut request_bytes: usize = request.iter().map(|payload| payload.content.len()).sum();
    let mut request_omitted = request_omitted_by_count;
    while base_bytes + request_bytes > MAX_DEVELOPER_EVENT_BYTES && !request.is_empty() {
        if let Some(dropped) = request.pop() {
            request_bytes -= dropped.content.len();
            request_omitted += 1;
        }
    }

    DeveloperDetailEvent {
        seq,
        elapsed_ms,
        kind: detail.kind,
        label,
        provider,
        model,
        round: detail.round,
        tool_name,
        offered_tools,
        offered_tools_omitted,
        request,
        request_omitted,
        response,
        status,
        sensitive: true,
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

/// Bound one session/message id to a fixed-size, collision-safe stand-in.
///
/// An id at or under [`MAX_DEVELOPER_KEY_CHARS`] passes through unchanged
/// (the common case — real ids are short). An id over that bound is NOT
/// simply truncated to its first `N` characters: two different full-length
/// ids that happen to share a long common prefix would then collapse onto
/// the identical bounded key, letting `get`/`insert` resolve the wrong
/// session's sensitive developer detail and letting `forget_session` delete
/// more than the one session it was asked to forget. Instead, an oversized
/// id becomes a short human-legible prefix plus a SHA-256 digest of the
/// FULL raw string, so two distinct full-length ids can only ever collide
/// with cryptographic-hash improbability — never merely from a shared
/// prefix. The raw oversized id itself is never retained, only this bounded
/// form; every entry point (`insert`, `get`, `forget_session`) MUST call
/// this exact function so they never disagree on what a given id maps to.
fn bound_id_component(value: &str) -> String {
    if value.chars().count() <= MAX_DEVELOPER_KEY_CHARS {
        return value.to_string();
    }
    use sha2::{Digest, Sha256};
    let digest_hex = format!("{:x}", Sha256::digest(value.as_bytes()));
    // `#` plus the fixed 64-hex-char digest is always the same length, so
    // the prefix budget is a compile-time-obvious constant subtraction.
    let prefix_budget = MAX_DEVELOPER_KEY_CHARS.saturating_sub(digest_hex.len() + 1);
    let prefix: String = value.chars().take(prefix_budget).collect();
    format!("{prefix}#{digest_hex}")
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct DeveloperTurnKey {
    session_id: String,
    message_id: String,
}

impl DeveloperTurnKey {
    /// The only way a [`DeveloperTurnKey`] gets built. Every id component is
    /// bounded via [`bound_id_component`] here, uniformly, so:
    /// - `insert`/`get`/`forget_session` always agree on the same key for
    ///   the same input, however long that input is;
    /// - a caller cannot bypass [`MAX_DEVELOPER_STORE_BYTES`] by handing the
    ///   public `insert` API an unbounded session/message id — the id itself
    ///   is capped, not merely the event payloads hung off it;
    /// - two DIFFERENT full-length ids can never collide onto the same key
    ///   merely because they share a prefix — see [`bound_id_component`].
    fn bounded(session_id: &str, message_id: &str) -> Self {
        Self {
            session_id: bound_id_component(session_id),
            message_id: bound_id_component(message_id),
        }
    }

    /// Approximate bytes the key itself retains, counted into the store's
    /// byte budget alongside its events so an oversized id cannot be
    /// exempt from [`MAX_DEVELOPER_STORE_BYTES`].
    fn approx_bytes(&self) -> usize {
        self.session_id.len() + self.message_id.len()
    }
}

/// Re-verify one already-emitted event at the store's own insert boundary,
/// so the store enforces its guarantees even for an event that did not pass
/// through [`bound_developer_event`] — every field on [`DeveloperDetailEvent`]
/// is `pub`, so nothing stops a caller from constructing one directly and
/// handing it to [`DeveloperDetailStore::insert`]. Idempotent on an event
/// [`bound_developer_event`] already produced.
fn reseal_event(event: DeveloperDetailEvent) -> DeveloperDetailEvent {
    let label = scrub_and_bound_field(&event.label);
    let status = scrub_and_bound_field(&event.status);
    let provider = event.provider.as_deref().map(scrub_and_bound_field);
    let model = event.model.as_deref().map(scrub_and_bound_field);
    let tool_name = event.tool_name.as_deref().map(scrub_and_bound_field);

    let extra_tools_omitted = event
        .offered_tools
        .len()
        .saturating_sub(MAX_DEVELOPER_OFFERED_TOOLS);
    let offered_tools: Vec<String> = event
        .offered_tools
        .into_iter()
        .take(MAX_DEVELOPER_OFFERED_TOOLS)
        .map(|tool| scrub_and_bound_field(&tool))
        .collect();

    let extra_request_omitted = event
        .request
        .len()
        .saturating_sub(MAX_DEVELOPER_REQUEST_ITEMS);
    let mut request: Vec<DeveloperPayload> = event
        .request
        .into_iter()
        .take(MAX_DEVELOPER_REQUEST_ITEMS)
        .map(reseal_payload)
        .collect();
    let response = event.response.map(reseal_payload);

    let base_bytes = label.len()
        + status.len()
        + provider.as_ref().map_or(0, String::len)
        + model.as_ref().map_or(0, String::len)
        + tool_name.as_ref().map_or(0, String::len)
        + offered_tools.iter().map(String::len).sum::<usize>()
        + response.as_ref().map_or(0, |payload| payload.content.len());
    let mut request_bytes: usize = request.iter().map(|payload| payload.content.len()).sum();
    let mut dropped_for_event_bytes = 0usize;
    while base_bytes + request_bytes > MAX_DEVELOPER_EVENT_BYTES && !request.is_empty() {
        if let Some(dropped) = request.pop() {
            request_bytes -= dropped.content.len();
            dropped_for_event_bytes += 1;
        }
    }

    DeveloperDetailEvent {
        seq: event.seq,
        elapsed_ms: event.elapsed_ms,
        kind: event.kind,
        label,
        provider,
        model,
        round: event.round,
        tool_name,
        offered_tools,
        offered_tools_omitted: event.offered_tools_omitted + extra_tools_omitted,
        request,
        request_omitted: event.request_omitted + extra_request_omitted + dropped_for_event_bytes,
        response,
        status,
        sensitive: event.sensitive,
    }
}

/// Approximate retained bytes for one event: every field a reader can
/// actually see, summed. Used to enforce the per-turn and whole-store byte
/// ceilings; deliberately approximate (no struct/enum tag overhead) since
/// the goal is a budget, not an exact wire size.
fn event_bytes(event: &DeveloperDetailEvent) -> usize {
    event.label.len()
        + event.status.len()
        + event.provider.as_ref().map_or(0, String::len)
        + event.model.as_ref().map_or(0, String::len)
        + event.tool_name.as_ref().map_or(0, String::len)
        + event.offered_tools.iter().map(String::len).sum::<usize>()
        + event
            .request
            .iter()
            .map(|payload| payload.content.len())
            .sum::<usize>()
        + event
            .response
            .as_ref()
            .map_or(0, |payload| payload.content.len())
}

fn omitted_marker_event(next_seq: u64, omitted: usize) -> DeveloperDetailEvent {
    DeveloperDetailEvent {
        seq: next_seq,
        elapsed_ms: None,
        kind: DeveloperDetailKind::DeterministicStage,
        label: format!(
            "{omitted} developer-detail event{} omitted by the per-turn retention bound",
            if omitted == 1 { "" } else { "s" }
        ),
        provider: None,
        model: None,
        round: None,
        tool_name: None,
        offered_tools: Vec::new(),
        offered_tools_omitted: 0,
        request: Vec::new(),
        request_omitted: 0,
        response: None,
        status: "omitted".to_string(),
        sensitive: true,
    }
}

/// Bounded, process-local developer payload store. It has deliberately no
/// serialization or filesystem API.
#[derive(Debug, Default)]
pub struct DeveloperDetailStore {
    records: HashMap<DeveloperTurnKey, Vec<DeveloperDetailEvent>>,
    /// Approximate retained bytes per key, kept in lockstep with `records`
    /// so `total_bytes` can be adjusted in O(1) on insert/replace/evict
    /// instead of re-summing the whole store.
    bytes: HashMap<DeveloperTurnKey, usize>,
    order: VecDeque<DeveloperTurnKey>,
    /// Sum of `bytes.values()`. Enforces [`MAX_DEVELOPER_STORE_BYTES`]
    /// across the whole process-lifetime store, not just a turn count.
    total_bytes: usize,
}

impl DeveloperDetailStore {
    /// Insert or replace one exact session/message record.
    ///
    /// This is the store's own trust boundary: every event is resealed
    /// ([`reseal_event`]) regardless of how it arrived, the key itself is
    /// bounded ([`DeveloperTurnKey::bounded`]) and its bytes counted into the
    /// store budget so an oversized session/message id cannot bypass it, the
    /// turn is trimmed to its own byte budget ([`MAX_DEVELOPER_TURN_BYTES`])
    /// in addition to the existing event-count cap, and the whole store is
    /// trimmed to its process-lifetime byte budget
    /// ([`MAX_DEVELOPER_STORE_BYTES`]) in addition to the existing turn-count
    /// cap. Every omission — by count or by bytes — is left as a visible
    /// marker event, never a silent drop.
    ///
    /// `recorder_dropped` is the exact count of events the *recorder* itself
    /// never retained (see [`RecordingTurnTrace::developer_dropped`]) —
    /// distinct from anything truncated here, since those events never
    /// reached this call at all. It is folded into the same omitted-count
    /// marker so a reader sees one honest total rather than a store-only
    /// count that undercounts the real loss.
    pub fn insert(
        &mut self,
        session_id: &str,
        message_id: &str,
        events: Vec<DeveloperDetailEvent>,
        recorder_dropped: usize,
    ) {
        let mut events: Vec<DeveloperDetailEvent> = events.into_iter().map(reseal_event).collect();
        let count_before = events.len();
        events.truncate(MAX_DEVELOPER_EVENTS);
        let mut omitted = recorder_dropped + count_before.saturating_sub(events.len());

        let mut turn_bytes: usize = events.iter().map(event_bytes).sum();
        while turn_bytes > MAX_DEVELOPER_TURN_BYTES && !events.is_empty() {
            if let Some(dropped) = events.pop() {
                turn_bytes = turn_bytes.saturating_sub(event_bytes(&dropped));
                omitted += 1;
            }
        }

        if omitted > 0 {
            let marker_seq = events.last().map_or(0, |event| event.seq + 1);
            let marker = omitted_marker_event(marker_seq, omitted);
            turn_bytes += event_bytes(&marker);
            events.push(marker);
        }

        let key = DeveloperTurnKey::bounded(session_id, message_id);
        turn_bytes += key.approx_bytes();
        if let Some(previous_bytes) = self.bytes.remove(&key) {
            self.total_bytes = self.total_bytes.saturating_sub(previous_bytes);
        }
        if !self.records.contains_key(&key) {
            self.order.push_back(key.clone());
        }
        self.records.insert(key.clone(), events);
        self.bytes.insert(key.clone(), turn_bytes);
        self.total_bytes = self.total_bytes.saturating_add(turn_bytes);

        while self.records.len() > MAX_DEVELOPER_TURNS
            || self.total_bytes > MAX_DEVELOPER_STORE_BYTES
        {
            let Some(oldest) = self.order.pop_front() else {
                break;
            };
            if oldest == key {
                // The turn just inserted is itself the only one left and
                // still over budget alone — nothing older to evict.
                self.order.push_back(oldest);
                break;
            }
            self.records.remove(&oldest);
            if let Some(oldest_bytes) = self.bytes.remove(&oldest) {
                self.total_bytes = self.total_bytes.saturating_sub(oldest_bytes);
            }
        }
    }

    /// Read one exact session/message record. Cross-session lookup cannot
    /// alias because both identities are part of the key, and both are
    /// bounded exactly as `insert` bounds them so the same input always
    /// resolves to the same record regardless of its raw length.
    pub fn get(&self, session_id: &str, message_id: &str) -> Option<&[DeveloperDetailEvent]> {
        self.records
            .get(&DeveloperTurnKey::bounded(session_id, message_id))
            .map(Vec::as_slice)
    }

    /// Delete every sensitive developer record for one chat session.
    ///
    /// Uses the IDENTICAL [`bound_id_component`] transform `insert`/`get`
    /// use, so this can never diverge into deleting the wrong (or an
    /// additional, aliased) session's records.
    pub fn forget_session(&mut self, session_id: &str) {
        let bounded_session_id = bound_id_component(session_id);
        let freed: usize = self
            .bytes
            .iter()
            .filter(|(key, _)| key.session_id == bounded_session_id)
            .map(|(_, bytes)| *bytes)
            .sum();
        self.total_bytes = self.total_bytes.saturating_sub(freed);
        self.bytes
            .retain(|key, _| key.session_id != bounded_session_id);
        self.records
            .retain(|key, _| key.session_id != bounded_session_id);
        self.order
            .retain(|key| key.session_id != bounded_session_id);
    }

    /// Approximate total bytes currently retained across every turn,
    /// including key bytes — the exact quantity [`MAX_DEVELOPER_STORE_BYTES`]
    /// bounds. Read-only observability, primarily for tests that need to
    /// prove the whole-store byte budget is actually enforced rather than
    /// merely declared.
    pub fn approx_retained_bytes(&self) -> usize {
        self.total_bytes
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
        // Many distinct array entries, each individually under
        // MAX_JSON_STRING_CHARS (so the depth-first per-string bounding in
        // `bound_json_value` does not itself cut any single one of them),
        // but whose combined pretty-printed size still exceeds
        // MAX_DEVELOPER_PAYLOAD_BYTES — so this exercises the FINAL byte cap
        // in `DeveloperPayload::from_redacted`, not the earlier per-string one.
        let long_items: Vec<String> = (0..20)
            .map(|i| format!("chunk-{i}-{}", "x".repeat(1_800)))
            .collect();
        let payload = DeveloperPayload::json(&serde_json::json!({
            "Authorization": "Bearer top-secret-value",
            "nested": {
                "api_key": "sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD",
                "password": "hunter2",
                "ordinary": "visible"
            },
            "long": long_items,
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
            offered_tools_omitted: 0,
            request: Vec::new(),
            request_omitted: 0,
            response: Some(DeveloperPayload::text("bounded result")),
            status: "ok".into(),
            sensitive: true,
        };
        let mut store = DeveloperDetailStore::default();
        store.insert("session-a", "same-message", vec![event], 0);
        assert!(store.get("session-a", "same-message").is_some());
        assert!(store.get("session-b", "same-message").is_none());
        store.forget_session("session-a");
        assert!(store.get("session-a", "same-message").is_none());
    }

    // -- is_secret_field: header/secret key coverage (Blocker 2) ----------

    #[test]
    fn is_secret_field_redacts_x_api_key_in_every_case_and_separator_variant() {
        for key in [
            "X-API-Key",
            "x-api-key",
            "X_API_KEY",
            "x_api_key",
            "api.key",
            "api_key",
            "apikey",
            "Api-Key",
            "APIKEY",
        ] {
            assert!(
                is_secret_field(key),
                "expected {key} to be treated as secret"
            );
        }
    }

    #[test]
    fn is_secret_field_redacts_credentials_private_and_cookie_variants() {
        for key in [
            "credentials",
            "credential",
            "client_credentials",
            "client credentials",
            "clientCredentials",
            "private",
            "private-key",
            "private_key",
            "cookie",
            "cookies",
            "Cookie",
        ] {
            assert!(
                is_secret_field(key),
                "expected {key} to be treated as secret"
            );
        }
    }

    #[test]
    fn is_secret_field_redacts_generic_auth_token_password_suffixes() {
        // Suffix match: these are not literal "auth"/"token"/"password" but
        // END with them, so a header/body key templated with a prefix
        // (`session_`, `refresh_`, `db_`, `oauth-`) must still redact.
        for key in [
            "session_token",
            "refresh_token",
            "db_password",
            "oauth-auth",
            "user_auth",
            "basic_auth",
        ] {
            assert!(
                is_secret_field(key),
                "expected {key} to be treated as secret"
            );
        }
    }

    #[test]
    fn is_secret_field_redacts_mixed_case_and_low_entropy_adversarial_keys() {
        for key in ["Authorization", "AUTHTOKEN", "AuthToken", "PassWord"] {
            assert!(
                is_secret_field(key),
                "expected {key} to be treated as secret"
            );
        }
    }

    #[test]
    fn is_secret_field_does_not_redact_near_miss_non_sensitive_keys() {
        // Precision matters in both directions: these sound related to a
        // sensitive term but are not one, by exact match or by suffix.
        for key in [
            "author",
            "authority",
            "path",
            "secretary",
            "cookiecutter",
            "tokenizer",
            "privateer",
            "creditscore",
            "message",
            "label",
            "status",
        ] {
            assert!(
                !is_secret_field(key),
                "expected {key} to NOT be treated as secret (false positive)"
            );
        }
    }

    fn bare_event(seq: u64, label: &str) -> DeveloperDetailEvent {
        DeveloperDetailEvent {
            seq,
            elapsed_ms: None,
            kind: DeveloperDetailKind::ToolResult,
            label: label.to_string(),
            provider: None,
            model: None,
            round: None,
            tool_name: None,
            offered_tools: Vec::new(),
            offered_tools_omitted: 0,
            request: Vec::new(),
            request_omitted: 0,
            response: None,
            status: "ok".to_string(),
            sensitive: true,
        }
    }

    fn bare_draft(label: &str) -> DeveloperDetailDraft {
        DeveloperDetailDraft {
            kind: DeveloperDetailKind::DeterministicStage,
            label: label.to_string(),
            provider: None,
            model: None,
            round: None,
            tool_name: None,
            offered_tools: Vec::new(),
            request: Vec::new(),
            response: None,
            status: "ok".to_string(),
        }
    }

    /// Pull the leading integer out of an omitted-marker label such as
    /// "6 developer-detail events omitted by the per-turn retention bound".
    fn leading_number(label: &str) -> usize {
        label
            .split_whitespace()
            .next()
            .and_then(|token| token.parse::<usize>().ok())
            .unwrap_or_else(|| panic!("expected a leading integer in marker label: {label}"))
    }

    // -- bound_json_value: depth / item-count / key bounding -------------

    #[test]
    fn bound_json_value_depth_limit_replaces_only_the_over_deep_branch() {
        // 20 levels of nested single-key objects — well past MAX_JSON_DEPTH.
        // `level19` wraps `level18` wraps ... wraps `level0` wraps "bottom",
        // so `level19` sits at depth 0 (shallow / outermost) and `level0`
        // sits at depth ~19 (deep / innermost, right next to "bottom").
        let mut value = serde_json::json!("bottom");
        for level in 0..20 {
            value = serde_json::json!({ format!("level{level}"): value });
        }
        let bounded = bound_json_value(&value);
        let rendered = serde_json::to_string(&bounded).unwrap();
        assert!(
            rendered.contains("max depth exceeded"),
            "a value nested past MAX_JSON_DEPTH must be replaced with a visible \
             placeholder, not silently kept or silently dropped: {rendered}"
        );
        // The shallow levels (within budget) must still be genuinely present,
        // proving this is a depth cut, not a wholesale replacement.
        assert!(rendered.contains("level19"), "{rendered}");
        assert!(
            !rendered.contains("level0") && !rendered.contains("bottom"),
            "content past the depth cut must not survive: {rendered}"
        );
    }

    #[test]
    fn bound_json_value_caps_items_per_level_before_final_byte_bounding() {
        // 500 short items — individually tiny, so the *final* byte cap
        // (MAX_DEVELOPER_PAYLOAD_BYTES) alone would not catch this; only an
        // item-count limit applied to the raw value would.
        let items: Vec<serde_json::Value> = (0..500).map(|i| serde_json::json!(i)).collect();
        let value = serde_json::json!(items);
        let bounded = bound_json_value(&value);
        let array = bounded.as_array().expect("array");
        assert!(
            array.len() <= MAX_JSON_ITEMS_PER_LEVEL + 1,
            "500 items must be capped to MAX_JSON_ITEMS_PER_LEVEL plus one \
             omitted-marker entry, not passed through whole: got {} entries",
            array.len()
        );
        let rendered = serde_json::to_string(&bounded).unwrap();
        assert!(
            rendered.contains("item(s) omitted"),
            "dropping items must leave a visible count, not a silent cut: {rendered}"
        );
    }

    #[test]
    fn bound_json_value_bounds_an_oversized_key_without_cloning_it_whole() {
        let huge_key = "k".repeat(50_000);
        let value = serde_json::json!({ huge_key.clone(): "value" });
        let bounded = bound_json_value(&value);
        let map = bounded.as_object().expect("object");
        assert_eq!(map.len(), 1);
        let (stored_key, _) = map.iter().next().expect("one entry");
        assert!(
            stored_key.chars().count() <= MAX_JSON_KEY_CHARS + "…[key truncated]".chars().count(),
            "an oversized key must be bounded, not retained at full length: {} chars",
            stored_key.chars().count()
        );
        assert!(
            !map.contains_key(&huge_key),
            "the raw, unbounded key must not appear verbatim in the output"
        );
    }

    #[test]
    fn bound_json_value_disambiguates_keys_that_collide_after_truncation() {
        // Two distinct keys share an identical MAX_JSON_KEY_CHARS-char
        // prefix, so naively truncating both would collide on the same
        // bounded key — one value silently clobbering the other.
        let shared_prefix = "p".repeat(MAX_JSON_KEY_CHARS);
        let key_a = format!("{shared_prefix}-first-tail");
        let key_b = format!("{shared_prefix}-second-tail");
        let value = serde_json::json!({ key_a: 1, key_b: 2 });
        let bounded = bound_json_value(&value);
        let map = bounded.as_object().expect("object");
        assert_eq!(
            map.len(),
            2,
            "both colliding keys must be retained under distinct bounded \
             names, not overwritten with no signal: {map:?}"
        );
        let values: std::collections::BTreeSet<u64> = map
            .values()
            .map(|v| v.as_u64().expect("numeric value"))
            .collect();
        assert_eq!(
            values,
            std::collections::BTreeSet::from([1, 2]),
            "both original values (1 and 2) must survive the collision: {map:?}"
        );
    }

    // -- sink/store bound field + secret redaction ------------------------

    #[test]
    fn sink_boundary_scrubs_secrets_from_every_metadata_field() {
        let secret = "sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD";
        let sink = RecordingTurnTrace::with_developer_detail(
            Instant::now(),
            Arc::new(|_event: DeveloperDetailEvent| {}),
        );
        let mut draft = bare_draft(&format!("Selected tool: leaked {secret}"));
        draft.status = format!("failed: key={secret}");
        draft.provider = Some(format!("provider-{secret}"));
        draft.model = Some(format!("model-{secret}"));
        draft.tool_name = Some(format!("tool-{secret}"));
        draft.offered_tools = vec![format!("offered-{secret}")];
        sink.record_developer(draft);

        let events = sink.developer_events();
        assert_eq!(events.len(), 1);
        let event = &events[0];
        assert!(!event.label.contains(secret), "label: {}", event.label);
        assert!(!event.status.contains(secret), "status: {}", event.status);
        assert!(
            !event
                .provider
                .as_deref()
                .unwrap_or_default()
                .contains(secret),
            "provider: {:?}",
            event.provider
        );
        assert!(
            !event.model.as_deref().unwrap_or_default().contains(secret),
            "model: {:?}",
            event.model
        );
        assert!(
            !event
                .tool_name
                .as_deref()
                .unwrap_or_default()
                .contains(secret),
            "tool_name: {:?}",
            event.tool_name
        );
        assert!(
            !event.offered_tools.iter().any(|tool| tool.contains(secret)),
            "offered_tools: {:?}",
            event.offered_tools
        );
    }

    #[test]
    fn store_boundary_scrubs_secrets_from_every_metadata_field_on_a_hand_built_event() {
        // Bypasses `bound_developer_event` entirely — every field on
        // `DeveloperDetailEvent` is `pub`, so this simulates a caller handing
        // `DeveloperDetailStore::insert` an event it never bounded/redacted
        // itself. The STORE's own `reseal_event` boundary must still catch it.
        let secret = "sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD";
        let mut event = bare_event(0, &format!("label with {secret}"));
        event.status = format!("status with {secret}");
        event.provider = Some(format!("provider {secret}"));
        event.model = Some(format!("model {secret}"));
        event.tool_name = Some(format!("tool {secret}"));
        event.offered_tools = vec![format!("tool-a {secret}")];

        let mut store = DeveloperDetailStore::default();
        store.insert("session-secret", "message-secret", vec![event], 0);
        let stored = store.get("session-secret", "message-secret").unwrap();
        assert_eq!(stored.len(), 1);
        let stored = &stored[0];
        assert!(!stored.label.contains(secret), "label: {}", stored.label);
        assert!(!stored.status.contains(secret), "status: {}", stored.status);
        assert!(
            !stored
                .provider
                .as_deref()
                .unwrap_or_default()
                .contains(secret),
            "provider: {:?}",
            stored.provider
        );
        assert!(
            !stored.model.as_deref().unwrap_or_default().contains(secret),
            "model: {:?}",
            stored.model
        );
        assert!(
            !stored
                .tool_name
                .as_deref()
                .unwrap_or_default()
                .contains(secret),
            "tool_name: {:?}",
            stored.tool_name
        );
        assert!(
            !stored
                .offered_tools
                .iter()
                .any(|tool| tool.contains(secret)),
            "offered_tools: {:?}",
            stored.offered_tools
        );
    }

    #[test]
    fn sink_boundary_caps_offered_tools_and_request_items_with_visible_omitted_counts() {
        let sink = RecordingTurnTrace::with_developer_detail(
            Instant::now(),
            Arc::new(|_event: DeveloperDetailEvent| {}),
        );
        let mut draft = bare_draft("many-tools");
        draft.offered_tools = (0..500).map(|i| format!("tool-{i}")).collect();
        draft.request = (0..500)
            .map(|i| DeveloperPayload::text(&format!("arg-{i}")))
            .collect();
        sink.record_developer(draft);

        let events = sink.developer_events();
        let event = &events[0];
        assert!(event.offered_tools.len() <= MAX_DEVELOPER_OFFERED_TOOLS);
        assert_eq!(
            event.offered_tools_omitted,
            500 - MAX_DEVELOPER_OFFERED_TOOLS
        );
        assert!(event.request.len() <= MAX_DEVELOPER_REQUEST_ITEMS);
        assert_eq!(event.request_omitted, 500 - MAX_DEVELOPER_REQUEST_ITEMS);
    }

    // -- recorder-side dropped-event counter (distinct from store trimming)

    #[test]
    fn recorder_drops_events_past_its_own_cap_and_discloses_the_exact_count() {
        let sink = RecordingTurnTrace::with_developer_detail(
            Instant::now(),
            Arc::new(|_event: DeveloperDetailEvent| {}),
        );
        let pushed = MAX_DEVELOPER_EVENTS + 4;
        for i in 0..pushed {
            sink.record_developer(bare_draft(&format!("event-{i}")));
        }
        assert_eq!(sink.developer_events().len(), MAX_DEVELOPER_EVENTS);
        assert_eq!(
            sink.developer_dropped(),
            4,
            "the recorder must disclose the EXACT number of events it never \
             retained, not just events the store later truncates"
        );

        // The one production caller folds this into the store's own
        // omitted-count marker so a reader sees one honest total.
        let events = sink.developer_events();
        let mut store = DeveloperDetailStore::default();
        store.insert("session-a", "message-a", events, sink.developer_dropped());
        let stored = store.get("session-a", "message-a").unwrap();
        let marker = stored.last().expect("marker event present");
        assert_eq!(marker.status, "omitted");
        assert_eq!(
            leading_number(&marker.label),
            4,
            "store-level marker must disclose the recorder-dropped count even \
             though the store itself never truncated anything by count or bytes: {}",
            marker.label
        );
    }

    // -- store-level per-turn and whole-store byte ceilings ---------------

    #[test]
    fn store_trims_a_turn_to_its_own_byte_budget_and_discloses_the_exact_count() {
        let response_bytes = 7_000usize;
        let total_events = 80usize;
        let events: Vec<DeveloperDetailEvent> = (0..total_events)
            .map(|i| {
                let mut event = bare_event(i as u64, "L");
                event.response = Some(DeveloperPayload::text(&"x".repeat(response_bytes)));
                event
            })
            .collect();

        let mut store = DeveloperDetailStore::default();
        store.insert("session-turn-budget", "message-a", events, 0);
        let stored = store
            .get("session-turn-budget", "message-a")
            .expect("turn present");

        let (marker, kept) = stored.split_last().expect("at least the marker");
        assert_eq!(
            marker.status, "omitted",
            "trailing event must be the marker"
        );
        let omitted = leading_number(&marker.label);
        assert!(omitted > 0, "the oversized turn must actually be trimmed");
        assert_eq!(
            kept.len() + omitted,
            total_events,
            "kept events plus the disclosed omitted count must equal exactly \
             what was originally recorded — no unaccounted loss"
        );
        let kept_bytes: usize = kept.iter().map(event_bytes).sum();
        assert!(
            kept_bytes <= MAX_DEVELOPER_TURN_BYTES,
            "kept events alone must already fit the per-turn byte budget: {kept_bytes}"
        );
    }

    #[test]
    fn store_evicts_oldest_turns_once_the_whole_store_byte_budget_is_exceeded() {
        // A single event's response is itself capped at
        // MAX_DEVELOPER_PAYLOAD_BYTES (8KB), so a turn this size has to be
        // built from many events rather than one huge one. Each turn packs
        // enough ~8000-byte-response events to sit comfortably under
        // MAX_DEVELOPER_TURN_BYTES (so no per-turn trimming fires) while
        // still being large enough, over many turns, to blow the whole-store
        // budget — isolating the whole-store byte ceiling specifically.
        let response_bytes = 8_000usize;
        let events_per_turn = 60usize; // 60 * 8_000 = 480_000 < MAX_DEVELOPER_TURN_BYTES
        let per_turn_bytes = response_bytes * events_per_turn;
        assert!(per_turn_bytes < MAX_DEVELOPER_TURN_BYTES);
        let turns_needed = MAX_DEVELOPER_STORE_BYTES / per_turn_bytes + 3;

        let mut store = DeveloperDetailStore::default();
        for i in 0..turns_needed {
            let events: Vec<DeveloperDetailEvent> = (0..events_per_turn)
                .map(|seq| {
                    let mut event = bare_event(seq as u64, "L");
                    event.response = Some(DeveloperPayload::text(&"x".repeat(response_bytes)));
                    event
                })
                .collect();
            store.insert("session-store-budget", &format!("message-{i}"), events, 0);
        }

        assert!(
            store.approx_retained_bytes() <= MAX_DEVELOPER_STORE_BYTES,
            "whole-store byte budget must be enforced, not merely declared: {} > {}",
            store.approx_retained_bytes(),
            MAX_DEVELOPER_STORE_BYTES
        );
        assert!(
            store.get("session-store-budget", "message-0").is_none(),
            "the oldest turn must have been evicted to respect the store-wide budget"
        );
        assert!(
            store
                .get(
                    "session-store-budget",
                    &format!("message-{}", turns_needed - 1)
                )
                .is_some(),
            "the newest turn must survive"
        );
    }

    // -- DeveloperTurnKey: session/message id cannot bypass the store cap -

    #[test]
    fn oversized_session_and_message_ids_are_bounded_and_still_counted() {
        let huge_session_id = "s".repeat(200_000);
        let huge_message_id = "m".repeat(200_000);
        let mut store = DeveloperDetailStore::default();
        let before = store.approx_retained_bytes();
        store.insert(
            &huge_session_id,
            &huge_message_id,
            vec![bare_event(0, "L")],
            0,
        );
        let after = store.approx_retained_bytes();

        assert!(
            after > before,
            "an oversized key must still be counted against the store budget, \
             not exempt from it entirely"
        );
        assert!(
            after - before < 10_000,
            "an oversized key must be BOUNDED before counting, not accounted \
             at its full raw length: retained {} bytes for a single tiny event",
            after - before
        );

        // Lookup with the same (huge) ids must still resolve — insert and get
        // bound identically, so the same input always maps to the same key.
        assert!(store.get(&huge_session_id, &huge_message_id).is_some());
    }

    /// Regression for the shared-prefix-truncation bug: two DISTINCT
    /// ~200k-char session ids that share the same first 256+ characters
    /// (differing only in their tail) must NEVER be treated as the same
    /// session. A naive `bound_chars`-only truncation collapses both onto
    /// the identical bounded key — this proves the fix (a full-string
    /// digest, not a prefix) keeps them apart end-to-end: insert, get, AND
    /// forget_session all agree, and forgetting one never touches the other.
    #[test]
    fn oversized_session_ids_sharing_a_long_prefix_never_alias_across_insert_get_and_forget() {
        let shared_prefix = "a".repeat(300_000);
        let session_a = format!("{shared_prefix}-tail-A-only");
        let session_b = format!("{shared_prefix}-tail-B-only");
        assert_ne!(session_a, session_b);
        let shared_probe_len = MAX_DEVELOPER_KEY_CHARS + 50;
        assert_eq!(
            session_a.chars().take(shared_probe_len).collect::<String>(),
            session_b.chars().take(shared_probe_len).collect::<String>(),
            "test setup sanity: the two ids must share more than \
             MAX_DEVELOPER_KEY_CHARS of common prefix"
        );

        let mut event_a = bare_event(0, "record-for-session-A");
        event_a.response = Some(DeveloperPayload::text("session A's sensitive content"));
        let mut event_b = bare_event(0, "record-for-session-B");
        event_b.response = Some(DeveloperPayload::text("session B's sensitive content"));

        let mut store = DeveloperDetailStore::default();
        store.insert(&session_a, "message-1", vec![event_a], 0);
        store.insert(&session_b, "message-1", vec![event_b], 0);

        // 1. Each session's `get` must resolve to ITS OWN record, not the
        // other's — no aliasing from the shared 300k-char prefix.
        let stored_a = store
            .get(&session_a, "message-1")
            .expect("session A record present");
        let stored_b = store
            .get(&session_b, "message-1")
            .expect("session B record present");
        assert_eq!(stored_a[0].label, "record-for-session-A");
        assert_eq!(stored_b[0].label, "record-for-session-B");
        assert_eq!(
            stored_a[0].response.as_ref().unwrap().content,
            "session A's sensitive content"
        );
        assert_eq!(
            stored_b[0].response.as_ref().unwrap().content,
            "session B's sensitive content"
        );

        // 2. Forgetting session A must remove ONLY session A's record —
        // session B's must still be retrievable, byte-for-byte unchanged.
        store.forget_session(&session_a);
        assert!(
            store.get(&session_a, "message-1").is_none(),
            "forgotten session must actually be gone"
        );
        let still_b = store
            .get(&session_b, "message-1")
            .expect("forgetting session A must not remove session B's record");
        assert_eq!(still_b[0].label, "record-for-session-B");
        assert_eq!(
            still_b[0].response.as_ref().unwrap().content,
            "session B's sensitive content"
        );
    }
}
