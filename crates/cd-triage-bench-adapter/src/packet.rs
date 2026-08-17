//! Bounded packet materialization.
//!
//! The adapter never assembles evidence itself. It calls the bench's real
//! [`cd_triage_bench::materialize_task_packet`] and then re-checks the result
//! against the task's visibility policy, so a widening attempt fails closed
//! twice: once in the bench, once here.
//!
//! A [`TaskPacket`] carries content **digests**, never evidence bytes. That is
//! why no adapter path can leak a raw body: it never holds one.

use std::collections::BTreeSet;

use cd_triage_bench::{
    materialize_task_packet, Case, EvaluationTask, EvidenceSnapshot, TaskPacket,
};
use cd_triage_sdk::MAX_TRIAGE_SOURCE_IDS;
use serde::Serialize;

use crate::error::{AdapterError, AdapterResult};
use crate::fingerprint::{fingerprint, CORPUS_PREFIX, PACKET_PREFIX};

/// A materialized packet plus the identities the SDK request and replay bind to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BoundedPacket {
    /// The bench-materialized packet. Resolution is structurally absent.
    pub packet: TaskPacket,
    /// Fingerprint over the whole packet, including every visible digest.
    pub packet_fingerprint: String,
    /// Fingerprint over the bounded evidence corpus the strategy may see.
    pub corpus_fingerprint: String,
    /// Number of visible evidence rows.
    pub evidence_count: u32,
    /// Sorted visible item identities, exactly as the task allows.
    pub visible_item_ids: Vec<String>,
}

/// Identity-only corpus body. Digests and ids, never bytes or source labels.
#[derive(Serialize)]
struct CorpusBody<'a> {
    snapshot_id: &'a str,
    case_id: &'a str,
    items: Vec<CorpusItem<'a>>,
}

#[derive(Serialize)]
struct CorpusItem<'a> {
    item_id: &'a str,
    kind: &'a str,
    content_digest: Option<String>,
    expected_content_digest: Option<String>,
}

/// Materialize the packet for `task` and prove it did not widen evidence.
///
/// Fails closed when the task names an item the snapshot does not hold, when
/// the snapshot marks an item as not visible to strategies, when the packet's
/// evidence set differs from the task's visibility policy in either direction,
/// or when the visible set exceeds the public [`MAX_TRIAGE_SOURCE_IDS`] bound.
pub fn materialize_bounded_packet(
    case: &Case,
    snapshot: &EvidenceSnapshot,
    task: &EvaluationTask,
) -> AdapterResult<BoundedPacket> {
    let packet = materialize_task_packet(case, snapshot, task).map_err(AdapterError::bench)?;

    let allowed: BTreeSet<&str> = task
        .visibility
        .visible_item_ids
        .iter()
        .map(String::as_str)
        .collect();
    let materialized: BTreeSet<&str> = packet
        .evidence
        .iter()
        .map(|row| row.item_id.as_str())
        .collect();

    if let Some(extra) = materialized.difference(&allowed).next() {
        return Err(AdapterError::VisibilityWidened(format!(
            "packet holds item {extra}, which the task visibility policy does not allow"
        )));
    }
    if let Some(missing) = allowed.difference(&materialized).next() {
        return Err(AdapterError::VisibilityWidened(format!(
            "packet omits allowed item {missing}; packet and policy must agree exactly"
        )));
    }
    for item_id in &materialized {
        let item = snapshot.item(item_id).ok_or_else(|| {
            AdapterError::VisibilityWidened(format!(
                "packet holds item {item_id}, which is absent from snapshot {}",
                snapshot.snapshot_id
            ))
        })?;
        if !item.visible_to_strategies() {
            return Err(AdapterError::VisibilityWidened(format!(
                "packet holds item {item_id}, which the snapshot marks not visible to strategies"
            )));
        }
    }
    if packet.snapshot_id != snapshot.snapshot_id || packet.task_id != task.task_id {
        return Err(AdapterError::IdentityMismatch(
            "packet does not carry its snapshot and task identity".into(),
        ));
    }
    if materialized.len() > MAX_TRIAGE_SOURCE_IDS {
        return Err(AdapterError::BoundExceeded(format!(
            "{} visible items exceed the public bound of {MAX_TRIAGE_SOURCE_IDS}",
            materialized.len()
        )));
    }

    let corpus = CorpusBody {
        snapshot_id: &snapshot.snapshot_id,
        case_id: &snapshot.case_id,
        items: packet
            .evidence
            .iter()
            .map(|row| CorpusItem {
                item_id: &row.item_id,
                kind: &row.kind,
                content_digest: row.content.as_ref().map(|held| held.digest.wire()),
                expected_content_digest: row
                    .expected_content_digest
                    .as_ref()
                    .map(|digest| digest.wire()),
            })
            .collect(),
    };

    Ok(BoundedPacket {
        packet_fingerprint: fingerprint(PACKET_PREFIX, &packet)?,
        corpus_fingerprint: fingerprint(CORPUS_PREFIX, &corpus)?,
        evidence_count: materialized.len() as u32,
        visible_item_ids: materialized.iter().map(|id| (*id).to_string()).collect(),
        packet,
    })
}
