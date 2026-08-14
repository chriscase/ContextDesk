//! Gateway wire conformance lab — Phase 5: streaming matrix.
//!
//! Drives `OpenAiCompatibleClient::complete_stream_cb` /
//! `AnthropicClient::complete_stream_cb` — the REAL streaming code path —
//! against a hermetic `cd_test_gateway::MockGateway`, with byte-exact
//! control over SSE framing, chunk boundaries, and connection lifecycle.
//!
//! Two scenarios in this file (`premature_close_*`, `anthropic_error_event_*`)
//! are regression tests for real defects found while mapping this matrix;
//! see `docs/testing/gateway-wire-survivors-and-gaps.md` for the root-cause
//! writeup and the paired `fix(chat): ...` commits.

use cd_core::chat::{AnthropicClient, ChatMessage, OpenAiCompatibleClient, Role, StreamDelta};
use cd_core::ssrf::SsrfPolicy;
use cd_test_gateway::{split_at, Body, Frame, MockGateway, Response, Step};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

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

/// A `Fn` callback sink that records every delta it sees, for assertions on
/// exactly what streamed before an eventual error.
#[derive(Clone, Default)]
struct DeltaLog(Arc<Mutex<Vec<StreamDelta>>>);

impl DeltaLog {
    fn sink(&self) -> impl FnMut(StreamDelta) + '_ {
        move |d: StreamDelta| self.0.lock().unwrap().push(d)
    }

    fn texts(&self) -> String {
        self.0
            .lock()
            .unwrap()
            .iter()
            .filter_map(|d| match d {
                StreamDelta::Text(t) => Some(t.clone()),
                _ => None,
            })
            .collect()
    }
}

fn sse_stream_frames(events: &[&str]) -> Body {
    let joined: String = events.iter().map(|e| format!("data: {e}\n\n")).collect();
    Body::Stream(vec![Frame::new(joined.into_bytes())])
}

// ---------------------------------------------------------------------------
// Ordinary SSE, comments/blank lines, CRLF/LF, multi-event-per-chunk,
// event-split-across-chunks
// ---------------------------------------------------------------------------

#[tokio::test]
async fn ordinary_sse_stream_accumulates_content_and_finish_reason() {
    let gateway = MockGateway::start_ordered(vec![Step::respond(
        Response::new(
            200,
            sse_stream_frames(&[
                r#"{"choices":[{"delta":{"content":"hello "}}]}"#,
                r#"{"choices":[{"delta":{"content":"world"}}]}"#,
                r#"{"choices":[{"delta":{},"finish_reason":"stop"}]}"#,
                "[DONE]",
            ]),
        )
        .with_header("content-type", "text/event-stream"),
    )])
    .await;
    let log = DeltaLog::default();
    let completion = openai_client(&gateway)
        .complete_stream_cb(&user_turn("hi"), None, &mut log.sink(), None)
        .await
        .expect("ordinary stream completes");
    assert_eq!(completion.content, "hello world");
    assert_eq!(completion.finish_reason, "stop");
    assert_eq!(log.texts(), "hello world");
}

#[tokio::test]
async fn comments_and_blank_lines_are_skipped_over_the_real_wire() {
    let raw = ": keep-alive\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\n\n: another comment\n\ndata: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n";
    let gateway = MockGateway::start_ordered(vec![Step::respond(
        Response::new(200, Body::Stream(vec![Frame::new(raw.as_bytes().to_vec())]))
            .with_header("content-type", "text/event-stream"),
    )])
    .await;
    let mut sink = |_: StreamDelta| {};
    let completion = openai_client(&gateway)
        .complete_stream_cb(&user_turn("hi"), None, &mut sink, None)
        .await
        .expect("comments/blank lines must not break framing");
    assert_eq!(completion.content, "ok");
}

#[tokio::test]
async fn crlf_and_lf_line_terminators_both_parse_correctly() {
    let raw = "data: {\"choices\":[{\"delta\":{\"content\":\"cr\"}}]}\r\n\r\ndata: {\"choices\":[{\"delta\":{\"content\":\"lf\"}}]}\n\ndata: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\r\n\r\ndata: [DONE]\r\n\r\n";
    let gateway = MockGateway::start_ordered(vec![Step::respond(
        Response::new(200, Body::Stream(vec![Frame::new(raw.as_bytes().to_vec())]))
            .with_header("content-type", "text/event-stream"),
    )])
    .await;
    let mut sink = |_: StreamDelta| {};
    let completion = openai_client(&gateway)
        .complete_stream_cb(&user_turn("hi"), None, &mut sink, None)
        .await
        .expect("mixed CRLF/LF must parse");
    assert_eq!(completion.content, "crlf");
}

#[tokio::test]
async fn multiple_events_delivered_in_one_transport_chunk_all_apply() {
    let raw = "data: {\"choices\":[{\"delta\":{\"content\":\"a\"}}]}\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"b\"}}]}\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"c\"}}]}\n\ndata: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n";
    // One single Frame == one single write == the client observes it as (at
    // most) one transport chunk.
    let gateway = MockGateway::start_ordered(vec![Step::respond(
        Response::new(200, Body::Stream(vec![Frame::new(raw.as_bytes().to_vec())]))
            .with_header("content-type", "text/event-stream"),
    )])
    .await;
    let mut sink = |_: StreamDelta| {};
    let completion = openai_client(&gateway)
        .complete_stream_cb(&user_turn("hi"), None, &mut sink, None)
        .await
        .expect("ok");
    assert_eq!(completion.content, "abc");
}

#[tokio::test]
async fn one_event_split_across_many_chunks_reassembles_cleanly() {
    let raw = "data: {\"choices\":[{\"delta\":{\"content\":\"reassembled\"}}]}\n\ndata: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n";
    // Split at 5 arbitrary byte offsets, forcing the client to see the
    // single SSE event arrive across six separate TCP reads.
    let frames = split_at(raw.as_bytes(), &[3, 9, 17, 28, 41]);
    let gateway = MockGateway::start_ordered(vec![Step::respond(
        Response::new(200, Body::Stream(frames)).with_header("content-type", "text/event-stream"),
    )])
    .await;
    let mut sink = |_: StreamDelta| {};
    let completion = openai_client(&gateway)
        .complete_stream_cb(&user_turn("hi"), None, &mut sink, None)
        .await
        .expect("split event must reassemble");
    assert_eq!(completion.content, "reassembled");
}

#[tokio::test]
async fn anthropic_utf8_content_split_across_chunks_decodes_intact() {
    // OpenAI's UTF-8-split-across-chunks wire behavior is already covered
    // by crates/cd-core/tests/transport_semantic_attempt_oracle.rs; this
    // covers the same property for the independent Anthropic accumulator.
    let text = "caf\u{e9} \u{1f389} done"; // café 🎉 done
    let raw = format!(
        "event: content_block_start\ndata: {{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{{\"type\":\"text\",\"text\":\"\"}}}}\n\nevent: content_block_delta\ndata: {{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{{\"type\":\"text_delta\",\"text\":\"{text}\"}}}}\n\nevent: message_delta\ndata: {{\"type\":\"message_delta\",\"delta\":{{\"stop_reason\":\"end_turn\"}}}}\n\nevent: message_stop\ndata: {{\"type\":\"message_stop\"}}\n\n"
    );
    let bytes = raw.as_bytes();
    let e_pos = raw.find('\u{e9}').unwrap();
    let emoji_pos = raw.find('\u{1f389}').unwrap();
    let frames = split_at(bytes, &[e_pos + 1, emoji_pos + 2]);
    let gateway = MockGateway::start_ordered(vec![Step::respond(
        Response::new(200, Body::Stream(frames)).with_header("content-type", "text/event-stream"),
    )])
    .await;
    let mut sink = |_: StreamDelta| {};
    let completion = anthropic_client(&gateway)
        .complete_stream_cb(&user_turn("hi"), None, &mut sink, None)
        .await
        .expect("split multi-byte UTF-8 must decode intact");
    assert_eq!(completion.content, text);
}

// ---------------------------------------------------------------------------
// [DONE] present, [DONE] missing (but a real finish signal still arrives)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn missing_done_marker_still_completes_when_a_finish_reason_arrived() {
    // No [DONE] sentinel at all — some gateways omit it — but finish_reason
    // did arrive, so this is a legitimately complete answer.
    let raw = "data: {\"choices\":[{\"delta\":{\"content\":\"no done marker\"}}]}\n\ndata: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n";
    let gateway = MockGateway::start_ordered(vec![Step::respond(
        Response::new(200, Body::Stream(vec![Frame::new(raw.as_bytes().to_vec())]))
            .with_header("content-type", "text/event-stream"),
    )])
    .await;
    let mut sink = |_: StreamDelta| {};
    let completion = openai_client(&gateway)
        .complete_stream_cb(&user_turn("hi"), None, &mut sink, None)
        .await
        .expect("an explicit finish_reason is enough even without [DONE]");
    assert_eq!(completion.content, "no done marker");
    assert_eq!(completion.finish_reason, "stop");
}

// ---------------------------------------------------------------------------
// REGRESSION: premature connection close must not be misreported as a
// completed, validated answer — the primary defect this matrix was built to
// catch. See docs/testing/gateway-wire-survivors-and-gaps.md.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn premature_close_after_partial_content_is_reported_as_an_error_not_a_completion() {
    // Content arrives, then the connection closes cleanly (valid HTTP
    // framing — Body::Stream's normal termination) with NO finish_reason
    // delta and NO [DONE] sentinel ever sent. Before the fix, StreamAccumulator
    // fabricated finish_reason="stop" and this returned Ok(completion) with
    // truncated content silently presented as a normal, complete answer.
    let raw =
        "data: {\"choices\":[{\"delta\":{\"content\":\"partial answer, then the gate\"}}]}\n\n";
    let gateway = MockGateway::start_ordered(vec![Step::respond(
        Response::new(200, Body::Stream(vec![Frame::new(raw.as_bytes().to_vec())]))
            .with_header("content-type", "text/event-stream"),
    )])
    .await;
    let log = DeltaLog::default();
    let outcome = openai_client(&gateway)
        .complete_stream_cb(&user_turn("hi"), None, &mut log.sink(), None)
        .await;
    assert!(
        outcome.is_err(),
        "a stream that closes with no finish signal must not be reported as a completed answer, got {outcome:?}"
    );
    assert_eq!(
        log.texts(),
        "partial answer, then the gate",
        "the partial text is still legitimately delivered live via the callback \
         (the caller may already be rendering it) — only the overall Result must not \
         claim success"
    );
}

#[tokio::test]
async fn anthropic_premature_close_after_partial_content_is_also_an_error() {
    let raw = "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\nevent: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"cut off mid\"}}\n\n";
    let gateway = MockGateway::start_ordered(vec![Step::respond(
        Response::new(200, Body::Stream(vec![Frame::new(raw.as_bytes().to_vec())]))
            .with_header("content-type", "text/event-stream"),
    )])
    .await;
    let mut sink = |_: StreamDelta| {};
    let outcome = anthropic_client(&gateway)
        .complete_stream_cb(&user_turn("hi"), None, &mut sink, None)
        .await;
    assert!(
        outcome.is_err(),
        "Anthropic stream cut off before message_delta/message_stop must not fabricate end_turn, got {outcome:?}"
    );
}

#[tokio::test]
async fn completely_empty_stream_body_is_an_error_not_a_silent_empty_success() {
    let gateway = MockGateway::start_ordered(vec![Step::respond(
        Response::new(200, Body::Stream(vec![])).with_header("content-type", "text/event-stream"),
    )])
    .await;
    let mut sink = |_: StreamDelta| {};
    let outcome = openai_client(&gateway)
        .complete_stream_cb(&user_turn("hi"), None, &mut sink, None)
        .await;
    assert!(
        outcome.is_err(),
        "zero bytes and zero finish signal must not be Ok, got {outcome:?}"
    );
}

// ---------------------------------------------------------------------------
// Malformed event among valid events
// ---------------------------------------------------------------------------

#[tokio::test]
async fn malformed_event_among_valid_events_aborts_without_fabricating_success() {
    let raw = "data: {\"choices\":[{\"delta\":{\"content\":\"good start\"}}]}\n\ndata: {this is not json\n\ndata: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n";
    let gateway = MockGateway::start_ordered(vec![Step::respond(
        Response::new(200, Body::Stream(vec![Frame::new(raw.as_bytes().to_vec())]))
            .with_header("content-type", "text/event-stream"),
    )])
    .await;
    let log = DeltaLog::default();
    let outcome = openai_client(&gateway)
        .complete_stream_cb(&user_turn("hi"), None, &mut log.sink(), None)
        .await;
    assert!(
        outcome.is_err(),
        "a malformed data line must abort the read, not be skipped silently"
    );
    assert_eq!(
        log.texts(),
        "good start",
        "content before the malformed line was still legitimately streamed"
    );
}

// ---------------------------------------------------------------------------
// Empty delta events
// ---------------------------------------------------------------------------

#[tokio::test]
async fn empty_delta_events_are_harmless_no_ops() {
    let raw = "data: {\"choices\":[{\"delta\":{}}]}\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"real\"}}]}\n\ndata: {\"choices\":[{\"delta\":{}}]}\n\ndata: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n";
    let gateway = MockGateway::start_ordered(vec![Step::respond(
        Response::new(200, Body::Stream(vec![Frame::new(raw.as_bytes().to_vec())]))
            .with_header("content-type", "text/event-stream"),
    )])
    .await;
    let mut sink = |_: StreamDelta| {};
    let completion = openai_client(&gateway)
        .complete_stream_cb(&user_turn("hi"), None, &mut sink, None)
        .await
        .expect("empty deltas must not error");
    assert_eq!(completion.content, "real");
}

// ---------------------------------------------------------------------------
// Content and tool-call deltas interleaved
// ---------------------------------------------------------------------------

#[tokio::test]
async fn content_and_tool_call_deltas_in_the_same_event_are_both_preserved() {
    let raw = "data: {\"choices\":[{\"delta\":{\"content\":\"checking logs... \",\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"search_logs\",\"arguments\":\"{\\\"q\\\":\\\"timeout\\\"}\"}}]}}]}\n\ndata: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\ndata: [DONE]\n\n";
    let gateway = MockGateway::start_ordered(vec![Step::respond(
        Response::new(200, Body::Stream(vec![Frame::new(raw.as_bytes().to_vec())]))
            .with_header("content-type", "text/event-stream"),
    )])
    .await;
    let mut sink = |_: StreamDelta| {};
    let completion = openai_client(&gateway)
        .complete_stream_cb(&user_turn("hi"), None, &mut sink, None)
        .await
        .expect("interleaved content+tool_call delta must not drop either");
    assert_eq!(completion.content, "checking logs... ");
    assert_eq!(completion.tool_calls.len(), 1);
    assert_eq!(completion.tool_calls[0].function.name, "search_logs");
}

// ---------------------------------------------------------------------------
// Usage in the final chunk
// ---------------------------------------------------------------------------

#[tokio::test]
async fn usage_reported_only_in_the_final_chunk_populates_telemetry() {
    let raw = "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\ndata: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":7,\"completion_tokens\":3,\"total_tokens\":10}}\n\ndata: [DONE]\n\n";
    let gateway = MockGateway::start_ordered(vec![Step::respond(
        Response::new(200, Body::Stream(vec![Frame::new(raw.as_bytes().to_vec())]))
            .with_header("content-type", "text/event-stream"),
    )])
    .await;
    let mut sink = |_: StreamDelta| {};
    let completion = openai_client(&gateway)
        .complete_stream_cb(&user_turn("hi"), None, &mut sink, None)
        .await
        .expect("ok");
    assert_eq!(completion.telemetry.prompt_tokens, Some(7));
    assert_eq!(completion.telemetry.completion_tokens, Some(3));
    assert_eq!(completion.telemetry.total_tokens, Some(10));
}

// ---------------------------------------------------------------------------
// REGRESSION: provider error event midstream must abort, never be silently
// discarded — Anthropic-specific defect (OpenAI already handles this).
// ---------------------------------------------------------------------------

#[tokio::test]
async fn openai_error_event_midstream_aborts_and_does_not_fabricate_success() {
    let raw = "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\ndata: {\"error\":{\"message\":\"provider overloaded mid-stream\"}}\n\n";
    let gateway = MockGateway::start_ordered(vec![Step::respond(
        Response::new(200, Body::Stream(vec![Frame::new(raw.as_bytes().to_vec())]))
            .with_header("content-type", "text/event-stream"),
    )])
    .await;
    let mut sink = |_: StreamDelta| {};
    let err = openai_client(&gateway)
        .complete_stream_cb(&user_turn("hi"), None, &mut sink, None)
        .await
        .expect_err("a mid-stream error event must abort with an error");
    assert!(
        err.to_string().contains("provider overloaded mid-stream"),
        "{err}"
    );
}

#[tokio::test]
async fn anthropic_error_event_midstream_aborts_and_does_not_fabricate_success() {
    // Before the fix: accumulate_anthropic_sse's `_` wildcard arm silently
    // discarded any `event: error` frame, so this returned Ok(completion)
    // with only the pre-error partial content and no indication anything
    // went wrong.
    let raw = "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\nevent: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"partial\"}}\n\nevent: error\ndata: {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}\n\n";
    let gateway = MockGateway::start_ordered(vec![Step::respond(
        Response::new(200, Body::Stream(vec![Frame::new(raw.as_bytes().to_vec())]))
            .with_header("content-type", "text/event-stream"),
    )])
    .await;
    let mut sink = |_: StreamDelta| {};
    let err = anthropic_client(&gateway)
        .complete_stream_cb(&user_turn("hi"), None, &mut sink, None)
        .await
        .expect_err(
            "a mid-stream Anthropic error event must abort with an error, not fabricate success",
        );
    assert!(err.to_string().contains("Overloaded"), "{err}");
}

#[tokio::test]
async fn anthropic_error_event_without_an_explicit_event_line_is_still_caught() {
    // Some servers put the type only in the data JSON, without an `event:`
    // line — the same fallback path accumulate_anthropic_sse already uses
    // for content_block_delta must also catch this for errors.
    let raw = "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"partial\"}}\n\ndata: {\"type\":\"error\",\"error\":{\"type\":\"api_error\",\"message\":\"Internal error\"}}\n\n";
    let gateway = MockGateway::start_ordered(vec![Step::respond(
        Response::new(200, Body::Stream(vec![Frame::new(raw.as_bytes().to_vec())]))
            .with_header("content-type", "text/event-stream"),
    )])
    .await;
    let mut sink = |_: StreamDelta| {};
    let err = anthropic_client(&gateway)
        .complete_stream_cb(&user_turn("hi"), None, &mut sink, None)
        .await
        .expect_err("error type in data JSON without an event: line must still be caught");
    assert!(err.to_string().contains("Internal error"), "{err}");
}

// ---------------------------------------------------------------------------
// Slow chunks
// ---------------------------------------------------------------------------

#[tokio::test]
async fn slow_chunks_still_reassemble_into_the_full_answer() {
    let frames =
        vec![
        Frame::delayed(
            "data: {\"choices\":[{\"delta\":{\"content\":\"slow\"}}]}\n\n".as_bytes().to_vec(),
            Duration::from_millis(15),
        ),
        Frame::delayed(
            "data: {\"choices\":[{\"delta\":{\"content\":\" chunks\"}}]}\n\n".as_bytes().to_vec(),
            Duration::from_millis(15),
        ),
        Frame::delayed(
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n"
                .as_bytes()
                .to_vec(),
            Duration::from_millis(15),
        ),
    ];
    let gateway = MockGateway::start_ordered(vec![Step::respond(
        Response::new(200, Body::Stream(frames)).with_header("content-type", "text/event-stream"),
    )])
    .await;
    let mut sink = |_: StreamDelta| {};
    let completion = openai_client(&gateway)
        .complete_stream_cb(&user_turn("hi"), None, &mut sink, None)
        .await
        .expect("slow chunks must still complete");
    assert_eq!(completion.content, "slow chunks");
}

// ---------------------------------------------------------------------------
// Cancellation: before first token, after partial output, deadline during
// a stalled stream
// ---------------------------------------------------------------------------

#[tokio::test]
async fn cancellation_before_first_token_stops_immediately() {
    let gateway = MockGateway::start_ordered(vec![Step::respond(
        Response::new(200, Body::NeverEnds).with_header("content-type", "text/event-stream"),
    )])
    .await;
    let cancel = AtomicBool::new(true); // already cancelled before the call starts
    let mut sink = |_: StreamDelta| {};
    let err = openai_client(&gateway)
        .complete_stream_cb(&user_turn("hi"), None, &mut sink, Some(&cancel))
        .await
        .expect_err("pre-cancelled call must not stream anything");
    assert!(err.to_string().contains("cancelled"));
}

/// Real (raw-client) guarantee: `complete_stream_cb` checks the cancel flag
/// once per chunk boundary — before applying each newly arrived chunk — not
/// while blocked awaiting the *next* chunk. So the honest way to prove
/// "cancellation after partial output stops the stream" at this layer is:
/// let the first chunk apply (via the callback, which runs synchronously
/// inside the read loop), set cancel from inside that callback, and confirm
/// the second chunk — sent moments later — is never applied.
///
/// A genuinely indefinite mid-body stall (no further chunk ever arriving) is
/// a different, stronger guarantee that only the outer `tokio::select!` race
/// in `cd_core::agent::within_turn_deadline_with_cap` provides — proven at
/// that layer in the Phase 9 latency/cancellation matrix, not here.
#[tokio::test]
async fn cancellation_after_partial_output_stops_the_stream() {
    let first = "data: {\"choices\":[{\"delta\":{\"content\":\"first bit\"}}]}\n\n";
    let second = "data: {\"choices\":[{\"delta\":{\"content\":\"must not apply\"}}]}\n\ndata: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n";
    let gateway = MockGateway::start_ordered(vec![Step::respond(
        Response::new(
            200,
            Body::Stream(vec![
                Frame::new(first.as_bytes().to_vec()),
                // A short, bounded, deterministic delay — long enough that
                // the two writes land in separate reads on the client's
                // bytes_stream() instead of being coalesced by the kernel,
                // short enough to keep this test fast.
                Frame::delayed(second.as_bytes().to_vec(), Duration::from_millis(10)),
            ]),
        )
        .with_header("content-type", "text/event-stream"),
    )])
    .await;
    let cancel = Arc::new(AtomicBool::new(false));
    let cancel_from_sink = cancel.clone();
    let log = DeltaLog::default();
    let log_sink = log.clone();
    let mut sink = move |d: StreamDelta| {
        if let StreamDelta::Text(_) = &d {
            cancel_from_sink.store(true, Ordering::SeqCst);
        }
        log_sink.0.lock().unwrap().push(d);
    };
    let started = std::time::Instant::now();
    let err = openai_client(&gateway)
        .complete_stream_cb(&user_turn("hi"), None, &mut sink, Some(cancel.as_ref()))
        .await
        .expect_err(
            "cancellation observed after the first delta must stop before the next chunk applies",
        );
    assert!(err.to_string().contains("cancelled"));
    assert_eq!(
        log.texts(),
        "first bit",
        "the second chunk's content must never have been applied"
    );
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "cancellation must be prompt, took {:?}",
        started.elapsed()
    );
}

#[tokio::test(start_paused = true)]
async fn deadline_during_a_stalled_stream_eventually_times_out() {
    let gateway = MockGateway::start_ordered(vec![Step::respond(
        Response::new(200, Body::NeverEnds).with_header("content-type", "text/event-stream"),
    )])
    .await;
    let client = openai_client(&gateway);
    let call = tokio::spawn(async move {
        let mut sink = |_: StreamDelta| {};
        client
            .complete_stream_cb(&user_turn("hi"), None, &mut sink, None)
            .await
    });
    tokio::time::advance(Duration::from_secs(121)).await;
    let outcome = call.await.expect("join");
    assert!(
        outcome.is_err(),
        "a stalled stream must eventually time out, not hang forever"
    );
}
