//! Snapshot loading must be bounded before it touches a blob byte.
//!
//! The live comparison command publishes per-blob and aggregate byte limits.
//! Those limits are worth nothing if loading the snapshot has already read a
//! whole blob into memory, so these tests pin both halves of the contract:
//! declared sizes are refused from the manifest alone, and verification of an
//! accepted snapshot streams rather than allocating.

mod common;

use cd_triage_bench::{BenchError, ContentDigest};
use common::{init_store, resolved_case, snapshot_for, LOG_BYTES};
use std::fs;

fn largest_declared_bytes(snapshot: &cd_triage_bench::EvidenceSnapshot) -> u64 {
    snapshot
        .items
        .iter()
        .filter_map(|item| item.held_content())
        .map(|content| content.byte_length)
        .max()
        .expect("fixture snapshot holds content")
}

#[test]
fn an_oversized_blob_is_refused_from_the_manifest_alone() {
    let dir = tempfile::tempdir().unwrap();
    let store = init_store(dir.path());
    store.put_case(&resolved_case()).unwrap();
    let snapshot = snapshot_for(&store, "case-checkout-cascade");
    let largest = largest_declared_bytes(&snapshot);

    let error = store
        .get_snapshot_bounded(&snapshot.snapshot_id, largest - 1, u64::MAX, || false)
        .unwrap_err();

    match error {
        BenchError::BlobTooLarge {
            declared_bytes,
            max_bytes,
            ..
        } => {
            assert_eq!(declared_bytes, largest);
            assert_eq!(max_bytes, largest - 1);
        }
        other => panic!("expected a declared-size refusal, got {other}"),
    }
}

#[test]
fn an_oversized_aggregate_is_refused_from_the_manifest_alone() {
    let dir = tempfile::tempdir().unwrap();
    let store = init_store(dir.path());
    store.put_case(&resolved_case()).unwrap();
    let snapshot = snapshot_for(&store, "case-checkout-cascade");
    let total: u64 = snapshot
        .items
        .iter()
        .filter_map(|item| item.held_content())
        .map(|content| content.byte_length)
        .sum();

    let error = store
        .get_snapshot_bounded(&snapshot.snapshot_id, u64::MAX, total - 1, || false)
        .unwrap_err();

    assert!(matches!(error, BenchError::BlobTooLarge { .. }), "{error}");
}

#[test]
fn a_snapshot_within_its_bounds_still_loads_and_verifies() {
    let dir = tempfile::tempdir().unwrap();
    let store = init_store(dir.path());
    store.put_case(&resolved_case()).unwrap();
    let snapshot = snapshot_for(&store, "case-checkout-cascade");

    let loaded = store
        .get_snapshot_bounded(&snapshot.snapshot_id, u64::MAX, u64::MAX, || false)
        .expect("a snapshot inside its bounds loads");

    assert_eq!(loaded.snapshot_id, snapshot.snapshot_id);
}

#[test]
fn a_blob_longer_than_its_manifest_is_refused_without_reading_it_whole() {
    let dir = tempfile::tempdir().unwrap();
    let store = init_store(dir.path());
    store.put_case(&resolved_case()).unwrap();
    let snapshot = snapshot_for(&store, "case-checkout-cascade");

    // Append far more bytes than the manifest declares. Verification must
    // stop one byte past the declared length instead of slurping the file.
    let hex = ContentDigest::of_bytes(LOG_BYTES).hex;
    let blob_path = store.root().join("blobs/sha256").join(&hex[..2]).join(&hex);
    let mut bytes = LOG_BYTES.to_vec();
    bytes.extend(std::iter::repeat_n(b'x', 8 * 1024 * 1024));
    fs::write(&blob_path, &bytes).unwrap();

    let error = store.get_snapshot(&snapshot.snapshot_id).unwrap_err();

    assert!(
        error.to_string().contains("exceeds manifest"),
        "expected an overlong-blob refusal, got {error}"
    );
}

#[test]
fn snapshot_verification_observes_cancellation() {
    let dir = tempfile::tempdir().unwrap();
    let store = init_store(dir.path());
    store.put_case(&resolved_case()).unwrap();
    let snapshot = snapshot_for(&store, "case-checkout-cascade");

    let error = store
        .get_snapshot_bounded(&snapshot.snapshot_id, u64::MAX, u64::MAX, || true)
        .unwrap_err();

    assert!(
        matches!(error, BenchError::BlobCopyCancelled { .. }),
        "{error}"
    );
}
