//! Hermetic OpenAI chat contract v2: typed modes on the production client,
//! channel integrity, qualification ladder evidence, and mutation guards.
//!
//! No live providers, Keychain, or private network.

use cd_core::capability_qualification::{
    run_qualification, CapabilityKind, CapabilityStatus, ProfileCapabilityGate, QualificationKey,
    ScriptedQualificationTransport, SyntheticChatResponse, QUALIFICATION_SCHEMA_VERSION,
};
use cd_core::chat::{ChatMessage, OpenAiCompatibleClient, Role};
use cd_core::openai_chat_contract::{
    build_openai_chat_request_body, extract_openai_message_channels,
    parse_structured_json_from_content, OpenAiChatRequestMode, OpenAiMessageChannels,
    MODE_JSON_OBJECT, MODE_PLAIN, MODE_PROMPTED_JSON,
};
use cd_core::ssrf::SsrfPolicy;
use cd_core::tools::{ToolSideEffect, ToolSpec};
use cd_test_gateway::{MockGateway, Response, Step};
use serde_json::json;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

fn user(text: &str) -> ChatMessage {
    ChatMessage {
        role: Role::User,
        content: text.into(),
        tool_call_id: None,
        tool_calls: None,
    }
}

fn inert_tool() -> ToolSpec {
    ToolSpec {
        name: "cd_qualify_echo".into(),
        description: "inert".into(),
        side_effect: ToolSideEffect::Read,
        parameters: json!({"type": "object", "properties": {}}),
    }
}

#[test]
fn schema_version_is_v5() {
    assert_eq!(
        QUALIFICATION_SCHEMA_VERSION,
        "contextdesk.capability_qualification.v5"
    );
}

#[test]
fn parse_completion_does_not_leak_reasoning_into_content() {
    let fixture = r#"{
      "choices": [{
        "finish_reason": "stop",
        "message": {
          "role": "assistant",
          "content": "",
          "reasoning_content": "{\"qualify\":\"ok\",\"v\":1}"
        }
      }]
    }"#;
    let c = cd_core::chat::parse_openai_completion(fixture).unwrap();
    assert!(
        c.content.is_empty(),
        "reasoning must not leak into content channel"
    );
    assert!(!c.content.contains("qualify"));
}

#[test]
fn parse_completion_keeps_content_when_reasoning_also_present() {
    let fixture = r#"{
      "choices": [{
        "finish_reason": "stop",
        "message": {
          "role": "assistant",
          "content": "{\"qualify\":\"ok\",\"v\":1}",
          "reasoning_content": "thinking about JSON"
        }
      }]
    }"#;
    let c = cd_core::chat::parse_openai_completion(fixture).unwrap();
    assert!(c.content.contains("qualify"));
    assert!(!c.content.contains("thinking"));
    let msg = serde_json::from_str::<serde_json::Value>(fixture).unwrap()["choices"][0]["message"]
        .clone();
    let ch = extract_openai_message_channels(&msg);
    assert!(ch.reasoning_content.contains("thinking"));
    let v = parse_structured_json_from_content(&ch).unwrap();
    assert_eq!(v["qualify"], "ok");
}

/// Mode-aware OpenAI-compatible transport for the full v3 ladder.
struct ModeRecordingTransport {
    modes: Vec<&'static str>,
}

impl cd_core::capability_qualification::QualificationTransport for ModeRecordingTransport {
    fn chat_complete(
        &mut self,
        req: &cd_core::capability_qualification::SyntheticChatRequest,
        cancel: &AtomicBool,
    ) -> Result<SyntheticChatResponse, cd_core::capability_qualification::TransportError> {
        self.modes.push(req.chat_mode.evidence_id());
        let dialect = Some("openai_compatible".into());
        if cancel.load(std::sync::atomic::Ordering::SeqCst) {
            return Ok(SyntheticChatResponse {
                cancelled: true,
                streamed: req.stream,
                dialect,
                mode_transmitted: false,
                ..Default::default()
            });
        }
        let ok_json = || SyntheticChatResponse {
            content: r#"{"qualify":"ok","v":1}"#.into(),
            dialect: Some("openai_compatible".into()),
            mode_transmitted: true,
            ..Default::default()
        };
        let tool = || cd_core::capability_qualification::SyntheticToolCall {
            id: "c1".into(),
            name: cd_core::capability_qualification::INERT_PROBE_TOOL_NAME.into(),
            arguments_json: r#"{"token":"QUALIFY_TOOL_V1"}"#.into(),
        };
        match &req.chat_mode {
            OpenAiChatRequestMode::PromptedJson
            | OpenAiChatRequestMode::JsonObject
            | OpenAiChatRequestMode::JsonSchema { .. } => Ok(ok_json()),
            OpenAiChatRequestMode::ForcedTool { .. } => Ok(SyntheticChatResponse {
                tool_calls: vec![tool()],
                dialect: Some("openai_compatible".into()),
                mode_transmitted: true,
                ..Default::default()
            }),
            OpenAiChatRequestMode::Plain if req.tools.is_empty() && req.stream => {
                Ok(SyntheticChatResponse {
                    content: "QUALIFY_OK_V1".into(),
                    streamed: true,
                    dialect: Some("openai_compatible".into()),
                    mode_transmitted: true,
                    ..Default::default()
                })
            }
            OpenAiChatRequestMode::Plain if !req.tools.is_empty() && req.messages.len() == 1 => {
                Ok(SyntheticChatResponse {
                    tool_calls: vec![tool()],
                    dialect: Some("openai_compatible".into()),
                    mode_transmitted: true,
                    ..Default::default()
                })
            }
            OpenAiChatRequestMode::Plain => Ok(SyntheticChatResponse {
                content: "QUALIFY_OK_V1".into(),
                streamed: req.stream,
                dialect: Some("openai_compatible".into()),
                mode_transmitted: true,
                ..Default::default()
            }),
        }
    }

    fn embed(
        &mut self,
        _model_id: &str,
        _text: &str,
        _cancel: &AtomicBool,
    ) -> Result<
        cd_core::capability_qualification::SyntheticEmbeddingResponse,
        cd_core::capability_qualification::TransportError,
    > {
        Err(cd_core::capability_qualification::TransportError {
            reason: "not_used".into(),
        })
    }

    fn rerank(
        &mut self,
        _model_id: &str,
        _query: &str,
        _document_ids: &[&str],
        _cancel: &AtomicBool,
    ) -> Result<
        cd_core::capability_qualification::SyntheticRerankResponse,
        cd_core::capability_qualification::TransportError,
    > {
        Err(cd_core::capability_qualification::TransportError {
            reason: "not_used".into(),
        })
    }
}

#[test]
fn structured_ladder_records_prompted_and_native_modes() {
    let mut transport = ModeRecordingTransport { modes: vec![] };
    let key = QualificationKey::new("p", "https://gw.example/v1", "model-x");
    let cancel = Arc::new(AtomicBool::new(false));
    let report = run_qualification(
        key,
        ProfileCapabilityGate {
            tools_enabled: true,
            stream_enabled: true,
            embeddings_enabled: false,
        },
        &mut transport,
        &cancel,
    );

    let prompted = report
        .checks
        .iter()
        .find(|c| c.kind == CapabilityKind::StructuredOutput)
        .expect("prompted structured check");
    assert_eq!(
        prompted.status,
        CapabilityStatus::Pass,
        "{}",
        prompted.reason
    );
    assert_eq!(prompted.request_mode.as_deref(), Some(MODE_PROMPTED_JSON));

    let native = report
        .checks
        .iter()
        .find(|c| c.kind == CapabilityKind::StructuredJsonObject)
        .expect("native structured check");
    assert_eq!(native.status, CapabilityStatus::Pass, "{}", native.reason);
    assert_eq!(native.request_mode.as_deref(), Some(MODE_JSON_OBJECT));
    assert!(
        transport.modes.contains(&MODE_PROMPTED_JSON)
            && transport.modes.contains(&MODE_JSON_OBJECT),
        "modes: {:?}",
        transport.modes
    );
    assert_eq!(report.key.schema_version, QUALIFICATION_SCHEMA_VERSION);
}

#[test]
fn native_json_object_fails_closed_without_mid_turn_downgrade() {
    // Mode-aware: JsonObject returns bad content; no silent plain retry.
    struct FailNativeJson;
    impl cd_core::capability_qualification::QualificationTransport for FailNativeJson {
        fn chat_complete(
            &mut self,
            req: &cd_core::capability_qualification::SyntheticChatRequest,
            cancel: &AtomicBool,
        ) -> Result<SyntheticChatResponse, cd_core::capability_qualification::TransportError>
        {
            if cancel.load(std::sync::atomic::Ordering::SeqCst) {
                return Ok(SyntheticChatResponse {
                    cancelled: true,
                    mode_transmitted: true,
                    dialect: Some("openai_compatible".into()),
                    ..Default::default()
                });
            }
            if matches!(req.chat_mode, OpenAiChatRequestMode::JsonObject) {
                return Ok(SyntheticChatResponse {
                    content: "I cannot emit JSON".into(),
                    mode_transmitted: true,
                    dialect: Some("openai_compatible".into()),
                    ..Default::default()
                });
            }
            // Other modes succeed so the ladder reaches native json_object.
            Ok(SyntheticChatResponse {
                content: if matches!(
                    req.chat_mode,
                    OpenAiChatRequestMode::PromptedJson | OpenAiChatRequestMode::JsonSchema { .. }
                ) {
                    r#"{"qualify":"ok","v":1}"#.into()
                } else if !req.tools.is_empty() && req.messages.len() == 1 {
                    String::new()
                } else {
                    "QUALIFY_OK_V1".into()
                },
                tool_calls: if !req.tools.is_empty() && req.messages.len() == 1 {
                    vec![cd_core::capability_qualification::SyntheticToolCall {
                        id: "c1".into(),
                        name: cd_core::capability_qualification::INERT_PROBE_TOOL_NAME.into(),
                        arguments_json: r#"{"token":"QUALIFY_TOOL_V1"}"#.into(),
                    }]
                } else {
                    vec![]
                },
                streamed: req.stream,
                mode_transmitted: true,
                dialect: Some("openai_compatible".into()),
                ..Default::default()
            })
        }
        fn embed(
            &mut self,
            _: &str,
            _: &str,
            _: &AtomicBool,
        ) -> Result<
            cd_core::capability_qualification::SyntheticEmbeddingResponse,
            cd_core::capability_qualification::TransportError,
        > {
            Err(cd_core::capability_qualification::TransportError {
                reason: "n/a".into(),
            })
        }
        fn rerank(
            &mut self,
            _: &str,
            _: &str,
            _: &[&str],
            _: &AtomicBool,
        ) -> Result<
            cd_core::capability_qualification::SyntheticRerankResponse,
            cd_core::capability_qualification::TransportError,
        > {
            Err(cd_core::capability_qualification::TransportError {
                reason: "n/a".into(),
            })
        }
    }

    let mut transport = FailNativeJson;
    let report = run_qualification(
        QualificationKey::new("p", "https://gw.example/v1", "model-y"),
        ProfileCapabilityGate {
            tools_enabled: true,
            stream_enabled: true,
            embeddings_enabled: false,
        },
        &mut transport,
        &Arc::new(AtomicBool::new(false)),
    );

    let structured = report
        .checks
        .iter()
        .find(|c| c.kind == CapabilityKind::StructuredJsonObject)
        .unwrap();
    assert_eq!(structured.status, CapabilityStatus::Fail);
    assert_eq!(structured.request_mode.as_deref(), Some(MODE_JSON_OBJECT));
    assert!(
        structured.reason.contains("mode=json_object"),
        "fail reason must retain measured mode (no silent plain downgrade): {}",
        structured.reason
    );
}

#[test]
fn name_hint_never_alone_passes_structured() {
    // Empty transport: all probes fail/exhaust — readiness must not pass from name.
    let mut transport = ScriptedQualificationTransport::default();
    let key = QualificationKey::new("p", "https://gw.example/v1", "gpt-4o-json-mode");
    let cancel = Arc::new(AtomicBool::new(false));
    let report = run_qualification(
        key,
        ProfileCapabilityGate {
            tools_enabled: true,
            stream_enabled: true,
            embeddings_enabled: false,
        },
        &mut transport,
        &cancel,
    );
    let structured = report
        .checks
        .iter()
        .find(|c| c.kind == CapabilityKind::StructuredOutput)
        .unwrap();
    assert_ne!(
        structured.status,
        CapabilityStatus::Pass,
        "model name must never alone produce structured pass"
    );
}

#[test]
fn v1_through_v4_schema_keys_are_stale_vs_v5() {
    let v5 = QualificationKey::new("p", "https://gw.example/v1", "m");
    assert_eq!(v5.schema_version, "contextdesk.capability_qualification.v5");
    for prior in ["v1", "v2", "v3", "v4"] {
        let mut old = v5.clone();
        old.schema_version = format!("contextdesk.capability_qualification.{prior}");
        assert_ne!(old.storage_id(), v5.storage_id());
        assert_ne!(old, v5);
    }
    // Same profile/base/model under different protocol is a different key.
    let ollama = QualificationKey::with_protocol(
        "p",
        "https://gw.example/v1",
        "m",
        cd_core::openai_chat_contract::ChatBackendDialect::Ollama,
    );
    assert_ne!(ollama.storage_id(), v5.storage_id());
}

#[test]
fn reasoning_only_channels_reject_structured_parse() {
    let ch = OpenAiMessageChannels {
        content: String::new(),
        reasoning_content: r#"{"qualify":"ok","v":1}"#.into(),
    };
    assert!(parse_structured_json_from_content(&ch).is_err());
}

#[test]
fn body_builder_modes_are_mutually_distinct() {
    let msgs = [user("hi")];
    let tools = [inert_tool()];
    let plain = build_openai_chat_request_body(
        "m",
        &msgs,
        Some(&tools),
        false,
        &OpenAiChatRequestMode::Plain,
    );
    let json_obj =
        build_openai_chat_request_body("m", &msgs, None, false, &OpenAiChatRequestMode::JsonObject);
    let forced = build_openai_chat_request_body(
        "m",
        &msgs,
        Some(&tools),
        false,
        &OpenAiChatRequestMode::ForcedTool {
            name: "cd_qualify_echo".into(),
        },
    );
    assert_eq!(plain["tool_choice"], "auto");
    assert!(plain.get("response_format").is_none());
    assert_eq!(json_obj["response_format"]["type"], "json_object");
    assert_eq!(forced["tool_choice"]["function"]["name"], "cd_qualify_echo");
    assert_eq!(OpenAiChatRequestMode::Plain.evidence_id(), MODE_PLAIN);
}

/// Mutation guard: if production again discarded chat_mode / response_format,
/// this body-shape assertion fails.
#[test]
fn mutation_guard_json_object_body_requires_response_format() {
    let body = build_openai_chat_request_body(
        "matrix-model",
        &[user("probe")],
        None,
        false,
        &OpenAiChatRequestMode::JsonObject,
    );
    let raw = serde_json::to_string(&body).unwrap();
    assert!(
        raw.contains("response_format") && raw.contains("json_object"),
        "production body builder must emit response_format for JsonObject mode"
    );
}

#[tokio::test]
async fn live_client_emits_response_format_on_wire() {
    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::json_ok(&json!({
        "choices": [{
            "finish_reason": "stop",
            "message": {
                "role": "assistant",
                "content": "{\"qualify\":\"ok\",\"v\":1}"
            }
        }]
    })))])
    .await;

    let client = OpenAiCompatibleClient::new(
        gateway.base_url(),
        None,
        "matrix-model",
        &SsrfPolicy::default(),
    )
    .expect("client");

    let completion = client
        .complete_with_mode(
            &[user(r#"Reply JSON {"qualify":"ok","v":1}"#)],
            None,
            &OpenAiChatRequestMode::JsonObject,
        )
        .await
        .expect("complete");

    assert!(completion.content.contains("qualify"));
    assert_eq!(gateway.request_count(), 1);
    let sent = gateway.requests();
    let body: serde_json::Value = serde_json::from_slice(&sent[0].body).expect("json body");
    assert_eq!(
        body["response_format"]["type"], "json_object",
        "wire body must carry response_format; got {}",
        body
    );
    assert_eq!(body["stream"], false);
}

#[tokio::test]
async fn live_client_emits_forced_tool_choice_on_wire() {
    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::json_ok(&json!({
        "choices": [{
            "finish_reason": "tool_calls",
            "message": {
                "role": "assistant",
                "content": null,
                "tool_calls": [{
                    "id": "call_1",
                    "type": "function",
                    "function": {
                        "name": "cd_qualify_echo",
                        "arguments": "{\"token\":\"QUALIFY_TOOL_V1\"}"
                    }
                }]
            }
        }]
    })))])
    .await;

    let client = OpenAiCompatibleClient::new(
        gateway.base_url(),
        None,
        "matrix-model",
        &SsrfPolicy::default(),
    )
    .expect("client");

    let tools = [inert_tool()];
    let completion = client
        .complete_with_mode(
            &[user("call the tool")],
            Some(&tools),
            &OpenAiChatRequestMode::ForcedTool {
                name: "cd_qualify_echo".into(),
            },
        )
        .await
        .expect("complete");

    assert_eq!(completion.tool_calls.len(), 1);
    assert_eq!(gateway.request_count(), 1);
    let sent = gateway.requests();
    let body: serde_json::Value = serde_json::from_slice(&sent[0].body).expect("json body");
    assert_eq!(body["tool_choice"]["type"], "function");
    assert_eq!(body["tool_choice"]["function"]["name"], "cd_qualify_echo");
    assert!(body.get("response_format").is_none());
}

#[tokio::test]
async fn typed_client_rejects_forced_tool_without_tools_before_http() {
    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::json_ok(&json!({
        "choices": [{"finish_reason": "stop", "message": {"role": "assistant", "content": "x"}}]
    })))])
    .await;
    let client = OpenAiCompatibleClient::new(
        gateway.base_url(),
        None,
        "matrix-model",
        &SsrfPolicy::default(),
    )
    .expect("client");
    let err = client
        .complete_with_mode(
            &[user("call")],
            None,
            &OpenAiChatRequestMode::ForcedTool {
                name: "cd_qualify_echo".into(),
            },
        )
        .await
        .expect_err("must fail before send");
    assert!(
        err.to_string().contains("invalid_request_mode")
            && err.to_string().contains("forced_tool_missing_tools"),
        "{err}"
    );
    assert_eq!(gateway.request_count(), 0, "must not contact provider");
}

#[tokio::test]
async fn typed_client_rejects_forced_tool_mismatched_name_before_http() {
    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::json_ok(&json!({
        "choices": [{"finish_reason": "stop", "message": {"role": "assistant", "content": "x"}}]
    })))])
    .await;
    let client = OpenAiCompatibleClient::new(
        gateway.base_url(),
        None,
        "matrix-model",
        &SsrfPolicy::default(),
    )
    .expect("client");
    let tools = [inert_tool()];
    let err = client
        .complete_with_mode(
            &[user("call")],
            Some(&tools),
            &OpenAiChatRequestMode::ForcedTool {
                name: "some_other_tool".into(),
            },
        )
        .await
        .expect_err("must fail before send");
    assert!(
        err.to_string().contains("invalid_request_mode")
            && err.to_string().contains("forced_tool_mismatched_name"),
        "{err}"
    );
    assert_eq!(gateway.request_count(), 0, "must not contact provider");
}

#[tokio::test]
async fn stream_json_object_rejects_invalid_content_without_silent_accept() {
    // Stream returns non-JSON content for json_object mode — must fail closed.
    let sse = concat!(
        "data: {\"choices\":[{\"delta\":{\"content\":\"not-json\"},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
        "data: [DONE]\n\n"
    );
    let gateway =
        MockGateway::start_ordered(vec![Step::respond(Response::sse_ok(sse.as_bytes()))]).await;
    let client = OpenAiCompatibleClient::new(
        gateway.base_url(),
        None,
        "matrix-model",
        &SsrfPolicy::default(),
    )
    .expect("client");
    let err = client
        .complete_stream_with_mode(
            &[user("json please")],
            None,
            &OpenAiChatRequestMode::JsonObject,
        )
        .await
        .expect_err("invalid stream JSON must not be accepted");
    assert!(
        err.to_string().contains("invalid_response_for_mode"),
        "got {err}"
    );
    assert_eq!(gateway.request_count(), 1);
}

#[tokio::test]
async fn typed_client_rejects_malformed_schema_before_http() {
    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::json_ok(&json!({
        "choices": [{"finish_reason": "stop", "message": {"role": "assistant", "content": "{}"}}]
    })))])
    .await;
    let client = OpenAiCompatibleClient::new(
        gateway.base_url(),
        None,
        "matrix-model",
        &SsrfPolicy::default(),
    )
    .expect("client");
    let err = client
        .complete_with_mode(
            &[user("json")],
            None,
            &OpenAiChatRequestMode::JsonSchema {
                name: "".into(),
                schema: json!("not-an-object"),
                strict: true,
            },
        )
        .await
        .expect_err("must fail before send");
    assert!(err.to_string().contains("invalid_request_mode"), "{err}");
    assert_eq!(gateway.request_count(), 0);
}

#[tokio::test]
async fn gateway_reject_json_object_is_not_silently_downgraded() {
    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::json(
        400,
        &json!({
            "error": {
                "message": "response_format json_object is not supported",
                "type": "invalid_request_error"
            }
        }),
    ))])
    .await;

    let client = OpenAiCompatibleClient::new(
        gateway.base_url(),
        None,
        "matrix-model",
        &SsrfPolicy::default(),
    )
    .expect("client");

    let err = client
        .complete_with_mode(
            &[user("json please")],
            None,
            &OpenAiChatRequestMode::JsonObject,
        )
        .await
        .expect_err("must surface rejection");

    let msg = err.to_string();
    assert!(
        msg.contains("400") || msg.contains("chat"),
        "error should retain provider status: {msg}"
    );
    // Exactly one attempt — no silent plain retry.
    assert_eq!(
        gateway.request_count(),
        1,
        "must not retry as plain after response_format rejection"
    );
    let body: serde_json::Value =
        serde_json::from_slice(&gateway.requests()[0].body).expect("json");
    assert_eq!(body["response_format"]["type"], "json_object");
}

#[tokio::test]
async fn stream_with_mode_emits_response_format() {
    let sse = concat!(
        "data: {\"choices\":[{\"delta\":{\"content\":\"{\\\"q\\\":1}\"},\"finish_reason\":null}]}\n\n",
        "data: [DONE]\n\n"
    );
    let gateway =
        MockGateway::start_ordered(vec![Step::respond(Response::sse_ok(sse.as_bytes()))]).await;

    let client = OpenAiCompatibleClient::new(
        gateway.base_url(),
        None,
        "matrix-model",
        &SsrfPolicy::default(),
    )
    .expect("client");

    let _ = client
        .complete_stream_with_mode(
            &[user("stream json")],
            None,
            &OpenAiChatRequestMode::JsonObject,
        )
        .await
        .expect("stream");

    let body: serde_json::Value =
        serde_json::from_slice(&gateway.requests()[0].body).expect("json");
    assert_eq!(body["stream"], true);
    assert_eq!(body["response_format"]["type"], "json_object");
}
