//! Phase-0 memory value types — column dictionary and write/read shapes.
//!
//! Names match [`docs/design/MEMORY.md`](../../../../docs/design/MEMORY.md) §2.5
//! exactly. Do not introduce synonyms (`body`, `mtype`, `version`, …).

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Closed kind taxonomy plus open escape hatch for imports / forward-compat.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    /// Atomic fact.
    Fact,
    /// Decision with optional rationale in `structured`.
    Decision,
    /// URL bookmark.
    Bookmark,
    /// User/agent preference.
    Preference,
    /// Free-form project note.
    ProjectNote,
    /// Person / contact (PII — flag-don't-strip per §10).
    Contact,
    /// Domain term / glossary entry.
    Term,
    /// Task / reminder.
    Task,
    /// Unrecognized kind string (round-trips; does not error).
    Other(String),
}

impl Kind {
    /// Canonical wire / column string.
    pub fn as_str(&self) -> &str {
        match self {
            Kind::Fact => "fact",
            Kind::Decision => "decision",
            Kind::Bookmark => "bookmark",
            Kind::Preference => "preference",
            Kind::ProjectNote => "project_note",
            Kind::Contact => "contact",
            Kind::Term => "term",
            Kind::Task => "task",
            Kind::Other(s) => s.as_str(),
        }
    }

    /// Parse a stored kind; unknown → [`Kind::Other`].
    pub fn parse(s: &str) -> Self {
        match s {
            "fact" => Kind::Fact,
            "decision" => Kind::Decision,
            "bookmark" => Kind::Bookmark,
            "preference" => Kind::Preference,
            "project_note" => Kind::ProjectNote,
            "contact" => Kind::Contact,
            "term" => Kind::Term,
            "task" => Kind::Task,
            other => Kind::Other(other.to_string()),
        }
    }
}

/// Lifecycle status (append-and-supersede; no content DELETE for normal forget).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    /// Currently believed / visible by default.
    Active,
    /// Replaced by a newer row via Supersede.
    Superseded,
    /// Past `valid_to` (lazy; may also be filtered by valid-now).
    Expired,
    /// Soft tombstone ("forget"); reversible.
    Retracted,
}

impl Status {
    /// Canonical column string.
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Active => "active",
            Status::Superseded => "superseded",
            Status::Expired => "expired",
            Status::Retracted => "retracted",
        }
    }

    /// Parse; unknown → `None`.
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "active" => Some(Status::Active),
            "superseded" => Some(Status::Superseded),
            "expired" => Some(Status::Expired),
            "retracted" => Some(Status::Retracted),
            _ => None,
        }
    }
}

/// Privacy / placement axis (v1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Scope {
    /// OS app-data; structurally barred from sync.
    Personal,
    /// Workspace-scoped store (in-repo gitignored by default).
    Workspace,
}

impl Scope {
    /// Canonical column string.
    pub fn as_str(self) -> &'static str {
        match self {
            Scope::Personal => "personal",
            Scope::Workspace => "workspace",
        }
    }

    /// Parse; unknown → `None`.
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "personal" => Some(Scope::Personal),
            "workspace" => Some(Scope::Workspace),
            _ => None,
        }
    }
}

/// Provenance of a memory row.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum MemorySource {
    /// Explicit user capture.
    #[default]
    User,
    /// Agent-proposed (still human-confirmed on write).
    Agent,
    /// One-shot migration / import.
    Import,
    /// External connector.
    Connector,
}

impl MemorySource {
    /// Canonical column string.
    pub fn as_str(self) -> &'static str {
        match self {
            MemorySource::User => "user",
            MemorySource::Agent => "agent",
            MemorySource::Import => "import",
            MemorySource::Connector => "connector",
        }
    }

    /// Parse with default `user` for unknown.
    pub fn parse(s: &str) -> Self {
        match s {
            "user" => MemorySource::User,
            "agent" => MemorySource::Agent,
            "import" => MemorySource::Import,
            "connector" => MemorySource::Connector,
            _ => MemorySource::User,
        }
    }
}

/// Full stored memory row (canonical columns + tags join).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MemoryRecord {
    /// UUIDv7 primary key.
    pub id: Uuid,
    /// Kind taxonomy value.
    pub kind: Kind,
    /// Short title (derived from content if empty at insert).
    pub title: String,
    /// Markdown body (embedded + keyword-indexed).
    pub content: String,
    /// Kind-specific JSON blob.
    pub structured: serde_json::Value,
    /// Lifecycle status.
    pub status: Status,
    /// Valid-time start (unix secs); `None` ⇒ since `created_at`.
    pub valid_from: Option<i64>,
    /// Valid-time end (unix secs, exclusive); `None` ⇒ still valid.
    pub valid_to: Option<i64>,
    /// Id this row supersedes, if any.
    pub supersedes: Option<Uuid>,
    /// Id that superseded this row, if any.
    pub superseded_by: Option<Uuid>,
    /// personal | workspace.
    pub scope: Scope,
    /// Workspace id when `scope=workspace`.
    pub workspace_id: Option<String>,
    /// Optional 0..1 confidence.
    pub confidence: Option<f32>,
    /// Pinned memories get a recall boost and never auto-expire.
    pub pinned: bool,
    /// Provenance.
    pub source: MemorySource,
    /// Author label (`user`, agent id, …).
    pub created_by: String,
    /// Originating session when agent-authored.
    pub origin_session_id: Option<String>,
    /// Originating tool name when agent-authored.
    pub origin_tool: Option<String>,
    /// Created-at unix seconds.
    pub created_at: i64,
    /// Updated-at unix seconds (bumped every mutation).
    pub updated_at: i64,
    /// Monotonic revision (LWW tiebreak; sync-reserved).
    pub rev: i64,
    /// Authoring node id; `None` = local (sync-reserved).
    pub origin_node: Option<String>,
    /// [`crate::embed::chunk_content_key`] of content.
    pub content_hash: String,
    /// Bookmark URL column (also in structured).
    pub url: Option<String>,
    /// Task due-at unix seconds.
    pub due_at: Option<i64>,
    /// Tags from `memory_tags` join (not a column on `memory`).
    #[serde(default)]
    pub tags: Vec<String>,
}

/// Draft payload for Insert / Supersede (no id/rev/status yet).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MemoryDraft {
    /// Kind.
    pub kind: Kind,
    /// Title; empty ⇒ derived from content at put.
    #[serde(default)]
    pub title: String,
    /// Markdown body.
    pub content: String,
    /// Kind-specific JSON; default `{}`.
    #[serde(default = "empty_object")]
    pub structured: serde_json::Value,
    /// Scope; default workspace.
    #[serde(default = "default_scope")]
    pub scope: Scope,
    /// Workspace id when workspace-scoped.
    #[serde(default)]
    pub workspace_id: Option<String>,
    /// Tags.
    #[serde(default)]
    pub tags: Vec<String>,
    /// Pin flag.
    #[serde(default)]
    pub pinned: bool,
    /// Optional confidence.
    #[serde(default)]
    pub confidence: Option<f32>,
    /// Optional valid_from.
    #[serde(default)]
    pub valid_from: Option<i64>,
    /// Optional valid_to.
    #[serde(default)]
    pub valid_to: Option<i64>,
    /// Provenance.
    #[serde(default)]
    pub source: MemorySource,
    /// Author label.
    #[serde(default = "default_created_by")]
    pub created_by: String,
    /// Session id.
    #[serde(default)]
    pub origin_session_id: Option<String>,
    /// Tool name.
    #[serde(default)]
    pub origin_tool: Option<String>,
    /// Bookmark URL.
    #[serde(default)]
    pub url: Option<String>,
    /// Task due.
    #[serde(default)]
    pub due_at: Option<i64>,
}

fn empty_object() -> serde_json::Value {
    serde_json::json!({})
}

fn default_scope() -> Scope {
    Scope::Workspace
}

fn default_created_by() -> String {
    "user".into()
}

impl MemoryDraft {
    /// Minimal draft constructor.
    pub fn new(kind: Kind, content: impl Into<String>) -> Self {
        Self {
            kind,
            title: String::new(),
            content: content.into(),
            structured: serde_json::json!({}),
            scope: Scope::Workspace,
            workspace_id: None,
            tags: vec![],
            pinned: false,
            confidence: None,
            valid_from: None,
            valid_to: None,
            source: MemorySource::User,
            created_by: "user".into(),
            origin_session_id: None,
            origin_tool: None,
            url: None,
            due_at: None,
        }
    }
}

/// Every mutation is one of these (MEMORY.md §2.6).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum MemoryWriteOp {
    /// Insert a new active row.
    Insert(MemoryDraft),
    /// Metadata-only update (never mutates content in place).
    UpdateMeta {
        /// Target id.
        id: Uuid,
        /// Replace tags when `Some`.
        tags: Option<Vec<String>>,
        /// Set pinned when `Some`.
        pinned: Option<bool>,
        /// Set valid_to when `Some`.
        valid_to: Option<i64>,
        /// Set status when `Some` (rare; prefer Supersede/Retract).
        status: Option<Status>,
    },
    /// Content change: new row supersedes `old` (old → superseded).
    Supersede {
        /// Id being replaced.
        old: Uuid,
        /// Replacement draft.
        new: MemoryDraft,
    },
    /// Soft tombstone: `status = retracted` (reversible).
    Retract {
        /// Id to retract.
        id: Uuid,
    },
}

/// Query for hybrid recall.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RecallQuery {
    /// Free-text query (keyword + semantic).
    pub query: String,
    /// Optional kind filter.
    #[serde(default)]
    pub kinds: Option<Vec<Kind>>,
    /// Max hits (default 10).
    #[serde(default = "default_k")]
    pub k: usize,
    /// When true, return supersession chains (newest first) instead of collapsing.
    #[serde(default)]
    pub include_superseded: bool,
    /// Scope filter; `None` = both (facade merges pools).
    #[serde(default)]
    pub scope: Option<Scope>,
    /// Optional min hybrid score floor.
    #[serde(default)]
    pub min_score: Option<f32>,
}

fn default_k() -> usize {
    10
}

impl RecallQuery {
    /// Build a simple query with default k.
    pub fn new(query: impl Into<String>) -> Self {
        Self {
            query: query.into(),
            kinds: None,
            k: 10,
            include_superseded: false,
            scope: None,
            min_score: None,
        }
    }
}

/// One recall hit with score and citation id.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RecallHit {
    /// Matched record.
    pub record: MemoryRecord,
    /// Hybrid score.
    pub score: f32,
    /// Keyword component (raw or normalized per pool).
    pub keyword_score: f32,
    /// Semantic cosine (0 when no embed).
    pub semantic_score: f32,
    /// Recency boost component.
    pub recency_score: f32,
    /// Citation `source_id` = `memory:{id}`.
    pub source_id: String,
    /// Short snippet for UI / tool output.
    pub snippet: String,
}

impl RecallHit {
    /// Build citation source_id for a memory id.
    pub fn memory_source_id(id: &Uuid) -> String {
        format!("memory:{id}")
    }
}

/// Allocate a new UUIDv7 memory id (k-sortable, offline-stable).
pub fn new_memory_id() -> Uuid {
    Uuid::now_v7()
}

/// Parse a memory id string (host IPC / tools).
pub fn parse_memory_id(s: &str) -> crate::error::CoreResult<Uuid> {
    Uuid::parse_str(s.trim())
        .map_err(|e| crate::error::CoreError::Message(format!("invalid memory id: {e}")))
}

/// Content hash = [`crate::embed::chunk_content_key`] (dedupe + embed cache key).
pub fn content_hash_for(content: &str) -> String {
    crate::embed::chunk_content_key(content)
}

/// Stable import fingerprint for bulk import idempotency (Phase 2).
pub fn import_fp(source: &str, remote_or_path_key: &str) -> String {
    crate::embed::chunk_content_key(&format!("{source}\0{remote_or_path_key}"))
}

/// Tombstone left after GDPR purge (content hard-deleted).
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct PurgeTombstone {
    /// Purged memory id.
    pub id: Uuid,
    /// When purged (unix secs).
    pub purged_at: i64,
    /// Kind at purge time.
    pub kind: String,
    /// Scope at purge time.
    pub scope: String,
    /// Content hash (for audit; content itself is gone).
    pub content_hash: String,
    /// Redacted title stub (no body).
    pub title_redacted: String,
    /// Reason string (e.g. gdpr_purge).
    pub reason: String,
}

/// Valid-now predicate (MEMORY.md §4):  
/// `(valid_from IS NULL OR valid_from <= now) AND (valid_to IS NULL OR valid_to > now)`.
pub fn is_valid_now(valid_from: Option<i64>, valid_to: Option<i64>, now_secs: i64) -> bool {
    let from_ok = valid_from.map(|f| f <= now_secs).unwrap_or(true);
    let to_ok = valid_to.map(|t| t > now_secs).unwrap_or(true);
    from_ok && to_ok
}

/// Derive a short title from markdown body or fallback name (shared with memory_fs).
pub fn title_from_content(content: &str, fallback: &str) -> String {
    for line in content.lines() {
        let t = line.trim();
        if let Some(rest) = t.strip_prefix('#') {
            let title = rest.trim_start_matches('#').trim();
            if !title.is_empty() {
                return title.to_string();
            }
        }
        if !t.is_empty() {
            // First non-empty line, truncated
            let mut s = t.to_string();
            if s.len() > 80 {
                s = crate::text::truncate_bytes(&s, 80).to_string();
            }
            return s;
        }
    }
    fallback.to_string()
}
