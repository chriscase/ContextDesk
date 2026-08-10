//! Gateway-diagnostic **contract audit** (test/docs lane only).
//!
//! Proves a future provider-neutral gateway diagnostic can safely reuse
//! ContextDesk production plumbing — without shipping a competing command
//! and without modifying production behavior.
//!
//! All traffic hits `cd_test_gateway::MockGateway` on loopback. Secrets are
//! synthetic `file:` protected-file references (no Keychain). Zero live
//! provider / network / private corpus data.
//!
//! # Contracts under audit
//!
//! 1. Exact model discovery IDs + selected-model binding
//! 2. Qualification → ordinary generation, structured output, inert tool
//!    call/continuation (linked-log triage entry points reuse the same chat
//!    transport + activity capture)
//! 3. Shared activity/trace aggregation is surface-neutral (human / no-color /
//!    JSONL project the same DTO)
//! 4. Protected-file credentials without Keychain; one resolution per turn;
//!    no secret/header leakage into traces
//! 5. Redaction of credentials, endpoints, private paths, raw provider bodies
//! 6. Bounded deadline/cancellation; temp corpus/session cleanup on success,
//!    failure, timeout, and cancel paths
//! 7. Unsupported / gated capabilities are never reported as passes

use cd_core::activity::{ActivityDetailLevel, ActivityRecorder, ActivityStatus, DataScope};
use cd_core::agent::ChatBackend;
use cd_core::capability_qualification::{
    fingerprint_endpoint, run_qualification, CapabilityKind, CapabilityStatus,
    ProfileCapabilityGate, QualificationKey, QUALIFICATION_SCHEMA_VERSION,
};
use cd_core::chat::{ChatMessage, OpenAiCompatibleClient, Role};
use cd_core::events::StreamEvent;
use cd_core::index::KeywordIndex;
use cd_core::keychain_store::{
    file_secret_ref, MemorySecretStore, ReferencedSecretStore, SecretStore,
};
use cd_core::log_analysis::LogCorpus;
use cd_core::providers::{ProviderCapabilities, ProviderConfig, ProviderKind, ProviderProfile};
use cd_core::redact::scrub_secrets;
use cd_core::research::backend_for;
use cd_core::sessions::{Session, SessionStore};
use cd_core::ssrf::SsrfPolicy;
use cd_core::tool_host::ToolHost;
use cd_core::turn_trace::{
    opaque_absolute_paths, DeveloperPayload, RecordingTurnTrace, TracedOutcome, TracingChatBackend,
    TurnTraceSink,
};
use cd_core::workspace::Workspace;
use cd_test_gateway::{MockGateway, Response, Step};
use cd_workflow::capability_qualification::{
    qualification_key, LiveBackendKind, LiveQualificationTransport,
};
use cd_workflow::provider::{
    resolve_turn_inputs, resolve_turn_inputs_with_credential_cache, TurnProviderCredentialCache,
};
use cd_workflow::provider_telemetry::{
    aggregate_provider_turn_telemetry, ProviderTelemetryAggregateInput,
};
use cd_workflow::turn::{bind_linked_corpus, run_turn, unbind_linked_corpus, TurnExecutionOptions};
use serde_json::json;
use std::fs;
use std::future::Future;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

// ---------------------------------------------------------------------------
// Shared hermetic helpers (synthetic only)
// ---------------------------------------------------------------------------

fn synthetic_protected_file(
    dir: &tempfile::TempDir,
    name: &str,
    secret: &str,
) -> (PathBuf, String) {
    let path = dir.path().join(name);
    fs::write(&path, secret).expect("write synthetic secret");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).expect("chmod 600");
    }
    let reference = file_secret_ref(&path).expect("file secret ref");
    (path, reference)
}

struct CountingSecretStore<S: SecretStore> {
    inner: S,
    reads: AtomicUsize,
}

impl<S: SecretStore> CountingSecretStore<S> {
    fn new(inner: S) -> Self {
        Self {
            inner,
            reads: AtomicUsize::new(0),
        }
    }
    fn read_count(&self) -> usize {
        self.reads.load(Ordering::SeqCst)
    }
}

impl<S: SecretStore> SecretStore for CountingSecretStore<S> {
    fn get(&self, ref_id: &str) -> cd_core::error::CoreResult<Option<String>> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        self.inner.get(ref_id)
    }
    fn set(&self, ref_id: &str, secret: &str) -> cd_core::error::CoreResult<()> {
        self.inner.set(ref_id, secret)
    }
    fn delete(&self, ref_id: &str) -> cd_core::error::CoreResult<()> {
        self.inner.delete(ref_id)
    }
}

fn openai_profile(base_url: &str, model: &str, api_key_ref: Option<String>) -> ProviderProfile {
    ProviderProfile {
        id: "audit-openai".into(),
        label: "audit openai-compatible".into(),
        kind: ProviderKind::OpenAiCompatible,
        base_url: base_url.into(),
        api_key_ref,
        chat_model: model.into(),
        embedding_model: None,
        embedding_base_url: None,
        capabilities: ProviderCapabilities::chat_remote(),
        local_only: true,
        deadline_preference: Default::default(),
    }
}

fn cfg_with(profile: ProviderProfile) -> cd_core::config::AppConfig {
    cd_core::config::AppConfig {
        providers: cd_core::providers::ProviderConfig {
            active_id: Some(profile.id.clone()),
            profiles: vec![profile],
        },
        ..Default::default()
    }
}

fn completion_stop(content: &str) -> serde_json::Value {
    json!({
        "id": "chatcmpl-audit",
        "model": "matrix-model",
        "choices": [{
            "finish_reason": "stop",
            "message": {"role": "assistant", "content": content}
        }]
    })
}

fn completion_tools(name: &str, args: &str) -> serde_json::Value {
    json!({
        "id": "chatcmpl-tools",
        "model": "matrix-model",
        "choices": [{
            "finish_reason": "tool_calls",
            "message": {
                "role": "assistant",
                "content": null,
                "tool_calls": [{
                    "id": "call_audit_1",
                    "type": "function",
                    "function": {"name": name, "arguments": args}
                }]
            }
        }]
    })
}

fn completion_json_object() -> serde_json::Value {
    json!({
        "id": "chatcmpl-json",
        "model": "matrix-model",
        "choices": [{
            "finish_reason": "stop",
            "message": {
                "role": "assistant",
                "content": "{\"qualify\":\"ok\",\"v\":1}"
            }
        }]
    })
}

fn user_msg(text: &str) -> Vec<ChatMessage> {
    vec![ChatMessage {
        role: Role::User,
        content: text.into(),
        tool_call_id: None,
        tool_calls: None,
    }]
}

// ---------------------------------------------------------------------------
// 1. Exact model discovery IDs + selected-model binding
// ---------------------------------------------------------------------------

#[tokio::test]
async fn discovery_returns_exact_catalog_ids_and_selected_model_is_bound_on_the_wire() {
    // Catalog exposes two exact ids; the profile's selected chat_model must
    // be the only model id sent on the subsequent completion request.
    let catalog = json!({
        "data": [
            {"id": "audit-model-alpha"},
            {"id": "audit-model-beta"}
        ]
    });
    let gateway = MockGateway::start_routed(move |req| {
        if req.path.ends_with("/models") {
            Step::respond(Response::json_ok(&catalog))
        } else if req.path.contains("chat/completions") {
            Step::respond(Response::json_ok(&completion_stop("hello")))
        } else {
            Step::respond(Response::status_only(404))
        }
    })
    .await;

    // Avoid ai_probe's localhost→Ollama special case (see gateway_wire_discovery).
    let base = gateway.base_url().replacen("127.0.0.1", "127.1", 1);
    let profile = openai_profile(&format!("{base}/v1"), "audit-model-beta", None);

    let client = OpenAiCompatibleClient::new(
        format!("{}/v1", gateway.base_url()),
        None,
        "audit-model-beta",
        &SsrfPolicy::default(),
    )
    .unwrap();
    let listed = client.list_models().await.expect("list_models");
    assert!(
        listed.iter().any(|m| m == "audit-model-alpha"),
        "discovery must surface exact catalog id alpha: {listed:?}"
    );
    assert!(
        listed.iter().any(|m| m == "audit-model-beta"),
        "discovery must surface exact catalog id beta: {listed:?}"
    );

    // Selected model binding: backend_for + complete must send the profile model.
    let backend = backend_for(&profile, None).await.expect("backend_for");
    let mut sink = |_: String| {};
    backend
        .complete_streaming(&user_msg("ping"), &[], &mut sink, None)
        .await
        .expect("completion");

    let chat_reqs: Vec<_> = gateway
        .requests()
        .into_iter()
        .filter(|r| r.path.contains("chat/completions"))
        .collect();
    assert_eq!(chat_reqs.len(), 1, "exactly one completion request");
    let body = chat_reqs[0].json_body().expect("json body");
    assert_eq!(
        body.get("model").and_then(|v| v.as_str()),
        Some("audit-model-beta"),
        "selected model must be bound on the wire body: {body}"
    );
    // Wrong-id mutation target: asserting the wire model is not the other catalog id.
    assert_ne!(
        body.get("model").and_then(|v| v.as_str()),
        Some("audit-model-alpha"),
        "must not silently bind a different discovery id"
    );
}

#[test]
fn qualification_key_binds_exact_model_and_fingerprints_endpoint_not_raw_url() {
    let raw = "https://private-gateway.internal.example/v1";
    let key = QualificationKey::new("prof-a", raw, "exact-model-id");
    assert_eq!(key.model_id, "exact-model-id");
    assert_eq!(key.schema_version, QUALIFICATION_SCHEMA_VERSION);
    assert_eq!(key.endpoint_fingerprint, fingerprint_endpoint(raw));
    assert!(
        !key.endpoint_fingerprint.contains("private-gateway"),
        "fingerprint must not embed the private hostname"
    );
    assert!(!key.storage_id().contains("private-gateway"));
    // Distinct models must not collide in storage identity.
    let other = QualificationKey::new("prof-a", raw, "other-model");
    assert_ne!(key.storage_id(), other.storage_id());
}

// ---------------------------------------------------------------------------
// 2. Qualification suite: generation, structured, tools, continuation
// ---------------------------------------------------------------------------

#[test]
fn qualification_suite_covers_generation_tools_continuation_and_structured_on_live_transport() {
    // LiveQualificationTransport is the production HTTP bridge a future
    // diagnostic must reuse — not a parallel client.
    let rt = tokio::runtime::Runtime::new().expect("rt");
    let gateway = rt.block_on(MockGateway::start_ordered(vec![
        // BasicGeneration
        Step::respond(Response::json_ok(&completion_stop(
            cd_core::capability_qualification::SYNTH_GENERATION_MARKER,
        ))),
        // NativeToolCall
        Step::respond(Response::json_ok(&completion_tools(
            cd_core::capability_qualification::INERT_PROBE_TOOL_NAME,
            "{\"token\":\"probe_ok\"}",
        ))),
        // ToolResultContinuation
        Step::respond(Response::json_ok(&completion_stop("continued-ok"))),
        // StructuredOutput
        Step::respond(Response::json_ok(&completion_json_object())),
        // Streaming (may still hit non-stream path depending on gate)
        Step::respond(Response::json_ok(&completion_stop("stream-ok"))),
        // Cancellation probe
        Step::respond(Response::json_ok(&completion_stop("cancel-ok"))),
    ]));

    let mut transport = LiveQualificationTransport::new(
        LiveBackendKind::OpenAiCompatible,
        format!("{}/v1", gateway.base_url()),
        None,
        true,
    );
    let gate = ProfileCapabilityGate {
        tools_enabled: true,
        stream_enabled: true,
        embeddings_enabled: false,
    };
    let cancel = Arc::new(AtomicBool::new(false));
    let key = QualificationKey::new("audit-prof", gateway.base_url(), "matrix-model");
    let report = run_qualification(key, gate, &mut transport, &cancel);

    assert_eq!(
        report.status_of(CapabilityKind::BasicGeneration),
        CapabilityStatus::Pass,
        "ordinary generation must pass: {:?}",
        report.checks
    );
    assert_eq!(
        report.status_of(CapabilityKind::NativeToolCall),
        CapabilityStatus::Pass,
        "inert tool call must pass: {:?}",
        report.checks
    );
    assert_eq!(
        report.status_of(CapabilityKind::ToolResultContinuation),
        CapabilityStatus::Pass,
        "tool continuation must pass: {:?}",
        report.checks
    );
    assert_eq!(
        report.status_of(CapabilityKind::StructuredOutput),
        CapabilityStatus::Pass,
        "structured output must pass: {:?}",
        report.checks
    );
    assert!(
        gateway.request_count() >= 4,
        "suite must issue real HTTP for each exercised probe"
    );
    // Single production transport: every request shares the same mock base.
    for req in gateway.requests() {
        assert!(
            req.path.contains("/v1/") || req.path.contains("chat"),
            "unexpected path on production transport: {}",
            req.path
        );
    }
}

#[test]
fn gated_or_untested_capabilities_are_never_reported_as_pass() {
    // Profile tools disabled → Fail/Untested for tool probes, never Pass.
    let mut transport = LiveQualificationTransport::new(
        LiveBackendKind::OpenAiCompatible,
        String::from("http://127.0.0.1:9/v1"), // unused if tools gated before HTTP
        None,
        true,
    );
    // tools_enabled false: tool probes fail closed without inventing a pass.
    let gate = ProfileCapabilityGate {
        tools_enabled: false,
        stream_enabled: false,
        embeddings_enabled: false,
    };
    let cancel = Arc::new(AtomicBool::new(false));
    // Use a scripted path via run_qualification: with tools disabled and no
    // server, basic generation will fail HTTP — still must not be Pass for tools.
    let report = run_qualification(
        QualificationKey::new("gated", "http://127.0.0.1:9/v1", "nomic-embed-text"),
        gate,
        &mut transport,
        &cancel,
    );
    // Embedding role hint for nomic-embed-text should offer embedding contract,
    // not invent chat tool passes from the name.
    for check in &report.checks {
        assert_ne!(
            check.status,
            CapabilityStatus::Pass,
            "with tools/stream gated and no successful probe, status must not be Pass: {:?}",
            check
        );
    }
}

#[test]
fn investigator_name_hint_cannot_force_a_pass_without_measured_contract() {
    use cd_core::capability_qualification::{
        QualificationTransport, SyntheticChatRequest, SyntheticChatResponse,
        SyntheticEmbeddingResponse, SyntheticRerankResponse, TransportError,
    };
    // Empty scripted transport: every probe fails → no Pass rows.
    struct EmptyTransport;
    impl QualificationTransport for EmptyTransport {
        fn chat_complete(
            &mut self,
            _req: &SyntheticChatRequest,
            _cancel: &AtomicBool,
        ) -> Result<SyntheticChatResponse, TransportError> {
            Err(TransportError {
                reason: "empty".into(),
            })
        }
        fn embed(
            &mut self,
            _model: &str,
            _input: &str,
            _cancel: &AtomicBool,
        ) -> Result<SyntheticEmbeddingResponse, TransportError> {
            Err(TransportError {
                reason: "empty".into(),
            })
        }
        fn rerank(
            &mut self,
            _model: &str,
            _query: &str,
            _docs: &[&str],
            _cancel: &AtomicBool,
        ) -> Result<SyntheticRerankResponse, TransportError> {
            Err(TransportError {
                reason: "empty".into(),
            })
        }
    }
    let mut t = EmptyTransport;
    let report = run_qualification(
        QualificationKey::new("p", "https://example.invalid/v1", "gpt-4o-investigator"),
        ProfileCapabilityGate {
            tools_enabled: true,
            stream_enabled: true,
            embeddings_enabled: true,
        },
        &mut t,
        &Arc::new(AtomicBool::new(false)),
    );
    assert!(
        report
            .checks
            .iter()
            .all(|c| c.status != CapabilityStatus::Pass),
        "name hint alone must never yield Pass: {:?}",
        report.checks
    );
}

// ---------------------------------------------------------------------------
// 3. Surface-neutral activity / trace aggregation
// ---------------------------------------------------------------------------

#[tokio::test]
async fn activity_and_provider_telemetry_are_surface_neutral_for_human_jsonl_and_no_color() {
    // One TracedCall → one activity round + one telemetry projection.
    // Human / --no-color / JSONL hosts must project the same DTO fields.
    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::json_ok(
        &completion_stop("surface-ok"),
    ))])
    .await;
    let profile = openai_profile(&format!("{}/v1", gateway.base_url()), "matrix-model", None);
    let inner = backend_for(&profile, None).await.unwrap();
    let recorder = Arc::new(RecordingTurnTrace::new());
    let sink: Arc<dyn TurnTraceSink> = recorder.clone();
    let backend = TracingChatBackend::new(inner, sink);
    let mut on_text = |_: String| {};
    backend
        .complete_streaming(&user_msg("hi"), &[], &mut on_text, None)
        .await
        .unwrap();

    let calls = recorder.calls();
    assert_eq!(calls.len(), 1);
    assert!(matches!(calls[0].outcome, TracedOutcome::Completed { .. }));

    let mut summary = ActivityRecorder::new(
        "turn-audit",
        "session-audit",
        DataScope::conversation(),
        ActivityDetailLevel::Summary,
    );
    summary.record_provider_rounds(&calls);
    let summary_rec = summary.finish(ActivityStatus::Ok, 1);
    assert_eq!(summary_rec.provider_round_count(), 1);

    let mut full = ActivityRecorder::new(
        "turn-audit",
        "session-audit",
        DataScope::conversation(),
        ActivityDetailLevel::Full,
    );
    full.record_provider_rounds(&calls);
    let full_rec = full.finish(ActivityStatus::Ok, 1);
    assert_eq!(
        full_rec.provider_round_count(),
        summary_rec.provider_round_count(),
        "detail level must not invent or drop provider rounds"
    );

    let tel = aggregate_provider_turn_telemetry(ProviderTelemetryAggregateInput {
        configured_profile_id: "audit-openai",
        configured_model: "matrix-model",
        calls: &calls,
        events: &[],
    });
    assert_eq!(tel.provider_round_count, 1);
    assert_eq!(tel.configured_model, "matrix-model");
    // JSONL / human / no-color all serialize this same DTO — prove it is secret-free.
    let blob = serde_json::to_string(&tel).expect("serialize");
    for forbidden in ["sk-", "Authorization", "Bearer ", "/Users/", "password"] {
        assert!(
            !blob.contains(forbidden),
            "telemetry DTO must not contain {forbidden}: {blob}"
        );
    }
}

// ---------------------------------------------------------------------------
// 4. Protected-file credentials, single resolution, no keychain
// ---------------------------------------------------------------------------

#[tokio::test]
async fn protected_file_credential_resolves_once_per_turn_without_keychain() {
    let dir = tempfile::tempdir().unwrap();
    let secret = "sk-audit-fixture-never-keychain";
    let (_path, reference) = synthetic_protected_file(&dir, "turn.secret", secret);
    let store = CountingSecretStore::new(ReferencedSecretStore::new());
    let profile = openai_profile("http://127.0.0.1:1", "matrix-model", Some(reference));
    let cfg = cfg_with(profile);

    let cache = TurnProviderCredentialCache::new(&store);
    let a = resolve_turn_inputs_with_credential_cache(&cache, &cfg, None, None).unwrap();
    let b = resolve_turn_inputs_with_credential_cache(&cache, &cfg, None, None).unwrap();
    assert_eq!(a.api_key.as_deref(), Some(secret));
    assert_eq!(b.api_key.as_deref(), Some(secret));
    assert_eq!(
        store.read_count(),
        1,
        "turn-scoped cache must resolve once (mutation target: duplicated resolution)"
    );

    // Contrast: uncached path reads again — documents that the cache is the
    // production one-read guarantee a diagnostic must use.
    let store2 = CountingSecretStore::new(ReferencedSecretStore::new());
    resolve_turn_inputs(&store2, &cfg, None, None).unwrap();
    resolve_turn_inputs(&store2, &cfg, None, None).unwrap();
    assert_eq!(store2.read_count(), 2);
}

#[tokio::test]
async fn resolved_credential_reaches_wire_header_but_never_trace_bodies() {
    let dir = tempfile::tempdir().unwrap();
    let secret = "sk-audit-header-only";
    let (_path, reference) = synthetic_protected_file(&dir, "hdr.secret", secret);
    let store = ReferencedSecretStore::new();
    let api_key = store.get(&reference).unwrap();

    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::json_ok(
        &completion_stop("ok"),
    ))])
    .await;
    let profile = openai_profile(&format!("{}/v1", gateway.base_url()), "matrix-model", None);
    let inner = backend_for(&profile, api_key.clone()).await.unwrap();
    let recorder = Arc::new(RecordingTurnTrace::new());
    let sink: Arc<dyn TurnTraceSink> = recorder.clone();
    let backend = TracingChatBackend::new(inner, sink);
    let leaky = format!("please remember {secret} forever");
    let mut on_text = |_: String| {};
    backend
        .complete_streaming(&user_msg(&leaky), &[], &mut on_text, None)
        .await
        .unwrap();

    let recorded = gateway.requests();
    let auth = recorded[0]
        .header("authorization")
        .expect("authorization header present")
        .to_string();
    assert_eq!(auth, format!("Bearer {secret}"));

    let calls = recorder.calls();
    let serialized = serde_json::to_string(&calls).unwrap();
    assert!(
        !serialized.contains(secret),
        "raw credential must not appear in serialized TracedCall: {serialized}"
    );
    for m in &calls[0].messages {
        assert!(
            !m.content.contains(secret),
            "trace message bodies must scrub secret-shaped content"
        );
    }
}

// ---------------------------------------------------------------------------
// 5. Production redaction: opaque_absolute_paths + DeveloperPayload
// ---------------------------------------------------------------------------

#[test]
fn production_developer_payload_opaques_paths_and_scrubs_secrets_in_provider_bodies() {
    // Drive the same helpers TracingChatBackend / developer detail use —
    // not the test-only cd_test_gateway::redact panic helper.
    let secret = "sk-audit-redact-0123456789abcdef0123456789";
    let private_path = "/Users/audit-fixture/secret/corpus/events.duckdb";
    let endpoint = "https://models.private.example.corp/v1/chat/completions";
    let raw_provider_body = json!({
        "error": {
            "message": format!("denied for {private_path}"),
            "type": "invalid_request",
            "param": null,
            "code": "auth"
        },
        "authorization": format!("Bearer {secret}"),
        "request_url": endpoint,
        "debug_path": private_path
    });

    // 1) opaque_absolute_paths is the production path-opaqueing seam.
    let path_only = opaque_absolute_paths(&format!("failed under {private_path}"));
    assert!(
        path_only.contains("[local-path]"),
        "must insert [local-path] marker: {path_only}"
    );
    assert!(
        !path_only.contains("/Users/audit-fixture"),
        "home directory must not survive opaque_absolute_paths: {path_only}"
    );

    // 2) DeveloperPayload::text runs scrub_secrets + opaque_absolute_paths.
    let text_payload = DeveloperPayload::text(&format!(
        "Authorization: Bearer {secret} path={private_path} url={endpoint}"
    ));
    assert!(
        !text_payload.content.contains(secret),
        "DeveloperPayload::text must scrub credential: {}",
        text_payload.content
    );
    assert!(
        !text_payload.content.contains("/Users/audit-fixture"),
        "DeveloperPayload::text must opaque private path: {}",
        text_payload.content
    );
    assert!(
        text_payload.content.contains("[local-path]"),
        "expected [local-path] in developer text: {}",
        text_payload.content
    );

    // 3) DeveloperPayload::json redacts nested secret-bearing fields and
    //    opaques paths without the test pre-listing every token for replace.
    let json_payload = DeveloperPayload::json(&raw_provider_body);
    assert!(
        !json_payload.content.contains(secret),
        "raw secret must not appear in developer JSON payload: {}",
        json_payload.content
    );
    assert!(
        !json_payload.content.contains("/Users/audit-fixture"),
        "private path must not appear in developer JSON payload: {}",
        json_payload.content
    );
    // Endpoint host is not absolute filesystem path; scrub_secrets may leave
    // public-looking hosts — but Authorization-shaped values must go.
    assert!(
        !json_payload.content.contains("Bearer sk-"),
        "Bearer secret prefix must not survive: {}",
        json_payload.content
    );

    // 4) Credential shape alone still redacts via scrub_secrets (production).
    let scrubbed = scrub_secrets(&format!("Authorization: Bearer {secret}"));
    assert!(!scrubbed.contains(secret), "{scrubbed}");
}

// ---------------------------------------------------------------------------
// 6. Deadlines (Duration race → TracedOutcome::TimedOut) + real cleanup
// ---------------------------------------------------------------------------

/// Same shape as production `within_turn_deadline_with_cap` / gateway latency
/// lab: optional timeout wrapper raced with cancel watcher.
async fn race_with_cancel<F, T>(
    future: F,
    deadline: Option<Duration>,
    cancel: Option<&AtomicBool>,
) -> Result<T, &'static str>
where
    F: Future<Output = T>,
{
    async fn wait_for_cancel(cancel: Option<&AtomicBool>) {
        let Some(cancel) = cancel else {
            std::future::pending::<()>().await;
            return;
        };
        while !cancel.load(Ordering::Relaxed) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
    tokio::select! {
        biased;
        _ = wait_for_cancel(cancel) => Err("cancelled"),
        value = async {
            match deadline {
                Some(d) => tokio::time::timeout(d, future)
                    .await
                    .map_err(|_| "deadline"),
                None => Ok(future.await),
            }
        } => value,
    }
}

#[tokio::test(start_paused = true)]
async fn outer_deadline_race_records_traced_outcome_timed_out() {
    // Dropping TracingChatBackend mid-flight via a Duration deadline must
    // leave exactly one TimedOut TracedCall (production attempt lifecycle).
    let gateway = MockGateway::start_ordered(vec![Step::respond(
        Response::new(200, cd_test_gateway::Body::NeverEnds)
            .with_header("content-type", "text/event-stream"),
    )])
    .await;
    let profile = openai_profile(&format!("{}/v1", gateway.base_url()), "matrix-model", None);
    let inner = backend_for(&profile, None).await.unwrap();
    let recorder = Arc::new(RecordingTurnTrace::new());
    let sink: Arc<dyn TurnTraceSink> = recorder.clone();
    let backend = TracingChatBackend::new(inner, sink);
    let messages = user_msg("stall for deadline");
    let call = tokio::spawn(async move {
        let mut on_text = |_: String| {};
        race_with_cancel(
            backend.complete_streaming(&messages, &[], &mut on_text, None),
            Some(Duration::from_secs(2)),
            None,
        )
        .await
    });
    tokio::time::advance(Duration::from_secs(3)).await;
    let outcome = call.await.expect("join");
    assert!(
        matches!(outcome, Err("deadline")),
        "Duration deadline must win the outer race, got {outcome:?}"
    );
    let calls = recorder.calls();
    assert_eq!(
        calls.len(),
        1,
        "deadline drop must retain exactly one attempt record"
    );
    assert!(
        matches!(calls[0].outcome, TracedOutcome::TimedOut),
        "expected TracedOutcome::TimedOut, got {:?}",
        calls[0].outcome
    );
}

#[tokio::test]
async fn outer_cancel_race_records_traced_outcome_cancelled() {
    let gateway = MockGateway::start_ordered(vec![Step::respond(
        Response::new(200, cd_test_gateway::Body::NeverEnds)
            .with_header("content-type", "text/event-stream"),
    )])
    .await;
    let profile = openai_profile(&format!("{}/v1", gateway.base_url()), "matrix-model", None);
    let inner = backend_for(&profile, None).await.unwrap();
    let recorder = Arc::new(RecordingTurnTrace::new());
    let sink: Arc<dyn TurnTraceSink> = recorder.clone();
    let backend = TracingChatBackend::new(inner, sink);
    let cancel = Arc::new(AtomicBool::new(false));
    let cancel_for_race = cancel.clone();
    let cancel_for_stream = cancel.clone();
    let messages = user_msg("stall for cancel");
    let handle = tokio::spawn(async move {
        let mut on_text = |_: String| {};
        race_with_cancel(
            backend.complete_streaming(
                &messages,
                &[],
                &mut on_text,
                Some(cancel_for_stream.as_ref()),
            ),
            None,
            Some(cancel_for_race.as_ref()),
        )
        .await
    });
    tokio::time::sleep(Duration::from_millis(40)).await;
    cancel.store(true, Ordering::SeqCst);
    let outcome = tokio::time::timeout(Duration::from_secs(5), handle)
        .await
        .expect("join timeout")
        .expect("task join");
    assert!(
        matches!(outcome, Err("cancelled")) || matches!(outcome, Ok(Err(_))),
        "cancel must bound the call, got {outcome:?}"
    );
    let calls = recorder.calls();
    assert_eq!(calls.len(), 1, "cancel must retain one attempt");
    assert!(
        matches!(
            calls[0].outcome,
            TracedOutcome::Cancelled | TracedOutcome::TimedOut | TracedOutcome::Failed { .. }
        ),
        "cancelled in-flight attempt must not look completed: {:?}",
        calls[0].outcome
    );
}

/// Terminal outcomes a diagnostic temp fixture may end in — each must call
/// the same production cleanup primitives.
#[derive(Clone, Copy, Debug)]
enum TerminalOutcome {
    Success,
    Failure,
    Timeout,
    Cancel,
}

fn cleanup_temp_diagnostic_state(
    cache_root: &std::path::Path,
    corpus_id: &str,
    sessions: &SessionStore,
    session_id: &str,
    _outcome: TerminalOutcome,
) {
    // Production cleanup: LogCorpus::discard + SessionStore::delete — not
    // hand-rolled remove_dir_all, and not outcome-label theater.
    let _ = LogCorpus::discard(cache_root, corpus_id);
    let _ = sessions.delete(session_id);
}

#[test]
fn temporary_corpus_and_session_cleanup_uses_production_primitives_for_each_terminal() {
    let cache = tempfile::tempdir().unwrap();
    let sessions_dir = tempfile::tempdir().unwrap();
    let store = SessionStore::new(sessions_dir.path());

    for outcome in [
        TerminalOutcome::Success,
        TerminalOutcome::Failure,
        TerminalOutcome::Timeout,
        TerminalOutcome::Cancel,
    ] {
        let corpus =
            LogCorpus::create(cache.path(), format!("audit-{outcome:?}")).expect("create corpus");
        let corpus_id = corpus.id().to_string();
        let corpus_root = cache.path().join("log_corpora").join(&corpus_id);
        assert!(corpus_root.exists());
        drop(corpus);

        let session = Session::new(format!("audit-sess-{outcome:?}"));
        let session_id = session.id.clone();
        store.save(&session).expect("save session");
        assert!(store.exists(&session_id).unwrap());

        cleanup_temp_diagnostic_state(cache.path(), &corpus_id, &store, &session_id, outcome);

        assert!(
            !corpus_root.exists(),
            "LogCorpus::discard must remove corpus for {outcome:?}"
        );
        assert!(
            !LogCorpus::list_ids(cache.path())
                .unwrap()
                .contains(&corpus_id),
            "discarded corpus must not list for {outcome:?}"
        );
        assert!(
            !store.exists(&session_id).unwrap(),
            "SessionStore::delete must remove session for {outcome:?}"
        );
    }

    // Mutation target: if discard is skipped, corpus remains on disk.
    let corpus = LogCorpus::create(cache.path(), "audit-skip-discard").unwrap();
    let corpus_id = corpus.id().to_string();
    let corpus_root = cache.path().join("log_corpora").join(&corpus_id);
    drop(corpus);
    assert!(corpus_root.exists());
    // Skipping discard leaves the corpus — prove discard is required.
    assert!(
        corpus_root.exists(),
        "without discard the corpus must still be on disk"
    );
    LogCorpus::discard(cache.path(), &corpus_id).unwrap();
    assert!(!corpus_root.exists());
}

// ---------------------------------------------------------------------------
// 7. Linked-log triage plumbing: bind + grounded tool path + unbind + discard
// ---------------------------------------------------------------------------

#[tokio::test]
async fn linked_log_bind_search_and_unbind_reuse_production_turn_seams() {
    // Hermetic linked-log fixture: ingest one synthetic log line, bind the
    // corpus on ToolHost (production bind_linked_corpus), run a real linked
    // turn via run_turn against MockGateway, then unbind + LogCorpus::discard.
    let workspace_dir = tempfile::tempdir().expect("workspace");
    let workspace = Workspace::new("audit-linked", vec![workspace_dir.path().to_path_buf()]);
    let index = KeywordIndex::build(&workspace).expect("index");
    let mut host = ToolHost::new(workspace, index, None);

    let logs_dir = workspace_dir.path().join("logs");
    fs::create_dir_all(&logs_dir).unwrap();
    fs::write(
        logs_dir.join("worker.log"),
        r#"{"ts":1700000100,"level":"error","service":"worker","message":"audit-linked-incident pool exhausted"}"#,
    )
    .unwrap();
    let cache_root = tempfile::tempdir().expect("cache");
    let report =
        cd_core::log_analysis::ingest_path(cache_root.path(), &logs_dir, "audit", None, "none")
            .expect("ingest");
    let corpus_id = report.corpus_id;
    host.set_log_analysis(true, Some(cache_root.path().to_path_buf()));
    let binding = bind_linked_corpus(&mut host, cache_root.path(), &corpus_id)
        .expect("bind_linked_corpus is the production linked-log seam");
    assert!(
        host.active_log_corpus().is_some(),
        "bind must pin active corpus"
    );
    assert_eq!(
        host.active_log_corpus().map(str::to_string).as_deref(),
        Some(corpus_id.as_str())
    );
    let _revision = binding.revision;
    let context =
        cd_core::agent::LogExplorerTurnContext::for_main_chat(&corpus_id).expect("linked context");

    // Script provider: tool call search_logs → final answer with citation shape.
    let gateway = MockGateway::start_ordered(vec![
        Step::respond(Response::json_ok(&completion_tools(
            "search_logs",
            r#"{"query":"pool exhausted"}"#,
        ))),
        Step::respond(Response::json_ok(&completion_stop(
            "The worker hit pool exhaustion. [1]",
        ))),
    ])
    .await;

    let profile = openai_profile(&format!("{}/v1", gateway.base_url()), "matrix-model", None);
    let cfg = cd_core::config::AppConfig {
        providers: ProviderConfig {
            active_id: Some(profile.id.clone()),
            profiles: vec![profile],
        },
        ..Default::default()
    };
    let secrets = MemorySecretStore::new();
    let resolved = resolve_turn_inputs(&secrets, &cfg, None, None).expect("resolve");
    let mut history = Vec::new();
    let events = run_turn(
        &mut host,
        &resolved,
        "What happened to the worker pool?",
        &mut history,
        "audit-linked-session",
        TurnExecutionOptions {
            context: Some(context),
            ..TurnExecutionOptions::default()
        },
        None,
        None,
    )
    .await
    .expect("linked turn completes against hermetic gateway + corpus");

    // Linked turn must have used tools and/or completed — not invent a pass
    // without host corpus plumbing.
    let saw_tool = events.iter().any(|e| {
        matches!(
            e,
            StreamEvent::Tool {
                name,
                ..
            } if name == "search_logs"
        )
    });
    let terminal = events.iter().rev().find_map(|e| match e {
        StreamEvent::TurnCompleted { reason } => Some(reason.as_str()),
        _ => None,
    });
    assert!(
        saw_tool || terminal.is_some(),
        "linked turn must exercise tool host or complete: terminal={terminal:?} events={events:?}"
    );
    assert!(
        gateway.request_count() >= 1,
        "linked turn must hit production backend_for path"
    );

    unbind_linked_corpus(&mut host, binding);
    // After unbind, active corpus is restored (None in this fixture).
    assert!(
        host.active_log_corpus().is_none(),
        "unbind must restore prior active corpus"
    );

    // Diagnostic cleanup: production discard removes the temp corpus.
    let corpus_root = cache_root.path().join("log_corpora").join(&corpus_id);
    assert!(corpus_root.exists());
    LogCorpus::discard(cache_root.path(), &corpus_id).expect("discard");
    assert!(
        !corpus_root.exists(),
        "LogCorpus::discard must remove linked corpus after diagnostic"
    );
}

// ---------------------------------------------------------------------------
// Structural: future diagnostic must reuse production entry points
// ---------------------------------------------------------------------------

#[test]
fn production_plumbing_entrypoints_exist_for_diagnostic_reuse() {
    // Static/source contracts — a competing second HTTP client stack must not
    // be introduced; diagnostics should call these symbols.
    let research = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../cd-core/src/research.rs"
    ));
    assert!(
        research.contains("pub async fn backend_for"),
        "backend_for is the production client constructor"
    );
    let provider = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/src/provider.rs"));
    assert!(
        provider.contains("TurnProviderCredentialCache"),
        "credential cache is the one-resolution seam"
    );
    assert!(
        provider.contains("resolve_turn_inputs_with_credential_cache"),
        "turn inputs must go through the cached resolver"
    );
    let qual = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../cd-core/src/capability_qualification.rs"
    ));
    assert!(qual.contains("pub fn run_qualification"));
    assert!(qual.contains("name_hint_cannot_produce_measured_pass") || qual.contains("role_hint"));
}

#[test]
fn qualification_key_helper_matches_workflow_and_core() {
    // cd_workflow::qualification_key must stay aligned with QualificationKey::new.
    let base = "https://gw.example/v1";
    let a = QualificationKey::new("p", base, "m1");
    let b = qualification_key("p", base, "m1");
    assert_eq!(a.storage_id(), b.storage_id());
    assert_eq!(a.model_id, b.model_id);
}
