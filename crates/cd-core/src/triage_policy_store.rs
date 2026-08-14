//! Revisioned, non-secret storage for opt-in Triage Policy V2 documents.
//!
//! The store is deliberately separate from [`crate::config::AppConfig`]. A
//! missing or unreadable policy store therefore cannot change the established
//! Standard path. Hosts choose the path, perform any user confirmation, and
//! may later resolve the stored policy through the normal exact preflight
//! compiler before executing it.

use std::path::Path;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::multi_model::triage_policy::{TriagePolicyV2, TRIAGE_POLICY_SCHEMA_V2};

/// Stable schema identifier for the on-disk policy store.
pub const TRIAGE_POLICY_STORE_SCHEMA_V1: &str = "contextdesk.triage_policy_store.v1";
/// Maximum serialized store size accepted by this bounded host file.
pub const MAX_TRIAGE_POLICY_STORE_BYTES: usize = 2 * 1024 * 1024;
/// Maximum saved policies in one store.
pub const MAX_SAVED_TRIAGE_POLICIES: usize = 64;

/// One revisioned, non-secret saved policy.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SavedTriagePolicyV1 {
    /// Stable host-authored policy identity.
    pub policy_id: String,
    /// Monotonically increasing revision for this policy identity.
    pub revision: u64,
    /// The provider-neutral policy document. It contains model identities, not
    /// credentials or endpoint URLs.
    pub policy: TriagePolicyV2,
}

/// The complete local policy store.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TriagePolicyStoreV1 {
    /// Must equal [`TRIAGE_POLICY_STORE_SCHEMA_V1`].
    pub schema_id: String,
    /// Explicitly selected policy. `None` preserves Standard behavior.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_policy_id: Option<String>,
    /// Saved policy revisions, retained for explicit rollback/audit.
    #[serde(default)]
    pub policies: Vec<SavedTriagePolicyV1>,
}

impl Default for TriagePolicyStoreV1 {
    fn default() -> Self {
        Self {
            schema_id: TRIAGE_POLICY_STORE_SCHEMA_V1.into(),
            active_policy_id: None,
            policies: Vec::new(),
        }
    }
}

impl TriagePolicyStoreV1 {
    /// Validate structure and bounds without compiling or contacting a model.
    pub fn validate(&self) -> Result<(), TriagePolicyStoreError> {
        if self.schema_id != TRIAGE_POLICY_STORE_SCHEMA_V1 {
            return Err(TriagePolicyStoreError::Schema);
        }
        if self.policies.len() > MAX_SAVED_TRIAGE_POLICIES {
            return Err(TriagePolicyStoreError::TooManyPolicies);
        }
        let mut ids = std::collections::BTreeSet::new();
        for saved in &self.policies {
            validate_policy_id(&saved.policy_id)?;
            if saved.revision == 0 || !ids.insert(saved.policy_id.as_str()) {
                return Err(TriagePolicyStoreError::DuplicateOrInvalidRevision);
            }
            if saved.policy.schema_id != TRIAGE_POLICY_SCHEMA_V2 {
                return Err(TriagePolicyStoreError::PolicySchema);
            }
            let encoded = serde_json::to_vec(&saved.policy)
                .map_err(|_| TriagePolicyStoreError::Serialization)?;
            if encoded.len() > MAX_TRIAGE_POLICY_STORE_BYTES {
                return Err(TriagePolicyStoreError::TooLarge);
            }
        }
        if let Some(active) = &self.active_policy_id {
            validate_policy_id(active)?;
            if !self.policies.iter().any(|saved| &saved.policy_id == active) {
                return Err(TriagePolicyStoreError::UnknownActivePolicy);
            }
        }
        let encoded =
            serde_json::to_vec(self).map_err(|_| TriagePolicyStoreError::Serialization)?;
        if encoded.len() > MAX_TRIAGE_POLICY_STORE_BYTES {
            return Err(TriagePolicyStoreError::TooLarge);
        }
        Ok(())
    }

    /// Return the selected policy, if the host has explicitly selected one.
    pub fn active(&self) -> Option<&SavedTriagePolicyV1> {
        self.active_policy_id
            .as_ref()
            .and_then(|id| self.policies.iter().find(|saved| &saved.policy_id == id))
    }

    /// Insert or replace a policy and select it, returning its new revision.
    pub fn upsert(
        &mut self,
        policy_id: impl Into<String>,
        policy: TriagePolicyV2,
    ) -> Result<u64, TriagePolicyStoreError> {
        let policy_id = policy_id.into();
        validate_policy_id(&policy_id)?;
        if policy.schema_id != TRIAGE_POLICY_SCHEMA_V2 {
            return Err(TriagePolicyStoreError::PolicySchema);
        }
        let revision = self
            .policies
            .iter()
            .find(|saved| saved.policy_id == policy_id)
            .map_or(1, |saved| saved.revision.saturating_add(1));
        if let Some(saved) = self
            .policies
            .iter_mut()
            .find(|saved| saved.policy_id == policy_id)
        {
            saved.revision = revision;
            saved.policy = policy;
        } else {
            if self.policies.len() >= MAX_SAVED_TRIAGE_POLICIES {
                return Err(TriagePolicyStoreError::TooManyPolicies);
            }
            self.policies.push(SavedTriagePolicyV1 {
                policy_id: policy_id.clone(),
                revision,
                policy,
            });
        }
        self.active_policy_id = Some(policy_id);
        self.validate()?;
        Ok(revision)
    }

    /// Explicitly select an already saved policy without rewriting its body.
    pub fn select(&mut self, policy_id: &str) -> Result<(), TriagePolicyStoreError> {
        validate_policy_id(policy_id)?;
        if !self
            .policies
            .iter()
            .any(|saved| saved.policy_id == policy_id)
        {
            return Err(TriagePolicyStoreError::UnknownActivePolicy);
        }
        self.active_policy_id = Some(policy_id.to_string());
        Ok(())
    }

    /// Clear the opt-in selection. Saved policy revisions remain available for
    /// later explicit selection, while the host returns to Standard mode.
    pub fn clear_selection(&mut self) {
        self.active_policy_id = None;
    }

    /// Load a store from an explicit path. An absent file is the safe default.
    pub fn load(path: &Path) -> crate::error::CoreResult<Self> {
        if !path.exists() {
            return Ok(Self::default());
        }
        let metadata = std::fs::metadata(path)?;
        if !metadata.is_file() || metadata.len() as usize > MAX_TRIAGE_POLICY_STORE_BYTES {
            return Err(crate::error::CoreError::Config(
                "triage policy store is not a bounded regular file".into(),
            ));
        }
        let raw = std::fs::read(path)?;
        let store: Self = serde_json::from_slice(&raw).map_err(|_| {
            crate::error::CoreError::Config("triage policy store is malformed".into())
        })?;
        store.validate().map_err(|error| {
            crate::error::CoreError::Config(format!("triage policy store rejected: {error}"))
        })?;
        Ok(store)
    }

    /// Atomically publish a validated store to an explicit path.
    pub fn save(&self, path: &Path) -> crate::error::CoreResult<()> {
        self.validate().map_err(|error| {
            crate::error::CoreError::Config(format!("triage policy store rejected: {error}"))
        })?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let raw = serde_json::to_vec_pretty(self)?;
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, raw)?;
        std::fs::rename(tmp, path)?;
        Ok(())
    }
}

fn validate_policy_id(value: &str) -> Result<(), TriagePolicyStoreError> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
    {
        Err(TriagePolicyStoreError::PolicyId)
    } else {
        Ok(())
    }
}

/// Structural errors for the policy store. They contain no paths or secrets.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum TriagePolicyStoreError {
    /// Store schema is not the supported version.
    #[error("unsupported policy store schema")]
    Schema,
    /// A policy identity is malformed.
    #[error("invalid policy id")]
    PolicyId,
    /// A revision is zero or a policy id is duplicated.
    #[error("duplicate policy id or invalid revision")]
    DuplicateOrInvalidRevision,
    /// A selected policy is absent.
    #[error("active policy is not saved")]
    UnknownActivePolicy,
    /// A nested policy has the wrong schema.
    #[error("nested policy has the wrong schema")]
    PolicySchema,
    /// The store exceeds the count bound.
    #[error("too many saved policies")]
    TooManyPolicies,
    /// The serialized store exceeds the byte bound.
    #[error("policy store is too large")]
    TooLarge,
    /// A bounded store could not be serialized.
    #[error("policy store serialization failed")]
    Serialization,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model_ref::ModelRef;

    fn standard() -> TriagePolicyV2 {
        TriagePolicyV2::standard(
            ModelRef {
                profile_id: "profile-a".into(),
                model_id: "model-a".into(),
            },
            false,
        )
    }

    fn path(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "contextdesk-policy-store-{name}-{}",
            std::process::id()
        ))
    }

    #[test]
    fn absent_store_is_standard_safe_default() {
        let store = TriagePolicyStoreV1::default();
        assert!(store.active().is_none());
        store.validate().unwrap();
    }

    #[test]
    fn upsert_select_and_clear_are_revisioned_and_explicit() {
        let mut store = TriagePolicyStoreV1::default();
        assert_eq!(store.upsert("policy-a", standard()).unwrap(), 1);
        assert_eq!(store.active().unwrap().revision, 1);
        assert_eq!(store.upsert("policy-a", standard()).unwrap(), 2);
        store.clear_selection();
        assert!(store.active().is_none());
        store.select("policy-a").unwrap();
        assert_eq!(store.active().unwrap().revision, 2);
    }

    #[test]
    fn save_and_load_are_atomic_and_round_trip_without_secrets() {
        let path = path("roundtrip");
        let mut store = TriagePolicyStoreV1::default();
        store.upsert("policy-a", standard()).unwrap();
        store.save(&path).unwrap();
        let loaded = TriagePolicyStoreV1::load(&path).unwrap();
        assert_eq!(loaded, store);
        let encoded = std::fs::read_to_string(&path).unwrap();
        assert!(!encoded.contains("api_key"));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn unknown_or_duplicate_selection_fails_closed() {
        let mut store = TriagePolicyStoreV1::default();
        assert_eq!(
            store.select("missing"),
            Err(TriagePolicyStoreError::UnknownActivePolicy)
        );
        store.upsert("policy-a", standard()).unwrap();
        store.active_policy_id = Some("missing".into());
        assert_eq!(
            store.validate(),
            Err(TriagePolicyStoreError::UnknownActivePolicy)
        );
    }

    #[test]
    fn unknown_fields_are_rejected_on_load() {
        let path = path("unknown");
        std::fs::write(
            &path,
            r#"{"schema_id":"contextdesk.triage_policy_store.v1","policies":[],"extra":true}"#,
        )
        .unwrap();
        assert!(TriagePolicyStoreV1::load(&path).is_err());
        let _ = std::fs::remove_file(path);
    }
}
