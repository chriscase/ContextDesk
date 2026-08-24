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
use cd_core::providers::{ProviderCapabilities, ProviderKind, ProviderProfile};
use cd_core::research::backend_for;
use cd_core::ssrf::SsrfPolicy;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, Request, Respond, ResponseTemplate};

const JSON_COMPLETION: &str = r#"{"choices":[{"message":{"role":"assistant","content":"recovered"},"finish_reason":"stop"}]}"#;

#[derive(Clone, Copy)]
struct SequenceResponse {
    status: u16,
    body: &'static str,
    retry_after: Option<&'static str>,
}

struct SequenceResponder {
    calls: Arc<AtomicUsize>,
    responses: Vec<SequenceResponse>,
}

impl Respond for SequenceResponder {
    fn respond(&self, _request: &Request) -> ResponseTemplate {
        let index = self.calls.fetch_add(1, Ordering::SeqCst);
        let response = self
            .responses
            .get(index)
            .copied()
            .unwrap_or_else(|| *self.responses.last().expect("non-empty response sequence"));
        let mut template = ResponseTemplate::new(response.status).set_body_string(response.body);
        if let Some(retry_after) = response.retry_after {
            template = template.insert_header("retry-after", retry_after);
        }
        if response.status == 200 {
            template = template.insert_header("content-type", "application/json");
        }
        template
    }
}

fn client(base_url: &str) -> OpenAiCompatibleClient {
    OpenAiCompatibleClient::new(base_url, None, "matrix-test-model", &SsrfPolicy::default())
        .expect("client construction")
}

fn openai_profile(base_url: &str) -> ProviderProfile {
    ProviderProfile {
        id: "matrix-openai-compatible".into(),
        label: "matrix OpenAI-compatible".into(),
        kind: ProviderKind::OpenAiCompatible,
        base_url: base_url.into(),
        api_key_ref: None,
        chat_model: "matrix-test-model".into(),
        embedding_model: None,
        embedding_base_url: None,
        capabilities: ProviderCapabilities::chat_remote(),
        local_only: true,
        deadline_preference: Default::default(),
    }
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

async fn mount_sequence(server: &MockServer, responses: Vec<SequenceResponse>) -> Arc<AtomicUsize> {
    let calls = Arc::new(AtomicUsize::new(0));
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(SequenceResponder {
            calls: calls.clone(),
            responses,
        })
        .mount(server)
        .await;
    calls
}

/// Bounded HTTP 429 recovery is shared by buffered, streamed, and callback
/// completion paths. Retry-After: 0 keeps this hermetic test instantaneous.
#[tokio::test]
async fn rate_limit_recovers_across_all_openai_completion_paths() {
    for path_kind in ["complete", "stream", "callback"] {
        let server = MockServer::start().await;
        let calls = mount_sequence(
            &server,
            vec![
                SequenceResponse {
                    status: 429,
                    body: "synthetic rate limit",
                    retry_after: Some("0"),
                },
                SequenceResponse {
                    status: 200,
                    body: JSON_COMPLETION,
                    retry_after: None,
                },
            ],
        )
        .await;
        let completion = match path_kind {
            "complete" => {
                client(&server.uri())
                    .complete(&one_user_message("hi"), None)
                    .await
            }
            "stream" => {
                client(&server.uri())
                    .complete_stream(&one_user_message("hi"), None)
                    .await
            }
            "callback" => {
                client(&server.uri())
                    .complete_stream_cb(&one_user_message("hi"), None, |_| {}, None)
                    .await
            }
            _ => unreachable!("fixed path-kind fixture"),
        }
        .expect("429 followed by success must recover");
        assert_eq!(completion.content, "recovered", "path={path_kind}");
        assert_eq!(calls.load(Ordering::SeqCst), 2, "path={path_kind}");
    }
}

#[tokio::test]
async fn repeated_429_exhaustion_preserves_final_error_body() {
    let server = MockServer::start().await;
    let calls = mount_sequence(
        &server,
        vec![SequenceResponse {
            status: 429,
            body: "synthetic final rate-limit body",
            retry_after: Some("0"),
        }],
    )
    .await;
    let error = client(&server.uri())
        .complete(&one_user_message("hi"), None)
        .await
        .expect_err("persistent 429 must fail after the bounded retry budget");
    assert!(error.to_string().contains("HTTP 429"));
    assert!(error
        .to_string()
        .contains("synthetic final rate-limit body"));
    assert_eq!(
        calls.load(Ordering::SeqCst),
        3,
        "initial request plus two retries"
    );
}

#[tokio::test]
async fn non_429_client_error_is_not_retried_and_preserves_body() {
    let server = MockServer::start().await;
    let calls = mount_sequence(
        &server,
        vec![SequenceResponse {
            status: 400,
            body: "synthetic invalid request body",
            retry_after: None,
        }],
    )
    .await;
    let error = client(&server.uri())
        .complete_stream(&one_user_message("hi"), None)
        .await
        .expect_err("non-429 4xx must return immediately");
    assert!(error.to_string().contains("HTTP 400"));
    assert!(error.to_string().contains("synthetic invalid request body"));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn exhausted_streaming_429_does_not_trigger_a_second_non_stream_retry_budget() {
    let server = MockServer::start().await;
    let calls = mount_sequence(
        &server,
        vec![SequenceResponse {
            status: 429,
            body: "synthetic terminal rate limit",
            retry_after: Some("0"),
        }],
    )
    .await;
    let backend = backend_for(&openai_profile(&server.uri()), None)
        .await
        .expect("build local mock backend");
    let mut on_text = |_text: String| {};
    let error = backend
        .complete_streaming(&one_user_message("hi"), &[], &mut on_text, None)
        .await
        .expect_err("exhausted 429 remains terminal instead of falling back");
    assert!(error.to_string().contains("HTTP 429"));
    assert_eq!(
        calls.load(Ordering::SeqCst),
        3,
        "the OpenAI backend must not replay an exhausted streaming 429 as non-stream"
    );
}

#[tokio::test]
async fn callback_retry_wait_observes_cancellation() {
    let server = MockServer::start().await;
    let calls = mount_sequence(
        &server,
        vec![SequenceResponse {
            status: 429,
            body: "synthetic rate limit",
            retry_after: Some("1"),
        }],
    )
    .await;
    let cancel = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let client = client(&server.uri());
    let cancel_for_task = cancel.clone();
    let task = tokio::spawn(async move {
        client
            .complete_stream_cb(
                &one_user_message("hi"),
                None,
                |_| {},
                Some(cancel_for_task.as_ref()),
            )
            .await
    });
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    cancel.store(true, Ordering::SeqCst);
    let error = task
        .await
        .expect("retry task joins")
        .expect_err("cancellation must interrupt callback retry wait");
    assert_eq!(error.to_string(), "cancelled");
    assert_eq!(calls.load(Ordering::SeqCst), 1);
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

use cd_core::agent::ChatBackend;
use cd_core::events::StreamEvent;
use cd_core::provider_telemetry::ObservedRoute;
use cd_core::turn_trace::{RecordingTurnTrace, TracingChatBackend};

fn client_with_secret(base_url: &str) -> OpenAiCompatibleClient {
    OpenAiCompatibleClient::new(
        base_url,
        Some("sk-secret-must-never-leak".into()),
        "configured-model-id",
        &SsrfPolicy::default(),
    )
    .expect("client construction")
}

/// Non-streaming Vercel-shaped usage: cost, reasoning, cached, response model,
/// finish reason, and a safe request id — without treating configured model
/// as observed route.
#[tokio::test]
async fn non_streaming_vercel_shaped_usage_and_safe_request_id() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "application/json")
                .insert_header("x-request-id", "hdr-req-1")
                .insert_header("authorization", "Bearer should-not-capture")
                .set_body_raw(
                    serde_json::json!({
                        "id": "chatcmpl-vercel-1",
                        "model": "anthropic/claude-sonnet-4",
                        "choices": [{
                            "message": { "role": "assistant", "content": "ok" },
                            "finish_reason": "stop"
                        }],
                        "usage": {
                            "prompt_tokens": 11,
                            "completion_tokens": 22,
                            "total_tokens": 33,
                            "cost": 0.00123,
                            "completion_tokens_details": { "reasoning_tokens": 9 },
                            "prompt_tokens_details": { "cached_tokens": 5 }
                        },
                        "providerMetadata": {
                            "gateway": {
                                "routing": { "finalProvider": "anthropic" }
                            }
                        }
                    })
                    .to_string(),
                    "application/json",
                ),
        )
        .mount(&server)
        .await;

    let completion = client_with_secret(&server.uri())
        .complete(&one_user_message("hi"), None)
        .await
        .unwrap();
    assert_eq!(completion.content, "ok");
    assert_eq!(completion.finish_reason, "stop");
    let tel = &completion.telemetry;
    assert_eq!(
        tel.certified_response_model(),
        Some("anthropic/claude-sonnet-4")
    );
    assert_eq!(
        tel.provider_request_id.as_deref(),
        Some("chatcmpl-vercel-1")
    );
    assert_eq!(
        tel.observed_route,
        ObservedRoute::Reported {
            value: "anthropic".into()
        }
    );
    assert_eq!(tel.prompt_tokens, Some(11));
    assert_eq!(tel.completion_tokens, Some(22));
    assert_eq!(tel.reasoning_tokens, Some(9));
    assert_eq!(tel.cached_tokens, Some(5));
    assert_eq!(tel.total_tokens, Some(33));
    assert_eq!(tel.cost, Some(0.00123));
    let dumped = format!("{tel:?}");
    assert!(!dumped.contains("sk-secret"));
    assert!(!dumped.contains("should-not-capture"));
}

/// Streaming path with a final usage-bearing chunk.
#[tokio::test]
async fn streaming_captures_final_usage_chunk() {
    let server = MockServer::start().await;
    mount_sse(
        &server,
        "data: {\"id\":\"chatcmpl-stream-1\",\"model\":\"openai/gpt-test\",\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n\
         data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n\
         data: {\"id\":\"chatcmpl-stream-1\",\"model\":\"openai/gpt-test\",\"choices\":[],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":1,\"total_tokens\":4,\"cost\":0.0}}\n\n\
         data: [DONE]\n\n",
    )
    .await;

    let completion = client(&server.uri())
        .complete_stream_cb(&one_user_message("hi"), None, |_| {}, None)
        .await
        .unwrap();
    assert_eq!(completion.content, "hi");
    assert_eq!(completion.finish_reason, "stop");
    assert_eq!(completion.telemetry.prompt_tokens, Some(3));
    assert_eq!(completion.telemetry.completion_tokens, Some(1));
    assert_eq!(completion.telemetry.total_tokens, Some(4));
    assert_eq!(completion.telemetry.cost, Some(0.0));
    assert_eq!(
        completion.telemetry.certified_response_model(),
        Some("openai/gpt-test")
    );
    assert_eq!(completion.telemetry.observed_route, ObservedRoute::Unknown);
}

/// Reasoning consumes the whole completion allowance: empty visible text + length.
#[tokio::test]
async fn reasoning_fills_completion_empty_visible_length_finish() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "application/json")
                .set_body_raw(
                    serde_json::json!({
                        "id": "chatcmpl-len-1",
                        "model": "openai/o1-test",
                        "choices": [{
                            "message": { "role": "assistant", "content": "" },
                            "finish_reason": "length"
                        }],
                        "usage": {
                            "prompt_tokens": 100,
                            "completion_tokens": 500,
                            "total_tokens": 600,
                            "completion_tokens_details": { "reasoning_tokens": 500 }
                        }
                    })
                    .to_string(),
                    "application/json",
                ),
        )
        .mount(&server)
        .await;

    let completion = client(&server.uri())
        .complete(&one_user_message("think hard"), None)
        .await
        .unwrap();
    assert!(completion.content.trim().is_empty());
    assert_eq!(completion.finish_reason, "length");
    assert_eq!(completion.telemetry.reasoning_tokens, Some(500));
    assert!(cd_core::provider_telemetry::visible_answer_empty(
        &completion.content
    ));
    assert!(cd_core::provider_telemetry::finish_reason_is_length(
        &completion.finish_reason
    ));
}

/// DeepSeek/Qwen-style reasoning fields remain out of visible answer text,
/// while the host records only a bounded channel length for diagnosis.
#[tokio::test]
async fn separate_reasoning_channel_does_not_leak_into_visible_answer() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "application/json")
                .set_body_raw(
                    serde_json::json!({
                        "id": "chatcmpl-reasoning-channel",
                        "model": "deepseek/deepseek-v4-flash",
                        "choices": [{
                            "message": {
                                "role": "assistant",
                                "reasoning_content": "internal chain of thought",
                                "content": "visible answer"
                            },
                            "finish_reason": "stop"
                        }]
                    })
                    .to_string(),
                    "application/json",
                ),
        )
        .mount(&server)
        .await;

    let completion = client(&server.uri())
        .complete(&one_user_message("answer"), None)
        .await
        .unwrap();
    assert_eq!(completion.content, "visible answer");
    assert_eq!(completion.finish_reason, "stop");
    assert_eq!(
        completion.telemetry.reasoning_content_chars,
        Some("internal chain of thought".chars().count() as u64)
    );
    assert!(!completion.content.contains("internal chain"));
}

#[tokio::test]
async fn streamed_reasoning_channel_is_counted_without_visible_leakage() {
    let server = MockServer::start().await;
    mount_sse(
        &server,
        "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"internal \"}}]}\n\n\
         data: {\"choices\":[{\"delta\":{\"content\":\"visible\"}}]}\n\n\
         data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n\
         data: [DONE]\n\n",
    )
    .await;

    let completion = client(&server.uri())
        .complete_stream(&one_user_message("answer"), None)
        .await
        .unwrap();
    assert_eq!(completion.content, "visible");
    assert_eq!(completion.finish_reason, "stop");
    assert_eq!(
        completion.telemetry.reasoning_content_chars,
        Some("internal ".chars().count() as u64)
    );
}

/// Missing usage / route / cost stay explicitly unknown.
#[tokio::test]
async fn missing_metadata_stays_unknown_not_inferred_from_configured_model() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "application/json")
                .set_body_raw(
                    serde_json::json!({
                        "choices": [{
                            "message": { "role": "assistant", "content": "plain" },
                            "finish_reason": "stop"
                        }]
                    })
                    .to_string(),
                    "application/json",
                ),
        )
        .mount(&server)
        .await;

    let completion = client_with_secret(&server.uri())
        .complete(&one_user_message("hi"), None)
        .await
        .unwrap();
    let tel = &completion.telemetry;
    assert!(tel.response_model.is_none());
    assert!(tel.provider_request_id.is_none());
    assert_eq!(tel.observed_route, ObservedRoute::Unknown);
    assert!(tel.prompt_tokens.is_none());
    assert!(tel.cost.is_none());
}

/// Secrets injected into auth never appear in traced transport DTOs / EventDto.
#[tokio::test]
async fn secrets_never_appear_in_traced_transport_dto() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "application/json")
                .insert_header("set-cookie", "session=evil")
                .set_body_raw(
                    serde_json::json!({
                        "id": "chatcmpl-safe",
                        "choices": [{
                            "message": { "role": "assistant", "content": "hi" },
                            "finish_reason": "stop"
                        }],
                        "usage": { "prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2 }
                    })
                    .to_string(),
                    "application/json",
                ),
        )
        .mount(&server)
        .await;

    let recorder = Arc::new(RecordingTurnTrace::new());
    let inner = client_with_secret(&server.uri());
    struct Adapter(OpenAiCompatibleClient);
    #[async_trait::async_trait]
    impl ChatBackend for Adapter {
        async fn complete(
            &self,
            messages: &[cd_core::chat::ChatMessage],
            tools: &[cd_core::tools::ToolSpec],
        ) -> cd_core::error::CoreResult<cd_core::chat::ChatCompletion> {
            let tools = if tools.is_empty() { None } else { Some(tools) };
            self.0.complete(messages, tools).await
        }
    }
    let backend = TracingChatBackend::new(Box::new(Adapter(inner)), recorder.clone());
    let _ = backend
        .complete(&one_user_message("hi"), &[])
        .await
        .unwrap();
    let calls = recorder.calls();
    assert_eq!(calls.len(), 1);
    let json = serde_json::to_string(&calls[0]).unwrap();
    assert!(!json.contains("sk-secret"));
    assert!(!json.contains("session=evil"));
    assert_eq!(
        calls[0].transport.provider_request_id.as_deref(),
        Some("chatcmpl-safe")
    );

    // Shared DTO projection path used by Tauri (event_to_dto).
    let turn_transport = calls[0].transport.clone();
    let event = StreamEvent::ProviderTelemetry {
        telemetry: Box::new(cd_core::provider_telemetry::ProviderTurnTelemetry {
            configured_profile_id: "openai-compatible".into(),
            configured_model: "configured-model-id".into(),
            response_model: turn_transport
                .certified_response_model()
                .map(str::to_string),
            model_identity_status: turn_transport.model_identity_status(),
            provider_request_id: turn_transport.provider_request_id.clone(),
            observed_route: turn_transport.observed_route.clone(),
            prompt_tokens: turn_transport.prompt_tokens,
            completion_tokens: turn_transport.completion_tokens,
            reasoning_tokens: turn_transport.reasoning_tokens,
            reasoning_content_chars: turn_transport.reasoning_content_chars,
            cached_tokens: turn_transport.cached_tokens,
            total_tokens: turn_transport.total_tokens,
            cost: turn_transport.cost,
            context_budget: None,
            provider_round_count: 1,
            application_retry_reasons: vec![],
            final_turn_outcome: Some("stop".into()),
            finish_reason: Some("stop".into()),
            empty_visible_answer: false,
            truncated_by_length: false,
            tool_call_count: 0,
            latency_ms: Some(calls[0].elapsed_ms),
            rounds: vec![],
        }),
    };
    let dto = cd_core::research::event_to_dto(&event);
    assert_eq!(dto.kind, "provider_telemetry");
    let dumped = dto.payload.to_string();
    assert!(!dumped.contains("sk-secret"));
    assert!(!dumped.contains("session=evil"));
    assert_eq!(
        dto.payload.get("configuredModel").and_then(|v| v.as_str()),
        Some("configured-model-id")
    );
    assert_eq!(
        dto.payload
            .get("observedRoute")
            .and_then(|v| v.get("status"))
            .and_then(|v| v.as_str()),
        Some("unknown")
    );
}
