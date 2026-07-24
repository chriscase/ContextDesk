//! Bounded object-storage abstraction for optional backup/export (#292 / #417).
//!
//! The production S3 transport is deliberately a separate feature. This module
//! owns transport-neutral keys, metadata, cancellation, errors, and a
//! deterministic in-memory backend used by offline tests.

use async_trait::async_trait;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, VecDeque};
use std::fmt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use thiserror::Error;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::Notify;

/// Maximum bytes requested from a reader or written to a sink per I/O step.
pub const OBJECT_IO_CHUNK_BYTES: usize = 64 * 1024;

/// Maximum number of objects returned by one list page.
pub const MAX_OBJECT_LIST_PAGE: usize = 1_000;

/// Validated storage object key.
///
/// Keys are always relative slash-separated paths. URL-like input, absolute
/// paths, empty segments, dot segments, backslashes, and control characters
/// are rejected before a backend sees them.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ObjectKey(String);

impl ObjectKey {
    /// Parse and validate a relative object key.
    pub fn parse(value: impl Into<String>) -> Result<Self, ObjectStoreError> {
        let value = value.into();
        validate_object_path(&value, false)?;
        Ok(Self(value))
    }

    /// Validated key text.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for ObjectKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// Validated list prefix.
///
/// The empty prefix is valid and lists from the backend root. Non-empty
/// prefixes follow the same rules as [`ObjectKey`], with one optional trailing
/// slash for directory-like prefix queries.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ObjectPrefix(String);

impl ObjectPrefix {
    /// Parse and validate a list prefix.
    pub fn parse(value: impl Into<String>) -> Result<Self, ObjectStoreError> {
        let value = value.into();
        validate_object_path(&value, true)?;
        Ok(Self(value))
    }

    /// Empty/root prefix.
    pub fn root() -> Self {
        Self::default()
    }

    /// Validated prefix text.
    pub fn as_str(&self) -> &str {
        &self.0
    }

    fn contains(&self, key: &ObjectKey) -> bool {
        key.as_str().starts_with(self.as_str())
    }
}

fn validate_object_path(value: &str, allow_empty: bool) -> Result<(), ObjectStoreError> {
    if value.is_empty() {
        return if allow_empty {
            Ok(())
        } else {
            Err(ObjectStoreError::InvalidInput {
                reason: "object key must not be empty",
            })
        };
    }
    if value.len() > 1_024 {
        return Err(ObjectStoreError::InvalidInput {
            reason: "object path exceeds 1024 bytes",
        });
    }
    if value.starts_with('/') || value.starts_with('\\') {
        return Err(ObjectStoreError::InvalidInput {
            reason: "object path must be relative",
        });
    }
    if value.contains('\\') {
        return Err(ObjectStoreError::InvalidInput {
            reason: "backslashes are not valid object separators",
        });
    }
    if !allow_empty && value.ends_with('/') {
        return Err(ObjectStoreError::InvalidInput {
            reason: "object keys must not end with a separator",
        });
    }
    if value.contains("://") || value.contains('?') || value.contains('#') {
        return Err(ObjectStoreError::InvalidInput {
            reason: "object path must not contain URL components",
        });
    }
    if value.chars().any(char::is_control) {
        return Err(ObjectStoreError::InvalidInput {
            reason: "object path contains control characters",
        });
    }
    let trimmed = value.strip_suffix('/').unwrap_or(value);
    if trimmed.is_empty() && allow_empty {
        return Ok(());
    }
    if value.contains("//")
        || trimmed
            .split('/')
            .any(|segment| segment.is_empty() || segment == "." || segment == "..")
    {
        return Err(ObjectStoreError::InvalidInput {
            reason: "object path contains an ambiguous or escaping segment",
        });
    }
    Ok(())
}

/// Runtime-only object-store credentials.
///
/// This type intentionally does not implement serialization or `Display`.
/// Its `Debug` implementation always redacts every credential component.
#[derive(Clone)]
pub struct ObjectCredentials {
    access_key: String,
    secret_key: String,
    session_token: Option<String>,
}

impl ObjectCredentials {
    /// Construct runtime credentials.
    pub fn new(
        access_key: impl Into<String>,
        secret_key: impl Into<String>,
        session_token: Option<String>,
    ) -> Result<Self, ObjectStoreError> {
        let access_key = access_key.into();
        let secret_key = secret_key.into();
        if access_key.trim().is_empty() || secret_key.trim().is_empty() {
            return Err(ObjectStoreError::Authorization);
        }
        Ok(Self {
            access_key,
            secret_key,
            session_token: session_token.filter(|value| !value.trim().is_empty()),
        })
    }

    /// Runtime access key for a trusted backend.
    pub fn access_key(&self) -> &str {
        &self.access_key
    }

    /// Runtime secret key for a trusted backend.
    pub fn secret_key(&self) -> &str {
        &self.secret_key
    }

    /// Optional runtime session token for a trusted backend.
    pub fn session_token(&self) -> Option<&str> {
        self.session_token.as_deref()
    }
}

impl fmt::Debug for ObjectCredentials {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ObjectCredentials")
            .field("access_key", &"[REDACTED]")
            .field("secret_key", &"[REDACTED]")
            .field(
                "session_token",
                &self.session_token.as_ref().map(|_| "[REDACTED]"),
            )
            .finish()
    }
}

/// Metadata returned for one object.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ObjectMetadata {
    /// Validated object key.
    pub key: ObjectKey,
    /// Stored content length.
    pub content_length: u64,
    /// Backend entity tag, when available.
    pub etag: Option<String>,
    /// Hex SHA-256 supplied or computed for idempotence.
    pub content_sha256: Option<String>,
}

/// Options accompanying one upload.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PutObjectOptions {
    /// Expected body length. A mismatch fails before the fake commits.
    pub content_length: Option<u64>,
    /// Expected lowercase/uppercase hex SHA-256. A mismatch fails.
    pub content_sha256: Option<String>,
    /// Non-secret media type for transport metadata.
    pub content_type: Option<String>,
}

/// One bounded list request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ListObjectsRequest {
    /// Validated key prefix.
    pub prefix: ObjectPrefix,
    /// Opaque continuation returned by the previous page.
    pub continuation: Option<String>,
    /// Maximum number of results in this page.
    pub max_keys: usize,
}

impl ListObjectsRequest {
    /// Construct a bounded list request.
    pub fn new(prefix: ObjectPrefix, max_keys: usize) -> Result<Self, ObjectStoreError> {
        if max_keys == 0 || max_keys > MAX_OBJECT_LIST_PAGE {
            return Err(ObjectStoreError::InvalidInput {
                reason: "list max_keys must be between 1 and 1000",
            });
        }
        Ok(Self {
            prefix,
            continuation: None,
            max_keys,
        })
    }
}

/// One bounded page of object metadata.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ListObjectsPage {
    /// Objects in deterministic backend order.
    pub objects: Vec<ObjectMetadata>,
    /// Opaque continuation for the next page.
    pub next_continuation: Option<String>,
}

/// Typed storage failure that never embeds raw credentials or response bodies.
#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum ObjectStoreError {
    /// Requested object does not exist.
    #[error("object not found")]
    NotFound,
    /// Credentials are missing or rejected.
    #[error("object-store authorization failed")]
    Authorization,
    /// Endpoint or request violates host policy.
    #[error("object-store endpoint rejected by policy")]
    EndpointPolicy,
    /// Operation exceeded its wall-clock budget.
    #[error("object-store operation timed out")]
    Timeout,
    /// User or caller cancelled the operation.
    #[error("object-store operation cancelled")]
    Cancelled,
    /// Remote transport failed; only a bounded status is retained.
    #[error("object-store transport failed")]
    Transport {
        /// Optional HTTP-style status code.
        status: Option<u16>,
    },
    /// Input failed local validation.
    #[error("{reason}")]
    InvalidInput {
        /// Static, non-secret validation reason.
        reason: &'static str,
    },
    /// Local reader or writer failed.
    #[error("object-store local I/O failed")]
    LocalIo,
}

impl ObjectStoreError {
    /// Construct a scrubbed transport failure with an optional status code.
    pub fn transport(status: Option<u16>) -> Self {
        Self::Transport { status }
    }
}

/// Cloneable cancellation signal for object operations.
#[derive(Clone, Default)]
pub struct ObjectCancellation {
    inner: Arc<ObjectCancellationInner>,
}

#[derive(Default)]
struct ObjectCancellationInner {
    cancelled: AtomicBool,
    notify: Notify,
}

impl fmt::Debug for ObjectCancellation {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ObjectCancellation")
            .field("cancelled", &self.is_cancelled())
            .finish()
    }
}

impl ObjectCancellation {
    /// Mark the operation cancelled and wake current waiters.
    pub fn cancel(&self) {
        self.inner.cancelled.store(true, Ordering::Release);
        self.inner.notify.notify_waiters();
    }

    /// True after cancellation was requested.
    pub fn is_cancelled(&self) -> bool {
        self.inner.cancelled.load(Ordering::Acquire)
    }

    /// Resolve after cancellation is requested.
    pub async fn cancelled(&self) {
        loop {
            let notified = self.inner.notify.notified();
            if self.is_cancelled() {
                return;
            }
            notified.await;
            if self.is_cancelled() {
                return;
            }
        }
    }
}

/// Cancellation and wall-clock deadline for one storage operation.
#[derive(Clone, Debug, Default)]
pub struct ObjectOperation {
    /// Caller-owned cancellation signal.
    pub cancellation: ObjectCancellation,
    deadline: Option<Instant>,
}

impl ObjectOperation {
    /// Operation without a deadline.
    pub fn new(cancellation: ObjectCancellation) -> Self {
        Self {
            cancellation,
            deadline: None,
        }
    }

    /// Operation with a deadline relative to now.
    pub fn with_timeout(cancellation: ObjectCancellation, timeout: Duration) -> Self {
        Self {
            cancellation,
            deadline: Some(Instant::now() + timeout),
        }
    }

    /// Fail immediately when cancellation or the deadline has already elapsed.
    pub fn check(&self) -> Result<(), ObjectStoreError> {
        if self.cancellation.is_cancelled() {
            return Err(ObjectStoreError::Cancelled);
        }
        if self
            .deadline
            .is_some_and(|deadline| Instant::now() >= deadline)
        {
            return Err(ObjectStoreError::Timeout);
        }
        Ok(())
    }

    /// Absolute wall-clock deadline, when configured.
    pub fn deadline(&self) -> Option<Instant> {
        self.deadline
    }

    pub(crate) async fn read(
        &self,
        reader: &mut (dyn AsyncRead + Unpin + Send),
        buffer: &mut [u8],
    ) -> Result<usize, ObjectStoreError> {
        self.check()?;
        if let Some(deadline) = self.deadline {
            tokio::select! {
                _ = self.cancellation.cancelled() => Err(ObjectStoreError::Cancelled),
                _ = tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)) => {
                    Err(ObjectStoreError::Timeout)
                }
                read = reader.read(buffer) => read.map_err(|_| ObjectStoreError::LocalIo),
            }
        } else {
            tokio::select! {
                _ = self.cancellation.cancelled() => Err(ObjectStoreError::Cancelled),
                read = reader.read(buffer) => read.map_err(|_| ObjectStoreError::LocalIo),
            }
        }
    }

    pub(crate) async fn write_all(
        &self,
        writer: &mut (dyn AsyncWrite + Unpin + Send),
        bytes: &[u8],
    ) -> Result<(), ObjectStoreError> {
        self.check()?;
        if let Some(deadline) = self.deadline {
            tokio::select! {
                _ = self.cancellation.cancelled() => Err(ObjectStoreError::Cancelled),
                _ = tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)) => {
                    Err(ObjectStoreError::Timeout)
                }
                write = writer.write_all(bytes) => write.map_err(|_| ObjectStoreError::LocalIo),
            }
        } else {
            tokio::select! {
                _ = self.cancellation.cancelled() => Err(ObjectStoreError::Cancelled),
                write = writer.write_all(bytes) => write.map_err(|_| ObjectStoreError::LocalIo),
            }
        }
    }

    pub(crate) async fn flush(
        &self,
        writer: &mut (dyn AsyncWrite + Unpin + Send),
    ) -> Result<(), ObjectStoreError> {
        self.check()?;
        if let Some(deadline) = self.deadline {
            tokio::select! {
                _ = self.cancellation.cancelled() => Err(ObjectStoreError::Cancelled),
                _ = tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)) => {
                    Err(ObjectStoreError::Timeout)
                }
                flush = writer.flush() => flush.map_err(|_| ObjectStoreError::LocalIo),
            }
        } else {
            tokio::select! {
                _ = self.cancellation.cancelled() => Err(ObjectStoreError::Cancelled),
                flush = writer.flush() => flush.map_err(|_| ObjectStoreError::LocalIo),
            }
        }
    }
}

/// Transport-neutral object storage.
///
/// Upload and download bodies use async readers/writers so production backends
/// can stream with bounded memory. Implementations must stop all mutation before
/// returning timeout or cancellation.
#[async_trait]
pub trait ObjectStore: Send + Sync {
    /// Upload one object, replacing the same key when the backend supports it.
    async fn put(
        &self,
        key: &ObjectKey,
        body: &mut (dyn AsyncRead + Unpin + Send),
        options: &PutObjectOptions,
        operation: &ObjectOperation,
    ) -> Result<ObjectMetadata, ObjectStoreError>;

    /// Stream one object into the caller-provided sink.
    async fn get(
        &self,
        key: &ObjectKey,
        sink: &mut (dyn AsyncWrite + Unpin + Send),
        operation: &ObjectOperation,
    ) -> Result<ObjectMetadata, ObjectStoreError>;

    /// Read object metadata without downloading its body.
    async fn head(
        &self,
        key: &ObjectKey,
        operation: &ObjectOperation,
    ) -> Result<ObjectMetadata, ObjectStoreError>;

    /// Return one bounded page under a validated prefix.
    async fn list(
        &self,
        request: &ListObjectsRequest,
        operation: &ObjectOperation,
    ) -> Result<ListObjectsPage, ObjectStoreError>;
}

/// Deterministic failure that can be injected into the offline fake.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FakeObjectStoreFailure {
    /// Return an authorization failure.
    Authorization,
    /// Return a scrubbed transport failure.
    Transport,
    /// Return a timeout without mutating state.
    Timeout,
}

impl FakeObjectStoreFailure {
    fn into_error(self) -> ObjectStoreError {
        match self {
            Self::Authorization => ObjectStoreError::Authorization,
            Self::Transport => ObjectStoreError::transport(None),
            Self::Timeout => ObjectStoreError::Timeout,
        }
    }
}

#[derive(Clone)]
struct FakeObject {
    bytes: Vec<u8>,
    metadata: ObjectMetadata,
}

#[derive(Default)]
struct FakeObjectStoreState {
    objects: BTreeMap<ObjectKey, FakeObject>,
    upload_counts: BTreeMap<ObjectKey, u64>,
    failures: VecDeque<FakeObjectStoreFailure>,
}

/// Deterministic, observable in-memory object store for offline tests.
///
/// The fake stores complete bodies by design, but it reads/writes them through
/// [`OBJECT_IO_CHUNK_BYTES`] buffers so callers exercise the streaming API.
#[derive(Clone, Default)]
pub struct InMemoryObjectStore {
    state: Arc<Mutex<FakeObjectStoreState>>,
}

impl fmt::Debug for InMemoryObjectStore {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let count = self
            .state
            .lock()
            .map(|state| state.objects.len())
            .unwrap_or_default();
        f.debug_struct("InMemoryObjectStore")
            .field("object_count", &count)
            .finish()
    }
}

impl InMemoryObjectStore {
    /// Queue a deterministic failure for the next operation.
    pub fn fail_next(&self, failure: FakeObjectStoreFailure) {
        if let Ok(mut state) = self.state.lock() {
            state.failures.push_back(failure);
        }
    }

    /// Number of committed uploads for one key.
    pub fn upload_count(&self, key: &ObjectKey) -> u64 {
        self.state
            .lock()
            .ok()
            .and_then(|state| state.upload_counts.get(key).copied())
            .unwrap_or_default()
    }

    /// Deterministic snapshot of stored keys.
    pub fn keys(&self) -> Vec<ObjectKey> {
        self.state
            .lock()
            .map(|state| state.objects.keys().cloned().collect())
            .unwrap_or_default()
    }

    fn take_failure(&self) -> Result<(), ObjectStoreError> {
        let failure = self
            .state
            .lock()
            .map_err(|_| ObjectStoreError::transport(None))?
            .failures
            .pop_front();
        match failure {
            Some(failure) => Err(failure.into_error()),
            None => Ok(()),
        }
    }
}

#[async_trait]
impl ObjectStore for InMemoryObjectStore {
    async fn put(
        &self,
        key: &ObjectKey,
        body: &mut (dyn AsyncRead + Unpin + Send),
        options: &PutObjectOptions,
        operation: &ObjectOperation,
    ) -> Result<ObjectMetadata, ObjectStoreError> {
        operation.check()?;
        self.take_failure()?;

        let mut bytes = Vec::new();
        let mut buffer = vec![0_u8; OBJECT_IO_CHUNK_BYTES];
        loop {
            let read = operation.read(body, &mut buffer).await?;
            if read == 0 {
                break;
            }
            bytes.extend_from_slice(&buffer[..read]);
        }
        operation.check()?;

        if options
            .content_length
            .is_some_and(|expected| expected != bytes.len() as u64)
        {
            return Err(ObjectStoreError::InvalidInput {
                reason: "upload content length mismatch",
            });
        }
        let digest = hex_sha256(&bytes);
        if options
            .content_sha256
            .as_deref()
            .is_some_and(|expected| !expected.eq_ignore_ascii_case(&digest))
        {
            return Err(ObjectStoreError::InvalidInput {
                reason: "upload content hash mismatch",
            });
        }

        let metadata = ObjectMetadata {
            key: key.clone(),
            content_length: bytes.len() as u64,
            etag: Some(digest.clone()),
            content_sha256: Some(digest),
        };
        let mut state = self
            .state
            .lock()
            .map_err(|_| ObjectStoreError::transport(None))?;
        operation.check()?;
        state.objects.insert(
            key.clone(),
            FakeObject {
                bytes,
                metadata: metadata.clone(),
            },
        );
        *state.upload_counts.entry(key.clone()).or_default() += 1;
        Ok(metadata)
    }

    async fn get(
        &self,
        key: &ObjectKey,
        sink: &mut (dyn AsyncWrite + Unpin + Send),
        operation: &ObjectOperation,
    ) -> Result<ObjectMetadata, ObjectStoreError> {
        operation.check()?;
        self.take_failure()?;
        let object = self
            .state
            .lock()
            .map_err(|_| ObjectStoreError::transport(None))?
            .objects
            .get(key)
            .cloned()
            .ok_or(ObjectStoreError::NotFound)?;
        for chunk in object.bytes.chunks(OBJECT_IO_CHUNK_BYTES) {
            operation.write_all(sink, chunk).await?;
        }
        operation.flush(sink).await?;
        operation.check()?;
        Ok(object.metadata)
    }

    async fn head(
        &self,
        key: &ObjectKey,
        operation: &ObjectOperation,
    ) -> Result<ObjectMetadata, ObjectStoreError> {
        operation.check()?;
        self.take_failure()?;
        self.state
            .lock()
            .map_err(|_| ObjectStoreError::transport(None))?
            .objects
            .get(key)
            .map(|object| object.metadata.clone())
            .ok_or(ObjectStoreError::NotFound)
    }

    async fn list(
        &self,
        request: &ListObjectsRequest,
        operation: &ObjectOperation,
    ) -> Result<ListObjectsPage, ObjectStoreError> {
        operation.check()?;
        self.take_failure()?;
        let state = self
            .state
            .lock()
            .map_err(|_| ObjectStoreError::transport(None))?;
        let mut matches = state
            .objects
            .iter()
            .filter(|(key, _)| request.prefix.contains(key))
            .filter(|(key, _)| {
                request
                    .continuation
                    .as_deref()
                    .is_none_or(|after| key.as_str() > after)
            })
            .map(|(_, object)| object.metadata.clone());
        let objects: Vec<_> = matches.by_ref().take(request.max_keys).collect();
        let has_more = matches.next().is_some();
        let next_continuation = has_more
            .then(|| {
                objects
                    .last()
                    .map(|metadata| metadata.key.as_str().to_string())
            })
            .flatten();
        operation.check()?;
        Ok(ListObjectsPage {
            objects,
            next_continuation,
        })
    }
}

fn hex_sha256(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut output = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use fmt::Write as _;
        let _ = write!(output, "{byte:02x}");
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use std::pin::Pin;
    use std::task::{Context, Poll};
    use tokio::io::{AsyncRead, ReadBuf};

    #[test]
    fn object_key_rejects_escape_and_url_components() {
        for invalid in [
            "",
            "/absolute",
            "../escape",
            "safe/../escape",
            "safe//double",
            "safe/trailing/",
            "safe\\windows",
            "https://example.com/key",
            "safe?query=secret",
            "safe#fragment",
            "safe/\0bad",
        ] {
            assert!(
                ObjectKey::parse(invalid).is_err(),
                "invalid key accepted: {invalid:?}"
            );
        }
        assert_eq!(
            ObjectKey::parse("workspace/files/readme.md")
                .unwrap()
                .as_str(),
            "workspace/files/readme.md"
        );
        assert!(ObjectPrefix::parse("").is_ok());
        assert!(ObjectPrefix::parse("workspace/files/").is_ok());
    }

    #[tokio::test]
    async fn fake_put_get_list_is_deterministic_and_paged() {
        let store = InMemoryObjectStore::default();
        let operation = ObjectOperation::default();
        for (key, body) in [
            ("ws/a.txt", b"alpha".as_slice()),
            ("ws/b.txt", b"beta".as_slice()),
            ("other/c.txt", b"gamma".as_slice()),
        ] {
            let key = ObjectKey::parse(key).unwrap();
            let mut reader = Cursor::new(body.to_vec());
            let metadata = store
                .put(
                    &key,
                    &mut reader,
                    &PutObjectOptions {
                        content_length: Some(body.len() as u64),
                        ..PutObjectOptions::default()
                    },
                    &operation,
                )
                .await
                .unwrap();
            assert_eq!(metadata.content_length, body.len() as u64);
            assert_eq!(store.upload_count(&key), 1);
        }

        let mut request = ListObjectsRequest::new(ObjectPrefix::parse("ws/").unwrap(), 1).unwrap();
        let first = store.list(&request, &operation).await.unwrap();
        assert_eq!(first.objects.len(), 1);
        assert_eq!(first.objects[0].key.as_str(), "ws/a.txt");
        request.continuation = first.next_continuation;
        let second = store.list(&request, &operation).await.unwrap();
        assert_eq!(second.objects.len(), 1);
        assert_eq!(second.objects[0].key.as_str(), "ws/b.txt");
        assert!(second.next_continuation.is_none());

        let mut output = Vec::new();
        store
            .get(
                &ObjectKey::parse("ws/b.txt").unwrap(),
                &mut output,
                &operation,
            )
            .await
            .unwrap();
        assert_eq!(output, b"beta");
    }

    #[tokio::test]
    async fn fake_injected_failures_do_not_mutate() {
        let store = InMemoryObjectStore::default();
        let key = ObjectKey::parse("ws/fail.txt").unwrap();
        for (failure, expected) in [
            (
                FakeObjectStoreFailure::Authorization,
                ObjectStoreError::Authorization,
            ),
            (
                FakeObjectStoreFailure::Transport,
                ObjectStoreError::transport(None),
            ),
            (FakeObjectStoreFailure::Timeout, ObjectStoreError::Timeout),
        ] {
            store.fail_next(failure);
            let mut reader = Cursor::new(b"never committed".to_vec());
            let error = store
                .put(
                    &key,
                    &mut reader,
                    &PutObjectOptions::default(),
                    &ObjectOperation::default(),
                )
                .await
                .unwrap_err();
            assert_eq!(error, expected);
            assert_eq!(store.upload_count(&key), 0);
            assert!(store.head(&key, &ObjectOperation::default()).await.is_err());
        }
    }

    #[test]
    fn credentials_debug_is_fully_redacted() {
        let access = "AKIA_TEST_ACCESS_NEVER_PRINT";
        let secret = "secret-value-never-print";
        let token = "session-token-never-print";
        let credentials = ObjectCredentials::new(access, secret, Some(token.to_string())).unwrap();
        let debug = format!("{credentials:?}");
        assert!(!debug.contains(access), "{debug}");
        assert!(!debug.contains(secret), "{debug}");
        assert!(!debug.contains(token), "{debug}");
        assert!(debug.matches("[REDACTED]").count() >= 3, "{debug}");
    }

    #[derive(Default)]
    struct RecordingReader {
        remaining: usize,
        largest_request: Arc<Mutex<usize>>,
    }

    impl AsyncRead for RecordingReader {
        fn poll_read(
            mut self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
            buffer: &mut ReadBuf<'_>,
        ) -> Poll<std::io::Result<()>> {
            let requested = buffer.remaining();
            if let Ok(mut largest) = self.largest_request.lock() {
                *largest = (*largest).max(requested);
            }
            let count = requested.min(self.remaining);
            let bytes = vec![b'x'; count];
            buffer.put_slice(&bytes);
            self.remaining -= count;
            Poll::Ready(Ok(()))
        }
    }

    #[tokio::test]
    async fn fake_reads_through_bounded_chunks() {
        let largest_request = Arc::new(Mutex::new(0));
        let mut reader = RecordingReader {
            remaining: OBJECT_IO_CHUNK_BYTES * 3 + 17,
            largest_request: Arc::clone(&largest_request),
        };
        let store = InMemoryObjectStore::default();
        store
            .put(
                &ObjectKey::parse("ws/large.bin").unwrap(),
                &mut reader,
                &PutObjectOptions::default(),
                &ObjectOperation::default(),
            )
            .await
            .unwrap();
        assert_eq!(
            *largest_request.lock().unwrap(),
            OBJECT_IO_CHUNK_BYTES,
            "backend requested an unbounded read"
        );
    }

    #[tokio::test]
    async fn cancellation_interrupts_blocked_upload_without_commit() {
        let store = InMemoryObjectStore::default();
        let key = ObjectKey::parse("ws/cancelled.bin").unwrap();
        let cancellation = ObjectCancellation::default();
        let operation = ObjectOperation::new(cancellation.clone());
        let (mut writer, mut reader) = tokio::io::duplex(128);
        writer.write_all(b"partial").await.unwrap();

        let task_store = store.clone();
        let task_key = key.clone();
        let task = tokio::spawn(async move {
            task_store
                .put(
                    &task_key,
                    &mut reader,
                    &PutObjectOptions::default(),
                    &operation,
                )
                .await
        });
        tokio::task::yield_now().await;
        cancellation.cancel();
        let error = task.await.unwrap().unwrap_err();
        assert_eq!(error, ObjectStoreError::Cancelled);
        assert_eq!(store.upload_count(&key), 0);
        assert!(store.head(&key, &ObjectOperation::default()).await.is_err());
    }

    #[tokio::test]
    async fn timeout_interrupts_blocked_upload_without_commit() {
        let store = InMemoryObjectStore::default();
        let key = ObjectKey::parse("ws/timeout.bin").unwrap();
        let (_writer, mut reader) = tokio::io::duplex(128);
        let operation =
            ObjectOperation::with_timeout(ObjectCancellation::default(), Duration::from_millis(20));
        let error = store
            .put(&key, &mut reader, &PutObjectOptions::default(), &operation)
            .await
            .unwrap_err();
        assert_eq!(error, ObjectStoreError::Timeout);
        assert_eq!(store.upload_count(&key), 0);
        assert!(store.head(&key, &ObjectOperation::default()).await.is_err());
    }
}
