//! Embedded SQLite [`MemoryStore`] (MEMORY.md §3).
//!
//! Single-writer (Mutex), WAL, store-maintained FTS, separate `memory_embeddings`.

use super::migrate::{self, migrate};
use super::types::*;
use super::MemoryStore;
use crate::embed::{recency_boost, HybridWeights};
use crate::error::{CoreError, CoreResult};
use rusqlite::{params, Connection, OptionalExtension};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use uuid::Uuid;

/// SQLite-backed memory store (default embedded backend).
pub struct SqliteMemoryStore {
    path: Option<PathBuf>,
    conn: Mutex<Connection>,
}

impl SqliteMemoryStore {
    /// Open (or create) a memory database at `path` and run migrations.
    pub fn open(path: impl AsRef<Path>) -> CoreResult<Self> {
        let path = path.as_ref();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path)
            .map_err(|e| CoreError::Message(format!("memory open {}: {e}", path.display())))?;
        migrate(&conn)?;
        Ok(Self {
            path: Some(path.to_path_buf()),
            conn: Mutex::new(conn),
        })
    }

    /// In-memory store for hermetic tests.
    pub fn open_in_memory() -> CoreResult<Self> {
        let conn = Connection::open_in_memory()
            .map_err(|e| CoreError::Message(format!("memory open_in_memory: {e}")))?;
        migrate(&conn)?;
        Ok(Self {
            path: None,
            conn: Mutex::new(conn),
        })
    }

    /// Filesystem path when file-backed.
    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    /// Schema version applied.
    pub fn schema_version(&self) -> CoreResult<i64> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        let v: i64 = conn
            .query_row(
                "SELECT COALESCE(MAX(version), 0) FROM memory_schema_migrations",
                [],
                |r| r.get(0),
            )
            .map_err(sqlite_err)?;
        Ok(v)
    }

    /// Upsert an embedding vector for a memory (separate table — not index cache).
    pub fn put_embedding(&self, memory_id: &Uuid, model: &str, vector: &[f32]) -> CoreResult<()> {
        let blob = f32_slice_to_bytes(vector);
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        conn.execute(
            "INSERT INTO memory_embeddings (memory_id, model, vector) VALUES (?1, ?2, ?3)
             ON CONFLICT(memory_id) DO UPDATE SET model = excluded.model, vector = excluded.vector",
            params![memory_id.to_string(), model, blob],
        )
        .map_err(sqlite_err)?;
        Ok(())
    }

    /// Load embedding if present; returns `(model, vector)`.
    pub fn get_embedding(&self, memory_id: &Uuid) -> CoreResult<Option<(String, Vec<f32>)>> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        let row = conn
            .query_row(
                "SELECT model, vector FROM memory_embeddings WHERE memory_id = ?1",
                params![memory_id.to_string()],
                |r| {
                    let model: String = r.get(0)?;
                    let blob: Vec<u8> = r.get(1)?;
                    Ok((model, blob))
                },
            )
            .optional()
            .map_err(sqlite_err)?;
        Ok(row.map(|(m, b)| (m, bytes_to_f32_vec(&b))))
    }

    fn insert_row(
        conn: &Connection,
        draft: &MemoryDraft,
        id: Uuid,
        now: i64,
        supersedes: Option<Uuid>,
        rev: i64,
    ) -> CoreResult<MemoryRecord> {
        // Redact secrets before persist (and content_hash is over redacted text)
        let redaction = crate::redact::redact_candidate(&draft.content);
        if redaction.blocked {
            return Err(CoreError::Policy(
                redaction
                    .block_reason
                    .unwrap_or_else(|| "credential-dominant memory blocked".into()),
            ));
        }
        let content = if redaction.redacted {
            redaction.text
        } else {
            draft.content.clone()
        };
        let title = if draft.title.trim().is_empty() {
            title_from_content(&content, "untitled")
        } else {
            draft.title.clone()
        };
        let content_hash = content_hash_for(&content);
        // url / due_at from structured (Rust-written, not GENERATED columns)
        let url = draft.url.clone().or_else(|| {
            draft
                .structured
                .get("url")
                .and_then(|v| v.as_str())
                .map(str::to_string)
        });
        let due_at = draft
            .due_at
            .or_else(|| draft.structured.get("due_at").and_then(|v| v.as_i64()));
        let structured = if draft.structured.is_null() {
            "{}".to_string()
        } else {
            draft.structured.to_string()
        };
        let valid_from = draft.valid_from;
        let valid_to = draft.valid_to;

        conn.execute(
            r#"INSERT INTO memory (
                id, kind, title, content, structured,
                status, valid_from, valid_to, supersedes, superseded_by,
                scope, workspace_id, confidence, pinned, source, created_by,
                origin_session_id, origin_tool, created_at, updated_at, rev,
                origin_node, content_hash, url, due_at
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5,
                'active', ?6, ?7, ?8, NULL,
                ?9, ?10, ?11, ?12, ?13, ?14,
                ?15, ?16, ?17, ?17, ?18,
                NULL, ?19, ?20, ?21
            )"#,
            params![
                id.to_string(),
                draft.kind.as_str(),
                title,
                content,
                structured,
                valid_from,
                valid_to,
                supersedes.map(|u| u.to_string()),
                draft.scope.as_str(),
                draft.workspace_id,
                draft.confidence,
                draft.pinned as i64,
                draft.source.as_str(),
                draft.created_by,
                draft.origin_session_id,
                draft.origin_tool,
                now,
                rev,
                content_hash,
                url,
                due_at,
            ],
        )
        .map_err(sqlite_err)?;

        replace_tags(conn, &id, &draft.tags)?;
        fts_upsert(conn, &id, &content, &title)?;

        load_record(conn, &id)?.ok_or_else(|| CoreError::Message("insert vanished".into()))
    }
}

impl MemoryStore for SqliteMemoryStore {
    fn put(&self, op: MemoryWriteOp, now_secs: i64) -> CoreResult<MemoryRecord> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        conn.execute("BEGIN IMMEDIATE", []).map_err(sqlite_err)?;
        let result = (|| -> CoreResult<MemoryRecord> {
            match op {
                MemoryWriteOp::Insert(draft) => {
                    let id = new_memory_id();
                    Self::insert_row(&conn, &draft, id, now_secs, None, 1)
                }
                MemoryWriteOp::UpdateMeta {
                    id,
                    tags,
                    pinned,
                    valid_to,
                    status,
                } => {
                    let _existing = load_record(&conn, &id)?
                        .ok_or_else(|| CoreError::Message(format!("memory not found: {id}")))?;
                    let mut touched = false;
                    if let Some(p) = pinned {
                        conn.execute(
                            "UPDATE memory SET pinned = ?1, updated_at = ?2, rev = rev + 1 WHERE id = ?3",
                            params![p as i64, now_secs, id.to_string()],
                        )
                        .map_err(sqlite_err)?;
                        touched = true;
                    }
                    if let Some(vt) = valid_to {
                        conn.execute(
                            "UPDATE memory SET valid_to = ?1, updated_at = ?2, rev = rev + 1 WHERE id = ?3",
                            params![vt, now_secs, id.to_string()],
                        )
                        .map_err(sqlite_err)?;
                        touched = true;
                    }
                    if let Some(st) = status {
                        conn.execute(
                            "UPDATE memory SET status = ?1, updated_at = ?2, rev = rev + 1 WHERE id = ?3",
                            params![st.as_str(), now_secs, id.to_string()],
                        )
                        .map_err(sqlite_err)?;
                        touched = true;
                    }
                    if let Some(ref t) = tags {
                        replace_tags(&conn, &id, t)?;
                        conn.execute(
                            "UPDATE memory SET updated_at = ?1, rev = rev + 1 WHERE id = ?2",
                            params![now_secs, id.to_string()],
                        )
                        .map_err(sqlite_err)?;
                        touched = true;
                    }
                    if !touched {
                        conn.execute(
                            "UPDATE memory SET updated_at = ?1, rev = rev + 1 WHERE id = ?2",
                            params![now_secs, id.to_string()],
                        )
                        .map_err(sqlite_err)?;
                    }
                    load_record(&conn, &id)?
                        .ok_or_else(|| CoreError::Message("update vanished".into()))
                }
                MemoryWriteOp::Supersede { old, new } => {
                    let old_rec = load_record(&conn, &old)?.ok_or_else(|| {
                        CoreError::Message(format!("supersede target missing: {old}"))
                    })?;
                    // Close old: status superseded, valid_to = now, link superseded_by after insert
                    let new_id = new_memory_id();
                    let inserted = Self::insert_row(&conn, &new, new_id, now_secs, Some(old), 1)?;
                    conn.execute(
                        "UPDATE memory SET status = 'superseded', valid_to = ?1, superseded_by = ?2,
                         updated_at = ?1, rev = rev + 1 WHERE id = ?3",
                        params![now_secs, new_id.to_string(), old.to_string()],
                    )
                    .map_err(sqlite_err)?;
                    // Remove superseded from FTS so keyword recall collapses to newest
                    fts_delete(&conn, &old)?;
                    let _ = old_rec;
                    Ok(inserted)
                }
                MemoryWriteOp::Retract { id } => {
                    let n = conn
                        .execute(
                            "UPDATE memory SET status = 'retracted', updated_at = ?1, rev = rev + 1 WHERE id = ?2",
                            params![now_secs, id.to_string()],
                        )
                        .map_err(sqlite_err)?;
                    if n == 0 {
                        return Err(CoreError::Message(format!("retract target missing: {id}")));
                    }
                    fts_delete(&conn, &id)?;
                    load_record(&conn, &id)?
                        .ok_or_else(|| CoreError::Message("retract vanished".into()))
                }
            }
        })();
        match result {
            Ok(r) => {
                conn.execute("COMMIT", []).map_err(sqlite_err)?;
                Ok(r)
            }
            Err(e) => {
                let _ = conn.execute("ROLLBACK", []);
                Err(e)
            }
        }
    }

    fn get(&self, id: &Uuid) -> CoreResult<Option<MemoryRecord>> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        load_record(&conn, id)
    }

    fn recall(
        &self,
        q: &RecallQuery,
        _embed: Option<&dyn crate::embed::EmbedBackend>,
        w: HybridWeights,
        now_secs: i64,
    ) -> CoreResult<Vec<RecallHit>> {
        // Keyword + recency path (semantic ranking lands in RecallEngine #268).
        // When embed is provided, still degrade gracefully to keyword-only here;
        // the dedicated engine will call put_embedding + cosine.
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        let mut candidates: Vec<(MemoryRecord, f32)> = Vec::new();

        let fts_q = fts_match_query(&q.query);
        if !fts_q.is_empty() {
            let mut stmt = conn
                .prepare(
                    r#"SELECT memory_id, bm25(memory_fts) AS rank
                       FROM memory_fts
                       WHERE memory_fts MATCH ?1
                       ORDER BY rank
                       LIMIT 50"#,
                )
                .map_err(sqlite_err)?;
            let rows = stmt
                .query_map(params![fts_q], |r| {
                    let id: String = r.get(0)?;
                    let rank: f64 = r.get(1)?;
                    Ok((id, rank))
                })
                .map_err(sqlite_err)?;
            for row in rows {
                let (id_s, rank) = row.map_err(sqlite_err)?;
                let id = Uuid::parse_str(&id_s)
                    .map_err(|e| CoreError::Message(format!("bad memory_id in fts: {e}")))?;
                if let Some(rec) = load_record(&conn, &id)? {
                    // bm25: lower is better in sqlite fts5; convert to positive score
                    let kw = (-rank as f32).max(0.01);
                    candidates.push((rec, kw));
                }
            }
        }

        // Fallback / supplement: if no FTS hits, scan active rows with LIKE
        if candidates.is_empty() && !q.query.trim().is_empty() {
            let like = format!("%{}%", q.query.trim());
            let mut stmt = conn
                .prepare(
                    "SELECT id FROM memory WHERE status = 'active' AND (content LIKE ?1 OR title LIKE ?1) LIMIT 50",
                )
                .map_err(sqlite_err)?;
            let ids: Vec<String> = stmt
                .query_map(params![like], |r| r.get(0))
                .map_err(sqlite_err)?
                .filter_map(|r| r.ok())
                .collect();
            for id_s in ids {
                if let Ok(id) = Uuid::parse_str(&id_s) {
                    if let Some(rec) = load_record(&conn, &id)? {
                        candidates.push((rec, 1.0));
                    }
                }
            }
        }

        // Default: active + valid-now only. Superseded/retracted stay out of FTS
        // after write, so they never rank unless `include_superseded` expands chains.
        candidates.retain(|(rec, _)| {
            rec.status == Status::Active && is_valid_now(rec.valid_from, rec.valid_to, now_secs)
        });

        if let Some(ref kinds) = q.kinds {
            candidates.retain(|(rec, _)| kinds.iter().any(|k| k == &rec.kind));
        }
        if let Some(scope) = q.scope {
            candidates.retain(|(rec, _)| rec.scope == scope);
        }

        // Expand supersession chains (newest-first) when requested.
        if q.include_superseded {
            let mut expanded: Vec<(MemoryRecord, f32)> = Vec::new();
            let mut seen = std::collections::HashSet::new();
            for (rec, kw) in candidates {
                let mut cursor = Some(rec);
                while let Some(r) = cursor {
                    if !seen.insert(r.id) {
                        break;
                    }
                    let next = r.supersedes;
                    expanded.push((r, kw));
                    cursor = match next {
                        Some(id) => load_record(&conn, &id)?,
                        None => None,
                    };
                }
            }
            candidates = expanded;
        }

        let kw_max = candidates
            .iter()
            .map(|(_, k)| *k)
            .fold(0.0f32, f32::max)
            .max(f32::EPSILON);

        let mut hits: Vec<RecallHit> = candidates
            .into_iter()
            .map(|(rec, kw)| {
                let recency = recency_boost(rec.updated_at, now_secs);
                let pinned_boost = if rec.pinned { 0.15 } else { 0.0 };
                let conf = rec.confidence.unwrap_or(0.0) * 0.05;
                let score =
                    crate::embed::hybrid_score(kw, kw_max, 0.0, recency, w) + pinned_boost + conf;
                let snippet = snippet_of(&rec.content, 160);
                let source_id = RecallHit::memory_source_id(&rec.id);
                RecallHit {
                    record: rec,
                    score,
                    keyword_score: kw,
                    semantic_score: 0.0,
                    recency_score: recency,
                    source_id,
                    snippet,
                }
            })
            .collect();

        hits.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        if let Some(min) = q.min_score {
            hits.retain(|h| h.score >= min);
        }
        hits.truncate(q.k.max(1));
        Ok(hits)
    }

    fn changes_since(&self, cursor: i64) -> CoreResult<Vec<MemoryRecord>> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        let mut stmt = conn
            .prepare(
                "SELECT id FROM memory WHERE updated_at > ?1 ORDER BY updated_at ASC LIMIT 1000",
            )
            .map_err(sqlite_err)?;
        let ids: Vec<String> = stmt
            .query_map(params![cursor], |r| r.get(0))
            .map_err(sqlite_err)?
            .filter_map(|r| r.ok())
            .collect();
        let mut out = Vec::with_capacity(ids.len());
        for id_s in ids {
            if let Ok(id) = Uuid::parse_str(&id_s) {
                if let Some(r) = load_record(&conn, &id)? {
                    out.push(r);
                }
            }
        }
        Ok(out)
    }
}

fn load_record(conn: &Connection, id: &Uuid) -> CoreResult<Option<MemoryRecord>> {
    let row = conn
        .query_row(
            r#"SELECT id, kind, title, content, structured, status, valid_from, valid_to,
                      supersedes, superseded_by, scope, workspace_id, confidence, pinned,
                      source, created_by, origin_session_id, origin_tool, created_at, updated_at,
                      rev, origin_node, content_hash, url, due_at
               FROM memory WHERE id = ?1"#,
            params![id.to_string()],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, String>(5)?,
                    r.get::<_, Option<i64>>(6)?,
                    r.get::<_, Option<i64>>(7)?,
                    r.get::<_, Option<String>>(8)?,
                    r.get::<_, Option<String>>(9)?,
                    r.get::<_, String>(10)?,
                    r.get::<_, Option<String>>(11)?,
                    r.get::<_, Option<f64>>(12)?,
                    r.get::<_, i64>(13)?,
                    r.get::<_, String>(14)?,
                    r.get::<_, String>(15)?,
                    r.get::<_, Option<String>>(16)?,
                    r.get::<_, Option<String>>(17)?,
                    r.get::<_, i64>(18)?,
                    r.get::<_, i64>(19)?,
                    r.get::<_, i64>(20)?,
                    r.get::<_, Option<String>>(21)?,
                    r.get::<_, String>(22)?,
                    r.get::<_, Option<String>>(23)?,
                    r.get::<_, Option<i64>>(24)?,
                ))
            },
        )
        .optional()
        .map_err(sqlite_err)?;

    let Some(t) = row else {
        return Ok(None);
    };

    let id = Uuid::parse_str(&t.0).map_err(|e| CoreError::Message(e.to_string()))?;
    let supersedes =
        t.8.as_ref()
            .map(|s| Uuid::parse_str(s))
            .transpose()
            .map_err(|e| CoreError::Message(e.to_string()))?;
    let superseded_by =
        t.9.as_ref()
            .map(|s| Uuid::parse_str(s))
            .transpose()
            .map_err(|e| CoreError::Message(e.to_string()))?;
    let structured: serde_json::Value =
        serde_json::from_str(&t.4).unwrap_or_else(|_| serde_json::json!({}));
    let tags = load_tags(conn, &id)?;

    Ok(Some(MemoryRecord {
        id,
        kind: Kind::parse(&t.1),
        title: t.2,
        content: t.3,
        structured,
        status: Status::parse(&t.5).unwrap_or(Status::Active),
        valid_from: t.6,
        valid_to: t.7,
        supersedes,
        superseded_by,
        scope: Scope::parse(&t.10).unwrap_or(Scope::Workspace),
        workspace_id: t.11,
        confidence: t.12.map(|f| f as f32),
        pinned: t.13 != 0,
        source: MemorySource::parse(&t.14),
        created_by: t.15,
        origin_session_id: t.16,
        origin_tool: t.17,
        created_at: t.18,
        updated_at: t.19,
        rev: t.20,
        origin_node: t.21,
        content_hash: t.22,
        url: t.23,
        due_at: t.24,
        tags,
    }))
}

fn load_tags(conn: &Connection, id: &Uuid) -> CoreResult<Vec<String>> {
    let mut stmt = conn
        .prepare("SELECT tag FROM memory_tags WHERE memory_id = ?1 ORDER BY tag")
        .map_err(sqlite_err)?;
    let tags = stmt
        .query_map(params![id.to_string()], |r| r.get::<_, String>(0))
        .map_err(sqlite_err)?
        .filter_map(|r| r.ok())
        .collect();
    Ok(tags)
}

fn replace_tags(conn: &Connection, id: &Uuid, tags: &[String]) -> CoreResult<()> {
    conn.execute(
        "DELETE FROM memory_tags WHERE memory_id = ?1",
        params![id.to_string()],
    )
    .map_err(sqlite_err)?;
    for tag in tags {
        let t = tag.trim();
        if t.is_empty() {
            continue;
        }
        conn.execute(
            "INSERT OR IGNORE INTO memory_tags (memory_id, tag) VALUES (?1, ?2)",
            params![id.to_string(), t],
        )
        .map_err(sqlite_err)?;
    }
    Ok(())
}

fn fts_upsert(conn: &Connection, id: &Uuid, content: &str, title: &str) -> CoreResult<()> {
    fts_delete(conn, id)?;
    conn.execute(
        "INSERT INTO memory_fts (content, title, memory_id) VALUES (?1, ?2, ?3)",
        params![content, title, id.to_string()],
    )
    .map_err(sqlite_err)?;
    Ok(())
}

fn fts_delete(conn: &Connection, id: &Uuid) -> CoreResult<()> {
    conn.execute(
        "DELETE FROM memory_fts WHERE memory_id = ?1",
        params![id.to_string()],
    )
    .map_err(sqlite_err)?;
    Ok(())
}

/// Build a simple FTS5 MATCH query from free text (OR of tokens).
fn fts_match_query(q: &str) -> String {
    let tokens: Vec<String> = q
        .split(|c: char| !c.is_alphanumeric() && c != '_' && c != '-')
        .filter(|t| t.len() >= 2)
        .map(|t| {
            // Escape double quotes for FTS
            let escaped = t.replace('"', "");
            format!("\"{escaped}\"")
        })
        .collect();
    tokens.join(" OR ")
}

fn snippet_of(content: &str, max: usize) -> String {
    let t = content.trim();
    if t.len() <= max {
        return t.to_string();
    }
    crate::text::truncate_bytes(t, max).to_string()
}

fn f32_slice_to_bytes(v: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(v.len() * 4);
    for f in v {
        out.extend_from_slice(&f.to_le_bytes());
    }
    out
}

fn bytes_to_f32_vec(b: &[u8]) -> Vec<f32> {
    b.chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

fn sqlite_err(e: rusqlite::Error) -> CoreError {
    CoreError::Message(format!("memory sqlite: {e}"))
}

fn lock_err() -> CoreError {
    CoreError::Message("memory store lock poisoned".into())
}

// Silence unused import warning if migrate version const unused in non-test
#[allow(dead_code)]
fn _schema_version_export() -> i64 {
    migrate::MEMORY_SCHEMA_VERSION
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::MemoryStore;

    fn draft(content: &str) -> MemoryDraft {
        MemoryDraft::new(Kind::Fact, content)
    }

    #[test]
    fn insert_get_round_trip() {
        let store = SqliteMemoryStore::open_in_memory().unwrap();
        let now = 1_700_000_000_i64;
        let rec = store
            .put(
                MemoryWriteOp::Insert(draft("remember the launch date")),
                now,
            )
            .unwrap();
        assert_eq!(rec.status, Status::Active);
        assert_eq!(rec.rev, 1);
        assert_eq!(rec.created_at, now);
        assert!(!rec.content_hash.is_empty());
        assert_eq!(
            rec.content_hash,
            crate::embed::chunk_content_key("remember the launch date")
        );
        let got = store.get(&rec.id).unwrap().unwrap();
        assert_eq!(got.content, "remember the launch date");
        assert_eq!(got.kind, Kind::Fact);
    }

    #[test]
    fn supersede_chain_never_deletes() {
        let store = SqliteMemoryStore::open_in_memory().unwrap();
        let t0 = 1_000_i64;
        let old = store
            .put(MemoryWriteOp::Insert(draft("decision: use SQLite")), t0)
            .unwrap();
        let t1 = 2_000_i64;
        let mut new_draft = draft("decision: use SQLite with WAL");
        new_draft.kind = Kind::Decision;
        let neu = store
            .put(
                MemoryWriteOp::Supersede {
                    old: old.id,
                    new: new_draft,
                },
                t1,
            )
            .unwrap();
        assert_eq!(neu.supersedes, Some(old.id));
        let old_after = store.get(&old.id).unwrap().unwrap();
        assert_eq!(old_after.status, Status::Superseded);
        assert_eq!(old_after.superseded_by, Some(neu.id));
        assert_eq!(old_after.valid_to, Some(t1));
        // old row still exists (no DELETE)
        assert!(store.get(&old.id).unwrap().is_some());
        // default recall hides superseded
        let hits = store
            .recall(
                &RecallQuery::new("SQLite"),
                None,
                HybridWeights::default(),
                t1,
            )
            .unwrap();
        assert!(hits.iter().all(|h| h.record.id == neu.id));
        assert!(hits.iter().all(|h| h.record.status == Status::Active));
        // include_superseded surfaces chain
        let mut q = RecallQuery::new("SQLite");
        q.include_superseded = true;
        let chain = store
            .recall(&q, None, HybridWeights::default(), t1)
            .unwrap();
        assert!(chain.iter().any(|h| h.record.id == neu.id));
        assert!(chain.iter().any(|h| h.record.id == old.id));
    }

    #[test]
    fn retract_is_soft_tombstone() {
        let store = SqliteMemoryStore::open_in_memory().unwrap();
        let now = 5_000_i64;
        let rec = store
            .put(MemoryWriteOp::Insert(draft("forgettable secret plan")), now)
            .unwrap();
        let retracted = store
            .put(MemoryWriteOp::Retract { id: rec.id }, now + 1)
            .unwrap();
        assert_eq!(retracted.status, Status::Retracted);
        assert!(store.get(&rec.id).unwrap().is_some());
        let hits = store
            .recall(
                &RecallQuery::new("forgettable"),
                None,
                HybridWeights::default(),
                now + 2,
            )
            .unwrap();
        assert!(
            hits.is_empty(),
            "retracted must not surface in active recall"
        );
    }

    #[test]
    fn valid_now_filtering() {
        let store = SqliteMemoryStore::open_in_memory().unwrap();
        let mut d = draft("temporary fact");
        d.valid_from = Some(100);
        d.valid_to = Some(200);
        let rec = store.put(MemoryWriteOp::Insert(d), 150).unwrap();
        let hits_now = store
            .recall(
                &RecallQuery::new("temporary"),
                None,
                HybridWeights::default(),
                150,
            )
            .unwrap();
        assert_eq!(hits_now.len(), 1);
        let hits_later = store
            .recall(
                &RecallQuery::new("temporary"),
                None,
                HybridWeights::default(),
                200,
            )
            .unwrap();
        assert!(hits_later.is_empty());
        let _ = rec;
    }

    #[test]
    fn fts_sync_after_write() {
        let store = SqliteMemoryStore::open_in_memory().unwrap();
        let now = 10_i64;
        store
            .put(
                MemoryWriteOp::Insert(draft("alpha keyword uniquezebra")),
                now,
            )
            .unwrap();
        store
            .put(MemoryWriteOp::Insert(draft("beta other note")), now)
            .unwrap();
        let hits = store
            .recall(
                &RecallQuery::new("uniquezebra"),
                None,
                HybridWeights::default(),
                now,
            )
            .unwrap();
        assert_eq!(hits.len(), 1);
        assert!(hits[0].record.content.contains("uniquezebra"));
    }

    #[test]
    fn migration_idempotent_on_file_store() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("memory.sqlite");
        {
            let s = SqliteMemoryStore::open(&path).unwrap();
            assert_eq!(s.schema_version().unwrap(), 1);
            s.put(MemoryWriteOp::Insert(draft("persist me")), 1)
                .unwrap();
        }
        {
            let s = SqliteMemoryStore::open(&path).unwrap();
            assert_eq!(s.schema_version().unwrap(), 1);
            // re-open re-migrates as no-op; data intact
            let all = s.changes_since(0).unwrap();
            assert_eq!(all.len(), 1);
            assert_eq!(all[0].content, "persist me");
        }
    }

    #[test]
    fn embeddings_table_is_separate_and_round_trips() {
        let store = SqliteMemoryStore::open_in_memory().unwrap();
        let rec = store
            .put(MemoryWriteOp::Insert(draft("embed me")), 1)
            .unwrap();
        let vec = vec![0.1f32, 0.2, 0.3, 0.4];
        store.put_embedding(&rec.id, "mock-hash-32", &vec).unwrap();
        let (model, got) = store.get_embedding(&rec.id).unwrap().unwrap();
        assert_eq!(model, "mock-hash-32");
        assert_eq!(got.len(), 4);
        assert!((got[0] - 0.1).abs() < 1e-6);
        // Prove table name is memory_embeddings not embeddings
        let conn = store.conn.lock().unwrap();
        let name_ok: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name='memory_embeddings'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(name_ok, 1);
        let bad: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name='embeddings'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(bad, 0);
    }

    #[test]
    fn url_and_due_at_from_structured() {
        let store = SqliteMemoryStore::open_in_memory().unwrap();
        let mut d = MemoryDraft::new(Kind::Bookmark, "useful link");
        d.structured = serde_json::json!({"url": "https://example.com/x", "due_at": 99});
        let rec = store.put(MemoryWriteOp::Insert(d), 1).unwrap();
        assert_eq!(rec.url.as_deref(), Some("https://example.com/x"));
        assert_eq!(rec.due_at, Some(99));
    }

    #[test]
    fn credential_dominant_blocked_on_insert() {
        let store = SqliteMemoryStore::open_in_memory().unwrap();
        let err = store
            .put(
                MemoryWriteOp::Insert(draft("sk-proj-abcdefghijklmnopqrstuvwxyz012345")),
                1,
            )
            .unwrap_err();
        let msg = format!("{err}");
        assert!(
            msg.contains("credential") || msg.contains("policy") || msg.contains("refuse"),
            "{msg}"
        );
    }

    #[test]
    fn prose_token_redacted_before_persist() {
        let store = SqliteMemoryStore::open_in_memory().unwrap();
        let rec = store
            .put(
                MemoryWriteOp::Insert(draft(
                    "remember the bot uses sk-abcdefghijklmnop for staging only",
                )),
                1,
            )
            .unwrap();
        assert!(!rec.content.contains("abcdefghijklmnop"));
        assert!(rec.content.contains("sk-***"));
    }

    #[test]
    fn changes_since_cursor() {
        let store = SqliteMemoryStore::open_in_memory().unwrap();
        store.put(MemoryWriteOp::Insert(draft("a")), 100).unwrap();
        store.put(MemoryWriteOp::Insert(draft("b")), 200).unwrap();
        let since = store.changes_since(150).unwrap();
        assert_eq!(since.len(), 1);
        assert_eq!(since[0].content, "b");
    }
}
