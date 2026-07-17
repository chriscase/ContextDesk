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

const MAX_FILE_BYTES: u64 = 512 * 1024;
const MAX_FILES: usize = 5_000;
const MAX_DEPTH: usize = 12;

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
}

impl Default for KeywordIndex {
    fn default() -> Self {
        Self {
            chunks: Vec::new(),
            postings: HashMap::new(),
            roots: Vec::new(),
            store_path: None,
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
        Self::open_or_build(workspace, None)
    }

    /// Open a persisted store for this workspace or build from scratch.
    ///
    /// When `cache_dir` is `Some`, the SQLite file is
    /// `<cache_dir>/<workspace_id>.sqlite`. When `None`, in-memory only.
    pub fn open_or_build(workspace: &Workspace, cache_dir: Option<&Path>) -> CoreResult<Self> {
        let store_path = cache_dir.map(|d| {
            let _ = fs::create_dir_all(d);
            d.join(format!("{}.sqlite", sanitize_ws_id(&workspace.id)))
        });

        let mut idx = Self {
            chunks: Vec::new(),
            postings: HashMap::new(),
            roots: workspace.roots.clone(),
            store_path: store_path.clone(),
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

    /// Incremental reindex: skip re-read when size+mtime unchanged.
    pub fn refresh(&mut self) -> CoreResult<ReindexStats> {
        let mut stats = ReindexStats::default();
        let mut seen_paths: HashSet<String> = HashSet::new();
        let mut file_count = 0usize;

        // Snapshot existing file metadata from store or memory fingerprint map.
        let existing = self.file_meta_map()?;

        for root in self.roots.clone() {
            if !root.exists() {
                continue;
            }
            walk(&root, 0, &mut |path| {
                if file_count >= MAX_FILES {
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
            "#,
        )
        .map_err(|e| CoreError::Message(format!("index schema: {e}")))?;
        Ok(())
    }

    fn load_from_store(&mut self, path: &Path) -> CoreResult<()> {
        let conn =
            Connection::open(path).map_err(|e| CoreError::Message(format!("index open: {e}")))?;
        self.chunks.clear();
        let mut stmt = conn
            .prepare(
                "SELECT f.path, c.start_line, c.end_line, c.text
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

        // Memory-only: replace chunks for this path
        self.chunks.retain(|c| c.path != path);
        self.chunks.extend(file_chunks);
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

    /// Search with simple TF scoring.
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
        let mut ranked: Vec<_> = scores.into_iter().collect();
        ranked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        ranked
            .into_iter()
            .take(limit.clamp(1, 50))
            .filter_map(|(i, s)| self.chunks.get(i).map(|c| (s, c)))
            .collect()
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

fn chunk_file(path: &Path, text: &str) -> Vec<Chunk> {
    let lines: Vec<&str> = text.lines().collect();
    let chunk_size = 40usize;
    let mut out = Vec::new();
    let mut start = 0usize;
    while start < lines.len() {
        let end = (start + chunk_size).min(lines.len());
        let body = lines[start..end].join("\n");
        if !body.trim().is_empty() {
            out.push(Chunk {
                path: path.to_path_buf(),
                start_line: start + 1,
                end_line: end,
                text: body,
            });
        }
        start = end;
    }
    out
}

fn fingerprint(size: i64, mtime: i64, text: &str) -> String {
    // Cheap stable id: size, mtime, and length of text (content hash only when re-read).
    format!("{size}:{mtime}:{}", text.len())
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
        if name.starts_with('.') && name != ".contextdesk" {
            if path.is_dir() && name != ".contextdesk" {
                continue;
            }
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

        let mut idx = KeywordIndex::open_or_build(&ws, Some(cache.path())).unwrap();
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
        let idx2 = KeywordIndex::open_or_build(&ws, Some(cache.path())).unwrap();
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
        let mut idx = KeywordIndex::open_or_build(&ws, Some(cache.path())).unwrap();

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
        let idx = KeywordIndex::open_or_build(&ws, Some(cache.path())).unwrap();
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
}
