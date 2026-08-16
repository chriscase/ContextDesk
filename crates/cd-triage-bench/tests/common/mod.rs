//! Shared fixture construction for triage-bench integration tests.

#![allow(dead_code)]

use cd_triage_bench::types::*;
use cd_triage_bench::{import_run, BenchStore};
use std::collections::BTreeSet;
use std::path::Path;

pub const LOG_BYTES: &[u8] = b"2026-01-15T04:12:00Z ERROR checkout failed: inventory timeout\n";
pub const EMAIL_BYTES: &[u8] =
    b"From: oncall@example.test\nSubject: checkout 500s\n\nSeeing timeouts on inventory.\n";
pub const ATTACH_BYTES: &[u8] = b"runbook: raise inventory client timeout to 5s\n";
pub const HUMAN_RAW: &str =
    "Diagnosis: inventory client timeout. Next step: raise timeout and watch error rate.\n";
pub const WEB_RAW: &str = "I think the database is down. Citation: ev-does-not-exist\n";
pub const OTHER_RAW: &str = "Partial: logs show timeout; I am not sure about root cause.\n";
pub const HUMAN_V2_RAW: &str = "Diagnosis: inventory client timeout. Also restart the proxy.\n";

pub fn init_store(root: &Path) -> BenchStore {
    BenchStore::init(root, "2026-01-15T00:00:00Z").unwrap()
}

pub fn resolved_case() -> Case {
    Case {
        schema_id: CASE_SCHEMA_V1.into(),
        case_id: "case-checkout-cascade".into(),
        privacy: PrivacyClass::ShareSafe,
        title: "Synthetic checkout latency spike".into(),
        reported_problem: ReportedProblem {
            summary: "Checkout returns 500 during peak".into(),
            reported_at: Some("2026-01-15T04:10:00Z".into()),
            reporter: Some("on-call".into()),
            symptoms: vec!["HTTP 500".into(), "inventory timeout".into()],
        },
        lifecycle: CaseLifecycle::Resolved,
        timeline_notes: vec![TimelineNote {
            at: "2026-01-15T04:20:00Z".into(),
            author: "on-call".into(),
            text: "Mitigated by increasing timeout.".into(),
        }],
        created_at: "2026-01-15T00:00:00Z".into(),
        resolution: Some(CaseResolution {
            adjudicated_root_cause: Some("inventory client timeout".into()),
            fix: Some("raise client timeout".into()),
            domain_expertise: Some("SKU service is known to stall under lock contention".into()),
            notes: Some("evaluation-only".into()),
        }),
    }
}

pub fn unresolved_case() -> Case {
    Case {
        schema_id: CASE_SCHEMA_V1.into(),
        case_id: "case-open-question".into(),
        privacy: PrivacyClass::OwnerOnly,
        title: "Intermittent 500s without agreed cause".into(),
        reported_problem: ReportedProblem {
            summary: "Occasional 500s; no confirmed root cause".into(),
            reported_at: None,
            reporter: None,
            symptoms: vec!["intermittent 500".into()],
        },
        lifecycle: CaseLifecycle::Unresolved,
        timeline_notes: vec![],
        created_at: "2026-01-16T00:00:00Z".into(),
        resolution: None,
    }
}

pub fn four_kind_items() -> Vec<EvidenceItem> {
    vec![
        EvidenceItem::Attachment {
            item_id: "ev-attach-1".into(),
            privacy: PrivacyClass::ShareSafe,
            capture_time: "2026-01-15T04:15:00Z".into(),
            source: EvidenceSource {
                reference: "runbook.txt".into(),
                captured_from: "wiki export".into(),
            },
            media_type: "text/plain".into(),
            filename: "runbook.txt".into(),
            content: HeldContent {
                digest: ContentDigest::of_bytes(ATTACH_BYTES),
                byte_length: ATTACH_BYTES.len() as u64,
            },
            summaries: vec![],
            visible_to_strategies: true,
        },
        EvidenceItem::Email {
            item_id: "ev-email-1".into(),
            privacy: PrivacyClass::ShareSafe,
            capture_time: "2026-01-15T04:13:00Z".into(),
            source: EvidenceSource {
                reference: "alert.eml".into(),
                captured_from: "on-call mailbox".into(),
            },
            media_type: "message/rfc822".into(),
            content: HeldContent {
                digest: ContentDigest::of_bytes(EMAIL_BYTES),
                byte_length: EMAIL_BYTES.len() as u64,
            },
            summaries: vec![AttributedSummary {
                author: "on-call".into(),
                kind: "human".into(),
                text: "On-call reported inventory timeouts.".into(),
                created_at: "2026-01-15T04:30:00Z".into(),
            }],
            visible_to_strategies: true,
        },
        EvidenceItem::Log {
            item_id: "ev-log-1".into(),
            privacy: PrivacyClass::ShareSafe,
            capture_time: "2026-01-15T04:12:00Z".into(),
            source: EvidenceSource {
                reference: "app.log".into(),
                captured_from: "synthetic collector".into(),
            },
            media_type: "text/plain".into(),
            format: "raw".into(),
            content: HeldContent {
                digest: ContentDigest::of_bytes(LOG_BYTES),
                byte_length: LOG_BYTES.len() as u64,
            },
            summaries: vec![],
            visible_to_strategies: true,
        },
        EvidenceItem::ExternalFileServerReference {
            item_id: "ev-ref-1".into(),
            privacy: PrivacyClass::ShareSafe,
            capture_time: "2026-01-15T04:16:00Z".into(),
            source: EvidenceSource {
                reference: "fileserver://archives/heap.bin".into(),
                captured_from: "ticket attachment list".into(),
            },
            uri: "fileserver://archives/heap.bin".into(),
            expected_content_digest: None,
            verification: VerificationStatus::Unverified,
            summaries: vec![],
            visible_to_strategies: true,
        },
    ]
}

pub fn snapshot_for(store: &BenchStore, case_id: &str) -> EvidenceSnapshot {
    store.put_blob(LOG_BYTES).unwrap();
    store.put_blob(EMAIL_BYTES).unwrap();
    store.put_blob(ATTACH_BYTES).unwrap();
    let snapshot = EvidenceSnapshot::from_parts(
        PrivacyClass::ShareSafe,
        case_id.into(),
        "2026-01-15T06:00:00Z".into(),
        "fixture-operator".into(),
        four_kind_items(),
        None,
    )
    .unwrap();
    store.put_snapshot(&snapshot).unwrap();
    snapshot
}

pub fn task_for(store: &BenchStore, snapshot: &EvidenceSnapshot) -> EvaluationTask {
    let task = EvaluationTask::from_parts(
        PrivacyClass::ShareSafe,
        snapshot.case_id.clone(),
        snapshot.snapshot_id.clone(),
        "What caused the checkout failures, and what should we do next?".into(),
        "Answer only from visible snapshot evidence. Do not invent a root cause.".into(),
        "v1".into(),
        VisibilityPolicy {
            visible_item_ids: vec![
                "ev-attach-1".into(),
                "ev-email-1".into(),
                "ev-log-1".into(),
                "ev-ref-1".into(),
            ],
            include_summaries: true,
            include_raw_bytes: true,
        },
        Some(TimeConstraint {
            not_before: Some("2026-01-15T04:00:00Z".into()),
            not_after: Some("2026-01-15T05:00:00Z".into()),
        }),
        "2026-01-15T07:00:00Z".into(),
    )
    .unwrap();
    store.put_task(&task).unwrap();
    task
}

#[allow(clippy::too_many_arguments)]
pub fn import_named(
    store: &BenchStore,
    task_id: &str,
    source_kind: SourceKind,
    name: &str,
    version: Observed<String>,
    raw: &str,
    fairness: FairnessClass,
    status: RunStatus,
    created_at: &str,
) -> String {
    let document = RunImport {
        schema_id: RUN_IMPORT_SCHEMA_V1.into(),
        task_id: task_id.into(),
        strategy: StrategyIdentity {
            name: name.into(),
            version,
            build: Observed::Unknown,
        },
        source_kind,
        prompt_workflow: PromptWorkflow {
            completeness: Completeness::Unknown,
            prompt: Observed::Unknown,
            workflow: Observed::Unknown,
        },
        raw_output_utf8: Some(raw.into()),
        claims: if source_kind == SourceKind::WebOnly {
            vec![ClaimedCitation {
                claim: "database is down".into(),
                evidence_item_id: Some("ev-does-not-exist".into()),
                locator: None,
            }]
        } else {
            vec![ClaimedCitation {
                claim: "inventory timeout".into(),
                evidence_item_id: Some("ev-log-1".into()),
                locator: None,
            }]
        },
        timing: Observed::Unknown,
        cost: Observed::Unknown,
        uncertainty: if status == RunStatus::Partial {
            Observed::Known("inconclusive".into())
        } else {
            Observed::Unknown
        },
        fairness,
        status,
        operator: "operator-a".into(),
        importer: Some("importer-b".into()),
        privacy: PrivacyClass::ShareSafe,
        created_at: created_at.into(),
    };
    match import_run(store, &document, raw.as_bytes()).unwrap() {
        cd_triage_bench::ImportOutcome::Created { run_id, .. } => run_id,
        cd_triage_bench::ImportOutcome::Duplicate { run_id } => run_id,
    }
}

pub fn outcomes(
    diagnosis: DimensionVerdict,
    evidence: DimensionVerdict,
    action: DimensionVerdict,
    uncertainty: DimensionVerdict,
    unsafe_claims: DimensionVerdict,
) -> Vec<DimensionOutcome> {
    vec![
        DimensionOutcome {
            dimension: RubricDimension::DiagnosisCorrectness,
            verdict: diagnosis,
            rationale: "diagnosis rationale".into(),
            assist_flags: vec![],
        },
        DimensionOutcome {
            dimension: RubricDimension::EvidenceSupport,
            verdict: evidence,
            rationale: "evidence rationale".into(),
            assist_flags: vec![],
        },
        DimensionOutcome {
            dimension: RubricDimension::Actionability,
            verdict: action,
            rationale: "action rationale".into(),
            assist_flags: vec![],
        },
        DimensionOutcome {
            dimension: RubricDimension::UncertaintyCalibration,
            verdict: uncertainty,
            rationale: "uncertainty rationale".into(),
            assist_flags: vec![],
        },
        DimensionOutcome {
            dimension: RubricDimension::UnsafeUnsupportedClaims,
            verdict: unsafe_claims,
            rationale: "unsafe-claims rationale".into(),
            assist_flags: vec![],
        },
    ]
}

#[allow(clippy::too_many_arguments)]
pub fn put_support_then_diagnosis(
    store: &BenchStore,
    privacy: PrivacyClass,
    case_id: &str,
    task_id: &str,
    snapshot_id: &str,
    run_id: &str,
    reviewer: &str,
    conflict_of_interest: ConflictOfInterest,
    rubric_version: &str,
    blinding: BlindingState,
    diagnosis: DimensionVerdict,
    evidence: DimensionVerdict,
    action: DimensionVerdict,
    uncertainty: DimensionVerdict,
    unsafe_claims: DimensionVerdict,
    created_at: &str,
) {
    let support_packet = store
        .materialize_review_packet(run_id, ReviewPhase::Support)
        .unwrap();
    let support = Adjudication::from_parts(
        privacy,
        case_id.into(),
        task_id.into(),
        snapshot_id.into(),
        run_id.into(),
        reviewer.into(),
        conflict_of_interest.clone(),
        rubric_version.into(),
        ReviewPhase::Support,
        blinding.clone(),
        outcomes(
            DimensionVerdict::NotApplicable,
            evidence.clone(),
            action.clone(),
            uncertainty.clone(),
            unsafe_claims.clone(),
        ),
        created_at.into(),
    )
    .unwrap()
    .bind_review_packet(support_packet.packet_id)
    .unwrap();
    store.put_adjudication(&support).unwrap();
    let diagnosis_packet = store
        .materialize_review_packet(run_id, ReviewPhase::Diagnosis)
        .unwrap();
    let diagnosis_adj = Adjudication::from_parts(
        privacy,
        case_id.into(),
        task_id.into(),
        snapshot_id.into(),
        run_id.into(),
        reviewer.into(),
        conflict_of_interest,
        rubric_version.into(),
        ReviewPhase::Diagnosis,
        blinding,
        outcomes(diagnosis, evidence, action, uncertainty, unsafe_claims),
        created_at.into(),
    )
    .unwrap()
    .bind_review_packet(diagnosis_packet.packet_id)
    .unwrap();
    store.put_adjudication(&diagnosis_adj).unwrap();
}

pub fn snapshot_ids(snapshot: &EvidenceSnapshot) -> BTreeSet<String> {
    snapshot
        .items
        .iter()
        .map(|i| i.item_id().to_string())
        .collect()
}
