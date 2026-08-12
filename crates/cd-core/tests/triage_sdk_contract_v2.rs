use std::fs;
use std::path::PathBuf;

use cd_core::extension_contract::PacketPrivacyBoundary;
use cd_core::investigation_answer::{
    AnswerBindingV1, AnswerEnvelopeV1, EvidenceRole, HostEvidenceEntry, InvestigationAnswerV1,
    LogSnapshotRevisionV1, SCHEMA_V1,
};
use cd_core::triage_sdk::*;

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/triage-sdk/v2")
}

fn request() -> TriageRequestV2 {
    TriageRequestV2 {
        schema_id: TRIAGE_REQUEST_SCHEMA_V2.into(),
        run_id: "run:golden:01".into(),
        privacy: PacketPrivacyBoundary::OwnerOnly,
        task: "Find the initiating cause and keep downstream symptoms separate.".into(),
        scope: TriageScopeV1 {
            corpus_id: "corpus:demo:01".into(),
            corpus_revision: Some(63),
            source_ids: vec!["source:edm".into()],
        },
        policy: TriagePolicySelectionV2::Standard {
            model: ModelRef {
                profile_id: "profile:primary".into(),
                model_id: "model:catalog:exact".into(),
            },
        },
        overrides: TriageRequestOverridesV1 {
            deadline_ms: Some(600_000),
            max_provider_calls: Some(3),
        },
        cancellation_id: "cancel:golden:01".into(),
    }
}

fn reconciliation() -> TriageReconciliationV1 {
    TriageReconciliationV1 {
        state: "insufficient_evidence".into(),
        configured_role_slots: 2,
        completed_role_slots: 1,
        distinct_models: 1,
        distinct_gateways: 1,
        supported_claim_ids: vec!["claim:01".into()],
        conflict_ids: vec![],
        gap_ids: vec!["gap:missing-change".into()],
        root_cause_established: false,
    }
}

fn partial_result() -> TriageResultV2 {
    TriageResultV2 {
        schema_id: TRIAGE_RESULT_SCHEMA_V2.into(),
        run_id: "run:golden:01".into(),
        kind: TriageResultKind::HonestPartial,
        validation_state: TriageValidationState::Partial,
        packet_id: "packet:golden:01".into(),
        reconciliation: reconciliation(),
        answer: None,
        accepted_evidence_ids: vec!["evidence:01".into(), "evidence:02".into()],
        reason_codes: vec!["required_role_timed_out".into()],
    }
}

fn partial_answer() -> AnswerEnvelopeV1 {
    let revision = LogSnapshotRevisionV1 {
        event_revision: 63,
        template_analysis_revision: 4,
        suppression_revision: 2,
    };
    AnswerEnvelopeV1 {
        binding: AnswerBindingV1 {
            session_id: "session:01".into(),
            turn_id: "run:golden:01".into(),
            corpus_id: "corpus:demo:01".into(),
            revision,
            ledger_digest: "sha256:ledger:01".into(),
        },
        evidence: vec![HostEvidenceEntry {
            evidence_id: "evidence:01".into(),
            candidate_id: "candidate:01".into(),
            source_label: "demo.log".into(),
            locator: "seq:1".into(),
            corpus_id: "corpus:demo:01".into(),
            revision,
            role: EvidenceRole::Supporting,
            content: "bounded host-authored deterministic floor".into(),
        }],
        answer: InvestigationAnswerV1 {
            schema: SCHEMA_V1.into(),
            candidates: vec![],
            canonical_citations: vec![],
            root_cause_established: false,
        },
        semantic_attempts: 0,
    }
}

fn event(sequence: u64, event: TriageRunEventPayloadV2) -> TriageRunEventV2 {
    TriageRunEventV2 {
        schema_id: TRIAGE_RUN_EVENT_SCHEMA_V2.into(),
        run_id: "run:golden:01".into(),
        sequence,
        privacy: PacketPrivacyBoundary::OwnerOnly,
        event,
    }
}

fn replay() -> TriageReplayV1 {
    TriageReplayV1 {
        schema_id: TRIAGE_REPLAY_SCHEMA_V1.into(),
        run_id: "run:golden:01".into(),
        request_fingerprint: "sha256:request:01".into(),
        events: vec![
            event(
                0,
                TriageRunEventPayloadV2::RunStarted {
                    request_fingerprint: "sha256:request:01".into(),
                    policy_fingerprint: "sha256:policy:01".into(),
                },
            ),
            event(
                1,
                TriageRunEventPayloadV2::PacketReady {
                    packet_id: "packet:golden:01".into(),
                    packet_digest: "sha256:packet:01".into(),
                    evidence_count: 2,
                },
            ),
            event(
                2,
                TriageRunEventPayloadV2::RoleAttempt {
                    attempt: TriageRoleAttemptV1 {
                        attempt_id: "attempt:01".into(),
                        role_slot_id: "slot:causal:01".into(),
                        role: "causal_proposer".into(),
                        model: Some(ModelRef {
                            profile_id: "profile:primary".into(),
                            model_id: "model:catalog:exact".into(),
                        }),
                        status: TriageAttemptStatus::Completed,
                        reason_codes: vec![],
                        elapsed_ms: 24_360,
                        input_chars: 3_612,
                        output_chars: 812,
                    },
                },
            ),
            event(
                3,
                TriageRunEventPayloadV2::Reconciliation {
                    summary: reconciliation(),
                },
            ),
            event(
                4,
                TriageRunEventPayloadV2::Validation {
                    passed: false,
                    reason_codes: vec!["required_role_timed_out".into()],
                },
            ),
            event(
                5,
                TriageRunEventPayloadV2::Completed {
                    result: Box::new(partial_result()),
                },
            ),
        ],
    }
}

#[test]
fn request_and_replay_goldens_are_exact_rust_serializations() {
    request().validate().unwrap();
    replay().validate().unwrap();

    let expected_request = fs::read_to_string(fixtures_dir().join("request.standard.json"))
        .expect("committed request golden");
    let expected_replay = fs::read_to_string(fixtures_dir().join("replay.partial.json"))
        .expect("committed replay golden");
    assert_eq!(
        format!("{}\n", serde_json::to_string_pretty(&request()).unwrap()),
        expected_request
    );
    assert_eq!(
        format!("{}\n", serde_json::to_string_pretty(&replay()).unwrap()),
        expected_replay
    );
}

#[test]
fn invalid_goldens_are_rust_serialized_mutations_and_fail_closed() {
    let unknown = fs::read_to_string(fixtures_dir().join("request.unknown-version.invalid.json"))
        .expect("unknown version golden");
    assert!(matches!(
        parse_request_v2(&unknown),
        Err(TriageContractError::UnknownSchema { .. })
    ));

    let order = fs::read_to_string(fixtures_dir().join("replay.bad-order.invalid.json"))
        .expect("bad order golden");
    assert_eq!(
        parse_replay_v1(&order),
        Err(TriageContractError::NonContiguousSequence)
    );

    let terminal = fs::read_to_string(fixtures_dir().join("replay.after-terminal.invalid.json"))
        .expect("after terminal golden");
    assert_eq!(
        parse_replay_v1(&terminal),
        Err(TriageContractError::EventAfterTerminal)
    );
}

#[test]
fn jsonl_is_the_exact_ordered_event_stream() {
    let replay = replay();
    let jsonl = replay
        .events
        .iter()
        .map(|item| serde_json::to_string(item).unwrap())
        .collect::<Vec<_>>()
        .join("\n");
    let decoded = jsonl
        .lines()
        .map(|line| parse_event_v2(line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(decoded, replay.events);
}

#[test]
fn unknown_versions_fail_before_payload_deserialization() {
    let mut value = serde_json::to_value(request()).unwrap();
    value["schema_id"] = "contextdesk.triage.request.v99".into();
    assert!(matches!(
        parse_request_v2(&value.to_string()),
        Err(TriageContractError::UnknownSchema { .. })
    ));
}

#[test]
fn replay_requires_contiguous_order_and_exactly_one_last_terminal() {
    let mut missing = replay();
    missing.events[2].sequence = 7;
    assert_eq!(
        missing.validate(),
        Err(TriageContractError::NonContiguousSequence)
    );

    let mut no_terminal = replay();
    no_terminal.events.pop();
    assert_eq!(
        no_terminal.validate(),
        Err(TriageContractError::TerminalCount(0))
    );

    let mut after_terminal = replay();
    after_terminal.events.push(event(
        6,
        TriageRunEventPayloadV2::Failed {
            category: "should_not_exist".into(),
        },
    ));
    assert_eq!(
        after_terminal.validate(),
        Err(TriageContractError::EventAfterTerminal)
    );
}

#[test]
fn replay_binds_the_first_started_event_to_the_request_fingerprint() {
    let mut wrong_first = replay();
    wrong_first.events.remove(0);
    for (sequence, event) in wrong_first.events.iter_mut().enumerate() {
        event.sequence = sequence as u64;
    }
    assert_eq!(
        wrong_first.validate(),
        Err(TriageContractError::MissingRunStarted)
    );

    let mut wrong_fingerprint = replay();
    wrong_fingerprint.request_fingerprint = "sha256:different".into();
    assert_eq!(
        wrong_fingerprint.validate(),
        Err(TriageContractError::RequestFingerprintMismatch)
    );
}

#[test]
fn share_safe_projection_drops_the_authoritative_answer_and_scans_metadata() {
    let safe = partial_result().share_safe_summary();
    safe.validate().unwrap();
    let encoded = serde_json::to_string(&safe).unwrap();
    assert!(!encoded.contains("answer"));
    assert!(!encoded.contains("content"));

    let mut leak = safe;
    leak.reason_codes.push("api_key".into());
    assert_eq!(leak.validate(), Err(TriageContractError::PrivacyLeak));
}

#[test]
fn honest_partial_may_carry_a_host_authored_non_root_answer_floor() {
    let mut partial = partial_result();
    partial.accepted_evidence_ids = vec!["evidence:01".into()];
    partial.answer = Some(partial_answer());
    partial.validate().unwrap();

    partial
        .answer
        .as_mut()
        .unwrap()
        .answer
        .root_cause_established = true;
    assert_eq!(
        partial.validate(),
        Err(TriageContractError::InvalidField("partial_root_cause"))
    );
}

#[test]
fn attempt_and_reconciliation_mutations_fail_closed() {
    let mut bad_role_replay = replay();
    let TriageRunEventPayloadV2::RoleAttempt { attempt } = &mut bad_role_replay.events[2].event
    else {
        panic!("fixture attempt")
    };
    attempt.role = "invented_role".into();
    assert_eq!(
        bad_role_replay.validate(),
        Err(TriageContractError::InvalidField("role"))
    );

    let mut bad_count_replay = replay();
    let TriageRunEventPayloadV2::Reconciliation { summary } = &mut bad_count_replay.events[3].event
    else {
        panic!("fixture reconciliation")
    };
    summary.completed_role_slots = summary.configured_role_slots + 1;
    assert_eq!(
        bad_count_replay.validate(),
        Err(TriageContractError::InvalidField("reconciliation_counts"))
    );

    let mut duplicate_gap_replay = replay();
    let TriageRunEventPayloadV2::Reconciliation { summary } =
        &mut duplicate_gap_replay.events[3].event
    else {
        panic!("fixture reconciliation")
    };
    summary.gap_ids = vec!["same".into(), "same".into()];
    assert_eq!(
        duplicate_gap_replay.validate(),
        Err(TriageContractError::InvalidField("gap_ids"))
    );
}

#[test]
fn share_safe_role_attempt_cannot_expose_exact_model_identity() {
    let mut attempt = replay().events[2].clone();
    attempt.privacy = PacketPrivacyBoundary::ShareSafe;
    assert_eq!(attempt.validate(), Err(TriageContractError::PrivacyLeak));
}

#[test]
fn declared_share_safe_events_cannot_embed_owner_only_terminal_results() {
    let mut terminal = replay().events.pop().unwrap();
    terminal.privacy = PacketPrivacyBoundary::ShareSafe;
    assert_eq!(terminal.validate(), Err(TriageContractError::PrivacyLeak));
}

#[test]
fn cancellation_is_identity_only_and_versioned() {
    let cancel = TriageCancellationV1 {
        schema_id: TRIAGE_CANCELLATION_SCHEMA_V1.into(),
        run_id: "run:golden:01".into(),
        cancellation_id: "cancel:golden:01".into(),
    };
    cancel.validate().unwrap();
    let encoded = serde_json::to_string(&cancel).unwrap();
    assert_eq!(parse_cancellation_v1(&encoded).unwrap(), cancel);
    assert!(!encoded.contains("model"));
    assert!(!encoded.contains("provider"));
}

#[test]
#[ignore = "regenerates committed Rust-owned contract fixtures"]
fn regenerate_goldens() {
    fs::create_dir_all(fixtures_dir()).unwrap();
    fs::write(
        fixtures_dir().join("request.standard.json"),
        format!("{}\n", serde_json::to_string_pretty(&request()).unwrap()),
    )
    .unwrap();
    fs::write(
        fixtures_dir().join("replay.partial.json"),
        format!("{}\n", serde_json::to_string_pretty(&replay()).unwrap()),
    )
    .unwrap();

    let mut unknown = serde_json::to_value(request()).unwrap();
    unknown["schema_id"] = "contextdesk.triage.request.v99".into();
    fs::write(
        fixtures_dir().join("request.unknown-version.invalid.json"),
        format!("{}\n", serde_json::to_string_pretty(&unknown).unwrap()),
    )
    .unwrap();

    let mut bad_order = replay();
    bad_order.events[2].sequence = 7;
    fs::write(
        fixtures_dir().join("replay.bad-order.invalid.json"),
        format!("{}\n", serde_json::to_string_pretty(&bad_order).unwrap()),
    )
    .unwrap();

    let mut after_terminal = replay();
    after_terminal.events.push(event(
        6,
        TriageRunEventPayloadV2::Failed {
            category: "second_terminal".into(),
        },
    ));
    fs::write(
        fixtures_dir().join("replay.after-terminal.invalid.json"),
        format!(
            "{}\n",
            serde_json::to_string_pretty(&after_terminal).unwrap()
        ),
    )
    .unwrap();
}
