//! Keyword file knowledge index with optional SQLite persistence and incremental refresh.

use crate::error::{CoreError, CoreResult};
use crate::probe::looks_like_secret_filename;
use crate::workspace::Workspace;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// Max bytes read per file (binaries / huge dumps still skipped).
const MAX_FILE_BYTES: u64 = 512 * 1024;
/// Default soft file cap (was hard 5_000; now configurable via AppConfig).
const DEFAULT_MAX_FILES: usize = 100_000;
/// Max directory depth when walking roots.
const MAX_DEPTH: usize = 12;
/// Soft max chars per chunk (structure-aware chunker).
const MAX_CHUNK_CHARS: usize = 2_400;
/// Overlap lines between consecutive chunks.
const CHUNK_OVERLAP_LINES: usize = 4;

/// A searchable chunk.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Chunk {
    /// Absolute path.
    pub path: PathBuf,
    /// 1-based start line.
    pub start_line: usize,
    /// 1-based end line.
    pub end_line: usize,
    /// Text body.
    pub text: String,
    /// Source file mtime (unix secs) for recency scoring (#119).
    #[serde(default)]
    pub mtime_secs: i64,
}

/// Counts from an incremental refresh (for tests and tracing).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ReindexStats {
    /// Files seen during the walk (within caps).
    pub scanned: u32,
    /// New files indexed.
    pub added: u32,
    /// Existing files re-read and re-chunked.
    pub updated: u32,
    /// Files removed from the index (deleted on disk).
    pub removed: u32,
    /// Files skipped because (size, mtime) matched the store.
    pub unchanged: u32,
    /// True when walk stopped because max_files was hit (not silent).
    pub truncated: bool,
    /// Soft cap in effect during this refresh.
    pub max_files: u32,
}

/// In-memory keyword index with optional SQLite backing store.
#[derive(Debug)]
pub struct KeywordIndex {
    chunks: Vec<Chunk>,
    /// term -> chunk indices
    postings: HashMap<String, Vec<usize>>,
    /// Workspace roots this index covers.
    roots: Vec<PathBuf>,
    /// Optional SQLite path for persistence.
    store_path: Option<PathBuf>,
    /// Soft max files (default 100_000).
    max_files: usize,
}

impl Default for KeywordIndex {
    fn default() -> Self {
        Self {
            chunks: Vec::new(),
            postings: HashMap::new(),
            roots: Vec::new(),
            store_path: None,
            max_files: DEFAULT_MAX_FILES,
        }
    }
}

impl KeywordIndex {
    /// Empty index.
    pub fn new() -> Self {
        Self::default()
    }

    /// Number of chunks.
    pub fn len(&self) -> usize {
        self.chunks.len()
    }

    /// True if empty.
    pub fn is_empty(&self) -> bool {
        self.chunks.is_empty()
    }

    /// Full walk build (in-memory only). Prefer [`Self::open_or_build`] when a cache dir is available.
    pub fn build(workspace: &Workspace) -> CoreResult<Self> {
        Self::open_or_build(workspace, None, None)
    }

    /// Open a persisted store for this workspace or build from scratch.
    ///
    /// When `cache_dir` is `Some`, the SQLite file is
    /// `<cache_dir>/<workspace_id>.sqlite`. When `None`, in-memory only.
    /// `max_files` overrides the soft cap when `Some`.
    pub fn open_or_build(
        workspace: &Workspace,
        cache_dir: Option<&Path>,
        max_files: Option<usize>,
    ) -> CoreResult<Self> {
        let store_path = cache_dir.map(|d| {
            let _ = fs::create_dir_all(d);
            d.join(format!("{}.sqlite", sanitize_ws_id(&workspace.id)))
        });

        let mut idx = Self {
            chunks: Vec::new(),
            postings: HashMap::new(),
            roots: workspace.roots.clone(),
            store_path: store_path.clone(),
            max_files: max_files.unwrap_or(DEFAULT_MAX_FILES).clamp(1, 1_000_000),
        };

        if let Some(ref path) = store_path {
            if path.exists() {
                idx.load_from_store(path)?;
                // Cheap refresh to pick up disk changes without full re-read of unchanged.
                let _ = idx.refresh()?;
                return Ok(idx);
            }
            idx.init_store(path)?;
        }

        let stats = idx.refresh()?;
        tracing::debug!(?stats, "index open_or_build refresh");
        Ok(idx)
    }

    /// Configure soft max files (Settings / AppConfig).
    pub fn set_max_files(&mut self, n: usize) {
        self.max_files = n.clamp(1, 1_000_000);
    }

    /// Incremental reindex: skip re-read when size+mtime unchanged.
    pub fn refresh(&mut self) -> CoreResult<ReindexStats> {
        let mut stats = ReindexStats {
            max_files: self.max_files as u32,
            ..ReindexStats::default()
        };
        let mut seen_paths: HashSet<String> = HashSet::new();
        let mut file_count = 0usize;
        let mut hit_cap = false;
        let max_files = self.max_files;

        // Snapshot existing file metadata from store or memory fingerprint map.
        let existing = self.file_meta_map()?;

        for root in self.roots.clone() {
            if !root.exists() {
                continue;
            }
            walk(&root, 0, &mut |path| {
                if file_count >= max_files {
                    hit_cap = true;
                    return Ok(false);
                }
                let name = path
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or_default();
                if looks_like_secret_filename(name) {
                    return Ok(true);
                }
                if !is_textish(path) {
                    return Ok(true);
                }
                let meta = match fs::metadata(path) {
                    Ok(m) => m,
                    Err(_) => return Ok(true),
                };
                if meta.len() > MAX_FILE_BYTES {
                    return Ok(true);
                }
                let path_key = path.to_string_lossy().to_string();
                seen_paths.insert(path_key.clone());
                stats.scanned += 1;
                file_count += 1;

                let mtime = mtime_secs(&meta);
                let size = meta.len() as i64;

                if let Some((old_size, old_mtime, _)) = existing.get(&path_key) {
                    if *old_size == size && *old_mtime == mtime {
                        stats.unchanged += 1;
                        return Ok(true);
                    }
                }

                let text = match fs::read_to_string(path) {
                    Ok(t) => t,
                    Err(_) => return Ok(true),
                };
                let fp = fingerprint(size, mtime, &text);

                let is_new = !existing.contains_key(&path_key);
                self.upsert_file(path, size, mtime, &fp, &text)?;
                if is_new {
                    stats.added += 1;
                } else {
                    stats.updated += 1;
                }
                Ok(true)
            })?;
        }

        if hit_cap {
            stats.truncated = true;
            tracing::warn!(
                max_files = max_files,
                scanned = stats.scanned,
                "index walk truncated at max_files soft cap"
            );
        }

        // Remove files no longer present.
        for path_key in existing.keys() {
            if !seen_paths.contains(path_key) {
                self.remove_file(path_key)?;
                stats.removed += 1;
            }
        }

        // Rebuild in-memory view from store or re-chunk map.
        if self.store_path.is_some() {
            let path = self.store_path.clone().unwrap();
            self.load_from_store(&path)?;
        } else {
            // Pure in-memory: rebuild postings from current chunks only
            // (chunks already updated by upsert for memory-only path)
            self.rebuild_postings();
        }

        Ok(stats)
    }

    fn file_meta_map(&self) -> CoreResult<HashMap<String, (i64, i64, String)>> {
        let mut map = HashMap::new();
        if let Some(ref sp) = self.store_path {
            if !sp.exists() {
                return Ok(map);
            }
            let conn =
                Connection::open(sp).map_err(|e| CoreError::Message(format!("index open: {e}")))?;
            let mut stmt = conn
                .prepare("SELECT path, size, mtime_secs, fingerprint FROM files")
                .map_err(|e| CoreError::Message(format!("index prepare: {e}")))?;
            let rows = stmt
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                })
                .map_err(|e| CoreError::Message(format!("index query: {e}")))?;
            for r in rows.flatten() {
                map.insert(r.0, (r.1, r.2, r.3));
            }
            return Ok(map);
        }
        // Memory-only: derive from chunks (no mtime — always re-read on refresh)
        Ok(map)
    }

    fn init_store(&self, path: &Path) -> CoreResult<()> {
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let conn =
            Connection::open(path).map_err(|e| CoreError::Message(format!("index create: {e}")))?;
        conn.execute_batch(
            r#"
            PRAGMA foreign_keys = ON;
            CREATE TABLE IF NOT EXISTS files (
              id INTEGER PRIMARY KEY,
              path TEXT NOT NULL UNIQUE,
              size INTEGER NOT NULL,
              mtime_secs INTEGER NOT NULL,
              fingerprint TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS chunks (
              id INTEGER PRIMARY KEY,
              file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
              start_line INTEGER NOT NULL,
              end_line INTEGER NOT NULL,
              text TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_id);
            -- Embedding cache keyed by content fingerprint (#119); optional / empty by default.
            CREATE TABLE IF NOT EXISTS embeddings (
              content_key TEXT PRIMARY KEY,
              dims INTEGER NOT NULL,
              vector BLOB NOT NULL
            );
            "#,
        )
        .map_err(|e| CoreError::Message(format!("index schema: {e}")))?;
        // Migrate older stores that predate embeddings table.
        let _ = conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS embeddings (
              content_key TEXT PRIMARY KEY,
              dims INTEGER NOT NULL,
              vector BLOB NOT NULL
            );
            "#,
        );
        Ok(())
    }

    fn load_from_store(&mut self, path: &Path) -> CoreResult<()> {
        let conn =
            Connection::open(path).map_err(|e| CoreError::Message(format!("index open: {e}")))?;
        self.chunks.clear();
        let mut stmt = conn
            .prepare(
                "SELECT f.path, c.start_line, c.end_line, c.text, f.mtime_secs
                 FROM chunks c JOIN files f ON f.id = c.file_id
                 ORDER BY c.id",
            )
            .map_err(|e| CoreError::Message(format!("index prepare: {e}")))?;
        let rows = stmt
            .query_map([], |row| {
                Ok(Chunk {
                    path: PathBuf::from(row.get::<_, String>(0)?),
                    start_line: row.get::<_, i64>(1)? as usize,
                    end_line: row.get::<_, i64>(2)? as usize,
                    text: row.get(3)?,
                    mtime_secs: row.get::<_, i64>(4).unwrap_or(0),
                })
            })
            .map_err(|e| CoreError::Message(format!("index query: {e}")))?;
        for r in rows.flatten() {
            self.chunks.push(r);
        }
        self.rebuild_postings();
        Ok(())
    }

    fn upsert_file(
        &mut self,
        path: &Path,
        size: i64,
        mtime: i64,
        fingerprint: &str,
        text: &str,
    ) -> CoreResult<()> {
        let path_key = path.to_string_lossy().to_string();
        let file_chunks = chunk_file(path, text);

        if let Some(ref sp) = self.store_path {
            if !sp.exists() {
                self.init_store(sp)?;
            }
            let conn =
                Connection::open(sp).map_err(|e| CoreError::Message(format!("index open: {e}")))?;
            conn.execute("PRAGMA foreign_keys = ON", [])
                .map_err(|e| CoreError::Message(format!("pragma: {e}")))?;

            let existing_id: Option<i64> = conn
                .query_row(
                    "SELECT id FROM files WHERE path = ?1",
                    params![path_key],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|e| CoreError::Message(format!("index select: {e}")))?;

            let file_id = if let Some(id) = existing_id {
                conn.execute(
                    "UPDATE files SET size=?1, mtime_secs=?2, fingerprint=?3 WHERE id=?4",
                    params![size, mtime, fingerprint, id],
                )
                .map_err(|e| CoreError::Message(format!("index update file: {e}")))?;
                conn.execute("DELETE FROM chunks WHERE file_id=?1", params![id])
                    .map_err(|e| CoreError::Message(format!("index del chunks: {e}")))?;
                id
            } else {
                conn.execute(
                    "INSERT INTO files (path, size, mtime_secs, fingerprint) VALUES (?1,?2,?3,?4)",
                    params![path_key, size, mtime, fingerprint],
                )
                .map_err(|e| CoreError::Message(format!("index insert file: {e}")))?;
                conn.last_insert_rowid()
            };

            for c in &file_chunks {
                conn.execute(
                    "INSERT INTO chunks (file_id, start_line, end_line, text) VALUES (?1,?2,?3,?4)",
                    params![file_id, c.start_line as i64, c.end_line as i64, c.text],
                )
                .map_err(|e| CoreError::Message(format!("index insert chunk: {e}")))?;
            }
            return Ok(());
        }

        // Memory-only: replace chunks for this path; stamp mtime for recency.
        self.chunks.retain(|c| c.path != path);
        let stamped: Vec<Chunk> = file_chunks
            .into_iter()
            .map(|mut c| {
                c.mtime_secs = mtime;
                c
            })
            .collect();
        self.chunks.extend(stamped);
        Ok(())
    }

    fn remove_file(&mut self, path_key: &str) -> CoreResult<()> {
        if let Some(ref sp) = self.store_path {
            let conn =
                Connection::open(sp).map_err(|e| CoreError::Message(format!("index open: {e}")))?;
            conn.execute("PRAGMA foreign_keys = ON", []).ok();
            conn.execute("DELETE FROM files WHERE path = ?1", params![path_key])
                .map_err(|e| CoreError::Message(format!("index delete file: {e}")))?;
            return Ok(());
        }
        let p = PathBuf::from(path_key);
        self.chunks.retain(|c| c.path != p);
        Ok(())
    }

    fn rebuild_postings(&mut self) {
        self.postings.clear();
        for (i, chunk) in self.chunks.iter().enumerate() {
            for term in tokenize(&chunk.text) {
                self.postings.entry(term).or_default().push(i);
            }
            if let Some(s) = chunk.path.to_str() {
                for term in tokenize(s) {
                    self.postings.entry(term).or_default().push(i);
                }
            }
        }
    }

    /// Search with TF-IDF plus path / heading boosts.
    ///
    /// Scoring: base IDF sum for matching terms; +2.0 if term appears in the
    /// file path/basename; +1.5 if term appears in a markdown heading line
    /// (`# …`) inside the chunk. Body-only hits still rank via IDF alone.
    pub fn search(&self, query: &str, limit: usize) -> Vec<(f32, &Chunk)> {
        let terms: Vec<String> = tokenize(query).collect();
        if terms.is_empty() {
            return vec![];
        }
        let mut scores: HashMap<usize, f32> = HashMap::new();
        for term in &terms {
            if let Some(ids) = self.postings.get(term) {
                let idf = 1.0 + (self.chunks.len() as f32 / (1 + ids.len()) as f32).ln();
                for &i in ids {
                    *scores.entry(i).or_default() += idf;
                }
            }
        }
        // Path / heading boosts
        for (i, chunk) in self.chunks.iter().enumerate() {
            let Some(base) = scores.get_mut(&i) else {
                continue;
            };
            let path_l = chunk.path.to_string_lossy().to_lowercase();
            let file_stem = chunk
                .path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_lowercase();
            for term in &terms {
                if path_l.contains(term) || file_stem.contains(term) {
                    *base += 2.0;
                }
                for line in chunk.text.lines() {
                    if line.trim_start().starts_with('#')
                        && line.to_lowercase().contains(term.as_str())
                    {
                        *base += 1.5;
                        break;
                    }
                }
            }
        }
        let mut ranked: Vec<_> = scores.into_iter().collect();
        ranked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        ranked
            .into_iter()
            .take(limit.clamp(1, 50))
            .filter_map(|(i, s)| self.chunks.get(i).map(|c| (s, c)))
            .collect()
    }

    /// Hybrid search: keyword + optional semantic (embeddings) + recency (#119).
    ///
    /// When `embed` is `None`, results match keyword ranking with a mild recency
    /// boost only (same hit set as [`Self::search`] when recency weight is 0 for
    /// ties — default still includes small recency). Callers that need **strict**
    /// keyword equivalence should use [`Self::search`].
    ///
    /// On embed failure: `tracing::warn!` once and fall back to keyword+recency.
    pub async fn search_hybrid(
        &self,
        query: &str,
        limit: usize,
        embed: Option<&dyn crate::embed::EmbedBackend>,
        weights: crate::embed::HybridWeights,
    ) -> Vec<(f32, &Chunk)> {
        use crate::embed::{
            chunk_content_key, cosine_similarity, hybrid_score, now_unix_secs, recency_boost,
        };

        // Keyword baseline scores (same as search, unlimited then re-rank).
        let kw_hits = self.search(query, 50.max(limit));
        if kw_hits.is_empty() && embed.is_none() {
            return vec![];
        }

        // Candidate pool: keyword hits; if empty but we have embed, score all chunks (cap).
        let mut candidates: Vec<(usize, f32)> = if kw_hits.is_empty() {
            self.chunks
                .iter()
                .enumerate()
                .take(200)
                .map(|(i, _)| (i, 0.0f32))
                .collect()
        } else {
            // Map keyword results back to indices
            kw_hits
                .iter()
                .filter_map(|(s, c)| {
                    self.chunks
                        .iter()
                        .position(|x| {
                            x.path == c.path
                                && x.start_line == c.start_line
                                && x.end_line == c.end_line
                        })
                        .map(|i| (i, *s))
                })
                .collect()
        };

        let keyword_max = candidates
            .iter()
            .map(|(_, s)| *s)
            .fold(0.0f32, f32::max)
            .max(1e-6);

        let now = now_unix_secs();
        let mut query_vec: Option<Vec<f32>> = None;
        let mut chunk_vecs: HashMap<usize, Vec<f32>> = HashMap::new();

        if let Some(backend) = embed {
            match backend.embed(&[query.to_string()]).await {
                Ok(mut v) if !v.is_empty() => {
                    query_vec = Some(v.remove(0));
                    // Batch embed candidate texts (cache-aware when store present).
                    let texts: Vec<String> = candidates
                        .iter()
                        .filter_map(|(i, _)| self.chunks.get(*i).map(|c| c.text.clone()))
                        .collect();
                    match backend.embed(&texts).await {
                        Ok(vecs) => {
                            for (k, (i, _)) in candidates.iter().enumerate() {
                                if let Some(vec) = vecs.get(k) {
                                    // Best-effort persist
                                    if let Some(c) = self.chunks.get(*i) {
                                        let _ =
                                            self.cache_embedding(&chunk_content_key(&c.text), vec);
                                    }
                                    chunk_vecs.insert(*i, vec.clone());
                                }
                            }
                        }
                        Err(e) => {
                            tracing::warn!(error = %e, "embed candidates failed; keyword+recency only");
                            query_vec = None;
                        }
                    }
                }
                Ok(_) => {
                    tracing::warn!("embed returned empty vectors; keyword+recency only");
                }
                Err(e) => {
                    tracing::warn!(error = %e, "embed query failed; keyword+recency only");
                }
            }
        }

        let has_sem = query_vec.is_some() && !chunk_vecs.is_empty();
        let mut scored: Vec<(f32, usize)> = candidates
            .drain(..)
            .map(|(i, kw)| {
                let chunk = &self.chunks[i];
                let rec = recency_boost(chunk.mtime_secs, now);
                let sem = if has_sem {
                    match (query_vec.as_ref(), chunk_vecs.get(&i)) {
                        (Some(q), Some(c)) => cosine_similarity(q, c),
                        _ => 0.0,
                    }
                } else {
                    0.0
                };
                let score = hybrid_score(kw, keyword_max, sem, rec, weights);
                (score, i)
            })
            .collect();

        scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        scored
            .into_iter()
            .take(limit.clamp(1, 50))
            .filter_map(|(s, i)| self.chunks.get(i).map(|c| (s, c)))
            .collect()
    }

    /// Store an embedding blob in the SQLite cache (no-op when memory-only).
    fn cache_embedding(&self, content_key: &str, vector: &[f32]) -> CoreResult<()> {
        let Some(ref sp) = self.store_path else {
            return Ok(());
        };
        if !sp.exists() {
            return Ok(());
        }
        let conn = Connection::open(sp)
            .map_err(|e| CoreError::Message(format!("embed cache open: {e}")))?;
        let _ = conn.execute_batch(
            r#"CREATE TABLE IF NOT EXISTS embeddings (
              content_key TEXT PRIMARY KEY,
              dims INTEGER NOT NULL,
              vector BLOB NOT NULL
            );"#,
        );
        let bytes = f32_slice_to_bytes(vector);
        conn.execute(
            "INSERT OR REPLACE INTO embeddings (content_key, dims, vector) VALUES (?1,?2,?3)",
            params![content_key, vector.len() as i64, bytes],
        )
        .map_err(|e| CoreError::Message(format!("embed cache write: {e}")))?;
        Ok(())
    }

    /// Paths currently represented in the index (for tests).
    pub fn indexed_paths(&self) -> HashSet<PathBuf> {
        self.chunks.iter().map(|c| c.path.clone()).collect()
    }

    /// Parent directory of the SQLite store, if persistent.
    pub fn cache_dir(&self) -> Option<PathBuf> {
        self.store_path
            .as_ref()
            .and_then(|p| p.parent().map(|d| d.to_path_buf()))
    }
}

/// Structure-aware overlapping chunks: prefer markdown headings / blank lines;
/// bound by MAX_CHUNK_CHARS; overlap CHUNK_OVERLAP_LINES when advancing.
fn chunk_file(path: &Path, text: &str) -> Vec<Chunk> {
    let lines: Vec<&str> = text.lines().collect();
    if lines.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut start = 0usize;
    while start < lines.len() {
        let mut end = start;
        let mut chars = 0usize;
        let mut last_break = start + 1;
        while end < lines.len() {
            let line = lines[end];
            let add = line.chars().count() + 1;
            if end > start && chars + add > MAX_CHUNK_CHARS {
                break;
            }
            chars += add;
            end += 1;
            // Prefer break after heading or blank line
            if line.starts_with('#') || line.trim().is_empty() {
                last_break = end;
            }
        }
        if end == start {
            end = (start + 1).min(lines.len());
        } else if end < lines.len() && last_break > start + 1 {
            end = last_break;
        }
        let body = lines[start..end].join("\n");
        if !body.trim().is_empty() {
            out.push(Chunk {
                path: path.to_path_buf(),
                start_line: start + 1,
                end_line: end,
                text: body,
                mtime_secs: 0,
            });
        }
        if end >= lines.len() {
            break;
        }
        // Overlap: step back a few lines, but always advance
        let next = end.saturating_sub(CHUNK_OVERLAP_LINES).max(start + 1);
        start = next;
    }
    out
}

fn fingerprint(size: i64, mtime: i64, text: &str) -> String {
    // Cheap stable id: size, mtime, and length of text (content hash only when re-read).
    format!("{size}:{mtime}:{}", text.len())
}

fn f32_slice_to_bytes(v: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(v.len() * 4);
    for x in v {
        out.extend_from_slice(&x.to_le_bytes());
    }
    out
}

fn mtime_secs(meta: &fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn sanitize_ws_id(id: &str) -> String {
    id.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

fn tokenize(s: &str) -> impl Iterator<Item = String> + '_ {
    s.split(|c: char| !c.is_alphanumeric() && c != '_' && c != '-')
        .filter(|t| t.len() > 1)
        .map(|t| t.to_lowercase())
}

fn is_textish(path: &Path) -> bool {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase()
        .as_str()
    {
        "md" | "txt" | "rs" | "ts" | "tsx" | "js" | "jsx" | "json" | "toml" | "yaml" | "yml"
        | "py" | "go" | "java" | "kt" | "css" | "html" | "sh" | "sql" | "graphql" | "proto" => true,
        "" => path
            .file_name()
            .and_then(|s| s.to_str())
            .map(|n| n.to_uppercase().starts_with("README") || n.to_uppercase() == "LICENSE")
            .unwrap_or(false),
        _ => false,
    }
}

fn walk(dir: &Path, depth: usize, f: &mut dyn FnMut(&Path) -> CoreResult<bool>) -> CoreResult<()> {
    if depth > MAX_DEPTH {
        return Ok(());
    }
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return Ok(()),
    };
    for ent in entries.flatten() {
        let path = ent.path();
        let name = ent.file_name().to_string_lossy().to_string();
        if name.starts_with('.') && name != ".contextdesk" && path.is_dir() {
            continue;
        }
        if name == "node_modules" || name == "target" || name == "dist" || name == ".git" {
            continue;
        }
        if path.is_dir() {
            if path
                .symlink_metadata()
                .map(|m| m.file_type().is_symlink())
                .unwrap_or(false)
            {
                continue;
            }
            walk(&path, depth + 1, f)?;
        } else {
            if path
                .symlink_metadata()
                .map(|m| m.file_type().is_symlink())
                .unwrap_or(false)
            {
                continue;
            }
            let cont = f(&path)?;
            if !cont {
                return Ok(());
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn indexes_and_finds() {
        let dir = tempdir().unwrap();
        fs::write(
            dir.path().join("auth.md"),
            "# Auth\n\nSession tokens live in the gateway middleware.\n",
        )
        .unwrap();
        fs::write(dir.path().join(".env"), "SECRET=1").unwrap();
        let ws = Workspace::new("t", vec![dir.path().to_path_buf()]);
        let idx = KeywordIndex::build(&ws).unwrap();
        assert!(!idx.is_empty());
        let hits = idx.search("gateway session", 5);
        assert!(!hits.is_empty());
        assert!(idx.chunks.iter().all(|c| !c.path.ends_with(".env")));
    }

    #[test]
    fn persistent_incremental_unchanged() {
        let dir = tempdir().unwrap();
        let cache = tempdir().unwrap();
        fs::write(dir.path().join("a.md"), "alpha gateway one").unwrap();
        fs::write(dir.path().join("b.md"), "beta session two").unwrap();
        let ws = Workspace::new("ws1", vec![dir.path().to_path_buf()]);

        let mut idx = KeywordIndex::open_or_build(&ws, Some(cache.path()), None).unwrap();
        let hits1_text = idx
            .search("gateway", 5)
            .first()
            .map(|(_, c)| c.text.clone())
            .expect("hit");
        assert!(!hits1_text.is_empty());

        let stats = idx.refresh().unwrap();
        assert_eq!(stats.added, 0);
        assert_eq!(stats.updated, 0);
        assert!(stats.unchanged >= 2);
        assert_eq!(stats.removed, 0);

        // Reopen: same search hits, no full re-index needed beyond refresh stats
        let idx2 = KeywordIndex::open_or_build(&ws, Some(cache.path()), None).unwrap();
        let hits2_text = idx2
            .search("gateway", 5)
            .first()
            .map(|(_, c)| c.text.clone())
            .expect("hit2");
        assert_eq!(hits1_text, hits2_text);
    }

    #[test]
    fn persistent_update_and_remove() {
        let dir = tempdir().unwrap();
        let cache = tempdir().unwrap();
        let a = dir.path().join("a.md");
        fs::write(&a, "alpha gateway").unwrap();
        let ws = Workspace::new("ws2", vec![dir.path().to_path_buf()]);
        let mut idx = KeywordIndex::open_or_build(&ws, Some(cache.path()), None).unwrap();

        // Ensure mtime can change on some filesystems
        std::thread::sleep(std::time::Duration::from_millis(20));
        fs::write(&a, "alpha gateway UPDATED content").unwrap();
        let stats = idx.refresh().unwrap();
        assert_eq!(stats.updated, 1);

        fs::remove_file(&a).unwrap();
        let stats2 = idx.refresh().unwrap();
        assert_eq!(stats2.removed, 1);
        assert!(idx.search("UPDATED", 5).is_empty());
    }

    #[test]
    fn secret_env_never_persisted() {
        let dir = tempdir().unwrap();
        let cache = tempdir().unwrap();
        fs::write(dir.path().join("ok.md"), "public").unwrap();
        fs::write(dir.path().join(".env"), "SECRET=1").unwrap();
        let ws = Workspace::new("ws3", vec![dir.path().to_path_buf()]);
        let idx = KeywordIndex::open_or_build(&ws, Some(cache.path()), None).unwrap();
        assert!(idx.indexed_paths().iter().all(|p| !p.ends_with(".env")));
        // Store file must not contain .env path string
        let db = idx.store_path.clone().expect("persistent store path");
        assert!(db.exists(), "missing store at {}", db.display());
        let conn = Connection::open(&db).unwrap();
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM files WHERE path LIKE '%/.env' OR path LIKE '%\\.env'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 0);
    }

    /// Soft cap is no longer 5_000 — default allows large workspaces; truncation is signaled.
    #[test]
    fn max_files_soft_cap_signals_truncation() {
        let dir = tempdir().unwrap();
        for i in 0..20 {
            fs::write(dir.path().join(format!("f{i}.md")), format!("content {i}")).unwrap();
        }
        let ws = Workspace::new("cap", vec![dir.path().to_path_buf()]);
        let mut idx = KeywordIndex::open_or_build(&ws, None, Some(5)).unwrap();
        let stats = idx.refresh().unwrap();
        assert!(stats.truncated, "expected truncated={stats:?}");
        assert!(stats.scanned <= 5);
    }

    /// Synthetic 50k-file tree — ignored so default CI stays fast (AGENTS #8).
    ///
    /// Run:
    /// ```text
    /// cargo test -p cd-core --lib index_50k_soft_cap_allows_large_tree -- --ignored --nocapture
    /// ```
    /// Uses a SQLite store so walk flushes per-file (peak RAM is post-load postings,
    /// not an unbounded all-in-memory walk buffer). Default soft cap is 100_000.
    #[test]
    #[ignore = "slow synthetic 50k-file tree; run with --ignored"]
    fn index_50k_soft_cap_allows_large_tree() {
        let dir = tempdir().unwrap();
        let cache = tempdir().unwrap();
        let n = 50_000usize;
        for i in 0..n {
            let sub = dir.path().join(format!("b{}", i % 200));
            let _ = fs::create_dir_all(&sub);
            fs::write(
                sub.join(format!("f{i}.md")),
                format!("token_{i} unique document body\n"),
            )
            .unwrap();
        }
        let ws = Workspace::new("big50k", vec![dir.path().to_path_buf()]);
        let idx =
            KeywordIndex::open_or_build(&ws, Some(cache.path()), Some(DEFAULT_MAX_FILES)).unwrap();
        assert!(!idx.is_empty(), "index should not be empty after 50k walk");
        // Not truncated at default cap.
        let stats = {
            // Second refresh should report mostly unchanged.
            let mut idx2 =
                KeywordIndex::open_or_build(&ws, Some(cache.path()), Some(DEFAULT_MAX_FILES))
                    .unwrap();
            idx2.refresh().unwrap()
        };
        assert!(
            !stats.truncated,
            "default cap must not truncate 50k files: {stats:?}"
        );
        let hits = idx.search("token_42", 5);
        assert!(!hits.is_empty(), "expected hit for seeded token_42");
        let hits2 = idx.search("token_49999", 5);
        assert!(!hits2.is_empty(), "expected hit near end of corpus");
    }

    /// #119: without embed backend, hybrid hits are a superset of keyword path for same limit pool.
    #[tokio::test]
    async fn hybrid_without_embed_preserves_keyword_hits() {
        let dir = tempdir().unwrap();
        fs::write(
            dir.path().join("auth.md"),
            "# Auth\n\nSession tokens live in the gateway middleware.\n",
        )
        .unwrap();
        fs::write(
            dir.path().join("billing.md"),
            "# Billing\n\nInvoices and refunds are tracked here.\n",
        )
        .unwrap();
        let ws = Workspace::new("hyb", vec![dir.path().to_path_buf()]);
        let idx = KeywordIndex::build(&ws).unwrap();
        let kw: Vec<_> = idx
            .search("gateway session", 5)
            .into_iter()
            .map(|(_, c)| (c.path.clone(), c.start_line))
            .collect();
        let hy: Vec<_> = idx
            .search_hybrid(
                "gateway session",
                5,
                None,
                crate::embed::HybridWeights {
                    keyword: 1.0,
                    semantic: 0.0,
                    recency: 0.0,
                },
            )
            .await
            .into_iter()
            .map(|(_, c)| (c.path.clone(), c.start_line))
            .collect();
        // Same paths for pure keyword weights (order may differ only on ties).
        for p in &kw {
            assert!(hy.contains(p), "hybrid missing keyword hit {p:?}");
        }
    }

    /// #119: mock embed ranks semantic neighbor above pure keyword decoy.
    #[tokio::test]
    async fn hybrid_semantic_boosts_paraphrase() {
        let dir = tempdir().unwrap();
        // Keyword decoy: shares rare tokens with a naive query but wrong topic.
        fs::write(
            dir.path().join("decoy.md"),
            "# Unrelated\n\nThe word credentials appears once in a random list: apple banana credentials zebra.\n",
        )
        .unwrap();
        // Semantic target: auth topic without the query's exact rare tokens.
        fs::write(
            dir.path().join("auth.md"),
            "# Sign-in\n\nUsers authenticate with passwords and session tokens at the login endpoint.\n",
        )
        .unwrap();
        let ws = Workspace::new("sem", vec![dir.path().to_path_buf()]);
        let idx = KeywordIndex::build(&ws).unwrap();
        let backend = crate::embed::MockHashEmbedBackend::new(32);
        // Paraphrase query — few exact keyword overlaps with auth.md, but semantic neighbor.
        let hits = idx
            .search_hybrid(
                "user authentication credentials sign-in",
                5,
                Some(&backend),
                crate::embed::HybridWeights {
                    keyword: 0.25,
                    semantic: 0.65,
                    recency: 0.10,
                },
            )
            .await;
        assert!(!hits.is_empty());
        let top = hits[0].1.path.file_name().unwrap().to_string_lossy();
        assert!(
            top.contains("auth"),
            "expected auth.md on top, got {top} hits={:?}",
            hits.iter()
                .map(|(s, c)| (s, c.path.file_name().unwrap().to_string_lossy().to_string()))
                .collect::<Vec<_>>()
        );
    }
}
