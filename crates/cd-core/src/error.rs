//! Error types for `cd-core`.

use thiserror::Error;

/// Result alias for core operations.
pub type CoreResult<T> = Result<T, CoreError>;

/// Errors returned by core APIs.
#[derive(Debug, Error)]
pub enum CoreError {
    /// Invalid configuration or branding.
    #[error("config: {0}")]
    Config(String),

    /// Operation denied by policy (permissions, allowlists).
    #[error("policy denied: {0}")]
    Policy(String),

    /// I/O failure.
    #[error("io: {0}")]
    Io(#[from] std::io::Error),

    /// Serialization failure.
    #[error("serde: {0}")]
    Serde(#[from] serde_json::Error),

    /// Generic failure with context (host may log details).
    #[error("{0}")]
    Message(String),
}
