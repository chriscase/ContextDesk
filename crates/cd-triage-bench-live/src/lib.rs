//! Run-exclusive bridge from a source-neutral benchmark snapshot to the real
//! ContextDesk triage host.
//!
//! The default adapter remains dependency-light and offline. This separate,
//! intentionally heavy crate owns the filesystem, DuckDB, host, provider, and
//! lifecycle boundary required for live execution.

#![forbid(unsafe_code)]
#![deny(missing_docs)]

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use cd_core::config::AppConfig;
use cd_core::index::KeywordIndex;
use cd_core::keychain_store::SecretStore;
use cd_core::log_analysis::embed_policy::{LogEmbedMode, LogEmbedPolicy};
use cd_core::log_analysis::import_preview::{preview_import_plan, verify_import_plan};
use cd_core::log_analysis::ingest::ingest_path_with_policy_selection_and_observer_managed;
use cd_core::log_analysis::store::LogCorpus;
use cd_core::log_analysis::{query_source_catalog, LogSourceCatalogQuery};
use cd_core::process_progress::{CancelFlag, NoopProcessProgress};
use cd_core::tool_host::ToolHost;
use cd_core::triage_policy_store::TriagePolicyStoreV1;
use cd_core::triage_role_qualification::TriageRoleQualificationStoreV1;
use cd_core::workspace::Workspace;
use cd_triage_bench::{BenchStore, Case, EvaluationTask, EvidenceSnapshot};
use cd_triage_bench_adapter::{
    build_live_request, fingerprint, materialize_bounded_packet, record_live_public_replay,
    BoundedPacket, HostExecutionProof, HostPacketEvidenceBinding, HostSourceBinding,
    RecordedContextDeskRun, RecordingContext,
};
use cd_triage_runtime::{triage, triage_with_policy, TriageEventSink};
use cd_triage_sdk::{PacketPrivacyBoundary, TriagePolicySelectionV2, TriageRequestOverridesV1};
use cd_workflow::triage_host::{
    TriageExecutedPacketProofV1, TriagePacketProofObserverErrorV1, TriagePacketProofObserverV1,
};
use cd_workflow::triage_runtime_host::{TriageCancellationRegistryV1, WorkflowTriageEngineV1};
use fs2::FileExt;

/// Default per-source limit. It matches the production raw-log import bound.
pub const DEFAULT_LIVE_MAX_BLOB_BYTES: u64 = 512 * 1024 * 1024;
/// Default aggregate source-byte limit for one isolated live run.
pub const DEFAULT_LIVE_MAX_AGGREGATE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// Maximum number of candidate runs in one same-snapshot comparison.
pub const DEFAULT_MAX_COMPARISON_CANDIDATES: usize = 16;
/// Default whole-comparison deadline when candidates omit an override.
///
/// This matches the host's Standard deadline and bounds source preparation as
/// well as sequential candidate execution. An omitted override must never
/// make the blocking preparation phase unbounded.
pub const DEFAULT_LIVE_COMPARISON_DEADLINE_MS: u64 = 180_000;
const PREPARATION_RUNNING: u8 = 0;
const PREPARATION_COMPLETED: u8 = 1;
const PREPARATION_TIMED_OUT: u8 = 2;
const CLEANUP_MARKER_DIR: &str = ".triage-bench-live-cleanup";
const CLEANUP_LEASE_DIR: &str = ".triage-bench-live-leases";
const MAX_CLEANUP_MARKERS: usize = 1_024;
const MAX_CLEANUP_MARKER_BYTES: u64 = 256;
const MAX_CLEANUP_CORPORA: usize = 4_096;

/// Resource bounds applied before any live host or provider operation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LiveCorpusLimits {
    /// Maximum bytes copied from one benchmark blob.
    pub max_blob_bytes: u64,
    /// Maximum total bytes copied across all visible blobs.
    pub max_aggregate_bytes: u64,
}

impl Default for LiveCorpusLimits {
    fn default() -> Self {
        Self {
            max_blob_bytes: DEFAULT_LIVE_MAX_BLOB_BYTES,
            max_aggregate_bytes: DEFAULT_LIVE_MAX_AGGREGATE_BYTES,
        }
    }
}

/// Content-free refusal categories for the live bridge.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum LiveBridgeError {
    /// Benchmark identity, visibility, or blob verification failed.
    #[error("benchmark evidence verification failed")]
    Benchmark,
    /// The requested visibility cannot be reproduced by live bridge v1.
    #[error("task visibility is unsupported by the live bridge")]
    UnsupportedVisibility,
    /// A configured per-source or aggregate byte bound was exceeded.
    #[error("live evidence byte bound exceeded")]
    BoundExceeded,
    /// Cancellation was requested before corpus preparation completed.
    #[error("live bridge preparation cancelled")]
    Cancelled,
    /// Private staging could not be created or written.
    #[error("private live staging failed")]
    Staging,
    /// Production import preview or verified selection failed.
    #[error("live corpus import preview failed")]
    Preview,
    /// Production ingest failed.
    #[error("live corpus import failed")]
    Import,
    /// The imported corpus did not exactly match the visible source inventory.
    #[error("live corpus provenance verification failed")]
    Provenance,
    /// The explicit whole-run deadline elapsed.
    #[error("live triage deadline elapsed")]
    Deadline,
    /// The public workflow runtime could not produce an authoritative replay.
    #[error("live triage execution failed")]
    Execution,
    /// The isolated corpus could not be bound into a valid public request.
    #[error("live triage request binding failed")]
    Request,
    /// The replay or packet proof could not be recorded without weakening provenance.
    #[error("live triage recording failed")]
    Recording,
    /// The verified recorded run could not be persisted to the benchmark store.
    #[error("live benchmark persistence failed")]
    Persistence,
    /// The run-exclusive corpus could not be discarded.
    #[error("live corpus cleanup failed")]
    Cleanup,
    /// The primary run failed and cleanup also failed; neither fact is hidden.
    #[error("live triage failed and isolated corpus cleanup also failed")]
    FailureAndCleanup,
    /// A comparison was requested without any candidates.
    #[error("live triage comparison has no candidates")]
    EmptyComparison,
    /// A comparison exceeded its bounded candidate count.
    #[error("live triage comparison candidate bound exceeded")]
    ComparisonCandidateBound,
    /// Candidate options could not share one exact preparation safely.
    #[error("live triage comparison candidates are not safely shareable")]
    ComparisonInvariant,
}

/// Host-owned execution configuration for one live benchmark run.
#[derive(Debug, Clone)]
pub struct LiveRunOptions {
    /// ContextDesk cache root used only for this run's isolated corpus.
    pub cache_root: PathBuf,
    /// Existing non-secret provider and router configuration.
    pub config: AppConfig,
    /// Bounded saved-policy snapshot used by the workflow host.
    pub policies: TriagePolicyStoreV1,
    /// Bounded exact-role qualification snapshot used by the workflow host.
    pub qualifications: TriageRoleQualificationStoreV1,
    /// Public Standard, Saved, or Inline policy selection.
    pub policy: TriagePolicySelectionV2,
    /// Public deadline and provider-call overrides.
    pub overrides: TriageRequestOverridesV1,
    /// Caller-owned cancellation identity.
    pub cancellation_id: String,
    /// Bench strategy/operator/timestamp provenance.
    pub recording: RecordingContext,
    /// Pre-provider source-copy and aggregate limits.
    pub limits: LiveCorpusLimits,
    /// Shared cancellation signal spanning copy, import, and workflow execution.
    pub cancel: CancelFlag,
}

/// Completed and durably persisted live benchmark run.
#[derive(Debug, Clone, PartialEq)]
pub struct LiveRunResult {
    /// Proof-complete owner-only record and validated benchmark row.
    pub recorded: RecordedContextDeskRun,
}

/// One candidate in a same-snapshot live comparison.
///
/// Candidate options may select different policies, providers, or recording
/// identities. The cache root, source bounds, and cancellation signal must be
/// shared with every other candidate so preparation and cancellation remain a
/// single bounded operation.
#[derive(Debug)]
pub struct LiveComparisonCandidate {
    /// Host-owned options for this candidate execution.
    pub options: LiveRunOptions,
    /// Optional event sink for this candidate's validated public replay.
    pub events: Option<TriageEventSink>,
}

/// Completed runs from a same-snapshot comparison.
#[derive(Debug, Clone, PartialEq)]
pub struct LiveComparisonResult {
    /// Runs persisted by the bridge and ready for the honest bench report.
    pub runs: Vec<LiveRunResult>,
}

/// A verified, run-exclusive corpus prepared from one exact task visibility.
///
/// Dropping this value makes a best-effort discard. Call [`Self::cleanup`]
/// explicitly when cleanup failure must be surfaced to the operator.
#[derive(Debug)]
pub struct PreparedSameSnapshotCorpus {
    cache_root: PathBuf,
    corpus_id: Option<String>,
    cleanup_intent: Option<CleanupIntent>,
    bounded: BoundedPacket,
    corpus_revision: u64,
    source_bytes: u64,
    sources: Vec<HostSourceBinding>,
}

#[derive(Debug)]
struct CleanupIntent {
    marker_path: PathBuf,
    lease_path: PathBuf,
    lease: Option<File>,
}

impl PreparedSameSnapshotCorpus {
    /// Source-neutral packet materialized from the benchmark task.
    pub fn bounded(&self) -> &BoundedPacket {
        &self.bounded
    }

    /// Run-exclusive production corpus identity.
    pub fn corpus_id(&self) -> &str {
        self.corpus_id
            .as_deref()
            .expect("prepared corpus remains live until cleanup")
    }

    /// Exact event revision requested through the public SDK scope.
    pub fn corpus_revision(&self) -> u64 {
        self.corpus_revision
    }

    /// Exact aggregate source bytes copied and imported.
    pub fn source_bytes(&self) -> u64 {
        self.source_bytes
    }

    /// Complete, sorted one-to-one source-to-benchmark inventory.
    pub fn sources(&self) -> &[HostSourceBinding] {
        &self.sources
    }

    /// Discard the isolated corpus now and report cleanup failure.
    pub fn cleanup(mut self) -> Result<(), LiveBridgeError> {
        self.discard()
    }

    fn discard(&mut self) -> Result<(), LiveBridgeError> {
        let Some(corpus_id) = self.corpus_id.as_deref() else {
            return Ok(());
        };
        if LogCorpus::discard(&self.cache_root, corpus_id).is_err() {
            return Err(LiveBridgeError::Cleanup);
        }
        let Some(cleanup_intent) = self.cleanup_intent.as_mut() else {
            return Err(LiveBridgeError::Cleanup);
        };
        cleanup_intent.clear()?;
        self.corpus_id = None;
        self.cleanup_intent = None;
        Ok(())
    }
}

impl CleanupIntent {
    fn clear(&mut self) -> Result<(), LiveBridgeError> {
        drop(self.lease.take());
        match std::fs::remove_file(&self.marker_path) {
            Ok(()) => sync_directory(self.marker_path.parent().ok_or(LiveBridgeError::Cleanup)?)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(LiveBridgeError::Cleanup),
        }
        match std::fs::remove_file(&self.lease_path) {
            Ok(()) => {
                if let Some(parent) = self.lease_path.parent() {
                    sync_directory(parent)?;
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(LiveBridgeError::Cleanup),
        }
        Ok(())
    }
}

impl Drop for PreparedSameSnapshotCorpus {
    fn drop(&mut self) {
        let _ = self.discard();
    }
}

/// Copy, import, and prove exactly one task's visible benchmark evidence.
///
/// This stage performs no credential lookup and no provider operation. It
/// rejects any visibility shape the current broad-log host cannot reproduce:
/// summaries, time constraints, missing raw bytes, or external-only evidence.
pub fn prepare_same_snapshot_corpus(
    store: &BenchStore,
    case: &Case,
    snapshot: &EvidenceSnapshot,
    task: &EvaluationTask,
    cache_root: &Path,
    limits: LiveCorpusLimits,
    cancel: &CancelFlag,
) -> Result<PreparedSameSnapshotCorpus, LiveBridgeError> {
    if cancel.is_cancelled() {
        return Err(LiveBridgeError::Cancelled);
    }
    if !task.visibility.include_raw_bytes
        || task.visibility.include_summaries
        || task.time_constraint.is_some()
    {
        return Err(LiveBridgeError::UnsupportedVisibility);
    }
    let bounded =
        materialize_bounded_packet(case, snapshot, task).map_err(|_| LiveBridgeError::Benchmark)?;

    let mut aggregate_bytes = 0_u64;
    for item in &bounded.packet.evidence {
        if item.kind != "log" {
            return Err(LiveBridgeError::UnsupportedVisibility);
        }
        let Some(content) = &item.content else {
            return Err(LiveBridgeError::UnsupportedVisibility);
        };
        if content.byte_length > limits.max_blob_bytes {
            return Err(LiveBridgeError::BoundExceeded);
        }
        aggregate_bytes = aggregate_bytes
            .checked_add(content.byte_length)
            .ok_or(LiveBridgeError::BoundExceeded)?;
        if aggregate_bytes > limits.max_aggregate_bytes {
            return Err(LiveBridgeError::BoundExceeded);
        }
    }

    std::fs::create_dir_all(cache_root).map_err(|_| LiveBridgeError::Staging)?;
    retry_pending_live_cleanup(cache_root)?;
    let staging = tempfile::Builder::new()
        .prefix("contextdesk-triage-live-")
        .tempdir_in(cache_root)
        .map_err(|_| LiveBridgeError::Staging)?;
    restrict_directory(staging.path())?;

    let mut sources = Vec::with_capacity(bounded.packet.evidence.len());
    for (ordinal, item) in bounded.packet.evidence.iter().enumerate() {
        if cancel.is_cancelled() {
            return Err(LiveBridgeError::Cancelled);
        }
        let content = item
            .content
            .as_ref()
            .ok_or(LiveBridgeError::UnsupportedVisibility)?;
        let item_fingerprint =
            fingerprint("evf", &item.item_id).map_err(|_| LiveBridgeError::Benchmark)?;
        let source_label = format!("bench-{ordinal:04}-{item_fingerprint}.log");
        let path = staging.path().join(&source_label);
        let mut destination = private_destination(&path)?;
        store
            .copy_snapshot_blob_verified(content, limits.max_blob_bytes, &mut destination, || {
                cancel.is_cancelled()
            })
            .map_err(|error| match error {
                cd_triage_bench::BenchError::BlobCopyCancelled { .. } => LiveBridgeError::Cancelled,
                cd_triage_bench::BenchError::BlobTooLarge { .. } => LiveBridgeError::BoundExceeded,
                _ => LiveBridgeError::Benchmark,
            })?;
        destination.flush().map_err(|_| LiveBridgeError::Staging)?;
        sources.push(HostSourceBinding {
            source_label,
            evidence_item_id: item.item_id.clone(),
            content_digest: content.digest.wire(),
            byte_length: content.byte_length,
        });
    }
    sources.sort_by(|left, right| left.source_label.cmp(&right.source_label));

    let plan = preview_import_plan(staging.path(), Some(cancel))
        .map_err(|_| cancelled_or(cancel, LiveBridgeError::Preview))?;
    prove_preview(&plan.report, &sources)?;
    let selected = plan
        .report
        .items
        .iter()
        .map(|item| item.identity.clone())
        .collect::<Vec<_>>();
    let selection = verify_import_plan(
        staging.path(),
        plan.plan_version,
        &plan.plan_token,
        &selected,
        Some(cancel),
    )
    .map_err(|_| cancelled_or(cancel, LiveBridgeError::Preview))?;

    let policy = LogEmbedPolicy {
        mode: LogEmbedMode::None,
        ..LogEmbedPolicy::default()
    };
    let managed_identity = format!("triage-bench-live.{}", uuid::Uuid::now_v7());
    let mut cleanup_intent = record_cleanup_intent(cache_root, &managed_identity)?;
    let report = match ingest_path_with_policy_selection_and_observer_managed(
        cache_root,
        staging.path(),
        "ContextDesk triage benchmark live run",
        &policy,
        None,
        &NoopProcessProgress,
        Some(cancel),
        &managed_identity,
        &selection,
    ) {
        Ok(report) => report,
        Err(_) => {
            let error = cancelled_or(cancel, LiveBridgeError::Import);
            return match cleanup_intent.clear() {
                Ok(()) => Err(error),
                Err(_) => Err(LiveBridgeError::FailureAndCleanup),
            };
        }
    };

    let mut prepared = PreparedSameSnapshotCorpus {
        cache_root: cache_root.to_path_buf(),
        corpus_id: Some(report.corpus_id.clone()),
        cleanup_intent: Some(cleanup_intent),
        bounded,
        corpus_revision: 0,
        source_bytes: aggregate_bytes,
        sources,
    };
    let verification = (|| {
        if cancel.is_cancelled() {
            return Err(LiveBridgeError::Cancelled);
        }
        prove_ingest_stats(&report.stats, &prepared.sources, aggregate_bytes)?;
        prove_ingest_digests(&report.source_digests, &prepared.sources)?;
        let corpus = LogCorpus::open(cache_root, &report.corpus_id)
            .map_err(|_| LiveBridgeError::Provenance)?;
        if corpus
            .meta()
            .map_err(|_| LiveBridgeError::Provenance)?
            .managed_identity
            .as_deref()
            != Some(managed_identity.as_str())
        {
            return Err(LiveBridgeError::Provenance);
        }
        prove_source_catalog(&corpus, &prepared.sources, cancel)?;
        let revision = corpus.revision();
        if revision == 0 {
            return Err(LiveBridgeError::Provenance);
        }
        prepared.corpus_revision = revision;
        Ok(())
    })();
    if let Err(error) = verification {
        return finish_with_cleanup(&mut prepared, Err(error));
    }
    Ok(prepared)
}

#[allow(clippy::too_many_arguments)]
async fn prepare_same_snapshot_with_deadline(
    store: &BenchStore,
    case: &Case,
    snapshot: &EvidenceSnapshot,
    task: &EvaluationTask,
    cache_root: &Path,
    limits: LiveCorpusLimits,
    cancel: &CancelFlag,
    deadline_ms: Option<u64>,
) -> Result<PreparedSameSnapshotCorpus, LiveBridgeError> {
    let worker_store = store.clone();
    let worker_case = case.clone();
    let worker_snapshot = snapshot.clone();
    let worker_task = task.clone();
    let worker_cache = cache_root.to_path_buf();
    let worker_cancel = cancel.clone();
    let preparation_state = Arc::new(AtomicU8::new(PREPARATION_RUNNING));
    let worker_state = Arc::clone(&preparation_state);
    let worker = tokio::task::spawn_blocking(move || {
        let result = prepare_same_snapshot_corpus(
            &worker_store,
            &worker_case,
            &worker_snapshot,
            &worker_task,
            &worker_cache,
            limits,
            &worker_cancel,
        );
        match worker_state.compare_exchange(
            PREPARATION_RUNNING,
            PREPARATION_COMPLETED,
            Ordering::SeqCst,
            Ordering::SeqCst,
        ) {
            Ok(_) => result,
            Err(PREPARATION_TIMED_OUT) => match result {
                Ok(prepared) => match prepared.cleanup() {
                    Ok(()) => Err(LiveBridgeError::Deadline),
                    Err(_) => Err(LiveBridgeError::Cleanup),
                },
                Err(error) => Err(error),
            },
            Err(_) => Err(LiveBridgeError::Import),
        }
    });

    await_blocking_preparation(worker, preparation_state, deadline_ms, cancel).await
}

/// Prepare, execute, proof-bind, record, persist, and clean up one live run.
///
/// Blocking copy/import work runs outside the async executor. An explicit
/// request deadline starts before that work, cancels preparation when elapsed,
/// and passes only its remaining allowance into the public workflow request.
/// The isolated corpus is discarded on every exit path.
#[allow(clippy::too_many_arguments)]
pub async fn run_live_same_snapshot(
    store: &BenchStore,
    case: &Case,
    snapshot: &EvidenceSnapshot,
    task: &EvaluationTask,
    secrets: Arc<dyn SecretStore>,
    mut options: LiveRunOptions,
    events: Option<TriageEventSink>,
) -> Result<LiveRunResult, LiveBridgeError> {
    let started = Instant::now();
    let deadline_ms = options
        .overrides
        .deadline_ms
        .unwrap_or(DEFAULT_LIVE_COMPARISON_DEADLINE_MS);
    let mut prepared = prepare_same_snapshot_with_deadline(
        store,
        case,
        snapshot,
        task,
        &options.cache_root,
        options.limits,
        &options.cancel,
        Some(deadline_ms),
    )
    .await?;

    let elapsed_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
    let remaining = deadline_ms.saturating_sub(elapsed_ms);
    if remaining == 0 {
        return finish_with_cleanup(&mut prepared, Err(LiveBridgeError::Deadline));
    }
    options.overrides.deadline_ms = Some(remaining);

    let result = execute_prepared_same_snapshot(
        store,
        case,
        snapshot,
        task,
        &prepared,
        Arc::clone(&secrets),
        &options,
        events,
    )
    .await;
    finish_with_cleanup(&mut prepared, result)
}

/// Execute multiple live candidates against one prepared task snapshot.
///
/// The source bytes are copied, imported, and proven exactly once. Every
/// candidate then receives that same bounded benchmark packet and the same
/// run-exclusive production corpus. Each candidate still gets its own public
/// request, cancellation identity, replay proof, and immutable bench run.
/// Runs are persisted as they complete, so the existing `cd-triage-bench
/// report` command can project the comparison without inventing rankings.
///
/// The strictest candidate deadline bounds the entire comparison, including
/// preparation. Candidate execution is sequential by design: this keeps the
/// shared corpus and whole-comparison deadline auditable while still avoiding
/// repeated source copying and ingest. A cancelled comparison stops before
/// starting the next candidate and cleans the shared corpus.
pub async fn run_live_comparison(
    store: &BenchStore,
    case: &Case,
    snapshot: &EvidenceSnapshot,
    task: &EvaluationTask,
    secrets: Arc<dyn SecretStore>,
    candidates: Vec<LiveComparisonCandidate>,
) -> Result<LiveComparisonResult, LiveBridgeError> {
    if candidates.is_empty() {
        return Err(LiveBridgeError::EmptyComparison);
    }
    if candidates.len() > DEFAULT_MAX_COMPARISON_CANDIDATES {
        return Err(LiveBridgeError::ComparisonCandidateBound);
    }

    let first = &candidates[0].options;
    let comparison_deadline_ms = candidates
        .iter()
        .filter_map(|candidate| candidate.options.overrides.deadline_ms)
        .min()
        .unwrap_or(DEFAULT_LIVE_COMPARISON_DEADLINE_MS);
    let mut cancellation_ids = BTreeSet::new();
    for candidate in &candidates {
        let options = &candidate.options;
        if options.cache_root != first.cache_root
            || options.limits != first.limits
            || !Arc::ptr_eq(&first.cancel.inner_arc(), &options.cancel.inner_arc())
            || !cancellation_ids.insert(options.cancellation_id.as_str())
        {
            return Err(LiveBridgeError::ComparisonInvariant);
        }
    }

    let started = Instant::now();
    let mut prepared = prepare_same_snapshot_with_deadline(
        store,
        case,
        snapshot,
        task,
        &first.cache_root,
        first.limits,
        &first.cancel,
        Some(comparison_deadline_ms),
    )
    .await?;

    let mut runs = Vec::with_capacity(candidates.len());
    for candidate in candidates {
        let LiveComparisonCandidate {
            mut options,
            events,
        } = candidate;
        if options.cancel.is_cancelled() {
            return finish_with_cleanup(&mut prepared, Err(LiveBridgeError::Cancelled));
        }
        let elapsed_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
        let remaining = comparison_deadline_ms.saturating_sub(elapsed_ms);
        if remaining == 0 {
            return finish_with_cleanup(&mut prepared, Err(LiveBridgeError::Deadline));
        }
        options.overrides.deadline_ms = Some(
            options
                .overrides
                .deadline_ms
                .map_or(remaining, |candidate_deadline| {
                    candidate_deadline.min(remaining)
                }),
        );

        let result = execute_prepared_same_snapshot(
            store,
            case,
            snapshot,
            task,
            &prepared,
            Arc::clone(&secrets),
            &options,
            events,
        )
        .await;
        match result {
            Ok(result) => runs.push(result),
            Err(error) => return finish_with_cleanup(&mut prepared, Err(error)),
        }
    }

    finish_with_cleanup(&mut prepared, Ok(LiveComparisonResult { runs }))
}

#[allow(clippy::too_many_arguments)]
async fn execute_prepared_same_snapshot(
    store: &BenchStore,
    case: &Case,
    snapshot: &EvidenceSnapshot,
    task: &EvaluationTask,
    prepared: &PreparedSameSnapshotCorpus,
    secrets: Arc<dyn SecretStore>,
    options: &LiveRunOptions,
    events: Option<TriageEventSink>,
) -> Result<LiveRunResult, LiveBridgeError> {
    let bound = build_live_request(
        snapshot,
        task,
        prepared.bounded(),
        prepared.corpus_id(),
        prepared.corpus_revision(),
        options.policy.clone(),
        options.overrides.clone(),
        &options.cancellation_id,
    )
    .map_err(|_| LiveBridgeError::Request)?;

    let imported_labels = prepared
        .sources()
        .iter()
        .map(|source| source.source_label.clone())
        .collect::<BTreeSet<_>>();
    let source_inventory = prepared.sources().to_vec();
    let expected_run_id = bound.sdk_run_id.clone();
    let expected_request = bound.request_fingerprint.clone();
    let expected_corpus = prepared.corpus_id().to_string();
    let expected_revision = prepared.corpus_revision();
    let captured = Arc::new(Mutex::new(None));
    let captured_for_observer = Arc::clone(&captured);
    let observer: TriagePacketProofObserverV1 =
        Arc::new(move |proof: &TriageExecutedPacketProofV1| {
            let converted = convert_packet_proof(
                proof,
                &expected_run_id,
                &expected_request,
                &expected_corpus,
                expected_revision,
                &imported_labels,
                &source_inventory,
            )?;
            let mut slot = captured_for_observer
                .lock()
                .map_err(|_| TriagePacketProofObserverErrorV1::new())?;
            if slot.replace(converted).is_some() {
                return Err(TriagePacketProofObserverErrorV1::new());
            }
            Ok(())
        });

    let workspace = tempfile::Builder::new()
        .prefix("contextdesk-triage-live-host-")
        .tempdir_in(&options.cache_root)
        .map_err(|_| LiveBridgeError::Staging)?;
    restrict_directory(workspace.path())?;
    let workspace_scope = Workspace::new(
        "ContextDesk triage benchmark live run",
        vec![workspace.path().to_path_buf()],
    );
    let mut host = ToolHost::new(workspace_scope, KeywordIndex::new(), None);
    host.set_log_analysis(true, Some(options.cache_root.clone()));
    host.set_log_only_tool_surface(true);

    let cancellations = TriageCancellationRegistryV1::default();
    let engine = WorkflowTriageEngineV1::new(
        &mut host,
        &options.cache_root,
        options.config.clone(),
        secrets,
        options.policies.clone(),
        options.qualifications.clone(),
        cancellations.clone(),
    )
    .with_packet_proof_observer(observer)
    .with_cancel_owner(options.cancel.inner_arc());

    let execution = if matches!(
        &bound.request.policy,
        TriagePolicySelectionV2::Standard { .. }
    ) {
        triage(&engine, bound.request.clone(), events).await
    } else {
        triage_with_policy(&engine, bound.request.clone(), events).await
    };
    let replay = execution
        .map_err(|_| LiveBridgeError::Execution)?
        .into_replay();
    let proof = captured
        .lock()
        .map_err(|_| LiveBridgeError::Recording)?
        .clone();
    let recorded = record_live_public_replay(
        case,
        snapshot,
        task,
        prepared.bounded(),
        &bound,
        replay,
        proof,
        &options.recording,
    )
    .map_err(|_| LiveBridgeError::Recording)?;

    store
        .put_run_with_raw_output(&recorded.bench_run, &recorded.raw_output)
        .map_err(|_| LiveBridgeError::Persistence)?;
    Ok(LiveRunResult { recorded })
}

#[allow(clippy::too_many_arguments)]
fn convert_packet_proof(
    proof: &TriageExecutedPacketProofV1,
    expected_run_id: &str,
    expected_request: &str,
    expected_corpus: &str,
    expected_revision: u64,
    imported_labels: &BTreeSet<String>,
    source_inventory: &[HostSourceBinding],
) -> Result<HostExecutionProof, TriagePacketProofObserverErrorV1> {
    if proof.run_id != expected_run_id
        || proof.request_fingerprint != expected_request
        || proof.policy_fingerprint.trim().is_empty()
        || proof.privacy != PacketPrivacyBoundary::OwnerOnly
        || proof.corpus_id != expected_corpus
        || proof.corpus_revision != expected_revision
        || proof.snapshot_revision.event_revision != expected_revision
        || proof.packet_id.trim().is_empty()
        || proof.packet_digest.trim().is_empty()
        || proof.evidence.is_empty()
        || proof.evidence.len() > u32::MAX as usize
    {
        return Err(TriagePacketProofObserverErrorV1::new());
    }
    let mut evidence_ids = BTreeSet::new();
    let mut packet_source_labels = BTreeSet::new();
    let mut packet_evidence = Vec::with_capacity(proof.evidence.len());
    for evidence in &proof.evidence {
        if evidence.evidence_id.trim().is_empty()
            || evidence.source_label.trim().is_empty()
            || !evidence_ids.insert(evidence.evidence_id.as_str())
            || !imported_labels.contains(&evidence.source_label)
        {
            return Err(TriagePacketProofObserverErrorV1::new());
        }
        packet_source_labels.insert(evidence.source_label.clone());
        packet_evidence.push(HostPacketEvidenceBinding {
            evidence_id: evidence.evidence_id.clone(),
            source_label: evidence.source_label.clone(),
        });
    }
    if !packet_evidence
        .windows(2)
        .all(|pair| pair[0].evidence_id < pair[1].evidence_id)
    {
        return Err(TriagePacketProofObserverErrorV1::new());
    }
    Ok(HostExecutionProof {
        packet_id: proof.packet_id.clone(),
        packet_digest: proof.packet_digest.clone(),
        policy_fingerprint: proof.policy_fingerprint.clone(),
        evidence_count: proof.evidence.len() as u32,
        corpus_id: proof.corpus_id.clone(),
        corpus_revision: proof.corpus_revision,
        snapshot_revision: proof.snapshot_revision,
        ledger_digest: proof.packet_digest.clone(),
        sources: source_inventory.to_vec(),
        packet_evidence,
        packet_source_labels: packet_source_labels.into_iter().collect(),
    })
}

fn finish_with_cleanup<T>(
    prepared: &mut PreparedSameSnapshotCorpus,
    result: Result<T, LiveBridgeError>,
) -> Result<T, LiveBridgeError> {
    reconcile_cleanup(result, prepared.discard())
}

fn reconcile_cleanup<T>(
    result: Result<T, LiveBridgeError>,
    cleanup: Result<(), LiveBridgeError>,
) -> Result<T, LiveBridgeError> {
    match (result, cleanup) {
        (Ok(result), Ok(())) => Ok(result),
        (Ok(_), Err(_)) => Err(LiveBridgeError::Cleanup),
        (Err(error), Ok(())) => Err(error),
        (Err(_), Err(_)) => Err(LiveBridgeError::FailureAndCleanup),
    }
}

async fn await_blocking_preparation<T: Send + 'static>(
    mut worker: tokio::task::JoinHandle<Result<T, LiveBridgeError>>,
    state: Arc<AtomicU8>,
    deadline_ms: Option<u64>,
    cancel: &CancelFlag,
) -> Result<T, LiveBridgeError> {
    if let Some(deadline_ms) = deadline_ms {
        tokio::select! {
            biased;
            result = &mut worker => result.map_err(|_| LiveBridgeError::Import)?,
            _ = tokio::time::sleep(Duration::from_millis(deadline_ms)) => {
                match state.compare_exchange(
                    PREPARATION_RUNNING,
                    PREPARATION_TIMED_OUT,
                    Ordering::SeqCst,
                    Ordering::SeqCst,
                ) {
                    Ok(_) => {
                        cancel.cancel();
                        // The blocking worker observes PREPARATION_TIMED_OUT
                        // before returning and explicitly cleans any corpus it
                        // managed to publish. A cleanup failure leaves a
                        // durable, content-free retry marker.
                        drop(worker);
                        Err(LiveBridgeError::Deadline)
                    }
                    Err(PREPARATION_COMPLETED) => {
                        worker.await.map_err(|_| LiveBridgeError::Import)?
                    }
                    Err(_) => Err(LiveBridgeError::Import),
                }
            }
        }
    } else {
        worker.await.map_err(|_| LiveBridgeError::Import)?
    }
}

/// Retry cleanup of isolated corpora whose owner process no longer holds the
/// corresponding lease.
///
/// Each marker is installed and synced before managed ingest can publish a
/// corpus. It contains only a generated host identity, never evidence or model
/// content. A malformed, oversized, or non-regular marker fails closed.
pub fn retry_pending_live_cleanup(cache_root: &Path) -> Result<(), LiveBridgeError> {
    let directory = cache_root.join(CLEANUP_MARKER_DIR);
    let directory_metadata = match std::fs::symlink_metadata(&directory) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err(LiveBridgeError::Cleanup),
    };
    if !directory_metadata.is_dir() {
        return Err(LiveBridgeError::Cleanup);
    }
    let lease_directory = cache_root.join(CLEANUP_LEASE_DIR);
    ensure_private_directory(&lease_directory)?;
    let mut entries = std::fs::read_dir(&directory).map_err(|_| LiveBridgeError::Cleanup)?;
    for index in 0..=MAX_CLEANUP_MARKERS {
        let Some(entry) = entries.next() else {
            let _ = std::fs::remove_dir(&directory);
            let _ = std::fs::remove_dir(&lease_directory);
            return Ok(());
        };
        if index == MAX_CLEANUP_MARKERS {
            return Err(LiveBridgeError::Cleanup);
        }
        let entry = entry.map_err(|_| LiveBridgeError::Cleanup)?;
        let metadata =
            std::fs::symlink_metadata(entry.path()).map_err(|_| LiveBridgeError::Cleanup)?;
        if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_CLEANUP_MARKER_BYTES {
            return Err(LiveBridgeError::Cleanup);
        }
        let managed_identity =
            std::fs::read_to_string(entry.path()).map_err(|_| LiveBridgeError::Cleanup)?;
        if managed_identity.is_empty() || managed_identity.trim() != managed_identity {
            return Err(LiveBridgeError::Cleanup);
        }
        let expected_marker =
            fingerprint("tli", &managed_identity).map_err(|_| LiveBridgeError::Cleanup)?;
        if entry.file_name().to_str() != Some(expected_marker.as_str()) {
            return Err(LiveBridgeError::Cleanup);
        }
        let lease_path = lease_directory.join(&expected_marker);
        let lease = open_cleanup_lease(&lease_path)?;
        match lease.try_lock_exclusive() {
            Ok(()) => {}
            Err(error) if is_lock_contended(&error) => continue,
            Err(_) => return Err(LiveBridgeError::Cleanup),
        }

        discard_managed_corpora(cache_root, &managed_identity)?;
        match std::fs::remove_file(entry.path()) {
            Ok(()) => sync_directory(&directory)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(LiveBridgeError::Cleanup),
        }
        drop(lease);
        match std::fs::remove_file(&lease_path) {
            Ok(()) => sync_directory(&lease_directory)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(LiveBridgeError::Cleanup),
        }
    }
    Err(LiveBridgeError::Cleanup)
}

fn is_lock_contended(error: &std::io::Error) -> bool {
    let expected = fs2::lock_contended_error();
    error.raw_os_error() == expected.raw_os_error()
}

fn record_cleanup_intent(
    cache_root: &Path,
    managed_identity: &str,
) -> Result<CleanupIntent, LiveBridgeError> {
    let directory = cache_root.join(CLEANUP_MARKER_DIR);
    let lease_directory = cache_root.join(CLEANUP_LEASE_DIR);
    ensure_private_directory(&directory)?;
    ensure_private_directory(&lease_directory)?;
    let marker_id = fingerprint("tli", &managed_identity).map_err(|_| LiveBridgeError::Cleanup)?;
    let marker_path = directory.join(&marker_id);
    let lease_path = lease_directory.join(&marker_id);
    let lease = open_cleanup_lease(&lease_path)?;
    lease
        .lock_exclusive()
        .map_err(|_| LiveBridgeError::Cleanup)?;

    if marker_path.exists() {
        verify_cleanup_marker(&marker_path, managed_identity)?;
    } else {
        let mut marker =
            tempfile::NamedTempFile::new_in(cache_root).map_err(|_| LiveBridgeError::Cleanup)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            marker
                .as_file()
                .set_permissions(std::fs::Permissions::from_mode(0o600))
                .map_err(|_| LiveBridgeError::Cleanup)?;
        }
        marker
            .write_all(managed_identity.as_bytes())
            .and_then(|()| marker.as_file().sync_all())
            .map_err(|_| LiveBridgeError::Cleanup)?;
        match marker.persist_noclobber(&marker_path) {
            Ok(_) => sync_directory(&directory)?,
            Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
                drop(error.file);
                verify_cleanup_marker(&marker_path, managed_identity)?;
            }
            Err(_) => return Err(LiveBridgeError::Cleanup),
        }
    }

    Ok(CleanupIntent {
        marker_path,
        lease_path,
        lease: Some(lease),
    })
}

fn verify_cleanup_marker(path: &Path, managed_identity: &str) -> Result<(), LiveBridgeError> {
    let metadata = std::fs::symlink_metadata(path).map_err(|_| LiveBridgeError::Cleanup)?;
    if !metadata.is_file()
        || metadata.len() != managed_identity.len() as u64
        || metadata.len() > MAX_CLEANUP_MARKER_BYTES
        || std::fs::read_to_string(path).ok().as_deref() != Some(managed_identity)
    {
        return Err(LiveBridgeError::Cleanup);
    }
    Ok(())
}

fn open_cleanup_lease(path: &Path) -> Result<File, LiveBridgeError> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(path).map_err(|_| LiveBridgeError::Cleanup)?;
    if !std::fs::symlink_metadata(path)
        .map_err(|_| LiveBridgeError::Cleanup)?
        .is_file()
    {
        return Err(LiveBridgeError::Cleanup);
    }
    Ok(file)
}

fn discard_managed_corpora(
    cache_root: &Path,
    managed_identity: &str,
) -> Result<(), LiveBridgeError> {
    let corpus_ids = LogCorpus::list_ids(cache_root).map_err(|_| LiveBridgeError::Cleanup)?;
    if corpus_ids.len() > MAX_CLEANUP_CORPORA {
        return Err(LiveBridgeError::Cleanup);
    }
    for corpus_id in corpus_ids {
        let corpus =
            LogCorpus::open(cache_root, &corpus_id).map_err(|_| LiveBridgeError::Cleanup)?;
        let matches = corpus
            .meta()
            .map_err(|_| LiveBridgeError::Cleanup)?
            .managed_identity
            .as_deref()
            == Some(managed_identity);
        drop(corpus);
        if matches {
            LogCorpus::discard(cache_root, &corpus_id).map_err(|_| LiveBridgeError::Cleanup)?;
        }
    }
    Ok(())
}

fn ensure_private_directory(path: &Path) -> Result<(), LiveBridgeError> {
    std::fs::create_dir_all(path).map_err(|_| LiveBridgeError::Cleanup)?;
    if !std::fs::symlink_metadata(path)
        .map_err(|_| LiveBridgeError::Cleanup)?
        .is_dir()
    {
        return Err(LiveBridgeError::Cleanup);
    }
    restrict_directory(path).map_err(|_| LiveBridgeError::Cleanup)
}

fn sync_directory(path: &Path) -> Result<(), LiveBridgeError> {
    #[cfg(unix)]
    {
        File::open(path)
            .and_then(|directory| directory.sync_all())
            .map_err(|_| LiveBridgeError::Cleanup)?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn prove_preview(
    report: &cd_core::log_analysis::import_preview::ImportPreviewReport,
    sources: &[HostSourceBinding],
) -> Result<(), LiveBridgeError> {
    if report.truncated
        || report.items.len() != sources.len()
        || report.counts.total != sources.len() as u64
        || report.counts.selected != sources.len() as u64
        || report.counts.ignored != 0
        || report.counts.unsupported != 0
        || report.counts.blocked != 0
        || report.items.iter().any(|item| !item.selected)
    {
        return Err(LiveBridgeError::Provenance);
    }
    let expected = sources
        .iter()
        .map(|source| (source.source_label.as_str(), source.byte_length))
        .collect::<BTreeMap<_, _>>();
    let observed = report
        .items
        .iter()
        .map(|item| (item.identity.as_str(), item.bytes))
        .collect::<BTreeMap<_, _>>();
    if expected != observed {
        return Err(LiveBridgeError::Provenance);
    }
    Ok(())
}

fn prove_ingest_stats(
    stats: &cd_core::log_analysis::ingest::IngestStats,
    sources: &[HostSourceBinding],
    aggregate_bytes: u64,
) -> Result<(), LiveBridgeError> {
    let count = sources.len() as u64;
    if stats.files as u64 != count
        || stats.discovered_files != count
        || stats.excluded_files != 0
        || stats.failed_files != 0
        || stats.ignored_files != 0
        || stats.partial
        || stats.source_bytes != aggregate_bytes
        || stats.lines == 0
    {
        return Err(LiveBridgeError::Provenance);
    }
    Ok(())
}

fn prove_ingest_digests(
    digests: &[cd_core::log_analysis::ingest::IngestSourceDigest],
    sources: &[HostSourceBinding],
) -> Result<(), LiveBridgeError> {
    let expected = sources
        .iter()
        .map(|source| {
            (
                source.source_label.as_str(),
                source.content_digest.as_str(),
                source.byte_length,
            )
        })
        .collect::<BTreeSet<_>>();
    let observed = digests
        .iter()
        .map(|digest| {
            (
                digest.source.as_str(),
                digest.content_digest.as_str(),
                digest.byte_length,
            )
        })
        .collect::<BTreeSet<_>>();
    if digests.len() != sources.len() || observed != expected {
        return Err(LiveBridgeError::Provenance);
    }
    Ok(())
}

fn prove_source_catalog(
    corpus: &LogCorpus,
    sources: &[HostSourceBinding],
    cancel: &CancelFlag,
) -> Result<(), LiveBridgeError> {
    let expected = sources
        .iter()
        .map(|source| source.source_label.clone())
        .collect::<BTreeSet<_>>();
    let mut observed = BTreeSet::new();
    let mut cursor = None;
    let mut seen_cursors = BTreeSet::new();
    loop {
        if cancel.is_cancelled() {
            return Err(LiveBridgeError::Cancelled);
        }
        let page = query_source_catalog(
            corpus,
            &LogSourceCatalogQuery {
                search: None,
                cursor: cursor.clone(),
                limit: 200,
            },
        )
        .map_err(|_| LiveBridgeError::Provenance)?;
        if cancel.is_cancelled() {
            return Err(LiveBridgeError::Cancelled);
        }
        if page.total_matched != expected.len() as u64
            || page.sources.iter().any(|source| source.event_count == 0)
        {
            return Err(LiveBridgeError::Provenance);
        }
        observed.extend(page.sources.iter().map(|source| source.source.clone()));
        match page.next_cursor {
            Some(next) if !next.is_empty() && seen_cursors.insert(next.clone()) => {
                cursor = Some(next)
            }
            Some(_) => return Err(LiveBridgeError::Provenance),
            None => break,
        }
    }
    if observed != expected {
        return Err(LiveBridgeError::Provenance);
    }
    Ok(())
}

fn cancelled_or(cancel: &CancelFlag, otherwise: LiveBridgeError) -> LiveBridgeError {
    if cancel.is_cancelled() {
        LiveBridgeError::Cancelled
    } else {
        otherwise
    }
}

fn private_destination(path: &Path) -> Result<File, LiveBridgeError> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path).map_err(|_| LiveBridgeError::Staging)
}

fn restrict_directory(path: &Path) -> Result<(), LiveBridgeError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .map_err(|_| LiveBridgeError::Staging)?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    #[test]
    fn cleanup_reconciliation_never_hides_a_second_failure() {
        assert_eq!(
            reconcile_cleanup::<()>(Err(LiveBridgeError::Execution), Ok(())).unwrap_err(),
            LiveBridgeError::Execution
        );
        assert_eq!(
            reconcile_cleanup::<()>(Ok(()), Err(LiveBridgeError::Cleanup)).unwrap_err(),
            LiveBridgeError::Cleanup
        );
        assert_eq!(
            reconcile_cleanup::<()>(
                Err(LiveBridgeError::Execution),
                Err(LiveBridgeError::Cleanup)
            )
            .unwrap_err(),
            LiveBridgeError::FailureAndCleanup
        );
    }

    #[test]
    fn pending_cleanup_marker_is_bounded_and_retried() {
        let cache = tempfile::tempdir().unwrap();
        let managed_identity = "triage-bench-live.cleanup-retry";

        let intent = record_cleanup_intent(cache.path(), managed_identity).unwrap();

        let marker_directory = cache.path().join(CLEANUP_MARKER_DIR);
        let markers = std::fs::read_dir(&marker_directory)
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(markers.len(), 1);
        assert_eq!(
            std::fs::read_to_string(markers[0].path()).unwrap(),
            managed_identity
        );

        retry_pending_live_cleanup(cache.path()).unwrap();
        assert!(markers[0].path().exists(), "an active lease was reclaimed");

        drop(intent);
        retry_pending_live_cleanup(cache.path()).unwrap();

        assert!(!marker_directory.exists());
    }

    #[test]
    fn malformed_cleanup_marker_fails_closed() {
        let cache = tempfile::tempdir().unwrap();
        let marker_directory = cache.path().join(CLEANUP_MARKER_DIR);
        std::fs::create_dir_all(&marker_directory).unwrap();
        std::fs::write(marker_directory.join("malformed"), "../escape").unwrap();

        assert_eq!(
            retry_pending_live_cleanup(cache.path()).unwrap_err(),
            LiveBridgeError::Cleanup
        );
        assert!(marker_directory.join("malformed").exists());
    }

    #[test]
    fn orphaned_intent_discards_its_exact_managed_corpus() {
        let cache = tempfile::tempdir().unwrap();
        let managed_identity = "triage-bench-live.orphaned-corpus";
        let intent = record_cleanup_intent(cache.path(), managed_identity).unwrap();
        let corpus = LogCorpus::create(cache.path(), "orphaned live run").unwrap();
        corpus.write_managed_identity(managed_identity).unwrap();
        let corpus_id = corpus.id().to_string();
        let corpus_root = corpus.root().to_path_buf();
        drop(corpus);
        drop(intent);

        retry_pending_live_cleanup(cache.path()).unwrap();

        assert!(!corpus_root.exists());
        assert!(!LogCorpus::list_ids(cache.path())
            .unwrap()
            .contains(&corpus_id));
    }

    #[tokio::test]
    async fn preparation_deadline_detaches_the_blocking_worker() {
        let finished = Arc::new(AtomicBool::new(false));
        let worker_finished = Arc::clone(&finished);
        let state = Arc::new(AtomicU8::new(PREPARATION_RUNNING));
        let worker_state = Arc::clone(&state);
        let worker = tokio::task::spawn_blocking(move || {
            std::thread::sleep(Duration::from_millis(250));
            let _ = worker_state.compare_exchange(
                PREPARATION_RUNNING,
                PREPARATION_COMPLETED,
                Ordering::SeqCst,
                Ordering::SeqCst,
            );
            worker_finished.store(true, Ordering::SeqCst);
            Ok::<_, LiveBridgeError>(())
        });
        let cancel = CancelFlag::new();

        let error = await_blocking_preparation(worker, state.clone(), Some(1), &cancel)
            .await
            .unwrap_err();

        assert_eq!(error, LiveBridgeError::Deadline);
        assert!(cancel.is_cancelled());
        assert!(
            !finished.load(Ordering::SeqCst),
            "deadline path waited for the blocking worker"
        );
        assert_eq!(state.load(Ordering::SeqCst), PREPARATION_TIMED_OUT);
    }
}
