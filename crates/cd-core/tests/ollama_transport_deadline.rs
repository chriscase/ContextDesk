//! Gateway wire conformance — Ollama transport ceiling.
//!
//! The router explicitly grants Ollama profiles patient deadlines
//! (`provider_prefers_patient_deadlines`), and `backend_for_with_timeout`'s
//! contract says the transport ceiling follows the host-owned turn budget.
//! These tests drive the real `OllamaClient` through the production
//! `backend_for_with_timeout` factory against a hermetic local gateway and
//! prove the caller-owned ceiling — not a hidden constructor default —
//! bounds the request in both directions.

use cd_core::chat::OllamaClient;
use cd_core::providers::{ProviderCapabilities, ProviderKind, ProviderProfile};
use cd_core::research::backend_for_with_timeout;
use cd_test_gateway::{MockGateway, Response, Step};
use serde_json::json;
use std::time::Duration;

fn ollama_profile(base_url: &str) -> ProviderProfile {
    ProviderProfile {
        id: "ollama-deadline-profile".into(),
        label: "ollama deadline oracle".into(),
        kind: ProviderKind::Ollama,
        base_url: base_url.into(),
        api_key_ref: None,
        chat_model: "patient-model".into(),
        embedding_model: None,
        embedding_base_url: None,
        capabilities: ProviderCapabilities::local_full(),
        local_only: true,
        deadline_preference: Default::default(),
    }
}

fn ollama_completion(text: &str) -> Response {
    Response::json_ok(&json!({
        "model": "patient-model",
        "message": { "role": "assistant", "content": text },
        "done": true
    }))
}

fn probe_messages() -> Vec<cd_core::chat::ChatMessage> {
    vec![cd_core::chat::ChatMessage {
        role: cd_core::chat::Role::User,
        content: "transport ceiling probe".into(),
        tool_call_id: None,
        tool_calls: None,
    }]
}

/// A host-owned ceiling shorter than the provider's latency must cut the
/// request off at the ceiling — never wait out the legacy 120s default.
#[tokio::test(flavor = "multi_thread")]
async fn turn_owned_ceiling_bounds_a_slow_ollama_response() {
    let gateway = MockGateway::start_ordered(vec![Step::respond(
        ollama_completion("too late").with_header_delay(Duration::from_millis(600)),
    )])
    .await;
    let backend = backend_for_with_timeout(
        &ollama_profile(gateway.base_url()),
        None,
        Duration::from_millis(120),
    )
    .await
    .expect("ollama backend construction");
    let started = std::time::Instant::now();
    let result = backend.complete(&probe_messages(), &[]).await;
    let elapsed = started.elapsed();
    assert!(
        result.is_err(),
        "a 120ms turn-owned ceiling must bound a 600ms Ollama response"
    );
    assert!(
        elapsed < Duration::from_secs(5),
        "the ceiling must be the configured 120ms, not a hidden constructor default (took {elapsed:?})"
    );
    drop(gateway);
}

/// A patient host-owned ceiling must allow a response the legacy default
/// would also have allowed — threading the timeout must never shorten it.
#[tokio::test(flavor = "multi_thread")]
async fn patient_turn_owned_ceiling_allows_a_slow_ollama_response() {
    let gateway = MockGateway::start_ordered(vec![Step::respond(
        ollama_completion("patient success").with_header_delay(Duration::from_millis(300)),
    )])
    .await;
    let backend = backend_for_with_timeout(
        &ollama_profile(gateway.base_url()),
        None,
        Duration::from_secs(30),
    )
    .await
    .expect("ollama backend construction");
    let completion = backend
        .complete(&probe_messages(), &[])
        .await
        .expect("patient ceiling must not cut off a permitted slow response");
    assert_eq!(completion.content, "patient success");
    drop(gateway);
}

/// The Ollama constructor rejects a zero ceiling exactly like the
/// OpenAI-compatible and Anthropic clients, instead of building a client
/// with no bound at all.
#[test]
fn zero_request_timeout_is_rejected_at_construction() {
    let err =
        OllamaClient::new_with_timeout("http://127.0.0.1:11434", "patient-model", Duration::ZERO);
    assert!(err.is_err(), "a zero transport ceiling must fail closed");
}
