//! Gold-reference backtest: alignment is independent of helpfulness.

mod common;

use cd_triage_bench::gold::{GoldAlignmentStatus, GoldReference, GOLD_ALIGNMENT_NOT_CORRECTNESS};
use cd_triage_bench::privacy::gate_share_safe_text;
use cd_triage_bench::report::{build_report, build_report_with_gold, ScoreVisibility};
use cd_triage_bench::types::*;
use cd_triage_bench::{import_run, ImportOutcome, GOLD_IS_HUMAN_BENCHMARK};
use common::*;
use std::collections::BTreeMap;

fn import_with_claims(
    store: &cd_triage_bench::BenchStore,
    task_id: &str,
    name: &str,
    raw: &str,
    claims: Vec<ClaimedCitation>,
    created_at: &str,
) -> String {
    let document = RunImport {
        schema_id: RUN_IMPORT_SCHEMA_V1.into(),
        task_id: task_id.into(),
        strategy: StrategyIdentity {
            name: name.into(),
            version: Observed::Known("synth".into()),
            build: Observed::Unknown,
        },
        source_kind: SourceKind::Human,
        prompt_workflow: PromptWorkflow {
            completeness: Completeness::Unknown,
            prompt: Observed::Unknown,
            workflow: Observed::Unknown,
        },
        raw_output_utf8: Some(raw.into()),
        claims,
        timing: Observed::Unknown,
        cost: Observed::Unknown,
        uncertainty: Observed::Unknown,
        fairness: FairnessClass::SameSnapshot,
        status: RunStatus::Completed,
        operator: "operator-a".into(),
        importer: Some("importer-b".into()),
        privacy: PrivacyClass::ShareSafe,
        created_at: created_at.into(),
    };
    match import_run(store, &document, raw.as_bytes()).unwrap() {
        ImportOutcome::Created { run_id, .. } | ImportOutcome::Duplicate { run_id } => run_id,
    }
}

fn claim(evidence: &str) -> ClaimedCitation {
    ClaimedCitation {
        claim: format!("cited {evidence}"),
        evidence_item_id: Some(evidence.into()),
        locator: None,
    }
}

#[test]
fn no_gold_report_keeps_v2_shape() {
    let dir = tempfile::tempdir().unwrap();
    let store = init_store(dir.path());
    let case = resolved_case();
    store.put_case(&case).unwrap();
    let snapshot = snapshot_for(&store, &case.case_id);
    let task = task_for(&store, &snapshot);
    let _run = import_named(
        &store,
        &task.task_id,
        SourceKind::Human,
        "no-gold-human",
        Observed::Known("1.0".into()),
        HUMAN_RAW,
        FairnessClass::SameSnapshot,
        RunStatus::Completed,
        "2026-01-15T08:00:00Z",
    );
    let report = build_report(
        &store.load_runs().unwrap(),
        &store.load_adjudications().unwrap(),
        &store.load_scores().unwrap(),
        &store.load_cases().unwrap(),
        PrivacyClass::ShareSafe,
    )
    .unwrap();
    let json = serde_json::to_string(&report).unwrap();
    assert!(!json.contains("gold_alignment"), "{json}");
    assert!(!json.contains("human_acceptance"), "{json}");
    assert!(!json.contains(GOLD_IS_HUMAN_BENCHMARK));
    assert_eq!(report.groups[0].gold, None);
    assert!(report.groups[0]
        .runs
        .iter()
        .all(|run| run.gold_alignment.is_none()));
}

#[test]
fn gold_alignment_is_independent_of_helpfulness() {
    let dir = tempfile::tempdir().unwrap();
    let store = init_store(dir.path());
    let case = resolved_case();
    store.put_case(&case).unwrap();
    let snapshot = snapshot_for(&store, &case.case_id);
    let task = task_for(&store, &snapshot);
    let mut gold = GoldReference::parse_json(include_str!(
        "../../../collab/contracts/fixtures/gold-reference.valid.json"
    ))
    .unwrap();
    gold.case_id = case.case_id.clone();
    gold.task_fingerprint = task.task_id.clone();
    gold.snapshot_fingerprint = task.snapshot_id.clone();
    gold.validate().unwrap();
    store.put_gold(&gold).unwrap();
    store.put_gold(&gold).unwrap();
    let mut mutated = gold.clone();
    mutated.notes.push("mutation attempt".into());
    assert!(store.put_gold(&mutated).is_err());

    let aligned = import_with_claims(
        &store,
        &task.task_id,
        "qwen-synth",
        "cited checkout log and inventory timeout\n",
        vec![
            claim("ev-demo-checkout-log"),
            claim("ev-demo-inventory-timeout"),
        ],
        "2026-01-15T08:01:00Z",
    );
    let partial = import_with_claims(
        &store,
        &task.task_id,
        "gpt-synth",
        "cited checkout log only\n",
        vec![
            claim("ev-demo-checkout-log"),
            claim("ev-demo-pool-exhaustion"),
        ],
        "2026-01-15T08:02:00Z",
    );
    let unscored = import_with_claims(
        &store,
        &task.task_id,
        "silent-synth",
        "no evidence ids\n",
        vec![],
        "2026-01-15T08:03:00Z",
    );

    let report = build_report_with_gold(
        &store.load_runs().unwrap(),
        &[],
        &[],
        &store.load_cases().unwrap(),
        &BTreeMap::new(),
        PrivacyClass::ShareSafe,
        &store.load_golds().unwrap(),
    )
    .unwrap();
    let group = &report.groups[0];
    let gold_row = group.gold.as_ref().expect("gold");
    assert_eq!(gold_row.version, 1);
    assert_eq!(gold_row.human_acceptance.status, "accepted");
    assert_eq!(
        gold_row.evidence_anchors,
        vec!["ev-demo-checkout-log", "ev-demo-inventory-timeout"]
    );
    let by_name: BTreeMap<_, _> = group
        .runs
        .iter()
        .map(|run| (run.strategy_name.as_str(), run))
        .collect();
    assert_eq!(
        by_name["qwen-synth"]
            .gold_alignment
            .as_ref()
            .unwrap()
            .status,
        GoldAlignmentStatus::Aligned
    );
    assert_eq!(
        by_name["gpt-synth"].gold_alignment.as_ref().unwrap().status,
        GoldAlignmentStatus::Partial
    );
    assert_eq!(
        by_name["silent-synth"]
            .gold_alignment
            .as_ref()
            .unwrap()
            .status,
        GoldAlignmentStatus::Unscored
    );
    assert!(by_name
        .values()
        .all(|run| run.score_visibility == ScoreVisibility::Unscored));
    assert!(report
        .notes
        .iter()
        .any(|note| note == GOLD_IS_HUMAN_BENCHMARK));
    assert!(report
        .notes
        .iter()
        .any(|note| note == GOLD_ALIGNMENT_NOT_CORRECTNESS));
    let json = serde_json::to_string(&report).unwrap();
    gate_share_safe_text(&json).unwrap();
    assert!(!json.contains("rawModelCapture"));
    assert!(!json.contains("ai-gateway.vercel.sh"));
    let _ = (aligned, partial, unscored);
}
