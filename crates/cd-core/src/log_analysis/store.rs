//! Corpus event store (#358).
//!
//! Phase-1 uses an in-process columnar-friendly store (row vectors + indexes)
//! so default `cargo test` stays hermetic and fast. DuckDB is the design-locked
//! engine for 10–100M production scans (LOG_ANALYSIS.md §10); wire-up lives
//! behind the same [`LogCorpus`] API so a DuckDB backend can replace the body
//! without tool changes. See residual on #358 if `duckdb` feature is not yet
//! the default build path.

use super::drain::TemplateInfo;
use crate::error::{CoreError, CoreResult};
use crate::vector_index::{backend_name, select_backend, VectorIndex};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use uuid::Uuid;

/// Corpus identifier (UUIDv7 string).
pub type CorpusId = String;

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

/// Disposable log corpus under app cache.
pub struct LogCorpus {
    id: CorpusId,
    name: String,
    root: PathBuf,
    events: Mutex<Vec<LogEvent>>,
    templates: Mutex<HashMap<u64, TemplateRow>>,
    /// Vector index over template ids (Exact or Hnsw by size).
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
        let meta = serde_json::json!({
            "id": id,
            "name": name.into(),
            "created_at": crate::embed::now_unix_secs(),
            "engine": "mem_columnar_v1",
            "note": "DuckDB backend swap-compatible (#358)"
        });
        std::fs::write(root.join("meta.json"), serde_json::to_vec_pretty(&meta)?)?;
        Ok(Self {
            id,
            name: meta["name"].as_str().unwrap_or("corpus").to_string(),
            root,
            events: Mutex::new(Vec::new()),
            templates: Mutex::new(HashMap::new()),
            index: Mutex::new(select_backend(0)),
            index_backend: Mutex::new(backend_name(0)),
        })
    }

    /// Open existing corpus (loads events.jsonl + templates.json if present).
    pub fn open(cache_root: &Path, id: &str) -> CoreResult<Self> {
        let root = cache_root.join("log_corpora").join(id);
        if !root.join("meta.json").exists() {
            return Err(CoreError::Message(format!("corpus not found: {id}")));
        }
        let meta: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(root.join("meta.json"))?)?;
        let name = meta["name"].as_str().unwrap_or(id).to_string();
        let mut events = Vec::new();
        let ev_path = root.join("events.jsonl");
        if ev_path.exists() {
            for line in std::fs::read_to_string(&ev_path)?.lines() {
                if line.trim().is_empty() {
                    continue;
                }
                events.push(serde_json::from_str(line)?);
            }
        }
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
        // rebuild vectors
        for (tid, row) in &templates {
            if let Some(ref v) = row.vector {
                let _ = idx.upsert(*tid, v);
            }
        }
        Ok(Self {
            id: id.to_string(),
            name,
            root,
            events: Mutex::new(events),
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

    /// Append events (streaming ingest).
    pub fn push_events(&self, batch: &[LogEvent]) -> CoreResult<()> {
        let mut g = self.events.lock().map_err(|_| lock_err())?;
        g.extend_from_slice(batch);
        Ok(())
    }

    /// Upsert template rows.
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
        // Resize backend if crossed threshold
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
        // rebuild
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

    /// Event count.
    pub fn event_count(&self) -> usize {
        self.events.lock().map(|g| g.len()).unwrap_or(0)
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

    /// Borrow events under a callback (avoids cloning 10M rows).
    pub fn with_events<R>(&self, f: impl FnOnce(&[LogEvent]) -> R) -> R {
        let g = self.events.lock().unwrap_or_else(|e| e.into_inner());
        f(&g)
    }

    /// Semantic search over template vectors.
    pub fn search_templates(
        &self,
        query: &[f32],
        k: usize,
        allow: Option<&std::collections::HashSet<u64>>,
    ) -> CoreResult<Vec<(u64, f32)>> {
        let idx = self.index.lock().map_err(|_| lock_err())?;
        idx.search(query, k, allow)
    }

    /// Persist events + templates to disk (flush).
    pub fn flush(&self) -> CoreResult<()> {
        let events = self.events.lock().map_err(|_| lock_err())?;
        let mut f = String::new();
        for e in events.iter() {
            f.push_str(&serde_json::to_string(e)?);
            f.push('\n');
        }
        std::fs::write(self.root.join("events.jsonl"), f)?;
        let templates = self.templates.lock().map_err(|_| lock_err())?;
        let rows: Vec<_> = templates.values().cloned().collect();
        std::fs::write(
            self.root.join("templates.json"),
            serde_json::to_vec_pretty(&rows)?,
        )?;
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

fn lock_err() -> CoreError {
    CoreError::Message("log corpus lock poisoned".into())
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
    fn create_push_flush_open() {
        let dir = tempfile::tempdir().unwrap();
        let c = LogCorpus::create(dir.path(), "t1").unwrap();
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
        let c2 = LogCorpus::open(dir.path(), &id).unwrap();
        assert_eq!(c2.event_count(), 1);
        assert_eq!(c2.template_count(), 1);
        LogCorpus::discard(dir.path(), &id).unwrap();
        assert!(LogCorpus::list_ids(dir.path()).unwrap().is_empty());
    }

    /// Bounded-memory synthetic scan bench (not 10M by default — keep suite fast).
    /// Prints a projected 10M rate from a 200k-row full scan.
    #[test]
    fn scan_bench_print() {
        let dir = tempfile::tempdir().unwrap();
        let c = LogCorpus::create(dir.path(), "bench").unwrap();
        let n = 200_000u64;
        let mut batch = Vec::with_capacity(1024);
        for i in 0..n {
            batch.push(LogEvent {
                seq: i,
                ts: i as i64,
                level: if i % 10 == 0 { "error" } else { "info" }.into(),
                service: Some("api".into()),
                host: None,
                template_id: (i % 50) + 1,
                params: vec![],
                trace_id: None,
                message: format!("event {i}"),
                source: "b.log".into(),
            });
            if batch.len() >= 1024 {
                c.push_events(&batch).unwrap();
                batch.clear();
            }
        }
        if !batch.is_empty() {
            c.push_events(&batch).unwrap();
        }
        let t0 = Instant::now();
        let mut err = 0u64;
        c.with_events(|events| {
            for e in events {
                if e.level == "error" {
                    err += 1;
                }
            }
        });
        let dt = t0.elapsed();
        let rate = n as f64 / dt.as_secs_f64().max(1e-9);
        let proj_10m = 10_000_000f64 / rate;
        eprintln!(
            "scan_bench rows={n} errors={err} elapsed={dt:?} rate={rate:.0}/s projected_10M_scan={proj_10m:.2}s engine=mem_columnar_v1"
        );
        assert_eq!(err, n / 10);
        assert!(rate > 100_000.0, "scan too slow: {rate}/s");
    }
}
