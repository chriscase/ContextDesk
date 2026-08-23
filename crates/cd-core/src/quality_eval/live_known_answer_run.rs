//! Durable, redacted run records for provider-backed OPEN-v1 known-answer checks.
//!
//! The provider-facing prompts and host-only truth stay in
//! `live_known_answer`; this module records only exact execution identity,
//! lifecycle, deterministic dimension outcomes, latency, and byte proxies.

use super::export::gate_export_text;
use super::live_known_answer::{LIVE_KNOWN_ANSWER_PACKET_ID, LIVE_KNOWN_ANSWER_RESPONSE_SCHEMA_ID};
use super::suite::hex_sha256;
use super::types::{
    AnswerScore, CaseRunResult, EvidenceClassMarkers, JudgeMetadata, LaneStatus, ModelSubject,
    QualityRunRecord, QualityUnit, TaskMode, QUALITY_EVAL_SCHEMA_VERSION, RUN_RECORD_SCHEMA_ID,
};
use crate::error::{CoreError, CoreResult};
use crate::investigation_team_qualification::InvestigationTeamRole;
use serde::{Deserialize, Serialize};

/// Schema identity for one role/model known-answer report.
pub const LIVE_KNOWN_ANSWER_RUN_SCHEMA_ID: &str =
    "contextdesk.investigation_team_known_answer_run.v1";
/// OPEN-v1 currently contains exactly fourteen required scenarios.
pub const LIVE_KNOWN_ANSWER_REQUIRED_SCENARIOS: usize = 14;
/// Bounded durable/report parser size.
pub const LIVE_KNOWN_ANSWER_RUN_MAX_BYTES: usize = 1024 * 1024;
/// Stable host orchestration policy; the digest is recorded in the quality unit.
pub const LIVE_KNOWN_ANSWER_ORCHESTRATION_POLICY: &str =
    "contextdesk.live_known_answer.serial_per_role.v1";

/// Overall interpretation of one exact role/model suite run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LiveKnownAnswerRunStatus {
    /// Every required scenario executed and passed every deterministic dimension.
    Qualified,
    /// Every required scenario terminated, but one or more did not pass.
    Failed,
    /// Some required scenarios completed while others were blocked or cancelled.
    Partial,
    /// Every required scenario was cancelled before a usable score existed.
    Cancelled,
    /// Every required scenario was blocked before a usable score existed.
    Blocked,
}

impl LiveKnownAnswerRunStatus {
    /// Stable UI/export label.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Qualified => "qualified",
            Self::Failed => "failed",
            Self::Partial => "partial",
            Self::Cancelled => "cancelled",
            Self::Blocked => "blocked",
        }
    }
}

/// Host-observed telemetry for one opaque scenario. Raw prompts and responses
/// are deliberately absent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LiveKnownAnswerScenarioTelemetry {
    /// Opaque manifest-order scenario identity.
    pub scenario_id: String,
    /// Provider-attempt lifecycle before deterministic score projection.
    pub status: LaneStatus,
    /// Host-observed wall-clock latency for this provider call.
    pub latency_ms: u64,
    /// Exact serialized request byte count used as a resource proxy.
    pub input_bytes: u64,
    /// Exact provider response byte count used as a resource proxy.
    pub output_bytes: u64,
    /// Bounded secret-free failure class for non-executed scenarios.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure_code: Option<String>,
}

/// Aggregate measured/resource summary. Tokens and cost remain explicit
/// unknowns because the qualification transport does not currently return
/// provider usage accounting.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LiveKnownAnswerRunMetrics {
    /// Required scenario count for this exact suite.
    pub required_scenarios: u32,
    /// Scenarios that produced a strict parsed deterministic score.
    pub executed_scenarios: u32,
    /// Executed scenarios passing every deterministic dimension.
    pub passed_scenarios: u32,
    /// Scenarios failing quality or provider/response contracts.
    pub failed_scenarios: u32,
    /// Scenarios cancelled before a usable deterministic score.
    pub cancelled_scenarios: u32,
    /// Scenarios blocked before a provider attempt could execute.
    pub blocked_scenarios: u32,
    /// Sum of host-observed provider-call latency.
    pub total_latency_ms: u64,
    /// Sum of exact serialized request bytes.
    pub total_input_bytes: u64,
    /// Sum of exact provider response bytes.
    pub total_output_bytes: u64,
    /// Provider-reported input tokens, absent when transport does not return usage.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<u64>,
    /// Provider-reported output tokens, absent when transport does not return usage.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<u64>,
    /// Provider-reported cost in millionths of a US dollar, absent when unknown.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost_microusd: Option<u64>,
}

/// Redacted durable report for one exact role/profile/model/deployment.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LiveKnownAnswerRunReport {
    /// Report schema identity.
    pub schema_id: String,
    /// Positive host-owned observation timestamp.
    pub observed_at: i64,
    /// Exact Investigation Team role exercised by this report.
    pub role: InvestigationTeamRole,
    /// Overall lifecycle and deterministic-quality interpretation.
    pub status: LiveKnownAnswerRunStatus,
    /// Existing quality-eval identity and redacted per-scenario scores.
    pub quality_run: QualityRunRecord,
    /// Host-observed lifecycle, latency, and byte proxies per opaque scenario.
    pub telemetry: Vec<LiveKnownAnswerScenarioTelemetry>,
    /// Recomputed aggregate quality, speed, and resource metrics.
    pub metrics: LiveKnownAnswerRunMetrics,
}

/// In-memory host observation used to build a report. This type never carries
/// raw provider text and is not serializable.
#[derive(Debug, Clone)]
pub struct LiveKnownAnswerScenarioObservation {
    /// Opaque manifest-order scenario identity.
    pub scenario_id: String,
    /// Provider-attempt lifecycle before score projection.
    pub status: LaneStatus,
    /// Host-only deterministic score when the response executed successfully.
    pub answer: Option<AnswerScore>,
    /// Host-observed call latency.
    pub latency_ms: u64,
    /// Serialized request size.
    pub input_bytes: u64,
    /// Provider response size.
    pub output_bytes: u64,
    /// Bounded secret-free failure class for a non-executed attempt.
    pub failure_code: Option<String>,
}

/// Build the exact gateway/model/suite/prompt quality identity used by a live
/// known-answer run.
pub fn live_known_answer_quality_unit(
    build_identity: impl Into<String>,
    subject: ModelSubject,
    suite_id: impl Into<String>,
    suite_digest: impl Into<String>,
    prompt_set_hash: impl Into<String>,
) -> QualityUnit {
    QualityUnit {
        build_identity: build_identity.into(),
        subject,
        task_mode: TaskMode::TriageInvestigation,
        prompt_set_hash: prompt_set_hash.into(),
        answer_schema_version: LIVE_KNOWN_ANSWER_RESPONSE_SCHEMA_ID.into(),
        suite_id: suite_id.into(),
        suite_digest: suite_digest.into(),
        retrieval_mode: LIVE_KNOWN_ANSWER_PACKET_ID.into(),
        sampling_config: "provider_profile_default_no_override".into(),
        orchestration_policy_fingerprint: hex_sha256(
            LIVE_KNOWN_ANSWER_ORCHESTRATION_POLICY.as_bytes(),
        ),
        quality_eval_schema_version: QUALITY_EVAL_SCHEMA_VERSION.into(),
    }
}

/// Convert host observations into a bounded redacted report. Scenario order is
/// the public opaque manifest order (`scenario-001` through `scenario-014`).
pub fn build_live_known_answer_run(
    observed_at: i64,
    role: InvestigationTeamRole,
    quality_unit: QualityUnit,
    observations: Vec<LiveKnownAnswerScenarioObservation>,
) -> CoreResult<LiveKnownAnswerRunReport> {
    if observed_at <= 0 {
        return Err(run_error("observation timestamp must be positive"));
    }
    if observations.len() != LIVE_KNOWN_ANSWER_REQUIRED_SCENARIOS {
        return Err(run_error(
            "known-answer run must include every required scenario",
        ));
    }

    let mut cases = Vec::with_capacity(observations.len());
    let mut telemetry = Vec::with_capacity(observations.len());
    for (index, observation) in observations.into_iter().enumerate() {
        let expected_id = format!("scenario-{:03}", index + 1);
        if observation.scenario_id != expected_id {
            return Err(run_error(
                "known-answer scenarios must use exact manifest order",
            ));
        }
        validate_failure_code(observation.status, observation.failure_code.as_deref())?;

        let answers = match (observation.status, observation.answer) {
            (LaneStatus::Executed, Some(mut answer)) => {
                answer.candidate_id = format!("live:{expected_id}");
                answer.task_id = expected_id.clone();
                answer.packet_id = LIVE_KNOWN_ANSWER_PACKET_ID.into();
                answer.expected_outcome = None;
                answer.expectation_met = None;
                vec![answer]
            }
            (LaneStatus::Executed, None) => {
                return Err(run_error(
                    "executed scenario is missing a deterministic score",
                ));
            }
            (_, Some(_)) => {
                return Err(run_error("non-executed scenario cannot carry a score"));
            }
            (_, None) => Vec::new(),
        };
        let case_status = if observation.status == LaneStatus::Executed {
            if answers[0].passed {
                LaneStatus::Executed
            } else {
                LaneStatus::Failed
            }
        } else {
            observation.status
        };
        cases.push(CaseRunResult {
            case_id: expected_id.clone(),
            title: format!("Known-answer scenario {}", index + 1),
            status: case_status,
            retrieval: Vec::new(),
            answers,
            isolation_findings: Vec::new(),
        });
        telemetry.push(LiveKnownAnswerScenarioTelemetry {
            scenario_id: expected_id,
            status: observation.status,
            latency_ms: observation.latency_ms,
            input_bytes: observation.input_bytes,
            output_bytes: observation.output_bytes,
            failure_code: observation.failure_code,
        });
    }

    let status = derive_status(&cases, &telemetry);
    let quality_run = QualityRunRecord {
        schema_id: RUN_RECORD_SCHEMA_ID.into(),
        schema_version: QUALITY_EVAL_SCHEMA_VERSION.into(),
        suite_id: quality_unit.suite_id.clone(),
        suite_digest: quality_unit.suite_digest.clone(),
        quality_unit,
        status: match status {
            LiveKnownAnswerRunStatus::Qualified => LaneStatus::Executed,
            LiveKnownAnswerRunStatus::Cancelled => LaneStatus::Cancelled,
            LiveKnownAnswerRunStatus::Blocked => LaneStatus::Blocked,
            LiveKnownAnswerRunStatus::Failed | LiveKnownAnswerRunStatus::Partial => {
                LaneStatus::Failed
            }
        },
        cases,
        judge: JudgeMetadata::default(),
        evidence_classes: EvidenceClassMarkers {
            compatibility_untouched: true,
            retrieval_quality: false,
            answer_quality: true,
            orchestration_quality: false,
            live_optional: true,
        },
    };
    let metrics = derive_metrics(&quality_run.cases, &telemetry);
    let report = LiveKnownAnswerRunReport {
        schema_id: LIVE_KNOWN_ANSWER_RUN_SCHEMA_ID.into(),
        observed_at,
        role,
        status,
        quality_run,
        telemetry,
        metrics,
    };
    validate_live_known_answer_run(&report)?;
    Ok(report)
}

/// Validate a durable report, including recomputed status and aggregate metrics.
pub fn validate_live_known_answer_run(report: &LiveKnownAnswerRunReport) -> CoreResult<()> {
    if report.schema_id != LIVE_KNOWN_ANSWER_RUN_SCHEMA_ID || report.observed_at <= 0 {
        return Err(run_error("known-answer report identity is invalid"));
    }
    validate_quality_unit(&report.quality_run)?;
    if report.quality_run.cases.len() != LIVE_KNOWN_ANSWER_REQUIRED_SCENARIOS
        || report.telemetry.len() != LIVE_KNOWN_ANSWER_REQUIRED_SCENARIOS
    {
        return Err(run_error("known-answer report scenario count is invalid"));
    }
    for (index, (case, telemetry)) in report
        .quality_run
        .cases
        .iter()
        .zip(&report.telemetry)
        .enumerate()
    {
        let expected_id = format!("scenario-{:03}", index + 1);
        if case.case_id != expected_id
            || case.title != format!("Known-answer scenario {}", index + 1)
            || telemetry.scenario_id != expected_id
            || !case.retrieval.is_empty()
            || !case.isolation_findings.is_empty()
        {
            return Err(run_error(
                "known-answer report scenario identity is invalid",
            ));
        }
        validate_failure_code(telemetry.status, telemetry.failure_code.as_deref())?;
        match telemetry.status {
            LaneStatus::Executed => {
                if case.answers.len() != 1
                    || case.answers[0].candidate_id != format!("live:{expected_id}")
                    || case.answers[0].task_id != expected_id
                    || case.answers[0].packet_id != LIVE_KNOWN_ANSWER_PACKET_ID
                    || case.answers[0].status != LaneStatus::Executed
                    || case.answers[0].expected_outcome.is_some()
                    || case.answers[0].expectation_met.is_some()
                    || case.status
                        != if case.answers[0].passed {
                            LaneStatus::Executed
                        } else {
                            LaneStatus::Failed
                        }
                {
                    return Err(run_error("executed known-answer score is inconsistent"));
                }
            }
            status => {
                if !case.answers.is_empty() || case.status != status {
                    return Err(run_error("non-executed known-answer score is inconsistent"));
                }
            }
        }
    }
    let status = derive_status(&report.quality_run.cases, &report.telemetry);
    let metrics = derive_metrics(&report.quality_run.cases, &report.telemetry);
    if report.status != status
        || report.metrics != metrics
        || report.quality_run.status
            != match status {
                LiveKnownAnswerRunStatus::Qualified => LaneStatus::Executed,
                LiveKnownAnswerRunStatus::Cancelled => LaneStatus::Cancelled,
                LiveKnownAnswerRunStatus::Blocked => LaneStatus::Blocked,
                LiveKnownAnswerRunStatus::Failed | LiveKnownAnswerRunStatus::Partial => {
                    LaneStatus::Failed
                }
            }
    {
        return Err(run_error("known-answer report aggregates are inconsistent"));
    }
    gate_export_text(&serde_json::to_string(report)?)?;
    Ok(())
}

/// Canonical redacted JSON export.
pub fn render_live_known_answer_json(report: &LiveKnownAnswerRunReport) -> CoreResult<String> {
    validate_live_known_answer_run(report)?;
    let body = serde_json::to_string_pretty(report)?;
    gate_export_text(&body)?;
    Ok(body)
}

/// Parse a canonical report and reject unknown fields by JSON-value round trip.
pub fn parse_live_known_answer_json(raw: &str) -> CoreResult<LiveKnownAnswerRunReport> {
    if raw.len() > LIVE_KNOWN_ANSWER_RUN_MAX_BYTES {
        return Err(run_error("known-answer report exceeds the byte limit"));
    }
    gate_export_text(raw)?;
    let original: serde_json::Value = serde_json::from_str(raw)?;
    let report: LiveKnownAnswerRunReport = serde_json::from_value(original.clone())?;
    validate_live_known_answer_run(&report)?;
    if serde_json::to_value(&report)? != original {
        return Err(run_error(
            "known-answer report is non-canonical or has unknown fields",
        ));
    }
    Ok(report)
}

/// Redacted Markdown export for operator review.
pub fn render_live_known_answer_markdown(report: &LiveKnownAnswerRunReport) -> CoreResult<String> {
    validate_live_known_answer_run(report)?;
    let unit = &report.quality_run.quality_unit;
    let mut body = String::new();
    body.push_str("# Investigation Team known-answer qualification\n\n");
    body.push_str(&format!("- Status: `{}`\n", report.status.as_str()));
    body.push_str(&format!("- Role: `{}`\n", report.role.as_str()));
    body.push_str(&format!("- Observed at: `{}`\n", report.observed_at));
    body.push_str(&format!("- Build: `{}`\n", unit.build_identity));
    body.push_str(&format!(
        "- Profile: `{}`\n",
        unit.subject.gateway_profile_id
    ));
    body.push_str(&format!("- Model: `{}`\n", unit.subject.model_id));
    body.push_str(&format!(
        "- Endpoint fingerprint: `{}`\n",
        unit.subject.endpoint_fingerprint
    ));
    body.push_str(&format!(
        "- Suite: `{}` / `{}`\n",
        unit.suite_id, unit.suite_digest
    ));
    body.push_str(&format!("- Prompt set: `{}`\n\n", unit.prompt_set_hash));
    body.push_str("## Measured summary\n\n");
    body.push_str(&format!(
        "- Passed: {}/{}\n- Executed: {}\n- Failed: {}\n- Cancelled: {}\n- Blocked: {}\n- Total latency: {} ms\n- Input/output bytes: {}/{}\n- Tokens: unknown\n- Cost: unknown\n\n",
        report.metrics.passed_scenarios,
        report.metrics.required_scenarios,
        report.metrics.executed_scenarios,
        report.metrics.failed_scenarios,
        report.metrics.cancelled_scenarios,
        report.metrics.blocked_scenarios,
        report.metrics.total_latency_ms,
        report.metrics.total_input_bytes,
        report.metrics.total_output_bytes,
    ));
    body.push_str("## Scenario outcomes\n\n");
    for (case, telemetry) in report.quality_run.cases.iter().zip(&report.telemetry) {
        let passed = case.answers.first().is_some_and(|answer| answer.passed);
        body.push_str(&format!(
            "- `{}`: `{}`{} ({} ms)",
            case.case_id,
            case.status.as_str(),
            if passed { ", passed" } else { "" },
            telemetry.latency_ms,
        ));
        if let Some(code) = &telemetry.failure_code {
            body.push_str(&format!(" — `{code}`"));
        }
        body.push('\n');
    }
    body.push_str("\nThis report contains deterministic host scores and redacted execution metadata only. It does not contain prompts, provider responses, evaluator truth, credentials, token counts, cost, or a universal model recommendation.\n");
    gate_export_text(&body)?;
    Ok(body)
}

fn validate_quality_unit(record: &QualityRunRecord) -> CoreResult<()> {
    let unit = &record.quality_unit;
    if record.schema_id != RUN_RECORD_SCHEMA_ID
        || record.schema_version != QUALITY_EVAL_SCHEMA_VERSION
        || record.suite_id != unit.suite_id
        || record.suite_digest != unit.suite_digest
        || unit.task_mode != TaskMode::TriageInvestigation
        || unit.answer_schema_version != LIVE_KNOWN_ANSWER_RESPONSE_SCHEMA_ID
        || unit.retrieval_mode != LIVE_KNOWN_ANSWER_PACKET_ID
        || unit.sampling_config != "provider_profile_default_no_override"
        || unit.orchestration_policy_fingerprint
            != hex_sha256(LIVE_KNOWN_ANSWER_ORCHESTRATION_POLICY.as_bytes())
        || unit.quality_eval_schema_version != QUALITY_EVAL_SCHEMA_VERSION
        || !is_safe_identity(&unit.build_identity, 512)
        || !is_safe_identity(&unit.subject.gateway_profile_id, 256)
        || !is_safe_identity(&unit.subject.model_id, 256)
        || !is_safe_identity(&unit.suite_id, 128)
        || !is_sha256(&unit.subject.endpoint_fingerprint)
        || !is_sha256(&unit.suite_digest)
        || !is_sha256(&unit.prompt_set_hash)
        || record.judge.status != LaneStatus::NotScheduled
        || !record.evidence_classes.compatibility_untouched
        || record.evidence_classes.retrieval_quality
        || !record.evidence_classes.answer_quality
        || record.evidence_classes.orchestration_quality
        || !record.evidence_classes.live_optional
    {
        return Err(run_error("known-answer quality unit is invalid"));
    }
    Ok(())
}

fn validate_failure_code(status: LaneStatus, code: Option<&str>) -> CoreResult<()> {
    let code_is_safe = code.is_some_and(|value| {
        !value.is_empty()
            && value.len() <= 64
            && value
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
    });
    if (status == LaneStatus::Executed && code.is_some())
        || (status != LaneStatus::Executed && !code_is_safe)
    {
        return Err(run_error("known-answer failure code is invalid"));
    }
    Ok(())
}

fn derive_status(
    cases: &[CaseRunResult],
    telemetry: &[LiveKnownAnswerScenarioTelemetry],
) -> LiveKnownAnswerRunStatus {
    let qualified = cases.iter().all(|case| {
        case.status == LaneStatus::Executed && case.answers.len() == 1 && case.answers[0].passed
    });
    if qualified {
        return LiveKnownAnswerRunStatus::Qualified;
    }
    let all_cancelled = telemetry
        .iter()
        .all(|row| row.status == LaneStatus::Cancelled);
    if all_cancelled {
        return LiveKnownAnswerRunStatus::Cancelled;
    }
    let all_blocked = telemetry
        .iter()
        .all(|row| row.status == LaneStatus::Blocked);
    if all_blocked {
        return LiveKnownAnswerRunStatus::Blocked;
    }
    if telemetry.iter().any(|row| {
        matches!(
            row.status,
            LaneStatus::Cancelled | LaneStatus::Blocked | LaneStatus::NotScheduled
        )
    }) {
        LiveKnownAnswerRunStatus::Partial
    } else {
        LiveKnownAnswerRunStatus::Failed
    }
}

fn derive_metrics(
    cases: &[CaseRunResult],
    telemetry: &[LiveKnownAnswerScenarioTelemetry],
) -> LiveKnownAnswerRunMetrics {
    LiveKnownAnswerRunMetrics {
        required_scenarios: telemetry.len() as u32,
        executed_scenarios: telemetry
            .iter()
            .filter(|row| row.status == LaneStatus::Executed)
            .count() as u32,
        passed_scenarios: cases
            .iter()
            .filter(|case| case.answers.first().is_some_and(|answer| answer.passed))
            .count() as u32,
        failed_scenarios: cases
            .iter()
            .filter(|case| case.status == LaneStatus::Failed)
            .count() as u32,
        cancelled_scenarios: telemetry
            .iter()
            .filter(|row| row.status == LaneStatus::Cancelled)
            .count() as u32,
        blocked_scenarios: telemetry
            .iter()
            .filter(|row| row.status == LaneStatus::Blocked)
            .count() as u32,
        total_latency_ms: telemetry.iter().map(|row| row.latency_ms).sum(),
        total_input_bytes: telemetry.iter().map(|row| row.input_bytes).sum(),
        total_output_bytes: telemetry.iter().map(|row| row.output_bytes).sum(),
        input_tokens: None,
        output_tokens: None,
        cost_microusd: None,
    }
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn is_safe_identity(value: &str, max_bytes: usize) -> bool {
    !value.trim().is_empty()
        && value.len() <= max_bytes
        && value
            .chars()
            .all(|character| !character.is_control() && character != '`')
}

fn run_error(detail: &str) -> CoreError {
    CoreError::Config(format!("live known-answer run: {detail}"))
}
