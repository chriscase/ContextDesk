//! Deterministic opaque fingerprints.
//!
//! Canonicalization and hashing are reused from `cd-triage-bench`
//! (`to_canonical_json` + `sha256_hex`); this module adds no second
//! canonical-JSON implementation and no second hash.
//!
//! Every fingerprint is prefixed so its provenance is readable, and every
//! prefix is chosen to satisfy both `cd_triage_sdk` opaque-id validation and
//! `cd_triage_bench::validate_id` (ASCII alphanumeric start, no path
//! separators, no `://`, no control characters).

use cd_triage_bench::canonical::to_canonical_json;
use cd_triage_bench::sha256_hex;
use serde::Serialize;

use crate::error::{AdapterError, AdapterResult};

/// Prefix for a compiled/selected policy fingerprint.
pub const POLICY_PREFIX: &str = "pol";
/// Prefix for a materialized task-packet fingerprint.
pub const PACKET_PREFIX: &str = "pkf";
/// Prefix for the bounded evidence-corpus fingerprint.
pub const CORPUS_PREFIX: &str = "cof";
/// Prefix for a per-role-slot fingerprint.
pub const SLOT_PREFIX: &str = "slf";
/// Prefix for an exact `ModelRef` fingerprint.
pub const MODEL_PREFIX: &str = "mdf";
/// Prefix for the SDK-side run identity.
pub const SDK_RUN_PREFIX: &str = "cdrun";
/// Prefix for the bench task identity projected into share-safe output.
pub const TASK_PREFIX: &str = "tkf";
/// Prefix for the bench snapshot identity projected into share-safe output.
pub const SNAPSHOT_PREFIX: &str = "snf";

/// Fingerprint `value` under `prefix` as `"<prefix>-<sha256 hex>"`.
///
/// The digest covers canonical JSON, so field order and map iteration order
/// cannot change the result.
pub fn fingerprint<T: Serialize>(prefix: &str, value: &T) -> AdapterResult<String> {
    let canonical = to_canonical_json(value).map_err(|_| AdapterError::Serialize)?;
    Ok(format!("{prefix}-{}", sha256_hex(canonical.as_bytes())))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprints_ignore_field_order_and_change_with_content() {
        let a = fingerprint("tst", &serde_json::json!({"b": 1, "a": 2})).unwrap();
        let b = fingerprint("tst", &serde_json::json!({"a": 2, "b": 1})).unwrap();
        let c = fingerprint("tst", &serde_json::json!({"a": 2, "b": 2})).unwrap();
        assert_eq!(a, b);
        assert_ne!(a, c);
        assert!(a.starts_with("tst-"));
    }
}
