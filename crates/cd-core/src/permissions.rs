//! Permission grants for tool side effects.
//!
//! Grants are **UI-originated**. Never accept "approved" flags from the model.

use crate::tools::ToolSideEffect;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

/// How the user responded to a permission prompt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionDecision {
    /// Deny this call.
    Deny,
    /// Allow only this single invocation.
    AllowOnce,
    /// Allow Soft/Hard writes to a specific path for the rest of the session.
    AllowSessionPath,
}

/// A pending or completed permission request.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermissionRequest {
    /// Correlation id for the host UI.
    pub request_id: String,
    /// Tool name.
    pub tool_name: String,
    /// Side effect class.
    pub side_effect: ToolSideEffect,
    /// Target (path, page id, …).
    pub target: String,
    /// Model-provided reason (untrusted text).
    pub reason: String,
    /// Human-readable preview (may be non-JSON; for UI only).
    pub preview: String,
    /// Original tool arguments for re-execute after Accept (host-authoritative).
    #[serde(default)]
    pub arguments: Value,
    /// Risk: `local` | `remote` | `destructive`.
    pub risk: String,
    /// If set, type-to-confirm phrase required (remote/destructive).
    pub type_confirm_phrase: Option<String>,
}

impl PermissionRequest {
    /// Create a new request with a fresh id.
    pub fn new(
        tool_name: impl Into<String>,
        side_effect: ToolSideEffect,
        target: impl Into<String>,
        reason: impl Into<String>,
        preview: impl Into<String>,
        risk: impl Into<String>,
    ) -> Self {
        Self::with_arguments(
            tool_name,
            side_effect,
            target,
            reason,
            preview,
            risk,
            Value::Null,
        )
    }

    /// Create a request that retains original tool arguments for grant re-execute.
    pub fn with_arguments(
        tool_name: impl Into<String>,
        side_effect: ToolSideEffect,
        target: impl Into<String>,
        reason: impl Into<String>,
        preview: impl Into<String>,
        risk: impl Into<String>,
        arguments: Value,
    ) -> Self {
        let risk_s = risk.into();
        let type_confirm_phrase = match risk_s.as_str() {
            "remote" | "destructive" => Some("WRITE".into()),
            _ => None,
        };
        Self {
            request_id: Uuid::new_v4().to_string(),
            tool_name: tool_name.into(),
            side_effect,
            target: target.into(),
            reason: reason.into(),
            preview: preview.into(),
            arguments,
            risk: risk_s,
            type_confirm_phrase,
        }
    }
}

/// Session-scoped path allows (narrow) + per-tool grants for MCP (#129).
#[derive(Debug, Default, Clone)]
pub struct PermissionState {
    session_paths: Vec<String>,
    /// Full tool names (e.g. `mcp__server__tool`) approved for the session.
    approved_tools: Vec<String>,
}

impl PermissionState {
    /// Record a session path allow.
    pub fn allow_session_path(&mut self, path: impl Into<String>) {
        let p = path.into();
        if !self.session_paths.iter().any(|x| x == &p) {
            self.session_paths.push(p);
        }
    }

    /// Record first-use approval for a named tool (MCP full name).
    pub fn allow_session_tool(&mut self, tool_name: impl Into<String>) {
        let t = tool_name.into();
        if !self.approved_tools.iter().any(|x| x == &t) {
            self.approved_tools.push(t);
        }
    }

    /// True if this path was session-allowed (boundary-safe, not raw prefix).
    pub fn session_path_allowed(&self, path: &str) -> bool {
        let path = path.trim();
        self.session_paths
            .iter()
            .any(|grant| path_under_grant(path, grant))
    }

    /// True if this tool name was session-approved (#129).
    pub fn session_tool_allowed(&self, tool_name: &str) -> bool {
        self.approved_tools.iter().any(|t| t == tool_name)
    }

    /// Whether a tool may run without a new UI prompt.
    ///
    /// Built-in Read tools auto-run. MCP tools (`mcp__*`) never auto-run on
    /// first use even if classified Read — they need a session tool grant.
    ///
    /// **#270 memory hardening:** any HardWrite whose target is `mem://…`
    /// (or a destructive memory op path) **never** auto-runs on a session path
    /// grant — a fresh UI AllowOnce is always required. File SoftWrite/HardWrite
    /// session grants are unchanged.
    pub fn may_execute_without_prompt(&self, side_effect: ToolSideEffect, target: &str) -> bool {
        // target may be path or tool name for MCP (see tool_host resolve).
        if target.starts_with("mcp__") {
            return self.session_tool_allowed(target);
        }
        // Destructive durable-memory ops: never session-auto (#270).
        if is_destructive_memory_target(target) {
            return false;
        }
        // Harvest SoftWrite: AllowOnce only — never session path grants (#326 K15).
        // Exact-match would still be wrong for prefix `harvest://confluence` vs page targets.
        if crate::harvest::is_harvest_target(target) {
            return false;
        }
        match side_effect {
            ToolSideEffect::Read => true,
            ToolSideEffect::SoftWrite => self.session_path_allowed(target),
            ToolSideEffect::HardWrite => {
                // HardWrite to mem:// never auto-runs (#270), even with a broad grant.
                if destructive_memory_hard_write(side_effect, target) {
                    return false;
                }
                self.session_path_allowed(target)
            }
        }
    }
}

/// True when a permission target identifies a destructive memory op (#270).
///
/// Matches `mem://retract/…`, `mem://purge/…` (SoftWrite retract still needs a
/// fresh Accept — session path grants never auto-satisfy these targets).
pub fn is_destructive_memory_target(target: &str) -> bool {
    let t = target.trim();
    t.starts_with("mem://retract/") || t.starts_with("mem://purge/")
}

/// HardWrite + mem:// target ⇒ never auto-execute (session grant ignored).
pub fn destructive_memory_hard_write(side_effect: ToolSideEffect, target: &str) -> bool {
    matches!(side_effect, ToolSideEffect::HardWrite) && target.trim().starts_with("mem://")
}

/// Exact match or child under grant with path separator boundary.
pub fn path_under_grant(path: &str, grant: &str) -> bool {
    let path = path.trim().trim_end_matches('/');
    let grant = grant.trim().trim_end_matches('/');
    if grant.is_empty() {
        return false;
    }
    if path == grant {
        return true;
    }
    path.starts_with(&format!("{grant}/"))
}

/// Validate a UI decision, including type-to-confirm when required.
pub fn validate_decision(
    request: &PermissionRequest,
    decision: PermissionDecision,
    typed_phrase: Option<&str>,
) -> Result<PermissionDecision, String> {
    if matches!(decision, PermissionDecision::Deny) {
        return Ok(PermissionDecision::Deny);
    }
    if let Some(expected) = &request.type_confirm_phrase {
        let got = typed_phrase.unwrap_or("").trim();
        if got != expected {
            return Err(format!(
                "type-to-confirm required: type `{expected}` exactly"
            ));
        }
    }
    Ok(decision)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_auto_allowed() {
        let st = PermissionState::default();
        assert!(st.may_execute_without_prompt(ToolSideEffect::Read, "/x"));
        assert!(!st.may_execute_without_prompt(ToolSideEffect::HardWrite, "/x"));
    }

    #[test]
    fn harvest_targets_never_session_auto() {
        let mut st = PermissionState::default();
        st.allow_session_path("harvest://confluence");
        st.allow_session_path("harvest://confluence/_/42");
        assert!(
            !st.may_execute_without_prompt(ToolSideEffect::SoftWrite, "harvest://confluence/_/42")
        );
        assert!(!st
            .may_execute_without_prompt(ToolSideEffect::SoftWrite, "harvest://confluence/batch/3"));
    }

    #[test]
    fn type_confirm_enforced() {
        let req = PermissionRequest::new(
            "publish",
            ToolSideEffect::HardWrite,
            "page:1",
            "update",
            "diff",
            "remote",
        );
        assert!(req.type_confirm_phrase.is_some());
        assert!(validate_decision(&req, PermissionDecision::AllowOnce, Some("nope")).is_err());
        assert!(validate_decision(&req, PermissionDecision::AllowOnce, Some("WRITE")).is_ok());
    }

    #[test]
    fn session_path_allows_soft_write() {
        let mut st = PermissionState::default();
        st.allow_session_path("/proj/memory");
        assert!(st.may_execute_without_prompt(ToolSideEffect::SoftWrite, "/proj/memory/a.md"));
        // Boundary: /proj/mem must not grant /proj/memory-evil
        st.allow_session_path("/proj/mem");
        assert!(!st.session_path_allowed("/proj/memory-evil/x"));
        assert!(st.session_path_allowed("/proj/mem/x"));
    }

    /// #270: a broad `mem://` session grant must NOT auto-satisfy retract/purge.
    #[test]
    fn broad_mem_session_grant_does_not_auto_retract() {
        let mut st = PermissionState::default();
        // Path-boundary grant that covers all mem:// targets (see path_under_grant).
        st.allow_session_path("mem:");
        assert!(
            st.session_path_allowed("mem://retract/00000000-0000-0000-0000-000000000001"),
            "precondition: broad grant matches mem:// targets"
        );
        assert!(
            !st.may_execute_without_prompt(
                ToolSideEffect::SoftWrite,
                "mem://retract/00000000-0000-0000-0000-000000000001"
            ),
            "retract must still require a fresh UI Accept"
        );
        assert!(
            !st.may_execute_without_prompt(
                ToolSideEffect::HardWrite,
                "mem://purge/00000000-0000-0000-0000-000000000001"
            ),
            "purge HardWrite must never auto-run"
        );
        // Non-destructive memory SoftWrite can still use session grants.
        assert!(st.may_execute_without_prompt(ToolSideEffect::SoftWrite, "mem://workspace/new"));
        // File HardWrite session grants still work (unchanged).
        st.allow_session_path("/proj/out");
        assert!(st.may_execute_without_prompt(ToolSideEffect::HardWrite, "/proj/out/file.txt"));
    }

    #[test]
    fn hardwrite_mem_target_never_session_auto() {
        let mut st = PermissionState::default();
        st.allow_session_path("mem:");
        assert!(!st.may_execute_without_prompt(
            ToolSideEffect::HardWrite,
            "mem://workspace/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee@v3"
        ));
    }

    /// #129: MCP tools never auto-run until session tool grant.
    #[test]
    fn mcp_requires_session_tool_grant() {
        let mut st = PermissionState::default();
        let name = "mcp__docs__read_file";
        assert!(!st.may_execute_without_prompt(ToolSideEffect::Read, name));
        st.allow_session_tool(name);
        assert!(st.may_execute_without_prompt(ToolSideEffect::Read, name));
        assert!(!st.may_execute_without_prompt(ToolSideEffect::Read, "mcp__docs__other"));
    }
}
