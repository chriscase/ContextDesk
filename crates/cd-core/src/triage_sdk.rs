//! Versioned host-neutral wire contracts for the public triage SDK boundary.
//!
//! These DTOs are deliberately additive. They do not execute a turn and do
//! not depend on application configuration, a GUI runtime, a credential
//! store, or a filesystem. CLI JSONL, Tauri IPC, HTTP/SSE, and deterministic
//! mock adapters can serialize the same ordered event stream.

#![allow(missing_docs)] // Public fields are the external wire schema.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

use crate::extension_contract::{scan_share_safe_text, PacketPrivacyBoundary};
use crate::investigation_answer::AnswerEnvelopeV1;
pub use crate::model_ref::ModelRef;
use crate::multi_model::triage_policy::{TriageSlotKindV2, TRIAGE_POLICY_SCHEMA_V2};

pub const TRIAGE_REQUEST_SCHEMA_V2: &str = "contextdesk.triage.request.v2";
pub const TRIAGE_RUN_EVENT_SCHEMA_V2: &str = "contextdesk.triage.run_event.v2";
pub const TRIAGE_RESULT_SCHEMA_V2: &str = "contextdesk.triage.result.v2";
pub const TRIAGE_SHARE_SAFE_RESULT_SCHEMA_V2: &str = "contextdesk.triage.result_share_safe.v2";
pub const TRIAGE_CANCELLATION_SCHEMA_V1: &str = "contextdesk.triage.cancellation.v1";
pub const TRIAGE_REPLAY_SCHEMA_V1: &str = "contextdesk.triage.replay.v1";

/// Public SDK bounds. These cap untrusted transport payloads; they are not
/// recommended model/context defaults.
pub const MAX_TRIAGE_WIRE_BYTES: usize = 4 * 1024 * 1024;
/// Maximum UTF-8 bytes accepted for a triage task.
pub const MAX_TRIAGE_TASK_BYTES: usize = 64 * 1024;
/// Maximum serialized bytes accepted for an inline policy document.
pub const MAX_TRIAGE_INLINE_POLICY_BYTES: usize = 1024 * 1024;
/// Maximum source identities accepted in one request scope.
pub const MAX_TRIAGE_SOURCE_IDS: usize = 256;
/// Maximum reason codes accepted in one bounded contract field.
pub const MAX_TRIAGE_REASON_CODES: usize = 64;
/// Maximum evidence or claim identities accepted in one bounded contract field.
pub const MAX_TRIAGE_EVIDENCE_IDS: usize = 4096;
/// Maximum events accepted in one deterministic replay.
pub const MAX_TRIAGE_REPLAY_EVENTS: usize = 4096;
/// Maximum per-request whole-turn deadline in milliseconds.
pub const MAX_TRIAGE_REQUEST_DEADLINE_MS: u64 = 3_600_000;
/// Maximum provider calls accepted in a per-request override.
pub const MAX_TRIAGE_REQUEST_PROVIDER_CALLS: u32 = 64;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TriageScopeV1 {
    pub corpus_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub corpus_revision: Option<u64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub source_ids: Vec<String>,
}

impl TriageScopeV1 {
    pub fn validate(&self) -> Result<(), TriageContractError> {
        validate_opaque_id("corpus_id", &self.corpus_id)?;
        if self.corpus_revision == Some(0) {
            return Err(TriageContractError::InvalidField("corpus_revision"));
        }
        validate_unique_ids_bounded("source_ids", &self.source_ids, MAX_TRIAGE_SOURCE_IDS)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum TriagePolicySelectionV2 {
    Standard {
        model: ModelRef,
    },
    Saved {
        policy_id: String,
        policy_revision: u64,
    },
    Inline {
        schema_id: String,
        document: Value,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TriageRequestOverridesV1 {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deadline_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_provider_calls: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TriageRequestV2 {
    pub schema_id: String,
    pub run_id: String,
    /// Requests contain task text and may contain an inline policy, so they
    /// are always owner-only even when their eventual report is share-safe.
    pub privacy: PacketPrivacyBoundary,
    pub task: String,
    pub scope: TriageScopeV1,
    pub policy: TriagePolicySelectionV2,
    #[serde(default)]
    pub overrides: TriageRequestOverridesV1,
    pub cancellation_id: String,
}

impl TriageRequestV2 {
    pub fn validate(&self) -> Result<(), TriageContractError> {
        expect_schema(&self.schema_id, TRIAGE_REQUEST_SCHEMA_V2)?;
        if self.privacy != PacketPrivacyBoundary::OwnerOnly {
            return Err(TriageContractError::PrivacyLeak);
        }
        validate_opaque_id("run_id", &self.run_id)?;
        self.scope.validate()?;
        validate_opaque_id("cancellation_id", &self.cancellation_id)?;
        if self.task.trim().is_empty()
            || self.task.len() > MAX_TRIAGE_TASK_BYTES
            || self.task.contains('\0')
        {
            return Err(TriageContractError::InvalidField("task"));
        }
        match &self.policy {
            TriagePolicySelectionV2::Standard { model } => model
                .validate()
                .map_err(|_| TriageContractError::InvalidField("model"))?,
            TriagePolicySelectionV2::Saved {
                policy_id,
                policy_revision,
            } => {
                validate_opaque_id("policy_id", policy_id)?;
                if *policy_revision == 0 {
                    return Err(TriageContractError::InvalidField("policy_revision"));
                }
            }
            TriagePolicySelectionV2::Inline {
                schema_id,
                document,
            } => {
                let document_schema = document.get("schema_id").and_then(Value::as_str);
                let document_bytes = serde_json::to_vec(document)
                    .map_err(|_| TriageContractError::Serialize)?
                    .len();
                if schema_id != TRIAGE_POLICY_SCHEMA_V2
                    || document_schema != Some(TRIAGE_POLICY_SCHEMA_V2)
                    || !document.is_object()
                    || document_bytes > MAX_TRIAGE_INLINE_POLICY_BYTES
                {
                    return Err(TriageContractError::InvalidField("inline_policy"));
                }
            }
        }
        if self
            .overrides
            .deadline_ms
            .is_some_and(|value| value == 0 || value > MAX_TRIAGE_REQUEST_DEADLINE_MS)
            || self
                .overrides
                .max_provider_calls
                .is_some_and(|value| value == 0 || value > MAX_TRIAGE_REQUEST_PROVIDER_CALLS)
        {
            return Err(TriageContractError::InvalidField("overrides"));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TriageAttemptStatus {
    Completed,
    Abstained,
    Invalid,
    Unavailable,
    TimedOut,
    Cancelled,
    Failed,
    NotAdmitted,
}

/// Terminal accounting for one role slot. This is intentionally separate
/// from the run-level terminal event: a replay can contain a completed run
/// with optional role dropouts, or a failed run with several already-terminal
/// attempts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TriageTerminalDispositionV1 {
    Completed,
    Abstained,
    Invalid,
    Unavailable,
    TimedOut,
    Cancelled,
    Failed,
    NotAdmitted,
}

/// Compatibility alias for callers that use the attempt-qualified name.
pub type TriageAttemptTerminalDispositionV1 = TriageTerminalDispositionV1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TriageRoleAttemptV1 {
    pub attempt_id: String,
    pub role_slot_id: String,
    pub role: TriageSlotKindV2,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<ModelRef>,
    pub status: TriageAttemptStatus,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub reason_codes: Vec<String>,
    pub elapsed_ms: u64,
    pub input_chars: u64,
    pub output_chars: u64,
    /// Physical provider operations attributed to this role. Transport
    /// retries count here even when they produce one semantic correction.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub physical_provider_calls: Option<u32>,
    /// Content-bearing semantic corrections, kept distinct from transport
    /// retries and physical provider operations.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub semantic_corrections: Option<u32>,
    /// Explicit per-role terminal disposition. Missing is a legacy/unknown
    /// value and never implies success.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_disposition: Option<TriageTerminalDispositionV1>,
}

impl TriageRoleAttemptV1 {
    pub fn validate(&self) -> Result<(), TriageContractError> {
        validate_opaque_id("attempt_id", &self.attempt_id)?;
        validate_opaque_id("role_slot_id", &self.role_slot_id)?;
        if let Some(model) = &self.model {
            model
                .validate()
                .map_err(|_| TriageContractError::InvalidField("model"))?;
        }
        validate_unique_reason_codes(&self.reason_codes)?;
        if self
            .physical_provider_calls
            .is_some_and(|calls| calls > MAX_TRIAGE_REQUEST_PROVIDER_CALLS)
        {
            return Err(TriageContractError::InvalidField("physical_provider_calls"));
        }
        if let (Some(calls), Some(corrections)) =
            (self.physical_provider_calls, self.semantic_corrections)
        {
            if corrections > calls {
                return Err(TriageContractError::InvalidField("semantic_corrections"));
            }
        }
        if self.status == TriageAttemptStatus::NotAdmitted
            && (self.physical_provider_calls.is_some_and(|calls| calls > 0)
                || self
                    .semantic_corrections
                    .is_some_and(|corrections| corrections > 0))
        {
            return Err(TriageContractError::InvalidField("not_admitted_accounting"));
        }
        if let Some(disposition) = self.terminal_disposition {
            if disposition != terminal_disposition_for_status(self.status) {
                return Err(TriageContractError::InvalidField("terminal_disposition"));
            }
        }
        Ok(())
    }
}

fn terminal_disposition_for_status(status: TriageAttemptStatus) -> TriageTerminalDispositionV1 {
    match status {
        TriageAttemptStatus::Completed => TriageTerminalDispositionV1::Completed,
        TriageAttemptStatus::Abstained => TriageTerminalDispositionV1::Abstained,
        TriageAttemptStatus::Invalid => TriageTerminalDispositionV1::Invalid,
        TriageAttemptStatus::Unavailable => TriageTerminalDispositionV1::Unavailable,
        TriageAttemptStatus::TimedOut => TriageTerminalDispositionV1::TimedOut,
        TriageAttemptStatus::Cancelled => TriageTerminalDispositionV1::Cancelled,
        TriageAttemptStatus::Failed => TriageTerminalDispositionV1::Failed,
        TriageAttemptStatus::NotAdmitted => TriageTerminalDispositionV1::NotAdmitted,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TriageReconciliationV1 {
    pub state: String,
    pub configured_role_slots: u32,
    pub completed_role_slots: u32,
    pub distinct_models: u32,
    pub distinct_gateways: u32,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub supported_claim_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub conflict_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub gap_ids: Vec<String>,
    pub root_cause_established: bool,
}

impl TriageReconciliationV1 {
    pub fn validate(&self) -> Result<(), TriageContractError> {
        validate_opaque_id("reconciliation_state", &self.state)?;
        if self.completed_role_slots > self.configured_role_slots
            || self.distinct_models > self.completed_role_slots
            || self.distinct_gateways > self.distinct_models
        {
            return Err(TriageContractError::InvalidField("reconciliation_counts"));
        }
        validate_unique_ids_bounded(
            "supported_claim_ids",
            &self.supported_claim_ids,
            MAX_TRIAGE_EVIDENCE_IDS,
        )?;
        validate_unique_ids_bounded("conflict_ids", &self.conflict_ids, MAX_TRIAGE_EVIDENCE_IDS)?;
        validate_unique_ids_bounded("gap_ids", &self.gap_ids, MAX_TRIAGE_EVIDENCE_IDS)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TriageResultKind {
    GroundedFinal,
    HonestPartial,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TriageValidationState {
    Passed,
    Partial,
    Failed,
}

/// Authoritative terminal result. An answer envelope is owner-only by nature;
/// share-safe exports use [`ShareSafeTriageResultV2`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TriageResultV2 {
    pub schema_id: String,
    pub run_id: String,
    pub kind: TriageResultKind,
    pub validation_state: TriageValidationState,
    pub packet_id: String,
    pub reconciliation: TriageReconciliationV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answer: Option<AnswerEnvelopeV1>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub accepted_evidence_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub reason_codes: Vec<String>,
}

impl TriageResultV2 {
    pub fn validate(&self) -> Result<(), TriageContractError> {
        expect_schema(&self.schema_id, TRIAGE_RESULT_SCHEMA_V2)?;
        validate_opaque_id("run_id", &self.run_id)?;
        validate_opaque_id("packet_id", &self.packet_id)?;
        self.reconciliation.validate()?;
        validate_unique_ids_bounded(
            "accepted_evidence_ids",
            &self.accepted_evidence_ids,
            MAX_TRIAGE_EVIDENCE_IDS,
        )?;
        validate_unique_reason_codes(&self.reason_codes)?;
        if self.reconciliation.root_cause_established && self.answer.is_none() {
            return Err(TriageContractError::InvalidField("answer"));
        }
        match self.kind {
            TriageResultKind::GroundedFinal
                if self.answer.is_none()
                    || self.validation_state != TriageValidationState::Passed =>
            {
                Err(TriageContractError::InvalidField("answer"))
            }
            TriageResultKind::HonestPartial
                if self.validation_state == TriageValidationState::Passed
                    || self.reconciliation.root_cause_established =>
            {
                Err(TriageContractError::InvalidField("partial_validation"))
            }
            _ => {
                if let Some(answer) = &self.answer {
                    let known = answer
                        .evidence
                        .iter()
                        .map(|row| row.evidence_id.as_str())
                        .collect::<BTreeSet<_>>();
                    if self
                        .accepted_evidence_ids
                        .iter()
                        .any(|id| !known.contains(id.as_str()))
                    {
                        return Err(TriageContractError::InvalidField("accepted_evidence_ids"));
                    }
                    if self.kind == TriageResultKind::HonestPartial
                        && answer.answer.root_cause_established
                    {
                        return Err(TriageContractError::InvalidField("partial_root_cause"));
                    }
                }
                let encoded =
                    serde_json::to_vec(self).map_err(|_| TriageContractError::Serialize)?;
                if encoded.len() > MAX_TRIAGE_WIRE_BYTES {
                    Err(TriageContractError::PayloadTooLarge)
                } else {
                    Ok(())
                }
            }
        }
    }

    pub fn share_safe_summary(&self) -> ShareSafeTriageResultV2 {
        ShareSafeTriageResultV2 {
            schema_id: TRIAGE_SHARE_SAFE_RESULT_SCHEMA_V2.to_string(),
            run_id: self.run_id.clone(),
            kind: self.kind,
            validation_state: self.validation_state,
            packet_id: self.packet_id.clone(),
            reconciliation: self.reconciliation.clone(),
            accepted_evidence_ids: self.accepted_evidence_ids.clone(),
            reason_codes: self.reason_codes.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ShareSafeTriageResultV2 {
    pub schema_id: String,
    pub run_id: String,
    pub kind: TriageResultKind,
    pub validation_state: TriageValidationState,
    pub packet_id: String,
    pub reconciliation: TriageReconciliationV1,
    pub accepted_evidence_ids: Vec<String>,
    pub reason_codes: Vec<String>,
}

impl ShareSafeTriageResultV2 {
    pub fn validate(&self) -> Result<(), TriageContractError> {
        expect_schema(&self.schema_id, TRIAGE_SHARE_SAFE_RESULT_SCHEMA_V2)?;
        validate_opaque_id("run_id", &self.run_id)?;
        validate_opaque_id("packet_id", &self.packet_id)?;
        self.reconciliation.validate()?;
        validate_unique_ids_bounded(
            "accepted_evidence_ids",
            &self.accepted_evidence_ids,
            MAX_TRIAGE_EVIDENCE_IDS,
        )?;
        validate_unique_reason_codes(&self.reason_codes)?;
        let encoded = serde_json::to_string(self).map_err(|_| TriageContractError::Serialize)?;
        if scan_share_safe_text(&encoded).is_empty() {
            Ok(())
        } else {
            Err(TriageContractError::PrivacyLeak)
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum TriageRunEventPayloadV2 {
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
        attempt: TriageRoleAttemptV1,
    },
    Reconciliation {
        summary: TriageReconciliationV1,
    },
    /// Contributor-only reconciliation. This event is emitted before a
    /// conditional reviewer/challenger can be admitted.
    PreliminaryReconciliation {
        summary: TriageReconciliationV1,
    },
    /// Reconciliation after the optional reviewer/challenger phase and before
    /// a finalizer can draft an answer.
    FinalReconciliation {
        summary: TriageReconciliationV1,
    },
    Validation {
        passed: bool,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        reason_codes: Vec<String>,
    },
    /// Host-bounded semantic correction checkpoint. The mock seam records
    /// whether a correction backend was available without carrying model
    /// text or provider details.
    Correction {
        applied: bool,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        reason_codes: Vec<String>,
    },
    Completed {
        result: Box<TriageResultV2>,
    },
    Failed {
        category: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        partial_result: Option<Box<TriageResultV2>>,
    },
    TimedOut {
        category: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        partial_result: Option<Box<TriageResultV2>>,
    },
    Cancelled {
        cancellation_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        partial_result: Option<Box<TriageResultV2>>,
    },
}

impl TriageRunEventPayloadV2 {
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TriageRunEventV2 {
    pub schema_id: String,
    pub run_id: String,
    pub sequence: u64,
    pub privacy: PacketPrivacyBoundary,
    pub event: TriageRunEventPayloadV2,
}

impl TriageRunEventV2 {
    pub fn validate(&self) -> Result<(), TriageContractError> {
        expect_schema(&self.schema_id, TRIAGE_RUN_EVENT_SCHEMA_V2)?;
        validate_opaque_id("run_id", &self.run_id)?;
        match &self.event {
            TriageRunEventPayloadV2::RunStarted {
                request_fingerprint,
                policy_fingerprint,
            } => {
                validate_opaque_id("request_fingerprint", request_fingerprint)?;
                validate_opaque_id("policy_fingerprint", policy_fingerprint)?;
            }
            TriageRunEventPayloadV2::PacketReady {
                packet_id,
                packet_digest,
                ..
            } => {
                validate_opaque_id("packet_id", packet_id)?;
                validate_opaque_id("packet_digest", packet_digest)?;
            }
            TriageRunEventPayloadV2::RoleAttempt { attempt } => attempt.validate()?,
            TriageRunEventPayloadV2::Reconciliation { summary }
            | TriageRunEventPayloadV2::PreliminaryReconciliation { summary }
            | TriageRunEventPayloadV2::FinalReconciliation { summary } => summary.validate()?,
            TriageRunEventPayloadV2::Validation { reason_codes, .. } => {
                validate_unique_reason_codes(reason_codes)?;
            }
            TriageRunEventPayloadV2::Correction { reason_codes, .. } => {
                validate_unique_reason_codes(reason_codes)?;
            }
            TriageRunEventPayloadV2::Failed {
                category,
                partial_result,
            }
            | TriageRunEventPayloadV2::TimedOut {
                category,
                partial_result,
            } => {
                validate_opaque_id("failure_category", category)?;
                validate_terminal_partial(&self.run_id, partial_result.as_deref())?;
            }
            TriageRunEventPayloadV2::Cancelled {
                cancellation_id,
                partial_result,
            } => {
                validate_opaque_id("cancellation_id", cancellation_id)?;
                validate_terminal_partial(&self.run_id, partial_result.as_deref())?;
            }
            TriageRunEventPayloadV2::Completed { .. } => {}
        }
        if let TriageRunEventPayloadV2::Completed { result } = &self.event {
            result.validate()?;
            if result.run_id != self.run_id {
                return Err(TriageContractError::RunIdentityMismatch);
            }
        }
        if self.privacy == PacketPrivacyBoundary::ShareSafe {
            if matches!(self.event, TriageRunEventPayloadV2::Completed { .. }) {
                return Err(TriageContractError::PrivacyLeak);
            }
            if matches!(
                self.event,
                TriageRunEventPayloadV2::Failed {
                    partial_result: Some(_),
                    ..
                } | TriageRunEventPayloadV2::TimedOut {
                    partial_result: Some(_),
                    ..
                } | TriageRunEventPayloadV2::Cancelled {
                    partial_result: Some(_),
                    ..
                }
            ) {
                return Err(TriageContractError::PrivacyLeak);
            }
            if matches!(
                self.event,
                TriageRunEventPayloadV2::RoleAttempt {
                    attempt: TriageRoleAttemptV1 { model: Some(_), .. }
                }
            ) {
                return Err(TriageContractError::PrivacyLeak);
            }
            let encoded =
                serde_json::to_string(self).map_err(|_| TriageContractError::Serialize)?;
            if !scan_share_safe_text(&encoded).is_empty() {
                return Err(TriageContractError::PrivacyLeak);
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TriageCancellationV1 {
    pub schema_id: String,
    pub run_id: String,
    pub cancellation_id: String,
}

impl TriageCancellationV1 {
    pub fn validate(&self) -> Result<(), TriageContractError> {
        expect_schema(&self.schema_id, TRIAGE_CANCELLATION_SCHEMA_V1)?;
        validate_opaque_id("run_id", &self.run_id)?;
        validate_opaque_id("cancellation_id", &self.cancellation_id)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TriageReplayV1 {
    pub schema_id: String,
    pub run_id: String,
    pub request_fingerprint: String,
    pub events: Vec<TriageRunEventV2>,
}

impl TriageReplayV1 {
    pub fn validate(&self) -> Result<(), TriageContractError> {
        expect_schema(&self.schema_id, TRIAGE_REPLAY_SCHEMA_V1)?;
        validate_opaque_id("run_id", &self.run_id)?;
        validate_opaque_id("request_fingerprint", &self.request_fingerprint)?;
        if self.events.is_empty() {
            return Err(TriageContractError::EmptyReplay);
        }
        if self.events.len() > MAX_TRIAGE_REPLAY_EVENTS {
            return Err(TriageContractError::PayloadTooLarge);
        }
        let Some(TriageRunEventV2 {
            event:
                TriageRunEventPayloadV2::RunStarted {
                    request_fingerprint,
                    ..
                },
            ..
        }) = self.events.first()
        else {
            return Err(TriageContractError::MissingRunStarted);
        };
        if request_fingerprint != &self.request_fingerprint {
            return Err(TriageContractError::RequestFingerprintMismatch);
        }
        let mut terminal_count = 0usize;
        for (index, event) in self.events.iter().enumerate() {
            event.validate()?;
            if event.run_id != self.run_id {
                return Err(TriageContractError::RunIdentityMismatch);
            }
            if event.sequence != index as u64 {
                return Err(TriageContractError::NonContiguousSequence);
            }
            if event.event.is_terminal() {
                terminal_count += 1;
                if index + 1 != self.events.len() {
                    return Err(TriageContractError::EventAfterTerminal);
                }
            }
        }
        if terminal_count != 1 {
            return Err(TriageContractError::TerminalCount(terminal_count));
        }
        Ok(())
    }
}

pub fn parse_request_v2(raw: &str) -> Result<TriageRequestV2, TriageContractError> {
    let value: TriageRequestV2 = parse_versioned(raw, TRIAGE_REQUEST_SCHEMA_V2)?;
    value.validate()?;
    Ok(value)
}

pub fn parse_event_v2(raw: &str) -> Result<TriageRunEventV2, TriageContractError> {
    let value: TriageRunEventV2 = parse_versioned(raw, TRIAGE_RUN_EVENT_SCHEMA_V2)?;
    value.validate()?;
    Ok(value)
}

pub fn parse_result_v2(raw: &str) -> Result<TriageResultV2, TriageContractError> {
    let value: TriageResultV2 = parse_versioned(raw, TRIAGE_RESULT_SCHEMA_V2)?;
    value.validate()?;
    Ok(value)
}

pub fn parse_cancellation_v1(raw: &str) -> Result<TriageCancellationV1, TriageContractError> {
    let value: TriageCancellationV1 = parse_versioned(raw, TRIAGE_CANCELLATION_SCHEMA_V1)?;
    value.validate()?;
    Ok(value)
}

pub fn parse_replay_v1(raw: &str) -> Result<TriageReplayV1, TriageContractError> {
    let value: TriageReplayV1 = parse_versioned(raw, TRIAGE_REPLAY_SCHEMA_V1)?;
    value.validate()?;
    Ok(value)
}

fn parse_versioned<T: for<'de> Deserialize<'de>>(
    raw: &str,
    expected: &'static str,
) -> Result<T, TriageContractError> {
    if raw.len() > MAX_TRIAGE_WIRE_BYTES {
        return Err(TriageContractError::PayloadTooLarge);
    }
    let header: Value = serde_json::from_str(raw).map_err(|_| TriageContractError::Parse)?;
    let got = header
        .get("schema_id")
        .and_then(Value::as_str)
        .ok_or(TriageContractError::MissingSchema)?;
    expect_schema(got, expected)?;
    serde_json::from_value(header).map_err(|_| TriageContractError::Parse)
}

fn expect_schema(got: &str, expected: &'static str) -> Result<(), TriageContractError> {
    if got == expected {
        Ok(())
    } else {
        Err(TriageContractError::UnknownSchema {
            expected,
            got: got.to_string(),
        })
    }
}

fn validate_opaque_id(field: &'static str, value: &str) -> Result<(), TriageContractError> {
    if value.trim().is_empty()
        || value.len() > 512
        || value.contains('/')
        || value.contains('\\')
        || value.contains("://")
        || value.chars().any(char::is_control)
    {
        Err(TriageContractError::InvalidField(field))
    } else {
        Ok(())
    }
}

pub fn validate_unique_reason_codes(codes: &[String]) -> Result<(), TriageContractError> {
    if codes.len() > MAX_TRIAGE_REASON_CODES {
        return Err(TriageContractError::PayloadTooLarge);
    }
    let mut unique = BTreeSet::new();
    if codes
        .iter()
        .all(|code| validate_opaque_id("reason_code", code).is_ok() && unique.insert(code))
    {
        Ok(())
    } else {
        Err(TriageContractError::InvalidField("reason_codes"))
    }
}

fn validate_unique_ids(field: &'static str, ids: &[String]) -> Result<(), TriageContractError> {
    let mut unique = BTreeSet::new();
    if ids
        .iter()
        .all(|id| validate_opaque_id(field, id).is_ok() && unique.insert(id))
    {
        Ok(())
    } else {
        Err(TriageContractError::InvalidField(field))
    }
}

fn validate_unique_ids_bounded(
    field: &'static str,
    ids: &[String],
    max: usize,
) -> Result<(), TriageContractError> {
    if ids.len() > max {
        return Err(TriageContractError::PayloadTooLarge);
    }
    validate_unique_ids(field, ids)
}

fn validate_terminal_partial(
    run_id: &str,
    partial: Option<&TriageResultV2>,
) -> Result<(), TriageContractError> {
    let Some(partial) = partial else {
        return Ok(());
    };
    partial.validate()?;
    if partial.run_id != run_id {
        return Err(TriageContractError::RunIdentityMismatch);
    }
    if partial.kind != TriageResultKind::HonestPartial {
        return Err(TriageContractError::InvalidField("terminal_partial_result"));
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum TriageContractError {
    #[error("triage contract JSON could not be parsed")]
    Parse,
    #[error("triage contract schema_id is missing")]
    MissingSchema,
    #[error("unknown triage contract schema `{got}`; expected `{expected}`")]
    UnknownSchema { expected: &'static str, got: String },
    #[error("invalid triage contract field `{0}`")]
    InvalidField(&'static str),
    #[error("triage replay is empty")]
    EmptyReplay,
    #[error("triage replay does not begin with run_started")]
    MissingRunStarted,
    #[error("triage replay request fingerprint does not match run_started")]
    RequestFingerprintMismatch,
    #[error("triage event sequence is not contiguous from zero")]
    NonContiguousSequence,
    #[error("triage replay has {0} terminal events; expected exactly one")]
    TerminalCount(usize),
    #[error("triage replay contains an event after its terminal event")]
    EventAfterTerminal,
    #[error("triage run identity does not match its envelope")]
    RunIdentityMismatch,
    #[error("share-safe triage serialization contains owner-only material")]
    PrivacyLeak,
    #[error("triage contract serialization failed")]
    Serialize,
    #[error("triage contract payload exceeds its public bound")]
    PayloadTooLarge,
}
