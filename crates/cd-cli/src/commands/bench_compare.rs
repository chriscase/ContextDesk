//! `contextdesk bench-compare` — host-facing live comparison orchestration.
//!
//! This module is intentionally thin. The live bridge owns materialization,
//! packet proof, replay validation, persistence, and cleanup; the CLI only
//! loads the host-owned state, converts bounded candidate documents into
//! bridge options, and renders the resulting honest report plus the adapter's
//! own share-safe projection.
//!
//! Two boundary rules live here rather than in the bridge. Cancellation is
//! armed before any blocking or provider work, and every blocking load —
//! including content-addressed snapshot verification — runs off the async
//! runtime under this command's published byte bounds.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Read;
use std::path::PathBuf;
use std::sync::Arc;

use cd_core::config::AppConfig;
use cd_core::keychain_store::SecretStore;
use cd_core::process_progress::CancelFlag;
use cd_core::triage_policy_store::TriagePolicyStoreV1;
use cd_core::triage_role_qualification::{
    triage_role_qualification_store_path, TriageRoleQualificationStoreV1,
};
use cd_triage_bench::{
    build_report_with_attribution, extract_owner_model_attribution, render_report_markdown,
    BacktestReport, BenchStore, Case, EvaluationTask, EvidenceSnapshot, Observed, PrivacyClass,
    RunAttribution, RunStatus, StrategyIdentity,
};
use cd_triage_bench_adapter::{project_share_safe, RecordingContext, ShareSafeAdapterRun};
use cd_triage_bench_live::{
    LiveBridgeError, LiveComparisonCandidate, LiveComparisonOptions, LiveCorpusLimits,
    LiveRunOptions, LiveRunResult, DEFAULT_LIVE_MAX_AGGREGATE_BYTES, DEFAULT_LIVE_MAX_BLOB_BYTES,
};
use cd_triage_sdk::{TriagePolicySelectionV2, TriageRequestOverridesV1};
use serde::{Deserialize, Serialize};

use crate::adapters::Paths;
use crate::cli::BenchCompareArgs;
use crate::envelope::{CliError, CliResult, Render};

const MAX_CANDIDATE_FILE_BYTES: u64 = 1_048_576;
const MAX_METADATA_BYTES: usize = 256;

/// Stable schema for the host-facing comparison command.
pub const BENCH_COMPARE_CLI_SCHEMA_ID: &str = "contextdesk.cli.bench_compare.v1";

/// One explicit candidate document accepted by `bench-compare`.
///
/// Candidate documents contain policy and provenance metadata only. Provider
/// credentials and endpoint configuration remain in the host-owned app
/// configuration and credential adapter.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CandidateSpec {
    /// Standard, saved, or inline policy selection.
    pub policy: TriagePolicySelectionV2,
    /// Caller-owned identity; every candidate must provide a distinct value.
    pub cancellation_id: String,
    /// Strategy and operator provenance supplied by the caller.
    pub strategy: StrategySpec,
    /// Per-candidate public request bounds.
    #[serde(default)]
    pub overrides: TriageRequestOverridesV1,
}

/// Explicit strategy/operator metadata for one comparison candidate.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StrategySpec {
    /// Human-readable strategy identity.
    pub name: String,
    /// Optional strategy release/version.
    #[serde(default)]
    pub version: Option<String>,
    /// Optional build identity.
    #[serde(default)]
    pub build: Option<String>,
    /// Explicit operator label.
    pub operator: String,
    /// Explicit RFC3339 creation time; the command never reads a clock.
    pub created_at: String,
}

/// One persisted candidate plus the exact host facts needed to audit its
/// same-snapshot relationship with the other rows.
#[derive(Debug, Clone, Serialize)]
pub struct BenchComparisonRunOutput {
    /// Durable source-neutral benchmark run identity.
    pub run_id: String,
    /// Honest terminal status; failed and partial rows are retained.
    pub status: RunStatus,
    /// Strategy identity from the recording context.
    pub strategy: StrategyIdentity,
    /// Exact model identities retained in the owner-only raw record.
    pub model_identities: Vec<String>,
    /// Share-safe model fingerprints retained by the raw record.
    pub model_fingerprints: Vec<String>,
    /// Source-neutral packet fingerprint.
    pub packet_fingerprint: String,
    /// Source-neutral corpus fingerprint.
    pub corpus_fingerprint: String,
    /// Run-exclusive production corpus identity, when packet execution began.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_corpus_id: Option<String>,
    /// Production corpus revision, when packet execution began.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_corpus_revision: Option<u64>,
    /// Production packet identity, when packet execution began.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_packet_id: Option<String>,
    /// Wall-clock allowance this candidate's request actually carried.
    ///
    /// Every candidate in one comparison receives the same allowance, so an
    /// auditor can see that list position bought nobody extra time.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_deadline_ms: Option<u64>,
}

/// Owner-only command result.
///
/// The payload as a whole is owner-only: it retains exact model identities,
/// task-linked provenance, and the owner-only comparison report. The
/// `share_safe` field inside it is the explicitly projected, scanner-gated
/// artifact that may be shared on its own.
#[derive(Debug, Clone, Serialize)]
pub struct BenchComparisonOutput {
    /// CLI payload schema.
    pub schema_id: &'static str,
    /// Stable action name.
    pub action: &'static str,
    /// Exact task/case/snapshot identities used by this comparison.
    pub task_id: String,
    pub case_id: String,
    pub snapshot_id: String,
    /// This command always retains owner-only attribution.
    pub privacy: &'static str,
    /// Number of candidates executed and persisted.
    pub candidate_count: usize,
    /// Defensive re-check that every returned row came from one preparation.
    ///
    /// These are not independent evidence: the bridge hands every candidate
    /// the same materialized packet, so a `false` here would mean the bridge
    /// itself is broken rather than that the candidates diverged. They are
    /// published because a reader can compare them against the per-run
    /// `packet_fingerprint`/`corpus_fingerprint` values below, which are the
    /// facts that actually carry the same-snapshot claim. A failed pre-packet
    /// candidate may omit the host corpus id, so the shared materialization
    /// check uses the validated benchmark fingerprint rather than that id.
    pub same_packet_fingerprint: bool,
    pub same_materialized_corpus: bool,
    /// Content-free reason when the comparison stopped before every
    /// requested candidate was durably recorded. A non-`None` value means
    /// `runs` is an honest durable prefix, not a complete comparison.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stopped_reason: Option<String>,
    /// Per-candidate durable and provenance identities.
    pub runs: Vec<BenchComparisonRunOutput>,
    /// Existing honest comparison report over exactly these newly persisted
    /// rows; it assigns no readiness or ranking claim.
    pub report: BacktestReport,
    /// Human-readable form of the same report.
    pub report_markdown: String,
    /// Explicit share-safe projection of exactly these runs.
    ///
    /// Produced by the adapter's hand-written `project_share_safe` and gated
    /// by the real share-safe scanner, so it carries fingerprints, counts and
    /// dispositions only — never an exact provider/model identity, the task
    /// text, the answer envelope, or raw output. Benchmark run rows stay
    /// owner-only in the store, so this projection — not
    /// `cd-triage-bench report --privacy share-safe` — is the share-safe
    /// artifact for a live comparison.
    pub share_safe: Vec<ShareSafeAdapterRun>,
    /// Pending isolated-corpus cleanup this cache root still carries.
    ///
    /// Non-zero means an earlier run leaked a corpus that a bounded recovery
    /// sweep could not discard yet. It never blocks this comparison.
    pub pending_cleanup_markers: usize,
    /// Maximum candidate lanes that were allowed to run at once.
    pub max_concurrency: usize,
}

impl Render for BenchComparisonOutput {
    fn render_text(&self) -> String {
        let mut output = self.report_markdown.clone();
        output.push_str("\n## Same-snapshot provenance\n\n");
        output.push_str(&format!(
            "- task: `{}`\n- snapshot: `{}`\n- candidates: {}\n- max concurrency: {}\n- same packet fingerprint: {}\n- same materialized corpus: {}\n\n",
            self.task_id,
            self.snapshot_id,
            self.candidate_count,
            self.max_concurrency,
            self.same_packet_fingerprint,
            self.same_materialized_corpus
        ));
        if let Some(reason) = &self.stopped_reason {
            output.push_str(&format!(
                "- stopped before every candidate completed: {}\n\n",
                reason
            ));
        }
        for run in &self.runs {
            output.push_str(&format!(
                "- `{}`: {} — packet `{}`, corpus `{}`, deadline {}\n",
                run.run_id,
                run.status.as_str(),
                run.packet_fingerprint,
                run.corpus_fingerprint,
                run.request_deadline_ms
                    .map_or_else(|| "unknown".to_string(), |ms| format!("{ms}ms"))
            ));
        }
        output.push_str(&format!(
            "\nShare-safe projections: {} (use the `share_safe` field of the JSON payload)\n",
            self.share_safe.len()
        ));
        if self.pending_cleanup_markers > 0 {
            output.push_str(&format!(
                "Pending isolated-corpus cleanup markers: {}\n",
                self.pending_cleanup_markers
            ));
        }
        output
    }

    fn render_json(&self) -> serde_json::Value {
        serde_json::to_value(self).expect("bench comparison output is serializable")
    }
}

/// Everything the host owns, loaded once off the async runtime.
struct LoadedHostState {
    specs: Vec<CandidateSpec>,
    store: BenchStore,
    case: Case,
    snapshot: EvidenceSnapshot,
    task: EvaluationTask,
    policies: TriagePolicyStoreV1,
    qualifications: TriageRoleQualificationStoreV1,
    cache_root: PathBuf,
}

/// Load the host-owned state this comparison needs.
///
/// Every step here is blocking filesystem work, including verifying the
/// snapshot's content-addressed blobs, so the caller runs it off the async
/// runtime. The snapshot is loaded through the store's bounded entry point:
/// the declared sizes are checked against this command's published limits
/// before a single blob byte is read, and verification then streams rather
/// than allocating a blob in memory.
fn load_host_state(
    candidates: Vec<PathBuf>,
    library: PathBuf,
    task_id: String,
    config_dir: PathBuf,
    cache_root: PathBuf,
    limits: LiveCorpusLimits,
    cancel: CancelFlag,
) -> CliResult<LoadedHostState> {
    let specs = candidates
        .iter()
        .map(read_candidate)
        .collect::<CliResult<Vec<_>>>()?;
    validate_candidates(&specs)?;

    let store = BenchStore::open(&library)
        .map_err(|_| CliError::not_found("benchmark library could not be opened"))?;
    let task = store
        .get_task(&task_id)
        .map_err(|_| CliError::not_found("benchmark task was not found"))?;
    let case = store
        .get_case(&task.case_id)
        .map_err(|_| CliError::not_found("benchmark case linked by the task was not found"))?;
    let snapshot = store
        .get_snapshot_bounded(
            &task.snapshot_id,
            limits.max_blob_bytes,
            limits.max_aggregate_bytes,
            || cancel.is_cancelled(),
        )
        .map_err(|error| match error {
            cd_triage_bench::BenchError::BlobTooLarge { .. } => CliError::user(
                "benchmark snapshot exceeds the configured per-blob or aggregate byte bound",
            ),
            cd_triage_bench::BenchError::BlobCopyCancelled { .. } => {
                CliError::cancelled("benchmark snapshot verification was cancelled")
            }
            _ => CliError::not_found("benchmark snapshot linked by the task was not found"),
        })?;

    let policy_path = config_dir.join("triage-policies.json");
    let policies = TriagePolicyStoreV1::load(&policy_path)
        .map_err(|_| CliError::user("saved triage policy store could not be loaded"))?;
    let qualification_path = triage_role_qualification_store_path(&config_dir);
    let qualifications = TriageRoleQualificationStoreV1::load(&qualification_path)
        .map_err(|_| CliError::user("triage role qualification store could not be loaded"))?;

    fs::create_dir_all(&cache_root)
        .map_err(|_| CliError::internal("could not create the live comparison cache root"))?;

    Ok(LoadedHostState {
        specs,
        store,
        case,
        snapshot,
        task,
        policies,
        qualifications,
        cache_root,
    })
}

/// Execute one bounded live comparison through the production host bridge.
pub async fn run(
    args: &BenchCompareArgs,
    paths: &Paths,
    cfg: &AppConfig,
) -> CliResult<BenchComparisonOutput> {
    run_with_live_progress(args, paths, cfg, |_index, _run| {}).await
}

/// Execute a bounded live comparison and notify the caller after each lane
/// has persisted. The callback is deliberately limited to source-neutral
/// durable output; final report construction remains owned by this command.
pub async fn run_with_live_progress<F>(
    args: &BenchCompareArgs,
    paths: &Paths,
    cfg: &AppConfig,
    on_lane_persisted: F,
) -> CliResult<BenchComparisonOutput>
where
    F: FnMut(usize, &LiveRunResult) + Send,
{
    run_with_live_lifecycle(args, paths, cfg, |_index| {}, on_lane_persisted).await
}

/// Execute a bounded live comparison with safe admission and persistence
/// notifications for a host-facing caller.
pub async fn run_with_live_lifecycle<S, F>(
    args: &BenchCompareArgs,
    paths: &Paths,
    cfg: &AppConfig,
    on_lane_started: S,
    mut on_lane_persisted: F,
) -> CliResult<BenchComparisonOutput>
where
    S: FnMut(usize) + Send,
    F: FnMut(usize, &LiveRunResult) + Send,
{
    if args.candidates.len() < 2 {
        return Err(CliError::user(
            "bench-compare requires at least two --candidate files",
        ));
    }
    if args.candidates.len() > cd_triage_bench_live::DEFAULT_MAX_COMPARISON_CANDIDATES {
        return Err(CliError::user(format!(
            "bench-compare accepts at most {} candidates",
            cd_triage_bench_live::DEFAULT_MAX_COMPARISON_CANDIDATES
        )));
    }
    let requested_candidates = args.candidates.len();
    let limits = LiveCorpusLimits {
        max_blob_bytes: args.max_blob_bytes,
        max_aggregate_bytes: args.max_aggregate_bytes,
    };
    // A host boundary bounds its callers: a limit may be lowered, never
    // raised above the production import bound the bridge publishes.
    limits.validate().map_err(|_| {
        CliError::user(format!(
            "bench-compare byte limits must be greater than zero and at most {DEFAULT_LIVE_MAX_BLOB_BYTES} per blob and {DEFAULT_LIVE_MAX_AGGREGATE_BYTES} aggregate"
        ))
    })?;
    let comparison_options = LiveComparisonOptions::new(args.concurrency).map_err(|_| {
        CliError::user(format!(
            "bench-compare --concurrency must be between 1 and {}",
            cd_triage_bench_live::MAX_LIVE_COMPARISON_CONCURRENCY
        ))
    })?;

    // Cancellation is armed before any blocking or provider work, so Ctrl-C
    // reaches snapshot verification and corpus preparation, not just the
    // provider call.
    let cancel = CancelFlag::new();
    let signal_cancel = cancel.clone();
    let signal_task = tokio::spawn(async move {
        if tokio::signal::ctrl_c().await.is_ok() {
            signal_cancel.cancel();
        }
    });
    let guard = SignalGuard {
        task: Some(signal_task),
    };

    let cache_root = args
        .cache_root
        .clone()
        .unwrap_or_else(|| paths.cache_root.clone());
    let loaded = {
        let candidates = args.candidates.clone();
        let library = args.library.clone();
        let task_id = args.task.clone();
        let config_dir = paths.config_dir.clone();
        let cache_root = cache_root.clone();
        let cancel = cancel.clone();
        tokio::task::spawn_blocking(move || {
            load_host_state(
                candidates, library, task_id, config_dir, cache_root, limits, cancel,
            )
        })
        .await
        .map_err(|_| CliError::internal("host state loading did not complete"))??
    };
    let LoadedHostState {
        specs,
        store,
        case,
        snapshot,
        task,
        policies,
        qualifications,
        cache_root,
    } = loaded;

    let candidates = specs
        .into_iter()
        .map(|spec| LiveComparisonCandidate {
            options: LiveRunOptions {
                cache_root: cache_root.clone(),
                config: cfg.clone(),
                policies: policies.clone(),
                qualifications: qualifications.clone(),
                policy: spec.policy,
                overrides: spec.overrides,
                cancellation_id: spec.cancellation_id,
                recording: RecordingContext {
                    strategy: strategy_identity(&spec.strategy),
                    operator: spec.strategy.operator,
                    created_at: spec.strategy.created_at,
                },
                limits,
                cancel: cancel.clone(),
            },
            events: None,
        })
        .collect();

    let secrets: Arc<dyn SecretStore> = Arc::new(crate::adapters::secret_store());
    let live = cd_triage_bench_live::run_live_comparison_with_options_and_lifecycle(
        &store,
        &case,
        &snapshot,
        &task,
        secrets,
        candidates,
        comparison_options,
        on_lane_started,
        |index, run| on_lane_persisted(index, run),
    )
    .await;
    drop(guard);

    let live = live.map_err(map_bridge_error)?;
    let pending_cleanup_markers = live.pending_cleanup.unresolved;
    let stopped_reason = live.stopped.map(|error| error.to_string());

    // The bridge only returns runs it already persisted. Once rows exist, no
    // failure path below may drop their identities: they are the operator's
    // only handle on durable state this command created.
    let persisted_run_ids = live
        .runs
        .iter()
        .map(|run| run.recorded.bench_run.run_id.clone())
        .collect::<Vec<_>>();
    let durable_rows = DurableRows {
        run_ids: persisted_run_ids,
        requested_candidates,
        pending_cleanup_markers,
    };

    let mut attribution = BTreeMap::new();
    let mut runs = Vec::with_capacity(live.runs.len());
    let mut share_safe = Vec::with_capacity(live.runs.len());
    for run in live.runs {
        let recorded = run.recorded;
        let attribution_for_run = extract_owner_model_attribution(&recorded.raw_output);
        if let Some(value) = attribution_for_run.clone() {
            attribution.insert(recorded.bench_run.run_id.clone(), value);
        }
        share_safe.push(
            project_share_safe(&snapshot, &task, &recorded).map_err(|_| {
                CliError::internal(
                    durable_rows.describe("share-safe comparison projection could not be produced"),
                )
            })?,
        );
        runs.push(run_output(&recorded, attribution_for_run));
    }

    let same_packet_fingerprint = runs
        .iter()
        .map(|run| run.packet_fingerprint.as_str())
        .collect::<BTreeSet<_>>()
        .len()
        == 1;
    let same_materialized_corpus = runs
        .iter()
        .map(|run| run.corpus_fingerprint.as_str())
        .collect::<BTreeSet<_>>()
        .len()
        == 1;
    let stopped_reason = if !same_packet_fingerprint || !same_materialized_corpus {
        Some("live comparison returned inconsistent same-snapshot provenance".to_string())
    } else {
        stopped_reason
    };

    let persisted_runs = runs
        .iter()
        .map(|run| run.run_id.as_str())
        .collect::<BTreeSet<_>>();
    let report_runs = store
        .load_runs()
        .map_err(|_| {
            CliError::internal(
                durable_rows.describe("persisted comparison runs could not be reloaded"),
            )
        })?
        .into_iter()
        .filter(|run| persisted_runs.contains(run.run_id.as_str()))
        .collect::<Vec<_>>();
    let report = build_report_with_attribution(
        &report_runs,
        &[],
        &[],
        std::slice::from_ref(&case),
        &attribution,
        PrivacyClass::OwnerOnly,
    )
    .map_err(|_| {
        CliError::internal(durable_rows.describe("comparison report could not be built"))
    })?;
    let report_markdown = render_report_markdown(&report).map_err(|_| {
        CliError::internal(durable_rows.describe("comparison report could not be rendered"))
    })?;

    Ok(BenchComparisonOutput {
        schema_id: BENCH_COMPARE_CLI_SCHEMA_ID,
        action: "compare",
        task_id: task.task_id,
        case_id: case.case_id,
        snapshot_id: snapshot.snapshot_id,
        privacy: "owner_only",
        candidate_count: runs.len(),
        same_packet_fingerprint,
        same_materialized_corpus,
        stopped_reason,
        runs,
        report,
        report_markdown,
        share_safe,
        pending_cleanup_markers,
        max_concurrency: comparison_options.max_concurrency,
    })
}

/// Abort the Ctrl-C listener on every exit path, including an early return.
struct SignalGuard {
    task: Option<tokio::task::JoinHandle<()>>,
}

impl Drop for SignalGuard {
    fn drop(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

/// Durable state this command created, for any message that has to report it.
struct DurableRows {
    run_ids: Vec<String>,
    requested_candidates: usize,
    pending_cleanup_markers: usize,
}

impl DurableRows {
    /// Extend a refusal with the rows an operator now has to know about.
    ///
    /// Benchmark run identities are generated, content-free values, so naming
    /// them costs no privacy and is the difference between an actionable
    /// failure and orphaned rows nobody can find.
    fn describe(&self, reason: &str) -> String {
        let mut message = format!(
            "{reason}; {} of {} candidates persisted",
            self.run_ids.len(),
            self.requested_candidates
        );
        if !self.run_ids.is_empty() {
            message.push_str(&format!(
                "; durable runs retained in the benchmark library: {}",
                self.run_ids.join(", ")
            ));
        }
        if self.pending_cleanup_markers > 0 {
            message.push_str(&format!(
                "; {} isolated corpus cleanup marker(s) still pending",
                self.pending_cleanup_markers
            ));
        }
        message
    }
}

/// Keep the exit category of the underlying refusal while carrying the
/// operator-facing detail about what is now durable.
fn read_candidate(path: &PathBuf) -> CliResult<CandidateSpec> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| CliError::user("candidate specification could not be read"))?;
    if !metadata.file_type().is_file() || metadata.len() > MAX_CANDIDATE_FILE_BYTES {
        return Err(CliError::user(
            "candidate specification must be a regular file within the size bound",
        ));
    }
    let mut file = fs::File::open(path)
        .map_err(|_| CliError::user("candidate specification could not be opened"))?;
    let mut bytes = Vec::new();
    file.by_ref()
        .take(MAX_CANDIDATE_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| CliError::user("candidate specification could not be read"))?;
    if bytes.len() as u64 > MAX_CANDIDATE_FILE_BYTES {
        return Err(CliError::user(
            "candidate specification exceeds the size bound",
        ));
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| CliError::user("candidate specification is not valid JSON"))
}

fn validate_candidates(specs: &[CandidateSpec]) -> CliResult<()> {
    let mut cancellation_ids = BTreeSet::new();
    for spec in specs {
        bounded_text("cancellation_id", &spec.cancellation_id)?;
        if !cancellation_ids.insert(spec.cancellation_id.as_str()) {
            return Err(CliError::user(
                "candidate cancellation_id values must be unique",
            ));
        }
        bounded_text("strategy.name", &spec.strategy.name)?;
        bounded_text("strategy.operator", &spec.strategy.operator)?;
        bounded_text("strategy.created_at", &spec.strategy.created_at)?;
        cd_triage_bench::validate_rfc3339("strategy.created_at", &spec.strategy.created_at)
            .map_err(|_| CliError::user("strategy.created_at must be RFC3339"))?;
        if let Some(version) = &spec.strategy.version {
            bounded_text("strategy.version", version)?;
        }
        if let Some(build) = &spec.strategy.build {
            bounded_text("strategy.build", build)?;
        }
        if let Some(deadline_ms) = spec.overrides.deadline_ms {
            if deadline_ms == 0 || deadline_ms > cd_triage_sdk::MAX_TRIAGE_REQUEST_DEADLINE_MS {
                return Err(CliError::user(
                    "candidate deadline_ms is outside the public request bound",
                ));
            }
        }
        if let Some(max_provider_calls) = spec.overrides.max_provider_calls {
            if max_provider_calls == 0
                || max_provider_calls > cd_triage_sdk::MAX_TRIAGE_REQUEST_PROVIDER_CALLS
            {
                return Err(CliError::user(
                    "candidate max_provider_calls is outside the public request bound",
                ));
            }
        }
        let encoded_policy = serde_json::to_vec(&spec.policy)
            .map_err(|_| CliError::user("candidate policy could not be encoded"))?;
        if encoded_policy.len() > cd_triage_sdk::MAX_TRIAGE_INLINE_POLICY_BYTES {
            return Err(CliError::user(
                "candidate policy exceeds the public inline-policy bound",
            ));
        }
    }
    Ok(())
}

fn bounded_text(field: &str, value: &str) -> CliResult<()> {
    if value.trim().is_empty()
        || value.len() > MAX_METADATA_BYTES
        || value.chars().any(char::is_control)
    {
        return Err(CliError::user(format!(
            "{field} is empty or outside its bound"
        )));
    }
    Ok(())
}

fn strategy_identity(spec: &StrategySpec) -> StrategyIdentity {
    StrategyIdentity {
        name: spec.name.clone(),
        version: spec
            .version
            .clone()
            .map_or(Observed::Unknown, Observed::Known),
        build: spec
            .build
            .clone()
            .map_or(Observed::Unknown, Observed::Known),
    }
}

fn run_output(
    recorded: &cd_triage_bench_adapter::RecordedContextDeskRun,
    attribution: Option<RunAttribution>,
) -> BenchComparisonRunOutput {
    let host_execution = recorded.owner_only.host_execution.as_ref();
    let attribution = attribution.unwrap_or(RunAttribution {
        model_identities: Vec::new(),
        model_fingerprints: recorded.owner_only.fingerprints.models.clone(),
    });
    BenchComparisonRunOutput {
        run_id: recorded.bench_run.run_id.clone(),
        status: recorded.bench_run.status,
        strategy: recorded.bench_run.strategy.clone(),
        model_identities: attribution.model_identities,
        model_fingerprints: attribution.model_fingerprints,
        packet_fingerprint: recorded.owner_only.fingerprints.packet.clone(),
        corpus_fingerprint: recorded.owner_only.fingerprints.corpus.clone(),
        host_corpus_id: host_execution.map(|proof| proof.corpus_id.clone()),
        host_corpus_revision: host_execution.map(|proof| proof.corpus_revision),
        host_packet_id: host_execution.map(|proof| proof.packet_id.clone()),
        request_deadline_ms: recorded.owner_only.request.overrides.deadline_ms,
    }
}

fn map_bridge_error(error: LiveBridgeError) -> CliError {
    let message = error.to_string();
    match error {
        LiveBridgeError::Cancelled => CliError::cancelled(message),
        LiveBridgeError::Deadline => {
            CliError::new(crate::envelope::ExitCategory::NotReady, message)
        }
        LiveBridgeError::Execution => CliError::provider(message),
        LiveBridgeError::Benchmark
        | LiveBridgeError::UnsupportedVisibility
        | LiveBridgeError::BoundExceeded
        | LiveBridgeError::EmptyComparison
        | LiveBridgeError::ComparisonCandidateBound
        | LiveBridgeError::ComparisonInvariant
        | LiveBridgeError::ComparisonConcurrencyBound => CliError::user(message),
        LiveBridgeError::Staging
        | LiveBridgeError::Preview
        | LiveBridgeError::Import
        | LiveBridgeError::Provenance
        | LiveBridgeError::Request
        | LiveBridgeError::Recording
        | LiveBridgeError::Persistence
        | LiveBridgeError::Cleanup
        | LiveBridgeError::FailureAndCleanup => CliError::internal(message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cd_triage_sdk::ModelRef;

    fn spec(cancellation_id: &str) -> CandidateSpec {
        CandidateSpec {
            policy: TriagePolicySelectionV2::Standard {
                model: ModelRef {
                    profile_id: "profile:test".into(),
                    model_id: "model:test".into(),
                },
            },
            cancellation_id: cancellation_id.into(),
            strategy: StrategySpec {
                name: "fixture".into(),
                version: Some("v1".into()),
                build: None,
                operator: "test".into(),
                created_at: "2026-01-15T08:00:00Z".into(),
            },
            overrides: TriageRequestOverridesV1 {
                deadline_ms: Some(10_000),
                max_provider_calls: Some(1),
            },
        }
    }

    #[test]
    fn candidate_validation_requires_distinct_cancellation_identities() {
        let error = validate_candidates(&[spec("cancel:same"), spec("cancel:same")])
            .expect_err("duplicate cancellation ids must fail");
        assert!(error.to_string().contains("must be unique"));
    }

    #[test]
    fn candidate_validation_rejects_unbounded_metadata_before_host_access() {
        let mut candidate = spec("cancel:one");
        candidate.strategy.name = "x".repeat(MAX_METADATA_BYTES + 1);
        let error = validate_candidates(&[candidate, spec("cancel:two")])
            .expect_err("oversized metadata must fail");
        assert!(error.to_string().contains("strategy.name"));
    }

    #[test]
    fn strategy_identity_preserves_unknown_optional_facts() {
        let candidate = spec("cancel:one");
        let identity = strategy_identity(&candidate.strategy);
        assert_eq!(identity.name, "fixture");
        assert_eq!(identity.version, Observed::Known("v1".into()));
        assert_eq!(identity.build, Observed::Unknown);
    }
}
