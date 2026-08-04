//! Deterministic mock-provider compatibility matrix for
//! `cd_core::chat::OpenAiCompatibleClient` — the wire-protocol boundary
//! `cd_workflow`'s `ChatWorkflow` and every CLI `chat` command sit behind.
//! Every case here drives a REAL HTTP round trip (through the same
//! SSRF-pinned `reqwest::Client` construction production code uses, against
//! a local `wiremock` server) rather than calling a parsing function in
//! isolation — the parsing-function-level matrix (chunk-boundary UTF-8
//! safety, bounded-memory line length) lives in `cd_core::chat`'s own
//! `#[cfg(test)]` module, since those specific cases need byte-exact
//! control over chunk boundaries that a real TCP connection cannot
//! guarantee deterministically.
//!
//! No external network access, no credentials, no private fixtures —
//! `wiremock::MockServer` binds to an ephemeral loopback port.

use cd_core::chat::{ChatMessage, OpenAiCompatibleClient, Role, StreamDelta};
use cd_core::ssrf::SsrfPolicy;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn client(base_url: &str) -> OpenAiCompatibleClient {
    OpenAiCompatibleClient::new(base_url, None, "matrix-test-model", &SsrfPolicy::default())
        .expect("client construction")
}

fn one_user_message(text: &str) -> Vec<ChatMessage> {
    vec![ChatMessage {
        role: Role::User,
        content: text.to_string(),
        tool_call_id: None,
        tool_calls: None,
    }]
}

async fn mount_sse(server: &MockServer, body: &str) {
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_raw(body.to_string(), "text/event-stream"),
        )
        .mount(server)
        .await;
}

/// Baseline: an ordinary conformant SSE stream produces the expected text.
#[tokio::test]
async fn ordinary_streaming_sse_response() {
    let server = MockServer::start().await;
    mount_sse(
        &server,
        "data: {\"choices\":[{\"delta\":{\"content\":\"hello \"}}]}\n\n\
         data: {\"choices\":[{\"delta\":{\"content\":\"world\"}}]}\n\n\
         data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n\
         data: [DONE]\n\n",
    )
    .await;

    let completion = client(&server.uri())
        .complete_stream_cb(&one_user_message("hi"), None, |_| {}, None)
        .await
        .unwrap();
    assert_eq!(completion.content, "hello world");
    assert_eq!(completion.finish_reason, "stop");
}

/// CRLF line endings — some gateways behind a proxy normalize to `\r\n`.
#[tokio::test]
async fn crlf_line_endings_parse_identically_to_lf() {
    let server = MockServer::start().await;
    mount_sse(
        &server,
        "data: {\"choices\":[{\"delta\":{\"content\":\"crlf ok\"}}]}\r\n\r\n\
         data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\r\n\r\n\
         data: [DONE]\r\n\r\n",
    )
    .await;

    let completion = client(&server.uri())
        .complete_stream_cb(&one_user_message("hi"), None, |_| {}, None)
        .await
        .unwrap();
    assert_eq!(completion.content, "crlf ok");
}

/// SSE comment lines (`:` prefix, used for keep-alive) and blank lines
/// between events must be skipped, not misparsed as data.
#[tokio::test]
async fn comment_lines_and_blank_lines_are_skipped() {
    let server = MockServer::start().await;
    mount_sse(
        &server,
        ": keep-alive\n\n\
         data: {\"choices\":[{\"delta\":{\"content\":\"after keepalive\"}}]}\n\n\
         \n\
         : another comment\n\
         data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n\
         data: [DONE]\n\n",
    )
    .await;

    let completion = client(&server.uri())
        .complete_stream_cb(&one_user_message("hi"), None, |_| {}, None)
        .await
        .unwrap();
    assert_eq!(completion.content, "after keepalive");
}

/// Multi-byte UTF-8 content over a real HTTP response body — correctness,
/// not the chunk-boundary-splitting case (covered deterministically at the
/// `cd_core::chat` unit level, since real TCP can't be forced to split at a
/// byte-exact offset).
#[tokio::test]
async fn multi_byte_utf8_content_round_trips_intact() {
    let server = MockServer::start().await;
    mount_sse(
        &server,
        "data: {\"choices\":[{\"delta\":{\"content\":\"caf\u{e9} \u{1f389} \u{65e5}\u{672c}\u{8a9e}\"}}]}\n\n\
         data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n\
         data: [DONE]\n\n",
    )
    .await;

    let completion = client(&server.uri())
        .complete_stream_cb(&one_user_message("hi"), None, |_| {}, None)
        .await
        .unwrap();
    assert_eq!(completion.content, "café 🎉 日本語");
}

/// A delta that carries both narration content and a tool call in the SAME
/// event — the class of gateway behavior that used to silently drop the
/// content.
#[tokio::test]
async fn content_and_tool_call_together_are_both_delivered_live_and_accumulated() {
    let server = MockServer::start().await;
    mount_sse(
        &server,
        "data: {\"choices\":[{\"delta\":{\"content\":\"checking logs\",\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"search_logs\",\"arguments\":\"{}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n\
         data: [DONE]\n\n",
    )
    .await;

    let mut live_deltas = Vec::new();
    let completion = client(&server.uri())
        .complete_stream_cb(&one_user_message("hi"), None, |d| live_deltas.push(d), None)
        .await
        .unwrap();

    assert_eq!(completion.content, "checking logs");
    assert_eq!(completion.tool_calls.len(), 1);
    assert_eq!(completion.tool_calls[0].function.name, "search_logs");
    assert_eq!(completion.finish_reason, "tool_calls");
    assert!(
        live_deltas
            .iter()
            .any(|d| matches!(d, StreamDelta::Text(t) if t == "checking logs")),
        "the live on_delta callback must see the narration text too, not just the tool call: {live_deltas:?}"
    );
}

/// Multiple parallel tool calls in one delta.
#[tokio::test]
async fn multiple_parallel_tool_calls_in_one_delta() {
    let server = MockServer::start().await;
    mount_sse(
        &server,
        "data: {\"choices\":[{\"delta\":{\"tool_calls\":[\
            {\"index\":0,\"id\":\"call_a\",\"function\":{\"name\":\"search_logs\",\"arguments\":\"{\\\"query\\\":\\\"a\\\"}\"}},\
            {\"index\":1,\"id\":\"call_b\",\"function\":{\"name\":\"search_logs\",\"arguments\":\"{\\\"query\\\":\\\"b\\\"}\"}}\
         ]},\"finish_reason\":\"tool_calls\"}]}\n\n\
         data: [DONE]\n\n",
    )
    .await;

    let completion = client(&server.uri())
        .complete_stream_cb(&one_user_message("hi"), None, |_| {}, None)
        .await
        .unwrap();
    assert_eq!(completion.tool_calls.len(), 2);
    assert_eq!(completion.tool_calls[0].id, "call_a");
    assert_eq!(completion.tool_calls[1].id, "call_b");
}

/// Tool-call arguments fragmented across several delta events for the same
/// index must reassemble into one valid JSON argument string.
#[tokio::test]
async fn fragmented_tool_call_arguments_reassemble_across_events() {
    let server = MockServer::start().await;
    mount_sse(
        &server,
        "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"search_logs\",\"arguments\":\"{\\\"qu\"}}]}}]}\n\n\
         data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"ery\\\":\\\"time\"}}]}}]}\n\n\
         data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"out\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n\
         data: [DONE]\n\n",
    )
    .await;

    let completion = client(&server.uri())
        .complete_stream_cb(&one_user_message("hi"), None, |_| {}, None)
        .await
        .unwrap();
    assert_eq!(completion.tool_calls.len(), 1);
    let args: serde_json::Value =
        serde_json::from_str(&completion.tool_calls[0].function.arguments).unwrap();
    assert_eq!(args["query"], "timeout");
}

/// A gateway that omits tool-call ids entirely gets deterministic synthetic
/// ones rather than a panic or an empty id downstream tool dispatch would
/// reject.
#[tokio::test]
async fn missing_tool_call_ids_get_synthesized() {
    let server = MockServer::start().await;
    mount_sse(
        &server,
        "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"name\":\"search_logs\",\"arguments\":\"{}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n\
         data: [DONE]\n\n",
    )
    .await;

    let completion = client(&server.uri())
        .complete_stream_cb(&one_user_message("hi"), None, |_| {}, None)
        .await
        .unwrap();
    assert_eq!(completion.tool_calls.len(), 1);
    assert!(!completion.tool_calls[0].id.is_empty());
}

/// A `finish_reason` combined with content (rather than the conformant
/// separate terminal event) must still be reported honestly — a truncated
/// ("length") response must not silently read as an ordinary "stop".
#[tokio::test]
async fn finish_reason_combined_with_content_is_not_lost_or_defaulted() {
    let server = MockServer::start().await;
    mount_sse(
        &server,
        "data: {\"choices\":[{\"delta\":{\"content\":\" (truncated)\"},\"finish_reason\":\"length\"}]}\n\n\
         data: [DONE]\n\n",
    )
    .await;

    let completion = client(&server.uri())
        .complete_stream_cb(&one_user_message("hi"), None, |_| {}, None)
        .await
        .unwrap();
    assert_eq!(completion.content, " (truncated)");
    assert_eq!(completion.finish_reason, "length");
}

/// A vLLM-style capability rejection (tool_choice=auto unsupported) must
/// surface its HTTP body text unchanged, verbatim — `cd_core::agent`'s
/// `is_tools_unsupported_error` string-matches this exact wording to decide
/// whether to retry without tools; if the client ever stopped forwarding
/// the body, that detection would silently break.
#[tokio::test]
async fn vllm_tool_choice_rejection_body_is_forwarded_verbatim() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(ResponseTemplate::new(400).set_body_string(
            r#"{"object":"error","message":"\"auto\" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set","type":"BadRequestError"}"#,
        ))
        .mount(&server)
        .await;

    let error = client(&server.uri())
        .complete_stream_cb(&one_user_message("hi"), None, |_| {}, None)
        .await
        .unwrap_err();
    assert!(
        cd_core::agent::is_tools_unsupported_error(&error),
        "{error}"
    );
}

/// A malformed (non-JSON) `data:` payload mid-stream must fail the whole
/// call, not silently continue past corrupted data.
#[tokio::test]
async fn malformed_data_line_mid_stream_fails_the_whole_call() {
    let server = MockServer::start().await;
    mount_sse(
        &server,
        "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n\
         data: {this is not valid json\n\n\
         data: [DONE]\n\n",
    )
    .await;

    let error = client(&server.uri())
        .complete_stream_cb(&one_user_message("hi"), None, |_| {}, None)
        .await
        .unwrap_err();
    assert!(error.to_string().contains("sse json"));
}

/// A well-formed in-band SSE error object aborts the call with its message,
/// distinct from a malformed-JSON parse failure.
#[tokio::test]
async fn in_band_sse_error_object_aborts_with_its_message() {
    let server = MockServer::start().await;
    mount_sse(
        &server,
        "data: {\"error\":{\"message\":\"model overloaded, try again\"}}\n\n",
    )
    .await;

    let error = client(&server.uri())
        .complete_stream_cb(&one_user_message("hi"), None, |_| {}, None)
        .await
        .unwrap_err();
    assert!(error.to_string().contains("model overloaded"));
}

/// A plain HTTP 500 with no SSE framing at all.
#[tokio::test]
async fn http_500_with_no_body_is_a_clean_error_not_a_panic() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(ResponseTemplate::new(500))
        .mount(&server)
        .await;

    let error = client(&server.uri())
        .complete_stream_cb(&one_user_message("hi"), None, |_| {}, None)
        .await
        .unwrap_err();
    assert!(error.to_string().contains("500"));
}

/// Cooperative cancellation: a `cancel` flag already set before the call
/// starts must abort promptly without ever completing a "successful" turn.
#[tokio::test]
async fn a_pre_set_cancel_flag_aborts_the_stream() {
    let server = MockServer::start().await;
    mount_sse(
        &server,
        "data: {\"choices\":[{\"delta\":{\"content\":\"should not finish\"}}]}\n\n\
         data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n\
         data: [DONE]\n\n",
    )
    .await;

    let cancel = std::sync::atomic::AtomicBool::new(true);
    let error = client(&server.uri())
        .complete_stream_cb(&one_user_message("hi"), None, |_| {}, Some(&cancel))
        .await
        .unwrap_err();
    assert!(error.to_string().contains("cancelled"));
}

/// A gateway that ignores `stream=true` and returns one ordinary JSON
/// completion body — the non-SSE fallback — must decode multi-byte UTF-8
/// content correctly. The byte-exact chunk-boundary-splitting case for this
/// same fallback is covered deterministically at the `cd_core::sse` unit
/// level (`BoundedBodyAccumulator`'s own tests), since real TCP can't be
/// forced to split at a byte-exact offset; this proves the REAL
/// `complete_stream_cb` production path gets the content right end to end.
#[tokio::test]
async fn non_sse_json_fallback_decodes_multi_byte_utf8_content_correctly() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "application/json")
                .set_body_raw(
                    "{\"choices\":[{\"finish_reason\":\"stop\",\"message\":{\"role\":\"assistant\",\"content\":\"caf\u{e9} \u{1f389} \u{65e5}\u{672c}\u{8a9e}\"}}]}".to_string(),
                    "application/json",
                ),
        )
        .mount(&server)
        .await;

    let completion = client(&server.uri())
        .complete_stream_cb(&one_user_message("hi"), None, |_| {}, None)
        .await
        .unwrap();
    assert_eq!(completion.content, "café 🎉 日本語");
}

/// Some enterprise proxies strip or replace the upstream content type. A
/// complete JSON response must still take the bounded whole-body fallback,
/// while preserving the same live delta contract as the explicit
/// `application/json` fast path (including tool call and terminal state).
#[tokio::test]
async fn non_sse_json_without_a_json_content_type_preserves_the_full_completion() {
    let server = MockServer::start().await;
    let body = r#"{"choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","content":"checking","tool_calls":[{"id":"call_1","type":"function","function":{"name":"search_logs","arguments":"{}"}}]}}]}"#;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(ResponseTemplate::new(200).set_body_string(body))
        .mount(&server)
        .await;

    let mut live = Vec::new();
    let completion = client(&server.uri())
        .complete_stream_cb(
            &one_user_message("hi"),
            None,
            |delta| live.push(delta),
            None,
        )
        .await
        .unwrap();

    assert_eq!(completion.content, "checking");
    assert_eq!(completion.tool_calls.len(), 1);
    assert_eq!(completion.tool_calls[0].function.name, "search_logs");
    assert_eq!(completion.finish_reason, "tool_calls");
    assert!(matches!(live.first(), Some(StreamDelta::Text(text)) if text == "checking"));
    assert!(live.iter().any(
        |delta| matches!(delta, StreamDelta::ToolCall { name: Some(name), .. } if name == "search_logs")
    ));
    assert!(live
        .iter()
        .any(|delta| matches!(delta, StreamDelta::Finish(reason) if reason == "tool_calls")));
    assert!(matches!(live.last(), Some(StreamDelta::Done)));
}

/// The same no-content-type fallback is finite: a proxy cannot make the
/// client retain an arbitrarily large ordinary body while it waits to decide
/// whether the response was SSE or JSON.
#[tokio::test]
async fn oversized_non_sse_body_without_a_content_type_fails_closed() {
    let server = MockServer::start().await;
    let body = vec![b'x'; cd_core::sse::DEFAULT_MAX_BUFFERED_LINE_BYTES + 1];
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(body))
        .mount(&server)
        .await;

    let error = client(&server.uri())
        .complete_stream_cb(&one_user_message("hi"), None, |_| {}, None)
        .await
        .unwrap_err();
    assert!(error.to_string().contains("exceeded"), "{error}");
}

/// Genuinely invalid UTF-8 (not a chunk-boundary artifact — this is the
/// whole, complete SSE line, delivered as one HTTP response body) must fail
/// closed rather than silently becoming replacement characters.
#[tokio::test]
async fn invalid_utf8_in_an_sse_line_fails_closed_not_lossy() {
    let server = MockServer::start().await;
    let mut body = b"data: {\"choices\":[{\"delta\":{\"content\":\"".to_vec();
    body.extend_from_slice(&[0xFF, 0xFE]); // never valid UTF-8
    body.extend_from_slice(b"\"}}]}\n\ndata: [DONE]\n\n");
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_raw(body, "text/event-stream"),
        )
        .mount(&server)
        .await;

    let error = client(&server.uri())
        .complete_stream_cb(&one_user_message("hi"), None, |_| {}, None)
        .await
        .unwrap_err();
    assert!(error.to_string().contains("not valid UTF-8"), "{error}");
}

/// The non-SSE fallback body must fail closed on invalid UTF-8 too, not
/// just the line-oriented SSE path.
#[tokio::test]
async fn invalid_utf8_in_a_non_sse_body_fails_closed_not_lossy() {
    let server = MockServer::start().await;
    let mut body = b"{\"choices\":[{\"message\":{\"content\":\"".to_vec();
    body.extend_from_slice(&[0xFF, 0xFE]);
    body.extend_from_slice(b"\"}}]}");
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "application/json")
                .set_body_raw(body, "application/json"),
        )
        .mount(&server)
        .await;

    let error = client(&server.uri())
        .complete_stream_cb(&one_user_message("hi"), None, |_| {}, None)
        .await
        .unwrap_err();
    assert!(error.to_string().contains("not valid UTF-8"), "{error}");
}

/// A connection that closes (or a gateway that simply stops writing) mid
/// JSON object, with no trailing newline after the incomplete `data:` line
/// — the truncated-mid-object case. The trailing bytes ARE valid UTF-8 (this
/// is testing JSON truncation specifically, not the UTF-8 guarantee above),
/// so the flush path's attempt to parse it as JSON must fail cleanly rather
/// than panic or silently drop the truncated event.
#[tokio::test]
async fn truncated_mid_json_object_with_no_trailing_newline_fails_cleanly() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_raw(
                    "data: {\"choices\":[{\"delta\":{\"content\":\"complete first\"}}]}\n\n\
                     data: {\"choices\":[{\"delta\":{\"content\":\"cut off mid-obje"
                        .to_string(),
                    "text/event-stream",
                ),
        )
        .mount(&server)
        .await;

    let mut live_texts = Vec::new();
    let error = client(&server.uri())
        .complete_stream_cb(
            &one_user_message("hi"),
            None,
            |d| {
                if let StreamDelta::Text(t) = d {
                    live_texts.push(t);
                }
            },
            None,
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains("sse json"), "{error}");
    assert_eq!(
        live_texts,
        vec!["complete first".to_string()],
        "the complete event before the truncation must still have been delivered live"
    );
}

/// The same truncation, but for the non-SSE whole-body fallback: a plain
/// JSON completion response that is simply cut off before the closing
/// brace. Must fail with a clean parse error, not a panic.
#[tokio::test]
async fn truncated_non_sse_json_body_fails_cleanly() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "application/json")
                .set_body_raw(
                    "{\"choices\":[{\"message\":{\"content\":\"cut off",
                    "application/json",
                ),
        )
        .mount(&server)
        .await;

    let error = client(&server.uri())
        .complete_stream_cb(&one_user_message("hi"), None, |_| {}, None)
        .await
        .unwrap_err();
    assert!(!error.to_string().is_empty());
}
