//! Chat sessions and compaction without deleting full history.
//!
//! Desktop persists full UI transcripts via [`SessionStore`]; host agent history
//! is derived from stored messages on load. Compact/fold is view-only.

use crate::chat::{ChatMessage, Role};
use crate::error::{CoreError, CoreResult};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

/// Lightweight row for sidebar / archive lists.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionMeta {
    /// Id.
    pub id: String,
    /// Title.
    pub title: String,
    /// Archived (soft-hide from default lists).
    pub archived: bool,
    /// Pinned to the app sidebar.
    #[serde(default)]
    pub pinned: bool,
    /// Created.
    pub created_at: DateTime<Utc>,
    /// Updated.
    pub updated_at: DateTime<Utc>,
    /// Message count (full history).
    pub message_count: usize,
    /// Short preview for list rows.
    pub preview: String,
}

/// Scored search hit for the chat archive.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionSearchHit {
    /// Session metadata.
    pub meta: SessionMeta,
    /// Relevance score (higher is better).
    pub score: f32,
    /// Optional matched snippet from body.
    #[serde(default)]
    pub snippet: String,
}

/// A durable chat session (UI-compatible fields for desktop).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    /// Id.
    pub id: String,
    /// Title.
    pub title: String,
    /// Full message history (UI-shaped).
    pub messages: Vec<StoredMessage>,
    /// Compact summary of older turns (optional; not required for UI fold).
    #[serde(default)]
    pub compact_summary: Option<String>,
    /// How many recent messages stay fully expanded in model context helpers.
    #[serde(default = "default_keep_last")]
    pub compact_keep_last: usize,
    /// When true, UI shows full history instead of auto-fold.
    #[serde(default)]
    pub show_full_history: bool,
    /// Created.
    pub created_at: DateTime<Utc>,
    /// Updated.
    pub updated_at: DateTime<Utc>,
    /// Archived (soft-hide).
    #[serde(default)]
    pub archived: bool,
    /// Pinned to sidebar shortcuts.
    #[serde(default)]
    pub pinned: bool,
    /// True once the user explicitly renames (blocks auto-title).
    #[serde(default)]
    pub title_locked: bool,
    /// Chat model id for this session (None → app default / active profile).
    #[serde(default)]
    pub chat_model: Option<String>,
    /// Provider profile id when the session model is not from the active default source.
    #[serde(default)]
    pub provider_profile_id: Option<String>,
    /// Last message id the user has scrolled into view / marked read.
    #[serde(default)]
    pub last_read_message_id: Option<String>,
}

fn default_keep_last() -> usize {
    6
}

/// One stored message (desktop transcript).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredMessage {
    /// Stable client id.
    pub id: String,
    /// `user` | `assistant` | `system` | `tool`.
    pub role: String,
    /// Text body.
    pub content: String,
    /// Optional tool-call UI payload (opaque JSON).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<serde_json::Value>,
    /// Optional citations.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub citations: Option<serde_json::Value>,
    /// Optional search trail.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trail: Option<Vec<String>>,
}

impl Session {
    /// New empty session with placeholder title.
    pub fn new(title: impl Into<String>) -> Self {
        let now = Utc::now();
        Self {
            id: Uuid::new_v4().to_string(),
            title: title.into(),
            messages: vec![],
            compact_summary: None,
            compact_keep_last: default_keep_last(),
            show_full_history: false,
            created_at: now,
            updated_at: now,
            archived: false,
            pinned: false,
            title_locked: false,
            chat_model: None,
            provider_profile_id: None,
            last_read_message_id: None,
        }
    }

    /// Touch updated_at.
    pub fn touch(&mut self) {
        self.updated_at = Utc::now();
    }

    /// List preview from last non-empty message.
    pub fn preview(&self) -> String {
        self.messages
            .iter()
            .rev()
            .find(|m| !m.content.trim().is_empty())
            .map(|m| {
                let t = m.content.replace('\n', " ");
                let t = t.trim();
                if t.chars().count() > 80 {
                    format!("{}…", t.chars().take(80).collect::<String>())
                } else {
                    t.to_string()
                }
            })
            .unwrap_or_default()
    }

    /// Convert to host agent history (role + content only).
    pub fn to_chat_history(&self) -> Vec<ChatMessage> {
        self.messages
            .iter()
            .filter_map(|m| {
                let role = match m.role.as_str() {
                    "user" => Role::User,
                    "assistant" => Role::Assistant,
                    "system" => Role::System,
                    "tool" => Role::Tool,
                    _ => return None,
                };
                Some(ChatMessage {
                    role,
                    content: m.content.clone(),
                    tool_call_id: None,
                    tool_calls: None,
                })
            })
            .collect()
    }

    /// Apply **heuristic** auto-title from first user prompt when allowed.
    ///
    /// Does not lock the title — LLM can upgrade later while `title_locked` is false.
    pub fn maybe_auto_title_from_first_user(&mut self) {
        if self.title_locked {
            return;
        }
        // Only replace placeholders or prior heuristic-length auto titles when empty-ish.
        if !is_placeholder_title(&self.title) {
            return;
        }
        if let Some(first) = self.messages.iter().find(|m| m.role == "user") {
            let t = title_from_prompt(&first.content, 40);
            if !t.is_empty() {
                self.title = t;
            }
        }
    }

    /// Apply an LLM (or other) suggested title when the user has not renamed.
    pub fn apply_suggested_title(&mut self, suggested: &str) {
        if self.title_locked {
            return;
        }
        let t = sanitize_generated_title(suggested, 48);
        if !t.is_empty() {
            self.title = t;
            self.touch();
        }
    }

    /// Messages for model context: summary + last N full (legacy helper).
    pub fn context_messages(&self) -> Vec<ChatMessage> {
        let hist = self.to_chat_history();
        let keep = self.compact_keep_last;
        if hist.len() <= keep {
            return hist;
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
        let start = hist.len().saturating_sub(keep);
        out.extend(hist[start..].iter().cloned());
        out
    }

    /// Build compact summary from older messages (lossy; full history retained).
    pub fn recompact(&mut self) {
        let keep = self.compact_keep_last;
        if self.messages.len() <= keep {
            self.compact_summary = None;
            return;
        }
        let older = &self.messages[..self.messages.len() - keep];
        let mut lines = Vec::new();
        for m in older {
            let snippet: String = m.content.chars().take(160).collect();
            lines.push(format!("- {}: {snippet}", m.role));
        }
        self.compact_summary = Some(lines.join("\n"));
        self.touch();
    }

    /// Meta row for listings.
    pub fn meta(&self) -> SessionMeta {
        SessionMeta {
            id: self.id.clone(),
            title: self.title.clone(),
            archived: self.archived,
            pinned: self.pinned,
            created_at: self.created_at,
            updated_at: self.updated_at,
            message_count: self.messages.len(),
            preview: self.preview(),
        }
    }
}

/// True when title is still an auto placeholder (`Chat`, `Chat 1`, …).
pub fn is_placeholder_title(title: &str) -> bool {
    let t = title.trim();
    if t.is_empty() {
        return true;
    }
    if t.eq_ignore_ascii_case("chat") {
        return true;
    }
    // Chat N / Chat 12
    let lower = t.to_ascii_lowercase();
    if let Some(rest) = lower.strip_prefix("chat ") {
        return rest.chars().all(|c| c.is_ascii_digit());
    }
    false
}

/// Derive a **short** session title from the first user prompt (no LLM).
///
/// Prefer first sentence / clause; hard-cap length so the sidebar never shows
/// the entire prompt.
pub fn title_from_prompt(prompt: &str, max_chars: usize) -> String {
    let one_line = prompt
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("")
        .replace('\t', " ");
    let collapsed: String = one_line.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        return String::new();
    }
    // Cut at sentence / clause boundary when short enough.
    let cut_at = collapsed
        .find(['.', '?', '!'])
        .map(|i| i + 1)
        .or_else(|| collapsed.find([';', ',']))
        .filter(|&i| i >= 12 && i <= max_chars.max(24));
    let base = if let Some(i) = cut_at {
        collapsed[..i].trim_end_matches(['.', '?', '!', ';', ',']).trim()
    } else {
        collapsed.as_str()
    };
    let max = max_chars.max(8).min(48);
    let mut out: String = base.chars().take(max).collect();
    if base.chars().count() > max {
        // Prefer break on last space inside window.
        if let Some(sp) = out.rfind(' ') {
            if sp >= 8 {
                out.truncate(sp);
            }
        }
        out = out.trim_end().to_string();
        out.push('…');
    }
    out
}

/// Prompt for a one-shot chat title completion (no tools).
pub fn session_title_llm_prompt(user_message: &str) -> String {
    let snippet: String = user_message.chars().take(800).collect();
    format!(
        "Create a concise chat title for this message.\n\
         Rules: 3–7 words, Title Case preferred, no quotes, no trailing punctuation, \
         no prefix like \"Title:\", English unless the message is clearly another language.\n\
         Message:\n{snippet}\n\
         Title:"
    )
}

/// Clean model output into a safe sidebar title.
pub fn sanitize_generated_title(raw: &str, max_chars: usize) -> String {
    let mut t = raw.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("").to_string();
    for prefix in [
        "Title:",
        "title:",
        "Chat title:",
        "Here's a title:",
        "Here is a title:",
    ] {
        if let Some(rest) = t.strip_prefix(prefix) {
            t = rest.trim().to_string();
        }
    }
    t = t
        .trim_matches(|c: char| c == '"' || c == '\'' || c == '`' || c == '*')
        .trim()
        .trim_end_matches(['.', '!', '?'])
        .trim()
        .to_string();
    // Collapse whitespace.
    t = t.split_whitespace().collect::<Vec<_>>().join(" ");
    if t.is_empty() || is_placeholder_title(&t) {
        return String::new();
    }
    let max = max_chars.max(8).min(64);
    if t.chars().count() > max {
        let mut out: String = t.chars().take(max).collect();
        if let Some(sp) = out.rfind(' ') {
            if sp >= 8 {
                out.truncate(sp);
            }
        }
        t = out.trim_end().to_string();
        if !t.ends_with('…') {
            t.push('…');
        }
    }
    t
}

/// Session store on disk (`*.json` per session).
#[derive(Debug, Clone)]
pub struct SessionStore {
    dir: PathBuf,
}

impl SessionStore {
    /// Create store under dir.
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    /// Sessions directory path.
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Ensure dir.
    pub fn ensure(&self) -> CoreResult<()> {
        fs::create_dir_all(&self.dir)?;
        Ok(())
    }

    fn path(&self, id: &str) -> PathBuf {
        // Reject path traversal in id.
        let safe = id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
        if !safe || id.is_empty() {
            return self.dir.join("_invalid.json");
        }
        self.dir.join(format!("{id}.json"))
    }

    fn validate_id(id: &str) -> CoreResult<()> {
        if id.is_empty()
            || !id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        {
            return Err(CoreError::Policy("invalid session id".into()));
        }
        Ok(())
    }

    /// Save session.
    pub fn save(&self, session: &Session) -> CoreResult<()> {
        Self::validate_id(&session.id)?;
        self.ensure()?;
        let p = self.path(&session.id);
        fs::write(p, serde_json::to_string_pretty(session)?)?;
        Ok(())
    }

    /// Load session.
    pub fn load(&self, id: &str) -> CoreResult<Session> {
        Self::validate_id(id)?;
        let raw = fs::read_to_string(self.path(id))?;
        Ok(serde_json::from_str(&raw)?)
    }

    /// Delete session file if present.
    pub fn delete(&self, id: &str) -> CoreResult<()> {
        Self::validate_id(id)?;
        let p = self.path(id);
        if p.exists() {
            fs::remove_file(p)?;
        }
        Ok(())
    }

    /// List sessions (ids + titles + archived) — unsorted legacy shape.
    pub fn list(&self) -> CoreResult<Vec<(String, String, bool)>> {
        let metas = self.list_meta()?;
        Ok(metas
            .into_iter()
            .map(|m| (m.id, m.title, m.archived))
            .collect())
    }

    /// List session metadata, newest `updated_at` first (pinned first among ties).
    pub fn list_meta(&self) -> CoreResult<Vec<SessionMeta>> {
        let mut sessions = self.load_all()?;
        sessions.sort_by(|a, b| {
            b.pinned
                .cmp(&a.pinned)
                .then_with(|| b.updated_at.cmp(&a.updated_at))
        });
        Ok(sessions.iter().map(Session::meta).collect())
    }

    /// Load every session from disk.
    pub fn load_all(&self) -> CoreResult<Vec<Session>> {
        self.ensure()?;
        let mut out = Vec::new();
        if let Ok(rd) = fs::read_dir(&self.dir) {
            for ent in rd.flatten() {
                let path = ent.path();
                if path.extension().and_then(|e| e.to_str()) != Some("json") {
                    continue;
                }
                let Some(stem) = path.file_stem().and_then(|x| x.to_str()) else {
                    continue;
                };
                if let Ok(s) = self.load(stem) {
                    out.push(s);
                }
            }
        }
        Ok(out)
    }

    /// Keyword search over titles + message bodies (scored, newest break ties).
    ///
    /// Empty query returns all non-archived metas as zero-score hits (archive browse).
    pub fn search(&self, query: &str, limit: usize, include_archived: bool) -> CoreResult<Vec<SessionSearchHit>> {
        let terms = tokenize_query(query);
        let mut hits = Vec::new();
        for s in self.load_all()? {
            if s.archived && !include_archived {
                continue;
            }
            if terms.is_empty() {
                hits.push(SessionSearchHit {
                    meta: s.meta(),
                    score: if s.pinned { 0.1 } else { 0.0 },
                    snippet: s.preview(),
                });
                continue;
            }
            let (score, snippet) = score_session(&s, &terms);
            if score > 0.0 {
                hits.push(SessionSearchHit {
                    meta: s.meta(),
                    score,
                    snippet,
                });
            }
        }
        hits.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| b.meta.updated_at.cmp(&a.meta.updated_at))
        });
        if limit > 0 && hits.len() > limit {
            hits.truncate(limit);
        }
        Ok(hits)
    }
}

fn tokenize_query(q: &str) -> Vec<String> {
    q.split(|c: char| !c.is_alphanumeric())
        .map(|t| t.trim().to_ascii_lowercase())
        .filter(|t| t.len() >= 2)
        .collect()
}

fn score_session(s: &Session, terms: &[String]) -> (f32, String) {
    let title_l = s.title.to_ascii_lowercase();
    let mut body = String::new();
    for m in &s.messages {
        body.push_str(&m.content);
        body.push('\n');
    }
    let body_l = body.to_ascii_lowercase();
    let mut score = 0.0_f32;
    let mut snippet = String::new();
    for term in terms {
        if title_l.contains(term) {
            score += 4.0;
        }
        if let Some(idx) = body_l.find(term.as_str()) {
            score += 1.0;
            if snippet.is_empty() {
                let start = idx.saturating_sub(40);
                let end = (idx + term.len() + 60).min(body.len());
                // Map byte indices carefully — use char boundaries on original body via lower match
                let raw = body.get(start..end).unwrap_or("").replace('\n', " ");
                snippet = format!("…{}…", raw.trim());
            }
        }
    }
    if score <= 0.0 {
        return (0.0, String::new());
    }
    if s.pinned {
        score += 0.25;
    }
    // Mild recency boost only when there was a keyword hit
    let age_hours = (Utc::now() - s.updated_at).num_hours().max(0) as f32;
    score += (1.0 / (1.0 + age_hours / 720.0)) * 0.5;
    if snippet.is_empty() {
        snippet = s.preview();
    }
    (score, snippet)
}

/// Full history always available even when compact view used.
pub fn expand_full_history(session: &Session) -> &[StoredMessage] {
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
            s.messages.push(StoredMessage {
                id: format!("m{i}"),
                role: "user".into(),
                content: format!("msg {i} with details"),
                tools: None,
                citations: None,
                trail: None,
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
        s.messages.push(StoredMessage {
            id: "1".into(),
            role: "user".into(),
            content: "hi".into(),
            tools: None,
            citations: None,
            trail: None,
        });
        store.save(&s).unwrap();
        let loaded = store.load(&s.id).unwrap();
        assert_eq!(loaded.title, "Research");
        assert_eq!(loaded.messages.len(), 1);
    }

    #[test]
    fn auto_title_from_prompt() {
        assert_eq!(
            title_from_prompt("  Hello world\nsecond line  ", 40),
            "Hello world"
        );
        let long = "a".repeat(100);
        let t = title_from_prompt(&long, 20);
        assert!(t.ends_with('…'));
        assert!(t.chars().count() <= 21);
        // Does not dump an entire long first sentence when a clause break exists.
        let t2 = title_from_prompt(
            "How do I configure Ollama for local models, and what ports should I open for the API?",
            40,
        );
        assert!(t2.len() < 80);
        assert!(!t2.contains("ports should I open"));
    }

    #[test]
    fn sanitize_llm_title() {
        assert_eq!(
            sanitize_generated_title("Title: \"Ollama Local Setup\"", 48),
            "Ollama Local Setup"
        );
        assert!(sanitize_generated_title("Chat 1", 48).is_empty());
    }

    #[test]
    fn placeholder_titles() {
        assert!(is_placeholder_title("Chat"));
        assert!(is_placeholder_title("Chat 1"));
        assert!(is_placeholder_title("chat 12"));
        assert!(!is_placeholder_title("Hello world"));
    }

    #[test]
    fn maybe_auto_title_locks() {
        let mut s = Session::new("Chat 1");
        s.messages.push(StoredMessage {
            id: "u1".into(),
            role: "user".into(),
            content: "How do I configure Ollama locally?".into(),
            tools: None,
            citations: None,
            trail: None,
        });
        s.maybe_auto_title_from_first_user();
        assert!(s.title.contains("Ollama") || s.title.contains("configure"));
        s.title_locked = true;
        s.title = "My name".into();
        s.maybe_auto_title_from_first_user();
        assert_eq!(s.title, "My name");
    }

    #[test]
    fn list_meta_sorted_and_delete() {
        let dir = tempdir().unwrap();
        let store = SessionStore::new(dir.path());
        let mut a = Session::new("Chat 1");
        a.id = "aaa".into();
        a.messages.push(StoredMessage {
            id: "1".into(),
            role: "user".into(),
            content: "first".into(),
            tools: None,
            citations: None,
            trail: None,
        });
        a.touch();
        store.save(&a).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        let mut b = Session::new("Chat 2");
        b.id = "bbb".into();
        b.messages.push(StoredMessage {
            id: "1".into(),
            role: "user".into(),
            content: "second".into(),
            tools: None,
            citations: None,
            trail: None,
        });
        b.touch();
        store.save(&b).unwrap();
        let list = store.list_meta().unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].id, "bbb");
        store.delete("bbb").unwrap();
        assert_eq!(store.list_meta().unwrap().len(), 1);
    }

    #[test]
    fn search_scores_title_and_body() {
        let dir = tempdir().unwrap();
        let store = SessionStore::new(dir.path());
        let mut a = Session::new("Ollama setup");
        a.id = "s1".into();
        a.messages.push(StoredMessage {
            id: "1".into(),
            role: "user".into(),
            content: "How do I install ollama on macOS?".into(),
            tools: None,
            citations: None,
            trail: None,
        });
        store.save(&a).unwrap();
        let mut b = Session::new("Unrelated");
        b.id = "s2".into();
        b.messages.push(StoredMessage {
            id: "1".into(),
            role: "user".into(),
            content: "What is the weather?".into(),
            tools: None,
            citations: None,
            trail: None,
        });
        store.save(&b).unwrap();
        let hits = store.search("ollama", 10, false).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].meta.id, "s1");
        assert!(hits[0].score > 0.0);
    }

    #[test]
    fn pin_sorts_first_in_list_meta() {
        let dir = tempdir().unwrap();
        let store = SessionStore::new(dir.path());
        let mut a = Session::new("Old");
        a.id = "old".into();
        a.pinned = false;
        a.touch();
        store.save(&a).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        let mut b = Session::new("New");
        b.id = "new".into();
        b.pinned = false;
        b.touch();
        store.save(&b).unwrap();
        // Pin older one
        a.pinned = true;
        store.save(&a).unwrap();
        let list = store.list_meta().unwrap();
        assert_eq!(list[0].id, "old");
        assert!(list[0].pinned);
    }

    #[test]
    fn rejects_bad_ids() {
        let dir = tempdir().unwrap();
        let store = SessionStore::new(dir.path());
        let mut s = Session::new("x");
        s.id = "../evil".into();
        assert!(store.save(&s).is_err());
    }
}
