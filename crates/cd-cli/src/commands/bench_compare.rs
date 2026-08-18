//! `contextdesk bench-compare` — host-facing live comparison orchestration.
//!
//! This module is intentionally thin. The live bridge owns materialization,
//! packet proof, replay validation, persistence, and cleanup; the CLI only
//! loads the host-owned state, converts bounded candidate documents into
//! bridge options, and renders the resulting honest report.

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
    BacktestReport, BenchStore, Observed, PrivacyClass, RunAttribution, RunStatus,
    StrategyIdentity,
};
use cd_triage_bench_adapter::RecordingContext;
use cd_triage_bench_live::{
    LiveBridgeError, LiveComparisonCandidate, LiveCorpusLimits, LiveRunOptions,
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
#[derive(Debug, Clone, Deserialize)]
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
#[derive(Debug, Clone, Deserialize)]
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
}

/// Owner-only command result. Use `cd-triage-bench report --privacy
/// share-safe` for an explicitly share-safe projection.
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
    /// Bridge invariants echoed as independently auditable facts. A failed
    /// pre-packet candidate may omit the host corpus id, so the shared
    /// materialization fact is based on the validated benchmark fingerprint.
    pub same_packet_fingerprint: bool,
    pub same_materialized_corpus: bool,
    /// Per-candidate durable and provenance identities.
    pub runs: Vec<BenchComparisonRunOutput>,
    /// Existing honest comparison report over exactly these newly persisted
    /// rows; it assigns no readiness or ranking claim.
    pub report: BacktestReport,
    /// Human-readable form of the same report.
    pub report_markdown: String,
}

impl Render for BenchComparisonOutput {
    fn render_text(&self) -> String {
        let mut output = self.report_markdown.clone();
        output.push_str("\n## Same-snapshot provenance\n\n");
        output.push_str(&format!(
            "- task: `{}`\n- snapshot: `{}`\n- candidates: {}\n- same packet fingerprint: {}\n- same materialized corpus: {}\n\n",
            self.task_id,
            self.snapshot_id,
            self.candidate_count,
            self.same_packet_fingerprint,
            self.same_materialized_corpus
        ));
        for run in &self.runs {
            output.push_str(&format!(
                "- `{}`: {} — packet `{}`, corpus `{}`\n",
                run.run_id,
                run.status.as_str(),
                run.packet_fingerprint,
                run.corpus_fingerprint
            ));
        }
        output
    }

    fn render_json(&self) -> serde_json::Value {
        serde_json::to_value(self).expect("bench comparison output is serializable")
    }
}

/// Execute one bounded live comparison through the production host bridge.
pub async fn run(
    args: &BenchCompareArgs,
    paths: &Paths,
    cfg: &AppConfig,
) -> CliResult<BenchComparisonOutput> {
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
    if args.max_blob_bytes == 0 || args.max_aggregate_bytes == 0 {
        return Err(CliError::user(
            "bench-compare byte limits must both be greater than zero",
        ));
    }

    let specs = args
        .candidates
        .iter()
        .map(read_candidate)
        .collect::<CliResult<Vec<_>>>()?;
    validate_candidates(&specs)?;

    let store = BenchStore::open(&args.library)
        .map_err(|_| CliError::not_found("benchmark library could not be opened"))?;
    let task = store
        .get_task(&args.task)
        .map_err(|_| CliError::not_found("benchmark task was not found"))?;
    let case = store
        .get_case(&task.case_id)
        .map_err(|_| CliError::not_found("benchmark case linked by the task was not found"))?;
    let snapshot = store
        .get_snapshot(&task.snapshot_id)
        .map_err(|_| CliError::not_found("benchmark snapshot linked by the task was not found"))?;

    let policy_path = paths.config_dir.join("triage-policies.json");
    let policies = TriagePolicyStoreV1::load(&policy_path)
        .map_err(|_| CliError::user("saved triage policy store could not be loaded"))?;
    let qualification_path = triage_role_qualification_store_path(&paths.config_dir);
    let qualifications = TriageRoleQualificationStoreV1::load(&qualification_path)
        .map_err(|_| CliError::user("triage role qualification store could not be loaded"))?;

    let cache_root = args
        .cache_root
        .clone()
        .unwrap_or_else(|| paths.cache_root.clone());
    fs::create_dir_all(&cache_root)
        .map_err(|_| CliError::internal("could not create the live comparison cache root"))?;

    let cancel = CancelFlag::new();
    let signal_cancel = cancel.clone();
    let signal_task = tokio::spawn(async move {
        if tokio::signal::ctrl_c().await.is_ok() {
            signal_cancel.cancel();
        }
    });

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
                limits: LiveCorpusLimits {
                    max_blob_bytes: args.max_blob_bytes,
                    max_aggregate_bytes: args.max_aggregate_bytes,
                },
                cancel: cancel.clone(),
            },
            events: None,
        })
        .collect();

    let secrets: Arc<dyn SecretStore> = Arc::new(crate::adapters::secret_store());
    let live = cd_triage_bench_live::run_live_comparison(
        &store, &case, &snapshot, &task, secrets, candidates,
    )
    .await;
    signal_task.abort();

    let live = live.map_err(map_bridge_error)?;
    let mut attribution = BTreeMap::new();
    let mut runs = Vec::with_capacity(live.runs.len());
    for run in live.runs {
        let recorded = run.recorded;
        let attribution_for_run = extract_owner_model_attribution(&recorded.raw_output);
        if let Some(value) = attribution_for_run.clone() {
            attribution.insert(recorded.bench_run.run_id.clone(), value);
        }
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
    if !same_packet_fingerprint || !same_materialized_corpus {
        return Err(CliError::internal(
            "live comparison returned inconsistent same-snapshot provenance",
        ));
    }

    let persisted_runs = runs
        .iter()
        .map(|run| run.run_id.as_str())
        .collect::<BTreeSet<_>>();
    let report_runs = store
        .load_runs()
        .map_err(|_| CliError::internal("persisted comparison runs could not be reloaded"))?
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
    .map_err(|_| CliError::internal("comparison report could not be built"))?;
    let report_markdown = render_report_markdown(&report)
        .map_err(|_| CliError::internal("comparison report could not be rendered"))?;

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
        runs,
        report,
        report_markdown,
    })
}

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
        | LiveBridgeError::ComparisonInvariant => CliError::user(message),
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
