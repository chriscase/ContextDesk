//! Gateway wire conformance lab — Phase 6 (qualification half): proves
//! `LiveQualificationTransport` — the real, HTTP-connected implementation
//! of `cd_core::capability_qualification::QualificationTransport` — cannot
//! be talked into passing native-tool-call support merely because a model
//! narrates the probe tool's name in ordinary prose instead of emitting a
//! real `tool_calls` array.
//!
//! Lives in `cd-workflow` (not `cd-core`) because `LiveQualificationTransport`
//! is defined here; `cd-core` cannot depend back on `cd-workflow`.
//!
//! # Why plain `#[test]`, not `#[tokio::test]`
//!
//! `run_qualification` is a synchronous function; `LiveQualificationTransport`
//! bridges to async HTTP internally via `tokio::task::block_in_place` when it
//! finds an ambient runtime handle. `block_in_place` panics unless that
//! ambient runtime is multi-threaded — and `#[tokio::test]` defaults to a
//! single-threaded runtime. Driving these tests from a plain `#[test]`
//! (mirroring `cd_core::rerank`'s own `rerank_blocking_times_out_to_none`
//! test, which hits the analogous constraint) means there is no ambient
//! runtime handle at all, so `LiveQualificationTransport` takes its other,
//! safe branch and builds its own fresh current-thread runtime for the HTTP
//! call. The mock gateway's accept loop lives on a separately, explicitly
//! created runtime — real loopback TCP does not care which in-process async
//! runtime issued the connect(), so this is safe.

use cd_core::capability_qualification::{
    run_qualification, CapabilityKind, CapabilityStatus, ProfileCapabilityGate, QualificationKey,
    QualificationTransport, SyntheticChatRequest, SyntheticMessage,
};
use cd_core::openai_chat_contract::OpenAiChatRequestMode;
use cd_test_gateway::{MockGateway, Response, Step};
use cd_workflow::capability_qualification::{
    qualification_key, LiveBackendKind, LiveQualificationTransport,
};
use serde_json::json;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

fn completion_with_tool_calls(calls: serde_json::Value) -> serde_json::Value {
    json!({
        "id": "chatcmpl-tools",
        "choices": [{
            "finish_reason": "tool_calls",
            "message": {"role": "assistant", "content": null, "tool_calls": calls}
        }]
    })
}

#[test]
fn live_transport_exposes_authoritative_model_usage_and_cost_once() {
    let rt = tokio::runtime::Runtime::new().expect("gateway runtime");
    let gateway = rt.block_on(MockGateway::start_ordered(vec![Step::respond(
        Response::json_ok(&json!({
            "id": "chatcmpl-telemetry",
            "model": "reported/model-b",
            "choices": [{
                "finish_reason": "stop",
                "message": {"role": "assistant", "content": "{}"}
            }],
            "usage": {
                "prompt_tokens": 11,
                "completion_tokens": 7,
                "total_tokens": 18,
                "completion_tokens_details": {"reasoning_tokens": 3},
                "prompt_tokens_details": {"cached_tokens": 5},
                "cost": 0.000321
            }
        })),
    )]));
    let mut transport = LiveQualificationTransport::new(
        LiveBackendKind::OpenAiCompatible,
        format!("{}/v1", gateway.base_url()),
        None,
        true,
    );
    let request = SyntheticChatRequest {
        model_id: "configured/model-a".into(),
        messages: vec![SyntheticMessage {
            role: "user".into(),
            content: "return json".into(),
            tool_call_id: None,
            tool_calls: Vec::new(),
        }],
        tools: Vec::new(),
        stream: false,
        chat_mode: OpenAiChatRequestMode::PromptedJson,
    };
    transport
        .chat_complete(&request, &AtomicBool::new(false))
        .expect("completion");
    let telemetry = transport
        .take_last_chat_provider_telemetry()
        .expect("wire telemetry");
    assert_eq!(
        telemetry.response_model.as_deref(),
        Some("reported/model-b")
    );
    assert_eq!(telemetry.prompt_tokens, Some(11));
    assert_eq!(telemetry.completion_tokens, Some(7));
    assert_eq!(telemetry.reasoning_tokens, Some(3));
    assert_eq!(telemetry.cached_tokens, Some(5));
    assert_eq!(telemetry.cost, Some(0.000321));
    assert!(transport.take_last_chat_provider_telemetry().is_none());
}

#[test]
fn qualification_native_tool_call_fails_on_tool_shaped_prose_alone() {
    let rt = tokio::runtime::Runtime::new().expect("gateway runtime");
    // The model narrates using the exact probe tool name in plain content
    // text, with an EMPTY tool_calls array — never a real native call.
    let gateway = rt.block_on(MockGateway::start_ordered(vec![Step::respond(
        Response::json_ok(&json!({
            "id": "x",
            "choices": [{
                "finish_reason": "stop",
                "message": {
                    "role": "assistant",
                    "content": "I would call cd_qualify_echo with token=probe_ok now.",
                    "tool_calls": []
                }
            }]
        })),
    )]));
    let mut transport = LiveQualificationTransport::new(
        LiveBackendKind::OpenAiCompatible,
        format!("{}/v1", gateway.base_url()),
        None,
        true,
    );
    let key = qualification_key("qual-profile", gateway.base_url(), "matrix-model");
    let gate = ProfileCapabilityGate {
        tools_enabled: true,
        stream_enabled: false,
        embeddings_enabled: false,
    };
    let cancel = Arc::new(AtomicBool::new(false));
    let report = run_qualification(
        QualificationKey::new(&key.profile_id, gateway.base_url(), "matrix-model"),
        gate,
        &mut transport,
        &cancel,
    );
    assert_eq!(
        report.status_of(CapabilityKind::NativeToolCall),
        CapabilityStatus::Fail,
        "tool-shaped prose with an empty tool_calls array must never qualify as a pass"
    );
    // run_qualification's default (Investigator/Unknown role hint) suite
    // exercises several probes beyond NativeToolCall (BasicGeneration,
    // ToolResultContinuation, StructuredOutput, ...), each issuing its own
    // chat completion against this same scripted response — so more than
    // one request is expected; the point proven here is that real wire
    // activity occurred, not an exact round count (that belongs to the
    // Phase 6 tool-continuation round-accounting tests).
    assert!(
        gateway.request_count() >= 1,
        "the probe suite must have made real HTTP calls"
    );
}

#[test]
fn qualification_native_tool_call_passes_on_a_real_tool_call() {
    let rt = tokio::runtime::Runtime::new().expect("gateway runtime");
    let gateway = rt.block_on(MockGateway::start_ordered(vec![Step::respond(
        Response::json_ok(&completion_with_tool_calls(json!([{
            "id": "call_probe",
            "type": "function",
            "function": {"name": "cd_qualify_echo", "arguments": "{\"token\":\"QUALIFY_TOOL_V1\"}"}
        }]))),
    )]));
    let mut transport = LiveQualificationTransport::new(
        LiveBackendKind::OpenAiCompatible,
        format!("{}/v1", gateway.base_url()),
        None,
        true,
    );
    let gate = ProfileCapabilityGate {
        tools_enabled: true,
        stream_enabled: false,
        embeddings_enabled: false,
    };
    let cancel = Arc::new(AtomicBool::new(false));
    let report = run_qualification(
        QualificationKey::new("qual-profile", gateway.base_url(), "matrix-model"),
        gate,
        &mut transport,
        &cancel,
    );
    assert_eq!(
        report.status_of(CapabilityKind::NativeToolCall),
        CapabilityStatus::Pass
    );
}

/// Prompted structured output uses plain chat; native json_object emits
/// `response_format` on the OpenAI-compatible wire (chat contract v3).
#[test]
fn qualification_native_json_object_emits_response_format_on_wire() {
    let rt = tokio::runtime::Runtime::new().expect("gateway runtime");
    let gateway = rt.block_on(MockGateway::start_ordered(vec![Step::respond(
        Response::json_ok(&json!({
            "id": "chatcmpl-json",
            "choices": [{
                "finish_reason": "stop",
                "message": {
                    "role": "assistant",
                    "content": "{\"qualify\":\"ok\",\"v\":1}"
                }
            }]
        })),
    )]));
    let mut transport = LiveQualificationTransport::new(
        LiveBackendKind::OpenAiCompatible,
        format!("{}/v1", gateway.base_url()),
        None,
        true,
    );
    let gate = ProfileCapabilityGate {
        tools_enabled: false,
        stream_enabled: false,
        embeddings_enabled: false,
    };
    let cancel = Arc::new(AtomicBool::new(false));
    let report = run_qualification(
        QualificationKey::new("qual-profile", gateway.base_url(), "matrix-model"),
        gate,
        &mut transport,
        &cancel,
    );
    // Prompted JSON (production reviewer path) does not require response_format.
    assert_eq!(
        report.status_of(CapabilityKind::StructuredOutput),
        CapabilityStatus::Pass
    );
    let prompted = report
        .checks
        .iter()
        .find(|c| c.kind == CapabilityKind::StructuredOutput)
        .expect("prompted structured check");
    assert_eq!(prompted.request_mode.as_deref(), Some("prompted_json"));
    assert_eq!(prompted.dialect.as_deref(), Some("openai_compatible"));

    // Native json_object is a separate measurement.
    assert_eq!(
        report.status_of(CapabilityKind::StructuredJsonObject),
        CapabilityStatus::Pass
    );
    let native = report
        .checks
        .iter()
        .find(|c| c.kind == CapabilityKind::StructuredJsonObject)
        .expect("native structured check");
    assert_eq!(native.request_mode.as_deref(), Some("json_object"));

    let bodies: Vec<serde_json::Value> = gateway
        .requests()
        .iter()
        .filter_map(|r| serde_json::from_slice(&r.body).ok())
        .collect();
    assert!(
        bodies
            .iter()
            .any(|b| b["response_format"]["type"] == "json_object"),
        "native json_object probe must emit response_format; bodies={bodies:?}"
    );
    // At least one body must be plain (prompted) without response_format.
    assert!(
        bodies
            .iter()
            .any(|b| b.get("response_format").is_none() && b.get("stream") == Some(&json!(false))),
        "prompted JSON must not invent response_format; bodies={bodies:?}"
    );
}

/// Ollama live transport must refuse OpenAI-native modes before inventing a pass.
#[test]
fn qualification_ollama_refuses_openai_native_json_object() {
    let rt = tokio::runtime::Runtime::new().expect("gateway runtime");
    // Ollama path uses /api/chat; serve a success body so plain probes work.
    let gateway = rt.block_on(MockGateway::start_ordered(vec![Step::respond(
        Response::json_ok(&json!({
            "message": {"role": "assistant", "content": "QUALIFY_OK_V1"}
        })),
    )]));
    let mut transport =
        LiveQualificationTransport::new(LiveBackendKind::Ollama, gateway.base_url(), None, true);
    let gate = ProfileCapabilityGate {
        tools_enabled: false,
        stream_enabled: false,
        embeddings_enabled: false,
    };
    let cancel = Arc::new(AtomicBool::new(false));
    let report = run_qualification(
        QualificationKey::with_protocol(
            "ollama-profile",
            gateway.base_url(),
            "llama3",
            cd_core::openai_chat_contract::ChatBackendDialect::Ollama,
        ),
        gate,
        &mut transport,
        &cancel,
    );
    let native = report
        .checks
        .iter()
        .find(|c| c.kind == CapabilityKind::StructuredJsonObject)
        .expect("native check row");
    assert_eq!(native.status, CapabilityStatus::Fail);
    assert!(
        native.reason.contains("unsupported_request_mode") && native.reason.contains("ollama"),
        "ollama must refuse openai-native mode: {}",
        native.reason
    );
    // No request may have been made with response_format (Ollama never got it).
    let bodies: Vec<String> = gateway
        .requests()
        .iter()
        .map(|r| String::from_utf8_lossy(&r.body).into_owned())
        .collect();
    assert!(
        bodies.iter().all(|b| !b.contains("response_format")),
        "ollama must never receive OpenAI response_format: {bodies:?}"
    );
    assert_eq!(
        native.dialect.as_deref(),
        Some("ollama"),
        "typed dialect field must be set on refuse, not only reason text"
    );
    // Schema and forced-tool native modes also fail closed (not Pass).
    for kind in [
        CapabilityKind::StructuredJsonSchema,
        CapabilityKind::StructuredJsonSchemaStrict,
        CapabilityKind::ForcedToolCall,
    ] {
        let row = report.checks.iter().find(|c| c.kind == kind);
        if let Some(row) = row {
            assert_ne!(row.status, CapabilityStatus::Pass, "{kind:?}");
            if row.reason.contains("unsupported_request_mode") {
                assert_eq!(row.dialect.as_deref(), Some("ollama"));
            }
        }
    }
}

/// Anthropic live transport must refuse OpenAI-native modes before inventing a
/// pass. Deleting refuse_unsupported_mode from chat_anthropic alone must fail.
#[test]
fn qualification_anthropic_refuses_openai_native_modes() {
    let rt = tokio::runtime::Runtime::new().expect("gateway runtime");
    // Anthropic path posts to /v1/messages when it actually transmits. Refuse
    // happens before HTTP for OpenAI-native modes; still mount a safe response
    // for any plain/prompted probes that do contact the mock.
    let gateway = rt.block_on(MockGateway::start_ordered(vec![Step::respond(
        Response::json_ok(&json!({
            "content": [{"type": "text", "text": "QUALIFY_OK_V1"}],
            "stop_reason": "end_turn"
        })),
    )]));
    let mut transport = LiveQualificationTransport::new(
        LiveBackendKind::Anthropic,
        format!("{}/v1", gateway.base_url()),
        Some("sk-test-fixture-not-secret".into()),
        true,
    );
    let gate = ProfileCapabilityGate {
        tools_enabled: true,
        stream_enabled: false,
        embeddings_enabled: false,
    };
    let cancel = Arc::new(AtomicBool::new(false));
    let report = run_qualification(
        QualificationKey::with_protocol(
            "anthropic-profile",
            gateway.base_url(),
            "claude-test",
            cd_core::openai_chat_contract::ChatBackendDialect::Anthropic,
        ),
        gate,
        &mut transport,
        &cancel,
    );

    for (kind, mode_token) in [
        (CapabilityKind::StructuredJsonObject, "json_object"),
        (CapabilityKind::StructuredJsonSchema, "json_schema"),
        (
            CapabilityKind::StructuredJsonSchemaStrict,
            "json_schema_strict",
        ),
        (CapabilityKind::ForcedToolCall, "forced_tool"),
    ] {
        let row = report
            .checks
            .iter()
            .find(|c| c.kind == kind)
            .unwrap_or_else(|| panic!("missing check row for {kind:?}"));
        assert_eq!(
            row.status,
            CapabilityStatus::Fail,
            "{kind:?} must fail closed: {}",
            row.reason
        );
        assert!(
            row.reason.contains("unsupported_request_mode")
                && row.reason.contains("anthropic")
                && row.reason.contains(mode_token),
            "{kind:?} reason must be dialect-honest: {}",
            row.reason
        );
        assert_eq!(
            row.dialect.as_deref(),
            Some("anthropic"),
            "{kind:?} typed dialect must be anthropic on refuse"
        );
        assert_eq!(
            row.request_mode.as_deref(),
            Some(mode_token),
            "{kind:?} must still record the requested mode identity"
        );
        assert_ne!(row.status, CapabilityStatus::Pass);
    }

    // No OpenAI-native wire fields may appear on any Anthropic request that did fire.
    let bodies: Vec<String> = gateway
        .requests()
        .iter()
        .map(|r| String::from_utf8_lossy(&r.body).into_owned())
        .collect();
    assert!(
        bodies
            .iter()
            .all(|b| !b.contains("response_format") && !b.contains("\"tool_choice\"")),
        "anthropic must never receive OpenAI-native response_format/tool_choice: {bodies:?}"
    );

    use cd_core::capability_qualification::{
        capability_contract_verdict, CapabilityContract, ContractVerdict,
    };
    assert_eq!(
        capability_contract_verdict(Some(&report), CapabilityContract::NativeJsonObject),
        ContractVerdict::Unqualified
    );
    assert_eq!(
        capability_contract_verdict(Some(&report), CapabilityContract::ForcedToolLoop),
        ContractVerdict::Unqualified
    );
}

fn chat_ok(content: &str) -> serde_json::Value {
    json!({
        "id": "chatcmpl-ok",
        "choices": [{
            "finish_reason": "stop",
            "message": {"role": "assistant", "content": content}
        }]
    })
}

fn http_400(message: &str) -> Response {
    Response::json(
        400,
        &json!({
            "error": {"message": message, "type": "invalid_request_error"}
        }),
    )
}

/// Observed Vercel-shaped OpenAI-compatible ladder for qwen / gpt-oss / ministral:
/// auto tools and json_schema work; continuation is production-valid prose
/// without QUALIFY_OK_V1; json_object and forced tool_choice return HTTP 400.
#[test]
fn qualification_vercel_shaped_auto_tool_path_is_not_limited_by_optional_native_modes() {
    let rt = tokio::runtime::Runtime::new().expect("gateway runtime");
    let gateway = rt.block_on(MockGateway::start_routed(|req| {
        let body = req.json_body().unwrap_or_else(|| json!({}));
        let messages = body["messages"].as_array().cloned().unwrap_or_default();
        let has_tool_result = messages.iter().any(|m| m["role"] == "tool");
        let rf_type = body["response_format"]["type"].as_str();
        let forced = body.get("tool_choice").is_some_and(|v| v.is_object());
        let tools = body.get("tools").and_then(|v| v.as_array()).is_some_and(|a| !a.is_empty());

        if forced {
            return Step::respond(http_400("tool_choice is not supported in thinking mode"));
        }
        if rf_type == Some("json_object") {
            return Step::respond(http_400("response_format type json_object is not supported"));
        }
        if rf_type == Some("json_schema") {
            return Step::respond(Response::json_ok(&chat_ok(r#"{"qualify":"ok","v":1}"#)));
        }
        if has_tool_result {
            return Step::respond(Response::json_ok(&chat_ok(
                "Acknowledged the echo token and ready for the next step.",
            )));
        }
        if tools {
            return Step::respond(Response::json_ok(&completion_with_tool_calls(json!([{
                "id": "call_probe",
                "type": "function",
                "function": {"name": "cd_qualify_echo", "arguments": "{\"token\":\"QUALIFY_TOOL_V1\"}"}
            }]))));
        }
        let prompted = messages.iter().any(|m| {
            m["content"]
                .as_str()
                .is_some_and(|c| c.contains("JSON only"))
        });
        if prompted {
            return Step::respond(Response::json_ok(&chat_ok(r#"{"qualify":"ok","v":1}"#)));
        }
        Step::respond(Response::json_ok(&chat_ok("QUALIFY_OK_V1")))
    }));

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
    let report = run_qualification(
        QualificationKey::new("qual-profile", gateway.base_url(), "alibaba/qwen3.6-27b"),
        gate,
        &mut transport,
        &cancel,
    );

    use cd_core::capability_qualification::{
        capability_contract_verdict, model_readiness_for_report, CapabilityContract,
        ContractVerdict, ModelReadinessState,
    };

    assert_eq!(
        report.status_of(CapabilityKind::NativeToolCall),
        CapabilityStatus::Pass
    );
    assert_eq!(
        report.status_of(CapabilityKind::ToolResultContinuation),
        CapabilityStatus::Pass,
        "production-valid continuation must not fail on a missing QUALIFY_OK_V1 marker: {:?}",
        report.checks
    );
    assert_eq!(
        report.status_of(CapabilityKind::StructuredOutput),
        CapabilityStatus::Pass
    );
    assert_eq!(
        report.status_of(CapabilityKind::StructuredJsonSchema),
        CapabilityStatus::Pass
    );
    assert_eq!(
        report.status_of(CapabilityKind::StructuredJsonObject),
        CapabilityStatus::Fail
    );
    assert_eq!(
        report.status_of(CapabilityKind::ForcedToolCall),
        CapabilityStatus::Fail
    );

    let json_object = report
        .checks
        .iter()
        .find(|c| c.kind == CapabilityKind::StructuredJsonObject)
        .expect("json_object row");
    assert!(
        json_object.reason.contains("400"),
        "json_object limitation must stay explicit: {}",
        json_object.reason
    );
    let forced = report
        .checks
        .iter()
        .find(|c| c.kind == CapabilityKind::ForcedToolCall)
        .expect("forced row");
    assert!(
        forced.reason.contains("thinking") || forced.reason.contains("400"),
        "forced-tool thinking-mode refusal must stay explicit: {}",
        forced.reason
    );

    let readiness = model_readiness_for_report(&report);
    assert_eq!(
        readiness.state,
        ModelReadinessState::Verified,
        "optional native-mode failures must not mark a valid auto-tool path limited: {}",
        readiness.detail
    );
    assert_eq!(
        capability_contract_verdict(Some(&report), CapabilityContract::NativeToolLoop),
        ContractVerdict::Qualified
    );
    assert_eq!(
        capability_contract_verdict(Some(&report), CapabilityContract::NativeJsonObject),
        ContractVerdict::Unqualified
    );
    assert_eq!(
        capability_contract_verdict(Some(&report), CapabilityContract::ForcedToolLoop),
        ContractVerdict::Unqualified
    );

    let bodies: Vec<serde_json::Value> = gateway
        .requests()
        .iter()
        .filter_map(|r| r.json_body())
        .collect();
    assert!(
        bodies
            .iter()
            .any(|b| b["response_format"]["type"] == "json_object"),
        "must still emit json_object on the wire so HTTP 400 is a real provider limitation"
    );
    assert!(
        bodies
            .iter()
            .any(|b| b["response_format"]["type"] == "json_schema"),
        "json_schema probe must remain on the wire"
    );
    assert!(
        bodies.iter().any(|b| b["tool_choice"].is_object()),
        "forced tool_choice must remain on the wire"
    );
    assert!(
        bodies.iter().any(|b| b["messages"]
            .as_array()
            .is_some_and(|m| m.iter().any(|msg| msg["role"] == "tool"))),
        "continuation must send the OpenAI tool-result message shape"
    );
}

#[test]
fn qualification_empty_tool_continuation_stays_fail_closed() {
    let rt = tokio::runtime::Runtime::new().expect("gateway runtime");
    let gateway = rt.block_on(MockGateway::start_routed(|req| {
        let body = req.json_body().unwrap_or_else(|| json!({}));
        let messages = body["messages"].as_array().cloned().unwrap_or_default();
        let has_tool_result = messages.iter().any(|m| m["role"] == "tool");
        let tools = body.get("tools").and_then(|v| v.as_array()).is_some_and(|a| !a.is_empty());
        if has_tool_result {
            return Step::respond(Response::json_ok(&chat_ok("")));
        }
        if tools {
            return Step::respond(Response::json_ok(&completion_with_tool_calls(json!([{
                "id": "call_probe",
                "type": "function",
                "function": {"name": "cd_qualify_echo", "arguments": "{\"token\":\"QUALIFY_TOOL_V1\"}"}
            }]))));
        }
        Step::respond(Response::json_ok(&chat_ok("QUALIFY_OK_V1")))
    }));

    let mut transport = LiveQualificationTransport::new(
        LiveBackendKind::OpenAiCompatible,
        format!("{}/v1", gateway.base_url()),
        None,
        true,
    );
    let gate = ProfileCapabilityGate {
        tools_enabled: true,
        stream_enabled: false,
        embeddings_enabled: false,
    };
    let cancel = Arc::new(AtomicBool::new(false));
    let report = run_qualification(
        QualificationKey::new("qual-profile", gateway.base_url(), "mistral/ministral-14b"),
        gate,
        &mut transport,
        &cancel,
    );
    assert_eq!(
        report.status_of(CapabilityKind::ToolResultContinuation),
        CapabilityStatus::Fail
    );
    use cd_core::capability_qualification::{
        capability_contract_verdict, model_readiness_for_report, CapabilityContract,
        ContractVerdict, ModelReadinessState,
    };
    assert_eq!(
        capability_contract_verdict(Some(&report), CapabilityContract::NativeToolLoop),
        ContractVerdict::Unqualified
    );
    assert_eq!(
        model_readiness_for_report(&report).state,
        ModelReadinessState::Limited
    );
}
