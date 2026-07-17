//! Tool host: validate, gate side-effects, execute MVP tools.

use crate::audit::AuditLog;
use crate::error::{CoreError, CoreResult};
use crate::events::{StreamEvent, ToolPhase};
use crate::index::KeywordIndex;
use crate::injection::wrap_untrusted;
use crate::paths::resolve_allowed_path;
use crate::permissions::{
    validate_decision, PermissionDecision, PermissionRequest, PermissionState,
};
use crate::tools::{may_auto_execute, mvp_tool_specs, names, ToolSideEffect, ToolSpec};
use crate::workspace::Workspace;
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use uuid::Uuid;

/// Result of a tool invocation.
#[derive(Debug, Clone)]
pub struct ToolResult {
    /// Tool name.
    pub name: String,
    /// Success.
    pub ok: bool,
    /// Compact summary for UI.
    pub summary: String,
    /// Full detail (untrusted wrapper applied for model).
    pub detail_for_model: String,
    /// Raw detail for UI expand.
    pub detail_raw: String,
    /// Optional citation path.
    pub citation_path: Option<String>,
    /// Stream events to emit.
    pub events: Vec<StreamEvent>,
}

/// Host context for tools.
pub struct ToolHost {
    /// Workspace allowlist.
    pub workspace: Workspace,
    /// Keyword index (shared).
    pub index: Arc<KeywordIndex>,
    /// Permission state.
    pub permissions: PermissionState,
    /// Audit log.
    pub audit: Option<AuditLog>,
    /// Memory directory under workspace.
    pub memory_dir: PathBuf,
    /// Pending permission requests keyed by request_id (UI-originated grants only).
    pending: std::collections::HashMap<String, PermissionRequest>,
    /// Single-use grants after UI AllowOnce (request_id → tool name + target).
    approved_once: std::collections::HashMap<String, (String, String)>,
}

impl ToolHost {
    /// Create host.
    pub fn new(workspace: Workspace, index: KeywordIndex, audit: Option<AuditLog>) -> Self {
        let memory_dir = workspace
            .roots
            .first()
            .map(|r| r.join(".contextdesk").join("memory"))
            .unwrap_or_else(|| PathBuf::from(".contextdesk/memory"));
        Self {
            workspace,
            index: Arc::new(index),
            permissions: PermissionState::default(),
            audit,
            memory_dir,
            pending: std::collections::HashMap::new(),
            approved_once: std::collections::HashMap::new(),
        }
    }

    /// Register a UI decision for a pending request id.
    pub fn complete_permission(
        &mut self,
        request_id: &str,
        decision: PermissionDecision,
        typed: Option<&str>,
    ) -> CoreResult<(String, PermissionDecision)> {
        let req = self
            .pending
            .remove(request_id)
            .ok_or_else(|| CoreError::Policy("unknown or expired permission request".into()))?;
        let decision = validate_decision(&req, decision, typed).map_err(CoreError::Policy)?;
        match decision {
            PermissionDecision::Deny => {}
            PermissionDecision::AllowOnce => {
                self.approved_once.insert(
                    request_id.to_string(),
                    (req.tool_name.clone(), req.target.clone()),
                );
            }
            PermissionDecision::AllowSessionPath => {
                self.permissions.allow_session_path(&req.target);
            }
        }
        Ok((req.tool_name, decision))
    }

    fn consume_grant(&mut self, request_id: &str, name: &str, target: &str) -> bool {
        match self.approved_once.remove(request_id) {
            Some((tool, tgt)) => tool == name && tgt == target,
            None => false,
        }
    }

    /// Peek if request still pending.
    pub fn has_pending(&self, request_id: &str) -> bool {
        self.pending.contains_key(request_id)
    }

    /// Tool specs for the model.
    pub fn specs(&self) -> Vec<ToolSpec> {
        mvp_tool_specs()
    }

    /// Rebuild index.
    pub fn reindex(&mut self) -> CoreResult<()> {
        self.index = Arc::new(KeywordIndex::build(&self.workspace)?);
        Ok(())
    }

    /// Execute a tool by name with JSON arguments.
    /// For Soft/Hard write without grant, returns a PermissionRequired event only.
    ///
    /// `granted_request_id` must be a request previously approved via
    /// [`Self::complete_permission`] (AllowOnce). Free-floating grants are rejected.
    pub fn execute(
        &mut self,
        name: &str,
        arguments: &Value,
        granted_request_id: Option<&str>,
    ) -> CoreResult<ToolResult> {
        let side = side_effect_for(name);
        let target = resolve_write_target(name, arguments, &self.memory_dir);
        let id = Uuid::new_v4().to_string();

        if !may_auto_execute(side) && !self.permissions.may_execute_without_prompt(side, &target) {
            if let Some(rid) = granted_request_id {
                if !self.consume_grant(rid, name, &target) {
                    return Err(CoreError::Policy(
                        "invalid grant: unknown request_id or tool/target mismatch".into(),
                    ));
                }
            } else {
                let req = PermissionRequest::new(
                    name,
                    side,
                    &target,
                    "tool requested write",
                    preview_args(arguments),
                    risk_for(side, name),
                );
                let request_id = req.request_id.clone();
                self.pending.insert(request_id.clone(), req.clone());
                let mut events = vec![
                    StreamEvent::Tool {
                        id: id.clone(),
                        name: name.into(),
                        phase: ToolPhase::Started,
                        summary: format!("permission required for {name}"),
                        detail: None,
                        ok: None,
                    },
                    StreamEvent::PermissionRequired {
                        request_id,
                        tool_name: req.tool_name,
                        target: req.target,
                        reason: req.reason,
                        preview: req.preview,
                        risk: req.risk,
                    },
                ];
                events.push(StreamEvent::Tool {
                    id: id.clone(),
                    name: name.into(),
                    phase: ToolPhase::Finished,
                    summary: "awaiting permission".into(),
                    detail: None,
                    ok: Some(false),
                });
                self.audit_log(name, side, &target, "pending", "permission required", 0);
                return Ok(ToolResult {
                    name: name.into(),
                    ok: false,
                    summary: "permission required".into(),
                    detail_for_model: wrap_untrusted(
                        &format!("tool:{name}"),
                        "Permission required before this write can proceed.",
                    ),
                    detail_raw: "permission required".into(),
                    citation_path: None,
                    events,
                });
            }
        }

        let started = StreamEvent::Tool {
            id: id.clone(),
            name: name.into(),
            phase: ToolPhase::Started,
            summary: format!("{name}…"),
            detail: Some(preview_args(arguments)),
            ok: None,
        };

        let (ok, summary, raw, citation) = match name {
            names::SEARCH_KB => self.tool_search(arguments)?,
            names::READ_FILE_SLICE => self.tool_read(arguments)?,
            names::SAVE_MEMORY => self.tool_save_memory(arguments)?,
            _ => {
                return Err(CoreError::Message(format!("unknown tool `{name}`")));
            }
        };

        let finished = StreamEvent::Tool {
            id: id.clone(),
            name: name.into(),
            phase: ToolPhase::Finished,
            summary: summary.clone(),
            detail: Some(raw.clone()),
            ok: Some(ok),
        };

        let mut events = vec![started, finished];
        if let Some(ref path) = citation {
            events.push(StreamEvent::Citation {
                source_id: path.clone(),
                label: path.clone(),
                locator: None,
            });
        }

        self.audit_log(
            name,
            side,
            &target,
            if ok { "allowed" } else { "error" },
            &summary,
            raw.len() as u64,
        );

        Ok(ToolResult {
            name: name.into(),
            ok,
            summary,
            detail_for_model: wrap_untrusted(&format!("tool:{name}"), &raw),
            detail_raw: raw,
            citation_path: citation,
            events,
        })
    }

    fn tool_search(&self, args: &Value) -> CoreResult<(bool, String, String, Option<String>)> {
        let query = args
            .get("query")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim();
        if query.is_empty() {
            return Err(CoreError::Message("search_kb requires query".into()));
        }
        let limit = args
            .get("limit")
            .and_then(|v| v.as_u64())
            .unwrap_or(8)
            .min(50) as usize;
        let hits = self.index.search(query, limit);
        let mut lines = Vec::new();
        let mut first_path = None;
        for (score, chunk) in &hits {
            let p = chunk.path.display().to_string();
            if first_path.is_none() {
                first_path = Some(p.clone());
            }
            let excerpt: String = chunk.text.chars().take(240).collect();
            lines.push(format!(
                "- score={score:.2} {}#L{}-L{}\n  {}",
                p, chunk.start_line, chunk.end_line, excerpt
            ));
        }
        let raw = if lines.is_empty() {
            format!("No hits for `{query}`.")
        } else {
            lines.join("\n")
        };
        Ok((
            true,
            format!("{} hit(s) for `{query}`", hits.len()),
            raw,
            first_path,
        ))
    }

    fn tool_read(&self, args: &Value) -> CoreResult<(bool, String, String, Option<String>)> {
        let path = args
            .get("path")
            .and_then(|v| v.as_str())
            .ok_or_else(|| CoreError::Message("read_file_slice requires path".into()))?;
        let resolved = resolve_allowed_path(&self.workspace, path, false)?;
        let start = args
            .get("start_line")
            .and_then(|v| v.as_u64())
            .unwrap_or(1)
            .max(1) as usize;
        let end = args
            .get("end_line")
            .and_then(|v| v.as_u64())
            .unwrap_or(start as u64 + 80) as usize;
        let end = end.max(start).min(start + 400);
        let text = fs::read_to_string(&resolved)?;
        let lines: Vec<&str> = text.lines().collect();
        let slice: Vec<String> = lines
            .iter()
            .enumerate()
            .skip(start.saturating_sub(1))
            .take(end - start + 1)
            .map(|(i, l)| format!("{:4}| {}", i + 1, l))
            .collect();
        let raw = slice.join("\n");
        let p = resolved.display().to_string();
        Ok((
            true,
            format!("read {} L{start}-L{end}", resolved.display()),
            raw,
            Some(p),
        ))
    }

    fn tool_save_memory(&self, args: &Value) -> CoreResult<(bool, String, String, Option<String>)> {
        let title = args
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("note")
            .trim();
        let body = args
            .get("body_markdown")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim();
        if body.is_empty() {
            return Err(CoreError::Message(
                "save_memory requires body_markdown".into(),
            ));
        }
        fs::create_dir_all(&self.memory_dir)?;
        let hint = args
            .get("filename_hint")
            .and_then(|v| v.as_str())
            .unwrap_or(title);
        let safe: String = hint
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
            .collect();
        let safe = safe.trim_matches('-');
        let safe = if safe.is_empty() { "note" } else { safe };
        let path = self.memory_dir.join(format!("{safe}.md"));
        // Ensure under workspace
        let _ = resolve_allowed_path(&self.workspace, &path, false)?;
        let content = format!("# {title}\n\n{body}\n");
        fs::write(&path, &content)?;
        Ok((
            true,
            format!("saved {}", path.display()),
            content,
            Some(path.display().to_string()),
        ))
    }

    fn audit_log(
        &self,
        tool: &str,
        side: ToolSideEffect,
        target: &str,
        outcome: &str,
        detail: &str,
        bytes: u64,
    ) {
        if let Some(a) = &self.audit {
            let _ = a.log(tool, side, target, outcome, detail, bytes);
        }
    }
}

fn side_effect_for(name: &str) -> ToolSideEffect {
    mvp_tool_specs()
        .into_iter()
        .find(|t| t.name == name)
        .map(|t| t.side_effect)
        .unwrap_or(ToolSideEffect::HardWrite)
}

fn risk_for(side: ToolSideEffect, name: &str) -> &'static str {
    match side {
        ToolSideEffect::Read => "local",
        ToolSideEffect::SoftWrite if name == names::SAVE_MEMORY => "local",
        ToolSideEffect::SoftWrite => "local",
        ToolSideEffect::HardWrite => "destructive",
    }
}

fn resolve_write_target(name: &str, args: &Value, memory_dir: &std::path::Path) -> String {
    match name {
        names::READ_FILE_SLICE => args
            .get("path")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .into(),
        names::SAVE_MEMORY => {
            let hint = args
                .get("filename_hint")
                .or_else(|| args.get("title"))
                .and_then(|v| v.as_str())
                .unwrap_or("note");
            let safe: String = hint
                .chars()
                .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
                .collect();
            let safe = safe.trim_matches('-');
            let safe = if safe.is_empty() { "note" } else { safe };
            memory_dir.join(format!("{safe}.md")).display().to_string()
        }
        names::SEARCH_KB => args
            .get("query")
            .and_then(|v| v.as_str())
            .unwrap_or("search")
            .into(),
        _ => name.into(),
    }
}

fn preview_args(args: &Value) -> String {
    let s = args.to_string();
    if s.len() > 500 {
        format!("{}…", &s[..500])
    } else {
        s
    }
}

/// Serialize tool specs to OpenAI tools array.
pub fn openai_tools_json() -> Value {
    let tools: Vec<Value> = mvp_tool_specs()
        .into_iter()
        .map(|t| {
            json!({
                "type": "function",
                "function": {
                    "name": t.name,
                    "description": t.description,
                    "parameters": t.parameters,
                }
            })
        })
        .collect();
    Value::Array(tools)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::permissions::PermissionDecision;
    use crate::tools::ToolSideEffect;
    use tempfile::tempdir;

    fn host_with_docs() -> (tempfile::TempDir, ToolHost) {
        let dir = tempdir().unwrap();
        fs::write(
            dir.path().join("readme.md"),
            "Authentication uses JWT middleware in gateway.\n",
        )
        .unwrap();
        let ws = Workspace::new("t", vec![dir.path().to_path_buf()]);
        let idx = KeywordIndex::build(&ws).unwrap();
        let audit = AuditLog::new(dir.path().join("audit.jsonl"));
        let host = ToolHost::new(ws, idx, Some(audit));
        (dir, host)
    }

    #[test]
    fn search_and_read_work() {
        let (_dir, mut host) = host_with_docs();
        let r = host
            .execute("search_kb", &json!({"query": "JWT gateway"}), None)
            .unwrap();
        assert!(r.ok);
        assert!(r.detail_raw.contains("JWT") || r.summary.contains("hit"));
        assert!(r.detail_for_model.contains("UNTRUSTED_DATA"));
    }

    #[test]
    fn hard_write_blocked_without_grant() {
        // Use save_memory which is SoftWrite — test SoftWrite blocked
        let (_dir, mut host) = host_with_docs();
        let r = host
            .execute(
                "save_memory",
                &json!({"title": "t", "body_markdown": "hello memory"}),
                None,
            )
            .unwrap();
        assert!(!r.ok);
        assert!(r
            .events
            .iter()
            .any(|e| matches!(e, StreamEvent::PermissionRequired { .. })));
    }

    #[test]
    fn soft_write_with_allow_once() {
        let (dir, mut host) = host_with_docs();
        let args = json!({"title": "arch", "body_markdown": "We use JWT."});
        let r = host.execute("save_memory", &args, None).unwrap();
        assert!(!r.ok);
        let rid = r
            .events
            .iter()
            .find_map(|e| match e {
                StreamEvent::PermissionRequired { request_id, .. } => Some(request_id.clone()),
                _ => None,
            })
            .expect("permission event");
        host.complete_permission(&rid, PermissionDecision::AllowOnce, None)
            .unwrap();
        let r2 = host.execute("save_memory", &args, Some(&rid)).unwrap();
        assert!(r2.ok, "{}", r2.summary);
        let mem = dir.path().join(".contextdesk/memory/arch.md");
        assert!(mem.exists());
    }

    #[test]
    fn rejects_free_floating_grant() {
        let (_dir, mut host) = host_with_docs();
        let err = host.execute(
            "save_memory",
            &json!({"title": "x", "body_markdown": "y"}),
            Some("not-a-real-request"),
        );
        assert!(err.is_err());
    }

    #[test]
    fn read_outside_denied() {
        let (_dir, mut host) = host_with_docs();
        let err = host.execute("read_file_slice", &json!({"path": "/etc/passwd"}), None);
        assert!(err.is_err());
    }

    #[test]
    fn may_auto_read_only() {
        assert!(may_auto_execute(ToolSideEffect::Read));
        assert!(!may_auto_execute(ToolSideEffect::HardWrite));
    }
}
