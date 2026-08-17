//! Existing `cd_core::triage_sdk` / `cd_core::model_ref` paths stay the public API.

use cd_core::extension_contract::PacketPrivacyBoundary;
use cd_core::investigation_answer::AnswerEnvelopeV1;
use cd_core::model_ref::ModelRef;
use cd_core::multi_model::triage_policy::{TriageContributorRole, TriageSlotKindV2};
use cd_core::triage_sdk::{parse_replay_v1, TriageReplayV1, TRIAGE_REPLAY_SCHEMA_V1};

#[test]
fn reexports_are_the_contract_crate_types() {
    fn same_model(_: cd_triage_sdk::ModelRef) {}
    fn same_replay(_: cd_triage_sdk::TriageReplayV1) {}
    fn same_privacy(_: cd_triage_sdk::PacketPrivacyBoundary) {}
    fn same_slot(_: cd_triage_sdk::TriageSlotKindV2) {}
    fn same_answer(_: cd_triage_sdk::AnswerEnvelopeV1) {}

    same_model(ModelRef {
        profile_id: "profile:primary".into(),
        model_id: "model:catalog".into(),
    });
    same_privacy(PacketPrivacyBoundary::OwnerOnly);
    same_slot(TriageSlotKindV2::Contributor(
        TriageContributorRole::ObservationExtractor,
    ));
    same_replay(TriageReplayV1 {
        schema_id: TRIAGE_REPLAY_SCHEMA_V1.into(),
        run_id: "run:compat".into(),
        request_fingerprint: "request:compat".into(),
        events: vec![],
    });
    same_answer(AnswerEnvelopeV1 {
        binding: cd_core::investigation_answer::AnswerBindingV1 {
            session_id: "session:compat".into(),
            turn_id: "turn:compat".into(),
            corpus_id: "corpus:compat".into(),
            revision: cd_core::investigation_answer::LogSnapshotRevisionV1 {
                event_revision: 1,
                template_analysis_revision: 1,
                suppression_revision: 1,
            },
            ledger_digest: "digest:compat".into(),
        },
        evidence: vec![],
        answer: cd_core::investigation_answer::InvestigationAnswerV1 {
            schema: cd_core::investigation_answer::SCHEMA_V1.into(),
            candidates: vec![],
            canonical_citations: vec![],
            root_cause_established: false,
        },
        semantic_attempts: 0,
    });
}

#[test]
fn parse_replay_v1_path_is_unchanged() {
    let raw = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../fixtures/triage-sdk/v2/replay.partial.json"
    ))
    .unwrap();
    parse_replay_v1(&raw).unwrap().validate().unwrap();
}
