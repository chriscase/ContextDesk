//! Hermetic scripted HTTP/1.1 mock gateway for ContextDesk's wire-level
//! provider conformance and fault-injection tests.
//!
//! Test-support only. Not a product crate, never linked into a shipped
//! binary — `crates/cd-core`, `crates/cd-workflow`, and `crates/cd-cli`
//! depend on it as a `[dev-dependencies]` entry only.
//!
//! # Why a bespoke server instead of `wiremock`
//!
//! `wiremock` (already a dev-dependency across this workspace) is the right
//! tool for ordinary request/response scripting and stays in use for that.
//! It cannot, however, express several faults this lab is explicitly asked
//! to cover deterministically: a delay before an individual stream chunk, a
//! connection that closes mid-body without a proper terminator, a response
//! that stalls forever, or a `Content-Length` that lies about how many
//! bytes actually arrive. Those need raw control over what goes on the
//! wire and when — the same reason
//! `crates/cd-core/tests/transport_semantic_attempt_oracle.rs` already
//! hand-rolls a `tokio::net::TcpListener` fault server for a narrower set
//! of cases. This crate generalizes that pattern into one reusable,
//! documented framework so every capability matrix in this lab (and future
//! ones) scripts faults the same way instead of each growing its own
//! one-off raw-socket helper.
//!
//! # Quick start
//!
//! ```no_run
//! use cd_test_gateway::{MockGateway, Response, Step};
//!
//! # async fn example() {
//! let gateway = MockGateway::start_ordered(vec![
//!     Step::respond(Response::json_ok(&serde_json::json!({"ok": true}))),
//! ])
//! .await;
//!
//! // Point any provider client at `gateway.base_url()` exactly as the
//! // production code points it at a real gateway's base URL.
//! let base_url = gateway.base_url().to_string();
//!
//! // ... drive the real client here ...
//!
//! assert_eq!(gateway.request_count(), 1);
//! let sent = gateway.requests();
//! assert_eq!(sent[0].method, "GET");
//! # }
//! ```
//!
//! # Ordered vs. routed
//!
//! [`MockGateway::start_ordered`] accepts connections **one at a time**,
//! serving `steps[0]`, `steps[1]`, ... in strict arrival order (repeating
//! the last step past the end of the script). This is the right mode
//! whenever call *order* is part of the assertion — retry/backoff
//! sequences, "N attempts then success," etc.
//!
//! [`MockGateway::start_routed`] spawns a fresh task per accepted
//! connection so many requests can be in flight — and mid-delay — at once.
//! Use it for fan-out the production code genuinely issues concurrently
//! (parallel embedding batches, parallel discovery probes), where
//! serializing acceptance would misrepresent what's under test. The
//! `route` closure decides each connection's [`Step`] from its
//! [`RecordedRequest`], so it can match on path/method/body or just close
//! over a shared counter.
//!
//! # Timing
//!
//! Every delay in this crate (header delay, body delay, per-frame delay) is
//! a plain [`std::time::Duration`] slept with `tokio::time::sleep`. Under
//! `#[tokio::test(start_paused = true)]` these delays advance virtual time
//! instantly and deterministically — prefer that for anything asserting a
//! specific timeout/deadline boundary. Under a live clock, keep delays
//! small (single-digit milliseconds) and bounded; this crate has no
//! wall-clock ceiling of its own; the calling test supplies one.
//!
//! # Secrets
//!
//! [`RecordedRequest`] stores exactly what crossed the wire, including a
//! real synthetic credential in an `Authorization`/`x-api-key` header —
//! that's required to prove the client attached it. When building an
//! assertion message, panic, or log line from a recorded request, pass the
//! synthetic secret value(s) through [`redact`] first so raw credentials
//! never land in test output.

mod redact;
mod request;
mod script;
mod server;

pub use redact::redact;
pub use request::RecordedRequest;
pub use script::{split_at, split_evenly, Body, Frame, Response, Step};
pub use server::MockGateway;

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    #[tokio::test]
    async fn ordered_script_serves_steps_in_sequence_and_records_requests() {
        let gateway = MockGateway::start_ordered(vec![
            Step::respond(Response::status_only(429).with_header("retry-after", "0")),
            Step::respond(Response::json_ok(&serde_json::json!({"ok": true}))),
        ])
        .await;
        let base = gateway.base_url().to_string();
        let client = reqwest::Client::new();

        let first = client
            .get(format!("{base}/v1/models"))
            .header("authorization", "Bearer sk-test-fixture")
            .send()
            .await
            .expect("first request");
        assert_eq!(first.status().as_u16(), 429);
        assert_eq!(first.headers().get("retry-after").unwrap(), "0");

        let second = client
            .get(format!("{base}/v1/models"))
            .send()
            .await
            .expect("second request");
        assert_eq!(second.status().as_u16(), 200);
        let body: serde_json::Value = second.json().await.expect("json body");
        assert_eq!(body["ok"], true);

        assert_eq!(gateway.request_count(), 2);
        let recorded = gateway.requests();
        assert_eq!(
            recorded[0].header("authorization"),
            Some("Bearer sk-test-fixture")
        );
        assert_eq!(recorded[1].path, "/v1/models");
    }

    #[tokio::test]
    async fn overflow_requests_repeat_the_last_step() {
        let gateway =
            MockGateway::start_ordered(vec![Step::respond(Response::status_only(200))]).await;
        let base = gateway.base_url().to_string();
        let client = reqwest::Client::new();
        for _ in 0..3 {
            let resp = client.get(&base).send().await.expect("request");
            assert_eq!(resp.status().as_u16(), 200);
        }
        assert_eq!(gateway.request_count(), 3);
    }

    #[tokio::test]
    async fn fixed_then_drop_delivers_a_short_read_the_client_can_detect() {
        let gateway = MockGateway::start_ordered(vec![Step::respond(Response::new(
            200,
            Body::FixedThenDrop {
                declared_len: 100,
                sent: b"only twenty bytes.."[..].to_vec(),
                reset: false,
            },
        ))])
        .await;
        let base = gateway.base_url().to_string();
        let client = reqwest::Client::new();
        let err = client
            .get(&base)
            .send()
            .await
            .expect("headers arrive")
            .bytes()
            .await
            .expect_err("a short body against a larger declared Content-Length must error");
        assert!(
            err.is_body() || err.is_decode(),
            "unexpected error kind: {err:?}"
        );
    }

    #[tokio::test]
    async fn stream_body_delivers_fragments_in_order_with_no_length_framing() {
        let gateway = MockGateway::start_ordered(vec![Step::respond(
            Response::new(200, Body::Stream(split_at(b"data: a\n\ndata: b\n\n", &[9])))
                .with_header("content-type", "text/event-stream"),
        )])
        .await;
        let base = gateway.base_url().to_string();
        let body = reqwest::get(&base)
            .await
            .expect("request")
            .text()
            .await
            .expect("body");
        assert_eq!(body, "data: a\n\ndata: b\n\n");
    }

    #[tokio::test(start_paused = true)]
    async fn header_delay_advances_virtual_time_deterministically() {
        let gateway = MockGateway::start_ordered(vec![Step::respond(
            Response::status_only(200).with_header_delay(Duration::from_secs(30)),
        )])
        .await;
        let base = gateway.base_url().to_string();
        let call =
            tokio::spawn(async move { reqwest::get(&base).await.map(|r| r.status().as_u16()) });
        tokio::time::advance(Duration::from_secs(31)).await;
        let status = call.await.expect("join").expect("request");
        assert_eq!(status, 200);
    }

    #[tokio::test]
    async fn stall_step_hangs_until_the_caller_gives_up() {
        let gateway = MockGateway::start_ordered(vec![Step::Stall]).await;
        let base = gateway.base_url().to_string();
        let outcome = tokio::time::timeout(Duration::from_millis(50), reqwest::get(&base)).await;
        assert!(
            outcome.is_err(),
            "a stalled connection must not resolve on its own"
        );
    }

    #[tokio::test]
    async fn routed_mode_serves_concurrent_requests_independently() {
        let hits = Arc::new(AtomicUsize::new(0));
        let hits_route = hits.clone();
        let gateway = MockGateway::start_routed(move |req| {
            let n = hits_route.fetch_add(1, Ordering::SeqCst);
            if req.path == "/slow" {
                Step::respond(
                    Response::status_only(200).with_header_delay(Duration::from_millis(30)),
                )
            } else {
                Step::respond(Response::json_ok(&serde_json::json!({"n": n})))
            }
        })
        .await;
        let base = gateway.base_url().to_string();
        let client = reqwest::Client::new();
        let slow = {
            let client = client.clone();
            let base = base.clone();
            tokio::spawn(async move { client.get(format!("{base}/slow")).send().await })
        };
        // The fast request must not wait behind the slow one — proves
        // concurrent, not one-at-a-time, handling.
        let fast = client
            .get(format!("{base}/fast"))
            .send()
            .await
            .expect("fast request");
        assert_eq!(fast.status().as_u16(), 200);
        let slow = slow.await.expect("join").expect("slow request");
        assert_eq!(slow.status().as_u16(), 200);
        assert_eq!(gateway.request_count(), 2);
    }

    #[tokio::test]
    async fn dropping_the_gateway_releases_the_port() {
        let gateway =
            MockGateway::start_ordered(vec![Step::respond(Response::status_only(200))]).await;
        let base = gateway.base_url().to_string();
        drop(gateway);
        let outcome = tokio::time::timeout(Duration::from_millis(200), reqwest::get(&base)).await;
        if let Ok(Ok(_)) = outcome {
            panic!("dropped gateway must not still be serving");
        }
    }
}
