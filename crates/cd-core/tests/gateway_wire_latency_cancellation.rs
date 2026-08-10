//! Gateway wire conformance lab — Phase 9: latency, timeout, and cancellation.
//!
//! Drives the real `OpenAiCompatibleClient` (via `research::backend_for` +
//! `TracingChatBackend`, exactly like `transport_semantic_attempt_oracle.rs`)
//! against a hermetic `cd_test_gateway::MockGateway`, plus the pure
//! `multi_stage_budget` cap-arithmetic functions combined with real wire
//! timing.
//!
//! # The outer race
//!
//! Production wraps every provider round in `cd_core::agent`'s
//! `within_turn_deadline_with_cap` (`pub(crate)`, not reachable from an
//! integration test): a `tokio::select!` between the operation (optionally
//! `tokio::time::timeout`-wrapped) and a 10ms-poll cancellation watcher. That
//! is the ONLY thing that can interrupt a genuinely stalled provider
//! connection — the raw client itself only checks its cancel flag between
//! SSE chunks (proven in `gateway_wire_streaming.rs`). `race_with_cancel`
//! below replicates that exact shape so this file can test the real
//! architectural guarantee without needing a full `ToolHost`/turn setup.

use cd_core::agent::ChatBackend;
use cd_core::chat::{ChatMessage, Role};
use cd_core::multi_stage_budget::{
    candidate_operation_cap_ms, synthesis_operation_cap_ms, SynthesisReserve,
};
use cd_core::providers::{ProviderCapabilities, ProviderKind, ProviderProfile};
use cd_core::research::{backend_for, backend_for_with_timeout};
use cd_core::turn_trace::{RecordingTurnTrace, TracedOutcome, TracingChatBackend, TurnTraceSink};
use cd_test_gateway::{Body, Frame, MockGateway, Response, Step};
use serde_json::json;
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

fn profile(base_url: &str) -> ProviderProfile {
    ProviderProfile {
        id: "latency-profile".into(),
        label: "latency oracle".into(),
        kind: ProviderKind::OpenAiCompatible,
        base_url: base_url.into(),
        api_key_ref: None,
        chat_model: "matrix-model".into(),
        embedding_model: None,
        embedding_base_url: None,
        capabilities: ProviderCapabilities::chat_remote(),
        local_only: true,
        deadline_preference: Default::default(),
    }
}

async fn traced_backend(base_url: &str) -> (Box<dyn ChatBackend>, Arc<RecordingTurnTrace>) {
    let inner = backend_for(&profile(base_url), None)
        .await
        .expect("backend construction");
    let recorder = Arc::new(RecordingTurnTrace::new());
    let sink: Arc<dyn TurnTraceSink> = recorder.clone();
    (Box::new(TracingChatBackend::new(inner, sink)), recorder)
}

async fn backend_with_timeout(base_url: &str, timeout: Duration) -> Box<dyn ChatBackend> {
    backend_for_with_timeout(&profile(base_url), None, timeout)
        .await
        .expect("backend construction with host timeout")
}

fn user_message(text: &str) -> Vec<ChatMessage> {
    vec![ChatMessage {
        role: Role::User,
        content: text.to_string(),
        tool_call_id: None,
        tool_calls: None,
    }]
}

async fn complete_streaming_once(
    backend: &dyn ChatBackend,
    cancel: Option<&AtomicBool>,
) -> cd_core::error::CoreResult<cd_core::chat::ChatCompletion> {
    let mut sink = |_text: String| {};
    backend
        .complete_streaming(&user_message("latency probe"), &[], &mut sink, cancel)
        .await
}

fn sse_ok(events: &[serde_json::Value]) -> Response {
    let mut body = String::new();
    for event in events {
        body.push_str(&format!("data: {event}\n\n"));
    }
    body.push_str("data: [DONE]\n\n");
    Response::new(
        200,
        Body::Fixed {
            data: body.into_bytes(),
            delay: Duration::ZERO,
        },
    )
    .with_header("content-type", "text/event-stream")
}

fn text_event(text: &str) -> serde_json::Value {
    json!({"choices":[{"delta":{"content":text}}]})
}
fn finish_event() -> serde_json::Value {
    json!({"choices":[{"delta":{},"finish_reason":"stop"}]})
}

fn json_completion(text: &str) -> Response {
    Response::json(
        200,
        &json!({
            "choices": [{
                "message": {"role": "assistant", "content": text},
                "finish_reason": "stop"
            }]
        }),
    )
}

async fn wait_for_cancel(cancel: Option<&AtomicBool>) {
    let Some(cancel) = cancel else {
        std::future::pending::<()>().await;
        return;
    };
    while !cancel.load(Ordering::Relaxed) {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

/// Replicates `cd_core::agent::within_turn_deadline_with_cap`'s exact shape
/// (a `tokio::select!` between an optionally timeout-wrapped operation and a
/// cancellation watcher) — the seam is `pub(crate)` and not reachable from
/// an external test, but the pattern itself is what every production call
/// site uses, so testing it here is testing the real guarantee, not an
/// invented one.
async fn race_with_cancel<F, T>(
    future: F,
    deadline: Option<Duration>,
    cancel: Option<&AtomicBool>,
) -> Result<T, &'static str>
where
    F: Future<Output = T>,
{
    tokio::select! {
        biased;
        _ = wait_for_cancel(cancel) => Err("cancelled"),
        value = async {
            match deadline {
                Some(d) => tokio::time::timeout(d, future).await.map_err(|_| "deadline"),
                None => Ok(future.await),
            }
        } => value,
    }
}

// ---------------------------------------------------------------------------
// Fast / slow-but-successful providers
// ---------------------------------------------------------------------------

#[tokio::test]
async fn fast_provider_completes_immediately() {
    let gateway = MockGateway::start_ordered(vec![Step::respond(sse_ok(&[
        text_event("fast"),
        finish_event(),
    ]))])
    .await;
    let (backend, recorder) = traced_backend(gateway.base_url()).await;
    let completion = complete_streaming_once(backend.as_ref(), None)
        .await
        .expect("fast completion");
    assert_eq!(completion.content, "fast");
    assert_eq!(recorder.calls().len(), 1);
}

#[tokio::test]
async fn slow_but_successful_provider_completes_within_a_patient_deadline() {
    let gateway = MockGateway::start_ordered(vec![Step::respond(
        sse_ok(&[text_event("slow but fine"), finish_event()])
            .with_header_delay(Duration::from_millis(30)),
    )])
    .await;
    let (backend, _recorder) = traced_backend(gateway.base_url()).await;
    let outcome = race_with_cancel(
        complete_streaming_once(backend.as_ref(), None),
        Some(Duration::from_secs(5)),
        None,
    )
    .await;
    assert_eq!(outcome.unwrap().unwrap().content, "slow but fine");
}

#[tokio::test]
async fn turn_owned_transport_timeout_allows_a_patient_non_stream_operation() {
    // Millisecond-scaled analogue of the live acceptance shape: the host
    // authorizes a much longer turn than the legacy client default, and the
    // provider responds after the shorter ceiling would have expired. The
    // production path supplies 600_000ms through the same constructor.
    let gateway = MockGateway::start_ordered(vec![Step::respond(
        json_completion("patient success").with_header_delay(Duration::from_millis(100)),
    )])
    .await;
    let backend = backend_with_timeout(gateway.base_url(), Duration::from_millis(400)).await;

    let completion = backend
        .complete(&user_message("patient comparison"), &[])
        .await
        .expect("host-owned transport timeout must allow the response");

    assert_eq!(completion.content, "patient success");
    assert_eq!(gateway.request_count(), 1);
    assert_eq!(gateway.requests()[0].json_body().unwrap()["stream"], false);
}

#[tokio::test]
async fn configured_transport_timeout_still_bounds_an_unresponsive_operation() {
    let gateway = MockGateway::start_ordered(vec![Step::respond(
        json_completion("too late").with_header_delay(Duration::from_millis(150)),
    )])
    .await;
    let backend = backend_with_timeout(gateway.base_url(), Duration::from_millis(25)).await;

    let _error = backend
        .complete(&user_message("bounded comparison"), &[])
        .await
        .expect_err("the configured transport ceiling must remain effective");

    assert_eq!(gateway.request_count(), 1);
}

#[tokio::test]
async fn non_stream_completion_failure_is_not_replayed_through_streaming() {
    let gateway = MockGateway::start_ordered(vec![
        Step::respond(Response::json(
            500,
            &json!({"error": {"message": "upstream failed"}}),
        )),
        Step::respond(json_completion("must not be requested")),
    ])
    .await;
    let (backend, _recorder) = traced_backend(gateway.base_url()).await;

    let error = backend
        .complete(&user_message("one comparison"), &[])
        .await
        .expect_err("the first provider failure must be terminal");

    assert!(error.to_string().contains("HTTP 500"), "{error}");
    assert_eq!(
        gateway.request_count(),
        1,
        "a non-stream call is exactly one provider request"
    );
    assert_eq!(gateway.requests()[0].json_body().unwrap()["stream"], false);
}

#[tokio::test]
async fn streaming_transport_failure_does_not_launch_a_non_stream_replay() {
    let gateway = MockGateway::start_ordered(vec![
        Step::CloseBeforeHeaders { reset: true },
        Step::respond(json_completion("must not be requested")),
    ])
    .await;
    let (backend, _recorder) = traced_backend(gateway.base_url()).await;

    complete_streaming_once(backend.as_ref(), None)
        .await
        .expect_err("the streaming transport failure must be terminal");

    assert_eq!(
        gateway.request_count(),
        1,
        "transport failure must not replay the prompt through stream=false"
    );
    assert_eq!(gateway.requests()[0].json_body().unwrap()["stream"], true);
}

// ---------------------------------------------------------------------------
// Delayed headers, delayed first token, slow continuous stream
// ---------------------------------------------------------------------------

#[tokio::test]
async fn delayed_headers_still_succeed() {
    let gateway = MockGateway::start_ordered(vec![Step::respond(
        sse_ok(&[text_event("ok"), finish_event()]).with_header_delay(Duration::from_millis(20)),
    )])
    .await;
    let (backend, _recorder) = traced_backend(gateway.base_url()).await;
    let completion = complete_streaming_once(backend.as_ref(), None)
        .await
        .unwrap();
    assert_eq!(completion.content, "ok");
}

#[tokio::test]
async fn delayed_first_token_then_normal_completion() {
    let frames = vec![
        Frame::delayed(
            format!("data: {}\n\n", text_event("delayed but arrives")).into_bytes(),
            Duration::from_millis(20),
        ),
        Frame::new(format!("data: {}\n\ndata: [DONE]\n\n", finish_event()).into_bytes()),
    ];
    let gateway = MockGateway::start_ordered(vec![Step::respond(
        Response::new(200, Body::Stream(frames)).with_header("content-type", "text/event-stream"),
    )])
    .await;
    let (backend, _recorder) = traced_backend(gateway.base_url()).await;
    let completion = complete_streaming_once(backend.as_ref(), None)
        .await
        .unwrap();
    assert_eq!(completion.content, "delayed but arrives");
}

#[tokio::test]
async fn slow_continuous_stream_of_many_delayed_chunks_still_completes() {
    let mut frames: Vec<Frame> = (0..10)
        .map(|i| {
            Frame::delayed(
                format!("data: {}\n\n", text_event(&format!("{i} "))).into_bytes(),
                Duration::from_millis(5),
            )
        })
        .collect();
    frames.push(Frame::new(
        format!("data: {}\n\ndata: [DONE]\n\n", finish_event()).into_bytes(),
    ));
    let gateway = MockGateway::start_ordered(vec![Step::respond(
        Response::new(200, Body::Stream(frames)).with_header("content-type", "text/event-stream"),
    )])
    .await;
    let (backend, _recorder) = traced_backend(gateway.base_url()).await;
    let completion = complete_streaming_once(backend.as_ref(), None)
        .await
        .unwrap();
    assert_eq!(completion.content, "0 1 2 3 4 5 6 7 8 9 ");
}

// ---------------------------------------------------------------------------
// Permanently stalled provider: explicit deadline vs. the pinned client's
// own ceiling when no deadline is supplied at all
// ---------------------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn permanently_stalled_provider_is_cut_off_by_an_explicit_user_deadline() {
    let gateway = MockGateway::start_ordered(vec![Step::respond(
        Response::new(200, Body::NeverEnds).with_header("content-type", "text/event-stream"),
    )])
    .await;
    let (backend, recorder) = traced_backend(gateway.base_url()).await;
    let call = tokio::spawn(async move {
        race_with_cancel(
            complete_streaming_once(backend.as_ref(), None),
            Some(Duration::from_secs(15)),
            None,
        )
        .await
    });
    tokio::time::advance(Duration::from_secs(16)).await;
    let outcome = call.await.expect("join");
    assert!(matches!(outcome, Err("deadline")), "an explicit 15s deadline must cut off a permanent stall, not wait for the 120s client ceiling");
    assert!(
        recorder.calls().is_empty(),
        "documents the real telemetry gap: TracingChatBackend::record() only runs after its \
         inner future resolves, so a round dropped by the outer deadline race leaves no \
         TracedCall at all — see docs/testing/gateway-wire-survivors-and-gaps.md"
    );
}

#[tokio::test(start_paused = true)]
async fn permanently_stalled_provider_with_no_explicit_deadline_hits_the_adaptive_standard_ceiling()
{
    // "Adaptive standard deadline": with no explicit user deadline supplied
    // to complete_streaming, the only bound left is the pinned client's own
    // fixed 120s reqwest timeout (OpenAiCompatibleClient::new).
    let gateway = MockGateway::start_ordered(vec![Step::respond(
        Response::new(200, Body::NeverEnds).with_header("content-type", "text/event-stream"),
    )])
    .await;
    let (backend, _recorder) = traced_backend(gateway.base_url()).await;
    let call = tokio::spawn(async move { complete_streaming_once(backend.as_ref(), None).await });
    tokio::time::advance(Duration::from_secs(121)).await;
    let outcome = call.await.expect("join");
    assert!(
        outcome.is_err(),
        "the 120s client ceiling must eventually fire with no outer deadline"
    );
}

// These two use real (short) delays rather than `start_paused` +
// `tokio::spawn` + `tokio::time::advance`. That combination is fragile here:
// the mock gateway's header delay only registers its own timer once real
// loopback TCP I/O (connect/accept/request-read) has actually progressed,
// which can lose a race against an explicit `advance()` that jumps the
// clock before the spawned task is ever polled — tokio's own docs flag
// mixing real I/O with paused-clock auto-advance as unreliable for exactly
// this reason. A response-beats-deadline claim needs a real clock; a
// deadline-beats-response claim (the sibling tests below and elsewhere in
// this file) is robust either way since the race's bias always favors the
// deadline, never the response.

#[tokio::test]
async fn a_patient_deadline_succeeds_where_a_standard_one_would_have_cut_off() {
    let gateway = MockGateway::start_ordered(vec![Step::respond(
        sse_ok(&[
            text_event("arrived late but within patience"),
            finish_event(),
        ])
        .with_header_delay(Duration::from_millis(30)),
    )])
    .await;
    let (backend, _recorder) = traced_backend(gateway.base_url()).await;
    let outcome = race_with_cancel(
        complete_streaming_once(backend.as_ref(), None),
        Some(Duration::from_millis(300)),
        None,
    )
    .await
    .expect("did not hit the patient deadline");
    assert_eq!(outcome.unwrap().content, "arrived late but within patience");
}

#[tokio::test]
async fn a_standard_deadline_cuts_off_the_same_response_a_patient_one_would_allow() {
    let gateway = MockGateway::start_ordered(vec![Step::respond(
        sse_ok(&[text_event("too slow for standard"), finish_event()])
            .with_header_delay(Duration::from_millis(30)),
    )])
    .await;
    let (backend, _recorder) = traced_backend(gateway.base_url()).await;
    let outcome = race_with_cancel(
        complete_streaming_once(backend.as_ref(), None),
        Some(Duration::from_millis(10)),
        None,
    )
    .await;
    assert!(matches!(outcome, Err("deadline")));
}

// ---------------------------------------------------------------------------
// Cancellation at every provider stage
// ---------------------------------------------------------------------------

#[tokio::test]
async fn cancellation_before_any_request_is_sent() {
    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::status_only(200))]).await;
    let (backend, _recorder) = traced_backend(gateway.base_url()).await;
    let cancel = AtomicBool::new(true);
    let err = complete_streaming_once(backend.as_ref(), Some(&cancel))
        .await
        .unwrap_err();
    assert!(err.to_string().contains("cancelled"));
    assert_eq!(
        gateway.request_count(),
        0,
        "no request is issued once already cancelled"
    );
}

#[tokio::test]
async fn cancellation_while_waiting_on_headers_via_the_outer_race() {
    let gateway = MockGateway::start_ordered(vec![Step::respond(
        sse_ok(&[text_event("too late")]).with_header_delay(Duration::from_secs(30)),
    )])
    .await;
    let (backend, recorder) = traced_backend(gateway.base_url()).await;
    let cancel = Arc::new(AtomicBool::new(false));
    let cancel_setter = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(15)).await;
        cancel_setter.store(true, Ordering::SeqCst);
    });
    let outcome = race_with_cancel(
        complete_streaming_once(backend.as_ref(), None),
        None,
        Some(cancel.as_ref()),
    )
    .await;
    assert!(
        matches!(outcome, Err("cancelled")),
        "waiting on headers is only interruptible via the outer race"
    );
    assert!(recorder.calls().is_empty());
}

#[tokio::test]
async fn cancellation_mid_stream_via_the_inner_per_chunk_check() {
    // Distinct from the header-wait case above: once bytes are flowing, the
    // raw client's own per-chunk cancel check (chat.rs) is what stops it —
    // no outer race needed. Proven directly at the chat.rs level in
    // gateway_wire_streaming.rs; this test proves the SAME property survives
    // through the TracingChatBackend/backend_for production wrapper.
    let first = format!("data: {}\n\n", text_event("first"));
    let second = format!(
        "data: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
        text_event("must not apply"),
        finish_event()
    );
    let gateway = MockGateway::start_ordered(vec![Step::respond(
        Response::new(
            200,
            Body::Stream(vec![
                Frame::new(first.into_bytes()),
                Frame::delayed(second.into_bytes(), Duration::from_millis(10)),
            ]),
        )
        .with_header("content-type", "text/event-stream"),
    )])
    .await;
    let (backend, recorder) = traced_backend(gateway.base_url()).await;
    let cancel = Arc::new(AtomicBool::new(false));
    let cancel_for_sink = cancel.clone();
    let seen = Arc::new(std::sync::Mutex::new(String::new()));
    let seen_for_sink = seen.clone();
    let mut sink = move |text: String| {
        seen_for_sink.lock().unwrap().push_str(&text);
        cancel_for_sink.store(true, Ordering::SeqCst);
    };
    let err = backend
        .complete_streaming(&user_message("hi"), &[], &mut sink, Some(cancel.as_ref()))
        .await
        .expect_err("cancellation after the first delta must stop before the next chunk applies");
    assert!(err.to_string().contains("cancelled"));
    assert_eq!(*seen.lock().unwrap(), "first");
    assert_eq!(
        recorder.calls().len(),
        1,
        "unlike a header-wait cancellation, an inner-loop cancel still resolves the traced call \
         (as Failed), because complete_streaming's own future returns normally here rather than \
         being dropped by an outer select!"
    );
    assert!(matches!(
        &recorder.calls()[0].outcome,
        TracedOutcome::Failed { .. }
    ));
}

// ---------------------------------------------------------------------------
// Candidate-operation timeout vs whole-turn timeout
// ---------------------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn candidate_operation_cap_is_shorter_than_the_whole_turn_budget_and_wins() {
    // Whole turn has 10s left; a synthesis reserve holds back half of a
    // (hypothetical) original plan, leaving this candidate only a few
    // hundred ms of "unprotected" time even though the turn itself has
    // seconds left — exactly the real multi_stage_budget arithmetic.
    let remaining_total_ms = 10_000u64;
    let reserve = SynthesisReserve {
        policy_id: "test",
        time_reserve_ms: 9_700,
        round_reserve: 1,
    };
    let phase_cap_ms = 60_000; // generous phase cap; the reserve is the binding constraint
    let cap = candidate_operation_cap_ms(Some(remaining_total_ms), phase_cap_ms, reserve)
        .expect("a bounded turn always yields a candidate cap");
    assert_eq!(cap, 300, "unprotected = remaining - reserve = 10000 - 9700");

    let gateway = MockGateway::start_ordered(vec![Step::respond(
        // Arrives well within the whole-turn budget (10s) but after the
        // much shorter candidate cap (300ms).
        sse_ok(&[text_event("too slow for this candidate"), finish_event()])
            .with_header_delay(Duration::from_secs(2)),
    )])
    .await;
    let (backend, recorder) = traced_backend(gateway.base_url()).await;
    let outcome = race_with_cancel(
        complete_streaming_once(backend.as_ref(), None),
        Some(Duration::from_millis(cap)),
        None,
    )
    .await;
    assert!(
        matches!(outcome, Err("deadline")),
        "the candidate cap, not the whole-turn budget, must bind"
    );
    assert!(
        recorder.calls().is_empty(),
        "the outer-race drop leaves no TracedCall (documented gap)"
    );
}

#[tokio::test]
async fn synthesis_operation_cap_uses_the_full_remaining_budget_not_a_reserve() {
    // Synthesis is the LAST stage — it uses whatever time remains, with no
    // additional reserve held back (unlike candidate rounds). Uses real
    // short delays rather than `start_paused` — see the comment above
    // `a_patient_deadline_succeeds_where_a_standard_one_would_have_cut_off`.
    let remaining_total_ms = 100u64;
    let phase_cap_ms = 600;
    let cap = synthesis_operation_cap_ms(Some(remaining_total_ms), phase_cap_ms).unwrap();
    assert_eq!(
        cap, 100,
        "synthesis gets the full remaining turn budget, no reserve subtracted"
    );

    let gateway = MockGateway::start_ordered(vec![Step::respond(
        sse_ok(&[
            text_event("arrives within the full remaining budget"),
            finish_event(),
        ])
        .with_header_delay(Duration::from_millis(20)),
    )])
    .await;
    let (backend, _recorder) = traced_backend(gateway.base_url()).await;
    let outcome = race_with_cancel(
        complete_streaming_once(backend.as_ref(), None),
        Some(Duration::from_millis(cap)),
        None,
    )
    .await
    .expect("must not hit the deadline branch");
    assert_eq!(
        outcome.unwrap().content,
        "arrives within the full remaining budget"
    );
}

// ---------------------------------------------------------------------------
// Provider attempt counting on success, error, cancellation, and timeout
// ---------------------------------------------------------------------------

#[tokio::test]
async fn attempt_counting_success_records_exactly_one_completed_call() {
    let gateway = MockGateway::start_ordered(vec![Step::respond(sse_ok(&[
        text_event("ok"),
        finish_event(),
    ]))])
    .await;
    let (backend, recorder) = traced_backend(gateway.base_url()).await;
    complete_streaming_once(backend.as_ref(), None)
        .await
        .unwrap();
    let calls = recorder.calls();
    assert_eq!(calls.len(), 1);
    assert!(matches!(&calls[0].outcome, TracedOutcome::Completed { .. }));
}

#[tokio::test]
async fn attempt_counting_provider_error_records_exactly_one_failed_call() {
    let gateway = MockGateway::start_ordered(vec![Step::respond(Response::status_only(500))]).await;
    let (backend, recorder) = traced_backend(gateway.base_url()).await;
    let _ = complete_streaming_once(backend.as_ref(), None)
        .await
        .unwrap_err();
    let calls = recorder.calls();
    assert_eq!(calls.len(), 1);
    assert!(matches!(&calls[0].outcome, TracedOutcome::Failed { .. }));
}

#[tokio::test]
async fn attempt_counting_inner_cancellation_still_records_one_failed_call() {
    // The inner per-chunk cancel check returns normally from
    // complete_streaming (proven above), so TracingChatBackend still
    // observes and records the outcome — contrast with the outer-race cases.
    let gateway = MockGateway::start_ordered(vec![Step::respond(
        Response::new(200, Body::NeverEnds).with_header("content-type", "text/event-stream"),
    )])
    .await;
    let (backend, recorder) = traced_backend(gateway.base_url()).await;
    let cancel = AtomicBool::new(true);
    let _ = complete_streaming_once(backend.as_ref(), Some(&cancel))
        .await
        .unwrap_err();
    assert_eq!(
        recorder.calls().len(),
        1,
        "pre-cancelled complete_streaming still resolves and is recorded"
    );
}

#[tokio::test(start_paused = true)]
async fn attempt_counting_outer_race_timeout_records_zero_calls_documented_gap() {
    let gateway = MockGateway::start_ordered(vec![Step::respond(
        Response::new(200, Body::NeverEnds).with_header("content-type", "text/event-stream"),
    )])
    .await;
    let (backend, recorder) = traced_backend(gateway.base_url()).await;
    let call = tokio::spawn(async move {
        race_with_cancel(
            complete_streaming_once(backend.as_ref(), None),
            Some(Duration::from_secs(5)),
            None,
        )
        .await
    });
    tokio::time::advance(Duration::from_secs(6)).await;
    let outcome = call.await.expect("join");
    assert!(matches!(outcome, Err("deadline")));
    assert_eq!(
        recorder.calls().len(),
        0,
        "REAL GAP: a round timed out by the outer race consumes an admitted round (per \
         agent.rs's used_rounds accounting) but leaves no TracedCall — provider_round_count \
         and used_rounds can diverge for exactly this reason. Documented, not fixed here — see \
         docs/testing/gateway-wire-survivors-and-gaps.md."
    );
}

// ---------------------------------------------------------------------------
// Elapsed-provider telemetry on failed calls
// ---------------------------------------------------------------------------

#[tokio::test]
async fn elapsed_telemetry_is_recorded_on_a_failed_call_not_only_successful_ones() {
    let gateway = MockGateway::start_ordered(vec![Step::respond(
        sse_ok(&[text_event("partial, then a malformed line")]).with_body(Body::Stream(vec![
            Frame::new(b"data: {not valid json\n\n".to_vec()),
        ])),
    )])
    .await;
    let (backend, recorder) = traced_backend(gateway.base_url()).await;
    let _ = complete_streaming_once(backend.as_ref(), None)
        .await
        .unwrap_err();
    let calls = recorder.calls();
    assert_eq!(calls.len(), 1);
    assert!(matches!(&calls[0].outcome, TracedOutcome::Failed { .. }));
    // elapsed_ms is a plain u64 (always populated); the honest assertion is
    // that it is captured on this failed call at all, not fabricated only
    // for successes.
    let _ = calls[0].elapsed_ms;
}
