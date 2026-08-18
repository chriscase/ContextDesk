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

use std::collections::{BTreeMap, BTreeSet};

use cd_triage_bench::{Case, ClaimedCitation, EvaluationTask, EvidenceSnapshot};
use cd_triage_sdk::{TriageReplayV1, TriageResultV2, TriageRoleAttemptV1, TriageRunEventPayloadV2};

use crate::error::{AdapterError, AdapterResult};
use crate::fingerprint::{fingerprint, POLICY_PREFIX, SDK_RUN_PREFIX};
use crate::packet::{materialize_bounded_packet, BoundedPacket};
use crate::record::{
    record_run, record_validated_run, HostExecutionProof, RecordedContextDeskRun, RecordingContext,
    TerminalProvenance,
};
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
    /// Policy fingerprint the authoritative `RunStarted` event reported.
    pub executed_policy_fingerprint: String,
}

/// What the authoritative replay proves about an execution packet.
///
/// The bench packet is always materialized before recording. A normal replay
/// must repeat that packet exactly. A contract-valid pre-packet terminal is
/// instead explicit proof that execution stopped before any engine packet was
/// produced.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionPacketState {
    /// `PacketReady` repeated the exact materialized packet identity.
    Matched,
    /// The validated replay terminated before `PacketReady` without a result.
    NotProduced,
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
    validate_replay_with_policy_binding(replay, bound, true)
}

/// Validate a replay returned by the real workflow host.
///
/// A live host fingerprints the resolved, override-adjusted policy document;
/// that is intentionally distinct from the public request's policy-selection
/// fingerprint. Both are retained. Offline/imported replays continue through
/// [`validate_public_replay`] and must repeat the selection fingerprint exactly.
pub fn validate_live_public_replay(
    replay: TriageReplayV1,
    bound: &BoundRequest,
) -> AdapterResult<ValidatedReplayOutcome> {
    validate_replay_with_policy_binding(replay, bound, false)
}

fn validate_replay_with_policy_binding(
    replay: TriageReplayV1,
    bound: &BoundRequest,
    require_selection_policy_fingerprint: bool,
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
    let executed_policy_fingerprint = if let Some(TriageRunEventPayloadV2::RunStarted {
        request_fingerprint,
        policy_fingerprint,
    }) = replay.events.first().map(|event| &event.event)
    {
        if request_fingerprint != &bound.request_fingerprint
            || policy_fingerprint.trim().is_empty()
            || (require_selection_policy_fingerprint
                && policy_fingerprint != &bound.policy_fingerprint)
        {
            return Err(AdapterError::IdentityMismatch(
                "run_started fingerprints do not match the bound request".into(),
            ));
        }
        policy_fingerprint.clone()
    } else {
        return Err(AdapterError::IdentityMismatch(
            "replay does not start with run_started".into(),
        ));
    };

    let replay = cd_triage_runtime::replay(bound.request.clone(), replay)
        .map_err(|_| {
            AdapterError::IdentityMismatch(
                "replay failed public runtime request or cross-event binding".into(),
            )
        })?
        .into_replay();

    let terminal = terminal_payload(&replay)?;
    let _ = terminal_result(terminal);

    let pre_packet = !replay
        .events
        .iter()
        .any(|event| matches!(&event.event, TriageRunEventPayloadV2::PacketReady { .. }));
    let mut attempts = Vec::new();
    for event in &replay.events {
        if let TriageRunEventPayloadV2::RoleAttempt { attempt } = &event.event {
            if attempt.model.is_none() && !pre_packet {
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

    Ok(ValidatedReplayOutcome {
        replay,
        attempts,
        executed_policy_fingerprint,
    })
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
/// `bounded` is not that packet. A normal replay requires [`PacketReady`] and
/// the terminal packet identity (when a result is present) to match the
/// materialized packet. A validated pre-packet terminal is recorded as
/// [`ExecutionPacketState::NotProduced`]. A differing production packet fails
/// closed. No host attestation is invented.
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

/// Record a replay emitted by the real workflow host over a run-exclusive
/// corpus imported from the exact benchmark snapshot bytes.
///
/// A production packet is not the benchmark's source-neutral task packet, so
/// this function never asserts that their ids are equal. Instead it requires
/// an owner-only [`HostExecutionProof`] captured before provider work and
/// binds every imported source and returned citation back to the benchmark
/// evidence inventory. A contract-valid pre-packet terminal must omit the
/// proof and is recorded honestly as [`ExecutionPacketState::NotProduced`].
#[allow(clippy::too_many_arguments)]
pub fn record_live_public_replay(
    case: &Case,
    snapshot: &EvidenceSnapshot,
    task: &EvaluationTask,
    bounded: &BoundedPacket,
    bound: &BoundRequest,
    replay: TriageReplayV1,
    proof: Option<HostExecutionProof>,
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

    let outcome = validate_live_public_replay(replay, bound)?;
    match proof {
        Some(proof) => {
            let claims = prove_live_execution(&outcome, bound, bounded, &proof)?;
            record_validated_run(
                snapshot,
                task,
                bound,
                bounded,
                &outcome,
                context,
                ExecutionPacketState::Matched,
                Some(proof),
                claims,
                "cd-triage-bench-live",
            )
        }
        None => {
            let packet_state = prove_materialized_packet(&outcome.replay, bounded)?;
            if packet_state != ExecutionPacketState::NotProduced {
                return Err(AdapterError::IdentityMismatch(
                    "live replay produced a packet without host execution proof".into(),
                ));
            }
            record_validated_run(
                snapshot,
                task,
                bound,
                bounded,
                &outcome,
                context,
                packet_state,
                None,
                Vec::new(),
                "cd-triage-bench-live",
            )
        }
    }
}

fn prove_live_execution(
    outcome: &ValidatedReplayOutcome,
    bound: &BoundRequest,
    bounded: &BoundedPacket,
    proof: &HostExecutionProof,
) -> AdapterResult<Vec<ClaimedCitation>> {
    if proof.packet_id.trim().is_empty()
        || proof.packet_digest.trim().is_empty()
        || proof.policy_fingerprint.trim().is_empty()
        || proof.ledger_digest.trim().is_empty()
        || proof.corpus_id.trim().is_empty()
        || proof.corpus_revision == 0
        || proof.evidence_count == 0
        || proof.packet_digest != proof.ledger_digest
    {
        return Err(AdapterError::IdentityMismatch(
            "live host execution proof is incomplete".into(),
        ));
    }
    if bound.request.scope.corpus_id != proof.corpus_id
        || bound.request.scope.corpus_revision != Some(proof.corpus_revision)
        || !bound.request.scope.source_ids.is_empty()
    {
        return Err(AdapterError::IdentityMismatch(
            "live request scope does not match the isolated host corpus proof".into(),
        ));
    }
    if outcome.executed_policy_fingerprint != proof.policy_fingerprint {
        return Err(AdapterError::IdentityMismatch(
            "RunStarted policy fingerprint does not match the captured host proof".into(),
        ));
    }
    if proof.snapshot_revision.event_revision != proof.corpus_revision {
        return Err(AdapterError::IdentityMismatch(
            "host packet event revision does not match the requested corpus revision".into(),
        ));
    }

    let ready = outcome
        .replay
        .events
        .iter()
        .find_map(|event| match &event.event {
            TriageRunEventPayloadV2::PacketReady {
                packet_id,
                packet_digest,
                evidence_count,
            } => Some((packet_id, packet_digest, *evidence_count)),
            _ => None,
        });
    let Some((packet_id, packet_digest, evidence_count)) = ready else {
        return Err(AdapterError::IdentityMismatch(
            "host execution proof was supplied for a pre-packet replay".into(),
        ));
    };
    if packet_id != &proof.packet_id
        || packet_digest != &proof.packet_digest
        || evidence_count != proof.evidence_count
    {
        return Err(AdapterError::IdentityMismatch(
            "PacketReady does not match the captured host execution proof".into(),
        ));
    }
    if let Some(result) = outcome.result() {
        if result.packet_id != proof.packet_id {
            return Err(AdapterError::IdentityMismatch(
                "terminal result does not repeat the captured host packet identity".into(),
            ));
        }
    }

    let source_map = prove_live_sources(bounded, proof)?;
    let packet_evidence = prove_live_packet_evidence(proof, &source_map)?;
    live_claims(outcome.result(), proof, &source_map, &packet_evidence)
}

fn prove_live_sources<'a>(
    bounded: &BoundedPacket,
    proof: &'a HostExecutionProof,
) -> AdapterResult<BTreeMap<&'a str, &'a crate::record::HostSourceBinding>> {
    if proof.sources.len() != bounded.packet.evidence.len()
        || !proof
            .sources
            .windows(2)
            .all(|pair| pair[0].source_label < pair[1].source_label)
    {
        return Err(AdapterError::IdentityMismatch(
            "imported source proof is not a complete sorted snapshot inventory".into(),
        ));
    }

    let expected = bounded
        .packet
        .evidence
        .iter()
        .map(|item| (item.item_id.as_str(), item))
        .collect::<BTreeMap<_, _>>();
    let mut by_source = BTreeMap::new();
    let mut item_ids = BTreeSet::new();
    for source in &proof.sources {
        if source.source_label.trim().is_empty()
            || by_source
                .insert(source.source_label.as_str(), source)
                .is_some()
            || !item_ids.insert(source.evidence_item_id.as_str())
        {
            return Err(AdapterError::IdentityMismatch(
                "imported source proof is not one-to-one".into(),
            ));
        }
        let Some(item) = expected.get(source.evidence_item_id.as_str()) else {
            return Err(AdapterError::IdentityMismatch(
                "imported source proof names evidence outside task visibility".into(),
            ));
        };
        let Some(content) = &item.content else {
            return Err(AdapterError::IdentityMismatch(
                "live execution cannot prove raw bytes for an external-only reference".into(),
            ));
        };
        if source.content_digest != content.digest.wire()
            || source.byte_length != content.byte_length
        {
            return Err(AdapterError::IdentityMismatch(
                "imported source proof does not match the snapshot content manifest".into(),
            ));
        }
    }
    if item_ids != expected.keys().copied().collect::<BTreeSet<_>>() {
        return Err(AdapterError::IdentityMismatch(
            "imported source proof does not cover the exact visible item set".into(),
        ));
    }
    Ok(by_source)
}

fn prove_live_packet_evidence<'a>(
    proof: &'a HostExecutionProof,
    source_map: &BTreeMap<&str, &crate::record::HostSourceBinding>,
) -> AdapterResult<BTreeMap<&'a str, &'a str>> {
    if proof.packet_evidence.len() != proof.evidence_count as usize
        || !proof
            .packet_evidence
            .windows(2)
            .all(|pair| pair[0].evidence_id < pair[1].evidence_id)
    {
        return Err(AdapterError::IdentityMismatch(
            "host packet evidence proof is not complete and sorted".into(),
        ));
    }
    let mut evidence = BTreeMap::new();
    for row in &proof.packet_evidence {
        if row.evidence_id.trim().is_empty()
            || row.source_label.trim().is_empty()
            || !source_map.contains_key(row.source_label.as_str())
            || evidence
                .insert(row.evidence_id.as_str(), row.source_label.as_str())
                .is_some()
        {
            return Err(AdapterError::IdentityMismatch(
                "host packet evidence proof is outside the imported source inventory".into(),
            ));
        }
    }
    let packet_sources = evidence.values().copied().collect::<BTreeSet<_>>();
    let claimed_sources = proof
        .packet_source_labels
        .iter()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    if claimed_sources != packet_sources
        || claimed_sources.len() != proof.packet_source_labels.len()
        || !proof
            .packet_source_labels
            .windows(2)
            .all(|pair| pair[0] < pair[1])
    {
        return Err(AdapterError::IdentityMismatch(
            "host packet source inventory does not match its evidence proof".into(),
        ));
    }
    Ok(evidence)
}

fn live_claims(
    result: Option<&TriageResultV2>,
    proof: &HostExecutionProof,
    source_map: &BTreeMap<&str, &crate::record::HostSourceBinding>,
    packet_evidence: &BTreeMap<&str, &str>,
) -> AdapterResult<Vec<ClaimedCitation>> {
    let Some(answer) = result.and_then(|result| result.answer.as_ref()) else {
        return Ok(Vec::new());
    };
    if answer.binding.corpus_id != proof.corpus_id
        || answer.binding.revision != proof.snapshot_revision
        || answer.binding.ledger_digest != proof.ledger_digest
    {
        return Err(AdapterError::IdentityMismatch(
            "answer binding does not match the captured host packet proof".into(),
        ));
    }

    let mut evidence = BTreeMap::new();
    for row in &answer.evidence {
        let Some(expected_source) = packet_evidence.get(row.evidence_id.as_str()) else {
            return Err(AdapterError::IdentityMismatch(
                "answer evidence identity is outside the captured host packet proof".into(),
            ));
        };
        if row.corpus_id != proof.corpus_id
            || row.revision != proof.snapshot_revision
            || *expected_source != row.source_label
            || !source_map.contains_key(row.source_label.as_str())
            || evidence.insert(row.evidence_id.as_str(), row).is_some()
        {
            return Err(AdapterError::IdentityMismatch(
                "answer evidence is outside the captured host packet proof".into(),
            ));
        }
    }
    if evidence.keys().copied().collect::<BTreeSet<_>>()
        != packet_evidence.keys().copied().collect::<BTreeSet<_>>()
    {
        return Err(AdapterError::IdentityMismatch(
            "answer evidence does not repeat the complete captured host packet".into(),
        ));
    }

    let mut locators = BTreeMap::new();
    for citation in &answer.answer.canonical_citations {
        let Some(row) = evidence.get(citation.evidence_id.as_str()) else {
            return Err(AdapterError::IdentityMismatch(
                "canonical citation names evidence outside the host packet".into(),
            ));
        };
        if citation.candidate_id != row.candidate_id
            || citation.source_label != row.source_label
            || citation.corpus_id != row.corpus_id
            || citation.revision != row.revision
            || citation.locator != row.locator
            || citation.content != row.content
            || locators
                .insert(citation.evidence_id.as_str(), citation.locator.as_str())
                .is_some()
        {
            return Err(AdapterError::IdentityMismatch(
                "canonical citation does not repeat its authoritative evidence row".into(),
            ));
        }
    }

    let mut claims = Vec::new();
    let mut claimed_evidence = BTreeSet::new();
    for candidate in &answer.answer.candidates {
        for claim in &candidate.claims {
            if claim.evidence_ids.is_empty() {
                claims.push(ClaimedCitation {
                    claim: claim.text.clone(),
                    evidence_item_id: None,
                    locator: None,
                });
                continue;
            }
            let mut claim_evidence = BTreeSet::new();
            for evidence_id in &claim.evidence_ids {
                let Some(row) = evidence.get(evidence_id.as_str()) else {
                    return Err(AdapterError::IdentityMismatch(
                        "claim names evidence outside the captured host packet".into(),
                    ));
                };
                if row.candidate_id != candidate.candidate_id
                    || !claim_evidence.insert(evidence_id.as_str())
                {
                    return Err(AdapterError::IdentityMismatch(
                        "claim evidence does not match its authoritative candidate".into(),
                    ));
                }
                claimed_evidence.insert(evidence_id.as_str());
                let Some(source) = source_map.get(row.source_label.as_str()) else {
                    return Err(AdapterError::IdentityMismatch(
                        "claim source does not map to benchmark evidence".into(),
                    ));
                };
                claims.push(ClaimedCitation {
                    claim: claim.text.clone(),
                    evidence_item_id: Some(source.evidence_item_id.clone()),
                    locator: locators
                        .get(evidence_id.as_str())
                        .map(|value| (*value).to_string()),
                });
            }
        }
    }
    if claimed_evidence != locators.keys().copied().collect::<BTreeSet<_>>() {
        return Err(AdapterError::IdentityMismatch(
            "canonical citations do not exactly cover claim-referenced evidence".into(),
        ));
    }
    Ok(claims)
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
) -> AdapterResult<ExecutionPacketState> {
    let ready = replay.events.iter().find_map(|event| match &event.event {
        TriageRunEventPayloadV2::PacketReady {
            packet_id,
            packet_digest,
            ..
        } => Some((packet_id.as_str(), packet_digest.as_str())),
        _ => None,
    });
    let Some((packet_id, packet_digest)) = ready else {
        if terminal_result(terminal_payload(replay)?).is_some() {
            return Err(AdapterError::IdentityMismatch(
                "replay has a terminal result without a PacketReady proof".into(),
            ));
        }
        return Ok(ExecutionPacketState::NotProduced);
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
    Ok(ExecutionPacketState::Matched)
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
