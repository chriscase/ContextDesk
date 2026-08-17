//! Preserve real `TriageReplayV1::validate` phase-order and terminal rules.

use cd_triage_sdk::{parse_replay_v1, TriageContractError, TRIAGE_REPLAY_SCHEMA_V1};
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
