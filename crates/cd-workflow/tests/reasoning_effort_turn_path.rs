//! Production turn-path: resolved effort reaches the OpenAI wire via
//! `resolve_turn_inputs` → `backend_for_resolved_turn` (the factory
//! `run_turn` / research_turn use after this fix).

use cd_core::chat::{ChatMessage, Role};
use cd_core::config::AppConfig;
use cd_core::keychain_store::SecretStore;
use cd_core::providers::{ProviderConfig, ProviderKind, ProviderProfile};
use cd_core::reasoning_effort::{EffectiveEffortPolicy, ReasoningEffortLevel};
use cd_test_gateway::{MockGateway, Response, Step};
use cd_workflow::provider::{backend_for_resolved_turn, resolve_turn_inputs};
use serde_json::json;

struct NoSecrets;
impl SecretStore for NoSecrets {
    fn get(&self, _reference: &str) -> cd_core::error::CoreResult<Option<String>> {
        Ok(None)
    }
    fn set(&self, _reference: &str, _value: &str) -> cd_core::error::CoreResult<()> {
        Ok(())
    }
    fn delete(&self, _reference: &str) -> cd_core::error::CoreResult<()> {
        Ok(())
    }
}

fn openai_profile(base_url: &str) -> ProviderProfile {
    ProviderProfile {
        id: "effort-openai".into(),
        label: "effort openai".into(),
        kind: ProviderKind::OpenAiCompatible,
        base_url: base_url.into(),
        api_key_ref: None,
        chat_model: "fixture-model".into(),
        embedding_model: None,
        embedding_base_url: None,
        capabilities: Default::default(),
        local_only: false,
        deadline_preference: Default::default(),
    }
}

fn cfg_with_openai(base_url: &str) -> AppConfig {
    AppConfig {
        providers: ProviderConfig {
            active_id: Some("effort-openai".into()),
            profiles: vec![openai_profile(base_url)],
        },
        ..AppConfig::default()
    }
}

#[tokio::test]
async fn default_auto_policy_preserves_standard_wire_shape() {
    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::json_ok(&json!({
        "id": "chatcmpl-auto",
        "model": "fixture-model",
        "choices": [{
            "index": 0,
            "finish_reason": "stop",
            "message": {"role": "assistant", "content": "auto"}
        }],
    })))])
    .await;
    let cfg = cfg_with_openai(&format!("{}/v1", gateway.base_url()));
    assert!(cfg.reasoning_effort.is_omit());
    let resolved = resolve_turn_inputs(&NoSecrets, &cfg, None, None).unwrap();
    assert_eq!(resolved.reasoning_effort, EffectiveEffortPolicy::Omit);
    let backend = backend_for_resolved_turn(&resolved).await.unwrap();
    let messages = vec![ChatMessage {
        role: Role::User,
        content: "auto".into(),
        tool_call_id: None,
        tool_calls: None,
    }];
    cd_core::agent::ChatBackend::complete(backend.as_ref(), &messages, &[])
        .await
        .unwrap();
    let body = gateway.requests()[0].json_body().unwrap();
    assert!(body.get("reasoning_effort").is_none());
    assert!(body.get("reasoning").is_none());
}

#[tokio::test]
async fn saved_effort_reaches_wire_through_resolved_turn_backend() {
    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::json_ok(&json!({
        "id": "chatcmpl-turn",
        "model": "fixture-model",
        "choices": [{
            "index": 0,
            "finish_reason": "stop",
            "message": {"role": "assistant", "content": "turn-ok"}
        }],
    })))])
    .await;

    let mut cfg = cfg_with_openai(&format!("{}/v1", gateway.base_url()));
    cfg.reasoning_effort.apply_level(ReasoningEffortLevel::High);

    let resolved = resolve_turn_inputs(&NoSecrets, &cfg, None, None).expect("resolve");
    assert_eq!(
        resolved.reasoning_effort,
        EffectiveEffortPolicy::Explicit(ReasoningEffortLevel::High),
        "saved AppConfig effort must populate ResolvedTurnInputs"
    );

    let backend = backend_for_resolved_turn(&resolved)
        .await
        .expect("backend for resolved turn");
    let messages = vec![ChatMessage {
        role: Role::User,
        content: "turn".into(),
        tool_call_id: None,
        tool_calls: None,
    }];
    // Drive the trait method on the production dyn ChatBackend.
    let completion = cd_core::agent::ChatBackend::complete(backend.as_ref(), &messages, &[])
        .await
        .expect("complete");
    assert_eq!(completion.content, "turn-ok");

    let body = gateway.requests()[0].json_body().expect("json body");
    assert_eq!(
        body["reasoning_effort"],
        json!("high"),
        "backend_for_resolved_turn must apply ResolvedTurnInputs.reasoning_effort on the wire"
    );
}

#[tokio::test]
async fn per_turn_override_on_resolved_inputs_beats_saved_omit() {
    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::json_ok(&json!({
        "id": "chatcmpl-override",
        "model": "fixture-model",
        "choices": [{
            "index": 0,
            "finish_reason": "stop",
            "message": {"role": "assistant", "content": "ov"}
        }],
    })))])
    .await;

    let cfg = cfg_with_openai(&format!("{}/v1", gateway.base_url()));
    assert!(cfg.reasoning_effort.is_omit());

    let mut resolved = resolve_turn_inputs(&NoSecrets, &cfg, None, None).expect("resolve");
    assert_eq!(resolved.reasoning_effort, EffectiveEffortPolicy::Omit);

    resolved.reasoning_effort = EffectiveEffortPolicy::Explicit(ReasoningEffortLevel::Low);
    assert!(
        cfg.reasoning_effort.is_omit(),
        "override must not mutate AppConfig"
    );

    let backend = backend_for_resolved_turn(&resolved).await.expect("backend");
    let messages = vec![ChatMessage {
        role: Role::User,
        content: "ov".into(),
        tool_call_id: None,
        tool_calls: None,
    }];
    cd_core::agent::ChatBackend::complete(backend.as_ref(), &messages, &[])
        .await
        .expect("complete");
    let body = gateway.requests()[0].json_body().expect("json body");
    assert_eq!(body["reasoning_effort"], json!("low"));
}

/// Structural: run_turn must pass resolved.reasoning_effort into research_turn.
#[test]
fn run_turn_source_passes_resolved_reasoning_effort() {
    let src = include_str!("../src/turn.rs");
    assert!(
        src.contains("resolved.reasoning_effort"),
        "run_turn must pass resolved.reasoning_effort into research_turn"
    );
    assert!(
        src.contains("research_turn_with_cancel_and_context_and_checkpoint_and_trace"),
        "run_turn must call the shared research entry"
    );
}
