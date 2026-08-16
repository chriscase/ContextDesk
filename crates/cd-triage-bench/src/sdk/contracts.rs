//! Published public-SDK schema ids and the bench-owned recorded-outcome envelope.
//!
//! Schema id strings are pinned to the #872/#826 contracts. Types here are the
//! subset the bench needs to record a run; they are not a copy of the
//! production compiler or host.

use crate::canonical::to_canonical_json;
use crate::error::{BenchError, BenchResult};
use crate::privacy::gate_share_safe_text;
use crate::types::{sha256_hex, validate_bounded_string, validate_id, Observed};
use serde::{Deserialize, Serialize};

/// Published request contract.
pub const TRIAGE_REQUEST_SCHEMA_V2: &str = "contextdesk.triage.request.v2";
/// Published ordered event contract.
pub const TRIAGE_RUN_EVENT_SCHEMA_V2: &str = "contextdesk.triage.run_event.v2";
/// Published owner-only result contract.
pub const TRIAGE_RESULT_SCHEMA_V2: &str = "contextdesk.triage.result.v2";
/// Published share-safe result contract.
pub const TRIAGE_SHARE_SAFE_RESULT_SCHEMA_V2: &str = "contextdesk.triage.result_share_safe.v2";
/// Published cancellation contract.
pub const TRIAGE_CANCELLATION_SCHEMA_V1: &str = "contextdesk.triage.cancellation.v1";
/// Published replay contract.
pub const TRIAGE_REPLAY_SCHEMA_V1: &str = "contextdesk.triage.replay.v1";
/// Bench envelope that embeds the share-safe result plus exact fingerprints.
pub const SDK_RECORDED_OUTCOME_SCHEMA_V1: &str = "contextdesk.triage_bench.sdk_recorded_outcome.v1";

/// Deterministic mock gateway profile. Not a live provider identity.
pub const MOCK_GATEWAY_PROFILE: &str = "profile:mock-gateway";
/// Deterministic mock catalog model id.
pub const MOCK_MODEL_ID: &str = "mock-finalizer-v1";
/// Single compiled slot used by the mock Standard policy.
pub const MOCK_FINALIZER_SLOT: &str = "slot-finalizer";

/// Exact gateway-scoped model identity (`cd_core::model_ref::ModelRef`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelRef {
    pub profile_id: String,
    pub model_id: String,
}

impl ModelRef {
    pub fn mock() -> Self {
        Self {
            profile_id: MOCK_GATEWAY_PROFILE.into(),
            model_id: MOCK_MODEL_ID.into(),
        }
    }

    pub fn validate(&self) -> BenchResult<()> {
        validate_id("model.profile_id", &self.profile_id)?;
        validate_bounded_string("model.model_id", &self.model_id, 512)?;
        if self.model_id.trim().is_empty()
            || self.model_id.contains('\\')
            || self.model_id.contains("://")
            || self.model_id.chars().any(char::is_control)
        {
            return Err(BenchError::Schema("invalid ModelRef.model_id".into()));
        }
        Ok(())
    }
}

/// Public policy selection. The mock path only needs Standard + ModelRef.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum SdkPolicySelection {
    Standard { model: ModelRef },
}

impl SdkPolicySelection {
    pub fn mock_standard() -> Self {
        Self::Standard {
            model: ModelRef::mock(),
        }
    }

    pub fn model(&self) -> &ModelRef {
        match self {
            Self::Standard { model } => model,
        }
    }

    pub fn fingerprint(&self) -> BenchResult<String> {
        let hex = sha256_hex(to_canonical_json(self)?.as_bytes());
        Ok(format!("policy-{hex}"))
    }
}

/// Typed terminal recorded from the public SDK seam.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SdkTerminal {
    Completed,
    Failed,
    Partial,
    TimedOut,
    Cancelled,
}

impl SdkTerminal {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Partial => "partial",
            Self::TimedOut => "timed_out",
            Self::Cancelled => "cancelled",
        }
    }
}

/// Published share-safe result subset (no answer envelope).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SdkShareSafeResult {
    pub schema_id: String,
    pub run_id: String,
    pub kind: String,
    pub validation_state: String,
    pub packet_id: String,
    pub reconciliation: SdkReconciliation,
    #[serde(default)]
    pub accepted_evidence_ids: Vec<String>,
    #[serde(default)]
    pub reason_codes: Vec<String>,
}

impl SdkShareSafeResult {
    pub fn validate(&self) -> BenchResult<()> {
        if self.schema_id != TRIAGE_SHARE_SAFE_RESULT_SCHEMA_V2 {
            return Err(BenchError::Schema(format!(
                "expected {TRIAGE_SHARE_SAFE_RESULT_SCHEMA_V2}, got {}",
                self.schema_id
            )));
        }
        validate_id("share_safe_result.run_id", &self.run_id)?;
        validate_id("share_safe_result.packet_id", &self.packet_id)?;
        self.reconciliation.validate()?;
        for id in &self.accepted_evidence_ids {
            validate_id("accepted_evidence_id", id)?;
        }
        for code in &self.reason_codes {
            validate_id("reason_code", code)?;
        }
        let encoded = serde_json::to_string(self).map_err(BenchError::from_serde)?;
        gate_share_safe_text(&encoded)
    }
}

/// Published reconciliation counts (identity/accounting only).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SdkReconciliation {
    pub state: String,
    pub configured_role_slots: u32,
    pub completed_role_slots: u32,
    pub distinct_models: u32,
    pub distinct_gateways: u32,
    #[serde(default)]
    pub supported_claim_ids: Vec<String>,
    #[serde(default)]
    pub conflict_ids: Vec<String>,
    #[serde(default)]
    pub gap_ids: Vec<String>,
    pub root_cause_established: bool,
}

impl SdkReconciliation {
    pub fn validate(&self) -> BenchResult<()> {
        validate_id("reconciliation.state", &self.state)?;
        if self.completed_role_slots > self.configured_role_slots
            || self.distinct_models > self.completed_role_slots
            || self.distinct_gateways > self.distinct_models
        {
            return Err(BenchError::Schema(
                "invalid share-safe reconciliation counts".into(),
            ));
        }
        Ok(())
    }
}

/// One compiled role slot and its terminal disposition.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SdkSlotRecord {
    pub slot_id: String,
    pub role: String,
    pub disposition: String,
    pub fingerprint: String,
    pub model: ModelRef,
}

impl SdkSlotRecord {
    pub fn validate(&self) -> BenchResult<()> {
        validate_id("slot_id", &self.slot_id)?;
        validate_id("slot.role", &self.role)?;
        validate_id("slot.disposition", &self.disposition)?;
        validate_id("slot.fingerprint", &self.fingerprint)?;
        self.model.validate()
    }
}

/// Ordered replay of published event kinds (exactly one terminal).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SdkReplay {
    pub schema_id: String,
    pub run_id: String,
    pub request_fingerprint: String,
    pub events: Vec<SdkRunEvent>,
}

impl SdkReplay {
    pub fn validate(&self) -> BenchResult<()> {
        if self.schema_id != TRIAGE_REPLAY_SCHEMA_V1 {
            return Err(BenchError::Schema(format!(
                "expected {TRIAGE_REPLAY_SCHEMA_V1}, got {}",
                self.schema_id
            )));
        }
        validate_id("replay.run_id", &self.run_id)?;
        validate_id("replay.request_fingerprint", &self.request_fingerprint)?;
        if self.events.is_empty() {
            return Err(BenchError::Schema("replay has no events".into()));
        }
        if self.events[0].event.kind() != "run_started" {
            return Err(BenchError::Schema(
                "replay must begin with run_started".into(),
            ));
        }
        let mut terminals = 0usize;
        for (idx, event) in self.events.iter().enumerate() {
            event.validate()?;
            if event.run_id != self.run_id {
                return Err(BenchError::Integrity(
                    "replay event run_id does not match envelope".into(),
                ));
            }
            if event.sequence != idx as u64 {
                return Err(BenchError::Schema(
                    "replay event sequence is not contiguous from zero".into(),
                ));
            }
            if event.event.is_terminal() {
                terminals += 1;
            } else if terminals > 0 {
                return Err(BenchError::Schema(
                    "replay contains an event after its terminal".into(),
                ));
            }
        }
        if terminals != 1 {
            return Err(BenchError::Schema(format!(
                "replay has {terminals} terminal events; expected exactly one"
            )));
        }
        match &self.events[0].event {
            SdkEventPayload::RunStarted {
                request_fingerprint,
                ..
            } if request_fingerprint == &self.request_fingerprint => Ok(()),
            SdkEventPayload::RunStarted { .. } => Err(BenchError::Integrity(
                "replay request fingerprint does not match run_started".into(),
            )),
            _ => Ok(()),
        }
    }
}

/// One published run event.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SdkRunEvent {
    pub schema_id: String,
    pub run_id: String,
    pub sequence: u64,
    pub privacy: String,
    pub event: SdkEventPayload,
}

impl SdkRunEvent {
    pub fn validate(&self) -> BenchResult<()> {
        if self.schema_id != TRIAGE_RUN_EVENT_SCHEMA_V2 {
            return Err(BenchError::Schema(format!(
                "expected {TRIAGE_RUN_EVENT_SCHEMA_V2}, got {}",
                self.schema_id
            )));
        }
        validate_id("event.run_id", &self.run_id)?;
        if self.privacy != "owner_only" && self.privacy != "share_safe" {
            return Err(BenchError::Schema("event privacy is unknown".into()));
        }
        Ok(())
    }
}

/// Published event payload kinds used by the mock engine.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum SdkEventPayload {
    RunStarted {
        request_fingerprint: String,
        policy_fingerprint: String,
    },
    PacketReady {
        packet_id: String,
        packet_digest: String,
        evidence_count: u32,
    },
    RoleAttempt {
        attempt_id: String,
        role_slot_id: String,
        role: String,
        status: String,
    },
    Reconciliation {
        state: String,
    },
    Validation {
        passed: bool,
        #[serde(default)]
        reason_codes: Vec<String>,
    },
    Completed {
        result_schema_id: String,
    },
    Failed {
        category: String,
    },
    TimedOut {
        category: String,
    },
    Cancelled {
        cancellation_id: String,
    },
}

impl SdkEventPayload {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::RunStarted { .. } => "run_started",
            Self::PacketReady { .. } => "packet_ready",
            Self::RoleAttempt { .. } => "role_attempt",
            Self::Reconciliation { .. } => "reconciliation",
            Self::Validation { .. } => "validation",
            Self::Completed { .. } => "completed",
            Self::Failed { .. } => "failed",
            Self::TimedOut { .. } => "timed_out",
            Self::Cancelled { .. } => "cancelled",
        }
    }

    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            Self::Completed { .. }
                | Self::Failed { .. }
                | Self::TimedOut { .. }
                | Self::Cancelled { .. }
        )
    }
}

/// Durable bench envelope for one ContextDesk SDK attempt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SdkRecordedOutcome {
    pub schema_id: String,
    pub privacy: crate::types::PrivacyClass,
    pub engine: String,
    pub terminal: SdkTerminal,
    pub sdk_run_id: String,
    pub task_id: String,
    pub snapshot_id: String,
    pub packet_id: String,
    pub packet_fingerprint: String,
    pub corpus_fingerprint: String,
    pub policy_fingerprint: String,
    pub request_fingerprint: String,
    pub models: Vec<ModelRef>,
    pub slots: Vec<SdkSlotRecord>,
    pub share_safe_result: SdkShareSafeResult,
    pub replay: SdkReplay,
    pub usage: Observed<String>,
    pub cost: Observed<String>,
}

impl SdkRecordedOutcome {
    pub fn parse_json(text: &str) -> BenchResult<Self> {
        let parsed: Self = serde_json::from_str(text).map_err(BenchError::from_serde)?;
        parsed.validate()?;
        Ok(parsed)
    }

    pub fn validate(&self) -> BenchResult<()> {
        if self.schema_id != SDK_RECORDED_OUTCOME_SCHEMA_V1 {
            return Err(BenchError::Schema(format!(
                "expected {SDK_RECORDED_OUTCOME_SCHEMA_V1}, got {}",
                self.schema_id
            )));
        }
        if self.engine != "mock" {
            return Err(BenchError::Schema(format!(
                "unsupported SDK engine {}",
                self.engine
            )));
        }
        validate_id("sdk_run_id", &self.sdk_run_id)?;
        validate_id("task_id", &self.task_id)?;
        validate_id("snapshot_id", &self.snapshot_id)?;
        validate_id("packet_id", &self.packet_id)?;
        validate_id("packet_fingerprint", &self.packet_fingerprint)?;
        validate_id("corpus_fingerprint", &self.corpus_fingerprint)?;
        validate_id("policy_fingerprint", &self.policy_fingerprint)?;
        validate_id("request_fingerprint", &self.request_fingerprint)?;
        if self.models.is_empty() {
            return Err(BenchError::Schema(
                "recorded ContextDesk run must include at least one ModelRef".into(),
            ));
        }
        for model in &self.models {
            model.validate()?;
        }
        if self.slots.is_empty() {
            return Err(BenchError::Schema(
                "recorded ContextDesk run must include slot fingerprints".into(),
            ));
        }
        for slot in &self.slots {
            slot.validate()?;
        }
        self.share_safe_result.validate()?;
        if self.share_safe_result.run_id != self.sdk_run_id {
            return Err(BenchError::Integrity(
                "share-safe result run_id does not match sdk_run_id".into(),
            ));
        }
        if self.share_safe_result.packet_id != self.packet_id {
            return Err(BenchError::Integrity(
                "share-safe result packet_id does not match packet fingerprint binding".into(),
            ));
        }
        self.replay.validate()?;
        if self.replay.run_id != self.sdk_run_id {
            return Err(BenchError::Integrity(
                "replay run_id does not match sdk_run_id".into(),
            ));
        }
        if self.replay.request_fingerprint != self.request_fingerprint {
            return Err(BenchError::Integrity(
                "replay request fingerprint does not match recorded request".into(),
            ));
        }
        if !self.usage.is_unknown() {
            return Err(BenchError::Schema(
                "mock usage must remain unknown; do not invent token counts".into(),
            ));
        }
        if !self.cost.is_unknown() {
            return Err(BenchError::Schema(
                "mock cost must remain unknown; do not invent spend".into(),
            ));
        }
        if self.privacy == crate::types::PrivacyClass::ShareSafe {
            let encoded = serde_json::to_string(self).map_err(BenchError::from_serde)?;
            gate_share_safe_text(&encoded)?;
        }
        Ok(())
    }

    pub fn to_canonical_bytes(&self) -> BenchResult<Vec<u8>> {
        Ok(to_canonical_json(self)?.into_bytes())
    }
}

pub fn slot_fingerprint(
    slot_id: &str,
    role: &str,
    disposition: &str,
    model: &ModelRef,
) -> BenchResult<String> {
    let body = serde_json::json!({
        "slot_id": slot_id,
        "role": role,
        "disposition": disposition,
        "model": model,
    });
    let hex = sha256_hex(to_canonical_json(&body)?.as_bytes());
    Ok(format!("slot-{hex}"))
}

pub fn request_fingerprint(
    task_id: &str,
    packet_id: &str,
    policy_fingerprint: &str,
    corpus_fingerprint: &str,
) -> BenchResult<String> {
    let body = serde_json::json!({
        "schema_id": TRIAGE_REQUEST_SCHEMA_V2,
        "task_id": task_id,
        "packet_id": packet_id,
        "policy_fingerprint": policy_fingerprint,
        "corpus_fingerprint": corpus_fingerprint,
    });
    let hex = sha256_hex(to_canonical_json(&body)?.as_bytes());
    Ok(format!("request-{hex}"))
}

pub fn sdk_run_id(request_fingerprint: &str, terminal: SdkTerminal) -> String {
    let material = format!("{request_fingerprint}:{}", terminal.as_str());
    format!("sdkrun-{}", sha256_hex(material.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn published_schema_ids_are_exact() {
        assert_eq!(TRIAGE_REQUEST_SCHEMA_V2, "contextdesk.triage.request.v2");
        assert_eq!(
            TRIAGE_SHARE_SAFE_RESULT_SCHEMA_V2,
            "contextdesk.triage.result_share_safe.v2"
        );
        assert_eq!(TRIAGE_REPLAY_SCHEMA_V1, "contextdesk.triage.replay.v1");
    }
}
