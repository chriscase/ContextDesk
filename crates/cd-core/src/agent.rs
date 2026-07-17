//! Multi-round agent loop with tool host and mockable chat.

use crate::chat::{
    parse_json_tool_fallback, ChatCompletion, ChatMessage, FunctionCall, Role, ToolCallMsg,
};
use crate::error::{CoreError, CoreResult};
use crate::events::StreamEvent;
use crate::injection::{system_policy_with_tools, wrap_untrusted};
use crate::permissions::PermissionDecision;
use crate::tool_host::ToolHost;
use crate::tools::ToolSpec;
use async_trait::async_trait;
use serde_json::Value;
use std::collections::VecDeque;

/// Chat backend trait (real HTTP or mock).
#[async_trait]
pub trait ChatBackend: Send + Sync {
    /// Complete one turn.
    async fn complete(
        &self,
        messages: &[ChatMessage],
        tools: &[ToolSpec],
    ) -> CoreResult<ChatCompletion>;
}

/// Mock backend for tests: scripted responses.
pub struct ScriptedBackend {
    script: std::sync::Mutex<VecDeque<ChatCompletion>>,
}

impl ScriptedBackend {
    /// Create from ordered completions.
    pub fn new(responses: Vec<ChatCompletion>) -> Self {
        Self {
            script: std::sync::Mutex::new(responses.into()),
        }
    }
}

#[async_trait]
impl ChatBackend for ScriptedBackend {
    async fn complete(
        &self,
        _messages: &[ChatMessage],
        _tools: &[ToolSpec],
    ) -> CoreResult<ChatCompletion> {
        self.script
            .lock()
            .map_err(|_| CoreError::Message("script lock".into()))?
            .pop_front()
            .ok_or_else(|| CoreError::Message("script exhausted".into()))
    }
}

/// Agent turn options.
#[derive(Debug, Clone)]
pub struct AgentOptions {
    /// Max tool rounds.
    pub max_rounds: usize,
    /// Session id for events.
    pub session_id: String,
    /// Model label.
    pub model: Option<String>,
    /// Cooperative cancel flag (checked each round). When true, stop cleanly.
    pub cancel: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
}

impl Default for AgentOptions {
    fn default() -> Self {
        Self {
            max_rounds: 8,
            session_id: "session".into(),
            model: None,
            cancel: None,
        }
    }
}

fn cancelled(opts: &AgentOptions) -> bool {
    opts.cancel
        .as_ref()
        .map(|c| c.load(std::sync::atomic::Ordering::SeqCst))
        .unwrap_or(false)
}

/// Run agent loop; returns all stream events + final messages.
pub async fn run_agent_turn(
    backend: &dyn ChatBackend,
    host: &mut ToolHost,
    user_text: &str,
    history: &mut Vec<ChatMessage>,
    opts: &AgentOptions,
    // Optional grants for soft writes in this turn (AllowOnce for pending writes).
    auto_grant: Option<PermissionDecision>,
) -> CoreResult<Vec<StreamEvent>> {
    let mut events = vec![StreamEvent::TurnStarted {
        session_id: opts.session_id.clone(),
        model: opts.model.clone(),
    }];

    let specs = host.specs();
    let tool_names: Vec<&str> = specs.iter().map(|t| t.name.as_str()).collect();
    let system_content = system_policy_with_tools(&tool_names);

    if history.is_empty() {
        history.push(ChatMessage {
            role: Role::System,
            content: system_content,
            tool_call_id: None,
            tool_calls: None,
        });
    } else if !history.iter().any(|m| matches!(m.role, Role::System)) {
        // Loaded sessions may lack system — inject once so tools are visible.
        history.insert(
            0,
            ChatMessage {
                role: Role::System,
                content: system_content,
                tool_call_id: None,
                tool_calls: None,
            },
        );
    } else {
        // Refresh system message so newly enabled tools (e.g. web research) appear.
        if let Some(sys) = history.iter_mut().find(|m| matches!(m.role, Role::System)) {
            sys.content = system_content;
        }
    }
    history.push(ChatMessage {
        role: Role::User,
        content: user_text.into(),
        tool_call_id: None,
        tool_calls: None,
    });

    let mut trail: Vec<String> = vec!["started".into()];

    for round in 0..opts.max_rounds {
        if cancelled(opts) {
            events.push(StreamEvent::TurnCompleted {
                reason: "cancel".into(),
            });
            return Ok(events);
        }
        let completion = backend.complete(history, &specs).await?;
        let mut tool_calls = completion.tool_calls.clone();

        // JSON fallback if no native tools
        if tool_calls.is_empty() {
            if let Some((name, args)) = parse_json_tool_fallback(&completion.content) {
                tool_calls.push(ToolCallMsg {
                    id: format!("fallback_{round}"),
                    kind: "function".into(),
                    function: FunctionCall {
                        name,
                        arguments: args.to_string(),
                    },
                });
            }
        }

        if tool_calls.is_empty() {
            if !completion.content.is_empty() {
                // Emit text in chunks for streaming UX compatibility
                for chunk in chunk_text(&completion.content, 48) {
                    events.push(StreamEvent::TextDelta { text: chunk });
                }
            }
            history.push(ChatMessage {
                role: Role::Assistant,
                content: completion.content,
                tool_call_id: None,
                tool_calls: None,
            });
            if !trail.is_empty() {
                events.push(StreamEvent::SearchTrail {
                    steps: trail.clone(),
                });
            }
            events.push(StreamEvent::TurnCompleted {
                reason: completion.finish_reason,
            });
            return Ok(events);
        }

        // Assistant message with tool calls
        history.push(ChatMessage {
            role: Role::Assistant,
            content: completion.content.clone(),
            tool_call_id: None,
            tool_calls: Some(tool_calls.clone()),
        });

        for tc in tool_calls {
            let args: Value = serde_json::from_str(&tc.function.arguments)
                .unwrap_or_else(|_| serde_json::json!({}));
            trail.push(format!("tool:{}", tc.function.name));
            // Never free-float grants into execute. SoftWrite must go through
            // PermissionRequired → complete_permission. auto_grant only used for
            // tests that pre-approve via host API before re-issue.
            let _ = auto_grant;
            // Tool execution errors must not kill the whole turn (e.g. HTTP 401
            // on a news site). Feed the failure back as tool content so the
            // model can try another URL or answer from search snippets.
            let result = match host.execute(&tc.function.name, &args, None) {
                Ok(r) => r,
                Err(e) => {
                    let id = uuid::Uuid::new_v4().to_string();
                    let detail = format!(
                        "Tool `{}` failed: {e}\n\
                         Continue if possible (try another tool/URL). Do not claim the host crashed.",
                        tc.function.name
                    );
                    let wrapped = wrap_untrusted(&format!("tool:{}", tc.function.name), &detail);
                    events.push(StreamEvent::Tool {
                        id: id.clone(),
                        name: tc.function.name.clone(),
                        phase: crate::events::ToolPhase::Finished,
                        summary: format!("{} failed", tc.function.name),
                        detail: Some(detail.clone()),
                        ok: Some(false),
                    });
                    crate::tool_host::ToolResult {
                        name: tc.function.name.clone(),
                        ok: false,
                        summary: format!("{} failed", tc.function.name),
                        detail_for_model: wrapped,
                        detail_raw: detail,
                        citation_path: None,
                        events: vec![],
                    }
                }
            };
            events.extend(result.events);
            if let Some(path) = &result.citation_path {
                if result.ok {
                    events.push(StreamEvent::Citation {
                        source_id: path.clone(),
                        label: path.clone(),
                        locator: None,
                    });
                }
            }
            history.push(ChatMessage {
                role: Role::Tool,
                content: result.detail_for_model,
                tool_call_id: Some(tc.id),
                tool_calls: None,
            });
        }
    }

    events.push(StreamEvent::Error {
        code: "max_rounds".into(),
        message: "Agent reached max tool rounds".into(),
    });
    events.push(StreamEvent::TurnCompleted {
        reason: "max_rounds".into(),
    });
    Ok(events)
}

fn chunk_text(s: &str, size: usize) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    for ch in s.chars() {
        cur.push(ch);
        if cur.len() >= size {
            out.push(std::mem::take(&mut cur));
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// Prefetch retrieval when tools unsupported: force search_kb then answer.
pub fn prefetch_context(host: &mut ToolHost, query: &str) -> CoreResult<String> {
    let r = host.execute(
        "search_kb",
        &serde_json::json!({"query": query, "limit": 6}),
        None,
    )?;
    Ok(wrap_untrusted("prefetch:search_kb", &r.detail_raw))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::KeywordIndex;
    use crate::permissions::PermissionDecision;
    use crate::workspace::Workspace;
    use std::fs;
    use tempfile::tempdir;

    #[tokio::test]
    async fn agent_uses_tool_then_answers() {
        let dir = tempdir().unwrap();
        fs::write(
            dir.path().join("auth.md"),
            "Billing is handled by the payments service.\n",
        )
        .unwrap();
        let ws = Workspace::new("t", vec![dir.path().to_path_buf()]);
        let idx = KeywordIndex::build(&ws).unwrap();
        let mut host = ToolHost::new(ws, idx, None);

        let tool_resp = ChatCompletion {
            content: String::new(),
            tool_calls: vec![ToolCallMsg {
                id: "1".into(),
                kind: "function".into(),
                function: FunctionCall {
                    name: "search_kb".into(),
                    arguments: r#"{"query":"billing payments"}"#.into(),
                },
            }],
            finish_reason: "tool_calls".into(),
        };
        let final_resp = ChatCompletion {
            content: "Billing lives in the payments service. [auth.md]".into(),
            tool_calls: vec![],
            finish_reason: "stop".into(),
        };
        let backend = ScriptedBackend::new(vec![tool_resp, final_resp]);
        let mut history = vec![];
        let events = run_agent_turn(
            &backend,
            &mut host,
            "Where is billing?",
            &mut history,
            &AgentOptions::default(),
            Some(PermissionDecision::AllowOnce),
        )
        .await
        .unwrap();

        assert!(events
            .iter()
            .any(|e| matches!(e, StreamEvent::TextDelta { .. })));
        assert!(events.iter().any(|e| matches!(e, StreamEvent::Tool { .. })));
        let text: String = events
            .iter()
            .filter_map(|e| match e {
                StreamEvent::TextDelta { text } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert!(text.contains("payments"));
    }

    #[tokio::test]
    async fn agent_stops_on_cancel() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;
        let dir = tempdir().unwrap();
        let ws = Workspace::new("t", vec![dir.path().to_path_buf()]);
        let idx = KeywordIndex::build(&ws).unwrap();
        let mut host = ToolHost::new(ws, idx, None);
        let backend = ScriptedBackend::new(vec![ChatCompletion {
            content: "should not run".into(),
            tool_calls: vec![],
            finish_reason: "stop".into(),
        }]);
        let flag = Arc::new(AtomicBool::new(true));
        let mut history = vec![];
        let events = run_agent_turn(
            &backend,
            &mut host,
            "hi",
            &mut history,
            &AgentOptions {
                cancel: Some(Arc::clone(&flag)),
                ..Default::default()
            },
            None,
        )
        .await
        .unwrap();
        assert!(events
            .iter()
            .any(|e| matches!(e, StreamEvent::TurnCompleted { reason } if reason == "cancel")));
        assert!(!events
            .iter()
            .any(|e| matches!(e, StreamEvent::TextDelta { text } if text.contains("should not"))));
        assert!(flag.load(Ordering::SeqCst));
    }
}
