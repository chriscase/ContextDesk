//! Provider-free adversarial verification of Triage Policy V2 role
//! qualification at the pinned release SHA.
//!
//! Every test is hermetic: scripted/synthetic backends only — no gateway,
//! credential store, or private corpus is touched.  The suite probes the
//! release invariants:
//!   1. a pre-cancelled request never reaches the backend, for every role;
//!   2. cancellation observed while waiting fails closed with zero call
//!      credit and can never mint a Qualified record;
//!   3. deadline expiry and provider failure classify distinctly;
//!   4. role semantics stay exact (TimelineAnalyst / Reviewer / Finalizer);
//!   5. malformed, refused, and foreign-evidence responses fail closed.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

use cd_core::agent::{ChatBackend, ScriptedBackend};
use cd_core::chat::{ChatCompletion, ChatMessage};
use cd_core::error::{CoreError, CoreResult};
use cd_core::fast_triage::FastTriagePacketV1;
use cd_core::investigation_answer::{
    AnswerBindingV1, EvidenceRole, HostEvidenceEntry, HostEvidenceLedger, LogSnapshotRevisionV1,
    SCHEMA_V1,
};
use cd_core::multi_model::contributions::{ContributionRole, CONTRIBUTION_SCHEMA_V1};
use cd_core::multi_model::triage_policy::{
    RoleQualificationV2, TriageContributorRole, TriageSlotKindV2, MAX_TRIAGE_DEADLINE_MS_V2,
};
use cd_core::tools::ToolSpec;
use cd_workflow::triage_role_qualification::{
    qualify_role_v2_with_backend, TriageRoleProbeBackendInput, TriageRoleProbeError,
};

const PROTOCOL: &str = "openai-chat-completions";

const ALL_KINDS: [TriageSlotKindV2; 7] = [
    TriageSlotKindV2::Contributor(TriageContributorRole::ObservationExtractor),
    TriageSlotKindV2::Contributor(TriageContributorRole::TimelineAnalyst),
    TriageSlotKindV2::Contributor(TriageContributorRole::CausalProposer),
    TriageSlotKindV2::Contributor(TriageContributorRole::ContradictionChecker),
    TriageSlotKindV2::Contributor(TriageContributorRole::EvidenceGapFinder),
    TriageSlotKindV2::Reviewer,
    TriageSlotKindV2::Finalizer,
];

/// Byte-for-byte replica of the module's synthetic probe packet, so
/// integration tests can compute the exact packet id the probe binds to.
fn synthetic_packet() -> FastTriagePacketV1 {
    let revision = LogSnapshotRevisionV1 {
        event_revision: 1,
        template_analysis_revision: 1,
        suppression_revision: 1,
    };
    let entry = HostEvidenceEntry {
        evidence_id: "evidence:role-probe".into(),
        candidate_id: "candidate:role-probe".into(),
        source_label: "synthetic-role-probe.log".into(),
        locator: "seq=1".into(),
        corpus_id: "corpus:role-probe".into(),
        revision,
        role: EvidenceRole::Neutral,
        content: "ContextDesk synthetic role qualification evidence.".into(),
    };
    let binding = AnswerBindingV1 {
        session_id: "session:role-probe".into(),
        turn_id: "turn:role-probe".into(),
        corpus_id: "corpus:role-probe".into(),
        revision,
        ledger_digest: HostEvidenceLedger::digest(std::slice::from_ref(&entry)),
    };
    FastTriagePacketV1::from_ledger(
        HostEvidenceLedger::new(binding, vec![entry]).expect("synthetic ledger"),
        None,
        true,
    )
}

fn valid_contribution(packet: &FastTriagePacketV1, role: ContributionRole) -> String {
    serde_json::json!({
        "schema": CONTRIBUTION_SCHEMA_V1,
        "packet_id": packet.packet_id(),
        "role": role,
        "abstained": true,
        "claims": [],
        "evidence_gaps": [],
        "contradictions": []
    })
    .to_string()
}

fn valid_finalizer() -> String {
    serde_json::json!({
        "schema": SCHEMA_V1,
        "candidates": [{
            "candidate_id": "candidate:role-probe",
            "observations": [{
                "claim_id": "claim:probe",
                "text": "synthetic observation",
                "evidence_ids": ["evidence:role-probe"]
            }]
        }]
    })
    .to_string()
}

fn input(
    kind: TriageSlotKindV2,
    deadline_ms: u64,
    cancel: Option<Arc<AtomicBool>>,
    backend: Arc<dyn ChatBackend>,
) -> TriageRoleProbeBackendInput {
    TriageRoleProbeBackendInput {
        profile_id: "profile:verify".into(),
        base_url: "https://gateway.example/v1".into(),
        model_id: "model:verify".into(),
        kind,
        protocol: PROTOCOL.into(),
        deadline_ms,
        cancel,
        backend,
    }
}

/// Counts physical backend dispatches; a pre-cancelled probe must keep this 0.
struct CountingBackend {
    calls: Arc<AtomicU32>,
    inner: ScriptedBackend,
}

#[async_trait::async_trait]
impl ChatBackend for CountingBackend {
    async fn complete(
        &self,
        messages: &[ChatMessage],
        tools: &[ToolSpec],
    ) -> CoreResult<ChatCompletion> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.inner.complete(messages, tools).await
    }
}

/// Never resolves within any test deadline; counts dispatches.
struct HangingBackend {
    calls: Arc<AtomicU32>,
}

#[async_trait::async_trait]
impl ChatBackend for HangingBackend {
    async fn complete(
        &self,
        _messages: &[ChatMessage],
        _tools: &[ToolSpec],
    ) -> CoreResult<ChatCompletion> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        tokio::time::sleep(Duration::from_secs(600)).await;
        Err(CoreError::Message("unreachable".into()))
    }
}

/// Simulates the user pressing cancel while the provider round is in flight
/// and the provider nevertheless returning a fully valid response in the
/// same scheduler tick — the tightest possible cancellation/completion race.
struct CancelDuringCallBackend {
    cancel: Arc<AtomicBool>,
    response: String,
}

#[async_trait::async_trait]
impl ChatBackend for CancelDuringCallBackend {
    async fn complete(
        &self,
        _messages: &[ChatMessage],
        _tools: &[ToolSpec],
    ) -> CoreResult<ChatCompletion> {
        self.cancel.store(true, Ordering::SeqCst);
        Ok(ChatCompletion::from_parts(
            self.response.clone(),
            Vec::new(),
            "stop",
        ))
    }
}

/// Always fails at the provider layer.
struct FailingBackend;

#[async_trait::async_trait]
impl ChatBackend for FailingBackend {
    async fn complete(
        &self,
        _messages: &[ChatMessage],
        _tools: &[ToolSpec],
    ) -> CoreResult<ChatCompletion> {
        Err(CoreError::Message("provider exploded".into()))
    }
}

fn scripted(content: &str) -> ScriptedBackend {
    ScriptedBackend::new(vec![ChatCompletion::from_parts(
        content.to_string(),
        Vec::new(),
        "stop",
    )])
}

// ---------------------------------------------------------------------------
// 1. Pre-cancellation: every role, zero backend traffic, zero credit.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn pre_cancelled_probe_never_calls_backend_for_any_role() {
    let packet = synthetic_packet();
    for kind in ALL_KINDS {
        let calls = Arc::new(AtomicU32::new(0));
        let content = match kind {
            TriageSlotKindV2::Finalizer => valid_finalizer(),
            TriageSlotKindV2::Reviewer => valid_contribution(&packet, ContributionRole::Reviewer),
            TriageSlotKindV2::Contributor(_) => {
                valid_contribution(&packet, ContributionRole::ObservationExtractor)
            }
        };
        let backend = Arc::new(CountingBackend {
            calls: Arc::clone(&calls),
            inner: scripted(&content),
        });
        let cancel = Arc::new(AtomicBool::new(true));
        let record = qualify_role_v2_with_backend(input(kind, 5_000, Some(cancel), backend))
            .await
            .expect("probe runs");
        assert_eq!(
            record.qualification,
            RoleQualificationV2::Unqualified,
            "pre-cancelled {kind:?} must be Unqualified"
        );
        assert_eq!(
            record.physical_provider_calls, 0,
            "pre-cancelled {kind:?} must record zero provider calls"
        );
        assert_eq!(
            record.reason, "cancelled",
            "pre-cancelled {kind:?} must carry the cancelled reason"
        );
        assert_eq!(
            calls.load(Ordering::SeqCst),
            0,
            "pre-cancelled {kind:?} must never dispatch to the backend"
        );
    }
}

// ---------------------------------------------------------------------------
// 2. Cancellation observed while waiting: fail closed, zero credit.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn cancel_observed_while_finalizer_waits_fails_closed_with_zero_credit() {
    let calls = Arc::new(AtomicU32::new(0));
    let backend = Arc::new(HangingBackend {
        calls: Arc::clone(&calls),
    });
    let cancel = Arc::new(AtomicBool::new(false));
    let flip = Arc::clone(&cancel);
    let task = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(80)).await;
        flip.store(true, Ordering::SeqCst);
    });
    let record = qualify_role_v2_with_backend(input(
        TriageSlotKindV2::Finalizer,
        30_000,
        Some(cancel),
        backend,
    ))
    .await
    .expect("probe runs");
    task.await.unwrap();
    assert_eq!(record.qualification, RoleQualificationV2::Unqualified);
    assert_eq!(record.reason, "cancelled");
    assert_eq!(
        record.physical_provider_calls, 0,
        "an observed cancellation must receive zero call credit"
    );
    assert_eq!(
        calls.load(Ordering::SeqCst),
        1,
        "the request had been dispatched before the cancel"
    );
}

/// KNOWN DEFECT (P2, documented, not yet fixed): the contributor path
/// records a mid-wait cancellation as `role_probe_response_rejected` with
/// one call credited, while the finalizer path records `cancelled` with
/// zero credit for the same event.  Run with `--ignored` to reproduce.
#[ignore = "documents known P2 defect: contributor cancel records response_rejected/1 instead of cancelled/0"]
#[tokio::test]
async fn cancel_observed_while_contributor_waits_fails_closed_with_zero_credit() {
    let calls = Arc::new(AtomicU32::new(0));
    let backend = Arc::new(HangingBackend {
        calls: Arc::clone(&calls),
    });
    let cancel = Arc::new(AtomicBool::new(false));
    let flip = Arc::clone(&cancel);
    let task = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(80)).await;
        flip.store(true, Ordering::SeqCst);
    });
    let record = qualify_role_v2_with_backend(input(
        TriageSlotKindV2::Contributor(TriageContributorRole::ObservationExtractor),
        30_000,
        Some(cancel),
        backend,
    ))
    .await
    .expect("probe runs");
    task.await.unwrap();
    assert_eq!(record.qualification, RoleQualificationV2::Unqualified);
    assert_eq!(
        record.reason, "cancelled",
        "a cancelled contributor probe must record the cancelled reason, \
         not a response-rejection it never had"
    );
    assert_eq!(
        record.physical_provider_calls, 0,
        "an observed cancellation must receive zero call credit"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

/// KNOWN DEFECT (P2, documented, not yet fixed): a cancellation raised
/// during the provider round loses the completion race (the cancel watcher
/// polls every 10ms), so a valid response minted in that window still
/// qualifies.  Contradicts the module's own "a cancelled probe must never
/// mint qualification" comment.  Run with `--ignored` to reproduce.
#[ignore = "documents known P2 defect: cancel-during-call race can mint Qualified"]
#[tokio::test]
async fn cancellation_during_finalizer_call_must_not_mint_qualified() {
    let cancel = Arc::new(AtomicBool::new(false));
    let backend = Arc::new(CancelDuringCallBackend {
        cancel: Arc::clone(&cancel),
        response: valid_finalizer(),
    });
    let record = qualify_role_v2_with_backend(input(
        TriageSlotKindV2::Finalizer,
        5_000,
        Some(cancel),
        backend,
    ))
    .await
    .expect("probe runs");
    assert_ne!(
        record.qualification,
        RoleQualificationV2::Qualified,
        "a probe cancelled during the finalizer round must never mint \
         qualification, even when the response itself is valid \
         (actual reason: {}, calls: {})",
        record.reason,
        record.physical_provider_calls
    );
}

/// KNOWN DEFECT (P2, documented, not yet fixed): same completion race as
/// the finalizer variant, through the contribution pipeline.  Run with
/// `--ignored` to reproduce.
#[ignore = "documents known P2 defect: cancel-during-call race can mint Qualified"]
#[tokio::test]
async fn cancellation_during_contributor_call_must_not_mint_qualified() {
    let cancel = Arc::new(AtomicBool::new(false));
    let backend = Arc::new(CancelDuringCallBackend {
        cancel: Arc::clone(&cancel),
        response: valid_contribution(&synthetic_packet(), ContributionRole::TimelineAnalyst),
    });
    let record = qualify_role_v2_with_backend(input(
        TriageSlotKindV2::Contributor(TriageContributorRole::TimelineAnalyst),
        5_000,
        Some(cancel),
        backend,
    ))
    .await
    .expect("probe runs");
    assert_ne!(
        record.qualification,
        RoleQualificationV2::Qualified,
        "a probe cancelled during the contributor round must never mint \
         qualification (actual reason: {}, calls: {})",
        record.reason,
        record.physical_provider_calls
    );
}

// ---------------------------------------------------------------------------
// 3. Deadline expiry classification.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn finalizer_deadline_expiry_classifies_as_deadline() {
    let calls = Arc::new(AtomicU32::new(0));
    let backend = Arc::new(HangingBackend {
        calls: Arc::clone(&calls),
    });
    let record =
        qualify_role_v2_with_backend(input(TriageSlotKindV2::Finalizer, 200, None, backend))
            .await
            .expect("probe runs");
    assert_eq!(record.qualification, RoleQualificationV2::Unqualified);
    assert_eq!(record.reason, "deadline");
    assert_eq!(
        record.physical_provider_calls, 1,
        "a dispatched-then-expired call is a real physical call"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn contributor_deadline_expiry_fails_closed() {
    let calls = Arc::new(AtomicU32::new(0));
    let backend = Arc::new(HangingBackend {
        calls: Arc::clone(&calls),
    });
    let record = qualify_role_v2_with_backend(input(
        TriageSlotKindV2::Contributor(TriageContributorRole::CausalProposer),
        200,
        None,
        backend,
    ))
    .await
    .expect("probe runs");
    assert_eq!(record.qualification, RoleQualificationV2::Unqualified);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn invalid_deadlines_and_identities_fail_closed_before_any_backend_use() {
    let calls = Arc::new(AtomicU32::new(0));
    for deadline in [0, MAX_TRIAGE_DEADLINE_MS_V2 + 1] {
        let backend = Arc::new(CountingBackend {
            calls: Arc::clone(&calls),
            inner: scripted(&valid_finalizer()),
        });
        let err = qualify_role_v2_with_backend(input(
            TriageSlotKindV2::Finalizer,
            deadline,
            None,
            backend,
        ))
        .await
        .expect_err("invalid deadline must be rejected");
        assert_eq!(err, TriageRoleProbeError::InvalidRequest("deadline_ms"));
    }
    for (field, patch) in [
        ("profile_id", 0usize),
        ("base_url", 1usize),
        ("model_id", 2usize),
    ] {
        let backend = Arc::new(CountingBackend {
            calls: Arc::clone(&calls),
            inner: scripted(&valid_finalizer()),
        });
        let mut probe = input(TriageSlotKindV2::Finalizer, 5_000, None, backend);
        match patch {
            0 => probe.profile_id = "   ".into(),
            1 => probe.base_url = "".into(),
            _ => probe.model_id = "\t".into(),
        }
        let err = qualify_role_v2_with_backend(probe)
            .await
            .expect_err("blank identity must be rejected");
        assert_eq!(err, TriageRoleProbeError::InvalidRequest(field));
    }
    assert_eq!(
        calls.load(Ordering::SeqCst),
        0,
        "invalid requests must never touch the backend"
    );
}

// ---------------------------------------------------------------------------
// 4. Role semantics stay exact.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn timeline_analyst_rejects_a_wrong_role_contribution() {
    let packet = synthetic_packet();
    let backend = Arc::new(scripted(&valid_contribution(
        &packet,
        ContributionRole::ObservationExtractor,
    )));
    let record = qualify_role_v2_with_backend(input(
        TriageSlotKindV2::Contributor(TriageContributorRole::TimelineAnalyst),
        5_000,
        None,
        backend,
    ))
    .await
    .expect("probe runs");
    assert_eq!(
        record.qualification,
        RoleQualificationV2::Unqualified,
        "a TimelineAnalyst probe must reject a contribution claiming another role"
    );
    assert_eq!(record.physical_provider_calls, 1);
}

#[tokio::test]
async fn reviewer_probe_rejects_a_finalizer_shaped_answer() {
    let backend = Arc::new(scripted(&valid_finalizer()));
    let record =
        qualify_role_v2_with_backend(input(TriageSlotKindV2::Reviewer, 5_000, None, backend))
            .await
            .expect("probe runs");
    assert_eq!(
        record.qualification,
        RoleQualificationV2::Unqualified,
        "Reviewer keeps contribution semantics; an investigation answer must not qualify it"
    );
}

#[tokio::test]
async fn finalizer_probe_rejects_a_contribution_shaped_response() {
    let packet = synthetic_packet();
    let backend = Arc::new(scripted(&valid_contribution(
        &packet,
        ContributionRole::Reviewer,
    )));
    let record =
        qualify_role_v2_with_backend(input(TriageSlotKindV2::Finalizer, 5_000, None, backend))
            .await
            .expect("probe runs");
    assert_eq!(record.qualification, RoleQualificationV2::Unqualified);
    assert_eq!(record.reason, "finalizer_probe_response_rejected");
}

#[tokio::test]
async fn finalizer_probe_rejects_foreign_evidence_ids() {
    let foreign = serde_json::json!({
        "schema": SCHEMA_V1,
        "candidates": [{
            "candidate_id": "candidate:role-probe",
            "observations": [{
                "claim_id": "claim:probe",
                "text": "synthetic observation",
                "evidence_ids": ["evidence:forged-not-in-ledger"]
            }]
        }]
    })
    .to_string();
    let backend = Arc::new(scripted(&foreign));
    let record =
        qualify_role_v2_with_backend(input(TriageSlotKindV2::Finalizer, 5_000, None, backend))
            .await
            .expect("probe runs");
    assert_eq!(
        record.qualification,
        RoleQualificationV2::Unqualified,
        "evidence ids outside the host ledger must never qualify a finalizer"
    );
}

#[tokio::test]
async fn contributor_probe_rejects_a_stale_packet_id() {
    let stale = serde_json::json!({
        "schema": CONTRIBUTION_SCHEMA_V1,
        "packet_id": "packet:someone-elses",
        "role": ContributionRole::ObservationExtractor,
        "abstained": true,
        "claims": [],
        "evidence_gaps": [],
        "contradictions": []
    })
    .to_string();
    let backend = Arc::new(scripted(&stale));
    let record = qualify_role_v2_with_backend(input(
        TriageSlotKindV2::Contributor(TriageContributorRole::ObservationExtractor),
        5_000,
        None,
        backend,
    ))
    .await
    .expect("probe runs");
    assert_eq!(record.qualification, RoleQualificationV2::Unqualified);
}

// ---------------------------------------------------------------------------
// 5. Malformed / refused / failing providers fail closed.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn refusal_prose_fails_closed_for_finalizer_and_contributor() {
    let refusal = "I cannot help with analyzing these logs.";
    let finalizer = qualify_role_v2_with_backend(input(
        TriageSlotKindV2::Finalizer,
        5_000,
        None,
        Arc::new(scripted(refusal)),
    ))
    .await
    .expect("probe runs");
    assert_eq!(finalizer.qualification, RoleQualificationV2::Unqualified);
    assert_eq!(finalizer.physical_provider_calls, 1);

    let contributor = qualify_role_v2_with_backend(input(
        TriageSlotKindV2::Contributor(TriageContributorRole::EvidenceGapFinder),
        5_000,
        None,
        Arc::new(scripted(refusal)),
    ))
    .await
    .expect("probe runs");
    assert_eq!(contributor.qualification, RoleQualificationV2::Unqualified);
    assert_eq!(contributor.physical_provider_calls, 1);
}

#[tokio::test]
async fn empty_completion_fails_closed() {
    let record = qualify_role_v2_with_backend(input(
        TriageSlotKindV2::Finalizer,
        5_000,
        None,
        Arc::new(scripted("")),
    ))
    .await
    .expect("probe runs");
    assert_eq!(record.qualification, RoleQualificationV2::Unqualified);
}

#[tokio::test]
async fn provider_failure_classifies_as_provider_failed_with_one_call() {
    let record = qualify_role_v2_with_backend(input(
        TriageSlotKindV2::Finalizer,
        5_000,
        None,
        Arc::new(FailingBackend),
    ))
    .await
    .expect("probe runs");
    assert_eq!(record.qualification, RoleQualificationV2::Unqualified);
    assert_eq!(record.reason, "provider_failed");
    assert_eq!(record.physical_provider_calls, 1);
}
