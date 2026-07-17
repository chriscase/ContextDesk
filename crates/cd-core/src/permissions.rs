//! Permission grants for tool side effects.
//!
//! Grants are **UI-originated**. Never accept "approved" flags from the model.

use crate::tools::ToolSideEffect;
use serde::{Deserialize, Serialize};
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
    /// Preview excerpt.
    pub preview: String,
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
            risk: risk_s,
            type_confirm_phrase,
        }
    }
}

/// Session-scoped path allows (narrow).
#[derive(Debug, Default, Clone)]
pub struct PermissionState {
    session_paths: Vec<String>,
}

impl PermissionState {
    /// Record a session path allow.
    pub fn allow_session_path(&mut self, path: impl Into<String>) {
        let p = path.into();
        if !self.session_paths.iter().any(|x| x == &p) {
            self.session_paths.push(p);
        }
    }

    /// True if this path was session-allowed.
    pub fn session_path_allowed(&self, path: &str) -> bool {
        self.session_paths
            .iter()
            .any(|p| path.starts_with(p) || p == path)
    }

    /// Whether a tool may run without a new UI prompt.
    pub fn may_execute_without_prompt(&self, side_effect: ToolSideEffect, target: &str) -> bool {
        match side_effect {
            ToolSideEffect::Read => true,
            ToolSideEffect::SoftWrite | ToolSideEffect::HardWrite => {
                self.session_path_allowed(target)
            }
        }
    }
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
        st.allow_session_path("/proj/memory/");
        assert!(st.may_execute_without_prompt(ToolSideEffect::SoftWrite, "/proj/memory/a.md"));
    }
}
