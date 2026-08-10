//! Transport-retry vs semantic-attempt acceptance oracle — wire seam.
//!
//! Complements `openai_compatible_provider_matrix.rs` (wire-protocol
//! compatibility) and `cd-workflow/tests/transport_semantic_attempt_oracle.rs`
//! (turn-kernel classification) by binding the REAL production transport
//! (`OpenAiCompatibleClient::post_completion_with_429_retry` under
//! `research::backend_for` + `TracingChatBackend`) to the semantic-attempt
//! ledger (`TracedCall`) and to the only place transport attempts, rate-limit
//! waits, delays, and delay sources are observable at base: the
//! `target: "cd_core::chat"` tracing events.
//!
//! Faults wiremock cannot inject deterministically (TCP RST before headers,
//! a never-responding socket, byte-exact chunk splits inside a multi-byte
//! UTF-8 character) come from a raw in-test `tokio::net::TcpListener`.
//!
//! Timing discipline: recovering 429s use `Retry-After: 0`; parked backoffs
//! use `Retry-After: 60` and are interrupted by cancellation within
//! milliseconds; the read-timeout case runs under `start_paused` against a
//! socket that never produces IO, so auto-advance is deterministic. No test
//! sleeps for a product-visible duration.

use cd_core::agent::ChatBackend;
use cd_core::providers::{ProviderCapabilities, ProviderKind, ProviderProfile};
use cd_core::research::backend_for;
use cd_core::ssrf::SsrfPolicy;
use cd_core::turn_trace::{RecordingTurnTrace, TracedOutcome, TracingChatBackend, TurnTraceSink};
use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, Request, Respond, ResponseTemplate};

const SSE_HELLO: &str = "data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}\n\n\
     data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n\
     data: [DONE]\n\n";

const SSE_EMPTY_STOP: &str = "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n\
     data: [DONE]\n\n";

const SSE_LENGTH: &str = "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n\
     data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"length\"}]}\n\n\
     data: [DONE]\n\n";

const SSE_MALFORMED_DATA_LINE: &str =
    "data: {\"choices\":[{\"delta\":{\"content\":\"good\"}}]}\n\n\
     data: {not json at all\n\n\
     data: [DONE]\n\n";

const JSON_HELLO: &str =
    r#"{"choices":[{"message":{"role":"assistant","content":"hello"},"finish_reason":"stop"}]}"#;

// ---------------------------------------------------------------------------
// tracing capture — the only seam where transport attempts / delays exist.
// Hand-rolled (no tracing-subscriber dependency): collects every event whose
// target starts with `cd_core::chat` on the current thread.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct CapturedTraceEvent {
    message: String,
    fields: BTreeMap<String, String>,
}

impl CapturedTraceEvent {
    fn field(&self, name: &str) -> Option<&str> {
        self.fields.get(name).map(String::as_str)
    }
}

#[derive(Default)]
struct ChatTraceCapture {
    events: Mutex<Vec<CapturedTraceEvent>>,
}

struct FieldVisitor {
    message: String,
    fields: BTreeMap<String, String>,
}

impl tracing::field::Visit for FieldVisitor {
    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
        if field.name() == "message" {
            let _ = write!(self.message, "{value:?}");
        } else {
            self.fields
                .insert(field.name().to_string(), format!("{value:?}"));
        }
    }

    fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
        if field.name() == "message" {
            self.message.push_str(value);
        } else {
            self.fields
                .insert(field.name().to_string(), value.to_string());
        }
    }

    fn record_u64(&mut self, field: &tracing::field::Field, value: u64) {
        self.fields
            .insert(field.name().to_string(), value.to_string());
    }

    fn record_i64(&mut self, field: &tracing::field::Field, value: i64) {
        self.fields
            .insert(field.name().to_string(), value.to_string());
    }

    fn record_bool(&mut self, field: &tracing::field::Field, value: bool) {
        self.fields
            .insert(field.name().to_string(), value.to_string());
    }
}

/// Local newtype so the foreign `tracing::Subscriber` trait can be
/// implemented (orphan rule) while tests keep a shared `Arc` handle.
struct CaptureHandle(Arc<ChatTraceCapture>);

impl tracing::Subscriber for CaptureHandle {
    fn enabled(&self, metadata: &tracing::Metadata<'_>) -> bool {
        metadata.target().starts_with("cd_core::chat")
    }

    fn new_span(&self, _span: &tracing::span::Attributes<'_>) -> tracing::span::Id {
        tracing::span::Id::from_u64(1)
    }

    fn record(&self, _span: &tracing::span::Id, _values: &tracing::span::Record<'_>) {}

    fn record_follows_from(&self, _span: &tracing::span::Id, _follows: &tracing::span::Id) {}

    fn event(&self, event: &tracing::Event<'_>) {
        let mut visitor = FieldVisitor {
            message: String::new(),
            fields: BTreeMap::new(),
        };
        event.record(&mut visitor);
        self.0
            .events
            .lock()
            .expect("capture lock")
            .push(CapturedTraceEvent {
                message: visitor.message,
                fields: visitor.fields,
            });
    }

    fn enter(&self, _span: &tracing::span::Id) {}

    fn exit(&self, _span: &tracing::span::Id) {}
}

impl ChatTraceCapture {
    fn install() -> (Arc<Self>, tracing::subscriber::DefaultGuard) {
        let capture = Arc::new(Self::default());
        let guard = tracing::subscriber::set_default(CaptureHandle(capture.clone()));
        (capture, guard)
    }

    fn events(&self) -> Vec<CapturedTraceEvent> {
        self.events.lock().expect("capture lock").clone()
    }

    fn waits(&self) -> Vec<CapturedTraceEvent> {
        self.events()
            .into_iter()
            .filter(|e| {
                e.message
                    .contains("waiting due to provider rate limit before retry")
            })
            .collect()
    }

    fn recoveries(&self) -> usize {
        self.events()
            .iter()
            .filter(|e| e.message.contains("provider rate limit recovered"))
            .count()
    }

    fn exhaustions(&self) -> Vec<CapturedTraceEvent> {
        self.events()
            .into_iter()
            .filter(|e| e.message.contains("provider rate limit exhausted"))
            .collect()
    }
}

// ---------------------------------------------------------------------------
// wiremock scripting (status/Retry-After sequences)
// ---------------------------------------------------------------------------

#[derive(Clone, Copy)]
struct WireStep {
    status: u16,
    body: &'static str,
    content_type: &'static str,
    retry_after: Option<&'static str>,
}

const RATE_LIMITED_NO_HEADER: WireStep = WireStep {
    status: 429,
    body: r#"{"error":{"message":"provider rate limited"}}"#,
    content_type: "application/json",
    retry_after: None,
};

fn rate_limited(retry_after: &'static str) -> WireStep {
    WireStep {
        retry_after: Some(retry_after),
        ..RATE_LIMITED_NO_HEADER
    }
}

fn sse_ok(body: &'static str) -> WireStep {
    WireStep {
        status: 200,
        body,
        content_type: "text/event-stream",
        retry_after: None,
    }
}

fn json_ok(body: &'static str) -> WireStep {
    WireStep {
        status: 200,
        body,
        content_type: "application/json",
        retry_after: None,
    }
}

struct SequenceResponder {
    calls: Arc<AtomicUsize>,
    steps: Vec<WireStep>,
}

impl Respond for SequenceResponder {
    fn respond(&self, _request: &Request) -> ResponseTemplate {
        let index = self.calls.fetch_add(1, Ordering::SeqCst);
        let step = self
            .steps
            .get(index)
            .copied()
            .unwrap_or_else(|| *self.steps.last().expect("non-empty script"));
        let mut template = ResponseTemplate::new(step.status)
            .insert_header("content-type", step.content_type)
            .set_body_raw(step.body, step.content_type);
        if let Some(retry_after) = step.retry_after {
            template = template.insert_header("retry-after", retry_after);
        }
        template
    }
}

async fn mount_steps(server: &MockServer, steps: Vec<WireStep>) -> Arc<AtomicUsize> {
    let calls = Arc::new(AtomicUsize::new(0));
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(SequenceResponder {
            calls: calls.clone(),
            steps,
        })
        .mount(server)
        .await;
    calls
}

fn oracle_profile(base_url: &str) -> ProviderProfile {
    ProviderProfile {
        id: "oracle-openai-compatible".into(),
        label: "oracle OpenAI-compatible".into(),
        kind: ProviderKind::OpenAiCompatible,
        base_url: base_url.into(),
        api_key_ref: None,
        chat_model: "oracle-test-model".into(),
        embedding_model: None,
        embedding_base_url: None,
        capabilities: ProviderCapabilities::chat_remote(),
        local_only: true,
        deadline_preference: Default::default(),
    }
}

/// The exact production stack `run_turn` drives: `backend_for` (one declared
/// protocol request per operation) wrapped in `TracingChatBackend` recording
/// one `TracedCall` per semantic attempt.
async fn traced_backend(base_url: &str) -> (Box<dyn ChatBackend>, Arc<RecordingTurnTrace>) {
    let inner = backend_for(&oracle_profile(base_url), None)
        .await
        .expect("backend construction");
    let recorder = Arc::new(RecordingTurnTrace::new());
    let sink: Arc<dyn TurnTraceSink> = recorder.clone();
    (Box::new(TracingChatBackend::new(inner, sink)), recorder)
}

fn user_message(text: &str) -> Vec<cd_core::chat::ChatMessage> {
    vec![cd_core::chat::ChatMessage {
        role: cd_core::chat::Role::User,
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
        .complete_streaming(&user_message("oracle probe"), &[], &mut sink, cancel)
        .await
}

/// Flip `cancel` as soon as the wire has served `n` responses — the only
/// deterministic way to cancel *inside* transport backoff.
fn cancel_after_calls(calls: Arc<AtomicUsize>, n: usize, cancel: Arc<AtomicBool>) {
    tokio::spawn(async move {
        for _ in 0..5_000 {
            if calls.load(Ordering::SeqCst) >= n {
                cancel.store(true, Ordering::SeqCst);
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(2)).await;
        }
        cancel.store(true, Ordering::SeqCst);
    });
}

// ---------------------------------------------------------------------------
// Raw TCP fault server — connection-level faults wiremock cannot script.
// ---------------------------------------------------------------------------

enum RawConn {
    /// Read the request, then RST the connection before any response bytes.
    ResetBeforeHeaders,
    /// Read the request, then hold the socket open forever (read timeout).
    NeverRespond,
    /// Read the request, then serve a JSON completion and close.
    Json(&'static str),
    /// Read the request, then serve an SSE body split into exact chunked
    /// frames (chunk boundaries may fall inside a multi-byte UTF-8 char).
    SseChunks(Vec<&'static [u8]>),
}

async fn read_http_request(stream: &mut tokio::net::TcpStream) -> Vec<u8> {
    let mut buffer = Vec::new();
    let mut byte = [0u8; 1024];
    loop {
        let Ok(n) = stream.read(&mut byte).await else {
            return buffer;
        };
        if n == 0 {
            return buffer;
        }
        buffer.extend_from_slice(&byte[..n]);
        if let Some(headers_end) = buffer.windows(4).position(|w| w == b"\r\n\r\n") {
            let headers = String::from_utf8_lossy(&buffer[..headers_end]).to_ascii_lowercase();
            let content_length = headers
                .lines()
                .find_map(|line| line.strip_prefix("content-length:"))
                .and_then(|value| value.trim().parse::<usize>().ok())
                .unwrap_or(0);
            if buffer.len() >= headers_end + 4 + content_length {
                return buffer;
            }
        }
    }
}

/// Serve `script` connections in order on an ephemeral loopback port.
/// Returns the base URL and a counter of accepted connections.
fn raw_fault_server(script: Vec<RawConn>) -> (String, Arc<AtomicUsize>) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind loopback");
    listener.set_nonblocking(true).expect("nonblocking");
    let port = listener.local_addr().expect("addr").port();
    let accepted = Arc::new(AtomicUsize::new(0));
    let accepted_clone = accepted.clone();
    tokio::spawn(async move {
        let listener = tokio::net::TcpListener::from_std(listener).expect("tokio listener");
        // Sockets parked by NeverRespond stay alive here for the test's life.
        let mut parked = Vec::new();
        for conn in script {
            let Ok((mut stream, _)) = listener.accept().await else {
                return;
            };
            accepted_clone.fetch_add(1, Ordering::SeqCst);
            let _request = read_http_request(&mut stream).await;
            match conn {
                RawConn::ResetBeforeHeaders => {
                    // SO_LINGER(0) turns close into an RST — a genuine
                    // connection reset before any response bytes exist.
                    // Deprecated because linger can block on drop; with a
                    // zero timeout it aborts instead, which is the point.
                    #[allow(deprecated)]
                    let _ = stream.set_linger(Some(std::time::Duration::ZERO));
                    drop(stream);
                }
                RawConn::NeverRespond => {
                    parked.push(stream);
                }
                RawConn::Json(body) => {
                    let response = format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    );
                    let _ = stream.write_all(response.as_bytes()).await;
                    let _ = stream.flush().await;
                }
                RawConn::SseChunks(chunks) => {
                    let _ = stream
                        .write_all(
                            b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\nconnection: close\r\n\r\n",
                        )
                        .await;
                    for chunk in chunks {
                        let frame = format!("{:x}\r\n", chunk.len());
                        let _ = stream.write_all(frame.as_bytes()).await;
                        let _ = stream.write_all(chunk).await;
                        let _ = stream.write_all(b"\r\n").await;
                        let _ = stream.flush().await;
                        // Force distinct TCP segments so the client decoder
                        // genuinely sees the split.
                        tokio::task::yield_now().await;
                    }
                    let _ = stream.write_all(b"0\r\n\r\n").await;
                    let _ = stream.flush().await;
                }
            }
        }
        // Keep parked sockets (and the listener) alive until the runtime ends.
        if !parked.is_empty() {
            std::future::pending::<()>().await;
        }
    });
    (format!("http://127.0.0.1:{port}"), accepted)
}

// ---------------------------------------------------------------------------
// Scenario 1 — two 429s then success. Three transport attempts, ONE recorded
// semantic attempt, one accepted completion; every backoff wait is traced
// with its delay and source (mutation "sleeping without trace telemetry"
// fails the waits==retries equality; mutation "semantic attempts before HTTP
// success" fails the calls().len()==1 assertion).
// ---------------------------------------------------------------------------
#[tokio::test]
async fn two_429s_then_success_is_three_transport_attempts_inside_one_semantic_attempt() {
    let (capture, _guard) = ChatTraceCapture::install();
    let server = MockServer::start().await;
    let wire_calls = mount_steps(
        &server,
        vec![rate_limited("0"), rate_limited("0"), sse_ok(SSE_HELLO)],
    )
    .await;

    let (backend, recorder) = traced_backend(&server.uri()).await;
    let completion = complete_streaming_once(backend.as_ref(), None)
        .await
        .expect("bounded 429 recovery");

    assert_eq!(completion.content, "hello");
    assert_eq!(
        wire_calls.load(Ordering::SeqCst),
        3,
        "three transport attempts"
    );

    let calls = recorder.calls();
    assert_eq!(
        calls.len(),
        1,
        "exactly one semantic attempt is recorded no matter how many transport attempts ran"
    );
    assert!(matches!(
        &calls[0].outcome,
        TracedOutcome::Completed { finish_reason, .. } if finish_reason == "stop"
    ));

    let waits = capture.waits();
    assert_eq!(
        waits.len(),
        2,
        "every transport retry wait must emit exactly one traced wait record"
    );
    for wait in &waits {
        assert_eq!(wait.field("delay_ms"), Some("0"));
        assert_eq!(wait.field("delay_source"), Some("retry_after"));
        assert_eq!(wait.field("http_status"), Some("429"));
    }
    assert_eq!(
        waits[0].field("attempt"),
        Some("2"),
        "the first wait precedes transport attempt 2"
    );
    assert_eq!(waits[1].field("attempt"), Some("3"));
    assert_eq!(capture.recoveries(), 1, "recovery is traced once");
    assert!(capture.exhaustions().is_empty());
}

// ---------------------------------------------------------------------------
// Scenario 2 — 429 exhaustion at the transport seam: one FAILED semantic
// attempt (nothing evaluable was consumed), an explicit rate-limit error
// that never borrows analysis vocabulary, a traced exhaustion record, and no
// second (non-stream fallback) retry budget.
// ---------------------------------------------------------------------------
#[tokio::test]
async fn exhausted_429_is_an_explicit_rate_limit_failure_with_no_semantic_consumption() {
    let (capture, _guard) = ChatTraceCapture::install();
    let server = MockServer::start().await;
    let wire_calls = mount_steps(&server, vec![rate_limited("0")]).await;

    let (backend, recorder) = traced_backend(&server.uri()).await;
    let error = complete_streaming_once(backend.as_ref(), None)
        .await
        .expect_err("persistent 429 exhausts the bounded budget");

    assert_eq!(
        wire_calls.load(Ordering::SeqCst),
        3,
        "initial attempt + two bounded retries, and no non-stream fallback replay"
    );

    let message = error.to_string();
    assert!(
        message.contains("HTTP 429"),
        "the failure must name the rate limit explicitly, got {message:?}"
    );
    let lowered = message.to_ascii_lowercase();
    for forbidden in ["candidate", "rejected", "evidence", "invalid", "analysis"] {
        assert!(
            !lowered.contains(forbidden),
            "a transport exhaustion must not borrow analysis-failure vocabulary \
             ({forbidden:?} found in {message:?})"
        );
    }

    let calls = recorder.calls();
    assert_eq!(
        calls.len(),
        1,
        "one failed provider call, zero completed semantic attempts"
    );
    assert!(
        matches!(&calls[0].outcome, TracedOutcome::Failed { message } if message.contains("429"))
    );

    let exhaustions = capture.exhaustions();
    assert_eq!(exhaustions.len(), 1, "exhaustion is traced exactly once");
    assert_eq!(exhaustions[0].field("attempt"), Some("3"));
    assert_eq!(exhaustions[0].field("max_attempts"), Some("3"));
    assert_eq!(capture.waits().len(), 2);
    assert_eq!(capture.recoveries(), 0);
}

// ---------------------------------------------------------------------------
// Scenario 3 — Retry-After forms. Delta-seconds is exercised end-to-end by
// the recovery test above (`Retry-After: 0`); here the HTTP-date, malformed,
// and absent forms are pinned via the traced delay decision, with the actual
// wait interrupted by cancellation so no test ever sleeps a product delay.
// The pure bound arithmetic lives in `cd_core::chat`'s own unit tests.
// ---------------------------------------------------------------------------
async fn traced_delay_for_retry_after(
    retry_after: Option<&'static str>,
) -> (Option<u64>, Option<String>) {
    let (capture, _guard) = ChatTraceCapture::install();
    let server = MockServer::start().await;
    let step = match retry_after {
        Some(value) => rate_limited(value),
        None => RATE_LIMITED_NO_HEADER,
    };
    let wire_calls = mount_steps(&server, vec![step]).await;

    let (backend, _recorder) = traced_backend(&server.uri()).await;
    let cancel = Arc::new(AtomicBool::new(false));
    cancel_after_calls(wire_calls.clone(), 1, cancel.clone());
    let error = complete_streaming_once(backend.as_ref(), Some(cancel.as_ref()))
        .await
        .expect_err("cancellation interrupts the traced backoff");
    assert!(error.to_string().contains("cancelled"));
    assert_eq!(
        wire_calls.load(Ordering::SeqCst),
        1,
        "cancellation during backoff must prevent any further transport attempt"
    );

    let waits = capture.waits();
    assert_eq!(waits.len(), 1, "the wait decision itself must be traced");
    (
        waits[0].field("delay_ms").and_then(|v| v.parse().ok()),
        waits[0]
            .field("delay_source")
            .map(|v| v.trim_matches('"').to_string()),
    )
}

#[tokio::test]
async fn retry_after_http_date_is_honored_and_bounded() {
    // An HTTP-date ~90s out must be honored as retry_after but clamped to
    // the 60s bound. Leak tolerance: allow the full [1s, 60s] window so the
    // wall-clock between header mint and parse cannot flake the assertion.
    let date = chrono::Utc::now() + chrono::Duration::seconds(90);
    let leaked: &'static str = Box::leak(date.to_rfc2822().into_boxed_str());
    let (delay_ms, source) = traced_delay_for_retry_after(Some(leaked)).await;
    let delay_ms = delay_ms.expect("traced delay");
    assert_eq!(source.as_deref(), Some("retry_after"));
    assert!(
        (1_000..=60_000).contains(&delay_ms),
        "HTTP-date Retry-After must be honored and bounded to 60s, got {delay_ms}ms"
    );
}

#[tokio::test]
async fn malformed_retry_after_falls_back_to_the_bounded_default() {
    let (delay_ms, source) = traced_delay_for_retry_after(Some("three-parrots")).await;
    assert_eq!(source.as_deref(), Some("fallback"));
    assert_eq!(
        delay_ms,
        Some(30_000),
        "malformed Retry-After uses the bounded 30s fallback for the first retry"
    );
}

#[tokio::test]
async fn past_http_date_retry_after_falls_back_to_the_bounded_default() {
    let (delay_ms, source) =
        traced_delay_for_retry_after(Some("Wed, 21 Oct 2015 07:28:00 GMT")).await;
    assert_eq!(source.as_deref(), Some("fallback"));
    assert_eq!(delay_ms, Some(30_000));
}

#[tokio::test]
async fn absent_retry_after_falls_back_to_the_bounded_default() {
    let (delay_ms, source) = traced_delay_for_retry_after(None).await;
    assert_eq!(source.as_deref(), Some("fallback"));
    assert_eq!(delay_ms, Some(30_000));
}

// ---------------------------------------------------------------------------
// Scenario 5 — cancellation while parked in a real (60s) backoff: prompt
// exit, no subsequent request, no semantic attempt consumed, and the single
// entered wait was traced (mutation "retrying after cancellation" and
// mutation "sleeping without trace telemetry" both die here).
// ---------------------------------------------------------------------------
#[tokio::test]
async fn cancellation_during_backoff_exits_promptly_without_further_requests() {
    let (capture, _guard) = ChatTraceCapture::install();
    let server = MockServer::start().await;
    let wire_calls = mount_steps(&server, vec![rate_limited("60")]).await;

    let (backend, recorder) = traced_backend(&server.uri()).await;
    let cancel = Arc::new(AtomicBool::new(false));
    cancel_after_calls(wire_calls.clone(), 1, cancel.clone());

    let started = std::time::Instant::now();
    let error = complete_streaming_once(backend.as_ref(), Some(cancel.as_ref()))
        .await
        .expect_err("cancellation interrupts the backoff");
    let elapsed = started.elapsed();

    assert!(error.to_string().contains("cancelled"));
    assert!(
        elapsed < std::time::Duration::from_secs(5),
        "cancellation must interrupt a 60s backoff promptly, took {elapsed:?}"
    );
    assert_eq!(
        wire_calls.load(Ordering::SeqCst),
        1,
        "no request after cancellation"
    );
    let calls = recorder.calls();
    assert_eq!(calls.len(), 1);
    assert!(
        matches!(&calls[0].outcome, TracedOutcome::Cancelled),
        "the aborted attempt is recorded as Cancelled, never as completed; got {:?}",
        calls[0].outcome
    );
    assert_eq!(capture.waits().len(), 1, "the entered backoff was traced");
    assert_eq!(capture.recoveries(), 0);
}

// ---------------------------------------------------------------------------
// Scenario 4 — connection reset before any response bytes is terminal for
// this operation. A scripted second response proves that transport failure
// never replays the prompt through a different protocol mode.
// ---------------------------------------------------------------------------
#[tokio::test]
async fn connection_reset_before_headers_is_terminal_without_protocol_replay() {
    let (base_url, accepted) =
        raw_fault_server(vec![RawConn::ResetBeforeHeaders, RawConn::Json(JSON_HELLO)]);

    let (backend, recorder) = traced_backend(&base_url).await;
    complete_streaming_once(backend.as_ref(), None)
        .await
        .expect_err("the reset must remain the operation's terminal failure");

    assert_eq!(
        accepted.load(Ordering::SeqCst),
        1,
        "the scripted non-stream success must remain unused"
    );
    let calls = recorder.calls();
    assert_eq!(calls.len(), 1);
    assert!(matches!(&calls[0].outcome, TracedOutcome::Failed { .. }));
}

// ---------------------------------------------------------------------------
// Scenario 4b — transport failures with no usable response classify as
// transport ("chat request:"/"stream request:" + IO error), never as an HTTP
// provider status and never as analysis failure.
// ---------------------------------------------------------------------------
#[tokio::test]
async fn connection_refused_classifies_as_transport_failure_not_provider_status() {
    // Bind then immediately drop a listener: the port is real but closed.
    let port = {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        listener.local_addr().expect("addr").port()
    };
    let client = cd_core::chat::OpenAiCompatibleClient::new(
        format!("http://127.0.0.1:{port}"),
        None,
        "oracle-test-model",
        &SsrfPolicy::default(),
    )
    .expect("client construction");

    let error = client
        .complete(&user_message("oracle probe"), None)
        .await
        .expect_err("refused connection is a transport failure");
    let message = error.to_string();
    assert!(
        message.starts_with("chat request:"),
        "transport failures carry the operation label, got {message:?}"
    );
    assert!(
        !message.contains("HTTP 4") && !message.contains("HTTP 5"),
        "a refused connection must not masquerade as an HTTP provider status: {message:?}"
    );
}

/// Read timeout before headers under a paused clock: the socket never
/// produces IO, so auto-advance deterministically fires the pinned client's
/// 120s total timeout. Classified as transport, not HTTP status.
#[tokio::test(start_paused = true)]
async fn read_timeout_before_headers_classifies_as_transport_failure() {
    let (base_url, accepted) = raw_fault_server(vec![RawConn::NeverRespond]);
    let client = cd_core::chat::OpenAiCompatibleClient::new(
        &base_url,
        None,
        "oracle-test-model",
        &SsrfPolicy::default(),
    )
    .expect("client construction");

    let error = client
        .complete(&user_message("oracle probe"), None)
        .await
        .expect_err("a never-responding socket times out");
    // Under a paused clock the timeout may fire before the mock's accept
    // task is ever scheduled, so the accept count is 0 or 1 — either way no
    // response bytes existed, which is the class under test.
    assert!(accepted.load(Ordering::SeqCst) <= 1);
    let message = error.to_string();
    assert!(
        message.starts_with("chat request:"),
        "timeout carries the transport operation label, got {message:?}"
    );
    // Observability caveat pinned as-is: reqwest 0.12's top-level Display is
    // "error sending request for url (…)" — the timeout CAUSE lives only in
    // the source chain, so the product string cannot distinguish a timeout
    // from other send failures. Both stay in the transport class, which is
    // what this oracle requires; naming the cause is a doc'd improvement.
    assert!(
        message.contains("error sending request"),
        "the transport send failure must be visible, got {message:?}"
    );
    assert!(!message.contains("HTTP 4") && !message.contains("HTTP 5"));
}

// ---------------------------------------------------------------------------
// Scenario 8 — provider-output categories stay distinct.
// ---------------------------------------------------------------------------

/// 8a: empty visible answer with a clean finish — a COMPLETED semantic
/// attempt whose emptiness is typed, not a failure of any kind.
#[tokio::test]
async fn empty_visible_answer_is_a_completed_attempt_with_typed_emptiness() {
    let server = MockServer::start().await;
    let wire_calls = mount_steps(&server, vec![sse_ok(SSE_EMPTY_STOP)]).await;
    let (backend, recorder) = traced_backend(&server.uri()).await;
    let completion = complete_streaming_once(backend.as_ref(), None)
        .await
        .expect("an empty completed answer is not an error");
    assert!(completion.content.is_empty());
    assert_eq!(wire_calls.load(Ordering::SeqCst), 1, "no retry of any kind");
    let calls = recorder.calls();
    assert_eq!(calls.len(), 1);
    assert!(
        calls[0].empty_visible_answer,
        "emptiness must be typed on the attempt"
    );
    assert!(matches!(
        &calls[0].outcome,
        TracedOutcome::Completed { finish_reason, .. } if finish_reason == "stop"
    ));
}

/// 8b: truncated-by-length — a COMPLETED semantic attempt with the provider's
/// own finish_reason preserved; never retried at transport level.
#[tokio::test]
async fn length_truncation_is_a_completed_attempt_not_a_transport_failure() {
    let server = MockServer::start().await;
    let wire_calls = mount_steps(&server, vec![sse_ok(SSE_LENGTH)]).await;
    let (backend, recorder) = traced_backend(&server.uri()).await;
    let completion = complete_streaming_once(backend.as_ref(), None)
        .await
        .expect("length truncation is a completed provider output");
    assert_eq!(completion.finish_reason, "length");
    assert_eq!(wire_calls.load(Ordering::SeqCst), 1);
    let calls = recorder.calls();
    assert_eq!(calls.len(), 1);
    assert!(matches!(
        &calls[0].outcome,
        TracedOutcome::Completed { finish_reason, .. } if finish_reason == "length"
    ));
}

/// 8c: malformed tool-call/SSE stream — a PROVIDER-OUTPUT failure. A
/// scripted non-stream success remains unused because parse failure never
/// launches a second protocol request.
#[tokio::test]
async fn malformed_sse_stream_is_terminal_without_protocol_replay() {
    let server = MockServer::start().await;
    let wire_calls = mount_steps(
        &server,
        vec![sse_ok(SSE_MALFORMED_DATA_LINE), json_ok(JSON_HELLO)],
    )
    .await;
    let (backend, recorder) = traced_backend(&server.uri()).await;
    complete_streaming_once(backend.as_ref(), None)
        .await
        .expect_err("malformed SSE must fail this operation");
    assert_eq!(
        wire_calls.load(Ordering::SeqCst),
        1,
        "the scripted non-stream success must remain unused"
    );
    let calls = recorder.calls();
    assert_eq!(calls.len(), 1);
    assert!(matches!(&calls[0].outcome, TracedOutcome::Failed { .. }));
}

/// 8c (classification): malformed provider output is a FAILED attempt whose
/// error names the parse failure. It is neither an HTTP-status provider
/// failure nor analysis vocabulary, and it consumes one wire request.
#[tokio::test]
async fn persistently_malformed_provider_output_fails_the_attempt_with_parse_language() {
    let server = MockServer::start().await;
    let wire_calls = mount_steps(&server, vec![sse_ok(SSE_MALFORMED_DATA_LINE)]).await;
    let (backend, recorder) = traced_backend(&server.uri()).await;
    let error = complete_streaming_once(backend.as_ref(), None)
        .await
        .expect_err("malformed stream fails the attempt");
    assert_eq!(wire_calls.load(Ordering::SeqCst), 1);
    let calls = recorder.calls();
    assert_eq!(calls.len(), 1);
    assert!(matches!(&calls[0].outcome, TracedOutcome::Failed { .. }));
    let lowered = error.to_string().to_ascii_lowercase();
    for forbidden in ["candidate", "rejected", "evidence", "analysis invalid"] {
        assert!(
            !lowered.contains(forbidden),
            "provider-output failure must not borrow analysis vocabulary: {lowered:?}"
        );
    }
}

/// 8d: SSE whose chunk boundaries split a multi-byte UTF-8 character and an
/// SSE line — NOT a failure of any category: one wire request, one completed
/// semantic attempt, content byte-exact.
#[tokio::test]
async fn partial_utf8_sse_fragments_across_real_tcp_chunks_complete_cleanly() {
    // "héllo wörld ✓" — the é (0xC3 0xA9), ö (0xC3 0xB6) and ✓ (0xE2 0x9C
    // 0x93) are each split across chunk boundaries, as is the SSE framing.
    let full = "data: {\"choices\":[{\"delta\":{\"content\":\"h\\u00e9llo w\\u00f6rld \\u2713\"}}]}\n\ndata: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n";
    // Split the *encoded* body on byte positions that bisect the escaped
    // sequences once decoded — and also split a literal multi-byte char by
    // sending one raw UTF-8 content frame.
    let raw_multibyte = "data: {\"choices\":[{\"delta\":{\"content\":\" — done\"}}]}\n\n";
    let raw_bytes = raw_multibyte.as_bytes();
    // Split inside the em-dash (0xE2 0x80 0x94) at its second byte.
    let dash_index = raw_multibyte.find('—').expect("em dash present");
    let (dash_first, dash_rest) = raw_bytes.split_at(dash_index + 1);

    let chunks: Vec<&'static [u8]> = vec![
        &full.as_bytes()[..17],
        &full.as_bytes()[17..53],
        &full.as_bytes()[53..],
        dash_first,
        dash_rest,
        b"data: [DONE]\n\n",
    ];
    let (base_url, accepted) = raw_fault_server(vec![RawConn::SseChunks(chunks)]);
    let (backend, recorder) = traced_backend(&base_url).await;
    let completion = complete_streaming_once(backend.as_ref(), None)
        .await
        .expect("split UTF-8 SSE frames decode cleanly");
    assert_eq!(completion.content, "héllo wörld ✓ — done");
    assert_eq!(
        accepted.load(Ordering::SeqCst),
        1,
        "no retry was needed or made"
    );
    let calls = recorder.calls();
    assert_eq!(calls.len(), 1);
    assert!(matches!(&calls[0].outcome, TracedOutcome::Completed { .. }));
}
