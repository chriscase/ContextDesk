//! Task packet materialization. Resolution is excluded by construction.

use crate::canonical::to_canonical_json;
use crate::error::{BenchError, BenchResult};
use crate::types::{
    sha256_hex, AttributedSummary, Case, ContentDigest, EvaluationTask, EvidenceItem,
    EvidenceSnapshot, HeldContent, PrivacyClass, TimeConstraint, MAX_STRING_BYTES,
    PACKET_SCHEMA_V2,
};
use serde::{Deserialize, Serialize};

/// Strategy-visible evidence. No evaluation-only fields exist on this type.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VisibleEvidence {
    pub item_id: String,
    pub kind: String,
    pub capture_time: String,
    pub source_reference: String,
    pub source_captured_from: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uri: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<HeldContent>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_content_digest: Option<ContentDigest>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verification: Option<String>,
    #[serde(default)]
    pub summaries: Vec<AttributedSummary>,
}

/// Frozen packet a strategy is allowed to see for one task.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TaskPacket {
    pub schema_id: String,
    pub packet_id: String,
    pub privacy: PrivacyClass,
    pub task_id: String,
    pub snapshot_id: String,
    pub case_id: String,
    pub question: String,
    pub protocol: String,
    pub protocol_version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time_constraint: Option<TimeConstraint>,
    pub evidence: Vec<VisibleEvidence>,
}

impl TaskPacket {
    pub fn parse_json(text: &str) -> BenchResult<Self> {
        let parsed: Self = serde_json::from_str(text).map_err(BenchError::from_serde)?;
        parsed.validate()?;
        Ok(parsed)
    }

    pub fn to_json(&self) -> BenchResult<String> {
        crate::canonical::to_pretty_json(self)
    }

    pub fn validate(&self) -> BenchResult<()> {
        if self.schema_id != PACKET_SCHEMA_V2 {
            return Err(BenchError::Schema(format!(
                "task packet schema must be {PACKET_SCHEMA_V2}, got {}; v1 packets must be regenerated from their source records",
                self.schema_id
            )));
        }
        crate::types::validate_id("packet_id", &self.packet_id)?;
        crate::types::validate_id("task_id", &self.task_id)?;
        crate::types::validate_id("snapshot_id", &self.snapshot_id)?;
        crate::types::validate_id("case_id", &self.case_id)?;
        crate::types::validate_bounded_string("question", &self.question, MAX_STRING_BYTES)?;
        crate::types::validate_bounded_string("protocol", &self.protocol, MAX_STRING_BYTES)?;
        crate::types::validate_bounded_string(
            "protocol_version",
            &self.protocol_version,
            MAX_STRING_BYTES,
        )?;
        if let Some(constraint) = &self.time_constraint {
            constraint.validate()?;
        }
        assert_packet_excludes_resolution(self)?;
        let expected = format!(
            "pkt-{}",
            sha256_hex(to_canonical_json(&packet_digest_body(self))?.as_bytes())
        );
        if self.packet_id != expected {
            return Err(BenchError::Integrity(format!(
                "task packet id does not match content digest (expected {expected})"
            )));
        }
        Ok(())
    }
}

/// Materialize a packet from a case + snapshot + task. The case resolution
/// section is structurally absent from [`TaskPacket`].
pub fn materialize_task_packet(
    case: &Case,
    snapshot: &EvidenceSnapshot,
    task: &EvaluationTask,
) -> BenchResult<TaskPacket> {
    case.validate()?;
    snapshot.validate()?;
    task.validate()?;
    if task.case_id != case.case_id {
        return Err(BenchError::Schema(
            "task.case_id does not match the loaded case".into(),
        ));
    }
    if task.snapshot_id != snapshot.snapshot_id {
        return Err(BenchError::CrossSnapshot(format!(
            "task {} is bound to snapshot {}, not {}",
            task.task_id, task.snapshot_id, snapshot.snapshot_id
        )));
    }
    if snapshot.case_id != case.case_id {
        return Err(BenchError::Schema(
            "snapshot.case_id does not match the loaded case".into(),
        ));
    }

    let mut privacy = case
        .privacy
        .restrict_with(snapshot.privacy)
        .restrict_with(task.privacy);
    let mut evidence = Vec::new();
    for item_id in &task.visibility.visible_item_ids {
        let item = snapshot.item(item_id).ok_or_else(|| {
            BenchError::Schema(format!(
                "visible item {item_id} is not present in snapshot {}",
                snapshot.snapshot_id
            ))
        })?;
        if !item.visible_to_strategies() {
            return Err(BenchError::Schema(format!(
                "item {item_id} is marked not visible to strategies"
            )));
        }
        privacy = privacy.restrict_with(item.privacy());
        evidence.push(visible_item(item, task.visibility.include_summaries));
    }

    let mut packet = TaskPacket {
        schema_id: PACKET_SCHEMA_V2.into(),
        packet_id: String::new(),
        privacy,
        task_id: task.task_id.clone(),
        snapshot_id: task.snapshot_id.clone(),
        case_id: task.case_id.clone(),
        question: task.question.clone(),
        protocol: task.protocol.clone(),
        protocol_version: task.protocol_version.clone(),
        time_constraint: task.time_constraint.clone(),
        evidence,
    };
    packet.packet_id = format!(
        "pkt-{}",
        sha256_hex(to_canonical_json(&packet_digest_body(&packet))?.as_bytes())
    );
    packet.validate()?;
    Ok(packet)
}

#[derive(Serialize)]
struct PacketDigestBody<'a> {
    schema_id: &'a str,
    privacy: PrivacyClass,
    task_id: &'a str,
    snapshot_id: &'a str,
    case_id: &'a str,
    question: &'a str,
    protocol: &'a str,
    protocol_version: &'a str,
    time_constraint: &'a Option<TimeConstraint>,
    evidence: &'a [VisibleEvidence],
}

fn packet_digest_body(packet: &TaskPacket) -> PacketDigestBody<'_> {
    PacketDigestBody {
        schema_id: &packet.schema_id,
        privacy: packet.privacy,
        task_id: &packet.task_id,
        snapshot_id: &packet.snapshot_id,
        case_id: &packet.case_id,
        question: &packet.question,
        protocol: &packet.protocol,
        protocol_version: &packet.protocol_version,
        time_constraint: &packet.time_constraint,
        evidence: &packet.evidence,
    }
}

fn visible_item(item: &EvidenceItem, include_summaries: bool) -> VisibleEvidence {
    let summaries = if include_summaries {
        item.summaries().to_vec()
    } else {
        Vec::new()
    };
    match item {
        EvidenceItem::Log {
            item_id,
            capture_time,
            source,
            media_type,
            format,
            content,
            ..
        } => VisibleEvidence {
            item_id: item_id.clone(),
            kind: "log".into(),
            capture_time: capture_time.clone(),
            source_reference: source.reference.clone(),
            source_captured_from: source.captured_from.clone(),
            media_type: Some(media_type.clone()),
            format: Some(format.clone()),
            filename: None,
            uri: None,
            content: Some(content.clone()),
            expected_content_digest: None,
            verification: None,
            summaries,
        },
        EvidenceItem::Email {
            item_id,
            capture_time,
            source,
            media_type,
            content,
            ..
        } => VisibleEvidence {
            item_id: item_id.clone(),
            kind: "email".into(),
            capture_time: capture_time.clone(),
            source_reference: source.reference.clone(),
            source_captured_from: source.captured_from.clone(),
            media_type: Some(media_type.clone()),
            format: None,
            filename: None,
            uri: None,
            content: Some(content.clone()),
            expected_content_digest: None,
            verification: None,
            summaries,
        },
        EvidenceItem::Attachment {
            item_id,
            capture_time,
            source,
            media_type,
            filename,
            content,
            ..
        } => VisibleEvidence {
            item_id: item_id.clone(),
            kind: "attachment".into(),
            capture_time: capture_time.clone(),
            source_reference: source.reference.clone(),
            source_captured_from: source.captured_from.clone(),
            media_type: Some(media_type.clone()),
            format: None,
            filename: Some(filename.clone()),
            uri: None,
            content: Some(content.clone()),
            expected_content_digest: None,
            verification: None,
            summaries,
        },
        EvidenceItem::ExternalFileServerReference {
            item_id,
            capture_time,
            source,
            uri,
            expected_content_digest,
            verification,
            ..
        } => VisibleEvidence {
            item_id: item_id.clone(),
            kind: "external_file_server_reference".into(),
            capture_time: capture_time.clone(),
            source_reference: source.reference.clone(),
            source_captured_from: source.captured_from.clone(),
            media_type: None,
            format: None,
            filename: None,
            uri: Some(uri.clone()),
            content: None,
            expected_content_digest: expected_content_digest.clone(),
            verification: Some(verification.as_str().into()),
            summaries,
        },
    }
}

fn assert_packet_excludes_resolution(packet: &TaskPacket) -> BenchResult<()> {
    let json = serde_json::to_string(packet).map_err(BenchError::from_serde)?;
    for forbidden in [
        "adjudicated_root_cause",
        "domain_expertise",
        "\"resolution\"",
        "evaluation_only",
    ] {
        if json.contains(forbidden) {
            return Err(BenchError::Integrity(format!(
                "task packet leaked evaluation-only field {forbidden}"
            )));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{
        Case, CaseLifecycle, CaseResolution, ContentDigest, EvidenceSource, HeldContent,
        PrivacyClass, ReportedProblem, VerificationStatus, VisibilityPolicy,
    };

    fn fixture_case(resolution: Option<CaseResolution>) -> Case {
        Case {
            schema_id: crate::types::CASE_SCHEMA_V1.into(),
            case_id: "case-1".into(),
            privacy: PrivacyClass::OwnerOnly,
            title: "Checkout errors".into(),
            reported_problem: ReportedProblem {
                summary: "checkout 500s".into(),
                reported_at: None,
                reporter: None,
                symptoms: vec![],
            },
            lifecycle: if resolution
                .as_ref()
                .is_some_and(CaseResolution::has_root_cause)
            {
                CaseLifecycle::Resolved
            } else {
                CaseLifecycle::Unresolved
            },
            timeline_notes: vec![],
            created_at: "2026-01-15T00:00:00Z".into(),
            resolution,
        }
    }

    fn fixture_snapshot() -> EvidenceSnapshot {
        let bytes = b"error\n";
        EvidenceSnapshot::from_parts(
            PrivacyClass::OwnerOnly,
            "case-1".into(),
            "2026-01-15T06:00:00Z".into(),
            "operator".into(),
            vec![
                EvidenceItem::Log {
                    item_id: "ev-log-1".into(),
                    privacy: PrivacyClass::OwnerOnly,
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
                EvidenceItem::ExternalFileServerReference {
                    item_id: "ev-ref-1".into(),
                    privacy: PrivacyClass::OwnerOnly,
                    capture_time: "2026-01-15T04:12:00Z".into(),
                    source: EvidenceSource {
                        reference: "fileserver://archives/dump.bin".into(),
                        captured_from: "ticket".into(),
                    },
                    uri: "fileserver://archives/dump.bin".into(),
                    expected_content_digest: None,
                    verification: VerificationStatus::Unverified,
                    summaries: vec![],
                    visible_to_strategies: true,
                },
            ],
            None,
        )
        .unwrap()
    }

    #[test]
    fn packet_excludes_resolution_even_when_case_has_one() {
        let case = fixture_case(Some(CaseResolution {
            adjudicated_root_cause: Some("inventory timeout".into()),
            fix: Some("raise timeout".into()),
            domain_expertise: Some("known flaky SKU service".into()),
            notes: Some("do not show to strategies".into()),
        }));
        let snapshot = fixture_snapshot();
        let task = EvaluationTask::from_parts(
            PrivacyClass::OwnerOnly,
            case.case_id.clone(),
            snapshot.snapshot_id.clone(),
            "What failed?".into(),
            "Use only visible evidence.".into(),
            "v1".into(),
            VisibilityPolicy {
                visible_item_ids: vec!["ev-log-1".into(), "ev-ref-1".into()],
                include_summaries: true,
                include_raw_bytes: true,
            },
            None,
            "2026-01-15T07:00:00Z".into(),
        )
        .unwrap();
        let packet = materialize_task_packet(&case, &snapshot, &task).unwrap();
        let json = serde_json::to_string(&packet).unwrap();
        assert!(!json.contains("inventory timeout"));
        assert!(!json.contains("adjudicated_root_cause"));
        assert!(!json.contains("domain_expertise"));
        assert!(!json.contains("resolution"));
        assert_eq!(packet.evidence.len(), 2);
    }
}
