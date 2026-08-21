//! `contextdesk collab-triage-run` — the narrow host boundary for Collab.
//!
//! The Collab server owns the job and user-facing data model. This command
//! owns the sensitive execution boundary: it accepts one bounded request,
//! converts the snapshot and evidence into the source-neutral benchmark
//! library, and delegates all provider/configuration/secret work to the
//! existing `bench-compare` command path. No HTTP client or credential field
//! is defined here.

use std::collections::BTreeSet;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use cd_core::config::AppConfig;
use cd_core::process_progress::CancelFlag;
use cd_triage_bench::{
    Case, CaseLifecycle, ContentDigest, EvaluationTask, EvidenceItem, EvidenceSnapshot,
    EvidenceSource, HeldContent, PrivacyClass, ReportedProblem, VisibilityPolicy,
};
use cd_triage_sdk::{ModelRef, TriagePolicySelectionV2, TriageRequestOverridesV1};
use serde::{Deserialize, Serialize};
use tempfile::{tempdir, TempDir};

use crate::adapters::Paths;
use crate::cli::{BenchCompareArgs, CollabTriageRunArgs};
use crate::commands::bench_compare::{
    run as run_bench_compare, run_with_live_lifecycle as run_bench_compare_with_lifecycle,
    CandidateSpec, StrategySpec,
};
use crate::envelope::{CliError, CliResult, Render};

const REQUEST_SCHEMA_ID: &str = "cd-collab.triage_run_request.v1";
const RESULT_SCHEMA_ID: &str = "cd-collab.triage_run_result.v1";
const MAX_REQUEST_BYTES: u64 = 16 * 1024 * 1024;
const MAX_EVIDENCE_ITEMS: usize = 128;
const MAX_EVIDENCE_ITEM_BYTES: usize = 4 * 1024 * 1024;
const MAX_EVIDENCE_AGGREGATE_BYTES: usize = 8 * 1024 * 1024;
const MAX_CANDIDATES: usize = cd_triage_bench_live::DEFAULT_MAX_COMPARISON_CANDIDATES;
const MAX_TEXT_BYTES: usize = 4 * 1024;
const MAX_STATUS_BLOB_BYTES: u64 = 64 * 1024;
const MAX_SAFE_SUMMARY_BYTES: usize = 2 * 1024;
const MAX_SAFE_CLAIM_COUNT: usize = 8;
const MAX_SAFE_CLAIM_BYTES: usize = 320;

/// The Collab-to-host request. It deliberately has no endpoint, token,
/// authorization header, or raw provider configuration field.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CollabTriageRunRequest {
    pub schema_id: String,
    pub job_id: String,
    pub created_at: String,
    pub requested_by: String,
    pub case: CollabCase,
    pub snapshot: CollabSnapshot,
    pub question: String,
    #[serde(default)]
    pub task_fingerprint: Option<String>,
    #[serde(default)]
    pub strategy_id: Option<String>,
    #[serde(default)]
    pub policy_fingerprint: Option<String>,
    pub evidence: Vec<CollabEvidence>,
    pub candidates: Vec<CollabCandidate>,
    #[serde(default)]
    pub deadline_ms: Option<u64>,
    #[serde(default)]
    pub max_provider_calls: Option<u32>,
    /// Bounded gateway lane concurrency; the server supplies the default.
    #[serde(default)]
    pub concurrency: Option<usize>,
}

/// The non-sensitive Collab case fields needed to construct a benchmark case.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CollabCase {
    pub case_id: String,
    pub title: String,
    pub reported_problem: CollabReportedProblem,
    pub created_at: String,
    #[serde(default = "default_case_lifecycle")]
    pub lifecycle: CaseLifecycle,
}

fn default_case_lifecycle() -> CaseLifecycle {
    CaseLifecycle::Open
}

/// Collab's problem summary, kept separate from any evaluation resolution.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CollabReportedProblem {
    pub summary: String,
    #[serde(default)]
    pub reported_at: Option<String>,
    #[serde(default)]
    pub reporter: Option<String>,
    #[serde(default)]
    pub symptoms: Vec<String>,
}

/// Snapshot metadata. The generated benchmark snapshot identity comes from
/// these fields plus the decoded, content-addressed evidence bytes.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CollabSnapshot {
    pub snapshot_id: String,
    pub fingerprint: String,
    pub parent_snapshot_id: Option<String>,
    pub evidence: Vec<CollabSnapshotEvidence>,
    pub visibility: PrivacyClass,
    pub protocol_version: String,
    pub captured_at: String,
    pub captured_by: String,
    #[serde(default)]
    pub notes: Option<String>,
}

/// The exact manifest fields used by Collab's snapshot fingerprint. Keeping
/// this alongside the bytes request lets the host verify that the evidence it
/// materializes is the same frozen manifest the server authorized.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CollabSnapshotEvidence {
    pub evidence_id: String,
    pub ordinal: u64,
    pub content_hash: Option<String>,
    pub expected_hash: Option<String>,
    pub verification_status: Option<String>,
    pub privacy_class: PrivacyClass,
}

/// One bounded base64 evidence item. Raw bytes are written only to the
/// host-owned benchmark blob store and are never copied into the result.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CollabEvidence {
    pub item_id: String,
    pub bytes_base64: String,
    #[serde(default = "default_capture_time")]
    pub capture_time: String,
    #[serde(default = "default_reference")]
    pub reference: String,
    #[serde(default = "default_captured_from")]
    pub captured_from: String,
    #[serde(default = "default_media_type")]
    pub media_type: String,
    #[serde(default = "default_format")]
    pub format: String,
    #[serde(default = "default_visible")]
    pub visible_to_strategies: bool,
}

fn default_capture_time() -> String {
    "1970-01-01T00:00:00Z".into()
}
fn default_reference() -> String {
    "collab evidence item".into()
}
fn default_captured_from() -> String {
    "ContextDesk Collab".into()
}
fn default_media_type() -> String {
    "application/octet-stream".into()
}
fn default_format() -> String {
    "raw".into()
}
fn default_visible() -> bool {
    true
}

/// Explicit model/profile/role selection supplied by the Collab caller.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CollabCandidate {
    pub candidate_id: String,
    #[serde(default)]
    pub provider: Option<String>,
    pub profile_id: String,
    pub model_id: String,
    pub role: String,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub build: Option<String>,
    #[serde(default)]
    pub cancellation_id: Option<String>,
}

/// Stable, owner-only result. Model/profile identity is included because the
/// host caller requested it; evidence bytes, prompts, secrets, and endpoints
/// are intentionally absent.
#[derive(Debug, Clone, Serialize)]
pub struct CollabTriageRunOutput {
    pub schema_id: &'static str,
    pub action: &'static str,
    pub job_id: String,
    pub case_id: String,
    pub collab_snapshot_id: String,
    pub collab_snapshot_fingerprint: String,
    pub benchmark_task_id: String,
    pub benchmark_snapshot_id: String,
    pub same_snapshot: bool,
    pub candidates: Vec<CollabCandidateResult>,
}

/// One durable candidate result and the provenance needed by Collab to attach
/// it to a job and later open it in Experiment Lab.
#[derive(Debug, Clone, Serialize)]
pub struct CollabCandidateResult {
    pub candidate_id: String,
    pub profile_id: String,
    pub model_id: String,
    pub role: String,
    pub status: String,
    pub run_id: Option<String>,
    /// Safe operator-facing status text; never the raw provider answer.
    pub summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    pub output_hash: Option<String>,
    pub evidence_refs: Vec<String>,
    pub packet_fingerprint: Option<String>,
    pub corpus_fingerprint: Option<String>,
    pub usage: &'static str,
    pub cost: &'static str,
}

/// Safe side-channel event emitted only when the host has durably persisted a
/// lane. It intentionally contains the same bounded projection that Collab
/// receives in the final result, never the provider answer or prompt.
#[derive(Debug, Clone, Serialize)]
struct CollabTriageProgressEvent {
    schema_id: &'static str,
    action: &'static str,
    job_id: String,
    case_id: String,
    collab_snapshot_id: String,
    collab_snapshot_fingerprint: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    candidate: Option<CollabCandidateResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    candidate_id: Option<String>,
}

const PROGRESS_EVENT_PREFIX: &str = "contextdesk.collab_triage_progress ";

impl Render for CollabTriageRunOutput {
    fn render_text(&self) -> String {
        format!(
            "Collab triage job {} completed: {} candidates on snapshot {}\n{}",
            self.job_id,
            self.candidates.len(),
            self.benchmark_snapshot_id,
            self.candidates
                .iter()
                .map(|candidate| format!(
                    "- {} / {}: {} (run {})",
                    candidate.role,
                    candidate.model_id,
                    candidate.status,
                    candidate.run_id.as_deref().unwrap_or("not persisted")
                ))
                .collect::<Vec<_>>()
                .join("\n")
        )
    }

    fn render_json(&self) -> serde_json::Value {
        serde_json::to_value(self).expect("Collab triage output is serializable")
    }
}

struct MaterializedLibrary {
    path: PathBuf,
    task_id: String,
    _temporary: Option<TempDir>,
}

/// Abort the preparation Ctrl-C listener on every exit path.
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

/// Execute one bounded Collab request through the existing production bridge.
pub async fn run(
    args: &CollabTriageRunArgs,
    paths: &Paths,
    cfg: &AppConfig,
) -> CliResult<CollabTriageRunOutput> {
    let request = read_request(&args.request)?;
    validate_request(&request)?;
    // Cover host-owned snapshot and candidate preparation. The downstream
    // bench command arms its own listener for provider work.
    let cancel = CancelFlag::new();
    let signal_cancel = cancel.clone();
    let signal_task = tokio::spawn(async move {
        if tokio::signal::ctrl_c().await.is_ok() {
            signal_cancel.cancel();
        }
    });
    let _signal_guard = SignalGuard {
        task: Some(signal_task),
    };
    let library = materialize_library(&request, args.library.as_deref(), &cancel)?;
    if cancel.is_cancelled() {
        return Err(CliError::cancelled(
            "live gateway run cancelled during snapshot preparation",
        ));
    }
    let candidate_dir =
        tempdir().map_err(|_| CliError::internal("could not create private candidate staging"))?;
    let candidate_paths = write_candidates(&request, candidate_dir.path(), &cancel)?;
    if cancel.is_cancelled() {
        return Err(CliError::cancelled(
            "live gateway run cancelled during candidate preparation",
        ));
    }

    let compare_args = BenchCompareArgs {
        library: library.path.clone(),
        task: library.task_id.clone(),
        candidates: candidate_paths,
        cache_root: args.cache_root.clone(),
        max_blob_bytes: args.max_blob_bytes,
        max_aggregate_bytes: args.max_aggregate_bytes,
        concurrency: request
            .concurrency
            .unwrap_or(cd_triage_bench_live::DEFAULT_LIVE_COMPARISON_CONCURRENCY),
    };
    let comparison = if args.progress_events {
        run_bench_compare_with_lifecycle(
            &compare_args,
            paths,
            cfg,
            |index| emit_started_event(&request, index),
            |index, live| emit_progress_event(&request, index, live),
        )
        .await?
    } else {
        run_bench_compare(&compare_args, paths, cfg).await?
    };
    if comparison.runs.len() > request.candidates.len() {
        return Err(CliError::internal(
            "live comparison returned more candidate results than requested",
        ));
    }

    let store = cd_triage_bench::BenchStore::open(&library.path)
        .map_err(|_| CliError::internal("benchmark result library could not be reopened"))?;
    let stopped_status = comparison
        .stopped_reason
        .as_deref()
        .map(stopped_candidate_status);
    let stopped_error = comparison.stopped_reason.as_deref().map(stopped_error_code);
    let mut candidates = Vec::with_capacity(request.candidates.len());
    for (index, candidate) in request.candidates.iter().enumerate() {
        let Some(run) = comparison.runs.get(index) else {
            let status = stopped_status.unwrap_or("failed");
            candidates.push(CollabCandidateResult {
                candidate_id: candidate.candidate_id.clone(),
                profile_id: candidate.profile_id.clone(),
                model_id: candidate.model_id.clone(),
                role: candidate.role.clone(),
                status: status.into(),
                run_id: None,
                summary: safe_missing_summary(status),
                error_code: Some(stopped_error.unwrap_or("live_run_stopped").into()),
                output_hash: None,
                evidence_refs: Vec::new(),
                packet_fingerprint: None,
                corpus_fingerprint: None,
                usage: "unknown",
                cost: "unknown",
            });
            continue;
        };
        let durable = store
            .get_run(&run.run_id)
            .map_err(|_| CliError::internal("durable live run could not be reloaded"))?;
        let mut evidence_refs = durable
            .claims
            .iter()
            .filter_map(|claim| claim.evidence_item_id.clone())
            .collect::<Vec<_>>();
        evidence_refs.sort();
        evidence_refs.dedup();
        candidates.push(CollabCandidateResult {
            candidate_id: candidate.candidate_id.clone(),
            profile_id: candidate.profile_id.clone(),
            model_id: candidate.model_id.clone(),
            role: candidate.role.clone(),
            status: durable.status.as_str().into(),
            run_id: Some(durable.run_id.clone()),
            summary: safe_run_summary(&durable),
            error_code: safe_error_code(&store, &durable),
            output_hash: Some(durable.raw_output.digest.hex),
            evidence_refs,
            packet_fingerprint: Some(run.packet_fingerprint.clone()),
            corpus_fingerprint: Some(run.corpus_fingerprint.clone()),
            usage: "unknown",
            cost: "unknown",
        });
    }
    Ok(CollabTriageRunOutput {
        schema_id: RESULT_SCHEMA_ID,
        action: "collab_triage_run",
        job_id: request.job_id,
        case_id: request.case.case_id,
        collab_snapshot_id: request.snapshot.snapshot_id,
        collab_snapshot_fingerprint: request.snapshot.fingerprint,
        benchmark_task_id: comparison.task_id,
        benchmark_snapshot_id: comparison.snapshot_id,
        same_snapshot: comparison.same_packet_fingerprint && comparison.same_materialized_corpus,
        candidates,
    })
}

fn safe_result_summary(status: &str) -> String {
    match status {
        "completed" => "Live gateway run completed; open the benchmark record for the owner-only answer.".into(),
        "partial" => "Live gateway run produced a partial result; review the completed and missing lanes separately.".into(),
        "timed_out" => "Live gateway run timed out before every lane completed.".into(),
        "cancelled" => "Live gateway run was cancelled before every lane completed.".into(),
        _ => "Live gateway run did not produce a model answer; inspect its recorded provenance.".into(),
    }
}

fn emit_progress_event(
    request: &CollabTriageRunRequest,
    index: usize,
    live: &cd_triage_bench_live::LiveRunResult,
) {
    let Some(candidate) = request.candidates.get(index) else {
        return;
    };
    let durable = &live.recorded.bench_run;
    let mut evidence_refs = durable
        .claims
        .iter()
        .filter_map(|claim| claim.evidence_item_id.clone())
        .collect::<Vec<_>>();
    evidence_refs.sort();
    evidence_refs.dedup();
    let event = CollabTriageProgressEvent {
        schema_id: "cd-collab.triage_run_progress.v1",
        action: "candidate_persisted",
        job_id: request.job_id.clone(),
        case_id: request.case.case_id.clone(),
        collab_snapshot_id: request.snapshot.snapshot_id.clone(),
        collab_snapshot_fingerprint: request.snapshot.fingerprint.clone(),
        candidate: Some(CollabCandidateResult {
            candidate_id: candidate.candidate_id.clone(),
            profile_id: candidate.profile_id.clone(),
            model_id: candidate.model_id.clone(),
            role: candidate.role.clone(),
            status: durable.status.as_str().into(),
            run_id: Some(durable.run_id.clone()),
            summary: safe_run_summary(durable),
            error_code: None,
            output_hash: Some(durable.raw_output.digest.hex.clone()),
            evidence_refs,
            packet_fingerprint: Some(live.recorded.owner_only.fingerprints.packet.clone()),
            corpus_fingerprint: Some(live.recorded.owner_only.fingerprints.corpus.clone()),
            usage: "unknown",
            cost: "unknown",
        }),
        candidate_id: None,
    };
    if let Ok(json) = serde_json::to_string(&event) {
        eprintln!("{PROGRESS_EVENT_PREFIX}{json}");
    }
}

fn emit_started_event(request: &CollabTriageRunRequest, index: usize) {
    let Some(candidate) = request.candidates.get(index) else {
        return;
    };
    let event = CollabTriageProgressEvent {
        schema_id: "cd-collab.triage_run_progress.v1",
        action: "candidate_started",
        job_id: request.job_id.clone(),
        case_id: request.case.case_id.clone(),
        collab_snapshot_id: request.snapshot.snapshot_id.clone(),
        collab_snapshot_fingerprint: request.snapshot.fingerprint.clone(),
        candidate: None,
        candidate_id: Some(candidate.candidate_id.clone()),
    };
    if let Ok(json) = serde_json::to_string(&event) {
        eprintln!("{PROGRESS_EVENT_PREFIX}{json}");
    }
}

/// Project only the evidence-linked claim text into Collab's bounded result
/// summary. The provider answer, prompt, and raw replay remain in the
/// owner-only benchmark store. This gives the War Room something useful to
/// compare without making the host boundary a raw-output transport.
fn safe_run_summary(run: &cd_triage_bench::TriageRun) -> String {
    let claims = run
        .claims
        .iter()
        .take(MAX_SAFE_CLAIM_COUNT)
        .filter_map(|claim| {
            let text = claim.claim.split_whitespace().collect::<Vec<_>>().join(" ");
            if text.is_empty() || !safe_projected_text(&text) {
                return None;
            }
            let bounded = text.chars().take(MAX_SAFE_CLAIM_BYTES).collect::<String>();
            let evidence = claim
                .evidence_item_id
                .as_deref()
                .map(|value| format!(" [evidence {value}]"))
                .unwrap_or_default();
            Some(format!("{bounded}{evidence}"))
        })
        .collect::<Vec<_>>();
    if claims.is_empty() {
        return safe_result_summary(run.status.as_str());
    }
    let mut summary = format!("Evidence-linked claims: {}", claims.join(" • "));
    if summary.len() > MAX_SAFE_SUMMARY_BYTES {
        summary.truncate(MAX_SAFE_SUMMARY_BYTES);
        summary.push('…');
    }
    summary
}

fn safe_projected_text(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    cd_triage_sdk::scan_share_safe_text(value).is_empty()
        && !lower.contains("xai-")
        && !lower.contains("ghp_")
        && !lower.contains("token=")
        && !lower.contains("password=")
        && !lower.contains("credential=")
        && !lower.contains("private key")
        && !lower.contains("-----begin")
        && !lower.contains("request_id")
        && !lower.contains("request-id")
        && !lower.contains("x-request-id")
        && !lower.contains("trace_id")
        && !lower.contains("span_id")
        && !lower.contains("/users/")
        && !lower.contains("/home/")
        && !lower.contains("/private/")
        && !lower.contains("/var/folders/")
        && !lower.contains("/tmp/")
        && !lower.contains("c:\\users\\")
        && !value
            .chars()
            .any(|character| character == '\0' || character.is_control())
}

fn safe_missing_summary(status: &str) -> String {
    match status {
        "cancelled" => {
            "Live gateway lane was not started because the comparison was cancelled.".into()
        }
        "timed_out" => "Live gateway lane was not started before the comparison deadline.".into(),
        _ => "Live gateway lane was not persisted because the comparison stopped early.".into(),
    }
}

fn stopped_candidate_status(reason: &str) -> &'static str {
    if reason.contains("cancel") {
        "cancelled"
    } else if reason.contains("deadline") || reason.contains("elapsed") {
        "timed_out"
    } else {
        "failed"
    }
}

fn stopped_error_code(reason: &str) -> &'static str {
    if reason.contains("cancel") {
        "cancel_requested"
    } else if reason.contains("deadline") || reason.contains("elapsed") {
        "deadline_exceeded"
    } else {
        "gateway_runner_error"
    }
}

/// Extract only a small allow-listed terminal classification from the durable
/// replay envelope. Raw answers, prompts, evidence, and provider details stay
/// in the host-owned benchmark blob store.
fn safe_error_code(
    store: &cd_triage_bench::BenchStore,
    run: &cd_triage_bench::TriageRun,
) -> Option<String> {
    if run.status.as_str() == "completed" {
        return None;
    }
    let fallback = match run.status.as_str() {
        "timed_out" => "deadline_exceeded",
        "cancelled" => "cancelled",
        _ => "live_run_failed",
    };
    let Ok(raw) = store.get_blob_bounded(&run.raw_output.digest.hex, MAX_STATUS_BLOB_BYTES) else {
        return Some(fallback.into());
    };
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(&raw) else {
        return Some(fallback.into());
    };
    safe_terminal_code(&value).or_else(|| Some(fallback.into()))
}

/// Project a bounded, allow-listed terminal or partial-result reason without
/// exposing provider text or arbitrary host error strings.
fn safe_terminal_code(value: &serde_json::Value) -> Option<String> {
    let terminal = value.get("terminal")?;
    if let Some(reason) = terminal
        .get("reason_codes")
        .and_then(serde_json::Value::as_array)
        .and_then(|reasons| {
            reasons
                .iter()
                .filter_map(serde_json::Value::as_str)
                .find_map(allowlisted_status_code)
        })
    {
        return Some(reason);
    }
    terminal
        .get("category")
        .and_then(serde_json::Value::as_str)
        .and_then(allowlisted_status_code)
}

fn allowlisted_status_code(value: &str) -> Option<String> {
    match value {
        "policy_preflight_rejected"
        | "provider_error"
        | "provider_failed"
        | "provider_rate_limited"
        | "provider_unavailable"
        | "provider_call_budget_exhausted"
        | "deadline"
        | "deadline_exceeded"
        | "cancelled"
        | "replay_invalid"
        | "packet_proof_observer_failed"
        | "root_cause_not_established"
        | "no_authoritative_answer"
        | "malformed_proposal"
        | "host_validation_unconfigured" => Some(value.into()),
        _ => None,
    }
}

fn read_request(path: &Path) -> CliResult<CollabTriageRunRequest> {
    let mut bytes = Vec::new();
    if path == Path::new("-") {
        io::stdin()
            .lock()
            .take(MAX_REQUEST_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| CliError::user("Collab request could not be read"))?;
    } else {
        let metadata = fs::metadata(path)
            .map_err(|_| CliError::user("Collab request file could not be read"))?;
        if !metadata.is_file() || metadata.len() > MAX_REQUEST_BYTES {
            return Err(CliError::user(
                "Collab request exceeds the bounded input size",
            ));
        }
        fs::File::open(path)
            .and_then(|mut file| file.read_to_end(&mut bytes))
            .map_err(|_| CliError::user("Collab request could not be read"))?;
    }
    if bytes.len() as u64 > MAX_REQUEST_BYTES {
        return Err(CliError::user(
            "Collab request exceeds the bounded input size",
        ));
    }
    serde_json::from_slice(&bytes).map_err(|_| CliError::user("Collab request JSON is malformed"))
}

fn validate_request(request: &CollabTriageRunRequest) -> CliResult<()> {
    if request.schema_id != REQUEST_SCHEMA_ID {
        return Err(CliError::user("unsupported Collab triage request schema"));
    }
    for (field, value) in [
        ("job_id", request.job_id.as_str()),
        ("case_id", request.case.case_id.as_str()),
        ("snapshot_id", request.snapshot.snapshot_id.as_str()),
    ] {
        cd_triage_bench::types::validate_id(field, value)
            .map_err(|_| CliError::user("Collab request contains an invalid identity"))?;
    }
    // The authenticated actor may be a local username or an LDAP DN. It is
    // bounded attribution text, not a filesystem-backed benchmark identity.
    validate_text(&request.requested_by, "requested_by")?;
    if request.snapshot.fingerprint.len() != 64
        || !request
            .snapshot
            .fingerprint
            .chars()
            .all(|value| value.is_ascii_hexdigit())
    {
        return Err(CliError::user("Collab snapshot fingerprint is invalid"));
    }
    validate_snapshot_manifest(request)?;
    if request.candidates.is_empty() || request.candidates.len() > MAX_CANDIDATES {
        return Err(CliError::user(
            "Collab request candidate count is out of bounds",
        ));
    }
    if request.evidence.is_empty() || request.evidence.len() > MAX_EVIDENCE_ITEMS {
        return Err(CliError::user(
            "Collab request evidence count is out of bounds",
        ));
    }
    validate_text(&request.question, "question")?;
    validate_text(&request.created_at, "created_at")?;
    if let Some(value) = &request.task_fingerprint {
        validate_text(value, "task_fingerprint")?;
    }
    if let Some(value) = &request.policy_fingerprint {
        validate_text(value, "policy_fingerprint")?;
    }
    for candidate in &request.candidates {
        cd_triage_bench::types::validate_id("candidate identity", &candidate.candidate_id)
            .map_err(|_| CliError::user("Collab request contains an invalid candidate identity"))?;
        ModelRef {
            profile_id: candidate.profile_id.clone(),
            model_id: candidate.model_id.clone(),
        }
        .validate()
        .map_err(|_| CliError::user("Collab request contains an invalid model reference"))?;
        validate_text(&candidate.role, "candidate role")?;
        if let Some(provider) = &candidate.provider {
            validate_text(provider, "candidate provider")?;
        }
    }
    let mut ids = BTreeSet::new();
    if request
        .candidates
        .iter()
        .any(|candidate| !ids.insert(candidate.candidate_id.as_str()))
    {
        return Err(CliError::user(
            "Collab request candidate ids must be unique",
        ));
    }
    let mut total = 0usize;
    for evidence in &request.evidence {
        cd_triage_bench::types::validate_id("evidence item_id", &evidence.item_id)
            .map_err(|_| CliError::user("Collab request contains an invalid evidence identity"))?;
        let bytes = BASE64
            .decode(&evidence.bytes_base64)
            .map_err(|_| CliError::user("Collab evidence contains malformed base64"))?;
        if bytes.is_empty() || bytes.len() > MAX_EVIDENCE_ITEM_BYTES {
            return Err(CliError::user(
                "Collab evidence item exceeds the bounded size",
            ));
        }
        total = total
            .checked_add(bytes.len())
            .ok_or_else(|| CliError::user("Collab evidence aggregate size overflowed"))?;
        if total > MAX_EVIDENCE_AGGREGATE_BYTES {
            return Err(CliError::user(
                "Collab evidence exceeds the aggregate bound",
            ));
        }
    }
    if request.deadline_ms.is_some_and(|value| value == 0)
        || request.max_provider_calls.is_some_and(|value| value == 0)
        || request.concurrency.is_some_and(|value| {
            value == 0 || value > cd_triage_bench_live::MAX_LIVE_COMPARISON_CONCURRENCY
        })
    {
        return Err(CliError::user(
            "Collab request execution bounds must be positive and concurrency must not exceed the host ceiling",
        ));
    }
    Ok(())
}

fn validate_snapshot_manifest(request: &CollabTriageRunRequest) -> CliResult<()> {
    let snapshot = &request.snapshot;
    validate_text(&snapshot.protocol_version, "snapshot protocol_version")?;
    if let Some(parent) = &snapshot.parent_snapshot_id {
        cd_triage_bench::types::validate_id("parent_snapshot_id", parent)
            .map_err(|_| CliError::user("Collab snapshot parent identity is invalid"))?;
    }
    if snapshot.evidence.len() != request.evidence.len() {
        return Err(CliError::user(
            "Collab snapshot manifest does not cover the evidence request",
        ));
    }
    let mut manifest_ids = BTreeSet::new();
    for item in &snapshot.evidence {
        cd_triage_bench::types::validate_id("snapshot evidence_id", &item.evidence_id)
            .map_err(|_| CliError::user("Collab snapshot contains an invalid evidence identity"))?;
        validate_optional_hash(item.content_hash.as_deref(), "snapshot content_hash")?;
        validate_optional_hash(item.expected_hash.as_deref(), "snapshot expected_hash")?;
        if let Some(status) = &item.verification_status {
            validate_text(status, "snapshot verification_status")?;
        }
        if !manifest_ids.insert(item.evidence_id.as_str()) {
            return Err(CliError::user(
                "Collab snapshot manifest contains duplicate evidence",
            ));
        }
    }
    for (index, evidence) in request.evidence.iter().enumerate() {
        let Some(manifest) = snapshot
            .evidence
            .iter()
            .find(|item| item.evidence_id == evidence.item_id)
        else {
            return Err(CliError::user(
                "Collab snapshot manifest and evidence request differ",
            ));
        };
        if manifest.ordinal != index as u64 {
            return Err(CliError::user(
                "Collab snapshot evidence ordinals are not stable",
            ));
        }
    }
    let expected = collab_snapshot_fingerprint(snapshot)?;
    if snapshot.fingerprint != expected {
        return Err(CliError::user(
            "Collab snapshot fingerprint does not match its manifest",
        ));
    }
    Ok(())
}

fn validate_optional_hash(value: Option<&str>, field: &str) -> CliResult<()> {
    if let Some(value) = value {
        if value.len() != 64 || !value.chars().all(|character| character.is_ascii_hexdigit()) {
            return Err(CliError::user(format!("{field} is invalid")));
        }
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotFingerprintInput<'a> {
    parent_snapshot_id: &'a Option<String>,
    evidence: Vec<SnapshotFingerprintEvidence<'a>>,
    visibility: PrivacyClass,
    protocol_version: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotFingerprintEvidence<'a> {
    evidence_id: &'a str,
    ordinal: u64,
    content_hash: Option<&'a str>,
    expected_hash: Option<&'a str>,
    verification_status: Option<&'a str>,
    privacy_class: PrivacyClass,
}

fn collab_snapshot_fingerprint(snapshot: &CollabSnapshot) -> CliResult<String> {
    let mut evidence = snapshot
        .evidence
        .iter()
        .map(|item| SnapshotFingerprintEvidence {
            evidence_id: &item.evidence_id,
            ordinal: item.ordinal,
            content_hash: item.content_hash.as_deref(),
            expected_hash: item.expected_hash.as_deref(),
            verification_status: item.verification_status.as_deref(),
            privacy_class: item.privacy_class,
        })
        .collect::<Vec<_>>();
    evidence.sort_by(|left, right| left.evidence_id.cmp(right.evidence_id));
    let canonical = serde_json::to_vec(&SnapshotFingerprintInput {
        parent_snapshot_id: &snapshot.parent_snapshot_id,
        evidence,
        visibility: snapshot.visibility,
        protocol_version: &snapshot.protocol_version,
    })
    .map_err(|_| CliError::internal("Collab snapshot fingerprint could not be encoded"))?;
    Ok(cd_triage_bench::sha256_hex(&canonical))
}

fn validate_text(value: &str, field: &str) -> CliResult<()> {
    if value.trim().is_empty() || value.len() > MAX_TEXT_BYTES || value.contains('\0') {
        return Err(CliError::user(format!("Collab request {field} is invalid")));
    }
    Ok(())
}

fn materialize_library(
    request: &CollabTriageRunRequest,
    configured: Option<&Path>,
    cancel: &CancelFlag,
) -> CliResult<MaterializedLibrary> {
    let temporary = if let Some(path) = configured {
        if path.exists() {
            if !path.is_dir() {
                return Err(CliError::user(
                    "configured benchmark library is not a directory",
                ));
            }
            None
        } else {
            fs::create_dir_all(path)
                .map_err(|_| CliError::user("configured benchmark library could not be created"))?;
            None
        }
    } else {
        Some(tempdir().map_err(|_| CliError::internal("temporary benchmark library failed"))?)
    };
    let path = configured
        .map(Path::to_path_buf)
        .or_else(|| temporary.as_ref().map(|dir| dir.path().to_path_buf()))
        .expect("library path exists");
    let store = if path.join("library.json").exists() {
        cd_triage_bench::BenchStore::open(&path)
            .map_err(|_| CliError::conflict("configured benchmark library is invalid"))?
    } else {
        cd_triage_bench::BenchStore::init(&path, &request.created_at)
            .map_err(|_| CliError::user("benchmark library could not be initialized"))?
    };
    let case = Case {
        schema_id: "contextdesk.triage_bench.case.v1".into(),
        case_id: request.case.case_id.clone(),
        privacy: PrivacyClass::OwnerOnly,
        title: request.case.title.clone(),
        reported_problem: ReportedProblem {
            summary: request.case.reported_problem.summary.clone(),
            reported_at: request.case.reported_problem.reported_at.clone(),
            reporter: request.case.reported_problem.reporter.clone(),
            symptoms: request.case.reported_problem.symptoms.clone(),
        },
        lifecycle: request.case.lifecycle,
        timeline_notes: Vec::new(),
        created_at: request.case.created_at.clone(),
        resolution: None,
    };
    let mut items = Vec::with_capacity(request.evidence.len());
    for evidence in &request.evidence {
        if cancel.is_cancelled() {
            return Err(CliError::cancelled(
                "live gateway run cancelled during evidence preparation",
            ));
        }
        let bytes = BASE64
            .decode(&evidence.bytes_base64)
            .map_err(|_| CliError::user("Collab evidence contains malformed base64"))?;
        let manifest = request
            .snapshot
            .evidence
            .iter()
            .find(|item| item.evidence_id == evidence.item_id)
            .ok_or_else(|| {
                CliError::user("Collab snapshot manifest and evidence request differ")
            })?;
        let actual_hash = ContentDigest::of_bytes(&bytes).hex;
        if manifest.content_hash.as_deref() != Some(actual_hash.as_str()) {
            return Err(CliError::user(
                "Collab evidence content does not match the frozen snapshot hash",
            ));
        }
        let digest = ContentDigest::of_bytes(&bytes);
        store
            .put_blob(&bytes)
            .map_err(|_| CliError::internal("evidence blob could not be persisted"))?;
        items.push(EvidenceItem::Log {
            item_id: evidence.item_id.clone(),
            privacy: manifest.privacy_class,
            capture_time: evidence.capture_time.clone(),
            source: EvidenceSource {
                reference: evidence.reference.clone(),
                captured_from: evidence.captured_from.clone(),
            },
            media_type: evidence.media_type.clone(),
            format: evidence.format.clone(),
            content: HeldContent {
                digest,
                byte_length: bytes.len() as u64,
            },
            summaries: Vec::new(),
            visible_to_strategies: evidence.visible_to_strategies,
        });
    }
    let snapshot = EvidenceSnapshot::from_parts(
        request.snapshot.visibility,
        request.case.case_id.clone(),
        request.snapshot.captured_at.clone(),
        request.snapshot.captured_by.clone(),
        items,
        request.snapshot.notes.clone(),
    )
    .map_err(|_| CliError::user("Collab snapshot failed validation"))?;
    let visible_ids = snapshot
        .items
        .iter()
        .filter(|item| item.visible_to_strategies())
        .map(|item| item.item_id().to_string())
        .collect::<Vec<_>>();
    if visible_ids.is_empty() {
        return Err(CliError::user("Collab snapshot has no visible evidence"));
    }
    // A Collab snapshot may be marked share-safe while the case metadata is
    // still owner-only. The host must not claim that the whole task is safe
    // to share merely because its selected evidence is; retain the stricter
    // case boundary on the benchmark task and let the snapshot carry its own
    // narrower visibility declaration.
    let task = EvaluationTask::from_parts(
        PrivacyClass::OwnerOnly,
        request.case.case_id.clone(),
        snapshot.snapshot_id.clone(),
        request.question.clone(),
        "collab-triage".into(),
        "v1".into(),
        VisibilityPolicy {
            visible_item_ids: visible_ids,
            include_summaries: false,
            include_raw_bytes: true,
        },
        None,
        request.created_at.clone(),
    )
    .map_err(|_| CliError::user("Collab task failed validation"))?;
    put_same_or_reject_case(&store, &case)?;
    put_same_or_reject_snapshot(&store, &snapshot)?;
    put_same_or_reject_task(&store, &task)?;
    Ok(MaterializedLibrary {
        path,
        task_id: task.task_id,
        _temporary: temporary,
    })
}

fn put_same_or_reject_case(store: &cd_triage_bench::BenchStore, case: &Case) -> CliResult<()> {
    if store
        .list_cases()
        .map_err(|_| CliError::internal("case index could not be read"))?
        .contains(&case.case_id)
    {
        let existing = store
            .get_case(&case.case_id)
            .map_err(|_| CliError::conflict("configured case could not be read"))?;
        if existing != *case {
            return Err(CliError::conflict(
                "configured library contains a different case",
            ));
        }
        return Ok(());
    }
    store
        .put_case(case)
        .map_err(|_| CliError::user("case could not be persisted"))
}

fn put_same_or_reject_snapshot(
    store: &cd_triage_bench::BenchStore,
    snapshot: &EvidenceSnapshot,
) -> CliResult<()> {
    if store
        .list_snapshots()
        .map_err(|_| CliError::internal("snapshot index could not be read"))?
        .contains(&snapshot.snapshot_id)
    {
        let existing = store
            .get_snapshot(&snapshot.snapshot_id)
            .map_err(|_| CliError::conflict("configured snapshot could not be read"))?;
        if existing != *snapshot {
            return Err(CliError::conflict(
                "configured library contains a different snapshot",
            ));
        }
        return Ok(());
    }
    store
        .put_snapshot(snapshot)
        .map_err(|_| CliError::user("snapshot could not be persisted"))
}

fn put_same_or_reject_task(
    store: &cd_triage_bench::BenchStore,
    task: &EvaluationTask,
) -> CliResult<()> {
    if store
        .list_tasks()
        .map_err(|_| CliError::internal("task index could not be read"))?
        .contains(&task.task_id)
    {
        let existing = store
            .get_task(&task.task_id)
            .map_err(|_| CliError::conflict("configured task could not be read"))?;
        if existing != *task {
            return Err(CliError::conflict(
                "configured library contains a different task",
            ));
        }
        return Ok(());
    }
    store
        .put_task(task)
        .map_err(|_| CliError::user("task could not be persisted"))
}

fn write_candidates(
    request: &CollabTriageRunRequest,
    dir: &Path,
    cancel: &CancelFlag,
) -> CliResult<Vec<PathBuf>> {
    let overrides = TriageRequestOverridesV1 {
        deadline_ms: request.deadline_ms,
        max_provider_calls: request.max_provider_calls,
    };
    request
        .candidates
        .iter()
        .enumerate()
        .map(|(index, candidate)| {
            if cancel.is_cancelled() {
                return Err(CliError::cancelled(
                    "live gateway run cancelled during candidate preparation",
                ));
            }
            let spec = CandidateSpec {
                policy: TriagePolicySelectionV2::Standard {
                    model: ModelRef {
                        profile_id: candidate.profile_id.clone(),
                        model_id: candidate.model_id.clone(),
                    },
                },
                cancellation_id: candidate
                    .cancellation_id
                    .clone()
                    .unwrap_or_else(|| format!("{}:{}", request.job_id, candidate.candidate_id)),
                strategy: StrategySpec {
                    name: format!(
                        "{}:{}",
                        request.strategy_id.as_deref().unwrap_or("collab"),
                        candidate.role
                    ),
                    version: candidate.version.clone(),
                    build: candidate.build.clone(),
                    operator: request.requested_by.clone(),
                    created_at: request.created_at.clone(),
                },
                overrides: overrides.clone(),
            };
            let path = dir.join(format!("candidate-{index}.json"));
            let text = serde_json::to_vec(&spec)
                .map_err(|_| CliError::internal("candidate staging serialization failed"))?;
            fs::write(&path, text)
                .map_err(|_| CliError::internal("candidate staging write failed"))?;
            Ok(path)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request_with_evidence(bytes_base64: &str) -> CollabTriageRunRequest {
        let mut request = CollabTriageRunRequest {
            schema_id: REQUEST_SCHEMA_ID.into(),
            job_id: "job-demo".into(),
            created_at: "2026-08-20T00:00:00Z".into(),
            requested_by: "user-demo".into(),
            case: CollabCase {
                case_id: "case-demo".into(),
                title: "Demo case".into(),
                reported_problem: CollabReportedProblem {
                    summary: "A bounded demo problem".into(),
                    reported_at: None,
                    reporter: None,
                    symptoms: vec![],
                },
                created_at: "2026-08-20T00:00:00Z".into(),
                lifecycle: CaseLifecycle::Open,
            },
            snapshot: CollabSnapshot {
                snapshot_id: "snapshot-demo".into(),
                fingerprint: String::new(),
                parent_snapshot_id: None,
                evidence: vec![CollabSnapshotEvidence {
                    evidence_id: "ev-demo".into(),
                    ordinal: 0,
                    content_hash: Some("0".repeat(64)),
                    expected_hash: None,
                    verification_status: Some("verified".into()),
                    privacy_class: PrivacyClass::OwnerOnly,
                }],
                visibility: PrivacyClass::OwnerOnly,
                protocol_version: "cd-collab.snapshot.v1".into(),
                captured_at: "2026-08-20T00:00:00Z".into(),
                captured_by: "user-demo".into(),
                notes: None,
            },
            question: "What happened?".into(),
            task_fingerprint: None,
            strategy_id: None,
            policy_fingerprint: None,
            evidence: vec![CollabEvidence {
                item_id: "ev-demo".into(),
                bytes_base64: bytes_base64.into(),
                capture_time: "2026-08-20T00:00:00Z".into(),
                reference: "fixture".into(),
                captured_from: "test".into(),
                media_type: "text/plain".into(),
                format: "raw".into(),
                visible_to_strategies: true,
            }],
            candidates: vec![CollabCandidate {
                candidate_id: "c1".into(),
                provider: None,
                profile_id: "profile:test".into(),
                model_id: "model:test".into(),
                role: "reviewer".into(),
                version: None,
                build: None,
                cancellation_id: None,
            }],
            deadline_ms: None,
            max_provider_calls: None,
            concurrency: None,
        };
        request.snapshot.fingerprint = collab_snapshot_fingerprint(&request.snapshot).unwrap();
        request
    }

    #[test]
    fn malformed_base64_is_rejected_without_echoing_input() {
        let request = request_with_evidence("not-base64-secret");
        let error = validate_request(&request).unwrap_err();
        assert_eq!(error.category, crate::envelope::ExitCategory::UserError);
        assert!(!error.message.contains("not-base64-secret"));
    }

    #[test]
    fn ldap_actor_identity_is_bounded_text_not_a_benchmark_id() {
        let mut request = request_with_evidence(&BASE64.encode(b"evidence"));
        request.requested_by = "uid=demo,ou=people,dc=example,dc=test".into();
        validate_request(&request).expect("LDAP actor identity should be accepted");
    }

    #[test]
    fn namespaced_catalog_model_ids_are_accepted() {
        let mut request = request_with_evidence(&BASE64.encode(b"evidence"));
        request.candidates[0].model_id = "alibaba/qwen3.6-27b".into();
        validate_request(&request).expect("provider catalog namespaces are valid model ids");
    }

    #[test]
    fn snapshot_manifest_fingerprint_is_required() {
        let mut request = request_with_evidence(&BASE64.encode(b"evidence"));
        request.snapshot.fingerprint = "a".repeat(64);
        let error = validate_request(&request).unwrap_err();
        assert!(error.message.contains("fingerprint does not match"));
    }

    #[test]
    fn materialization_rejects_bytes_that_do_not_match_the_frozen_hash() {
        let mut request = request_with_evidence(&BASE64.encode(b"evidence"));
        request.snapshot.evidence[0].content_hash = Some("a".repeat(64));
        request.snapshot.fingerprint = collab_snapshot_fingerprint(&request.snapshot).unwrap();
        validate_request(&request).expect("manifest itself is internally consistent");
        let error = match materialize_library(&request, None, &CancelFlag::new()) {
            Ok(_) => panic!("mismatched evidence bytes must be rejected"),
            Err(error) => error,
        };
        assert!(error.message.contains("frozen snapshot hash"));
    }

    #[test]
    fn share_safe_snapshot_keeps_owner_only_task_boundary() {
        let bytes = b"evidence";
        let mut request = request_with_evidence(&BASE64.encode(bytes));
        let digest = ContentDigest::of_bytes(bytes).hex;
        request.snapshot.visibility = PrivacyClass::ShareSafe;
        request.snapshot.evidence[0].privacy_class = PrivacyClass::ShareSafe;
        request.snapshot.evidence[0].content_hash = Some(digest);
        request.snapshot.fingerprint = collab_snapshot_fingerprint(&request.snapshot).unwrap();
        validate_request(&request).expect("share-safe snapshot should be valid");

        let library = materialize_library(&request, None, &CancelFlag::new())
            .expect("share-safe snapshot should materialize");
        let store = cd_triage_bench::BenchStore::open(&library.path).unwrap();
        let task = store.get_task(&library.task_id).unwrap();
        let snapshot = store.get_snapshot(&task.snapshot_id).unwrap();
        assert_eq!(snapshot.privacy, PrivacyClass::ShareSafe);
        assert_eq!(task.privacy, PrivacyClass::OwnerOnly);
    }

    #[test]
    fn evidence_bounds_are_rejected() {
        let mut request =
            request_with_evidence(&BASE64.encode(vec![b'x'; MAX_EVIDENCE_ITEM_BYTES + 1]));
        let error = validate_request(&request).unwrap_err();
        assert!(error.message.contains("bounded size"));
        request.evidence[0].bytes_base64 = BASE64.encode(vec![b'x'; MAX_EVIDENCE_ITEM_BYTES]);
        request.evidence.push(request.evidence[0].clone());
        request.evidence[1].item_id = "ev-demo-2".into();
        request.evidence.push(request.evidence[0].clone());
        request.evidence[2].item_id = "ev-demo-3".into();
        assert!(validate_request(&request).is_err());
    }

    #[test]
    fn staged_candidate_contains_no_secret_or_evidence_bytes() {
        let request = request_with_evidence(&BASE64.encode(b"TOP-SECRET-EVIDENCE"));
        let dir = tempdir().unwrap();
        let cancel = CancelFlag::new();
        let paths = write_candidates(&request, dir.path(), &cancel).unwrap();
        let text = fs::read_to_string(&paths[0]).unwrap();
        assert!(!text.contains("TOP-SECRET-EVIDENCE"));
        assert!(!text.contains("bytesBase64"));
        assert!(!text.contains("api_key"));
    }

    #[test]
    fn result_serialization_omits_raw_capture_fields() {
        let output = CollabTriageRunOutput {
            schema_id: RESULT_SCHEMA_ID,
            action: "collab_triage_run",
            job_id: "job-demo".into(),
            case_id: "case-demo".into(),
            collab_snapshot_id: "snapshot-demo".into(),
            collab_snapshot_fingerprint: "a".repeat(64),
            benchmark_task_id: "task-demo".into(),
            benchmark_snapshot_id: "snap-demo".into(),
            same_snapshot: true,
            candidates: vec![CollabCandidateResult {
                candidate_id: "c1".into(),
                profile_id: "profile:test".into(),
                model_id: "model:test".into(),
                role: "reviewer".into(),
                status: "completed".into(),
                run_id: Some("run-demo".into()),
                summary: "Live gateway run completed; open the benchmark record for the owner-only answer.".into(),
                error_code: None,
                output_hash: Some("b".repeat(64)),
                evidence_refs: vec!["ev-demo".into()],
                packet_fingerprint: Some("c".repeat(64)),
                corpus_fingerprint: Some("d".repeat(64)),
                usage: "unknown",
                cost: "unknown",
            }],
        };
        let text = serde_json::to_string(&output).unwrap();
        assert!(!text.contains("raw_output"));
        assert!(!text.contains("bytes_base64"));
        assert!(!text.contains("TOP-SECRET-EVIDENCE"));
    }

    #[test]
    fn partial_reason_projection_is_bounded_and_does_not_echo_unknown_text() {
        let partial = serde_json::json!({
            "terminal": {
                "reason_codes": ["root_cause_not_established", "provider response: secret"]
            }
        });
        assert_eq!(
            safe_terminal_code(&partial).as_deref(),
            Some("root_cause_not_established")
        );

        let unknown = serde_json::json!({
            "terminal": {"category": "provider response: secret"}
        });
        assert_eq!(safe_terminal_code(&unknown), None);
    }

    #[test]
    fn progress_claim_projection_rejects_urls_paths_and_request_ids() {
        for value in [
            "inspect https://example.test/next",
            "read /tmp/private.log",
            "gateway request_id=req-123",
            "x-request-id: abc",
        ] {
            assert!(
                !safe_projected_text(value),
                "unsafe claim accepted: {value}"
            );
        }
        assert!(safe_projected_text(
            "inventory timeout is supported by ev-demo"
        ));
    }
}
