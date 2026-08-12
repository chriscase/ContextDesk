//! Host-owned, exact-role qualification evidence for Triage Policy V2.
//!
//! Generic capability qualification answers questions such as “does this
//! endpoint emit a native tool call?”  That evidence is deliberately not
//! enough to authorize the V2 graph: every role has a different packet and
//! validator contract.  This module is the small, secret-free persistence
//! boundary for the stronger evidence.  It stores only host-authored facts;
//! the workflow layer is responsible for running the synthetic probes that
//! produce them.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::capability_qualification::fingerprint_endpoint;
use crate::multi_model::triage_policy::{
    RoleQualificationV2, TriageSlotKindV2, TRIAGE_QUALIFICATION_SCHEMA_V2,
    TRIAGE_QUALIFICATION_WORKFLOW_V2,
};

/// Stable schema for the persisted role-qualification store.
pub const TRIAGE_ROLE_QUALIFICATION_STORE_SCHEMA_V1: &str =
    "contextdesk.triage_role_qualification_store.v1";
/// Stable identity for the synthetic role probe contract.
pub const TRIAGE_ROLE_QUALIFICATION_PROBE_SCHEMA_V1: &str = "contextdesk.triage.role_probe.v1";
/// Bounded file size for the local, non-secret store.
pub const MAX_TRIAGE_ROLE_QUALIFICATION_STORE_BYTES: usize = 2 * 1024 * 1024;
/// Maximum records retained so a corrupted or hostile file cannot grow
/// startup/preflight work without bound.
pub const MAX_TRIAGE_ROLE_QUALIFICATION_RECORDS: usize = 512;

/// Exact identity of one role probe.  The endpoint is represented only by its
/// stable fingerprint; no URL or credential reference is persisted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TriageRoleQualificationKeyV1 {
    /// Provider profile identity from local configuration.
    pub profile_id: String,
    /// Exact catalog model id.
    pub model_id: String,
    /// Normalized endpoint fingerprint.
    pub endpoint_fingerprint: String,
    /// Exact V2 role/phase identity.
    pub kind: TriageSlotKindV2,
    /// Qualification evidence schema.
    pub qualification_schema_id: String,
    /// Workflow identity.
    pub workflow_id: String,
    /// Secret-free transport/dialect fingerprint.
    pub protocol_fingerprint: String,
    /// Fingerprint of the synthetic probe contract and prompt version.
    pub probe_fingerprint: String,
}

impl TriageRoleQualificationKeyV1 {
    /// Construct the current key from a configured profile and exact role.
    pub fn current(
        profile_id: &str,
        base_url: &str,
        model_id: &str,
        kind: TriageSlotKindV2,
        protocol_fingerprint: impl Into<String>,
    ) -> Self {
        Self {
            profile_id: profile_id.trim().to_string(),
            model_id: model_id.trim().to_string(),
            endpoint_fingerprint: format!("sha256:{}", fingerprint_endpoint(base_url)),
            kind,
            qualification_schema_id: TRIAGE_QUALIFICATION_SCHEMA_V2.into(),
            workflow_id: TRIAGE_QUALIFICATION_WORKFLOW_V2.into(),
            protocol_fingerprint: protocol_fingerprint.into(),
            probe_fingerprint: triage_role_probe_fingerprint(),
        }
    }

    /// Exact local storage key.  It contains no raw endpoint or secret.
    pub fn storage_id(&self) -> String {
        format!(
            "{}::{}::{}::{:?}::{}::{}::{}::{}",
            self.profile_id,
            self.endpoint_fingerprint,
            self.model_id,
            self.kind,
            self.qualification_schema_id,
            self.workflow_id,
            self.protocol_fingerprint,
            self.probe_fingerprint,
        )
    }
}

/// One host-authored exact-role qualification result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TriageRoleQualificationRecordV1 {
    /// Exact identity bound by the host.
    pub key: TriageRoleQualificationKeyV1,
    /// Current result of the exact role probe.
    pub qualification: RoleQualificationV2,
    /// Number of semantic provider operations used by the probe.
    pub physical_provider_calls: u32,
    /// Number of host correction operations used by the probe.
    pub semantic_corrections: u32,
    /// Host-authored bounded reason, never provider response text.
    pub reason: String,
    /// Unix seconds when the probe completed.
    pub tested_at: i64,
}

/// Complete local role-qualification store.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TriageRoleQualificationStoreV1 {
    /// Must equal [`TRIAGE_ROLE_QUALIFICATION_STORE_SCHEMA_V1`].
    pub schema_id: String,
    /// Exact records, keyed by [`TriageRoleQualificationKeyV1::storage_id`].
    #[serde(default)]
    pub records: Vec<TriageRoleQualificationRecordV1>,
}

impl Default for TriageRoleQualificationStoreV1 {
    fn default() -> Self {
        Self {
            schema_id: TRIAGE_ROLE_QUALIFICATION_STORE_SCHEMA_V1.into(),
            records: Vec::new(),
        }
    }
}

impl TriageRoleQualificationStoreV1 {
    /// Validate the bounded, secret-free store.
    pub fn validate(&self) -> Result<(), TriageRoleQualificationError> {
        if self.schema_id != TRIAGE_ROLE_QUALIFICATION_STORE_SCHEMA_V1 {
            return Err(TriageRoleQualificationError::Schema);
        }
        if self.records.len() > MAX_TRIAGE_ROLE_QUALIFICATION_RECORDS {
            return Err(TriageRoleQualificationError::TooManyRecords);
        }
        let mut ids = std::collections::BTreeSet::new();
        for record in &self.records {
            validate_key(&record.key)?;
            if !ids.insert(record.key.storage_id()) {
                return Err(TriageRoleQualificationError::DuplicateRecord);
            }
            if record.physical_provider_calls > 8 || record.semantic_corrections > 2 {
                return Err(TriageRoleQualificationError::ProbeBounds);
            }
            if record.reason.len() > 256 || record.reason.chars().any(|c| c.is_control()) {
                return Err(TriageRoleQualificationError::Reason);
            }
        }
        let bytes = serde_json::to_vec(self).map_err(|_| TriageRoleQualificationError::Encoding)?;
        if bytes.len() > MAX_TRIAGE_ROLE_QUALIFICATION_STORE_BYTES {
            return Err(TriageRoleQualificationError::TooLarge);
        }
        Ok(())
    }

    /// Insert/replace one exact record without touching other models or roles.
    pub fn put(
        &mut self,
        record: TriageRoleQualificationRecordV1,
    ) -> Result<(), TriageRoleQualificationError> {
        validate_record(&record)?;
        if let Some(existing) = self
            .records
            .iter_mut()
            .find(|existing| existing.key.storage_id() == record.key.storage_id())
        {
            *existing = record;
        } else {
            if self.records.len() >= MAX_TRIAGE_ROLE_QUALIFICATION_RECORDS {
                return Err(TriageRoleQualificationError::TooManyRecords);
            }
            self.records.push(record);
        }
        self.validate()
    }

    /// Return the exact current record, if present.  A near miss is never
    /// returned as positive evidence; endpoint, role, protocol, and probe
    /// fingerprints must all match.
    pub fn get(
        &self,
        key: &TriageRoleQualificationKeyV1,
    ) -> Option<&TriageRoleQualificationRecordV1> {
        self.records.iter().find(|record| record.key == *key)
    }

    /// Mark a matching record stale without mutating sibling roles/models.
    pub fn mark_stale(&mut self, key: &TriageRoleQualificationKeyV1) -> bool {
        if let Some(record) = self.records.iter_mut().find(|record| {
            record.key.profile_id == key.profile_id
                && record.key.model_id == key.model_id
                && record.key.kind == key.kind
                && record.key.endpoint_fingerprint == key.endpoint_fingerprint
                && record.key.probe_fingerprint == key.probe_fingerprint
        }) {
            if record.key != *key && record.qualification == RoleQualificationV2::Qualified {
                record.qualification = RoleQualificationV2::Stale;
                record.reason = "qualification_identity_changed".into();
                return true;
            }
        }
        false
    }

    /// Load a bounded store from an explicit path.  Missing means the safe
    /// empty store; malformed data never upgrades a role.
    pub fn load(path: &Path) -> crate::error::CoreResult<Self> {
        if !path.exists() {
            return Ok(Self::default());
        }
        let metadata = std::fs::metadata(path)?;
        if !metadata.is_file()
            || metadata.len() as usize > MAX_TRIAGE_ROLE_QUALIFICATION_STORE_BYTES
        {
            return Err(crate::error::CoreError::Config(
                "triage role qualification store is not bounded".into(),
            ));
        }
        let store: Self = serde_json::from_slice(&std::fs::read(path)?).map_err(|_| {
            crate::error::CoreError::Config("triage role qualification store is malformed".into())
        })?;
        store.validate().map_err(|error| {
            crate::error::CoreError::Config(format!(
                "triage role qualification store rejected: {error}"
            ))
        })?;
        Ok(store)
    }

    /// Atomically publish a validated store.
    pub fn save(&self, path: &Path) -> crate::error::CoreResult<()> {
        self.validate().map_err(|error| {
            crate::error::CoreError::Config(format!(
                "triage role qualification store rejected: {error}"
            ))
        })?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(self)?)?;
        std::fs::rename(tmp, path)?;
        Ok(())
    }
}

/// Locate the role store next to the existing qualification evidence.
pub fn triage_role_qualification_store_path(config_dir: &Path) -> PathBuf {
    config_dir.join("triage-role-qualifications.json")
}

/// Stable fingerprint of the exact probe prompt/validator contract.
pub fn triage_role_probe_fingerprint() -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(TRIAGE_ROLE_QUALIFICATION_PROBE_SCHEMA_V1.as_bytes());
    format!("sha256:{digest:x}")
}

fn validate_record(
    record: &TriageRoleQualificationRecordV1,
) -> Result<(), TriageRoleQualificationError> {
    validate_key(&record.key)?;
    if record.physical_provider_calls > 8 || record.semantic_corrections > 2 {
        return Err(TriageRoleQualificationError::ProbeBounds);
    }
    if record.reason.len() > 256 || record.reason.chars().any(|c| c.is_control()) {
        return Err(TriageRoleQualificationError::Reason);
    }
    Ok(())
}

fn validate_key(key: &TriageRoleQualificationKeyV1) -> Result<(), TriageRoleQualificationError> {
    if key.profile_id.trim().is_empty() || key.profile_id.len() > 128 {
        return Err(TriageRoleQualificationError::Identity);
    }
    if key.model_id.trim().is_empty() || key.model_id.len() > 512 {
        return Err(TriageRoleQualificationError::Identity);
    }
    if key.qualification_schema_id != TRIAGE_QUALIFICATION_SCHEMA_V2
        || key.workflow_id != TRIAGE_QUALIFICATION_WORKFLOW_V2
        || !valid_digest(&key.endpoint_fingerprint)
        || !valid_digest(&key.protocol_fingerprint)
        || !valid_digest(&key.probe_fingerprint)
    {
        return Err(TriageRoleQualificationError::Identity);
    }
    Ok(())
}

fn valid_digest(value: &str) -> bool {
    let Some(hex) = value.strip_prefix("sha256:") else {
        return false;
    };
    hex.len() == 64 && hex.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// Structural errors for the role-qualification store.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum TriageRoleQualificationError {
    /// Store schema id was not the current version.
    #[error("unsupported role qualification store schema")]
    Schema,
    /// Store exceeded its record bound.
    #[error("too many role qualification records")]
    TooManyRecords,
    /// Two records share an exact identity.
    #[error("duplicate role qualification record")]
    DuplicateRecord,
    /// A profile/model/endpoint/protocol identity was malformed.
    #[error("invalid role qualification identity")]
    Identity,
    /// Probe physical-call or correction bounds were exceeded.
    #[error("invalid role qualification probe bounds")]
    ProbeBounds,
    /// The host-authored reason was malformed or too large.
    #[error("invalid role qualification reason")]
    Reason,
    /// The serialized store exceeded its byte bound.
    #[error("role qualification store is too large")]
    TooLarge,
    /// The store could not be serialized.
    #[error("role qualification store encoding failed")]
    Encoding,
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn key(model: &str) -> TriageRoleQualificationKeyV1 {
        TriageRoleQualificationKeyV1::current(
            "profile",
            "https://gateway.invalid/v1",
            model,
            TriageSlotKindV2::Finalizer,
            format!("sha256:{:064x}", 1),
        )
    }

    fn record(model: &str) -> TriageRoleQualificationRecordV1 {
        TriageRoleQualificationRecordV1 {
            key: key(model),
            qualification: RoleQualificationV2::Qualified,
            physical_provider_calls: 1,
            semantic_corrections: 0,
            reason: "synthetic probe passed".into(),
            tested_at: 1,
        }
    }

    #[test]
    fn exact_identity_is_required_and_siblings_are_isolated() {
        let mut store = TriageRoleQualificationStoreV1::default();
        store.put(record("model-a")).unwrap();
        assert!(store.get(&key("model-a")).is_some());
        assert!(store.get(&key("model-b")).is_none());
        let mut different_role = key("model-a");
        different_role.kind = TriageSlotKindV2::Reviewer;
        assert!(store.get(&different_role).is_none());
    }

    #[test]
    fn malformed_digest_and_duplicate_records_fail_closed() {
        let mut bad = record("model-a");
        bad.key.protocol_fingerprint = "sha256:not-hex".into();
        assert_eq!(
            TriageRoleQualificationStoreV1::default().put(bad),
            Err(TriageRoleQualificationError::Identity)
        );
        let mut store = TriageRoleQualificationStoreV1::default();
        store.put(record("model-a")).unwrap();
        assert_eq!(store.put(record("model-a")), Ok(()));
        assert_eq!(store.records.len(), 1);
    }

    #[test]
    fn save_and_load_is_bounded_and_atomic() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("triage-role-qualifications.json");
        let mut store = TriageRoleQualificationStoreV1::default();
        store.put(record("model-a")).unwrap();
        store.save(&path).unwrap();
        assert_eq!(TriageRoleQualificationStoreV1::load(&path).unwrap(), store);
    }
}
