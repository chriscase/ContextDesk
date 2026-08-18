//! Hermetic coverage for the deterministic agreement projection.
//!
//! Every fixture here is built in memory. No store, no provider, no network,
//! no credential, no clock.

use std::collections::BTreeMap;

use cd_triage_bench::agreement::{
    build_agreement_views, project_agreement_share_safe, render_agreement_markdown,
    render_agreement_share_safe_json, ExclusionReason, RoleBucket, AGREEMENT_VIEW_SCHEMA_V1,
    AGREEMENT_VIEW_SHARE_SAFE_SCHEMA_V1,
};
use cd_triage_bench::{
    ClaimedCitation, Completeness, ContentDigest, EvaluationTask, FairnessClass, Observed,
    PrivacyClass, PromptWorkflow, RawOutput, RunStatus, SourceKind, StrategyIdentity, TriageRun,
    VisibilityPolicy, RUN_SCHEMA_V2,
};
use serde_json::{json, Value};

const CREATED_AT: &str = "2026-01-15T08:00:00Z";
const CASE_ID: &str = "case-agreement-1";
const SNAPSHOT_ID: &str = "snap-1111111111111111111111111111111111111111111111111111111111111111";
const PACKET: &str = "pkf-2222222222222222222222222222222222222222222222222222222222222222";

fn task(visible: &[&str]) -> EvaluationTask {
    EvaluationTask::from_parts(
        PrivacyClass::OwnerOnly,
        CASE_ID.into(),
        SNAPSHOT_ID.into(),
        "What caused the checkout failure?".into(),
        "Use only the supplied evidence.".into(),
        "v1".into(),
        VisibilityPolicy {
            visible_item_ids: visible.iter().map(|item| (*item).to_string()).collect(),
            include_summaries: false,
            include_raw_bytes: true,
        },
        None,
        CREATED_AT.into(),
    )
    .expect("task")
}

fn model_fingerprint(seed: char) -> String {
    format!("mdf-{}", String::from_iter(std::iter::repeat_n(seed, 64)))
}

/// One claim as the SDK answer envelope carries it.
fn claim(claim_id: &str, kind: &str, status: &str, evidence: &[&str]) -> Value {
    json!({
        "candidate_id": "cand-1",
        "claim_id": claim_id,
        "claim_kind": kind,
        "evidence_ids": evidence,
        "status": status,
        "text": "claim text that agreement must never compare",
    })
}

/// Build the adapter's owner-only envelope bytes for one SDK row.
fn envelope(
    profile: &str,
    model: &str,
    fingerprint_seed: char,
    visible: &[&str],
    packet: &str,
    terminal: Value,
) -> Vec<u8> {
    let record = json!({
        "sdk_run_id": format!("cdrun-{profile}-{model}"),
        "execution_packet_state": "matched",
        "visible_item_ids": visible,
        "fingerprints": {
            "policy": "pol-abc",
            "request": "sha256:abc",
            "packet": packet,
            "corpus": "cof-abc",
            "models": [model_fingerprint(fingerprint_seed)],
            "slots": ["slf-abc"],
        },
        "slots": [{
            "model": { "profile_id": profile, "model_id": model },
            "model_fingerprint": model_fingerprint(fingerprint_seed),
            "role": "finalizer",
        }],
        "terminal": { "kind": "grounded_final", "category": "completed" },
        "replay": {
            "schema_id": "contextdesk.triage.replay.v1",
            "run_id": format!("cdrun-{profile}-{model}"),
            "request_fingerprint": "sha256:abc",
            "events": [{ "sequence": 0, "event": terminal }],
        },
    });
    serde_json::to_vec(&record).expect("envelope bytes")
}

/// A completed terminal carrying an answer with `claims`.
fn completed_terminal(claims: Vec<Value>) -> Value {
    json!({
        "kind": "completed",
        "result": {
            "schema_id": "contextdesk.triage.result.v2",
            "kind": "grounded_final",
            "answer": {
                "answer": {
                    "schema": "contextdesk.investigation_answer.v1",
                    "root_cause_established": true,
                    "candidates": [{ "candidate_id": "cand-1", "claims": claims }],
                    "canonical_citations": [],
                },
                "evidence": [],
                "semantic_attempts": 1,
            },
        },
    })
}

/// A failed terminal whose honest partial carries no answer at all.
fn failed_terminal_without_answer() -> Value {
    json!({
        "kind": "failed",
        "category": "mock_failed",
        "partial_result": {
            "schema_id": "contextdesk.triage.result.v2",
            "kind": "honest_partial",
            "reason_codes": ["no_authoritative_answer"],
        },
    })
}

fn run_row(
    run_id: &str,
    task_id: &str,
    source_kind: SourceKind,
    strategy_name: &str,
    status: RunStatus,
    fairness: FairnessClass,
    claims: Vec<ClaimedCitation>,
) -> TriageRun {
    TriageRun {
        schema_id: RUN_SCHEMA_V2.into(),
        run_id: run_id.into(),
        privacy: PrivacyClass::OwnerOnly,
        case_id: CASE_ID.into(),
        task_id: task_id.into(),
        snapshot_id: SNAPSHOT_ID.into(),
        strategy: StrategyIdentity {
            name: strategy_name.into(),
            version: Observed::Unknown,
            build: Observed::Unknown,
        },
        source_kind,
        prompt_workflow: PromptWorkflow {
            completeness: Completeness::Unknown,
            prompt: Observed::Unknown,
            workflow: Observed::Unknown,
        },
        raw_output: RawOutput {
            digest: ContentDigest::sha256_hex(
                "0000000000000000000000000000000000000000000000000000000000000000",
            )
            .expect("digest"),
            byte_length: 1,
            encoding: "utf-8".into(),
        },
        claims,
        timing: Observed::Unknown,
        cost: Observed::Unknown,
        uncertainty: Observed::Unknown,
        fairness,
        status,
        operator: "test-operator".into(),
        importer: None,
        created_at: CREATED_AT.into(),
        near_duplicate_of: None,
    }
}

fn sdk_row(run_id: &str, task_id: &str, status: RunStatus) -> TriageRun {
    run_row(
        run_id,
        task_id,
        SourceKind::ContextdeskSdk,
        "contextdesk-sdk",
        status,
        FairnessClass::SameSnapshot,
        Vec::new(),
    )
}

/// Two distinct models, both citing the same evidence as the initiating cause.
#[test]
fn two_distinct_models_concurring_on_one_anchor_are_independent() {
    let task = task(&["ev-1"]);
    let runs = vec![
        sdk_row("run-a", &task.task_id, RunStatus::Completed),
        sdk_row("run-b", &task.task_id, RunStatus::Completed),
    ];
    let mut raw = BTreeMap::new();
    raw.insert(
        "run-a".to_string(),
        envelope(
            "profile:alpha",
            "model:alpha",
            'a',
            &["ev-1"],
            PACKET,
            completed_terminal(vec![claim(
                "claim-a",
                "initiating_cause",
                "supported",
                &["ev-1"],
            )]),
        ),
    );
    raw.insert(
        "run-b".to_string(),
        envelope(
            "profile:beta",
            "model:beta",
            'b',
            &["ev-1"],
            PACKET,
            completed_terminal(vec![claim(
                "claim-b",
                "initiating_cause",
                "supported",
                &["ev-1"],
            )]),
        ),
    );

    let views = build_agreement_views(&runs, std::slice::from_ref(&task), &raw).expect("views");
    assert_eq!(views.len(), 1);
    let view = &views[0];
    assert_eq!(view.schema_id, AGREEMENT_VIEW_SCHEMA_V1);
    assert_eq!(view.privacy, PrivacyClass::OwnerOnly);
    assert_eq!(view.packet_fingerprint.as_deref(), Some(PACKET));
    assert!(view.excluded_runs.is_empty());
    assert!(view.role_conflicts.is_empty());
    assert!(view.uncited_visible_evidence.is_empty());

    assert_eq!(view.anchors.len(), 1);
    let anchor = &view.anchors[0];
    assert_eq!(anchor.evidence_item_id, "ev-1");
    assert_eq!(anchor.role_bucket, RoleBucket::Cause);
    assert_eq!(anchor.concurring_run_ids, vec!["run-a", "run-b"]);
    assert_eq!(anchor.distinct_source_count, 2);
    assert_eq!(anchor.distinct_model_identity_count, 2);
    assert!(anchor.independent);
    assert!(!anchor.sole_support);
    assert_eq!(anchor.claim_ids, vec!["claim-a", "claim-b"]);
}

/// Two candidates resolved to the SAME exact model. They concur, but nothing
/// about that is independent corroboration.
#[test]
fn two_candidates_on_one_model_concur_without_independence() {
    let task = task(&["ev-1"]);
    let runs = vec![
        sdk_row("run-a", &task.task_id, RunStatus::Completed),
        sdk_row("run-b", &task.task_id, RunStatus::Completed),
    ];
    let mut raw = BTreeMap::new();
    for run_id in ["run-a", "run-b"] {
        raw.insert(
            run_id.to_string(),
            envelope(
                "profile:one",
                "model:one",
                'c',
                &["ev-1"],
                PACKET,
                completed_terminal(vec![claim(
                    &format!("claim-{run_id}"),
                    "initiating_cause",
                    "supported",
                    &["ev-1"],
                )]),
            ),
        );
    }

    let views = build_agreement_views(&runs, std::slice::from_ref(&task), &raw).expect("views");
    let anchor = &views[0].anchors[0];
    assert_eq!(anchor.concurring_run_ids.len(), 2);
    assert_eq!(anchor.distinct_source_count, 1);
    assert_eq!(anchor.distinct_model_identity_count, 1);
    assert!(!anchor.independent, "one model is not two witnesses");
}

/// Same evidence, incompatible roles: a conflict, and never one merged anchor.
#[test]
fn same_evidence_under_different_roles_is_a_conflict_not_agreement() {
    let task = task(&["ev-1"]);
    let runs = vec![
        sdk_row("run-a", &task.task_id, RunStatus::Completed),
        sdk_row("run-b", &task.task_id, RunStatus::Completed),
    ];
    let mut raw = BTreeMap::new();
    raw.insert(
        "run-a".to_string(),
        envelope(
            "profile:alpha",
            "model:alpha",
            'a',
            &["ev-1"],
            PACKET,
            completed_terminal(vec![claim(
                "claim-a",
                "initiating_cause",
                "supported",
                &["ev-1"],
            )]),
        ),
    );
    raw.insert(
        "run-b".to_string(),
        envelope(
            "profile:beta",
            "model:beta",
            'b',
            &["ev-1"],
            PACKET,
            completed_terminal(vec![claim("claim-b", "symptom", "supported", &["ev-1"])]),
        ),
    );

    let view = &build_agreement_views(&runs, std::slice::from_ref(&task), &raw).expect("views")[0];
    assert_eq!(view.anchors.len(), 2, "one anchor per role, never merged");
    for anchor in &view.anchors {
        assert_eq!(anchor.concurring_run_ids.len(), 1);
        assert!(!anchor.independent);
        assert!(anchor.sole_support);
    }
    assert_eq!(view.role_conflicts.len(), 1);
    let conflict = &view.role_conflicts[0];
    assert_eq!(conflict.evidence_item_id, "ev-1");
    assert_eq!(
        conflict
            .buckets
            .iter()
            .map(|bucket| bucket.role_bucket)
            .collect::<Vec<_>>(),
        vec![RoleBucket::Cause, RoleBucket::Symptom]
    );
}

/// Every documented claim kind maps to its bucket; an unknown kind is counted
/// as unrecognized rather than folded into `unknown` and treated as agreement.
#[test]
fn claim_kinds_map_to_buckets_and_unknown_kinds_fail_closed() {
    let task = task(&["ev-1", "ev-2", "ev-3", "ev-4", "ev-5", "ev-6"]);
    let runs = vec![sdk_row("run-a", &task.task_id, RunStatus::Completed)];
    let mut raw = BTreeMap::new();
    raw.insert(
        "run-a".to_string(),
        envelope(
            "profile:alpha",
            "model:alpha",
            'a',
            &["ev-1", "ev-2", "ev-3", "ev-4", "ev-5", "ev-6"],
            PACKET,
            completed_terminal(vec![
                claim("c1", "initiating_cause", "supported", &["ev-1"]),
                claim("c2", "causal_candidate", "supported", &["ev-2"]),
                claim("c3", "competing_explanation", "supported", &["ev-3"]),
                claim("c4", "symptom", "supported", &["ev-4"]),
                claim("c5", "observation", "supported", &["ev-5"]),
                claim("c6", "missing_evidence", "supported", &["ev-6"]),
                claim("c7", "contributing_factor_v2", "supported", &["ev-1"]),
            ]),
        ),
    );

    let view = &build_agreement_views(&runs, std::slice::from_ref(&task), &raw).expect("views")[0];
    let buckets: Vec<(String, RoleBucket)> = view
        .anchors
        .iter()
        .map(|anchor| (anchor.evidence_item_id.clone(), anchor.role_bucket))
        .collect();
    assert_eq!(
        buckets,
        vec![
            ("ev-1".into(), RoleBucket::Cause),
            ("ev-2".into(), RoleBucket::Candidate),
            ("ev-3".into(), RoleBucket::Candidate),
            ("ev-4".into(), RoleBucket::Symptom),
            ("ev-5".into(), RoleBucket::Observation),
            ("ev-6".into(), RoleBucket::Gap),
        ]
    );
    assert_eq!(view.runs[0].unrecognized_claims, 1);
    assert_eq!(view.runs[0].anchor_count, 6);
}

/// A citation outside the task's visible set is a finding, not an anchor, and
/// a withheld claim never counts as support.
#[test]
fn invalid_citations_and_withheld_claims_never_anchor() {
    let task = task(&["ev-1"]);
    let runs = vec![sdk_row("run-a", &task.task_id, RunStatus::Completed)];
    let mut raw = BTreeMap::new();
    raw.insert(
        "run-a".to_string(),
        envelope(
            "profile:alpha",
            "model:alpha",
            'a',
            &["ev-1"],
            PACKET,
            completed_terminal(vec![
                claim(
                    "c1",
                    "initiating_cause",
                    "supported",
                    &["ev-not-in-snapshot"],
                ),
                claim("c2", "observation", "withheld", &["ev-1"]),
                claim("c3", "observation", "unsupported", &["ev-1"]),
                claim("c4", "observation", "supported", &[]),
            ]),
        ),
    );

    let view = &build_agreement_views(&runs, std::slice::from_ref(&task), &raw).expect("views")[0];
    assert!(view.anchors.is_empty());
    let run = &view.runs[0];
    assert_eq!(run.invalid_citations, vec!["ev-not-in-snapshot"]);
    assert_eq!(run.withheld_claims, 2);
    assert_eq!(run.unanchored_claims, 1);
    assert_eq!(run.anchor_count, 0);
    assert_eq!(view.uncited_visible_evidence, vec!["ev-1"]);
}

/// The projection reads the validated claim graph, not `TriageRun::claims`.
/// The flattened summary keeps only the first evidence id, so a claim citing
/// two items proves the envelope is the source of truth.
#[test]
fn sdk_agreement_reads_the_envelope_not_the_flattened_claim_summary() {
    let task = task(&["ev-1", "ev-2"]);
    let mut run = sdk_row("run-a", &task.task_id, RunStatus::Completed);
    // Exactly what `claimed_citations` would have stored: first id only.
    run.claims = vec![ClaimedCitation {
        claim: "claim text".into(),
        evidence_item_id: Some("ev-1".into()),
        locator: None,
    }];
    let mut raw = BTreeMap::new();
    raw.insert(
        "run-a".to_string(),
        envelope(
            "profile:alpha",
            "model:alpha",
            'a',
            &["ev-1", "ev-2"],
            PACKET,
            completed_terminal(vec![claim(
                "c1",
                "initiating_cause",
                "supported",
                &["ev-1", "ev-2"],
            )]),
        ),
    );

    let view = &build_agreement_views(&[run], std::slice::from_ref(&task), &raw).expect("views")[0];
    let anchored: Vec<&str> = view
        .anchors
        .iter()
        .map(|anchor| anchor.evidence_item_id.as_str())
        .collect();
    assert_eq!(anchored, vec!["ev-1", "ev-2"]);
    for anchor in &view.anchors {
        assert_eq!(anchor.role_bucket, RoleBucket::Cause);
    }
}

/// A run whose fairness is not `same_snapshot` is excluded with the reason.
#[test]
fn only_same_snapshot_fairness_participates() {
    let task = task(&["ev-1"]);
    let runs = vec![
        run_row(
            "run-extra",
            &task.task_id,
            SourceKind::Human,
            "human-expert",
            RunStatus::Completed,
            FairnessClass::ExtraEvidence {
                description: "saw the dashboard too".into(),
            },
            vec![ClaimedCitation {
                claim: "inventory timeout".into(),
                evidence_item_id: Some("ev-1".into()),
                locator: None,
            }],
        ),
        run_row(
            "run-unknown",
            &task.task_id,
            SourceKind::WebOnly,
            "web-assistant",
            RunStatus::Completed,
            FairnessClass::UnknownVisibility,
            vec![ClaimedCitation {
                claim: "inventory timeout".into(),
                evidence_item_id: Some("ev-1".into()),
                locator: None,
            }],
        ),
    ];

    let view = &build_agreement_views(&runs, std::slice::from_ref(&task), &BTreeMap::new())
        .expect("views")[0];
    assert!(view.runs.is_empty());
    assert!(view.anchors.is_empty());
    assert_eq!(view.excluded_runs.len(), 2);
    for excluded in &view.excluded_runs {
        assert_eq!(excluded.reason, ExclusionReason::FairnessNotSameSnapshot);
    }
}

/// A run against another snapshot never joins this group, and a group whose
/// task record is missing excludes everything rather than guessing visibility.
#[test]
fn groups_are_exact_and_a_missing_task_record_fails_closed() {
    let task = task(&["ev-1"]);
    let mut other = sdk_row("run-other", &task.task_id, RunStatus::Completed);
    other.snapshot_id =
        "snap-9999999999999999999999999999999999999999999999999999999999999999".into();
    let runs = vec![sdk_row("run-a", &task.task_id, RunStatus::Completed), other];
    let mut raw = BTreeMap::new();
    for run_id in ["run-a", "run-other"] {
        raw.insert(
            run_id.to_string(),
            envelope(
                "profile:alpha",
                "model:alpha",
                'a',
                &["ev-1"],
                PACKET,
                completed_terminal(vec![claim("c1", "observation", "supported", &["ev-1"])]),
            ),
        );
    }

    let views = build_agreement_views(&runs, std::slice::from_ref(&task), &raw).expect("views");
    assert_eq!(views.len(), 2, "different snapshots are different groups");
    let cross = views
        .iter()
        .find(|view| view.snapshot_id.starts_with("snap-9999"))
        .expect("second group");
    // The task record binds one snapshot, so its visibility policy cannot be
    // used to validate a run recorded against another snapshot.
    assert!(cross.runs.is_empty());
    assert_eq!(cross.excluded_runs.len(), 1);
    assert_eq!(
        cross.excluded_runs[0].reason,
        ExclusionReason::TaskSnapshotMismatch
    );
    assert!(cross.anchors.is_empty());

    // The in-snapshot group is unaffected by the stray row.
    let same = views
        .iter()
        .find(|view| view.snapshot_id == SNAPSHOT_ID)
        .expect("first group");
    assert_eq!(same.runs.len(), 1);
    assert_eq!(same.anchors.len(), 1);

    // A group whose task record was never supplied fails closed the same way.
    let orphan = build_agreement_views(&runs, &[], &raw).expect("views");
    assert!(orphan.iter().all(|view| view.runs.is_empty()));
    assert!(orphan.iter().all(|view| view
        .excluded_runs
        .iter()
        .all(|excluded| excluded.reason == ExclusionReason::TaskRecordUnavailable)));
}

/// Failed, partial, timed-out, and cancelled rows stay listed and anchor
/// nothing. A terminal with no answer is reported as "no claim set", which is
/// a different fact from an answer that cited nothing.
#[test]
fn failed_and_partial_rows_stay_visible_with_zero_anchors() {
    let task = task(&["ev-1"]);
    let statuses = [
        ("run-failed", RunStatus::Failed),
        ("run-partial", RunStatus::Partial),
        ("run-timeout", RunStatus::TimedOut),
        ("run-cancelled", RunStatus::Cancelled),
    ];
    let runs: Vec<TriageRun> = statuses
        .iter()
        .map(|(run_id, status)| sdk_row(run_id, &task.task_id, *status))
        .collect();
    let mut raw = BTreeMap::new();
    for (run_id, _) in statuses {
        raw.insert(
            run_id.to_string(),
            envelope(
                "profile:alpha",
                "model:alpha",
                'a',
                &["ev-1"],
                PACKET,
                failed_terminal_without_answer(),
            ),
        );
    }

    let view = &build_agreement_views(&runs, std::slice::from_ref(&task), &raw).expect("views")[0];
    assert_eq!(view.runs.len(), 4, "no row is dropped for failing");
    assert!(view.excluded_runs.is_empty());
    assert!(view.anchors.is_empty());
    for run in &view.runs {
        assert!(!run.claims_available);
        assert_eq!(run.anchor_count, 0);
        assert_eq!(run.unanchored_claims, 0);
    }
    assert_eq!(view.uncited_visible_evidence, vec!["ev-1"]);
}

/// An imported row carries no typed kind, so it lands in `unknown` and can
/// never silently corroborate a typed SDK claim.
#[test]
fn imported_rows_use_the_unknown_bucket_and_never_merge_with_typed_claims() {
    let task = task(&["ev-1"]);
    let runs = vec![
        sdk_row("run-sdk", &task.task_id, RunStatus::Completed),
        run_row(
            "run-human",
            &task.task_id,
            SourceKind::Human,
            "human-expert",
            RunStatus::Completed,
            FairnessClass::SameSnapshot,
            vec![ClaimedCitation {
                claim: "inventory timeout".into(),
                evidence_item_id: Some("ev-1".into()),
                locator: Some("ERROR checkout failed".into()),
            }],
        ),
    ];
    let mut raw = BTreeMap::new();
    raw.insert(
        "run-sdk".to_string(),
        envelope(
            "profile:alpha",
            "model:alpha",
            'a',
            &["ev-1"],
            PACKET,
            completed_terminal(vec![claim(
                "c1",
                "initiating_cause",
                "supported",
                &["ev-1"],
            )]),
        ),
    );

    let view = &build_agreement_views(&runs, std::slice::from_ref(&task), &raw).expect("views")[0];
    assert_eq!(view.anchors.len(), 2);
    let unknown = view
        .anchors
        .iter()
        .find(|anchor| anchor.role_bucket == RoleBucket::Unknown)
        .expect("imported anchor");
    assert_eq!(unknown.concurring_run_ids, vec!["run-human"]);
    assert!(unknown.sole_support);
    assert_eq!(unknown.distinct_model_identity_count, 0);
    // A human and a model are two distinct sources, but they landed in
    // different buckets, so this is a conflict rather than corroboration.
    assert_eq!(view.role_conflicts.len(), 1);
}

/// Two imported rows from distinct sources do corroborate each other, which is
/// the path that makes `unknown` useful instead of inert.
#[test]
fn two_distinct_imported_sources_concur_in_the_unknown_bucket() {
    let task = task(&["ev-1"]);
    let citation = vec![ClaimedCitation {
        claim: "inventory timeout".into(),
        evidence_item_id: Some("ev-1".into()),
        locator: None,
    }];
    let runs = vec![
        run_row(
            "run-human",
            &task.task_id,
            SourceKind::Human,
            "human-expert",
            RunStatus::Completed,
            FairnessClass::SameSnapshot,
            citation.clone(),
        ),
        run_row(
            "run-other",
            &task.task_id,
            SourceKind::OtherProduct,
            "other-product",
            RunStatus::Completed,
            FairnessClass::SameSnapshot,
            citation,
        ),
    ];

    let view = &build_agreement_views(&runs, std::slice::from_ref(&task), &BTreeMap::new())
        .expect("views")[0];
    assert_eq!(view.anchors.len(), 1);
    let anchor = &view.anchors[0];
    assert_eq!(anchor.role_bucket, RoleBucket::Unknown);
    assert_eq!(anchor.distinct_source_count, 2);
    assert_eq!(anchor.distinct_model_identity_count, 0);
    assert!(anchor.independent);
    assert!(view.role_conflicts.is_empty());
}

/// Provenance failures on an SDK row are named, never silently rendered as a
/// row that simply contributed nothing.
#[test]
fn sdk_provenance_failures_are_named_exclusions() {
    let task = task(&["ev-1"]);
    let runs = vec![
        sdk_row("run-missing-raw", &task.task_id, RunStatus::Completed),
        sdk_row("run-unparseable", &task.task_id, RunStatus::Completed),
        sdk_row("run-not-envelope", &task.task_id, RunStatus::Completed),
        sdk_row("run-visibility", &task.task_id, RunStatus::Completed),
    ];
    let mut raw = BTreeMap::new();
    raw.insert("run-unparseable".to_string(), b"{not json".to_vec());
    raw.insert(
        "run-not-envelope".to_string(),
        serde_json::to_vec(&json!({"some": "imported artifact"})).expect("bytes"),
    );
    raw.insert(
        "run-visibility".to_string(),
        envelope(
            "profile:alpha",
            "model:alpha",
            'a',
            &["ev-1", "ev-2"],
            PACKET,
            completed_terminal(vec![claim("c1", "observation", "supported", &["ev-1"])]),
        ),
    );

    let view = &build_agreement_views(&runs, std::slice::from_ref(&task), &raw).expect("views")[0];
    assert!(view.runs.is_empty());
    let reasons: BTreeMap<&str, ExclusionReason> = view
        .excluded_runs
        .iter()
        .map(|excluded| (excluded.run_id.as_str(), excluded.reason))
        .collect();
    assert_eq!(
        reasons["run-missing-raw"],
        ExclusionReason::SdkRawOutputUnavailable
    );
    assert_eq!(
        reasons["run-unparseable"],
        ExclusionReason::SdkEnvelopeUnparseable
    );
    assert_eq!(
        reasons["run-not-envelope"],
        ExclusionReason::SdkRowWithoutOwnerOnlyEnvelope
    );
    assert_eq!(
        reasons["run-visibility"],
        ExclusionReason::SdkVisibilityMismatch
    );
}

/// SDK rows that did not share one materialized packet cannot be compared, and
/// no majority is picked — every SDK row is refused.
#[test]
fn packet_divergence_refuses_every_sdk_row_rather_than_picking_one() {
    let task = task(&["ev-1"]);
    let runs = vec![
        sdk_row("run-a", &task.task_id, RunStatus::Completed),
        sdk_row("run-b", &task.task_id, RunStatus::Completed),
    ];
    let mut raw = BTreeMap::new();
    raw.insert(
        "run-a".to_string(),
        envelope(
            "profile:alpha",
            "model:alpha",
            'a',
            &["ev-1"],
            PACKET,
            completed_terminal(vec![claim("c1", "observation", "supported", &["ev-1"])]),
        ),
    );
    raw.insert(
        "run-b".to_string(),
        envelope(
            "profile:beta",
            "model:beta",
            'b',
            &["ev-1"],
            "pkf-3333333333333333333333333333333333333333333333333333333333333333",
            completed_terminal(vec![claim("c2", "observation", "supported", &["ev-1"])]),
        ),
    );

    let view = &build_agreement_views(&runs, std::slice::from_ref(&task), &raw).expect("views")[0];
    assert!(view.runs.is_empty());
    assert!(view.anchors.is_empty());
    assert_eq!(view.packet_fingerprint, None);
    assert_eq!(view.excluded_runs.len(), 2);
    for excluded in &view.excluded_runs {
        assert_eq!(
            excluded.reason,
            ExclusionReason::PacketFingerprintDivergence
        );
    }
}

/// Byte stability: the same records must produce identical JSON every time,
/// and independently of the order the runs were supplied in.
#[test]
fn agreement_views_are_byte_stable_and_input_order_independent() {
    let task = task(&["ev-1", "ev-2"]);
    let mut raw = BTreeMap::new();
    raw.insert(
        "run-a".to_string(),
        envelope(
            "profile:alpha",
            "model:alpha",
            'a',
            &["ev-1", "ev-2"],
            PACKET,
            completed_terminal(vec![claim(
                "c1",
                "initiating_cause",
                "supported",
                &["ev-1"],
            )]),
        ),
    );
    raw.insert(
        "run-b".to_string(),
        envelope(
            "profile:beta",
            "model:beta",
            'b',
            &["ev-1", "ev-2"],
            PACKET,
            completed_terminal(vec![
                claim("c2", "initiating_cause", "supported", &["ev-1"]),
                claim("c3", "symptom", "supported", &["ev-2"]),
            ]),
        ),
    );
    let forward = vec![
        sdk_row("run-a", &task.task_id, RunStatus::Completed),
        sdk_row("run-b", &task.task_id, RunStatus::Completed),
    ];
    let reversed: Vec<TriageRun> = forward.iter().rev().cloned().collect();

    let first = build_agreement_views(&forward, std::slice::from_ref(&task), &raw).expect("views");
    let again = build_agreement_views(&forward, std::slice::from_ref(&task), &raw).expect("views");
    let flipped =
        build_agreement_views(&reversed, std::slice::from_ref(&task), &raw).expect("views");

    let render =
        |views: &[cd_triage_bench::AgreementView]| serde_json::to_string(views).expect("json");
    assert_eq!(render(&first), render(&again));
    assert_eq!(render(&first), render(&flipped));
    assert_eq!(
        render_agreement_markdown(&first).expect("markdown"),
        render_agreement_markdown(&flipped).expect("markdown")
    );

    let share_safe: Vec<_> = first
        .iter()
        .map(|view| project_agreement_share_safe(view).expect("projection"))
        .collect();
    let share_safe_again: Vec<_> = flipped
        .iter()
        .map(|view| project_agreement_share_safe(view).expect("projection"))
        .collect();
    assert_eq!(
        serde_json::to_string(&share_safe).expect("json"),
        serde_json::to_string(&share_safe_again).expect("json")
    );
}

/// The share-safe projection carries fingerprints and counts only.
#[test]
fn share_safe_projection_leaks_no_identity_text_or_locator() {
    let task = task(&["ev-secret-item"]);
    let runs = vec![
        sdk_row("run-a", &task.task_id, RunStatus::Completed),
        run_row(
            "run-human",
            &task.task_id,
            SourceKind::Human,
            "acme-oncall-expert",
            RunStatus::Completed,
            FairnessClass::SameSnapshot,
            vec![ClaimedCitation {
                claim: "the checkout log line at 04:12".into(),
                evidence_item_id: Some("ev-secret-item".into()),
                locator: Some("ERROR inventory_client timeout_ms=2000".into()),
            }],
        ),
    ];
    let mut raw = BTreeMap::new();
    raw.insert(
        "run-a".to_string(),
        envelope(
            "profile:acme-gateway",
            "model:acme-cheap-v1",
            'a',
            &["ev-secret-item"],
            PACKET,
            completed_terminal(vec![claim(
                "c1",
                "initiating_cause",
                "supported",
                &["ev-secret-item"],
            )]),
        ),
    );

    let views = build_agreement_views(&runs, std::slice::from_ref(&task), &raw).expect("views");
    let owner_only = serde_json::to_string(&views).expect("json");
    // The owner-only view is allowed to carry these; that is the contrast.
    assert!(owner_only.contains("model:acme-cheap-v1"));
    assert!(owner_only.contains("ev-secret-item"));

    let projection = project_agreement_share_safe(&views[0]).expect("share-safe projection");
    assert_eq!(projection.schema_id, AGREEMENT_VIEW_SHARE_SAFE_SCHEMA_V1);
    assert_eq!(projection.privacy, PrivacyClass::ShareSafe);

    let text = render_agreement_share_safe_json(std::slice::from_ref(&projection))
        .expect("share-safe json");
    for forbidden in [
        "model:acme-cheap-v1",
        "profile:acme-gateway",
        "acme-oncall-expert",
        "ev-secret-item",
        "ERROR inventory_client timeout_ms=2000",
        "the checkout log line",
        "claim text that agreement must never compare",
        "What caused the checkout failure?",
        "Use only the supplied evidence.",
        "test-operator",
        "run-a",
        "run-human",
        "c1",
    ] {
        assert!(
            !text.contains(forbidden),
            "share-safe output leaked {forbidden:?}"
        );
    }

    // Counts and structure survive.
    assert_eq!(projection.runs.len(), 2);
    assert_eq!(projection.visible_item_count, 1);
    assert_eq!(projection.anchors.len(), 2);
    assert!(projection
        .anchors
        .iter()
        .all(|anchor| anchor.evidence_fingerprint.starts_with("aef-")));
    assert!(projection
        .runs
        .iter()
        .all(|run| run.run_fingerprint.starts_with("arf-")
            && run.source_fingerprint.starts_with("asf-")));
    assert!(projection.task_fingerprint.starts_with("tkf-"));
    assert!(projection.snapshot_fingerprint.starts_with("snf-"));
}

/// The markdown renderer escapes values that came from a record, so a crafted
/// imported strategy name cannot split a table row or inject markup.
#[test]
fn markdown_rendering_escapes_record_supplied_identities() {
    let task = task(&["ev-1"]);
    let runs = vec![run_row(
        "run-human",
        &task.task_id,
        SourceKind::Human,
        "evil | <b>name</b>",
        RunStatus::Completed,
        FairnessClass::SameSnapshot,
        vec![ClaimedCitation {
            claim: "cited".into(),
            evidence_item_id: Some("ev-1".into()),
            locator: None,
        }],
    )];

    let views =
        build_agreement_views(&runs, std::slice::from_ref(&task), &BTreeMap::new()).expect("views");
    let markdown = render_agreement_markdown(&views).expect("markdown");
    assert!(markdown.contains("evil &#124; &lt;b&gt;name&lt;/b&gt;"));
    assert!(!markdown.contains("evil | <b>"));
}

/// Every view repeats the fixed honesty notes, including the one that keeps a
/// reader from reading agreement as correctness.
#[test]
fn views_always_carry_the_honesty_notes() {
    let task = task(&["ev-1"]);
    let views = build_agreement_views(
        &[sdk_row("run-a", &task.task_id, RunStatus::Completed)],
        std::slice::from_ref(&task),
        &BTreeMap::new(),
    )
    .expect("views");
    let notes = &views[0].notes;
    assert!(notes
        .iter()
        .any(|note| note.contains("Agreement is not correctness")));
    assert!(notes
        .iter()
        .any(|note| note.contains("assigns no score, rank, readiness, or winner")));
    let markdown = render_agreement_markdown(&views).expect("markdown");
    assert!(markdown.contains("Agreement is not correctness"));
}
