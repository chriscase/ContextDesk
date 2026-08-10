//! `contextdesk gateway diagnose` — a bounded, provider-neutral diagnostic
//! and synthetic-workflow suite for one explicitly selected model.
//!
//! This module is an **orchestrator only**. Every actual provider call goes
//! through code another command already exercises in production:
//!
//! - the **direct lane** calls `cd_core::capability_qualification::run_qualification`
//!   through `cd_workflow::capability_qualification::LiveQualificationTransport`
//!   — the exact machinery `contextdesk models verify` uses — never a second
//!   HTTP client;
//! - the **product lane** calls `cd_workflow::chat::run_chat_workflow` — the
//!   exact machinery `contextdesk chat`/`contextdesk doctor` use — with a
//!   `cd_core::turn_trace::RecordingTurnTrace` sink, never a second agent
//!   loop or a diagnostic-only imitation of the real tool/grounding pipeline;
//! - the linked-log triage case scores the model's structured answer with
//!   `cd_core::triage_quality::score_structured_triage_answer`, the same
//!   rubric `contextdesk eval`/`logging-assessment` use, never a bespoke
//!   scorer.
//!
//! For each applicable synthetic case this module runs the smallest known
//! -valid request through the direct lane (when one exists) and the
//! equivalent request through the real ContextDesk product path, then
//! classifies the pair: both failed (gateway/model likely), direct passed
//! but product failed (ContextDesk integration), both executed but a typed
//! scorer failed (usefulness), or a retry/correction was needed (compatible
//! but fragile). These are evidence for triage, not infallible proof of a
//! single root cause.
//!
//! Every disposable corpus/session this run creates is deleted on every
//! exit path — success, a case failure, the overall deadline, or Ctrl-C —
//! mirroring `doctor.rs`'s guaranteed-cleanup discipline. Credentials are
//! never logged, serialized, or written to the diagnostic artifact; the
//! default artifact is share-safe (pseudonymous profile/model identity, no
//! raw endpoint URL, no absolute paths). An explicit `--raw
//! --raw-i-understand` capture additionally writes a local-only,
//! owner-permissioned file with bounded synthetic request/response text and
//! sanitized wire events — never credentials — kept in a separate file the
//! share-safe bundle never references by content.

use crate::adapters::Paths;
use crate::cli::{DiagnoseLevel, GatewayDiagnoseArgs};
use crate::config::{ColorMode, OutputFormat};
use crate::envelope::{CliError, CliResult, Envelope};
use crate::render::TerminalCapabilities;
use cd_core::capability_qualification::{
    fingerprint_endpoint, redact_reason, run_qualification, CapabilityStatus, QualificationKey,
};
use cd_core::config::AppConfig;
use cd_core::events::StreamEvent;
use cd_core::keychain_store::SecretStore;
use cd_core::log_analysis::{
    ActiveTimestampBasis, CorpusEmbeddingStatus, CorpusStats, LogCorpus, LogEvent,
    SearchEvidenceIdentity, TemplateInfo, TemplateRow, TimestampProvenance,
};
use cd_core::model_role_hints::{classify_model_role, ModelRoleHint};
use cd_core::providers::{ProviderKind, ProviderProfile};
use cd_core::redact::ShareSafeRedactionPolicy;
use cd_core::rerank::HttpRerankBackend;
use cd_core::sessions::SessionStore;
use cd_core::triage_quality::{
    parse_structured_triage_answer, score_structured_triage_answer,
    triage_answer_contract_system_text, TriageHostFacts, TriageKnownAnswerKey,
};
use cd_core::turn_trace::{RecordingTurnTrace, TracedOutcome, TurnTraceSink};
use cd_workflow::capability_qualification::{
    backend_for_provider, gate_for_model, LiveQualificationTransport,
};
use cd_workflow::chat::{run_chat_workflow, ChatWorkflowRequest};
use cd_workflow::provider::resolve_provider_profile;
use serde::Serialize;
use std::io::{self, IsTerminal, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Stable schema id for the diagnostic bundle/report.
pub const GATEWAY_DIAGNOSTIC_SCHEMA_ID: &str = "contextdesk.gateway_diagnostic.v1";
pub const GATEWAY_DIAGNOSTIC_SCHEMA_VERSION: u32 = 2;

const DEFAULT_TIMEOUT_SECS: u64 = 180;
/// Safety ceiling for each case when the operator did not choose a deadline.
/// An explicit `--timeout` is intentional and instead lets a case use the
/// operation's remaining time; the whole-operation deadline is still the
/// hard ceiling.
const DEFAULT_PER_CASE_SAFETY_TIMEOUT_SECS: u64 = 45;
/// Distinctive synthetic markers — never a real hostname/service/company
/// term — so a model's answer citing one is unambiguous proof it used this
/// run's disposable evidence, never leftover state from prior use.
const TOOL_MARKER: &str = "GWDX_TOOL_GROUNDED_MARKER";
const ATTACH_MARKER: &str = "GWDX_ATTACHMENT_FACT_7f2c";
const ATTACH_DECOY: &str = "GWDX_ATTACHMENT_DECOY_9a1b";
const GENERATION_MARKER: &str = "GWDX_GENERATION_ECHO_MARKER";

/// One lane's outcome for one case: `None` when the lane does not apply to
/// this case (e.g. no raw-provider equivalent of a linked-log triage turn).
#[derive(Debug, Clone, Serialize)]
pub struct LaneResult {
    pub executed: bool,
    pub passed: bool,
    pub detail: String,
    pub elapsed_ms: u64,
    pub attempts: u32,
    pub requests_used: u32,
}

impl LaneResult {
    fn not_applicable(reason: impl Into<String>) -> Self {
        Self {
            executed: false,
            passed: false,
            detail: reason.into(),
            elapsed_ms: 0,
            attempts: 0,
            requests_used: 0,
        }
    }
}

/// Evidence-based classification of one case's direct/product/scorer
/// outcomes. Never asserted as infallible single-cause proof — see module
/// docs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CaseClassification {
    /// Both lanes (or the only applicable lane) passed, including any
    /// typed-property scorer.
    Compatible,
    /// Direct and product lanes both failed — evidence the gap is at the
    /// gateway/model layer rather than ContextDesk's integration.
    GatewayOrModelLikely,
    /// The direct lane passed but the product lane failed — evidence the
    /// gap is in ContextDesk's own integration of an otherwise-working
    /// model.
    ProductIntegrationLikely,
    /// Both lanes executed and completed, but a typed-property scorer
    /// failed — a usefulness gap, not a compatibility gap.
    UsefulnessGap,
    /// The product lane needed a correction/retry to succeed — compatible,
    /// but fragile.
    RetryRequired,
    /// This case does not apply to the selected model's role, or was
    /// skipped by the deadline/level before it ran.
    NotRun,
}

#[derive(Debug, Clone, Serialize)]
pub struct CaseReport {
    pub case_id: &'static str,
    pub description: &'static str,
    pub direct: LaneResult,
    pub product: LaneResult,
    pub scorer: LaneResult,
    pub classification: CaseClassification,
}

#[derive(Debug, Clone, Serialize)]
pub struct Verdicts {
    /// Backward-compatible projection of `gateway_model_status`. This is true
    /// only when enough direct evidence passed; inconclusive runs are false.
    pub gateway_model_compatible: bool,
    /// Backward-compatible projection of `product_workflow_status`.
    pub product_workflow_compatible: bool,
    /// Backward-compatible projection of `answers_useful_status`.
    pub answers_useful: bool,
    /// Measured status for the direct gateway/model contract.
    pub gateway_model_status: VerdictStatus,
    /// Measured status for the product workflow contract.
    pub product_workflow_status: VerdictStatus,
    /// Measured status for scorer-applicable answer usefulness.
    pub answers_useful_status: VerdictStatus,
}

/// A diagnostic dimension can pass, fail, or remain unmeasured. In
/// particular, a deadline/cancellation that skips every applicable case is
/// not evidence of compatibility. The legacy Boolean fields in `Verdicts`
/// remain for consumers that have not adopted this explicit status yet.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VerdictStatus {
    Pass,
    Fail,
    Inconclusive,
}

#[derive(Debug, Clone, Serialize)]
pub struct CleanupReport {
    pub corpora_created: usize,
    pub corpora_removed: usize,
    pub sessions_created: usize,
    pub sessions_removed: usize,
    pub failures: Vec<String>,
}

impl CleanupReport {
    fn ok(&self) -> bool {
        self.failures.is_empty()
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct BuildIdentity {
    pub version: &'static str,
    pub long_version: &'static str,
}

#[derive(Debug, Clone, Serialize)]
pub struct PlannedRun {
    pub level: &'static str,
    pub case_ids: Vec<&'static str>,
    pub max_requests: u32,
    pub deadline_secs: u64,
    pub artifact_classes: Vec<&'static str>,
}

#[derive(Debug, Clone, Serialize)]
pub struct GatewayDiagnosticReport {
    pub schema_id: &'static str,
    pub schema_version: u32,
    pub run_id: String,
    pub build: BuildIdentity,
    pub started_at_unix_ms: u64,
    pub finished_at_unix_ms: u64,
    pub level: &'static str,
    /// Stable run-local pseudonym for the provider profile identity —
    /// never the operator's private profile label.
    pub profile_pseudonym: String,
    /// Stable run-local pseudonym for the exact selected model id — never
    /// the literal private catalog id.
    pub model_pseudonym: String,
    pub role_hint: &'static str,
    pub endpoint_fingerprint: String,
    pub credentials_read: bool,
    pub deadline_secs: u64,
    pub requests_planned_max: u32,
    pub requests_made: u32,
    pub cases: Vec<CaseReport>,
    pub verdicts: Verdicts,
    pub cleanup: CleanupReport,
    pub cancelled: bool,
    pub deadline_exceeded: bool,
    pub artifact_dir: Option<String>,
    pub private_capture_written: bool,
}

impl GatewayDiagnosticReport {
    fn to_envelope_value(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or_default()
    }
}

/// One `--jsonl` line. Streamed as each case completes, then exactly one
/// terminal `verdict` line — the same one-terminal-line discipline
/// `doctor.rs`'s `DoctorLine` uses.
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum DiagnoseLine<'a> {
    Plan(&'a PlannedRun),
    Case(&'a CaseReport),
    Verdict(&'a GatewayDiagnosticReport),
    Cancelled { elapsed_ms: u64, cleanup_ok: bool },
}

fn now_unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn pseudonym(label: &str) -> String {
    let digest = fingerprint_endpoint(&format!("gwdx-pseudonym:{label}"));
    format!("p-{}", &digest[..12.min(digest.len())])
}

/// Execute `contextdesk gateway diagnose`. Handles Text/Jsonl progressive
/// rendering and the terminal Json envelope itself (mirrors `doctor::run`)
/// — the caller only needs the returned report to compute an exit code.
#[allow(clippy::too_many_arguments)]
pub async fn run(
    args: &GatewayDiagnoseArgs,
    paths: &Paths,
    cfg: &AppConfig,
    secrets: &dyn SecretStore,
    sessions: &SessionStore,
    format: OutputFormat,
    color: ColorMode,
    profile_override: Option<&str>,
    model_override: Option<&str>,
) -> CliResult<GatewayDiagnosticReport> {
    let started = Instant::now();
    let started_at_unix_ms = now_unix_ms();
    let run_id = format!(
        "gwdx-{}-{}",
        started_at_unix_ms,
        std::process::id() % 100_000
    );

    let profile = resolve_provider_profile(cfg, profile_override)
        .map_err(|id| CliError::not_found(format!("provider profile not found: {id}")))?;
    let model = model_override
        .map(str::to_string)
        .unwrap_or_else(|| profile.chat_model.clone());
    let role = classify_model_role(&model).role;
    let redaction = ShareSafeRedactionPolicy::new([profile.id.as_str(), model.as_str()]);
    let deadline_secs = args.timeout.unwrap_or(DEFAULT_TIMEOUT_SECS);

    let plan = build_plan(args.level, role, deadline_secs, args.raw);
    print_plan(format, color, &plan);
    confirm_or_error(args.yes, format)?;

    let credentials = resolve_credentials_once(&profile, secrets)?;
    let caps = TerminalCapabilities::detect(color);

    let deadline = started + Duration::from_secs(deadline_secs);
    let cancel = Arc::new(AtomicBool::new(false));
    install_ctrlc_watcher(cancel.clone());

    let mut corpora: Vec<String> = Vec::new();
    let mut created_sessions: Vec<String> = Vec::new();
    let mut requests_made: u32 = 0;
    let mut cases: Vec<CaseReport> = Vec::new();

    // One shared direct-lane qualification pass, run once up front, covers
    // `ordinary_generation`/`structured_response`/`tool_call_continuation`'s
    // direct baseline for chat-role models — never a second, per-case
    // qualification call (that would blow the stated request budget).
    // `embedding_or_rerank_contract` runs its own single-kind probe inline
    // since only one capability applies to that role.
    let shared_qualification =
        if matches!(role, ModelRoleHint::Investigator | ModelRoleHint::Unknown) {
            let qual = run_shared_qualification(&profile, &model, &credentials, deadline).await;
            requests_made += qual.requests_used;
            Some(qual)
        } else {
            None
        };

    for case_id in &plan.case_ids {
        if cancel.load(Ordering::SeqCst) {
            break;
        }
        if Instant::now() >= deadline {
            let mut skipped =
                skipped_case(case_id, "overall deadline exceeded before this case ran");
            sanitize_case_report(&mut skipped, &redaction);
            cases.push(skipped);
            continue;
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        let case_budget = per_case_budget(remaining, args.timeout.is_some());
        let mut report = run_one_case(
            case_id,
            &profile,
            &model,
            role,
            args.level,
            &credentials,
            shared_qualification.as_ref(),
            paths,
            cfg,
            secrets,
            sessions,
            case_budget,
            &cancel,
            &mut corpora,
            &mut created_sessions,
        )
        .await;
        requests_made += report.direct.requests_used + report.product.requests_used;
        sanitize_case_report(&mut report, &redaction);
        print_case(format, color, &caps, &report);
        cases.push(report);
    }

    let cancelled = cancel.load(Ordering::SeqCst);
    let deadline_exceeded = Instant::now() >= deadline;

    let mut cleanup = cleanup_all(paths, sessions, &corpora, &created_sessions);
    sanitize_cleanup_report(&mut cleanup, &redaction);

    let verdicts = compute_verdicts(&cases);
    let finished_at_unix_ms = now_unix_ms();

    let mut report = GatewayDiagnosticReport {
        schema_id: GATEWAY_DIAGNOSTIC_SCHEMA_ID,
        schema_version: GATEWAY_DIAGNOSTIC_SCHEMA_VERSION,
        run_id,
        build: BuildIdentity {
            version: env!("CARGO_PKG_VERSION"),
            long_version: env!("CD_CLI_LONG_VERSION"),
        },
        started_at_unix_ms,
        finished_at_unix_ms,
        level: level_str(args.level),
        profile_pseudonym: pseudonym(&format!("profile:{}", profile.id)),
        model_pseudonym: pseudonym(&format!("model:{model}")),
        role_hint: role_str(role),
        endpoint_fingerprint: QualificationKey::new(&profile.id, &profile.base_url, &model)
            .endpoint_fingerprint,
        credentials_read: credentials.credentials_read,
        deadline_secs,
        requests_planned_max: plan.max_requests,
        requests_made,
        cases,
        verdicts,
        cleanup,
        cancelled,
        deadline_exceeded,
        artifact_dir: None,
        private_capture_written: false,
    };
    sanitize_gateway_report(&mut report, &redaction);

    let artifact_run_dir = run_id_for_dir(&report.run_id);
    match write_artifact_bundle(args, paths, &artifact_run_dir, &report, &redaction) {
        Ok(dir) => report.artifact_dir = Some(dir.display().to_string()),
        Err(e) => eprintln!("warning: failed to write diagnostic artifact bundle: {e}"),
    }
    if args.raw && args.raw_i_understand {
        match write_private_capture(args, paths, &artifact_run_dir, &report, &redaction) {
            Ok(()) => report.private_capture_written = true,
            Err(e) => eprintln!("warning: failed to write private capture: {e}"),
        }
    }

    print_terminal(
        format,
        color,
        &caps,
        &report,
        cancelled,
        &cleanup_note(&report.cleanup),
    );

    Ok(report)
}

/// Return a provider-neutral budget for one diagnostic case.
///
/// The operation's remaining time is always the hard upper bound. When the
/// operator accepts the default deadline, a shorter per-case ceiling prevents
/// one accidentally stalled case from consuming the whole run. Supplying
/// `--timeout` explicitly opts into allowing a legitimately slow case to use
/// the remaining operation budget, including values such as 600 seconds.
fn per_case_budget(remaining: Duration, timeout_is_explicit: bool) -> Duration {
    if timeout_is_explicit {
        remaining
    } else {
        remaining.min(Duration::from_secs(DEFAULT_PER_CASE_SAFETY_TIMEOUT_SECS))
    }
}

/// Keep the deadline outside the real workflow future: on timeout, dropping
/// the future preserves the tracing backend's RAII `TimedOut` record; on
/// cancellation, the existing cooperative token still produces its normal
/// cancellation outcome and trace before this outer budget expires.
async fn within_case_budget<F>(
    budget: Duration,
    future: F,
) -> Result<F::Output, tokio::time::error::Elapsed>
where
    F: std::future::Future,
{
    tokio::time::timeout(budget.max(Duration::from_millis(1)), future).await
}

fn run_id_for_dir(run_id: &str) -> String {
    run_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

fn cleanup_note(cleanup: &CleanupReport) -> String {
    if cleanup.ok() {
        format!(
            "cleanup ok ({} corpus, {} session removed)",
            cleanup.corpora_removed, cleanup.sessions_removed
        )
    } else {
        format!("cleanup FAILED: {}", cleanup.failures.join("; "))
    }
}

fn sanitize_lane_result(lane: &mut LaneResult, policy: &ShareSafeRedactionPolicy) {
    let lower = lane.detail.to_ascii_lowercase();
    let failure_shaped = lane.executed
        || [
            "provider returned",
            "body=",
            "body:",
            "authorization",
            "http://",
            "https://",
            "error",
            "failed",
            "failure",
        ]
        .iter()
        .any(|marker| lower.contains(marker));
    lane.detail = if !lane.passed && failure_shaped {
        policy.failure_summary(&lane.detail)
    } else {
        policy.redact_text(&lane.detail)
    };
}

fn sanitize_case_report(report: &mut CaseReport, policy: &ShareSafeRedactionPolicy) {
    sanitize_lane_result(&mut report.direct, policy);
    sanitize_lane_result(&mut report.product, policy);
    sanitize_lane_result(&mut report.scorer, policy);
}

fn sanitize_cleanup_report(report: &mut CleanupReport, policy: &ShareSafeRedactionPolicy) {
    for failure in &mut report.failures {
        *failure = policy.failure_summary(failure);
    }
}

fn sanitize_gateway_report(
    report: &mut GatewayDiagnosticReport,
    policy: &ShareSafeRedactionPolicy,
) {
    report.run_id = policy.redact_text(&report.run_id);
    report.profile_pseudonym = policy.redact_text(&report.profile_pseudonym);
    report.model_pseudonym = policy.redact_text(&report.model_pseudonym);
    report.endpoint_fingerprint = policy.redact_text(&report.endpoint_fingerprint);
    for case in &mut report.cases {
        sanitize_case_report(case, policy);
    }
    sanitize_cleanup_report(&mut report.cleanup, policy);
    report.artifact_dir = report
        .artifact_dir
        .as_deref()
        .map(|value| run_id_for_dir(&policy.redact_text(value)));
}

fn level_str(level: DiagnoseLevel) -> &'static str {
    match level {
        DiagnoseLevel::Basic => "basic",
        DiagnoseLevel::Extended => "extended",
    }
}

fn role_str(role: ModelRoleHint) -> &'static str {
    match role {
        ModelRoleHint::Investigator => "investigator",
        ModelRoleHint::Embedding => "embedding",
        ModelRoleHint::Reranker => "reranker",
        ModelRoleHint::Unknown => "unknown",
    }
}

/// Every case id this command can plan, gated on role so a specialty
/// request is never sent to a model not qualified for that role and vice
/// versa.
fn build_plan(
    level: DiagnoseLevel,
    role: ModelRoleHint,
    deadline_secs: u64,
    raw: bool,
) -> PlannedRun {
    let case_ids: Vec<&'static str> = match role {
        ModelRoleHint::Embedding | ModelRoleHint::Reranker => vec!["embedding_or_rerank_contract"],
        ModelRoleHint::Investigator | ModelRoleHint::Unknown => vec![
            "ordinary_generation",
            "structured_response",
            "tool_call_continuation",
            "attachment_selected_context",
            "linked_log_triage",
        ],
    };
    let attempts_per_case: u32 = if level == DiagnoseLevel::Extended {
        2
    } else {
        1
    };
    // Conservative per-case upper bound: qualification's chat-role probe
    // set is 6 requests, embedding/reranker roles are 1; the product lane
    // is bounded at 3 provider rounds per attempt (tool loop headroom).
    let max_requests: u32 = case_ids
        .iter()
        .map(|id| match *id {
            "embedding_or_rerank_contract" => 1 + 3,
            "tool_call_continuation" => 2 + 3 * attempts_per_case,
            "linked_log_triage" => 3 * attempts_per_case,
            _ => 1 + 2 * attempts_per_case,
        })
        .sum::<u32>()
        + 6; // one shared direct-lane qualification pass covering generation/structured/tool cases
    let mut artifact_classes = vec!["share_safe_bundle"];
    if raw {
        artifact_classes.push("private_raw_capture");
    }
    PlannedRun {
        level: level_str(level),
        case_ids,
        max_requests,
        deadline_secs,
        artifact_classes,
    }
}

fn skipped_case(case_id: &'static str, reason: &str) -> CaseReport {
    CaseReport {
        case_id,
        description: case_description(case_id),
        direct: LaneResult::not_applicable(reason.to_string()),
        product: LaneResult::not_applicable(reason.to_string()),
        scorer: LaneResult::not_applicable(reason.to_string()),
        classification: CaseClassification::NotRun,
    }
}

fn case_description(case_id: &str) -> &'static str {
    match case_id {
        "ordinary_generation" => "exact-marker ordinary generation",
        "structured_response" => "strict structured JSON response",
        "tool_call_continuation" => "native tool call + tool-result continuation",
        "attachment_selected_context" => "tiny selected-context question with expected fact recall",
        "linked_log_triage" => "known-truth linked-log multi-stage triage",
        "embedding_or_rerank_contract" => "embedding/reranker contract + small known-ranking case",
        _ => "unknown case",
    }
}

fn compute_verdicts(cases: &[CaseReport]) -> Verdicts {
    let direct_executed = cases.iter().any(|c| c.direct.executed);
    let direct_failed = cases.iter().any(|c| c.direct.executed && !c.direct.passed);
    let gateway_model_status = if !direct_executed {
        VerdictStatus::Inconclusive
    } else if direct_failed {
        VerdictStatus::Fail
    } else {
        VerdictStatus::Pass
    };

    let product_executed = cases.iter().any(|c| c.product.executed);
    let product_failed = cases.iter().any(|c| {
        c.product.executed
            && !c.product.passed
            && c.classification == CaseClassification::ProductIntegrationLikely
    });
    let gateway_contaminated_product = cases.iter().any(|c| {
        c.product.executed
            && !c.product.passed
            && c.classification == CaseClassification::GatewayOrModelLikely
    });
    let product_workflow_status = if !product_executed {
        VerdictStatus::Inconclusive
    } else if product_failed {
        VerdictStatus::Fail
    } else if gateway_contaminated_product {
        VerdictStatus::Inconclusive
    } else {
        VerdictStatus::Pass
    };

    let scorer_executed = cases.iter().any(|c| c.scorer.executed);
    let scorer_failed = cases.iter().any(|c| c.scorer.executed && !c.scorer.passed);
    let answers_useful_status = if !scorer_executed {
        VerdictStatus::Inconclusive
    } else if scorer_failed {
        VerdictStatus::Fail
    } else {
        VerdictStatus::Pass
    };

    Verdicts {
        gateway_model_compatible: gateway_model_status == VerdictStatus::Pass,
        product_workflow_compatible: product_workflow_status == VerdictStatus::Pass,
        answers_useful: answers_useful_status == VerdictStatus::Pass,
        gateway_model_status,
        product_workflow_status,
        answers_useful_status,
    }
}

struct LiveCredentials {
    api_key: Option<String>,
    extra_headers: Vec<(String, String)>,
    credentials_read: bool,
}

/// Resolve the selected profile's credential exactly once for this
/// operation's direct lane. The product lane (`run_chat_workflow`) resolves
/// its own credential internally via `cd_workflow::provider`'s existing
/// per-turn cache — the same reused mechanism every other command's live
/// turn uses, not a second implementation — so a full run touches the
/// configured `SecretStore` at most twice (once here, once inside the
/// workflow's own cache), never through a bespoke credential path.
fn resolve_credentials_once(
    profile: &ProviderProfile,
    secrets: &dyn SecretStore,
) -> CliResult<LiveCredentials> {
    if profile.kind == ProviderKind::Ollama {
        return Ok(LiveCredentials {
            api_key: None,
            extra_headers: Vec::new(),
            credentials_read: false,
        });
    }
    if profile.kind == ProviderKind::XaiGrokBuild {
        let base = if profile.base_url.trim().is_empty() {
            "https://api.x.ai/v1"
        } else {
            profile.base_url.trim()
        };
        cd_core::grok_auth::assert_grok_base_allowed(base)
            .map_err(|error| CliError::user(error.to_string()))?;
        let credentials = cd_core::grok_auth::load_grok_session_credentials()
            .map_err(|error| CliError::provider(error.to_string()))?;
        return Ok(LiveCredentials {
            api_key: None,
            extra_headers: credentials.request_headers(),
            credentials_read: true,
        });
    }
    let api_key = profile
        .api_key_ref
        .as_deref()
        .map(|reference| {
            secrets
                .get(reference)
                .map_err(|error| CliError::provider(format!("read provider credential: {error}")))
        })
        .transpose()?
        .flatten();
    Ok(LiveCredentials {
        credentials_read: profile.api_key_ref.is_some(),
        api_key,
        extra_headers: Vec::new(),
    })
}

fn install_ctrlc_watcher(cancel: Arc<AtomicBool>) {
    tokio::spawn(async move {
        if tokio::signal::ctrl_c().await.is_ok() {
            cancel.store(true, Ordering::SeqCst);
        }
    });
}

fn confirm_or_error(yes: bool, format: OutputFormat) -> CliResult<()> {
    if yes {
        return Ok(());
    }
    if !io::stdin().is_terminal() {
        return Err(CliError::user(
            "gateway diagnose makes real provider requests; pass --yes to confirm in a non-interactive context",
        ));
    }
    if format != OutputFormat::Text {
        // A machine-readable format with no --yes has no reasonable place
        // to interleave an interactive prompt; fail closed rather than
        // silently blocking a script reading stdout.
        return Err(CliError::user(
            "pass --yes when using --json/--jsonl non-interactively",
        ));
    }
    let mut stderr = io::stderr();
    write!(
        stderr,
        "Proceed with these bounded provider requests? [y/N] "
    )
    .map_err(|e| CliError::internal(e.to_string()))?;
    stderr
        .flush()
        .map_err(|e| CliError::internal(e.to_string()))?;
    let mut answer = String::new();
    io::stdin()
        .read_line(&mut answer)
        .map_err(|e| CliError::internal(e.to_string()))?;
    match answer.trim().to_ascii_lowercase().as_str() {
        "y" | "yes" => Ok(()),
        _ => Err(CliError::cancelled(
            "gateway diagnose cancelled by operator",
        )),
    }
}

// ---------------------------------------------------------------------
// Rendering (Text / Jsonl progressive, Json terminal envelope)
// ---------------------------------------------------------------------

fn print_plan(format: OutputFormat, _color: ColorMode, plan: &PlannedRun) {
    match format {
        OutputFormat::Text => {
            eprintln!(
                "contextdesk gateway diagnose — planned checks ({})",
                plan.level
            );
            for id in &plan.case_ids {
                eprintln!("  - {id}: {}", case_description(id));
            }
            eprintln!("  max requests:   up to {}", plan.max_requests);
            eprintln!("  deadline:       {}s", plan.deadline_secs);
            eprintln!("  artifact:       {}", plan.artifact_classes.join(", "));
            eprintln!("  no live provider credential is printed or written to the artifact.");
        }
        OutputFormat::Jsonl => {
            println!(
                "{}",
                serde_json::to_string(&DiagnoseLine::Plan(plan))
                    .expect("PlannedRun is always serializable")
            );
        }
        OutputFormat::Json => {}
    }
}

fn status_tag(classification: CaseClassification) -> &'static str {
    match classification {
        CaseClassification::Compatible => "PASS",
        CaseClassification::GatewayOrModelLikely => "FAIL",
        CaseClassification::ProductIntegrationLikely => "FAIL",
        CaseClassification::UsefulnessGap => "WARN",
        CaseClassification::RetryRequired => "WARN",
        CaseClassification::NotRun => "SKIP",
    }
}

fn color_for(tag: &str) -> &'static str {
    match tag {
        "PASS" => "\x1b[32m",
        "WARN" => "\x1b[33m",
        "FAIL" => "\x1b[31m",
        _ => "\x1b[2m",
    }
}

fn colorize(caps: &TerminalCapabilities, tag: &str) -> String {
    if caps.color {
        format!("{}{tag}\x1b[0m", color_for(tag))
    } else {
        tag.to_string()
    }
}

fn print_case(
    format: OutputFormat,
    _color: ColorMode,
    caps: &TerminalCapabilities,
    report: &CaseReport,
) {
    match format {
        OutputFormat::Text => {
            let tag = status_tag(report.classification);
            println!(
                "[{}] {:<28} {:?}",
                colorize(caps, tag),
                report.case_id,
                report.classification
            );
            print_lane("direct", &report.direct);
            print_lane("product", &report.product);
            if report.scorer.executed
                || matches!(report.classification, CaseClassification::UsefulnessGap)
            {
                print_lane("scorer", &report.scorer);
            }
        }
        OutputFormat::Jsonl => {
            println!(
                "{}",
                serde_json::to_string(&DiagnoseLine::Case(report))
                    .expect("CaseReport is always serializable")
            );
        }
        OutputFormat::Json => {}
    }
}

fn print_lane(name: &str, lane: &LaneResult) {
    if !lane.executed && lane.detail.is_empty() {
        return;
    }
    println!(
        "  |-- {name}: {} ({}ms, {} attempt(s), {} request(s)) {}",
        if lane.executed {
            if lane.passed {
                "pass"
            } else {
                "fail"
            }
        } else {
            "n/a"
        },
        lane.elapsed_ms,
        lane.attempts,
        lane.requests_used,
        lane.detail
    );
}

fn print_terminal(
    format: OutputFormat,
    _color: ColorMode,
    _caps: &TerminalCapabilities,
    report: &GatewayDiagnosticReport,
    cancelled: bool,
    cleanup_note: &str,
) {
    match format {
        OutputFormat::Text => {
            println!();
            if cancelled {
                println!("interrupted — no full verdict was produced ({cleanup_note})");
            } else {
                println!(
                    "gateway/model compatible:    {}",
                    report.verdicts.gateway_model_compatible
                );
                println!(
                    "product-path compatible:     {}",
                    report.verdicts.product_workflow_compatible
                );
                println!(
                    "answers useful (quality):    {}",
                    report.verdicts.answers_useful
                );
                println!("{cleanup_note}");
                if let Some(dir) = &report.artifact_dir {
                    println!("artifact bundle: {dir}");
                }
            }
        }
        OutputFormat::Jsonl => {
            if cancelled {
                let elapsed_ms = report
                    .finished_at_unix_ms
                    .saturating_sub(report.started_at_unix_ms);
                println!(
                    "{}",
                    serde_json::to_string(&DiagnoseLine::Cancelled {
                        elapsed_ms,
                        cleanup_ok: report.cleanup.ok(),
                    })
                    .expect("cancelled line always serializable")
                );
            } else {
                println!(
                    "{}",
                    serde_json::to_string(&DiagnoseLine::Verdict(report))
                        .expect("GatewayDiagnosticReport is always serializable")
                );
            }
        }
        OutputFormat::Json => {
            let envelope = Envelope::ok("gateway_diagnose", report.to_envelope_value());
            println!(
                "{}",
                serde_json::to_string(&envelope).expect("Envelope is always serializable")
            );
        }
    }
}

// ---------------------------------------------------------------------
// Case execution
// ---------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
async fn run_one_case(
    case_id: &'static str,
    profile: &ProviderProfile,
    model: &str,
    role: ModelRoleHint,
    level: DiagnoseLevel,
    credentials: &LiveCredentials,
    qual: Option<&SharedQualification>,
    paths: &Paths,
    cfg: &AppConfig,
    secrets: &dyn SecretStore,
    sessions: &SessionStore,
    budget: Duration,
    cancel: &Arc<AtomicBool>,
    corpora: &mut Vec<String>,
    created_sessions: &mut Vec<String>,
) -> CaseReport {
    let deadline = Instant::now() + budget;
    match case_id {
        "ordinary_generation" => {
            case_ordinary_generation(
                paths,
                cfg,
                secrets,
                sessions,
                &profile.id,
                model,
                qual,
                deadline,
                cancel,
            )
            .await
        }
        "structured_response" => {
            case_structured_response(
                paths,
                cfg,
                secrets,
                sessions,
                &profile.id,
                model,
                qual,
                deadline,
                cancel,
            )
            .await
        }
        "tool_call_continuation" => {
            case_tool_call_continuation(
                paths,
                cfg,
                secrets,
                sessions,
                &profile.id,
                model,
                qual,
                deadline,
                cancel,
                corpora,
                created_sessions,
            )
            .await
        }
        "attachment_selected_context" => {
            case_attachment_selected_context(
                paths,
                cfg,
                secrets,
                sessions,
                &profile.id,
                model,
                deadline,
                cancel,
                created_sessions,
            )
            .await
        }
        "linked_log_triage" => {
            case_linked_log_triage(
                paths,
                cfg,
                secrets,
                sessions,
                &profile.id,
                model,
                deadline,
                cancel,
                level,
                corpora,
                created_sessions,
            )
            .await
        }
        "embedding_or_rerank_contract" => {
            case_embedding_or_rerank(profile, model, role, credentials, deadline).await
        }
        other => skipped_case(other, "unknown case id"),
    }
}

/// Run one shared direct-lane qualification pass. Called at most once per
/// operation for a chat-role model (see `run`) so this run's own stated
/// request bound holds regardless of how many cases want direct-lane
/// evidence.
async fn run_shared_qualification(
    profile: &ProviderProfile,
    model: &str,
    credentials: &LiveCredentials,
    deadline: Instant,
) -> SharedQualification {
    let profile = profile.clone();
    let model = model.to_string();
    let api_key = credentials.api_key.clone();
    let extra_headers = credentials.extra_headers.clone();
    let budget = deadline.saturating_duration_since(Instant::now());
    let joined = tokio::task::spawn_blocking(move || {
        let backend = backend_for_provider(profile.kind);
        let base_url =
            if profile.kind == ProviderKind::XaiGrokBuild && profile.base_url.trim().is_empty() {
                "https://api.x.ai/v1".to_string()
            } else {
                profile.base_url.clone()
            };
        let mut transport =
            LiveQualificationTransport::new(backend, base_url, api_key, profile.local_only)
                .with_extra_headers(extra_headers);
        let key = QualificationKey::new(&profile.id, &profile.base_url, &model);
        let gate = gate_for_model(&profile, true, &model);
        let cancel = Arc::new(AtomicBool::new(false));
        run_qualification(key, gate, &mut transport, &cancel)
    });
    match tokio::time::timeout(budget.max(Duration::from_millis(1)), joined).await {
        Ok(Ok(report)) => {
            let requests_used = report
                .checks
                .iter()
                .filter(|c| c.status != CapabilityStatus::Untested)
                .count() as u32;
            SharedQualification {
                report: Some(report),
                requests_used,
                failure_detail: None,
            }
        }
        Ok(Err(e)) => SharedQualification {
            report: None,
            requests_used: 0,
            failure_detail: Some(format!("qualification task failed: {e}")),
        },
        Err(_) => SharedQualification {
            report: None,
            requests_used: 0,
            failure_detail: Some("direct-lane qualification timed out".to_string()),
        },
    }
}

struct SharedQualification {
    report: Option<cd_core::capability_qualification::QualificationReport>,
    requests_used: u32,
    failure_detail: Option<String>,
}

/// Project this run's one shared qualification pass into a per-case direct
/// -lane result for `kind`. `requests_used` is always 0 here — the shared
/// pass's own request count is already folded into the operation total
/// once, in `run`, so per-case totals never double-count it.
/// Combine two direct-lane probes into one case's direct-lane verdict: both
/// must pass for the combined lane to pass, and both reasons are kept.
fn combine_lanes(a: LaneResult, b: LaneResult) -> LaneResult {
    LaneResult {
        executed: a.executed || b.executed,
        passed: a.passed && b.passed,
        detail: format!("{} | {}", a.detail, b.detail),
        elapsed_ms: a.elapsed_ms + b.elapsed_ms,
        attempts: a.attempts.max(b.attempts),
        requests_used: a.requests_used + b.requests_used,
    }
}

fn lane_from_qualification(
    qual: Option<&SharedQualification>,
    kind: cd_core::capability_qualification::CapabilityKind,
) -> LaneResult {
    let Some(qual) = qual else {
        return LaneResult::not_applicable(
            "shared qualification pass does not apply to this model's role".to_string(),
        );
    };
    let Some(report) = &qual.report else {
        return LaneResult {
            executed: true,
            passed: false,
            detail: qual
                .failure_detail
                .clone()
                .unwrap_or_else(|| "shared qualification pass failed".to_string()),
            elapsed_ms: 0,
            attempts: 1,
            requests_used: 0,
        };
    };
    match report.checks.iter().find(|c| c.kind == kind) {
        Some(c) => LaneResult {
            executed: true,
            passed: c.status == CapabilityStatus::Pass,
            detail: format!("{:?}: {}", c.status, c.reason),
            elapsed_ms: c.elapsed_ms,
            attempts: 1,
            requests_used: 0,
        },
        None => LaneResult {
            executed: false,
            passed: false,
            detail: "capability not offered for this role".to_string(),
            elapsed_ms: 0,
            attempts: 0,
            requests_used: 0,
        },
    }
}

fn classify(
    direct: &LaneResult,
    product: &LaneResult,
    scorer: &LaneResult,
    retried: bool,
) -> CaseClassification {
    if !product.executed {
        return CaseClassification::NotRun;
    }
    if direct.executed && !direct.passed && !product.passed {
        return CaseClassification::GatewayOrModelLikely;
    }
    if direct.executed && direct.passed && !product.passed {
        return CaseClassification::ProductIntegrationLikely;
    }
    if !direct.executed && !product.passed {
        // No direct baseline exists for this case (e.g. triage/attachment).
        // Still real evidence of an integration/usefulness gap, just
        // without gateway-vs-product separation.
        return CaseClassification::ProductIntegrationLikely;
    }
    if scorer.executed && !scorer.passed {
        return CaseClassification::UsefulnessGap;
    }
    if retried {
        return CaseClassification::RetryRequired;
    }
    CaseClassification::Compatible
}

fn build_host(
    paths: &Paths,
    cfg: &AppConfig,
    secrets: &dyn SecretStore,
) -> Result<cd_core::tool_host::ToolHost, String> {
    crate::adapters::tool_host_with_app_config(&paths.cache_root, cfg, secrets)
        .map_err(|e| e.to_string())
}

#[allow(clippy::too_many_arguments)]
async fn one_turn(
    paths: &Paths,
    cfg: &AppConfig,
    secrets: &dyn SecretStore,
    sessions: &SessionStore,
    profile_id: &str,
    model: &str,
    question: &str,
    corpus_id: Option<&str>,
    user_selection: Option<&str>,
    deadline: Instant,
    cancel: &Arc<AtomicBool>,
) -> (
    Result<cd_workflow::chat::ChatWorkflowOutcome, String>,
    Vec<cd_core::turn_trace::TracedCall>,
    Duration,
) {
    let recorder = Arc::new(RecordingTurnTrace::new());
    let trace_sink: Arc<dyn TurnTraceSink> = recorder.clone();
    let mut host = match build_host(paths, cfg, secrets) {
        Ok(host) => host,
        Err(e) => {
            return (
                Err(format!("could not build tool host: {e}")),
                Vec::new(),
                Duration::ZERO,
            )
        }
    };
    let started = Instant::now();
    let budget = deadline.saturating_duration_since(Instant::now());
    let mut turn = Box::pin(run_chat_workflow(
        &mut host,
        secrets,
        cfg,
        sessions,
        &paths.cache_root,
        None,
        question,
        ChatWorkflowRequest {
            corpus_id,
            // The command's whole point is a differential against the exact
            // selected profile/model — never the shared AppConfig's
            // active/default profile, which may silently differ from what
            // the operator passed via --profile/--model. Both fields are
            // ChatWorkflowRequest-only per-turn overrides; nothing here
            // reads or writes AppConfig itself.
            explicit_profile_id: Some(profile_id),
            chat_model_override: Some(model),
            dry_run: false,
            trace_sink: Some(trace_sink),
            user_selection,
            ..ChatWorkflowRequest::default()
        },
        Some(cancel.clone()),
        None,
        |_tool_name, _target, _reason, _preview, _risk| {
            cd_core::permissions::PermissionDecision::AllowOnce
        },
    ));
    let raced = tokio::select! {
        result = within_case_budget(budget, turn.as_mut()) => result,
        _ = tokio::signal::ctrl_c(), if false => unreachable!(),
    };
    let outcome = match raced {
        Ok(Ok(outcome)) => Ok(outcome),
        Ok(Err(e)) => Err(e.to_string()),
        Err(_) => Err("turn timed out".to_string()),
    };
    (outcome, recorder.calls(), started.elapsed())
}

/// Summarize the host-observed terminal channel without retaining provider
/// bodies. This makes a completed turn with no visible answer distinguishable
/// from a normal useful completion in share-safe diagnostic artifacts.
fn terminal_channel_summary(events: &[StreamEvent]) -> String {
    let text_delta_count = events
        .iter()
        .filter(|event| matches!(event, StreamEvent::TextDelta { .. }))
        .count();
    let text_delta_chars = events
        .iter()
        .filter_map(|event| match event {
            StreamEvent::TextDelta { text } => Some(text.chars().count()),
            _ => None,
        })
        .sum::<usize>();
    let turn_terminal = events.iter().rev().find_map(|event| match event {
        StreamEvent::TurnCompleted { reason } => Some(reason.as_str()),
        _ => None,
    });
    let provider_telemetry = events.iter().rev().find_map(|event| match event {
        StreamEvent::ProviderTelemetry { telemetry } => Some(telemetry.as_ref()),
        _ => None,
    });
    let (provider_rounds, empty_visible_answer, finish_reason) = provider_telemetry
        .map(|telemetry| {
            (
                telemetry.provider_round_count,
                telemetry.empty_visible_answer,
                telemetry.finish_reason.as_deref().unwrap_or("unknown"),
            )
        })
        .unwrap_or((0, false, "unknown"));
    format!(
        "terminal_text_chars={text_delta_chars}, text_delta_count={text_delta_count}, provider_rounds={provider_rounds}, empty_visible_answer={empty_visible_answer}, finish_reason={finish_reason}, turn_terminal={}",
        turn_terminal.unwrap_or("unknown")
    )
}

#[allow(clippy::too_many_arguments)]
async fn case_ordinary_generation(
    paths: &Paths,
    cfg: &AppConfig,
    secrets: &dyn SecretStore,
    sessions: &SessionStore,
    profile_id: &str,
    model: &str,
    qual: Option<&SharedQualification>,
    deadline: Instant,
    cancel: &Arc<AtomicBool>,
) -> CaseReport {
    let direct = lane_from_qualification(
        qual,
        cd_core::capability_qualification::CapabilityKind::BasicGeneration,
    );
    let question = format!("Reply with exactly this token and nothing else: {GENERATION_MARKER}");
    let (outcome, calls, elapsed) = one_turn(
        paths, cfg, secrets, sessions, profile_id, model, &question, None, None, deadline, cancel,
    )
    .await;
    let product = match outcome {
        Ok(o) if o.final_text.contains(GENERATION_MARKER) => LaneResult {
            executed: true,
            passed: true,
            detail: "product-path turn echoed the exact marker".to_string(),
            elapsed_ms: elapsed.as_millis() as u64,
            attempts: 1,
            requests_used: calls.len().max(1) as u32,
        },
        Ok(o) => LaneResult {
            executed: true,
            passed: false,
            detail: format!(
                "product-path answer did not contain the marker (got {} chars)",
                o.final_text.len()
            ),
            elapsed_ms: elapsed.as_millis() as u64,
            attempts: 1,
            requests_used: calls.len().max(1) as u32,
        },
        Err(e) => LaneResult {
            executed: true,
            passed: false,
            detail: redact_reason(&e),
            elapsed_ms: elapsed.as_millis() as u64,
            attempts: 1,
            requests_used: calls.len().max(1) as u32,
        },
    };
    let retried = calls.iter().any(|c| c.application_retry_reason.is_some());
    let scorer = LaneResult::not_applicable("no typed scorer for plain generation".to_string());
    let classification = classify(&direct, &product, &scorer, retried);
    CaseReport {
        case_id: "ordinary_generation",
        description: case_description("ordinary_generation"),
        direct,
        product,
        scorer,
        classification,
    }
}

#[allow(clippy::too_many_arguments)]
async fn case_structured_response(
    paths: &Paths,
    cfg: &AppConfig,
    secrets: &dyn SecretStore,
    sessions: &SessionStore,
    profile_id: &str,
    model: &str,
    qual: Option<&SharedQualification>,
    deadline: Instant,
    cancel: &Arc<AtomicBool>,
) -> CaseReport {
    let direct = lane_from_qualification(
        qual,
        cd_core::capability_qualification::CapabilityKind::StructuredOutput,
    );
    let question = format!(
        "Reply with ONLY a single JSON object, no prose, no markdown fence, matching exactly: \
         {{\"ok\": true, \"marker\": \"{GENERATION_MARKER}\"}}"
    );
    let (outcome, calls, elapsed) = one_turn(
        paths, cfg, secrets, sessions, profile_id, model, &question, None, None, deadline, cancel,
    )
    .await;
    let product = match outcome {
        Ok(o) => {
            let parsed: Result<serde_json::Value, _> = serde_json::from_str(o.final_text.trim());
            match parsed {
                Ok(v) if v.get("marker").and_then(|m| m.as_str()) == Some(GENERATION_MARKER) => {
                    LaneResult {
                        executed: true,
                        passed: true,
                        detail: "product-path answer parsed as the exact requested JSON shape"
                            .to_string(),
                        elapsed_ms: elapsed.as_millis() as u64,
                        attempts: 1,
                        requests_used: calls.len().max(1) as u32,
                    }
                }
                Ok(_) => LaneResult {
                    executed: true,
                    passed: false,
                    detail: "answer parsed as JSON but did not match the requested shape"
                        .to_string(),
                    elapsed_ms: elapsed.as_millis() as u64,
                    attempts: 1,
                    requests_used: calls.len().max(1) as u32,
                },
                Err(e) => LaneResult {
                    executed: true,
                    passed: false,
                    detail: format!("answer was not valid JSON: {e}"),
                    elapsed_ms: elapsed.as_millis() as u64,
                    attempts: 1,
                    requests_used: calls.len().max(1) as u32,
                },
            }
        }
        Err(e) => LaneResult {
            executed: true,
            passed: false,
            detail: redact_reason(&e),
            elapsed_ms: elapsed.as_millis() as u64,
            attempts: 1,
            requests_used: calls.len().max(1) as u32,
        },
    };
    let retried = calls.iter().any(|c| c.application_retry_reason.is_some());
    let scorer =
        LaneResult::not_applicable("no separate scorer beyond shape validation".to_string());
    let classification = classify(&direct, &product, &scorer, retried);
    CaseReport {
        case_id: "structured_response",
        description: case_description("structured_response"),
        direct,
        product,
        scorer,
        classification,
    }
}

fn seed_marker_corpus(
    cache_root: &std::path::Path,
    name: &str,
    marker: &str,
    detail: &str,
) -> Result<String, String> {
    let corpus = LogCorpus::create(cache_root, name).map_err(|e| e.to_string())?;
    let corpus_id = corpus.id().to_string();
    let base_ts: i64 = 1_800_000_000;
    let events = vec![LogEvent {
        seq: 1,
        ts: base_ts,
        timestamp_provenance: TimestampProvenance::ExplicitWallClock,
        active_timestamp_basis: ActiveTimestampBasis::ExplicitWall,
        unresolved_local_timestamp: None,
        level: "INFO".into(),
        service: Some("gateway-diagnose".into()),
        host: Some("synthetic-host".into()),
        template_id: 1,
        params: vec![],
        trace_id: None,
        message: format!("{marker} {detail}"),
        source: "synthetic/gateway-diagnose.log".into(),
    }];
    corpus.push_events(&events).map_err(|e| e.to_string())?;
    corpus
        .upsert_templates(std::iter::once(TemplateRow {
            info: TemplateInfo {
                template_id: 1,
                pattern: detail.to_string(),
                token_count: detail.split_whitespace().count(),
                count: 1,
                first_seen: base_ts,
                last_seen: base_ts,
                severity: 1,
                example: detail.to_string(),
            },
            content_hash: "gateway-diagnose-synthetic-hash-1".to_string(),
            vector: None,
        }))
        .map_err(|e| e.to_string())?;
    corpus
        .write_ingest_summary(
            Some("contextdesk gateway diagnose synthetic check".to_string()),
            CorpusStats {
                files: 1,
                discovered_files: 1,
                lines: 1,
                templates: 1,
                ts_min: Some(base_ts),
                ts_max: Some(base_ts),
                ..Default::default()
            },
            vec![],
            CorpusEmbeddingStatus::default(),
        )
        .map_err(|e| e.to_string())?;
    corpus.flush().map_err(|e| e.to_string())?;
    Ok(corpus_id)
}

#[allow(clippy::too_many_arguments)]
async fn case_tool_call_continuation(
    paths: &Paths,
    cfg: &AppConfig,
    secrets: &dyn SecretStore,
    sessions: &SessionStore,
    profile_id: &str,
    model: &str,
    qual: Option<&SharedQualification>,
    deadline: Instant,
    cancel: &Arc<AtomicBool>,
    corpora: &mut Vec<String>,
    created_sessions: &mut Vec<String>,
) -> CaseReport {
    let direct = combine_lanes(
        lane_from_qualification(
            qual,
            cd_core::capability_qualification::CapabilityKind::NativeToolCall,
        ),
        lane_from_qualification(
            qual,
            cd_core::capability_qualification::CapabilityKind::ToolResultContinuation,
        ),
    );
    let corpus_id = match seed_marker_corpus(
        &paths.cache_root,
        "contextdesk-gateway-diagnose-tool",
        TOOL_MARKER,
        "correlation=gwdx-tool-1",
    ) {
        Ok(id) => id,
        Err(e) => {
            let lane = LaneResult {
                executed: true,
                passed: false,
                detail: format!("could not create synthetic corpus: {e}"),
                elapsed_ms: 0,
                attempts: 1,
                requests_used: 0,
            };
            return CaseReport {
                case_id: "tool_call_continuation",
                description: case_description("tool_call_continuation"),
                direct,
                product: lane,
                scorer: LaneResult::not_applicable("corpus setup failed".to_string()),
                classification: CaseClassification::ProductIntegrationLikely,
            };
        }
    };
    corpora.push(corpus_id.clone());
    let question = format!(
        "Search the logs for {TOOL_MARKER} and tell me exactly what correlation id it \
         referenced. Cite the matching event exactly as seq=N plus source=\"...\" from the \
         bounded tool result."
    );
    let (outcome, calls, elapsed) = one_turn(
        paths,
        cfg,
        secrets,
        sessions,
        profile_id,
        model,
        &question,
        Some(&corpus_id),
        None,
        deadline,
        cancel,
    )
    .await;
    let tool_called = matches!(&outcome, Ok(o) if o.events.iter().any(|e| matches!(
        e,
        StreamEvent::Tool { phase: cd_core::events::ToolPhase::Finished, ok: Some(true), .. }
    )));
    if let Ok(o) = &outcome {
        created_sessions.push(o.session_id.clone());
    }
    let grounding = match &outcome {
        Ok(o) => crate::commands::chat::grounding_status(Some(&corpus_id), &o.events),
        Err(_) => "not_applicable",
    };
    let product = match &outcome {
        Ok(_) if tool_called && grounding == "grounded" => LaneResult {
            executed: true,
            passed: true,
            detail: "real search tool executed and answer was validated as grounded".to_string(),
            elapsed_ms: elapsed.as_millis() as u64,
            attempts: 1,
            requests_used: calls.len().max(1) as u32,
        },
        Ok(_) => LaneResult {
            executed: true,
            passed: false,
            detail: format!("tool_called={tool_called} grounding={grounding}"),
            elapsed_ms: elapsed.as_millis() as u64,
            attempts: 1,
            requests_used: calls.len().max(1) as u32,
        },
        Err(e) => LaneResult {
            executed: true,
            passed: false,
            detail: redact_reason(e),
            elapsed_ms: elapsed.as_millis() as u64,
            attempts: 1,
            requests_used: calls.len().max(1) as u32,
        },
    };
    let retried = calls.iter().any(|c| c.application_retry_reason.is_some())
        || matches!(&calls.first().map(|c| &c.outcome), Some(TracedOutcome::Completed { tool_call_count, .. }) if *tool_call_count > 0)
            && calls.len() > 1;
    let scorer = LaneResult::not_applicable(
        "grounding classification is the scorer for this case".to_string(),
    );
    let classification = classify(&direct, &product, &scorer, retried);
    CaseReport {
        case_id: "tool_call_continuation",
        description: case_description("tool_call_continuation"),
        direct,
        product,
        scorer,
        classification,
    }
}

#[allow(clippy::too_many_arguments)]
async fn case_attachment_selected_context(
    paths: &Paths,
    cfg: &AppConfig,
    secrets: &dyn SecretStore,
    sessions: &SessionStore,
    profile_id: &str,
    model: &str,
    deadline: Instant,
    cancel: &Arc<AtomicBool>,
    created_sessions: &mut Vec<String>,
) -> CaseReport {
    let direct = LaneResult::not_applicable(
        "no raw-provider equivalent of a selected-context attachment turn".to_string(),
    );
    let selection = format!(
        "Attached note: the incident ticket number is {ATTACH_MARKER}. An unrelated older \
         ticket number {ATTACH_DECOY} was superseded and must not be used."
    );
    let question = "What is the current incident ticket number from the attached note? \
        Answer with only the ticket number.";
    let (outcome, calls, elapsed) = one_turn(
        paths,
        cfg,
        secrets,
        sessions,
        profile_id,
        model,
        question,
        None,
        Some(&selection),
        deadline,
        cancel,
    )
    .await;
    if let Ok(o) = &outcome {
        created_sessions.push(o.session_id.clone());
    }
    let scorer = match &outcome {
        Ok(o) => {
            let text = &o.final_text;
            let has_fact = text.contains(ATTACH_MARKER);
            let avoids_decoy = !text.contains(ATTACH_DECOY);
            LaneResult {
                executed: true,
                passed: has_fact && avoids_decoy,
                detail: format!(
                    "cites_current_fact={has_fact} avoids_superseded_decoy={avoids_decoy}"
                ),
                elapsed_ms: 0,
                attempts: 1,
                requests_used: 0,
            }
        }
        Err(_) => LaneResult::not_applicable("turn did not complete".to_string()),
    };
    let product = match &outcome {
        Ok(_) => LaneResult {
            executed: true,
            passed: true,
            detail: "product-path selected-context turn completed".to_string(),
            elapsed_ms: elapsed.as_millis() as u64,
            attempts: 1,
            requests_used: calls.len().max(1) as u32,
        },
        Err(e) => LaneResult {
            executed: true,
            passed: false,
            detail: redact_reason(e),
            elapsed_ms: elapsed.as_millis() as u64,
            attempts: 1,
            requests_used: calls.len().max(1) as u32,
        },
    };
    let retried = calls.iter().any(|c| c.application_retry_reason.is_some());
    let classification = classify(&direct, &product, &scorer, retried);
    CaseReport {
        case_id: "attachment_selected_context",
        description: case_description("attachment_selected_context"),
        direct,
        product,
        scorer,
        classification,
    }
}

/// Trigger, louder downstream symptom, an unrelated decoy incident, and a
/// recovery event — truth never enters model-visible input; it lives only
/// in the [`TriageKnownAnswerKey`] built alongside the corpus, used solely
/// at scoring time.
fn seed_triage_corpus(
    cache_root: &std::path::Path,
) -> Result<(String, TriageKnownAnswerKey, TriageHostFacts), String> {
    let corpus = LogCorpus::create(cache_root, "contextdesk-gateway-diagnose-triage")
        .map_err(|e| e.to_string())?;
    let corpus_id = corpus.id().to_string();
    let base_ts: i64 = 1_800_100_000;
    let source = "synthetic/gateway-diagnose-triage.log".to_string();
    let trigger_msg = "kind=config_error level=error service=control lease window 250ms below supported minimum 1000ms";
    let symptom_msg_1 =
        "kind=exception level=error service=worker LeaseWindowExpired during acquisition";
    let symptom_msg_2 =
        "kind=exception level=error service=worker LeaseWindowExpired retry exhausted";
    let symptom_msg_3 =
        "kind=exception level=error service=worker LeaseWindowExpired retry exhausted again";
    let decoy_msg = "kind=alert level=warn service=billing-metrics unrelated disk usage alert cleared automatically";
    let recovery_msg = "kind=config_event level=info service=control restored revision r16 lease window 4000ms lease acquisition recovered";

    let events = vec![
        LogEvent {
            seq: 1,
            ts: base_ts,
            timestamp_provenance: TimestampProvenance::ExplicitWallClock,
            active_timestamp_basis: ActiveTimestampBasis::ExplicitWall,
            unresolved_local_timestamp: None,
            level: "ERROR".into(),
            service: Some("control".into()),
            host: Some("synthetic-host".into()),
            template_id: 1,
            params: vec![],
            trace_id: None,
            message: trigger_msg.to_string(),
            source: source.clone(),
        },
        LogEvent {
            seq: 2,
            ts: base_ts + 1,
            timestamp_provenance: TimestampProvenance::ExplicitWallClock,
            active_timestamp_basis: ActiveTimestampBasis::ExplicitWall,
            unresolved_local_timestamp: None,
            level: "WARN".into(),
            service: Some("billing-metrics".into()),
            host: Some("synthetic-host-2".into()),
            template_id: 2,
            params: vec![],
            trace_id: None,
            message: decoy_msg.to_string(),
            source: source.clone(),
        },
        LogEvent {
            seq: 3,
            ts: base_ts + 2,
            timestamp_provenance: TimestampProvenance::ExplicitWallClock,
            active_timestamp_basis: ActiveTimestampBasis::ExplicitWall,
            unresolved_local_timestamp: None,
            level: "ERROR".into(),
            service: Some("worker".into()),
            host: Some("synthetic-host".into()),
            template_id: 3,
            params: vec![],
            trace_id: None,
            message: symptom_msg_1.to_string(),
            source: source.clone(),
        },
        LogEvent {
            seq: 4,
            ts: base_ts + 3,
            timestamp_provenance: TimestampProvenance::ExplicitWallClock,
            active_timestamp_basis: ActiveTimestampBasis::ExplicitWall,
            unresolved_local_timestamp: None,
            level: "ERROR".into(),
            service: Some("worker".into()),
            host: Some("synthetic-host".into()),
            template_id: 3,
            params: vec![],
            trace_id: None,
            message: symptom_msg_2.to_string(),
            source: source.clone(),
        },
        LogEvent {
            seq: 5,
            ts: base_ts + 4,
            timestamp_provenance: TimestampProvenance::ExplicitWallClock,
            active_timestamp_basis: ActiveTimestampBasis::ExplicitWall,
            unresolved_local_timestamp: None,
            level: "ERROR".into(),
            service: Some("worker".into()),
            host: Some("synthetic-host".into()),
            template_id: 3,
            params: vec![],
            trace_id: None,
            message: symptom_msg_3.to_string(),
            source: source.clone(),
        },
        LogEvent {
            seq: 6,
            ts: base_ts + 5,
            timestamp_provenance: TimestampProvenance::ExplicitWallClock,
            active_timestamp_basis: ActiveTimestampBasis::ExplicitWall,
            unresolved_local_timestamp: None,
            level: "INFO".into(),
            service: Some("control".into()),
            host: Some("synthetic-host".into()),
            template_id: 4,
            params: vec![],
            trace_id: None,
            message: recovery_msg.to_string(),
            source: source.clone(),
        },
    ];
    corpus.push_events(&events).map_err(|e| e.to_string())?;
    let templates = [
        (1u64, "lease window below minimum", 4u8),
        (2u64, "unrelated disk usage alert", 2u8),
        (3u64, "LeaseWindowExpired", 4u8),
        (4u64, "restored lease window", 1u8),
    ];
    corpus
        .upsert_templates(
            templates
                .iter()
                .map(|(template_id, pattern, severity)| TemplateRow {
                    info: TemplateInfo {
                        template_id: *template_id,
                        pattern: (*pattern).into(),
                        token_count: pattern.split_whitespace().count(),
                        count: 1,
                        first_seen: base_ts,
                        last_seen: base_ts + 5,
                        severity: *severity,
                        example: (*pattern).into(),
                    },
                    content_hash: format!("gateway-diagnose-triage-hash-{template_id}"),
                    vector: None,
                }),
        )
        .map_err(|e| e.to_string())?;
    corpus
        .write_ingest_summary(
            Some("contextdesk gateway diagnose synthetic triage fixture".to_string()),
            CorpusStats {
                files: 1,
                discovered_files: 1,
                lines: events.len() as u64,
                templates: templates.len() as u64,
                ts_min: Some(base_ts),
                ts_max: Some(base_ts + 5),
                ..Default::default()
            },
            vec![],
            CorpusEmbeddingStatus::default(),
        )
        .map_err(|e| e.to_string())?;
    corpus.flush().map_err(|e| e.to_string())?;

    let key = TriageKnownAnswerKey {
        case_id: "gateway-diagnose-triage-v1".to_string(),
        time_quality_expected: "wall".to_string(),
        sources_present: vec![source.clone()],
        sources_omitted: vec![],
        decoy_earliest_error_message_token: None,
        true_trigger_message_token: Some("lease window 250ms below supported minimum".to_string()),
        competing_trigger_message_tokens: vec![],
        symptom_message_tokens: vec!["LeaseWindowExpired".to_string()],
        root_cause_establishable: true,
        forbidden_claims: vec![],
        required_disclosures: vec![],
    };
    let evidence: Vec<SearchEvidenceIdentity> = events
        .iter()
        .map(|e| SearchEvidenceIdentity {
            seq: e.seq,
            source: e.source.clone(),
            citation_source: None,
            template_id: e.template_id,
        })
        .collect();
    let messages_by_seq: Vec<(u64, String, String)> = events
        .iter()
        .map(|e| (e.seq, e.source.clone(), e.message.clone()))
        .collect();
    let error_count = events.iter().filter(|e| e.level == "ERROR").count() as u64;
    let host = TriageHostFacts {
        time_quality: "wall".to_string(),
        exact_event_count: events.len() as u64,
        exact_error_count: Some(error_count),
        sources_present: [source].into_iter().collect(),
        evidence,
        messages_by_seq,
        known_semantic_occurrence_count: None,
        stderr_record_count: None,
        raw_exception_record_count: None,
        episode_counts_complete: false,
    };
    Ok((corpus_id, key, host))
}

#[allow(clippy::too_many_arguments)]
async fn case_linked_log_triage(
    paths: &Paths,
    cfg: &AppConfig,
    secrets: &dyn SecretStore,
    sessions: &SessionStore,
    profile_id: &str,
    model: &str,
    deadline: Instant,
    cancel: &Arc<AtomicBool>,
    level: DiagnoseLevel,
    corpora: &mut Vec<String>,
    created_sessions: &mut Vec<String>,
) -> CaseReport {
    let direct = LaneResult::not_applicable(
        "no raw-provider equivalent of a multi-stage product-path triage turn".to_string(),
    );
    let (corpus_id, key, host) = match seed_triage_corpus(&paths.cache_root) {
        Ok(v) => v,
        Err(e) => {
            let lane = LaneResult {
                executed: true,
                passed: false,
                detail: format!("could not create synthetic triage corpus: {e}"),
                elapsed_ms: 0,
                attempts: 1,
                requests_used: 0,
            };
            return CaseReport {
                case_id: "linked_log_triage",
                description: case_description("linked_log_triage"),
                direct,
                product: lane,
                scorer: LaneResult::not_applicable("corpus setup failed".to_string()),
                classification: CaseClassification::ProductIntegrationLikely,
            };
        }
    };
    corpora.push(corpus_id.clone());

    let question = format!(
        "Investigate this incident using the linked logs. What was the initiating trigger, what \
         downstream symptoms followed, which events are unrelated noise, and what shows recovery? \
         {}",
        triage_answer_contract_system_text()
    );

    let attempts = if level == DiagnoseLevel::Extended {
        2
    } else {
        1
    };
    let mut last_outcome = None;
    let mut last_calls = Vec::new();
    let mut total_elapsed = Duration::ZERO;
    let mut total_requests = 0u32;
    let mut pass_seen = false;
    let mut fail_seen = false;
    let mut last_scorer_detail = String::new();
    let mut last_terminal_detail = String::new();

    for attempt in 0..attempts {
        if Instant::now() >= deadline {
            break;
        }
        let (outcome, calls, elapsed) = one_turn(
            paths,
            cfg,
            secrets,
            sessions,
            profile_id,
            model,
            &question,
            Some(&corpus_id),
            None,
            deadline,
            cancel,
        )
        .await;
        total_elapsed += elapsed;
        total_requests += calls.len().max(1) as u32;
        if let Ok(o) = &outcome {
            created_sessions.push(o.session_id.clone());
            last_terminal_detail = terminal_channel_summary(&o.events);
            if o.final_text.trim().is_empty() {
                fail_seen = true;
                last_scorer_detail = format!(
                    "attempt {}: no visible terminal answer; {}",
                    attempt + 1,
                    last_terminal_detail
                );
            } else {
                let parsed = parse_structured_triage_answer(&o.final_text);
                match parsed {
                    Ok(answer) => {
                        let score = score_structured_triage_answer(&answer, &key, &host);
                        last_scorer_detail = format!(
                            "attempt {}: passed={} failed_dimensions=[{}]",
                            attempt + 1,
                            score.passed,
                            score.failed_ids().join(",")
                        );
                        if score.passed {
                            pass_seen = true;
                        } else {
                            fail_seen = true;
                        }
                    }
                    Err(e) => {
                        fail_seen = true;
                        last_scorer_detail = format!(
                            "attempt {}: contract parse failed: {e}; {}",
                            attempt + 1,
                            last_terminal_detail
                        );
                    }
                }
            }
        } else if let Err(e) = &outcome {
            fail_seen = true;
            last_scorer_detail =
                format!("attempt {}: turn failed: {}", attempt + 1, redact_reason(e));
        }
        last_outcome = Some(outcome);
        last_calls = calls;
    }

    let product = match &last_outcome {
        Some(Ok(o)) if o.final_text.trim().is_empty() => LaneResult {
            executed: true,
            passed: false,
            detail: format!(
                "product-path turn completed without a visible terminal answer; {last_terminal_detail}"
            ),
            elapsed_ms: total_elapsed.as_millis() as u64,
            attempts,
            requests_used: total_requests,
        },
        Some(Ok(_)) => LaneResult {
            executed: true,
            passed: true,
            detail: "product-path triage turn completed".to_string(),
            elapsed_ms: total_elapsed.as_millis() as u64,
            attempts,
            requests_used: total_requests,
        },
        Some(Err(e)) => LaneResult {
            executed: true,
            passed: false,
            detail: redact_reason(e),
            elapsed_ms: total_elapsed.as_millis() as u64,
            attempts,
            requests_used: total_requests,
        },
        None => LaneResult {
            executed: false,
            passed: false,
            detail: "deadline exceeded before the triage turn ran".to_string(),
            elapsed_ms: total_elapsed.as_millis() as u64,
            attempts: 0,
            requests_used: total_requests,
        },
    };
    let scorer = LaneResult {
        executed: !last_scorer_detail.is_empty(),
        passed: pass_seen,
        detail: last_scorer_detail,
        elapsed_ms: 0,
        attempts,
        requests_used: 0,
    };
    let retried = pass_seen && fail_seen;
    let classification = if !product.executed {
        CaseClassification::NotRun
    } else if !product.passed {
        CaseClassification::ProductIntegrationLikely
    } else if scorer.executed && !scorer.passed && !retried {
        CaseClassification::UsefulnessGap
    } else if retried {
        CaseClassification::RetryRequired
    } else if scorer.executed && scorer.passed {
        CaseClassification::Compatible
    } else {
        CaseClassification::UsefulnessGap
    };
    let _ = last_calls;
    CaseReport {
        case_id: "linked_log_triage",
        description: case_description("linked_log_triage"),
        direct,
        product,
        scorer,
        classification,
    }
}

async fn case_embedding_or_rerank(
    profile: &ProviderProfile,
    model: &str,
    role: ModelRoleHint,
    credentials: &LiveCredentials,
    deadline: Instant,
) -> CaseReport {
    let kind = if role == ModelRoleHint::Embedding {
        cd_core::capability_qualification::CapabilityKind::EmbeddingContract
    } else {
        cd_core::capability_qualification::CapabilityKind::RerankerContract
    };
    let qual = run_shared_qualification(profile, model, credentials, deadline).await;
    let requests_used = qual.requests_used;
    let mut direct = lane_from_qualification(Some(&qual), kind);
    direct.requests_used = requests_used;

    // Small, known-ranking case: three short synthetic documents with one
    // expected best match for the query. Real production adapters only
    // (`cd_core::rerank::HttpRerankBackend`, generic HTTP reranking;
    // `cd_core::embed::OllamaEmbedBackend` for Ollama-hosted embedding
    // profiles) — never a bespoke second HTTP client.
    let query = "database connection timeout".to_string();
    let docs = vec![
        "the database connection pool timed out after 30 seconds".to_string(),
        "the weather today is sunny with a light breeze".to_string(),
        "invoices are generated nightly by the billing batch job".to_string(),
    ];
    let expected_best = 0usize;

    let product = if role == ModelRoleHint::Reranker {
        match HttpRerankBackend::new(&profile.base_url, model, credentials.api_key.clone()) {
            Ok(backend) => {
                use cd_core::rerank::RerankBackend;
                match tokio::time::timeout(
                    deadline
                        .saturating_duration_since(Instant::now())
                        .max(Duration::from_millis(1)),
                    backend.rerank(&query, &docs),
                )
                .await
                {
                    Ok(Ok(scores)) => {
                        let best = scores
                            .iter()
                            .enumerate()
                            .max_by(|a, b| a.1.total_cmp(b.1))
                            .map(|(i, _)| i);
                        LaneResult {
                            executed: true,
                            passed: best == Some(expected_best),
                            detail: format!("production reranker ranked index {best:?} best (expected {expected_best})"),
                            elapsed_ms: 0,
                            attempts: 1,
                            requests_used: 1,
                        }
                    }
                    Ok(Err(e)) => LaneResult {
                        executed: true,
                        passed: false,
                        detail: redact_reason(&e.to_string()),
                        elapsed_ms: 0,
                        attempts: 1,
                        requests_used: 1,
                    },
                    Err(_) => LaneResult {
                        executed: true,
                        passed: false,
                        detail: "production reranker call timed out".to_string(),
                        elapsed_ms: 0,
                        attempts: 1,
                        requests_used: 0,
                    },
                }
            }
            Err(e) => LaneResult {
                executed: true,
                passed: false,
                detail: redact_reason(&e.to_string()),
                elapsed_ms: 0,
                attempts: 1,
                requests_used: 0,
            },
        }
    } else if profile.kind == ProviderKind::Ollama {
        use cd_core::embed::{EmbedBackend, OllamaEmbedBackend};
        match cd_core::chat::OllamaClient::new(&profile.base_url, model) {
            Ok(client) => {
                let backend = OllamaEmbedBackend::new(client);
                let mut all = vec![query.clone()];
                all.extend(docs.clone());
                match tokio::time::timeout(
                    deadline
                        .saturating_duration_since(Instant::now())
                        .max(Duration::from_millis(1)),
                    backend.embed(&all),
                )
                .await
                {
                    Ok(Ok(vectors)) if vectors.len() == all.len() => {
                        let query_vec = &vectors[0];
                        let mut sims: Vec<(usize, f32)> = vectors[1..]
                            .iter()
                            .enumerate()
                            .map(|(i, v)| (i, cosine(query_vec, v)))
                            .collect();
                        sims.sort_by(|a, b| b.1.total_cmp(&a.1));
                        let best = sims.first().map(|(i, _)| *i);
                        LaneResult {
                            executed: true,
                            passed: best == Some(expected_best),
                            detail: format!("production embedding backend ranked index {best:?} best (expected {expected_best})"),
                            elapsed_ms: 0,
                            attempts: 1,
                            requests_used: 1,
                        }
                    }
                    Ok(Ok(_)) => LaneResult {
                        executed: true,
                        passed: false,
                        detail: "embedding backend returned an unexpected vector count".to_string(),
                        elapsed_ms: 0,
                        attempts: 1,
                        requests_used: 1,
                    },
                    Ok(Err(e)) => LaneResult {
                        executed: true,
                        passed: false,
                        detail: redact_reason(&e.to_string()),
                        elapsed_ms: 0,
                        attempts: 1,
                        requests_used: 1,
                    },
                    Err(_) => LaneResult {
                        executed: true,
                        passed: false,
                        detail: "production embedding call timed out".to_string(),
                        elapsed_ms: 0,
                        attempts: 1,
                        requests_used: 0,
                    },
                }
            }
            Err(e) => LaneResult {
                executed: true,
                passed: false,
                detail: redact_reason(&e.to_string()),
                elapsed_ms: 0,
                attempts: 1,
                requests_used: 0,
            },
        }
    } else {
        LaneResult::not_applicable(
            "not_run: no production embedding backend is wired for this provider kind outside \
             the qualification transport yet — follow-up: extend cd_core::embed with a generic \
             OpenAI-compatible production backend"
                .to_string(),
        )
    };

    let scorer =
        LaneResult::not_applicable("ranking-order match is the scorer for this case".to_string());
    let classification = classify(&direct, &product, &scorer, false);
    CaseReport {
        case_id: "embedding_or_rerank_contract",
        description: case_description("embedding_or_rerank_contract"),
        direct,
        product,
        scorer,
        classification,
    }
}

fn cosine(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let dot: f32 = a.iter().zip(b.iter()).map(|(x, y)| x * y).sum();
    let na: f32 = a.iter().map(|x| x * x).sum::<f32>().sqrt();
    let nb: f32 = b.iter().map(|x| x * x).sum::<f32>().sqrt();
    if na == 0.0 || nb == 0.0 {
        0.0
    } else {
        dot / (na * nb)
    }
}

// ---------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------

fn cleanup_all(
    paths: &Paths,
    sessions: &SessionStore,
    corpora: &[String],
    created_sessions: &[String],
) -> CleanupReport {
    let mut failures = Vec::new();
    let mut corpora_removed = 0usize;
    for corpus_id in corpora {
        match LogCorpus::discard(&paths.cache_root, corpus_id) {
            Ok(()) => corpora_removed += 1,
            Err(e) => failures.push(format!("corpus {corpus_id} was not removed: {e}")),
        }
    }
    let mut sessions_removed = 0usize;
    let mut seen = std::collections::BTreeSet::new();
    for session_id in created_sessions {
        if !seen.insert(session_id.clone()) {
            continue;
        }
        match sessions.delete(session_id) {
            Ok(()) => sessions_removed += 1,
            Err(e) => failures.push(format!("session {session_id} was not removed: {e}")),
        }
    }
    CleanupReport {
        corpora_created: corpora.len(),
        corpora_removed,
        sessions_created: seen.len(),
        sessions_removed,
        failures,
    }
}

// ---------------------------------------------------------------------
// Artifact bundle
// ---------------------------------------------------------------------

fn artifact_root(paths: &Paths, out: &Option<PathBuf>, run_dir: &str) -> PathBuf {
    out.clone()
        .unwrap_or_else(|| paths.cache_root.join("gateway-diagnostics"))
        .join(run_dir)
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn write_artifact_bundle(
    args: &GatewayDiagnoseArgs,
    paths: &Paths,
    run_dir: &str,
    report: &GatewayDiagnosticReport,
    redaction: &ShareSafeRedactionPolicy,
) -> Result<PathBuf, String> {
    let dir = artifact_root(paths, &args.out, run_dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut share_safe_report = report.clone();
    sanitize_gateway_report(&mut share_safe_report, redaction);
    let body = serde_json::to_vec_pretty(&share_safe_report).map_err(|e| e.to_string())?;
    let report_path = dir.join("report.json");
    std::fs::write(&report_path, &body).map_err(|e| e.to_string())?;
    let checksum = sha256_hex(&body);
    let manifest = serde_json::json!({
        "schema_id": "contextdesk.gateway_diagnostic_manifest.v1",
        "schema_version": 1,
        "run_id": share_safe_report.run_id,
        "files": [
            { "name": "report.json", "sha256": checksum, "bytes": body.len() }
        ],
    });
    std::fs::write(
        dir.join("manifest.json"),
        serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Owner-only, local-only private capture: bounded synthetic case detail
/// (already redacted lane details — never raw credentials, since those
/// never reach this struct in the first place). Written only under
/// `--raw --raw-i-understand`, and never referenced by content from the
/// share-safe `report.json`/`manifest.json` above.
fn write_private_capture(
    args: &GatewayDiagnoseArgs,
    paths: &Paths,
    run_dir: &str,
    report: &GatewayDiagnosticReport,
    redaction: &ShareSafeRedactionPolicy,
) -> Result<(), String> {
    let dir = artifact_root(paths, &args.out, run_dir).join("private");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut safe_report = report.clone();
    sanitize_gateway_report(&mut safe_report, redaction);
    let body = serde_json::json!({
        "schema_id": "contextdesk.gateway_diagnostic_private_capture.v1",
        "local_only": true,
        "note": "bounded synthetic lane detail only; never credentials, auth headers, or user corpora",
        "run_id": safe_report.run_id,
        "cases": safe_report.cases,
    });
    let path = dir.join("capture.json");
    std::fs::write(
        &path,
        serde_json::to_vec_pretty(&body).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[test]
    fn terminal_channel_summary_reports_empty_completed_answer() {
        let summary = terminal_channel_summary(&[StreamEvent::TurnCompleted {
            reason: "stop".into(),
        }]);
        assert!(summary.contains("terminal_text_chars=0"));
        assert!(summary.contains("text_delta_count=0"));
        assert!(summary.contains("turn_terminal=stop"));
    }

    fn pass_lane() -> LaneResult {
        LaneResult {
            executed: true,
            passed: true,
            detail: "ok".to_string(),
            elapsed_ms: 1,
            attempts: 1,
            requests_used: 1,
        }
    }

    fn fail_lane() -> LaneResult {
        LaneResult {
            executed: true,
            passed: false,
            detail: "no".to_string(),
            elapsed_ms: 1,
            attempts: 1,
            requests_used: 1,
        }
    }

    #[test]
    fn classify_both_lanes_failed_points_at_gateway_or_model() {
        let scorer = LaneResult::not_applicable("n/a".to_string());
        assert_eq!(
            classify(&fail_lane(), &fail_lane(), &scorer, false),
            CaseClassification::GatewayOrModelLikely
        );
    }

    #[test]
    fn classify_direct_pass_product_fail_points_at_product_integration() {
        let scorer = LaneResult::not_applicable("n/a".to_string());
        assert_eq!(
            classify(&pass_lane(), &fail_lane(), &scorer, false),
            CaseClassification::ProductIntegrationLikely
        );
    }

    #[test]
    fn classify_no_direct_baseline_and_product_failed_is_still_product_integration_evidence() {
        let scorer = LaneResult::not_applicable("n/a".to_string());
        let no_direct = LaneResult::not_applicable("no raw-provider equivalent".to_string());
        assert_eq!(
            classify(&no_direct, &fail_lane(), &scorer, false),
            CaseClassification::ProductIntegrationLikely
        );
    }

    #[test]
    fn classify_both_pass_but_scorer_fails_is_a_usefulness_gap_not_a_compatibility_failure() {
        assert_eq!(
            classify(&pass_lane(), &pass_lane(), &fail_lane(), false),
            CaseClassification::UsefulnessGap
        );
    }

    #[test]
    fn classify_both_pass_after_a_retry_is_retry_required_not_silently_compatible() {
        let scorer = LaneResult::not_applicable("n/a".to_string());
        assert_eq!(
            classify(&pass_lane(), &pass_lane(), &scorer, true),
            CaseClassification::RetryRequired
        );
    }

    #[test]
    fn classify_both_pass_no_retry_no_scorer_gap_is_compatible() {
        let scorer = LaneResult::not_applicable("n/a".to_string());
        assert_eq!(
            classify(&pass_lane(), &pass_lane(), &scorer, false),
            CaseClassification::Compatible
        );
    }

    fn case_with_lanes(
        direct: LaneResult,
        product: LaneResult,
        scorer: LaneResult,
        classification: CaseClassification,
    ) -> CaseReport {
        CaseReport {
            case_id: "test",
            description: "test",
            direct,
            product,
            scorer,
            classification,
        }
    }

    #[test]
    fn verdicts_are_inconclusive_when_no_applicable_case_executed() {
        let skipped = skipped_case("test", "deadline exceeded");
        let verdicts = compute_verdicts(&[skipped]);
        assert_eq!(verdicts.gateway_model_status, VerdictStatus::Inconclusive);
        assert_eq!(
            verdicts.product_workflow_status,
            VerdictStatus::Inconclusive
        );
        assert_eq!(verdicts.answers_useful_status, VerdictStatus::Inconclusive);
        assert!(!verdicts.gateway_model_compatible);
        assert!(!verdicts.product_workflow_compatible);
        assert!(!verdicts.answers_useful);
    }

    #[test]
    fn verdicts_require_measured_passes_and_keep_dimensions_separate() {
        let useful = compute_verdicts(&[case_with_lanes(
            pass_lane(),
            pass_lane(),
            pass_lane(),
            CaseClassification::Compatible,
        )]);
        assert_eq!(useful.gateway_model_status, VerdictStatus::Pass);
        assert_eq!(useful.product_workflow_status, VerdictStatus::Pass);
        assert_eq!(useful.answers_useful_status, VerdictStatus::Pass);

        let gateway_failure = compute_verdicts(&[case_with_lanes(
            fail_lane(),
            fail_lane(),
            LaneResult::not_applicable("n/a"),
            CaseClassification::GatewayOrModelLikely,
        )]);
        assert_eq!(gateway_failure.gateway_model_status, VerdictStatus::Fail);
        assert_eq!(
            gateway_failure.product_workflow_status,
            VerdictStatus::Inconclusive
        );

        let usefulness_failure = compute_verdicts(&[case_with_lanes(
            pass_lane(),
            pass_lane(),
            fail_lane(),
            CaseClassification::UsefulnessGap,
        )]);
        assert_eq!(usefulness_failure.gateway_model_status, VerdictStatus::Pass);
        assert_eq!(
            usefulness_failure.product_workflow_status,
            VerdictStatus::Pass
        );
        assert_eq!(
            usefulness_failure.answers_useful_status,
            VerdictStatus::Fail
        );
    }

    #[test]
    fn classify_product_never_executed_is_not_run_regardless_of_direct() {
        let not_run_product = LaneResult {
            executed: false,
            ..fail_lane()
        };
        let scorer = LaneResult::not_applicable("n/a".to_string());
        assert_eq!(
            classify(&pass_lane(), &not_run_product, &scorer, false),
            CaseClassification::NotRun
        );
    }

    #[test]
    fn combine_lanes_requires_both_to_pass() {
        let combined = combine_lanes(pass_lane(), fail_lane());
        assert!(
            !combined.passed,
            "one failing probe must fail the combined lane"
        );
        assert!(combined.detail.contains("ok"));
        assert!(combined.detail.contains("no"));
        assert_eq!(combined.requests_used, 2);
    }

    #[test]
    fn combine_lanes_both_pass_is_a_pass() {
        let combined = combine_lanes(pass_lane(), pass_lane());
        assert!(combined.passed);
    }

    #[test]
    fn lane_from_qualification_reports_not_applicable_when_no_pass_was_run() {
        let lane = lane_from_qualification(
            None,
            cd_core::capability_qualification::CapabilityKind::BasicGeneration,
        );
        assert!(!lane.executed);
        assert!(!lane.passed);
    }

    #[test]
    fn lane_from_qualification_surfaces_a_failed_shared_pass_as_a_failed_lane_not_not_applicable() {
        let qual = SharedQualification {
            report: None,
            requests_used: 0,
            failure_detail: Some("simulated failure".to_string()),
        };
        let lane = lane_from_qualification(
            Some(&qual),
            cd_core::capability_qualification::CapabilityKind::BasicGeneration,
        );
        assert!(
            lane.executed,
            "a failed shared pass must still be reported, not swallowed"
        );
        assert!(!lane.passed);
        assert!(lane.detail.contains("simulated failure"));
    }

    #[test]
    fn build_plan_never_expands_for_embedding_or_reranker_roles() {
        let plan = build_plan(DiagnoseLevel::Basic, ModelRoleHint::Embedding, 180, false);
        assert_eq!(plan.case_ids, vec!["embedding_or_rerank_contract"]);
        let plan = build_plan(DiagnoseLevel::Basic, ModelRoleHint::Reranker, 180, false);
        assert_eq!(plan.case_ids, vec!["embedding_or_rerank_contract"]);
    }

    #[test]
    fn build_plan_chat_role_never_sends_specialty_cases() {
        let plan = build_plan(
            DiagnoseLevel::Basic,
            ModelRoleHint::Investigator,
            180,
            false,
        );
        assert!(!plan.case_ids.contains(&"embedding_or_rerank_contract"));
        assert_eq!(plan.case_ids.len(), 5);
    }

    #[test]
    fn build_plan_extended_level_states_a_larger_request_bound_than_basic() {
        let basic = build_plan(
            DiagnoseLevel::Basic,
            ModelRoleHint::Investigator,
            180,
            false,
        );
        let extended = build_plan(
            DiagnoseLevel::Extended,
            ModelRoleHint::Investigator,
            180,
            false,
        );
        assert!(
            extended.max_requests > basic.max_requests,
            "extended must state a larger bound, never a silently identical one"
        );
    }

    #[test]
    fn build_plan_raw_adds_the_private_artifact_class_only_when_requested() {
        let without_raw = build_plan(
            DiagnoseLevel::Basic,
            ModelRoleHint::Investigator,
            180,
            false,
        );
        assert_eq!(without_raw.artifact_classes, vec!["share_safe_bundle"]);
        let with_raw = build_plan(DiagnoseLevel::Basic, ModelRoleHint::Investigator, 180, true);
        assert_eq!(
            with_raw.artifact_classes,
            vec!["share_safe_bundle", "private_raw_capture"]
        );
    }

    #[test]
    fn pseudonym_is_stable_for_the_same_input_and_never_echoes_it_verbatim() {
        let a = pseudonym("profile:my-private-profile-id");
        let b = pseudonym("profile:my-private-profile-id");
        assert_eq!(
            a, b,
            "the same input must pseudonymize the same way within a process"
        );
        assert!(!a.contains("my-private-profile-id"));
    }

    #[test]
    fn pseudonym_differs_for_different_inputs() {
        let a = pseudonym("profile:one");
        let b = pseudonym("profile:two");
        assert_ne!(a, b);
    }

    #[test]
    fn sha256_hex_matches_a_known_vector() {
        // sha256("") — the standard empty-input test vector.
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn skipped_case_is_reported_as_not_run_never_as_a_silent_pass() {
        let case = skipped_case("linked_log_triage", "deadline exceeded");
        assert_eq!(case.classification, CaseClassification::NotRun);
        assert!(!case.direct.executed);
        assert!(!case.product.executed);
    }

    #[tokio::test(start_paused = true)]
    async fn default_policy_times_out_a_slow_case_at_the_45_second_safety_ceiling() {
        let budget = per_case_budget(Duration::from_secs(600), false);
        assert_eq!(
            budget,
            Duration::from_secs(DEFAULT_PER_CASE_SAFETY_TIMEOUT_SECS)
        );

        let started = tokio::time::Instant::now();
        let outcome = within_case_budget(budget, tokio::time::sleep(Duration::from_secs(46))).await;

        assert!(outcome.is_err(), "the default safety ceiling must win");
        assert_eq!(started.elapsed(), Duration::from_secs(45));
    }

    #[tokio::test(start_paused = true)]
    async fn explicit_600_second_deadline_allows_a_slow_case_past_45_seconds() {
        let budget = per_case_budget(Duration::from_secs(600), true);
        assert_eq!(budget, Duration::from_secs(600));

        let started = tokio::time::Instant::now();
        let outcome = within_case_budget(budget, tokio::time::sleep(Duration::from_secs(46))).await;

        assert!(
            outcome.is_ok(),
            "an explicit 600s deadline must not retain the hidden 45s cap"
        );
        assert_eq!(started.elapsed(), Duration::from_secs(46));
    }

    #[tokio::test(start_paused = true)]
    async fn explicit_policy_still_bounds_a_slow_case_by_the_remaining_whole_run_deadline() {
        let budget = per_case_budget(Duration::from_secs(17), true);
        let started = tokio::time::Instant::now();
        let outcome = within_case_budget(budget, tokio::time::sleep(Duration::from_secs(18))).await;

        assert!(
            outcome.is_err(),
            "remaining whole-run time must stay authoritative"
        );
        assert_eq!(started.elapsed(), Duration::from_secs(17));
    }

    #[tokio::test(start_paused = true)]
    async fn cooperative_cancellation_still_wins_and_retains_case_activity() {
        let budget = per_case_budget(Duration::from_secs(600), true);
        let cancel = Arc::new(AtomicBool::new(false));
        let activity = Arc::new(Mutex::new(Vec::new()));

        let cancel_for_case = cancel.clone();
        let activity_for_case = activity.clone();
        let case = async move {
            activity_for_case.lock().unwrap().push("started");
            loop {
                if cancel_for_case.load(Ordering::SeqCst) {
                    activity_for_case.lock().unwrap().push("cancelled");
                    return "cancelled";
                }
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        };
        let cancel_after_slow_start = async {
            tokio::time::sleep(Duration::from_secs(46)).await;
            cancel.store(true, Ordering::SeqCst);
        };

        let (outcome, ()) = tokio::join!(within_case_budget(budget, case), cancel_after_slow_start);

        assert_eq!(
            outcome.expect("cancellation must beat the 600s budget"),
            "cancelled"
        );
        assert_eq!(*activity.lock().unwrap(), vec!["started", "cancelled"]);
    }

    fn adversarial_case_detail(profile: &str, model: &str) -> String {
        let body = serde_json::json!({
            "error": {
                "message": "read /private/tmp/provider-body.json and /home/alice/.config/contextdesk/config.json",
                "nested": {
                    "Authorization": "Bearer arbitrary-token",
                    "X-API-Key": "another-token",
                    "api_key": "third-token",
                    "profile": profile,
                    "model": model,
                }
            }
        });
        format!(
            "provider returned 401 from https://private.example/v1/chat with fallback \
             http://10.1.2.3:8080/v1; body={body}"
        )
    }

    fn assert_share_safe(serialized: &str, profile: &str, model: &str) {
        for forbidden in [
            "https://",
            "http://",
            "/private/tmp",
            "/home/alice",
            "Authorization",
            "authorization",
            "Bearer",
            "X-API-Key",
            "api_key",
            "arbitrary-token",
            "another-token",
            "third-token",
            "provider-body.json",
            profile,
            model,
        ] {
            assert!(
                !serialized.contains(forbidden),
                "{forbidden:?} leaked in {serialized}"
            );
        }
    }

    fn adversarial_report(profile: &str, model: &str) -> GatewayDiagnosticReport {
        let leaky = adversarial_case_detail(profile, model);
        GatewayDiagnosticReport {
            schema_id: GATEWAY_DIAGNOSTIC_SCHEMA_ID,
            schema_version: GATEWAY_DIAGNOSTIC_SCHEMA_VERSION,
            run_id: format!("run-{profile}-{model}"),
            build: BuildIdentity {
                version: "test",
                long_version: "test",
            },
            started_at_unix_ms: 1,
            finished_at_unix_ms: 2,
            level: "basic",
            profile_pseudonym: profile.to_string(),
            model_pseudonym: model.to_string(),
            role_hint: "investigator",
            endpoint_fingerprint: "https://private.example/v1".to_string(),
            credentials_read: true,
            deadline_secs: 30,
            requests_planned_max: 1,
            requests_made: 1,
            cases: vec![CaseReport {
                case_id: "ordinary_generation",
                description: "exact-marker ordinary generation",
                direct: LaneResult {
                    executed: true,
                    passed: false,
                    detail: leaky.clone(),
                    elapsed_ms: 1,
                    attempts: 1,
                    requests_used: 1,
                },
                product: LaneResult::not_applicable(leaky.clone()),
                scorer: LaneResult::not_applicable(leaky),
                classification: CaseClassification::GatewayOrModelLikely,
            }],
            verdicts: Verdicts {
                gateway_model_compatible: false,
                product_workflow_compatible: true,
                answers_useful: true,
                gateway_model_status: VerdictStatus::Fail,
                product_workflow_status: VerdictStatus::Pass,
                answers_useful_status: VerdictStatus::Pass,
            },
            cleanup: CleanupReport {
                corpora_created: 1,
                corpora_removed: 0,
                sessions_created: 0,
                sessions_removed: 0,
                failures: vec![format!(
                    "cleanup failed at /private/tmp/{profile}/{model}: Authorization: Bearer cleanup-token"
                )],
            },
            cancelled: false,
            deadline_exceeded: false,
            artifact_dir: Some(format!("/private/tmp/{profile}/{model}")),
            private_capture_written: false,
        }
    }

    #[test]
    fn adversarial_nested_provider_error_is_safe_in_case_jsonl_and_report_json() {
        let profile = "private-profile-73";
        let model = "exact-model/customer-9";
        let policy = ShareSafeRedactionPolicy::new([profile, model]);
        let mut report = adversarial_report(profile, model);
        sanitize_gateway_report(&mut report, &policy);

        let case_jsonl = serde_json::to_string(&DiagnoseLine::Case(&report.cases[0])).unwrap();
        let report_json = serde_json::to_string(&report).unwrap();
        assert_share_safe(&case_jsonl, profile, model);
        assert_share_safe(&report_json, profile, model);
        assert!(
            case_jsonl.contains("failure category: authentication"),
            "useful category was lost: {case_jsonl}"
        );
        assert!(
            !report
                .artifact_dir
                .as_deref()
                .unwrap_or_default()
                .starts_with('/'),
            "machine output must use a relative artifact reference: {report_json}"
        );
    }

    #[test]
    fn artifact_writer_reapplies_policy_to_report_and_manifest() {
        let profile = "private-profile-73";
        let model = "exact-model/customer-9";
        let policy = ShareSafeRedactionPolicy::new([profile, model]);
        let report = adversarial_report(profile, model);
        let temp = tempfile::tempdir().unwrap();
        let paths = Paths::resolve(Some(temp.path()), None).unwrap();
        let args = GatewayDiagnoseArgs {
            level: DiagnoseLevel::Basic,
            yes: true,
            timeout: Some(30),
            raw: false,
            raw_i_understand: false,
            out: Some(temp.path().join("artifacts")),
        };

        let dir = write_artifact_bundle(&args, &paths, "safe-run", &report, &policy).unwrap();
        let report_json = std::fs::read_to_string(dir.join("report.json")).unwrap();
        let manifest_json = std::fs::read_to_string(dir.join("manifest.json")).unwrap();
        assert_share_safe(&report_json, profile, model);
        assert_share_safe(&manifest_json, profile, model);
        assert!(
            report_json.contains("failure category: authentication"),
            "useful category was lost: {report_json}"
        );

        let manifest: serde_json::Value = serde_json::from_str(&manifest_json).unwrap();
        let expected = sha256_hex(report_json.as_bytes());
        assert_eq!(
            manifest["files"][0]["sha256"].as_str(),
            Some(expected.as_str())
        );
    }
}
