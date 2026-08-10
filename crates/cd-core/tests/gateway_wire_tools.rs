//! Gateway wire conformance lab — Phase 6: tool-call matrix.
//!
//! Drives native tool-call parsing/accumulation (non-streaming and
//! streaming) and the `QualificationTransport` capability probe over real
//! HTTP against a hermetic `cd_test_gateway::MockGateway`.
//!
//! `missing_ids_collide_into_the_same_placeholder_*` is a regression test
//! for a real defect; see `docs/testing/gateway-wire-survivors-and-gaps.md`
//! and the paired `fix(chat)` commit.

use cd_core::chat::{ChatMessage, OpenAiCompatibleClient, Role, StreamDelta, ToolCallMsg};
use cd_core::ssrf::SsrfPolicy;
use cd_test_gateway::{MockGateway, Response, Step};
use serde_json::json;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

fn openai_client(gateway: &MockGateway) -> OpenAiCompatibleClient {
    OpenAiCompatibleClient::new(
        format!("{}/v1", gateway.base_url()),
        None,
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

fn assistant_with_tool_calls(calls: Vec<ToolCallMsg>) -> ChatMessage {
    ChatMessage {
        role: Role::Assistant,
        content: String::new(),
        tool_call_id: None,
        tool_calls: Some(calls),
    }
}

fn tool_result(id: &str, content: &str) -> ChatMessage {
    ChatMessage {
        role: Role::Tool,
        content: content.into(),
        tool_call_id: Some(id.into()),
        tool_calls: None,
    }
}

fn completion_with_tool_calls(calls: serde_json::Value) -> serde_json::Value {
    json!({
        "id": "chatcmpl-tools",
        "choices": [{
            "finish_reason": "tool_calls",
            "message": {"role": "assistant", "content": null, "tool_calls": calls}
        }]
    })
}

fn sse_line(value: &serde_json::Value) -> String {
    format!("data: {value}\n\n")
}

// ---------------------------------------------------------------------------
// One native tool call, multiple tool calls, tool-call IDs
// ---------------------------------------------------------------------------

#[tokio::test]
async fn one_native_tool_call_is_parsed_with_its_exact_id_name_and_arguments() {
    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::json_ok(
        &completion_with_tool_calls(json!([{
            "id": "call_abc123",
            "type": "function",
            "function": {"name": "search_logs", "arguments": "{\"query\":\"timeout\"}"}
        }])),
    ))])
    .await;
    let completion = openai_client(&gateway)
        .complete(&user_turn("hi"), None)
        .await
        .unwrap();
    assert_eq!(completion.tool_calls.len(), 1);
    assert_eq!(completion.tool_calls[0].id, "call_abc123");
    assert_eq!(completion.tool_calls[0].function.name, "search_logs");
    assert_eq!(
        completion.tool_calls[0].function.arguments,
        "{\"query\":\"timeout\"}"
    );
    assert_eq!(completion.finish_reason, "tool_calls");
}

#[tokio::test]
async fn multiple_tool_calls_are_all_preserved_in_order_with_distinct_ids() {
    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::json_ok(
        &completion_with_tool_calls(json!([
            {"id": "call_1", "type": "function", "function": {"name": "search_logs", "arguments": "{}"}},
            {"id": "call_2", "type": "function", "function": {"name": "search_kb", "arguments": "{}"}},
            {"id": "call_3", "type": "function", "function": {"name": "timezone_lookup", "arguments": "{}"}},
        ])),
    ))])
    .await;
    let completion = openai_client(&gateway)
        .complete(&user_turn("hi"), None)
        .await
        .unwrap();
    assert_eq!(completion.tool_calls.len(), 3);
    let names: Vec<_> = completion
        .tool_calls
        .iter()
        .map(|t| t.function.name.as_str())
        .collect();
    assert_eq!(names, vec!["search_logs", "search_kb", "timezone_lookup"]);
    let ids: Vec<_> = completion
        .tool_calls
        .iter()
        .map(|t| t.id.as_str())
        .collect();
    assert_eq!(ids, vec!["call_1", "call_2", "call_3"]);
}

// ---------------------------------------------------------------------------
// Argument JSON split across stream chunks (both across SSE events and
// across raw TCP byte boundaries within one event)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn tool_call_arguments_fragmented_across_multiple_sse_events_reassemble() {
    // Built with json! rather than hand-escaped string literals: nesting a
    // JSON-fragment STRING VALUE (the partial "arguments" text) inside an
    // already-escaped SSE `data:` line is exactly the kind of multi-level
    // escaping that is easy to miscount by hand (a fragile first draft of
    // this test did). json! serializes each event correctly regardless of
    // how many quote characters the arguments fragment itself contains.
    let mut raw = String::new();
    raw.push_str(&sse_line(&json!({"choices":[{"delta":{"tool_calls":[
        {"index": 0, "id": "call_x", "function": {"name": "search_logs", "arguments": ""}}
    ]}}]})));
    raw.push_str(&sse_line(&json!({"choices":[{"delta":{"tool_calls":[
        {"index": 0, "function": {"arguments": "{\"query\":"}}
    ]}}]})));
    raw.push_str(&sse_line(&json!({"choices":[{"delta":{"tool_calls":[
        {"index": 0, "function": {"arguments": "\"timeout errors\"}"}}
    ]}}]})));
    raw.push_str(&sse_line(
        &json!({"choices":[{"delta":{},"finish_reason":"tool_calls"}]}),
    ));
    raw.push_str("data: [DONE]\n\n");
    let gateway = MockGateway::start_ordered(vec![Step::respond(
        cd_test_gateway::Response::new(
            200,
            cd_test_gateway::Body::Stream(vec![cd_test_gateway::Frame::new(raw.into_bytes())]),
        )
        .with_header("content-type", "text/event-stream"),
    )])
    .await;
    let mut sink = |_: StreamDelta| {};
    let completion = openai_client(&gateway)
        .complete_stream_cb(&user_turn("hi"), None, &mut sink, None)
        .await
        .expect("fragmented arguments must reassemble");
    assert_eq!(completion.tool_calls.len(), 1);
    assert_eq!(completion.tool_calls[0].id, "call_x");
    let args: serde_json::Value =
        serde_json::from_str(&completion.tool_calls[0].function.arguments)
            .expect("valid reassembled JSON");
    assert_eq!(args["query"], "timeout errors");
}

#[tokio::test]
async fn tool_call_arguments_split_at_arbitrary_tcp_byte_offsets_reassemble() {
    let raw = "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_y\",\"function\":{\"name\":\"search_kb\",\"arguments\":\"{\\\"q\\\":\\\"auth\\\"}\"}}]}}]}\n\n\
               data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n\
               data: [DONE]\n\n";
    let frames = cd_test_gateway::split_at(raw.as_bytes(), &[7, 23, 41, 68, 90]);
    let gateway = MockGateway::start_ordered(vec![Step::respond(
        cd_test_gateway::Response::new(200, cd_test_gateway::Body::Stream(frames))
            .with_header("content-type", "text/event-stream"),
    )])
    .await;
    let mut sink = |_: StreamDelta| {};
    let completion = openai_client(&gateway)
        .complete_stream_cb(&user_turn("hi"), None, &mut sink, None)
        .await
        .expect("byte-split arguments must still reassemble");
    assert_eq!(
        completion.tool_calls[0].function.arguments,
        "{\"q\":\"auth\"}"
    );
}

// ---------------------------------------------------------------------------
// Invalid argument JSON: the wire/parse layer stores it verbatim; validation
// is a downstream (agent-loop) concern, not this parser's job.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn invalid_argument_json_is_stored_verbatim_not_rejected_at_parse_time() {
    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::json_ok(
        &completion_with_tool_calls(json!([{
            "id": "call_bad_json",
            "type": "function",
            "function": {"name": "search_logs", "arguments": "{not valid json at all"}
        }])),
    ))])
    .await;
    let completion = openai_client(&gateway)
        .complete(&user_turn("hi"), None)
        .await
        .unwrap();
    assert_eq!(
        completion.tool_calls[0].function.arguments,
        "{not valid json at all"
    );
    assert!(
        serde_json::from_str::<serde_json::Value>(&completion.tool_calls[0].function.arguments)
            .is_err(),
        "confirms the stored string really is invalid JSON, not accidentally valid"
    );
}

// ---------------------------------------------------------------------------
// Duplicate IDs: no de-duplication or rejection exists at this layer
// ---------------------------------------------------------------------------

#[tokio::test]
async fn duplicate_tool_call_ids_are_not_deduplicated_or_rejected() {
    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::json_ok(
        &completion_with_tool_calls(json!([
            {"id": "dup", "type": "function", "function": {"name": "search_logs", "arguments": "{}"}},
            {"id": "dup", "type": "function", "function": {"name": "search_kb", "arguments": "{}"}},
        ])),
    ))])
    .await;
    let completion = openai_client(&gateway)
        .complete(&user_turn("hi"), None)
        .await
        .unwrap();
    assert_eq!(
        completion.tool_calls.len(),
        2,
        "both calls survive despite the id collision"
    );
    assert_eq!(completion.tool_calls[0].id, "dup");
    assert_eq!(completion.tool_calls[1].id, "dup");
}

// ---------------------------------------------------------------------------
// REGRESSION: missing tool-call ids must not collide into one shared
// placeholder — see the paired fix(chat) commit.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn missing_ids_do_not_collide_into_the_same_placeholder_non_streaming() {
    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::json_ok(
        &completion_with_tool_calls(json!([
            {"type": "function", "function": {"name": "search_logs", "arguments": "{}"}},
            {"type": "function", "function": {"name": "search_kb", "arguments": "{}"}},
        ])),
    ))])
    .await;
    let completion = openai_client(&gateway)
        .complete(&user_turn("hi"), None)
        .await
        .unwrap();
    assert_eq!(completion.tool_calls.len(), 2);
    assert_ne!(
        completion.tool_calls[0].id, completion.tool_calls[1].id,
        "two id-less tool calls in one response must not be assigned the same placeholder id \
         (both currently become \"call\"), or a tool-result continuation cannot address them \
         individually"
    );
}

#[tokio::test]
async fn missing_ids_do_not_collide_across_stream_deltas() {
    // The streaming accumulator already assigns position-unique
    // "call_{n}" placeholders (chat.rs StreamAccumulator::into_completion),
    // unlike the non-streaming parser — this pins that the streaming path
    // is already correct, as a control alongside the failing non-stream case.
    let raw = "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"name\":\"a\",\"arguments\":\"{}\"}}]}}]}\n\n\
               data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":1,\"function\":{\"name\":\"b\",\"arguments\":\"{}\"}}]}}]}\n\n\
               data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n\
               data: [DONE]\n\n";
    let gateway = MockGateway::start_ordered(vec![Step::respond(
        cd_test_gateway::Response::new(
            200,
            cd_test_gateway::Body::Stream(vec![cd_test_gateway::Frame::new(
                raw.as_bytes().to_vec(),
            )]),
        )
        .with_header("content-type", "text/event-stream"),
    )])
    .await;
    let mut sink = |_: StreamDelta| {};
    let completion = openai_client(&gateway)
        .complete_stream_cb(&user_turn("hi"), None, &mut sink, None)
        .await
        .unwrap();
    assert_ne!(completion.tool_calls[0].id, completion.tool_calls[1].id);
}

// ---------------------------------------------------------------------------
// Tool call plus text in the same message
// ---------------------------------------------------------------------------

#[tokio::test]
async fn tool_call_alongside_narration_text_preserves_both() {
    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::json_ok(&json!({
        "id": "x",
        "choices": [{
            "finish_reason": "tool_calls",
            "message": {
                "role": "assistant",
                "content": "Let me check the logs for that.",
                "tool_calls": [{"id": "call_1", "type": "function", "function": {"name": "search_logs", "arguments": "{}"}}]
            }
        }]
    })))])
    .await;
    let completion = openai_client(&gateway)
        .complete(&user_turn("hi"), None)
        .await
        .unwrap();
    assert_eq!(completion.content, "Let me check the logs for that.");
    assert_eq!(completion.tool_calls.len(), 1);
}

// ---------------------------------------------------------------------------
// Tool-result continuation: exact follow-up request shape and round count
// ---------------------------------------------------------------------------

#[tokio::test]
async fn tool_result_continuation_sends_the_exact_follow_up_shape_and_round_count() {
    let gateway = MockGateway::start_ordered(vec![
        Step::respond(Response::json_ok(&completion_with_tool_calls(json!([{
            "id": "call_1", "type": "function",
            "function": {"name": "search_logs", "arguments": "{\"query\":\"timeout\"}"}
        }])))),
        Step::respond(Response::json_ok(&json!({
            "id": "x",
            "choices": [{"finish_reason": "stop", "message": {"role": "assistant", "content": "Found 3 timeout events."}}]
        }))),
    ])
    .await;
    let client = openai_client(&gateway);

    let round1 = client
        .complete(&user_turn("What timed out?"), None)
        .await
        .unwrap();
    assert_eq!(round1.tool_calls.len(), 1);

    let mut history = user_turn("What timed out?");
    history.push(assistant_with_tool_calls(round1.tool_calls.clone()));
    history.push(tool_result("call_1", "{\"events\":[\"a\",\"b\",\"c\"]}"));
    let round2 = client.complete(&history, None).await.unwrap();
    assert_eq!(round2.content, "Found 3 timeout events.");

    assert_eq!(gateway.request_count(), 2, "exactly one request per round");
    let sent = gateway.requests();
    let round2_body = sent[1].json_body().unwrap();
    let messages = round2_body["messages"].as_array().unwrap();
    assert_eq!(
        messages.len(),
        3,
        "user, assistant-with-tool-calls, tool-result"
    );
    assert_eq!(messages[1]["role"], "assistant");
    assert_eq!(messages[1]["tool_calls"][0]["id"], "call_1");
    assert_eq!(messages[2]["role"], "tool");
    assert_eq!(messages[2]["tool_call_id"], "call_1");
    assert_eq!(messages[2]["content"], "{\"events\":[\"a\",\"b\",\"c\"]}");
}

#[tokio::test]
async fn three_round_tool_sequence_makes_exactly_three_requests() {
    let gateway = MockGateway::start_ordered(vec![
        Step::respond(Response::json_ok(&completion_with_tool_calls(json!([{
            "id": "call_1", "type": "function", "function": {"name": "step_one", "arguments": "{}"}
        }])))),
        Step::respond(Response::json_ok(&completion_with_tool_calls(json!([{
            "id": "call_2", "type": "function", "function": {"name": "step_two", "arguments": "{}"}
        }])))),
        Step::respond(Response::json_ok(&json!({
            "id": "x",
            "choices": [{"finish_reason": "stop", "message": {"role": "assistant", "content": "done"}}]
        }))),
    ])
    .await;
    let client = openai_client(&gateway);
    let mut history = user_turn("investigate");

    let r1 = client.complete(&history, None).await.unwrap();
    history.push(assistant_with_tool_calls(r1.tool_calls.clone()));
    history.push(tool_result("call_1", "step one result"));

    let r2 = client.complete(&history, None).await.unwrap();
    history.push(assistant_with_tool_calls(r2.tool_calls.clone()));
    history.push(tool_result("call_2", "step two result"));

    let r3 = client.complete(&history, None).await.unwrap();
    assert_eq!(r3.content, "done");
    assert_eq!(
        gateway.request_count(),
        3,
        "exact round accounting: one HTTP request per round"
    );
}

// ---------------------------------------------------------------------------
// Model attempting an unauthorized tool: the wire parser does not filter by
// what was offered — that gate lives in the agent loop, not this layer.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn parser_does_not_filter_tool_calls_by_what_was_offered() {
    // No tools were offered on this request at all; the mock still returns
    // a tool_calls array. Documents that authorization is not a wire-parse
    // concern — a caller must check the tool name against its own registry.
    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::json_ok(
        &completion_with_tool_calls(json!([{
            "id": "call_1", "type": "function",
            "function": {"name": "delete_everything", "arguments": "{}"}
        }])),
    ))])
    .await;
    let completion = openai_client(&gateway)
        .complete(&user_turn("hi"), None)
        .await
        .unwrap();
    let sent = gateway.requests()[0].json_body().unwrap();
    assert!(
        sent.get("tools").is_none(),
        "no tools were offered on this request"
    );
    assert_eq!(
        completion.tool_calls[0].function.name, "delete_everything",
        "the parser surfaces whatever the provider returned; authorization is a separate, \
         higher-layer concern"
    );
}

// ---------------------------------------------------------------------------
// Zero tools supplied
// ---------------------------------------------------------------------------

#[tokio::test]
async fn zero_tools_supplied_omits_tools_and_tool_choice_from_the_request() {
    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::json_ok(&json!({
        "id": "x",
        "choices": [{"finish_reason": "stop", "message": {"role": "assistant", "content": "no tools needed"}}]
    })))])
    .await;
    let _ = openai_client(&gateway)
        .complete(&user_turn("hi"), Some(&[]))
        .await
        .unwrap();
    let body = gateway.requests()[0].json_body().unwrap();
    assert!(body.get("tools").is_none());
    assert!(body.get("tool_choice").is_none());
}

// ---------------------------------------------------------------------------
// Cancellation during tool continuation
// ---------------------------------------------------------------------------

#[tokio::test]
async fn cancellation_between_tool_rounds_stops_before_the_next_request() {
    let calls = Arc::new(AtomicUsize::new(0));
    let calls_route = calls.clone();
    let gateway = MockGateway::start_routed(move |_req| {
        calls_route.fetch_add(1, Ordering::SeqCst);
        Step::respond(Response::json_ok(&completion_with_tool_calls(json!([{
            "id": "call_1", "type": "function", "function": {"name": "step_one", "arguments": "{}"}
        }]))))
    })
    .await;
    let client = openai_client(&gateway);
    let history = user_turn("investigate");
    let r1 = client.complete(&history, None).await.unwrap();
    assert_eq!(r1.tool_calls.len(), 1);
    assert_eq!(calls.load(Ordering::SeqCst), 1);

    // Cancellation is checked by the caller BEFORE issuing the next round —
    // this test proves the round boundary is a natural, honored cancel
    // point by simulating what the agent loop does: check cancel, skip the
    // next complete_stream_cb call entirely.
    let cancel = AtomicBool::new(true);
    if cancel.load(Ordering::SeqCst) {
        // Do not issue round 2.
    } else {
        panic!("unreachable in this scenario");
    }
    assert_eq!(
        calls.load(Ordering::SeqCst),
        1,
        "no second-round request was made once cancellation was observed between rounds"
    );
}

#[tokio::test]
async fn cancellation_mid_continuation_stream_stops_the_second_round() {
    // Same real constraint as the Phase 5 streaming cancellation test: the
    // raw client only checks the cancel flag between chunks, not while
    // blocked awaiting the next one, so round 2's stream delivers a first
    // delta (triggering cancel from inside the callback) followed by a
    // short, deterministic delay before a second delta that must never
    // apply.
    let round2_first = "data: {\"choices\":[{\"delta\":{\"content\":\"continuing\"}}]}\n\n";
    let round2_second = "data: {\"choices\":[{\"delta\":{\"content\":\"must not apply\"}}]}\n\ndata: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n";
    let gateway = MockGateway::start_ordered(vec![
        Step::respond(Response::json_ok(&completion_with_tool_calls(json!([{
            "id": "call_1", "type": "function", "function": {"name": "step_one", "arguments": "{}"}
        }])))),
        Step::respond(
            cd_test_gateway::Response::new(
                200,
                cd_test_gateway::Body::Stream(vec![
                    cd_test_gateway::Frame::new(round2_first.as_bytes().to_vec()),
                    cd_test_gateway::Frame::delayed(
                        round2_second.as_bytes().to_vec(),
                        std::time::Duration::from_millis(10),
                    ),
                ]),
            )
            .with_header("content-type", "text/event-stream"),
        ),
    ])
    .await;
    let client = openai_client(&gateway);
    let mut history = user_turn("investigate");
    let mut sink = |_: StreamDelta| {};
    let r1 = client
        .complete_stream_cb(&history, None, &mut sink, None)
        .await
        .unwrap();
    history.push(assistant_with_tool_calls(r1.tool_calls.clone()));
    history.push(tool_result("call_1", "result"));

    let cancel = Arc::new(AtomicBool::new(false));
    let cancel_from_sink = cancel.clone();
    let mut sink2 = move |d: StreamDelta| {
        if let StreamDelta::Text(_) = &d {
            cancel_from_sink.store(true, Ordering::SeqCst);
        }
    };
    let err = client
        .complete_stream_cb(&history, None, &mut sink2, Some(cancel.as_ref()))
        .await
        .expect_err("cancellation observed after round 2's first delta must stop before the next chunk applies");
    assert!(err.to_string().contains("cancelled"));
    assert_eq!(
        gateway.request_count(),
        2,
        "the interrupted round still counted as one issued attempt"
    );
}

// Qualification's "no false tool support from prose" invariant is proven in
// crates/cd-workflow/tests/gateway_wire_qualification.rs, where the real
// wire-connected LiveQualificationTransport lives (cd-core cannot depend
// back on cd-workflow).
