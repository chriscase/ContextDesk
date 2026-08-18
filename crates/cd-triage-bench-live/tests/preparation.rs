use std::sync::Arc;
use std::time::Duration;

use cd_core::process_progress::CancelFlag;
use cd_core::{
    capability_qualification::QualificationKey,
    keychain_store::MemorySecretStore,
    multi_model::triage_policy::{RoleQualificationV2, TriageSlotKindV2},
    providers::{ProviderConfig, ProviderKind, ProviderProfile},
    triage_policy_store::TriagePolicyStoreV1,
    triage_role_qualification::{
        triage_protocol_fingerprint, TriageRoleQualificationKeyV1, TriageRoleQualificationRecordV1,
        TriageRoleQualificationStoreV1,
    },
};
use cd_test_gateway::{Body, Frame, MockGateway, RecordedRequest, Response, Step};
use cd_triage_bench::report::build_report;
use cd_triage_bench::{
    BenchStore, Case, CaseLifecycle, ContentDigest, EvaluationTask, EvidenceItem, EvidenceSnapshot,
    EvidenceSource, HeldContent, Observed, PrivacyClass, ReportedProblem, StrategyIdentity,
    VisibilityPolicy, CASE_SCHEMA_V1,
};
use cd_triage_bench_live::{
    prepare_same_snapshot_corpus, run_live_comparison, run_live_same_snapshot, LiveBridgeError,
    LiveComparisonCandidate, LiveCorpusLimits, LiveRunOptions,
};
use cd_triage_sdk::{ModelRef, TriagePolicySelectionV2, TriageRequestOverridesV1};
use serde_json::{json, Value};

const CREATED_AT: &str = "2026-08-18T07:00:00Z";

fn fixture() -> (
    tempfile::TempDir,
    tempfile::TempDir,
    BenchStore,
    Case,
    EvidenceSnapshot,
    EvaluationTask,
) {
    let library_dir = tempfile::tempdir().unwrap();
    let cache_dir = tempfile::tempdir().unwrap();
    let store = BenchStore::init(library_dir.path(), CREATED_AT).unwrap();
    let case = Case {
        schema_id: CASE_SCHEMA_V1.into(),
        case_id: "case-live-1".into(),
        privacy: PrivacyClass::OwnerOnly,
        title: "Checkout outage".into(),
        reported_problem: ReportedProblem {
            summary: "checkout requests fail".into(),
            reported_at: None,
            reporter: None,
            symptoms: vec![],
        },
        lifecycle: CaseLifecycle::Unresolved,
        timeline_notes: vec![],
        created_at: CREATED_AT.into(),
        resolution: None,
    };
    case.validate().unwrap();

    let bytes = b"2026-08-18T06:59:58Z INFO checkout started\n2026-08-18T06:59:59Z ERROR database timeout\n";
    let digest = store.put_blob(bytes).unwrap();
    let snapshot = EvidenceSnapshot::from_parts(
        PrivacyClass::OwnerOnly,
        case.case_id.clone(),
        CREATED_AT.into(),
        "fixture".into(),
        vec![EvidenceItem::Log {
            item_id: "ev-log-1".into(),
            privacy: PrivacyClass::OwnerOnly,
            capture_time: CREATED_AT.into(),
            source: EvidenceSource {
                reference: "checkout.log".into(),
                captured_from: "fixture".into(),
            },
            media_type: "text/plain".into(),
            format: "raw".into(),
            content: HeldContent {
                digest,
                byte_length: bytes.len() as u64,
            },
            summaries: vec![],
            visible_to_strategies: true,
        }],
        None,
    )
    .unwrap();
    let task = EvaluationTask::from_parts(
        PrivacyClass::OwnerOnly,
        case.case_id.clone(),
        snapshot.snapshot_id.clone(),
        "What caused the checkout failure?".into(),
        "Use only the supplied evidence.".into(),
        "v1".into(),
        VisibilityPolicy {
            visible_item_ids: vec!["ev-log-1".into()],
            include_summaries: false,
            include_raw_bytes: true,
        },
        None,
        CREATED_AT.into(),
    )
    .unwrap();
    store.put_case(&case).unwrap();
    store.put_snapshot(&snapshot).unwrap();
    store.put_task(&task).unwrap();
    (library_dir, cache_dir, store, case, snapshot, task)
}

fn openai_profile(base_url: &str) -> ProviderProfile {
    ProviderProfile {
        id: "profile:live-fixture".into(),
        label: "live fixture".into(),
        kind: ProviderKind::OpenAiCompatible,
        base_url: format!("{base_url}/v1"),
        api_key_ref: None,
        chat_model: "model:live-fixture".into(),
        embedding_model: None,
        embedding_base_url: None,
        capabilities: Default::default(),
        local_only: true,
        deadline_preference: Default::default(),
    }
}

fn qualified_finalizer(profile: &ProviderProfile) -> TriageRoleQualificationStoreV1 {
    let transport = QualificationKey::with_provider_kind(
        &profile.id,
        &profile.base_url,
        &profile.chat_model,
        profile.kind,
    )
    .transport_protocol;
    let key = TriageRoleQualificationKeyV1::current(
        &profile.id,
        &profile.base_url,
        &profile.chat_model,
        TriageSlotKindV2::Finalizer,
        triage_protocol_fingerprint(&transport),
    );
    let mut store = TriageRoleQualificationStoreV1::default();
    store
        .put(TriageRoleQualificationRecordV1 {
            key,
            qualification: RoleQualificationV2::Qualified,
            physical_provider_calls: 1,
            semantic_corrections: 0,
            reason: "hermetic-live-fixture".into(),
            tested_at: 1,
        })
        .unwrap();
    store
}

fn answer_from_live_request(request: &RecordedRequest) -> Value {
    let body = request.json_body().expect("OpenAI request JSON");
    let content = body["messages"]
        .as_array()
        .and_then(|messages| messages.last())
        .and_then(|message| message["content"].as_str())
        .expect("final user message");
    let manifest = content
        .strip_prefix("PACKET MANIFEST (host scaffolding):\n")
        .and_then(|content| {
            content
                .split_once("\n\nPACKET EVIDENCE:")
                .map(|part| part.0)
        })
        .expect("packet manifest boundary");
    let manifest: Value = serde_json::from_str(manifest).expect("packet manifest JSON");
    let candidates = manifest["candidates"]
        .as_array()
        .expect("manifest candidates")
        .iter()
        .enumerate()
        .map(|(index, candidate)| {
            let candidate_id = candidate["candidate_id"].as_str().expect("candidate id");
            let evidence_id = candidate["permitted_evidence"]
                .as_array()
                .and_then(|ids| ids.first())
                .and_then(|evidence| evidence["evidence_id"].as_str())
                .expect("candidate evidence id");
            json!({
                "candidate_id": candidate_id,
                "observations": [{
                    "claim_id": format!("claim-live-{index}"),
                    "text": "host-bound observation",
                    "evidence_ids": [evidence_id]
                }]
            })
        })
        .collect::<Vec<_>>();
    json!({
        "id": "chatcmpl-live-fixture",
        "model": "model:live-fixture",
        "choices": [{
            "index": 0,
            "finish_reason": "stop",
            "message": {
                "role": "assistant",
                "content": json!({
                    "schema": "contextdesk.investigation_answer.v1",
                    "candidates": candidates
                }).to_string()
            }
        }]
    })
}

#[test]
fn prepares_exact_private_corpus_and_explicit_cleanup_removes_it() {
    let (_library, cache, store, case, snapshot, task) = fixture();
    let prepared = prepare_same_snapshot_corpus(
        &store,
        &case,
        &snapshot,
        &task,
        cache.path(),
        LiveCorpusLimits::default(),
        &CancelFlag::new(),
    )
    .unwrap();

    assert_eq!(prepared.bounded().visible_item_ids, vec!["ev-log-1"]);
    assert!(prepared.corpus_revision() > 0);
    assert_eq!(prepared.sources().len(), 1);
    assert_eq!(prepared.sources()[0].evidence_item_id, "ev-log-1");
    assert!(!prepared.sources()[0].source_label.contains("ev-log-1"));
    assert_eq!(
        prepared.sources()[0].content_digest,
        snapshot.items[0].held_content().unwrap().digest.wire()
    );
    let corpus_dir = cache.path().join("log_corpora").join(prepared.corpus_id());
    assert!(corpus_dir.exists());

    prepared.cleanup().unwrap();
    assert!(!corpus_dir.exists());
}

#[test]
fn drop_discards_the_isolated_corpus() {
    let (_library, cache, store, case, snapshot, task) = fixture();
    let corpus_id = {
        let prepared = prepare_same_snapshot_corpus(
            &store,
            &case,
            &snapshot,
            &task,
            cache.path(),
            LiveCorpusLimits::default(),
            &CancelFlag::new(),
        )
        .unwrap();
        prepared.corpus_id().to_string()
    };
    assert!(!cache.path().join("log_corpora").join(corpus_id).exists());
}

#[test]
fn rejects_unsupported_visibility_before_import() {
    let (_library, cache, store, case, snapshot, mut task) = fixture();
    task.visibility.include_summaries = true;
    let error = prepare_same_snapshot_corpus(
        &store,
        &case,
        &snapshot,
        &task,
        cache.path(),
        LiveCorpusLimits::default(),
        &CancelFlag::new(),
    )
    .unwrap_err();
    assert_eq!(error, LiveBridgeError::UnsupportedVisibility);
    assert!(!cache.path().join("log_corpora").exists());
}

#[test]
fn rejects_non_log_bytes_instead_of_relabelling_them_as_logs() {
    let (_library, cache, store, case, snapshot, _) = fixture();
    let content = snapshot.items[0].held_content().unwrap().clone();
    let email_snapshot = EvidenceSnapshot::from_parts(
        PrivacyClass::OwnerOnly,
        case.case_id.clone(),
        CREATED_AT.into(),
        "fixture".into(),
        vec![EvidenceItem::Email {
            item_id: "ev-email-1".into(),
            privacy: PrivacyClass::OwnerOnly,
            capture_time: CREATED_AT.into(),
            source: EvidenceSource {
                reference: "incident.eml".into(),
                captured_from: "fixture".into(),
            },
            media_type: "message/rfc822".into(),
            content,
            summaries: vec![],
            visible_to_strategies: true,
        }],
        None,
    )
    .unwrap();
    let email_task = EvaluationTask::from_parts(
        PrivacyClass::OwnerOnly,
        case.case_id.clone(),
        email_snapshot.snapshot_id.clone(),
        "What happened?".into(),
        "Use only the supplied evidence.".into(),
        "v1".into(),
        VisibilityPolicy {
            visible_item_ids: vec!["ev-email-1".into()],
            include_summaries: false,
            include_raw_bytes: true,
        },
        None,
        CREATED_AT.into(),
    )
    .unwrap();

    let error = prepare_same_snapshot_corpus(
        &store,
        &case,
        &email_snapshot,
        &email_task,
        cache.path(),
        LiveCorpusLimits::default(),
        &CancelFlag::new(),
    )
    .unwrap_err();
    assert_eq!(error, LiveBridgeError::UnsupportedVisibility);
    assert!(!cache.path().join("log_corpora").exists());
}

#[test]
fn rejects_aggregate_bound_and_cancellation_before_copy() {
    let (_library, cache, store, case, snapshot, task) = fixture();
    let error = prepare_same_snapshot_corpus(
        &store,
        &case,
        &snapshot,
        &task,
        cache.path(),
        LiveCorpusLimits {
            max_blob_bytes: u64::MAX,
            max_aggregate_bytes: 1,
        },
        &CancelFlag::new(),
    )
    .unwrap_err();
    assert_eq!(error, LiveBridgeError::BoundExceeded);

    let cancel = CancelFlag::new();
    cancel.cancel();
    let error = prepare_same_snapshot_corpus(
        &store,
        &case,
        &snapshot,
        &task,
        cache.path(),
        LiveCorpusLimits::default(),
        &cancel,
    )
    .unwrap_err();
    assert_eq!(error, LiveBridgeError::Cancelled);
}

#[test]
fn missing_or_changed_blob_fails_without_publishing_a_corpus() {
    let (_library, cache, store, case, mut snapshot, task) = fixture();
    if let EvidenceItem::Log { content, .. } = &mut snapshot.items[0] {
        content.digest = ContentDigest::of_bytes(b"different");
    }
    let error = prepare_same_snapshot_corpus(
        &store,
        &case,
        &snapshot,
        &task,
        cache.path(),
        LiveCorpusLimits::default(),
        &CancelFlag::new(),
    )
    .unwrap_err();
    assert!(matches!(
        error,
        LiveBridgeError::Benchmark | LiveBridgeError::Provenance
    ));
}

#[tokio::test]
async fn public_workflow_preflight_failure_is_recorded_persisted_and_cleaned() {
    let (_library, cache, store, case, snapshot, task) = fixture();
    let result = run_live_same_snapshot(
        &store,
        &case,
        &snapshot,
        &task,
        Arc::new(MemorySecretStore::new()),
        LiveRunOptions {
            cache_root: cache.path().to_path_buf(),
            config: cd_core::config::AppConfig::default(),
            policies: TriagePolicyStoreV1::default(),
            qualifications: TriageRoleQualificationStoreV1::default(),
            policy: TriagePolicySelectionV2::Standard {
                model: ModelRef {
                    profile_id: "profile:missing".into(),
                    model_id: "model:missing".into(),
                },
            },
            overrides: TriageRequestOverridesV1 {
                deadline_ms: Some(10_000),
                max_provider_calls: Some(1),
            },
            cancellation_id: "cancel:live-preflight".into(),
            recording: cd_triage_bench_adapter::RecordingContext {
                strategy: StrategyIdentity {
                    name: "ContextDesk live".into(),
                    version: Observed::Unknown,
                    build: Observed::Unknown,
                },
                operator: "test".into(),
                created_at: CREATED_AT.into(),
            },
            limits: LiveCorpusLimits::default(),
            cancel: CancelFlag::new(),
        },
        None,
    )
    .await
    .unwrap();

    assert_eq!(
        result.recorded.bench_run.status,
        cd_triage_bench::RunStatus::Failed
    );
    assert_eq!(
        result.recorded.owner_only.execution_packet_state,
        cd_triage_bench_adapter::ExecutionPacketState::NotProduced
    );
    assert!(result.recorded.owner_only.host_execution.is_none());
    assert_eq!(
        store
            .get_run(&result.recorded.bench_run.run_id)
            .unwrap()
            .run_id,
        result.recorded.bench_run.run_id
    );
    let corpus_root = cache.path().join("log_corpora");
    assert!(
        !corpus_root.exists() || corpus_root.read_dir().unwrap().next().is_none(),
        "run-exclusive corpus must be removed"
    );
}

#[tokio::test]
async fn real_packet_and_provider_path_records_same_snapshot_proof_and_cleans_up() {
    let gateway = MockGateway::start_routed(|request| {
        if request.path.ends_with("/chat/completions") {
            Step::respond(Response::json_ok(&answer_from_live_request(request)))
        } else {
            Step::respond(Response::status_only(404))
        }
    })
    .await;
    let (_library, cache, store, case, snapshot, task) = fixture();
    let profile = openai_profile(gateway.base_url());
    let qualifications = qualified_finalizer(&profile);
    let model = ModelRef {
        profile_id: profile.id.clone(),
        model_id: profile.chat_model.clone(),
    };
    let config = cd_core::config::AppConfig {
        providers: ProviderConfig {
            active_id: Some(profile.id.clone()),
            profiles: vec![profile],
        },
        ..Default::default()
    };

    let result = run_live_same_snapshot(
        &store,
        &case,
        &snapshot,
        &task,
        Arc::new(MemorySecretStore::new()),
        LiveRunOptions {
            cache_root: cache.path().to_path_buf(),
            config,
            policies: TriagePolicyStoreV1::default(),
            qualifications,
            policy: TriagePolicySelectionV2::Standard { model },
            overrides: TriageRequestOverridesV1 {
                deadline_ms: Some(300_000),
                max_provider_calls: None,
            },
            cancellation_id: "cancel:live-success".into(),
            recording: cd_triage_bench_adapter::RecordingContext {
                strategy: StrategyIdentity {
                    name: "ContextDesk live".into(),
                    version: Observed::Unknown,
                    build: Observed::Unknown,
                },
                operator: "test".into(),
                created_at: CREATED_AT.into(),
            },
            limits: LiveCorpusLimits::default(),
            cancel: CancelFlag::new(),
        },
        None,
    )
    .await
    .unwrap();

    assert_eq!(
        gateway.request_count(),
        1,
        "live replay: {:#?}",
        result.recorded.owner_only.replay
    );
    assert_eq!(
        result.recorded.bench_run.status,
        cd_triage_bench::RunStatus::Partial
    );
    assert_eq!(
        result.recorded.owner_only.execution_packet_state,
        cd_triage_bench_adapter::ExecutionPacketState::Matched
    );
    let proof = result
        .recorded
        .owner_only
        .host_execution
        .as_ref()
        .expect("authoritative host packet proof");
    assert_eq!(proof.sources.len(), 1);
    assert_eq!(proof.sources[0].evidence_item_id, "ev-log-1");
    assert!(proof
        .packet_source_labels
        .contains(&proof.sources[0].source_label));
    assert!(!result.recorded.bench_run.claims.is_empty());
    assert!(result
        .recorded
        .bench_run
        .claims
        .iter()
        .all(|claim| claim.evidence_item_id.as_deref() == Some("ev-log-1")));
    assert_eq!(
        store
            .get_run(&result.recorded.bench_run.run_id)
            .unwrap()
            .run_id,
        result.recorded.bench_run.run_id
    );
    let corpus_root = cache.path().join("log_corpora");
    assert!(
        !corpus_root.exists() || corpus_root.read_dir().unwrap().next().is_none(),
        "run-exclusive corpus must be removed"
    );
}

#[tokio::test]
async fn comparison_reuses_one_proven_snapshot_and_feeds_the_honest_report() {
    let gateway = MockGateway::start_routed(|request| {
        if request.path.ends_with("/chat/completions") {
            Step::respond(Response::json_ok(&answer_from_live_request(request)))
        } else {
            Step::respond(Response::status_only(404))
        }
    })
    .await;
    let (_library, cache, store, case, snapshot, task) = fixture();
    let profile = openai_profile(gateway.base_url());
    let mut alternate_profile = openai_profile(gateway.base_url());
    alternate_profile.id = "profile:live-fixture-beta".into();
    alternate_profile.label = "live fixture beta".into();
    alternate_profile.chat_model = "model:live-fixture-beta".into();
    let qualifications = qualified_finalizer(&profile);
    let alternate_qualifications = qualified_finalizer(&alternate_profile);
    let model = ModelRef {
        profile_id: profile.id.clone(),
        model_id: profile.chat_model.clone(),
    };
    let alternate_model = ModelRef {
        profile_id: alternate_profile.id.clone(),
        model_id: alternate_profile.chat_model.clone(),
    };
    let config = cd_core::config::AppConfig {
        providers: ProviderConfig {
            active_id: Some(profile.id.clone()),
            profiles: vec![profile],
        },
        ..Default::default()
    };
    let alternate_config = cd_core::config::AppConfig {
        providers: ProviderConfig {
            active_id: Some(alternate_profile.id.clone()),
            profiles: vec![alternate_profile],
        },
        ..Default::default()
    };
    let cancel = CancelFlag::new();

    let candidate = |name: &str,
                     cancellation_id: &str,
                     config: cd_core::config::AppConfig,
                     qualifications: TriageRoleQualificationStoreV1,
                     model: ModelRef| LiveComparisonCandidate {
        options: LiveRunOptions {
            cache_root: cache.path().to_path_buf(),
            config,
            policies: TriagePolicyStoreV1::default(),
            qualifications,
            policy: TriagePolicySelectionV2::Standard { model },
            overrides: TriageRequestOverridesV1 {
                deadline_ms: Some(300_000),
                max_provider_calls: None,
            },
            cancellation_id: cancellation_id.into(),
            recording: cd_triage_bench_adapter::RecordingContext {
                strategy: StrategyIdentity {
                    name: name.into(),
                    version: Observed::Known("comparison-v1".into()),
                    build: Observed::Unknown,
                },
                operator: "test".into(),
                created_at: CREATED_AT.into(),
            },
            limits: LiveCorpusLimits::default(),
            cancel: cancel.clone(),
        },
        events: None,
    };

    let result = run_live_comparison(
        &store,
        &case,
        &snapshot,
        &task,
        Arc::new(MemorySecretStore::new()),
        vec![
            candidate(
                "ContextDesk live alpha",
                "cancel:comparison-alpha",
                config,
                qualifications,
                model,
            ),
            candidate(
                "ContextDesk live beta",
                "cancel:comparison-beta",
                alternate_config,
                alternate_qualifications,
                alternate_model,
            ),
        ],
    )
    .await
    .unwrap();

    assert_eq!(result.runs.len(), 2);
    assert_eq!(gateway.request_count(), 2);
    let requests = gateway.requests();
    let models = requests
        .iter()
        .map(|request| {
            request.json_body().unwrap()["model"]
                .as_str()
                .unwrap()
                .to_owned()
        })
        .collect::<Vec<_>>();
    assert_eq!(
        models,
        vec!["model:live-fixture", "model:live-fixture-beta"]
    );
    assert_ne!(
        result.runs[0].recorded.bench_run.run_id,
        result.runs[1].recorded.bench_run.run_id
    );
    let first_proof = result.runs[0]
        .recorded
        .owner_only
        .host_execution
        .as_ref()
        .expect("first host proof");
    let second_proof = result.runs[1]
        .recorded
        .owner_only
        .host_execution
        .as_ref()
        .expect("second host proof");
    assert_eq!(first_proof.corpus_id, second_proof.corpus_id);
    assert_eq!(first_proof.corpus_revision, second_proof.corpus_revision);
    assert_eq!(
        result.runs[0].recorded.owner_only.fingerprints.packet,
        result.runs[1].recorded.owner_only.fingerprints.packet
    );

    let report = build_report(
        &store.load_runs().unwrap(),
        &[],
        &[],
        &store.load_cases().unwrap(),
        PrivacyClass::OwnerOnly,
    )
    .unwrap();
    assert_eq!(report.counts.runs, 2);
    assert_eq!(report.groups.len(), 1);
    assert_eq!(report.groups[0].runs.len(), 2);
    assert!(report.incomparable.is_empty());
}

#[tokio::test]
async fn comparison_rejects_empty_candidates_before_preparation() {
    let (_library, cache, store, case, snapshot, task) = fixture();
    let error = run_live_comparison(
        &store,
        &case,
        &snapshot,
        &task,
        Arc::new(MemorySecretStore::new()),
        Vec::new(),
    )
    .await
    .unwrap_err();
    assert_eq!(error, LiveBridgeError::EmptyComparison);
    assert!(!cache.path().join("log_corpora").exists());
}

#[tokio::test]
async fn cancellation_after_packet_is_recorded_and_cleans_up() {
    let provider_started = Arc::new(tokio::sync::Notify::new());
    let notify_route = Arc::clone(&provider_started);
    let gateway = MockGateway::start_routed(move |request| {
        if request.path.ends_with("/chat/completions") {
            notify_route.notify_one();
            Step::respond(
                Response::new(
                    200,
                    Body::Stream(vec![Frame::delayed(
                        b"data: {}\n\n".to_vec(),
                        Duration::from_millis(100),
                    )]),
                )
                .with_header("content-type", "text/event-stream"),
            )
        } else {
            Step::respond(Response::status_only(404))
        }
    })
    .await;
    let (_library, cache, store, case, snapshot, task) = fixture();
    let profile = openai_profile(gateway.base_url());
    let qualifications = qualified_finalizer(&profile);
    let model = ModelRef {
        profile_id: profile.id.clone(),
        model_id: profile.chat_model.clone(),
    };
    let config = cd_core::config::AppConfig {
        providers: ProviderConfig {
            active_id: Some(profile.id.clone()),
            profiles: vec![profile],
        },
        ..Default::default()
    };
    let cancel = CancelFlag::new();
    let cancel_after_start = cancel.clone();
    let cancellation = tokio::spawn(async move {
        provider_started.notified().await;
        cancel_after_start.cancel();
    });

    let result = run_live_same_snapshot(
        &store,
        &case,
        &snapshot,
        &task,
        Arc::new(MemorySecretStore::new()),
        LiveRunOptions {
            cache_root: cache.path().to_path_buf(),
            config,
            policies: TriagePolicyStoreV1::default(),
            qualifications,
            policy: TriagePolicySelectionV2::Standard { model },
            overrides: TriageRequestOverridesV1 {
                deadline_ms: Some(300_000),
                max_provider_calls: None,
            },
            cancellation_id: "cancel:live-in-flight".into(),
            recording: cd_triage_bench_adapter::RecordingContext {
                strategy: StrategyIdentity {
                    name: "ContextDesk live".into(),
                    version: Observed::Unknown,
                    build: Observed::Unknown,
                },
                operator: "test".into(),
                created_at: CREATED_AT.into(),
            },
            limits: LiveCorpusLimits::default(),
            cancel,
        },
        None,
    )
    .await
    .unwrap();
    cancellation.await.unwrap();

    assert_eq!(gateway.request_count(), 1);
    assert_eq!(
        result.recorded.bench_run.status,
        cd_triage_bench::RunStatus::Cancelled
    );
    assert_eq!(
        result.recorded.owner_only.execution_packet_state,
        cd_triage_bench_adapter::ExecutionPacketState::Matched
    );
    assert!(result.recorded.owner_only.host_execution.is_some());
    let corpus_root = cache.path().join("log_corpora");
    assert!(
        !corpus_root.exists() || corpus_root.read_dir().unwrap().next().is_none(),
        "run-exclusive corpus must be removed"
    );
}
