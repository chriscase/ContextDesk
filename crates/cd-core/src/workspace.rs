//! Workspace identity and allowlist stubs.

use crate::error::{CoreError, CoreResult};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

/// A project workspace the assistant may operate on.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Workspace {
    /// Stable id.
    pub id: String,
    /// Display name.
    pub name: String,
    /// Allowlisted filesystem roots (absolute).
    pub roots: Vec<PathBuf>,
}

impl Workspace {
    /// Create a new workspace with a fresh id.
    pub fn new(name: impl Into<String>, roots: Vec<PathBuf>) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            name: name.into(),
            roots,
        }
    }

    /// Returns true if `path` is under any allowlisted root.
    pub fn path_allowed(&self, path: &std::path::Path) -> bool {
        let Ok(canon) = path.canonicalize() else {
            // If path does not exist yet, check prefix against root strings.
            return self.roots.iter().any(|r| path.starts_with(r));
        };
        self.roots.iter().any(|r| {
            r.canonicalize()
                .map(|root| canon.starts_with(root))
                .unwrap_or(false)
        })
    }
}

/// Platform Documents directory, with a portable fallback.
///
/// - macOS / Windows: standard Documents folder via `dirs`
/// - Linux: `XDG_DOCUMENTS_DIR` or `$HOME/Documents`
/// - last resort: `$HOME` (caller must not use bare home as a root)
pub fn platform_documents_dir() -> CoreResult<PathBuf> {
    if let Some(d) = dirs::document_dir() {
        return Ok(d);
    }
    let home = dirs::home_dir().ok_or_else(|| CoreError::Config("no home directory".into()))?;
    Ok(home.join("Documents"))
}

/// Sanitize a single folder segment for use under Documents.
fn sanitize_folder_name(name: &str) -> CoreResult<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(CoreError::Config("empty workspace folder name".into()));
    }
    if name.contains('/') || name.contains('\\') || name.contains('\0') {
        return Err(CoreError::Config(
            "workspace folder name must be a single path segment".into(),
        ));
    }
    if name == "." || name == ".." {
        return Err(CoreError::Config("invalid workspace folder name".into()));
    }
    Ok(name.to_string())
}

/// OS-sensible default workspace root: `<Documents>/<product>`.
///
/// Never returns the whole home directory (hosts refuse that as a root).
/// The folder may not exist yet — call [`ensure_default_workspace_root`] to create it.
pub fn default_workspace_root(product_folder: &str) -> CoreResult<PathBuf> {
    let folder = sanitize_folder_name(product_folder)?;
    let base = platform_documents_dir()?;
    let path = base.join(&folder);

    // Defense in depth: never equal bare home.
    if let Some(home) = dirs::home_dir() {
        if path_eq_loose(&path, &home) {
            return Err(CoreError::Policy(
                "refusing whole home directory as a workspace root".into(),
            ));
        }
    }
    Ok(path)
}

/// Resolve and create the default workspace root if missing.
pub fn ensure_default_workspace_root(product_folder: &str) -> CoreResult<PathBuf> {
    let path = default_workspace_root(product_folder)?;
    fs::create_dir_all(&path)?;
    Ok(path)
}

/// Short label for UI (Documents/ContextDesk style).
pub fn default_workspace_label(product_folder: &str) -> String {
    let folder = product_folder.trim();
    if folder.is_empty() {
        "Documents".into()
    } else {
        format!("Documents/{folder}")
    }
}

fn path_eq_loose(a: &Path, b: &Path) -> bool {
    if a == b {
        return true;
    }
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(ca), Ok(cb)) => ca == cb,
        _ => false,
    }
}

/// True when `path` is exactly the user home directory (not a subfolder).
pub fn is_whole_home_directory(path: &Path) -> bool {
    let Ok(canon) = path.canonicalize() else {
        return false;
    };
    let Some(home) = dirs::home_dir() else {
        return false;
    };
    let Ok(h) = home.canonicalize() else {
        return false;
    };
    canon == h
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn path_allowed_prefix() {
        let root = PathBuf::from("/tmp/contextdesk-test-root");
        let ws = Workspace::new("t", vec![root.clone()]);
        assert!(ws.path_allowed(&root.join("docs/a.md")));
        assert!(!ws.path_allowed(std::path::Path::new("/etc/passwd")));
    }

    #[test]
    fn default_root_is_under_documents_not_home() {
        let path = default_workspace_root("ContextDesk").expect("default path");
        assert!(
            path.ends_with("ContextDesk"),
            "expected …/ContextDesk, got {}",
            path.display()
        );
        if let Some(home) = dirs::home_dir() {
            assert_ne!(
                path.canonicalize().ok(),
                home.canonicalize().ok(),
                "must not be whole home"
            );
            assert!(
                path.starts_with(&home) || dirs::document_dir().is_some_and(|d| path.starts_with(d)),
                "should sit under home or documents"
            );
        }
    }

    #[test]
    fn rejects_bad_folder_names() {
        assert!(default_workspace_root("").is_err());
        assert!(default_workspace_root("a/b").is_err());
        assert!(default_workspace_root("..").is_err());
    }

    #[test]
    fn ensure_creates_directory() {
        // Use a unique product name under real Documents when available.
        let name = format!("ContextDesk-test-{}", Uuid::new_v4());
        let path = ensure_default_workspace_root(&name).expect("create");
        assert!(path.is_dir());
        let _ = fs::remove_dir(&path);
    }

    #[test]
    fn label_format() {
        assert_eq!(default_workspace_label("ContextDesk"), "Documents/ContextDesk");
    }
}
