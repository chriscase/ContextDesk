//! Append-only audit log for tool calls (no secrets).

use crate::error::CoreResult;
use crate::tools::ToolSideEffect;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

/// One audit entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditEntry {
    /// Timestamp UTC.
    pub at: DateTime<Utc>,
    /// Tool name.
    pub tool: String,
    /// Side effect.
    pub side_effect: ToolSideEffect,
    /// Target path/id (scrubbed).
    pub target: String,
    /// Outcome: allowed, denied, error.
    pub outcome: String,
    /// Optional reason (no secrets).
    pub detail: String,
    /// Approx payload bytes.
    pub bytes: u64,
}

/// JSONL audit logger.
#[derive(Debug, Clone)]
pub struct AuditLog {
    path: PathBuf,
}

impl AuditLog {
    /// Create logger at path.
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    /// Path to log file.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Append an entry.
    pub fn append(&self, entry: &AuditEntry) -> CoreResult<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut f = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?;
        let mut line = serde_json::to_string(entry)?;
        // Scrub accidental secrets
        line = scrub_line(&line);
        writeln!(f, "{line}")?;
        Ok(())
    }

    /// Convenience log.
    pub fn log(
        &self,
        tool: &str,
        side_effect: ToolSideEffect,
        target: &str,
        outcome: &str,
        detail: &str,
        bytes: u64,
    ) -> CoreResult<()> {
        self.append(&AuditEntry {
            at: Utc::now(),
            tool: tool.into(),
            side_effect,
            target: scrub_line(target),
            outcome: outcome.into(),
            detail: scrub_line(detail),
            bytes,
        })
    }
}

fn scrub_line(s: &str) -> String {
    // crude: redact sk- and bearer-looking tokens
    let mut out = s.to_string();
    for prefix in ["sk-", "xai-", "Bearer "] {
        if let Some(i) = out.find(prefix) {
            let end = (i + prefix.len() + 8).min(out.len());
            out.replace_range(i..end, &format!("{prefix}***"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn writes_jsonl() {
        let dir = tempdir().unwrap();
        let log = AuditLog::new(dir.path().join("audit.jsonl"));
        log.log(
            "search_kb",
            ToolSideEffect::Read,
            "/proj",
            "allowed",
            "ok",
            12,
        )
        .unwrap();
        let text = fs::read_to_string(log.path()).unwrap();
        assert!(text.contains("search_kb"));
        assert!(text.contains("allowed"));
    }
}
