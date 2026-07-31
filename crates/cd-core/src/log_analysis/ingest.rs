//! Path/dir ingest orchestration (#355–#359, #362 core) + multi-phase progress (#445).

use super::drain::DrainMiner;
use super::embed_policy::{LogEmbedMode, LogEmbedPolicy};
use super::import_preview::{ImportPreviewItem, ImportPreviewReport};
use super::ingest_confidence::{IngestConfidenceAggregator, IngestConfidenceReport};
use super::parse::{parse_line_with_fingerprint, LogFormat};
use super::redact_log::{prepare_original_record, redact_message, redact_params};
use super::store::{
    template_content_hash, CorpusEmbeddingStatus, EmbeddingState, IngestedLogEvent, LogCorpus,
    LogEvent, TemplateRow, TopTemplateSnapshot,
};
use crate::embed::EmbedBackend;
use crate::error::{CoreError, CoreResult};
use crate::memory::embed_blocking;
use crate::process_progress::{
    progress_basename, CancelFlag, LogIngestEvidence, LogIngestEvidenceReason, NoopProcessProgress,
    ProcessProgress, ProcessProgressKind, ProcessProgressObserver, ProcessProgressPhase,
};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use uuid::Uuid;

#[cfg(windows)]
use std::os::windows::io::AsRawHandle;

/// Stats from one ingest run.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestStats {
    /// Files successfully read through EOF and imported.
    pub files: usize,
    /// File entries discovered before policy/read decisions.
    #[serde(default)]
    pub discovered_files: u64,
    /// Files excluded by an explicit policy guard.
    #[serde(default)]
    pub excluded_files: u64,
    /// Files that could not be opened or completely read.
    #[serde(default)]
    pub failed_files: u64,
    /// Entries intentionally ignored (for example hidden files/directories).
    #[serde(default)]
    pub ignored_files: u64,
    /// Counts by stable exclusion/failure reason.
    #[serde(default)]
    pub exclusion_counts: std::collections::BTreeMap<String, u64>,
    /// Bounded basename-only examples (`reason: basename`).
    #[serde(default)]
    pub exclusion_examples: Vec<String>,
    /// True when any discovered content was not fully imported.
    #[serde(default)]
    pub partial: bool,
    /// Lines parsed.
    pub lines: u64,
    /// Distinct templates.
    pub templates: usize,
    /// Template reduction ratio (lines / templates).
    pub reduction_ratio: f64,
    /// Templates newly embedded.
    pub embedded: usize,
    /// Bytes read from source files.
    pub source_bytes: u64,
    /// On-disk corpus footprint after flush.
    pub corpus_bytes: u64,
    /// Counts by normalized level.
    #[serde(default)]
    pub level_counts: std::collections::BTreeMap<String, u64>,
    /// Earliest event ts.
    pub ts_min: Option<i64>,
    /// Latest event ts.
    pub ts_max: Option<i64>,
    /// Counts by parse format.
    #[serde(default)]
    pub format_counts: std::collections::BTreeMap<String, u64>,
    /// Counts by explicit timestamp provenance.
    #[serde(default)]
    pub timestamp_provenance_counts: std::collections::BTreeMap<String, u64>,
    /// Counts by active timestamp basis.
    #[serde(default)]
    pub active_timestamp_basis_counts: std::collections::BTreeMap<String, u64>,
}

impl IngestStats {
    /// Convert to persisted [`super::store::CorpusStats`].
    pub fn to_corpus_stats(&self) -> super::store::CorpusStats {
        super::store::CorpusStats {
            files: self.files as u64,
            discovered_files: self.discovered_files,
            excluded_files: self.excluded_files,
            failed_files: self.failed_files,
            ignored_files: self.ignored_files,
            exclusion_counts: self.exclusion_counts.clone(),
            exclusion_examples: self.exclusion_examples.clone(),
            partial: self.partial,
            lines: self.lines,
            templates: self.templates as u64,
            reduction_ratio: self.reduction_ratio,
            embedded: self.embedded as u64,
            source_bytes: self.source_bytes,
            corpus_bytes: self.corpus_bytes,
            level_counts: self.level_counts.clone(),
            ts_min: self.ts_min,
            ts_max: self.ts_max,
            format_counts: self.format_counts.clone(),
            timestamp_provenance_counts: self.timestamp_provenance_counts.clone(),
            active_timestamp_basis_counts: self.active_timestamp_basis_counts.clone(),
        }
    }

    fn discover(&mut self) {
        self.discovered_files = self.discovered_files.saturating_add(1);
    }

    fn imported(&mut self) {
        self.files = self.files.saturating_add(1);
    }

    fn excluded(&mut self, reason: &'static str, source: &Path) {
        self.excluded_files = self.excluded_files.saturating_add(1);
        self.record_omission(reason, source);
    }

    fn failed(&mut self, reason: &'static str, source: &Path) {
        self.failed_files = self.failed_files.saturating_add(1);
        self.record_omission(reason, source);
    }

    fn ignored(&mut self, reason: &'static str, source: &Path) {
        self.ignored_files = self.ignored_files.saturating_add(1);
        self.record_omission(reason, source);
    }

    fn record_omission(&mut self, reason: &'static str, source: &Path) {
        *self.exclusion_counts.entry(reason.into()).or_insert(0) += 1;
        if self.exclusion_examples.len() < MAX_EXCLUSION_EXAMPLES {
            let safe_basename = redact_message(&progress_basename(source));
            self.exclusion_examples
                .push(format!("{reason}: {safe_basename}"));
        }
        self.partial = true;
    }
}

/// Measured wall-clock **operation** timings for one ingest (#824).
///
/// Values accumulate via **scoped timers around actual work**, not via the last
/// UI progress enum while read/parse/template/persist interleave. Non-overlapping
/// working subtotals must be bounded by [`Self::total_ms`] / wall time.
/// Completion diagnostics may list these separately; progress chrome uses one
/// monotonic streaming phase for the interleaved work.
///
/// One-machine observations only — not a product SLA.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestPhaseTimings {
    /// Inventory / discover + bounded source reads (ms).
    pub discover_read_ms: u64,
    /// Parse / frame / redaction of logical records (ms).
    pub parse_frame_ms: u64,
    /// Drain template matching only (ms).
    pub template_analysis_ms: u64,
    /// Event/template persistence and flushes (ms).
    pub persist_index_ms: u64,
    /// Optional embedding (0 when deferred or not requested) (ms).
    pub optional_embedding_ms: u64,
    /// Staged corpus validation before publish (ms).
    #[serde(default)]
    pub validation_ms: u64,
    /// Atomic library publication (ms).
    pub publication_ms: u64,
    /// End-to-end wall time for the ingest operation (ms).
    pub total_ms: u64,
    /// True when optional embedding was deferred past first use.
    pub embedding_deferred: bool,
}

impl IngestPhaseTimings {
    /// Sum of non-overlapping working subtotals (excludes total wall).
    pub fn working_subtotal_ms(&self) -> u64 {
        self.discover_read_ms
            .saturating_add(self.parse_frame_ms)
            .saturating_add(self.template_analysis_ms)
            .saturating_add(self.persist_index_ms)
            .saturating_add(self.optional_embedding_ms)
            .saturating_add(self.validation_ms)
            .saturating_add(self.publication_ms)
    }
}

/// Which real operation a scoped timer attributes wall time to (#824).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum IngestOp {
    DiscoverRead,
    ParseFrame,
    Template,
    Persist,
    Embed,
    Validate,
    Publish,
}

/// Full ingest report.
#[derive(Debug, Clone)]
pub struct IngestReport {
    /// Corpus id.
    pub corpus_id: String,
    /// Stats.
    pub stats: IngestStats,
    /// Bounded per-source grammar and time-confidence report.
    pub confidence: IngestConfidenceReport,
    /// Top templates by count (for summary UI).
    pub top_templates: Vec<(u64, String, u64, u8)>,
    /// Persisted semantic-vector availability.
    pub embedding: CorpusEmbeddingStatus,
    /// Phase wall-clock timings (#824); zeroed when not instrumented.
    pub phase_timings: IngestPhaseTimings,
}

/// Ingest a file or directory into a new corpus under `cache_root`.
///
/// Streams line-by-line (bounded memory). `embed` is optional — when present,
/// templates are embedded (content-hash cached). Uses realistic embed budget.
pub fn ingest_path(
    cache_root: &Path,
    path: &Path,
    name: &str,
    embed: Option<&dyn EmbedBackend>,
    embed_model: &str,
) -> CoreResult<IngestReport> {
    ingest_path_with_observer(
        cache_root,
        path,
        name,
        embed,
        embed_model,
        &NoopProcessProgress,
        None,
    )
}

/// Ingest with multi-phase progress and optional cancel (#445).
pub fn ingest_path_with_observer(
    cache_root: &Path,
    path: &Path,
    name: &str,
    embed: Option<&dyn EmbedBackend>,
    embed_model: &str,
    progress: &dyn ProcessProgressObserver,
    cancel: Option<&CancelFlag>,
) -> CoreResult<IngestReport> {
    ingest_path_inner(
        cache_root,
        path,
        name,
        embed,
        embed_model,
        if embed.is_some() {
            LogEmbedMode::Local
        } else {
            LogEmbedMode::None
        },
        None,
        progress,
        cancel,
        None,
    )
}

/// Ingest with an explicit [`LogEmbedPolicy`] (#359).
///
/// - **Local:** uses `embed` when provided (host/Ollama/Concept/fastembed).
/// - **Cloud:** requires confirm flag; caller must pass a cloud `EmbedBackend`
///   (secrets stay keychain-side — never in policy).
/// - **None:** skip template embedding.
pub fn ingest_path_with_policy(
    cache_root: &Path,
    path: &Path,
    name: &str,
    policy: &LogEmbedPolicy,
    embed: Option<Arc<dyn EmbedBackend>>,
) -> CoreResult<IngestReport> {
    ingest_path_with_policy_and_observer(
        cache_root,
        path,
        name,
        policy,
        embed,
        &NoopProcessProgress,
        None,
    )
}

/// Policy ingest with progress observer (#445).
pub fn ingest_path_with_policy_and_observer(
    cache_root: &Path,
    path: &Path,
    name: &str,
    policy: &LogEmbedPolicy,
    embed: Option<Arc<dyn EmbedBackend>>,
    progress: &dyn ProcessProgressObserver,
    cancel: Option<&CancelFlag>,
) -> CoreResult<IngestReport> {
    policy.assert_embed_allowed()?;
    let backend = match policy.mode {
        LogEmbedMode::None => None,
        LogEmbedMode::Local | LogEmbedMode::Cloud => embed,
    };
    if policy.mode == LogEmbedMode::Cloud && backend.is_none() {
        return Err(CoreError::Config(
            "cloud embed mode requires an EmbedBackend (key from keychain)".into(),
        ));
    }
    ingest_path_inner(
        cache_root,
        path,
        name,
        backend.as_deref(),
        policy.model_id.as_str(),
        policy.mode,
        policy.defer_above_source_bytes,
        progress,
        cancel,
        None,
    )
}

/// Policy ingest with a reserved host-managed identity.
///
/// This is the same bounded ingest orchestration as
/// [`ingest_path_with_policy_and_observer`]. The identity is written into the
/// hidden staged corpus before validation and atomic publication, allowing the
/// host to reconcile a crash before its own installation marker is published.
#[allow(clippy::too_many_arguments)]
pub fn ingest_path_with_policy_and_observer_managed(
    cache_root: &Path,
    path: &Path,
    name: &str,
    policy: &LogEmbedPolicy,
    embed: Option<Arc<dyn EmbedBackend>>,
    progress: &dyn ProcessProgressObserver,
    cancel: Option<&CancelFlag>,
    managed_identity: &str,
) -> CoreResult<IngestReport> {
    policy.assert_embed_allowed()?;
    let backend = match policy.mode {
        LogEmbedMode::None => None,
        LogEmbedMode::Local | LogEmbedMode::Cloud => embed,
    };
    if policy.mode == LogEmbedMode::Cloud && backend.is_none() {
        return Err(CoreError::Config(
            "cloud embed mode requires an EmbedBackend (key from keychain)".into(),
        ));
    }
    ingest_path_inner(
        cache_root,
        path,
        name,
        backend.as_deref(),
        policy.model_id.as_str(),
        policy.mode,
        policy.defer_above_source_bytes,
        progress,
        cancel,
        Some(managed_identity),
    )
}

fn cancelled(cancel: Option<&CancelFlag>) -> bool {
    cancel.map(|c| c.is_cancelled()).unwrap_or(false)
}

/// Wall-clock progress chrome + **operation-scoped** accumulators (#824).
///
/// Progress `phase_elapsed_ms` tracks UI phase transitions only (for chrome).
/// Accounting for diagnostics uses [`IngestPhaseTimings`] filled exclusively by
/// [`IngestOp`] scopes around real work — never "last emitted UI enum".
struct IngestProgressClock {
    start: std::time::Instant,
    phase_started: std::time::Instant,
    current_phase: ProcessProgressPhase,
    timings: IngestPhaseTimings,
}

impl IngestProgressClock {
    fn new() -> Self {
        let now = std::time::Instant::now();
        Self {
            start: now,
            phase_started: now,
            current_phase: ProcessProgressPhase::Starting,
            timings: IngestPhaseTimings::default(),
        }
    }

    fn stamp(&mut self, mut update: ProcessProgress) -> ProcessProgress {
        let now = std::time::Instant::now();
        if update.phase != self.current_phase {
            let spent = now
                .saturating_duration_since(self.phase_started)
                .as_millis() as u64;
            // UI-only: report how long chrome sat on the previous phase.
            // Do NOT attribute this to operation buckets (interleaved work).
            update.phase_elapsed_ms = Some(spent);
            self.current_phase = update.phase;
            self.phase_started = now;
        }
        let total = now.saturating_duration_since(self.start).as_millis() as u64;
        update.elapsed_ms = Some(total);
        self.timings.total_ms = total;
        update
    }

    fn finish(&mut self) {
        let now = std::time::Instant::now();
        self.timings.total_ms = now.saturating_duration_since(self.start).as_millis() as u64;
        self.current_phase = ProcessProgressPhase::Completed;
        self.phase_started = now;
    }
}

fn emit(progress: &dyn ProcessProgressObserver, mut update: ProcessProgress) {
    if update.kind == ProcessProgressKind::LogIngest && update.phase != ProcessProgressPhase::Stream
    {
        update.fraction = None;
    }
    progress.progress(update);
}

/// Observer wrapper that stamps elapsed onto progress and holds op timers.
///
/// `Mutex` (not `RefCell`) because [`ProcessProgressObserver`] is `Sync`.
struct TimedIngestObserver<'a> {
    inner: &'a dyn ProcessProgressObserver,
    clock: std::sync::Mutex<IngestProgressClock>,
}

impl<'a> TimedIngestObserver<'a> {
    fn new(inner: &'a dyn ProcessProgressObserver) -> Self {
        Self {
            inner,
            clock: std::sync::Mutex::new(IngestProgressClock::new()),
        }
    }

    fn finish_timings(&self, embedding_deferred: bool) -> IngestPhaseTimings {
        let mut clock = self.clock.lock().expect("ingest progress clock");
        clock.finish();
        let mut timings = clock.timings.clone();
        timings.embedding_deferred = embedding_deferred;
        timings
    }
}

impl ProcessProgressObserver for TimedIngestObserver<'_> {
    fn progress(&self, update: ProcessProgress) {
        let stamped = self
            .clock
            .lock()
            .expect("ingest progress clock")
            .stamp(update);
        emit(self.inner, stamped);
    }

    fn log_ingest_evidence(&self, evidence: LogIngestEvidence) {
        self.inner.log_ingest_evidence(evidence);
    }
}

fn parse_file_fraction(completed_files: u64, total_files: u64) -> Option<f32> {
    if total_files == 0 {
        return None;
    }
    let fraction = (completed_files.min(total_files) as f64 / total_files as f64) as f32;
    fraction.is_finite().then_some(fraction.clamp(0.0, 1.0))
}

fn with_stream_file_fraction(
    mut update: ProcessProgress,
    completed_files: u64,
    total_files: u64,
) -> ProcessProgress {
    debug_assert_eq!(update.phase, ProcessProgressPhase::Stream);
    update.fraction = parse_file_fraction(completed_files, total_files);
    update
}

fn emit_ingest_evidence(
    progress: &dyn ProcessProgressObserver,
    reason: LogIngestEvidenceReason,
    source: &Path,
) {
    progress.log_ingest_evidence(LogIngestEvidence::from_source(reason, source));
}

/// Soft max size per log member before skip (bytes). Overridable via env later.
pub const DEFAULT_MAX_FILE_BYTES: u64 = 512 * 1024 * 1024;

/// Emit parse progress every N lines so one huge file still advances UI.
pub const PROGRESS_EVERY_LINES: u64 = 2_000;

/// Max templates to embed on bulk SoftWrite when embed is enabled (cap).
pub const BULK_EMBED_TEMPLATE_CAP: usize = 256;

/// Maximum basename-only omission examples persisted or sent to the webview.
pub const MAX_EXCLUSION_EXAMPLES: usize = 20;

/// Maximum number of filesystem or archive entries inspected by one raw ingest.
pub const MAX_RAW_LOG_ENTRIES: u64 = 50_000;

/// Maximum aggregate actual bytes streamed for import by one raw ingest (4 GiB).
pub const MAX_RAW_LOG_EXPANDED_BYTES: u64 = 4 * 1024 * 1024 * 1024;

/// Maximum number of archive containers in one source-identity chain.
///
/// A directly selected ZIP is depth 1, so this permits
/// `outer.zip!/inner.zip!/deep.zip!/app.log` and refuses a fourth container.
pub const MAX_RAW_LOG_ARCHIVE_DEPTH: u8 = 3;

/// Maximum expanded-to-compressed ratio for a payload that will be read.
///
/// Absolute member and aggregate expanded-byte caps remain authoritative.
/// The deliberately generous ratio preserves legitimate highly repetitive
/// logs while rejecting corrupt or adversarial metadata before payload reads.
pub const MAX_RAW_LOG_COMPRESSION_RATIO: u64 = 2_048;

/// Maximum bytes in one logical log line, including its line ending (16 MiB).
///
/// Absolute member and aggregate bounds remain authoritative. This higher
/// record bound accommodates legitimate structured payloads and stack traces
/// without permitting one record to grow without limit.
pub const MAX_RAW_LOG_LINE_BYTES: usize = 16 * 1024 * 1024;

/// Startup orphan cleanup inspects at most this many staging children.
const MAX_ABANDONED_STAGING_SCAN: usize = 64;

/// Startup orphan cleanup removes at most this many staging children per run.
const MAX_ABANDONED_STAGING_REMOVALS: usize = 8;

/// UUIDv7 staging directories older than this are eligible for best-effort
/// startup cleanup. A long grace period avoids disturbing a live ingest.
const ABANDONED_STAGING_AGE_SECS: u64 = 7 * 24 * 60 * 60;

#[derive(Debug, Clone, Copy)]
struct RawIngestLimits {
    max_entries: u64,
    max_file_bytes: u64,
    max_expanded_bytes: u64,
    max_line_bytes: usize,
    max_archive_depth: u8,
    max_compression_ratio: u64,
}

impl Default for RawIngestLimits {
    fn default() -> Self {
        Self {
            max_entries: MAX_RAW_LOG_ENTRIES,
            max_file_bytes: DEFAULT_MAX_FILE_BYTES,
            max_expanded_bytes: MAX_RAW_LOG_EXPANDED_BYTES,
            max_line_bytes: MAX_RAW_LOG_LINE_BYTES,
            max_archive_depth: MAX_RAW_LOG_ARCHIVE_DEPTH,
            max_compression_ratio: MAX_RAW_LOG_COMPRESSION_RATIO,
        }
    }
}

#[derive(Debug, Default)]
struct RawIngestBudget {
    entries: u64,
    actual_bytes: u64,
}

impl RawIngestBudget {
    fn add_entries(&mut self, count: u64, limits: RawIngestLimits) -> CoreResult<()> {
        self.entries = self
            .entries
            .checked_add(count)
            .ok_or_else(|| CoreError::Policy("raw log entry count overflow".into()))?;
        if self.entries > limits.max_entries {
            return Err(CoreError::Policy(format!(
                "raw log entry limit exceeded ({} > {})",
                self.entries, limits.max_entries
            )));
        }
        Ok(())
    }
}

struct BoundedSourceReader<'a, R> {
    inner: R,
    budget: &'a mut RawIngestBudget,
    member_bytes: u64,
    member_limit: u64,
    aggregate_limit: u64,
    counts_toward_aggregate: bool,
    cancel: Option<&'a CancelFlag>,
}

impl<'a, R> BoundedSourceReader<'a, R> {
    fn new(
        inner: R,
        budget: &'a mut RawIngestBudget,
        limits: RawIngestLimits,
        cancel: Option<&'a CancelFlag>,
    ) -> Self {
        Self {
            inner,
            budget,
            member_bytes: 0,
            member_limit: limits.max_file_bytes,
            aggregate_limit: limits.max_expanded_bytes,
            counts_toward_aggregate: false,
            cancel,
        }
    }

    /// Charge bytes already read for classification, then charge future reads.
    ///
    /// Hidden, binary, nested-archive, and other excluded entries never call
    /// this method, so sniffing them cannot consume the aggregate import budget.
    fn commit_to_aggregate(&mut self) -> CoreResult<()> {
        if self.counts_toward_aggregate {
            return Ok(());
        }
        let aggregate_total = self
            .budget
            .actual_bytes
            .checked_add(self.member_bytes)
            .ok_or_else(|| CoreError::Policy("raw log actual-byte count overflow".into()))?;
        if aggregate_total > self.aggregate_limit {
            return Err(CoreError::Policy(format!(
                "raw log aggregate actual-byte limit exceeded ({} > {})",
                aggregate_total, self.aggregate_limit
            )));
        }
        self.budget.actual_bytes = aggregate_total;
        self.counts_toward_aggregate = true;
        Ok(())
    }
}

impl<R: Read> Read for BoundedSourceReader<'_, R> {
    fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
        if cancelled(self.cancel) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Interrupted,
                "ingest cancelled during source read",
            ));
        }
        if output.is_empty() {
            return Ok(0);
        }
        let member_remaining = self.member_limit.saturating_sub(self.member_bytes);
        let mut allowed = output
            .len()
            .min(usize::try_from(member_remaining.saturating_add(1)).unwrap_or(usize::MAX));
        if self.counts_toward_aggregate {
            let aggregate_remaining = self
                .aggregate_limit
                .saturating_sub(self.budget.actual_bytes);
            allowed = allowed
                .min(usize::try_from(aggregate_remaining.saturating_add(1)).unwrap_or(usize::MAX));
        }
        let read = self.inner.read(&mut output[..allowed])?;
        if read == 0 {
            return Ok(0);
        }
        let read = read as u64;
        let member_total = self.member_bytes.saturating_add(read);
        if member_total > self.member_limit {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "raw log member actual-byte limit exceeded",
            ));
        }
        self.member_bytes = member_total;
        if self.counts_toward_aggregate {
            let aggregate_total = self.budget.actual_bytes.saturating_add(read);
            if aggregate_total > self.aggregate_limit {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "raw log aggregate actual-byte limit exceeded",
                ));
            }
            self.budget.actual_bytes = aggregate_total;
        }
        Ok(read as usize)
    }
}

/// Hidden, same-filesystem cache used until a new corpus is fully validated.
///
/// The final `log_corpora/{id}` path does not exist until [`Self::publish`].
/// Normal success, error, and cancellation paths call checked cleanup. Drop
/// retries best-effort for unwinding/process teardown; a process crash or an
/// uncooperative filesystem can still leave an orphan for bounded cleanup on
/// a later ingest.
struct IngestStaging {
    parent: PathBuf,
    root: PathBuf,
    cleaned: bool,
}

impl IngestStaging {
    fn new(cache_root: &Path) -> CoreResult<Self> {
        let parent = cache_root.join(".log_ingest_staging");
        std::fs::create_dir_all(&parent)?;
        cleanup_abandoned_staging(&parent);
        let root = parent.join(Uuid::now_v7().to_string());
        let builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        let mut builder = builder;
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(&root)?;
        Ok(Self {
            parent,
            root,
            cleaned: false,
        })
    }

    fn cache_root(&self) -> &Path {
        &self.root
    }

    fn publish(&mut self, cache_root: &Path, corpus_id: &str) -> CoreResult<()> {
        let source = self.root.join("log_corpora").join(corpus_id);
        let corpora_root = cache_root.join("log_corpora");
        let destination = corpora_root.join(corpus_id);
        if destination.exists() {
            return Err(CoreError::Message(format!(
                "refusing to replace existing log corpus {corpus_id}"
            )));
        }
        std::fs::create_dir_all(&corpora_root)?;
        std::fs::rename(&source, &destination)
            .map_err(|e| CoreError::Message(format!("publish log corpus: {e}")))?;
        Ok(())
    }

    fn cleanup_checked(&mut self) -> CoreResult<()> {
        if self.cleaned {
            return Ok(());
        }
        match std::fs::symlink_metadata(&self.root) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                return Err(CoreError::Policy(
                    "private ingest staging root changed to a symlink or non-directory".into(),
                ));
            }
            Ok(_) => std::fs::remove_dir_all(&self.root)
                .map_err(|error| CoreError::Message(format!("remove ingest staging: {error}")))?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(CoreError::Message(format!(
                    "inspect ingest staging before cleanup: {error}"
                )))
            }
        }
        // Concurrent ingests may still own sibling directories. A non-empty
        // parent is expected and must not make this ingest fail.
        match std::fs::remove_dir(&self.parent) {
            Ok(()) => {}
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::DirectoryNotEmpty
                ) => {}
            Err(error) => {
                return Err(CoreError::Message(format!(
                    "remove empty ingest staging parent: {error}"
                )))
            }
        }
        self.cleaned = true;
        Ok(())
    }

    fn cleanup_best_effort(&mut self) {
        let _ = self.cleanup_checked();
    }
}

impl Drop for IngestStaging {
    fn drop(&mut self) {
        self.cleanup_best_effort();
    }
}

fn cleanup_abandoned_staging(parent: &Path) {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_secs());
    cleanup_abandoned_staging_at(parent, now);
}

fn cleanup_abandoned_staging_at(parent: &Path, now_unix_secs: u64) -> usize {
    let Ok(entries) = std::fs::read_dir(parent) else {
        return 0;
    };
    let mut removed = 0usize;
    for entry in entries.take(MAX_ABANDONED_STAGING_SCAN).flatten() {
        if removed >= MAX_ABANDONED_STAGING_REMOVALS {
            break;
        }
        let path = entry.path();
        let Some(created_secs) = entry
            .file_name()
            .to_str()
            .and_then(|name| Uuid::parse_str(name).ok())
            .and_then(|id| id.get_timestamp())
            .map(|timestamp| timestamp.to_unix().0)
        else {
            continue;
        };
        if now_unix_secs.saturating_sub(created_secs) < ABANDONED_STAGING_AGE_SECS {
            continue;
        }
        let Ok(metadata) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            continue;
        }
        // Startup cleanup is deliberately bounded and best-effort. Normal
        // in-process cleanup is checked; this path handles only crash or
        // forced-termination remnants without blocking a new import.
        if std::fs::remove_dir_all(path).is_ok() {
            removed += 1;
        }
    }
    removed
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum IngestCheckpoint {
    CorpusCreated,
    EventsStored,
    BeforeTemplates,
    DuringEmbedding,
    BeforeSummary,
    BeforeValidation,
    BeforePublish,
}

type IngestFaultHook<'a> = Option<&'a dyn Fn(IngestCheckpoint) -> CoreResult<()>>;

fn check_ingest_fault(hook: IngestFaultHook<'_>, checkpoint: IngestCheckpoint) -> CoreResult<()> {
    match hook {
        Some(hook) => hook(checkpoint),
        None => Ok(()),
    }
}

fn reconcile_ingest_cleanup<T>(
    ingest_result: CoreResult<T>,
    cleanup_result: CoreResult<()>,
) -> CoreResult<(T, bool)> {
    match (ingest_result, cleanup_result) {
        (Ok(value), Ok(())) => Ok((value, false)),
        (Ok(value), Err(_)) => {
            // Publication is the commit point. A later private-staging cleanup
            // failure must not make the host report that an import which is
            // already visible did not happen. The completion event carries a
            // bounded maintenance warning, and Drop retries cleanup.
            Ok((value, true))
        }
        (Err(error), Ok(())) => Err(error),
        (Err(error), Err(cleanup_error)) => Err(CoreError::Message(format!(
            "{error}; private ingest staging cleanup also failed: {cleanup_error}"
        ))),
    }
}

fn is_zip_file(path: &Path) -> bool {
    std::fs::symlink_metadata(path)
        .is_ok_and(|metadata| metadata.is_file() && !metadata.file_type().is_symlink())
        && path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("zip"))
            .unwrap_or(false)
}

#[cfg(windows)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct WindowsFileIdentity {
    volume_serial: u32,
    file_index: u64,
}

#[cfg(windows)]
fn windows_open_no_follow(path: &Path, context: &str) -> CoreResult<std::fs::File> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;

    let mut options = std::fs::OpenOptions::new();
    options
        .read(true)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    options
        .open(path)
        .map_err(|error| CoreError::Message(format!("{context}: {error}")))
}

#[cfg(windows)]
fn windows_opened_file_details(
    file: &std::fs::File,
) -> CoreResult<(WindowsFileIdentity, u32, PathBuf)> {
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, GetFinalPathNameByHandleW, BY_HANDLE_FILE_INFORMATION,
        FILE_NAME_NORMALIZED, VOLUME_NAME_DOS,
    };

    let handle = file.as_raw_handle() as HANDLE;
    let mut information = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: `handle` is owned by the live `File`, and `information` points to
    // valid writable storage for the duration of the call.
    if unsafe { GetFileInformationByHandle(handle, &mut information) } == 0 {
        return Err(CoreError::Message(format!(
            "read opened Windows file identity: {}",
            std::io::Error::last_os_error()
        )));
    }
    let identity = WindowsFileIdentity {
        volume_serial: information.dwVolumeSerialNumber,
        file_index: ((information.nFileIndexHigh as u64) << 32) | information.nFileIndexLow as u64,
    };

    let flags = FILE_NAME_NORMALIZED | VOLUME_NAME_DOS;
    // SAFETY: a null, zero-length first call requests the required UTF-16
    // buffer length for this live handle.
    let required = unsafe { GetFinalPathNameByHandleW(handle, std::ptr::null_mut(), 0, flags) };
    if required == 0 {
        return Err(CoreError::Message(format!(
            "read opened Windows final path length: {}",
            std::io::Error::last_os_error()
        )));
    }
    let mut buffer = vec![0u16; required as usize + 1];
    // SAFETY: `buffer` is writable for the supplied capacity and the handle
    // remains live for the entire call.
    let written = unsafe {
        GetFinalPathNameByHandleW(handle, buffer.as_mut_ptr(), buffer.len() as u32, flags)
    };
    if written == 0 || written as usize >= buffer.len() {
        return Err(CoreError::Message(format!(
            "read opened Windows final path: {}",
            std::io::Error::last_os_error()
        )));
    }
    buffer.truncate(written as usize);
    let final_path = PathBuf::from(std::ffi::OsString::from_wide(&buffer));
    Ok((identity, information.dwFileAttributes, final_path))
}

#[cfg(windows)]
fn windows_validate_regular_handle(
    file: &std::fs::File,
    expected_final_path: &Path,
    allowed_root: Option<&Path>,
    changed_message: &str,
) -> CoreResult<(WindowsFileIdentity, PathBuf)> {
    use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;

    let (identity, attributes, final_path) = windows_opened_file_details(file)?;
    let opened = file
        .metadata()
        .map_err(|error| CoreError::Message(format!("read opened source metadata: {error}")))?;
    if attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 || !opened.is_file() {
        return Err(CoreError::Policy(
            "opened log source is a reparse point or non-regular file".into(),
        ));
    }
    if final_path != expected_final_path
        || allowed_root.is_some_and(|root| !final_path.starts_with(root))
    {
        return Err(CoreError::Policy(changed_message.into()));
    }
    Ok((identity, final_path))
}

#[cfg(windows)]
fn windows_secure_open_regular_file(
    path: &Path,
    expected_final_path: &Path,
    allowed_root: Option<&Path>,
    open_context: &str,
    changed_message: &str,
) -> CoreResult<std::fs::File> {
    let file = windows_open_no_follow(path, open_context)?;
    let (identity, final_path) =
        windows_validate_regular_handle(&file, expected_final_path, allowed_root, changed_message)?;

    // Reopen with the same no-follow policy and compare stable handle identity.
    // The returned first handle remains safe even if the pathname changes
    // after validation; a replacement during validation is rejected.
    let verification = windows_open_no_follow(path, open_context)?;
    let (verification_identity, verification_final_path) = windows_validate_regular_handle(
        &verification,
        expected_final_path,
        allowed_root,
        changed_message,
    )?;
    if identity != verification_identity || final_path != verification_final_path {
        return Err(CoreError::Policy(changed_message.into()));
    }
    Ok(file)
}

fn open_selected_regular_file(path: &Path) -> CoreResult<std::fs::File> {
    let before = std::fs::symlink_metadata(path)
        .map_err(|e| CoreError::Message(format!("read source metadata: {e}")))?;
    if before.file_type().is_symlink() || !before.is_file() {
        return Err(CoreError::Policy(
            "selected log source is a symlink or non-regular file".into(),
        ));
    }
    #[cfg(windows)]
    let file = {
        use std::os::windows::fs::MetadataExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;

        if before.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(CoreError::Policy(
                "selected log source is a reparse point".into(),
            ));
        }
        let expected = std::fs::canonicalize(path)
            .map_err(|error| CoreError::Message(format!("resolve selected source: {error}")))?;
        windows_secure_open_regular_file(
            path,
            &expected,
            None,
            "open source",
            "selected log source changed during secure open",
        )?
    };
    #[cfg(not(windows))]
    let file =
        std::fs::File::open(path).map_err(|e| CoreError::Message(format!("open source: {e}")))?;
    #[cfg(not(windows))]
    let opened = file
        .metadata()
        .map_err(|e| CoreError::Message(format!("read opened source metadata: {e}")))?;
    #[cfg(not(windows))]
    if !opened.is_file() {
        return Err(CoreError::Policy(
            "opened log source is not a regular file".into(),
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if before.dev() != opened.dev() || before.ino() != opened.ino() {
            return Err(CoreError::Policy(
                "selected log source changed during secure open".into(),
            ));
        }
    }
    Ok(file)
}

fn has_zip_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("zip"))
}

fn has_zip_signature(bytes: &[u8]) -> bool {
    matches!(
        bytes.get(..4),
        Some(b"PK\x03\x04" | b"PK\x05\x06" | b"PK\x07\x08")
    )
}

fn is_hidden_archive_identity(identity: &str) -> bool {
    identity
        .split('/')
        .any(|component| component.starts_with('.'))
}

fn validate_raw_log_zip_entry(name: &str) -> CoreResult<(String, bool)> {
    let directory = name.ends_with('/');
    if name.is_empty()
        || name.starts_with(['/', '\\'])
        || name.contains('\\')
        || name.contains("!/")
        || name.contains("//")
        || name.contains('\0')
    {
        return Err(CoreError::Policy(
            "raw log zip entry path rejected by policy".into(),
        ));
    }
    let normalized = if directory {
        name.strip_suffix('/').unwrap_or(name)
    } else {
        name
    };
    if normalized.is_empty()
        || normalized
            .as_bytes()
            .get(1)
            .is_some_and(|byte| *byte == b':')
            && normalized
                .as_bytes()
                .first()
                .is_some_and(u8::is_ascii_alphabetic)
        || normalized
            .split('/')
            .any(|component| component.is_empty() || matches!(component, "." | ".."))
    {
        return Err(CoreError::Policy(
            "raw log zip entry path rejected by policy".into(),
        ));
    }
    Ok((normalized.to_string(), directory))
}

fn portable_source_identity(path: &Path) -> CoreResult<String> {
    let mut components = Vec::new();
    let mut path_components = path.components().peekable();
    while let Some(component) = path_components.next() {
        match component {
            std::path::Component::Normal(value) => {
                let value = value.to_string_lossy();
                // A leaf ending in `!` is unambiguous and remains a faithful
                // source label. Only a non-leaf `name!/child` collides with
                // the virtual archive-boundary syntax.
                if value.ends_with('!') && path_components.peek().is_some() {
                    return Err(CoreError::Policy(
                        "log source identity conflicts with archive boundary syntax".into(),
                    ));
                }
                components.push(value.into_owned())
            }
            std::path::Component::CurDir => {}
            _ => {
                return Err(CoreError::Policy(
                    "log source identity escaped its import root".into(),
                ))
            }
        }
    }
    if components.is_empty() {
        return Err(CoreError::Policy(
            "log source identity is empty after normalization".into(),
        ));
    }
    Ok(components.join("/"))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ZipEntryDisposition {
    Import,
    Directory,
    Hidden,
    NestedArchive,
    Symlink,
    NonRegular,
    TooLarge,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ZipEntryPlan {
    identity: String,
    expanded_size: u64,
    compressed_size: u64,
    disposition: ZipEntryDisposition,
}

fn compression_ratio_exceeded(expanded: u64, compressed: u64, limit: u64) -> bool {
    expanded > 0
        && (compressed == 0
            || compressed
                .checked_mul(limit)
                .is_none_or(|allowed| expanded > allowed))
}

fn read_zip_u16(bytes: &[u8], offset: usize) -> CoreResult<u16> {
    let value = bytes
        .get(offset..offset + 2)
        .ok_or_else(|| CoreError::Message("raw log zip metadata is truncated".into()))?;
    Ok(u16::from_le_bytes([value[0], value[1]]))
}

fn read_zip_u32(bytes: &[u8], offset: usize) -> CoreResult<u32> {
    let value = bytes
        .get(offset..offset + 4)
        .ok_or_else(|| CoreError::Message("raw log zip metadata is truncated".into()))?;
    Ok(u32::from_le_bytes([value[0], value[1], value[2], value[3]]))
}

fn read_zip_u64(bytes: &[u8], offset: usize) -> CoreResult<u64> {
    let value = bytes
        .get(offset..offset + 8)
        .ok_or_else(|| CoreError::Message("raw log zip metadata is truncated".into()))?;
    Ok(u64::from_le_bytes([
        value[0], value[1], value[2], value[3], value[4], value[5], value[6], value[7],
    ]))
}

fn resolve_zip64_entry_values(
    extra: &[u8],
    expanded32: u32,
    compressed32: u32,
    local_offset32: u32,
    disk_start16: u16,
) -> CoreResult<(u64, u64, u64, u32)> {
    let mut expanded = (expanded32 != u32::MAX).then_some(expanded32 as u64);
    let mut compressed = (compressed32 != u32::MAX).then_some(compressed32 as u64);
    let mut local_offset = (local_offset32 != u32::MAX).then_some(local_offset32 as u64);
    let mut disk_start = (disk_start16 != u16::MAX).then_some(disk_start16 as u32);
    let mut cursor = 0usize;
    while cursor < extra.len() {
        let kind = read_zip_u16(extra, cursor)?;
        let size = read_zip_u16(extra, cursor + 2)? as usize;
        cursor = cursor
            .checked_add(4)
            .ok_or_else(|| CoreError::Policy("raw log zip extra-field overflow".into()))?;
        let end = cursor
            .checked_add(size)
            .ok_or_else(|| CoreError::Policy("raw log zip extra-field overflow".into()))?;
        let field = extra
            .get(cursor..end)
            .ok_or_else(|| CoreError::Policy("raw log zip extra field is truncated".into()))?;
        if kind == 0x0001 {
            let mut offset = 0usize;
            let carries_all_sizes = field.len() >= 24;
            if expanded.is_none() || carries_all_sizes {
                expanded = Some(read_zip_u64(field, offset)?);
                offset += 8;
            }
            if compressed.is_none() || carries_all_sizes {
                compressed = Some(read_zip_u64(field, offset)?);
                offset += 8;
            }
            if local_offset.is_none() || carries_all_sizes {
                local_offset = Some(read_zip_u64(field, offset)?);
                offset += 8;
            }
            if disk_start.is_none() {
                disk_start = Some(read_zip_u32(field, offset)?);
            }
        } else if kind == 0x9901 {
            return Err(CoreError::Policy(
                "encrypted raw log zip entries are not supported".into(),
            ));
        }
        cursor = end;
    }
    let malformed =
        || CoreError::Policy("Zip64 raw log archive entry is missing resolved metadata".into());
    Ok((
        expanded.ok_or_else(malformed)?,
        compressed.ok_or_else(malformed)?,
        local_offset.ok_or_else(malformed)?,
        disk_start.ok_or_else(malformed)?,
    ))
}

fn locate_raw_log_zip_directory<R: Read + Seek>(file: &mut R) -> CoreResult<(u64, u64, u64)> {
    const EOCD_MIN_BYTES: usize = 22;
    const MAX_ZIP_COMMENT_BYTES: usize = u16::MAX as usize;
    const EOCD_SIGNATURE: &[u8; 4] = b"PK\x05\x06";
    const ZIP64_LOCATOR_SIGNATURE: &[u8; 4] = b"PK\x06\x07";
    const ZIP64_EOCD_SIGNATURE: &[u8; 4] = b"PK\x06\x06";

    // Length via seek rather than `File::metadata`, so this works for any
    // `Read + Seek` — the preview inventories a nested archive from an
    // in-memory cursor, because staging it to disk would be a write.
    let file_len: u64 = file
        .seek(SeekFrom::End(0))
        .map_err(|e| CoreError::Message(format!("read zip length: {e}")))?;
    if file_len < EOCD_MIN_BYTES as u64 {
        return Err(CoreError::Message("zip open: missing end record".into()));
    }
    let tail_len = usize::try_from(file_len)
        .unwrap_or(usize::MAX)
        .min(EOCD_MIN_BYTES + MAX_ZIP_COMMENT_BYTES);
    file.seek(SeekFrom::End(-(tail_len as i64)))
        .map_err(|e| CoreError::Message(format!("seek zip tail: {e}")))?;
    let mut tail = vec![0u8; tail_len];
    file.read_exact(&mut tail)
        .map_err(|e| CoreError::Message(format!("read zip tail: {e}")))?;
    let eocd_in_tail = (0..=tail.len().saturating_sub(EOCD_SIGNATURE.len()))
        .rev()
        .find(|position| {
            tail.get(*position..*position + 4) == Some(EOCD_SIGNATURE)
                && tail
                    .get(*position + 20..*position + 22)
                    .is_some_and(|comment| {
                        *position
                            + EOCD_MIN_BYTES
                            + u16::from_le_bytes([comment[0], comment[1]]) as usize
                            == tail.len()
                    })
        })
        .ok_or_else(|| CoreError::Message("zip open: missing end record".into()))?;
    let absolute_eocd = file_len - tail_len as u64 + eocd_in_tail as u64;
    let eocd = &tail[eocd_in_tail..];
    let disk = read_zip_u16(eocd, 4)?;
    let central_disk = read_zip_u16(eocd, 6)?;
    let entries_on_disk = read_zip_u16(eocd, 8)?;
    let entries_total = read_zip_u16(eocd, 10)?;
    let central_size32 = read_zip_u32(eocd, 12)?;
    let central_offset32 = read_zip_u32(eocd, 16)?;
    if disk != 0 || central_disk != 0 || entries_on_disk != entries_total {
        return Err(CoreError::Policy(
            "multi-disk raw log archives are not supported".into(),
        ));
    }

    let needs_zip64 =
        entries_total == u16::MAX || central_size32 == u32::MAX || central_offset32 == u32::MAX;
    let (entry_count, central_size, central_offset, expected_central_end) = if needs_zip64 {
        let locator_offset = absolute_eocd
            .checked_sub(20)
            .ok_or_else(|| CoreError::Policy("Zip64 raw log archive locator is missing".into()))?;
        file.seek(SeekFrom::Start(locator_offset))
            .map_err(|e| CoreError::Message(format!("seek Zip64 locator: {e}")))?;
        let mut locator = [0u8; 20];
        file.read_exact(&mut locator)
            .map_err(|e| CoreError::Message(format!("read Zip64 locator: {e}")))?;
        if &locator[..4] != ZIP64_LOCATOR_SIGNATURE
            || read_zip_u32(&locator, 4)? != 0
            || read_zip_u32(&locator, 16)? != 1
        {
            return Err(CoreError::Policy(
                "Zip64 raw log archive locator is invalid or multi-disk".into(),
            ));
        }
        let zip64_eocd_offset = read_zip_u64(&locator, 8)?;
        file.seek(SeekFrom::Start(zip64_eocd_offset))
            .map_err(|e| CoreError::Message(format!("seek Zip64 end record: {e}")))?;
        let mut zip64_eocd = [0u8; 56];
        file.read_exact(&mut zip64_eocd)
            .map_err(|e| CoreError::Message(format!("read Zip64 end record: {e}")))?;
        if &zip64_eocd[..4] != ZIP64_EOCD_SIGNATURE {
            return Err(CoreError::Policy(
                "Zip64 raw log archive end record is invalid".into(),
            ));
        }
        let record_size = read_zip_u64(&zip64_eocd, 4)?;
        if record_size < 44
            || zip64_eocd_offset
                .checked_add(12)
                .and_then(|offset| offset.checked_add(record_size))
                != Some(locator_offset)
        {
            return Err(CoreError::Policy(
                "Zip64 raw log archive end record length is inconsistent".into(),
            ));
        }
        let disk64 = read_zip_u32(&zip64_eocd, 16)?;
        let central_disk64 = read_zip_u32(&zip64_eocd, 20)?;
        let entries_on_disk64 = read_zip_u64(&zip64_eocd, 24)?;
        let entries_total64 = read_zip_u64(&zip64_eocd, 32)?;
        if disk64 != 0 || central_disk64 != 0 || entries_on_disk64 != entries_total64 {
            return Err(CoreError::Policy(
                "multi-disk Zip64 raw log archives are not supported".into(),
            ));
        }
        (
            entries_total64,
            read_zip_u64(&zip64_eocd, 40)?,
            read_zip_u64(&zip64_eocd, 48)?,
            zip64_eocd_offset,
        )
    } else {
        (
            entries_total as u64,
            central_size32 as u64,
            central_offset32 as u64,
            absolute_eocd,
        )
    };
    let central_end = central_offset
        .checked_add(central_size)
        .ok_or_else(|| CoreError::Policy("raw log zip central directory overflow".into()))?;
    if central_end != expected_central_end || central_end > file_len {
        return Err(CoreError::Policy(
            "raw log zip central directory is inconsistent".into(),
        ));
    }
    Ok((entry_count, central_offset, central_end))
}

/// Validate and classify every central-directory entry before reading payload.
///
/// `zip` resolves valid Zip64 records and rejects missing/corrupt Zip64
/// metadata, inconsistent central directories, and multi-disk archives. We
/// independently walk every raw central entry so no name-index collapsing can
/// hide duplicate or traversal ambiguity.
fn preflight_raw_log_zip<R: Read + Seek>(
    file: &mut R,
    budget: &mut RawIngestBudget,
    limits: RawIngestLimits,
    cancel: Option<&CancelFlag>,
) -> CoreResult<Vec<ZipEntryPlan>> {
    const CENTRAL_HEADER_BYTES: usize = 46;
    const MAX_RAW_LOG_ENTRY_NAME_BYTES: usize = 4 * 1024;
    const CENTRAL_SIGNATURE: &[u8; 4] = b"PK\x01\x02";

    let (entry_count, central_offset, central_end) = locate_raw_log_zip_directory(file)?;
    budget.add_entries(entry_count, limits)?;
    let entry_capacity = usize::try_from(entry_count)
        .map_err(|_| CoreError::Policy("raw log zip entry count exceeds memory range".into()))?;
    let mut names = std::collections::HashSet::with_capacity(entry_capacity);
    let mut plans = Vec::with_capacity(entry_capacity);
    file.seek(SeekFrom::Start(central_offset))
        .map_err(|e| CoreError::Message(format!("seek zip central directory: {e}")))?;
    for _ in 0..entry_count {
        if cancelled(cancel) {
            return Err(CoreError::Cancelled);
        }
        let mut header = [0u8; CENTRAL_HEADER_BYTES];
        file.read_exact(&mut header)
            .map_err(|e| CoreError::Message(format!("read zip central directory: {e}")))?;
        if &header[..4] != CENTRAL_SIGNATURE {
            return Err(CoreError::Policy(
                "raw log zip central directory entry is invalid".into(),
            ));
        }
        let flags = read_zip_u16(&header, 8)?;
        let compressed32 = read_zip_u32(&header, 20)?;
        let expanded32 = read_zip_u32(&header, 24)?;
        let name_len = read_zip_u16(&header, 28)? as usize;
        let extra_len = read_zip_u16(&header, 30)? as usize;
        let comment_len = read_zip_u16(&header, 32)? as usize;
        let disk_start16 = read_zip_u16(&header, 34)?;
        let external_attributes = read_zip_u32(&header, 38)?;
        let local_offset32 = read_zip_u32(&header, 42)?;
        if flags & 1 != 0 || flags & (1 << 6) != 0 {
            return Err(CoreError::Policy(
                "encrypted raw log zip entries are not supported".into(),
            ));
        }
        if name_len == 0 || name_len > MAX_RAW_LOG_ENTRY_NAME_BYTES {
            return Err(CoreError::Policy(
                "raw log zip entry name exceeds policy limit".into(),
            ));
        }
        let mut name_bytes = vec![0u8; name_len];
        file.read_exact(&mut name_bytes)
            .map_err(|e| CoreError::Message(format!("read zip entry name: {e}")))?;
        let name = std::str::from_utf8(&name_bytes)
            .map_err(|_| CoreError::Policy("raw log zip entry name is not UTF-8".into()))?;
        let (identity, directory_name) = validate_raw_log_zip_entry(name)?;
        if !names.insert(identity.clone()) {
            return Err(CoreError::Policy(
                "duplicate raw log zip entry rejected by policy".into(),
            ));
        }
        let mut extra = vec![0u8; extra_len];
        file.read_exact(&mut extra)
            .map_err(|e| CoreError::Message(format!("read zip entry extra field: {e}")))?;
        file.seek(SeekFrom::Current(i64::try_from(comment_len).map_err(
            |_| CoreError::Policy("raw log zip entry comment exceeds seek range".into()),
        )?))
        .map_err(|e| CoreError::Message(format!("seek zip entry comment: {e}")))?;
        let (expanded_size, compressed_size, _local_offset, disk_start) =
            resolve_zip64_entry_values(
                &extra,
                expanded32,
                compressed32,
                local_offset32,
                disk_start16,
            )?;
        if disk_start != 0 {
            return Err(CoreError::Policy(
                "multi-disk raw log archive entries are not supported".into(),
            ));
        }
        let unix_kind = (external_attributes >> 16) & 0o170000;
        let disposition = if unix_kind == 0o120000 {
            ZipEntryDisposition::Symlink
        } else if directory_name || unix_kind == 0o040000 {
            ZipEntryDisposition::Directory
        } else if !matches!(unix_kind, 0 | 0o100000) {
            ZipEntryDisposition::NonRegular
        } else if is_hidden_archive_identity(&identity) {
            ZipEntryDisposition::Hidden
        } else if expanded_size > limits.max_file_bytes {
            ZipEntryDisposition::TooLarge
        } else if has_zip_extension(Path::new(&identity)) {
            ZipEntryDisposition::NestedArchive
        } else {
            ZipEntryDisposition::Import
        };
        if matches!(
            disposition,
            ZipEntryDisposition::Import | ZipEntryDisposition::NestedArchive
        ) && compression_ratio_exceeded(
            expanded_size,
            compressed_size,
            limits.max_compression_ratio,
        ) {
            return Err(CoreError::Policy(format!(
                "raw log zip compression-ratio limit exceeded ({} expanded / {} compressed > {}:1)",
                expanded_size, compressed_size, limits.max_compression_ratio
            )));
        }
        plans.push(ZipEntryPlan {
            identity,
            expanded_size,
            compressed_size,
            disposition,
        });
    }
    if file
        .stream_position()
        .map_err(|e| CoreError::Message(format!("read zip position: {e}")))?
        != central_end
    {
        return Err(CoreError::Policy(
            "raw log zip central directory lengths are inconsistent".into(),
        ));
    }
    Ok(plans)
}

fn read_bounded_line(
    reader: &mut dyn BufRead,
    output: &mut Vec<u8>,
    max_line_bytes: usize,
    cancel: Option<&CancelFlag>,
    progress: &dyn ProcessProgressObserver,
    source: &Path,
) -> CoreResult<usize> {
    let mut total = 0usize;
    loop {
        if cancelled(cancel) {
            return Err(CoreError::Cancelled);
        }
        let available = match reader.fill_buf() {
            Ok(available) => available,
            Err(error) if error.kind() == std::io::ErrorKind::InvalidData => {
                emit_ingest_evidence(progress, LogIngestEvidenceReason::ReadFailed, source);
                return Err(CoreError::Policy(error.to_string()));
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {
                return Err(CoreError::Message(error.to_string()))
            }
            Err(error) => {
                emit_ingest_evidence(progress, LogIngestEvidenceReason::ReadFailed, source);
                return Err(CoreError::Message(format!(
                    "raw log source read failed: {error}"
                )));
            }
        };
        if available.is_empty() {
            return Ok(total);
        }
        let through_newline = available
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(available.len(), |position| position + 1);
        if output.len().saturating_add(through_newline) > max_line_bytes {
            emit_ingest_evidence(progress, LogIngestEvidenceReason::ParseFailed, source);
            return Err(CoreError::Policy(format!(
                "raw log line-length limit exceeded (>{max_line_bytes} bytes)"
            )));
        }
        let ended = available.get(through_newline.saturating_sub(1)) == Some(&b'\n');
        output.extend_from_slice(&available[..through_newline]);
        reader.consume(through_newline);
        total = total.saturating_add(through_newline);
        if ended {
            return Ok(total);
        }
    }
}

/// Accumulate operation wall time into shared diagnostic timers (#824).
///
/// Times are tracked in **microseconds** then floored to milliseconds on read so
/// many sub-ms line operations still sum into truthful ms buckets.
fn add_op_us(ops: &std::sync::Mutex<IngestPhaseTimingsUs>, op: IngestOp, us: u64) {
    let mut t = ops.lock().expect("ingest op timers");
    match op {
        IngestOp::DiscoverRead => t.discover_read_us = t.discover_read_us.saturating_add(us),
        IngestOp::ParseFrame => t.parse_frame_us = t.parse_frame_us.saturating_add(us),
        IngestOp::Template => t.template_analysis_us = t.template_analysis_us.saturating_add(us),
        IngestOp::Persist => t.persist_index_us = t.persist_index_us.saturating_add(us),
        IngestOp::Embed => t.optional_embedding_us = t.optional_embedding_us.saturating_add(us),
        IngestOp::Validate => t.validation_us = t.validation_us.saturating_add(us),
        IngestOp::Publish => t.publication_us = t.publication_us.saturating_add(us),
    }
}

#[derive(Debug, Default, Clone)]
struct IngestPhaseTimingsUs {
    discover_read_us: u64,
    parse_frame_us: u64,
    template_analysis_us: u64,
    persist_index_us: u64,
    optional_embedding_us: u64,
    validation_us: u64,
    publication_us: u64,
}

impl IngestPhaseTimingsUs {
    fn to_ms(&self) -> IngestPhaseTimings {
        IngestPhaseTimings {
            discover_read_ms: self.discover_read_us / 1000,
            parse_frame_ms: self.parse_frame_us / 1000,
            template_analysis_ms: self.template_analysis_us / 1000,
            persist_index_ms: self.persist_index_us / 1000,
            optional_embedding_ms: self.optional_embedding_us / 1000,
            validation_ms: self.validation_us / 1000,
            publication_ms: self.publication_us / 1000,
            total_ms: 0,
            embedding_deferred: false,
        }
    }
}

fn time_op_ms<R>(
    ops: &std::sync::Mutex<IngestPhaseTimingsUs>,
    op: IngestOp,
    f: impl FnOnce() -> R,
) -> R {
    let start = std::time::Instant::now();
    let result = f();
    add_op_us(ops, op, start.elapsed().as_micros() as u64);
    result
}

fn time_op_result_ms<R, E>(
    ops: &std::sync::Mutex<IngestPhaseTimingsUs>,
    op: IngestOp,
    f: impl FnOnce() -> Result<R, E>,
) -> Result<R, E> {
    let start = std::time::Instant::now();
    let result = f();
    add_op_us(ops, op, start.elapsed().as_micros() as u64);
    result
}

/// Parse lines from a streaming reader into the corpus batch (shared by dir + zip).
#[allow(clippy::too_many_arguments)]
fn ingest_lines_from_reader(
    reader: &mut dyn BufRead,
    source_label: &str,
    file_hint: Option<&Path>,
    corpus: &LogCorpus,
    miner: &mut DrainMiner,
    stats: &mut IngestStats,
    confidence: &mut IngestConfidenceAggregator,
    seq: &mut u64,
    batch: &mut Vec<IngestedLogEvent>,
    files_done: u64,
    file_count: u64,
    progress: &dyn ProcessProgressObserver,
    cancel: Option<&CancelFlag>,
    kind: ProcessProgressKind,
    limits: RawIngestLimits,
    ops: &std::sync::Mutex<IngestPhaseTimingsUs>,
) -> CoreResult<bool> {
    let mut raw_line = Vec::new();
    let mut source_bytes_read = 0u64;
    loop {
        if cancelled(cancel) {
            emit(
                progress,
                ProcessProgress::phase(
                    kind,
                    ProcessProgressPhase::Cancelled,
                    "ingest cancelled during streaming import",
                    false,
                )
                .with_lines(stats.lines)
                .with_files(files_done)
                .with_bytes(stats.source_bytes),
            );
            return Err(CoreError::Cancelled);
        }
        raw_line.clear();
        let bytes = time_op_result_ms(ops, IngestOp::DiscoverRead, || {
            read_bounded_line(
                reader,
                &mut raw_line,
                limits.max_line_bytes,
                cancel,
                progress,
                Path::new(source_label),
            )
        })?;
        if bytes == 0 {
            break;
        }
        source_bytes_read = source_bytes_read.saturating_add(bytes as u64);
        if source_bytes_read > limits.max_file_bytes {
            return Err(CoreError::Policy(format!(
                "raw log member actual-byte limit exceeded ({} > {})",
                source_bytes_read, limits.max_file_bytes
            )));
        }
        stats.source_bytes = stats.source_bytes.saturating_add(bytes as u64);
        let prepared_original = time_op_ms(ops, IngestOp::ParseFrame, || {
            prepare_original_record(&raw_line)
        });
        let line = prepared_original.parser_text.as_str();
        if line.trim().is_empty() {
            continue;
        }
        // Every bounded physical record is fingerprinted independently. A
        // plain banner cannot lock the rest of a file to Plain, and mixed
        // structured records remain independently explainable.
        let fingerprinted = time_op_ms(ops, IngestOp::ParseFrame, || {
            parse_line_with_fingerprint(line, file_hint, *seq)
        });
        confidence.observe(source_label, &fingerprinted);
        let parsed = fingerprinted.parsed;
        *stats
            .timestamp_provenance_counts
            .entry(parsed.timestamp_provenance.as_storage_str().into())
            .or_insert(0) += 1;
        *stats
            .active_timestamp_basis_counts
            .entry(parsed.active_timestamp_basis.as_storage_str().into())
            .or_insert(0) += 1;
        let fmt_key = match parsed.format {
            LogFormat::Json => "json",
            LogFormat::Logfmt => "logfmt",
            LogFormat::Syslog => "syslog",
            LogFormat::Plain => "plain",
        };
        *stats.format_counts.entry(fmt_key.into()).or_insert(0) += 1;
        let msg = time_op_ms(ops, IngestOp::ParseFrame, || {
            redact_message(&parsed.message)
        });
        let ts = parsed.ts.unwrap_or(*seq as i64);
        stats.ts_min = Some(stats.ts_min.map_or(ts, |m| m.min(ts)));
        stats.ts_max = Some(stats.ts_max.map_or(ts, |m| m.max(ts)));
        let level_key = parsed.level.to_ascii_lowercase();
        *stats.level_counts.entry(level_key).or_insert(0) += 1;
        let (tid, params) = time_op_result_ms(ops, IngestOp::Template, || {
            miner.match_or_create_cancellable(&msg, ts, &parsed.level, cancel)
        })?;
        let params = time_op_ms(ops, IngestOp::ParseFrame, || redact_params(&params));
        batch.push(IngestedLogEvent {
            event: LogEvent {
                seq: *seq,
                ts,
                timestamp_provenance: parsed.timestamp_provenance,
                active_timestamp_basis: parsed.active_timestamp_basis,
                unresolved_local_timestamp: parsed.unresolved_local_timestamp,
                level: parsed.level,
                service: parsed.service,
                host: parsed.host,
                template_id: tid,
                params,
                trace_id: parsed.trace_id,
                message: msg,
                source: source_label.to_string(),
            },
            original: prepared_original.stored,
        });
        *seq += 1;
        stats.lines += 1;
        if batch.len() >= 256 {
            if files_done == 0 && stats.lines <= 256 {
                emit(
                    progress,
                    ProcessProgress::phase(
                        kind,
                        ProcessProgressPhase::Stream,
                        "streaming read, parse, template, and persist",
                        true,
                    )
                    .with_lines(stats.lines)
                    .with_files(files_done)
                    .with_bytes(stats.source_bytes),
                );
            }
            time_op_result_ms(ops, IngestOp::Persist, || {
                corpus.push_ingested_events(batch)
            })?;
            batch.clear();
        }
        if stats.lines.is_multiple_of(PROGRESS_EVERY_LINES) {
            emit(
                progress,
                with_stream_file_fraction(
                    ProcessProgress::phase(
                        kind,
                        ProcessProgressPhase::Stream,
                        format!(
                            "streaming import of {source_label} ({} lines so far)",
                            stats.lines
                        ),
                        true,
                    )
                    .with_lines(stats.lines)
                    .with_files(files_done)
                    .with_bytes(stats.source_bytes)
                    .with_templates(miner.templates().len() as u64),
                    files_done,
                    file_count,
                ),
            );
        }
    }
    Ok(true)
}

/// One nested archive copied into the hidden per-ingest tree.
///
/// Drop attempts to remove the file as soon as recursion returns. Normal
/// success/error/cancellation then checks removal of the enclosing
/// [`IngestStaging`] tree; crash remnants are only best-effort recoverable.
struct PrivateStagedArchive {
    path: PathBuf,
}

impl PrivateStagedArchive {
    fn create(root: &Path) -> CoreResult<(Self, std::fs::File)> {
        let mut directory = std::fs::DirBuilder::new();
        directory.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            directory.mode(0o700);
        }
        directory.create(root)?;

        let path = root.join(format!("{}.zip", Uuid::now_v7()));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options
            .open(&path)
            .map_err(|e| CoreError::Message(format!("create private nested archive: {e}")))?;
        Ok((Self { path }, file))
    }
}

impl Drop for PrivateStagedArchive {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

fn stage_nested_archive(
    reader: &mut dyn Read,
    private_staging_root: &Path,
    cancel: Option<&CancelFlag>,
) -> CoreResult<PrivateStagedArchive> {
    let (staged, mut output) = PrivateStagedArchive::create(private_staging_root)?;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        if cancelled(cancel) {
            return Err(CoreError::Cancelled);
        }
        let read = match reader.read(&mut buffer) {
            Ok(read) => read,
            Err(error) if error.kind() == std::io::ErrorKind::InvalidData => {
                return Err(CoreError::Policy(error.to_string()))
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {
                return Err(CoreError::Message(error.to_string()))
            }
            Err(error) => {
                return Err(CoreError::Message(format!(
                    "read nested raw log archive: {error}"
                )))
            }
        };
        if read == 0 {
            break;
        }
        output
            .write_all(&buffer[..read])
            .map_err(|e| CoreError::Message(format!("stage nested raw log archive: {e}")))?;
    }
    output
        .flush()
        .map_err(|e| CoreError::Message(format!("flush nested raw log archive: {e}")))?;
    Ok(staged)
}

fn archive_member_identity(archive_identity: &str, member_identity: &str) -> String {
    format!("{archive_identity}!/{member_identity}")
}

/// Stream ZIP members in-place. Nested archive members alone are copied into
/// bounded private staging because ZIP readers require `Read + Seek`.
#[allow(clippy::too_many_arguments)]
fn ingest_from_zip(
    zip_path: &Path,
    private_staging_root: &Path,
    corpus: &LogCorpus,
    miner: &mut DrainMiner,
    stats: &mut IngestStats,
    confidence: &mut IngestConfidenceAggregator,
    seq: &mut u64,
    batch: &mut Vec<IngestedLogEvent>,
    progress: &dyn ProcessProgressObserver,
    cancel: Option<&CancelFlag>,
    kind: ProcessProgressKind,
    budget: &mut RawIngestBudget,
    limits: RawIngestLimits,
    ops: &std::sync::Mutex<IngestPhaseTimingsUs>,
) -> CoreResult<u64> {
    let file = open_selected_regular_file(zip_path)?;
    let archive_identity = portable_source_identity(Path::new(&progress_basename(zip_path)))?;
    ingest_from_zip_file(
        file,
        &archive_identity,
        1,
        false,
        private_staging_root,
        corpus,
        miner,
        stats,
        confidence,
        seq,
        batch,
        progress,
        cancel,
        kind,
        budget,
        limits,
        ops,
    )
}

#[allow(clippy::too_many_arguments)]
fn ingest_from_zip_file(
    mut file: std::fs::File,
    archive_identity: &str,
    archive_depth: u8,
    prefix_members: bool,
    private_staging_root: &Path,
    corpus: &LogCorpus,
    miner: &mut DrainMiner,
    stats: &mut IngestStats,
    confidence: &mut IngestConfidenceAggregator,
    seq: &mut u64,
    batch: &mut Vec<IngestedLogEvent>,
    progress: &dyn ProcessProgressObserver,
    cancel: Option<&CancelFlag>,
    kind: ProcessProgressKind,
    budget: &mut RawIngestBudget,
    limits: RawIngestLimits,
    ops: &std::sync::Mutex<IngestPhaseTimingsUs>,
) -> CoreResult<u64> {
    if cancelled(cancel) {
        emit(
            progress,
            ProcessProgress::phase(
                kind,
                ProcessProgressPhase::Cancelled,
                "ingest cancelled before zip open",
                false,
            ),
        );
        return Err(CoreError::Cancelled);
    }
    if archive_depth == 0 || archive_depth > limits.max_archive_depth {
        return Err(CoreError::Policy(format!(
            "raw log nested archive depth limit exceeded ({} > {})",
            archive_depth, limits.max_archive_depth
        )));
    }

    let archive_file = file
        .try_clone()
        .map_err(|e| CoreError::Message(format!("clone zip source handle: {e}")))?;
    let plans = match preflight_raw_log_zip(&mut file, budget, limits, cancel) {
        Ok(plans) => plans,
        Err(error) => {
            if !cancelled(cancel) {
                emit_ingest_evidence(
                    progress,
                    LogIngestEvidenceReason::ParseFailed,
                    Path::new(archive_identity),
                );
            }
            return Err(error);
        }
    };
    let mut archive = zip::ZipArchive::new(archive_file).map_err(|e| {
        emit_ingest_evidence(
            progress,
            LogIngestEvidenceReason::ParseFailed,
            Path::new(archive_identity),
        );
        CoreError::Message(format!("zip open: {e}"))
    })?;
    if archive.len() != plans.len() {
        return Err(CoreError::Policy(
            "raw log zip entry index is ambiguous".into(),
        ));
    }
    let entry_count = plans.len() as u64;

    emit(
        progress,
        ProcessProgress::phase(
            kind,
            ProcessProgressPhase::Scan,
            format!(
                "archive {} depth {archive_depth} has {entry_count} entr(y/ies)",
                progress_basename(Path::new(archive_identity))
            ),
            true,
        )
        .with_files(entry_count),
    );

    let mut files_done = 0u64;
    for (i, plan) in plans.iter().enumerate() {
        if cancelled(cancel) {
            emit(
                progress,
                ProcessProgress::phase(
                    kind,
                    ProcessProgressPhase::Cancelled,
                    "ingest cancelled during zip stream",
                    false,
                )
                .with_lines(stats.lines)
                .with_files(files_done)
                .with_bytes(stats.source_bytes),
            );
            return Err(CoreError::Cancelled);
        }

        stats.discover();
        let rel = plan.identity.as_str();
        let nested_archive_identity = archive_member_identity(archive_identity, rel);
        let source_identity = if prefix_members {
            nested_archive_identity.clone()
        } else {
            rel.to_string()
        };
        match plan.disposition {
            ZipEntryDisposition::Import | ZipEntryDisposition::NestedArchive => {}
            ZipEntryDisposition::Directory => {
                stats.ignored("directory", Path::new(&source_identity));
                files_done += 1;
                continue;
            }
            ZipEntryDisposition::Hidden => {
                stats.ignored("hidden", Path::new(&source_identity));
                emit_ingest_evidence(
                    progress,
                    LogIngestEvidenceReason::Hidden,
                    Path::new(&source_identity),
                );
                files_done += 1;
                continue;
            }
            ZipEntryDisposition::Symlink => {
                stats.excluded("symlink", Path::new(&source_identity));
                files_done += 1;
                continue;
            }
            ZipEntryDisposition::NonRegular => {
                stats.excluded("non_regular", Path::new(&source_identity));
                files_done += 1;
                continue;
            }
            ZipEntryDisposition::TooLarge => {
                stats.excluded("too_large", Path::new(&source_identity));
                emit_ingest_evidence(
                    progress,
                    LogIngestEvidenceReason::Oversized,
                    Path::new(&source_identity),
                );
                files_done += 1;
                continue;
            }
        }

        emit(
            progress,
            ProcessProgress::phase(
                kind,
                ProcessProgressPhase::Scan,
                format!(
                    "archive member {}/{} at depth {}: {}",
                    i + 1,
                    entry_count,
                    archive_depth,
                    progress_basename(Path::new(rel))
                ),
                true,
            )
            .with_files(files_done)
            .with_lines(stats.lines)
            .with_bytes(stats.source_bytes),
        );

        let entry = archive
            .by_index(i)
            .map_err(|e| CoreError::Message(format!("zip entry: {e}")))?;
        let (runtime_identity, runtime_directory) = validate_raw_log_zip_entry(
            std::str::from_utf8(entry.name_raw())
                .map_err(|_| CoreError::Policy("raw log zip entry name is not UTF-8".into()))?,
        )?;
        if runtime_identity != rel
            || runtime_directory
            || !entry.is_file()
            || entry.is_symlink()
            || entry.encrypted()
            || entry.size() != plan.expanded_size
            || entry.compressed_size() != plan.compressed_size
        {
            return Err(CoreError::Policy(
                "raw log zip entry changed after preflight".into(),
            ));
        }

        let bounded = BoundedSourceReader::new(entry, budget, limits, cancel);
        let mut reader = BufReader::with_capacity(64 * 1024, bounded);
        let head = match reader.fill_buf() {
            Ok(bytes) => &bytes[..bytes.len().min(8192)],
            Err(error) if error.kind() == std::io::ErrorKind::InvalidData => {
                emit_ingest_evidence(
                    progress,
                    LogIngestEvidenceReason::ReadFailed,
                    Path::new(&source_identity),
                );
                return Err(CoreError::Policy(error.to_string()));
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {
                return Err(CoreError::Message(error.to_string()))
            }
            Err(error) => {
                emit_ingest_evidence(
                    progress,
                    LogIngestEvidenceReason::ReadFailed,
                    Path::new(&source_identity),
                );
                return Err(CoreError::Message(format!(
                    "raw log zip member read failed: {error}"
                )));
            }
        };
        let nested_archive =
            plan.disposition == ZipEntryDisposition::NestedArchive || has_zip_signature(head);
        if nested_archive {
            let next_depth = archive_depth.saturating_add(1);
            if next_depth > limits.max_archive_depth {
                return Err(CoreError::Policy(format!(
                    "raw log nested archive depth limit exceeded ({} > {})",
                    next_depth, limits.max_archive_depth
                )));
            }
            reader.get_mut().commit_to_aggregate()?;
            emit(
                progress,
                ProcessProgress::phase(
                    kind,
                    ProcessProgressPhase::Scan,
                    format!(
                        "staging nested archive {} for bounded depth {}",
                        progress_basename(Path::new(rel)),
                        next_depth
                    ),
                    true,
                )
                .with_files(files_done)
                .with_lines(stats.lines)
                .with_bytes(stats.source_bytes),
            );
            let staged = match stage_nested_archive(&mut reader, private_staging_root, cancel) {
                Ok(staged) => staged,
                Err(error) => {
                    if !cancelled(cancel) {
                        emit_ingest_evidence(
                            progress,
                            LogIngestEvidenceReason::ReadFailed,
                            Path::new(&source_identity),
                        );
                    }
                    return Err(error);
                }
            };
            let bounded = reader.into_inner();
            if bounded.member_bytes != plan.expanded_size {
                return Err(CoreError::Policy(format!(
                    "raw log zip member size mismatch (declared {}, read {})",
                    plan.expanded_size, bounded.member_bytes
                )));
            }
            let nested_file = open_selected_regular_file(&staged.path)?;
            ingest_from_zip_file(
                nested_file,
                &nested_archive_identity,
                next_depth,
                true,
                private_staging_root,
                corpus,
                miner,
                stats,
                confidence,
                seq,
                batch,
                progress,
                cancel,
                kind,
                budget,
                limits,
                ops,
            )?;
            files_done += 1;
            continue;
        }
        if head.contains(&0) {
            stats.excluded("binary", Path::new(&source_identity));
            emit_ingest_evidence(
                progress,
                LogIngestEvidenceReason::Binary,
                Path::new(&source_identity),
            );
            files_done += 1;
            continue;
        }
        reader.get_mut().commit_to_aggregate()?;

        let lines_before = stats.lines;
        let completely_read = ingest_lines_from_reader(
            &mut reader,
            &source_identity,
            Some(Path::new(rel)),
            corpus,
            miner,
            stats,
            confidence,
            seq,
            batch,
            files_done,
            entry_count,
            progress,
            cancel,
            kind,
            limits,
            ops,
        )?;
        let bounded = reader.into_inner();
        if bounded.member_bytes != plan.expanded_size {
            return Err(CoreError::Policy(format!(
                "raw log zip member size mismatch (declared {}, read {})",
                plan.expanded_size, bounded.member_bytes
            )));
        }

        files_done += 1;
        if completely_read {
            if stats.lines == lines_before {
                stats.excluded("empty", Path::new(&source_identity));
                emit_ingest_evidence(
                    progress,
                    LogIngestEvidenceReason::Empty,
                    Path::new(&source_identity),
                );
            } else {
                stats.imported();
            }
        } else {
            stats.failed("read_failed", Path::new(&source_identity));
            emit_ingest_evidence(
                progress,
                LogIngestEvidenceReason::ReadFailed,
                Path::new(&source_identity),
            );
        }
        if files_done == 1 || files_done == entry_count || files_done.is_multiple_of(5) {
            emit(
                progress,
                with_stream_file_fraction(
                    ProcessProgress::phase(
                        kind,
                        ProcessProgressPhase::Stream,
                        "Parsing archive entries",
                        true,
                    )
                    .with_lines(stats.lines)
                    .with_files(files_done)
                    .with_bytes(stats.source_bytes)
                    .with_templates(miner.templates().len() as u64),
                    files_done,
                    entry_count,
                ),
            );
        }
    }

    Ok(files_done)
}

#[allow(clippy::too_many_arguments)]
fn ingest_path_inner(
    cache_root: &Path,
    path: &Path,
    name: &str,
    embed: Option<&dyn EmbedBackend>,
    embed_model: &str,
    embed_mode: LogEmbedMode,
    defer_above_source_bytes: Option<u64>,
    progress: &dyn ProcessProgressObserver,
    cancel: Option<&CancelFlag>,
    managed_identity: Option<&str>,
) -> CoreResult<IngestReport> {
    ingest_path_inner_with_fault(
        cache_root,
        path,
        name,
        embed,
        embed_model,
        embed_mode,
        defer_above_source_bytes,
        progress,
        cancel,
        managed_identity,
        None,
    )
}

#[allow(clippy::too_many_arguments)]
fn ingest_path_inner_with_fault(
    cache_root: &Path,
    path: &Path,
    name: &str,
    embed: Option<&dyn EmbedBackend>,
    embed_model: &str,
    embed_mode: LogEmbedMode,
    defer_above_source_bytes: Option<u64>,
    progress: &dyn ProcessProgressObserver,
    cancel: Option<&CancelFlag>,
    managed_identity: Option<&str>,
    fault: IngestFaultHook<'_>,
) -> CoreResult<IngestReport> {
    ingest_path_inner_with_limits_and_fault(
        cache_root,
        path,
        name,
        embed,
        embed_model,
        embed_mode,
        defer_above_source_bytes,
        progress,
        cancel,
        managed_identity,
        RawIngestLimits::default(),
        fault,
    )
}

#[allow(clippy::too_many_arguments)]
fn ingest_path_inner_with_limits_and_fault(
    cache_root: &Path,
    path: &Path,
    name: &str,
    embed: Option<&dyn EmbedBackend>,
    embed_model: &str,
    embed_mode: LogEmbedMode,
    defer_above_source_bytes: Option<u64>,
    progress: &dyn ProcessProgressObserver,
    cancel: Option<&CancelFlag>,
    managed_identity: Option<&str>,
    limits: RawIngestLimits,
    fault: IngestFaultHook<'_>,
) -> CoreResult<IngestReport> {
    let kind = ProcessProgressKind::LogIngest;
    let source_label = progress_basename(path);
    let timed = TimedIngestObserver::new(progress);
    let progress = &timed;
    let ops = std::sync::Mutex::new(IngestPhaseTimingsUs::default());

    emit(
        progress,
        ProcessProgress::phase(
            kind,
            ProcessProgressPhase::Starting,
            format!("starting ingest of {source_label}"),
            true,
        ),
    );

    if cancelled(cancel) {
        emit(
            progress,
            ProcessProgress::phase(
                kind,
                ProcessProgressPhase::Cancelled,
                "ingest cancelled before scan",
                false,
            ),
        );
        return Err(CoreError::Cancelled);
    }

    emit(
        progress,
        ProcessProgress::phase(
            kind,
            ProcessProgressPhase::Scan,
            format!("scanning {source_label}"),
            true,
        ),
    );

    let mut staging = IngestStaging::new(cache_root)?;
    let ingest_result = (|| {
        let report = match ingest_path_into_cache(
            staging.cache_root(),
            path,
            name,
            embed,
            embed_model,
            embed_mode,
            defer_above_source_bytes,
            progress,
            cancel,
            limits,
            fault,
            &ops,
        ) {
            Ok(report) => report,
            Err(_error) if cancelled(cancel) => {
                // Emit the canonical terminal phase here even when a lower
                // streaming phase noticed cancellation first. This keeps every
                // cancellation path terminal and typed; duplicate lower-phase
                // notices are harmless and the final update is deterministic.
                emit(
                    progress,
                    ProcessProgress::phase(
                        kind,
                        ProcessProgressPhase::Cancelled,
                        "ingest cancelled",
                        false,
                    ),
                );
                return Err(CoreError::Cancelled);
            }
            Err(error) => return Err(error),
        };

        if let Some(identity) = managed_identity {
            let staged = LogCorpus::open(staging.cache_root(), &report.corpus_id)?;
            staged.write_managed_identity(identity)?;
        }
        check_ingest_fault(fault, IngestCheckpoint::BeforeValidation)?;
        emit(
            progress,
            ProcessProgress::phase(
                kind,
                ProcessProgressPhase::Validate,
                "validating staged corpus before publication",
                true,
            )
            .with_lines(report.stats.lines)
            .with_templates(report.stats.templates as u64),
        );
        time_op_result_ms(&ops, IngestOp::Validate, || {
            validate_staged_ingest(staging.cache_root(), &report)
        })?;
        check_ingest_fault(fault, IngestCheckpoint::BeforePublish)?;
        if cancelled(cancel) {
            emit(
                progress,
                ProcessProgress::phase(
                    kind,
                    ProcessProgressPhase::Cancelled,
                    "ingest cancelled before publication",
                    false,
                ),
            );
            return Err(CoreError::Cancelled);
        }
        emit(
            progress,
            ProcessProgress::phase(
                kind,
                ProcessProgressPhase::Publish,
                "publishing corpus into the library (atomic)",
                false,
            )
            .with_lines(report.stats.lines)
            .with_templates(report.stats.templates as u64),
        );
        time_op_result_ms(&ops, IngestOp::Publish, || {
            staging.publish(cache_root, &report.corpus_id)
        })?;
        Ok(report)
    })();
    let cleanup_result = staging.cleanup_checked();
    let (mut report, cleanup_deferred) = reconcile_ingest_cleanup(ingest_result, cleanup_result)?;
    let embedding_deferred = report.embedding.state == EmbeddingState::Deferred;
    let op_us = ops.into_inner().unwrap_or_default();
    let mut op_timings = op_us.to_ms();
    let chrome = timed.finish_timings(embedding_deferred);
    op_timings.total_ms = chrome.total_ms;
    op_timings.embedding_deferred = embedding_deferred;
    report.phase_timings = op_timings;
    let defer_note = if embedding_deferred {
        "; optional embedding deferred (keyword/structured first use ready)"
    } else {
        ""
    };
    let completion_message = format!(
        "ingested {} events → {} learned templates ({:.1} avg. events/template) in {} ms{}{}",
        report.stats.lines,
        report.stats.templates,
        report.stats.reduction_ratio,
        report.phase_timings.total_ms,
        defer_note,
        if cleanup_deferred {
            "; private staging cleanup deferred"
        } else {
            ""
        }
    );

    emit(
        progress,
        ProcessProgress::phase(
            kind,
            ProcessProgressPhase::Completed,
            completion_message,
            false,
        )
        .with_lines(report.stats.lines)
        .with_files(report.stats.files as u64)
        .with_bytes(report.stats.source_bytes)
        .with_templates(report.stats.templates as u64),
    );

    Ok(report)
}

#[allow(clippy::too_many_arguments)]
fn ingest_path_into_cache(
    cache_root: &Path,
    path: &Path,
    name: &str,
    embed: Option<&dyn EmbedBackend>,
    embed_model: &str,
    embed_mode: LogEmbedMode,
    defer_above_source_bytes: Option<u64>,
    progress: &dyn ProcessProgressObserver,
    cancel: Option<&CancelFlag>,
    limits: RawIngestLimits,
    fault: IngestFaultHook<'_>,
    ops: &std::sync::Mutex<IngestPhaseTimingsUs>,
) -> CoreResult<IngestReport> {
    let kind = ProcessProgressKind::LogIngest;
    let source_label = progress_basename(path);

    let corpus = LogCorpus::create(cache_root, name)?;
    check_ingest_fault(fault, IngestCheckpoint::CorpusCreated)?;
    let mut miner = DrainMiner::default();
    let mut stats = IngestStats::default();
    let mut confidence = IngestConfidenceAggregator::default();
    let mut seq = 0u64;
    let mut batch = Vec::with_capacity(256);
    let mut budget = RawIngestBudget::default();
    let private_archive_root = cache_root.join(".nested_archives");
    let _files_done = if is_zip_file(path) {
        // Stream members without full extraction. Only nested archive
        // containers are copied into the hidden, bounded per-ingest tree.
        ingest_from_zip(
            path,
            &private_archive_root,
            &corpus,
            &mut miner,
            &mut stats,
            &mut confidence,
            &mut seq,
            &mut batch,
            progress,
            cancel,
            kind,
            &mut budget,
            limits,
            ops,
        )?
    } else {
        let inventory = collect_log_files(path, &mut budget, limits, cancel)?;
        for ignored in &inventory.ignored {
            stats.discover();
            stats.ignored("hidden", ignored);
            emit_ingest_evidence(progress, LogIngestEvidenceReason::Hidden, ignored);
        }
        for (excluded, reason) in &inventory.excluded {
            stats.discover();
            stats.excluded(reason, excluded);
        }
        for _ in &inventory.files {
            stats.discover();
        }
        if stats.discovered_files == 0 {
            return Err(CoreError::Message(
                "no importable log file entries discovered".into(),
            ));
        }
        let file_count = stats.discovered_files;
        let mut files_done = (inventory.ignored.len() + inventory.excluded.len()) as u64;

        emit(
            progress,
            ProcessProgress::phase(
                kind,
                ProcessProgressPhase::Scan,
                format!("found {file_count} file entr(y/ies)"),
                true,
            )
            .with_files(file_count),
        );

        emit(
            progress,
            with_stream_file_fraction(
                ProcessProgress::phase(
                    kind,
                    ProcessProgressPhase::Stream,
                    "parsing and templating lines",
                    true,
                )
                .with_files(files_done),
                files_done,
                file_count,
            ),
        );

        for file in &inventory.files {
            if cancelled(cancel) {
                emit(
                    progress,
                    ProcessProgress::phase(
                        kind,
                        ProcessProgressPhase::Cancelled,
                        "ingest cancelled during parse",
                        false,
                    )
                    .with_lines(stats.lines)
                    .with_files(files_done),
                );
                return Err(CoreError::Cancelled);
            }

            let file_bytes = match std::fs::symlink_metadata(file) {
                Ok(metadata) => metadata.len(),
                Err(_) => {
                    stats.failed("metadata_failed", file);
                    emit_ingest_evidence(progress, LogIngestEvidenceReason::ReadFailed, file);
                    files_done += 1;
                    continue;
                }
            };
            emit(
                progress,
                with_stream_file_fraction(
                    ProcessProgress::phase(
                        kind,
                        ProcessProgressPhase::Stream,
                        format!("opening {}", progress_basename(file)),
                        true,
                    )
                    .with_lines(stats.lines)
                    .with_files(files_done)
                    .with_bytes(stats.source_bytes),
                    files_done,
                    file_count,
                ),
            );
            let mut fh = match open_inventory_file(&inventory, file) {
                Ok(file) => file,
                Err(CoreError::Policy(reason)) => return Err(CoreError::Policy(reason)),
                Err(_) => {
                    stats.failed("open_failed", file);
                    emit_ingest_evidence(progress, LogIngestEvidenceReason::ReadFailed, file);
                    files_done += 1;
                    continue;
                }
            };
            let rel_path = if path.is_dir() {
                file.strip_prefix(path).unwrap_or(file.as_path())
            } else {
                Path::new(
                    file.file_name()
                        .and_then(|name| name.to_str())
                        .unwrap_or("log"),
                )
            };
            let rel = portable_source_identity(rel_path)?;
            let mut signature = [0u8; 4];
            let signature_len = match fh.read(&mut signature) {
                Ok(read) => read,
                Err(_) => {
                    stats.failed("read_failed", file);
                    emit_ingest_evidence(progress, LogIngestEvidenceReason::ReadFailed, file);
                    files_done += 1;
                    continue;
                }
            };
            fh.seek(SeekFrom::Start(0))
                .map_err(|e| CoreError::Message(format!("rewind log source: {e}")))?;
            if has_zip_extension(file) || has_zip_signature(&signature[..signature_len]) {
                ingest_from_zip_file(
                    fh,
                    &rel,
                    1,
                    true,
                    &private_archive_root,
                    &corpus,
                    &mut miner,
                    &mut stats,
                    &mut confidence,
                    &mut seq,
                    &mut batch,
                    progress,
                    cancel,
                    kind,
                    &mut budget,
                    limits,
                    ops,
                )?;
                files_done += 1;
                continue;
            }
            if file_bytes > limits.max_file_bytes {
                stats.excluded("too_large", file);
                emit_ingest_evidence(progress, LogIngestEvidenceReason::Oversized, file);
                files_done += 1;
                emit(
                    progress,
                    with_stream_file_fraction(
                        ProcessProgress::phase(
                            kind,
                            ProcessProgressPhase::Stream,
                            format!(
                                "skipped oversized {} ({} bytes > {} cap)",
                                progress_basename(file),
                                file_bytes,
                                limits.max_file_bytes
                            ),
                            true,
                        ),
                        files_done,
                        file_count,
                    )
                    .with_lines(stats.lines)
                    .with_files(files_done),
                );
                continue;
            }
            let bounded = BoundedSourceReader::new(fh, &mut budget, limits, cancel);
            let mut reader = BufReader::with_capacity(64 * 1024, bounded);
            let head = match reader.fill_buf() {
                Ok(bytes) => &bytes[..bytes.len().min(8192)],
                Err(error) if error.kind() == std::io::ErrorKind::InvalidData => {
                    return Err(CoreError::Policy(error.to_string()))
                }
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {
                    return Err(CoreError::Message(error.to_string()))
                }
                Err(_) => {
                    stats.failed("read_failed", file);
                    emit_ingest_evidence(progress, LogIngestEvidenceReason::ReadFailed, file);
                    files_done += 1;
                    continue;
                }
            };
            if head.contains(&0) {
                stats.excluded("binary", file);
                emit_ingest_evidence(progress, LogIngestEvidenceReason::Binary, file);
                files_done += 1;
                continue;
            }
            reader.get_mut().commit_to_aggregate()?;

            let lines_before = stats.lines;
            let completely_read = ingest_lines_from_reader(
                &mut reader,
                &rel,
                Some(file.as_path()),
                &corpus,
                &mut miner,
                &mut stats,
                &mut confidence,
                &mut seq,
                &mut batch,
                files_done,
                file_count,
                progress,
                cancel,
                kind,
                limits,
                ops,
            )?;
            files_done += 1;
            if completely_read {
                if stats.lines == lines_before {
                    stats.excluded("empty", file);
                    emit_ingest_evidence(progress, LogIngestEvidenceReason::Empty, file);
                } else {
                    stats.imported();
                }
            } else {
                stats.failed("read_failed", file);
                emit_ingest_evidence(progress, LogIngestEvidenceReason::ReadFailed, file);
            }
            if files_done == 1 || files_done == file_count || files_done.is_multiple_of(5) {
                emit(
                    progress,
                    with_stream_file_fraction(
                        ProcessProgress::phase(
                            kind,
                            ProcessProgressPhase::Stream,
                            "Streaming read, parse, template, and persist",
                            true,
                        )
                        .with_lines(stats.lines)
                        .with_files(files_done)
                        .with_bytes(stats.source_bytes)
                        .with_templates(miner.templates().len() as u64),
                        files_done,
                        file_count,
                    ),
                );
            }
        }
        files_done
    };

    // Monotonic chrome: streaming phase already covered read/parse/template/persist.
    // Do not emit Template/Redact/Store bookends that rewind UI progress (#824).
    if stats.lines == 0 {
        return Err(CoreError::Message(
            "no safe/importable log events were found".into(),
        ));
    }

    if !batch.is_empty() {
        emit(
            progress,
            ProcessProgress::phase(
                kind,
                ProcessProgressPhase::Stream,
                "streaming persist of remaining events",
                // After first store, cancel is less clean; still allow between template persist.
                true,
            )
            .with_lines(stats.lines),
        );
        time_op_result_ms(ops, IngestOp::Persist, || {
            corpus.push_ingested_events(&batch)
        })?;
    }
    check_ingest_fault(fault, IngestCheckpoint::EventsStored)?;

    if cancelled(cancel) {
        emit(
            progress,
            ProcessProgress::phase(
                kind,
                ProcessProgressPhase::Cancelled,
                "ingest cancelled before template persist",
                false,
            )
            .with_lines(stats.lines),
        );
        return Err(CoreError::Cancelled);
    }

    // Persist templates
    check_ingest_fault(fault, IngestCheckpoint::BeforeTemplates)?;
    emit(
        progress,
        ProcessProgress::phase(
            kind,
            ProcessProgressPhase::Stream,
            "persisting template table",
            false, // flush in progress — not cleanly cancellable mid-upsert
        )
        .with_lines(stats.lines),
    );

    let mut rows = Vec::new();
    for t in miner.templates() {
        rows.push(TemplateRow {
            content_hash: template_content_hash(&t.pattern),
            info: t,
            vector: None,
        });
    }
    time_op_result_ms(ops, IngestOp::Persist, || corpus.upsert_templates(rows))?;

    // Embed templates only (#359). Cap bulk SoftWrite so import is not forced
    // through a full multi-k embed pass (semantic can be filled later).
    let deferred = embed_mode == LogEmbedMode::Local
        && defer_above_source_bytes.is_some_and(|limit| stats.source_bytes > limit);
    let mut embedded = 0usize;
    if let Some(backend) = embed.filter(|_| !deferred) {
        check_ingest_fault(fault, IngestCheckpoint::DuringEmbedding)?;
        let mut templates = corpus.list_templates();
        templates.sort_by_key(|r| std::cmp::Reverse(r.info.count));
        let cap = BULK_EMBED_TEMPLATE_CAP.min(templates.len());
        let to_embed: Vec<_> = templates.into_iter().take(cap).collect();
        emit(
            progress,
            ProcessProgress::phase(
                kind,
                ProcessProgressPhase::Embed,
                format!("embedding up to {cap} top templates (bulk SoftWrite cap)"),
                false,
            )
            .with_templates(corpus.template_count() as u64),
        );
        let mut hash_cache: std::collections::HashMap<String, Vec<f32>> =
            std::collections::HashMap::new();
        for (i, row) in to_embed.into_iter().enumerate() {
            if cancelled(cancel) {
                emit(
                    progress,
                    ProcessProgress::phase(
                        kind,
                        ProcessProgressPhase::Cancelled,
                        "ingest cancelled during template embedding",
                        false,
                    )
                    .with_lines(stats.lines)
                    .with_templates(embedded as u64),
                );
                return Err(CoreError::Cancelled);
            }
            time_op_result_ms(ops, IngestOp::Embed, || -> CoreResult<()> {
                if let Some(v) = hash_cache.get(&row.content_hash) {
                    corpus.set_template_vector(row.info.template_id, v.clone())?;
                    embedded += 1;
                    return Ok(());
                }
                if let Some(v) = embed_blocking(backend, &row.info.pattern, 5_000) {
                    hash_cache.insert(row.content_hash.clone(), v.clone());
                    corpus.set_template_vector(row.info.template_id, v)?;
                    embedded += 1;
                }
                Ok(())
            })?;
            if i % 8 == 0 {
                emit(
                    progress,
                    ProcessProgress::phase(
                        kind,
                        ProcessProgressPhase::Embed,
                        "embedding templates",
                        false,
                    )
                    .with_templates(embedded as u64),
                );
            }
        }
    }

    stats.templates = corpus.template_count();
    stats.reduction_ratio = if stats.templates > 0 {
        stats.lines as f64 / stats.templates as f64
    } else {
        0.0
    };
    stats.embedded = embedded;
    let embedding = CorpusEmbeddingStatus {
        state: if deferred {
            EmbeddingState::Deferred
        } else if stats.templates > 0 && embedded == stats.templates {
            EmbeddingState::Complete
        } else if embedded > 0 {
            EmbeddingState::Partial
        } else {
            EmbeddingState::KeywordOnly
        },
        model_id: (embedded > 0 || deferred).then(|| embed_model.to_string()),
        embedded_templates: embedded as u64,
        total_templates: stats.templates as u64,
        reason: Some(
            if deferred {
                "bulk_source_bytes_threshold"
            } else if embed.is_none() && embed_mode == LogEmbedMode::Local {
                "local_model_unavailable"
            } else if embed_mode == LogEmbedMode::None {
                "embedding_not_requested"
            } else if embedded < stats.templates {
                "template_cap_or_backend_failure"
            } else {
                "local_embedding_complete"
            }
            .into(),
        ),
        updated_at: crate::embed::now_unix_secs(),
    };

    let mut top: Vec<_> = corpus
        .list_templates()
        .into_iter()
        .map(|r| {
            (
                r.info.template_id,
                r.info.pattern,
                r.info.count,
                r.info.severity,
            )
        })
        .collect();
    top.sort_by_key(|b| std::cmp::Reverse(b.2));
    top.truncate(10);

    corpus.flush()?;
    stats.corpus_bytes = corpus.corpus_bytes_on_disk();
    check_ingest_fault(fault, IngestCheckpoint::BeforeSummary)?;

    let top_snap: Vec<TopTemplateSnapshot> = top
        .iter()
        .map(|(id, pattern, count, severity)| TopTemplateSnapshot {
            id: *id,
            pattern: pattern.clone(),
            count: *count,
            severity: *severity,
        })
        .collect();
    corpus.write_ingest_summary(
        Some(source_label.clone()),
        stats.to_corpus_stats(),
        top_snap,
        embedding.clone(),
    )?;
    let confidence = confidence.finish();

    Ok(IngestReport {
        corpus_id: corpus.id().to_string(),
        stats,
        confidence,
        top_templates: top,
        embedding,
        phase_timings: IngestPhaseTimings::default(),
    })
}

fn validate_staged_ingest(staging_cache_root: &Path, report: &IngestReport) -> CoreResult<()> {
    // Open only after the writer handle from `ingest_path_into_cache` has been
    // dropped. This catches malformed metadata/templates/DuckDB while the
    // corpus is still hidden and keeps rename compatible with Windows.
    let opened = LogCorpus::open(staging_cache_root, &report.corpus_id)?;
    let meta = opened.meta()?;
    if meta.id != report.corpus_id {
        return Err(CoreError::Message(
            "staged corpus metadata id mismatch".into(),
        ));
    }
    let Some(persisted) = meta.stats else {
        return Err(CoreError::Message(
            "staged corpus missing completed ingest stats".into(),
        ));
    };
    if persisted.lines != report.stats.lines
        || persisted.templates != report.stats.templates as u64
        || opened.event_count() as u64 != report.stats.lines
        || opened.template_count() != report.stats.templates
    {
        return Err(CoreError::Message(
            "staged corpus validation counts do not match ingest report".into(),
        ));
    }
    Ok(())
}

#[derive(Default)]
struct FileInventory {
    files: Vec<PathBuf>,
    ignored: Vec<PathBuf>,
    excluded: Vec<(PathBuf, &'static str)>,
    canonical_root: PathBuf,
}

fn collect_log_files(
    path: &Path,
    budget: &mut RawIngestBudget,
    limits: RawIngestLimits,
    cancel: Option<&CancelFlag>,
) -> CoreResult<FileInventory> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|_| CoreError::Message("log source does not exist".into()))?;
    if metadata.file_type().is_symlink() {
        return Err(CoreError::Policy(
            "symlink log source rejected by policy".into(),
        ));
    }
    let canonical_root = std::fs::canonicalize(path)
        .map_err(|e| CoreError::Message(format!("resolve log source: {e}")))?;
    let mut out = FileInventory {
        canonical_root: canonical_root.clone(),
        ..FileInventory::default()
    };
    if metadata.is_file() {
        budget.add_entries(1, limits)?;
        out.files.push(path.to_path_buf());
        return Ok(out);
    }
    if metadata.is_dir() {
        let mut visited = std::collections::HashSet::new();
        visited.insert(canonical_root);
        let root_for_walk = out.canonical_root.clone();
        walk_dir(
            path,
            &root_for_walk,
            &mut out,
            &mut visited,
            budget,
            limits,
            cancel,
        )?;
    } else {
        return Err(CoreError::Policy(
            "non-regular log source rejected by policy".into(),
        ));
    }
    out.files.sort();
    out.ignored.sort();
    out.excluded.sort_by(|left, right| left.0.cmp(&right.0));
    Ok(out)
}

fn walk_dir(
    dir: &Path,
    canonical_root: &Path,
    out: &mut FileInventory,
    visited: &mut std::collections::HashSet<PathBuf>,
    budget: &mut RawIngestBudget,
    limits: RawIngestLimits,
    cancel: Option<&CancelFlag>,
) -> CoreResult<()> {
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        if cancelled(cancel) {
            return Err(CoreError::Cancelled);
        }
        budget.add_entries(1, limits)?;
        entries.push(entry?);
    }
    entries.sort_by_key(std::fs::DirEntry::file_name);
    for entry in entries {
        if cancelled(cancel) {
            return Err(CoreError::Cancelled);
        }
        let path = entry.path();
        let name = entry.file_name();
        if name.to_string_lossy().starts_with('.') {
            out.ignored.push(path);
            continue;
        }
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            out.excluded.push((path, "symlink"));
            continue;
        }
        if file_type.is_dir() {
            let canonical = std::fs::canonicalize(&path)
                .map_err(|e| CoreError::Message(format!("resolve log directory: {e}")))?;
            if !canonical.starts_with(canonical_root) {
                return Err(CoreError::Policy(
                    "log directory escaped selected root".into(),
                ));
            }
            if !visited.insert(canonical) {
                return Err(CoreError::Policy(
                    "log directory cycle rejected by policy".into(),
                ));
            }
            walk_dir(&path, canonical_root, out, visited, budget, limits, cancel)?;
        } else if file_type.is_file() {
            let metadata = std::fs::symlink_metadata(&path)?;
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                out.excluded.push((path, "non_regular"));
                continue;
            }
            out.files.push(path);
        } else {
            out.excluded.push((path, "non_regular"));
        }
    }
    Ok(())
}

fn open_inventory_file(inventory: &FileInventory, path: &Path) -> CoreResult<std::fs::File> {
    let before = std::fs::symlink_metadata(path)
        .map_err(|e| CoreError::Message(format!("read log metadata: {e}")))?;
    if before.file_type().is_symlink() || !before.is_file() {
        return Err(CoreError::Policy(
            "log source changed to a symlink or non-regular file".into(),
        ));
    }
    let canonical =
        std::fs::canonicalize(path).map_err(|e| CoreError::Message(format!("resolve log: {e}")))?;
    if !canonical.starts_with(&inventory.canonical_root) {
        return Err(CoreError::Policy("log source escaped selected root".into()));
    }
    #[cfg(windows)]
    let file = {
        use std::os::windows::fs::MetadataExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;

        if before.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(CoreError::Policy(
                "log source changed to a reparse point".into(),
            ));
        }
        windows_secure_open_regular_file(
            path,
            &canonical,
            Some(&inventory.canonical_root),
            "open log",
            "log source changed during secure open",
        )?
    };
    #[cfg(not(windows))]
    let file =
        std::fs::File::open(path).map_err(|e| CoreError::Message(format!("open log: {e}")))?;
    #[cfg(not(windows))]
    let opened = file
        .metadata()
        .map_err(|e| CoreError::Message(format!("read opened log metadata: {e}")))?;
    #[cfg(not(windows))]
    if !opened.is_file() {
        return Err(CoreError::Policy(
            "opened log source is not a regular file".into(),
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if before.dev() != opened.dev() || before.ino() != opened.ino() {
            return Err(CoreError::Policy(
                "log source changed during secure open".into(),
            ));
        }
    }
    Ok(file)
}

/// Largest nested archive the preview will buffer in memory to inventory.
///
/// Preview never stages to disk (that is a write), so a nested archive must be
/// held in memory to be read. Beyond this bound the archive is reported with
/// [`super::import_preview::ImportPreviewReason::NestedArchiveNotInventoried`]
/// and the report is marked truncated, rather than silently under-reporting
/// what the real import would descend into.
const MAX_PREVIEW_NESTED_ARCHIVE_BYTES: u64 = 64 * 1024 * 1024;

/// Read-only preview traversal backing [`super::import_preview::preview_import_path`].
///
/// Lives here, not in `import_preview`, so it can reuse this module's private
/// traversal (`collect_log_files`), archive preflight (`preflight_raw_log_zip`),
/// identity rules (`portable_source_identity`, `archive_member_identity`), and
/// budget/limit types **without widening any of them into the public API**. A
/// parallel walker in another module would be free to disagree with the real
/// import path about what is safe, which is precisely the class of bug these
/// limits exist to prevent.
///
/// Writes nothing: no staging directory, no corpus, no cache entry. Nested
/// archives are inventoried from their central directory only.
pub(super) fn preview_import_path_impl(
    path: &Path,
    cancel: Option<&CancelFlag>,
) -> CoreResult<ImportPreviewReport> {
    use super::import_preview::{
        excluded_item, finish_report, item_from_sample, map_exclusion, sample_bounded,
        ImportItemStatus, ImportPreviewReason, ImportSourceKind, MAX_IMPORT_PREVIEW_ITEMS,
    };

    let limits = RawIngestLimits::default();
    let mut budget = RawIngestBudget::default();
    let mut items: Vec<ImportPreviewItem> = Vec::new();
    let mut truncated = false;

    let metadata = std::fs::symlink_metadata(path)
        .map_err(|_| CoreError::Message("log source does not exist".into()))?;
    if metadata.file_type().is_symlink() {
        // Matches `collect_log_files`: a directly selected symlink is fatal,
        // not an excluded row.
        return Err(CoreError::Policy(
            "symlink log source rejected by policy".into(),
        ));
    }

    // A directly selected ZIP previews as an archive with bare member
    // identities, exactly as `ingest_from_zip_file(prefix_members = false)`
    // would publish them.
    if metadata.is_file() {
        // Archive detection must match `ingest_path_inner` exactly, or the
        // preview promises an import that will not happen. For a *directly
        // selected* path ingest uses `is_zip_file`, which is extension-only
        // and deliberately ignores content — so preview does too. Using the
        // ZIP signature here instead (as an earlier version did) reported a
        // `.bundle` ZIP as an archive full of importable members while the
        // real import treated it as one binary file and published nothing.
        let mut file = open_selected_regular_file(path)?;
        let is_archive = is_zip_file(path);

        if is_archive {
            preview_zip_members(
                &mut file,
                "",
                1,
                &mut budget,
                limits,
                cancel,
                &mut items,
                &mut truncated,
            )?;
            return Ok(finish_report(
                ImportSourceKind::Archive,
                items,
                truncated,
                None,
            ));
        }

        budget.add_entries(1, limits)?;
        let identity = path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| "item".to_string());
        let bytes = metadata.len();
        if bytes > limits.max_file_bytes {
            items.push(excluded_item(
                &identity,
                bytes,
                ImportItemStatus::Blocked,
                ImportPreviewReason::Oversized,
            ));
        } else {
            let sample = sample_bounded(&mut file, bytes);
            items.push(item_from_sample(&identity, bytes, &sample, None, false));
        }
        return Ok(finish_report(
            ImportSourceKind::File,
            items,
            truncated,
            None,
        ));
    }

    let inventory = collect_log_files(path, &mut budget, limits, cancel)?;

    // Excluded AND ignored entries become rows — "nothing disappears silently"
    // is only true if every refusal is visible. `collect_log_files` returns
    // these in two separate vectors; an earlier version consumed only
    // `excluded`, so hidden files and whole hidden subtrees vanished from the
    // report with no item, no reason, and no count.
    for ignored_path in &inventory.ignored {
        if items.len() >= MAX_IMPORT_PREVIEW_ITEMS {
            truncated = true;
            break;
        }
        let identity = preview_relative_identity(ignored_path, &inventory.canonical_root);
        let bytes = std::fs::symlink_metadata(ignored_path)
            .map(|meta| meta.len())
            .unwrap_or(0);
        items.push(excluded_item(
            &identity,
            bytes,
            ImportItemStatus::Ignored,
            ImportPreviewReason::Hidden,
        ));
    }

    for (excluded_path, reason) in &inventory.excluded {
        if items.len() >= MAX_IMPORT_PREVIEW_ITEMS {
            truncated = true;
            break;
        }
        let identity = preview_relative_identity(excluded_path, &inventory.canonical_root);
        let (status, code) = map_exclusion(reason);
        let bytes = std::fs::symlink_metadata(excluded_path)
            .map(|meta| meta.len())
            .unwrap_or(0);
        items.push(excluded_item(&identity, bytes, status, code));
    }

    for file_path in &inventory.files {
        if cancelled(cancel) {
            return Err(CoreError::Cancelled);
        }
        if items.len() >= MAX_IMPORT_PREVIEW_ITEMS {
            truncated = true;
            break;
        }
        let identity = preview_relative_identity(file_path, &inventory.canonical_root);
        let Ok(meta) = std::fs::symlink_metadata(file_path) else {
            items.push(excluded_item(
                &identity,
                0,
                ImportItemStatus::Unsupported,
                ImportPreviewReason::ReadFailed,
            ));
            continue;
        };
        if meta.file_type().is_symlink() || !meta.is_file() {
            // TOCTOU guard: the walk saw a regular file, so anything else now
            // is a change under us and is refused rather than followed.
            items.push(excluded_item(
                &identity,
                meta.len(),
                ImportItemStatus::Blocked,
                ImportPreviewReason::SymlinkRejected,
            ));
            continue;
        }
        let bytes = meta.len();
        if bytes > limits.max_file_bytes {
            items.push(excluded_item(
                &identity,
                bytes,
                ImportItemStatus::Blocked,
                ImportPreviewReason::Oversized,
            ));
            continue;
        }
        // `open_inventory_file` is the same hardened open the real import
        // uses: it re-canonicalizes and asserts containment under the selected
        // root, compares dev/ino of the pre-open metadata against the *opened
        // handle*, and on Windows refuses reparse points. Plain `File::open`
        // (an earlier version) left a check-then-use window in which a
        // concurrent rename could swap the file for a symlink to anything on
        // disk, whose content would then be sampled and reported under the
        // in-root identity.
        let Ok(mut file) = open_inventory_file(&inventory, file_path) else {
            items.push(excluded_item(
                &identity,
                bytes,
                ImportItemStatus::Blocked,
                ImportPreviewReason::SymlinkRejected,
            ));
            continue;
        };

        let mut head = [0u8; 4];
        let read = file.read(&mut head).unwrap_or(0);
        // Directory members: extension OR signature, matching ingest.
        let is_archive = has_zip_extension(file_path) || has_zip_signature(&head[..read]);
        if file.seek(SeekFrom::Start(0)).is_err() {
            items.push(excluded_item(
                &identity,
                bytes,
                ImportItemStatus::Unsupported,
                ImportPreviewReason::ReadFailed,
            ));
            continue;
        }

        if is_archive {
            preview_zip_members(
                &mut file,
                &identity,
                1,
                &mut budget,
                limits,
                cancel,
                &mut items,
                &mut truncated,
            )?;
            continue;
        }

        let sample = sample_bounded(&mut file, bytes);
        items.push(item_from_sample(&identity, bytes, &sample, None, false));
    }

    Ok(finish_report(
        ImportSourceKind::Directory,
        items,
        truncated,
        None,
    ))
}

/// Portable identity of a walked path relative to the selected root.
fn preview_relative_identity(path: &Path, canonical_root: &Path) -> String {
    let relative = std::fs::canonicalize(path)
        .ok()
        .and_then(|canonical| {
            canonical
                .strip_prefix(canonical_root)
                .ok()
                .map(Path::to_path_buf)
        })
        .or_else(|| {
            path.strip_prefix(canonical_root)
                .ok()
                .map(Path::to_path_buf)
        })
        .unwrap_or_else(|| {
            PathBuf::from(
                path.file_name()
                    .unwrap_or_else(|| std::ffi::OsStr::new("item")),
            )
        });
    portable_source_identity(&relative).unwrap_or_else(|_| {
        path.file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| "item".to_string())
    })
}

/// Inventory one archive's members from its central directory.
///
/// Two-pass like ingest: the plan is built from the central directory before
/// any payload read, so a hostile entry is refused before it can be decompressed.
/// Nested archives recurse under the same [`MAX_RAW_LOG_ARCHIVE_DEPTH`] bound.
#[allow(clippy::too_many_arguments)]
fn preview_zip_members<R: Read + Seek>(
    file: &mut R,
    archive_identity: &str,
    archive_depth: u8,
    budget: &mut RawIngestBudget,
    limits: RawIngestLimits,
    cancel: Option<&CancelFlag>,
    items: &mut Vec<ImportPreviewItem>,
    truncated: &mut bool,
) -> CoreResult<()> {
    use super::import_preview::{
        excluded_item, item_from_sample, sample_streaming, ImportItemStatus, ImportPreviewReason,
        SampleOutcome, MAX_IMPORT_PREVIEW_ITEMS,
    };

    let member_identity = |member: &str| -> String {
        if archive_identity.is_empty() {
            member.to_string()
        } else {
            archive_member_identity(archive_identity, member)
        }
    };

    if archive_depth > limits.max_archive_depth {
        items.push(excluded_item(
            archive_identity,
            0,
            ImportItemStatus::Blocked,
            ImportPreviewReason::ArchiveDepthExceeded,
        ));
        return Ok(());
    }

    // Refuses traversal, duplicate identities, encryption, and multi-disk
    // archives before any member is opened.
    let plans = preflight_raw_log_zip(file, budget, limits, cancel)?;

    file.seek(SeekFrom::Start(0))
        .map_err(|e| CoreError::Message(format!("rewind zip: {e}")))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| CoreError::Policy(format!("read zip archive: {e}")))?;

    for plan in plans {
        if cancelled(cancel) {
            return Err(CoreError::Cancelled);
        }
        if items.len() >= MAX_IMPORT_PREVIEW_ITEMS {
            *truncated = true;
            break;
        }
        let identity = member_identity(&plan.identity);

        match plan.disposition {
            ZipEntryDisposition::Directory => continue,
            ZipEntryDisposition::Symlink => {
                items.push(excluded_item(
                    &identity,
                    plan.expanded_size,
                    ImportItemStatus::Blocked,
                    ImportPreviewReason::SymlinkRejected,
                ));
                continue;
            }
            ZipEntryDisposition::NonRegular => {
                items.push(excluded_item(
                    &identity,
                    plan.expanded_size,
                    ImportItemStatus::Blocked,
                    ImportPreviewReason::NonRegularRejected,
                ));
                continue;
            }
            ZipEntryDisposition::TooLarge => {
                items.push(excluded_item(
                    &identity,
                    plan.expanded_size,
                    ImportItemStatus::Blocked,
                    ImportPreviewReason::Oversized,
                ));
                continue;
            }
            ZipEntryDisposition::Hidden => {
                // Same condition as a hidden file on disk, so same ledger
                // state. Filing it as `Supporting` mixed ignored noise in with
                // real attachments and left `counts.ignored` unreachable for
                // archives.
                items.push(excluded_item(
                    &identity,
                    plan.expanded_size,
                    ImportItemStatus::Ignored,
                    ImportPreviewReason::Hidden,
                ));
                continue;
            }
            ZipEntryDisposition::Import | ZipEntryDisposition::NestedArchive => {}
        }

        if compression_ratio_exceeded(
            plan.expanded_size,
            plan.compressed_size,
            limits.max_compression_ratio,
        ) {
            items.push(excluded_item(
                &identity,
                plan.expanded_size,
                ImportItemStatus::Blocked,
                ImportPreviewReason::CompressionRatioExceeded,
            ));
            continue;
        }

        let Ok(mut entry) = archive.by_name(&plan.identity) else {
            items.push(excluded_item(
                &identity,
                plan.expanded_size,
                ImportItemStatus::Unsupported,
                ImportPreviewReason::ReadFailed,
            ));
            continue;
        };

        // A nested archive is buffered and inventoried recursively.
        // `ZipArchive` needs `Read + Seek`, which `Cursor<Vec<u8>>` provides,
        // so preview never stages anything to disk the way ingest must.
        if plan.disposition == ZipEntryDisposition::NestedArchive {
            if archive_depth + 1 > limits.max_archive_depth {
                items.push(excluded_item(
                    &identity,
                    plan.expanded_size,
                    ImportItemStatus::Blocked,
                    ImportPreviewReason::ArchiveDepthExceeded,
                ));
                continue;
            }
            if plan.expanded_size > MAX_PREVIEW_NESTED_ARCHIVE_BYTES {
                // Disclosed, not silently skipped: the real import would
                // descend here, so the preview says it could not.
                items.push(excluded_item(
                    &identity,
                    plan.expanded_size,
                    ImportItemStatus::Supporting,
                    ImportPreviewReason::NestedArchiveNotInventoried,
                ));
                *truncated = true;
                continue;
            }
            let mut buf = Vec::new();
            if std::io::Read::take(&mut entry, plan.expanded_size)
                .read_to_end(&mut buf)
                .is_err()
            {
                items.push(excluded_item(
                    &identity,
                    plan.expanded_size,
                    ImportItemStatus::Unsupported,
                    ImportPreviewReason::ReadFailed,
                ));
                continue;
            }
            drop(entry);
            let mut nested = std::io::Cursor::new(buf);
            preview_zip_members(
                &mut nested,
                &identity,
                archive_depth + 1,
                budget,
                limits,
                cancel,
                items,
                truncated,
            )?;
            continue;
        }

        // True head/interior/tail sampling without `Seek`.
        //
        // A ZIP entry is a streaming reader, so an earlier version buffered
        // only the first 64 KiB and then "sampled" three windows out of that
        // head region — re-introducing exactly the first-window lock-in the
        // design forbids, but only inside archives. Streaming keeps the head,
        // a middle window, and a rolling tail, at bounded memory.
        // Cancellation propagates as `Err(Cancelled)`; a read/decompression
        // failure becomes an explicit ledger row rather than a classification
        // of whatever bytes happened to arrive.
        let sample = match sample_streaming(&mut entry, plan.expanded_size, cancel)? {
            SampleOutcome::Sampled(sample) => sample,
            SampleOutcome::ReadFailed => {
                items.push(excluded_item(
                    &identity,
                    plan.expanded_size,
                    ImportItemStatus::Unsupported,
                    ImportPreviewReason::ReadFailed,
                ));
                continue;
            }
        };
        items.push(item_from_sample(
            &identity,
            plan.expanded_size,
            &sample,
            None,
            false,
        ));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::embed::ConceptEmbedBackend;
    use crate::log_analysis::{
        FailedIngestDiagnostic, FailedIngestDiagnosticRecorder, FailedIngestSourceKind,
        IngestFormatOutcome, TimeQuality, UnresolvedTimeReason, MAX_TIMESTAMP_PREFIX_SAMPLES,
    };
    use crate::process_progress::{
        CancelFlag, LogIngestEvidence, ProcessProgressPhase, RecordingProcessProgress,
    };
    use std::io::Write;

    fn cache_tree_paths(root: &Path) -> Vec<PathBuf> {
        fn walk(root: &Path, dir: &Path, out: &mut Vec<PathBuf>) {
            let Ok(entries) = std::fs::read_dir(dir) else {
                return;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if let Ok(rel) = path.strip_prefix(root) {
                    out.push(rel.to_path_buf());
                }
                if path.is_dir() {
                    walk(root, &path, out);
                }
            }
        }

        let mut out = Vec::new();
        walk(root, root, &mut out);
        out.sort();
        out
    }

    fn assert_no_ingest_staging(cache_root: &Path) {
        assert!(
            !cache_root.join(".log_ingest_staging").exists(),
            "ingest staging survived: {:?}",
            cache_tree_paths(cache_root)
        );
    }

    fn ingest_with_limits(
        cache_root: &Path,
        path: &Path,
        name: &str,
        limits: RawIngestLimits,
        progress: &dyn ProcessProgressObserver,
        cancel: Option<&CancelFlag>,
    ) -> CoreResult<IngestReport> {
        ingest_path_inner_with_limits_and_fault(
            cache_root,
            path,
            name,
            None,
            "none",
            LogEmbedMode::None,
            None,
            progress,
            cancel,
            None,
            limits,
            None,
        )
    }

    fn zip_bytes(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default();
        for (name, body) in entries {
            zip.start_file(*name, options).unwrap();
            zip.write_all(body).unwrap();
        }
        zip.finish().unwrap().into_inner()
    }

    fn with_bounded_zip64_end_records(bytes: Vec<u8>) -> Vec<u8> {
        let eocd = bytes
            .windows(4)
            .rposition(|window| window == b"PK\x05\x06")
            .unwrap();
        assert_eq!(bytes.len(), eocd + 22, "fixture must have no ZIP comment");
        let entries = u16::from_le_bytes([bytes[eocd + 10], bytes[eocd + 11]]) as u64;
        let central_size = u32::from_le_bytes([
            bytes[eocd + 12],
            bytes[eocd + 13],
            bytes[eocd + 14],
            bytes[eocd + 15],
        ]) as u64;
        let central_offset = u32::from_le_bytes([
            bytes[eocd + 16],
            bytes[eocd + 17],
            bytes[eocd + 18],
            bytes[eocd + 19],
        ]) as u64;

        let mut output = bytes[..eocd].to_vec();
        output.extend_from_slice(b"PK\x06\x06");
        output.extend_from_slice(&44u64.to_le_bytes());
        output.extend_from_slice(&45u16.to_le_bytes());
        output.extend_from_slice(&45u16.to_le_bytes());
        output.extend_from_slice(&0u32.to_le_bytes());
        output.extend_from_slice(&0u32.to_le_bytes());
        output.extend_from_slice(&entries.to_le_bytes());
        output.extend_from_slice(&entries.to_le_bytes());
        output.extend_from_slice(&central_size.to_le_bytes());
        output.extend_from_slice(&central_offset.to_le_bytes());
        output.extend_from_slice(b"PK\x06\x07");
        output.extend_from_slice(&0u32.to_le_bytes());
        output.extend_from_slice(&(eocd as u64).to_le_bytes());
        output.extend_from_slice(&1u32.to_le_bytes());

        let mut conventional = bytes[eocd..].to_vec();
        conventional[8..12].copy_from_slice(&u32::MAX.to_le_bytes());
        conventional[12..20].copy_from_slice(&[u8::MAX; 8]);
        output.extend_from_slice(&conventional);
        output
    }

    fn assert_atomic_failure(cache: &Path, error: &CoreError, expected: &str) {
        assert!(
            error.to_string().contains(expected),
            "expected {expected:?}, got {error}"
        );
        assert!(LogCorpus::list_ids(cache).unwrap().is_empty());
        assert_no_ingest_staging(cache);
    }

    fn finish_failed_evidence(
        recorder: &FailedIngestDiagnosticRecorder,
        error: &CoreError,
        source: &Path,
    ) -> FailedIngestDiagnostic {
        recorder.finish(
            &error.to_string(),
            FailedIngestSourceKind::from_path(source),
            123,
        )
    }

    #[test]
    fn failed_directory_intake_reports_each_typed_exclusion_without_publication() {
        let cases = [
            ("binary.log", b"prefix\0binary".as_slice(), "binary"),
            ("empty.log", b"\n \r\n".as_slice(), "empty"),
            (".hidden.log", b"hidden\n".as_slice(), "hidden"),
            ("oversized.log", b"0123456789abcdef".as_slice(), "oversized"),
        ];
        for (name, body, expected_reason) in cases {
            let root = tempfile::tempdir().unwrap();
            let cache = root.path().join("cache");
            let logs = root.path().join("logs");
            std::fs::create_dir_all(&logs).unwrap();
            std::fs::write(logs.join(name), body).unwrap();
            let recorder = FailedIngestDiagnosticRecorder::default();
            let limits = RawIngestLimits {
                max_file_bytes: if expected_reason == "oversized" {
                    8
                } else {
                    1_024
                },
                ..RawIngestLimits::default()
            };
            let error =
                ingest_with_limits(&cache, &logs, name, limits, &recorder, None).unwrap_err();
            assert_atomic_failure(&cache, &error, "no safe/importable log events");
            let diagnostic = finish_failed_evidence(&recorder, &error, &logs);
            let counts = &diagnostic.evidence.scan_counts;
            let observed = match expected_reason {
                "binary" => counts.binary,
                "empty" => counts.empty,
                "hidden" => counts.hidden,
                "oversized" => counts.oversized,
                _ => unreachable!(),
            };
            assert_eq!(observed, 1, "{diagnostic:?}");
            assert_eq!(diagnostic.evidence.transcript.len(), 1);
            assert_eq!(
                serde_json::to_value(&diagnostic.evidence.transcript[0]).unwrap()["reason"],
                expected_reason
            );
            assert_eq!(diagnostic.evidence.transcript[0].basename, name);
        }
    }

    #[test]
    fn direct_and_nested_zip_intake_share_typed_evidence_and_safe_leaf_names() {
        fn evidence_zip() -> Vec<u8> {
            let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
            let stored = zip::write::SimpleFileOptions::default();
            writer.start_file(".hidden.log", stored).unwrap();
            writer.write_all(b"hidden\n").unwrap();
            writer.start_file("empty.log", stored).unwrap();
            writer.write_all(b"\n").unwrap();
            writer.start_file("binary.log", stored).unwrap();
            writer.write_all(b"x\0y").unwrap();
            let deflated = stored.compression_method(zip::CompressionMethod::Deflated);
            writer.start_file("oversized.log", deflated).unwrap();
            writer.write_all(&vec![b'x'; 2_048]).unwrap();
            writer.finish().unwrap().into_inner()
        }

        for nested in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let cache = root.path().join("cache");
            let selected = root
                .path()
                .join(if nested { "outer.zip" } else { "direct.zip" });
            let evidence_archive = evidence_zip();
            std::fs::write(
                &selected,
                if nested {
                    zip_bytes(&[("private-parent.zip", &evidence_archive)])
                } else {
                    evidence_archive
                },
            )
            .unwrap();
            let recorder = FailedIngestDiagnosticRecorder::default();
            let error = ingest_with_limits(
                &cache,
                &selected,
                "zip-evidence",
                RawIngestLimits {
                    max_file_bytes: 1_024,
                    ..RawIngestLimits::default()
                },
                &recorder,
                None,
            )
            .unwrap_err();
            assert_atomic_failure(&cache, &error, "no safe/importable log events");
            let diagnostic = finish_failed_evidence(&recorder, &error, &selected);
            assert_eq!(diagnostic.evidence.scan_counts.binary, 1);
            assert_eq!(diagnostic.evidence.scan_counts.empty, 1);
            assert_eq!(diagnostic.evidence.scan_counts.hidden, 1);
            assert_eq!(diagnostic.evidence.scan_counts.oversized, 1);
            let basenames = diagnostic
                .evidence
                .transcript
                .iter()
                .map(|entry| entry.basename.as_str())
                .collect::<Vec<_>>();
            assert_eq!(
                basenames,
                [".hidden.log", "empty.log", "binary.log", "oversized.log"]
            );
            assert!(
                basenames.iter().all(|basename| !basename.contains("zip!/")),
                "{basenames:?}"
            );
        }
    }

    #[test]
    fn malformed_direct_and_nested_archives_emit_parse_evidence_and_clean_staging() {
        for nested in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let cache = root.path().join("cache");
            let selected = root
                .path()
                .join(if nested { "outer.zip" } else { "broken.zip" });
            std::fs::write(
                &selected,
                if nested {
                    zip_bytes(&[("broken-inner.zip", b"PK\x03\x04malformed")])
                } else {
                    b"PK\x03\x04malformed".to_vec()
                },
            )
            .unwrap();
            let recorder = FailedIngestDiagnosticRecorder::default();
            let error = ingest_with_limits(
                &cache,
                &selected,
                "malformed",
                RawIngestLimits::default(),
                &recorder,
                None,
            )
            .unwrap_err();
            assert!(error.to_string().contains("zip"), "{error}");
            assert!(LogCorpus::list_ids(&cache).unwrap().is_empty());
            assert_no_ingest_staging(&cache);
            let diagnostic = finish_failed_evidence(&recorder, &error, &selected);
            assert_eq!(diagnostic.evidence.scan_counts.parse_failed, 1);
            assert_eq!(
                diagnostic.evidence.transcript[0].basename,
                if nested {
                    "broken-inner.zip"
                } else {
                    "broken.zip"
                }
            );
        }
    }

    #[test]
    fn corrupt_direct_and_nested_zip_members_emit_read_evidence_and_clean_staging() {
        let body = b"level=error msg=checksum-sentinel\n";
        for nested in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let cache = root.path().join("cache");
            let selected = root
                .path()
                .join(if nested { "outer.zip" } else { "corrupt.zip" });
            let mut corrupt = zip_bytes(&[("unreadable.log", body)]);
            let payload = corrupt
                .windows(body.len())
                .position(|window| window == body)
                .expect("stored payload");
            corrupt[payload + 8] ^= 0x20;
            std::fs::write(
                &selected,
                if nested {
                    zip_bytes(&[("inner.zip", &corrupt)])
                } else {
                    corrupt
                },
            )
            .unwrap();

            let recorder = FailedIngestDiagnosticRecorder::default();
            let error = ingest_with_limits(
                &cache,
                &selected,
                "corrupt-member",
                RawIngestLimits::default(),
                &recorder,
                None,
            )
            .unwrap_err();
            assert!(
                error.to_string().contains("read")
                    || error.to_string().contains("checksum")
                    || error.to_string().contains("CRC"),
                "{error}"
            );
            assert!(LogCorpus::list_ids(&cache).unwrap().is_empty());
            assert_no_ingest_staging(&cache);
            let diagnostic = finish_failed_evidence(&recorder, &error, &selected);
            assert_eq!(diagnostic.evidence.scan_counts.read_failed, 1);
            assert_eq!(diagnostic.evidence.transcript[0].basename, "unreadable.log");
        }
    }

    #[test]
    fn overlong_source_line_is_typed_parse_failure_and_never_publishes() {
        let root = tempfile::tempdir().unwrap();
        let cache = root.path().join("cache");
        let log = root.path().join("overlong.log");
        std::fs::write(&log, "x".repeat(64)).unwrap();
        let recorder = FailedIngestDiagnosticRecorder::default();
        let error = ingest_with_limits(
            &cache,
            &log,
            "overlong",
            RawIngestLimits {
                max_file_bytes: 128,
                max_line_bytes: 16,
                ..RawIngestLimits::default()
            },
            &recorder,
            None,
        )
        .unwrap_err();
        assert_atomic_failure(&cache, &error, "line-length limit");
        let diagnostic = finish_failed_evidence(&recorder, &error, &log);
        assert_eq!(diagnostic.evidence.scan_counts.parse_failed, 1);
        assert_eq!(diagnostic.evidence.transcript[0].basename, "overlong.log");
    }

    #[test]
    fn source_removed_after_scan_is_typed_read_failure_and_never_publishes() {
        use std::sync::atomic::{AtomicBool, Ordering};

        struct RemoveAfterInventory {
            source: PathBuf,
            removed: AtomicBool,
            diagnostic: FailedIngestDiagnosticRecorder,
        }

        impl ProcessProgressObserver for RemoveAfterInventory {
            fn progress(&self, update: ProcessProgress) {
                if update.phase == ProcessProgressPhase::Stream
                    && !self.removed.swap(true, Ordering::SeqCst)
                {
                    std::fs::remove_file(&self.source).unwrap();
                }
                self.diagnostic.progress(update);
            }

            fn log_ingest_evidence(&self, evidence: LogIngestEvidence) {
                self.diagnostic.log_ingest_evidence(evidence);
            }
        }

        let root = tempfile::tempdir().unwrap();
        let cache = root.path().join("cache");
        let logs = root.path().join("logs");
        std::fs::create_dir_all(&logs).unwrap();
        let source = logs.join("unreadable-after-scan.log");
        std::fs::write(&source, "level=error msg=must-not-publish\n").unwrap();
        let observer = RemoveAfterInventory {
            source,
            removed: AtomicBool::new(false),
            diagnostic: FailedIngestDiagnosticRecorder::default(),
        };
        let error = ingest_with_limits(
            &cache,
            &logs,
            "read-failure",
            RawIngestLimits::default(),
            &observer,
            None,
        )
        .unwrap_err();
        assert_atomic_failure(&cache, &error, "no safe/importable log events");
        let diagnostic = finish_failed_evidence(&observer.diagnostic, &error, &logs);
        assert_eq!(diagnostic.evidence.scan_counts.read_failed, 1);
        assert_eq!(
            diagnostic.evidence.transcript[0].basename,
            "unreadable-after-scan.log"
        );
    }

    #[test]
    fn nested_zip_success_from_directory_and_archive_preserves_virtual_identities() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache");
        let logs = dir.path().join("logs");
        std::fs::create_dir_all(&logs).unwrap();
        std::fs::write(logs.join("visible.log"), "level=info msg=visible\n").unwrap();
        let inner = zip_bytes(&[("deep/app.log", b"level=error msg=nested-visible\n")]);
        std::fs::write(logs.join("host-a.zip"), &inner).unwrap();
        std::fs::write(logs.join("host-a.bundle"), &inner).unwrap();

        let directory_report =
            ingest_path(&cache, &logs, "directory-nested", None, "none").unwrap();
        assert_eq!(directory_report.stats.lines, 3);
        assert_eq!(directory_report.stats.files, 3);
        assert!(!directory_report.stats.partial);
        let directory_corpus = LogCorpus::open(&cache, &directory_report.corpus_id).unwrap();
        let mut directory_sources = directory_corpus.with_events(|events| {
            events
                .iter()
                .map(|event| event.source.clone())
                .collect::<Vec<_>>()
        });
        directory_sources.sort();
        assert_eq!(
            directory_sources,
            [
                "host-a.bundle!/deep/app.log",
                "host-a.zip!/deep/app.log",
                "visible.log"
            ]
        );

        let outer = dir.path().join("outer.zip");
        std::fs::write(
            &outer,
            zip_bytes(&[
                ("visible.log", b"level=info msg=outer-visible\n"),
                ("host-b.zip", &inner),
                ("host-b.bundle", &inner),
            ]),
        )
        .unwrap();
        let archive_report = ingest_path(&cache, &outer, "zip-nested", None, "none").unwrap();
        assert_eq!(archive_report.stats.lines, 3);
        assert_eq!(archive_report.stats.files, 3);
        assert!(!archive_report.stats.partial);
        let archive_corpus = LogCorpus::open(&cache, &archive_report.corpus_id).unwrap();
        let mut archive_sources = archive_corpus.with_events(|events| {
            events
                .iter()
                .map(|event| event.source.clone())
                .collect::<Vec<_>>()
        });
        archive_sources.sort();
        assert_eq!(
            archive_sources,
            [
                "outer.zip!/host-b.bundle!/deep/app.log",
                "outer.zip!/host-b.zip!/deep/app.log",
                "visible.log"
            ]
        );
        assert_no_ingest_staging(&cache);
    }

    #[test]
    fn nested_zip_malformed_container_fails_atomically_and_cleans_staging() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache");
        let outer = dir.path().join("outer.zip");
        std::fs::write(
            &outer,
            zip_bytes(&[
                ("visible.log", b"level=info msg=must-not-publish\n"),
                ("broken.zip", b"PK\x03\x04malformed nested bytes"),
            ]),
        )
        .unwrap();

        let error = ingest_path(&cache, &outer, "malformed-nested", None, "none").unwrap_err();
        assert_atomic_failure(&cache, &error, "zip open");
    }

    #[test]
    fn nested_zip_binary_only_input_fails_atomically_and_cleans_staging() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache");
        let outer = dir.path().join("outer.zip");
        let inner = zip_bytes(&[("binary.log", b"prefix\0binary")]);
        std::fs::write(&outer, zip_bytes(&[("host.zip", &inner)])).unwrap();

        let error = ingest_path(&cache, &outer, "binary-nested", None, "none").unwrap_err();
        assert_atomic_failure(&cache, &error, "no safe/importable log events");
    }

    #[test]
    fn hidden_directory_and_archive_subtrees_have_policy_parity() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache");
        let logs = dir.path().join("logs");
        std::fs::create_dir_all(logs.join(".private/deep")).unwrap();
        std::fs::write(
            logs.join(".private/deep/secret.log"),
            "level=error msg=must-not-import\n",
        )
        .unwrap();
        std::fs::write(logs.join("visible.log"), "level=info msg=visible\n").unwrap();
        let directory_report =
            ingest_path(&cache, &logs, "hidden-directory", None, "none").unwrap();
        assert_eq!(directory_report.stats.lines, 1);
        assert_eq!(directory_report.stats.ignored_files, 1);
        assert_eq!(directory_report.stats.exclusion_counts["hidden"], 1);

        let zip_path = dir.path().join("hidden.zip");
        std::fs::write(
            &zip_path,
            zip_bytes(&[
                (
                    ".private/deep/secret.log",
                    b"level=error msg=must-not-import\n",
                ),
                ("visible.log", b"level=info msg=visible\n"),
            ]),
        )
        .unwrap();
        let archive_report =
            ingest_path(&cache, &zip_path, "hidden-archive", None, "none").unwrap();
        assert_eq!(archive_report.stats.lines, 1);
        assert_eq!(archive_report.stats.ignored_files, 1);
        assert_eq!(archive_report.stats.exclusion_counts["hidden"], 1);

        let nested_cache = dir.path().join("nested-cache");
        let nested_path = dir.path().join("nested-hidden.zip");
        let inner = zip_bytes(&[
            (
                ".private/deep/secret.log",
                b"level=error msg=must-not-import\n",
            ),
            ("visible.log", b"level=info msg=nested-visible\n"),
        ]);
        std::fs::write(&nested_path, zip_bytes(&[("host.zip", &inner)])).unwrap();
        let nested_report =
            ingest_path(&nested_cache, &nested_path, "hidden-nested", None, "none").unwrap();
        assert_eq!(nested_report.stats.lines, 1);
        assert_eq!(nested_report.stats.ignored_files, 1);
        assert_eq!(nested_report.stats.exclusion_counts["hidden"], 1);
    }

    #[test]
    fn nested_zip_summary_and_progress_use_bounded_basename_only_reasons() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache");
        let outer = dir.path().join("support.zip");
        let inner = {
            let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
            let options = zip::write::SimpleFileOptions::default();
            writer.start_file("safe.log", options).unwrap();
            writer.write_all(b"level=info msg=safe\n").unwrap();
            writer.start_file(".hidden.log", options).unwrap();
            writer.write_all(b"must-not-import\n").unwrap();
            writer.start_file("binary.log", options).unwrap();
            writer.write_all(b"prefix\0binary").unwrap();
            writer
                .add_symlink("link.log", "../outside.log", options)
                .unwrap();
            writer.finish().unwrap().into_inner()
        };
        std::fs::write(&outer, zip_bytes(&[("host-a.zip", &inner)])).unwrap();
        let recorder = RecordingProcessProgress::default();

        let report = ingest_path_with_observer(
            &cache,
            &outer,
            "nested-reporting",
            None,
            "none",
            &recorder,
            None,
        )
        .unwrap();
        assert_eq!(report.stats.files, 1);
        assert_eq!(report.stats.ignored_files, 1);
        assert_eq!(report.stats.excluded_files, 2);
        assert_eq!(report.stats.failed_files, 0);
        assert_eq!(report.stats.exclusion_counts["hidden"], 1);
        assert_eq!(report.stats.exclusion_counts["binary"], 1);
        assert_eq!(report.stats.exclusion_counts["symlink"], 1);
        assert_eq!(
            report.stats.exclusion_examples,
            [
                "hidden: .hidden.log",
                "binary: binary.log",
                "symlink: link.log"
            ]
        );
        assert!(report.stats.partial);
        let updates = recorder.updates.lock().unwrap();
        assert!(updates
            .iter()
            .any(|update| update.message.contains("depth 2")));
        assert!(updates
            .iter()
            .all(|update| !update.message.contains("/Users/")));
        assert!(updates.iter().all(|update| !update
            .message
            .contains(dir.path().to_string_lossy().as_ref())));
    }

    #[test]
    fn directory_same_basenames_keep_distinct_relative_source_identities() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache");
        let logs = dir.path().join("logs");
        std::fs::create_dir_all(logs.join("host-a")).unwrap();
        std::fs::create_dir_all(logs.join("host-b")).unwrap();
        std::fs::write(
            logs.join("host-a/app.log"),
            "level=info msg=host-a-visible\n",
        )
        .unwrap();
        std::fs::write(
            logs.join("host-b/app.log"),
            "level=error msg=host-b-visible\n",
        )
        .unwrap();

        let report = ingest_path(&cache, &logs, "same-basename", None, "none").unwrap();
        let corpus = LogCorpus::open(&cache, &report.corpus_id).unwrap();
        let mut sources = corpus.with_events(|events| {
            events
                .iter()
                .map(|event| event.source.clone())
                .collect::<Vec<_>>()
        });
        sources.sort();
        assert_eq!(sources, ["host-a/app.log", "host-b/app.log"]);
    }

    #[test]
    fn direct_and_directory_leaf_names_ending_in_bang_remain_importable() {
        let dir = tempfile::tempdir().unwrap();
        let direct_cache = dir.path().join("direct-cache");
        let direct = dir.path().join("important!");
        std::fs::write(&direct, "level=error msg=direct-visible\n").unwrap();

        let direct_report =
            ingest_path(&direct_cache, &direct, "direct-bang", None, "none").unwrap();
        let direct_corpus = LogCorpus::open(&direct_cache, &direct_report.corpus_id).unwrap();
        assert_eq!(
            direct_corpus.with_events(|events| events[0].source.clone()),
            "important!"
        );

        let directory_cache = dir.path().join("directory-cache");
        let logs = dir.path().join("logs");
        std::fs::create_dir_all(&logs).unwrap();
        std::fs::write(
            logs.join("directory-leaf!"),
            "level=info msg=directory-visible\n",
        )
        .unwrap();
        let directory_report =
            ingest_path(&directory_cache, &logs, "directory-bang", None, "none").unwrap();
        let directory_corpus =
            LogCorpus::open(&directory_cache, &directory_report.corpus_id).unwrap();
        assert_eq!(
            directory_corpus.with_events(|events| events[0].source.clone()),
            "directory-leaf!"
        );
    }

    #[test]
    fn non_leaf_bang_identity_that_mimics_archive_boundary_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache");
        let logs = dir.path().join("logs");
        std::fs::create_dir_all(logs.join("ambiguous!")).unwrap();
        std::fs::write(
            logs.join("ambiguous!/app.log"),
            "level=error msg=must-not-publish\n",
        )
        .unwrap();

        let error = ingest_path(&cache, &logs, "ambiguous-bang", None, "none").unwrap_err();
        assert_atomic_failure(&cache, &error, "archive boundary syntax");
    }

    #[test]
    fn nested_zip_same_basenames_in_distinct_archives_keep_distinct_identities() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache");
        let outer = dir.path().join("support.zip");
        let host_a = zip_bytes(&[("logs/app.log", b"level=info msg=host-a\n")]);
        let host_b = zip_bytes(&[("logs/app.log", b"level=error msg=host-b\n")]);
        std::fs::write(
            &outer,
            zip_bytes(&[("hosts/a.zip", &host_a), ("hosts/b.zip", &host_b)]),
        )
        .unwrap();

        let report = ingest_path(&cache, &outer, "same-nested-basename", None, "none").unwrap();
        let corpus = LogCorpus::open(&cache, &report.corpus_id).unwrap();
        let mut sources = corpus.with_events(|events| {
            events
                .iter()
                .map(|event| event.source.clone())
                .collect::<Vec<_>>()
        });
        sources.sort();
        assert_eq!(
            sources,
            [
                "support.zip!/hosts/a.zip!/logs/app.log",
                "support.zip!/hosts/b.zip!/logs/app.log"
            ]
        );
    }

    #[cfg(unix)]
    #[test]
    fn directory_walk_excludes_symlink_and_non_regular_entries_but_imports_safe_logs() {
        use std::os::unix::fs::symlink;
        use std::os::unix::net::UnixListener;

        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache");
        let logs = dir.path().join("logs");
        let outside = dir.path().join("outside.log");
        std::fs::create_dir_all(&logs).unwrap();
        std::fs::write(logs.join("safe.log"), "level=info msg=safe\n").unwrap();
        std::fs::write(&outside, "level=error msg=must-not-import\n").unwrap();
        symlink(&outside, logs.join("escape.log")).unwrap();
        let _socket = UnixListener::bind(logs.join("events.sock")).unwrap();

        let report = ingest_path(&cache, &logs, "mixed-special", None, "none").unwrap();
        assert_eq!(report.stats.lines, 1);
        assert_eq!(report.stats.files, 1);
        assert_eq!(report.stats.discovered_files, 3);
        assert_eq!(report.stats.excluded_files, 2);
        assert_eq!(report.stats.exclusion_counts["symlink"], 1);
        assert_eq!(report.stats.exclusion_counts["non_regular"], 1);
        assert!(report
            .stats
            .exclusion_examples
            .contains(&"symlink: escape.log".to_string()));
        assert!(report
            .stats
            .exclusion_examples
            .contains(&"non_regular: events.sock".to_string()));
        assert!(report.stats.partial);
        let corpus = LogCorpus::open(&cache, &report.corpus_id).unwrap();
        assert_eq!(
            corpus.with_events(|events| events
                .iter()
                .map(|event| event.message.clone())
                .collect::<Vec<_>>()),
            ["safe".to_string()]
        );
    }

    #[cfg(unix)]
    #[test]
    fn directly_selected_symlink_is_rejected_atomically() {
        use std::os::unix::fs::symlink;

        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache");
        let target = dir.path().join("target.log");
        let selected = dir.path().join("selected.log");
        std::fs::write(&target, "level=error msg=outside\n").unwrap();
        symlink(&target, &selected).unwrap();

        let error = ingest_path(&cache, &selected, "symlink", None, "none").unwrap_err();
        assert_atomic_failure(&cache, &error, "symlink");

        let socket_cache = dir.path().join("socket-cache");
        let socket_path = dir.path().join("selected.sock");
        let _socket = std::os::unix::net::UnixListener::bind(&socket_path).unwrap();
        let error = ingest_path(&socket_cache, &socket_path, "socket", None, "none").unwrap_err();
        assert_atomic_failure(&socket_cache, &error, "non-regular");
    }

    #[cfg(windows)]
    #[test]
    fn windows_secure_open_reports_stable_identity_and_final_path_for_regular_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("regular.log");
        std::fs::write(&path, "level=info msg=safe\n").unwrap();
        let expected = std::fs::canonicalize(&path).unwrap();
        let allowed_root = std::fs::canonicalize(dir.path()).unwrap();

        let file = windows_secure_open_regular_file(
            &path,
            &expected,
            Some(&allowed_root),
            "open test log",
            "test log changed during secure open",
        )
        .unwrap();
        let (_, _, final_path) = windows_opened_file_details(&file).unwrap();
        assert_eq!(final_path, expected);
    }

    #[cfg(windows)]
    #[test]
    fn windows_direct_reparse_point_is_rejected_when_symlink_creation_is_available() {
        use std::os::windows::fs::symlink_file;

        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache");
        let target = dir.path().join("target.log");
        let selected = dir.path().join("selected.log");
        std::fs::write(&target, "level=error msg=outside\n").unwrap();
        if let Err(error) = symlink_file(&target, &selected) {
            // Unprivileged Windows environments may disable symlink creation;
            // the regular-handle test above still exercises handle identity
            // and final-path validation.
            if matches!(
                error.kind(),
                std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::Unsupported
            ) {
                return;
            }
            panic!("create Windows test symlink: {error}");
        }

        let error = ingest_path(&cache, &selected, "windows-reparse", None, "none").unwrap_err();
        assert_atomic_failure(&cache, &error, "symlink");
    }

    #[test]
    fn zip_preflight_rejects_duplicate_and_traversal_entries() {
        let mut duplicate = zip_bytes(&[
            ("one.log", b"level=info msg=one\n"),
            ("two.log", b"level=info msg=two\n"),
        ]);
        let central_positions: Vec<_> = duplicate
            .windows(4)
            .enumerate()
            .filter_map(|(position, window)| (window == b"PK\x01\x02").then_some(position))
            .collect();
        assert_eq!(central_positions.len(), 2);
        let second_name = central_positions[1] + 46;
        duplicate[second_name..second_name + 7].copy_from_slice(b"one.log");
        let cases = [
            ("duplicate", duplicate, "duplicate"),
            (
                "traversal",
                zip_bytes(&[("../escape.log", b"level=error msg=escape\n")]),
                "path rejected",
            ),
        ];
        for (case, bytes, expected) in cases {
            let dir = tempfile::tempdir().unwrap();
            let cache = dir.path().join("cache");
            let archive = dir.path().join(format!("{case}.zip"));
            std::fs::write(&archive, bytes).unwrap();
            let error = ingest_path(&cache, &archive, case, None, "none").unwrap_err();
            assert_atomic_failure(&cache, &error, expected);
        }
    }

    #[test]
    fn nested_zip_duplicate_normalized_identity_fails_atomically() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache");
        let outer = dir.path().join("outer.zip");
        let mut inner = zip_bytes(&[
            ("one.log", b"level=info msg=one\n"),
            ("two.log", b"level=info msg=two\n"),
        ]);
        let central_positions: Vec<_> = inner
            .windows(4)
            .enumerate()
            .filter_map(|(position, window)| (window == b"PK\x01\x02").then_some(position))
            .collect();
        assert_eq!(central_positions.len(), 2);
        let second_name = central_positions[1] + 46;
        inner[second_name..second_name + 7].copy_from_slice(b"one.log");
        std::fs::write(&outer, zip_bytes(&[("host.zip", &inner)])).unwrap();

        let error = ingest_path(&cache, &outer, "duplicate-nested", None, "none").unwrap_err();
        assert_atomic_failure(&cache, &error, "duplicate");
    }

    #[test]
    fn nested_zip_traversal_backslash_nul_and_symlink_metadata_are_rejected_or_excluded() {
        for (case, inner, expected) in [
            (
                "traversal",
                zip_bytes(&[("../escape.log", b"level=error msg=escape\n")]),
                "path rejected",
            ),
            (
                "backslash",
                zip_bytes(&[("logs\\app.log", b"level=error msg=ambiguous\n")]),
                "path rejected",
            ),
            (
                "virtual-delimiter",
                zip_bytes(&[("host.zip!/app.log", b"level=error msg=ambiguous\n")]),
                "path rejected",
            ),
            (
                "nul",
                {
                    let mut bytes = zip_bytes(&[("nul.log", b"level=error msg=nul\n")]);
                    let central = bytes
                        .windows(4)
                        .position(|window| window == b"PK\x01\x02")
                        .unwrap();
                    bytes[central + 49] = 0;
                    bytes
                },
                "path rejected",
            ),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let cache = dir.path().join("cache");
            let outer = dir.path().join(format!("{case}.zip"));
            std::fs::write(&outer, zip_bytes(&[("host.zip", &inner)])).unwrap();
            let error = ingest_path(&cache, &outer, case, None, "none").unwrap_err();
            assert_atomic_failure(&cache, &error, expected);
        }

        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache");
        let outer = dir.path().join("symlink.zip");
        let inner = {
            let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
            let options = zip::write::SimpleFileOptions::default();
            writer.start_file("safe.log", options).unwrap();
            writer.write_all(b"level=info msg=safe\n").unwrap();
            writer
                .add_symlink("link.log", "../outside.log", options)
                .unwrap();
            writer.finish().unwrap().into_inner()
        };
        std::fs::write(&outer, zip_bytes(&[("host.zip", &inner)])).unwrap();
        let report = ingest_path(&cache, &outer, "nested-symlink", None, "none").unwrap();
        assert_eq!(report.stats.lines, 1);
        assert_eq!(report.stats.exclusion_counts["symlink"], 1);
        assert!(report
            .stats
            .exclusion_examples
            .contains(&"symlink: link.log".to_string()));
        assert!(report.stats.partial);
    }

    #[test]
    fn nested_zip_encrypted_malformed_zip64_and_multi_disk_metadata_fail_atomically() {
        for (case, expected, patch) in [
            ("encrypted", "encrypted", "flags"),
            ("malformed-zip64", "Zip64", "size"),
            ("multi-disk", "multi-disk", "disk"),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let cache = dir.path().join("cache");
            let outer = dir.path().join(format!("{case}.zip"));
            let mut inner = zip_bytes(&[("app.log", b"level=info msg=safe\n")]);
            let central = inner
                .windows(4)
                .position(|window| window == b"PK\x01\x02")
                .unwrap();
            let eocd = inner
                .windows(4)
                .position(|window| window == b"PK\x05\x06")
                .unwrap();
            match patch {
                "flags" => {
                    let flags = u16::from_le_bytes([inner[central + 8], inner[central + 9]]) | 1;
                    inner[central + 8..central + 10].copy_from_slice(&flags.to_le_bytes());
                }
                "size" => {
                    inner[central + 24..central + 28].copy_from_slice(&u32::MAX.to_le_bytes());
                }
                "disk" => {
                    inner[eocd + 4..eocd + 6].copy_from_slice(&1u16.to_le_bytes());
                }
                _ => unreachable!(),
            }
            std::fs::write(&outer, zip_bytes(&[("host.zip", &inner)])).unwrap();
            let error = ingest_path(&cache, &outer, case, None, "none").unwrap_err();
            assert_atomic_failure(&cache, &error, expected);
        }
    }

    #[test]
    fn zip_excludes_symlink_and_non_regular_entries_but_imports_safe_logs() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache");
        let archive = dir.path().join("mixed-special.zip");
        {
            let file = std::fs::File::create(&archive).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            zip.start_file("safe.log", zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(b"level=info msg=safe\n").unwrap();
            zip.add_symlink(
                "link.log",
                "../outside.log",
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
            zip.start_file("socket.log", zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(b"level=error msg=must-not-import\n").unwrap();
            zip.finish().unwrap();
        }
        let mut bytes = std::fs::read(&archive).unwrap();
        let socket_mode = (0o140777u32) << 16;
        let socket_central = bytes
            .windows(4)
            .enumerate()
            .filter_map(|(position, window)| (window == b"PK\x01\x02").then_some(position))
            .find(|position| {
                let name_len =
                    u16::from_le_bytes([bytes[position + 28], bytes[position + 29]]) as usize;
                bytes.get(position + 46..position + 46 + name_len) == Some(b"socket.log")
            })
            .unwrap();
        bytes[socket_central + 38..socket_central + 42].copy_from_slice(&socket_mode.to_le_bytes());
        std::fs::write(&archive, bytes).unwrap();

        let report = ingest_path(&cache, &archive, "mixed-special", None, "none").unwrap();
        assert_eq!(report.stats.lines, 1);
        assert_eq!(report.stats.files, 1);
        assert_eq!(report.stats.discovered_files, 3);
        assert_eq!(report.stats.excluded_files, 2);
        assert_eq!(report.stats.exclusion_counts["symlink"], 1);
        assert_eq!(report.stats.exclusion_counts["non_regular"], 1);
        assert!(report
            .stats
            .exclusion_examples
            .contains(&"symlink: link.log".to_string()));
        assert!(report
            .stats
            .exclusion_examples
            .contains(&"non_regular: socket.log".to_string()));
        assert!(report.stats.partial);
        let corpus = LogCorpus::open(&cache, &report.corpus_id).unwrap();
        assert_eq!(
            corpus.with_events(|events| events
                .iter()
                .map(|event| event.message.clone())
                .collect::<Vec<_>>()),
            ["safe".to_string()]
        );
    }

    #[test]
    fn zip_preflight_rejects_encrypted_malformed_zip64_and_multi_disk_metadata() {
        for (case, expected, patch) in [
            ("encrypted", "encrypted", "flags"),
            ("malformed-zip64", "Zip64", "size"),
            ("multi-disk", "multi-disk", "disk"),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let cache = dir.path().join("cache");
            let archive = dir.path().join(format!("{case}.zip"));
            let mut bytes = zip_bytes(&[("app.log", b"level=info msg=safe\n")]);
            let central = bytes
                .windows(4)
                .position(|window| window == b"PK\x01\x02")
                .unwrap();
            let eocd = bytes
                .windows(4)
                .position(|window| window == b"PK\x05\x06")
                .unwrap();
            match patch {
                "flags" => {
                    let flags = u16::from_le_bytes([bytes[central + 8], bytes[central + 9]]) | 1;
                    bytes[central + 8..central + 10].copy_from_slice(&flags.to_le_bytes());
                }
                "size" => {
                    bytes[central + 24..central + 28].copy_from_slice(&u32::MAX.to_le_bytes());
                }
                "disk" => {
                    bytes[eocd + 4..eocd + 6].copy_from_slice(&1u16.to_le_bytes());
                }
                _ => unreachable!(),
            }
            std::fs::write(&archive, bytes).unwrap();
            let error = ingest_path(&cache, &archive, case, None, "none").unwrap_err();
            assert_atomic_failure(&cache, &error, expected);
        }
    }

    #[test]
    fn valid_bounded_zip64_entry_imports_through_resolved_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache");
        let archive = dir.path().join("bounded-zip64.zip");
        {
            let file = std::fs::File::create(&archive).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            let options = zip::write::SimpleFileOptions::default().large_file(true);
            zip.start_file("app.log", options).unwrap();
            zip.write_all(b"level=info msg=zip64-safe\n").unwrap();
            zip.finish().unwrap();
        }
        let bytes = std::fs::read(&archive).unwrap();
        let central = bytes
            .windows(4)
            .position(|window| window == b"PK\x01\x02")
            .unwrap();
        assert!(
            u32::from_le_bytes([
                bytes[central + 24],
                bytes[central + 25],
                bytes[central + 26],
                bytes[central + 27],
            ]) == u32::MAX,
            "fixture must carry a Zip64 size sentinel resolved by extra metadata"
        );

        let report = ingest_path(&cache, &archive, "bounded-zip64", None, "none").unwrap();
        assert_eq!(report.stats.lines, 1);
        assert_eq!(report.stats.files, 1);
        assert!(!report.stats.partial);
    }

    #[test]
    fn valid_bounded_zip64_end_records_import_through_resolved_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache");
        let archive = dir.path().join("bounded-zip64-end.zip");
        std::fs::write(
            &archive,
            with_bounded_zip64_end_records(zip_bytes(&[(
                "app.log",
                b"level=info msg=zip64-end-safe\n",
            )])),
        )
        .unwrap();

        let report = ingest_path(&cache, &archive, "bounded-zip64-end", None, "none").unwrap();
        assert_eq!(report.stats.lines, 1);
        assert_eq!(report.stats.files, 1);
        assert!(!report.stats.partial);
    }

    #[test]
    fn nested_zip_valid_bounded_zip64_imports_through_shared_preflight() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache");
        let outer = dir.path().join("outer.zip");
        let inner = with_bounded_zip64_end_records(zip_bytes(&[(
            "app.log",
            b"level=info msg=nested-zip64-safe\n",
        )]));
        std::fs::write(&outer, zip_bytes(&[("host.zip", &inner)])).unwrap();

        let report = ingest_path(&cache, &outer, "nested-zip64", None, "none").unwrap();
        assert_eq!(report.stats.lines, 1);
        assert_eq!(report.stats.files, 1);
        assert!(!report.stats.partial);
        let corpus = LogCorpus::open(&cache, &report.corpus_id).unwrap();
        assert_eq!(
            corpus.with_events(|events| events[0].source.clone()),
            "outer.zip!/host.zip!/app.log"
        );
    }

    #[test]
    fn zip_per_member_cap_is_an_honest_exclusion() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache");
        let archive = dir.path().join("member-cap.zip");
        std::fs::write(
            &archive,
            zip_bytes(&[
                ("safe.log", b"level=info msg=safe\n"),
                (
                    "large.log",
                    b"level=error msg=this-member-is-over-the-test-cap\n",
                ),
            ]),
        )
        .unwrap();
        let limits = RawIngestLimits {
            max_file_bytes: 32,
            ..RawIngestLimits::default()
        };
        let report = ingest_with_limits(
            &cache,
            &archive,
            "member-cap",
            limits,
            &NoopProcessProgress,
            None,
        )
        .unwrap();
        assert_eq!(report.stats.lines, 1);
        assert_eq!(report.stats.files, 1);
        assert_eq!(report.stats.excluded_files, 1);
        assert_eq!(report.stats.exclusion_counts["too_large"], 1);
        assert!(report.stats.partial);
    }

    #[test]
    fn entry_and_actual_byte_budgets_fail_atomically() {
        let cases = [
            (
                "entries",
                zip_bytes(&[
                    ("one.log", b"level=info msg=one\n"),
                    ("two.log", b"level=info msg=two\n"),
                ]),
                RawIngestLimits {
                    max_entries: 1,
                    ..RawIngestLimits::default()
                },
                "entry limit",
            ),
            (
                "actual-bytes",
                zip_bytes(&[
                    ("one.log", b"level=info msg=one\n"),
                    ("two.log", b"level=info msg=two\n"),
                ]),
                RawIngestLimits {
                    max_expanded_bytes: 24,
                    ..RawIngestLimits::default()
                },
                "aggregate actual-byte limit",
            ),
        ];
        for (case, bytes, limits, expected) in cases {
            let dir = tempfile::tempdir().unwrap();
            let cache = dir.path().join("cache");
            let archive = dir.path().join(format!("{case}.zip"));
            std::fs::write(&archive, bytes).unwrap();
            let error =
                ingest_with_limits(&cache, &archive, case, limits, &NoopProcessProgress, None)
                    .unwrap_err();
            assert_atomic_failure(&cache, &error, expected);
        }
    }

    #[test]
    fn nested_zip_depth_entry_member_aggregate_and_ratio_limits_fail_atomically() {
        let leaf = zip_bytes(&[("app.log", b"level=error msg=deep\n")]);
        let middle = zip_bytes(&[("deep.zip", &leaf)]);
        let too_deep = zip_bytes(&[("middle.zip", &middle)]);

        let two_entries = zip_bytes(&[
            ("one.log", b"level=info msg=one\n"),
            ("two.log", b"level=info msg=two\n"),
        ]);
        let entry_limited = zip_bytes(&[("host.zip", &two_entries)]);

        let oversized_leaf_body = vec![b'x'; 96];
        let oversized_leaf = zip_bytes(&[("large.log", &oversized_leaf_body)]);
        let member_limited = zip_bytes(&[("host.zip", &oversized_leaf)]);

        let aggregate_body = b"level=error msg=aggregate-budget\n";
        let aggregate_inner = zip_bytes(&[("app.log", aggregate_body)]);
        let aggregate_limited = zip_bytes(&[("host.zip", &aggregate_inner)]);
        let aggregate_cap = aggregate_inner.len() as u64 + aggregate_body.len() as u64 - 1;

        let ratio_inner = {
            let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            writer.start_file("repeated.log", options).unwrap();
            writer.write_all(&vec![b'a'; 64 * 1024]).unwrap();
            writer.finish().unwrap().into_inner()
        };
        let ratio_limited = zip_bytes(&[("host.zip", &ratio_inner)]);

        let cases = [
            (
                "depth",
                too_deep,
                RawIngestLimits {
                    max_archive_depth: 2,
                    ..RawIngestLimits::default()
                },
                "depth limit",
            ),
            (
                "entry",
                entry_limited,
                RawIngestLimits {
                    max_entries: 2,
                    ..RawIngestLimits::default()
                },
                "entry limit",
            ),
            (
                "member",
                member_limited,
                RawIngestLimits {
                    max_file_bytes: 64,
                    ..RawIngestLimits::default()
                },
                "no safe/importable log events",
            ),
            (
                "aggregate",
                aggregate_limited,
                RawIngestLimits {
                    max_expanded_bytes: aggregate_cap,
                    ..RawIngestLimits::default()
                },
                "aggregate actual-byte limit",
            ),
            (
                "ratio",
                ratio_limited,
                RawIngestLimits {
                    max_compression_ratio: 2,
                    ..RawIngestLimits::default()
                },
                "compression-ratio limit",
            ),
        ];

        for (case, bytes, limits, expected) in cases {
            let dir = tempfile::tempdir().unwrap();
            let cache = dir.path().join("cache");
            let outer = dir.path().join(format!("{case}.zip"));
            std::fs::write(&outer, bytes).unwrap();
            let error =
                ingest_with_limits(&cache, &outer, case, limits, &NoopProcessProgress, None)
                    .unwrap_err();
            assert_atomic_failure(&cache, &error, expected);
        }
    }

    #[test]
    fn excluded_content_does_not_consume_the_actual_byte_budget() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache");
        let archive = dir.path().join("excluded-budget.zip");
        {
            let file = std::fs::File::create(&archive).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            let options = zip::write::SimpleFileOptions::default();
            zip.start_file("safe.log", options).unwrap();
            zip.write_all(b"level=info msg=safe\n").unwrap();
            zip.start_file(".hidden.log", options).unwrap();
            zip.write_all(&[b'h'; 64]).unwrap();
            zip.start_file("oversized.log", options).unwrap();
            zip.write_all(&[b'o'; 64]).unwrap();
            zip.start_file("binary.log", options).unwrap();
            zip.write_all(b"\0binary-content").unwrap();
            zip.finish().unwrap();
        }
        let limits = RawIngestLimits {
            max_file_bytes: 32,
            max_expanded_bytes: 24,
            ..RawIngestLimits::default()
        };
        let report = ingest_with_limits(
            &cache,
            &archive,
            "excluded-zip-budget",
            limits,
            &NoopProcessProgress,
            None,
        )
        .unwrap();
        assert_eq!(report.stats.lines, 1);
        assert_eq!(report.stats.files, 1);
        assert_eq!(report.stats.ignored_files, 1);
        assert_eq!(report.stats.exclusion_counts["hidden"], 1);
        assert_eq!(report.stats.exclusion_counts["too_large"], 1);
        assert_eq!(report.stats.exclusion_counts["binary"], 1);

        let directory_cache = dir.path().join("directory-cache");
        let logs = dir.path().join("logs");
        std::fs::create_dir_all(&logs).unwrap();
        std::fs::write(logs.join("safe.log"), b"level=info msg=safe\n").unwrap();
        std::fs::write(logs.join("binary.log"), b"\0binary-content").unwrap();
        std::fs::write(logs.join("oversized-b.bin"), [b'n'; 64]).unwrap();
        std::fs::write(logs.join("oversized.log"), [b'o'; 64]).unwrap();
        let report = ingest_with_limits(
            &directory_cache,
            &logs,
            "excluded-directory-budget",
            limits,
            &NoopProcessProgress,
            None,
        )
        .unwrap();
        assert_eq!(report.stats.lines, 1);
        assert_eq!(report.stats.files, 1);
        assert_eq!(report.stats.exclusion_counts["binary"], 1);
        assert_eq!(report.stats.exclusion_counts["too_large"], 2);
    }

    #[test]
    fn highly_repetitive_log_within_absolute_bounds_imports() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache");
        let archive = dir.path().join("repetitive.zip");
        {
            let file = std::fs::File::create(&archive).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            zip.start_file("repeated.log", options).unwrap();
            let chunk = [b'a'; 64 * 1024];
            for _ in 0..17 {
                zip.write_all(&chunk).unwrap();
            }
            zip.finish().unwrap();
        }
        {
            let file = std::fs::File::open(&archive).unwrap();
            let mut zip = zip::ZipArchive::new(file).unwrap();
            let entry = zip.by_index(0).unwrap();
            assert!(
                entry.size() > entry.compressed_size().saturating_mul(250),
                "fixture must exceed the removed blanket 250:1 rejection"
            );
        }
        let report = ingest_path(&cache, &archive, "repetitive", None, "none").unwrap();
        assert_eq!(report.stats.lines, 1);
        assert_eq!(report.stats.files, 1);
    }

    #[test]
    fn actual_byte_growth_fails_atomically() {
        use std::sync::atomic::{AtomicBool, Ordering};

        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache");
        let logs = dir.path().join("logs");
        std::fs::create_dir_all(&logs).unwrap();
        let growing = logs.join("growing.log");
        std::fs::write(&growing, "level=info msg=ok\n").unwrap();

        struct GrowAfterScan {
            path: PathBuf,
            grown: AtomicBool,
        }
        impl ProcessProgressObserver for GrowAfterScan {
            fn progress(&self, update: ProcessProgress) {
                if update.message == "opening growing.log"
                    && !self.grown.swap(true, Ordering::SeqCst)
                {
                    let mut file = std::fs::OpenOptions::new()
                        .append(true)
                        .open(&self.path)
                        .unwrap();
                    file.write_all(&vec![b'x'; 256]).unwrap();
                    file.write_all(b"\n").unwrap();
                }
            }
        }
        let observer = GrowAfterScan {
            path: growing,
            grown: AtomicBool::new(false),
        };
        let limits = RawIngestLimits {
            max_file_bytes: 64,
            ..RawIngestLimits::default()
        };
        let error =
            ingest_with_limits(&cache, &logs, "growth", limits, &observer, None).unwrap_err();
        assert_atomic_failure(&cache, &error, "actual-byte limit");
    }

    #[test]
    fn production_line_bound_accepts_the_boundary_and_fails_atomically_above_it() {
        let mut reader = BufReader::with_capacity(
            64 * 1024,
            std::io::repeat(b'x').take(MAX_RAW_LOG_LINE_BYTES as u64),
        );
        let mut record = Vec::new();
        assert_eq!(
            read_bounded_line(
                &mut reader,
                &mut record,
                MAX_RAW_LOG_LINE_BYTES,
                None,
                &NoopProcessProgress,
                Path::new("line.log"),
            )
            .unwrap(),
            MAX_RAW_LOG_LINE_BYTES
        );
        assert_eq!(record.len(), MAX_RAW_LOG_LINE_BYTES);
        drop(record);

        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("line-cache");
        let long_line = dir.path().join("long.log");
        let mut file = std::fs::File::create(&long_line).unwrap();
        let chunk = [b'x'; 64 * 1024];
        for _ in 0..=(MAX_RAW_LOG_LINE_BYTES / chunk.len()) {
            file.write_all(&chunk).unwrap();
        }
        drop(file);
        let error = ingest_path(&cache, &long_line, "long-line", None, "none").unwrap_err();
        assert_atomic_failure(&cache, &error, "line-length limit");
    }

    #[test]
    fn ingest_fixture_multi_format_with_reduction() {
        let dir = tempfile::tempdir().unwrap();
        let logs = dir.path().join("logs");
        std::fs::create_dir_all(&logs).unwrap();
        let mut f = std::fs::File::create(logs.join("app.log")).unwrap();
        // multi-k lines with heavy repetition
        for i in 0..3000 {
            writeln!(
                f,
                r#"{{"ts":{},"level":"error","service":"api","message":"connection refused to upstream {}"}}"#,
                1_700_000_000 + i,
                i % 50
            )
            .unwrap();
            writeln!(
                f,
                "ts={} level=info service=api msg=GET /users/{} 200 {}ms",
                1_700_000_000 + i,
                8000 + (i % 100),
                10 + (i % 20)
            )
            .unwrap();
        }
        let backend = ConceptEmbedBackend::new(64);
        let report = ingest_path(dir.path(), &logs, "fixture", Some(&backend), "concept").unwrap();
        assert!(report.stats.lines >= 6000);
        assert!(report.stats.templates < report.stats.lines as usize / 10);
        assert!(report.stats.reduction_ratio > 10.0);
        assert!(report.stats.embedded > 0);
        // #359: unconfirmed cloud must not run (no backend required if policy fails first).
        let blocked = ingest_path_with_policy(
            dir.path(),
            &logs,
            "cloud-blocked",
            &crate::log_analysis::LogEmbedPolicy::cloud_opt_in("https://api.example.com", false),
            None,
        );
        assert!(blocked.is_err(), "unconfirmed cloud must fail before embed");

        eprintln!(
            "ingest_fixture lines={} templates={} ratio={:.1} embedded={}",
            report.stats.lines,
            report.stats.templates,
            report.stats.reduction_ratio,
            report.stats.embedded
        );
    }

    #[test]
    fn ingest_report_publishes_bounded_portable_source_confidence() {
        let dir = tempfile::tempdir().unwrap();
        let logs = dir.path().join("private-absolute-root");
        std::fs::create_dir_all(logs.join("nested")).unwrap();
        std::fs::write(
            logs.join("wall.jsonl"),
            concat!(
                "{\"ts\":\"2025-01-01T12:00:00Z\",\"message\":\"wall one\"}\n",
                "{\"ts\":\"2025-01-01T12:00:01+00:00\",\"message\":\"wall two\"}\n",
            ),
        )
        .unwrap();
        std::fs::write(
            logs.join("nested/server.log"),
            concat!(
                "Synthetic startup banner\n",
                "2021-03-05 02:53:53,654 ERROR [org.jboss] (worker) private payload one\n",
                "2021-03-05 02:53:54,654 ERROR [org.jboss] (worker) private payload two\n",
                "2021-03-05 02:53:55,654 ERROR [org.jboss] (worker) private payload three\n",
                "2021-03-05 02:53:56,654 ERROR [org.jboss] (worker) private payload four\n",
            ),
        )
        .unwrap();

        let cache = dir.path().join("cache");
        let report = ingest_path(&cache, &logs, "confidence", None, "none").unwrap();
        assert_eq!(report.confidence.corpus_time_quality, TimeQuality::Mixed);
        assert_eq!(report.confidence.counts.wall, 1);
        assert_eq!(report.confidence.counts.order_only, 1);
        assert_eq!(report.confidence.counts.matched, 2);
        assert_eq!(report.confidence.counts.unresolved, 1);
        assert_eq!(report.confidence.sources.len(), 2);

        let server = report
            .confidence
            .sources
            .iter()
            .find(|source| source.source == "nested/server.log")
            .unwrap();
        assert_eq!(server.lines, 5);
        assert_eq!(
            server.format_id.as_deref(),
            Some("date-level-logger-thread-record")
        );
        assert_eq!(server.format_version, Some(1));
        assert_eq!(server.outcome, IngestFormatOutcome::Matched);
        assert_eq!(server.time_quality, TimeQuality::OrderOnly);
        assert_eq!(
            server.unresolved_reasons,
            vec![UnresolvedTimeReason::NoTimezone]
        );
        assert_eq!(
            server.timestamp_prefix_samples.len(),
            MAX_TIMESTAMP_PREFIX_SAMPLES
        );

        let encoded = serde_json::to_string(&report.confidence).unwrap();
        assert!(!encoded.contains(dir.path().to_string_lossy().as_ref()));
        assert!(!encoded.contains("private payload"));
    }

    #[test]
    fn banner_then_structured_and_mixed_formats_are_record_scoped() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("mixed.jsonl");
        std::fs::write(
            &source,
            concat!(
                "Synthetic startup banner\n",
                "{\"ts\":1700000000,\"level\":\"error\",\"message\":\"json failure\"}\n",
                "ts=1700000001 level=warn msg=\"logfmt retry\"\n",
                "[2026-07-29 14:05:06,324][INFO][transport][node.example] bracketed event\n",
                "request text includes user=42 and retry=true as payload\n",
            ),
        )
        .unwrap();

        let cache = dir.path().join("cache");
        let report = ingest_path(&cache, &source, "mixed-records", None, "none").unwrap();
        assert_eq!(report.stats.lines, 5);
        assert_eq!(report.stats.format_counts.get("plain"), Some(&2));
        assert_eq!(report.stats.format_counts.get("json"), Some(&1));
        assert_eq!(report.stats.format_counts.get("logfmt"), Some(&1));
        assert_eq!(report.stats.format_counts.get("syslog"), Some(&1));

        let corpus = LogCorpus::open(&cache, &report.corpus_id).unwrap();
        let page = crate::log_analysis::query_events(
            &corpus,
            &crate::log_analysis::EventQuery {
                limit: 20,
                sort_by_time: false,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(page.events.len(), 5);
        assert_eq!(page.events[0].message, "Synthetic startup banner");
        assert_eq!(page.events[1].message, "json failure");
        assert_eq!(page.events[2].message, "logfmt retry");
        assert_eq!(page.events[3].message, "bracketed event");
        assert_eq!(
            page.events[4].message,
            "request text includes user=42 and retry=true as payload"
        );
    }

    #[test]
    fn cloud_policy_refuses_without_confirm() {
        use crate::log_analysis::LogEmbedPolicy;
        use std::sync::Arc;
        let dir = tempfile::tempdir().unwrap();
        let logs = dir.path().join("l");
        std::fs::create_dir_all(&logs).unwrap();
        std::fs::write(logs.join("a.log"), "error connection refused\n").unwrap();
        let policy = LogEmbedPolicy::cloud_opt_in("https://example.invalid", false);
        let backend: Arc<dyn EmbedBackend> = Arc::new(ConceptEmbedBackend::new(64));
        let err =
            ingest_path_with_policy(dir.path(), &logs, "c", &policy, Some(backend)).unwrap_err();
        assert!(format!("{err}").contains("leaves this machine"), "{err}");
    }

    #[test]
    fn ingest_zip_streams_members_without_full_extract() {
        use std::io::Write as _;
        let dir = tempfile::tempdir().unwrap();
        let zip_path = dir.path().join("bundle.zip");
        {
            let file = std::fs::File::create(&zip_path).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            let opts = zip::write::SimpleFileOptions::default();
            zip.start_file("nested/app.log", opts).unwrap();
            let mut body = String::new();
            for i in 0..80 {
                body.push_str(&format!(
                    "ts={} level=error service=api msg=connection refused {}\n",
                    1_700_000_000 + i,
                    i % 7
                ));
            }
            zip.write_all(body.as_bytes()).unwrap();
            zip.finish().unwrap();
        }
        let cache = dir.path().join("cache");
        std::fs::create_dir_all(&cache).unwrap();
        let report = ingest_path(&cache, &zip_path, "from-zip", None, "none").unwrap();
        assert!(report.stats.lines >= 80, "lines={}", report.stats.lines);
        assert!(!report.corpus_id.is_empty());
        // No full extract-to-temp: production uses ingest_from_zip
        let path =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/log_analysis/ingest.rs");
        let prod = std::fs::read_to_string(&path)
            .unwrap()
            .split("#[cfg(test)]")
            .next()
            .unwrap()
            .to_string();
        assert!(prod.contains("fn ingest_from_zip"));
        assert!(
            !prod.contains("tempfile::tempdir"),
            "must not full-extract zip to temp"
        );
    }

    #[test]
    fn ingest_zip_cancel_mid_member_stream() {
        use std::io::Write as _;
        let dir = tempfile::tempdir().unwrap();
        let zip_path = dir.path().join("many.zip");
        {
            let file = std::fs::File::create(&zip_path).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            let opts = zip::write::SimpleFileOptions::default();
            // Several members so cancel can fire between entries / during lines.
            for m in 0..8 {
                zip.start_file(format!("part{m}.log"), opts).unwrap();
                let mut body = String::new();
                for i in 0..8_000 {
                    body.push_str(&format!("info line {m}-{i}\n"));
                }
                zip.write_all(body.as_bytes()).unwrap();
            }
            zip.finish().unwrap();
        }
        let flag = CancelFlag::new();
        let flag2 = flag.clone();
        struct CancelAfterN {
            n: u64,
            flag: CancelFlag,
            rec: RecordingProcessProgress,
        }
        impl ProcessProgressObserver for CancelAfterN {
            fn progress(&self, update: ProcessProgress) {
                if update.lines_processed.unwrap_or(0) >= self.n
                    || update.files_processed.unwrap_or(0) >= 2
                {
                    self.flag.cancel();
                }
                self.rec.progress(update);
            }
        }
        let observer = CancelAfterN {
            n: 3_000,
            flag: flag2,
            rec: RecordingProcessProgress::default(),
        };
        let err = ingest_path_with_observer(
            dir.path(),
            &zip_path,
            "zip-cancel",
            None,
            "none",
            &observer,
            Some(&flag),
        )
        .unwrap_err();
        assert!(format!("{err}").contains("cancelled"), "{err}");
        let phases = observer.rec.phases();
        assert!(
            phases.contains(&ProcessProgressPhase::Cancelled),
            "phases={phases:?}"
        );
        let updates = observer.rec.updates.lock().unwrap();
        assert!(
            updates.iter().any(|u| u.message.contains("zip member")
                || u.message.contains("streaming")
                || u.files_processed.unwrap_or(0) > 0),
            "expected zip stream progress: {:?}",
            updates.iter().map(|u| &u.message).collect::<Vec<_>>()
        );
        drop(updates);
        assert!(LogCorpus::list_ids(dir.path()).unwrap().is_empty());
        assert_no_ingest_staging(dir.path());
    }

    #[test]
    fn nested_zip_cancellation_during_private_staging_is_atomic_and_cleans_up() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache");
        let outer = dir.path().join("outer.zip");
        let inner = zip_bytes(&[("app.log", &vec![b'a'; 256 * 1024])]);
        std::fs::write(&outer, zip_bytes(&[("host.zip", &inner)])).unwrap();

        struct CancelOnNestedStage {
            flag: CancelFlag,
            recorder: RecordingProcessProgress,
            diagnostic: FailedIngestDiagnosticRecorder,
        }
        impl ProcessProgressObserver for CancelOnNestedStage {
            fn progress(&self, update: ProcessProgress) {
                if update.message.starts_with("staging nested archive ") {
                    self.flag.cancel();
                }
                self.diagnostic.progress(update.clone());
                self.recorder.progress(update);
            }

            fn log_ingest_evidence(&self, evidence: LogIngestEvidence) {
                self.diagnostic.log_ingest_evidence(evidence);
            }
        }

        let flag = CancelFlag::new();
        let observer = CancelOnNestedStage {
            flag: flag.clone(),
            recorder: RecordingProcessProgress::default(),
            diagnostic: FailedIngestDiagnosticRecorder::default(),
        };
        let error = ingest_path_with_observer(
            &cache,
            &outer,
            "nested-cancel",
            None,
            "none",
            &observer,
            Some(&flag),
        )
        .unwrap_err();
        assert!(matches!(error, CoreError::Cancelled));
        assert_eq!(error.to_string(), "ingest cancelled");
        assert_eq!(
            observer.recorder.phases().last(),
            Some(&ProcessProgressPhase::Cancelled)
        );
        assert!(LogCorpus::list_ids(&cache).unwrap().is_empty());
        assert_no_ingest_staging(&cache);
        let diagnostic = finish_failed_evidence(&observer.diagnostic, &error, &outer);
        assert_eq!(
            diagnostic.reason_code,
            crate::log_analysis::FailedIngestReason::Cancelled
        );
        assert!(diagnostic.cancelled);
        assert_eq!(
            diagnostic.progress.last_phase,
            ProcessProgressPhase::Cancelled
        );
    }

    #[test]
    fn read_cancellation_is_canonical_and_emits_terminal_cancelled_progress() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache");
        let log = dir.path().join("cancel.log");
        std::fs::write(&log, "level=info msg=must-not-import\n").unwrap();
        let flag = CancelFlag::new();

        struct CancelOnOpen {
            flag: CancelFlag,
            rec: RecordingProcessProgress,
        }
        impl ProcessProgressObserver for CancelOnOpen {
            fn progress(&self, update: ProcessProgress) {
                if update.message.starts_with("opening ") {
                    self.flag.cancel();
                }
                self.rec.progress(update);
            }
        }

        let observer = CancelOnOpen {
            flag: flag.clone(),
            rec: RecordingProcessProgress::default(),
        };
        let error = ingest_path_with_observer(
            &cache,
            &log,
            "read-cancel",
            None,
            "none",
            &observer,
            Some(&flag),
        )
        .unwrap_err();
        assert!(matches!(error, CoreError::Cancelled));
        assert_eq!(error.to_string(), "ingest cancelled");
        let phases = observer.rec.phases();
        assert_eq!(phases.last(), Some(&ProcessProgressPhase::Cancelled));
        assert_no_ingest_staging(&cache);
        assert!(LogCorpus::list_ids(&cache).unwrap().is_empty());
    }

    #[test]
    fn ingest_failure_checkpoints_preserve_existing_corpus_set_and_tree() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache");
        let logs = dir.path().join("logs");
        std::fs::create_dir_all(&logs).unwrap();
        std::fs::write(
            logs.join("app.log"),
            "ts=1700000000 level=error msg=connection refused\n",
        )
        .unwrap();

        let baseline = ingest_path(&cache, &logs, "baseline", None, "none").unwrap();
        let baseline_ids = LogCorpus::list_ids(&cache).unwrap();
        assert_eq!(baseline_ids, vec![baseline.corpus_id]);
        let baseline_tree = cache_tree_paths(&cache);
        let backend = ConceptEmbedBackend::new(16);

        for checkpoint in [
            IngestCheckpoint::CorpusCreated,
            IngestCheckpoint::EventsStored,
            IngestCheckpoint::BeforeTemplates,
            IngestCheckpoint::DuringEmbedding,
            IngestCheckpoint::BeforeSummary,
            IngestCheckpoint::BeforeValidation,
            IngestCheckpoint::BeforePublish,
        ] {
            let hook = |actual| {
                if actual == checkpoint {
                    Err(CoreError::Message(format!(
                        "injected ingest failure at {checkpoint:?}"
                    )))
                } else {
                    Ok(())
                }
            };
            let err = ingest_path_inner_with_fault(
                &cache,
                &logs,
                "must-not-publish",
                Some(&backend),
                "concept",
                LogEmbedMode::Local,
                None,
                &NoopProcessProgress,
                None,
                None,
                Some(&hook),
            )
            .unwrap_err();
            assert!(
                format!("{err}").contains("injected ingest failure"),
                "{checkpoint:?}: {err}"
            );
            assert_eq!(
                LogCorpus::list_ids(&cache).unwrap(),
                baseline_ids,
                "published a failed corpus at {checkpoint:?}"
            );
            assert_no_ingest_staging(&cache);
            assert_eq!(
                cache_tree_paths(&cache),
                baseline_tree,
                "cache tree changed at {checkpoint:?}"
            );
        }
    }

    #[test]
    fn cancellation_after_validation_before_publish_is_typed_and_atomic() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache");
        let logs = dir.path().join("logs");
        std::fs::create_dir_all(&logs).unwrap();
        std::fs::write(
            logs.join("app.log"),
            "ts=1700000000 level=error msg=must-not-publish\n",
        )
        .unwrap();
        let cancel = CancelFlag::new();
        let observer = RecordingProcessProgress::default();
        let hook = |checkpoint| {
            if checkpoint == IngestCheckpoint::BeforePublish {
                cancel.cancel();
            }
            Ok(())
        };

        let error = ingest_path_inner_with_fault(
            &cache,
            &logs,
            "cancel-before-publish",
            None,
            "none",
            LogEmbedMode::None,
            None,
            &observer,
            Some(&cancel),
            None,
            Some(&hook),
        )
        .unwrap_err();

        assert!(matches!(error, CoreError::Cancelled));
        assert_eq!(error.to_string(), "ingest cancelled");
        assert_eq!(
            observer.phases().last(),
            Some(&ProcessProgressPhase::Cancelled)
        );
        assert!(LogCorpus::list_ids(&cache).unwrap().is_empty());
        assert_no_ingest_staging(&cache);
    }

    #[test]
    fn malformed_zip_failure_leaves_no_partial_corpus_or_staging() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache");
        let zip_path = dir.path().join("broken.zip");
        std::fs::write(&zip_path, b"not a zip archive").unwrap();

        let err = ingest_path(&cache, &zip_path, "broken", None, "none").unwrap_err();
        assert!(format!("{err}").contains("zip open"), "{err}");
        assert!(LogCorpus::list_ids(&cache).unwrap().is_empty());
        assert_no_ingest_staging(&cache);
    }

    #[test]
    fn successful_ingest_publishes_one_validated_corpus_and_no_staging() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache");
        let logs = dir.path().join("logs");
        std::fs::create_dir_all(&logs).unwrap();
        std::fs::write(logs.join("app.log"), "error connection refused\n").unwrap();

        let report = ingest_path(&cache, &logs, "published", None, "none").unwrap();
        assert_eq!(
            LogCorpus::list_ids(&cache).unwrap(),
            vec![report.corpus_id.clone()]
        );
        let reopened = LogCorpus::open(&cache, &report.corpus_id).unwrap();
        assert_eq!(reopened.event_count() as u64, report.stats.lines);
        assert_eq!(reopened.template_count(), report.stats.templates);
        assert_no_ingest_staging(&cache);
    }

    #[test]
    fn published_ingest_remains_successful_when_private_cleanup_is_deferred() {
        let cleanup_error = CoreError::Message("injected cleanup failure".into());
        let (value, cleanup_deferred) =
            reconcile_ingest_cleanup::<u8>(Ok(7), Err(cleanup_error)).unwrap();

        assert_eq!(value, 7);
        assert!(cleanup_deferred);

        let ingest_error = CoreError::Message("injected ingest failure".into());
        let cleanup_error = CoreError::Message("injected cleanup failure".into());
        let error =
            reconcile_ingest_cleanup::<u8>(Err(ingest_error), Err(cleanup_error)).unwrap_err();
        assert_eq!(
            error.to_string(),
            "injected ingest failure; private ingest staging cleanup also failed: injected cleanup failure"
        );
    }

    #[test]
    fn checked_staging_cleanup_removes_own_tree_and_preserves_concurrent_sibling() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache");
        let mut staging = IngestStaging::new(&cache).unwrap();
        std::fs::create_dir_all(staging.root.join("nested")).unwrap();
        std::fs::write(staging.root.join("nested/private.bin"), b"private").unwrap();
        let sibling = staging.parent.join(Uuid::now_v7().to_string());
        std::fs::create_dir(&sibling).unwrap();

        staging.cleanup_checked().unwrap();

        assert!(!staging.root.exists());
        assert!(sibling.is_dir());
        assert!(staging.parent.is_dir());
        std::fs::remove_dir(&sibling).unwrap();
        std::fs::remove_dir(&staging.parent).unwrap();
    }

    #[test]
    fn abandoned_staging_cleanup_is_age_gated_owned_and_bounded() {
        let dir = tempfile::tempdir().unwrap();
        let parent = dir.path().join(".log_ingest_staging");
        std::fs::create_dir(&parent).unwrap();
        let now = 2_000_000_000u64;
        let old_seconds = now - ABANDONED_STAGING_AGE_SECS - 1;
        let fresh_seconds = now - ABANDONED_STAGING_AGE_SECS + 1;
        let old =
            uuid::Builder::from_unix_timestamp_millis(old_seconds * 1_000, &[1u8; 10]).into_uuid();
        let fresh = uuid::Builder::from_unix_timestamp_millis(fresh_seconds * 1_000, &[2u8; 10])
            .into_uuid();
        let old_path = parent.join(old.to_string());
        let fresh_path = parent.join(fresh.to_string());
        let unrelated = parent.join("not-owned-by-ingest");
        std::fs::create_dir(&old_path).unwrap();
        std::fs::write(old_path.join("private.bin"), b"private").unwrap();
        std::fs::create_dir(&fresh_path).unwrap();
        std::fs::create_dir(&unrelated).unwrap();

        assert_eq!(cleanup_abandoned_staging_at(&parent, now), 1);
        assert!(!old_path.exists());
        assert!(fresh_path.is_dir());
        assert!(unrelated.is_dir());

        for salt in 10..10 + MAX_ABANDONED_STAGING_REMOVALS + 3 {
            let id =
                uuid::Builder::from_unix_timestamp_millis(old_seconds * 1_000, &[salt as u8; 10])
                    .into_uuid();
            std::fs::create_dir(parent.join(id.to_string())).unwrap();
        }
        assert_eq!(
            cleanup_abandoned_staging_at(&parent, now),
            MAX_ABANDONED_STAGING_REMOVALS
        );
        let remaining_owned = std::fs::read_dir(&parent)
            .unwrap()
            .flatten()
            .filter(|entry| {
                entry
                    .file_name()
                    .to_str()
                    .is_some_and(|name| Uuid::parse_str(name).is_ok())
            })
            .count();
        assert!(remaining_owned >= 4);
    }

    #[test]
    fn content_hash_cache_skips_reembed_of_same_pattern() {
        // Two identical patterns in miner collapse to one template → one embed call path.
        let dir = tempfile::tempdir().unwrap();
        let logs = dir.path().join("logs");
        std::fs::create_dir_all(&logs).unwrap();
        let mut f = std::fs::File::create(logs.join("x.log")).unwrap();
        for i in 0..20 {
            writeln!(f, "connection refused to upstream host-{i}").unwrap();
        }
        let backend = ConceptEmbedBackend::new(64);
        let report = ingest_path(dir.path(), &logs, "h", Some(&backend), "concept").unwrap();
        assert_eq!(
            report.stats.embedded, report.stats.templates,
            "one embed per distinct template (content-hash keyed)"
        );
        assert!(report.stats.templates < 5);
    }

    #[test]
    fn parse_file_fraction_requires_a_real_total_and_stays_bounded() {
        assert_eq!(parse_file_fraction(0, 0), None);
        assert_eq!(parse_file_fraction(0, 2), Some(0.0));
        assert_eq!(parse_file_fraction(1, 2), Some(0.5));
        assert_eq!(parse_file_fraction(2, 2), Some(1.0));
        assert_eq!(parse_file_fraction(3, 2), Some(1.0));
        assert_eq!(parse_file_fraction(u64::MAX, u64::MAX), Some(1.0));
    }

    #[test]
    fn log_ingest_non_stream_phases_discard_fractions() {
        let recorder = RecordingProcessProgress::default();
        let phases = [
            ProcessProgressPhase::Starting,
            ProcessProgressPhase::Scan,
            ProcessProgressPhase::Embed,
            ProcessProgressPhase::Validate,
            ProcessProgressPhase::Publish,
            ProcessProgressPhase::Completed,
            ProcessProgressPhase::Cancelled,
            ProcessProgressPhase::Failed,
        ];
        for phase in phases {
            emit(
                &recorder,
                ProcessProgress::phase(ProcessProgressKind::LogIngest, phase, "test", false)
                    .with_fraction(0.5),
            );
        }

        let updates = recorder.updates.lock().unwrap();
        assert_eq!(updates.len(), phases.len());
        assert!(
            updates.iter().all(|update| update.fraction.is_none()),
            "non-stream phases must remain indeterminate: {updates:?}"
        );
    }

    #[test]
    fn log_ingest_reports_fraction_only_for_parse_file_progress() {
        let dir = tempfile::tempdir().unwrap();
        let logs = dir.path().join("logs");
        std::fs::create_dir_all(&logs).unwrap();
        std::fs::write(logs.join("a.log"), "level=info msg=started\n").unwrap();
        std::fs::write(logs.join("b.log"), "level=error msg=failed\n").unwrap();
        let recorder = RecordingProcessProgress::default();

        ingest_path_with_observer(
            dir.path(),
            &logs,
            "truthful-progress",
            None,
            "none",
            &recorder,
            None,
        )
        .unwrap();

        let updates = recorder.updates.lock().unwrap();
        let parse_fractions: Vec<f32> = updates
            .iter()
            .filter(|update| update.phase == ProcessProgressPhase::Stream)
            .filter_map(|update| update.fraction)
            .collect();
        assert!(!parse_fractions.is_empty(), "updates={updates:?}");
        assert!(
            parse_fractions
                .iter()
                .all(|fraction| fraction.is_finite() && (0.0..=1.0).contains(fraction)),
            "parse fractions must be finite and bounded: {parse_fractions:?}"
        );
        assert!(
            parse_fractions.contains(&0.0)
                && parse_fractions.contains(&0.5)
                && parse_fractions.contains(&1.0),
            "expected completed_files / total_files progress: {parse_fractions:?}"
        );
        assert!(
            updates
                .iter()
                .filter(|update| update.phase != ProcessProgressPhase::Stream)
                .all(|update| update.fraction.is_none()),
            "non-Parse phases must remain indeterminate: {updates:?}"
        );
    }

    #[test]
    fn ingest_emits_multi_phase_progress_sequence() {
        let dir = tempfile::tempdir().unwrap();
        let logs = dir.path().join("logs");
        std::fs::create_dir_all(&logs).unwrap();
        let mut f = std::fs::File::create(logs.join("app.log")).unwrap();
        for i in 0..80 {
            writeln!(f, "error connection refused host-{i}").unwrap();
        }
        let backend = ConceptEmbedBackend::new(32);
        let recorder = RecordingProcessProgress::default();
        let report = ingest_path_with_observer(
            dir.path(),
            &logs,
            "progress-fixture",
            Some(&backend),
            "concept",
            &recorder,
            None,
        )
        .unwrap();
        assert!(report.stats.lines >= 80);
        let phases = recorder.phases();
        assert!(
            phases.contains(&ProcessProgressPhase::Starting),
            "phases={phases:?}"
        );
        assert!(
            phases.contains(&ProcessProgressPhase::Scan),
            "phases={phases:?}"
        );
        assert!(
            phases.contains(&ProcessProgressPhase::Stream),
            "streaming phase required (no bookend rewind): {phases:?}"
        );
        // Monotonic chrome: no Template/Redact/Store bookends after Stream.
        assert!(
            !phases.contains(&ProcessProgressPhase::Template)
                && !phases.contains(&ProcessProgressPhase::Redact)
                && !phases.contains(&ProcessProgressPhase::Store),
            "must not emit rewinding bookend phases: {phases:?}"
        );
        assert!(
            phases.contains(&ProcessProgressPhase::Embed),
            "phases={phases:?}"
        );
        assert!(
            phases.contains(&ProcessProgressPhase::Validate),
            "phases={phases:?}"
        );
        assert!(
            phases.contains(&ProcessProgressPhase::Publish),
            "publish phase required for atomic library handoff (#824): {phases:?}"
        );
        assert_eq!(
            phases.last().copied(),
            Some(ProcessProgressPhase::Completed)
        );
        let updates = recorder.updates.lock().unwrap();
        let completed = updates.last().expect("completed progress update");
        assert!(
            completed.message.contains("avg. events/template"),
            "{}",
            completed.message
        );
        assert!(
            completed.message.contains(" ms"),
            "completion must report wall-clock total (#824): {}",
            completed.message
        );
        assert!(
            !completed.message.contains("reduction"),
            "{}",
            completed.message
        );
        // No home-style absolute paths in messages
        for u in updates.iter() {
            assert!(
                !u.message.contains("/Users/"),
                "leaked path in message: {}",
                u.message
            );
            assert!(
                !u.message.contains("secret"),
                "unexpected secret token: {}",
                u.message
            );
            assert!(
                u.elapsed_ms.is_some(),
                "every progress update must carry elapsed_ms (#824): {u:?}"
            );
        }
        // Elapsed is monotonic non-decreasing across the operation.
        let elapsed: Vec<u64> = updates.iter().filter_map(|u| u.elapsed_ms).collect();
        assert!(
            elapsed.windows(2).all(|w| w[0] <= w[1]),
            "elapsed={elapsed:?}"
        );
        assert!(
            report.phase_timings.total_ms > 0,
            "phase timings must be instrumented: {:?}",
            report.phase_timings
        );
        assert!(
            report.phase_timings.publication_ms > 0
                || report.phase_timings.persist_index_ms > 0
                || report.phase_timings.parse_frame_ms > 0,
            "at least one working phase must accumulate wall time: {:?}",
            report.phase_timings
        );
        assert!(!report.phase_timings.embedding_deferred);
    }

    /// #824 — optional embedding deferred past first use is disclosed, not claimed complete.
    #[test]
    fn ingest_defers_embedding_and_discloses_in_progress_and_timings() {
        use crate::log_analysis::LogEmbedPolicy;
        let dir = tempfile::tempdir().unwrap();
        let logs = dir.path().join("logs");
        std::fs::create_dir_all(&logs).unwrap();
        let mut f = std::fs::File::create(logs.join("app.log")).unwrap();
        for i in 0..40 {
            writeln!(f, "info event-{i} payload").unwrap();
        }
        let backend = ConceptEmbedBackend::new(32);
        let mut policy = LogEmbedPolicy::local_default();
        policy.defer_above_source_bytes = Some(1);
        let recorder = RecordingProcessProgress::default();
        let report = ingest_path_with_policy_and_observer(
            dir.path(),
            &logs,
            "defer-embed",
            &policy,
            Some(std::sync::Arc::new(backend)),
            &recorder,
            None,
        )
        .unwrap();
        assert_eq!(report.embedding.state, EmbeddingState::Deferred);
        assert!(report.phase_timings.embedding_deferred);
        assert_eq!(
            report.phase_timings.optional_embedding_ms, 0,
            "deferred embed must not burn wall time as if it ran"
        );
        {
            let updates = recorder.updates.lock().unwrap();
            let completed = updates.last().expect("completed");
            assert!(
                completed.message.contains("deferred") || completed.message.contains("first use"),
                "must disclose deferred optional work: {}",
                completed.message
            );
        }
        let phases = recorder.phases();
        assert!(
            !phases.contains(&ProcessProgressPhase::Embed),
            "optional embed phase must not appear when deferred: {phases:?}"
        );
        assert!(
            phases.contains(&ProcessProgressPhase::Publish),
            "publication still required when embed deferred"
        );
        // Keyword/structured first use: corpus is listed and queryable.
        assert!(!LogCorpus::list_ids(dir.path()).unwrap().is_empty());
        let corpus = LogCorpus::open(dir.path(), &report.corpus_id).unwrap();
        assert!(corpus.event_count() >= 40);
    }

    /// #824 — cancel before publish leaves no library entry (atomicity).
    #[test]
    fn ingest_cancel_during_parse_does_not_publish() {
        let dir = tempfile::tempdir().unwrap();
        let logs = dir.path().join("logs");
        std::fs::create_dir_all(&logs).unwrap();
        let mut f = std::fs::File::create(logs.join("bulk.log")).unwrap();
        for i in 0..8_000 {
            writeln!(f, "warn bulk line {i} padding-padding").unwrap();
        }
        let flag = CancelFlag::new();
        struct CancelMidParse {
            flag: CancelFlag,
            rec: RecordingProcessProgress,
        }
        impl ProcessProgressObserver for CancelMidParse {
            fn progress(&self, update: ProcessProgress) {
                if update.phase == ProcessProgressPhase::Stream
                    && update.lines_processed.unwrap_or(0) >= 2_000
                {
                    self.flag.cancel();
                }
                self.rec.progress(update);
            }
        }
        let observer = CancelMidParse {
            flag: flag.clone(),
            rec: RecordingProcessProgress::default(),
        };
        let err = ingest_path_with_observer(
            dir.path(),
            &logs,
            "cancel-mid-parse",
            None,
            "none",
            &observer,
            Some(&flag),
        )
        .unwrap_err();
        assert!(format!("{err}").contains("cancelled"), "{err}");
        assert!(LogCorpus::list_ids(dir.path()).unwrap().is_empty());
        assert_no_ingest_staging(dir.path());
        assert!(observer
            .rec
            .phases()
            .contains(&ProcessProgressPhase::Cancelled));
        assert!(
            !observer
                .rec
                .phases()
                .contains(&ProcessProgressPhase::Publish),
            "must not reach publish after cancel"
        );
    }

    /// #824 — real ingest on a blocking pool must not starve async heartbeat/cancel.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn spawn_blocking_ingest_allows_async_heartbeat_and_cancel() {
        use std::sync::atomic::{AtomicU64, Ordering};
        let dir = tempfile::tempdir().unwrap();
        let logs = dir.path().join("logs");
        std::fs::create_dir_all(&logs).unwrap();
        let mut f = std::fs::File::create(logs.join("bulk.log")).unwrap();
        for i in 0..20_000 {
            writeln!(f, "warn bulk line {i} padding-padding-padding").unwrap();
        }
        drop(f);

        let flag = CancelFlag::new();
        let flag_job = flag.clone();
        let heartbeat = Arc::new(AtomicU64::new(0));
        let heartbeat_tick = Arc::clone(&heartbeat);
        let cache = dir.path().join("cache");
        std::fs::create_dir_all(&cache).unwrap();
        let cache_for_job = cache.clone();

        // Async task: must keep progressing while blocking ingest runs.
        let hb = tokio::spawn(async move {
            for _ in 0..200 {
                heartbeat_tick.fetch_add(1, Ordering::SeqCst);
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
        });

        let cancel_watcher = flag.clone();
        let cancel_task = tokio::spawn(async move {
            // Give ingest a moment to enter streaming work, then cancel.
            tokio::time::sleep(std::time::Duration::from_millis(40)).await;
            cancel_watcher.cancel();
        });

        let logs_path = logs.clone();
        let job = tokio::task::spawn_blocking(move || {
            ingest_path_with_observer(
                &cache_for_job,
                &logs_path,
                "off-loop",
                None,
                "none",
                &RecordingProcessProgress::default(),
                Some(&flag_job),
            )
        });

        let result = job.await.expect("join spawn_blocking");
        let _ = cancel_task.await;
        let _ = hb.await;
        let ticks = heartbeat.load(Ordering::SeqCst);
        assert!(
            ticks >= 3,
            "async heartbeat must advance during blocking ingest (ticks={ticks})"
        );
        assert!(
            result.is_err(),
            "cancel should terminate ingest: {result:?}"
        );
        let err = result.unwrap_err();
        assert!(
            format!("{err}").to_lowercase().contains("cancel"),
            "expected cancel error, got {err}"
        );
        assert!(
            LogCorpus::list_ids(&cache).unwrap().is_empty(),
            "cancel must not publish"
        );
        // Source evidence unchanged.
        let source = std::fs::read_to_string(logs.join("bulk.log")).unwrap();
        assert!(source.contains("warn bulk line 0"));
        assert!(source.lines().count() >= 20_000);
    }

    /// #824 — cancel mid-parse leaves a clean library; the same path can SoftWrite again.
    #[test]
    fn ingest_cancel_then_retry_succeeds_with_publish() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache");
        let logs = dir.path().join("logs");
        std::fs::create_dir_all(&logs).unwrap();
        let mut f = std::fs::File::create(logs.join("bulk.log")).unwrap();
        for i in 0..6_000 {
            writeln!(f, "warn bulk line {i} padding-padding").unwrap();
        }
        drop(f);

        let flag = CancelFlag::new();
        struct CancelMidParse {
            flag: CancelFlag,
            rec: RecordingProcessProgress,
        }
        impl ProcessProgressObserver for CancelMidParse {
            fn progress(&self, update: ProcessProgress) {
                if update.phase == ProcessProgressPhase::Stream
                    && update.lines_processed.unwrap_or(0) >= 1_500
                {
                    self.flag.cancel();
                }
                self.rec.progress(update);
            }
        }
        let cancel_obs = CancelMidParse {
            flag: flag.clone(),
            rec: RecordingProcessProgress::default(),
        };
        let err = ingest_path_with_observer(
            &cache,
            &logs,
            "cancel-then-retry",
            None,
            "none",
            &cancel_obs,
            Some(&flag),
        )
        .unwrap_err();
        assert!(format!("{err}").contains("cancelled"), "{err}");
        assert!(
            LogCorpus::list_ids(&cache).unwrap().is_empty(),
            "cancel must not publish a partial corpus"
        );
        assert_no_ingest_staging(&cache);

        // Retry the same SoftWrite path without cancel — must publish cleanly.
        let retry_rec = RecordingProcessProgress::default();
        let report = ingest_path_with_observer(
            &cache,
            &logs,
            "cancel-then-retry",
            None,
            "none",
            &retry_rec,
            None,
        )
        .unwrap();
        assert_eq!(report.stats.lines, 6_000);
        assert!(
            retry_rec.phases().contains(&ProcessProgressPhase::Publish),
            "retry must reach atomic publication: {:?}",
            retry_rec.phases()
        );
        assert_eq!(
            retry_rec.phases().last().copied(),
            Some(ProcessProgressPhase::Completed)
        );
        let ids = LogCorpus::list_ids(&cache).unwrap();
        assert_eq!(ids, vec![report.corpus_id.clone()]);
        let corpus = LogCorpus::open(&cache, &report.corpus_id).unwrap();
        assert_eq!(corpus.event_count() as u64, 6_000);
        assert_no_ingest_staging(&cache);
    }

    /// #824 — operation-scoped subtotals must not exceed wall time (non-overlapping).
    #[test]
    fn operation_timers_subtotals_bounded_by_wall_time() {
        let dir = tempfile::tempdir().unwrap();
        let logs = dir.path().join("logs");
        std::fs::create_dir_all(&logs).unwrap();
        let mut f = std::fs::File::create(logs.join("ops.log")).unwrap();
        for i in 0..4_000 {
            match i % 5 {
                0 => writeln!(f, "ERROR connection refused host-{i}").unwrap(),
                1 => writeln!(f, "WARN retry timeout attempt={}", i % 3).unwrap(),
                _ => writeln!(f, "INFO request completed id={i}").unwrap(),
            }
        }
        drop(f);
        let recorder = RecordingProcessProgress::default();
        let wall_start = std::time::Instant::now();
        let report = ingest_path_with_observer(
            dir.path(),
            &logs,
            "op-timers",
            None,
            "none",
            &recorder,
            None,
        )
        .unwrap();
        let wall_ms = wall_start.elapsed().as_millis() as u64;
        let t = &report.phase_timings;
        let sub = t.working_subtotal_ms();
        assert!(t.total_ms > 0, "total wall must be instrumented: {t:?}");
        // Non-overlapping working subtotals are bounded by instrumented total and wall.
        assert!(
            sub <= t.total_ms.saturating_add(50),
            "working subtotal {sub} must be ≤ total {} (+slack): {t:?}",
            t.total_ms
        );
        assert!(
            sub <= wall_ms.saturating_add(2_000),
            "working subtotal {sub} must be ≤ wall {wall_ms} (+slack): {t:?}"
        );
        assert!(
            t.parse_frame_ms > 0 || t.template_analysis_ms > 0 || t.persist_index_ms > 0,
            "at least one streaming operation must accumulate: {t:?}"
        );
        assert!(
            t.publication_ms > 0 || t.validation_ms > 0,
            "validate/publish must accumulate: {t:?}"
        );
        // Progress never rewinds through bookend phases.
        let phases = recorder.phases();
        let stream_idxs: Vec<_> = phases
            .iter()
            .enumerate()
            .filter(|(_, p)| **p == ProcessProgressPhase::Stream)
            .map(|(i, _)| i)
            .collect();
        assert!(!stream_idxs.is_empty(), "must emit Stream: {phases:?}");
        let first_stream = stream_idxs[0];
        for (i, p) in phases.iter().enumerate() {
            if i > first_stream {
                assert!(
                    !matches!(
                        p,
                        ProcessProgressPhase::Parse
                            | ProcessProgressPhase::Template
                            | ProcessProgressPhase::Redact
                            | ProcessProgressPhase::Store
                    ),
                    "bookend phase {p:?} after Stream rewinds chrome at index {i}: {phases:?}"
                );
            }
        }
        eprintln!(
            "PASS op-timers accounting: wall_ms={wall_ms} total_ms={} subtotal_ms={sub} read={} parse={} template={} persist={} embed={} validate={} publish={}",
            t.total_ms,
            t.discover_read_ms,
            t.parse_frame_ms,
            t.template_analysis_ms,
            t.persist_index_ms,
            t.optional_embedding_ms,
            t.validation_ms,
            t.publication_ms
        );
    }

    /// #824 — product-path scale envelopes live in Log Lab (`log_lab.rs`):
    /// pinned seven-day 25k, ui-medium 100k, triage-stress 250k under
    /// `LogEmbedPolicy::local_default`. Synthetic one-file substitute corpora
    /// were removed so scale evidence cannot drift from product paths.

    #[test]
    fn ingest_cancel_before_work_reports_cancelled() {
        let dir = tempfile::tempdir().unwrap();
        let logs = dir.path().join("logs");
        std::fs::create_dir_all(&logs).unwrap();
        std::fs::write(logs.join("a.log"), "error x\n").unwrap();
        let recorder = RecordingProcessProgress::default();
        let flag = CancelFlag::new();
        flag.cancel();
        let err = ingest_path_with_observer(
            dir.path(),
            &logs,
            "cancel-me",
            None,
            "concept",
            &recorder,
            Some(&flag),
        )
        .unwrap_err();
        assert!(format!("{err}").contains("cancelled"), "{err}");
        assert!(recorder.phases().contains(&ProcessProgressPhase::Cancelled));
        assert!(LogCorpus::list_ids(dir.path()).unwrap().is_empty());
        assert_no_ingest_staging(dir.path());
    }

    #[test]
    fn zip_path_streams_members_not_full_extract() {
        let path =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/log_analysis/ingest.rs");
        let full = std::fs::read_to_string(&path).expect("read ingest.rs");
        let prod = full.split("#[cfg(test)]").next().expect("prod section");
        assert!(
            prod.contains("fn ingest_from_zip"),
            "zip stream path required"
        );
        assert!(
            !prod.contains("tempfile::tempdir"),
            "must not full-extract zip to temp before parse"
        );
        assert!(
            !prod.contains("read_to_string(file)"),
            "ingest must not read_to_string whole log members"
        );
        assert!(
            prod.contains("BufReader") || prod.contains("BufRead"),
            "must use line streaming"
        );
    }

    #[test]
    fn ingest_cancel_mid_stream_stops() {
        let dir = tempfile::tempdir().unwrap();
        let logs = dir.path().join("logs");
        std::fs::create_dir_all(&logs).unwrap();
        let mut f = std::fs::File::create(logs.join("big.log")).unwrap();
        for i in 0..50_000 {
            writeln!(f, "ts={} level=info msg=line {i}", 1_700_000_000 + i).unwrap();
        }
        let flag = CancelFlag::new();
        let flag2 = flag.clone();
        // Cancel after a short delay from another "thread" simulation: cancel
        // before call after first check would need async — cancel at start of
        // second file by pre-cancelling after scanning? Use a custom approach:
        // cancel immediately after Starting by racing — simplest: cancel mid-way
        // via a second observer that cancels when lines exceed a threshold.
        struct CancelAfterN {
            n: u64,
            flag: CancelFlag,
            rec: RecordingProcessProgress,
        }
        impl ProcessProgressObserver for CancelAfterN {
            fn progress(&self, update: ProcessProgress) {
                if update.lines_processed.unwrap_or(0) >= self.n {
                    self.flag.cancel();
                }
                self.rec.progress(update);
            }
        }
        let rec = RecordingProcessProgress::default();
        let observer = CancelAfterN {
            n: 4_000,
            flag: flag2,
            rec,
        };
        let err = ingest_path_with_observer(
            dir.path(),
            &logs,
            "mid-cancel",
            None,
            "none",
            &observer,
            Some(&flag),
        )
        .unwrap_err();
        assert!(format!("{err}").contains("cancelled"), "{err}");
        assert!(LogCorpus::list_ids(dir.path()).unwrap().is_empty());
        assert_no_ingest_staging(dir.path());
    }

    #[test]
    fn bulk_softwrite_no_embed_when_backend_none() {
        let dir = tempfile::tempdir().unwrap();
        let logs = dir.path().join("logs");
        std::fs::create_dir_all(&logs).unwrap();
        let mut f = std::fs::File::create(logs.join("a.log")).unwrap();
        for i in 0..100 {
            writeln!(f, "error connection refused {i}").unwrap();
        }
        let report = ingest_path(dir.path(), &logs, "no-embed", None, "none").unwrap();
        assert_eq!(report.stats.embedded, 0);
        assert!(report.stats.lines >= 100);
    }

    #[test]
    fn local_policy_embeds_ordinary_input_and_defers_above_exact_byte_threshold() {
        let dir = tempfile::tempdir().unwrap();
        let logs = dir.path().join("app.log");
        std::fs::write(&logs, "ts=1700000000 level=error msg=connection refused\n").unwrap();
        let backend: Arc<dyn EmbedBackend> = Arc::new(ConceptEmbedBackend::new(32));

        let mut ordinary = LogEmbedPolicy::local_default();
        ordinary.model_id = "concept-local".into();
        ordinary.defer_above_source_bytes = Some(u64::MAX);
        let embedded = ingest_path_with_policy(
            dir.path(),
            &logs,
            "ordinary",
            &ordinary,
            Some(backend.clone()),
        )
        .unwrap();
        assert!(embedded.stats.embedded > 0);
        assert_eq!(embedded.embedding.state, EmbeddingState::Complete);
        assert_eq!(
            embedded.embedding.model_id.as_deref(),
            Some("concept-local")
        );

        let mut bulk = ordinary;
        bulk.defer_above_source_bytes = Some(1);
        let deferred =
            ingest_path_with_policy(dir.path(), &logs, "bulk", &bulk, Some(backend)).unwrap();
        assert_eq!(deferred.stats.embedded, 0);
        assert_eq!(deferred.embedding.state, EmbeddingState::Deferred);
        assert_eq!(
            LogCorpus::open(dir.path(), &deferred.corpus_id)
                .unwrap()
                .embedding_status(),
            deferred.embedding
        );
    }

    #[test]
    fn progress_includes_line_byte_advances_on_large_file() {
        let dir = tempfile::tempdir().unwrap();
        let logs = dir.path().join("logs");
        std::fs::create_dir_all(&logs).unwrap();
        let mut f = std::fs::File::create(logs.join("huge.log")).unwrap();
        // > PROGRESS_EVERY_LINES so we get mid-file parse updates
        for i in 0..(PROGRESS_EVERY_LINES as usize * 3 + 10) {
            writeln!(f, "info line number {i} padding padding").unwrap();
        }
        let recorder = RecordingProcessProgress::default();
        let report = ingest_path_with_observer(
            dir.path(),
            &logs,
            "prog-lines",
            None,
            "none",
            &recorder,
            None,
        )
        .unwrap();
        assert!(report.stats.lines > PROGRESS_EVERY_LINES);
        let updates = recorder.updates.lock().unwrap();
        let with_lines: Vec<_> = updates
            .iter()
            .filter(|u| u.lines_processed.unwrap_or(0) >= PROGRESS_EVERY_LINES)
            .collect();
        assert!(
            with_lines.len() >= 2,
            "expected multiple line-progress updates, got {}",
            with_lines.len()
        );
        assert!(
            updates.iter().any(|u| u.bytes_processed.unwrap_or(0) > 0),
            "expected bytes_processed on some updates"
        );
    }

    #[test]
    fn directory_reporting_separates_imported_excluded_failed_and_ignored() {
        use std::sync::atomic::{AtomicBool, Ordering};

        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache");
        let logs = dir.path().join("logs");
        std::fs::create_dir_all(&logs).unwrap();
        let safe = b"level=info msg=started\nlevel=error msg=Bearer test-secret-token\n";
        std::fs::write(logs.join("safe.log"), safe).unwrap();
        std::fs::write(logs.join("binary.log"), b"prefix\0binary").unwrap();
        std::fs::write(logs.join(".hidden.log"), b"must be ignored\n").unwrap();
        std::fs::write(logs.join("vanish.log"), b"unreadable after scan\n").unwrap();
        let oversized = std::fs::File::create(logs.join("oversized.log")).unwrap();
        oversized.set_len(DEFAULT_MAX_FILE_BYTES + 1).unwrap();

        struct RemoveAfterScan {
            path: PathBuf,
            removed: AtomicBool,
            recorder: RecordingProcessProgress,
        }
        impl ProcessProgressObserver for RemoveAfterScan {
            fn progress(&self, update: ProcessProgress) {
                if update.message.starts_with("found ")
                    && !self.removed.swap(true, Ordering::SeqCst)
                {
                    std::fs::remove_file(&self.path).unwrap();
                }
                self.recorder.progress(update);
            }
        }

        let observer = RemoveAfterScan {
            path: logs.join("vanish.log"),
            removed: AtomicBool::new(false),
            recorder: RecordingProcessProgress::default(),
        };
        let report = ingest_path_with_observer(
            &cache,
            &logs,
            "honest-directory",
            None,
            "none",
            &observer,
            None,
        )
        .unwrap();

        assert_eq!(report.stats.discovered_files, 5);
        assert_eq!(report.stats.files, 1);
        assert_eq!(report.stats.excluded_files, 2);
        assert_eq!(report.stats.failed_files, 1);
        assert_eq!(report.stats.ignored_files, 1);
        assert_eq!(report.stats.source_bytes, safe.len() as u64);
        assert!(report.stats.partial);
        assert_eq!(report.stats.exclusion_counts["binary"], 1);
        assert_eq!(report.stats.exclusion_counts["too_large"], 1);
        assert_eq!(report.stats.exclusion_counts["metadata_failed"], 1);
        assert_eq!(report.stats.exclusion_counts["hidden"], 1);
        assert!(report.stats.exclusion_examples.len() <= MAX_EXCLUSION_EXAMPLES);
        assert!(report
            .stats
            .exclusion_examples
            .iter()
            .all(|example| !example.contains(dir.path().to_string_lossy().as_ref())));

        let updates = observer.recorder.updates.lock().unwrap();
        let byte_updates: Vec<u64> = updates
            .iter()
            .filter_map(|update| update.bytes_processed)
            .collect();
        assert!(
            byte_updates.windows(2).all(|pair| pair[0] <= pair[1]),
            "progress bytes regressed: {byte_updates:?}"
        );
        assert_eq!(
            byte_updates.last().copied().unwrap_or_default(),
            report.stats.source_bytes,
            "completed progress reports source bytes actually streamed"
        );
        let diagnostics = format!("{:?} {:?}", report.stats, *updates);
        assert!(!diagnostics.contains("test-secret-token"), "{diagnostics}");
        assert!(!diagnostics.contains("/Users/"), "{diagnostics}");

        let reopened = LogCorpus::open(&cache, &report.corpus_id).unwrap();
        let persisted = reopened.meta().unwrap().stats.unwrap();
        assert_eq!(persisted.discovered_files, 5);
        assert_eq!(persisted.files, 1);
        assert!(persisted.partial);
    }

    #[test]
    fn zip_reporting_uses_the_same_counter_semantics() {
        use std::io::Write as _;

        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache");
        let zip_path = dir.path().join("mixed.zip");
        let safe = b"level=info msg=safe zip line\n";
        {
            let file = std::fs::File::create(&zip_path).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            let opts = zip::write::SimpleFileOptions::default();
            zip.add_directory("ignored/", opts).unwrap();
            zip.start_file("safe.log", opts).unwrap();
            zip.write_all(safe).unwrap();
            zip.start_file("binary.log", opts).unwrap();
            zip.write_all(b"prefix\0binary").unwrap();
            zip.finish().unwrap();
        }

        let report = ingest_path(&cache, &zip_path, "honest-zip", None, "none").unwrap();
        assert_eq!(report.stats.discovered_files, 3);
        assert_eq!(report.stats.files, 1);
        assert_eq!(report.stats.excluded_files, 1);
        assert_eq!(report.stats.failed_files, 0);
        assert_eq!(report.stats.ignored_files, 1);
        assert_eq!(report.stats.source_bytes, safe.len() as u64);
        assert_eq!(report.stats.exclusion_counts["binary"], 1);
        assert_eq!(report.stats.exclusion_counts["directory"], 1);
        assert!(report.stats.partial);
    }

    #[test]
    fn empty_directory_fails_without_publishing_a_corpus() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("cache");
        let logs = dir.path().join("empty");
        std::fs::create_dir_all(&logs).unwrap();

        let err = ingest_path(&cache, &logs, "empty", None, "none").unwrap_err();
        assert!(
            format!("{err}").contains("no importable log file entries"),
            "{err}"
        );
        assert!(LogCorpus::list_ids(&cache).unwrap().is_empty());
        assert_no_ingest_staging(&cache);
    }
}
