//! Shared synthetic fixtures. No real incident data, no credentials.

#![allow(dead_code)]

use std::fs;
use std::path::PathBuf;

use cd_triage_bench::{
    canonical::to_pretty_json, AttributedSummary, Case, CaseLifecycle, CaseResolution,
    ContentDigest, EvaluationTask, EvidenceItem, EvidenceSnapshot, EvidenceSource, HeldContent,
    Observed, PrivacyClass, ReportedProblem, StrategyIdentity, VerificationStatus,
    VisibilityPolicy, CASE_SCHEMA_V1,
};
use cd_triage_bench_adapter::{
    MockCorrection, MockEnginePlan, MockSlotOutcome, MockSlotPlan, MockTerminalPlan,
    MockValidation, RecordingContext,
};
use cd_triage_sdk::{ModelRef, TriageContributorRole, TriagePolicySelectionV2, TriageSlotKindV2};

pub const CASE_ID: &str = "case-checkout-500s";
pub const CREATED_AT: &str = "2026-01-15T07:00:00Z";
pub const CANCELLATION_ID: &str = "cancel-fixture-1";

/// Directory holding committed golden fixtures.
pub fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures")
}

/// Compare `actual` against a committed golden.
///
/// Set `UPDATE_ADAPTER_FIXTURES=1` to rewrite the goldens after an intentional
/// change; CI never sets it, so a drifting adapter fails the suite.
pub fn assert_golden(name: &str, actual: &str) {
    let path = fixtures_dir().join(name);
    if std::env::var_os("UPDATE_ADAPTER_FIXTURES").is_some() {
        fs::create_dir_all(path.parent().expect("fixtures dir")).expect("create fixtures dir");
        fs::write(&path, actual).expect("write golden");
    }
    let expected = fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("missing golden {}: {error}", path.display()));
    assert_eq!(
        expected, actual,
        "golden {name} is stale; re-run with UPDATE_ADAPTER_FIXTURES=1 if the change is intended"
    );
}

/// Serialize deterministically for golden comparison.
pub fn golden_json<T: serde::Serialize>(value: &T) -> String {
    to_pretty_json(value).expect("pretty json")
}

pub fn model(profile: &str, model_id: &str) -> ModelRef {
    ModelRef {
        profile_id: profile.into(),
        model_id: model_id.into(),
    }
}

/// A resolved case. The resolution is evaluation-only and must never reach a
/// packet, a request, or a share-safe export.
pub fn case() -> Case {
    Case {
        schema_id: CASE_SCHEMA_V1.into(),
        case_id: CASE_ID.into(),
        privacy: PrivacyClass::OwnerOnly,
        title: "Checkout returns 500 during evening peak".into(),
        reported_problem: ReportedProblem {
            summary: "Checkout begins returning 500 responses around 04:10Z.".into(),
            reported_at: Some("2026-01-15T04:20:00Z".into()),
            reporter: Some("duty-operator".into()),
            symptoms: vec!["500 on POST /checkout".into(), "elevated latency".into()],
        },
        lifecycle: CaseLifecycle::Resolved,
        timeline_notes: vec![],
        created_at: "2026-01-15T00:00:00Z".into(),
        resolution: Some(CaseResolution {
            adjudicated_root_cause: Some("inventory service connection pool exhaustion".into()),
            fix: Some("raise pool size and add a bounded queue".into()),
            domain_expertise: Some("this SKU service has failed this way before".into()),
            notes: Some("evaluation-only: never show to a strategy".into()),
        }),
    }
}

fn log_bytes() -> &'static [u8] {
    b"2026-01-15T04:12:00Z ERROR checkout upstream inventory timeout\n"
}

fn mail_bytes() -> &'static [u8] {
    b"Subject: checkout alerts\n\nPaging: checkout error rate above threshold.\n"
}

/// Four items: three strategy-visible, one the snapshot withholds.
pub fn snapshot() -> EvidenceSnapshot {
    EvidenceSnapshot::from_parts(
        PrivacyClass::OwnerOnly,
        CASE_ID.into(),
        "2026-01-15T06:00:00Z".into(),
        "duty-operator".into(),
        vec![
            EvidenceItem::Log {
                item_id: "ev-hidden-1".into(),
                privacy: PrivacyClass::OwnerOnly,
                capture_time: "2026-01-15T04:12:00Z".into(),
                source: EvidenceSource {
                    reference: "restricted/audit.log".into(),
                    captured_from: "synthetic fixture".into(),
                },
                media_type: "text/plain".into(),
                format: "raw".into(),
                content: HeldContent {
                    digest: ContentDigest::of_bytes(b"withheld\n"),
                    byte_length: 9,
                },
                summaries: vec![],
                // The snapshot itself withholds this item from every strategy.
                visible_to_strategies: false,
            },
            EvidenceItem::Log {
                item_id: "ev-log-1".into(),
                privacy: PrivacyClass::OwnerOnly,
                capture_time: "2026-01-15T04:12:00Z".into(),
                source: EvidenceSource {
                    reference: "app/checkout.log".into(),
                    captured_from: "synthetic fixture".into(),
                },
                media_type: "text/plain".into(),
                format: "raw".into(),
                content: HeldContent {
                    digest: ContentDigest::of_bytes(log_bytes()),
                    byte_length: log_bytes().len() as u64,
                },
                summaries: vec![AttributedSummary {
                    author: "duty-operator".into(),
                    kind: "human".into(),
                    text: "Upstream inventory timeouts start at 04:12Z.".into(),
                    created_at: "2026-01-15T05:00:00Z".into(),
                }],
                visible_to_strategies: true,
            },
            EvidenceItem::Email {
                item_id: "ev-mail-1".into(),
                privacy: PrivacyClass::OwnerOnly,
                capture_time: "2026-01-15T04:25:00Z".into(),
                source: EvidenceSource {
                    reference: "alerts mailbox".into(),
                    captured_from: "synthetic fixture".into(),
                },
                media_type: "message/rfc822".into(),
                content: HeldContent {
                    digest: ContentDigest::of_bytes(mail_bytes()),
                    byte_length: mail_bytes().len() as u64,
                },
                summaries: vec![],
                visible_to_strategies: true,
            },
            EvidenceItem::ExternalFileServerReference {
                item_id: "ev-ref-1".into(),
                privacy: PrivacyClass::OwnerOnly,
                capture_time: "2026-01-15T04:30:00Z".into(),
                source: EvidenceSource {
                    reference: "fileserver archives, incident bundle".into(),
                    captured_from: "synthetic fixture".into(),
                },
                uri: "fileserver-archives/incident-bundle.bin".into(),
                expected_content_digest: None,
                verification: VerificationStatus::Unverified,
                summaries: vec![],
                visible_to_strategies: true,
            },
        ],
        Some("synthetic fixture snapshot".into()),
    )
    .expect("fixture snapshot")
}

/// A task over the three visible items.
pub fn task(snapshot: &EvidenceSnapshot) -> EvaluationTask {
    task_with_visibility(
        snapshot,
        vec!["ev-log-1".into(), "ev-mail-1".into(), "ev-ref-1".into()],
    )
}

pub fn task_with_visibility(
    snapshot: &EvidenceSnapshot,
    visible_item_ids: Vec<String>,
) -> EvaluationTask {
    EvaluationTask::from_parts(
        PrivacyClass::OwnerOnly,
        CASE_ID.into(),
        snapshot.snapshot_id.clone(),
        "What initiated the checkout failures, and what evidence supports it?".into(),
        "Answer only from the visible evidence in this packet. Say so when evidence is missing."
            .into(),
        "v1".into(),
        VisibilityPolicy {
            visible_item_ids,
            include_summaries: true,
            include_raw_bytes: true,
        },
        None,
        CREATED_AT.into(),
    )
    .expect("fixture task")
}

pub fn policy() -> TriagePolicySelectionV2 {
    TriagePolicySelectionV2::Saved {
        policy_id: "policy-triage-enhanced".into(),
        policy_revision: 3,
    }
}

pub fn context() -> RecordingContext {
    RecordingContext {
        strategy: StrategyIdentity {
            name: "contextdesk".into(),
            version: Observed::Known("0.1.0".into()),
            build: Observed::Unknown,
        },
        operator: "duty-operator".into(),
        created_at: CREATED_AT.into(),
    }
}

fn slots(finalizer_outcome: MockSlotOutcome) -> Vec<MockSlotPlan> {
    vec![
        MockSlotPlan {
            role_slot_id: "observe".into(),
            role: TriageSlotKindV2::Contributor(TriageContributorRole::ObservationExtractor),
            model: model("gateway-alpha", "model-observe"),
            outcome: MockSlotOutcome::completed(),
        },
        MockSlotPlan {
            role_slot_id: "contradict".into(),
            role: TriageSlotKindV2::Contributor(TriageContributorRole::ContradictionChecker),
            model: model("gateway-beta", "vendor/model-contradict"),
            outcome: MockSlotOutcome::completed(),
        },
        MockSlotPlan {
            role_slot_id: "review".into(),
            role: TriageSlotKindV2::Reviewer,
            model: model("gateway-gamma", "model-review"),
            outcome: MockSlotOutcome::completed(),
        },
        MockSlotPlan {
            role_slot_id: "finalize".into(),
            role: TriageSlotKindV2::Finalizer,
            model: model("gateway-delta", "model-finalize"),
            outcome: finalizer_outcome,
        },
    ]
}

/// Every slot completes and the run reaches a grounded final answer.
pub fn plan_complete() -> MockEnginePlan {
    MockEnginePlan {
        slots: slots(MockSlotOutcome::completed()),
        validation: Some(MockValidation {
            passed: true,
            reason_codes: vec![],
        }),
        correction: Some(MockCorrection {
            applied: false,
            reason_codes: vec!["no_correction_needed".into()],
        }),
        terminal: MockTerminalPlan::Completed,
    }
}

/// The run completes but only reaches an honest partial result.
pub fn plan_partial() -> MockEnginePlan {
    MockEnginePlan {
        slots: slots(MockSlotOutcome::Abstained),
        validation: Some(MockValidation {
            passed: false,
            reason_codes: vec!["finalizer_abstained".into()],
        }),
        correction: None,
        terminal: MockTerminalPlan::CompletedPartial,
    }
}

/// The run fails, and still carries partial output as provenance.
pub fn plan_failed() -> MockEnginePlan {
    MockEnginePlan {
        slots: slots(MockSlotOutcome::Failed),
        validation: Some(MockValidation {
            passed: false,
            reason_codes: vec!["finalizer_failed".into()],
        }),
        correction: None,
        terminal: MockTerminalPlan::Failed {
            category: "provider_unavailable".into(),
            partial_result: true,
        },
    }
}

/// The run exceeds its deadline, and carries partial output as provenance.
pub fn plan_timed_out() -> MockEnginePlan {
    MockEnginePlan {
        slots: slots(MockSlotOutcome::TimedOut),
        validation: Some(MockValidation {
            passed: false,
            reason_codes: vec!["deadline".into()],
        }),
        correction: None,
        terminal: MockTerminalPlan::TimedOut {
            category: "whole_turn_deadline".into(),
            partial_result: true,
        },
    }
}

/// The run is cancelled before the host validation checkpoint.
pub fn plan_cancelled() -> MockEnginePlan {
    MockEnginePlan {
        slots: slots(MockSlotOutcome::Cancelled),
        validation: None,
        correction: None,
        terminal: MockTerminalPlan::Cancelled {
            partial_result: false,
        },
    }
}

/// The legacy single-finalizer shape, with no contributors or reviewer.
pub fn plan_standard() -> MockEnginePlan {
    MockEnginePlan {
        slots: vec![MockSlotPlan {
            role_slot_id: "finalize".into(),
            role: TriageSlotKindV2::Finalizer,
            model: model("gateway-delta", "model-finalize"),
            outcome: MockSlotOutcome::completed(),
        }],
        validation: Some(MockValidation {
            passed: true,
            reason_codes: vec![],
        }),
        correction: None,
        terminal: MockTerminalPlan::Completed,
    }
}

/// Every slot is refused admission, as a policy preflight rejection would
/// leave them. The bench still records a run rather than discarding it.
pub fn plan_preflight_rejected() -> MockEnginePlan {
    let mut plan = plan_complete();
    for slot in &mut plan.slots {
        slot.outcome = MockSlotOutcome::NotAdmitted;
    }
    plan.validation = Some(MockValidation {
        passed: false,
        reason_codes: vec!["policy_preflight_rejected".into()],
    });
    plan.correction = None;
    plan.terminal = MockTerminalPlan::Failed {
        category: "policy_preflight_rejected".into(),
        partial_result: true,
    };
    plan
}
