//! Minimal MCP stdio client (opt-in, absolute command, side-effect class by host).

use crate::connectors::{validate_mcp_command, McpServerConfig};
use crate::error::{CoreError, CoreResult};
use crate::tools::{ToolSideEffect, ToolSpec};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};

static REQ_ID: AtomicU64 = AtomicU64::new(1);

/// Running MCP session (one server).
pub struct McpSession {
    name: String,
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    hard_write_tools: Vec<String>,
    read_tools: Vec<String>,
}

/// Discovered MCP tool.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpToolInfo {
    /// Prefixed name mcp__server__tool.
    pub name: String,
    /// Description.
    pub description: String,
    /// Side effect assigned by host (not server).
    pub side_effect: ToolSideEffect,
    /// Parameters schema.
    pub parameters: Value,
}

impl McpSession {
    /// Spawn server (absolute command only).
    pub fn spawn(cfg: &McpServerConfig) -> CoreResult<Self> {
        if !cfg.enabled {
            return Err(CoreError::Policy("MCP server disabled".into()));
        }
        validate_mcp_command(&cfg.command)?;
        let mut child = Command::new(&cfg.command)
            .args(&cfg.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .env_clear()
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .spawn()
            .map_err(|e| CoreError::Message(format!("mcp spawn: {e}")))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| CoreError::Message("mcp stdin".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| CoreError::Message("mcp stdout".into()))?;
        let mut sess = Self {
            name: cfg.name.clone(),
            child,
            stdin,
            stdout: BufReader::new(stdout),
            hard_write_tools: cfg.hard_write_tools.clone(),
            read_tools: cfg.read_tools.clone(),
        };
        // initialize
        let _ = sess.request(
            "initialize",
            json!({
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": { "name": "contextdesk", "version": env!("CARGO_PKG_VERSION") }
            }),
        )?;
        sess.notify("notifications/initialized", json!({}))?;
        Ok(sess)
    }

    fn request(&mut self, method: &str, params: Value) -> CoreResult<Value> {
        let id = REQ_ID.fetch_add(1, Ordering::SeqCst);
        let msg = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        let line = serde_json::to_string(&msg)?;
        writeln!(self.stdin, "{line}")
            .map_err(|e| CoreError::Message(format!("mcp write: {e}")))?;
        self.stdin
            .flush()
            .map_err(|e| CoreError::Message(format!("mcp flush: {e}")))?;
        // Read until matching id (cap lines)
        for _ in 0..100 {
            let mut buf = String::new();
            let n = self
                .stdout
                .read_line(&mut buf)
                .map_err(|e| CoreError::Message(format!("mcp read: {e}")))?;
            if n == 0 {
                return Err(CoreError::Message("mcp eof".into()));
            }
            if buf.len() > 256 * 1024 {
                return Err(CoreError::Policy("mcp response too large".into()));
            }
            let v: Value = serde_json::from_str(buf.trim())
                .map_err(|e| CoreError::Message(format!("mcp json: {e}")))?;
            if v.get("id").and_then(|i| i.as_u64()) == Some(id) {
                if let Some(err) = v.get("error") {
                    return Err(CoreError::Message(format!("mcp error: {err}")));
                }
                return Ok(v.get("result").cloned().unwrap_or(Value::Null));
            }
        }
        Err(CoreError::Message(
            "mcp timeout waiting for response".into(),
        ))
    }

    fn notify(&mut self, method: &str, params: Value) -> CoreResult<()> {
        let msg = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        });
        let line = serde_json::to_string(&msg)?;
        writeln!(self.stdin, "{line}")
            .map_err(|e| CoreError::Message(format!("mcp write: {e}")))?;
        Ok(())
    }

    /// List tools; host assigns side effects.
    pub fn list_tools(&mut self) -> CoreResult<Vec<McpToolInfo>> {
        let result = self.request("tools/list", json!({}))?;
        let mut out = Vec::new();
        if let Some(tools) = result.get("tools").and_then(|t| t.as_array()) {
            for t in tools {
                let raw_name = t
                    .get("name")
                    .and_then(|n| n.as_str())
                    .unwrap_or("tool")
                    .to_string();
                let desc = t
                    .get("description")
                    .and_then(|d| d.as_str())
                    .unwrap_or("")
                    .to_string();
                let params = t
                    .get("inputSchema")
                    .cloned()
                    .unwrap_or(json!({"type":"object"}));
                let side = classify_mcp_tool_side_effect(
                    &raw_name,
                    &self.read_tools,
                    &self.hard_write_tools,
                );
                out.push(McpToolInfo {
                    name: format!("mcp__{}__{}", self.name, raw_name),
                    description: desc,
                    side_effect: side,
                    parameters: params,
                });
            }
        }
        Ok(out)
    }

    /// Call a tool by bare server tool name.
    pub fn call_tool(&mut self, tool: &str, arguments: Value) -> CoreResult<String> {
        let result = self.request(
            "tools/call",
            json!({ "name": tool, "arguments": arguments }),
        )?;
        // Cap size
        let s = result.to_string();
        if s.len() > 64 * 1024 {
            return Ok(format!(
                "{}…(truncated)",
                crate::text::truncate_bytes(&s, 64 * 1024)
            ));
        }
        Ok(s)
    }
}

impl Drop for McpSession {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Convert MCP tools to ToolSpec.
pub fn mcp_to_specs(tools: &[McpToolInfo]) -> Vec<ToolSpec> {
    tools
        .iter()
        .map(|t| ToolSpec {
            name: t.name.clone(),
            description: t.description.clone(),
            side_effect: t.side_effect,
            parameters: t.parameters.clone(),
        })
        .collect()
}

/// Parse mcp__server__tool name.
pub fn parse_mcp_tool_name(full: &str) -> Option<(&str, &str)> {
    let rest = full.strip_prefix("mcp__")?;
    let (server, tool) = rest.split_once("__")?;
    Some((server, tool))
}

/// Classify MCP tool side effect (#129): HardWrite unless in `read_tools`.
/// `hard_write_tools` always wins (HardWrite).
pub fn classify_mcp_tool_side_effect(
    raw_name: &str,
    read_tools: &[String],
    hard_write_tools: &[String],
) -> ToolSideEffect {
    if hard_write_tools.iter().any(|h| h == raw_name) {
        ToolSideEffect::HardWrite
    } else if read_tools.iter().any(|r| r == raw_name) {
        ToolSideEffect::Read
    } else {
        ToolSideEffect::HardWrite
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn rejects_relative_command() {
        let cfg = McpServerConfig {
            name: "x".into(),
            command: PathBuf::from("npx"),
            args: vec![],
            enabled: true,
            hard_write_tools: vec![],
            read_tools: vec![],
        };
        assert!(McpSession::spawn(&cfg).is_err());
    }

    #[test]
    fn classify_mcp_side_effect_defaults_to_hard_write() {
        assert_eq!(
            classify_mcp_tool_side_effect("write_file", &[], &[]),
            ToolSideEffect::HardWrite
        );
        assert_eq!(
            classify_mcp_tool_side_effect("read_file", &["read_file".into()], &[]),
            ToolSideEffect::Read
        );
        assert_eq!(
            classify_mcp_tool_side_effect(
                "read_file",
                &["read_file".into()],
                &["read_file".into()]
            ),
            ToolSideEffect::HardWrite
        );
    }

    #[test]
    fn parse_name() {
        let (s, t) = parse_mcp_tool_name("mcp__fs__read").unwrap();
        assert_eq!(s, "fs");
        assert_eq!(t, "read");
    }

    /// Cap path: multibyte JSON body straddling 64KiB must not panic.
    #[test]
    fn tool_result_truncate_multibyte_safe() {
        let mut s = "x".repeat(64 * 1024 - 1);
        s.push('世'); // 3-byte char straddling the old raw slice point
        s.push_str("more");
        let out = if s.len() > 64 * 1024 {
            format!("{}…(truncated)", crate::text::truncate_bytes(&s, 64 * 1024))
        } else {
            s.clone()
        };
        assert!(out.contains("truncated") || out.len() <= s.len());
        assert!(out.is_char_boundary(out.len()));
    }

    #[test]
    fn validate_absolute() {
        validate_mcp_command(&PathBuf::from("/usr/bin/true")).unwrap();
    }
}
