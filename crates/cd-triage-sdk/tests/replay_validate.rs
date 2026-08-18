//! Preserve real `TriageReplayV1::validate` phase-order and terminal rules.

use cd_triage_sdk::{parse_replay_v1, TriageContractError, TRIAGE_REPLAY_SCHEMA_V1};
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/triage-sdk/v2")
}

#[test]
fn golden_partial_replay_validates() {
    let raw = fs::read_to_string(fixtures_dir().join("replay.partial.json")).unwrap();
    let replay = parse_replay_v1(&raw).expect("valid partial replay");
    assert_eq!(replay.schema_id, TRIAGE_REPLAY_SCHEMA_V1);
    replay.validate().unwrap();
}

#[test]
fn golden_cancelled_partial_replay_validates() {
    let raw = fs::read_to_string(fixtures_dir().join("replay.cancelled-partial.json")).unwrap();
    parse_replay_v1(&raw)
        .expect("cancelled partial is a valid terminal")
        .validate()
        .unwrap();
}

#[test]
fn golden_bad_order_is_rejected() {
    let raw = fs::read_to_string(fixtures_dir().join("replay.bad-order.invalid.json")).unwrap();
    assert_eq!(
        parse_replay_v1(&raw).unwrap_err(),
        TriageContractError::NonContiguousSequence
    );
}

#[test]
fn golden_event_after_terminal_is_rejected() {
    let raw =
        fs::read_to_string(fixtures_dir().join("replay.after-terminal.invalid.json")).unwrap();
    let err = parse_replay_v1(&raw).unwrap_err();
    assert!(
        matches!(
            err,
            TriageContractError::EventAfterTerminal | TriageContractError::TerminalCount(_)
        ),
        "{err:?}"
    );
}

fn pre_packet_replay(terminal: &str) -> Value {
    let terminal = match terminal {
        "failed" => json!({"kind": "failed", "category": "policy_preflight_rejected"}),
        "timed_out" => json!({"kind": "timed_out", "category": "deadline"}),
        "cancelled" => json!({"kind": "cancelled", "cancellation_id": "cancel:early"}),
        _ => unreachable!(),
    };
    let event = |sequence, event| {
        json!({
            "schema_id": "contextdesk.triage.run_event.v2",
            "run_id": "run:early",
            "sequence": sequence,
            "privacy": "owner_only",
            "event": event,
        })
    };
    json!({
        "schema_id": "contextdesk.triage.replay.v1",
        "run_id": "run:early",
        "request_fingerprint": "sha256:request:early",
        "events": [
            event(0, json!({
                "kind": "run_started",
                "request_fingerprint": "sha256:request:early",
                "policy_fingerprint": "sha256:policy:early",
            })),
            event(1, json!({
                "kind": "role_attempt",
                "attempt": {
                    "attempt_id": "attempt:early:observe",
                    "role_slot_id": "observe",
                    "role": {"contributor": "observation_extractor"},
                    "model": {"profile_id": "profile:one", "model_id": "model:one"},
                    "status": "not_admitted",
                    "reason_codes": ["policy_preflight_rejected"],
                    "elapsed_ms": 0,
                    "input_chars": 0,
                    "output_chars": 0,
                    "physical_provider_calls": 0,
                    "semantic_corrections": 0,
                    "terminal_disposition": "not_admitted"
                }
            })),
            event(2, json!({
                "kind": "role_attempt",
                "attempt": {
                    "attempt_id": "attempt:early:finalize",
                    "role_slot_id": "finalize",
                    "role": "finalizer",
                    "model": {"profile_id": "profile:two", "model_id": "model:two"},
                    "status": terminal_status(&terminal),
                    "reason_codes": [terminal_reason(&terminal)],
                    "elapsed_ms": 0,
                    "input_chars": 0,
                    "output_chars": 0,
                    "physical_provider_calls": 0,
                    "semantic_corrections": 0,
                    "terminal_disposition": terminal_status(&terminal)
                }
            })),
            event(3, terminal),
        ]
    })
}

fn terminal_status(terminal: &Value) -> &'static str {
    match terminal["kind"].as_str() {
        Some("timed_out") => "timed_out",
        Some("cancelled") => "cancelled",
        _ => "failed",
    }
}

fn terminal_reason(terminal: &Value) -> &'static str {
    match terminal["kind"].as_str() {
        Some("timed_out") => "deadline",
        Some("cancelled") => "cancelled",
        _ => "policy_preflight_rejected",
    }
}

fn parse_value(value: &Value) -> Result<cd_triage_sdk::TriageReplayV1, TriageContractError> {
    parse_replay_v1(&serde_json::to_string(value).unwrap())
}

#[test]
fn pre_packet_failure_cancel_and_deadline_replays_validate() {
    for terminal in ["failed", "timed_out", "cancelled"] {
        parse_value(&pre_packet_replay(terminal))
            .unwrap_or_else(|error| panic!("{terminal}: {error:?}"));
    }

    let mut unresolved = pre_packet_replay("failed");
    unresolved["events"].as_array_mut().unwrap().drain(1..3);
    unresolved["events"][1]["sequence"] = json!(1);
    parse_value(&unresolved).expect("a resolved request may fail before policy slots are known");
}

#[test]
fn pre_packet_path_rejects_packet_and_provider_work_lies() {
    let mut packet = pre_packet_replay("failed");
    packet["events"].as_array_mut().unwrap().insert(
        1,
        json!({
            "schema_id": "contextdesk.triage.run_event.v2",
            "run_id": "run:early",
            "sequence": 1,
            "privacy": "owner_only",
            "event": {
                "kind": "packet_ready",
                "packet_id": "packet:fabricated",
                "packet_digest": "sha256:fabricated",
                "evidence_count": 0
            }
        }),
    );
    for (sequence, event) in packet["events"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .enumerate()
    {
        event["sequence"] = json!(sequence);
    }
    assert_eq!(
        parse_value(&packet).unwrap_err(),
        TriageContractError::InvalidPhaseOrder
    );

    for (field, value) in [
        ("physical_provider_calls", json!(1)),
        ("semantic_corrections", json!(1)),
        ("input_chars", json!(1)),
        ("output_chars", json!(1)),
        ("elapsed_ms", json!(1)),
    ] {
        let mut replay = pre_packet_replay("failed");
        replay["events"][1]["event"]["attempt"][field] = value;
        assert!(parse_value(&replay).is_err(), "accepted nonzero {field}");
    }

    let mut completed = pre_packet_replay("failed");
    completed["events"][1]["event"]["attempt"]["status"] = json!("completed");
    completed["events"][1]["event"]["attempt"]["terminal_disposition"] = json!("completed");
    assert!(parse_value(&completed).is_err());
}

#[test]
fn pre_packet_path_rejects_duplicate_slots_and_partial_results() {
    let mut duplicate = pre_packet_replay("cancelled");
    duplicate["events"][2]["event"]["attempt"]["role_slot_id"] = json!("observe");
    assert!(parse_value(&duplicate).is_err());

    let full = serde_json::from_str::<Value>(
        &fs::read_to_string(fixtures_dir().join("replay.partial.json")).unwrap(),
    )
    .unwrap();
    let mut partial = pre_packet_replay("failed");
    let mut result = full["events"][5]["event"]["result"].clone();
    result["run_id"] = json!("run:early");
    partial["events"][3]["event"]["partial_result"] = result;
    assert_eq!(
        parse_value(&partial).unwrap_err(),
        TriageContractError::InvalidPhaseOrder
    );
}
