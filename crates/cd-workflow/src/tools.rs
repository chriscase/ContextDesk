//! Tool execution with a caller-supplied permission decision.
//!
//! [`ToolHost::execute`] is already fully transport-neutral — it takes a
//! tool name, JSON arguments, and an optional grant id, and returns a
//! [`ToolResult`]. There is no separate abstraction to build for "running a
//! tool from a CLI"; what a CLI needs is a strategy for the one thing it
//! cannot do that a GUI does with a modal: answer a `PermissionRequired`
//! event. This module gives that strategy a name so the CLI adapter stays a
//! thin caller rather than reimplementing the grant/execute dance.

use cd_core::chat::ChatMessage;
use cd_core::error::CoreResult;
use cd_core::permissions::PermissionDecision;
use cd_core::research::grant_and_execute;
use cd_core::tool_host::{ToolHost, ToolResult};
use serde_json::Value;

/// Run one tool call, resolving any permission prompt through `decide`.
///
/// `decide` receives the exact `(tool_name, target, reason, preview, risk)` a
/// GUI's permission modal would show and returns the decision — a CLI
/// implements this as a stdin prompt (or an `--allow`/`--yes` flag honoring
/// the same [`PermissionDecision`] the GUI grants); a test implements it as a
/// fixed answer. The grant is applied through
/// [`cd_core::research::grant_and_execute`], the same helper the desktop
/// permission-response path uses, so a CLI never re-derives which stored
/// arguments win on re-execution.
pub async fn run_tool(
    host: &mut ToolHost,
    name: &str,
    arguments: &Value,
    decide: impl FnOnce(&str, &str, &str, &str, &str) -> PermissionDecision,
) -> CoreResult<ToolResult> {
    let result = host.execute(name, arguments, None).await?;
    let Some(pending) = result.events.iter().find_map(|event| match event {
        cd_core::events::StreamEvent::PermissionRequired {
            request_id,
            tool_name,
            target,
            reason,
            preview,
            risk,
            ..
        } => Some((
            request_id.clone(),
            tool_name.clone(),
            target.clone(),
            reason.clone(),
            preview.clone(),
            risk.clone(),
        )),
        _ => None,
    }) else {
        return Ok(result);
    };
    let (request_id, tool_name, target, reason, preview, risk) = pending;
    let decision = decide(&tool_name, &target, &reason, &preview, &risk);
    let mut history: Option<&mut Vec<ChatMessage>> = None;
    let events = grant_and_execute(
        host,
        &request_id,
        decision,
        None,
        &tool_name,
        arguments,
        history.take(),
    )
    .await?;
    let ok = events.iter().any(|event| {
        matches!(
            event,
            cd_core::events::StreamEvent::Tool { ok: Some(true), .. }
        )
    });
    let summary = events
        .iter()
        .find_map(|event| match event {
            cd_core::events::StreamEvent::Tool { summary, .. } => Some(summary.clone()),
            _ => None,
        })
        .unwrap_or_default();
    Ok(ToolResult {
        name: tool_name,
        ok,
        summary,
        detail_for_model: String::new(),
        detail_raw: String::new(),
        log_evidence: Vec::new(),
        log_result_count: None,
        citation_path: None,
        events,
    })
}
