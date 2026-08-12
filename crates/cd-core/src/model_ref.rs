//! Exact gateway-scoped model identity.
//!
//! A model reference proves identity only. Protocol, workflow, role,
//! qualification, cost, and quality evidence are deliberately separate.

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Exact provider-profile and catalog-model identity.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelRef {
    /// Host-owned provider profile identity.
    pub profile_id: String,
    /// Exact catalog model identity returned by discovery.
    pub model_id: String,
}

impl ModelRef {
    /// Validate that both identities are non-empty, opaque, and content-free.
    pub fn validate(&self) -> Result<(), ModelRefError> {
        validate_opaque("profile_id", &self.profile_id)?;
        validate_opaque("model_id", &self.model_id)
    }
}

fn validate_opaque(field: &'static str, value: &str) -> Result<(), ModelRefError> {
    if value.trim().is_empty()
        || value.contains('/')
        || value.contains('\\')
        || value.contains("://")
        || value.chars().any(char::is_control)
    {
        Err(ModelRefError::InvalidField(field))
    } else {
        Ok(())
    }
}

/// Invalid exact model-reference identity.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ModelRefError {
    /// The named field is empty or contains path/URL/control material.
    #[error("invalid model reference field `{0}`")]
    InvalidField(&'static str),
}
