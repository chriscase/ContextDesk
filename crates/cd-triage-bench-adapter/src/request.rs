//! Bench task + bounded packet to a real `TriageRequestV2`.
//!
//! The request is the genuine `cd_triage_sdk` DTO, validated by the genuine
//! `TriageRequestV2::validate`. The adapter declares no request schema of its
//! own and re-implements no request validator.

use cd_triage_bench::{EvaluationTask, EvidenceSnapshot};
use cd_triage_sdk::{
    PacketPrivacyBoundary, TriagePolicySelectionV2, TriageRequestOverridesV1, TriageRequestV2,
    TriageScopeV1, MAX_TRIAGE_TASK_BYTES, TRIAGE_REQUEST_SCHEMA_V2,
};
use serde::Serialize;

use crate::error::{AdapterError, AdapterResult};
use crate::fingerprint::{fingerprint, POLICY_PREFIX, REQUEST_PREFIX, SDK_RUN_PREFIX};
use crate::packet::BoundedPacket;

/// A validated request together with the fingerprints the replay repeats.
#[derive(Debug, Clone, PartialEq)]
pub struct BoundRequest {
    /// The real public request DTO. Always owner-only: it carries task text.
    pub request: TriageRequestV2,
    /// Fingerprint the `run_started` event and the replay envelope must repeat.
    pub request_fingerprint: String,
    /// Fingerprint of the exact policy selection.
    pub policy_fingerprint: String,
    /// SDK-side run identity, derived from the request fingerprint.
    ///
    /// This is deliberately **not** the bench `TriageRun::run_id`, which is a
    /// separate content fingerprint over the imported run.
    pub sdk_run_id: String,
}

/// Body hashed for request identity. `run_id` is excluded because it is
/// derived from this fingerprint; packet and corpus fingerprints are included
/// so a different packet is always a different request.
#[derive(Serialize)]
struct RequestFingerprintBody<'a> {
    schema_id: &'a str,
    privacy: PacketPrivacyBoundary,
    task: &'a str,
    scope: &'a TriageScopeV1,
    policy_fingerprint: &'a str,
    overrides: &'a TriageRequestOverridesV1,
    cancellation_id: &'a str,
    packet_fingerprint: &'a str,
    corpus_fingerprint: &'a str,
}

/// Build the owner-only triage request for one bench task.
///
/// `overrides` is passed through unchanged so a caller-supplied deadline or
/// provider-call cap is validated by the public contract, not by the adapter.
pub fn build_request(
    snapshot: &EvidenceSnapshot,
    task: &EvaluationTask,
    bounded: &BoundedPacket,
    policy: TriagePolicySelectionV2,
    overrides: TriageRequestOverridesV1,
    cancellation_id: &str,
) -> AdapterResult<BoundRequest> {
    if task.snapshot_id != snapshot.snapshot_id {
        return Err(AdapterError::IdentityMismatch(format!(
            "task {} is bound to snapshot {}, not {}",
            task.task_id, task.snapshot_id, snapshot.snapshot_id
        )));
    }

    let text = task_text(task);
    if text.len() > MAX_TRIAGE_TASK_BYTES {
        return Err(AdapterError::BoundExceeded(format!(
            "task text is {} bytes, over the public bound of {MAX_TRIAGE_TASK_BYTES}",
            text.len()
        )));
    }

    // Bench snapshots are content-addressed, so there is no monotonic corpus
    // revision to report. Omitting it keeps "unknown" distinct from a
    // fabricated zero, which the contract would reject anyway.
    let scope = TriageScopeV1 {
        corpus_id: snapshot.snapshot_id.clone(),
        corpus_revision: None,
        source_ids: bounded.visible_item_ids.clone(),
    };

    let policy_fingerprint = fingerprint(POLICY_PREFIX, &policy)?;
    let overrides_for_body = overrides.clone();
    let request_fingerprint = fingerprint(
        REQUEST_PREFIX,
        &RequestFingerprintBody {
            schema_id: TRIAGE_REQUEST_SCHEMA_V2,
            privacy: PacketPrivacyBoundary::OwnerOnly,
            task: &text,
            scope: &scope,
            policy_fingerprint: &policy_fingerprint,
            overrides: &overrides_for_body,
            cancellation_id,
            packet_fingerprint: &bounded.packet_fingerprint,
            corpus_fingerprint: &bounded.corpus_fingerprint,
        },
    )?;
    let sdk_run_id = fingerprint(SDK_RUN_PREFIX, &request_fingerprint)?;

    let request = TriageRequestV2 {
        schema_id: TRIAGE_REQUEST_SCHEMA_V2.to_string(),
        run_id: sdk_run_id.clone(),
        privacy: PacketPrivacyBoundary::OwnerOnly,
        task: text,
        scope,
        policy,
        overrides,
        cancellation_id: cancellation_id.to_string(),
    };
    // Real public validator. The adapter adds no second request validator.
    request.validate()?;

    if request.scope.corpus_id != bounded.packet.snapshot_id {
        return Err(AdapterError::IdentityMismatch(
            "request corpus identity does not match the materialized packet snapshot".into(),
        ));
    }

    Ok(BoundRequest {
        request,
        request_fingerprint,
        policy_fingerprint,
        sdk_run_id,
    })
}

/// The exact question and protocol the bench task fixes, verbatim.
///
/// The adapter does not rewrite, summarize, or augment the task. Anything a
/// strategy is asked comes from the bench record.
fn task_text(task: &EvaluationTask) -> String {
    format!(
        "{}\n\nProtocol ({}): {}",
        task.question.trim(),
        task.protocol_version.trim(),
        task.protocol.trim()
    )
}
