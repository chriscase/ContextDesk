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
};
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
            "function": {"name": "cd_qualify_echo", "arguments": "{\"token\":\"probe_ok\"}"}
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
        QualificationKey::new("ollama-profile", gateway.base_url(), "llama3"),
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
        QualificationKey::new("anthropic-profile", gateway.base_url(), "claude-test"),
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
