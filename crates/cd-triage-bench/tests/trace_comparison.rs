//! Interaction-trace strategy comparison (hermetic, no providers).

use cd_triage_bench::gold::GoldReference;
use cd_triage_bench::trace::{compare_traces, extract_plain_transcript, InteractionTrace};
use cd_triage_bench::TEXTUAL_SIMILARITY_NOT_WINNER;

fn init_store(root: &std::path::Path) -> cd_triage_bench::BenchStore {
    cd_triage_bench::BenchStore::init(root, "2026-01-15T00:00:00Z").unwrap()
}

#[test]
fn store_is_insert_only_and_gold_convergence_is_not_correctness() {
    let dir = tempfile::tempdir().unwrap();
    let store = init_store(dir.path());
    let programmatic = InteractionTrace::parse_json(include_str!(
        "../../../collab/contracts/fixtures/interaction-trace.programmatic.json"
    ))
    .unwrap();
    store.put_trace(&programmatic).unwrap();
    store.put_trace(&programmatic).unwrap();
    let mut mutated = programmatic.clone();
    mutated.notes.push("mutation".into());
    assert!(store.put_trace(&mutated).is_err());

    let chat = InteractionTrace::parse_json(include_str!(
        "../../../collab/contracts/fixtures/interaction-trace.chat.json"
    ))
    .unwrap();
    store.put_trace(&chat).unwrap();
    let mut gold = GoldReference::parse_json(include_str!(
        "../../../collab/contracts/fixtures/gold-reference.valid.json"
    ))
    .unwrap();
    gold.task_fingerprint = "task-x".into();
    gold.snapshot_fingerprint = "snap-x".into();
    gold.case_id = "case-checkout-cascade".into();
    gold.validate().unwrap();
    let comparison = compare_traces(&store.load_traces().unwrap(), Some(&gold));
    assert!(comparison
        .gold_convergence
        .contains(&"ev-demo-checkout-log".into()));
    assert!(comparison
        .notes
        .iter()
        .any(|note| note == TEXTUAL_SIMILARITY_NOT_WINNER));
}

#[test]
fn incomplete_plain_text_stays_unknown() {
    let plain: serde_json::Value = serde_json::from_str(include_str!(
        "../../../collab/contracts/fixtures/plain-transcript.incomplete.json"
    ))
    .unwrap();
    let text = plain["text"].as_str().unwrap();
    let trace =
        extract_plain_transcript(text, "cand-chat-operator", "2026-08-19T00:00:00Z").unwrap();
    assert_eq!(trace.completeness, "unknown");
    assert!(trace.unknowns.iter().any(|item| item == "turns"));
}
