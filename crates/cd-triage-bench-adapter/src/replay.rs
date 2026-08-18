//! Source-neutral public-SDK replay validation.
//!
//! Recording must not depend on the deterministic mock engine. Any caller
//! that already holds a [`TriageReplayV1`] — mock, later live façade, or an
//! imported JSON blob — goes through [`validate_public_replay`] and then the
//! single [`crate::record::record_run`] path.
//!
//! This module fabricates no usage, cost, timing, model, prompt, or
//! completion facts. Phase order is the real
//! [`TriageReplayV1::validate`]; canonical request and cross-event binding use
//! `cd-triage-runtime`; policy and packet proofs are extra fail-closed checks
//! against the adapter's bound request and materialized packet.

use cd_triage_bench::{Case, EvaluationTask, EvidenceSnapshot};
use cd_triage_sdk::{TriageReplayV1, TriageResultV2, TriageRoleAttemptV1, TriageRunEventPayloadV2};

use crate::error::{AdapterError, AdapterResult};
use crate::fingerprint::{fingerprint, POLICY_PREFIX, SDK_RUN_PREFIX};
use crate::packet::{materialize_bounded_packet, BoundedPacket};
use crate::record::{record_run, RecordedContextDeskRun, RecordingContext, TerminalProvenance};
use crate::request::BoundRequest;
use cd_triage_bench::RunStatus;
use cd_triage_sdk::TriageResultKind;

/// A replay the public validator accepted, bound to one [`BoundRequest`].
///
/// Attempts are the `RoleAttempt` events in emission order. The terminal is
/// the single last event; [`TriageReplayV1::validate`] has already required
/// that shape, and this type re-checks it so recording never trusts a
/// caller assertion.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedReplayOutcome {
    /// Owner-only replay. Already accepted by [`TriageReplayV1::validate`].
    pub replay: TriageReplayV1,
    /// Role attempts in emission order.
    pub attempts: Vec<TriageRoleAttemptV1>,
}

impl ValidatedReplayOutcome {
    /// The single terminal payload.
    pub fn terminal(&self) -> &TriageRunEventPayloadV2 {
        terminal_payload(&self.replay).expect("validated replay ends in a terminal event")
    }

    /// Authoritative or partial result on the terminal, if any.
    pub fn result(&self) -> Option<&TriageResultV2> {
        terminal_result(self.terminal())
    }
}

/// Validate `replay` with the real public contract and bind it to `bound`.
///
/// Rejects a mismatched run id or request fingerprint, a replay that is not
/// a single-terminal stream, and any role attempt that omitted an exact
/// model or terminal disposition. Phase-order failures come from
/// [`TriageReplayV1::validate`] and are not reimplemented here.
pub fn validate_public_replay(
    replay: TriageReplayV1,
    bound: &BoundRequest,
) -> AdapterResult<ValidatedReplayOutcome> {
    let canonical_request = cd_triage_runtime::canonical_request_fingerprint(&bound.request)
        .map_err(|_| {
            AdapterError::IdentityMismatch(
                "bound request failed public runtime validation or identity".into(),
            )
        })?;
    let canonical_policy = fingerprint(POLICY_PREFIX, &bound.request.policy)?;
    let canonical_run = fingerprint(SDK_RUN_PREFIX, &canonical_request)?;
    if bound.request_fingerprint != canonical_request
        || bound.policy_fingerprint != canonical_policy
        || bound.sdk_run_id != canonical_run
        || bound.request.run_id != canonical_run
    {
        return Err(AdapterError::IdentityMismatch(
            "bound request provenance is not canonical".into(),
        ));
    }
    replay.validate()?;
    if replay.run_id != bound.sdk_run_id {
        return Err(AdapterError::IdentityMismatch(
            "replay run_id does not match the bound request".into(),
        ));
    }
    if replay.request_fingerprint != bound.request_fingerprint {
        return Err(AdapterError::IdentityMismatch(
            "replay request_fingerprint does not match the bound request".into(),
        ));
    }
    if let Some(TriageRunEventPayloadV2::RunStarted {
        request_fingerprint,
        policy_fingerprint,
    }) = replay.events.first().map(|event| &event.event)
    {
        if request_fingerprint != &bound.request_fingerprint
            || policy_fingerprint != &bound.policy_fingerprint
        {
            return Err(AdapterError::IdentityMismatch(
                "run_started fingerprints do not match the bound request".into(),
            ));
        }
    }

    let replay = cd_triage_runtime::replay(bound.request.clone(), replay)
        .map_err(|_| {
            AdapterError::IdentityMismatch(
                "replay failed public runtime request or cross-event binding".into(),
            )
        })?
        .into_replay();

    let terminal = terminal_payload(&replay)?;
    let _ = terminal_result(terminal);

    let mut attempts = Vec::new();
    for event in &replay.events {
        if let TriageRunEventPayloadV2::RoleAttempt { attempt } = &event.event {
            if attempt.model.is_none() {
                return Err(AdapterError::IdentityMismatch(format!(
                    "attempt {} does not record an exact model identity",
                    attempt.attempt_id
                )));
            }
            if attempt.terminal_disposition.is_none() {
                return Err(AdapterError::IdentityMismatch(format!(
                    "attempt {} does not record a terminal disposition",
                    attempt.attempt_id
                )));
            }
            attempts.push(attempt.clone());
        }
    }

    Ok(ValidatedReplayOutcome { replay, attempts })
}

/// Decode owner-only replay JSON. Does not validate the contract; callers
/// still run [`validate_public_replay`].
pub fn decode_replay_json(bytes: &[u8]) -> AdapterResult<TriageReplayV1> {
    serde_json::from_slice(bytes).map_err(|_| AdapterError::ReplayJson)
}

/// Record a public-SDK replay against an already-materialized packet and
/// bound request.
///
/// Rematerializes the packet from `case`/`snapshot`/`task` and refuses if
/// `bounded` is not that packet. Recording then requires [`PacketReady`] and
/// the terminal packet identity (when a result is present) to match the
/// materialized packet. A differing production packet fails closed. No host
/// attestation is invented.
pub fn record_public_replay(
    case: &Case,
    snapshot: &EvidenceSnapshot,
    task: &EvaluationTask,
    bounded: &BoundedPacket,
    bound: &BoundRequest,
    replay: TriageReplayV1,
    context: &RecordingContext,
) -> AdapterResult<RecordedContextDeskRun> {
    if task.case_id != case.case_id {
        return Err(AdapterError::IdentityMismatch(format!(
            "task {} belongs to case {}, not {}",
            task.task_id, task.case_id, case.case_id
        )));
    }
    if task.snapshot_id != snapshot.snapshot_id {
        return Err(AdapterError::IdentityMismatch(format!(
            "task {} is bound to snapshot {}, not {}",
            task.task_id, task.snapshot_id, snapshot.snapshot_id
        )));
    }
    let expected = materialize_bounded_packet(case, snapshot, task)?;
    if expected.packet.packet_id != bounded.packet.packet_id
        || expected.packet_fingerprint != bounded.packet_fingerprint
    {
        return Err(AdapterError::IdentityMismatch(
            "bounded packet is not the adapter materialization of this snapshot and task".into(),
        ));
    }
    let outcome = validate_public_replay(replay, bound)?;
    record_run(snapshot, task, bound, bounded, &outcome, context)
}

pub(crate) fn terminal_payload(replay: &TriageReplayV1) -> AdapterResult<&TriageRunEventPayloadV2> {
    let Some(last) = replay.events.last() else {
        return Err(AdapterError::IdentityMismatch(
            "validated replay did not end in a terminal event".into(),
        ));
    };
    if !last.event.is_terminal() {
        return Err(AdapterError::IdentityMismatch(
            "validated replay did not end in a terminal event".into(),
        ));
    }
    let terminals = replay
        .events
        .iter()
        .filter(|event| event.event.is_terminal())
        .count();
    if terminals != 1 {
        return Err(AdapterError::IdentityMismatch(
            "replay must carry exactly one terminal event".into(),
        ));
    }
    Ok(&last.event)
}

pub(crate) fn terminal_result(terminal: &TriageRunEventPayloadV2) -> Option<&TriageResultV2> {
    match terminal {
        TriageRunEventPayloadV2::Completed { result } => Some(result),
        TriageRunEventPayloadV2::Failed { partial_result, .. }
        | TriageRunEventPayloadV2::TimedOut { partial_result, .. }
        | TriageRunEventPayloadV2::Cancelled { partial_result, .. } => partial_result.as_deref(),
        _ => None,
    }
}

pub(crate) fn prove_materialized_packet(
    replay: &TriageReplayV1,
    bounded: &BoundedPacket,
) -> AdapterResult<()> {
    let ready = replay.events.iter().find_map(|event| match &event.event {
        TriageRunEventPayloadV2::PacketReady {
            packet_id,
            packet_digest,
            ..
        } => Some((packet_id.as_str(), packet_digest.as_str())),
        _ => None,
    });
    let Some((packet_id, packet_digest)) = ready else {
        return Err(AdapterError::IdentityMismatch(
            "replay has no PacketReady event proving the materialized packet".into(),
        ));
    };
    if packet_id != bounded.packet.packet_id || packet_digest != bounded.packet_fingerprint {
        return Err(AdapterError::IdentityMismatch(
            "PacketReady does not match the materialized packet".into(),
        ));
    }
    if let Some(result) = terminal_result(terminal_payload(replay)?) {
        if result.packet_id != bounded.packet.packet_id {
            return Err(AdapterError::IdentityMismatch(
                "terminal result packet identity does not match the materialized packet".into(),
            ));
        }
    }
    Ok(())
}

pub(crate) fn terminal_provenance(
    outcome: &ValidatedReplayOutcome,
) -> AdapterResult<TerminalProvenance> {
    let (kind, category, cancellation_id, result, provenance_only) = match outcome.terminal() {
        TriageRunEventPayloadV2::Completed { result } => {
            ("completed", None, None, Some(result.as_ref()), false)
        }
        TriageRunEventPayloadV2::Failed {
            category,
            partial_result,
        } => (
            "failed",
            Some(category.clone()),
            None,
            partial_result.as_deref(),
            partial_result.is_some(),
        ),
        TriageRunEventPayloadV2::TimedOut {
            category,
            partial_result,
        } => (
            "timed_out",
            Some(category.clone()),
            None,
            partial_result.as_deref(),
            partial_result.is_some(),
        ),
        TriageRunEventPayloadV2::Cancelled {
            cancellation_id,
            partial_result,
        } => (
            "cancelled",
            None,
            Some(cancellation_id.clone()),
            partial_result.as_deref(),
            partial_result.is_some(),
        ),
        _ => {
            return Err(AdapterError::IdentityMismatch(
                "validated replay did not end in a terminal event".into(),
            ))
        }
    };

    let bench_status = match (kind, result.map(|result| result.kind)) {
        ("completed", Some(TriageResultKind::GroundedFinal)) => RunStatus::Completed,
        ("completed", _) => RunStatus::Partial,
        ("failed", _) => RunStatus::Failed,
        ("timed_out", _) => RunStatus::TimedOut,
        ("cancelled", _) => RunStatus::Cancelled,
        _ => unreachable!("terminal kinds are exhaustive above"),
    };

    Ok(TerminalProvenance {
        kind: kind.to_string(),
        category,
        cancellation_id,
        result_kind: result.map(|result| result.kind),
        validation_state: result.map(|result| result.validation_state),
        packet_id: result.map(|result| result.packet_id.clone()),
        reason_codes: result
            .map(|result| result.reason_codes.clone())
            .unwrap_or_default(),
        partial_result_is_provenance_only: provenance_only,
        bench_status,
    })
}
