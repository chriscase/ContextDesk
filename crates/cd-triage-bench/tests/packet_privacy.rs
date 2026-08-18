//! Durable packet privacy is explicit, versioned, and monotonic.

mod common;

use cd_triage_bench::types::*;
use cd_triage_bench::{
    materialize_review_packet, materialize_task_packet, BenchError, ReviewPacket, ReviewPhase,
    TaskPacket,
};

fn task_for_privacy(snapshot: &EvidenceSnapshot, privacy: PrivacyClass) -> EvaluationTask {
    EvaluationTask::from_parts(
        privacy,
        snapshot.case_id.clone(),
        snapshot.snapshot_id.clone(),
        "What caused the checkout failures?".into(),
        "Use only visible evidence.".into(),
        "v1".into(),
        VisibilityPolicy {
            visible_item_ids: vec!["ev-log-1".into()],
            include_summaries: true,
            include_raw_bytes: true,
        },
        None,
        "2026-01-15T07:00:00Z".into(),
    )
    .unwrap()
}

#[test]
fn task_packet_uses_the_most_restrictive_label_from_every_source() {
    for owner_only_source in ["case", "snapshot", "task", "evidence"] {
        let mut case = common::resolved_case();
        case.privacy = if owner_only_source == "case" {
            PrivacyClass::OwnerOnly
        } else {
            PrivacyClass::ShareSafe
        };
        let mut items = common::four_kind_items();
        if owner_only_source == "evidence" {
            match &mut items[2] {
                EvidenceItem::Log { privacy, .. } => *privacy = PrivacyClass::OwnerOnly,
                other => panic!("expected log fixture, got {other:?}"),
            }
        }
        let snapshot = EvidenceSnapshot::from_parts(
            if owner_only_source == "snapshot" {
                PrivacyClass::OwnerOnly
            } else {
                PrivacyClass::ShareSafe
            },
            case.case_id.clone(),
            "2026-01-15T06:00:00Z".into(),
            "fixture-operator".into(),
            items,
            None,
        )
        .unwrap();
        let task = task_for_privacy(
            &snapshot,
            if owner_only_source == "task" {
                PrivacyClass::OwnerOnly
            } else {
                PrivacyClass::ShareSafe
            },
        );

        let packet = materialize_task_packet(&case, &snapshot, &task).unwrap();
        assert_eq!(
            packet.privacy,
            PrivacyClass::OwnerOnly,
            "owner-only {owner_only_source} must propagate"
        );
    }
}

#[test]
fn share_safe_task_packet_v2_round_trips_and_legacy_missing_privacy_is_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let store = common::init_store(dir.path());
    let case = common::resolved_case();
    store.put_case(&case).unwrap();
    let snapshot = common::snapshot_for(&store, &case.case_id);
    let task = common::task_for(&store, &snapshot);

    let packet = store.materialize_packet(&task.task_id).unwrap();
    assert_eq!(packet.schema_id, PACKET_SCHEMA_V2);
    assert_eq!(packet.privacy, PrivacyClass::ShareSafe);
    assert_eq!(store.get_packet(&packet.packet_id).unwrap(), packet);
    assert_eq!(
        TaskPacket::parse_json(&packet.to_json().unwrap()).unwrap(),
        packet
    );

    let persisted = std::fs::read_to_string(
        dir.path()
            .join("packets")
            .join(format!("{}.json", packet.packet_id)),
    )
    .unwrap();
    assert!(persisted.contains("\"privacy\": \"share_safe\""));

    let mut legacy: serde_json::Value = serde_json::from_str(&persisted).unwrap();
    legacy["schema_id"] = PACKET_SCHEMA_V1.into();
    legacy.as_object_mut().unwrap().remove("privacy");
    let error = TaskPacket::parse_json(&serde_json::to_string(&legacy).unwrap()).unwrap_err();
    assert!(error.to_string().contains("missing field `privacy`"));
}

#[test]
fn owner_only_selected_evidence_propagates_and_share_safe_task_is_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let store = common::init_store(dir.path());
    let case = common::resolved_case();
    store.put_case(&case).unwrap();
    store.put_blob(common::LOG_BYTES).unwrap();
    store.put_blob(common::EMAIL_BYTES).unwrap();
    store.put_blob(common::ATTACH_BYTES).unwrap();
    let mut items = common::four_kind_items();
    match &mut items[2] {
        EvidenceItem::Log { privacy, .. } => *privacy = PrivacyClass::OwnerOnly,
        other => panic!("expected log fixture, got {other:?}"),
    }
    let snapshot = EvidenceSnapshot::from_parts(
        PrivacyClass::ShareSafe,
        case.case_id.clone(),
        "2026-01-15T06:00:00Z".into(),
        "fixture-operator".into(),
        items,
        None,
    )
    .unwrap();
    store.put_snapshot(&snapshot).unwrap();

    let downgraded_task = task_for_privacy(&snapshot, PrivacyClass::ShareSafe);
    let derived = materialize_task_packet(&case, &snapshot, &downgraded_task).unwrap();
    assert_eq!(derived.privacy, PrivacyClass::OwnerOnly);
    assert!(matches!(
        store.put_task(&downgraded_task).unwrap_err(),
        BenchError::Privacy(_)
    ));

    let owner_task = task_for_privacy(&snapshot, PrivacyClass::OwnerOnly);
    store.put_task(&owner_task).unwrap();
    let packet = store.materialize_packet(&owner_task.task_id).unwrap();
    assert_eq!(packet.schema_id, PACKET_SCHEMA_V2);
    assert_eq!(packet.privacy, PrivacyClass::OwnerOnly);
    assert_eq!(store.get_packet(&packet.packet_id).unwrap(), packet);

    let mut forged = serde_json::to_value(&packet).unwrap();
    forged["privacy"] = serde_json::json!("share_safe");
    let error = TaskPacket::parse_json(&serde_json::to_string(&forged).unwrap()).unwrap_err();
    assert!(matches!(error, BenchError::Integrity(_)));
}

#[test]
fn review_packet_privacy_round_trips_and_owner_only_run_propagates() {
    let dir = tempfile::tempdir().unwrap();
    let store = common::init_store(dir.path());
    let case = common::resolved_case();
    store.put_case(&case).unwrap();
    let snapshot = common::snapshot_for(&store, &case.case_id);
    let task = common::task_for(&store, &snapshot);

    let share_run_id = common::import_named(
        &store,
        &task.task_id,
        SourceKind::Human,
        "share-safe-human",
        Observed::Unknown,
        "share-safe analysis",
        FairnessClass::SameSnapshot,
        RunStatus::Completed,
        "2026-01-15T08:00:00Z",
    );
    let share_packet = store
        .materialize_review_packet(&share_run_id, ReviewPhase::Support)
        .unwrap();
    assert_eq!(share_packet.schema_id, REVIEW_PACKET_SCHEMA_V2);
    assert_eq!(share_packet.privacy, PrivacyClass::ShareSafe);
    assert_eq!(
        store.get_review_packet(&share_packet.packet_id).unwrap(),
        share_packet
    );
    assert_eq!(
        ReviewPacket::parse_json(&share_packet.to_json().unwrap()).unwrap(),
        share_packet
    );

    let owner_run_id = common::import_named_with_privacy(
        &store,
        &task.task_id,
        SourceKind::Human,
        "private-human",
        Observed::Unknown,
        "private analysis",
        FairnessClass::SameSnapshot,
        RunStatus::Completed,
        PrivacyClass::OwnerOnly,
        "2026-01-15T08:01:00Z",
    );
    let owner_packet = store
        .materialize_review_packet(&owner_run_id, ReviewPhase::Support)
        .unwrap();
    assert_eq!(owner_packet.privacy, PrivacyClass::OwnerOnly);
    assert_eq!(
        store.get_review_packet(&owner_packet.packet_id).unwrap(),
        owner_packet
    );

    let persisted = std::fs::read_to_string(
        dir.path()
            .join("review-packets")
            .join(format!("{}.json", owner_packet.packet_id)),
    )
    .unwrap();
    assert!(persisted.contains("\"privacy\": \"owner_only\""));

    let mut forged = serde_json::to_value(&owner_packet).unwrap();
    forged["privacy"] = serde_json::json!("share_safe");
    let error = ReviewPacket::parse_json(&serde_json::to_string(&forged).unwrap()).unwrap_err();
    assert!(matches!(error, BenchError::Integrity(_)));

    let mut legacy: serde_json::Value = serde_json::from_str(&persisted).unwrap();
    legacy["schema_id"] = REVIEW_PACKET_SCHEMA_V1.into();
    legacy.as_object_mut().unwrap().remove("privacy");
    let error = ReviewPacket::parse_json(&serde_json::to_string(&legacy).unwrap()).unwrap_err();
    assert!(error.to_string().contains("missing field `privacy`"));

    let downgraded = Adjudication::from_parts(
        PrivacyClass::ShareSafe,
        case.case_id,
        task.task_id,
        snapshot.snapshot_id,
        owner_run_id,
        "reviewer-a".into(),
        ConflictOfInterest {
            declared: false,
            notes: None,
        },
        RUBRIC_V1.into(),
        ReviewPhase::Support,
        owner_packet.blinding.clone(),
        common::outcomes(
            DimensionVerdict::NotApplicable,
            DimensionVerdict::Score { value: 2 },
            DimensionVerdict::Score { value: 2 },
            DimensionVerdict::Score { value: 2 },
            DimensionVerdict::Score { value: 2 },
        ),
        "2026-01-15T10:00:00Z".into(),
    )
    .unwrap()
    .bind_review_packet(owner_packet.packet_id)
    .unwrap();
    assert!(matches!(
        store.put_adjudication(&downgraded).unwrap_err(),
        BenchError::Privacy(_)
    ));
}

#[test]
fn unverifiable_review_raw_output_fails_closed() {
    let dir = tempfile::tempdir().unwrap();
    let store = common::init_store(dir.path());
    let case = common::resolved_case();
    store.put_case(&case).unwrap();
    let snapshot = common::snapshot_for(&store, &case.case_id);
    let task = common::task_for(&store, &snapshot);
    let run_id = common::import_named(
        &store,
        &task.task_id,
        SourceKind::Human,
        "human",
        Observed::Unknown,
        "verified raw output",
        FairnessClass::SameSnapshot,
        RunStatus::Completed,
        "2026-01-15T08:00:00Z",
    );
    let run = store.get_run(&run_id).unwrap();

    let error = materialize_review_packet(
        &case,
        &snapshot,
        &task,
        &run,
        b"different raw output",
        ReviewPhase::Support,
        false,
    )
    .unwrap_err();
    assert!(matches!(error, BenchError::Integrity(_)));
    assert!(error.to_string().contains("verified digest"));
}
