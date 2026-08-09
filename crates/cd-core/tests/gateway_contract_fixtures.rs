//! Hermetic gateway protocol contract fixtures derived from live Vercel evidence.
//!
//! This is a **test-evidence** suite only:
//! - no network, Keychain, credentials, private hosts, or live payloads
//! - fixtures under `fixtures/gateway-contracts/v1/`
//! - coverage map: `docs/development/GATEWAY_CONTRACT_FIXTURES_COVERAGE.md`
//!
//! Prefer normalized protocol invariants over raw payload snapshots.

use std::collections::{BTreeSet, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use cd_core::capability_qualification::{
    model_readiness_for_report, probes_for_role_hint, run_qualification, CapabilityKind,
    CapabilityStatus, ModelReadinessRole, ModelReadinessState, ProfileCapabilityGate,
    QualificationKey, QualificationTransport, ScriptedQualificationTransport, SyntheticChatRequest,
    SyntheticChatResponse, SyntheticEmbeddingResponse, SyntheticRerankResponse, SyntheticToolCall,
    TransportError, INERT_PROBE_TOOL_NAME, SYNTH_GENERATION_MARKER,
};
use cd_core::discovery::{classify_probe_http_status, is_vercel_ai_gateway, ProbeOutcome};
use cd_core::model_role_hints::{classify_model_role, sort_ids_for_chat_picker, ModelRoleHint};
use cd_core::rerank::validate_rerank_scores;
use serde::Deserialize;
use serde_json::Value;

// ---------------------------------------------------------------------------
// Pure protocol helpers (fixture-local; mirror lab / adapter fail-closed rules)
// ---------------------------------------------------------------------------

fn parse_catalog_model_ids(value: &Value) -> Vec<String> {
    value
        .get("models")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|row| row.get("id").and_then(Value::as_str))
        .map(str::to_string)
        .collect()
}

fn catalog_role_from_model_type(model_type: Option<&str>) -> Option<&'static str> {
    match model_type {
        Some("embedding") => Some("embedding"),
        Some("reranking") | Some("reranker") => Some("reranker"),
        Some("language") | Some("chat") | Some("generation") => Some("chat"),
        _ => None,
    }
}

/// Vercel v4 embedding envelope: `{ "embeddings": [[f32; d]; n] }`.
fn validate_vercel_embedding_envelope(
    body: &Value,
    expected_values: usize,
    expected_dims: Option<usize>,
) -> Result<usize, String> {
    let embeddings = body
        .get("embeddings")
        .and_then(Value::as_array)
        .ok_or_else(|| "embedding response missing embeddings array".to_string())?;
    if embeddings.len() != expected_values {
        return Err(format!(
            "embedding response count {} != expected {expected_values}",
            embeddings.len()
        ));
    }
    if embeddings.is_empty() {
        return Err("embedding response empty".into());
    }
    let mut dims = None;
    for vector in embeddings {
        let arr = vector
            .as_array()
            .ok_or_else(|| "embedding vector is not an array".to_string())?;
        let this_dims = arr.len();
        if this_dims == 0 || this_dims > 65_536 {
            return Err("embedding response has an invalid dimension count".into());
        }
        match dims {
            None => dims = Some(this_dims),
            Some(d) if d != this_dims => {
                return Err("embedding response has inconsistent dimensions".into());
            }
            Some(_) => {}
        }
        for component in arr {
            let number = component
                .as_f64()
                .ok_or_else(|| "embedding response contains a non-number".to_string())?;
            if !number.is_finite() {
                return Err("embedding response contains a non-finite component".into());
            }
        }
    }
    let dims = dims.unwrap_or(0);
    if let Some(expected) = expected_dims {
        if dims != expected {
            return Err(format!("embedding dimension {dims} != expected {expected}"));
        }
    }
    Ok(dims)
}

/// Vercel v4 rerank envelope: `{ "ranking": [{ "index", "relevanceScore" }, ...] }`.
fn validate_vercel_ranking_envelope(
    body: &Value,
    document_count: usize,
    top_n: usize,
) -> Result<Vec<usize>, String> {
    let ranking = body
        .get("ranking")
        .and_then(Value::as_array)
        .ok_or_else(|| "reranking response missing ranking rows".to_string())?;
    if ranking.len() != top_n {
        return Err(format!(
            "reranking response count {} != topN {top_n}",
            ranking.len()
        ));
    }
    let mut seen = BTreeSet::new();
    let mut indices = Vec::with_capacity(ranking.len());
    for row in ranking {
        let index = row
            .get("index")
            .and_then(Value::as_u64)
            .and_then(|i| usize::try_from(i).ok())
            .ok_or_else(|| "reranking response contains an invalid index".to_string())?;
        let score = row
            .get("relevanceScore")
            .or_else(|| row.get("relevance_score"))
            .and_then(Value::as_f64)
            .ok_or_else(|| "reranking response contains an invalid score".to_string())?;
        if index >= document_count {
            return Err(format!(
                "reranking index {index} out of range for {document_count} documents"
            ));
        }
        if !score.is_finite() {
            return Err("reranking score must be finite".into());
        }
        if !seen.insert(index) {
            return Err(format!("reranking duplicate index {index}"));
        }
        indices.push(index);
    }
    // Complete permutation when top_n == document_count.
    if top_n == document_count && seen.len() != document_count {
        return Err("reranking ranking is not a complete permutation".into());
    }
    Ok(indices)
}

fn unit_vector(dims: usize) -> Vec<f32> {
    let scale = (dims as f32).sqrt().recip();
    vec![scale; dims]
}

fn gate_full() -> ProfileCapabilityGate {
    ProfileCapabilityGate {
        tools_enabled: true,
        stream_enabled: true,
        embeddings_enabled: true,
    }
}

fn key(model: &str) -> QualificationKey {
    // Public synthetic endpoint fingerprint only — never a private host.
    QualificationKey::new("fixture-gateway", "https://gateway.example.test/v1", model)
}

fn push_full_chat_pass_queue(t: &mut ScriptedQualificationTransport) {
    // LIFO pop: push cancel first, generation last, then reverse.
    let mut responses = vec![
        Ok(SyntheticChatResponse {
            content: SYNTH_GENERATION_MARKER.into(),
            ..Default::default()
        }),
        Ok(SyntheticChatResponse {
            tool_calls: vec![SyntheticToolCall {
                id: "call_fixture_1".into(),
                name: INERT_PROBE_TOOL_NAME.into(),
                arguments_json: r#"{"token":"QUALIFY_TOOL_V1"}"#.into(),
            }],
            ..Default::default()
        }),
        Ok(SyntheticChatResponse {
            content: "continued".into(),
            ..Default::default()
        }),
        Ok(SyntheticChatResponse {
            content: r#"{"qualify":"ok","v":1}"#.into(),
            ..Default::default()
        }),
        Ok(SyntheticChatResponse {
            content: SYNTH_GENERATION_MARKER.into(),
            streamed: true,
            ..Default::default()
        }),
        Ok(SyntheticChatResponse {
            cancelled: true,
            ..Default::default()
        }),
    ];
    responses.reverse();
    t.chat_queue = responses;
    t.honor_cancel = true;
}

fn assert_full_chat_pass(report: &cd_core::capability_qualification::QualificationReport) {
    for kind in [
        CapabilityKind::BasicGeneration,
        CapabilityKind::NativeToolCall,
        CapabilityKind::ToolResultContinuation,
        CapabilityKind::StructuredOutput,
        CapabilityKind::Streaming,
        CapabilityKind::Cancellation,
    ] {
        assert_eq!(
            report.status_of(kind),
            CapabilityStatus::Pass,
            "{kind:?} must pass for live chat contract: {:?}",
            report.checks
        );
    }
    assert!(
        !report.cancelled,
        "cancellation probe must not mark user-cancelled"
    );
    let readiness = model_readiness_for_report(report);
    assert_eq!(readiness.role, ModelReadinessRole::Chat);
    assert_eq!(readiness.state, ModelReadinessState::Verified);
}

// ---------------------------------------------------------------------------
// Catalog + role classification
// ---------------------------------------------------------------------------

#[test]
fn mixed_catalog_classifies_roles_without_assuming_chat() {
    let catalog: Value = serde_json::from_str(include_str!(
        "../../../fixtures/gateway-contracts/v1/catalog-mixed-roles.json"
    ))
    .expect("catalog fixture");

    let ids = parse_catalog_model_ids(&catalog);
    assert!(ids.contains(&"deepseek/deepseek-v4-flash".into()));
    assert!(ids.contains(&"openai/gpt-oss-120b".into()));
    assert!(ids.contains(&"voyage/voyage-4".into()));
    assert!(ids.contains(&"voyage/rerank-2.5".into()));
    assert_eq!(ids.len(), 5, "all synthetic catalog rows must be visible");

    let models = catalog
        .get("models")
        .and_then(Value::as_array)
        .expect("models array");

    let mut chat_capable = 0usize;
    let mut embedding = 0usize;
    let mut reranker = 0usize;
    for model in models {
        let id = model.get("id").and_then(Value::as_str).unwrap_or("");
        let model_type = model.get("modelType").and_then(Value::as_str);
        let catalog_role = catalog_role_from_model_type(model_type);
        let hint = classify_model_role(id);

        match catalog_role {
            Some("embedding") => {
                embedding += 1;
                assert_eq!(hint.role, ModelRoleHint::Embedding, "{id}");
                assert!(!hint.ordinary_chat_default, "{id}");
                assert_eq!(
                    probes_for_role_hint(hint.role),
                    vec![CapabilityKind::EmbeddingContract]
                );
            }
            Some("reranker") => {
                reranker += 1;
                assert_eq!(hint.role, ModelRoleHint::Reranker, "{id}");
                assert!(!hint.ordinary_chat_default, "{id}");
                assert_eq!(
                    probes_for_role_hint(hint.role),
                    vec![CapabilityKind::RerankerContract]
                );
            }
            Some("chat") => {
                chat_capable += 1;
                assert_eq!(hint.role, ModelRoleHint::Investigator, "{id}");
                assert!(hint.ordinary_chat_default, "{id}");
                assert!(
                    probes_for_role_hint(hint.role).contains(&CapabilityKind::BasicGeneration),
                    "{id}"
                );
            }
            None | Some(_) => {
                // Private alias / unmapped type: selectable; name hint alone is not verification.
                assert_ne!(
                    hint.role,
                    ModelRoleHint::Investigator,
                    "unknown catalog rows should not look like strong chat defaults: {id}"
                );
            }
        }
    }
    assert!(chat_capable >= 2);
    assert_eq!(embedding, 1);
    assert_eq!(reranker, 1);

    let sorted = sort_ids_for_chat_picker(&ids);
    let deepseek = sorted
        .iter()
        .position(|id| id == "deepseek/deepseek-v4-flash")
        .unwrap();
    let voyage = sorted
        .iter()
        .position(|id| id == "voyage/voyage-4")
        .unwrap();
    let rerank = sorted
        .iter()
        .position(|id| id == "voyage/rerank-2.5")
        .unwrap();
    assert!(deepseek < voyage, "chat models sort ahead of embeddings");
    assert!(deepseek < rerank, "chat models sort ahead of rerankers");
}

#[test]
fn live_observed_model_ids_have_stable_role_hints() {
    let cases = [
        (
            "deepseek/deepseek-v4-flash",
            ModelRoleHint::Investigator,
            true,
        ),
        ("openai/gpt-oss-120b", ModelRoleHint::Investigator, true),
        ("voyage/voyage-4", ModelRoleHint::Embedding, false),
        ("voyage/rerank-2.5", ModelRoleHint::Reranker, false),
    ];
    for (id, role, chat_default) in cases {
        let s = classify_model_role(id);
        assert_eq!(s.role, role, "{id}");
        assert_eq!(s.ordinary_chat_default, chat_default, "{id}");
    }
}

#[test]
fn empty_and_malformed_catalogs_yield_no_usable_ids() {
    let empty: Value = serde_json::from_str(include_str!(
        "../../../fixtures/gateway-contracts/v1/fail-closed/catalog-empty.json"
    ))
    .unwrap();
    assert!(parse_catalog_model_ids(&empty).is_empty());

    let malformed: Value = serde_json::from_str(include_str!(
        "../../../fixtures/gateway-contracts/v1/fail-closed/catalog-malformed.json"
    ))
    .unwrap();
    assert!(
        parse_catalog_model_ids(&malformed).is_empty(),
        "rows without string ids must be dropped"
    );
}

#[test]
fn vercel_public_gateway_host_detection_is_exact() {
    assert!(is_vercel_ai_gateway("https://ai-gateway.vercel.sh/v1"));
    assert!(is_vercel_ai_gateway("https://ai-gateway.vercel.sh/v4/ai"));
    assert!(!is_vercel_ai_gateway(
        "https://ai-gateway.vercel.sh.evil.example/v1"
    ));
    assert!(!is_vercel_ai_gateway("https://gateway.example.test/v1"));
}

// ---------------------------------------------------------------------------
// Chat generation / tools / stream / cancel (live model ids)
// ---------------------------------------------------------------------------

#[test]
fn live_chat_models_pass_full_scripted_suite() {
    for model in ["deepseek/deepseek-v4-flash", "openai/gpt-oss-120b"] {
        let mut t = ScriptedQualificationTransport::default();
        push_full_chat_pass_queue(&mut t);
        let report = run_qualification(
            key(model),
            gate_full(),
            &mut t,
            &Arc::new(AtomicBool::new(false)),
        );
        assert_eq!(report.role_hint, "chat");
        assert_full_chat_pass(&report);
    }
}

#[test]
fn fragmented_stream_content_reassembles_to_marker() {
    #[derive(Deserialize)]
    struct StreamFixture {
        fragments: Vec<String>,
        expected: String,
        clean_completion: bool,
    }
    let fixture: StreamFixture = serde_json::from_str(include_str!(
        "../../../fixtures/gateway-contracts/v1/chat-stream-fragments.json"
    ))
    .unwrap();
    let joined = fixture.fragments.concat();
    assert_eq!(joined, fixture.expected);
    assert_eq!(joined, SYNTH_GENERATION_MARKER);
    assert!(fixture.clean_completion);

    let mut t = ScriptedQualificationTransport {
        honor_cancel: true,
        chat_queue: {
            let mut q = vec![
                Ok(SyntheticChatResponse {
                    content: joined.clone(),
                    ..Default::default()
                }),
                Ok(SyntheticChatResponse {
                    tool_calls: vec![SyntheticToolCall {
                        id: "c1".into(),
                        name: INERT_PROBE_TOOL_NAME.into(),
                        arguments_json: r#"{"token":"QUALIFY_TOOL_V1"}"#.into(),
                    }],
                    ..Default::default()
                }),
                Ok(SyntheticChatResponse {
                    content: "continued".into(),
                    ..Default::default()
                }),
                Ok(SyntheticChatResponse {
                    content: r#"{"qualify":"ok","v":1}"#.into(),
                    ..Default::default()
                }),
                // Streaming probe: content from fragments, streamed flag set by transport.
                Ok(SyntheticChatResponse {
                    content: joined,
                    streamed: true,
                    ..Default::default()
                }),
                Ok(SyntheticChatResponse {
                    cancelled: true,
                    ..Default::default()
                }),
            ];
            q.reverse();
            q
        },
        ..Default::default()
    };
    let report = run_qualification(
        key("deepseek/deepseek-v4-flash"),
        gate_full(),
        &mut t,
        &Arc::new(AtomicBool::new(false)),
    );
    assert_eq!(
        report.status_of(CapabilityKind::Streaming),
        CapabilityStatus::Pass
    );
    assert_eq!(
        report.status_of(CapabilityKind::BasicGeneration),
        CapabilityStatus::Pass
    );
}

/// Slow-but-valid models are represented by multi-step scripted content, never
/// by wall-clock `sleep` or latency thresholds.
#[test]
fn verbose_scripted_chat_passes_without_wall_clock_sleep() {
    /// Deterministic "verbose" transport: many tiny content fragments, no sleep.
    struct VerboseScripted {
        fragments_left: usize,
        phase: usize,
    }

    impl QualificationTransport for VerboseScripted {
        fn chat_complete(
            &mut self,
            req: &SyntheticChatRequest,
            cancel: &AtomicBool,
        ) -> Result<SyntheticChatResponse, TransportError> {
            if cancel.load(Ordering::SeqCst) {
                return Ok(SyntheticChatResponse {
                    cancelled: true,
                    ..Default::default()
                });
            }
            // Simulate a slow/verbose model by assembling many fragments in-process.
            let mut content = String::new();
            while self.fragments_left > 0 {
                content.push('x');
                self.fragments_left -= 1;
                // Cooperative yield only — never sleep.
                std::thread::yield_now();
            }
            self.fragments_left = 64; // refill for next phase
            let phase = self.phase;
            self.phase += 1;
            match phase {
                0 => Ok(SyntheticChatResponse {
                    content: SYNTH_GENERATION_MARKER.into(),
                    streamed: req.stream,
                    ..Default::default()
                }),
                1 => Ok(SyntheticChatResponse {
                    tool_calls: vec![SyntheticToolCall {
                        id: "verbose_1".into(),
                        name: INERT_PROBE_TOOL_NAME.into(),
                        arguments_json: r#"{"token":"QUALIFY_TOOL_V1"}"#.into(),
                    }],
                    ..Default::default()
                }),
                2 => Ok(SyntheticChatResponse {
                    content: format!("continued:{content}"),
                    ..Default::default()
                }),
                3 => Ok(SyntheticChatResponse {
                    content: r#"{"qualify":"ok","v":1}"#.into(),
                    ..Default::default()
                }),
                4 => Ok(SyntheticChatResponse {
                    content: SYNTH_GENERATION_MARKER.into(),
                    streamed: true,
                    ..Default::default()
                }),
                _ => Ok(SyntheticChatResponse {
                    cancelled: true,
                    ..Default::default()
                }),
            }
        }

        fn embed(
            &mut self,
            _model_id: &str,
            _text: &str,
            _cancel: &AtomicBool,
        ) -> Result<SyntheticEmbeddingResponse, TransportError> {
            Err(TransportError {
                reason: "not_offered".into(),
            })
        }

        fn rerank(
            &mut self,
            _model_id: &str,
            _query: &str,
            _document_ids: &[&str],
            _cancel: &AtomicBool,
        ) -> Result<SyntheticRerankResponse, TransportError> {
            Err(TransportError {
                reason: "not_offered".into(),
            })
        }
    }

    let mut t = VerboseScripted {
        fragments_left: 128,
        phase: 0,
    };
    let report = run_qualification(
        key("openai/gpt-oss-120b"),
        gate_full(),
        &mut t,
        &Arc::new(AtomicBool::new(false)),
    );
    assert_full_chat_pass(&report);
    // Explicitly document: no wall-clock threshold was consulted.
    assert!(
        report
            .checks
            .iter()
            .all(|c| c.status == CapabilityStatus::Pass),
        "verbose scripted path must not depend on sleep: {:?}",
        report.checks
    );
}

// ---------------------------------------------------------------------------
// Embedding contract (voyage/voyage-4 → 1024-d)
// ---------------------------------------------------------------------------

#[test]
fn voyage_4_embedding_envelope_and_qualification() {
    #[derive(Deserialize)]
    struct Meta {
        model: String,
        value_count: usize,
        dimensions: usize,
    }
    let meta: Meta = serde_json::from_str(include_str!(
        "../../../fixtures/gateway-contracts/v1/vercel-embedding-response-meta.json"
    ))
    .unwrap();
    assert_eq!(meta.model, "voyage/voyage-4");
    assert_eq!(meta.dimensions, 1024);
    assert_eq!(meta.value_count, 1);

    let vector = unit_vector(meta.dimensions);
    assert_eq!(vector.len(), 1024);
    assert!(vector.iter().all(|f| f.is_finite()));

    let body = serde_json::json!({
        "embeddings": [vector],
        "usage": { "tokens": 0 },
        "warnings": []
    });
    let dims =
        validate_vercel_embedding_envelope(&body, meta.value_count, Some(meta.dimensions)).unwrap();
    assert_eq!(dims, 1024);

    let mut t = ScriptedQualificationTransport::default();
    t.embed_queue.push(Ok(SyntheticEmbeddingResponse {
        vector: unit_vector(1024),
        raw_error: None,
    }));
    let report = run_qualification(
        key("voyage/voyage-4"),
        gate_full(),
        &mut t,
        &Arc::new(AtomicBool::new(false)),
    );
    assert_eq!(report.role_hint, "embedding");
    assert_eq!(report.checks.len(), 1);
    assert_eq!(
        report.status_of(CapabilityKind::EmbeddingContract),
        CapabilityStatus::Pass
    );
    assert!(
        report.checks[0].reason.contains("vector_len=1024"),
        "dimension must appear in the measured reason: {}",
        report.checks[0].reason
    );
    let readiness = model_readiness_for_report(&report);
    assert_eq!(readiness.role, ModelReadinessRole::Embedding);
    assert_eq!(readiness.state, ModelReadinessState::Verified);
    // Specialty verification must never outrank a verified chat model for chat pick.
    let mut chat_t = ScriptedQualificationTransport::default();
    push_full_chat_pass_queue(&mut chat_t);
    let chat_report = run_qualification(
        key("deepseek/deepseek-v4-flash"),
        gate_full(),
        &mut chat_t,
        &Arc::new(AtomicBool::new(false)),
    );
    let chat_readiness = model_readiness_for_report(&chat_report);
    assert!(
        readiness.chat_preference_rank() > chat_readiness.chat_preference_rank(),
        "embedding verified rank {} must be worse (higher) than chat verified rank {}",
        readiness.chat_preference_rank(),
        chat_readiness.chat_preference_rank()
    );
}

#[test]
fn vercel_v4_specialty_envelopes_are_not_chat_shapes() {
    let embed_req: Value = serde_json::from_str(include_str!(
        "../../../fixtures/gateway-contracts/v1/vercel-embedding-request.json"
    ))
    .unwrap();
    let rerank_req: Value = serde_json::from_str(include_str!(
        "../../../fixtures/gateway-contracts/v1/vercel-rerank-request.json"
    ))
    .unwrap();

    for (label, req) in [("embed", &embed_req), ("rerank", &rerank_req)] {
        let body = req.get("body").expect("body");
        let forbidden = req
            .get("must_not_contain_keys")
            .and_then(Value::as_array)
            .expect("must_not_contain_keys");
        for key in forbidden {
            let k = key.as_str().unwrap();
            assert!(
                body.get(k).is_none(),
                "{label} specialty body must not look like chat (key {k})"
            );
        }
        let path = req.get("path").and_then(Value::as_str).unwrap_or("");
        assert!(
            path.contains("embedding-model") || path.contains("reranking-model"),
            "{label} path must be specialty v4, got {path}"
        );
        // Headers are protocol constants only — never Authorization values.
        let headers = req.get("headers").and_then(Value::as_object).unwrap();
        assert!(!headers.contains_key("Authorization"));
        assert!(!headers.contains_key("authorization"));
    }

    assert!(embed_req.pointer("/body/values").is_some());
    assert!(rerank_req.pointer("/body/documents/values").is_some());
    assert_eq!(
        rerank_req.pointer("/body/topN").and_then(Value::as_u64),
        Some(3)
    );
}

// ---------------------------------------------------------------------------
// Rerank contract (voyage/rerank-2.5 complete permutation)
// ---------------------------------------------------------------------------

#[test]
fn voyage_rerank_complete_permutation_and_qualification() {
    let body: Value = serde_json::from_str(include_str!(
        "../../../fixtures/gateway-contracts/v1/vercel-rerank-response-permutation.json"
    ))
    .unwrap();
    let document_count = body.get("document_count").and_then(Value::as_u64).unwrap() as usize;
    let top_n = body.get("top_n").and_then(Value::as_u64).unwrap() as usize;
    let indices = validate_vercel_ranking_envelope(&body, document_count, top_n).unwrap();
    assert_eq!(indices, vec![1, 0, 2]);
    let unique: HashSet<_> = indices.iter().copied().collect();
    assert_eq!(unique.len(), document_count);

    // Generic score contract (provider-neutral consumer boundary).
    let scores = [0.44_f32, 0.91, 0.12];
    validate_rerank_scores(&scores, 3).unwrap();

    let mut t = ScriptedQualificationTransport::default();
    t.rerank_queue.push(Ok(SyntheticRerankResponse {
        ranked_ids: vec!["doc_b".into(), "doc_a".into(), "doc_c".into()],
        raw_error: None,
    }));
    let report = run_qualification(
        key("voyage/rerank-2.5"),
        gate_full(),
        &mut t,
        &Arc::new(AtomicBool::new(false)),
    );
    assert_eq!(report.role_hint, "reranker");
    assert_eq!(
        report.status_of(CapabilityKind::RerankerContract),
        CapabilityStatus::Pass
    );
    let readiness = model_readiness_for_report(&report);
    assert_eq!(readiness.role, ModelReadinessRole::Reranker);
    assert_eq!(readiness.state, ModelReadinessState::Verified);
}

// ---------------------------------------------------------------------------
// Fail closed matrix
// ---------------------------------------------------------------------------

#[test]
fn embedding_fail_closed_matrix() {
    // Non-finite component (JSON encodes NaN as string in our fixture).
    let non_finite: Value = serde_json::from_str(include_str!(
        "../../../fixtures/gateway-contracts/v1/fail-closed/embedding-non-finite.json"
    ))
    .unwrap();
    // Rebuild with actual NaN for the validator path.
    let nan_body = serde_json::json!({
        "embeddings": [[0.1, f64::NAN, 0.2]]
    });
    assert!(validate_vercel_embedding_envelope(&nan_body, 1, None).is_err());
    assert!(non_finite.get("case").is_some());

    let dim_mismatch: Value = serde_json::from_str(include_str!(
        "../../../fixtures/gateway-contracts/v1/fail-closed/embedding-dimension-mismatch.json"
    ))
    .unwrap();
    assert!(validate_vercel_embedding_envelope(&dim_mismatch, 2, None).is_err());

    let truncated: Value = serde_json::from_str(include_str!(
        "../../../fixtures/gateway-contracts/v1/fail-closed/embedding-truncated.json"
    ))
    .unwrap();
    assert!(validate_vercel_embedding_envelope(&truncated, 1, None).is_err());

    let chat_shaped: Value = serde_json::from_str(include_str!(
        "../../../fixtures/gateway-contracts/v1/fail-closed/embedding-chat-shaped.json"
    ))
    .unwrap();
    assert!(
        validate_vercel_embedding_envelope(&chat_shaped, 1, None).is_err(),
        "chat envelope must not satisfy the specialty embedding contract"
    );

    // Qualification transport fail-closed.
    for vector in [
        vec![],
        vec![f32::NAN],
        vec![f32::INFINITY, 0.1],
        vec![f32::NEG_INFINITY],
    ] {
        let mut t = ScriptedQualificationTransport::default();
        t.embed_queue.push(Ok(SyntheticEmbeddingResponse {
            vector,
            raw_error: None,
        }));
        let report = run_qualification(
            key("voyage/voyage-4"),
            gate_full(),
            &mut t,
            &Arc::new(AtomicBool::new(false)),
        );
        assert_eq!(
            report.status_of(CapabilityKind::EmbeddingContract),
            CapabilityStatus::Fail,
            "empty/non-finite must fail closed"
        );
    }
}

#[test]
fn rerank_fail_closed_matrix() {
    let duplicate: Value = serde_json::from_str(include_str!(
        "../../../fixtures/gateway-contracts/v1/fail-closed/rerank-duplicate-index.json"
    ))
    .unwrap();
    assert!(validate_vercel_ranking_envelope(&duplicate, 2, 2).is_err());

    let missing: Value = serde_json::from_str(include_str!(
        "../../../fixtures/gateway-contracts/v1/fail-closed/rerank-missing-index.json"
    ))
    .unwrap();
    // topN equals document_count but only two rows → length mismatch fails closed.
    assert!(validate_vercel_ranking_envelope(&missing, 3, 3).is_err());
    // topN=2 with indices {0,2} is length-ok for a partial top-N, but a full
    // permutation probe (topN == document_count) requires every index once.
    let incomplete_perm = serde_json::json!({
        "ranking": [
            { "index": 0, "relevanceScore": 0.9 },
            { "index": 1, "relevanceScore": 0.5 }
        ]
    });
    assert!(validate_vercel_ranking_envelope(&incomplete_perm, 3, 3).is_err());

    let out_of_range: Value = serde_json::from_str(include_str!(
        "../../../fixtures/gateway-contracts/v1/fail-closed/rerank-out-of-range.json"
    ))
    .unwrap();
    assert!(validate_vercel_ranking_envelope(&out_of_range, 3, 3).is_err());

    assert!(validate_rerank_scores(&[0.1, f32::NAN], 2).is_err());
    assert!(validate_rerank_scores(&[0.1], 2).is_err());

    // Empty ranking fails the qualification probe.
    let mut t = ScriptedQualificationTransport::default();
    t.rerank_queue.push(Ok(SyntheticRerankResponse {
        ranked_ids: vec![],
        raw_error: None,
    }));
    let report = run_qualification(
        key("voyage/rerank-2.5"),
        gate_full(),
        &mut t,
        &Arc::new(AtomicBool::new(false)),
    );
    assert_eq!(
        report.status_of(CapabilityKind::RerankerContract),
        CapabilityStatus::Fail
    );

    // Unknown ids must fail (role-mismatched / foreign permutation).
    let mut t = ScriptedQualificationTransport::default();
    t.rerank_queue.push(Ok(SyntheticRerankResponse {
        ranked_ids: vec!["foreign".into()],
        raw_error: None,
    }));
    let report = run_qualification(
        key("voyage/rerank-2.5"),
        gate_full(),
        &mut t,
        &Arc::new(AtomicBool::new(false)),
    );
    assert_eq!(
        report.status_of(CapabilityKind::RerankerContract),
        CapabilityStatus::Fail
    );
}

#[test]
fn role_mismatch_fails_closed() {
    // Chat-shaped body cannot validate as embedding.
    let chat_shaped: Value = serde_json::from_str(include_str!(
        "../../../fixtures/gateway-contracts/v1/fail-closed/embedding-chat-shaped.json"
    ))
    .unwrap();
    assert!(validate_vercel_embedding_envelope(&chat_shaped, 1, Some(1024)).is_err());

    // Embedding model must not be offered chat probes.
    assert_eq!(
        probes_for_role_hint(ModelRoleHint::Embedding),
        vec![CapabilityKind::EmbeddingContract]
    );
    // Running chat transport exhaustion against voyage must not invent a chat pass.
    let mut t = ScriptedQualificationTransport::default();
    // No embed response → fail embedding contract only.
    let report = run_qualification(
        key("voyage/voyage-4"),
        gate_full(),
        &mut t,
        &Arc::new(AtomicBool::new(false)),
    );
    assert_eq!(report.checks.len(), 1);
    assert_ne!(
        report.status_of(CapabilityKind::EmbeddingContract),
        CapabilityStatus::Pass
    );
    assert_eq!(
        report.status_of(CapabilityKind::BasicGeneration),
        CapabilityStatus::Untested
    );
}

#[test]
fn backend_error_envelopes_fail_closed() {
    let err_body: Value = serde_json::from_str(include_str!(
        "../../../fixtures/gateway-contracts/v1/fail-closed/backend-error-envelope.json"
    ))
    .unwrap();
    assert!(err_body.pointer("/error/message").is_some());
    // Chat-shaped success parsers must not treat error envelopes as completions.
    assert!(err_body.get("choices").is_none());
    assert!(err_body.get("embeddings").is_none());
    assert!(err_body.get("ranking").is_none());

    assert!(matches!(
        classify_probe_http_status(401),
        ProbeOutcome::KeyRejected { .. }
    ));
    assert!(matches!(
        classify_probe_http_status(500),
        ProbeOutcome::Unreachable { .. }
    ));
    assert!(matches!(
        classify_probe_http_status(429),
        ProbeOutcome::Unreachable { .. }
    ));

    let mut t = ScriptedQualificationTransport::default();
    t.chat_queue.push(Err(TransportError {
        reason: "HTTP 503 model_unavailable".into(),
    }));
    // Fill remaining chat probes with errors.
    for _ in 0..5 {
        t.chat_queue.insert(
            0,
            Err(TransportError {
                reason: "HTTP 503 model_unavailable".into(),
            }),
        );
    }
    let report = run_qualification(
        key("deepseek/deepseek-v4-flash"),
        gate_full(),
        &mut t,
        &Arc::new(AtomicBool::new(false)),
    );
    assert!(
        report
            .checks
            .iter()
            .all(|c| c.status == CapabilityStatus::Fail || c.status == CapabilityStatus::Untested),
        "backend errors must not pass: {:?}",
        report.checks
    );
    assert_eq!(
        report.status_of(CapabilityKind::BasicGeneration),
        CapabilityStatus::Fail
    );

    let mut t2 = ScriptedQualificationTransport::default();
    t2.embed_queue.push(Ok(SyntheticEmbeddingResponse {
        vector: vec![],
        raw_error: Some("HTTP 429 rate_limited".into()),
    }));
    let report2 = run_qualification(
        key("voyage/voyage-4"),
        gate_full(),
        &mut t2,
        &Arc::new(AtomicBool::new(false)),
    );
    assert_eq!(
        report2.status_of(CapabilityKind::EmbeddingContract),
        CapabilityStatus::Fail
    );
}

#[test]
fn fixtures_never_embed_secrets_or_live_metadata() {
    let root = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../fixtures/gateway-contracts/v1"
    );
    let mut files = Vec::new();
    collect_json_files(std::path::Path::new(root), &mut files);
    assert!(
        !files.is_empty(),
        "expected gateway-contract fixtures under {root}"
    );
    let forbidden = [
        "Bearer ",
        "sk-",
        "api_key",
        "authorization",
        "password",
        "x-request-id",
        "request_id",
        "billing",
        "account_id",
        "/Users/",
        "keychain",
    ];
    for path in files {
        let text = std::fs::read_to_string(&path).unwrap();
        let lower = text.to_ascii_lowercase();
        for needle in forbidden {
            assert!(
                !lower.contains(&needle.to_ascii_lowercase()),
                "{} must not contain {needle}",
                path.display()
            );
        }
    }
}

fn collect_json_files(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_json_files(&path, out);
        } else if path.extension().and_then(|e| e.to_str()) == Some("json") {
            out.push(path);
        }
    }
}
