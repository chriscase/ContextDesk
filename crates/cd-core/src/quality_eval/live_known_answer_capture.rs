//! Operator-controlled canonical response evidence for known-answer runs.
//!
//! This artifact is deliberately separate from the redacted score report. It
//! can contain only strict parsed response objects and their deterministic
//! hashes; prompts, evaluator truth, endpoints, credentials, headers, raw
//! transport errors, and rejected response text have no field in the schema.

use super::export::gate_export_text;
use super::live_known_answer::{
    prepare_live_known_answer_suite, validate_live_known_answer_canonical_response,
    validate_provider_controlled_text, validate_provider_model_identity,
    validate_response_prompt_separation, LiveKnownAnswerResponse, PreparedLiveKnownAnswerCase,
};
use super::live_known_answer_run::{
    validate_live_known_answer_quality_unit, LIVE_KNOWN_ANSWER_JS_SAFE_MAX,
};
use super::suite::{hex_sha256, load_embedded_open_v1_suite};
use super::types::{
    AnswerScore, QualityRunRecord, QualityUnit, QUALITY_EVAL_SCHEMA_VERSION, RUN_RECORD_SCHEMA_ID,
};
use crate::error::{CoreError, CoreResult};
use crate::investigation_team_qualification::InvestigationTeamRole;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

/// Canonical capture schema identity.
pub const LIVE_KNOWN_ANSWER_CAPTURE_SCHEMA_ID: &str =
    "contextdesk.investigation_team_known_answer_capture.v1";
/// Bounded parser/export size for one role/model capture.
pub const LIVE_KNOWN_ANSWER_CAPTURE_MAX_BYTES: usize = 1024 * 1024;

/// One strict parsed response prepared for canonical capture construction.
/// The hash is computed by the builder and cannot be supplied by a caller.
#[derive(Debug, Clone)]
pub struct LiveKnownAnswerCanonicalScenarioInput {
    /// Opaque scenario identity.
    pub scenario_id: String,
    /// Provider-reported model identity, separate from configured identity.
    pub reported_model_id: Option<String>,
    /// Strict parsed provider response.
    pub response: LiveKnownAnswerResponse,
    /// Exact canonical host score for an executed response. This remains absent
    /// when strict parsing succeeded but host scoring failed.
    pub answer_score: Option<AnswerScore>,
    /// True only when strict parsing succeeded and the host scorer itself
    /// failed. Exactly one of this marker and `answer_score` must be present.
    pub host_score_failed: bool,
}

/// One canonical, privacy-gated response retained for regression analysis.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LiveKnownAnswerCanonicalScenario {
    /// Opaque scenario identity.
    pub scenario_id: String,
    /// Provider-reported model identity, absent when unknown.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reported_model_id: Option<String>,
    /// Strict parsed response. Rejected raw response text is never retained.
    pub canonical_response: LiveKnownAnswerResponse,
    /// SHA-256 of compact canonical response JSON.
    pub canonical_response_sha256: String,
    /// SHA-256 of the exact canonical redacted score paired with this response.
    /// Absent only for a parsed response whose host scoring failed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answer_score_sha256: Option<String>,
    /// Closed eligibility marker for a parsed response whose host score failed.
    /// It is false for every response bound to an answer-score digest.
    pub host_score_failed: bool,
}

/// Canonical response evidence for one exact configured role/model run.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LiveKnownAnswerCanonicalCapture {
    /// Capture schema identity.
    pub schema_id: String,
    /// Positive host-owned observation timestamp shared with the score report.
    pub observed_at: i64,
    /// Exact Investigation Team role.
    pub role: InvestigationTeamRole,
    /// Exact configured quality identity. Provider-reported identity remains
    /// separately recorded on each response and never rewrites this value.
    pub quality_unit: QualityUnit,
    /// Strict responses only, in manifest order. Failed/rejected scenarios are
    /// represented solely by bounded codes and byte counts in the score report.
    pub scenarios: Vec<LiveKnownAnswerCanonicalScenario>,
}

/// Build a canonical capture after strict parsing/privacy/vocabulary gates.
pub fn build_live_known_answer_capture(
    observed_at: i64,
    role: InvestigationTeamRole,
    quality_unit: QualityUnit,
    inputs: Vec<LiveKnownAnswerCanonicalScenarioInput>,
) -> CoreResult<LiveKnownAnswerCanonicalCapture> {
    let prepared = canonical_prepared_cases()?;
    let mut scenarios = Vec::with_capacity(inputs.len());
    for input in inputs {
        if input.answer_score.is_some() == input.host_score_failed {
            return Err(capture_error(
                "capture score eligibility must be exactly scored or host-score-failed",
            ));
        }
        validate_live_known_answer_canonical_response(&input.response, &input.scenario_id)
            .map_err(|failure| capture_error(failure.as_code()))?;
        validate_capture_prompt_separation(&prepared, &input.scenario_id, &input.response)?;
        if let Some(reported_model_id) = &input.reported_model_id {
            validate_provider_model_identity(reported_model_id)
                .map_err(|failure| capture_error(failure.as_code()))?;
        }
        let canonical = canonical_response_json(&input.response)?;
        reject_non_capture_safe_text(&canonical)?;
        scenarios.push(LiveKnownAnswerCanonicalScenario {
            scenario_id: input.scenario_id,
            reported_model_id: input.reported_model_id,
            canonical_response: input.response,
            canonical_response_sha256: hex_sha256(canonical.as_bytes()),
            answer_score_sha256: input
                .answer_score
                .as_ref()
                .map(live_known_answer_answer_score_sha256)
                .transpose()?,
            host_score_failed: input.host_score_failed,
        });
    }
    let capture = LiveKnownAnswerCanonicalCapture {
        schema_id: LIVE_KNOWN_ANSWER_CAPTURE_SCHEMA_ID.into(),
        observed_at,
        role,
        quality_unit,
        scenarios,
    };
    validate_live_known_answer_capture(&capture)?;
    Ok(capture)
}

/// Validate identity, ordering, canonical hashes, and privacy boundaries.
pub fn validate_live_known_answer_capture(
    capture: &LiveKnownAnswerCanonicalCapture,
) -> CoreResult<()> {
    let prepared = canonical_prepared_cases()?;
    if capture.schema_id != LIVE_KNOWN_ANSWER_CAPTURE_SCHEMA_ID
        || capture.observed_at <= 0
        || capture.observed_at as u64 > LIVE_KNOWN_ANSWER_JS_SAFE_MAX
    {
        return Err(capture_error("capture identity is invalid"));
    }
    let identity_record = QualityRunRecord {
        schema_id: RUN_RECORD_SCHEMA_ID.into(),
        schema_version: QUALITY_EVAL_SCHEMA_VERSION.into(),
        suite_id: capture.quality_unit.suite_id.clone(),
        suite_digest: capture.quality_unit.suite_digest.clone(),
        quality_unit: capture.quality_unit.clone(),
        status: super::types::LaneStatus::Failed,
        cases: Vec::new(),
        judge: super::types::JudgeMetadata::default(),
        evidence_classes: super::types::EvidenceClassMarkers {
            compatibility_untouched: true,
            retrieval_quality: false,
            answer_quality: true,
            orchestration_quality: false,
            live_optional: true,
        },
    };
    validate_live_known_answer_quality_unit(&identity_record)?;
    if capture.scenarios.len() > super::live_known_answer_run::LIVE_KNOWN_ANSWER_REQUIRED_SCENARIOS
    {
        return Err(capture_error("capture has too many scenarios"));
    }
    let mut seen = BTreeSet::new();
    let mut prior = 0usize;
    for scenario in &capture.scenarios {
        let ordinal = scenario_ordinal(&scenario.scenario_id)
            .ok_or_else(|| capture_error("capture scenario identity is invalid"))?;
        if ordinal <= prior || !seen.insert(scenario.scenario_id.as_str()) {
            return Err(capture_error("capture scenarios are not in manifest order"));
        }
        prior = ordinal;
        if scenario
            .reported_model_id
            .as_deref()
            .is_some_and(|value| !is_safe_identity(value))
        {
            return Err(capture_error("reported model identity is invalid"));
        }
        if let Some(reported_model_id) = &scenario.reported_model_id {
            validate_provider_model_identity(reported_model_id)
                .map_err(|failure| capture_error(failure.as_code()))?;
        }
        validate_live_known_answer_canonical_response(
            &scenario.canonical_response,
            &scenario.scenario_id,
        )
        .map_err(|failure| capture_error(failure.as_code()))?;
        validate_capture_prompt_separation(
            &prepared,
            &scenario.scenario_id,
            &scenario.canonical_response,
        )?;
        for value in canonical_response_values(&scenario.canonical_response) {
            validate_provider_controlled_text(value)
                .map_err(|failure| capture_error(failure.as_code()))?;
        }
        let canonical = canonical_response_json(&scenario.canonical_response)?;
        reject_non_capture_safe_text(&canonical)?;
        if scenario.canonical_response_sha256 != hex_sha256(canonical.as_bytes()) {
            return Err(capture_error("canonical response hash mismatch"));
        }
        if scenario
            .answer_score_sha256
            .as_deref()
            .is_some_and(|digest| !is_sha256(digest))
        {
            return Err(capture_error("canonical answer score hash is invalid"));
        }
        if scenario.answer_score_sha256.is_some() == scenario.host_score_failed {
            return Err(capture_error(
                "capture score eligibility is internally inconsistent",
            ));
        }
    }
    let body = serde_json::to_string(capture)?;
    if body.len() > LIVE_KNOWN_ANSWER_CAPTURE_MAX_BYTES {
        return Err(capture_error("capture exceeds the byte limit"));
    }
    reject_non_capture_safe_text(&body)
}

fn canonical_prepared_cases() -> CoreResult<Vec<PreparedLiveKnownAnswerCase>> {
    let suite = load_embedded_open_v1_suite()?;
    prepare_live_known_answer_suite(&suite)
}

fn validate_capture_prompt_separation(
    prepared: &[PreparedLiveKnownAnswerCase],
    scenario_id: &str,
    response: &LiveKnownAnswerResponse,
) -> CoreResult<()> {
    let case = prepared
        .iter()
        .find(|case| case.prompt().scenario_id == scenario_id)
        .ok_or_else(|| capture_error("capture scenario identity is invalid"))?;
    validate_response_prompt_separation(response, case.prompt())
        .map_err(|failure| capture_error(failure.as_code()))
}

/// SHA-256 of compact canonical `AnswerScore` JSON. The score remains in the
/// redacted report; only this digest is copied into the private capture.
pub fn live_known_answer_answer_score_sha256(answer: &AnswerScore) -> CoreResult<String> {
    Ok(hex_sha256(serde_json::to_string(answer)?.as_bytes()))
}

/// SHA-256 of the complete compact canonical capture JSON. This binds a
/// private capture to its redacted report, but is not a signature.
pub fn live_known_answer_capture_sha256(
    capture: &LiveKnownAnswerCanonicalCapture,
) -> CoreResult<String> {
    validate_live_known_answer_capture(capture)?;
    Ok(hex_sha256(serde_json::to_string(capture)?.as_bytes()))
}

/// Render canonical pretty JSON for private operator-controlled storage.
pub fn render_live_known_answer_capture_json(
    capture: &LiveKnownAnswerCanonicalCapture,
) -> CoreResult<String> {
    validate_live_known_answer_capture(capture)?;
    let body = serde_json::to_string_pretty(capture)?;
    reject_non_capture_safe_text(&body)?;
    Ok(body)
}

/// Parse a canonical capture and reject unknown or non-canonical fields.
pub fn parse_live_known_answer_capture_json(
    raw: &str,
) -> CoreResult<LiveKnownAnswerCanonicalCapture> {
    if raw.len() > LIVE_KNOWN_ANSWER_CAPTURE_MAX_BYTES {
        return Err(capture_error("capture exceeds the byte limit"));
    }
    reject_non_capture_safe_text(raw)?;
    let original: serde_json::Value = serde_json::from_str(raw)?;
    let capture: LiveKnownAnswerCanonicalCapture = serde_json::from_value(original.clone())?;
    validate_live_known_answer_capture(&capture)?;
    if serde_json::to_value(&capture)? != original {
        return Err(capture_error(
            "capture is non-canonical or has unknown fields",
        ));
    }
    Ok(capture)
}

fn canonical_response_json(response: &LiveKnownAnswerResponse) -> CoreResult<String> {
    serde_json::to_string(response).map_err(CoreError::from)
}

fn canonical_response_values(response: &LiveKnownAnswerResponse) -> Vec<&str> {
    [
        response.schema_id.as_str(),
        response.scenario_id.as_str(),
        response.conclusion.as_str(),
        response.confidence.as_str(),
    ]
    .into_iter()
    .chain(response.claims.iter().flat_map(|claim| {
        std::iter::once(claim.text.as_str())
            .chain(claim.role.iter().map(String::as_str))
            .chain(claim.citations.iter().flat_map(|citation| {
                [
                    citation.evidence_id.as_str(),
                    citation.source_id.as_str(),
                    citation.time_anchor.as_str(),
                ]
            }))
    }))
    .collect()
}

fn reject_non_capture_safe_text(text: &str) -> CoreResult<()> {
    gate_export_text(text)?;
    let normalized = text.to_ascii_lowercase();
    const FORBIDDEN: &[&str] = &[
        "http://",
        "https://",
        "file://",
        "ftp://",
        "ssh://",
        "ws://",
        "wss://",
        "ldap://",
        "ldaps://",
        "postgres://",
        "postgresql://",
        "authorization:",
        "x-api-key",
        "api_key",
        "must_include",
        "must_exclude",
        "evaluator_only",
        "evaluator_truth",
        "answer_key",
        "response_contract",
        "treat the user json as the complete evidence packet",
    ];
    if FORBIDDEN.iter().any(|token| normalized.contains(token)) {
        return Err(CoreError::Policy(
            "known-answer capture contains forbidden prompt, truth, endpoint, header, or credential material"
                .into(),
        ));
    }
    Ok(())
}

fn scenario_ordinal(value: &str) -> Option<usize> {
    let ordinal = value.strip_prefix("scenario-")?.parse::<usize>().ok()?;
    (1..=super::live_known_answer_run::LIVE_KNOWN_ANSWER_REQUIRED_SCENARIOS)
        .contains(&ordinal)
        .then_some(ordinal)
}

fn is_safe_identity(value: &str) -> bool {
    !value.trim().is_empty()
        && value.len() <= 256
        && value
            .chars()
            .all(|character| !character.is_control() && character != '`')
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn capture_error(detail: &str) -> CoreError {
    CoreError::Config(format!("live known-answer capture: {detail}"))
}
