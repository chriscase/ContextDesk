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
