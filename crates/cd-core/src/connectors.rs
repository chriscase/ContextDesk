//! Connector config, dynamic tool registry kinds, and SQL RO helpers (#127).
//!
//! Kind-specific execution is filled in by sibling issues (MCP #128, SQL #130, HTTP #131).

use crate::error::{CoreError, CoreResult};
use crate::tools::{ToolSideEffect, ToolSpec};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;

/// Connector configuration entry (persisted in `AppConfig.connectors`).
///
/// Secrets must never appear here — only keychain ref ids in `settings` JSON.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ConnectorConfig {
    /// Stable id (slug).
    pub id: String,
    /// Kind: files | memory | mcp | sqlite | postgres | http | confluence.
    pub kind: String,
    /// Enabled.
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Kind-specific JSON (no secrets).
    #[serde(default)]
    pub settings: Value,
}

fn default_true() -> bool {
    true
}

impl ConnectorConfig {
    /// Human label for Settings (generic kinds only).
    pub fn label(&self) -> String {
        match self.kind.as_str() {
            "files" => "Files (workspace roots)".into(),
            "memory" => "Project memory".into(),
            "mcp" => "MCP server".into(),
            "sqlite" => "SQLite (read-only)".into(),
            "postgres" => "Postgres (read-only)".into(),
            "http" => "HTTP / OpenAPI preset".into(),
            "confluence" => "Confluence (read-only)".into(),
            other => other.to_string(),
        }
    }
}

/// Known generic connector kinds for Settings dropdowns (#127).
pub const CONNECTOR_KINDS: &[&str] = &[
    "files",
    "memory",
    "sqlite",
    "postgres",
    "mcp",
    "http",
    "confluence",
];

/// How a dynamic tool is executed (filled by #128/#130/#131).
#[derive(Debug, Clone)]
pub enum ConnectorExecutor {
    /// Stub / test executor returning fixed text (registry plumbing).
    Stub {
        /// Fixed model-visible detail.
        detail: String,
    },
    /// MCP tool name on a named server (#128).
    Mcp {
        /// Server id from connector settings.
        server_id: String,
        /// Remote tool name.
        tool: String,
    },
    /// SQL source id (#130).
    Sql {
        /// Connector id.
        source_id: String,
    },
    /// HTTP preset id (#131).
    Http {
        /// Preset id.
        preset_id: String,
    },
}

/// A tool registered on the host from a connector (#127).
#[derive(Debug, Clone)]
pub struct RegisteredTool {
    /// Spec advertised to the model.
    pub spec: ToolSpec,
    /// Dispatch handle.
    pub exec: ConnectorExecutor,
}

impl RegisteredTool {
    /// Side-effect class for permission gating.
    pub fn side_effect(&self) -> ToolSideEffect {
        self.spec.side_effect
    }
}

/// Validate SQL as single SELECT only (denylist writes).
pub fn validate_readonly_sql(sql: &str) -> CoreResult<()> {
    let s = sql.trim();
    if s.is_empty() {
        return Err(CoreError::Policy("empty SQL".into()));
    }
    // strip comments roughly
    let lower = s.to_lowercase();
    if lower.contains(';') && lower.trim_end().matches(';').count() > 0 {
        // allow trailing semicolon only
        let without = lower.trim_end().trim_end_matches(';');
        if without.contains(';') {
            return Err(CoreError::Policy("multiple statements not allowed".into()));
        }
    }
    for bad in [
        "insert ",
        "update ",
        "delete ",
        "drop ",
        "alter ",
        "create ",
        "truncate ",
        "grant ",
        "revoke ",
        "copy ",
        "attach ",
        "pragma ",
        "into outfile",
        "execute ",
        "call ",
    ] {
        if lower.contains(bad) {
            return Err(CoreError::Policy(format!("SQL keyword blocked: {bad}")));
        }
    }
    let first = lower.split_whitespace().next().unwrap_or("");
    if first != "select" && first != "with" {
        return Err(CoreError::Policy(
            "only SELECT (or WITH … SELECT) statements allowed".into(),
        ));
    }
    if first == "with" && !lower.contains(" select ") && !lower.contains("\nselect ") {
        // WITH must eventually select
        if !lower.contains("select") {
            return Err(CoreError::Policy("WITH must include SELECT".into()));
        }
    }
    Ok(())
}

/// MCP server config (opt-in).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServerConfig {
    /// Name.
    pub name: String,
    /// Absolute command path.
    pub command: PathBuf,
    /// Args.
    #[serde(default)]
    pub args: Vec<String>,
    /// Enabled.
    #[serde(default)]
    pub enabled: bool,
    /// Host-assigned side effects: tools treated as read unless listed.
    #[serde(default)]
    pub hard_write_tools: Vec<String>,
}

/// Validate MCP command is absolute.
pub fn validate_mcp_command(cmd: &std::path::Path) -> CoreResult<()> {
    if !cmd.is_absolute() {
        return Err(CoreError::Policy(
            "MCP command must be an absolute path".into(),
        ));
    }
    Ok(())
}

/// HTTP connector preset (typed — no free-form URL tool).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HttpPreset {
    /// Id.
    pub id: String,
    /// Allowed host.
    pub host: String,
    /// Base path.
    pub base_path: String,
}

/// Confluence RO config.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfluenceConfig {
    /// Base URL.
    pub base_url: String,
    /// Space allowlist.
    pub spaces: Vec<String>,
    /// Key ref for PAT.
    pub pat_ref: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sql_allows_select() {
        validate_readonly_sql("SELECT id FROM users LIMIT 10").unwrap();
        validate_readonly_sql("WITH x AS (SELECT 1) SELECT * FROM x").unwrap();
    }

    #[test]
    fn sql_blocks_write() {
        assert!(validate_readonly_sql("DELETE FROM users").is_err());
        assert!(validate_readonly_sql("SELECT 1; DROP TABLE t").is_err());
        assert!(validate_readonly_sql("ATTACH DATABASE 'x' AS y").is_err());
    }

    #[test]
    fn mcp_requires_absolute() {
        assert!(validate_mcp_command(&PathBuf::from("npx")).is_err());
        assert!(validate_mcp_command(&PathBuf::from("/usr/bin/node")).is_ok());
    }
}
