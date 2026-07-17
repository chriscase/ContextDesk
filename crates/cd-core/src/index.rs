//! Keyword file knowledge index (offline-friendly).

use crate::error::CoreResult;
use crate::probe::looks_like_secret_filename;
use crate::workspace::Workspace;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

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

/// In-memory keyword index.
#[derive(Debug, Clone, Default)]
pub struct KeywordIndex {
    chunks: Vec<Chunk>,
    /// term -> chunk indices
    postings: HashMap<String, Vec<usize>>,
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

    /// Build index by walking workspace roots.
    pub fn build(workspace: &Workspace) -> CoreResult<Self> {
        let mut idx = Self::new();
        let mut file_count = 0usize;
        for root in &workspace.roots {
            if !root.exists() {
                continue;
            }
            walk(root, 0, &mut |path| {
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
                let meta = fs::metadata(path)?;
                if meta.len() > MAX_FILE_BYTES {
                    return Ok(true);
                }
                let text = match fs::read_to_string(path) {
                    Ok(t) => t,
                    Err(_) => return Ok(true),
                };
                idx.add_file(path, &text);
                file_count += 1;
                Ok(true)
            })?;
        }
        idx.rebuild_postings();
        Ok(idx)
    }

    fn add_file(&mut self, path: &Path, text: &str) {
        let lines: Vec<&str> = text.lines().collect();
        let chunk_size = 40usize;
        let mut start = 0usize;
        while start < lines.len() {
            let end = (start + chunk_size).min(lines.len());
            let body = lines[start..end].join("\n");
            if !body.trim().is_empty() {
                self.chunks.push(Chunk {
                    path: path.to_path_buf(),
                    start_line: start + 1,
                    end_line: end,
                    text: body,
                });
            }
            start = end;
        }
    }

    fn rebuild_postings(&mut self) {
        self.postings.clear();
        for (i, chunk) in self.chunks.iter().enumerate() {
            for term in tokenize(&chunk.text) {
                self.postings.entry(term).or_default().push(i);
            }
            // path tokens
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
        "" => {
            // allow README without ext
            path.file_name()
                .and_then(|s| s.to_str())
                .map(|n| n.to_uppercase().starts_with("README") || n.to_uppercase() == "LICENSE")
                .unwrap_or(false)
        }
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
            // skip most dot dirs; allow .contextdesk memory
            if path.is_dir() && name != ".contextdesk" {
                continue;
            }
        }
        if name == "node_modules" || name == "target" || name == "dist" || name == ".git" {
            continue;
        }
        if path.is_dir() {
            // Do not follow symlinked directories outside the walk root.
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
                // Only index symlink files if the canonical target stays under an ancestor of path's parent walk — skip for safety.
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
        // .env not indexed as secret
        assert!(idx.chunks.iter().all(|c| !c.path.ends_with(".env")));
    }
}
