//! Bounded same-snapshot live comparison.
//!
//! Preparation still happens exactly once. Candidate lanes then run with an
//! explicit concurrency ceiling so provider work can overlap without unbounded
//! task spawning, shared mutable workflow state, or a second corpus copy.

use std::collections::BTreeSet;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, Instant};

use cd_core::keychain_store::SecretStore;
use cd_core::process_progress::CancelFlag;
use cd_triage_bench::{BenchStore, Case, EvaluationTask, EvidenceSnapshot};
use cd_triage_runtime::TriageEventSink;
use futures_util::stream::{FuturesUnordered, StreamExt};

use crate::{
    candidate_allowance_ms, execute_prepared_same_snapshot, prepare_same_snapshot_with_deadline,
    LiveBridgeError, LiveRunOptions, LiveRunResult, PendingCleanupOutcome,
    PreparedSameSnapshotCorpus, DEFAULT_LIVE_COMPARISON_DEADLINE_MS,
    DEFAULT_MAX_COMPARISON_CANDIDATES,
};

type LaneOutput<T> = Result<T, LiveBridgeError>;
type BoxedLaneFuture<T> = Pin<Box<dyn Future<Output = LaneOutput<T>> + Send>>;
type BoxedIndexedLaneFuture<T> = Pin<Box<dyn Future<Output = (usize, LaneOutput<T>)> + Send>>;

/// Conservative default for how many candidate lanes may execute at once.
///
/// Two lanes overlap provider waits without bursting the shared DuckDB corpus
/// mutex or the host's four-wide credential worker pool. Operators may lower
/// this to `1` under provider rate limits; they may not raise it above
/// [`MAX_LIVE_COMPARISON_CONCURRENCY`].
pub const DEFAULT_LIVE_COMPARISON_CONCURRENCY: usize = 2;
/// Published ceiling on comparison concurrency. A caller may lower the limit
/// and may never raise it above this value.
pub const MAX_LIVE_COMPARISON_CONCURRENCY: usize = 4;

/// Execution bounds for one same-snapshot comparison.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LiveComparisonOptions {
    /// Maximum number of candidate lanes that may be in flight together.
    pub max_concurrency: usize,
}

impl Default for LiveComparisonOptions {
    fn default() -> Self {
        Self {
            max_concurrency: DEFAULT_LIVE_COMPARISON_CONCURRENCY,
        }
    }
}

impl LiveComparisonOptions {
    /// Accept a caller-chosen concurrency limit within the published ceiling.
    pub fn new(max_concurrency: usize) -> Result<Self, LiveBridgeError> {
        if max_concurrency == 0 || max_concurrency > MAX_LIVE_COMPARISON_CONCURRENCY {
            return Err(LiveBridgeError::ComparisonConcurrencyBound);
        }
        Ok(Self { max_concurrency })
    }

    /// Restore the historical one-at-a-time admission path.
    pub fn sequential() -> Self {
        Self { max_concurrency: 1 }
    }
}

/// One candidate in a same-snapshot live comparison.
///
/// Candidate options may select different policies, providers, or recording
/// identities. The cache root, source bounds, and cancellation signal must be
/// shared with every other candidate so preparation and cancellation remain a
/// single bounded operation. Per-run workflow state is never shared: each
/// lane builds its own host, workspace, cancellation registry, and request.
#[derive(Debug)]
pub struct LiveComparisonCandidate {
    /// Host-owned options for this candidate execution.
    pub options: LiveRunOptions,
    /// Optional event sink for this candidate's validated public replay.
    pub events: Option<TriageEventSink>,
}

/// What happened to one requested candidate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LiveLaneDisposition {
    /// The lane persisted a durable benchmark run.
    Persisted,
    /// The lane started and failed without persisting a run.
    Failed,
    /// The lane never started because the comparison stopped admitting work.
    NotStarted,
}

/// Request-order record of one candidate lane.
///
/// `error` is `None` for a persisted lane. A failed lane names the lane's own
/// refusal. A not-started lane names why admission closed — cancellation,
/// deadline, or a sibling hard failure — never a fabricated run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiveLaneOutcome {
    /// Zero-based index in the requested candidate list.
    pub index: usize,
    /// Distinct cancellation identity this candidate carried.
    pub cancellation_id: String,
    /// Whether the lane persisted, failed, or never started.
    pub disposition: LiveLaneDisposition,
    /// Lane refusal or admission-stop reason, when the lane did not persist.
    pub error: Option<LiveBridgeError>,
}

/// Completed runs from a same-snapshot comparison.
///
/// Every run listed here is already durable in the benchmark store. A
/// comparison that stopped early still returns the runs it persisted, so an
/// operator is never told "it failed" without being told what now exists.
/// `runs` is the requested-order projection of persisted lanes, not a
/// sequential prefix: a later lane that finished while an earlier sibling
/// failed is retained.
#[derive(Debug, Clone, PartialEq)]
pub struct LiveComparisonResult {
    /// Runs persisted by the bridge and ready for the honest bench report.
    pub runs: Vec<LiveRunResult>,
    /// Why the comparison is incomplete, when it is.
    ///
    /// `None` means every requested candidate started and persisted. `Some(_)`
    /// means at least one lane failed without persisting or never started.
    /// The first request-order gap wins, so a sibling failure is not rewritten
    /// as cancellation or deadline.
    pub stopped: Option<LiveBridgeError>,
    /// Cleanup debt this cache root carried into the comparison.
    pub pending_cleanup: PendingCleanupOutcome,
    /// One row per requested candidate, in requested order.
    pub lanes: Vec<LiveLaneOutcome>,
}

impl LiveComparisonResult {
    /// True only when every requested candidate ran and persisted.
    pub fn is_complete(&self) -> bool {
        self.stopped.is_none()
    }

    /// Durable benchmark run identities produced by this comparison.
    pub fn persisted_run_ids(&self) -> Vec<String> {
        self.runs
            .iter()
            .map(|run| run.recorded.bench_run.run_id.clone())
            .collect()
    }
}

/// Shared, immutable preparation handed to every candidate lane.
#[derive(Clone)]
pub(crate) struct SharedPreparedSnapshot {
    corpus: Arc<PreparedSameSnapshotCorpus>,
    comparison_deadline_ms: u64,
}

impl SharedPreparedSnapshot {
    #[cfg(test)]
    fn corpus_id(&self) -> &str {
        self.corpus.corpus_id()
    }

    #[cfg(test)]
    fn corpus_revision(&self) -> u64 {
        self.corpus.corpus_revision()
    }

    fn corpus(&self) -> &PreparedSameSnapshotCorpus {
        self.corpus.as_ref()
    }
}

/// Execute multiple live candidates against one prepared task snapshot.
///
/// Uses [`DEFAULT_LIVE_COMPARISON_CONCURRENCY`]. See
/// [`run_live_comparison_with_options`] for the explicit bound.
pub async fn run_live_comparison(
    store: &BenchStore,
    case: &Case,
    snapshot: &EvidenceSnapshot,
    task: &EvaluationTask,
    secrets: Arc<dyn SecretStore>,
    candidates: Vec<LiveComparisonCandidate>,
) -> Result<LiveComparisonResult, LiveBridgeError> {
    run_live_comparison_with_options(
        store,
        case,
        snapshot,
        task,
        secrets,
        candidates,
        LiveComparisonOptions::default(),
    )
    .await
}

/// Same as [`run_live_comparison`], with an explicit concurrency bound.
pub async fn run_live_comparison_with_options(
    store: &BenchStore,
    case: &Case,
    snapshot: &EvidenceSnapshot,
    task: &EvaluationTask,
    secrets: Arc<dyn SecretStore>,
    candidates: Vec<LiveComparisonCandidate>,
    options: LiveComparisonOptions,
) -> Result<LiveComparisonResult, LiveBridgeError> {
    let envelope = run_live_comparison_with_lane_fn(
        store,
        case,
        snapshot,
        task,
        candidates,
        options,
        production_lane_fn(store, case, snapshot, task, secrets),
    )
    .await?;
    Ok(envelope.into_result())
}

/// Same as [`run_live_comparison_with_options`], with a bounded callback for
/// each lane that has already persisted a durable run. The callback receives
/// only the source-neutral persisted run; it never receives provider text,
/// prompts, credentials, or raw replay bytes.
#[allow(clippy::too_many_arguments)]
pub async fn run_live_comparison_with_options_and_progress<P>(
    store: &BenchStore,
    case: &Case,
    snapshot: &EvidenceSnapshot,
    task: &EvaluationTask,
    secrets: Arc<dyn SecretStore>,
    candidates: Vec<LiveComparisonCandidate>,
    options: LiveComparisonOptions,
    on_lane_persisted: P,
) -> Result<LiveComparisonResult, LiveBridgeError>
where
    P: FnMut(usize, &LiveRunResult) + Send,
{
    run_live_comparison_with_options_and_lifecycle(
        store,
        case,
        snapshot,
        task,
        secrets,
        candidates,
        options,
        ignore_lane_started,
        on_lane_persisted,
    )
    .await
}

/// Same as [`run_live_comparison_with_options_and_progress`], also reporting
/// when the bounded scheduler admits a lane. Started events contain only the
/// request-order index; the persisted callback remains the only path for
/// durable, host-validated result data.
#[allow(clippy::too_many_arguments)]
pub async fn run_live_comparison_with_options_and_lifecycle<S, P>(
    store: &BenchStore,
    case: &Case,
    snapshot: &EvidenceSnapshot,
    task: &EvaluationTask,
    secrets: Arc<dyn SecretStore>,
    candidates: Vec<LiveComparisonCandidate>,
    options: LiveComparisonOptions,
    on_lane_started: S,
    on_lane_persisted: P,
) -> Result<LiveComparisonResult, LiveBridgeError>
where
    S: FnMut(usize) + Send,
    P: FnMut(usize, &LiveRunResult) + Send,
{
    let envelope = run_live_comparison_with_lane_fn_and_progress(
        store,
        case,
        snapshot,
        task,
        candidates,
        options,
        production_lane_fn(store, case, snapshot, task, secrets),
        on_lane_started,
        on_lane_persisted,
    )
    .await?;
    Ok(envelope.into_result())
}

fn production_lane_fn(
    store: &BenchStore,
    case: &Case,
    snapshot: &EvidenceSnapshot,
    task: &EvaluationTask,
    secrets: Arc<dyn SecretStore>,
) -> impl FnMut(
    usize,
    Arc<SharedPreparedSnapshot>,
    LiveComparisonCandidate,
) -> BoxedLaneFuture<LiveRunResult> {
    let store = store.clone();
    let case = case.clone();
    let snapshot = snapshot.clone();
    let task = task.clone();
    move |_index, prepared, candidate| {
        let store = store.clone();
        let case = case.clone();
        let snapshot = snapshot.clone();
        let task = task.clone();
        let secrets = Arc::clone(&secrets);
        Box::pin(async move {
            let LiveComparisonCandidate {
                mut options,
                events,
            } = candidate;
            options.overrides.deadline_ms = Some(candidate_allowance_ms(
                prepared.comparison_deadline_ms,
                options.overrides.deadline_ms,
            ));
            execute_prepared_same_snapshot(
                &store,
                &case,
                &snapshot,
                &task,
                prepared.corpus(),
                secrets,
                &options,
                events,
            )
            .await
        })
    }
}

/// Generic comparison envelope so hermetic tests can return controlled lane
/// products without fabricating adapter envelopes.
pub(crate) struct LiveComparisonEnvelope<T> {
    pub items: Vec<T>,
    pub stopped: Option<LiveBridgeError>,
    pub pending_cleanup: PendingCleanupOutcome,
    pub lanes: Vec<LiveLaneOutcome>,
}

impl LiveComparisonEnvelope<LiveRunResult> {
    fn into_result(self) -> LiveComparisonResult {
        LiveComparisonResult {
            runs: self.items,
            stopped: self.stopped,
            pending_cleanup: self.pending_cleanup,
            lanes: self.lanes,
        }
    }
}

pub(crate) async fn run_live_comparison_with_lane_fn<T, F, Fut>(
    store: &BenchStore,
    case: &Case,
    snapshot: &EvidenceSnapshot,
    task: &EvaluationTask,
    candidates: Vec<LiveComparisonCandidate>,
    options: LiveComparisonOptions,
    lane_fn: F,
) -> Result<LiveComparisonEnvelope<T>, LiveBridgeError>
where
    T: Send + 'static,
    F: FnMut(usize, Arc<SharedPreparedSnapshot>, LiveComparisonCandidate) -> Fut,
    Fut: Future<Output = Result<T, LiveBridgeError>> + Send + 'static,
{
    let mut ignore_started = ignore_lane_started;
    let mut ignore_progress = ignore_lane_progress::<T>;
    run_live_comparison_with_lane_fn_and_progress(
        store,
        case,
        snapshot,
        task,
        candidates,
        options,
        lane_fn,
        &mut ignore_started,
        &mut ignore_progress,
    )
    .await
}

fn ignore_lane_progress<T>(_index: usize, _value: &T) {}

fn ignore_lane_started(_index: usize) {}

#[allow(clippy::too_many_arguments)]
async fn run_live_comparison_with_lane_fn_and_progress<T, F, Fut, P>(
    store: &BenchStore,
    case: &Case,
    snapshot: &EvidenceSnapshot,
    task: &EvaluationTask,
    candidates: Vec<LiveComparisonCandidate>,
    options: LiveComparisonOptions,
    mut lane_fn: F,
    mut on_lane_started: impl FnMut(usize) + Send,
    mut on_lane_persisted: P,
) -> Result<LiveComparisonEnvelope<T>, LiveBridgeError>
where
    T: Send + 'static,
    F: FnMut(usize, Arc<SharedPreparedSnapshot>, LiveComparisonCandidate) -> Fut,
    Fut: Future<Output = Result<T, LiveBridgeError>> + Send + 'static,
    P: FnMut(usize, &T) + Send,
{
    if candidates.is_empty() {
        return Err(LiveBridgeError::EmptyComparison);
    }
    if candidates.len() > DEFAULT_MAX_COMPARISON_CANDIDATES {
        return Err(LiveBridgeError::ComparisonCandidateBound);
    }
    if options.max_concurrency == 0 || options.max_concurrency > MAX_LIVE_COMPARISON_CONCURRENCY {
        return Err(LiveBridgeError::ComparisonConcurrencyBound);
    }

    let first = &candidates[0].options;
    let comparison_deadline_ms = candidates
        .iter()
        .filter_map(|candidate| candidate.options.overrides.deadline_ms)
        .min()
        .unwrap_or(DEFAULT_LIVE_COMPARISON_DEADLINE_MS);
    let mut seen_cancellation_ids = BTreeSet::new();
    for candidate in &candidates {
        let lane_options = &candidate.options;
        if lane_options.cache_root != first.cache_root
            || lane_options.limits != first.limits
            || !Arc::ptr_eq(&first.cancel.inner_arc(), &lane_options.cancel.inner_arc())
            || !seen_cancellation_ids.insert(lane_options.cancellation_id.as_str())
        {
            return Err(LiveBridgeError::ComparisonInvariant);
        }
    }

    let started = Instant::now();
    let candidate_count = candidates.len();
    let prepared = prepare_same_snapshot_with_deadline(
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
    let pending_cleanup = prepared.pending_cleanup();
    let cancel = first.cancel.clone();
    let cancellation_ids = candidates
        .iter()
        .map(|candidate| candidate.options.cancellation_id.clone())
        .collect::<Vec<_>>();

    let shared = Arc::new(SharedPreparedSnapshot {
        corpus: Arc::new(prepared),
        comparison_deadline_ms,
    });
    let mut slots: Vec<Option<LiveComparisonCandidate>> =
        candidates.into_iter().map(Some).collect();
    let mut start_lane = {
        let shared = Arc::clone(&shared);
        move |index: usize| {
            let candidate = slots[index]
                .take()
                .expect("each comparison lane starts at most once");
            lane_fn(index, Arc::clone(&shared), candidate)
        }
    };

    let scheduled = run_bounded_candidate_lanes_with_lifecycle(
        candidate_count,
        options.max_concurrency,
        &cancel,
        started,
        comparison_deadline_ms,
        &mut start_lane,
        &mut on_lane_started,
        &mut on_lane_persisted,
    )
    .await;

    drop(start_lane);
    let corpus = Arc::clone(&shared.corpus);
    drop(shared);
    let cleanup = match Arc::try_unwrap(corpus) {
        Ok(mut prepared) => prepared.discard(),
        Err(remaining) => {
            drop(remaining);
            Err(LiveBridgeError::Cleanup)
        }
    };

    let (items, lanes, stopped) = project_lanes(
        &cancellation_ids,
        scheduled.outcomes,
        scheduled.admission_stop,
    );

    if items.is_empty() {
        return Err(match (stopped, cleanup) {
            (Some(_), Err(_)) => LiveBridgeError::FailureAndCleanup,
            (Some(error), Ok(())) => error,
            (None, Err(cleanup_error)) => cleanup_error,
            (None, Ok(())) => LiveBridgeError::EmptyComparison,
        });
    }
    Ok(LiveComparisonEnvelope {
        items,
        stopped: stopped.or_else(|| cleanup.err()),
        pending_cleanup,
        lanes,
    })
}

pub(crate) struct BoundedLaneRun<T> {
    outcomes: Vec<Option<Result<T, LiveBridgeError>>>,
    admission_stop: Option<LiveBridgeError>,
}

#[cfg(test)]
pub(crate) async fn run_bounded_candidate_lanes<T, F, Fut>(
    count: usize,
    max_concurrency: usize,
    cancel: &CancelFlag,
    started: Instant,
    comparison_deadline_ms: u64,
    start_lane: &mut F,
) -> BoundedLaneRun<T>
where
    T: Send + 'static,
    F: FnMut(usize) -> Fut,
    Fut: Future<Output = Result<T, LiveBridgeError>> + Send + 'static,
{
    let mut ignore_started = ignore_lane_started;
    let mut ignore_progress = ignore_lane_progress::<T>;
    run_bounded_candidate_lanes_with_lifecycle(
        count,
        max_concurrency,
        cancel,
        started,
        comparison_deadline_ms,
        start_lane,
        &mut ignore_started,
        &mut ignore_progress,
    )
    .await
}

#[cfg(test)]
async fn run_bounded_candidate_lanes_with_progress<T, F, Fut, P>(
    count: usize,
    max_concurrency: usize,
    cancel: &CancelFlag,
    started: Instant,
    comparison_deadline_ms: u64,
    start_lane: &mut F,
    on_lane_persisted: &mut P,
) -> BoundedLaneRun<T>
where
    T: Send + 'static,
    F: FnMut(usize) -> Fut,
    Fut: Future<Output = Result<T, LiveBridgeError>> + Send + 'static,
    P: FnMut(usize, &T) + Send,
{
    let mut ignore_started = ignore_lane_started;
    run_bounded_candidate_lanes_with_lifecycle(
        count,
        max_concurrency,
        cancel,
        started,
        comparison_deadline_ms,
        start_lane,
        &mut ignore_started,
        on_lane_persisted,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn run_bounded_candidate_lanes_with_lifecycle<T, F, Fut, P, S>(
    count: usize,
    max_concurrency: usize,
    cancel: &CancelFlag,
    started: Instant,
    comparison_deadline_ms: u64,
    start_lane: &mut F,
    on_lane_started: &mut S,
    on_lane_persisted: &mut P,
) -> BoundedLaneRun<T>
where
    T: Send + 'static,
    F: FnMut(usize) -> Fut,
    Fut: Future<Output = Result<T, LiveBridgeError>> + Send + 'static,
    P: FnMut(usize, &T) + Send,
    S: FnMut(usize) + Send,
{
    let limit = max_concurrency.min(count).max(1);
    let mut outcomes: Vec<Option<Result<T, LiveBridgeError>>> = (0..count).map(|_| None).collect();
    let mut in_flight = FuturesUnordered::<BoxedIndexedLaneFuture<T>>::new();
    let mut next = 0;
    let mut admission_open = true;
    let mut admission_stop = None;

    loop {
        close_admission_if_needed(
            cancel,
            started,
            comparison_deadline_ms,
            &mut admission_open,
            &mut admission_stop,
        );

        while admission_open && in_flight.len() < limit && next < count {
            close_admission_if_needed(
                cancel,
                started,
                comparison_deadline_ms,
                &mut admission_open,
                &mut admission_stop,
            );
            if !admission_open {
                break;
            }
            let index = next;
            next += 1;
            on_lane_started(index);
            let future = start_lane(index);
            in_flight.push(Box::pin(async move { (index, future.await) }));
        }

        if in_flight.is_empty() {
            break;
        }

        let remaining = Duration::from_millis(comparison_deadline_ms)
            .checked_sub(started.elapsed())
            .unwrap_or(Duration::ZERO);
        tokio::select! {
            biased;
            Some((index, result)) = in_flight.next() => {
                match result {
                    Ok(value) => {
                        on_lane_persisted(index, &value);
                        outcomes[index] = Some(Ok(value));
                    }
                    Err(error) => {
                        outcomes[index] = Some(Err(error));
                        admission_open = false;
                        if admission_stop.is_none() {
                            admission_stop = Some(error);
                        }
                    }
                }
            }
            _ = tokio::time::sleep(remaining), if admission_open && remaining > Duration::ZERO => {
                admission_open = false;
                if admission_stop.is_none() {
                    admission_stop = Some(LiveBridgeError::Deadline);
                }
            }
        }
    }

    BoundedLaneRun {
        outcomes,
        admission_stop,
    }
}

fn close_admission_if_needed(
    cancel: &CancelFlag,
    started: Instant,
    comparison_deadline_ms: u64,
    admission_open: &mut bool,
    admission_stop: &mut Option<LiveBridgeError>,
) {
    if !*admission_open {
        return;
    }
    if cancel.is_cancelled() {
        *admission_open = false;
        if admission_stop.is_none() {
            *admission_stop = Some(LiveBridgeError::Cancelled);
        }
        return;
    }
    if started.elapsed() >= Duration::from_millis(comparison_deadline_ms) {
        *admission_open = false;
        if admission_stop.is_none() {
            *admission_stop = Some(LiveBridgeError::Deadline);
        }
    }
}

fn project_lanes<T>(
    cancellation_ids: &[String],
    outcomes: Vec<Option<Result<T, LiveBridgeError>>>,
    admission_stop: Option<LiveBridgeError>,
) -> (Vec<T>, Vec<LiveLaneOutcome>, Option<LiveBridgeError>) {
    let mut runs = Vec::new();
    let mut lanes = Vec::with_capacity(outcomes.len());
    let mut stopped = None;
    for (index, outcome) in outcomes.into_iter().enumerate() {
        let cancellation_id = cancellation_ids[index].clone();
        match outcome {
            Some(Ok(run)) => {
                runs.push(run);
                lanes.push(LiveLaneOutcome {
                    index,
                    cancellation_id,
                    disposition: LiveLaneDisposition::Persisted,
                    error: None,
                });
            }
            Some(Err(error)) => {
                if stopped.is_none() {
                    stopped = Some(error);
                }
                lanes.push(LiveLaneOutcome {
                    index,
                    cancellation_id,
                    disposition: LiveLaneDisposition::Failed,
                    error: Some(error),
                });
            }
            None => {
                if stopped.is_none() {
                    stopped = admission_stop;
                }
                lanes.push(LiveLaneOutcome {
                    index,
                    cancellation_id,
                    disposition: LiveLaneDisposition::NotStarted,
                    error: admission_stop,
                });
            }
        }
    }
    (runs, lanes, stopped)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    use cd_core::config::AppConfig;
    use cd_core::process_progress::CancelFlag;
    use cd_core::triage_policy_store::TriagePolicyStoreV1;
    use cd_core::triage_role_qualification::TriageRoleQualificationStoreV1;
    use cd_triage_bench::{
        BenchStore, Case, CaseLifecycle, ClaimedCitation, Completeness, ContentDigest,
        EvaluationTask, EvidenceItem, EvidenceSnapshot, EvidenceSource, FairnessClass, HeldContent,
        Observed, PrivacyClass, PromptWorkflow, RawOutput, ReportedProblem, RunStatus, SourceKind,
        StrategyIdentity, TriageRun, VisibilityPolicy, CASE_SCHEMA_V1, RUN_SCHEMA_V2,
    };
    use cd_triage_bench_adapter::RecordingContext;
    use cd_triage_sdk::{ModelRef, TriagePolicySelectionV2, TriageRequestOverridesV1};
    use tokio::sync::{Barrier, Notify};

    use crate::{LiveCorpusLimits, LiveRunOptions};

    const CREATED_AT: &str = "2026-08-18T07:00:00Z";

    fn fixture() -> (
        tempfile::TempDir,
        tempfile::TempDir,
        BenchStore,
        Case,
        EvidenceSnapshot,
        EvaluationTask,
    ) {
        let library_dir = tempfile::tempdir().unwrap();
        let cache_dir = tempfile::tempdir().unwrap();
        let store = BenchStore::init(library_dir.path(), CREATED_AT).unwrap();
        let case = Case {
            schema_id: CASE_SCHEMA_V1.into(),
            case_id: "case-live-1".into(),
            privacy: PrivacyClass::OwnerOnly,
            title: "Checkout outage".into(),
            reported_problem: ReportedProblem {
                summary: "checkout requests fail".into(),
                reported_at: None,
                reporter: None,
                symptoms: vec![],
            },
            lifecycle: CaseLifecycle::Unresolved,
            timeline_notes: vec![],
            created_at: CREATED_AT.into(),
            resolution: None,
        };
        case.validate().unwrap();
        let bytes = b"2026-08-18T06:59:58Z INFO checkout started\n2026-08-18T06:59:59Z ERROR database timeout\n";
        let digest = store.put_blob(bytes).unwrap();
        let snapshot = EvidenceSnapshot::from_parts(
            PrivacyClass::OwnerOnly,
            case.case_id.clone(),
            CREATED_AT.into(),
            "fixture".into(),
            vec![EvidenceItem::Log {
                item_id: "ev-log-1".into(),
                privacy: PrivacyClass::OwnerOnly,
                capture_time: CREATED_AT.into(),
                source: EvidenceSource {
                    reference: "checkout.log".into(),
                    captured_from: "fixture".into(),
                },
                media_type: "text/plain".into(),
                format: "raw".into(),
                content: HeldContent {
                    digest,
                    byte_length: bytes.len() as u64,
                },
                summaries: vec![],
                visible_to_strategies: true,
            }],
            None,
        )
        .unwrap();
        let task = EvaluationTask::from_parts(
            PrivacyClass::OwnerOnly,
            case.case_id.clone(),
            snapshot.snapshot_id.clone(),
            "What caused the checkout failure?".into(),
            "Use only the supplied evidence.".into(),
            "v1".into(),
            VisibilityPolicy {
                visible_item_ids: vec!["ev-log-1".into()],
                include_summaries: false,
                include_raw_bytes: true,
            },
            None,
            CREATED_AT.into(),
        )
        .unwrap();
        store.put_case(&case).unwrap();
        store.put_snapshot(&snapshot).unwrap();
        store.put_task(&task).unwrap();
        (library_dir, cache_dir, store, case, snapshot, task)
    }

    fn dummy_candidate(
        cache_root: &std::path::Path,
        cancel: &CancelFlag,
        cancellation_id: &str,
        deadline_ms: Option<u64>,
    ) -> LiveComparisonCandidate {
        LiveComparisonCandidate {
            options: LiveRunOptions {
                cache_root: cache_root.to_path_buf(),
                config: AppConfig::default(),
                policies: TriagePolicyStoreV1::default(),
                qualifications: TriageRoleQualificationStoreV1::default(),
                policy: TriagePolicySelectionV2::Standard {
                    model: ModelRef {
                        profile_id: "profile:live-fixture".into(),
                        model_id: "model:live-fixture".into(),
                    },
                },
                overrides: TriageRequestOverridesV1 {
                    deadline_ms,
                    max_provider_calls: None,
                },
                cancellation_id: cancellation_id.into(),
                recording: RecordingContext {
                    strategy: StrategyIdentity {
                        name: cancellation_id.into(),
                        version: Observed::Unknown,
                        build: Observed::Unknown,
                    },
                    operator: "test".into(),
                    created_at: CREATED_AT.into(),
                },
                limits: LiveCorpusLimits::default(),
                cancel: cancel.clone(),
            },
            events: None,
        }
    }

    fn persist_lane_run(
        store: &BenchStore,
        task: &EvaluationTask,
        index: usize,
        status: RunStatus,
    ) -> String {
        let raw = format!("lane-{index}-output");
        let raw_bytes = raw.as_bytes();
        let mut run = TriageRun {
            schema_id: RUN_SCHEMA_V2.into(),
            run_id: String::new(),
            privacy: task.privacy,
            case_id: task.case_id.clone(),
            task_id: task.task_id.clone(),
            snapshot_id: task.snapshot_id.clone(),
            strategy: StrategyIdentity {
                name: format!("lane-{index}"),
                version: Observed::Known("comparison-v1".into()),
                build: Observed::Unknown,
            },
            source_kind: SourceKind::OtherProduct,
            prompt_workflow: PromptWorkflow {
                completeness: Completeness::Unknown,
                prompt: Observed::Unknown,
                workflow: Observed::Unknown,
            },
            raw_output: RawOutput {
                digest: ContentDigest::of_bytes(raw_bytes),
                byte_length: raw_bytes.len() as u64,
                encoding: "utf-8".into(),
            },
            claims: vec![ClaimedCitation {
                claim: "host-bound observation".into(),
                evidence_item_id: Some("ev-log-1".into()),
                locator: None,
            }],
            timing: Observed::Unknown,
            cost: Observed::Unknown,
            uncertainty: Observed::Unknown,
            fairness: FairnessClass::SameSnapshot,
            status,
            operator: "test".into(),
            importer: None,
            created_at: CREATED_AT.into(),
            near_duplicate_of: None,
        };
        run.run_id = format!("run-{}", run.fingerprint().unwrap());
        store.put_run_with_raw_output(&run, raw_bytes).unwrap();
        run.run_id
    }

    #[test]
    fn comparison_options_refuse_zero_and_unbounded_concurrency() {
        assert_eq!(
            LiveComparisonOptions::new(0).unwrap_err(),
            LiveBridgeError::ComparisonConcurrencyBound
        );
        assert_eq!(
            LiveComparisonOptions::new(MAX_LIVE_COMPARISON_CONCURRENCY + 1).unwrap_err(),
            LiveBridgeError::ComparisonConcurrencyBound
        );
        assert_eq!(
            LiveComparisonOptions::new(1).unwrap(),
            LiveComparisonOptions::sequential()
        );
        assert_eq!(
            LiveComparisonOptions::default().max_concurrency,
            DEFAULT_LIVE_COMPARISON_CONCURRENCY
        );
    }

    #[tokio::test]
    async fn scheduler_overlaps_up_to_the_configured_limit_and_no_further() {
        let active = Arc::new(AtomicUsize::new(0));
        let max_active = Arc::new(AtomicUsize::new(0));
        let starts = Arc::new(Mutex::new(Vec::<(usize, Instant)>::new()));
        let ends = Arc::new(Mutex::new(Vec::<(usize, Instant)>::new()));
        let mut next = 0;
        let count = 3;
        let mut start_lane = |_index: usize| {
            let index = next;
            next += 1;
            let active = Arc::clone(&active);
            let max_active = Arc::clone(&max_active);
            let starts = Arc::clone(&starts);
            let ends = Arc::clone(&ends);
            async move {
                starts.lock().unwrap().push((index, Instant::now()));
                let now = active.fetch_add(1, Ordering::SeqCst) + 1;
                max_active.fetch_max(now, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(40)).await;
                active.fetch_sub(1, Ordering::SeqCst);
                ends.lock().unwrap().push((index, Instant::now()));
                Ok(index)
            }
        };

        let scheduled = run_bounded_candidate_lanes(
            count,
            2,
            &CancelFlag::new(),
            Instant::now(),
            5_000,
            &mut start_lane,
        )
        .await;

        assert_eq!(max_active.load(Ordering::SeqCst), 2);
        let outcomes = scheduled
            .outcomes
            .into_iter()
            .map(|outcome| outcome.unwrap().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(outcomes, vec![0, 1, 2]);
        let starts = starts.lock().unwrap().clone();
        let ends = ends.lock().unwrap().clone();
        let start_of = |index: usize| {
            starts
                .iter()
                .find(|(seen, _)| *seen == index)
                .map(|(_, at)| *at)
                .unwrap()
        };
        let end_of = |index: usize| {
            ends.iter()
                .find(|(seen, _)| *seen == index)
                .map(|(_, at)| *at)
                .unwrap()
        };
        assert!(
            start_of(0) < end_of(1) && start_of(1) < end_of(0),
            "the first two lanes must overlap"
        );
        assert!(
            start_of(2) >= end_of(0).min(end_of(1)),
            "the third lane must wait for a free slot"
        );
        assert!(scheduled.admission_stop.is_none());
    }

    #[tokio::test]
    async fn scheduler_with_concurrency_one_is_sequential() {
        let active = Arc::new(AtomicUsize::new(0));
        let max_active = Arc::new(AtomicUsize::new(0));
        let mut next = 0;
        let mut start_lane = |_index: usize| {
            let index = next;
            next += 1;
            let active = Arc::clone(&active);
            let max_active = Arc::clone(&max_active);
            async move {
                let now = active.fetch_add(1, Ordering::SeqCst) + 1;
                max_active.fetch_max(now, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(15)).await;
                active.fetch_sub(1, Ordering::SeqCst);
                Ok(index)
            }
        };

        let scheduled = run_bounded_candidate_lanes(
            3,
            1,
            &CancelFlag::new(),
            Instant::now(),
            5_000,
            &mut start_lane,
        )
        .await;

        assert_eq!(max_active.load(Ordering::SeqCst), 1);
        let outcomes = scheduled
            .outcomes
            .into_iter()
            .map(|outcome| outcome.unwrap().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(outcomes, vec![0, 1, 2]);
    }

    #[tokio::test]
    async fn scheduler_reports_each_persisted_lane_before_projection() {
        let mut next = 0;
        let mut start_lane = |_index: usize| {
            let index = next;
            next += 1;
            async move {
                tokio::time::sleep(Duration::from_millis(if index == 0 { 30 } else { 5 })).await;
                Ok(index)
            }
        };
        let mut persisted = Vec::new();
        let mut on_lane_persisted = |index: usize, value: &usize| {
            persisted.push((index, *value));
        };

        let scheduled = run_bounded_candidate_lanes_with_progress(
            2,
            2,
            &CancelFlag::new(),
            Instant::now(),
            5_000,
            &mut start_lane,
            &mut on_lane_persisted,
        )
        .await;

        assert_eq!(persisted, vec![(1, 1), (0, 0)]);
        assert_eq!(
            scheduled.outcomes[0].as_ref().unwrap().as_ref().unwrap(),
            &0
        );
        assert_eq!(
            scheduled.outcomes[1].as_ref().unwrap().as_ref().unwrap(),
            &1
        );
    }

    #[tokio::test]
    async fn scheduler_projects_requested_order_after_out_of_order_completion() {
        let mut next = 0;
        let delays = [50_u64, 10, 30];
        let mut start_lane = |_index: usize| {
            let index = next;
            next += 1;
            let delay = delays[index];
            async move {
                tokio::time::sleep(Duration::from_millis(delay)).await;
                Ok(format!("lane-{index}"))
            }
        };

        let scheduled = run_bounded_candidate_lanes(
            3,
            3,
            &CancelFlag::new(),
            Instant::now(),
            5_000,
            &mut start_lane,
        )
        .await;

        let outcomes = scheduled
            .outcomes
            .into_iter()
            .map(|outcome| outcome.unwrap().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            outcomes,
            vec![
                "lane-0".to_string(),
                "lane-1".to_string(),
                "lane-2".to_string()
            ]
        );
    }

    #[tokio::test]
    async fn scheduler_cancels_admission_with_multiple_in_flight_lanes() {
        let started_lanes = Arc::new(AtomicUsize::new(0));
        let barrier = Arc::new(Barrier::new(2));
        let cancel = CancelFlag::new();
        let mut next = 0;
        let mut start_lane = |_index: usize| {
            let index = next;
            next += 1;
            let started_lanes = Arc::clone(&started_lanes);
            let barrier = Arc::clone(&barrier);
            let cancel = cancel.clone();
            async move {
                started_lanes.fetch_add(1, Ordering::SeqCst);
                barrier.wait().await;
                while !cancel.is_cancelled() {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
                Ok(index)
            }
        };

        let cancel_for_task = cancel.clone();
        let started_for_task = Arc::clone(&started_lanes);
        tokio::spawn(async move {
            while started_for_task.load(Ordering::SeqCst) < 2 {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            cancel_for_task.cancel();
        });

        let scheduled =
            run_bounded_candidate_lanes(3, 2, &cancel, Instant::now(), 5_000, &mut start_lane)
                .await;

        assert_eq!(scheduled.admission_stop, Some(LiveBridgeError::Cancelled));
        assert_eq!(started_lanes.load(Ordering::SeqCst), 2);
        assert!(scheduled.outcomes[0].as_ref().unwrap().is_ok());
        assert!(scheduled.outcomes[1].as_ref().unwrap().is_ok());
        assert!(scheduled.outcomes[2].is_none());
    }

    #[tokio::test]
    async fn scheduler_deadline_prevents_new_work_and_keeps_in_flight_results() {
        let started_lanes = Arc::new(AtomicUsize::new(0));
        let mut next = 0;
        let mut start_lane = |_index: usize| {
            let index = next;
            next += 1;
            let started_lanes = Arc::clone(&started_lanes);
            async move {
                started_lanes.fetch_add(1, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(80)).await;
                Ok(index)
            }
        };

        let scheduled = run_bounded_candidate_lanes(
            3,
            2,
            &CancelFlag::new(),
            Instant::now(),
            20,
            &mut start_lane,
        )
        .await;

        assert_eq!(scheduled.admission_stop, Some(LiveBridgeError::Deadline));
        assert_eq!(started_lanes.load(Ordering::SeqCst), 2);
        assert_eq!(
            scheduled.outcomes[0].as_ref().unwrap().as_ref().unwrap(),
            &0
        );
        assert_eq!(
            scheduled.outcomes[1].as_ref().unwrap().as_ref().unwrap(),
            &1
        );
        assert!(scheduled.outcomes[2].is_none());
    }

    #[tokio::test]
    async fn scheduler_keeps_sibling_results_when_one_lane_fails() {
        let started_lanes = Arc::new(AtomicUsize::new(0));
        let mut next = 0;
        let mut start_lane = |_index: usize| {
            let index = next;
            next += 1;
            let started_lanes = Arc::clone(&started_lanes);
            async move {
                started_lanes.fetch_add(1, Ordering::SeqCst);
                if index == 1 {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                    return Err(LiveBridgeError::Execution);
                }
                tokio::time::sleep(Duration::from_millis(40)).await;
                Ok(index)
            }
        };

        let scheduled = run_bounded_candidate_lanes(
            3,
            2,
            &CancelFlag::new(),
            Instant::now(),
            5_000,
            &mut start_lane,
        )
        .await;

        assert_eq!(scheduled.admission_stop, Some(LiveBridgeError::Execution));
        assert_eq!(started_lanes.load(Ordering::SeqCst), 2);
        assert_eq!(
            scheduled.outcomes[0].as_ref().unwrap().as_ref().unwrap(),
            &0
        );
        assert!(scheduled.outcomes[1].as_ref().unwrap().is_err());
        assert!(
            scheduled.outcomes[2].is_none(),
            "a sibling failure must not start later queued work"
        );
    }

    #[tokio::test]
    async fn live_comparison_shares_one_snapshot_identity_across_lanes() {
        let (_library, cache, store, case, snapshot, task) = fixture();
        let cancel = CancelFlag::new();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let candidates = vec![
            dummy_candidate(cache.path(), &cancel, "cancel:a", None),
            dummy_candidate(cache.path(), &cancel, "cancel:b", None),
            dummy_candidate(cache.path(), &cancel, "cancel:c", None),
        ];
        let envelope = run_live_comparison_with_lane_fn(
            &store,
            &case,
            &snapshot,
            &task,
            candidates,
            LiveComparisonOptions::new(2).unwrap(),
            {
                let seen = Arc::clone(&seen);
                let store = store.clone();
                let task = task.clone();
                move |index, prepared, _candidate| {
                    let seen = Arc::clone(&seen);
                    let store = store.clone();
                    let task = task.clone();
                    async move {
                        seen.lock().unwrap().push((
                            index,
                            prepared.corpus_id().to_string(),
                            prepared.corpus_revision(),
                        ));
                        Ok(persist_lane_run(&store, &task, index, RunStatus::Partial))
                    }
                }
            },
        )
        .await
        .unwrap();

        assert_eq!(envelope.items.len(), 3);
        assert!(envelope.stopped.is_none());
        assert!(envelope
            .lanes
            .iter()
            .all(|lane| lane.disposition == LiveLaneDisposition::Persisted));
        let seen = seen.lock().unwrap().clone();
        assert_eq!(seen.len(), 3);
        assert!(
            seen.windows(2)
                .all(|pair| pair[0].1 == pair[1].1 && pair[0].2 == pair[1].2),
            "every lane must receive the same proven corpus identity: {seen:?}"
        );
        for run_id in &envelope.items {
            assert_eq!(store.get_run(run_id).unwrap().run_id, *run_id);
        }
        let corpus_root = cache.path().join("log_corpora");
        assert!(
            !corpus_root.exists() || corpus_root.read_dir().unwrap().next().is_none(),
            "shared corpus must be discarded after concurrent lanes finish"
        );
    }

    #[tokio::test]
    async fn live_comparison_deadline_returns_durable_partial_results() {
        let (_library, cache, store, case, snapshot, task) = fixture();
        let cancel = CancelFlag::new();
        let candidates = vec![
            dummy_candidate(cache.path(), &cancel, "cancel:a", Some(1_000)),
            dummy_candidate(cache.path(), &cancel, "cancel:b", Some(1_000)),
            dummy_candidate(cache.path(), &cancel, "cancel:c", Some(1_000)),
        ];
        let envelope = run_live_comparison_with_lane_fn(
            &store,
            &case,
            &snapshot,
            &task,
            candidates,
            LiveComparisonOptions::new(2).unwrap(),
            {
                let store = store.clone();
                let task = task.clone();
                move |index, _prepared, _candidate| {
                    let store = store.clone();
                    let task = task.clone();
                    async move {
                        tokio::time::sleep(Duration::from_millis(1_500)).await;
                        Ok(persist_lane_run(&store, &task, index, RunStatus::Partial))
                    }
                }
            },
        )
        .await
        .expect("lanes that started before the deadline persist durable rows");

        assert_eq!(envelope.stopped, Some(LiveBridgeError::Deadline));
        assert_eq!(envelope.items.len(), 2);
        assert_eq!(
            envelope.lanes[2].disposition,
            LiveLaneDisposition::NotStarted
        );
        assert_eq!(envelope.lanes[2].error, Some(LiveBridgeError::Deadline));
        for run_id in &envelope.items {
            assert_eq!(store.get_run(run_id).unwrap().run_id, *run_id);
        }
        let corpus_root = cache.path().join("log_corpora");
        assert!(!corpus_root.exists() || corpus_root.read_dir().unwrap().next().is_none());
    }

    #[tokio::test]
    async fn live_comparison_keeps_durable_siblings_when_one_lane_fails() {
        let (_library, cache, store, case, snapshot, task) = fixture();
        let cancel = CancelFlag::new();
        let candidates = vec![
            dummy_candidate(cache.path(), &cancel, "cancel:a", None),
            dummy_candidate(cache.path(), &cancel, "cancel:b", None),
            dummy_candidate(cache.path(), &cancel, "cancel:c", None),
        ];
        let envelope = run_live_comparison_with_lane_fn(
            &store,
            &case,
            &snapshot,
            &task,
            candidates,
            LiveComparisonOptions::new(2).unwrap(),
            {
                let store = store.clone();
                let task = task.clone();
                move |index, _prepared, _candidate| {
                    let store = store.clone();
                    let task = task.clone();
                    async move {
                        if index == 0 {
                            tokio::time::sleep(Duration::from_millis(10)).await;
                            return Err(LiveBridgeError::Execution);
                        }
                        tokio::time::sleep(Duration::from_millis(40)).await;
                        Ok(persist_lane_run(&store, &task, index, RunStatus::Partial))
                    }
                }
            },
        )
        .await
        .unwrap();

        assert_eq!(envelope.stopped, Some(LiveBridgeError::Execution));
        assert_eq!(envelope.items.len(), 1);
        assert_eq!(envelope.lanes[0].disposition, LiveLaneDisposition::Failed);
        assert_eq!(envelope.lanes[0].error, Some(LiveBridgeError::Execution));
        assert_eq!(
            envelope.lanes[1].disposition,
            LiveLaneDisposition::Persisted
        );
        assert_eq!(
            envelope.lanes[2].disposition,
            LiveLaneDisposition::NotStarted
        );
        assert_eq!(
            store.get_run(&envelope.items[0]).unwrap().run_id,
            envelope.items[0]
        );
        let corpus_root = cache.path().join("log_corpora");
        assert!(!corpus_root.exists() || corpus_root.read_dir().unwrap().next().is_none());
    }

    #[tokio::test]
    async fn live_comparison_cancel_preserves_in_flight_durable_runs() {
        let (_library, cache, store, case, snapshot, task) = fixture();
        let cancel = CancelFlag::new();
        let started = Arc::new(Notify::new());
        let candidates = vec![
            dummy_candidate(cache.path(), &cancel, "cancel:a", None),
            dummy_candidate(cache.path(), &cancel, "cancel:b", None),
            dummy_candidate(cache.path(), &cancel, "cancel:c", None),
        ];
        let cancel_task = cancel.clone();
        let started_wait = Arc::clone(&started);
        tokio::spawn(async move {
            started_wait.notified().await;
            started_wait.notified().await;
            cancel_task.cancel();
        });
        let envelope = run_live_comparison_with_lane_fn(
            &store,
            &case,
            &snapshot,
            &task,
            candidates,
            LiveComparisonOptions::new(2).unwrap(),
            {
                let store = store.clone();
                let task = task.clone();
                let started = Arc::clone(&started);
                move |index, _prepared, candidate| {
                    let store = store.clone();
                    let task = task.clone();
                    let started = Arc::clone(&started);
                    let cancel = candidate.options.cancel.clone();
                    async move {
                        started.notify_one();
                        while !cancel.is_cancelled() {
                            tokio::time::sleep(Duration::from_millis(5)).await;
                        }
                        Ok(persist_lane_run(&store, &task, index, RunStatus::Cancelled))
                    }
                }
            },
        )
        .await
        .unwrap();

        assert_eq!(envelope.stopped, Some(LiveBridgeError::Cancelled));
        assert_eq!(envelope.items.len(), 2);
        assert_eq!(
            envelope.lanes[2].disposition,
            LiveLaneDisposition::NotStarted
        );
        for run_id in &envelope.items {
            let stored = store.get_run(run_id).unwrap();
            assert_eq!(stored.status, RunStatus::Cancelled);
        }
        let corpus_root = cache.path().join("log_corpora");
        assert!(!corpus_root.exists() || corpus_root.read_dir().unwrap().next().is_none());
    }

    #[tokio::test]
    async fn concurrent_store_writes_from_comparison_lanes_are_safe() {
        let (_library, cache, store, case, snapshot, task) = fixture();
        let cancel = CancelFlag::new();
        let candidates = (0..4)
            .map(|index| dummy_candidate(cache.path(), &cancel, &format!("cancel:{index}"), None))
            .collect();
        let envelope = run_live_comparison_with_lane_fn(
            &store,
            &case,
            &snapshot,
            &task,
            candidates,
            LiveComparisonOptions::new(3).unwrap(),
            {
                let store = store.clone();
                let task = task.clone();
                move |index, _prepared, _candidate| {
                    let store = store.clone();
                    let task = task.clone();
                    async move { Ok(persist_lane_run(&store, &task, index, RunStatus::Partial)) }
                }
            },
        )
        .await
        .unwrap();

        assert!(envelope.stopped.is_none());
        assert_eq!(envelope.items.len(), 4);
        let mut stored = store.list_runs().unwrap();
        stored.sort();
        let mut reported = envelope.items.clone();
        reported.sort();
        assert_eq!(stored, reported);
        for run_id in stored {
            let run = store.get_run(&run_id).unwrap();
            assert_eq!(run.fairness, FairnessClass::SameSnapshot);
            assert_eq!(run.timing, Observed::Unknown);
            assert_eq!(run.cost, Observed::Unknown);
        }
    }
}
