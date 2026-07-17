//! Workspace identity and allowlist stubs.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use uuid::Uuid;

/// A project workspace the assistant may operate on.
#[derive(Debug, Clone, Serialize, Deserialize)]
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
}
