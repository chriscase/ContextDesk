//! Local file-backed library. Offline; no network or keychain.

use crate::canonical::to_pretty_json;
use crate::error::{BenchError, BenchResult};
use crate::gold::GoldReference;
use crate::packet::{materialize_task_packet, TaskPacket};
use crate::review::{
    materialize_review_packet, merge_citation_assists, run_has_support_adjudication, ReviewPacket,
    ReviewPhase,
};
use crate::trace::InteractionTrace;
use crate::types::citation_assist_flags;
use crate::types::{
    sha256_hex, Adjudication, Case, ContentDigest, EvaluationTask, EvidenceSnapshot, HeldContent,
    ScoreReview, TriageRun, LIBRARY_SCHEMA_V1, MAX_RAW_INLINE_BYTES,
};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

const BLOB_COPY_BUFFER_BYTES: usize = 64 * 1024;
static BLOB_TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// Library metadata stored at `<root>/library.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LibraryMeta {
    pub schema_id: String,
    pub created_at: String,
}

/// Durable offline store. Records are immutable after first write.
#[derive(Debug, Clone)]
pub struct BenchStore {
    root: PathBuf,
}

/// Proof returned only after a streamed blob copy matches its declared length and digest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedBlobCopy {
    pub digest: ContentDigest,
    pub byte_length: u64,
}

impl BenchStore {
    pub fn init(root: impl Into<PathBuf>, created_at: &str) -> BenchResult<Self> {
        let root = root.into();
        fs::create_dir_all(&root).map_err(|e| BenchError::io(&root, e))?;
        for dir in [
            "cases",
            "snapshots",
            "tasks",
            "runs",
            "adjudications",
            "scores",
            "golds",
            "traces",
            "packets",
            "review-packets",
            "blobs/sha256",
        ] {
            let path = root.join(dir);
            fs::create_dir_all(&path).map_err(|e| BenchError::io(&path, e))?;
        }
        let meta = LibraryMeta {
            schema_id: LIBRARY_SCHEMA_V1.into(),
            created_at: created_at.to_string(),
        };
        crate::types::validate_rfc3339("created_at", created_at)?;
        atomic_write_json(&root.join("library.json"), &meta)?;
        Ok(Self { root })
    }

    pub fn open(root: impl Into<PathBuf>) -> BenchResult<Self> {
        let root = root.into();
        let meta_path = root.join("library.json");
        let text = fs::read_to_string(&meta_path).map_err(|e| BenchError::io(&meta_path, e))?;
        let meta: LibraryMeta = serde_json::from_str(&text).map_err(BenchError::from_serde)?;
        if meta.schema_id != LIBRARY_SCHEMA_V1 {
            return Err(BenchError::Schema(format!(
                "unsupported library schema {}",
                meta.schema_id
            )));
        }
        Ok(Self { root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn put_blob(&self, bytes: &[u8]) -> BenchResult<ContentDigest> {
        self.with_write_lock(|| self.put_blob_tracked(bytes).map(|outcome| outcome.digest))
    }

    fn put_blob_tracked(&self, bytes: &[u8]) -> BenchResult<PutBlobOutcome> {
        let digest = ContentDigest::of_bytes(bytes);
        let path = self.blob_path(&digest.hex);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| BenchError::io(parent, e))?;
        }

        if path.exists() {
            verify_existing_blob_bytes(&path, &digest, bytes)?;
            return Ok(PutBlobOutcome {
                digest,
                created: false,
            });
        }

        // Stage complete bytes beside the destination, then atomically link
        // them into the content-addressed name. Readers can therefore observe
        // either no blob or the complete blob, never a partially written one.
        let sequence = BLOB_TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let temporary = path.with_extension(format!("tmp-{}-{sequence}", std::process::id()));
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|source| BenchError::io(&temporary, source))?;
        if let Err(source) = file.write_all(bytes).and_then(|()| file.sync_all()) {
            drop(file);
            let _ = fs::remove_file(&temporary);
            return Err(BenchError::io(&temporary, source));
        }
        drop(file);

        let created = match fs::hard_link(&temporary, &path) {
            Ok(()) => true,
            Err(source) if source.kind() == std::io::ErrorKind::AlreadyExists => {
                if let Err(error) = verify_existing_blob_bytes(&path, &digest, bytes) {
                    let _ = fs::remove_file(&temporary);
                    return Err(error);
                }
                false
            }
            Err(source) => {
                let _ = fs::remove_file(&temporary);
                return Err(BenchError::io(&path, source));
            }
        };
        let _ = fs::remove_file(&temporary);
        Ok(PutBlobOutcome { digest, created })
    }

    pub fn get_blob(&self, hex: &str) -> BenchResult<Vec<u8>> {
        crate::types::validate_sha256_hex(hex)?;
        let path = self.blob_path(hex);
        let bytes = fs::read(&path).map_err(|e| BenchError::io(&path, e))?;
        let actual = sha256_hex(&bytes);
        if actual != hex {
            return Err(BenchError::Integrity(format!(
                "blob {hex} failed digest verification (got {actual})"
            )));
        }
        Ok(bytes)
    }

    /// Read and verify a blob without allocating beyond `max_bytes`.
    pub fn get_blob_bounded(&self, hex: &str, max_bytes: u64) -> BenchResult<Vec<u8>> {
        crate::types::validate_sha256_hex(hex)?;
        let path = self.blob_path(hex);
        let metadata = fs::symlink_metadata(&path).map_err(|e| BenchError::io(&path, e))?;
        if !metadata.file_type().is_file() {
            return Err(BenchError::Integrity("blob is not a regular file".into()));
        }
        if metadata.len() > max_bytes {
            return Err(BenchError::BlobTooLarge {
                digest: hex.to_string(),
                declared_bytes: metadata.len(),
                max_bytes,
            });
        }
        let mut file = fs::File::open(&path).map_err(|e| BenchError::io(&path, e))?;
        let mut bytes = Vec::new();
        std::io::Read::by_ref(&mut file)
            .take(max_bytes.saturating_add(1))
            .read_to_end(&mut bytes)
            .map_err(|e| BenchError::io(&path, e))?;
        if bytes.len() as u64 > max_bytes {
            return Err(BenchError::BlobTooLarge {
                digest: hex.to_string(),
                declared_bytes: bytes.len() as u64,
                max_bytes,
            });
        }
        let actual = sha256_hex(&bytes);
        if actual != hex {
            return Err(BenchError::Integrity(format!(
                "blob {hex} failed digest verification (got {actual})"
            )));
        }
        Ok(bytes)
    }

    /// Stream a snapshot blob into `destination` with a hard byte limit and fail-closed proof.
    ///
    /// `content` supplies both immutable claims made by the snapshot: SHA-256 and byte length.
    /// The cancellation callback is polled before opening the blob, around every bounded read,
    /// and before returning success. The store's private backing path is never returned or
    /// included in errors from this API.
    ///
    /// A failure can leave a prefix in `destination`; callers must discard that destination
    /// unless this method returns [`VerifiedBlobCopy`]. The method does not flush the writer.
    pub fn copy_snapshot_blob_verified<W, C>(
        &self,
        content: &HeldContent,
        max_bytes: u64,
        destination: &mut W,
        mut is_cancelled: C,
    ) -> BenchResult<VerifiedBlobCopy>
    where
        W: Write,
        C: FnMut() -> bool,
    {
        if content.digest.algorithm != "sha256" {
            return Err(BenchError::Schema(
                "held content digest algorithm must be sha256".into(),
            ));
        }
        crate::types::validate_sha256_hex(&content.digest.hex)?;

        if content.byte_length > max_bytes {
            return Err(BenchError::BlobTooLarge {
                digest: content.digest.hex.clone(),
                declared_bytes: content.byte_length,
                max_bytes,
            });
        }
        if is_cancelled() {
            return Err(BenchError::BlobCopyCancelled {
                digest: content.digest.hex.clone(),
            });
        }

        let path = self.blob_path(&content.digest.hex);
        let mut source = match fs::File::open(&path) {
            Ok(source) => source,
            Err(source) if source.kind() == std::io::ErrorKind::NotFound => {
                return Err(BenchError::NotFound(format!("blob {}", content.digest.hex)));
            }
            Err(source) => {
                return Err(BenchError::BlobRead {
                    digest: content.digest.hex.clone(),
                    source,
                });
            }
        };

        let mut hasher = Sha256::new();
        let mut copied = 0_u64;
        let mut buffer = [0_u8; BLOB_COPY_BUFFER_BYTES];

        loop {
            if is_cancelled() {
                return Err(BenchError::BlobCopyCancelled {
                    digest: content.digest.hex.clone(),
                });
            }

            // Read one extra byte after the declared length to detect trailing corruption without
            // ever writing bytes beyond the caller's declared or configured bounds.
            let remaining = content.byte_length.saturating_sub(copied);
            let read_limit = if remaining == 0 {
                1
            } else {
                usize::try_from(remaining.min(buffer.len() as u64))
                    .expect("bounded by the fixed copy buffer")
            };
            let read =
                source
                    .read(&mut buffer[..read_limit])
                    .map_err(|source| BenchError::BlobRead {
                        digest: content.digest.hex.clone(),
                        source,
                    })?;
            if read == 0 {
                break;
            }
            if is_cancelled() {
                return Err(BenchError::BlobCopyCancelled {
                    digest: content.digest.hex.clone(),
                });
            }

            let next = copied.checked_add(read as u64).ok_or_else(|| {
                BenchError::Integrity(format!("blob {} byte count overflowed", content.digest.hex))
            })?;
            if next > content.byte_length {
                return Err(BenchError::Integrity(format!(
                    "blob {} length exceeds manifest {}",
                    content.digest.hex, content.byte_length
                )));
            }
            if next > max_bytes {
                return Err(BenchError::BlobTooLarge {
                    digest: content.digest.hex.clone(),
                    declared_bytes: next,
                    max_bytes,
                });
            }

            destination
                .write_all(&buffer[..read])
                .map_err(|source| BenchError::BlobWrite { source })?;
            hasher.update(&buffer[..read]);
            copied = next;
        }

        if is_cancelled() {
            return Err(BenchError::BlobCopyCancelled {
                digest: content.digest.hex.clone(),
            });
        }
        if copied != content.byte_length {
            return Err(BenchError::Integrity(format!(
                "blob {} length {} does not match manifest {}",
                content.digest.hex, copied, content.byte_length
            )));
        }

        let actual = format!("{:x}", hasher.finalize());
        if actual != content.digest.hex {
            return Err(BenchError::Integrity(format!(
                "blob {} failed digest verification (got {actual})",
                content.digest.hex
            )));
        }

        Ok(VerifiedBlobCopy {
            digest: content.digest.clone(),
            byte_length: copied,
        })
    }

    /// Verify every held snapshot blob without allocating a blob in memory.
    ///
    /// Verification streams each backing file through a bounded buffer, so a
    /// large or corrupt blob costs time but never a proportional allocation.
    /// The declared manifest length is the read bound: a file longer than its
    /// manifest is rejected after one extra byte instead of being read whole.
    pub fn verify_snapshot_blobs(&self, snapshot: &EvidenceSnapshot) -> BenchResult<()> {
        self.verify_snapshot_blobs_cancellable(snapshot, || false)
    }

    /// [`Self::verify_snapshot_blobs`] with a cancellation poll between chunks.
    pub fn verify_snapshot_blobs_cancellable<C>(
        &self,
        snapshot: &EvidenceSnapshot,
        mut is_cancelled: C,
    ) -> BenchResult<()>
    where
        C: FnMut() -> bool,
    {
        for item in &snapshot.items {
            if let Some(content) = item.held_content() {
                self.verify_held_content_streamed(content, &mut is_cancelled)?;
            }
        }
        Ok(())
    }

    /// Check every held blob's declared size against explicit bounds before
    /// any backing file is opened, then verify the snapshot by streaming.
    ///
    /// This is the entry point for callers that publish byte limits: the
    /// manifest is metadata only, so an oversized snapshot is refused before
    /// the store touches a single blob byte.
    pub fn get_snapshot_bounded<C>(
        &self,
        snapshot_id: &str,
        max_blob_bytes: u64,
        max_aggregate_bytes: u64,
        mut is_cancelled: C,
    ) -> BenchResult<EvidenceSnapshot>
    where
        C: FnMut() -> bool,
    {
        let snapshot = EvidenceSnapshot::parse_json(&self.read_entity("snapshots", snapshot_id)?)?;
        let mut aggregate = 0_u64;
        for item in &snapshot.items {
            let Some(content) = item.held_content() else {
                continue;
            };
            if content.byte_length > max_blob_bytes {
                return Err(BenchError::BlobTooLarge {
                    digest: content.digest.hex.clone(),
                    declared_bytes: content.byte_length,
                    max_bytes: max_blob_bytes,
                });
            }
            aggregate = aggregate.checked_add(content.byte_length).ok_or_else(|| {
                BenchError::BlobTooLarge {
                    digest: content.digest.hex.clone(),
                    declared_bytes: u64::MAX,
                    max_bytes: max_aggregate_bytes,
                }
            })?;
            if aggregate > max_aggregate_bytes {
                return Err(BenchError::BlobTooLarge {
                    digest: content.digest.hex.clone(),
                    declared_bytes: aggregate,
                    max_bytes: max_aggregate_bytes,
                });
            }
        }
        self.verify_snapshot_blobs_cancellable(&snapshot, &mut is_cancelled)?;
        Ok(snapshot)
    }

    fn verify_held_content_streamed<C>(
        &self,
        content: &HeldContent,
        is_cancelled: &mut C,
    ) -> BenchResult<()>
    where
        C: FnMut() -> bool,
    {
        if content.digest.algorithm != "sha256" {
            return Err(BenchError::Schema(
                "held content digest algorithm must be sha256".into(),
            ));
        }
        crate::types::validate_sha256_hex(&content.digest.hex)?;
        if is_cancelled() {
            return Err(BenchError::BlobCopyCancelled {
                digest: content.digest.hex.clone(),
            });
        }

        let path = self.blob_path(&content.digest.hex);
        let file = fs::File::open(&path).map_err(|e| BenchError::io(&path, e))?;
        // One byte past the manifest length is enough to prove an overlong
        // file without reading the rest of it.
        let mut reader = file.take(content.byte_length.saturating_add(1));
        let mut hasher = Sha256::new();
        let mut buffer = [0_u8; BLOB_COPY_BUFFER_BYTES];
        let mut read_bytes = 0_u64;
        loop {
            if is_cancelled() {
                return Err(BenchError::BlobCopyCancelled {
                    digest: content.digest.hex.clone(),
                });
            }
            let read = reader
                .read(&mut buffer)
                .map_err(|e| BenchError::io(&path, e))?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
            read_bytes = read_bytes.checked_add(read as u64).ok_or_else(|| {
                BenchError::Integrity(format!("blob {} byte count overflowed", content.digest.hex))
            })?;
        }

        if read_bytes > content.byte_length {
            return Err(BenchError::Integrity(format!(
                "blob {} length exceeds manifest {}",
                content.digest.hex, content.byte_length
            )));
        }
        // Digest first, so a mutated blob reports tampering rather than the
        // length difference that tampering happens to produce.
        let actual = format!("{:x}", hasher.finalize());
        if actual != content.digest.hex {
            return Err(BenchError::Integrity(format!(
                "blob {} failed digest verification (got {actual})",
                content.digest.hex
            )));
        }
        if read_bytes != content.byte_length {
            return Err(BenchError::Integrity(format!(
                "blob {} length {} does not match manifest {}",
                content.digest.hex, read_bytes, content.byte_length
            )));
        }
        Ok(())
    }

    pub fn put_case(&self, case: &Case) -> BenchResult<()> {
        case.validate()?;
        atomic_write_json(&self.entity_path("cases", &case.case_id), case)
    }

    pub fn get_case(&self, case_id: &str) -> BenchResult<Case> {
        Case::parse_json(&self.read_entity("cases", case_id)?)
    }

    pub fn list_cases(&self) -> BenchResult<Vec<String>> {
        list_ids(&self.root.join("cases"))
    }

    pub fn load_cases(&self) -> BenchResult<Vec<Case>> {
        let mut cases = Vec::new();
        for id in self.list_cases()? {
            cases.push(self.get_case(&id)?);
        }
        Ok(cases)
    }

    pub fn put_snapshot(&self, snapshot: &EvidenceSnapshot) -> BenchResult<()> {
        self.with_write_lock(|| {
            snapshot.validate()?;
            self.verify_snapshot_blobs(snapshot)?;
            atomic_write_json(
                &self.entity_path("snapshots", &snapshot.snapshot_id),
                snapshot,
            )
        })
    }

    pub fn get_snapshot(&self, snapshot_id: &str) -> BenchResult<EvidenceSnapshot> {
        let snapshot = EvidenceSnapshot::parse_json(&self.read_entity("snapshots", snapshot_id)?)?;
        self.verify_snapshot_blobs(&snapshot)?;
        Ok(snapshot)
    }

    pub fn list_snapshots(&self) -> BenchResult<Vec<String>> {
        list_ids(&self.root.join("snapshots"))
    }

    pub fn put_task(&self, task: &EvaluationTask) -> BenchResult<()> {
        task.validate()?;
        let snapshot = self.get_snapshot(&task.snapshot_id)?;
        let case = self.get_case(&task.case_id)?;
        let derived = materialize_task_packet(&case, &snapshot, task)?;
        if task.privacy.is_downgrade_from(derived.privacy) {
            return Err(BenchError::Privacy(
                "share_safe task would downgrade owner_only case, snapshot, or selected evidence"
                    .into(),
            ));
        }
        atomic_write_json(&self.entity_path("tasks", &task.task_id), task)
    }

    pub fn get_task(&self, task_id: &str) -> BenchResult<EvaluationTask> {
        EvaluationTask::parse_json(&self.read_entity("tasks", task_id)?)
    }

    pub fn list_tasks(&self) -> BenchResult<Vec<String>> {
        list_ids(&self.root.join("tasks"))
    }

    pub fn materialize_packet(&self, task_id: &str) -> BenchResult<TaskPacket> {
        let task = self.get_task(task_id)?;
        let case = self.get_case(&task.case_id)?;
        let snapshot = self.get_snapshot(&task.snapshot_id)?;
        let packet = materialize_task_packet(&case, &snapshot, &task)?;
        atomic_write_json(&self.entity_path("packets", &packet.packet_id), &packet)?;
        Ok(packet)
    }

    pub fn get_packet(&self, packet_id: &str) -> BenchResult<TaskPacket> {
        let packet = TaskPacket::parse_json(&self.read_entity("packets", packet_id)?)?;
        let task = self.get_task(&packet.task_id)?;
        let case = self.get_case(&packet.case_id)?;
        let snapshot = self.get_snapshot(&packet.snapshot_id)?;
        let expected = materialize_task_packet(&case, &snapshot, &task)?;
        if packet != expected {
            return Err(BenchError::Privacy(
                "persisted task packet does not match privacy and content derived from its source records"
                    .into(),
            ));
        }
        Ok(packet)
    }

    pub fn put_run(&self, run: &TriageRun) -> BenchResult<PutRunOutcome> {
        self.with_write_lock(|| {
            self.validate_run_links(run)?;
            let raw_output =
                self.get_blob_bounded(&run.raw_output.digest.hex, MAX_RAW_INLINE_BYTES as u64)?;
            validate_run_raw_output(run, &raw_output)?;
            self.persist_validated_run(run)
        })
    }

    /// Validate and persist a run together with its exact raw output bytes.
    ///
    /// All deterministic run and linkage checks happen before the content-addressed blob is
    /// written. If this call creates the blob but the run record cannot be persisted, the blob is
    /// removed only after proving that no stored run references it. A blob that already existed is
    /// never removed by this operation.
    pub fn put_run_with_raw_output(
        &self,
        run: &TriageRun,
        raw_output: &[u8],
    ) -> BenchResult<PutRunOutcome> {
        self.with_write_lock(|| {
            self.validate_run_links(run)?;
            validate_run_raw_output(run, raw_output)?;

            let blob = self.put_blob_tracked(raw_output)?;
            debug_assert_eq!(blob.digest, run.raw_output.digest);

            match self.persist_validated_run(run) {
                Ok(outcome) => Ok(outcome),
                Err(run_error) if blob.created => {
                    if self
                        .remove_blob_if_unreferenced(&run.raw_output.digest)
                        .is_err()
                    {
                        return Err(BenchError::Message(
                            "run persistence failed and the newly-created raw output blob could not be rolled back safely"
                                .into(),
                        ));
                    }
                    Err(run_error)
                }
                Err(run_error) => Err(run_error),
            }
        })
    }

    fn with_write_lock<T>(&self, operation: impl FnOnce() -> BenchResult<T>) -> BenchResult<T> {
        let path = self.root.join(".write.lock");
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)
            .map_err(|source| BenchError::io(&path, source))?;
        lock.lock_exclusive()
            .map_err(|source| BenchError::io(&path, source))?;
        let result = operation();
        drop(lock);
        result
    }

    fn validate_run_links(&self, run: &TriageRun) -> BenchResult<()> {
        run.validate()?;
        let task = self.get_task(&run.task_id)?;
        if run.snapshot_id != task.snapshot_id {
            return Err(BenchError::CrossSnapshot(format!(
                "run snapshot {} does not match task snapshot {}",
                run.snapshot_id, task.snapshot_id
            )));
        }
        if run.case_id != task.case_id {
            return Err(BenchError::Schema(
                "run.case_id does not match task.case_id".into(),
            ));
        }
        let case = self.get_case(&task.case_id)?;
        let snapshot = self.get_snapshot(&task.snapshot_id)?;
        let task_packet = materialize_task_packet(&case, &snapshot, &task)?;
        if run.privacy.is_downgrade_from(task_packet.privacy) {
            return Err(BenchError::Privacy(
                "share_safe run would downgrade an owner_only task packet".into(),
            ));
        }
        Ok(())
    }

    fn persist_validated_run(&self, run: &TriageRun) -> BenchResult<PutRunOutcome> {
        let path = self.entity_path("runs", &run.run_id);
        if path.exists() {
            let existing = TriageRun::parse_json(&self.read_entity("runs", &run.run_id)?)?;
            // Same fingerprint/id: first write wins. Never overwrite.
            return Ok(PutRunOutcome::Duplicate {
                run_id: existing.run_id,
            });
        }
        atomic_write_json(&path, run)?;
        Ok(PutRunOutcome::Created {
            run_id: run.run_id.clone(),
        })
    }

    fn remove_blob_if_unreferenced(&self, digest: &ContentDigest) -> BenchResult<()> {
        for run_id in self.list_runs()? {
            let stored_run = self.get_run(&run_id)?;
            if stored_run.raw_output.digest == *digest {
                return Ok(());
            }
        }

        let path = self.blob_path(&digest.hex);
        match fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(source) if source.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(source) => Err(BenchError::io(&path, source)),
        }
    }

    pub fn get_run(&self, run_id: &str) -> BenchResult<TriageRun> {
        TriageRun::parse_json(&self.read_entity("runs", run_id)?)
    }

    pub fn list_runs(&self) -> BenchResult<Vec<String>> {
        list_ids(&self.root.join("runs"))
    }

    pub fn load_runs(&self) -> BenchResult<Vec<TriageRun>> {
        let mut runs = Vec::new();
        for id in self.list_runs()? {
            runs.push(self.get_run(&id)?);
        }
        Ok(runs)
    }

    pub fn materialize_review_packet(
        &self,
        run_id: &str,
        phase: ReviewPhase,
    ) -> BenchResult<ReviewPacket> {
        let run = self.get_run(run_id)?;
        let task = self.get_task(&run.task_id)?;
        let case = self.get_case(&run.case_id)?;
        let snapshot = self.get_snapshot(&run.snapshot_id)?;
        let raw = self.get_blob_bounded(&run.raw_output.digest.hex, MAX_RAW_INLINE_BYTES as u64)?;
        let support_recorded = run_has_support_adjudication(&self.load_adjudications()?, run_id);
        let packet = materialize_review_packet(
            &case,
            &snapshot,
            &task,
            &run,
            &raw,
            phase,
            support_recorded,
        )?;
        atomic_write_json(
            &self.entity_path("review-packets", &packet.packet_id),
            &packet,
        )?;
        Ok(packet)
    }

    pub fn get_review_packet(&self, packet_id: &str) -> BenchResult<ReviewPacket> {
        let text = self.read_entity("review-packets", packet_id)?;
        let packet = ReviewPacket::parse_json(&text)?;
        let run = self.get_run(&packet.run_id)?;
        let task = self.get_task(&packet.task_id)?;
        let case = self.get_case(&packet.case_id)?;
        let snapshot = self.get_snapshot(&packet.snapshot_id)?;
        let raw = self.get_blob_bounded(&run.raw_output.digest.hex, MAX_RAW_INLINE_BYTES as u64)?;
        let support_recorded = packet.phase == ReviewPhase::Support
            || run_has_support_adjudication(&self.load_adjudications()?, &packet.run_id);
        let expected = materialize_review_packet(
            &case,
            &snapshot,
            &task,
            &run,
            &raw,
            packet.phase,
            support_recorded,
        )?;
        if packet != expected {
            return Err(BenchError::Privacy(
                "persisted review packet does not match privacy and content derived from its source records"
                    .into(),
            ));
        }
        Ok(packet)
    }

    pub fn import_adjudication(&self, adj: Adjudication) -> BenchResult<ScoreReview> {
        let run = self.get_run(&adj.run_id)?;
        let snapshot = self.get_snapshot(&run.snapshot_id)?;
        let item_ids = snapshot
            .items
            .iter()
            .map(|item| item.item_id().to_string())
            .collect();
        let flags = citation_assist_flags(&item_ids, &run.claims);
        let adj = merge_citation_assists(adj, flags)?;
        self.put_adjudication(&adj)
    }

    pub fn put_adjudication(&self, adj: &Adjudication) -> BenchResult<ScoreReview> {
        adj.validate()?;
        let run = self.get_run(&adj.run_id)?;
        if run.task_id != adj.task_id
            || run.snapshot_id != adj.snapshot_id
            || run.case_id != adj.case_id
        {
            return Err(BenchError::CrossSnapshot(
                "adjudication identities do not match the run".into(),
            ));
        }
        let phase = adj.phase.ok_or_else(|| {
            BenchError::Schema(
                "new adjudications must declare phase and bind a generated review packet; diagnosis also requires a prior support-phase review".into(),
            )
        })?;
        let packet_id = adj.review_packet_id.as_deref().ok_or_else(|| {
            BenchError::Schema(
                "new adjudications must declare phase and bind a generated review packet; diagnosis also requires a prior support-phase review".into(),
            )
        })?;
        if adj.schema_id != crate::types::ADJUDICATION_SCHEMA_V2 {
            return Err(BenchError::Schema(
                "new adjudications must use adjudication.v2 when packet-bound".into(),
            ));
        }
        let packet = self.get_review_packet(packet_id)?;
        if adj.privacy.is_downgrade_from(packet.privacy) {
            return Err(BenchError::Privacy(
                "share_safe adjudication would downgrade an owner_only review packet".into(),
            ));
        }
        if packet.phase != phase
            || packet.case_id != adj.case_id
            || packet.task_id != adj.task_id
            || packet.snapshot_id != adj.snapshot_id
            || packet.run_id != adj.run_id
            || packet.blinding != adj.blinding
        {
            return Err(BenchError::Integrity(format!(
                "adjudication does not match its generated review packet (packet phase={:?}, case={}, task={}, snapshot={}, run={}, blinding={:?}; adjudication phase={:?}, case={}, task={}, snapshot={}, run={}, blinding={:?})",
                packet.phase,
                packet.case_id,
                packet.task_id,
                packet.snapshot_id,
                packet.run_id,
                packet.blinding,
                phase,
                adj.case_id,
                adj.task_id,
                adj.snapshot_id,
                adj.run_id,
                adj.blinding
            )));
        }
        if phase == ReviewPhase::Diagnosis {
            let existing = self.load_adjudications()?;
            let diagnosis_has_prior_support = existing.iter().any(|support| {
                support.run_id == adj.run_id
                    && support.reviewer == adj.reviewer
                    && support.phase == Some(ReviewPhase::Support)
                    && support
                        .created_at
                        .parse::<chrono::DateTime<chrono::FixedOffset>>()
                        .ok()
                        .zip(
                            adj.created_at
                                .parse::<chrono::DateTime<chrono::FixedOffset>>()
                                .ok(),
                        )
                        .is_some_and(|(support_at, diagnosis_at)| support_at <= diagnosis_at)
            });
            if !diagnosis_has_prior_support {
                return Err(BenchError::Schema(
                    format!(
                        "diagnosis-phase adjudication requires a prior support-phase review by the same reviewer (existing: {:?})",
                        existing
                            .iter()
                            .map(|support| (
                                support.run_id.as_str(),
                                support.reviewer.as_str(),
                                support.rubric_version.as_str(),
                                support.phase,
                                support.created_at.as_str()
                            ))
                            .collect::<Vec<_>>()
                    ),
                ));
            }
        }
        let case = self.get_case(&adj.case_id)?;
        if !case.diagnosis_is_applicable() {
            match adj.outcome(crate::types::RubricDimension::DiagnosisCorrectness) {
                Some(outcome)
                    if matches!(
                        outcome.verdict,
                        crate::types::DimensionVerdict::NotApplicable
                            | crate::types::DimensionVerdict::Unscorable { .. }
                    ) => {}
                _ => {
                    return Err(BenchError::Schema(
                        "diagnosis_correctness must be n/a or unscorable when the case has no adjudicated root cause".into(),
                    ));
                }
            }
        }
        atomic_write_json(
            &self.entity_path("adjudications", &adj.adjudication_id),
            adj,
        )?;
        let score = adj.to_score_review()?;
        atomic_write_json(&self.entity_path("scores", &score.score_id), &score)?;
        Ok(score)
    }

    pub fn get_adjudication(&self, id: &str) -> BenchResult<Adjudication> {
        Adjudication::parse_json(&self.read_entity("adjudications", id)?)
    }

    pub fn list_adjudications(&self) -> BenchResult<Vec<String>> {
        list_ids(&self.root.join("adjudications"))
    }

    pub fn load_adjudications(&self) -> BenchResult<Vec<Adjudication>> {
        let mut items = Vec::new();
        for id in self.list_adjudications()? {
            items.push(self.get_adjudication(&id)?);
        }
        Ok(items)
    }

    pub fn get_score(&self, id: &str) -> BenchResult<ScoreReview> {
        ScoreReview::parse_json(&self.read_entity("scores", id)?)
    }

    pub fn list_scores(&self) -> BenchResult<Vec<String>> {
        list_ids(&self.root.join("scores"))
    }

    pub fn load_scores(&self) -> BenchResult<Vec<ScoreReview>> {
        let mut items = Vec::new();
        for id in self.list_scores()? {
            items.push(self.get_score(&id)?);
        }
        Ok(items)
    }

    pub fn put_gold(&self, gold: &GoldReference) -> BenchResult<()> {
        gold.validate()?;
        atomic_write_json(&self.entity_path("golds", &gold.gold_id), gold)
    }

    pub fn get_gold(&self, gold_id: &str) -> BenchResult<GoldReference> {
        GoldReference::parse_json(&self.read_entity("golds", gold_id)?)
    }

    pub fn list_golds(&self) -> BenchResult<Vec<String>> {
        list_ids(&self.root.join("golds"))
    }

    pub fn load_golds(&self) -> BenchResult<Vec<GoldReference>> {
        let mut items = Vec::new();
        for id in self.list_golds()? {
            items.push(self.get_gold(&id)?);
        }
        items.sort_by(|a, b| a.version.cmp(&b.version).then(a.gold_id.cmp(&b.gold_id)));
        Ok(items)
    }

    pub fn put_trace(&self, trace: &InteractionTrace) -> BenchResult<()> {
        trace.validate()?;
        atomic_write_json(&self.entity_path("traces", &trace.trace_id), trace)
    }

    pub fn get_trace(&self, trace_id: &str) -> BenchResult<InteractionTrace> {
        InteractionTrace::parse_json(&self.read_entity("traces", trace_id)?)
    }

    pub fn list_traces(&self) -> BenchResult<Vec<String>> {
        list_ids(&self.root.join("traces"))
    }

    pub fn load_traces(&self) -> BenchResult<Vec<InteractionTrace>> {
        let mut items = Vec::new();
        for id in self.list_traces()? {
            items.push(self.get_trace(&id)?);
        }
        items.sort_by(|a, b| {
            a.candidate_id
                .cmp(&b.candidate_id)
                .then(a.trace_id.cmp(&b.trace_id))
        });
        Ok(items)
    }

    fn entity_path(&self, kind: &str, id: &str) -> PathBuf {
        self.root.join(kind).join(format!("{id}.json"))
    }

    fn blob_path(&self, hex: &str) -> PathBuf {
        self.root.join("blobs/sha256").join(&hex[..2]).join(hex)
    }

    fn read_entity(&self, kind: &str, id: &str) -> BenchResult<String> {
        crate::types::validate_id(kind, id)?;
        let path = self.entity_path(kind, id);
        fs::read_to_string(&path).map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                BenchError::NotFound(format!("{kind}/{id}"))
            } else {
                BenchError::io(&path, e)
            }
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PutRunOutcome {
    Created { run_id: String },
    Duplicate { run_id: String },
}

struct PutBlobOutcome {
    digest: ContentDigest,
    created: bool,
}

fn validate_run_raw_output(run: &TriageRun, raw_output: &[u8]) -> BenchResult<()> {
    if raw_output.len() > MAX_RAW_INLINE_BYTES {
        return Err(BenchError::BlobTooLarge {
            digest: run.raw_output.digest.hex.clone(),
            declared_bytes: raw_output.len() as u64,
            max_bytes: MAX_RAW_INLINE_BYTES as u64,
        });
    }
    if raw_output.len() as u64 != run.raw_output.byte_length {
        return Err(BenchError::Integrity(
            "raw output byte length does not match the run manifest".into(),
        ));
    }
    if ContentDigest::of_bytes(raw_output) != run.raw_output.digest {
        return Err(BenchError::Integrity(
            "raw output digest does not match the run manifest".into(),
        ));
    }
    Ok(())
}

fn verify_existing_blob_bytes(
    path: &Path,
    digest: &ContentDigest,
    expected: &[u8],
) -> BenchResult<()> {
    let existing = fs::read(path).map_err(|source| BenchError::io(path, source))?;
    if existing.as_slice() != expected {
        return Err(BenchError::Integrity(format!(
            "blob {} already exists with different bytes",
            digest.hex
        )));
    }
    Ok(())
}

fn list_ids(dir: &Path) -> BenchResult<Vec<String>> {
    let mut ids = Vec::new();
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(ids),
        Err(err) => return Err(BenchError::io(dir, err)),
    };
    for entry in entries {
        let entry = entry.map_err(|e| BenchError::io(dir, e))?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if let Some(id) = name.strip_suffix(".json") {
            ids.push(id.to_string());
        }
    }
    ids.sort();
    Ok(ids)
}

fn atomic_write_json<T: Serialize>(path: &Path, value: &T) -> BenchResult<()> {
    let bytes = to_pretty_json(value)?.into_bytes();
    atomic_write_bytes(path, &bytes)
}

fn atomic_write_bytes(path: &Path, bytes: &[u8]) -> BenchResult<()> {
    if path.exists() {
        let existing = fs::read(path).map_err(|e| BenchError::io(path, e))?;
        if existing.as_slice() == bytes {
            return Ok(());
        }
        return Err(BenchError::Immutable(format!(
            "{} already exists with different content",
            path.file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("record")
        )));
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| BenchError::io(parent, e))?;
    }
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes).map_err(|e| BenchError::io(&tmp, e))?;
    fs::rename(&tmp, path).map_err(|e| BenchError::io(path, e))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{
        CaseLifecycle, ContentDigest, EvidenceItem, EvidenceSource, HeldContent, PrivacyClass,
        ReportedProblem, VisibilityPolicy,
    };

    fn temp_store() -> (tempfile::TempDir, BenchStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = BenchStore::init(dir.path(), "2026-01-15T00:00:00Z").unwrap();
        (dir, store)
    }

    #[test]
    fn write_lock_serializes_mutations_across_store_handles() {
        let (_dir, store) = temp_store();
        let lock_path = store.root().join(".write.lock");
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(lock_path)
            .unwrap();
        lock.lock_exclusive().unwrap();

        let worker_store = store.clone();
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (finished_tx, finished_rx) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            started_tx.send(()).unwrap();
            let result = worker_store.put_blob(b"serialized-write");
            finished_tx.send(result).unwrap();
        });

        started_rx
            .recv_timeout(std::time::Duration::from_secs(1))
            .unwrap();
        assert!(
            finished_rx
                .recv_timeout(std::time::Duration::from_millis(50))
                .is_err(),
            "mutation completed while another store handle held the write lock"
        );
        drop(lock);

        let digest = finished_rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap()
            .unwrap();
        worker.join().unwrap();
        assert_eq!(store.get_blob(&digest.hex).unwrap(), b"serialized-write");
    }

    #[test]
    fn mutated_blob_fails_closed() {
        let (_dir, store) = temp_store();
        let digest = store.put_blob(b"hello").unwrap();
        let path = store.blob_path(&digest.hex);
        fs::write(&path, b"mutated").unwrap();
        let err = store.get_blob(&digest.hex).unwrap_err();
        assert!(err.to_string().contains("digest verification"));
    }

    #[test]
    fn case_overwrite_with_different_bytes_is_rejected() {
        let (_dir, store) = temp_store();
        let mut case = Case {
            schema_id: crate::types::CASE_SCHEMA_V1.into(),
            case_id: "case-1".into(),
            privacy: PrivacyClass::OwnerOnly,
            title: "one".into(),
            reported_problem: ReportedProblem {
                summary: "s".into(),
                reported_at: None,
                reporter: None,
                symptoms: vec![],
            },
            lifecycle: CaseLifecycle::Unresolved,
            timeline_notes: vec![],
            created_at: "2026-01-15T00:00:00Z".into(),
            resolution: None,
        };
        store.put_case(&case).unwrap();
        case.title = "two".into();
        let err = store.put_case(&case).unwrap_err();
        assert!(matches!(err, BenchError::Immutable(_)));
    }

    #[test]
    fn snapshot_put_requires_matching_blob() {
        let (_dir, store) = temp_store();
        store
            .put_case(&Case {
                schema_id: crate::types::CASE_SCHEMA_V1.into(),
                case_id: "case-1".into(),
                privacy: PrivacyClass::OwnerOnly,
                title: "one".into(),
                reported_problem: ReportedProblem {
                    summary: "s".into(),
                    reported_at: None,
                    reporter: None,
                    symptoms: vec![],
                },
                lifecycle: CaseLifecycle::Unresolved,
                timeline_notes: vec![],
                created_at: "2026-01-15T00:00:00Z".into(),
                resolution: None,
            })
            .unwrap();
        let bytes = b"log-bytes";
        let snapshot = EvidenceSnapshot::from_parts(
            PrivacyClass::OwnerOnly,
            "case-1".into(),
            "2026-01-15T06:00:00Z".into(),
            "op".into(),
            vec![EvidenceItem::Log {
                item_id: "ev-log-1".into(),
                privacy: PrivacyClass::OwnerOnly,
                capture_time: "2026-01-15T04:12:00Z".into(),
                source: EvidenceSource {
                    reference: "app.log".into(),
                    captured_from: "fixture".into(),
                },
                media_type: "text/plain".into(),
                format: "raw".into(),
                content: HeldContent {
                    digest: ContentDigest::of_bytes(bytes),
                    byte_length: bytes.len() as u64,
                },
                summaries: vec![],
                visible_to_strategies: true,
            }],
            None,
        )
        .unwrap();
        let err = store.put_snapshot(&snapshot).unwrap_err();
        assert!(
            matches!(err, BenchError::Io { .. } | BenchError::NotFound(_))
                || err.to_string().contains("blobs")
                || err.to_string().contains("io")
        );
        store.put_blob(bytes).unwrap();
        store.put_snapshot(&snapshot).unwrap();
        let task = EvaluationTask::from_parts(
            PrivacyClass::OwnerOnly,
            "case-1".into(),
            snapshot.snapshot_id.clone(),
            "What failed?".into(),
            "visible evidence only".into(),
            "v1".into(),
            VisibilityPolicy {
                visible_item_ids: vec!["ev-log-1".into()],
                include_summaries: false,
                include_raw_bytes: true,
            },
            None,
            "2026-01-15T07:00:00Z".into(),
        )
        .unwrap();
        store.put_task(&task).unwrap();
        let packet = store.materialize_packet(&task.task_id).unwrap();
        assert!(!serde_json::to_string(&packet)
            .unwrap()
            .contains("resolution"));
    }
}
