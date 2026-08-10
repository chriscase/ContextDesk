//! Secret storage: explicit protected-file references, OS keychain, and an
//! in-memory backend for tests.

use crate::branding::DEFAULT_SLUG;
use crate::error::{CoreError, CoreResult};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// Prefix for a profile that reads a protected file directly instead of
/// consulting the OS keychain. The suffix is an absolute native path.
pub const FILE_SECRET_REF_PREFIX: &str = "file:";

/// Credential files are deliberately tiny. A larger file is almost certainly
/// a mistaken path and must never be sent to a provider as a bearer value.
const MAX_FILE_SECRET_BYTES: u64 = 64 * 1024;

fn file_secret_path(ref_id: &str) -> Option<PathBuf> {
    ref_id
        .strip_prefix(FILE_SECRET_REF_PREFIX)
        .map(PathBuf::from)
}

fn validate_file_secret_path(path: &Path) -> CoreResult<std::fs::Metadata> {
    if !path.is_absolute() {
        return Err(CoreError::Config(
            "file-backed credential path must be absolute".into(),
        ));
    }
    let metadata = std::fs::symlink_metadata(path).map_err(|error| {
        CoreError::Config(format!("read protected credential file metadata: {error}"))
    })?;
    if metadata.file_type().is_symlink() {
        return Err(CoreError::Config(
            "protected credential file must not be a symbolic link".into(),
        ));
    }
    if !metadata.is_file() {
        return Err(CoreError::Config(
            "protected credential path must name a regular file".into(),
        ));
    }
    if metadata.len() == 0 || metadata.len() > MAX_FILE_SECRET_BYTES {
        return Err(CoreError::Config(format!(
            "protected credential file must contain 1..={MAX_FILE_SECRET_BYTES} bytes"
        )));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.mode() & 0o077 != 0 {
            return Err(CoreError::Config(
                "protected credential file permissions must deny group and other access (use mode 600)"
                    .into(),
            ));
        }
        // SAFETY: geteuid has no preconditions and does not retain a pointer.
        let effective_uid = unsafe { libc::geteuid() };
        if metadata.uid() != effective_uid {
            return Err(CoreError::Config(
                "protected credential file must be owned by the current user".into(),
            ));
        }
    }
    Ok(metadata)
}

/// Validate an existing protected file and return the reference persisted in
/// a profile. The secret bytes are never included in the reference.
pub fn file_secret_ref(path: &Path) -> CoreResult<String> {
    validate_file_secret_path(path)?;
    Ok(format!("{FILE_SECRET_REF_PREFIX}{}", path.display()))
}

/// Resolve one protected-file reference. Non-file references return `None`
/// so a caller can route them to its explicitly selected secret backend.
pub fn read_file_secret_ref(ref_id: &str) -> CoreResult<Option<String>> {
    let Some(path) = file_secret_path(ref_id) else {
        return Ok(None);
    };
    validate_file_secret_path(&path)?;
    let raw = std::fs::read_to_string(&path)
        .map_err(|error| CoreError::Config(format!("read protected credential file: {error}")))?;
    let value = raw.trim();
    if value.is_empty() {
        return Err(CoreError::Config(
            "protected credential file contains no credential".into(),
        ));
    }
    if value.contains('\0') {
        return Err(CoreError::Config(
            "protected credential file contains an invalid NUL byte".into(),
        ));
    }
    Ok(Some(value.to_string()))
}

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

/// Runtime store for user-facing hosts. A `file:` reference is resolved only
/// from that exact protected file; every other reference is an explicit legacy
/// or `keychain` profile reference and is routed to the OS keychain. A missing
/// or unsafe file never falls back to Keychain, which prevents surprise macOS
/// authorization dialogs during source tests and evaluations.
pub struct ReferencedSecretStore {
    keychain: KeychainSecretStore,
}

impl ReferencedSecretStore {
    /// Use the default ContextDesk keychain for explicitly keychain-backed
    /// references while enabling protected-file references.
    pub fn new() -> Self {
        Self {
            keychain: KeychainSecretStore::new(),
        }
    }

    /// Keychain service name used for non-file references.
    pub fn service_name(&self) -> &str {
        self.keychain.service_name()
    }
}

impl Default for ReferencedSecretStore {
    fn default() -> Self {
        Self::new()
    }
}

impl SecretStore for ReferencedSecretStore {
    fn get(&self, ref_id: &str) -> CoreResult<Option<String>> {
        if ref_id.starts_with(FILE_SECRET_REF_PREFIX) {
            return read_file_secret_ref(ref_id);
        }
        self.keychain.get(ref_id)
    }

    fn set(&self, ref_id: &str, secret: &str) -> CoreResult<()> {
        if ref_id.starts_with(FILE_SECRET_REF_PREFIX) {
            return Err(CoreError::Config(
                "file-backed credentials are read-only; update the protected file directly".into(),
            ));
        }
        self.keychain.set(ref_id, secret)
    }

    fn delete(&self, ref_id: &str) -> CoreResult<()> {
        if ref_id.starts_with(FILE_SECRET_REF_PREFIX) {
            return Err(CoreError::Config(
                "file-backed credentials are not deleted by ContextDesk".into(),
            ));
        }
        self.keychain.delete(ref_id)
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

    #[cfg(unix)]
    fn write_protected_file(path: &Path, body: &str, mode: u32) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::write(path, body).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn protected_file_reference_reads_trimmed_value_without_keychain() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("provider.key");
        write_protected_file(&path, "  synthetic-value\n", 0o600);
        let reference = file_secret_ref(&path).unwrap();
        assert_eq!(reference, format!("file:{}", path.display()));
        assert_eq!(
            read_file_secret_ref(&reference).unwrap().as_deref(),
            Some("synthetic-value")
        );
        let store = ReferencedSecretStore::new();
        assert_eq!(
            store.get(&reference).unwrap().as_deref(),
            Some("synthetic-value")
        );
    }

    #[cfg(unix)]
    #[test]
    fn protected_file_reference_rejects_unsafe_permissions_without_fallback() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("provider.key");
        write_protected_file(&path, "synthetic-value", 0o644);
        let reference = format!("file:{}", path.display());
        let error = read_file_secret_ref(&reference).unwrap_err().to_string();
        assert!(error.contains("permissions"));
    }

    #[cfg(unix)]
    #[test]
    fn protected_file_reference_rejects_symlinks() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("target.key");
        let link = dir.path().join("provider.key");
        write_protected_file(&target, "synthetic-value", 0o600);
        symlink(&target, &link).unwrap();
        let error = file_secret_ref(&link).unwrap_err().to_string();
        assert!(error.contains("symbolic link"));
    }
}
