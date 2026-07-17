//! Connector trait and built-in file/memory connectors; SQL RO helpers.

use crate::error::{CoreError, CoreResult};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Connector configuration entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectorConfig {
    /// Id.
    pub id: String,
    /// Kind: files | memory | mcp | sqlite | postgres | http | confluence.
    pub kind: String,
    /// Enabled.
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Kind-specific JSON.
    #[serde(default)]
    pub settings: serde_json::Value,
}

fn default_true() -> bool {
    true
}

/// Trait for pluggable connectors (sync for simplicity; async wrappers later).
pub trait Connector: Send + Sync {
    /// Connector id.
    fn id(&self) -> &str;
    /// Human label.
    fn label(&self) -> &str;
    /// Whether enabled.
    fn enabled(&self) -> bool;
}

/// Files connector (workspace roots).
pub struct FilesConnector {
    /// Id.
    pub id: String,
    /// Roots.
    pub roots: Vec<PathBuf>,
    /// Enabled.
    pub enabled: bool,
}

impl Connector for FilesConnector {
    fn id(&self) -> &str {
        &self.id
    }
    fn label(&self) -> &str {
        "Files"
    }
    fn enabled(&self) -> bool {
        self.enabled
    }
}

/// Memory connector.
pub struct MemoryConnector {
    /// Id.
    pub id: String,
    /// Directory.
    pub dir: PathBuf,
    /// Enabled.
    pub enabled: bool,
}

impl Connector for MemoryConnector {
    fn id(&self) -> &str {
        &self.id
    }
    fn label(&self) -> &str {
        "Memory"
    }
    fn enabled(&self) -> bool {
        self.enabled
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
