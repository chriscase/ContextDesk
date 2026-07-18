//! Chat provider clients (OpenAI-compatible, Ollama, Anthropic Messages).

use crate::error::{CoreError, CoreResult};
use crate::ssrf::{build_pinned_client_for_url, SsrfPolicy, SystemResolver};
use crate::tools::ToolSpec;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

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
            StreamDelta::Done => {}
        }
    }

    /// Finish into a completion (same shape as non-stream parse).
    pub fn into_completion(self) -> ChatCompletion {
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
        ChatCompletion {
            content: self.content,
            tool_calls,
            finish_reason,
        }
    }
}

/// Parse a single SSE `data:` payload (JSON object or `[DONE]`).
/// Returns at most one primary delta; use [`parse_openai_sse_stream`] for finish+delta pairs.
pub fn parse_openai_sse_data(data: &str) -> CoreResult<Option<StreamDelta>> {
    let data = data.trim();
    if data.is_empty() {
        return Ok(None);
    }
    if data == "[DONE]" {
        return Ok(Some(StreamDelta::Done));
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
        return Ok(None);
    };
    if let Some(delta) = choice.get("delta") {
        if let Some(d) = delta_from_json(delta)? {
            return Ok(Some(d));
        }
    }
    if let Some(fr) = choice
        .get("finish_reason")
        .and_then(|f| f.as_str())
        .filter(|s| !s.is_empty() && *s != "null")
    {
        return Ok(Some(StreamDelta::Finish(fr.to_string())));
    }
    Ok(None)
}

fn tool_call_from_json(tc: &Value) -> StreamDelta {
    let index = tc.get("index").and_then(|i| i.as_u64()).unwrap_or(0) as usize;
    let id = tc.get("id").and_then(|x| x.as_str()).map(str::to_string);
    let func = tc.get("function").cloned().unwrap_or(json!({}));
    let name = func
        .get("name")
        .and_then(|x| x.as_str())
        .map(str::to_string);
    let arguments = func
        .get("arguments")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    StreamDelta::ToolCall {
        index,
        id,
        name,
        arguments,
    }
}

fn delta_from_json(delta: &Value) -> CoreResult<Option<StreamDelta>> {
    // Prefer tool_calls when present (even alongside empty content).
    if let Some(arr) = delta.get("tool_calls").and_then(|t| t.as_array()) {
        if arr.len() == 1 {
            return Ok(Some(tool_call_from_json(&arr[0])));
        }
        if arr.len() > 1 {
            let parts: Vec<StreamDelta> = arr.iter().map(tool_call_from_json).collect();
            return Ok(Some(StreamDelta::ToolCalls(parts)));
        }
    }
    if let Some(content) = delta.get("content").and_then(|c| c.as_str()) {
        if !content.is_empty() {
            return Ok(Some(StreamDelta::Text(content.to_string())));
        }
    }
    Ok(None)
}

/// Parse a full SSE body (recorded fixture or live) into deltas, applying finish reasons.
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
        let data = data.trim_start();
        // Peek finish_reason on same payload as delta
        if data != "[DONE]" {
            if let Ok(v) = serde_json::from_str::<Value>(data) {
                if let Some(choice) = v
                    .get("choices")
                    .and_then(|c| c.as_array())
                    .and_then(|a| a.first())
                {
                    if let Some(delta) = choice.get("delta") {
                        if let Some(d) = delta_from_json(delta)? {
                            out.push(d);
                        }
                    }
                    if let Some(fr) = choice
                        .get("finish_reason")
                        .and_then(|f| f.as_str())
                        .filter(|s| !s.is_empty() && *s != "null")
                    {
                        out.push(StreamDelta::Finish(fr.to_string()));
                    }
                    continue;
                }
            }
        }
        if let Some(d) = parse_openai_sse_data(data)? {
            out.push(d);
        }
    }
    Ok(out)
}

/// Accumulate a full SSE body into [`ChatCompletion`] (offline fixture path).
pub fn accumulate_openai_sse(body: &str) -> CoreResult<ChatCompletion> {
    let mut acc = StreamAccumulator::new();
    for d in parse_openai_sse_stream(body)? {
        acc.push(d);
    }
    Ok(acc.into_completion())
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
        let req = self.apply_auth(self.http.post(self.chat_url()).json(&body));
        let resp = req
            .send()
            .await
            .map_err(|e| CoreError::Message(format!("chat request: {e}")))?;
        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| CoreError::Message(format!("chat body: {e}")))?;
        if !status.is_success() {
            return Err(CoreError::Message(format!(
                "chat HTTP {status}: {}",
                text.chars().take(300).collect::<String>()
            )));
        }
        parse_openai_completion(&text)
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
        let req = self.apply_auth(self.http.post(self.chat_url()).json(&body));
        let resp = req
            .send()
            .await
            .map_err(|e| CoreError::Message(format!("stream request: {e}")))?;
        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| CoreError::Message(format!("stream body: {e}")))?;
        if !status.is_success() {
            return Err(CoreError::Message(format!(
                "stream HTTP {status}: {}",
                text.chars().take(300).collect::<String>()
            )));
        }
        // Some gateways ignore stream=true and return a full JSON object.
        if text.trim_start().starts_with('{') && !text.contains("data:") {
            return parse_openai_completion(&text);
        }
        accumulate_openai_sse(&text)
    }

    /// Streaming chat: invoke `on_delta` for each text fragment as SSE arrives.
    ///
    /// Reads `bytes_stream()` and splits on newlines; call with a multi-chunk
    /// fixture in tests. Returns the same accumulated [`ChatCompletion`] as the
    /// buffered path. When `cancel` is set, aborts mid-stream.
    #[allow(clippy::string_slice)] // line buffer split on ASCII '\n'
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
        use futures_util::StreamExt;
        use std::sync::atomic::Ordering;

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
        let req = self.apply_auth(self.http.post(self.chat_url()).json(&body));
        let resp = req
            .send()
            .await
            .map_err(|e| CoreError::Message(format!("stream request: {e}")))?;
        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(CoreError::Message(format!(
                "stream HTTP {status}: {}",
                text.chars().take(300).collect::<String>()
            )));
        }

        let mut acc = StreamAccumulator::new();
        let mut line_buf = String::new();
        let mut stream = resp.bytes_stream();
        while let Some(chunk) = stream.next().await {
            if cancel.map(|c| c.load(Ordering::SeqCst)).unwrap_or(false) {
                return Err(CoreError::Message("cancelled".into()));
            }
            let bytes = chunk.map_err(|e| CoreError::Message(format!("stream chunk: {e}")))?;
            let s = String::from_utf8_lossy(&bytes);
            line_buf.push_str(&s);
            while let Some(nl) = line_buf.find('\n') {
                let line = line_buf[..nl].trim_end_matches('\r').to_string();
                line_buf = line_buf[nl + 1..].to_string();
                let data = line.strip_prefix("data:").map(str::trim).unwrap_or("");
                if data.is_empty() {
                    continue;
                }
                // Full JSON object fallback (gateway ignored stream)
                if data.starts_with('{') && !data.contains("\"choices\"") && line_buf.is_empty() {
                    // keep scanning
                }
                match parse_openai_sse_data(data) {
                    Ok(Some(delta)) => {
                        if let StreamDelta::Text(ref t) = delta {
                            if !t.is_empty() {
                                on_delta(StreamDelta::Text(t.clone()));
                            }
                        } else {
                            on_delta(delta.clone());
                        }
                        acc.push(delta);
                    }
                    Ok(None) => {}
                    Err(_) => {
                        // Non-SSE full body
                        if data.starts_with('{') {
                            return parse_openai_completion(data);
                        }
                    }
                }
            }
        }
        // Flush remaining buffer
        if !line_buf.trim().is_empty() {
            let data = line_buf
                .trim()
                .strip_prefix("data:")
                .map(str::trim)
                .unwrap_or(line_buf.trim());
            if let Ok(Some(delta)) = parse_openai_sse_data(data) {
                if let StreamDelta::Text(ref t) = delta {
                    if !t.is_empty() {
                        on_delta(StreamDelta::Text(t.clone()));
                    }
                }
                acc.push(delta);
            } else if data.starts_with('{') {
                return parse_openai_completion(data);
            }
        }
        Ok(acc.into_completion())
    }

    /// List models via GET /v1/models.
    pub async fn list_models(&self) -> CoreResult<Vec<String>> {
        let url = if self.base_url.ends_with("/v1") {
            format!("{}/models", self.base_url)
        } else {
            format!("{}/v1/models", self.base_url)
        };
        let mut req = self.http.get(url);
        req = self.apply_auth(req);
        let resp = req
            .send()
            .await
            .map_err(|e| CoreError::Message(format!("models: {e}")))?;
        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| CoreError::Message(format!("models body: {e}")))?;
        if !status.is_success() {
            return Err(CoreError::Message(format!("models HTTP {status}")));
        }
        let v: Value = serde_json::from_str(&text)?;
        let mut ids = Vec::new();
        if let Some(arr) = v.get("data").and_then(|d| d.as_array()) {
            for m in arr {
                if let Some(id) = m.get("id").and_then(|x| x.as_str()) {
                    ids.push(id.to_string());
                }
            }
        }
        Ok(ids)
    }
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
        for tc in arr {
            let id = tc
                .get("id")
                .and_then(|x| x.as_str())
                .unwrap_or("call")
                .to_string();
            let func = tc.get("function").cloned().unwrap_or(json!({}));
            let name = func
                .get("name")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            let arguments = func
                .get("arguments")
                .and_then(|x| x.as_str())
                .unwrap_or("{}")
                .to_string();
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
                if let Some(name) = m.get("name").and_then(|n| n.as_str()) {
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
        let omsgs: Vec<Value> = messages.iter().map(message_to_ollama).collect();
        let mut body = json!({
            "model": self.model,
            "messages": omsgs,
            "stream": false,
        });
        if let Some(specs) = tools {
            if !specs.is_empty() {
                body["tools"] = tools_to_openai(specs);
            }
        }
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
            return Err(CoreError::Message(format!(
                "ollama HTTP {status}: {}",
                text.chars().take(200).collect::<String>()
            )));
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

/// Parse Anthropic `GET /v1/models` JSON (`{ "data": [ { "id": … } ] }`).
pub fn parse_anthropic_models_list(text: &str) -> CoreResult<Vec<String>> {
    let v: Value = serde_json::from_str(text)
        .map_err(|e| CoreError::Message(format!("anthropic models json: {e}")))?;
    let mut ids = Vec::new();
    if let Some(arr) = v.get("data").and_then(|d| d.as_array()) {
        for m in arr {
            if let Some(id) = m.get("id").and_then(|x| x.as_str()) {
                ids.push(id.to_string());
            }
        }
    }
    Ok(ids)
}

/// Parse non-stream Anthropic Messages JSON into [`ChatCompletion`].
pub fn parse_anthropic_completion(text: &str) -> CoreResult<ChatCompletion> {
    let v: Value = serde_json::from_str(text)
        .map_err(|e| CoreError::Message(format!("anthropic json: {e}")))?;
    let mut content = String::new();
    let mut tool_calls = Vec::new();
    if let Some(blocks) = v.get("content").and_then(|c| c.as_array()) {
        for b in blocks {
            let ty = b.get("type").and_then(|t| t.as_str()).unwrap_or("");
            match ty {
                "text" => {
                    if let Some(t) = b.get("text").and_then(|t| t.as_str()) {
                        content.push_str(t);
                    }
                }
                "tool_use" => {
                    let id = b
                        .get("id")
                        .and_then(|x| x.as_str())
                        .unwrap_or("toolu_unknown")
                        .to_string();
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
                }
            }
            "message_stop" | "content_block_stop" => {}
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
            return Err(CoreError::Message(format!(
                "anthropic HTTP {status}: {}",
                text.chars().take(300).collect::<String>()
            )));
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
            return Err(CoreError::Message(format!(
                "anthropic stream HTTP {status}: {}",
                text.chars().take(300).collect::<String>()
            )));
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

    /// Streaming with live text callbacks (bytes_stream line buffer).
    #[allow(clippy::string_slice)]
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
            return Err(CoreError::Message(format!(
                "anthropic stream HTTP {status}: {}",
                text.chars().take(300).collect::<String>()
            )));
        }

        let mut full_body = String::new();
        let mut line_buf = String::new();
        let mut stream = resp.bytes_stream();
        while let Some(chunk) = stream.next().await {
            if cancel.map(|c| c.load(Ordering::SeqCst)).unwrap_or(false) {
                return Err(CoreError::Message("cancelled".into()));
            }
            let bytes = chunk.map_err(|e| CoreError::Message(format!("stream chunk: {e}")))?;
            let s = String::from_utf8_lossy(&bytes);
            full_body.push_str(&s);
            line_buf.push_str(&s);
            while let Some(pos) = line_buf.find('\n') {
                let line = line_buf[..pos].trim_end_matches('\r').to_string();
                line_buf = line_buf[pos + 1..].to_string();
                if let Some(data) = line.strip_prefix("data:") {
                    let data = data.trim();
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
        }
        accumulate_anthropic_sse(&full_body)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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

    /// Feed fixture in awkward byte slices (mid-line) and rebuild via same
    /// line-buffer logic as complete_stream_cb.
    #[test]
    #[allow(clippy::string_slice)] // ASCII '\n' split of fixture
    fn sse_multi_chunk_byte_boundaries_match_buffered() {
        let full = SSE_TEXT_FIXTURE.as_bytes();
        let mut line_buf = String::new();
        let mut acc = StreamAccumulator::new();
        let mut texts = Vec::new();
        // Split every 17 bytes — not aligned to lines or JSON.
        for chunk in full.chunks(17) {
            line_buf.push_str(&String::from_utf8_lossy(chunk));
            while let Some(nl) = line_buf.find('\n') {
                let line = line_buf[..nl].trim_end_matches('\r').to_string();
                line_buf = line_buf[nl + 1..].to_string();
                let data = line.strip_prefix("data:").map(str::trim).unwrap_or("");
                if data.is_empty() {
                    continue;
                }
                if let Ok(Some(delta)) = parse_openai_sse_data(data) {
                    if let StreamDelta::Text(ref t) = delta {
                        texts.push(t.clone());
                    }
                    acc.push(delta);
                }
            }
        }
        let c = acc.into_completion();
        let buffered = accumulate_openai_sse(SSE_TEXT_FIXTURE).unwrap();
        assert_eq!(c.content, buffered.content);
        assert_eq!(c.tool_calls.len(), buffered.tool_calls.len());
        assert!(!texts.is_empty(), "expected live text deltas across chunks");
        assert_eq!(texts.join(""), buffered.content);
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
