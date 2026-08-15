//! Typed errors for the offline triage bench.

use std::io;
use std::path::PathBuf;

/// Result alias for bench operations.
pub type BenchResult<T> = Result<T, BenchError>;

/// Fail-closed bench error. Messages are share-safe (no secret material).
#[derive(Debug, thiserror::Error)]
pub enum BenchError {
    #[error("schema: {0}")]
    Schema(String),
    #[error("unknown field rejected: {0}")]
    UnknownField(String),
    #[error("immutable record: {0}")]
    Immutable(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("cross-snapshot comparison rejected: {0}")]
    CrossSnapshot(String),
    #[error("integrity: {0}")]
    Integrity(String),
    #[error("duplicate: {0}")]
    Duplicate(String),
    #[error("privacy: {0}")]
    Privacy(String),
    #[error("io {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("{0}")]
    Message(String),
}

impl BenchError {
    /// Process exit code for CLI mapping.
    pub fn exit_code(&self) -> i32 {
        match self {
            Self::NotFound(_) => 3,
            Self::Immutable(_) | Self::Integrity(_) | Self::CrossSnapshot(_) => 2,
            _ => 1,
        }
    }

    pub(crate) fn io(path: impl Into<PathBuf>, source: io::Error) -> Self {
        Self::Io {
            path: path.into(),
            source,
        }
    }

    pub(crate) fn from_serde(err: serde_json::Error) -> Self {
        let text = err.to_string();
        if text.contains("unknown field") {
            Self::UnknownField(text)
        } else {
            Self::Schema(text)
        }
    }
}
