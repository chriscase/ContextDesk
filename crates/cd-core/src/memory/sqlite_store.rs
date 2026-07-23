//! Embedded SQLite [`MemoryStore`] (MEMORY.md §3).
//!
//! Single-writer (Mutex), WAL, store-maintained FTS, separate `memory_embeddings`.

use super::migrate::{self, migrate};
use super::types::*;
use super::MemoryStore;
use crate::embed::{recency_boost, EmbedBackend, HybridWeights};
use crate::error::{CoreError, CoreResult};
use rusqlite::{params, Connection, OptionalExtension};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use uuid::Uuid;

/// Timeout for write-time / query embeds (realistic budget; not 50ms throwaway). #346
pub const MEMORY_EMBED_TIMEOUT_MS: u64 = 5_000;

/// SQLite-backed memory store (default embedded backend).
pub struct SqliteMemoryStore {
    path: Option<PathBuf>,
    conn: Mutex<Connection>,
    /// Optional embed backend for embed-on-write (#346).
    embed: Mutex<Option<(Arc<dyn EmbedBackend>, String)>>,
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
            embed: Mutex::new(None),
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
            embed: Mutex::new(None),
        })
    }

    /// Attach embed backend for embed-on-write (model id e.g. provider profile / nomic-embed-text).
    pub fn set_embed_backend_model(
        &self,
        backend: Option<Arc<dyn EmbedBackend>>,
        model: impl Into<String>,
    ) {
        let mut g = self.embed.lock().unwrap_or_else(|e| e.into_inner());
        *g = backend.map(|b| (b, model.into()));
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

    /// All stored embeddings as `(memory_id, model, vector)` for semantic candidate gather (#346).
    pub fn list_embeddings(&self) -> CoreResult<Vec<(Uuid, String, Vec<f32>)>> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        let mut stmt = conn
            .prepare("SELECT memory_id, model, vector FROM memory_embeddings")
            .map_err(sqlite_err)?;
        let rows = stmt
            .query_map([], |r| {
                let id: String = r.get(0)?;
                let model: String = r.get(1)?;
                let blob: Vec<u8> = r.get(2)?;
                Ok((id, model, blob))
            })
            .map_err(sqlite_err)?;
        let mut out = Vec::new();
        for row in rows {
            let (id_s, model, blob) = row.map_err(sqlite_err)?;
            let id = Uuid::parse_str(&id_s)
                .map_err(|e| CoreError::Message(format!("bad memory_id in embeddings: {e}")))?;
            out.push((id, model, bytes_to_f32_vec(&blob)));
        }
        Ok(out)
    }

    /// Embed active records that lack a vector (legacy/import/migrated) — offline-safe lazy path.
    ///
    /// Not called on the recall hot path; host may invoke after import or on idle.
    pub fn backfill_missing_embeddings(&self, limit: usize) -> CoreResult<usize> {
        let guard = self.embed.lock().unwrap_or_else(|e| e.into_inner());
        let Some((backend, model)) = guard.as_ref() else {
            return Ok(0);
        };
        let backend = Arc::clone(backend);
        let model = model.clone();
        drop(guard);

        let rows: Vec<(String, String)> = {
            let conn = self.conn.lock().map_err(|_| lock_err())?;
            let mut stmt = conn
                .prepare(
                    r#"SELECT m.id, m.content FROM memory m
                       LEFT JOIN memory_embeddings e ON e.memory_id = m.id
                       WHERE m.status = 'active' AND e.memory_id IS NULL
                       LIMIT ?1"#,
                )
                .map_err(sqlite_err)?;
            let mapped = stmt
                .query_map(params![limit.clamp(1, 500) as i64], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                })
                .map_err(sqlite_err)?;
            let collected: Vec<(String, String)> = mapped.filter_map(|r| r.ok()).collect();
            collected
        };

        let mut n = 0usize;
        for (id_s, content) in rows {
            let Ok(id) = Uuid::parse_str(&id_s) else {
                continue;
            };
            let redacted = match crate::memory::recall::redact_for_embed(&content) {
                Ok(t) => t,
                Err(_) => continue,
            };
            if let Some(vec) = embed_blocking(backend.as_ref(), &redacted, MEMORY_EMBED_TIMEOUT_MS)
            {
                self.put_embedding(&id, &model, &vec)?;
                n += 1;
            }
        }
        Ok(n)
    }

    /// List records for UI (newest first). Filters status by flags.
    pub fn list_records(
        &self,
        kinds: Option<&[Kind]>,
        include_superseded: bool,
        include_retracted: bool,
        now_secs: i64,
        limit: usize,
    ) -> CoreResult<Vec<MemoryRecord>> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        let mut stmt = conn
            .prepare("SELECT id FROM memory ORDER BY updated_at DESC LIMIT ?1")
            .map_err(sqlite_err)?;
        let cap = limit.clamp(1, 500) as i64;
        let ids: Vec<String> = stmt
            .query_map(params![cap * 3], |r| r.get(0))
            .map_err(sqlite_err)?
            .filter_map(|r| r.ok())
            .collect();
        let mut out = Vec::new();
        for id_s in ids {
            let Ok(id) = Uuid::parse_str(&id_s) else {
                continue;
            };
            let Some(rec) = load_record(&conn, &id)? else {
                continue;
            };
            match rec.status {
                Status::Active => {
                    if !is_valid_now(rec.valid_from, rec.valid_to, now_secs) && !include_superseded
                    {
                        continue;
                    }
                }
                Status::Superseded if include_superseded => {}
                Status::Retracted if include_retracted => {}
                Status::Expired if include_superseded => {}
                _ => continue,
            }
            if let Some(ks) = kinds {
                if !ks.iter().any(|k| k == &rec.kind) {
                    continue;
                }
            }
            out.push(rec);
            if out.len() >= limit {
                break;
            }
        }
        Ok(out)
    }

    /// GDPR purge: hard-delete content, keep tombstone (≠ retract).
    ///
    /// Requires type-to-confirm at the UI/host; this method only performs the
    /// store mutation. Removes FTS + embeddings for the id.
    pub fn purge_gdpr(&self, id: &Uuid, now_secs: i64, reason: &str) -> CoreResult<PurgeTombstone> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        let rec = load_record(&conn, id)?
            .ok_or_else(|| CoreError::Message(format!("purge target missing: {id}")))?;
        let title_redacted = if rec.title.is_empty() {
            "[purged]".into()
        } else {
            format!(
                "[purged] {}",
                rec.title.chars().take(40).collect::<String>()
            )
        };
        conn.execute("BEGIN IMMEDIATE", []).map_err(sqlite_err)?;
        let tomb = PurgeTombstone {
            id: *id,
            purged_at: now_secs,
            kind: rec.kind.as_str().to_string(),
            scope: rec.scope.as_str().to_string(),
            content_hash: rec.content_hash.clone(),
            title_redacted: title_redacted.clone(),
            reason: reason.to_string(),
        };
        conn.execute(
            "INSERT INTO memory_purge_tombstones (id, purged_at, kind, scope, content_hash, title_redacted, reason)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(id) DO UPDATE SET purged_at=excluded.purged_at, reason=excluded.reason",
            params![
                id.to_string(),
                now_secs,
                tomb.kind,
                tomb.scope,
                tomb.content_hash,
                tomb.title_redacted,
                tomb.reason,
            ],
        )
        .map_err(sqlite_err)?;
        // Hard delete content row + tags + embeddings + FTS
        let _ = conn.execute(
            "DELETE FROM memory_tags WHERE memory_id = ?1",
            params![id.to_string()],
        );
        let _ = conn.execute(
            "DELETE FROM memory_embeddings WHERE memory_id = ?1",
            params![id.to_string()],
        );
        fts_delete(&conn, id)?;
        conn.execute("DELETE FROM memory WHERE id = ?1", params![id.to_string()])
            .map_err(sqlite_err)?;
        conn.execute("COMMIT", []).map_err(sqlite_err)?;
        Ok(tomb)
    }

    /// Fetch purge tombstone if present.
    pub fn get_purge_tombstone(&self, id: &Uuid) -> CoreResult<Option<PurgeTombstone>> {
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        let row = conn
            .query_row(
                "SELECT id, purged_at, kind, scope, content_hash, title_redacted, reason
                 FROM memory_purge_tombstones WHERE id = ?1",
                params![id.to_string()],
                |r| {
                    Ok(PurgeTombstone {
                        id: Uuid::parse_str(&r.get::<_, String>(0)?).unwrap_or(*id),
                        purged_at: r.get(1)?,
                        kind: r.get(2)?,
                        scope: r.get(3)?,
                        content_hash: r.get(4)?,
                        title_redacted: r.get(5)?,
                        reason: r.get(6)?,
                    })
                },
            )
            .optional()
            .map_err(sqlite_err)?;
        Ok(row)
    }

    /// Insert with a predetermined id (idempotent import). No-op if id exists.
    ///
    /// After commit, embeds via the same write-time path as [`MemoryStore::put`]
    /// so migration (#273) and memory_fs import are paraphrase-recallable (#346).
    pub fn put_imported(
        &self,
        id: Uuid,
        draft: MemoryDraft,
        now_secs: i64,
    ) -> CoreResult<MemoryRecord> {
        if let Some(existing) = self.get(&id)? {
            return Ok(existing);
        }
        let conn = self.conn.lock().map_err(|_| lock_err())?;
        conn.execute("BEGIN IMMEDIATE", []).map_err(sqlite_err)?;
        let result = Self::insert_row(&conn, &draft, id, now_secs, None, 1);
        match result {
            Ok(r) => {
                conn.execute("COMMIT", []).map_err(sqlite_err)?;
                drop(conn);
                // Same embed-on-write seam as put() — harvest uses put; import uses this.
                self.maybe_embed_content(&r.id, &r.content);
                Ok(r)
            }
            Err(e) => {
                let _ = conn.execute("ROLLBACK", []);
                Err(e)
            }
        }
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

    /// Embed redacted content and store in `memory_embeddings` when a backend is attached (#346).
    fn maybe_embed_content(&self, memory_id: &Uuid, content: &str) {
        let guard = self.embed.lock().unwrap_or_else(|e| e.into_inner());
        let Some((backend, model)) = guard.as_ref() else {
            return;
        };
        let redacted = match crate::memory::recall::redact_for_embed(content) {
            Ok(t) => t,
            Err(_) => return,
        };
        if let Some(vec) = embed_blocking(backend.as_ref(), &redacted, MEMORY_EMBED_TIMEOUT_MS) {
            let _ = self.put_embedding(memory_id, model, &vec);
        }
    }
}

/// Block on embed with a realistic timeout (write + query path). #346
pub fn embed_blocking(backend: &dyn EmbedBackend, text: &str, timeout_ms: u64) -> Option<Vec<f32>> {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .ok()?;
    let texts = vec![text.to_string()];
    match rt.block_on(async {
        tokio::time::timeout(
            std::time::Duration::from_millis(timeout_ms),
            backend.embed(&texts),
        )
        .await
    }) {
        Ok(Ok(mut v)) if !v.is_empty() => v.pop(),
        _ => None,
    }
}

impl MemoryStore for SqliteMemoryStore {
    fn set_embed_backend(&self, backend: Option<std::sync::Arc<dyn EmbedBackend>>, model: &str) {
        self.set_embed_backend_model(backend, model);
    }

    fn put(&self, op: MemoryWriteOp, now_secs: i64) -> CoreResult<MemoryRecord> {
        let embed_after = matches!(
            op,
            MemoryWriteOp::Insert(_) | MemoryWriteOp::Supersede { .. }
        );
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
                // Embed-on-write after commit so harvest/import/tools share this path (#346).
                drop(conn);
                if embed_after {
                    self.maybe_embed_content(&r.id, &r.content);
                }
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

        // #347: terms that live only in superseded content are not in FTS (we
        // remove superseded rows on write so active-only keyword collapse works).
        // When include_superseded, scan superseded rows by content/title directly.
        if q.include_superseded && !q.query.trim().is_empty() {
            let like = format!("%{}%", q.query.trim());
            let mut stmt = conn
                .prepare(
                    "SELECT id FROM memory WHERE status = 'superseded' AND (content LIKE ?1 OR title LIKE ?1) LIMIT 50",
                )
                .map_err(sqlite_err)?;
            let ids: Vec<String> = stmt
                .query_map(params![like], |r| r.get(0))
                .map_err(sqlite_err)?
                .filter_map(|r| r.ok())
                .collect();
            let mut seen: std::collections::HashSet<Uuid> =
                candidates.iter().map(|(r, _)| r.id).collect();
            for id_s in ids {
                if let Ok(id) = Uuid::parse_str(&id_s) {
                    if !seen.insert(id) {
                        continue;
                    }
                    if let Some(rec) = load_record(&conn, &id)? {
                        candidates.push((rec, 0.85)); // slightly below pure FTS active hits
                    }
                }
            }
        }

        // Default: active + valid-now only (unless include_superseded kept supersedes above).
        candidates.retain(|(rec, _)| {
            if rec.status == Status::Active {
                is_valid_now(rec.valid_from, rec.valid_to, now_secs)
            } else {
                q.include_superseded && rec.status == Status::Superseded
            }
        });

        if let Some(ref kinds) = q.kinds {
            candidates.retain(|(rec, _)| kinds.iter().any(|k| k == &rec.kind));
        }
        if let Some(scope) = q.scope {
            candidates.retain(|(rec, _)| rec.scope == scope);
        }

        // Expand supersession chains (newest-first) when requested.
        // Walk both directions: supersedes (older) and superseded_by (newer head).
        if q.include_superseded {
            let mut expanded: Vec<(MemoryRecord, f32)> = Vec::new();
            let mut seen = std::collections::HashSet::new();
            for (rec, kw) in candidates {
                // Climb to newest head first
                let mut head = rec.clone();
                while let Some(next_id) = head.superseded_by {
                    if let Some(n) = load_record(&conn, &next_id)? {
                        head = n;
                    } else {
                        break;
                    }
                }
                // Walk chain oldest-ward from head via supersedes
                let mut cursor = Some(head);
                let mut chain_rev: Vec<MemoryRecord> = Vec::new();
                while let Some(r) = cursor {
                    if !seen.insert(r.id) {
                        break;
                    }
                    let next = r.supersedes;
                    chain_rev.push(r);
                    cursor = match next {
                        Some(id) => load_record(&conn, &id)?,
                        None => None,
                    };
                }
                // newest-first
                for r in chain_rev {
                    expanded.push((r, kw));
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
                let conf = rec.confidence.unwrap_or(0.0).clamp(0.0, 1.0)
                    * crate::memory::recall::CONFIDENCE_SCORE_WEIGHT;
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

    fn list(
        &self,
        kinds: Option<&[Kind]>,
        include_superseded: bool,
        include_retracted: bool,
        now_secs: i64,
        limit: usize,
    ) -> CoreResult<Vec<MemoryRecord>> {
        self.list_records(
            kinds,
            include_superseded,
            include_retracted,
            now_secs,
            limit,
        )
    }

    fn purge_gdpr(
        &self,
        id: &Uuid,
        now_secs: i64,
        reason: &str,
    ) -> CoreResult<crate::memory::PurgeTombstone> {
        SqliteMemoryStore::purge_gdpr(self, id, now_secs, reason)
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
            assert_eq!(s.schema_version().unwrap(), migrate::MEMORY_SCHEMA_VERSION);
            s.put(MemoryWriteOp::Insert(draft("persist me")), 1)
                .unwrap();
        }
        {
            let s = SqliteMemoryStore::open(&path).unwrap();
            assert_eq!(s.schema_version().unwrap(), migrate::MEMORY_SCHEMA_VERSION);
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
    fn list_records_filters_status() {
        let store = SqliteMemoryStore::open_in_memory().unwrap();
        store
            .put(MemoryWriteOp::Insert(draft("active note alpha")), 10)
            .unwrap();
        let old = store
            .put(MemoryWriteOp::Insert(draft("will supersede")), 20)
            .unwrap();
        store
            .put(
                MemoryWriteOp::Supersede {
                    old: old.id,
                    new: draft("replacement beta"),
                },
                30,
            )
            .unwrap();
        let active = store.list_records(None, false, false, 40, 50).unwrap();
        assert!(active.iter().all(|r| r.status == Status::Active));
        let with_sup = store.list_records(None, true, false, 40, 50).unwrap();
        assert!(with_sup.iter().any(|r| r.status == Status::Superseded));
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
    #[test]
    fn purge_gdpr_removes_content_keeps_tombstone() {
        let store = SqliteMemoryStore::open_in_memory().unwrap();
        let rec = store
            .put(
                MemoryWriteOp::Insert(MemoryDraft::new(Kind::Fact, "secret personal fact xyz")),
                10,
            )
            .unwrap();
        let id = rec.id;
        let tomb = store.purge_gdpr(&id, 20, "gdpr_purge").unwrap();
        assert_eq!(tomb.id, id);
        assert!(store.get(&id).unwrap().is_none());
        let t2 = store.get_purge_tombstone(&id).unwrap().unwrap();
        assert_eq!(t2.content_hash, rec.content_hash);
        assert!(t2.title_redacted.contains("purged"));
        // retract is different path — purged id cannot be gotten
    }
}
