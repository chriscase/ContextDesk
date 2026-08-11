//! Share-safe telemetry for one fast-triage route run.
//!
//! Every field here is a host label, a host identifier, a count, or a digest.
//! The types have no field able to hold a prompt, an evidence excerpt, a
//! rejected proposal, a reasoning body, an endpoint, a credential, a username,
//! or a filesystem path — so a leak would require adding a field, not merely
//! forgetting to redact one. Reasoning is represented by presence and length
//! only, which is the whole reason
//! [`super::terminal::FastTriageTerminal`] refuses to hand its text to anyone.
//!
//! The same values drive the host activity stream, so an operator sees the same
//! account of the run that telemetry records — one truth, two projections.

use serde::{Deserialize, Serialize};

use super::packet::{FastTriagePacketV1, FastTriageRoleEvidence};
use super::selection::{
    FastTriageRoleBinding, FastTriageRouteRejection, FastTriageWorkflowContract,
};
use super::terminal::FastTriageTerminalState;
use super::validate::FastTriageFailureCategory;

/// Stable schema id for [`FastTriageTelemetryV1`].
pub const FAST_TRIAGE_TELEMETRY_SCHEMA_V1: &str = "contextdesk.fast_triage.telemetry.v1";

/// Which bounded stage one provider attempt belonged to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FastTriageStage {
    /// The first synthesis attempt against the selected fast model.
    Primary,
    /// The single bounded, category-specific correction.
    Correction,
    /// The one visible escalation to an explicitly configured fallback model.
    Escalation,
}

impl FastTriageStage {
    /// Stable wire label.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Primary => "primary",
            Self::Correction => "correction",
            Self::Escalation => "escalation",
        }
    }
}

/// How one provider attempt ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FastTriageAttemptOutcome {
    /// The host validated the proposal into a typed envelope.
    Accepted,
    /// The proposal failed host validation.
    Rejected,
    /// The provider failed (rate limit / server / transport exhausted).
    ProviderFailed,
    /// The attempt exceeded the route deadline.
    Deadline,
    /// The turn was cancelled during the attempt.
    Cancelled,
}

impl FastTriageAttemptOutcome {
    /// Stable wire label.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Accepted => "accepted",
            Self::Rejected => "rejected",
            Self::ProviderFailed => "provider_failed",
            Self::Deadline => "deadline",
            Self::Cancelled => "cancelled",
        }
    }
}

/// One provider attempt, described in host facts only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FastTriageAttemptTelemetry {
    /// Which bounded stage this attempt belonged to.
    pub stage: FastTriageStage,
    /// Provider profile id used for this attempt.
    pub profile_id: String,
    /// Exact model id used for this attempt.
    pub model_id: String,
    /// Typed terminal classification, absent when no terminal was observed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_state: Option<FastTriageTerminalState>,
    /// Whether the provider emitted a reasoning channel.
    pub reasoning_present: bool,
    /// Length of the reasoning channel. The text itself is never retained.
    pub reasoning_chars: usize,
    /// Visible answer length (reasoning excluded).
    pub visible_chars: usize,
    /// Tool calls the model requested on a route that offers none.
    pub tool_calls: usize,
    /// How the attempt ended.
    pub outcome: FastTriageAttemptOutcome,
    /// Ordered host validation categories for this attempt.
    pub categories: Vec<FastTriageFailureCategory>,
}

/// State of the one visible escalation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FastTriageEscalationState {
    /// The fast answer was accepted; nothing to escalate.
    NotRequested,
    /// Escalation was needed but no fallback model is configured.
    NotConfigured,
    /// A fallback model is configured but was not explicitly authorized.
    NotAuthorized,
    /// Escalation was needed and the host packet was handed back unchanged for
    /// a caller to act on.
    Requested,
    /// The escalation ran and its answer passed host validation.
    Succeeded,
    /// The escalation ran and its answer did not pass host validation.
    Failed,
    /// The escalation could not run because the host packet no longer held.
    PacketIdentityChanged,
}

impl FastTriageEscalationState {
    /// Stable wire label.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NotRequested => "not_requested",
            Self::NotConfigured => "not_configured",
            Self::NotAuthorized => "not_authorized",
            Self::Requested => "requested",
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::PacketIdentityChanged => "packet_identity_changed",
        }
    }
}

/// The escalation account, including the exact packet identity that crossed it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FastTriageEscalationTelemetry {
    /// What happened to the escalation.
    pub state: FastTriageEscalationState,
    /// Configured fallback profile id, when one is configured.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_id: Option<String>,
    /// Configured fallback model id, when one is configured.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    /// The packet identity actually sent to the fallback. Equal to the route's
    /// `packet_id` exactly when the unchanged host packet was escalated.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub packet_id: Option<String>,
}

impl FastTriageEscalationTelemetry {
    /// The escalation account for a run that never needed one.
    pub fn not_requested() -> Self {
        Self {
            state: FastTriageEscalationState::NotRequested,
            profile_id: None,
            model_id: None,
            packet_id: None,
        }
    }
}

/// Final route outcome, as one stable label.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FastTriageOutcomeLabel {
    /// Exact persisted evidence did not authorize this route.
    NotSelected,
    /// The fast model's first proposal passed host validation.
    VerifiedFastAnswer,
    /// The fast model's proposal passed after the one bounded correction.
    VerifiedAfterCorrection,
    /// The escalated proposal passed host validation.
    VerifiedAfterEscalation,
    /// No proposal passed; the host reports an honest partial result.
    PartialInconclusive,
    /// No proposal passed and the unchanged host packet is handed back.
    EscalationRequested,
    /// The turn was cancelled.
    Cancelled,
    /// The route hit its deadline.
    Deadline,
    /// A provider call failed.
    ProviderFailed,
}

impl FastTriageOutcomeLabel {
    /// Stable wire label.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NotSelected => "not_selected",
            Self::VerifiedFastAnswer => "verified_fast_answer",
            Self::VerifiedAfterCorrection => "verified_after_correction",
            Self::VerifiedAfterEscalation => "verified_after_escalation",
            Self::PartialInconclusive => "partial_inconclusive",
            Self::EscalationRequested => "escalation_requested",
            Self::Cancelled => "cancelled",
            Self::Deadline => "deadline",
            Self::ProviderFailed => "provider_failed",
        }
    }

    /// Whether this outcome delivered a host-validated typed answer.
    pub fn is_verified(self) -> bool {
        matches!(
            self,
            Self::VerifiedFastAnswer | Self::VerifiedAfterCorrection | Self::VerifiedAfterEscalation
        )
    }
}

/// Host-owned packet facts a reader needs to interpret the run, with no
/// evidence text and no binding/digest of the corpus itself.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FastTriagePacketTelemetry {
    /// The exact packet identity this run used.
    pub packet_id: String,
    /// Candidate groups in the packet (excluding the chronology scope).
    pub candidate_count: usize,
    /// Permitted evidence rows in the packet.
    pub evidence_row_count: usize,
    /// Rows in the separately scoped chronology.
    pub independent_row_count: usize,
    /// Whether the host actually holds role evidence for this packet.
    pub role_evidence: FastTriageRoleEvidence,
    /// Whether the host chronology in this packet is complete.
    pub timeline_complete: bool,
}

impl FastTriagePacketTelemetry {
    /// Project one packet's host facts.
    pub fn from_packet(packet: &FastTriagePacketV1) -> Self {
        Self {
            packet_id: packet.packet_id().to_string(),
            candidate_count: packet.candidate_ids().len(),
            evidence_row_count: packet.rows().len(),
            independent_row_count: packet
                .rows()
                .iter()
                .filter(|row| row.scope == super::packet::FastTriageEvidenceScope::Independent)
                .count(),
            role_evidence: packet.role_evidence(),
            timeline_complete: packet.timeline_complete(),
        }
    }
}

/// Whole-run fast-triage telemetry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FastTriageTelemetryV1 {
    /// Stable schema id for DTOs.
    pub schema: String,
    /// Whether exact persisted evidence authorized the route.
    pub route_selected: bool,
    /// Why the route was not selected, when it was not.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selection_rejection: Option<FastTriageRouteRejection>,
    /// The workflow contract this run was scoped to.
    pub workflow_contract: FastTriageWorkflowContract,
    /// The exact host contract fingerprint this build ran.
    pub contract_fingerprint: String,
    /// The selected route's host identities, when selected.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<FastTriageRoleBinding>,
    /// Host packet facts, when a packet was built.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub packet: Option<FastTriagePacketTelemetry>,
    /// Every provider attempt, in order.
    pub attempts: Vec<FastTriageAttemptTelemetry>,
    /// Total logical provider attempts sent across the run.
    pub provider_attempts: u32,
    /// Whether the one bounded correction was consumed.
    pub correction_used: bool,
    /// The exact category the correction addressed, when one was consumed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub correction_category: Option<FastTriageFailureCategory>,
    /// Ordered host validation categories from the final rejected attempt.
    pub validation_categories: Vec<FastTriageFailureCategory>,
    /// The escalation account.
    pub escalation: FastTriageEscalationTelemetry,
    /// Whole-route wall-clock ceiling in ms (`0` = none).
    pub deadline_ms: u64,
    /// Final route outcome.
    pub outcome: FastTriageOutcomeLabel,
}

impl FastTriageTelemetryV1 {
    /// One host-authored activity/diagnostic detail line for this run.
    ///
    /// Deliberately built from the same struct rather than from a second,
    /// drifting formatter: what an operator reads is what telemetry recorded.
    pub fn activity_detail(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| {
            serde_json::json!({
                "schema": FAST_TRIAGE_TELEMETRY_SCHEMA_V1,
                "outcome": self.outcome.as_str(),
            })
            .to_string()
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn telemetry() -> FastTriageTelemetryV1 {
        FastTriageTelemetryV1 {
            schema: FAST_TRIAGE_TELEMETRY_SCHEMA_V1.into(),
            route_selected: true,
            selection_rejection: None,
            workflow_contract: FastTriageWorkflowContract::HostGroundedSynthesisCompletePacket,
            contract_fingerprint: "f".repeat(64),
            role: Some(FastTriageRoleBinding {
                profile_id: "profile-a".into(),
                model_id: "model-a".into(),
            }),
            packet: None,
            attempts: vec![FastTriageAttemptTelemetry {
                stage: FastTriageStage::Primary,
                profile_id: "profile-a".into(),
                model_id: "model-a".into(),
                terminal_state: Some(FastTriageTerminalState::TypedObject),
                reasoning_present: true,
                reasoning_chars: 812,
                visible_chars: 240,
                tool_calls: 0,
                outcome: FastTriageAttemptOutcome::Accepted,
                categories: Vec::new(),
            }],
            provider_attempts: 1,
            correction_used: false,
            correction_category: None,
            validation_categories: Vec::new(),
            escalation: FastTriageEscalationTelemetry::not_requested(),
            deadline_ms: 180_000,
            outcome: FastTriageOutcomeLabel::VerifiedFastAnswer,
        }
    }

    #[test]
    fn telemetry_round_trips_and_uses_stable_snake_case_labels() {
        let value = telemetry();
        let json = serde_json::to_string(&value).expect("serialize");
        assert_eq!(
            serde_json::from_str::<FastTriageTelemetryV1>(&json).expect("deserialize"),
            value
        );
        assert!(json.contains("\"outcome\":\"verified_fast_answer\""));
        assert!(json.contains("\"stage\":\"primary\""));
        assert!(json.contains("\"state\":\"not_requested\""));
        assert_eq!(value.activity_detail(), json);
    }

    #[test]
    fn the_reasoning_channel_is_represented_only_by_presence_and_length() {
        let json = serde_json::to_string(&telemetry()).expect("serialize");
        assert!(json.contains("\"reasoning_present\":true"));
        assert!(json.contains("\"reasoning_chars\":812"));
        // There is no field able to carry the text itself.
        let fields = serde_json::from_str::<serde_json::Value>(&json).expect("json");
        let attempt = &fields["attempts"][0];
        assert!(attempt.get("reasoning").is_none());
        assert!(attempt.get("visible").is_none());
        assert!(attempt.get("proposal").is_none());
    }

    #[test]
    fn every_label_is_non_empty_and_distinct_within_its_enum() {
        let outcomes = [
            FastTriageOutcomeLabel::NotSelected,
            FastTriageOutcomeLabel::VerifiedFastAnswer,
            FastTriageOutcomeLabel::VerifiedAfterCorrection,
            FastTriageOutcomeLabel::VerifiedAfterEscalation,
            FastTriageOutcomeLabel::PartialInconclusive,
            FastTriageOutcomeLabel::EscalationRequested,
            FastTriageOutcomeLabel::Cancelled,
            FastTriageOutcomeLabel::Deadline,
            FastTriageOutcomeLabel::ProviderFailed,
        ]
        .map(FastTriageOutcomeLabel::as_str);
        assert_eq!(
            outcomes.iter().collect::<std::collections::BTreeSet<_>>().len(),
            outcomes.len()
        );
        assert!(FastTriageOutcomeLabel::VerifiedAfterEscalation.is_verified());
        assert!(!FastTriageOutcomeLabel::PartialInconclusive.is_verified());
        assert!(!FastTriageOutcomeLabel::EscalationRequested.is_verified());

        let states = [
            FastTriageEscalationState::NotRequested,
            FastTriageEscalationState::NotConfigured,
            FastTriageEscalationState::NotAuthorized,
            FastTriageEscalationState::Requested,
            FastTriageEscalationState::Succeeded,
            FastTriageEscalationState::Failed,
            FastTriageEscalationState::PacketIdentityChanged,
        ]
        .map(FastTriageEscalationState::as_str);
        assert_eq!(
            states.iter().collect::<std::collections::BTreeSet<_>>().len(),
            states.len()
        );
        assert_eq!(FastTriageStage::Correction.as_str(), "correction");
        assert_eq!(
            FastTriageAttemptOutcome::ProviderFailed.as_str(),
            "provider_failed"
        );
    }
}
