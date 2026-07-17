//! Secret storage: OS keychain with in-memory backend for tests.

use crate::branding::DEFAULT_SLUG;
use crate::error::{CoreError, CoreResult};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// Abstraction over secret storage (never exposed to webview).
pub trait SecretStore: Send + Sync {
    /// Store a secret under `ref_id`.
    fn set(&self, ref_id: &str, secret: &str) -> CoreResult<()>;
    /// Load secret; Ok(None) if missing.
    fn get(&self, ref_id: &str) -> CoreResult<Option<String>>;
    /// Delete secret.
    fn delete(&self, ref_id: &str) -> CoreResult<()>;
    /// True if a non-empty secret exists.
    fn has(&self, ref_id: &str) -> CoreResult<bool> {
        Ok(self.get(ref_id)?.map(|s| !s.is_empty()).unwrap_or(false))
    }
}

/// In-memory store for unit tests and CI.
#[derive(Debug, Default, Clone)]
pub struct MemorySecretStore {
    inner: Arc<Mutex<HashMap<String, String>>>,
}

impl MemorySecretStore {
    /// Empty store.
    pub fn new() -> Self {
        Self::default()
    }
}

impl SecretStore for MemorySecretStore {
    fn set(&self, ref_id: &str, secret: &str) -> CoreResult<()> {
        self.inner
            .lock()
            .map_err(|_| CoreError::Message("secret lock poisoned".into()))?
            .insert(ref_id.to_string(), secret.to_string());
        Ok(())
    }

    fn get(&self, ref_id: &str) -> CoreResult<Option<String>> {
        Ok(self
            .inner
            .lock()
            .map_err(|_| CoreError::Message("secret lock poisoned".into()))?
            .get(ref_id)
            .cloned())
    }

    fn delete(&self, ref_id: &str) -> CoreResult<()> {
        self.inner
            .lock()
            .map_err(|_| CoreError::Message("secret lock poisoned".into()))?
            .remove(ref_id);
        Ok(())
    }
}

/// OS keychain service name from product slug (`{slug}-secrets`).
/// Documented for agents and packaging; must stay rename-friendly via branding slug.
pub fn keychain_service_name(slug: &str) -> String {
    format!("{slug}-secrets")
}

/// True if a string looks like a raw API key rather than a keychain ref id.
/// Used to refuse writing secrets into `api_key_ref` fields on disk / IPC.
pub fn looks_like_raw_secret(value: &str) -> bool {
    let v = value.trim();
    if v.is_empty() {
        return false;
    }
    // Keychain refs use path-like ids: `provider/{id}/api_key`
    if v.contains('/') && !v.starts_with("sk-") && !v.starts_with("xai-") {
        return false;
    }
    v.starts_with("sk-")
        || v.starts_with("xai-")
        || v.starts_with("ghp_")
        || v.starts_with("gho_")
        || (v.len() >= 32 && !v.contains('/') && !v.contains('.'))
}

/// OS keychain-backed store. Service name derived from product slug.
pub struct KeychainSecretStore {
    service: String,
}

impl KeychainSecretStore {
    /// Use default ContextDesk service name.
    pub fn new() -> Self {
        Self::with_service(keychain_service_name(DEFAULT_SLUG))
    }

    /// Custom service name (tests / branding).
    pub fn with_service(service: impl Into<String>) -> Self {
        Self {
            service: service.into(),
        }
    }

    /// Service name used for OS keychain entries.
    pub fn service_name(&self) -> &str {
        &self.service
    }
}

impl Default for KeychainSecretStore {
    fn default() -> Self {
        Self::new()
    }
}

impl SecretStore for KeychainSecretStore {
    fn set(&self, ref_id: &str, secret: &str) -> CoreResult<()> {
        let entry = keyring::Entry::new(&self.service, ref_id)
            .map_err(|e| CoreError::Message(format!("keychain: {e}")))?;
        entry
            .set_password(secret)
            .map_err(|e| CoreError::Message(format!("keychain set: {e}")))
    }

    fn get(&self, ref_id: &str) -> CoreResult<Option<String>> {
        let entry = keyring::Entry::new(&self.service, ref_id)
            .map_err(|e| CoreError::Message(format!("keychain: {e}")))?;
        match entry.get_password() {
            Ok(p) => Ok(Some(p)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(CoreError::Message(format!("keychain get: {e}"))),
        }
    }

    fn delete(&self, ref_id: &str) -> CoreResult<()> {
        let entry = keyring::Entry::new(&self.service, ref_id)
            .map_err(|e| CoreError::Message(format!("keychain: {e}")))?;
        match entry.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(CoreError::Message(format!("keychain delete: {e}"))),
        }
    }
}

/// Build a keychain ref id for a profile (no secret material).
pub fn key_ref_for_profile(profile_id: &str) -> String {
    format!("provider/{profile_id}/api_key")
}

/// Keychain ref for Confluence PAT (same constant as config).
pub fn key_ref_confluence_pat() -> String {
    crate::config::CONFLUENCE_PAT_REF.to_string()
}

/// Keychain ref for X API bearer token (same constant as config).
pub fn key_ref_x_api_key() -> String {
    crate::config::X_API_KEY_REF.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_roundtrip() {
        let s = MemorySecretStore::new();
        s.set("a", "secret-value").unwrap();
        assert_eq!(s.get("a").unwrap().as_deref(), Some("secret-value"));
        assert!(s.has("a").unwrap());
        s.delete("a").unwrap();
        assert!(!s.has("a").unwrap());
    }

    #[test]
    fn key_ref_stable() {
        assert_eq!(key_ref_for_profile("work"), "provider/work/api_key");
    }

    #[test]
    fn service_name_from_slug() {
        assert_eq!(keychain_service_name("contextdesk"), "contextdesk-secrets");
        assert_eq!(keychain_service_name("acme-desk"), "acme-desk-secrets");
        assert_eq!(
            KeychainSecretStore::new().service_name(),
            "contextdesk-secrets"
        );
    }

    #[test]
    fn raw_secret_heuristic() {
        assert!(looks_like_raw_secret("sk-proj-abc123def456"));
        assert!(looks_like_raw_secret("xai-aaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
        assert!(!looks_like_raw_secret("provider/work/api_key"));
        assert!(!looks_like_raw_secret(&key_ref_confluence_pat()));
        assert!(!looks_like_raw_secret(""));
    }
}
