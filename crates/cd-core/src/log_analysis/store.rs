//! Corpus event store (#358) — embedded **DuckDB** for line events.
//!
//! Design: LOG_ANALYSIS.md §4 / §10. DuckDB is MIT (crate `duckdb` 1.x).
//! Template vectors stay on pure-Rust [`VectorIndex`] (Exact/Hnsw) — DuckDB is
//! the **event** store only, not the ANN backend.

use super::drain::TemplateInfo;
use crate::error::{CoreError, CoreResult};
use crate::vector_index::{backend_name, select_backend, VectorIndex};
use duckdb::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use uuid::Uuid;

/// Corpus identifier (UUIDv7 string).
pub type CorpusId = String;

/// Engine id recorded in meta.json (close-proof must show this, not mem_columnar).
pub const EVENT_ENGINE: &str = "duckdb";

/// One stored line event after parse/template/redact.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogEvent {
    /// Event sequence within corpus.
    pub seq: u64,
    /// Unix seconds.
    pub ts: i64,
    /// Normalized level.
    pub level: String,
    /// Optional service.
    pub service: Option<String>,
    /// Optional host.
    pub host: Option<String>,
    /// Template id from Drain.
    pub template_id: u64,
    /// Redacted params.
    pub params: Vec<String>,
    /// Optional trace id.
    pub trace_id: Option<String>,
    /// Redacted message (for FTS / exemplars).
    pub message: String,
    /// Source file relative path.
    pub source: String,
}

/// Template row persisted with the corpus (plus optional embedding hash).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TemplateRow {
    /// Drain template info.
    pub info: TemplateInfo,
    /// Content hash of pattern (embed cache key).
    pub content_hash: String,
    /// Dense vector when embedded.
    pub vector: Option<Vec<f32>>,
}

/// Disposable log corpus under app cache (events in DuckDB; templates + vectors aside).
pub struct LogCorpus {
    id: CorpusId,
    name: String,
    root: PathBuf,
    db: Mutex<Connection>,
    templates: Mutex<HashMap<u64, TemplateRow>>,
    /// Vector index over template ids (Exact or Hnsw by size) — pure Rust.
    index: Mutex<Box<dyn VectorIndex>>,
    /// Diagnostics: "exact" | "hnsw".
    index_backend: Mutex<&'static str>,
}

impl LogCorpus {
    /// Create empty corpus directory under `cache_root/log_corpora/{id}`.
    pub fn create(cache_root: &Path, name: impl Into<String>) -> CoreResult<Self> {
        let id = Uuid::now_v7().to_string();
        let root = cache_root.join("log_corpora").join(&id);
        std::fs::create_dir_all(&root)?;
        let name_s = name.into();
        let meta = serde_json::json!({
            "id": id,
            "name": name_s,
            "created_at": crate::embed::now_unix_secs(),
            "engine": EVENT_ENGINE,
            "license": "MIT (duckdb-rs + DuckDB)",
            "vector_index": "pure-rust VectorIndex (Exact/Hnsw)",
        });
        std::fs::write(root.join("meta.json"), serde_json::to_vec_pretty(&meta)?)?;
        let db_path = root.join("events.duckdb");
        let conn = Connection::open(&db_path).map_err(duck_err)?;
        init_schema(&conn)?;
        Ok(Self {
            id,
            name: name_s,
            root,
            db: Mutex::new(conn),
            templates: Mutex::new(HashMap::new()),
            index: Mutex::new(select_backend(0)),
            index_backend: Mutex::new(backend_name(0)),
        })
    }

    /// Open existing corpus.
    pub fn open(cache_root: &Path, id: &str) -> CoreResult<Self> {
        let root = cache_root.join("log_corpora").join(id);
        if !root.join("meta.json").exists() {
            return Err(CoreError::Message(format!("corpus not found: {id}")));
        }
        let meta: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(root.join("meta.json"))?)?;
        let name = meta["name"].as_str().unwrap_or(id).to_string();
        let db_path = root.join("events.duckdb");
        // Legacy mem corpora only had events.jsonl — refuse silent wrong engine.
        if !db_path.exists() {
            if root.join("events.jsonl").exists() {
                return Err(CoreError::Message(format!(
                    "corpus {id} is legacy mem_columnar (events.jsonl); re-ingest under DuckDB"
                )));
            }
            return Err(CoreError::Message(format!(
                "corpus {id} missing events.duckdb"
            )));
        }
        let conn = Connection::open(&db_path).map_err(duck_err)?;
        init_schema(&conn)?;

        let mut templates = HashMap::new();
        let t_path = root.join("templates.json");
        if t_path.exists() {
            let rows: Vec<TemplateRow> = serde_json::from_str(&std::fs::read_to_string(&t_path)?)?;
            for r in rows {
                templates.insert(r.info.template_id, r);
            }
        }
        let n_tpl = templates.len();
        let idx = select_backend(n_tpl);
        for (tid, row) in &templates {
            if let Some(ref v) = row.vector {
                let _ = idx.upsert(*tid, v);
            }
        }
        Ok(Self {
            id: id.to_string(),
            name,
            root,
            db: Mutex::new(conn),
            templates: Mutex::new(templates),
            index: Mutex::new(idx),
            index_backend: Mutex::new(backend_name(n_tpl)),
        })
    }

    /// Corpus id.
    pub fn id(&self) -> &str {
        &self.id
    }

    /// Display name.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// On-disk root.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Event engine id (`duckdb`).
    pub fn event_engine(&self) -> &'static str {
        EVENT_ENGINE
    }

    /// Append events (streaming ingest) into DuckDB.
    pub fn push_events(&self, batch: &[LogEvent]) -> CoreResult<()> {
        if batch.is_empty() {
            return Ok(());
        }
        let conn = self.db.lock().map_err(|_| lock_err())?;
        conn.execute_batch("BEGIN").map_err(duck_err)?;
        {
            let mut app = conn
                .appender("events")
                .map_err(|e| CoreError::Message(format!("duckdb appender: {e}")))?;
            for e in batch {
                let params_json = serde_json::to_string(&e.params).unwrap_or_else(|_| "[]".into());
                app.append_row(params![
                    e.seq as i64,
                    e.ts,
                    e.level.as_str(),
                    e.service.as_deref(),
                    e.host.as_deref(),
                    e.template_id as i64,
                    params_json.as_str(),
                    e.trace_id.as_deref(),
                    e.message.as_str(),
                    e.source.as_str(),
                ])
                .map_err(|e| CoreError::Message(format!("duckdb append: {e}")))?;
            }
            app.flush()
                .map_err(|e| CoreError::Message(format!("duckdb flush: {e}")))?;
        }
        conn.execute_batch("COMMIT").map_err(duck_err)?;
        Ok(())
    }

    /// Upsert template rows (JSON sidecar; not in DuckDB).
    pub fn upsert_templates(&self, rows: impl IntoIterator<Item = TemplateRow>) -> CoreResult<()> {
        let mut g = self.templates.lock().map_err(|_| lock_err())?;
        for r in rows {
            g.insert(r.info.template_id, r);
        }
        Ok(())
    }

    /// Set embedding for a template (content-hash cached by caller).
    pub fn set_template_vector(&self, template_id: u64, vector: Vec<f32>) -> CoreResult<()> {
        {
            let mut g = self.templates.lock().map_err(|_| lock_err())?;
            if let Some(row) = g.get_mut(&template_id) {
                row.vector = Some(vector.clone());
            } else {
                return Err(CoreError::Message(format!(
                    "unknown template_id {template_id}"
                )));
            }
        }
        let idx = self.index.lock().map_err(|_| lock_err())?;
        idx.upsert(template_id, &vector)?;
        let n = idx.len();
        drop(idx);
        self.maybe_reselect_backend(n)?;
        Ok(())
    }

    fn maybe_reselect_backend(&self, n: usize) -> CoreResult<()> {
        let want = backend_name(n);
        let mut kind = self.index_backend.lock().map_err(|_| lock_err())?;
        if *kind == want {
            return Ok(());
        }
        let templates = self.templates.lock().map_err(|_| lock_err())?;
        let new_idx = select_backend(n);
        for (tid, row) in templates.iter() {
            if let Some(ref v) = row.vector {
                new_idx.upsert(*tid, v)?;
            }
        }
        drop(templates);
        *self.index.lock().map_err(|_| lock_err())? = new_idx;
        *kind = want;
        Ok(())
    }

    /// Event count (DuckDB).
    pub fn event_count(&self) -> usize {
        let conn = match self.db.lock() {
            Ok(c) => c,
            Err(_) => return 0,
        };
        conn.query_row("SELECT COUNT(*) FROM events", [], |r| r.get::<_, i64>(0))
            .map(|n| n as usize)
            .unwrap_or(0)
    }

    /// Template count.
    pub fn template_count(&self) -> usize {
        self.templates.lock().map(|g| g.len()).unwrap_or(0)
    }

    /// Snapshot templates.
    pub fn list_templates(&self) -> Vec<TemplateRow> {
        let g = self.templates.lock().unwrap_or_else(|e| e.into_inner());
        let mut v: Vec<_> = g.values().cloned().collect();
        v.sort_by_key(|t| t.info.template_id);
        v
    }

    /// Load all events into memory for a callback (fine for tests / moderate corpora).
    /// Prefer [`Self::scan_template_frequency`] / [`Self::scan_error_by_service`] for large scans.
    pub fn with_events<R>(&self, f: impl FnOnce(&[LogEvent]) -> R) -> R {
        let events = self.load_all_events().unwrap_or_default();
        f(&events)
    }

    fn load_all_events(&self) -> CoreResult<Vec<LogEvent>> {
        let conn = self.db.lock().map_err(|_| lock_err())?;
        let mut stmt = conn
            .prepare(
                "SELECT seq, ts, level, service, host, template_id, params, trace_id, message, source FROM events ORDER BY seq",
            )
            .map_err(duck_err)?;
        let rows = stmt
            .query_map([], |r| {
                let params_s: String = r.get(6)?;
                let params: Vec<String> = serde_json::from_str(&params_s).unwrap_or_default();
                Ok(LogEvent {
                    seq: r.get::<_, i64>(0)? as u64,
                    ts: r.get(1)?,
                    level: r.get(2)?,
                    service: r.get(3)?,
                    host: r.get(4)?,
                    template_id: r.get::<_, i64>(5)? as u64,
                    params,
                    trace_id: r.get(7)?,
                    message: r.get(8)?,
                    source: r.get(9)?,
                })
            })
            .map_err(duck_err)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(duck_err)?);
        }
        Ok(out)
    }

    /// Semantic search over template vectors (pure-Rust index).
    pub fn search_templates(
        &self,
        query: &[f32],
        k: usize,
        allow: Option<&std::collections::HashSet<u64>>,
    ) -> CoreResult<Vec<(u64, f32)>> {
        let idx = self.index.lock().map_err(|_| lock_err())?;
        idx.search(query, k, allow)
    }

    // ── DuckDB analytical scans (production path for multi-M rows) ──────────

    /// Template frequency: `(template_id, count)` ordered by count desc.
    pub fn scan_template_frequency(
        &self,
        time_from: Option<i64>,
        time_to: Option<i64>,
    ) -> CoreResult<Vec<(u64, u64)>> {
        let conn = self.db.lock().map_err(|_| lock_err())?;
        let sql = r#"
            SELECT template_id, COUNT(*) AS c
            FROM events
            WHERE (?1 IS NULL OR ts >= ?1)
              AND (?2 IS NULL OR ts < ?2)
            GROUP BY template_id
            ORDER BY c DESC
        "#;
        let mut stmt = conn.prepare(sql).map_err(duck_err)?;
        let rows = stmt
            .query_map(params![time_from, time_to], |r| {
                Ok((r.get::<_, i64>(0)? as u64, r.get::<_, i64>(1)? as u64))
            })
            .map_err(duck_err)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(duck_err)?);
        }
        Ok(out)
    }

    /// Count by service where level is error/fatal.
    pub fn scan_error_by_service(&self) -> CoreResult<Vec<(String, u64)>> {
        let conn = self.db.lock().map_err(|_| lock_err())?;
        let mut stmt = conn
            .prepare(
                r#"
                SELECT COALESCE(service, ''), COUNT(*) AS c
                FROM events
                WHERE level IN ('error', 'fatal')
                GROUP BY 1
                ORDER BY c DESC
                "#,
            )
            .map_err(duck_err)?;
        let rows = stmt
            .query_map([], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as u64))
            })
            .map_err(duck_err)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(duck_err)?);
        }
        Ok(out)
    }

    /// Co-occurrence: pairs of template_ids that appear within `window_secs` of each other.
    ///
    /// Uses time-bucketed pairing (not a full O(n²) self-join) so multi-million
    /// corpora stay interactive. Returns `(a, b, count)` with a < b.
    pub fn scan_co_occurrence(
        &self,
        window_secs: i64,
        limit: usize,
    ) -> CoreResult<Vec<(u64, u64, u64)>> {
        let w = window_secs.max(1);
        let conn = self.db.lock().map_err(|_| lock_err())?;
        // Bucket events by floor(ts/window), then pair distinct templates that share a bucket.
        // This approximates "within window" co-occurrence without n² joins.
        let sql = r#"
            WITH bucketed AS (
                SELECT template_id, (ts / ?1) AS bkt, COUNT(*) AS n
                FROM events
                GROUP BY 1, 2
            ),
            pairs AS (
                SELECT LEAST(a.template_id, b.template_id) AS t_a,
                       GREATEST(a.template_id, b.template_id) AS t_b,
                       SUM(a.n * b.n) AS c
                FROM bucketed a
                JOIN bucketed b
                  ON a.bkt = b.bkt
                 AND a.template_id < b.template_id
                GROUP BY 1, 2
            )
            SELECT t_a, t_b, c FROM pairs
            ORDER BY c DESC
            LIMIT ?2
        "#;
        let mut stmt = conn.prepare(sql).map_err(duck_err)?;
        let rows = stmt
            .query_map(params![w, limit as i64], |r| {
                Ok((
                    r.get::<_, i64>(0)? as u64,
                    r.get::<_, i64>(1)? as u64,
                    r.get::<_, i64>(2)? as u64,
                ))
            })
            .map_err(duck_err)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(duck_err)?);
        }
        Ok(out)
    }

    /// Count events matching level/service (for timeline-style buckets via SQL).
    pub fn scan_timeline_buckets(
        &self,
        width_secs: i64,
        level: Option<&str>,
        service: Option<&str>,
    ) -> CoreResult<Vec<(i64, u64, String, u64)>> {
        let width = width_secs.max(1);
        let conn = self.db.lock().map_err(|_| lock_err())?;
        let sql = r#"
            SELECT (ts / ?1) * ?1 AS bucket,
                   level,
                   COUNT(*) AS c
            FROM events
            WHERE (?2 IS NULL OR level = ?2)
              AND (?3 IS NULL OR service = ?3)
            GROUP BY 1, 2
            ORDER BY 1, 2
        "#;
        let mut stmt = conn.prepare(sql).map_err(duck_err)?;
        let rows = stmt
            .query_map(params![width, level, service], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    width,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)? as u64,
                ))
            })
            .map_err(duck_err)?;
        // Return as (bucket_start, width, level, count) flattened — caller aggregates.
        let mut out = Vec::new();
        for row in rows {
            let (b, w, lvl, c) = row.map_err(duck_err)?;
            out.push((b, w as u64, lvl, c));
        }
        Ok(out)
    }

    /// Flush templates JSON + checkpoint DuckDB.
    pub fn flush(&self) -> CoreResult<()> {
        let templates = self.templates.lock().map_err(|_| lock_err())?;
        let rows: Vec<_> = templates.values().cloned().collect();
        std::fs::write(
            self.root.join("templates.json"),
            serde_json::to_vec_pretty(&rows)?,
        )?;
        // DuckDB is durable on append; optional checkpoint.
        let conn = self.db.lock().map_err(|_| lock_err())?;
        let _ = conn.execute_batch("CHECKPOINT");
        Ok(())
    }

    /// Discard corpus directory.
    pub fn discard(cache_root: &Path, id: &str) -> CoreResult<()> {
        let root = cache_root.join("log_corpora").join(id);
        if root.exists() {
            std::fs::remove_dir_all(&root)?;
        }
        Ok(())
    }

    /// List corpus ids under cache root.
    pub fn list_ids(cache_root: &Path) -> CoreResult<Vec<String>> {
        let dir = cache_root.join("log_corpora");
        if !dir.exists() {
            return Ok(vec![]);
        }
        let mut out = Vec::new();
        for e in std::fs::read_dir(dir)? {
            let e = e?;
            if e.file_type()?.is_dir() && e.path().join("meta.json").exists() {
                out.push(e.file_name().to_string_lossy().to_string());
            }
        }
        out.sort();
        Ok(out)
    }
}

fn init_schema(conn: &Connection) -> CoreResult<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS events (
            seq BIGINT NOT NULL,
            ts BIGINT NOT NULL,
            level VARCHAR NOT NULL,
            service VARCHAR,
            host VARCHAR,
            template_id BIGINT NOT NULL,
            params VARCHAR NOT NULL,
            trace_id VARCHAR,
            message VARCHAR NOT NULL,
            source VARCHAR NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
        CREATE INDEX IF NOT EXISTS idx_events_template ON events(template_id);
        CREATE INDEX IF NOT EXISTS idx_events_level ON events(level);
        CREATE INDEX IF NOT EXISTS idx_events_service ON events(service);
        CREATE INDEX IF NOT EXISTS idx_events_trace ON events(trace_id);
        "#,
    )
    .map_err(duck_err)?;
    Ok(())
}

fn lock_err() -> CoreError {
    CoreError::Message("log corpus lock poisoned".into())
}

fn duck_err(e: impl std::fmt::Display) -> CoreError {
    CoreError::Message(format!("duckdb: {e}"))
}

/// Content hash for template embed cache.
pub fn template_content_hash(pattern: &str) -> String {
    crate::embed::chunk_content_key(pattern)
}

#[cfg(test)]
mod tests {
    use super::super::drain::TemplateInfo;
    use super::*;
    use std::time::Instant;

    #[test]
    fn create_push_flush_open_is_duckdb() {
        let dir = tempfile::tempdir().unwrap();
        let c = LogCorpus::create(dir.path(), "t1").unwrap();
        assert_eq!(c.event_engine(), "duckdb");
        let meta: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(c.root().join("meta.json")).unwrap())
                .unwrap();
        assert_eq!(meta["engine"], "duckdb");
        assert!(c.root().join("events.duckdb").exists());
        let id = c.id().to_string();
        c.push_events(&[LogEvent {
            seq: 0,
            ts: 1,
            level: "error".into(),
            service: Some("api".into()),
            host: None,
            template_id: 1,
            params: vec![],
            trace_id: None,
            message: "boom".into(),
            source: "a.log".into(),
        }])
        .unwrap();
        c.upsert_templates([TemplateRow {
            info: TemplateInfo {
                template_id: 1,
                pattern: "boom".into(),
                token_count: 1,
                count: 1,
                first_seen: 1,
                last_seen: 1,
                severity: 4,
                example: "boom".into(),
            },
            content_hash: "x".into(),
            vector: None,
        }])
        .unwrap();
        c.flush().unwrap();
        drop(c);
        let c2 = LogCorpus::open(dir.path(), &id).unwrap();
        assert_eq!(c2.event_engine(), "duckdb");
        assert_eq!(c2.event_count(), 1);
        assert_eq!(c2.template_count(), 1);
        let freq = c2.scan_template_frequency(None, None).unwrap();
        assert_eq!(freq, vec![(1, 1)]);
        LogCorpus::discard(dir.path(), &id).unwrap();
        assert!(LogCorpus::list_ids(dir.path()).unwrap().is_empty());
    }

    /// Default-suite medium scan (keeps CI fast). Multi-million is #[ignore].
    #[test]
    fn duckdb_scan_bench_200k() {
        let dir = tempfile::tempdir().unwrap();
        let c = LogCorpus::create(dir.path(), "bench").unwrap();
        assert_eq!(c.event_engine(), EVENT_ENGINE);
        let n = 200_000u64;
        let mut batch = Vec::with_capacity(4096);
        let t_ingest = Instant::now();
        for i in 0..n {
            batch.push(LogEvent {
                seq: i,
                ts: (i / 10) as i64,
                level: if i % 10 == 0 { "error" } else { "info" }.into(),
                service: Some(if i % 3 == 0 { "api" } else { "worker" }.into()),
                host: Some("h1".into()),
                template_id: (i % 50) + 1,
                params: vec![],
                trace_id: None,
                message: format!("event {i}"),
                source: "b.log".into(),
            });
            if batch.len() >= 4096 {
                c.push_events(&batch).unwrap();
                batch.clear();
            }
        }
        if !batch.is_empty() {
            c.push_events(&batch).unwrap();
        }
        let ingest_dt = t_ingest.elapsed();

        let t0 = Instant::now();
        let freq = c.scan_template_frequency(None, None).unwrap();
        let freq_dt = t0.elapsed();
        assert_eq!(freq.len(), 50);

        let t1 = Instant::now();
        let by_svc = c.scan_error_by_service().unwrap();
        let err_dt = t1.elapsed();
        let err_total: u64 = by_svc.iter().map(|(_, c)| *c).sum();
        assert_eq!(err_total, n / 10);

        let t2 = Instant::now();
        let co = c.scan_co_occurrence(5, 20).unwrap();
        let co_dt = t2.elapsed();

        eprintln!(
            "duckdb_scan engine={} rows={n} ingest={ingest_dt:?} \
             template_frequency={freq_dt:?} error_by_service={err_dt:?} \
             co_occurrence(window=5s,top20)={co_dt:?} co_pairs={}",
            c.event_engine(),
            co.len()
        );
        assert!(c.event_count() as u64 == n);
    }

    /// Multi-million-row real DuckDB analytical scan (#358 close-proof).
    /// Run: `cargo test -p cd-core duckdb_multi_million -- --ignored --nocapture`
    #[test]
    #[ignore = "multi-million DuckDB ingest; run offline for #358 close-proof"]
    fn duckdb_multi_million_scan() {
        let dir = tempfile::tempdir().unwrap();
        let c = LogCorpus::create(dir.path(), "mm").unwrap();
        assert_eq!(c.event_engine(), "duckdb");
        let n = 2_000_000u64;
        let templates_n = 80u64;
        let mut batch = Vec::with_capacity(8192);
        let t_ingest = Instant::now();
        for i in 0..n {
            batch.push(LogEvent {
                seq: i,
                ts: (i / 100) as i64,
                level: if i % 20 == 0 {
                    "error"
                } else if i % 7 == 0 {
                    "warn"
                } else {
                    "info"
                }
                .into(),
                service: Some(
                    match i % 4 {
                        0 => "api",
                        1 => "worker",
                        2 => "db",
                        _ => "gateway",
                    }
                    .into(),
                ),
                host: Some(format!("node-{}", i % 16)),
                template_id: (i % templates_n) + 1,
                params: vec![format!("{}", i % 1000)],
                trace_id: if i % 50 == 0 {
                    Some(format!("tr-{}", i % 5000))
                } else {
                    None
                },
                message: format!("t{} param {}", i % templates_n, i % 1000),
                source: "synth.log".into(),
            });
            if batch.len() >= 8192 {
                c.push_events(&batch).unwrap();
                batch.clear();
            }
        }
        if !batch.is_empty() {
            c.push_events(&batch).unwrap();
        }
        let ingest_dt = t_ingest.elapsed();
        // Fake drain reduction: n events / templates_n unique templates
        let reduction = n as f64 / templates_n as f64;

        let t0 = Instant::now();
        let freq = c.scan_template_frequency(None, None).unwrap();
        let freq_dt = t0.elapsed();

        let t1 = Instant::now();
        let by_svc = c.scan_error_by_service().unwrap();
        let err_dt = t1.elapsed();

        let t2 = Instant::now();
        // Co-occurrence on full 2M self-join is heavy; sample via time slice if needed.
        // Window 2s on dense timestamps is still large — limit pair output.
        let co = c.scan_co_occurrence(2, 50).unwrap();
        let co_dt = t2.elapsed();

        eprintln!(
            "duckdb_multi_million engine={} rows={n} templates={templates_n} \
             reduction_ratio={reduction:.1} ingest={ingest_dt:?} \
             template_frequency={freq_dt:?} (groups={}) \
             error_by_service={err_dt:?} (services={}) \
             co_occurrence={co_dt:?} (pairs={})",
            c.event_engine(),
            freq.len(),
            by_svc.len(),
            co.len()
        );
        assert_eq!(c.event_count() as u64, n);
        assert_eq!(freq.len() as u64, templates_n);
        assert!(
            freq_dt.as_secs_f64() < 60.0,
            "frequency scan too slow: {freq_dt:?}"
        );
    }
}
