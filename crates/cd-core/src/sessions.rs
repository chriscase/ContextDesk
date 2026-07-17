//! Chat sessions and compaction without deleting full history.

use crate::chat::{ChatMessage, Role};
use crate::error::CoreResult;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use uuid::Uuid;

/// A durable chat session.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    /// Id.
    pub id: String,
    /// Title.
    pub title: String,
    /// Full message history.
    pub messages: Vec<ChatMessage>,
    /// Compact summary of older turns (optional).
    pub compact_summary: Option<String>,
    /// Index into messages where compact view starts showing full messages.
    pub compact_keep_last: usize,
    /// Created.
    pub created_at: DateTime<Utc>,
    /// Updated.
    pub updated_at: DateTime<Utc>,
    /// Archived.
    #[serde(default)]
    pub archived: bool,
}

impl Session {
    /// New empty session.
    pub fn new(title: impl Into<String>) -> Self {
        let now = Utc::now();
        Self {
            id: Uuid::new_v4().to_string(),
            title: title.into(),
            messages: vec![],
            compact_summary: None,
            compact_keep_last: 12,
            created_at: now,
            updated_at: now,
            archived: false,
        }
    }

    /// Messages for model context: summary + last N full.
    pub fn context_messages(&self) -> Vec<ChatMessage> {
        let keep = self.compact_keep_last;
        if self.messages.len() <= keep {
            return self.messages.clone();
        }
        let mut out = Vec::new();
        if let Some(sum) = &self.compact_summary {
            out.push(ChatMessage {
                role: Role::System,
                content: format!("[Compacted earlier conversation]\n{sum}"),
                tool_call_id: None,
                tool_calls: None,
            });
        }
        let start = self.messages.len().saturating_sub(keep);
        out.extend(self.messages[start..].iter().cloned());
        out
    }

    /// Build compact summary from older messages (lossy but full history retained).
    pub fn recompact(&mut self) {
        let keep = self.compact_keep_last;
        if self.messages.len() <= keep {
            self.compact_summary = None;
            return;
        }
        let older = &self.messages[..self.messages.len() - keep];
        let mut lines = Vec::new();
        for m in older {
            let role = format!("{:?}", m.role);
            let snippet: String = m.content.chars().take(160).collect();
            lines.push(format!("- {role}: {snippet}"));
        }
        self.compact_summary = Some(lines.join("\n"));
        self.updated_at = Utc::now();
    }
}

/// Session store on disk.
#[derive(Debug, Clone)]
pub struct SessionStore {
    dir: PathBuf,
}

impl SessionStore {
    /// Create store under dir.
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    /// Ensure dir.
    pub fn ensure(&self) -> CoreResult<()> {
        fs::create_dir_all(&self.dir)?;
        Ok(())
    }

    fn path(&self, id: &str) -> PathBuf {
        self.dir.join(format!("{id}.json"))
    }

    /// Save session.
    pub fn save(&self, session: &Session) -> CoreResult<()> {
        self.ensure()?;
        let p = self.path(&session.id);
        fs::write(p, serde_json::to_string_pretty(session)?)?;
        Ok(())
    }

    /// Load session.
    pub fn load(&self, id: &str) -> CoreResult<Session> {
        let raw = fs::read_to_string(self.path(id))?;
        Ok(serde_json::from_str(&raw)?)
    }

    /// List sessions (ids + titles).
    pub fn list(&self) -> CoreResult<Vec<(String, String, bool)>> {
        self.ensure()?;
        let mut out = Vec::new();
        if let Ok(rd) = fs::read_dir(&self.dir) {
            for ent in rd.flatten() {
                if ent.path().extension().and_then(|e| e.to_str()) == Some("json") {
                    if let Ok(s) = self.load(
                        ent.path()
                            .file_stem()
                            .and_then(|x| x.to_str())
                            .unwrap_or(""),
                    ) {
                        out.push((s.id, s.title, s.archived));
                    }
                }
            }
        }
        Ok(out)
    }
}

/// Full history always available even when compact view used.
pub fn expand_full_history(session: &Session) -> &[ChatMessage] {
    &session.messages
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn compact_keeps_full_history() {
        let mut s = Session::new("t");
        s.compact_keep_last = 2;
        for i in 0..6 {
            s.messages.push(ChatMessage {
                role: Role::User,
                content: format!("msg {i} with details"),
                tool_call_id: None,
                tool_calls: None,
            });
        }
        s.recompact();
        assert!(s.compact_summary.is_some());
        assert_eq!(expand_full_history(&s).len(), 6);
        let ctx = s.context_messages();
        assert!(ctx.len() < 6);
        assert!(ctx[0].content.contains("Compacted"));
    }

    #[test]
    fn store_roundtrip() {
        let dir = tempdir().unwrap();
        let store = SessionStore::new(dir.path());
        let mut s = Session::new("Research");
        s.messages.push(ChatMessage {
            role: Role::User,
            content: "hi".into(),
            tool_call_id: None,
            tool_calls: None,
        });
        store.save(&s).unwrap();
        let loaded = store.load(&s.id).unwrap();
        assert_eq!(loaded.title, "Research");
    }
}
