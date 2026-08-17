//! Fail-closed adapter errors.
//!
//! Every message is share-safe: identities and reasons only, never evidence
//! bytes, model text, or credential material.

use cd_triage_sdk::TriageContractError;

/// Result alias for adapter operations.
pub type AdapterResult<T> = Result<T, AdapterError>;

/// A refusal at the bench/SDK boundary.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum AdapterError {
    /// A `cd-triage-bench` type or materialization rejected the input. The
    /// bench error is rendered to text because `BenchError` is not `Clone`.
    #[error("bench rejected the input: {0}")]
    Bench(String),
    /// A real `cd-triage-sdk` validator rejected the contract value.
    #[error("public contract rejected the value: {0}")]
    Contract(#[from] TriageContractError),
    /// The materialized packet does not match the task's visibility policy.
    #[error("visibility widened: {0}")]
    VisibilityWidened(String),
    /// A public SDK bound would have been exceeded.
    #[error("public SDK bound exceeded: {0}")]
    BoundExceeded(String),
    /// A share-safe projection failed the real `scan_share_safe_text` gate.
    #[error("share-safe projection retained owner-only material: {0}")]
    Privacy(String),
    /// Two identities that must agree do not.
    #[error("identity mismatch: {0}")]
    IdentityMismatch(String),
    /// A deterministic mock plan cannot produce a contract-valid replay.
    #[error("mock plan is not realizable: {0}")]
    UnrealizablePlan(String),
    /// Canonical JSON serialization failed.
    #[error("adapter serialization failed")]
    Serialize,
}

impl AdapterError {
    /// Wrap a `cd-triage-bench` error without importing its type into the
    /// adapter's public surface.
    pub(crate) fn bench(error: impl std::fmt::Display) -> Self {
        Self::Bench(error.to_string())
    }
}
