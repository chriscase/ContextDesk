//! Snapshot → task packet under the task visibility policy. Widening fails closed.

use crate::error::{BenchError, BenchResult};
use crate::packet::{materialize_task_packet, TaskPacket};
use crate::types::{Case, EvaluationTask, EvidenceSnapshot};
use std::collections::BTreeSet;

/// Optional extra evidence the caller wants the engine to see.
///
/// A requested id that is not already in the task visibility set is a
/// widening attempt and is rejected. Narrowing (a subset) is allowed and
/// still materializes the full task-visible packet so fairness stays
/// `same_snapshot`.
#[derive(Debug, Clone, Default)]
pub struct VisibilityRequest<'a> {
    pub requested_item_ids: Option<&'a [String]>,
}

/// Materialize a strategy-visible packet and refuse evidence widening.
pub fn materialize_visible_packet(
    case: &Case,
    snapshot: &EvidenceSnapshot,
    task: &EvaluationTask,
    request: VisibilityRequest<'_>,
) -> BenchResult<TaskPacket> {
    let allowed: BTreeSet<&str> = task
        .visibility
        .visible_item_ids
        .iter()
        .map(String::as_str)
        .collect();

    if let Some(requested) = request.requested_item_ids {
        let mut seen = BTreeSet::new();
        for item_id in requested {
            if !seen.insert(item_id.as_str()) {
                return Err(BenchError::Schema(format!(
                    "duplicate requested evidence id {item_id}"
                )));
            }
            if !allowed.contains(item_id.as_str()) {
                return Err(BenchError::Integrity(format!(
                    "visibility widening rejected: {item_id} is not in the task visibility policy"
                )));
            }
            if snapshot.item(item_id).is_none() {
                return Err(BenchError::Schema(format!(
                    "requested evidence id {item_id} is not in snapshot {}",
                    snapshot.snapshot_id
                )));
            }
        }
    }

    let packet = materialize_task_packet(case, snapshot, task)?;
    let packet_ids: BTreeSet<&str> = packet
        .evidence
        .iter()
        .map(|item| item.item_id.as_str())
        .collect();
    if !packet_ids.is_subset(&allowed) {
        return Err(BenchError::Integrity(
            "materialized packet widened evidence beyond the task visibility policy".into(),
        ));
    }
    for item_id in &allowed {
        if snapshot.item(item_id).is_none() {
            return Err(BenchError::Schema(format!(
                "visible item {item_id} is not present in snapshot {}",
                snapshot.snapshot_id
            )));
        }
    }
    Ok(packet)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{
        Case, CaseLifecycle, ContentDigest, EvidenceItem, EvidenceSnapshot, EvidenceSource,
        HeldContent, PrivacyClass, ReportedProblem, VisibilityPolicy,
    };

    fn case_and_snapshot() -> (Case, EvidenceSnapshot) {
        let case = Case {
            schema_id: crate::types::CASE_SCHEMA_V1.into(),
            case_id: "case-1".into(),
            privacy: PrivacyClass::ShareSafe,
            title: "t".into(),
            reported_problem: ReportedProblem {
                summary: "s".into(),
                reported_at: None,
                reporter: None,
                symptoms: vec![],
            },
            lifecycle: CaseLifecycle::Unresolved,
            timeline_notes: vec![],
            created_at: "2026-01-15T00:00:00Z".into(),
            resolution: None,
        };
        let bytes = b"log\n";
        let snapshot = EvidenceSnapshot::from_parts(
            PrivacyClass::ShareSafe,
            "case-1".into(),
            "2026-01-15T06:00:00Z".into(),
            "op".into(),
            vec![
                EvidenceItem::Log {
                    item_id: "ev-log-1".into(),
                    privacy: PrivacyClass::ShareSafe,
                    capture_time: "2026-01-15T04:12:00Z".into(),
                    source: EvidenceSource {
                        reference: "app.log".into(),
                        captured_from: "fixture".into(),
                    },
                    media_type: "text/plain".into(),
                    format: "raw".into(),
                    content: HeldContent {
                        digest: ContentDigest::of_bytes(bytes),
                        byte_length: bytes.len() as u64,
                    },
                    summaries: vec![],
                    visible_to_strategies: true,
                },
                EvidenceItem::Log {
                    item_id: "ev-hidden-1".into(),
                    privacy: PrivacyClass::ShareSafe,
                    capture_time: "2026-01-15T04:12:00Z".into(),
                    source: EvidenceSource {
                        reference: "secret.log".into(),
                        captured_from: "fixture".into(),
                    },
                    media_type: "text/plain".into(),
                    format: "raw".into(),
                    content: HeldContent {
                        digest: ContentDigest::of_bytes(bytes),
                        byte_length: bytes.len() as u64,
                    },
                    summaries: vec![],
                    visible_to_strategies: true,
                },
            ],
            None,
        )
        .unwrap();
        (case, snapshot)
    }

    fn task_for(snapshot: &EvidenceSnapshot) -> crate::types::EvaluationTask {
        crate::types::EvaluationTask::from_parts(
            PrivacyClass::ShareSafe,
            snapshot.case_id.clone(),
            snapshot.snapshot_id.clone(),
            "What failed?".into(),
            "visible only".into(),
            "v1".into(),
            VisibilityPolicy {
                visible_item_ids: vec!["ev-log-1".into()],
                include_summaries: false,
                include_raw_bytes: true,
            },
            None,
            "2026-01-15T07:00:00Z".into(),
        )
        .unwrap()
    }

    #[test]
    fn widening_request_fails_closed() {
        let (case, snapshot) = case_and_snapshot();
        let task = task_for(&snapshot);
        let requested = vec!["ev-log-1".into(), "ev-hidden-1".into()];
        let err = materialize_visible_packet(
            &case,
            &snapshot,
            &task,
            VisibilityRequest {
                requested_item_ids: Some(&requested),
            },
        )
        .unwrap_err();
        assert!(
            err.to_string().contains("visibility widening rejected"),
            "{err}"
        );
    }

    #[test]
    fn subset_request_is_not_widening() {
        let (case, snapshot) = case_and_snapshot();
        let task = task_for(&snapshot);
        let requested = vec!["ev-log-1".into()];
        let packet = materialize_visible_packet(
            &case,
            &snapshot,
            &task,
            VisibilityRequest {
                requested_item_ids: Some(&requested),
            },
        )
        .unwrap();
        assert_eq!(packet.evidence.len(), 1);
        assert_eq!(packet.evidence[0].item_id, "ev-log-1");
    }
}
