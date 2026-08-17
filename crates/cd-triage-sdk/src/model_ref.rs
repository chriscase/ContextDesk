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
    /// Validate content-free identities while preserving namespaced catalog ids.
    pub fn validate(&self) -> Result<(), ModelRefError> {
        validate_profile_id(&self.profile_id)?;
        validate_model_id(&self.model_id)
    }
}

fn validate_profile_id(value: &str) -> Result<(), ModelRefError> {
    if value.trim().is_empty()
        || value.len() > 256
        || value.contains('/')
        || value.contains('\\')
        || value.contains("://")
        || value.chars().any(char::is_control)
    {
        Err(ModelRefError::InvalidField("profile_id"))
    } else {
        Ok(())
    }
}

fn validate_model_id(value: &str) -> Result<(), ModelRefError> {
    // Catalog ids commonly contain `/` (`openai/gpt-oss-120b`). They are
    // exact provider values, not filesystem paths, so preserve them verbatim.
    if value.trim().is_empty()
        || value.len() > 512
        || value.contains('\\')
        || value.contains("://")
        || value.chars().any(char::is_control)
    {
        Err(ModelRefError::InvalidField("model_id"))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_catalog_ids_preserve_provider_namespaces_and_labels() {
        for model_id in [
            "openai/gpt-oss-120b",
            "deepseek-v4-flash",
            "Mistral-Small-24B-Instruct-2501-FP8-dynamic",
            "qwen3-reranker-0.6b",
        ] {
            ModelRef {
                profile_id: "profile:employer".into(),
                model_id: model_id.into(),
            }
            .validate()
            .unwrap_or_else(|error| panic!("{model_id}: {error}"));
        }
    }

    #[test]
    fn empty_control_url_and_windows_path_shapes_fail_closed() {
        for model_id in ["", "bad\nmodel", "https://gateway/model", "org\\model"] {
            assert_eq!(
                ModelRef {
                    profile_id: "profile:primary".into(),
                    model_id: model_id.into(),
                }
                .validate(),
                Err(ModelRefError::InvalidField("model_id"))
            );
        }
    }
}
