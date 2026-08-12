//! Adversarial hermetic audit of exact-role qualification for Triage Policy V2.
//!
//! Drives **shipped** entry points only:
//! - [`cd_workflow::triage_role_qualification::qualify_role_v2_with_backend`]
//! - [`cd_workflow::triage_host::preflight_for_policy`]
//! - [`cd_core::triage_role_qualification::TriageRoleQualificationStoreV1`]
//!
//! No network, credentials, Keychain, live corpus, or provider HTTP.
//! ScriptedBackend only. Generic capability stores are never consulted.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use cd_core::agent::{ChatBackend, ScriptedBackend};
use cd_core::chat::{ChatCompletion, ChatMessage};
use cd_core::config::AppConfig;
use cd_core::error::CoreResult;
use cd_core::fast_triage::FastTriagePacketV1;
use cd_core::investigation_answer::SCHEMA_V1;
use cd_core::model_ref::ModelRef;
use cd_core::multi_model::contributions::{ContributionRole, CONTRIBUTION_SCHEMA_V1};
use cd_core::multi_model::triage_policy::{
    RoleQualificationV2, TriageContributorRole, TriagePolicyMode, TriagePolicyV2, TriageSlotKindV2,
};
use cd_core::providers::ProviderProfile;
use cd_core::tools::ToolSpec;
use cd_core::triage_role_qualification::{
    triage_protocol_fingerprint, TriageRoleQualificationKeyV1, TriageRoleQualificationRecordV1,
    TriageRoleQualificationStoreV1,
};
use cd_workflow::triage_host::preflight_for_policy;
use cd_workflow::triage_role_qualification::{
    qualify_role_v2_with_backend, TriageRoleProbeBackendInput,
};
use serde_json::json;

const PROFILE: &str = "profile:audit";
const MODEL: &str = "model:audit";
const BASE_URL: &str = "https://gateway.example.invalid/v1";
const PROTOCOL: &str = "openai-chat-completions";

fn packet() -> FastTriagePacketV1 {
    // Must match the synthetic packet used by the production probe.
    // We re-run a valid contribution against the same identity constants
    // the probe embeds (evidence:role-probe / candidate:role-probe).
    // The probe builds its own packet internally; tests only need correct
    // claim shapes for ScriptedBackend responses.
    //
    // Access packet_id via a one-shot qualify helper's known constants.
    // For building bodies we use the literal ids from the production probe.
    // (See triage_role_qualification::synthetic_packet.)
    // Construct a local packet with the same ids for helpers that need one.
    use cd_core::investigation_answer::{
        AnswerBindingV1, EvidenceRole, HostEvidenceEntry, HostEvidenceLedger, LogSnapshotRevisionV1,
    };
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
        HostEvidenceLedger::new(binding, vec![entry]).expect("ledger"),
        None,
        true,
    )
}

fn input(
    kind: TriageSlotKindV2,
    backend: Arc<dyn ChatBackend>,
    cancel: Option<Arc<AtomicBool>>,
) -> TriageRoleProbeBackendInput {
    TriageRoleProbeBackendInput {
        profile_id: PROFILE.into(),
        base_url: BASE_URL.into(),
        model_id: MODEL.into(),
        kind,
        protocol: PROTOCOL.into(),
        deadline_ms: 5_000,
        cancel,
        backend,
    }
}

fn scripted(body: impl Into<String>) -> Arc<dyn ChatBackend> {
    Arc::new(ScriptedBackend::new(vec![ChatCompletion::from_parts(
        body.into(),
        Vec::new(),
        "stop",
    )]))
}

/// Counts `complete_streaming` invocations so zero-call proofs are not theater.
struct CountingBackend {
    inner: ScriptedBackend,
    calls: Arc<AtomicUsize>,
}

#[async_trait]
impl ChatBackend for CountingBackend {
    async fn complete(
        &self,
        messages: &[ChatMessage],
        tools: &[ToolSpec],
    ) -> CoreResult<ChatCompletion> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.inner.complete(messages, tools).await
    }

    async fn complete_streaming(
        &self,
        messages: &[ChatMessage],
        tools: &[ToolSpec],
        on_text: &mut (dyn FnMut(String) + Send),
        cancel: Option<&AtomicBool>,
    ) -> CoreResult<ChatCompletion> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.inner
            .complete_streaming(messages, tools, on_text, cancel)
            .await
    }
}

fn counting(body: impl Into<String>) -> (Arc<dyn ChatBackend>, Arc<AtomicUsize>) {
    let calls = Arc::new(AtomicUsize::new(0));
    let backend: Arc<dyn ChatBackend> = Arc::new(CountingBackend {
        inner: ScriptedBackend::new(vec![ChatCompletion::from_parts(
            body.into(),
            Vec::new(),
            "stop",
        )]),
        calls: Arc::clone(&calls),
    });
    (backend, calls)
}

fn valid_contribution(pkt: &FastTriagePacketV1, role: ContributionRole) -> String {
    json!({
        "schema": CONTRIBUTION_SCHEMA_V1,
        "packet_id": pkt.packet_id(),
        "role": role,
        "abstained": true,
        "claims": [],
        "evidence_gaps": [],
        "contradictions": []
    })
    .to_string()
}

fn valid_finalizer() -> String {
    json!({
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

// ---------------------------------------------------------------------------
// 1–2. Valid probes qualify only via production pipeline / host validator
// ---------------------------------------------------------------------------

#[tokio::test]
async fn q1_valid_contributor_qualifies_only_via_contribution_pipeline() {
    let pkt = packet();
    let role = ContributionRole::ObservationExtractor;
    let (backend, calls) = counting(valid_contribution(&pkt, role));
    let record = qualify_role_v2_with_backend(input(
        TriageSlotKindV2::Contributor(TriageContributorRole::ObservationExtractor),
        backend,
        None,
    ))
    .await
    .expect("probe");
    assert_eq!(record.qualification, RoleQualificationV2::Qualified);
    assert_eq!(record.physical_provider_calls, 1);
    assert_eq!(record.semantic_corrections, 0);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(record.reason, "role_probe_passed");
    // Record must not carry raw provider body or URL
    let encoded = serde_json::to_string(&record).unwrap();
    assert!(!encoded.contains("gateway.example"));
    assert!(!encoded.contains(CONTRIBUTION_SCHEMA_V1) || encoded.contains("role_probe"));
    assert!(!encoded.contains("sk-"));
}

#[tokio::test]
async fn q2_valid_finalizer_qualifies_only_via_host_packet_validator() {
    let (backend, calls) = counting(valid_finalizer());
    let record = qualify_role_v2_with_backend(input(TriageSlotKindV2::Finalizer, backend, None))
        .await
        .expect("probe");
    assert_eq!(record.qualification, RoleQualificationV2::Qualified);
    assert_eq!(record.physical_provider_calls, 1);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(record.reason, "role_probe_passed");
}

// ---------------------------------------------------------------------------
// 3. Fail-closed classes (no qualification credit)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn q3_wrong_schema_fails_closed() {
    let pkt = packet();
    let body = json!({
        "schema": "contextdesk.multi_model.contribution.v99",
        "packet_id": pkt.packet_id(),
        "role": ContributionRole::CausalProposer,
        "abstained": true,
        "claims": [],
        "evidence_gaps": [],
        "contradictions": []
    })
    .to_string();
    let record = qualify_role_v2_with_backend(input(
        TriageSlotKindV2::Contributor(TriageContributorRole::CausalProposer),
        scripted(body),
        None,
    ))
    .await
    .expect("probe");
    assert_eq!(record.qualification, RoleQualificationV2::Unqualified);
    assert_eq!(record.reason, "role_probe_response_rejected");
}

#[tokio::test]
async fn q3_wrong_role_fails_closed() {
    let pkt = packet();
    // Assigned CausalProposer but body claims ObservationExtractor.
    let body = valid_contribution(&pkt, ContributionRole::ObservationExtractor);
    let record = qualify_role_v2_with_backend(input(
        TriageSlotKindV2::Contributor(TriageContributorRole::CausalProposer),
        scripted(body),
        None,
    ))
    .await
    .expect("probe");
    assert_eq!(record.qualification, RoleQualificationV2::Unqualified);
}

#[tokio::test]
async fn q3_stale_packet_fails_closed() {
    let body = json!({
        "schema": CONTRIBUTION_SCHEMA_V1,
        "packet_id": "packet:stale-or-foreign",
        "role": ContributionRole::ContradictionChecker,
        "abstained": true,
        "claims": [],
        "evidence_gaps": [],
        "contradictions": []
    })
    .to_string();
    let record = qualify_role_v2_with_backend(input(
        TriageSlotKindV2::Contributor(TriageContributorRole::ContradictionChecker),
        scripted(body),
        None,
    ))
    .await
    .expect("probe");
    assert_eq!(record.qualification, RoleQualificationV2::Unqualified);
}

#[tokio::test]
async fn q3_foreign_candidate_and_evidence_fail_closed() {
    let pkt = packet();
    let foreign_candidate = json!({
        "schema": CONTRIBUTION_SCHEMA_V1,
        "packet_id": pkt.packet_id(),
        "role": ContributionRole::CausalProposer,
        "abstained": false,
        "claims": [{
            "claim_id": "c1",
            "candidate_id": "candidate:foreign",
            "kind": "causal_candidate",
            "text": "foreign",
            "evidence_ids": ["evidence:role-probe"]
        }],
        "evidence_gaps": [],
        "contradictions": []
    })
    .to_string();
    let record = qualify_role_v2_with_backend(input(
        TriageSlotKindV2::Contributor(TriageContributorRole::CausalProposer),
        scripted(foreign_candidate),
        None,
    ))
    .await
    .expect("probe");
    assert_eq!(record.qualification, RoleQualificationV2::Unqualified);

    let foreign_evidence = json!({
        "schema": CONTRIBUTION_SCHEMA_V1,
        "packet_id": pkt.packet_id(),
        "role": ContributionRole::ObservationExtractor,
        "abstained": false,
        "claims": [{
            "claim_id": "o1",
            "candidate_id": "candidate:role-probe",
            "kind": "observation",
            "text": "foreign evidence",
            "evidence_ids": ["evidence:not-in-packet"]
        }],
        "evidence_gaps": [],
        "contradictions": []
    })
    .to_string();
    let record = qualify_role_v2_with_backend(input(
        TriageSlotKindV2::Contributor(TriageContributorRole::ObservationExtractor),
        scripted(foreign_evidence),
        None,
    ))
    .await
    .expect("probe");
    assert_eq!(record.qualification, RoleQualificationV2::Unqualified);
}

#[tokio::test]
async fn q3_malformed_json_and_reasoning_wrapper_fail_closed() {
    let malformed = qualify_role_v2_with_backend(input(
        TriageSlotKindV2::Contributor(TriageContributorRole::EvidenceGapFinder),
        scripted("not json at all"),
        None,
    ))
    .await
    .expect("probe");
    assert_eq!(malformed.qualification, RoleQualificationV2::Unqualified);
    assert_eq!(malformed.physical_provider_calls, 1);

    let pkt = packet();
    let wrapped = format!(
        "Thinking...\n```json\n{}\n```\n",
        valid_contribution(&pkt, ContributionRole::ObservationExtractor)
    );
    let wrapped_record = qualify_role_v2_with_backend(input(
        TriageSlotKindV2::Contributor(TriageContributorRole::ObservationExtractor),
        scripted(wrapped),
        None,
    ))
    .await
    .expect("probe");
    assert_eq!(
        wrapped_record.qualification,
        RoleQualificationV2::Unqualified,
        "reasoning wrapper / markdown fences must not grant qualification"
    );

    let finalizer_foreign = json!({
        "schema": SCHEMA_V1,
        "candidates": [{
            "candidate_id": "candidate:role-probe",
            "observations": [{
                "claim_id": "claim:probe",
                "text": "bad",
                "evidence_ids": ["evidence:foreign"]
            }]
        }]
    })
    .to_string();
    let fin = qualify_role_v2_with_backend(input(
        TriageSlotKindV2::Finalizer,
        scripted(finalizer_foreign),
        None,
    ))
    .await
    .expect("probe");
    assert_eq!(fin.qualification, RoleQualificationV2::Unqualified);
}

// ---------------------------------------------------------------------------
// 4. TimelineAnalyst / Reviewer zero provider calls
// ---------------------------------------------------------------------------

#[tokio::test]
async fn q4_timeline_and_reviewer_make_zero_provider_calls() {
    let (backend, calls) = counting(valid_finalizer());
    let timeline = qualify_role_v2_with_backend(input(
        TriageSlotKindV2::Contributor(TriageContributorRole::TimelineAnalyst),
        Arc::clone(&backend),
        None,
    ))
    .await
    .expect("probe");
    assert_eq!(timeline.qualification, RoleQualificationV2::Unqualified);
    assert_eq!(timeline.physical_provider_calls, 0);
    assert_eq!(timeline.reason, "timeline_role_unsupported");
    assert_eq!(calls.load(Ordering::SeqCst), 0);

    let reviewer = qualify_role_v2_with_backend(input(TriageSlotKindV2::Reviewer, backend, None))
        .await
        .expect("probe");
    assert_eq!(reviewer.qualification, RoleQualificationV2::Unqualified);
    assert_eq!(reviewer.physical_provider_calls, 0);
    assert_eq!(reviewer.reason, "reviewer_execution_unavailable");
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

// ---------------------------------------------------------------------------
// 5. Cancel / deadline never receive qualification credit
// ---------------------------------------------------------------------------

#[tokio::test]
async fn q5_pre_cancel_never_qualifies_and_makes_zero_calls() {
    let cancel = Arc::new(AtomicBool::new(true));
    let (backend, calls) = counting(valid_finalizer());
    let record = qualify_role_v2_with_backend(input(
        TriageSlotKindV2::Finalizer,
        backend,
        Some(Arc::clone(&cancel)),
    ))
    .await
    .expect("probe");
    assert_eq!(record.qualification, RoleQualificationV2::Unqualified);
    assert_eq!(record.physical_provider_calls, 0);
    assert_eq!(record.reason, "cancelled");
    assert_eq!(calls.load(Ordering::SeqCst), 0);

    let pkt = packet();
    let (backend, calls) = counting(valid_contribution(
        &pkt,
        ContributionRole::ObservationExtractor,
    ));
    let record = qualify_role_v2_with_backend(input(
        TriageSlotKindV2::Contributor(TriageContributorRole::ObservationExtractor),
        backend,
        Some(cancel),
    ))
    .await
    .expect("probe");
    assert_eq!(record.qualification, RoleQualificationV2::Unqualified);
    assert_eq!(record.physical_provider_calls, 0);
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn q5_deadline_never_qualifies() {
    // Backend that never completes within a tiny deadline: ScriptedBackend is
    // instant, so force deadline_ms=0 is InvalidRequest. Use 1ms with a
    // hanging backend.
    struct HangBackend;
    #[async_trait]
    impl ChatBackend for HangBackend {
        async fn complete(
            &self,
            _messages: &[ChatMessage],
            _tools: &[ToolSpec],
        ) -> CoreResult<ChatCompletion> {
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
            unreachable!()
        }
        async fn complete_streaming(
            &self,
            messages: &[ChatMessage],
            tools: &[ToolSpec],
            _on_text: &mut (dyn FnMut(String) + Send),
            _cancel: Option<&AtomicBool>,
        ) -> CoreResult<ChatCompletion> {
            self.complete(messages, tools).await
        }
    }
    let mut req = input(TriageSlotKindV2::Finalizer, Arc::new(HangBackend), None);
    req.deadline_ms = 20;
    let record = qualify_role_v2_with_backend(req).await.expect("probe");
    assert_eq!(record.qualification, RoleQualificationV2::Unqualified);
    assert_ne!(record.reason, "role_probe_passed");
    // Honest non-zero call accounting when the provider race was entered.
    assert!(
        record.physical_provider_calls <= 1,
        "deadline must not invent multi-call credit"
    );
}

// ---------------------------------------------------------------------------
// 6. Exact identity isolates sibling models / roles / endpoints / protocols
// ---------------------------------------------------------------------------

#[test]
fn q6_exact_identity_isolates_siblings_in_store_and_preflight() {
    // Build profile first so the key matches preflight_for_policy's transport fingerprint.
    let mut cfg = AppConfig::default();
    let mut profile = ProviderProfile::ollama_local();
    profile.id = PROFILE.into();
    profile.base_url = BASE_URL.into();
    profile.chat_model = MODEL.into();
    cfg.providers.profiles.push(profile.clone());
    let transport = cd_core::capability_qualification::QualificationKey::with_provider_kind(
        &profile.id,
        &profile.base_url,
        &profile.chat_model,
        profile.kind,
    )
    .transport_protocol;
    let proto_fp = triage_protocol_fingerprint(&transport);

    let mut store = TriageRoleQualificationStoreV1::default();
    let key_a = TriageRoleQualificationKeyV1::current(
        PROFILE,
        BASE_URL,
        MODEL,
        TriageSlotKindV2::Finalizer,
        proto_fp.clone(),
    );
    store
        .put(TriageRoleQualificationRecordV1 {
            key: key_a.clone(),
            qualification: RoleQualificationV2::Qualified,
            physical_provider_calls: 1,
            semantic_corrections: 0,
            reason: "probe_ok".into(),
            tested_at: 1,
        })
        .unwrap();

    // Sibling model
    let key_model = TriageRoleQualificationKeyV1::current(
        PROFILE,
        BASE_URL,
        "model:sibling",
        TriageSlotKindV2::Finalizer,
        proto_fp.clone(),
    );
    assert!(store.get(&key_model).is_none());

    // Sibling role
    let key_role = TriageRoleQualificationKeyV1::current(
        PROFILE,
        BASE_URL,
        MODEL,
        TriageSlotKindV2::Contributor(TriageContributorRole::ObservationExtractor),
        proto_fp.clone(),
    );
    assert!(store.get(&key_role).is_none());

    // Sibling endpoint
    let key_ep = TriageRoleQualificationKeyV1::current(
        PROFILE,
        "https://other.example.invalid/v1",
        MODEL,
        TriageSlotKindV2::Finalizer,
        proto_fp.clone(),
    );
    assert!(store.get(&key_ep).is_none());

    // Sibling protocol
    let key_proto = TriageRoleQualificationKeyV1::current(
        PROFILE,
        BASE_URL,
        MODEL,
        TriageSlotKindV2::Finalizer,
        triage_protocol_fingerprint("anthropic-messages"),
    );
    assert!(store.get(&key_proto).is_none());

    assert!(store.get(&key_a).is_some());

    // Shared preflight must not promote a sibling model from generic store hits.
    let mut policy = TriagePolicyV2::standard(
        ModelRef {
            profile_id: PROFILE.into(),
            model_id: MODEL.into(),
        },
        false,
    );
    policy.mode = TriagePolicyMode::Enhanced;
    let preflight = preflight_for_policy(&cfg, &policy, &store);
    assert_eq!(
        preflight.roles[0].qualification,
        RoleQualificationV2::Qualified
    );
    policy.finalizer.as_mut().unwrap().model.model_id = "model:sibling".into();
    let sibling = preflight_for_policy(&cfg, &policy, &store);
    assert_eq!(
        sibling.roles[0].qualification,
        RoleQualificationV2::Unverified
    );
}

// ---------------------------------------------------------------------------
// 7. Persisted records: no secrets, URLs, raw bodies, paths, unbounded text
// ---------------------------------------------------------------------------

#[test]
fn q7_persisted_records_are_secret_free_and_bounded() {
    let mut store = TriageRoleQualificationStoreV1::default();
    let key = TriageRoleQualificationKeyV1::current(
        PROFILE,
        BASE_URL,
        MODEL,
        TriageSlotKindV2::Finalizer,
        triage_protocol_fingerprint(PROTOCOL),
    );
    store
        .put(TriageRoleQualificationRecordV1 {
            key: key.clone(),
            qualification: RoleQualificationV2::Qualified,
            physical_provider_calls: 1,
            semantic_corrections: 0,
            reason: "role_probe_passed".into(),
            tested_at: 42,
        })
        .unwrap();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("triage-role-qualifications.json");
    store.save(&path).unwrap();
    let raw = std::fs::read_to_string(&path).unwrap();
    for forbidden in [
        "sk-",
        "Bearer ",
        "api_key",
        "https://",
        "http://",
        "/Users/",
        "gateway.example",
        "password",
        "Authorization",
    ] {
        assert!(
            !raw.contains(forbidden),
            "store must not contain {forbidden}: {raw}"
        );
    }
    // Endpoint is fingerprint only
    assert!(raw.contains("endpoint_fingerprint"));
    assert!(raw.contains("sha256:"));
    // Reason bound enforced
    let mut long = store.records[0].clone();
    long.reason = "x".repeat(300);
    assert!(TriageRoleQualificationStoreV1::default().put(long).is_err());
}

// ---------------------------------------------------------------------------
// 8. Shared resolver / CLI cannot admit caller preflight or generic capability
// ---------------------------------------------------------------------------

#[test]
fn q8_preflight_ignores_generic_capability_and_requires_exact_role_store() {
    // Empty role store → Unverified even if a profile exists (no generic credit).
    let mut cfg = AppConfig::default();
    let mut profile = ProviderProfile::ollama_local();
    profile.id = PROFILE.into();
    profile.base_url = BASE_URL.into();
    profile.chat_model = MODEL.into();
    cfg.providers.profiles.push(profile);
    let mut policy = TriagePolicyV2::standard(
        ModelRef {
            profile_id: PROFILE.into(),
            model_id: MODEL.into(),
        },
        false,
    );
    policy.mode = TriagePolicyMode::Enhanced;
    let empty = TriageRoleQualificationStoreV1::default();
    let preflight = preflight_for_policy(&cfg, &policy, &empty);
    assert_eq!(
        preflight.roles[0].qualification,
        RoleQualificationV2::Unverified,
        "empty exact-role store must not invent Qualified from transport alone"
    );
}

#[test]
fn q8_cli_source_refuses_caller_supplied_preflight_literal() {
    // Structural: live CLI path must reject --preflight before host resolver.
    let src = include_str!("../../cd-cli/src/commands/triage.rs");
    assert!(
        src.contains("caller_preflight_not_authoritative"),
        "CLI must refuse caller-supplied preflight for live execution"
    );
    assert!(
        src.contains("preflight_for_policy"),
        "CLI live path must use shared preflight_for_policy"
    );
    assert!(
        src.contains("if args.preflight.is_some()"),
        "CLI must gate on args.preflight being present"
    );
}

#[test]
fn q8_tauri_host_uses_shared_preflight_for_policy() {
    let src = include_str!("../../../desktop/src-tauri/src/lib.rs");
    assert!(
        src.contains("triage_preflight_for_policy"),
        "Tauri must expose shared preflight helper"
    );
    assert!(
        src.contains("cd_workflow::triage_host::preflight_for_policy"),
        "Tauri must delegate to shared preflight_for_policy"
    );
    // Must not accept a webview-supplied preflight JSON as authoritative.
    assert!(
        !src.contains("preflight_from_webview") && !src.contains("caller_preflight_json"),
        "no webview-authored preflight authority path"
    );
}
