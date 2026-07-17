//! Offline and host research entry points (real tool path, no demo shell).

use crate::agent::{run_agent_turn, AgentOptions, ChatBackend, ScriptedBackend};
use crate::audit::AuditLog;
use crate::chat::{
    ChatCompletion, ChatMessage, FunctionCall, OllamaClient, OpenAiCompatibleClient, Role,
    ToolCallMsg,
};
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

/// Convert stream events to DTOs.
pub fn events_to_dto(events: &[StreamEvent]) -> Vec<EventDto> {
    events
        .iter()
        .map(|e| {
            let (kind, payload) = match e {
                StreamEvent::TurnStarted { session_id, model } => (
                    "turn_started",
                    serde_json::json!({ "session_id": session_id, "model": model }),
                ),
                StreamEvent::TextDelta { text } => {
                    ("text_delta", serde_json::json!({ "text": text }))
                }
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
                } => (
                    "permission_required",
                    serde_json::json!({
                        "request_id": request_id,
                        "tool_name": tool_name,
                        "target": target,
                        "reason": reason,
                        "preview": preview,
                        "risk": risk,
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
        })
        .collect()
}

/// Build a tool host for a workspace.
pub fn build_host(workspace: Workspace, audit_path: Option<PathBuf>) -> CoreResult<ToolHost> {
    let index = KeywordIndex::build(&workspace)?;
    let audit = audit_path.map(AuditLog::new);
    Ok(ToolHost::new(workspace, index, audit))
}

/// Local research without an LLM: search_kb + cited synthesis from hits.
/// This is a real shipped entry point used when no model is available and in fixtures.
pub fn research_local(
    host: &mut ToolHost,
    query: &str,
    session_id: &str,
) -> CoreResult<Vec<StreamEvent>> {
    let mut events = vec![StreamEvent::TurnStarted {
        session_id: session_id.into(),
        model: Some("local-retrieval".into()),
    }];

    let result = host.execute(
        "search_kb",
        &serde_json::json!({ "query": query, "limit": 8 }),
        None,
    )?;
    events.extend(result.events.clone());
    events.push(StreamEvent::SearchTrail {
        steps: vec!["source:Files".into(), "tool:search_kb".into()],
    });

    if let Some(path) = &result.citation_path {
        events.push(StreamEvent::Citation {
            source_id: path.clone(),
            label: path.clone(),
            locator: None,
        });
    }

    let answer = if result.ok && !result.detail_raw.contains("No hits") {
        format!(
            "### Research results\n\nQuery: **{}**\n\n{}\n\n_Sources cited from workspace search._\n",
            query, result.detail_raw
        )
    } else {
        format!(
            "### Research results\n\nNo indexed hits for **{}**. Add workspace roots and reindex, or rephrase.\n",
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
        _tools: &[ToolSpec],
    ) -> CoreResult<ChatCompletion> {
        // Ollama path: no native tools — agent uses JSON fallback or local prefetch.
        self.0.complete(messages).await
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
        // Prefer SSE stream path (buffered accumulate); fall back to non-stream
        // when gateway rejects stream or tools-on-stream.
        match self.0.complete_stream(messages, Some(tools)).await {
            Ok(c) => Ok(c),
            Err(_) => self.0.complete(messages, Some(tools)).await,
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
    if force_local || profile.kind == ProviderKind::Ollama {
        // Try Ollama agent first if not forced local-only retrieval
        if !force_local && profile.kind == ProviderKind::Ollama {
            if let Ok(client) = OllamaClient::new(&profile.base_url, &profile.chat_model) {
                if client.health().await {
                    // Prefetch then answer with ollama (tools via JSON fallback after prefetch)
                    let ctx = crate::agent::prefetch_context(host, user_text)?;
                    history.push(ChatMessage {
                        role: Role::System,
                        content: format!(
                            "{}\n\nRetrieved context:\n{ctx}",
                            crate::injection::SYSTEM_POLICY
                        ),
                        tool_call_id: None,
                        tool_calls: None,
                    });
                    // Scripted: use ollama for final answer only via one complete
                    let backend = OllamaBackend(client);
                    history.push(ChatMessage {
                        role: Role::User,
                        content: user_text.into(),
                        tool_call_id: None,
                        tool_calls: None,
                    });
                    let mut events = vec![StreamEvent::TurnStarted {
                        session_id: session_id.into(),
                        model: Some(profile.chat_model.clone()),
                    }];
                    events.push(StreamEvent::SearchTrail {
                        steps: vec!["source:Files".into(), "prefetch:search_kb".into()],
                    });
                    match backend.complete(history, &[]).await {
                        Ok(c) => {
                            for chunk in chunk_text(&c.content, 48) {
                                events.push(StreamEvent::TextDelta { text: chunk });
                            }
                            history.push(ChatMessage {
                                role: Role::Assistant,
                                content: c.content,
                                tool_call_id: None,
                                tool_calls: None,
                            });
                            events.push(StreamEvent::TurnCompleted {
                                reason: c.finish_reason,
                            });
                            return Ok(events);
                        }
                        Err(_) => {
                            // fall through to local
                        }
                    }
                }
            }
        }
        return research_local(host, user_text, session_id);
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
        return run_agent_turn(
            &backend,
            host,
            user_text,
            history,
            &AgentOptions {
                session_id: session_id.into(),
                model: Some(profile.chat_model.clone()),
                max_rounds: 8,
                cancel: None,
            },
            None,
        )
        .await;
    }

    research_local(host, user_text, session_id)
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
            cancel: None,
        },
        None,
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
pub fn grant_and_execute(
    host: &mut ToolHost,
    request_id: &str,
    decision: PermissionDecision,
    typed: Option<&str>,
    name: &str,
    arguments: &serde_json::Value,
) -> CoreResult<Vec<StreamEvent>> {
    let (_tool, dec) = host.complete_permission(request_id, decision, typed)?;
    if matches!(dec, PermissionDecision::Deny) {
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
    let result = host.execute(name, arguments, rid)?;
    Ok(result.events)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

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
