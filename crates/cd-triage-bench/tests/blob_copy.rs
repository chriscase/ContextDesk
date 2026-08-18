use cd_triage_bench::{BenchError, BenchStore, ContentDigest, HeldContent, VerifiedBlobCopy};
use std::cell::Cell;
use std::fs;
use std::io::{self, Write};
use std::rc::Rc;

fn temp_store() -> (tempfile::TempDir, BenchStore) {
    let dir = tempfile::tempdir().unwrap();
    let store = BenchStore::init(dir.path(), "2026-01-15T00:00:00Z").unwrap();
    (dir, store)
}

fn held(bytes: &[u8]) -> HeldContent {
    HeldContent {
        digest: ContentDigest::of_bytes(bytes),
        byte_length: bytes.len() as u64,
    }
}

fn backing_blob_path(store: &BenchStore, digest: &ContentDigest) -> std::path::PathBuf {
    store
        .root()
        .join("blobs/sha256")
        .join(&digest.hex[..2])
        .join(&digest.hex)
}

#[test]
fn streams_and_verifies_blob_at_exact_bound() {
    let (_dir, store) = temp_store();
    let bytes = vec![0x5a; 128 * 1024 + 17];
    let content = held(&bytes);
    store.put_blob(&bytes).unwrap();
    let mut destination = Vec::new();

    let receipt = store
        .copy_snapshot_blob_verified(&content, content.byte_length, &mut destination, || false)
        .unwrap();

    assert_eq!(destination, bytes);
    assert_eq!(
        receipt,
        VerifiedBlobCopy {
            digest: content.digest,
            byte_length: content.byte_length,
        }
    );
}

#[test]
fn corrupted_blob_fails_digest_verification_without_success_receipt() {
    let (_dir, store) = temp_store();
    let expected = b"expected bytes";
    let content = held(expected);
    store.put_blob(expected).unwrap();
    fs::write(
        backing_blob_path(&store, &content.digest),
        b"corruptd bytes",
    )
    .unwrap();
    let mut destination = Vec::new();

    let error = store
        .copy_snapshot_blob_verified(&content, content.byte_length, &mut destination, || false)
        .unwrap_err();

    assert!(matches!(error, BenchError::Integrity(_)));
    assert_eq!(destination, b"corruptd bytes");
}

#[test]
fn declared_oversize_is_rejected_before_open_or_write() {
    let (_dir, store) = temp_store();
    let bytes = b"four";
    let content = held(bytes);
    store.put_blob(bytes).unwrap();
    let mut destination = Vec::new();

    let error = store
        .copy_snapshot_blob_verified(&content, 3, &mut destination, || false)
        .unwrap_err();

    assert!(matches!(
        error,
        BenchError::BlobTooLarge {
            declared_bytes: 4,
            max_bytes: 3,
            ..
        }
    ));
    assert!(destination.is_empty());
}

#[test]
fn cancellation_before_copy_writes_nothing() {
    let (_dir, store) = temp_store();
    let content = held(b"cancel me");
    store.put_blob(b"cancel me").unwrap();
    let mut destination = Vec::new();

    let error = store
        .copy_snapshot_blob_verified(&content, content.byte_length, &mut destination, || true)
        .unwrap_err();

    assert!(matches!(error, BenchError::BlobCopyCancelled { .. }));
    assert!(destination.is_empty());
}

struct ObservedWriter {
    bytes: Vec<u8>,
    written: Rc<Cell<usize>>,
}

impl Write for ObservedWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.bytes.extend_from_slice(bytes);
        self.written.set(self.bytes.len());
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[test]
fn cancellation_between_chunks_returns_error_not_receipt() {
    let (_dir, store) = temp_store();
    let bytes = vec![0x3c; 192 * 1024];
    let content = held(&bytes);
    store.put_blob(&bytes).unwrap();
    let written = Rc::new(Cell::new(0));
    let observed = Rc::clone(&written);
    let mut destination = ObservedWriter {
        bytes: Vec::new(),
        written,
    };

    let error = store
        .copy_snapshot_blob_verified(&content, content.byte_length, &mut destination, || {
            observed.get() > 0
        })
        .unwrap_err();

    assert!(matches!(error, BenchError::BlobCopyCancelled { .. }));
    assert!(!destination.bytes.is_empty());
    assert!(destination.bytes.len() < bytes.len());
}

#[test]
fn empty_blob_succeeds_with_zero_bound() {
    let (_dir, store) = temp_store();
    let content = held(b"");
    store.put_blob(b"").unwrap();
    let mut destination = Vec::new();

    let receipt = store
        .copy_snapshot_blob_verified(&content, 0, &mut destination, || false)
        .unwrap();

    assert_eq!(receipt.byte_length, 0);
    assert!(destination.is_empty());
}

#[test]
fn nonempty_blob_is_rejected_with_zero_bound() {
    let (_dir, store) = temp_store();
    let content = held(b"x");
    store.put_blob(b"x").unwrap();
    let mut destination = Vec::new();

    let error = store
        .copy_snapshot_blob_verified(&content, 0, &mut destination, || false)
        .unwrap_err();

    assert!(matches!(error, BenchError::BlobTooLarge { .. }));
    assert!(destination.is_empty());
}

#[test]
fn declared_length_mismatch_fails_without_writing_trailing_bytes() {
    let (_dir, store) = temp_store();
    let bytes = b"actual";
    let mut content = held(bytes);
    store.put_blob(bytes).unwrap();
    content.byte_length -= 1;
    let mut destination = Vec::new();

    let error = store
        .copy_snapshot_blob_verified(&content, bytes.len() as u64, &mut destination, || false)
        .unwrap_err();

    assert!(matches!(error, BenchError::Integrity(_)));
    assert_eq!(destination, &bytes[..bytes.len() - 1]);
}

struct FailsAfter {
    remaining: usize,
}

impl Write for FailsAfter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if self.remaining == 0 {
            return Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "synthetic full destination",
            ));
        }
        let written = self.remaining.min(bytes.len());
        self.remaining -= written;
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[test]
fn destination_write_failure_is_reported() {
    let (_dir, store) = temp_store();
    let bytes = b"destination failure";
    let content = held(bytes);
    store.put_blob(bytes).unwrap();
    let mut destination = FailsAfter { remaining: 4 };

    let error = store
        .copy_snapshot_blob_verified(&content, content.byte_length, &mut destination, || false)
        .unwrap_err();

    assert!(matches!(error, BenchError::BlobWrite { .. }));
}

#[test]
fn missing_blob_error_does_not_expose_store_path() {
    let (dir, store) = temp_store();
    let content = held(b"missing");
    let mut destination = Vec::new();

    let error = store
        .copy_snapshot_blob_verified(&content, content.byte_length, &mut destination, || false)
        .unwrap_err();
    let message = error.to_string();

    assert!(matches!(error, BenchError::NotFound(_)));
    assert!(!message.contains(dir.path().to_string_lossy().as_ref()));
    assert!(destination.is_empty());
}
