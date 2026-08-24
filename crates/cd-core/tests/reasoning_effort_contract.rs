//! Hermetic reasoning-effort contract: body matrices, dialect refusal,
//! config preservation, and mutation fail-closed cases.
//!
//! No network, credentials, or readiness-store mutation.

use cd_core::config::{load_config, save_config, AppConfig};
use cd_core::openai_chat_contract::{
    build_openai_chat_request_body, ChatBackendDialect, OpenAiChatRequestMode,
};
use cd_core::providers::{ProviderKind, ProviderProfile};
use cd_core::reasoning_effort::{
    apply_reasoning_effort_to_body, body_has_effort_field, dialect_from_provider_kind,
    resolve_effort_policy, transport_candidate_levels, ChatApiSurface, EffectiveEffortPolicy,
    EffortApplyTelemetry, ReasoningEffortLevel, ReasoningEffortSettings,
    REASONING_EFFORT_SCHEMA_V1,
};
use serde_json::json;
use std::path::PathBuf;

fn temp_config() -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "cd-effort-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir.join("config.json")
}

#[test]
fn request_body_matrix_completions_levels() {
    for level in [
        ReasoningEffortLevel::None,
        ReasoningEffortLevel::Low,
        ReasoningEffortLevel::Medium,
        ReasoningEffortLevel::High,
        ReasoningEffortLevel::XHigh,
        ReasoningEffortLevel::Max,
    ] {
        let mut body = build_openai_chat_request_body(
            "fixture-model",
            &[],
            None,
            false,
            &OpenAiChatRequestMode::Plain,
        );
        let tel = apply_reasoning_effort_to_body(
            &mut body,
            ChatBackendDialect::OpenAiCompatible,
            ChatApiSurface::ChatCompletions,
            EffectiveEffortPolicy::Explicit(level),
        )
        .expect("supported completions level");
        assert_eq!(tel.schema, REASONING_EFFORT_SCHEMA_V1);
        assert_eq!(tel.effective, level.as_str());
        assert_eq!(tel.wire_field.as_deref(), Some("reasoning_effort"));
        assert_eq!(body["reasoning_effort"], json!(level.as_str()));
        // Never invent Responses nest on Completions.
        assert!(body
            .get("reasoning")
            .and_then(|r| r.get("effort"))
            .is_none());
    }
}

#[test]
fn request_body_matrix_responses_uses_nested_field_only() {
    for level in ReasoningEffortLevel::all() {
        let mut body = json!({"model": "m", "input": []});
        let tel = apply_reasoning_effort_to_body(
            &mut body,
            ChatBackendDialect::OpenAiCompatible,
            ChatApiSurface::Responses,
            EffectiveEffortPolicy::Explicit(*level),
        )
        .unwrap();
        assert_eq!(tel.wire_field.as_deref(), Some("reasoning.effort"));
        assert_eq!(tel.requested, level.as_str());
        assert_eq!(body["reasoning"]["effort"], json!(level.as_str()));
        assert!(body.get("reasoning_effort").is_none());
    }
}

#[test]
fn omit_default_leaves_plain_body_byte_identical_for_effort_keys() {
    let base = build_openai_chat_request_body("m", &[], None, false, &OpenAiChatRequestMode::Plain);
    let mut with_omit = base.clone();
    apply_reasoning_effort_to_body(
        &mut with_omit,
        ChatBackendDialect::OpenAiCompatible,
        ChatApiSurface::ChatCompletions,
        EffectiveEffortPolicy::Omit,
    )
    .unwrap();
    assert_eq!(base, with_omit);
    assert!(!body_has_effort_field(&with_omit));
}

#[test]
fn dialect_refusal_ollama_and_anthropic_no_field_leak() {
    for dialect in [ChatBackendDialect::Ollama, ChatBackendDialect::Anthropic] {
        let mut body = json!({"model": "m"});
        let err = apply_reasoning_effort_to_body(
            &mut body,
            dialect,
            ChatApiSurface::ChatCompletions,
            EffectiveEffortPolicy::Explicit(ReasoningEffortLevel::Medium),
        )
        .unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains("reasoning_effort_unsupported"),
            "typed refuse: {msg}"
        );
        assert!(!body_has_effort_field(&body));
    }
}

#[test]
fn mutation_silent_clamp_of_max_on_completions_is_detected() {
    let mut body = json!({});
    let tel = apply_reasoning_effort_to_body(
        &mut body,
        ChatBackendDialect::OpenAiCompatible,
        ChatApiSurface::ChatCompletions,
        EffectiveEffortPolicy::Explicit(ReasoningEffortLevel::Max),
    )
    .unwrap();
    assert_eq!(tel.requested, "max");
    assert_eq!(tel.effective, "max");
    assert_eq!(body["reasoning_effort"], json!("max"));
    assert_ne!(body["reasoning_effort"], json!("high"));
}

#[test]
fn mutation_unsupported_field_leakage_on_responses_vs_completions() {
    // Completions must not write reasoning.effort
    let mut completions = json!({});
    apply_reasoning_effort_to_body(
        &mut completions,
        ChatBackendDialect::OpenAiCompatible,
        ChatApiSurface::ChatCompletions,
        EffectiveEffortPolicy::Explicit(ReasoningEffortLevel::Low),
    )
    .unwrap();
    assert!(completions.get("reasoning").is_none());
    assert!(completions.get("reasoning_effort").is_some());

    // Responses must not write top-level reasoning_effort
    let mut responses = json!({});
    apply_reasoning_effort_to_body(
        &mut responses,
        ChatBackendDialect::OpenAiCompatible,
        ChatApiSurface::Responses,
        EffectiveEffortPolicy::Explicit(ReasoningEffortLevel::Low),
    )
    .unwrap();
    assert!(responses.get("reasoning_effort").is_none());
    assert!(responses["reasoning"]["effort"].is_string());
}

#[test]
fn malformed_values_rejected_without_clamp() {
    for bad in ["", "  ", "ultra", "higher", "1", "HIGHISH"] {
        assert!(
            ReasoningEffortLevel::parse(bad).is_err(),
            "should reject {bad:?}"
        );
    }
}

#[test]
fn precedence_override_saved_omit() {
    let mut saved = ReasoningEffortSettings::default();
    assert_eq!(
        resolve_effort_policy(None, &saved),
        EffectiveEffortPolicy::Omit
    );
    saved.apply_level(ReasoningEffortLevel::High);
    assert_eq!(
        resolve_effort_policy(None, &saved),
        EffectiveEffortPolicy::Explicit(ReasoningEffortLevel::High)
    );
    assert_eq!(
        resolve_effort_policy(Some(ReasoningEffortLevel::Low), &saved),
        EffectiveEffortPolicy::Explicit(ReasoningEffortLevel::Low)
    );
}

#[test]
fn config_migration_preserves_unrelated_fields_and_defaults_omit() {
    let path = temp_config();
    let mut cfg = AppConfig {
        theme: "slate".into(),
        web_research_enabled: true,
        default_chat_model: Some("fixture-model".into()),
        ..AppConfig::default()
    };
    cfg.router.max_tool_rounds = 7;
    // Historical files may omit `reasoning_effort`. Plant bytes — do not call
    // production `save_config`, which is Unix-only.
    let mut value = serde_json::to_value(&cfg).unwrap();
    value.as_object_mut().unwrap().remove("reasoning_effort");
    std::fs::write(&path, serde_json::to_string_pretty(&value).unwrap()).unwrap();

    let loaded = load_config(&path).unwrap();
    assert!(loaded.reasoning_effort.is_omit());
    assert_eq!(loaded.theme, "slate");
    assert!(loaded.web_research_enabled);
    assert_eq!(loaded.router.max_tool_rounds, 7);
    assert_eq!(loaded.default_chat_model.as_deref(), Some("fixture-model"));

    let mut next = loaded;
    next.reasoning_effort
        .apply_level(ReasoningEffortLevel::Medium);
    #[cfg(unix)]
    {
        save_config(&path, &next).unwrap();
        let again = load_config(&path).unwrap();
        assert_eq!(
            again.reasoning_effort.level,
            Some(ReasoningEffortLevel::Medium)
        );
        assert_eq!(again.theme, "slate");
        assert_eq!(again.router.max_tool_rounds, 7);
    }
    #[cfg(not(unix))]
    {
        let before = std::fs::read(&path).unwrap();
        let err = save_config(&path, &next).expect_err("non-unix save is fail-closed");
        assert!(
            cd_core::config::durable_config_persistence_unsupported(&err),
            "{err}"
        );
        assert!(
            err.to_string()
                .contains(cd_core::config::DURABLE_CONFIG_SAVE_UNSUPPORTED),
            "{err}"
        );
        assert_eq!(before, std::fs::read(&path).unwrap());
        let again = load_config(&path).unwrap();
        assert!(again.reasoning_effort.is_omit());
        assert_eq!(again.theme, "slate");
        assert_eq!(again.router.max_tool_rounds, 7);
    }
    let _ = std::fs::remove_file(&path);
}

#[test]
fn mutation_override_does_not_persist_when_only_resolve_policy_used() {
    // Simulate: override applied in memory, saved config remains omit.
    let saved = ReasoningEffortSettings::default();
    let effective = resolve_effort_policy(Some(ReasoningEffortLevel::High), &saved);
    assert_eq!(
        effective,
        EffectiveEffortPolicy::Explicit(ReasoningEffortLevel::High)
    );
    assert!(saved.is_omit(), "saved settings must stay omit");
}

#[test]
fn dialect_from_provider_kind_maps_without_hardcoding_model_names() {
    assert_eq!(
        dialect_from_provider_kind(ProviderKind::OpenAiCompatible),
        ChatBackendDialect::OpenAiCompatible
    );
    assert_eq!(
        dialect_from_provider_kind(ProviderKind::Ollama),
        ChatBackendDialect::Ollama
    );
    assert!(transport_candidate_levels(
        ChatBackendDialect::Ollama,
        ChatApiSurface::ChatCompletions
    )
    .is_empty());
    let _ = ProviderProfile::ollama_local();
}

#[test]
fn telemetry_labels_are_share_safe() {
    let tel = EffortApplyTelemetry {
        schema: REASONING_EFFORT_SCHEMA_V1,
        requested: "high".into(),
        effective: "high".into(),
        dialect: "openai_compatible".into(),
        surface: "chat_completions".into(),
        wire_field: Some("reasoning_effort".into()),
    };
    let s = serde_json::to_string(&tel).unwrap();
    for forbidden in [
        "sk-",
        "http://",
        "https://",
        "Authorization",
        "/Users/",
        "Bearer ",
    ] {
        assert!(!s.contains(forbidden), "leaked {forbidden} in {s}");
    }
}

/// Production client path: non-Omit policy emits `reasoning_effort` on the real wire.
#[tokio::test]
async fn openai_client_with_effort_emits_reasoning_effort_on_wire() {
    use cd_core::chat::{ChatMessage, OpenAiCompatibleClient, Role};
    use cd_core::ssrf::SsrfPolicy;
    use cd_test_gateway::{MockGateway, Response, Step};

    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::json_ok(&json!({
        "id": "chatcmpl-effort",
        "model": "fixture-model",
        "choices": [{
            "index": 0,
            "finish_reason": "stop",
            "message": {"role": "assistant", "content": "ok"}
        }],
    })))])
    .await;

    let client = OpenAiCompatibleClient::new(
        format!("{}/v1", gateway.base_url()),
        None,
        "fixture-model",
        &SsrfPolicy::default(),
    )
    .expect("client")
    .with_reasoning_effort(EffectiveEffortPolicy::Explicit(ReasoningEffortLevel::High));

    let messages = vec![ChatMessage {
        role: Role::User,
        content: "hi".into(),
        tool_call_id: None,
        tool_calls: None,
    }];
    let completion = client.complete(&messages, None).await.expect("complete");
    assert_eq!(completion.content, "ok");
    assert_eq!(
        completion.telemetry.reasoning_effort_requested.as_deref(),
        Some("high")
    );
    assert_eq!(
        completion.telemetry.reasoning_effort_effective.as_deref(),
        Some("high")
    );

    let body = gateway.requests()[0]
        .json_body()
        .expect("json request body");
    assert_eq!(
        body["reasoning_effort"],
        json!("high"),
        "production client must put effort on the Chat Completions body"
    );
    assert!(
        body.get("reasoning")
            .and_then(|r| r.get("effort"))
            .is_none(),
        "must not invent Responses nest on Completions client"
    );
}

/// Exact-target refusal remains structured provider evidence. The client must
/// not retry with a lower value or reinterpret the refusal as a successful
/// capability observation.
#[tokio::test]
async fn openai_client_preserves_exact_effort_refusal_without_downgrade() {
    use cd_core::chat::{ChatMessage, OpenAiCompatibleClient, Role};
    use cd_core::error::CoreError;
    use cd_core::ssrf::SsrfPolicy;
    use cd_test_gateway::{MockGateway, Response, Step};

    let refusal = json!({"error": {"message": "unsupported reasoning_effort=max"}});
    let gateway =
        MockGateway::start_ordered(vec![Step::respond(Response::json(400, &refusal))]).await;
    let client = OpenAiCompatibleClient::new(
        format!("{}/v1", gateway.base_url()),
        None,
        "fixture-model",
        &SsrfPolicy::default(),
    )
    .unwrap()
    .with_reasoning_effort(EffectiveEffortPolicy::Explicit(ReasoningEffortLevel::Max));
    let messages = vec![ChatMessage {
        role: Role::User,
        content: "hi".into(),
        tool_call_id: None,
        tool_calls: None,
    }];

    let error = client.complete(&messages, None).await.unwrap_err();
    assert_eq!(error.provider_http_status(), Some(400));
    assert!(matches!(&error, CoreError::ProviderHttp { .. }));
    assert!(error
        .provider_http_body()
        .is_some_and(|body| body.contains("unsupported reasoning_effort=max")));
    let requests = gateway.requests();
    assert_eq!(requests.len(), 1, "must not retry with another effort");
    let body = requests[0].json_body().expect("json body");
    assert_eq!(body["reasoning_effort"], json!("max"));
}

/// Omit policy leaves the real client request free of effort fields.
#[tokio::test]
async fn openai_client_omit_does_not_emit_effort_field() {
    use cd_core::chat::{ChatMessage, OpenAiCompatibleClient, Role};
    use cd_core::ssrf::SsrfPolicy;
    use cd_test_gateway::{MockGateway, Response, Step};

    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::json_ok(&json!({
        "id": "chatcmpl-omit",
        "model": "fixture-model",
        "choices": [{
            "index": 0,
            "finish_reason": "stop",
            "message": {"role": "assistant", "content": "ok"}
        }],
    })))])
    .await;

    let client = OpenAiCompatibleClient::new(
        format!("{}/v1", gateway.base_url()),
        None,
        "fixture-model",
        &SsrfPolicy::default(),
    )
    .expect("client");
    let messages = vec![ChatMessage {
        role: Role::User,
        content: "hi".into(),
        tool_call_id: None,
        tool_calls: None,
    }];
    client.complete(&messages, None).await.expect("complete");
    let body = gateway.requests()[0].json_body().expect("json body");
    assert!(body.get("reasoning_effort").is_none());
    assert!(!body_has_effort_field(&body));
}

/// Research factory used by the turn path must honor non-Omit effort.
#[tokio::test]
async fn backend_for_with_timeout_and_effort_emits_on_openai_wire() {
    use cd_core::chat::{ChatMessage, Role};
    use cd_core::providers::{ProviderKind, ProviderProfile};
    use cd_core::research::backend_for_with_timeout_and_effort;
    use cd_test_gateway::{MockGateway, Response, Step};
    use std::time::Duration;

    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::json_ok(&json!({
        "id": "chatcmpl-factory",
        "model": "fixture-model",
        "choices": [{
            "index": 0,
            "finish_reason": "stop",
            "message": {"role": "assistant", "content": "from-factory"}
        }],
    })))])
    .await;

    let profile = ProviderProfile {
        id: "effort-fixture".into(),
        label: "effort fixture".into(),
        kind: ProviderKind::OpenAiCompatible,
        base_url: format!("{}/v1", gateway.base_url()),
        api_key_ref: None,
        chat_model: "fixture-model".into(),
        embedding_model: None,
        embedding_base_url: None,
        capabilities: Default::default(),
        local_only: false,
        deadline_preference: Default::default(),
    };

    let backend = backend_for_with_timeout_and_effort(
        &profile,
        None,
        Duration::from_secs(30),
        EffectiveEffortPolicy::Explicit(ReasoningEffortLevel::Medium),
    )
    .await
    .expect("backend");

    let messages = vec![ChatMessage {
        role: Role::User,
        content: "factory".into(),
        tool_call_id: None,
        tool_calls: None,
    }];
    let completion = cd_core::agent::ChatBackend::complete(backend.as_ref(), &messages, &[])
        .await
        .expect("complete via ChatBackend");
    assert_eq!(completion.content, "from-factory");

    let body = gateway.requests()[0].json_body().expect("json body");
    assert_eq!(
        body["reasoning_effort"],
        json!("medium"),
        "research factory must apply effort on the production OpenAI backend path"
    );
}

/// Structural: production research_turn entry must call the effort-aware factory.
#[test]
fn research_turn_source_uses_effort_aware_factory() {
    let src = include_str!("../src/research.rs");
    assert!(
        src.contains("backend_for_with_timeout_and_effort("),
        "research_turn must construct backends via backend_for_with_timeout_and_effort"
    );
    assert!(
        src.contains("reasoning_effort: crate::reasoning_effort::EffectiveEffortPolicy"),
        "research_turn must take a reasoning_effort parameter"
    );
}

/// Production SSE path: `complete_stream_cb` must retain effort telemetry
/// through StreamAccumulator.merge_telemetry → into_completion (agent
/// complete_streaming uses this path).
#[tokio::test]
async fn openai_stream_cb_with_effort_retains_telemetry_on_completion() {
    use cd_core::chat::{ChatMessage, OpenAiCompatibleClient, Role, StreamDelta};
    use cd_core::ssrf::SsrfPolicy;
    use cd_test_gateway::{Body, Frame, MockGateway, Response, Step};

    let sse = concat!(
        "data: {\"choices\":[{\"delta\":{\"content\":\"streamed\"}}]}\n\n",
        "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":1,\"total_tokens\":2}}\n\n",
        "data: [DONE]\n\n",
    );
    let gateway = MockGateway::start_ordered(vec![Step::respond(
        Response::new(200, Body::Stream(vec![Frame::new(sse.as_bytes().to_vec())]))
            .with_header("content-type", "text/event-stream"),
    )])
    .await;

    let client = OpenAiCompatibleClient::new(
        format!("{}/v1", gateway.base_url()),
        None,
        "fixture-model",
        &SsrfPolicy::default(),
    )
    .expect("client")
    .with_reasoning_effort(EffectiveEffortPolicy::Explicit(ReasoningEffortLevel::High));

    let messages = vec![ChatMessage {
        role: Role::User,
        content: "stream".into(),
        tool_call_id: None,
        tool_calls: None,
    }];
    let mut deltas = Vec::new();
    let completion = client
        .complete_stream_cb(
            &messages,
            None,
            |d| {
                if let StreamDelta::Text(t) = d {
                    deltas.push(t);
                }
            },
            None,
        )
        .await
        .expect("stream complete");
    assert_eq!(completion.content, "streamed");
    assert_eq!(
        completion.telemetry.reasoning_effort_requested.as_deref(),
        Some("high"),
        "SSE path must keep requested effort after merge_telemetry/into_completion"
    );
    assert_eq!(
        completion.telemetry.reasoning_effort_effective.as_deref(),
        Some("high"),
        "SSE path must keep effective effort after usage merge"
    );
    // Wire still carries the field.
    let body = gateway.requests()[0].json_body().expect("json body");
    assert_eq!(body["reasoning_effort"], json!("high"));
}

/// ChatBackend streaming path (what the agent loop uses) retains effort labels.
#[tokio::test]
async fn chat_backend_complete_streaming_retains_effort_telemetry() {
    use cd_core::chat::{ChatMessage, Role};
    use cd_core::providers::{ProviderKind, ProviderProfile};
    use cd_core::research::backend_for_with_timeout_and_effort;
    use cd_test_gateway::{Body, Frame, MockGateway, Response, Step};
    use std::time::Duration;

    let sse = concat!(
        "data: {\"choices\":[{\"delta\":{\"content\":\"via-backend\"}}]}\n\n",
        "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
        "data: [DONE]\n\n",
    );
    let gateway = MockGateway::start_ordered(vec![Step::respond(
        Response::new(200, Body::Stream(vec![Frame::new(sse.as_bytes().to_vec())]))
            .with_header("content-type", "text/event-stream"),
    )])
    .await;

    let profile = ProviderProfile {
        id: "effort-stream".into(),
        label: "effort stream".into(),
        kind: ProviderKind::OpenAiCompatible,
        base_url: format!("{}/v1", gateway.base_url()),
        api_key_ref: None,
        chat_model: "fixture-model".into(),
        embedding_model: None,
        embedding_base_url: None,
        capabilities: Default::default(),
        local_only: false,
        deadline_preference: Default::default(),
    };

    let backend = backend_for_with_timeout_and_effort(
        &profile,
        None,
        Duration::from_secs(30),
        EffectiveEffortPolicy::Explicit(ReasoningEffortLevel::Medium),
    )
    .await
    .expect("backend");

    let messages = vec![ChatMessage {
        role: Role::User,
        content: "stream".into(),
        tool_call_id: None,
        tool_calls: None,
    }];
    let mut text = String::new();
    let completion = cd_core::agent::ChatBackend::complete_streaming(
        backend.as_ref(),
        &messages,
        &[],
        &mut |chunk| text.push_str(&chunk),
        None,
    )
    .await
    .expect("complete_streaming");
    assert_eq!(completion.content, "via-backend");
    assert_eq!(text, "via-backend");
    assert_eq!(
        completion.telemetry.reasoning_effort_requested.as_deref(),
        Some("medium")
    );
    assert_eq!(
        completion.telemetry.reasoning_effort_effective.as_deref(),
        Some("medium")
    );
    let body = gateway.requests()[0].json_body().expect("json body");
    assert_eq!(body["reasoning_effort"], json!("medium"));
}
