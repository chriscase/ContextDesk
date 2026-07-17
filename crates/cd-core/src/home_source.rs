//! Home-source write-back defaults.

use serde::{Deserialize, Serialize};

/// Write capability of an origin.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WriteCapability {
    /// Cannot write.
    ReadOnly,
    /// Local soft write (memory/files).
    LocalWrite,
    /// Remote write (needs stronger confirm).
    RemoteWrite,
}

/// Provenance of content opened in a pane.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContentOrigin {
    /// Origin id (path, page, …).
    pub id: String,
    /// Kind label.
    pub kind: String,
    /// Write capability.
    pub write: WriteCapability,
}

/// Default save target decision.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SaveTarget {
    /// Where to save.
    pub origin: ContentOrigin,
    /// Why this default.
    pub reason: String,
}

/// Decide default save target.
pub fn default_save_target(
    opened_from: Option<&ContentOrigin>,
    multi_origin_synthesis: bool,
    memory_origin: ContentOrigin,
) -> SaveTarget {
    if multi_origin_synthesis {
        return SaveTarget {
            origin: memory_origin,
            reason: "Synthesized from multiple sources — save to project memory.".into(),
        };
    }
    if let Some(o) = opened_from {
        match o.write {
            WriteCapability::LocalWrite | WriteCapability::RemoteWrite => {
                return SaveTarget {
                    origin: o.clone(),
                    reason: format!("Content opened from {} — save back by default.", o.id),
                };
            }
            WriteCapability::ReadOnly => {
                return SaveTarget {
                    origin: memory_origin,
                    reason: format!("{} is read-only — saving overlay to project memory.", o.id),
                };
            }
        }
    }
    SaveTarget {
        origin: memory_origin,
        reason: "No single origin — project memory.".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn multi_origin_to_memory() {
        let mem = ContentOrigin {
            id: "memory/note.md".into(),
            kind: "memory".into(),
            write: WriteCapability::LocalWrite,
        };
        let t = default_save_target(
            Some(&ContentOrigin {
                id: "a".into(),
                kind: "file".into(),
                write: WriteCapability::LocalWrite,
            }),
            true,
            mem.clone(),
        );
        assert_eq!(t.origin.id, "memory/note.md");
    }

    #[test]
    fn single_writable_origin() {
        let mem = ContentOrigin {
            id: "memory/x".into(),
            kind: "memory".into(),
            write: WriteCapability::LocalWrite,
        };
        let o = ContentOrigin {
            id: "docs/a.md".into(),
            kind: "file".into(),
            write: WriteCapability::LocalWrite,
        };
        let t = default_save_target(Some(&o), false, mem);
        assert_eq!(t.origin.id, "docs/a.md");
    }
}
