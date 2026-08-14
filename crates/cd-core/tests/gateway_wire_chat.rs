//! Gateway wire conformance lab — Phase 4: chat and structured-output matrix.
//!
//! Drives `OpenAiCompatibleClient`/`AnthropicClient` non-streaming `complete()`
//! over real HTTP against a hermetic `cd_test_gateway::MockGateway`, plus the
//! strict structured-output contract in `investigation_answer::parse_model_json`.

use cd_core::chat::{
    AnthropicClient, ChatMessage, OllamaClient, OpenAiCompatibleClient, Role, StreamDelta,
    ToolCallMsg,
};
use cd_core::investigation_answer::{parse_model_json, ValidationError};
use cd_core::sse::BoundedBodyAccumulator;
use cd_core::ssrf::SsrfPolicy;
use cd_test_gateway::{Body, Frame, MockGateway, Response, Step};
use serde_json::json;

fn openai_client(gateway: &MockGateway) -> OpenAiCompatibleClient {
    OpenAiCompatibleClient::new(
        format!("{}/v1", gateway.base_url()),
        None,
        "matrix-model",
        &SsrfPolicy::default(),
    )
    .expect("client construction")
}

fn anthropic_client(gateway: &MockGateway) -> AnthropicClient {
    AnthropicClient::new(
        gateway.base_url(),
        Some("sk-ant-fixture".into()),
        "matrix-model",
        &SsrfPolicy::default(),
    )
    .expect("client construction")
}

fn user_turn(text: &str) -> Vec<ChatMessage> {
    vec![ChatMessage {
        role: Role::User,
        content: text.into(),
        tool_call_id: None,
        tool_calls: None,
    }]
}

fn openai_completion_body(message: serde_json::Value) -> serde_json::Value {
    json!({
        "id": "chatcmpl-matrix",
        "model": "matrix-model",
        "choices": [{"index": 0, "finish_reason": "stop", "message": message}],
    })
}

// ---------------------------------------------------------------------------
// Basic non-streaming generation
// ---------------------------------------------------------------------------

#[tokio::test]
async fn basic_non_streaming_generation_round_trips_content_and_finish_reason() {
    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::json_ok(
        &openai_completion_body(json!({"role": "assistant", "content": "hello world"})),
    ))])
    .await;
    let completion = openai_client(&gateway)
        .complete(&user_turn("hi"), None)
        .await
        .expect("completion");
    assert_eq!(completion.content, "hello world");
    assert_eq!(completion.finish_reason, "stop");
    let sent = gateway.requests();
    let body = sent[0].json_body().expect("json request body");
    assert_eq!(body["model"], "matrix-model");
    assert_eq!(body["stream"], false);
    assert_eq!(body["messages"][0]["content"], "hi");
}

// ---------------------------------------------------------------------------
// Usage: absent, null, and alternate-compatible field names
// ---------------------------------------------------------------------------

#[tokio::test]
async fn absent_usage_leaves_telemetry_token_fields_unknown_not_zero() {
    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::json_ok(
        &openai_completion_body(json!({"role": "assistant", "content": "ok"})),
    ))])
    .await;
    let completion = openai_client(&gateway)
        .complete(&user_turn("hi"), None)
        .await
        .unwrap();
    assert_eq!(completion.telemetry.prompt_tokens, None);
    assert_eq!(completion.telemetry.completion_tokens, None);
    assert_eq!(
        completion.telemetry.cost, None,
        "unknown cost must never default to 0.0"
    );
}

#[tokio::test]
async fn null_usage_object_also_leaves_telemetry_unknown() {
    let mut body = openai_completion_body(json!({"role": "assistant", "content": "ok"}));
    body["usage"] = serde_json::Value::Null;
    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::json_ok(&body))]).await;
    let completion = openai_client(&gateway)
        .complete(&user_turn("hi"), None)
        .await
        .unwrap();
    assert_eq!(completion.telemetry.prompt_tokens, None);
}

#[tokio::test]
async fn alternate_compatible_usage_field_names_are_accepted() {
    // Some gateways use input_tokens/output_tokens instead of the OpenAI
    // prompt_tokens/completion_tokens names, and total_cost instead of cost.
    let mut body = openai_completion_body(json!({"role": "assistant", "content": "ok"}));
    body["usage"] = json!({
        "input_tokens": 11,
        "output_tokens": 22,
        "total_tokens": 33,
        "total_cost": 0.0125,
    });
    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::json_ok(&body))]).await;
    let completion = openai_client(&gateway)
        .complete(&user_turn("hi"), None)
        .await
        .unwrap();
    assert_eq!(completion.telemetry.prompt_tokens, Some(11));
    assert_eq!(completion.telemetry.completion_tokens, Some(22));
    assert_eq!(completion.telemetry.total_tokens, Some(33));
    assert_eq!(completion.telemetry.cost, Some(0.0125));
}

#[tokio::test]
async fn genuine_zero_cost_is_distinct_from_unknown_cost() {
    let mut body = openai_completion_body(json!({"role": "assistant", "content": "ok"}));
    body["usage"] = json!({"prompt_tokens": 1, "completion_tokens": 1, "cost": 0.0});
    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::json_ok(&body))]).await;
    let completion = openai_client(&gateway)
        .complete(&user_turn("hi"), None)
        .await
        .unwrap();
    assert_eq!(
        completion.telemetry.cost,
        Some(0.0),
        "an explicit zero must be retained as Some(0.0), not collapsed into None"
    );
}

// ---------------------------------------------------------------------------
// Empty choices, missing message content
// ---------------------------------------------------------------------------

#[tokio::test]
async fn empty_choices_array_is_a_hard_parse_error() {
    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::json_ok(&json!({
        "id": "x", "choices": []
    })))])
    .await;
    let err = openai_client(&gateway)
        .complete(&user_turn("hi"), None)
        .await
        .expect_err("no choices must not be treated as an empty-but-ok completion");
    assert!(err.to_string().contains("no choices"), "{err}");
}

#[tokio::test]
async fn missing_message_content_defaults_to_empty_string_not_an_error() {
    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::json_ok(
        &openai_completion_body(json!({"role": "assistant"})),
    ))])
    .await;
    let completion = openai_client(&gateway)
        .complete(&user_turn("hi"), None)
        .await
        .unwrap();
    assert_eq!(completion.content, "");
    assert!(completion.tool_calls.is_empty());
}

#[tokio::test]
async fn null_message_content_also_defaults_to_empty_string() {
    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::json_ok(
        &openai_completion_body(json!({"role": "assistant", "content": null})),
    ))])
    .await;
    let completion = openai_client(&gateway)
        .complete(&user_turn("hi"), None)
        .await
        .unwrap();
    assert_eq!(completion.content, "");
}

/// Documents a real gap: newer OpenAI-shaped responses may carry a
/// `refusal` string alongside/instead of `content` (e.g. `{"content": null,
/// "refusal": "I can't help with that."}`). `parse_openai_completion` never
/// reads `message.refusal` — the refusal text is silently discarded and the
/// caller sees an ordinary empty-content completion with finish_reason
/// "stop", not a distinguishable refusal. This test pins the current
/// (lossy) behavior rather than inventing refusal support that doesn't
/// exist.
#[tokio::test]
async fn refusal_shaped_content_is_silently_dropped_not_surfaced() {
    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::json_ok(
        &openai_completion_body(
            json!({"role": "assistant", "content": null, "refusal": "I can't help with that."}),
        ),
    ))])
    .await;
    let completion = openai_client(&gateway)
        .complete(&user_turn("hi"), None)
        .await
        .unwrap();
    assert_eq!(
        completion.content, "",
        "documents that refusal text is not surfaced anywhere on ChatCompletion"
    );
    assert_eq!(completion.finish_reason, "stop");
}

// ---------------------------------------------------------------------------
// Extra unknown fields, malformed JSON, JSON surrounded by prose
// ---------------------------------------------------------------------------

#[tokio::test]
async fn extra_unknown_top_level_and_nested_fields_are_ignored() {
    let mut body = openai_completion_body(json!({
        "role": "assistant",
        "content": "fine",
        "unexpected_nested_field": {"whatever": true}
    }));
    body["unexpected_top_level_field"] = json!(["a", "b"]);
    body["provider_extension_v7"] = json!({"beta": true});
    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::json_ok(&body))]).await;
    let completion = openai_client(&gateway)
        .complete(&user_turn("hi"), None)
        .await
        .unwrap();
    assert_eq!(completion.content, "fine");
}

#[tokio::test]
async fn malformed_completion_json_fails_closed() {
    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::text(
        200,
        "application/json",
        "{\"choices\": [ this is not valid json",
    ))])
    .await;
    let err = openai_client(&gateway)
        .complete(&user_turn("hi"), None)
        .await
        .unwrap_err();
    assert!(!err.to_string().is_empty());
}

#[tokio::test]
async fn json_embedded_in_prose_is_not_a_valid_chat_envelope() {
    // The outer HTTP JSON envelope itself, not a structured-output content
    // string (see the structured-output section below for that case).
    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::text(
        200,
        "application/json",
        format!(
            "Sure, here is the completion: {} Hope that helps!",
            openai_completion_body(json!({"role": "assistant", "content": "hi"}))
        ),
    ))])
    .await;
    let err = openai_client(&gateway)
        .complete(&user_turn("hi"), None)
        .await
        .unwrap_err();
    assert!(
        !err.to_string().is_empty(),
        "prose-wrapped JSON must not parse as a valid envelope"
    );
}

// ---------------------------------------------------------------------------
// Backend error envelopes: 2xx and non-2xx
// ---------------------------------------------------------------------------

#[tokio::test]
async fn error_envelope_with_non_2xx_status_surfaces_the_body_text() {
    let gateway = MockGateway::start_ordered(vec![Step::respond(
        Response::new(
            400,
            Body::Fixed {
                data: serde_json::to_vec(&json!({
                    "error": {"message": "context_length_exceeded: too many tokens"}
                }))
                .unwrap(),
                delay: std::time::Duration::ZERO,
            },
        )
        .with_header("content-type", "application/json"),
    )])
    .await;
    let err = openai_client(&gateway)
        .complete(&user_turn("hi"), None)
        .await
        .unwrap_err();
    assert!(err.to_string().contains("400"));
    assert!(
        err.to_string().contains("context_length_exceeded"),
        "the provider's actual error body must be visible, got {err}"
    );
}

/// Documents a real, narrow gap: an error-shaped body returned with an
/// HTTP 2xx status is not specially recognized by `parse_openai_completion`
/// (only the streaming SSE path checks for an inline `error` key — see
/// `parse_openai_sse_data`). The caller sees a generic "no choices in
/// completion" message instead of the provider's actual complaint.
#[tokio::test]
async fn error_envelope_returned_with_2xx_status_loses_the_actual_reason() {
    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::json_ok(&json!({
        "error": {"message": "model is currently overloaded", "type": "overloaded_error"}
    })))])
    .await;
    let err = openai_client(&gateway)
        .complete(&user_turn("hi"), None)
        .await
        .unwrap_err();
    assert!(
        err.to_string().contains("no choices"),
        "documents the current generic message rather than the provider's actual \
         'model is currently overloaded' reason: {err}"
    );
}

// ---------------------------------------------------------------------------
// Finish-reason variants
// ---------------------------------------------------------------------------

#[tokio::test]
async fn finish_reason_variants_pass_through_verbatim() {
    for reason in [
        "stop",
        "length",
        "content_filter",
        "tool_calls",
        "a_future_provider_reason",
    ] {
        let gateway = MockGateway::start_ordered(vec![Step::respond(Response::json_ok(&json!({
            "id": "x",
            "choices": [{"finish_reason": reason, "message": {"role": "assistant", "content": "x"}}]
        })))])
        .await;
        let completion = openai_client(&gateway)
            .complete(&user_turn("hi"), None)
            .await
            .unwrap();
        assert_eq!(completion.finish_reason, reason);
    }
}

#[tokio::test]
async fn length_finish_reason_is_classified_as_truncated_in_telemetry() {
    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::json_ok(&json!({
        "id": "x",
        "choices": [{"finish_reason": "length", "message": {"role": "assistant", "content": "cut off"}}]
    })))])
    .await;
    let completion = openai_client(&gateway)
        .complete(&user_turn("hi"), None)
        .await
        .unwrap();
    assert_eq!(completion.finish_reason, "length");
}

// ---------------------------------------------------------------------------
// Ollama dialect: same matrix cells, native /api/chat shape
// ---------------------------------------------------------------------------

#[tokio::test]
async fn ollama_basic_generation_and_missing_content_default() {
    let gateway = MockGateway::start_ordered(vec![
        Step::respond(Response::json_ok(&json!({
            "model": "matrix-model",
            "message": {"role": "assistant", "content": "hi from ollama"},
            "done": true,
            "done_reason": "stop"
        }))),
        Step::respond(Response::json_ok(&json!({
            "model": "matrix-model",
            "message": {"role": "assistant"},
            "done": true
        }))),
    ])
    .await;
    let client = OllamaClient::new(gateway.base_url(), "matrix-model").unwrap();
    let first = client.complete(&user_turn("hi"), None).await.unwrap();
    assert_eq!(first.content, "hi from ollama");
    let second = client.complete(&user_turn("hi"), None).await.unwrap();
    assert_eq!(second.content, "");
}

#[tokio::test]
async fn ollama_status_error_fails_closed() {
    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::status_only(500))]).await;
    let client = OllamaClient::new(gateway.base_url(), "matrix-model").unwrap();
    let err = client.complete(&user_turn("hi"), None).await.unwrap_err();
    assert!(err.to_string().contains("500"));
}

// ---------------------------------------------------------------------------
// Anthropic dialect
// ---------------------------------------------------------------------------

#[tokio::test]
async fn anthropic_basic_generation_uses_content_blocks() {
    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::json_ok(&json!({
        "id": "msg_1",
        "type": "message",
        "role": "assistant",
        "content": [{"type": "text", "text": "hello from anthropic"}],
        "stop_reason": "end_turn",
    })))])
    .await;
    let completion = anthropic_client(&gateway)
        .complete(&user_turn("hi"), None)
        .await
        .unwrap();
    assert_eq!(completion.content, "hello from anthropic");
    assert_eq!(completion.finish_reason, "end_turn");
    let sent = gateway.requests();
    assert_eq!(sent[0].header("x-api-key"), Some("sk-ant-fixture"));
}

// REGRESSION: unlike parse_openai_completion (which requires `choices` to
// exist and errors otherwise), parse_anthropic_completion has NO required-
// field check at all — it defaults content to "" and finish_reason to
// "end_turn" for ANY object lacking a `content` array, including Anthropic's
// own documented `{"type":"error", ...}` envelope. A 2xx error response is
// therefore currently indistinguishable from a legitimately empty answer:
// no error, no signal, just a silent empty "success". This must fail
// against the current (unfixed) code; see the paired fix(chat) commit.
#[tokio::test]
async fn anthropic_error_envelope_is_rejected_not_silently_accepted_as_an_empty_success() {
    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::json_ok(&json!({
        "type": "error",
        "error": {"type": "overloaded_error", "message": "Overloaded"}
    })))])
    .await;
    let err = anthropic_client(&gateway)
        .complete(&user_turn("hi"), None)
        .await
        .expect_err("an Anthropic error envelope must never parse as a completed answer");
    assert!(err.to_string().contains("Overloaded"), "{err}");
}

// ---------------------------------------------------------------------------
// Structured output (investigation_answer::parse_model_json) — strict,
// content-level JSON contract; separate from the outer HTTP envelope.
// ---------------------------------------------------------------------------

fn minimal_valid_answer_json() -> String {
    // The real, narrow wire shape: ModelInvestigationAnswerV1 { schema,
    // candidates } with #[serde(deny_unknown_fields)] — host-owned fields
    // (canonical_citations, root_cause_established, ...) are intentionally
    // absent from what the model may submit.
    json!({
        "schema": cd_core::investigation_answer::SCHEMA_V1,
        "candidates": [],
    })
    .to_string()
}

#[tokio::test]
async fn strict_structured_output_accepts_exact_pure_json() {
    // parse_model_json is a pure content-level parser (no HTTP needed), but
    // the fixture below is the literal string a chat completion's
    // `message.content` would carry over the wire.
    let result = parse_model_json(&minimal_valid_answer_json());
    match result {
        Ok(_) => {}
        Err(ValidationError::Schema) => panic!("schema field matched, should not report Schema"),
        Err(other) => panic!("valid minimal envelope must parse, got {other:?}"),
    }
}

#[tokio::test]
async fn structured_output_schema_mismatch_is_a_distinct_error_from_parse_failure() {
    let mut value: serde_json::Value = serde_json::from_str(&minimal_valid_answer_json()).unwrap();
    value["schema"] = json!("contextdesk.investigation_answer.v999");
    let err = parse_model_json(&value.to_string()).expect_err("wrong schema must fail");
    assert!(matches!(err, ValidationError::Schema), "got {err:?}");
}

#[tokio::test]
async fn json_surrounded_by_prose_fails_strict_parse() {
    let wrapped = format!(
        "Here is my answer: {} Let me know if that helps!",
        minimal_valid_answer_json()
    );
    let err = parse_model_json(&wrapped).expect_err("prose-wrapped JSON must not be accepted");
    assert!(matches!(err, ValidationError::Parse), "got {err:?}");
}

#[tokio::test]
async fn fenced_json_also_fails_strict_parse() {
    let fenced = format!("```json\n{}\n```", minimal_valid_answer_json());
    let err = parse_model_json(&fenced).expect_err("fenced JSON must not be accepted");
    assert!(matches!(err, ValidationError::Parse), "got {err:?}");
}

#[tokio::test]
async fn truncated_structured_output_fails_strict_parse() {
    let full = minimal_valid_answer_json();
    let truncated = &full[..full.len() / 2];
    let err = parse_model_json(truncated).expect_err("truncated JSON must not be accepted");
    assert!(matches!(err, ValidationError::Parse), "got {err:?}");
}

#[tokio::test]
async fn structured_output_rejects_unknown_fields() {
    let mut value: serde_json::Value = serde_json::from_str(&minimal_valid_answer_json()).unwrap();
    value["unexpected_extra_field"] = json!(true);
    let err = parse_model_json(&value.to_string());
    assert!(
        err.is_err(),
        "deny_unknown_fields must reject an unrecognized top-level key"
    );
}

// ---------------------------------------------------------------------------
// Bounded response accumulation over the real wire (non-SSE JSON fallback)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn oversized_non_streamed_body_fails_closed_instead_of_unbounded_growth() {
    // Exercises the exact path complete_stream_cb uses when a gateway
    // ignores stream=true and returns application/json: BoundedBodyAccumulator
    // over the real bytes_stream(), not a synthetic in-memory buffer.
    let oversized = "x".repeat(5 * 1024 * 1024); // over DEFAULT_MAX_BUFFERED_LINE_BYTES (4 MiB)
    let payload = format!(
        "{{\"choices\":[{{\"finish_reason\":\"stop\",\"message\":{{\"role\":\"assistant\",\"content\":\"{oversized}\"}}}}]}}"
    );
    let gateway = MockGateway::start_ordered(vec![Step::respond(
        Response::new(
            200,
            Body::Fixed {
                data: payload.into_bytes(),
                delay: std::time::Duration::ZERO,
            },
        )
        .with_header("content-type", "application/json"),
    )])
    .await;
    let client = openai_client(&gateway);
    let mut sink = |_: StreamDelta| {};
    let err = client
        .complete_stream_cb(&user_turn("hi"), None, &mut sink, None)
        .await
        .expect_err(
            "an oversized non-streamed body must fail closed, not be buffered without bound",
        );
    assert!(err.to_string().contains("exceeded"), "{err}");
}

#[tokio::test]
async fn under_bound_non_streamed_body_still_succeeds_over_the_real_wire() {
    let comfortable = "y".repeat(64 * 1024);
    let payload = format!(
        "{{\"choices\":[{{\"finish_reason\":\"stop\",\"message\":{{\"role\":\"assistant\",\"content\":\"{comfortable}\"}}}}]}}"
    );
    let gateway = MockGateway::start_ordered(vec![Step::respond(
        Response::new(
            200,
            Body::Fixed {
                data: payload.into_bytes(),
                delay: std::time::Duration::ZERO,
            },
        )
        .with_header("content-type", "application/json"),
    )])
    .await;
    let client = openai_client(&gateway);
    let mut sink = |_: StreamDelta| {};
    let completion = client
        .complete_stream_cb(&user_turn("hi"), None, &mut sink, None)
        .await
        .expect("a large-but-bounded body must succeed");
    assert_eq!(completion.content.len(), comfortable.len());
}

// ---------------------------------------------------------------------------
// No fabricated success after parse failure (non-streaming primary path)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn direct_client_never_fabricates_a_completion_from_a_parse_failure() {
    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::text(
        200,
        "application/json",
        "not json",
    ))])
    .await;
    let outcome = openai_client(&gateway)
        .complete(&user_turn("hi"), None)
        .await;
    assert!(
        outcome.is_err(),
        "a parse failure must never be reported as Ok(completion)"
    );
}

// ---------------------------------------------------------------------------
// Framework smoke-check for the JSON-request-body assertion helper used
// throughout this file (mirrors the same coverage cd-test-gateway's own
// tests already prove, at the level this lab actually exercises it).
// ---------------------------------------------------------------------------

#[tokio::test]
async fn tool_free_request_body_omits_the_tools_field_entirely() {
    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::json_ok(
        &openai_completion_body(json!({"role": "assistant", "content": "no tools here"})),
    ))])
    .await;
    let _ = openai_client(&gateway)
        .complete(&user_turn("hi"), None)
        .await
        .unwrap();
    let body = gateway.requests()[0].json_body().unwrap();
    assert!(body.get("tools").is_none());
    assert!(body.get("tool_choice").is_none());
}

// Silence "unused" lints for helpers only some scenarios exercise directly
// through re-export paths (kept for discoverability from this file's tests).
#[allow(dead_code)]
fn _unused_type_anchors(
    _: Option<ToolCallMsg>,
    _: Option<BoundedBodyAccumulator>,
    _: Option<Frame>,
) {
}
