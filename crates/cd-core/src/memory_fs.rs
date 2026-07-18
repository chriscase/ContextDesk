//! Project memory directory listing and I/O under workspace allowlist.

use crate::error::{CoreError, CoreResult};
use crate::paths::resolve_allowed_path;
use crate::workspace::Workspace;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

/// A memory note on disk.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryFile {
    /// Absolute or resolved path.
    pub path: PathBuf,
    /// Relative display path.
    pub relative: String,
    /// Title (from first heading or filename).
    pub title: String,
    /// Full markdown body.
    pub body: String,
}

/// Resolve `{workspace_dir_name}/memory` under the first workspace root.
///
/// `workspace_dir_name` comes from [`crate::branding::Branding`] (e.g. `.contextdesk`).
pub fn memory_dir(workspace: &Workspace) -> CoreResult<PathBuf> {
    memory_dir_named(
        workspace,
        &crate::branding::Branding::embedded().workspace_dir_name,
    )
}

/// Like [`memory_dir`] with an explicit workspace data dir name (#179).
pub fn memory_dir_named(workspace: &Workspace, workspace_dir_name: &str) -> CoreResult<PathBuf> {
    let root = workspace
        .roots
        .first()
        .ok_or_else(|| CoreError::Policy("no workspace roots".into()))?;
    let dir = root.join(workspace_dir_name).join("memory");
    Ok(dir)
}

/// List all markdown notes in project memory (creates dir if missing).
pub fn list_memory_files(workspace: &Workspace) -> CoreResult<Vec<MemoryFile>> {
    let dir = memory_dir(workspace)?;
    if !dir.exists() {
        fs::create_dir_all(&dir)?;
        return Ok(vec![]);
    }
    let mut out = Vec::new();
    for ent in fs::read_dir(&dir)? {
        let ent = ent?;
        let path = ent.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        // Must stay under allowlist
        let resolved = resolve_allowed_path(workspace, &path, false)?;
        let body = fs::read_to_string(&resolved)?;
        let title = title_from_body_or_name(&body, &resolved);
        let relative = resolved
            .strip_prefix(workspace.roots.first().unwrap())
            .map(|p| p.display().to_string())
            .unwrap_or_else(|_| resolved.display().to_string());
        out.push(MemoryFile {
            path: resolved,
            relative,
            title,
            body,
        });
    }
    out.sort_by(|a, b| a.relative.cmp(&b.relative));
    Ok(out)
}

/// Read a file under workspace roots (for source preview / citations).
pub fn read_workspace_file(workspace: &Workspace, path: impl AsRef<Path>) -> CoreResult<String> {
    let resolved = resolve_allowed_path(workspace, path.as_ref(), false)?;
    if !resolved.is_file() {
        return Err(CoreError::Message(format!(
            "not a file: {}",
            resolved.display()
        )));
    }
    // Cap size for UI
    let meta = fs::metadata(&resolved)?;
    if meta.len() > 2 * 1024 * 1024 {
        return Err(CoreError::Policy("file too large to preview (>2MB)".into()));
    }
    Ok(fs::read_to_string(resolved)?)
}

/// Write/update a memory note (caller must have SoftWrite grant in agent path).
pub fn write_memory_file(
    workspace: &Workspace,
    filename: &str,
    title: &str,
    body: &str,
) -> CoreResult<PathBuf> {
    let dir = memory_dir(workspace)?;
    fs::create_dir_all(&dir)?;
    let safe: String = filename
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let safe = safe.trim_matches('-');
    let safe = if safe.is_empty() { "note" } else { safe };
    let path = dir.join(format!("{safe}.md"));
    let _ = resolve_allowed_path(workspace, &path, false)?;
    let content = if body.trim_start().starts_with('#') {
        body.to_string()
    } else {
        format!("# {title}\n\n{body}\n")
    };
    fs::write(&path, content)?;
    Ok(path)
}

fn title_from_body_or_name(body: &str, path: &Path) -> String {
    for line in body.lines() {
        let t = line.trim();
        if let Some(rest) = t.strip_prefix("# ") {
            return rest.trim().to_string();
        }
    }
    path.file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("note")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::Workspace;
    use tempfile::tempdir;

    #[test]
    fn list_write_roundtrip() {
        let dir = tempdir().unwrap();
        let ws = Workspace::new("t", vec![dir.path().to_path_buf()]);
        let p = write_memory_file(&ws, "arch", "Architecture", "We use JWT.").unwrap();
        assert!(p.exists());
        let files = list_memory_files(&ws).unwrap();
        assert_eq!(files.len(), 1);
        assert!(files[0].body.contains("JWT"));
        assert_eq!(files[0].title, "Architecture");
    }

    #[test]
    fn read_workspace_file_ok() {
        let dir = tempdir().unwrap();
        let f = dir.path().join("doc.md");
        fs::write(&f, "hello source").unwrap();
        let ws = Workspace::new("t", vec![dir.path().to_path_buf()]);
        let body = read_workspace_file(&ws, &f).unwrap();
        assert_eq!(body, "hello source");
    }

    #[test]
    fn read_outside_denied() {
        let dir = tempdir().unwrap();
        let ws = Workspace::new("t", vec![dir.path().to_path_buf()]);
        assert!(read_workspace_file(&ws, Path::new("/etc/passwd")).is_err());
    }
}
