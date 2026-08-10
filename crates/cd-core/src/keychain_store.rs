//! Secret storage: explicit protected-file references, OS keychain, and an
//! in-memory backend for tests.

use crate::branding::DEFAULT_SLUG;
use crate::error::{CoreError, CoreResult};
use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::Read;
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

fn require_absolute_file_secret_path(path: &Path) -> CoreResult<()> {
    if path.is_absolute() {
        Ok(())
    } else {
        Err(CoreError::Config(
            "file-backed credential path must be absolute".into(),
        ))
    }
}

fn validate_file_secret_metadata(metadata: &std::fs::Metadata) -> CoreResult<()> {
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
    Ok(())
}

/// Open a protected credential file without following a final-path symlink,
/// then re-validate metadata on the open descriptor so a race cannot swap in
/// a world-readable or linked target after the path check.
fn open_protected_credential_file(path: &Path) -> CoreResult<File> {
    require_absolute_file_secret_path(path)?;
    // Fail closed on an already-linked final path before open (clearer error).
    let before = std::fs::symlink_metadata(path).map_err(|error| {
        CoreError::Config(format!("read protected credential file metadata: {error}"))
    })?;
    validate_file_secret_metadata(&before)?;

    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    let file = options
        .open(path)
        .map_err(|error| CoreError::Config(format!("read protected credential file: {error}")))?;
    let metadata = file.metadata().map_err(|error| {
        CoreError::Config(format!("read protected credential file metadata: {error}"))
    })?;
    validate_file_secret_metadata(&metadata)?;
    Ok(file)
}

fn credential_value_from_bytes(raw: &[u8]) -> CoreResult<String> {
    let text = std::str::from_utf8(raw)
        .map_err(|_| CoreError::Config("protected credential file must be valid UTF-8".into()))?;
    let value = text.trim();
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
    Ok(value.to_string())
}

fn read_protected_credential_file(path: &Path) -> CoreResult<String> {
    let mut file = open_protected_credential_file(path)?;
    // Bound the read from the open fd so a post-open size change cannot force
    // an unbounded allocation. One extra byte proves "too large".
    let mut buf = Vec::new();
    file.by_ref()
        .take(MAX_FILE_SECRET_BYTES.saturating_add(1))
        .read_to_end(&mut buf)
        .map_err(|error| CoreError::Config(format!("read protected credential file: {error}")))?;
    if buf.len() as u64 > MAX_FILE_SECRET_BYTES {
        return Err(CoreError::Config(format!(
            "protected credential file must contain 1..={MAX_FILE_SECRET_BYTES} bytes"
        )));
    }
    credential_value_from_bytes(&buf)
}

/// Validate an existing protected file and return the reference persisted in
/// a profile. The secret bytes are never included in the reference.
pub fn file_secret_ref(path: &Path) -> CoreResult<String> {
    // Open + fstat so Save cannot succeed against a path that only looked safe
    // at the first metadata snapshot.
    let _ = open_protected_credential_file(path)?;
    Ok(format!("{FILE_SECRET_REF_PREFIX}{}", path.display()))
}

/// Resolve one protected-file reference. Non-file references return `None`
/// so a caller can route them to its explicitly selected secret backend.
pub fn read_file_secret_ref(ref_id: &str) -> CoreResult<Option<String>> {
    let Some(path) = file_secret_path(ref_id) else {
        return Ok(None);
    };
    Ok(Some(read_protected_credential_file(&path)?))
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
    fn write_protected_file(path: &Path, body: impl AsRef<[u8]>, mode: u32) {
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
        assert!(
            !error.contains("synthetic-value"),
            "error text must never echo the credential body"
        );
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
        assert!(!error.contains("synthetic-value"));
    }

    #[cfg(unix)]
    #[test]
    fn protected_file_rejects_relative_path_empty_nul_directory_and_oversized() {
        let dir = tempfile::tempdir().unwrap();

        let relative = PathBuf::from("relative.key");
        let err = file_secret_ref(&relative).unwrap_err().to_string();
        assert!(err.contains("absolute"), "{err}");

        let empty = dir.path().join("empty.key");
        write_protected_file(&empty, "", 0o600);
        let err = file_secret_ref(&empty).unwrap_err().to_string();
        assert!(err.contains("1..="), "{err}");

        let whitespace = dir.path().join("blank.key");
        write_protected_file(&whitespace, "   \n\t  \n", 0o600);
        let err = read_file_secret_ref(&format!("file:{}", whitespace.display()))
            .unwrap_err()
            .to_string();
        assert!(err.contains("no credential"), "{err}");

        let nul = dir.path().join("nul.key");
        write_protected_file(&nul, b"abc\0def", 0o600);
        let err = read_file_secret_ref(&format!("file:{}", nul.display()))
            .unwrap_err()
            .to_string();
        assert!(err.contains("NUL"), "{err}");
        assert!(!err.contains("abc"));
        assert!(!err.contains("def"));

        let nested = dir.path().join("nested");
        std::fs::create_dir(&nested).unwrap();
        let err = file_secret_ref(&nested).unwrap_err().to_string();
        assert!(err.contains("regular file"), "{err}");

        let huge = dir.path().join("huge.key");
        write_protected_file(&huge, vec![b'a'; MAX_FILE_SECRET_BYTES as usize + 1], 0o600);
        let err = file_secret_ref(&huge).unwrap_err().to_string();
        assert!(err.contains("1..="), "{err}");
    }

    /// Exact upper bound is inclusive (`1..=MAX`). A `>`→`>=` mutant on the
    /// length check rejects a legal MAX-byte credential file.
    #[cfg(unix)]
    #[test]
    fn protected_file_accepts_exactly_max_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("max.key");
        let body = vec![b'x'; MAX_FILE_SECRET_BYTES as usize];
        write_protected_file(&path, &body, 0o600);
        let reference = file_secret_ref(&path).expect("MAX-byte file must be admitted");
        let got = read_file_secret_ref(&reference)
            .expect("read MAX-byte secret")
            .expect("present");
        assert_eq!(got.len(), MAX_FILE_SECRET_BYTES as usize);
        assert!(got.chars().all(|c| c == 'x'));
    }

    #[cfg(unix)]
    #[test]
    fn protected_file_accepts_unicode_path_and_hard_link_to_same_inode() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cred-密钥.key");
        write_protected_file(&path, "unicode-path-secret\n", 0o600);
        let reference = file_secret_ref(&path).unwrap();
        assert_eq!(
            read_file_secret_ref(&reference).unwrap().as_deref(),
            Some("unicode-path-secret")
        );

        let hard = dir.path().join("hardlink.key");
        std::fs::hard_link(&path, &hard).unwrap();
        // Hard links share the inode and mode; they are regular files, not
        // symlinks. Accepting them is intentional (still owned + mode 600).
        assert_eq!(
            read_file_secret_ref(&format!("file:{}", hard.display()))
                .unwrap()
                .as_deref(),
            Some("unicode-path-secret")
        );
    }

    #[cfg(unix)]
    #[test]
    fn unsafe_or_missing_file_ref_never_falls_back_to_keychain_branch() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        struct CountingKeychain {
            gets: AtomicUsize,
        }

        impl SecretStore for CountingKeychain {
            fn get(&self, _ref_id: &str) -> CoreResult<Option<String>> {
                self.gets.fetch_add(1, Ordering::SeqCst);
                Ok(Some("must-never-be-used".into()))
            }
            fn set(&self, _ref_id: &str, _secret: &str) -> CoreResult<()> {
                Ok(())
            }
            fn delete(&self, _ref_id: &str) -> CoreResult<()> {
                Ok(())
            }
        }

        // Production ReferencedSecretStore routes `file:` only through
        // read_file_secret_ref. This local twin proves the same branch
        // discipline: a failing file path must not consult the keychain
        // half of the store.
        struct FileFirstStore {
            keychain: CountingKeychain,
        }
        impl SecretStore for FileFirstStore {
            fn get(&self, ref_id: &str) -> CoreResult<Option<String>> {
                if ref_id.starts_with(FILE_SECRET_REF_PREFIX) {
                    return read_file_secret_ref(ref_id);
                }
                self.keychain.get(ref_id)
            }
            fn set(&self, ref_id: &str, secret: &str) -> CoreResult<()> {
                if ref_id.starts_with(FILE_SECRET_REF_PREFIX) {
                    return Err(CoreError::Config("read-only".into()));
                }
                self.keychain.set(ref_id, secret)
            }
            fn delete(&self, ref_id: &str) -> CoreResult<()> {
                if ref_id.starts_with(FILE_SECRET_REF_PREFIX) {
                    return Err(CoreError::Config("not deleted".into()));
                }
                self.keychain.delete(ref_id)
            }
        }

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("provider.key");
        write_protected_file(&path, "synthetic-value", 0o644);
        let store = FileFirstStore {
            keychain: CountingKeychain {
                gets: AtomicUsize::new(0),
            },
        };
        let err = store
            .get(&format!("file:{}", path.display()))
            .unwrap_err()
            .to_string();
        assert!(err.contains("permissions"), "{err}");
        assert_eq!(store.keychain.gets.load(Ordering::SeqCst), 0);

        let missing = dir.path().join("gone.key");
        let err = store
            .get(&format!("file:{}", missing.display()))
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("metadata") || err.contains("read protected"),
            "{err}"
        );
        assert_eq!(store.keychain.gets.load(Ordering::SeqCst), 0);
        assert!(!err.contains("must-never-be-used"));
        assert!(!err.contains("synthetic-value"));
    }

    #[cfg(unix)]
    #[test]
    fn concurrent_readers_of_a_stable_protected_file_agree() {
        use std::thread;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("shared.key");
        write_protected_file(&path, "shared-stable-secret\n", 0o600);
        let reference = format!("file:{}", path.display());
        let handles: Vec<_> = (0..8)
            .map(|_| {
                let reference = reference.clone();
                thread::spawn(move || read_file_secret_ref(&reference).unwrap().expect("present"))
            })
            .collect();
        for handle in handles {
            assert_eq!(handle.join().unwrap(), "shared-stable-secret");
        }
    }

    #[test]
    fn looks_like_raw_secret_never_flags_file_or_keychain_refs() {
        assert!(!looks_like_raw_secret(
            "file:/Users/demo/.secrets/provider.key"
        ));
        assert!(!looks_like_raw_secret("provider/work/api_key"));
        assert!(!looks_like_raw_secret(&key_ref_for_profile("demo")));
        assert!(looks_like_raw_secret("sk-proj-definitely-a-raw-key-value"));
    }

    #[test]
    fn non_file_refs_return_none_from_read_file_secret_ref() {
        assert_eq!(read_file_secret_ref("provider/work/api_key").unwrap(), None);
        assert_eq!(read_file_secret_ref("").unwrap(), None);
    }

    #[test]
    fn referenced_store_refuses_set_and_delete_for_file_refs() {
        let store = ReferencedSecretStore::new();
        let reference = "file:/tmp/does-not-need-to-exist.key";
        let set_err = store.set(reference, "x").unwrap_err().to_string();
        assert!(set_err.contains("read-only"), "{set_err}");
        let del_err = store.delete(reference).unwrap_err().to_string();
        assert!(del_err.contains("not deleted"), "{del_err}");
    }
}
