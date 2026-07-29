//! Host orchestration for explicit synthetic capability qualification (#724).
//!
//! User-triggered only. Live transport uses existing provider clients with
//! synthetic prompts only. Unit tests inject
//! [`cd_core::capability_qualification::ScriptedQualificationTransport`].

#[cfg(test)]
use cd_core::capability_qualification::run_qualification;
use cd_core::capability_qualification::{
    execute_inert_probe_tool, inert_probe_tools, CapabilityStatus, ProfileCapabilityGate,
    QualificationKey, QualificationReport, QualificationStore, QualificationTransport,
    SyntheticChatRequest, SyntheticChatResponse, SyntheticEmbeddingResponse, SyntheticMessage,
    SyntheticRerankResponse, SyntheticToolCall, TransportError, INERT_PROBE_TOOL_NAME,
};
#[cfg(test)]
use cd_core::capability_qualification::QUALIFICATION_SCHEMA_VERSION;
use cd_core::chat::{
    ChatMessage, FunctionCall, OllamaClient, OpenAiCompatibleClient, Role as ChatRole, ToolCallMsg,
};
use cd_core::providers::{ProviderKind, ProviderProfile};
use cd_core::ssrf::{build_pinned_client_for_url, SsrfPolicy, SystemResolver};
use cd_core::tools::{ToolSideEffect, ToolSpec};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(test)]
use std::sync::Arc;

/// Cancel registry key — one qualification run at a time.
pub const QUALIFICATION_CANCEL_KEY: &str = "capability_qualification";

/// Wire DTO for one capability check (secret-free).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CapabilityCheckDto {
    pub kind: String,
    pub status: String,
    pub elapsed_ms: u64,
    pub tested_at: i64,
    pub reason: String,
}

/// Wire DTO for a qualification report (no raw endpoint URL or secrets).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct QualificationReportDto {
    pub profile_id: String,
    pub endpoint_fingerprint: String,
    pub model_id: String,
    pub schema_version: String,
    pub role_hint: String,
    pub cancelled: bool,
    pub stale: bool,
    pub finished_at: i64,
    pub checks: Vec<CapabilityCheckDto>,
}

impl From<&QualificationReport> for QualificationReportDto {
    fn from(r: &QualificationReport) -> Self {
        Self {
            profile_id: r.key.profile_id.clone(),
            endpoint_fingerprint: r.key.endpoint_fingerprint.clone(),
            model_id: r.key.model_id.clone(),
            schema_version: r.key.schema_version.clone(),
            role_hint: r.role_hint.clone(),
            cancelled: r.cancelled,
            stale: r.stale,
            finished_at: r.finished_at,
            checks: r
                .checks
                .iter()
                .map(|c| CapabilityCheckDto {
                    kind: c.kind.as_str().to_string(),
                    status: status_wire(c.status).to_string(),
                    elapsed_ms: c.elapsed_ms,
                    tested_at: c.tested_at,
                    reason: c.reason.clone(),
                })
                .collect(),
        }
    }
}

fn status_wire(s: CapabilityStatus) -> &'static str {
    match s {
        CapabilityStatus::Pass => "pass",
        CapabilityStatus::Degraded => "degraded",
        CapabilityStatus::Fail => "fail",
        CapabilityStatus::Untested => "untested",
    }
}

/// Build a cache key for the selected profile/endpoint/model.
pub fn qualification_key(profile_id: &str, base_url: &str, model_id: &str) -> QualificationKey {
    QualificationKey::new(profile_id, base_url, model_id)
}

/// Profile gates are authoritative over probes.
pub fn gate_from_profile(
    profile: &ProviderProfile,
    tools_enabled_for_model: bool,
) -> ProfileCapabilityGate {
    ProfileCapabilityGate {
        tools_enabled: profile.capabilities.tools && tools_enabled_for_model,
        stream_enabled: profile.capabilities.stream,
        embeddings_enabled: profile.capabilities.embeddings,
    }
}

/// Lookup cached report; mark stale when key identity diverges from current selection.
///
/// Exact key hit preferred. Same profile+model under a previous endpoint or
/// schema is returned as **stale** so the UI can prompt Retry without inventing
/// a measured pass. Sibling models never overwrite each other (#650).
pub fn get_cached_report(
    store: &mut QualificationStore,
    current: &QualificationKey,
) -> Option<QualificationReportDto> {
    store
        .get_for_selection(current)
        .map(QualificationReportDto::from)
}

/// Store a finished report (sibling keys untouched).
pub fn put_report(
    store: &mut QualificationStore,
    report: QualificationReport,
) -> QualificationReportDto {
    let dto = QualificationReportDto::from(&report);
    store.put(report);
    dto
}

/// Clear one exact model result only (#650).
pub fn clear_report(store: &mut QualificationStore, key: &QualificationKey) -> bool {
    store.remove(key)
}

/// Run qualification against an injectable transport (tests + host live path).
#[cfg(test)]
fn run_and_store(
    store: &mut QualificationStore,
    key: QualificationKey,
    gate: ProfileCapabilityGate,
    transport: &mut dyn QualificationTransport,
    cancel: &Arc<AtomicBool>,
) -> QualificationReportDto {
    let report = run_qualification(key, gate, transport, cancel);
    put_report(store, report)
}

// ---------------------------------------------------------------------------
// Live transport (synthetic prompts only; contacts configured provider)
// ---------------------------------------------------------------------------

/// Which client backend to use for live probes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LiveBackendKind {
    /// Ollama `/api/chat` (+ `/api/embeddings`).
    Ollama,
    /// OpenAI-compatible chat completions (also Grok Build after headers).
    OpenAiCompatible,
    /// Anthropic Messages API — chat only; embeddings/rerank fail honestly.
    Anthropic,
}

/// Live provider transport for user-triggered qualification.
pub struct LiveQualificationTransport {
    kind: LiveBackendKind,
    base_url: String,
    api_key: Option<String>,
    extra_headers: Vec<(String, String)>,
    local_only: bool,
    /// Last inert tool execution (proves host validation path).
    pub last_inert_tool_result: Option<Result<String, String>>,
}

impl LiveQualificationTransport {
    /// Construct a live transport for a profile kind.
    pub fn new(
        kind: LiveBackendKind,
        base_url: impl Into<String>,
        api_key: Option<String>,
        local_only: bool,
    ) -> Self {
        Self {
            kind,
            base_url: base_url.into(),
            api_key,
            extra_headers: Vec::new(),
            local_only,
            last_inert_tool_result: None,
        }
    }

    /// Attach extra headers (Grok session OIDC markers).
    pub fn with_extra_headers(mut self, headers: Vec<(String, String)>) -> Self {
        self.extra_headers = headers;
        self
    }

    fn ssrf_policy(&self) -> SsrfPolicy {
        if self.local_only {
            SsrfPolicy::local_only()
        } else {
            SsrfPolicy::allow_private_networks()
        }
    }

    fn block_on<F, T>(fut: F) -> Result<T, TransportError>
    where
        F: std::future::Future<Output = Result<T, TransportError>>,
    {
        match tokio::runtime::Handle::try_current() {
            Ok(handle) => tokio::task::block_in_place(|| handle.block_on(fut)),
            Err(_) => {
                let rt = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .map_err(|e| TransportError {
                        reason: format!("runtime: {e}"),
                    })?;
                rt.block_on(fut)
            }
        }
    }

    fn to_chat_messages(msgs: &[SyntheticMessage]) -> Vec<ChatMessage> {
        msgs.iter()
            .map(|m| {
                let role = match m.role.as_str() {
                    "system" => ChatRole::System,
                    "assistant" => ChatRole::Assistant,
                    "tool" => ChatRole::Tool,
                    _ => ChatRole::User,
                };
                let tool_calls = if m.tool_calls.is_empty() {
                    None
                } else {
                    Some(
                        m.tool_calls
                            .iter()
                            .map(|tc| ToolCallMsg {
                                id: tc.id.clone(),
                                kind: "function".into(),
                                function: FunctionCall {
                                    name: tc.name.clone(),
                                    arguments: tc.arguments_json.clone(),
                                },
                            })
                            .collect(),
                    )
                };
                ChatMessage {
                    role,
                    content: m.content.clone(),
                    tool_call_id: m.tool_call_id.clone(),
                    tool_calls,
                }
            })
            .collect()
    }

    fn to_tool_specs(tools: &[cd_core::capability_qualification::InertToolSpec]) -> Vec<ToolSpec> {
        tools
            .iter()
            .map(|t| {
                let parameters = serde_json::from_str(&t.parameters_json)
                    .unwrap_or_else(|_| serde_json::json!({"type": "object", "properties": {}}));
                ToolSpec {
                    name: t.name.clone(),
                    description: t.description.clone(),
                    side_effect: ToolSideEffect::Read,
                    parameters,
                }
            })
            .collect()
    }

    fn map_completion(
        content: String,
        tool_calls: Vec<ToolCallMsg>,
        streamed: bool,
        cancelled: bool,
    ) -> SyntheticChatResponse {
        SyntheticChatResponse {
            content,
            tool_calls: tool_calls
                .into_iter()
                .map(|tc| SyntheticToolCall {
                    id: tc.id,
                    name: tc.function.name,
                    arguments_json: tc.function.arguments,
                })
                .collect(),
            streamed,
            cancelled,
            raw_error: None,
        }
    }

    async fn chat_openai(
        &self,
        req: &SyntheticChatRequest,
        cancel: &AtomicBool,
    ) -> Result<SyntheticChatResponse, TransportError> {
        if cancel.load(Ordering::SeqCst) {
            return Ok(SyntheticChatResponse {
                cancelled: true,
                ..Default::default()
            });
        }
        let client = OpenAiCompatibleClient::new(
            &self.base_url,
            self.api_key.clone(),
            &req.model_id,
            &self.ssrf_policy(),
        )
        .map_err(|e| TransportError {
            reason: redact_host_err(&e.to_string()),
        })?;
        let client = if self.extra_headers.is_empty() {
            client
        } else {
            client.with_extra_headers(self.extra_headers.clone())
        };
        let messages = Self::to_chat_messages(&req.messages);
        let specs = Self::to_tool_specs(&req.tools);
        let tools = if specs.is_empty() {
            None
        } else {
            Some(specs.as_slice())
        };

        if req.stream {
            let result = client
                .complete_stream_cb(&messages, tools, |_| {}, Some(cancel))
                .await;
            match result {
                Ok(comp) => Ok(Self::map_completion(
                    comp.content,
                    comp.tool_calls,
                    true,
                    cancel.load(Ordering::SeqCst),
                )),
                Err(e) => {
                    let msg = e.to_string();
                    if msg.contains("cancelled") || cancel.load(Ordering::SeqCst) {
                        Ok(SyntheticChatResponse {
                            cancelled: true,
                            streamed: true,
                            ..Default::default()
                        })
                    } else {
                        Err(TransportError {
                            reason: redact_host_err(&msg),
                        })
                    }
                }
            }
        } else {
            let mut body_tools = tools;
            // Structured output: still chat; host only checks JSON shape of content.
            let _ = req.expect_json_object;
            match client.complete(&messages, body_tools.take()).await {
                Ok(comp) => Ok(Self::map_completion(
                    comp.content,
                    comp.tool_calls,
                    false,
                    cancel.load(Ordering::SeqCst),
                )),
                Err(e) => Err(TransportError {
                    reason: redact_host_err(&e.to_string()),
                }),
            }
        }
    }

    async fn chat_ollama(
        &self,
        req: &SyntheticChatRequest,
        cancel: &AtomicBool,
    ) -> Result<SyntheticChatResponse, TransportError> {
        if cancel.load(Ordering::SeqCst) {
            return Ok(SyntheticChatResponse {
                cancelled: true,
                ..Default::default()
            });
        }
        let client =
            OllamaClient::new(&self.base_url, &req.model_id).map_err(|e| TransportError {
                reason: redact_host_err(&e.to_string()),
            })?;
        let messages = Self::to_chat_messages(&req.messages);
        let specs = Self::to_tool_specs(&req.tools);
        let tools = if specs.is_empty() {
            None
        } else {
            Some(specs.as_slice())
        };
        // Ollama client uses non-stream complete only. Never claim streamed=true
        // without observing real stream deltas — Streaming probe must degrade/fail honestly.
        match client.complete(&messages, tools).await {
            Ok(comp) => Ok(Self::map_completion(
                comp.content,
                comp.tool_calls,
                false,
                cancel.load(Ordering::SeqCst),
            )),
            Err(e) => Err(TransportError {
                reason: redact_host_err(&e.to_string()),
            }),
        }
    }

    async fn chat_anthropic(
        &self,
        req: &SyntheticChatRequest,
        cancel: &AtomicBool,
    ) -> Result<SyntheticChatResponse, TransportError> {
        if cancel.load(Ordering::SeqCst) {
            return Ok(SyntheticChatResponse {
                cancelled: true,
                ..Default::default()
            });
        }
        let client = cd_core::chat::AnthropicClient::new(
            &self.base_url,
            self.api_key.clone(),
            &req.model_id,
            &self.ssrf_policy(),
        )
        .map_err(|e| TransportError {
            reason: redact_host_err(&e.to_string()),
        })?;
        let messages = Self::to_chat_messages(&req.messages);
        let specs = Self::to_tool_specs(&req.tools);
        let tools = if specs.is_empty() {
            None
        } else {
            Some(specs.as_slice())
        };
        if req.stream {
            match client
                .complete_stream_cb(&messages, tools, |_| {}, Some(cancel))
                .await
            {
                Ok(comp) => Ok(Self::map_completion(
                    comp.content,
                    comp.tool_calls,
                    true,
                    cancel.load(Ordering::SeqCst),
                )),
                Err(e) => {
                    let msg = e.to_string();
                    if msg.contains("cancelled") || cancel.load(Ordering::SeqCst) {
                        Ok(SyntheticChatResponse {
                            cancelled: true,
                            streamed: true,
                            ..Default::default()
                        })
                    } else {
                        Err(TransportError {
                            reason: redact_host_err(&msg),
                        })
                    }
                }
            }
        } else {
            match client.complete(&messages, tools).await {
                Ok(comp) => Ok(Self::map_completion(
                    comp.content,
                    comp.tool_calls,
                    false,
                    cancel.load(Ordering::SeqCst),
                )),
                Err(e) => Err(TransportError {
                    reason: redact_host_err(&e.to_string()),
                }),
            }
        }
    }
}

impl QualificationTransport for LiveQualificationTransport {
    fn chat_complete(
        &mut self,
        req: &SyntheticChatRequest,
        cancel: &AtomicBool,
    ) -> Result<SyntheticChatResponse, TransportError> {
        // Host validates inert tools before any model-visible result continues.
        for tc in req.messages.iter().flat_map(|m| m.tool_calls.iter()) {
            if tc.name == INERT_PROBE_TOOL_NAME {
                let r = execute_inert_probe_tool(&tc.name, &tc.arguments_json);
                self.last_inert_tool_result = Some(r);
            }
        }
        // Also validate tool defs are only the inert set.
        for t in &req.tools {
            if t.name != INERT_PROBE_TOOL_NAME {
                return Err(TransportError {
                    reason: "non_inert_probe_tool_rejected".into(),
                });
            }
        }

        let kind = self.kind;
        Self::block_on(async {
            match kind {
                LiveBackendKind::Ollama => self.chat_ollama(req, cancel).await,
                LiveBackendKind::OpenAiCompatible => self.chat_openai(req, cancel).await,
                LiveBackendKind::Anthropic => self.chat_anthropic(req, cancel).await,
            }
        })
    }

    fn embed(
        &mut self,
        model_id: &str,
        text: &str,
        cancel: &AtomicBool,
    ) -> Result<SyntheticEmbeddingResponse, TransportError> {
        if cancel.load(Ordering::SeqCst) {
            return Err(TransportError {
                reason: "cancelled".into(),
            });
        }
        match self.kind {
            LiveBackendKind::Ollama => Self::block_on(async {
                let client =
                    OllamaClient::new(&self.base_url, model_id).map_err(|e| TransportError {
                        reason: redact_host_err(&e.to_string()),
                    })?;
                match client.embed(text).await {
                    Ok(vector) => Ok(SyntheticEmbeddingResponse {
                        vector,
                        raw_error: None,
                    }),
                    Err(e) => Ok(SyntheticEmbeddingResponse {
                        vector: vec![],
                        raw_error: Some(redact_host_err(&e.to_string())),
                    }),
                }
            }),
            LiveBackendKind::OpenAiCompatible => {
                let base = self.base_url.clone();
                let key = self.api_key.clone();
                let headers = self.extra_headers.clone();
                let policy = self.ssrf_policy();
                let model = model_id.to_string();
                let body_text = text.to_string();
                Self::block_on(async move {
                    match openai_embed(&base, key.as_deref(), &headers, &policy, &model, &body_text)
                        .await
                    {
                        Ok(vector) => Ok(SyntheticEmbeddingResponse {
                            vector,
                            raw_error: None,
                        }),
                        Err(e) => Ok(SyntheticEmbeddingResponse {
                            vector: vec![],
                            raw_error: Some(e),
                        }),
                    }
                })
            }
            LiveBackendKind::Anthropic => Ok(SyntheticEmbeddingResponse {
                vector: vec![],
                raw_error: Some("embeddings_not_supported_on_anthropic_chat_profile".into()),
            }),
        }
    }

    fn rerank(
        &mut self,
        _model_id: &str,
        _query: &str,
        _document_ids: &[&str],
        cancel: &AtomicBool,
    ) -> Result<SyntheticRerankResponse, TransportError> {
        if cancel.load(Ordering::SeqCst) {
            return Err(TransportError {
                reason: "cancelled".into(),
            });
        }
        // No portable rerank wire shape across gateways — fail honestly (not a name-hint pass).
        Ok(SyntheticRerankResponse {
            ranked_ids: vec![],
            raw_error: Some(
                "rerank_contract_requires_gateway_specific_endpoint; not auto-assumed".into(),
            ),
        })
    }
}

/// Map provider kind to live backend.
pub fn backend_for_provider(kind: ProviderKind) -> LiveBackendKind {
    match kind {
        ProviderKind::Ollama => LiveBackendKind::Ollama,
        ProviderKind::Anthropic => LiveBackendKind::Anthropic,
        ProviderKind::OpenAiCompatible | ProviderKind::XaiGrokBuild => {
            LiveBackendKind::OpenAiCompatible
        }
    }
}

fn redact_host_err(raw: &str) -> String {
    cd_core::capability_qualification::redact_reason(raw)
}

/// OpenAI-compatible `/embeddings` with the same SSRF pin as chat.
async fn openai_embed(
    base_url: &str,
    api_key: Option<&str>,
    extra_headers: &[(String, String)],
    policy: &SsrfPolicy,
    model_id: &str,
    text: &str,
) -> Result<Vec<f32>, String> {
    let (url, http) = build_pinned_client_for_url(
        base_url,
        policy,
        &SystemResolver,
        std::time::Duration::from_secs(60),
    )
    .map_err(|e| redact_host_err(&e.to_string()))?;
    let base = url.as_str().trim_end_matches('/');
    let embed_url = if base.ends_with("/v1") {
        format!("{base}/embeddings")
    } else if base.contains("/v1/") {
        format!("{}/embeddings", base.trim_end_matches('/'))
    } else {
        format!("{base}/v1/embeddings")
    };
    let body = serde_json::json!({
        "model": model_id,
        "input": text,
    });
    let mut req = http.post(embed_url).json(&body);
    for (k, v) in extra_headers {
        req = req.header(k, v);
    }
    if let Some(k) = api_key {
        if !extra_headers
            .iter()
            .any(|(h, _)| h.eq_ignore_ascii_case("Authorization"))
        {
            req = req.bearer_auth(k);
        }
    }
    let resp = req
        .send()
        .await
        .map_err(|e| redact_host_err(&e.to_string()))?;
    let status = resp.status();
    let text_body = resp
        .text()
        .await
        .map_err(|e| redact_host_err(&e.to_string()))?;
    if !status.is_success() {
        return Err(redact_host_err(&format!(
            "embed HTTP {status}: {}",
            text_body.chars().take(160).collect::<String>()
        )));
    }
    let v: serde_json::Value =
        serde_json::from_str(&text_body).map_err(|e| redact_host_err(&e.to_string()))?;
    let arr = v
        .pointer("/data/0/embedding")
        .and_then(|e| e.as_array())
        .ok_or_else(|| "embed_missing_vector".to_string())?;
    let mut out = Vec::with_capacity(arr.len());
    for x in arr {
        let f = x.as_f64().ok_or_else(|| "embed_non_float".to_string())?;
        out.push(f as f32);
    }
    Ok(out)
}

/// Inert tools must not appear as writable host tools.
pub fn assert_inert_tools_only() -> bool {
    inert_probe_tools()
        .iter()
        .all(|t| t.name == INERT_PROBE_TOOL_NAME)
}

/// Export-safe summary: no private base URL, no inventory dump.
pub fn redacted_export_summary(report: &QualificationReportDto) -> String {
    format!(
        "schema={} model={} role_hint={} cancelled={} stale={} checks={}",
        report.schema_version,
        report.model_id,
        report.role_hint,
        report.cancelled,
        report.stale,
        report
            .checks
            .iter()
            .map(|c| format!("{}:{}", c.kind, c.status))
            .collect::<Vec<_>>()
            .join(",")
    )
}

/// Called from host start path so clippy keeps export/privacy helpers live.
pub fn preflight_inert_and_export_guard(sample: Option<&QualificationReportDto>) -> bool {
    let inert_ok = assert_inert_tools_only();
    if let Some(r) = sample {
        let s = redacted_export_summary(r);
        inert_ok && !s.contains("https://") && !s.contains("secret")
    } else {
        inert_ok
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cd_core::capability_qualification::{
        ScriptedQualificationTransport, SyntheticChatResponse, SYNTH_GENERATION_MARKER,
    };
    use cd_core::providers::{ProviderCapabilities, ProviderDeadlinePreference, ProviderKind};

    fn sample_profile(tools: bool) -> ProviderProfile {
        ProviderProfile {
            id: "p1".into(),
            kind: ProviderKind::OpenAiCompatible,
            label: "Test".into(),
            base_url: "https://gateway.example.com/v1".into(),
            chat_model: "gpt-4o".into(),
            api_key_ref: None,
            embedding_model: None,
            embedding_base_url: None,
            local_only: false,
            capabilities: ProviderCapabilities {
                tools,
                stream: true,
                embeddings: false,
            },
            deadline_preference: ProviderDeadlinePreference::Auto,
        }
    }

    #[test]
    fn cache_isolated_by_model_and_endpoint() {
        let mut store = QualificationStore::default();
        let k1 = qualification_key("p1", "https://a.example/v1", "model-a");
        let k2 = qualification_key("p1", "https://a.example/v1", "model-b");
        let k3 = qualification_key("p1", "https://b.example/v1", "model-a");
        assert_ne!(k1.storage_id(), k2.storage_id());
        assert_ne!(k1.storage_id(), k3.storage_id());

        let mut t = ScriptedQualificationTransport {
            chat_queue: vec![
                // reverse pop order: cancel, stream, structured, tool cont, tool call, basic
                Ok(SyntheticChatResponse {
                    content: SYNTH_GENERATION_MARKER.into(),
                    cancelled: true,
                    ..Default::default()
                }),
                Ok(SyntheticChatResponse {
                    content: "x".into(),
                    streamed: true,
                    ..Default::default()
                }),
                Ok(SyntheticChatResponse {
                    content: r#"{"ok":true}"#.into(),
                    ..Default::default()
                }),
                Ok(SyntheticChatResponse {
                    content: "continued".into(),
                    ..Default::default()
                }),
                Ok(SyntheticChatResponse {
                    content: String::new(),
                    tool_calls: vec![SyntheticToolCall {
                        id: "1".into(),
                        name: INERT_PROBE_TOOL_NAME.into(),
                        arguments_json: r#"{"token":"t1"}"#.into(),
                    }],
                    ..Default::default()
                }),
                Ok(SyntheticChatResponse {
                    content: SYNTH_GENERATION_MARKER.into(),
                    ..Default::default()
                }),
            ],
            honor_cancel: true,
            ..Default::default()
        };
        let cancel = Arc::new(AtomicBool::new(false));
        let dto = run_and_store(
            &mut store,
            k1.clone(),
            gate_from_profile(&sample_profile(true), true),
            &mut t,
            &cancel,
        );
        assert_eq!(dto.model_id, "model-a");
        assert!(get_cached_report(&mut store, &k1).is_some());
        assert!(get_cached_report(&mut store, &k2).is_none());
        assert!(clear_report(&mut store, &k1));
        assert!(get_cached_report(&mut store, &k1).is_none());
    }

    #[test]
    fn name_hint_cannot_fill_cache_without_transport() {
        let mut store = QualificationStore::default();
        let key = qualification_key("p1", "https://gateway.example.com/v1", "gpt-4o");
        // Empty scripted transport → fails, no pass from name.
        let mut t = ScriptedQualificationTransport::default();
        let dto = run_and_store(
            &mut store,
            key.clone(),
            gate_from_profile(&sample_profile(true), true),
            &mut t,
            &Arc::new(AtomicBool::new(false)),
        );
        assert!(dto.checks.iter().all(|c| c.status != "pass"));
        assert_eq!(dto.role_hint, "chat");
    }

    #[test]
    fn profile_tools_disabled_authoritative() {
        let mut store = QualificationStore::default();
        let key = qualification_key("p1", "https://gateway.example.com/v1", "gpt-4o");
        let mut t = ScriptedQualificationTransport {
            chat_queue: vec![
                Ok(SyntheticChatResponse {
                    content: SYNTH_GENERATION_MARKER.into(),
                    cancelled: true,
                    ..Default::default()
                }),
                Ok(SyntheticChatResponse {
                    content: "x".into(),
                    streamed: true,
                    ..Default::default()
                }),
                Ok(SyntheticChatResponse {
                    content: r#"{"ok":true}"#.into(),
                    ..Default::default()
                }),
                // tools probes should not consume these if gated
                Ok(SyntheticChatResponse {
                    content: SYNTH_GENERATION_MARKER.into(),
                    ..Default::default()
                }),
            ],
            honor_cancel: true,
            ..Default::default()
        };
        let dto = run_and_store(
            &mut store,
            key,
            gate_from_profile(&sample_profile(false), false),
            &mut t,
            &Arc::new(AtomicBool::new(false)),
        );
        let tools = dto
            .checks
            .iter()
            .find(|c| c.kind == "native_tool_call")
            .expect("tool check");
        assert_eq!(tools.status, "fail");
        assert!(tools.reason.contains("disabled"));
    }

    #[test]
    fn inert_tools_only_and_export_redacted() {
        assert!(assert_inert_tools_only());
        let dto = QualificationReportDto {
            profile_id: "p".into(),
            endpoint_fingerprint: "abc".into(),
            model_id: "m".into(),
            schema_version: QUALIFICATION_SCHEMA_VERSION.into(),
            role_hint: "chat".into(),
            cancelled: false,
            stale: false,
            finished_at: 0,
            checks: vec![CapabilityCheckDto {
                kind: "basic_generation".into(),
                status: "pass".into(),
                elapsed_ms: 1,
                tested_at: 0,
                reason: "ok".into(),
            }],
        };
        let s = redacted_export_summary(&dto);
        assert!(!s.contains("https://"));
        assert!(!s.contains("secret"));
        assert!(s.contains("basic_generation:pass"));
    }

    #[test]
    fn cancel_marks_untested() {
        let mut store = QualificationStore::default();
        let key = qualification_key("p1", "https://gateway.example.com/v1", "gpt-4o");
        let mut t = ScriptedQualificationTransport::default();
        let cancel = Arc::new(AtomicBool::new(true));
        let dto = run_and_store(
            &mut store,
            key,
            gate_from_profile(&sample_profile(true), true),
            &mut t,
            &cancel,
        );
        assert!(dto.cancelled);
        assert!(dto.checks.iter().all(|c| c.status == "untested"));
    }

    #[test]
    fn schema_version_present() {
        assert_eq!(
            QUALIFICATION_SCHEMA_VERSION,
            "contextdesk.capability_qualification.v1"
        );
    }

    #[test]
    fn backend_mapping() {
        assert_eq!(
            backend_for_provider(ProviderKind::Ollama),
            LiveBackendKind::Ollama
        );
        assert_eq!(
            backend_for_provider(ProviderKind::Anthropic),
            LiveBackendKind::Anthropic
        );
        assert_eq!(
            backend_for_provider(ProviderKind::XaiGrokBuild),
            LiveBackendKind::OpenAiCompatible
        );
    }

    #[test]
    fn execute_inert_has_no_filesystem_side_effects() {
        let r = execute_inert_probe_tool(INERT_PROBE_TOOL_NAME, r#"{"token":"abc"}"#).unwrap();
        assert!(r.contains("abc"));
        assert!(execute_inert_probe_tool("rm", "{}").is_err());
        assert!(execute_inert_probe_tool(INERT_PROBE_TOOL_NAME, r#"{"token":"../etc"}"#).is_err());
    }

    #[test]
    fn get_cached_report_surfaces_stale_after_endpoint_change() {
        let mut store = QualificationStore::default();
        let old = qualification_key("p1", "https://a.example.com/v1", "model-x");
        let current = qualification_key("p1", "https://b.example.com/v1", "model-x");
        put_report(
            &mut store,
            QualificationReport {
                key: old,
                checks: vec![],
                role_hint: "chat".into(),
                cancelled: false,
                stale: false,
                finished_at: 0,
            },
        );
        let dto = get_cached_report(&mut store, &current).expect("near-miss stale");
        assert!(dto.stale);
        assert_eq!(dto.model_id, "model-x");
        // Different model: no exact or near-miss (near-miss requires same model_id).
        assert!(get_cached_report(
            &mut store,
            &qualification_key("p1", "https://b.example.com/v1", "other-model")
        )
        .is_none());
    }
}
