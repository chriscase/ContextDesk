//! Host orchestration for explicit synthetic capability qualification (#724).
//!
//! User-triggered only. Live transport uses existing provider clients with
//! synthetic prompts only. Unit tests inject
//! [`cd_core::capability_qualification::ScriptedQualificationTransport`].

#[cfg(test)]
use cd_core::capability_qualification::run_qualification;
#[cfg(test)]
use cd_core::capability_qualification::QUALIFICATION_SCHEMA_VERSION;
use cd_core::capability_qualification::{
    execute_inert_probe_tool, inert_probe_tools, CapabilityStatus, ProfileCapabilityGate,
    QualificationKey, QualificationReport, QualificationStore, QualificationTransport,
    SyntheticChatRequest, SyntheticChatResponse, SyntheticEmbeddingResponse, SyntheticMessage,
    SyntheticRerankResponse, SyntheticToolCall, TransportError, INERT_PROBE_TOOL_NAME,
};
use cd_core::chat::{
    ChatMessage, FunctionCall, OllamaClient, OpenAiCompatibleClient, Role as ChatRole, ToolCallMsg,
};
use cd_core::embed::{EmbedBackend, HttpEmbedBackend, VercelV4EmbedBackend};
use cd_core::openai_chat_contract::{
    dialect_supports_mode, unsupported_mode_reason, ChatBackendDialect,
};
use cd_core::providers::{ProviderKind, ProviderProfile};
use cd_core::rerank::{RerankBackend, VercelV4RerankBackend};
use cd_core::ssrf::SsrfPolicy;
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
    /// Request-mode identity (`plain`, `prompted_json`, `json_object`, …).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_mode: Option<String>,
    /// Backend dialect (`openai_compatible`, `ollama`, `anthropic`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dialect: Option<String>,
    /// Schema strictness when a json_schema probe was measured.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema_strict: Option<bool>,
    /// Schema probe name identity (never a schema body).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema_probe_id: Option<String>,
}

/// Wire DTO for a qualification report (no raw endpoint URL or secrets).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct QualificationReportDto {
    pub profile_id: String,
    pub endpoint_fingerprint: String,
    pub model_id: String,
    pub schema_version: String,
    /// Typed transport protocol (`openai_compatible` / `ollama` / `anthropic`).
    #[serde(default)]
    pub transport_protocol: String,
    pub role_hint: String,
    pub cancelled: bool,
    pub stale: bool,
    pub finished_at: i64,
    pub readiness: cd_core::capability_qualification::ModelReadiness,
    /// Scoped execution contracts shared by CLI and desktop. Each value is
    /// `qualified`, `unqualified`, or `inconclusive`; no contract is inferred
    /// from another contract or from a model-name hint.
    pub contracts: cd_core::capability_qualification::CapabilityContractProjection,
    pub checks: Vec<CapabilityCheckDto>,
}

impl From<&QualificationReport> for QualificationReportDto {
    fn from(r: &QualificationReport) -> Self {
        qualification_report_dto(r, None)
    }
}

/// Build the shared report DTO while honoring the profile's explicit gates.
/// The optional gate is supplied by live hosts; cached/offline callers can
/// omit it and still receive fail-closed report evidence.
pub fn qualification_report_dto(
    r: &QualificationReport,
    gate: Option<&cd_core::capability_qualification::ProfileCapabilityGate>,
) -> QualificationReportDto {
    QualificationReportDto {
        profile_id: r.key.profile_id.clone(),
        endpoint_fingerprint: r.key.endpoint_fingerprint.clone(),
        model_id: r.key.model_id.clone(),
        schema_version: r.key.schema_version.clone(),
        transport_protocol: r.key.transport_protocol.clone(),
        role_hint: r.role_hint.clone(),
        cancelled: r.cancelled,
        stale: r.stale,
        finished_at: r.finished_at,
        readiness: cd_core::capability_qualification::model_readiness_for_report(r),
        contracts: cd_core::capability_qualification::capability_contract_projection(Some(r), gate),
        checks: r
            .checks
            .iter()
            .map(|c| CapabilityCheckDto {
                kind: c.kind.as_str().to_string(),
                status: status_wire(c.status).to_string(),
                elapsed_ms: c.elapsed_ms,
                tested_at: c.tested_at,
                reason: c.reason.clone(),
                request_mode: c.request_mode.clone(),
                dialect: c.dialect.clone(),
                schema_strict: c.schema_strict,
                schema_probe_id: c.schema_probe_id.clone(),
            })
            .collect(),
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

/// Build a cache key for the selected profile/endpoint/model (OpenAI-compatible default).
pub fn qualification_key(profile_id: &str, base_url: &str, model_id: &str) -> QualificationKey {
    QualificationKey::new(profile_id, base_url, model_id)
}

/// Build a cache key bound to the configured provider kind's transport protocol.
pub fn qualification_key_for_profile(
    profile: &ProviderProfile,
    model_id: &str,
) -> QualificationKey {
    QualificationKey::with_provider_kind(&profile.id, &profile.base_url, model_id, profile.kind)
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

/// Gate for one explicitly selected model. A specialty model returned by a
/// gateway may be probed for its hinted role even when the profile was first
/// created as chat-only; the explicit Verify action is the user's consent to
/// test that endpoint contract. Name hints still never produce a pass.
pub fn gate_for_model(
    profile: &ProviderProfile,
    tools_enabled_for_model: bool,
    model_id: &str,
) -> ProfileCapabilityGate {
    let mut gate = gate_from_profile(profile, tools_enabled_for_model);
    if matches!(
        cd_core::model_role_hints::classify_model_role(model_id).role,
        cd_core::model_role_hints::ModelRoleHint::Embedding
    ) {
        gate.embeddings_enabled = true;
    }
    gate
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
    get_cached_report_with_gate(store, current, None)
}

/// Cached report projection with the host's explicit capability gate.
pub fn get_cached_report_with_gate(
    store: &mut QualificationStore,
    current: &QualificationKey,
    gate: Option<&cd_core::capability_qualification::ProfileCapabilityGate>,
) -> Option<QualificationReportDto> {
    store
        .get_for_selection(current)
        .map(|report| qualification_report_dto(report, gate))
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

/// Store a finished report and project it with the exact host gates used for
/// the run. This keeps an explicit tools-off configuration from becoming a
/// stale native-tool capability claim in either client.
pub fn put_report_with_gate(
    store: &mut QualificationStore,
    report: QualificationReport,
    gate: &cd_core::capability_qualification::ProfileCapabilityGate,
) -> QualificationReportDto {
    let dto = qualification_report_dto(&report, Some(gate));
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
    put_report_with_gate(store, report, &gate)
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

    fn dialect(&self) -> ChatBackendDialect {
        match self.kind {
            LiveBackendKind::OpenAiCompatible => ChatBackendDialect::OpenAiCompatible,
            LiveBackendKind::Ollama => ChatBackendDialect::Ollama,
            LiveBackendKind::Anthropic => ChatBackendDialect::Anthropic,
        }
    }

    fn map_completion(
        content: String,
        tool_calls: Vec<ToolCallMsg>,
        streamed: bool,
        cancelled: bool,
        dialect: ChatBackendDialect,
        mode_transmitted: bool,
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
            dialect: Some(dialect.as_str().into()),
            mode_transmitted,
        }
    }

    /// Refuse OpenAI-native modes on dialects that cannot transmit them.
    fn refuse_unsupported_mode(&self, req: &SyntheticChatRequest) -> Result<(), TransportError> {
        let dialect = self.dialect();
        if !dialect_supports_mode(dialect, &req.chat_mode) {
            return Err(TransportError {
                reason: unsupported_mode_reason(dialect, &req.chat_mode),
            });
        }
        // Forced tool without tools is a host misconfiguration — fail closed.
        if matches!(
            &req.chat_mode,
            cd_core::openai_chat_contract::OpenAiChatRequestMode::ForcedTool { .. }
        ) && req.tools.is_empty()
        {
            return Err(TransportError {
                reason: format!("missing_forced_tools:mode={}", req.chat_mode.evidence_id()),
            });
        }
        Ok(())
    }

    async fn chat_openai(
        &self,
        req: &SyntheticChatRequest,
        cancel: &AtomicBool,
    ) -> Result<SyntheticChatResponse, TransportError> {
        self.refuse_unsupported_mode(req)?;
        let dialect = ChatBackendDialect::OpenAiCompatible;
        if cancel.load(Ordering::SeqCst) {
            return Ok(SyntheticChatResponse {
                cancelled: true,
                dialect: Some(dialect.as_str().into()),
                mode_transmitted: false,
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
                .complete_stream_cb_with_mode(
                    &messages,
                    tools,
                    &req.chat_mode,
                    |_| {},
                    Some(cancel),
                )
                .await;
            match result {
                Ok(comp) => Ok(Self::map_completion(
                    comp.content,
                    comp.tool_calls,
                    true,
                    cancel.load(Ordering::SeqCst),
                    dialect,
                    true,
                )),
                Err(e) => {
                    let msg = e.to_string();
                    if msg.contains("cancelled") || cancel.load(Ordering::SeqCst) {
                        Ok(SyntheticChatResponse {
                            cancelled: true,
                            streamed: true,
                            dialect: Some(dialect.as_str().into()),
                            mode_transmitted: true,
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
            // Honor typed chat mode (response_format / forced tool). Never discard;
            // never silent mid-turn downgrade when the gateway rejects the mode.
            match client
                .complete_with_mode(&messages, tools, &req.chat_mode)
                .await
            {
                Ok(comp) => Ok(Self::map_completion(
                    comp.content,
                    comp.tool_calls,
                    false,
                    cancel.load(Ordering::SeqCst),
                    dialect,
                    true,
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
        // OpenAI-native modes are never silently sent as ordinary chat.
        self.refuse_unsupported_mode(req)?;
        let dialect = ChatBackendDialect::Ollama;
        if cancel.load(Ordering::SeqCst) {
            return Ok(SyntheticChatResponse {
                cancelled: true,
                dialect: Some(dialect.as_str().into()),
                mode_transmitted: false,
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
        // Only plain / prompted_json reach here (native modes refused above).
        match client.complete(&messages, tools).await {
            Ok(comp) => Ok(Self::map_completion(
                comp.content,
                comp.tool_calls,
                false,
                cancel.load(Ordering::SeqCst),
                dialect,
                true, // plain/prompted modes were transmitted as ordinary chat
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
        self.refuse_unsupported_mode(req)?;
        let dialect = ChatBackendDialect::Anthropic;
        if cancel.load(Ordering::SeqCst) {
            return Ok(SyntheticChatResponse {
                cancelled: true,
                dialect: Some(dialect.as_str().into()),
                mode_transmitted: false,
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
                    dialect,
                    true,
                )),
                Err(e) => {
                    let msg = e.to_string();
                    if msg.contains("cancelled") || cancel.load(Ordering::SeqCst) {
                        Ok(SyntheticChatResponse {
                            cancelled: true,
                            streamed: true,
                            dialect: Some(dialect.as_str().into()),
                            mode_transmitted: true,
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
                    dialect,
                    true,
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
        model_id: &str,
        query: &str,
        document_ids: &[&str],
        cancel: &AtomicBool,
    ) -> Result<SyntheticRerankResponse, TransportError> {
        if cancel.load(Ordering::SeqCst) {
            return Err(TransportError {
                reason: "cancelled".into(),
            });
        }
        if !matches!(self.kind, LiveBackendKind::OpenAiCompatible) {
            return Ok(SyntheticRerankResponse {
                ranked_ids: vec![],
                raw_error: Some("reranking_not_supported_for_this_provider_protocol".into()),
            });
        }
        let base = self.base_url.clone();
        let key = self.api_key.clone();
        let headers = self.extra_headers.clone();
        let policy = self.ssrf_policy();
        let model = model_id.to_string();
        let query = query.to_string();
        let documents = document_ids
            .iter()
            .map(|document| (*document).to_string())
            .collect::<Vec<_>>();
        Self::block_on(async move {
            let result = if is_vercel_ai_gateway(&base) {
                vercel_v4_rerank(&key, &headers, &policy, &model, &query, &documents).await
            } else {
                generic_rerank(
                    &base,
                    key.as_deref(),
                    &headers,
                    &policy,
                    &model,
                    &query,
                    &documents,
                )
                .await
            };
            match result {
                Ok(indices) => Ok(SyntheticRerankResponse {
                    ranked_ids: indices
                        .into_iter()
                        .filter_map(|index| documents.get(index).cloned())
                        .collect(),
                    raw_error: None,
                }),
                Err(error) => Ok(SyntheticRerankResponse {
                    ranked_ids: Vec::new(),
                    raw_error: Some(error),
                }),
            }
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
    if is_vercel_ai_gateway(base_url) {
        return vercel_v4_embed(api_key, extra_headers, policy, model_id, text).await;
    }
    let backend = HttpEmbedBackend::new_with_policy(
        base_url,
        model_id.to_string(),
        api_key.map(str::to_string),
        policy,
    )
    .map_err(|error| redact_host_err(&error.to_string()))?
    .with_extra_headers(extra_headers.to_vec());
    backend
        .embed(&[text.to_string()])
        .await
        .map_err(|error| redact_host_err(&error.to_string()))?
        .into_iter()
        .next()
        .ok_or_else(|| "embed_missing_vector".to_string())
}

fn is_vercel_ai_gateway(base_url: &str) -> bool {
    url::Url::parse(base_url)
        .ok()
        .and_then(|url| url.host_str().map(str::to_string))
        .is_some_and(|host| host == "ai-gateway.vercel.sh")
}

async fn vercel_v4_embed(
    api_key: Option<&str>,
    extra_headers: &[(String, String)],
    policy: &SsrfPolicy,
    model_id: &str,
    text: &str,
) -> Result<Vec<f32>, String> {
    let backend = VercelV4EmbedBackend::new_with_policy(
        "https://ai-gateway.vercel.sh/v4/ai",
        model_id.to_string(),
        api_key.map(str::to_string),
        policy,
    )
    .map_err(|error| redact_host_err(&error.to_string()))?
    .with_extra_headers(extra_headers.to_vec());
    backend
        .embed(&[text.to_string()])
        .await
        .map_err(|error| redact_host_err(&error.to_string()))?
        .into_iter()
        .next()
        .ok_or_else(|| "embed_missing_vector".to_string())
}

async fn vercel_v4_rerank(
    api_key: &Option<String>,
    extra_headers: &[(String, String)],
    policy: &SsrfPolicy,
    model_id: &str,
    query: &str,
    documents: &[String],
) -> Result<Vec<usize>, String> {
    let backend = VercelV4RerankBackend::new_with_policy(
        "https://ai-gateway.vercel.sh/v4/ai",
        model_id.to_string(),
        api_key.clone(),
        policy,
    )
    .map_err(|error| redact_host_err(&error.to_string()))?
    .with_extra_headers(extra_headers.to_vec());
    let scores = backend
        .rerank(query, documents)
        .await
        .map_err(|error| redact_host_err(&error.to_string()))?;
    let mut indices: Vec<usize> = (0..scores.len()).collect();
    indices.sort_by(|left, right| {
        scores[*right]
            .partial_cmp(&scores[*left])
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| left.cmp(right))
    });
    Ok(indices)
}

async fn generic_rerank(
    base_url: &str,
    api_key: Option<&str>,
    extra_headers: &[(String, String)],
    policy: &SsrfPolicy,
    model_id: &str,
    query: &str,
    documents: &[String],
) -> Result<Vec<usize>, String> {
    let backend = cd_core::rerank::HttpRerankBackend::new_with_policy(
        base_url,
        model_id.to_string(),
        api_key.map(str::to_string),
        policy,
    )
    .map_err(|error| redact_host_err(&error.to_string()))?
    .with_extra_headers(extra_headers.to_vec());
    let scores = backend
        .rerank(query, documents)
        .await
        .map_err(|error| redact_host_err(&error.to_string()))?;
    let mut indices: Vec<usize> = (0..scores.len()).collect();
    indices.sort_by(|left, right| {
        scores[*right]
            .partial_cmp(&scores[*left])
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| left.cmp(right))
    });
    Ok(indices)
}

#[cfg(test)]
fn parse_ranking_indices(
    body: &serde_json::Value,
    document_count: usize,
    pointer: &str,
) -> Result<Vec<usize>, String> {
    let rows = body
        .pointer(pointer)
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| "reranking response missing ranking rows".to_string())?;
    if rows.len() != document_count {
        return Err("reranking response count did not match documents".into());
    }
    let mut seen = std::collections::BTreeSet::new();
    let mut indices = Vec::with_capacity(rows.len());
    for row in rows {
        let index = row
            .get("index")
            .and_then(serde_json::Value::as_u64)
            .and_then(|index| usize::try_from(index).ok())
            .ok_or_else(|| "reranking response contains an invalid index".to_string())?;
        let score = row
            .get("relevanceScore")
            .or_else(|| row.get("relevance_score"))
            .and_then(serde_json::Value::as_f64)
            .ok_or_else(|| "reranking response contains an invalid score".to_string())?;
        if index >= document_count || !score.is_finite() || !seen.insert(index) {
            return Err("reranking response contains an invalid row".into());
        }
        indices.push(index);
    }
    Ok(indices)
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
            .map(|c| {
                let mode = c.request_mode.as_deref().unwrap_or("-");
                let dialect = c.dialect.as_deref().unwrap_or("-");
                let strict = c
                    .schema_strict
                    .map(|s| if s { "strict" } else { "nonstrict" })
                    .unwrap_or("-");
                let schema_id = c.schema_probe_id.as_deref().unwrap_or("-");
                format!(
                    "{}:{}:mode={}:dialect={}:schema={}:{}",
                    c.kind, c.status, mode, dialect, schema_id, strict
                )
            })
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
        ContractVerdict, ScriptedQualificationTransport, SyntheticChatResponse,
        SYNTH_GENERATION_MARKER,
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
            transport_protocol: "openai_compatible".into(),
            role_hint: "chat".into(),
            cancelled: false,
            stale: false,
            finished_at: 0,
            readiness: cd_core::capability_qualification::ModelReadiness::unverified("m"),
            contracts: cd_core::capability_qualification::CapabilityContractProjection::default(),
            checks: vec![CapabilityCheckDto {
                kind: "basic_generation".into(),
                status: "pass".into(),
                elapsed_ms: 1,
                tested_at: 0,
                reason: "ok".into(),
                request_mode: Some("plain".into()),
                dialect: Some("openai_compatible".into()),
                schema_strict: None,
                schema_probe_id: None,
            }],
        };
        let s = redacted_export_summary(&dto);
        assert!(!s.contains("https://"));
        assert!(!s.contains("secret"));
        assert!(s.contains("basic_generation:pass"));
        assert!(s.contains("mode=plain"));
        assert!(s.contains("dialect=openai_compatible"));
        // No schema bodies or private endpoints in export.
        assert!(!s.contains("properties"));
        assert!(!s.contains("additionalProperties"));
    }

    #[test]
    fn report_dto_projects_mode_and_dialect_fields() {
        use cd_core::capability_qualification::{
            CapabilityCheckResult, CapabilityKind, CapabilityStatus, QualificationReport,
        };
        let report = QualificationReport {
            key: qualification_key("p", "https://private.example/v1", "m"),
            checks: vec![CapabilityCheckResult {
                kind: CapabilityKind::StructuredJsonObject,
                status: CapabilityStatus::Pass,
                elapsed_ms: 1,
                tested_at: 1,
                reason: "ok".into(),
                request_mode: Some("json_object".into()),
                dialect: Some("openai_compatible".into()),
                schema_strict: None,
                schema_probe_id: None,
            }],
            role_hint: "chat".into(),
            cancelled: false,
            stale: false,
            finished_at: 1,
        };
        let dto = QualificationReportDto::from(&report);
        assert_eq!(dto.checks[0].request_mode.as_deref(), Some("json_object"));
        assert_eq!(dto.checks[0].dialect.as_deref(), Some("openai_compatible"));
        assert_eq!(dto.schema_version, QUALIFICATION_SCHEMA_VERSION);
        let s = redacted_export_summary(&dto);
        assert!(!s.contains("private.example"));
        assert!(s.contains("mode=json_object"));
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
        assert_eq!(
            dto.contracts.host_grounded_generation,
            ContractVerdict::Inconclusive
        );
        assert_eq!(
            dto.contracts.validated_structured_proposal,
            ContractVerdict::Inconclusive
        );
        assert_eq!(
            dto.contracts.native_tool_loop,
            ContractVerdict::Inconclusive
        );
    }

    #[test]
    fn schema_version_present() {
        assert_eq!(
            QUALIFICATION_SCHEMA_VERSION,
            "contextdesk.capability_qualification.v4"
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
        let r = execute_inert_probe_tool(INERT_PROBE_TOOL_NAME, r#"{"token":"QUALIFY_TOOL_V1"}"#)
            .unwrap();
        assert!(r.contains("QUALIFY_TOOL_V1"));
        assert!(execute_inert_probe_tool("rm", "{}").is_err());
        assert!(execute_inert_probe_tool(INERT_PROBE_TOOL_NAME, r#"{"token":"../etc"}"#).is_err());
        assert!(
            execute_inert_probe_tool(INERT_PROBE_TOOL_NAME, r#"{"token":"WRONG"}"#)
                .unwrap_err()
                .contains("wrong_token")
        );
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

    #[test]
    fn sibling_model_cache_not_mutated_when_selecting_other_model() {
        // #650 host path: get_cached_report for model-a must not stale model-b.
        let mut store = QualificationStore::default();
        put_report(
            &mut store,
            QualificationReport {
                key: qualification_key("p1", "https://a.example.com/v1", "model-a"),
                checks: vec![],
                role_hint: "chat".into(),
                cancelled: false,
                stale: false,
                finished_at: 0,
            },
        );
        put_report(
            &mut store,
            QualificationReport {
                key: qualification_key("p1", "https://a.example.com/v1", "model-b"),
                checks: vec![],
                role_hint: "chat".into(),
                cancelled: false,
                stale: false,
                finished_at: 0,
            },
        );
        let dto = get_cached_report(
            &mut store,
            &qualification_key("p1", "https://b.example.com/v1", "model-a"),
        )
        .expect("stale near-miss for model-a");
        assert!(dto.stale);
        assert_eq!(dto.model_id, "model-a");
        let sib = store
            .get(&qualification_key(
                "p1",
                "https://a.example.com/v1",
                "model-b",
            ))
            .expect("sibling retained");
        assert!(
            !sib.stale,
            "sibling model-b must not be marked stale when selecting model-a"
        );
    }

    #[test]
    fn rerank_parsers_accept_v4_and_generic_score_names() {
        let v4 = serde_json::json!({
            "ranking": [
                {"index": 1, "relevanceScore": 0.9},
                {"index": 0, "relevanceScore": 0.2}
            ]
        });
        assert_eq!(parse_ranking_indices(&v4, 2, "/ranking").unwrap(), [1, 0]);

        let generic = serde_json::json!({
            "results": [
                {"index": 0, "relevance_score": 0.7},
                {"index": 1, "relevance_score": 0.1}
            ]
        });
        assert_eq!(
            parse_ranking_indices(&generic, 2, "/results").unwrap(),
            [0, 1]
        );
    }

    #[test]
    fn rerank_parser_rejects_partial_duplicate_or_non_finite_rows() {
        let partial = serde_json::json!({"ranking": [{"index": 0, "relevanceScore": 1.0}]});
        assert!(parse_ranking_indices(&partial, 2, "/ranking").is_err());
        let duplicate = serde_json::json!({
            "results": [
                {"index": 0, "relevance_score": 0.9},
                {"index": 0, "relevance_score": 0.8}
            ]
        });
        assert!(parse_ranking_indices(&duplicate, 2, "/results").is_err());
    }
}
