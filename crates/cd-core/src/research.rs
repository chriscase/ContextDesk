//! Offline and host research entry points (real tool path, no demo shell).

use crate::agent::{
    run_agent_turn, run_agent_turn_with_sink_and_checkpoint, AgentOptions, ChatBackend,
    LinkedSynthesisCheckpoint, ScriptedBackend,
};
use crate::audit::AuditLog;
use crate::chat::{
    AnthropicClient, ChatCompletion, ChatMessage, FunctionCall, OllamaClient,
    OpenAiCompatibleClient, Role, StreamDelta, ToolCallMsg,
};
use crate::error::CoreError;
use crate::error::CoreResult;
use crate::events::StreamEvent;
use crate::index::KeywordIndex;
use crate::permissions::PermissionDecision;
use crate::providers::{ProviderCapabilities, ProviderKind, ProviderProfile};
use crate::ssrf::SsrfPolicy;
use crate::tool_host::ToolHost;
use crate::tools::ToolSpec;
use crate::turn_trace::{DryRunBackend, TracingChatBackend, TurnTraceSink};
use crate::workspace::Workspace;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::future::Future;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::time::Instant;

/// Serialized stream event for IPC/JSON.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventDto {
    /// Discriminator.
    pub kind: String,
    /// JSON payload.
    pub payload: serde_json::Value,
}

/// Convert one stream event to a host DTO.
pub fn event_to_dto(e: &StreamEvent) -> EventDto {
    let (kind, payload) = match e {
        StreamEvent::TurnStarted { session_id, model } => (
            "turn_started",
            serde_json::json!({ "session_id": session_id, "model": model }),
        ),
        StreamEvent::TurnPhase { phase } => ("turn_phase", serde_json::json!({ "phase": phase })),
        StreamEvent::LinkedSynthesisRetry {
            available,
            session_id,
            corpus_id,
            provider_profile_id,
            model_id,
        } => (
            "linked_synthesis_retry",
            serde_json::json!({
                "available": available,
                "session_id": session_id,
                "corpus_id": corpus_id,
                "provider_profile_id": provider_profile_id,
                "model_id": model_id,
            }),
        ),
        StreamEvent::TextDelta { text } => ("text_delta", serde_json::json!({ "text": text })),
        StreamEvent::ThoughtDelta { text } => {
            ("thought_delta", serde_json::json!({ "text": text }))
        }
        StreamEvent::Tool {
            id,
            name,
            phase,
            summary,
            detail,
            ok,
        } => (
            "tool",
            serde_json::json!({
                "id": id, "name": name, "phase": phase,
                "summary": summary, "detail": detail, "ok": ok
            }),
        ),
        StreamEvent::Citation {
            source_id,
            label,
            locator,
            corpus_id,
        } => {
            let mut payload = serde_json::json!({
                "source_id": source_id, "label": label, "locator": locator
            });
            if let Some(corpus) = corpus_id {
                payload["corpus_id"] = serde_json::json!(corpus);
            }
            ("citation", payload)
        }
        StreamEvent::SearchTrail { steps } => {
            ("search_trail", serde_json::json!({ "steps": steps }))
        }
        StreamEvent::PermissionRequired {
            request_id,
            tool_name,
            target,
            reason,
            preview,
            risk,
            arguments,
        } => (
            "permission_required",
            serde_json::json!({
                "request_id": request_id,
                "tool_name": tool_name,
                "target": target,
                "reason": reason,
                "preview": preview,
                "risk": risk,
                "arguments": arguments,
            }),
        ),
        StreamEvent::TurnCompleted { reason } => {
            ("turn_completed", serde_json::json!({ "reason": reason }))
        }
        StreamEvent::Error { code, message } => (
            "error",
            serde_json::json!({ "code": code, "message": message }),
        ),
    };
    EventDto {
        kind: kind.into(),
        payload,
    }
}

/// Convert stream events to DTOs.
pub fn events_to_dto(events: &[StreamEvent]) -> Vec<EventDto> {
    events.iter().map(event_to_dto).collect()
}

/// Build a tool host for a workspace (in-memory index; no disk cache).
///
/// # Embed host example
///
/// See the runnable example: `cargo run -p cd-core --example embed_host -- <dir> "<query>"`
/// (`crates/cd-core/examples/embed_host.rs`, docs/examples/host-adapter.md).
///
/// ```no_run
/// use cd_core::research::{build_host, events_to_dto, research_local};
/// use cd_core::workspace::Workspace;
/// # async fn demo() -> Result<(), Box<dyn std::error::Error>> {
/// let ws = Workspace::new("embed", vec!["/tmp/notes".into()]);
/// let mut host = build_host(ws, None)?;
/// let events = research_local(&mut host, "payments", "s1").await?;
/// for dto in events_to_dto(&events) {
///     println!("{} {}", dto.kind, dto.payload);
/// }
/// # Ok(())
/// # }
/// ```
pub fn build_host(workspace: Workspace, audit_path: Option<PathBuf>) -> CoreResult<ToolHost> {
    build_host_with_index_cache(workspace, audit_path, None)
}

/// Build a tool host with an optional persistent index cache directory.
pub fn build_host_with_index_cache(
    workspace: Workspace,
    audit_path: Option<PathBuf>,
    index_cache_dir: Option<PathBuf>,
) -> CoreResult<ToolHost> {
    build_host_with_options(workspace, audit_path, index_cache_dir, None, None, None)
}

/// Build host with index cache, file cap, index byte budget, and router budget.
///
/// `index_max_bytes` bounds the resident index working set (`None`/`0` → default,
/// #117). The on-disk store still holds every chunk.
#[allow(clippy::too_many_arguments)]
pub fn build_host_with_options(
    workspace: Workspace,
    audit_path: Option<PathBuf>,
    index_cache_dir: Option<PathBuf>,
    index_max_files: Option<usize>,
    index_max_bytes: Option<usize>,
    router: Option<crate::router::RouterBudget>,
) -> CoreResult<ToolHost> {
    build_host_with_connectors(
        workspace,
        audit_path,
        index_cache_dir,
        index_max_files,
        index_max_bytes,
        router,
        &[],
    )
}

/// Build host and attach workspace connector configs (#127).
///
/// `index_max_bytes` bounds the resident index working set (`None`/`0` → default);
/// the on-disk store still holds every chunk (#115/#117).
#[allow(clippy::too_many_arguments)]
pub fn build_host_with_connectors(
    workspace: Workspace,
    audit_path: Option<PathBuf>,
    index_cache_dir: Option<PathBuf>,
    index_max_files: Option<usize>,
    index_max_bytes: Option<usize>,
    router: Option<crate::router::RouterBudget>,
    connectors: &[crate::connectors::ConnectorConfig],
) -> CoreResult<ToolHost> {
    let index = KeywordIndex::open_or_build_bounded(
        &workspace,
        index_cache_dir.as_deref(),
        index_max_files,
        index_max_bytes,
    )?;
    let audit = audit_path.map(AuditLog::new);
    let mut host = ToolHost::new(workspace, index, audit);
    if let Some(b) = router {
        host.set_router_budget(b);
    }
    host.attach_connectors(connectors);
    // Product seam: attach durable memory (default ON per MEMORY.md §10).
    // Desktop rebuild_host re-attaches with AppConfig.memory; this path covers
    // server/local research and tests that use build_host*.
    let branding = crate::branding::Branding::embedded();
    if let Err(e) = crate::memory::attach_durable_memory_to_host(
        &mut host,
        &branding,
        &crate::memory::MemoryConfig::default(),
    ) {
        tracing::warn!(error = %e, "durable memory attach failed; tools fall back to memory_fs");
    }
    Ok(host)
}

// Note: open_or_build third arg is max_files.

/// Local research without an LLM: search_kb + cited synthesis from hits.
/// This is a real shipped entry point used when no model is available and in fixtures.
pub async fn research_local(
    host: &mut ToolHost,
    query: &str,
    session_id: &str,
) -> CoreResult<Vec<StreamEvent>> {
    research_local_with_skills(host, query, session_id, &[]).await
}

/// Local research with optional skill directories for `/skill` slash invoke.
pub async fn research_local_with_skills(
    host: &mut ToolHost,
    query: &str,
    session_id: &str,
    skill_dirs: &[std::path::PathBuf],
) -> CoreResult<Vec<StreamEvent>> {
    let mut events = vec![StreamEvent::TurnStarted {
        session_id: session_id.into(),
        model: Some("local-retrieval".into()),
    }];

    let mut query = query.to_string();
    let mut skill_note = String::new();
    if let Some((sid, rest)) = crate::skills::parse_skill_slash(&query) {
        let skills = crate::skills::discover_skills(skill_dirs).unwrap_or_default();
        if let Some(sk) = crate::skills::find_skill(&skills, &sid) {
            if sk.disabled {
                skill_note = format!(
                    "_Skill `{}` is disabled (review-gated). Enable it in Settings before use._\n\n",
                    sk.id
                );
            } else {
                skill_note = format!("{}\n\n", crate::skills::skill_context(sk));
                events.push(StreamEvent::SearchTrail {
                    steps: vec![format!("skill:{}", sk.id)],
                });
            }
        } else {
            skill_note = format!("_Skill `{sid}` not found in skill dirs._\n\n");
        }
        query = if rest.is_empty() { sid } else { rest };
    }

    let result = host
        .execute(
            "search_kb",
            &serde_json::json!({ "query": query, "limit": 8 }),
            None,
        )
        .await?;
    events.extend(result.events.clone());
    let budget = host.router_budget().clone();
    host.set_max_results_per_source(budget.max_results_per_source);
    let ranked = crate::router::rank_sources(
        &query,
        &[
            crate::router::SourceKind::Memory,
            crate::router::SourceKind::Files,
        ],
        &budget,
    );
    let mut trail = crate::router::trail_for(&ranked);
    trail.insert(0, budget.trail_step());
    trail.push("tool:search_kb".into());
    events.push(StreamEvent::SearchTrail { steps: trail });

    if let Some(path) = &result.citation_path {
        events.push(StreamEvent::Citation {
            source_id: path.clone(),
            label: path.clone(),
            locator: None,
            corpus_id: None,
        });
    }

    let answer = if result.ok && !result.detail_raw.contains("No hits") {
        format!(
            "### Research results\n\n{skill_note}Query: **{}**\n\n{}\n\n_Sources cited from workspace search._\n",
            query, result.detail_raw
        )
    } else {
        format!(
            "### Research results\n\n{skill_note}No indexed hits for **{}**. Add workspace roots and reindex, or rephrase.\n",
            query
        )
    };

    for chunk in chunk_text(&answer, 64) {
        events.push(StreamEvent::TextDelta { text: chunk });
    }
    events.push(StreamEvent::TurnCompleted {
        reason: "stop".into(),
    });
    Ok(events)
}

fn chunk_text(s: &str, size: usize) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    for ch in s.chars() {
        cur.push(ch);
        if cur.chars().count() >= size {
            out.push(std::mem::take(&mut cur));
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

struct OllamaBackend(OllamaClient);

#[async_trait]
impl ChatBackend for OllamaBackend {
    async fn complete(
        &self,
        messages: &[ChatMessage],
        tools: &[ToolSpec],
    ) -> CoreResult<ChatCompletion> {
        // Pass tools when present (mistral/llama tool-capable models). Empty
        // tools still works for plain chat; agent JSON fallback remains.
        let tools = if tools.is_empty() { None } else { Some(tools) };
        self.0.complete(messages, tools).await
    }
}

struct OpenAiBackend(OpenAiCompatibleClient);

#[async_trait]
impl ChatBackend for OpenAiBackend {
    async fn complete(
        &self,
        messages: &[ChatMessage],
        tools: &[ToolSpec],
    ) -> CoreResult<ChatCompletion> {
        // Prefer live SSE callback path; fall back to non-stream.
        match self
            .0
            .complete_stream_cb(messages, Some(tools), |_| {}, None)
            .await
        {
            Ok(c) => Ok(c),
            Err(_) => self.0.complete(messages, Some(tools)).await,
        }
    }

    async fn complete_streaming(
        &self,
        messages: &[ChatMessage],
        tools: &[ToolSpec],
        on_text: &mut (dyn FnMut(String) + Send),
        cancel: Option<&std::sync::atomic::AtomicBool>,
    ) -> CoreResult<ChatCompletion> {
        match self
            .0
            .complete_stream_cb(
                messages,
                Some(tools),
                |d| {
                    if let StreamDelta::Text(t) = d {
                        if !t.is_empty() {
                            on_text(t);
                        }
                    }
                },
                cancel,
            )
            .await
        {
            Ok(c) => Ok(c),
            Err(e) if e.to_string().contains("cancelled") => Err(e),
            Err(_) => {
                // Fall back to non-stream; emit once.
                let c = self.0.complete(messages, Some(tools)).await?;
                if !c.content.is_empty() && c.tool_calls.is_empty() {
                    on_text(c.content.clone());
                }
                Ok(c)
            }
        }
    }
}

struct AnthropicBackend(AnthropicClient);

#[async_trait]
impl ChatBackend for AnthropicBackend {
    async fn complete(
        &self,
        messages: &[ChatMessage],
        tools: &[ToolSpec],
    ) -> CoreResult<ChatCompletion> {
        match self
            .0
            .complete_stream_cb(messages, Some(tools), |_| {}, None)
            .await
        {
            Ok(c) => Ok(c),
            Err(_) => self.0.complete(messages, Some(tools)).await,
        }
    }

    async fn complete_streaming(
        &self,
        messages: &[ChatMessage],
        tools: &[ToolSpec],
        on_text: &mut (dyn FnMut(String) + Send),
        cancel: Option<&std::sync::atomic::AtomicBool>,
    ) -> CoreResult<ChatCompletion> {
        match self
            .0
            .complete_stream_cb(
                messages,
                Some(tools),
                |d| {
                    if let StreamDelta::Text(t) = d {
                        if !t.is_empty() {
                            on_text(t);
                        }
                    }
                },
                cancel,
            )
            .await
        {
            Ok(c) => Ok(c),
            Err(e) if e.to_string().contains("cancelled") => Err(e),
            Err(_) => {
                let c = self.0.complete(messages, Some(tools)).await?;
                if !c.content.is_empty() && c.tool_calls.is_empty() {
                    on_text(c.content.clone());
                }
                Ok(c)
            }
        }
    }
}

/// Honor profile capability flags: strip tools when disabled; skip stream when
/// `stream` is false (#125). Does not swallow rejections — non-stream path is explicit.
pub struct CapabilityAwareBackend {
    inner: Box<dyn ChatBackend>,
    caps: ProviderCapabilities,
}

impl CapabilityAwareBackend {
    /// Wrap a constructed backend with profile capabilities.
    pub fn new(inner: Box<dyn ChatBackend>, caps: ProviderCapabilities) -> Self {
        Self { inner, caps }
    }
}

#[async_trait]
impl ChatBackend for CapabilityAwareBackend {
    async fn complete(
        &self,
        messages: &[ChatMessage],
        tools: &[ToolSpec],
    ) -> CoreResult<ChatCompletion> {
        let tools = if self.caps.tools { tools } else { &[] };
        self.inner.complete(messages, tools).await
    }

    async fn complete_streaming(
        &self,
        messages: &[ChatMessage],
        tools: &[ToolSpec],
        on_text: &mut (dyn FnMut(String) + Send),
        cancel: Option<&std::sync::atomic::AtomicBool>,
    ) -> CoreResult<ChatCompletion> {
        let tools = if self.caps.tools { tools } else { &[] };
        if !self.caps.stream {
            // Explicit non-stream path — no attempt-then-catch mask.
            let c = self.inner.complete(messages, tools).await?;
            if !c.content.is_empty() && c.tool_calls.is_empty() {
                on_text(c.content.clone());
            }
            return Ok(c);
        }
        match self
            .inner
            .complete_streaming(messages, tools, on_text, cancel)
            .await
        {
            Ok(c) => Ok(c),
            Err(e) => {
                // Let agent classify tool_choice/vLLM rejections — do not re-wrap as stream errors.
                if crate::agent::is_tools_unsupported_error(&e) {
                    return Err(e);
                }
                // Surface stream rejection rather than silent success-with-empty.
                let msg = e.to_string().to_lowercase();
                if msg.contains("stream")
                    || msg.contains("sse")
                    || (msg.contains("not support") && !msg.contains("tool"))
                    || (msg.contains("unsupported") && !msg.contains("tool"))
                {
                    return Err(CoreError::Message(format!(
                        "Streaming rejected by provider (capabilities.stream=true but request failed): {e}"
                    )));
                }
                Err(e)
            }
        }
    }
}

/// Build a SSRF-pinned HTTP client for Grok OIDC token refresh (#141 / #251).
///
/// **Fail closed:** if pin/resolve rejects (e.g. hostname → private IP), returns
/// `Err` — never constructs an unpinned `reqwest::Client`.
pub fn pinned_oidc_refresh_client(
    refresh_url: &str,
    policy: &SsrfPolicy,
    resolver: &impl crate::ssrf::DnsResolver,
    timeout: std::time::Duration,
) -> CoreResult<reqwest::Client> {
    let url = if refresh_url.trim().starts_with("http") {
        refresh_url.trim()
    } else {
        "https://auth.x.ai"
    };
    match crate::ssrf::build_pinned_client_for_url(url, policy, resolver, timeout) {
        Ok((_u, c)) => Ok(c),
        Err(e) => Err(CoreError::Message(format!(
            "refresh client pin failed: {e}"
        ))),
    }
}

/// Build a [`ChatBackend`] for `profile` (#122).
///
/// Owns SSRF policy selection, Anthropic/OpenAI client construction, and Grok
/// session credential loading. Callers (hosts / `research_turn`) must not
/// re-implement per-kind client wiring.
///
/// Adding a generic kind = edit [`ProviderKind`] + [`crate::providers::descriptor_for`]
/// + this function, nothing else.
pub async fn backend_for(
    profile: &ProviderProfile,
    api_key: Option<String>,
) -> CoreResult<Box<dyn ChatBackend>> {
    // Remote profiles may use corporate private DNS (TriageTool-style gateways).
    // SSRF still applies to model-driven tools; the user-configured base is trusted.
    let policy = if profile.local_only {
        SsrfPolicy::local_only()
    } else {
        SsrfPolicy::allow_private_networks()
    };

    match profile.kind {
        ProviderKind::Ollama => {
            let client = OllamaClient::new(&profile.base_url, &profile.chat_model)?;
            Ok(Box::new(OllamaBackend(client)))
        }
        ProviderKind::OpenAiCompatible => {
            let client = OpenAiCompatibleClient::new(
                &profile.base_url,
                api_key,
                &profile.chat_model,
                &policy,
            )?;
            Ok(Box::new(OpenAiBackend(client)))
        }
        ProviderKind::Anthropic => {
            let client =
                AnthropicClient::new(&profile.base_url, api_key, &profile.chat_model, &policy)?;
            Ok(Box::new(AnthropicBackend(client)))
        }
        ProviderKind::XaiGrokBuild => {
            let desc = crate::providers::descriptor_for(ProviderKind::XaiGrokBuild);
            let base = if profile.base_url.trim().is_empty() {
                desc.default_base_url.unwrap_or("https://api.x.ai/v1")
            } else {
                profile.base_url.trim()
            };
            crate::grok_auth::assert_grok_base_allowed(base)?;
            let creds = crate::grok_auth::load_grok_session_credentials()?;
            // #141 / #251: pin OIDC refresh host — fail closed, never unpinned fallback.
            let refresh_url = creds.oidc_issuer.as_deref().unwrap_or("https://auth.x.ai");
            let http = pinned_oidc_refresh_client(
                refresh_url,
                &SsrfPolicy::default(),
                &crate::ssrf::SystemResolver,
                std::time::Duration::from_secs(60),
            )?;
            let creds = crate::grok_auth::ensure_fresh_credentials(creds, |token_url, body| {
                let http = http.clone();
                async move {
                    let resp = http
                        .post(token_url)
                        .json(&body)
                        .send()
                        .await
                        .map_err(|e| CoreError::Message(format!("refresh request: {e}")))?;
                    let status = resp.status();
                    let text = resp
                        .text()
                        .await
                        .map_err(|e| CoreError::Message(format!("refresh body: {e}")))?;
                    if !status.is_success() {
                        return Err(CoreError::Message(format!(
                            "refresh HTTP {status}: {}",
                            text.chars().take(120).collect::<String>()
                        )));
                    }
                    serde_json::from_str(&text)
                        .map_err(|e| CoreError::Message(format!("refresh json: {e}")))
                }
            })
            .await?;
            let headers = creds.request_headers();
            let client = OpenAiCompatibleClient::new(
                base,
                None,
                &profile.chat_model,
                &SsrfPolicy::default(),
            )?
            .with_extra_headers(headers);
            Ok(Box::new(OpenAiBackend(client)))
        }
    }
}

/// Run a full research turn: prefer live model; fall back to local retrieval.
pub async fn research_turn(
    host: &mut ToolHost,
    profile: &ProviderProfile,
    api_key: Option<String>,
    user_text: &str,
    history: &mut Vec<ChatMessage>,
    session_id: &str,
    force_local: bool,
) -> CoreResult<Vec<StreamEvent>> {
    research_turn_with_cancel(
        host,
        profile,
        api_key,
        user_text,
        history,
        session_id,
        force_local,
        None,
        None,
    )
    .await
}

/// Research turn with optional cancel flag and live event sink.
#[allow(clippy::too_many_arguments)] // host API; cancel + sink additive for #109/#108
pub async fn research_turn_with_cancel(
    host: &mut ToolHost,
    profile: &ProviderProfile,
    api_key: Option<String>,
    user_text: &str,
    history: &mut Vec<ChatMessage>,
    session_id: &str,
    force_local: bool,
    cancel: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
    live: Option<&mut (dyn FnMut(StreamEvent) + Send)>,
) -> CoreResult<Vec<StreamEvent>> {
    research_turn_with_cancel_and_context(
        host,
        profile,
        api_key,
        user_text,
        history,
        session_id,
        force_local,
        cancel,
        None,
        live,
    )
    .await
}

/// Research turn with an immutable, caller-validated Log Explorer snapshot.
#[allow(clippy::too_many_arguments)] // explicit turn context is safer than ambient host state
pub async fn research_turn_with_cancel_and_context(
    host: &mut ToolHost,
    profile: &ProviderProfile,
    api_key: Option<String>,
    user_text: &str,
    history: &mut Vec<ChatMessage>,
    session_id: &str,
    force_local: bool,
    cancel: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
    log_explorer_context: Option<crate::agent::LogExplorerTurnContext>,
    live: Option<&mut (dyn FnMut(StreamEvent) + Send)>,
) -> CoreResult<Vec<StreamEvent>> {
    research_turn_with_cancel_and_context_and_checkpoint(
        host,
        profile,
        api_key,
        user_text,
        history,
        session_id,
        force_local,
        cancel,
        log_explorer_context,
        None,
        None,
        None,
        false,
        live,
    )
    .await
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProviderSetupWait {
    Deadline,
    Cancelled,
}

async fn wait_for_setup_cancel(cancel: Option<&std::sync::atomic::AtomicBool>) {
    let Some(cancel) = cancel else {
        std::future::pending::<()>().await;
        return;
    };
    while !cancel.load(std::sync::atomic::Ordering::Relaxed) {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

async fn await_provider_setup<F, T>(
    started: Instant,
    plan: crate::router::TurnDeadlinePlan,
    cancel: Option<&std::sync::atomic::AtomicBool>,
    future: F,
) -> Result<T, ProviderSetupWait>
where
    F: Future<Output = T>,
{
    if cancel.is_some_and(|flag| flag.load(std::sync::atomic::Ordering::Relaxed)) {
        return Err(ProviderSetupWait::Cancelled);
    }
    let remaining = if plan.total_ms == 0 {
        None
    } else {
        Some(
            Duration::from_millis(plan.total_ms)
                .checked_sub(started.elapsed())
                .ok_or(ProviderSetupWait::Deadline)?,
        )
    };
    tokio::select! {
        biased;
        _ = wait_for_setup_cancel(cancel) => Err(ProviderSetupWait::Cancelled),
        value = async {
            match remaining {
                Some(remaining) => tokio::time::timeout(remaining, future)
                    .await
                    .map_err(|_| ProviderSetupWait::Deadline),
                None => Ok(future.await),
            }
        } => value,
    }
}

/// Research turn with optional host-retained linked synthesis evidence.
///
/// Thin wrapper: no trace capture. See
/// [`research_turn_with_cancel_and_context_and_checkpoint_and_trace`] for the
/// full parameter set — this function exists so the existing call sites
/// (production and test) never need to know tracing exists.
#[allow(clippy::too_many_arguments)] // explicit trust inputs avoid ambient retry state
pub async fn research_turn_with_cancel_and_context_and_checkpoint(
    host: &mut ToolHost,
    profile: &ProviderProfile,
    api_key: Option<String>,
    user_text: &str,
    history: &mut Vec<ChatMessage>,
    session_id: &str,
    force_local: bool,
    cancel: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
    log_explorer_context: Option<crate::agent::LogExplorerTurnContext>,
    linked_synthesis_retry: Option<LinkedSynthesisCheckpoint>,
    checkpoint_out: Option<&mut Option<LinkedSynthesisCheckpoint>>,
    turn_started_at: Option<Instant>,
    turn_prelude_emitted: bool,
    live: Option<&mut (dyn FnMut(StreamEvent) + Send)>,
) -> CoreResult<Vec<StreamEvent>> {
    research_turn_with_cancel_and_context_and_checkpoint_and_trace(
        host,
        profile,
        api_key,
        user_text,
        history,
        session_id,
        force_local,
        cancel,
        log_explorer_context,
        linked_synthesis_retry,
        checkpoint_out,
        turn_started_at,
        turn_prelude_emitted,
        live,
        false,
        None,
        &[],
        None,
    )
    .await
}

/// Research turn with optional dry-run and trace capture.
///
/// `dry_run = true` skips every provider-reaching step — no Ollama health
/// probe, no OIDC refresh, no chat completion. The assembled turn is driven
/// through a [`DryRunBackend`] so the multi-round loop, context assembly, and
/// tool-schema path still run for inspection.
///
/// `trace_sink` wraps the chosen backend in a [`TracingChatBackend`], which
/// records one bounded, redacted [`crate::turn_trace::TracedCall`] per
/// provider round *before* forwarding the call on unchanged. It cannot alter
/// execution, tool selection, context composition, or which network requests
/// are made — it only observes what was already assembled. With `None`, the
/// backend is the exact value it was before this parameter existed, which is
/// what the on/off equivalence test pins.
#[allow(clippy::too_many_arguments)] // explicit trust inputs avoid ambient retry state
pub async fn research_turn_with_cancel_and_context_and_checkpoint_and_trace(
    host: &mut ToolHost,
    profile: &ProviderProfile,
    api_key: Option<String>,
    user_text: &str,
    history: &mut Vec<ChatMessage>,
    session_id: &str,
    force_local: bool,
    cancel: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
    log_explorer_context: Option<crate::agent::LogExplorerTurnContext>,
    linked_synthesis_retry: Option<LinkedSynthesisCheckpoint>,
    checkpoint_out: Option<&mut Option<LinkedSynthesisCheckpoint>>,
    turn_started_at: Option<Instant>,
    turn_prelude_emitted: bool,
    mut live: Option<&mut (dyn FnMut(StreamEvent) + Send)>,
    dry_run: bool,
    trace_sink: Option<Arc<dyn TurnTraceSink>>,
    applied_skill_ids: &[String],
    turn_id: Option<String>,
    user_selection: Option<&str>,
) -> CoreResult<Vec<StreamEvent>> {
    let user_selection = match user_selection.map(str::trim) {
        Some("") | None => None,
        Some(selection)
            if selection.chars().count() <= crate::context_plan::MAX_USER_SELECTION_CHARS =>
        {
            Some(selection.to_string())
        }
        Some(_) => {
            return Err(CoreError::Policy(format!(
                "explicit user selection exceeds {} characters",
                crate::context_plan::MAX_USER_SELECTION_CHARS
            )))
        }
    };
    if log_explorer_context.is_some() && user_selection.is_some() {
        return Err(CoreError::Policy(
            "explicit text selection is available only for ordinary chat; linked-log turns must use host-resolved corpus evidence"
                .into(),
        ));
    }
    if force_local {
        if linked_synthesis_retry.is_some() {
            return Ok(emit_provider_error(
                "linked_synthesis_retry_stale",
                "Synthesis-only retry must use the original linked chat model. The local \
                 keyword fallback cannot consume preserved model evidence."
                    .into(),
                session_id,
                Some(profile.chat_model.clone()),
                live,
            ));
        }
        let ev = research_local(host, user_text, session_id).await?;
        if let Some(sink) = live {
            for e in &ev {
                sink(e.clone());
            }
        }
        return Ok(ev);
    }

    if log_explorer_context.is_some() && linked_synthesis_retry.is_none() {
        if let Some(events) = linked_tools_unavailable_events(profile, session_id) {
            if let Some(sink) = live {
                for event in &events {
                    sink(event.clone());
                }
            }
            return Ok(events);
        }
    }

    let deadline_plan = crate::router::TurnDeadlinePlan::for_profile(host.router_budget(), profile);
    let turn_started_at = turn_started_at.unwrap_or_else(Instant::now);
    let cancel_ref = cancel.as_ref().map(|flag| flag.as_ref());
    let prelude_was_emitted = turn_prelude_emitted;
    if !prelude_was_emitted {
        if let Some(sink) = live.as_mut() {
            sink(StreamEvent::TurnStarted {
                session_id: session_id.to_string(),
                model: Some(profile.chat_model.clone()),
            });
            sink(StreamEvent::TurnPhase {
                phase: crate::router::AgentPhase::ChoosingEvidence,
            });
        }
    }
    let turn_prelude_emitted = prelude_was_emitted || live.is_some();

    // Ollama health soft-fail (not a construction error): remain here; client build is in backend_for.
    // #123: never silently fall back to keyword-only when a chat model is selected.
    // Skipped entirely for a dry run: a health probe is itself a request to
    // the configured endpoint, and `chat --dry-run` promises none occurs.
    if !dry_run && profile.kind == ProviderKind::Ollama {
        let health = match OllamaClient::new(&profile.base_url, &profile.chat_model) {
            Ok(client) => {
                await_provider_setup(turn_started_at, deadline_plan, cancel_ref, client.health())
                    .await
            }
            Err(_) => Ok(false),
        };
        match health {
            Ok(true) => { /* reachable; build via factory below */ }
            Err(ProviderSetupWait::Cancelled) => {
                return Ok(emit_provider_cancelled(
                    session_id,
                    Some(profile.chat_model.clone()),
                    turn_prelude_emitted,
                    live,
                ));
            }
            Err(ProviderSetupWait::Deadline) => {
                return Ok(emit_provider_deadline(
                    session_id,
                    Some(profile.chat_model.clone()),
                    deadline_plan.total_ms,
                    turn_prelude_emitted,
                    live,
                ));
            }
            _ => {
                let msg = format!(
                    "Ollama isn't reachable at {} — start Ollama or choose another provider in Settings.",
                    profile.base_url
                );
                return Ok(emit_provider_error(
                    "ollama_unreachable",
                    msg,
                    session_id,
                    Some(profile.chat_model.clone()),
                    live,
                ));
            }
        }
    }

    // #122: single factory for all wired kinds (no per-kind if-chain for client construction).
    //
    // A dry run never calls this factory at all — not even to build-and-discard
    // a client. For `ProviderKind::XaiGrokBuild`, `backend_for` performs an OIDC
    // credential refresh over the network before any client exists, which by
    // itself would violate "no provider request occurs." `DryRunBackend` is
    // constructed directly instead: it holds no client, base URL, or
    // credential, so there is nothing in it capable of reaching a socket.
    let backend: Box<dyn ChatBackend> = if dry_run {
        Box::new(DryRunBackend)
    } else {
        match await_provider_setup(
            turn_started_at,
            deadline_plan,
            cancel_ref,
            backend_for(profile, api_key),
        )
        .await
        {
            Ok(Ok(b)) => b,
            Err(ProviderSetupWait::Cancelled) => {
                return Ok(emit_provider_cancelled(
                    session_id,
                    Some(profile.chat_model.clone()),
                    turn_prelude_emitted,
                    live,
                ));
            }
            Err(ProviderSetupWait::Deadline) => {
                return Ok(emit_provider_deadline(
                    session_id,
                    Some(profile.chat_model.clone()),
                    deadline_plan.total_ms,
                    turn_prelude_emitted,
                    live,
                ));
            }
            Ok(Err(e)) => {
                let msg = e.to_string();
                let code = if msg.to_lowercase().contains("not wired") {
                    "provider_not_wired"
                } else {
                    "provider_error"
                };
                return Ok(emit_provider_error(
                    code,
                    msg,
                    session_id,
                    Some(profile.chat_model.clone()),
                    live,
                ));
            }
        }
    };

    // #125: honor capability matrix with explicit degrade notices.
    let caps = profile.capabilities;
    let tools_notice = if !caps.tools && linked_synthesis_retry.is_none() {
        Some(StreamEvent::SearchTrail {
            steps: vec![format!(
                "tools disabled for profile “{}” (capabilities.tools=false)",
                profile.label
            )],
        })
    } else {
        None
    };
    if let (Some(notice), Some(sink)) = (&tools_notice, live.as_mut()) {
        sink(notice.clone());
    }
    let backend: Box<dyn ChatBackend> = Box::new(CapabilityAwareBackend::new(backend, caps));
    // Observation only: `TracingChatBackend` records the already-assembled,
    // already-redacted call and forwards it unchanged. With no sink the value
    // is the same backend it always was.
    let developer_trace_sink = trace_sink.clone();
    let backend: Box<dyn ChatBackend> = match trace_sink {
        Some(sink) => Box::new(
            TracingChatBackend::new(backend, sink)
                .with_developer_context(profile.id.clone(), profile.chat_model.clone()),
        ),
        None => backend,
    };

    let mut opts = AgentOptions::from_budget(
        host.router_budget(),
        session_id,
        Some(profile.chat_model.clone()),
    );
    opts.turn_id = turn_id.unwrap_or_default();
    opts.provider_profile_id = Some(profile.id.clone());
    opts.cancel = cancel;
    opts.log_explorer_context = log_explorer_context;
    opts.linked_synthesis_retry = linked_synthesis_retry;
    opts.deadline_plan = Some(deadline_plan);
    opts.turn_started_at = Some(turn_started_at);
    opts.turn_started_emitted = turn_prelude_emitted;
    opts.developer_trace = developer_trace_sink.map(crate::turn_trace::TurnTraceObserver::new);
    opts.applied_skill_ids = applied_skill_ids.to_vec();
    opts.user_selection = user_selection;
    // Ambient recall follows host config (set by attach_durable_memory / rebuild_host).
    opts.ambient_recall_enabled =
        !dry_run && host.ambient_recall_enabled() && host.durable_memory_active();
    // Per-model context budget (default / declared / learned).
    opts.context_char_budget = host
        .model_context_budgets()
        .resolve(Some(profile.chat_model.as_str()));
    let mut events = run_agent_turn_with_sink_and_checkpoint(
        backend.as_ref(),
        host,
        user_text,
        history,
        &opts,
        live,
        checkpoint_out,
    )
    .await?;
    if let Some(notice) = tools_notice {
        events.insert(0, notice);
    }
    Ok(events)
}

/// Emit a provider failure as stream events (no keyword-only TextDelta shell) (#123).
fn emit_provider_error(
    code: &str,
    message: String,
    session_id: &str,
    model: Option<String>,
    live: Option<&mut (dyn FnMut(StreamEvent) + Send)>,
) -> Vec<StreamEvent> {
    let events = vec![
        StreamEvent::TurnStarted {
            session_id: session_id.into(),
            model,
        },
        StreamEvent::Error {
            code: code.into(),
            message,
        },
        StreamEvent::TurnCompleted {
            reason: code.into(),
        },
    ];
    if let Some(sink) = live {
        for e in &events {
            sink(e.clone());
        }
    }
    events
}

fn emit_provider_cancelled(
    session_id: &str,
    model: Option<String>,
    turn_prelude_emitted: bool,
    live: Option<&mut (dyn FnMut(StreamEvent) + Send)>,
) -> Vec<StreamEvent> {
    let events = vec![
        StreamEvent::TurnStarted {
            session_id: session_id.into(),
            model,
        },
        StreamEvent::TurnPhase {
            phase: crate::router::AgentPhase::ChoosingEvidence,
        },
        StreamEvent::TurnCompleted {
            reason: "cancel".into(),
        },
    ];
    if let Some(sink) = live {
        for event in &events {
            if !turn_prelude_emitted
                || !matches!(
                    event,
                    StreamEvent::TurnStarted { .. } | StreamEvent::TurnPhase { .. }
                )
            {
                sink(event.clone());
            }
        }
    }
    events
}

fn emit_provider_deadline(
    session_id: &str,
    model: Option<String>,
    deadline_ms: u64,
    turn_prelude_emitted: bool,
    live: Option<&mut (dyn FnMut(StreamEvent) + Send)>,
) -> Vec<StreamEvent> {
    let events = vec![
        StreamEvent::TurnStarted {
            session_id: session_id.into(),
            model,
        },
        StreamEvent::TurnPhase {
            phase: crate::router::AgentPhase::ChoosingEvidence,
        },
        StreamEvent::Error {
            code: "budget_time".into(),
            message: format!(
                "The whole-turn deadline ({deadline_ms} ms) expired while preparing the provider."
            ),
        },
        StreamEvent::TurnCompleted {
            reason: "budget_time".into(),
        },
    ];
    if let Some(sink) = live {
        for event in &events {
            if !turn_prelude_emitted
                || !matches!(
                    event,
                    StreamEvent::TurnStarted { .. } | StreamEvent::TurnPhase { .. }
                )
            {
                sink(event.clone());
            }
        }
    }
    events
}

/// Deterministic linked-chat refusal for profiles that cannot call tools.
///
/// Hosts may use this before constructing or waiting for a [`ToolHost`]: the
/// result depends only on the selected profile and must remain available even
/// while workspace indexing is still warming up.
pub fn linked_tools_unavailable_events(
    profile: &ProviderProfile,
    session_id: &str,
) -> Option<Vec<StreamEvent>> {
    if profile.capabilities.tools {
        return None;
    }
    let message = format!(
        "Linked log investigation is unavailable because profile “{}” has tools disabled \
         (capabilities.tools=false). Select or configure a tools-enabled profile in \
         Settings → AI, then retry this linked chat.",
        profile.label
    );
    Some(emit_provider_error(
        "linked_tools_unavailable",
        message,
        session_id,
        Some(profile.chat_model.clone()),
        None,
    ))
}

/// Scripted tool-using turn for golden fixtures (no network).
pub async fn research_scripted_tool_turn(
    host: &mut ToolHost,
    query: &str,
    session_id: &str,
) -> CoreResult<Vec<StreamEvent>> {
    let tool_resp = ChatCompletion {
        content: String::new(),
        tool_calls: vec![ToolCallMsg {
            id: "g1".into(),
            kind: "function".into(),
            function: FunctionCall {
                name: "search_kb".into(),
                arguments: serde_json::json!({ "query": query, "limit": 8 }).to_string(),
            },
        }],
        finish_reason: "tool_calls".into(),
    };
    // Second response filled after tool — use local synthesis in script:
    let backend = ScriptedBackend::new(vec![
        tool_resp,
        ChatCompletion {
            content: String::new(), // replaced below if empty
            tool_calls: vec![],
            finish_reason: "stop".into(),
        },
    ]);
    let mut history = vec![];
    let mut events = run_agent_turn(
        &backend,
        host,
        query,
        &mut history,
        &AgentOptions {
            session_id: session_id.into(),
            model: Some("scripted".into()),
            max_rounds: 4,
            deadline_ms: 60_000,
            max_results_per_source: 8,
            cancel: None,
            ..Default::default()
        },
    )
    .await?;

    // If script ended without text (empty second response), append local synthesis
    let has_text = events
        .iter()
        .any(|e| matches!(e, StreamEvent::TextDelta { .. }));
    if !has_text {
        let local = research_local(host, query, session_id).await?;
        // merge text/citations from local, skip duplicate turn started
        for e in local {
            if matches!(e, StreamEvent::TurnStarted { .. }) {
                continue;
            }
            events.push(e);
        }
    }
    Ok(events)
}

/// Approve a pending write and re-run the tool.
///
/// Uses **host-stored** tool arguments from the pending request when the client
/// supplies empty/`null` arguments (preview is human text, not JSON).
///
/// When `history` is provided (#111), appends a paired
/// `Role::Assistant(tool_calls)` + `Role::Tool(result)` so the next model turn
/// sees the outcome. Denials append a short model-visible note instead.
pub async fn grant_and_execute(
    host: &mut ToolHost,
    request_id: &str,
    decision: PermissionDecision,
    typed: Option<&str>,
    name: &str,
    arguments: &serde_json::Value,
    history: Option<&mut Vec<ChatMessage>>,
) -> CoreResult<Vec<StreamEvent>> {
    let (req, dec) = host.complete_permission(request_id, decision, typed)?;
    if matches!(dec, PermissionDecision::Deny) {
        if let Some(h) = history {
            append_grant_deny_note(h, &req.tool_name, &req.target);
        }
        return Ok(vec![StreamEvent::Error {
            code: "denied".into(),
            message: "User denied write".into(),
        }]);
    }
    let rid = if matches!(dec, PermissionDecision::AllowOnce) {
        Some(request_id)
    } else {
        None
    };
    // Prefer host-stored args: UI may only have human preview, not parseable JSON.
    let use_stored =
        arguments.is_null() || arguments.as_object().map(|o| o.is_empty()).unwrap_or(false);
    let args = if use_stored && !req.arguments.is_null() {
        &req.arguments
    } else {
        arguments
    };
    let tool_name = if name.is_empty() {
        req.tool_name.as_str()
    } else {
        name
    };
    let result = match host.execute(tool_name, args, rid).await {
        Ok(result) => result,
        Err(error) => {
            // A stale or otherwise invalid pending request must not escape the
            // approval boundary as a raw host-command failure. Keep the failure
            // in-thread, make the lack of a confirmed write explicit, and
            // retain bounded model-visible feedback for a later correction
            // (#691).
            let raw_error = crate::redact::scrub_secrets(&error.to_string());
            let bounded_error = crate::text::truncate_bytes(&raw_error, 512);
            let user_message = if tool_name == crate::tools::names::SAVE_MEMORY {
                "Memory draft was incomplete; nothing was written."
            } else {
                "The approved tool action did not complete; no successful write was confirmed."
            };
            let detail = format!("{user_message}\nReason: {bounded_error}");
            let model_detail =
                crate::injection::wrap_untrusted(&format!("tool:{tool_name}"), &detail);
            if let Some(h) = history {
                append_grant_tool_outcome(h, tool_name, args, &model_detail);
            }
            return Ok(vec![
                StreamEvent::Tool {
                    id: uuid::Uuid::new_v4().to_string(),
                    name: tool_name.into(),
                    phase: crate::events::ToolPhase::Finished,
                    summary: format!("{tool_name} did not complete"),
                    detail: Some(detail),
                    ok: Some(false),
                },
                StreamEvent::Error {
                    code: "approved_tool_failed".into(),
                    message: user_message.into(),
                },
            ]);
        }
    };
    if let Some(h) = history {
        append_grant_tool_outcome(h, tool_name, args, &result.detail_for_model);
    }
    Ok(result.events)
}

/// Append assistant(tool_calls) + tool(result) so OpenAI-style validation passes.
fn append_grant_tool_outcome(
    history: &mut Vec<ChatMessage>,
    tool_name: &str,
    args: &serde_json::Value,
    detail_for_model: &str,
) {
    let call_id = format!("grant_{}", uuid::Uuid::new_v4());
    history.push(ChatMessage {
        role: Role::Assistant,
        content: String::new(),
        tool_call_id: None,
        tool_calls: Some(vec![ToolCallMsg {
            id: call_id.clone(),
            kind: "function".into(),
            function: FunctionCall {
                name: tool_name.into(),
                arguments: args.to_string(),
            },
        }]),
    });
    history.push(ChatMessage {
        role: Role::Tool,
        content: detail_for_model.into(),
        tool_call_id: Some(call_id),
        tool_calls: None,
    });
}

/// Model-visible denial so the agent does not silently retry the same write.
fn append_grant_deny_note(history: &mut Vec<ChatMessage>, tool_name: &str, target: &str) {
    history.push(ChatMessage {
        role: Role::User,
        content: format!(
            "[permission] User denied write for tool `{tool_name}` on `{target}`. \
             Do not retry the same write unless the user explicitly asks."
        ),
        tool_call_id: None,
        tool_calls: None,
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::permissions::PermissionDecision;
    use crate::ssrf::{MapResolver, SsrfPolicy};
    use std::fs;
    use std::net::IpAddr;
    use tempfile::tempdir;

    #[tokio::test(start_paused = true)]
    async fn slow_provider_health_is_bounded_by_original_whole_turn_deadline() {
        let plan = crate::router::TurnDeadlinePlan {
            total_ms: 100,
            choosing_ms: 500,
            retrieving_ms: 500,
            synthesizing_ms: 500,
            explicit: true,
        };
        let started = Instant::now();
        tokio::time::advance(Duration::from_millis(80)).await;
        let result = await_provider_setup(
            started,
            plan,
            None,
            tokio::time::sleep(Duration::from_millis(30)),
        )
        .await;
        assert_eq!(result, Err(ProviderSetupWait::Deadline));
    }

    #[tokio::test(start_paused = true)]
    async fn stop_is_authoritative_during_provider_health() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;

        let cancel = Arc::new(AtomicBool::new(false));
        let trigger = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(10)).await;
            trigger.store(true, Ordering::SeqCst);
        });
        let plan = crate::router::TurnDeadlinePlan {
            total_ms: 60_000,
            choosing_ms: 60_000,
            retrieving_ms: 60_000,
            synthesizing_ms: 60_000,
            explicit: true,
        };
        let result = await_provider_setup(
            Instant::now(),
            plan,
            Some(cancel.as_ref()),
            std::future::pending::<()>(),
        )
        .await;
        assert_eq!(result, Err(ProviderSetupWait::Cancelled));
    }

    /// #251: private resolve must not fall back to an unpinned refresh client.
    #[test]
    fn oidc_refresh_pin_fails_closed_on_private_resolve() {
        let resolver =
            MapResolver::from_pairs([("auth.x.ai", vec!["10.0.0.1".parse::<IpAddr>().unwrap()])]);
        let err = pinned_oidc_refresh_client(
            "https://auth.x.ai/oauth/token",
            &SsrfPolicy::default(),
            &resolver,
            std::time::Duration::from_secs(60),
        )
        .expect_err("must not build unpinned client");
        let s = err.to_string();
        assert!(
            s.contains("pin failed") || s.contains("private") || s.contains("blocked"),
            "unexpected err: {s}"
        );
        // No network request is made — MapResolver is pure offline.
    }

    #[test]
    fn oidc_refresh_pin_source_has_no_unpinned_fallback() {
        // Structural: the refresh path must not construct Client::builder on Err.
        let src = include_str!("research.rs");
        // Find pinned_oidc_refresh_client body — must not contain unpinned builder.
        let start = src
            .find("pub fn pinned_oidc_refresh_client")
            .expect("function present");
        // ASCII-only substring scan (clippy::string_slice).
        let end = (start + 800).min(src.len());
        let slice = src.get(start..end).expect("ascii function body slice");
        assert!(
            !slice.contains("Client::builder()"),
            "pinned_oidc_refresh_client must not fall back to Client::builder"
        );
        assert!(slice.contains("refresh client pin failed"));
    }

    /// #111: after approving save_memory, history has assistant(tool_calls)+tool(result).
    #[tokio::test]
    async fn grant_appends_tool_outcome_to_history() {
        let dir = tempdir().unwrap();
        let ws = Workspace::new("t", vec![dir.path().to_path_buf()]);
        let mut host = build_host(ws, None).unwrap();
        let args = serde_json::json!({
            "title": "notes",
            "body_markdown": "JWT auth lives in middleware."
        });
        let pending = host.execute("save_memory", &args, None).await.unwrap();
        assert!(!pending.ok);
        let rid = pending
            .events
            .iter()
            .find_map(|e| match e {
                StreamEvent::PermissionRequired { request_id, .. } => Some(request_id.clone()),
                _ => None,
            })
            .expect("permission required");

        let mut history: Vec<ChatMessage> = vec![];
        let events = grant_and_execute(
            &mut host,
            &rid,
            PermissionDecision::AllowOnce,
            None,
            "save_memory",
            &serde_json::json!({}),
            Some(&mut history),
        )
        .await
        .unwrap();
        assert!(events
            .iter()
            .any(|e| matches!(e, StreamEvent::Tool { ok: Some(true), .. })));

        // Paired assistant(tool_calls) then tool(result) — no orphan tool message.
        assert_eq!(history.len(), 2);
        assert!(matches!(history[0].role, Role::Assistant));
        let tcs = history[0].tool_calls.as_ref().expect("tool_calls");
        assert_eq!(tcs.len(), 1);
        assert_eq!(tcs[0].function.name, "save_memory");
        let call_id = tcs[0].id.clone();
        assert!(matches!(history[1].role, Role::Tool));
        assert_eq!(history[1].tool_call_id.as_deref(), Some(call_id.as_str()));
        assert!(
            history[1].content.contains("JWT")
                || history[1].content.to_lowercase().contains("memory")
                || history[1].content.contains("notes")
                || !history[1].content.is_empty(),
            "tool result content={:?}",
            history[1].content
        );

        // Follow-up scripted turn sees the grant outcome in messages handed to backend.
        struct CaptureBackend {
            saw_tool_result: std::sync::Mutex<bool>,
        }
        #[async_trait]
        impl ChatBackend for CaptureBackend {
            async fn complete(
                &self,
                messages: &[ChatMessage],
                _tools: &[ToolSpec],
            ) -> CoreResult<ChatCompletion> {
                let saw = messages.iter().any(|m| {
                    matches!(m.role, Role::Tool)
                        && (m.content.contains("JWT")
                            || m.content.to_lowercase().contains("memory")
                            || m.content.contains("notes"))
                });
                *self.saw_tool_result.lock().unwrap() = saw;
                Ok(ChatCompletion {
                    content: if saw {
                        "Yes, that save wrote JWT notes.".into()
                    } else {
                        "I do not know if it saved.".into()
                    },
                    tool_calls: vec![],
                    finish_reason: "stop".into(),
                })
            }
        }
        let backend = CaptureBackend {
            saw_tool_result: std::sync::Mutex::new(false),
        };
        // Already inside #[tokio::test] — await directly (no nested runtime).
        let events2 = run_agent_turn(
            &backend,
            &mut host,
            "did that save?",
            &mut history,
            &AgentOptions::default(),
        )
        .await
        .unwrap();
        assert!(
            *backend.saw_tool_result.lock().unwrap(),
            "follow-up turn must receive prior tool result in history"
        );
        let text: String = events2
            .iter()
            .filter_map(|e| match e {
                StreamEvent::TextDelta { text } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert!(text.contains("save") || text.contains("JWT"), "text={text}");
    }

    #[tokio::test]
    async fn invalid_approved_memory_draft_stays_in_thread_and_writes_nothing() {
        let dir = tempdir().unwrap();
        let ws = Workspace::new("invalid-grant", vec![dir.path().to_path_buf()]);
        let mut host = build_host(ws, None).unwrap();
        let valid_draft = serde_json::json!({
            "title": "notes",
            "body_markdown": "A complete draft."
        });
        let pending = host
            .execute("save_memory", &valid_draft, None)
            .await
            .unwrap();
        let rid = pending
            .events
            .iter()
            .find_map(|event| match event {
                StreamEvent::PermissionRequired { request_id, .. } => Some(request_id.clone()),
                _ => None,
            })
            .expect("valid draft should request permission");

        let mut history = Vec::new();
        let events = grant_and_execute(
            &mut host,
            &rid,
            PermissionDecision::AllowOnce,
            None,
            "save_memory",
            &serde_json::json!({"title": "different invalid draft"}),
            Some(&mut history),
        )
        .await
        .expect("approval-path validation failure should be returned as events");

        assert!(events.iter().any(|event| {
            matches!(
                event,
                StreamEvent::Tool {
                    name,
                    ok: Some(false),
                    ..
                } if name == "save_memory"
            )
        }));
        assert!(events.iter().any(|event| {
            matches!(
                event,
                StreamEvent::Error { code, message }
                    if code == "approved_tool_failed"
                        && message.contains("nothing was written")
            )
        }));
        assert_eq!(history.len(), 2);
        assert!(history[1].content.contains("nothing was written"));
        assert!(!dir
            .path()
            .join(".contextdesk/memory/different-invalid-draft.md")
            .exists());
        assert!(!dir.path().join(".contextdesk/memory/notes.md").exists());
    }

    #[tokio::test]
    async fn grant_deny_appends_model_visible_note() {
        let dir = tempdir().unwrap();
        let ws = Workspace::new("t", vec![dir.path().to_path_buf()]);
        let mut host = build_host(ws, None).unwrap();
        let args = serde_json::json!({"title": "x", "body_markdown": "y"});
        let pending = host.execute("save_memory", &args, None).await.unwrap();
        let rid = pending
            .events
            .iter()
            .find_map(|e| match e {
                StreamEvent::PermissionRequired { request_id, .. } => Some(request_id.clone()),
                _ => None,
            })
            .unwrap();
        let mut history = vec![];
        let _ = grant_and_execute(
            &mut host,
            &rid,
            PermissionDecision::Deny,
            None,
            "save_memory",
            &args,
            Some(&mut history),
        )
        .await
        .unwrap();
        assert_eq!(history.len(), 1);
        assert!(matches!(history[0].role, Role::User));
        assert!(
            history[0].content.contains("denied") && history[0].content.contains("save_memory"),
            "content={}",
            history[0].content
        );
        assert!(!dir.path().join(".contextdesk/memory/x.md").exists());
    }

    /// #123: Anthropic without API key must fail honestly (not keyword shell).
    /// (#122: factory `backend_for` errors surface as provider_error events, not TextDelta.)
    #[tokio::test]
    async fn anthropic_missing_key_errors_without_keyword_shell() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("hit.md"), "billing secret keyword\n").unwrap();
        let ws = Workspace::new("t", vec![dir.path().to_path_buf()]);
        let mut host = build_host(ws, None).unwrap();
        let mut profile = ProviderProfile::ollama_local();
        profile.kind = ProviderKind::Anthropic;
        profile.label = "Anthropic".into();
        profile.base_url = "https://api.anthropic.com".into();
        let mut history = vec![];
        let events = research_turn_with_cancel(
            &mut host,
            &profile,
            None,
            "billing",
            &mut history,
            "s-anthropic",
            false,
            None,
            None,
        )
        .await
        .expect("provider errors are stream events, not panics");
        let err_msgs: Vec<_> = events
            .iter()
            .filter_map(|e| match e {
                StreamEvent::Error { message, .. } => Some(message.as_str()),
                _ => None,
            })
            .collect();
        assert!(!err_msgs.is_empty(), "expected Error event, got {events:?}");
        let joined = err_msgs.join(" ");
        assert!(
            joined.to_lowercase().contains("key") || joined.to_lowercase().contains("anthropic"),
            "err={joined}"
        );
        // Must not emit a keyword-only TextDelta that looks like a successful answer.
        let has_billing_shell = events.iter().any(|e| match e {
            StreamEvent::TextDelta { text } => text.to_lowercase().contains("billing secret"),
            _ => false,
        });
        assert!(!has_billing_shell, "keyword shell leaked: {events:?}");
    }

    #[tokio::test]
    async fn backend_for_builds_ollama_and_rejects_anthropic_without_key() {
        let ollama = ProviderProfile::ollama_local();
        assert!(backend_for(&ollama, None).await.is_ok());

        let mut anthropic = ProviderProfile::ollama_local();
        anthropic.kind = ProviderKind::Anthropic;
        anthropic.base_url = "https://api.anthropic.com".into();
        anthropic.chat_model = "claude-test".into();
        let err = backend_for(&anthropic, None)
            .await
            .err()
            .expect("missing key must Err");
        let s = err.to_string().to_lowercase();
        assert!(s.contains("key") || s.contains("anthropic"), "err={s}");

        // SSRF: private metadata host refused for OpenAI-compatible.
        let mut bad = ProviderProfile::ollama_local();
        bad.kind = ProviderKind::OpenAiCompatible;
        bad.base_url = "http://169.254.169.254/".into();
        bad.local_only = false;
        assert!(backend_for(&bad, Some("sk-test-key-12345".into()))
            .await
            .is_err());
    }

    #[tokio::test]
    async fn capability_matrix_honors_tools_and_stream_flags() {
        use std::sync::Arc;
        struct SharedProbe {
            tools_lens: std::sync::Mutex<Vec<usize>>,
            used_stream: std::sync::Mutex<bool>,
        }
        #[async_trait]
        impl ChatBackend for Arc<SharedProbe> {
            async fn complete(
                &self,
                _messages: &[ChatMessage],
                tools: &[ToolSpec],
            ) -> CoreResult<ChatCompletion> {
                self.tools_lens.lock().unwrap().push(tools.len());
                Ok(ChatCompletion {
                    content: "ok".into(),
                    tool_calls: vec![],
                    finish_reason: "stop".into(),
                })
            }
            async fn complete_streaming(
                &self,
                messages: &[ChatMessage],
                tools: &[ToolSpec],
                on_text: &mut (dyn FnMut(String) + Send),
                _cancel: Option<&std::sync::atomic::AtomicBool>,
            ) -> CoreResult<ChatCompletion> {
                *self.used_stream.lock().unwrap() = true;
                let c = self.complete(messages, tools).await?;
                if !c.content.is_empty() {
                    on_text(c.content.clone());
                }
                Ok(c)
            }
        }

        let tools = [ToolSpec {
            name: "search_kb".into(),
            description: "x".into(),
            parameters: serde_json::json!({"type": "object"}),
            side_effect: crate::tools::ToolSideEffect::Read,
        }];

        // tools=false, stream=false → empty tools + complete (not stream path on inner).
        let probe = Arc::new(SharedProbe {
            tools_lens: std::sync::Mutex::new(vec![]),
            used_stream: std::sync::Mutex::new(false),
        });
        let backend = CapabilityAwareBackend::new(
            Box::new(probe.clone()),
            ProviderCapabilities {
                tools: false,
                stream: false,
                embeddings: false,
            },
        );
        let mut _d = vec![];
        backend
            .complete_streaming(&[], &tools, &mut |t| _d.push(t), None)
            .await
            .unwrap();
        assert_eq!(*probe.tools_lens.lock().unwrap(), vec![0]);
        assert!(
            !*probe.used_stream.lock().unwrap(),
            "stream=false must not call complete_streaming on inner"
        );

        // tools=true, stream=true → tools passed + stream path.
        let probe2 = Arc::new(SharedProbe {
            tools_lens: std::sync::Mutex::new(vec![]),
            used_stream: std::sync::Mutex::new(false),
        });
        let backend2 = CapabilityAwareBackend::new(
            Box::new(probe2.clone()),
            ProviderCapabilities {
                tools: true,
                stream: true,
                embeddings: false,
            },
        );
        let mut _d2 = vec![];
        backend2
            .complete_streaming(&[], &tools, &mut |t| _d2.push(t), None)
            .await
            .unwrap();
        assert_eq!(*probe2.tools_lens.lock().unwrap(), vec![1]);
        assert!(*probe2.used_stream.lock().unwrap());
    }

    #[tokio::test]
    async fn ollama_unreachable_errors_not_local_shell() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("hit.md"), "billing secret keyword\n").unwrap();
        let ws = Workspace::new("t", vec![dir.path().to_path_buf()]);
        let mut host = build_host(ws, None).unwrap();
        let mut profile = ProviderProfile::ollama_local();
        // Port nothing listens on — health fails without needing a real Ollama.
        profile.base_url = "http://127.0.0.1:9".into();
        let mut history = vec![];
        let events = research_turn_with_cancel(
            &mut host,
            &profile,
            None,
            "billing",
            &mut history,
            "s-ollama",
            false,
            None,
            None,
        )
        .await
        .unwrap();
        assert!(
            events.iter().any(|e| matches!(
                e,
                StreamEvent::Error { code, .. } if code == "ollama_unreachable"
            )),
            "events={events:?}"
        );
        assert!(
            !events
                .iter()
                .any(|e| matches!(e, StreamEvent::TextDelta { .. })),
            "must not emit keyword TextDelta"
        );
    }

    #[tokio::test]
    async fn tools_disabled_profile_blocks_linked_turn_before_provider_but_not_ordinary_chat() {
        let dir = tempdir().unwrap();
        let ws = Workspace::new("linked-tools", vec![dir.path().to_path_buf()]);
        let mut host = build_host(ws, None).unwrap();
        let mut profile = ProviderProfile::ollama_local();
        profile.label = "Grok Build session".into();
        profile.base_url = "http://127.0.0.1:9".into();
        profile.capabilities.tools = false;
        let context = crate::agent::LogExplorerTurnContext::for_main_chat("corpus-1").unwrap();
        let mut linked_history = vec![];
        let linked = research_turn_with_cancel_and_context(
            &mut host,
            &profile,
            None,
            "Investigate this corpus",
            &mut linked_history,
            "linked-session",
            false,
            None,
            Some(context),
            None,
        )
        .await
        .unwrap();

        let linked_error = linked.iter().find_map(|event| match event {
            StreamEvent::Error { code, message } => Some((code, message)),
            _ => None,
        });
        let (code, message) = linked_error.expect("visible linked-tools error");
        assert_eq!(code, "linked_tools_unavailable");
        assert!(message.contains("Grok Build session"), "{message}");
        assert!(message.contains("capabilities.tools=false"), "{message}");
        assert!(message.contains("tools-enabled profile"), "{message}");
        assert!(
            !linked
                .iter()
                .any(|event| matches!(event, StreamEvent::TextDelta { .. })),
            "provider planning prose must not be presented: {linked:?}"
        );
        assert!(linked_history.is_empty());

        let mut ordinary_history = vec![];
        let ordinary = research_turn_with_cancel(
            &mut host,
            &profile,
            None,
            "Ordinary chat remains chat-only",
            &mut ordinary_history,
            "ordinary-session",
            false,
            None,
            None,
        )
        .await
        .unwrap();
        assert!(ordinary.iter().any(|event| matches!(
            event,
            StreamEvent::Error { code, .. } if code == "ollama_unreachable"
        )));
        assert!(!ordinary.iter().any(|event| matches!(
            event,
            StreamEvent::Error { code, .. } if code == "linked_tools_unavailable"
        )));
    }

    #[tokio::test]
    async fn research_local_cites_fixture() {
        let dir = tempdir().unwrap();
        fs::write(
            dir.path().join("billing.md"),
            "# Billing\n\nPayments service owns invoices and refunds.\n",
        )
        .unwrap();
        let ws = Workspace::new("fix", vec![dir.path().to_path_buf()]);
        let mut host = build_host(ws, None).unwrap();
        let events = research_local(&mut host, "payments invoices", "s1")
            .await
            .unwrap();
        let text: String = events
            .iter()
            .filter_map(|e| match e {
                StreamEvent::TextDelta { text } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert!(
            text.to_lowercase().contains("payment")
                || text.contains("Billing")
                || text.contains("invoice")
                || text.contains("hit"),
            "text={text}"
        );
        assert!(events
            .iter()
            .any(|e| matches!(e, StreamEvent::Citation { .. })
                || matches!(e, StreamEvent::Tool { .. })));
        assert!(events
            .iter()
            .any(|e| matches!(e, StreamEvent::TurnCompleted { .. })));
    }

    /// #169: EventDto.kind set must match docs/PROTOCOL.md discriminants (drift guard).
    #[test]
    fn protocol_md_event_kinds_match_dto() {
        use crate::events::ToolPhase;
        // Documented in docs/PROTOCOL.md — keep in sync.
        const DOCUMENTED: &[&str] = &[
            "turn_started",
            "turn_phase",
            "linked_synthesis_retry",
            "text_delta",
            "thought_delta",
            "tool",
            "citation",
            "search_trail",
            "permission_required",
            "turn_completed",
            "error",
        ];
        let samples = [
            StreamEvent::TurnStarted {
                session_id: "s".into(),
                model: None,
            },
            StreamEvent::TurnPhase {
                phase: crate::router::AgentPhase::ChoosingEvidence,
            },
            StreamEvent::LinkedSynthesisRetry {
                available: true,
                session_id: "s".into(),
                corpus_id: "c".into(),
                provider_profile_id: Some("p".into()),
                model_id: Some("m".into()),
            },
            StreamEvent::TextDelta { text: "t".into() },
            StreamEvent::ThoughtDelta { text: "th".into() },
            StreamEvent::Tool {
                id: "i".into(),
                name: "n".into(),
                phase: ToolPhase::Started,
                summary: "s".into(),
                detail: None,
                ok: None,
            },
            StreamEvent::Citation {
                source_id: "c".into(),
                label: "l".into(),
                locator: None,
                corpus_id: None,
            },
            StreamEvent::SearchTrail {
                steps: vec!["x".into()],
            },
            StreamEvent::PermissionRequired {
                request_id: "r".into(),
                tool_name: "t".into(),
                target: "p".into(),
                reason: "why".into(),
                preview: "pv".into(),
                risk: "local".into(),
                arguments: serde_json::json!({}),
            },
            StreamEvent::TurnCompleted {
                reason: "stop".into(),
            },
            StreamEvent::Error {
                code: "e".into(),
                message: "m".into(),
            },
        ];
        let mut kinds: Vec<String> = samples.iter().map(|e| event_to_dto(e).kind).collect();
        kinds.sort();
        let mut expected: Vec<String> = DOCUMENTED.iter().map(|s| (*s).to_string()).collect();
        expected.sort();
        assert_eq!(
            kinds, expected,
            "DTO kinds drifted from docs/PROTOCOL.md — update both"
        );
        // Exhaustive: every StreamEvent variant appears (count match).
        assert_eq!(kinds.len(), DOCUMENTED.len());
    }

    #[tokio::test]
    async fn scripted_tool_turn_runs_search() {
        let dir = tempdir().unwrap();
        fs::write(
            dir.path().join("auth.md"),
            "JWT middleware validates sessions.\n",
        )
        .unwrap();
        let ws = Workspace::new("fix", vec![dir.path().to_path_buf()]);
        let mut host = build_host(ws, None).unwrap();
        let events = research_scripted_tool_turn(&mut host, "JWT sessions", "s2")
            .await
            .unwrap();
        assert!(events.iter().any(|e| matches!(e, StreamEvent::Tool { .. })));
    }
}
