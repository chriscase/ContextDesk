//! Chat provider clients (OpenAI-compatible + Ollama).

use crate::error::{CoreError, CoreResult};
use crate::ssrf::{validate_provider_url, SsrfPolicy};
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
        validate_provider_url(&base_url, policy)?;
        // No redirects: SSRF check is on the user-entered base only.
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(120))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| CoreError::Message(format!("http client: {e}")))?;
        Ok(Self {
            http,
            base_url: base_url.trim_end_matches('/').to_string(),
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
            let text = resp
                .text()
                .await
                .unwrap_or_default();
            return Err(CoreError::Message(format!(
                "stream HTTP {status}: {}",
                text.chars().take(300).collect::<String>()
            )));
        }

        let mut acc = StreamAccumulator::new();
        let mut line_buf = String::new();
        let mut stream = resp.bytes_stream();
        while let Some(chunk) = stream.next().await {
            if cancel
                .map(|c| c.load(Ordering::SeqCst))
                .unwrap_or(false)
            {
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
        validate_provider_url(&base_url, &SsrfPolicy::default())?;
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(120))
            .build()
            .map_err(|e| CoreError::Message(format!("http: {e}")))?;
        Ok(Self {
            http,
            base_url: base_url.trim_end_matches('/').to_string(),
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
