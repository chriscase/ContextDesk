//! Candidate review inbox — non-durable until SoftWrite approve (MEMORY.md §9).

use super::cue::{CandidateStatus, CueExtractOpts, CueExtractor, MemoryCandidate};
use super::dedup::{apply_dedup_proposal, detect_dedup};
use super::types::*;
use crate::embed::EmbedBackend;
use crate::error::{CoreError, CoreResult};
use rusqlite::{params, Connection, OptionalExtension};
use std::sync::Mutex;
use uuid::Uuid;

/// SQLite-backed candidate inbox (co-located with workspace memory DB or dedicated path).
pub struct CandidateInbox {
    conn: Mutex<Connection>,
}

impl CandidateInbox {
    /// Open/create inbox at path.
    pub fn open(path: impl AsRef<std::path::Path>) -> CoreResult<Self> {
        if let Some(parent) = path.as_ref().parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path.as_ref())
            .map_err(|e| CoreError::Message(format!("candidate inbox open: {e}")))?;
        init_schema(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Hermetic in-memory inbox.
    pub fn open_in_memory() -> CoreResult<Self> {
        let conn = Connection::open_in_memory()
            .map_err(|e| CoreError::Message(format!("candidate inbox mem: {e}")))?;
        init_schema(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Insert a candidate (pending).
    pub fn put(&self, c: &MemoryCandidate) -> CoreResult<()> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        conn.execute(
            r#"INSERT INTO memory_candidates (
                id, kind, title, content, scope, salience, confidence, content_hash,
                origin_session_id, cue, source_excerpt, created_at, status, propose_supersede_of
            ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)
            ON CONFLICT(id) DO UPDATE SET
                title=excluded.title, content=excluded.content, salience=excluded.salience,
                confidence=excluded.confidence, status=excluded.status,
                propose_supersede_of=excluded.propose_supersede_of
            "#,
            params![
                c.id.to_string(),
                c.kind.as_str(),
                c.title,
                c.content,
                c.scope.as_str(),
                c.salience as f64,
                c.confidence as f64,
                c.content_hash,
                c.origin_session_id,
                c.cue,
                c.source_excerpt,
                c.created_at,
                c.status.as_str(),
                c.propose_supersede_of.map(|u| u.to_string()),
            ],
        )
        .map_err(sqlite_err)?;
        Ok(())
    }

    /// List candidates (default pending only).
    pub fn list(&self, include_resolved: bool, limit: usize) -> CoreResult<Vec<MemoryCandidate>> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        let sql = if include_resolved {
            "SELECT id, kind, title, content, scope, salience, confidence, content_hash,
                    origin_session_id, cue, source_excerpt, created_at, status, propose_supersede_of
             FROM memory_candidates ORDER BY created_at DESC LIMIT ?1"
        } else {
            "SELECT id, kind, title, content, scope, salience, confidence, content_hash,
                    origin_session_id, cue, source_excerpt, created_at, status, propose_supersede_of
             FROM memory_candidates WHERE status = 'pending'
             ORDER BY salience DESC, created_at DESC LIMIT ?1"
        };
        let mut stmt = conn.prepare(sql).map_err(sqlite_err)?;
        let rows = stmt
            .query_map(params![limit.clamp(1, 500) as i64], row_to_candidate)
            .map_err(sqlite_err)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(sqlite_err)?);
        }
        Ok(out)
    }

    /// Get one candidate.
    pub fn get(&self, id: &Uuid) -> CoreResult<Option<MemoryCandidate>> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        let row = conn
            .query_row(
                "SELECT id, kind, title, content, scope, salience, confidence, content_hash,
                        origin_session_id, cue, source_excerpt, created_at, status, propose_supersede_of
                 FROM memory_candidates WHERE id = ?1",
                params![id.to_string()],
                row_to_candidate,
            )
            .optional()
            .map_err(sqlite_err)?;
        Ok(row)
    }

    /// Update status.
    pub fn set_status(&self, id: &Uuid, status: CandidateStatus) -> CoreResult<()> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        let n = conn
            .execute(
                "UPDATE memory_candidates SET status = ?1 WHERE id = ?2",
                params![status.as_str(), id.to_string()],
            )
            .map_err(sqlite_err)?;
        if n == 0 {
            return Err(CoreError::Message(format!("candidate not found: {id}")));
        }
        Ok(())
    }

    /// Update content/title after human edit (pending only).
    pub fn edit(
        &self,
        id: &Uuid,
        title: Option<&str>,
        content: Option<&str>,
    ) -> CoreResult<MemoryCandidate> {
        let mut c = self
            .get(id)?
            .ok_or_else(|| CoreError::Message(format!("candidate not found: {id}")))?;
        if c.status != CandidateStatus::Pending {
            return Err(CoreError::Policy(
                "only pending candidates can be edited".into(),
            ));
        }
        if let Some(t) = title {
            c.title = t.to_string();
        }
        if let Some(body) = content {
            c.content = body.to_string();
            c.content_hash = content_hash_for(&c.content);
        }
        self.put(&c)?;
        Ok(c)
    }

    /// Discard a pending candidate.
    pub fn discard(&self, id: &Uuid) -> CoreResult<()> {
        self.set_status(id, CandidateStatus::Discarded)
    }

    /// Approve: SoftWrite path inserts via store.put (or supersede if proposed).
    ///
    /// Returns the durable memory record. Marks candidate approved.
    pub fn approve(
        &self,
        id: &Uuid,
        store: &dyn super::MemoryStore,
        now_secs: i64,
    ) -> CoreResult<MemoryRecord> {
        let c = self
            .get(id)?
            .ok_or_else(|| CoreError::Message(format!("candidate not found: {id}")))?;
        if c.status != CandidateStatus::Pending {
            return Err(CoreError::Policy(format!(
                "candidate is not pending: {}",
                c.status.as_str()
            )));
        }
        let mut draft = MemoryDraft::new(c.kind.clone(), c.content.clone());
        draft.title = c.title.clone();
        draft.scope = c.scope;
        draft.confidence = Some(c.confidence);
        draft.source = MemorySource::Agent;
        draft.created_by = "cue_extractor".into();
        draft.origin_session_id = c.origin_session_id.clone();
        draft.origin_tool = Some("approve_memory_candidate".into());
        draft.structured = serde_json::json!({
            "from_candidate": c.id.to_string(),
            "cue": c.cue,
            "salience": c.salience,
        });

        let rec = if let Some(old) = c.propose_supersede_of {
            store.put(MemoryWriteOp::Supersede { old, new: draft }, now_secs)?
        } else {
            store.put(MemoryWriteOp::Insert(draft), now_secs)?
        };
        self.set_status(id, CandidateStatus::Approved)?;
        Ok(rec)
    }

    /// Batch approve pending candidates with confidence >= min and salience >= min_sal.
    ///
    /// For `count > batch_confirm_threshold`, caller must set `type_confirm == "APPROVE"`
    /// (type-to-confirm gate for large batches).
    pub fn batch_approve_above(
        &self,
        store: &dyn super::MemoryStore,
        min_confidence: f32,
        min_salience: f32,
        batch_confirm_threshold: usize,
        type_confirm: Option<&str>,
        now_secs: i64,
    ) -> CoreResult<Vec<MemoryRecord>> {
        let pending = self.list(false, 200)?;
        let eligible: Vec<_> = pending
            .into_iter()
            .filter(|c| c.confidence >= min_confidence && c.salience >= min_salience)
            .collect();
        if eligible.len() > batch_confirm_threshold && type_confirm != Some("APPROVE") {
            return Err(CoreError::Policy(format!(
                "batch approve of {} candidates requires type-to-confirm APPROVE",
                eligible.len()
            )));
        }
        let mut out = Vec::new();
        for c in eligible {
            match self.approve(&c.id, store, now_secs) {
                Ok(r) => out.push(r),
                Err(e) => tracing::warn!(error = %e, id = %c.id, "batch approve skip"),
            }
        }
        Ok(out)
    }
}

fn init_schema(conn: &Connection) -> CoreResult<()> {
    conn.execute_batch(
        r#"
CREATE TABLE IF NOT EXISTS memory_candidates (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'workspace',
  salience REAL NOT NULL,
  confidence REAL NOT NULL,
  content_hash TEXT NOT NULL,
  origin_session_id TEXT,
  cue TEXT NOT NULL,
  source_excerpt TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  propose_supersede_of TEXT
);
CREATE INDEX IF NOT EXISTS idx_candidates_status ON memory_candidates(status, salience DESC);
"#,
    )
    .map_err(sqlite_err)?;
    Ok(())
}

fn row_to_candidate(r: &rusqlite::Row<'_>) -> rusqlite::Result<MemoryCandidate> {
    let id_s: String = r.get(0)?;
    let kind_s: String = r.get(1)?;
    let scope_s: String = r.get(4)?;
    let status_s: String = r.get(12)?;
    let supersede_s: Option<String> = r.get(13)?;
    Ok(MemoryCandidate {
        id: Uuid::parse_str(&id_s).unwrap_or_else(|_| Uuid::nil()),
        kind: Kind::parse(&kind_s),
        title: r.get(2)?,
        content: r.get(3)?,
        scope: Scope::parse(&scope_s).unwrap_or(Scope::Workspace),
        salience: r.get::<_, f64>(5)? as f32,
        confidence: r.get::<_, f64>(6)? as f32,
        content_hash: r.get(7)?,
        origin_session_id: r.get(8)?,
        cue: r.get(9)?,
        source_excerpt: r.get(10)?,
        created_at: r.get(11)?,
        status: CandidateStatus::parse(&status_s).unwrap_or(CandidateStatus::Pending),
        propose_supersede_of: supersede_s.and_then(|s| Uuid::parse_str(&s).ok()),
    })
}

fn lock_err() -> CoreError {
    CoreError::Message("candidate inbox lock poisoned".into())
}

fn sqlite_err(e: rusqlite::Error) -> CoreError {
    CoreError::Message(format!("sqlite: {e}"))
}

/// Run cue extract → optional dedup against store → put into inbox.
///
/// Never writes durable memory.
#[allow(clippy::too_many_arguments)] // inbox/store/embed/opts + turn text surface
pub fn propose_from_turn(
    inbox: &CandidateInbox,
    store: Option<&dyn super::MemoryStore>,
    user_text: &str,
    assistant_text: Option<&str>,
    session_id: Option<&str>,
    now_secs: i64,
    embed: Option<&dyn EmbedBackend>,
    opts: CueExtractOpts,
) -> CoreResult<Vec<MemoryCandidate>> {
    let extractor = CueExtractor::new(opts);
    let mut cands = extractor.extract(user_text, assistant_text, session_id, now_secs);
    if let Some(st) = store {
        // Active records for dedup
        let actives = st
            .list(None, false, false, now_secs, 200)
            .unwrap_or_default();
        for c in &mut cands {
            let proposal = detect_dedup(c, &actives, embed, 0.88)?;
            apply_dedup_proposal(c, proposal);
            inbox.put(c)?;
        }
    } else {
        for c in &cands {
            inbox.put(c)?;
        }
    }
    Ok(cands)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::embed::ConceptEmbedBackend;
    use crate::memory::MemoryStore;
    use std::sync::Arc;

    #[test]
    fn extract_into_inbox_then_approve_puts_memory() {
        use super::super::sqlite_store::SqliteMemoryStore;
        let inbox = CandidateInbox::open_in_memory().unwrap();
        let store = SqliteMemoryStore::open_in_memory().unwrap();
        let backend = Arc::new(ConceptEmbedBackend::new(64));
        store.set_embed_backend_model(Some(backend.clone()), "concept-v1");

        let proposed = propose_from_turn(
            &inbox,
            Some(&store as &dyn MemoryStore),
            "Remember that our staging DB is Postgres on port 5433.",
            None,
            Some("s1"),
            1_000,
            Some(backend.as_ref()),
            CueExtractOpts::default(),
        )
        .unwrap();
        assert!(!proposed.is_empty());
        let pending = inbox.list(false, 10).unwrap();
        assert_eq!(pending.len(), proposed.len());

        let rec = inbox
            .approve(&pending[0].id, &store, 1_001)
            .expect("approve");
        assert_eq!(rec.status, Status::Active);
        assert!(store.get_embedding(&rec.id).unwrap().is_some());

        // Paraphrase recall
        use crate::embed::HybridWeights;
        let hits = super::super::recall::recall_two_pool(
            &store,
            &SqliteMemoryStore::open_in_memory().unwrap(),
            &RecallQuery::new("which relational database for staging"),
            Some(backend.as_ref()),
            HybridWeights {
                keyword: 0.2,
                semantic: 0.7,
                recency: 0.1,
            },
            2_000,
        )
        .unwrap();
        // Concept geometry may or may not link "staging DB Postgres" to "relational database"
        // Ensure at least durable content is recallable by keyword:
        let kw = store
            .recall(
                &RecallQuery::new("Postgres"),
                Some(backend.as_ref()),
                HybridWeights::default(),
                2_000,
            )
            .unwrap();
        assert!(
            kw.iter().any(|h| h.record.id == rec.id),
            "approved memory must be recallable: {kw:?} / {hits:?}"
        );

        let after = inbox.get(&pending[0].id).unwrap().unwrap();
        assert_eq!(after.status, CandidateStatus::Approved);
    }

    #[test]
    fn batch_approve_requires_type_confirm() {
        use super::super::sqlite_store::SqliteMemoryStore;
        let inbox = CandidateInbox::open_in_memory().unwrap();
        let store = SqliteMemoryStore::open_in_memory().unwrap();
        for i in 0..5 {
            let cands = CueExtractor::default().extract(
                &format!("Remember that fact number {i} is important for shipping."),
                None,
                None,
                100 + i,
            );
            for c in cands {
                inbox.put(&c).unwrap();
            }
        }
        let err = inbox
            .batch_approve_above(&store, 0.0, 0.0, 2, None, 200)
            .unwrap_err();
        assert!(format!("{err}").contains("APPROVE"), "{err}");
        let ok = inbox
            .batch_approve_above(&store, 0.0, 0.0, 2, Some("APPROVE"), 200)
            .unwrap();
        assert!(!ok.is_empty());
    }

    #[test]
    fn discard_keeps_out_of_pending() {
        let inbox = CandidateInbox::open_in_memory().unwrap();
        let c = CueExtractor::default()
            .extract("Remember that the API is versioned.", None, None, 1)
            .pop()
            .unwrap();
        inbox.put(&c).unwrap();
        inbox.discard(&c.id).unwrap();
        assert!(inbox.list(false, 10).unwrap().is_empty());
    }
}
