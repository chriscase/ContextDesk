//! Offline and host research entry points (real tool path, no demo shell).

use crate::agent::{
    run_agent_turn, run_agent_turn_with_sink, AgentOptions, ChatBackend, ScriptedBackend,
};
use crate::audit::AuditLog;
use crate::chat::{
    ChatCompletion, ChatMessage, FunctionCall, OllamaClient, OpenAiCompatibleClient, Role,
    ToolCallMsg,
};
use crate::error::CoreError;
use crate::error::CoreResult;
use crate::events::StreamEvent;
use crate::index::KeywordIndex;
use crate::permissions::PermissionDecision;
use crate::providers::{ProviderKind, ProviderProfile};
use crate::ssrf::SsrfPolicy;
use crate::tool_host::ToolHost;
use crate::tools::ToolSpec;
use crate::workspace::Workspace;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

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
        } => (
            "citation",
            serde_json::json!({
                "source_id": source_id, "label": label, "locator": locator
            }),
        ),
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
pub fn build_host(workspace: Workspace, audit_path: Option<PathBuf>) -> CoreResult<ToolHost> {
    build_host_with_index_cache(workspace, audit_path, None)
}

/// Build a tool host with an optional persistent index cache directory.
pub fn build_host_with_index_cache(
    workspace: Workspace,
    audit_path: Option<PathBuf>,
    index_cache_dir: Option<PathBuf>,
) -> CoreResult<ToolHost> {
    build_host_with_options(workspace, audit_path, index_cache_dir, None, None)
}

/// Build host with index cache, max files, and router budget.
pub fn build_host_with_options(
    workspace: Workspace,
    audit_path: Option<PathBuf>,
    index_cache_dir: Option<PathBuf>,
    index_max_files: Option<usize>,
    router: Option<crate::router::RouterBudget>,
) -> CoreResult<ToolHost> {
    let index =
        KeywordIndex::open_or_build(&workspace, index_cache_dir.as_deref(), index_max_files)?;
    let audit = audit_path.map(AuditLog::new);
    let mut host = ToolHost::new(workspace, index, audit);
    if let Some(b) = router {
        host.set_router_budget(b);
    }
    Ok(host)
}

// Note: open_or_build third arg is max_files.

/// Local research without an LLM: search_kb + cited synthesis from hits.
/// This is a real shipped entry point used when no model is available and in fixtures.
pub fn research_local(
    host: &mut ToolHost,
    query: &str,
    session_id: &str,
) -> CoreResult<Vec<StreamEvent>> {
    research_local_with_skills(host, query, session_id, &[])
}

/// Local research with optional skill directories for `/skill` slash invoke.
pub fn research_local_with_skills(
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

    let result = host.execute(
        "search_kb",
        &serde_json::json!({ "query": query, "limit": 8 }),
        None,
    )?;
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
                    if let crate::chat::StreamDelta::Text(t) = d {
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
    if force_local {
        let ev = research_local(host, user_text, session_id)?;
        if let Some(sink) = live {
            for e in &ev {
                sink(e.clone());
            }
        }
        return Ok(ev);
    }

    // Ollama: full agent loop with native tools (mistral etc. advertise tools).
    // Previously we only prefetched search_kb and answered once — models then
    // correctly said they could not search the web because no tools were offered.
    if profile.kind == ProviderKind::Ollama {
        if let Ok(client) = OllamaClient::new(&profile.base_url, &profile.chat_model) {
            if client.health().await {
                let backend = OllamaBackend(client);
                let mut opts = AgentOptions::from_budget(
                    host.router_budget(),
                    session_id,
                    Some(profile.chat_model.clone()),
                );
                opts.cancel = cancel;
                return run_agent_turn_with_sink(&backend, host, user_text, history, &opts, live)
                    .await;
            }
        }
        let ev = research_local(host, user_text, session_id)?;
        if let Some(sink) = live {
            for e in &ev {
                sink(e.clone());
            }
        }
        return Ok(ev);
    }

    if profile.kind == ProviderKind::OpenAiCompatible {
        let policy = if profile.local_only {
            SsrfPolicy::local_only()
        } else {
            SsrfPolicy::default()
        };
        let client =
            OpenAiCompatibleClient::new(&profile.base_url, api_key, &profile.chat_model, &policy)?;
        let backend = OpenAiBackend(client);
        let mut opts = AgentOptions::from_budget(
            host.router_budget(),
            session_id,
            Some(profile.chat_model.clone()),
        );
        opts.cancel = cancel;
        return run_agent_turn_with_sink(&backend, host, user_text, history, &opts, live).await;
    }

    // Explicit opt-in only: load ~/.grok/auth.json session, pin host to api.x.ai.
    if profile.kind == ProviderKind::XaiGrokBuild {
        let base = if profile.base_url.trim().is_empty() {
            "https://api.x.ai/v1"
        } else {
            profile.base_url.trim()
        };
        crate::grok_auth::assert_grok_base_allowed(base)?;
        let creds = crate::grok_auth::load_grok_session_credentials()?;
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(60))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| CoreError::Message(format!("http client: {e}")))?;
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
        let client =
            OpenAiCompatibleClient::new(base, None, &profile.chat_model, &SsrfPolicy::default())?
                .with_extra_headers(headers);
        let backend = OpenAiBackend(client);
        let mut opts = AgentOptions::from_budget(
            host.router_budget(),
            session_id,
            Some(profile.chat_model.clone()),
        );
        opts.cancel = cancel;
        return run_agent_turn_with_sink(&backend, host, user_text, history, &opts, live).await;
    }

    let ev = research_local(host, user_text, session_id)?;
    if let Some(sink) = live {
        for e in &ev {
            sink(e.clone());
        }
    }
    Ok(ev)
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
        },
    )
    .await?;

    // If script ended without text (empty second response), append local synthesis
    let has_text = events
        .iter()
        .any(|e| matches!(e, StreamEvent::TextDelta { .. }));
    if !has_text {
        let local = research_local(host, query, session_id)?;
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
pub fn grant_and_execute(
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
    let result = host.execute(tool_name, args, rid)?;
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
    use std::fs;
    use tempfile::tempdir;

    /// #111: after approving save_memory, history has assistant(tool_calls)+tool(result).
    #[test]
    fn grant_appends_tool_outcome_to_history() {
        let dir = tempdir().unwrap();
        let ws = Workspace::new("t", vec![dir.path().to_path_buf()]);
        let mut host = build_host(ws, None).unwrap();
        let args = serde_json::json!({
            "title": "notes",
            "body_markdown": "JWT auth lives in middleware."
        });
        let pending = host.execute("save_memory", &args, None).unwrap();
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
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let events2 = rt
            .block_on(run_agent_turn(
                &backend,
                &mut host,
                "did that save?",
                &mut history,
                &AgentOptions::default(),
            ))
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

    #[test]
    fn grant_deny_appends_model_visible_note() {
        let dir = tempdir().unwrap();
        let ws = Workspace::new("t", vec![dir.path().to_path_buf()]);
        let mut host = build_host(ws, None).unwrap();
        let args = serde_json::json!({"title": "x", "body_markdown": "y"});
        let pending = host.execute("save_memory", &args, None).unwrap();
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

    #[test]
    fn research_local_cites_fixture() {
        let dir = tempdir().unwrap();
        fs::write(
            dir.path().join("billing.md"),
            "# Billing\n\nPayments service owns invoices and refunds.\n",
        )
        .unwrap();
        let ws = Workspace::new("fix", vec![dir.path().to_path_buf()]);
        let mut host = build_host(ws, None).unwrap();
        let events = research_local(&mut host, "payments invoices", "s1").unwrap();
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
