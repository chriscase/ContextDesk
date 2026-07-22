//! Session-scoped context packs (#341) — ad-hoc files for one chat, not permanent workspace roots.

use crate::error::{CoreError, CoreResult};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

/// Default max files per session context.
pub const DEFAULT_MAX_FILES: usize = 200;
/// Default max total bytes for session context.
pub const DEFAULT_MAX_BYTES: u64 = 50 * 1024 * 1024; // 50 MiB
/// Default max single file size.
pub const DEFAULT_MAX_FILE_BYTES: u64 = 10 * 1024 * 1024; // 10 MiB

/// Caps for session context ingest.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct SessionContextCaps {
    /// Max file count.
    pub max_files: usize,
    /// Max total bytes of stored files.
    pub max_bytes: u64,
    /// Max single file bytes.
    pub max_file_bytes: u64,
}

impl Default for SessionContextCaps {
    fn default() -> Self {
        Self {
            max_files: DEFAULT_MAX_FILES,
            max_bytes: DEFAULT_MAX_BYTES,
            max_file_bytes: DEFAULT_MAX_FILE_BYTES,
        }
    }
}

/// One file entry in a session context pack.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionContextEntry {
    /// Relative path under the session context root (posix-style).
    pub rel_path: String,
    /// Original filename when imported.
    pub name: String,
    /// Size in bytes.
    pub size: u64,
}

/// Resolve and validate session context root: `{base}/sessions/{session_id}/context`.
///
/// `session_id` must be a safe id (uuid-like): alphanumeric, `-`, `_` only.
pub fn session_context_root(base: impl AsRef<Path>, session_id: &str) -> CoreResult<PathBuf> {
    let sid = sanitize_session_id(session_id)?;
    Ok(base.as_ref().join("sessions").join(sid).join("context"))
}

/// Reject path traversal / empty / weird session ids.
pub fn sanitize_session_id(session_id: &str) -> CoreResult<String> {
    let s = session_id.trim();
    if s.is_empty() || s.len() > 128 {
        return Err(CoreError::Policy(
            "invalid session id for context pack".into(),
        ));
    }
    if !s
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(CoreError::Policy(
            "session id must be alphanumeric / - / _ only".into(),
        ));
    }
    Ok(s.to_string())
}

/// Ensure `candidate` resolves under `root` (zip-slip / path escape guard).
pub fn resolve_under_root(root: &Path, relative: &str) -> CoreResult<PathBuf> {
    let rel = relative.trim().trim_start_matches('/');
    if rel.is_empty() {
        return Err(CoreError::Policy("empty relative path".into()));
    }
    if rel.contains('\0') {
        return Err(CoreError::Policy("nul in path".into()));
    }
    // Normalize components — reject `..` and absolute.
    let mut out = root.to_path_buf();
    for comp in Path::new(rel).components() {
        match comp {
            std::path::Component::Normal(c) => out.push(c),
            std::path::Component::CurDir => {}
            _ => {
                return Err(CoreError::Policy(format!(
                    "path escape rejected: `{relative}`"
                )));
            }
        }
    }
    // Canonical check when root exists
    let root_can = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    if let Ok(out_can) = out.canonicalize() {
        if !out_can.starts_with(&root_can) {
            return Err(CoreError::Policy(
                "path escape rejected after resolve".into(),
            ));
        }
        return Ok(out_can);
    }
    // Parent must stay under root for new files
    if let Some(parent) = out.parent() {
        if parent.exists() {
            let p = parent
                .canonicalize()
                .map_err(|e| CoreError::Message(format!("canonicalize parent: {e}")))?;
            if !p.starts_with(&root_can) {
                return Err(CoreError::Policy("path escape rejected (parent)".into()));
            }
        }
    }
    Ok(out)
}

/// Session context store on disk.
pub struct SessionContextStore {
    root: PathBuf,
    caps: SessionContextCaps,
}

impl SessionContextStore {
    /// Open (create) context dir for a session under `base`.
    pub fn open(
        base: impl AsRef<Path>,
        session_id: &str,
        caps: SessionContextCaps,
    ) -> CoreResult<Self> {
        let root = session_context_root(base, session_id)?;
        fs::create_dir_all(&root)
            .map_err(|e| CoreError::Message(format!("create session context: {e}")))?;
        Ok(Self { root, caps })
    }

    /// Absolute root path.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// List files (non-recursive for v1 top-level + one level of subdirs).
    pub fn list(&self) -> CoreResult<Vec<SessionContextEntry>> {
        let mut out = Vec::new();
        self.walk_list(&self.root, "", &mut out)?;
        out.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
        Ok(out)
    }

    fn walk_list(
        &self,
        dir: &Path,
        prefix: &str,
        out: &mut Vec<SessionContextEntry>,
    ) -> CoreResult<()> {
        let rd = fs::read_dir(dir).map_err(|e| CoreError::Message(format!("read_dir: {e}")))?;
        for ent in rd {
            let ent = ent.map_err(|e| CoreError::Message(format!("dir entry: {e}")))?;
            let name = ent.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            let rel = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}/{name}")
            };
            let ft = ent
                .file_type()
                .map_err(|e| CoreError::Message(format!("file_type: {e}")))?;
            if ft.is_dir() {
                self.walk_list(&ent.path(), &rel, out)?;
            } else if ft.is_file() {
                let meta = ent
                    .metadata()
                    .map_err(|e| CoreError::Message(format!("metadata: {e}")))?;
                out.push(SessionContextEntry {
                    rel_path: rel,
                    name,
                    size: meta.len(),
                });
            }
        }
        Ok(())
    }

    /// Import bytes as `rel_path` under the session root.
    pub fn import_bytes(&self, rel_path: &str, data: &[u8]) -> CoreResult<SessionContextEntry> {
        if data.len() as u64 > self.caps.max_file_bytes {
            return Err(CoreError::Policy(format!(
                "file exceeds max_file_bytes ({})",
                self.caps.max_file_bytes
            )));
        }
        let existing = self.list()?;
        if existing.len() >= self.caps.max_files {
            return Err(CoreError::Policy(format!(
                "session context max_files ({})",
                self.caps.max_files
            )));
        }
        let total = existing.iter().map(|e| e.size).sum::<u64>() + data.len() as u64;
        if total > self.caps.max_bytes {
            return Err(CoreError::Policy(format!(
                "session context max_bytes ({})",
                self.caps.max_bytes
            )));
        }
        let dest = resolve_under_root(&self.root, rel_path)?;
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| CoreError::Message(format!("mkdir: {e}")))?;
        }
        fs::write(&dest, data).map_err(|e| CoreError::Message(format!("write: {e}")))?;
        let name = dest
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| rel_path.to_string());
        Ok(SessionContextEntry {
            rel_path: rel_path.replace('\\', "/"),
            name,
            size: data.len() as u64,
        })
    }

    /// Copy a local file into the session context (host path already trusted by UI).
    pub fn import_file(
        &self,
        source: &Path,
        dest_name: Option<&str>,
    ) -> CoreResult<SessionContextEntry> {
        let data = fs::read(source).map_err(|e| CoreError::Message(format!("read source: {e}")))?;
        let name = dest_name
            .map(|s| s.to_string())
            .or_else(|| source.file_name().map(|s| s.to_string_lossy().to_string()))
            .unwrap_or_else(|| "file.bin".into());
        // Sanitize name only (no path seps)
        let safe: String = name
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' {
                    c
                } else {
                    '_'
                }
            })
            .collect();
        let safe = if safe.is_empty() {
            "file.bin".into()
        } else {
            safe
        };
        self.import_bytes(&safe, &data)
    }

    /// Remove one relative path.
    pub fn remove(&self, rel_path: &str) -> CoreResult<()> {
        let path = resolve_under_root(&self.root, rel_path)?;
        if path.is_file() {
            fs::remove_file(&path).map_err(|e| CoreError::Message(format!("remove: {e}")))?;
        } else if path.is_dir() {
            fs::remove_dir_all(&path)
                .map_err(|e| CoreError::Message(format!("remove dir: {e}")))?;
        }
        Ok(())
    }

    /// Purge entire session context directory.
    pub fn purge(&self) -> CoreResult<()> {
        if self.root.exists() {
            fs::remove_dir_all(&self.root)
                .map_err(|e| CoreError::Message(format!("purge: {e}")))?;
        }
        Ok(())
    }

    /// Expand a zip archive into the session context (#342). Nested zips up to `max_nest`.
    ///
    /// Rejects path escape (zip-slip), enforces entry/byte caps. Does not execute content.
    pub fn import_zip_bytes(
        &self,
        zip_bytes: &[u8],
        max_nest: u32,
    ) -> CoreResult<Vec<SessionContextEntry>> {
        import_zip_into_store(self, zip_bytes, max_nest, 0)
    }

    /// Whether `abs_path` is under this session root (for tool path policy).
    pub fn contains_path(&self, abs_path: &Path) -> bool {
        let Ok(root) = self.root.canonicalize() else {
            return false;
        };
        let Ok(p) = abs_path.canonicalize() else {
            return false;
        };
        p.starts_with(root)
    }
}

/// Default max nested zip depth.
pub const DEFAULT_MAX_ZIP_NEST: u32 = 2;
/// Max entries per zip expansion (including nested).
pub const DEFAULT_MAX_ZIP_ENTRIES: usize = 500;

/// One search hit inside session context (for `search_kb` overlay).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionSearchHit {
    /// Absolute path (for `read_file_slice`).
    pub path: PathBuf,
    /// Relative path under context root.
    pub rel_path: String,
    /// 1-based line of first match (approx).
    pub line: usize,
    /// Excerpt around the match.
    pub excerpt: String,
}

/// Keyword search over files under a session context root (case-insensitive substring).
///
/// Used by ToolHost so newly dropped pack files are searchable without a full reindex.
pub fn search_session_context(
    root: &Path,
    query: &str,
    limit: usize,
) -> CoreResult<Vec<SessionSearchHit>> {
    let q = query.trim();
    if q.is_empty() || limit == 0 {
        return Ok(vec![]);
    }
    let q_lower = q.to_ascii_lowercase();
    let mut hits = Vec::new();
    if !root.is_dir() {
        return Ok(hits);
    }
    walk_search(root, root, &q_lower, limit, &mut hits)?;
    Ok(hits)
}

fn walk_search(
    root: &Path,
    dir: &Path,
    q_lower: &str,
    limit: usize,
    hits: &mut Vec<SessionSearchHit>,
) -> CoreResult<()> {
    if hits.len() >= limit {
        return Ok(());
    }
    let rd = match fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return Ok(()),
    };
    for ent in rd.flatten() {
        if hits.len() >= limit {
            break;
        }
        let path = ent.path();
        let name = ent.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let ft = match ent.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if ft.is_dir() {
            walk_search(root, &path, q_lower, limit, hits)?;
            continue;
        }
        if !ft.is_file() {
            continue;
        }
        // Skip huge files / obvious binaries by size and extension
        let meta = match ent.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.len() > 2 * 1024 * 1024 {
            continue;
        }
        let lower_name = name.to_ascii_lowercase();
        if lower_name.ends_with(".zip")
            || lower_name.ends_with(".png")
            || lower_name.ends_with(".jpg")
            || lower_name.ends_with(".pdf")
        {
            continue;
        }
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        // Char-based case-fold search (no UTF-8 byte indexing).
        let text_chars: Vec<char> = text.chars().collect();
        let lower_chars: Vec<char> = text_chars.iter().flat_map(|c| c.to_lowercase()).collect();
        let q_chars: Vec<char> = q_lower.chars().collect();
        if q_chars.is_empty() {
            continue;
        }
        if let Some(char_idx) = lower_chars
            .windows(q_chars.len())
            .position(|w| w == q_chars.as_slice())
        {
            let line = text_chars
                .iter()
                .take(char_idx)
                .filter(|c| **c == '\n')
                .count()
                + 1;
            let start_c = char_idx.saturating_sub(40);
            let end_c = (char_idx + q_chars.len() + 80).min(text_chars.len());
            let excerpt: String = text_chars[start_c..end_c].iter().collect();
            let rel = path
                .strip_prefix(root)
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_else(|_| name.clone());
            hits.push(SessionSearchHit {
                path: path.clone(),
                rel_path: rel,
                line,
                excerpt: excerpt.replace('\n', " "),
            });
        }
    }
    Ok(())
}

/// Purge session context pack for `session_id` under `base` (no-op if missing).
///
/// Host calls this from permanent session delete (#341).
pub fn purge_session_at(base: impl AsRef<Path>, session_id: &str) -> CoreResult<()> {
    let root = session_context_root(base, session_id)?;
    if root.exists() {
        fs::remove_dir_all(&root).map_err(|e| CoreError::Message(format!("purge: {e}")))?;
    }
    Ok(())
}

/// Resolve a path for tools: session context first (when provided), else `None`.
pub fn resolve_in_session_context(session_root: &Path, path: &str) -> CoreResult<Option<PathBuf>> {
    let p = Path::new(path.trim());
    // Absolute under session root
    if p.is_absolute() {
        let Ok(root_c) = session_root.canonicalize() else {
            return Ok(None);
        };
        if let Ok(pc) = p.canonicalize() {
            if pc.starts_with(&root_c) {
                return Ok(Some(pc));
            }
        }
        return Ok(None);
    }
    // Relative to session root (or session:rel prefix)
    let rel = path
        .trim()
        .strip_prefix("session:")
        .unwrap_or(path.trim())
        .trim_start_matches('/');
    if rel.is_empty() {
        return Ok(None);
    }
    match resolve_under_root(session_root, rel) {
        Ok(resolved) if resolved.exists() => Ok(Some(resolved)),
        Ok(_) => Ok(None),
        Err(e) => Err(e),
    }
}

fn import_zip_into_store(
    store: &SessionContextStore,
    zip_bytes: &[u8],
    max_nest: u32,
    depth: u32,
) -> CoreResult<Vec<SessionContextEntry>> {
    use std::io::{Cursor, Read};
    let cursor = Cursor::new(zip_bytes);
    let mut archive =
        zip::ZipArchive::new(cursor).map_err(|e| CoreError::Message(format!("zip open: {e}")))?;
    if archive.len() > DEFAULT_MAX_ZIP_ENTRIES {
        return Err(CoreError::Policy(format!(
            "zip has too many entries (max {DEFAULT_MAX_ZIP_ENTRIES})"
        )));
    }
    let mut imported = Vec::new();
    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|e| CoreError::Message(format!("zip entry: {e}")))?;
        let name = file.name().to_string();
        if name.ends_with('/') {
            continue;
        }
        // Zip-slip: reject absolute and `..` components
        let rel = name.trim_start_matches('/');
        if rel.is_empty()
            || Path::new(rel)
                .components()
                .any(|c| !matches!(c, std::path::Component::Normal(_)))
        {
            return Err(CoreError::Policy(format!("zip-slip rejected: `{name}`")));
        }
        let mut data = Vec::new();
        file.read_to_end(&mut data)
            .map_err(|e| CoreError::Message(format!("zip read: {e}")))?;
        // Nested zip
        if depth < max_nest && rel.to_ascii_lowercase().ends_with(".zip") {
            let nested = import_zip_into_store(store, &data, max_nest, depth + 1)?;
            imported.extend(nested);
            continue;
        }
        match store.import_bytes(rel, &data) {
            Ok(e) => imported.push(e),
            Err(e) => {
                if e.to_string().contains("max_") {
                    return Err(e);
                }
                return Err(e);
            }
        }
    }
    Ok(imported)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_path_escape() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("ctx");
        fs::create_dir_all(&root).unwrap();
        assert!(resolve_under_root(&root, "../etc/passwd").is_err());
        let err = resolve_under_root(&root, "foo/../../secret").unwrap_err();
        assert!(
            err.to_string().contains("escape") || err.to_string().contains("rejected"),
            "{err}"
        );
    }

    #[test]
    fn import_list_remove() {
        let dir = tempfile::tempdir().unwrap();
        let store =
            SessionContextStore::open(dir.path(), "sess-1", SessionContextCaps::default()).unwrap();
        let e = store.import_bytes("logs/app.log", b"error line\n").unwrap();
        assert_eq!(e.rel_path, "logs/app.log");
        let list = store.list().unwrap();
        assert_eq!(list.len(), 1);
        assert!(store.contains_path(&store.root().join("logs/app.log")));
        store.remove("logs/app.log").unwrap();
        assert!(store.list().unwrap().is_empty());
    }

    #[test]
    fn caps_enforce_file_count() {
        let dir = tempfile::tempdir().unwrap();
        let caps = SessionContextCaps {
            max_files: 2,
            max_bytes: 10_000,
            max_file_bytes: 1000,
        };
        let store = SessionContextStore::open(dir.path(), "s2", caps).unwrap();
        store.import_bytes("a.txt", b"1").unwrap();
        store.import_bytes("b.txt", b"2").unwrap();
        let err = store.import_bytes("c.txt", b"3").unwrap_err();
        assert!(err.to_string().contains("max_files"));
    }

    #[test]
    fn session_id_sanitize_rules() {
        assert!(super::sanitize_session_id("../x").is_err());
        assert!(super::sanitize_session_id("ok-id_1").is_ok());
    }

    #[test]
    fn purge_session() {
        let dir = tempfile::tempdir().unwrap();
        let store =
            SessionContextStore::open(dir.path(), "p1", SessionContextCaps::default()).unwrap();
        store.import_bytes("f.txt", b"x").unwrap();
        store.purge().unwrap();
        assert!(!store.root().exists());
    }

    #[test]
    fn zip_slip_rejected() {
        use std::io::{Cursor, Write};
        let dir = tempfile::tempdir().unwrap();
        let store =
            SessionContextStore::open(dir.path(), "z1", SessionContextCaps::default()).unwrap();
        let mut buf = Cursor::new(Vec::new());
        {
            let mut w = zip::ZipWriter::new(&mut buf);
            let opts = zip::write::SimpleFileOptions::default();
            w.start_file("../evil.txt", opts).unwrap();
            w.write_all(b"nope").unwrap();
            w.finish().unwrap();
        }
        let err = store.import_zip_bytes(&buf.into_inner(), 1).unwrap_err();
        assert!(
            err.to_string().to_ascii_lowercase().contains("slip")
                || err.to_string().contains("rejected"),
            "{err}"
        );
    }

    #[test]
    fn zip_import_ok() {
        use std::io::{Cursor, Write};
        let dir = tempfile::tempdir().unwrap();
        let store =
            SessionContextStore::open(dir.path(), "z2", SessionContextCaps::default()).unwrap();
        let mut buf = Cursor::new(Vec::new());
        {
            let mut w = zip::ZipWriter::new(&mut buf);
            let opts = zip::write::SimpleFileOptions::default();
            w.start_file("nested/log.txt", opts).unwrap();
            w.write_all(b"hello zip").unwrap();
            w.finish().unwrap();
        }
        let entries = store.import_zip_bytes(&buf.into_inner(), 1).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].rel_path, "nested/log.txt");
    }

    #[test]
    fn search_finds_imported_file() {
        let dir = tempfile::tempdir().unwrap();
        let store =
            SessionContextStore::open(dir.path(), "s3", SessionContextCaps::default()).unwrap();
        store
            .import_bytes("triage.log", b"FATAL connection refused at gateway\n")
            .unwrap();
        let hits = search_session_context(store.root(), "connection refused", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert!(hits[0].excerpt.to_ascii_lowercase().contains("connection"));
        let resolved =
            resolve_in_session_context(store.root(), &hits[0].path.to_string_lossy()).unwrap();
        assert!(resolved.is_some());
        let by_rel = resolve_in_session_context(store.root(), "triage.log")
            .unwrap()
            .unwrap();
        assert!(by_rel.ends_with("triage.log"));
    }

    #[test]
    fn purge_session_at_removes_pack() {
        let dir = tempfile::tempdir().unwrap();
        let store =
            SessionContextStore::open(dir.path(), "del-me", SessionContextCaps::default()).unwrap();
        store.import_bytes("a.log", b"x").unwrap();
        assert!(store.root().exists());
        purge_session_at(dir.path(), "del-me").unwrap();
        assert!(!store.root().exists());
    }
}
