//! Host-neutral execution seam for Investigation Team qualification.
//!
//! The core contract owns scoring, identity, redaction, and fail-closed
//! validation. This module owns the small amount of orchestration that a
//! desktop or CLI host needs: execute one host-built input, round-trip the
//! redacted export through the core parser, and project an honest lifecycle
//! status without contacting a provider or persisting anything.

use cd_core::error::{CoreError, CoreResult};
use cd_core::investigation_team_qualification::{
    parse_report, qualify, render_json, render_markdown, AttemptStatus, QualificationInput,
    QualificationReport,
};
use serde::{Deserialize, Serialize};

/// Stable host-facing status for one qualification result.
///
/// The ordering is deliberate: stale evidence is never presented as current;
/// incomplete attempts are never presented as a clean qualification; and an
/// axis failure is never hidden behind a successful model response.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QualificationStatus {
    /// Every scored axis is contract-compliant and every attempt completed.
    Qualified,
    /// At least one scored axis is not contract-compliant.
    Failed,
    /// At least one attempt is incomplete, failed, cancelled, or timed out.
    Partial,
    /// The pipeline fingerprint explicitly says its suite evidence is stale.
    Stale,
}

impl QualificationStatus {
    /// Stable wire label for UI, CLI, and exported metadata.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Qualified => "qualified",
            Self::Failed => "failed",
            Self::Partial => "partial",
            Self::Stale => "stale",
        }
    }
}

/// One validated, redacted qualification execution result.
///
/// The JSON and Markdown fields are produced by the core redaction gates, not
/// by a second serializer in the host. `report` remains available for typed
/// desktop projections and exact fingerprint comparisons.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QualificationExecutionResult {
    /// Typed, fail-closed report.
    pub report: QualificationReport,
    /// Redacted JSON suitable for share-safe storage or export.
    pub redacted_json: String,
    /// Redacted Markdown suitable for a human-readable report.
    pub redacted_markdown: String,
    /// Honest lifecycle/status projection.
    pub status: QualificationStatus,
}

impl QualificationExecutionResult {
    /// Return the exact pipeline fingerprint digest bound to this result.
    pub fn fingerprint_digest(&self) -> &str {
        &self.report.fingerprint.digest
    }

    /// Whether any attempt remains incomplete or terminally unsuccessful.
    pub fn has_incomplete_attempt(&self) -> bool {
        self.report
            .attempt_scores
            .iter()
            .any(|attempt| !matches!(attempt.status, AttemptStatus::Completed))
    }
}

/// Execute one host-built qualification input.
///
/// This function is deliberately synchronous and provider-neutral. A trusted
/// host supplies the input after it has collected the exact role bindings and
/// attempt observations. Provider calls, credentials, persistence, and UI
/// state machines remain outside this seam.
pub fn execute(input: QualificationInput) -> CoreResult<QualificationExecutionResult> {
    let report = qualify(input)?;
    let redacted_json = render_json(&report)?;
    let redacted_markdown = render_markdown(&report)?;

    // Do not expose a report that cannot survive the same parser used for
    // imported/exported results. This also proves the JSON is the redacted
    // contract rather than an incidental serde rendering.
    let reparsed = parse_report(&redacted_json)?;
    if reparsed != report {
        return Err(CoreError::Config(
            "investigation qualification report round-trip mismatch".into(),
        ));
    }

    let status = status_for(&report);
    Ok(QualificationExecutionResult {
        report,
        redacted_json,
        redacted_markdown,
        status,
    })
}

/// Execute a JSON-encoded host input with strict unknown-field handling.
pub fn execute_json(input_json: &str) -> CoreResult<QualificationExecutionResult> {
    let input: QualificationInput = serde_json::from_str(input_json).map_err(|error| {
        CoreError::Config(format!(
            "invalid investigation qualification input: {error}"
        ))
    })?;
    execute(input)
}

/// Recompute the lifecycle status from a validated report. Hosts use this
/// when reopening durable redacted history so a stored status can never be
/// trusted independently of the scored report.
pub fn status_for(report: &QualificationReport) -> QualificationStatus {
    if report.fingerprint.stale {
        return QualificationStatus::Stale;
    }
    if report
        .attempt_scores
        .iter()
        .any(|attempt| !matches!(attempt.status, AttemptStatus::Completed))
    {
        return QualificationStatus::Partial;
    }
    if ![
        &report.axes.capability,
        &report.axes.quality,
        &report.axes.speed,
        &report.axes.resource,
    ]
    .iter()
    .all(|axis| axis.contract_met)
    {
        return QualificationStatus::Failed;
    }
    QualificationStatus::Qualified
}

#[cfg(test)]
mod tests {
    use super::*;
    use cd_core::capability_qualification::fingerprint_endpoint;
    use cd_core::investigation_answer::EvidenceRole;
    use cd_core::investigation_team_qualification::{
        policy_budget_identity, AttemptClaim, AttemptRecord, CitationRecord, EvaluatorTruth,
        InvestigationTeamRole, MemberBinding, ProviderFacingDocument, ProviderFacingInput,
        ToolCallRecord, SCHEMA_ID, SUITE_VERSION,
    };
    use std::collections::{BTreeMap, BTreeSet};

    fn input(stale: bool, status: AttemptStatus) -> QualificationInput {
        let endpoint = "https://qualification.example.test/v1";
        let evidence_id = "evidence-1";
        let source_id = "source-1";
        let time_anchor = "time-1";
        QualificationInput {
            schema_id: SCHEMA_ID.into(),
            current_suite_version: SUITE_VERSION.into(),
            suite_version: if stale {
                "contextdesk.investigation_team_qualification.suite.v0".into()
            } else {
                SUITE_VERSION.into()
            },
            observed_at: 1_777_000_000,
            stale,
            policy_budget_identity: policy_budget_identity(4, 100),
            max_tool_calls: 4,
            resource_budget: 100,
            members: vec![MemberBinding::from_deployment(
                InvestigationTeamRole::Single,
                "profile-1",
                "model-1",
                endpoint,
            )
            .expect("member")],
            provider_facing: ProviderFacingInput {
                question: "Which evidence is required?".into(),
                evidence_packet: vec![ProviderFacingDocument {
                    id: evidence_id.into(),
                    text: "opaque evidence".into(),
                }],
            },
            truth: EvaluatorTruth {
                required_evidence_ids: BTreeSet::from([evidence_id.into()]),
                required_sources: BTreeMap::from([(evidence_id.into(), source_id.into())]),
                required_times: BTreeMap::from([(evidence_id.into(), time_anchor.into())]),
                forbidden_provider_tokens: BTreeSet::new(),
            },
            attempts: vec![AttemptRecord {
                attempt_id: "attempt-1".into(),
                role: InvestigationTeamRole::Single,
                model_id: "model-1".into(),
                profile_id: "profile-1".into(),
                endpoint_fingerprint: fingerprint_endpoint(endpoint),
                status,
                completion_claimed: matches!(status, AttemptStatus::Completed),
                claims: vec![AttemptClaim {
                    text: "evidence supports the answer".into(),
                    evidence_ids: vec![evidence_id.into()],
                }],
                tool_calls: vec![ToolCallRecord {
                    name: "cd_qualify_lookup".into(),
                    evidence_ids: vec![evidence_id.into()],
                }],
                citations: vec![CitationRecord {
                    evidence_id: evidence_id.into(),
                    source_id: source_id.into(),
                    time_anchor: time_anchor.into(),
                    role: EvidenceRole::Supporting,
                }],
                latency_ms: 20,
                resource_units: 8,
            }],
        }
    }

    #[test]
    fn execute_round_trips_redacted_json_and_preserves_fingerprint() {
        let result = execute(input(false, AttemptStatus::Completed)).expect("qualification");
        assert_eq!(result.status, QualificationStatus::Qualified);
        assert_eq!(
            result.report.fingerprint.digest,
            result.fingerprint_digest()
        );
        assert_eq!(
            parse_report(&result.redacted_json).expect("parse"),
            result.report
        );
        assert!(!result.redacted_json.contains("https://"));
        assert!(!result.redacted_markdown.contains("https://"));
    }

    #[test]
    fn stale_evidence_wins_over_a_complete_attempt() {
        let result = execute(input(true, AttemptStatus::Completed)).expect("qualification");
        assert_eq!(result.status, QualificationStatus::Stale);
    }

    #[test]
    fn incomplete_attempts_are_not_presented_as_qualified() {
        let result = execute(input(false, AttemptStatus::Partial)).expect("qualification");
        assert_eq!(result.status, QualificationStatus::Partial);
        assert!(result.has_incomplete_attempt());
    }

    #[test]
    fn json_input_rejects_unknown_fields() {
        let mut value = serde_json::to_value(input(false, AttemptStatus::Completed)).expect("json");
        value["unexpected"] = serde_json::json!(true);
        let error = execute_json(&serde_json::to_string(&value).expect("serialize"))
            .expect_err("unknown input field must fail closed");
        assert!(error
            .to_string()
            .contains("invalid investigation qualification input"));
    }
}
