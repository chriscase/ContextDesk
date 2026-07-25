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

/// `meta.json` schema version (v2 adds persisted ingest stats).
pub const META_VERSION: u32 = 2;

/// Snapshot of ingest / corpus statistics (persisted in meta.json).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CorpusStats {
    /// Files successfully read through EOF and imported.
    pub files: u64,
    /// File entries discovered before policy/read decisions.
    #[serde(default)]
    pub discovered_files: u64,
    /// Files excluded by an explicit policy guard.
    #[serde(default)]
    pub excluded_files: u64,
    /// Files that could not be opened or completely read.
    #[serde(default)]
    pub failed_files: u64,
    /// Entries intentionally ignored.
    #[serde(default)]
    pub ignored_files: u64,
    /// Counts by stable exclusion/failure reason.
    #[serde(default)]
    pub exclusion_counts: std::collections::BTreeMap<String, u64>,
    /// Bounded basename-only examples (`reason: basename`).
    #[serde(default)]
    pub exclusion_examples: Vec<String>,
    /// True when discovered content was not fully imported.
    #[serde(default)]
    pub partial: bool,
    /// Lines parsed.
    pub lines: u64,
    /// Distinct templates.
    pub templates: u64,
    /// lines / templates (0 if no templates).
    pub reduction_ratio: f64,
    /// Templates newly embedded at ingest.
    pub embedded: u64,
    /// Bytes read from source files (pre-redact).
    pub source_bytes: u64,
    /// On-disk footprint of corpus artifacts after flush.
    pub corpus_bytes: u64,
    /// Counts by normalized level (error/warn/info/…).
    #[serde(default)]
    pub level_counts: std::collections::BTreeMap<String, u64>,
    /// Earliest event ts (unix secs), if any.
    pub ts_min: Option<i64>,
    /// Latest event ts (unix secs), if any.
    pub ts_max: Option<i64>,
    /// Counts by parse format (json/logfmt/syslog/plain).
    #[serde(default)]
    pub format_counts: std::collections::BTreeMap<String, u64>,
}

/// Top template row saved at end of ingest for UI without full template load.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopTemplateSnapshot {
    /// Template id.
    pub id: u64,
    /// Drain pattern text.
    pub pattern: String,
    /// Event count for this template.
    pub count: u64,
    /// Severity score 0–max.
    pub severity: u8,
}

/// Persisted availability of semantic template vectors for a corpus.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum EmbeddingState {
    /// No template vectors are available; keyword/structured analysis remains usable.
    #[default]
    KeywordOnly,
    /// Local embedding was deliberately deferred by the bulk policy.
    Deferred,
    /// Some, but not all, templates have vectors.
    Partial,
    /// Every template has a vector.
    Complete,
}

/// Non-secret, restart-safe embedding status stored in `meta.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CorpusEmbeddingStatus {
    /// Current semantic availability.
    #[serde(default)]
    pub state: EmbeddingState,
    /// Local model identity when known; never a credential or endpoint.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    /// Templates with vectors.
    #[serde(default)]
    pub embedded_templates: u64,
    /// Total templates at the last embedding decision.
    #[serde(default)]
    pub total_templates: u64,
    /// Stable non-sensitive policy/result reason.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// Unix time of the last completed embedding decision.
    #[serde(default)]
    pub updated_at: i64,
}

impl Default for CorpusEmbeddingStatus {
    fn default() -> Self {
        Self {
            state: EmbeddingState::KeywordOnly,
            model_id: None,
            embedded_templates: 0,
            total_templates: 0,
            reason: Some("legacy_or_not_embedded".into()),
            updated_at: 0,
        }
    }
}

/// Full corpus meta.json document.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CorpusMeta {
    /// Schema version for meta.json.
    #[serde(default = "default_meta_version")]
    pub meta_version: u32,
    /// Corpus id (UUID).
    pub id: String,
    /// Display name.
    pub name: String,
    /// Unix creation time.
    pub created_at: i64,
    /// Event engine id (`duckdb`).
    pub engine: String,
    /// License note for close-proof.
    #[serde(default)]
    pub license: String,
    /// Vector index backend description.
    #[serde(default)]
    pub vector_index: String,
    /// Basename-only source label (never a home path).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_label: Option<String>,
    /// Original package id when imported from another machine.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin_corpus_id: Option<String>,
    /// Ingest / corpus statistics when available.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stats: Option<CorpusStats>,
    /// Top templates snapshot from last ingest.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub top_templates: Vec<TopTemplateSnapshot>,
    /// Actual semantic-vector availability and local model identity.
    #[serde(default)]
    pub embedding: CorpusEmbeddingStatus,
}

fn default_meta_version() -> u32 {
    1
}

/// Lightweight summary for list UIs (no full open analysis).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CorpusSummary {
    /// Corpus id.
    pub id: String,
    /// Display name.
    pub name: String,
    /// Event / line count.
    pub event_count: u64,
    /// Template count.
    pub template_count: u64,
    /// Event engine id.
    pub engine: String,
    /// Unix creation time.
    pub created_at: i64,
    /// Basename-only source label.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_label: Option<String>,
    /// Persisted ingest stats when available.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stats: Option<CorpusStats>,
    /// Actual semantic-vector availability.
    #[serde(default)]
    pub embedding: CorpusEmbeddingStatus,
}

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
    meta: Mutex<CorpusMeta>,
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
        let meta = CorpusMeta {
            meta_version: META_VERSION,
            id: id.clone(),
            name: name_s.clone(),
            created_at: crate::embed::now_unix_secs(),
            engine: EVENT_ENGINE.into(),
            license: "MIT (duckdb-rs + DuckDB)".into(),
            vector_index: "pure-rust VectorIndex (Exact/Hnsw)".into(),
            source_label: None,
            origin_corpus_id: None,
            stats: None,
            top_templates: Vec::new(),
            embedding: CorpusEmbeddingStatus::default(),
        };
        write_meta_file(&root, &meta)?;
        let db_path = root.join("events.duckdb");
        let conn = Connection::open(&db_path).map_err(duck_err)?;
        init_schema(&conn)?;
        Ok(Self {
            id,
            name: name_s,
            root,
            meta: Mutex::new(meta),
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
        let meta = read_meta_file(&root)?;
        let name = meta.name.clone();
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
            meta: Mutex::new(meta),
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

    /// Snapshot of corpus meta (stats, source label, …).
    pub fn meta(&self) -> CoreResult<CorpusMeta> {
        Ok(self.meta.lock().map_err(|_| lock_err())?.clone())
    }

    /// Persist updated ingest stats + top templates into meta.json.
    pub fn write_ingest_summary(
        &self,
        source_label: Option<String>,
        stats: CorpusStats,
        top_templates: Vec<TopTemplateSnapshot>,
        embedding: CorpusEmbeddingStatus,
    ) -> CoreResult<()> {
        let mut meta = self.meta.lock().map_err(|_| lock_err())?;
        meta.meta_version = META_VERSION;
        if let Some(label) = source_label {
            meta.source_label = Some(label);
        }
        meta.stats = Some(stats);
        meta.top_templates = top_templates;
        meta.embedding = embedding;
        write_meta_file(&self.root, &meta)?;
        Ok(())
    }

    /// Actual vector availability, correcting legacy metadata from loaded rows.
    pub fn embedding_status(&self) -> CorpusEmbeddingStatus {
        let rows = self.templates.lock().unwrap_or_else(|e| e.into_inner());
        let total = rows.len() as u64;
        let embedded = rows.values().filter(|row| row.vector.is_some()).count() as u64;
        let mut status = self
            .meta
            .lock()
            .map(|meta| meta.embedding.clone())
            .unwrap_or_default();
        status.total_templates = total;
        status.embedded_templates = embedded;
        status.state = if total > 0 && embedded == total {
            EmbeddingState::Complete
        } else if embedded > 0 {
            EmbeddingState::Partial
        } else if status.state == EmbeddingState::Deferred {
            EmbeddingState::Deferred
        } else {
            EmbeddingState::KeywordOnly
        };
        status
    }

    /// On-disk size of corpus artifacts (meta + duckdb + templates).
    pub fn corpus_bytes_on_disk(&self) -> u64 {
        dir_size(&self.root)
    }

    /// List summary for UI cards.
    ///
    /// Prefer meta.json (stats) without opening DuckDB when possible so Windows
    /// does not hit exclusive file locks when another handle is open.
    pub fn list_summaries(cache_root: &Path) -> CoreResult<Vec<CorpusSummary>> {
        let mut out = Vec::new();
        for id in Self::list_ids(cache_root)? {
            let root = cache_root.join("log_corpora").join(&id);
            if let Ok(meta) = read_meta_file(&root) {
                if let Some(ref stats) = meta.stats {
                    out.push(CorpusSummary {
                        id: meta.id.clone(),
                        name: meta.name.clone(),
                        event_count: stats.lines,
                        template_count: stats.templates,
                        engine: meta.engine.clone(),
                        created_at: meta.created_at,
                        source_label: meta.source_label.clone(),
                        stats: Some(stats.clone()),
                        embedding: meta.embedding.clone(),
                    });
                    continue;
                }
                // Legacy meta without stats: open for live counts if possible.
            }
            match Self::open(cache_root, &id) {
                Ok(c) => out.push(c.summary()),
                Err(_) => continue,
            }
        }
        out.sort_by_key(|b| std::cmp::Reverse(b.created_at));
        Ok(out)
    }

    /// Build a list/detail summary from this open corpus.
    pub fn summary(&self) -> CorpusSummary {
        let meta = self.meta.lock().ok();
        let (created_at, source_label, stats) = meta
            .as_ref()
            .map(|m| (m.created_at, m.source_label.clone(), m.stats.clone()))
            .unwrap_or((0, None, None));
        let (event_count, template_count) = if let Some(ref s) = stats {
            (s.lines, s.templates)
        } else {
            (self.event_count() as u64, self.template_count() as u64)
        };
        drop(meta);
        let embedding = self.embedding_status();
        CorpusSummary {
            id: self.id.clone(),
            name: self.name.clone(),
            event_count,
            template_count,
            engine: EVENT_ENGINE.into(),
            created_at,
            source_label,
            stats,
            embedding,
        }
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

    /// Run a closure with the DuckDB connection (explorer query plane).
    ///
    /// Prefer this over loading all events for large corpora.
    pub fn with_connection<R>(
        &self,
        f: impl FnOnce(&Connection) -> CoreResult<R>,
    ) -> CoreResult<R> {
        let conn = self.db.lock().map_err(|_| lock_err())?;
        f(&conn)
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

/// Write meta.json under a corpus root.
pub fn write_meta_file(root: &Path, meta: &CorpusMeta) -> CoreResult<()> {
    std::fs::write(root.join("meta.json"), serde_json::to_vec_pretty(meta)?)
        .map_err(|e| CoreError::Message(format!("write meta: {e}")))
}

/// Read meta.json from a corpus root.
pub fn read_meta_file(root: &Path) -> CoreResult<CorpusMeta> {
    let raw = std::fs::read_to_string(root.join("meta.json"))
        .map_err(|e| CoreError::Message(format!("read meta: {e}")))?;
    // Prefer typed parse; fall back for very old meta shapes.
    if let Ok(m) = serde_json::from_str::<CorpusMeta>(&raw) {
        return Ok(m);
    }
    let v: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| CoreError::Message(format!("parse meta: {e}")))?;
    Ok(CorpusMeta {
        meta_version: v.get("meta_version").and_then(|x| x.as_u64()).unwrap_or(1) as u32,
        id: v.get("id").and_then(|x| x.as_str()).unwrap_or("").into(),
        name: v.get("name").and_then(|x| x.as_str()).unwrap_or("").into(),
        created_at: v.get("created_at").and_then(|x| x.as_i64()).unwrap_or(0),
        engine: v
            .get("engine")
            .and_then(|x| x.as_str())
            .unwrap_or(EVENT_ENGINE)
            .into(),
        license: v
            .get("license")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .into(),
        vector_index: v
            .get("vector_index")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .into(),
        source_label: None,
        origin_corpus_id: None,
        stats: None,
        top_templates: Vec::new(),
        embedding: CorpusEmbeddingStatus::default(),
    })
}

/// Recursive directory size in bytes (best-effort).
pub fn dir_size(path: &Path) -> u64 {
    let mut total = 0u64;
    let Ok(rd) = std::fs::read_dir(path) else {
        return 0;
    };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            total = total.saturating_add(dir_size(&p));
        } else if let Ok(m) = e.metadata() {
            total = total.saturating_add(m.len());
        }
    }
    total
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
    fn legacy_meta_without_stats_still_opens() {
        let dir = tempfile::tempdir().unwrap();
        let id = "legacy-meta-1";
        let root = dir.path().join("log_corpora").join(id);
        std::fs::create_dir_all(&root).unwrap();
        // v1-style meta: no stats, no meta_version
        let meta = serde_json::json!({
            "id": id,
            "name": "old-incident",
            "created_at": 1_700_000_000,
            "engine": "duckdb",
            "license": "MIT",
            "vector_index": "exact"
        });
        std::fs::write(
            root.join("meta.json"),
            serde_json::to_vec_pretty(&meta).unwrap(),
        )
        .unwrap();
        // Minimal duckdb via create then copy? open requires events.duckdb — create empty via LogCorpus then overwrite meta
        let c = LogCorpus::create(dir.path(), "tmp").unwrap();
        let real_id = c.id().to_string();
        drop(c);
        let real_root = dir.path().join("log_corpora").join(&real_id);
        // Replace meta with legacy shape keeping same id field wrong — better: write legacy meta for real_id
        let legacy = serde_json::json!({
            "id": real_id,
            "name": "old-incident",
            "created_at": 1_700_000_000,
            "engine": "duckdb"
        });
        std::fs::write(
            real_root.join("meta.json"),
            serde_json::to_vec_pretty(&legacy).unwrap(),
        )
        .unwrap();
        let opened = LogCorpus::open(dir.path(), &real_id).expect("legacy meta must open");
        assert_eq!(opened.name(), "old-incident");
        let s = opened.summary();
        // counts derived from store when stats absent
        assert_eq!(s.event_count, opened.event_count() as u64);
        assert!(s.stats.is_none());
    }

    #[test]
    fn ingest_persists_meta_version_and_stats() {
        use std::io::Write;
        let dir = tempfile::tempdir().unwrap();
        let logs = dir.path().join("logs");
        std::fs::create_dir_all(&logs).unwrap();
        let mut f = std::fs::File::create(logs.join("a.log")).unwrap();
        for i in 0..40 {
            writeln!(f, "ts={} level=error msg=fail {}", 1_700_000_000 + i, i % 4).unwrap();
        }
        let cache = dir.path().join("cache");
        std::fs::create_dir_all(&cache).unwrap();
        let report = crate::log_analysis::ingest_path(&cache, &logs, "s", None, "none").unwrap();
        assert!(report.stats.reduction_ratio > 1.0);
        assert!(report.stats.source_bytes > 0);
        assert!(report.stats.corpus_bytes > 0);
        let c = LogCorpus::open(&cache, &report.corpus_id).unwrap();
        let meta = c.meta().unwrap();
        assert_eq!(meta.meta_version, META_VERSION);
        let stats = meta.stats.expect("stats persisted");
        assert_eq!(stats.lines, report.stats.lines);
        assert!((stats.reduction_ratio - report.stats.reduction_ratio).abs() < 0.01);
        assert!(!meta.top_templates.is_empty());
        // list summaries
        let list = LogCorpus::list_summaries(&cache).unwrap();
        assert!(list
            .iter()
            .any(|s| s.id == report.corpus_id && s.stats.is_some()));
    }

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
