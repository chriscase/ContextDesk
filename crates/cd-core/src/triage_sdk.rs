//! Versioned host-neutral wire contracts for the public triage SDK boundary.
//!
//! Re-exported from the public contract crate so existing
//! `cd_core::triage_sdk` paths stay source-compatible.

pub use cd_triage_sdk::{
    parse_cancellation_v1, parse_event_v2, parse_replay_v1, parse_request_v2, parse_result_v2,
    validate_unique_reason_codes, ModelRef, ShareSafeTriageResultV2, TriageAttemptStatus,
    TriageAttemptTerminalDispositionV1, TriageCancellationV1, TriageContractError,
    TriagePolicySelectionV2, TriageReconciliationV1, TriageReplayV1, TriageRequestOverridesV1,
    TriageRequestV2, TriageResultKind, TriageResultV2, TriageRoleAttemptV1,
    TriageRunEventPayloadV2, TriageRunEventV2, TriageScopeV1, TriageTerminalDispositionV1,
    TriageValidationState, MAX_TRIAGE_EVIDENCE_IDS, MAX_TRIAGE_INLINE_POLICY_BYTES,
    MAX_TRIAGE_REASON_CODES, MAX_TRIAGE_REPLAY_EVENTS, MAX_TRIAGE_REQUEST_DEADLINE_MS,
    MAX_TRIAGE_REQUEST_PROVIDER_CALLS, MAX_TRIAGE_SOURCE_IDS, MAX_TRIAGE_TASK_BYTES,
    MAX_TRIAGE_WIRE_BYTES, TRIAGE_CANCELLATION_SCHEMA_V1, TRIAGE_REPLAY_SCHEMA_V1,
    TRIAGE_REQUEST_SCHEMA_V2, TRIAGE_RESULT_SCHEMA_V2, TRIAGE_RUN_EVENT_SCHEMA_V2,
    TRIAGE_SHARE_SAFE_RESULT_SCHEMA_V2,
};
