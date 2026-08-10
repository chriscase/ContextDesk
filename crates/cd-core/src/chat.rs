//! Chat provider clients (OpenAI-compatible, Ollama, Anthropic Messages).

use crate::error::{CoreError, CoreResult};
use crate::ssrf::{build_pinned_client_for_url, SsrfPolicy, SystemResolver};
use crate::tools::ToolSpec;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

// Vercel free-tier throttles may last a full minute. Keep retries bounded to
// one initial request plus two retries while giving that short outage a real
// chance to recover instead of amplifying it with rapid repeat requests.
const OPENAI_COMPATIBLE_MAX_429_RETRIES: u32 = 2;
const OPENAI_COMPATIBLE_RETRY_BASE_DELAY: Duration = Duration::from_secs(30);
const OPENAI_COMPATIBLE_RETRY_MAX_DELAY: Duration = Duration::from_secs(60);
const OPENAI_COMPATIBLE_MAX_RETRY_AFTER: Duration = Duration::from_secs(60);

/// One provider-neutral constructor for "the provider answered a chat or
/// stream request with a non-success HTTP status".
///
/// Every provider client routes its status failure through this so the status
/// travels structurally (see [`CoreError::ProviderHttp`]) instead of only
/// inside prose that each consumer would have to re-parse. The rendered text
/// is identical to the per-client `format!` calls this replaces, so existing
/// message contracts (and the transport oracle that pins them) still hold.
fn provider_http_error(
    operation: &str,
    status: reqwest::StatusCode,
    body: &str,
    body_chars: usize,
) -> CoreError {
    CoreError::ProviderHttp {
        operation: operation.to_string(),
        status: status.as_u16(),
        status_line: status.to_string(),
        body: body.chars().take(body_chars).collect(),
    }
}

fn bounded_openai_retry_after(
    headers: &reqwest::header::HeaderMap,
    retry: u32,
) -> (Duration, &'static str) {
    let fallback = OPENAI_COMPATIBLE_RETRY_BASE_DELAY
        .checked_mul(1u32 << retry.min(3))
        .unwrap_or(OPENAI_COMPATIBLE_RETRY_MAX_DELAY)
        .min(OPENAI_COMPATIBLE_RETRY_MAX_DELAY);
    let Some(value) = headers
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
    else {
        return (fallback, "fallback");
    };
    if let Ok(seconds) = value.parse::<u64>() {
        return (
            Duration::from_secs(seconds).min(OPENAI_COMPATIBLE_MAX_RETRY_AFTER),
            "retry_after",
        );
    }
    let date_delay = DateTime::parse_from_rfc2822(value)
        .ok()
        .and_then(|at| {
            at.with_timezone(&Utc)
                .signed_duration_since(Utc::now())
                .to_std()
                .ok()
        })
        .map(|delay| delay.min(OPENAI_COMPATIBLE_MAX_RETRY_AFTER));
    date_delay
        .map(|delay| (delay, "retry_after"))
        .unwrap_or((fallback, "fallback"))
}

async fn wait_for_openai_429_retry(delay: Duration, cancel: Option<&AtomicBool>) -> CoreResult<()> {
    if cancel
        .map(|flag| flag.load(Ordering::SeqCst))
        .unwrap_or(false)
    {
        return Err(CoreError::Message("cancelled".into()));
    }
    let Some(cancel) = cancel else {
        tokio::time::sleep(delay).await;
        return Ok(());
    };
    tokio::select! {
        _ = tokio::time::sleep(delay) => Ok(()),
        _ = async {
            while !cancel.load(Ordering::SeqCst) {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        } => Err(CoreError::Message("cancelled".into())),
    }
}

/// Chat message role.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    /// System.
    System,
    /// User.
    User,
    /// Assistant.
    Assistant,
    /// Tool result.
    Tool,
}

impl Role {
    /// Stable lowercase wire/trace representation, matching the `serde`
    /// spelling above without requiring a serializer round-trip.
    pub fn as_str(&self) -> &'static str {
        match self {
            Role::System => "system",
            Role::User => "user",
            Role::Assistant => "assistant",
            Role::Tool => "tool",
        }
    }
}

/// One chat message.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    /// Role.
    pub role: Role,
    /// Content.
    pub content: String,
    /// Tool call id when role=tool.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    /// Tool calls from assistant.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCallMsg>>,
}

/// Tool call in assistant message.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCallMsg {
    /// Id.
    pub id: String,
    /// Type (function).
    #[serde(rename = "type")]
    pub kind: String,
    /// Function body.
    pub function: FunctionCall,
}

/// Function name + args JSON string.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FunctionCall {
    /// Name.
    pub name: String,
    /// Arguments JSON string.
    pub arguments: String,
}

/// Result of a chat completion (non-stream or fully accumulated stream).
#[derive(Debug, Clone)]
pub struct ChatCompletion {
    /// Assistant text (may be empty if only tools).
    pub content: String,
    /// Tool calls.
    pub tool_calls: Vec<ToolCallMsg>,
    /// Finish reason.
    pub finish_reason: String,
    /// Authoritative transport telemetry captured from the wire (OpenAI-
    /// compatible body + allowlisted safe headers). Absent fields stay
    /// unknown — never inferred from the configured model.
    pub telemetry: crate::provider_telemetry::ProviderTransportTelemetry,
}

impl ChatCompletion {
    /// Build a completion without transport capture (non-OpenAI backends,
    /// scripted tests). Prefer letting [`OpenAiCompatibleClient`] fill
    /// [`Self::telemetry`] from the wire.
    pub fn from_parts(
        content: impl Into<String>,
        tool_calls: Vec<ToolCallMsg>,
        finish_reason: impl Into<String>,
    ) -> Self {
        Self {
            content: content.into(),
            tool_calls,
            finish_reason: finish_reason.into(),
            telemetry: crate::provider_telemetry::ProviderTransportTelemetry::default(),
        }
    }
}

/// One logical delta from an OpenAI-compatible SSE stream (after `data: ` parse).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StreamDelta {
    /// Incremental assistant text.
    Text(String),
    /// Partial tool call (arguments may be fragmented across deltas).
    ToolCall {
        /// Stream index (OpenAI tool_calls[].index).
        index: usize,
        /// Call id (present on first fragment).
        id: Option<String>,
        /// Function name (present on first fragment).
        name: Option<String>,
        /// Arguments JSON fragment.
        arguments: String,
    },
    /// Multiple tool-call fragments in one SSE event (OpenAI may batch).
    ToolCalls(Vec<StreamDelta>),
    /// Model finished this choice.
    Finish(String),
    /// Stream ended (`data: [DONE]`).
    Done,
}

/// Accumulates SSE deltas into a final [`ChatCompletion`].
#[derive(Debug, Default)]
pub struct StreamAccumulator {
    content: String,
    /// index -> (id, name, arguments buffer)
    tool_parts: std::collections::BTreeMap<usize, (String, String, String)>,
    finish_reason: Option<String>,
    /// True once a `data: [DONE]` sentinel has been observed. Tracked
    /// separately from `finish_reason` because a stream may signal
    /// completion via `[DONE]` alone (see `into_completion`).
    saw_done: bool,
    telemetry: crate::provider_telemetry::ProviderTransportTelemetry,
}

impl StreamAccumulator {
    /// Empty accumulator.
    pub fn new() -> Self {
        Self::default()
    }

    /// Apply one parsed delta.
    pub fn push(&mut self, delta: StreamDelta) {
        match delta {
            StreamDelta::Text(t) => self.content.push_str(&t),
            StreamDelta::ToolCall {
                index,
                id,
                name,
                arguments,
            } => {
                let entry = self
                    .tool_parts
                    .entry(index)
                    .or_insert_with(|| (String::new(), String::new(), String::new()));
                if let Some(i) = id {
                    if !i.is_empty() {
                        entry.0 = i;
                    }
                }
                if let Some(n) = name {
                    if !n.is_empty() {
                        entry.1 = n;
                    }
                }
                entry.2.push_str(&arguments);
            }
            StreamDelta::ToolCalls(parts) => {
                for p in parts {
                    self.push(p);
                }
            }
            StreamDelta::Finish(r) => {
                self.finish_reason = Some(r);
            }
            StreamDelta::Done => {
                self.saw_done = true;
            }
        }
    }

    /// Merge transport telemetry from one SSE payload or header capture.
    pub fn merge_telemetry(
        &mut self,
        patch: &crate::provider_telemetry::ProviderTransportTelemetry,
    ) {
        self.telemetry.merge_from(patch);
    }

    /// Finish into a completion (same shape as non-stream parse).
    ///
    /// Fails closed when the stream ended without ever observing a finish
    /// signal (`finish_reason` on a delta, or `data: [DONE]`). A connection
    /// that closes cleanly mid-answer is a real, observed provider/gateway
    /// failure mode (a crash or timeout on the far side, not a transport
    /// error on this one) and must not be reported as a completed, validated
    /// response with a fabricated finish reason — see
    /// docs/testing/gateway-wire-survivors-and-gaps.md.
    pub fn into_completion(self) -> CoreResult<ChatCompletion> {
        if self.finish_reason.is_none() && !self.saw_done {
            return Err(CoreError::Message(
                "stream ended before a finish_reason or [DONE] was ever received".into(),
            ));
        }
        let mut tool_calls = Vec::new();
        for (_idx, (id, name, arguments)) in self.tool_parts {
            if name.is_empty() && arguments.is_empty() {
                continue;
            }
            tool_calls.push(ToolCallMsg {
                id: if id.is_empty() {
                    format!("call_{}", tool_calls.len())
                } else {
                    id
                },
                kind: "function".into(),
                function: FunctionCall {
                    name,
                    arguments: if arguments.is_empty() {
                        "{}".into()
                    } else {
                        arguments
                    },
                },
            });
        }
        let finish_reason = self.finish_reason.unwrap_or_else(|| {
            if tool_calls.is_empty() {
                "stop".into()
            } else {
                "tool_calls".into()
            }
        });
        Ok(ChatCompletion {
            content: self.content,
            tool_calls,
            finish_reason,
            telemetry: self.telemetry,
        })
    }
}

/// Parse a single SSE `data:` payload (JSON object or `[DONE]`) into every
/// delta it carries, in wire order (content, then tool calls, then a
/// co-occurring finish reason).
///
/// A conformant OpenAI stream never combines these in one event — the final
/// content/tool-call delta and the terminal `finish_reason` normally arrive
/// as separate events. Several standards-adjacent gateways (GPT-OSS, vLLM,
/// Ollama-compatible servers) are not that strict and send the last content
/// fragment, a tool call, and `finish_reason` together in a single choice
/// object. Returning only the Vec's first element (the old contract) would
/// silently drop whichever of those arrived second — content lost behind a
/// tool call, or a `finish_reason` (e.g. `"length"`, `"content_filter"`)
/// lost behind either — so every caller must consume the whole Vec.
pub fn parse_openai_sse_data(data: &str) -> CoreResult<Vec<StreamDelta>> {
    let data = data.trim();
    if data.is_empty() {
        return Ok(Vec::new());
    }
    if data == "[DONE]" {
        return Ok(vec![StreamDelta::Done]);
    }
    let v: Value =
        serde_json::from_str(data).map_err(|e| CoreError::Message(format!("sse json: {e}")))?;
    if let Some(err) = v.get("error") {
        let msg = err
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("stream error");
        return Err(CoreError::Message(msg.into()));
    }
    let choice = v
        .get("choices")
        .and_then(|c| c.as_array())
        .and_then(|a| a.first());
    let Some(choice) = choice else {
        return Ok(Vec::new());
    };
    let mut out = Vec::new();
    if let Some(delta) = choice.get("delta") {
        out.extend(deltas_from_json(delta)?);
    }
    if let Some(fr) = choice
        .get("finish_reason")
        .and_then(|f| f.as_str())
        .filter(|s| !s.is_empty() && *s != "null")
    {
        out.push(StreamDelta::Finish(fr.to_string()));
    }
    Ok(out)
}

fn tool_call_from_json(tc: &Value) -> StreamDelta {
    let index = tc.get("index").and_then(|i| i.as_u64()).unwrap_or(0) as usize;
    let id = tc.get("id").and_then(|x| x.as_str()).map(str::to_string);
    let func = tc.get("function").cloned().unwrap_or(json!({}));
    let name = func
        .get("name")
        .and_then(|x| x.as_str())
        .map(str::to_string);
    let arguments = function_arguments_as_string(func.get("arguments"), "");
    StreamDelta::ToolCall {
        index,
        id,
        name,
        arguments,
    }
}

/// Normalize the two argument shapes seen across OpenAI-compatible servers.
/// The OpenAI wire contract uses a JSON-encoded string, while several local
/// model gateways return the decoded JSON object directly. Internally the
/// agent loop intentionally keeps one representation: a JSON string.
fn function_arguments_as_string(arguments: Option<&Value>, missing: &str) -> String {
    match arguments {
        Some(Value::String(value)) => value.clone(),
        Some(Value::Null) | None => missing.to_string(),
        Some(value) => serde_json::to_string(value).unwrap_or_else(|_| missing.to_string()),
    }
}

/// Every delta one `delta` object carries, content first then tool calls —
/// a conformant provider only ever sets one of the two, but this must not
/// assume that: some gateways narrate ("checking the logs...") in the same
/// chunk as the tool call it introduces, and silently keeping only
/// whichever field this function checked first would lose the other.
fn deltas_from_json(delta: &Value) -> CoreResult<Vec<StreamDelta>> {
    let mut out = Vec::new();
    if let Some(content) = delta.get("content").and_then(|c| c.as_str()) {
        if !content.is_empty() {
            out.push(StreamDelta::Text(content.to_string()));
        }
    }
    if let Some(arr) = delta.get("tool_calls").and_then(|t| t.as_array()) {
        if arr.len() == 1 {
            out.push(tool_call_from_json(&arr[0]));
        } else if arr.len() > 1 {
            let parts: Vec<StreamDelta> = arr.iter().map(tool_call_from_json).collect();
            out.push(StreamDelta::ToolCalls(parts));
        }
    }
    Ok(out)
}

/// Parse a full SSE body (recorded fixture or live) into deltas, applying
/// finish reasons. Delegates to [`parse_openai_sse_data`] per line — kept
/// as ONE parser rather than two, so a buffered fixture replay and a live
/// stream of the identical bytes can never silently disagree.
pub fn parse_openai_sse_stream(body: &str) -> CoreResult<Vec<StreamDelta>> {
    let mut out = Vec::new();
    for raw_line in body.lines() {
        let line = raw_line.trim_end_matches('\r');
        if line.is_empty() || line.starts_with(':') {
            // comment / keep-alive
            continue;
        }
        let Some(data) = line.strip_prefix("data:") else {
            continue;
        };
        out.extend(parse_openai_sse_data(data.trim_start())?);
    }
    Ok(out)
}

/// Feed every delta from one parsed SSE line to both the live callback and
/// the accumulator, in order — shared by the main read loop and the final
/// flush in [`OpenAiCompatibleClient::complete_stream_cb`] so the two paths
/// can't drift into surfacing different delta kinds to `on_delta`.
fn apply_sse_deltas<F: FnMut(StreamDelta)>(
    acc: &mut StreamAccumulator,
    on_delta: &mut F,
    deltas: Vec<StreamDelta>,
) {
    for delta in deltas {
        if let StreamDelta::Text(ref t) = delta {
            if !t.is_empty() {
                on_delta(StreamDelta::Text(t.clone()));
            }
        } else {
            on_delta(delta.clone());
        }
        acc.push(delta);
    }
}

/// Parse one SSE `data:` payload into deltas **and** merge any transport
/// telemetry the chunk carries (usage on the final OpenAI chunk, Vercel
/// `providerMetadata`, response `model` / `id`, …).
fn apply_sse_data_line<F: FnMut(StreamDelta)>(
    acc: &mut StreamAccumulator,
    on_delta: &mut F,
    data: &str,
) -> CoreResult<()> {
    let trimmed = data.trim();
    if !trimmed.is_empty() && trimmed != "[DONE]" {
        if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
            acc.merge_telemetry(
                &crate::provider_telemetry::extract_transport_telemetry_from_value(&value),
            );
        }
    }
    apply_sse_deltas(acc, on_delta, parse_openai_sse_data(trimmed)?);
    Ok(())
}

/// Replay one ordinary JSON completion through the same callback contract as
/// an equivalent SSE response. Gateways that ignore `stream=true` must not
/// make live consumers lose tool calls, finish state, or the terminal marker.
fn emit_full_completion<F: FnMut(StreamDelta)>(completion: &ChatCompletion, on_delta: &mut F) {
    if !completion.content.is_empty() {
        on_delta(StreamDelta::Text(completion.content.clone()));
    }
    for (index, call) in completion.tool_calls.iter().enumerate() {
        on_delta(StreamDelta::ToolCall {
            index,
            id: Some(call.id.clone()),
            name: Some(call.function.name.clone()),
            arguments: call.function.arguments.clone(),
        });
    }
    on_delta(StreamDelta::Finish(completion.finish_reason.clone()));
    on_delta(StreamDelta::Done);
}

/// Accumulate a full SSE body into [`ChatCompletion`] (offline fixture path).
pub fn accumulate_openai_sse(body: &str) -> CoreResult<ChatCompletion> {
    let mut acc = StreamAccumulator::new();
    for raw_line in body.lines() {
        let line = raw_line.trim_end_matches('\r');
        if line.is_empty() || line.starts_with(':') {
            continue;
        }
        let Some(data) = line.strip_prefix("data:") else {
            continue;
        };
        let data = data.trim_start();
        if data.is_empty() {
            continue;
        }
        if data != "[DONE]" {
            if let Ok(value) = serde_json::from_str::<Value>(data) {
                acc.merge_telemetry(
                    &crate::provider_telemetry::extract_transport_telemetry_from_value(&value),
                );
            }
        }
        for d in parse_openai_sse_data(data)? {
            acc.push(d);
        }
    }
    acc.into_completion()
}

/// Convert tool specs to OpenAI tools array.
pub fn tools_to_openai(specs: &[ToolSpec]) -> Value {
    Value::Array(
        specs
            .iter()
            .map(|t| {
                json!({
                    "type": "function",
                    "function": {
                        "name": t.name,
                        "description": t.description,
                        "parameters": t.parameters,
                    }
                })
            })
            .collect(),
    )
}

/// OpenAI-compatible chat client.
#[derive(Debug, Clone)]
pub struct OpenAiCompatibleClient {
    /// HTTP client.
    http: reqwest::Client,
    /// Base URL (may include /v1).
    pub base_url: String,
    /// Bearer token (optional). Skipped when `extra_headers` already set Authorization.
    pub api_key: Option<String>,
    /// Model id.
    pub model: String,
    /// Optional extra request headers (e.g. Grok OIDC CLI markers).
    pub extra_headers: Vec<(String, String)>,
}

impl OpenAiCompatibleClient {
    /// Create client after SSRF check.
    pub fn new(
        base_url: impl Into<String>,
        api_key: Option<String>,
        model: impl Into<String>,
        policy: &SsrfPolicy,
    ) -> CoreResult<Self> {
        let base_url = base_url.into();
        // #141: resolve+vet+pin; no redirects (anti-rebind / SSRF).
        let (url, http) = build_pinned_client_for_url(
            &base_url,
            policy,
            &SystemResolver,
            std::time::Duration::from_secs(120),
        )?;
        Ok(Self {
            http,
            base_url: url.as_str().trim_end_matches('/').to_string(),
            api_key,
            model: model.into(),
            extra_headers: Vec::new(),
        })
    }

    /// Attach extra headers (e.g. session/OIDC). If Authorization is present, clears `api_key`.
    pub fn with_extra_headers(mut self, headers: Vec<(String, String)>) -> Self {
        if headers
            .iter()
            .any(|(k, _)| k.eq_ignore_ascii_case("Authorization"))
        {
            self.api_key = None;
        }
        self.extra_headers = headers;
        self
    }

    fn chat_url(&self) -> String {
        let b = &self.base_url;
        if b.ends_with("/v1") {
            format!("{b}/chat/completions")
        } else if b.contains("/v1/") {
            format!("{}/chat/completions", b.trim_end_matches('/'))
        } else {
            format!("{b}/v1/chat/completions")
        }
    }

    fn apply_auth(&self, mut req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        for (k, v) in &self.extra_headers {
            req = req.header(k, v);
        }
        if let Some(k) = &self.api_key {
            req = req.bearer_auth(k);
        }
        req
    }

    /// POST one completion request, retrying only bounded HTTP 429 responses.
    ///
    /// A fresh request builder is created for every attempt so JSON/auth body
    /// replay is explicit. Other 4xx responses (and transport failures) return
    /// immediately to preserve their provider body and avoid retry storms.
    async fn post_completion_with_429_retry(
        &self,
        body: &Value,
        operation: &str,
        cancel: Option<&AtomicBool>,
    ) -> CoreResult<reqwest::Response> {
        let mut retry = 0;
        loop {
            if cancel
                .map(|flag| flag.load(Ordering::SeqCst))
                .unwrap_or(false)
            {
                return Err(CoreError::Message("cancelled".into()));
            }
            let response = self
                .apply_auth(self.http.post(self.chat_url()).json(body))
                .send()
                .await
                .map_err(|error| CoreError::Message(format!("{operation}: {error}")))?;
            if response.status().as_u16() != 429 {
                if retry > 0 {
                    tracing::info!(
                        target: "cd_core::chat",
                        provider = "openai_compatible",
                        operation,
                        attempt = retry + 1,
                        max_attempts = OPENAI_COMPATIBLE_MAX_429_RETRIES + 1,
                        "provider rate limit recovered"
                    );
                }
                return Ok(response);
            }
            let request_id = response
                .headers()
                .get("x-request-id")
                .or_else(|| response.headers().get("request-id"))
                .and_then(|value| value.to_str().ok())
                .unwrap_or("");
            if retry >= OPENAI_COMPATIBLE_MAX_429_RETRIES {
                tracing::warn!(
                    target: "cd_core::chat",
                    provider = "openai_compatible",
                    http_status = 429,
                    operation,
                    attempt = retry + 1,
                    max_attempts = OPENAI_COMPATIBLE_MAX_429_RETRIES + 1,
                    provider_request_id = request_id,
                    "provider rate limit exhausted"
                );
                return Ok(response);
            }
            let (delay, delay_source) = bounded_openai_retry_after(response.headers(), retry);
            retry += 1;
            tracing::warn!(
                target: "cd_core::chat",
                provider = "openai_compatible",
                http_status = 429,
                operation,
                attempt = retry + 1,
                max_attempts = OPENAI_COMPATIBLE_MAX_429_RETRIES + 1,
                delay_ms = delay.as_millis() as u64,
                delay_source,
                provider_request_id = request_id,
                cancellable = cancel.is_some(),
                "waiting due to provider rate limit before retry"
            );
            wait_for_openai_429_retry(delay, cancel).await?;
        }
    }

    /// Non-streaming chat completion.
    pub async fn complete(
        &self,
        messages: &[ChatMessage],
        tools: Option<&[ToolSpec]>,
    ) -> CoreResult<ChatCompletion> {
        let mut body = json!({
            "model": self.model,
            "messages": messages,
            "stream": false,
        });
        if let Some(specs) = tools {
            if !specs.is_empty() {
                body["tools"] = tools_to_openai(specs);
                body["tool_choice"] = json!("auto");
            }
        }
        let resp = self
            .post_completion_with_429_retry(&body, "chat request", None)
            .await?;
        let status = resp.status();
        let header_tel = crate::provider_telemetry::capture_safe_response_headers(
            resp.headers().iter().filter_map(|(k, v)| {
                v.to_str()
                    .ok()
                    .map(|value| (k.as_str().to_string(), value.to_string()))
            }),
        );
        let text = resp
            .text()
            .await
            .map_err(|e| CoreError::Message(format!("chat body: {e}")))?;
        if !status.is_success() {
            return Err(provider_http_error("chat", status, &text, 300));
        }
        let mut completion = parse_openai_completion(&text)?;
        // Headers first, body second so JSON `id` / usage win over header ids.
        let mut tel = header_tel;
        tel.merge_from(&completion.telemetry);
        completion.telemetry = tel;
        Ok(completion)
    }

    /// Streaming chat completion (SSE). Accumulates to [`ChatCompletion`].
    ///
    /// When tools are unsupported by the gateway, callers should fall back to
    /// non-stream `complete` or JSON tool fallback in the agent loop.
    pub async fn complete_stream(
        &self,
        messages: &[ChatMessage],
        tools: Option<&[ToolSpec]>,
    ) -> CoreResult<ChatCompletion> {
        let mut body = json!({
            "model": self.model,
            "messages": messages,
            "stream": true,
        });
        if let Some(specs) = tools {
            if !specs.is_empty() {
                body["tools"] = tools_to_openai(specs);
                body["tool_choice"] = json!("auto");
            }
        }
        let resp = self
            .post_completion_with_429_retry(&body, "stream request", None)
            .await?;
        let status = resp.status();
        let header_tel = crate::provider_telemetry::capture_safe_response_headers(
            resp.headers().iter().filter_map(|(k, v)| {
                v.to_str()
                    .ok()
                    .map(|value| (k.as_str().to_string(), value.to_string()))
            }),
        );
        let text = resp
            .text()
            .await
            .map_err(|e| CoreError::Message(format!("stream body: {e}")))?;
        if !status.is_success() {
            return Err(provider_http_error("stream", status, &text, 300));
        }
        // Some gateways ignore stream=true and return a full JSON object.
        let mut completion = if text.trim_start().starts_with('{') && !text.contains("data:") {
            parse_openai_completion(&text)?
        } else {
            accumulate_openai_sse(&text)?
        };
        let mut tel = header_tel;
        tel.merge_from(&completion.telemetry);
        completion.telemetry = tel;
        Ok(completion)
    }

    /// Streaming chat: invoke `on_delta` for each delta as SSE arrives.
    ///
    /// Reads `bytes_stream()` through a [`crate::sse::SseLineDecoder`] — safe
    /// across arbitrary chunk boundaries (including mid-character UTF-8
    /// splits) and bounded against an oversized or unterminated line; call
    /// with a multi-chunk fixture in tests. Returns the same accumulated
    /// [`ChatCompletion`] as the buffered path. When `cancel` is set, aborts
    /// mid-stream.
    pub async fn complete_stream_cb<F>(
        &self,
        messages: &[ChatMessage],
        tools: Option<&[ToolSpec]>,
        mut on_delta: F,
        cancel: Option<&std::sync::atomic::AtomicBool>,
    ) -> CoreResult<ChatCompletion>
    where
        F: FnMut(StreamDelta),
    {
        use crate::sse::{BoundedBodyAccumulator, SseLineDecoder};
        use futures_util::StreamExt;

        let mut body = json!({
            "model": self.model,
            "messages": messages,
            "stream": true,
        });
        if let Some(specs) = tools {
            if !specs.is_empty() {
                body["tools"] = tools_to_openai(specs);
                body["tool_choice"] = json!("auto");
            }
        }
        let resp = self
            .post_completion_with_429_retry(&body, "stream request", cancel)
            .await?;
        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(provider_http_error("stream", status, &text, 300));
        }

        let header_tel = crate::provider_telemetry::capture_safe_response_headers(
            resp.headers().iter().filter_map(|(k, v)| {
                v.to_str()
                    .ok()
                    .map(|value| (k.as_str().to_string(), value.to_string()))
            }),
        );

        // Some OpenAI-compatible gateways ignore `stream=true` and return a
        // normal completion with an honest JSON content type. Parse that
        // shape before the SSE line parser: a full completion's
        // `finish_reason=tool_calls` also resembles one SSE finish delta, and
        // accepting only that fragment silently drops `message.tool_calls`.
        let content_type = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if content_type.contains("application/json") {
            let mut full_body = BoundedBodyAccumulator::new();
            let mut stream = resp.bytes_stream();
            while let Some(chunk) = stream.next().await {
                if cancel.map(|c| c.load(Ordering::SeqCst)).unwrap_or(false) {
                    return Err(CoreError::Message("cancelled".into()));
                }
                let bytes = chunk.map_err(|e| CoreError::Message(format!("stream body: {e}")))?;
                full_body.push(&bytes)?;
            }
            let mut completion = parse_openai_completion(&full_body.finish()?)?;
            let mut tel = header_tel.clone();
            tel.merge_from(&completion.telemetry);
            completion.telemetry = tel;
            emit_full_completion(&completion, &mut on_delta);
            return Ok(completion);
        }

        let mut acc = StreamAccumulator::new();
        acc.merge_telemetry(&header_tel);
        // Only needed for the non-SSE-gateway fallback below; stop growing
        // it once real SSE framing is confirmed. Raw bytes, decoded exactly
        // once in that fallback — never per chunk, which would corrupt a
        // multi-byte character split across two reads exactly the way
        // `SseLineDecoder` avoids for line-oriented data.
        let mut full_body = BoundedBodyAccumulator::new();
        let mut saw_sse_data = false;
        let mut decoder = SseLineDecoder::new();
        let mut stream = resp.bytes_stream();
        while let Some(chunk) = stream.next().await {
            if cancel.map(|c| c.load(Ordering::SeqCst)).unwrap_or(false) {
                return Err(CoreError::Message("cancelled".into()));
            }
            let bytes = chunk.map_err(|e| CoreError::Message(format!("stream chunk: {e}")))?;
            if !saw_sse_data {
                full_body.push(&bytes)?;
            }
            for line in decoder.push(&bytes)? {
                let Some(data) = line.strip_prefix("data:").map(str::trim) else {
                    continue;
                };
                saw_sse_data = true;
                if data.is_empty() {
                    continue;
                }
                apply_sse_data_line(&mut acc, &mut on_delta, data)?;
            }
        }
        // Some OpenAI-compatible gateways accept `stream=true` but return a
        // normal completion object (often with `application/json`). Parsing
        // that object as an SSE delta sees only `finish_reason` and loses the
        // assistant message/tool calls. Detect the absence of any SSE data
        // lines and route the complete body through the non-stream parser.
        if !saw_sse_data {
            let mut completion = parse_openai_completion(full_body.finish()?.trim())?;
            let mut tel = header_tel;
            tel.merge_from(&completion.telemetry);
            completion.telemetry = tel;
            emit_full_completion(&completion, &mut on_delta);
            return Ok(completion);
        }
        // A provider that closes the connection without a trailing newline
        // after its last event — flush whatever line was still pending.
        if let Some(trailing) = decoder.finish()? {
            if !trailing.trim().is_empty() {
                let data = trailing
                    .trim()
                    .strip_prefix("data:")
                    .map(str::trim)
                    .unwrap_or("");
                if !data.is_empty() {
                    apply_sse_data_line(&mut acc, &mut on_delta, data)?;
                }
            }
        }
        acc.into_completion()
    }

    /// List models via GET …/models (tries several path shapes like TriageTool).
    pub async fn list_models(&self) -> CoreResult<Vec<String>> {
        let base = self.base_url.trim_end_matches('/');
        // Prefer longest successful list across path variants.
        let mut urls: Vec<String> = Vec::new();
        if base.ends_with("/v1") {
            urls.push(format!("{base}/models"));
        } else {
            urls.push(format!("{base}/v1/models"));
            urls.push(format!("{base}/models"));
        }
        let mut last_err = CoreError::Message("models: no URL attempted".into());
        let mut best: Vec<String> = Vec::new();
        for url in urls {
            let mut req = self.http.get(&url);
            req = self.apply_auth(req);
            match req.send().await {
                Ok(resp) => {
                    let status = resp.status();
                    let text = resp
                        .text()
                        .await
                        .map_err(|e| CoreError::Message(format!("models body: {e}")))?;
                    if !status.is_success() {
                        last_err = CoreError::Message(format!("models HTTP {status}"));
                        continue;
                    }
                    match parse_openai_style_models_list(&text) {
                        Ok(ids) if !ids.is_empty() => {
                            if ids.len() > best.len() {
                                best = ids;
                            }
                        }
                        Ok(_) => { /* empty */ }
                        Err(e) => last_err = e,
                    }
                }
                Err(e) => last_err = CoreError::Message(format!("models: {e}")),
            }
        }
        if !best.is_empty() {
            return Ok(best);
        }
        Err(last_err)
    }
}

/// Parse OpenAI-style model catalogs (`data[]`, `models[]`, or top-level array).
/// Accepts `id` or `name` fields (enterprise gateways vary).
pub fn parse_openai_style_models_list(text: &str) -> CoreResult<Vec<String>> {
    let v: Value =
        serde_json::from_str(text).map_err(|e| CoreError::Message(format!("models json: {e}")))?;
    let mut ids = Vec::new();
    let mut push_arr = |arr: &Vec<Value>| {
        for m in arr {
            if let Some(id) = m
                .get("id")
                .and_then(|x| x.as_str())
                .or_else(|| m.get("name").and_then(|x| x.as_str()))
                .or_else(|| m.get("model").and_then(|x| x.as_str()))
            {
                if !id.is_empty() && !ids.iter().any(|x| x == id) {
                    ids.push(id.to_string());
                }
            } else if let Some(s) = m.as_str() {
                if !s.is_empty() && !ids.iter().any(|x| x == s) {
                    ids.push(s.to_string());
                }
            }
        }
    };
    if let Some(arr) = v.get("data").and_then(|d| d.as_array()) {
        push_arr(arr);
    }
    if let Some(arr) = v.get("models").and_then(|d| d.as_array()) {
        push_arr(arr);
    }
    if let Some(arr) = v.as_array() {
        push_arr(arr);
    }
    Ok(ids)
}

/// Parse OpenAI chat completion JSON (also used in tests with fixtures).
pub fn parse_openai_completion(text: &str) -> CoreResult<ChatCompletion> {
    let v: Value = serde_json::from_str(text)?;
    let choice = v
        .get("choices")
        .and_then(|c| c.as_array())
        .and_then(|a| a.first())
        .ok_or_else(|| CoreError::Message("no choices in completion".into()))?;
    let message = choice
        .get("message")
        .ok_or_else(|| CoreError::Message("no message".into()))?;
    let content = message
        .get("content")
        .and_then(|c| c.as_str())
        .unwrap_or("")
        .to_string();
    let finish = choice
        .get("finish_reason")
        .and_then(|f| f.as_str())
        .unwrap_or("stop")
        .to_string();
    let mut tool_calls = Vec::new();
    if let Some(arr) = message.get("tool_calls").and_then(|t| t.as_array()) {
        for (idx, tc) in arr.iter().enumerate() {
            // A position-unique fallback (matching StreamAccumulator's
            // "call_{n}" convention) — a literal "call" for every id-less
            // tool call in one response would collide whenever there is more
            // than one, making a tool-result continuation unable to address
            // them individually.
            let id = tc
                .get("id")
                .and_then(|x| x.as_str())
                .map(str::to_string)
                .unwrap_or_else(|| format!("call_{idx}"));
            let func = tc.get("function").cloned().unwrap_or(json!({}));
            let name = func
                .get("name")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            let arguments = function_arguments_as_string(func.get("arguments"), "{}");
            tool_calls.push(ToolCallMsg {
                id,
                kind: "function".into(),
                function: FunctionCall { name, arguments },
            });
        }
    }
    Ok(ChatCompletion {
        content,
        tool_calls,
        finish_reason: finish,
        telemetry: crate::provider_telemetry::extract_transport_telemetry_from_value(&v),
    })
}

/// Ollama chat client (native /api/chat).
#[derive(Debug, Clone)]
pub struct OllamaClient {
    http: reqwest::Client,
    /// Base URL (e.g. http://127.0.0.1:11434).
    pub base_url: String,
    /// Model name.
    pub model: String,
}

impl OllamaClient {
    /// Create with SSRF policy (loopback allowed by default).
    pub fn new(base_url: impl Into<String>, model: impl Into<String>) -> CoreResult<Self> {
        let base_url = base_url.into();
        // Loopback Ollama: pin with default policy (allow_loopback).
        let (url, http) = build_pinned_client_for_url(
            &base_url,
            &SsrfPolicy::default(),
            &SystemResolver,
            std::time::Duration::from_secs(120),
        )?;
        Ok(Self {
            http,
            base_url: url.as_str().trim_end_matches('/').to_string(),
            model: model.into(),
        })
    }

    /// Configured model name (configuration identity, not a served-model echo).
    pub fn model(&self) -> &str {
        &self.model
    }

    /// List local models via /api/tags.
    pub async fn list_tags(&self) -> CoreResult<Vec<String>> {
        let url = format!("{}/api/tags", self.base_url);
        let resp = self
            .http
            .get(url)
            .send()
            .await
            .map_err(|e| CoreError::Message(format!("ollama tags: {e}")))?;
        if !resp.status().is_success() {
            return Err(CoreError::Message("ollama tags failed".into()));
        }
        let v: Value = resp
            .json()
            .await
            .map_err(|e| CoreError::Message(format!("ollama json: {e}")))?;
        let mut out = Vec::new();
        if let Some(models) = v.get("models").and_then(|m| m.as_array()) {
            for m in models {
                if let Some(name) = m
                    .get("name")
                    .and_then(|n| n.as_str())
                    .or_else(|| m.get("model").and_then(|n| n.as_str()))
                {
                    out.push(name.to_string());
                }
            }
        }
        Ok(out)
    }

    /// Non-stream chat. When `tools` is non-empty, passes OpenAI-shaped tool
    /// schemas (Ollama `/api/chat` `tools` field) and parses `message.tool_calls`.
    pub async fn complete(
        &self,
        messages: &[ChatMessage],
        tools: Option<&[ToolSpec]>,
    ) -> CoreResult<ChatCompletion> {
        let body = ollama_chat_body(&self.model, messages, tools);
        let url = format!("{}/api/chat", self.base_url);
        let resp = self
            .http
            .post(url)
            .json(&body)
            .send()
            .await
            .map_err(|e| CoreError::Message(format!("ollama chat: {e}")))?;
        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| CoreError::Message(format!("ollama body: {e}")))?;
        if !status.is_success() {
            return Err(provider_http_error("ollama", status, &text, 200));
        }
        parse_ollama_chat_response(&text)
    }

    /// Health: tags reachable.
    pub async fn health(&self) -> bool {
        self.list_tags().await.is_ok()
    }

    /// Embed a single prompt via Ollama `/api/embeddings` (#119).
    ///
    /// Not invoked by default `cargo test` (network). Prefer
    /// [`crate::embed::MockHashEmbedBackend`] offline.
    pub async fn embed(&self, prompt: &str) -> CoreResult<Vec<f32>> {
        let url = format!("{}/api/embeddings", self.base_url);
        let body = json!({
            "model": self.model,
            "prompt": prompt,
        });
        let resp = self
            .http
            .post(url)
            .json(&body)
            .send()
            .await
            .map_err(|e| CoreError::Message(format!("ollama embed: {e}")))?;
        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| CoreError::Message(format!("ollama embed body: {e}")))?;
        if !status.is_success() {
            return Err(CoreError::Message(format!(
                "ollama embed HTTP {status}: {}",
                text.chars().take(160).collect::<String>()
            )));
        }
        let v: Value = serde_json::from_str(&text)
            .map_err(|e| CoreError::Message(format!("ollama embed json: {e}")))?;
        let arr = v
            .get("embedding")
            .and_then(|e| e.as_array())
            .ok_or_else(|| CoreError::Message("ollama embed: missing embedding array".into()))?;
        let mut out = Vec::with_capacity(arr.len());
        for x in arr {
            let f = x
                .as_f64()
                .ok_or_else(|| CoreError::Message("ollama embed: non-float component".into()))?;
            out.push(f as f32);
        }
        Ok(out)
    }
}

fn ollama_chat_body(model: &str, messages: &[ChatMessage], tools: Option<&[ToolSpec]>) -> Value {
    let omsgs: Vec<Value> = messages.iter().map(message_to_ollama).collect();
    let mut body = json!({
        "model": model,
        "messages": omsgs,
        "stream": false,
    });
    if let Some(specs) = tools {
        if !specs.is_empty() {
            body["tools"] = tools_to_openai(specs);
            // Tool routing should be reproducible. A nonzero default sampling
            // temperature makes smaller local models alternate between native
            // calls and narrated/fabricated call-shaped prose for the same
            // request. Plain Ollama chat retains the model's normal defaults.
            body["options"] = json!({ "temperature": 0 });
        }
    }
    body
}

/// Serialize a chat message for Ollama `/api/chat` (includes tool_calls).
fn message_to_ollama(m: &ChatMessage) -> Value {
    let role = match m.role {
        Role::System => "system",
        Role::User => "user",
        Role::Assistant => "assistant",
        Role::Tool => "tool",
    };
    let mut v = json!({
        "role": role,
        "content": m.content,
    });
    if let Some(id) = &m.tool_call_id {
        v["tool_call_id"] = json!(id);
    }
    if let Some(tcs) = &m.tool_calls {
        let arr: Vec<Value> = tcs
            .iter()
            .map(|tc| {
                // Ollama commonly wants arguments as a JSON object, not a string.
                let args: Value =
                    serde_json::from_str(&tc.function.arguments).unwrap_or_else(|_| json!({}));
                json!({
                    "id": tc.id,
                    "type": "function",
                    "function": {
                        "name": tc.function.name,
                        "arguments": args,
                    }
                })
            })
            .collect();
        v["tool_calls"] = Value::Array(arr);
    }
    v
}

/// Parse Ollama `/api/chat` non-stream response (tool_calls + content).
pub fn parse_ollama_chat_response(text: &str) -> CoreResult<ChatCompletion> {
    let v: Value = serde_json::from_str(text)?;
    let message = v.get("message").cloned().unwrap_or(json!({}));
    let content = message
        .get("content")
        .and_then(|c| c.as_str())
        .unwrap_or("")
        .to_string();
    let mut tool_calls = Vec::new();
    if let Some(arr) = message.get("tool_calls").and_then(|t| t.as_array()) {
        for (i, tc) in arr.iter().enumerate() {
            let id = tc
                .get("id")
                .and_then(|x| x.as_str())
                .map(str::to_string)
                .unwrap_or_else(|| format!("ollama_{i}"));
            // Ollama: { function: { name, arguments } } — args may be object or string.
            let func = tc
                .get("function")
                .cloned()
                .or_else(|| {
                    // Older shapes put name at top level
                    if tc.get("name").is_some() {
                        Some(tc.clone())
                    } else {
                        None
                    }
                })
                .unwrap_or(json!({}));
            let name = func
                .get("name")
                .and_then(|n| n.as_str())
                .unwrap_or("")
                .to_string();
            if name.is_empty() {
                continue;
            }
            let arguments = match func.get("arguments") {
                Some(Value::String(s)) => s.clone(),
                Some(other) => other.to_string(),
                None => "{}".into(),
            };
            tool_calls.push(ToolCallMsg {
                id,
                kind: "function".into(),
                function: FunctionCall { name, arguments },
            });
        }
    }
    let finish_reason = if tool_calls.is_empty() {
        v.get("done_reason")
            .and_then(|d| d.as_str())
            .unwrap_or("stop")
            .to_string()
    } else {
        "tool_calls".into()
    };
    Ok(ChatCompletion {
        content,
        tool_calls,
        finish_reason,

        telemetry: Default::default(),
    })
}

/// Parse JSON tool call fallback from model prose.
#[allow(clippy::string_slice)] // safe: sliced at ASCII fence delimiters from find()
pub fn parse_json_tool_fallback(content: &str) -> Option<(String, Value)> {
    let content = content.trim();
    // Look for ```json ... ``` or raw object with "tool"
    let json_str = if let Some(start) = content.find("```json") {
        let rest = &content[start + 7..];
        let end = rest.find("```")?;
        rest[..end].trim()
    } else if content.starts_with('{') {
        content
    } else {
        return None;
    };
    let v: Value = serde_json::from_str(json_str).ok()?;
    let name = v
        .get("tool")
        .or_else(|| v.get("name"))?
        .as_str()?
        .to_string();
    let args = v
        .get("arguments")
        .or_else(|| v.get("parameters"))
        .cloned()
        .unwrap_or(json!({}));
    Some((name, args))
}

// ─── Anthropic Messages API (#121) ───────────────────────────────────────────

/// Convert tool specs to Anthropic tools array (`input_schema`, not `parameters`).
pub fn tools_to_anthropic(specs: &[ToolSpec]) -> Value {
    Value::Array(
        specs
            .iter()
            .map(|t| {
                json!({
                    "name": t.name,
                    "description": t.description,
                    "input_schema": t.parameters,
                })
            })
            .collect(),
    )
}

/// Build Anthropic request body: system field + messages + optional tools.
///
/// System messages collapse into top-level `system`; tool results become user
/// messages with `tool_result` blocks; assistant tool calls become `tool_use`.
pub fn anthropic_request_body(
    model: &str,
    messages: &[ChatMessage],
    tools: Option<&[ToolSpec]>,
    max_tokens: u32,
    stream: bool,
) -> Value {
    let mut system_parts: Vec<String> = Vec::new();
    let mut out_msgs: Vec<Value> = Vec::new();

    for m in messages {
        match m.role {
            Role::System => {
                if !m.content.is_empty() {
                    system_parts.push(m.content.clone());
                }
            }
            Role::User => {
                out_msgs.push(json!({
                    "role": "user",
                    "content": m.content,
                }));
            }
            Role::Assistant => {
                let mut content: Vec<Value> = Vec::new();
                if !m.content.is_empty() {
                    content.push(json!({"type": "text", "text": m.content}));
                }
                if let Some(tcs) = &m.tool_calls {
                    for tc in tcs {
                        let input: Value = serde_json::from_str(&tc.function.arguments)
                            .unwrap_or_else(|_| json!({}));
                        content.push(json!({
                            "type": "tool_use",
                            "id": tc.id,
                            "name": tc.function.name,
                            "input": input,
                        }));
                    }
                }
                if content.is_empty() {
                    content.push(json!({"type": "text", "text": ""}));
                }
                out_msgs.push(json!({
                    "role": "assistant",
                    "content": content,
                }));
            }
            Role::Tool => {
                // Anthropic: tool_result lives in a user message content array.
                let tool_use_id = m.tool_call_id.clone().unwrap_or_default();
                let block = json!({
                    "type": "tool_result",
                    "tool_use_id": tool_use_id,
                    "content": m.content,
                });
                // Merge consecutive tool results into one user message when possible.
                if let Some(last) = out_msgs.last_mut() {
                    if last.get("role").and_then(|r| r.as_str()) == Some("user") {
                        if let Some(arr) = last.get_mut("content").and_then(|c| c.as_array_mut()) {
                            if arr.iter().any(|b| {
                                b.get("type").and_then(|t| t.as_str()) == Some("tool_result")
                            }) {
                                arr.push(block);
                                continue;
                            }
                        }
                    }
                }
                out_msgs.push(json!({
                    "role": "user",
                    "content": [block],
                }));
            }
        }
    }

    let mut body = json!({
        "model": model,
        "max_tokens": max_tokens,
        "messages": out_msgs,
        "stream": stream,
    });
    if !system_parts.is_empty() {
        body["system"] = json!(system_parts.join("\n\n"));
    }
    if let Some(specs) = tools {
        if !specs.is_empty() {
            body["tools"] = tools_to_anthropic(specs);
        }
    }
    body
}

/// Parse Anthropic `GET /v1/models` JSON (same flexible shapes as OpenAI-style).
pub fn parse_anthropic_models_list(text: &str) -> CoreResult<Vec<String>> {
    parse_openai_style_models_list(text)
}

/// Parse non-stream Anthropic Messages JSON into [`ChatCompletion`].
pub fn parse_anthropic_completion(text: &str) -> CoreResult<ChatCompletion> {
    let v: Value = serde_json::from_str(text)
        .map_err(|e| CoreError::Message(format!("anthropic json: {e}")))?;
    // Anthropic's documented error envelope (`{"type":"error","error":{...}}`)
    // has no `content` array — without this check it silently parsed as an
    // ordinary empty-but-successful completion (content "", finish_reason
    // defaulted to "end_turn"), indistinguishable from a legitimately empty
    // answer. Mirrors the equivalent inline check the OpenAI-compatible SSE
    // parser already applies (`parse_openai_sse_data`'s `v.get("error")`).
    if v.get("type").and_then(|t| t.as_str()) == Some("error") {
        let message = v
            .pointer("/error/message")
            .and_then(|m| m.as_str())
            .unwrap_or("anthropic error response");
        return Err(CoreError::Message(message.to_string()));
    }
    let mut content = String::new();
    let mut tool_calls = Vec::new();
    if let Some(blocks) = v.get("content").and_then(|c| c.as_array()) {
        for (idx, b) in blocks.iter().enumerate() {
            let ty = b.get("type").and_then(|t| t.as_str()).unwrap_or("");
            match ty {
                "text" => {
                    if let Some(t) = b.get("text").and_then(|t| t.as_str()) {
                        content.push_str(t);
                    }
                }
                "tool_use" => {
                    // A position-unique fallback (matching the streaming
                    // accumulator's convention below) — a literal
                    // "toolu_unknown" for every id-less block would collide
                    // whenever a response has more than one, making a
                    // tool-result continuation unable to address them
                    // individually.
                    let id = b
                        .get("id")
                        .and_then(|x| x.as_str())
                        .map(str::to_string)
                        .unwrap_or_else(|| format!("toolu_{idx}"));
                    let name = b
                        .get("name")
                        .and_then(|n| n.as_str())
                        .unwrap_or("")
                        .to_string();
                    if name.is_empty() {
                        continue;
                    }
                    let arguments = match b.get("input") {
                        Some(Value::String(s)) => s.clone(),
                        Some(other) => other.to_string(),
                        None => "{}".into(),
                    };
                    tool_calls.push(ToolCallMsg {
                        id,
                        kind: "function".into(),
                        function: FunctionCall { name, arguments },
                    });
                }
                _ => {}
            }
        }
    }
    let stop = v
        .get("stop_reason")
        .and_then(|s| s.as_str())
        .unwrap_or("end_turn");
    let finish_reason = match stop {
        "tool_use" => "tool_calls".into(),
        other => other.to_string(),
    };
    Ok(ChatCompletion {
        content,
        tool_calls,
        finish_reason,

        telemetry: Default::default(),
    })
}

/// Accumulate Anthropic SSE (`event:` / `data:`) into [`ChatCompletion`].
///
/// Handles `content_block_start` / `content_block_delta` (`text_delta`,
/// `input_json_delta`) / `content_block_stop` / `message_delta` / `message_stop`.
#[allow(clippy::string_slice)] // SSE lines split on ASCII newlines
pub fn accumulate_anthropic_sse(body: &str) -> CoreResult<ChatCompletion> {
    let mut content = String::new();
    // index -> (id, name, json_args_buf)
    let mut tools: std::collections::BTreeMap<usize, (String, String, String)> =
        std::collections::BTreeMap::new();
    let mut finish_reason = String::from("end_turn");
    // True once message_delta (carrying stop_reason) or message_stop has
    // been observed — see the fail-closed check below.
    let mut saw_finish_signal = false;
    let mut current_event = String::new();

    for raw_line in body.lines() {
        let line = raw_line.trim_end();
        if line.is_empty() {
            current_event.clear();
            continue;
        }
        if let Some(ev) = line.strip_prefix("event:") {
            current_event = ev.trim().to_string();
            continue;
        }
        let Some(data) = line.strip_prefix("data:") else {
            continue;
        };
        let data = data.trim();
        if data.is_empty() || data == "[DONE]" {
            continue;
        }
        let v: Value = match serde_json::from_str(data) {
            Ok(v) => v,
            Err(_) => continue,
        };
        // Prefer nested type field when event: line missing.
        let ev = if current_event.is_empty() {
            v.get("type").and_then(|t| t.as_str()).unwrap_or("")
        } else {
            current_event.as_str()
        };

        match ev {
            "content_block_start" => {
                let idx = v.get("index").and_then(|i| i.as_u64()).unwrap_or(0) as usize;
                let block = v.get("content_block").cloned().unwrap_or(json!({}));
                let ty = block.get("type").and_then(|t| t.as_str()).unwrap_or("");
                if ty == "tool_use" {
                    let id = block
                        .get("id")
                        .and_then(|x| x.as_str())
                        .unwrap_or("")
                        .to_string();
                    let name = block
                        .get("name")
                        .and_then(|n| n.as_str())
                        .unwrap_or("")
                        .to_string();
                    tools.insert(idx, (id, name, String::new()));
                }
            }
            "content_block_delta" => {
                let idx = v.get("index").and_then(|i| i.as_u64()).unwrap_or(0) as usize;
                let delta = v.get("delta").cloned().unwrap_or(json!({}));
                let dty = delta.get("type").and_then(|t| t.as_str()).unwrap_or("");
                match dty {
                    "text_delta" => {
                        if let Some(t) = delta.get("text").and_then(|t| t.as_str()) {
                            content.push_str(t);
                        }
                    }
                    "input_json_delta" => {
                        if let Some(partial) = delta.get("partial_json").and_then(|t| t.as_str()) {
                            let entry = tools
                                .entry(idx)
                                .or_insert_with(|| (String::new(), String::new(), String::new()));
                            entry.2.push_str(partial);
                        }
                    }
                    _ => {}
                }
            }
            "message_delta" => {
                if let Some(sr) = v.pointer("/delta/stop_reason").and_then(|s| s.as_str()) {
                    finish_reason = match sr {
                        "tool_use" => "tool_calls".into(),
                        other => other.to_string(),
                    };
                    saw_finish_signal = true;
                }
            }
            "message_stop" => {
                saw_finish_signal = true;
            }
            "content_block_stop" => {}
            // Anthropic's documented mid-stream error event
            // (`event: error` / `{"type":"error","error":{...}}`, e.g.
            // `overloaded_error`). Previously fell through the wildcard arm
            // below and was silently discarded — a provider-reported error
            // must abort with an error, never be dropped in favor of
            // whatever partial content streamed before it.
            "error" => {
                let message = v
                    .pointer("/error/message")
                    .and_then(|m| m.as_str())
                    .unwrap_or("anthropic stream error");
                return Err(CoreError::Message(message.to_string()));
            }
            _ => {
                // Some servers put type only in data JSON without event: lines.
                if v.get("type").and_then(|t| t.as_str()) == Some("content_block_delta") {
                    let delta = v.get("delta").cloned().unwrap_or(json!({}));
                    if delta.get("type").and_then(|t| t.as_str()) == Some("text_delta") {
                        if let Some(t) = delta.get("text").and_then(|t| t.as_str()) {
                            content.push_str(t);
                        }
                    }
                }
            }
        }
    }

    // Fails closed when the stream ended without ever observing
    // message_delta or message_stop — see StreamAccumulator::into_completion
    // (chat.rs) for the identical OpenAI-side invariant and rationale. A
    // connection that closes cleanly mid-answer must not be reported as a
    // completed response with a fabricated "end_turn".
    if !saw_finish_signal {
        return Err(CoreError::Message(
            "anthropic stream ended before message_delta or message_stop was ever received".into(),
        ));
    }

    let mut tool_calls = Vec::new();
    for (_idx, (id, name, args)) in tools {
        if name.is_empty() {
            continue;
        }
        let arguments = if args.is_empty() { "{}".into() } else { args };
        tool_calls.push(ToolCallMsg {
            id: if id.is_empty() {
                format!("toolu_{}", tool_calls.len())
            } else {
                id
            },
            kind: "function".into(),
            function: FunctionCall { name, arguments },
        });
    }
    if !tool_calls.is_empty() && finish_reason == "end_turn" {
        finish_reason = "tool_calls".into();
    }
    Ok(ChatCompletion {
        content,
        tool_calls,
        finish_reason,

        telemetry: Default::default(),
    })
}

/// Anthropic Messages API client (`POST /v1/messages`).
#[derive(Debug, Clone)]
pub struct AnthropicClient {
    http: reqwest::Client,
    /// Base URL (default `https://api.anthropic.com`).
    pub base_url: String,
    /// API key (sent as `x-api-key`, never Bearer).
    pub api_key: String,
    /// Model id from the active profile.
    pub model: String,
}

impl AnthropicClient {
    /// Create client after SSRF check. Empty `base_url` → `https://api.anthropic.com`.
    pub fn new(
        base_url: impl Into<String>,
        api_key: Option<String>,
        model: impl Into<String>,
        policy: &SsrfPolicy,
    ) -> CoreResult<Self> {
        let raw = base_url.into();
        let base = if raw.trim().is_empty() {
            "https://api.anthropic.com".to_string()
        } else {
            raw.trim().to_string()
        };
        let key = api_key
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| CoreError::Config("Anthropic API key required".into()))?;
        let (url, http) = build_pinned_client_for_url(
            &base,
            policy,
            &SystemResolver,
            std::time::Duration::from_secs(120),
        )?;
        Ok(Self {
            http,
            base_url: url.as_str().trim_end_matches('/').to_string(),
            api_key: key,
            model: model.into(),
        })
    }

    fn messages_url(&self) -> String {
        let b = &self.base_url;
        if b.ends_with("/v1") {
            format!("{b}/messages")
        } else if b.contains("/v1/") {
            format!("{}/messages", b.trim_end_matches('/'))
        } else {
            format!("{b}/v1/messages")
        }
    }

    fn apply_headers(&self, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        req.header("x-api-key", &self.api_key)
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
    }

    /// Non-streaming Messages completion.
    pub async fn complete(
        &self,
        messages: &[ChatMessage],
        tools: Option<&[ToolSpec]>,
    ) -> CoreResult<ChatCompletion> {
        let body = anthropic_request_body(&self.model, messages, tools, 4096, false);
        let req = self.apply_headers(self.http.post(self.messages_url()).json(&body));
        let resp = req
            .send()
            .await
            .map_err(|e| CoreError::Message(format!("anthropic request: {e}")))?;
        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| CoreError::Message(format!("anthropic body: {e}")))?;
        if !status.is_success() {
            return Err(provider_http_error("anthropic", status, &text, 300));
        }
        parse_anthropic_completion(&text)
    }

    /// Streaming Messages completion (buffered SSE body → accumulate).
    pub async fn complete_stream(
        &self,
        messages: &[ChatMessage],
        tools: Option<&[ToolSpec]>,
    ) -> CoreResult<ChatCompletion> {
        let body = anthropic_request_body(&self.model, messages, tools, 4096, true);
        let req = self.apply_headers(self.http.post(self.messages_url()).json(&body));
        let resp = req
            .send()
            .await
            .map_err(|e| CoreError::Message(format!("anthropic stream request: {e}")))?;
        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| CoreError::Message(format!("anthropic stream body: {e}")))?;
        if !status.is_success() {
            return Err(provider_http_error("anthropic stream", status, &text, 300));
        }
        if text.trim_start().starts_with('{') && !text.contains("event:") && !text.contains("data:")
        {
            return parse_anthropic_completion(&text);
        }
        accumulate_anthropic_sse(&text)
    }

    /// List models via GET /v1/models (x-api-key).
    pub async fn list_models(&self) -> CoreResult<Vec<String>> {
        let url = if self.base_url.ends_with("/v1") {
            format!("{}/models", self.base_url)
        } else {
            format!("{}/v1/models", self.base_url)
        };
        let req = self.apply_headers(self.http.get(url));
        let resp = req
            .send()
            .await
            .map_err(|e| CoreError::Message(format!("anthropic models: {e}")))?;
        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| CoreError::Message(format!("anthropic models body: {e}")))?;
        if !status.is_success() {
            return Err(CoreError::Message(format!(
                "anthropic models HTTP {status}"
            )));
        }
        parse_anthropic_models_list(&text)
    }

    /// Streaming with live text callbacks, read through a
    /// [`crate::sse::SseLineDecoder`] for the same reasons
    /// [`OpenAiCompatibleClient::complete_stream_cb`] uses one — safe across
    /// arbitrary chunk boundaries (including mid-character UTF-8 splits).
    pub async fn complete_stream_cb<F>(
        &self,
        messages: &[ChatMessage],
        tools: Option<&[ToolSpec]>,
        mut on_delta: F,
        cancel: Option<&std::sync::atomic::AtomicBool>,
    ) -> CoreResult<ChatCompletion>
    where
        F: FnMut(StreamDelta),
    {
        use crate::sse::SseLineDecoder;
        use futures_util::StreamExt;
        use std::sync::atomic::Ordering;

        let body = anthropic_request_body(&self.model, messages, tools, 4096, true);
        let req = self.apply_headers(self.http.post(self.messages_url()).json(&body));
        let resp = req
            .send()
            .await
            .map_err(|e| CoreError::Message(format!("anthropic stream request: {e}")))?;
        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(provider_http_error("anthropic stream", status, &text, 300));
        }

        // Anthropic's final tool-call reconstruction re-parses the whole
        // accumulated body (unlike the OpenAI-compatible path, which can
        // stop retaining it once real SSE framing is confirmed), so this
        // buffer's size is inherent to that design, not bounded here. Built
        // from the decoder's already-UTF-8-safe lines — never from
        // re-decoding a raw chunk in isolation, which would reintroduce the
        // exact corruption this decoder exists to prevent.
        let mut full_body_lines: Vec<String> = Vec::new();
        let mut decoder = SseLineDecoder::new();
        let mut stream = resp.bytes_stream();
        while let Some(chunk) = stream.next().await {
            if cancel.map(|c| c.load(Ordering::SeqCst)).unwrap_or(false) {
                return Err(CoreError::Message("cancelled".into()));
            }
            let bytes = chunk.map_err(|e| CoreError::Message(format!("stream chunk: {e}")))?;
            for line in decoder.push(&bytes)? {
                let Some(data) = line.strip_prefix("data:") else {
                    full_body_lines.push(line);
                    continue;
                };
                let data = data.trim();
                full_body_lines.push(line.clone());
                if data.is_empty() || data == "[DONE]" {
                    continue;
                }
                if let Ok(v) = serde_json::from_str::<Value>(data) {
                    let ty = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
                    if ty == "content_block_delta" {
                        let delta = v.get("delta").cloned().unwrap_or(json!({}));
                        if delta.get("type").and_then(|t| t.as_str()) == Some("text_delta") {
                            if let Some(t) = delta.get("text").and_then(|t| t.as_str()) {
                                if !t.is_empty() {
                                    on_delta(StreamDelta::Text(t.to_string()));
                                }
                            }
                        }
                    }
                }
            }
        }
        if let Some(trailing) = decoder.finish()? {
            full_body_lines.push(trailing);
        }
        accumulate_anthropic_sse(&full_body_lines.join("\n"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn openai_429_delay_honors_bounded_retry_after_and_conservative_fallback() {
        let empty = reqwest::header::HeaderMap::new();
        assert_eq!(
            bounded_openai_retry_after(&empty, 0),
            (Duration::from_secs(30), "fallback")
        );
        assert_eq!(
            bounded_openai_retry_after(&empty, 1),
            (Duration::from_secs(60), "fallback")
        );

        let mut seconds = reqwest::header::HeaderMap::new();
        seconds.insert(reqwest::header::RETRY_AFTER, "120".parse().unwrap());
        assert_eq!(
            bounded_openai_retry_after(&seconds, 0),
            (Duration::from_secs(60), "retry_after"),
            "Retry-After must be honored but never exceed the one-minute bound"
        );

        let mut date = reqwest::header::HeaderMap::new();
        let future = (Utc::now() + chrono::Duration::seconds(1)).to_rfc2822();
        date.insert(reqwest::header::RETRY_AFTER, future.parse().unwrap());
        let (delay, source) = bounded_openai_retry_after(&date, 0);
        assert_eq!(source, "retry_after");
        assert!(delay <= Duration::from_secs(1));
    }

    #[test]
    fn parse_fixture_with_tools() {
        let fixture = r#"{
          "choices": [{
            "finish_reason": "tool_calls",
            "message": {
              "role": "assistant",
              "content": null,
              "tool_calls": [{
                "id": "call_1",
                "type": "function",
                "function": {
                  "name": "search_kb",
                  "arguments": "{\"query\":\"auth\"}"
                }
              }]
            }
          }]
        }"#;
        let c = parse_openai_completion(fixture).unwrap();
        assert_eq!(c.tool_calls.len(), 1);
        assert_eq!(c.tool_calls[0].function.name, "search_kb");
    }

    #[test]
    fn parse_openai_completion_preserves_object_valued_tool_arguments() {
        let fixture = r#"{
          "choices": [{
            "finish_reason": "tool_calls",
            "message": {
              "role": "assistant",
              "content": null,
              "tool_calls": [{
                "id": "call_object_args",
                "type": "function",
                "function": {
                  "name": "search_logs",
                  "arguments": {"query":"NO_SUCH_TOKEN","semantic":false,"k":5}
                }
              }]
            }
          }]
        }"#;
        let completion = parse_openai_completion(fixture).unwrap();
        let arguments: Value =
            serde_json::from_str(&completion.tool_calls[0].function.arguments).unwrap();
        assert_eq!(arguments["query"], "NO_SUCH_TOKEN");
        assert_eq!(arguments["semantic"], false);
        assert_eq!(arguments["k"], 5);
    }

    #[test]
    fn parse_text_completion() {
        let fixture = r#"{
          "choices": [{
            "finish_reason": "stop",
            "message": { "role": "assistant", "content": "Hello **world**" }
          }]
        }"#;
        let c = parse_openai_completion(fixture).unwrap();
        assert!(c.content.contains("Hello"));
        assert!(c.tool_calls.is_empty());
    }

    #[test]
    fn json_tool_fallback() {
        let (n, a) = parse_json_tool_fallback(
            "```json\n{\"tool\":\"search_kb\",\"arguments\":{\"query\":\"x\"}}\n```",
        )
        .unwrap();
        assert_eq!(n, "search_kb");
        assert_eq!(a["query"], "x");
    }

    #[test]
    fn parse_ollama_tool_calls_object_args() {
        // Live-shaped fixture from Ollama mistral (arguments as object).
        let raw = r#"{
          "model":"mistral",
          "message":{
            "role":"assistant",
            "content":"",
            "tool_calls":[{
              "id":"call_abc",
              "function":{
                "index":0,
                "name":"web_search",
                "arguments":{"query":"latest rust release","limit":10}
              }
            }]
          },
          "done":true,
          "done_reason":"stop"
        }"#;
        let c = parse_ollama_chat_response(raw).unwrap();
        assert_eq!(c.tool_calls.len(), 1);
        assert_eq!(c.tool_calls[0].function.name, "web_search");
        assert_eq!(c.finish_reason, "tool_calls");
        let args: Value = serde_json::from_str(&c.tool_calls[0].function.arguments).unwrap();
        assert_eq!(args["query"], "latest rust release");
    }

    #[test]
    fn ollama_tool_requests_use_deterministic_sampling_only_when_tools_are_present() {
        let messages = vec![ChatMessage {
            role: Role::User,
            content: "Investigate the linked corpus.".into(),
            tool_call_id: None,
            tool_calls: None,
        }];
        let specs = vec![ToolSpec {
            name: "search_logs".into(),
            description: "Search logs".into(),
            side_effect: crate::tools::ToolSideEffect::Read,
            parameters: serde_json::json!({
                "type": "object",
                "properties": { "query": { "type": "string" } },
                "required": ["query"]
            }),
        }];

        let with_tools = ollama_chat_body("mistral", &messages, Some(&specs));
        assert_eq!(with_tools["options"]["temperature"], 0);
        assert_eq!(with_tools["tools"][0]["function"]["name"], "search_logs");

        let plain = ollama_chat_body("mistral", &messages, None);
        assert!(
            plain.get("options").is_none(),
            "plain chat must preserve provider defaults"
        );
    }

    #[test]
    fn client_rejects_ssrf() {
        let err = OpenAiCompatibleClient::new(
            "http://169.254.169.254/",
            None,
            "m",
            &SsrfPolicy::default(),
        );
        assert!(err.is_err());
    }

    #[test]
    fn anthropic_rejects_ssrf_and_missing_key() {
        assert!(AnthropicClient::new(
            "http://169.254.169.254/",
            Some("sk-ant-test".into()),
            "claude-test",
            &SsrfPolicy::default(),
        )
        .is_err());
        assert!(AnthropicClient::new(
            "https://api.anthropic.com",
            None,
            "claude-test",
            &SsrfPolicy::default(),
        )
        .is_err());
    }

    #[test]
    fn parse_anthropic_models_list_extracts_ids() {
        let fixture = r#"{
          "data": [
            {"id": "claude-opus-4-20250514", "type": "model"},
            {"id": "claude-sonnet-4-20250514", "type": "model"},
            {"type": "model"}
          ]
        }"#;
        let ids = parse_anthropic_models_list(fixture).unwrap();
        assert_eq!(
            ids,
            vec![
                "claude-opus-4-20250514".to_string(),
                "claude-sonnet-4-20250514".to_string()
            ]
        );
        assert!(parse_anthropic_models_list(r#"{"data":[]}"#)
            .unwrap()
            .is_empty());
        assert!(parse_anthropic_models_list("not-json").is_err());
    }

    #[test]
    fn parse_openai_style_models_accepts_name_and_models_array() {
        let fixture = r#"{
          "models": [
            {"name": "corp/chat-large"},
            {"id": "corp/chat-small"}
          ]
        }"#;
        let ids = parse_openai_style_models_list(fixture).unwrap();
        assert!(ids.contains(&"corp/chat-large".into()));
        assert!(ids.contains(&"corp/chat-small".into()));
    }

    #[test]
    fn parse_anthropic_text_and_tool_use() {
        let fixture = r#"{
          "id": "msg_1",
          "type": "message",
          "role": "assistant",
          "content": [
            {"type": "text", "text": "Looking that up."},
            {
              "type": "tool_use",
              "id": "toolu_1",
              "name": "search_kb",
              "input": {"query": "auth"}
            }
          ],
          "stop_reason": "tool_use"
        }"#;
        let c = parse_anthropic_completion(fixture).unwrap();
        assert!(c.content.contains("Looking"));
        assert_eq!(c.tool_calls.len(), 1);
        assert_eq!(c.tool_calls[0].id, "toolu_1");
        assert_eq!(c.tool_calls[0].function.name, "search_kb");
        assert_eq!(c.finish_reason, "tool_calls");
        let args: Value = serde_json::from_str(&c.tool_calls[0].function.arguments).unwrap();
        assert_eq!(args["query"], "auth");
    }

    #[test]
    fn accumulate_anthropic_sse_text_and_fragmented_tool() {
        let sse = r#"event: message_start
data: {"type":"message_start","message":{"id":"msg_1","role":"assistant","content":[]}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello "}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Claude"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: content_block_start
data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_9","name":"search_kb","input":{}}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"que"}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"ry\":\"x\"}"}}

event: content_block_stop
data: {"type":"content_block_stop","index":1}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}

event: message_stop
data: {"type":"message_stop"}
"#;
        let c = accumulate_anthropic_sse(sse).unwrap();
        assert_eq!(c.content, "Hello Claude");
        assert_eq!(c.tool_calls.len(), 1);
        assert_eq!(c.tool_calls[0].function.name, "search_kb");
        assert_eq!(c.finish_reason, "tool_calls");
        let args: Value = serde_json::from_str(&c.tool_calls[0].function.arguments).unwrap();
        assert_eq!(args["query"], "x");
    }

    #[test]
    fn anthropic_request_body_maps_system_and_tools() {
        let msgs = vec![
            ChatMessage {
                role: Role::System,
                content: "policy".into(),
                tool_call_id: None,
                tool_calls: None,
            },
            ChatMessage {
                role: Role::User,
                content: "hi".into(),
                tool_call_id: None,
                tool_calls: None,
            },
            ChatMessage {
                role: Role::Assistant,
                content: String::new(),
                tool_call_id: None,
                tool_calls: Some(vec![ToolCallMsg {
                    id: "toolu_1".into(),
                    kind: "function".into(),
                    function: FunctionCall {
                        name: "search_kb".into(),
                        arguments: r#"{"query":"q"}"#.into(),
                    },
                }]),
            },
            ChatMessage {
                role: Role::Tool,
                content: "result".into(),
                tool_call_id: Some("toolu_1".into()),
                tool_calls: None,
            },
        ];
        let specs = crate::tools::mvp_tool_specs();
        let body = anthropic_request_body("claude-test", &msgs, Some(&specs), 1024, false);
        assert_eq!(body["system"], "policy");
        assert_eq!(body["max_tokens"], 1024);
        assert!(!body["tools"].as_array().unwrap().is_empty());
        assert!(body["tools"][0].get("input_schema").is_some());
        assert!(body["tools"][0].get("parameters").is_none());
        let m = body["messages"].as_array().unwrap();
        assert_eq!(m[0]["role"], "user");
        assert_eq!(m[1]["role"], "assistant");
        assert_eq!(m[1]["content"][0]["type"], "tool_use");
        assert_eq!(m[2]["role"], "user");
        assert_eq!(m[2]["content"][0]["type"], "tool_result");
    }

    /// Recorded OpenAI-style SSE fixture (text only).
    const SSE_TEXT_FIXTURE: &str = r#"data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}

data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hello "},"finish_reason":null}]}

data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"**world**"},"finish_reason":null}]}

data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
"#;

    /// Recorded fixture: tool call arguments fragmented across SSE chunks.
    const SSE_TOOLS_FIXTURE: &str = r#"data: {"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}

data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_abc","type":"function","function":{"name":"search_kb","arguments":""}}]},"finish_reason":null}]}

data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"query\":"}}]},"finish_reason":null}]}

data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"auth JWT\"}"}}]},"finish_reason":null}]}

data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}

data: [DONE]
"#;

    #[test]
    fn sse_parse_text_fixture() {
        let c = accumulate_openai_sse(SSE_TEXT_FIXTURE).unwrap();
        assert_eq!(c.content, "Hello **world**");
        assert!(c.tool_calls.is_empty());
        assert_eq!(c.finish_reason, "stop");
    }

    /// Feed the fixture through the REAL production line decoder
    /// ([`crate::sse::SseLineDecoder`]) in awkward byte slices (mid-line,
    /// not aligned to JSON) and confirm it reaches the same
    /// [`ChatCompletion`] as the single-shot buffered parse — proving the
    /// live and buffered paths agree on identical bytes, not just that a
    /// hand-copied test-local buffer happens to.
    #[test]
    fn sse_multi_chunk_byte_boundaries_match_buffered() {
        let full = SSE_TEXT_FIXTURE.as_bytes();
        let mut decoder = crate::sse::SseLineDecoder::new();
        let mut acc = StreamAccumulator::new();
        let mut texts = Vec::new();
        // Split every 17 bytes — not aligned to lines or JSON.
        for chunk in full.chunks(17) {
            for line in decoder.push(chunk).unwrap() {
                let Some(data) = line.strip_prefix("data:").map(str::trim) else {
                    continue;
                };
                if data.is_empty() {
                    continue;
                }
                for delta in parse_openai_sse_data(data).unwrap() {
                    if let StreamDelta::Text(ref t) = delta {
                        texts.push(t.clone());
                    }
                    acc.push(delta);
                }
            }
        }
        let c = acc.into_completion().unwrap();
        let buffered = accumulate_openai_sse(SSE_TEXT_FIXTURE).unwrap();
        assert_eq!(c.content, buffered.content);
        assert_eq!(c.tool_calls.len(), buffered.tool_calls.len());
        assert!(!texts.is_empty(), "expected live text deltas across chunks");
        assert_eq!(texts.join(""), buffered.content);
    }

    /// A multi-byte UTF-8 character split exactly across a `bytes_stream()`
    /// chunk boundary must decode intact through the real production path
    /// used by `complete_stream_cb`, not corrupt into replacement
    /// characters — the adversarial case a naive per-chunk
    /// `String::from_utf8_lossy` (the pre-fix behavior) silently mangles.
    #[test]
    fn sse_text_delta_survives_utf8_character_split_across_chunks() {
        let line =
            "data: {\"choices\":[{\"delta\":{\"content\":\"café 🎉 done\"}}]}\n\ndata: [DONE]\n\n";
        let bytes = line.as_bytes();
        let split_at = line.find('🎉').unwrap() + 1; // land inside the 4-byte emoji
        let mut decoder = crate::sse::SseLineDecoder::new();
        let mut acc = StreamAccumulator::new();
        for chunk in [&bytes[..split_at], &bytes[split_at..]] {
            for parsed_line in decoder.push(chunk).unwrap() {
                let Some(data) = parsed_line.strip_prefix("data:").map(str::trim) else {
                    continue;
                };
                if data.is_empty() {
                    continue;
                }
                for delta in parse_openai_sse_data(data).unwrap() {
                    acc.push(delta);
                }
            }
        }
        assert_eq!(acc.into_completion().unwrap().content, "café 🎉 done");
    }

    /// The non-SSE "gateway ignored `stream=true`" fallback's exact
    /// sequence — `BoundedBodyAccumulator::push` per chunk, then `finish`,
    /// then `parse_openai_completion` — reproduced here the same way
    /// `sse_text_delta_survives_utf8_character_split_across_chunks` proves
    /// the line-oriented path: a multi-byte character split across chunk
    /// boundaries must survive intact through to the parsed completion, not
    /// corrupt the way a naive per-chunk `String::from_utf8_lossy` (the
    /// pre-fix behavior for this fallback specifically) would.
    #[test]
    fn non_sse_fallback_body_survives_utf8_character_split_across_chunks() {
        let body = "{\"choices\":[{\"finish_reason\":\"stop\",\"message\":{\"role\":\"assistant\",\"content\":\"café 🎉 done\"}}]}";
        let bytes = body.as_bytes();
        let split_at = body.find('🎉').unwrap() + 1; // land inside the 4-byte emoji
        let mut acc = crate::sse::BoundedBodyAccumulator::new();
        for chunk in [&bytes[..split_at], &bytes[split_at..]] {
            acc.push(chunk).unwrap();
        }
        let completion = parse_openai_completion(&acc.finish().unwrap()).unwrap();
        assert_eq!(completion.content, "café 🎉 done");
    }

    /// A delta that carries both `content` (narration) and `tool_calls` in
    /// the SAME object — seen from gateways that describe what they're
    /// about to do in the same chunk as the call — must surface both, not
    /// silently drop the content behind the tool call.
    #[test]
    fn sse_delta_with_content_and_tool_calls_together_keeps_both() {
        let body = r#"data: {"choices":[{"delta":{"content":"checking the logs","tool_calls":[{"index":0,"id":"call_1","function":{"name":"search_logs","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}

data: [DONE]
"#;
        let completion = accumulate_openai_sse(body).unwrap();
        assert_eq!(completion.content, "checking the logs");
        assert_eq!(completion.tool_calls.len(), 1);
        assert_eq!(completion.tool_calls[0].function.name, "search_logs");
        assert_eq!(completion.finish_reason, "tool_calls");
    }

    /// The same combined-fields event, this time driven through the LIVE
    /// per-line parser [`parse_openai_sse_data`] exactly as
    /// `complete_stream_cb` calls it, proving the live path no longer
    /// diverges from the buffered path proven above.
    #[test]
    fn parse_openai_sse_data_returns_content_tool_call_and_finish_reason_together() {
        let data = r#"{"choices":[{"delta":{"content":"checking the logs","tool_calls":[{"index":0,"id":"call_1","function":{"name":"search_logs","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}"#;
        let deltas = parse_openai_sse_data(data).unwrap();
        assert_eq!(
            deltas,
            vec![
                StreamDelta::Text("checking the logs".into()),
                StreamDelta::ToolCall {
                    index: 0,
                    id: Some("call_1".into()),
                    name: Some("search_logs".into()),
                    arguments: "{}".into(),
                },
                StreamDelta::Finish("tool_calls".into()),
            ]
        );
    }

    /// A `finish_reason` that co-occurs with a plain text delta (no tool
    /// call) in the same object — the class of event a conformant OpenAI
    /// stream sends as two separate events, but some gateways combine —
    /// must not be dropped either.
    #[test]
    fn sse_finish_reason_survives_when_combined_with_a_final_text_delta() {
        let body = r#"data: {"choices":[{"delta":{"content":" done."},"finish_reason":"length"}]}

data: [DONE]
"#;
        let completion = accumulate_openai_sse(body).unwrap();
        assert_eq!(completion.content, " done.");
        assert_eq!(
            completion.finish_reason, "length",
            "a finish_reason combined with content must not be lost or defaulted"
        );
    }

    /// A single SSE line with no terminator that grows past the configured
    /// bound must fail the whole read closed rather than buffer forever —
    /// verified against the real decoder `complete_stream_cb` uses.
    #[test]
    fn an_unterminated_oversized_line_fails_closed_instead_of_growing_forever() {
        let mut decoder = crate::sse::SseLineDecoder::with_max_buffered_line_bytes(4096);
        let chunk = vec![b'x'; 8192];
        let error = decoder.push(&chunk).unwrap_err();
        assert!(error.to_string().to_ascii_lowercase().contains("exceed"));
    }

    /// A malformed (non-JSON) `data:` payload mid-stream must fail the
    /// whole turn — never silently skipped, which would let a corrupted or
    /// truncated event pass as if nothing happened.
    #[test]
    fn a_malformed_data_line_is_a_hard_error_not_silently_skipped() {
        let error = parse_openai_sse_data("{not json}").unwrap_err();
        assert!(error.to_string().contains("sse json"));
    }

    #[test]
    fn sse_parse_tool_call_fragments() {
        let c = accumulate_openai_sse(SSE_TOOLS_FIXTURE).unwrap();
        assert!(c.content.is_empty());
        assert_eq!(c.tool_calls.len(), 1);
        assert_eq!(c.tool_calls[0].id, "call_abc");
        assert_eq!(c.tool_calls[0].function.name, "search_kb");
        assert_eq!(
            c.tool_calls[0].function.arguments,
            r#"{"query":"auth JWT"}"#
        );
        assert_eq!(c.finish_reason, "tool_calls");
        // Arguments must be valid JSON after reassembly
        let v: Value = serde_json::from_str(&c.tool_calls[0].function.arguments).unwrap();
        assert_eq!(v["query"], "auth JWT");
    }

    /// Two tools batched in one SSE delta (index 0 and 1).
    const SSE_MULTI_TOOL_FIXTURE: &str = r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c0","type":"function","function":{"name":"search_kb","arguments":"{\"query\":\"a\"}"}},{"index":1,"id":"c1","type":"function","function":{"name":"read_file_slice","arguments":"{\"path\":\"x\"}"}}]},"finish_reason":"tool_calls"}]}

data: [DONE]
"#;

    #[test]
    fn sse_parse_multi_tool_in_one_delta() {
        let c = accumulate_openai_sse(SSE_MULTI_TOOL_FIXTURE).unwrap();
        assert_eq!(c.tool_calls.len(), 2);
        assert_eq!(c.tool_calls[0].function.name, "search_kb");
        assert_eq!(c.tool_calls[1].function.name, "read_file_slice");
        assert_eq!(c.finish_reason, "tool_calls");
    }

    #[test]
    fn sse_error_payload() {
        let body = r#"data: {"error":{"message":"rate limited","type":"server_error"}}
"#;
        let err = parse_openai_sse_stream(body).unwrap_err();
        assert!(err.to_string().contains("rate limited"));
    }

    #[test]
    fn sse_done_only() {
        let c = accumulate_openai_sse("data: [DONE]\n").unwrap();
        assert!(c.content.is_empty());
        assert!(c.tool_calls.is_empty());
    }

    #[test]
    fn tools_to_openai_shape() {
        use crate::tools::{ToolSideEffect, ToolSpec};
        let specs = vec![ToolSpec {
            name: "search_kb".into(),
            description: "search".into(),
            parameters: json!({"type":"object"}),
            side_effect: ToolSideEffect::Read,
        }];
        let v = tools_to_openai(&specs);
        let arr = v.as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["type"], "function");
        assert_eq!(arr[0]["function"]["name"], "search_kb");
    }
}
