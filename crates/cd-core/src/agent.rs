//! Multi-round agent loop with tool host and mockable chat.

use crate::chat::{
    parse_json_tool_fallback, ChatCompletion, ChatMessage, FunctionCall, Role, ToolCallMsg,
};
use crate::error::{CoreError, CoreResult};
use crate::events::StreamEvent;
use crate::injection::{system_policy_with_tools, wrap_untrusted};
use crate::tool_host::ToolHost;
use crate::tools::ToolSpec;
use async_trait::async_trait;
use serde_json::Value;
use std::collections::VecDeque;
use std::time::Instant;

/// Chat backend trait (real HTTP or mock).
#[async_trait]
pub trait ChatBackend: Send + Sync {
    /// Complete one turn (buffered).
    async fn complete(
        &self,
        messages: &[ChatMessage],
        tools: &[ToolSpec],
    ) -> CoreResult<ChatCompletion>;

    /// Streaming complete: call `on_text` for each text fragment as it arrives.
    /// Default: buffered complete then one-shot text emit.
    async fn complete_streaming(
        &self,
        messages: &[ChatMessage],
        tools: &[ToolSpec],
        on_text: &mut (dyn FnMut(String) + Send),
        _cancel: Option<&std::sync::atomic::AtomicBool>,
    ) -> CoreResult<ChatCompletion> {
        let c = self.complete(messages, tools).await?;
        if !c.content.is_empty() && c.tool_calls.is_empty() {
            on_text(c.content.clone());
        }
        Ok(c)
    }
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
    /// Max tool rounds (from [`crate::router::RouterBudget::max_tool_rounds`]).
    pub max_rounds: usize,
    /// Wall-clock deadline in ms (`0` = no deadline).
    pub deadline_ms: u64,
    /// Cap for source-query tools (search_kb limit).
    pub max_results_per_source: usize,
    /// Session id for events.
    pub session_id: String,
    /// Model label.
    pub model: Option<String>,
    /// Cooperative cancel flag (checked each round). When true, stop cleanly.
    pub cancel: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
    /// Keep last N messages in model context (full history retained in `history`).
    pub compact_keep_last: usize,
    /// Ambient durable-memory injection (MEMORY.md §10.1 default ON).
    pub ambient_recall_enabled: bool,
}

impl Default for AgentOptions {
    fn default() -> Self {
        let b = crate::router::RouterBudget::default();
        Self {
            max_rounds: b.max_tool_rounds,
            deadline_ms: b.deadline_ms,
            max_results_per_source: b.max_results_per_source,
            session_id: "session".into(),
            model: None,
            cancel: None,
            compact_keep_last: crate::sessions::default_compact_keep_last(),
            ambient_recall_enabled: true,
        }
    }
}

impl AgentOptions {
    /// Build from a router budget (+ session/model metadata).
    pub fn from_budget(
        budget: &crate::router::RouterBudget,
        session_id: impl Into<String>,
        model: Option<String>,
    ) -> Self {
        let b = budget.clone().sanitized();
        Self {
            max_rounds: b.max_tool_rounds,
            deadline_ms: b.deadline_ms,
            max_results_per_source: b.max_results_per_source,
            session_id: session_id.into(),
            model,
            cancel: None,
            compact_keep_last: crate::sessions::default_compact_keep_last(),
            ambient_recall_enabled: true,
        }
    }
}

fn cancelled(opts: &AgentOptions) -> bool {
    opts.cancel
        .as_ref()
        .map(|c| c.load(std::sync::atomic::Ordering::SeqCst))
        .unwrap_or(false)
}

/// Cheap char-based size estimate for near-limit compaction (#113).
/// Approximate tokens ≈ chars/4 (no tokenizer dependency).
pub fn estimate_context_chars(messages: &[ChatMessage]) -> usize {
    messages.iter().map(|m| m.content.len()).sum()
}

/// Detect provider "context length exceeded" style errors from status + body.
pub fn is_context_length_error(status: u16, body: &str) -> bool {
    if status != 400 && status != 413 {
        // Also accept errors embedded only in the message string (status 0).
        if status != 0 {
            return false;
        }
    }
    let b = body.to_ascii_lowercase();
    const NEEDLES: &[&str] = &[
        "context_length_exceeded",
        "context length",
        "maximum context",
        "max context",
        "too many tokens",
        "token limit",
        "maximum context length",
        "prompt is too long",
        "context window",
    ];
    NEEDLES.iter().any(|n| b.contains(n))
}

/// Parse status + body from `CoreError::Message("chat HTTP 400: …")` style strings.
fn classify_context_error(err: &CoreError) -> bool {
    let s = err.to_string();
    // "chat HTTP 400: …" / "stream HTTP 400: …"
    let status = s
        .split_whitespace()
        .find_map(|w| {
            if w.chars().all(|c| c.is_ascii_digit()) {
                w.parse::<u16>().ok()
            } else {
                None
            }
        })
        .unwrap_or(0);
    is_context_length_error(status, &s)
}

/// Gateway rejected native tool calling (e.g. vLLM without `--enable-auto-tool-choice`).
///
/// Typical body:
/// `"auto" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set`
pub fn is_tools_unsupported_error(err: &CoreError) -> bool {
    let s = err.to_string().to_ascii_lowercase();
    const NEEDLES: &[&str] = &[
        "tool choice",
        "tool_choice",
        "enable-auto-tool-choice",
        "tool-call-parser",
        "tool_call_parser",
        "does not support tools",
        "tools are not supported",
        "tool use is not supported",
        "function calling is not supported",
        "does not support function",
        "unsupported tool",
        "tools not enabled",
        "tool calling is not enabled",
    ];
    NEEDLES.iter().any(|n| s.contains(n))
}

/// Soft char budget before proactive recompact (~32k tokens * 4).
const DEFAULT_CONTEXT_CHAR_BUDGET: usize = 120_000;

/// Collect + optional live sink for stream events.
struct EventCollector<'a> {
    events: Vec<StreamEvent>,
    live: Option<&'a mut (dyn FnMut(StreamEvent) + Send)>,
}

impl EventCollector<'_> {
    fn push(&mut self, e: StreamEvent) {
        if let Some(f) = self.live.as_mut() {
            f(e.clone());
        }
        self.events.push(e);
    }

    fn extend_from(&mut self, es: Vec<StreamEvent>) {
        for e in es {
            self.push(e);
        }
    }

    fn into_events(self) -> Vec<StreamEvent> {
        self.events
    }
}

/// Run agent loop; returns all stream events + final messages.
pub async fn run_agent_turn(
    backend: &dyn ChatBackend,
    host: &mut ToolHost,
    user_text: &str,
    history: &mut Vec<ChatMessage>,
    opts: &AgentOptions,
) -> CoreResult<Vec<StreamEvent>> {
    run_agent_turn_with_sink(backend, host, user_text, history, opts, None).await
}

/// Run agent loop with optional live event sink (for Channel streaming to UI).
pub async fn run_agent_turn_with_sink(
    backend: &dyn ChatBackend,
    host: &mut ToolHost,
    user_text: &str,
    history: &mut Vec<ChatMessage>,
    opts: &AgentOptions,
    live: Option<&mut (dyn FnMut(StreamEvent) + Send)>,
) -> CoreResult<Vec<StreamEvent>> {
    let mut out = EventCollector {
        events: Vec::new(),
        live,
    };
    out.push(StreamEvent::TurnStarted {
        session_id: opts.session_id.clone(),
        model: opts.model.clone(),
    });

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

    // Enforce per-source result caps on tools for this turn.
    host.set_max_results_per_source(opts.max_results_per_source);

    let mut trail: Vec<String> = vec![
        "started".into(),
        format!(
            "budget:rounds={},per_source={},deadline={}ms",
            opts.max_rounds, opts.max_results_per_source, opts.deadline_ms
        ),
    ];
    let started = Instant::now();

    for round in 0..opts.max_rounds {
        if cancelled(opts) {
            out.push(StreamEvent::TurnCompleted {
                reason: "cancel".into(),
            });
            return Ok(out.into_events());
        }
        if opts.deadline_ms > 0 && started.elapsed().as_millis() as u64 >= opts.deadline_ms {
            if !trail.is_empty() {
                out.push(StreamEvent::SearchTrail {
                    steps: trail.clone(),
                });
            }
            out.push(StreamEvent::TurnCompleted {
                reason: "budget_time".into(),
            });
            return Ok(out.into_events());
        }
        let cancel_ref = opts.cancel.as_ref().map(|c| c.as_ref());
        let mut streamed_text = false;
        // #112/#113: pairing-safe compact context; near-limit shrink keep; one 400-retry.
        let mut keep = opts.compact_keep_last.max(1);
        let mut summary = crate::sessions::recompact_chat_history(history, keep);
        let mut model_ctx =
            crate::sessions::context_chat_messages(history, summary.as_deref(), keep);
        // Proactive near-limit: shrink keep until under char budget or floor.
        let mut proactive_notice = false;
        while estimate_context_chars(&model_ctx) > DEFAULT_CONTEXT_CHAR_BUDGET && keep > 2 {
            keep = (keep / 2).max(2);
            summary = crate::sessions::recompact_chat_history(history, keep);
            model_ctx = crate::sessions::context_chat_messages(history, summary.as_deref(), keep);
            proactive_notice = true;
        }
        if proactive_notice {
            out.push(StreamEvent::Error {
                code: "context_compacted".into(),
                message: "Conversation grew large — older turns were compacted for the model. Full history is still saved."
                    .into(),
            });
        }
        // Ambient memory injection (MEMORY.md §4) — after compaction, tight budget.
        if opts.ambient_recall_enabled {
            if let Some(store) = host.durable_memory_store() {
                let hist_text: String = model_ctx
                    .iter()
                    .map(|m| m.content.as_str())
                    .collect::<Vec<_>>()
                    .join("\n");
                let budget = crate::memory::AmbientBudget::default();
                if let Ok(inj) = crate::memory::inject_memory_context(
                    store.as_ref(),
                    user_text,
                    &hist_text,
                    true,
                    budget,
                    crate::embed::HybridWeights::default(),
                    crate::embed::now_unix_secs(),
                ) {
                    if !inj.context_block.is_empty() {
                        // First-party context — not wrap_untrusted (write-time redaction).
                        model_ctx.insert(
                            0,
                            ChatMessage {
                                role: Role::System,
                                content: inj.context_block,
                                tool_call_id: None,
                                tool_calls: None,
                            },
                        );
                        for (source_id, label) in inj.citations {
                            out.push(StreamEvent::Citation {
                                source_id,
                                label,
                                locator: Some("memory".into()),
                            });
                        }
                        trail.push(format!("ambient_recall:{} hits", inj.count));
                    }
                }
            }
        }
        let mut attempt = 0u8;
        // When the gateway rejects tool_choice=auto (common on vLLM), retry once
        // without native tools so chat still works.
        let mut tools_disabled = false;
        let completion = loop {
            let mut on_text = |t: String| {
                if !t.is_empty() {
                    streamed_text = true;
                    out.push(StreamEvent::TextDelta { text: t });
                }
            };
            let tool_arg: &[ToolSpec] = if tools_disabled { &[] } else { &specs };
            let result = backend
                .complete_streaming(&model_ctx, tool_arg, &mut on_text, cancel_ref)
                .await;
            match result {
                Ok(c) => break c,
                Err(e) if e.to_string().contains("cancelled") => {
                    out.push(StreamEvent::TurnCompleted {
                        reason: "cancel".into(),
                    });
                    return Ok(out.into_events());
                }
                Err(e) if !tools_disabled && is_tools_unsupported_error(&e) => {
                    tools_disabled = true;
                    trail.push("tools_disabled:gateway_rejected_tool_choice".into());
                    out.push(StreamEvent::Error {
                        code: "tools_unsupported".into(),
                        message: "This gateway rejected native tool calling (tool_choice=auto). \
Retrying without tools — answers still work; built-in tools (KB search, etc.) need a \
tool-capable endpoint or vLLM flags --enable-auto-tool-choice + --tool-call-parser."
                            .into(),
                    });
                    // Soft-ground the model with a local KB prefetch when tools are off.
                    if let Ok(ctx) = prefetch_context(host, user_text).await {
                        if !ctx.is_empty() {
                            model_ctx.push(ChatMessage {
                                role: Role::System,
                                content: format!(
                                    "Local knowledge prefetch (tools unavailable on this gateway):\n{ctx}"
                                ),
                                tool_call_id: None,
                                tool_calls: None,
                            });
                            trail.push("prefetch:search_kb".into());
                        }
                    }
                    continue;
                }
                Err(e) if attempt == 0 && classify_context_error(&e) => {
                    // Reactive: harder compact + single retry (#113).
                    attempt = 1;
                    keep = (keep / 2).max(2);
                    summary = crate::sessions::recompact_chat_history(history, keep);
                    model_ctx =
                        crate::sessions::context_chat_messages(history, summary.as_deref(), keep);
                    out.push(StreamEvent::Error {
                        code: "context_compacted".into(),
                        message: "Provider hit context limit — compacted and retrying once.".into(),
                    });
                    continue;
                }
                Err(e) if attempt >= 1 && classify_context_error(&e) => {
                    out.push(StreamEvent::Error {
                        code: "context_too_long".into(),
                        message: "This chat is too long for the model even after compaction. Start a new chat or remove older messages."
                            .into(),
                    });
                    out.push(StreamEvent::TurnCompleted {
                        reason: "context_too_long".into(),
                    });
                    return Ok(out.into_events());
                }
                Err(e) => return Err(e),
            }
        };
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
            // Default backends may not stream; emit remaining content once.
            if !streamed_text && !completion.content.is_empty() {
                out.push(StreamEvent::TextDelta {
                    text: completion.content.clone(),
                });
            }
            history.push(ChatMessage {
                role: Role::Assistant,
                content: completion.content,
                tool_call_id: None,
                tool_calls: None,
            });
            if !trail.is_empty() {
                out.push(StreamEvent::SearchTrail {
                    steps: trail.clone(),
                });
            }
            out.push(StreamEvent::TurnCompleted {
                reason: completion.finish_reason,
            });
            return Ok(out.into_events());
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
            // PermissionRequired → complete_permission → grant_and_execute, which
            // appends the outcome to session history for the next turn (#111).
            // Tool execution errors must not kill the whole turn (e.g. HTTP 401
            // on a news site). Feed the failure back as tool content so the
            // model can try another URL or answer from search snippets.
            let result = match host.execute(&tc.function.name, &args, None).await {
                Ok(r) => r,
                Err(e) => {
                    let id = uuid::Uuid::new_v4().to_string();
                    let detail = format!(
                        "Tool `{}` failed: {e}\n\
                         Continue if possible (try another tool/URL). Do not claim the host crashed.",
                        tc.function.name
                    );
                    let wrapped = wrap_untrusted(&format!("tool:{}", tc.function.name), &detail);
                    out.push(StreamEvent::Tool {
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
            out.extend_from(result.events);
            if let Some(path) = &result.citation_path {
                if result.ok {
                    out.push(StreamEvent::Citation {
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

    // Tool budget exhausted while the model still wanted tools (common on
    // multi-fetch news turns). One forced no-tools completion so the user
    // gets a synthesis instead of a hard "max tool rounds" dead-end.
    trail.push(format!(
        "budget_rounds:{} — synthesizing without tools",
        opts.max_rounds
    ));
    out.push(StreamEvent::Error {
        code: "budget_rounds".into(),
        message: format!(
            "Reached max tool rounds ({}) — answering from what was already gathered.",
            opts.max_rounds
        ),
    });
    history.push(ChatMessage {
        role: Role::System,
        content: SYNTHESIZE_AFTER_BUDGET.to_string(),
        tool_call_id: None,
        tool_calls: None,
    });
    let keep = opts.compact_keep_last.max(1);
    let summary = crate::sessions::recompact_chat_history(history, keep);
    let model_ctx = crate::sessions::context_chat_messages(history, summary.as_deref(), keep);
    let cancel_ref = opts.cancel.as_ref().map(|c| c.as_ref());
    let mut streamed_text = false;
    let mut on_text = |t: String| {
        if !t.is_empty() {
            streamed_text = true;
            out.push(StreamEvent::TextDelta { text: t });
        }
    };
    match backend
        .complete_streaming(&model_ctx, &[], &mut on_text, cancel_ref)
        .await
    {
        Ok(completion) => {
            // Ignore further tool_calls — budget is closed.
            let content = if completion.content.trim().is_empty() {
                "I gathered sources but hit the tool-round limit before finishing. \
                 Try a more specific question, or ask me to continue from the results above."
                    .to_string()
            } else {
                completion.content
            };
            if !streamed_text && !content.is_empty() {
                out.push(StreamEvent::TextDelta {
                    text: content.clone(),
                });
            }
            history.push(ChatMessage {
                role: Role::Assistant,
                content,
                tool_call_id: None,
                tool_calls: None,
            });
            if !trail.is_empty() {
                out.push(StreamEvent::SearchTrail {
                    steps: trail.clone(),
                });
            }
            out.push(StreamEvent::TurnCompleted {
                reason: "budget_rounds_answer".into(),
            });
            Ok(out.into_events())
        }
        Err(e) if e.to_string().contains("cancelled") => {
            out.push(StreamEvent::TurnCompleted {
                reason: "cancel".into(),
            });
            Ok(out.into_events())
        }
        Err(e) => {
            out.push(StreamEvent::Error {
                code: "budget_rounds_fail".into(),
                message: format!(
                    "Tool budget exhausted and final answer failed: {e}. \
                     Try a narrower question or raise max tool rounds in Settings."
                ),
            });
            out.push(StreamEvent::TurnCompleted {
                reason: "budget_rounds".into(),
            });
            Ok(out.into_events())
        }
    }
}

/// Injected when the agent loop hits max_tool_rounds after tool use.
const SYNTHESIZE_AFTER_BUDGET: &str = "\
TOOL BUDGET EXHAUSTED. Do NOT call any more tools. \
Write a complete final answer now from tool results already in this conversation. \
If evidence is incomplete, say what you found and what is still uncertain. \
Use short source names; do not invent facts not supported by the tool output.";

/// Prefetch retrieval when tools unsupported: force search_kb then answer.
pub async fn prefetch_context(host: &mut ToolHost, query: &str) -> CoreResult<String> {
    let r = host
        .execute(
            "search_kb",
            &serde_json::json!({"query": query, "limit": 6}),
            None,
        )
        .await?;
    Ok(wrap_untrusted("prefetch:search_kb", &r.detail_raw))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::KeywordIndex;
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
        )
        .await
        .unwrap();

        assert!(events
            .iter()
            .any(|e| matches!(e, StreamEvent::TextDelta { .. })));
        assert!(events.iter().any(|e| matches!(e, StreamEvent::Tool { .. })));
        assert!(events.iter().any(|e| matches!(
            e,
            StreamEvent::SearchTrail { steps } if steps.iter().any(|s| s.starts_with("budget:"))
        )));
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

    #[tokio::test]
    async fn agent_stops_at_budget_rounds() {
        let dir = tempdir().unwrap();
        let ws = Workspace::new("t", vec![dir.path().to_path_buf()]);
        let idx = KeywordIndex::build(&ws).unwrap();
        let mut host = ToolHost::new(ws, idx, None);
        // Always request another tool call — after 2 rounds, forced no-tools synthesis.
        let always_tool = ChatCompletion {
            content: String::new(),
            tool_calls: vec![ToolCallMsg {
                id: "t".into(),
                kind: "function".into(),
                function: FunctionCall {
                    name: "search_kb".into(),
                    arguments: r#"{"query":"x","limit":20}"#.into(),
                },
            }],
            finish_reason: "tool_calls".into(),
        };
        let final_answer = ChatCompletion {
            content: "Here is what I found from the tools.".into(),
            tool_calls: vec![],
            finish_reason: "stop".into(),
        };
        let backend = ScriptedBackend::new(vec![always_tool.clone(), always_tool, final_answer]);
        let mut history = vec![];
        let events = run_agent_turn(
            &backend,
            &mut host,
            "loop",
            &mut history,
            &AgentOptions {
                max_rounds: 2,
                deadline_ms: 60_000,
                max_results_per_source: 3,
                session_id: "s".into(),
                model: None,
                cancel: None,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert!(events
            .iter()
            .any(|e| matches!(e, StreamEvent::Error { code, .. } if code == "budget_rounds")));
        assert!(events.iter().any(
            |e| matches!(e, StreamEvent::TurnCompleted { reason } if reason == "budget_rounds_answer")
        ));
        assert!(events.iter().any(
            |e| matches!(e, StreamEvent::TextDelta { text } if text.contains("what I found"))
        ));
    }

    #[tokio::test]
    async fn agent_stops_at_budget_time() {
        struct SlowBackend;
        #[async_trait]
        impl ChatBackend for SlowBackend {
            async fn complete(
                &self,
                _messages: &[ChatMessage],
                _tools: &[ToolSpec],
            ) -> CoreResult<ChatCompletion> {
                tokio::time::sleep(std::time::Duration::from_millis(40)).await;
                // Keep requesting tools so we would enter a second round.
                Ok(ChatCompletion {
                    content: String::new(),
                    tool_calls: vec![ToolCallMsg {
                        id: "slow".into(),
                        kind: "function".into(),
                        function: FunctionCall {
                            name: "search_kb".into(),
                            arguments: r#"{"query":"x"}"#.into(),
                        },
                    }],
                    finish_reason: "tool_calls".into(),
                })
            }
        }

        let dir = tempdir().unwrap();
        let ws = Workspace::new("t", vec![dir.path().to_path_buf()]);
        let idx = KeywordIndex::build(&ws).unwrap();
        let mut host = ToolHost::new(ws, idx, None);
        let mut history = vec![];
        // Round 0 runs (~40ms); round 1 hits deadline before next complete.
        let events = run_agent_turn(
            &SlowBackend,
            &mut host,
            "hi",
            &mut history,
            &AgentOptions {
                max_rounds: 8,
                deadline_ms: 25,
                max_results_per_source: 8,
                session_id: "s".into(),
                model: None,
                cancel: None,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert!(events.iter().any(
            |e| matches!(e, StreamEvent::TurnCompleted { reason } if reason == "budget_time")
        ));
    }

    #[test]
    fn context_length_classifier_fixtures() {
        assert!(is_context_length_error(
            400,
            r#"{"error":{"code":"context_length_exceeded","message":"too many tokens"}}"#
        ));
        assert!(is_context_length_error(
            400,
            "This model's maximum context length is 8192 tokens"
        ));
        assert!(is_context_length_error(413, "prompt is too long"));
        assert!(!is_context_length_error(400, "invalid api key"));
        assert!(!is_context_length_error(500, "context length"));
        assert!(classify_context_error(&CoreError::Message(
            "stream HTTP 400: context_length_exceeded".into()
        )));
    }

    #[test]
    fn classifies_vllm_tool_choice_error() {
        let e = CoreError::Message(
            r#"chat HTTP 400 Bad Request: {"object":"error","message":"\"auto\" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set","type":"BadRequestError","param":null,"code":400}"#
                .into(),
        );
        assert!(is_tools_unsupported_error(&e));
        assert!(!is_tools_unsupported_error(&CoreError::Message(
            "chat HTTP 400: context_length_exceeded".into()
        )));
        assert!(!is_tools_unsupported_error(&CoreError::Message(
            "chat HTTP 401: invalid api key".into()
        )));
    }

    /// Gateway rejects tool_choice=auto → retry without tools and still answer.
    #[tokio::test]
    async fn agent_retries_without_tools_on_tool_choice_reject() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        struct FlakyToolsBackend {
            calls: AtomicUsize,
        }
        #[async_trait]
        impl ChatBackend for FlakyToolsBackend {
            async fn complete(
                &self,
                _messages: &[ChatMessage],
                tools: &[ToolSpec],
            ) -> CoreResult<ChatCompletion> {
                let n = self.calls.fetch_add(1, Ordering::SeqCst);
                if n == 0 {
                    assert!(
                        !tools.is_empty(),
                        "first attempt should request native tools"
                    );
                    return Err(CoreError::Message(
                        r#"chat HTTP 400 Bad Request: {"message":"\"auto\" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set"}"#
                            .into(),
                    ));
                }
                assert!(tools.is_empty(), "retry must strip tools");
                Ok(ChatCompletion {
                    content: "plain answer without tools".into(),
                    tool_calls: vec![],
                    finish_reason: "stop".into(),
                })
            }
        }
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("note.md"), "hello workspace\n").unwrap();
        let ws = Workspace::new("t", vec![dir.path().to_path_buf()]);
        let idx = KeywordIndex::build(&ws).unwrap();
        let mut host = ToolHost::new(ws, idx, None);
        let mut history = vec![];
        let backend = FlakyToolsBackend {
            calls: AtomicUsize::new(0),
        };
        let events = run_agent_turn(
            &backend,
            &mut host,
            "hello",
            &mut history,
            &AgentOptions::default(),
        )
        .await
        .unwrap();
        assert_eq!(backend.calls.load(Ordering::SeqCst), 2);
        assert!(events.iter().any(|e| matches!(
            e,
            StreamEvent::Error { code, .. } if code == "tools_unsupported"
        )));
        assert!(events.iter().any(|e| matches!(
            e,
            StreamEvent::TextDelta { text } if text.contains("plain answer")
        )));
    }

    /// #113: context-length 400 → one compact notice + retry success.
    #[tokio::test]
    async fn agent_retries_once_on_context_length_error() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        struct FlakyCtxBackend {
            calls: AtomicUsize,
        }
        #[async_trait]
        impl ChatBackend for FlakyCtxBackend {
            async fn complete(
                &self,
                _messages: &[ChatMessage],
                _tools: &[ToolSpec],
            ) -> CoreResult<ChatCompletion> {
                let n = self.calls.fetch_add(1, Ordering::SeqCst);
                if n == 0 {
                    return Err(CoreError::Message(
                        "chat HTTP 400: context_length_exceeded: too many tokens".into(),
                    ));
                }
                Ok(ChatCompletion {
                    content: "recovered after compact".into(),
                    tool_calls: vec![],
                    finish_reason: "stop".into(),
                })
            }
        }
        let dir = tempdir().unwrap();
        let ws = Workspace::new("t", vec![dir.path().to_path_buf()]);
        let idx = KeywordIndex::build(&ws).unwrap();
        let mut host = ToolHost::new(ws, idx, None);
        let mut history = vec![];
        let backend = FlakyCtxBackend {
            calls: AtomicUsize::new(0),
        };
        let events = run_agent_turn(
            &backend,
            &mut host,
            "hello",
            &mut history,
            &AgentOptions::default(),
        )
        .await
        .unwrap();
        assert_eq!(backend.calls.load(Ordering::SeqCst), 2);
        assert!(events.iter().any(|e| matches!(
            e,
            StreamEvent::Error { code, .. } if code == "context_compacted"
        )));
        assert!(events.iter().any(|e| matches!(
            e,
            StreamEvent::TextDelta { text } if text.contains("recovered")
        )));
    }

    /// #112: model sees compacted context while full history grows unbounded.
    #[tokio::test]
    async fn agent_sends_compacted_context_not_full_history() {
        struct CaptureLenBackend {
            max_msgs: std::sync::Mutex<usize>,
        }
        #[async_trait]
        impl ChatBackend for CaptureLenBackend {
            async fn complete(
                &self,
                messages: &[ChatMessage],
                _tools: &[ToolSpec],
            ) -> CoreResult<ChatCompletion> {
                let mut g = self.max_msgs.lock().unwrap();
                *g = (*g).max(messages.len());
                // Prove compaction summary when history is long.
                let _has_compact = messages
                    .iter()
                    .any(|m| m.content.contains("Compacted earlier conversation"));
                Ok(ChatCompletion {
                    content: "ok".into(),
                    tool_calls: vec![],
                    finish_reason: "stop".into(),
                })
            }
        }
        let dir = tempdir().unwrap();
        let ws = Workspace::new("t", vec![dir.path().to_path_buf()]);
        let idx = KeywordIndex::build(&ws).unwrap();
        let mut host = ToolHost::new(ws, idx, None);
        // Pre-seed a long history (well above keep=4).
        let mut history = vec![ChatMessage {
            role: Role::System,
            content: "policy".into(),
            tool_call_id: None,
            tool_calls: None,
        }];
        for i in 0..20 {
            history.push(ChatMessage {
                role: Role::User,
                content: format!("old message {i}"),
                tool_call_id: None,
                tool_calls: None,
            });
            history.push(ChatMessage {
                role: Role::Assistant,
                content: format!("old answer {i}"),
                tool_call_id: None,
                tool_calls: None,
            });
        }
        let full_before = history.len();
        let backend = CaptureLenBackend {
            max_msgs: std::sync::Mutex::new(0),
        };
        let _ = run_agent_turn(
            &backend,
            &mut host,
            "new question",
            &mut history,
            &AgentOptions {
                compact_keep_last: 4,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let sent = *backend.max_msgs.lock().unwrap();
        // Model context bounded: summary + keep window, far below full history.
        assert!(
            sent < full_before,
            "model saw {sent} msgs but full history was {full_before}"
        );
        assert!(sent <= 12, "compacted context should be small, got {sent}");
        // Full history retained (grew by user + assistant at least).
        assert!(
            history.len() > full_before,
            "full history must grow, len={}",
            history.len()
        );
    }

    /// #108: live sink receives each event as produced (same order as final batch).
    #[tokio::test]
    async fn live_sink_receives_events_as_produced() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("a.md"), "alpha beta\n").unwrap();
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
                    arguments: r#"{"query":"alpha"}"#.into(),
                },
            }],
            finish_reason: "tool_calls".into(),
        };
        let final_resp = ChatCompletion {
            content: "Found alpha.".into(),
            tool_calls: vec![],
            finish_reason: "stop".into(),
        };
        let backend = ScriptedBackend::new(vec![tool_resp, final_resp]);
        let mut history = vec![];
        let live: std::sync::Arc<std::sync::Mutex<Vec<StreamEvent>>> =
            std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let live_c = std::sync::Arc::clone(&live);
        let mut sink = move |e: StreamEvent| {
            live_c.lock().expect("live").push(e);
        };
        let events = run_agent_turn_with_sink(
            &backend,
            &mut host,
            "alpha?",
            &mut history,
            &AgentOptions::default(),
            Some(&mut sink),
        )
        .await
        .unwrap();

        let live_events = live.lock().expect("live").clone();
        assert_eq!(
            live_events.len(),
            events.len(),
            "live sink must see every event, not a post-hoc subset"
        );
        // Order matches final batch (clone equality via Debug kinds).
        for (i, (a, b)) in live_events.iter().zip(events.iter()).enumerate() {
            assert_eq!(
                std::mem::discriminant(a),
                std::mem::discriminant(b),
                "event {i} kind mismatch between live and final"
            );
        }
        assert!(live_events
            .iter()
            .any(|e| matches!(e, StreamEvent::TurnStarted { .. })));
        assert!(live_events
            .iter()
            .any(|e| matches!(e, StreamEvent::Tool { .. })));
        assert!(live_events.iter().any(|e| matches!(
            e,
            StreamEvent::TextDelta { text } if text.contains("alpha")
        )));
        assert!(live_events.iter().any(|e| matches!(
            e,
            StreamEvent::TurnCompleted { reason } if reason == "stop"
        )));
    }
}
