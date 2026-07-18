//! Durable typed memory contracts (Phase 0) and store surface.
//!
//! Frozen by [`docs/design/MEMORY.md`](../../../docs/design/MEMORY.md) §2:
//! unix-second timestamps, UUIDv7 ids, closed kind taxonomy + `Other`,
//! Status/Scope enums, canonical column names, [`MemoryStore`] /
//! [`MemoryWriteOp`], and tool names. Storage backends land in later issues;
//! this module is the single dictionary every Phase-1 unit imports.
//!
//! # Timestamp unit
//! All temporal fields are `i64` unix **seconds** (not ms, not RFC3339) so
//! [`crate::embed::recency_boost`] and [`crate::embed::now_unix_secs`] reuse
//! verbatim.
//!
//! # Clock
//! Production uses [`SystemClock`] → [`crate::embed::now_unix_secs`]. Tests
//! inject a fixed [`Clock`] or pass `now_secs` into store methods.

pub mod facade;
pub mod migrate;
pub mod recall;
pub mod sqlite_store;
pub mod types;

pub use facade::{
    ensure_workspace_memory_gitignored, personal_memory_db_path, workspace_memory_db_path,
    workspace_memory_gitignore_lines, MemoryConfig, TwoScopeMemory, WorkspaceMemoryLocation,
};
pub use sqlite_store::SqliteMemoryStore;
pub use types::*;

use crate::embed::{EmbedBackend, HybridWeights};
use crate::error::CoreResult;
use uuid::Uuid;

/// Source of "now" for store writes, valid-time predicates, and recency.
///
/// Keep this tiny: one method returning unix seconds. Thread `now_secs`
/// into [`MemoryStore::put`] / [`MemoryStore::recall`] for hermetic tests.
pub trait Clock: Send + Sync {
    /// Current time as unix seconds.
    fn now_secs(&self) -> i64;
}

/// Production clock: wall-clock unix seconds via [`crate::embed::now_unix_secs`].
#[derive(Debug, Default, Clone, Copy)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_secs(&self) -> i64 {
        crate::embed::now_unix_secs()
    }
}

/// Fixed clock for offline deterministic tests.
#[derive(Debug, Clone, Copy)]
pub struct FixedClock {
    /// Frozen unix-seconds value returned by every call.
    pub secs: i64,
}

impl Clock for FixedClock {
    fn now_secs(&self) -> i64 {
        self.secs
    }
}

/// Read/write memory store.
///
/// `SqliteMemoryStore` (default, embedded) is Phase 1; a Postgres backend is
/// additive later behind this same trait. Sync-reserved: [`Self::changes_since`].
pub trait MemoryStore: Send + Sync {
    /// Apply one write op at `now_secs` (injectable for tests).
    fn put(&self, op: MemoryWriteOp, now_secs: i64) -> CoreResult<MemoryRecord>;

    /// Fetch a single record by id (any status; no valid-now filter).
    fn get(&self, id: &Uuid) -> CoreResult<Option<MemoryRecord>>;

    /// Hybrid recall over the active-now view (see design §4).
    ///
    /// `embed` is optional — when `None`, ranking degrades to keyword + recency.
    fn recall(
        &self,
        q: &RecallQuery,
        embed: Option<&dyn EmbedBackend>,
        w: HybridWeights,
        now_secs: i64,
    ) -> CoreResult<Vec<RecallHit>>;

    /// Sync-reserved: records with `updated_at > cursor` (personal scope must
    /// never surface here — enforced by facade, not this trait alone).
    fn changes_since(&self, cursor: i64) -> CoreResult<Vec<MemoryRecord>>;
}

/// Build the frozen audit `target` string for a memory op.
///
/// Format: `mem://{scope}/{id}@v{rev}`. Do **not** add fields to `AuditEntry`
/// (breaks `verify_chain`); encode memory metadata only in `target`.
pub fn audit_target(scope: Scope, id: &Uuid, rev: i64) -> String {
    format!("mem://{}/{id}@v{rev}", scope.as_str())
}

/// Frozen tool names (MEMORY.md §2.7).
pub mod tool_names {
    /// Hybrid search / get / list (Read).
    pub const RECALL_MEMORY: &str = "recall_memory";
    /// Insert, or update when `id` supplied (SoftWrite).
    pub const SAVE_MEMORY: &str = "save_memory";
    /// Append-and-supersede content change (SoftWrite).
    pub const SUPERSEDE_MEMORY: &str = "supersede_memory";
    /// Soft tombstone (`status=retracted`). v1 tier is SoftWrite per owner
    /// default (§10); permanent purge remains HardWrite / type-to-confirm.
    pub const RETRACT_MEMORY: &str = "retract_memory";
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::embed::now_unix_secs;

    #[test]
    fn kind_round_trips_closed_and_other() {
        for k in [
            Kind::Fact,
            Kind::Decision,
            Kind::Bookmark,
            Kind::Preference,
            Kind::ProjectNote,
            Kind::Contact,
            Kind::Term,
            Kind::Task,
            Kind::Other("custom_import".into()),
        ] {
            let s = k.as_str().to_string();
            let back = Kind::parse(&s);
            assert_eq!(back, k, "kind round-trip failed for {s}");
            let json = serde_json::to_string(&k).unwrap();
            let de: Kind = serde_json::from_str(&json).unwrap();
            assert_eq!(de, k);
        }
    }

    #[test]
    fn status_and_scope_dictionaries() {
        assert_eq!(Status::Active.as_str(), "active");
        assert_eq!(Status::Superseded.as_str(), "superseded");
        assert_eq!(Status::Expired.as_str(), "expired");
        assert_eq!(Status::Retracted.as_str(), "retracted");
        assert_eq!(Scope::Personal.as_str(), "personal");
        assert_eq!(Scope::Workspace.as_str(), "workspace");
        assert_eq!(Status::parse("retracted"), Some(Status::Retracted));
        assert_eq!(Scope::parse("personal"), Some(Scope::Personal));
        assert!(Status::parse("deleted").is_none());
    }

    #[test]
    fn ids_are_uuid_v7() {
        let id = new_memory_id();
        assert_eq!(id.get_version(), Some(uuid::Version::SortRand));
        // v7 is time-ordered: two sequential ids should compare by creation order
        let a = new_memory_id();
        let b = new_memory_id();
        assert!(a <= b, "v7 should be sortable");
    }

    #[test]
    fn timestamps_are_unix_seconds_scale() {
        let now = now_unix_secs();
        // Roughly 2020..2100 in seconds (not ms)
        assert!(now > 1_500_000_000, "now looks like ms not secs: {now}");
        assert!(now < 4_000_000_000, "now looks like ms not secs: {now}");
        let fixed = FixedClock {
            secs: 1_700_000_000,
        };
        assert_eq!(fixed.now_secs(), 1_700_000_000);
        assert_eq!(SystemClock.now_secs(), now_unix_secs());
    }

    #[test]
    fn memory_record_serde_uses_canonical_columns() {
        let id = new_memory_id();
        let rec = MemoryRecord {
            id,
            kind: Kind::Fact,
            title: "T".into(),
            content: "body".into(),
            structured: serde_json::json!({"k": 1}),
            status: Status::Active,
            valid_from: Some(100),
            valid_to: None,
            supersedes: None,
            superseded_by: None,
            scope: Scope::Workspace,
            workspace_id: Some("ws".into()),
            confidence: Some(0.9),
            pinned: false,
            source: MemorySource::User,
            created_by: "user".into(),
            origin_session_id: None,
            origin_tool: None,
            created_at: 100,
            updated_at: 100,
            rev: 1,
            origin_node: None,
            content_hash: "abc".into(),
            url: None,
            due_at: None,
            tags: vec!["a".into()],
        };
        let v = serde_json::to_value(&rec).unwrap();
        // Canonical dictionary (§2.5) — no synonyms
        for key in [
            "id",
            "kind",
            "title",
            "content",
            "structured",
            "status",
            "valid_from",
            "valid_to",
            "supersedes",
            "superseded_by",
            "scope",
            "workspace_id",
            "confidence",
            "pinned",
            "source",
            "created_by",
            "origin_session_id",
            "origin_tool",
            "created_at",
            "updated_at",
            "rev",
            "origin_node",
            "content_hash",
            "url",
            "due_at",
            "tags",
        ] {
            assert!(v.get(key).is_some(), "missing column {key}");
        }
        assert!(v.get("body").is_none());
        assert!(v.get("mtype").is_none());
        assert!(v.get("version").is_none());
        let back: MemoryRecord = serde_json::from_value(v).unwrap();
        assert_eq!(back.id, id);
        assert_eq!(back.kind, Kind::Fact);
        assert_eq!(back.rev, 1);
    }

    #[test]
    fn write_op_variants_cover_design() {
        let draft = MemoryDraft {
            kind: Kind::Decision,
            title: String::new(),
            content: "ship it".into(),
            structured: serde_json::json!({}),
            scope: Scope::Workspace,
            workspace_id: None,
            tags: vec![],
            pinned: false,
            confidence: None,
            valid_from: None,
            valid_to: None,
            source: MemorySource::Agent,
            created_by: "agent".into(),
            origin_session_id: None,
            origin_tool: Some("save_memory".into()),
            url: None,
            due_at: None,
        };
        let _ops = [
            MemoryWriteOp::Insert(draft.clone()),
            MemoryWriteOp::UpdateMeta {
                id: new_memory_id(),
                tags: Some(vec!["x".into()]),
                pinned: Some(true),
                valid_to: Some(999),
                status: None,
            },
            MemoryWriteOp::Supersede {
                old: new_memory_id(),
                new: draft.clone(),
            },
            MemoryWriteOp::Retract {
                id: new_memory_id(),
            },
        ];
        assert_eq!(tool_names::RECALL_MEMORY, "recall_memory");
        assert_eq!(tool_names::SAVE_MEMORY, "save_memory");
        assert_eq!(tool_names::SUPERSEDE_MEMORY, "supersede_memory");
        assert_eq!(tool_names::RETRACT_MEMORY, "retract_memory");
    }

    #[test]
    fn audit_target_encoding() {
        let id = Uuid::nil();
        let t = audit_target(Scope::Personal, &id, 3);
        assert_eq!(t, "mem://personal/00000000-0000-0000-0000-000000000000@v3");
    }

    #[test]
    fn valid_now_predicate_matches_design() {
        let now = 1_000_i64;
        // NULL bounds => always valid
        assert!(is_valid_now(None, None, now));
        assert!(is_valid_now(Some(500), None, now));
        assert!(is_valid_now(None, Some(2000), now));
        assert!(is_valid_now(Some(500), Some(2000), now));
        // not yet valid
        assert!(!is_valid_now(Some(1500), None, now));
        // expired (valid_to is exclusive: valid_to > now)
        assert!(!is_valid_now(None, Some(1000), now));
        assert!(!is_valid_now(None, Some(999), now));
        assert!(is_valid_now(None, Some(1001), now));
    }

    #[test]
    fn draft_defaults_and_content_hash_reuse_embed_key() {
        let d = MemoryDraft::new(Kind::Fact, "hello world");
        assert_eq!(d.scope, Scope::Workspace);
        assert_eq!(d.source, MemorySource::User);
        let h = content_hash_for("hello world");
        assert_eq!(h, crate::embed::chunk_content_key("hello world"));
        assert!(!h.is_empty());
    }
}
