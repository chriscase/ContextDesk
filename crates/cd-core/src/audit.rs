//! Append-only audit log for tool calls (no secrets).
//!
//! Outcomes: `pending`, `denied`, `granted`, `allowed`, `error` (#143).
//! Each entry carries a hash chain (`prev_hash` + `hash`) for tamper evidence.

use crate::error::{CoreError, CoreResult};
use crate::tools::ToolSideEffect;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Documented outcome strings written to the audit log.
pub mod outcomes {
    /// Permission requested; awaiting UI decision.
    pub const PENDING: &str = "pending";
    /// User denied the write.
    pub const DENIED: &str = "denied";
    /// User granted (AllowOnce / AllowSessionPath) at the permission gate.
    pub const GRANTED: &str = "granted";
    /// Tool executed successfully.
    pub const ALLOWED: &str = "allowed";
    /// Tool execution failed.
    pub const ERROR: &str = "error";
}

/// One audit entry (hash fields filled by [`AuditLog::append`]).
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
    /// Outcome: see [`outcomes`].
    pub outcome: String,
    /// Optional reason (no secrets).
    pub detail: String,
    /// Approx payload bytes.
    pub bytes: u64,
    /// Previous entry hash (hex), or zeros for genesis.
    #[serde(default)]
    pub prev_hash: String,
    /// sha256(prev_hash || canonical_json_without_hash) hex.
    #[serde(default)]
    pub hash: String,
}

/// JSONL audit logger with hash-chain tamper evidence.
#[derive(Debug)]
pub struct AuditLog {
    path: PathBuf,
    /// Last written hash (hex), guarded for chain correctness.
    tail: Mutex<String>,
}

impl Clone for AuditLog {
    fn clone(&self) -> Self {
        Self {
            path: self.path.clone(),
            tail: Mutex::new(self.tail.lock().map(|t| t.clone()).unwrap_or_default()),
        }
    }
}

impl AuditLog {
    /// Genesis prev_hash (64 zero hex digits).
    pub const GENESIS: &'static str =
        "0000000000000000000000000000000000000000000000000000000000000000";

    /// Create logger at path; loads tail hash from existing file if present.
    pub fn new(path: impl Into<PathBuf>) -> Self {
        let path = path.into();
        let tail = load_tail_hash(&path).unwrap_or_else(|| Self::GENESIS.to_string());
        Self {
            path,
            tail: Mutex::new(tail),
        }
    }

    /// Path to log file.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Append an entry (computes hash chain fields).
    pub fn append(&self, entry: &AuditEntry) -> CoreResult<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut tail = self
            .tail
            .lock()
            .map_err(|_| CoreError::Message("audit tail lock poisoned".into()))?;
        let mut e = entry.clone();
        e.target = scrub_line(&e.target);
        e.detail = scrub_line(&e.detail);
        e.outcome = scrub_line(&e.outcome);
        e.tool = scrub_line(&e.tool);
        e.prev_hash = tail.clone();
        e.hash = String::new();
        let canonical = serde_json::to_string(&e)?;
        let mut hasher = Sha256::new();
        hasher.update(e.prev_hash.as_bytes());
        hasher.update(canonical.as_bytes());
        e.hash = hex_encode(&hasher.finalize());
        // Serialize once. Do **not** run high-entropy scrub on the whole JSON line:
        // that would redact the 64-hex `hash` field and break `verify_chain`.
        // Fields were already scrubbed above; the hash is computed over that.
        let line = serde_json::to_string(&e)?;
        let mut f = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?;
        writeln!(f, "{line}")?;
        *tail = e.hash;
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
            target: target.into(),
            outcome: outcome.into(),
            detail: detail.into(),
            bytes,
            prev_hash: String::new(),
            hash: String::new(),
        })
    }

    /// Verify hash chain integrity. Returns `Ok(())` or the first bad line (1-based).
    pub fn verify_chain(&self) -> CoreResult<()> {
        if !self.path.exists() {
            return Ok(());
        }
        let f = fs::File::open(&self.path)?;
        let reader = BufReader::new(f);
        let mut prev = Self::GENESIS.to_string();
        for (i, line) in reader.lines().enumerate() {
            let line = line?;
            if line.trim().is_empty() {
                continue;
            }
            let entry: AuditEntry = serde_json::from_str(&line)
                .map_err(|e| CoreError::Message(format!("audit line {}: json: {e}", i + 1)))?;
            if entry.prev_hash != prev {
                return Err(CoreError::Message(format!(
                    "audit line {}: prev_hash mismatch",
                    i + 1
                )));
            }
            let mut for_hash = entry.clone();
            for_hash.hash = String::new();
            let canonical = serde_json::to_string(&for_hash)?;
            let mut hasher = Sha256::new();
            hasher.update(for_hash.prev_hash.as_bytes());
            hasher.update(canonical.as_bytes());
            let expect = hex_encode(&hasher.finalize());
            if expect != entry.hash {
                return Err(CoreError::Message(format!(
                    "audit line {}: hash mismatch",
                    i + 1
                )));
            }
            prev = entry.hash;
        }
        Ok(())
    }
}

fn load_tail_hash(path: &Path) -> Option<String> {
    let text = fs::read_to_string(path).ok()?;
    let last = text.lines().rev().find(|l| !l.trim().is_empty())?;
    let entry: AuditEntry = serde_json::from_str(last).ok()?;
    if entry.hash.is_empty() {
        None
    } else {
        Some(entry.hash)
    }
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn scrub_line(s: &str) -> String {
    crate::redact::scrub_secrets(s)
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
            outcomes::ALLOWED,
            "ok",
            12,
        )
        .unwrap();
        let text = fs::read_to_string(log.path()).unwrap();
        assert!(text.contains("search_kb"));
        assert!(text.contains("allowed"));
        assert!(text.contains("prev_hash"));
        assert!(text.contains("hash"));
        log.verify_chain().unwrap();
    }

    #[test]
    fn chain_detects_tamper() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("audit.jsonl");
        let log = AuditLog::new(&path);
        log.log("a", ToolSideEffect::Read, "t", outcomes::ALLOWED, "1", 0)
            .unwrap();
        log.log("b", ToolSideEffect::Read, "t", outcomes::ALLOWED, "2", 0)
            .unwrap();
        log.log("c", ToolSideEffect::Read, "t", outcomes::DENIED, "3", 0)
            .unwrap();
        log.verify_chain().unwrap();

        // Edit middle line detail.
        let text = fs::read_to_string(&path).unwrap();
        let mut lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 3);
        let mut mid: AuditEntry = serde_json::from_str(lines[1]).unwrap();
        mid.detail = "TAMPERED".into();
        // Keep old hash so verify fails.
        let new_mid = serde_json::to_string(&mid).unwrap();
        lines[1] = &new_mid;
        // Need owned strings for write
        let owned: Vec<String> = lines.iter().map(|s| s.to_string()).collect();
        // Re-parse after replace
        let mut lines = owned;
        let mut mid: AuditEntry = serde_json::from_str(&lines[1]).unwrap();
        mid.detail = "TAMPERED".into();
        lines[1] = serde_json::to_string(&mid).unwrap();
        fs::write(&path, lines.join("\n") + "\n").unwrap();

        let v = AuditLog::new(&path).verify_chain();
        assert!(v.is_err(), "expected tamper detect, got {v:?}");
    }

    #[test]
    fn chain_detects_removed_line() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("audit.jsonl");
        let log = AuditLog::new(&path);
        log.log("a", ToolSideEffect::Read, "t", outcomes::PENDING, "1", 0)
            .unwrap();
        log.log("b", ToolSideEffect::Read, "t", outcomes::GRANTED, "2", 0)
            .unwrap();
        log.log("c", ToolSideEffect::Read, "t", outcomes::ALLOWED, "3", 0)
            .unwrap();
        let text = fs::read_to_string(&path).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        // Drop middle line — prev_hash of last no longer matches first's hash.
        fs::write(&path, format!("{}\n{}\n", lines[0], lines[2])).unwrap();
        let v = AuditLog::new(&path).verify_chain();
        assert!(v.is_err());
    }
}
